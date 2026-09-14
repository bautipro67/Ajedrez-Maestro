/**
 * engine.test.js — Propiedades del buscador y de la evaluacion.
 * Los mates no se dan por buenos porque el motor lo diga: se reproduce la
 * variante principal con chess.js y se comprueba que termina en jaque mate.
 * Tambien se verifica que la busqueda respeta sus limites, que no muta la
 * posicion de quien la llama y que dos instancias no comparten estado.
 */

import { test, assert, assertEqual, run } from './harness.js';
import { createSearcher, MATE } from '../web/js/engine.js';
import { evaluate, seeCapture, DEFAULT_WEIGHTS } from '../web/js/eval.js';
import {
  createPosition,
  generateMoves,
  makeMove,
  gameResult,
  getFen,
  moveToSan,
  moveToUci,
  isCapture,
  moveTo,
  START_FEN,
} from '../web/js/chess.js';

const LONG = { timeMs: 600000 };

/** Reproduce la PV sobre la posicion inicial y describe a que lleva. */
function playPv(fen, pv) {
  const pos = createPosition(fen);
  const sans = [];
  for (const move of pv) {
    const legal = generateMoves(pos);
    if (!legal.includes(move)) {
      return { legal: false, sans, result: null, at: sans.length };
    }
    sans.push(moveToSan(pos, move));
    makeMove(pos, move);
  }
  return { legal: true, sans, result: gameResult(pos), fen: getFen(pos) };
}

/** La misma posicion con los colores y las filas invertidas. */
function mirrorFen(fen) {
  const parts = fen.trim().split(/\s+/);
  const swapCase = (s) => s.replace(/[a-zA-Z]/g, (c) =>
    (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()));
  const board = parts[0].split('/').reverse().map(swapCase).join('/');
  const turn = parts[1] === 'w' ? 'b' : 'w';
  let castling = '-';
  if (parts[2] !== '-') {
    const swapped = swapCase(parts[2]);
    castling = 'KQkq'.split('').filter((c) => swapped.includes(c)).join('') || '-';
  }
  const ep = parts[3] === '-' ? '-' : parts[3][0] + String(9 - Number(parts[3][1]));
  return [board, turn, castling, ep, parts[4] || '0', parts[5] || '1'].join(' ');
}

/* --------------------------------- mates -------------------------------- */

test('mate en 1: lo encuentra y la PV acaba en jaque mate', () => {
  const fen = '6k1/5ppp/8/8/8/8/8/R3K3 w - - 0 1';
  const searcher = createSearcher({ ttSizeMb: 4 });
  const result = searcher.searchRoot(createPosition(fen), { depth: 4, ...LONG });

  assertEqual(moveToUci(result.best), 'a1a8', 'la torre entrega mate por la octava');
  assertEqual(result.mate, 1, 'anuncia mate en 1');
  assertEqual(result.score, MATE - 1, 'la puntuacion de mate se ajusta por ply');

  const line = playPv(fen, result.pv);
  assert(line.legal, 'la PV es legal');
  assertEqual(line.result.reason, 'checkmate', 'la PV termina en mate: ' + line.sans.join(' '));
  assertEqual(line.sans.length, 1, 'el mate llega en una jugada');
});

test('mate en 2: sacrificio de dama y mate de caballo', () => {
  const fen = '2rr3k/pp3pp1/1nnqbN1p/3pN3/2pP4/2P3Q1/PPB4P/R4RK1 w - - 0 1';
  const searcher = createSearcher({ ttSizeMb: 4 });
  const result = searcher.searchRoot(createPosition(fen), { depth: 6, ...LONG });

  assertEqual(result.mate, 2, 'anuncia mate en 2');
  assertEqual(result.score, MATE - 3, 'mate en 2 son tres plies');

  const line = playPv(fen, result.pv);
  assert(line.legal, 'la PV es legal');
  assertEqual(line.result.reason, 'checkmate', 'la PV termina en mate: ' + line.sans.join(' '));
  assertEqual(line.sans.length, 3, 'tres medias jugadas hasta el mate');
});

