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
 *                       tipo: 'regla' | 'premio' | 'insignia' | 'cuidado' (efecto: comer|acariciar|banar|jugar)
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
 *  - Dia de clase = dia con algun movimiento 'ajuste' o 'ruleta' (de cualquier alumno) que cae en
 *    uno de los dias de la semana de Config.dias_clase (1=lunes ... 7=domingo; por defecto 2,4 = martes y jueves).
 *    Los demas dias nunca cuentan ni rompen la racha. Un dia de clase sin ningun apunte es festivo.
 *  - Racha = dias de clase seguidos, hasta el mas reciente, en los que el alumno suma neto > 0.
 *    El dia en curso aun no rompe la racha mientras el alumno no tenga neto positivo.
 *    Cada vez que la racha llega a un multiplo de racha_hito se concede racha_bonus (una sola vez).
 *  - Insignias: duran Config.insignia_dias dias (por defecto 7): caducan al final del dia concesion + N.
 *    Volver a concederla reinicia el plazo. Su historial queda en el ledger.
 *  - Cosmeticos (colores extra, degradados y avatares imagen): los desbloquea una insignia (columna
 *    efecto de su fila, p. ej. 'fondo:aurora,color:dorado,avatar:robot'). Basta con haberla recibido
 *    alguna vez: el desbloqueo NO caduca. El servidor rechaza cosmeticos no desbloqueados.
 *  - Reto de clase = puntos GANADOS (ajuste, ruleta, racha) desde reto_desde. No baja al canjear.
 *  - Personalizar: cada canje de un premio con efecto 'personalizar' da derecho a un cambio
 *    de avatar/color; cada movimiento 'perfil' consume uno.
 *  - MASCOTA de clase: progreso = puntos ganados por todos (ajuste, ruleta, racha, rol, estrella)
 *    MENOS las restas por conducta (ajustes y 'a cero' negativos). Los canjes (incluidas las acciones
 *    de la mascota) NUNCA restan. Nunca baja de etapa: si una resta no cabe en la etapa actual se anota
 *    como 'deuda' y la mascota queda en PELIGRO hasta que la clase la recupere o el profesor la reinicie
 *    (movimiento 'mascota' con ref 'reset'). Se calcula recorriendo el ledger en orden.
 *  - Necesidad de la mascota: cada clase (dia de dias_clase) pide UNA accion distinta (comer, acariciar,
 *    banar, jugar), de forma fija segun la fecha. Se atiende canjeando el premio con efecto
 *    'mascota:comer' (etc.). Solo se puede una vez por clase y solo la accion que toca.
 *  - Nombre de la mascota: premio con efecto 'nombre' cuya descripcion lista los nombres separados por ';'.
 *    Cada alumno canjea uno una sola vez. Cuando votan todos (o el profesor cierra) gana el mas votado
 *    (empate: el que alcanzo antes sus votos).
 *  - Estrella amable: premio con efecto 'estrella' (descripcion = frases separadas por ';'). El alumno
 *    propone una a un companero (1 al dia); el profesor la aprueba (suma estrella_puntos) o rechaza.
 *  - Ayudante de turno: rota por orden de la hoja Alumnos; el profesor confirma (suma ayudante_puntos)
 *    o salta al siguiente si falta.
 */
