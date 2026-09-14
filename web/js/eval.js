/*
 * eval.js — evaluacion posicional tapered (apertura/final) del motor.
 * Material, tablas pieza-casilla, movilidad, seguridad del rey, estructura
 * de peones, pasados, pareja de alfiles, torres, puestos avanzados, control
 * del centro y desarrollo, con los multiplicadores de personalidad.
 * Incluye seeCapture (intercambio estatico) usado por la ordenacion y la
 * busqueda de quietud. Modulo agnostico del entorno y sin estado entre
 * llamadas: el acumulado interno es siempre entero, de modo que la posicion
 * espejada da exactamente el valor opuesto desde el punto de vista blanco.
 */

import {
  WHITE, BLACK, EMPTY, PAWN, KNIGHT, BISHOP, ROOK, QUEEN, KING,
  FLAG_EP
} from './chess.js';

export const PIECE_VALUES = Object.freeze({ 1: 100, 2: 325, 3: 335, 4: 500, 5: 975, 6: 0 });

export const DEFAULT_WEIGHTS = Object.freeze({
  material: 1.0,
  pst: 1.0,
  mobility: 1.0,
  kingSafety: 1.0,
  pawnStructure: 1.0,
  passedPawns: 1.0,
  bishopPair: 1.0,
  rookFiles: 1.0,
  centerControl: 1.0,
  development: 1.0,
  aggression: 1.0,
  materialism: 1.0,
  contempt: 0
});

// Valores tapered de material. El punto medio coincide con PIECE_VALUES.
const VAL_MG = new Int32Array([0, 100, 325, 335, 500, 975, 0]);
const VAL_EG = new Int32Array([0, 118, 330, 355, 545, 985, 0]);
// Valores planos para SEE y MVV/LVA (el rey vale "infinito" practico).
const SEE_VAL = new Int32Array([0, 100, 325, 335, 500, 975, 20000]);

const PHASE_UNITS = new Int32Array([0, 0, 1, 1, 2, 4, 0]);
const PHASE_TOTAL = 24;

const KNIGHT_DELTAS = new Int32Array([-33, -31, -18, -14, 14, 18, 31, 33]);
const BISHOP_DELTAS = new Int32Array([-17, -15, 15, 17]);
const ROOK_DELTAS = new Int32Array([-16, -1, 1, 16]);
const KING_DELTAS = new Int32Array([-17, -16, -15, -1, 1, 15, 16, 17]);

// --- Tablas pieza-casilla (indice 0 = a1, 63 = h8; fila 1 primero) -------

