/**
 * tournament.js — Motor de torneos de Ajedrez Maestro.
 * Cuatro formatos: suizo (grupos de puntuacion, sin repetir rival, colores equilibrados
 * y busqueda con retroceso), round robin por el algoritmo del circulo de Berger,
 * knockout con cabezas de serie y muerte subita, y arena con puntuacion de racha.
 * Incluye desempates FIDE, rendimiento Elo, variacion de puntuacion y serializacion exacta.
 * Modulo agnostico del entorno: sin DOM, sin red y sin dependencias externas.
 */

import { applyResult, performanceRating } from './elo.js';

/** Formatos admitidos. */
export const FORMATS = ['swiss', 'roundrobin', 'knockout', 'arena'];
/** Resultados validos de una partida. */
export const RESULTS = ['1-0', '0-1', '1/2-1/2'];

const MAX_COLOR_DIFF = 2;
const MAX_SAME_COLOR_RUN = 2;
const PAIRING_BUDGET = 400000;
const ARENA_WIN = 2;
const ARENA_DRAW = 1;
const ARENA_STREAK_WIN = 4;
const ARENA_STREAK_AFTER = 2;
const MEDALS = ['🥇', '🥈', '🥉'];
const PRIZE_LABELS = ['Campeon', 'Subcampeon', 'Tercer puesto'];
const PRIZE_SHARES = [0.5, 0.3, 0.2];

