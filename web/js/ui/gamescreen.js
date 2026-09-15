/**
 * ui/gamescreen.js — the board you actually play on, for all four modes.
 * It wires game.js (rules and result), board.js (interaction), clock.js (time)
 * and ai.js (the bots) together, keeps the side panel in sync and, when the
 * game ends, records the result through storage.js and shows the summary.
 */

import {
  el, clear, button, playerCard, evalBar, moveList, modal, confirmDialog,
  deltaSpan, spinner, formatDate,
} from './components.js';
import { createGame } from '../game.js';
import { ONLINE_ERRORS } from '../online.js';
import { uciToMove, moveToSan } from '../chess.js';
import { createBoard } from '../board.js';
import { createClock, TIME_CONTROLS, CATEGORY_NAMES, timeCategory, formatClock } from '../clock.js';
import { botById, botLine, eloOf } from '../bots.js';
import { recordResult, getTournament, saveTournament } from '../storage.js';
import { deserialize, serialize, reportResult, tournamentPlayer } from '../tournament.js';
import { analyzeGame, achievementById } from '../achievements.js';
import { accuracyFromLoss } from '../ai.js';
import { openingName } from '../book.js';
import { ratingTier, STARTING_RATING } from '../elo.js';

const COLOR_NAME = { w: 'blancas', b: 'negras' };

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms || 0)));
}

