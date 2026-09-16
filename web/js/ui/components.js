/**
 * ui/components.js — the shared widget kit every screen builds from.
 * Text always goes in through textContent; the only innerHTML used here is for
 * SVG markup this project generates itself (pieces, avatars, badges).
 */

import { MOVE_CLASSES } from '../report.js';
import { pieceSvg, botAvatarSvg, userAvatarSvg, flagEmoji } from '../pieces.js';
import { ratingTier } from '../elo.js';
import { formatClock } from '../clock.js';

/* ----------------------------- DOM helper ------------------------------ */

/**
 * el('div', {class:'row', onClick, text:'hola'}, child1, child2)
 * Props: class/className, text, html (trusted SVG only), style (object),
 * dataset (object), attrs (object), on* handlers, plus any direct property.
 */
export function el(tag, props = null, ...children) {
  const node = document.createElement(tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class' || key === 'className') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key === 'html') node.innerHTML = value;
      else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
      else if (key === 'dataset') Object.assign(node.dataset, value);
      else if (key === 'attrs') {
        for (const [a, v] of Object.entries(value)) {
          if (v !== null && v !== undefined && v !== false) node.setAttribute(a, String(v));
        }
      } else if (key.startsWith('on') && typeof value === 'function') {
        node.addEventListener(key.slice(2).toLowerCase(), value);
      } else if (key in node) {
        node[key] = value;
      } else {
        node.setAttribute(key, String(value));
      }
    }
  }
  append(node, children);
  return node;
}

export function append(parent, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    parent.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return parent;
}

export function clear(node) {
  node.textContent = '';
  return node;
}

/* ------------------------------ controls ------------------------------- */

export function button(label, opts = {}) {
  const { variant = '', size = '', onClick, disabled = false, title, icon: iconName, block, type = 'button' } = opts;
  const classes = ['btn'];
  if (variant) classes.push(`btn--${variant}`);
  if (size) classes.push(`btn--${size}`);
  if (block) classes.push('btn--block');
  const node = el('button', { class: classes.join(' '), type, disabled, title, onClick });
  if (iconName) node.appendChild(el('span', { text: iconName, attrs: { 'aria-hidden': 'true' } }));
  if (label) node.appendChild(el('span', { text: label }));
  else node.setAttribute('aria-label', title || 'Botón');
  return node;
}

export function chip(label, { active = false, onClick, title } = {}) {
  return el('button', {
    class: `chip${active ? ' is-active' : ''}`,
    type: 'button',
    text: label,
    title,
    onClick,
    attrs: { 'aria-pressed': String(!!active) },
  });
}

export function field(labelText, control, hint) {
  const wrap = el('label', { class: 'field' }, el('span', { class: 'field__label', text: labelText }), control);
  if (hint) wrap.appendChild(el('span', { class: 'tiny faint', text: hint }));
  return wrap;
}

export function select(options, { value, onChange, ariaLabel } = {}) {
  const node = el('select', { class: 'select', onChange, attrs: { 'aria-label': ariaLabel } });
  for (const opt of options) {
    const o = el('option', { value: opt.value, text: opt.label });
    if (String(opt.value) === String(value)) o.selected = true;
    node.appendChild(o);
  }
  return node;
}

export function switchControl(labelText, { checked = false, onChange } = {}) {
  const input = el('input', { type: 'checkbox', checked, onChange });
  return el('label', { class: 'switch' },
    input,
    el('span', { class: 'switch__track' }),
    el('span', { text: labelText }));
}

export function spinner(size = 18) {
  return el('div', { class: 'spinner', style: { width: `${size}px`, height: `${size}px` } });
}

export function card(title, ...children) {
  const node = el('section', { class: 'card' });
  if (title) node.appendChild(el('h2', { class: 'card__title', text: title }));
  append(node, children);
  return node;
}

/* ------------------------------- avatars ------------------------------- */

