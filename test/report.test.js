/**
 * report.test.js — el informe de partida.
 * Lo que se comprueba aquí no es que salgan números bonitos, sino la idea que
 * hace que los veredictos se parezcan a los de una web de ajedrez: se juzga en
 * probabilidad de ganar, no en centipeones. Con umbrales fijos en centipeones,
 * perder 100 cp con la partida ganada y perderlos con la partida igualada
 * salían iguales, y son cosas distintas.
 */

import { test, assert, assertEqual, assertClose, run } from './harness.js';
import {
  winPercent, winPercentOf, classifyMove, moveAccuracy, gameAccuracy,
  estimateRating, isSacrifice, buildReport, phaseOf, heavyMaterial, MOVE_CLASSES,
} from '../web/js/report.js';

/* -------------------------- probabilidad de ganar ------------------------ */

test('la igualdad es el 50 % y la ventaja sube con sentido', () => {
  assertClose(winPercent(0), 50, 1e-9, 'una posición igualada');
  assert(winPercent(100) > 55 && winPercent(100) < 65, 'un peón de más ronda el 60 %, y da ' + winPercent(100).toFixed(1));
  assert(winPercent(900) > 93, 'una dama de más es casi ganada, y da ' + winPercent(900).toFixed(1));
  assert(winPercent(5000) <= 100 && winPercent(-5000) >= 0, 'nunca se sale de la escala');
});

test('lo que gana uno lo pierde el otro', () => {
  for (const cp of [0, 35, 120, 400, 1200]) {
    assertClose(winPercent(cp) + winPercent(-cp), 100, 1e-6, 'en ' + cp + ' cp');
  }
});

test('un mate no pasa por la logística', () => {
  assertEqual(winPercentOf({ cp: 0, mate: 3 }), 100, 'dar mate es ganado');
  assertEqual(winPercentOf({ cp: 0, mate: -2 }), 0, 'recibirlo es perdido');
});

/* ----------------------------- clasificación ----------------------------- */

test('perder lo mismo pesa distinto según cómo esté la partida', () => {
  /* El caso que lo resume: los mismos 100 centipeones. */
  const ganando = classifyMove({
    winBefore: winPercent(900), winAfter: winPercent(800), playedUci: 'a1a2', bestUci: 'b1b2',
  });
  const igualada = classifyMove({
    winBefore: winPercent(0), winAfter: winPercent(-100), playedUci: 'a1a2', bestUci: 'b1b2',
  });
  assert(MOVE_CLASSES[ganando].weight < MOVE_CLASSES[igualada].weight,
    `con la partida ganada eso no es grave (${ganando}) y con la partida igualada sí (${igualada})`);
  assertEqual(ganando, 'excellent', 'soltar 100 cp desde +9 casi no cambia nada');
});

test('tirar la partida se llama error grave', () => {
  const clase = classifyMove({
    winBefore: winPercent(50), winAfter: winPercent(-600), playedUci: 'a1a2', bestUci: 'b1b2',
  });
  assertEqual(clase, 'blunder');
});

test('la mejor jugada se reconoce, y la única que valía también', () => {
  assertEqual(classifyMove({ winBefore: 50, winAfter: 50, playedUci: 'e2e4', bestUci: 'e2e4' }), 'best');
  assertEqual(classifyMove({
    winBefore: 60, winAfter: 58, playedUci: 'e2e4', bestUci: 'e2e4', secondWin: 20,
  }), 'great', 'si la segunda mejor era mucho peor, la jugada era la única');
});

test('un sacrificio que además es lo mejor es brillante, y regalar material no', () => {
  assertEqual(classifyMove({
    winBefore: 60, winAfter: 72, playedUci: 'd5e6', bestUci: 'd5e6', sacrifice: true,
  }), 'brilliant');
  assertEqual(classifyMove({
    winBefore: 10, winAfter: 8, playedUci: 'd5e6', bestUci: 'd5e6', sacrifice: true,
  }), 'best', 'entregar una pieza en una posición perdida no es brillante');
});

test('sin alternativa no hay mérito ni culpa', () => {
  assertEqual(classifyMove({ winBefore: 80, winAfter: 5, legalCount: 1 }), 'forced',
    'la única legal no se juzga por mucho que empeore');
  assertEqual(classifyMove({ winBefore: 50, winAfter: 44, inBook: true }), 'book');
});

/* ------------------------------- precisión ------------------------------- */

