# CONTRATO DE INTERFAZ — Ajedrez Maestro (en ingles: Master Chess)

Complementa `docs/CONTRATO.md` (que sigue siendo normativo para el nucleo). Aqui se define la
capa visual y de aplicacion. Tambien es **normativo**.

## 0. Principios

- La app corre servida por `node server/server.js` en `http://localhost:8080`. **No** funciona con
  `file://` porque usa ES modules y un module worker: eso es esperado y correcto.
- Una sola pagina (`web/index.html`), enrutada por hash. Sin frameworks, sin build, sin CDNs.
- Todo el texto visible, en **espanol**. Identificadores y comentarios en ingles.
- Accesible: foco visible, navegacion por teclado en el tablero, `aria-label` en los controles,
  contraste AA. Responsive real: de 360 px (movil) a 2560 px.
- Nada de `innerHTML` con datos del usuario o del servidor (nombres, chat): usa `textContent`.

## 1. Sistema de diseno (va en `web/css/style.css`, como variables CSS en `:root`)

```
--bg:           #161512      fondo general
--surface:      #262421      paneles
--surface-2:    #312E2B      tarjetas / filas alternas
--surface-3:    #3A3734      hover
--border:       #45423E
--text:         #ECEAE7
--text-dim:     #A7A19B
--text-faint:   #6E6A66
--accent:       #81B64C      verde de accion (botones primarios)
--accent-hover: #94CC5B
--accent-dim:   #5D8837
--info:         #4A90D9
--danger:       #C74B4B
--warn:         #E0A030
--gold:         #E8C14E
--board-light:  #EBECD0
--board-dark:   #739552
--hl-last:      rgba(255, 214, 0, .38)     ultima jugada
--hl-select:    rgba(255, 214, 0, .55)     casilla seleccionada
--hl-legal:     rgba(0, 0, 0, .16)         punto de jugada legal
--hl-capture:   rgba(0, 0, 0, .16)         aro de captura
--hl-check:     radial-gradient(circle, #E4463B 0%, #E4463B 32%, transparent 72%)
--hl-premove:   rgba(140, 100, 220, .55)
--radius:       8px     --radius-lg: 14px
--shadow:       0 6px 24px rgba(0,0,0,.45)
--font: system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif
--font-mono: ui-monospace, 'Cascadia Code', Consolas, monospace
```

Temas de tablero seleccionables (objeto exportado por `board.js`): `verde` (por defecto),
`marron`, `azul`, `gris`, `madera`, `noche`. Cada uno define claro/oscuro.

Transiciones: 180 ms para el movimiento de piezas, 120 ms para hover. Respeta
`@media (prefers-reduced-motion: reduce)` desactivando animaciones.

## 2. `web/js/pieces.js`

```js
export const PIECE_SETS;        // ['clasico', 'moderno', 'unicode'] con nombre visible en espanol
export function pieceSvg(pieceCode, setName);  // pieceCode = entero de chess.js (1..14)
                                               // -> string SVG con viewBox '0 0 45 45'
export function pieceNode(pieceCode, setName); // -> Element listo para insertar (clonado de cache)
export function botAvatarSvg(bot, size);       // avatar generado a partir de bot.avatar + bot.emoji
export function userAvatarSvg(seed, size);     // avatar deterministico para el jugador humano
export function flagEmoji(countryCode);        // 'AR' -> bandera emoji
export function tierBadge(tier);               // -> string SVG/HTML de la insignia de categoria
```
Las piezas deben ser **vectoriales originales**, legibles a 40 px y a 120 px, con silueta clasica
(rey con cruz, dama con corona de puntas, alfil con mitra y corte, caballo con crin, torre con
almenas, peon esferico), relleno blanco `#F9F9F9` con borde `#3A3A3A` para las blancas y relleno
`#3A3A3A` con borde `#111` y detalle claro para las negras. El set 'unicode' usa los glifos
♔♕♖♗♘♙♚♛♜♝♞♟ como respaldo.

## 3. `web/js/board.js`

Habla en **nombres algebraicos** (`'e4'`), no en indices 0x88, para quedar desacoplado.

