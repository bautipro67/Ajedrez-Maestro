/**
 * generar-problemas.mjs — fabrica el juego de problemas que viaja con la app.
 *
 * La idea: generar aquí, fuera del navegador, donde se puede pensar mucho por
 * posición, y que el jugador reciba un fichero ya verificado. Nada de buscar
 * tácticas en caliente mientras alguien espera.
 *
 * Cómo salen: se juegan partidas entre bots de nivel medio —que son los que se
 * equivocan de forma humana— y en cada posición se mira si el que mueve tiene
 * UNA jugada claramente mejor que todas las demás. Eso es una táctica: si la
 * segunda mejor pierde 250 centipeones respecto de la primera, la primera hay
 * que encontrarla. Después se comprueba la línea entera con una búsqueda más
 * profunda y se guarda con su solución.
 *
 *   node tools/generar-problemas.mjs [cuántos] [segundos como mucho]
 */

import { writeFileSync } from 'node:fs';
import * as C from '../web/js/chess.js';
import { createSearcher } from '../web/js/engine.js';
import { handleBotMove } from '../web/js/enginecore.js';
import { BOTS } from '../web/js/bots.js';

const OBJETIVO = Number(process.argv[2]) || 120;
const TOPE_SEGUNDOS = Number(process.argv[3]) || 900;

/* Las dos piden TODAS las puntuaciones exactas, y no es un lujo: con el sondeo
   de ventana nula, las jugadas que no se puntúan exactas se quedan con un
   número pegado al de la mejor. Al ordenar, una de esas se cuela en el segundo
   puesto, la diferencia sale cero y no se detecta ninguna táctica. */
/* Criba: barata, para descartar la inmensa mayoría de posiciones. */
const CRIBA = { depth: 9, nodes: 120_000, timeMs: 300, exactRootScores: true };
/* Verificación: cara, solo para las que pasan la criba. */
const PRUEBA = { depth: 20, nodes: 3_000_000, timeMs: 4000, exactRootScores: true };

const VENTAJA_MINIMA = 250;   // cuánto tiene que ganar la mejor sobre la segunda
const DECISIVA = -50;         // y en qué posición te tiene que dejar (salvarse cuenta)

/* Bots de nivel medio: los fuertes no se equivocan y los flojos hacen ruido. */
const CANTERA = BOTS.filter((b) => b.elo >= 900 && b.elo <= 2000).map((b) => b.id);

const searcher = createSearcher();

function analizar(fen, limites) {
  const pos = C.createPosition(fen);
  searcher.clearTables();
  const r = searcher.searchRoot(pos, limites);
  /* Solo las exactas: una cota no dice cuánto vale una jugada, solo que no
     supera a la mejor, y su número engaña al ordenar. */
  const moves = (r.moves || []).filter((m) => m.exact !== false).sort((a, b) => b.score - a.score);
  return {
    mejor: moves[0] || null,
    segunda: moves[1] || null,
    pos,
    mate: r.mate,
  };
}

/** ¿Es la jugada tranquila? Las que no capturan ni dan jaque cuestan más. */
function esTranquila(pos, move) {
  if (C.isCapture(move) || C.movePromo(move) !== 0) return false;
  C.makeMove(pos, move);
  const jaque = C.inCheck(pos);
  C.unmakeMove(pos);
  return !jaque;
}

function dificultad({ plies, tranquila, ventaja, mate }) {
  let r = 900;
  r += Math.max(0, plies - 1) * 140;
  if (tranquila) r += 220;
  if (mate) r -= 120;
  /* Cuanto más justa es la diferencia, más fina hay que hilar. */
  if (ventaja < 400) r += 120;
  if (ventaja > 900) r -= 100;
  return Math.max(600, Math.min(2400, Math.round(r / 25) * 25));
}

/** ¿La línea guardada termina de verdad en mate? */
function acabaEnMate(fen, linea) {
  const pos = C.createPosition(fen);
  for (const uci of linea) {
    const move = C.uciToMove(pos, uci);
    if (!move) return false;
    C.makeMove(pos, move);
  }
  const r = C.gameResult(pos);
  return !!(r.over && r.reason === 'checkmate');
}

function tema({ mate, ventaja, eraPeor }) {
  /* «mate» solo si la solución guardada llega hasta el mate. El motor lo ve
     más lejos de donde corta la línea, y prometer un mate que no está en las
     jugadas que se guardan es mandar a alguien a buscar lo que no hay. */
  if (mate) return 'mate';
  if (eraPeor) return 'defensa';
  return ventaja >= 500 ? 'material' : 'ventaja';
}

/** Juega una partida entre dos bots y devuelve las posiciones por las que pasó. */
function partida(semilla) {
  const blancas = CANTERA[semilla % CANTERA.length];
  const negras = CANTERA[(semilla * 7 + 3) % CANTERA.length];
  const pos = C.createPosition(C.START_FEN);
  const fens = [];
  const historia = [];

  for (let ply = 0; ply < 80; ply++) {
    const fen = C.getFen(pos);
    if (C.gameResult(pos).over) break;
    fens.push(fen);
    const botId = pos.turn === 0 ? blancas : negras;
    let jugada;
    try {
      jugada = handleBotMove({
        fen, botId, history: historia.slice(),
        moveNumber: Math.floor(ply / 2) + 1,
        seed: (semilla * 131 + ply * 17) >>> 0,
      });
    } catch {
      break;
    }
    if (!jugada || !jugada.uci) break;
    const move = C.uciToMove(pos, jugada.uci);
    if (!move) break;
    C.makeMove(pos, move);
    historia.push(jugada.uci);
  }
  return fens;
}

