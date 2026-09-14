/*
 * chess.js — nucleo de reglas del juego.
 * Representacion 0x88, generacion de jugadas legales y pseudolegales,
 * make/unmake con actualizacion incremental de la clave Zobrist,
 * lectura y escritura de FEN, notacion SAN y UCI, perft y deteccion
 * del final de la partida. Modulo agnostico del entorno: funciona igual
 * en Node, en el navegador y dentro de un Web Worker.
 */

export const WHITE = 0;
export const BLACK = 1;

export const EMPTY = 0;
export const PAWN = 1;
export const KNIGHT = 2;
export const BISHOP = 3;
export const ROOK = 4;
export const QUEEN = 5;
export const KING = 6;

export const FLAG_CAPTURE = 1 << 19;
export const FLAG_EP = 1 << 20;
export const FLAG_DOUBLE = 1 << 21;
export const FLAG_CASTLE = 1 << 22;

export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

const FLAGS_MASK = 0xf80000;

const SQ_A1 = 0;
const SQ_C1 = 2;
const SQ_D1 = 3;
const SQ_E1 = 4;
const SQ_F1 = 5;
const SQ_G1 = 6;
const SQ_H1 = 7;
const SQ_A8 = 112;
const SQ_C8 = 114;
const SQ_D8 = 115;
const SQ_E8 = 116;
const SQ_F8 = 117;
const SQ_G8 = 118;
const SQ_H8 = 119;

const W_PAWN = PAWN;
const W_ROOK = ROOK;
const W_KING = KING;
const B_PAWN = PAWN | 8;
const B_ROOK = ROOK | 8;
const B_KING = KING | 8;

const KNIGHT_DELTAS = new Int8Array([-33, -31, -18, -14, 14, 18, 31, 33]);
const BISHOP_DELTAS = new Int8Array([-17, -15, 15, 17]);
const ROOK_DELTAS = new Int8Array([-16, -1, 1, 16]);
const KING_DELTAS = new Int8Array([-17, -16, -15, -1, 1, 15, 16, 17]);
// Primero las cuatro direcciones rectas y despues las cuatro diagonales.
const RAY_DELTAS = new Int8Array([-16, -1, 1, 16, -17, -15, 15, 17]);

const TYPE_CHARS = '.pnbrqk';
const SAN_CHARS = '.PNBRQK';

const DEFAULT_OPTS = Object.freeze({});

// DIR_TABLE[0x77 + (to - from)] devuelve el paso unitario que une ambas
// casillas si estan en la misma linea (fila, columna o diagonal), o 0.
const DIR_TABLE = new Int8Array(256);
for (let i = 0; i < 8; i++) {
  const d = RAY_DELTAS[i];
  for (let dist = 1; dist <= 7; dist++) {
    DIR_TABLE[0x77 + d * dist] = d;
  }
}

// Mascara de derechos de enroque que sobrevive a un movimiento desde o hacia
// cada casilla (las torres y los reyes en su casilla inicial pierden derechos).
const CASTLE_MASK = new Int8Array(128).fill(15);
CASTLE_MASK[SQ_A1] = 15 & ~2;
CASTLE_MASK[SQ_E1] = 15 & ~3;
CASTLE_MASK[SQ_H1] = 15 & ~1;
CASTLE_MASK[SQ_A8] = 15 & ~8;
CASTLE_MASK[SQ_E8] = 15 & ~12;
CASTLE_MASK[SQ_H8] = 15 & ~4;

// --- Zobrist ------------------------------------------------------------
// Tablas deterministas: xorshift32 con semilla fija para que cliente,
// servidor y worker calculen siempre las mismas claves.

const ZOB_PIECE_LO = new Int32Array(15 * 128);
const ZOB_PIECE_HI = new Int32Array(15 * 128);
const ZOB_CASTLE_LO = new Int32Array(16);
const ZOB_CASTLE_HI = new Int32Array(16);
const ZOB_EP_LO = new Int32Array(128);
const ZOB_EP_HI = new Int32Array(128);
let ZOB_SIDE_LO = 0;
let ZOB_SIDE_HI = 0;

(function initZobrist() {
  let state = 0x2f6e2b13 | 0;
  const next = () => {
    state ^= state << 13;
    state |= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state |= 0;
    return state | 0;
  };
  for (let pc = 1; pc < 15; pc++) {
    for (let sq = 0; sq < 128; sq++) {
      ZOB_PIECE_LO[(pc << 7) + sq] = next();
      ZOB_PIECE_HI[(pc << 7) + sq] = next();
    }
  }
  for (let i = 0; i < 16; i++) {
    ZOB_CASTLE_LO[i] = next();
    ZOB_CASTLE_HI[i] = next();
  }
  for (let sq = 0; sq < 128; sq++) {
    ZOB_EP_LO[sq] = next();
    ZOB_EP_HI[sq] = next();
  }
  ZOB_SIDE_LO = next();
  ZOB_SIDE_HI = next();
})();

// --- Helpers de pieza, casilla y jugada ---------------------------------

export function pieceType(pc) {
  return pc & 7;
}

export function pieceColor(pc) {
  return pc >> 3;
}

export function sqRank(sq) {
  return sq >> 4;
}

export function sqFile(sq) {
  return sq & 7;
}

