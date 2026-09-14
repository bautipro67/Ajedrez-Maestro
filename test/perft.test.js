/*
 * perft.test.js — conteo de nodos contra los valores de referencia del
 * contrato (seccion 13). Cubre las seis posiciones estandar a todas las
 * profundidades indicadas e imprime los nodos por segundo medidos en
 * la posicion inicial a profundidad 5.
 */

import { createPosition, generateMoves, makeMove, unmakeMove, perft, moveToUci, START_FEN } from '../web/js/chess.js';
import { test, assertEqual, run } from './harness.js';

const POSITIONS = [
  {
    name: 'posición inicial',
    fen: START_FEN,
    depths: [20, 400, 8902, 197281, 4865609]
  },
  {
    name: 'Kiwipete',
    fen: 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq -',
    depths: [48, 2039, 97862, 4085603]
  },
  {
    name: 'posición 3',
    fen: '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - -',
    depths: [14, 191, 2812, 43238, 674624]
  },
  {
    name: 'posición 4',
    fen: 'r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq -',
    depths: [6, 264, 9467, 422333]
  },
  {
    name: 'posición 5',
    fen: 'rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ -',
    depths: [44, 1486, 62379, 2103487]
  },
  {
    name: 'posición 6',
    fen: 'r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - -',
    depths: [46, 2079, 89890, 3894594]
  }
];

// Perft por jugada raiz: util para depurar una discrepancia comparando el
// reparto de nodos contra una referencia externa.
export function perftDivide(pos, depth) {
  const result = [];
  const moves = generateMoves(pos);
  for (let i = 0; i < moves.length; i++) {
    makeMove(pos, moves[i]);
    result.push({ uci: moveToUci(moves[i]), nodes: perft(pos, depth - 1) });
    unmakeMove(pos);
  }
  result.sort((a, b) => (a.uci < b.uci ? -1 : 1));
  return result;
}

for (const entry of POSITIONS) {
  for (let depth = 1; depth <= entry.depths.length; depth++) {
    const expected = entry.depths[depth - 1];
    test(entry.name + ' — perft(' + depth + ') = ' + expected, () => {
      const pos = createPosition(entry.fen);
      assertEqual(perft(pos, depth), expected, entry.name + ' d' + depth);
    });
  }
}

test('perft no altera la posición de partida', () => {
  const pos = createPosition(START_FEN);
  const before = pos.keyLo + ':' + pos.keyHi;
  perft(pos, 4);
  assertEqual(pos.keyLo + ':' + pos.keyHi, before, 'clave Zobrist');
  assertEqual(pos.undoStack.length, 0, 'pila de deshacer vacía');
  assertEqual(pos.repLo.length, 1, 'historial de repetición');
});

test('generateMoves({legal:false}) es un superconjunto de las legales', () => {
  const fens = [
    START_FEN,
    'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq -',
    'rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ -'
  ];
  for (const fen of fens) {
    const pos = createPosition(fen);
    const legal = new Set(generateMoves(pos, { legal: true }));
    const pseudo = new Set(generateMoves(pos, { legal: false }));
    for (const move of legal) {
      if (!pseudo.has(move)) throw new Error('falta ' + moveToUci(move) + ' en ' + fen);
    }
    if (pseudo.size < legal.size) throw new Error('pseudolegales < legales en ' + fen);
  }
});

const benchPos = createPosition(START_FEN);
const started = process.hrtime.bigint();
const benchNodes = perft(benchPos, 5);
const elapsed = Number(process.hrtime.bigint() - started) / 1e9;
const nps = Math.round(benchNodes / elapsed);

run('perft');
process.stdout.write('  rendimiento: perft(inicial, 5) = ' + benchNodes + ' nodos en ' +
  elapsed.toFixed(3) + ' s  ->  ' + nps.toLocaleString('es-AR') + ' nodos/segundo\n');
if (nps < 1500000) {
  process.stdout.write('  AVISO: por debajo del objetivo de 1.500.000 nodos/segundo\n');
  process.exit(1);
}
