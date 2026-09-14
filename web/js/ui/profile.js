/**
 * ui/profile.js — the player page: identity, one rating per category with its
 * evolution chart, streaks and records, the trophy cabinet of defeated bots,
 * the 28 achievements, the game history with downloadable PGN, and the
 * import / export / reset of every stored byte.
 */

import {
  el, clear, card, button, chip, field, ratingBadge, ratingChart, resultBadge,
  deltaSpan, emptyState, formatDate, avatarNode, botAvatarNode,
} from './components.js';
import { ratingTier } from '../elo.js';
import { CATEGORY_NAMES } from '../clock.js';
import { BOTS } from '../bots.js';
import { ACHIEVEMENTS } from '../achievements.js';
import { loadGames, exportAll, importAll, resetAll } from '../storage.js';

/** Order used everywhere on this screen; matches storage.js. */
const CATEGORIES = ['bullet', 'blitz', 'rapid', 'classical', 'bots'];

const MODE_NAMES = {
  bot: 'Contra la máquina',
  local: 'Local a dos',
  online: 'Online',
  tournament: 'Torneo',
};

/** Seeds offered in the avatar picker, besides the one already in use. */
const AVATAR_SEEDS = ['peon', 'caballo', 'alfil', 'torre', 'dama', 'rey'];

const HISTORY_PAGE = 25;

export function mount(root, ctx) {
  const profile = ctx.profile;
  const timers = new Set();
  const urls = new Set();

  /** setTimeout that unmount() can cancel. */
  function later(fn, ms) {
    const id = setTimeout(() => { timers.delete(id); fn(); }, ms);
    timers.add(id);
    return id;
  }

  /**
   * Offers a text file for download without a server: Blob + object URL + a
   * throwaway anchor we click ourselves.
   */
  function download(filename, text, mime) {
    try {
      const blob = new Blob([text], { type: `${mime || 'text/plain'};charset=utf-8` });
      const url = URL.createObjectURL(blob);
      urls.add(url);
      const link = el('a', { class: 'hidden', href: url, download: filename });
      document.body.appendChild(link);
      link.click();
      link.remove();
      later(() => {
        try { URL.revokeObjectURL(url); } catch { /* ya no existe */ }
        urls.delete(url);
      }, 2000);
      return true;
    } catch {
      ctx.toast('Tu navegador no permitió la descarga.', 'err');
      return false;
    }
  }

  const screen = el('div', { class: 'screen' });

  /* -------------------------------- cabecera ------------------------------ */

  const headActions = el('div', { class: 'row row--wrap gap-6' },
    el('a', { class: 'btn btn--ghost', href: '#/ajustes', text: 'Ajustes' }),
    el('a', { class: 'btn btn--primary', href: '#/bots', text: 'Jugar una partida' }));

  screen.appendChild(el('div', { class: 'screen__head' },
    el('div', { class: 'col gap-4' },
      el('h1', { class: 'h1', text: 'Tu perfil' }),
      el('p', { class: 'muted small', text: 'Todo lo que llevás jugado, guardado en este dispositivo.' })),
    headActions));

  /* ------------------------------- identidad ------------------------------ */

  screen.appendChild(identityCard(ctx, later));

  /* ------------------------------ estadísticas ---------------------------- */

  screen.appendChild(statsCard(profile));

  /* -------------------------------- ratings ------------------------------- */

  screen.appendChild(ratingsCard(profile));

  /* ------------------------------- dos columnas --------------------------- */

  const columns = el('div', {
    style: {
      display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
      gap: '16px', marginBottom: '16px',
    },
  },
  trophiesCard(ctx),
  achievementsCard(profile));
  screen.appendChild(columns);

  /* ------------------------------- historial ------------------------------ */

  screen.appendChild(historyCard(ctx, download));

  /* --------------------------------- datos -------------------------------- */

  screen.appendChild(dataCard(ctx, download));

  root.appendChild(screen);

  return {
    unmount() {
      for (const id of timers) clearTimeout(id);
      timers.clear();
      for (const url of urls) {
        try { URL.revokeObjectURL(url); } catch { /* nada que revocar */ }
      }
      urls.clear();
    },
  };
}

/* ============================== identidad ================================ */

