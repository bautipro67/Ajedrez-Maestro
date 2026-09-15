/**
 * puzzles.test.js — el entrenamiento táctico.
 * Lo importante aquí es que un problema no se pueda «resolver» por casualidad
 * (la línea entera tiene que salir), que la elección se acerque a tu nivel sin
 * repetir, y que de una partida tuya salgan problemas solo donde de verdad te
 * equivocaste.
 */

import { test, assert, assertEqual, run } from './harness.js';
import {
  createSolver, pickPuzzle, ratePuzzleResult, sessionSummary,
  puzzlesFromReport, ratingFromDrop, STARTING_PUZZLE_RATING, PUZZLE_THEMES,
} from '../web/js/puzzles.js';
import { PUZZLES } from '../web/js/puzzledata.js';
import { createPosition, generateMoves, uciToMove, makeMove, gameResult } from '../web/js/chess.js';

/* -------------------------------- resolver ------------------------------- */

const LINEA = { id: 'x', fen: '8/8/8/8/8/8/8/8 w - - 0 1', moves: ['e2e4', 'e7e5', 'g1f3'], rating: 1200, theme: 'material' };

test('acertar la línea entera resuelve el problema', () => {
  const s = createSolver(LINEA);
  assertEqual(s.expected(), 'e2e4', 'primero toca tu jugada');
  const uno = s.tryMove('e2e4');
  assert(uno.ok, 'la primera era buena');
  assertEqual(uno.reply, 'e7e5', 'y el rival contesta');
  assert(!uno.solved, 'todavía queda');
  const dos = s.tryMove('g1f3');
  assert(dos.ok && dos.solved, 'con la última se acaba');
  assert(!s.failed(), 'sin fallar por el camino');
});

test('una jugada mala falla el problema, aunque después se acierte', () => {
  const s = createSolver(LINEA);
  const malo = s.tryMove('d2d4');
  assert(!malo.ok, 'esa no era');
  assert(malo.failed, 'y cuenta como fallo');
  assertEqual(malo.expected, 'e2e4', 'diciendo cuál era');
  /* Se puede seguir para ver la línea, pero el fallo ya está puesto. */
  s.tryMove('e2e4');
  assert(s.failed(), 'el fallo no se borra por acertar después');
});

test('rendirse devuelve la línea y cuenta como fallo', () => {
  const s = createSolver(LINEA);
  const linea = s.giveUp();
  assertEqual(linea.length, 3);
  assert(s.failed() && s.solved(), 'queda cerrado y fallado');
  const despues = s.tryMove('e2e4');
  assert(!despues.ok, 'ya no se puede jugar');
});

/* -------------------------------- elección ------------------------------- */

const POOL = [
  { id: 'a', rating: 700 }, { id: 'b', rating: 1000 }, { id: 'c', rating: 1050 },
  { id: 'd', rating: 1800 }, { id: 'e', rating: 2200 },
];

test('el problema que toca está cerca de tu nivel', () => {
  for (let i = 0; i < 30; i++) {
    const p = pickPuzzle(POOL, { rating: 1000, rng: () => (i * 0.037) % 1 });
    assert(Math.abs(p.rating - 1000) <= 150,
      'con nivel 1000 no debería tocar uno de ' + p.rating);
  }
});

test('no repite los que acabás de ver', () => {
  const p = pickPuzzle(POOL, { rating: 1000, recent: ['b', 'c'], rng: () => 0 });
  assert(p.id !== 'b' && p.id !== 'c', 'esos dos estaban vistos y salió ' + p.id);
});

test('si todos están vistos, vuelve a empezar en vez de quedarse sin nada', () => {
  const p = pickPuzzle(POOL, { rating: 1000, recent: POOL.map((x) => x.id), rng: () => 0 });
  assert(p !== null, 'tiene que devolver alguno igualmente');
});

test('sin problemas no inventa ninguno', () => {
  assertEqual(pickPuzzle([], {}), null);
});

/* ------------------------------- puntuación ------------------------------ */

test('resolver uno difícil sube más que uno fácil', () => {
  const facil = ratePuzzleResult({ rating: 1200, puzzleRating: 700, solved: true, solvedCount: 50 });
  const dificil = ratePuzzleResult({ rating: 1200, puzzleRating: 1700, solved: true, solvedCount: 50 });
  assert(dificil.delta > facil.delta,
    `el difícil debería dar más: fácil ${facil.delta}, difícil ${dificil.delta}`);
  assert(facil.delta > 0, 'acertar siempre suma algo');
});

test('fallar uno fácil baja más que fallar uno difícil', () => {
  const facil = ratePuzzleResult({ rating: 1200, puzzleRating: 700, solved: false, solvedCount: 50 });
  const dificil = ratePuzzleResult({ rating: 1200, puzzleRating: 1700, solved: false, solvedCount: 50 });
  assert(facil.delta < dificil.delta,
    `fallar el fácil tiene que doler más: fácil ${facil.delta}, difícil ${dificil.delta}`);
  assert(dificil.delta <= 0, 'fallar nunca suma');
});

test('el resumen de la tanda cuenta rachas', () => {
  const s = sessionSummary([
    { solved: true, delta: 8 }, { solved: true, delta: 7 }, { solved: false, delta: -12 },
    { solved: true, delta: 6 },
  ]);
  assertEqual(s.total, 4);
  assertEqual(s.solved, 3);
  assertEqual(s.bestStreak, 2, 'la racha más larga fueron dos');
  assertEqual(s.delta, 9);
  assertEqual(s.accuracy, 75);
});

