# Notas de API — detalles reales de los módulos ya terminados

Addenda a `docs/CONTRATO.md` y `docs/CONTRATO-UI.md`. Cuando algo de aquí contradiga a los
contratos, **manda este archivo**: describe el código tal como quedó.

## elo.js (terminado, 20/20 tests)

- `applyResult(a, b, scoreA, opts)` — `opts`: `{gamesA, gamesB, peakA, peakB, kA, kB, floor}`.
  Devuelve `{a, b, deltaA, deltaB}`. Con el mismo K es de suma cero exacta.
- `kFactor(rating, gamesPlayed, peakRating)` — el tercer parámetro implementa el "haber alcanzado
  2400 alguna vez".
- `performanceRating(opponentRatings, score, opts)` — `opts.method: 'auto'|'fide'|'linear'`.
  Con menos de 5 partidas `auto` usa la regla lineal de 400.
- `ratingHistoryStats(history, opts)` devuelve `winRate` como fracción 0..1 **y** `winPercent`.
- `ratingTier(elo)` -> `{key, name, color, icon, min, max}`. Constante exportada: `RATING_TIERS`.
- `glicko2Update(player, results, opts)` verificado contra el ejemplo canónico de Glickman.
- Exporta también `RATING_FLOOR`, `PROVISIONAL_GAMES`, `MASTER_THRESHOLD`, `RD_MAX`, `RD_MIN`,
  `dpFromPercentage`, `provisionalRd`.

## tournament.js (terminado, 20/20 tests)

- Exporta además de lo pactado: `pendingGames(t)`, `FORMATS`, `RESULTS`, `tournamentPlayer(t, id)`.
- `nextRound(t)` **lanza error** si la ronda en curso tiene partidas sin resultado, y devuelve `[]`
  si el torneo ya terminó.
- `reportResult(t, gameId, result)` -> `{game, tiebreak, roundComplete, finished}`.
- En eliminatoria, unas tablas generan automáticamente la partida de muerte súbita con colores
  invertidos (y puede encadenarse). **El bucle de juego debe vaciar `pendingGames(t)` antes de
  pedir la ronda siguiente.**
- Puntos por bye: 1 en suizo y liga, 2 en arena. Nunca cuentan para rendimiento ni para Elo.
- `standings(t)` incluye `buchholz` (total) y `buchholzCut` (el que se usa como desempate).

## engine.js (terminado, 22/22 tests)

- Exporta `createSearcher`, más las constantes `MATE` (30000) y `MATE_BOUND` (29744).
- **La búsqueda trabaja sobre una copia de la posición**: `search`/`searchRoot` nunca tocan la
  `Position` que les pasás, y no hace falta clonarla antes de llamar.
- `searchRoot(pos, limits)` busca **cada jugada de raíz con ventana completa**, no con PVS, para
  que todas tengan una puntuación honesta y no un montón de empates en `alpha`. Los bots la
  necesitan así para el softmax. Se puede desactivar con `limits.exactRootScores: false`.
  `search(pos, limits)` sí usa PVS en la raíz (más rápido) y **no** devuelve `moves`.
- Entradas de `result.moves`: `{move, score, pv, mate}`, ordenadas de mejor a peor. `pv` siempre
  empieza por la jugada de esa entrada.
- `evalNoise`: el ruido **no** se saca llamando a `rng()` en cada hoja. De `limits.rng` se toma
  una única semilla al empezar y el ruido de cada hoja sale de mezclarla con la clave Zobrist de
  esa posición. Así la misma posición recibe siempre el mismo ruido dentro de una búsqueda (la
  tabla de transposición sigue siendo coherente) y la misma semilla replica la partida entera.
  Si `evalNoise > 0` y no hay `limits.rng`, **lanza `Error`**.
- `weights.contempt` se aplica en las tablas encontradas dentro de la búsqueda (repetición, 50
  jugadas, material insuficiente), con el signo visto desde el bando que buscó. Con `contempt: 0`
  las tablas valen `0` exacto (nunca `-0`).
- Entre búsquedas los killers se limpian y el historial se atenúa (`>> 3`) en vez de borrarse: la
  ordenación anterior sigue ayudando pero pesa menos. `clearTables()` sí lo borra todo.
- `depth` se recorta a 1..64 y la profundidad máxima real está limitada a 128 plies.
- La extensión de jaque puede hacer que `seldepth` supere bastante a `depth`; es normal.
- `seeCapture` de `eval.js` usa arrays de módulo reutilizados: es seguro porque todo es síncrono,
  pero **no llames al motor desde dentro de una evaluación**.

