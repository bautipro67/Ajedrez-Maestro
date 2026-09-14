/**
 * worker.js — thin module-worker shell around enginecore.js. Keeping the search
 * off the main thread is what lets the board stay smooth while a bot thinks.
 * Protocol: see docs/CONTRATO-UI.md section 7.
 */

import { handleBotMove, handleAnalyze, handleEvalOnly, stopSearch, newGame, resetSearcher } from './enginecore.js';

self.onmessage = (event) => {
  const msg = event.data || {};
  try {
    switch (msg.type) {
      case 'botMove':
        self.postMessage({ id: msg.id, type: 'botMove', ...handleBotMove(msg) });
        break;
      case 'analyze':
        self.postMessage({ id: msg.id, type: 'analysis', ...handleAnalyze(msg) });
        break;
      case 'evalOnly':
        self.postMessage({ id: msg.id, type: 'evalOnly', ...handleEvalOnly(msg) });
        break;
      case 'stop':
        stopSearch();
        break;
      case 'newGame':
        newGame();
        break;
      case 'reset':
        resetSearcher();
        break;
      default:
        break;
    }
  } catch (error) {
    self.postMessage({
      id: msg.id,
      type: 'error',
      message: String(error && error.message ? error.message : error),
    });
  }
};
