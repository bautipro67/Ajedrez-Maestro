/**
 * bots.test.js — El plantel y el modelo de fuerza.
 * Comprueba que los personajes cumplen el contrato, que `strengthProfile` es
 * monotona (mas Elo nunca puede significar bot mas debil) y que
 * `chooseBotMove` se comporta: los fuertes eligen casi siempre la mejor, los
 * flojos se dispersan, y ninguno se mete a drede en un mate.
 */

import { test, assert, assertEqual, run } from './harness.js';
import {
  BOTS, BOT_EVENTS, botById, botsByTier, strengthProfile, chooseBotMove, botLine,
} from '../web/js/bots.js';
import { DEFAULT_WEIGHTS } from '../web/js/eval.js';
import { createPosition, generateMoves, getFen } from '../web/js/chess.js';

function makeRng(seed) {
  let state = seed >>> 0;
  return function rng() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const START = createPosition();
const LEGAL = generateMoves(START);
/** Jugadas de raiz sinteticas, ya ordenadas de mejor a peor. */
function rootMoves(scores) {
  return LEGAL.slice(0, scores.length).map((move, i) => ({
    move, score: scores[i], pv: [move], mate: null,
  }));
}
function ctxBase() {
  return { pos: createPosition(), moveNumber: 1, myColor: 0, inCheck: false, materialDiff: 0 };
}

/* -------------------------------- plantel -------------------------------- */

test('el plantel cumple el minimo y no tiene ids ni nombres repetidos', () => {
  assert(BOTS.length >= 24, 'el contrato pide al menos 24 bots y hay ' + BOTS.length);
  const ids = new Set();
  const nombres = new Set();
  for (const bot of BOTS) {
    assert(/^[a-z0-9]+(-[a-z0-9]+)*$/.test(bot.id), 'id no kebab-case: ' + bot.id);
    assert(!ids.has(bot.id), 'id repetido: ' + bot.id);
    ids.add(bot.id);
    assert(!nombres.has(bot.name), 'nombre repetido: ' + bot.name);
    nombres.add(bot.name);
  }
});

test('los Elo cubren todo el rango', () => {
  const elos = BOTS.map((b) => b.elo).sort((a, b) => a - b);
  for (const elo of elos) {
    assert(Number.isInteger(elo) && elo >= 250 && elo <= 2900, 'elo fuera de rango: ' + elo);
  }
  assert(elos[0] <= 400, 'hace falta algun bot de iniciacion, el mas flojo es ' + elos[0]);
  assert(elos[elos.length - 1] >= 2800, 'falta un bot de elite, el mas fuerte es ' + elos[elos.length - 1]);
  assert(new Set(elos).size >= 20, 'solo hay ' + new Set(elos).size + ' puntuaciones distintas');
  /* Sin huecos enormes: entre bots consecutivos, menos de 400 puntos. */
  for (let i = 1; i < elos.length; i++) {
    assert(elos[i] - elos[i - 1] <= 400,
      'hueco de ' + (elos[i] - elos[i - 1]) + ' puntos entre ' + elos[i - 1] + ' y ' + elos[i]);
  }
});

test('cada bot esta completo y bien tipado', () => {
  const estilos = new Set(['agresivo', 'posicional', 'tactico', 'caotico', 'solido',
    'materialista', 'romantico', 'tecnico']);
  const libros = new Set(['wide', 'sharp', 'solid', 'offbeat', 'none']);
  for (const bot of BOTS) {
    assert(typeof bot.name === 'string' && bot.name.length > 1, bot.id + ': sin nombre');
    assert(/^[A-Z]{2}$/.test(bot.country), bot.id + ': pais invalido ' + bot.country);
    assert(typeof bot.emoji === 'string' && bot.emoji.length > 0, bot.id + ': sin emoji');
    assert(bot.avatar && /^#[0-9a-fA-F]{6}$/.test(bot.avatar.bg), bot.id + ': avatar.bg invalido');
    assert(/^#[0-9a-fA-F]{6}$/.test(bot.avatar.fg), bot.id + ': avatar.fg invalido');
    assert(typeof bot.avatar.face === 'string' && bot.avatar.face.length > 0, bot.id + ': sin cara');
    assert(typeof bot.tagline === 'string' && bot.tagline.length > 4, bot.id + ': sin lema');
    assert(typeof bot.bio === 'string' && bot.bio.length > 24, bot.id + ': bio demasiado corta');
    assert(estilos.has(bot.style), bot.id + ': estilo desconocido ' + bot.style);
    assert(libros.has(bot.book), bot.id + ': libro desconocido ' + bot.book);
    assert(Array.isArray(bot.favoriteOpenings) && bot.favoriteOpenings.length > 0,
      bot.id + ': sin aperturas favoritas');
    assert(bot.title === null || ['CM', 'FM', 'IM', 'GM'].includes(bot.title),
      bot.id + ': titulo invalido ' + bot.title);
    if (bot.title) assert(bot.elo >= 2000, bot.id + ': titulo ' + bot.title + ' con solo ' + bot.elo);
  }
});

test('los pesos y los ajustes de fuerza usan claves que existen', () => {
  const pesos = new Set(Object.keys(DEFAULT_WEIGHTS));
  const fuerza = new Set(['depth', 'nodes', 'timeMs', 'evalNoise', 'blunderRate',
    'tacticalBlindness', 'temperature', 'quiescence', 'maxQDepth', 'thinkMs']);
  for (const bot of BOTS) {
    for (const [key, value] of Object.entries(bot.weights || {})) {
      assert(pesos.has(key), bot.id + ': weights.' + key + ' no existe en DEFAULT_WEIGHTS');
      assert(typeof value === 'number' && Number.isFinite(value), bot.id + ': weights.' + key + ' no es numero');
      if (key !== 'contempt') {
        assert(value >= 0 && value <= 2, bot.id + ': weights.' + key + ' fuera de 0..2 (' + value + ')');
      }
    }
    for (const key of Object.keys(bot.strength || {})) {
      assert(fuerza.has(key), bot.id + ': strength.' + key + ' no es del perfil de fuerza');
    }
  }
});

test('todos los bots tienen frases para los ocho momentos', () => {
  for (const bot of BOTS) {
    for (const event of BOT_EVENTS) {
      const list = bot.lines[event];
      assert(Array.isArray(list) && list.length >= 4,
        bot.id + ': lines.' + event + ' necesita 4 frases y tiene ' + (list ? list.length : 0));
      for (const phrase of list) {
        assert(typeof phrase === 'string' && phrase.trim().length > 3,
          bot.id + ': frase vacia en ' + event);
      }
    }
  }
});

test('ningun bot repite las frases de otro', () => {
  const vistas = new Map();
  for (const bot of BOTS) {
    for (const event of BOT_EVENTS) {
      for (const phrase of bot.lines[event]) {
        const key = phrase.trim().toLowerCase();
        assert(!vistas.has(key), 'frase repetida por ' + bot.id + ' y ' + vistas.get(key) + ': "' + phrase + '"');
        vistas.set(key, bot.id);
      }
    }
  }
});

test('botById y botsByTier', () => {
  for (const bot of BOTS) assertEqual(botById(bot.id), bot, 'botById devuelve el bot de ' + bot.id);
  assertEqual(botById('no-existe'), null, 'un id desconocido devuelve null');
  assertEqual(botById(undefined), null, 'sin id devuelve null');

  const tramos = botsByTier();
  assert(tramos.length > 1, 'deberia haber varios tramos');
  let total = 0;
  for (const grupo of tramos) {
    assert(grupo.tier && typeof grupo.tier.name === 'string', 'cada tramo trae su descripcion');
    total += grupo.bots.length;
    for (let i = 1; i < grupo.bots.length; i++) {
      assert(grupo.bots[i - 1].elo <= grupo.bots[i].elo, 'dentro del tramo van de menos a mas');
    }
  }
  assertEqual(total, BOTS.length, 'cada bot aparece en exactamente un tramo');
  for (let i = 1; i < tramos.length; i++) {
    assert(tramos[i - 1].tier.min < tramos[i].tier.min, 'los tramos van de flojo a fuerte');
  }
});

/* ---------------------------- curva de fuerza ---------------------------- */

test('strengthProfile devuelve el perfil completo', () => {
  const p = strengthProfile(1500);
  for (const key of ['depth', 'nodes', 'timeMs', 'evalNoise', 'blunderRate',
    'tacticalBlindness', 'temperature', 'quiescence', 'maxQDepth', 'thinkMs']) {
    assert(key in p, 'falta ' + key + ' en el perfil');
  }
  assert(Array.isArray(p.thinkMs) && p.thinkMs.length === 2, 'thinkMs es [min, max]');
  assert(p.thinkMs[0] <= p.thinkMs[1], 'thinkMs mal ordenado');
  assertEqual(typeof p.quiescence, 'boolean', 'quiescence es booleano');
});

test('mas Elo nunca puede dar un bot mas debil', () => {
  const suben = ['depth', 'nodes', 'timeMs', 'maxQDepth'];
  const bajan = ['evalNoise', 'blunderRate', 'tacticalBlindness', 'temperature'];
  let previo = strengthProfile(250);
  for (let elo = 300; elo <= 2900; elo += 50) {
    const actual = strengthProfile(elo);
    for (const key of suben) {
      assert(actual[key] >= previo[key],
        key + ' baja de ' + previo[key] + ' a ' + actual[key] + ' al subir a ' + elo);
    }
    for (const key of bajan) {
      assert(actual[key] <= previo[key],
        key + ' sube de ' + previo[key] + ' a ' + actual[key] + ' al subir a ' + elo);
    }
    assert(actual.thinkMs[0] >= previo.thinkMs[0], 'thinkMs minimo baja en ' + elo);
    previo = actual;
  }
});

test('los extremos de la curva son razonables', () => {
  const flojo = strengthProfile(250);
  const fuerte = strengthProfile(2900);
  assertEqual(flojo.depth, 1, 'el mas flojo mira una sola jugada');
  assert(flojo.quiescence === false, 'el mas flojo no ve las capturas encadenadas');
  assert(flojo.blunderRate > 0.25, 'el mas flojo tiene que fallar a menudo');
  assert(fuerte.blunderRate === 0, 'el mas fuerte no regala nada');
  assert(fuerte.evalNoise === 0, 'el mas fuerte evalua sin ruido');
  assert(fuerte.depth >= 14, 'el mas fuerte tiene que calcular hondo');
  assert(fuerte.nodes > flojo.nodes * 1000, 'la diferencia de nodos debe ser de ordenes de magnitud');
});

test('strengthProfile acota las entradas absurdas', () => {
  assertEqual(strengthProfile(-500).depth, strengthProfile(250).depth, 'por debajo del minimo se acota');
  assertEqual(strengthProfile(9999).depth, strengthProfile(2900).depth, 'por encima del maximo tambien');
  assert(Number.isFinite(strengthProfile(undefined).depth), 'sin Elo no revienta');
});

/* ---------------------------- eleccion de jugada -------------------------- */

test('chooseBotMove devuelve siempre una de las jugadas ofrecidas', () => {
  const moves = rootMoves([80, 50, 20, -10, -40, -90, -150, -220]);
  const permitidas = new Set(moves.map((m) => m.move));
  for (const elo of [250, 700, 1200, 1800, 2400, 2900]) {
    const rng = makeRng(elo);
    for (let i = 0; i < 50; i++) {
      const chosen = chooseBotMove(moves, strengthProfile(elo), rng, ctxBase());
      assert(permitidas.has(chosen), 'el bot de ' + elo + ' devolvio una jugada que no estaba');
    }
  }
});

test('casos degenerados', () => {
  assertEqual(chooseBotMove([], strengthProfile(1500), makeRng(1), ctxBase()), 0, 'sin jugadas devuelve 0');
  assertEqual(chooseBotMove(null, strengthProfile(1500), makeRng(1), ctxBase()), 0, 'entrada invalida');
  const una = rootMoves([30]);
  assertEqual(chooseBotMove(una, strengthProfile(250), makeRng(1), ctxBase()), una[0].move,
    'con una sola jugada la juega');
});

test('el bot fuerte elige casi siempre la mejor', () => {
  const moves = rootMoves([80, 30, 0, -40, -80, -130, -200, -300]);
  const rng = makeRng(2024);
  let mejores = 0;
  for (let i = 0; i < 200; i++) {
    if (chooseBotMove(moves, strengthProfile(2900), rng, ctxBase()) === moves[0].move) mejores++;
  }
  assert(mejores >= 170, 'solo eligio la mejor ' + mejores + '/200 veces');
});

test('el bot flojo se dispersa', () => {
  const moves = rootMoves([80, 30, 0, -40, -80, -130, -200, -300]);
  const rng = makeRng(2024);
  const vistas = new Set();
  for (let i = 0; i < 200; i++) {
    vistas.add(chooseBotMove(moves, strengthProfile(250), rng, ctxBase()));
  }
  assert(vistas.size >= 5, 'un bot de 250 solo probo ' + vistas.size + ' jugadas distintas');
});

test('ningun bot se mete a drede en un mate', () => {
  /* Una jugada decente y el resto, mate en contra. */
  const moves = rootMoves([300, -29990, -29992, -29994, -29996, -29998]);
  for (const elo of [250, 400, 900, 1600, 2900]) {
    const rng = makeRng(elo * 7);
    for (let i = 0; i < 100; i++) {
      assertEqual(chooseBotMove(moves, strengthProfile(elo), rng, ctxBase()), moves[0].move,
        'el bot de ' + elo + ' se dejo matar pudiendo evitarlo');
    }
  }
});

test('es determinista: mismo rng, misma partida', () => {
  const moves = rootMoves([80, 60, 40, 20, 0, -30, -70, -120]);
  for (const elo of [250, 1200, 2900]) {
    const a = [];
    const b = [];
    const rngA = makeRng(555);
    const rngB = makeRng(555);
    for (let i = 0; i < 60; i++) {
      a.push(chooseBotMove(moves, strengthProfile(elo), rngA, ctxBase()));
      b.push(chooseBotMove(moves, strengthProfile(elo), rngB, ctxBase()));
    }
    assertEqual(b.join(','), a.join(','), 'el bot de ' + elo + ' no es reproducible');
  }
});

test('chooseBotMove no toca la posicion que le pasan', () => {
  const moves = rootMoves([80, 50, 20, -10, -40]);
  const ctx = ctxBase();
  const antes = getFen(ctx.pos);
  const rng = makeRng(8);
  for (let i = 0; i < 40; i++) chooseBotMove(moves, strengthProfile(250), rng, ctx);
  assertEqual(getFen(ctx.pos), antes, 'la FEN cambio');
  assertEqual(ctx.pos.undoStack.length, 0, 'quedaron jugadas a medias en la pila');
});

test('funciona aunque no le den contexto', () => {
  const moves = rootMoves([80, 50, 20]);
  const permitidas = new Set(moves.map((m) => m.move));
  const chosen = chooseBotMove(moves, strengthProfile(600), makeRng(4), {});
  assert(permitidas.has(chosen), 'sin ctx deberia seguir eligiendo algo valido');
});

/* --------------------------------- frases -------------------------------- */

test('botLine saca una frase de las del bot', () => {
  const rng = makeRng(77);
  for (const bot of BOTS) {
    for (const event of BOT_EVENTS) {
      const phrase = botLine(bot, event, rng);
      assert(bot.lines[event].includes(phrase), bot.id + ': frase inventada en ' + event);
    }
  }
});

test('botLine no revienta con entradas raras', () => {
  assertEqual(botLine(null, 'win', makeRng(1)), '', 'sin bot devuelve cadena vacia');
  assertEqual(botLine(BOTS[0], 'evento-que-no-existe', makeRng(1)), '', 'evento desconocido');
});

test('botLine recorre el repertorio', () => {
  const bot = BOTS[0];
  const vistas = new Set();
  const rng = makeRng(5);
  for (let i = 0; i < 100; i++) vistas.add(botLine(bot, 'greeting', rng));
  assert(vistas.size >= 2, 'siempre dice lo mismo al saludar');
});

run('bots.js');
