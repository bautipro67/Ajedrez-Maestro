/**
 * engine.js — alpha-beta searcher: iterative deepening, aspiration windows,
 * transposition table, null-move, LMR, futility, staged move ordering and a
 * SEE-driven quiescence search. Environment agnostic (no DOM, no state shared
 * between instances) so it runs in a Web Worker and in Node alike.
 */

import {
  WHITE, PAWN, QUEEN,
  generateMoves, makeMove, unmakeMove, makeNullMove, unmakeNullMove,
  inCheck, clonePosition, isInsufficientMaterial, repetitionCount,
  moveFrom, moveTo, movePromo, isCapture, isEnPassant,
} from './chess.js';
import { evaluate, hasNonPawnMaterial, seeCapture, DEFAULT_WEIGHTS, SEE_PIECE_VALUES } from './eval.js';

export const MATE = 30000;
export const MATE_BOUND = MATE - 256;
const INFINITE = 32000;
const MAX_PLY = 128;

const TT_EXACT = 1;
const TT_LOWER = 2;
const TT_UPPER = 3;

/* Move-ordering bands. Everything is compared inside one Int32 score. */
const ORD_TT = 1 << 30;
const ORD_PROMO = 900000000;
const ORD_GOOD_CAPTURE = 800000000;
const ORD_KILLER_1 = 790000000;
const ORD_KILLER_2 = 780000000;
const ORD_BAD_CAPTURE = 100000000;
const HISTORY_MAX = 90000000;

/* Late move reductions, indexed [depth][moveCount]. */
const LMR = [];
for (let d = 0; d < 64; d++) {
  const row = new Int8Array(64);
  for (let m = 0; m < 64; m++) {
    row[m] = d < 3 || m < 3 ? 0 : Math.min(d - 1, 1 + Math.floor((Math.log(d) * Math.log(m)) / 2.1));
  }
  LMR.push(row);
}

const FUTILITY = [0, 110, 220, 340];

function nextPowerOfTwo(n) {
  let p = 1;
  while (p * 2 <= n) p *= 2;
  return p;
}

