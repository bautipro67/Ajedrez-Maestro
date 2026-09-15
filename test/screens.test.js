/**
 * screens.test.js — Monta las ocho pantallas sobre el DOM simulado de
 * `domstub.js` y comprueba lo que se puede comprobar sin navegador: que el
 * modulo importa, que `mount()` no revienta, que pinta algo, que **todas las
 * clases CSS que usa existen de verdad en style.css** y que `unmount()` deja
 * limpio. No valida el aspecto: eso hay que mirarlo con los ojos.
 *
 * El montaje es asincrono (las pantallas piden cosas al motor), asi que todo
 * el trabajo se hace aqui arriba con await y despues se registran los tests,
 * que el mini-runner exige sincronos.
 */

import './domstub.js';
import { test, assert, assertEqual, run } from './harness.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as C from '../web/js/chess.js';
import { loadProfile, loadSettings } from '../web/js/storage.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.join(HERE, '..', 'web');

/* Clases declaradas en la hoja de estilos. */
const css = readFileSync(path.join(WEB, 'css', 'style.css'), 'utf8');
const KNOWN = new Set();
for (const match of css.matchAll(/\.(-?[A-Za-z_][\w-]*)/g)) KNOWN.add(match[1]);

/* Una pantalla puede dejar trabajo en marcha; se recoge en vez de reventar. */
const rejections = [];
process.on('unhandledRejection', (err) => {
  rejections.push(err && err.message ? err.message : String(err));
});

/* ------------------------------ contexto ------------------------------- */

function fakeAi() {
  return {
    usingWorkers: () => false,
    poolSize: () => 1,
    busy: () => false,
    async botMove({ fen }) {
      const pos = C.createPosition(fen);
      const legal = C.generateMoves(pos);
      if (!legal.length) return { uci: null, san: null, score: 0, rootMoves: [] };
      return {
        uci: C.moveToUci(legal[0]), san: C.moveToSan(pos, legal[0]), score: 10, mate: null,
        depth: 6, nodes: 1000, elapsedMs: 5, fromBook: false, bookName: null,
        rootMoves: [], thinkMs: 0,
      };
    },
    async analyze({ fen }) {
      const pos = C.createPosition(fen);
      const legal = C.generateMoves(pos);
      return {
        lines: legal.slice(0, 3).map((m, i) => ({
          uci: C.moveToUci(m), san: C.moveToSan(pos, m),
          pvUci: [C.moveToUci(m)], score: 20 - i * 15, mate: null,
        })),
        depth: 8, nodes: 2000, score: 20, mate: null,
      };
    },
    async evalOnly() { return 12; },
    stop() {}, newGame() {}, reset() {}, terminate() {},
  };
}

function makeCtx() {
  return {
    navigate() {},
    profile: loadProfile(),
    settings: loadSettings(),
    saveProfile() {}, saveSettings() {},
    ai: fakeAi(),
    online: {
      connect() {}, disconnect() {}, isConnected: () => false, latency: () => null,
      lobby() {}, create() {}, join() {}, quick() {}, cancelQuick() {}, watch() {},
      move() {}, resign() {}, offerDraw() {}, acceptDraw() {}, declineDraw() {},
      rematch() {}, chat() {}, leaderboard() {},
    },
    sound: { initSound() {}, setEnabled() {}, setVolume() {}, isEnabled: () => false, play() {}, playMoveSound() {} },
    toast() {},
    modal() { return { close() {} }; },
    confirm() { return Promise.resolve(false); },
    t: (key) => key,
  };
}

/* ------------------------------ inspeccion ------------------------------ */

function collect(node, acc) {
  if (!node || node.nodeType !== 1) return acc;
  acc.count++;
  for (const cls of String(node.className || '').split(/\s+/)) {
    if (cls) acc.classes.add(cls);
  }
  for (const child of node.childNodes) collect(child, acc);
  return acc;
}