/** Saca la línea de la solución: tu jugada, la respuesta, tu jugada… */
function lineaDeSolucion(fen, pv, maxPlies = 7) {
  const pos = C.createPosition(fen);
  const salida = [];
  for (const move of pv.slice(0, maxPlies)) {
    if (!move) break;
    const legales = C.generateMoves(pos, { legal: true });
    if (!legales.includes(move)) break;
    salida.push(C.moveToUci(move));
    C.makeMove(pos, move);
    if (C.gameResult(pos).over) break;
  }
  /* Tiene que acabar en jugada tuya: si no, la última del rival sobra. */
  if (salida.length % 2 === 0) salida.pop();
  return salida;
}

function main() {
  const arranque = Date.now();
  const problemas = [];
  const vistos = new Set();
  let posicionesMiradas = 0;

  for (let semilla = 1; problemas.length < OBJETIVO; semilla++) {
    if ((Date.now() - arranque) / 1000 > TOPE_SEGUNDOS) break;
    const fens = partida(semilla);

    for (const fen of fens) {
      if (problemas.length >= OBJETIVO) break;
      if ((Date.now() - arranque) / 1000 > TOPE_SEGUNDOS) break;
      if (vistos.has(fen)) continue;
      vistos.add(fen);
      posicionesMiradas++;

      const rapido = analizar(fen, CRIBA);
      if (!rapido.mejor || !rapido.segunda) continue;
      const ventajaRapida = rapido.mejor.score - rapido.segunda.score;
      if (ventajaRapida < VENTAJA_MINIMA) continue;
      if (rapido.mejor.score < DECISIVA) continue;

      /* Pasó la criba: ahora en serio. */
      const hondo = analizar(fen, PRUEBA);
      if (!hondo.mejor || !hondo.segunda) continue;
      const ventaja = hondo.mejor.score - hondo.segunda.score;
      if (ventaja < VENTAJA_MINIMA || hondo.mejor.score < DECISIVA) continue;

      const linea = lineaDeSolucion(fen, hondo.mejor.pv || [hondo.mejor.move]);
      if (!linea.length) continue;

      const pos = C.createPosition(fen);
      const primera = C.uciToMove(pos, linea[0]);
      if (!primera) continue;

      const esMate = hondo.mejor.mate !== null && hondo.mejor.mate !== undefined;
      const problema = {
        id: 'p' + String(problemas.length + 1).padStart(3, '0'),
        fen,
        moves: linea,
        rating: dificultad({
          plies: Math.ceil(linea.length / 2),
          tranquila: esTranquila(pos, primera),
          ventaja,
          mate: esMate,
        }),
        theme: tema({
          mate: esMate && acabaEnMate(fen, linea),
          ventaja,
          eraPeor: hondo.segunda.score < -300,
        }),
        gain: Math.min(2000, ventaja),
      };
      problemas.push(problema);
      process.stdout.write(
        `${problemas.length}/${OBJETIVO} ${problema.theme.padEnd(9)} ${problema.rating} ` +
        `(+${ventaja} cp, ${linea.length} plies) tras mirar ${posicionesMiradas}\n`);
    }
  }

  problemas.sort((a, b) => a.rating - b.rating);
  problemas.forEach((p, i) => { p.id = 'p' + String(i + 1).padStart(3, '0'); });

  const cabecera = `/**
 * puzzledata.js — el juego de problemas que viene con la aplicacion.
 *
 * NO SE ESCRIBE A MANO: lo genera tools/generar-problemas.mjs jugando partidas
 * entre bots y quedandose con las posiciones donde el que mueve tiene una sola
 * jugada claramente mejor que las demas. Cada uno esta verificado con una
 * busqueda profunda: la solucion gana al menos ${VENTAJA_MINIMA} centipeones sobre la
 * segunda mejor.
 *
 * Campos: fen (te toca mover), moves (tu jugada, la respuesta, tu jugada...),
 * rating (dificultad estimada), theme, gain (centipeones de diferencia).
 *
 * Generado con ${problemas.length} problemas.
 */

export const PUZZLES = Object.freeze([
`;
  const cuerpo = problemas.map((p) =>
    `  { id: '${p.id}', fen: '${p.fen}', moves: [${p.moves.map((m) => `'${m}'`).join(', ')}], ` +
    `rating: ${p.rating}, theme: '${p.theme}', gain: ${p.gain} },`).join('\n');

  writeFileSync('web/js/puzzledata.js', cabecera + cuerpo + '\n].map(Object.freeze));\n');
  process.stdout.write(
    `\nlisto: ${problemas.length} problemas de ${posicionesMiradas} posiciones miradas, ` +
    `en ${Math.round((Date.now() - arranque) / 1000)} s\n`);
}

main();