test('mate en 2 con las negras: la deflexion del rey', () => {
  const fen = '6k1/pp4p1/2p5/2bp4/8/P5Pb/1P3rrP/2BRRN1K b - - 0 1';
  const searcher = createSearcher({ ttSizeMb: 4 });
  const result = searcher.searchRoot(createPosition(fen), { depth: 6, ...LONG });

  assertEqual(result.mate, 2, 'tambien ve los mates jugando con negras');
  const line = playPv(fen, result.pv);
  assert(line.legal, 'la PV es legal');
  assertEqual(line.result.reason, 'checkmate', 'la PV termina en mate: ' + line.sans.join(' '));
});

test('posiciones terminales: no inventa jugadas', () => {
  const searcher = createSearcher({ ttSizeMb: 1 });

  const stalemate = searcher.searchRoot(createPosition('8/8/8/8/8/6k1/6p1/6K1 w - - 0 1'), { depth: 4, ...LONG });
  assertEqual(stalemate.best, 0, 'sin jugadas legales no hay mejor jugada');
  assertEqual(stalemate.score, 0, 'el ahogado vale cero');
  assertEqual(stalemate.moves.length, 0, 'la lista de jugadas de raiz esta vacia');

  const mated = searcher.searchRoot(createPosition('R5k1/5ppp/8/8/8/8/8/4K3 b - - 0 1'), { depth: 4, ...LONG });
  assertEqual(mated.best, 0, 'estar mateado no produce jugada');
  assertEqual(mated.score, -MATE, 'estar mateado es la peor puntuacion');
});

/* ------------------------------- tactica -------------------------------- */

test('se lleva el material que le regalan', () => {
  const searcher = createSearcher({ ttSizeMb: 4 });
  const fen = '4k3/8/8/3q4/8/8/8/3RK3 w - - 0 1';
  const result = searcher.search(createPosition(fen), { depth: 6, ...LONG });
  assertEqual(moveToUci(result.best), 'd1d5', 'la torre se come la dama indefensa');
  /* Antes de la captura iba perdiendo la dama por torre; despues se queda con
     la torre sola frente al rey pelado. */
  assert(result.score > 400, 'y sabe que pasa a ganar: ' + result.score);
});

test('no cuelga piezas: tras su jugada nadie gana material de un bocado', () => {
  const fens = [
    START_FEN,
    'r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 4 4',
    'rnbqkb1r/pp3ppp/4pn2/2pp4/2PP4/2N1PN2/PP3PPP/R1BQKB1R b KQkq - 0 6',
    'r1bq1rk1/pp2ppbp/2np1np1/8/2BNP3/2N1B3/PPP2PPP/R2QK2R w KQ - 0 9',
  ];
  const searcher = createSearcher({ ttSizeMb: 8 });
  for (const fen of fens) {
    const pos = createPosition(fen);
    const result = searcher.search(pos, { depth: 7, nodes: 400000, ...LONG });
    const best = result.best;
    const san = moveToSan(pos, best);

    /* Si su jugada es una captura, el SEE ya incluye toda la cadena de
       recapturas: basta con que el cambio no sea perdedor. */
    const trade = isCapture(best);
    if (trade) {
      const see = seeCapture(pos, best);
      assert(see >= -100, san + ' es un cambio perdedor (' + see + ' cp) en ' + fen);
    }

    const after = createPosition(fen);
    makeMove(after, best);
    let worst = 0;
    let culprit = '';
    for (const reply of generateMoves(after)) {
      if (!isCapture(reply)) continue;
      /* La recaptura en la casilla del cambio ya la cubre el SEE de arriba. */
      if (trade && moveTo(reply) === moveTo(best)) continue;
      const see = seeCapture(after, reply);
      if (see > worst) {
        worst = see;
        culprit = moveToSan(after, reply);
      }
    }
    assert(worst <= 100,
      'tras ' + san + ' el rival gana ' + worst + ' cp con ' + culprit + ' en ' + fen);
  }
});