const Engine = (function () {
  'use strict';

  const TIPOS_RACHA = ['ajuste', 'ruleta'];
  const TIPOS_GANADOS = ['ajuste', 'ruleta', 'racha', 'rol', 'estrella_res'];
  const ACCIONES_MASCOTA = ['comer', 'acariciar', 'banar', 'jugar'];
  const COLORES = ['base', 'azul', 'verde', 'turquesa', 'amarillo', 'naranja', 'rosa', 'violeta', 'arena'];
  const AVATARES = [
    'pets', 'rocket_launch', 'sailing', 'park', 'sports_soccer', 'music_note', 'palette', 'bolt',
    'local_florist', 'wb_sunny', 'water_drop', 'diamond', 'anchor', 'nightlight', 'forest', 'ac_unit',
    'cookie', 'hiking', 'kayaking', 'piano', 'eco', 'volcano', 'sports_basketball', 'cruelty_free'
  ];

  // Cosmeticos desbloqueables (los dibujos estan en ui.js / styles.css / carpeta avatares/).
  // Aqui solo viven las CLAVES: la hoja decide que insignia desbloquea cada una.
  const COSMETICOS = {
    colores: ['coral', 'lavanda', 'menta', 'dorado', 'deg-aurora', 'deg-atardecer', 'deg-oceano', 'deg-bosque'],
    avatares: ['img:robot', 'img:androide', 'img:gato', 'img:zorro', 'img:buho', 'img:pulpo']
  };
  const TODOS_COSMETICOS = COSMETICOS.colores.concat(COSMETICOS.avatares);

  const DEFAULTS = {
    dias_clase: '2,4',
    insignia_dias: 7,
    racha_hito: 5,
    racha_bonus: 10,
    reto_nombre: 'Reto de clase',
    reto_meta: 0,
    reto_premio: '',
    reto_icono: 'flag',
    reto_desde: '',
    mascota_activa: 'true',
    mascota_nombre: 'Mascota desconocida',
    mascota_desde: '',
    mascota_etapas: '0,100,300,600,1000',
    mascota_premio: '',
    estrella_puntos: 2,
    ayudante_puntos: 2,
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

  /** Dia de la semana ISO de un 'YYYY-MM-DD' (1 = lunes ... 7 = domingo). */
  function isoDow(day) {
    const p = day.split('-').map(Number);
    const w = new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay();
    return w === 0 ? 7 : w;
  }
  /** Numero de dia (para restar fechas 'YYYY-MM-DD'). */
  function dayNum(day) {
    const p = day.split('-').map(Number);
    return Date.UTC(p[0], p[1] - 1, p[2]) / 86400000;
  }

  /** Umbrales de puntos de las 5 etapas de la mascota. Deben ser 5 numeros crecientes y el primero 0. */
  const ETAPAS_MASCOTA = 5;
  function etapasMascota(v) {
    const n = list(v).map(Number);
    const ok = n.length === ETAPAS_MASCOTA && n[0] === 0 && n.every((x, i) => Number.isInteger(x) && (i === 0 || x > n[i - 1]));
    return ok ? n : list(DEFAULTS.mascota_etapas).map(Number);
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
    let diasClase = str(g('dias_clase')).split(/[,;.\s]+/).filter(Boolean).map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= 7);
    if (!diasClase.length) diasClase = [2, 4];
    return {
      diasClase,
      insigniaDias: Math.max(1, int(g('insignia_dias'), 7)),
      rachaHito: Math.max(1, int(g('racha_hito'), 5)),
      rachaBonus: Math.max(0, int(g('racha_bonus'), 10)),
      retoNombre: str(g('reto_nombre')),
      retoMeta: Math.max(0, int(g('reto_meta'), 0)),
      retoPremio: str(g('reto_premio')),
      retoIcono: str(g('reto_icono')) || 'flag',
      retoDesde: g('reto_desde'),
      mascotaActiva: str(g('mascota_activa')).trim().toLowerCase() !== 'false',
      tpvBloqueo: str(g('tpv_bloqueo')).trim().toLowerCase() !== 'false', // FALSE = sin bloqueo de canje
      mascotaNombre: str(g('mascota_nombre')).trim() || 'Mascota desconocida',
      mascotaDesde: g('mascota_desde'),
      mascotaEtapas: etapasMascota(g('mascota_etapas')),
      mascotaPremio: str(g('mascota_premio')),
      estrellaPuntos: Math.max(0, int(g('estrella_puntos'), 2)),
      ayudantePuntos: Math.max(0, int(g('ayudante_puntos'), 2)),
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

  /** Dias de clase (solo los dias de la semana de dias_clase) y neto diario por alumno. */
  function dayTables(led, ctx, diasClase) {
    const days = {};
    const net = {};
    const neg = {};
    led.forEach((m) => {
      if (TIPOS_RACHA.indexOf(m.tipo) < 0) return;
      const d = toDay(m.fecha, ctx);
      if (!d || diasClase.indexOf(isoDow(d)) < 0) return;
      days[d] = true;
      const id = str(m.alumnoId);
      net[id] = net[id] || {};
      net[id][d] = (net[id][d] || 0) + Number(m.delta || 0);
      if (Number(m.delta || 0) < 0) neg[id + '|' + d] = true; // una sola resta ese dia rompe la racha
    });
    return { days: Object.keys(days).sort(), net, neg };
  }

  /** Racha actual de un alumno y dia en que empezo. 'hoy' aun no rompe la racha si no es positivo. */
  function streakOf(dt, alumnoId, hoy) {
    const mine = dt.net[str(alumnoId)] || {};
    let i = dt.days.length - 1;
    const ok = (d) => (mine[d] || 0) > 0 && !dt.neg[str(alumnoId) + '|' + d]; // solo puntos positivos ese dia
    if (i >= 0 && dt.days[i] === hoy && (mine[hoy] || 0) <= 0 && !dt.neg[str(alumnoId) + '|' + hoy]) i--; // el dia en curso no ha terminado
    let n = 0;
    while (i >= 0 && ok(dt.days[i])) {
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

  /** 'fondo:aurora' -> 'deg-aurora', 'color:dorado' -> 'dorado', 'avatar:robot' -> 'img:robot'. */
  function cosKey(tok) {
    const m = String(tok).trim().match(/^(fondo|color|avatar|img):\s*(.+)$/i);
    const k = !m ? String(tok).trim() : { fondo: 'deg-', color: '', avatar: 'img:', img: 'img:' }[m[1].toLowerCase()] + m[2].trim();
    return TODOS_COSMETICOS.indexOf(k) >= 0 || /^img:[a-z0-9-]{1,30}(\.(png|svg))?$/.test(k) ? k : '';
  }
  /** Cosmeticos que desbloquea cada insignia: {idInsignia: [claves]} (lee la columna efecto). */
  function unlockMap(items) {
    const out = {};
    items.forEach((i) => {
      if (i.tipo !== 'insignia') return;
      out[str(i.id)] = str(i.efecto).split(/[,;\s]+/).map(cosKey).filter(Boolean);
    });
    return out;
  }
  /** Insignias por alumno: activas (con dias que les quedan) y todas las alguna vez recibidas. */
  function insigniaTables(led, ctx, dias) {
    const hoy = dayNum(ctx.fmtDay(ctx.now));
    const last = {};
    const ever = {};
    led.forEach((m) => {
      if (m.tipo !== 'insignia') return;
      const d = toDay(m.fecha, ctx);
      if (!d) return;
      const id = str(m.alumnoId);
      const ref = str(m.ref);
      ever[id] = ever[id] || {};
      ever[id][ref] = true;
      last[id] = last[id] || {};
      if (!last[id][ref] || d > last[id][ref]) last[id][ref] = d;
    });
    const activas = {};
    Object.keys(last).forEach((id) => {
      Object.keys(last[id]).forEach((ref) => {
        const restan = dias - (hoy - dayNum(last[id][ref])); // 0 = ultimo dia
        if (restan >= 0) {
          activas[id] = activas[id] || {};
          activas[id][ref] = Math.min(dias, restan);
        }
      });
    });
    return { activas, ever };
  }
  /** Cosmeticos desbloqueados por un alumno (permanente: basta con haber recibido la insignia). */
  function cosmeticosDe(everMine, unlocks) {
    const out = [];
    Object.keys(everMine || {}).forEach((ref) => (unlocks[ref] || []).forEach((k) => { if (out.indexOf(k) < 0) out.push(k); }));
    return out;
  }


  /* ---------- Mascota, votaciones y roles ---------- */
  const splitOpciones = (v) => str(v).split(/[;|]/).map((s) => s.trim()).filter(Boolean);
  const efectoDe = (items) => {
    const m = {};
    items.forEach((i) => { if (i.tipo === 'premio' || i.tipo === 'cuidado') m[str(i.id)] = str(i.efecto); });
    return m;
  };
  const accionDe = (efecto) => {
    const m = str(efecto).trim().match(/^(?:mascota:)?([a-z]+)$/); // en tipo 'cuidado' basta 'comer'; 'mascota:comer' tambien vale
    return m && ACCIONES_MASCOTA.indexOf(m[1]) >= 0 ? m[1] : '';
  };
  /** Cuidado de la mascota: tipo 'cuidado' (o un premio antiguo con efecto mascota:accion). */
  const esCuidado = (i) => (i.tipo === 'cuidado' && !!accionDe(i.efecto)) || (i.tipo === 'premio' && /^mascota:/.test(str(i.efecto)) && !!accionDe(i.efecto));
  /** Dia de clase mas reciente (hoy incluido). */
  function ultimaClase(hoy, diasClase) {
    const n = dayNum(hoy);
    for (let i = 0; i < 7; i++) {
      const key = new Date((n - i) * 86400000).toISOString().slice(0, 10);
      if (diasClase.indexOf(isoDow(key)) >= 0) return key;
    }
    return hoy;
  }
  /** Numero de orden de una clase: sirve para rotar la necesidad de la mascota. */
  function ordenClase(day, diasClase) {
    const dow = isoDow(day);
    const sorted = diasClase.slice().sort((a, b) => a - b);
    const semana = Math.floor((dayNum(day) - (dow - 1) - 4) / 7); // el lunes 1970-01-05 es el dia 4
    return semana * sorted.length + Math.max(0, sorted.indexOf(dow));
  }
  /** Que pide la mascota en la clase actual y si ya esta atendida. */
  function necesidadMascota(led, items, ctx, c) {
    const hoy = ctx.fmtDay(ctx.now);
    const clase = ultimaClase(hoy, c.diasClase);
    const accion = ACCIONES_MASCOTA[((ordenClase(clase, c.diasClase) % 4) + 4) % 4];
    const ef = efectoDe(items);
    const atendida = led.some((m) => m.tipo === 'canje' && accionDe(ef[str(m.ref)]) && toDay(m.fecha, ctx) >= clase);
    return { accion, atendida, clase };
  }
  /** Votos del nombre de la mascota (primer voto de cada alumno) y estado de la votacion. */
  function votacionNombre(led, items, alumnosAct, c) {
    const premio = items.filter((i) => i.tipo === 'premio' && isActivo(i) && str(i.efecto) === 'nombre')[0];
    if (!premio) return { estado: 'ninguna', premioId: '', opciones: [], votos: {}, votantes: 0, total: alumnosAct.length, porAlumno: {}, ganador: '', fecha: null };
    const opciones = splitOpciones(premio.descripcion);
    const activos = {};
    alumnosAct.forEach((a) => (activos[str(a.id)] = true));
    const porAlumno = {};
    const orden = [];
    let fecha = null;
    led.forEach((m) => {
      if (m.tipo === 'canje' && str(m.ref) === str(premio.id) && activos[str(m.alumnoId)] && !porAlumno[str(m.alumnoId)] && opciones.indexOf(str(m.nota)) >= 0) {
        porAlumno[str(m.alumnoId)] = str(m.nota);
        orden.push(str(m.nota));
        fecha = m.fecha;
      }
    });
    const votos = {};
    const alcanzo = {};
    opciones.forEach((o) => (votos[o] = 0));
    orden.forEach((o, idx) => { votos[o]++; alcanzo[o] = idx; });
    const cierre = led.filter((m) => m.tipo === 'mascota' && str(m.ref) === 'cerrar-nombre')[0];
    if (cierre) fecha = cierre.fecha;
    const votantes = orden.length;
    const cerrada = !!cierre || (alumnosAct.length > 0 && votantes >= alumnosAct.length);
    const ranking = opciones.filter((o) => votos[o] > 0).sort((x, y) => votos[y] - votos[x] || alcanzo[x] - alcanzo[y]);
    return {
      estado: cerrada ? 'cerrada' : 'abierta', premioId: str(premio.id), opciones, votos, votantes, total: alumnosAct.length,
      porAlumno, ganador: cerrada && ranking.length ? ranking[0] : '', fecha
    };
  }
  /** Clase anterior a hoy (estrictamente antes): jueves -> martes, martes -> jueves pasado. */
  function claseAnterior(hoy, diasClase) {
    const n = dayNum(hoy);
    for (let i = 1; i <= 7; i++) {
      const key = new Date((n - i) * 86400000).toISOString().slice(0, 10);
      if (diasClase.indexOf(isoDow(key)) >= 0) return key;
    }
    return '';
  }
  /** TPV: un alumno solo puede canjear si el profesor lo ha desbloqueado. Se vuelve a bloquear tras canjear/enviar estrella o al pulsar Cambiar. */
  function tpvAbiertos(led) {
    const m = {};
    led.forEach((r) => {
      if (r.tipo === 'tpv') m[str(r.alumnoId)] = str(r.ref) === 'abrir';
      else if (r.tipo === 'canje') m[str(r.alumnoId)] = false;
      else if (r.tipo === 'estrella') m[str(r.ref)] = false; // en 'estrella' el alumno que envia va en ref
    });
    return m;
  }
  /** Estrellas aprobadas recibidas en la clase anterior: { alumnoId: [{de, frase}] }. */
  function estrellasRecibidas(led, ctx, diasClase, hoy, nombres) {
    const dia = claseAnterior(hoy, diasClase);
    const res = {};
    led.forEach((m) => { if (m.tipo === 'estrella_res') res[str(m.ref)] = m; });
    const out = {};
    led.forEach((m) => {
      if (m.tipo !== 'estrella' || toDay(m.fecha, ctx) !== dia) return;
      const r = res[str(m.id)];
      if (!r || str(r.nota) === 'Rechazada') return;
      const para = str(m.alumnoId);
      (out[para] = out[para] || []).push({ de: nombres[str(m.ref)] || '', frase: str(m.nota) });
    });
    return out;
  }
  /** Estrellas amables pendientes de que el profesor las revise. */
  /** Companeros a los que `de` envio una estrella hace menos de 2 semanas (no puede repetir todavia). */
  const ESTRELLA_ESPERA_DIAS = 14;
  function estrellaBloqueados(led, ctx, de, hoyDia) {
    const out = [];
    led.forEach((m) => {
      if (m.tipo === 'estrella' && str(m.ref) === str(de) && hoyDia - dayNum(toDay(m.fecha, ctx)) < ESTRELLA_ESPERA_DIAS && out.indexOf(str(m.alumnoId)) < 0) out.push(str(m.alumnoId));
    });
    return out;
  }
  function estrellasPendientes(led) {
    const resueltas = {};
    led.forEach((m) => { if (m.tipo === 'estrella_res') resueltas[str(m.ref)] = true; });
    return led.filter((m) => m.tipo === 'estrella' && !resueltas[str(m.id)]);
  }
  /** Ayudante de turno: el siguiente en la lista despues del ultimo que tuvo el rol (confirmado o saltado). */
  function ayudanteDe(led, alumnosAct) {
    if (!alumnosAct.length) return null;
    let ult = null;
    led.forEach((m) => { if (m.tipo === 'rol') ult = str(m.alumnoId); });
    const idx = alumnosAct.findIndex((a) => str(a.id) === ult);
    return alumnosAct[(idx + 1) % alumnosAct.length];
  }
  /**
   * Mascota: recorre el ledger EN ORDEN. Nunca baja de etapa; lo que no cabe se acumula como deuda (peligro).
   * Devuelve {progreso, etapa, deuda, diario[]}. Los canjes nunca restan.
   */
  function progresoMascota(led, items, ctx, c, idsAct) {
    const th = c.mascotaEtapas;
    const desde = c.mascotaDesde ? toDay(c.mascotaDesde, ctx) : '';
    const ef = efectoDe(items);
    let p = 0, piso = 0, etapa = 0, deuda = 0;
    const diario = [];
    led.forEach((m) => {
      const dia = toDay(m.fecha, ctx);
      if (desde && dia && dia < desde) return;
      if (m.tipo === 'mascota') {
        if (str(m.ref) === 'reset') { p = 0; piso = 0; etapa = 0; deuda = 0; diario.push({ dia, tipo: 'reinicio' }); }
        return;
      }
      if (m.tipo === 'canje') {
        const a = accionDe(ef[str(m.ref)]);
        if (a && idsAct[str(m.alumnoId)]) diario.push({ dia, tipo: 'accion', accion: a, alumnoId: str(m.alumnoId) });
        return;
      }
      if (!idsAct[str(m.alumnoId)]) return;
      const d = Number(m.delta) || 0;
      if (d > 0 && TIPOS_GANADOS.indexOf(m.tipo) >= 0) {
        let gana = d;
        if (deuda > 0) {
          const paga = Math.min(deuda, gana);
          deuda -= paga;
          gana -= paga;
          if (deuda === 0) diario.push({ dia, tipo: 'recuperada' });
        }
        p += gana;
      } else if (d < 0) {
        const nuevo = p + d;
        if (nuevo < piso) {
          if (deuda === 0) diario.push({ dia, tipo: 'peligro' });
          deuda += piso - nuevo;
          p = piso;
        } else {
          p = nuevo;
        }
      }
      th.forEach((u, i) => { if (p >= u && i > etapa) { etapa = i; piso = th[i]; diario.push({ dia, tipo: 'crecio', etapa: i }); } });
    });
    return { progreso: p, etapa, deuda, diario };
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
    const hoy = ctx.fmtDay(ctx.now);
    const dt = dayTables(led, ctx, c.diasClase);
    const pend = pendientesMap(items, led);
    const it = insigniaTables(led, ctx, c.insigniaDias);
    const unlocks = unlockMap(items);
    const vot = votacionNombre(led, items, alumnosAct, c);
    const tpv = tpvAbiertos(led);
    const nombresAl = {};
    alumnosAct.forEach((a) => (nombresAl[str(a.id)] = str(a.nombre)));
    const recibidas = estrellasRecibidas(led, ctx, c.diasClase, hoy, nombresAl);
    const estHoy = {};
    led.forEach((m) => { if (m.tipo === 'estrella' && toDay(m.fecha, ctx) === hoy) estHoy[str(m.ref)] = true; });

    const alumnos = alumnosAct.map((a) => {
      const id = str(a.id);
      return {
        id,
        nombre: str(a.nombre),
        avatar: str(a.avatar) || 'person',
        color: str(a.color) || 'base',
        puntos: bal[id] || 0,
        racha: streakOf(dt, id, hoy).racha,
        insignias: Object.keys(it.activas[id] || {}).sort((x, y) => it.activas[id][y] - it.activas[id][x]),
        insigniasRestan: it.activas[id] || {},
        cosmeticos: cosmeticosDe(it.ever[id], unlocks),
        pendientes: pend[id] || 0,
        votoNombre: vot.porAlumno[id] || '',
        estrellaHoy: !!estHoy[id],
        estrellaBloqueados: estrellaBloqueados(led, ctx, id, dayNum(hoy)),
        desbloqueado: !c.tpvBloqueo || !!tpv[id],
        estrellasRecibidas: recibidas[id] || []
      };
    });

    // Puntos ganados por los alumnos activos desde un dia (sin descontar canjes ni restas)
    const ganadosDesde = (v) => {
      const desde = v ? toDay(v, ctx) : '';
      let total = 0;
      led.forEach((m) => {
        if (TIPOS_GANADOS.indexOf(m.tipo) < 0 || !idsAct[str(m.alumnoId)] || Number(m.delta) <= 0) return;
        if (desde && toDay(m.fecha, ctx) < desde) return;
        total += Number(m.delta);
      });
      return total;
    };

    // Reto de clase
    const progreso = ganadosDesde(c.retoDesde);
    const reto = c.retoMeta > 0
      ? { nombre: c.retoNombre, meta: c.retoMeta, progreso, premio: c.retoPremio, icono: c.retoIcono, logrado: progreso >= c.retoMeta }
      : null;

    // Mascota de clase (ver cabecera: restas, peligro, necesidad, nombre y diario)
    let mascota = null;
    if (c.mascotaActiva) {
      const pm = progresoMascota(led, items, ctx, c, idsAct);
      const th = c.mascotaEtapas;
      const etapa = pm.etapa;
      const maxima = etapa >= th.length - 1;
      const nec = necesidadMascota(led, items, ctx, c);
      const diario = pm.diario.slice(-8).reverse();
      if (vot.estado === 'cerrada' && vot.ganador) diario.unshift({ dia: toDay(vot.fecha, ctx), tipo: 'nombre', nombre: vot.ganador });
      mascota = {
        nombre: vot.ganador || c.mascotaNombre, puntos: pm.progreso, etapa, etapas: th.length, premio: c.mascotaPremio,
        desde: th[etapa], hasta: maxima ? null : th[etapa + 1], falta: maxima ? 0 : th[etapa + 1] - pm.progreso, maxima,
        peligro: pm.deuda > 0, deuda: pm.deuda,
        necesidad: nec.accion, atendida: nec.atendida,
        votacion: { estado: vot.estado, opciones: vot.opciones, votos: vot.votos, votantes: vot.votantes, total: vot.total },
        diario
      };
    }
    const estrellas = estrellasPendientes(led).map((m) => {
      const para = alumnosAct.find((a) => str(a.id) === str(m.alumnoId));
      const de = alumnosAct.find((a) => str(a.id) === str(m.ref));
      return { id: str(m.id), para: str(m.alumnoId), paraNombre: para ? str(para.nombre) : '', de: str(m.ref), deNombre: de ? str(de.nombre) : '', frase: str(m.nota) };
    }).filter((e) => e.paraNombre);
    const ay = ayudanteDe(led, alumnosAct);

    // Cosmeticos que se pueden conseguir (para mostrarlos bloqueados en el editor)
    const cosmeticos = [];
    activeItems.filter((i) => i.tipo === 'insignia').forEach((i) => {
      (unlocks[str(i.id)] || []).forEach((k) => {
        if (!cosmeticos.some((x) => x.clave === k)) {
          cosmeticos.push({ clave: k, tipo: k.indexOf('img:') === 0 ? 'avatar' : 'color', insignia: str(i.id), insigniaNombre: str(i.nombre) });
        }
      });
    });

    const view = (i) => ({ id: str(i.id), nombre: str(i.nombre), icono: str(i.icono), descripcion: str(i.descripcion) });
    return {
      alumnos,
      reglas: activeItems.filter((i) => i.tipo === 'regla').map((i) => Object.assign(view(i), { puntos: Number(i.puntos) || 0 })),
      cuidados: activeItems.filter(esCuidado).map((i) => Object.assign(view(i), { coste: Number(i.puntos) || 0, accion: accionDe(i.efecto) })),
      premios: activeItems.filter((i) => i.tipo === 'premio' && !esCuidado(i)).map((i) => Object.assign(view(i), { coste: Number(i.puntos) || 0, efecto: str(i.efecto) || 'ninguno' })),
      insignias: activeItems.filter((i) => i.tipo === 'insignia').map((i) => Object.assign(view(i), { desbloquea: unlocks[str(i.id)] || [] })),
      reto,
      mascota,
      estrellas,
      ayudante: ay ? { id: str(ay.id), nombre: str(ay.nombre) } : null,
      config: {
        rachaHito: c.rachaHito, rachaBonus: c.rachaBonus, ruletaBonus: c.ruletaBonus, avatares: c.avatares, colores: c.colores,
        diasClase: c.diasClase, insigniaDias: c.insigniaDias, cosmeticos, estrellaPuntos: c.estrellaPuntos, ayudantePuntos: c.ayudantePuntos, tpvBloqueo: c.tpvBloqueo
      },
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
    const hoy = ctx.fmtDay(ctx.now);
    const concedidas = {}; // insignias ya anadidas en ESTE lote (evita duplicados en el carrito)

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

    // Acciones de clase: sirven sueltas y tambien dentro de un lote (ven lo anadido antes en el mismo lote)
    const cur = () => led.concat(rows);
    const doRol = (alumnoId, accion) => {
      const ay = ayudanteDe(cur(), (t.alumnos || []).filter(isActivo));
      if (!ay) throw new Error('No hay alumnos');
      if (str(alumnoId) !== str(ay.id)) throw new Error('El ayudante ha cambiado: actualiza la pantalla');
      const confirmar = accion === 'confirmar';
      if (!confirmar && accion !== 'saltar') throw new Error('Acción de rol no válida');
      add(str(ay.id), 'rol', confirmar ? c.ayudantePuntos : 0, 'Ayudante de turno', 'profesor', confirmar ? 'confirmado' : 'saltado');
    };
    const doEstrella = (estrellaId, ok) => {
      const pend = estrellasPendientes(cur()).filter((m) => str(m.id) === str(estrellaId))[0];
      if (!pend) throw new Error('Esa estrella ya está resuelta');
      add(str(pend.alumnoId), 'estrella_res', ok ? c.estrellaPuntos : 0, ok ? str(pend.nota) : 'Rechazada', 'profesor', str(pend.id));
    };
    const doMascota = (accion) => {
      if (accion === 'reiniciar') {
        add('', 'mascota', 0, 'Reinicio de la mascota', 'profesor', 'reset');
      } else if (accion === 'cerrar_nombre') {
        const vot = votacionNombre(cur(), items, (t.alumnos || []).filter(isActivo), c);
        if (vot.estado !== 'abierta') throw new Error('No hay una votación abierta');
        add('', 'mascota', 0, 'Cierre de la votación', 'profesor', 'cerrar-nombre');
      } else {
        throw new Error('Acción de mascota no válida');
      }
    };

    if (p.action === 'batch') {
      if (!Array.isArray(p.movimientos) || !p.movimientos.length) throw new Error('Carrito vacío');
      p.movimientos.forEach((m) => {
        if (m.tipo === 'rol') return doRol(m.alumnoId, m.accion);            // ayudante de turno: confirmar | saltar
        if (m.tipo === 'estrella_res') return doEstrella(m.ref, m.ok === true); // estrella amable: aprobar | rechazar
        if (m.tipo === 'mascota') return doMascota(m.ref);                   // reiniciar | cerrar_nombre
        const id = alumnoValido(m.alumnoId);
        const nota = str(m.nota).slice(0, 80);
        if (m.tipo === 'reset') {
          add(id, 'reset', 0 - (bal[id] || 0), nota, 'profesor'); // lleva el saldo a 0 en ese instante
        } else if (m.tipo === 'insignia') {
          const ins = items.filter((i) => i.tipo === 'insignia' && isActivo(i) && str(i.id) === str(m.ref))[0];
          if (!ins) throw new Error('Insignia no válida');
          if (concedidas[id + '|' + str(ins.id)]) return; // repetida en el mismo lote: se ignora
          concedidas[id + '|' + str(ins.id)] = true;   // si ya la tenia, se concede otra vez y se reinicia el plazo
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
    } else if (p.action === 'tpv_abrir' || p.action === 'tpv_cerrar') {
      // Control remoto del profesor: sin desbloqueo no se puede canjear. Cerrar tambien lo usa el iPad al pulsar Cambiar.
      const id = alumnoValido(p.alumnoId);
      const abrir = p.action === 'tpv_abrir';
      if (!!tpvAbiertos(cur())[id] !== abrir) add(id, 'tpv', 0, abrir ? 'Canje desbloqueado' : 'Canje bloqueado', abrir ? 'profesor' : 'tpv', abrir ? 'abrir' : 'cerrar');
    } else if (p.action === 'canje') {
      const id = alumnoValido(p.alumnoId);
      if (c.tpvBloqueo && !tpvAbiertos(cur())[id]) throw new Error('Pide a tu profe que te desbloquee');
      const premio = items.filter((i) => (i.tipo === 'premio' || i.tipo === 'cuidado') && isActivo(i) && str(i.id) === str(p.premioId))[0];
      if (!premio) throw new Error('Premio no válido');
      if (premio.tipo === 'cuidado' && !accionDe(premio.efecto)) throw new Error('Cuidado sin acción válida');
      const coste = Number(premio.puntos) || 0;
      if ((bal[id] || 0) < coste) throw new Error('Saldo insuficiente');
      const efecto = str(premio.efecto);
      let nota = str(premio.nombre);
      if (accionDe(efecto)) {
        if (!c.mascotaActiva) throw new Error('La mascota no está activa');
        const nec = necesidadMascota(led, items, ctx, c);
        if (nec.atendida) throw new Error('La mascota ya está atendida en esta clase');
        if (nec.accion !== accionDe(efecto)) throw new Error('La mascota no necesita esto ahora');
      } else if (efecto === 'nombre') {
        const vot = votacionNombre(led, items, (t.alumnos || []).filter(isActivo), c);
        const opcion = str(p.opcion).trim();
        if (vot.estado !== 'abierta') throw new Error('La votación ya ha terminado');
        if (vot.porAlumno[id]) throw new Error('Ya has elegido un nombre');
        if (vot.opciones.indexOf(opcion) < 0) throw new Error('Nombre no válido');
        nota = opcion;
      } else if (efecto === 'estrella') {
        throw new Error('La estrella amable se envía desde su propia pantalla');
      }
      add(id, 'canje', -coste, nota, 'tpv', str(premio.id));
    } else if (p.action === 'estrella') {
      const id = alumnoValido(p.alumnoId);
      const para = alumnoValido(p.paraId);
      if (para === id) throw new Error('Elige a un compañero');
      if (c.tpvBloqueo && !tpvAbiertos(cur())[id]) throw new Error('Pide a tu profe que te desbloquee');
      const premio = items.filter((i) => i.tipo === 'premio' && isActivo(i) && str(i.efecto) === 'estrella')[0];
      if (!premio) throw new Error('La estrella amable no está disponible');
      const frase = str(p.frase).trim();
      if (splitOpciones(premio.descripcion).indexOf(frase) < 0) throw new Error('Frase no válida');
      if (led.some((m) => m.tipo === 'estrella' && str(m.ref) === id && toDay(m.fecha, ctx) === hoy)) throw new Error('Hoy ya has enviado tu estrella');
      if (estrellaBloqueados(cur(), ctx, id, dayNum(hoy)).indexOf(para) >= 0) throw new Error('Ya le enviaste una estrella hace menos de 2 semanas');
      add(para, 'estrella', 0, frase, 'tpv', id);
    } else if (p.action === 'estrella_resolver') {
      doEstrella(p.estrellaId, p.ok === true);
    } else if (p.action === 'rol') {
      doRol(p.alumnoId, p.accion);
    } else if (p.action === 'mascota') {
      doMascota(p.accion);
    } else if (p.action === 'perfil') {
      const id = alumnoValido(p.alumnoId);
      const avatar = str(p.avatar);
      const color = str(p.color);
      const mias = cosmeticosDe(insigniaTables(led, ctx, c.insigniaDias).ever[id], unlockMap(items));
      if (c.avatares.indexOf(avatar) < 0 && mias.indexOf(avatar) < 0) throw new Error('Avatar no válido o bloqueado');
      if (c.colores.indexOf(color) < 0 && mias.indexOf(color) < 0) throw new Error('Color no válido o bloqueado');
      if (!(pendientesMap(items, led)[id] > 0)) throw new Error('No tienes una personalización disponible');
      add(id, 'perfil', 0, 'Personalización', 'tpv', avatar + '|' + color);
      patches.push({ alumnoId: id, avatar, color });
    } else {
      throw new Error('Acción desconocida');
    }

    // Bonus automatico por racha (solo tras movimientos del profesor)
    if (p.action === 'batch' && c.rachaBonus > 0) {
      const led2 = led.concat(rows);
      const dt = dayTables(led2, ctx, c.diasClase);
      const tocados = {};
      rows.forEach((r) => {
        if (TIPOS_RACHA.indexOf(r.tipo) >= 0) tocados[r.alumnoId] = true;
      });
      Object.keys(tocados).forEach((id) => {
        const s = streakOf(dt, id, hoy);
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

  return { computeState, applyAction, COLORES, AVATARES, COSMETICOS, DEFAULTS };
})();
