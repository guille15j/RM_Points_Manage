/**
 * profesor.js - Panel del profesor (iPhone / Safari movil)
 *
 * Interfaz de trabajo: lista compacta de alumnos, barra de acciones en la zona del pulgar
 * (motivos frecuentes editables desde la hoja + valores rapidos), ruleta de refuerzo,
 * insignias y carrito de movimientos.
 *
 * Flujo:
 *  1. Toca uno o varios alumnos.
 *  2. Pulsa un motivo frecuente, una accion rapida (+10, +5, -5, -10, A cero) o escribe un valor.
 *     La ruleta y las insignias tambien anaden al carrito: todo se envia junto.
 *     Se anade al CARRITO (buffer local en localStorage). Nada va aun al servidor.
 *  3. Abre el carrito, revisa / edita / elimina movimientos y pulsa ENVIAR.
 *  4. Envio transaccional:
 *       - SNAPSHOT del estado local (alumnos + carrito).
 *       - Actualizacion optimista (puntos y carrito vacio al instante).
 *       - Si el servidor falla: ROLLBACK al snapshot y aviso para reintentar.
 *       - El batchId es idempotente: reintentar nunca duplica movimientos en el ledger.
 *
 * Estructura: 1. Estado  2. Calculo  3. Componentes (con sus mapas)  4. Render
 *             5. Acciones  6. Envio  7. Sincronizacion  8. Eventos
 * Convencion de renderizado condicional: ver cabecera de ui.js.
 */