test('la precisión de una jugada baja con lo que cuesta', () => {
  assertClose(moveAccuracy(50, 50), 100, 0.1, 'no costar nada es el 100 %');
  assert(moveAccuracy(50, 40) < 70 && moveAccuracy(50, 40) > 55,
    'diez puntos de caída rondan el 65 %, y dan ' + moveAccuracy(50, 40).toFixed(1));
  assert(moveAccuracy(50, 10) < 25, 'cuarenta puntos es un desastre');
});

test('una pifia entre jugadas perfectas se nota, pero no lo tapa todo', () => {
  const perfectas = Array.from({ length: 30 }, () => 100);
  const conPifia = [...perfectas.slice(0, 29), 5];
  const limpia = gameAccuracy(perfectas);
  const manchada = gameAccuracy(conPifia);
  assertClose(limpia, 100, 0.5, 'treinta jugadas perfectas son el 100 %');
  assert(manchada < limpia - 5, 'una pifia tiene que bajar la nota, y bajó a ' + manchada.toFixed(1));
  assert(manchada > 55, 'pero no convierte la partida en un desastre: ' + manchada.toFixed(1));
});

test('el nivel estimado se mueve en el rango de los bots', () => {
  const flojo = estimateRating(45, 180);
  const fuerte = estimateRating(96, 12);
  assert(flojo >= 250 && flojo <= 1200, 'una partida floja no da 2500: ' + flojo);
  assert(fuerte > flojo + 800, 'y una buena tiene que quedar muy por encima: ' + fuerte);
  assert(fuerte <= 2900, 'sin pasarse del techo');
});

/* -------------------------------- material ------------------------------- */

test('el material pesado se lee del FEN y marca la fase', () => {
  assertEqual(heavyMaterial('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'), 62,
    'dos juegos completos sin peones son 31 + 31');
  assertEqual(phaseOf(40, '8/5k2/8/8/8/8/5K2/8 w - - 0 40'), 'final', 'reyes solos es final');
  assertEqual(phaseOf(4, 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'), 'apertura');
});

test('se ve cuándo una jugada entrega material', () => {
  const antes = 'r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4';
  /* Blancas dejan el alfiller de c4 por nada: menos material propio, igual el del rival. */
  const despues = 'r1bqkb1r/pppp1ppp/2n2n2/4p3/4P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 0 4';
  assert(isSacrifice(antes, despues, 'w'), 'perder un alfil sin compensación es un sacrificio');
  assert(!isSacrifice(antes, antes, 'w'), 'no mover material no lo es');
});

/* -------------------------------- informe -------------------------------- */

test('el informe reparte las jugadas por bando y saca una nota de cada uno', () => {
  const jugadas = [
    { san: 'e4', uci: 'e2e4', color: 'w', fenBefore: 'x w x', winBefore: 52, winAfter: 52, bestUci: 'e2e4', legalCount: 20 },
    { san: 'e5', uci: 'e7e5', color: 'b', fenBefore: 'x b x', winBefore: 48, winAfter: 48, bestUci: 'e7e5', legalCount: 20 },
    { san: 'Qh5', uci: 'd1h5', color: 'w', fenBefore: 'x w x', winBefore: 52, winAfter: 20, bestUci: 'g1f3', legalCount: 29 },
  ];
  const informe = buildReport(jugadas);
  assertEqual(informe.moves.length, 3);
  assertEqual(informe.white.moves, 2, 'dos jugadas de las blancas medidas');
  assertEqual(informe.black.moves, 1);
  assert(informe.white.accuracy < informe.black.accuracy,
    'las blancas tiraron la partida, su nota tiene que ser peor');
  assertEqual(informe.moves[2].clase, 'blunder');
  assertEqual(informe.keyMoments.length, 1, 'ese error es el momento que decidió');
  assertEqual(informe.keyMoments[0].san, 'Qh5');
});

test('las jugadas de libro no le suben ni le bajan la nota a nadie', () => {
  const jugadas = [
    { san: 'e4', uci: 'e2e4', color: 'w', fenBefore: 'x w x', winBefore: 52, winAfter: 40, inBook: true, legalCount: 20 },
  ];
  const informe = buildReport(jugadas);
  assertEqual(informe.white.moves, 0, 'no cuenta como jugada medida');
  assertEqual(informe.white.accuracy, null, 'y sin jugadas propias no hay nota');
  assertEqual(informe.moves[0].clase, 'book');
});

run('report.js');