function toFinite(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

function round4(value) {
  return Math.round(value * 10000) / 10000;
}

function byePoints(format) {
  return format === 'arena' ? ARENA_WIN : 1;
}

function scoreFromResult(result, color) {
  if (result === '1/2-1/2') return 0.5;
  if (result === '1-0') return color === 'w' ? 1 : 0;
  if (result === '0-1') return color === 'w' ? 0 : 1;
  return null;
}

/** PRNG determinista (mulberry32) con el estado guardado en el torneo. */
function nextRandom(t) {
  t.rngState = (t.rngState + 0x6d2b79f5) >>> 0;
  let x = t.rngState;
  x = Math.imul(x ^ (x >>> 15), 1 | x);
  x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
  return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
}

function bracketSize(n) {
  let size = 1;
  while (size < n) size *= 2;
  return Math.max(2, size);
}

/** Orden clasico de cabezas de serie: 1-8, 5-4, 3-6, 7-2 para un cuadro de 8. */
function seedOrder(size) {
  let arr = [1];
  while (arr.length < size) {
    const len = arr.length * 2 + 1;
    const next = [];
    for (const s of arr) {
      next.push(s, len - s);
    }
    arr = next;
  }
  return arr;
}

/**
 * Reparto de colores de un calendario fijo: gana las blancas quien menos veces
 * las ha llevado, sin superar la diferencia maxima ni tres colores seguidos.
 */
function balanceScheduleColors(rounds) {
  const state = new Map();
  const get = (id) => {
    if (!state.has(id)) state.set(id, { diff: 0, last: null, run: 0 });
    return state.get(id);
  };
  const canTake = (s, color) => {
    if (s.last === color && s.run >= MAX_SAME_COLOR_RUN) return false;
    const delta = color === 'w' ? 1 : -1;
    return Math.abs(s.diff + delta) <= MAX_COLOR_DIFF;
  };
  const apply = (s, color) => {
    s.diff += color === 'w' ? 1 : -1;
    s.run = s.last === color ? s.run + 1 : 1;
    s.last = color;
  };
  rounds.forEach((pairs, r) => {
    pairs.forEach((pair, i) => {
      const [x, y] = pair;
      if (x === null || y === null) return;
      const sx = get(x);
      const sy = get(y);
      const xWhiteOk = canTake(sx, 'w') && canTake(sy, 'b');
      const yWhiteOk = canTake(sy, 'w') && canTake(sx, 'b');
      let xWhite;
      if (xWhiteOk !== yWhiteOk) xWhite = xWhiteOk;
      else if (sx.diff !== sy.diff) xWhite = sx.diff < sy.diff;
      else if (sx.last !== sy.last) xWhite = sx.last === 'b' || sy.last === 'w';
      else xWhite = (r + i) % 2 === 0;
      pair[0] = xWhite ? x : y;
      pair[1] = xWhite ? y : x;
      apply(sx, xWhite ? 'w' : 'b');
      apply(sy, xWhite ? 'b' : 'w');
    });
  });
  return rounds;
}

/** Algoritmo del circulo (Berger). Devuelve rondas de pares [blancas, negras]. */
function bergerSchedule(playerIds, doubleRound) {
  const list = playerIds.slice();
  if (list.length % 2 === 1) list.push(null);
  const n = list.length;
  const rounds = [];
  for (let r = 0; r < n - 1; r += 1) {
    const pairs = [];
    for (let i = 0; i < n / 2; i += 1) {
      pairs.push([list[i], list[n - 1 - i]]);
    }
    rounds.push(pairs);
    list.splice(1, 0, list.pop());
  }
  balanceScheduleColors(rounds);
  if (!doubleRound) return rounds;
  // La segunda vuelta repite el calendario en orden inverso y con los colores cambiados:
  // asi nadie encadena tres colores iguales en el salto entre vueltas.
  const second = rounds
    .slice()
    .reverse()
    .map((pairs) => pairs.map(([a, b]) => [b, a]));
  return rounds.concat(second);
}

function defaultRounds(format, playerCount) {
  if (format === 'knockout') return Math.round(Math.log2(bracketSize(playerCount)));
  if (format === 'arena') return 5;
  const swiss = Math.ceil(Math.log2(Math.max(2, playerCount)));
  return Math.max(1, Math.min(playerCount - 1, swiss));
}

/**
 * Crea un torneo a partir de la configuracion.
 * config: { id, name, format, rounds, players, timeControl, doubleRound, seed }.
 */
export function createTournament(config = {}) {
  const format = config.format || 'swiss';
  if (!FORMATS.includes(format)) throw new Error('Formato de torneo desconocido: ' + format);
  const rawPlayers = Array.isArray(config.players) ? config.players : [];
  if (rawPlayers.length < 2) throw new Error('Un torneo necesita al menos 2 jugadores.');

  const players = rawPlayers.map((p, i) => ({
    id: String(p && p.id !== undefined ? p.id : 'p' + (i + 1)),
    name: String(p && p.name !== undefined ? p.name : 'Jugador ' + (i + 1)),
    elo: toFinite(p && Number(p.elo), 1500),
    isHuman: !!(p && p.isHuman),
    botId: p && p.botId ? String(p.botId) : null,
    gamesPlayed: toFinite(p && Number(p.gamesPlayed), 30),
    seed: i
  }));
  const ids = new Set();
  for (const p of players) {
    if (ids.has(p.id)) throw new Error('Hay jugadores con el mismo identificador: ' + p.id);
    ids.add(p.id);
  }

  const doubleRound = !!config.doubleRound;
  const seed = toFinite(Number(config.seed), 1);
  const t = {
    id: String(config.id !== undefined ? config.id : 'torneo'),
    name: String(config.name !== undefined ? config.name : 'Torneo'),
    format,
    doubleRound,
    seed,
    rngState: seed >>> 0,
    timeControl: {
      base: toFinite(config.timeControl && Number(config.timeControl.base), 300),
      inc: toFinite(config.timeControl && Number(config.timeControl.inc), 3)
    },
    players,
    games: [],
    round: 0,
    rounds: 0,
    status: 'pending',
    schedule: null,
    knockout: null
  };

  if (format === 'roundrobin') {
    t.schedule = bergerSchedule(players.map((p) => p.id), doubleRound);
    t.rounds = t.schedule.length;
  } else if (format === 'knockout') {
    const order = players
      .slice()
      .sort((a, b) => b.elo - a.elo || a.seed - b.seed)
      .map((p) => p.id);
    const size = bracketSize(players.length);
    const slots = seedOrder(size).map((s) => (s <= order.length ? order[s - 1] : null));
    t.knockout = { size, order, slots, alive: slots.slice() };
    t.rounds = Math.round(Math.log2(size));
  } else {
    const requested = Number(config.rounds);
    t.rounds = Number.isFinite(requested) && requested > 0
      ? Math.floor(requested)
      : defaultRounds(format, players.length);
  }
  return t;
}

function playerById(t, id) {
  return t.players.find((p) => p.id === id) || null;
}

/** Partidas de la ronda en curso que aun no tienen resultado. */
export function pendingGames(t) {
  return t.games.filter((g) => g.result === null).map((g) => ({ ...g }));
}

function applyGameToStats(format, me, opp, score, game, color) {
  me.played += 1;
  me.gamePoints += score;
  me.opponents.push(opp.id);
  me.colors.push(color);
  me.oppRatings.push(opp.elo);
  me.results.push({ round: game.round, opponent: opp.id, score, color, gameId: game.id });
  if (score === 1) me.wins += 1;
  else if (score === 0.5) me.draws += 1;
  else me.losses += 1;
  if (format === 'arena') {
    if (score === 1) {
      me.points += me.streak >= ARENA_STREAK_AFTER ? ARENA_STREAK_WIN : ARENA_WIN;
      me.streak += 1;
      if (me.streak > me.bestStreak) me.bestStreak = me.streak;
    } else if (score === 0.5) {
      me.points += ARENA_DRAW;
      me.streak = 0;
    } else {
      me.streak = 0;
    }
  } else {
    me.points += score;
  }
}

/** Estadisticas acumuladas por jugador a partir de las partidas ya resueltas. */
function computeStats(t) {
  const stats = new Map();
  for (const p of t.players) {
    stats.set(p.id, {
      id: p.id,
      elo: p.elo,
      seed: p.seed,
      points: 0,
      gamePoints: 0,
      played: 0,
      wins: 0,
      draws: 0,
      losses: 0,
      byes: 0,
      streak: 0,
      bestStreak: 0,
      opponents: [],
      colors: [],
      oppRatings: [],
      results: []
    });
  }
  for (const g of t.games) {
    if (!g.result) continue;
    const white = stats.get(g.white);
    if (g.result === 'bye') {
      if (white) {
        white.points += byePoints(t.format);
        white.byes += 1;
      }
      continue;
    }
    const black = stats.get(g.black);
    if (!white || !black) continue;
    const sw = scoreFromResult(g.result, 'w');
    applyGameToStats(t.format, white, black, sw, g, 'w');
    applyGameToStats(t.format, black, white, 1 - sw, g, 'b');
  }
  return stats;
}

function timesPlayed(stats, aId, bId) {
  const s = stats.get(aId);
  if (!s) return 0;
  let count = 0;
  for (const o of s.opponents) if (o === bId) count += 1;
  return count;
}

function colorBalance(entry) {
  let diff = 0;
  for (const c of entry.colors) diff += c === 'w' ? 1 : -1;
  return diff;
}

function lastColorsAre(entry, color, maxRun) {
  const n = entry.colors.length;
  if (n < maxRun) return false;
  for (let i = n - maxRun; i < n; i += 1) {
    if (entry.colors[i] !== color) return false;
  }
  return true;
}

/**
 * Restricciones de color segun el nivel de relajacion:
 * 0 estricto, 1 admite una diferencia mas, 2 o mas sin restricciones.
 */
function colorLimits(level) {
  if (level <= 0) return { maxDiff: MAX_COLOR_DIFF, maxRun: MAX_SAME_COLOR_RUN };
  if (level === 1) return { maxDiff: MAX_COLOR_DIFF + 1, maxRun: MAX_SAME_COLOR_RUN };
  return null;
}

function colorAllowed(whiteEntry, blackEntry, limits) {
  if (!limits) return true;
  if (lastColorsAre(whiteEntry, 'w', limits.maxRun)) return false;
  if (lastColorsAre(blackEntry, 'b', limits.maxRun)) return false;
  if (colorBalance(whiteEntry) + 1 > limits.maxDiff) return false;
  if (colorBalance(blackEntry) - 1 < -limits.maxDiff) return false;
  return true;
}

/** Decide colores para un emparejamiento aplicando las restricciones del nivel. */
function assignColors(a, b, stats, level, round) {
  const sa = stats.get(a.id);
  const sb = stats.get(b.id);
  const limits = colorLimits(level);
  const aWhiteOk = colorAllowed(sa, sb, limits);
  const bWhiteOk = colorAllowed(sb, sa, limits);
  if (!aWhiteOk && !bWhiteOk) return null;
  if (aWhiteOk && !bWhiteOk) return { white: a, black: b };
  if (bWhiteOk && !aWhiteOk) return { white: b, black: a };
  const da = colorBalance(sa);
  const db = colorBalance(sb);
  if (da !== db) return da < db ? { white: a, black: b } : { white: b, black: a };
  const la = sa.colors[sa.colors.length - 1];
  const lb = sb.colors[sb.colors.length - 1];
  if (la !== lb) return la === 'b' ? { white: a, black: b } : { white: b, black: a };
  return round % 2 === 1 ? { white: a, black: b } : { white: b, black: a };
}

/**
 * Orden de candidatos para el primer jugador sin emparejar:
 * primero su pareja natural de la mitad inferior del grupo de puntuacion,
 * luego el resto del grupo y por ultimo los grupos mas cercanos en puntos.
 */
function candidateOrder(pool, used, index, stats, level) {
  const me = stats.get(pool[index].id);
  const group = [];
  const others = [];
  for (let j = 0; j < pool.length; j += 1) {
    if (used[j] || j === index) continue;
    if (stats.get(pool[j].id).points === me.points) group.push(j);
    else others.push(j);
  }
  const half = Math.floor((group.length + 1) / 2);
  const ordered = [];
  const push = (j) => {
    if (j !== undefined && !ordered.includes(j)) ordered.push(j);
  };
  push(group[half - 1]);
  for (let k = half; k < group.length; k += 1) push(group[k]);
  for (let k = 0; k < half - 1; k += 1) push(group[k]);
  others.sort((x, y) => {
    const dx = Math.abs(stats.get(pool[x].id).points - me.points);
    const dy = Math.abs(stats.get(pool[y].id).points - me.points);
    return dx - dy || x - y;
  });
  for (const j of others) push(j);
  if (level >= 3) {
    ordered.sort((x, y) => timesPlayed(stats, me.id, pool[x].id) - timesPlayed(stats, me.id, pool[y].id));
  }
  return ordered;
}

/**
 * Busqueda con retroceso de un emparejamiento perfecto.
 * Niveles 0 a 2: nunca se repite rival y las restricciones de color se van relajando.
 * Nivel 3: ultimo recurso, se permite repetir rival (primero quien menos veces se enfrento).
 */
function backtrackPairing(pool, stats, level, round) {
  const n = pool.length;
  const used = new Array(n).fill(false);
  const pairs = [];
  const budget = { left: PAIRING_BUDGET };

  function solve(count) {
    if (count === n) return true;
    if (budget.left <= 0) return false;
    let i = 0;
    while (i < n && used[i]) i += 1;
    if (i >= n) return false;
    const me = pool[i];
    for (const j of candidateOrder(pool, used, i, stats, level)) {
      if (used[j]) continue;
      budget.left -= 1;
      if (budget.left <= 0) return false;
      const rival = pool[j];
      if (level < 3 && timesPlayed(stats, me.id, rival.id) > 0) continue;
      const colors = assignColors(me, rival, stats, level, round);
      if (!colors) continue;
      used[i] = true;
      used[j] = true;
      pairs.push(colors);
      if (solve(count + 2)) return true;
      pairs.pop();
      used[i] = false;
      used[j] = false;
    }
    return false;
  }

  return solve(0) ? pairs.slice() : null;
}

/** Bye para el jugador con menos puntos que aun no lo tuvo (desempate: menos Elo). */
function chooseByePlayer(pool, stats) {
  let minByes = Infinity;
  for (const p of pool) minByes = Math.min(minByes, stats.get(p.id).byes);
  const candidates = pool.filter((p) => stats.get(p.id).byes === minByes);
  let best = candidates[0];
  for (const p of candidates) {
    const a = stats.get(p.id);
    const b = stats.get(best.id);
    if (a.points < b.points) best = p;
    else if (a.points === b.points && p.elo < best.elo) best = p;
    else if (a.points === b.points && p.elo === best.elo && p.seed > best.seed) best = p;
  }
  return best;
}

function rankedPool(t, stats) {
  return t.players.slice().sort((a, b) => {
    const sa = stats.get(a.id);
    const sb = stats.get(b.id);
    if (sb.points !== sa.points) return sb.points - sa.points;
    if (b.elo !== a.elo) return b.elo - a.elo;
    return a.seed - b.seed;
  });
}

function swissPairings(t, round) {
  const stats = computeStats(t);
  let pool = rankedPool(t, stats);
  const pairings = [];
  let byePlayer = null;
  if (pool.length % 2 === 1) {
    byePlayer = chooseByePlayer(pool, stats);
    pool = pool.filter((p) => p.id !== byePlayer.id);
  }
  let matching = null;
  for (let level = 0; level <= 3 && !matching; level += 1) {
    matching = backtrackPairing(pool, stats, level, round);
  }
  if (!matching) throw new Error('No se pudo emparejar la ronda ' + round + '.');
  for (const pair of matching) pairings.push({ white: pair.white.id, black: pair.black.id, bye: false });
  if (byePlayer) pairings.push({ white: byePlayer.id, black: null, bye: true });
  return pairings;
}

function arenaPairings(t, round) {
  const stats = computeStats(t);
  let pool = rankedPool(t, stats);
  const pairings = [];
  let byePlayer = null;
  if (pool.length % 2 === 1) {
    byePlayer = chooseByePlayer(pool, stats);
    pool = pool.filter((p) => p.id !== byePlayer.id);
  }
  const used = new Set();
  for (let i = 0; i < pool.length; i += 1) {
    const me = pool[i];
    if (used.has(me.id)) continue;
    used.add(me.id);
    let fresh = -1;
    let notLast = -1;
    let nearest = -1;
    for (let j = i + 1; j < pool.length; j += 1) {
      const other = pool[j];
      if (used.has(other.id)) continue;
      if (nearest < 0) nearest = j;
      const entry = stats.get(me.id);
      const lastOpponent = entry.opponents[entry.opponents.length - 1];
      if (notLast < 0 && lastOpponent !== other.id) notLast = j;
      if (timesPlayed(stats, me.id, other.id) === 0) {
        fresh = j;
        break;
      }
    }
    const pick = fresh >= 0 ? fresh : notLast >= 0 ? notLast : nearest;
    if (pick < 0) break;
    const rival = pool[pick];
    used.add(rival.id);
    const colors = assignColors(me, rival, stats, 2, round);
    pairings.push({ white: colors.white.id, black: colors.black.id, bye: false });
  }
  if (byePlayer) pairings.push({ white: byePlayer.id, black: null, bye: true });
  return pairings;
}

function roundRobinPairings(t, round) {
  const pairs = t.schedule[round - 1] || [];
  const pairings = [];
  for (const [a, b] of pairs) {
    if (a === null && b === null) continue;
    if (a === null || b === null) {
      pairings.push({ white: a === null ? b : a, black: null, bye: true });
      continue;
    }
    pairings.push({ white: a, black: b, bye: false });
  }
  return pairings;
}

function winnerOf(game) {
  if (!game || !game.result) return null;
  if (game.result === 'bye' || game.result === '1-0') return game.white;
  if (game.result === '0-1') return game.black;
  return null;
}

function roundWinners(t, round) {
  const bySlot = new Map();
  for (const g of t.games) {
    if (g.round !== round) continue;
    bySlot.set(g.slot, g);
  }
  return [...bySlot.keys()]
    .sort((a, b) => a - b)
    .map((slot) => winnerOf(bySlot.get(slot)));
}

function seedRankOf(t, id) {
  const idx = t.knockout.order.indexOf(id);
  return idx < 0 ? t.knockout.order.length : idx;
}

function knockoutPairings(t, round) {
  const alive = round === 1 ? t.knockout.slots.slice() : roundWinners(t, round - 1);
  t.knockout.alive = alive.slice();
  const pairings = [];
  for (let i = 0; i < alive.length; i += 2) {
    const a = alive[i];
    const b = i + 1 < alive.length ? alive[i + 1] : null;
    if (a === null && b === null) continue;
    if (a === null || b === null) {
      pairings.push({ white: a === null ? b : a, black: null, bye: true });
      continue;
    }
    const topFirst = seedRankOf(t, a) <= seedRankOf(t, b);
    const white = topFirst ? a : b;
    const black = topFirst ? b : a;
    pairings.push({ white, black, bye: false });
  }
  return pairings;
}

/**
 * Genera y registra las partidas de la siguiente ronda.
 * Devuelve [{ id, white, black, round, slot, bye }]; en un bye `black` es null.
 */
export function nextRound(t) {
  if (isFinished(t)) return [];
  if (t.games.some((g) => g.result === null)) {
    throw new Error('La ronda en curso tiene partidas sin resultado.');
  }
  const round = t.round + 1;
  if (t.format !== 'knockout' && round > t.rounds) return [];
  let pairings;
  if (t.format === 'swiss') pairings = swissPairings(t, round);
  else if (t.format === 'roundrobin') pairings = roundRobinPairings(t, round);
  else if (t.format === 'knockout') pairings = knockoutPairings(t, round);
  else pairings = arenaPairings(t, round);

  // Un toque de aleatoriedad determinista mantiene el estado del PRNG vivo entre rondas.
  nextRandom(t);

  const created = [];
  pairings.forEach((pair, slot) => {
    const game = {
      id: t.id + '-r' + round + '-' + (slot + 1),
      round,
      slot,
      white: pair.white,
      black: pair.bye ? null : pair.black,
      result: pair.bye ? 'bye' : null,
      suddenDeath: false,
      parent: null
    };
    t.games.push(game);
    created.push({ ...game });
  });
  t.round = round;
  t.status = isFinished(t) ? 'finished' : 'running';
  return created;
}

/** Registra el resultado de una partida. En knockout unas tablas generan muerte subita. */
export function reportResult(t, gameId, result) {
  if (!RESULTS.includes(result)) throw new Error('Resultado no valido: ' + result);
  const game = t.games.find((g) => g.id === gameId);
  if (!game) throw new Error('Partida no encontrada: ' + gameId);
  if (game.result === 'bye') throw new Error('Un bye no admite resultado: ' + gameId);
  if (game.result !== null) throw new Error('La partida ya tiene resultado: ' + gameId);
  game.result = result;

  let tiebreak = null;
  if (t.format === 'knockout' && result === '1/2-1/2') {
    const siblings = t.games.filter((g) => g.round === game.round && g.slot === game.slot).length;
    tiebreak = {
      id: t.id + '-r' + game.round + '-' + (game.slot + 1) + '-d' + siblings,
      round: game.round,
      slot: game.slot,
      white: game.black,
      black: game.white,
      result: null,
      suddenDeath: true,
      parent: game.id
    };
    t.games.push(tiebreak);
  }
  const finished = isFinished(t);
  t.status = finished ? 'finished' : 'running';
  return {
    game: { ...game },
    tiebreak: tiebreak ? { ...tiebreak } : null,
    roundComplete: !t.games.some((g) => g.result === null),
    finished
  };
}

/** Indica si el torneo ha terminado. */
export function isFinished(t) {
  if (t.round === 0) return false;
  if (t.games.some((g) => g.result === null)) return false;
  if (t.format === 'knockout') return roundWinners(t, t.round).filter((id) => id !== null).length <= 1;
  return t.round >= t.rounds;
}

function headToHeadMap(t) {
  const map = new Map();
  for (const g of t.games) {
    if (!g.result || g.result === 'bye' || !g.black) continue;
    const sw = scoreFromResult(g.result, 'w');
    const kw = g.white + '|' + g.black;
    const kb = g.black + '|' + g.white;
    map.set(kw, (map.get(kw) || 0) + sw);
    map.set(kb, (map.get(kb) || 0) + (1 - sw));
  }
  return map;
}

/** Los únicos resultados que significan algo. Cualquier otra cosa es basura. */
function resultadoValido(valor) {
  return valor === '1-0' || valor === '0-1' || valor === '1/2-1/2' || valor === 'bye';
}

function headToHeadCompare(map, aId, bId) {
  const ab = map.get(aId + '|' + bId);
  const ba = map.get(bId + '|' + aId);
  if (ab === undefined || ba === undefined) return 0;
  if (ab === ba) return 0;
  return ab > ba ? -1 : 1;
}

/** Variacion de puntuacion acumulada aplicando elo.applyResult partida a partida. */
function ratingChanges(t) {
  const current = new Map();
  const played = new Map();
  for (const p of t.players) {
    current.set(p.id, p.elo);
    played.set(p.id, p.gamesPlayed);
  }
  for (const g of t.games) {
    if (!g.result || g.result === 'bye' || !g.black) continue;
    const ra = current.get(g.white);
    const rb = current.get(g.black);
    if (ra === undefined || rb === undefined) continue;
    const res = applyResult(ra, rb, scoreFromResult(g.result, 'w'), {
      gamesA: played.get(g.white),
      gamesB: played.get(g.black)
    });
    current.set(g.white, res.a);
    current.set(g.black, res.b);
    played.set(g.white, played.get(g.white) + 1);
    played.set(g.black, played.get(g.black) + 1);
  }
  const out = new Map();
  for (const p of t.players) out.set(p.id, current.get(p.id) - p.elo);
  return out;
}

/**
 * Clasificacion con desempates en orden: puntos, enfrentamiento directo,
 * Sonneborn-Berger, Buchholz recortado, numero de victorias y rendimiento Elo.
 */
export function standings(t) {
  const stats = computeStats(t);
  const changes = ratingChanges(t);
  const h2h = headToHeadMap(t);
  const pointsOf = (id) => {
    const s = stats.get(id);
    return s ? s.points : 0;
  };
  const rows = t.players.map((p) => {
    const s = stats.get(p.id);
    const oppPoints = s.opponents.map(pointsOf);
    const buchholz = oppPoints.reduce((sum, v) => sum + v, 0);
    const buchholzCut = oppPoints.length > 0 ? buchholz - Math.min(...oppPoints) : 0;
    const sonneborn = s.results.reduce((sum, r) => sum + r.score * pointsOf(r.opponent), 0);
    const performance = s.played > 0 ? performanceRating(s.oppRatings, s.gamePoints) : p.elo;
    return {
      playerId: p.id,
      name: p.name,
      elo: p.elo,
      seed: p.seed,
      points: round4(s.points),
      gamePoints: round4(s.gamePoints),
      played: s.played,
      wins: s.wins,
      draws: s.draws,
      losses: s.losses,
      byes: s.byes,
      bestStreak: s.bestStreak,
      buchholz: round4(buchholz),
      buchholzCut: round4(buchholzCut),
      sonnebornBerger: round4(sonneborn),
      performance,
      ratingChange: round4(changes.get(p.id) || 0),
      rank: 0
    };
  });
  /* El enfrentamiento directo, como criterio de comparar de a dos, NO da un
     orden: si A le gana a B, B a C y C a A, no hay manera de ordenarlos y
     Array.sort devuelve lo que le salga segun donde estuviera cada uno, o sea
     segun el orden en que se inscribio la gente. Con las mismas partidas y los
     mismos resultados salian tres campeones distintos.
     La forma correcta —y la que usa la FIDE— es la miniliga: entre los que
     empatan a puntos, se cuenta lo que sumo cada uno CONTRA ESOS MISMOS. Eso
     es un numero, asi que ordena siempre igual, y un triangulo se resuelve
     solo: los tres suman lo mismo y decide el criterio siguiente. */
  const porPuntos = new Map();
  for (const row of rows) {
    const grupo = porPuntos.get(row.points) || [];
    grupo.push(row);
    porPuntos.set(row.points, grupo);
  }
  for (const grupo of porPuntos.values()) {
    for (const row of grupo) {
      let suma = 0;
      for (const otro of grupo) {
        if (otro === row) continue;
        const marcador = h2h.get(row.playerId + '|' + otro.playerId);
        if (marcador !== undefined) suma += marcador;
      }
      row.directScore = round4(suma);
    }
  }

  rows.sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    if (b.directScore !== a.directScore) return b.directScore - a.directScore;
    if (b.sonnebornBerger !== a.sonnebornBerger) return b.sonnebornBerger - a.sonnebornBerger;
    if (b.buchholzCut !== a.buchholzCut) return b.buchholzCut - a.buchholzCut;
    if (b.buchholz !== a.buchholz) return b.buchholz - a.buchholz;
    if (b.wins !== a.wins) return b.wins - a.wins;
    if (b.performance !== a.performance) return b.performance - a.performance;
    return a.seed - b.seed;
  });
  rows.forEach((row, i) => {
    row.rank = i + 1;
  });
  return rows;
}