/* ----------------------------- evaluacion ------------------------------- */

test('la evaluacion es simetrica al invertir colores y filas', () => {
  const fens = [
    START_FEN,
    'r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 4 4',
    'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1',
    '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1',
    'rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8',
  ];
  for (const fen of fens) {
    const direct = evaluate(createPosition(fen), DEFAULT_WEIGHTS);
    const mirrored = evaluate(createPosition(mirrorFen(fen)), DEFAULT_WEIGHTS);
    /* Comparacion con ==, no Object.is: negar una posicion igualada da -0. */
    assert(mirrored === direct,
      'la reflejada deberia valer ' + direct + ' y vale ' + mirrored + ': ' + fen);
  }
});

test('la posicion inicial esta equilibrada', () => {
  const score = evaluate(createPosition(), DEFAULT_WEIGHTS);
  assert(Math.abs(score) <= 30, 'la salida no puede valer ' + score + ' cp');
});

/* -------------------------------- limites ------------------------------- */

test('respeta el limite de nodos', () => {
  const searcher = createSearcher({ ttSizeMb: 4 });
  const result = searcher.search(createPosition(), { depth: 64, nodes: 30000, ...LONG });
  assert(result.nodes >= 1000, 'algo tiene que buscar: ' + result.nodes);
  assert(result.nodes <= 60000, 'no se pasa del tope de nodos: ' + result.nodes);
  assert(result.best !== 0, 'devuelve una jugada igualmente');
});

test('respeta el limite de tiempo', () => {
  const searcher = createSearcher({ ttSizeMb: 8 });
  const started = Date.now();
  const result = searcher.search(createPosition(), { depth: 64, timeMs: 300 });
  const elapsed = Date.now() - started;
  assert(elapsed < 3000, 'corto a tiempo: ' + elapsed + ' ms');
  assert(result.best !== 0, 'devuelve una jugada');
  assert(result.depth >= 1, 'completa al menos una iteracion');
});

test('stop() corta la busqueda y el buscador queda utilizable', () => {
  const searcher = createSearcher({ ttSizeMb: 4 });
  const cortada = searcher.searchRoot(createPosition(), {
    depth: 64,
    evalNoise: 5,
    rng: () => {
      searcher.stop();
      return 0.5;
    },
    ...LONG,
  });
  assert(cortada.nodes < 5000, 'apenas busco nada: ' + cortada.nodes);
  assert(generateMoves(createPosition()).includes(cortada.best), 'aun asi devuelve una jugada legal');

  const normal = searcher.search(createPosition(), { depth: 5, ...LONG });
  assert(normal.depth >= 5, 'la siguiente busqueda vuelve a funcionar: profundidad ' + normal.depth);
});

/* ------------------------------- contrato ------------------------------- */

test('no muta la posicion de quien llama', () => {
  const fen = 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1';
  const pos = createPosition(fen);
  const searcher = createSearcher({ ttSizeMb: 4 });
  searcher.searchRoot(pos, { depth: 5, ...LONG });
  assertEqual(getFen(pos), fen, 'la FEN sigue intacta');
  assertEqual(pos.undoStack.length, 0, 'no deja jugadas a medias en la pila');
});

