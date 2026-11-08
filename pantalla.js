/**
 * pantalla.js - Pantalla comun y terminal de canjes (iPad)
 *
 * Pensada para ninos de 1.o a 6.o de primaria, incluidos alumnos con TEA:
 *  - Un solo objetivo por pantalla y pasos siempre en el mismo orden.
 *  - Tres secciones fijas: Puntos, Canjear y Reglas (tabla de lo que suma y resta).
 *  - Canjear va en dos pasos: 1) quien eres  2) elige tu premio  (+ confirmacion).
 *  - Los premios bloqueados no son botones: muestran cuanto falta, con barra de progreso.
 *  - "Personalizar mi tarjeta" abre un editor (icono + color) justo despues de canjearlo.
 *  - Si los datos no han cambiado, no se redibuja nada (sin parpadeos al refrescar).
 *
 * Estructura: 1. Estado  2. Componentes (con sus mapas)  3. Render  4. Canje  5. Personalizar
 *             6. Sincronizacion  7. Eventos
 * Convencion de renderizado condicional: ver cabecera de ui.js.
 */
(function () {
  'use strict';
  const { CFG, uid, clone, esc, store, isDemo, apiGet, apiPost, pickState } = window.TP;
  const { resolve, safeIcon, Icon, Avatar, avatarFace, colorStyle, cosmeticLabel, renderStreak, renderBadges, renderNote, btnClass, Segmented, ProgressBar, renderEmpty, renderStatus, toast, openSheet, closeSheet } = window.UI;
  const UI_ICON = (name) => safeIcon(name, 'redeem'); // icono de premio (si el dato no es valido, usa 'redeem')

  /* ======================= 1. ESTADO ======================= */
  const KEY = 'tp_pant_v3';
  const saved = store.get(KEY, {});
  const STATE_KEYS = ['alumnos', 'reglas', 'premios', 'insignias', 'reto', 'config'];
  const S = {
    alumnos: saved.alumnos || [],
    reglas: saved.reglas || [],
    premios: saved.premios || [],
    insignias: saved.insignias || [],
    reto: saved.reto || null,
    config: saved.config || { rachaHito: 5, rachaBonus: 10, ruletaBonus: [], avatares: [], colores: [], cosmeticos: [], insigniaDias: 7 },
    tab: saved.tab || 'puntos',   // clave de TABS
    view: saved.view || 'cards',  // clave de POINTS_VIEWS
    sel: null,                    // alumno que canjea (no se guarda: terminal compartido)
    status: isDemo() ? 'demo' : 'off'
  };
  let busy = false;               // operacion en curso: pausa el refresco automatico
  let pendingPrize = null;        // premio pendiente de confirmar
  let custom = null;              // editor de identidad: {alumnoId, avatar, color}

  const $ = (s) => document.querySelector(s);
  const persist = () => store.set(KEY, Object.assign(pickState(S), { tab: S.tab, view: S.view }));
  const applyServer = (res) => STATE_KEYS.forEach((k) => { if (res[k] !== undefined && (res[k] !== null || k === 'reto')) S[k] = res[k]; });
  const byName = (a, b) => a.nombre.localeCompare(b.nombre, 'es');
  const findAlumno = (id) => S.alumnos.find((a) => a.id === id);
  const findPremio = (id) => S.premios.find((p) => p.id === id);
  const maxCoste = () => Math.max(1, ...S.premios.map((p) => p.coste));

  /* ======================= 2. COMPONENTES ======================= */

  /** Estrella + cifra: la "moneda" de la app, siempre igual en todas las pantallas. */
  function Score({ value, size }) {
    return `<span class="inline-flex items-center gap-2 font-bold tabular-nums ${size || 'text-3xl'}">${Icon('star', 'text-[0.85em] text-primary', true)}<span>${value}</span></span>`;
  }
  const StudentAvatar = (a, size) => Avatar({ icono: a.avatar, color: a.color, size });
  const Badges = (a, max) => renderBadges({ ids: a.insignias || [], catalog: S.insignias, max, restan: a.insigniasRestan });

  /* ---- Reto de clase (barra comun) ---- */
  const RETO_STATES = {
    activo: (r) => `
      <section class="flex items-center gap-4 p-5 mb-6 rounded-ui-lg bg-surface border border-line" aria-label="Reto de clase">
        <span class="flex items-center justify-center shrink-0 w-14 h-14 rounded-full bg-primary-soft text-primary">${Icon(safeIcon(r.icono, 'flag'), 'text-4xl')}</span>
        <div class="flex-1 min-w-0 space-y-2">
          <div class="flex items-baseline justify-between gap-3">
            <h2 class="text-xl font-bold truncate">${esc(r.nombre)}</h2>
            <span class="text-xl font-bold tabular-nums shrink-0">${r.progreso} <span class="text-ink-soft font-normal">de ${r.meta}</span></span>
          </div>
          ${ProgressBar({ value: r.progreso, max: r.meta })}
          <p class="text-ink-soft">Entre todos conseguimos: <strong class="text-ink">${esc(r.premio)}</strong></p>
        </div>
      </section>`,
    logrado: (r) => `
      <section class="flex items-center gap-4 p-5 mb-6 rounded-ui-lg bg-success-soft border border-success/30 text-success" aria-label="Reto de clase conseguido">
        <span class="flex items-center justify-center shrink-0 w-14 h-14 rounded-full bg-surface">${Icon('check_circle', 'text-4xl', true)}</span>
        <div class="flex-1 min-w-0">
          <h2 class="text-xl font-bold">Lo hemos conseguido</h2>
          <p class="text-ink">${esc(r.nombre)}: <strong>${esc(r.premio)}</strong></p>
        </div>
      </section>`,
    ninguno: () => ''
  };
  const getRetoKind = (r) => (!r ? 'ninguno' : r.logrado ? 'logrado' : 'activo');
  const renderReto = (r) => resolve(RETO_STATES, getRetoKind(r), 'ninguno')(r);

  /* ---- Vistas de puntos (3 modos conmutables) ---- */

  function PointsList({ alumnos }) {
    const rows = [...alumnos]
      .sort(byName)
      .map(
        (a) => `
      <li class="flex items-center gap-4 px-5 py-3 min-h-tap ${colorStyle(a.color).row}">
        ${StudentAvatar(a, 'md')}
        <span class="flex-1 min-w-0 text-xl font-bold truncate">${esc(a.nombre)}</span>
        <span class="flex items-center gap-1.5">${Badges(a, 4)}</span>
        ${renderStreak(a)}
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
      <li class="flex items-center gap-4 px-5 py-4 ${colorStyle(a.color).row}">
        ${resolve(RANK_BADGES, getRankKind(a), 'rest')(a)}
        ${StudentAvatar(a, 'md')}
        <div class="flex-1 min-w-0 space-y-2">
          <div class="flex items-center gap-2">
            <p class="text-xl font-bold truncate">${esc(a.nombre)}</p>
            ${Badges(a, 3)}
          </div>
          ${ProgressBar({ value: a.puntos, max: meta })}
        </div>
        ${renderStreak(a)}
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
      <article class="flex flex-col items-center gap-2 p-5 text-center rounded-ui-lg border ${colorStyle(a.color).card}">
        ${StudentAvatar(a, 'lg')}
        <h3 class="max-w-full text-xl font-bold truncate">${esc(a.nombre)}</h3>
        ${Score({ value: a.puntos, size: 'text-5xl' })}
        <p class="text-ink-soft">puntos</p>
        <div class="flex flex-wrap items-center justify-center gap-1.5 min-h-[2rem]">${renderStreak(a)}${Badges(a, 4)}</div>
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
      ${renderReto(S.reto)}
      <div class="flex items-center gap-4 mb-6">
        <span class="text-ink-soft">Ver como</span>
        ${Segmented({ options: VIEW_OPTIONS, active: S.view, attr: 'data-view' })}
      </div>
      ${renderPointsView({ mode: S.view, alumnos: S.alumnos, maxCoste: maxCoste() })}`;
  }

  /* ---- Reglas: tabla de referencia (viene de la pestana ReglasYPremios) ---- */
  const RULE_TONES = {
    suma: { chip: 'bg-success-soft text-success', sign: '+' },
    resta: { chip: 'bg-attention-soft text-attention', sign: '−' }
  };
  const getRuleKind = (r) => (r.puntos >= 0 ? 'suma' : 'resta');

  function RuleRow(r) {
    const tone = resolve(RULE_TONES, getRuleKind(r), 'suma');
    return `
      <li class="flex items-center gap-3 px-4 py-2.5 min-h-tap">
        <span class="flex items-center justify-center shrink-0 w-11 h-11 rounded-full bg-surface-alt text-ink">${Icon(safeIcon(r.icono, 'rule'), 'text-3xl')}</span>
        <div class="flex-1 min-w-0">
          <p class="text-lg font-bold leading-tight">${esc(r.nombre)}</p>
          ${renderNote(r.descripcion, 'text-base leading-tight text-ink-soft')}
        </div>
        <span class="shrink-0 px-3 py-0.5 rounded-full text-xl font-bold tabular-nums ${tone.chip}">${tone.sign}${Math.abs(r.puntos)}</span>
      </li>`;
  }

  // Cada apartado tiene su propio color de cabecera: se distinguen de un vistazo
  const RULE_GROUPS = {
    suma: { title: 'Lo que suma', icon: 'add_circle', head: 'bg-success-soft text-success', filter: (r) => r.puntos >= 0 },
    resta: { title: 'Lo que resta', icon: 'do_not_disturb_on', head: 'bg-attention-soft text-attention', filter: (r) => r.puntos < 0 }
  };
  const RULE_GROUP_BODY = {
    lleno: (rows) => `<ul class="divide-y divide-line">${rows.map(RuleRow).join('')}</ul>`,
    vacio: () => `<p class="px-4 py-3 text-ink-soft">Nada por ahora.</p>`
  };
  const sectionCard = (id, head, icon, title, body) => `
    <section id="${id}" class="scroll-mt-28 overflow-hidden rounded-ui-lg bg-surface border border-line">
      <h2 class="flex items-center gap-2 px-4 py-3 text-2xl font-bold ${head}">${Icon(icon, 'text-3xl')}${title}</h2>
      ${body}
    </section>`;
  function RuleGroup(key) {
    const g = RULE_GROUPS[key];
    const rows = S.reglas.filter(g.filter).sort((x, y) => Math.abs(y.puntos) - Math.abs(x.puntos) || x.nombre.localeCompare(y.nombre, 'es'));
    return sectionCard('sec-' + key, g.head, g.icon, g.title, resolve(RULE_GROUP_BODY, rows.length ? 'lleno' : 'vacio', 'vacio')(rows));
  }

  function InfoRacha() {
    const c = S.config;
    return sectionCard('sec-racha', 'bg-attention-soft text-attention', 'local_fire_department', 'Racha',
      `<p class="px-4 py-3 text-lg text-ink-soft">Cada clase en la que sumas puntos, tu racha crece. Cada ${c.rachaHito} clases seguidas ganas <strong class="text-ink">+${c.rachaBonus}</strong> puntos extra.</p>`);
  }

  const UNLOCKS = {
    si: (list) => `<p class="text-base leading-tight text-primary">Desbloquea: ${esc(list.map(cosmeticLabel).join(', '))}</p>`,
    no: () => ''
  };
  const BADGE_LEGEND_BODY = {
    lleno: () => sectionCard('sec-insignias', 'bg-primary-soft text-primary', 'military_tech', 'Insignias',
      `<p class="px-4 py-3 text-lg text-ink-soft border-b border-line">Duran ${S.config.insigniaDias || 7} días. Lo que desbloquean es tuyo para siempre.</p>
      <ul class="divide-y divide-line">${S.insignias
        .map((i) => `<li class="flex items-center gap-3 px-4 py-2.5 min-h-tap">
          <span class="flex items-center justify-center shrink-0 w-11 h-11 rounded-full border border-line bg-surface text-primary">${Icon(safeIcon(i.icono, 'military_tech'), 'text-3xl')}</span>
          <div class="flex-1 min-w-0"><p class="text-lg font-bold leading-tight">${esc(i.nombre)}</p>${renderNote(i.descripcion, 'text-base leading-tight text-ink-soft')}${resolve(UNLOCKS, (i.desbloquea || []).length ? 'si' : 'no', 'no')(i.desbloquea || [])}</div>
        </li>`).join('')}</ul>`),
    vacio: () => ''
  };
  const BadgeLegend = () => resolve(BADGE_LEGEND_BODY, S.insignias.length ? 'lleno' : 'vacio', 'vacio')();

  // Indice: todos los apartados a la vista desde el principio; tocar uno lleva a su seccion
  const SECTION_INDEX = [
    { id: 'sec-suma', label: 'Suma', icon: 'add_circle', tone: 'bg-success-soft text-success', show: () => true },
    { id: 'sec-resta', label: 'Resta', icon: 'do_not_disturb_on', tone: 'bg-attention-soft text-attention', show: () => true },
    { id: 'sec-racha', label: 'Racha', icon: 'local_fire_department', tone: 'bg-attention-soft text-attention', show: () => true },
    { id: 'sec-insignias', label: 'Insignias', icon: 'military_tech', tone: 'bg-primary-soft text-primary', show: () => S.insignias.length > 0 }
  ];
  const SectionIndex = () => `
    <nav class="flex gap-3" aria-label="Apartados">
      ${SECTION_INDEX.filter((s) => s.show()).map((s) => `<button type="button" data-goto="${s.id}" class="pressable flex flex-1 items-center justify-center gap-2 h-tap rounded-ui text-xl font-bold ${s.tone}">${Icon(s.icon, 'text-3xl')}<span>${s.label}</span></button>`).join('')}
    </nav>`;

  const REGLAS_BODY = {
    lleno: () => `
      <div class="space-y-5">
        ${SectionIndex()}
        <div class="grid grid-cols-2 gap-5 items-start">${RuleGroup('suma')}${RuleGroup('resta')}</div>
        <div class="grid grid-cols-2 gap-5 items-start">${InfoRacha()}${BadgeLegend()}</div>
      </div>`,
    vacio: () => renderEmpty('sinReglas')
  };
  const ReglasPanel = () => resolve(REGLAS_BODY, S.reglas.length ? 'lleno' : 'vacio', 'vacio')();

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

  /* ---- Aviso: personalizacion pendiente ---- */
  const CUSTOM_PENDING = {
    si: () => `
      <div class="flex items-center gap-4 p-4 mb-8 rounded-ui-lg bg-primary-soft border-2 border-primary">
        <span class="text-primary">${Icon('brush', 'text-4xl')}</span>
        <p class="flex-1 text-xl font-bold">Tienes una personalización lista para estrenar.</p>
        <button type="button" data-open-custom class="${btnClass('primary', 'shrink-0 text-xl')}">${Icon('palette', 'text-3xl')}<span>Personalizar</span></button>
      </div>`,
    no: () => ''
  };

  /* ---- Canjear: pasos ---- */

  function StepSinDatos() {
    return renderEmpty('sinAlumnos');
  }

  function StepElegirAlumno() {
    const buttons = [...S.alumnos]
      .sort(byName)
      .map(
        (a) => `
      <button type="button" data-sel="${esc(a.id)}" class="pressable flex items-center gap-4 min-h-[5rem] px-4 text-left rounded-ui-lg border-2 ${colorStyle(a.color).card}">
        ${StudentAvatar(a, 'md')}
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
        <div class="flex items-center gap-4 p-4 mb-8 rounded-ui-lg border ${colorStyle(a.color).card}">
          ${StudentAvatar(a, 'lg')}
          <div class="flex-1 min-w-0">
            <p class="text-2xl font-bold truncate">${esc(a.nombre)}</p>
            <p class="flex items-center gap-2 text-ink-soft">Tienes ${Score({ value: a.puntos, size: 'text-2xl text-ink' })} puntos</p>
          </div>
          <button type="button" data-change class="${btnClass('outline', 'shrink-0 text-xl border-2')}">${Icon('swap_horiz', 'text-3xl')}<span>Cambiar</span></button>
        </div>
        ${resolve(CUSTOM_PENDING, a.pendientes > 0 ? 'si' : 'no', 'no')()}
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

  /* ---- Editor de identidad ---- */
  const optBase = 'pressable relative flex items-center justify-center aspect-square rounded-ui overflow-hidden';
  const LOCK = `<span class="absolute bottom-0.5 right-0.5 flex items-center justify-center w-6 h-6 rounded-full bg-surface text-ink-soft">${Icon('lock', 'text-base')}</span>`;
  const AVATAR_OPTION = {
    on: (k) => `<button type="button" data-av="${esc(k)}" aria-pressed="true" aria-label="${esc(k)}" class="${optBase} border-4 border-primary bg-primary-soft text-primary">${avatarFace(k, 'lg')}</button>`,
    off: (k) => `<button type="button" data-av="${esc(k)}" aria-pressed="false" aria-label="${esc(k)}" class="${optBase} border-2 border-line bg-surface text-ink">${avatarFace(k, 'lg')}</button>`,
    locked: (k) => `<button type="button" data-locked="${esc(k)}" aria-label="Bloqueado: ${esc(cosmeticLabel(k))}" class="${optBase} border-2 border-dashed border-line bg-surface-alt text-ink-soft opacity-60">${avatarFace(k, 'lg')}${LOCK}</button>`
  };
  const COLOR_OPTION = {
    on: (k) => `<button type="button" data-co="${esc(k)}" aria-pressed="true" aria-label="${esc(colorStyle(k).label)}" class="pressable flex items-center justify-center w-16 h-16 rounded-full border-4 border-primary ${colorStyle(k).swatch}">${Icon('check', 'text-3xl text-ink')}</button>`,
    off: (k) => `<button type="button" data-co="${esc(k)}" aria-pressed="false" aria-label="${esc(colorStyle(k).label)}" class="pressable w-16 h-16 rounded-full border-2 border-line ${colorStyle(k).swatch}"></button>`,
    locked: (k) => `<button type="button" data-locked="${esc(k)}" aria-label="Bloqueado: ${esc(cosmeticLabel(k))}" class="pressable relative flex items-center justify-center w-16 h-16 rounded-full border-2 border-dashed border-line opacity-50 ${colorStyle(k).swatch}">${Icon('lock', 'text-3xl text-ink')}</button>`
  };

  /** Opciones de un tipo: gratis (hoja Config) + cosmeticos desbloqueados + cosmeticos bloqueados. */
  function optionsOf({ tipo, free, a }) {
    const mine = a.cosmeticos || [];
    const extra = (S.config.cosmeticos || []).filter((c) => c.tipo === tipo);
    return {
      open: free.concat(extra.filter((c) => mine.indexOf(c.clave) >= 0).map((c) => c.clave)),
      locked: extra.filter((c) => mine.indexOf(c.clave) < 0)
    };
  }
  const optionState = (key, chosen) => (key === chosen ? 'on' : 'off');

  const CUSTOM_HINT = {
    si: (text) => `<p class="flex items-center gap-3 p-3 rounded-ui bg-attention-soft text-attention text-xl font-bold">${Icon('lock', 'text-3xl')}<span>${esc(text)}</span></p>`,
    no: () => ''
  };

  function CustomBody({ c, a }) {
    const av = optionsOf({ tipo: 'avatar', free: S.config.avatares, a });
    const co = optionsOf({ tipo: 'color', free: S.config.colores, a });
    const avatares = av.open.map((k) => resolve(AVATAR_OPTION, optionState(k, c.avatar), 'off')(k)).concat(av.locked.map((x) => AVATAR_OPTION.locked(x.clave))).join('');
    const colores = co.open.map((k) => resolve(COLOR_OPTION, optionState(k, c.color), 'off')(k)).concat(co.locked.map((x) => COLOR_OPTION.locked(x.clave))).join('');
    const ready = av.open.indexOf(c.avatar) >= 0 && co.open.indexOf(c.color) >= 0;
    return `
      <div class="space-y-6">
        <div class="flex items-center gap-5 p-4 rounded-ui-lg border ${colorStyle(c.color).card}">
          ${Avatar({ icono: c.avatar || a.avatar, color: c.color, size: 'lg' })}
          <div class="min-w-0">
            <h2 id="custom-title" class="text-3xl font-bold truncate">${esc(a.nombre)}</h2>
            <p class="text-ink-soft">Así se verá tu tarjeta.</p>
          </div>
        </div>
        <section>
          <h3 class="mb-3 text-2xl font-bold">1. Elige tu dibujo</h3>
          <div class="grid grid-cols-6 gap-3">${avatares}</div>
        </section>
        <section>
          <h3 class="mb-3 text-2xl font-bold">2. Elige tu color o fondo</h3>
          <div class="flex flex-wrap gap-4">${colores}</div>
        </section>
        ${resolve(CUSTOM_HINT, c.hint ? 'si' : 'no', 'no')(c.hint)}
        <div class="grid grid-cols-2 gap-4 pt-2">
          <button type="button" data-custom-later class="${btnClass('outline', 'h-[4.5rem] text-xl border-2')}">${Icon('schedule', 'text-3xl')}<span>Después</span></button>
          <button type="button" data-custom-save ${ready ? '' : 'disabled'} class="${btnClass('primary', 'h-[4.5rem] text-xl')}">${Icon('check', 'text-3xl')}<span>Guardar</span></button>
        </div>
      </div>`;
  }

  // Al tocar algo bloqueado se explica como conseguirlo (sin cambiar la seleccion)
  function showLocked(key) {
    const x = (S.config.cosmeticos || []).find((c) => c.clave === key);
    custom.hint = x ? `${cosmeticLabel(key)}: se consigue con la insignia ${x.insigniaNombre}.` : 'Todavía está bloqueado.';
    renderCustom();
  }

  /* ---- Navegacion por pestanas ---- */
  const TABS = {
    puntos: { label: 'Puntos', icon: 'star', Panel: PuntosPanel },
    canje: { label: 'Canjear', icon: 'redeem', Panel: CanjePanel },
    reglas: { label: 'Reglas', icon: 'rule', Panel: ReglasPanel }
  };
  const TAB_BUTTONS = {
    on: (t) => `<button type="button" data-tab="${t.key}" aria-current="page" class="pressable inline-flex items-center gap-2 h-tap px-4 rounded-ui text-xl font-bold bg-primary text-on-primary">${Icon(t.icon, 'text-3xl')}<span>${t.label}</span></button>`,
    off: (t) => `<button type="button" data-tab="${t.key}" class="pressable inline-flex items-center gap-2 h-tap px-4 rounded-ui text-xl font-bold bg-surface-alt text-ink">${Icon(t.icon, 'text-3xl')}<span>${t.label}</span></button>`
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

  // Que pasa despues de un canje, segun el efecto del premio (columna efecto de la hoja)
  const POST_REDEEM = {
    personalizar: (id) => openCustom(id),
    ninguno: () => { S.sel = null; } // vuelve al paso 1
  };

  async function doRedeem() {
    const a = findAlumno(S.sel);
    const p = pendingPrize;
    closeSheet('dlg');
    if (!a || !p || busy) return;
    busy = true;
    const nombre = a.nombre;
    const alumnoId = a.id;

    const snapshot = clone(S.alumnos);  // para el rollback
    a.puntos -= p.coste;                 // optimista: descuenta al instante
    if (p.efecto === 'personalizar') a.pendientes = (a.pendientes || 0) + 1;
    persist();
    render();

    try {
      const res = await apiPost({ action: 'canje', batchId: uid(), alumnoId, premioId: p.id });
      applyServer(res);                          // la verdad del servidor
      persist();
      setStatus(isDemo() ? 'demo' : 'ok');
      resolve(POST_REDEEM, p.efecto, 'ninguno')(alumnoId);
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

  /* ======================= 5. PERSONALIZAR (optimista + rollback) ======================= */
  function renderCustom() {
    const a = custom && findAlumno(custom.alumnoId);
    if (!a) return;
    $('#custom-body').innerHTML = CustomBody({ c: custom, a });
  }

  function openCustom(alumnoId) {
    const a = findAlumno(alumnoId);
    if (!a) return;
    custom = { alumnoId, avatar: a.avatar || '', color: a.color || '', hint: '' };
    renderCustom();
    openSheet('sheet-custom');
  }

  function closeCustom() {
    custom = null;
    closeSheet('sheet-custom');
    render();
  }

  async function saveCustom() {
    if (!custom || busy || !custom.avatar || !custom.color) return;
    busy = true;
    const c = custom;
    const a = findAlumno(c.alumnoId);
    const snapshot = clone(S.alumnos);
    // Optimista: la tarjeta cambia al instante en las tres vistas
    a.avatar = c.avatar;
    a.color = c.color;
    a.pendientes = Math.max(0, (a.pendientes || 0) - 1);
    persist();
    render();
    try {
      const res = await apiPost({ action: 'perfil', batchId: uid(), alumnoId: c.alumnoId, avatar: c.avatar, color: c.color });
      applyServer(res);
      persist();
      setStatus(isDemo() ? 'demo' : 'ok');
      S.sel = null;
      closeCustom();
      toast('Tu tarjeta ya es nueva.', 'ok');
    } catch (err) {
      console.error('Personalizacion fallida:', err);
      S.alumnos = snapshot;                     // ROLLBACK: el alumno conserva su personalizacion pendiente
      persist();
      setStatus('off');
      render();
      renderCustom();                           // el editor sigue abierto para reintentar
      toast('No se ha podido guardar. Prueba otra vez.', 'err');
    } finally {
      busy = false;
    }
  }

  /* ======================= 6. SINCRONIZACION ======================= */
  async function refresh(manual) {
    if (busy) return;
    try {
      const r = await apiGet();
      if (busy) return; // empezo una operacion mientras esperabamos
      const changed = JSON.stringify(pickState(r)) !== JSON.stringify(pickState(S));
      applyServer(r);
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

  /* ======================= 7. EVENTOS ======================= */
  // Lista [selector, accion]. Se evalua en orden; la primera coincidencia gana.
  const CLICK_HANDLERS = [
    ['[data-confirm]', () => doRedeem()],
    ['[data-custom-save]', () => saveCustom()],
    ['[data-custom-later]', () => closeCustom()],
    ['[data-locked]', (el) => showLocked(el.dataset.locked)],
    ['[data-av]', (el) => { custom.avatar = el.dataset.av; custom.hint = ''; renderCustom(); }],
    ['[data-co]', (el) => { custom.color = el.dataset.co; custom.hint = ''; renderCustom(); }],
    ['[data-open-custom]', () => openCustom(S.sel)],
    ['[data-close]', (el) => closeSheet(el.dataset.close)],
    ['[data-goto]', (el) => { const s = document.getElementById(el.dataset.goto); if (s) s.scrollIntoView({ block: 'start' }); }],
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
    if (!document.hidden && !busy && !$('#dlg').classList.contains('open') && !custom) refresh(false);
  }, CFG.POLL_MS || 15000);

  // Arranque: pinta lo guardado al instante y sincroniza en segundo plano
  render();
  refresh(false);
})();
