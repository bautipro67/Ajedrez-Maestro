/**
 * server.js — Ajedrez Maestro match server. It serves web/ as static files and
 * speaks the section 10 protocol over the WebSocket endpoint at /ws.
 * The server is the only authority: it validates every move with chess.js,
 * runs the clocks, decides the result, rates it with elo.js and stores users
 * and the leaderboard atomically under server/data/. No npm dependencies.
 */

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';

import { createWebSocketServer } from './ws.js';
import {
  createPosition, getFen, generateMoves, uciToMove, moveToSan, makeMove, gameResult,
  pieceType, pieceColor, WHITE, BLACK, PAWN, KNIGHT, BISHOP, ROOK, QUEEN,
} from '../web/js/chess.js';
import { applyResult } from '../web/js/elo.js';
import { timeCategory } from '../web/js/clock.js';
import { buildPgn } from '../web/js/pgn.js';

/* ----------------------------- constants ------------------------------- */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const DEFAULT_PORT = 8080;
const DEFAULT_RATING = 1200;
const RATING_CATEGORIES = ['bullet', 'blitz', 'rapid', 'classical'];

const MIN_BASE = 10;             // seconds
const MAX_BASE = 10800;
const MAX_INC = 180;
const MAX_NAME = 20;
const MAX_CHAT = 240;
const CHAT_MIN_GAP_MS = 700;
const DRAW_OFFER_GAP_MS = 8000;

/* Un minuto de gracia al que se desconecta. Se puede acortar con la variable
   de entorno AJEDREZ_ABANDON_MS, que es lo que hacen los tests para no tener
   que esperar el minuto entero; en produccion no se toca. */
const ABANDON_MS = Number(process.env.AJEDREZ_ABANDON_MS) > 0
  ? Number(process.env.AJEDREZ_ABANDON_MS)
  : 60000;
const ABANDON_TICK_MS = 15000;   // how often the countdown is repeated
const FINISHED_TTL_MS = 5 * 60 * 1000;
const WAITING_TTL_MS = 30 * 60 * 1000;
const QUICK_TICK_MS = 1000;
const JANITOR_MS = 30000;
const LOBBY_THROTTLE_MS = 250;
const SAVE_DEBOUNCE_MS = 200;
const MAX_STORED_USERS = 5000;

/* Quick pairing: +-200 Elo that widens 40 points per second of waiting. */
const QUICK_BASE_WINDOW = 200;
const QUICK_WIDEN_PER_SEC = 40;
const QUICK_MAX_WINDOW = 2000;

/* Token bucket per connection, so nobody can flood the server. */
const RATE_CAPACITY = 40;
const RATE_REFILL_PER_SEC = 20;

/* Letters for private room codes: I and O are left out to avoid confusion. */
const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const CODE_LENGTH = 5;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
};

/* Error codes the client knows how to translate (see web/js/online.js). */
const ERRORS = {
  noSuchGame: 'Esa partida ya no existe.',
  gameFull: 'La partida ya tiene dos jugadores.',
  notYourTurn: 'No es tu turno.',
  illegalMove: 'Esa jugada no es legal.',
  rateLimited: 'Vas demasiado rápido, esperá un momento.',
  badRequest: 'El servidor no entendió la petición.',
  notFound: 'No se encontró lo que pediste.',
};

/* ------------------------------- state --------------------------------- */

/* One server per process: the state lives in the module and startServer()
   points it at the right folders. */
const users = new Map();         // userId -> user record
const tokens = new Map();        // token -> userId
const games = new Map();         // gameId -> game record
const codes = new Map();         // private code -> gameId
const quickQueue = [];           // [{ userId, tc, rated, category, since }]

let webDir = path.join(ROOT, 'web');
let dataDir = path.join(HERE, 'data');
let wss = null;
let saveTimer = null;
let lobbyTimer = null;
let quickTimer = null;
let janitorTimer = null;
let logging = true;

function log(...parts) {
  if (logging) console.log('[ajedrez]', ...parts);
}

/* ------------------------------ helpers -------------------------------- */

function nowMs() {
  return Date.now();
}

function randomId(bytes = 8) {
  return randomBytes(bytes).toString('hex');
}

function newToken() {
  return randomBytes(24).toString('base64url');
}

/** Trims a client-supplied name: no control characters, bounded length. */
function cleanName(raw) {
  const text = typeof raw === 'string' ? raw : '';
  const clean = text
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME);
  return clean || 'Invitado';
}

