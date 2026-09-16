/**
 * report.js — el informe de una partida: cuánto costó cada jugada, qué nombre
 * merece, cuánta precisión tuvo cada bando y qué momentos decidieron.
 *
 * La idea central, y la que hace que los veredictos se parezcan a los de una
 * web de ajedrez de verdad: NO se juzga en centipeones, se juzga en
 * probabilidad de ganar. Perder 100 centipeones con +9 de ventaja no cambia
 * nada; perderlos en una posición igualada cambia la partida. Un umbral fijo
 * en centipeones trata esos dos casos igual, y por eso el análisis anterior
 * llamaba «error grave» a jugadas que no cambiaban nada y «buena» a las que
 * tiraban la partida.
 *
 * Sin DOM y sin estado: se puede probar entera desde Node.
 */

/* ------------------------- probabilidad de ganar ------------------------- */

/**
 * De centipeones a probabilidad de ganar (0..100) desde el bando que mueve.
 * La constante es la logística que usa Lichess, ajustada sobre millones de
 * partidas: +100 cp ≈ 59,3 %, +300 cp ≈ 75,6 %, +900 cp ≈ 96,4 %.
 */
export function winPercent(cp) {
  const acotado = Math.max(-2000, Math.min(2000, Number(cp) || 0));
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * acotado)) - 1);
}

/** Un mate a favor es 100 y en contra 0, sin pasar por la logística. */
export function winPercentOf({ cp = 0, mate = null } = {}) {
  if (mate !== null && mate !== undefined) return mate > 0 ? 100 : 0;
  return winPercent(cp);
}

/* ---------------------------- clasificación ------------------------------ */

export const MOVE_CLASSES = Object.freeze({
  brilliant: { label: 'Brillante', glyph: '!!', color: '#1baca6', weight: 0 },
  great: { label: 'Genial', glyph: '!', color: '#5c8bb0', weight: 1 },
  best: { label: 'La mejor', glyph: '★', color: '#81b64c', weight: 2 },
  excellent: { label: 'Excelente', glyph: '✓', color: '#81b64c', weight: 3 },
  good: { label: 'Buena', glyph: '·', color: '#95b776', weight: 4 },
  book: { label: 'De libro', glyph: '📖', color: '#a88865', weight: 5 },
  forced: { label: 'Forzada', glyph: '=', color: '#8b8987', weight: 6 },
  inaccuracy: { label: 'Imprecisión', glyph: '?!', color: '#f7c631', weight: 7 },
  mistake: { label: 'Error', glyph: '?', color: '#ffa459', weight: 8 },
  blunder: { label: 'Error grave', glyph: '??', color: '#fa412d', weight: 9 },
});

/** Las que conviene repasar, en el orden en que duelen. */
export const CLASSES_TO_REVIEW = Object.freeze(['blunder', 'mistake', 'inaccuracy']);

/* Cuánta probabilidad de ganar se puede perder en cada categoría, en puntos
   porcentuales. Son los saltos que de verdad se notan jugando. */
const UMBRALES = [
  ['excellent', 2],
  ['good', 5],
  ['inaccuracy', 10],
  ['mistake', 20],
];

/**
 * Nombre de una jugada.
 *
 * @param {object} d
 *   winBefore     probabilidad de ganar del que mueve, antes
 *   winAfter      la misma, después de su jugada (ya girada a su bando)
 *   playedUci     la jugada jugada
 *   bestUci       la que decía el motor
 *   secondWin     probabilidad de ganar de la segunda mejor, si se sabe
 *   legalCount    jugadas legales que había
 *   sacrifice     true si la jugada entrega material de verdad
 *   inBook        true si sigue el libro de aperturas
 *   winning       probabilidad de ganar tras la jugada, para exigir que un
 *                 sacrificio brillante siga siendo bueno
 */
export function classifyMove(d = {}) {
  const {
    winBefore = 50, winAfter = 50, bestUci = null,
    secondWin = null, legalCount = 0, sacrifice = false, inBook = false,
  } = d;
  /* `uci` vale igual que `playedUci`: los hechos de una jugada la llaman de la
     primera forma en todo el resto del programa, y pedirla con otro nombre ya
     hizo que la lista de jugadas no reconociera ni una sola «la mejor». */
  const playedUci = d.playedUci || d.uci || null;

  if (legalCount === 1) return 'forced';
  if (inBook) return 'book';

  const caida = Math.max(0, winBefore - winAfter);
  const fueLaMejor = !!playedUci && !!bestUci && playedUci === bestUci;

  if (fueLaMejor) {
    /* Brillante es un sacrificio que además es lo mejor del tablero y deja la
       posición buena. Sin la última condición, entregar una pieza en una
       posición perdida también contaría, y eso no es brillante. */
    if (sacrifice && winAfter >= 50) return 'brilliant';
    /* Genial: la única que mantenía la posición. Hace falta saber cuánto valía
       la segunda para poder decirlo. */
    if (secondWin !== null && winAfter - secondWin >= 10) return 'great';
    return 'best';
  }

  for (const [nombre, tope] of UMBRALES) {
    if (caida < tope) return nombre;
  }
  return 'blunder';
}