/** Deterministic PRNG so a seed replays the same bot chatter. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function timeControlById(id) {
  return TIME_CONTROLS.find((tc) => tc.id === id) || TIME_CONTROLS[0];
}

function humanPlayer(profile, category) {
  const bucket = profile?.ratings?.[category] || profile?.ratings?.bots;
  return {
    kind: 'human',
    name: profile?.name || 'Invitado',
    rating: bucket ? Math.round(bucket.rating) : STARTING_RATING,
    avatarSeed: profile?.avatarSeed || profile?.name || 'invitado',
  };
}

function botPlayer(bot) {
  return {
    kind: 'bot',
    botId: bot.id,
    name: bot.name,
    rating: eloOf(bot),
    title: bot.title || null,
    country: bot.country,
    isBot: true,
    emoji: bot.emoji,
    avatar: bot.avatar,
  };
}

export function mount(root, ctx, params = {}) {
  const mode = params.mode || 'local';
  const query = params.query || {};
  const settings = ctx.settings || {};

  let destroyed = false;
  const cleanups = [];

  clear(root);

  /* --------------------------- configuracion --------------------------- */

  let bot = null;
  let tournament = null;
  let tournamentGame = null;

  if (mode === 'bot') {
    bot = botById(params.botId);
    if (!bot) return fatal(root, ctx, 'No encuentro ese rival.', '#/bots', 'Elegir rival');
  }

  if (mode === 'online' && (!ctx.online || typeof ctx.onOnlineEvent !== 'function')) {
    return fatal(root, ctx,
      'No hay conexión con el servidor de partidas. Podés jugar contra la máquina, en local o un torneo.',
      '#/bots', 'Jugar contra la máquina');
  }

  /* De que color juega la persona. */
  let myColor = 'w';
  let tc = timeControlById(query.tc || 'sin-reloj');

  if (mode === 'bot') {
    if (query.color === 'black') myColor = 'b';
    else if (query.color === 'random') myColor = Math.random() < 0.5 ? 'w' : 'b';
  }

  if (mode === 'tournament') {
    const stored = getTournament(params.tournamentId);
    if (!stored) return fatal(root, ctx, 'Ese torneo ya no existe.', '#/torneos', 'Ver torneos');
    try {
      tournament = deserialize(stored);
    } catch {
      return fatal(root, ctx, 'Los datos de ese torneo están corruptos.', '#/torneos', 'Ver torneos');
    }
    tournamentGame = tournament.games.find((g) => g.id === params.gameId && g.result === null) || null;
    if (!tournamentGame) {
      return fatal(root, ctx, 'Esa partida del torneo ya no está pendiente.',
        `#/torneo/${params.tournamentId}`, 'Volver al torneo');
    }

    const whitePlayer = tournamentPlayer(tournament, tournamentGame.white);
    const blackPlayer = tournamentGame.black ? tournamentPlayer(tournament, tournamentGame.black) : null;
    if (!blackPlayer) {
      return fatal(root, ctx, 'Esa ronda te dio descanso: no hay partida que jugar.',
        `#/torneo/${params.tournamentId}`, 'Volver al torneo');
    }
    if (whitePlayer?.isHuman) {
      myColor = 'w';
      bot = botById(blackPlayer.botId);
    } else if (blackPlayer?.isHuman) {
      myColor = 'b';
      bot = botById(whitePlayer.botId);
    } else {
      return fatal(root, ctx, 'Esa partida es entre dos bots: se juega sola desde la pantalla del torneo.',
        `#/torneo/${params.tournamentId}`, 'Volver al torneo');
    }
    if (!bot) {
      return fatal(root, ctx, 'No encuentro al rival de esa partida.',
        `#/torneo/${params.tournamentId}`, 'Volver al torneo');
    }
    /* El control de tiempo lo manda el torneo, no la URL. */
    const base = tournament.timeControl?.base || 0;
    const inc = tournament.timeControl?.inc || 0;
    tc = { id: `${base}+${inc}`, label: `${base}+${inc}`, base, inc };
  }

  const category = mode === 'bot' ? 'bots' : timeCategory(tc.base, tc.inc);
  /* La partida empieza puntuable o no, pero puede DEJAR de serlo: pedir una
     pista o deshacer una jugada es ayuda del motor, y subir el Elo con eso
     seria hacerse trampas al solitario. */
  const ratedAtStart = mode === 'bot' ? query.rated !== '0' : false;
  let rated = ratedAtStart;
  /* En torneo no se deshace ni se piden pistas: falsearia la clasificacion. */
  const allowUndo = mode !== 'online' && mode !== 'tournament' && query.undo !== '0';
  const allowHints = mode !== 'online' && mode !== 'tournament' && query.hints !== '0';

  const me = humanPlayer(ctx.profile, category);
  const seedBase = (Date.now() ^ 0x9e3779b9) >>> 0;

  let game = null;
  let board = null;
  let clock = null;
  let session = null;
  let onlineRival = null;      // {name, elo} del rival online, para el historial
  let onlineRatings = null;    // el cambio de puntuacion que manda el servidor

  /* ------------------------------- layout ------------------------------- */

  const layout = el('div', { class: 'game-layout' });
  const boardCol = el('div', { class: 'game-board-col' });
  const stack = el('div', { class: 'board-stack' });
  const boardHost = el('div');
  const panel = el('aside', { class: 'game-panel' });
  const bubble = el('div', { class: 'bot-bubble hidden' });

  /* `.game-board-col` es una rejilla de dos columnas: la barra de evaluacion
     ocupa la primera (26 px) y `.board-stack` la segunda. Si no hay barra, la
     clase `no-eval` deja una sola columna. */
  /* La barra se construye siempre que el ajuste la pida, porque de ella sale
     la precision del resumen final. Pero NO se enseña donde ver en vivo si vas
     ganando seria ayuda del motor: en partida puntuable contra la maquina, en
     torneo, y sobre todo online, donde enfrente hay una persona que no la
     tiene. Suelta o local si, que ahi no falsea ningun resultado. */
  const ayudaFalsearia = ratedAtStart || mode === 'online' || mode === 'tournament';
  const bar = settings.showEvalBar !== false ? evalBar() : null;
  const showBar = bar !== null && !ayudaFalsearia;
  if (showBar) boardCol.appendChild(bar.node);
  else boardCol.classList.add('no-eval');
  stack.appendChild(boardHost);
  boardCol.appendChild(stack);
  layout.appendChild(boardCol);
  layout.appendChild(panel);
  root.appendChild(layout);

  /* Las tarjetas se rehacen en cada partida: `playerCard` fija el nombre al
     construirse, asi que no basta con crearlas una vez. */
  const topSlot = el('div');
  const bottomSlot = el('div');
  let topCard = null;
  let bottomCard = null;

  const moves = moveList({ onSelect: (index) => setView(index) });
  const controls = el('div', { class: 'game-controls' });
  const statusLine = el('p', { class: 'muted small' });
  const openingLine = el('p', { class: 'tiny faint' });
  const ratedChip = el('span', { class: 'chip' });

  panel.appendChild(topSlot);
  panel.appendChild(bubble);
  panel.appendChild(el('div', { class: 'row row--wrap gap-6' }, ratedChip, openingLine));
  panel.appendChild(moves.node);
  panel.appendChild(statusLine);
  panel.appendChild(controls);
  panel.appendChild(bottomSlot);

  /** Rebuilds both player strips for the current game and orientation. */
  function buildPlayerCards() {
    const showClock = tc.base > 0;
    const top = myColor === 'w' ? 'b' : 'w';
    const topPlayer = playerFor(top);
    const bottomPlayer = playerFor(myColor);

    /* Sin subtitulo: el eslogan del bot no cabe en un panel de 340 px y acaba
       estrujando el nombre hasta cortarlo. Para conocerlos esta la galeria. */
    topCard = playerCard({ ...topPlayer, subtitle: '' }, { showClock });
    bottomCard = playerCard({ ...bottomPlayer, subtitle: '' }, { showClock });

    clear(topSlot);
    clear(bottomSlot);
    topSlot.appendChild(topCard.node);
    bottomSlot.appendChild(bottomCard.node);
  }

  /* ------------------------------- estado ------------------------------- */

  let viewIndex = -2;          // -2 = en vivo; si no, indice de jugada mirada
  let thinking = false;
  let hintsLeft = allowHints ? 3 : 0;
  let evals = [];              // centipeones desde las blancas, para precision
  let lastBotScore = null;
  let ended = false;

  function isLive() { return viewIndex === -2; }

  function myTurn() {
    if (!game || game.status.over || !isLive()) return false;
    if (mode === 'local') return true;
    return game.turn() === myColor;
  }

  function playerFor(color) {
    return color === 'w' ? game.config.white : game.config.black;
  }

  /* ------------------------------- partida ------------------------------ */

  function buildGame(colorForMe) {
    myColor = colorForMe;

    const white = mode === 'local'
      ? { kind: 'human', name: 'Blancas' }
      : (myColor === 'w' ? me : botPlayer(bot));
    const black = mode === 'local'
      ? { kind: 'human', name: 'Negras' }
      : (myColor === 'b' ? me : botPlayer(bot));

    game = createGame({
      mode,
      timeControl: tc.base > 0 ? { base: tc.base, inc: tc.inc } : null,
      rated,
      white,
      black,
    });

    evals = [];
    lastBotScore = null;
    ended = false;
    viewIndex = -2;
    hintsLeft = allowHints ? 3 : 0;

    if (clock) clock.destroy();
    clock = tc.base > 0
      ? createClock({
        base: tc.base,
        inc: tc.inc,
        onTick: () => paintClocks(),
        onFlag: (color) => {
          game.timeout(color === 'w' ? 'w' : 'b');
          finish();
        },
      })
      : null;

    if (board) board.destroy();
    clear(boardHost);
    board = createBoard(boardHost, {
      orientation: myColor === 'b' ? 'black' : 'white',
      pieceSet: settings.pieceSet || 'clasico',
      theme: settings.boardTheme || 'verde',
      coordinates: settings.showCoordinates !== false,
      showLegal: query.legal === '0' ? false : settings.showLegalMoves !== false,
      animationMs: settings.animations === false ? 0 : 180,
      onMoveAttempt: handleMoveAttempt,
      onPromotion: settings.autoQueen ? () => Promise.resolve('q') : null,
      /* Premovimiento: solo tiene sentido con reloj y contra alguien que
         tarda en responder, asi que en local no se ofrece. */
      onPremove: settings.premove === false || mode === 'local' ? null : handlePremove,
    });
    if (showBar) bar.setOrientation(myColor === 'b' ? 'black' : 'white');

    buildPlayerCards();
    ctx.ai?.newGame?.();
    ctx.sound?.play?.('gameStart');

    if (mode === 'bot') {
      say(botLine(bot, 'greeting', mulberry32(seedBase)));
    }

    renderControls();
    sync({ animate: false });
    if (clock) clock.start('w');
    scheduleBot();
  }

  async function handleMoveAttempt(from, to, promotion) {
    if (!myTurn() || thinking) return false;

    /* Con «confirmar jugada» activado se pregunta antes de mover. Hay que
       consultarlo aqui: el ajuste existia en la pantalla de ajustes y no lo
       leia nadie, asi que el interruptor no hacia nada. */
    if (settings.confirmMove) {
      const san = sanPreview(from, to, promotion);
      const ok = await confirmDialog({
        title: '¿Confirmás la jugada?',
        message: san ? `Vas a jugar ${san}.` : `Vas a mover de ${from} a ${to}.`,
        confirmLabel: 'Jugar',
      });
      if (!ok || game.status.over || !myTurn()) return false;
    }

    const res = game.tryMove(from, to, promotion || null);
    if (!res.ok) return false;
    afterMove(res.entry, 'human');
    return true;
  }

  /** Notación de una jugada antes de hacerla, para poder preguntar por ella. */
  function sanPreview(from, to, promotion) {
    try {
      const uci = from + to + (promotion || '');
      const move = uciToMove(game.pos, uci);
      return move === -1 ? null : moveToSan(game.pos, move);
    } catch {
      return null;
    }
  }

  /**
   * Quita el caracter puntuable de la partida. Se llama al usar cualquier
   * ayuda: asi nadie infla su puntuacion con el motor delante.
   */
  function dropRated(motivo) {
    if (!rated) return;
    rated = false;
    ctx.toast?.(`La partida pasa a ser amistosa: ${motivo}.`, 'warn');
    renderControls();
    paintStatus();
    paintRated();
  }

  /* --------------------------- premovimiento ---------------------------- */

  let premove = null;
  const premoveEnabled = settings.premove !== false && mode !== 'local';

  function handlePremove(from, to) {
    if (game.status.over || myTurn()) return;
    premove = { from, to };
    board.setPremove(from, to);
    setStatus('Premovimiento preparado. Se juega en cuanto responda tu rival.');
  }

  function clearPremove() {
    premove = null;
    if (board) board.clearPremove();
  }

  /** Intenta soltar el premovimiento guardado en cuanto vuelve a ser tu turno. */
  function runPremove() {
    if (!premove || !myTurn() || thinking) return;
    const { from, to } = premove;
    clearPremove();
    /* Un premovimiento no puede abrir el dialogo de promocion: no hay a quien
       preguntar todavia, asi que corona dama, que es lo habitual. */
    const res = game.tryMove(from, to, 'q');
    if (res.ok) afterMove(res.entry, 'human');
    else {
      sync({ animate: false });
      ctx.toast?.('Tu premovimiento ya no era legal.', 'warn');
    }
  }

  function afterMove(entry, who) {
    if (clock) {
      clock.press(entry.color === 'w' ? 'w' : 'b');
      game.setClockSnapshot(clock.getTimes());
    }
    ctx.sound?.playMoveSound?.({
      capture: !!entry.capture,
      castle: /^O-O/.test(entry.san),
      promotion: !!entry.promotion,
      check: /[+#]$/.test(entry.san),
      mate: /#$/.test(entry.san),
    });
    viewIndex = -2;
    sync({ animate: true });
    refreshEval();

    if (game.status.over) {
      finish();
      return;
    }
    if (who === 'human' && mode === 'bot' && /\+$/.test(entry.san)) {
      say(botLine(bot, 'check', mulberry32(seedBase + game.ply())));
    }
    scheduleBot();
    /* Si el rival acaba de mover y habia un premovimiento esperando, va ahora. */
    if (who !== 'human') runPremove();
  }

  /* --------------------------------- bots -------------------------------- */

  function scheduleBot() {
    if (destroyed || !game || game.status.over) return;
    const player = playerFor(game.turn());
    if (!player || player.kind !== 'bot') return;
    runBot(player).catch((err) => {
      if (!destroyed) ctx.toast?.('El motor falló: ' + (err?.message || err), 'err');
    });
  }

  async function runBot(player) {
    if (thinking) return;
    thinking = true;
    const ply = game.ply();
    setStatus(`${player.name} está pensando…`);
    if (mode === 'bot') say(botLine(bot, 'thinking', mulberry32(seedBase + ply * 7)));

    let res;
    try {
      res = await ctx.ai.botMove({
        fen: game.getFen(),
        botId: player.botId,
        history: game.uciMoves(),
        moveNumber: game.moveNumber(),
        seed: (seedBase + ply) >>> 0,
        /* El worker no ve el Elo en vivo que se fijo en el hilo principal. */
        elo: eloOf(player.botId ? botById(player.botId) : bot),
        timeBudgetMs: clock ? Math.max(120, Math.min(4000, clock.getTimes()[game.turn()] / 25)) : null,
      });
    } finally {
      thinking = false;
    }

    if (destroyed || !game || game.status.over || game.ply() !== ply) return;
    await delay(Math.min(res.thinkMs || 0, 2600));
    if (destroyed || !game || game.status.over || game.ply() !== ply) return;

    const played = game.playUci(res.uci, { engineScore: res.score });
    if (!played || played.ok === false) {
      ctx.toast?.('El bot propuso una jugada imposible.', 'err');
      return;
    }

    /* Comentario segun como le haya ido respecto a su jugada anterior. */
    if (mode === 'bot' && typeof res.score === 'number') {
      if (lastBotScore !== null) {
        const swing = res.score - lastBotScore;
        if (swing < -250) say(botLine(bot, 'blunder', mulberry32(seedBase + ply * 13)));
        else if (swing > 250) say(botLine(bot, 'brilliant', mulberry32(seedBase + ply * 17)));
      }
      lastBotScore = res.score;
    }
    if (res.fromBook && res.bookName) openingLine.textContent = 'Libro: ' + res.bookName;

    afterMove(played.entry || game.history[game.history.length - 1], 'bot');
  }

  /* ----------------------------- sincronizacion -------------------------- */

  function sync({ animate = true } = {}) {
    if (!game || !board) return;

    const live = isLive();
    const index = live ? game.history.length - 1 : viewIndex;
    board.setPosition(live ? game.getFen() : game.fenAt(index), {
      animate,
      /* `highlightLastMove` tampoco lo leia nadie: la ultima jugada se
         resaltaba siempre, tuvieras el ajuste puesto o no. */
      lastMove: settings.highlightLastMove === false ? null : game.lastMoveSquares(index),
    });

    const mias = myColor === 'w' ? 'white' : 'black';
    if (live && !game.status.over && myTurn()) {
      board.setLegalMoves(game.legalMovesMap());
      board.setInteractive(true);
      board.setMovableColor(mode === 'local' ? 'both' : mias);
    } else if (live && !game.status.over && premoveEnabled) {
      /* Turno del rival: el tablero tiene que seguir escuchando o el
         premovimiento no puede llegar nunca. Sin jugadas legales, todo intento
         cae en el camino de `onPremove`. */
      board.setLegalMoves(new Map());
      board.setInteractive(true);
      board.setMovableColor(mias);
    } else {
      board.setLegalMoves(new Map());
      board.setInteractive(false);
    }

    board.markCheck(live && game.inCheck() ? game.kingSquare(game.turn()) : null);

    moves.setMoves(game.sanMoves());
    moves.setCurrent(live ? game.history.length - 1 : viewIndex);

    paintPlayers();
    paintClocks();
    paintStatus();
    paintOpening();
    paintRated();
    /* Los controles dependen del estado (deshacer necesita jugadas hechas,
       «volver al presente» solo vale mirando el pasado). Sin repintarlos aqui,
       el boton de deshacer no aparecia hasta que otra cosa forzara el redibujo. */
    renderControls();
  }

  function paintPlayers() {
    if (!topCard || !bottomCard) return;
    const top = myColor === 'w' ? 'b' : 'w';
    const bottom = myColor;
    const material = game.material();

    const info = (color, card) => {
      const player = playerFor(color);
      const captured = color === 'w' ? material.capturedByWhite : material.capturedByBlack;
      const advantage = color === 'w' ? material.balance : -material.balance;
      card.setCaptured(captured, advantage);
      card.setActive(!game.status.over && game.turn() === color);
    };

    /* Las tarjetas se construyen una vez; solo se refresca lo que cambia. */
    info(top, topCard);
    info(bottom, bottomCard);
  }

  function paintClocks() {
    /* El reloj puede dar su primer tic antes de que existan las tarjetas
       (al fijar los tiempos que manda el servidor, por ejemplo). */
    if (!clock || !topCard || !bottomCard) return;
    const times = clock.getTimes();
    const running = clock.runningColor?.();
    const top = myColor === 'w' ? 'b' : 'w';
    topCard.setClock(times[top], { active: running === top });
    bottomCard.setClock(times[myColor], { active: running === myColor });
    if (settings.sound !== false) {
      for (const color of ['w', 'b']) {
        if (running === color && times[color] > 9400 && times[color] < 10000) ctx.sound?.play?.('tenSeconds');
      }
    }
  }

  function paintStatus() {
    if (game.status.over) {
      setStatus(game.status.text || 'Partida terminada.');
      return;
    }
    if (!isLive()) {
      setStatus('Estás mirando una jugada anterior. Pulsá «Volver al presente» para seguir.');
      return;
    }
    const turn = game.turn();
    const player = playerFor(turn);
    /* El aviso de premovimiento lo escribia handlePremove, pero `sync()` corre
       despues y lo pisaba: hay que contarlo aqui para que se quede. */
    if (premove && !myTurn()) {
      setStatus(`Premovimiento listo (${premove.from}→${premove.to}). Se juega en cuanto responda tu rival.`);
      return;
    }
    if (game.inCheck()) setStatus(`Jaque a las ${COLOR_NAME[turn]}.`);
    /* «te toca» solo si de verdad te toca: en online los dos jugadores son
       humanos y ambas pantallas decian lo mismo a la vez. */
    else setStatus(`Juegan las ${COLOR_NAME[turn]}${mode !== 'local' && turn === myColor ? ' — te toca' : ''}.`);
  }

  function paintOpening() {
    if (openingLine.textContent.startsWith('Libro:')) return;
    const hit = openingName(game.sanMoves());
    openingLine.textContent = hit ? `${hit.eco} · ${hit.name}` : '';
  }

  function setStatus(text) {
    statusLine.textContent = text;
  }

  /** Deja claro en todo momento si la partida cuenta para la puntuacion. */
  function paintRated() {
    if (mode === 'tournament' || mode === 'local') {
      ratedChip.textContent = mode === 'tournament' ? 'De torneo' : 'Amistosa';
      ratedChip.title = '';
      return;
    }
    /* Online lo decide el servidor, y lo decia mal: ponia «Amistosa» en
       partidas que si movian la puntuacion. */
    ratedChip.textContent = rated ? 'Puntuable' : 'Amistosa';
    if (mode === 'online') {
      ratedChip.title = rated
        ? 'El resultado cambiará tu puntuación online.'
        : 'Esta partida no cuenta para la puntuación.';
      return;
    }
    ratedChip.title = rated
      ? 'El resultado cambiará tu puntuación. Usar pistas o deshacer la volvería amistosa.'
      : (ratedAtStart ? 'Dejó de contar al usar una ayuda.' : 'Elegiste jugarla sin puntuación.');
  }

  function say(text) {
    if (!text || mode !== 'bot' || settings.showBotChat === false) {
      bubble.classList.add('hidden');
      return;
    }
    bubble.textContent = text;
    bubble.classList.remove('hidden');
  }

  async function refreshEval() {
    if (!bar || !ctx.ai?.evalOnly) return;
    const fen = game.getFen();
    try {
      const score = await ctx.ai.evalOnly(fen);
      if (destroyed || game.getFen() !== fen) return;
      /* evalOnly puntua desde el bando que mueve; la barra habla en blancas. */
      const white = game.turn() === 'w' ? score : -score;
      evals.push(white);
      bar.setScore(white, null);
    } catch {
      /* que falle la barra no puede estropear la partida */
    }
  }

  /* ------------------------------ navegacion ----------------------------- */

  function setView(index) {
    const last = game.history.length - 1;
    if (index >= last) viewIndex = -2;
    else viewIndex = Math.max(-1, index);
    sync({ animate: true });
    renderControls();
  }

  function onKey(event) {
    if (event.target && /input|textarea|select/i.test(event.target.localName || '')) return;
    const last = game.history.length - 1;
    const current = isLive() ? last : viewIndex;
    if (event.key === 'ArrowLeft') { setView(current - 1); event.preventDefault(); }
    else if (event.key === 'ArrowRight') { setView(current + 1); event.preventDefault(); }
    else if (event.key === 'Home') { setView(-1); event.preventDefault(); }
    else if (event.key === 'End') { setView(last); event.preventDefault(); }
    else if (event.key.toLowerCase() === 'f') board?.flip();
  }
  document.addEventListener('keydown', onKey);
  cleanups.push(() => document.removeEventListener('keydown', onKey));

  /* ------------------------------- controles ----------------------------- */

  function renderControls() {
    clear(controls);

    if (!game.status.over) {
      controls.appendChild(button('Rendirse', {
        variant: 'danger', size: 'sm',
        onClick: async () => {
          const ok = await confirmDialog({
            title: '¿Abandonar la partida?',
            message: 'Se contará como derrota.',
            confirmLabel: 'Rendirse',
            danger: true,
          });
          if (!ok || game.status.over) return;
          /* Online no se puede terminar la partida por tu cuenta: hay que
             decirselo al servidor, que es quien avisa al rival. Antes te
             rendias solo en tu pantalla y el otro se quedaba jugando contra
             nadie hasta que se le acababa el tiempo. */
          if (mode === 'online') {
            try {
              ctx.online.resign(params.gameId);
              setStatus('Te rendiste. Esperando al servidor…');
            } catch {
              ctx.toast?.('No pude mandar la rendición.', 'err');
            }
            return;
          }
          game.resign(mode === 'local' ? game.turn() : myColor);
          finish();
        },
      }));

      controls.appendChild(button('Tablas', {
        size: 'sm',
        onClick: () => {
          if (mode === 'local') {
            game.offerDraw(game.turn());
            game.acceptDraw();
            finish();
            return;
          }
          /* Contra una persona las tablas se ofrecen y las contesta ella. La
             pantalla usaba aqui la logica de los bots: miraba la evaluacion y
             decidia sola, sin preguntarle a nadie ni avisar al servidor. */
          if (mode === 'online') {
            try {
              ctx.online.offerDraw(params.gameId);
              ctx.toast?.('Tablas ofrecidas. Le toca contestar a tu rival.', '');
            } catch {
              ctx.toast?.('No pude ofrecer tablas.', 'err');
            }
            return;
          }
          /* Un bot acepta las tablas solo si de verdad esta igualado. */
          const last = evals.length ? evals[evals.length - 1] : 0;
          const fromMe = myColor === 'w' ? last : -last;
          if (Math.abs(fromMe) < 40 && game.ply() > 20) {
            game.offerDraw(myColor);
            game.acceptDraw();
            finish();
          } else {
            ctx.toast?.(`${playerFor(myColor === 'w' ? 'b' : 'w').name} prefiere seguir jugando.`, '');
          }
        },
      }));
    }

    if (allowUndo && !game.status.over && game.ply() > 0) {
      controls.appendChild(button('Deshacer', {
        size: 'sm',
        onClick: () => {
          dropRated('deshiciste una jugada');
          const plies = mode === 'local' ? 1 : 2;
          game.takeback(Math.min(plies, game.ply()));
          clearPremove();
          viewIndex = -2;
          sync({ animate: true });
          renderControls();
        },
      }));
    }

    if (hintsLeft > 0 && !game.status.over) {
      controls.appendChild(button(`Pista (${hintsLeft})`, {
        size: 'sm',
        onClick: async () => {
          if (!myTurn()) return;
          dropRated('pediste una pista');
          hintsLeft--;
          renderControls();
          try {
            const res = await ctx.ai.analyze({ fen: game.getFen(), depth: 12, timeMs: 700, multiPv: 1 });
            const best = res.lines?.[0];
            if (best && board) {
              board.drawArrow(best.uci.slice(0, 2), best.uci.slice(2, 4), 'var(--accent)');
              ctx.toast?.(`Se sugiere ${best.san}.`, '');
            }
          } catch {
            ctx.toast?.('No pude calcular la pista.', 'warn');
          }
        },
      }));
    }

    controls.appendChild(button('Girar', {
      size: 'sm', title: 'Girar el tablero (tecla F)',
      onClick: () => { board?.flip(); if (showBar) bar.setOrientation(board.getOrientation()); },
    }));

    controls.appendChild(button('Copiar PGN', {
      size: 'sm',
      onClick: () => copy(game.getPgn(), 'PGN copiado.'),
    }));
    controls.appendChild(button('Copiar FEN', {
      size: 'sm',
      onClick: () => copy(game.getFen(), 'FEN copiada.'),
    }));

    if (!isLive()) {
      controls.appendChild(button('Volver al presente', {
        size: 'sm', variant: 'ghost',
        onClick: () => setView(game.history.length - 1),
      }));
    }
  }

  function copy(text, okMessage) {
    try {
      navigator.clipboard.writeText(text).then(
        () => ctx.toast?.(okMessage, ''),
        () => ctx.toast?.('El navegador no dejó copiar.', 'warn'),
      );
    } catch {
      ctx.toast?.('El navegador no dejó copiar.', 'warn');
    }
  }

  /* -------------------------------- final -------------------------------- */

  function myResult() {
    const status = game.status;
    if (status.winner === null) return 'draw';
    const winner = status.winner === 0 ? 'w' : 'b';
    return winner === myColor ? 'win' : 'loss';
  }

  function accuracy() {
    if (evals.length < 4) return null;
    const mine = myColor === 'w' ? 1 : -1;
    let loss = 0;
    let n = 0;
    for (let i = 1; i < evals.length; i++) {
      const before = evals[i - 1] * mine;
      const after = evals[i] * mine;
      /* Solo cuentan las jugadas propias. */
      const moverWasMe = (i % 2 === 1) === (myColor === 'w');
      if (!moverWasMe) continue;
      loss += Math.max(0, before - after);
      n++;
    }
    if (!n) return null;
    return accuracyFromLoss(loss / n);
  }

  function finish() {
    if (ended || !game.status.over) return;
    ended = true;
    clearPremove();
    if (clock) clock.pause();
    thinking = false;
    sync({ animate: true });
    renderControls();

    const result = myResult();
    ctx.sound?.play?.(result === 'win' ? 'win' : result === 'loss' ? 'lose' : 'draw');
    if (result === 'win' && board) board.spawnConfetti?.();

    if (mode === 'bot') {
      say(botLine(bot, result === 'win' ? 'lose' : result === 'loss' ? 'win' : 'draw',
        mulberry32(seedBase + 99)));
    }

    let record = null;
    /* Online tambien se guarda: antes la partida se perdia entera —no quedaba
       en el historial y «Analizar» abria un tablero vacio— aunque fuese la
       unica contra una persona de verdad. */
    if (mode === 'bot' || mode === 'tournament' || mode === 'online') {
      try {
        const facts = analyzeGame({
          sanMoves: game.sanMoves(),
          myColor,
          endReason: game.status.reason,
          winnerColor: game.status.winner === null ? null : (game.status.winner === 0 ? 'w' : 'b'),
          finalFen: game.getFen(),
          clockLeftMs: clock ? clock.getTimes()[myColor] : null,
          category,
          myElo: me.rating,
          opponentElo: bot ? eloOf(bot) : (onlineRival?.elo ?? 1500),
          ...game.gameFacts(myColor),
        });
        record = recordResult({
          mode,
          category,
          opponent: bot
            ? { name: bot.name, elo: eloOf(bot), botId: bot.id }
            : (onlineRival ? { name: onlineRival.name, elo: onlineRival.elo } : {}),
          result,
          /* La puntuacion online la lleva el servidor: recalcularla aqui
             inventaria un segundo Elo que no cuadra con el suyo. */
          rated: mode === 'online' ? false : rated,
          pgn: game.getPgn(),
          sanMoves: game.sanMoves(),
          facts,
          plies: game.ply(),
        });
        if (record?.profile) Object.assign(ctx.profile, record.profile);
      } catch (err) {
        ctx.toast?.('No pude guardar la partida: ' + (err?.message || err), 'warn');
      }
    }

    if (mode === 'tournament') reportToTournament(result);

    showSummary(result, record);
  }

  function reportToTournament(result) {
    try {
      /* Gana el blanco cuando gano yo y soy blancas, o cuando pierdo y soy negras. */
      const pgnResult = result === 'draw'
        ? '1/2-1/2'
        : ((result === 'win') === (myColor === 'w') ? '1-0' : '0-1');
      const stored = getTournament(params.tournamentId);
      if (!stored) return;
      const t = deserialize(stored);
      reportResult(t, params.gameId, pgnResult);
      saveTournament(serialize(t));
    } catch (err) {
      ctx.toast?.('No pude anotar el resultado en el torneo: ' + (err?.message || err), 'warn');
    }
  }

  function showSummary(result, record) {
    const title = result === 'win' ? '¡Ganaste!' : result === 'loss' ? 'Perdiste' : 'Tablas';
    const body = el('div', { class: 'col gap-16' });

    body.appendChild(el('p', { class: 'result-hero', text: game.status.text || '' }));

    /* En online el cambio de puntuacion lo manda el servidor, que es quien la
       lleva; el de aqui seria otro numero distinto. */
    if (mode === 'online' && onlineRatings) {
      const mio = onlineRatings[myColor === 'w' ? 'white' : 'black'];
      if (mio && typeof mio.delta === 'number') {
        body.appendChild(el('div', { class: 'row gap-6' },
          el('span', { class: 'muted', text: 'Puntuación:' }),
          el('span', { class: 'mono', text: String(Math.round(mio.before)) }),
          el('span', { text: '→' }),
          el('span', { class: 'mono strong', text: String(Math.round(mio.after)) }),
          deltaSpan(mio.delta)));
      }
    } else if (mode !== 'online' && record && typeof record.delta === 'number' && rated) {
      const row = el('div', { class: 'row gap-6' },
        el('span', { class: 'muted', text: 'Puntuación:' }),
        el('span', { class: 'mono', text: String(Math.round(record.ratingBefore)) }),
        el('span', { text: '→' }),
        el('span', { class: 'mono strong', text: String(Math.round(record.ratingAfter)) }),
        deltaSpan(record.delta));
      body.appendChild(row);
    }

    /* Sin barra de evaluacion no hay con que medir, y con cuatro jugadas la
       media no dice nada. Son dos motivos distintos: contarlos como uno solo
       manda a activar algo que a lo mejor ya estaba activado. */
    const acc = accuracy();
    let precision;
    if (acc !== null) precision = `Precisión estimada: ${acc.toFixed(1)}%`;
    else if (!bar) precision = 'Precisión: no se midió, la barra de evaluación estaba desactivada.';
    else precision = 'Precisión: la partida fue demasiado corta para estimarla.';
    body.appendChild(el('p', { class: 'small muted' }, el('span', { text: precision })));

    if (record?.unlocked?.length) {
      const list = el('div', { class: 'col gap-6' });
      list.appendChild(el('p', { class: 'strong', text: 'Logros desbloqueados' }));
      for (const id of record.unlocked) {
        const ach = achievementById(id);
        if (ach) list.appendChild(el('div', { class: 'row gap-6' },
          el('span', { text: ach.icon }), el('span', { text: ach.name })));
      }
      body.appendChild(list);
    }

    const actions = [];
    if (mode === 'bot') {
      actions.push({
        label: 'Revancha',
        variant: 'primary',
        onClick: () => buildGame(myColor === 'w' ? 'b' : 'w'),
      });
      actions.push({ label: 'Otro rival', onClick: () => ctx.navigate('#/bots') });
    } else if (mode === 'local') {
      actions.push({ label: 'Otra partida', variant: 'primary', onClick: () => buildGame('w') });
    } else if (mode === 'tournament') {
      actions.push({
        label: 'Volver al torneo',
        variant: 'primary',
        onClick: () => ctx.navigate(`#/torneo/${params.tournamentId}`),
      });
    } else if (mode === 'online') {
      /* Antes de esto, al terminar una partida online no habia ni revancha ni
         forma de volver al lobby: solo «Analizar», que ademas abria un tablero
         vacio. */
      actions.push({
        label: 'Pedir revancha',
        variant: 'primary',
        onClick: () => {
          try {
            ctx.online.rematch(params.gameId);
            ctx.toast?.('Revancha pedida. Empieza en cuanto tu rival acepte.', '');
          } catch {
            ctx.toast?.('No pude pedir la revancha.', 'err');
          }
        },
      });
      actions.push({ label: 'Volver al lobby', onClick: () => ctx.navigate('#/online') });
    }
    /* `recordResult` devuelve la partida ya guardada: con su id el análisis la
       carga entera y se puede revisar jugada a jugada. Sin id se abría un
       tablero vacío, que no es revisar nada. */
    const guardada = record && record.game && record.game.id;
    actions.push({
      label: guardada ? 'Revisar la partida' : 'Analizar',
      onClick: () => ctx.navigate(guardada ? `#/analisis/${record.game.id}` : '#/analisis'),
    });

    modal({ title, body, actions, dismissable: true });
  }

  /* ------------------------------- arranque ------------------------------ */

  /* ------------------------------- online -------------------------------- */

  /**
   * En online manda el servidor: la pantalla no inventa nada. Al montarse pide
   * el estado con un `join` (el servidor reenvia `gameStart` a quien ya esta en
   * la partida), reconstruye el tablero con lo que llegue y a partir de ahi
   * solo aplica lo que el servidor confirma.
   */
  let salidaPuesta = false;

  function startOnline() {
    setStatus('Conectando con la partida…');
    /* Si en 10 s no ha llegado la partida, algo pasa: mejor decirlo que dejar
       al jugador mirando un «Conectando…» eterno. */
    const aviso = setTimeout(() => {
      if (destroyed || game) return;
      handleOnlineEvent({ t: 'error', code: 'noSuchGame', message: 'La partida no llegó. Puede que ya no exista.' });
    }, 10000);
    cleanups.push(() => clearTimeout(aviso));
    const off = ctx.onOnlineEvent((msg) => {
      if (destroyed || !msg || msg.gameId && msg.gameId !== params.gameId) {
        if (!msg || msg.t !== 'gameStart') return;
      }
      try {
        handleOnlineEvent(msg);
      } catch (err) {
        ctx.toast?.('Error procesando un mensaje del servidor: ' + (err?.message || err), 'err');
      }
    });
    cleanups.push(off);
    try {
      ctx.online.join(params.gameId);
    } catch {
      setStatus('No pude pedirle la partida al servidor.');
    }
  }

  /**
   * El reloj de online lo lleva el servidor; aqui solo se copia lo que manda y
   * se pone a correr del lado que toca. Sin esto el reloj local no cambiaba
   * nunca de bando: se vaciaba el del jugador que ya habia movido, cada
   * cliente enseñaba una hora distinta, y quien ganaba por tiempo veia su
   * propio reloj a cero.
   */
  function syncClocks(clocks, over = false) {
    if (!clock) return;
    clock.pause();
    if (clocks) clock.setTimes(clocks);
    if (!over && game && !game.status.over) clock.resume(game.turn());
    paintClocks();
  }

  function handleOnlineEvent(msg) {
    if (msg.t === 'gameStart' && msg.game) {
      if (msg.game.id === params.gameId) {
        buildOnlineGame(msg.game);
        return;
      }
      /* La revancha es una partida nueva, con otro id: hay que ir a ella o el
         jugador se queda mirando la que acaba de terminar. */
      if (!msg.resume && msg.game.youAre) ctx.navigate(`#/jugar/online/${msg.game.id}`);
      return;
    }
    if (!game) return;
    if (msg.t === 'move' && msg.gameId === params.gameId) {
      applyServerMove(msg);
      return;
    }
    if (msg.t === 'gameOver' && msg.gameId === params.gameId) {
      onlineRatings = msg.ratings || null;
      /* El motivo viene ya redactado por el servidor («Se acabó el tiempo:
         ganan las blancas»); pasarlo entero evita el «partida terminada» seco
         que se leia antes. */
      game.forceResult(msg.result, msg.reason || 'agreement', msg.reason || null);
      syncClocks(null, true);
      finish();
      return;
    }
    if (msg.t === 'chat' && msg.gameId === params.gameId) {
      say(`${msg.from}: ${msg.text}`);
      return;
    }
    if (msg.t === 'drawOffer' && msg.gameId === params.gameId) {
      ofrecenTablas(msg.from);
      return;
    }
    if (msg.t === 'drawDeclined' && msg.gameId === params.gameId) {
      ctx.toast?.('Tu rival no quiere tablas.', '');
      return;
    }
    if (msg.t === 'opponentGone' && msg.gameId === params.gameId) {
      setStatus(`Tu rival se desconectó. Si no vuelve en ${msg.secondsLeft} s, ganás.`);
      return;
    }
    if (msg.t === 'opponentBack' && msg.gameId === params.gameId) {
      setStatus('Tu rival volvió.');
      sync({ animate: false });
      return;
    }
    /* Si el servidor dice que esa partida no existe o que no es tuya, antes se
       quedaba «Conectando con la partida…» para siempre, sin decir nada ni
       dejar salir. */
    if (msg.t === 'error' && !game) {
      const motivo = ONLINE_ERRORS[msg.code] || msg.message || 'No pude entrar en la partida.';
      setStatus(motivo);
      if (!salidaPuesta) {
        salidaPuesta = true;
        panel.appendChild(el('div', { class: 'row row--wrap gap-6', style: { marginTop: '10px' } },
          button('Volver al lobby', { variant: 'primary', onClick: () => ctx.navigate('#/online') })));
      }
    }
  }

  /** El rival ofrece tablas: se pregunta, y la respuesta va al servidor. */
  async function ofrecenTablas(quien) {
    ctx.sound?.play?.('notify');
    const ok = await confirmDialog({
      title: 'Tu rival ofrece tablas',
      message: `${quien || 'Tu rival'} propone terminar en tablas. ¿Aceptás?`,
      confirmLabel: 'Aceptar tablas',
      cancelLabel: 'Seguir jugando',
    });
    if (destroyed || !game || game.status.over) return;
    try {
      if (ok) ctx.online.acceptDraw(params.gameId);
      else ctx.online.declineDraw(params.gameId);
    } catch {
      ctx.toast?.('No pude contestar a la oferta.', 'err');
    }
  }

  /** Reconstruye la partida a partir del estado que manda el servidor. */
  function buildOnlineGame(payload) {
    myColor = payload.youAre === 'b' ? 'b' : 'w';
    const base = payload.tc?.base || 0;
    const inc = payload.tc?.inc || 0;
    tc = { id: `${base}+${inc}`, label: `${base}+${inc}`, base, inc };

    const lado = (info, color) => ({
      kind: 'human',
      name: info?.name || (color === 'w' ? 'Blancas' : 'Negras'),
      rating: typeof info?.rating === 'number' ? Math.round(info.rating) : undefined,
      avatarSeed: info?.name || color,
    });

    /* Online es el servidor quien dice si la partida puntua. La pantalla lo
       daba siempre por amistoso, asi que mentia en las que si contaban. */
    rated = payload.rated !== false;
    const infoRival = payload.youAre === 'b' ? payload.white : payload.black;
    onlineRival = {
      name: infoRival?.name || 'Rival',
      elo: typeof infoRival?.rating === 'number' ? Math.round(infoRival.rating) : 1500,
    };
    onlineRatings = null;

    game = createGame({
      mode: 'online',
      timeControl: base > 0 ? { base, inc } : null,
      rated: !!payload.rated,
      white: lado(payload.white, 'w'),
      black: lado(payload.black, 'b'),
    });
    /* Las jugadas ya hechas se reproducen tal cual para llegar a la posicion
       actual: asi una reconexion recupera la partida entera, no solo la FEN. */
    for (const uci of payload.moves || []) {
      const hecho = game.playUci(uci);
      if (!hecho || hecho.ok === false) break;
    }

    evals = [];
    ended = false;
    viewIndex = -2;
    hintsLeft = 0;

    if (clock) clock.destroy();
    clock = base > 0
      ? createClock({ base, inc, onTick: () => paintClocks(), onFlag: () => { /* lo decide el servidor */ } })
      : null;

    if (board) board.destroy();
    clear(boardHost);
    board = createBoard(boardHost, {
      orientation: myColor === 'b' ? 'black' : 'white',
      pieceSet: settings.pieceSet || 'clasico',
      theme: settings.boardTheme || 'verde',
      coordinates: settings.showCoordinates !== false,
      showLegal: settings.showLegalMoves !== false,
      animationMs: settings.animations === false ? 0 : 180,
      onMoveAttempt: handleOnlineMoveAttempt,
      onPromotion: settings.autoQueen ? () => Promise.resolve('q') : null,
      onPremove: settings.premove === false ? null : handlePremove,
    });

    buildPlayerCards();
    renderControls();
    sync({ animate: false });
    syncClocks(payload.clocks, payload.status === 'over');
    ctx.sound?.play?.('gameStart');
  }

  /** Una jugada propia: se comprueba aqui y se manda; el servidor es la autoridad. */
  async function handleOnlineMoveAttempt(from, to, promotion) {
    if (!game || game.status.over || game.turn() !== myColor || !isLive()) return false;
    const res = game.tryMove(from, to, promotion || null);
    if (!res.ok) return false;
    const uci = res.entry.uci;
    try {
      ctx.online.move(params.gameId, uci);
    } catch {
      ctx.toast?.('No pude enviar la jugada.', 'err');
    }
    afterMove(res.entry, 'human');
    return true;
  }

  /** Jugada confirmada por el servidor: si ya la teniamos, solo ajusta relojes. */
  function applyServerMove(msg) {
    const yaHechas = game.uciMoves();
    const esperada = typeof msg.moveNumber === 'number' ? null : null;
    const ultima = yaHechas[yaHechas.length - 1];
    if (ultima !== msg.uci || yaHechas.length === 0) {
      const hecho = game.playUci(msg.uci);
      if (hecho && hecho.ok !== false) {
        syncClocks(msg.clocks);
        clearPremove();
        ctx.sound?.playMoveSound?.({ capture: /x/.test(msg.san || ''), check: /[+#]$/.test(msg.san || '') });
        viewIndex = -2;
        sync({ animate: true });
        /* Tambien las del rival cuentan para la precision del resumen. */
        refreshEval();
        runPremove();
        return;
      }
    }
    syncClocks(msg.clocks);
    sync({ animate: false });
  }

  if (mode === 'online') startOnline();
  else buildGame(myColor);

  return {
    unmount() {
      destroyed = true;
      for (const fn of cleanups) {
        try { fn(); } catch { /* nada que hacer */ }
      }
      try { ctx.ai?.stop?.(); } catch { /* el motor ya estaba parado */ }
      if (clock) clock.destroy();
      if (board) board.destroy();
      clear(root);
    },
  };
}

/** Pantalla de cortesia cuando el modo pedido no se puede jugar. */
function fatal(root, ctx, message, route, label) {
  clear(root);
  const screen = el('div', { class: 'screen center' },
    el('div', { class: 'col center gap-16' },
      el('p', { class: 'h2', text: 'No se puede abrir la partida' }),
      el('p', { class: 'muted', text: message }),
      button(label, { variant: 'primary', onClick: () => ctx.navigate(route) })));
  root.appendChild(screen);
  return { unmount() { clear(root); } };
}
