/*
 * edge.test.js — adversarial corner cases for the rules core.
 * Castling rights and attacked squares, the horizontal double pin that
 * forbids an en passant capture, SAN disambiguation and check/mate suffixes,
 * clock bookkeeping, a nine queen position, repetition counting, Zobrist
 * coverage and exact make/unmake symmetry, plus two extra perft positions.
 */

import {
  WHITE, BLACK, EMPTY, PAWN, KNIGHT, BISHOP, ROOK, QUEEN, KING, START_FEN,
  createPosition, setFen, getFen, clonePosition,
  generateMoves, makeMove, unmakeMove, makeNullMove, unmakeNullMove,
  inCheck, moveToSan, sanToMove, moveToUci, uciToMove, perft,
  pieceType, pieceColor, parseSquare, squareName, repetitionCount, gameResult
} from '../web/js/chess.js';
import { test, assert, assertEqual, run } from './harness.js';

function sanSet(pos) {
  return generateMoves(pos).map((m) => moveToSan(pos, m)).sort();
}

function snapshot(pos) {
  return {
    board: Array.from(pos.board).join(','),
    turn: pos.turn,
    castling: pos.castling,
    ep: pos.ep,
    halfmove: pos.halfmove,
    fullmove: pos.fullmove,
    kingSq: pos.kingSq[0] + ',' + pos.kingSq[1],
    keyLo: pos.keyLo,
    keyHi: pos.keyHi,
    undo: pos.undoStack.length,
    rep: pos.repLo.length
  };
}

function assertSameState(actual, expected, label) {
  for (const field of Object.keys(expected)) {
    assertEqual(actual[field], expected[field], label + ' -> ' + field);
  }
}

// --- Castling ------------------------------------------------------------

test('se puede enrocar con la torre atacada, no cruzando una casilla atacada', () => {
  // Ra8 attacks the a1 rook straight down the empty a file.
  const rookAttacked = createPosition('r3k3/8/8/8/8/8/8/R3K2R w KQ - 0 1');
  assert(sanSet(rookAttacked).indexOf('O-O-O') >= 0, 'la torre atacada no impide el enroque');
  const longCastle = sanToMove(rookAttacked, 'O-O-O');
  makeMove(rookAttacked, longCastle);
  assertEqual(getFen(rookAttacked), 'r3k3/8/8/8/8/8/8/2KR3R b - - 1 1');

  // Rb8 attacks b1, the square the rook (not the king) travels through.
  const rookPathAttacked = createPosition('1r2k3/8/8/8/8/8/8/R3K2R w KQ - 0 1');
  assert(sanSet(rookPathAttacked).indexOf('O-O-O') >= 0, 'b1 atacada no impide el enroque largo');

  // Rd8 attacks d1, which the king must cross.
  const kingPathAttacked = createPosition('3rk3/8/8/8/8/8/8/R3K2R w KQ - 0 1');
  assertEqual(sanSet(kingPathAttacked).indexOf('O-O-O'), -1, 'el rey no cruza d1 atacada');
  assert(sanSet(kingPathAttacked).indexOf('O-O') >= 0, 'el otro lado sigue disponible');

  // Rc8 attacks c1, the square the king lands on.
  const landingAttacked = createPosition('2r1k3/8/8/8/8/8/8/R3K2R w KQ - 0 1');
  assertEqual(sanSet(landingAttacked).indexOf('O-O-O'), -1, 'el rey no cae en c1 atacada');
});

test('capturar la torre en su casilla original quita el derecho de enroque', () => {
  const kingSide = createPosition('4k3/1b6/8/8/8/8/8/R3K2R b KQ - 0 1');
  makeMove(kingSide, sanToMove(kingSide, 'Bxh1'));
  assertEqual(kingSide.castling & 1, 0, 'se pierde el enroque corto blanco');
  assertEqual(kingSide.castling & 2, 2, 'se conserva el largo');
  unmakeMove(kingSide);
  assertEqual(kingSide.castling, 3, 'unmake devuelve ambos derechos');

  const queenSide = createPosition('4k3/6b1/8/8/8/8/8/R3K2R b KQ - 0 1');
  makeMove(queenSide, sanToMove(queenSide, 'Bxa1'));
  assertEqual(queenSide.castling & 2, 0, 'se pierde el enroque largo blanco');
  assertEqual(queenSide.castling & 1, 1, 'se conserva el corto');

  const blackSide = createPosition('r3k2r/8/8/8/8/8/1B6/4K3 w kq - 0 1');
  makeMove(blackSide, sanToMove(blackSide, 'Bxh8'));
  assertEqual(blackSide.castling & 4, 0, 'se pierde el enroque corto negro');
  assertEqual(blackSide.castling & 8, 8, 'se conserva el largo negro');
});