```js
export const BOARD_THEMES;
export function createBoard(container, opts);
// opts: { orientation:'white'|'black', pieceSet:'clasico', theme:'verde', coordinates:true,
//         interactive:true, showLegal:true, animationMs:180,
//         onMoveAttempt: (from, to) => boolean|Promise<boolean>,   // devuelve si fue aceptada
//         onPromotion: (from, to, color) => Promise<'q'|'r'|'b'|'n'|null>,
//         onSquareClick: (sq) => void,
//         onPremove: (from, to) => void }
```
Metodos del objeto devuelto:
```js
setPosition(fen, { animate = true, lastMove = null })   // lastMove: {from, to}
getOrientation() / setOrientation(c) / flip()
setInteractive(bool) / setMovableColor('white'|'black'|'both'|'none')
setLegalMoves(map)          // Map<from, string[]> de destinos, para resaltar y validar el arrastre
markCheck(square|null)
highlight(squares, kind)    // kind: 'last'|'select'|'premove'|'custom'
clearHighlights(kind?)
drawArrow(from, to, color) / clearArrows()
setPremove(from, to) / clearPremove()
shake(square)               // feedback de jugada ilegal
spawnConfetti()             // al ganar
resize() / destroy()
setPieceSet(name) / setTheme(name) / setCoordinates(bool)
```
Interaccion obligatoria: arrastrar y soltar con puntero (mouse + tactil, `setPointerCapture`),
clic-origen + clic-destino, teclado (flechas mueven un cursor, Enter selecciona), pieza fantasma
translucida en el origen mientras se arrastra, la pieza arrastrada sigue al cursor centrada y se
agranda un 5%, casillas legales con punto central (o aro si hay captura), soltar fuera = cancelar,
dialogo de promocion flotante sobre la casilla de destino con las 4 piezas, premovimiento en
partidas con reloj. El tablero nunca decide legalidad por si mismo: pregunta con `onMoveAttempt`.

## 4. `web/js/clock.js`

```js
export function createClock({ base, inc, onTick, onFlag });  // base e inc en segundos
// metodos: start(color), pause(), resume(), switchTo(color), press(color) (jugada hecha: resta y
// suma incremento), getTimes() -> {w, b} en ms, setTimes({w,b}), addTime(color, ms),
// isRunning(), destroy()
// onTick(times) se llama cada 100 ms; onFlag(color) una sola vez.
```
Usa `performance.now()` y calcula por diferencia real (nunca acumules restas de intervalos).
Debe seguir siendo exacto si la pestana pasa a segundo plano.

Formato: `formatClock(ms)` -> `'5:03'`, `'0:09.4'` cuando quedan menos de 20 s, `'1:05:00'` si hay horas.

## 5. `web/js/storage.js`

Raiz en `localStorage` bajo la clave `ajedrezMaestro.v1`. Todo pasa por aqui; ningun otro modulo
toca `localStorage` directamente. Si `localStorage` no esta disponible, degrada a memoria sin romper.

```js
export function loadProfile(); export function saveProfile(p); export function defaultProfile();
export function loadSettings(); export function saveSettings(s);
export function saveGame(game); export function loadGames(limit); export function deleteGame(id);
export function saveTournament(t); export function loadTournaments(); export function deleteTournament(id);
export function recordResult({ mode, category, opponent, result, ratingBefore, ratingAfter, pgn, ts });
export function exportAll(); export function importAll(jsonString); export function resetAll();
```

Perfil:
```js
{
  version: 1, id, name: 'Invitado', avatarSeed, createdAt,
  ratings: {
    bullet:    { rating: 800, games: 0, rd: 350, history: [] },
    blitz:     { ... }, rapid: { ... }, classical: { ... }, bots: { ... }
  },
  stats: { wins:0, losses:0, draws:0, byBot:{}, currentStreak:0, bestStreak:0,
           bestWin:null, totalMoves:0, totalTimeMs:0 },
  achievements: [],   // ids desbloqueados
  defeatedBots: []    // ids de bots vencidos, para la galeria
}
```
`history` es un array de `{ ts, rating, delta, result, opponent, opponentRating }`.

Ajustes:
```js
{ pieceSet:'clasico', boardTheme:'verde', sound:true, volume:0.6, animations:true,
  showLegalMoves:true, showEvalBar:true, showCoordinates:true, autoQueen:false,
  confirmMove:false, highlightLastMove:true, showBotChat:true, premove:true }
```

## 6. `web/js/sound.js`

Sintetizado con WebAudio (nada de archivos). `AudioContext` creado en el primer gesto del usuario.
```js
export function initSound(settings); export function setEnabled(b); export function setVolume(v);
export function play(name);
// names: 'move','capture','check','castle','promote','gameStart','gameEnd','win','lose','draw',
//        'lowTime','notify','illegal','click','tenSeconds'
```
Cada sonido con envolvente corta (attack 3 ms, decay 60-180 ms), sin clics, y respetando el volumen.

## 7. `web/js/worker.js` + `web/js/ai.js`