/* ------------------------------ precisión -------------------------------- */

/**
 * Precisión de UNA jugada (0..100) a partir de lo que costó en probabilidad
 * de ganar. Perder 0 puntos es 100; perder 10 ronda el 65; perder 30, el 25.
 */
export function moveAccuracy(winBefore, winAfter) {
  const caida = Math.max(0, (Number(winBefore) || 0) - (Number(winAfter) || 0));
  const valor = 103.1668 * Math.exp(-0.04354 * caida) - 3.1669;
  return Math.max(0, Math.min(100, valor));
}

/** Media armónica: castiga los ceros, que es justo lo que hace una pifia. */
function mediaArmonica(valores) {
  if (!valores.length) return 0;
  let suma = 0;
  for (const v of valores) suma += 1 / Math.max(1, v);
  return valores.length / suma;
}

function media(valores) {
  if (!valores.length) return 0;
  return valores.reduce((a, b) => a + b, 0) / valores.length;
}

/**
 * Precisión de una partida entera. La media sola premia al que hizo treinta
 * jugadas obvias y una pifia; la armónica sola castiga demasiado. Se usan las
 * dos a medias, que es lo que mejor se parece a como lo cuenta la gente.
 */
export function gameAccuracy(precisiones) {
  if (!precisiones || !precisiones.length) return null;
  return Math.max(0, Math.min(100, (media(precisiones) + mediaArmonica(precisiones)) / 2));
}

/**
 * Elo aproximado a partir de la precisión y del coste medio en centipeones.
 * No es una medición, es una orientación: se dice así en el informe.
 */
export function estimateRating(accuracy, acpl) {
  if (accuracy === null || accuracy === undefined) return null;
  const porPrecision = 250 + (accuracy - 40) * 38;
  const porCoste = 2900 - Math.max(0, Number(acpl) || 0) * 18;
  const mezcla = (porPrecision * 0.6) + (porCoste * 0.4);
  return Math.max(250, Math.min(2900, Math.round(mezcla / 25) * 25));
}

/**
 * Precisión de un bando en una partida en vivo, a partir de las evaluaciones
 * por ply: `evals[p]` es la evaluación en centipeones, desde las blancas,
 * DESPUÉS del ply p, y `evals[0]` es la posición inicial.
 *
 * Los huecos se saltan a propósito. Las evaluaciones llegan del motor de forma
 * asíncrona y algunas se descartan por el camino, así que la lista tiene
 * agujeros: contar por posición en la lista en vez de por ply emparejaba cada
 * jugada con la del rival, y el resumen te daba SU precisión con tu nombre.
 */
export function accuracyFromPlyEvals(evals = [], myColor = 'w') {
  const mia = myColor === 'b' ? -1 : 1;
  const precisiones = [];
  for (let ply = 1; ply < evals.length; ply++) {
    /* El ply 1 lo juegan las blancas, el 2 las negras, y así. */
    const fueMia = (ply % 2 === 1) === (myColor !== 'b');
    if (!fueMia) continue;
    const antes = evals[ply - 1];
    const despues = evals[ply];
    if (!Number.isFinite(antes) || !Number.isFinite(despues)) continue;
    precisiones.push(moveAccuracy(winPercent(antes * mia), winPercent(despues * mia)));
  }
  return precisiones.length >= 2 ? gameAccuracy(precisiones) : null;
}

/* -------------------------------- fases ---------------------------------- */

const VALOR_PIEZA = { p: 1, n: 3, b: 3, r: 5, q: 9 };

/** Material no peón que queda en el tablero, leído del FEN. */
export function heavyMaterial(fen) {
  const piezas = String(fen || '').split(' ')[0];
  let total = 0;
  for (const c of piezas) {
    const bajo = c.toLowerCase();
    if (bajo === 'p' || !VALOR_PIEZA[bajo]) continue;
    total += VALOR_PIEZA[bajo];
  }
  return total;
}

/** apertura | medio | final, con el criterio de siempre: queda poco material. */
export function phaseOf(ply, fen, lastBookPly = 0) {
  if (ply <= lastBookPly) return 'apertura';
  const material = heavyMaterial(fen);
  if (material <= 20) return 'final';
  if (ply < 20) return 'apertura';
  return 'medio';
}

export const PHASE_LABEL = Object.freeze({ apertura: 'Apertura', medio: 'Medio juego', final: 'Final' });

/* ------------------------------- el informe ------------------------------ */

/**
 * Arma el informe completo.
 *
 * @param {object[]} moves  una entrada por jugada, en orden:
 *   {san, uci, color:'w'|'b', fenBefore, fenAfter, legalCount,
 *    winBefore, winAfter, bestUci, bestSan, secondWin, sacrifice, inBook}
 *   winBefore/winAfter ya vienen desde el bando que mueve.
 */
