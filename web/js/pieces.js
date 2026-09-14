/**
 * pieces.js — original vector piece sets, generated avatars and small badges.
 * Three sets: 'clasico' (Staunton-inspired, curved), 'moderno' (flat geometric)
 * and 'unicode' (text glyph fallback). Every path here was authored for this
 * project; nothing is traced from an existing piece set.
 * Piece codes follow chess.js: type = pc & 7, color = pc >> 3.
 */

const PAWN = 1, KNIGHT = 2, BISHOP = 3, ROOK = 4, QUEEN = 5, KING = 6;

export const PIECE_SETS = [
  { id: 'clasico', name: 'Clásico' },
  { id: 'moderno', name: 'Moderno' },
  { id: 'unicode', name: 'Unicode' },
];

const SKIN = {
  white: { fill: '#FAFAF8', stroke: '#2A2724', detail: '#2A2724', shade: '#DFDCD6' },
  black: { fill: '#33302C', stroke: '#100F0D', detail: '#E6E2DC', shade: '#1F1D1A' },
};

/* ------------------------------------------------------------------ *
 * Set "clásico"
 * ------------------------------------------------------------------ */

const CLASSIC = {
  [PAWN]: () => `
    <circle cx="22.5" cy="11.6" r="4.8"/>
    <path d="M17.8 18.5c1.4.9 3 1.4 4.7 1.4s3.3-.5 4.7-1.4c1.7 1.3 2.8 3.3 2.8 5.6 0 1.9-.8 3.6-2.1 4.9 2.8 2 4.9 5 5.8 8.6H11.3c.9-3.6 3-6.6 5.8-8.6-1.3-1.3-2.1-3-2.1-4.9 0-2.3 1.1-4.3 2.8-5.6z"/>
    <rect x="10.6" y="36.8" width="23.8" height="4.2" rx="2.1"/>`,

  [KNIGHT]: (s) => `
    <path d="M23.9 7.9c-1.5-1.9-4.2-2.4-6.3-1.1-.9.6-1.6 1.4-2 2.4-1.1-.5-2.4-.3-3.3.5-3.1 2.6-5.2 6.1-6.1 10.1-.4 1.8-.6 3.7-.5 5.6.1 1.2 1.1 2.1 2.3 2.1.8 0 1.5-.4 2-1l2.6-3.4.7 2.2c.3 1 1.3 1.7 2.4 1.5l3-.4c-2.3 3.1-3.9 6.7-4.5 10.5l-.5 3.1h18.6c1-6.2 1.4-11.3 1.2-15.2-.3-6.3-3.1-11.4-8.2-15.2-.4-.3-.9-.5-1.4-.7z"/>
    <circle cx="17.4" cy="13.4" r="1.45" fill="${s.detail}" stroke="none"/>
    <path d="M11.6 21.5c1.5-.5 2.8-1.3 3.9-2.4" fill="none" stroke="${s.detail}" stroke-width="1.15" stroke-linecap="round"/>
    <path d="M25.4 12.1c2.2 2.4 3.5 5.3 3.9 8.6" fill="none" stroke="${s.detail}" stroke-width="1.1" stroke-linecap="round" opacity=".55"/>
    <rect x="10.6" y="36.8" width="23.8" height="4.2" rx="2.1"/>`,

  [BISHOP]: (s) => `
    <circle cx="22.5" cy="7.4" r="2.4"/>
    <path d="M22.5 10.1c4.7 3 7.5 7.1 7.5 11.1 0 2.4-1.1 4.6-3 6h-9c-1.9-1.4-3-3.6-3-6 0-4 2.8-8.1 7.5-11.1z"/>
    <path d="M22.5 13.4l3.6 6.4" fill="none" stroke="${s.detail}" stroke-width="1.3" stroke-linecap="round"/>
    <rect x="16.2" y="26.9" width="12.6" height="2.8" rx="1.3"/>
    <path d="M14.4 29.6h16.2c1.2 2.7 2.9 4.6 5 5.9H9.4c2.1-1.3 3.8-3.2 5-5.9z"/>
    <rect x="9" y="35.2" width="27" height="4.4" rx="2.2"/>`,

  [QUEEN]: (s) => `
    <circle cx="7.9" cy="13.1" r="2.2"/><circle cx="14.5" cy="9.3" r="2.2"/>
    <circle cx="22.5" cy="7.7" r="2.6"/>
    <circle cx="30.5" cy="9.3" r="2.2"/><circle cx="37.1" cy="13.1" r="2.2"/>
    <path d="M8.4 14.9l4.9 13.2h18.4l4.9-13.2-7.2 8.4-2.4-12.5-4.5 11.5-4.5-11.5-2.4 12.5z"/>
    <rect x="12.4" y="27.7" width="20.2" height="2.9" rx="1.3"/>
    <path d="M11.4 30.5h22.2c1.2 2.5 2.9 4.3 4.9 5.5H6.5c2-1.2 3.7-3 4.9-5.5z"/>
    <path d="M14.2 31.9h16.6" fill="none" stroke="${s.detail}" stroke-width="1.1" stroke-linecap="round" opacity=".6"/>
    <rect x="6" y="35.8" width="33" height="4.4" rx="2.2"/>`,

  [KING]: (s) => `
    <path d="M22.5 3.6v8.4M18.4 7h8.2" fill="none" stroke="${s.stroke}" stroke-width="3.2" stroke-linecap="round"/>
    <path d="M22.5 3.6v8.4M18.4 7h8.2" fill="none" stroke="${s.fill}" stroke-width="1.6" stroke-linecap="round"/>
    <path d="M22.5 12.4c-3.9 0-7 2.7-7 6.1 0 1.7.8 3.2 2 4.3h10c1.2-1.1 2-2.6 2-4.3 0-3.4-3.1-6.1-7-6.1z"/>
    <path d="M13.9 22.4h17.2l1.6 6.6H12.3z"/>
    <path d="M16.6 24.8h11.8" fill="none" stroke="${s.detail}" stroke-width="1.1" stroke-linecap="round" opacity=".55"/>
    <path d="M12.1 28.8h20.8c1.3 3.1 3.4 5.4 6.1 7H6c2.7-1.6 4.8-3.9 6.1-7z"/>
    <rect x="8.6" y="34.6" width="27.8" height="2.4" rx="1.2"/>
    <rect x="6" y="36.4" width="33" height="4.2" rx="2.1"/>`,

  [ROOK]: (s) => `
    <path d="M11.6 8.2h4.9v2.9h3.7V8.2h4.8v2.9h3.7V8.2h4.9v7.6H11.6z"/>
    <rect x="13.2" y="15.4" width="18.6" height="2.9" rx="1.2"/>
    <path d="M15.5 18.2h14l-1.2 14.4H16.7z"/>
    <path d="M17.6 21.6h9.8" fill="none" stroke="${s.detail}" stroke-width="1.05" stroke-linecap="round" opacity=".55"/>
    <rect x="12.4" y="32.2" width="20.2" height="3.5" rx="1.4"/>
    <rect x="9.4" y="35.4" width="26.2" height="4.5" rx="2.2"/>`,
};