async function inspect(spec) {
  const out = {
    label: spec.label, file: spec.file,
    hasMount: false, error: null, nodes: 0, classes: 0,
    unknown: [], handleOk: false, unmountError: null,
  };

  let mod;
  try {
    mod = await import(pathToFileURL(path.join(WEB, 'js', 'ui', spec.file)).href);
  } catch (err) {
    out.error = 'no se pudo importar: ' + (err && err.message ? err.message : err);
    return out;
  }
  out.hasMount = typeof mod.mount === 'function';
  if (!out.hasMount) return out;

  const root = document.createElement('main');
  let handle;
  try {
    handle = mod.mount(root, makeCtx(), spec.params);
  } catch (err) {
    out.error = err && err.stack ? err.stack.split('\n').slice(0, 3).join(' | ') : String(err);
    return out;
  }

  /* Que corra lo que la pantalla haya lanzado al montarse. */
  await new Promise((resolve) => setTimeout(resolve, 250));

  const acc = collect(root, { count: 0, classes: new Set() });
  out.nodes = acc.count;
  out.classes = acc.classes.size;
  out.unknown = [...acc.classes].filter((cls) => !KNOWN.has(cls)).sort();

  out.handleOk = !!(handle && typeof handle.unmount === 'function');
  if (out.handleOk) {
    try {
      handle.unmount();
    } catch (err) {
      out.unmountError = err && err.message ? err.message : String(err);
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 60));
  return out;
}

/* ------------------------------- pantallas ------------------------------ */

const SCREENS = [
  { label: 'inicio', file: 'home.js', params: {} },
  { label: 'seleccion de bot', file: 'botpicker.js', params: {} },
  { label: 'seleccion de bot, con rival ya elegido', file: 'botpicker.js', params: { botId: 'kenji-afinador' } },
  { label: 'partida local', file: 'gamescreen.js', params: { mode: 'local', query: {} } },
  {
    label: 'partida contra bot, con negras y reloj',
    file: 'gamescreen.js',
    params: { mode: 'bot', botId: 'helena-teorema', query: { color: 'black', tc: '3+2' } },
  },
  { label: 'partida online sin servidor', file: 'gamescreen.js', params: { mode: 'online', gameId: 'x' } },
  {
    label: 'partida de un torneo que no existe',
    file: 'gamescreen.js',
    params: { mode: 'tournament', tournamentId: 'no-existe', gameId: 'g1' },
  },
  { label: 'torneos', file: 'tournaments.js', params: {} },
  { label: 'perfil', file: 'profile.js', params: {} },
  { label: 'ajustes', file: 'settings.js', params: {} },
  { label: 'analisis', file: 'analysis.js', params: { gameId: null } },
  { label: 'online', file: 'online.js', params: {} },
  { label: 'entrenamiento', file: 'puzzles.js', params: { source: 'juego' } },
  { label: 'entrenamiento con tus partidas', file: 'puzzles.js', params: { source: 'propias' } },
];

const results = [];
for (const spec of SCREENS) {
  results.push(await inspect(spec));
}

/* --------------------------------- tests -------------------------------- */

for (const r of results) {
  test(`${r.label} (${r.file}) monta, pinta y desmonta`, () => {
    assert(r.hasMount, r.file + ' no exporta mount(root, ctx, params)');
    assertEqual(r.error, null, 'mount() lanzo una excepcion');
    assert(r.nodes >= 3, 'apenas genero ' + r.nodes + ' nodos: la pantalla sale vacia');
    assertEqual(r.unknown.length, 0,
      'usa clases que no existen en style.css: ' + r.unknown.join(', '));
    assert(r.handleOk, 'mount() debe devolver { unmount() }');
    assertEqual(r.unmountError, null, 'unmount() lanzo una excepcion');
  });
}

test('el router de app.js tiene una pantalla para cada ruta', () => {
  const app = readFileSync(path.join(WEB, 'js', 'app.js'), 'utf8');
  const referenced = [...app.matchAll(/import\('\.\/ui\/([\w-]+\.js)'\)/g)].map((m) => m[1]);
  assert(referenced.length >= 8, 'se esperaban al menos 8 pantallas enrutadas, hay ' + referenced.length);
  const tested = new Set(SCREENS.map((s) => s.file));
  for (const file of referenced) {
    assert(tested.has(file), 'app.js enruta ui/' + file + ' y esta suite no lo prueba');
  }
});

test('ninguna pantalla deja promesas sin capturar al montarse', () => {
  assertEqual(rejections.length, 0, rejections.slice(0, 4).join(' | '));
});

run('pantallas');
