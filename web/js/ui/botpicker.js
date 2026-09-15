/**
 * ui/botpicker.js — the opponent gallery: every bot as a card with its avatar,
 * flag, rating and trophy, filtered by tier, style and name. Picking one opens
 * the setup panel (colour, time control, rated, assists) and from there the
 * screen hands over to the game screen through the hash route.
 */

import { el, clear, button, chip, field, select, switchControl, botAvatarNode, emptyState } from './components.js';
import { BOTS, botsByTier, eloOf, setLiveElo } from '../bots.js';
import { fetchGithubElo } from '../github.js';
import { flagEmoji } from '../pieces.js';
import { ratingTier, RATING_TIERS } from '../elo.js';
import { TIME_CONTROLS, CATEGORY_NAMES, timeCategory } from '../clock.js';

const STYLE_LABELS = {
  agresivo: 'Agresivo',
  posicional: 'Posicional',
  tactico: 'Táctico',
  caotico: 'Caótico',
  solido: 'Sólido',
  materialista: 'Materialista',
  romantico: 'Romántico',
  tecnico: 'Técnico',
};

/* Los controles de tiempo que pide el contrato para jugar contra la maquina. */
const PICKER_TC = ['sin-reloj', '1+0', '3+0', '3+2', '5+0', '10+0', '15+10', '30+0'];

function timeControls() {
  return PICKER_TC
    .map((id) => TIME_CONTROLS.find((tc) => tc.id === id))
    .filter(Boolean);
}

