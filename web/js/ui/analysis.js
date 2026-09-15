/**
 * ui/analysis.js — free analysis board: load a FEN or a PGN, walk through the
 * game with the keyboard, watch the engine's best lines live (with an arrow on
 * the board and the evaluation bar) and see how much every move really cost.
 *
 * The screen owns a single line of play: a starting FEN plus the moves made
 * from it. Playing on the board from any point truncates the rest, so the board
 * is genuinely free and not tied to a finished game.
 */

import {
  el, card, button, spinner, evalBar, moveList, switchControl, clear, field,
} from './components.js';
import { createBoard } from '../board.js';
import { classifyMove, MOVE_QUALITY_LABEL } from '../ai.js';
import { buildPgn, parsePgn } from '../pgn.js';
import { getGame } from '../storage.js';
import {
  START_FEN, WHITE, createPosition, generateMoves, makeMove, moveToSan, moveToUci,
  uciToMove, sanToMove, squareName, moveFrom, moveTo, movePromo, isCapture,
  isEnPassant, inCheck, gameResult,
} from '../chess.js';

/** Glyph shown next to a move for each quality bucket of classifyMove(). */
const QUALITY_GLYPH = {
  brilliant: '!!', good: '!', inaccuracy: '?!', mistake: '?', blunder: '??',
};
const QUALITY_ORDER = ['brilliant', 'good', 'inaccuracy', 'mistake', 'blunder'];

/** Live analysis settings: deep enough to be useful, quick enough to feel live. */
const LIVE_DEPTH = 14;
const LIVE_TIME_MS = 1500;
const LIVE_MULTI_PV = 3;

/** Full-game pass: shallower, because it runs once per ply. */
const FULL_DEPTH = 16;
const FULL_TIME_MS = 700;

const ARROW_COLORS = ['#81B64C', '#4A90D9', '#E0A030'];