const PAWN_MG_T = [
  0, 0, 0, 0, 0, 0, 0, 0,
  0, 2, 4, -12, -12, 6, 8, 2,
  2, 0, 0, 6, 6, -2, 2, -2,
  2, 4, 10, 20, 20, 6, 2, -4,
  6, 8, 16, 24, 24, 12, 6, 0,
  20, 24, 30, 34, 34, 28, 22, 18,
  60, 66, 70, 74, 74, 68, 62, 56,
  0, 0, 0, 0, 0, 0, 0, 0
];
const PAWN_EG_T = [
  0, 0, 0, 0, 0, 0, 0, 0,
  4, 2, 2, 0, 0, 2, 2, 4,
  6, 4, 2, 0, 0, 2, 4, 6,
  12, 10, 6, 4, 4, 6, 10, 12,
  26, 24, 18, 14, 14, 18, 24, 26,
  56, 52, 44, 38, 38, 44, 52, 56,
  96, 92, 84, 78, 78, 84, 92, 96,
  0, 0, 0, 0, 0, 0, 0, 0
];
const KNIGHT_MG_T = [
  -50, -34, -24, -20, -20, -24, -34, -50,
  -30, -12, 2, 6, 6, 2, -12, -30,
  -20, 4, 16, 20, 20, 16, 4, -20,
  -16, 8, 20, 26, 26, 20, 8, -16,
  -16, 8, 22, 28, 28, 22, 8, -16,
  -20, 6, 18, 22, 22, 18, 6, -20,
  -34, -12, 4, 8, 8, 4, -12, -34,
  -60, -36, -24, -20, -20, -24, -36, -60
];
const KNIGHT_EG_T = [
  -46, -32, -22, -16, -16, -22, -32, -46,
  -30, -14, -4, 2, 2, -4, -14, -30,
  -22, -4, 8, 14, 14, 8, -4, -22,
  -16, 2, 14, 20, 20, 14, 2, -16,
  -16, 2, 14, 20, 20, 14, 2, -16,
  -22, -4, 8, 14, 14, 8, -4, -22,
  -30, -14, -4, 2, 2, -4, -14, -30,
  -46, -32, -22, -16, -16, -22, -32, -46
];
const BISHOP_MG_T = [
  -20, -12, -14, -8, -8, -14, -12, -20,
  -8, 8, 4, 2, 2, 4, 8, -8,
  -4, 6, 10, 10, 10, 10, 6, -4,
  -6, 4, 12, 16, 16, 12, 4, -6,
  -6, 6, 12, 16, 16, 12, 6, -6,
  -4, 10, 10, 10, 10, 10, 10, -4,
  -10, 2, 2, 2, 2, 2, 2, -10,
  -22, -10, -12, -10, -10, -12, -10, -22
];
const BISHOP_EG_T = [
  -18, -10, -10, -6, -6, -10, -10, -18,
  -8, 2, 2, 4, 4, 2, 2, -8,
  -4, 4, 8, 8, 8, 8, 4, -4,
  -2, 6, 10, 12, 12, 10, 6, -2,
  -2, 6, 10, 12, 12, 10, 6, -2,
  -4, 4, 8, 8, 8, 8, 4, -4,
  -8, 2, 2, 4, 4, 2, 2, -8,
  -18, -10, -10, -6, -6, -10, -10, -18
];
const ROOK_MG_T = [
  -6, -4, 0, 6, 6, 0, -4, -6,
  -8, 0, 2, 4, 4, 2, 0, -8,
  -8, -2, 0, 2, 2, 0, -2, -8,
  -8, -2, 0, 2, 2, 0, -2, -8,
  -6, 0, 2, 4, 4, 2, 0, -6,
  -4, 2, 6, 8, 8, 6, 2, -4,
  12, 16, 18, 20, 20, 18, 16, 12,
  6, 8, 10, 12, 12, 10, 8, 6
];
const ROOK_EG_T = [
  2, 2, 4, 4, 4, 4, 2, 2,
  0, 2, 2, 2, 2, 2, 2, 0,
  0, 0, 2, 2, 2, 2, 0, 0,
  2, 2, 4, 4, 4, 4, 2, 2,
  4, 4, 6, 6, 6, 6, 4, 4,
  6, 8, 8, 8, 8, 8, 8, 6,
  14, 14, 16, 16, 16, 16, 14, 14,
  8, 8, 10, 10, 10, 10, 8, 8
];
const QUEEN_MG_T = [
  -18, -12, -8, -4, -4, -8, -12, -18,
  -12, -4, -2, 0, 0, -2, -4, -12,
  -8, -2, 2, 4, 4, 2, -2, -8,
  -4, 0, 4, 6, 6, 4, 0, -4,
  -4, 0, 4, 6, 6, 4, 0, -4,
  -8, -2, 2, 4, 4, 2, -2, -8,
  -12, -4, -2, 0, 0, -2, -4, -12,
  -18, -12, -8, -4, -4, -8, -12, -18
];
const QUEEN_EG_T = [
  -34, -24, -18, -10, -10, -18, -24, -34,
  -24, -12, -6, 0, 0, -6, -12, -24,
  -18, -6, 4, 10, 10, 4, -6, -18,
  -10, 0, 10, 18, 18, 10, 0, -10,
  -10, 0, 10, 18, 18, 10, 0, -10,
  -18, -6, 4, 10, 10, 4, -6, -18,
  -24, -12, -6, 0, 0, -6, -12, -24,
  -34, -24, -18, -10, -10, -18, -24, -34
];
const KING_MG_T = [
  20, 32, 10, -12, 0, -14, 34, 22,
  14, 16, -4, -18, -18, -6, 18, 16,
  -12, -18, -22, -28, -28, -22, -18, -12,
  -26, -32, -36, -42, -42, -36, -32, -26,
  -36, -42, -46, -52, -52, -46, -42, -36,
  -44, -50, -54, -60, -60, -54, -50, -44,
  -50, -56, -60, -64, -64, -60, -56, -50,
  -56, -60, -64, -68, -68, -64, -60, -56
];
const KING_EG_T = [
  -54, -34, -22, -18, -18, -22, -34, -54,
  -22, -6, 8, 12, 12, 8, -6, -22,
  -14, 10, 24, 30, 30, 24, 10, -14,
  -12, 14, 30, 38, 38, 30, 14, -12,
  -12, 14, 30, 38, 38, 30, 14, -12,
  -14, 10, 24, 30, 30, 24, 10, -14,
  -22, -6, 8, 12, 12, 8, -6, -22,
  -54, -34, -22, -18, -18, -22, -34, -54
];

const PST_MG = [
  new Int32Array(64), new Int32Array(PAWN_MG_T), new Int32Array(KNIGHT_MG_T),
  new Int32Array(BISHOP_MG_T), new Int32Array(ROOK_MG_T), new Int32Array(QUEEN_MG_T),
  new Int32Array(KING_MG_T)
];
const PST_EG = [
  new Int32Array(64), new Int32Array(PAWN_EG_T), new Int32Array(KNIGHT_EG_T),
  new Int32Array(BISHOP_EG_T), new Int32Array(ROOK_EG_T), new Int32Array(QUEEN_EG_T),
  new Int32Array(KING_EG_T)
];

// --- Tablas de movilidad -------------------------------------------------

