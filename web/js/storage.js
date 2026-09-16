/**
 * storage.js — the only module that touches localStorage. Everything lives
 * under a single root key so exporting, importing and resetting are trivial.
 * If storage is unavailable (private mode, blocked cookies) it degrades to an
 * in-memory store instead of throwing.
 */

import { applyResult, STARTING_RATING } from './elo.js';
import { evaluateAchievements } from './achievements.js';

const ROOT_KEY = 'ajedrezMaestro.v1';
const MAX_GAMES = 300;
const MAX_HISTORY = 400;

const CATEGORIES = ['bullet', 'blitz', 'rapid', 'classical', 'bots'];

let memoryFallback = null;

function backend() {
  try {
    if (typeof localStorage === 'undefined') throw new Error('sin localStorage');
    const probe = `${ROOT_KEY}.probe`;
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    return localStorage;
  } catch {
    if (!memoryFallback) {
      const map = new Map();
      memoryFallback = {
        getItem: (k) => (map.has(k) ? map.get(k) : null),
        setItem: (k, v) => map.set(k, String(v)),
        removeItem: (k) => map.delete(k),
      };
    }
    return memoryFallback;
  }
}

function readRoot() {
  try {
    const raw = backend().getItem(ROOT_KEY);
    if (!raw) return emptyRoot();
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return emptyRoot();
    return {
      profile: parsed.profile || defaultProfile(),
      settings: { ...defaultSettings(), ...(parsed.settings || {}) },
      games: Array.isArray(parsed.games) ? parsed.games : [],
      tournaments: Array.isArray(parsed.tournaments) ? parsed.tournaments : [],
    };
  } catch {
    return emptyRoot();
  }
}

function writeRoot(root) {
  try {
    backend().setItem(ROOT_KEY, JSON.stringify(root));
    return true;
  } catch {
    // Quota exceeded: shed the oldest games and try once more.
    try {
      root.games = root.games.slice(0, Math.floor(MAX_GAMES / 3));
      backend().setItem(ROOT_KEY, JSON.stringify(root));
      return true;
    } catch {
      return false;
    }
  }
}

function emptyRoot() {
  return { profile: defaultProfile(), settings: defaultSettings(), games: [], tournaments: [] };
}

function randomId(prefix) {
  const rnd = Math.random().toString(36).slice(2, 9);
  return `${prefix}_${Date.now().toString(36)}${rnd}`;
}

export function defaultProfile() {
  const ratings = {};
  for (const c of CATEGORIES) {
    ratings[c] = { rating: STARTING_RATING, games: 0, rd: 350, peak: STARTING_RATING, history: [] };
  }
  return {
    version: 1,
    id: randomId('u'),
    name: 'Invitado',
    avatarSeed: Math.random().toString(36).slice(2, 10),
    createdAt: Date.now(),
    ratings,
    stats: {
      wins: 0, losses: 0, draws: 0,
      byBot: {},
      currentStreak: 0, bestStreak: 0,
      bestWin: null,
      totalMoves: 0, totalTimeMs: 0,
      tournamentsPlayed: 0, tournamentsWon: 0,
      tournamentsCounted: [],   // ids ya apuntados, para no contarlos dos veces
    },
    achievements: [],
    defeatedBots: [],
    /* El entrenamiento tactico lleva su propia puntuacion: resolver problemas
       no es lo mismo que jugar partidas y mezclarlas no diria nada de ninguna
       de las dos. */
    puzzles: {
      rating: 900,
      solved: 0,
      failed: 0,
      bestStreak: 0,
      currentStreak: 0,
      recent: [],      // ids de los ultimos, para no repetir enseguida
      byTheme: {},
    },
  };
}