export function squareName(sq) {
  return String.fromCharCode(97 + (sq & 7), 49 + (sq >> 4));
}

export function parseSquare(name) {
  if (typeof name !== 'string' || name.length !== 2) return -1;
  const file = name.charCodeAt(0) - 97;
  const rank = name.charCodeAt(1) - 49;
  if (file < 0 || file > 7 || rank < 0 || rank > 7) return -1;
  return (rank << 4) | file;
}

export function encodeMove(from, to, promo, flags) {
  return from | (to << 8) | (promo << 16) | flags;
}

export function moveFrom(m) {
  return m & 0xff;
}

export function moveTo(m) {
  return (m >>> 8) & 0xff;
}

export function movePromo(m) {
  return (m >>> 16) & 7;
}

export function moveFlags(m) {
  return m & FLAGS_MASK;
}

export function isCapture(m) {
  return (m & FLAG_CAPTURE) !== 0;
}

export function isEnPassant(m) {
  return (m & FLAG_EP) !== 0;
}

export function isCastle(m) {
  return (m & FLAG_CASTLE) !== 0;
}

export function isDoublePush(m) {
  return (m & FLAG_DOUBLE) !== 0;
}

// --- Posicion -----------------------------------------------------------

function emptyPosition() {
  return {
    board: new Int8Array(128),
    turn: WHITE,
    castling: 0,
    ep: -1,
    halfmove: 0,
    fullmove: 1,
    kingSq: new Int8Array(2),
    keyLo: 0,
    keyHi: 0,
    undoStack: [],
    repLo: [],
    repHi: []
  };
}

export function createPosition(fen = START_FEN) {
  const pos = emptyPosition();
  setFen(pos, fen);
  return pos;
}

export function clonePosition(pos) {
  const copy = {
    board: new Int8Array(pos.board),
    turn: pos.turn,
    castling: pos.castling,
    ep: pos.ep,
    halfmove: pos.halfmove,
    fullmove: pos.fullmove,
    kingSq: new Int8Array(pos.kingSq),
    keyLo: pos.keyLo,
    keyHi: pos.keyHi,
    undoStack: new Array(pos.undoStack.length),
    repLo: pos.repLo.slice(),
    repHi: pos.repHi.slice()
  };
  for (let i = 0; i < pos.undoStack.length; i++) {
    const u = pos.undoStack[i];
    copy.undoStack[i] = {
      move: u.move,
      captured: u.captured,
      castling: u.castling,
      ep: u.ep,
      halfmove: u.halfmove,
      fullmove: u.fullmove,
      keyLo: u.keyLo,
      keyHi: u.keyHi
    };
  }
  return copy;
}

function charToPiece(ch) {
  const lower = ch.toLowerCase();
  const type = TYPE_CHARS.indexOf(lower);
  if (type < 1) return -1;
  return ch === lower ? type | 8 : type;
}

function pieceToChar(pc) {
  const ch = TYPE_CHARS[pc & 7];
  return (pc >> 3) === WHITE ? ch.toUpperCase() : ch;
}

function computeKey(pos) {
  let lo = 0;
  let hi = 0;
  for (let sq = 0; sq < 128; sq++) {
    if (sq & 0x88) {
      sq += 7;
      continue;
    }
    const pc = pos.board[sq];
    if (pc !== EMPTY) {
      lo ^= ZOB_PIECE_LO[(pc << 7) + sq];
      hi ^= ZOB_PIECE_HI[(pc << 7) + sq];
    }
  }
  lo ^= ZOB_CASTLE_LO[pos.castling];
  hi ^= ZOB_CASTLE_HI[pos.castling];
  if (pos.ep !== -1) {
    lo ^= ZOB_EP_LO[pos.ep];
    hi ^= ZOB_EP_HI[pos.ep];
  }
  if (pos.turn === BLACK) {
    lo ^= ZOB_SIDE_LO;
    hi ^= ZOB_SIDE_HI;
  }
  pos.keyLo = lo >>> 0;
  pos.keyHi = hi >>> 0;
}