export function avatarNode(source, size = 40) {
  const wrap = el('div', { class: 'player-card__avatar', style: { width: `${size}px`, height: `${size}px` } });
  wrap.innerHTML = source && source.botId !== undefined && source.emoji
    ? botAvatarSvg(source, size)
    : source && source.isBot
      ? botAvatarSvg(source, size)
      : userAvatarSvg(source?.avatarSeed || source?.name || 'invitado', size);
  return wrap;
}

export function botAvatarNode(bot, size = 48) {
  const wrap = el('div', { style: { width: `${size}px`, height: `${size}px`, flex: 'none' } });
  wrap.innerHTML = botAvatarSvg(bot, size);
  return wrap;
}

export function ratingBadge(elo, { showName = false } = {}) {
  const tier = ratingTier(elo);
  const node = el('span', {
    class: 'tier-chip',
    style: { color: tier.color },
    title: tier.name,
  });
  node.appendChild(el('span', { text: tier.icon || '•' }));
  node.appendChild(el('span', { text: showName ? tier.name : String(Math.round(elo)) }));
  return node;
}

/* ----------------------------- player card ------------------------------ */

/**
 * A player strip: avatar, name, rating, clock and captured material.
 * Returns { node, setClock, setActive, setCaptured, setText }.
 */
export function playerCard(player, { showClock = true } = {}) {
  const avatar = avatarNode(player, 40);
  const nameRow = el('div', { class: 'player-card__name' });
  if (player.country) nameRow.appendChild(el('span', { text: flagEmoji(player.country), attrs: { 'aria-hidden': 'true' } }));
  if (player.title) nameRow.appendChild(el('span', { class: 'strong', style: { color: 'var(--warn)' }, text: player.title }));
  /* Sin `truncate`: con el reloj a 26px el hueco del nombre queda en unos
     160px y casi cualquier nombre con bandera y titulo se cortaba. Mejor que
     baje a una segunda linea. */
  nameRow.appendChild(el('span', { text: player.name || '—' }));

  const meta = el('div', { class: 'player-card__meta' });
  if (typeof player.rating === 'number') meta.appendChild(ratingBadge(player.rating));
  const extra = el('span', { class: 'tiny faint', text: player.subtitle || '' });
  meta.appendChild(extra);

  const captured = el('div', { class: 'player-card__captured' });
  const info = el('div', { class: 'grow' }, nameRow, meta, captured);

  const clockNode = showClock ? el('div', { class: 'clock', text: '--:--' }) : null;
  const node = el('div', { class: 'player-card' }, avatar, info, clockNode);

  return {
    node,
    clockNode,
    setClock(ms, { active = false, low = false } = {}) {
      if (!clockNode) return;
      clockNode.textContent = formatClock(ms);
      clockNode.classList.toggle('is-active', active);
      clockNode.classList.toggle('is-low', low || (Number.isFinite(ms) && ms < 30000));
      clockNode.classList.toggle('is-critical', active && Number.isFinite(ms) && ms < 10000);
    },
    setActive(active) {
      node.style.borderColor = active ? 'var(--accent)' : 'var(--border-soft)';
    },
    setCaptured(codes, advantage) {
      clear(captured);
      for (const code of codes) {
        const span = el('span');
        span.innerHTML = pieceSvg(code, 'moderno');
        captured.appendChild(span);
      }
      if (advantage > 0) captured.appendChild(el('span', { class: 'player-card__adv', text: `+${advantage}` }));
    },
    setText(text) {
      extra.textContent = text;
    },
  };
}

/* ------------------------------- eval bar ------------------------------- */