/** Same treatment for chat lines; returns '' when nothing usable is left. */
function cleanText(raw, max = MAX_CHAT) {
  const text = typeof raw === 'string' ? raw : '';
  return text
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** Accepts whatever the client sent as a time control and makes it sane. */
function cleanTimeControl(raw) {
  const tc = raw && typeof raw === 'object' ? raw : {};
  const base = clampNumber(tc.base, MIN_BASE, MAX_BASE, 300);
  const inc = clampNumber(tc.inc, 0, MAX_INC, 0);
  return { base, inc };
}

function newCode() {
  for (let attempt = 0; attempt < 200; attempt++) {
    let code = '';
    const bytes = randomBytes(CODE_LENGTH);
    for (let i = 0; i < CODE_LENGTH; i++) code += CODE_LETTERS[bytes[i] % CODE_LETTERS.length];
    if (!codes.has(code)) return code;
  }
  return 'X' + randomId(2).toUpperCase().slice(0, CODE_LENGTH - 1);
}

/* ---------------------------- persistence ------------------------------ */

/**
 * Atomic write: a temporary file next to the target plus a rename, so a reader
 * never sees a half-written file and a crash cannot truncate the old one.
 */
async function writeJsonAtomic(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomId(4)}.tmp`;
  const text = JSON.stringify(value, null, 2);
  let handle = null;
  try {
    handle = await fsp.open(tmp, 'w');
    await handle.writeFile(text, 'utf8');
    await handle.sync().catch(() => {});
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
  await fsp.rename(tmp, file);
}

async function readJson(file, fallback) {
  try {
    const text = await fsp.readFile(file, 'utf8');
    const value = JSON.parse(text);
    return value && typeof value === 'object' ? value : fallback;
  } catch {
    return fallback;
  }
}

function usersFile() {
  return path.join(dataDir, 'users.json');
}

function leaderboardFile() {
  return path.join(dataDir, 'leaderboard.json');
}

/** Users worth keeping: the ones that played, and the most recent guests. */
function usersToPersist() {
  const all = [...users.values()];
  const played = all.filter((u) => totalGames(u) > 0);
  const idle = all.filter((u) => totalGames(u) === 0).sort((a, b) => b.lastSeen - a.lastSeen);
  return played.concat(idle).slice(0, MAX_STORED_USERS);
}

let savingChain = Promise.resolve();

/** Serialises saves so two flushes never fight over the same file. */
function saveNow() {
  savingChain = savingChain.then(async () => {
    try {
      const list = usersToPersist().map((u) => ({
        id: u.id,
        name: u.name,
        token: u.token,
        rating: u.rating,
        peak: u.peak,
        games: u.games,
        record: u.record,
        created: u.created,
        lastSeen: u.lastSeen,
      }));
      await writeJsonAtomic(usersFile(), { version: 1, saved: nowMs(), users: list });
      await writeJsonAtomic(leaderboardFile(), {
        version: 1,
        saved: nowMs(),
        top: leaderboardTop(50),
      });
    } catch (err) {
      log('no se pudo guardar:', err && err.message);
    }
  });
  return savingChain;
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveNow();
  }, SAVE_DEBOUNCE_MS);
  if (saveTimer.unref) saveTimer.unref();
}

async function loadData() {
  await fsp.mkdir(dataDir, { recursive: true });
  const stored = await readJson(usersFile(), { users: [] });
  const list = Array.isArray(stored.users) ? stored.users : [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const user = makeUser(cleanName(raw.name), typeof raw.token === 'string' ? raw.token : newToken());
    user.id = typeof raw.id === 'string' && raw.id ? raw.id : user.id;
    user.created = Number.isFinite(raw.created) ? raw.created : nowMs();
    user.lastSeen = Number.isFinite(raw.lastSeen) ? raw.lastSeen : user.created;
    for (const cat of RATING_CATEGORIES) {
      user.rating[cat] = clampNumber(raw.rating && raw.rating[cat], 100, 4000, DEFAULT_RATING);
      user.peak[cat] = clampNumber(raw.peak && raw.peak[cat], 100, 4000, user.rating[cat]);
      user.games[cat] = clampNumber(raw.games && raw.games[cat], 0, 1e7, 0);
    }
    if (raw.record && typeof raw.record === 'object') {
      user.record.wins = clampNumber(raw.record.wins, 0, 1e7, 0);
      user.record.losses = clampNumber(raw.record.losses, 0, 1e7, 0);
      user.record.draws = clampNumber(raw.record.draws, 0, 1e7, 0);
    }
    users.set(user.id, user);
    tokens.set(user.token, user.id);
  }
  log(`usuarios cargados: ${users.size}`);
}

/* ------------------------------- users --------------------------------- */

function makeUser(name, token = newToken()) {
  const user = {
    id: randomId(8),
    name,
    token,
    created: nowMs(),
    lastSeen: nowMs(),
    rating: {},
    peak: {},
    games: {},
    record: { wins: 0, losses: 0, draws: 0 },
    sockets: new Set(),          // live connections, never persisted
  };
  for (const cat of RATING_CATEGORIES) {
    user.rating[cat] = DEFAULT_RATING;
    user.peak[cat] = DEFAULT_RATING;
    user.games[cat] = 0;
  }
  return user;
}

function totalGames(user) {
  let sum = 0;
  for (const cat of RATING_CATEGORIES) sum += user.games[cat] || 0;
  return sum;
}

/** Best rating the player has, used for the leaderboard and quick pairing. */
function bestRating(user) {
  let best = DEFAULT_RATING;
  let seen = false;
  for (const cat of RATING_CATEGORIES) {
    if ((user.games[cat] || 0) <= 0) continue;
    if (!seen || user.rating[cat] > best) best = user.rating[cat];
    seen = true;
  }
  if (!seen) return user.rating.blitz;
  return best;
}

function ratingOf(user, category) {
  if (!user) return DEFAULT_RATING;
  if (!RATING_CATEGORIES.includes(category)) return bestRating(user);
  return user.rating[category];
}

function publicUser(userId, category) {
  const user = users.get(userId);
  if (!user) return null;
  return { id: user.id, name: user.name, rating: Math.round(ratingOf(user, category)) };
}

function sendToUser(userId, message) {
  const user = users.get(userId);
  if (!user) return;
  for (const client of user.sockets) {
    try {
      client.send(message);
    } catch {
      /* a broken socket is not our problem here */
    }
  }
}

function isOnline(userId) {
  const user = users.get(userId);
  return !!user && user.sockets.size > 0;
}

function leaderboardTop(limit = 20) {
  return [...users.values()]
    .filter((u) => totalGames(u) > 0)
    .map((u) => ({ name: u.name, rating: Math.round(bestRating(u)), games: totalGames(u) }))
    .sort((a, b) => b.rating - a.rating || b.games - a.games || a.name.localeCompare(b.name))
    .slice(0, limit);
}

/* ------------------------------- games --------------------------------- */

function createGame({ hostId, tc, rated, isPrivate }) {
  const id = randomId(6);
  const game = {
    id,
    code: isPrivate ? newCode() : null,
    private: !!isPrivate,
    rated: !!rated,
    tc,
    category: timeCategory(tc.base, tc.inc),
    host: hostId,
    white: null,
    black: null,
    pos: createPosition(),
    sanMoves: [],
    uciMoves: [],
    clockTags: [],
    clocks: { w: tc.base * 1000, b: tc.base * 1000 },
    turnStartedAt: 0,
    status: 'waiting',           // waiting | playing | over
    result: null,
    reason: '',
    ratings: null,
    pgn: '',
    createdAt: nowMs(),
    startedAt: 0,
    endedAt: 0,
    drawOffer: null,             // 'w' | 'b' — who has an offer on the table
    lastOffer: { w: 0, b: 0 },
    rematch: new Set(),
    spectators: new Set(),
    flagTimer: null,
    absent: { w: null, b: null },
    purgeTimer: null,
  };
  games.set(id, game);
  if (game.code) codes.set(game.code, id);
  return game;
}

function findGame(rawId) {
  if (typeof rawId !== 'string' || !rawId) return null;
  const direct = games.get(rawId);
  if (direct) return direct;
  const byCode = codes.get(rawId.trim().toUpperCase());
  return byCode ? games.get(byCode) || null : null;
}

function playerColor(game, userId) {
  if (!userId) return null;
  if (game.white === userId) return 'w';
  if (game.black === userId) return 'b';
  return null;
}

function opponentId(game, userId) {
  if (game.white === userId) return game.black;
  if (game.black === userId) return game.white;
  return null;
}

function turnColor(game) {
  return game.pos.turn === WHITE ? 'w' : 'b';
}

function audience(game) {
  const list = [];
  if (game.white) list.push(game.white);
  if (game.black && game.black !== game.white) list.push(game.black);
  for (const id of game.spectators) if (!list.includes(id)) list.push(id);
  return list;
}

function toGame(game, message) {
  for (const id of audience(game)) sendToUser(id, message);
}

/** The `game` payload of gameStart: contract fields plus what a client needs
    to resynchronise after a reconnection or when it starts watching. */
function gamePayload(game, viewerId = null) {
  return {
    id: game.id,
    white: publicUser(game.white, game.category),
    black: publicUser(game.black, game.category),
    tc: game.tc,
    rated: game.rated,
    fen: getFen(game.pos),
    code: game.code && (viewerId === game.host || playerColor(game, viewerId)) ? game.code : null,
    private: game.private,
    category: game.category,
    status: game.status,
    clocks: { w: Math.round(game.clocks.w), b: Math.round(game.clocks.b) },
    moves: game.uciMoves.slice(),
    sanMoves: game.sanMoves.slice(),
    moveNumber: game.pos.fullmove,
    youAre: playerColor(game, viewerId),
    started: game.startedAt,
  };
}

function lobbyPayload(viewerId = null) {
  const list = [];
  for (const game of games.values()) {
    if (game.status === 'waiting') {
      /* A private room is only listed for its host, which is how the code
         reaches the person who has to share it. */
      if (game.private && game.host !== viewerId) continue;
      const host = users.get(game.host);
      if (!host) continue;
      list.push({
        id: game.id,
        host: host.name,
        hostRating: Math.round(ratingOf(host, game.category)),
        tc: game.tc,
        rated: game.rated,
        private: game.private,
        code: game.private && game.host === viewerId ? game.code : undefined,
        mine: game.host === viewerId,
        created: game.createdAt,
      });
    } else if (game.status === 'playing') {
      list.push({
        id: game.id,
        live: true,
        status: 'playing',
        white: publicUser(game.white, game.category),
        black: publicUser(game.black, game.category),
        tc: game.tc,
        rated: game.rated,
        moveNumber: game.pos.fullmove,
        created: game.createdAt,
      });
    }
  }
  list.sort((a, b) => (b.created || 0) - (a.created || 0));
  return { t: 'lobby', games: list };
}

function broadcastLobby() {
  if (!wss) return;
  for (const client of wss.clients) {
    const userId = client.data && client.data.userId;
    if (!userId) continue;
    client.send(lobbyPayload(userId));
  }
}

function scheduleLobby() {
  if (lobbyTimer) return;
  lobbyTimer = setTimeout(() => {
    lobbyTimer = null;
    try {
      broadcastLobby();
    } catch (err) {
      log('lobby:', err && err.message);
    }
  }, LOBBY_THROTTLE_MS);
  if (lobbyTimer.unref) lobbyTimer.unref();
}

/* --------------------------- clock handling ---------------------------- */

/** Milliseconds the side to move has left right now. */
function remaining(game, color) {
  if (game.status !== 'playing') return game.clocks[color];
  if (color !== turnColor(game)) return game.clocks[color];
  return game.clocks[color] - (nowMs() - game.turnStartedAt);
}

function clearFlagTimer(game) {
  if (game.flagTimer) {
    clearTimeout(game.flagTimer);
    game.flagTimer = null;
  }
}

/** Arms the timer that fires exactly when the side to move runs out. */
function armFlagTimer(game) {
  clearFlagTimer(game);
  if (game.status !== 'playing') return;
  const color = turnColor(game);
  const left = Math.max(0, remaining(game, color));
  game.flagTimer = setTimeout(() => {
    game.flagTimer = null;
    try {
      flagFall(game, color);
    } catch (err) {
      log('bandera:', err && err.message);
    }
  }, left + 20);
  if (game.flagTimer.unref) game.flagTimer.unref();
}

/**
 * Can `color` still deliver mate with the material on the board? A flag fall
 * against a bare king (or a lone minor, or two knights) is a draw, not a loss.
 */
function canMate(pos, color) {
  let pawns = 0;
  let heavy = 0;
  let knights = 0;
  let lightBishops = 0;
  let darkBishops = 0;
  for (let sq = 0; sq < 128; sq++) {
    if (sq & 0x88) {
      sq += 7;
      continue;
    }
    const pc = pos.board[sq];
    if (pc === 0 || pieceColor(pc) !== color) continue;
    const type = pieceType(pc);
    if (type === PAWN) pawns++;
    else if (type === ROOK || type === QUEEN) heavy++;
    else if (type === KNIGHT) knights++;
    else if (type === BISHOP) {
      if (((sq >> 4) + (sq & 7)) & 1) lightBishops++;
      else darkBishops++;
    }
  }
  if (pawns > 0 || heavy > 0) return true;
  const bishops = lightBishops + darkBishops;
  if (knights + bishops <= 1) return false;
  if (knights === 0 && (lightBishops === 0 || darkBishops === 0)) return false;
  if (bishops === 0 && knights === 2) return false;
  return true;
}

function flagFall(game, color) {
  if (game.status !== 'playing') return;
  if (remaining(game, color) > 0) {
    armFlagTimer(game);
    return;
  }
  game.clocks[color] = 0;
  const other = color === 'w' ? 'b' : 'w';
  const otherColor = other === 'w' ? WHITE : BLACK;
  if (!canMate(game.pos, otherColor)) {
    finishGame(game, '1/2-1/2', 'Se acabó el tiempo, pero no hay material para dar mate: tablas.');
    return;
  }
  const winner = other === 'w' ? 'blancas' : 'negras';
  finishGame(game, other === 'w' ? '1-0' : '0-1', `Se acabó el tiempo: ganan las ${winner}.`);
}

/* -------------------------- starting a game ---------------------------- */

function startGame(game, whiteId, blackId) {
  game.white = whiteId;
  game.black = blackId;
  game.status = 'playing';
  game.startedAt = nowMs();
  game.clocks = { w: game.tc.base * 1000, b: game.tc.base * 1000 };
  game.turnStartedAt = game.startedAt;
  armFlagTimer(game);
  for (const id of [whiteId, blackId]) {
    sendToUser(id, { t: 'gameStart', game: gamePayload(game, id) });
  }
  scheduleLobby();
  log(`partida ${game.id}: ${nameOf(whiteId)} (b) vs ${nameOf(blackId)} (n) ${game.tc.base}+${game.tc.inc}`);
}

function nameOf(userId) {
  const user = users.get(userId);
  return user ? user.name : '¿?';
}

/* --------------------------- ending a game ----------------------------- */

function clearGameTimers(game) {
  clearFlagTimer(game);
  for (const color of ['w', 'b']) stopAbandonTimer(game, color);
}

function schedulePurge(game) {
  if (game.purgeTimer) clearTimeout(game.purgeTimer);
  game.purgeTimer = setTimeout(() => {
    game.purgeTimer = null;
    dropGame(game);
  }, FINISHED_TTL_MS);
  if (game.purgeTimer.unref) game.purgeTimer.unref();
}

function dropGame(game) {
  clearGameTimers(game);
  if (game.purgeTimer) {
    clearTimeout(game.purgeTimer);
    game.purgeTimer = null;
  }
  if (game.code) codes.delete(game.code);
  games.delete(game.id);
}

/** Applies Elo (when the game is rated) and returns the contract's block. */
function applyRatings(game, result) {
  const white = users.get(game.white);
  const black = users.get(game.black);
  const category = game.category;
  const beforeWhite = Math.round(ratingOf(white, category));
  const beforeBlack = Math.round(ratingOf(black, category));
  const unchanged = {
    white: { before: beforeWhite, after: beforeWhite, delta: 0 },
    black: { before: beforeBlack, after: beforeBlack, delta: 0 },
  };
  if (!white || !black || white === black) return unchanged;

  const scoreWhite = result === '1-0' ? 1 : result === '0-1' ? 0 : 0.5;
  /* Wins and losses always count for the record; only rated games move Elo. */
  if (result === '1/2-1/2') {
    white.record.draws++;
    black.record.draws++;
  } else if (result === '1-0') {
    white.record.wins++;
    black.record.losses++;
  } else {
    white.record.losses++;
    black.record.wins++;
  }

  if (!game.rated || !RATING_CATEGORIES.includes(category)) {
    scheduleSave();
    return unchanged;
  }

  const outcome = applyResult(beforeWhite, beforeBlack, scoreWhite, {
    gamesA: white.games[category],
    gamesB: black.games[category],
    peakA: white.peak[category],
    peakB: black.peak[category],
  });
  white.rating[category] = outcome.a;
  black.rating[category] = outcome.b;
  white.peak[category] = Math.max(white.peak[category], outcome.a);
  black.peak[category] = Math.max(black.peak[category], outcome.b);
  white.games[category]++;
  black.games[category]++;
  scheduleSave();
  return {
    white: { before: beforeWhite, after: outcome.a, delta: outcome.deltaA },
    black: { before: beforeBlack, after: outcome.b, delta: outcome.deltaB },
  };
}

function buildGamePgn(game) {
  try {
    const date = new Date(game.startedAt || game.createdAt);
    const stamp = `${date.getFullYear()}.${String(date.getMonth() + 1).padStart(2, '0')}.` +
      `${String(date.getDate()).padStart(2, '0')}`;
    return buildPgn({
      headers: {
        Event: 'Ajedrez Maestro online',
        Site: 'Ajedrez Maestro',
        Date: stamp,
        Round: '-',
        White: nameOf(game.white),
        Black: nameOf(game.black),
        Result: game.result || '*',
        WhiteElo: String(Math.round(ratingOf(users.get(game.white), game.category))),
        BlackElo: String(Math.round(ratingOf(users.get(game.black), game.category))),
        TimeControl: `${game.tc.base}+${game.tc.inc}`,
        Termination: game.reason || '',
      },
      sanMoves: game.sanMoves,
      result: game.result || '*',
      clocks: game.clockTags.length === game.sanMoves.length ? game.clockTags : null,
    });
  } catch {
    return '';
  }
}

function finishGame(game, result, reason) {
  if (game.status === 'over') return;
  const wasPlaying = game.status === 'playing';
  game.status = 'over';
  game.result = result;
  game.reason = reason;
  game.endedAt = nowMs();
  game.drawOffer = null;
  clearGameTimers(game);

  const ratings = wasPlaying
    ? applyRatings(game, result)
    : {
      white: { before: DEFAULT_RATING, after: DEFAULT_RATING, delta: 0 },
      black: { before: DEFAULT_RATING, after: DEFAULT_RATING, delta: 0 },
    };
  game.ratings = ratings;
  game.pgn = buildGamePgn(game);

  toGame(game, {
    t: 'gameOver',
    gameId: game.id,
    result,
    reason,
    ratings,
    pgn: game.pgn,
  });
  schedulePurge(game);
  scheduleLobby();
  scheduleSave();
  log(`fin de ${game.id}: ${result} — ${reason}`);
}

/* ------------------------ disconnection grace -------------------------- */

function stopAbandonTimer(game, color) {
  const state = game.absent[color];
  if (!state) return;
  clearTimeout(state.timer);
  clearInterval(state.ticker);
  game.absent[color] = null;
}

function startAbandonTimer(game, color) {
  if (game.status !== 'playing' || game.absent[color]) return;
  const deadline = nowMs() + ABANDON_MS;
  const rival = color === 'w' ? game.black : game.white;

  const announce = () => {
    const secondsLeft = Math.max(0, Math.ceil((deadline - nowMs()) / 1000));
    sendToUser(rival, { t: 'opponentGone', gameId: game.id, secondsLeft });
  };

  const state = {
    deadline,
    ticker: setInterval(announce, ABANDON_TICK_MS),
    timer: setTimeout(() => {
      game.absent[color] = null;
      try {
        const winner = color === 'w' ? 'negras' : 'blancas';
        finishGame(
          game,
          color === 'w' ? '0-1' : '1-0',
          `Se agotó el minuto de reconexión: ganan las ${winner}.`,
        );
      } catch (err) {
        log('abandono:', err && err.message);
      }
    }, ABANDON_MS),
  };
  if (state.ticker.unref) state.ticker.unref();
  if (state.timer.unref) state.timer.unref();
  game.absent[color] = state;
  announce();
}

/* --------------------------- quick pairing ----------------------------- */

function removeFromQueue(userId) {
  const index = quickQueue.findIndex((entry) => entry.userId === userId);
  if (index !== -1) quickQueue.splice(index, 1);
  return index !== -1;
}

function quickWindow(entry) {
  const waited = (nowMs() - entry.since) / 1000;
  return Math.min(QUICK_MAX_WINDOW, QUICK_BASE_WINDOW + waited * QUICK_WIDEN_PER_SEC);
}

function userIsBusy(userId) {
  for (const game of games.values()) {
    if (game.status === 'playing' && playerColor(game, userId)) return game;
  }
  return null;
}

/** Pairs everyone it can; both sides must be happy with the Elo gap. */
function runQuickMatcher() {
  for (let i = 0; i < quickQueue.length; i++) {
    const a = quickQueue[i];
    if (!isOnline(a.userId)) {
      quickQueue.splice(i, 1);
      i--;
      continue;
    }
    for (let j = i + 1; j < quickQueue.length; j++) {
      const b = quickQueue[j];
      if (a.userId === b.userId) continue;
      if (a.tc.base !== b.tc.base || a.tc.inc !== b.tc.inc) continue;
      if (a.rated !== b.rated) continue;
      if (!isOnline(b.userId)) continue;
      const ratingA = ratingOf(users.get(a.userId), a.category);
      const ratingB = ratingOf(users.get(b.userId), b.category);
      const gap = Math.abs(ratingA - ratingB);
      if (gap > quickWindow(a) || gap > quickWindow(b)) continue;

      quickQueue.splice(j, 1);
      quickQueue.splice(i, 1);
      i--;
      const game = createGame({ hostId: a.userId, tc: a.tc, rated: a.rated, isPrivate: false });
      const flip = randomBytes(1)[0] & 1;
      startGame(game, flip ? a.userId : b.userId, flip ? b.userId : a.userId);
      break;
    }
  }
}

/* ------------------------------ janitor -------------------------------- */

function runJanitor() {
  const now = nowMs();
  for (const game of [...games.values()]) {
    if (game.status === 'waiting') {
      const stale = now - game.createdAt > WAITING_TTL_MS;
      if (stale || !isOnline(game.host)) {
        dropGame(game);
        scheduleLobby();
      }
    } else if (game.status === 'over' && now - game.endedAt > FINISHED_TTL_MS) {
      dropGame(game);
    }
  }
  for (let i = quickQueue.length - 1; i >= 0; i--) {
    if (!isOnline(quickQueue[i].userId)) quickQueue.splice(i, 1);
  }
  /* Guests that never played and have been gone for a day are forgotten. */
  for (const user of [...users.values()]) {
    if (user.sockets.size > 0 || totalGames(user) > 0) continue;
    if (now - user.lastSeen < 24 * 3600 * 1000) continue;
    users.delete(user.id);
    tokens.delete(user.token);
  }
}

/* --------------------------- message plumbing -------------------------- */

function fail(client, code, message) {
  const known = ERRORS[code] ? code : 'badRequest';
  client.send({ t: 'error', code: known, message: message || ERRORS[known] });
}

function takeToken(client) {
  const rate = client.data.rate;
  const now = nowMs();
  rate.tokens = Math.min(
    RATE_CAPACITY,
    rate.tokens + ((now - rate.last) / 1000) * RATE_REFILL_PER_SEC,
  );
  rate.last = now;
  if (rate.tokens < 1) return false;
  rate.tokens -= 1;
  return true;
}

function currentUser(client) {
  const id = client.data.userId;
  return id ? users.get(id) || null : null;
}

/** Resolves the game a message refers to, answering the client if it cannot. */
function resolveGame(client, raw, { playing = false } = {}) {
  const game = findGame(raw);
  if (!game) {
    fail(client, 'noSuchGame');
    return null;
  }
  if (playing && game.status !== 'playing') {
    fail(client, 'badRequest', 'Esa partida no está en juego.');
    return null;
  }
  return game;
}

/* --------------------------- message handlers -------------------------- */

function handleHello(client, msg) {
  const name = cleanName(msg.name);
  let user = null;

  if (typeof msg.token === 'string' && msg.token) {
    const id = tokens.get(msg.token);
    if (id) user = users.get(id) || null;
  }
  if (!user) {
    user = makeUser(name);
    users.set(user.id, user);
    tokens.set(user.token, user.id);
  } else if (msg.name !== undefined) {
    user.name = name;
  }
  user.lastSeen = nowMs();

  /* One identity per connection: leaving the old one behind keeps the
     bookkeeping honest when somebody says hello twice. */
  const previous = currentUser(client);
  if (previous && previous !== user) detachClient(client, previous);

  client.data.userId = user.id;
  user.sockets.add(client);

  client.send({
    t: 'welcome',
    you: {
      id: user.id,
      name: user.name,
      token: user.token,
      rating: {
        bullet: Math.round(user.rating.bullet),
        blitz: Math.round(user.rating.blitz),
        rapid: Math.round(user.rating.rapid),
        classical: Math.round(user.rating.classical),
      },
      games: totalGames(user),
    },
  });
  scheduleSave();

  /* Reconnection: cancel the countdown, tell the rival and resend the game. */
  for (const game of games.values()) {
    const color = playerColor(game, user.id);
    if (!color) continue;
    if (game.status === 'playing') {
      if (game.absent[color]) {
        stopAbandonTimer(game, color);
        sendToUser(opponentId(game, user.id), { t: 'opponentBack', gameId: game.id });
      }
      client.send({ t: 'gameStart', game: gamePayload(game, user.id) });
    } else if (game.status === 'over' && nowMs() - game.endedAt < FINISHED_TTL_MS) {
      client.send({ t: 'gameStart', game: gamePayload(game, user.id) });
      client.send({
        t: 'gameOver',
        gameId: game.id,
        result: game.result,
        reason: game.reason,
        ratings: game.ratings,
        pgn: game.pgn,
      });
    }
  }
  client.send(lobbyPayload(user.id));
}

function handleLobby(client, user) {
  client.send(lobbyPayload(user.id));
}

function handleCreate(client, user, msg) {
  const busy = userIsBusy(user.id);
  if (busy) {
    fail(client, 'badRequest', 'Ya estás jugando una partida.');
    return;
  }
  /* Only one open room per player, so the lobby cannot be spammed. */
  for (const game of [...games.values()]) {
    if (game.status === 'waiting' && game.host === user.id) dropGame(game);
  }
  removeFromQueue(user.id);

  const tc = cleanTimeControl(msg.tc);
  const rated = msg.rated !== false;
  const isPrivate = msg.private === true;
  const wanted = msg.color === 'w' || msg.color === 'b' ? msg.color : 'random';
  const game = createGame({ hostId: user.id, tc, rated, isPrivate });
  game.hostColor = wanted;
  scheduleLobby();
  client.send(lobbyPayload(user.id));
}

function handleJoin(client, user, msg) {
  const game = findGame(typeof msg.gameId === 'string' ? msg.gameId : '');
  if (!game) {
    fail(client, 'noSuchGame');
    return;
  }
  if (game.status === 'playing' || game.status === 'over') {
    /* Already under way: the only sensible reading of "join" is to watch. */
    if (playerColor(game, user.id)) {
      client.send({ t: 'gameStart', game: gamePayload(game, user.id) });
      return;
    }
    fail(client, 'gameFull');
    return;
  }
  if (game.host === user.id) {
    fail(client, 'badRequest', 'No podés unirte a tu propia partida.');
    return;
  }
  if (userIsBusy(user.id)) {
    fail(client, 'badRequest', 'Ya estás jugando una partida.');
    return;
  }
  if (!isOnline(game.host)) {
    dropGame(game);
    scheduleLobby();
    fail(client, 'noSuchGame');
    return;
  }
  removeFromQueue(user.id);

  const wanted = game.hostColor || 'random';
  let hostIsWhite;
  if (wanted === 'w') hostIsWhite = true;
  else if (wanted === 'b') hostIsWhite = false;
  else hostIsWhite = (randomBytes(1)[0] & 1) === 1;
  startGame(
    game,
    hostIsWhite ? game.host : user.id,
    hostIsWhite ? user.id : game.host,
  );
}

function handleQuick(client, user, msg) {
  if (userIsBusy(user.id)) {
    fail(client, 'badRequest', 'Ya estás jugando una partida.');
    return;
  }
  const tc = cleanTimeControl(msg.tc);
  removeFromQueue(user.id);
  quickQueue.push({
    userId: user.id,
    tc,
    rated: msg.rated !== false,
    category: timeCategory(tc.base, tc.inc),
    since: nowMs(),
  });
  runQuickMatcher();
}

function handleCancelQuick(client, user) {
  removeFromQueue(user.id);
}

function handleMove(client, user, msg) {
  const game = resolveGame(client, msg.gameId, { playing: true });
  if (!game) return;
  const color = playerColor(game, user.id);
  if (!color) {
    fail(client, 'badRequest', 'No sos jugador de esa partida.');
    return;
  }
  if (color !== turnColor(game)) {
    fail(client, 'notYourTurn');
    return;
  }
  if (typeof msg.uci !== 'string') {
    fail(client, 'illegalMove');
    return;
  }

  /* The clock is charged before anything else: if the flag fell while the
     message was in flight, the move never happens. */
  const now = nowMs();
  const elapsed = now - game.turnStartedAt;
  if (game.clocks[color] - elapsed <= 0) {
    flagFall(game, color);
    return;
  }

  const legal = generateMoves(game.pos);
  const move = uciToMove(game.pos, msg.uci);
  if (move === -1 || !legal.includes(move)) {
    fail(client, 'illegalMove');
    return;
  }

  const moveNumber = game.pos.fullmove;
  const san = moveToSan(game.pos, move);
  makeMove(game.pos, move);

  game.clocks[color] -= elapsed;
  game.clocks[color] += game.tc.inc * 1000;
  game.turnStartedAt = now;
  game.sanMoves.push(san);
  game.uciMoves.push(msg.uci);
  game.clockTags.push(formatClockTag(game.clocks[color]));

  /* Moving answers any offer on the table. */
  if (game.drawOffer && game.drawOffer !== color) {
    sendToUser(opponentId(game, user.id), { t: 'drawDeclined', gameId: game.id });
  }
  game.drawOffer = null;

  const clocks = { w: Math.round(game.clocks.w), b: Math.round(game.clocks.b) };
  toGame(game, {
    t: 'move',
    gameId: game.id,
    uci: msg.uci,
    san,
    fen: getFen(game.pos),
    clocks,
    moveNumber,
    by: color,
  });

  const status = gameResult(game.pos);
  if (status.over) {
    const result = status.winner === null ? '1/2-1/2' : status.winner === WHITE ? '1-0' : '0-1';
    finishGame(game, result, status.text);
    return;
  }
  armFlagTimer(game);
}

function formatClockTag(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function handleResign(client, user, msg) {
  const game = resolveGame(client, msg.gameId, { playing: true });
  if (!game) return;
  const color = playerColor(game, user.id);
  if (!color) {
    fail(client, 'badRequest', 'No sos jugador de esa partida.');
    return;
  }
  const winner = color === 'w' ? 'negras' : 'blancas';
  finishGame(game, color === 'w' ? '0-1' : '1-0', `Abandono: ganan las ${winner}.`);
}

function handleDrawOffer(client, user, msg) {
  const game = resolveGame(client, msg.gameId, { playing: true });
  if (!game) return;
  const color = playerColor(game, user.id);
  if (!color) {
    fail(client, 'badRequest', 'No sos jugador de esa partida.');
    return;
  }
  if (game.drawOffer === color) return;
  if (game.drawOffer && game.drawOffer !== color) {
    /* Offering while the rival has one on the table means accepting it. */
    finishGame(game, '1/2-1/2', 'Tablas de común acuerdo.');
    return;
  }
  const now = nowMs();
  if (now - game.lastOffer[color] < DRAW_OFFER_GAP_MS) {
    fail(client, 'rateLimited', 'Esperá un poco antes de volver a ofrecer tablas.');
    return;
  }
  game.lastOffer[color] = now;
  game.drawOffer = color;
  sendToUser(opponentId(game, user.id), { t: 'drawOffer', gameId: game.id, from: user.name });
}

function handleDrawAccept(client, user, msg) {
  const game = resolveGame(client, msg.gameId, { playing: true });
  if (!game) return;
  const color = playerColor(game, user.id);
  if (!color) {
    fail(client, 'badRequest', 'No sos jugador de esa partida.');
    return;
  }
  if (!game.drawOffer || game.drawOffer === color) {
    fail(client, 'badRequest', 'No hay ninguna oferta de tablas que aceptar.');
    return;
  }
  finishGame(game, '1/2-1/2', 'Tablas de común acuerdo.');
}

function handleDrawDecline(client, user, msg) {
  const game = resolveGame(client, msg.gameId, { playing: true });
  if (!game) return;
  const color = playerColor(game, user.id);
  if (!color) {
    fail(client, 'badRequest', 'No sos jugador de esa partida.');
    return;
  }
  if (!game.drawOffer || game.drawOffer === color) return;
  game.drawOffer = null;
  sendToUser(opponentId(game, user.id), { t: 'drawDeclined', gameId: game.id });
}

/**
 * A rematch needs both players to ask for it. The first request is only
 * recorded (the protocol has no message to announce a pending offer); when the
 * second arrives the new game starts with the colours swapped.
 */
function handleRematch(client, user, msg) {
  const game = resolveGame(client, msg.gameId);
  if (!game) return;
  const color = playerColor(game, user.id);
  if (!color) {
    fail(client, 'badRequest', 'No sos jugador de esa partida.');
    return;
  }
  if (game.status !== 'over') {
    fail(client, 'badRequest', 'La partida todavía no terminó.');
    return;
  }
  const rival = opponentId(game, user.id);
  if (!isOnline(rival)) {
    fail(client, 'badRequest', 'Tu rival ya no está conectado.');
    return;
  }
  game.rematch.add(user.id);
  if (!game.rematch.has(rival)) return;
  if (userIsBusy(user.id) || userIsBusy(rival)) {
    fail(client, 'badRequest', 'Alguno de los dos ya está en otra partida.');
    return;
  }
  game.rematch.clear();
  const next = createGame({
    hostId: user.id,
    tc: game.tc,
    rated: game.rated,
    isPrivate: game.private,
  });
  startGame(next, game.black, game.white);
}

function handleChat(client, user, msg) {
  const game = resolveGame(client, msg.gameId);
  if (!game) return;
  const isPlayer = !!playerColor(game, user.id);
  if (!isPlayer && !game.spectators.has(user.id)) {
    fail(client, 'badRequest', 'No estás en esa partida.');
    return;
  }
  const text = cleanText(msg.text);
  if (!text) {
    fail(client, 'badRequest', 'El mensaje está vacío.');
    return;
  }
  const now = nowMs();
  if (now - (client.data.lastChat || 0) < CHAT_MIN_GAP_MS) {
    fail(client, 'rateLimited');
    return;
  }
  client.data.lastChat = now;
  toGame(game, { t: 'chat', gameId: game.id, from: user.name, text, ts: now });
}

function handleWatch(client, user, msg) {
  const game = resolveGame(client, msg.gameId);
  if (!game) return;
  if (!playerColor(game, user.id)) game.spectators.add(user.id);
  client.send({ t: 'gameStart', game: gamePayload(game, user.id) });
  if (game.status === 'over') {
    client.send({
      t: 'gameOver',
      gameId: game.id,
      result: game.result,
      reason: game.reason,
      ratings: game.ratings,
      pgn: game.pgn,
    });
  }
}

/**
 * Leaving means "I am not looking at this any more": it drops the spectator
 * and cancels a room nobody joined yet. A player who leaves a live game is
 * still a player — they have to resign, or let the clock and the grace period
 * decide — so the game is left alone.
 */
function handleLeave(client, user, msg) {
  const game = findGame(typeof msg.gameId === 'string' ? msg.gameId : '');
  if (!game) return;
  game.spectators.delete(user.id);
  if (game.status === 'waiting' && game.host === user.id) {
    dropGame(game);
    scheduleLobby();
    client.send(lobbyPayload(user.id));
  }
}

function handleLeaderboard(client) {
  client.send({ t: 'leaderboard', top: leaderboardTop(20) });
}

function handlePing(client, msg) {
  const ts = Number.isFinite(msg.ts) ? msg.ts : nowMs();
  client.send({ t: 'pong', ts });
}

/* Handlers that need an identified user. */
const GUARDED = {
  lobby: handleLobby,
  create: handleCreate,
  join: handleJoin,
  quick: handleQuick,
  cancelQuick: handleCancelQuick,
  move: handleMove,
  resign: handleResign,
  drawOffer: handleDrawOffer,
  drawAccept: handleDrawAccept,
  drawDecline: handleDrawDecline,
  rematch: handleRematch,
  chat: handleChat,
  watch: handleWatch,
  leave: handleLeave,
};

/**
 * Single entry point for everything a client says. Every branch is defensive:
 * whatever arrives, the answer is either a valid message or an `error`, and
 * the process stays up.
 */
function handleMessage(client, text) {
  if (typeof text !== 'string') return;
  if (!takeToken(client)) {
    fail(client, 'rateLimited');
    return;
  }

  let msg = null;
  try {
    msg = JSON.parse(text);
  } catch {
    fail(client, 'badRequest', 'El mensaje no es JSON válido.');
    return;
  }
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
    fail(client, 'badRequest', 'El mensaje tiene que ser un objeto JSON.');
    return;
  }
  const type = msg.t;
  if (typeof type !== 'string') {
    fail(client, 'badRequest', 'Falta el tipo de mensaje.');
    return;
  }

  if (type === 'ping') {
    handlePing(client, msg);
    return;
  }
  if (type === 'hello') {
    handleHello(client, msg);
    return;
  }
  if (type === 'leaderboard') {
    handleLeaderboard(client);
    return;
  }

  const handler = GUARDED[type];
  if (!handler) {
    fail(client, 'badRequest', `No conozco el mensaje «${type.slice(0, 24)}».`);
    return;
  }
  const user = currentUser(client);
  if (!user) {
    fail(client, 'badRequest', 'Identificate primero con un mensaje hello.');
    return;
  }
  user.lastSeen = nowMs();
  handler(client, user, msg);
}

/* ---------------------------- connections ------------------------------ */

function detachClient(client, user) {
  if (!user) return;
  user.sockets.delete(client);
  if (user.sockets.size > 0) return;

  user.lastSeen = nowMs();
  removeFromQueue(user.id);
  for (const game of [...games.values()]) {
    if (game.status === 'waiting' && game.host === user.id) {
      dropGame(game);
      scheduleLobby();
      continue;
    }
    game.spectators.delete(user.id);
    const color = playerColor(game, user.id);
    if (color && game.status === 'playing') startAbandonTimer(game, color);
  }
  scheduleSave();
}

function onConnection(client) {
  client.data = {
    userId: null,
    rate: { tokens: RATE_CAPACITY, last: nowMs() },
    lastChat: 0,
  };

  client.on('message', (text) => {
    try {
      handleMessage(client, text);
    } catch (err) {
      /* A bug of ours must not take the server down either. */
      log('error atendiendo un mensaje:', err && err.stack ? err.stack : err);
      try {
        fail(client, 'badRequest', 'No pude procesar ese mensaje.');
      } catch {
        /* the socket is gone; nothing else to do */
      }
    }
  });

  client.on('close', () => {
    try {
      detachClient(client, currentUser(client));
    } catch (err) {
      log('error cerrando una conexión:', err && err.message);
    }
  });

  client.on('error', () => {
    /* ws.js only emits this when somebody listens; swallowing it is enough. */
  });
}

/* --------------------------- static serving ---------------------------- */

/** Maps a URL path to a file inside web/, or null when it escapes the root. */
function resolveStatic(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.indexOf(String.fromCharCode(0)) !== -1) return null;

  const parts = decoded.split(/[/\\]+/).filter((part) => part && part !== '.');
  /* Directory traversal stops here: no '..' ever reaches path.join. */
  if (parts.some((part) => part === '..')) return null;

  const full = path.resolve(webDir, ...parts);
  const root = path.resolve(webDir);
  if (full !== root && !full.startsWith(root + path.sep)) return null;
  return full;
}

function sendPlain(res, status, message) {
  const body = Buffer.from(message, 'utf8');
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function serveFile(req, res, file) {
  fs.stat(file, (err, stats) => {
    if (err || !stats) {
      sendPlain(res, 404, 'No se encontró el archivo.');
      return;
    }
    if (stats.isDirectory()) {
      serveFile(req, res, path.join(file, 'index.html'));
      return;
    }
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': stats.size,
      'Cache-Control': 'no-cache',
      'Last-Modified': stats.mtime.toUTCString(),
      'X-Content-Type-Options': 'nosniff',
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    const stream = fs.createReadStream(file);
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  });
}

function onRequest(req, res) {
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendPlain(res, 405, 'Solo se admiten GET y HEAD.');
      return;
    }
    const raw = req.url || '/';
    const urlPath = raw.split('?')[0].split('#')[0];
    if (urlPath === '/ws') {
      sendPlain(res, 426, 'Esta ruta es para WebSocket.');
      return;
    }
    if (urlPath === '/salud' || urlPath === '/health') {
      const body = Buffer.from(JSON.stringify({
        ok: true,
        usuarios: users.size,
        partidas: games.size,
        cola: quickQueue.length,
      }), 'utf8');
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': body.length,
        'Cache-Control': 'no-store',
      });
      res.end(req.method === 'HEAD' ? undefined : body);
      return;
    }

    const file = resolveStatic(urlPath);
    if (!file) {
      sendPlain(res, 403, 'Ruta no permitida.');
      return;
    }
    serveFile(req, res, urlPath === '/' ? path.join(webDir, 'index.html') : file);
  } catch (err) {
    log('error sirviendo', req && req.url, err && err.message);
    try {
      sendPlain(res, 500, 'Error interno del servidor.');
    } catch {
      /* the response is already gone */
    }
  }
}

/* ------------------------------- startup ------------------------------- */

/**
 * Starts the HTTP + WebSocket server. `dataDir` and `webDir` are options so
 * the test scripts can run against a throwaway folder.
 */
export async function startServer(options = {}) {
  const port = Number.isFinite(Number(options.port))
    ? Number(options.port)
    : Number(process.env.PORT) || DEFAULT_PORT;
  const host = options.host || process.env.HOST || '0.0.0.0';
  webDir = path.resolve(options.webDir || path.join(ROOT, 'web'));
  dataDir = path.resolve(options.dataDir || process.env.DATA_DIR || path.join(HERE, 'data'));
  logging = options.silent !== true;

  await loadData();

  const httpServer = http.createServer(onRequest);
  httpServer.on('clientError', (err, socket) => {
    if (socket && socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });

  wss = createWebSocketServer({
    server: httpServer,
    path: '/ws',
    maxPayload: 1 << 20,
    heartbeatMs: 30000,
  });
  wss.on('connection', (client) => {
    try {
      onConnection(client);
    } catch (err) {
      log('error aceptando una conexión:', err && err.message);
      try {
        client.terminate();
      } catch {
        /* already gone */
      }
    }
  });

  quickTimer = setInterval(() => {
    try {
      runQuickMatcher();
    } catch (err) {
      log('emparejamiento:', err && err.message);
    }
  }, QUICK_TICK_MS);
  janitorTimer = setInterval(() => {
    try {
      runJanitor();
    } catch (err) {
      log('limpieza:', err && err.message);
    }
  }, JANITOR_MS);
  if (quickTimer.unref) quickTimer.unref();
  if (janitorTimer.unref) janitorTimer.unref();

  await new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, host, () => {
      httpServer.off('error', reject);
      resolve();
    });
  });

  const actualPort = httpServer.address().port;
  log(`escuchando en http://localhost:${actualPort} (WebSocket en /ws)`);
  log(`estáticos: ${webDir}`);
  log(`datos: ${dataDir}`);

  return {
    httpServer,
    wss,
    port: actualPort,
    url: `http://localhost:${actualPort}`,
    async close() {
      clearInterval(quickTimer);
      clearInterval(janitorTimer);
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }
      if (lobbyTimer) {
        clearTimeout(lobbyTimer);
        lobbyTimer = null;
      }
      for (const game of [...games.values()]) dropGame(game);
      quickQueue.length = 0;
      try {
        wss.close();
      } catch {
        /* ignore */
      }
      await new Promise((resolve) => httpServer.close(resolve));
      await saveNow();
      users.clear();
      tokens.clear();
      codes.clear();
      wss = null;
    },
  };
}

/* Run directly (`node server/server.js`) but stay quiet when imported. */
const invokedDirectly = process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const instance = await startServer();
  let closing = false;
  const shutdown = async (signal) => {
    if (closing) return;
    closing = true;
    log(`recibido ${signal}, guardando y cerrando…`);
    try {
      await instance.close();
    } catch (err) {
      log('al cerrar:', err && err.message);
    }
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('uncaughtException', (err) => {
    log('excepción no capturada:', err && err.stack ? err.stack : err);
  });
  process.on('unhandledRejection', (err) => {
    log('promesa rechazada sin capturar:', err && err.stack ? err.stack : err);
  });
}