function normalize(text) {
  return String(text)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

export function mount(root, ctx, params = {}) {
  const defeated = new Set(ctx.profile?.defeatedBots || []);
  const state = {
    view: 'list',
    search: '',
    tier: null,
    style: null,
    bot: null,
    color: 'random',
    tc: 'sin-reloj',
    rated: true,
    showLegal: ctx.settings?.showLegalMoves !== false,
    takeback: true,
    hints: true,
  };

  clear(root);
  const screen = el('div', { class: 'screen' });
  root.appendChild(screen);

  /* ------------------------------ listado ------------------------------ */

  function matches(bot) {
    if (state.tier && ratingTier(bot.elo).key !== state.tier) return false;
    if (state.style && bot.style !== state.style) return false;
    if (state.search) {
      const needle = normalize(state.search);
      const haystack = normalize(`${bot.name} ${bot.tagline} ${bot.style} ${bot.country}`);
      if (!haystack.includes(needle)) return false;
    }
    return true;
  }

  function botCard(bot) {
    const tier = ratingTier(bot.elo);
    const won = defeated.has(bot.id);
    const card = el('button', {
      class: 'bot-card',
      type: 'button',
      title: bot.bio,
      attrs: { 'aria-label': `${bot.name}, ${eloOf(bot)} de Elo, estilo ${STYLE_LABELS[bot.style] || bot.style}` },
      onClick: () => openSetup(bot),
    });

    /* La tarjeta es una fila: avatar + una columna con los datos. Si se cuelgan
       todos como hermanos, el flex los reparte en horizontal y se desbordan. */
    card.appendChild(el('div', { class: 'bot-card__avatar' }, botAvatarNode(bot, 52)));

    const name = el('div', { class: 'bot-card__name' });
    name.appendChild(el('span', { class: 'truncate', text: bot.name }));
    if (bot.title) name.appendChild(el('span', { class: 'tiny upper faint', text: bot.title }));

    const info = el('div', { class: 'col grow', style: { minWidth: '0', gap: '2px' } },
      name,
      el('div', { class: 'bot-card__elo row gap-4' },
        el('span', { text: flagEmoji(bot.country), attrs: { 'aria-hidden': 'true' } }),
        el('span', { class: 'mono', text: String(eloOf(bot)) }),
        el('span', { style: { color: tier.color }, text: tier.icon, attrs: { 'aria-hidden': 'true' } }),
        el('span', { class: 'truncate', text: STYLE_LABELS[bot.style] || bot.style })),
      el('div', { class: 'bot-card__tag truncate', text: bot.tagline }));
    card.appendChild(info);

    if (won) {
      card.appendChild(el('div', {
        class: 'bot-card__trophy',
        text: '🏆',
        title: 'Ya le has ganado',
        attrs: { 'aria-label': 'Ya le has ganado' },
      }));
    }
    return card;
  }

  /* El Elo de Bauverso puede haber cambiado desde la ultima vez: se pide al
     entrar y se repinta si volvio distinto. */
  let vivo = true;
  fetchGithubElo().then((dato) => {
    if (!vivo || !dato || !dato.elo) return;
    if (setLiveElo('bauverso', dato.elo)) renderList();
  }).catch(() => { /* da igual: se queda con el que hubiera */ });

  function renderList() {
    clear(screen);

    const head = el('div', { class: 'screen__head' },
      el('div', { class: 'col' },
        el('h1', { class: 'h1', text: 'Contra la máquina' }),
        el('p', { class: 'muted', text: `${BOTS.length} rivales con estilo propio, de 250 a 2900 de Elo. Ya has vencido a ${defeated.size}.` })));
    screen.appendChild(head);

    /* Buscador */
    const search = el('input', {
      class: 'input',
      type: 'search',
      value: state.search,
      placeholder: 'Buscar por nombre, estilo o país…',
      attrs: { 'aria-label': 'Buscar rival' },
      onInput: (event) => {
        state.search = event.target.value || '';
        renderGrid();
      },
    });
    screen.appendChild(el('div', { class: 'row gap-16' }, el('div', { class: 'grow' }, search)));

    /* Filtros por tramo */
    const tiersUsed = botsByTier().map((group) => group.tier.key);
    /* Con 28 rivales y ocho estilos, los filtros no caben en una linea. */
    const tierRow = el('div', { class: 'row gap-6 row--wrap' });
    tierRow.appendChild(chip('Todos', {
      active: state.tier === null,
      onClick: () => { state.tier = null; renderList(); },
    }));
    for (const tier of RATING_TIERS) {
      if (!tiersUsed.includes(tier.key)) continue;
      tierRow.appendChild(chip(`${tier.icon} ${tier.name}`, {
        active: state.tier === tier.key,
        onClick: () => { state.tier = state.tier === tier.key ? null : tier.key; renderList(); },
      }));
    }
    screen.appendChild(tierRow);

    /* Filtros por estilo */
    const styleRow = el('div', { class: 'row gap-6 row--wrap' });
    styleRow.appendChild(chip('Cualquier estilo', {
      active: state.style === null,
      onClick: () => { state.style = null; renderList(); },
    }));
    for (const [key, label] of Object.entries(STYLE_LABELS)) {
      if (!BOTS.some((b) => b.style === key)) continue;
      styleRow.appendChild(chip(label, {
        active: state.style === key,
        onClick: () => { state.style = state.style === key ? null : key; renderList(); },
      }));
    }
    screen.appendChild(styleRow);

    const grid = el('div', { class: 'bot-grid' });
    screen.appendChild(grid);

    function renderGrid() {
      clear(grid);
      const list = BOTS.filter(matches).sort((a, b) => a.elo - b.elo);
      if (list.length === 0) {
        grid.appendChild(emptyState('Ningún rival coincide con esa búsqueda.',
          button('Quitar filtros', {
            onClick: () => { state.search = ''; state.tier = null; state.style = null; renderList(); },
          })));
        return;
      }
      for (const bot of list) grid.appendChild(botCard(bot));
    }

    renderGrid();
  }

  /* ------------------------- panel de configuracion ------------------------ */

  function openSetup(bot) {
    state.bot = bot;
    state.view = 'setup';
    ctx.sound?.play('click');
    renderSetup();
  }

  function renderSetup() {
    const bot = state.bot;
    const tier = ratingTier(bot.elo);
    clear(screen);

    screen.appendChild(el('div', { class: 'screen__head' },
      button('Volver', { variant: 'ghost', onClick: () => { state.view = 'list'; renderList(); } })));

    /* Ficha del rival */
    const ficha = el('div', { class: 'card' },
      el('div', { class: 'row gap-16' },
        botAvatarNode(bot, 96),
        el('div', { class: 'col grow' },
          el('h1', { class: 'h2', text: bot.name + (bot.title ? ` (${bot.title})` : '') }),
          el('div', { class: 'row gap-6' },
            el('span', { text: flagEmoji(bot.country) }),
            el('span', { class: 'mono', text: `${eloOf(bot)}` }),
            el('span', { class: 'tier-chip', style: { color: tier.color } },
              el('span', { text: tier.icon }), el('span', { text: tier.name })),
            el('span', { class: 'chip', text: STYLE_LABELS[bot.style] || bot.style })),
          el('p', { class: 'muted', text: bot.bio }),
          el('p', { class: 'small faint', text: `Aperturas favoritas: ${bot.favoriteOpenings.join(', ')}` }),
          defeated.has(bot.id)
            ? el('p', { class: 'small', text: '🏆 Ya le has ganado alguna vez.' })
            : el('p', { class: 'small faint', text: 'Todavía no le has ganado.' }))));
    screen.appendChild(ficha);

    /* Opciones */
    const opciones = el('section', { class: 'card' });
    opciones.appendChild(el('h2', { class: 'card__title', text: 'Configurá la partida' }));

    opciones.appendChild(field('Tus piezas', select([
      { value: 'white', label: 'Blancas' },
      { value: 'black', label: 'Negras' },
      { value: 'random', label: 'Al azar' },
    ], {
      value: state.color,
      ariaLabel: 'Color de tus piezas',
      onChange: (event) => { state.color = event.target.value; },
    })));

    const tcs = timeControls();
    opciones.appendChild(field('Control de tiempo', select(
      tcs.map((tc) => ({
        value: tc.id,
        label: tc.base ? `${tc.label} · ${CATEGORY_NAMES[timeCategory(tc.base, tc.inc)]}` : tc.label,
      })),
      {
        value: state.tc,
        ariaLabel: 'Control de tiempo',
        onChange: (event) => { state.tc = event.target.value; },
      },
    )));

    opciones.appendChild(switchControl('Partida puntuable', {
      checked: state.rated,
      onChange: (event) => { state.rated = !!event.target.checked; },
    }));
    opciones.appendChild(el('p', { class: 'tiny faint', text: 'Si la desactivás, el resultado no afecta a tu puntuación.' }));

    opciones.appendChild(el('h3', { class: 'h3', text: 'Ayudas' }));
    opciones.appendChild(switchControl('Mostrar jugadas legales', {
      checked: state.showLegal,
      onChange: (event) => { state.showLegal = !!event.target.checked; },
    }));
    opciones.appendChild(switchControl('Permitir deshacer', {
      checked: state.takeback,
      onChange: (event) => { state.takeback = !!event.target.checked; },
    }));
    opciones.appendChild(switchControl('Permitir pistas', {
      checked: state.hints,
      onChange: (event) => { state.hints = !!event.target.checked; },
    }));

    opciones.appendChild(el('div', { class: 'row gap-6' },
      button('Empezar la partida', { variant: 'primary', size: 'lg', onClick: start }),
      button('Elegir otro rival', { variant: 'ghost', onClick: () => { state.view = 'list'; renderList(); } })));

    screen.appendChild(opciones);
  }

  function start() {
    const query = new URLSearchParams({
      color: state.color,
      tc: state.tc,
      rated: state.rated ? '1' : '0',
      legal: state.showLegal ? '1' : '0',
      undo: state.takeback ? '1' : '0',
      hints: state.hints ? '1' : '0',
    }).toString();
    ctx.navigate(`#/jugar/bot/${state.bot.id}?${query}`);
  }

  /* Si llegan con un bot ya elegido en la ruta, se abre su panel directamente. */
  const preset = params.botId ? BOTS.find((b) => b.id === params.botId) : null;
  if (preset) openSetup(preset);
  else renderList();

  return {
    unmount() {
      clear(root);
    },
  };
}