export function evalBar() {
  const white = el('div', { class: 'evalbar__white' });
  const top = el('div', { class: 'evalbar__label evalbar__label--top', text: '' });
  const bottom = el('div', { class: 'evalbar__label evalbar__label--bottom', text: '0.0' });
  const node = el('div', {
    class: 'evalbar',
    attrs: { role: 'img', 'aria-label': 'Barra de evaluación' },
  }, white, el('div', { class: 'evalbar__mid' }), top, bottom);

  let flipped = false;

  function render(cp, mate) {
    let percent;
    let label;
    if (mate !== null && mate !== undefined) {
      percent = mate > 0 ? 100 : 0;
      label = `M${Math.abs(mate)}`;
    } else {
      const score = Math.max(-1500, Math.min(1500, cp || 0));
      percent = 50 + 50 * (2 / (1 + Math.exp(-score / 380)) - 1);
      label = `${score >= 0 ? '' : '-'}${(Math.abs(score) / 100).toFixed(1)}`;
    }
    white.style.height = `${flipped ? 100 - percent : percent}%`;
    const whiteAhead = percent >= 50;
    // The label sits on whichever end belongs to the leading side.
    if (whiteAhead !== flipped) {
      bottom.textContent = label;
      top.textContent = '';
    } else {
      top.textContent = label;
      bottom.textContent = '';
    }
    node.setAttribute('aria-label', `Evaluación: ${label}`);
  }

  render(0, null);

  return {
    node,
    setScore(cp, mate = null) { render(cp, mate); },
    setOrientation(orientation) {
      flipped = orientation === 'black';
      render(0, null);
    },
  };
}

/* ------------------------------- move list ------------------------------ */

/* Las categorias y su simbolo viven en report.js, que es quien las decide.
   Tenerlas repetidas aqui hacia que la lista de jugadas enseñara el simbolo de
   otra categoria —una jugada «buena» salia con «!»— y que las nuevas (la
   mejor, excelente, de libro, forzada) no salieran de ninguna manera. */
const NAG_CLASS = Object.fromEntries(
  Object.keys(MOVE_CLASSES).map((k) => [k, `nag--${k}`]));
const NAG_GLYPH = Object.fromEntries(
  Object.entries(MOVE_CLASSES).map(([k, v]) => [k, v.glyph]));

export function moveList({ onSelect } = {}) {
  const node = el('div', { class: 'movelist', attrs: { role: 'list', 'aria-label': 'Lista de jugadas' } });
  let moves = [];
  let annotations = [];
  let current = -1;

  function render() {
    clear(node);
    if (!moves.length) {
      node.appendChild(el('div', { class: 'movelist__empty', text: 'Todavía no hay jugadas.' }));
      return;
    }
    for (let i = 0; i < moves.length; i += 2) {
      const row = el('div', { class: 'movelist__row', attrs: { role: 'listitem' } });
      row.appendChild(el('span', { class: 'movelist__num', text: `${i / 2 + 1}.` }));
      for (const offset of [0, 1]) {
        const index = i + offset;
        if (index >= moves.length) { row.appendChild(el('span')); continue; }
        const btn = el('button', {
          class: `movelist__move${index === current ? ' is-current' : ''}`,
          type: 'button',
          onClick: () => { if (onSelect) onSelect(index); },
        }, el('span', { text: moves[index] }));
        const nag = annotations[index];
        if (nag && NAG_GLYPH[nag]) {
          btn.appendChild(el('span', { class: `nag ${NAG_CLASS[nag]}`, text: NAG_GLYPH[nag] }));
        }
        row.appendChild(btn);
      }
      node.appendChild(row);
    }
    const active = node.querySelector('.is-current');
    if (active) active.scrollIntoView({ block: 'nearest' });
  }

  render();

  return {
    node,
    setMoves(list) { moves = list.slice(); render(); },
    setAnnotations(list) { annotations = list.slice(); render(); },
    setCurrent(index) { current = index; render(); },
    getCurrent: () => current,
  };
}

/* ----------------------------- rating chart ----------------------------- */

