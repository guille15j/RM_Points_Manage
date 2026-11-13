/**
 * pantalla.js - Pantalla comun y terminal de canjes (iPad)
 *
 * Pensada para ninos de 1.o a 6.o de primaria, incluidos alumnos con TEA:
 *  - Un solo objetivo por pantalla y pasos siempre en el mismo orden.
 *  - Tres secciones fijas: Puntos, Canjear y Reglas (tabla de lo que suma y resta).
 *  - Canjear va en dos pasos: 1) quien eres  2) elige tu premio  (+ confirmacion).
 *  - Los premios bloqueados no son botones: muestran cuanto falta, con barra de progreso.
 *    Excepcion: Personalizar mi tarjeta se puede abrir para ver el editor, con Guardar bloqueado hasta tener los puntos.
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
  const { resolve, safeIcon, Icon, Avatar, avatarFace, colorStyle, cosmeticLabel, renderStreakProgress, renderBadges, renderNote, btnClass, Segmented, ProgressBar, renderEmpty, renderStatus, toast, openSheet, closeSheet } = window.UI;
  const UI_ICON = (name) => safeIcon(name, 'redeem'); // icono de premio (si el dato no es valido, usa 'redeem')

  /* ======================= 1. ESTADO ======================= */
  const KEY = 'tp_pant_v3';
  const saved = store.get(KEY, {});
  const STATE_KEYS = ['alumnos', 'reglas', 'premios', 'insignias', 'reto', 'mascota', 'estrellas', 'ayudante', 'cuidados', 'config'];
  const S = {
    alumnos: saved.alumnos || [],
    reglas: saved.reglas || [],
    premios: saved.premios || [],
    insignias: saved.insignias || [],
    reto: saved.reto || null,
    mascota: saved.mascota || null,
    estrellas: saved.estrellas || [],     // solo las usa el panel del profesor
    ayudante: saved.ayudante || null,
    cuidados: saved.cuidados || [],
    config: saved.config || { rachaHito: 5, rachaBonus: 10, ruletaBonus: [], avatares: [], colores: [], cosmeticos: [], insigniaDias: 7 },
    tab: saved.tab || 'puntos',   // clave de TABS
    view: saved.view || 'cards',  // clave de POINTS_VIEWS
    sel: null,                    // alumno que canjea (no se guarda: terminal compartido)
    status: isDemo() ? 'demo' : 'off'
  };
  let busy = false;               // operacion en curso: pausa el refresco automatico
  // Un reintento de la MISMA operacion reutiliza su batchId: si el servidor ya la registro, no se duplica; si nunca llego, se registra.
  let pendBatch = null;
  const batchFor = (sig) => { if (!pendBatch || pendBatch.sig !== sig) pendBatch = { sig, id: uid() }; return pendBatch.id; };
  const batchDone = () => { pendBatch = null; };
  let loading = '';               // boton que esta esperando respuesta: 'confirm' | 'nombre' | 'estrella' | 'custom' | 'cuida'

  // Boton de envio: mientras espera la respuesta queda desactivado y dice "Un momento..." (sin animacion: perfil alumno)
  const SEND_BTN = {
    loading: (o) => `<button type="button" disabled aria-busy="true" class="${o.cls}">${Icon('hourglass_top', o.sz || 'text-3xl')}<span>Un momento…</span></button>`,
    idle: (o) => `<button type="button" ${o.attrs} ${o.off ? 'disabled' : ''} class="${o.cls}">${Icon(o.icon, o.sz || 'text-3xl', o.fill)}<span>${o.label}</span></button>`
  };
  const sendBtn = (o) => resolve(SEND_BTN, loading === o.key ? 'loading' : 'idle', 'idle')(o);
  const noBtn = () => `<button type="button" data-close="dlg" ${loading ? 'disabled' : ''} class="${btnClass('outline', 'h-[4.5rem] text-xl border-2')}">${Icon('close', 'text-3xl')}<span>No</span></button>`;
  let pendingPrize = null;        // premio pendiente de confirmar
  let custom = null;              // editor de identidad: {alumnoId, avatar, color}

  const $ = (s) => document.querySelector(s);
  const persist = () => store.set(KEY, Object.assign(pickState(S), { tab: S.tab, view: S.view }));
  const applyServer = (res) => STATE_KEYS.forEach((k) => { if (res[k] !== undefined && (res[k] !== null || k === 'reto' || k === 'mascota' || k === 'ayudante')) S[k] = res[k]; });
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
  const StreakChip = (a) => renderStreakProgress(a, S.config.rachaHito);
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

  /* ---- Mascota de clase (boton flotante + pantalla propia) ---- */
  const SEEN_KEY = 'tp_mascota_seen_v1';              // ultima etapa que los ninos ya han visto
  const MASCOTA_ETAPAS = ['Huevo', 'Cría', 'Joven', 'Adulto', 'Leyenda'];
  // Imagenes: mascota/etapa-1 ... etapa-5 en .gif (animado), .png o .svg. Se prueba en ese orden
  // y se recuerda cual existe, asi cada etapa puede estar en el formato que se quiera.
  const MASCOTA_EXT = ['gif', 'png', 'svg'];
  const extUsada = {};                                // etapa -> posicion en MASCOTA_EXT ('u' = unknown)
  const MASCOTA_ANIM_MS = 3500;                       // duracion de la animacion de una accion
  const etapaN = (etapa) => Math.max(0, Math.min(MASCOTA_ETAPAS.length - 1, etapa)) + 1;
  const mascotaImg = (etapa) => `mascota/etapa-${etapaN(etapa)}.${MASCOTA_EXT[extUsada[etapaN(etapa)] || 0]}`;
  let mascotaAnim = null;                             // {accion, token}: animacion de accion en curso
  /**
   * <img> de la mascota (pixel art nitido). Si falta el archivo, el listener de abajo prueba el siguiente formato.
   * Con accion: mascota/etapa-N-<accion>.gif (se reinicia con ?v=); si no existe, vuelve a la imagen base.
   */
  const MascotaImg = (etapa, cls, alt, accion) => {
    const n = etapaN(etapa);
    const src = accion ? `mascota/etapa-${n}-${accion}.gif?v=${mascotaAnim ? mascotaAnim.token : 0}` : mascotaImg(etapa);
    return `<img src="${src}" data-mascota="${n}"${accion ? ` data-accion="${accion}"` : ''} alt="${esc(alt || '')}" class="mascota-px object-contain ${cls}" draggable="false">`;
  };
  /** Etapas aun no alcanzadas: mascota/unknown.gif|png|svg. Si no hay ninguno, un signo de interrogacion. */
  const MascotaUnknown = (cls) => `<img src="mascota/unknown.${MASCOTA_EXT[extUsada.u || 0]}" data-unknown="1" data-cls="${cls}" alt="Todavía es un misterio" class="mascota-px object-contain ${cls}" draggable="false">`;
  document.addEventListener('error', (e) => {
    const img = e.target;
    if (!img || !img.dataset) return;
    if (img.dataset.accion) {                         // animacion sin archivo: se queda la imagen base
      const n = Number(img.dataset.mascota);
      img.removeAttribute('data-accion');
      img.src = `mascota/etapa-${n}.${MASCOTA_EXT[extUsada[n] || 0]}`;
      return;
    }
    if (img.dataset.unknown) {
      const next = (extUsada.u || 0) + 1;
      if (next >= MASCOTA_EXT.length) {
        img.outerHTML = `<span class="flex items-center justify-center ${img.dataset.cls} text-ink-soft">${Icon('help', 'text-5xl')}</span>`;
        return;
      }
      extUsada.u = next;
      img.src = `mascota/unknown.${MASCOTA_EXT[next]}`;
      return;
    }
    if (!img.dataset.mascota) return;
    const n = Number(img.dataset.mascota);
    const next = (extUsada[n] || 0) + 1;
    if (next >= MASCOTA_EXT.length) return;           // ningun formato: se queda sin imagen
    extUsada[n] = next;
    img.src = `mascota/etapa-${n}.${MASCOTA_EXT[next]}`;
  }, true);
  const etapaNombre = (etapa) => MASCOTA_ETAPAS[Math.max(0, Math.min(MASCOTA_ETAPAS.length - 1, etapa))];
  let mascotaGrow = false;                            // al abrir: la mascota ha crecido desde la ultima vez

  /** Primera vez en este iPad: se toma la etapa actual como vista (sin celebrar nada). */
  function seenEtapa() {
    const m = S.mascota;
    let seen = store.get(SEEN_KEY, null);
    if (seen === null && m) { seen = m.etapa; store.set(SEEN_KEY, seen); }
    return seen === null ? 0 : seen;
  }

  const FAB_STATES = {
    peligro: (m) => `
      <button type="button" data-open-mascota aria-label="Ver a ${esc(m.nombre)}: está en peligro" class="pressable relative flex items-center justify-center w-24 h-24 rounded-full bg-surface border-4 border-attention shadow-lg">
        ${MascotaImg(m.etapa, 'w-16 h-16')}
        <span class="absolute -top-1 -right-1 flex items-center justify-center w-8 h-8 rounded-full bg-attention text-on-primary">${Icon('warning', 'text-xl', true)}</span>
      </button>`,
    nuevo: (m) => `
      <button type="button" data-open-mascota aria-label="Ver a ${esc(m.nombre)}: ha crecido" class="pressable relative flex items-center justify-center w-24 h-24 rounded-full bg-surface border-4 border-primary shadow-lg">
        ${MascotaImg(m.etapa, 'w-16 h-16')}
        <span class="absolute -top-1 -right-1 flex items-center justify-center w-8 h-8 rounded-full bg-primary text-on-primary">${Icon('arrow_upward', 'text-xl', true)}</span>
      </button>`,
    normal: (m) => `
      <button type="button" data-open-mascota aria-label="Ver a ${esc(m.nombre)}" class="pressable flex items-center justify-center w-24 h-24 rounded-full bg-surface border-2 border-line shadow-lg">
        ${MascotaImg(m.etapa, 'w-16 h-16')}
      </button>`,
    ninguno: () => ''
  };
  const getFabKind = (m) => (!m ? 'ninguno' : m.peligro ? 'peligro' : m.etapa > seenEtapa() ? 'nuevo' : 'normal');
  function renderMascotaFab() {
    const m = S.mascota;
    $('#fab-mascota').innerHTML = m ? `<div class="fab-mascota">${resolve(FAB_STATES, getFabKind(m), 'ninguno')(m)}</div>` : '';
  }

  const MASCOTA_GROW = {
    si: (m) => `<p class="flex items-center justify-center gap-2 px-4 py-3 rounded-ui bg-primary-soft text-primary text-xl font-bold">${Icon('auto_awesome', 'text-2xl', true)}<span>${esc(m.nombre)} ha crecido</span></p>`,
    no: () => ''
  };
  // Peligro: la mascota nunca retrocede; el profe decide si se reinicia. Tono tranquilo, sin dramatizar.
  const MASCOTA_ALERT = {
    si: (m) => `<p class="flex items-center justify-center gap-2 px-4 py-3 rounded-ui bg-attention-soft text-attention text-lg font-bold">${Icon('warning', 'text-2xl', true)}<span>${esc(m.nombre)} está en peligro. Tu profe decidirá qué hacer.</span></p>`,
    no: () => ''
  };
  const MASCOTA_PROGRESS = {
    creciendo: (m) => `
      <div class="space-y-2">
        <div class="flex items-baseline justify-between gap-3">
          <p class="text-lg font-bold">Siguiente: ${esc(etapaNombre(m.etapa + 1))}</p>
          <p class="text-lg font-bold tabular-nums">${m.puntos - m.desde} <span class="text-ink-soft font-normal">de ${m.hasta - m.desde}</span></p>
        </div>
        ${ProgressBar({ value: m.puntos - m.desde, max: m.hasta - m.desde })}
        <p class="text-ink-soft">Faltan <strong class="text-ink">${m.falta}</strong> puntos de toda la clase para que ${esc(m.nombre)} crezca.</p>
      </div>`,
    maxima: (m) => `
      <p class="flex items-center justify-center gap-2 px-4 py-3 rounded-ui bg-success-soft text-success text-lg font-bold">${Icon('check_circle', 'text-2xl', true)}<span>${esc(m.nombre)} ya es una leyenda</span></p>`
  };
  const MASCOTA_PREMIO = {
    si: (m) => `<p class="text-center text-ink-soft">${m.maxima ? 'Lo hemos conseguido' : 'Entre todos conseguimos'}: <strong class="text-ink">${esc(m.premio)}</strong></p>`,
    no: () => ''
  };

  /* ---- Necesidad de la mascota: una sola cada clase ---- */
  const ACCION_INFO = {
    comer: { icon: 'restaurant', pide: 'tiene hambre', verbo: (n, m) => `${n} dio de comer a ${m}` },
    acariciar: { icon: 'favorite', pide: 'quiere mimos', verbo: (n, m) => `${n} acarició a ${m}` },
    banar: { icon: 'bathtub', pide: 'necesita un baño', verbo: (n, m) => `${n} bañó a ${m}` },
    jugar: { icon: 'sports_esports', pide: 'quiere jugar', verbo: (n, m) => `${n} jugó con ${m}` }
  };
  let mascotaView = 'main';                           // 'main' | 'cuidar' | 'diario'
  let cuidaSel = '';                                  // alumno que cuida a la mascota (se olvida al cerrar)
  const premioDeAccion = (accion) => S.cuidados.find((p) => p.accion === accion);
  // Quien cuida: se elige al alumno y se pulsa la accion que la mascota necesita
  const CUIDA_QUIEN = {
    elegido: (a, p) => `
      <p class="flex items-center gap-2 flex-wrap"><span class="text-ink-soft">Cuida:</span><strong>${esc(a.nombre)}</strong>
        <button type="button" data-cuida-cambiar class="pressable px-3 h-10 rounded-ui bg-surface text-ink-soft border border-line">Cambiar</button></p>
      ${sendBtn({ key: 'cuida', attrs: 'data-cuida-go', off: a.puntos < p.coste, cls: 'pressable inline-flex items-center justify-center gap-2 w-full h-tap rounded-ui bg-primary text-on-primary font-bold', sz: 'text-2xl', icon: safeIcon(p.icono, 'favorite'), label: `${esc(p.nombre)} (${p.coste} puntos)` })}
      ${a.puntos >= p.coste ? '' : `<p class="text-ink-soft text-center">A ${esc(a.nombre)} le faltan ${p.coste - a.puntos} puntos.</p>`}`,
    nadie: () => `
      <p class="text-ink-soft">¿Quién lo cuida?</p>
      <div class="grid-fit grid-fit-sm gap-2">${[...S.alumnos].sort(byName).map((a) => `<button type="button" data-cuida-al="${esc(a.id)}" class="pressable h-tap px-2 rounded-ui bg-surface border border-line truncate">${esc(a.nombre)}</button>`).join('')}</div>`
  };
  const NEED_CTA = {
    si: (p) => resolve(CUIDA_QUIEN, findAlumno(cuidaSel) ? 'elegido' : 'nadie', 'nadie')(findAlumno(cuidaSel), p),
    no: () => ''
  };
  /** Cuida a la mascota: reutiliza el canje normal (optimista, rollback y animacion incluidos). */
  async function doCuidar() {
    const a = findAlumno(cuidaSel);
    const m = S.mascota;
    const p = m && premioDeAccion(m.necesidad);
    if (!a || !p || busy) return;
    const prev = S.sel;
    S.sel = a.id;
    pendingPrize = Object.assign({}, p, { efecto: 'mascota:' + p.accion });
    await doRedeem('cuida');
    cuidaSel = '';
    S.sel = prev;
    render();
    if (mascotaOpen()) renderMascota();
  }
  const MASCOTA_NEED = {
    pendiente: (m) => {
      const info = resolve(ACCION_INFO, m.necesidad, 'comer');
      return `<div class="flex items-center gap-3 p-4 rounded-ui-lg bg-primary-soft text-primary">
        <span class="shrink-0">${Icon(info.icon, 'text-4xl', true)}</span>
        <p class="text-xl font-bold">${esc(m.nombre)} ${info.pide}</p>
      </div>`;
    },
    atendida: (m) => `<p class="flex items-center justify-center gap-2 px-4 py-3 rounded-ui bg-success-soft text-success text-lg font-bold">${Icon('check_circle', 'text-2xl', true)}<span>${esc(m.nombre)} está bien. Hasta la próxima clase.</span></p>`,
    ninguna: () => ''
  };

  /* ---- Votacion del nombre ---- */
  const MASCOTA_VOTACION = {
    abierta: (m) => `<p class="flex items-center justify-center gap-2 text-ink-soft">${Icon('how_to_vote', 'text-2xl')}<span>Estamos eligiendo su nombre: han votado <strong class="text-ink">${m.votacion.votantes}</strong> de <strong class="text-ink">${m.votacion.total}</strong>. Mira en Canjear.</span></p>`,
    otro: () => ''
  };

  /* ---- Diario: lo que le ha pasado ---- */
  const nombreAlumno = (id) => (findAlumno(id) || { nombre: 'Alguien' }).nombre;
  const fechaCorta = (d) => (d ? d.slice(8, 10) + '/' + d.slice(5, 7) : '');
  const DIARIO_TEXTO = {
    crecio: (e, m) => ({ icon: 'auto_awesome', texto: `${m.nombre} creció: ${etapaNombre(e.etapa)}` }),
    peligro: (e, m) => ({ icon: 'warning', texto: `${m.nombre} se puso en peligro` }),
    recuperada: (e, m) => ({ icon: 'favorite', texto: `${m.nombre} se ha recuperado` }),
    reinicio: (e, m) => ({ icon: 'restart_alt', texto: `${m.nombre} empezó de nuevo` }),
    accion: (e, m) => {
      const info = resolve(ACCION_INFO, e.accion, 'comer');
      return { icon: info.icon, texto: info.verbo(nombreAlumno(e.alumnoId), m.nombre) };
    },
    nombre: (e) => ({ icon: 'badge', texto: `La clase eligió el nombre ${e.nombre}` })
  };
  const DIARIO_BODY = {
    lleno: (m) => `
      <section aria-label="Diario de ${esc(m.nombre)}" class="space-y-2">
        <h3 class="flex items-center gap-2 text-xl font-bold">${Icon('menu_book', 'text-2xl')}Diario</h3>
        <ul class="divide-y divide-line rounded-ui-lg border border-line overflow-hidden">${m.diario.map((e) => {
          const d = resolve(DIARIO_TEXTO, e.tipo, 'crecio')(e, m);
          return `<li class="flex items-center gap-3 px-4 py-2.5 min-h-tap"><span class="shrink-0 text-primary">${Icon(d.icon, 'text-2xl')}</span><span class="flex-1 min-w-0">${esc(d.texto)}</span><span class="shrink-0 text-sm text-ink-soft tabular-nums">${fechaCorta(e.dia)}</span></li>`;
        }).join('')}</ul>
      </section>`,
    vacio: () => ''
  };

  const MASCOTA_HEAD = (m, back) => `
      <div class="flex items-center justify-between gap-3 mb-3">
        ${back ? `<button type="button" data-mascota-view="main" class="pressable inline-flex items-center gap-2 h-tap px-4 rounded-ui bg-surface-alt text-ink font-bold">${Icon('arrow_back', 'text-2xl')}<span>Volver</span></button>` : `<h2 id="mascota-title" class="text-2xl font-bold truncate">${esc(m.nombre)}</h2>`}
        <button type="button" data-close="sheet-mascota" aria-label="Cerrar" class="pressable flex items-center justify-center w-tap h-tap rounded-ui bg-surface-alt text-ink-soft shrink-0">${Icon('close', 'text-3xl')}</button>
      </div>`;
  const bigBtn = (view, icon, label) => `<button type="button" data-mascota-view="${view}" class="pressable inline-flex items-center justify-center gap-2 h-tap px-4 rounded-ui bg-primary text-on-primary text-lg font-bold">${Icon(icon, 'text-2xl')}<span>${label}</span></button>`;
  // Botones de la vista principal: Cuidar solo si hay una necesidad sin atender (nunca en el huevo); Diario si hay algo que contar
  const MASCOTA_ACTIONS = {
    cuidar: (m) => `<button type="button" data-mascota-view="cuidar" class="pressable inline-flex items-center justify-center gap-2 h-tap px-4 rounded-ui bg-danger text-on-primary text-lg font-bold">${Icon('favorite', 'text-2xl', true)}<span>Cuidar</span></button>`,
    cuidarNo: () => `<button type="button" disabled aria-disabled="true" class="pressable inline-flex items-center justify-center gap-2 h-tap px-4 rounded-ui bg-surface-alt text-ink-soft text-lg font-bold">${Icon('favorite', 'text-2xl')}<span>Cuidar</span></button>`,
    diario: (m) => bigBtn('diario', 'menu_book', 'Diario'),
    nada: () => ''
  };
  const puedeCuidar = (m) => !!m.necesidad && !m.atendida && m.etapa >= 1;
  const MASCOTA_VIEWS = {
    main: (m) => {
      // Etapas ya alcanzadas se ven; las que faltan son un misterio (unknown) aunque las imagenes esten subidas
    const steps = MASCOTA_ETAPAS.map((n, i) => `
      <li class="flex flex-col items-center gap-1 flex-1 min-w-0" ${i === m.etapa ? 'aria-current="step"' : ''}>
        ${i > m.etapa ? MascotaUnknown('w-14 h-14') : MascotaImg(i, 'w-14 h-14')}
        <span class="text-sm ${i === m.etapa ? 'font-bold text-ink' : 'text-ink-soft'}">${i > m.etapa ? '?' : esc(n)}</span>
      </li>`).join('');
      const hayDiario = !!(m.diario && m.diario.length);
      const acciones = resolve(MASCOTA_ACTIONS, puedeCuidar(m) ? 'cuidar' : 'cuidarNo', 'cuidarNo')(m) + resolve(MASCOTA_ACTIONS, m.diario && m.diario.length ? 'diario' : 'nada', 'nada')(m);
      return `${MASCOTA_HEAD(m, false)}
      <div class="space-y-5">
        ${resolve(MASCOTA_GROW, mascotaGrow ? 'si' : 'no', 'no')(m)}
        ${resolve(MASCOTA_ALERT, m.peligro ? 'si' : 'no', 'no')(m)}
        <div class="flex justify-center"><div class="flex items-center justify-center w-60 h-60 rounded-full mascota-halo">${MascotaImg(m.etapa, 'w-52 h-52', m.nombre + ', etapa ' + etapaNombre(m.etapa), mascotaAnim && mascotaAnim.accion)}</div></div>
        <div class="grid gap-3 ${hayDiario ? 'grid-cols-2' : 'grid-cols-1'}">${acciones}</div>
        <ol class="flex gap-1 pt-2 border-t border-line" aria-label="Etapas">${steps}</ol>
        ${resolve(MASCOTA_PROGRESS, m.maxima ? 'maxima' : 'creciendo', 'creciendo')(m)}
        ${resolve(MASCOTA_VOTACION, m.votacion && m.votacion.estado === 'abierta' ? 'abierta' : 'otro', 'otro')(m)}
        ${resolve(MASCOTA_PREMIO, m.premio ? 'si' : 'no', 'no')(m)}
      </div>`;
    },
    cuidar: (m) => {
      const p = premioDeAccion(m.necesidad);
      const info = resolve(ACCION_INFO, m.necesidad, 'comer');
      return `${MASCOTA_HEAD(m, true)}
      <div class="space-y-4">
        <p class="flex items-center gap-3 text-xl font-bold text-primary">${Icon(info.icon, 'text-4xl', true)}<span>${esc(m.nombre)} ${info.pide}</span></p>
        ${resolve(NEED_CTA, p ? 'si' : 'no', 'no')(p)}
      </div>`;
    },
    diario: (m) => `${MASCOTA_HEAD(m, true)}${resolve(DIARIO_BODY, m.diario && m.diario.length ? 'lleno' : 'vacio', 'vacio')(m)}`
  };
  function MascotaBody(m) {
    // Si la vista pedida ya no tiene sentido (p. ej. ya se atendio), se vuelve a la principal
    const v = mascotaView === 'cuidar' && !puedeCuidar(m) ? 'main' : mascotaView;
    return resolve(MASCOTA_VIEWS, v, 'main')(m);
  }
  const mascotaOpen = () => document.getElementById('sheet-mascota').classList.contains('open');
  function renderMascota() {
    if (S.mascota) $('#mascota-body').innerHTML = MascotaBody(S.mascota);
    else closeSheet('sheet-mascota');
  }
  /** Tras atender a la mascota: abre su pantalla y lanza el GIF de la accion; al acabar vuelve al GIF base. */
  function playMascotaAnim(accion) {
    if (!S.mascota) return;
    const token = Date.now();
    mascotaAnim = { accion, token };
    mascotaView = 'main';
    mascotaGrow = false;
    renderMascota();
    openSheet('sheet-mascota');
    store.set(SEEN_KEY, S.mascota.etapa);
    renderMascotaFab();
    setTimeout(() => {
      if (mascotaAnim && mascotaAnim.token === token) {
        mascotaAnim = null;
        if (mascotaOpen()) renderMascota();
      }
    }, MASCOTA_ANIM_MS);
  }
  function openMascota() {
    if (!S.mascota) return;
    mascotaAnim = null;
    cuidaSel = '';
    mascotaView = 'main';
    mascotaGrow = S.mascota.etapa > seenEtapa();
    renderMascota();
    openSheet('sheet-mascota');
    store.set(SEEN_KEY, S.mascota.etapa);              // ya la han visto: el aviso del boton desaparece
    renderMascotaFab();
  }

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
        ${StreakChip(a)}
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
        ${StreakChip(a)}
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
        <div class="flex flex-wrap items-center justify-center gap-1.5 min-h-[2rem]">${StreakChip(a)}${Badges(a, 4)}</div>
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
  // Insignias en dos columnas; si el numero es impar, la ultima ocupa las dos
  const BADGE_LEGEND_BODY = {
    lleno: () => sectionCard('sec-insignias', 'bg-primary-soft text-primary', 'military_tech', 'Insignias',
      `<p class="px-4 py-3 text-lg text-ink-soft border-b border-line">Duran ${S.config.insigniaDias || 7} días. Lo que desbloquean es tuyo para siempre.</p>
      <ul class="grid grid-cols-2 gap-px bg-line">${S.insignias
        .map((i, idx) => `<li class="flex items-center gap-3 px-4 py-2.5 min-h-tap bg-surface ${S.insignias.length % 2 === 1 && idx === S.insignias.length - 1 ? 'col-span-2' : ''}">
          <span class="flex items-center justify-center shrink-0 w-11 h-11 rounded-full border border-line bg-surface text-primary">${Icon(safeIcon(i.icono, 'military_tech'), 'text-3xl')}</span>
          <div class="flex-1 min-w-0"><p class="text-lg font-bold leading-tight">${esc(i.nombre)}</p>${renderNote(i.descripcion, 'text-base leading-tight text-ink-soft')}${resolve(UNLOCKS, (i.desbloquea || []).length ? 'si' : 'no', 'no')(i.desbloquea || [])}</div>
        </li>`).join('')}</ul>`),
    vacio: () => ''
  };
  const BadgeLegend = () => resolve(BADGE_LEGEND_BODY, S.insignias.length ? 'lleno' : 'vacio', 'vacio')();

  // Indice: todos los apartados a la vista desde el principio; tocar uno lleva a su seccion
  const hayReglas = (key) => S.reglas.some(RULE_GROUPS[key].filter);
  const SECTION_INDEX = [
    { id: 'sec-suma', label: 'Suma', icon: 'add_circle', tone: 'bg-success-soft text-success', show: () => hayReglas('suma') },
    { id: 'sec-resta', label: 'Resta', icon: 'do_not_disturb_on', tone: 'bg-attention-soft text-attention', show: () => hayReglas('resta') },
    { id: 'sec-racha', label: 'Racha', icon: 'local_fire_department', tone: 'bg-attention-soft text-attention', show: () => true },
    { id: 'sec-insignias', label: 'Insignias', icon: 'military_tech', tone: 'bg-primary-soft text-primary', show: () => S.insignias.length > 0 }
  ];
  const SectionIndex = () => `
    <nav class="flex gap-3" aria-label="Apartados">
      ${SECTION_INDEX.filter((s) => s.show()).map((s) => `<button type="button" data-goto="${s.id}" class="pressable flex flex-1 items-center justify-center gap-2 h-tap rounded-ui text-xl font-bold ${s.tone}">${Icon(s.icon, 'text-3xl')}<span>${s.label}</span></button>`).join('')}
    </nav>`;

  // [suman][restan]: dos columnas; si solo hay una de las dos, ocupa todo el ancho
  const RULES_GRID = {
    dos: () => `<div class="grid grid-cols-2 gap-5 items-start">${RuleGroup('suma')}${RuleGroup('resta')}</div>`,
    suma: () => RuleGroup('suma'),
    resta: () => RuleGroup('resta')
  };
  const RulesGrid = () => resolve(RULES_GRID, hayReglas('suma') && hayReglas('resta') ? 'dos' : hayReglas('suma') ? 'suma' : 'resta', 'dos')();
  const REGLAS_BODY = {
    lleno: () => `
      <div class="space-y-5">
        ${SectionIndex()}
        ${RulesGrid()}
        ${InfoRacha()}
        ${BadgeLegend()}
      </div>`,
    vacio: () => renderEmpty('sinReglas')
  };
  const ReglasPanel = () => resolve(REGLAS_BODY, S.reglas.length ? 'lleno' : 'vacio', 'vacio')();

  /* ---- Premios: disponible o bloqueado ---- */

  // Efecto de un premio -> clave. 'mascota:comer', 'mascota:jugar'... son todos "mascota".
  const efectoKey = (e) => (String(e).indexOf('mascota:') === 0 ? 'mascota' : String(e));
  const PRIZE_CTA = {
    nombre: { icon: 'badge', label: 'Elegir nombre' },
    estrella: { icon: 'star', label: 'Enviar estrella' },
    ninguno: { icon: 'redeem', label: 'Canjear' }
  };

  // Columna descripcion de un premio: "texto visible # opcion1;opcion2". Antes del # se ve en la carta; despues van las opciones.
  const descVisible = (p) => { const s = String(p.descripcion || ''); const i = s.indexOf('#'); return i < 0 ? '' : s.slice(0, i).trim(); };
  const DESC_LINE = { si: (txt) => `<span class="text-lg leading-tight text-ink-soft">${esc(txt)}</span>`, no: () => '' };
  const descLine = (p) => resolve(DESC_LINE, descVisible(p) ? 'si' : 'no', 'no')(descVisible(p));

  function PrizeAvailable({ premio }) {
    const cta = resolve(PRIZE_CTA, efectoKey(premio.efecto), 'ninguno');
    return `
      <button type="button" data-pr="${esc(premio.id)}" class="pressable flex flex-col items-center gap-3 p-6 text-center rounded-ui-lg bg-surface border-2 border-primary">
        <span class="flex items-center justify-center w-20 h-20 rounded-full bg-primary-soft text-primary">${Icon(UI_ICON(premio.icono), 'text-5xl')}</span>
        <span class="flex items-center justify-center min-h-[4rem] text-2xl font-bold">${esc(premio.nombre)}</span>
        ${descLine(premio)}
        <span class="inline-flex items-center gap-1 text-xl text-ink-soft">${Score({ value: premio.coste, size: 'text-xl text-ink' })}puntos</span>
        <span class="flex items-center justify-center gap-2 w-full h-tap mt-1 rounded-ui bg-primary text-on-primary text-xl font-bold">${Icon(cta.icon, 'text-3xl')}${cta.label}</span>
      </button>`;
  }

  // Bloqueado = no es un boton. Se ve cuanto falta y cuanto llevas.
  function PrizeLocked({ premio, saldo }) {
    return `
      <div aria-disabled="true" class="flex flex-col items-center gap-3 p-6 text-center rounded-ui-lg bg-surface-alt border-2 border-line text-ink-soft">
        <span class="flex items-center justify-center w-20 h-20 rounded-full bg-surface text-ink-soft">${Icon(UI_ICON(premio.icono), 'text-5xl')}</span>
        <span class="flex items-center justify-center min-h-[4rem] text-2xl font-bold text-ink">${esc(premio.nombre)}</span>
        ${descLine(premio)}
        <span class="inline-flex items-center gap-1 text-xl">${Score({ value: premio.coste, size: 'text-xl text-ink' })}puntos</span>
        ${ProgressBar({ value: saldo, max: premio.coste, track: 'bg-line' })}
        <span class="inline-flex items-center gap-2 text-lg font-bold text-ink">${Icon('lock', 'text-2xl')}Te faltan ${premio.coste - saldo}</span>
      </div>`;
  }

  // Solo "Personalizar mi tarjeta": aunque falten puntos se puede abrir para ver el editor (Canjear sigue bloqueado)
  function PrizePreview({ premio, saldo }) {
    return `
      <button type="button" data-preview-custom class="pressable flex flex-col items-center gap-3 p-6 text-center rounded-ui-lg bg-surface-alt border-2 border-line text-ink-soft">
        <span class="flex items-center justify-center w-20 h-20 rounded-full bg-surface text-ink-soft">${Icon(UI_ICON(premio.icono), 'text-5xl')}</span>
        <span class="flex items-center justify-center min-h-[4rem] text-2xl font-bold text-ink">${esc(premio.nombre)}</span>
        <span class="inline-flex items-center gap-1 text-xl">${Score({ value: premio.coste, size: 'text-xl text-ink' })}puntos</span>
        ${ProgressBar({ value: saldo, max: premio.coste, track: 'bg-line' })}
        <span class="inline-flex items-center gap-2 text-lg font-bold text-ink">${Icon('lock', 'text-2xl')}Te faltan ${premio.coste - saldo}</span>
        <span class="inline-flex items-center justify-center gap-2 w-full h-tap rounded-ui border-2 border-line bg-surface text-ink text-lg font-bold">${Icon('visibility', 'text-3xl')}Ver cómo es</span>
      </button>`;
  }

  // Tarjeta sin boton con un mensaje (la mascota no lo necesita ahora, ya votaste, etc.)
  const mascotaNombre = () => (S.mascota ? S.mascota.nombre : 'La mascota');
  const PRIZE_MSG = {
    inactiva: () => 'Ahora no está disponible',
    atendida: () => `${mascotaNombre()} ya está atendida. Hasta la próxima clase.`,
    noNecesita: () => `${mascotaNombre()} no necesita esto ahora`,
    votacionCerrada: () => 'El nombre ya está elegido',
    votado: () => `Tu voto: ${(findAlumno(S.sel) || {}).votoNombre || ''}`,
    estrellaEnviada: () => ({ html: `Ya has enviado tu estrella. Otra en <span data-countdown class="tabular-nums">${fmtCountdown()}</span>` }),
    bloqueadoTpv: () => 'Espera a que tu profe te desbloquee'
  };
  const msgHtml = (m) => (typeof m === 'object' ? m.html : esc(m));
  // Tiempo hasta las 00:00 (cuando se puede volver a enviar una estrella)
  const msHastaMedianoche = () => { const d = new Date(); d.setHours(24, 0, 0, 0); return d - new Date(); };
  function fmtCountdown() {
    const s = Math.max(0, Math.floor(msHastaMedianoche() / 1000));
    const p2 = (n) => String(n).padStart(2, '0');
    return `${p2(Math.floor(s / 3600))}:${p2(Math.floor((s % 3600) / 60))}:${p2(s % 60)}`;
  }
  const isUnlocked = () => (findAlumno(S.sel) || {}).desbloqueado !== false;
  function PrizeMessage({ premio }, state) {
    return `
      <div aria-disabled="true" class="flex flex-col items-center gap-3 p-6 text-center rounded-ui-lg bg-surface-alt border-2 border-line text-ink-soft">
        <span class="flex items-center justify-center w-20 h-20 rounded-full bg-surface text-ink-soft">${Icon(UI_ICON(premio.icono), 'text-5xl')}</span>
        <span class="flex items-center justify-center min-h-[4rem] text-2xl font-bold text-ink">${esc(premio.nombre)}</span>
        <span class="inline-flex items-center gap-2 text-lg font-bold text-ink">${Icon('lock', 'text-2xl')}${msgHtml(resolve(PRIZE_MSG, state, 'inactiva')())}</span>
      </div>`;
  }
  const PRIZE_CARDS = { available: PrizeAvailable, preview: PrizePreview, locked: PrizeLocked };
  Object.keys(PRIZE_MSG).forEach((k) => { PRIZE_CARDS[k] = (props) => PrizeMessage(props, k); });

  // Estado de cada premio segun su efecto: solo la accion que la mascota pide esta habilitada
  const enough = ({ premio, saldo }) => (premio.coste <= saldo ? 'available' : 'locked');
  const PRIZE_STATE = {
    estandar: enough,
    personalizar: ({ premio, saldo }) => (premio.coste <= saldo ? 'available' : 'preview'),
    mascota: (props) => {
      const m = S.mascota;
      if (!m) return 'inactiva';
      if (m.atendida) return 'atendida';
      if (m.necesidad !== props.premio.efecto.slice(8)) return 'noNecesita';
      return enough(props);
    },
    nombre: (props) => {
      const v = S.mascota && S.mascota.votacion;
      if (!v || v.estado !== 'abierta') return 'votacionCerrada';
      return (findAlumno(S.sel) || {}).votoNombre ? 'votado' : enough(props);
    },
    estrella: (props) => ((findAlumno(S.sel) || {}).estrellaHoy ? 'estrellaEnviada' : enough(props))
  };
  const getPrizeState = (props) => (isUnlocked() ? resolve(PRIZE_STATE, efectoKey(props.premio.efecto), 'estandar')(props) : 'bloqueadoTpv');
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

  /* ---- Aviso: canje bloqueado por el profesor ---- */
  // Solo cubre la cuadricula de premios (no la pagina): Cambiar y las pestanas siguen libres
  const CLAVE_TPV = 'OPEN';
  let pideClave = false;
  const TPV_BANNER = {
    si: () => `
      <div class="absolute inset-0 z-10 flex items-start justify-center pt-16 bg-page/85 rounded-ui-lg" role="alert">
        ${resolve(TPV_CARD, pideClave ? 'clave' : 'aviso', 'aviso')()}
      </div>`,
    no: () => ''
  };
  const TPV_CARD = {
    aviso: () => `
      <button type="button" data-tpv-clave class="pressable flex items-center gap-4 p-6 mx-6 max-w-xl text-left rounded-ui-lg bg-surface border-2 border-attention shadow-xl">
        <span class="text-attention">${Icon('lock', 'text-5xl')}</span>
        <span class="text-2xl font-bold">Pide a tu profe que te desbloquee para canjear.</span>
      </button>`,
    clave: () => `
      <form data-tpv-form class="flex items-center gap-3 p-6 mx-6 max-w-xl rounded-ui-lg bg-surface border-2 border-attention shadow-xl">
        <span class="text-attention">${Icon('lock', 'text-5xl')}</span>
        <input id="tpv-clave" type="password" autocomplete="off" autocapitalize="characters" placeholder="Contraseña" aria-label="Contraseña" class="min-w-0 flex-1 h-tap px-4 text-2xl rounded-ui border-2 border-line bg-page outline-none focus:border-primary">
        <button type="submit" class="pressable h-tap px-5 rounded-ui bg-primary text-on-primary text-xl font-bold">Abrir</button>
        <button type="button" data-tpv-cancel aria-label="Cerrar" class="pressable flex items-center justify-center w-tap h-tap rounded-ui text-ink-soft">${Icon('close', 'text-3xl')}</button>
      </form>`
  };
  async function abrirManual(valor) {
    if (String(valor).trim().toUpperCase() !== CLAVE_TPV) { toast('Contraseña incorrecta', 'err'); return; }
    const a = findAlumno(S.sel);
    if (!a || busy) return;
    busy = true;
    try {
      const res = await apiPost({ action: 'tpv_abrir', batchId: batchFor(`abrir|${a.id}`), alumnoId: a.id });
      batchDone(); pideClave = false; applyServer(res); persist();
    } catch (err) { toast(`No se ha desbloqueado (${err.message})`, 'err'); }
    finally { busy = false; render(); }
  }
  const ESTRELLAS_AVISO = {
    si: (list) => `
      <p class="inline-flex items-center gap-2 mb-4 text-lg text-ink-soft" aria-label="Estrellas recibidas">
        <span class="text-primary">${Icon('star', 'text-2xl', true)}</span>
        <span class="font-semibold text-ink">${list.slice(0, 6).map((e) => esc(e.de)).join(', ')}${list.length > 6 ? ` y ${list.length - 6} más` : ''}</span>
      </p>`,
    no: () => ''
  };
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
        ${resolve(ESTRELLAS_AVISO, (a.estrellasRecibidas || []).length ? 'si' : 'no', 'no')(a.estrellasRecibidas || [])}
        ${resolve(CUSTOM_PENDING, a.pendientes > 0 ? 'si' : 'no', 'no')()}
        <h2 class="text-3xl font-bold">Elige tu premio</h2>
        <p class="mt-1 mb-6 text-ink-soft">Los premios con candado todavía no se pueden canjear.</p>
        <div class="relative">
          ${resolve(TPV_BANNER, isUnlocked() ? 'no' : 'si', 'no')()}
          ${renderPrizes({ premios: S.premios, saldo: a.puntos })}
        </div>
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
          ${noBtn()}
          ${sendBtn({ key: 'confirm', attrs: 'data-confirm', cls: btnClass('primary', 'h-[4.5rem] text-xl'), icon: 'check', label: 'Sí, canjear' })}
        </div>
      </div>`;
  }

  /* ---- Editor de identidad ---- */
  const optBase = 'pressable relative flex items-center justify-center aspect-square rounded-ui overflow-hidden';
  // Icono de la insignia que desbloquea un cosmetico (para que el nino asocie al instante dibujo/fondo <-> insignia)
  const insigniaIconoDe = (k) => {
    const c = (S.config.cosmeticos || []).find((x) => x.clave === k);
    const i = c && (S.insignias || []).find((x) => x.id === c.insignia);
    return i && i.icono ? safeIcon(i.icono, 'lock') : 'lock';
  };
  const LOCK_AV = (k) => `<span class="absolute bottom-0.5 right-0.5 flex items-center justify-center w-8 h-8 rounded-full bg-surface border border-line text-ink">${Icon(insigniaIconoDe(k), 'text-xl', true)}</span>`;
  const AVATAR_OPTION = {
    on: (k) => `<button type="button" data-av="${esc(k)}" aria-pressed="true" aria-label="${esc(k)}" class="${optBase} border-4 border-primary bg-primary-soft text-primary">${avatarFace(k, 'lg')}</button>`,
    off: (k) => `<button type="button" data-av="${esc(k)}" aria-pressed="false" aria-label="${esc(k)}" class="${optBase} border-2 border-line bg-surface text-ink">${avatarFace(k, 'lg')}</button>`,
    locked: (k) => `<button type="button" data-locked="${esc(k)}" aria-label="Bloqueado: ${esc(cosmeticLabel(k))}" class="${optBase} border-2 border-dashed border-line bg-surface-alt text-ink-soft opacity-60">${avatarFace(k, 'lg')}${LOCK_AV(k)}</button>`
  };
  const COLOR_OPTION = {
    on: (k) => `<button type="button" data-co="${esc(k)}" aria-pressed="true" aria-label="${esc(colorStyle(k).label)}" class="pressable flex items-center justify-center w-16 h-16 rounded-full border-4 border-primary ${colorStyle(k).swatch}">${Icon('check', 'text-3xl text-ink')}</button>`,
    off: (k) => `<button type="button" data-co="${esc(k)}" aria-pressed="false" aria-label="${esc(colorStyle(k).label)}" class="pressable w-16 h-16 rounded-full border-2 border-line ${colorStyle(k).swatch}"></button>`,
    locked: (k) => `<button type="button" data-locked="${esc(k)}" aria-label="Bloqueado: ${esc(cosmeticLabel(k))}" class="pressable relative flex items-center justify-center w-16 h-16 rounded-full border-2 border-dashed border-line opacity-50 ${colorStyle(k).swatch}">${Icon(insigniaIconoDe(k), 'text-3xl text-ink', true)}</button>`
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

  // Botones del editor: normal (tras canjear) o vista previa (sin puntos: Guardar bloqueado)
  const CUSTOM_ACTIONS = {
    normal: ({ ready }) => `
          ${sendBtn({ key: 'custom', attrs: 'data-custom-save', off: !ready, cls: btnClass('primary', 'h-[4.5rem] text-xl'), icon: 'check', label: 'Guardar' })}`,
    preview: ({ c }) => `
          <button type="button" disabled aria-disabled="true" class=""${btnClass('primary', 'h-[4.5rem] text-xl')}">${Icon('lock', 'text-3xl')}<span>Te faltan ${c.falta}</span></button>`
  };
  function CustomBody({ c, a }) {
    const av = optionsOf({ tipo: 'avatar', free: S.config.avatares, a });
    const co = optionsOf({ tipo: 'color', free: S.config.colores, a });
    const avatares = av.open.map((k) => resolve(AVATAR_OPTION, optionState(k, c.avatar), 'off')(k)).concat(av.locked.map((x) => AVATAR_OPTION.locked(x.clave))).join('');
    const colores = co.open.map((k) => resolve(COLOR_OPTION, optionState(k, c.color), 'off')(k)).concat(co.locked.map((x) => COLOR_OPTION.locked(x.clave))).join('');
    const ready = av.open.indexOf(c.avatar) >= 0 && co.open.indexOf(c.color) >= 0;
    // Un paso por pagina (1 = dibujo, 2 = color); la tarjeta de ejemplo se ve siempre arriba
    const PASOS = {
      1: () => `
        <section>
          <h3 class="mb-2 text-2xl font-bold">Elige tu dibujo</h3>
          <div class="grid grid-cols-10 gap-2">${avatares}</div>
        </section>
        ${resolve(CUSTOM_HINT, c.hint ? 'si' : 'no', 'no')(c.hint)}
        <div class="grid grid-cols-1 gap-4">
          <button type="button" data-custom-next ${c.avatar ? '' : 'disabled'} class="${btnClass('primary', 'h-[4.5rem] text-xl')}"><span>Siguiente</span>${Icon('arrow_forward', 'text-3xl')}</button>
        </div>`,
      2: () => `
        <section>
          <h3 class="mb-3 text-2xl font-bold">Elige tu color o fondo</h3>
          <div class="flex flex-wrap gap-3">${colores}</div>
        </section>
        ${resolve(CUSTOM_HINT, c.hint ? 'si' : 'no', 'no')(c.hint)}
        <div class="grid grid-cols-2 gap-4 pt-2">
          <button type="button" data-custom-atras ${loading ? 'disabled' : ''} class="${btnClass('outline', 'h-[4.5rem] text-xl border-2')}">${Icon('arrow_back', 'text-3xl')}<span>Atrás</span></button>
          ${resolve(CUSTOM_ACTIONS, c.preview ? 'preview' : 'normal', 'normal')({ ready, c })}
        </div>`
    };
    return `
      <div class="space-y-4">
        <div class="relative flex items-center gap-4 p-3 pr-20 rounded-ui-lg border ${colorStyle(c.color).card}">
          ${Avatar({ icono: c.avatar || a.avatar, color: c.color, size: 'md' })}
          <div class="min-w-0">
            <h2 id="custom-title" class="text-2xl font-bold truncate">${esc(a.nombre)}</h2>
            <p class="text-ink-soft">Así se verá tu tarjeta.</p>
          </div>
          <button type="button" data-custom-later ${loading ? 'disabled' : ''} aria-label="Cerrar" class="pressable absolute right-2 top-1/2 -translate-y-1/2 flex items-center justify-center w-tap h-tap rounded-ui bg-surface text-ink-soft">${Icon('close', 'text-3xl')}</button>
        </div>
        ${resolve(PASOS, c.paso === 2 ? 2 : 1, 1)()}
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
    renderMascotaFab();
    if (mascotaOpen()) renderMascota();
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
    const own = resolve(OWN_DIALOG, efectoKey(p.efecto), 'ninguno');
    if (own !== OWN_DIALOG.ninguno) return own(a, p);
    dlgMode = 'confirm';
    $('#dlg-body').innerHTML = ConfirmBody({ a, p });
    openSheet('dlg');
  }

  /* ---- Nombre de la mascota: cada alumno elige uno, una sola vez ---- */
  let dlgMode = 'confirm';
  let nameSel = '';
  // Opciones = lo que va despues del primer # (o toda la celda si no hay #), separadas por ; o |
  const opcionesDe = (p) => { const s = String(p.descripcion || ''); const i = s.indexOf('#'); return (i < 0 ? s : s.slice(i + 1)).split(/[;|]/).map((x) => x.trim()).filter(Boolean); };
  // El servidor parte la celda entera por ; y |, asi que la primera opcion le llega como "descripcion#opcion": se envia tal como el la conoce
  const valorServidor = (p, o) => String(p.descripcion || '').split(/[;|]/).map((x) => x.trim()).find((x) => x === o || x.slice(x.lastIndexOf('#') + 1).trim() === o && x.indexOf('#') >= 0) || o;
  function NombreBody({ p }) {
    const opts = opcionesDe(p).map((o) => `<button type="button" data-nombre-pick="${esc(o)}" aria-pressed="${o === nameSel}" class="pressable flex items-center justify-center min-h-[4.5rem] px-4 rounded-ui-lg text-2xl font-bold border-2 ${o === nameSel ? 'border-primary bg-primary-soft text-primary' : 'border-line bg-surface text-ink'}">${esc(o)}</button>`).join('');
    return `
      <div class="flex flex-col gap-5">
        <div class="text-center space-y-1">
          <h2 id="dlg-title" class="text-3xl font-bold">¿Cómo se llamará?</h2>
          <p class="text-ink-soft">Solo puedes elegir una vez. Cuando voten todos, aparecerá su nombre.</p>
        </div>
        <div class="grid grid-cols-2 gap-3">${opts}</div>
        <div class="grid grid-cols-2 gap-4 pt-2">
          ${noBtn()}
          ${sendBtn({ key: 'nombre', attrs: 'data-nombre-send', off: !nameSel, cls: btnClass('primary', 'h-[4.5rem] text-xl'), icon: 'check', label: 'Elegir' })}
        </div>
      </div>`;
  }
  function openNombre(a, p) {
    nameSel = '';
    dlgMode = 'nombre';
    $('#dlg-body').innerHTML = NombreBody({ p });
    openSheet('dlg');
  }
  async function sendNombre() {
    const a = findAlumno(S.sel);
    const p = pendingPrize;
    if (!a || !p || !nameSel || busy) return;
    busy = true;
    loading = 'nombre';
    paintLoading();
    const voto = nameSel;
    const nombre = a.nombre;
    try {
      const res = await apiPost({ action: 'canje', batchId: batchFor(`voto|${a.id}|${p.id}|${voto}`), alumnoId: a.id, premioId: p.id, opcion: valorServidor(p, voto) });
      batchDone();
      applyServer(res);
      persist();
      setStatus(isDemo() ? 'demo' : 'ok');
      S.sel = null;
      render();
      toast(`Hecho. ${nombre} ha votado ${voto}.`, 'ok');
    } catch (err) {
      console.error('Voto fallido:', err);
      setStatus('off');
      render();
      toast('No se ha podido enviar tu voto. Avisa a tu profe y vuelve a probar.', 'err');
    } finally {
      loading = '';
      closeSheet('dlg');
      busy = false;
      pendingPrize = null;
      nameSel = '';
    }
  }

  /* ---- Estrella amable: propones una frase amable a un companero; el profe la revisa ---- */
  let estrellaSel = { para: '', frase: -1 };
  function EstrellaBody({ a, p }) {
    const frases = opcionesDe(p);
    const espera = a.estrellaBloqueados || [];
    const mates = [...S.alumnos].filter((x) => x.id !== a.id).sort(byName).map((x) => `
      <button type="button" data-est-para="${esc(x.id)}" ${espera.includes(x.id) ? 'disabled' : ''} aria-pressed="${x.id === estrellaSel.para}" class="pressable flex items-center gap-3 min-h-[4.5rem] px-3 text-left rounded-ui-lg border-2 ${espera.includes(x.id) ? 'border-line bg-surface-alt text-ink-soft opacity-60' : x.id === estrellaSel.para ? 'border-primary bg-primary-soft' : 'border-line bg-surface'}">
        ${StudentAvatar(x, 'md')}<span class="text-lg font-bold truncate">${esc(x.nombre)}</span>${espera.includes(x.id) ? Icon('lock', 'ml-auto text-2xl') : ''}
      </button>`).join('');
    const opts = frases.map((f, i) => `<button type="button" data-est-frase="${i}" aria-pressed="${i === estrellaSel.frase}" class="pressable flex items-center min-h-[3.5rem] px-4 text-left rounded-ui-lg text-xl font-bold border-2 ${i === estrellaSel.frase ? 'border-primary bg-primary-soft text-primary' : 'border-line bg-surface text-ink'}">${esc(f)}</button>`).join('');
    const ready = estrellaSel.para && estrellaSel.frase >= 0;
    const para = findAlumno(estrellaSel.para);
    // Un paso por pagina: 1 = a quien, 2 = por que (escoger compañero avanza solo)
    const PASOS = {
      1: () => `
        <section><h3 class="mb-2 text-xl font-bold">¿A quién?</h3><div class="grid grid-cols-2 gap-3">${mates}</div></section>
        `,
      2: () => `
        <section><h3 class="mb-2 text-xl font-bold">¿Por qué se la das a ${esc(para ? para.nombre : '')}?</h3><div class="grid gap-3">${opts}</div></section>
        <div class="grid grid-cols-2 gap-4 pt-2">
          <button type="button" data-est-atras ${loading ? 'disabled' : ''} class="${btnClass('outline', 'h-[4.5rem] text-xl border-2')}">${Icon('arrow_back', 'text-3xl')}<span>Atrás</span></button>
          ${sendBtn({ key: 'estrella', attrs: 'data-est-send', off: !ready, cls: btnClass('primary', 'h-[4.5rem] text-xl'), icon: 'star', label: 'Enviar' })}
        </div>`
    };
    return `
      <div class="flex flex-col gap-5 max-h-[80dvh] overflow-y-auto">
        <div class="relative flex items-center justify-center min-h-[3.5rem] px-14">
          <h2 id="dlg-title" class="text-3xl font-bold text-center">Estrella amable</h2>
          <button type="button" data-close="dlg" ${loading ? 'disabled' : ''} aria-label="Cerrar" class="pressable absolute right-0 top-0 flex items-center justify-center w-tap h-tap rounded-ui bg-surface-alt text-ink-soft">${Icon('close', 'text-3xl')}</button>
        </div>
        ${resolve(PASOS, estrellaSel.paso === 2 && para ? 2 : 1, 1)()}
      </div>`;
  }
  function openEstrella(a, p) {
    estrellaSel = { para: '', frase: -1 };
    dlgMode = 'estrella';
    $('#dlg-body').innerHTML = EstrellaBody({ a, p });
    openSheet('dlg');
  }
  async function sendEstrella() {
    const a = findAlumno(S.sel);
    const p = pendingPrize;
    if (!a || !p || busy || !estrellaSel.para || estrellaSel.frase < 0) return;
    const frase = valorServidor(p, opcionesDe(p)[estrellaSel.frase]);
    busy = true;
    loading = 'estrella';
    paintLoading();
    try {
      const res = await apiPost({ action: 'estrella', batchId: batchFor(`estrella|${a.id}|${estrellaSel.para}|${frase}`), alumnoId: a.id, paraId: estrellaSel.para, frase });
      batchDone();
      applyServer(res);
      persist();
      setStatus(isDemo() ? 'demo' : 'ok');
      S.sel = null;
      render();
      toast('Estrella enviada. Tu profe la revisará.', 'ok');
    } catch (err) {
      console.error('Estrella fallida:', err);
      setStatus('off');
      render();
      toast('No se ha podido enviar. Avisa a tu profe y vuelve a probar.', 'err');
    } finally {
      loading = '';
      closeSheet('dlg');
      busy = false;
      pendingPrize = null;
      estrellaSel = { para: '', frase: -1 };
    }
  }
  // Repinta el boton que acaba de pasar a "Un momento..." (o a su estado normal)
  const paintLoading = () => {
    const a = findAlumno(S.sel);
    if (loading === 'confirm' && a && pendingPrize) $('#dlg-body').innerHTML = ConfirmBody({ a, p: pendingPrize });
    else if (loading === 'nombre' || loading === 'estrella') redrawDlg();
    else if (loading === 'custom') renderCustom();
    else if (loading === 'cuida') renderMascota();
  };
  const redrawDlg = () => {
    const a = findAlumno(S.sel);
    if (!a || !pendingPrize) return;
    $('#dlg-body').innerHTML = dlgMode === 'nombre' ? NombreBody({ p: pendingPrize }) : EstrellaBody({ a, p: pendingPrize });
  };
  // Premios con su propia ventana en vez de la confirmacion normal
  const OWN_DIALOG = { nombre: openNombre, estrella: openEstrella, ninguno: null };
  OWN_DIALOG.ninguno = () => null;

  // Que pasa despues de un canje, segun el efecto del premio (columna efecto de la hoja)
  const POST_REDEEM = {
    personalizar: (id) => openCustom(id),
    mascota: (id, p) => { S.sel = null; playMascotaAnim(p.efecto.slice(8)); }, // abre a la mascota con su animacion
    ninguno: () => { S.sel = null; } // vuelve al paso 1
  };

  async function doRedeem(key) {
    const a = findAlumno(S.sel);
    const p = pendingPrize;
    if (!a || !p || busy) return;
    busy = true;
    loading = key || 'confirm';
    paintLoading();                     // el boton pasa a "Un momento..." hasta recibir respuesta
    const nombre = a.nombre;
    const alumnoId = a.id;

    // SIN actualizacion optimista: nada cambia en pantalla ni se guarda hasta que el servidor responde
    try {
      const res = await apiPost({ action: 'canje', batchId: batchFor(`canje|${alumnoId}|${p.id}`), alumnoId, premioId: p.id });
      batchDone();
      applyServer(res);                          // la verdad del servidor
      persist();
      setStatus(isDemo() ? 'demo' : 'ok');
      resolve(POST_REDEEM, efectoKey(p.efecto), 'ninguno')(alumnoId, p);
      render();
      toast(`Hecho. ${nombre} ha canjeado ${p.nombre}.`, 'ok');
    } catch (err) {
      console.error('Canje fallido:', err);
      setStatus('off');
      render();
      toast(`No se ha canjeado nada (${err.message}). Avisa a tu profe.`, 'err');
    } finally {
      loading = '';
      closeSheet('dlg');
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

  // preview = el alumno aun no tiene puntos: puede mirar el editor, pero Guardar queda bloqueado
  function openCustom(alumnoId, preview) {
    const a = findAlumno(alumnoId);
    if (!a) return;
    const costes = S.premios.filter((p) => p.efecto === 'personalizar').map((p) => p.coste);
    const falta = costes.length ? Math.max(0, Math.min(...costes) - a.puntos) : 0;
    custom = { alumnoId, paso: 1, avatar: a.avatar || '', color: a.color || '', hint: '', preview: !!preview && falta > 0, falta };
    renderCustom();
    openSheet('sheet-custom');
  }

  function closeCustom() {
    custom = null;
    closeSheet('sheet-custom');
    render();
  }

  async function saveCustom() {
    if (!custom || custom.preview || busy || !custom.avatar || !custom.color) return;
    busy = true;
    loading = 'custom';
    renderCustom();                             // Guardar pasa a "Un momento..." hasta recibir respuesta
    const c = custom;
    // SIN actualizacion optimista: la tarjeta cambia cuando el servidor confirma
    try {
      const res = await apiPost({ action: 'perfil', batchId: batchFor(`perfil|${c.alumnoId}|${c.avatar}|${c.color}`), alumnoId: c.alumnoId, avatar: c.avatar, color: c.color });
      batchDone();
      loading = '';
      applyServer(res);
      persist();
      setStatus(isDemo() ? 'demo' : 'ok');
      S.sel = null;
      closeCustom();
      toast('Tu tarjeta ya es nueva.', 'ok');
    } catch (err) {
      loading = '';
      console.error('Personalizacion fallida:', err);
      setStatus('off');
      render();
      renderCustom();                           // el editor sigue abierto para reintentar
      toast(`No se ha guardado nada (${err.message}). Prueba otra vez.`, 'err');
    } finally {
      loading = '';
      busy = false;
    }
  }

  /** Boton Cambiar: el perfil vuelve a quedar bloqueado (el servidor lo registra; un reintento si falla). */
  function cambiarAlumno() {
    const a = findAlumno(S.sel);
    if (a && a.desbloqueado === true && S.config.tpvBloqueo !== false) {
      a.desbloqueado = false;                              // se bloquea al instante en esta pantalla (direccion segura)
      const bid = uid();
      const cerrar = () => apiPost({ action: 'tpv_cerrar', batchId: bid, alumnoId: a.id });
      cerrar().then((res) => { applyServer(res); persist(); render(); })
        .catch(() => sleep(2000).then(cerrar).then((res) => { applyServer(res); persist(); render(); }).catch((e) => console.error('No se pudo bloquear:', e)));
    }
    S.sel = null;
    pideClave = false;
    render();
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
    ['[data-open-mascota]', () => openMascota()],
    ['[data-mascota-view]', (el) => { mascotaView = el.dataset.mascotaView; if (mascotaView !== 'cuidar') cuidaSel = ''; renderMascota(); const b = $('#mascota-body'); if (b) b.scrollTop = 0; }],
    ['[data-cuida-al]', (el) => { cuidaSel = el.dataset.cuidaAl; renderMascota(); }],
    ['[data-cuida-cambiar]', () => { cuidaSel = ''; renderMascota(); }],
    ['[data-cuida-go]', () => doCuidar()],
    ['[data-confirm]', () => doRedeem('confirm')],
    ['[data-nombre-pick]', (el) => { nameSel = el.dataset.nombrePick; redrawDlg(); }],
    ['[data-nombre-send]', () => sendNombre()],
    ['[data-est-para]', (el) => { estrellaSel.para = el.dataset.estPara; estrellaSel.paso = 2; redrawDlg(); }],
    ['[data-est-atras]', () => { estrellaSel.paso = 1; estrellaSel.frase = -1; redrawDlg(); }],
    ['[data-est-frase]', (el) => { estrellaSel.frase = Number(el.dataset.estFrase); redrawDlg(); }],
    ['[data-est-send]', () => sendEstrella()],
    ['[data-custom-save]', () => saveCustom()],
    ['[data-custom-next]', () => { custom.paso = 2; custom.hint = ''; renderCustom(); }],
    ['[data-custom-atras]', () => { custom.paso = 1; custom.hint = ''; renderCustom(); }],
    ['[data-custom-later]', () => closeCustom()],
    ['[data-locked]', (el) => showLocked(el.dataset.locked)],
    ['[data-av]', (el) => { custom.avatar = el.dataset.av; custom.hint = ''; renderCustom(); }],
    ['[data-co]', (el) => { custom.color = el.dataset.co; custom.hint = ''; renderCustom(); }],
    ['[data-open-custom]', () => openCustom(S.sel)],
    ['[data-preview-custom]', () => openCustom(S.sel, true)],
    ['[data-close]', (el) => closeSheet(el.dataset.close)],
    ['[data-goto]', (el) => { const s = document.getElementById(el.dataset.goto); if (s) s.scrollIntoView({ block: 'start' }); }],
    ['[data-tab]', (el) => { S.tab = el.dataset.tab; persist(); render(); window.scrollTo(0, 0); }],
    ['[data-view]', (el) => { S.view = el.dataset.view; persist(); render(); }],
    ['[data-sel]', (el) => { S.sel = el.dataset.sel; render(); window.scrollTo(0, 0); }],
    ['[data-change]', () => cambiarAlumno()],
    ['[data-tpv-clave]', () => { pideClave = true; render(); const i = $('#tpv-clave'); i && i.focus(); }],
    ['[data-tpv-cancel]', () => { pideClave = false; render(); }],
    ['[data-pr]', (el) => askRedeem(el.dataset.pr)],
    ['#btn-refresh', () => refresh(true)]
  ];
  document.addEventListener('click', (e) => {
    if (loading) return;                // esperando respuesta: ningun otro toque hace nada (evita dobles envios)
    for (const [selector, action] of CLICK_HANDLERS) {
      const el = e.target.closest(selector);
      if (el) return action(el);
    }
  });

  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(false); });
  setInterval(() => {
    if (!document.hidden && !busy && !$('#dlg').classList.contains('open') && !custom) refresh(false);
  }, CFG.POLL_MS || 15000);

  document.addEventListener('submit', (ev) => {
    if (!ev.target.matches('[data-tpv-form]')) return;
    ev.preventDefault();
    abrirManual(($('#tpv-clave') || {}).value || '');
  });
  // Contador de la estrella: solo cambia el texto (sin volver a pintar); al llegar a 0 se sincroniza
  let contadorAvisado = false;
  setInterval(() => {
    const els = document.querySelectorAll('[data-countdown]');
    if (!els.length) { contadorAvisado = false; return; }
    els.forEach((el) => { el.textContent = fmtCountdown(); });
    if (msHastaMedianoche() <= 1000 && !contadorAvisado) { contadorAvisado = true; setTimeout(() => refresh(false), 2000); }
  }, 1000);
  // Mientras un alumno espera a que el profesor lo desbloquee, se comprueba cada pocos segundos
  setInterval(() => {
    const a = findAlumno(S.sel);
    if (a && a.desbloqueado === false && !pideClave && !document.hidden && !busy && !$('#dlg').classList.contains('open') && !custom) refresh(false);
  }, 4000);

  // Arranque: pinta lo guardado al instante y sincroniza en segundo plano
  render();
  refresh(false);
})();
