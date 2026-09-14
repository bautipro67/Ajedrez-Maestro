/**
 * sound.js — every game sound is synthesised with WebAudio, so the app ships
 * without a single audio asset. The AudioContext is created lazily on the
 * first user gesture, as browsers require.
 */

let ctx = null;
let master = null;
let enabled = true;
let volume = 0.6;
let noiseBuffer = null;

/** Called once at startup with the persisted settings. */
export function initSound(settings = {}) {
  if (typeof settings.sound === 'boolean') enabled = settings.sound;
  if (typeof settings.volume === 'number') volume = clamp(settings.volume, 0, 1);
  if (typeof document !== 'undefined') {
    const unlock = () => { ensureContext(); };
    document.addEventListener('pointerdown', unlock, { once: true, passive: true });
    document.addEventListener('keydown', unlock, { once: true });
  }
}

export function setEnabled(value) {
  enabled = !!value;
}

export function setVolume(value) {
  volume = clamp(value, 0, 1);
  if (master) master.gain.value = volume;
}

export function isEnabled() {
  return enabled;
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

function ensureContext() {
  if (ctx) {
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }
  const AC = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
  if (!AC) return null;
  ctx = new AC();
  master = ctx.createGain();
  master.gain.value = volume;
  master.connect(ctx.destination);
  return ctx;
}

function makeNoise() {
  if (noiseBuffer || !ctx) return noiseBuffer;
  const length = Math.floor(ctx.sampleRate * 0.25);
  noiseBuffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = noiseBuffer.getChannelData(0);
  let seed = 12345;
  for (let i = 0; i < length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    data[i] = (seed / 0x3fffffff) - 1;
  }
  return noiseBuffer;
}

/** A short pitched blip. */
function tone({ freq, type = 'sine', start = 0, dur = 0.12, gain = 0.3, sweepTo = null, attack = 0.004 }) {
  const t0 = ctx.currentTime + start;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (sweepTo) osc.frequency.exponentialRampToValueAtTime(Math.max(1, sweepTo), t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t0 + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g).connect(master);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

/** A filtered noise burst — the woody part of a piece landing on the board. */
function thud({ start = 0, dur = 0.09, gain = 0.35, freq = 900, q = 1.6, type = 'bandpass' }) {
  const buf = makeNoise();
  if (!buf) return;
  const t0 = ctx.currentTime + start;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const filter = ctx.createBiquadFilter();
  filter.type = type;
  filter.frequency.setValueAtTime(freq, t0);
  filter.Q.value = q;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.003);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  src.connect(filter).connect(g).connect(master);
  src.start(t0);
  src.stop(t0 + dur + 0.02);
}

const RECIPES = {
  click: () => { thud({ gain: 0.16, dur: 0.035, freq: 2200, q: 2 }); },

  move: () => {
    thud({ gain: 0.34, dur: 0.075, freq: 780, q: 1.2 });
    tone({ freq: 190, type: 'sine', dur: 0.075, gain: 0.2, sweepTo: 120 });
  },

  capture: () => {
    thud({ gain: 0.45, dur: 0.1, freq: 480, q: 0.9 });
    thud({ start: 0.012, gain: 0.3, dur: 0.09, freq: 1500, q: 1.4 });
    tone({ freq: 150, type: 'triangle', dur: 0.1, gain: 0.24, sweepTo: 80 });
  },

  castle: () => {
    thud({ gain: 0.3, dur: 0.07, freq: 760, q: 1.2 });
    thud({ start: 0.085, gain: 0.32, dur: 0.08, freq: 620, q: 1.2 });
    tone({ freq: 170, type: 'sine', dur: 0.16, gain: 0.16, sweepTo: 110 });
  },

  check: () => {
    tone({ freq: 880, type: 'triangle', dur: 0.1, gain: 0.28 });
    tone({ freq: 1174, type: 'triangle', start: 0.09, dur: 0.16, gain: 0.26 });
  },

  promote: () => {
    [523, 659, 784, 1047].forEach((f, i) => {
      tone({ freq: f, type: 'triangle', start: i * 0.058, dur: 0.16, gain: 0.24 });
    });
  },

  gameStart: () => {
    tone({ freq: 392, type: 'sine', dur: 0.16, gain: 0.26 });
    tone({ freq: 587, type: 'sine', start: 0.12, dur: 0.26, gain: 0.24 });
  },

  gameEnd: () => {
    tone({ freq: 523, type: 'sine', dur: 0.18, gain: 0.24 });
    tone({ freq: 392, type: 'sine', start: 0.14, dur: 0.3, gain: 0.22 });
  },

  win: () => {
    [523, 659, 784, 1047].forEach((f, i) => {
      tone({ freq: f, type: 'sine', start: i * 0.09, dur: 0.3, gain: 0.26 });
    });
  },

  lose: () => {
    [440, 392, 330, 262].forEach((f, i) => {
      tone({ freq: f, type: 'sine', start: i * 0.11, dur: 0.34, gain: 0.22 });
    });
  },

  draw: () => {
    tone({ freq: 440, type: 'sine', dur: 0.22, gain: 0.22 });
    tone({ freq: 440, type: 'sine', start: 0.2, dur: 0.3, gain: 0.18 });
  },

  lowTime: () => { tone({ freq: 1320, type: 'square', dur: 0.05, gain: 0.16 }); },

  tenSeconds: () => {
    [0, 0.13, 0.26].forEach((s) => tone({ freq: 1568, type: 'square', start: s, dur: 0.07, gain: 0.2 }));
  },

  notify: () => {
    tone({ freq: 784, type: 'sine', dur: 0.1, gain: 0.2 });
    tone({ freq: 1046, type: 'sine', start: 0.08, dur: 0.16, gain: 0.18 });
  },

  illegal: () => {
    tone({ freq: 150, type: 'sawtooth', dur: 0.13, gain: 0.18, sweepTo: 90 });
  },
};

/** Play a named sound. Unknown names and disabled audio are silent no-ops. */
export function play(name) {
  if (!enabled) return;
  const recipe = RECIPES[name];
  if (!recipe) return;
  if (!ensureContext()) return;
  try {
    recipe();
  } catch {
    /* audio must never break the game */
  }
}

/** Convenience: pick the right sound for a move that was just played. */
export function playMoveSound({ capture, castle, promotion, check, mate }) {
  if (mate) { play('capture'); play('gameEnd'); return; }
  if (check) { play(capture ? 'capture' : 'move'); play('check'); return; }
  if (promotion) { play('promote'); return; }
  if (castle) { play('castle'); return; }
  play(capture ? 'capture' : 'move');
}
