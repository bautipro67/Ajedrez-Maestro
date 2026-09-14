/**
 * bench.js — medidor de rendimiento, no es un test.
 * Sirve para ver si un cambio en las reglas, la evaluacion o la busqueda sale
 * caro. No falla nunca: solo imprime numeros comparables entre ejecuciones.
 *
 *   npm run bench
 *   node test/bench.js --rapido
 */

import { performance } from 'node:perf_hooks';
import * as C from '../web/js/chess.js';
import { evaluate, DEFAULT_WEIGHTS } from '../web/js/eval.js';
import { createSearcher } from '../web/js/engine.js';
import { bookMove, openingName, BOOK_LINES } from '../web/js/book.js';
import { strengthProfile, chooseBotMove } from '../web/js/bots.js';

const QUICK = process.argv.includes('--rapido');

const POSITIONS = [
  ['inicial', C.START_FEN],
  ['Kiwipete', 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1'],
  ['final de peones', '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1'],
  ['medio juego', 'r1bq1rk1/pp2ppbp/2np1np1/8/2BNP3/2N1B3/PPP2PPP/R2QK2R w KQ - 0 9'],
];

function fmt(n, decimals = 0) {
  return n.toLocaleString('es-ES', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function bar(value, max, width = 22) {
  const filled = Math.max(1, Math.round((value / max) * width));
  return '█'.repeat(Math.min(width, filled));
}

function timed(fn) {
  const started = performance.now();
  const result = fn();
  return { ms: performance.now() - started, result };
}

process.stdout.write('\n=== Ajedrez Maestro · rendimiento ===\n');
process.stdout.write(`node ${process.version} · ${process.platform}\n\n`);

/* ------------------------------- reglas -------------------------------- */

process.stdout.write('Generacion de jugadas (perft)\n');
{
  const depth = QUICK ? 4 : 5;
  for (const [name, fen] of POSITIONS.slice(0, 3)) {
    const pos = C.createPosition(fen);
    const { ms, result } = timed(() => C.perft(pos, depth));
    const nps = result / (ms / 1000);
    process.stdout.write(
      `  ${name.padEnd(16)} profundidad ${depth}  ${fmt(result).padStart(11)} nodos  ` +
      `${fmt(ms, 0).padStart(6)} ms  ${fmt(nps).padStart(11)} nodos/s\n`,
    );
  }
}

/* ----------------------------- evaluacion ------------------------------ */

process.stdout.write('\nEvaluacion\n');
{
  const rounds = QUICK ? 60000 : 300000;
  for (const [name, fen] of POSITIONS) {
    const pos = C.createPosition(fen);
    const { ms } = timed(() => {
      let acc = 0;
      for (let i = 0; i < rounds; i++) acc += evaluate(pos, DEFAULT_WEIGHTS);
      return acc;
    });
    const rate = rounds / (ms / 1000);
    process.stdout.write(`  ${name.padEnd(16)} ${fmt(rate).padStart(12)} evaluaciones/s\n`);
  }
}

/* ------------------------------ busqueda ------------------------------- */

process.stdout.write('\nBusqueda (tope de nodos fijo, para comparar de verdad)\n');
{
  const nodes = QUICK ? 60000 : 250000;
  let peak = 1;
  const rows = [];
  for (const [name, fen] of POSITIONS) {
    const searcher = createSearcher({ ttSizeMb: 16 });
    const pos = C.createPosition(fen);
    const { ms, result } = timed(() => searcher.search(pos, { depth: 64, nodes, timeMs: 600000 }));
    const nps = result.nodes / (ms / 1000);
    peak = Math.max(peak, nps);
    rows.push({ name, result, ms, nps });
  }
  for (const row of rows) {
    process.stdout.write(
      `  ${row.name.padEnd(16)} prof ${String(row.result.depth).padStart(2)}/${String(row.result.seldepth).padStart(2)}  ` +
      `${fmt(row.result.nodes).padStart(9)} nodos  ${fmt(row.ms, 0).padStart(6)} ms  ` +
      `${fmt(row.nps).padStart(10)} n/s  ${bar(row.nps, peak)}\n`,
    );
  }
}

/* -------------------------------- libro -------------------------------- */

process.stdout.write('\nLibro de aperturas\n');
{
  const rounds = QUICK ? 4000 : 20000;
  let seed = 1;
  const rng = () => {
    seed = (seed * 48271) % 2147483647;
    return seed / 2147483647;
  };
  const pos = C.createPosition();
  const first = timed(() => bookMove(pos, 'wide', rng));   // incluye construir el indice
  const { ms } = timed(() => {
    let hits = 0;
    for (let i = 0; i < rounds; i++) if (bookMove(pos, 'wide', rng) !== -1) hits++;
    return hits;
  });
  const sample = BOOK_LINES[0].sans.slice(0, 8);
  const named = timed(() => {
    for (let i = 0; i < rounds; i++) openingName(sample);
  });
  process.stdout.write(`  indexado inicial   ${fmt(first.ms, 1).padStart(8)} ms (${BOOK_LINES.length} lineas)\n`);
  process.stdout.write(`  bookMove           ${fmt(rounds / (ms / 1000)).padStart(12)} consultas/s\n`);
  process.stdout.write(`  openingName        ${fmt(rounds / (named.ms / 1000)).padStart(12)} consultas/s\n`);
}

/* --------------------------- eleccion del bot --------------------------- */

process.stdout.write('\nEleccion de jugada de los bots\n');
{
  const searcher = createSearcher({ ttSizeMb: 8 });
  const pos = C.createPosition(POSITIONS[3][1]);
  const root = searcher.searchRoot(pos, { depth: 6, nodes: 200000, timeMs: 600000 });
  const rounds = QUICK ? 20000 : 100000;
  for (const elo of [400, 1200, 2000, 2900]) {
    const profile = strengthProfile(elo);
    let seed = 7;
    const rng = () => {
      seed = (seed * 48271) % 2147483647;
      return seed / 2147483647;
    };
    const ctx = { pos, moveNumber: 9, myColor: 0, inCheck: false, materialDiff: 0 };
    const { ms } = timed(() => {
      for (let i = 0; i < rounds; i++) chooseBotMove(root.moves, profile, rng, ctx);
    });
    process.stdout.write(`  Elo ${String(elo).padStart(4)}          ${fmt(rounds / (ms / 1000)).padStart(12)} elecciones/s\n`);
  }
}

process.stdout.write('\n');
