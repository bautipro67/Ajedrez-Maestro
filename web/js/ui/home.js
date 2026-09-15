/**
 * ui/home.js — landing screen: the four play modes, a snapshot of your
 * ratings, your last game and a few suggested opponents.
 */

import { el, card, button, ratingBadge, resultBadge, deltaSpan, formatDate, emptyState, botAvatarNode } from './components.js';
import { ratingTier } from '../elo.js';
import { CATEGORY_NAMES } from '../clock.js';
import { createBoard } from '../board.js';
import { loadGames, loadTournaments } from '../storage.js';

const MODES = [
  {
    icon: '🤖', title: 'Contra la máquina', route: '#/bots',
    desc: 'Enfrentá a 29 personajes con estilos y niveles distintos, de 250 a 2900 de Elo.',
  },
  {
    icon: '🌐', title: 'Jugar online', route: '#/online',
    desc: 'Partidas puntuables contra otras personas, con emparejamiento por puntuación.',
  },
  {
    icon: '👥', title: 'Local a dos', route: '#/jugar/local',
    desc: 'Dos jugadores en el mismo dispositivo, con reloj y todas las reglas.',
  },
  {
    icon: '🏆', title: 'Torneos', route: '#/torneos',
    desc: 'Suizo, liga, eliminatoria o arena contra un cuadro de bots. Con clasificación real.',
  },
  {
    icon: '🎯', title: 'Entrenamiento', route: '#/entrenamiento',
    desc: 'Posiciones con una sola jugada buena, y los errores de tus propias partidas convertidos en problemas.',
  },
];

export function mount(root, ctx) {
  const profile = ctx.profile;
  const screen = el('div', { class: 'screen' });

  /* ------------------------------- hero -------------------------------- */

  const boardHolder = el('div', { style: { width: 'min(280px, 70vw)', flex: 'none' } });
  const hero = el('section', {
    class: 'card',
    style: {
      display: 'flex', gap: '26px', alignItems: 'center', flexWrap: 'wrap',
      marginBottom: '22px', padding: '24px',
      background: 'linear-gradient(135deg, #2C3A20, var(--surface) 60%)',
    },
  },
  boardHolder,
  el('div', { class: 'grow col gap-16', style: { minWidth: '260px' } },
    el('h1', { class: 'h1', text: 'Ajedrez Maestro' }),
    el('p', { class: 'muted', style: { maxWidth: '52ch' },
      text: 'Jugá contra bots con personalidad propia, desafiá a otras personas online, armá torneos completos y seguí tu progreso con un sistema de puntuación de verdad.' }),
    el('div', { class: 'row row--wrap gap-6' },
      button('Jugar contra un bot', { variant: 'primary', size: 'lg', onClick: () => ctx.navigate('#/bots') }),
      button('Buscar rival online', { size: 'lg', onClick: () => ctx.navigate('#/online') }))));

  screen.appendChild(hero);

  const board = createBoard(boardHolder, {
    interactive: false, coordinates: false,
    theme: ctx.settings.boardTheme, pieceSet: ctx.settings.pieceSet,
  });
  const demo = runDemo(board);

  /* ------------------------------ modos -------------------------------- */

  const modeGrid = el('div', { class: 'mode-grid', style: { marginBottom: '22px' } });
  for (const mode of MODES) {
    modeGrid.appendChild(el('button', {
      class: 'mode-card', type: 'button',
      onClick: () => ctx.navigate(mode.route),
    },
    el('span', { class: 'mode-card__icon', text: mode.icon }),
    el('span', { class: 'mode-card__title', text: mode.title }),
    el('span', { class: 'mode-card__desc', text: mode.desc })));
  }
  screen.appendChild(modeGrid);

  /* ------------------------- columnas inferiores ------------------------ */

  const columns = el('div', {
    style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '16px' },
  });

  columns.appendChild(ratingsCard(profile));
  columns.appendChild(lastGamesCard(ctx));
  columns.appendChild(suggestionsCard(ctx));

  screen.appendChild(columns);
  root.appendChild(screen);

  return {
    unmount() {
      demo.stop();
      board.destroy();
    },
  };
}

/* ------------------------------- tarjetas -------------------------------- */