const MOB_MG = [
  null, null,
  new Int32Array([-32, -18, -8, 0, 6, 12, 16, 20, 22]),
  new Int32Array([-30, -16, -6, 2, 8, 13, 17, 20, 23, 25, 27, 29, 31, 33]),
  new Int32Array([-22, -12, -6, -2, 1, 4, 7, 10, 13, 15, 17, 19, 20, 21, 22]),
  new Int32Array(28)
];
const MOB_EG = [
  null, null,
  new Int32Array([-34, -20, -10, 0, 6, 12, 16, 19, 21]),
  new Int32Array([-32, -18, -8, 2, 9, 15, 20, 24, 27, 29, 31, 33, 35, 37]),
  new Int32Array([-28, -16, -6, 0, 6, 12, 17, 21, 25, 28, 30, 32, 34, 35, 36]),
  new Int32Array(28)
];
for (let i = 0; i < 28; i++) {
  MOB_MG[QUEEN][i] = -14 + i;
  MOB_EG[QUEEN][i] = i < 20 ? -22 + 2 * i : 18;
}

// --- Tablas auxiliares ---------------------------------------------------

// Pesos de ataque a la zona del rey por tipo de pieza.
const KING_ATTACK_WEIGHT = new Int32Array([0, 0, 20, 20, 40, 80, 0]);
// Multiplicador (en %) segun cuantas piezas distintas atacan la zona.
const ATTACK_COUNT_MULT = new Int32Array([0, 0, 50, 75, 88, 94, 97, 99, 100, 100, 100]);

const SHELTER_PEN = new Int32Array([0, 0, 8, 18, 26, 30, 30, 30, 30]);
const STORM_PEN = new Int32Array([0, 0, 24, 14, 6, 0, 0, 0, 0]);

const PASSED_MG = new Int32Array([0, 0, 6, 12, 24, 46, 78, 0]);
const PASSED_EG = new Int32Array([0, 4, 12, 26, 50, 88, 140, 0]);

const ISLAND_PEN_MG = 8;
const ISLAND_PEN_EG = 12;

const CENTER = new Int8Array(128);
CENTER[0x33] = 1; // d4
CENTER[0x34] = 1; // e4
CENTER[0x43] = 1; // d5
CENTER[0x44] = 1; // e5

// FRONT_MASK[color][rank]: filas estrictamente por delante para ese color.
// BEHIND_INCL[color][rank]: filas por detras incluyendo la propia.
const FRONT_MASK = [new Int32Array(8), new Int32Array(8)];
const BEHIND_INCL = [new Int32Array(8), new Int32Array(8)];
for (let r = 0; r < 8; r++) {
  let wf = 0;
  for (let k = r + 1; k < 8; k++) wf |= 1 << k;
  let bf = 0;
  for (let k = r - 1; k >= 0; k--) bf |= 1 << k;
  FRONT_MASK[WHITE][r] = wf;
  FRONT_MASK[BLACK][r] = bf;
  let wb = 0;
  for (let k = 0; k <= r; k++) wb |= 1 << k;
  let bb = 0;
  for (let k = r; k < 8; k++) bb |= 1 << k;
  BEHIND_INCL[WHITE][r] = wb;
  BEHIND_INCL[BLACK][r] = bb;
}

// --- Memoria de trabajo (se reescribe entera en cada llamada) ------------

const pawnAtkW = new Int32Array(128);
const pawnAtkB = new Int32Array(128);
const pawnAtkMaps = [pawnAtkW, pawnAtkB];
const zoneW = new Int32Array(128);
const zoneB = new Int32Array(128);
const zoneMaps = [zoneW, zoneB];
const pawnMaskW = new Int32Array(8);
const pawnMaskB = new Int32Array(8);
const pawnMasks = [pawnMaskW, pawnMaskB];
const pieceSqW = new Int32Array(24);
const pieceSqB = new Int32Array(24);
const pieceSqs = [pieceSqW, pieceSqB];
const pawnSqW = new Int32Array(16);
const pawnSqB = new Int32Array(16);
const pawnSqs = [pawnSqW, pawnSqB];
const typeCountW = new Int32Array(7);
const typeCountB = new Int32Array(7);
const typeCounts = [typeCountW, typeCountB];
const pieceCount = new Int32Array(2);
const pawnCount = new Int32Array(2);
let stamp = 0;