/** Resumen final: campeon, podio, premios y rondas. */
export function tournamentSummary(t) {
  const table = standings(t);
  const finished = isFinished(t);
  let ordered = table;
  if (t.format === 'knockout' && finished) {
    const champion = roundWinners(t, t.round).filter((id) => id !== null)[0] || null;
    if (champion) {
      ordered = table.slice().sort((a, b) => {
        if (a.playerId === champion) return -1;
        if (b.playerId === champion) return 1;
        return a.rank - b.rank;
      });
    }
  }
  const podium = ordered.slice(0, Math.min(3, ordered.length)).map((row, i) => ({
    rank: i + 1,
    playerId: row.playerId,
    name: row.name,
    elo: row.elo,
    points: row.points,
    performance: row.performance,
    ratingChange: row.ratingChange,
    medal: MEDALS[i]
  }));
  const prizes = podium.map((row, i) => ({
    rank: row.rank,
    playerId: row.playerId,
    name: row.name,
    medal: MEDALS[i],
    label: PRIZE_LABELS[i],
    share: PRIZE_SHARES[i]
  }));
  return {
    id: t.id,
    name: t.name,
    format: t.format,
    finished,
    champion: finished && podium.length > 0 ? podium[0] : null,
    podium,
    prizes,
    rounds: { played: t.round, total: t.rounds },
    standings: table
  };
}