test('SAN del enroque con jaque y con mate', () => {
  const check = createPosition('5k2/8/8/8/8/8/8/4K2R w K - 0 1');
  assertEqual(moveToSan(check, sanToMove(check, 'O-O')), 'O-O+', 'la torre en f1 da jaque');

  const mate = createPosition('4rkr1/4p1p1/8/8/8/8/8/4K2R w K - 0 1');
  const castle = sanToMove(mate, 'O-O');
  assertEqual(moveToSan(mate, castle), 'O-O#', 'el enroque da mate');
  makeMove(mate, castle);
  assertEqual(generateMoves(mate).length, 0, 'las negras no tienen respuesta');
  assertEqual(gameResult(mate).reason, 'checkmate');
  assertEqual(gameResult(mate).winner, WHITE);
});

// --- En passant ----------------------------------------------------------

test('al paso prohibido por clavada horizontal doble en la 5ª fila', () => {
  // Ka5, black c5 pawn, white d5 pawn and black rook on h5: capturing en
  // passant empties two squares of the rank at once and exposes the king.
  const pos = createPosition('7k/8/8/K1pP3r/8/8/8/8 w - c6 0 1');
  assertEqual(pos.ep, parseSquare('c6'), 'la casilla al paso se leyó bien');
  assertEqual(sanToMove(pos, 'dxc6'), -1, 'dxc6 es ilegal');
  assertEqual(sanSet(pos).join(' '), 'Ka4 Ka6 Kb5 Kb6 d6');
  assertEqual(uciToMove(pos, 'd5c6'), -1, 'tampoco por UCI');

  // The same geometry with the king off the fifth rank: the capture is legal.
  const legal = createPosition('7k/8/8/2pP3r/8/8/K7/8 w - c6 0 1');
  const capture = sanToMove(legal, 'dxc6');
  assert(capture !== -1, 'con el rey fuera de la fila sí se puede');
  makeMove(legal, capture);
  assertEqual(getFen(legal), '7k/8/2P5/7r/8/8/K7/8 b - - 0 1', 'desaparecen ambos peones de la 5ª');

  // Mirrored, black to move.
  const mirrored = createPosition('8/8/8/8/k1Pp3R/8/8/7K b - c3 0 1');
  assertEqual(sanToMove(mirrored, 'dxc3'), -1, 'mismo caso con los colores invertidos');

  // Vertical pin on the capturing pawn: the push keeps the file blocked and
  // stays legal, the en passant capture abandons it and does not.
  const filePin = createPosition('3r4/8/8/2pP3k/8/8/8/3K4 w - c6 0 1');
  assert(!inCheck(filePin), 'el peón tapa la columna d');
  assertEqual(sanToMove(filePin, 'dxc6'), -1, 'el peón clavado no captura al paso');
  assert(sanToMove(filePin, 'd6') !== -1, 'pero sí puede avanzar por la columna');
  assertEqual(sanSet(filePin).join(' '), 'Kc1 Kc2 Kd2 Ke1 Ke2 d6');
});

// --- Promotions ----------------------------------------------------------

