/**
 * Code.gs — Backend de "Puntos de clase" (Google Apps Script)
 * ===========================================================
 * La hoja "Movimientos" es un LEDGER (libro de registros): solo se AÑADEN filas.
 * El saldo de cada alumno = suma de la columna `delta` de sus movimientos.
 *
 * Hojas (se crean con la función setup()):
 *   Alumnos:     id | nombre | icono | activo
 *   Premios:     id | nombre | coste | icono | activo
 *   Movimientos: id | fecha | batchId | alumnoId | tipo | delta | nota | origen
 *
 *   `icono` es el NOMBRE de un icono de Material Symbols (https://fonts.google.com/icons),
 *   por ejemplo: pets, rocket_launch, sports_esports. Sin emojis.
 *   `tipo` del ledger: inicial | ajuste | reset | canje.
 *
 * Endpoints (Aplicación web):
 *   GET  ?token=...  ->  { ok, alumnos:[{id,nombre,icono,puntos}], premios:[{id,nombre,coste,icono}] }
 *                        (misma forma que datos-prueba.json: cambiar de demo a produccion no toca el frontend)
 *   POST {action:'batch', batchId, movimientos:[{alumnoId,tipo,delta,nota}], token}
 *   POST {action:'canje', batchId, alumnoId, premioId, token}
 *
 * Idempotencia: si llega un batchId que ya existe en el ledger, NO se vuelve a escribir
 * (un reintento tras un fallo de red nunca duplica puntos).
 */

// Debe coincidir con TOKEN en config.js
const TOKEN = 'cambia-esto-por-un-secreto';

const HOJA = { AL: 'Alumnos', PR: 'Premios', MV: 'Movimientos' };
const COLS_MV = 8;

/* ============ Preparación inicial (ejecútala UNA vez desde el editor) ============ */
// Datos de ejemplo: los mismos que datos-prueba.json. [id, nombre, icono, puntos iniciales]
const SEED_ALUMNOS = [
  ['a01', 'Lucía', 'pets', 190], ['a02', 'Mateo', 'rocket_launch', 60], ['a03', 'Sofía', 'sailing', 270],
  ['a04', 'Hugo', 'park', 120], ['a05', 'Martina', 'sports_soccer', 30], ['a06', 'Daniel', 'music_note', 150],
  ['a07', 'Valeria', 'palette', 310], ['a08', 'Pablo', 'bolt', 90], ['a09', 'Carla', 'local_florist', 240],
  ['a10', 'Álvaro', 'wb_sunny', 0], ['a11', 'Noa', 'water_drop', 150]
];
// [id, nombre, coste, icono]
const SEED_PREMIOS = [
  ['p01', 'Algodoo', 120, 'science'], ['p02', 'Scratch', 160, 'code'], ['p03', 'Megaman Maker', 180, 'sports_esports'],
  ['p04', 'Piskel', 200, 'brush'], ['p05', 'Lego', 240, 'extension'], ['p06', 'Subir de nivel en Lego', 280, 'upgrade']
];

function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ensure_(ss, HOJA.AL, ['id', 'nombre', 'icono', 'activo'], SEED_ALUMNOS.map((a) => [a[0], a[1], a[2], true]));
  ensure_(ss, HOJA.PR, ['id', 'nombre', 'coste', 'icono', 'activo'], SEED_PREMIOS.map((p) => [p[0], p[1], p[2], p[3], true]));
  // Saldo inicial de cada alumno como movimiento del ledger (el saldo siempre sale de sumar movimientos)
  const now = new Date();
  const iniciales = SEED_ALUMNOS.filter((a) => a[3] !== 0).map((a) => [
    Utilities.getUuid(), now, 'seed', a[0], 'inicial', a[3], 'Saldo inicial de prueba', 'setup'
  ]);
  ensure_(ss, HOJA.MV, ['id', 'fecha', 'batchId', 'alumnoId', 'tipo', 'delta', 'nota', 'origen'], iniciales);
}

function ensure_(ss, name, headers, rows) {
  const sh = ss.getSheetByName(name) || ss.insertSheet(name);
  if (sh.getLastRow() === 0) {
    sh.appendRow(headers);
    sh.setFrozenRows(1);
    if (rows.length) sh.getRange(2, 1, rows.length, headers.length).setValues(rows);
  }
}

/* ============ Lectura ============ */
function doGet(e) {
  try {
    checkToken_(e && e.parameter && e.parameter.token);
    const alumnos = alumnosActivos_();
    const bal = balances_(readLedger_());
    return out_({ ok: true, alumnos: buildAlumnos_(alumnos, bal), premios: premiosActivos_(), ts: new Date().toISOString() });
  } catch (err) {
    return out_({ ok: false, error: String(err.message || err) });
  }
}