export function buildReport(moves = []) {
  const entradas = [];
  const porBando = {
    w: { precisiones: [], perdidas: [], clases: {}, fases: {} },
    b: { precisiones: [], perdidas: [], clases: {}, fases: {} },
  };

  let ultimoLibro = 0;
  for (let i = 0; i < moves.length; i++) {
    const m = moves[i] || {};
    if (m.inBook) ultimoLibro = i + 1;
  }

  for (let i = 0; i < moves.length; i++) {
    const m = moves[i] || {};
    const color = m.color === 'b' ? 'b' : 'w';
    const winBefore = Number.isFinite(m.winBefore) ? m.winBefore : 50;
    const winAfter = Number.isFinite(m.winAfter) ? m.winAfter : winBefore;
    const clase = classifyMove({
      winBefore, winAfter,
      playedUci: m.uci, bestUci: m.bestUci,
      secondWin: Number.isFinite(m.secondWin) ? m.secondWin : null,
      legalCount: m.legalCount || 0,
      sacrifice: !!m.sacrifice,
      inBook: !!m.inBook,
    });
    const precision = moveAccuracy(winBefore, winAfter);
    const perdidaWin = Math.max(0, winBefore - winAfter);
    const fase = phaseOf(i + 1, m.fenBefore, ultimoLibro);

    const lado = porBando[color];
    /* Las de libro no miden a nadie: son la teoría, no el jugador. */
    if (!m.inBook) {
      lado.precisiones.push(precision);
      lado.perdidas.push(Number.isFinite(m.cpLoss) ? Math.max(0, m.cpLoss) : perdidaWin * 8);
      lado.fases[fase] = lado.fases[fase] || [];
      lado.fases[fase].push(precision);
    }
    lado.clases[clase] = (lado.clases[clase] || 0) + 1;

    entradas.push({
      /* El ply lo manda quien arma los hechos: la lista que llega aquí puede
         venir filtrada —una posición que el motor no llegó a evaluar— y
         numerar por posición en el array corría todas las jugadas siguientes.
         Se notaba en los «momentos que decidieron»: decían una jugada y al
         pulsarlas llevaban a otra. */
      ply: Number.isFinite(m.ply) ? m.ply : i + 1,
      san: m.san || '', uci: m.uci || null, color,
      /* La posicion viaja con la jugada: de ahi salen los problemas de
         entrenamiento, y buscarla luego por el SAN no era de fiar. */
      fenBefore: m.fenBefore || null, fenAfter: m.fenAfter || null,
      clase, precision, winBefore, winAfter, perdidaWin, fase,
      bestUci: m.bestUci || null, bestSan: m.bestSan || null,
      cpLoss: Number.isFinite(m.cpLoss) ? Math.max(0, m.cpLoss) : null,
    });
  }

  const resumen = {};
  for (const color of ['w', 'b']) {
    const lado = porBando[color];
    const accuracy = gameAccuracy(lado.precisiones);
    const acpl = lado.perdidas.length ? media(lado.perdidas) : 0;
    const fases = {};
    for (const [nombre, valores] of Object.entries(lado.fases)) {
      fases[nombre] = gameAccuracy(valores);
    }
    resumen[color] = {
      accuracy,
      acpl: Math.round(acpl),
      rating: estimateRating(accuracy, acpl),
      classes: lado.clases,
      phases: fases,
      moves: lado.precisiones.length,
    };
  }

  /* Los momentos que decidieron: las caídas mas grandes, una por jugada. */
  const momentos = entradas
    .filter((e) => e.clase === 'blunder' || e.clase === 'mistake')
    .sort((a, b) => b.perdidaWin - a.perdidaWin)
    .slice(0, 5);

  return { moves: entradas, white: resumen.w, black: resumen.b, keyMoments: momentos };
}

/**
 * ¿La jugada entrega material? Comparación simple de material por FEN: si
 * después de la jugada el que movió tiene menos que antes, y no fue una
 * captura que lo compense, hay sacrificio. Basta para marcar brillantes.
 */
export function isSacrifice(fenBefore, fenAfter, color) {
  const cuenta = (fen) => {
    const piezas = String(fen || '').split(' ')[0];
    let blancas = 0, negras = 0;
    for (const c of piezas) {
      const v = VALOR_PIEZA[c.toLowerCase()];
      if (!v) continue;
      if (c === c.toUpperCase()) blancas += v;
      else negras += v;
    }
    return { w: blancas, b: negras };
  };
  const antes = cuenta(fenBefore);
  const despues = cuenta(fenAfter);
  const rival = color === 'w' ? 'b' : 'w';
  const mio = despues[color] - antes[color];
  const suyo = despues[rival] - antes[rival];
  /* Perder al menos una pieza menor de saldo. */
  return (mio - suyo) <= -2;
}
