/**
 * board.js — the interactive board widget. It knows nothing about chess rules:
 * it renders a FEN, offers drag/click/keyboard interaction and asks the host
 * (via onMoveAttempt) whether a move is acceptable. Squares are addressed with
 * algebraic names ('e4') so the widget stays decoupled from chess.js internals.
 */

import { pieceNode, pieceSvg } from './pieces.js';

export const BOARD_THEMES = [
  { id: 'verde', name: 'Verde' },
  { id: 'marron', name: 'Marrón' },
  { id: 'azul', name: 'Azul' },
  { id: 'gris', name: 'Gris' },
  { id: 'madera', name: 'Madera' },
  { id: 'noche', name: 'Noche' },
];

const FILES = 'abcdefgh';
const FEN_TO_CODE = { p: 1, n: 2, b: 3, r: 4, q: 5, k: 6 };
const PROMO_ORDER = ['q', 'r', 'b', 'n'];
const PROMO_CODE = { q: 5, r: 4, b: 3, n: 2 };

function squareName(file, rank) {
  return FILES[file] + (rank + 1);
}

function parseSquare(name) {
  const file = FILES.indexOf(name[0]);
  const rank = Number(name[1]) - 1;
  if (file < 0 || rank < 0 || rank > 7) return null;
  return { file, rank };
}

/** FEN board field -> Map<'e4', pieceCode>. */
function fenToMap(fen) {
  const map = new Map();
  const rows = String(fen).split(' ')[0].split('/');
  for (let r = 0; r < 8 && r < rows.length; r++) {
    const rank = 7 - r;
    let file = 0;
    for (const ch of rows[r]) {
      if (ch >= '1' && ch <= '8') {
        file += Number(ch);
        continue;
      }
      const lower = ch.toLowerCase();
      const type = FEN_TO_CODE[lower];
      if (type && file < 8) {
        map.set(squareName(file, rank), ch === lower ? type | 8 : type);
      }
      file += 1;
    }
  }
  return map;
}