/** Line chart of a rating history, drawn as plain SVG. */
export function ratingChart(history, { width = 560, height = 170 } = {}) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'rating-chart');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('role', 'img');

  const points = (history || []).slice(-80);
  if (points.length < 2) {
    const text = document.createElementNS(NS, 'text');
    text.setAttribute('x', String(width / 2));
    text.setAttribute('y', String(height / 2));
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('class', 'axis-label');
    text.textContent = 'Juega algunas partidas para ver tu evolución.';
    svg.appendChild(text);
    return svg;
  }

  const values = points.map((p) => p.rating);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const pad = Math.max(20, (max - min) * 0.15);
  const lo = min - pad;
  const hi = max + pad;
  const padX = 34;
  const padY = 14;

  const x = (i) => padX + (i / (points.length - 1)) * (width - padX - 8);
  const y = (v) => padY + (1 - (v - lo) / (hi - lo || 1)) * (height - padY * 2);

  const defs = document.createElementNS(NS, 'defs');
  const grad = document.createElementNS(NS, 'linearGradient');
  grad.setAttribute('id', 'rc-grad');
  grad.setAttribute('x1', '0'); grad.setAttribute('y1', '0');
  grad.setAttribute('x2', '0'); grad.setAttribute('y2', '1');
  const s1 = document.createElementNS(NS, 'stop');
  s1.setAttribute('offset', '0'); s1.setAttribute('stop-color', '#81B64C');
  const s2 = document.createElementNS(NS, 'stop');
  s2.setAttribute('offset', '1'); s2.setAttribute('stop-color', '#81B64C');
  s2.setAttribute('stop-opacity', '0');
  grad.append(s1, s2);
  defs.appendChild(grad);
  svg.appendChild(defs);

  for (const value of [lo, (lo + hi) / 2, hi]) {
    const line = document.createElementNS(NS, 'line');
    line.setAttribute('class', 'grid');
    line.setAttribute('x1', String(padX)); line.setAttribute('x2', String(width - 8));
    line.setAttribute('y1', String(y(value))); line.setAttribute('y2', String(y(value)));
    svg.appendChild(line);
    const label = document.createElementNS(NS, 'text');
    label.setAttribute('class', 'axis-label');
    label.setAttribute('x', '2');
    label.setAttribute('y', String(y(value) + 3));
    label.textContent = String(Math.round(value));
    svg.appendChild(label);
  }

  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.rating).toFixed(1)}`).join(' ');
  const area = document.createElementNS(NS, 'path');
  area.setAttribute('class', 'area');
  area.setAttribute('d', `${line} L${x(points.length - 1).toFixed(1)},${height - padY} L${x(0).toFixed(1)},${height - padY} Z`);
  svg.appendChild(area);

  const path = document.createElementNS(NS, 'path');
  path.setAttribute('class', 'line');
  path.setAttribute('d', line);
  svg.appendChild(path);

  const last = document.createElementNS(NS, 'circle');
  last.setAttribute('class', 'dot');
  last.setAttribute('cx', String(x(points.length - 1)));
  last.setAttribute('cy', String(y(points[points.length - 1].rating)));
  last.setAttribute('r', '3.5');
  svg.appendChild(last);

  svg.setAttribute('aria-label',
    `Evolución de la puntuación: de ${values[0]} a ${values[values.length - 1]}.`);
  return svg;
}

/* -------------------------------- modals -------------------------------- */

let modalHost = null;
function host() {
  if (!modalHost) modalHost = document.getElementById('modal-host') || document.body;
  return modalHost;
}

/**
 * modal({title, body, actions:[{label, variant, onClick, close}], dismissable})
 * Returns { close }. Actions close the modal unless `close:false`.
 */
/* Los dialogos viven en #modal-host, fuera del trozo de pagina que el router
   limpia al cambiar de pantalla. Sin este registro se quedaban colgados encima
   de la pantalla siguiente —el resumen de una partida terminada flotando sobre
   la lista de bots, con botones que ya no llevan a ninguna parte—. */
const abiertos = new Set();

/** Cierra todos los diálogos abiertos. La usa el router al cambiar de pantalla. */
export function closeAllModals() {
  for (const cerrar of [...abiertos]) {
    try { cerrar(); } catch { /* uno que falle no puede dejar los demas abiertos */ }
  }
  abiertos.clear();
}

export function modal({ title, body, actions = [], dismissable = true, wide = false } = {}) {
  const backdrop = el('div', { class: 'modal-backdrop' });
  const dialog = el('div', {
    class: `modal${wide ? ' modal--wide' : ''}`,
    attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': title || 'Diálogo' },
  });

  if (title) {
    dialog.appendChild(el('div', { class: 'modal__head' }, el('h2', { class: 'modal__title', text: title })));
  }
  const bodyNode = el('div', { class: 'modal__body' });
  if (typeof body === 'string') bodyNode.appendChild(el('p', { text: body }));
  else if (body) bodyNode.appendChild(body);
  dialog.appendChild(bodyNode);

  function close() {
    document.removeEventListener('keydown', onKey);
    backdrop.remove();
    abiertos.delete(close);
  }

  if (actions.length) {
    const bar = el('div', { class: 'modal__actions' });
    for (const action of actions) {
      bar.appendChild(button(action.label, {
        variant: action.variant,
        onClick: () => {
          if (action.close !== false) close();
          if (action.onClick) action.onClick();
        },
      }));
    }
    dialog.appendChild(bar);
  }

  function onKey(ev) {
    if (ev.key === 'Escape' && dismissable) close();
  }
  document.addEventListener('keydown', onKey);

  if (dismissable) {
    backdrop.addEventListener('pointerdown', (ev) => { if (ev.target === backdrop) close(); });
  }

  abiertos.add(close);
  backdrop.appendChild(dialog);
  host().appendChild(backdrop);

  const focusable = dialog.querySelector('button, input, select, textarea, [tabindex]');
  if (focusable) focusable.focus();

  return { close, node: dialog, body: bodyNode };
}

export function confirmDialog({ title, message, confirmLabel = 'Confirmar', cancelLabel = 'Cancelar', danger = false } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => { if (!settled) { settled = true; resolve(value); } };
    const ref = modal({
      title,
      body: message,
      dismissable: true,
      actions: [
        { label: cancelLabel, variant: 'ghost', onClick: () => done(false) },
        { label: confirmLabel, variant: danger ? 'danger' : 'primary', onClick: () => done(true) },
      ],
    });
    const observer = new MutationObserver(() => {
      if (!ref.node.isConnected) { observer.disconnect(); done(false); }
    });
    observer.observe(host(), { childList: true, subtree: true });
  });
}

/* -------------------------------- toasts -------------------------------- */

export function toast(message, kind = '', { timeout = 3400, icon } = {}) {
  const container = document.getElementById('toasts');
  if (!container) return null;
  const node = el('div', { class: `toast${kind ? ` toast--${kind}` : ''}` });
  if (icon) node.appendChild(el('span', { style: { fontSize: '20px' }, text: icon }));
  node.appendChild(el('span', { text: message }));
  container.appendChild(node);
  setTimeout(() => {
    node.style.transition = 'opacity 220ms, transform 220ms';
    node.style.opacity = '0';
    node.style.transform = 'translateX(18px)';
    setTimeout(() => node.remove(), 240);
  }, timeout);
  return node;
}

export function achievementToast(achievement) {
  return toast(`¡Logro desbloqueado: ${achievement.name}!`, 'achievement', {
    icon: achievement.icon, timeout: 5200,
  });
}

/* ------------------------------ misc helpers ---------------------------- */

export function deltaSpan(delta) {
  if (delta === null || delta === undefined) return el('span', { class: 'delta-zero', text: '—' });
  const cls = delta > 0 ? 'delta-pos' : delta < 0 ? 'delta-neg' : 'delta-zero';
  const sign = delta > 0 ? '+' : '';
  return el('span', { class: cls, text: `${sign}${Math.round(delta)}` });
}

export function resultBadge(result) {
  const map = { win: ['G', 'win'], loss: ['P', 'loss'], draw: ['T', 'draw'] };
  const [letter, kind] = map[result] || ['-', 'draw'];
  return el('span', { class: `result-badge result-badge--${kind}`, text: letter, title: {
    win: 'Victoria', loss: 'Derrota', draw: 'Tablas',
  }[result] || '' });
}

export function emptyState(message, actionNode) {
  const node = el('div', { class: 'col center gap-16', style: { padding: '38px 16px', textAlign: 'center' } },
    el('p', { class: 'muted', text: message }));
  if (actionNode) node.appendChild(actionNode);
  return node;
}

export function formatDate(ts) {
  try {
    return new Date(ts).toLocaleDateString('es', { day: '2-digit', month: 'short', year: 'numeric' });
  } catch {
    return '';
  }
}

export function pluralize(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}
