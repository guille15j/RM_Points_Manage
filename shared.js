/**
 * shared.js - Utilidades comunes y capa de API (Google Apps Script o MODO DEMO)
 * Compartido por profesor.html y pantalla.html. No toca el DOM.
 *
 * Contrato de datos (igual en demo y en produccion). Todas las respuestas son el ESTADO completo:
 *   { ok, alumnos:[{id,nombre,avatar,color,puntos,racha,insignias,pendientes}],
 *     reglas:[{id,nombre,puntos,icono,descripcion}], premios:[{id,nombre,coste,icono,descripcion,efecto}],
 *     insignias:[{id,nombre,icono,descripcion}], reto:{nombre,meta,progreso,premio,icono,logrado}|null,
 *     cuidados:[{id,nombre,icono,coste,accion}] (hoja: tipo 'cuidado'),
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
  const STATE_KEYS = ['alumnos', 'reglas', 'premios', 'insignias', 'reto', 'mascota', 'estrellas', 'ayudante', 'cuidados', 'config', 'cola', 'equilibrio', 'economia', 'encuestas'];
  const pickState = (r) => STATE_KEYS.reduce((o, k) => ((o[k] = r[k] === undefined ? null : r[k]), o), {});

  /* ---------- Red ---------- */
  const isDemo = () => !CFG.APPS_SCRIPT_URL;
  const ES_PROFESOR = /profesor/i.test(location.pathname);
  const VISTA = ES_PROFESOR ? 'profesor' : 'pantalla';     // el iPad de los alumnos no recibe comentarios de encuestas ni informes
  const PIN_KEY = 'tp_pin_profesor';
  /** Errores del servidor con codigo: mensaje legible y .code para que la pagina reaccione. */
  const ERRORES = {
    PIN_REQUERIDO: 'Hace falta el PIN del profesor',
    PIN_INCORRECTO: 'PIN incorrecto',
    PIN_BLOQUEADO: 'Demasiados intentos con el PIN. Espera 10 minutos'
  };
  const errorServidor = (txt) => {
    const code = String(txt || '').trim();
    const e = new Error(ERRORES[code] || code || 'Error del servidor');
    if (ERRORES[code]) e.code = code;
    return e;
  };
  /** Aviso fijo si la web y el servidor tienen versiones distintas del motor (alguien no ha actualizado). */
  let avisoVersionPuesto = false;
  function revisaVersion(j) {
    if (avisoVersionPuesto || !j || !j.motor || !window.Engine || !Engine.VERSION || j.motor === Engine.VERSION) return;
    avisoVersionPuesto = true;
    const d = document.createElement('div');
    d.setAttribute('role', 'alert');
    d.className = 'fixed inset-x-0 bottom-0 z-[90] px-4 py-3 text-center font-semibold bg-attention text-on-primary';
    d.style.paddingBottom = 'calc(env(safe-area-inset-bottom) + 0.75rem)';
    d.textContent = 'La web y el servidor tienen versiones distintas. Recarga la página o vuelve a desplegar Code.gs.';
    document.body.appendChild(d);
  }

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
    if (!(t.config || []).some((r) => String(r.clave) === 'pin_profesor')) (t.config = t.config || []).push({ clave: 'pin_profesor', valor: 'OPEN' });   // PIN de la demo
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
      if (res.configSet) {
        const fila = (t.config || []).find((r) => String(r.clave) === res.configSet.clave);
        if (fila) fila.valor = res.configSet.valor; else (t.config = t.config || []).push({ clave: res.configSet.clave, valor: res.configSet.valor });
      }
      store.set(DEMO_KEY, t);
    }
    return Object.assign({ ok: true, duplicado: res.duplicado, bonificaciones: res.bonificaciones }, Engine.computeState(t, ctx));
  }

  /* ---------- Indicador de red: el icono de sincronizacion gira mientras haya peticiones y se para al responder ---------- */
  let netPending = 0;
  let netAnim = null;
  let netFeedbackTimer = null;
  const netIcon = () => document.querySelector('#btn-refresh .icon');
  const netSinMov = () => !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  function netStart() {
    netPending++;
    const ic = netIcon();
    if (!ic) return;
    clearTimeout(netFeedbackTimer);
    ic.textContent = 'sync';
    ic.style.color = '';
    document.getElementById('btn-refresh').setAttribute('aria-busy', 'true');
    if (netAnim && netAnim.playState === 'finished') { netAnim.cancel(); netAnim = null; }
    if (netAnim) netAnim.effect.updateTiming({ iterations: Infinity });   // otra peticion antes de parar: sigue girando
    else if (!netSinMov()) {
      netAnim = ic.animate([{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }], { duration: 900, iterations: Infinity, easing: 'linear' });
    }
  }
  function netEnd(ok) {
    netPending = Math.max(0, netPending - 1);
    if (netPending > 0) return;
    const ic = netIcon();
    if (!ic) return;
    const feedback = () => {                                   // resultado visible un momento: tick (ok) o aviso (fallo)
      netAnim = null;
      document.getElementById('btn-refresh').removeAttribute('aria-busy');
      ic.textContent = ok ? 'check' : 'sync_problem';
      ic.style.color = ok ? 'rgb(var(--c-success))' : 'rgb(var(--c-attention))';
      clearTimeout(netFeedbackTimer);
      netFeedbackTimer = setTimeout(() => { ic.textContent = 'sync'; ic.style.color = ''; }, 1600);
    };
    if (!netAnim) return feedback();
    const tm = netAnim.effect.getComputedTiming();               // termina la vuelta en curso y entonces se detiene
    netAnim.effect.updateTiming({ iterations: Math.ceil((tm.currentIteration || 0) + (tm.progress || 0.01)) });
    const a = netAnim;
    a.finished.then(() => { if (netAnim === a && netPending === 0) { a.cancel(); feedback(); } }).catch(() => {});
  }

  /* ---------- API publica ---------- */
  async function apiGet() {
    netStart();
    try { const r = await apiGetRaw(); netEnd(true); return r; } catch (e) { netEnd(false); throw e; }
  }
  async function apiPost(payload, ms) {
    netStart();
    try {
      let r;
      try { r = await apiPostRaw(payload, ms); }
      catch (e) {
        // Solo la pagina del profesor puede pedir el PIN (TP.pedirPin la define); se reintenta una vez con el PIN nuevo
        if ((e.code !== 'PIN_REQUERIDO' && e.code !== 'PIN_INCORRECTO') || !window.TP || !TP.pedirPin) throw e;
        const pin = await TP.pedirPin(e.code);
        if (!pin) throw e;
        r = await apiPostRaw(Object.assign({}, payload, { pin }), ms);
      }
      netEnd(true);
      return r;
    } catch (e) { netEnd(false); throw e; }
  }
  async function apiGetRaw() {
    if (isDemo()) {
      await sleep(150);
      return Object.assign({ ok: true }, Engine.computeState(await demoTables(), demoCtx()));
    }
    const url = CFG.APPS_SCRIPT_URL + '?token=' + encodeURIComponent(CFG.TOKEN) + '&vista=' + VISTA + '&_=' + Date.now();
    const r = await fetchTimeout(url, { method: 'GET' });
    const j = await r.json();
    if (!j.ok) throw errorServidor(j.error);
    revisaVersion(j);
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
 *  { action:'tpv_abrir'|'tpv_cerrar', batchId, alumnoId }  (desbloqueo de canje)
 *  { action:'rol', batchId, alumnoId, accion:'confirmar'|'saltar' }  (profesor)
 *  { action:'mascota', batchId, accion:'reiniciar'|'cerrar_nombre' }  (profesor)
   * El batchId hace la operacion idempotente: reintentar no duplica movimientos.
   */
  async function apiPostRaw(payload, ms) {
    payload = Object.assign({}, payload, { token: CFG.TOKEN, vista: VISTA });
    if (ES_PROFESOR && !payload.pin && store.get(PIN_KEY, '')) payload.pin = store.get(PIN_KEY, '');
    if (isDemo()) {
      payload.pin = payload.pin ? String(payload.pin).toUpperCase() : 'OPEN';   // en la demo el PIN es OPEN y no se pide
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
    }, ms);
    const j = await r.json();
    if (!j.ok) throw errorServidor(j.error);
    revisaVersion(j);
    return j;
  }

  /** Aviso sin conexion (H15): barra fija arriba. En el iPad ademas se bloquean los canjes (lo comprueba pantalla.js con TP.online()). */
  const online = () => navigator.onLine !== false;
  (function bannerOffline() {
    const d = document.createElement('div');
    d.setAttribute('role', 'status');
    d.className = 'hidden fixed inset-x-0 top-0 z-[90] px-4 py-2 text-center font-semibold bg-attention text-on-primary';
    d.style.paddingTop = 'calc(env(safe-area-inset-top) + 0.5rem)';
    d.textContent = ES_PROFESOR ? 'Sin conexión: lo que hagas se queda en el carrito hasta que vuelva.' : 'Sin conexión: no se pueden canjear premios ahora. Avisa al profesor.';
    const pon = () => d.classList.toggle('hidden', online());
    const montar = () => { document.body.appendChild(d); pon(); };
    window.addEventListener('online', pon); window.addEventListener('offline', pon);
    document.body ? montar() : document.addEventListener('DOMContentLoaded', montar);
  })();

  window.TP = { online, CFG, sleep, uid, clone, esc, store, isDemo, apiGet, apiPost, resetDemo, pickState, PIN_KEY, pedirPin: null };
})();
