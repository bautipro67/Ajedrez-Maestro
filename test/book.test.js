/**
 * book.test.js — El libro de aperturas.
 * Lo esencial: TODA linea del libro tiene que ser legal y estar escrita en el
 * SAN canonico, porque si no `bookMove` devolveria jugadas imposibles. Ademas
 * se comprueban la cobertura por estilos, el reparto de primeras jugadas y que
 * `openingName` acierte con el prefijo mas largo.
 */

import { test, assert, assertEqual, run } from './harness.js';
import { BOOK_LINES, OPENING_NAMES, BOOK_STYLES, bookMove, bookOptions, openingName } from '../web/js/book.js';
import {
  createPosition,
  generateMoves,
  makeMove,
  sanToMove,
  moveToSan,
  getFen,
} from '../web/js/chess.js';

/** PRNG determinista para que los tests no dependan de Math.random. */
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

/* ------------------------------ legalidad ------------------------------- */

test('todas las lineas del libro son legales y estan en SAN canonico', () => {
  const fallos = [];
  for (const line of BOOK_LINES) {
    const pos = createPosition();
    for (let i = 0; i < line.sans.length; i++) {
      const san = line.sans[i];
      const move = sanToMove(pos, san);
      if (move === -1) {
        fallos.push(line.name + ': jugada ' + (i + 1) + ' ilegal "' + san + '"');
        break;
      }
      const canonical = moveToSan(pos, move);
      if (canonical !== san) {
        fallos.push(line.name + ': jugada ' + (i + 1) + ' "' + san + '" deberia ser "' + canonical + '"');
        break;
      }
      makeMove(pos, move);
    }
  }
  assertEqual(fallos.length, 0, 'lineas rotas:\n         ' + fallos.slice(0, 10).join('\n         '));
});

test('los prefijos de la tabla de nombres tambien son legales', () => {
  const fallos = [];
  for (const entry of OPENING_NAMES) {
    const pos = createPosition();
    for (let i = 0; i < entry.sans.length; i++) {
      const move = sanToMove(pos, entry.sans[i]);
      if (move === -1) {
        fallos.push(entry.name + ': jugada ' + (i + 1) + ' ilegal "' + entry.sans[i] + '"');
        break;
      }
      makeMove(pos, move);
    }
  }
  assertEqual(fallos.length, 0, 'prefijos rotos:\n         ' + fallos.slice(0, 10).join('\n         '));
});

/* ------------------------------- cobertura ------------------------------- */

test('el libro llega al minimo que pide el contrato', () => {
  assert(BOOK_LINES.length >= 120, 'el contrato pide 120 lineas y hay ' + BOOK_LINES.length);
  assert(OPENING_NAMES.length >= 60, 'el contrato pide unos 60 nombres y hay ' + OPENING_NAMES.length);
});

test('las lineas tienen profundidad de apertura de verdad', () => {
  for (const line of BOOK_LINES) {
    assert(line.sans.length >= 12,
      line.name + ' solo tiene ' + line.sans.length + ' medias jugadas');
  }
});

test('cada estilo tiene material suficiente', () => {
  const cuenta = {};
  for (const style of BOOK_STYLES) cuenta[style] = 0;
  for (const line of BOOK_LINES) {
    assert(line.styles.length > 0, line.name + ' no tiene estilo');
    for (const style of line.styles) {
      assert(style in cuenta, line.name + ' usa un estilo desconocido: ' + style);
      cuenta[style]++;
    }
  }
  for (const style of BOOK_STYLES) {
    assert(cuenta[style] >= 15,
      'el estilo "' + style + '" solo tiene ' + cuenta[style] + ' lineas: los bots se quedarian sin repertorio');
  }
});

test('el libro no es monotematico en la primera jugada', () => {
  const primeras = new Map();
  for (const line of BOOK_LINES) {
    primeras.set(line.sans[0], (primeras.get(line.sans[0]) || 0) + 1);
  }
  assert(primeras.size >= 4, 'solo hay ' + primeras.size + ' primeras jugadas distintas');
  for (const [san, n] of primeras) {
    assert(n <= BOOK_LINES.length * 0.6, 'el ' + Math.round(100 * n / BOOK_LINES.length) +
      '% de las lineas empiezan por ' + san);
  }
});

test('no hay lineas ni nombres duplicados', () => {
  const vistas = new Set();
  for (const line of BOOK_LINES) {
    const key = line.sans.join(' ');
    assert(!vistas.has(key), 'linea duplicada: ' + line.name);
    vistas.add(key);
  }
  const nombres = new Set();
  for (const line of BOOK_LINES) {
    assert(!nombres.has(line.name), 'nombre duplicado: ' + line.name);
    nombres.add(line.name);
  }
  const prefijos = new Set();
  for (const entry of OPENING_NAMES) {
    const key = entry.sans.join(' ');
    assert(!prefijos.has(key), 'prefijo duplicado en la tabla de nombres: ' + entry.name);
    prefijos.add(key);
  }
});

/* ------------------------------- bookMove -------------------------------- */

test('bookMove siempre devuelve una jugada legal o -1', () => {
  const rng = makeRng(12345);
  for (const style of BOOK_STYLES) {
    const pos = createPosition();
    for (let ply = 0; ply < 20; ply++) {
      const move = bookMove(pos, style, rng);
      if (move === -1) break;
      const legal = generateMoves(pos);
      assert(legal.includes(move),
        'bookMove devolvio una jugada ilegal en ' + getFen(pos) + ' con estilo ' + style);
      makeMove(pos, move);
    }
  }
});

test('el estilo "none" deja al bot sin libro', () => {
  const rng = makeRng(1);
  assertEqual(bookMove(createPosition(), 'none', rng), -1, 'none no juega de libro');
  assertEqual(bookMove(createPosition(), null, rng), -1, 'sin estilo tampoco');
});

