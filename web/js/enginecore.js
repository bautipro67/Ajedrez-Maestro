/**
 * enginecore.js — the actual bot/analysis logic, shared by worker.js (normal
 * case) and by ai.js when Web Workers are unavailable and the engine has to
 * run on the main thread. Nothing in here touches the DOM or postMessage.
 */

import * as C from './chess.js';
import { createSearcher } from './engine.js';
import { DEFAULT_WEIGHTS } from './eval.js';
import { bookMove, openingName } from './book.js';
import { botById, strengthProfile, chooseBotMove } from './bots.js';

let searcher = createSearcher({ ttSizeMb: 16 });

/** Deterministic PRNG so a given seed always replays the same bot decisions. */
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

function mergedProfile(bot) {
  const base = strengthProfile(bot.elo);
  return { ...base, ...(bot.strength || {}) };
}

function mergedWeights(bot) {
  return { ...DEFAULT_WEIGHTS, ...(bot.weights || {}) };
}

/** How long the UI should wait before showing the move, for a human feel. */
function humanDelay(profile, rng, { critical = false } = {}) {
  const range = profile.thinkMs || [250, 900];
  const min = range[0];
  const max = Math.max(range[1], range[0]);
  const base = min + rng() * (max - min);
  return Math.round(critical ? base * (1.4 + rng() * 0.8) : base);
}

export function handleBotMove(msg) {
  const { fen, botId, moveNumber = 1, seed = 1, timeBudgetMs } = msg;
  const bot = botById(botId);
  if (!bot) throw new Error(`Bot desconocido: ${botId}`);

  const pos = C.createPosition(fen);
  const profile = mergedProfile(bot);
  const weights = mergedWeights(bot);
  const rng = mulberry32((seed ^ (moveNumber * 2654435761)) >>> 0);

  const legal = C.generateMoves(pos, { legal: true });
  if (!legal.length) return { uci: null, san: null, score: 0, rootMoves: [] };

  // Opening book first — it is what gives each bot its repertoire.
  const history = Array.isArray(msg.history) ? msg.history : [];
  if (bot.book && bot.book !== 'none' && history.length < 24) {
    const chosen = bookMove(pos, bot.book, rng);
    if (chosen && chosen > 0 && legal.includes(chosen)) {
      const san = C.moveToSan(pos, chosen);
      let name = null;
      try {
        const sans = sanListFromHistory(fen, history);
        name = openingName([...sans, san]);
      } catch {
        name = null;
      }
      return {
        uci: C.moveToUci(chosen),
        san,
        score: 0,
        mate: null,
        depth: 0,
        nodes: 0,
        elapsedMs: 0,
        fromBook: true,
        bookName: name ? `${name.eco} ${name.name}` : null,
        rootMoves: [],
        thinkMs: Math.round((profile.thinkMs?.[0] ?? 250) * (0.5 + rng() * 0.5)),
      };
    }
  }

  const inCheckNow = C.inCheck(pos);
  const blind = profile.tacticalBlindness > 0 && rng() < profile.tacticalBlindness;

  const limits = {
    depth: blind ? Math.min(2, profile.depth) : profile.depth,
    nodes: profile.nodes,
    timeMs: timeBudgetMs ? Math.min(profile.timeMs, timeBudgetMs) : profile.timeMs,
    weights,
    evalNoise: profile.evalNoise,
    rng,
    quiescence: blind ? false : profile.quiescence !== false,
    maxQDepth: profile.maxQDepth,
    useNullMove: profile.depth >= 4,
    useLmr: profile.depth >= 4,
    /* Puntuar con exactitud TODAS las jugadas de raiz cuesta tres o cuatro
       plies. Los bots flojos lo necesitan, porque reparten con softmax sobre
       el conjunto; los fuertes tienen la temperatura tan baja que solo miran
       las primeras, asi que ahi se cambia exactitud por profundidad. */
    exactRootScores: profile.temperature <= 60 ? 8 : true,
  };

  const started = Date.now();
  const result = searcher.searchRoot(pos, limits);
  const elapsedMs = Date.now() - started;

  const rootMoves = result.moves || [];
  const ctx = {
    pos,
    moveNumber,
    myColor: pos.turn,
    inCheck: inCheckNow,
    materialDiff: materialBalance(pos),
    phase: rootMoves.length,
  };

  let chosen = chooseBotMove(rootMoves, profile, rng, ctx);
  if (!chosen || !legal.includes(chosen)) chosen = result.best || legal[0];

  const picked = rootMoves.find((m) => m.move === chosen);
  const critical = inCheckNow || (picked && Math.abs(picked.score) > 250);

  return {
    uci: C.moveToUci(chosen),
    san: C.moveToSan(pos, chosen),
    score: picked ? picked.score : result.score,
    mate: result.mate ?? null,
    depth: result.depth,
    nodes: result.nodes,
    elapsedMs,
    fromBook: false,
    bookName: null,
    rootMoves: rootMoves.slice(0, 12).map((m) => ({ uci: C.moveToUci(m.move), score: m.score })),
    thinkMs: Math.max(0, humanDelay(profile, rng, { critical }) - elapsedMs),
  };
}

function sanListFromHistory(currentFen, history) {
  // Rebuild SAN from the UCI history so openingName() can match a line.
  const start = C.createPosition();
  const sans = [];
  for (const uci of history) {
    const move = C.uciToMove(start, uci);
    if (move <= 0) return sans;
    sans.push(C.moveToSan(start, move));
    C.makeMove(start, move);
  }
  return sans;
}

function materialBalance(pos) {
  const value = { 1: 100, 2: 325, 3: 335, 4: 500, 5: 975, 6: 0 };
  let score = 0;
  for (let sq = 0; sq < 128; sq++) {
    if (sq & 0x88) continue;
    const pc = pos.board[sq];
    if (!pc) continue;
    score += (C.pieceColor(pc) === pos.turn ? 1 : -1) * (value[C.pieceType(pc)] || 0);
  }
  return score;
}

export function handleAnalyze(msg) {
  const { fen, depth = 14, timeMs = 1200, multiPv = 1 } = msg;
  const pos = C.createPosition(fen);
  const legal = C.generateMoves(pos, { legal: true });
  if (!legal.length) return { lines: [], depth: 0, nodes: 0 };

  const result = searcher.searchRoot(pos, {
    depth, timeMs, weights: DEFAULT_WEIGHTS, quiescence: true,
    /* Solo las lineas que se van a enseñar necesitan puntuacion exacta. */
    exactRootScores: Math.max(1, multiPv),
  });

  const lines = (result.moves || []).slice(0, Math.max(1, multiPv)).map((entry) => ({
    uci: C.moveToUci(entry.move),
    san: C.moveToSan(pos, entry.move),
    pvUci: (entry.pv || []).map((m) => C.moveToUci(m)),
    score: entry.score,
    mate: entry.mate ?? null,
  }));

  return { lines, depth: result.depth, nodes: result.nodes, score: result.score, mate: result.mate ?? null };
}

export function handleEvalOnly(msg) {
  const pos = C.createPosition(msg.fen);
  const result = searcher.search(pos, { depth: 6, timeMs: 220, weights: DEFAULT_WEIGHTS, quiescence: true });
  return { score: result.score, mate: result.mate ?? null, bestUci: result.best ? C.moveToUci(result.best) : null };
}

export function stopSearch() {
  searcher.stop();
}

export function newGame() {
  searcher.clearTables();
}

export function resetSearcher() {
  searcher = createSearcher({ ttSizeMb: 16 });
}