function identityCard(ctx, later) {
  const profile = ctx.profile;
  const avatarHolder = el('div', { style: { flex: 'none' } }, avatarNode({ avatarSeed: profile.avatarSeed }, 88));
  const displayName = el('h2', { class: 'h2 truncate', text: profile.name || 'Invitado' });

  const tier = ratingTier(bestBucket(profile).rating);
  const subtitle = el('p', { class: 'muted small' },
    el('span', { style: { color: tier.color }, text: `${tier.icon} ${tier.name}` }),
    el('span', { class: 'faint', text: ` · jugando desde el ${formatDate(profile.createdAt)}` }));

  /* --- nombre --- */

  const nameInput = el('input', {
    class: 'input', type: 'text', value: profile.name || '',
    attrs: { maxlength: '24', 'aria-label': 'Nombre visible' },
  });

  function saveName() {
    const value = String(nameInput.value || '').trim().slice(0, 24);
    if (!value) {
      nameInput.value = profile.name || '';
      ctx.toast('El nombre no puede quedar vacío.', 'warn');
      return;
    }
    if (value === profile.name) return;
    profile.name = value;
    displayName.textContent = value;   // nunca innerHTML con datos del usuario
    ctx.saveProfile(profile);
    ctx.toast('Nombre guardado.');
  }

  nameInput.addEventListener('change', saveName);

  /* --- avatar --- */

  const picker = el('div', { class: 'row row--wrap gap-6' });
  const seeds = [];

  function renderPicker() {
    clear(picker);
    for (const seed of seeds) {
      const active = seed === profile.avatarSeed;
      picker.appendChild(el('button', {
        class: 'btn btn--ghost',
        type: 'button',
        style: {
          padding: '3px', width: '52px', height: '52px', flex: 'none',
          borderColor: active ? 'var(--accent)' : 'var(--border)',
        },
        attrs: { 'aria-label': `Usar este avatar`, 'aria-pressed': String(active) },
        onClick: () => {
          profile.avatarSeed = seed;
          clear(avatarHolder);
          avatarHolder.appendChild(avatarNode({ avatarSeed: seed }, 88));
          ctx.saveProfile(profile);
          renderPicker();
        },
      }, avatarNode({ avatarSeed: seed }, 44)));
    }
  }

  for (const seed of [profile.avatarSeed, ...AVATAR_SEEDS]) {
    if (seed && !seeds.includes(seed)) seeds.push(seed);
  }
  renderPicker();

  const shuffle = button('Otro al azar', {
    size: 'sm',
    icon: '🎲',
    onClick: () => {
      const seed = Math.random().toString(36).slice(2, 10);
      seeds.unshift(seed);
      if (seeds.length > 8) seeds.length = 8;
      profile.avatarSeed = seed;
      clear(avatarHolder);
      avatarHolder.appendChild(avatarNode({ avatarSeed: seed }, 88));
      ctx.saveProfile(profile);
      renderPicker();
      later(() => ctx.toast('Avatar actualizado.'), 0);
    },
  });

  const body = el('div', { class: 'row row--wrap gap-24', style: { alignItems: 'flex-start' } },
    el('div', { class: 'col center gap-6', style: { flex: 'none' } }, avatarHolder),
    el('div', { class: 'grow col gap-16', style: { minWidth: '260px' } },
      el('div', { class: 'col gap-4' }, displayName, subtitle),
      el('div', { class: 'row row--wrap gap-6', style: { alignItems: 'flex-end' } },
        el('div', { class: 'grow', style: { minWidth: '180px' } }, field('Nombre visible', nameInput, 'Hasta 24 caracteres.')),
        button('Guardar nombre', { variant: 'primary', onClick: saveName })),
      el('div', { class: 'col gap-6' },
        el('span', { class: 'field__label', text: 'Avatar' }),
        el('div', { class: 'row row--wrap gap-6' }, picker, shuffle))));

  const node = card('Identidad', body);
  node.style.marginBottom = '16px';
  return node;
}

/* ============================= estadísticas ============================== */

function statsCard(profile) {
  const stats = profile.stats || {};
  const wins = stats.wins || 0;
  const losses = stats.losses || 0;
  const draws = stats.draws || 0;
  const total = wins + losses + draws;
  const winPercent = total ? Math.round((wins / total) * 100) : 0;
  const bestWin = stats.bestWin;

  const grid = el('div', { class: 'stat-grid' },
    stat(String(total), 'Partidas jugadas'),
    stat(`${winPercent}%`, `Victorias (${wins}G · ${losses}P · ${draws}T)`),
    stat(String(stats.currentStreak || 0), 'Racha actual', stats.currentStreak > 1 ? 'var(--warn)' : null),
    stat(String(stats.bestStreak || 0), 'Mejor racha'),
    stat(String((profile.defeatedBots || []).length), 'Bots vencidos'),
    stat(`${(profile.achievements || []).length}/${ACHIEVEMENTS.length}`, 'Logros'));

  const best = el('div', {
    class: 'between', style: { marginTop: '12px', paddingTop: '12px', borderTop: '1px solid var(--border-soft)', gap: '10px', flexWrap: 'wrap' },
  });
  if (bestWin) {
    best.appendChild(el('span', { class: 'row gap-6' },
      el('span', { text: '🥇', attrs: { 'aria-hidden': 'true' } }),
      el('span', { class: 'small muted', text: 'Mejor victoria' }),
      el('span', { class: 'strong truncate', text: bestWin.name || '—' })));
    best.appendChild(el('span', { class: 'row gap-6' },
      ratingBadge(bestWin.elo || 0),
      el('span', { class: 'tiny faint', text: formatDate(bestWin.ts) })));
  } else {
    best.appendChild(el('span', { class: 'small faint', text: 'Todavía no tenés una mejor victoria: ganá una partida y aparece acá.' }));
  }

  const node = card('Resumen', grid, best);
  node.style.marginBottom = '16px';
  return node;
}