test('promoción con captura que da mate: exd8=Q#', () => {
  const pos = createPosition('3r2k1/4Pppp/8/8/8/8/8/6K1 w - - 0 1');
  const move = sanToMove(pos, 'exd8=Q');
  assert(move !== -1, 'exd8=Q existe');
  assertEqual(moveToSan(pos, move), 'exd8=Q#', 'SAN con # incluido');
  assertEqual(moveToUci(move), 'e7d8q');
  makeMove(pos, move);
  assertEqual(getFen(pos), '3Q2k1/5ppp/8/8/8/8/8/6K1 b - - 0 1');
  assert(inCheck(pos), 'el rey negro está en jaque');
  assertEqual(generateMoves(pos).length, 0, 'sin escapatoria');
  assertEqual(gameResult(pos).reason, 'checkmate');
  unmakeMove(pos);
  assertEqual(getFen(pos), '3r2k1/4Pppp/8/8/8/8/8/6K1 w - - 0 1', 'unmake restaura la torre capturada');
});

// --- SAN disambiguation --------------------------------------------------

test('desambiguación SAN con tres caballos que van a la misma casilla', () => {
  // Knights on b1, b3 and f3: one needs the rank, one the whole square and
  // one only the file.
  const three = createPosition('4k3/8/8/8/8/1N3N2/8/1N2K3 w - - 0 1');
  const sans = sanSet(three);
  for (const expected of ['N1d2', 'Nb3d2', 'Nfd2']) {
    assert(sans.indexOf(expected) >= 0, 'falta ' + expected + ' en ' + sans.join(' '));
  }
  for (const san of ['N1d2', 'Nb3d2', 'Nfd2']) {
    const move = sanToMove(three, san);
    assert(move !== -1, san + ' se vuelve a leer');
    assertEqual(moveToSan(three, move), san, san + ' es estable');
  }
  assertEqual(sanToMove(three, 'Nd2'), -1, 'sin desambiguar es ambiguo');
  assertEqual(sanToMove(three, 'Nbd2'), -1, 'la columna b no alcanza con dos caballos en ella');

  // Two knights on the same rank: the file is enough (Nbd2).
  const byFile = createPosition('4k3/8/8/8/8/8/8/1N2KN2 w - - 0 1');
  assert(sanSet(byFile).indexOf('Nbd2') >= 0, 'Nbd2');
  assertEqual(moveToSan(byFile, sanToMove(byFile, 'Nbd2')), 'Nbd2');

  // Knights on b1, b3 and f1: b1 shares file with b3 and rank with f1.
  const bySquare = createPosition('4k3/8/8/8/8/1N6/8/1N2KN2 w - - 0 1');
  assert(sanSet(bySquare).indexOf('Nb1d2') >= 0, 'Nb1d2');
  assertEqual(moveToSan(bySquare, sanToMove(bySquare, 'Nb1d2')), 'Nb1d2');
});

// --- Clocks --------------------------------------------------------------

test('halfmove y fullmove tras cada tipo de jugada', () => {
  const pos = createPosition(START_FEN);
  assertEqual(pos.halfmove, 0, 'inicio');
  assertEqual(pos.fullmove, 1, 'inicio');

  makeMove(pos, sanToMove(pos, 'e4'));
  assertEqual(pos.halfmove, 0, 'avance doble de peón: reinicia');
  assertEqual(pos.fullmove, 1, 'la jugada de las blancas no incrementa');

  makeMove(pos, sanToMove(pos, 'Nf6'));
  assertEqual(pos.halfmove, 1, 'jugada de pieza: incrementa');
  assertEqual(pos.fullmove, 2, 'la jugada de las negras incrementa');

  makeMove(pos, sanToMove(pos, 'Nc3'));
  assertEqual(pos.halfmove, 2, 'segunda jugada de pieza');
  assertEqual(pos.fullmove, 2);

  makeMove(pos, sanToMove(pos, 'Nxe4'));
  assertEqual(pos.halfmove, 0, 'captura: reinicia');
  assertEqual(pos.fullmove, 3);

  unmakeMove(pos);
  assertEqual(pos.halfmove, 2, 'unmake devuelve el reloj');
  assertEqual(pos.fullmove, 2, 'unmake devuelve el número de jugada');

  const castling = createPosition('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 7 12');
  makeMove(castling, sanToMove(castling, 'O-O'));
  assertEqual(castling.halfmove, 8, 'el enroque incrementa el reloj de 50');
  assertEqual(castling.fullmove, 12);
  makeMove(castling, sanToMove(castling, 'O-O-O'));
  assertEqual(castling.halfmove, 9);
  assertEqual(castling.fullmove, 13, 'tras la jugada negra sube el número');

  const promoting = createPosition('8/4P3/8/k7/8/8/8/4K3 w - - 9 40');
  makeMove(promoting, sanToMove(promoting, 'e8=Q'));
  assertEqual(promoting.halfmove, 0, 'la promoción reinicia el reloj');
  assertEqual(promoting.fullmove, 40);

  const enPassant = createPosition('rnbqkbnr/ppp1pppp/8/3pP3/8/8/PPPP1PPP/RNBQKBNR w KQkq d6 6 3');
  makeMove(enPassant, sanToMove(enPassant, 'exd6'));
  assertEqual(enPassant.halfmove, 0, 'la captura al paso reinicia el reloj');
  assertEqual(enPassant.fullmove, 3);

  const nullPos = createPosition('rnbqkbnr/ppp1pppp/8/3pP3/8/8/PPPP1PPP/RNBQKBNR w KQkq d6 6 3');
  const before = snapshot(nullPos);
  makeNullMove(nullPos);
  assertEqual(nullPos.turn, BLACK, 'la jugada nula cambia el turno');
  assertEqual(nullPos.ep, -1, 'la jugada nula borra la casilla al paso');
  unmakeNullMove(nullPos);
  assertSameState(snapshot(nullPos), before, 'jugada nula');
});

