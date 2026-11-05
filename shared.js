/**
 * shared.js - Utilidades comunes y capa de API (Google Apps Script o MODO DEMO)
 * Compartido por profesor.html y pantalla.html. No toca el DOM.
 *
 * Contrato de datos (igual en demo y en produccion):
 *   apiGet()  -> { ok, alumnos:[{id,nombre,icono,puntos}], premios:[{id,nombre,coste,icono}] }
 *   apiPost() -> { ok, alumnos:[...] }
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

  /* ---------- MODO DEMO: simula el servidor con datos-prueba.json + localStorage ---------- */
  const DEMO_KEY = 'demo_db_v2';

  /** Carga la base demo; la primera vez la siembra desde el JSON de prueba. */
  async function demoDB() {
    let db = store.get(DEMO_KEY, null);
    if (!db) {
      const r = await fetchTimeout(CFG.DEMO_DATA_URL || 'datos-prueba.json', { cache: 'no-cache' }, 8000);
      const seed = await r.json();
      db = { alumnos: seed.alumnos, premios: seed.premios, batches: [] };
      store.set(DEMO_KEY, db);
    }
    return db;
  }

  /** Aplica una operacion igual que Code.gs: valida, es idempotente por batchId y devuelve los saldos. */
  async function demoApply(p) {
    const db = await demoDB();
    if (db.batches.indexOf(p.batchId) === -1) {
      if (p.action === 'batch') {
        p.movimientos.forEach((m) => {
          if (!db.alumnos.some((a) => a.id === m.alumnoId)) throw new Error('Alumno no encontrado');
        });
        p.movimientos.forEach((m) => {
          const a = db.alumnos.find((x) => x.id === m.alumnoId);
          a.puntos = m.tipo === 'reset' ? 0 : a.puntos + m.delta;
        });
      } else if (p.action === 'canje') {
        const a = db.alumnos.find((x) => x.id === p.alumnoId);
        const pr = db.premios.find((x) => x.id === p.premioId);
        if (!a || !pr) throw new Error('Datos no validos');
        if (a.puntos < pr.coste) throw new Error('Saldo insuficiente');
        a.puntos -= pr.coste;
      } else {
        throw new Error('Accion desconocida');
      }
      db.batches.push(p.batchId);
      store.set(DEMO_KEY, db);
    }
    return { ok: true, alumnos: clone(db.alumnos) };
  }

  /** Vuelve a los datos del JSON de prueba. */
  function resetDemo() {
    store.del(DEMO_KEY);
  }

  /* ---------- API publica ---------- */
  async function apiGet() {
    if (isDemo()) {
      await sleep(150);
      const db = await demoDB();
      return { ok: true, alumnos: clone(db.alumnos), premios: clone(db.premios) };
    }
    const url = CFG.APPS_SCRIPT_URL + '?token=' + encodeURIComponent(CFG.TOKEN) + '&_=' + Date.now();
    const r = await fetchTimeout(url, { method: 'GET' });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || 'Error del servidor');
    return j;
  }

  /**
   * Envia una operacion. payload:
   *  { action:'batch', batchId, movimientos:[{alumnoId,tipo:'delta'|'reset',delta,nota}] }
   *  { action:'canje', batchId, alumnoId, premioId }
   * El batchId hace la operacion idempotente: reintentar no duplica movimientos.
   */
  async function apiPost(payload) {
    payload = Object.assign({}, payload, { token: CFG.TOKEN });
    if (isDemo()) {
      await sleep(500);
      if (store.get('demo_fail', false)) throw new Error('Fallo de red simulado');
      return demoApply(payload);
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

  window.TP = { CFG, sleep, uid, clone, esc, store, isDemo, apiGet, apiPost, resetDemo };
})();
