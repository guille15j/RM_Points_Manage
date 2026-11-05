/**
 * profesor.js - Panel del profesor (iPhone / Safari movil)
 *
 * Interfaz de trabajo: lista compacta de alumnos, barra de acciones en la zona del pulgar
 * y carrito de movimientos.
 *
 * Flujo:
 *  1. Toca uno o varios alumnos.
 *  2. Pulsa una accion rapida (+10, +5, -5, -10, A cero) o escribe un valor propio.
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
  const { CFG, uid, clone, esc, store, isDemo, apiGet, apiPost, resetDemo } = window.TP;
  const { resolve, Icon, btnClass, IconButton, Segmented, renderEmpty, renderStatus, toast, openSheet, closeSheet } = window.UI;

  /* ======================= 1. ESTADO ======================= */
  const KEY = 'tp_prof_v2';
  const saved = store.get(KEY, {});
  const S = {
    alumnos: saved.alumnos || [],   // [{id,nombre,icono,puntos}]  puntos confirmados por el servidor
    cart: saved.cart || [],         // [{id,alumnoId,tipo:'delta'|'reset',delta,nota}]
    pending: saved.pending || null, // {id,sig}: batchId del ultimo intento, para reintentos idempotentes
    status: isDemo() ? 'demo' : 'off',
    banner: null                    // mensaje de error visible, o null
  };
  const selected = new Set();       // seleccion efimera
  let sending = false;
  let edit = null;                  // movimiento en edicion: {id, sign, value}

  const $ = (s) => document.querySelector(s);
  const persist = () => store.set(KEY, { alumnos: S.alumnos, cart: S.cart, pending: S.pending });
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
      if (r) r.now = c.tipo === 'reset' ? 0 : r.now + c.delta;
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

  /* ---- Filas del carrito: ganancia, perdida o puesta a cero ---- */
  const EDIT_BUTTONS = {
    yes: (mov) => IconButton({ icon: 'edit', label: 'Editar movimiento', attrs: `data-edit="${esc(mov.id)}"` }),
    no: () => ''
  };
  const makeCartRow = ({ tone, editable, amount }) => ({ mov, nombre, before, after }) => `
    <li class="flex items-center pl-3 pr-1 min-h-[3.5rem]">
      <div class="flex-1 min-w-0 py-2">
        <p class="font-medium truncate">${esc(nombre)}</p>
        <p class="flex items-center gap-1 text-sm tabular-nums text-ink-soft">${before}${Icon('arrow_forward', 'text-base')}<span class="font-semibold text-ink">${after}</span></p>
      </div>
      <span class="min-w-[3.25rem] pr-1 font-semibold text-right tabular-nums ${tone}">${amount(mov)}</span>
      ${resolve(EDIT_BUTTONS, editable, 'no')(mov)}
      ${IconButton({ icon: 'delete', label: 'Eliminar movimiento', attrs: `data-del="${esc(mov.id)}"` })}
    </li>`;
  const CART_ROWS = {
    gain: makeCartRow({ tone: 'text-success', editable: 'yes', amount: (m) => fmt(m.delta) }),
    loss: makeCartRow({ tone: 'text-danger', editable: 'yes', amount: (m) => fmt(m.delta) }),
    reset: makeCartRow({ tone: 'text-ink-soft', editable: 'no', amount: () => 'A 0' })
  };
  const getMovementKind = (m) => (m.tipo === 'reset' ? 'reset' : m.delta >= 0 ? 'gain' : 'loss');

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
  const EDIT_FIELDS = { gain: EditDelta, loss: EditDelta, reset: EditReset };

  /* ======================= 4. RENDER ======================= */
  function renderList() {
    const key = S.alumnos.length ? 'lista' : 'vacio';
    $('#list').innerHTML = resolve(LIST_VIEWS, key, 'vacio')({ alumnos: S.alumnos, sim: simulate() });
    $('#selinfo').textContent = resolve(SELECTION_LABELS, selected.size ? 'some' : 'none', 'none')(selected.size);
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

  function addMov(tipo, delta) {
    if (sending) return;
    if (!selected.size) return toast('Primero toca a uno o más alumnos', 'err');
    const n = selected.size;
    selected.forEach((id) => S.cart.push({ id: uid(), alumnoId: id, tipo, delta: tipo === 'reset' ? 0 : delta, nota: '' }));
    selected.clear();
    persist();
    render();
    haptic();
    toast(tipo === 'reset' ? `A cero añadido (${n})` : `${fmt(delta)} añadido al carrito (${n})`, 'ok');
  }

  function quick(value) {
    value === 'reset' ? addMov('reset', 0) : addMov('delta', parseInt(value, 10));
  }

  function customAmount(sign) {
    const inp = $('#custom');
    const v = parseInt(inp.value, 10);
    if (!v || v < 1) return toast('Escribe un número mayor que 0', 'err');
    if (v > 10000) return toast('Valor demasiado grande', 'err');
    if (!selected.size) return toast('Primero toca a uno o más alumnos', 'err');
    addMov('delta', sign * v);
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
    const sig = JSON.stringify(S.cart.map((c) => [c.alumnoId, c.tipo, c.delta]));
    const batchId = S.pending && S.pending.sig === sig ? S.pending.id : uid();
    S.pending = { id: batchId, sig };

    const movimientos = S.cart.map((c) => ({ alumnoId: c.alumnoId, tipo: c.tipo, delta: c.delta, nota: c.nota || '' }));

    // 3) Actualizacion OPTIMISTA: aplicamos saldos y vaciamos el carrito al instante
    const sim = simulate();
    S.alumnos.forEach((a) => (a.puntos = sim[a.id].now));
    S.cart = [];
    persist();
    closeSheet('sheet-cart');
    render();

    try {
      // 4) Envio al ledger (Google Apps Script)
      const res = await apiPost({ action: 'batch', batchId, movimientos });
      if (res.alumnos) S.alumnos = res.alumnos; // la verdad del servidor
      S.pending = null;
      persist();
      setStatus(isDemo() ? 'demo' : 'ok');
      const n = movimientos.length;
      toast(`${n} ${n === 1 ? 'movimiento enviado' : 'movimientos enviados'}`, 'ok');
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
      const changed = JSON.stringify(r.alumnos) !== JSON.stringify(S.alumnos);
      S.alumnos = r.alumnos;
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
