/**
 * engine.js - Motor de reglas de "Puntos de clase"
 * =================================================
 * Logica de negocio PURA: no toca el DOM, ni Google Sheets, ni la red.
 *
 * Se usa en dos sitios con EL MISMO CODIGO:
 *   - En el navegador (modo de prueba): shared.js lo ejecuta contra datos-prueba.json.
 *   - En Google Apps Script: Code.gs contiene una copia de este archivo entre los marcadores
 *     MOTOR:INICIO y MOTOR:FIN. Si cambias una regla aqui, copia el bloque a Code.gs.
 *
 * TABLAS DE ENTRADA (t): cada clave es una pestana de la hoja de calculo
 *   t.alumnos         [{id,nombre,avatar,color,activo}]
 *   t.reglasYPremios  [{id,tipo,nombre,puntos,icono,efecto,descripcion,activo}]
 *                       tipo: 'regla' | 'premio' | 'insignia'
 *   t.config          [{clave,valor}]
 *   t.movimientos     [{id,fecha,batchId,alumnoId,tipo,delta,nota,origen,ref}]   <- LEDGER
 *
 * CONTEXTO (ctx), para que el motor no dependa del entorno:
 *   ctx.now     Date actual
 *   ctx.fmtDay  (Date) -> 'YYYY-MM-DD' en la zona horaria de la clase
 *   ctx.uuid    () -> id unico
 *
 * TIPOS DE MOVIMIENTO DEL LEDGER
 *   inicial | ajuste (profesor) | ruleta (profesor) | racha (bonus automatico)
 *   reset | canje | insignia (delta 0, ref = id de insignia) | perfil (delta 0, ref = 'avatar|color')
 *
 * REGLAS DE NEGOCIO
 *  - Saldo = suma de delta del ledger.
 *  - Dia de clase = dia con algun movimiento 'ajuste' o 'ruleta' (de cualquier alumno).
 *  - Racha = dias de clase seguidos, hasta el mas reciente, en los que el alumno suma neto > 0.
 *    Cada vez que la racha llega a un multiplo de racha_hito se concede racha_bonus (una sola vez).
 *  - Reto de clase = puntos GANADOS (ajuste, ruleta, racha) desde reto_desde. No baja al canjear.
 *  - Personalizar: cada canje de un premio con efecto 'personalizar' da derecho a un cambio
 *    de avatar/color; cada movimiento 'perfil' consume uno.
 */