export function setFen(pos, fen) {
  if (typeof fen !== 'string') throw new Error('FEN inválida: se esperaba una cadena.');
  const parts = fen.trim().split(/\s+/);
  if (parts.length < 4) throw new Error('FEN inválida: faltan campos.');
  const ranks = parts[0].split('/');
  if (ranks.length !== 8) throw new Error('FEN inválida: el tablero debe tener 8 filas.');

  const board = pos.board;
  board.fill(EMPTY);
  let whiteKings = 0;
  let blackKings = 0;
  for (let r = 0; r < 8; r++) {
    const row = ranks[r];
    const rank = 7 - r;
    let file = 0;
    for (let i = 0; i < row.length; i++) {
      const ch = row[i];
      if (ch >= '1' && ch <= '8') {
        file += ch.charCodeAt(0) - 48;
        continue;
      }
      const pc = charToPiece(ch);
      if (pc < 0) throw new Error('FEN inválida: carácter de pieza desconocido "' + ch + '".');
      if (file > 7) throw new Error('FEN inválida: la fila ' + (rank + 1) + ' desborda.');
      board[(rank << 4) | file] = pc;
      if (pc === W_KING) whiteKings++;
      else if (pc === B_KING) blackKings++;
      file++;
    }
    if (file !== 8) throw new Error('FEN inválida: la fila ' + (rank + 1) + ' no suma 8 casillas.');
  }
  if (whiteKings !== 1 || blackKings !== 1) {
    throw new Error('FEN inválida: debe haber exactamente un rey de cada color.');
  }

  const turnField = parts[1];
  if (turnField !== 'w' && turnField !== 'b') {
    throw new Error('FEN inválida: el turno debe ser "w" o "b".');
  }
  pos.turn = turnField === 'w' ? WHITE : BLACK;

  let castling = 0;
  const castleField = parts[2];
  if (castleField !== '-') {
    for (let i = 0; i < castleField.length; i++) {
      switch (castleField[i]) {
        case 'K': castling |= 1; break;
        case 'Q': castling |= 2; break;
        case 'k': castling |= 4; break;
        case 'q': castling |= 8; break;
        default: throw new Error('FEN inválida: derechos de enroque desconocidos.');
      }
    }
  }
  // Descarta derechos imposibles segun la posicion real de reyes y torres.
  if (board[SQ_E1] !== W_KING) castling &= ~3;
  if (board[SQ_H1] !== W_ROOK) castling &= ~1;
  if (board[SQ_A1] !== W_ROOK) castling &= ~2;
  if (board[SQ_E8] !== B_KING) castling &= ~12;
  if (board[SQ_H8] !== B_ROOK) castling &= ~4;
  if (board[SQ_A8] !== B_ROOK) castling &= ~8;
  pos.castling = castling;

  const epField = parts[3];
  if (epField === '-') {
    pos.ep = -1;
  } else {
    const sq = parseSquare(epField);
    if (sq < 0) throw new Error('FEN inválida: casilla al paso incorrecta.');
    const rank = sq >> 4;
    if (rank !== 2 && rank !== 5) throw new Error('FEN inválida: la casilla al paso no está en la 3ª ni en la 6ª fila.');
    pos.ep = sq;
  }

  const half = parts.length > 4 ? parseInt(parts[4], 10) : 0;
  const full = parts.length > 5 ? parseInt(parts[5], 10) : 1;
  pos.halfmove = Number.isFinite(half) && half >= 0 ? half : 0;
  pos.fullmove = Number.isFinite(full) && full >= 1 ? full : 1;

  pos.kingSq[WHITE] = -1;
  pos.kingSq[BLACK] = -1;
  for (let sq = 0; sq < 128; sq++) {
    if (sq & 0x88) {
      sq += 7;
      continue;
    }
    const pc = board[sq];
    if (pc === W_KING) pos.kingSq[WHITE] = sq;
    else if (pc === B_KING) pos.kingSq[BLACK] = sq;
  }

  pos.undoStack.length = 0;
  computeKey(pos);
  pos.repLo.length = 0;
  pos.repHi.length = 0;
  pos.repLo.push(pos.keyLo);
  pos.repHi.push(pos.keyHi);
  return pos;
}

export function getFen(pos) {
  const board = pos.board;
  let out = '';
  for (let rank = 7; rank >= 0; rank--) {
    let run = 0;
    for (let file = 0; file < 8; file++) {
      const pc = board[(rank << 4) | file];
      if (pc === EMPTY) {
        run++;
        continue;
      }
      if (run > 0) {
        out += run;
        run = 0;
      }
      out += pieceToChar(pc);
    }
    if (run > 0) out += run;
    if (rank > 0) out += '/';
  }
  out += pos.turn === WHITE ? ' w ' : ' b ';
  if (pos.castling === 0) {
    out += '-';
  } else {
    if (pos.castling & 1) out += 'K';
    if (pos.castling & 2) out += 'Q';
    if (pos.castling & 4) out += 'k';
    if (pos.castling & 8) out += 'q';
  }
  out += ' ' + (pos.ep === -1 ? '-' : squareName(pos.ep));
  out += ' ' + pos.halfmove + ' ' + pos.fullmove;
  return out;
}

// --- Ataques ------------------------------------------------------------

export function isSquareAttacked(pos, sq, byColor) {
  const b = pos.board;
  const bit = byColor << 3;

  const pawn = PAWN | bit;
  if (byColor === WHITE) {
    let s = sq - 15;
    if (!(s & 0x88) && b[s] === pawn) return true;
    s = sq - 17;
    if (!(s & 0x88) && b[s] === pawn) return true;
  } else {
    let s = sq + 15;
    if (!(s & 0x88) && b[s] === pawn) return true;
    s = sq + 17;
    if (!(s & 0x88) && b[s] === pawn) return true;
  }

  const knight = KNIGHT | bit;
  for (let i = 0; i < 8; i++) {
    const s = sq + KNIGHT_DELTAS[i];
    if (!(s & 0x88) && b[s] === knight) return true;
  }

  const king = KING | bit;
  for (let i = 0; i < 8; i++) {
    const s = sq + KING_DELTAS[i];
    if (!(s & 0x88) && b[s] === king) return true;
  }

  const queen = QUEEN | bit;
  const rook = ROOK | bit;
  for (let i = 0; i < 4; i++) {
    const d = ROOK_DELTAS[i];
    for (let s = sq + d; !(s & 0x88); s += d) {
      const pc = b[s];
      if (pc !== EMPTY) {
        if (pc === rook || pc === queen) return true;
        break;
      }
    }
  }
  const bishop = BISHOP | bit;
  for (let i = 0; i < 4; i++) {
    const d = BISHOP_DELTAS[i];
    for (let s = sq + d; !(s & 0x88); s += d) {
      const pc = b[s];
      if (pc !== EMPTY) {
        if (pc === bishop || pc === queen) return true;
        break;
      }
    }
  }
  return false;
}