export function defaultSettings() {
  return {
    pieceSet: 'clasico',
    boardTheme: 'verde',
    sound: true,
    volume: 0.6,
    animations: true,
    showLegalMoves: true,
    showEvalBar: true,
    showCoordinates: true,
    autoQueen: false,
    confirmMove: false,
    highlightLastMove: true,
    showBotChat: true,
    premove: true,
    /* Direccion del servidor de partidas. Vacio = el mismo sitio desde el que
       se sirve la pagina, que es lo correcto con `npm start`. Hace falta
       rellenarlo cuando la pagina vive en itch.io o GitHub Pages y el
       servidor esta en otro sitio. */
    serverUrl: '',
    /* El servidor da un pase al entrar; guardarlo es lo que permite volver a
       la misma partida y a la misma puntuacion despues de recargar. Sin esto,
       cada recarga creaba un invitado nuevo y la partida en curso se perdia. */
    onlineToken: '',
  };
}

/* --------------------------- profile & settings --------------------------- */

export function loadProfile() {
  const p = readRoot().profile;
  // Heal profiles written by older versions.
  for (const c of CATEGORIES) {
    if (!p.ratings[c]) p.ratings[c] = { rating: STARTING_RATING, games: 0, rd: 350, peak: STARTING_RATING, history: [] };
  }
  if (!p.stats) p.stats = defaultProfile().stats;
  if (!Array.isArray(p.achievements)) p.achievements = [];
  if (!Array.isArray(p.defeatedBots)) p.defeatedBots = [];
  return p;
}

export function saveProfile(profile) {
  const root = readRoot();
  root.profile = profile;
  return writeRoot(root);
}

export function loadSettings() {
  return readRoot().settings;
}

export function saveSettings(settings) {
  const root = readRoot();
  root.settings = { ...root.settings, ...settings };
  writeRoot(root);
  return root.settings;
}

/* --------------------------------- games --------------------------------- */

export function saveGame(game) {
  const root = readRoot();
  const record = { id: game.id || randomId('g'), ts: game.ts || Date.now(), ...game };
  root.games.unshift(record);
  if (root.games.length > MAX_GAMES) root.games.length = MAX_GAMES;
  writeRoot(root);
  return record;
}

export function loadGames(limit = 50) {
  return readRoot().games.slice(0, limit);
}

export function getGame(id) {
  return readRoot().games.find((g) => g.id === id) || null;
}

export function deleteGame(id) {
  const root = readRoot();
  root.games = root.games.filter((g) => g.id !== id);
  return writeRoot(root);
}

/* ------------------------------- tournaments ------------------------------ */

export function saveTournament(t) {
  const root = readRoot();
  const idx = root.tournaments.findIndex((x) => x.id === t.id);
  if (idx >= 0) root.tournaments[idx] = t;
  else root.tournaments.unshift(t);
  if (root.tournaments.length > 40) root.tournaments.length = 40;
  writeRoot(root);
  return t;
}

export function loadTournaments() {
  return readRoot().tournaments;
}

export function getTournament(id) {
  return readRoot().tournaments.find((t) => t.id === id) || null;
}

export function deleteTournament(id) {
  const root = readRoot();
  root.tournaments = root.tournaments.filter((t) => t.id !== id);
  return writeRoot(root);
}

/* ------------------------------ results & Elo ----------------------------- */

/**
 * Record a finished game: updates the rating for its category, the stats, the
 * defeated-bot gallery and any newly unlocked achievements, then persists it.
 *
 * @returns {{ratingBefore, ratingAfter, delta, unlocked: string[], profile}}
 */
