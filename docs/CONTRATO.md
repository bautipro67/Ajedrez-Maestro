# CONTRATO DE ARQUITECTURA — Ajedrez Maestro (en ingles: Master Chess)

Este documento es **normativo**. Todo modulo debe respetarlo al pie de la letra: varios
agentes escriben modulos en paralelo y solo encajan si las firmas y convenciones coinciden.

## 0. Reglas globales

- **ES modules** (`import`/`export`) en TODOS los archivos. `package.json` ya tiene `"type":"module"`.
- **Cero dependencias npm.** Nada de `require`, nada de paquetes externos, nada de CDNs.
- `web/js/chess.js`, `web/js/eval.js`, `web/js/engine.js`, `web/js/book.js`, `web/js/bots.js`,
  `web/js/elo.js`, `web/js/tournament.js`, `web/js/pgn.js` son **agnosticos del entorno**:
  NO pueden tocar `document`, `window`, `localStorage`, `fetch` ni `alert`. Deben poder
  importarse tal cual desde Node (el servidor los usa) y desde un Web Worker.
- Idioma: **identificadores y comentarios de codigo en ingles**; **todo texto visible al
  usuario en espanol** (bios de bots, frases, nombres de aperturas, etiquetas).
- Sin `console.log` en modulos de produccion (salvo el servidor y los tests).
- Estilo: 2 espacios de indentacion, comillas simples, punto y coma al final.
- Cada archivo empieza con un comentario de bloque de 2-6 lineas describiendo su rol.
- Nada de `eval`, `new Function`, ni `innerHTML` con datos no confiables.

## 1. Representacion del tablero (chess.js) — OBLIGATORIA

Tablero **0x88**: `Int8Array(128)`.
- `sq = (rank << 4) | file`, con `rank 0 = fila 1` (bando blanco) y `file 0 = columna a`.
- `a1 = 0`, `h1 = 7`, `a8 = 112`, `h8 = 119`.
- `(sq & 0x88) === 0` <=> casilla dentro del tablero.

Codigos de pieza: `piece = type | (color << 3)`.

```
EMPTY = 0
PAWN = 1, KNIGHT = 2, BISHOP = 3, ROOK = 4, QUEEN = 5, KING = 6
WHITE = 0, BLACK = 1
// blanco: peon 1 ... rey 6 ; negro: peon 9 ... rey 14
```
`pieceType(pc) === (pc & 7)`, `pieceColor(pc) === (pc >> 3)`. A `EMPTY` nunca se le pregunta el color.

### Codificacion de jugada (entero de 32 bits)

```
bits  0..7   from   (casilla 0x88)
bits  8..15  to     (casilla 0x88)
bits 16..18  promo  (0 = ninguna, si no KNIGHT|BISHOP|ROOK|QUEEN)
bits 19..23  flags
  FLAG_CAPTURE = 1 << 19
  FLAG_EP      = 1 << 20
  FLAG_DOUBLE  = 1 << 21   (avance doble de peon)
  FLAG_CASTLE  = 1 << 22   (enroque; `to` es la casilla final del REY: g1/c1/g8/c8)
```
Una jugada real valida nunca vale 0 (el valor 0 significa "sin jugada").

### Objeto Position (objeto plano, no clase)

```js
{
  board: Int8Array(128),
  turn: 0 | 1,
  castling: 0..15,          // 1=WK(blancas corto) 2=WQ 4=BK 8=BQ
  ep: -1 | square,          // casilla de captura al paso disponible
  halfmove: number,         // regla de 50 jugadas (ply sin captura ni peon)
  fullmove: number,         // empieza en 1
  kingSq: Int8Array(2),     // [casillaReyBlanco, casillaReyNegro]
  keyLo: number,            // zobrist 32 bits bajos (entero sin signo >>> 0)
  keyHi: number,            // zobrist 32 bits altos
  undoStack: [],            // gestionado por makeMove/unmakeMove
  repLo: [],                // historial de keyLo por ply (para repeticion)
  repHi: []
}
```

## 2. API de `web/js/chess.js`

