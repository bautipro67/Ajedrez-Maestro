/**
 * elo.js — Sistema de puntuacion para Ajedrez Maestro.
 * Elo clasico estilo FIDE (factor K variable, suelo de puntuacion, redondeo de suma cero),
 * rendimiento por la tabla dp oficial, tramos de categoria con color e icono,
 * estadisticas de historial y una implementacion completa de Glicko-2.
 * Modulo agnostico del entorno: sin DOM, sin red y sin dependencias externas.
 */

/** Puntuacion minima que puede alcanzar un jugador. */
export const RATING_FLOOR = 100;
/** Partidas necesarias para dejar de ser provisional (K = 40). */
export const PROVISIONAL_GAMES = 30;
/** A partir de esta puntuacion el factor K baja a 10 de forma permanente. */
export const MASTER_THRESHOLD = 2400;
/** Desviacion (RD) maxima y minima del modelo de incertidumbre. */
export const RD_MAX = 350;
export const RD_MIN = 50;
/** Constante de escala de Glicko-2. */
export const GLICKO_SCALE = 173.7178;
/** Volatilidad inicial y constante de sistema tau recomendadas por Glickman. */
export const DEFAULT_VOLATILITY = 0.06;
export const DEFAULT_TAU = 0.5;
/** RD minima tras una actualizacion Glicko-2 (evita puntuaciones congeladas). */
export const GLICKO_RD_MIN = 30;

/**
 * Tabla dp de la FIDE: diferencia de puntuacion para porcentajes del 50 % al 100 %.
 * El indice es (porcentaje - 50). Para porcentajes por debajo del 50 % se refleja con signo.
 */
const DP_TABLE = [
  0, 7, 14, 21, 29, 36, 43, 50, 57, 65,
  72, 80, 87, 95, 102, 110, 117, 125, 133, 141,
  149, 158, 166, 175, 184, 193, 202, 211, 220, 230,
  240, 251, 262, 273, 284, 296, 309, 322, 336, 351,
  366, 383, 401, 422, 444, 470, 501, 538, 589, 677,
  800
];

/** Tramos de categoria: nombre en espanol, color e icono coherentes con el tema oscuro. */
export const RATING_TIERS = [
  { key: 'novice', name: 'Novato', color: '#94a3b8', icon: '🐣', min: 0, max: 599 },
  { key: 'beginner', name: 'Principiante', color: '#4ade80', icon: '🌱', min: 600, max: 999 },
  { key: 'amateur', name: 'Aficionado', color: '#2dd4bf', icon: '♟️', min: 1000, max: 1299 },
  { key: 'intermediate', name: 'Intermedio', color: '#38bdf8', icon: '🛡️', min: 1300, max: 1599 },
  { key: 'advanced', name: 'Avanzado', color: '#818cf8', icon: '⚔️', min: 1600, max: 1899 },
  { key: 'expert', name: 'Experto', color: '#c084fc', icon: '🔮', min: 1900, max: 2199 },
  { key: 'master', name: 'Maestro', color: '#fbbf24', icon: '👑', min: 2200, max: 2499 },
  { key: 'grandmaster', name: 'Gran Maestro', color: '#f87171', icon: '🏆', min: 2500, max: Infinity }
];

const DAY_MS = 86400000;

function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

/** Redondeo simetrico: -0.5 -> -1 y 0.5 -> 1, para que los deltas sean espejo. */
function roundHalfAway(value) {
  return value < 0 ? -Math.round(-value) : Math.round(value);
}