/* ------------------------------------------------------------------ *
 * Set "moderno" — flat geometry, no fine detail, very legible when small
 * ------------------------------------------------------------------ */

const MODERN = {
  [PAWN]: () => `
    <circle cx="22.5" cy="13" r="6"/>
    <path d="M16.5 22h12l3.5 13h-19z"/>
    <rect x="9.5" y="34" width="26" height="5" rx="2.5"/>`,

  [KNIGHT]: () => `
    <path d="M25 7l-9 3.5-6 9.5 2.5 3 3-3.5 1.5 4 5-1-4.5 12h17c1.5-9 1.5-16-1-21S28 7.5 25 7z" stroke-linejoin="round"/>
    <rect x="9.5" y="34" width="26" height="5" rx="2.5"/>`,

  [BISHOP]: () => `
    <circle cx="22.5" cy="8" r="3"/>
    <path d="M22.5 11c5 3.5 8 8 8 12h-16c0-4 3-8.5 8-12z"/>
    <path d="M13 25h19l3 9H10z"/>
    <rect x="8.5" y="34" width="28" height="5" rx="2.5"/>`,

  [QUEEN]: () => `
    <circle cx="22.5" cy="7.5" r="3"/>
    <circle cx="8.5" cy="13" r="2.8"/><circle cx="36.5" cy="13" r="2.8"/>
    <path d="M8.5 14l5 14h18l5-14-8 7-6-10-6 10z"/>
    <path d="M12 29h21l2.5 5H9.5z"/>
    <rect x="7.5" y="34" width="30" height="5" rx="2.5"/>`,

  [KING]: (s) => `
    <path d="M22.5 4v9M18 7.5h9" fill="none" stroke="${s.stroke}" stroke-width="3.4" stroke-linecap="round"/>
    <path d="M22.5 14c-6 0-10 4-10 8.5 0 2 .8 3.8 2 5.5h16c1.2-1.7 2-3.5 2-5.5 0-4.5-4-8.5-10-8.5z"/>
    <path d="M12 29h21l2.5 5H9.5z"/>
    <rect x="7.5" y="34" width="30" height="5" rx="2.5"/>`,

  [ROOK]: () => `
    <path d="M11 8h5v3h4V8h5v3h4V8h5v8H11z"/>
    <path d="M15 17h15l-1.5 15h-12z"/>
    <rect x="9.5" y="31" width="26" height="4" rx="1.5"/>
    <rect x="8" y="34.5" width="29" height="4.8" rx="2.4"/>`,
};

