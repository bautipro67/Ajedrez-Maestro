/**
 * game.js — headless game session shared by every mode (bot, local, online,
 * tournament). It owns the position, the move history and the end condition;
 * it never touches the DOM and never runs a clock itself — the screen feeds it
 * clock snapshots and calls timeout() when a flag falls.
 */

import * as C from './chess.js';
import { buildPgn } from './pgn.js';

const RESULT_TEXT = {
  checkmate: 'jaque mate',
  stalemate: 'rey ahogado',
  fifty: 'regla de las 50 jugadas',
  repetition: 'triple repetición',
  insufficient: 'material insuficiente',
  resign: 'abandono',
  timeout: 'se acabó el tiempo',
  agreement: 'tablas acordadas',
  abandon: 'partida abandonada',
  adjudicated: 'partida adjudicada',
};

const PIECE_LETTER = { 1: 'p', 2: 'n', 3: 'b', 4: 'r', 5: 'q', 6: 'k' };
const PIECE_VALUE = { 1: 1, 2: 3, 3: 3, 4: 5, 5: 9, 6: 0 };

export function createGame(config = {}) {
  const cfg = {
    mode: 'local',
    startFen: C.START_FEN,
    timeControl: null,
    rated: false,
    white: { kind: 'human', name: 'Blancas' },
    black: { kind: 'human', name: 'Negras' },
    ...config,
  };

  const pos = C.createPosition(cfg.startFen);
  const startFen = C.getFen(pos);

  const history = [];          // { uci, san, move, fenBefore, fenAfter, ms, clocks, capture }
  const listeners = new Map();

  let status = { over: false, result: '*', reason: null, winner: null, text: '' };
  let drawOfferFrom = null;
  let clocks = { w: null, b: null };

  // Facts collected for the achievement system.
  const facts = {
    maxOwnQueensWhite: 1,
    maxOwnQueensBlack: 1,
    whiteQueenCaptured: false,
    blackQueenCaptured: false,
  };

  /* ------------------------------ events ------------------------------ */

  function on(event, cb) {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(cb);
    return () => listeners.get(event)?.delete(cb);
  }

  function emit(event, payload) {
    for (const cb of listeners.get(event) || []) {
      try {
        cb(payload);
      } catch {
        /* a broken listener must not break the game */
      }
    }
  }

  /* ---------------------------- legal moves --------------------------- */

  function legalMoveList() {
    return C.generateMoves(pos, { legal: true });
  }

  /** Map<'e2', [{to, capture, promotion}]> for board.js. */
  function legalMovesMap() {
    const map = new Map();
    if (status.over) return map;
    for (const move of legalMoveList()) {
      const from = C.squareName(C.moveFrom(move));
      const to = C.squareName(C.moveTo(move));
      let list = map.get(from);
      if (!list) { list = []; map.set(from, list); }
      const existing = list.find((d) => d.to === to);
      const promotion = C.movePromo(move) !== 0;
      if (existing) {
        existing.promotion = existing.promotion || promotion;
        continue;
      }
      list.push({
        to,
        capture: C.isCapture(move) || C.isEnPassant(move),
        promotion,
      });
    }
    return map;
  }

  function findMove(fromName, toName, promoLetter) {
    const from = C.parseSquare(fromName);
    const to = C.parseSquare(toName);
    if (from < 0 || to < 0) return 0;
    const wanted = promoLetter
      ? { p: 0, n: C.KNIGHT, b: C.BISHOP, r: C.ROOK, q: C.QUEEN }[String(promoLetter).toLowerCase()] || 0
      : 0;
    let fallback = 0;
    for (const move of legalMoveList()) {
      if (C.moveFrom(move) !== from || C.moveTo(move) !== to) continue;
      const promo = C.movePromo(move);
      if (promo === 0) return move;
      if (promo === wanted) return move;
      if (!fallback || promo === C.QUEEN) fallback = move;
    }
    return fallback;
  }

  /* ------------------------------- facts ------------------------------ */

  function trackFacts(move) {
    const undo = pos.undoStack[pos.undoStack.length - 1];
    const captured = undo && undo.captured ? C.pieceType(undo.captured) : 0;
    if (captured === C.QUEEN) {
      const victim = C.pieceColor(undo.captured);
      if (victim === C.WHITE) facts.whiteQueenCaptured = true;
      else facts.blackQueenCaptured = true;
    }
    if (C.movePromo(move) === C.QUEEN) {
      let white = 0;
      let black = 0;
      for (let sq = 0; sq < 128; sq++) {
        if (sq & 0x88) continue;
        const pc = pos.board[sq];
        if (!pc || C.pieceType(pc) !== C.QUEEN) continue;
        if (C.pieceColor(pc) === C.WHITE) white += 1;
        else black += 1;
      }
      facts.maxOwnQueensWhite = Math.max(facts.maxOwnQueensWhite, white);
      facts.maxOwnQueensBlack = Math.max(facts.maxOwnQueensBlack, black);
    }
  }

  /* ------------------------------ ending ------------------------------ */

  function setOver(reason, winner) {
    if (status.over) return status;
    const result = winner === C.WHITE ? '1-0' : winner === C.BLACK ? '0-1' : '1/2-1/2';
    status = {
      over: true,
      result,
      reason,
      winner: winner === null || winner === undefined ? null : winner,
      text: RESULT_TEXT[reason] || 'partida terminada',
    };
    drawOfferFrom = null;
    emit('over', status);
    return status;
  }

  function refreshStatus() {
    if (status.over) return status;
    const r = C.gameResult(pos);
    if (r.over) {
      status = {
        over: true,
        result: r.winner === C.WHITE ? '1-0' : r.winner === C.BLACK ? '0-1' : '1/2-1/2',
        reason: r.reason,
        winner: r.winner,
        text: r.text || RESULT_TEXT[r.reason] || '',
      };
      emit('over', status);
    }
    return status;
  }

  /* ------------------------------- moves ------------------------------ */

  function commit(move, meta = {}) {
    const fenBefore = C.getFen(pos);
    const san = C.moveToSan(pos, move);
    const uci = C.moveToUci(move);
    const capture = C.isCapture(move) || C.isEnPassant(move);
    const castle = C.isCastle(move);
    const promotion = C.movePromo(move) !== 0;

    C.makeMove(pos, move);
    trackFacts(move);

    const entry = {
      uci,
      san,
      move,
      fenBefore,
      fenAfter: C.getFen(pos),
      capture,
      castle,
      promotion,
      check: C.inCheck(pos),
      ms: meta.ms || 0,
      clocks: meta.clocks ? { ...meta.clocks } : null,
      by: pos.turn === C.WHITE ? 'b' : 'w',
    };

    history.push(entry);
    if (drawOfferFrom !== null && drawOfferFrom !== entry.by) drawOfferFrom = null;

    emit('move', entry);
    if (entry.check) emit('check', { color: pos.turn });
    refreshStatus();
    return entry;
  }

  /* -------------------------------- API ------------------------------- */

  const api = {
    config: cfg,
    pos,
    history,
    get status() { return status; },

    turn: () => (pos.turn === C.WHITE ? 'w' : 'b'),
    moveNumber: () => pos.fullmove,
    ply: () => history.length,
    getFen: () => C.getFen(pos),
    startFen: () => startFen,
    inCheck: () => C.inCheck(pos),

    kingSquare(color) {
      const c = color === 'w' ? C.WHITE : C.BLACK;
      return C.squareName(pos.kingSq[c]);
    },

    legalMovesMap,

    hasLegalMoves: () => legalMoveList().length > 0,

    /** Attempt a move by square names. Returns {ok, entry} or {ok:false, reason}. */
    tryMove(from, to, promo = null) {
      if (status.over) return { ok: false, reason: 'terminada' };
      const move = findMove(from, to, promo);
      if (!move) return { ok: false, reason: 'ilegal' };
      return { ok: true, entry: commit(move) };
    },

    /** Play a UCI move ('e2e4', 'e7e8q'). Used by bots and by the online client. */
    playUci(uci, meta = {}) {
      if (status.over) return { ok: false, reason: 'terminada' };
      const move = C.uciToMove(pos, uci);
      if (move <= 0) return { ok: false, reason: 'ilegal' };
      return { ok: true, entry: commit(move, meta) };
    },

    playSan(san, meta = {}) {
      if (status.over) return { ok: false, reason: 'terminada' };
      const move = C.sanToMove(pos, san);
      if (move <= 0) return { ok: false, reason: 'ilegal' };
      return { ok: true, entry: commit(move, meta) };
    },

    /** Undo `plies` half-moves. Returns how many were actually undone. */
    takeback(plies = 1) {
      let done = 0;
      for (let i = 0; i < plies && history.length > 0; i++) {
        C.unmakeMove(pos);
        history.pop();
        done += 1;
      }
      if (done) {
        status = { over: false, result: '*', reason: null, winner: null, text: '' };
        drawOfferFrom = null;
        emit('takeback', { plies: done });
        refreshStatus();
      }
      return done;
    },

    resign(color) {
      return setOver('resign', color === 'w' ? C.BLACK : C.WHITE);
    },

    timeout(color) {
      // Flag falls, but if the opponent cannot mate with their material it is a draw.
      const winner = color === 'w' ? C.BLACK : C.WHITE;
      if (!canMateWithMaterial(pos, winner)) return setOver('timeout', null);
      return setOver('timeout', winner);
    },

    abandon(color) {
      return setOver('abandon', color === 'w' ? C.BLACK : C.WHITE);
    },

    offerDraw(color) {
      if (status.over) return false;
      drawOfferFrom = color;
      emit('drawOffer', { from: color });
      return true;
    },

    pendingDrawOffer: () => drawOfferFrom,

    acceptDraw() {
      if (status.over || drawOfferFrom === null) return null;
      return setOver('agreement', null);
    },

    declineDraw() {
      drawOfferFrom = null;
      emit('drawDeclined', {});
    },

    /** Force a specific ending (used by the online client and adjudication). */
    forceResult(result, reason) {
      const winner = result === '1-0' ? C.WHITE : result === '0-1' ? C.BLACK : null;
      return setOver(reason || 'adjudicated', winner);
    },

    setClockSnapshot(times) {
      clocks = { ...clocks, ...times };
    },

    getClockSnapshot: () => ({ ...clocks }),

    sanMoves: () => history.map((h) => h.san),
    uciMoves: () => history.map((h) => h.uci),

    /** FEN after `index` plies (index -1 = the starting position). */
    fenAt(index) {
      if (index < 0) return startFen;
      const entry = history[Math.min(index, history.length - 1)];
      return entry ? entry.fenAfter : startFen;
    },

    lastMoveSquares(index = history.length - 1) {
      const entry = history[index];
      if (!entry) return null;
      return {
        from: entry.uci.slice(0, 2),
        to: entry.uci.slice(2, 4),
        promotion: entry.promotion,
      };
    },

    /** Captured pieces and material balance, computed from the live position. */
    material() {
      const start = { 1: 8, 2: 2, 3: 2, 4: 2, 5: 1 };
      const alive = { w: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }, b: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } };
      let score = 0;
      for (let sq = 0; sq < 128; sq++) {
        if (sq & 0x88) continue;
        const pc = pos.board[sq];
        if (!pc) continue;
        const type = C.pieceType(pc);
        if (type === C.KING) continue;
        const side = C.pieceColor(pc) === C.WHITE ? 'w' : 'b';
        alive[side][type] += 1;
        score += (side === 'w' ? 1 : -1) * PIECE_VALUE[type];
      }
      const capturedByWhite = [];
      const capturedByBlack = [];
      for (const type of [5, 4, 3, 2, 1]) {
        for (let i = alive.b[type]; i < start[type]; i++) capturedByWhite.push(Number(type) | 8);
        for (let i = alive.w[type]; i < start[type]; i++) capturedByBlack.push(Number(type));
      }
      return { capturedByWhite, capturedByBlack, balance: score };
    },

    /** Facts for achievements.analyzeGame(). */
    gameFacts(myColor) {
      const mine = myColor === 'w';
      return {
        maxOwnQueens: mine ? facts.maxOwnQueensWhite : facts.maxOwnQueensBlack,
        sacrificedQueen: mine
          ? facts.whiteQueenCaptured && !facts.blackQueenCaptured
          : facts.blackQueenCaptured && !facts.whiteQueenCaptured,
        materialDiffAtEnd: (mine ? 1 : -1) * api.material().balance,
      };
    },

    getPgn(extraHeaders = {}) {
      const white = cfg.white || {};
      const black = cfg.black || {};
      const tc = cfg.timeControl;
      const headers = {
        Event: extraHeaders.Event || eventName(cfg.mode),
        Site: 'Ajedrez Maestro',
        Date: formatPgnDate(new Date()),
        Round: extraHeaders.Round || '-',
        White: white.name || 'Blancas',
        Black: black.name || 'Negras',
        Result: status.result,
        ...(white.rating ? { WhiteElo: String(Math.round(white.rating)) } : {}),
        ...(black.rating ? { BlackElo: String(Math.round(black.rating)) } : {}),
        ...(tc && tc.base ? { TimeControl: `${tc.base}+${tc.inc || 0}` } : {}),
        ...(startFen !== C.START_FEN ? { SetUp: '1', FEN: startFen } : {}),
        ...(status.reason ? { Termination: RESULT_TEXT[status.reason] || status.reason } : {}),
        ...extraHeaders,
      };
      return buildPgn({ headers, sanMoves: api.sanMoves(), result: status.result });
    },

    on,

    destroy() {
      listeners.clear();
    },
  };

  refreshStatus();
  return api;
}

function eventName(mode) {
  return {
    bot: 'Partida contra la máquina',
    local: 'Partida local',
    online: 'Partida online',
    tournament: 'Torneo',
    analysis: 'Análisis',
  }[mode] || 'Partida';
}

function formatPgnDate(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())}`;
}

/**
 * Can `color` still deliver mate with the material they have left?
 * Lone king, king+knight and king+bishop cannot, so a flag fall is a draw.
 */
function canMateWithMaterial(pos, color) {
  let knights = 0;
  let bishops = 0;
  for (let sq = 0; sq < 128; sq++) {
    if (sq & 0x88) continue;
    const pc = pos.board[sq];
    if (!pc || C.pieceColor(pc) !== color) continue;
    const type = C.pieceType(pc);
    if (type === C.PAWN || type === C.ROOK || type === C.QUEEN) return true;
    if (type === C.KNIGHT) knights += 1;
    if (type === C.BISHOP) bishops += 1;
  }
  if (bishops >= 2) return true;
  if (bishops >= 1 && knights >= 1) return true;
  if (knights >= 3) return true;
  return false;
}

export { PIECE_LETTER, RESULT_TEXT };