function toFinite(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

/**
 * Puntuacion esperada de A frente a B (0..1).
 * La formula esta escrita de forma simetrica para que
 * expectedScore(a, b) + expectedScore(b, a) valga exactamente 1.
 */
export function expectedScore(ratingA, ratingB) {
  const a = toFinite(ratingA, 1500);
  const b = toFinite(ratingB, 1500);
  const diff = b - a;
  if (diff === 0) return 0.5;
  const weaker = 1 / (1 + Math.pow(10, Math.abs(diff) / 400));
  return diff > 0 ? weaker : 1 - weaker;
}

/**
 * Factor K estilo FIDE: 40 mientras se es provisional (menos de 30 partidas),
 * 10 en cuanto se ha alcanzado 2400 alguna vez, 20 en el resto de casos.
 */
export function kFactor(rating, gamesPlayed = PROVISIONAL_GAMES, peakRating = rating) {
  const games = toFinite(gamesPlayed, PROVISIONAL_GAMES);
  if (games < PROVISIONAL_GAMES) return 40;
  const current = toFinite(rating, 1500);
  const peak = Math.max(current, toFinite(peakRating, current));
  if (peak >= MASTER_THRESHOLD) return 10;
  return 20;
}

/**
 * Aplica un resultado a dos jugadores.
 * scoreA: 1 (gana A), 0.5 (tablas) o 0 (gana B).
 * opts: { gamesA, gamesB, peakA, peakB, kA, kB, floor }.
 */
export function applyResult(ratingA, ratingB, scoreA, opts = {}) {
  const a0 = toFinite(ratingA, 1500);
  const b0 = toFinite(ratingB, 1500);
  const sA = clamp(toFinite(Number(scoreA), 0.5), 0, 1);
  const sB = 1 - sA;
  const kA = toFinite(opts.kA, kFactor(a0, toFinite(opts.gamesA, PROVISIONAL_GAMES), toFinite(opts.peakA, a0)));
  const kB = toFinite(opts.kB, kFactor(b0, toFinite(opts.gamesB, PROVISIONAL_GAMES), toFinite(opts.peakB, b0)));
  const floor = toFinite(opts.floor, RATING_FLOOR);
  const eA = expectedScore(a0, b0);
  const eB = 1 - eA;
  const deltaA = roundHalfAway(kA * (sA - eA));
  // Con el mismo K el intercambio es de suma cero por construccion.
  const deltaB = kA === kB ? -deltaA : roundHalfAway(kB * (sB - eB));
  const a = Math.max(floor, a0 + deltaA);
  const b = Math.max(floor, b0 + deltaB);
  return {
    a,
    b,
    deltaA: a - a0,
    deltaB: b - b0,
    expectedA: eA,
    expectedB: eB,
    kA,
    kB
  };
}

/** Diferencia dp de la tabla FIDE para un porcentaje de puntuacion (0..1). */
export function dpFromPercentage(percentage) {
  const pct = Math.round(clamp(toFinite(percentage, 0.5), 0, 1) * 100);
  if (pct >= 50) return DP_TABLE[pct - 50];
  return -DP_TABLE[50 - pct];
}

/**
 * Rendimiento Elo frente a una lista de rivales.
 * Por defecto usa la tabla dp de la FIDE y, para muestras pequenas (menos de 5 partidas),
 * la aproximacion lineal de los 400 puntos. opts.method: 'auto' | 'fide' | 'linear'.
 */
export function performanceRating(opponentRatings, score, opts = {}) {
  const list = (Array.isArray(opponentRatings) ? opponentRatings : []).filter(Number.isFinite);
  const n = list.length;
  if (n === 0) return null;
  const total = clamp(toFinite(Number(score), 0), 0, n);
  const average = list.reduce((sum, r) => sum + r, 0) / n;
  const method = opts.method === 'fide' || opts.method === 'linear' ? opts.method : 'auto';
  const smallSample = toFinite(opts.smallSample, 5);
  const useLinear = method === 'linear' || (method === 'auto' && n < smallSample);
  if (useLinear) return Math.round(average + (400 * (2 * total - n)) / n);
  return Math.round(average + dpFromPercentage(total / n));
}

/** Tramo de categoria de una puntuacion. Devuelve una copia para no exponer la tabla. */
export function ratingTier(elo) {
  const value = toFinite(elo, 0);
  for (const tier of RATING_TIERS) {
    if (value >= tier.min && value <= tier.max) return { ...tier };
  }
  return value < RATING_TIERS[0].min
    ? { ...RATING_TIERS[0] }
    : { ...RATING_TIERS[RATING_TIERS.length - 1] };
}

function normalizeResult(result) {
  if (typeof result === 'number') {
    if (result === 1) return 'win';
    if (result === 0) return 'loss';
    if (result === 0.5) return 'draw';
    return null;
  }
  if (typeof result !== 'string') return null;
  const key = result.trim().toLowerCase();
  if (key === 'win' || key === 'w' || key === '1' || key === '1-0') return 'win';
  if (key === 'loss' || key === 'lose' || key === 'l' || key === '0' || key === '0-1') return 'loss';
  if (key === 'draw' || key === 'd' || key === '0.5' || key === '1/2' || key === '1/2-1/2') return 'draw';
  return null;
}

function emptyHistoryStats() {
  return {
    games: 0,
    peak: null,
    low: null,
    current: null,
    first: null,
    delta: 0,
    delta7d: 0,
    wins: 0,
    draws: 0,
    losses: 0,
    winRate: 0,
    winPercent: 0,
    scoreRate: 0,
    streak: { type: 'none', count: 0 },
    bestStreak: { type: 'none', count: 0 }
  };
}

/**
 * Estadisticas sobre un historial de entradas { ts, rating, result, opponent }.
 * delta7d compara la puntuacion actual con la vigente 7 dias antes de la ultima entrada.
 * winRate es una fraccion 0..1 y winPercent el mismo dato en porcentaje.
 */
export function ratingHistoryStats(history, opts = {}) {
  const entries = (Array.isArray(history) ? history : [])
    .filter((e) => e && Number.isFinite(e.rating))
    .slice()
    .sort((x, y) => toFinite(x.ts, 0) - toFinite(y.ts, 0));
  if (entries.length === 0) return emptyHistoryStats();

  let peak = entries[0].rating;
  let low = entries[0].rating;
  let wins = 0;
  let draws = 0;
  let losses = 0;
  let runType = 'none';
  let runCount = 0;
  let bestWinRun = 0;
  for (const entry of entries) {
    if (entry.rating > peak) peak = entry.rating;
    if (entry.rating < low) low = entry.rating;
    const kind = normalizeResult(entry.result);
    if (kind === 'win') wins += 1;
    else if (kind === 'draw') draws += 1;
    else if (kind === 'loss') losses += 1;
    if (kind === null) continue;
    if (kind === runType) runCount += 1;
    else {
      runType = kind;
      runCount = 1;
    }
    if (kind === 'win' && runCount > bestWinRun) bestWinRun = runCount;
  }

  const decided = wins + draws + losses;
  const current = entries[entries.length - 1].rating;
  const first = entries[0].rating;
  const now = toFinite(opts.now, toFinite(entries[entries.length - 1].ts, 0));
  const cutoff = now - 7 * DAY_MS;
  let baseline = first;
  for (const entry of entries) {
    if (toFinite(entry.ts, 0) < cutoff) baseline = entry.rating;
    else break;
  }

  return {
    games: entries.length,
    peak,
    low,
    current,
    first,
    delta: current - first,
    delta7d: current - baseline,
    wins,
    draws,
    losses,
    winRate: decided > 0 ? wins / decided : 0,
    winPercent: decided > 0 ? Math.round((wins / decided) * 1000) / 10 : 0,
    scoreRate: decided > 0 ? (wins + draws / 2) / decided : 0,
    streak: { type: runCount > 0 ? runType : 'none', count: runCount },
    bestStreak: { type: bestWinRun > 0 ? 'win' : 'none', count: bestWinRun }
  };
}

/**
 * Desviacion (RD) provisional segun las partidas jugadas: 350 sin partidas y
 * decreciente de forma suave hacia el suelo de 50.
 */
export function provisionalRd(gamesPlayed) {
  const games = Math.max(0, toFinite(gamesPlayed, 0));
  const spread = RD_MAX * RD_MAX - RD_MIN * RD_MIN;
  const rd = Math.sqrt(RD_MIN * RD_MIN + spread / (1 + games));
  return Math.round(clamp(rd, RD_MIN, RD_MAX) * 100) / 100;
}

function glickoG(phi) {
  return 1 / Math.sqrt(1 + (3 * phi * phi) / (Math.PI * Math.PI));
}

function glickoE(mu, muJ, phiJ) {
  return 1 / (1 + Math.exp(-glickoG(phiJ) * (mu - muJ)));
}

/** Iteracion de Illinois para la nueva volatilidad (Glickman, paso 5). */
function solveVolatility(phi, v, delta, sigma, tau) {
  const a = Math.log(sigma * sigma);
  const phi2 = phi * phi;
  const delta2 = delta * delta;
  const f = (x) => {
    const ex = Math.exp(x);
    const denom = phi2 + v + ex;
    return (ex * (delta2 - denom)) / (2 * denom * denom) - (x - a) / (tau * tau);
  };
  let A = a;
  let B;
  if (delta2 > phi2 + v) {
    B = Math.log(delta2 - phi2 - v);
  } else {
    let k = 1;
    while (f(a - k * tau) < 0 && k < 100) k += 1;
    B = a - k * tau;
  }
  let fA = f(A);
  let fB = f(B);
  let guard = 0;
  while (Math.abs(B - A) > 1e-6 && guard < 1000) {
    const C = A + ((A - B) * fA) / (fB - fA);
    const fC = f(C);
    if (fC * fB <= 0) {
      A = B;
      fA = fB;
    } else {
      fA /= 2;
    }
    B = C;
    fB = fC;
    guard += 1;
  }
  return Math.exp(A / 2);
}

/**
 * Actualizacion Glicko-2 completa.
 * player: { rating, rd, vol }  results: [{ rating, rd, score }]  opts: { tau, floor }.
 * Sin resultados solo aumenta la incertidumbre (paso 6 del articulo original).
 */
export function glicko2Update(player, results, opts = {}) {
  const tau = toFinite(opts.tau, DEFAULT_TAU);
  const floor = toFinite(opts.floor, RATING_FLOOR);
  const rating = toFinite(player && player.rating, 1500);
  const rd = clamp(toFinite(player && player.rd, RD_MAX), 1e-6, RD_MAX);
  const sigma = clamp(toFinite(player && player.vol, DEFAULT_VOLATILITY), 1e-6, 1);
  const list = (Array.isArray(results) ? results : []).filter(
    (r) => r && Number.isFinite(r.rating) && Number.isFinite(Number(r.score))
  );

  const mu = (rating - 1500) / GLICKO_SCALE;
  const phi = rd / GLICKO_SCALE;

  if (list.length === 0) {
    const phiStar = Math.sqrt(phi * phi + sigma * sigma);
    return {
      rating,
      rd: clamp(phiStar * GLICKO_SCALE, GLICKO_RD_MIN, RD_MAX),
      vol: sigma,
      games: 0
    };
  }

  let vInv = 0;
  let deltaSum = 0;
  for (const r of list) {
    const muJ = (r.rating - 1500) / GLICKO_SCALE;
    const phiJ = clamp(toFinite(r.rd, RD_MAX), 1e-6, RD_MAX) / GLICKO_SCALE;
    const g = glickoG(phiJ);
    const e = glickoE(mu, muJ, phiJ);
    vInv += g * g * e * (1 - e);
    deltaSum += g * (clamp(Number(r.score), 0, 1) - e);
  }
  const v = 1 / vInv;
  const delta = v * deltaSum;

  const sigmaPrime = solveVolatility(phi, v, delta, sigma, tau);
  const phiStar = Math.sqrt(phi * phi + sigmaPrime * sigmaPrime);
  const phiPrime = 1 / Math.sqrt(1 / (phiStar * phiStar) + 1 / v);
  const muPrime = mu + phiPrime * phiPrime * deltaSum;

  return {
    rating: Math.max(floor, 1500 + GLICKO_SCALE * muPrime),
    rd: clamp(GLICKO_SCALE * phiPrime, GLICKO_RD_MIN, RD_MAX),
    vol: sigmaPrime,
    games: list.length
  };
}