test('searchRoot puntua todas las jugadas legales y las ordena', () => {
  const fen = 'r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 4 4';
  const pos = createPosition(fen);
  const legal = generateMoves(pos);
  const searcher = createSearcher({ ttSizeMb: 8 });
  const result = searcher.searchRoot(pos, { depth: 5, ...LONG });

  assertEqual(result.moves.length, legal.length, 'una entrada por jugada legal');
  const seen = new Set(result.moves.map((m) => m.move));
  assertEqual(seen.size, legal.length, 'sin repetidas');
  for (const move of legal) assert(seen.has(move), 'falta ' + moveToUci(move));
  for (const entry of result.moves) {
    assert(Number.isFinite(entry.score), 'toda jugada tiene puntuacion');
    assert(Math.abs(entry.score) < 31000, 'puntuacion dentro de rango: ' + entry.score);
    assertEqual(entry.pv[0], entry.move, 'la PV de cada jugada empieza por ella misma');
  }
  for (let i = 1; i < result.moves.length; i++) {
    assert(result.moves[i - 1].score >= result.moves[i].score, 'vienen de mejor a peor');
  }
  assertEqual(result.moves[0].move, result.best, 'la primera es la mejor');
});

test('search() devuelve el contrato minimo y searchRoot anade las jugadas', () => {
  const searcher = createSearcher({ ttSizeMb: 4 });
  const plain = searcher.search(createPosition(), { depth: 4, ...LONG });
  for (const key of ['best', 'score', 'mate', 'depth', 'seldepth', 'nodes', 'timeMs', 'pv']) {
    assert(key in plain, 'search() devuelve ' + key);
  }
  assert(!('moves' in plain), 'search() no arrastra la lista de raiz');
  assert(plain.seldepth >= plain.depth, 'la profundidad selectiva llega al menos igual de lejos');
  assert(Array.isArray(plain.pv) && plain.pv.length > 0, 'la PV no viene vacia');
  assertEqual(plain.pv[0], plain.best, 'la PV empieza por la mejor jugada');

  const root = createSearcher({ ttSizeMb: 4 }).searchRoot(createPosition(), { depth: 4, ...LONG });
  assert(Array.isArray(root.moves), 'searchRoot() si la trae');
});

test('la PV es una secuencia legal de jugadas', () => {
  const fen = 'r1bq1rk1/pp2ppbp/2np1np1/8/2BNP3/2N1B3/PPP2PPP/R2QK2R w KQ - 0 9';
  const searcher = createSearcher({ ttSizeMb: 8 });
  const result = searcher.search(createPosition(fen), { depth: 7, nodes: 400000, ...LONG });
  const line = playPv(fen, result.pv);
  assert(line.legal, 'la PV se puede jugar entera: ' + line.sans.join(' '));
  assert(line.sans.length >= 2, 'y tiene mas de una jugada: ' + line.sans.join(' '));
});

test('es determinista: mismos limites, mismo resultado', () => {
  const fen = 'r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 4 4';
  const limits = { depth: 6, nodes: 150000, ...LONG };
  const a = createSearcher({ ttSizeMb: 4 }).searchRoot(createPosition(fen), limits);
  const b = createSearcher({ ttSizeMb: 4 }).searchRoot(createPosition(fen), limits);
  assertEqual(b.best, a.best, 'misma jugada');
  assertEqual(b.score, a.score, 'misma puntuacion');
  assertEqual(b.nodes, a.nodes, 'mismos nodos: dos instancias no comparten estado');
});

test('las instancias no se pisan entre si', () => {
  const fen = 'r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 4 4';
  const limits = { depth: 5, nodes: 120000, ...LONG };
  const solo = createSearcher({ ttSizeMb: 4 }).search(createPosition(fen), limits);

  const a = createSearcher({ ttSizeMb: 4 });
  const b = createSearcher({ ttSizeMb: 4 });
  b.search(createPosition('8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1'), { depth: 6, ...LONG });
  const mixed = a.search(createPosition(fen), limits);
  assertEqual(mixed.best, solo.best, 'otra instancia trabajando no cambia el resultado');
  assertEqual(mixed.nodes, solo.nodes, 'ni el numero de nodos');
});

