/**
 * ui/puzzles.js — entrenamiento táctico.
 *
 * Dos fuentes: el juego que viene con la aplicación, y —la que de verdad
 * importa— tus propias partidas. El informe ya sabe en qué jugada tiraste una
 * partida y cuál era la buena; esa posición, devuelta como problema, es la
 * única forma de entrenar exactamente lo que fallás vos.
 */

import { el, clear, button, card, chip, spinner, emptyState } from './components.js';
import { createBoard } from '../board.js';
import { createPosition, generateMoves, moveToUci, uciToMove, makeMove, getFen, moveToSan, gameResult } from '../chess.js';
import { PUZZLES } from '../puzzledata.js';
import {
  PUZZLE_THEMES, STARTING_PUZZLE_RATING, createSolver, pickPuzzle,
  ratePuzzleResult, sessionSummary, puzzlesFromReport,
} from '../puzzles.js';
import { recordPuzzle, loadGames } from '../storage.js';
import { buildReport, winPercentOf, isSacrifice } from '../report.js';
import { parsePgn } from '../pgn.js';

const ANALISIS = { depth: 16, timeMs: 700, multiPv: 2 };

function colorOf(fen) {
  return String(fen || '').split(' ')[1] === 'b' ? 'black' : 'white';
}

function sanOf(fen, uci) {
  try {
    const pos = createPosition(fen);
    const move = uciToMove(pos, uci);
    return move ? moveToSan(pos, move) : uci;
  } catch {
    return uci;
  }
}

function legalCountOf(fen) {
  try {
    return generateMoves(createPosition(fen), { legal: true }).length;
  } catch {
    return 0;
  }
}