export function mount(root, ctx, params = {}) {
  let destroyed = false;

  /* ------------------------------- state -------------------------------- */

  let startFen = START_FEN;          // position the line starts from
  let line = [];                     // [{ uci, san, fenBefore, fenAfter }]
  let ply = 0;                       // 0 = start position, n = after line[n-1]
  let evals = [];                    // per ply: { cp, mate, bestUci, legal } (side to move)
  let headers = {};                  // PGN headers of whatever was loaded
  let result = '*';

  let liveEnabled = true;
  let analysisToken = 0;
  let debounceTimer = null;
  let fullRun = null;                // { cancelled } while the whole game is being scanned
  const legalCountCache = new Map(); // fen -> number of legal moves

  /* -------------------------------- DOM --------------------------------- */

  const screen = el('div', { class: 'screen screen--wide' });

  const subtitle = el('p', {
    class: 'muted small',
    text: 'Tablero libre con el motor mirando por encima del hombro.',
  });

  const flipButton = el('button', {
    class: 'btn btn--ghost btn--icon',
    type: 'button',
    text: '⇅',
    title: 'Girar el tablero',
    attrs: { 'aria-label': 'Girar el tablero' },
    onClick: () => {
      board.flip();
      bar.setOrientation(board.getOrientation());
      renderEval();
    },
  });

  screen.appendChild(el('div', { class: 'screen__head' },
    el('div', { class: 'col gap-4' },
      el('h1', { class: 'h1', text: 'Análisis' }),
      subtitle),
    el('div', { class: 'row row--wrap gap-6' },
      flipButton,
      button('Posición inicial', { size: 'sm', onClick: () => loadFen(START_FEN, { quiet: true }) }),
      button('Copiar FEN', { size: 'sm', onClick: () => copyText(currentFen(), 'FEN copiada.') }),
      button('Copiar PGN', { size: 'sm', onClick: () => copyText(currentPgn(), 'PGN copiado.') }))));

  /* ------------------------------ board col ------------------------------ */

  const bar = evalBar();
  const boardStack = el('div', { class: 'board-stack' });

  const turnLabel = el('span', { class: 'small muted', text: 'Juegan las blancas' });
  const qualityLabel = el('span', { class: 'row gap-6' });
  const statusRow = el('div', { class: 'between row--wrap gap-6' }, turnLabel, qualityLabel);

  const layout = el('div', { class: 'game-layout' },
    el('div', { class: 'game-board-col' }, bar.node, boardStack),
    el('div', { class: 'game-panel' }));
  const panel = layout.lastChild;
  screen.appendChild(layout);

  const board = createBoard(boardStack, {
    orientation: 'white',
    theme: ctx.settings?.boardTheme,
    pieceSet: ctx.settings?.pieceSet,
    coordinates: ctx.settings?.showCoordinates !== false,
    animationMs: ctx.settings?.animations === false ? 0 : 180,
    interactive: true,
    showLegal: true,
    onMoveAttempt: (from, to, promotion) => playMove(from, to, promotion),
  });
  boardStack.appendChild(statusRow);

  /* ------------------------------- engine -------------------------------- */

  const engineSpinner = spinner(14);
  engineSpinner.classList.add('hidden');
  const engineDepth = el('span', { class: 'tiny faint', text: 'sin analizar' });
  const linesBox = el('div', { class: 'col gap-4' });

  const liveSwitch = switchControl('Análisis en vivo', {
    checked: liveEnabled,
    onChange: (ev) => {
      liveEnabled = !!(ev.target && ev.target.checked);
      if (liveEnabled) scheduleAnalysis(0);
      else {
        analysisToken += 1;
        safeStop();
        setThinking(false);
        board.clearArrows();
        engineDepth.textContent = 'análisis en vivo apagado';
      }
    },
  });

  const fullProgress = el('span', { class: 'tiny faint', text: '' });
  const fullButton = button('Analizar toda la partida', {
    size: 'sm',
    onClick: () => toggleFullAnalysis(),
  });

  panel.appendChild(card('Motor',
    el('div', { class: 'between row--wrap gap-6', style: { marginBottom: '8px' } },
      liveSwitch,
      el('span', { class: 'row gap-6' }, engineSpinner, engineDepth)),
    linesBox,
    el('div', { class: 'between row--wrap gap-6', style: { marginTop: '10px' } },
      fullButton,
      fullProgress)));

  /* ------------------------------- moves --------------------------------- */

  const list = moveList({ onSelect: (index) => goTo(index + 1) });

  const navButtons = el('div', { class: 'game-controls' },
    navButton('⏮', 'Ir al principio', () => goTo(0)),
    navButton('◀', 'Jugada anterior', () => goTo(ply - 1)),
    navButton('▶', 'Jugada siguiente', () => goTo(ply + 1)),
    navButton('⏭', 'Ir al final', () => goTo(line.length)),
    button('Deshacer', {
      size: 'sm',
      title: 'Borrar la última jugada de la línea',
      onClick: () => truncateHere(),
    }));

  const legend = el('div', { class: 'row row--wrap gap-6', style: { marginTop: '8px' } });
  for (const quality of QUALITY_ORDER) {
    legend.appendChild(el('span', { class: 'row gap-4' },
      el('span', { class: `nag nag--${quality}`, text: QUALITY_GLYPH[quality] }),
      el('span', { class: 'tiny faint', text: MOVE_QUALITY_LABEL[quality] })));
  }

  panel.appendChild(card('Jugadas', list.node, navButtons, legend));

  /* ------------------------------- loading -------------------------------- */

  const pasteArea = el('textarea', {
    class: 'textarea',
    placeholder: 'Pegá acá una FEN o el texto completo de un PGN…',
    attrs: { rows: '4', 'aria-label': 'FEN o PGN para cargar' },
  });

  panel.appendChild(card('Cargar una posición',
    field('FEN o PGN', pasteArea),
    el('div', { class: 'row row--wrap gap-6', style: { marginTop: '8px' } },
      button('Cargar FEN', { variant: 'primary', size: 'sm', onClick: () => loadFen(pasteArea.value) }),
      button('Cargar PGN', { size: 'sm', onClick: () => loadPgn(pasteArea.value) }),
      button('Limpiar', { size: 'sm', onClick: () => { pasteArea.value = ''; } }))));

  root.appendChild(screen);

  /* ------------------------------ keyboard -------------------------------- */

  function onKeyDown(ev) {
    if (ev.defaultPrevented || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    const tag = ev.target && ev.target.localName ? ev.target.localName : '';
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
    if (ev.key === 'ArrowLeft') { ev.preventDefault(); goTo(ply - 1); }
    else if (ev.key === 'ArrowRight') { ev.preventDefault(); goTo(ply + 1); }
    else if (ev.key === 'Home') { ev.preventDefault(); goTo(0); }
    else if (ev.key === 'End') { ev.preventDefault(); goTo(line.length); }
  }
  window.addEventListener('keydown', onKeyDown);

  /* ------------------------------- helpers -------------------------------- */

  function navButton(glyph, label, onClick) {
    return el('button', {
      class: 'btn btn--ghost btn--icon',
      type: 'button',
      text: glyph,
      title: label,
      attrs: { 'aria-label': label },
      onClick,
    });
  }

  function fenAt(index) {
    return index <= 0 ? startFen : line[index - 1].fenAfter;
  }

  function currentFen() {
    return fenAt(ply);
  }

  function currentPgn() {
    const extra = { ...headers };
    if (startFen !== START_FEN) {
      extra.FEN = startFen;
      extra.SetUp = '1';
    }
    return buildPgn({ headers: extra, sanMoves: line.map((m) => m.san), result });
  }

  function legalMap(pos) {
    const map = new Map();
    for (const move of generateMoves(pos)) {
      const from = squareName(moveFrom(move));
      const to = squareName(moveTo(move));
      let entry = map.get(from);
      if (!entry) { entry = []; map.set(from, entry); }
      if (entry.some((d) => d.to === to)) continue;
      entry.push({ to, capture: isCapture(move) || isEnPassant(move), promotion: movePromo(move) !== 0 });
    }
    return map;
  }

  function legalCount(fen) {
    if (legalCountCache.has(fen)) return legalCountCache.get(fen);
    let count = 0;
    try {
      count = generateMoves(createPosition(fen)).length;
    } catch {
      count = 0;
    }
    legalCountCache.set(fen, count);
    return count;
  }

  function copyText(text, message) {
    const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : null;
    if (!clipboard || !clipboard.writeText) {
      ctx.toast('Este navegador no deja copiar solo: seleccioná el texto a mano.', 'warn');
      return;
    }
    Promise.resolve(clipboard.writeText(text))
      .then(() => ctx.toast(message))
      .catch(() => ctx.toast('No se pudo copiar al portapapeles.', 'err'));
  }

  function safeStop() {
    try {
      if (ctx.ai && typeof ctx.ai.stop === 'function') ctx.ai.stop();
    } catch {
      /* stopping must never break the screen */
    }
  }

  /* ------------------------------ line edits ------------------------------ */

  function setLine(newStartFen, moves, meta = {}) {
    startFen = newStartFen;
    line = moves;
    headers = meta.headers || {};
    result = meta.result || '*';
    evals = [];
    legalCountCache.clear();
    ply = meta.atEnd === false ? 0 : line.length;
    list.setMoves(line.map((m) => m.san));
    list.setAnnotations([]);
    render();
  }

  /** Replay a list of SAN moves from a FEN, stopping at the first illegal one. */
  function movesFromSans(fromFen, sanMoves) {
    const pos = createPosition(fromFen);
    const moves = [];
    for (let i = 0; i < sanMoves.length; i++) {
      const fenBefore = fenOf(pos);
      const move = sanToMove(pos, sanMoves[i]);
      if (move === -1) {
        throw new Error(`La jugada «${sanMoves[i]}» (número ${i + 1}) no es legal.`);
      }
      const san = moveToSan(pos, move);
      const uci = moveToUci(move);
      makeMove(pos, move);
      moves.push({ uci, san, fenBefore, fenAfter: fenOf(pos) });
    }
    return moves;
  }

  /** getFen() re-exported under a short name so the replay above reads clean. */
  function fenOf(pos) {
    return fenFromPosition(pos);
  }

  function playMove(from, to, promotion) {
    const pos = createPosition(currentFen());
    const uci = `${from}${to}${promotion || ''}`;
    let move = uciToMove(pos, uci);
    if (move === -1 && !promotion) move = uciToMove(pos, `${uci}q`);
    if (move === -1) return false;

    const fenBefore = currentFen();
    const san = moveToSan(pos, move);
    makeMove(pos, move);
    const entry = { uci: moveToUci(move), san, fenBefore, fenAfter: fenFromPosition(pos) };

    line = line.slice(0, ply);
    evals = evals.slice(0, ply + 1);
    line.push(entry);
    ply = line.length;
    result = '*';
    list.setMoves(line.map((m) => m.san));
    refreshAnnotations();
    render();
    return true;
  }

  function truncateHere() {
    if (!line.length) return;
    const cut = ply > 0 ? ply - 1 : 0;
    line = line.slice(0, cut);
    evals = evals.slice(0, cut + 1);
    ply = line.length;
    list.setMoves(line.map((m) => m.san));
    refreshAnnotations();
    render();
  }

  function goTo(index) {
    const next = Math.max(0, Math.min(line.length, index));
    if (next === ply) return;
    ply = next;
    render();
  }

  /* -------------------------------- render -------------------------------- */

  function render() {
    if (destroyed) return;
    const fen = currentFen();
    const pos = createPosition(fen);
    const last = ply > 0 ? line[ply - 1] : null;

    board.setPosition(fen, {
      animate: true,
      lastMove: last
        ? { from: last.uci.slice(0, 2), to: last.uci.slice(2, 4), promotion: last.uci[4] || null }
        : null,
    });
    board.setLegalMoves(legalMap(pos));
    board.markCheck(inCheck(pos) ? squareName(pos.kingSq[pos.turn]) : null);
    board.clearArrows();

    list.setCurrent(ply - 1);
    renderStatus(pos);
    renderEval();
    renderLines(null);
    scheduleAnalysis();
  }

  function renderStatus(pos) {
    const over = gameResult(pos);
    if (over.over) {
      turnLabel.textContent = over.text;
    } else {
      const moveNumber = pos.fullmove;
      const side = pos.turn === WHITE ? 'las blancas' : 'las negras';
      turnLabel.textContent = `Juegan ${side} · jugada ${moveNumber}${inCheck(pos) ? ' · jaque' : ''}`;
    }

    clear(qualityLabel);
    const quality = ply > 0 ? annotationFor(ply - 1) : null;
    if (quality) {
      qualityLabel.appendChild(el('span', { class: `nag nag--${quality}`, text: QUALITY_GLYPH[quality] }));
      qualityLabel.appendChild(el('span', { class: 'small', text: `${line[ply - 1].san}: ${MOVE_QUALITY_LABEL[quality]}` }));
    } else if (ply > 0) {
      qualityLabel.appendChild(el('span', { class: 'small muted', text: `Última jugada: ${line[ply - 1].san}` }));
    } else {
      qualityLabel.appendChild(el('span', { class: 'tiny faint', text: 'Movés libremente: la línea se corta donde estés.' }));
    }
  }

  function renderEval() {
    const info = evals[ply];
    if (!info) {
      bar.setScore(0, null);
      return;
    }
    const whiteToMove = createPosition(currentFen()).turn === WHITE;
    const sign = whiteToMove ? 1 : -1;
    if (info.mate !== null && info.mate !== undefined) bar.setScore(0, sign * info.mate);
    else bar.setScore(sign * info.cp, null);
  }

  function renderLines(analysis) {
    clear(linesBox);
    if (!analysis || !analysis.lines || !analysis.lines.length) {
      const over = gameResult(createPosition(currentFen()));
      linesBox.appendChild(el('p', {
        class: 'tiny faint',
        text: over.over ? 'La partida está terminada en esta posición.' : 'Esperando al motor…',
      }));
      return;
    }
    const whiteToMove = createPosition(currentFen()).turn === WHITE;
    analysis.lines.slice(0, LIVE_MULTI_PV).forEach((entry, index) => {
      linesBox.appendChild(el('div', { class: 'row gap-6', style: { alignItems: 'baseline' } },
        el('span', {
          class: 'mono strong small',
          style: { color: index === 0 ? 'var(--accent)' : 'var(--text-dim)', minWidth: '52px' },
          text: formatScore(entry.score, entry.mate, whiteToMove),
        }),
        el('span', { class: 'small truncate grow', text: pvToSan(currentFen(), entry.pvUci, entry.san) })));
    });
  }

  function annotationFor(index) {
    const before = evals[index];
    const after = evals[index + 1];
    if (!before || !after || !line[index]) return null;
    return classifyMove(cpValue(before), -cpValue(after), {
      wasBest: before.bestUci === line[index].uci,
      isOnlyMove: legalCount(line[index].fenBefore) === 1,
    });
  }

  function refreshAnnotations() {
    const annotations = [];
    for (let i = 0; i < line.length; i++) annotations.push(annotationFor(i));
    list.setAnnotations(annotations);
    list.setCurrent(ply - 1);
  }

  /* ------------------------------- analysis -------------------------------- */

  function setThinking(on) {
    engineSpinner.classList.toggle('hidden', !on);
  }

  function scheduleAnalysis(delay = 140) {
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
    if (destroyed || !liveEnabled || fullRun) return;
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      runAnalysis();
    }, delay);
  }

  /** One live analysis of the current position; any previous one is cancelled. */
  async function runAnalysis() {
    if (destroyed || !liveEnabled || fullRun) return;
    const fen = currentFen();
    const atPly = ply;
    const pos = createPosition(fen);
    if (gameResult(pos).over) {
      engineDepth.textContent = 'posición terminada';
      renderLines(null);
      return;
    }

    const token = ++analysisToken;
    safeStop();
    setThinking(true);
    engineDepth.textContent = 'pensando…';

    let analysis = null;
    try {
      analysis = await ctx.ai.analyze({
        fen, depth: LIVE_DEPTH, timeMs: LIVE_TIME_MS, multiPv: LIVE_MULTI_PV,
      });
    } catch (error) {
      if (token === analysisToken && !destroyed) {
        setThinking(false);
        engineDepth.textContent = 'el motor no respondió';
      }
      return;
    }
    if (destroyed || token !== analysisToken) return;

    setThinking(false);
    storeEval(atPly, fen, analysis);
    if (atPly !== ply) return;

    engineDepth.textContent = `profundidad ${analysis.depth || 0} · ${formatNodes(analysis.nodes)} nodos`;
    renderLines(analysis);
    renderEval();
    drawArrows(analysis);
    refreshAnnotations();
  }

  function storeEval(index, fen, analysis) {
    const best = analysis && analysis.lines && analysis.lines[0];
    if (!best) return;
    evals[index] = {
      cp: typeof best.score === 'number' ? best.score : 0,
      mate: best.mate ?? null,
      bestUci: best.uci || null,
      fen,
    };
  }

  function drawArrows(analysis) {
    board.clearArrows();
    const lines = (analysis.lines || []).slice(0, 3);
    for (let i = lines.length - 1; i >= 0; i--) {
      const uci = lines[i].uci;
      if (!uci || uci.length < 4) continue;
      board.drawArrow(uci.slice(0, 2), uci.slice(2, 4), ARROW_COLORS[i] || ARROW_COLORS[2], i === 0 ? 0.17 : 0.11);
    }
  }

  /** Walk the whole line scoring every position, so each move gets a verdict. */
  async function toggleFullAnalysis() {
    if (fullRun) {
      fullRun.cancelled = true;
      fullRun = null;
      safeStop();
      fullButton.lastChild.textContent = 'Analizar toda la partida';
      fullProgress.textContent = 'análisis interrumpido';
      scheduleAnalysis(0);
      return;
    }
    if (!line.length) {
      ctx.toast('Cargá un PGN o jugá algunas jugadas antes de analizar la partida.', 'warn');
      return;
    }

    const run = { cancelled: false };
    fullRun = run;
    analysisToken += 1;
    safeStop();
    setThinking(true);
    fullButton.lastChild.textContent = 'Detener';

    for (let i = 0; i <= line.length; i++) {
      if (run.cancelled || destroyed) break;
      fullProgress.textContent = `analizando ${i} de ${line.length}`;
      const fen = fenAt(i);
      const pos = createPosition(fen);
      if (gameResult(pos).over) continue;
      try {
        const analysis = await ctx.ai.analyze({ fen, depth: FULL_DEPTH, timeMs: FULL_TIME_MS, multiPv: 1 });
        if (run.cancelled || destroyed) break;
        storeEval(i, fen, analysis);
        refreshAnnotations();
      } catch {
        if (run.cancelled || destroyed) break;
        fullProgress.textContent = 'el motor no respondió';
        break;
      }
    }

    if (destroyed) return;
    setThinking(false);
    if (fullRun === run) {
      fullRun = null;
      fullButton.lastChild.textContent = 'Analizar toda la partida';
      if (!run.cancelled) fullProgress.textContent = summary();
      refreshAnnotations();
      scheduleAnalysis(0);
    }
  }

  /** Count of each verdict, shown when the full pass finishes. */
  function summary() {
    const counts = { brilliant: 0, good: 0, inaccuracy: 0, mistake: 0, blunder: 0 };
    for (let i = 0; i < line.length; i++) {
      const quality = annotationFor(i);
      if (quality) counts[quality] += 1;
    }
    return `${counts.blunder} errores graves · ${counts.mistake} errores · ${counts.inaccuracy} imprecisiones`;
  }

  /* ------------------------------- loaders --------------------------------- */

  function loadFen(text, { quiet = false } = {}) {
    const fen = String(text || '').trim();
    if (!fen) {
      ctx.toast('Pegá primero una FEN.', 'warn');
      return;
    }
    try {
      createPosition(fen);
    } catch (error) {
      ctx.toast(error && error.message ? error.message : 'Esa FEN no es válida.', 'err');
      return;
    }
    setLine(fen, [], { headers: {}, result: '*' });
    if (!quiet) ctx.toast('Posición cargada.');
  }

  function loadPgn(text, { quiet = false } = {}) {
    const raw = String(text || '').trim();
    if (!raw) {
      ctx.toast('Pegá primero un PGN.', 'warn');
      return;
    }
    let parsed;
    try {
      parsed = parsePgn(raw);
    } catch (error) {
      ctx.toast('No se pudo leer el PGN.', 'err');
      return;
    }
    if (!parsed.sanMoves.length && !parsed.headers.FEN) {
      ctx.toast('Ese PGN no trae jugadas.', 'warn');
      return;
    }
    const from = parsed.headers.FEN || START_FEN;
    let moves;
    try {
      moves = movesFromSans(from, parsed.sanMoves);
    } catch (error) {
      ctx.toast(error && error.message ? error.message : 'El PGN tiene jugadas imposibles.', 'err');
      return;
    }
    setLine(from, moves, { headers: parsed.headers, result: parsed.result });
    if (!quiet) ctx.toast(`Partida cargada: ${moves.length} jugadas.`);
    describeHeaders(parsed.headers);
  }

  function describeHeaders(tags) {
    const white = tags.White || 'Blancas';
    const black = tags.Black || 'Negras';
    subtitle.textContent = `${white} — ${black}${tags.Date && tags.Date !== '????.??.??' ? ` · ${tags.Date}` : ''}`;
  }

  /* --------------------------- initial position ---------------------------- */

  setLine(START_FEN, [], {});

  if (params && params.gameId) {
    let saved = null;
    try {
      saved = getGame(params.gameId);
    } catch {
      saved = null;
    }
    if (saved && saved.pgn) {
      loadPgn(saved.pgn, { quiet: true });
      subtitle.textContent = `Partida guardada contra ${saved.opponent?.name || 'un rival'}.`;
    } else {
      ctx.toast('No se encontró esa partida guardada.', 'warn');
    }
  }

  /* Opening name is a nice-to-have: loaded apart so it never delays the board. */
  import('../book.js').then(({ openingName }) => {
    if (destroyed || !line.length || startFen !== START_FEN) return;
    /* `openingName` devuelve {eco, name}, no una cadena: interpolar el objeto
       entero escribia «[object Object]» en la cabecera. */
    const hit = openingName(line.map((m) => m.san));
    if (hit) subtitle.textContent = `${subtitle.textContent} · ${hit.eco} ${hit.name}`;
  }).catch(() => { /* the opening name is optional */ });

  /* -------------------------------- unmount -------------------------------- */

  return {
    unmount() {
      destroyed = true;
      analysisToken += 1;
      if (fullRun) fullRun.cancelled = true;
      fullRun = null;
      if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
      window.removeEventListener('keydown', onKeyDown);
      safeStop();
      board.destroy();
    },
  };
}