(function () {
  'use strict';
  const { CFG, uid, clone, esc, store, isDemo, apiGet, apiPost, resetDemo, pickState } = window.TP;
  const { resolve, safeIcon, Icon, renderStreak, renderNote, btnClass, IconButton, Segmented, renderEmpty, renderStatus, toast, openSheet, closeSheet } = window.UI;

  /* ======================= 1. ESTADO ======================= */
  const KEY = 'tp_prof_v3';
  const saved = store.get(KEY, {});
  const S = {
    alumnos: saved.alumnos || [],   // [{id,nombre,avatar,color,puntos,racha,insignias,pendientes}] confirmado por el servidor
    reglas: saved.reglas || [],     // motivos frecuentes (pestana ReglasYPremios)
    insignias: saved.insignias || [],
    config: saved.config || { ruletaBonus: [] },
    cart: saved.cart || [],         // [{id,alumnoId,tipo:'delta'|'reset'|'ruleta'|'insignia',delta,nota,ref}]
    pending: saved.pending || null, // {id,sig}: batchId del ultimo intento, para reintentos idempotentes
    status: isDemo() ? 'demo' : 'off',
    banner: null                    // mensaje de error visible, o null
  };
  const selected = new Set();       // seleccion efimera
  let sending = false;
  let edit = null;                  // movimiento en edicion: {id, sign, value}
  let wheel = { phase: 'idle', pool: [], name: '', winner: null, bonus: 0 }; // ruleta
  let wheelTimer = null;

  const $ = (s) => document.querySelector(s);
  const persist = () => store.set(KEY, { alumnos: S.alumnos, reglas: S.reglas, insignias: S.insignias, config: S.config, cart: S.cart, pending: S.pending });
  const applyServer = (res) => { ['alumnos', 'reglas', 'insignias', 'config'].forEach((k) => { if (res[k]) S[k] = res[k]; }); };
  const findInsignia = (id) => S.insignias.find((i) => i.id === id);
  const randInt = (n) => { const b = new Uint32Array(1); crypto.getRandomValues(b); return b[0] % n; };
  const byName = (a, b) => a.nombre.localeCompare(b.nombre, 'es');
  const findAlumno = (id) => S.alumnos.find((a) => a.id === id);
  const findMov = (id) => S.cart.find((m) => m.id === id);
  const fmt = (n) => (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(n); // signo menos tipografico
  const haptic = () => { try { navigator.vibrate && navigator.vibrate(10); } catch (e) {} };

  /* ======================= 2. CALCULO ======================= */
  /** Saldo proyectado de cada alumno = confirmado + carrito. */
  function simulate() {
    const m = {};
    S.alumnos.forEach((a) => (m[a.id] = { base: a.puntos, now: a.puntos, d: 0 }));
    S.cart.forEach((c) => {
      const r = m[c.alumnoId];
      if (r) r.now = c.tipo === 'reset' ? 0 : r.now + (c.delta || 0);
    });
    Object.keys(m).forEach((id) => (m[id].d = m[id].now - m[id].base));
    return m;
  }

  /* ======================= 3. COMPONENTES ======================= */

  /* ---- Insignia de cambio pendiente en la fila del alumno ---- */
  const chip = (tone, text) => `<span class="px-2 py-0.5 rounded-full text-sm font-semibold tabular-nums ${tone}">${text}</span>`;
  const PENDING_BADGES = {
    none: () => '',
    up: ({ d }) => chip('bg-success-soft text-success', fmt(d)),
    down: ({ d }) => chip('bg-danger-soft text-danger', fmt(d)),
    zero: () => chip('bg-surface-alt text-ink-soft', 'a 0')
  };
  function getPendingKind({ now, d }) {
    if (now === 0 && d !== 0) return 'zero';
    return d > 0 ? 'up' : d < 0 ? 'down' : 'none';
  }

  /* ---- Fila de alumno: seleccionada o en reposo ---- */
  const makeStudentRow = (icon, tone, pressed) => ({ a, sim }) => `
    <li>
      <button type="button" data-al="${esc(a.id)}" aria-pressed="${pressed}" class="pressable flex items-center w-full gap-3 px-3 text-left min-h-[3.25rem] ${tone}">
        ${Icon(icon, 'text-primary')}
        <span class="flex-1 min-w-0 font-medium truncate">${esc(a.nombre)}</span>
        ${renderStreak(a)}
        ${resolve(PENDING_BADGES, getPendingKind(sim), 'none')(sim)}
        <span class="w-14 text-lg font-semibold text-right tabular-nums">${sim.now}</span>
      </button>
    </li>`;
  const STUDENT_ROWS = {
    selected: makeStudentRow('check_box', 'bg-primary-soft', 'true'),
    idle: makeStudentRow('check_box_outline_blank', 'bg-surface', 'false')
  };

  function StudentList({ alumnos, sim }) {
    const rows = [...alumnos]
      .sort(byName)
      .map((a) => resolve(STUDENT_ROWS, selected.has(a.id) ? 'selected' : 'idle', 'idle')({ a, sim: sim[a.id] }))
      .join('');
    return `<ul class="rounded-ui border border-line bg-surface divide-y divide-line overflow-hidden">${rows}</ul>`;
  }
  const LIST_VIEWS = { lista: StudentList, vacio: () => renderEmpty('sinAlumnos') };

  /* ---- Texto de seleccion ---- */
  const SELECTION_LABELS = {
    none: () => 'Toca a un alumno para seleccionarlo',
    some: (n) => `${n} seleccionado${n > 1 ? 's' : ''}`
  };

  /* ---- Aviso de error ---- */
  const BANNERS = {
    none: () => '',
    error: ({ msg }) => `
      <div role="alert" class="flex items-start gap-2 p-3 mb-3 text-sm rounded-ui border border-danger/30 bg-danger-soft text-danger">
        ${Icon('error', 'text-xl')}
        <p class="flex-1 pt-0.5">${esc(msg)}</p>
        ${IconButton({ icon: 'close', label: 'Cerrar aviso', attrs: 'data-banner-close', size: 'sm', cls: '-m-2 text-danger' })}
      </div>`
  };

  /* ---- Filas del carrito: ganancia, perdida, puesta a cero, ruleta o insignia ---- */
  const EDIT_BUTTONS = {
    yes: (mov) => IconButton({ icon: 'edit', label: 'Editar movimiento', attrs: `data-edit="${esc(mov.id)}"` }),
    no: () => ''
  };
  // Segunda linea de la fila: saldo antes -> despues, o el nombre de la insignia
  const CART_DETAILS = {
    saldo: ({ before, after, mov }) => `<p class="flex items-center gap-1 text-sm tabular-nums text-ink-soft">${before}${Icon('arrow_forward', 'text-base')}<span class="font-semibold text-ink">${after}</span>${renderNote(mov.nota ? ' · ' + mov.nota : '', 'truncate')}</p>`,
    insignia: ({ mov }) => `<p class="text-sm text-ink-soft truncate">${esc(mov.nota || 'Insignia')}</p>`
  };
  const makeCartRow = ({ tone, editable, amount, detail }) => (props) => `
    <li class="flex items-center pl-3 pr-1 min-h-[3.5rem]">
      <div class="flex-1 min-w-0 py-2">
        <p class="font-medium truncate">${esc(props.nombre)}</p>
        ${resolve(CART_DETAILS, detail, 'saldo')(props)}
      </div>
      <span class="min-w-[3.25rem] pr-1 font-semibold text-right tabular-nums ${tone}">${amount(props.mov)}</span>
      ${resolve(EDIT_BUTTONS, editable, 'no')(props.mov)}
      ${IconButton({ icon: 'delete', label: 'Eliminar movimiento', attrs: `data-del="${esc(props.mov.id)}"` })}
    </li>`;
  const CART_ROWS = {
    gain: makeCartRow({ tone: 'text-success', editable: 'yes', amount: (m) => fmt(m.delta), detail: 'saldo' }),
    loss: makeCartRow({ tone: 'text-danger', editable: 'yes', amount: (m) => fmt(m.delta), detail: 'saldo' }),
    reset: makeCartRow({ tone: 'text-ink-soft', editable: 'no', amount: () => 'A 0', detail: 'saldo' }),
    ruleta: makeCartRow({ tone: 'text-success', editable: 'no', amount: (m) => fmt(m.delta), detail: 'saldo' }),
    insignia: makeCartRow({ tone: 'text-primary', editable: 'no', amount: () => Icon('military_tech'), detail: 'insignia' })
  };
  const MOVEMENT_KINDS = { reset: 'reset', ruleta: 'ruleta', insignia: 'insignia' };
  const getMovementKind = (m) => MOVEMENT_KINDS[m.tipo] || (m.delta >= 0 ? 'gain' : 'loss');

  function CartList({ rows }) {
    return `<ul class="rounded-ui border border-line bg-surface divide-y divide-line overflow-hidden">${rows}</ul>`;
  }
  const CART_LISTS = { lleno: CartList, vacio: () => renderEmpty('carritoVacio') };

  /* ---- Boton Enviar: vacio, enviando o listo ---- */
  const SEND_STATES = {
    empty: () => ({ disabled: true, html: `${Icon('send')}<span>Enviar</span>` }),
    sending: () => ({ disabled: true, html: `${Icon('sync')}<span>Enviando...</span>` }),
    ready: (n) => ({ disabled: false, html: `${Icon('send')}<span>Enviar ${n} ${n === 1 ? 'movimiento' : 'movimientos'}</span>` })
  };
  const getSendState = () => (sending ? 'sending' : S.cart.length ? 'ready' : 'empty');

  /* ---- Herramientas del modo de prueba ---- */
  const DEMO_TOOLS = {
    demo: () => `
      <div class="mt-3 pt-3 space-y-2 text-sm border-t border-line text-ink-soft">
        <label class="flex items-center gap-3 min-h-[2.75rem]">
          <input id="demo-fail" type="checkbox" class="w-5 h-5" ${store.get('demo_fail', false) ? 'checked' : ''}>
          <span>Simular fallo de red (probar el rollback)</span>
        </label>
        <button type="button" data-demo-reset class="${btnClass('outline', 'w-full')}">${Icon('restart_alt')}<span>Restablecer datos de prueba</span></button>
      </div>`,
    prod: () => ''
  };

  /* ---- Hoja de edicion: segun el tipo de movimiento ---- */
  const SIGN_OPTIONS = [
    { key: 'minus', label: 'Resta', icon: 'remove' },
    { key: 'plus', label: 'Suma', icon: 'add' }
  ];
  const EditHeader = (nombre) => `<div><h2 class="font-semibold">${esc(nombre)}</h2><p class="text-sm text-ink-soft">Editar movimiento</p></div>`;

  function EditDelta({ nombre, state }) {
    return `
      ${EditHeader(nombre)}
      ${Segmented({ options: SIGN_OPTIONS, active: state.sign > 0 ? 'plus' : 'minus', attr: 'data-sign', fill: true })}
      <input id="edit-value" type="number" inputmode="numeric" pattern="[0-9]*" min="1" value="${esc(state.value)}" aria-label="Cantidad"
             class="w-full h-tap px-3 text-xl font-semibold text-center rounded-ui border border-line bg-page outline-none focus:border-primary">
      <div class="flex gap-2">
        <button type="button" data-remove class="${btnClass('danger')}">${Icon('delete')}<span>Eliminar</span></button>
        <button type="button" data-save class="${btnClass('primary', 'flex-1')}">${Icon('check')}<span>Guardar</span></button>
      </div>`;
  }
  function EditReset({ nombre }) {
    return `
      ${EditHeader(nombre)}
      <p class="flex items-start gap-2 p-3 text-sm rounded-ui bg-surface-alt text-ink-soft">${Icon('info', 'text-xl')}<span>Este movimiento pone el saldo a 0. No tiene cantidad que editar.</span></p>
      <div class="flex gap-2">
        <button type="button" data-remove class="${btnClass('danger', 'flex-1')}">${Icon('delete')}<span>Eliminar</span></button>
        <button type="button" data-close="sheet-edit" class="${btnClass('outline', 'flex-1')}">${Icon('close')}<span>Cerrar</span></button>
      </div>`;
  }
  function EditFixed({ nombre }) {
    return `
      ${EditHeader(nombre)}
      <p class="flex items-start gap-2 p-3 text-sm rounded-ui bg-surface-alt text-ink-soft">${Icon('info', 'text-xl')}<span>Este movimiento no se puede editar. Puedes eliminarlo y crear otro.</span></p>
      <div class="flex gap-2">
        <button type="button" data-remove class="${btnClass('danger', 'flex-1')}">${Icon('delete')}<span>Eliminar</span></button>
        <button type="button" data-close="sheet-edit" class="${btnClass('outline', 'flex-1')}">${Icon('close')}<span>Cerrar</span></button>
      </div>`;
  }
  const EDIT_FIELDS = { gain: EditDelta, loss: EditDelta, reset: EditReset, ruleta: EditFixed, insignia: EditFixed };

  /* ---- Motivos frecuentes (botones de un toque; vienen de la hoja ReglasYPremios) ---- */
  const MOTIVE_TONES = { suma: 'text-success', resta: 'text-danger' };
  const getMotiveKind = (r) => (r.puntos >= 0 ? 'suma' : 'resta');
  const motiveChip = (r) => `
    <button type="button" data-motivo="${esc(r.id)}" class="pressable inline-flex items-center gap-1.5 shrink-0 h-11 px-3 rounded-ui border border-line bg-surface text-sm font-semibold whitespace-nowrap">
      ${Icon(safeIcon(r.icono, 'rule'), 'text-xl text-ink-soft')}<span>${esc(r.nombre)}</span><span class="tabular-nums ${resolve(MOTIVE_TONES, getMotiveKind(r), 'suma')}">${fmt(r.puntos)}</span>
    </button>`;
  const MOTIVES = {
    lista: (reglas) => reglas.map(motiveChip).join(''),
    vacio: () => ''
  };

  /* ---- Hoja de insignias ---- */
  const infoBox = (text) => `<p class="flex items-start gap-2 p-3 text-sm rounded-ui bg-surface-alt text-ink-soft">${Icon('info', 'text-xl')}<span>${text}</span></p>`;
  const BADGE_SHEET = {
    lista: (n) => `
      <p class="mb-3 text-sm text-ink-soft">Se concederá a ${n} ${n === 1 ? 'alumno seleccionado' : 'alumnos seleccionados'}. Las insignias son permanentes.</p>
      <ul class="rounded-ui border border-line bg-surface divide-y divide-line overflow-hidden">
        ${S.insignias.map((i) => `
          <li><button type="button" data-ins="${esc(i.id)}" class="pressable flex items-center w-full gap-3 px-3 py-2 text-left min-h-[3.5rem] bg-surface">
            ${Icon(safeIcon(i.icono, 'military_tech'), 'text-primary')}
            <span class="flex-1 min-w-0"><span class="block font-medium truncate">${esc(i.nombre)}</span>${renderNote(i.descripcion, 'text-sm text-ink-soft')}</span>
            ${Icon('add', 'text-ink-soft')}
          </button></li>`).join('')}
      </ul>`,
    sinSeleccion: () => infoBox('Cierra esta hoja, toca a los alumnos que la merecen y vuelve a abrirla.'),
    vacio: () => infoBox('No hay insignias en la pestaña ReglasYPremios.')
  };
  const getBadgeSheetKind = () => (!S.insignias.length ? 'vacio' : selected.size ? 'lista' : 'sinSeleccion');

  /* ---- Ruleta: fases ---- */
  const wheelBonuses = () => (S.config.ruletaBonus && S.config.ruletaBonus.length ? S.config.ruletaBonus : [10]);
  const wheelPool = () => (selected.size ? S.alumnos.filter((a) => selected.has(a.id)) : S.alumnos);
  const WHEEL_PHASES = {
    idle: () => {
      const n = wheelPool().length;
      return `
      <div class="space-y-3 text-center">
        <p class="text-sm text-ink-soft">Participan ${n} ${n === 1 ? 'alumno' : 'alumnos'} (${selected.size ? 'los seleccionados' : 'toda la clase'}). Bonus posibles: ${wheelBonuses().map((b) => '+' + b).join(', ')}.</p>
        <div class="flex items-center justify-center h-24 rounded-ui bg-surface-alt text-ink-soft">${Icon('casino', 'text-5xl')}</div>
        <button type="button" data-spin class="${btnClass('primary', 'w-full')}">${Icon('casino')}<span>Girar</span></button>
      </div>`;
    },
    spinning: () => `
      <div class="space-y-3 text-center">
        <p class="text-sm text-ink-soft">Girando...</p>
        <div class="flex items-center justify-center h-24 px-3 rounded-ui bg-surface-alt text-2xl font-semibold truncate">${esc(wheel.name)}</div>
        <button type="button" disabled class="${btnClass('primary', 'w-full')}">${Icon('sync')}<span>Girando</span></button>
      </div>`,
    result: () => `
      <div class="space-y-3 text-center">
        <p class="text-sm text-ink-soft">Ha tocado a</p>
        <div class="flex flex-col items-center justify-center gap-1 h-28 px-3 rounded-ui bg-success-soft text-success">
          <span class="max-w-full text-2xl font-bold truncate">${esc(wheel.winner ? wheel.winner.nombre : '')}</span>
          <span class="text-xl font-semibold tabular-nums">+${wheel.bonus} puntos</span>
        </div>
        <div class="flex gap-2">
          <button type="button" data-spin class="${btnClass('outline')}">${Icon('replay')}<span>Otra vez</span></button>
          <button type="button" data-wheel-add class="${btnClass('primary', 'flex-1')}">${Icon('add_shopping_cart')}<span>Añadir al carrito</span></button>
        </div>
      </div>`,
    sinAlumnos: () => renderEmpty('sinAlumnos')
  };
  const getWheelPhase = () => (S.alumnos.length ? wheel.phase : 'sinAlumnos');

  /* ======================= 4. RENDER ======================= */
  function renderList() {
    const key = S.alumnos.length ? 'lista' : 'vacio';
    $('#list').innerHTML = resolve(LIST_VIEWS, key, 'vacio')({ alumnos: S.alumnos, sim: simulate() });
    $('#selinfo').textContent = resolve(SELECTION_LABELS, selected.size ? 'some' : 'none', 'none')(selected.size);
  }

  function renderMotives() {
    const reglas = [...S.reglas].sort((a, b) => b.puntos - a.puntos);
    $('#motives').innerHTML = resolve(MOTIVES, reglas.length ? 'lista' : 'vacio', 'vacio')(reglas);
  }

  function renderCartCount() {
    const el = $('#cart-count');
    el.textContent = S.cart.length;
    el.classList.toggle('hidden', S.cart.length === 0);
  }

  function renderCart() {
    const run = {};
    S.alumnos.forEach((a) => (run[a.id] = a.puntos));
    const rows = S.cart
      .map((mov) => {
        const a = findAlumno(mov.alumnoId);
        const before = run[mov.alumnoId] != null ? run[mov.alumnoId] : 0;
        const after = mov.tipo === 'reset' ? 0 : before + mov.delta;
        run[mov.alumnoId] = after;
        return resolve(CART_ROWS, getMovementKind(mov), 'gain')({ mov, nombre: a ? a.nombre : 'Alumno desconocido', before, after });
      })
      .join('');
    $('#cart-list').innerHTML = resolve(CART_LISTS, S.cart.length ? 'lleno' : 'vacio', 'vacio')({ rows });

    const send = resolve(SEND_STATES, getSendState(), 'empty')(S.cart.length);
    $('#cart-send').innerHTML = send.html;
    $('#cart-send').disabled = send.disabled;
    $('#cart-clear').disabled = !S.cart.length || sending;
    $('#cart-demo').innerHTML = resolve(DEMO_TOOLS, isDemo() ? 'demo' : 'prod', 'prod')();
  }

  function renderBanner() {
    $('#banner').innerHTML = resolve(BANNERS, S.banner ? 'error' : 'none', 'none')({ msg: S.banner });
  }

  function renderEdit() {
    const mov = findMov(edit.id);
    const a = mov && findAlumno(mov.alumnoId);
    if (!mov) return;
    $('#edit-body').innerHTML = resolve(EDIT_FIELDS, getMovementKind(mov), 'gain')({ nombre: a ? a.nombre : 'Movimiento', state: edit });
  }

  function setStatus(kind) {
    S.status = kind;
    $('#status').innerHTML = renderStatus({ kind, showLabel: true });
  }

  function render() {
    renderList();
    renderMotives();
    renderCartCount();
    renderBanner();
    if ($('#sheet-cart').classList.contains('open')) renderCart();
  }

  /* ======================= 5. ACCIONES ======================= */
  function toggleStudent(id) {
    selected.has(id) ? selected.delete(id) : selected.add(id);
    haptic();
    renderList();
  }

  function addMov(m, ids) {
    if (sending) return false;
    const targets = ids || [...selected];
    if (!targets.length) {
      toast('Primero toca a uno o más alumnos', 'err');
      return false;
    }
    targets.forEach((id) => S.cart.push({ id: uid(), alumnoId: id, tipo: m.tipo, delta: m.tipo === 'reset' || m.tipo === 'insignia' ? 0 : m.delta, nota: m.nota || '', ref: m.ref || '' }));
    if (!ids) selected.clear();
    persist();
    render();
    haptic();
    return targets.length;
  }

  const ADD_MESSAGES = {
    reset: (m, n) => `A cero añadido (${n})`,
    insignia: (m, n) => `Insignia añadida (${n})`,
    ruleta: (m, n) => `Ruleta: ${fmt(m.delta)} añadido al carrito`,
    delta: (m, n) => `${m.nota ? m.nota + ' ' : ''}${fmt(m.delta)} añadido al carrito (${n})`
  };
  function addWithToast(m, ids) {
    const n = addMov(m, ids);
    if (n) toast(resolve(ADD_MESSAGES, m.tipo, 'delta')(m, n), 'ok');
    return n;
  }

  function quick(value) {
    value === 'reset' ? addWithToast({ tipo: 'reset' }) : addWithToast({ tipo: 'delta', delta: parseInt(value, 10) });
  }

  function addMotivo(id) {
    const r = S.reglas.find((x) => x.id === id);
    if (r) addWithToast({ tipo: 'delta', delta: r.puntos, nota: r.nombre });
  }

  /* ---- Insignias ---- */
  function renderBadgeSheet() {
    const kind = getBadgeSheetKind();
    $('#badge-body').innerHTML = resolve(BADGE_SHEET, kind, 'vacio')(selected.size);
  }
  function openBadges() {
    renderBadgeSheet();
    openSheet('sheet-badge');
  }
  function addInsignia(id) {
    const ins = findInsignia(id);
    if (!ins) return;
    // Quien ya la tiene no se repite
    const ids = [...selected].filter((aid) => {
      const a = findAlumno(aid);
      return a && !(a.insignias || []).includes(id) && !S.cart.some((m) => m.tipo === 'insignia' && m.ref === id && m.alumnoId === aid);
    });
    closeSheet('sheet-badge');
    if (!ids.length) return toast('Los seleccionados ya tienen esa insignia', 'info');
    selected.clear();
    addWithToast({ tipo: 'insignia', nota: ins.nombre, ref: id }, ids);
  }

  /* ---- Ruleta ---- */
  function renderWheel() {
    $('#wheel-body').innerHTML = resolve(WHEEL_PHASES, getWheelPhase(), 'idle')();
  }
  function openWheel() {
    clearInterval(wheelTimer);
    wheel = { phase: 'idle', name: '', winner: null, bonus: 0 };
    renderWheel();
    openSheet('sheet-wheel');
  }
  function spinWheel() {
    const pool = wheelPool();
    if (!pool.length || wheel.phase === 'spinning') return;
    const winner = pool[randInt(pool.length)];
    const bonuses = wheelBonuses();
    const bonus = bonuses[randInt(bonuses.length)];
    wheel = { phase: 'spinning', name: pool[randInt(pool.length)].nombre, winner, bonus };
    renderWheel();
    let ticks = 0;
    clearInterval(wheelTimer);
    wheelTimer = setInterval(() => {
      ticks++;
      if (ticks >= 22) {
        clearInterval(wheelTimer);
        wheel.phase = 'result';
      } else {
        wheel.name = pool[randInt(pool.length)].nombre;
      }
      renderWheel();
    }, 100);
  }
  function wheelToCart() {
    if (wheel.phase !== 'result' || !wheel.winner) return;
    const w = wheel.winner;
    const b = wheel.bonus;
    closeSheet('sheet-wheel');
    wheel.phase = 'idle';
    addWithToast({ tipo: 'ruleta', delta: b, nota: 'Ruleta' }, [w.id]);
  }

  function customAmount(sign) {
    const inp = $('#custom');
    const v = parseInt(inp.value, 10);
    if (!v || v < 1) return toast('Escribe un número mayor que 0', 'err');
    if (v > 10000) return toast('Valor demasiado grande', 'err');
    if (!selected.size) return toast('Primero toca a uno o más alumnos', 'err');
    addWithToast({ tipo: 'delta', delta: sign * v });
    inp.value = '';
    inp.blur();
  }

  function openEdit(id) {
    const mov = findMov(id);
    if (!mov) return;
    edit = { id, sign: mov.delta < 0 ? -1 : 1, value: Math.abs(mov.delta) };
    renderEdit();
    openSheet('sheet-edit');
  }

  function setEditSign(key) {
    const input = $('#edit-value');
    if (input) edit.value = input.value; // conserva lo escrito al cambiar de signo
    edit.sign = key === 'plus' ? 1 : -1;
    renderEdit();
  }

  function saveEdit() {
    const mov = findMov(edit.id);
    const v = parseInt($('#edit-value').value, 10);
    if (!mov || !v || v < 1 || v > 10000) return toast('Valor no válido', 'err');
    mov.delta = edit.sign * v;
    persist();
    closeSheet('sheet-edit');
    render();
  }

  function deleteMov(id) {
    if (sending) return;
    S.cart = S.cart.filter((m) => m.id !== id);
    persist();
    closeSheet('sheet-edit');
    render();
  }

  function clearCart() {
    if (!S.cart.length || sending) return;
    if (confirm('¿Vaciar todo el carrito?')) {
      S.cart = [];
      persist();
      render();
    }
  }

  async function resetDemoData() {
    resetDemo();
    S.cart = [];
    S.pending = null;
    selected.clear();
    persist();
    await refresh(true);
    render();
  }

  /* ======================= 6. ENVIO TRANSACCIONAL ======================= */
  async function sendCart() {
    if (sending || !S.cart.length) return;
    sending = true;
    S.banner = null;

    // 1) SNAPSHOT del estado anterior (para el rollback)
    const snapshot = clone({ alumnos: S.alumnos, cart: S.cart });

    // 2) batchId idempotente: si reintentamos el MISMO carrito, reutilizamos el id
    const sig = JSON.stringify(S.cart.map((c) => [c.alumnoId, c.tipo, c.delta, c.ref || '']));
    const batchId = S.pending && S.pending.sig === sig ? S.pending.id : uid();
    S.pending = { id: batchId, sig };

    const movimientos = S.cart.map((c) => ({ alumnoId: c.alumnoId, tipo: c.tipo, delta: c.delta, nota: c.nota || '', ref: c.ref || '' }));

    // 3) Actualizacion OPTIMISTA: aplicamos saldos y vaciamos el carrito al instante
    const sim = simulate();
    S.alumnos.forEach((a) => (a.puntos = sim[a.id].now));
    S.cart.forEach((c) => {
      const a = findAlumno(c.alumnoId);
      if (a && c.tipo === 'insignia' && !(a.insignias || []).includes(c.ref)) a.insignias = (a.insignias || []).concat(c.ref);
    });
    S.cart = [];
    persist();
    closeSheet('sheet-cart');
    render();

    try {
      // 4) Envio al ledger (Google Apps Script)
      const res = await apiPost({ action: 'batch', batchId, movimientos });
      applyServer(res); // la verdad del servidor
      S.pending = null;
      persist();
      setStatus(isDemo() ? 'demo' : 'ok');
      const n = movimientos.length;
      const bonos = res.bonificaciones || [];
      const extra = bonos.length ? '. Racha: ' + bonos.map((b) => `${(findAlumno(b.alumnoId) || { nombre: '' }).nombre} +${b.bonus}`).join(', ') : '';
      toast(`${n} ${n === 1 ? 'movimiento enviado' : 'movimientos enviados'}${extra}`, 'ok');
    } catch (err) {
      // 5) ROLLBACK: restauramos estado local e interfaz al snapshot anterior
      console.error('Envio fallido:', err);
      S.alumnos = snapshot.alumnos;
      S.cart = snapshot.cart;
      persist(); // S.pending se conserva para reintentar de forma idempotente
      setStatus('off');
      S.banner = `No se pudo enviar (${err.message}). El carrito se ha restaurado: revisa la conexión y vuelve a pulsar Enviar.`;
    } finally {
      sending = false;
      render();
    }
  }

  /* ======================= 7. SINCRONIZACION ======================= */
  async function refresh(manual) {
    if (sending) return;
    try {
      const r = await apiGet();
      const changed = JSON.stringify(pickState(r)) !== JSON.stringify(pickState(S));
      applyServer(r);
      persist();
      setStatus(isDemo() ? 'demo' : 'ok');
      if (changed) render();
      if (manual) toast('Actualizado', 'info');
    } catch (e) {
      console.error('No se pudo actualizar:', e);
      setStatus('off');
      if (manual) toast('Sin conexión: se muestran los últimos datos guardados', 'err');
    }
  }

  /* ======================= 8. EVENTOS ======================= */
  // Lista [selector, accion]. Se evalua en orden; la primera coincidencia gana.
  const CLICK_HANDLERS = [
    ['[data-del]', (el) => deleteMov(el.dataset.del)],
    ['[data-edit]', (el) => openEdit(el.dataset.edit)],
    ['[data-remove]', () => deleteMov(edit.id)],
    ['[data-save]', () => saveEdit()],
    ['[data-sign]', (el) => setEditSign(el.dataset.sign)],
    ['[data-close]', (el) => closeSheet(el.dataset.close)],
    ['[data-banner-close]', () => { S.banner = null; renderBanner(); }],
    ['[data-demo-reset]', () => resetDemoData()],
    ['[data-al]', (el) => toggleStudent(el.dataset.al)],
    ['[data-motivo]', (el) => addMotivo(el.dataset.motivo)],
    ['[data-ins]', (el) => addInsignia(el.dataset.ins)],
    ['[data-spin]', () => spinWheel()],
    ['[data-wheel-add]', () => wheelToCart()],
    ['#btn-wheel', () => openWheel()],
    ['#btn-badge', () => openBadges()],
    ['[data-q]', (el) => quick(el.dataset.q)],
    ['#custom-add', () => customAmount(1)],
    ['#custom-sub', () => customAmount(-1)],
    ['#sel-all', () => { S.alumnos.forEach((a) => selected.add(a.id)); renderList(); }],
    ['#sel-none', () => { selected.clear(); renderList(); }],
    ['#btn-refresh', () => refresh(true)],
    ['#btn-cart', () => { renderCart(); openSheet('sheet-cart'); }],
    ['#cart-send', () => sendCart()],
    ['#cart-clear', () => clearCart()]
  ];
  document.addEventListener('click', (e) => {
    for (const [selector, action] of CLICK_HANDLERS) {
      const el = e.target.closest(selector);
      if (el) return action(el);
    }
  });
  document.addEventListener('change', (e) => {
    if (e.target.id === 'demo-fail') store.set('demo_fail', e.target.checked);
  });

  // Refresco al volver a la pestana y cada cierto tiempo (nunca mientras se envia)
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(false); });
  setInterval(() => { if (!document.hidden && !sending) refresh(false); }, Math.max(CFG.POLL_MS || 15000, 20000));

  // Arranque: pinta lo guardado al instante y sincroniza en segundo plano
  setStatus(S.status);
  render();
  refresh(false);
})();