export function inCheck(pos, color = pos.turn) {
  return isSquareAttacked(pos, pos.kingSq[color], color ^ 1);
}

// --- Generacion de jugadas ----------------------------------------------

function genPseudoLegal(pos, out, capturesOnly) {
  const b = pos.board;
  const us = pos.turn;
  const them = us ^ 1;
  const push = us === WHITE ? 16 : -16;
  const startRank = us === WHITE ? 1 : 6;
  const promoRank = us === WHITE ? 7 : 0;
  const ep = pos.ep;

  for (let sq = 0; sq < 128; sq++) {
    if (sq & 0x88) {
      sq += 7;
      continue;
    }
    const pc = b[sq];
    if (pc === EMPTY || (pc >> 3) !== us) continue;
    const pt = pc & 7;

    if (pt === PAWN) {
      for (let i = 0; i < 2; i++) {
        const to = sq + push + (i === 0 ? -1 : 1);
        if (to & 0x88) continue;
        const target = b[to];
        if (target !== EMPTY) {
          if ((target >> 3) !== them) continue;
          if ((to >> 4) === promoRank) {
            out.push(encodeMove(sq, to, QUEEN, FLAG_CAPTURE));
            out.push(encodeMove(sq, to, ROOK, FLAG_CAPTURE));
            out.push(encodeMove(sq, to, BISHOP, FLAG_CAPTURE));
            out.push(encodeMove(sq, to, KNIGHT, FLAG_CAPTURE));
          } else {
            out.push(encodeMove(sq, to, 0, FLAG_CAPTURE));
          }
        } else if (to === ep) {
          out.push(encodeMove(sq, to, 0, FLAG_EP | FLAG_CAPTURE));
        }
      }
      const one = sq + push;
      if (!(one & 0x88) && b[one] === EMPTY) {
        if ((one >> 4) === promoRank) {
          out.push(encodeMove(sq, one, QUEEN, 0));
          out.push(encodeMove(sq, one, ROOK, 0));
          out.push(encodeMove(sq, one, BISHOP, 0));
          out.push(encodeMove(sq, one, KNIGHT, 0));
        } else if (!capturesOnly) {
          out.push(encodeMove(sq, one, 0, 0));
          if ((sq >> 4) === startRank) {
            const two = one + push;
            if (b[two] === EMPTY) out.push(encodeMove(sq, two, 0, FLAG_DOUBLE));
          }
        }
      }
      continue;
    }

    if (pt === KNIGHT || pt === KING) {
      const deltas = pt === KNIGHT ? KNIGHT_DELTAS : KING_DELTAS;
      for (let i = 0; i < 8; i++) {
        const to = sq + deltas[i];
        if (to & 0x88) continue;
        const target = b[to];
        if (target === EMPTY) {
          if (!capturesOnly) out.push(encodeMove(sq, to, 0, 0));
        } else if ((target >> 3) === them) {
          out.push(encodeMove(sq, to, 0, FLAG_CAPTURE));
        }
      }
      continue;
    }

    const deltas = pt === BISHOP ? BISHOP_DELTAS : pt === ROOK ? ROOK_DELTAS : KING_DELTAS;
    const dirCount = pt === QUEEN ? 8 : 4;
    for (let i = 0; i < dirCount; i++) {
      const d = deltas[i];
      for (let to = sq + d; !(to & 0x88); to += d) {
        const target = b[to];
        if (target === EMPTY) {
          if (!capturesOnly) out.push(encodeMove(sq, to, 0, 0));
          continue;
        }
        if ((target >> 3) === them) out.push(encodeMove(sq, to, 0, FLAG_CAPTURE));
        break;
      }
    }
  }

  if (!capturesOnly && pos.castling !== 0) genCastles(pos, out, us, them);
}

function genCastles(pos, out, us, them) {
  const b = pos.board;
  if (us === WHITE) {
    if ((pos.castling & 1) !== 0 && b[SQ_F1] === EMPTY && b[SQ_G1] === EMPTY &&
        b[SQ_H1] === W_ROOK && b[SQ_E1] === W_KING &&
        !isSquareAttacked(pos, SQ_E1, them) && !isSquareAttacked(pos, SQ_F1, them) &&
        !isSquareAttacked(pos, SQ_G1, them)) {
      out.push(encodeMove(SQ_E1, SQ_G1, 0, FLAG_CASTLE));
    }
    if ((pos.castling & 2) !== 0 && b[SQ_D1] === EMPTY && b[SQ_C1] === EMPTY &&
        b[1] === EMPTY && b[SQ_A1] === W_ROOK && b[SQ_E1] === W_KING &&
        !isSquareAttacked(pos, SQ_E1, them) && !isSquareAttacked(pos, SQ_D1, them) &&
        !isSquareAttacked(pos, SQ_C1, them)) {
      out.push(encodeMove(SQ_E1, SQ_C1, 0, FLAG_CASTLE));
    }
  } else {
    if ((pos.castling & 4) !== 0 && b[SQ_F8] === EMPTY && b[SQ_G8] === EMPTY &&
        b[SQ_H8] === B_ROOK && b[SQ_E8] === B_KING &&
        !isSquareAttacked(pos, SQ_E8, them) && !isSquareAttacked(pos, SQ_F8, them) &&
        !isSquareAttacked(pos, SQ_G8, them)) {
      out.push(encodeMove(SQ_E8, SQ_G8, 0, FLAG_CASTLE));
    }
    if ((pos.castling & 8) !== 0 && b[SQ_D8] === EMPTY && b[SQ_C8] === EMPTY &&
        b[113] === EMPTY && b[SQ_A8] === B_ROOK && b[SQ_E8] === B_KING &&
        !isSquareAttacked(pos, SQ_E8, them) && !isSquareAttacked(pos, SQ_D8, them) &&
        !isSquareAttacked(pos, SQ_C8, them)) {
      out.push(encodeMove(SQ_E8, SQ_C8, 0, FLAG_CASTLE));
    }
  }
}

