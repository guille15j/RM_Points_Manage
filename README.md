# Puntos de clase

App web estática (HTML + Tailwind CDN + JavaScript vainilla) para gestionar puntos en clase. Iconos: Material Symbols (sin emojis).

| Archivo | Para qué sirve |
|---|---|
| `index.html` | Portada con acceso a los dos paneles |
| `profesor.html` + `profesor.js` | Panel del profesor (iPhone): sobrio y compacto, carrito, envío transaccional con rollback |
| `pantalla.html` + `pantalla.js` | Pantalla del iPad para alumnos: puntos (lista / ranking / tarjetas) y canje en dos pasos |
| `ui.js` | Componentes compartidos y el helper `resolve()` del renderizado condicional |
| `shared.js` | Capa de API, almacenamiento y modo de prueba |
| `tailwind-config.js` + `styles.css` | **Tokens de diseño**: paleta, tamaños y radios por perfil |
| `datos-prueba.json` | Datos de prueba, con la misma forma que devuelve el Apps Script |
| `config.js` | URL del Apps Script y token |
| `Code.gs` | Backend (Google Apps Script). **No se sube a Vercel** |
| `vercel.json` | URLs limpias (`/profesor`, `/pantalla`) |

## Diseño por perfiles

Un perfil se activa con una clase en `<html>`: `theme-alumno` (iPad) o `theme-profesor` (iPhone). Todo el aspecto sale de variables CSS al principio de `styles.css`; el marcado usa colores semánticos (`bg-primary`, `text-ink-soft`, `bg-surface-alt`...), así que retocar la paleta es cambiar un valor en un solo sitio.

| | Alumno (iPad) | Profesor (iPhone) |
|---|---|---|
| Objetivo | Sencillo e intuitivo para 1.º a 6.º, incluido alumnado con TEA | Usabilidad y rapidez |
| `1rem` | 20 px | 15 px |
| Zona táctil mínima | 70 px | 45 px |
| Paleta | Crema suave, gris carbón, un único azul sereno, avisos en ámbar, sin rojo | Grises neutros, pizarra como único acento, verde/rojo solo para sumar/restar |
| Tipografía | Atkinson Hyperlegible | Sistema (SF) |
| Animaciones | Ninguna | Mínimas |

Decisiones del perfil alumno: un solo objetivo por pantalla; canjear en dos pasos (quién eres, elige tu premio) más confirmación; los premios bloqueados no son botones y muestran cuánto falta; el ranking mide contra el premio más caro, no contra el compañero que va primero; tras canjear se vuelve al paso 1; si los datos no cambian no se redibuja nada.

## Renderizado condicional (modular)

Sin `if/else` dentro de las plantillas. Cada decisión visual sigue el mismo patrón:

```js
// 1. Mapa { clave: componente }
const POINTS_VIEWS = { list: PointsList, ranking: PointsRanking, cards: PointsCards, vacio: EmptyView };
// 2. Función que recibe los datos, calcula la clave y resuelve el componente
function renderPointsView({ mode, alumnos }) {
  const key = alumnos.length ? mode : 'vacio';
  return resolve(POINTS_VIEWS, key, 'cards')({ alumnos });
}
```

Para añadir una variante (por ejemplo, un cuarto modo de vista o un tercer estado de premio) se escribe su componente y se registra en el mapa. Mapas actuales: vistas de puntos, tarjetas de premio (disponible/bloqueado), pasos de canje, pestañas, insignias de ranking, filas de alumno, insignias de cambio pendiente, filas del carrito, campos de edición, estados del botón Enviar, avisos, estados vacíos e indicador de conexión.

## Datos de prueba

`datos-prueba.json` tiene exactamente la forma de la respuesta de `doGet()`:

```json
{ "ok": true, "alumnos": [{ "id", "nombre", "icono", "puntos" }], "premios": [{ "id", "nombre", "coste", "icono" }] }
```

- 11 alumnos con puntos de 0 a 310 (hay un 0, un empate y uno con justo el precio del premio más barato).
- 6 premios: Algodoo 120, Scratch 160, Megaman Maker 180, Piskel 200, Lego 240, Subir de nivel en Lego 280.
- Todo múltiplo de 10. Con 2 días a la semana y 20 puntos como máximo por día, el premio más barato exige al menos 6 días (3 semanas).

Con `APPS_SCRIPT_URL` vacío en `config.js`, la app carga este JSON y guarda los cambios en el `localStorage` de cada dispositivo (iPhone e iPad no comparten datos en modo de prueba). En el carrito del profesor hay un interruptor para simular un fallo de red y un botón para restablecer los datos. Para ver la app en local hace falta un servidor (por ejemplo `npx serve`), porque `fetch` no funciona desde `file://`.

**Paso a producción:** rellena `APPS_SCRIPT_URL`. El frontend no cambia, porque el script devuelve la misma forma.

## Google Sheets (el ledger)

1. Crea una hoja de cálculo. **Extensiones, Apps Script**: pega `Code.gs` y cambia `TOKEN`.
2. Ejecuta **`setup`** una vez. Crea tres hojas con los mismos datos que `datos-prueba.json`:

| Hoja | Columnas |
|---|---|
| Alumnos | `id`, `nombre`, `icono`, `activo` |
| Premios | `id`, `nombre`, `coste`, `icono`, `activo` |
| Movimientos (ledger, solo se añaden filas) | `id`, `fecha`, `batchId`, `alumnoId`, `tipo`, `delta`, `nota`, `origen` |

- `icono` es el nombre de un icono de [Material Symbols](https://fonts.google.com/icons) en minúsculas con guion bajo (`pets`, `rocket_launch`...). Si el valor no es válido, la app usa un icono por defecto.
- `tipo`: `inicial`, `ajuste`, `reset` o `canje`. El saldo es la suma de `delta`.
- Para empezar con la clase real, borra las filas de ejemplo de las tres hojas y rellena Alumnos y Premios.

3. **Implementar, Nueva implementación, Aplicación web**: ejecutar como tú, acceso para cualquier usuario. Copia la URL `/exec` en `config.js` junto con el mismo `TOKEN`. Tras cada cambio en `Code.gs`, crea una versión nueva de la implementación.

## Vercel en menos de 5 minutos

- Con CLI: `npx vercel --prod` en la carpeta (framework *Other*, sin build).
- Con GitHub: sube la carpeta y *Add New, Project, Deploy*.
- URLs: `/profesor` y `/pantalla`.

## Consejos de uso

- iPhone: Safari, Compartir, **Añadir a pantalla de inicio**.
- iPad: igual, con **Acceso guiado** activado y bloqueo automático en *Nunca*.
- Los iconos y la tipografía se cargan de Google Fonts: la primera carga necesita conexión.
- El `TOKEN` viaja en el JavaScript del cliente: es solo una barrera básica. Mantén las URLs privadas y usa nombres de pila o apodos.