## book.js (terminado)

- En el fichero fuente cada línea guarda sus jugadas como **una cadena separada por espacios**
  (`sans: 'e4 c5 Nf3 d6 …'`), que ocupa mucho menos y se lee mejor. `BOOK_LINES` las expone ya
  troceadas en array y congeladas, así que quien consume el módulo no nota la diferencia.
- El índice se construye **la primera vez que se usa el libro**, recorriendo cada línea desde la
  posición inicial y anotando la jugada que sigue a cada posición **por su clave Zobrist**. Como
  la clave no depende del orden de jugadas, el libro **entiende las transposiciones**: llegar a la
  Siciliana por 1.Nf3 c5 2.e4 encuentra las mismas entradas que por 1.e4 c5 2.Nf3.
- El peso de una jugada es **cuántas líneas del libro la avalan**, así que las principales salen
  más a menudo sin necesidad de puntuarlas a mano.
- `bookMove(pos, style, rng)` devuelve `-1` **también cuando la posición está en el libro pero no
  hay nada del estilo pedido**. Es deliberado: un bot `sharp` prefiere salir del libro y pensar
  antes que jugar una línea que no es suya.
- Antes de devolver nada comprueba que la jugada esté en `generateMoves(pos)`: una colisión de
  clave Zobrist devolvería una jugada imposible.
- `openingName(sanMoves)` busca el **prefijo más largo** que coincida, mirando la tabla de nombres
  y además las propias líneas del libro (más específicas cuando la partida las siguió entera).
  Tolera que la partida se salga de la teoría: sigue nombrando la apertura por donde empezó.
- Exporta también `BOOK_STYLES`, `OPENING_NAMES` y `bookOptions(pos, style)` (cuántas jugadas
  distintas ofrece el libro ahí, útil para la UI de análisis).

## bots.js (terminado)

- `strengthProfile(elo)` devuelve **solo la curva base**. El merge con `bot.strength` lo hace ya
  `enginecore.js` (`mergedProfile`), así que **no lo repitas** al llamarla.
- Lo que de verdad regula la fuerza **no es la profundidad** sino el tope de nodos (de 200 a 1,2
  millones), el ruido en la evaluación y la temperatura. Un bot de 1500 tiene `depth: 9` pero
  `nodes: 12400`, que es lo que lo frena de verdad.
- La curva es **monótona por construcción** en los diez campos (hay un test que barre de 250 a
  2900 comprobándolo): más Elo nunca puede dar un bot más débil.
- `chooseBotMove(rootMoves, profile, rng, ctx)`:
  - Elige por **softmax sobre `score + sesgo humano`** con `profile.temperature` en centipeones.
  - El sesgo humano (`naive = temperature / 320`, o sea ~0 en los bots fuertes) premia capturas,
    jaques, sacar la dama antes de la jugada 8 y empujar peones de torre, y penaliza enrocar.
    Es lo que hace que un bot de 400 juegue como un principiante y no como un motor con ruido.
  - `blunderRate` elige a propósito una jugada mala **pero jugable**: solo entre las que pierden
    entre 90 y 650 centipeones. Nunca elige una jugada que valga menos de −20000, así que
    **ningún bot se mete a drede en un mate** por muy flojo que sea.
  - Para saber si una jugada da jaque hace `makeMove`/`unmakeMove` sobre `ctx.pos`: la posición
    queda **exactamente igual**, pero tiene que ser la posición real y no una copia a medias.
  - `tacticalBlindness` **no se usa aquí**: lo aplica `enginecore.js` bajando la profundidad y
    apagando la quietud antes de buscar.
- `botsByTier()` agrupa con `ratingTier` de `elo.js`, ordenado de flojo a fuerte, y dentro de cada
  tramo por Elo.
- Exporta también `BOT_EVENTS` (los ocho momentos en los que un bot habla).

## server/ws.js (terminado, 22 tests)

```js
const wss = createWebSocketServer({ server, path: '/ws', maxPayload: 1 << 20, heartbeatMs: 30000 });
wss.on('connection', (client, request) => { … });
// wss.clients (Set) · wss.broadcast(obj) · wss.close()
```
- `client.send(x)` serializa a JSON si no le das una cadena. `client.close(code, reason)` cierra
  limpio; `client.terminate()` corta en seco. Eventos: `message` (texto), `binary` (Buffer),
  `ping`, `pong`, `close(code, reason)`, `protocolError(code, reason)` y `error`.
