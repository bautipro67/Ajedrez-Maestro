/**
 * game.test.js — la partida como sesión: game.js.
 *
 * Existe por un fallo que estuvo ahí sin que nadie lo viera: la pantalla leía
 * `entry.color` de cada jugada y el campo se llama `entry.by`. Como el nombre
 * equivocado da `undefined`, el reloj se apretaba SIEMPRE como si hubieran
 * movido las negras: el incremento iba al jugador que no era y el tiempo corría
 * en el bando que acababa de mover. En toda partida con reloj contra un bot, en
 * local y en los torneos.
 *
 * De ahí que lo que se prueba aquí sea, sobre todo, el contrato: qué campos
 * trae una jugada y cómo se llaman.
 */

import { test, assert, assertEqual, run } from './harness.js';
import { createGame } from '../web/js/game.js';

/* ----------------------------- el contrato ------------------------------- */

test('cada jugada dice quién la hizo, y el campo se llama «by»', () => {
  const partida = createGame({ mode: 'local' });
  const blancas = partida.playUci('e2e4');
  assert(blancas && blancas.ok !== false, 'la jugada entra');
  assertEqual(blancas.entry.by, 'w', 'la primera la juegan las blancas');
  assertEqual(blancas.entry.color, undefined,
    'no hay campo «color»: quien lo lea se lleva undefined y lo tratará como negras');

  const negras = partida.playUci('e7e5');
  assertEqual(negras.entry.by, 'b');
});

test('una jugada trae lo que la pantalla necesita para pintarla', () => {
  const partida = createGame({ mode: 'local' });
  const { entry } = partida.playUci('e2e4');
  for (const campo of ['uci', 'san', 'fenBefore', 'fenAfter', 'by']) {
    assert(entry[campo] !== undefined, 'falta el campo ' + campo);
  }
  assertEqual(entry.uci, 'e2e4');
  assertEqual(entry.san, 'e4');
  assertEqual(typeof entry.capture, 'boolean');
  assertEqual(typeof entry.check, 'boolean');
});

test('el turno se alterna y el historial crece', () => {
  const partida = createGame({ mode: 'local' });
  assertEqual(partida.turn(), 'w');
  partida.playUci('e2e4');
  assertEqual(partida.turn(), 'b');
  partida.playUci('e7e5');
  assertEqual(partida.turn(), 'w');
  assertEqual(partida.ply(), 2);
  assertEqual(partida.sanMoves().join(' '), 'e4 e5');
});

/* --------------------------- jugadas imposibles -------------------------- */

test('una jugada ilegal se rechaza sin tocar la partida', () => {
  const partida = createGame({ mode: 'local' });
  const antes = partida.getFen();
  const mala = partida.playUci('e2e5');
  assertEqual(mala.ok, false, 'e2e5 no es legal desde la inicial');
  assertEqual(partida.getFen(), antes, 'y la posición no se movió');
  assertEqual(partida.ply(), 0);
});

test('la basura tampoco entra', () => {
  const partida = createGame({ mode: 'local' });
  for (const basura of ['', 'xx', 'e2e', null, undefined, 'e9e9']) {
    const r = partida.playUci(basura);
    assertEqual(r.ok, false, 'no debería aceptar ' + JSON.stringify(basura));
  }
  assertEqual(partida.ply(), 0);
});

/* ------------------------------ el final --------------------------------- */

test('el mate del pastor termina la partida solo', () => {
  const partida = createGame({ mode: 'local' });
  for (const uci of ['e2e4', 'e7e5', 'f1c4', 'b8c6', 'd1h5', 'g8f6', 'h5f7']) {
    partida.playUci(uci);
  }
  assert(partida.status.over, 'después de Qxf7# la partida terminó');
  assertEqual(partida.status.result, '1-0');
  assertEqual(partida.status.reason, 'checkmate');
});

test('rendirse da la partida al otro, y el motivo se puede escribir', () => {
  const rendida = createGame({ mode: 'local' });
  rendida.playUci('e2e4');
  rendida.resign('b');
  assertEqual(rendida.status.result, '1-0', 'si abandonan las negras, ganan las blancas');

  const desdeFuera = createGame({ mode: 'online' });
  desdeFuera.forceResult('0-1', 'timeout', 'Se acabó el tiempo: ganan las negras.');
  assertEqual(desdeFuera.status.result, '0-1');
  assertEqual(desdeFuera.status.text, 'Se acabó el tiempo: ganan las negras.',
    'el texto que manda el servidor se enseña tal cual');
});

test('una partida terminada no acepta más jugadas', () => {
  const partida = createGame({ mode: 'local' });
  partida.playUci('e2e4');
  partida.resign('b');
  const despues = partida.playUci('e7e5');
  assertEqual(despues.ok, false, 'con la partida acabada no se sigue jugando');
});

/* ------------------------------ deshacer --------------------------------- */

test('deshacer devuelve la posición y el turno', () => {
  const partida = createGame({ mode: 'local' });
  const inicial = partida.getFen();
  partida.playUci('e2e4');
  partida.playUci('e7e5');
  partida.takeback(2);
  assertEqual(partida.ply(), 0);
  assertEqual(partida.getFen(), inicial);
  assertEqual(partida.turn(), 'w');
});

run('game.js');