```js
// constantes
export const WHITE, BLACK, EMPTY, PAWN, KNIGHT, BISHOP, ROOK, QUEEN, KING;
export const FLAG_CAPTURE, FLAG_EP, FLAG_DOUBLE, FLAG_CASTLE;
export const START_FEN; // 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'

// helpers de pieza / casilla / jugada
export function pieceType(pc);
export function pieceColor(pc);
export function squareName(sq);            // 0 -> 'a1'
export function parseSquare(name);         // 'a1' -> 0, invalida -> -1
export function sqRank(sq); export function sqFile(sq);   // 0..7
export function encodeMove(from, to, promo, flags);
export function moveFrom(m); export function moveTo(m);
export function movePromo(m); export function moveFlags(m);
export function isCapture(m); export function isEnPassant(m);
export function isCastle(m);  export function isDoublePush(m);

// posicion
export function createPosition(fen = START_FEN);   // nueva Position
export function setFen(pos, fen);                  // muta pos; lanza Error si la FEN es invalida
export function getFen(pos);                       // FEN completa de 6 campos
export function clonePosition(pos);                // copia profunda e independiente

// generacion
export function generateMoves(pos, opts = {});
//   opts.legal    (default true)  -> solo jugadas legales
//   opts.captures (default false) -> solo capturas, al paso y promociones
//   devuelve un Array<number> de jugadas
export function isSquareAttacked(pos, sq, byColor);
export function inCheck(pos, color = pos.turn);

// ejecucion
export function makeMove(pos, move);   // muta pos, apila en undoStack, devuelve el undo
export function unmakeMove(pos);       // desapila y revierte; devuelve la jugada revertida
export function makeNullMove(pos);     // para null-move pruning (no valida)
export function unmakeNullMove(pos);

// notacion
export function moveToSan(pos, move);  // SAN ANTES de ejecutar la jugada; incluye '+' y '#'
export function sanToMove(pos, san);   // tolerante (acepta Nf3, O-O, 0-0, exd5, e8=Q+); -1 si no existe
export function moveToUci(move);       // e2e4, e7e8q
export function uciToMove(pos, uci);   // -1 si no es legal en pos

// estado de la partida
export function isInsufficientMaterial(pos);
export function repetitionCount(pos);  // cuantas veces aparecio la posicion actual (1 = primera)
export function gameResult(pos);
//   -> { over, winner: WHITE|BLACK|null,
//        reason: 'checkmate'|'stalemate'|'fifty'|'repetition'|'insufficient'|null,
//        text: string /* en espanol */ }

export function perft(pos, depth);     // conteo de nodos, para tests
```

Zobrist: tablas deterministas generadas con un PRNG sembrado (xorshift con semilla fija) para
que cliente y servidor obtengan siempre las mismas claves. `makeMove` actualiza `keyLo/keyHi`
de forma incremental.

## 3. API de `web/js/pgn.js`

```js
export function buildPgn({ headers, sanMoves, result, clocks });
//   headers: {Event, Site, Date, Round, White, Black, Result, WhiteElo, BlackElo, TimeControl, ...}
//   sanMoves: string[]   result: '1-0'|'0-1'|'1/2-1/2'|'*'
//   clocks: string[]|null (opcional, emite comentarios %clk)
export function parsePgn(text);
//   -> { headers, sanMoves, result }  (soporta comentarios {...}; variantes y NAGs se ignoran)
export function pgnToPositions(pgnText); // -> { headers, moves:number[], finalFen }
```

## 4. API de `web/js/eval.js`

```js
export const PIECE_VALUES;      // {1:100, 2:325, 3:335, 4:500, 5:975, 6:0}
export const DEFAULT_WEIGHTS;
export function evaluate(pos, weights = DEFAULT_WEIGHTS);
//   centipeones DESDE EL PUNTO DE VISTA DEL BANDO QUE MUEVE (convencion negamax)
export function gamePhase(pos);           // 0 (final puro) .. 256 (apertura)
export function seeCapture(pos, move);    // Static Exchange Evaluation en centipeones
export function evaluateVerbose(pos, weights); // -> {total, material, pst, mobility, ...} para el panel
```

`DEFAULT_WEIGHTS` (multiplicadores 0..2 salvo indicacion):

```js
{
  material: 1.0,        // escala de los valores de pieza
  pst: 1.0,             // tablas pieza-casilla (eval tapered mg/eg)
  mobility: 1.0,
  kingSafety: 1.0,
  pawnStructure: 1.0,   // doblados, aislados, retrasados
  passedPawns: 1.0,
  bishopPair: 1.0,
  rookFiles: 1.0,       // torres en columna abierta / 7a fila
  centerControl: 1.0,
  development: 1.0,     // penaliza piezas menores sin desarrollar en apertura
  aggression: 1.0,      // bonus por atacar la zona del rey enemigo
  materialism: 1.0,     // >1 codicioso, <1 mas dispuesto a sacrificar
  contempt: 0           // centipeones de desprecio por las tablas
}
```

