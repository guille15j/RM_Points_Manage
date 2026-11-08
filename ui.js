/**
 * ui.js - Componentes de interfaz compartidos (pantalla del alumno + panel del profesor)
 *
 * CONVENCION DE RENDERIZADO CONDICIONAL
 * -------------------------------------
 * Nada de if/else dentro de las plantillas. Cada decision visual se resuelve asi:
 *   1. Un MAPA { clave: componente } con todas las variantes posibles.
 *   2. Una funcion pequena que recibe los datos, calcula la clave y llama a resolve().
 *   3. resolve() devuelve el componente del mapa, o el de reserva si la clave no existe.
 * Para anadir una variante nueva basta con escribir su componente y registrarlo en el mapa.
 *
 * Todos los componentes devuelven HTML (string). Los datos que vienen de la hoja de calculo
 * se pasan siempre por esc() o safeIcon().
 */
(function () {
  'use strict';
  const { esc } = window.TP;

  /** Devuelve map[key]; si la clave no existe, map[fallbackKey]. */
  const resolve = (map, key, fallbackKey) =>
    Object.prototype.hasOwnProperty.call(map, key) ? map[key] : map[fallbackKey];

  /* ---------- Iconos (Material Symbols) ---------- */
  const ICON_RE = /^[a-z0-9_]{1,40}$/;
  /** Solo acepta nombres de icono validos (minusculas y guion bajo); si no, usa el de reserva. */
  const safeIcon = (name, fallback) => (ICON_RE.test(String(name || '')) ? name : fallback);

  /** Icono. cls admite utilidades de Tailwind (tamano, color); fill=true lo rellena. */
  function Icon(name, cls, fill) {
    return `<span class="icon${fill ? ' icon-fill' : ''}${cls ? ' ' + cls : ''}" aria-hidden="true">${esc(name)}</span>`;
  }

  /* ---------- Colores de identidad del alumno (los elige al personalizar su tarjeta) ----------
   * card   : fondo y borde de la tarjeta     row : fondo de la fila en Lista y Ranking
   * avatar : burbuja del avatar              swatch : muestra en el editor
   * Los cosmeticos (colores extra y degradados) usan clases propias de styles.css: .cos-<clave>.
   * Un mismo color o degradado se aplica igual en Tarjetas, Lista y Ranking. */
  // Clases escritas completas (no construidas por partes) para que Tailwind las detecte siempre
  const plain = (label, card, row, avatar, swatch) => ({ label, card, row, avatar, swatch });
  const cosmetic = (label, key) => ({ label, card: `cos-${key}`, row: `cos-${key}`, avatar: `cos-${key}-av text-ink`, swatch: `cos-${key}-av` });
  const COLOR_STYLES = {
    base: { label: 'Blanco', card: 'bg-surface border-line', row: '', avatar: 'bg-primary-soft text-primary', swatch: 'bg-surface border-2 border-line' },
    azul: plain('Azul', 'bg-sky-50 border-sky-200', 'bg-sky-50', 'bg-sky-100 text-sky-700', 'bg-sky-300'),
    verde: plain('Verde', 'bg-emerald-50 border-emerald-200', 'bg-emerald-50', 'bg-emerald-100 text-emerald-700', 'bg-emerald-300'),
    turquesa: plain('Turquesa', 'bg-teal-50 border-teal-200', 'bg-teal-50', 'bg-teal-100 text-teal-700', 'bg-teal-300'),
    amarillo: plain('Amarillo', 'bg-yellow-50 border-yellow-200', 'bg-yellow-50', 'bg-yellow-100 text-yellow-700', 'bg-yellow-300'),
    naranja: plain('Naranja', 'bg-orange-50 border-orange-200', 'bg-orange-50', 'bg-orange-100 text-orange-700', 'bg-orange-300'),
    rosa: plain('Rosa', 'bg-pink-50 border-pink-200', 'bg-pink-50', 'bg-pink-100 text-pink-700', 'bg-pink-300'),
    violeta: plain('Violeta', 'bg-violet-50 border-violet-200', 'bg-violet-50', 'bg-violet-100 text-violet-700', 'bg-violet-300'),
    arena: { label: 'Arena', card: 'bg-stone-100 border-stone-300', row: 'bg-stone-100', avatar: 'bg-stone-200 text-stone-700', swatch: 'bg-stone-300' },
    // Cosmeticos: se desbloquean con insignias (el motor decide cuales)
    coral: cosmetic('Coral', 'coral'),
    lavanda: cosmetic('Lavanda', 'lavanda'),
    menta: cosmetic('Menta', 'menta'),
    dorado: cosmetic('Dorado', 'dorado'),
    'deg-aurora': cosmetic('Aurora', 'deg-aurora'),
    'deg-atardecer': cosmetic('Atardecer', 'deg-atardecer'),
    'deg-oceano': cosmetic('Océano', 'deg-oceano'),
    'deg-bosque': cosmetic('Bosque', 'deg-bosque')
  };
  const colorStyle = (key) => resolve(COLOR_STYLES, key, 'base');

  // Nombres de los avatares imagen (el dibujo esta en avatares/<nombre>.svg)
  const AVATAR_IMAGE_LABELS = { robot: 'Robot', androide: 'Androide', gato: 'Gato', zorro: 'Zorro', buho: 'Búho', pulpo: 'Pulpo' };
  /** Nombre legible de un cosmetico (clave del motor) para mostrarlo en la interfaz. */
  const cosmeticLabel = (key) =>
    key.indexOf('img:') === 0 ? 'Avatar ' + (AVATAR_IMAGE_LABELS[key.slice(4)] || key.slice(4)) : (key.indexOf('deg-') === 0 ? 'Fondo ' : 'Color ') + colorStyle(key).label;

  /* ---------- Avatar de alumno: icono de Material o imagen (clave 'img:nombre') ---------- */
  const AVATAR_SIZES = {
    sm: { box: 'w-10 h-10', icon: 'text-2xl' },
    md: { box: 'w-12 h-12', icon: 'text-3xl' },
    lg: { box: 'w-16 h-16', icon: 'text-4xl' }
  };
  const IMG_RE = /^[a-z0-9-]{1,30}$/;
  const AVATAR_FACES = {
    icon: (v, s) => Icon(safeIcon(v, 'person'), s.icon),
    image: (v) => `<img src="avatares/${esc(IMG_RE.test(v.slice(4)) ? v.slice(4) : 'robot')}.svg" alt="" class="w-full h-full object-contain p-0.5" draggable="false">`
  };
  const getAvatarKind = (v) => (String(v || '').indexOf('img:') === 0 ? 'image' : 'icon');
  /** Dibujo del avatar (icono o imagen) sin burbuja; sirve para las opciones del editor. */
  const avatarFace = (v, size) => resolve(AVATAR_FACES, getAvatarKind(String(v || '')), 'icon')(String(v || ''), resolve(AVATAR_SIZES, size, 'md'));
  function Avatar({ icono, color, size }) {
    const s = resolve(AVATAR_SIZES, size, 'md');
    const v = String(icono || '');
    return `<span class="flex items-center justify-center shrink-0 overflow-hidden rounded-full ${colorStyle(color).avatar} ${s.box}">${resolve(AVATAR_FACES, getAvatarKind(v), 'icon')(v, s)}</span>`;
  }

  /* ---------- Racha ---------- */
  const STREAK_CHIPS = {
    activa: ({ racha }) =>
      `<span class="inline-flex items-center gap-1 px-2 h-8 rounded-full bg-attention-soft text-attention font-bold" title="Racha de ${racha} clases">${Icon('local_fire_department', 'text-xl', true)}<span class="tabular-nums">${racha}</span><span class="sr-only"> clases seguidas</span></span>`,
    ninguna: () => ''
  };
  const getStreakKind = ({ racha }) => (racha >= 2 ? 'activa' : 'ninguna');
  const renderStreak = (alumno) => resolve(STREAK_CHIPS, getStreakKind(alumno), 'ninguna')(alumno);

  /* ---------- Insignias ---------- */
  const DAYS_LEFT = {
    si: (n) => ` (${n === 0 ? 'último día' : n === 1 ? 'queda 1 día' : 'quedan ' + n + ' días'})`,
    no: () => ''
  };
  const BADGE_ICON = ({ ins, restan }) => {
    const left = resolve(DAYS_LEFT, restan === undefined ? 'no' : 'si', 'no')(restan);
    return `<span class="flex items-center justify-center shrink-0 w-8 h-8 rounded-full border border-line bg-surface text-primary" title="${esc(ins.nombre + left)}">${Icon(safeIcon(ins.icono, 'military_tech'), 'text-xl')}<span class="sr-only">${esc(ins.nombre + left)}</span></span>`;
  };
  const BADGE_MORE = {
    si: (n) => `<span class="text-sm font-bold text-ink-soft">+${n}</span>`,
    no: () => ''
  };
  /** ids: insignias activas del alumno; catalog: lista completa; restan: {id: dias}; max: cuantas se muestran. */
  function renderBadges({ ids, catalog, max, restan }) {
    const all = (ids || []).map((id) => catalog.find((i) => i.id === id)).filter(Boolean);
    const shown = all.slice(0, max || 4);
    const extra = all.length - shown.length;
    return shown.map((ins) => BADGE_ICON({ ins, restan: restan ? restan[ins.id] : undefined })).join('') + resolve(BADGE_MORE, extra > 0 ? 'si' : 'no', 'no')(extra);
  }

  /* ---------- Notas (descripcion) ---------- */
  const NOTES = {
    con: (text, cls) => `<p class="${cls || 'text-ink-soft'}">${esc(text)}</p>`,
    sin: () => ''
  };
  const renderNote = (text, cls) => resolve(NOTES, text ? 'con' : 'sin', 'sin')(text, cls);

  /* ---------- Botones ---------- */
  const BTN_VARIANTS = {
    primary: 'bg-primary text-on-primary',
    outline: 'bg-surface text-ink border border-line',
    danger: 'bg-surface text-danger border border-danger/40',
    ghost: 'text-ink-soft'
  };
  const btnClass = (variant, extra) =>
    `pressable inline-flex items-center justify-center gap-2 h-tap px-4 rounded-ui font-semibold ${resolve(BTN_VARIANTS, variant, 'outline')} ${extra || ''}`;

  const ICON_BUTTON_SIZES = { md: 'w-tap h-tap', sm: 'w-10 h-10' };
  /** Boton solo-icono. attrs es HTML propio de la app (p. ej. data-del="..."), nunca datos externos. */
  function IconButton({ icon, label, attrs, size, cls }) {
    return `<button type="button" ${attrs || ''} aria-label="${esc(label)}" class="pressable inline-flex items-center justify-center rounded-ui text-ink-soft ${resolve(ICON_BUTTON_SIZES, size, 'md')} ${cls || ''}">${Icon(icon)}</button>`;
  }

  /* ---------- Control segmentado ---------- */
  const SEGMENT_STATES = {
    on: (o, attr, fill) =>
      `<button type="button" ${attr}="${esc(o.key)}" aria-pressed="true" class="pressable inline-flex items-center justify-center gap-2 h-seg px-4 rounded-ui font-semibold bg-surface text-ink shadow-sm ${fill ? 'flex-1' : ''}">${Icon(o.icon, 'text-[1.25em]')}<span>${esc(o.label)}</span></button>`,
    off: (o, attr, fill) =>
      `<button type="button" ${attr}="${esc(o.key)}" aria-pressed="false" class="pressable inline-flex items-center justify-center gap-2 h-seg px-4 rounded-ui font-semibold text-ink-soft ${fill ? 'flex-1' : ''}">${Icon(o.icon, 'text-[1.25em]')}<span>${esc(o.label)}</span></button>`
  };
  /** options: [{key,label,icon}]; attr: atributo data-* que llevara cada boton; fill: ocupar todo el ancho. */
  function Segmented({ options, active, attr, fill }) {
    const items = options
      .map((o) => resolve(SEGMENT_STATES, o.key === active ? 'on' : 'off', 'off')(o, attr, fill))
      .join('');
    return `<div class="${fill ? 'flex w-full' : 'inline-flex'} gap-1 p-1 rounded-ui bg-surface-alt" role="group">${items}</div>`;
  }

  /* ---------- Barra de progreso ---------- */
  function ProgressBar({ value, max, track }) {
    const pct = max > 0 ? Math.max(0, Math.min(100, Math.round((value / max) * 100))) : 0;
    return `<div class="h-3 w-full rounded-full overflow-hidden ${track || 'bg-surface-alt'}" role="progressbar" aria-valuemin="0" aria-valuemax="${max}" aria-valuenow="${Math.max(0, value)}"><div class="h-full rounded-full bg-primary" style="width:${pct}%"></div></div>`;
  }

  /* ---------- Estados vacios ---------- */
  const makeEmpty = (icon, title, text) => () =>
    `<div class="flex flex-col items-center gap-2 py-12 text-center text-ink-soft">${Icon(icon, 'text-5xl')}<p class="text-xl font-bold text-ink">${esc(title)}</p><p>${esc(text)}</p></div>`;

  const EMPTY_STATES = {
    sinAlumnos: makeEmpty('groups', 'Todavía no hay alumnos', 'Pulsa el botón de actualizar.'),
    sinPremios: makeEmpty('redeem', 'No hay premios', 'Pide a tu profe que los añada.'),
    sinReglas: makeEmpty('rule', 'Todavía no hay reglas', 'Tu profe las añadirá pronto.'),
    carritoVacio: makeEmpty('shopping_cart', 'El carrito está vacío', 'Selecciona alumnos y pulsa una acción.')
  };
  const renderEmpty = (key) => resolve(EMPTY_STATES, key, 'sinAlumnos')();

  /* ---------- Indicador de conexion ---------- */
  const makeStatus = (icon, label, tone) => ({ showLabel }) =>
    `<span class="inline-flex items-center gap-1.5 px-2.5 h-9 rounded-full text-sm font-semibold ${tone}" title="${esc(label)}">${Icon(icon, 'text-xl')}${showLabel ? `<span>${esc(label)}</span>` : `<span class="sr-only">${esc(label)}</span>`}</span>`;

  const STATUS_CHIPS = {
    ok: makeStatus('cloud_done', 'Conectado', 'bg-success-soft text-success'),
    off: makeStatus('cloud_off', 'Sin conexión', 'bg-attention-soft text-attention'),
    demo: makeStatus('experiment', 'Modo de prueba', 'bg-surface-alt text-ink-soft')
  };
  const renderStatus = ({ kind, showLabel }) => resolve(STATUS_CHIPS, kind, 'off')({ showLabel });

  /* ---------- Avisos (toast) ---------- */
  const makeToast = (icon, tone) => (msg) =>
    `<div role="status" class="flex items-center gap-3 px-4 py-2.5 rounded-ui border shadow-lg font-semibold ${tone}">${Icon(icon, 'text-2xl')}<span>${esc(msg)}</span></div>`;

  const TOASTS = {
    ok: makeToast('check_circle', 'bg-success-soft text-success border-success/30'),
    err: makeToast('error', 'bg-attention-soft text-attention border-attention/40'),
    info: makeToast('info', 'bg-surface text-ink border-line')
  };
  let toastTimer = null;
  /** kind: 'ok' | 'err' | 'info'. Requiere un <div id="toast-root"> en la pagina. */
  function toast(msg, kind) {
    const root = document.getElementById('toast-root');
    if (!root) return;
    clearTimeout(toastTimer);
    root.innerHTML = resolve(TOASTS, kind, 'info')(msg); // un solo aviso a la vez: el nuevo sustituye al anterior
    toastTimer = setTimeout(() => (root.innerHTML = ''), kind === 'err' ? 6000 : 3000);
  }

  /* ---------- Hojas modales ---------- */
  const openSheet = (id) => document.getElementById(id).classList.add('open');
  const closeSheet = (id) => document.getElementById(id).classList.remove('open');

  window.UI = {
    resolve, safeIcon, Icon, COLOR_STYLES, colorStyle, cosmeticLabel, avatarFace, Avatar, renderStreak, renderBadges, renderNote,
    btnClass, IconButton, Segmented, ProgressBar, renderEmpty, renderStatus, toast, openSheet, closeSheet
  };
})();
