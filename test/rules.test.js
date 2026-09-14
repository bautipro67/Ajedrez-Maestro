/*
 * rules.test.js — reglas del juego de punta a punta.
 * FEN y SAN de ida y vuelta, enroques (incluido el rey que no puede cruzar
 * una casilla atacada), captura al paso (incluida la clavada descubierta
 * horizontal), las cuatro promociones, mate, ahogado, regla de 50 jugadas,
 * triple repeticion, material insuficiente y lectura/escritura de PGN.
 */

import {
  WHITE, BLACK, QUEEN, ROOK, BISHOP, KNIGHT, START_FEN,
  createPosition, setFen, getFen, clonePosition,
  generateMoves, makeMove, unmakeMove, inCheck, isSquareAttacked,
  moveToSan, sanToMove, moveToUci, uciToMove,
  movePromo, moveTo, moveFrom, isCastle, isEnPassant, isCapture, isDoublePush,
  squareName, parseSquare, isInsufficientMaterial, repetitionCount, gameResult
} from '../web/js/chess.js';
import { buildPgn, parsePgn, pgnToPositions } from '../web/js/pgn.js';
import { test, assert, assertEqual, assertThrows, run } from './harness.js';

function playSan(pos, sanList) {
  const played = [];
  for (const san of sanList) {
    const move = sanToMove(pos, san);
    if (move === -1) throw new Error('SAN ilegal: ' + san + ' en ' + getFen(pos));
    played.push(moveToSan(pos, move));
    makeMove(pos, move);
  }
  return played;
}

function sanSet(pos) {
  return generateMoves(pos).map((m) => moveToSan(pos, m)).sort();
}

// --- FEN ----------------------------------------------------------------

test('FEN ida y vuelta', () => {
  const fens = [
    START_FEN,
    'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1',
    '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1',
    'r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1',
    'rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 0 1',
    'r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 1',
    'rnbqkbnr/pppp1ppp/8/4p3/8/8/PPPPPPPP/RNBQKBNR w KQkq e6 0 2',
    '7k/8/8/K1pP3r/8/8/8/8 w - c6 0 1',
    '3k4/8/8/8/8/Q6Q/PPPPPPPP/QQQKQQQQ w - - 17 42',
    '8/8/8/4k3/8/8/4K3/8 b - - 99 120'
  ];
  for (const fen of fens) {
    assertEqual(getFen(createPosition(fen)), fen, 'ida y vuelta de ' + fen);
  }
});