function wnum(w, key, dflt) {
  const v = w[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : dflt;
}

function lowBitIndex(mask) {
  return 31 - Math.clz32(mask & -mask);
}

function highBitIndex(mask) {
  return 31 - Math.clz32(mask);
}

function popcount8(mask) {
  let n = 0;
  let m = mask;
  while (m !== 0) {
    m &= m - 1;
    n++;
  }
  return n;
}

export function gamePhase(pos) {
  const b = pos.board;
  let units = 0;
  for (let sq = 0; sq < 128; sq++) {
    if (sq & 0x88) {
      sq += 7;
      continue;
    }
    const pc = b[sq];
    if (pc === EMPTY) continue;
    units += PHASE_UNITS[pc & 7];
  }
  if (units > PHASE_TOTAL) units = PHASE_TOTAL;
  return ((units * 256) / PHASE_TOTAL) | 0;
}

export function hasNonPawnMaterial(pos, color) {
  const b = pos.board;
  const want = color << 3;
  for (let sq = 0; sq < 128; sq++) {
    if (sq & 0x88) {
      sq += 7;
      continue;
    }
    const pc = b[sq];
    if (pc === EMPTY) continue;
    if ((pc >> 3) !== color) continue;
    const t = pc & 7;
    if (t !== PAWN && t !== KING) return true;
  }
  return want >= 0 ? false : false;
}

// Recorre el tablero una sola vez y llena las estructuras de trabajo.
function scanBoard(pos) {
  const b = pos.board;
  stamp++;
  if (stamp > 0x3fffffff) {
    stamp = 1;
    pawnAtkW.fill(0);
    pawnAtkB.fill(0);
    zoneW.fill(0);
    zoneB.fill(0);
  }
  pieceCount[0] = 0;
  pieceCount[1] = 0;
  pawnCount[0] = 0;
  pawnCount[1] = 0;
  pawnMaskW.fill(0);
  pawnMaskB.fill(0);
  typeCountW.fill(0);
  typeCountB.fill(0);

  let units = 0;
  for (let sq = 0; sq < 128; sq++) {
    if (sq & 0x88) {
      sq += 7;
      continue;
    }
    const pc = b[sq];
    if (pc === EMPTY) continue;
    const c = pc >> 3;
    const t = pc & 7;
    typeCounts[c][t]++;
    units += PHASE_UNITS[t];
    if (t === PAWN) {
      if (pawnCount[c] < 16) pawnSqs[c][pawnCount[c]++] = sq;
      pawnMasks[c][sq & 7] |= 1 << (sq >> 4);
      const up = c === WHITE ? 16 : -16;
      const map = pawnAtkMaps[c];
      let a = sq + up - 1;
      if (!(a & 0x88)) map[a] = stamp;
      a = sq + up + 1;
      if (!(a & 0x88)) map[a] = stamp;
    } else if (t !== KING) {
      if (pieceCount[c] < 24) pieceSqs[c][pieceCount[c]++] = sq;
    }
  }

  for (let c = 0; c < 2; c++) {
    const ksq = pos.kingSq[c];
    const map = zoneMaps[c];
    const up = c === WHITE ? 16 : -16;
    map[ksq] = stamp;
    for (let i = 0; i < 8; i++) {
      const s = ksq + KING_DELTAS[i];
      if (!(s & 0x88)) map[s] = stamp;
    }
    for (let d = -1; d <= 1; d++) {
      const s = ksq + up + up + d;
      if (!(s & 0x88)) map[s] = stamp;
    }
  }

  if (units > PHASE_TOTAL) units = PHASE_TOTAL;
  return ((units * 256) / PHASE_TOTAL) | 0;
}

/*
 * Nucleo de la evaluacion. Todos los acumuladores son enteros y cada termino
 * se calcula con el mismo codigo para ambos bandos (rango relativo + signo),
 * de modo que la posicion espejada produce exactamente los valores opuestos.
 */
function runEval(pos, weights, detail) {
  const b = pos.board;
  const phase = scanBoard(pos);

  let matMg = 0, matEg = 0;
  let pstMg = 0, pstEg = 0;
  let mobMg = 0, mobEg = 0;
  let shMg = 0, shEg = 0;
  let atkMg = 0, atkEg = 0;
  let pwMg = 0, pwEg = 0;
  let psMg = 0, psEg = 0;
  let bpMg = 0, bpEg = 0;
  let rkMg = 0, rkEg = 0;
  let ceMg = 0, ceEg = 0;
  let dvMg = 0, dvEg = 0;
  let pcMg = 0, pcEg = 0;

  for (let c = 0; c < 2; c++) {
    const them = c ^ 1;
    const sign = c === WHITE ? 1 : -1;
    const up = c === WHITE ? 16 : -16;
    const myMask = pawnMasks[c];
    const theirMask = pawnMasks[them];
    const myPawnAtk = pawnAtkMaps[c];
    const theirPawnAtk = pawnAtkMaps[them];
    const zone = zoneMaps[them];
    const myTypes = typeCounts[c];
    const homeRank = c === WHITE ? 0 : 7;
    const ksq = pos.kingSq[c];
    const theirKsq = pos.kingSq[them];

    let attackUnits = 0;
    let attackerCount = 0;
    let centerMg = 0;
    let centerEg = 0;

    // --- Piezas (sin peones ni rey) -------------------------------------
    const list = pieceSqs[c];
    const n = pieceCount[c];
    for (let i = 0; i < n; i++) {
      const sq = list[i];
      const pt = b[sq] & 7;
      const rank = sq >> 4;
      const file = sq & 7;
      const relRank = c === WHITE ? rank : 7 - rank;
      const pstIdx = (relRank << 3) | file;

      matMg += sign * VAL_MG[pt];
      matEg += sign * VAL_EG[pt];
      pstMg += sign * PST_MG[pt][pstIdx];
      pstEg += sign * PST_EG[pt][pstIdx];
      if (CENTER[sq]) {
        centerMg += 4;
        centerEg += 2;
      }

      let mob = 0;
      let zoneHits = 0;

      if (pt === KNIGHT) {
        for (let d = 0; d < 8; d++) {
          const to = sq + KNIGHT_DELTAS[d];
          if (to & 0x88) continue;
          if (zone[to] === stamp) zoneHits++;
          if (CENTER[to]) centerMg += 3;
          const tgt = b[to];
          if (tgt !== EMPTY && (tgt >> 3) === c) continue;
          if (theirPawnAtk[to] === stamp) continue;
          mob++;
        }
        // Puesto avanzado: casilla protegida por peon propio e inalcanzable
        // por peones enemigos.
        if (relRank >= 3 && relRank <= 5 && myPawnAtk[sq] === stamp) {
          const ahead = FRONT_MASK[c][rank];
          const left = file > 0 ? theirMask[file - 1] : 0;
          const right = file < 7 ? theirMask[file + 1] : 0;
          if (((left | right) & ahead) === 0) {
            pcMg += sign * (file >= 2 && file <= 5 ? 26 : 16);
            pcEg += sign * 14;
          }
        }
      } else if (pt === KING) {
        mob = 0;
      } else {
        const deltas = pt === BISHOP ? BISHOP_DELTAS : pt === ROOK ? ROOK_DELTAS : KING_DELTAS;
        const dirs = pt === QUEEN ? 8 : 4;
        for (let d = 0; d < dirs; d++) {
          const step = deltas[d];
          for (let to = sq + step; !(to & 0x88); to += step) {
            if (zone[to] === stamp) zoneHits++;
            if (CENTER[to]) centerMg += 3;
            const tgt = b[to];
            if (tgt === EMPTY) {
              if (theirPawnAtk[to] !== stamp) mob++;
              continue;
            }
            if ((tgt >> 3) !== c && theirPawnAtk[to] !== stamp) mob++;
            break;
          }
        }

        if (pt === BISHOP) {
          // Alfil malo: peones propios en casillas de su color.
          const bishopColor = ((sq >> 4) + (sq & 7)) & 1;
          let blocked = 0;
          const myPawns = pawnSqs[c];
          for (let p = 0; p < pawnCount[c]; p++) {
            const psq = myPawns[p];
            if ((((psq >> 4) + (psq & 7)) & 1) !== bishopColor) continue;
            blocked++;
            if (b[psq + up] !== EMPTY) blocked++;
          }
          pcMg -= sign * blocked * 4;
          pcEg -= sign * blocked * 6;
        } else if (pt === ROOK) {
          const own = myMask[file];
          const opp = theirMask[file];
          if (own === 0) {
            if (opp === 0) {
              rkMg += sign * 24;
              rkEg += sign * 12;
            } else {
              rkMg += sign * 11;
              rkEg += sign * 6;
            }
          }
          if (relRank === 6) {
            const theirKingRel = c === WHITE ? (theirKsq >> 4) : 7 - (theirKsq >> 4);
            const enemyPawnsOn7 = theirMask[0] | theirMask[1] | theirMask[2] | theirMask[3] |
              theirMask[4] | theirMask[5] | theirMask[6] | theirMask[7];
            const seventh = c === WHITE ? (enemyPawnsOn7 & (1 << 6)) : (enemyPawnsOn7 & (1 << 1));
            if (theirKingRel === 7 || seventh !== 0) {
              rkMg += sign * 22;
              rkEg += sign * 32;
            } else {
              rkMg += sign * 8;
              rkEg += sign * 12;
            }
          }
          // Torres dobladas en la misma columna.
          for (let j = i + 1; j < n; j++) {
            const other = list[j];
            if ((b[other] & 7) === ROOK && (other & 7) === file) {
              rkMg += sign * 14;
              rkEg += sign * 8;
            }
          }
        }
      }

      if (pt !== KING) {
        const table = MOB_MG[pt];
        if (table !== null && table !== undefined) {
          const cap = table.length - 1;
          const m = mob > cap ? cap : mob;
          mobMg += sign * table[m];
          mobEg += sign * MOB_EG[pt][m];
        }
        if (zoneHits > 0) {
          attackUnits += KING_ATTACK_WEIGHT[pt] * zoneHits;
          attackerCount++;
        }
      }
    }

    // --- Rey propio: PST + material (0) ---------------------------------
    {
      const rank = ksq >> 4;
      const file = ksq & 7;
      const relRank = c === WHITE ? rank : 7 - rank;
      const pstIdx = (relRank << 3) | file;
      pstMg += sign * PST_MG[KING][pstIdx];
      pstEg += sign * PST_EG[KING][pstIdx];

      // Escudo de peones y columnas abiertas hacia el rey.
      let shelter = 0;
      let centerFile = file;
      if (centerFile === 0) centerFile = 1;
      else if (centerFile === 7) centerFile = 6;
      for (let f = centerFile - 1; f <= centerFile + 1; f++) {
        const own = myMask[f] & FRONT_MASK[c][rank];
        const opp = theirMask[f] & FRONT_MASK[c][rank];
        if (own === 0) {
          shelter -= 20;
          shelter -= opp === 0 ? 14 : 6;
        } else {
          const nearest = c === WHITE ? lowBitIndex(own) : highBitIndex(own);
          const dist = c === WHITE ? nearest - rank : rank - nearest;
          shelter -= SHELTER_PEN[dist > 8 ? 8 : dist];
        }
        if (opp !== 0) {
          const nearest = c === WHITE ? lowBitIndex(opp) : highBitIndex(opp);
          const dist = c === WHITE ? nearest - rank : rank - nearest;
          shelter -= STORM_PEN[dist > 8 ? 8 : dist];
        }
      }
      shMg += sign * shelter;
    }

    // --- Peones ----------------------------------------------------------
    let islands = 0;
    let prevFile = 0;
    for (let f = 0; f < 8; f++) {
      const mask = myMask[f];
      if (mask !== 0) {
        if (prevFile === 0) islands++;
        prevFile = 1;
        const count = popcount8(mask);
        if (count > 1) {
          pwMg -= sign * 10 * (count - 1);
          pwEg -= sign * 24 * (count - 1);
        }
        const left = f > 0 ? myMask[f - 1] : 0;
        const right = f < 7 ? myMask[f + 1] : 0;
        if ((left | right) === 0) {
          pwMg -= sign * 14 * count;
          pwEg -= sign * 18 * count;
        }
      } else {
        prevFile = 0;
      }
    }
    if (islands > 1) {
      pwMg -= sign * ISLAND_PEN_MG * (islands - 1);
      pwEg -= sign * ISLAND_PEN_EG * (islands - 1);
    }

    const myPawns = pawnSqs[c];
    for (let i = 0; i < pawnCount[c]; i++) {
      const sq = myPawns[i];
      const rank = sq >> 4;
      const file = sq & 7;
      const relRank = c === WHITE ? rank : 7 - rank;
      const pstIdx = (relRank << 3) | file;
      matMg += sign * VAL_MG[PAWN];
      matEg += sign * VAL_EG[PAWN];
      pstMg += sign * PST_MG[PAWN][pstIdx];
      pstEg += sign * PST_EG[PAWN][pstIdx];
      if (CENTER[sq]) {
        centerMg += 12;
        centerEg += 4;
      }
      let a = sq + up - 1;
      if (!(a & 0x88) && CENTER[a]) centerMg += 7;
      a = sq + up + 1;
      if (!(a & 0x88) && CENTER[a]) centerMg += 7;

      const stop = sq + up;
      const ahead = FRONT_MASK[c][rank];
      const left = file > 0 ? theirMask[file - 1] : 0;
      const right = file < 7 ? theirMask[file + 1] : 0;
      const blockers = ((left | right | theirMask[file]) & ahead);

      // Peon retrasado.
      const myLeft = file > 0 ? myMask[file - 1] : 0;
      const myRight = file < 7 ? myMask[file + 1] : 0;
      if (((myLeft | myRight) & BEHIND_INCL[c][rank]) === 0 &&
          !(stop & 0x88) && theirPawnAtk[stop] === stamp) {
        pwMg -= sign * 12;
        pwEg -= sign * 16;
      }

      if (blockers === 0 && relRank > 0 && relRank < 7) {
        // Peon pasado.
        let bonusMg = PASSED_MG[relRank];
        let bonusEg = PASSED_EG[relRank];
        if (myPawnAtk[sq] === stamp) {
          bonusMg += 10;
          bonusEg += 16;
        }
        const sameOrAdjRanks = (1 << rank) | (c === WHITE ? (1 << (rank - 1)) : (1 << (rank + 1)));
        if (((myLeft | myRight) & sameOrAdjRanks) !== 0) {
          bonusMg += 12;
          bonusEg += 20;
        }
        // Torre propia por detras del pasado (o enemiga, que resta).
        const back = -up;
        for (let s = sq + back; !(s & 0x88); s += back) {
          const pc = b[s];
          if (pc === EMPTY) continue;
          if ((pc & 7) === ROOK) {
            if ((pc >> 3) === c) {
              bonusMg += 10;
              bonusEg += 24;
            } else {
              bonusMg -= 8;
              bonusEg -= 20;
            }
          }
          break;
        }
        if (!(stop & 0x88) && b[stop] !== EMPTY) {
          bonusMg -= 6;
          bonusEg -= 12;
        }
        // Regla del cuadrado: en finales sin piezas del rival, un pasado
        // fuera del alcance del rey defensor decide la partida. La condicion
        // es deliberadamente conservadora (independiente del turno).
        if (pieceCount[them] === 0) {
          let steps = 7 - relRank;
          if (relRank === 1) steps--;
          let clear = true;
          for (let s = sq + up; !(s & 0x88); s += up) {
            if (b[s] !== EMPTY) {
              clear = false;
              break;
            }
          }
          if (clear) {
            const promoRank = c === WHITE ? 7 : 0;
            const dr = Math.abs((theirKsq >> 4) - promoRank);
            const df = Math.abs((theirKsq & 7) - file);
            const kingDist = dr > df ? dr : df;
            if (steps + 1 < kingDist) bonusEg += 420;
          }
        }
        psMg += sign * bonusMg;
        psEg += sign * bonusEg;
      }
    }

    // --- Pareja de alfiles ----------------------------------------------
    if (myTypes[BISHOP] >= 2) {
      bpMg += sign * 28;
      bpEg += sign * 48;
    }

    // --- Desarrollo (solo apertura) --------------------------------------
    {
      let undeveloped = 0;
      const b1 = (homeRank << 4) | 1;
      const c1 = (homeRank << 4) | 2;
      const f1 = (homeRank << 4) | 5;
      const g1 = (homeRank << 4) | 6;
      const knight = KNIGHT | (c << 3);
      const bishop = BISHOP | (c << 3);
      if (b[b1] === knight) undeveloped++;
      if (b[g1] === knight) undeveloped++;
      if (b[c1] === bishop) undeveloped++;
      if (b[f1] === bishop) undeveloped++;
      let dev = -13 * undeveloped;
      const queenHome = (homeRank << 4) | 3;
      if (myTypes[QUEEN] > 0 && b[queenHome] !== (QUEEN | (c << 3)) && undeveloped >= 2) {
        dev -= 10 * undeveloped;
      }
      const rights = c === WHITE ? (pos.castling & 3) : (pos.castling & 12);
      if (rights !== 0) dev += 12;
      dvMg += sign * dev;
    }

    // --- Seguridad del rey enemigo ---------------------------------------
    if (attackerCount > 0) {
      const idx = attackerCount > 10 ? 10 : attackerCount;
      const danger = ((attackUnits * ATTACK_COUNT_MULT[idx]) / 100) | 0;
      atkMg += sign * danger;
      atkEg += sign * (danger >> 2);
    }

    ceMg += sign * centerMg;
    ceEg += sign * centerEg;
  }

  const wMaterial = wnum(weights, 'material', 1) * wnum(weights, 'materialism', 1);
  const wPst = wnum(weights, 'pst', 1);
  const wMob = wnum(weights, 'mobility', 1);
  const wKing = wnum(weights, 'kingSafety', 1);
  const wPawn = wnum(weights, 'pawnStructure', 1);
  const wPass = wnum(weights, 'passedPawns', 1);
  const wPair = wnum(weights, 'bishopPair', 1);
  const wRook = wnum(weights, 'rookFiles', 1);
  const wCenter = wnum(weights, 'centerControl', 1);
  const wDev = wnum(weights, 'development', 1);
  const wAggr = wnum(weights, 'aggression', 1);

  const mg = matMg * wMaterial + pstMg * wPst + mobMg * wMob + shMg * wKing +
    atkMg * wAggr + pwMg * wPawn + psMg * wPass + bpMg * wPair + rkMg * wRook +
    ceMg * wCenter + dvMg * wDev + pcMg * wPst;
  const eg = matEg * wMaterial + pstEg * wPst + mobEg * wMob + shEg * wKing +
    atkEg * wAggr + pwEg * wPawn + psEg * wPass + bpEg * wPair + rkEg * wRook +
    ceEg * wCenter + dvEg * wDev + pcEg * wPst;

  const white = (mg * phase + eg * (256 - phase)) / 256;
  // Truncado hacia cero: simetrico respecto al signo.
  const rounded = white < 0 ? -Math.floor(-white) : Math.floor(white);
  const total = pos.turn === WHITE ? rounded : -rounded;

  if (detail !== null) {
    const taper = (a, b2) => {
      const v = (a * phase + b2 * (256 - phase)) / 256;
      return v < 0 ? -Math.floor(-v) : Math.floor(v);
    };
    detail.phase = phase;
    detail.material = taper(matMg * wMaterial, matEg * wMaterial);
    detail.pst = taper(pstMg * wPst, pstEg * wPst);
    detail.mobility = taper(mobMg * wMob, mobEg * wMob);
    detail.kingSafety = taper(shMg * wKing, shEg * wKing);
    detail.kingAttack = taper(atkMg * wAggr, atkEg * wAggr);
    detail.pawnStructure = taper(pwMg * wPawn, pwEg * wPawn);
    detail.passedPawns = taper(psMg * wPass, psEg * wPass);
    detail.bishopPair = taper(bpMg * wPair, bpEg * wPair);
    detail.rookFiles = taper(rkMg * wRook, rkEg * wRook);
    detail.centerControl = taper(ceMg * wCenter, ceEg * wCenter);
    detail.development = taper(dvMg * wDev, dvEg * wDev);
    detail.pieces = taper(pcMg * wPst, pcEg * wPst);
    detail.white = rounded;
    detail.turn = pos.turn;
  }
  return total;
}

export function evaluate(pos, weights = DEFAULT_WEIGHTS) {
  return runEval(pos, weights, null);
}

export function evaluateVerbose(pos, weights = DEFAULT_WEIGHTS) {
  const detail = { total: 0 };
  detail.total = runEval(pos, weights, detail);
  return detail;
}

// --- Intercambio estatico (SEE) -----------------------------------------

const seeBoard = new Int8Array(128);
const seeGain = new Int32Array(40);

// Devuelve la casilla del atacante mas barato de `to` para `side`, o -1.
// Recorre rayos desde `to`, de modo que los ataques descubiertos de piezas
// deslizantes situadas detras del atacante aparecen solos al ir quitando
// piezas del tablero auxiliar.
function leastValuableAttacker(b, to, side) {
  const bit = side << 3;
  const pawn = PAWN | bit;
  if (side === WHITE) {
    let s = to - 15;
    if (!(s & 0x88) && b[s] === pawn) return s;
    s = to - 17;
    if (!(s & 0x88) && b[s] === pawn) return s;
  } else {
    let s = to + 15;
    if (!(s & 0x88) && b[s] === pawn) return s;
    s = to + 17;
    if (!(s & 0x88) && b[s] === pawn) return s;
  }

  const knight = KNIGHT | bit;
  for (let i = 0; i < 8; i++) {
    const s = to + KNIGHT_DELTAS[i];
    if (!(s & 0x88) && b[s] === knight) return s;
  }

  const bishop = BISHOP | bit;
  const rook = ROOK | bit;
  const queen = QUEEN | bit;
  const king = KING | bit;
  let queenSq = -1;
  let kingSq = -1;

  for (let i = 0; i < 4; i++) {
    const d = BISHOP_DELTAS[i];
    let first = true;
    for (let s = to + d; !(s & 0x88); s += d, first = false) {
      const pc = b[s];
      if (pc === EMPTY) continue;
      if (pc === bishop) return s;
      if (pc === queen) queenSq = s;
      else if (pc === king && first) kingSq = s;
      break;
    }
  }
  for (let i = 0; i < 4; i++) {
    const d = ROOK_DELTAS[i];
    let first = true;
    for (let s = to + d; !(s & 0x88); s += d, first = false) {
      const pc = b[s];
      if (pc === EMPTY) continue;
      if (pc === rook) return s;
      if (pc === queen) queenSq = s;
      else if (pc === king && first) kingSq = s;
      break;
    }
  }
  if (queenSq >= 0) return queenSq;
  return kingSq;
}

export function seeCapture(pos, move) {
  const from = move & 0xff;
  const to = (move >>> 8) & 0xff;
  const promo = (move >>> 16) & 7;
  const board = pos.board;
  const mover = board[from];
  if (mover === EMPTY) return 0;
  const us = mover >> 3;

  seeBoard.set(board);
  const b = seeBoard;

  let gain0 = 0;
  if ((move & FLAG_EP) !== 0) {
    const capSq = us === WHITE ? to - 16 : to + 16;
    gain0 = SEE_VAL[PAWN];
    b[capSq] = EMPTY;
  } else if (b[to] !== EMPTY) {
    gain0 = SEE_VAL[b[to] & 7];
  }

  b[from] = EMPTY;
  let onSquare;
  if (promo !== 0) {
    onSquare = SEE_VAL[promo];
    gain0 += SEE_VAL[promo] - SEE_VAL[PAWN];
    b[to] = promo | (us << 3);
  } else {
    onSquare = SEE_VAL[mover & 7];
    b[to] = mover;
  }

  seeGain[0] = gain0;
  let d = 0;
  let side = us ^ 1;

  for (;;) {
    const sq = leastValuableAttacker(b, to, side);
    if (sq < 0) break;
    const pc = b[sq];
    const t = pc & 7;
    if (t === KING) {
      // El rey no puede capturar en una casilla que siga defendida.
      const saved = b[to];
      b[to] = pc;
      b[sq] = EMPTY;
      const stillDefended = leastValuableAttacker(b, to, side ^ 1) >= 0;
      b[sq] = pc;
      b[to] = saved;
      if (stillDefended) break;
    }
    d++;
    if (d >= 32) break;
    let gain = onSquare - seeGain[d - 1];
    let newOn = SEE_VAL[t];
    if (t === PAWN) {
      const rank = to >> 4;
      if ((side === WHITE && rank === 7) || (side === BLACK && rank === 0)) {
        gain += SEE_VAL[QUEEN] - SEE_VAL[PAWN];
        newOn = SEE_VAL[QUEEN];
      }
    }
    seeGain[d] = gain;
    b[sq] = EMPTY;
    b[to] = pc;
    onSquare = newOn;
    side ^= 1;
    const prev = -seeGain[d - 1];
    if ((prev > gain ? prev : gain) < 0) break;
  }

  while (d > 0) {
    const a = -seeGain[d - 1];
    const bb = seeGain[d];
    seeGain[d - 1] = -(a > bb ? a : bb);
    d--;
  }
  return seeGain[0];
}

// Valores planos exportados para la ordenacion de jugadas del motor.
export const SEE_PIECE_VALUES = SEE_VAL;