function stat(value, label, color) {
  return el('div', { class: 'stat' },
    el('div', { class: 'stat__value', style: color ? { color } : null, text: value }),
    el('div', { class: 'stat__label', text: label }));
}

/* ================================ ratings ================================ */

function bestBucket(profile) {
  const ratings = profile.ratings || {};
  let best = null;
  for (const key of CATEGORIES) {
    const bucket = ratings[key];
    if (!bucket) continue;
    if (!best || (bucket.games || 0) > (best.games || 0)) best = { key, ...bucket };
  }
  return best || { key: 'bots', rating: 800, games: 0, history: [] };
}

function ratingsCard(profile) {
  const ratings = profile.ratings || {};
  const rows = el('div', { class: 'col gap-6' });
  const chartHolder = el('div', { style: { minHeight: '170px', marginTop: '12px' } });
  const chips = el('div', { class: 'chip-group', style: { marginTop: '12px' } });

  let current = bestBucket(profile).key;

  for (const key of CATEGORIES) {
    const bucket = ratings[key] || { rating: 800, games: 0, history: [] };
    const played = bucket.games || 0;
    const history = bucket.history || [];
    const last = history.length ? history[history.length - 1] : null;

    rows.appendChild(el('div', {
      class: 'between', style: { padding: '7px 0', borderBottom: '1px solid var(--border-soft)', gap: '10px' },
    },
    el('span', { class: 'row gap-6 grow', style: { minWidth: '0' } },
      ratingBadge(bucket.rating),
      el('span', { class: 'truncate', text: CATEGORY_NAMES[key] || key })),
    el('span', { class: 'row gap-16' },
      el('span', { class: 'tiny faint', text: played ? `${played} partidas` : 'sin partidas' }),
      el('span', { class: 'tiny faint', text: `máx. ${Math.round(bucket.peak || bucket.rating)}` }),
      last ? deltaSpan(last.delta) : el('span', { class: 'delta-zero', text: '—' }))));
  }

  function renderChart() {
    clear(chartHolder);
    const bucket = ratings[current] || { history: [] };
    const history = bucket.history || [];
    chartHolder.appendChild(el('p', { class: 'tiny faint', text: `Evolución en ${CATEGORY_NAMES[current] || current}` }));
    chartHolder.appendChild(ratingChart(history));
    renderChips();
  }

  function renderChips() {
    clear(chips);
    for (const key of CATEGORIES) {
      chips.appendChild(chip(CATEGORY_NAMES[key] || key, {
        active: key === current,
        title: `Ver la evolución en ${CATEGORY_NAMES[key] || key}`,
        onClick: () => { current = key; renderChart(); },
      }));
    }
  }

  renderChart();

  const node = card('Puntuación por categoría', rows, chips, chartHolder);
  node.style.marginBottom = '16px';
  return node;
}

/* ============================ bots vencidos ============================== */