// Casillas clavadas de la posicion actual; se reutilizan entre llamadas para
// no asignar memoria por nodo. Solo se usan dentro de filterLegal.
const PIN_SQ = new Int8Array(8);
const PIN_DIR = new Int8Array(8);

function kingMoveLegal(pos, from, to, them) {
  const b = pos.board;
  const king = b[from];
  b[from] = EMPTY;
  const attacked = isSquareAttacked(pos, to, them);
  b[from] = king;
  return !attacked;
}

function epMoveLegal(pos, from, to) {
  const b = pos.board;
  const us = pos.turn;
  const capSq = us === WHITE ? to - 16 : to + 16;
  const pawn = b[from];
  const capturedPawn = b[capSq];
  b[from] = EMPTY;
  b[capSq] = EMPTY;
  b[to] = pawn;
  const ok = !isSquareAttacked(pos, pos.kingSq[us], us ^ 1);
  b[to] = EMPTY;
  b[capSq] = capturedPawn;
  b[from] = pawn;
  return ok;
}

function filterLegal(pos, moves) {
  const b = pos.board;
  const us = pos.turn;
  const them = us ^ 1;
  const ksq = pos.kingSq[us];

  let pinCount = 0;
  let checkCount = 0;
  let checkSq = -1;
  let checkDir = 0;
  let checkSlider = false;

  for (let i = 0; i < 8; i++) {
    const d = RAY_DELTAS[i];
    const diagonal = i >= 4;
    let blocker = -1;
    for (let s = ksq + d; !(s & 0x88); s += d) {
      const pc = b[s];
      if (pc === EMPTY) continue;
      if ((pc >> 3) === us) {
        if (blocker !== -1) break;
        blocker = s;
        continue;
      }
      const t = pc & 7;
      if (t === QUEEN || (diagonal ? t === BISHOP : t === ROOK)) {
        if (blocker === -1) {
          checkCount++;
          if (checkCount === 1) {
            checkSq = s;
            checkDir = d;
            checkSlider = true;
          }
        } else {
          PIN_SQ[pinCount] = blocker;
          PIN_DIR[pinCount] = d;
          pinCount++;
        }
      }
      break;
    }
  }

  const enemyKnight = KNIGHT | (them << 3);
  for (let i = 0; i < 8; i++) {
    const s = ksq + KNIGHT_DELTAS[i];
    if (!(s & 0x88) && b[s] === enemyKnight) {
      checkCount++;
      if (checkCount === 1) {
        checkSq = s;
        checkSlider = false;
      }
    }
  }

  const enemyPawn = PAWN | (them << 3);
  const pawnOffset = us === WHITE ? 15 : -15;
  let ps = ksq + pawnOffset;
  if (!(ps & 0x88) && b[ps] === enemyPawn) {
    checkCount++;
    if (checkCount === 1) {
      checkSq = ps;
      checkSlider = false;
    }
  }
  ps = ksq + (us === WHITE ? 17 : -17);
  if (!(ps & 0x88) && b[ps] === enemyPawn) {
    checkCount++;
    if (checkCount === 1) {
      checkSq = ps;
      checkSlider = false;
    }
  }

  const quiet = checkCount === 0 && pinCount === 0;
  let n = 0;
  for (let i = 0; i < moves.length; i++) {
    const m = moves[i];
    const from = m & 0xff;
    let ok;
    if ((m & FLAG_EP) !== 0) {
      ok = epMoveLegal(pos, from, (m >>> 8) & 0xff);
    } else if (from === ksq) {
      ok = (m & FLAG_CASTLE) !== 0 || kingMoveLegal(pos, from, (m >>> 8) & 0xff, them);
    } else if (quiet) {
      ok = true;
    } else if (checkCount > 1) {
      ok = false;
    } else {
      const to = (m >>> 8) & 0xff;
      ok = true;
      for (let p = 0; p < pinCount; p++) {
        if (PIN_SQ[p] === from) {
          if (DIR_TABLE[0x77 + to - ksq] !== PIN_DIR[p]) ok = false;
          break;
        }
      }
      if (ok && checkCount === 1) {
        if (to !== checkSq) {
          if (!checkSlider) {
            ok = false;
          } else {
            const step = to - ksq;
            const span = checkSq - ksq;
            ok = DIR_TABLE[0x77 + step] === checkDir &&
              (step < 0 ? -step : step) < (span < 0 ? -span : span);
          }
        }
      }
    }
    if (ok) moves[n++] = m;
  }
  moves.length = n;
  return moves;
}