test('clearTables() deja el buscador como recien creado', () => {
  const fen = 'r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 4 4';
  const limits = { depth: 5, nodes: 120000, ...LONG };
  const fresh = createSearcher({ ttSizeMb: 4 }).search(createPosition(fen), limits);

  const reused = createSearcher({ ttSizeMb: 4 });
  reused.search(createPosition(fen), { depth: 7, ...LONG });
  reused.clearTables();
  const after = reused.search(createPosition(fen), limits);
  assertEqual(after.best, fresh.best, 'misma jugada que en frio');
  assertEqual(after.nodes, fresh.nodes, 'y mismo recorrido');
});

/* ------------------------- perillas de los bots ------------------------- */

test('los bots debiles pueden apagar quietud, null-move y LMR', () => {
  const fen = 'r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 4 4';
  const searcher = createSearcher({ ttSizeMb: 2 });
  const result = searcher.searchRoot(createPosition(fen), {
    depth: 3,
    quiescence: false,
    useNullMove: false,
    useLmr: false,
    ...LONG,
  });
  assertEqual(result.depth, 3, 'llega a la profundidad pedida');
  assert(generateMoves(createPosition(fen)).includes(result.best), 'y su jugada es legal');
  assertEqual(result.moves.length, generateMoves(createPosition(fen)).length, 'sigue puntuando todo');
});

test('evalNoise exige un rng y mueve la evaluacion', () => {
  const searcher = createSearcher({ ttSizeMb: 2 });
  let threw = false;
  try {
    searcher.search(createPosition(), { depth: 2, evalNoise: 40, ...LONG });
  } catch {
    threw = true;
  }
  assert(threw, 'sin rng lanza error');

  const limpio = createSearcher({ ttSizeMb: 2 })
    .searchRoot(createPosition(), { depth: 3, ...LONG });
  let distinta = false;
  for (let seed = 1; seed <= 6 && !distinta; seed++) {
    const ruidosa = createSearcher({ ttSizeMb: 2 }).searchRoot(createPosition(), {
      depth: 3,
      evalNoise: 60,
      rng: () => seed / 7,
      ...LONG,
    });
    assert(generateMoves(createPosition()).includes(ruidosa.best), 'con ruido sigue siendo legal');
    if (ruidosa.best !== limpio.best || ruidosa.score !== limpio.score) distinta = true;
  }
  assert(distinta, 'con bastante ruido alguna semilla cambia la eleccion');
});

test('el mismo rng da siempre la misma partida', () => {
  const limits = () => ({ depth: 4, evalNoise: 50, rng: () => 0.4242, ...LONG });
  const a = createSearcher({ ttSizeMb: 2 }).searchRoot(createPosition(), limits());
  const b = createSearcher({ ttSizeMb: 2 }).searchRoot(createPosition(), limits());
  assertEqual(b.best, a.best, 'misma jugada con la misma semilla');
  assertEqual(b.score, a.score, 'y misma puntuacion');
});

test('ve las tablas por material insuficiente y el desprecio las tuerce', () => {
  /* Blancas van perdidas (torre contra dama) pero pueden liquidar a rey contra
     rey: la busqueda debe elegir esas tablas en vez de quedarse -475. */
  const fen = '3qk3/8/8/8/8/8/8/3RK3 w - - 0 1';
  const neutral = createSearcher({ ttSizeMb: 2 })
    .search(createPosition(fen), { depth: 5, ...LONG });
  assertEqual(moveToUci(neutral.best), 'd1d8', 'liquida en d8');
  assertEqual(neutral.score, 0, 'y firma tablas en vez de perder: ' + neutral.score);

  const despreciativo = createSearcher({ ttSizeMb: 2 }).search(createPosition(fen), {
    depth: 5,
    weights: { ...DEFAULT_WEIGHTS, contempt: 100 },
    ...LONG,
  });
  assertEqual(despreciativo.score, -100, 'con desprecio 100 las tablas valen -100');
});

run('engine.js');