// --- Nine queens ---------------------------------------------------------

test('posición con nueve damas del mismo color', () => {
  const fen = '3k4/8/8/8/8/Q6Q/PPPPPPPP/QQQKQQQQ w - - 0 1';
  const pos = createPosition(fen);
  assertEqual(getFen(pos), fen, 'ida y vuelta de la FEN');

  let queens = 0;
  for (let sq = 0; sq < 128; sq++) {
    if (sq & 0x88) continue;
    if (pos.board[sq] === QUEEN) queens++;
  }
  assertEqual(queens, 9, 'nueve damas blancas');

  const moves = generateMoves(pos);
  assertEqual(moves.length, 44, 'las damas de la 1ª fila están ahogadas entre sí');
  assertEqual(perft(pos, 2), 98, 'perft(2)');
  assertEqual(perft(pos, 3), 4493, 'perft(3)');
  for (const move of moves) {
    assertEqual(sanToMove(pos, moveToSan(pos, move)), move, 'SAN de ' + moveToUci(move));
  }

  // A tenth queen appears by promotion and the position still round-trips.
  const promoting = createPosition('3k4/4P3/8/8/8/Q6Q/PPPPPPPP/QQQKQQQQ w - - 0 1');
  makeMove(promoting, sanToMove(promoting, 'e8=Q'));
  assertEqual(promoting.board[parseSquare('e8')], QUEEN, 'décima dama en e8');
  assertEqual(getFen(createPosition(getFen(promoting))), getFen(promoting), 'FEN estable');
});

// --- Repetition ----------------------------------------------------------

test('repetitionCount tras una secuencia de ida y vuelta de caballos', () => {
  const pos = createPosition(START_FEN);
  assertEqual(repetitionCount(pos), 1, 'posición inicial');
  const shuffle = ['Nf3', 'Nf6', 'Ng1', 'Ng8'];
  for (const san of shuffle) makeMove(pos, sanToMove(pos, san));
  assertEqual(repetitionCount(pos), 2, 'segunda vez');
  for (const san of shuffle) makeMove(pos, sanToMove(pos, san));
  assertEqual(repetitionCount(pos), 3, 'tercera vez');
  assertEqual(gameResult(pos).reason, 'repetition');

  // Deshacer devuelve la cuenta.
  for (let i = 0; i < 4; i++) unmakeMove(pos);
  assertEqual(repetitionCount(pos), 2, 'unmake reduce la cuenta');
  for (let i = 0; i < 4; i++) unmakeMove(pos);
  assertEqual(repetitionCount(pos), 1, 'de vuelta al inicio');
  assertEqual(getFen(pos), START_FEN);

  // Una jugada irreversible abre un historial nuevo: la posición que queda
  // tras ella cuenta como primera aparición y sólo vuelve a subir al repetirse.
  const afterPawn = createPosition(START_FEN);
  for (const san of ['Nf3', 'Nf6', 'Ng1', 'Ng8']) makeMove(afterPawn, sanToMove(afterPawn, san));
  makeMove(afterPawn, sanToMove(afterPawn, 'a3'));
  assertEqual(afterPawn.halfmove, 0, 'el peón reinicia el reloj');
  assertEqual(repetitionCount(afterPawn), 1, 'primera aparición tras el peón');
  for (const san of ['Nf6', 'Nf3', 'Ng8', 'Ng1']) makeMove(afterPawn, sanToMove(afterPawn, san));
  assertEqual(afterPawn.halfmove, 4, 'cuatro medias jugadas reversibles');
  assertEqual(repetitionCount(afterPawn), 2, 'la posición posterior al peón se repitió');
});

