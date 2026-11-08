# Puntos de clase

App web estática (HTML + Tailwind CDN + JavaScript vainilla) para gestionar puntos en clase. Iconos: Material Symbols (sin emojis).

| Archivo | Para qué sirve |
|---|---|
| `index.html` | Portada con acceso a los dos paneles |
| `profesor.html` + `profesor.js` | Panel del profesor (iPhone): motivos rápidos, ruleta, insignias, carrito y envío transaccional con rollback |
| `pantalla.html` + `pantalla.js` | Pantalla del iPad: Puntos (lista / ranking / tarjetas), Canjear y Reglas |
| `engine.js` | **Motor de cálculo** (saldos, rachas, reto, insignias, validación). Lo usan el modo de prueba y `Code.gs` |
| `ui.js` | Componentes compartidos y el helper `resolve()` del renderizado condicional |
| `shared.js` | Capa de API, almacenamiento y modo de prueba |
| `tailwind-config.js` + `styles.css` | **Tokens de diseño**: paleta, tamaños y radios por perfil |
| `datos-prueba.json` | Volcado de las pestañas de la hoja, con 16 días de clase simulados |
| `config.js` | URL del Apps Script y token |
| `Code.gs` | Backend (Google Apps Script). **No se sube a Vercel** |
| `vercel.json` | URLs limpias (`/profesor`, `/pantalla`) |

## Novedades de esta versión

| # | Función | Dónde |
|---|---|---|
| 1 | Tabla de reglas (suma y resta) | iPad, pestaña **Reglas**. Sale de la pestaña `ReglasYPremios` (`tipo = regla`) |
| 2 | Tienda de identidad | Premio con `efecto = personalizar`. Al canjearlo se abre el editor (dibujo y color). Se guarda en `Alumnos.avatar` y `Alumnos.color` |
| 3 | Rachas | Llama (`local_fire_department`) en las tarjetas desde 2 clases seguidas. Bonus automático cada `racha_hito` clases |
| 4 | Reto de clase | Barra común en Puntos. Meta y premio en `Config` |
| 6 | Insignias | Iconos junto a cada alumno. Las concede el profesor y son permanentes |
| 7 | Ruleta | iPhone, botón **Ruleta**. Sortea entre los seleccionados (o toda la clase) un bonus de `ruleta_bonus` |
| 16 | Motivos rápidos | iPhone, fila de botones sobre el teclado numérico. Salen de `ReglasYPremios` |

Decisiones de diseño que conviene conocer:

- **Racha por días de clase.** Un día de clase es un día con algún movimiento de puntos de cualquier alumno. La racha son días de clase seguidos con saldo neto positivo del alumno. Un día de clase sin neto positivo la corta. Los fines de semana y festivos no cuentan.
- **El reto suma puntos ganados, no el saldo.** Gastar en premios no hace retroceder la barra. Cuenta desde `reto_desde` y solo alumnos activos.
- **Personalización = crédito.** Cada canje de un premio `personalizar` da un crédito. Cada guardado en el editor consume uno. Si el alumno cierra el editor con "Después", el crédito sigue y se le recuerda en Canjear.
- **Un solo cambio en la hoja, sin tocar código.** Reglas, premios, insignias y configuración viven en `ReglasYPremios` y `Config`. El iPad y el iPhone se actualizan en el siguiente refresco.

## Diseño por perfiles

Un perfil se activa con una clase en `<html>`: `theme-alumno` (iPad) o `theme-profesor` (iPhone). Todo el aspecto sale de variables CSS al principio de `styles.css`.

| | Alumno (iPad) | Profesor (iPhone) |
|---|---|---|
| Objetivo | Sencillo e intuitivo para 1.º a 6.º, incluido alumnado con TEA | Usabilidad y rapidez |
| `1rem` | 20 px | 15 px |
| Zona táctil mínima | 70 px | 45 px |
| Paleta | Crema suave, gris carbón, un único azul sereno, avisos en ámbar, sin rojo | Grises neutros, pizarra como único acento, verde/rojo solo para sumar/restar |
| Tipografía | Atkinson Hyperlegible | Sistema (SF) |
| Animaciones | Ninguna | Mínimas |

Los colores de identidad del alumno (azul, verde, rosa...) son pasteles suaves y solo tiñen su propia tarjeta.

## Renderizado condicional (modular)

Sin `if/else` dentro de las plantillas. Cada decisión visual: un **mapa** `{ clave: componente }`, una función que calcula la clave y `resolve(mapa, clave, reserva)`.

```js
const RETO_STATES = { activo: ..., logrado: ..., ninguno: () => '' };
const getRetoKind = (r) => (!r ? 'ninguno' : r.logrado ? 'logrado' : 'activo');
const renderReto = (r) => resolve(RETO_STATES, getRetoKind(r), 'ninguno')(r);
```

Mapas actuales: vistas de puntos, reto, rachas, insignias, tarjetas de premio, pasos de canje, efecto tras canjear, pestañas, grupos de reglas, filas del carrito (5 tipos), campos de edición, motivos, hoja de insignias, fases de la ruleta, estados del botón Enviar, avisos, estados vacíos e indicador de conexión.

## Carrito, localStorage y rollback (iPhone)

Todo lo que hace el profesor (motivos, +/-, a cero, ruleta, insignias) va al **carrito**, guardado en `localStorage` (`tp_prof_v3`). Al enviar:

1. Se toma un snapshot de alumnos y carrito.
2. Actualización optimista: saldos nuevos y carrito vacío al instante.
3. Si el servidor falla, **rollback** al snapshot y aviso. El `batchId` se conserva, así que reintentar no duplica movimientos (el ledger ignora un `batchId` ya escrito).
4. Si va bien, se sustituye el estado por el del servidor y se avisa de las bonificaciones de racha.

