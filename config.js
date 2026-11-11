/**
 * CONFIGURACION GLOBAL
 * --------------------
 * APPS_SCRIPT_URL: URL de la "Aplicacion web" de Google Apps Script (termina en /exec).
 *                  Si lo dejas vacio, la app funciona en MODO DEMO con los datos de
 *                  DEMO_DATA_URL (guardados en el localStorage de cada dispositivo).
 * TOKEN:           Secreto compartido. Debe ser IGUAL que la constante TOKEN de Code.gs.
 * POLL_MS:         Cada cuantos ms refresca la pantalla del iPad.
 * DEMO_DATA_URL:   JSON de prueba: volcado de las pestanas de la hoja (alumnos, reglasYPremios, config, movimientos).
 */
window.APP_CONFIG = {
  APPS_SCRIPT_URL: 'https://script.google.com/macros/s/AKfycbyB3rwDwplNObhcErg5jwilBFLPUcGIDr_5rpreWzB4tklsfJKj9rwurqaJtLVZseqo/exec',
  TOKEN: 'cambia-esto-por-un-secreto',
  POLL_MS: 15000,
  DEMO_DATA_URL: 'datos-prueba.json'
};