- `client.data` es un objeto vacío pensado para que el servidor cuelgue ahí su estado.
- **`error` solo se emite si hay alguien escuchando.** Un `ECONNRESET` es rutina cuando a un
  cliente se le va la red, y `EventEmitter` lanza si nadie recoge `'error'`: eso tumbaba el
  proceso entero. Si querés enterarte, suscribite; si no, no pasa nada.
- `maxPayload` por defecto 1 MB; pasarse cierra con 1009. Texto no UTF-8 cierra con 1007, y los
  fallos de protocolo (sin enmascarar, bits RSV, opcode raro, control fragmentado) con 1002.
- `heartbeatMs: 0` desactiva el latido, que es lo que conviene en los tests.
- Exporta además `acceptKey`, `encodeFrame`, `encodeClose`, `createFrameParser` y `OPCODE`, que
  es lo que hace falta para escribir un cliente (ver `test/wsclient.js`).

## server/server.js (terminado, 17 tests)

Dos comportamientos que el contrato no menciona y conviene saber antes de escribir clientes:

- **El lobby mezcla partidas abiertas y en curso.** Las que ya se están jugando vienen marcadas
  con `live: true` y `status: 'playing'` (están ahí para poder mirarlas). Si tomás `games[0]` a
  ciegas acabás intentando entrar en una partida llena: filtrá por las que no lo llevan.
- **Las ofertas de tablas tienen freno.** `DRAW_OFFER_GAP_MS` (8 s) impide que el mismo bando
  insista; el segundo intento seguido responde `rateLimited`. Es anti-spam y está bien, pero hay
  que contarlo: la interfaz debería deshabilitar el botón esos segundos.
- La desconexión abre 60 s de gracia (`ABANDON_MS`) avisando al rival con `opponentGone` de
  inmediato y repitiendo la cuenta cada 15 s; volver con el mismo `token` devuelve tu identidad
  y dispara `opponentBack`.

## Pantallas (`web/js/ui/*.js`, terminadas)

- Las ocho cumplen `mount(root, ctx, params) -> { unmount() }`. `unmount()` **tiene** que quitar
  listeners de `window`/`document`, parar timers y destruir los tableros de `createBoard`.
- **Cuidado con el layout del tablero**: `.game-board-col` es una rejilla de dos columnas, 26 px
  para la barra de evaluación y el resto para `.board-stack`. La barra va **como hermana** de
  `.board-stack`, no dentro. Si no hay barra, hay que ponerle la clase `no-eval` a la columna.
  Metida por dentro, el tablero acaba midiendo 26 px y no se ve.
- `playerCard(player)` fija el nombre al construirse y **no tiene `setName`**: para cambiar de
  jugador hay que rehacer la tarjeta, no actualizarla.
- Utilidades de separación disponibles: `gap-4`, `gap-6`, `gap-16`, `gap-24`. **No existe `gap-8`.**

## Pruebas de interfaz (`test/domstub.js` + `test/screens.test.js`)

- `domstub.js` instala un DOM de mentira al importarlo (nodos, `classList`, `dataset`, `style`
  con `setProperty`, eventos, selectores simples, `localStorage`, `AudioContext`). No dibuja
  nada: sirve para ejecutar las pantallas de verdad fuera del navegador.
- `screens.test.js` monta las ocho y comprueba que importan, que `mount()` no revienta, que
  pintan algo, que **toda clase CSS que usan existe en style.css** y que `unmount()` no falla.
  Además verifica que el router de `app.js` no enrute ninguna pantalla que la suite no pruebe.
- Lo que **no** cubre: el aspecto. Un tablero de 26 px pasaba estos tests tan contento. Para eso
  hay que abrir la app y mirarla.

## board.js (terminado)

Cambio respecto al contrato de UI: `setLegalMoves(map)` recibe
`Map<'e2', Array<{to: 'e4', capture: boolean, promotion: boolean}>>`
(no un array de strings). El tablero necesita saber qué destino es captura para dibujar el aro y
cuál es promoción para abrir el diálogo.

Otros detalles útiles:
- `createBoard(container, opts)` devuelve también `el` (el `.board-wrap`), `overlay(node)`,
  `clearOverlay()`, `focus()`, `setShowLegal(bool)`, `setAnimationMs(ms)`, `getFen()`,
  `setLastMove({from,to})`, `clearSelection()`, `askPromotion(to, color)`.
- `opts.onMoveAttempt(from, to, promotion)` puede devolver una promesa; si resuelve a falso, el
  tablero sacude la pieza y la devuelve a su casilla.
- `opts.onPremove(from, to)` se llama cuando el usuario intenta una jugada que **no** está en
  `legalMoves`; si no pasás `onPremove`, ese intento simplemente sacude la pieza.
