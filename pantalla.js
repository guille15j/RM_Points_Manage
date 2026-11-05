/**
 * pantalla.js - Pantalla comun y terminal de canjes (iPad)
 *
 * Pensada para ninos de 1.o a 6.o de primaria, incluidos alumnos con TEA:
 *  - Un solo objetivo por pantalla y pasos siempre en el mismo orden.
 *  - Canjear va en dos pasos: 1) quien eres  2) elige tu premio  (+ confirmacion).
 *  - Los premios bloqueados no son botones: muestran cuanto falta, con barra de progreso.
 *  - Despues de canjear se vuelve al paso 1 (terminal compartido).
 *  - Si los datos no han cambiado, no se redibuja nada (sin parpadeos al refrescar).
 *
 * Estructura del archivo:
 *   1. Estado   2. Componentes (con sus mapas)   3. Render   4. Canje   5. Sincronizacion   6. Eventos
 * Convencion de renderizado condicional: ver cabecera de ui.js.
 */
(function () {
  'use strict';
  const { CFG, uid, clone, esc, store, isDemo, apiGet, apiPost } = window.TP;
  const { resolve, safeIcon, Icon, Avatar, btnClass, Segmented, ProgressBar, renderEmpty, renderStatus, toast, openSheet, closeSheet } = window.UI;
  const UI_ICON = (name) => safeIcon(name, 'redeem'); // icono de premio (si el dato no es valido, usa 'redeem')

  /* ======================= 1. ESTADO ======================= */
  const KEY = 'tp_pant_v2';
  const saved = store.get(KEY, {});
  const S = {
    alumnos: saved.alumnos || [],
    premios: saved.premios || [],
    tab: saved.tab || 'puntos',   // clave de TABS
    view: saved.view || 'cards',  // clave de POINTS_VIEWS
    sel: null,                    // alumno que canjea (no se guarda: terminal compartido)
    status: isDemo() ? 'demo' : 'off'
  };
  let busy = false;               // canje en curso: pausa el refresco automatico
  let pendingPrize = null;        // premio pendiente de confirmar

  const $ = (s) => document.querySelector(s);
  const persist = () => store.set(KEY, { alumnos: S.alumnos, premios: S.premios, tab: S.tab, view: S.view });
  const byName = (a, b) => a.nombre.localeCompare(b.nombre, 'es');
  const findAlumno = (id) => S.alumnos.find((a) => a.id === id);
  const findPremio = (id) => S.premios.find((p) => p.id === id);
  const maxCoste = () => Math.max(1, ...S.premios.map((p) => p.coste));

  /* ======================= 2. COMPONENTES ======================= */

  /** Estrella + cifra: la "moneda" de la app, siempre igual en todas las pantallas. */
  function Score({ value, size }) {
    return `<span class="inline-flex items-center gap-2 font-bold tabular-nums ${size || 'text-3xl'}">${Icon('star', 'text-[0.85em] text-primary', true)}<span>${value}</span></span>`;
  }

  /* ---- Vistas de puntos (3 modos conmutables) ---- */

  function PointsList({ alumnos }) {
    const rows = [...alumnos]
      .sort(byName)
      .map(
        (a) => `
      <li class="flex items-center gap-4 px-5 py-3 min-h-tap">
        ${Avatar({ icono: a.icono, size: 'md' })}
        <span class="flex-1 min-w-0 text-xl font-bold truncate">${esc(a.nombre)}</span>
        ${Score({ value: a.puntos, size: 'text-3xl' })}
      </li>`
      )
      .join('');
    return `<ul class="rounded-ui-lg bg-surface border border-line divide-y divide-line overflow-hidden">${rows}</ul>`;
  }

  // Insignia de posicion: las tres primeras (con puntos) destacan, el resto es neutro
  const RANK_BADGES = {
    top: ({ pos }) => `<span class="flex items-center justify-center shrink-0 w-12 h-12 rounded-full bg-primary text-on-primary text-xl font-bold">${pos}</span>`,
    rest: ({ pos }) => `<span class="flex items-center justify-center shrink-0 w-12 h-12 rounded-full bg-surface-alt text-ink-soft text-xl font-bold">${pos}</span>`
  };
  const getRankKind = ({ pos, puntos }) => (pos <= 3 && puntos > 0 ? 'top' : 'rest');

  /** Ordena por puntos; los empates comparten posicion. */
  function rankAlumnos(alumnos) {
    const sorted = [...alumnos].sort((a, b) => b.puntos - a.puntos || byName(a, b));
    let pos = 0;
    let prev = null;
    return sorted.map((a, i) => {
      if (a.puntos !== prev) {
        pos = i + 1;
        prev = a.puntos;
      }
      return Object.assign({}, a, { pos });
    });
  }

  // La barra se mide contra el premio mas caro (meta comun), no contra el companero que va primero.
  function PointsRanking({ alumnos, maxCoste: meta }) {
    const rows = rankAlumnos(alumnos)
      .map(
        (a) => `
      <li class="flex items-center gap-4 px-5 py-4">
        ${resolve(RANK_BADGES, getRankKind(a), 'rest')(a)}
        ${Avatar({ icono: a.icono, size: 'md' })}
        <div class="flex-1 min-w-0 space-y-2">
          <p class="text-xl font-bold truncate">${esc(a.nombre)}</p>
          ${ProgressBar({ value: a.puntos, max: meta })}
        </div>
        ${Score({ value: a.puntos, size: 'text-3xl' })}
      </li>`
      )
      .join('');
    return `<ol class="rounded-ui-lg bg-surface border border-line divide-y divide-line overflow-hidden">${rows}</ol>`;
  }

  function PointsCards({ alumnos }) {
    const cards = [...alumnos]
      .sort(byName)
      .map(
        (a) => `
      <article class="flex flex-col items-center gap-2 p-5 text-center rounded-ui-lg bg-surface border border-line">
        ${Avatar({ icono: a.icono, size: 'lg' })}
        <h3 class="max-w-full text-xl font-bold truncate">${esc(a.nombre)}</h3>
        ${Score({ value: a.puntos, size: 'text-5xl' })}
        <p class="text-ink-soft">puntos</p>
      </article>`
      )
      .join('');
    return `<div class="grid-fit grid-fit-md gap-4">${cards}</div>`;
  }

  // MAPA de vistas. La clave 'vacio' cubre el caso sin datos.
  const POINTS_VIEWS = {
    list: PointsList,
    ranking: PointsRanking,
    cards: PointsCards,
    vacio: () => renderEmpty('sinAlumnos')
  };
  function renderPointsView({ mode, alumnos, maxCoste: meta }) {
    const key = alumnos.length ? mode : 'vacio';
    return resolve(POINTS_VIEWS, key, 'cards')({ alumnos, maxCoste: meta });
  }

  const VIEW_OPTIONS = [
    { key: 'list', label: 'Lista', icon: 'view_list' },
    { key: 'ranking', label: 'Ranking', icon: 'leaderboard' },
    { key: 'cards', label: 'Tarjetas', icon: 'grid_view' }
  ];

  function PuntosPanel() {
    return `
      <div class="flex items-center gap-4 mb-6">
        <span class="text-ink-soft">Ver como</span>
        ${Segmented({ options: VIEW_OPTIONS, active: S.view, attr: 'data-view' })}
      </div>
      ${renderPointsView({ mode: S.view, alumnos: S.alumnos, maxCoste: maxCoste() })}`;
  }

  /* ---- Premios: disponible o bloqueado ---- */

  function PrizeAvailable({ premio }) {
    return `
      <button type="button" data-pr="${esc(premio.id)}" class="pressable flex flex-col items-center gap-3 p-6 text-center rounded-ui-lg bg-surface border-2 border-primary">
        <span class="flex items-center justify-center w-20 h-20 rounded-full bg-primary-soft text-primary">${Icon(UI_ICON(premio.icono), 'text-5xl')}</span>
        <span class="flex items-center justify-center min-h-[4rem] text-2xl font-bold">${esc(premio.nombre)}</span>
        <span class="inline-flex items-center gap-1 text-xl text-ink-soft">${Score({ value: premio.coste, size: 'text-xl text-ink' })}puntos</span>
        <span class="flex items-center justify-center gap-2 w-full h-tap mt-1 rounded-ui bg-primary text-on-primary text-xl font-bold">${Icon('redeem', 'text-3xl')}Canjear</span>
      </button>`;
  }

  // Bloqueado = no es un boton. Se ve cuanto falta y cuanto llevas.
  function PrizeLocked({ premio, saldo }) {
    return `
      <div aria-disabled="true" class="flex flex-col items-center gap-3 p-6 text-center rounded-ui-lg bg-surface-alt border-2 border-line text-ink-soft">
        <span class="flex items-center justify-center w-20 h-20 rounded-full bg-surface text-ink-soft">${Icon(UI_ICON(premio.icono), 'text-5xl')}</span>
        <span class="flex items-center justify-center min-h-[4rem] text-2xl font-bold text-ink">${esc(premio.nombre)}</span>
        <span class="inline-flex items-center gap-1 text-xl">${Score({ value: premio.coste, size: 'text-xl text-ink' })}puntos</span>
        ${ProgressBar({ value: saldo, max: premio.coste, track: 'bg-line' })}
        <span class="inline-flex items-center gap-2 text-lg font-bold text-ink">${Icon('lock', 'text-2xl')}Te faltan ${premio.coste - saldo}</span>
      </div>`;
  }

  const PRIZE_CARDS = { available: PrizeAvailable, locked: PrizeLocked };
  const getPrizeState = ({ premio, saldo }) => (premio.coste <= saldo ? 'available' : 'locked');
  function renderPrize(props) {
    return resolve(PRIZE_CARDS, getPrizeState(props), 'locked')(props);
  }

  function PrizeGrid({ premios, saldo }) {
    const cards = [...premios]
      .sort((x, y) => x.coste - y.coste || x.nombre.localeCompare(y.nombre, 'es')) // del mas barato al mas caro, siempre igual
      .map((premio) => renderPrize({ premio, saldo }))
      .join('');
    return `<div class="grid-fit grid-fit-lg gap-5">${cards}</div>`;
  }
  const PRIZE_LISTS = { lista: PrizeGrid, vacio: () => renderEmpty('sinPremios') };
  const renderPrizes = ({ premios, saldo }) =>
    resolve(PRIZE_LISTS, premios.length ? 'lista' : 'vacio', 'vacio')({ premios, saldo });

  /* ---- Canjear: pasos ---- */

  function StepSinDatos() {
    return renderEmpty('sinAlumnos');
  }

  function StepElegirAlumno() {
    const buttons = [...S.alumnos]
      .sort(byName)
      .map(
        (a) => `
      <button type="button" data-sel="${esc(a.id)}" class="pressable flex items-center gap-4 min-h-[5rem] px-4 text-left rounded-ui-lg bg-surface border-2 border-line">
        ${Avatar({ icono: a.icono, size: 'md' })}
        <span class="text-xl font-bold truncate">${esc(a.nombre)}</span>
      </button>`
      )
      .join('');
    return `
      <section>
        <h2 class="text-3xl font-bold">¿Quién eres?</h2>
        <p class="mt-1 mb-6 text-ink-soft">Toca tu nombre.</p>
        <div class="grid-fit grid-fit-md gap-4">${buttons}</div>
      </section>`;
  }

  function StepElegirPremio() {
    const a = findAlumno(S.sel);
    return `
      <section>
        <div class="flex items-center gap-4 p-4 mb-8 rounded-ui-lg bg-surface border border-line">
          ${Avatar({ icono: a.icono, size: 'lg' })}
          <div class="flex-1 min-w-0">
            <p class="text-2xl font-bold truncate">${esc(a.nombre)}</p>
            <p class="flex items-center gap-2 text-ink-soft">Tienes ${Score({ value: a.puntos, size: 'text-2xl text-ink' })} puntos</p>
          </div>
          <button type="button" data-change class="${btnClass('outline', 'shrink-0 text-xl border-2')}">${Icon('swap_horiz', 'text-3xl')}<span>Cambiar</span></button>
        </div>
        <h2 class="text-3xl font-bold">Elige tu premio</h2>
        <p class="mt-1 mb-6 text-ink-soft">Los premios con candado todavía no se pueden canjear.</p>
        ${renderPrizes({ premios: S.premios, saldo: a.puntos })}
      </section>`;
  }

  // MAPA de pasos. getCanjeStep decide en cual estamos.
  const CANJE_STEPS = { sinDatos: StepSinDatos, alumno: StepElegirAlumno, premio: StepElegirPremio };
  function getCanjeStep() {
    if (!S.alumnos.length) return 'sinDatos';
    return findAlumno(S.sel) ? 'premio' : 'alumno';
  }
  const CanjePanel = () => resolve(CANJE_STEPS, getCanjeStep(), 'alumno')();

  /* ---- Confirmacion ---- */
  function ConfirmBody({ a, p }) {
    return `
      <div class="flex flex-col items-center gap-5 text-center">
        <span class="flex items-center justify-center w-24 h-24 rounded-full bg-primary-soft text-primary">${Icon(UI_ICON(p.icono), 'text-6xl')}</span>
        <h2 id="dlg-title" class="text-3xl font-bold">¿Canjear ${esc(p.nombre)}?</h2>
        <ul class="w-full space-y-3 text-xl">
          <li class="flex items-center justify-between"><span class="text-ink-soft">Cuesta</span>${Score({ value: p.coste, size: 'text-2xl' })}</li>
          <li class="flex items-center justify-between"><span class="text-ink-soft">Te quedarán</span>${Score({ value: a.puntos - p.coste, size: 'text-2xl' })}</li>
        </ul>
        <div class="grid grid-cols-2 gap-4 w-full pt-2">
          <button type="button" data-close="dlg" class="${btnClass('outline', 'h-[4.5rem] text-xl border-2')}">${Icon('close', 'text-3xl')}<span>No</span></button>
          <button type="button" data-confirm class="${btnClass('primary', 'h-[4.5rem] text-xl')}">${Icon('check', 'text-3xl')}<span>Sí, canjear</span></button>
        </div>
      </div>`;
  }

  /* ---- Navegacion por pestanas ---- */
  const TABS = {
    puntos: { label: 'Puntos', icon: 'star', Panel: PuntosPanel },
    canje: { label: 'Canjear', icon: 'redeem', Panel: CanjePanel }
  };
  const TAB_BUTTONS = {
    on: (t) => `<button type="button" data-tab="${t.key}" aria-current="page" class="pressable inline-flex items-center gap-2 h-tap px-5 rounded-ui text-xl font-bold bg-primary text-on-primary">${Icon(t.icon, 'text-3xl')}<span>${t.label}</span></button>`,
    off: (t) => `<button type="button" data-tab="${t.key}" class="pressable inline-flex items-center gap-2 h-tap px-5 rounded-ui text-xl font-bold bg-surface-alt text-ink">${Icon(t.icon, 'text-3xl')}<span>${t.label}</span></button>`
  };
  const renderTabs = () =>
    Object.keys(TABS)
      .map((key) => resolve(TAB_BUTTONS, key === S.tab ? 'on' : 'off', 'off')(Object.assign({ key }, TABS[key])))
      .join('');

  /* ======================= 3. RENDER ======================= */
  function renderStatusChip() {
    $('#status').innerHTML = renderStatus({ kind: S.status, showLabel: false });
  }
  function render() {
    $('#tabs').innerHTML = renderTabs();
    renderStatusChip();
    $('#main').innerHTML = resolve(TABS, S.tab, 'puntos').Panel();
  }
  function setStatus(kind) {
    S.status = kind;
    renderStatusChip();
  }

  /* ======================= 4. CANJE (optimista + rollback) ======================= */
  function askRedeem(prizeId) {
    const a = findAlumno(S.sel);
    const p = findPremio(prizeId);
    if (!a || !p || busy) return;
    if (p.coste > a.puntos) return toast('Todavía no tienes puntos para este premio.', 'info');
    pendingPrize = p;
    $('#dlg-body').innerHTML = ConfirmBody({ a, p });
    openSheet('dlg');
  }

  async function doRedeem() {
    const a = findAlumno(S.sel);
    const p = pendingPrize;
    closeSheet('dlg');
    if (!a || !p || busy) return;
    busy = true;
    const nombre = a.nombre;

    const snapshot = clone(S.alumnos);  // para el rollback
    a.puntos -= p.coste;                 // optimista: descuenta al instante
    persist();
    render();

    try {
      const res = await apiPost({ action: 'canje', batchId: uid(), alumnoId: a.id, premioId: p.id });
      if (res.alumnos) S.alumnos = res.alumnos; // la verdad del servidor
      S.sel = null;                             // vuelve al paso 1
      persist();
      setStatus(isDemo() ? 'demo' : 'ok');
      render();
      toast(`Hecho. ${nombre} ha canjeado ${p.nombre}.`, 'ok');
    } catch (err) {
      console.error('Canje fallido:', err);
      S.alumnos = snapshot;                     // ROLLBACK: puntos restaurados
      persist();
      setStatus('off');
      render();
      toast('No se ha podido canjear. Avisa a tu profe y vuelve a probar.', 'err');
    } finally {
      busy = false;
      pendingPrize = null;
    }
  }

  /* ======================= 5. SINCRONIZACION ======================= */
  async function refresh(manual) {
    if (busy) return;
    try {
      const r = await apiGet();
      if (busy) return; // empezo un canje mientras esperabamos
      const changed =
        JSON.stringify(r.alumnos) !== JSON.stringify(S.alumnos) ||
        JSON.stringify(r.premios || S.premios) !== JSON.stringify(S.premios);
      S.alumnos = r.alumnos;
      S.premios = r.premios || S.premios;
      if (S.sel && !findAlumno(S.sel)) S.sel = null;
      persist();
      setStatus(isDemo() ? 'demo' : 'ok');
      if (changed) render(); // sin cambios no se redibuja: la pantalla no parpadea
      if (manual) toast('Actualizado', 'info');
    } catch (e) {
      console.error('No se pudo actualizar:', e);
      setStatus('off');
      if (manual) toast('Sin conexión. Se muestran los últimos datos guardados.', 'err');
    }
  }

  /* ======================= 6. EVENTOS ======================= */
  // Lista [selector, accion]. Se evalua en orden; la primera coincidencia gana.
  const CLICK_HANDLERS = [
    ['[data-confirm]', () => doRedeem()],
    ['[data-close]', (el) => closeSheet(el.dataset.close)],
    ['[data-tab]', (el) => { S.tab = el.dataset.tab; persist(); render(); window.scrollTo(0, 0); }],
    ['[data-view]', (el) => { S.view = el.dataset.view; persist(); render(); }],
    ['[data-sel]', (el) => { S.sel = el.dataset.sel; render(); window.scrollTo(0, 0); }],
    ['[data-change]', () => { S.sel = null; render(); }],
    ['[data-pr]', (el) => askRedeem(el.dataset.pr)],
    ['#btn-refresh', () => refresh(true)]
  ];
  document.addEventListener('click', (e) => {
    for (const [selector, action] of CLICK_HANDLERS) {
      const el = e.target.closest(selector);
      if (el) return action(el);
    }
  });

  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(false); });
  setInterval(() => {
    if (!document.hidden && !busy && !$('#dlg').classList.contains('open')) refresh(false);
  }, CFG.POLL_MS || 15000);

  // Arranque: pinta lo guardado al instante y sincroniza en segundo plano
  render();
  refresh(false);
})();