// --- clonePosition -------------------------------------------------------

test('clonePosition es realmente independiente', () => {
  const pos = createPosition('r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1');
  makeMove(pos, sanToMove(pos, 'O-O'));
  const before = snapshot(pos);

  const copy = clonePosition(pos);
  assertSameState(snapshot(copy), before, 'la copia arranca igual');
  assert(copy.board !== pos.board, 'board distinto');
  assert(copy.kingSq !== pos.kingSq, 'kingSq distinto');
  assert(copy.undoStack !== pos.undoStack, 'undoStack distinto');
  assert(copy.repLo !== pos.repLo, 'repLo distinto');
  assert(copy.repHi !== pos.repHi, 'repHi distinto');
  assert(copy.undoStack[0] !== pos.undoStack[0], 'las entradas de undo también se copian');

  // Mutación directa de la copia.
  copy.board[0] = EMPTY;
  copy.kingSq[0] = 0;
  copy.repLo[0] = 12345;
  copy.undoStack[0].castling = 0;
  copy.castling = 0;
  copy.ep = 99;
  copy.halfmove = 77;
  copy.keyLo = 1;
  assertSameState(snapshot(pos), before, 'el original no se tocó');

  // Varias jugadas sobre una segunda copia.
  const played = clonePosition(pos);
  for (let i = 0; i < 6; i++) {
    const moves = generateMoves(played);
    if (moves.length === 0) break;
    makeMove(played, moves[moves.length >> 1]);
  }
  assertSameState(snapshot(pos), before, 'jugar en la copia no afecta al original');
  assert(getFen(played) !== getFen(pos), 'la copia sí avanzó');
});

// --- make / unmake -------------------------------------------------------

test('unmakeMove restaura board, castling, ep, halfmove, kingSq y la clave', () => {
  const fens = [
    START_FEN,
    'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 3 7',
    'r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1',
    'rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8',
    'rnbqkbnr/ppp1pppp/8/3pP3/8/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 3',
    '3r2k1/4Pppp/8/8/8/8/8/6K1 w - - 9 30',
    '8/8/8/K1pP3r/8/8/8/7k w - c6 0 1',
    'r3k2r/1b4bq/8/8/8/8/7B/R3K2R w KQkq - 0 1'
  ];
  for (const fen of fens) {
    const pos = createPosition(fen);
    const before = snapshot(pos);
    for (const move of generateMoves(pos, { legal: false })) {
      makeMove(pos, move);
      unmakeMove(pos);
      assertSameState(snapshot(pos), before, fen + ' / ' + moveToUci(move));
    }
    // Dos niveles de profundidad, para cruzar rachas de capturas y enroques.
    for (const first of generateMoves(pos)) {
      makeMove(pos, first);
      const mid = snapshot(pos);
      for (const second of generateMoves(pos)) {
        makeMove(pos, second);
        unmakeMove(pos);
        assertSameState(snapshot(pos), mid, fen + ' / ' + moveToUci(first) + ' ' + moveToUci(second));
      }
      unmakeMove(pos);
      assertSameState(snapshot(pos), before, fen + ' / ' + moveToUci(first) + ' (vuelta)');
    }
  }
});