export function generateMoves(pos, opts = DEFAULT_OPTS) {
  const moves = [];
  genPseudoLegal(pos, moves, opts.captures === true);
  if (opts.legal === false) return moves;
  return filterLegal(pos, moves);
}

// --- Ejecucion de jugadas -----------------------------------------------

export function makeMove(pos, move) {
  const b = pos.board;
  const from = move & 0xff;
  const to = (move >>> 8) & 0xff;
  const promo = (move >>> 16) & 7;
  const us = pos.turn;
  const piece = b[from];
  const pt = piece & 7;

  const undo = {
    move,
    captured: EMPTY,
    castling: pos.castling,
    ep: pos.ep,
    halfmove: pos.halfmove,
    fullmove: pos.fullmove,
    keyLo: pos.keyLo,
    keyHi: pos.keyHi
  };

  let lo = pos.keyLo;
  let hi = pos.keyHi;

  if (pos.ep !== -1) {
    lo ^= ZOB_EP_LO[pos.ep];
    hi ^= ZOB_EP_HI[pos.ep];
  }
  lo ^= ZOB_CASTLE_LO[pos.castling];
  hi ^= ZOB_CASTLE_HI[pos.castling];

  const capSq = (move & FLAG_EP) !== 0 ? (us === WHITE ? to - 16 : to + 16) : to;
  const captured = b[capSq];
  if (captured !== EMPTY) {
    undo.captured = captured;
    b[capSq] = EMPTY;
    const idx = (captured << 7) + capSq;
    lo ^= ZOB_PIECE_LO[idx];
    hi ^= ZOB_PIECE_HI[idx];
  }

  b[from] = EMPTY;
  const fromIdx = (piece << 7) + from;
  lo ^= ZOB_PIECE_LO[fromIdx];
  hi ^= ZOB_PIECE_HI[fromIdx];

  const placed = promo !== 0 ? (promo | (us << 3)) : piece;
  b[to] = placed;
  const toIdx = (placed << 7) + to;
  lo ^= ZOB_PIECE_LO[toIdx];
  hi ^= ZOB_PIECE_HI[toIdx];

  if (pt === KING) {
    pos.kingSq[us] = to;
    if ((move & FLAG_CASTLE) !== 0) {
      const rook = ROOK | (us << 3);
      let rookFrom;
      let rookTo;
      if (to === SQ_G1) {
        rookFrom = SQ_H1;
        rookTo = SQ_F1;
      } else if (to === SQ_C1) {
        rookFrom = SQ_A1;
        rookTo = SQ_D1;
      } else if (to === SQ_G8) {
        rookFrom = SQ_H8;
        rookTo = SQ_F8;
      } else {
        rookFrom = SQ_A8;
        rookTo = SQ_D8;
      }
      b[rookFrom] = EMPTY;
      b[rookTo] = rook;
      const rf = (rook << 7) + rookFrom;
      const rt = (rook << 7) + rookTo;
      lo ^= ZOB_PIECE_LO[rf] ^ ZOB_PIECE_LO[rt];
      hi ^= ZOB_PIECE_HI[rf] ^ ZOB_PIECE_HI[rt];
    }
  }

  pos.castling = pos.castling & CASTLE_MASK[from] & CASTLE_MASK[to];
  lo ^= ZOB_CASTLE_LO[pos.castling];
  hi ^= ZOB_CASTLE_HI[pos.castling];

  if ((move & FLAG_DOUBLE) !== 0) {
    pos.ep = us === WHITE ? from + 16 : from - 16;
    lo ^= ZOB_EP_LO[pos.ep];
    hi ^= ZOB_EP_HI[pos.ep];
  } else {
    pos.ep = -1;
  }

  if (pt === PAWN || captured !== EMPTY) pos.halfmove = 0;
  else pos.halfmove++;

  if (us === BLACK) pos.fullmove++;
  pos.turn = us ^ 1;
  lo ^= ZOB_SIDE_LO;
  hi ^= ZOB_SIDE_HI;

  pos.keyLo = lo >>> 0;
  pos.keyHi = hi >>> 0;
  pos.undoStack.push(undo);
  pos.repLo.push(pos.keyLo);
  pos.repHi.push(pos.keyHi);
  return undo;
}

export function unmakeMove(pos) {
  const undo = pos.undoStack.pop();
  if (undo === undefined) return 0;
  pos.repLo.pop();
  pos.repHi.pop();

  const move = undo.move;
  pos.turn ^= 1;
  pos.castling = undo.castling;
  pos.ep = undo.ep;
  pos.halfmove = undo.halfmove;
  pos.fullmove = undo.fullmove;
  pos.keyLo = undo.keyLo;
  pos.keyHi = undo.keyHi;
  if (move === 0) return 0;

  const b = pos.board;
  const us = pos.turn;
  const from = move & 0xff;
  const to = (move >>> 8) & 0xff;
  const promo = (move >>> 16) & 7;

  const piece = promo !== 0 ? (PAWN | (us << 3)) : b[to];
  b[to] = EMPTY;
  b[from] = piece;

  if ((piece & 7) === KING) {
    pos.kingSq[us] = from;
    if ((move & FLAG_CASTLE) !== 0) {
      const rook = ROOK | (us << 3);
      if (to === SQ_G1) {
        b[SQ_F1] = EMPTY;
        b[SQ_H1] = rook;
      } else if (to === SQ_C1) {
        b[SQ_D1] = EMPTY;
        b[SQ_A1] = rook;
      } else if (to === SQ_G8) {
        b[SQ_F8] = EMPTY;
        b[SQ_H8] = rook;
      } else {
        b[SQ_D8] = EMPTY;
        b[SQ_A8] = rook;
      }
    }
  }

  if (undo.captured !== EMPTY) {
    const capSq = (move & FLAG_EP) !== 0 ? (us === WHITE ? to - 16 : to + 16) : to;
    b[capSq] = undo.captured;
  }
  return move;
}

