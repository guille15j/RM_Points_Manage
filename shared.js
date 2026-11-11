/**
 * shared.js - Utilidades comunes y capa de API (Google Apps Script o MODO DEMO)
 * Compartido por profesor.html y pantalla.html. No toca el DOM.
 *
 * Contrato de datos (igual en demo y en produccion). Todas las respuestas son el ESTADO completo:
 *   { ok, alumnos:[{id,nombre,avatar,color,puntos,racha,insignias,pendientes}],
 *     reglas:[{id,nombre,puntos,icono,descripcion}], premios:[{id,nombre,coste,icono,descripcion,efecto}],
 *     insignias:[{id,nombre,icono,descripcion}], reto:{nombre,meta,progreso,premio,icono,logrado}|null,
 *     mascota:{nombre,puntos,etapa,etapas,desde,hasta,falta,premio,maxima,peligro,deuda,necesidad,atendida,votacion,diario}|null,
 *     estrellas:[{id,para,paraNombre,de,deNombre,frase}] (pendientes de revisar), ayudante:{id,nombre}|null,
 *     config:{rachaHito,rachaBonus,ruletaBonus,avatares,colores}, ts }
 * apiPost() devuelve ademas { bonificaciones:[{alumnoId,racha,bonus}] }.
 *
 * MODO DEMO: datos-prueba.json es un volcado de las pestanas de la hoja (alumnos, reglasYPremios,
 * config, movimientos). El estado se calcula con Engine (engine.js), el MISMO motor que lleva Code.gs.
 */
(function () {
  'use strict';
  const CFG = window.APP_CONFIG || {};

  /* ---------- Utilidades basicas ---------- */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const esc = (s) =>
    String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /** localStorage a prueba de fallos (modo privado, cuota llena...) */
  const store = {
    get(k, d) {
      try {
        const v = localStorage.getItem(k);
        return v ? JSON.parse(v) : d;
      } catch (e) {
        return d;
      }
    },
    set(k, v) {
      try {
        localStorage.setItem(k, JSON.stringify(v));
      } catch (e) {
        /* sin espacio o bloqueado: seguimos sin persistir */
      }
    },
    del(k) {
      try {
        localStorage.removeItem(k);
      } catch (e) {}
    }
  };

  /** Escoge y devuelve del estado solo lo que pinta la interfaz (para comparar y guardar). */
  const STATE_KEYS = ['alumnos', 'reglas', 'premios', 'insignias', 'reto', 'mascota', 'estrellas', 'ayudante', 'config'];
  const pickState = (r) => STATE_KEYS.reduce((o, k) => ((o[k] = r[k] === undefined ? null : r[k]), o), {});

  /* ---------- Red ---------- */
  const isDemo = () => !CFG.APPS_SCRIPT_URL;

  async function fetchTimeout(url, opts, ms) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), ms || 15000);
    try {
      const r = await fetch(url, Object.assign({}, opts, { signal: ac.signal }));
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r;
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('Tiempo de espera agotado');
      throw e;
    } finally {
      clearTimeout(t);
    }
  }

  /* ---------- MODO DEMO ---------- */
  const DEMO_KEY = 'demo_db_v4';
  const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit' });
  const demoCtx = () => ({ now: new Date(), fmtDay: (d) => dayFmt.format(d), uuid: uid });

  /**
   * Desplaza el historial de prueba en SEMANAS COMPLETAS (conserva lunes y jueves) para que el ultimo
   * apunte caiga en los ultimos 7 dias. Asi las insignias de ejemplo (que caducan) siguen vigentes.
   */
  function rebase(t) {
    const WEEK = 7 * 86400000;
    const times = t.movimientos.map((m) => Date.parse(m.fecha)).filter((n) => !isNaN(n));
    if (!times.length) return t;
    const k = Math.floor((Date.now() - Math.max(...times)) / WEEK);
    if (k <= 0) return t;
    t.movimientos.forEach((m) => {
      const n = Date.parse(m.fecha);
      if (!isNaN(n)) m.fecha = new Date(n + k * WEEK).toISOString();
    });
    const rd = t.config.find((c) => c.clave === 'reto_desde');
    if (rd && /^\d{4}-\d{2}-\d{2}$/.test(String(rd.valor))) rd.valor = new Date(Date.parse(rd.valor + 'T00:00:00Z') + k * WEEK).toISOString().slice(0, 10);
    return t;
  }

  /** Tablas de la hoja simulada. La primera vez se siembran desde datos-prueba.json. */
  async function demoTables() {
    let t = store.get(DEMO_KEY, null);
    if (!t) {
      const r = await fetchTimeout(CFG.DEMO_DATA_URL || 'datos-prueba.json', { cache: 'no-cache' }, 8000);
      t = rebase(await r.json());
      store.set(DEMO_KEY, t);
    }
    return t;
  }

  /** Vuelve a los datos del JSON de prueba. */
  function resetDemo() {
    store.del(DEMO_KEY);
  }

  async function demoPost(payload) {
    const t = await demoTables();
    const ctx = demoCtx();
    const res = Engine.applyAction(t, payload, ctx); // valida igual que Code.gs; lanza Error si no es valido
    if (!res.duplicado) {
      res.patches.forEach((p) => {
        const a = t.alumnos.find((x) => String(x.id) === p.alumnoId);
        if (a) { a.avatar = p.avatar; a.color = p.color; }
      });
      t.movimientos.push(...res.rows);
      store.set(DEMO_KEY, t);
    }
    return Object.assign({ ok: true, duplicado: res.duplicado, bonificaciones: res.bonificaciones }, Engine.computeState(t, ctx));
  }

  /* ---------- API publica ---------- */
  async function apiGet() {
    if (isDemo()) {
      await sleep(150);
      return Object.assign({ ok: true }, Engine.computeState(await demoTables(), demoCtx()));
    }
    const url = CFG.APPS_SCRIPT_URL + '?token=' + encodeURIComponent(CFG.TOKEN) + '&_=' + Date.now();
    const r = await fetchTimeout(url, { method: 'GET' });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || 'Error del servidor');
    return j;
  }

  /**
   * Envia una operacion. payload:
   *  { action:'batch',  batchId, movimientos:[{alumnoId,tipo:'delta'|'reset'|'ruleta'|'insignia',delta,nota,ref}] }
   *  { action:'canje',  batchId, alumnoId, premioId }
   *  { action:'perfil', batchId, alumnoId, avatar, color }
 *  { action:'canje',  ..., opcion }                         (premio con efecto 'nombre')
 *  { action:'estrella', batchId, alumnoId, paraId, frase }  (alumno propone)
 *  { action:'estrella_resolver', batchId, estrellaId, ok }  (profesor)
 *  { action:'rol', batchId, alumnoId, accion:'confirmar'|'saltar' }  (profesor)
 *  { action:'mascota', batchId, accion:'reiniciar'|'cerrar_nombre' }  (profesor)
   * El batchId hace la operacion idempotente: reintentar no duplica movimientos.
   */
  async function apiPost(payload) {
    payload = Object.assign({}, payload, { token: CFG.TOKEN });
    if (isDemo()) {
      await sleep(500);
      if (store.get('demo_fail', false)) throw new Error('Fallo de red simulado');
      return demoPost(payload);
    }
    // text/plain evita el preflight CORS que Apps Script no soporta
    const r = await fetchTimeout(CFG.APPS_SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload),
      redirect: 'follow'
    });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || 'Error del servidor');
    return j;
  }

  window.TP = { CFG, sleep, uid, clone, esc, store, isDemo, apiGet, apiPost, resetDemo, pickState };
})();