export function mount(root, ctx, params = {}) {
  let destroyed = false;
  const profile = ctx.profile || {};
  const stats = profile.puzzles || {
    rating: STARTING_PUZZLE_RATING, solved: 0, failed: 0, bestStreak: 0, currentStreak: 0, recent: [],
  };

  let fuente = params.source === 'propias' ? 'propias' : 'juego';
  let pool = PUZZLES.slice();
  let problema = null;
  let solver = null;
  let resuelto = false;       // ya se cerró (acertado o no)
  let usoPista = false;
  const tanda = [];

  clear(root);
  const screen = el('div', { class: 'screen' });
  root.appendChild(screen);

  /* ------------------------------ cabecera ------------------------------ */

  const puntuacion = el('span', { class: 'mono strong', style: { fontSize: '20px' }, text: String(Math.round(stats.rating || STARTING_PUZZLE_RATING)) });
  const rachaTexto = el('span', { class: 'tiny faint', text: '' });

  screen.appendChild(el('div', { class: 'screen__head' },
    el('div', { class: 'col gap-4' },
      el('h1', { class: 'h1', text: 'Entrenamiento' }),
      el('p', { class: 'muted', text: 'Posiciones con una sola jugada buena. Las de tus partidas son las que de verdad te hacen falta.' })),
    el('div', { class: 'col gap-4', style: { textAlign: 'right' } },
      el('div', { class: 'row gap-6', style: { justifyContent: 'flex-end' } },
        puntuacion,
        el('span', { class: 'tiny faint', text: 'tu nivel' })),
      rachaTexto)));

  /* ------------------------------ pestañas ------------------------------ */

  const tabs = el('div', { class: 'chip-group', style: { marginBottom: '14px' } });
  const tabJuego = chip('Del juego', { active: fuente === 'juego', onClick: () => cambiarFuente('juego') });
  const tabPropias = chip('De tus partidas', { active: fuente === 'propias', onClick: () => cambiarFuente('propias') });
  tabs.appendChild(tabJuego);
  tabs.appendChild(tabPropias);
  screen.appendChild(tabs);

  /* ------------------------------- layout ------------------------------- */

  const layout = el('div', { class: 'game-layout' });
  const boardCol = el('div', { class: 'game-board-col no-eval' });
  const stack = el('div', { class: 'board-stack' });
  const boardHost = el('div');
  const panel = el('aside', { class: 'game-panel' });
  stack.appendChild(boardHost);
  boardCol.appendChild(stack);
  layout.appendChild(boardCol);
  layout.appendChild(panel);
  screen.appendChild(layout);

  const board = createBoard(boardHost, {
    orientation: 'white',
    pieceSet: ctx.settings?.pieceSet || 'clasico',
    theme: ctx.settings?.boardTheme || 'verde',
    coordinates: ctx.settings?.showCoordinates !== false,
    showLegal: ctx.settings?.showLegalMoves !== false,
    animationMs: ctx.settings?.animations === false ? 0 : 180,
    onMoveAttempt: intentar,
    onPromotion: () => Promise.resolve('q'),
  });

  /* ------------------------------- panel -------------------------------- */

  const temaChip = el('span', { class: 'chip', text: '' });
  const dificultad = el('span', { class: 'tiny faint', text: '' });
  const consigna = el('p', { class: 'strong', text: '' });
  const pista = el('p', { class: 'muted small', text: '' });
  const veredicto = el('p', { class: 'result-hero', text: '' });
  const origen = el('p', { class: 'tiny faint', text: '' });

  const botonPista = button('Pista', { size: 'sm', onClick: darPista });
  const botonSolucion = button('Ver la solución', { size: 'sm', onClick: rendirse });
  const botonSiguiente = button('Siguiente', { variant: 'primary', onClick: siguiente });
  const controles = el('div', { class: 'game-controls' }, botonPista, botonSolucion, botonSiguiente);

  panel.appendChild(card('El problema',
    el('div', { class: 'row row--wrap gap-6', style: { marginBottom: '8px' } }, temaChip, dificultad),
    consigna, pista, veredicto, origen, controles));

  const resumenCuerpo = el('div', { class: 'col gap-6' });
  const resumenCard = card('Esta tanda', resumenCuerpo);
  resumenCard.classList.add('hidden');
  panel.appendChild(resumenCard);

  const aviso = el('div', { class: 'col gap-16' });
  const avisoCard = card('De tus partidas', aviso);
  avisoCard.classList.add('hidden');
  panel.appendChild(avisoCard);

  /* ------------------------------ acciones ------------------------------ */

  function pintarCabecera() {
    puntuacion.textContent = String(Math.round(stats.rating || STARTING_PUZZLE_RATING));
    const r = stats.currentStreak || 0;
    rachaTexto.textContent = r > 1
      ? `${r} seguidos · ${stats.solved || 0} resueltos`
      : `${stats.solved || 0} resueltos · ${stats.failed || 0} fallados`;
  }

  function pintarResumen() {
    const s = sessionSummary(tanda);
    if (!s.total) { resumenCard.classList.add('hidden'); return; }
    resumenCard.classList.remove('hidden');
    clear(resumenCuerpo);
    resumenCuerpo.appendChild(el('div', { class: 'row row--wrap gap-6' },
      el('span', { class: 'strong', text: `${s.solved} de ${s.total}` }),
      el('span', { class: 'tiny faint', text: `· ${s.accuracy} % de acierto` }),
      el('span', { class: 'tiny faint', text: s.bestStreak > 1 ? `· mejor racha ${s.bestStreak}` : '' }),
      el('span', { class: 'tiny faint', text: `· ${s.delta >= 0 ? '+' : ''}${s.delta} de puntuación` })));
  }

  function cargar(p) {
    problema = p;
    solver = createSolver(p);
    resuelto = false;
    usoPista = false;

    board.clearArrows();
    board.setPosition(p.fen, { animate: false });
    board.setOrientation(colorOf(p.fen));
    board.setInteractive(true);

    const tema = PUZZLE_THEMES[p.theme] || PUZZLE_THEMES.ventaja;
    temaChip.textContent = tema.label;
    dificultad.textContent = `dificultad ${p.rating}`;
    consigna.textContent = colorOf(p.fen) === 'white' ? 'Juegan las blancas.' : 'Juegan las negras.';
    pista.textContent = tema.hint;
    veredicto.textContent = '';
    origen.textContent = p.from
      ? `De tu partida contra ${p.from.opponent || 'alguien'}, jugada ${Math.ceil(p.from.ply / 2)}. Jugaste ${p.played || '—'}.`
      : '';
    botonPista.disabled = false;
    botonSolucion.disabled = false;
    pintarCabecera();
  }

  /** La persona intentó una jugada. Devuelve true si el tablero debe aceptarla. */
  function intentar(from, to, promotion) {
    if (!solver || resuelto) return false;
    const uci = from + to + (promotion || '');
    const res = solver.tryMove(uci);

    if (!res.ok) {
      veredicto.textContent = 'No. Esa no es.';
      board.shake?.(from);
      cerrar(false);
      return false;
    }

    /* La jugada buena: se aplica y contesta el rival. */
    aplicar(uci);
    if (res.reply) {
      setTimeout(() => {
        if (destroyed || problema !== solver.puzzle) return;
        aplicar(res.reply);
        if (solver.solved()) cerrar(true);
        else veredicto.textContent = 'Bien. Seguí.';
      }, 420);
    } else if (res.solved) {
      cerrar(true);
    }
    return true;
  }

  function aplicar(uci) {
    const fen = board.getFen();
    const pos = createPosition(fen);
    const move = uciToMove(pos, uci);
    if (!move) return;
    makeMove(pos, move);
    board.setPosition(getFen(pos), { animate: true, lastMove: [uci.slice(0, 2), uci.slice(2, 4)] });
  }

  function cerrar(acertado) {
    if (resuelto) return;
    resuelto = true;
    board.setInteractive(false);
    botonPista.disabled = true;
    botonSolucion.disabled = true;

    /* Con pista el problema cuenta como visto, pero no sube la puntuación. */
    const cuenta = !usoPista;
    let delta = 0;
    if (cuenta) {
      const r = ratePuzzleResult({
        rating: stats.rating || STARTING_PUZZLE_RATING,
        puzzleRating: problema.rating || 1000,
        solved: acertado,
        solvedCount: (stats.solved || 0) + (stats.failed || 0),
      });
      delta = r.delta;
      stats.rating = r.after;
    }
    if (acertado) {
      stats.solved = (stats.solved || 0) + 1;
      stats.currentStreak = (stats.currentStreak || 0) + 1;
      stats.bestStreak = Math.max(stats.bestStreak || 0, stats.currentStreak);
      veredicto.textContent = usoPista ? 'Resuelto, con pista.' : `¡Resuelto! ${delta >= 0 ? '+' : ''}${delta}`;
      ctx.sound?.play?.('win');
    } else {
      stats.failed = (stats.failed || 0) + 1;
      stats.currentStreak = 0;
      veredicto.textContent = `La buena era ${sanOf(problema.fen, problema.moves[0])}. ${delta}`;
      ctx.sound?.play?.('lose');
      board.drawArrow(problema.moves[0].slice(0, 2), problema.moves[0].slice(2, 4), 'var(--accent)');
    }

    try {
      const actualizado = recordPuzzle({
        id: problema.id, solved: acertado, theme: problema.theme,
        rating: stats.rating, delta,
      });
      if (actualizado?.puzzles) Object.assign(stats, actualizado.puzzles);
      if (ctx.profile) ctx.profile.puzzles = { ...stats };
    } catch {
      /* Sin almacenamiento el entrenamiento sigue funcionando en memoria. */
    }

    tanda.push({ id: problema.id, solved: acertado, delta });
    pintarCabecera();
    pintarResumen();
  }

  function darPista() {
    if (!solver || resuelto) return;
    usoPista = true;
    const esperada = solver.expected();
    if (!esperada) return;
    board.drawArrow(esperada.slice(0, 2), esperada.slice(0, 2), 'var(--accent)', 0.3);
    pista.textContent = `Mueve la pieza de ${esperada.slice(0, 2)}.`;
    botonPista.disabled = true;
  }

  function rendirse() {
    if (!solver || resuelto) return;
    const linea = solver.giveUp();
    veredicto.textContent = `Era ${sanOf(problema.fen, linea[0])}.`;
    board.drawArrow(linea[0].slice(0, 2), linea[0].slice(2, 4), 'var(--accent)');
    usoPista = false;
    cerrar(false);
  }

  function siguiente() {
    const p = pickPuzzle(pool, { rating: stats.rating || STARTING_PUZZLE_RATING, recent: stats.recent || [] });
    if (!p) {
      veredicto.textContent = 'No quedan problemas de esta fuente.';
      return;
    }
    cargar(p);
  }

  /* --------------------------- de tus partidas --------------------------- */

  function cambiarFuente(cual) {
    if (fuente === cual) return;
    fuente = cual;
    tabJuego.classList.toggle('is-active', fuente === 'juego');
    tabPropias.classList.toggle('is-active', fuente === 'propias');
    if (fuente === 'juego') {
      avisoCard.classList.add('hidden');
      pool = PUZZLES.slice();
      siguiente();
      return;
    }
    prepararPropias();
  }

  async function prepararPropias() {
    avisoCard.classList.remove('hidden');
    clear(aviso);
    const partidas = loadGames(12).filter((g) => typeof g.pgn === 'string' && g.pgn.length > 20);
    if (!partidas.length) {
      aviso.appendChild(emptyState(
        'Todavía no hay partidas tuyas guardadas. Jugá una contra un bot o por internet y volvé: los errores que cometas se convierten en problemas.'));
      return;
    }

    const progreso = el('p', { class: 'small muted', text: 'Repasando tus partidas con el motor…' });
    aviso.appendChild(el('div', { class: 'row gap-6' }, spinner(20), progreso));

    const encontrados = [];
    for (let i = 0; i < partidas.length && encontrados.length < 25; i++) {
      if (destroyed) return;
      progreso.textContent = `Repasando tus partidas… ${i + 1} de ${partidas.length}`;
      try {
        const nuevos = await problemasDePartida(partidas[i]);
        encontrados.push(...nuevos);
      } catch {
        /* Una partida que falle no corta el repaso. */
      }
    }
    if (destroyed) return;

    clear(aviso);
    if (!encontrados.length) {
      aviso.appendChild(emptyState(
        'No encontré errores gordos en tus partidas guardadas: ninguna jugada tiró la partida. Jugá alguna más y vuelvo a mirar.'));
      return;
    }
    aviso.appendChild(el('p', { class: 'small muted', text: `${encontrados.length} posiciones donde te equivocaste. Cada una tiene una jugada mejor.` }));
    pool = encontrados;
    siguiente();
  }

  /** Repasa una partida guardada y saca sus errores como problemas. */
  async function problemasDePartida(registro) {
    /* De la partida se guarda el PGN, no la lista de jugadas. */
    let sans = [];
    try {
      sans = parsePgn(registro.pgn).sanMoves || [];
    } catch {
      return [];
    }
    const pos = createPosition();
    const linea = [];
    for (const san of sans) {
      const fenBefore = getFen(pos);
      let move = null;
      try {
        const legales = generateMoves(pos, { legal: true });
        move = legales.find((m) => moveToSan(pos, m) === san) || null;
      } catch {
        move = null;
      }
      if (!move) break;
      const uci = moveToUci(move);
      makeMove(pos, move);
      linea.push({ san, uci, fenBefore, fenAfter: getFen(pos), color: fenBefore.split(' ')[1] === 'b' ? 'b' : 'w' });
    }
    if (linea.length < 6) return [];

    /* Una evaluación por posición, repartida entre los workers. */
    const fens = [...linea.map((m) => m.fenBefore), linea[linea.length - 1].fenAfter];
    const evals = new Array(fens.length).fill(null);
    const hilos = Math.max(1, Math.min(4, ctx.ai.poolSize ? ctx.ai.poolSize() : 1));
    let siguienteIndice = 0;

    async function trabajador() {
      for (;;) {
        const i = siguienteIndice++;
        if (i >= fens.length || destroyed) return;
        if (gameResult(createPosition(fens[i])).over) continue;
        try {
          const a = await ctx.ai.analyze({ fen: fens[i], ...ANALISIS });
          const mejor = a?.lines?.[0];
          if (mejor) {
            evals[i] = {
              cp: typeof mejor.score === 'number' ? mejor.score : 0,
              mate: mejor.mate ?? null,
              bestUci: mejor.uci || null,
              bestSan: mejor.san || null,
            };
          }
        } catch {
          /* posición sin evaluar: su jugada no dará problema y ya está */
        }
      }
    }
    await Promise.all(Array.from({ length: hilos }, () => trabajador()));
    if (destroyed) return [];

    const hechos = [];
    for (let i = 0; i < linea.length; i++) {
      const antes = evals[i];
      const despues = evals[i + 1];
      if (!antes || !despues) continue;
      const winBefore = winPercentOf(antes);
      const winAfter = 100 - winPercentOf(despues);
      hechos.push({
        ...linea[i],
        winBefore, winAfter,
        bestUci: antes.bestUci, bestSan: antes.bestSan,
        legalCount: legalCountOf(linea[i].fenBefore),
        sacrifice: isSacrifice(linea[i].fenBefore, linea[i].fenAfter, linea[i].color),
        cpLoss: Math.max(0, (antes.cp || 0) - (-(despues.cp || 0))),
      });
    }

    const informe = buildReport(hechos);
    /* Solo los errores del lado que jugó la persona. */
    const miColor = registro.myColor === 'b' ? 'b' : 'w';
    const mios = informe.moves.filter((m) => m.color === miColor);
    return puzzlesFromReport(mios, {
      gameId: registro.id,
      opponent: registro.opponent?.name || null,
    });
  }

  /* ------------------------------- arranque ------------------------------ */

  pintarCabecera();
  if (fuente === 'propias') prepararPropias();
  else siguiente();

  return {
    unmount() {
      destroyed = true;
      try { ctx.ai?.stop?.(); } catch { /* el motor ya estaba parado */ }
      board.destroy();
      clear(root);
    },
  };
}