const Engine = (function () {
  'use strict';

  const TIPOS_RACHA = ['ajuste', 'ruleta'];
  const TIPOS_GANADOS = ['ajuste', 'ruleta', 'racha'];
  const COLORES = ['base', 'azul', 'verde', 'turquesa', 'amarillo', 'naranja', 'rosa', 'violeta', 'arena'];
  const AVATARES = [
    'pets', 'rocket_launch', 'sailing', 'park', 'sports_soccer', 'music_note', 'palette', 'bolt',
    'local_florist', 'wb_sunny', 'water_drop', 'diamond', 'anchor', 'nightlight', 'forest', 'ac_unit',
    'cookie', 'hiking', 'kayaking', 'piano', 'eco', 'volcano', 'sports_basketball', 'cruelty_free'
  ];

  const DEFAULTS = {
    racha_hito: 5,
    racha_bonus: 10,
    reto_nombre: 'Reto de clase',
    reto_meta: 0,
    reto_premio: '',
    reto_icono: 'flag',
    reto_desde: '',
    ruleta_bonus: '5,10,20',
    avatares: AVATARES.join(','),
    colores: COLORES.join(',')
  };

  /* ---------- Utilidades ---------- */
  const str = (v) => (v == null ? '' : String(v));
  const isDate = (v) => Object.prototype.toString.call(v) === '[object Date]';
  const isActivo = (o) => str(o.activo).toLowerCase() !== 'false';
  const list = (v) => str(v).split(',').map((s) => s.trim()).filter(Boolean);
  const int = (v, d) => {
    const n = Number(v);
    return str(v) !== '' && isFinite(n) ? Math.floor(n) : d;
  };

  /** Fecha (Date, ISO o 'YYYY-MM-DD') -> 'YYYY-MM-DD' en la zona de la clase. '' si no es valida. */
  function toDay(v, ctx) {
    if (isDate(v)) return isNaN(v.getTime()) ? '' : ctx.fmtDay(v);
    const s = str(v).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    const d = new Date(s);
    return isNaN(d.getTime()) ? '' : ctx.fmtDay(d);
  }

  /* ---------- Configuracion (pestana Config) ---------- */
  function readConfig(rows) {
    const raw = {};
    (rows || []).forEach((r) => {
      if (str(r.clave).trim()) raw[str(r.clave).trim()] = r.valor;
    });
    const g = (k) => (raw[k] !== undefined && str(raw[k]).trim() !== '' ? raw[k] : DEFAULTS[k]);
    const avatares = list(g('avatares'));
    const colores = list(g('colores')).filter((c) => COLORES.indexOf(c) >= 0);
    const bonus = list(g('ruleta_bonus')).map(Number).filter((n) => Number.isInteger(n) && n > 0);
    return {
      rachaHito: Math.max(1, int(g('racha_hito'), 5)),
      rachaBonus: Math.max(0, int(g('racha_bonus'), 10)),
      retoNombre: str(g('reto_nombre')),
      retoMeta: Math.max(0, int(g('reto_meta'), 0)),
      retoPremio: str(g('reto_premio')),
      retoIcono: str(g('reto_icono')) || 'flag',
      retoDesde: g('reto_desde'),
      ruletaBonus: bonus.length ? bonus : [5, 10, 20],
      avatares: avatares.length ? avatares : AVATARES.slice(),
      colores: colores.length ? colores : COLORES.slice()
    };
  }

  /* ---------- Calculos sobre el ledger ---------- */
  function balances(led) {
    const bal = {};
    led.forEach((m) => {
      const id = str(m.alumnoId);
      bal[id] = (bal[id] || 0) + Number(m.delta || 0);
    });
    return bal;
  }

  /** Dias de clase y neto diario por alumno. */
  function dayTables(led, ctx) {
    const days = {};
    const net = {};
    led.forEach((m) => {
      if (TIPOS_RACHA.indexOf(m.tipo) < 0) return;
      const d = toDay(m.fecha, ctx);
      if (!d) return;
      days[d] = true;
      const id = str(m.alumnoId);
      net[id] = net[id] || {};
      net[id][d] = (net[id][d] || 0) + Number(m.delta || 0);
    });
    return { days: Object.keys(days).sort(), net };
  }

  /** Racha actual de un alumno y dia en que empezo. */
  function streakOf(dt, alumnoId) {
    const mine = dt.net[str(alumnoId)] || {};
    let i = dt.days.length - 1;
    let n = 0;
    while (i >= 0 && (mine[dt.days[i]] || 0) > 0) {
      n++;
      i--;
    }
    return { racha: n, inicio: n ? dt.days[i + 1] : '' };
  }

  /** Cambios de personalizacion disponibles = compras de premios 'personalizar' - usos ('perfil'). */
  function pendientesMap(items, led) {
    const ids = {};
    items.forEach((i) => {
      if (i.tipo === 'premio' && str(i.efecto) === 'personalizar') ids[str(i.id)] = true;
    });
    const out = {};
    led.forEach((m) => {
      const id = str(m.alumnoId);
      if (m.tipo === 'canje' && ids[str(m.ref)]) out[id] = (out[id] || 0) + 1;
      if (m.tipo === 'perfil') out[id] = (out[id] || 0) - 1;
    });
    Object.keys(out).forEach((id) => (out[id] = Math.max(0, out[id])));
    return out;
  }

  /* ---------- Estado que ve el frontend (respuesta de GET) ---------- */
  function computeState(t, ctx) {
    const c = readConfig(t.config);
    const led = t.movimientos || [];
    const items = t.reglasYPremios || [];
    const activeItems = items.filter(isActivo);
    const alumnosAct = (t.alumnos || []).filter(isActivo);
    const idsAct = {};
    alumnosAct.forEach((a) => (idsAct[str(a.id)] = true));

    const bal = balances(led);
    const dt = dayTables(led, ctx);
    const pend = pendientesMap(items, led);
    const insig = {};
    led.forEach((m) => {
      if (m.tipo !== 'insignia') return;
      const id = str(m.alumnoId);
      insig[id] = insig[id] || [];
      if (insig[id].indexOf(str(m.ref)) < 0) insig[id].push(str(m.ref));
    });

    const alumnos = alumnosAct.map((a) => {
      const id = str(a.id);
      return {
        id,
        nombre: str(a.nombre),
        avatar: str(a.avatar) || 'person',
        color: str(a.color) || 'base',
        puntos: bal[id] || 0,
        racha: streakOf(dt, id).racha,
        insignias: insig[id] || [],
        pendientes: pend[id] || 0
      };
    });

    // Reto de clase: puntos ganados desde reto_desde por los alumnos activos
    const desde = c.retoDesde ? toDay(c.retoDesde, ctx) : '';
    let progreso = 0;
    led.forEach((m) => {
      if (TIPOS_GANADOS.indexOf(m.tipo) < 0 || !idsAct[str(m.alumnoId)] || Number(m.delta) <= 0) return;
      if (desde && toDay(m.fecha, ctx) < desde) return;
      progreso += Number(m.delta);
    });
    const reto = c.retoMeta > 0
      ? { nombre: c.retoNombre, meta: c.retoMeta, progreso, premio: c.retoPremio, icono: c.retoIcono, logrado: progreso >= c.retoMeta }
      : null;

    const view = (i) => ({ id: str(i.id), nombre: str(i.nombre), icono: str(i.icono), descripcion: str(i.descripcion) });
    return {
      alumnos,
      reglas: activeItems.filter((i) => i.tipo === 'regla').map((i) => Object.assign(view(i), { puntos: Number(i.puntos) || 0 })),
      premios: activeItems.filter((i) => i.tipo === 'premio').map((i) => Object.assign(view(i), { coste: Number(i.puntos) || 0, efecto: str(i.efecto) || 'ninguno' })),
      insignias: activeItems.filter((i) => i.tipo === 'insignia').map(view),
      reto,
      config: { rachaHito: c.rachaHito, rachaBonus: c.rachaBonus, ruletaBonus: c.ruletaBonus, avatares: c.avatares, colores: c.colores },
      ts: ctx.now.toISOString()
    };
  }

  /* ---------- Operaciones (POST) ---------- */
  /**
   * Valida y calcula las filas nuevas del ledger. NO escribe nada: devuelve
   *   { rows, patches, bonificaciones, duplicado }
   * rows            filas a anadir al ledger
   * patches         cambios en la pestana Alumnos: [{alumnoId, avatar, color}]
   * bonificaciones  bonus de racha concedidos: [{alumnoId, racha, bonus}]
   * Lanza Error si algo no es valido (no se debe escribir nada en ese caso).
   */
  function applyAction(t, p, ctx) {
    if (!p || !p.batchId) throw new Error('Falta batchId');
    const led = t.movimientos || [];
    // Idempotencia: un lote ya registrado no se vuelve a escribir
    if (led.some((m) => str(m.batchId) === str(p.batchId))) {
      return { rows: [], patches: [], bonificaciones: [], duplicado: true };
    }

    const c = readConfig(t.config);
    const items = t.reglasYPremios || [];
    const activos = {};
    (t.alumnos || []).filter(isActivo).forEach((a) => (activos[str(a.id)] = true));
    const bal = balances(led);
    const owned = {};
    led.forEach((m) => {
      if (m.tipo === 'insignia') owned[str(m.alumnoId) + '|' + str(m.ref)] = true;
    });

    const rows = [];
    const patches = [];
    const bonificaciones = [];
    const add = (alumnoId, tipo, delta, nota, origen, ref) => {
      rows.push({
        id: ctx.uuid(), fecha: ctx.now, batchId: str(p.batchId), alumnoId, tipo,
        delta, nota: nota || '', origen, ref: ref || ''
      });
      bal[alumnoId] = (bal[alumnoId] || 0) + delta;
    };
    const alumnoValido = (v) => {
      const id = str(v);
      if (!activos[id]) throw new Error('Alumno no válido: ' + id);
      return id;
    };

    if (p.action === 'batch') {
      if (!Array.isArray(p.movimientos) || !p.movimientos.length) throw new Error('Carrito vacío');
      p.movimientos.forEach((m) => {
        const id = alumnoValido(m.alumnoId);
        const nota = str(m.nota).slice(0, 80);
        if (m.tipo === 'reset') {
          add(id, 'reset', 0 - (bal[id] || 0), nota, 'profesor'); // lleva el saldo a 0 en ese instante
        } else if (m.tipo === 'insignia') {
          const ins = items.filter((i) => i.tipo === 'insignia' && isActivo(i) && str(i.id) === str(m.ref))[0];
          if (!ins) throw new Error('Insignia no válida');
          if (owned[id + '|' + str(ins.id)]) return; // ya la tiene: se ignora
          owned[id + '|' + str(ins.id)] = true;
          add(id, 'insignia', 0, str(ins.nombre), 'profesor', str(ins.id));
        } else {
          const d = Number(m.delta);
          if (!Number.isInteger(d) || d === 0 || Math.abs(d) > 10000) throw new Error('Delta no válido');
          if (m.tipo === 'ruleta') {
            if (d < 0) throw new Error('La ruleta solo suma');
            add(id, 'ruleta', d, nota || 'Ruleta', 'profesor');
          } else {
            add(id, 'ajuste', d, nota, 'profesor');
          }
        }
      });
    } else if (p.action === 'canje') {
      const id = alumnoValido(p.alumnoId);
      const premio = items.filter((i) => i.tipo === 'premio' && isActivo(i) && str(i.id) === str(p.premioId))[0];
      if (!premio) throw new Error('Premio no válido');
      const coste = Number(premio.puntos) || 0;
      if ((bal[id] || 0) < coste) throw new Error('Saldo insuficiente');
      add(id, 'canje', -coste, str(premio.nombre), 'tpv', str(premio.id));
    } else if (p.action === 'perfil') {
      const id = alumnoValido(p.alumnoId);
      const avatar = str(p.avatar);
      const color = str(p.color);
      if (c.avatares.indexOf(avatar) < 0) throw new Error('Avatar no válido');
      if (c.colores.indexOf(color) < 0) throw new Error('Color no válido');
      if (!(pendientesMap(items, led)[id] > 0)) throw new Error('No tienes una personalización disponible');
      add(id, 'perfil', 0, 'Personalización', 'tpv', avatar + '|' + color);
      patches.push({ alumnoId: id, avatar, color });
    } else {
      throw new Error('Acción desconocida');
    }

    // Bonus automatico por racha (solo tras movimientos del profesor)
    if (p.action === 'batch' && c.rachaBonus > 0) {
      const led2 = led.concat(rows);
      const dt = dayTables(led2, ctx);
      const tocados = {};
      rows.forEach((r) => {
        if (TIPOS_RACHA.indexOf(r.tipo) >= 0) tocados[r.alumnoId] = true;
      });
      Object.keys(tocados).forEach((id) => {
        const s = streakOf(dt, id);
        if (s.racha > 0 && s.racha % c.rachaHito === 0) {
          const key = s.inicio + ':' + s.racha; // una racha concreta solo premia una vez cada hito
          const ya = led2.some((m) => m.tipo === 'racha' && str(m.alumnoId) === id && str(m.ref) === key);
          if (!ya) {
            add(id, 'racha', c.rachaBonus, 'Racha de ' + s.racha + ' clases', 'sistema', key);
            bonificaciones.push({ alumnoId: id, racha: s.racha, bonus: c.rachaBonus });
          }
        }
      });
    }

    return { rows, patches, bonificaciones, duplicado: false };
  }

  return { computeState, applyAction, COLORES, AVATARES, DEFAULTS };
})();