`worker.js` es un **module worker** (`new Worker(url, {type:'module'})`) que importa `chess.js`,
`eval.js`, `engine.js`, `book.js` y `bots.js`. Mensajes:

```
-> { id, type:'botMove', fen, botId, history:[uci], moveNumber, seed, timeBudgetMs }
<- { id, type:'botMove', uci, san, score, mate, depth, nodes, elapsedMs,
     fromBook, bookName, rootMoves:[{uci, score}], thinkMs }
-> { id, type:'analyze', fen, depth, timeMs, multiPv }
<- { id, type:'analysis', lines:[{uci, pvUci:[], score, mate}], depth, nodes }
-> { id, type:'evalOnly', fen }        <- { id, type:'evalOnly', score }
-> { type:'stop' }                     -> { type:'newGame' }
<- { id, type:'error', message }
```
`thinkMs` es cuanto deberia "pensar" el bot antes de que la UI muestre la jugada (realismo humano);
el worker lo calcula pero **no** duerme: espera la UI.

`ai.js` (hilo principal) gestiona un pool de 1-3 workers y expone promesas:
```js
export function createAI({ workers = 1 });
// ai.botMove({ fen, botId, history, moveNumber, seed, timeBudgetMs }) -> Promise<resultado>
// ai.analyze({ fen, depth, timeMs, multiPv }) -> Promise<analisis>
// ai.evalOnly(fen) -> Promise<number>
// ai.stop(); ai.newGame(); ai.terminate(); ai.busy()
```
Si `Worker` no esta disponible, `ai.js` cae a ejecutar el motor en el hilo principal (mismo API).

## 8. `web/js/game.js` — sesion de partida (sin DOM)

Motor de estado comun a los cuatro modos. No toca el DOM ni el reloj visual.
```js
export function createGame(config);
// config: { mode:'bot'|'local'|'online'|'tournament', startFen, timeControl:{base,inc}|null,
//           white:{ kind:'human'|'bot', id, name, rating, botId }, black:{...}, rated }
```
Objeto devuelto:
```js
pos                       // Position de chess.js (no mutar desde fuera)
history                   // [{ uci, san, fenAfter, ms, clockAfter }]
status                    // { over, result:'1-0'|'0-1'|'1/2-1/2'|'*', reason, winner }
legalMovesMap()           // Map<'e2', ['e4','e3']> para el tablero
tryMove(from, to, promo)  // -> { ok, move, san } | { ok:false, reason }
playUci(uci)              // usado por online/bot
takeback(plies)           // solo en modos permitidos
resign(color); offerDraw(color); acceptDraw(); declineDraw(); claimDraw(); timeout(color)
setClockSnapshot({w,b})
getPgn(extraHeaders); getFen(); turn(); moveNumber()
on(event, cb)             // 'move' | 'over' | 'check' | 'drawOffer'
destroy()
```
Al terminar, `game.status.reason` usa las razones del contrato principal mas
`'resign'|'timeout'|'agreement'|'abandon'`. `game` produce siempre el texto en espanol via
`chess.gameResult` o su propia tabla.

## 9. `web/js/online.js`

Cliente del protocolo de la seccion 10 del contrato principal.
```js
export function createOnline({ url, onEvent });
// connect(name, token) ; disconnect() ; isConnected()
// lobby(), create(opts), join(id), quick(tc, rated), cancelQuick(), watch(id)
// move(gameId, uci), resign(id), offerDraw(id), acceptDraw(id), declineDraw(id),
// rematch(id), chat(id, text), leaderboard()
// onEvent(msg) recibe TODOS los mensajes del servidor tal cual.
```
Reconexion automatica con backoff exponencial (1 s, 2, 4, 8, max 15 s), cola de mensajes mientras
esta caido, indicador de latencia con ping cada 10 s. Si el WebSocket no conecta (la app se abrio
sin servidor), `online.js` debe reportarlo limpiamente y la UI ofrece los modos offline.

## 10. `web/js/app.js` y pantallas

`app.js` es el enrutador y el contenedor de estado. Rutas por hash:
```
#/                     inicio
#/bots                 seleccion de bot
#/jugar/bot/:botId     partida contra bot
#/jugar/local          partida local a dos
#/online               lobby online
#/jugar/online/:id     partida online
#/torneos              lista y creacion de torneos
#/torneo/:id           torneo en curso (clasificacion, emparejamientos, tu partida)
#/perfil               perfil, ratings, historial, logros
#/ajustes              ajustes
#/analisis             tablero de analisis libre (con barra de evaluacion y flechas del motor)
```
Contexto compartido que `app.js` pasa a cada pantalla:
```js
ctx = { navigate(route), profile, settings, saveProfile(), saveSettings(),
        ai, online, sound, toast(msg, kind), modal(opts), confirm(opts), t(key) }
```
Cada pantalla es un modulo en `web/js/ui/` que exporta
`export function mount(root, ctx, params)` y devuelve `{ unmount() }`.
Archivos: `ui/home.js`, `ui/botpicker.js`, `ui/gamescreen.js`, `ui/online.js`, `ui/tournaments.js`,
`ui/profile.js`, `ui/settings.js`, `ui/analysis.js`, `ui/components.js`.