export function makeNullMove(pos) {
  const undo = {
    move: 0,
    captured: EMPTY,
    castling: pos.castling,
    ep: pos.ep,
    halfmove: pos.halfmove,
    fullmove: pos.fullmove,
    keyLo: pos.keyLo,
    keyHi: pos.keyHi
  };
  let lo = pos.keyLo;
  let hi = pos.keyHi;
  if (pos.ep !== -1) {
    lo ^= ZOB_EP_LO[pos.ep];
    hi ^= ZOB_EP_HI[pos.ep];
    pos.ep = -1;
  }
  if (pos.turn === BLACK) pos.fullmove++;
  pos.turn ^= 1;
  pos.halfmove++;
  lo ^= ZOB_SIDE_LO;
  hi ^= ZOB_SIDE_HI;
  pos.keyLo = lo >>> 0;
  pos.keyHi = hi >>> 0;
  pos.undoStack.push(undo);
  pos.repLo.push(pos.keyLo);
  pos.repHi.push(pos.keyHi);
  return undo;
}

export function unmakeNullMove(pos) {
  return unmakeMove(pos);
}

// --- Notacion -----------------------------------------------------------

function checkSuffix(pos, move) {
  makeMove(pos, move);
  let suffix = '';
  if (inCheck(pos)) {
    suffix = generateMoves(pos).length === 0 ? '#' : '+';
  }
  unmakeMove(pos);
  return suffix;
}

export function moveToSan(pos, move) {
  const from = move & 0xff;
  const to = (move >>> 8) & 0xff;
  const promo = (move >>> 16) & 7;
  const piece = pos.board[from];
  const pt = piece & 7;

  if ((move & FLAG_CASTLE) !== 0) {
    const base = (to & 7) === 6 ? 'O-O' : 'O-O-O';
    return base + checkSuffix(pos, move);
  }

  let san;
  if (pt === PAWN) {
    if ((move & FLAG_CAPTURE) !== 0) {
      san = String.fromCharCode(97 + (from & 7)) + 'x' + squareName(to);
    } else {
      san = squareName(to);
    }
    if (promo !== 0) san += '=' + SAN_CHARS[promo];
  } else {
    const legal = generateMoves(pos);
    let ambiguous = 0;
    let sameFile = 0;
    let sameRank = 0;
    for (let i = 0; i < legal.length; i++) {
      const other = legal[i];
      const oFrom = other & 0xff;
      if (oFrom === from) continue;
      if (((other >>> 8) & 0xff) !== to) continue;
      if ((pos.board[oFrom] & 7) !== pt) continue;
      ambiguous++;
      if ((oFrom & 7) === (from & 7)) sameFile++;
      if ((oFrom >> 4) === (from >> 4)) sameRank++;
    }
    let disambiguation = '';
    if (ambiguous > 0) {
      if (sameFile === 0) disambiguation = String.fromCharCode(97 + (from & 7));
      else if (sameRank === 0) disambiguation = String.fromCharCode(49 + (from >> 4));
      else disambiguation = squareName(from);
    }
    san = SAN_CHARS[pt] + disambiguation + ((move & FLAG_CAPTURE) !== 0 ? 'x' : '') + squareName(to);
  }
  return san + checkSuffix(pos, move);
}