export function recordResult({
  mode, category = 'bots', opponent = {}, result, rated = true,
  pgn = null, sanMoves = [], facts = {}, totalBots = 0, tournamentWon = false, plies = 0, timeMs = 0,
  myColor = null,
}) {
  const root = readRoot();
  const profile = root.profile;
  for (const c of CATEGORIES) {
    if (!profile.ratings[c]) profile.ratings[c] = { rating: STARTING_RATING, games: 0, rd: 350, peak: STARTING_RATING, history: [] };
  }
  const bucket = profile.ratings[category] || profile.ratings.bots;
  const ratingBefore = bucket.rating;
  const score = result === 'win' ? 1 : result === 'draw' ? 0.5 : 0;

  let ratingAfter = ratingBefore;
  let delta = 0;
  if (rated && typeof opponent.elo === 'number') {
    const out = applyResult(ratingBefore, opponent.elo, score, {
      gamesA: bucket.games,
      gamesB: 100,
      peakA: bucket.peak || ratingBefore,
    });
    ratingAfter = out.a;
    delta = out.deltaA;
    bucket.rating = ratingAfter;
    bucket.games += 1;
    bucket.peak = Math.max(bucket.peak || 0, ratingAfter);
    bucket.history.push({
      ts: Date.now(), rating: ratingAfter, delta, result,
      opponent: opponent.name || '—', opponentRating: opponent.elo,
    });
    if (bucket.history.length > MAX_HISTORY) bucket.history.splice(0, bucket.history.length - MAX_HISTORY);
  }

  const stats = profile.stats;
  if (result === 'win') { stats.wins += 1; stats.currentStreak += 1; }
  else if (result === 'loss') { stats.losses += 1; stats.currentStreak = 0; }
  else { stats.draws += 1; stats.currentStreak = 0; }
  stats.bestStreak = Math.max(stats.bestStreak || 0, stats.currentStreak);
  stats.totalMoves = (stats.totalMoves || 0) + plies;
  stats.totalTimeMs = (stats.totalTimeMs || 0) + timeMs;

  if (result === 'win' && typeof opponent.elo === 'number') {
    if (!stats.bestWin || opponent.elo > stats.bestWin.elo) {
      stats.bestWin = { name: opponent.name || '—', elo: opponent.elo, ts: Date.now(), botId: opponent.botId || null };
    }
  }

  if (opponent.botId) {
    const byBot = stats.byBot[opponent.botId] || { wins: 0, losses: 0, draws: 0 };
    if (result === 'win') byBot.wins += 1;
    else if (result === 'loss') byBot.losses += 1;
    else byBot.draws += 1;
    stats.byBot[opponent.botId] = byBot;
    if (result === 'win' && !profile.defeatedBots.includes(opponent.botId)) {
      profile.defeatedBots.push(opponent.botId);
    }
  }

  if (tournamentWon) stats.tournamentsWon = (stats.tournamentsWon || 0) + 1;

  const unlocked = evaluateAchievements({
    profile, result, mode, opponent, f: facts, totalBots, tournamentWon,
  });
  if (unlocked.length) profile.achievements.push(...unlocked);

  const gameRecord = {
    id: randomId('g'), ts: Date.now(), mode, category, result, rated,
    opponent: { name: opponent.name || '—', elo: opponent.elo ?? null, botId: opponent.botId || null },
    ratingBefore, ratingAfter, delta, plies: plies || sanMoves.length, pgn,
    /* De que color jugaste: sin esto, al sacar problemas de tus partidas no se
       sabe cuales de los errores son tuyos y cuales del rival. */
    myColor: myColor === 'b' ? 'b' : 'w',
  };
  root.games.unshift(gameRecord);
  if (root.games.length > MAX_GAMES) root.games.length = MAX_GAMES;

  writeRoot(root);
  return { ratingBefore, ratingAfter, delta, unlocked, profile, game: gameRecord };
}

/** Unlock achievements outside of a finished game (e.g. the analysis board). */
/**
 * Apunta el resultado de un problema y devuelve el perfil ya guardado.
 * Se queda con los ultimos 60 ids para no volver a poner el mismo enseguida.
 */