function trophiesCard(ctx) {
  const defeated = new Set(ctx.profile.defeatedBots || []);
  const byBot = (ctx.profile.stats || {}).byBot || {};
  const won = BOTS.filter((bot) => defeated.has(bot.id)).sort((a, b) => b.elo - a.elo);

  if (!won.length) {
    return card('Galería de trofeos',
      emptyState('Todavía no venciste a ningún bot. Cada uno que ganes deja su trofeo acá.',
        button('Elegir rival', { variant: 'primary', onClick: () => ctx.navigate('#/bots') })));
  }

  const grid = el('div', { class: 'trophy-grid' });
  for (const bot of won) {
    const record = byBot[bot.id] || { wins: 0, losses: 0, draws: 0 };
    grid.appendChild(el('button', {
      class: 'trophy',
      type: 'button',
      title: `${bot.name} (${bot.elo}) — ${record.wins}G ${record.losses}P ${record.draws}T. Jugar revancha.`,
      attrs: { 'aria-label': `Vencido: ${bot.name}, ${bot.elo} de Elo. Jugar revancha.` },
      onClick: () => ctx.navigate(`#/jugar/bot/${bot.id}`),
    }, botAvatarNode(bot, 46)));
  }

  const footer = el('div', { class: 'between', style: { marginTop: '12px', gap: '10px', flexWrap: 'wrap' } },
    el('span', { class: 'small muted', text: `${won.length} de ${BOTS.length} bots vencidos` }),
    el('a', { class: 'btn btn--ghost btn--sm', href: '#/bots', text: 'Ver el plantel' }));

  return card('Galería de trofeos', grid, footer);
}

/* ================================ logros ================================= */

function achievementsCard(profile) {
  const unlocked = new Set(profile.achievements || []);
  const ordered = [
    ...ACHIEVEMENTS.filter((a) => unlocked.has(a.id)),
    ...ACHIEVEMENTS.filter((a) => !unlocked.has(a.id)),
  ];

  const grid = el('div', { class: 'ach-grid' });
  for (const achievement of ordered) {
    const has = unlocked.has(achievement.id);
    grid.appendChild(el('div', {
      class: `ach${has ? '' : ' is-locked'}`,
      title: has ? `${achievement.name}: desbloqueado` : `Pendiente — ${achievement.hint}`,
    },
    el('span', { class: 'ach__icon', text: achievement.icon, attrs: { 'aria-hidden': 'true' } }),
    el('div', { class: 'col', style: { minWidth: '0' } },
      el('span', { class: 'ach__name', text: achievement.name }),
      el('span', { class: 'ach__hint', text: achievement.hint }),
      el('span', { class: 'sr-only', text: has ? 'Desbloqueado' : 'Pendiente' }))));
  }

  const header = el('p', { class: 'small muted', style: { marginBottom: '10px' },
    text: `${unlocked.size} de ${ACHIEVEMENTS.length} desbloqueados. Los grises todavía te faltan: la pista dice cómo.` });

  return card('Logros', header, grid);
}

/* =============================== historial =============================== */

function historyCard(ctx, download) {
  const games = loadGames(300);

  if (!games.length) {
    const empty = card('Historial de partidas',
      emptyState('Acá van a aparecer todas tus partidas, con su PGN descargable.',
        button('Jugar la primera', { variant: 'primary', onClick: () => ctx.navigate('#/bots') })));
    empty.style.marginBottom = '16px';
    return empty;
  }

  let shown = HISTORY_PAGE;

  const tbody = el('tbody');
  const table = el('table', { class: 'table' },
    el('thead', null,
      el('tr', null,
        el('th', { text: 'Fecha' }),
        el('th', { text: 'Rival' }),
        el('th', { text: 'Modo' }),
        el('th', { text: 'Resultado' }),
        el('th', { class: 'num', text: 'Elo' }),
        el('th', { class: 'num', text: 'Revisar' }),
        el('th', { class: 'num', text: 'PGN' }))),
    tbody);

  const more = button('Ver más partidas', { size: 'sm', onClick: () => { shown += HISTORY_PAGE; renderRows(); } });
  const footer = el('div', { class: 'between', style: { marginTop: '12px', gap: '10px', flexWrap: 'wrap' } },
    el('span', { class: 'small muted', text: '' }),
    el('div', { class: 'row row--wrap gap-6' },
      more,
      button('Descargar todo en PGN', {
        size: 'sm',
        onClick: () => {
          const pgns = games.map((g) => g.pgn).filter(Boolean);
          if (!pgns.length) {
            ctx.toast('Ninguna partida guardó su PGN.', 'warn');
            return;
          }
          download('ajedrez-maestro-partidas.pgn', `${pgns.join('\n\n')}\n`, 'application/x-chess-pgn');
        },
      })));
  const counter = footer.firstChild;

  function renderRows() {
    clear(tbody);
    for (const game of games.slice(0, shown)) {
      const opponent = game.opponent || {};
      tbody.appendChild(el('tr', null,
        el('td', null, el('span', { class: 'tiny faint', text: formatDate(game.ts) })),
        el('td', null, el('span', { class: 'row gap-6' },
          el('span', { class: 'truncate', text: opponent.name || '—' }),
          typeof opponent.elo === 'number' ? el('span', { class: 'tiny faint mono', text: String(opponent.elo) }) : null)),
        el('td', null, el('span', { class: 'tiny faint', text: `${MODE_NAMES[game.mode] || game.mode || '—'} · ${CATEGORY_NAMES[game.category] || game.category || '—'}` })),
        el('td', null, el('span', { class: 'row gap-6' },
          resultBadge(game.result),
          game.rated === false ? el('span', { class: 'tiny faint', text: 'amistosa' }) : null)),
        el('td', { class: 'num' }, deltaSpan(game.delta)),
        /* Llevar el id al analisis es lo que convierte el historial en algo
           util: se abre la partida entera y se puede repasar jugada a jugada. */
        el('td', { class: 'num' }, game.id
          ? button('Revisar', {
            size: 'sm',
            title: 'Abrir esta partida en el analisis',
            onClick: () => ctx.navigate(`#/analisis/${game.id}`),
          })
          : el('span', { class: 'tiny faint', text: '—' })),
        el('td', { class: 'num' }, pgnButton(ctx, game, download))));
    }
    counter.textContent = `Mostrando ${Math.min(shown, games.length)} de ${games.length} partidas`;
    more.disabled = shown >= games.length;
  }

  renderRows();

  const node = card('Historial de partidas', el('div', { style: { overflowX: 'auto' } }, table), footer);
  node.style.marginBottom = '16px';
  return node;
}