function ratingsCard(profile) {
  const body = el('div', { class: 'col gap-6' });
  const entries = Object.entries(profile.ratings || {});
  const played = entries.filter(([, value]) => (value.games || 0) > 0);
  const shown = played.length ? played : entries.filter(([key]) => key === 'bots' || key === 'rapid');

  for (const [key, value] of shown) {
    const tier = ratingTier(value.rating);
    body.appendChild(el('div', { class: 'between', style: { padding: '5px 0' } },
      el('span', { class: 'row gap-6' },
        el('span', { text: tier.icon }),
        el('span', { text: CATEGORY_NAMES[key] || key })),
      el('span', { class: 'row gap-6' },
        el('span', { class: 'mono strong', text: String(Math.round(value.rating)) }),
        el('span', { class: 'tiny faint', text: value.games ? `${value.games} partidas` : 'sin partidas' }))));
  }

  const stats = profile.stats || {};
  const total = (stats.wins || 0) + (stats.losses || 0) + (stats.draws || 0);
  body.appendChild(el('div', {
    class: 'row gap-16', style: { marginTop: '10px', paddingTop: '10px', borderTop: '1px solid var(--border-soft)' },
  },
  el('span', { class: 'small muted', text: `${total} partidas` }),
  el('span', { class: 'small', style: { color: 'var(--accent)' }, text: `${stats.wins || 0} G` }),
  el('span', { class: 'small', style: { color: 'var(--danger)' }, text: `${stats.losses || 0} P` }),
  el('span', { class: 'small muted', text: `${stats.draws || 0} T` }),
  stats.currentStreak > 1 ? el('span', { class: 'small', style: { color: 'var(--warn)' }, text: `🔥 ${stats.currentStreak}` }) : null));

  body.appendChild(el('a', { class: 'btn btn--ghost btn--sm', href: '#/perfil', text: 'Ver perfil completo', style: { marginTop: '6px' } }));
  return card('Tus puntuaciones', body);
}

function lastGamesCard(ctx) {
  const games = loadGames(6);
  if (!games.length) {
    return card('Últimas partidas', emptyState('Todavía no jugaste ninguna partida.',
      button('Empezar ahora', { variant: 'primary', onClick: () => ctx.navigate('#/bots') })));
  }

  const list = el('div', { class: 'col', style: { gap: '2px' } });
  for (const game of games) {
    list.appendChild(el('div', { class: 'between', style: { padding: '7px 0', borderBottom: '1px solid var(--border-soft)' } },
      el('span', { class: 'row gap-6 grow', style: { minWidth: '0' } },
        resultBadge(game.result),
        el('span', { class: 'truncate', text: game.opponent?.name || '—' })),
      el('span', { class: 'row gap-6' },
        deltaSpan(game.delta),
        el('span', { class: 'tiny faint', text: formatDate(game.ts) }))));
  }

  const last = games[0];
  const actions = el('div', { class: 'row gap-6', style: { marginTop: '10px' } });
  if (last.opponent?.botId) {
    actions.appendChild(button('Revancha', {
      variant: 'primary', size: 'sm',
      onClick: () => ctx.navigate(`#/jugar/bot/${last.opponent.botId}`),
    }));
  }
  actions.appendChild(el('a', { class: 'btn btn--ghost btn--sm', href: '#/perfil', text: 'Historial' }));

  return card('Últimas partidas', list, actions);
}

function suggestionsCard(ctx) {
  const body = el('div', { class: 'col gap-6' });
  const holder = card('Rivales sugeridos', body);

  import('../bots.js').then(({ BOTS }) => {
    const profile = ctx.profile;
    const myRating = profile.ratings?.bots?.rating || 800;
    const defeated = new Set(profile.defeatedBots || []);
    const candidates = [...BOTS]
      .sort((a, b) => Math.abs(a.elo - myRating) - Math.abs(b.elo - myRating))
      .slice(0, 8)
      .sort((a, b) => a.elo - b.elo)
      .slice(0, 4);

    for (const bot of candidates) {
      const row = el('button', {
        class: 'bot-card', type: 'button', style: { padding: '8px' },
        onClick: () => ctx.navigate(`#/jugar/bot/${bot.id}`),
      },
      botAvatarNode(bot, 40),
      el('span', { class: 'grow col', style: { gap: '1px', minWidth: '0', alignItems: 'flex-start' } },
        el('span', { class: 'bot-card__name', text: bot.name }),
        el('span', { class: 'bot-card__tag truncate', text: bot.tagline || bot.style })),
      ratingBadge(bot.elo));
      if (defeated.has(bot.id)) row.appendChild(el('span', { class: 'bot-card__trophy', text: '🏆' }));
      body.appendChild(row);
    }

    body.appendChild(el('a', { class: 'btn btn--ghost btn--sm', href: '#/bots', text: 'Ver los 29 bots' }));
  }).catch(() => {
    body.appendChild(el('p', { class: 'muted small', text: 'No se pudo cargar el plantel de bots.' }));
  });

  return holder;
}

/* ------------------------- tablero decorativo ---------------------------- */

/** Replays a short famous-style miniature on the hero board, on a loop. */
function runDemo(board) {
  const fens = [
    'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6 0 2',
    'rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2',
    'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3',
    'r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3',
    'r1bqk1nr/pppp1ppp/2n5/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4',
    'r1bqk1nr/pppp1ppp/2n5/2b1p3/2B1P3/2P2N2/PP1P1PPP/RNBQK2R b KQkq - 0 4',
    'r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/2P2N2/PP1P1PPP/RNBQK2R w KQkq - 1 5',
    'r1bqk2r/pppp1ppp/2n2n2/2b1p3/2BPP3/2P2N2/PP3PPP/RNBQK2R b KQkq d3 0 5',
  ];
  let index = 0;
  let timer = null;

  function step() {
    board.setPosition(fens[index], { animate: index > 0 });
    index = (index + 1) % fens.length;
    timer = setTimeout(step, index === 1 ? 1600 : 1100);
  }
  step();

  return {
    stop() {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