En el iPad, canjear y personalizar usan el mismo patrón (optimista, rollback, `localStorage` en `tp_pant_v3`). Si falla guardar la tarjeta, el editor sigue abierto y el crédito no se pierde.

## Datos de prueba

`datos-prueba.json` es un volcado de las pestañas: `alumnos`, `reglasYPremios`, `config`, `movimientos`. El modo de prueba calcula el estado con `engine.js`, igual que `Code.gs`.

- 11 alumnos, 16 días de clase simulados, 5 rachas activas, insignias repartidas y 3 alumnos ya personalizados. Mateo tiene una personalización pendiente.
- 9 reglas, 12 premios, 6 insignias y un reto de 1600 puntos.
- **Los costes de los premios son provisionales**: cámbialos en la pestaña `ReglasYPremios` (columna `puntos`).

Con `APPS_SCRIPT_URL` vacío, los cambios se guardan en el `localStorage` de cada dispositivo (iPhone e iPad no comparten datos en modo de prueba). En el carrito del profesor hay un interruptor para simular un fallo de red y un botón para restablecer los datos. Para verlo en local hace falta un servidor (`npx serve`): `fetch` no funciona desde `file://`.

## Google Sheets

1. Crea una hoja de cálculo. **Extensiones, Apps Script**: pega `Code.gs` y cambia `TOKEN`.
2. Ejecuta **`setup`** una vez. Crea cuatro pestañas con los datos de ejemplo. Si ya tenías pestañas de la versión anterior (`Alumnos`, `Premios`, `Movimientos`), **bórralas o renómbralas antes**: `setup` no sobrescribe pestañas con contenido.

| Pestaña | Columnas |
|---|---|
| `Alumnos` | `id`, `nombre`, `avatar`, `color`, `activo` |
| `ReglasYPremios` | `id`, `tipo`, `nombre`, `puntos`, `icono`, `efecto`, `descripcion`, `activo` |
| `Config` | `clave`, `valor` |
| `Movimientos` (ledger, solo se añaden filas) | `id`, `fecha`, `batchId`, `alumnoId`, `tipo`, `delta`, `nota`, `origen`, `ref` |

**Alumnos**: `avatar` es un icono de [Material Symbols](https://fonts.google.com/icons) (`pets`, `rocket_launch`...). `color` es uno de `base`, `azul`, `verde`, `turquesa`, `amarillo`, `naranja`, `rosa`, `violeta`, `arena`. Vacío = `base`. Si el valor no es válido se usa uno por defecto.

**ReglasYPremios**: la columna `tipo` decide qué es cada fila.

| `tipo` | `puntos` | Otras columnas |
|---|---|---|
| `regla` | Lo que suma (positivo) o resta (negativo) | `icono`, `descripcion`. Sale en la tabla del iPad y como motivo rápido en el iPhone |
| `premio` | Coste | `icono`. `efecto = personalizar` abre el editor de tarjeta al canjearlo |
| `insignia` | Vacío | `icono`, `descripcion` (para qué se concede) |

`activo` en `FALSE` oculta la fila sin borrar el historial.

**Config** (todas opcionales; si falta una se usa el valor por defecto):

| `clave` | Ejemplo | Qué hace |
|---|---|---|
| `racha_hito` | `5` | Cada cuántas clases seguidas se da el bonus |
| `racha_bonus` | `10` | Puntos del bonus |
| `reto_nombre`, `reto_meta`, `reto_premio`, `reto_icono` | `Reto de clase`, `1600`, `Un rato de juego libre`, `flag` | Reto cooperativo. Sin `reto_meta`, no hay reto |
| `reto_desde` | `2026-11-01` | Desde qué fecha cuentan los puntos para el reto. Para empezar un reto nuevo, cambia la fecha |
| `ruleta_bonus` | `5,10,20` | Bonus posibles de la ruleta |
| `avatares`, `colores` | lista separada por comas | Opciones del editor de tarjeta (por defecto, 24 dibujos y 9 colores) |

**Movimientos**: `tipo` puede ser `inicial`, `ajuste`, `ruleta`, `racha`, `reset`, `canje`, `insignia` o `perfil`. El saldo es la suma de `delta`. No edites esta pestaña a mano: la app solo añade filas.

3. **Implementar, Nueva implementación, Aplicación web**: ejecutar como tú, acceso para cualquier usuario. Copia la URL `/exec` en `config.js` junto con el mismo `TOKEN`. Tras cada cambio en `Code.gs`, crea una versión nueva de la implementación.

> `Code.gs` lleva incrustado `engine.js` entre `// ===== MOTOR:INICIO =====` y `// ===== MOTOR:FIN =====`. Si cambias el motor, copia el mismo bloque en ambos sitios.

## Vercel en menos de 5 minutos

- Con CLI: `npx vercel --prod` en la carpeta (framework *Other*, sin build).
- Con GitHub: sube la carpeta y *Add New, Project, Deploy*.
- URLs: `/profesor` y `/pantalla`.

## Consejos de uso

- iPhone: Safari, Compartir, **Añadir a pantalla de inicio**.
- iPad: igual, con **Acceso guiado** activado y bloqueo automático en *Nunca*.
- Los iconos y la tipografía se cargan de Google Fonts: la primera carga necesita conexión.
- El `TOKEN` viaja en el JavaScript del cliente: es solo una barrera básica. Mantén las URLs privadas y usa nombres de pila o apodos.