function pgnButton(ctx, game, download) {
  if (!game.pgn) {
    return button('', {
      size: 'sm', icon: '⬇', disabled: true,
      title: 'Esta partida no guardó su PGN',
    });
  }
  const opponent = (game.opponent || {}).name || 'rival';
  const safe = String(opponent).normalize('NFD').replace(/[^\w]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'partida';
  return button('', {
    size: 'sm', icon: '⬇',
    title: `Descargar el PGN de la partida contra ${opponent}`,
    onClick: () => {
      const ok = download(`ajedrez-maestro-${safe}-${game.id || game.ts}.pgn`, `${game.pgn}\n`, 'application/x-chess-pgn');
      if (ok) ctx.toast('PGN descargado.');
    },
  });
}

/* ================================= datos ================================= */

function dataCard(ctx, download) {
  const fileInput = el('input', {
    class: 'hidden', type: 'file',
    attrs: { accept: 'application/json,.json', 'aria-label': 'Archivo de copia de seguridad' },
  });

  fileInput.addEventListener('change', async (ev) => {
    const target = ev && ev.target ? ev.target : fileInput;
    const file = target.files && target.files[0];
    if (!file) return;
    let text = '';
    try {
      text = typeof file.text === 'function' ? await file.text() : '';
    } catch {
      text = '';
    }
    fileInput.value = '';
    if (!text) {
      ctx.toast('No se pudo leer el archivo.', 'err');
      return;
    }
    const outcome = importAll(text);
    if (!outcome.ok) {
      ctx.toast(outcome.error || 'No se pudo importar la copia.', 'err');
      return;
    }
    ctx.toast('Datos importados. Recargando tu perfil…');
    refresh(ctx);
  });

  const actions = el('div', { class: 'row row--wrap gap-6' },
    button('Exportar todos mis datos', {
      variant: 'primary',
      icon: '⬆',
      onClick: () => {
        const ok = download(`ajedrez-maestro-copia-${new Date().toISOString().slice(0, 10)}.json`, exportAll(), 'application/json');
        if (ok) ctx.toast('Copia descargada.');
      },
    }),
    button('Importar una copia', {
      icon: '⬇',
      onClick: () => fileInput.click(),
    }),
    button('Borrar todos los datos', {
      variant: 'danger',
      onClick: async () => {
        const sure = await ctx.confirm({
          title: 'Borrar todos los datos',
          message: 'Se borran el perfil, la puntuación, los logros, las partidas y los torneos. No se puede deshacer.',
          confirmLabel: 'Borrar todo',
          cancelLabel: 'Cancelar',
          danger: true,
        });
        if (!sure) return;
        resetAll();
        ctx.toast('Datos borrados.', 'warn');
        refresh(ctx);
      },
    }));

  const node = card('Copia de seguridad',
    el('p', { class: 'muted small', style: { marginBottom: '12px' },
      text: 'Todo se guarda solo en este navegador. Exportá un archivo JSON para llevarte el progreso a otro dispositivo; al importar, se reemplaza lo que haya ahora.' }),
    actions,
    fileInput);
  node.style.marginBottom = '16px';
  return node;
}

/** Re-reads storage into the shared context and repaints the screen. */
function refresh(ctx) {
  if (typeof ctx.reloadProfile === 'function') ctx.reloadProfile();
  ctx.navigate('#/perfil');
}
