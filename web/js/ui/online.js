/**
 * ui/online.js — the online lobby: connection status, quick pairing, open
 * games, game creation, private codes, leaderboard and live games to watch.
 * The match server may well be down, so the offline branch gets the most care:
 * it says so in plain words, retries a few times quietly without the screen
 * flickering between states, and points at everything that works offline.
 */

import {
  el, clear, button, chip, field, select, switchControl,
  avatarNode, ratingBadge, emptyState, spinner,
} from './components.js';
import { ONLINE_ERRORS, toEndpoint } from '../online.js';
import { TIME_CONTROLS, CATEGORY_NAMES, timeCategory } from '../clock.js';

/* Online play always has a clock: 'sin-reloj' is deliberately left out. */
const CREATE_TC = ['1+0', '2+1', '3+0', '3+2', '5+0', '5+3', '10+0', '10+5', '15+10', '30+0'];
const QUICK_TC = ['1+0', '3+0', '3+2', '5+0', '10+0', '15+10'];

/* What we can offer while there is nobody on the other side. */
const OFFLINE_MODES = [
  {
    icon: '🤖', title: 'Contra la máquina', route: '#/bots',
    desc: '29 rivales con estilo propio, de 250 a 2900 de Elo. Tu puntuación sube y baja igual que online.',
  },
  {
    icon: '👥', title: 'Local a dos', route: '#/jugar/local',
    desc: 'Dos personas en el mismo dispositivo, con reloj y todas las reglas.',
  },
  {
    icon: '🏆', title: 'Torneos', route: '#/torneos',
    desc: 'Armá un suizo, una liga o una eliminatoria contra un cuadro de bots.',
  },
];

const CONNECT_TIMEOUT_MS = 6000;   // after this without a link we assume there is no server
const LOBBY_REFRESH_MS = 12000;
const FALLBACK_POLL_MS = 1500;

function tcById(id) {
  return TIME_CONTROLS.find((tc) => tc.id === id) || TIME_CONTROLS[5];
}

/** '5+3' from a server-side {base, inc} in seconds. */
function tcText(tc) {
  if (!tc || !tc.base) return 'Sin reloj';
  return `${Math.round(tc.base / 60)}+${tc.inc || 0}`;
}

function tcCategory(tc) {
  if (!tc) return '';
  return CATEGORY_NAMES[timeCategory(tc.base, tc.inc)] || '';
}

function playerName(player) {
  if (!player) return 'Anónimo';
  if (typeof player === 'string') return player;
  return player.name || 'Anónimo';
}

function timeAgo(ts) {
  if (!ts) return '';
  const secs = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (secs < 60) return `hace ${secs} s`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `hace ${mins} min`;
  return `hace ${Math.round(mins / 60)} h`;
}

/**
 * The lobby message may also carry games already under way. The protocol does
 * not pin down that shape, so accept the reasonable ones and ignore the rest.
 */
function liveFrom(msg) {
  if (Array.isArray(msg.live)) return msg.live;
  if (!Array.isArray(msg.games)) return [];
  return msg.games.filter((g) => g && (g.live === true || g.status === 'playing' || (g.white && g.black)));
}

