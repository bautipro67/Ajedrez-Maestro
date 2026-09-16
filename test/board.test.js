/**
 * board.test.js — el tablero como widget, con el DOM de mentira.
 *
 * Existe por un fallo concreto: la pantalla de entrenamiento le pasaba la
 * última jugada como lista `['e2','e4']` y el tablero la quiere como objeto
 * `{from, to}`. Al pintar las marcas reventaba, y como el error salía dentro de
 * una promesa, no se veía nada: la pantalla se pintaba bien y no se podía mover
 * una sola pieza. Un tablero que se rompe por la forma de un parámetro tiene
 * que romperse aquí, no delante de alguien que quiere jugar.
 */

import './domstub.js';
import { test, assert, assertEqual, run } from './harness.js';
import { createBoard } from '../web/js/board.js';
import { START_FEN } from '../web/js/chess.js';

function nuevoTablero(opts = {}) {
  const host = document.createElement('div');
  return { host, board: createBoard(host, { animationMs: 0, ...opts }) };
}

test('pintar una posición con la última jugada bien formada no revienta', () => {
  const { board } = nuevoTablero();
  board.setPosition(START_FEN, { animate: false, lastMove: { from: 'e2', to: 'e4' } });
  assertEqual(board.getFen(), START_FEN);
  board.destroy();
});

test('la última jugada con forma rara no tumba el tablero', () => {
  /* Lo que pasaba: una lista en vez de un objeto y el tablero se quedaba
     inservible, sin que nada lo dijera. */
  const { board } = nuevoTablero();
  for (const raro of [['e2', 'e4'], 'e2e4', {}, { from: 'zz' }, 0]) {
    board.setPosition(START_FEN, { animate: false, lastMove: raro });
    board.setLastMove(raro);
  }
  assertEqual(board.getFen(), START_FEN, 'y sigue mostrando la posición');
  board.destroy();
});

test('sin última jugada tampoco pasa nada', () => {
  const { board } = nuevoTablero();
  board.setPosition(START_FEN, { animate: false });
  board.setPosition(START_FEN, { animate: false, lastMove: null });
  board.destroy();
});

test('las jugadas legales y el color que se puede mover se pueden fijar', () => {
  const { board } = nuevoTablero();
  board.setPosition(START_FEN, { animate: false });
  const mapa = new Map([['e2', [{ to: 'e4', capture: false, promotion: false }]]]);
  board.setLegalMoves(mapa);
  board.setMovableColor('white');
  board.setMovableColor('none');
  board.setLegalMoves(null);
  board.setLegalMoves(mapa);
  board.destroy();
});

test('girar el tablero conserva la posición', () => {
  const { board } = nuevoTablero({ orientation: 'white' });
  board.setPosition(START_FEN, { animate: false });
  assertEqual(board.getOrientation(), 'white');
  board.setOrientation('black');
  assertEqual(board.getOrientation(), 'black');
  assertEqual(board.getFen(), START_FEN);
  board.flip();
  assertEqual(board.getOrientation(), 'white');
  board.destroy();
});

test('destruir dos veces no da problemas', () => {
  const { board } = nuevoTablero();
  board.setPosition(START_FEN, { animate: false });
  board.destroy();
  board.destroy();
});

run('board.js');