test('unmakeMove devuelve la jugada revertida y tolera la pila vacía', () => {
  const pos = createPosition(START_FEN);
  const move = sanToMove(pos, 'e4');
  makeMove(pos, move);
  assertEqual(unmakeMove(pos), move, 'devuelve la jugada');
  assertEqual(unmakeMove(pos), 0, 'pila vacía');
  assertEqual(getFen(pos), START_FEN, 'nada cambió');
});

// --- Zobrist -------------------------------------------------------------

test('la clave Zobrist incluye turno, enroque y casilla al paso', () => {
  const same = (a, b) => a.keyLo === b.keyLo && a.keyHi === b.keyHi;

  const white = createPosition('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
  const black = createPosition('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 0 1');
  assert(!same(white, black), 'el turno cambia la clave');

  const allRights = createPosition('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
  const someRights = createPosition('r3k2r/8/8/8/8/8/8/R3K2R w Kkq - 0 1');
  const noRights = createPosition('r3k2r/8/8/8/8/8/8/R3K2R w - - 0 1');
  assert(!same(allRights, someRights), 'los derechos de enroque cambian la clave');
  assert(!same(allRights, noRights), 'sin derechos la clave es otra');
  assert(!same(someRights, noRights), 'cada combinación es distinta');

  const withEp = createPosition('rnbqkbnr/pppp1ppp/8/4p3/8/8/PPPPPPPP/RNBQKBNR w KQkq e6 0 2');
  const withoutEp = createPosition('rnbqkbnr/pppp1ppp/8/4p3/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 2');
  assert(!same(withEp, withoutEp), 'la casilla al paso cambia la clave');

  const otherEp = createPosition('rnbqkbnr/ppp1pppp/8/3p4/8/8/PPPPPPPP/RNBQKBNR w KQkq d6 0 2');
  assert(!same(withEp, otherEp), 'cada casilla al paso es distinta');

  const clockA = createPosition('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
  const clockB = createPosition('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 40 30');
  assert(same(clockA, clockB), 'los relojes no entran en la clave');
});

test('la clave incremental coincide con la recalculada', () => {
  const pos = createPosition(START_FEN);
  const game = ['e4', 'c5', 'Nf3', 'd6', 'd4', 'cxd4', 'Nxd4', 'Nf6', 'Nc3', 'a6',
    'Be3', 'e5', 'Nb3', 'Be6', 'f3', 'Be7', 'Qd2', 'O-O', 'O-O-O', 'Nbd7'];
  for (const san of game) {
    const move = sanToMove(pos, san);
    assert(move !== -1, san);
    makeMove(pos, move);
    const fresh = createPosition(getFen(pos));
    assertEqual(pos.keyLo, fresh.keyLo, 'keyLo tras ' + san);
    assertEqual(pos.keyHi, fresh.keyHi, 'keyHi tras ' + san);
  }
  for (let i = 0; i < game.length; i++) unmakeMove(pos);
  const start = createPosition(START_FEN);
  assertEqual(pos.keyLo, start.keyLo, 'keyLo de vuelta');
  assertEqual(pos.keyHi, start.keyHi, 'keyHi de vuelta');
});

test('la clave incremental sobrevive a promociones, enroques y al paso', () => {
  const cases = [
    ['3r2k1/4Pppp/8/8/8/8/8/6K1 w - - 0 1', 'exd8=N'],
    ['3r2k1/4Pppp/8/8/8/8/8/6K1 w - - 0 1', 'e8=B'],
    ['r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1', 'O-O-O'],
    ['rnbqkbnr/ppp1pppp/8/3pP3/8/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 3', 'exd6'],
    ['rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', 'a4']
  ];
  for (const [fen, san] of cases) {
    const pos = createPosition(fen);
    makeMove(pos, sanToMove(pos, san));
    const fresh = createPosition(getFen(pos));
    assertEqual(pos.keyLo, fresh.keyLo, 'keyLo tras ' + san + ' en ' + fen);
    assertEqual(pos.keyHi, fresh.keyHi, 'keyHi tras ' + san + ' en ' + fen);
  }
});

// --- Piece and move helpers ---------------------------------------------

test('helpers de pieza y casilla', () => {
  assertEqual(pieceType(QUEEN | (BLACK << 3)), QUEEN);
  assertEqual(pieceColor(QUEEN | (BLACK << 3)), BLACK);
  assertEqual(pieceColor(KING), WHITE);
  assertEqual(pieceType(KNIGHT), KNIGHT);
  assertEqual(pieceType(BISHOP), BISHOP);
  assertEqual(pieceType(ROOK), ROOK);
  assertEqual(squareName(parseSquare('e4')), 'e4');
  const pos = createPosition(START_FEN);
  assertEqual(pos.board[parseSquare('e1')], KING, 'rey blanco en e1');
  assertEqual(pos.board[parseSquare('e8')], KING | 8, 'rey negro en e8');
  assertEqual(pos.board[parseSquare('e2')], PAWN, 'peón blanco en e2');
  assertEqual(pos.board[parseSquare('e5')], EMPTY, 'e5 vacía');
  for (const move of generateMoves(pos)) {
    assert(move !== 0, 'ninguna jugada real vale 0');
  }
});

test('generateMoves({captures:true}) devuelve capturas, al paso y promociones', () => {
  const fens = [
    'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1',
    'rnbqkbnr/ppp1pppp/8/3pP3/8/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 3',
    '3r2k1/4Pppp/8/8/8/8/8/6K1 w - - 0 1'
  ];
  for (const fen of fens) {
    const pos = createPosition(fen);
    const tactical = generateMoves(pos, { captures: true });
    const all = generateMoves(pos);
    const allSet = new Set(all);
    for (const move of tactical) {
      assert(allSet.has(move), 'jugada táctica no legal: ' + moveToUci(move) + ' en ' + fen);
      const flags = (move & (1 << 19)) !== 0 || (move & (1 << 20)) !== 0;
      assert(flags || ((move >>> 16) & 7) !== 0, 'ni captura ni promoción: ' + moveToUci(move));
    }
    const expected = all.filter((m) => (m & (1 << 19)) !== 0 || ((m >>> 16) & 7) !== 0).length;
    assertEqual(tactical.length, expected, 'cuenta de jugadas tácticas en ' + fen);
  }
});

// --- Extra perft ---------------------------------------------------------

test('perft extra: promociones — n1n5/PPPk4/8/8/8/8/4Kppp/5N1N b - - 0 1', () => {
  const fen = 'n1n5/PPPk4/8/8/8/8/4Kppp/5N1N b - - 0 1';
  const expected = [24, 496, 9483, 182838, 3605103];
  for (let depth = 1; depth <= expected.length; depth++) {
    const pos = createPosition(fen);
    assertEqual(perft(pos, depth), expected[depth - 1], 'promociones d' + depth);
  }
});

test('perft extra: enroque doble — r3k2r/1b4bq/8/8/8/8/7B/R3K2R w KQkq - 0 1', () => {
  // Los valores del encargo (41/1680/64998) NO corresponden a esta FEN: las
  // blancas sólo tienen 26 jugadas legales (10 de Ta1, 2 de Th1, 7 de Ah2,
  // 5 del rey y 2 enroques), y se pueden contar a mano sobre el tablero.
  // Los valores de abajo son los de la suite de Martin Sedlak y los confirmo
  // con una segunda implementación independiente escrita para este contraste.
  const fen = 'r3k2r/1b4bq/8/8/8/8/7B/R3K2R w KQkq - 0 1';
  const expected = [26, 1141, 27826, 1274206];
  for (let depth = 1; depth <= expected.length; depth++) {
    const pos = createPosition(fen);
    assertEqual(perft(pos, depth), expected[depth - 1], 'enroque doble d' + depth);
  }
  const pos = createPosition(fen);
  const sans = sanSet(pos);
  assertEqual(sans.length, 26, 'veintiséis jugadas legales');
  assert(sans.indexOf('O-O') >= 0, 'enroque corto disponible');
  assert(sans.indexOf('O-O-O') >= 0, 'enroque largo disponible');
});

run('casos límite');