/* --------------------------- de tus propias partidas --------------------- */

test('de una partida salen problemas solo donde te equivocaste de verdad', () => {
  const jugadas = [
    { ply: 1, san: 'e4', uci: 'e2e4', color: 'w', clase: 'best', perdidaWin: 0, bestUci: 'e2e4', fenBefore: 'f1', cpLoss: 0 },
    { ply: 3, san: 'Qh5', uci: 'd1h5', color: 'w', clase: 'blunder', perdidaWin: 42, bestUci: 'g1f3', bestSan: 'Nf3', fenBefore: 'f2', cpLoss: 600 },
    { ply: 5, san: 'Nc3', uci: 'b1c3', color: 'w', clase: 'inaccuracy', perdidaWin: 7, bestUci: 'd2d4', fenBefore: 'f3', cpLoss: 60 },
    { ply: 7, san: 'Bc4', uci: 'f1c4', color: 'w', clase: 'mistake', perdidaWin: 22, bestUci: 'd2d4', bestSan: 'd4', fenBefore: 'f4', cpLoss: 260 },
  ];
  const problemas = puzzlesFromReport(jugadas, { gameId: 'g1', opponent: 'Pepito' });
  assertEqual(problemas.length, 2, 'la buena y la imprecisión no son problemas');
  assertEqual(problemas[0].theme, 'propia');
  assertEqual(problemas[0].moves[0], 'g1f3', 'la solución es la jugada que decía el motor');
  assertEqual(problemas[0].played, 'Qh5', 'y se recuerda lo que jugaste');
  assertEqual(problemas[0].from.opponent, 'Pepito');
  assert(problemas[0].gain > problemas[1].gain, 'primero el error más caro');
});

test('si la jugada buena era la que hiciste, no hay nada que preguntar', () => {
  const problemas = puzzlesFromReport([
    { ply: 3, san: 'Nf3', uci: 'g1f3', color: 'w', clase: 'blunder', perdidaWin: 40, bestUci: 'g1f3', fenBefore: 'f1', cpLoss: 500 },
  ], {});
  assertEqual(problemas.length, 0);
});

test('un error gordo es más fácil de ver que uno fino', () => {
  const gordo = ratingFromDrop(45, 800);
  const fino = ratingFromDrop(16, 150);
  assert(gordo < fino, `el gordo debería ser más fácil: gordo ${gordo}, fino ${fino}`);
  assert(gordo >= 600 && fino <= 2200, 'ambos dentro del rango');
});

/* ------------------------- el juego que viene dentro --------------------- */

test('los problemas que vienen con la app están bien formados', () => {
  assert(Array.isArray(PUZZLES), 'PUZZLES es una lista');
  for (const p of PUZZLES) {
    assert(typeof p.fen === 'string' && p.fen.split(' ').length >= 4, p.id + ': FEN rara');
    assert(Array.isArray(p.moves) && p.moves.length >= 1, p.id + ': sin solución');
    assertEqual(p.moves.length % 2, 1, p.id + ': la línea tiene que acabar en jugada tuya');
    for (const m of p.moves) {
      assert(/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(m), p.id + ': jugada rara ' + m);
    }
    assert(p.rating >= 600 && p.rating <= 2400, p.id + ': dificultad fuera de rango ' + p.rating);
    assert(PUZZLE_THEMES[p.theme], p.id + ': tema desconocido ' + p.theme);
  }
});

test('la solución de cada problema se puede jugar entera', () => {
  /* El formato se puede cumplir y la línea ser imposible: aquí se juega de
     verdad, jugada a jugada, sobre el tablero. */
  for (const p of PUZZLES) {
    const pos = createPosition(p.fen);
    p.moves.forEach((uci, i) => {
      const legales = generateMoves(pos, { legal: true });
      const move = uciToMove(pos, uci);
      assert(move && legales.includes(move),
        `${p.id}: la jugada ${i + 1} (${uci}) no es legal en esa posición`);
      makeMove(pos, move);
    });
  }
});

test('los problemas de mate acaban en mate', () => {
  for (const p of PUZZLES) {
    if (p.theme !== 'mate') continue;
    const pos = createPosition(p.fen);
    for (const uci of p.moves) makeMove(pos, uciToMove(pos, uci));
    const r = gameResult(pos);
    assert(r.over && r.reason === 'checkmate',
      `${p.id} dice ser mate y acaba en "${r.reason || 'nada'}"`);
  }
});

test('las dificultades cubren un rango útil', () => {
  const niveles = PUZZLES.map((p) => p.rating);
  const min = Math.min(...niveles);
  const max = Math.max(...niveles);
  assert(max - min >= 300, `todos los problemas valen casi lo mismo (${min}-${max})`);
  const temas = new Set(PUZZLES.map((p) => p.theme));
  assert(temas.size >= 2, 'tiene que haber más de un tipo de problema: ' + [...temas].join(', '));
});

test('ningún problema viene repetido', () => {
  const vistos = new Set();
  for (const p of PUZZLES) {
    assert(!vistos.has(p.fen), 'posición repetida en ' + p.id);
    vistos.add(p.fen);
  }
});

run('puzzles.js');