export function mount(root, ctx, params = {}) {
  const online = ctx.online || null;

  const state = {
    conn: 'connecting',        // 'connecting' | 'online' | 'offline'
    latency: null,
    everFailed: false,         // ya fallo una vez: los reintentos van en silencio
    gaveUp: false,             // el cliente dejo de reintentar solo
    me: null,                  // what the server says about us, from 'welcome'
    games: [],
    live: [],
    top: [],
    players: 0,                // personas conectadas, segun el servidor
    queue: 0,                  // cuantas estan buscando rival
    searching: false,
    searchStartedAt: 0,
    quickTc: '3+0',
    quickRated: true,
    newTc: '5+0',
    newColor: 'random',
    newRated: true,
    newPrivate: false,
    code: String(params.code || ''),
    resumeId: null,            // partida tuya que sigue viva, si el servidor avisa
  };

  let alive = true;
  let connectTimer = null;
  let searchTimer = null;
  let refreshTimer = null;
  let unsubscribe = () => {};

  /* Cards whose controls only make sense with a live connection. */
  const gatedSections = [];
  function gated(node) {
    gatedSections.push(node);
    return node;
  }

  clear(root);
  const screen = el('div', { class: 'screen' });
  root.appendChild(screen);

  /* ---------------------------- encabezado ----------------------------- */

  const dot = el('span', { class: 'conn-dot is-wait' });
  const connText = el('span', { class: 'small', text: 'Conectando…' });
  const connPill = el('div', {
    class: 'row gap-6',
    attrs: { role: 'status', 'aria-live': 'polite' },
  }, dot, connText);

  const identityMeta = el('div', { class: 'row gap-6' });
  const identity = el('div', { class: 'row gap-6' },
    avatarNode(ctx.profile, 36),
    el('div', { class: 'col gap-4' },
      el('span', { class: 'strong truncate', text: ctx.profile?.name || 'Invitado' }),
      identityMeta));

  screen.appendChild(el('div', { class: 'screen__head' },
    el('div', { class: 'col gap-4' },
      el('h1', { class: 'h1', text: 'Jugar online' }),
      el('p', { class: 'muted', text: 'Partidas contra otras personas, emparejadas por puntuación y con el reloj arbitrado por el servidor.' })),
    el('div', { class: 'col gap-6' }, connPill, identity)));

  /* --------------------- aviso de servidor caído ----------------------- */

  const bannerIcon = el('div', { class: 'center', style: { width: '34px', flex: 'none' } });
  const bannerTitle = el('h2', { class: 'h2', text: 'Buscando el servidor de partidas…' });
  const bannerDesc = el('p', { class: 'muted', style: { maxWidth: '62ch' }, text: 'Un momento, estamos intentando entrar en la sala.' });
  const retryLine = el('p', { class: 'tiny faint', text: '' });

  const retryButton = button('Reintentar ahora', { variant: 'primary', onClick: () => retry(true) });
  const retryLabel = retryButton.querySelector('span');

  /* Servido desde itch.io o GitHub Pages, el cliente intentaria conectarse a
     ESA direccion, donde no hay ningun servidor de partidas. Por eso se puede
     escribir aqui donde vive el tuyo. */
  const serverInput = el('input', {
    class: 'input',
    type: 'url',
    value: (ctx.settings && ctx.settings.serverUrl) || '',
    placeholder: 'https://tu-servidor.onrender.com',
    attrs: { 'aria-label': 'Dirección del servidor de partidas', spellcheck: 'false' },
  });
  const serverHint = el('span', { class: 'tiny faint', text: '' });
  const serverSave = button('Usar este servidor', {
    onClick: () => {
      const valor = serverInput.value.trim();
      /* Si no se entiende, mejor decirlo aqui que dejar al cliente golpeando
         una direccion imposible durante un minuto. */
      if (valor && !toEndpoint(valor)) {
        ctx.toast('No entiendo esa dirección. Tiene que ser algo como https://tu-servidor.onrender.com', 'err');
        serverInput.focus();
        return;
      }
      if (ctx.settings) ctx.settings.serverUrl = valor;
      ctx.saveSettings({ serverUrl: valor });
      ctx.toast(valor ? 'Guardado. Reconectando…' : 'Se usará el mismo sitio de la página.', '');
      setTimeout(() => location.reload(), 600);
    },
  });

  /** Enseña a donde se va a conectar de verdad, para que no haya sorpresas. */
  function renderServerHint() {
    const valor = serverInput.value.trim();
    if (!valor) { serverHint.textContent = ''; return; }
    const destino = toEndpoint(valor);
    serverHint.textContent = destino
      ? `Se conectará a ${destino}`
      : 'No entiendo esa dirección.';
  }
  serverInput.addEventListener('input', renderServerHint);
  const serverRow = el('div', { class: 'col gap-6', style: { maxWidth: '52ch' } },
    el('span', { class: 'field__label', text: 'Servidor de partidas' }),
    el('span', { class: 'tiny faint', text: 'Dejalo vacío si abrís el juego desde el propio servidor. Si lo abrís en itch.io o GitHub Pages, pegá aquí la dirección donde lo tengas publicado; la de la página sirve tal cual, no hace falta añadirle nada.' }),
    el('div', { class: 'row row--wrap gap-6' }, serverInput, serverSave),
    serverHint);

  const retryRow = el('div', { class: 'col gap-16 hidden' },
    el('div', { class: 'row row--wrap gap-6' }, retryButton),
    serverRow);

  const offlineGrid = el('div', { class: 'mode-grid' });
  for (const mode of OFFLINE_MODES) {
    offlineGrid.appendChild(el('button', {
      class: 'mode-card',
      type: 'button',
      onClick: () => ctx.navigate(mode.route),
    },
    el('span', { class: 'mode-card__icon', text: mode.icon, attrs: { 'aria-hidden': 'true' } }),
    el('span', { class: 'mode-card__title', text: mode.title }),
    el('span', { class: 'mode-card__desc', text: mode.desc })));
  }

  const offlineExtras = el('div', { class: 'col gap-16 hidden' },
    el('h3', { class: 'h3', text: 'Mientras tanto, esto funciona sin conexión' }),
    offlineGrid);

  const banner = el('section', { class: 'card col gap-16', style: { marginBottom: '18px' } },
    el('div', { class: 'row gap-16' },
      bannerIcon,
      el('div', { class: 'col gap-4 grow' }, bannerTitle, bannerDesc, retryLine)),
    retryRow,
    offlineExtras);
  screen.appendChild(banner);

  /* ------------------ la partida que ya tenias en marcha ---------------- */

  const resumeText = el('p', { class: 'muted', text: '' });
  const resumeButton = button('Volver a la partida', {
    variant: 'primary',
    onClick: () => { if (state.resumeId) ctx.navigate(`#/jugar/online/${state.resumeId}`); },
  });
  const resumeCard = el('section', {
    class: 'card row row--wrap gap-16 hidden',
    style: { marginBottom: '18px', alignItems: 'center' },
  },
  el('div', { class: 'col gap-4 grow' },
    el('h2', { class: 'h2', text: 'Tenés una partida en curso' }),
    resumeText),
  resumeButton);
  screen.appendChild(resumeCard);

  /**
   * Al reconectar, el servidor reenvia las partidas que seguis jugando. Eso no
   * es una partida nueva, asi que aqui solo se avisa: entrar solo, a la fuerza
   * y cada vez que el socket parpadea, era insoportable.
   */
  function showResume(game) {
    const mia = game && game.status === 'playing' && game.youAre;
    state.resumeId = mia ? game.id : null;
    if (!mia) { resumeCard.classList.add('hidden'); return; }
    const rival = game.youAre === 'w' ? game.black : game.white;
    resumeText.textContent = `Contra ${rival?.name || 'tu rival'}. El reloj corre igual mientras no estés, así que conviene volver.`;
    resumeCard.classList.remove('hidden');
  }

  const lobbyNote = el('p', {
    class: 'small faint hidden',
    style: { marginBottom: '12px' },
    text: 'Dejamos el lobby a la vista para que sepas qué vas a encontrar, pero no se puede usar hasta que haya servidor.',
  });
  screen.appendChild(lobbyNote);

  /* ------------------------------ columnas ----------------------------- */

  const columns = el('div', {
    style: {
      display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(320px, 100%), 1fr))',
      gap: '16px', alignItems: 'start',
    },
  });
  screen.appendChild(columns);

  const leftCol = el('div', { class: 'col gap-16' });
  const rightCol = el('div', { class: 'col gap-16' });
  columns.appendChild(leftCol);
  columns.appendChild(rightCol);

  /* --------------------- emparejamiento rápido ------------------------- */

  const quickChips = el('div', { class: 'chip-group' });
  const quickButton = button('Buscar rival', { variant: 'primary', size: 'lg', onClick: startQuick });
  const cancelButton = button('Cancelar la búsqueda', { variant: 'ghost', onClick: () => stopSearch(true) });
  const searchingText = el('p', { class: 'muted', text: 'Buscando rival de tu nivel…' });
  /* Esperar a que aparezca alguien que no existe es la peor pantalla posible:
     si no hay nadie mas buscando se dice, y se ofrece algo que si se puede
     hacer ahora mismo. */
  const soloNota = el('p', { class: 'small muted', text: '' });
  const soloSalida = el('div', { class: 'row row--wrap gap-6' },
    button('Jugar contra un bot de tu nivel', { onClick: () => ctx.navigate('#/bots') }));
  const soloBox = el('div', { class: 'col gap-6 hidden' }, soloNota, soloSalida);
  const searchingBox = el('div', { class: 'searching hidden' }, spinner(26), searchingText, soloBox, cancelButton);
  const quickNote = el('p', { class: 'small faint', text: '' });

  const quickCard = gated(el('section', { class: 'card' },
    el('h2', { class: 'card__title', text: 'Emparejamiento rápido' }),
    el('p', { class: 'small muted', text: 'Elegí el ritmo y te buscamos a alguien de puntuación parecida.' }),
    quickChips,
    switchControl('Partida puntuable', {
      checked: state.quickRated,
      onChange: (event) => { state.quickRated = !!event.target.checked; },
    }),
    el('div', { class: 'row row--wrap gap-6' }, quickButton),
    quickNote,
    searchingBox));
  leftCol.appendChild(quickCard);

  function renderQuickChips() {
    clear(quickChips);
    for (const id of QUICK_TC) {
      const tc = tcById(id);
      quickChips.appendChild(chip(tc.label, {
        active: state.quickTc === id,
        title: tcCategory(tc),
        onClick: () => {
          state.quickTc = id;
          renderQuickChips();
          renderIdentity();
          refreshControls();
        },
      }));
    }
  }

  /* ------------------------- partidas abiertas ------------------------- */

  const gamesBody = el('div');
  const gamesCard = gated(el('section', { class: 'card card--pad-0' },
    el('div', { class: 'card__head' },
      el('h2', { class: 'card__title', text: 'Partidas abiertas' }),
      button('Actualizar', { variant: 'ghost', size: 'sm', onClick: requestData })),
    gamesBody));
  leftCol.appendChild(gamesCard);

  function renderGames() {
    clear(gamesBody);
    if (state.conn !== 'online') {
      gamesBody.appendChild(el('div', { class: 'card__body' },
        el('p', { class: 'small faint', text: 'Aquí van a aparecer las partidas que otras personas dejen abiertas, con el Elo de quien la creó.' })));
      return;
    }
    if (!state.games.length) {
      gamesBody.appendChild(el('div', { class: 'card__body' },
        emptyState('Ahora mismo no hay ninguna partida abierta.',
          button('Crear la mía', { variant: 'primary', onClick: createGame }))));
      return;
    }
    for (const game of state.games) gamesBody.appendChild(openRow(game));
  }

  function openRow(game) {
    const tags = el('div', { class: 'row gap-6' },
      el('span', { class: 'chip', text: `${tcText(game.tc)} · ${tcCategory(game.tc)}` }));
    if (game.rated === false) tags.appendChild(el('span', { class: 'tiny faint', text: 'amistosa' }));
    if (game.private) tags.appendChild(el('span', { class: 'tiny faint', text: 'privada' }));

    return el('div', { class: 'lobby-row' },
      el('div', { class: 'col gap-4', style: { minWidth: '0' } },
        el('span', { class: 'strong truncate', text: playerName(game.host) }),
        el('span', { class: 'tiny faint', text: timeAgo(game.created) })),
      ratingBadge(Math.round(game.hostRating || 1200)),
      tags,
      button('Unirse', { variant: 'primary', size: 'sm', onClick: () => joinGame(game.id) }));
  }

  /* ---------------------------- en directo ----------------------------- */

  const liveBody = el('div');
  const liveCard = gated(el('section', { class: 'card card--pad-0' },
    el('div', { class: 'card__head' },
      el('h2', { class: 'card__title', text: 'Partidas en vivo' }),
      el('span', { class: 'tiny faint', text: 'para mirar' })),
    liveBody));
  leftCol.appendChild(liveCard);

  function renderLive() {
    clear(liveBody);
    if (state.conn !== 'online') {
      liveBody.appendChild(el('div', { class: 'card__body' },
        el('p', { class: 'small faint', text: 'Las partidas que se estén jugando ahora mismo se listan acá para que puedas mirarlas.' })));
      return;
    }
    if (!state.live.length) {
      liveBody.appendChild(el('div', { class: 'card__body' },
        el('p', { class: 'small faint', text: 'No hay ninguna partida en juego en este momento.' })));
      return;
    }
    for (const game of state.live) {
      const moves = game.moveNumber ? `jugada ${game.moveNumber}` : 'en juego';
      liveBody.appendChild(el('div', { class: 'lobby-row' },
        el('div', { class: 'col gap-4', style: { minWidth: '0' } },
          el('span', { class: 'truncate', text: `${playerName(game.white)} vs ${playerName(game.black)}` }),
          el('span', { class: 'tiny faint', text: moves })),
        el('span', { class: 'chip', text: tcText(game.tc) }),
        el('span', { class: 'tiny faint', text: game.rated === false ? 'amistosa' : 'puntuable' }),
        button('Ver', { size: 'sm', onClick: () => watchGame(game.id) })));
    }
  }

  /* --------------------------- crear partida --------------------------- */

  const createButton = button('Crear la partida', { variant: 'primary', onClick: createGame });
  const privateHint = el('p', { class: 'tiny faint', text: 'Una partida privada no sale en la lista: se entra con el código que te da el servidor.' });

  const createCard = gated(el('section', { class: 'card' },
    el('h2', { class: 'card__title', text: 'Crear una partida' }),
    field('Control de tiempo', select(
      CREATE_TC.map((id) => {
        const tc = tcById(id);
        return { value: id, label: `${tc.label} · ${tcCategory(tc)}` };
      }),
      {
        value: state.newTc,
        ariaLabel: 'Control de tiempo de la partida nueva',
        onChange: (event) => { state.newTc = event.target.value; },
      },
    )),
    field('Tus piezas', select([
      { value: 'w', label: 'Blancas' },
      { value: 'b', label: 'Negras' },
      { value: 'random', label: 'Al azar' },
    ], {
      value: state.newColor,
      ariaLabel: 'Color de tus piezas',
      onChange: (event) => { state.newColor = event.target.value; },
    })),
    switchControl('Partida puntuable', {
      checked: state.newRated,
      onChange: (event) => { state.newRated = !!event.target.checked; },
    }),
    switchControl('Partida privada', {
      checked: state.newPrivate,
      onChange: (event) => { state.newPrivate = !!event.target.checked; },
    }),
    privateHint,
    el('div', { class: 'row row--wrap gap-6' }, createButton)));
  rightCol.appendChild(createCard);

  /* ------------------------- unirse por código ------------------------- */

  const codeInput = el('input', {
    class: 'input',
    type: 'text',
    value: state.code,
    placeholder: 'Por ejemplo: TORRE',
    attrs: { 'aria-label': 'Código de la partida privada', maxlength: '8', autocomplete: 'off' },
    onInput: (event) => {
      state.code = event.target.value || '';
      refreshControls();
    },
    onKeydown: (event) => {
      if (event.key === 'Enter') joinByCode();
    },
  });
  const codeButton = button('Entrar', { variant: 'primary', onClick: joinByCode });

  const codeCard = gated(el('section', { class: 'card' },
    el('h2', { class: 'card__title', text: 'Unirse con un código' }),
    el('p', { class: 'small muted', text: 'Si alguien creó una partida privada, te pasa un código de cinco letras.' }),
    el('div', { class: 'row gap-6' },
      el('div', { class: 'grow' }, codeInput),
      codeButton)));
  rightCol.appendChild(codeCard);

  /* -------------------------- clasificación ---------------------------- */

  const topBody = el('div', { class: 'card__body' });
  const topCard = gated(el('section', { class: 'card card--pad-0' },
    el('div', { class: 'card__head' },
      el('h2', { class: 'card__title', text: 'Clasificación global' }),
      el('span', { class: 'tiny faint', text: 'mejores puntuaciones' })),
    topBody));
  rightCol.appendChild(topCard);

  function renderTop() {
    clear(topBody);
    if (state.conn !== 'online') {
      topBody.appendChild(el('p', { class: 'small faint', text: 'La tabla con las mejores puntuaciones se carga en cuanto haya servidor.' }));
      return;
    }
    if (!state.top.length) {
      topBody.appendChild(el('p', { class: 'small faint', text: 'Todavía no hay suficientes partidas jugadas para armar la tabla.' }));
      return;
    }

    const head = el('tr', null,
      el('th', { text: '#' }),
      el('th', { text: 'Jugador' }),
      el('th', { class: 'num', text: 'Elo' }),
      el('th', { class: 'num', text: 'Partidas' }));
    const body = el('tbody');
    const myName = state.me?.name || ctx.profile?.name || '';

    state.top.slice(0, 20).forEach((entry, index) => {
      const medal = ['🥇', '🥈', '🥉'][index] || '';
      const row = el('tr', { class: entry.name && entry.name === myName ? 'is-me' : '' },
        el('td', null, medal
          ? el('span', { class: 'rank-medal', text: medal })
          : el('span', { class: 'tiny faint', text: String(index + 1) })),
        el('td', null, el('span', { class: 'truncate', text: playerName(entry) })),
        el('td', { class: 'num mono', text: String(Math.round(entry.rating || 0)) }),
        el('td', { class: 'num tiny faint', text: String(entry.games || 0) }));
      body.appendChild(row);
    });

    topBody.appendChild(el('table', { class: 'table' }, el('thead', null, head), body));
  }

  /* ------------------------------ estado ------------------------------- */

  function renderIdentity() {
    clear(identityMeta);
    const tc = tcById(state.quickTc);
    const category = timeCategory(tc.base, tc.inc);
    const fromServer = state.me?.rating?.[category];
    const rating = Number.isFinite(fromServer)
      ? fromServer
      : (ctx.profile?.ratings?.[category]?.rating ?? 1200);
    identityMeta.appendChild(ratingBadge(Math.round(rating)));
    identityMeta.appendChild(el('span', { class: 'tiny faint', text: CATEGORY_NAMES[category] || '' }));
  }

  /**
   * Las tres caras del aviso. Sin esto la pantalla parpadeaba en cada reintento
   * automatico: volvia a «Buscando el servidor…» y escondia la casilla donde se
   * escribe la direccion, justo mientras la estabas usando. Una vez que ha
   * fallado, la cara ya no cambia: el reintento se ve en la pildora de estado.
   */
  function bannerFace() {
    if (state.conn === 'online') return 'ok';
    return state.everFailed ? 'caido' : 'buscando';
  }

  function renderBanner() {
    const cara = bannerFace();
    clear(bannerIcon);
    if (cara === 'buscando') {
      bannerIcon.appendChild(spinner(22));
      bannerTitle.textContent = 'Buscando el servidor de partidas…';
      bannerDesc.textContent = 'Un momento, estamos intentando entrar en la sala.';
    } else {
      bannerIcon.appendChild(el('span', { style: { fontSize: '26px' }, text: '🔌', attrs: { 'aria-hidden': 'true' } }));
      bannerTitle.textContent = 'No hay servidor de partidas ahora mismo';
      bannerDesc.textContent = 'No podemos ponerte con otras personas porque la sala de juego no está disponible. '
        + 'No es cosa de tu conexión ni de tu navegador: no hay nadie al otro lado atendiendo.';
    }
    banner.classList.toggle('hidden', cara === 'ok');
    retryRow.classList.toggle('hidden', cara !== 'caido');
    offlineExtras.classList.toggle('hidden', cara !== 'caido');
    renderRetryLine();
  }

  /* Un solo renglon quieto. La cuenta atras segundo a segundo no servia para
     nada y encima obligaba a repintar la pantalla cada segundo. */
  function renderRetryLine() {
    const probando = state.conn === 'connecting';
    retryButton.disabled = probando;
    if (retryLabel) retryLabel.textContent = probando ? 'Probando…' : 'Reintentar ahora';

    if (bannerFace() !== 'caido') { retryLine.textContent = ''; return; }
    if (!online) retryLine.textContent = 'Probá otra vez cuando el servidor esté en marcha.';
    else if (probando) retryLine.textContent = 'Probando otra vez…';
    else if (state.gaveUp) retryLine.textContent = 'Dejamos de insistir para no dar la lata. Tocá «Reintentar ahora» cuando el servidor esté listo.';
    else retryLine.textContent = 'Lo seguimos intentando en segundo plano un rato más.';
  }

  /**
   * Cuanta compañia hay. El recuento se cuenta a si mismo, asi que «1» quiere
   * decir que estas solo: mejor decirlo que dejar a alguien esperando rival en
   * una sala vacia.
   */
  function renderCompany() {
    if (state.conn !== 'online') { quickNote.textContent = ''; soloBox.classList.add('hidden'); return; }
    const otros = Math.max(0, state.players - 1);
    quickNote.textContent = otros === 0
      ? 'Ahora mismo no hay nadie más conectado.'
      : otros === 1 ? 'Hay 1 persona más conectada.' : `Hay ${otros} personas más conectadas.`;

    const enCola = Math.max(0, state.queue - (state.searching ? 1 : 0));
    const solo = state.searching && otros === 0 && enCola === 0;
    soloBox.classList.toggle('hidden', !solo);
    if (solo) {
      soloNota.textContent = 'No hay nadie más buscando rival. Podés dejar la búsqueda puesta '
        + 'por si alguien entra, o jugar mientras tanto contra un bot de tu nivel.';
    }
  }

  function renderConn() {
    const labels = {
      online: ['is-on', 'Conectado'],
      connecting: ['is-wait', state.everFailed ? 'Reintentando…' : 'Conectando…'],
      offline: ['is-off', state.gaveUp ? 'Sin servidor' : 'Sin conexión'],
    };
    const [cls, label] = labels[state.conn] || labels.offline;
    dot.className = `conn-dot ${cls}`;
    connText.textContent = state.conn === 'online' && state.latency !== null
      ? `${label} · ${state.latency} ms`
      : label;
  }

  /** Nothing in the lobby may look clickable while there is no connection. */
  function refreshControls() {
    const live = state.conn === 'online';
    for (const section of gatedSections) {
      for (const control of section.querySelectorAll('button, input, select, textarea')) {
        control.disabled = !live;
      }
      section.setAttribute('aria-disabled', String(!live));
    }
    lobbyNote.classList.toggle('hidden', live);

    quickButton.disabled = !live || state.searching;
    cancelButton.disabled = !live || !state.searching;
    codeButton.disabled = !live || state.code.trim().length < 3;
    searchingBox.classList.toggle('hidden', !state.searching);
  }

  function renderAll() {
    renderConn();
    renderBanner();
    renderCompany();
    renderGames();
    renderLive();
    renderTop();
    refreshControls();
  }

  function setConn(next, { latency, gaveUp } = {}) {
    const antes = bannerFace();
    state.conn = next;
    if (latency !== undefined) state.latency = latency;
    if (gaveUp !== undefined) state.gaveUp = !!gaveUp;
    if (next === 'offline') state.everFailed = true;
    if (next === 'online') { state.everFailed = false; state.gaveUp = false; }
    if (next !== 'connecting') stopTimer('connect');

    /* Repintar entero solo cuando de verdad cambia lo que se ve. */
    if (antes !== bannerFace()) renderAll();
    else { renderConn(); renderRetryLine(); refreshControls(); }
  }

  /* ------------------------------ acciones ----------------------------- */

  function requestData() {
    if (state.conn !== 'online' || !online) return;
    try {
      online.lobby?.();
      online.leaderboard?.();
    } catch {
      /* the client queues or drops on its own; nothing to do here */
    }
  }

  function retry(manual) {
    if (!online || typeof online.connect !== 'function') {
      setConn('offline');
      return;
    }
    if (manual) ctx.sound?.play?.('click');
    setConn('connecting');
    startConnectTimer();
    try {
      online.connect(ctx.profile?.name || 'Invitado', online.getToken?.() || null);
    } catch {
      setConn('offline');
    }
  }

  function startQuick() {
    if (state.conn !== 'online' || state.searching) return;
    const tc = tcById(state.quickTc);
    state.searching = true;
    state.searchStartedAt = Date.now();
    try {
      online.quick?.({ base: tc.base, inc: tc.inc }, state.quickRated);
    } catch {
      state.searching = false;
    }
    ctx.sound?.play?.('click');
    startSearchTimer();
    refreshControls();
    renderCompany();
  }

  function stopSearch(notify) {
    if (!state.searching) return;
    state.searching = false;
    stopTimer('search');
    if (notify) {
      try { online?.cancelQuick?.(); } catch { /* ignore */ }
      ctx.toast?.('Búsqueda cancelada.', '');
    }
    searchingText.textContent = 'Buscando rival de tu nivel…';
    refreshControls();
  }

  function createGame() {
    if (state.conn !== 'online') return;
    const tc = tcById(state.newTc);
    try {
      online.create?.({
        tc: { base: tc.base, inc: tc.inc },
        rated: state.newRated,
        color: state.newColor,
        private: state.newPrivate,
      });
    } catch {
      ctx.toast?.('No se pudo crear la partida.', 'err');
      return;
    }
    ctx.sound?.play?.('click');
    ctx.toast?.(state.newPrivate
      ? 'Partida privada creada. El servidor te dará el código para compartir.'
      : 'Partida creada. Queda en la lista hasta que alguien se una.', '');
  }

  function joinGame(id) {
    if (state.conn !== 'online' || !id) return;
    try { online.join?.(id); } catch { /* ignore */ }
    ctx.toast?.('Entrando en la partida…', '');
  }

  function joinByCode() {
    if (state.conn !== 'online') return;
    const code = state.code.trim().toUpperCase();
    if (code.length < 3) {
      ctx.toast?.('Escribí el código que te pasaron.', 'warn');
      return;
    }
    joinGame(code);
  }

  function watchGame(id) {
    if (state.conn !== 'online' || !id) return;
    try { online.watch?.(id); } catch { /* ignore */ }
    ctx.navigate(`#/jugar/online/${id}`);
  }

  function enterGame(msg) {
    const id = msg?.game?.id || msg?.gameId;
    if (!id) return;
    stopSearch(false);
    ctx.sound?.play?.('gameStart');
    ctx.navigate(`#/jugar/online/${id}`);
  }

  /* ------------------------------- timers ------------------------------ */

  function stopTimer(which) {
    if (which === 'connect' && connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
    if (which === 'search' && searchTimer) { clearInterval(searchTimer); searchTimer = null; }
    if (which === 'refresh' && refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
  }

  function startConnectTimer() {
    stopTimer('connect');
    connectTimer = setTimeout(() => {
      connectTimer = null;
      if (alive && state.conn !== 'online') setConn('offline');
    }, CONNECT_TIMEOUT_MS);
  }

  function startSearchTimer() {
    stopTimer('search');
    searchTimer = setInterval(() => {
      if (!alive || !state.searching) return;
      const secs = Math.round((Date.now() - state.searchStartedAt) / 1000);
      searchingText.textContent = `Buscando rival de tu nivel… ${secs} s`;
      /* A los 20 s ya no es un parpadeo: si sigue sin haber nadie, se dice. */
      if (secs === 20) renderCompany();
    }, 1000);
  }

  function startRefresh() {
    stopTimer('refresh');
    refreshTimer = setInterval(() => {
      if (alive && state.conn === 'online') requestData();
    }, LOBBY_REFRESH_MS);
  }

  /* ------------------------- eventos del cliente ----------------------- */

  function handleConnection(msg) {
    if (msg.state === 'open') {
      setConn('online', { latency: msg.latency === undefined ? state.latency : msg.latency });
      requestData();
      startRefresh();
      return;
    }
    if (msg.state === 'connecting') {
      setConn('connecting', { latency: null });
      return;
    }
    /* 'closed' (reconnecting on its own) or 'idle' (we hung up). */
    stopSearch(false);
    stopTimer('refresh');
    setConn('offline', { latency: null, gaveUp: !!msg.gaveUp });
  }

  function onMessage(msg) {
    if (!alive || !msg || typeof msg !== 'object') return;
    switch (msg.t) {
      case 'connection':
        handleConnection(msg);
        break;
      case 'welcome':
        state.me = msg.you || null;
        renderIdentity();
        requestData();
        break;
      case 'lobby': {
        if (Number.isFinite(msg.players)) state.players = msg.players;
        if (Number.isFinite(msg.searching)) state.queue = msg.searching;
        renderCompany();
        state.live = liveFrom(msg);
        const all = Array.isArray(msg.games) ? msg.games : [];
        state.games = all.filter((game) => !state.live.includes(game));
        renderGames();
        renderLive();
        refreshControls();
        break;
      }
      case 'leaderboard':
        state.top = Array.isArray(msg.top) ? msg.top : [];
        renderTop();
        refreshControls();
        break;
      case 'gameStart':
        if (msg.resume) showResume(msg.game);
        else enterGame(msg);
        break;
      case 'error':
        stopSearch(false);
        ctx.toast?.(ONLINE_ERRORS[msg.code] || msg.message || 'El servidor devolvió un error.', 'err');
        break;
      default:
        break;
    }
  }

  /**
   * The client only reports through the callback app.js handed it when it was
   * created, so the clean way in is ctx.onOnlineEvent(). If this build does not
   * expose it we fall back to watching the connection flag, which is enough to
   * tell the lobby apart from the offline screen.
   */
  function subscribe(handler) {
    if (typeof ctx.onOnlineEvent === 'function') {
      const off = ctx.onOnlineEvent(handler);
      return typeof off === 'function' ? off : () => {};
    }
    const deadline = Date.now() + CONNECT_TIMEOUT_MS;
    const poll = setInterval(() => {
      if (!alive) return;
      if (online?.isConnected?.()) handler({ t: 'connection', state: 'open' });
      else if (Date.now() >= deadline) handler({ t: 'connection', state: 'closed' });
    }, FALLBACK_POLL_MS);
    return () => clearInterval(poll);
  }

  /* ------------------------------- arranque ---------------------------- */

  renderQuickChips();
  renderServerHint();
  renderIdentity();
  renderAll();

  if (!online || typeof online.connect !== 'function') {
    setConn('offline');
  } else {
    unsubscribe = subscribe(onMessage);
    if (online.isConnected?.()) {
      setConn('online');
      requestData();
      startRefresh();
    } else {
      retry(false);
    }
  }

  return {
    unmount() {
      alive = false;
      try { unsubscribe(); } catch { /* ignore */ }
      stopTimer('connect');
      stopTimer('search');
      stopTimer('refresh');
      if (state.searching) {
        state.searching = false;
        try { online?.cancelQuick?.(); } catch { /* ignore */ }
      }
      /* A live link belongs to the game screen too, so it is left alone; a dead
         one is hung up so the client stops retrying behind our back. */
      if (online && !online.isConnected?.()) {
        try { online.disconnect?.(); } catch { /* ignore */ }
      }
      clear(root);
    },
  };
}
