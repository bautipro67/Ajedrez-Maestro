/**
 * ai.js — main-thread facade over the search. Manages a small pool of module
 * workers and hands out promises. If Web Workers are not available it falls
 * back to running enginecore.js inline, so the app still works (just less
 * smoothly) instead of breaking.
 */

const WORKER_URL = new URL('./worker.js', import.meta.url);

export function createAI({ workers = 1 } = {}) {
  const count = Math.max(1, Math.min(4, workers));
  const pending = new Map();
  let nextId = 1;
  let pool = [];
  let inlineCore = null;
  let usingWorkers = true;

  function spawn() {
    const worker = new Worker(WORKER_URL, { type: 'module' });
    const slot = { worker, jobs: 0 };
    worker.onmessage = (event) => {
      const msg = event.data || {};
      const entry = pending.get(msg.id);
      if (!entry) return;
      pending.delete(msg.id);
      slot.jobs = Math.max(0, slot.jobs - 1);
      if (msg.type === 'error') entry.reject(new Error(msg.message || 'Error del motor'));
      else entry.resolve(msg);
    };
    worker.onerror = (event) => {
      // A hard worker failure: fail every job it was holding.
      for (const [id, entry] of [...pending]) {
        if (entry.slot === slot) {
          pending.delete(id);
          entry.reject(new Error(event.message || 'El motor falló'));
        }
      }
      slot.jobs = 0;
    };
    return slot;
  }

  try {
    if (typeof Worker === 'undefined') throw new Error('sin Worker');
    pool = Array.from({ length: count }, spawn);
  } catch {
    usingWorkers = false;
    pool = [];
  }

  async function ensureInline() {
    if (!inlineCore) inlineCore = await import('./enginecore.js');
    return inlineCore;
  }

  function leastBusy() {
    let best = pool[0];
    for (const slot of pool) if (slot.jobs < best.jobs) best = slot;
    return best;
  }

  async function request(type, payload) {
    if (!usingWorkers) {
      const core = await ensureInline();
      // Yield once so the UI can paint before a long synchronous search.
      await new Promise((r) => setTimeout(r, 0));
      if (type === 'botMove') return { type: 'botMove', ...core.handleBotMove(payload) };
      if (type === 'analyze') return { type: 'analysis', ...core.handleAnalyze(payload) };
      if (type === 'evalOnly') return { type: 'evalOnly', ...core.handleEvalOnly(payload) };
      return {};
    }
    const slot = leastBusy();
    const id = nextId++;
    slot.jobs += 1;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, slot });
      slot.worker.postMessage({ id, type, ...payload });
    });
  }

  function broadcast(type) {
    if (!usingWorkers) {
      if (inlineCore) {
        if (type === 'stop') inlineCore.stopSearch();
        if (type === 'newGame') inlineCore.newGame();
        if (type === 'reset') inlineCore.resetSearcher();
      }
      return;
    }
    for (const slot of pool) slot.worker.postMessage({ type });
  }

  return {
    usingWorkers: () => usingWorkers,
    poolSize: () => pool.length || 1,
    busy: () => pending.size > 0,

    /**
     * Ask a bot for its move.
     * @returns {Promise<{uci, san, score, mate, depth, nodes, fromBook, bookName, thinkMs, rootMoves}>}
     */
    botMove({ fen, botId, history = [], moveNumber = 1, seed = 1, timeBudgetMs = null, elo = null }) {
      return request('botMove', { fen, botId, history, moveNumber, seed, timeBudgetMs, elo });
    },

    analyze({ fen, depth = 14, timeMs = 1200, multiPv = 1 }) {
      return request('analyze', { fen, depth, timeMs, multiPv });
    },

    evalOnly(fen) {
      return request('evalOnly', { fen }).then((r) => r.score);
    },

    stop() { broadcast('stop'); },
    newGame() { broadcast('newGame'); },
    reset() { broadcast('reset'); },

    terminate() {
      for (const slot of pool) slot.worker.terminate();
      pool = [];
      for (const [, entry] of pending) entry.reject(new Error('Motor detenido'));
      pending.clear();
    },
  };
}

/**
 * Wait for a bot move and honour its "thinking" delay, so a 300 Elo bot does
 * not answer a complex position in 4 ms. Resolves with the same payload.
 */
export async function botMoveWithDelay(ai, params, { minDelayMs = 180 } = {}) {
  const started = Date.now();
  const result = await ai.botMove(params);
  const wait = Math.max(minDelayMs, result.thinkMs || 0) - (Date.now() - started);
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  return result;
}

/**
 * Classify how much a move cost, comparing the evaluation before and after
 * (both from the mover's point of view, in centipawns).
 */
export function classifyMove(before, after, { wasBest = false, isOnlyMove = false } = {}) {
  const loss = before - after;
  if (isOnlyMove) return 'good';
  if (loss <= -80 && wasBest) return 'brilliant';
  if (loss <= 20) return 'good';
  if (loss <= 60) return 'inaccuracy';
  if (loss <= 180) return 'mistake';
  return 'blunder';
}

export const MOVE_QUALITY_LABEL = {
  brilliant: 'Brillante',
  good: 'Buena',
  inaccuracy: 'Imprecisión',
  mistake: 'Error',
  blunder: 'Error grave',
};

/** Rough accuracy percentage from the average centipawn loss of a side. */
export function accuracyFromLoss(averageCentipawnLoss) {
  const cpl = Math.max(0, averageCentipawnLoss);
  const value = 103.1668 * Math.exp(-0.04354 * (cpl / 2)) - 3.1669;
  return Math.max(0, Math.min(100, value));
}
