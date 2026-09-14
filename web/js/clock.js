/**
 * clock.js — chess clock with Fischer increment and optional simple delay.
 * Time is tracked against performance.now() deltas rather than accumulated
 * interval ticks, so the clock stays accurate even when the tab is throttled
 * in the background. All public times are in milliseconds.
 */

const TICK_MS = 100;

/**
 * @param {object} cfg
 *   base   seconds on the clock for each side (0 = untimed)
 *   inc    seconds added after each move
 *   delay  seconds of simple delay before the clock starts running (default 0)
 *   onTick (times) => void, called every 100 ms while running
 *   onFlag (color) => void, called once when a side runs out ('w' | 'b')
 */
export function createClock({ base = 300, inc = 0, delay = 0, onTick = null, onFlag = null } = {}) {
  const untimed = !base || base <= 0;
  const state = {
    w: untimed ? Infinity : base * 1000,
    b: untimed ? Infinity : base * 1000,
  };
  const incMs = Math.max(0, inc) * 1000;
  const delayMs = Math.max(0, delay) * 1000;

  let running = null;       // 'w' | 'b' | null
  let anchor = 0;           // performance.now() when the current side started
  let delayLeft = 0;        // remaining simple delay for the running side
  let timer = null;
  let flagged = { w: false, b: false };
  let destroyed = false;

  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

  function elapsedOnRunner() {
    if (running === null) return 0;
    const raw = now() - anchor;
    return Math.max(0, raw - delayLeft);
  }

  /** Current times without mutating state. */
  function getTimes() {
    const t = { w: state.w, b: state.b };
    if (running && !untimed) t[running] = Math.max(0, state[running] - elapsedOnRunner());
    return t;
  }

  function settleRunner() {
    if (running === null || untimed) return;
    state[running] = Math.max(0, state[running] - elapsedOnRunner());
  }

  function checkFlag() {
    if (untimed || running === null) return false;
    const t = getTimes();
    if (t[running] <= 0 && !flagged[running]) {
      const side = running;
      state[side] = 0;
      flagged[side] = true;
      stopTimer();
      running = null;
      if (onFlag) onFlag(side);
      return true;
    }
    return false;
  }

  function startTimer() {
    if (timer !== null || untimed) return;
    timer = setInterval(() => {
      if (destroyed) return;
      if (checkFlag()) return;
      if (onTick) onTick(getTimes());
    }, TICK_MS);
  }

  function stopTimer() {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  }

  return {
    /** Begin counting down for `color` ('w' | 'b'). */
    start(color) {
      if (untimed) { running = color; return; }
      settleRunner();
      running = color;
      anchor = now();
      delayLeft = delayMs;
      startTimer();
      if (onTick) onTick(getTimes());
    },

    /**
     * A move was completed by `color`: bank their remaining time, add the
     * increment and hand the clock to the opponent.
     */
    press(color) {
      if (untimed) { running = color === 'w' ? 'b' : 'w'; return getTimes(); }
      if (running !== null && running !== color) settleRunner();
      else settleRunner();
      if (!flagged[color]) state[color] = Math.max(0, state[color] + incMs);
      running = color === 'w' ? 'b' : 'w';
      anchor = now();
      delayLeft = delayMs;
      startTimer();
      if (onTick) onTick(getTimes());
      return getTimes();
    },

    pause() {
      settleRunner();
      stopTimer();
      const wasRunning = running;
      running = null;
      return wasRunning;
    },

    resume(color) {
      if (running !== null) return;
      running = color;
      anchor = now();
      delayLeft = delayMs;
      startTimer();
    },

    stop() {
      settleRunner();
      stopTimer();
      running = null;
    },

    getTimes,
    isRunning: () => running !== null,
    runningColor: () => running,
    isUntimed: () => untimed,

    /** Overwrite both clocks — used to sync with the authoritative server clock. */
    setTimes(times) {
      if (untimed) return;
      if (typeof times.w === 'number') state.w = Math.max(0, times.w);
      if (typeof times.b === 'number') state.b = Math.max(0, times.b);
      if (state.w > 0) flagged.w = false;
      if (state.b > 0) flagged.b = false;
      anchor = now();
      if (onTick) onTick(getTimes());
    },

    addTime(color, ms) {
      if (untimed) return;
      settleRunner();
      state[color] = Math.max(0, state[color] + ms);
      anchor = now();
      if (onTick) onTick(getTimes());
    },

    destroy() {
      destroyed = true;
      stopTimer();
      running = null;
    },
  };
}

/**
 * '5:03' normally, '0:09.4' under 20 s, '1:05:00' when there are hours.
 * Untimed clocks render as an infinity sign.
 */
export function formatClock(ms) {
  if (!Number.isFinite(ms)) return '∞';
  const t = Math.max(0, ms);
  const totalSeconds = t / 1000;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(Math.floor(seconds)).padStart(2, '0')}`;
  }
  if (t < 20000) {
    return `${minutes}:${seconds.toFixed(1).padStart(4, '0')}`;
  }
  return `${minutes}:${String(Math.floor(seconds)).padStart(2, '0')}`;
}

/** Time controls offered in the UI, grouped by category. */
export const TIME_CONTROLS = [
  { id: 'sin-reloj', label: 'Sin reloj', base: 0, inc: 0, category: 'casual' },
  { id: '1+0', label: '1 min', base: 60, inc: 0, category: 'bullet' },
  { id: '2+1', label: '2 | 1', base: 120, inc: 1, category: 'bullet' },
  { id: '3+0', label: '3 min', base: 180, inc: 0, category: 'blitz' },
  { id: '3+2', label: '3 | 2', base: 180, inc: 2, category: 'blitz' },
  { id: '5+0', label: '5 min', base: 300, inc: 0, category: 'blitz' },
  { id: '5+3', label: '5 | 3', base: 300, inc: 3, category: 'blitz' },
  { id: '10+0', label: '10 min', base: 600, inc: 0, category: 'rapid' },
  { id: '10+5', label: '10 | 5', base: 600, inc: 5, category: 'rapid' },
  { id: '15+10', label: '15 | 10', base: 900, inc: 10, category: 'rapid' },
  { id: '30+0', label: '30 min', base: 1800, inc: 0, category: 'classical' },
  { id: '30+20', label: '30 | 20', base: 1800, inc: 20, category: 'classical' },
];

/** Rating category for a time control, following the usual online convention. */
export function timeCategory(base, inc) {
  if (!base || base <= 0) return 'casual';
  const estimate = base + 40 * (inc || 0);
  if (estimate < 179) return 'bullet';
  if (estimate < 479) return 'blitz';
  if (estimate < 1499) return 'rapid';
  return 'classical';
}

export const CATEGORY_NAMES = {
  bullet: 'Bala',
  blitz: 'Relámpago',
  rapid: 'Rápida',
  classical: 'Clásica',
  casual: 'Sin reloj',
  bots: 'Contra bots',
};