const UNICODE_GLYPH = {
  [PAWN]: ['♙', '♟'], [KNIGHT]: ['♘', '♞'], [BISHOP]: ['♗', '♝'],
  [ROOK]: ['♖', '♜'], [QUEEN]: ['♕', '♛'], [KING]: ['♔', '♚'],
};

const SETS = { clasico: CLASSIC, moderno: MODERN };

/** Spanish piece names, for aria-labels and the analysis panel. */
export const PIECE_NAMES = {
  [PAWN]: 'peón', [KNIGHT]: 'caballo', [BISHOP]: 'alfil',
  [ROOK]: 'torre', [QUEEN]: 'dama', [KING]: 'rey',
};

export function pieceLabel(pc) {
  const type = pc & 7;
  const color = pc >> 3 === 0 ? 'blanco' : 'negro';
  return `${PIECE_NAMES[type] || 'pieza'} ${color}`;
}

/**
 * Full <svg> markup for a piece. `setName` falls back to 'clasico'.
 */
export function pieceSvg(pc, setName = 'clasico') {
  const type = pc & 7;
  if (!type || type > 6) return '';
  const isWhite = (pc >> 3) === 0;
  const skin = isWhite ? SKIN.white : SKIN.black;
  const label = pieceLabel(pc);

  if (setName === 'unicode') {
    const glyph = UNICODE_GLYPH[type][isWhite ? 0 : 1];
    return `<svg viewBox="0 0 45 45" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${label}">` +
      `<text x="22.5" y="36" text-anchor="middle" font-size="40" ` +
      `fill="${skin.fill}" stroke="${skin.stroke}" stroke-width="0.7">${glyph}</text></svg>`;
  }

  const set = SETS[setName] || CLASSIC;
  const body = set[type](skin);
  return `<svg viewBox="0 0 45 45" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${label}">` +
    `<g fill="${skin.fill}" stroke="${skin.stroke}" stroke-width="1.5" ` +
    `stroke-linejoin="round" stroke-linecap="round">${body}</g></svg>`;
}

const nodeCache = new Map();