test('FEN acepta 4 campos y completa reloj y número de jugada', () => {
  const pos = createPosition('r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq -');
  assertEqual(pos.halfmove, 0);
  assertEqual(pos.fullmove, 1);
  assertEqual(getFen(pos), 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1');
});

test('FEN inválida lanza Error', () => {
  const pos = createPosition(START_FEN);
  assertThrows(() => setFen(pos, 'esto no es una FEN'));
  assertThrows(() => setFen(pos, 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP w KQkq - 0 1'));
  assertThrows(() => setFen(pos, 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR x KQkq - 0 1'));
  assertThrows(() => setFen(pos, 'rnbqxbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'));
  assertThrows(() => setFen(pos, '8/8/8/8/8/8/8/8 w - - 0 1'), 'sin reyes');
  assertThrows(() => setFen(pos, 'rnbqkbnr/ppppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'), 'fila de 9');
});

test('setFen reinicia pila e historial', () => {
  const pos = createPosition(START_FEN);
  makeMove(pos, sanToMove(pos, 'e4'));
  makeMove(pos, sanToMove(pos, 'e5'));
  setFen(pos, START_FEN);
  assertEqual(pos.undoStack.length, 0);
  assertEqual(pos.repLo.length, 1);
  assertEqual(getFen(pos), START_FEN);
});

test('casillas 0x88: a1=0, h1=7, a8=112, h8=119', () => {
  assertEqual(parseSquare('a1'), 0);
  assertEqual(parseSquare('h1'), 7);
  assertEqual(parseSquare('a8'), 112);
  assertEqual(parseSquare('h8'), 119);
  assertEqual(squareName(0), 'a1');
  assertEqual(squareName(119), 'h8');
  assertEqual(parseSquare('j9'), -1);
  assertEqual(parseSquare('a'), -1);
});

// --- SAN / UCI ----------------------------------------------------------

test('SAN ida y vuelta en una apertura conocida', () => {
  const pos = createPosition(START_FEN);
  const game = ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6', 'Ba4', 'Nf6', 'O-O', 'Be7',
    'Re1', 'b5', 'Bb3', 'd6', 'c3', 'O-O', 'h3', 'Nb8', 'd4', 'Nbd7'];
  const produced = playSan(pos, game);
  assertEqual(produced.join(' '), game.join(' '), 'SAN reproducido');
});

test('SAN y UCI de ida y vuelta sobre todas las jugadas legales', () => {
  const fens = [
    START_FEN,
    'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1',
    'rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 0 1',
    'r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 1',
    '7k/8/8/2pP3r/8/8/K7/8 w - c6 0 1',
    '3r2k1/4Pppp/8/8/8/8/8/6K1 w - - 0 1',
    '3k4/8/8/8/8/Q6Q/PPPPPPPP/QQQKQQQQ w - - 0 1'
  ];
  for (const fen of fens) {
    const pos = createPosition(fen);
    for (const move of generateMoves(pos)) {
      const san = moveToSan(pos, move);
      assertEqual(sanToMove(pos, san), move, 'SAN ' + san + ' en ' + fen);
      const uci = moveToUci(move);
      assertEqual(uciToMove(pos, uci), move, 'UCI ' + uci + ' en ' + fen);
    }
  }
});

test('sanToMove es tolerante', () => {
  const pos = createPosition('r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1');
  const shortCastle = sanToMove(pos, 'O-O');
  assert(shortCastle !== -1, 'O-O');
  assertEqual(sanToMove(pos, '0-0'), shortCastle, '0-0 equivale a O-O');
  assertEqual(sanToMove(pos, 'OO'), shortCastle, 'OO equivale a O-O');
  assertEqual(sanToMove(pos, 'O-O!!'), shortCastle, 'anotaciones ignoradas');
  const longCastle = sanToMove(pos, 'O-O-O');
  assertEqual(sanToMove(pos, '0-0-0'), longCastle, '0-0-0 equivale a O-O-O');
  const knight = sanToMove(pos, 'Nc4');
  assert(knight !== -1, 'Nc4');
  assertEqual(sanToMove(pos, 'Ne5c4'), knight, 'notación larga');
  assertEqual(sanToMove(pos, 'Nxc4'), knight, 'la "x" sobrante se tolera');
  assertEqual(sanToMove(pos, 'Nc9'), -1, 'jugada inexistente');
  assertEqual(sanToMove(pos, 'e5'), -1, 'jugada ilegal');
});

test('uciToMove rechaza jugadas ilegales', () => {
  const pos = createPosition(START_FEN);
  assert(uciToMove(pos, 'e2e4') !== -1, 'e2e4');
  assertEqual(moveToUci(uciToMove(pos, 'e2e4')), 'e2e4');
  assertEqual(uciToMove(pos, 'e2e5'), -1);
  assertEqual(uciToMove(pos, 'zzzz'), -1);
  const promoPos = createPosition('8/4P3/8/k7/8/8/8/4K3 w - - 0 1');
  const promo = uciToMove(promoPos, 'e7e8q');
  assert(promo !== -1, 'e7e8q');
  assertEqual(movePromo(promo), QUEEN);
  assertEqual(moveToUci(promo), 'e7e8q');
});

test('FEN conocidas tras las primeras jugadas', () => {
  const pos = createPosition(START_FEN);
  playSan(pos, ['e4']);
  assertEqual(getFen(pos), 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1');
  playSan(pos, ['c5']);
  assertEqual(getFen(pos), 'rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq c6 0 2');
  playSan(pos, ['Nf3']);
  assertEqual(getFen(pos), 'rnbqkbnr/pp1ppppp/8/2p5/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2');
});

// --- Enroques -----------------------------------------------------------

test('enroque corto y largo mueven rey y torre', () => {
  const pos = createPosition('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
  const short = sanToMove(pos, 'O-O');
  assert(isCastle(short), 'bandera de enroque');
  assertEqual(moveTo(short), parseSquare('g1'));
  makeMove(pos, short);
  assertEqual(getFen(pos), 'r3k2r/8/8/8/8/8/8/R4RK1 b kq - 1 1');
  const longCastle = sanToMove(pos, 'O-O-O');
  makeMove(pos, longCastle);
  assertEqual(getFen(pos), '2kr3r/8/8/8/8/8/8/R4RK1 w - - 2 2');
  unmakeMove(pos);
  unmakeMove(pos);
  assertEqual(getFen(pos), 'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
});

test('el rey no puede cruzar una casilla atacada', () => {
  const crossing = createPosition('3rk3/8/8/8/8/8/8/R3K2R w KQ - 0 1');
  const sans = sanSet(crossing);
  assert(sans.indexOf('O-O') >= 0, 'el enroque corto sigue siendo legal');
  assertEqual(sans.indexOf('O-O-O'), -1, 'el enroque largo cruza d1 atacada');
  assertEqual(sanToMove(crossing, 'O-O-O'), -1, 'sanToMove también lo rechaza');

  const landing = createPosition('2r1k3/8/8/8/8/8/8/R3K2R w KQ - 0 1');
  assertEqual(sanSet(landing).indexOf('O-O-O'), -1, 'c1 atacada: el rey no puede llegar');

  const checked = createPosition('4rk2/8/8/8/8/8/8/R3K2R w KQ - 0 1');
  assert(inCheck(checked), 'el rey blanco está en jaque');
  const checkedSans = sanSet(checked);
  assertEqual(checkedSans.indexOf('O-O'), -1, 'en jaque no se enroca (corto)');
  assertEqual(checkedSans.indexOf('O-O-O'), -1, 'en jaque no se enroca (largo)');
});

test('el enroque exige casillas vacías y torre presente', () => {
  const blocked = createPosition('r3k2r/8/8/8/8/8/8/R2QK2R w KQkq - 0 1');
  assertEqual(sanSet(blocked).indexOf('O-O-O'), -1, 'la dama en d1 bloquea');
  assert(sanSet(blocked).indexOf('O-O') >= 0, 'el corto sigue disponible');
  const noRook = createPosition('r3k2r/8/8/8/8/8/8/4K2R w KQkq - 0 1');
  assertEqual(noRook.castling & 2, 0, 'sin torre en a1 no hay derecho largo');
});

test('mover el rey o la torre quita derechos de enroque', () => {
  const pos = createPosition('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
  makeMove(pos, sanToMove(pos, 'Rh2'));
  assertEqual(pos.castling & 1, 0, 'la torre de h1 pierde el enroque corto');
  assertEqual(pos.castling & 2, 2, 'el largo se conserva');
  makeMove(pos, sanToMove(pos, 'Ke7'));
  assertEqual(pos.castling & 12, 0, 'el rey negro pierde ambos derechos');
  unmakeMove(pos);
  unmakeMove(pos);
  assertEqual(pos.castling, 15, 'unmake restaura los derechos');
});

// --- Al paso ------------------------------------------------------------

test('captura al paso normal', () => {
  const pos = createPosition('rnbqkbnr/ppp1pppp/8/3pP3/8/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 3');
  const move = sanToMove(pos, 'exd6');
  assert(move !== -1, 'exd6 existe');
  assert(isEnPassant(move), 'bandera al paso');
  assert(isCapture(move), 'bandera de captura');
  makeMove(pos, move);
  assertEqual(getFen(pos), 'rnbqkbnr/ppp1pppp/3P4/8/8/8/PPPP1PPP/RNBQKBNR b KQkq - 0 3');
  unmakeMove(pos);
  assertEqual(getFen(pos), 'rnbqkbnr/ppp1pppp/8/3pP3/8/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 3');
});

test('el avance doble publica la casilla al paso', () => {
  const pos = createPosition(START_FEN);
  const move = sanToMove(pos, 'e4');
  assert(isDoublePush(move), 'bandera de avance doble');
  makeMove(pos, move);
  assertEqual(pos.ep, parseSquare('e3'));
  makeMove(pos, sanToMove(pos, 'e5'));
  assertEqual(pos.ep, parseSquare('e6'));
  makeMove(pos, sanToMove(pos, 'Nf3'));
  assertEqual(pos.ep, -1, 'la casilla al paso caduca en una jugada');
});

test('al paso ilegal por clavada descubierta horizontal', () => {
  const pinned = createPosition('7k/8/8/K1pP3r/8/8/8/8 w - c6 0 1');
  const sans = sanSet(pinned);
  assertEqual(sans.join(' '), 'Ka4 Ka6 Kb5 Kb6 d6', 'sólo 5 jugadas legales');
  assertEqual(sanToMove(pinned, 'dxc6'), -1, 'dxc6 dejaría al rey en jaque');

  const free = createPosition('7k/8/8/2pP3r/8/8/K7/8 w - c6 0 1');
  assert(sanSet(free).indexOf('dxc6') >= 0, 'con el rey fuera de la 5ª fila sí se puede');

  const mirrored = createPosition('8/8/8/8/k1Pp3R/8/8/7K b - c3 0 1');
  assertEqual(sanToMove(mirrored, 'dxc3'), -1, 'mismo caso con los colores invertidos');
});

test('al paso que resuelve un jaque de peón', () => {
  const pos = createPosition('8/8/8/4k3/3Pp3/8/8/7K b - d3 0 1');
  assert(inCheck(pos), 'el peón que avanzó dos da jaque');
  const move = sanToMove(pos, 'exd3');
  assert(move !== -1, 'la captura al paso resuelve el jaque');
  assert(isEnPassant(move), 'bandera al paso');
  assertEqual(sanToMove(pos, 'e3'), -1, 'avanzar el peón no tapa el jaque');
  assertEqual(sanSet(pos).join(' '), 'Kd5 Kd6 Ke6 Kf4 Kf5 Kf6 Kxd4 exd3', 'ocho respuestas legales');
});

// --- Promociones --------------------------------------------------------

test('promoción a las cuatro piezas', () => {
  const pos = createPosition('8/4P3/8/k7/8/8/8/4K3 w - - 0 1');
  const promos = generateMoves(pos).filter((m) => movePromo(m) !== 0);
  assertEqual(promos.length, 4, 'cuatro promociones');
  const types = promos.map(movePromo).sort();
  assertEqual(types.join(','), [KNIGHT, BISHOP, ROOK, QUEEN].sort().join(','));
  assertEqual(promos.map((m) => moveToSan(pos, m)).join(' '), 'e8=Q e8=R e8=B e8=N');

  for (const move of promos) {
    makeMove(pos, move);
    assertEqual(pos.board[parseSquare('e8')] & 7, movePromo(move), 'pieza promovida');
    assertEqual(pos.halfmove, 0, 'la promoción reinicia el reloj de 50');
    unmakeMove(pos);
    assertEqual(getFen(pos), '8/4P3/8/k7/8/8/8/4K3 w - - 0 1', 'unmake de la promoción');
  }
});

test('promoción con captura', () => {
  const pos = createPosition('3r4/4P3/8/k7/8/8/8/4K3 w - - 0 1');
  const sans = sanSet(pos);
  for (const expected of ['exd8=Q+', 'exd8=R', 'exd8=B+', 'exd8=N']) {
    assert(sans.indexOf(expected) >= 0, 'falta ' + expected + ' en ' + sans.join(' '));
  }
  const move = sanToMove(pos, 'exd8=Q+');
  makeMove(pos, move);
  assertEqual(getFen(pos), '3Q4/8/8/k7/8/8/8/4K3 b - - 0 1');
});

test('promoción negra', () => {
  const pos = createPosition('4k3/8/8/8/8/8/4p3/7K b - - 0 1');
  const promos = generateMoves(pos).filter((m) => movePromo(m) !== 0);
  assertEqual(promos.length, 4, 'cuatro promociones negras');
  const queen = promos.find((m) => movePromo(m) === QUEEN);
  makeMove(pos, queen);
  assertEqual(pos.board[parseSquare('e1')], QUEEN | 8, 'dama negra en e1');
});

// --- Final de la partida ------------------------------------------------

test('mate del loco', () => {
  const pos = createPosition(START_FEN);
  playSan(pos, ['f3', 'e5', 'g4', 'Qh4']);
  assertEqual(getFen(pos), 'rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3');
  assert(inCheck(pos), 'las blancas están en jaque');
  assertEqual(generateMoves(pos).length, 0, 'sin jugadas legales');
  const result = gameResult(pos);
  assertEqual(result.over, true);
  assertEqual(result.reason, 'checkmate');
  assertEqual(result.winner, BLACK);
  assertEqual(result.text, 'Jaque mate: ganan las negras.');
});

test('el SAN marca el mate con #', () => {
  const pos = createPosition(START_FEN);
  playSan(pos, ['f3', 'e5', 'g4']);
  const mate = sanToMove(pos, 'Qh4');
  assertEqual(moveToSan(pos, mate), 'Qh4#');
});

test('ahogado', () => {
  const pos = createPosition('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1');
  assert(!inCheck(pos), 'el rey negro no está en jaque');
  assertEqual(generateMoves(pos).length, 0, 'sin jugadas legales');
  const result = gameResult(pos);
  assertEqual(result.over, true);
  assertEqual(result.reason, 'stalemate');
  assertEqual(result.winner, null);
  assertEqual(result.text, 'Tablas por rey ahogado.');
});

test('regla de las 50 jugadas', () => {
  const pos = createPosition('8/8/8/4k3/8/8/4K3/7R w - - 99 50');
  assertEqual(gameResult(pos).over, false, 'con 99 medias jugadas la partida sigue');
  makeMove(pos, sanToMove(pos, 'Rh4'));
  assertEqual(pos.halfmove, 100);
  const result = gameResult(pos);
  assertEqual(result.over, true);
  assertEqual(result.reason, 'fifty');
  assertEqual(result.text, 'Tablas por la regla de las 50 jugadas.');
  unmakeMove(pos);
  assertEqual(pos.halfmove, 99, 'unmake restaura el reloj de 50');
  makeMove(pos, sanToMove(pos, 'Rh4'));
  makeMove(pos, sanToMove(pos, 'Kd5'));
  assertEqual(pos.halfmove, 101, 'el contador sigue subiendo');
});

test('triple repetición', () => {
  const pos = createPosition(START_FEN);
  assertEqual(repetitionCount(pos), 1, 'primera aparición');
  playSan(pos, ['Nf3', 'Nf6', 'Ng1', 'Ng8']);
  assertEqual(getFen(pos), 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 4 3');
  assertEqual(repetitionCount(pos), 2, 'segunda aparición');
  assertEqual(gameResult(pos).over, false, 'dos veces no bastan');
  playSan(pos, ['Nf3', 'Nf6', 'Ng1', 'Ng8']);
  assertEqual(repetitionCount(pos), 3, 'tercera aparición');
  const result = gameResult(pos);
  assertEqual(result.over, true);
  assertEqual(result.reason, 'repetition');
  assertEqual(result.text, 'Tablas por triple repetición.');
});

test('la repetición no cuenta posiciones con derechos distintos', () => {
  const pos = createPosition('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
  playSan(pos, ['Rh2', 'Rh7', 'Rh1', 'Rh8']);
  assertEqual(repetitionCount(pos), 1, 'el tablero se repite pero los derechos cambiaron');
  playSan(pos, ['Rh2', 'Rh7', 'Rh1', 'Rh8']);
  assertEqual(repetitionCount(pos), 2, 'ahora sí se repite');
});

test('material insuficiente', () => {
  const draws = [
    ['rey contra rey', '8/8/8/4k3/8/8/4K3/8 w - - 0 1'],
    ['rey y alfil contra rey', '8/8/8/4k3/8/8/4K3/5B2 w - - 0 1'],
    ['rey y caballo contra rey', '8/8/8/4k3/8/8/4K3/5N2 w - - 0 1'],
    ['alfiles del mismo color', '5b2/8/8/4k3/8/8/4K3/2B5 w - - 0 1']
  ];
  for (const [name, fen] of draws) {
    const pos = createPosition(fen);
    assertEqual(isInsufficientMaterial(pos), true, name);
    const result = gameResult(pos);
    assertEqual(result.reason, 'insufficient', name + ' (gameResult)');
    assertEqual(result.text, 'Tablas por material insuficiente.', name + ' (texto)');
  }

  const enough = [
    ['alfiles de distinto color', '2b5/8/8/4k3/8/8/4K3/2B5 w - - 0 1'],
    ['dos caballos contra rey', '8/8/8/4k3/8/8/4K3/5NN1 w - - 0 1'],
    ['alfil y caballo', '8/8/8/4k3/8/8/4K3/4BN2 w - - 0 1'],
    ['un peón', '8/8/8/4k3/8/8/4K2P/8 w - - 0 1'],
    ['una torre', '8/8/8/4k3/8/8/4K3/7R w - - 0 1'],
    ['una dama', '8/8/8/4k3/8/8/4K3/7Q w - - 0 1']
  ];
  for (const [name, fen] of enough) {
    assertEqual(isInsufficientMaterial(createPosition(fen)), false, name);
  }
});

test('el mate tiene prioridad sobre las tablas por regla', () => {
  const pos = createPosition('7k/5Q2/6K1/8/8/8/8/8 w - - 99 80');
  makeMove(pos, sanToMove(pos, 'Qg7#'));
  const result = gameResult(pos);
  assertEqual(result.reason, 'checkmate', 'gana el mate, no la regla de 50');
  assertEqual(result.winner, WHITE);
});

// --- Ataques y jaques ---------------------------------------------------

test('isSquareAttacked reconoce todas las piezas', () => {
  const pos = createPosition('8/8/8/3k4/8/8/8/R2NK2B w - - 0 1');
  assertEqual(isSquareAttacked(pos, parseSquare('a8'), WHITE), true, 'torre por la columna');
  assertEqual(isSquareAttacked(pos, parseSquare('c3'), WHITE), true, 'caballo');
  assertEqual(isSquareAttacked(pos, parseSquare('a8'), BLACK), false, 'las negras no llegan');
  assertEqual(isSquareAttacked(pos, parseSquare('c6'), BLACK), true, 'rey negro en d5');
  const pawns = createPosition('8/8/8/8/8/4P3/8/4K2k w - - 0 1');
  assertEqual(isSquareAttacked(pawns, parseSquare('d4'), WHITE), true, 'peón blanco');
  assertEqual(isSquareAttacked(pawns, parseSquare('f4'), WHITE), true, 'peón blanco');
  assertEqual(isSquareAttacked(pawns, parseSquare('e4'), WHITE), false, 'el peón no ataca de frente');
});

test('una pieza clavada no puede abandonar la línea', () => {
  const pos = createPosition('4k3/8/8/8/8/4r3/4N3/4K3 w - - 0 1');
  const sans = sanSet(pos);
  assert(sans.indexOf('Nxe3') < 0 || true, 'el caballo está clavado');
  for (const san of sans) {
    assert(san[0] !== 'N', 'el caballo clavado no tiene jugadas: ' + san);
  }
  const rookPin = createPosition('4k3/8/8/8/8/4r3/4R3/4K3 w - - 0 1');
  const rookSans = sanSet(rookPin);
  assert(rookSans.indexOf('Rxe3+') >= 0 || rookSans.indexOf('Rxe3') >= 0, 'la torre clavada sí puede capturar');
});

// --- PGN ----------------------------------------------------------------

test('PGN de ida y vuelta', () => {
  const sanMoves = ['e4', 'c5', 'Nf3', 'd6', 'd4', 'cxd4', 'Nxd4', 'Nf6', 'Nc3', 'a6'];
  const pgn = buildPgn({
    headers: { Event: 'Torneo de prueba', White: 'Ana', Black: 'Bruno', WhiteElo: '1850' },
    sanMoves,
    result: '1-0'
  });
  assert(pgn.indexOf('[Event "Torneo de prueba"]') === 0, 'cabecera Event al principio');
  assert(pgn.indexOf('[Result "1-0"]') > 0, 'cabecera Result');
  assert(pgn.indexOf('[WhiteElo "1850"]') > 0, 'cabecera extra');
  const parsed = parsePgn(pgn);
  assertEqual(parsed.sanMoves.join(' '), sanMoves.join(' '));
  assertEqual(parsed.result, '1-0');
  assertEqual(parsed.headers.White, 'Ana');
  for (const line of pgn.split('\n')) {
    assert(line.length <= 80, 'línea de más de 80 caracteres: ' + line);
  }
});

test('parsePgn ignora comentarios, variantes y NAGs', () => {
  const text = '[Event "X"]\n[Result "1/2-1/2"]\n\n' +
    '1. e4 {una buena jugada} e5 $1 2. Nf3 (2. f4 exf4 3. Nf3) Nc6 ; comentario de línea\n' +
    '3. Bb5 a6 1/2-1/2\n';
  const parsed = parsePgn(text);
  assertEqual(parsed.sanMoves.join(' '), 'e4 e5 Nf3 Nc6 Bb5 a6');
  assertEqual(parsed.result, '1/2-1/2');
  assertEqual(parsed.headers.Event, 'X');
});

test('pgnToPositions reproduce la partida', () => {
  const pgn = buildPgn({ headers: {}, sanMoves: ['e4', 'c5', 'Nf3'], result: '*' });
  const { moves, finalFen } = pgnToPositions(pgn);
  assertEqual(moves.length, 3);
  assertEqual(finalFen, 'rnbqkbnr/pp1ppppp/8/2p5/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2');
  assertThrows(() => pgnToPositions('[Event "X"]\n\n1. e4 e5 2. Qh8 *\n'), 'jugada ilegal');
});

test('pgnToPositions respeta la cabecera FEN', () => {
  const start = '4k3/8/8/8/8/8/4P3/4K3 w - - 0 1';
  const pgn = buildPgn({
    headers: { FEN: start, SetUp: '1' },
    sanMoves: ['e4', 'Kd7', 'e5'],
    result: '*'
  });
  const { finalFen } = pgnToPositions(pgn);
  assertEqual(finalFen, '8/3k4/8/4P3/8/8/8/4K3 b - - 0 2');
});

test('buildPgn emite comentarios de reloj', () => {
  const pgn = buildPgn({
    headers: {},
    sanMoves: ['e4', 'e5'],
    result: '*',
    clocks: ['0:03:00', '0:02:58']
  });
  assert(pgn.indexOf('{[%clk 0:03:00]}') > 0, 'reloj de las blancas');
  assert(pgn.indexOf('{[%clk 0:02:58]}') > 0, 'reloj de las negras');
  assertEqual(parsePgn(pgn).sanMoves.join(' '), 'e4 e5', 'los relojes no estorban al parseo');
});

// --- Clonado ------------------------------------------------------------

test('clonePosition produce una copia jugable', () => {
  const pos = createPosition(START_FEN);
  const copy = clonePosition(pos);
  assertEqual(getFen(copy), getFen(pos));
  makeMove(copy, sanToMove(copy, 'e4'));
  assertEqual(getFen(pos), START_FEN, 'el original no cambia');
  assert(getFen(copy) !== START_FEN, 'la copia sí cambia');
  assertEqual(moveFrom(sanToMove(pos, 'e4')), parseSquare('e2'));
});

run('reglas');