/* ------------------------------ pure helpers ------------------------------- */

/** Local wrapper so chess.js' getFen stays a single import point. */
function fenFromPosition(pos) {
  return chessFen(pos);
}

/* getFen is imported lazily-bound here to keep the import list above tidy. */
import { getFen as chessFen } from '../chess.js';

/** Centipawn value of a stored eval, with mates mapped to a huge number. */
function cpValue(info) {
  if (info.mate !== null && info.mate !== undefined) {
    const distance = Math.min(30, Math.abs(info.mate));
    return (info.mate > 0 ? 1 : -1) * (3000 - distance * 20);
  }
  return Math.max(-3000, Math.min(3000, info.cp || 0));
}

/** '+0.42' / '-1.30' / 'M3', always from White's point of view. */
function formatScore(cp, mate, whiteToMove) {
  const sign = whiteToMove ? 1 : -1;
  if (mate !== null && mate !== undefined) {
    const value = sign * mate;
    return `${value > 0 ? '' : '-'}M${Math.abs(mate)}`;
  }
  const score = (sign * (cp || 0)) / 100;
  return `${score >= 0 ? '+' : '−'}${Math.abs(score).toFixed(2)}`;
}

function formatNodes(nodes) {
  const value = nodes || 0;
  if (value >= 1000000) return `${(value / 1000000).toFixed(1)}M`;
  if (value >= 1000) return `${Math.round(value / 1000)}k`;
  return String(value);
}

/** Turn a principal variation in UCI into readable SAN with move numbers. */
function pvToSan(fen, pvUci, fallbackSan) {
  const list = Array.isArray(pvUci) ? pvUci : [];
  if (!list.length) return fallbackSan || '';
  let pos;
  try {
    pos = createPosition(fen);
  } catch {
    return fallbackSan || '';
  }
  const out = [];
  for (const uci of list.slice(0, 10)) {
    const move = uciToMove(pos, uci);
    if (move === -1) break;
    const san = moveToSan(pos, move);
    if (pos.turn === WHITE) out.push(`${pos.fullmove}.`);
    else if (!out.length) out.push(`${pos.fullmove}…`);
    out.push(san);
    makeMove(pos, move);
  }
  return out.length ? out.join(' ') : (fallbackSan || '');
}
