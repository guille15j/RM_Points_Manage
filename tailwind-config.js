/**
 * tailwind-config.js
 * ------------------
 * Configuracion de Tailwind (CDN). Se carga DESPUES de cdn.tailwindcss.com.
 *
 * Los colores y tamanos NO son valores fijos: apuntan a variables CSS definidas en
 * styles.css, una serie por perfil (html.theme-alumno / html.theme-profesor).
 * Asi el mismo marcado cambia de aspecto segun el perfil y la paleta se retoca en un solo sitio.
 *
 * Colores semanticos disponibles (bg-*, text-*, border-*):
 *   page, surface, surface-alt, line, ink, ink-soft,
 *   primary, primary-soft, on-primary,
 *   success, success-soft, danger, danger-soft, attention, attention-soft
 *
 * Tamanos semanticos:
 *   h-tap / w-tap / min-h-tap  -> zona tactil minima del perfil
 *   h-seg                      -> altura de un boton dentro de un control segmentado
 *   rounded-ui / rounded-ui-lg -> radios del perfil
 */
(function () {
  'use strict';
  const token = (name) => 'rgb(var(--c-' + name + ') / <alpha-value>)';

  tailwind.config = {
    theme: {
      extend: {
        colors: {
          page: token('page'),
          surface: token('surface'),
          'surface-alt': token('surface-alt'),
          line: token('line'),
          ink: token('ink'),
          'ink-soft': token('ink-soft'),
          primary: token('primary'),
          'primary-soft': token('primary-soft'),
          'on-primary': token('on-primary'),
          success: token('success'),
          'success-soft': token('success-soft'),
          danger: token('danger'),
          'danger-soft': token('danger-soft'),
          attention: token('attention'),
          'attention-soft': token('attention-soft')
        },
        borderRadius: {
          ui: 'var(--radius)',
          'ui-lg': 'var(--radius-lg)'
        },
        spacing: {
          tap: 'var(--tap)',
          seg: 'calc(var(--tap) - 0.5rem)'
        }
      }
    }
  };
})();
