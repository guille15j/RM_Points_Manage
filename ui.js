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

  /* ---------- Avatar de alumno ---------- */
  const AVATAR_SIZES = {
    sm: { box: 'w-10 h-10', icon: 'text-2xl' },
    md: { box: 'w-12 h-12', icon: 'text-3xl' },
    lg: { box: 'w-16 h-16', icon: 'text-4xl' }
  };
  function Avatar({ icono, size }) {
    const s = resolve(AVATAR_SIZES, size, 'md');
    return `<span class="flex items-center justify-center shrink-0 rounded-full bg-primary-soft text-primary ${s.box}">${Icon(safeIcon(icono, 'person'), s.icon)}</span>`;
  }

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
  /** kind: 'ok' | 'err' | 'info'. Requiere un <div id="toast-root"> en la pagina. */
  let toastTimer = null;
  function toast(msg, kind) {
    const root = document.getElementById('toast-root');
    if (!root) return;
    clearTimeout(toastTimer);
    root.innerHTML = resolve(TOASTS, kind, 'info')(msg); // un solo aviso a la vez: el nuevo sustituye al anterior
    toastTimer = setTimeout(() => (root.innerHTML = ''), kind === 'err' ? 6000 : 2500);
  }

  /* ---------- Hojas modales ---------- */
  const openSheet = (id) => document.getElementById(id).classList.add('open');
  const closeSheet = (id) => document.getElementById(id).classList.remove('open');

  window.UI = {
    resolve, safeIcon, Icon, Avatar, btnClass, IconButton, Segmented, ProgressBar,
    renderEmpty, renderStatus, toast, openSheet, closeSheet
  };
})();