La evaluacion debe ser **tapered** (interpolacion apertura/final) y simetrica: la misma
posicion con los colores invertidos debe dar el valor opuesto.

## 5. API de `web/js/engine.js`

```js
export function createSearcher(options = {});  // {ttSizeMb: 16}
// searcher.search(pos, limits) -> SearchResult   (sincrono; corre dentro de un Web Worker)
// searcher.searchRoot(pos, limits) -> { moves: [{move, score, pv}], ...SearchResult }
//    moves ORDENADAS de mejor a peor, con la puntuacion de CADA jugada legal de la raiz
//    (necesario para que los bots elijan jugadas humanas).
// searcher.stop()        -> corta la busqueda en curso
// searcher.clearTables() -> limpia TT/killers/history (nueva partida)
```

`limits`:
```js
{
  depth: 1..64,          // profundidad maxima (default 64)
  nodes: number,         // tope de nodos (default Infinity)
  timeMs: number,        // tope de tiempo (default 1000)
  weights: WeightsObj,   // personalidad
  evalNoise: 0,          // ruido en centipeones aplicado en la hoja (determinista via rng)
  rng: () => number,     // PRNG inyectado, obligatorio si evalNoise > 0
  useNullMove: true,
  useLmr: true,
  quiescence: true,      // los bots muy debiles la desactivan (ven menos)
  maxQDepth: 6
}
```

`SearchResult`:
```js
{ best, score /*cp desde el bando que mueve*/, mate: number|null,
  depth, seldepth, nodes, timeMs, pv: number[] }
```

Tecnicas requeridas: profundizacion iterativa, ventanas de aspiracion, tabla de transposicion
(Zobrist, reemplazo por profundidad), poda alfa-beta, null-move, LMR, futility en hojas,
ordenacion (TT > promociones > capturas por MVV/LVA+SEE > killers > history), busqueda de
quietud con SEE. Puntuaciones de mate: `MATE = 30000`, ajustadas por ply.
**Debe ser reentrante y no usar estado global entre instancias.**

## 6. API de `web/js/book.js`

```js
export function bookMove(pos, style, rng);
//   style: 'wide'|'sharp'|'solid'|'offbeat'|'none'  -> jugada (number) o -1
export function openingName(sanMoves);  // -> {eco, name /* en espanol */} o null
export const BOOK_LINES;
```
Minimo 120 lineas reales (8-12 jugadas) cubriendo: Espanola, Italiana, Siciliana (Najdorf,
Dragon, Sveshnikov, Alapin), Francesa, Caro-Kann, Escandinava, Pirc, Alekhine, Gambito de Dama
(aceptado/declinado), Eslava, Nimzoindia, India de Rey, Grunfeld, Inglesa, Reti, Londres,
Gambito de Rey, Escocesa, Vienesa, Philidor, Petrov, Benoni, Holandesa, Budapest, Ataque Indio
de Rey. Mas ~60 nombres ECO para `openingName`.
El libro se valida contra `chess.js`: toda linea debe ser legal (hay un test que lo comprueba).

## 7. API de `web/js/bots.js`

```js
export const BOTS;        // >= 24 personajes ORIGINALES (no copiar los de chess.com)
export function botById(id);
export function botsByTier();             // agrupados para la UI
export function strengthProfile(elo);     // curva elo -> limites de motor
export function chooseBotMove(rootMoves, profile, rng, ctx);
export function botLine(bot, event, rng); // frase en espanol
//   event: 'greeting'|'win'|'lose'|'draw'|'blunder'|'check'|'brilliant'|'thinking'
```

Cada bot:
```js
{
  id: 'kebab-case',
  name: 'Nombre visible',
  elo: 250..2900,
  title: null|'CM'|'FM'|'IM'|'GM',
  country: 'AR',          // ISO-2 para la bandera
  emoji: '🐣',
  avatar: { bg:'#hex', fg:'#hex', face:'...' },  // datos para el avatar SVG generado
  tagline: 'frase corta en espanol',
  bio: '1-2 frases en espanol con personalidad',
  style: 'agresivo'|'posicional'|'tactico'|'caotico'|'solido'|'materialista'|'romantico'|'tecnico',
  weights: { /* override parcial de DEFAULT_WEIGHTS */ },
  strength: { /* override parcial de strengthProfile(elo) */ },
  book: 'wide'|'sharp'|'solid'|'offbeat'|'none',
  favoriteOpenings: ['Gambito de Rey'],
  lines: { greeting:[], win:[], lose:[], draw:[], blunder:[], check:[], brilliant:[], thinking:[] }
}
```