export function createBoard(container, opts = {}) {
  const cfg = {
    orientation: 'white',
    pieceSet: 'clasico',
    theme: 'verde',
    coordinates: true,
    interactive: true,
    showLegal: true,
    animationMs: 180,
    onMoveAttempt: null,
    onPromotion: null,
    onSquareClick: null,
    onPremove: null,
    ...opts,
  };

  /* ------------------------------ DOM ------------------------------ */

  const wrap = document.createElement('div');
  wrap.className = 'board-wrap';

  const board = document.createElement('div');
  board.className = 'board';
  board.dataset.theme = cfg.theme;
  board.tabIndex = 0;
  board.setAttribute('role', 'application');
  board.setAttribute('aria-label', 'Tablero de ajedrez');

  const squares = new Map();   // 'e4' -> square element
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const sq = document.createElement('div');
      sq.className = 'board__square';
      board.appendChild(sq);
    }
  }

  const markLayer = document.createElement('div');
  markLayer.className = 'board__layer';

  const pieceLayer = document.createElement('div');
  pieceLayer.className = 'board__pieces';

  const arrowLayer = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  arrowLayer.setAttribute('class', 'board__arrows');
  arrowLayer.setAttribute('viewBox', '0 0 8 8');
  arrowLayer.setAttribute('preserveAspectRatio', 'none');

  wrap.append(board, markLayer, pieceLayer, arrowLayer);
  container.appendChild(wrap);

  /* ----------------------------- state ----------------------------- */

  let orientation = cfg.orientation;
  let pieceSet = cfg.pieceSet;
  let showCoordinates = cfg.coordinates;
  let interactive = cfg.interactive;
  let showLegal = cfg.showLegal;
  let animationMs = cfg.animationMs;
  let movableColor = 'both';

  let pieces = new Map();       // 'e4' -> { el, code }
  let legalMoves = new Map();   // 'e2' -> [{ to, capture, promotion }]
  let currentFen = '';
  let selected = null;
  let cursor = 'e4';
  let checkSquare = null;
  let lastMoveSquares = null;
  let premove = null;
  let destroyed = false;

  let drag = null;              // { from, el, rect, size, pointerId, moved }
  let arrowDraw = null;         // { from }
  const userArrows = [];        // right-click annotations
  const userCircles = new Set();
  let promoOpen = null;

  /* --------------------------- geometry ---------------------------- */

  function squareToCell(name) {
    const p = parseSquare(name);
    if (!p) return null;
    return orientation === 'white'
      ? { col: p.file, row: 7 - p.rank }
      : { col: 7 - p.file, row: p.rank };
  }

  function cellToSquare(col, row) {
    if (col < 0 || col > 7 || row < 0 || row > 7) return null;
    return orientation === 'white'
      ? squareName(col, 7 - row)
      : squareName(7 - col, row);
  }

  function squareIndex(name) {
    const cell = squareToCell(name);
    return cell ? cell.row * 8 + cell.col : -1;
  }

  function pointToSquare(clientX, clientY) {
    const rect = wrap.getBoundingClientRect();
    const size = rect.width / 8;
    const col = Math.floor((clientX - rect.left) / size);
    const row = Math.floor((clientY - rect.top) / size);
    return cellToSquare(col, row);
  }

  function placeAt(el, name, animate) {
    const cell = squareToCell(name);
    if (!cell) return;
    el.classList.toggle('no-anim', !animate);
    el.style.transform = `translate(${cell.col * 100}%, ${cell.row * 100}%)`;
    if (!animate) {
      // Force a reflow so the next animated move starts from this position.
      void el.offsetWidth;
      el.classList.remove('no-anim');
    }
  }

  /* ---------------------------- squares ---------------------------- */

  function paintSquares() {
    const children = board.children;
    squares.clear();
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        const el = children[row * 8 + col];
        const name = cellToSquare(col, row);
        const p = parseSquare(name);
        const light = (p.file + p.rank) % 2 === 1;
        el.className = `board__square ${light ? 'sq--light' : 'sq--dark'}`;
        el.dataset.square = name;
        el.textContent = '';
        if (showCoordinates) {
          if (row === 7) {
            const f = document.createElement('span');
            f.className = 'board__coord board__coord--file';
            f.textContent = name[0];
            el.appendChild(f);
          }
          if (col === 0) {
            const r = document.createElement('span');
            r.className = 'board__coord board__coord--rank';
            r.textContent = name[1];
            el.appendChild(r);
          }
        }
        squares.set(name, el);
      }
    }
  }

  /* ----------------------------- marks ----------------------------- */

  function mark(name, className) {
    const cell = squareToCell(name);
    if (!cell) return null;
    const el = document.createElement('div');
    el.className = `board__mark ${className}`;
    el.style.transform = `translate(${cell.col * 100}%, ${cell.row * 100}%)`;
    el.style.left = '0';
    el.style.top = '0';
    markLayer.appendChild(el);
    return el;
  }

  function renderMarks() {
    markLayer.textContent = '';
    if (lastMoveSquares) {
      mark(lastMoveSquares.from, 'mark--last');
      mark(lastMoveSquares.to, 'mark--last');
    }
    if (premove) {
      mark(premove.from, 'mark--premove');
      mark(premove.to, 'mark--premove');
    }
    if (checkSquare) mark(checkSquare, 'mark--check');
    for (const sq of userCircles) {
      const el = mark(sq, 'mark--select');
      if (el) el.style.opacity = '.5';
    }
    if (selected) mark(selected, 'mark--select');
    if (selected && showLegal) {
      for (const dest of legalMoves.get(selected) || []) {
        const el = mark(dest.to, 'mark--dest');
        if (el && dest.capture) el.classList.add('is-capture');
      }
    }
  }

  /* ---------------------------- pieces ----------------------------- */

  function makePiece(code, name) {
    const el = document.createElement('div');
    el.className = 'board__piece';
    el.dataset.code = String(code);
    el.appendChild(pieceNode(code, pieceSet));
    placeAt(el, name, false);
    pieceLayer.appendChild(el);
    return el;
  }

  function setPosition(fen, options = {}) {
    const { animate = true, lastMove = null } = options;
    currentFen = fen;
    lastMoveSquares = lastMove;
    const desired = fenToMap(fen);
    const useAnim = animate && animationMs > 0;

    // Keep every square whose piece is unchanged.
    const keep = new Map();
    const spare = [];
    for (const [sq, entry] of pieces) {
      if (desired.get(sq) === entry.code) keep.set(sq, entry);
      else spare.push({ sq, ...entry });
    }

    // Promotion: reuse the pawn element so it glides to the last rank.
    if (lastMove && lastMove.promotion) {
      const src = spare.find((s) => s.sq === lastMove.from);
      const wantCode = desired.get(lastMove.to);
      if (src && wantCode) {
        src.el.textContent = '';
        src.el.appendChild(pieceNode(wantCode, pieceSet));
        src.el.dataset.code = String(wantCode);
        src.code = wantCode;
      }
    }

    const next = new Map(keep);
    const needed = [];
    for (const [sq, code] of desired) {
      if (keep.has(sq)) continue;
      needed.push({ sq, code });
    }

    // Match each needed square with the closest spare piece of the same code,
    // preferring the square the last move came from.
    for (const need of needed) {
      let bestIndex = -1;
      let bestScore = Infinity;
      for (let i = 0; i < spare.length; i++) {
        const cand = spare[i];
        if (!cand || cand.code !== need.code) continue;
        const isLastFrom = lastMove && cand.sq === lastMove.from && need.sq === lastMove.to;
        const a = parseSquare(cand.sq);
        const b = parseSquare(need.sq);
        const dist = Math.abs(a.file - b.file) + Math.abs(a.rank - b.rank);
        const score = isLastFrom ? -100 : dist;
        if (score < bestScore) { bestScore = score; bestIndex = i; }
      }
      if (bestIndex >= 0) {
        const src = spare[bestIndex];
        spare[bestIndex] = null;
        placeAt(src.el, need.sq, useAnim);
        next.set(need.sq, { el: src.el, code: need.code });
      } else {
        next.set(need.sq, { el: makePiece(need.code, need.sq), code: need.code });
      }
    }

    // Anything left over was captured.
    for (const leftover of spare) {
      if (!leftover) continue;
      const { el } = leftover;
      if (useAnim) {
        el.style.transition = 'opacity 120ms linear';
        el.style.opacity = '0';
        setTimeout(() => el.remove(), 130);
      } else {
        el.remove();
      }
    }

    pieces = next;
    renderMarks();
  }

  function rebuildPieces() {
    pieceLayer.textContent = '';
    pieces = new Map();
    if (currentFen) setPosition(currentFen, { animate: false, lastMove: lastMoveSquares });
  }

  /* --------------------------- promotion --------------------------- */

  function closePromotion(result) {
    if (!promoOpen) return;
    const { node, resolve } = promoOpen;
    promoOpen = null;
    node.remove();
    resolve(result);
  }

  function askPromotion(to, color) {
    closePromotion(null);
    return new Promise((resolve) => {
      const cell = squareToCell(to);
      const node = document.createElement('div');
      node.className = 'promo';
      const downward = cell.row > 3;
      node.style.left = `${cell.col * 12.5}%`;
      if (downward) node.style.bottom = `${(7 - cell.row) * 12.5}%`;
      else node.style.top = `${cell.row * 12.5}%`;

      const order = downward ? [...PROMO_ORDER].reverse() : PROMO_ORDER;
      for (const letter of order) {
        const btn = document.createElement('button');
        btn.className = 'promo__opt';
        btn.type = 'button';
        btn.innerHTML = pieceSvg(PROMO_CODE[letter] | (color === 'b' ? 8 : 0), pieceSet);
        btn.setAttribute('aria-label', `Promocionar a ${{ q: 'dama', r: 'torre', b: 'alfil', n: 'caballo' }[letter]}`);
        btn.addEventListener('click', (ev) => { ev.stopPropagation(); closePromotion(letter); });
        node.appendChild(btn);
      }
      const cancel = document.createElement('button');
      cancel.className = 'promo__cancel';
      cancel.type = 'button';
      cancel.textContent = 'Cancelar';
      cancel.addEventListener('click', (ev) => { ev.stopPropagation(); closePromotion(null); });
      node.appendChild(cancel);

      wrap.appendChild(node);
      promoOpen = { node, resolve };
    });
  }

  /* ------------------------- move attempts ------------------------- */

  function legalDest(from, to) {
    const list = legalMoves.get(from);
    if (!list) return null;
    return list.find((m) => m.to === to) || null;
  }

  function canPickUp(name) {
    if (!interactive || movableColor === 'none') return false;
    const entry = pieces.get(name);
    if (!entry) return false;
    const color = entry.code >> 3 === 0 ? 'white' : 'black';
    if (movableColor !== 'both' && movableColor !== color) return false;
    return true;
  }

  async function attemptMove(from, to) {
    if (from === to) return false;
    const dest = legalDest(from, to);

    if (!dest) {
      // Not legal now: offer it as a premove when the host wants premoves.
      if (cfg.onPremove && movableColor !== 'none' && pieces.has(from)) {
        premove = { from, to };
        renderMarks();
        cfg.onPremove(from, to);
        return false;
      }
      shake(from);
      return false;
    }

    let promotion = null;
    if (dest.promotion) {
      const color = (pieces.get(from)?.code >> 3) === 0 ? 'w' : 'b';
      promotion = cfg.onPromotion
        ? await cfg.onPromotion(from, to, color)
        : await askPromotion(to, color);
      if (!promotion) {
        renderMarks();
        return false;
      }
    }

    const ok = cfg.onMoveAttempt ? await cfg.onMoveAttempt(from, to, promotion) : false;
    if (!ok) shake(from);
    return !!ok;
  }

  function shake(name) {
    const entry = pieces.get(name);
    if (!entry) return;
    entry.el.classList.add('is-shaking');
    setTimeout(() => entry.el.classList.remove('is-shaking'), 340);
  }

  /* --------------------------- interaction ------------------------- */

  function clearHoverTarget() {
    for (const el of squares.values()) el.classList.remove('is-hover-target');
  }

  function onPointerDown(ev) {
    if (promoOpen) { closePromotion(null); return; }

    const name = pointToSquare(ev.clientX, ev.clientY);
    if (!name) return;

    // Right button: annotation arrows and circles.
    if (ev.button === 2) {
      arrowDraw = { from: name };
      ev.preventDefault();
      return;
    }
    if (ev.button !== 0) return;

    if (userArrows.length || userCircles.size) {
      userArrows.length = 0;
      userCircles.clear();
      renderArrows();
      renderMarks();
    }

    if (premove) { premove = null; renderMarks(); }
    if (cfg.onSquareClick) cfg.onSquareClick(name);

    if (selected && selected !== name) {
      const from = selected;
      selected = null;
      renderMarks();
      if (legalDest(from, name) || cfg.onPremove) {
        attemptMove(from, name);
        return;
      }
    }

    if (!canPickUp(name)) {
      if (selected) { selected = null; renderMarks(); }
      return;
    }

    selected = selected === name ? null : name;
    renderMarks();

    if (!selected) return;

    const entry = pieces.get(name);
    const rect = wrap.getBoundingClientRect();
    drag = {
      from: name,
      el: entry.el,
      size: rect.width / 8,
      rect,
      pointerId: ev.pointerId,
      moved: false,
    };
    entry.el.classList.add('is-dragging');
    moveDragged(ev.clientX, ev.clientY);
    try { wrap.setPointerCapture(ev.pointerId); } catch { /* ignore */ }
    ev.preventDefault();
  }

  function moveDragged(clientX, clientY) {
    if (!drag) return;
    const x = clientX - drag.rect.left - drag.size / 2;
    const y = clientY - drag.rect.top - drag.size / 2;
    drag.el.style.transform = `translate(${x}px, ${y}px) scale(1.06)`;
  }

  function onPointerMove(ev) {
    if (arrowDraw) return;
    if (!drag || ev.pointerId !== drag.pointerId) return;
    if (!drag.moved) {
      const entry = pieces.get(drag.from);
      if (entry) entry.el.classList.add('is-dragging');
      drag.moved = true;
    }
    moveDragged(ev.clientX, ev.clientY);
    clearHoverTarget();
    const over = pointToSquare(ev.clientX, ev.clientY);
    if (over && over !== drag.from && legalDest(drag.from, over)) {
      squares.get(over)?.classList.add('is-hover-target');
    }
  }

  async function onPointerUp(ev) {
    if (arrowDraw) {
      const to = pointToSquare(ev.clientX, ev.clientY);
      if (to && to !== arrowDraw.from) {
        const key = `${arrowDraw.from}${to}`;
        const idx = userArrows.findIndex((a) => `${a.from}${a.to}` === key);
        if (idx >= 0) userArrows.splice(idx, 1);
        else userArrows.push({ from: arrowDraw.from, to, color: '#E8A33D' });
        renderArrows();
      } else if (to) {
        if (userCircles.has(to)) userCircles.delete(to);
        else userCircles.add(to);
        renderMarks();
      }
      arrowDraw = null;
      return;
    }

    if (!drag || ev.pointerId !== drag.pointerId) return;
    const { from, el, moved } = drag;
    drag = null;
    clearHoverTarget();
    el.classList.remove('is-dragging');
    try { wrap.releasePointerCapture(ev.pointerId); } catch { /* ignore */ }

    const to = pointToSquare(ev.clientX, ev.clientY);
    if (!moved || !to || to === from) {
      placeAt(el, from, false);
      return;
    }

    selected = null;
    placeAt(el, from, false);
    renderMarks();
    await attemptMove(from, to);
  }

  function onKeyDown(ev) {
    if (!interactive) return;
    const cell = squareToCell(cursor) || { col: 4, row: 4 };
    let { col, row } = cell;
    switch (ev.key) {
      case 'ArrowLeft': col -= 1; break;
      case 'ArrowRight': col += 1; break;
      case 'ArrowUp': row -= 1; break;
      case 'ArrowDown': row += 1; break;
      case 'Enter':
      case ' ': {
        ev.preventDefault();
        if (selected && selected !== cursor) {
          const from = selected;
          selected = null;
          renderMarks();
          attemptMove(from, cursor);
        } else if (canPickUp(cursor)) {
          selected = selected === cursor ? null : cursor;
          renderMarks();
        }
        return;
      }
      case 'Escape':
        selected = null;
        renderMarks();
        return;
      default:
        return;
    }
    ev.preventDefault();
    const next = cellToSquare(Math.max(0, Math.min(7, col)), Math.max(0, Math.min(7, row)));
    if (next) {
      cursor = next;
      board.setAttribute('aria-activedescendant', '');
      renderMarks();
      const el = mark(cursor, 'mark--select');
      if (el) el.style.boxShadow = 'inset 0 0 0 3px rgba(255,255,255,.8)';
      board.setAttribute('aria-label', `Tablero de ajedrez. Cursor en ${cursor}.`);
    }
  }

  function onContextMenu(ev) {
    ev.preventDefault();
  }

  /* ----------------------------- arrows ---------------------------- */

  function renderArrows() {
    arrowLayer.textContent = '';
    const all = [...userArrows, ...engineArrows];
    if (!all.length) return;

    const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    const seen = new Set();
    for (const a of all) {
      if (seen.has(a.color)) continue;
      seen.add(a.color);
      const marker = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
      marker.setAttribute('id', `ah-${a.color.replace(/[^a-z0-9]/gi, '')}`);
      marker.setAttribute('markerWidth', '3');
      marker.setAttribute('markerHeight', '3');
      marker.setAttribute('refX', '2.1');
      marker.setAttribute('refY', '1.5');
      marker.setAttribute('orient', 'auto');
      const tip = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      tip.setAttribute('d', 'M0,0 L2.6,1.5 L0,3 z');
      tip.setAttribute('fill', a.color);
      marker.appendChild(tip);
      defs.appendChild(marker);
    }
    arrowLayer.appendChild(defs);

    for (const a of all) {
      const from = squareToCell(a.from);
      const to = squareToCell(a.to);
      if (!from || !to) continue;
      const x1 = from.col + 0.5;
      const y1 = from.row + 0.5;
      const x2 = to.col + 0.5;
      const y2 = to.row + 0.5;
      const dx = x2 - x1;
      const dy = y2 - y1;
      const len = Math.hypot(dx, dy) || 1;
      const shrink = 0.36;
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', String(x1));
      line.setAttribute('y1', String(y1));
      line.setAttribute('x2', String(x2 - (dx / len) * shrink));
      line.setAttribute('y2', String(y2 - (dy / len) * shrink));
      line.setAttribute('stroke', a.color);
      line.setAttribute('stroke-width', String(a.width || 0.16));
      line.setAttribute('stroke-linecap', 'round');
      line.setAttribute('opacity', String(a.opacity ?? 0.82));
      line.setAttribute('marker-end', `url(#ah-${a.color.replace(/[^a-z0-9]/gi, '')})`);
      arrowLayer.appendChild(line);
    }
  }

  const engineArrows = [];

  /* ----------------------------- listeners -------------------------- */

  wrap.addEventListener('pointerdown', onPointerDown);
  wrap.addEventListener('pointermove', onPointerMove);
  wrap.addEventListener('pointerup', onPointerUp);
  wrap.addEventListener('pointercancel', onPointerUp);
  wrap.addEventListener('contextmenu', onContextMenu);
  board.addEventListener('keydown', onKeyDown);

  paintSquares();

  /* ------------------------------- API ------------------------------ */

  const api = {
    el: wrap,

    setPosition,

    getFen: () => currentFen,

    setOrientation(color) {
      if (color !== 'white' && color !== 'black') return;
      if (orientation === color) return;
      orientation = color;
      paintSquares();
      for (const [sq, entry] of pieces) placeAt(entry.el, sq, false);
      renderMarks();
      renderArrows();
    },

    flip() {
      api.setOrientation(orientation === 'white' ? 'black' : 'white');
    },

    getOrientation: () => orientation,

    setInteractive(value) {
      interactive = !!value;
      if (!interactive) { selected = null; renderMarks(); }
    },

    setMovableColor(value) {
      movableColor = value;
      if (value === 'none') { selected = null; renderMarks(); }
    },

    /** map: Map<'e2', Array<{to, capture, promotion}>> */
    setLegalMoves(map) {
      legalMoves = map instanceof Map ? map : new Map();
      renderMarks();
    },

    markCheck(square) {
      checkSquare = square || null;
      renderMarks();
    },

    setLastMove(lastMove) {
      lastMoveSquares = lastMove;
      renderMarks();
    },

    clearSelection() {
      selected = null;
      renderMarks();
    },

    setPremove(from, to) {
      premove = from && to ? { from, to } : null;
      renderMarks();
    },

    getPremove: () => premove,

    clearPremove() {
      premove = null;
      renderMarks();
    },

    drawArrow(from, to, color = '#81B64C', width = 0.16) {
      engineArrows.push({ from, to, color, width, opacity: 0.75 });
      renderArrows();
    },

    clearArrows() {
      engineArrows.length = 0;
      userArrows.length = 0;
      userCircles.clear();
      renderArrows();
      renderMarks();
    },

    shake,

    setPieceSet(name) {
      if (name === pieceSet) return;
      pieceSet = name;
      rebuildPieces();
    },

    setTheme(name) {
      board.dataset.theme = name;
    },

    setCoordinates(value) {
      showCoordinates = !!value;
      paintSquares();
    },

    setShowLegal(value) {
      showLegal = !!value;
      renderMarks();
    },

    setAnimationMs(ms) {
      animationMs = Math.max(0, ms);
      wrap.style.setProperty('--anim', `${animationMs}ms`);
    },

    askPromotion,

    /** Celebration overlay used when the player wins. */
    spawnConfetti(pieceCount = 70) {
      const layer = document.createElement('div');
      layer.className = 'confetti';
      const colors = ['#81B64C', '#E8C14E', '#4A90D9', '#E0A030', '#ECEAE7', '#C74B4B'];
      for (let i = 0; i < pieceCount; i++) {
        const bit = document.createElement('i');
        bit.style.left = `${Math.random() * 100}%`;
        bit.style.background = colors[Math.floor(Math.random() * colors.length)];
        bit.style.animationDuration = `${1.6 + Math.random() * 1.8}s`;
        bit.style.animationDelay = `${Math.random() * 0.5}s`;
        bit.style.transform = `rotate(${Math.random() * 360}deg)`;
        layer.appendChild(bit);
      }
      wrap.appendChild(layer);
      setTimeout(() => layer.remove(), 4200);
      return layer;
    },

    /** Dim the board and show a node on top of it (game over, waiting, …). */
    overlay(node) {
      api.clearOverlay();
      const ov = document.createElement('div');
      ov.className = 'board-overlay';
      if (node) ov.appendChild(node);
      wrap.appendChild(ov);
      return ov;
    },

    clearOverlay() {
      wrap.querySelectorAll('.board-overlay').forEach((n) => n.remove());
    },

    focus() {
      board.focus();
    },

    resize() {
      if (drag) drag.rect = wrap.getBoundingClientRect();
    },

    destroy() {
      if (destroyed) return;
      destroyed = true;
      closePromotion(null);
      wrap.removeEventListener('pointerdown', onPointerDown);
      wrap.removeEventListener('pointermove', onPointerMove);
      wrap.removeEventListener('pointerup', onPointerUp);
      wrap.removeEventListener('pointercancel', onPointerUp);
      wrap.removeEventListener('contextmenu', onContextMenu);
      board.removeEventListener('keydown', onKeyDown);
      wrap.remove();
    },
  };

  api.setAnimationMs(animationMs);
  return api;
}
