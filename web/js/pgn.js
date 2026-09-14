/*
 * pgn.js — lectura y escritura de partidas en formato PGN.
 * Construye el texto PGN (cabeceras, movetext plegado a 80 columnas y
 * comentarios de reloj %clk) y lo vuelve a analizar tolerando comentarios,
 * variantes anidadas y NAGs. Tambien reproduce una partida sobre chess.js
 * para obtener las jugadas codificadas y la FEN final.
 * Modulo agnostico del entorno.
 */

import { START_FEN, createPosition, setFen, getFen, sanToMove, makeMove } from './chess.js';

const ROSTER = ['Event', 'Site', 'Date', 'Round', 'White', 'Black', 'Result'];
const ROSTER_DEFAULTS = {
  Event: 'Partida amistosa',
  Site: 'Ajedrez Maestro',
  Date: '????.??.??',
  Round: '-',
  White: 'Blancas',
  Black: 'Negras',
  Result: '*'
};
const RESULTS = ['1-0', '0-1', '1/2-1/2', '*'];
const MAX_LINE = 80;

function escapeTagValue(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function unescapeTagValue(value) {
  return value.replace(/\\(["\\])/g, '$1');
}

export function buildPgn({ headers = {}, sanMoves = [], result = '*', clocks = null } = {}) {
  const finalResult = RESULTS.indexOf(result) >= 0 ? result : '*';
  const emitted = new Set();
  let text = '';

  for (let i = 0; i < ROSTER.length; i++) {
    const key = ROSTER[i];
    let value = Object.prototype.hasOwnProperty.call(headers, key) ? headers[key] : ROSTER_DEFAULTS[key];
    if (key === 'Result') value = finalResult;
    if (value === undefined || value === null || value === '') value = ROSTER_DEFAULTS[key];
    text += '[' + key + ' "' + escapeTagValue(value) + '"]\n';
    emitted.add(key);
  }
  for (const key of Object.keys(headers)) {
    if (emitted.has(key)) continue;
    const value = headers[key];
    if (value === undefined || value === null || value === '') continue;
    text += '[' + key + ' "' + escapeTagValue(value) + '"]\n';
  }
  text += '\n';

  const tokens = [];
  for (let i = 0; i < sanMoves.length; i++) {
    if (i % 2 === 0) tokens.push(String(i / 2 + 1) + '.');
    tokens.push(String(sanMoves[i]));
    if (clocks && clocks[i]) tokens.push('{[%clk ' + clocks[i] + ']}');
  }
  tokens.push(finalResult);

  let line = '';
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (line === '') {
      line = token;
    } else if (line.length + 1 + token.length <= MAX_LINE) {
      line += ' ' + token;
    } else {
      text += line + '\n';
      line = token;
    }
  }
  if (line !== '') text += line + '\n';
  return text;
}

function splitSections(text) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  const headers = {};
  let i = 0;
  for (; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '') continue;
    const match = /^\[\s*([A-Za-z0-9_]+)\s*"((?:[^"\\]|\\.)*)"\s*\]$/.exec(line);
    if (match === null) break;
    headers[match[1]] = unescapeTagValue(match[2]);
  }
  return { headers, movetext: lines.slice(i).join('\n') };
}

function stripAnnotations(movetext) {
  let out = '';
  let depth = 0;
  for (let i = 0; i < movetext.length; i++) {
    const ch = movetext[i];
    if (ch === '{') {
      while (i < movetext.length && movetext[i] !== '}') i++;
      out += ' ';
      continue;
    }
    if (ch === ';') {
      while (i < movetext.length && movetext[i] !== '\n') i++;
      out += ' ';
      continue;
    }
    if (ch === '<') {
      while (i < movetext.length && movetext[i] !== '>') i++;
      out += ' ';
      continue;
    }
    if (ch === '(') {
      depth++;
      continue;
    }
    if (ch === ')') {
      if (depth > 0) depth--;
      out += ' ';
      continue;
    }
    if (depth > 0) continue;
    out += ch;
  }
  return out;
}

export function parsePgn(text) {
  const { headers, movetext } = splitSections(text);
  const cleaned = stripAnnotations(movetext);
  const sanMoves = [];
  let result = '*';
  let sawResult = false;

  const rawTokens = cleaned.split(/\s+/);
  for (let i = 0; i < rawTokens.length; i++) {
    let token = rawTokens[i];
    if (token === '') continue;
    if (RESULTS.indexOf(token) >= 0) {
      result = token;
      sawResult = true;
      continue;
    }
    if (token[0] === '$') continue;
    token = token.replace(/^\d+\.*/, '');
    token = token.replace(/^\.+/, '');
    if (token === '') continue;
    if (token === '--' || token === 'Z0') continue;
    sanMoves.push(token);
  }
  if (!sawResult && headers.Result && RESULTS.indexOf(headers.Result) >= 0) {
    result = headers.Result;
  }
  return { headers, sanMoves, result };
}

export function pgnToPositions(pgnText) {
  const parsed = parsePgn(pgnText);
  const startFen = parsed.headers.FEN || START_FEN;
  const pos = createPosition(START_FEN);
  setFen(pos, startFen);
  const moves = [];
  for (let i = 0; i < parsed.sanMoves.length; i++) {
    const san = parsed.sanMoves[i];
    const move = sanToMove(pos, san);
    if (move === -1) {
      throw new Error('PGN inválido: la jugada "' + san + '" no es legal en la posición ' + (i + 1) + '.');
    }
    moves.push(move);
    makeMove(pos, move);
  }
  return { headers: parsed.headers, moves, finalFen: getFen(pos) };
}