export function recordPuzzle({ id, solved, theme = 'ventaja', rating = null, delta = 0 }) {
  const root = readRoot();
  const profile = root.profile;
  if (!profile.puzzles) profile.puzzles = defaultProfile().puzzles;
  const p = profile.puzzles;

  if (solved) {
    p.solved = (p.solved || 0) + 1;
    p.currentStreak = (p.currentStreak || 0) + 1;
    p.bestStreak = Math.max(p.bestStreak || 0, p.currentStreak);
  } else {
    p.failed = (p.failed || 0) + 1;
    p.currentStreak = 0;
  }
  if (typeof rating === 'number' && Number.isFinite(rating)) p.rating = Math.round(rating);
  /* Un perfil traido de una version intermedia puede no tener el reparto por
     tema; sin esta linea, la primera llamada lanzaba y el entrenamiento no
     guardaba NADA en silencio. */
  if (!p.byTheme || typeof p.byTheme !== 'object') p.byTheme = {};
  const porTema = p.byTheme[theme] || { solved: 0, failed: 0 };
  if (solved) porTema.solved += 1; else porTema.failed += 1;
  p.byTheme[theme] = porTema;

  if (id) {
    p.recent = [id, ...(p.recent || []).filter((x) => x !== id)].slice(0, 60);
  }
  p.lastDelta = Math.round(delta) || 0;

  writeRoot(root);
  return profile;
}

/**
 * Apunta que un torneo empezó o terminó. Sin esto, ganar un torneo no dejaba
 * rastro: `tournamentsPlayed` y `tournamentsWon` se quedaban en cero para
 * siempre y los dos logros de torneos eran imposibles de conseguir, porque
 * nadie pasaba nunca `tournamentWon`.
 */
export function recordTournament({ id = null, jugado = false, ganado = false, totalBots = 0 } = {}) {
  const root = readRoot();
  const stats = root.profile.stats;
  /* Idempotente por id. La pantalla de un torneo terminado se repinta cada vez
     que se entra, y `serialize` no guarda campos que no conozca, asi que una
     marca puesta en el torneo no sobrevivia: cada visita sumaba otro torneo
     jugado. La lista de contados vive con el perfil, que si se guarda entero. */
  if (!Array.isArray(stats.tournamentsCounted)) stats.tournamentsCounted = [];
  if (id && stats.tournamentsCounted.includes(id)) return [];
  if (id) stats.tournamentsCounted.push(id);

  if (jugado) stats.tournamentsPlayed = (stats.tournamentsPlayed || 0) + 1;
  if (ganado) stats.tournamentsWon = (stats.tournamentsWon || 0) + 1;
  writeRoot(root);
  if (!ganado) return [];
  return unlockAchievements({ tournamentWon: true, totalBots });
}

export function unlockAchievements(extraContext = {}) {
  const root = readRoot();
  const unlocked = evaluateAchievements({
    profile: root.profile, result: 'none', mode: 'none', opponent: {}, f: {}, ...extraContext,
  });
  if (unlocked.length) {
    root.profile.achievements.push(...unlocked);
    writeRoot(root);
  }
  return unlocked;
}

/* ------------------------------ import / export --------------------------- */

export function exportAll() {
  return JSON.stringify({ app: 'ajedrez-maestro', version: 1, exportedAt: Date.now(), data: readRoot() }, null, 2);
}

export function importAll(jsonString) {
  let parsed;
  try {
    parsed = JSON.parse(jsonString);
  } catch {
    return { ok: false, error: 'El archivo no es un JSON válido.' };
  }
  const data = parsed && parsed.data ? parsed.data : parsed;
  if (!data || typeof data !== 'object' || !data.profile) {
    return { ok: false, error: 'El archivo no contiene datos de Ajedrez Maestro.' };
  }
  const root = {
    profile: { ...defaultProfile(), ...data.profile },
    settings: { ...defaultSettings(), ...(data.settings || {}) },
    games: Array.isArray(data.games) ? data.games.slice(0, MAX_GAMES) : [],
    tournaments: Array.isArray(data.tournaments) ? data.tournaments.slice(0, 40) : [],
  };
  return writeRoot(root)
    ? { ok: true }
    : { ok: false, error: 'No se pudo guardar: el almacenamiento está lleno.' };
}

export function resetAll() {
  try {
    backend().removeItem(ROOT_KEY);
  } catch {
    /* nothing to do */
  }
  return emptyRoot();
}