/* ============ Escritura (movimientos del carrito y canjes) ============ */
function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000); // evita escrituras simultáneas (profesor + iPad)
    const p = JSON.parse(e.postData.contents);
    checkToken_(p.token);
    if (!p.batchId) throw new Error('Falta batchId');

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const mv = ss.getSheetByName(HOJA.MV);
    const data = readLedger_();
    const alumnos = alumnosActivos_();
    const bal = balances_(data);

    // Idempotencia: lote ya registrado -> devolver estado actual sin escribir
    if (data.some((r) => String(r[2]) === String(p.batchId))) {
      return out_({ ok: true, duplicado: true, alumnos: buildAlumnos_(alumnos, bal) });
    }

    const ids = {};
    alumnos.forEach((a) => (ids[String(a.id)] = true));
    const now = new Date();
    const rows = [];
    const add = (alumnoId, tipo, delta, nota, origen) => {
      rows.push([Utilities.getUuid(), now, String(p.batchId), String(alumnoId), tipo, delta, nota || '', origen]);
      bal[alumnoId] = (bal[alumnoId] || 0) + delta;
    };

    if (p.action === 'batch') {
      if (!Array.isArray(p.movimientos) || !p.movimientos.length) throw new Error('Carrito vacío');
      p.movimientos.forEach((m) => {
        const id = String(m.alumnoId);
        if (!ids[id]) throw new Error('Alumno no válido: ' + id);
        if (m.tipo === 'reset') {
          add(id, 'reset', 0 - (bal[id] || 0), m.nota, 'profesor'); // lleva el saldo a 0 en ese instante
        } else {
          const d = Number(m.delta);
          if (!Number.isInteger(d) || Math.abs(d) > 10000) throw new Error('Delta no válido');
          add(id, 'ajuste', d, m.nota, 'profesor');
        }
      });
    } else if (p.action === 'canje') {
      const id = String(p.alumnoId);
      if (!ids[id]) throw new Error('Alumno no válido');
      const premio = premiosActivos_().filter((x) => String(x.id) === String(p.premioId))[0];
      if (!premio) throw new Error('Premio no válido');
      if ((bal[id] || 0) < premio.coste) throw new Error('Saldo insuficiente');
      add(id, 'canje', -premio.coste, premio.nombre, 'tpv');
    } else {
      throw new Error('Acción desconocida');
    }

    // Validado todo -> escritura atómica de todas las filas de una vez
    mv.getRange(mv.getLastRow() + 1, 1, rows.length, COLS_MV).setValues(rows);
    SpreadsheetApp.flush();
    return out_({ ok: true, alumnos: buildAlumnos_(alumnos, bal) });
  } catch (err) {
    return out_({ ok: false, error: String(err.message || err) });
  } finally {
    try { lock.releaseLock(); } catch (x) {}
  }
}

/* ============ Helpers ============ */
function checkToken_(t) {
  if (String(t) !== TOKEN) throw new Error('No autorizado');
}

function out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function table_(name) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sh) throw new Error('Falta la hoja "' + name + '". Ejecuta setup().');
  const v = sh.getDataRange().getValues();
  const h = v.shift();
  return v
    .filter((r) => r[0] !== '' && r[0] != null)
    .map((r) => { const o = {}; h.forEach((k, i) => (o[k] = r[i])); return o; });
}
const activo_ = (o) => String(o.activo).toLowerCase() !== 'false';

function alumnosActivos_() {
  return table_(HOJA.AL).filter(activo_).map((a) => ({ id: String(a.id), nombre: String(a.nombre), icono: String(a.icono || 'person') }));
}
function premiosActivos_() {
  return table_(HOJA.PR).filter(activo_).map((p) => ({ id: String(p.id), nombre: String(p.nombre), coste: Number(p.coste), icono: String(p.icono || 'redeem') }));
}

function readLedger_() {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(HOJA.MV);
  if (!sh) throw new Error('Falta la hoja "Movimientos". Ejecuta setup().');
  const n = sh.getLastRow() - 1;
  return n > 0 ? sh.getRange(2, 1, n, COLS_MV).getValues() : [];
}

/** Saldo por alumno = suma de deltas del ledger */
function balances_(rows) {
  const bal = {};
  rows.forEach((r) => { const id = String(r[3]); bal[id] = (bal[id] || 0) + Number(r[5] || 0); });
  return bal;
}

function buildAlumnos_(alumnos, bal) {
  return alumnos.map((a) => ({ id: a.id, nombre: a.nombre, icono: a.icono, puntos: bal[a.id] || 0 }));
}
