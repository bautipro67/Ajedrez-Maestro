/**
 * fuerza.mjs — mide de verdad cuanto se equivocan los bots fuertes.
 *
 * No hace falta una lista de posiciones "con solucion conocida": la referencia
 * es el propio motor pensando mucho mas (mismo evaluador, asi que la
 * comparacion es justa). Para cada posicion se mira cuanto pierde la jugada
 * del bot frente a la mejor segun esa referencia. Eso es exactamente lo que
 * significa "comete errores graves".
 */
import * as C from '../web/js/chess.js';
import { createSearcher } from '../web/js/engine.js';
import { handleBotMove } from '../web/js/enginecore.js';

const BOTS = process.argv[2] ? process.argv[2].split(',') : ['helena-teorema', 'yusuf-cimientos', 'amalia-vectores'];
const REF = { depth: 22, nodes: 6_000_000, timeMs: 8000, exactRootScores: true };

/* Posiciones variadas de medio juego, sacadas de partidas reales cortas. */
const POSICIONES = [
  'r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4',
  'r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/2NP1N2/PPP2PPP/R1BQK2R b KQkq - 0 5',
  'r2q1rk1/ppp2ppp/2np1n2/2b1p1B1/2B1P1b1/2NP1N2/PPP2PPP/R2Q1RK1 w - - 6 8',
  'r1bq1rk1/pp2ppbp/2np1np1/8/2BNP3/2N1B3/PPP2PPP/R2QK2R w KQ - 0 9',
  'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1',
  'rnbq1rk1/pp2ppbp/3p1np1/2pP4/4P3/2N2N2/PP2BPPP/R1BQ1RK1 b - - 0 8',
  'r1b2rk1/2q1bppp/p2ppn2/1p6/3NPP2/1BN5/PPP3PP/R1BQ1R1K w - - 2 13',
  '2rq1rk1/pb1nbppp/1p2pn2/8/2BP4/2N1PN2/PP3PPP/R1BQ1RK1 w - - 4 11',
  'r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 11',
  '4rrk1/pp1n1ppp/2pb1q2/3p4/3P1B2/2NQ1N2/PPP2PPP/3RR1K1 b - - 5 15',
  '2r3k1/1b2bppp/p2ppn2/8/1p2P3/1P1BBP2/P1PQ2PP/2KR3R w - - 0 17',
  'r1bqr1k1/pp1nbppp/2p2n2/3p4/2PP4/2N1PN2/PPQ1BPPP/R1B2RK1 w - - 4 10',
  '8/2p2pkp/3p2p1/1p1P4/1P2P3/P3K1P1/5P1P/8 w - - 0 30',
  'r2q1rk1/1b1nbppp/p2ppn2/1p6/3NPP2/1BN1B3/PPPQ2PP/2KR3R w - - 2 13',
  '3r1rk1/1bq2ppp/p3pn2/1pn5/2p1P3/P1N1BN1P/1PB1QPP1/2RR2K1 w - - 0 19',
  'r1b1k2r/pp1n1ppp/2pbpn2/q7/2PP4/2N1PN2/PP1B1PPP/R2QKB1R w KQkq - 4 8',
];

function jugadaDelBot(fen, botId, seed) {
  const t0 = Date.now();
  const r = handleBotMove({ fen, botId, moveNumber: 12, seed, history: [] });
  return { ...r, wallMs: Date.now() - t0 };
}

function main() {
  const searcher = createSearcher();
  const referencia = new Map();

  process.stdout.write(`Referencia (${REF.timeMs} ms, ${REF.nodes.toLocaleString('es-ES')} nodos) sobre ${POSICIONES.length} posiciones…\n`);
  for (const fen of POSICIONES) {
    const pos = C.createPosition(fen);
    searcher.clearTables();
    const r = searcher.searchRoot(pos, REF);
    const mapa = new Map();
    for (const m of r.moves || []) mapa.set(C.moveToUci(m.move), m.score);
    referencia.set(fen, { mejor: r.moves?.[0]?.score ?? 0, mapa, depth: r.depth, best: C.moveToUci(r.best) });
    process.stdout.write('.');
  }
  process.stdout.write('\n\n');

  for (const botId of BOTS) {
    const perdidas = [];
    let graves = 0, medios = 0, exactos = 0;
    let nodos = 0, prof = 0, ms = 0;
    for (const fen of POSICIONES) {
      const ref = referencia.get(fen);
      /* Semilla distinta por posicion: con una sola, el azar del bot (errores
         a proposito, ceguera tactica) sale siempre igual y la medida miente. */
      const jug = jugadaDelBot(fen, botId, 1000 + POSICIONES.indexOf(fen) * 7919);
      const suScore = ref.mapa.has(jug.uci) ? ref.mapa.get(jug.uci) : null;
      const perdida = suScore === null ? null : Math.max(0, ref.mejor - suScore);
      if (perdida !== null) {
        perdidas.push(perdida);
        if (perdida >= 150) graves++;
        else if (perdida >= 50) medios++;
        if (perdida === 0) exactos++;
      }
      nodos += jug.nodes || 0;
      prof += jug.depth || 0;
      ms += jug.wallMs || 0;
    }
    const n = perdidas.length || 1;
    const media = perdidas.reduce((a, b) => a + b, 0) / n;
    const peor = perdidas.length ? Math.max(...perdidas) : 0;
    process.stdout.write(
      `${botId.padEnd(20)} pérdida media ${media.toFixed(0).padStart(4)} cp · ` +
      `graves(≥150) ${String(graves).padStart(2)}/${n} · dudosas(≥50) ${String(medios).padStart(2)} · ` +
      `clava la mejor ${String(exactos).padStart(2)} · peor ${String(peor).padStart(4)} cp\n` +
      `${''.padEnd(20)} prof media ${(prof / POSICIONES.length).toFixed(1)} · ` +
      `${Math.round(nodos / POSICIONES.length).toLocaleString('es-ES')} nodos · ` +
      `${Math.round(ms / POSICIONES.length)} ms por jugada\n`);
  }
}

main();