- `setPosition(fen, {animate, lastMove})` — `lastMove` acepta `{from, to, promotion}`; con
  `promotion` presente reutiliza la pieza del peón para que la animación sea continua.
- El botón derecho dibuja flechas y círculos de anotación (se borran con cualquier clic izquierdo).
- Marcadores de `markCheck(sq)`, `setPremove`, `drawArrow(from, to, color, width)`,
  `spawnConfetti(n)`.

## pieces.js (terminado)

`pieceSvg(pieceCode, setName)`, `pieceNode(...)`, `botAvatarSvg(bot, size)`,
`userAvatarSvg(seed, size)`, `flagEmoji(cc)`, `tierBadge(tier, size)`, `pieceLabel(pc)`,
`PIECE_SETS`, `PIECE_NAMES`. Sets disponibles: `clasico`, `moderno`, `unicode`.
`bot.avatar` puede traer `{bg, bg2}`; si no, el color sale del hash del id.

## clock.js (terminado)

`createClock({base, inc, delay, onTick, onFlag})` -> `start(color)`, `press(color)` (jugada hecha:
banca el tiempo, suma el incremento y pasa el turno), `pause()`, `resume(color)`, `stop()`,
`getTimes()`, `setTimes({w,b})`, `addTime(color, ms)`, `isRunning()`, `runningColor()`,
`isUntimed()`, `destroy()`. `base: 0` significa partida sin reloj (los tiempos son `Infinity`).
Exporta también `formatClock(ms)`, `TIME_CONTROLS`, `timeCategory(base, inc)`, `CATEGORY_NAMES`.

## sound.js (terminado)

`initSound(settings)`, `setEnabled`, `setVolume`, `isEnabled`, `play(name)` y el atajo
`playMoveSound({capture, castle, promotion, check, mate})`. Todo sintetizado con WebAudio.

## storage.js / achievements.js (terminados)

- `storage.recordResult({mode, category, opponent:{name,elo,botId}, result:'win'|'loss'|'draw',
  rated, pgn, sanMoves, facts, totalBots, tournamentWon, plies, timeMs})`
  -> `{ratingBefore, ratingAfter, delta, unlocked, profile, game}`.
  Ya aplica el Elo, actualiza estadísticas, galería de bots vencidos y logros. **La pantalla de
  partida no debe calcular el Elo por su cuenta: llama a esto.**
- `facts` es lo que devuelve `achievements.analyzeGame({sanMoves, myColor, endReason, winnerColor,
  finalFen, clockLeftMs, category, myElo, opponentElo, maxOwnQueens, sacrificedQueen,
  materialDiffAtEnd})`.
- Categorías de rating: `bullet`, `blitz`, `rapid`, `classical`, `bots`.
- `ACHIEVEMENTS` tiene 28 logros con `{id, name, icon, hint, check}`.
- Otras funciones: `loadProfile/saveProfile`, `loadSettings/saveSettings`, `saveGame/loadGames/
  getGame/deleteGame`, `saveTournament/loadTournaments/getTournament/deleteTournament`,
  `unlockAchievements`, `exportAll/importAll/resetAll`, `defaultProfile`, `defaultSettings`.

## CSS

`web/css/style.css` ya define el vocabulario completo de clases. **Usá esas clases en vez de
inventar nuevas o escribir estilos en línea.** Las principales:
`btn btn--primary|danger|ghost|sm|lg|block|icon`, `chip`, `card card__head card__body`,
`field field__label input select textarea switch switch__track range`,
`topbar topbar__nav topbar__link topbar__user`, `screen screen__head`,
`game-layout game-board-col board-stack game-panel`, `evalbar evalbar__white evalbar__label`,
`player-card player-card__avatar|name|meta|captured|adv`, `clock is-active is-low is-critical`,
`movelist movelist__row|num|move is-current nag--*`, `game-controls`, `bot-bubble`, `chat`,
`bot-grid bot-card bot-card__avatar|name|elo|tag|trophy`, `tier-chip`, `mode-grid mode-card`,
`table num is-me`, `result-badge--win|loss|draw`, `delta-pos|neg|zero`, `pairing bracket`,
`stat-grid stat stat__value|label`, `rating-chart`, `ach-grid ach ach__icon|name|hint`,
`trophy-grid trophy`, `conn-dot is-on|off|wait`, `lobby-row`, `spinner`, `searching`,
`modal-backdrop modal modal__head|title|body|actions`, `result-hero`, `toasts toast toast--err|
warn|achievement`, y utilidades `row col grow center between muted faint mono small tiny upper
truncate hidden sr-only h1 h2 h3`.