/** Serializa el torneo a un objeto plano apto para JSON. */
export function serialize(t) {
  return {
    version: 1,
    id: t.id,
    name: t.name,
    format: t.format,
    doubleRound: t.doubleRound,
    seed: t.seed,
    rngState: t.rngState,
    rounds: t.rounds,
    round: t.round,
    status: t.status,
    timeControl: { base: t.timeControl.base, inc: t.timeControl.inc },
    players: t.players.map((p) => ({
      id: p.id,
      name: p.name,
      elo: p.elo,
      isHuman: p.isHuman,
      botId: p.botId,
      gamesPlayed: p.gamesPlayed,
      seed: p.seed
    })),
    games: t.games.map((g) => ({
      id: g.id,
      round: g.round,
      slot: g.slot,
      white: g.white,
      black: g.black,
      result: g.result,
      suddenDeath: g.suddenDeath,
      parent: g.parent
    })),
    schedule: t.schedule ? t.schedule.map((r) => r.map((pair) => [pair[0], pair[1]])) : null,
    knockout: t.knockout
      ? {
          size: t.knockout.size,
          order: t.knockout.order.slice(),
          slots: t.knockout.slots.slice(),
          alive: t.knockout.alive.slice()
        }
      : null
  };
}

/** Reconstruye un torneo serializado. El ciclo serialize/deserialize es exacto. */
export function deserialize(obj) {
  if (!obj || typeof obj !== 'object') throw new Error('Datos de torneo no validos.');
  if (!FORMATS.includes(obj.format)) throw new Error('Formato de torneo desconocido: ' + obj.format);
  /* Un guardado al que le falta el calendario (liga) o el cuadro
     (eliminatoria) entraba sin protestar y reventaba al pulsar «siguiente
     ronda», con un TypeError y la pantalla muerta. Mejor decirlo aqui. */
  if (obj.format === 'roundrobin' && obj.round > 0 && !Array.isArray(obj.schedule)) {
    throw new Error('A ese torneo de liga le falta el calendario: no se puede continuar.');
  }
  if (obj.format === 'knockout' && obj.round > 0 && !obj.knockout) {
    throw new Error('A esa eliminatoria le falta el cuadro: no se puede continuar.');
  }
  /* Sin el numero de rondas no hay forma de saber cuando termina, e `isFinished`
     lo daba por acabado en cuanto se jugaba una: un torneo a medias se cerraba
     solo. serialize siempre lo escribe, asi que si falta es que los datos
     vienen rotos y es mejor decirlo. */
  const rondasGuardadas = Number(obj.rounds);
  if (!Number.isFinite(rondasGuardadas) || rondasGuardadas < 1) {
    throw new Error('A ese torneo le falta el número de rondas: no se puede continuar.');
  }

  return {
    id: String(obj.id),
    name: String(obj.name),
    format: obj.format,
    doubleRound: !!obj.doubleRound,
    seed: toFinite(Number(obj.seed), 1),
    rngState: toFinite(Number(obj.rngState), 1) >>> 0,
    rounds: Math.floor(rondasGuardadas),
    round: Math.max(0, toFinite(Number(obj.round), 0)),
    status: obj.status === 'running' || obj.status === 'finished' ? obj.status : 'pending',
    timeControl: {
      base: toFinite(obj.timeControl && Number(obj.timeControl.base), 300),
      inc: toFinite(obj.timeControl && Number(obj.timeControl.inc), 3)
    },
    players: (Array.isArray(obj.players) ? obj.players : []).map((p, i) => ({
      id: String(p.id),
      name: String(p.name),
      elo: toFinite(Number(p.elo), 1500),
      isHuman: !!p.isHuman,
      botId: p.botId === null || p.botId === undefined ? null : String(p.botId),
      gamesPlayed: toFinite(Number(p.gamesPlayed), 30),
      seed: toFinite(Number(p.seed), i)
    })),
    games: (Array.isArray(obj.games) ? obj.games : []).map((g) => ({
      id: String(g.id),
      round: toFinite(Number(g.round), 0),
      slot: toFinite(Number(g.slot), 0),
      white: g.white === null || g.white === undefined ? null : String(g.white),
      black: g.black === null || g.black === undefined ? null : String(g.black),
      /* Un resultado que no se reconoce NO puede colarse. Antes entraba tal
         cual y en computeStats `1 - null` da 1: unas tablas guardadas como
         «1/2» o «½-½» se convertian en victoria de las negras, en silencio.
         Y una cadena vacia dejaba una partida fantasma: ni puntuaba ni salia
         como pendiente, y el torneo se daba por terminado sin poder
         arreglarla. */
      result: resultadoValido(g.result) ? String(g.result) : null,
      suddenDeath: !!g.suddenDeath,
      parent: g.parent === null || g.parent === undefined ? null : String(g.parent)
    })),
    schedule: Array.isArray(obj.schedule)
      ? obj.schedule.map((r) => r.map((pair) => [pair[0] === null ? null : String(pair[0]), pair[1] === null ? null : String(pair[1])]))
      : null,
    knockout: obj.knockout
      ? {
          size: toFinite(Number(obj.knockout.size), 2),
          order: (obj.knockout.order || []).map(String),
          slots: (obj.knockout.slots || []).map((s) => (s === null ? null : String(s))),
          alive: (obj.knockout.alive || []).map((s) => (s === null ? null : String(s)))
        }
      : null
  };
}

/** Utilidad de lectura: datos de un jugador del torneo. */
export function tournamentPlayer(t, id) {
  const p = playerById(t, id);
  return p ? { ...p } : null;
}