`strengthProfile(elo)` devuelve:
```js
{ depth, nodes, timeMs, evalNoise, blunderRate, tacticalBlindness, temperature,
  quiescence, maxQDepth, thinkMs:[min,max] }
```
Modelo de fuerza (lo importante para que se sientan humanos):
- `temperature`: seleccion softmax sobre las puntuaciones de la raiz. Alta = elige peores jugadas.
- `blunderRate`: probabilidad por jugada de elegir deliberadamente una jugada mala pero **no**
  absurda (colgar una pieza de forma humana, ignorar una amenaza, un peon pasivo).
- `tacticalBlindness`: probabilidad de ignorar tacticas de 2+ jugadas (limitar esa jugada
  concreta a profundidad 1-2 y desactivar la quietud).
- Los bots de <800 deben tener sesgo humano: les atraen las capturas, sacan la dama pronto,
  mueven peones de torre, dan jaques inutiles.
- `chooseBotMove` recibe `rootMoves` (ya con score) y devuelve UNA jugada. Determinista dado `rng`.
- `ctx`: `{ pos, moveNumber, myColor, inCheck, materialDiff, phase }` para los sesgos humanos.

Distribucion de Elo sugerida (24+ bots): 250, 400, 550, 700, 850, 1000, 1150, 1300, 1400, 1500,
1600, 1700, 1800, 1900, 2000, 2100, 2200, 2350, 2500, 2650, 2800, 2900 + 3-4 "especiales"
(solo gambitos, hiper-defensivo, uno que evita capturar). Personajes variados y memorables:
edades, paises, oficios, manias. Todo original.

## 8. API de `web/js/elo.js`

```js
export function expectedScore(ratingA, ratingB);
export function kFactor(rating, gamesPlayed);   // 40 provisional (<30 partidas), 20, 10 (>=2400)
export function applyResult(ratingA, ratingB, scoreA, opts = {});
//   -> { a, b, deltaA, deltaB }   scoreA: 1 | 0.5 | 0
export function performanceRating(opponentRatings, score);
export function ratingTier(elo);
//   -> { key, name /*espanol*/, color, icon, min, max }
//      Novato, Principiante, Intermedio, Avanzado, Experto, Maestro, Gran Maestro, Leyenda
export function ratingHistoryStats(history); // -> {peak, low, current, delta7d, winRate, streak}
export function provisionalRd(gamesPlayed);
export function glicko2Update(player, results);
```

## 9. API de `web/js/tournament.js`

```js
export function createTournament(config);
//   config: { id, name, format:'swiss'|'roundrobin'|'knockout'|'arena', rounds,
//             players:[{id,name,elo,isHuman,botId}], timeControl:{base,inc},
//             doubleRound:false, seed:number }
export function nextRound(t);        // -> [{id, white, black, round}] ('bye' = black null)
export function reportResult(t, gameId, result); // '1-0'|'0-1'|'1/2-1/2'
export function standings(t);
//   -> [{ playerId, name, elo, points, played, wins, draws, losses, buchholz,
//         sonnebornBerger, performance, ratingChange, rank }]  con desempates aplicados
export function isFinished(t);
export function tournamentSummary(t); // -> {champion, podium, prizes, rounds}
export function serialize(t); export function deserialize(obj);
```
Suizo: emparejamiento por grupos de puntuacion, sin repetir rivales, equilibrando colores, bye
al jugador con menos puntos que aun no lo tuvo. Knockout: bracket con potencias de 2 (byes para
los mejores cabezas de serie). Round-robin: algoritmo del circulo (Berger).

## 10. Servidor (`server/server.js` + `server/ws.js`)

- **Cero dependencias.** `server/ws.js` implementa RFC 6455 a mano sobre `node:http`
  (handshake `Sec-WebSocket-Accept` con `node:crypto`, framing, ping/pong, close, fragmentacion,
  desenmascarado del cliente, mensajes de texto hasta 1 MB).
- `server/server.js`: sirve `web/` como estatico (MIME correctos, `.js` -> `text/javascript`) en
  `http://localhost:PORT` (env `PORT`, default 8080) y atiende WebSocket en la ruta `/ws`.
- Valida CADA jugada con `web/js/chess.js` (lo importa directamente). El servidor es la
  autoridad: reloj, legalidad y resultado.
- Persistencia en `server/data/*.json` (escritura atomica: tmp + rename).