`ui/components.js` exporta piezas reutilizables:
```js
export function el(tag, props, ...children);   // helper de creacion de nodos (usa textContent)
export function button(label, opts); export function icon(name);
export function modal({ title, body, actions, dismissable });
export function toast(message, kind);
export function playerCard({ name, rating, avatar, title, country, clock, captured, tier });
export function evalBar();      // -> { node, setScore(cp, mate) }
export function moveList();     // -> { node, setMoves(sans), setCurrent(i), onSelect(cb) }
export function ratingChart(history, opts);   // SVG de linea, sin librerias
export function ratingBadge(elo); export function spinner();
export function capturedPieces();  // -> { node, update(fen) } muestra material capturado y ventaja
```

## 11. Pantallas: contenido minimo exigido

**Inicio**: tablero decorativo animado o portada, tarjetas grandes de los modos (Online, Contra la
maquina, Local, Torneos, Analisis), resumen del perfil (rating por categoria, racha), y la ultima
partida con boton de revancha.

**Seleccion de bot**: rejilla de tarjetas con avatar, nombre, bandera, Elo, insignia de categoria,
eslogan y estado (vencido / no vencido, con trofeo). Filtro por tramo de fuerza y por estilo,
buscador por nombre. Al elegir, panel de configuracion: color (blancas/negras/azar), control de
tiempo (sin reloj, 1+0, 3+0, 3+2, 5+0, 10+0, 15+10, 30+0), partida puntuable o amistosa, y
ayudas (mostrar jugadas legales, deshacer permitido, pistas).

**Partida**: tablero centrado, barra de evaluacion opcional a la izquierda, panel derecho con las
dos tarjetas de jugador (avatar, nombre, Elo, reloj grande, piezas capturadas y ventaja material),
lista de jugadas en dos columnas navegable con clic y con las flechas del teclado, y controles:
rendirse, ofrecer tablas, deshacer (si aplica), pista, girar tablero, copiar PGN/FEN, nueva partida.
Burbujas de chat del bot con sus frases segun el evento. Al terminar: modal con resultado, cambio de
Elo animado, precision estimada de la partida, y botones de revancha / nuevo rival / analizar.

**Online**: estado de conexion, tu nombre y rating, boton de emparejamiento rapido por control de
tiempo, lista de partidas abiertas con Elo del anfitrion, crear partida, unirse por codigo privado,
clasificacion global y partidas en vivo para espectar.

**Torneos**: crear torneo (nombre, formato suizo/liga/eliminatoria/arena, numero de rondas, control
de tiempo, y seleccion del cuadro de bots: por tramo de Elo, aleatorio o a dedo), torneos guardados
en curso, y dentro de uno: cabecera con ronda actual, clasificacion completa con todos los
desempates, emparejamientos de la ronda, resultados de las partidas entre bots (simuladas en el
pool de workers, con progreso visible) y tu partida jugable. Al final, podio con trofeo y resumen.

**Perfil**: avatar y nombre editables, ratings por categoria con insignia y grafico de evolucion,
racha, mejor victoria, porcentaje de victorias, galeria de bots vencidos con sus trofeos, logros
desbloqueados, historial de partidas con PGN descargable, y exportar/importar todos los datos.

**Analisis**: tablero libre, cargar FEN/PGN, evaluacion en vivo con las mejores lineas del motor,
flechas de la mejor jugada, navegacion por la partida y clasificacion de cada jugada
(brillante / buena / imprecision / error / error grave) comparando la evaluacion antes y despues.

## 12. Logros (para `storage.js` y el perfil)

Al menos 20, con id, nombre en espanol, descripcion, icono y condicion verificable. Ejemplos:
primera victoria, vencer a un bot de 1500+, dar mate con caballo y alfil, ganar por tiempo,
promocionar a caballo y ganar, ganar un torneo, racha de 5, jugar 100 partidas, tablas por ahogado
a favor, mate del pastor, sacrificio de dama ganador, ganar con menos de 5 segundos en el reloj.