/** Cloned DOM node for a piece — cheap enough to call once per square per repaint. */
export function pieceNode(pc, setName = 'clasico') {
  const key = `${setName}:${pc}`;
  let template = nodeCache.get(key);
  if (!template) {
    const wrap = document.createElement('div');
    wrap.innerHTML = pieceSvg(pc, setName);
    template = wrap.firstElementChild;
    nodeCache.set(key, template);
  }
  return template.cloneNode(true);
}

/* ------------------------------------------------------------------ *
 * Avatars and badges
 * ------------------------------------------------------------------ */

/** ISO-3166 alpha-2 -> flag emoji. Returns '' for anything unexpected. */
export function flagEmoji(code) {
  if (typeof code !== 'string' || !/^[A-Za-z]{2}$/.test(code)) return '';
  const base = 0x1f1e6;
  const up = code.toUpperCase();
  return String.fromCodePoint(base + up.charCodeAt(0) - 65, base + up.charCodeAt(1) - 65);
}

function hashSeed(str) {
  let h = 2166136261;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Avatar for a bot: rounded square with its own gradient plus its emoji.
 * `bot.avatar` may supply {bg, fg}; otherwise colours derive from the id.
 */
export function botAvatarSvg(bot, size = 48) {
  const seed = hashSeed(bot?.id || 'bot');
  const hue = seed % 360;
  const bg = bot?.avatar?.bg || `hsl(${hue} 42% 32%)`;
  const bg2 = bot?.avatar?.bg2 || `hsl(${(hue + 38) % 360} 46% 20%)`;
  const gid = `ag${seed.toString(36)}`;
  const emoji = bot?.emoji || '🤖';
  return `<svg viewBox="0 0 48 48" width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Avatar de ${escapeAttr(bot?.name || 'bot')}">
  <defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="${bg}"/><stop offset="1" stop-color="${bg2}"/>
  </linearGradient></defs>
  <rect width="48" height="48" rx="11" fill="url(#${gid})"/>
  <text x="24" y="33" text-anchor="middle" font-size="25">${emoji}</text>
</svg>`;
}

/** Deterministic geometric avatar for the human player. */
export function userAvatarSvg(seed, size = 48) {
  const h = hashSeed(seed == null ? 'invitado' : seed);
  const hue = h % 360;
  const gid = `ua${h.toString(36)}`;
  const cells = [];
  for (let y = 0; y < 5; y++) {
    for (let x = 0; x < 3; x++) {
      const bit = (h >>> ((y * 3 + x) % 29)) & 1;
      if (!bit) continue;
      cells.push(`<rect x="${8 + x * 8}" y="${8 + y * 6.4}" width="8" height="6.4"/>`);
      if (x < 2) cells.push(`<rect x="${40 - 8 - x * 8}" y="${8 + y * 6.4}" width="8" height="6.4"/>`);
    }
  }
  return `<svg viewBox="0 0 48 48" width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Tu avatar">
  <defs><linearGradient id="${gid}" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="hsl(${hue} 38% 28%)"/><stop offset="1" stop-color="hsl(${(hue + 50) % 360} 40% 17%)"/>
  </linearGradient></defs>
  <rect width="48" height="48" rx="11" fill="url(#${gid})"/>
  <g fill="hsl(${hue} 62% 66%)" opacity=".92">${cells.join('')}</g>
</svg>`;
}

/** Small shield badge for a rating tier ({name, color, icon} from elo.js). */
export function tierBadge(tier, size = 20) {
  if (!tier) return '';
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${escapeAttr(tier.name)}">
  <path d="M12 1.8l8.4 3v7c0 5.3-3.5 9-8.4 10.4C7.1 20.8 3.6 17.1 3.6 11.8v-7z" fill="${tier.color}" opacity=".22" stroke="${tier.color}" stroke-width="1.4"/>
  <text x="12" y="16" text-anchor="middle" font-size="11">${tier.icon || ''}</text>
</svg>`;
}

function escapeAttr(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