/** Deterministic 32-bit mix, used to derive leaf noise from the Zobrist key. */
function mix32(a, b) {
  let h = (a ^ Math.imul(b ^ (b >>> 16), 0x45d9f3b)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

export function createSearcher(options = {}) {
  const sizeMb = Math.max(1, Math.min(256, Number(options.ttSizeMb) || 16));
  const entryCount = nextPowerOfTwo(Math.floor((sizeMb * 1024 * 1024) / 16));
  const ttMask = entryCount - 1;

  /* Four Int32 per entry: keyLo, keyHi, move, packed(score|depth|age|flag). */
  const tt = new Int32Array(entryCount * 4);
  let ttAge = 0;

  const killers = new Int32Array(MAX_PLY * 2);
  const history = new Int32Array(2 * 128 * 128);
  const pvTable = new Int32Array(MAX_PLY * MAX_PLY);
  const pvLength = new Int32Array(MAX_PLY);
  const evalStack = new Int32Array(MAX_PLY);

  /* Per-search state; reset by prepare(). */
  let pos = null;
  let nodes = 0;
  let seldepth = 0;
  let stopped = false;
  let stopRequested = false;
  let deadline = Infinity;
  let nodeLimit = Infinity;
  let weights = DEFAULT_WEIGHTS;
  let contempt = 0;
  let rootSide = WHITE;
  let evalNoise = 0;
  let noiseSeed = 0;
  let useNullMove = true;
  let useLmr = true;
  let useQuiescence = true;
  let maxQDepth = 6;
  let checkCounter = 0;
  let currentPly = 0;

  /* Filled by ttProbe. */
  let probedMove = 0;
  let probedScore = 0;
  let probedDepth = 0;
  let probedFlag = 0;

  function clearTables() {
    tt.fill(0);
    killers.fill(0);
    history.fill(0);
    ttAge = 0;
  }

  function stop() {
    stopRequested = true;
    stopped = true;
  }

  function ttStore(keyLo, keyHi, depth, score, flag, move) {
    const idx = (keyLo & ttMask) * 4;
    const packed = tt[idx + 3];
    const storedDepth = (packed >> 8) & 0xff;
    const storedAge = (packed >> 2) & 0x3f;
    const sameSlot = tt[idx] === keyLo && tt[idx + 1] === keyHi;
    if (!sameSlot && (packed & 3) !== 0 && storedAge === ttAge && storedDepth > depth) return;
    let adjusted = score;
    if (score >= MATE_BOUND) adjusted = score + currentPly;
    else if (score <= -MATE_BOUND) adjusted = score - currentPly;
    tt[idx] = keyLo;
    tt[idx + 1] = keyHi;
    tt[idx + 2] = move || (sameSlot ? tt[idx + 2] : 0);
    tt[idx + 3] = ((adjusted & 0xffff) << 16) | ((depth & 0xff) << 8) | ((ttAge & 0x3f) << 2) | flag;
  }

  /** Fills the probed* fields; returns true when the slot matches the key. */
  function ttProbe(keyLo, keyHi, ply) {
    const idx = (keyLo & ttMask) * 4;
    probedMove = 0;
    probedDepth = -1;
    probedFlag = 0;
    if (tt[idx] !== keyLo || tt[idx + 1] !== keyHi) return false;
    const packed = tt[idx + 3];
    const flag = packed & 3;
    if (flag === 0) return false;
    probedFlag = flag;
    probedDepth = (packed >> 8) & 0xff;
    probedMove = tt[idx + 2];
    let score = packed >> 16;
    if (score >= MATE_BOUND) score -= ply;
    else if (score <= -MATE_BOUND) score += ply;
    probedScore = score;
    return true;
  }

  function drawScore() {
    if (contempt === 0) return 0;
    return pos.turn === rootSide ? -contempt : contempt;
  }

  function leafEval() {
    let score = evaluate(pos, weights);
    if (evalNoise > 0) {
      const h = mix32(pos.keyLo ^ noiseSeed, pos.keyHi);
      score += (h % (evalNoise * 2 + 1)) - evalNoise;
    }
    return score;
  }

  function timeUp() {
    if (stopRequested) return true;
    if (nodes >= nodeLimit) return true;
    if (++checkCounter >= 1024) {
      checkCounter = 0;
      if (Date.now() >= deadline) return true;
    }
    return false;
  }

  function isQuiet(move) {
    return !isCapture(move) && movePromo(move) === 0;
  }

  function historyIndex(move) {
    return ((pos.turn * 128) + moveFrom(move)) * 128 + moveTo(move);
  }

  /** Scores a move list in place into `scores`, for selection sort. */
  function scoreMoves(moves, scores, ttMove, ply) {
    const k1 = killers[ply * 2];
    const k2 = killers[ply * 2 + 1];
    const board = pos.board;
    for (let i = 0; i < moves.length; i++) {
      const m = moves[i];
      if (m === ttMove) {
        scores[i] = ORD_TT;
        continue;
      }
      const promo = movePromo(m);
      if (promo !== 0) {
        scores[i] = ORD_PROMO + SEE_PIECE_VALUES[promo] + (isCapture(m) ? 500 : 0);
        continue;
      }
      if (isCapture(m)) {
        const victim = isEnPassant(m) ? PAWN : (board[moveTo(m)] & 7);
        const attacker = board[moveFrom(m)] & 7;
        const mvvLva = SEE_PIECE_VALUES[victim] * 16 - SEE_PIECE_VALUES[attacker];
        if (SEE_PIECE_VALUES[victim] >= SEE_PIECE_VALUES[attacker]) {
          scores[i] = ORD_GOOD_CAPTURE + mvvLva;
        } else {
          const see = seeCapture(pos, m);
          scores[i] = see >= 0 ? ORD_GOOD_CAPTURE + mvvLva : ORD_BAD_CAPTURE + see;
        }
        continue;
      }
      if (m === k1) {
        scores[i] = ORD_KILLER_1;
        continue;
      }
      if (m === k2) {
        scores[i] = ORD_KILLER_2;
        continue;
      }
      const h = history[historyIndex(m)];
      scores[i] = h > HISTORY_MAX ? HISTORY_MAX : h;
    }
  }

  /** Selection sort step: brings the best remaining move to index `i`. */
  function pickMove(moves, scores, i) {
    let best = i;
    for (let j = i + 1; j < moves.length; j++) {
      if (scores[j] > scores[best]) best = j;
    }
    if (best !== i) {
      const m = moves[i];
      moves[i] = moves[best];
      moves[best] = m;
      const s = scores[i];
      scores[i] = scores[best];
      scores[best] = s;
    }
  }

  function recordKiller(move, ply) {
    const base = ply * 2;
    if (killers[base] === move) return;
    killers[base + 1] = killers[base];
    killers[base] = move;
  }

  function bumpHistory(move, depth) {
    const idx = historyIndex(move);
    const value = history[idx] + depth * depth * 32;
    history[idx] = value > HISTORY_MAX ? HISTORY_MAX : value;
  }

  function quiescence(alpha, beta, ply, qdepth) {
    nodes++;
    if (ply > seldepth) seldepth = ply;
    if (timeUp()) {
      stopped = true;
      return alpha;
    }
    if (ply >= MAX_PLY - 1) return leafEval();

    const checked = inCheck(pos);
    let best = -INFINITE;
    if (!checked) {
      best = leafEval();
      if (best >= beta) return best;
      if (best > alpha) alpha = best;
      if (qdepth <= 0) return best;
      /* Delta pruning: even winning a queen would not reach alpha. */
      if (best + SEE_PIECE_VALUES[QUEEN] + 200 < alpha) return best;
    } else if (qdepth <= -4) {
      return leafEval();
    }

    const moves = checked
      ? generateMoves(pos, { legal: true })
      : generateMoves(pos, { legal: true, captures: true });
    if (moves.length === 0) return checked ? -MATE + ply : best;

    const scores = new Int32Array(moves.length);
    scoreMoves(moves, scores, 0, ply);

    for (let i = 0; i < moves.length; i++) {
      pickMove(moves, scores, i);
      const move = moves[i];
      /* Once the good captures run out there is nothing left worth trying. */
      if (!checked && movePromo(move) === 0 && scores[i] < ORD_GOOD_CAPTURE) break;
      currentPly = ply;
      makeMove(pos, move);
      const score = -quiescence(-beta, -alpha, ply + 1, qdepth - 1);
      unmakeMove(pos);
      if (stopped) return best > -INFINITE ? best : alpha;
      if (score > best) {
        best = score;
        if (score > alpha) {
          alpha = score;
          if (score >= beta) return score;
        }
      }
    }
    return best;
  }

  function negamax(depth, alpha, beta, ply, canNull) {
    const isPv = beta - alpha > 1;
    pvLength[ply] = ply;

    if (ply > 0) {
      if (repetitionCount(pos) >= 2 || pos.halfmove >= 100 || isInsufficientMaterial(pos)) {
        return drawScore();
      }
      /* Mate distance pruning. */
      const mateAlpha = alpha > -MATE + ply ? alpha : -MATE + ply;
      const mateBeta = beta < MATE - ply - 1 ? beta : MATE - ply - 1;
      if (mateAlpha >= mateBeta) return mateAlpha;
      alpha = mateAlpha;
      beta = mateBeta;
    }

    if (depth <= 0) {
      if (!useQuiescence) {
        nodes++;
        if (ply > seldepth) seldepth = ply;
        return leafEval();
      }
      return quiescence(alpha, beta, ply, maxQDepth);
    }

    nodes++;
    if (ply > seldepth) seldepth = ply;
    if (timeUp()) {
      stopped = true;
      return alpha;
    }
    if (ply >= MAX_PLY - 1) return leafEval();

    const keyLo = pos.keyLo;
    const keyHi = pos.keyHi;
    let ttMove = 0;
    if (ttProbe(keyLo, keyHi, ply)) {
      ttMove = probedMove;
      if (!isPv && probedDepth >= depth) {
        if (probedFlag === TT_EXACT) return probedScore;
        if (probedFlag === TT_LOWER && probedScore >= beta) return probedScore;
        if (probedFlag === TT_UPPER && probedScore <= alpha) return probedScore;
      }
    }

    const checked = inCheck(pos);
    if (checked) depth++;

    const staticEval = checked ? -INFINITE : leafEval();
    evalStack[ply] = staticEval;
    const improving = !checked && ply >= 2 && staticEval > evalStack[ply - 2];

    if (!isPv && !checked) {
      /* Reverse futility: so far ahead that a quiet move still holds. */
      if (depth <= 4 && staticEval - 85 * (depth - (improving ? 1 : 0)) >= beta &&
          staticEval < MATE_BOUND) {
        return staticEval;
      }
      /* Null-move pruning. */
      if (useNullMove && canNull && depth >= 3 && staticEval >= beta &&
          hasNonPawnMaterial(pos, pos.turn)) {
        const reduction = 2 + Math.floor(depth / 6);
        currentPly = ply;
        makeNullMove(pos);
        const score = -negamax(depth - 1 - reduction, -beta, -beta + 1, ply + 1, false);
        unmakeNullMove(pos);
        if (stopped) return alpha;
        if (score >= beta) return score < MATE_BOUND ? score : beta;
      }
    }

    const moves = generateMoves(pos, { legal: true });
    if (moves.length === 0) return checked ? -MATE + ply : drawScore();

    const scores = new Int32Array(moves.length);
    scoreMoves(moves, scores, ttMove, ply);

    const futilityPrune = !isPv && !checked && depth <= 3 &&
      staticEval + FUTILITY[depth] <= alpha && Math.abs(alpha) < MATE_BOUND;

    let best = -INFINITE;
    let bestMove = 0;
    let flag = TT_UPPER;

    for (let i = 0; i < moves.length; i++) {
      pickMove(moves, scores, i);
      const move = moves[i];
      const quiet = isQuiet(move);

      if (quiet && futilityPrune && i > 0 && best > -MATE_BOUND) continue;

      currentPly = ply;
      makeMove(pos, move);
      const givesCheck = inCheck(pos);

      let score;
      if (i === 0) {
        score = -negamax(depth - 1, -beta, -alpha, ply + 1, true);
      } else {
        let reduction = 0;
        if (useLmr && quiet && depth >= 3 && !checked && !givesCheck) {
          const d = depth < 63 ? depth : 63;
          const mc = i < 63 ? i : 63;
          reduction = LMR[d][mc];
          if (isPv && reduction > 0) reduction--;
          if (!improving && reduction < depth - 2) reduction++;
          if (scores[i] >= ORD_KILLER_2 && reduction > 0) reduction--;
        }
        score = -negamax(depth - 1 - reduction, -alpha - 1, -alpha, ply + 1, true);
        if (score > alpha && reduction > 0) {
          score = -negamax(depth - 1, -alpha - 1, -alpha, ply + 1, true);
        }
        if (score > alpha && score < beta) {
          score = -negamax(depth - 1, -beta, -alpha, ply + 1, true);
        }
      }
      unmakeMove(pos);
      if (stopped) return best > -INFINITE ? best : alpha;

      if (score > best) {
        best = score;
        bestMove = move;
        if (score > alpha) {
          alpha = score;
          flag = TT_EXACT;
          /* Copy the child PV up into this ply. */
          pvTable[ply * MAX_PLY + ply] = move;
          const childBase = (ply + 1) * MAX_PLY;
          for (let j = ply + 1; j < pvLength[ply + 1]; j++) {
            pvTable[ply * MAX_PLY + j] = pvTable[childBase + j];
          }
          pvLength[ply] = pvLength[ply + 1] > ply + 1 ? pvLength[ply + 1] : ply + 1;
          if (score >= beta) {
            flag = TT_LOWER;
            if (quiet) {
              recordKiller(move, ply);
              bumpHistory(move, depth);
            }
            break;
          }
        }
      }
    }

    if (best === -INFINITE) {
      /* Every move was futility-pruned: fall back to the static score. */
      best = staticEval;
      flag = TT_UPPER;
    } else {
      currentPly = ply;
      ttStore(keyLo, keyHi, depth, best, flag, bestMove);
    }
    return best;
  }

  /** The PV collected at ply 0, as a plain array of moves. */
  function collectPv() {
    const out = [];
    for (let i = 0; i < pvLength[0]; i++) out.push(pvTable[i]);
    return out;
  }

  /** Builds a root move's PV: the move itself plus the line found below it. */
  function rootPv(move) {
    const child = [];
    for (let i = 1; i < pvLength[1]; i++) child.push(pvTable[MAX_PLY + i]);
    return [move, ...child];
  }

  function mateIn(score) {
    if (score >= MATE_BOUND) return Math.ceil((MATE - score) / 2);
    if (score <= -MATE_BOUND) return -Math.ceil((MATE + score) / 2);
    return null;
  }

  function prepare(sourcePos, limits) {
    pos = clonePosition(sourcePos);
    pos.undoStack.length = 0;
    nodes = 0;
    seldepth = 0;
    stopped = false;
    stopRequested = false;
    checkCounter = 0;
    currentPly = 0;
    weights = limits.weights || DEFAULT_WEIGHTS;
    contempt = Number(weights.contempt) || 0;
    rootSide = pos.turn;
    evalNoise = Math.max(0, Math.floor(Number(limits.evalNoise) || 0));
    useNullMove = limits.useNullMove !== false;
    useLmr = limits.useLmr !== false;
    useQuiescence = limits.quiescence !== false;
    maxQDepth = Number.isFinite(limits.maxQDepth) ? Math.max(0, limits.maxQDepth) : 6;
    nodeLimit = Number.isFinite(limits.nodes) ? Math.max(1, limits.nodes) : Infinity;
    const timeMs = Number.isFinite(limits.timeMs) ? Math.max(1, limits.timeMs) : 1000;
    deadline = Date.now() + timeMs;
    if (evalNoise > 0) {
      const rng = typeof limits.rng === 'function' ? limits.rng : null;
      if (!rng) throw new Error('evalNoise requiere un rng inyectado en limits.rng.');
      noiseSeed = Math.floor(rng() * 4294967296) >>> 0;
    } else {
      noiseSeed = 0;
    }
    ttAge = (ttAge + 1) & 0x3f;
    killers.fill(0);
    /* Fade history instead of clearing it: ordering from the previous search
       is still useful, just less trusted. */
    for (let i = 0; i < history.length; i++) history[i] >>= 3;
    return Math.max(1, Math.min(64, Number.isFinite(limits.depth) ? limits.depth : 64));
  }

  /**
   * Iterative deepening. `exactScores` searches every root move with a full
   * window so each one gets an honest value (the bots need that spread to pick
   * human-looking moves); otherwise the root uses PVS, which is faster but
   * only trusts the best move.
   */
  function runSearch(sourcePos, limits, exactScores) {
    const started = Date.now();
    const maxDepth = prepare(sourcePos, limits);

    const rootMoves = generateMoves(pos, { legal: true });
    if (rootMoves.length === 0) {
      const score = inCheck(pos) ? -MATE : 0;
      return {
        best: 0, score, mate: mateIn(score), depth: 0, seldepth: 0,
        nodes: 0, timeMs: Date.now() - started, pv: [], moves: [],
      };
    }

    const entries = rootMoves.map((move) => ({ move, score: -INFINITE, pv: [move], mate: null }));
    let bestScore = 0;
    let bestEntry = entries[0];
    let completedDepth = 0;

    for (let depth = 1; depth <= maxDepth; depth++) {
      let alpha = -INFINITE;
      let beta = INFINITE;
      let delta = 24;
      if (depth >= 4 && Math.abs(bestScore) < MATE_BOUND) {
        alpha = bestScore - delta;
        beta = bestScore + delta;
      }

      /* The previous iteration's best move, under the aspiration window. */
      const first = entries[0];
      let firstScore = -INFINITE;
      for (;;) {
        currentPly = 0;
        makeMove(pos, first.move);
        firstScore = -negamax(depth - 1, -beta, -alpha, 1, true);
        unmakeMove(pos);
        if (stopped) break;
        if (firstScore <= alpha && alpha > -INFINITE) {
          delta *= 2;
          alpha = firstScore - delta;
          continue;
        }
        if (firstScore >= beta && beta < INFINITE) {
          delta *= 2;
          beta = firstScore + delta;
          continue;
        }
        break;
      }
      if (stopped && completedDepth > 0) break;
      first.score = firstScore;
      first.mate = mateIn(firstScore);
      first.pv = rootPv(first.move);

      let iterationBest = first;
      let cut = false;
      for (let i = 1; i < entries.length; i++) {
        const entry = entries[i];
        currentPly = 0;
        makeMove(pos, entry.move);
        let score;
        if (exactScores) {
          score = -negamax(depth - 1, -INFINITE, INFINITE, 1, true);
        } else {
          const bound = iterationBest.score;
          score = -negamax(depth - 1, -bound - 1, -bound, 1, true);
          if (score > bound) score = -negamax(depth - 1, -INFINITE, -bound, 1, true);
        }
        unmakeMove(pos);
        if (stopped) {
          cut = true;
          break;
        }
        entry.score = score;
        entry.mate = mateIn(score);
        entry.pv = rootPv(entry.move);
        if (score > iterationBest.score) iterationBest = entry;
      }

      if (!cut) {
        entries.sort((a, b) => b.score - a.score);
        bestEntry = entries[0];
        bestScore = bestEntry.score;
        completedDepth = depth;
      } else if (completedDepth === 0) {
        bestEntry = iterationBest;
        bestScore = iterationBest.score;
        completedDepth = depth;
      }

      if (stopped) break;
      if (Math.abs(bestScore) >= MATE_BOUND) break;
      if (Date.now() >= deadline) break;
      if (nodes >= nodeLimit) break;
    }

    return {
      best: bestEntry.move,
      score: bestScore,
      mate: mateIn(bestScore),
      depth: completedDepth,
      seldepth,
      nodes,
      timeMs: Date.now() - started,
      pv: bestEntry.pv.slice(),
      moves: entries.map((e) => ({ move: e.move, score: e.score, pv: e.pv.slice(), mate: e.mate })),
    };
  }

  return {
    search(position, limits = {}) {
      const result = runSearch(position, limits, false);
      delete result.moves;
      return result;
    },
    searchRoot(position, limits = {}) {
      return runSearch(position, limits, limits.exactRootScores !== false);
    },
    stop,
    clearTables,
  };
}