function normalizeSan(san) {
  let s = String(san).trim();
  s = s.replace(/×/g, 'x');
  s = s.replace(/e\.p\.?/i, '');
  s = s.replace(/[!?]+/g, '');
  s = s.replace(/[+#]+$/g, '');
  s = s.replace(/\s+/g, '');
  return s;
}

const SAN_RE = /^([NBRQK])?([a-h])?([1-8])?(x)?([a-h][1-8])(?:=?([NBRQnbrq]))?$/;

export function sanToMove(pos, san) {
  const clean = normalizeSan(san);
  if (clean === '') return -1;
  const legal = generateMoves(pos);

  const castleMatch = /^[O0o](?:-?[O0o]){1,2}$/.test(clean);
  if (castleMatch) {
    const longCastle = (clean.match(/[O0o]/g) || []).length === 3;
    for (let i = 0; i < legal.length; i++) {
      const m = legal[i];
      if ((m & FLAG_CASTLE) === 0) continue;
      const file = ((m >>> 8) & 0xff) & 7;
      if (longCastle ? file === 2 : file === 6) return m;
    }
    return -1;
  }

  const match = SAN_RE.exec(clean);
  if (match === null) {
    for (let i = 0; i < legal.length; i++) {
      if (normalizeSan(moveToSan(pos, legal[i])) === clean) return legal[i];
    }
    return -1;
  }

  const pieceLetter = match[1];
  const fromFile = match[2] ? match[2].charCodeAt(0) - 97 : -1;
  const fromRank = match[3] ? match[3].charCodeAt(0) - 49 : -1;
  const to = parseSquare(match[5]);
  const promoChar = match[6] ? match[6].toUpperCase() : '';
  const promo = promoChar === '' ? 0 : SAN_CHARS.indexOf(promoChar);
  const wantType = pieceLetter ? SAN_CHARS.indexOf(pieceLetter) : PAWN;

  let found = -1;
  let count = 0;
  for (let i = 0; i < legal.length; i++) {
    const m = legal[i];
    if (((m >>> 8) & 0xff) !== to) continue;
    const from = m & 0xff;
    if ((pos.board[from] & 7) !== wantType) continue;
    if (((m >>> 16) & 7) !== promo) continue;
    if (fromFile >= 0 && (from & 7) !== fromFile) continue;
    if (fromRank >= 0 && (from >> 4) !== fromRank) continue;
    found = m;
    count++;
  }
  return count === 1 ? found : -1;
}

export function moveToUci(move) {
  const promo = (move >>> 16) & 7;
  return squareName(move & 0xff) + squareName((move >>> 8) & 0xff) +
    (promo !== 0 ? TYPE_CHARS[promo] : '');
}

export function uciToMove(pos, uci) {
  if (typeof uci !== 'string' || uci.length < 4 || uci.length > 5) return -1;
  const from = parseSquare(uci.slice(0, 2));
  const to = parseSquare(uci.slice(2, 4));
  if (from < 0 || to < 0) return -1;
  let promo = 0;
  if (uci.length === 5) {
    promo = TYPE_CHARS.indexOf(uci[4].toLowerCase());
    if (promo < KNIGHT || promo > QUEEN) return -1;
  }
  const legal = generateMoves(pos);
  for (let i = 0; i < legal.length; i++) {
    const m = legal[i];
    if ((m & 0xff) === from && ((m >>> 8) & 0xff) === to && ((m >>> 16) & 7) === promo) return m;
  }
  return -1;
}

// --- Estado de la partida -----------------------------------------------

export function isInsufficientMaterial(pos) {
  const b = pos.board;
  let knights = 0;
  let bishops = 0;
  let bishopSquareColor = -1;
  const bishopsPerColor = [0, 0];
  for (let sq = 0; sq < 128; sq++) {
    if (sq & 0x88) {
      sq += 7;
      continue;
    }
    const pc = b[sq];
    if (pc === EMPTY) continue;
    const t = pc & 7;
    if (t === PAWN || t === ROOK || t === QUEEN) return false;
    if (t === KNIGHT) knights++;
    else if (t === BISHOP) {
      bishops++;
      bishopsPerColor[pc >> 3]++;
      const color = ((sq >> 4) + (sq & 7)) & 1;
      if (bishopSquareColor === -1) bishopSquareColor = color;
      else if (bishopSquareColor !== color) bishopSquareColor = -2;
    }
  }
  const minors = knights + bishops;
  if (minors <= 1) return true;
  if (knights === 0 && bishopSquareColor >= 0 &&
      bishopsPerColor[WHITE] === 1 && bishopsPerColor[BLACK] === 1) {
    return true;
  }
  return false;
}

export function repetitionCount(pos) {
  const repLo = pos.repLo;
  const repHi = pos.repHi;
  const last = repLo.length - 1;
  if (last < 0) return 1;
  const lo = pos.keyLo;
  const hi = pos.keyHi;
  let limit = last - pos.halfmove;
  if (limit < 0) limit = 0;
  let count = 1;
  for (let i = last - 2; i >= limit; i -= 2) {
    if (repLo[i] === lo && repHi[i] === hi) count++;
  }
  return count;
}

export function gameResult(pos) {
  const legal = generateMoves(pos);
  if (legal.length === 0) {
    if (inCheck(pos)) {
      const winner = pos.turn ^ 1;
      return {
        over: true,
        winner,
        reason: 'checkmate',
        text: winner === WHITE ? 'Jaque mate: ganan las blancas.' : 'Jaque mate: ganan las negras.'
      };
    }
    return { over: true, winner: null, reason: 'stalemate', text: 'Tablas por rey ahogado.' };
  }
  if (isInsufficientMaterial(pos)) {
    return { over: true, winner: null, reason: 'insufficient', text: 'Tablas por material insuficiente.' };
  }
  if (repetitionCount(pos) >= 3) {
    return { over: true, winner: null, reason: 'repetition', text: 'Tablas por triple repetición.' };
  }
  if (pos.halfmove >= 100) {
    return { over: true, winner: null, reason: 'fifty', text: 'Tablas por la regla de las 50 jugadas.' };
  }
  return { over: false, winner: null, reason: null, text: '' };
}

export function perft(pos, depth) {
  if (depth <= 0) return 1;
  const moves = generateMoves(pos);
  let nodes = 0;
  for (let i = 0; i < moves.length; i++) {
    makeMove(pos, moves[i]);
    nodes += perft(pos, depth - 1);
    unmakeMove(pos);
  }
  return nodes;
}
