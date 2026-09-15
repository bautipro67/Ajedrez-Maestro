/**
 * puzzles.js — el entrenamiento táctico: elegir problema, comprobar la jugada
 * y llevar la puntuación de quien resuelve.
 *
 * Dos fuentes, y la segunda es la que hace que esto valga la pena:
 *
 *  1. El juego que viene con la aplicación (puzzledata.js), generado fuera del
 *     navegador y verificado con búsqueda profunda.
 *  2. TUS propias partidas. El informe ya sabe en qué jugada tiraste la partida
 *     y cuál era la buena, así que esa posición es un problema hecho: «acá te
 *     equivocaste, ¿encontrás lo que había?». Es la única forma de entrenar
 *     exactamente lo que fallás vos.
 *
 * Sin DOM y sin estado global: todo entra por parámetros.
 */

import { applyResult } from './elo.js';

export const PUZZLE_THEMES = Object.freeze({
  mate: { label: 'Mate', hint: 'Hay mate. Encontralo.' },
  material: { label: 'Gana material', hint: 'Se gana material por la fuerza.' },
  ventaja: { label: 'Ventaja', hint: 'Una jugada cambia la posición. Las demás no.' },
  defensa: { label: 'Defensa', hint: 'Solo hay una forma de aguantar.' },
  propia: { label: 'De tu partida', hint: 'Acá jugaste otra cosa. Mirá qué había.' },
});

export const STARTING_PUZZLE_RATING = 900;

/* ------------------------- de tus propias partidas ----------------------- */

/**
 * Convierte los errores de una partida ya analizada en problemas.
 *
 * @param {object[]} reportMoves  el `moves` que devuelve buildReport()
 * @param {object} meta  {gameId, opponent}
 * @param {object} opts  {minDrop} caída mínima en probabilidad de ganar
 */
export function puzzlesFromReport(reportMoves = [], meta = {}, { minDrop = 15 } = {}) {
  const salida = [];
  for (const m of reportMoves) {
    if (!m || !m.bestUci || !m.fenBefore) continue;
    if (m.clase !== 'blunder' && m.clase !== 'mistake') continue;
    if (m.perdidaWin < minDrop) continue;
    /* Si la jugada buena era la que hiciste, no hay nada que preguntar. */
    if (m.uci && m.uci === m.bestUci) continue;
    salida.push({
      id: `propio:${meta.gameId || 'x'}:${m.ply}`,
      fen: m.fenBefore,
      moves: [m.bestUci],
      rating: ratingFromDrop(m.perdidaWin, m.cpLoss),
      theme: 'propia',
      gain: Math.round(m.cpLoss || 0),
      played: m.san || null,
      bestSan: m.bestSan || null,
      from: { gameId: meta.gameId || null, ply: m.ply, opponent: meta.opponent || null },
    });
  }
  /* Los más caros primero: son los que más duele repetir. */
  salida.sort((a, b) => b.gain - a.gain);
  return salida;
}

/** Dificultad de un problema sacado de una partida propia. */
export function ratingFromDrop(winDrop = 0, cpLoss = 0) {
  const caida = Math.max(0, Number(winDrop) || 0);
  const coste = Math.max(0, Number(cpLoss) || 0);
  /* Cuanto más gorda fue la metida de pata, más fácil es verla desde fuera. */
  let r = 1500 - caida * 12 - Math.min(400, coste / 4);
  return Math.max(600, Math.min(2200, Math.round(r / 25) * 25));
}

/* ----------------------------- elegir el próximo ------------------------- */

/**
 * El siguiente problema: uno cerca de tu nivel, que no hayas resuelto hace
 * poco. `rng` entra por parámetro para que se pueda probar.
 */
export function pickPuzzle(pool = [], { rating = STARTING_PUZZLE_RATING, recent = [], rng = Math.random } = {}) {
  if (!pool.length) return null;
  const vistos = new Set(recent);
  let candidatos = pool.filter((p) => !vistos.has(p.id));
  if (!candidatos.length) candidatos = pool.slice();

  /* Una ventana alrededor de tu nivel, que se ensancha si no hay nada dentro. */
  for (const margen of [150, 300, 600, 1200, Infinity]) {
    const dentro = candidatos.filter((p) => Math.abs((p.rating || 1000) - rating) <= margen);
    if (dentro.length) {
      return dentro[Math.floor(rng() * dentro.length) % dentro.length];
    }
  }
  return candidatos[0];
}

/* ------------------------------ el resolutor ----------------------------- */

/**
 * Máquina de estados de un problema. No toca el tablero: le decís qué jugada
 * intentó la persona y te dice qué pasó y qué tiene que hacer el tablero.
 *
 *   crear  -> { expected, solved:false }
 *   tryMove(uci) -> {ok, solved, reply, expected, failed}
 *     ok:       la jugada era la buena
 *     reply:    lo que contesta el rival (uci), si queda línea
 *     solved:   ya no queda nada que hacer
 *     failed:   se falló (solo la primera vez cuenta para la puntuación)
 */
export function createSolver(puzzle) {
  const linea = Array.isArray(puzzle && puzzle.moves) ? puzzle.moves.slice() : [];
  let indice = 0;         // cuántas jugadas de la línea se han consumido
  let fallado = false;
  let acabado = linea.length === 0;

  return {
    puzzle,
    /** La jugada que toca acertar ahora. */
    expected: () => linea[indice] || null,
    solved: () => acabado,
    failed: () => fallado,
    /** Cuántas jugadas tuyas quedan. */
    remaining: () => Math.ceil(Math.max(0, linea.length - indice) / 2),

    tryMove(uci) {
      if (acabado) return { ok: false, solved: true, reply: null, failed: fallado };
      const esperada = linea[indice];
      if (!uci || uci !== esperada) {
        fallado = true;
        return { ok: false, solved: false, reply: null, failed: true, expected: esperada };
      }
      indice += 1;
      const reply = linea[indice] || null;
      if (reply) indice += 1;
      acabado = indice >= linea.length;
      return { ok: true, solved: acabado, reply, failed: fallado, expected: linea[indice] || null };
    },

    /** Rendirse: deja el problema por fallado y devuelve la línea entera. */
    giveUp() {
      fallado = true;
      acabado = true;
      return linea.slice();
    },
  };
}

/* ---------------------------- tu puntuación ------------------------------ */

/**
 * Cómo se mueve tu puntuación al resolver. Es el mismo Elo del resto de la
 * aplicación: el problema es el rival y su dificultad es su puntuación.
 */
export function ratePuzzleResult({ rating = STARTING_PUZZLE_RATING, puzzleRating = 1000, solved = false, solvedCount = 0 }) {
  const out = applyResult(rating, puzzleRating, solved ? 1 : 0, {
    gamesA: solvedCount,
    gamesB: 100,
    peakA: rating,
  });
  return { before: Math.round(rating), after: Math.round(out.a), delta: Math.round(out.deltaA) };
}

/** Resumen de una tanda, para enseñarlo al terminar. */
export function sessionSummary(entries = []) {
  const total = entries.length;
  const acertados = entries.filter((e) => e.solved).length;
  let mejorRacha = 0;
  let racha = 0;
  for (const e of entries) {
    if (e.solved) { racha += 1; mejorRacha = Math.max(mejorRacha, racha); } else racha = 0;
  }
  const delta = entries.reduce((suma, e) => suma + (e.delta || 0), 0);
  return {
    total,
    solved: acertados,
    failed: total - acertados,
    bestStreak: mejorRacha,
    delta,
    accuracy: total ? Math.round((acertados / total) * 100) : 0,
  };
}