test('bookMove respeta el estilo pedido', () => {
  const rng = makeRng(999);
  const pos = createPosition();
  for (const style of BOOK_STYLES) {
    const move = bookMove(pos, style, rng);
    if (move === -1) continue;
    const san = moveToSan(pos, move);
    const apoyan = BOOK_LINES.filter((l) => l.sans[0] === san && l.styles.includes(style));
    assert(apoyan.length > 0,
      'con estilo ' + style + ' jugo ' + san + ', que ninguna linea de ese estilo avala');
  }
});

test('el mismo rng da siempre la misma jugada de libro', () => {
  const a = bookMove(createPosition(), 'wide', makeRng(42));
  const b = bookMove(createPosition(), 'wide', makeRng(42));
  assertEqual(b, a, 'misma semilla, misma jugada');
});

test('con semillas distintas el libro ofrece variedad', () => {
  const vistas = new Set();
  for (let seed = 1; seed <= 40; seed++) {
    vistas.add(bookMove(createPosition(), 'wide', makeRng(seed)));
  }
  assert(vistas.size >= 2, 'el libro siempre juega lo mismo en la salida');
});

test('fuera del libro devuelve -1', () => {
  const pos = createPosition();
  /* Una salida que ningun libro recomienda. */
  for (const san of ['a3', 'a6', 'h3', 'h6', 'Ra2', 'Ra7']) {
    const move = sanToMove(pos, san);
    assert(move !== -1, 'la posicion de prueba deberia permitir ' + san);
    makeMove(pos, move);
  }
  assertEqual(bookMove(pos, 'wide', makeRng(3)), -1, 'esta posicion no puede estar en el libro');
});

test('el libro entiende las transposiciones', () => {
  /* La Nimzoindia por sus dos ordenes de jugadas habituales. Ojo: las FEN
     completas NO coinciden, porque el contador de la regla de 50 jugadas va
     distinto; lo que coincide es la posicion en si, que es lo que indexa el
     libro (la clave Zobrist no incluye ese contador). */
  const porD4 = createPosition();
  const porC4 = createPosition();
  for (const san of ['d4', 'Nf6', 'c4', 'e6', 'Nc3', 'Bb4']) {
    const move = sanToMove(porD4, san);
    assert(move !== -1, 'la via 1.d4 deberia permitir ' + san);
    makeMove(porD4, move);
  }
  for (const san of ['c4', 'e6', 'Nc3', 'Nf6', 'd4', 'Bb4']) {
    const move = sanToMove(porC4, san);
    assert(move !== -1, 'la via 1.c4 deberia permitir ' + san);
    makeMove(porC4, move);
  }

  const campos = (pos) => getFen(pos).split(' ').slice(0, 4).join(' ');
  assertEqual(campos(porC4), campos(porD4), 'las dos vias llegan a la misma posicion');
  assertEqual(porC4.keyLo, porD4.keyLo, 'misma clave Zobrist (parte baja)');
  assertEqual(porC4.keyHi, porD4.keyHi, 'misma clave Zobrist (parte alta)');

  const opciones = bookOptions(porD4, null);
  assert(opciones > 0, 'el libro deberia conocer la Nimzoindia');
  assertEqual(bookOptions(porC4, null), opciones,
    'y reconocerla igual llegando por el otro orden de jugadas');
});

/* ------------------------------ openingName ------------------------------ */

test('openingName encuentra el nombre mas especifico', () => {
  for (const line of BOOK_LINES.slice(0, 40)) {
    const hit = openingName(line.sans);
    assert(hit !== null, 'sin nombre para ' + line.name);
    assert(typeof hit.name === 'string' && hit.name.length > 2, 'nombre vacio en ' + line.name);
    assert(/^[A-E]\d{2}$/.test(hit.eco), 'eco raro (' + hit.eco + ') en ' + line.name);
  }
});

test('openingName prefiere el prefijo mas largo', () => {
  const corto = openingName(['e4']);
  const largo = openingName(['e4', 'c5', 'Nf3', 'd6', 'd4', 'cxd4', 'Nxd4', 'Nf6', 'Nc3', 'a6']);
  assert(corto !== null, 'una sola jugada ya deberia tener nombre');
  assert(largo !== null, 'la Najdorf deberia tener nombre');
  assert(largo.name !== corto.name, 'con mas jugadas el nombre tiene que afinar mas');
});

test('openingName devuelve null cuando no reconoce nada', () => {
  assertEqual(openingName([]), null, 'sin jugadas no hay apertura');
  assertEqual(openingName(null), null, 'entrada invalida');
  /* Ojo al elegir el ejemplo: hasta 1.a3 (Anderssen) y 1.g4 (Grob) tienen
     nombre. Estas idas y vueltas de caballo no las llama nadie de ninguna manera. */
  assertEqual(openingName(['Na3', 'Nh6', 'Nb1', 'Ng8']), null, 'esto no es ninguna apertura');
});

test('hasta las aperturas raras tienen nombre', () => {
  for (const san of ['a3', 'b4', 'g4', 'f4', 'b3']) {
    const hit = openingName([san]);
    assert(hit !== null, '1.' + san + ' deberia tener nombre');
  }
});

test('openingName tolera partidas que se salen del libro', () => {
  const largo = ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6', 'Ba4', 'Nf6', 'O-O', 'Be7'];
  const hit = openingName([...largo, 'Qe1', 'Qd7', 'Qd1', 'Qe6']);
  assert(hit !== null, 'aunque las ultimas jugadas sean raras, la apertura ya tenia nombre');
});

run('book.js');