### Protocolo (JSON por mensaje, campo `t` = tipo)

Cliente -> Servidor:
```
{t:'hello', name, token?}
{t:'lobby'}
{t:'create', tc:{base,inc}, rated, color:'w'|'b'|'random', private?}
{t:'join', gameId}
{t:'quick', tc:{base,inc}, rated}        -> emparejamiento por Elo (+-200 ampliandose)
{t:'cancelQuick'}
{t:'move', gameId, uci, clientClock}
{t:'resign', gameId} {t:'drawOffer', gameId} {t:'drawAccept', gameId} {t:'drawDecline', gameId}
{t:'rematch', gameId} {t:'chat', gameId, text} {t:'watch', gameId} {t:'leave', gameId}
{t:'leaderboard'} {t:'ping', ts}
```
Servidor -> Cliente:
```
{t:'welcome', you:{id,name,token,rating:{bullet,blitz,rapid,classical},games}}
{t:'lobby', games:[{id, host, hostRating, tc, rated, created}]}
{t:'gameStart', game:{id, white:{id,name,rating}, black:{...}, tc, rated, fen}}
{t:'move', gameId, uci, san, fen, clocks:{w,b}, moveNumber}
{t:'gameOver', gameId, result, reason /*espanol*/, ratings:{white:{before,after,delta}, black:{...}}}
{t:'chat', gameId, from, text, ts}
{t:'drawOffer', gameId, from} {t:'drawDeclined', gameId}
{t:'opponentGone', gameId, secondsLeft} {t:'opponentBack', gameId}
{t:'leaderboard', top:[{name, rating, games}]}
{t:'error', code, message /*espanol*/}
{t:'pong', ts}
```
Reglas: reloj autoritativo del servidor (descuenta al recibir la jugada, suma el incremento),
bandera caida -> derrota (salvo material insuficiente del rival -> tablas), desconexion -> 60 s
de gracia y luego derrota, reconexion por `token`, espectadores, ratings por control de tiempo
usando `elo.js`, sala privada por codigo de 5 letras.

## 11. Cliente / UI

Archivos (fase 2; aqui solo el contrato de datos): `web/index.html`, `web/css/style.css`,
`web/js/pieces.js`, `web/js/board.js`, `web/js/clock.js`, `web/js/storage.js`, `web/js/sound.js`,
`web/js/online.js`, `web/js/worker.js`, `web/js/app.js`, `web/js/ui/*.js`.

- `web/js/worker.js` es un **module worker**: recibe `{id, type:'search', fen, limits}` y responde
  `{id, type:'result', ...SearchResult, rootMoves:[...]}`. Tambien acepta `{type:'stop'}` y
  `{type:'newGame'}`.
- Estetica tipo chess.com: tema oscuro, tablero verde/crema, piezas vectoriales, panel lateral
  con lista de jugadas, relojes, avatares, barra de evaluacion, resaltados y animaciones.
- Toda la persistencia local pasa por `storage.js` (clave raiz `ajedrezMaestro.v1`).

## 12. Tests (`test/`)

Node puro, sin dependencias, con mini-runner propio (`test/harness.js` exporta `test(name, fn)`,
`assert`, `assertEqual`, y `run()` que imprime resultados y hace `process.exit(1)` si algo falla).

- `test/perft.test.js`: posiciones estandar (ver seccion 13).
- `test/rules.test.js`: SAN ida y vuelta, FEN ida y vuelta, enroques, al paso, promociones, mate,
  ahogado, 50 jugadas, repeticion, material insuficiente.
- `test/engine.test.js`: mate en 1 y en 2, no cuelga piezas gratis, simetria de la evaluacion,
  la busqueda respeta los limites de nodos/tiempo.
- `test/book.test.js`: todas las lineas del libro son legales.
- `test/elo.test.js`, `test/tournament.test.js`: propiedades del sistema.
- `test/run-tests.js` importa y ejecuta todos.

## 13. Valores de referencia perft (obligatorio que coincidan)

```
startpos:  d1=20 d2=400 d3=8902 d4=197281 d5=4865609
Kiwipete   r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq -
           d1=48 d2=2039 d3=97862 d4=4085603
pos3       8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - -
           d1=14 d2=191 d3=2812 d4=43238 d5=674624
pos4       r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq -
           d1=6 d2=264 d3=9467 d4=422333
pos5       rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ -
           d1=44 d2=1486 d3=62379 d4=2103487
pos6       r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - -
           d1=46 d2=2079 d3=89890 d4=3894594
```
