/**
 * ui/tournaments.js — tournament list, creation form and the running board:
 * standings with every tiebreak, this round's pairings, your own playable game
 * and the bot-versus-bot games, which are simulated here with visible progress.
 * The bracket logic all lives in tournament.js; this screen only drives it.
 */

import {
  el, clear, button, card, field, select, chip, spinner, emptyState,
  botAvatarNode, deltaSpan, resultBadge, confirmDialog, formatDate,
} from './components.js';
import {
  createTournament, nextRound, reportResult, standings, isFinished,
  pendingGames, tournamentSummary, serialize, deserialize, tournamentPlayer, FORMATS,
} from '../tournament.js';
import { loadTournaments, saveTournament, getTournament, deleteTournament } from '../storage.js';
import { BOTS, botById } from '../bots.js';
import { TIME_CONTROLS } from '../clock.js';
import { ratingTier } from '../elo.js';
import * as C from '../chess.js';

const FORMAT_NAMES = {
  swiss: 'Suizo',
  roundrobin: 'Liga (todos contra todos)',
  knockout: 'Eliminatoria',
  arena: 'Arena',
};

const FORMAT_HINTS = {
  swiss: 'Cada ronda te empareja con alguien que lleva tus mismos puntos. Pocas rondas, mucha gente.',
  roundrobin: 'Todos juegan contra todos. Es el más justo y el más largo.',
  knockout: 'El que pierde se va a casa. Las tablas se deciden con una partida de desempate.',
  arena: 'Emparejamientos continuos por puntuación; gana quien más suma en las rondas fijadas.',
};

const HUMAN_ID = 'yo';
const TOURNAMENT_TC = ['3+2', '5+0', '5+3', '10+0', '10+5', '15+10'];

function tcById(id) {
  return TIME_CONTROLS.find((tc) => tc.id === id) || TIME_CONTROLS.find((tc) => tc.id === '5+3');
}

export function mount(root, ctx, params = {}) {
  let destroyed = false;
  let simulating = false;

  clear(root);
  const screen = el('div', { class: 'screen' });
  root.appendChild(screen);

  /* ------------------------------- listado ------------------------------ */

  function renderList() {
    clear(screen);
    screen.appendChild(el('div', { class: 'screen__head' },
      el('div', { class: 'col' },
        el('h1', { class: 'h1', text: 'Torneos' }),
        el('p', { class: 'muted', text: 'Armá un cuadro con los bots que quieras y jugá tus partidas ronda a ronda.' }))));

    const saved = loadTournaments();
    const section = el('section', { class: 'card' });
    section.appendChild(el('h2', { class: 'card__title', text: 'Tus torneos' }));

    if (!saved.length) {
      section.appendChild(emptyState('Todavía no has creado ningún torneo.'));
    } else {
      for (const raw of saved) {
        let t;
        try {
          t = deserialize(raw);
        } catch {
          continue;
        }
        const done = isFinished(t);
        const row = el('div', { class: 'lobby-row' },
          el('div', { class: 'col grow' },
            el('span', { class: 'strong', text: t.name }),
            el('span', {
              class: 'tiny faint',
              text: `${FORMAT_NAMES[t.format]} · ${t.players.length} jugadores · ronda ${t.round} de ${t.rounds}`,
            })),
          el('span', { class: 'chip', text: done ? 'Terminado' : 'En curso' }),
          button(done ? 'Ver resultado' : 'Continuar', {
            size: 'sm', variant: done ? '' : 'primary',
            onClick: () => ctx.navigate(`#/torneo/${t.id}`),
          }),
          button('Borrar', {
            size: 'sm', variant: 'ghost', title: 'Borrar el torneo',
            onClick: async () => {
              const ok = await confirmDialog({
                title: '¿Borrar el torneo?',
                message: `Se perderá «${t.name}» y su clasificación.`,
                confirmLabel: 'Borrar',
                danger: true,
              });
              if (!ok) return;
              deleteTournament(t.id);
              renderList();
            },
          }));
        section.appendChild(row);
      }
    }
    screen.appendChild(section);
    screen.appendChild(renderCreate());
  }

  /* --------------------------- crear un torneo -------------------------- */

  function renderCreate() {
    const state = {
      name: 'Mi torneo',
      format: 'swiss',
      rounds: 5,
      tc: '5+3',
      pick: 'range',
      count: 8,
      minElo: 800,
      maxElo: 1800,
      chosen: new Set(),
      includeMe: true,
    };

    const section = el('section', { class: 'card' });
    section.appendChild(el('h2', { class: 'card__title', text: 'Crear un torneo' }));

    const body = el('div', { class: 'col gap-16' });
    section.appendChild(body);

    const nameInput = el('input', {
      class: 'input', type: 'text', value: state.name,
      attrs: { maxlength: '40', 'aria-label': 'Nombre del torneo' },
      onInput: (e) => { state.name = e.target.value; },
    });
    body.appendChild(field('Nombre', nameInput));

    const hint = el('p', { class: 'tiny faint', text: FORMAT_HINTS[state.format] });
    body.appendChild(field('Formato', select(
      FORMATS.map((f) => ({ value: f, label: FORMAT_NAMES[f] })),
      {
        value: state.format,
        ariaLabel: 'Formato del torneo',
        onChange: (e) => {
          state.format = e.target.value;
          hint.textContent = FORMAT_HINTS[state.format];
          roundsField.hidden = state.format === 'roundrobin' || state.format === 'knockout';
        },
      },
    )));
    body.appendChild(hint);

    const roundsInput = el('input', {
      class: 'input', type: 'number', value: String(state.rounds),
      attrs: { min: '1', max: '15', 'aria-label': 'Número de rondas' },
      onInput: (e) => { state.rounds = Math.max(1, Math.min(15, Number(e.target.value) || 1)); },
    });
    const roundsField = field('Rondas', roundsInput, 'En liga y eliminatoria se calculan solas.');
    body.appendChild(roundsField);

    body.appendChild(field('Control de tiempo', select(
      TOURNAMENT_TC.map((id) => ({ value: id, label: tcById(id).label })),
      { value: state.tc, ariaLabel: 'Control de tiempo', onChange: (e) => { state.tc = e.target.value; } },
    )));

    /* Seleccion del cuadro */
    body.appendChild(el('h3', { class: 'h3', text: 'El cuadro' }));
    const pickRow = el('div', { class: 'row gap-6' });
    const picks = [
      ['range', 'Por tramo de Elo'],
      ['random', 'Al azar'],
      ['manual', 'A dedo'],
    ];
    for (const [key, label] of picks) {
      pickRow.appendChild(chip(label, {
        active: state.pick === key,
        onClick: () => { state.pick = key; renderPick(); },
      }));
    }
    body.appendChild(pickRow);

    const pickBody = el('div', { class: 'col gap-6' });
    body.appendChild(pickBody);

    function renderPick() {
      clear(pickBody);
      for (const node of pickRow.childNodes) node.classList.remove('is-active');
      const index = picks.findIndex(([k]) => k === state.pick);
      if (pickRow.childNodes[index]) pickRow.childNodes[index].classList.add('is-active');

      if (state.pick === 'manual') {
        const grid = el('div', { class: 'bot-grid' });
        for (const bot of [...BOTS].sort((a, b) => a.elo - b.elo)) {
          const on = state.chosen.has(bot.id);
          grid.appendChild(chip(`${bot.name} (${bot.elo})`, {
            active: on,
            onClick: () => {
              if (state.chosen.has(bot.id)) state.chosen.delete(bot.id);
              else state.chosen.add(bot.id);
              renderPick();
            },
          }));
        }
        pickBody.appendChild(grid);
        pickBody.appendChild(el('p', { class: 'tiny faint', text: `${state.chosen.size} elegidos.` }));
        return;
      }

      const countInput = el('input', {
        class: 'input', type: 'number', value: String(state.count),
        attrs: { min: '2', max: '16', 'aria-label': 'Cuántos bots' },
        onInput: (e) => { state.count = Math.max(2, Math.min(16, Number(e.target.value) || 2)); },
      });
      pickBody.appendChild(field('Cuántos bots', countInput));

      if (state.pick === 'range') {
        const minInput = el('input', {
          class: 'input', type: 'number', value: String(state.minElo),
          attrs: { min: '250', max: '2900', 'aria-label': 'Elo mínimo' },
          onInput: (e) => { state.minElo = Number(e.target.value) || 250; },
        });
        const maxInput = el('input', {
          class: 'input', type: 'number', value: String(state.maxElo),
          attrs: { min: '250', max: '2900', 'aria-label': 'Elo máximo' },
          onInput: (e) => { state.maxElo = Number(e.target.value) || 2900; },
        });
        pickBody.appendChild(el('div', { class: 'row gap-16' },
          field('Elo mínimo', minInput), field('Elo máximo', maxInput)));
      }
    }
    renderPick();

    const meSwitch = el('label', { class: 'switch' },
      el('input', {
        type: 'checkbox', checked: state.includeMe,
        onChange: (e) => { state.includeMe = !!e.target.checked; },
      }),
      el('span', { class: 'switch__track' }),
      el('span', { text: 'Juego yo también' }));
    body.appendChild(meSwitch);

    body.appendChild(button('Crear el torneo', {
      variant: 'primary', size: 'lg',
      onClick: () => create(state),
    }));

    return section;
  }

  function pickBots(state) {
    if (state.pick === 'manual') {
      return [...state.chosen].map((id) => botById(id)).filter(Boolean);
    }
    let pool = [...BOTS];
    if (state.pick === 'range') {
      const min = Math.min(state.minElo, state.maxElo);
      const max = Math.max(state.minElo, state.maxElo);
      pool = pool.filter((b) => b.elo >= min && b.elo <= max);
    }
    if (state.pick === 'random') {
      pool = pool.slice();
      for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
      }
    } else {
      pool.sort((a, b) => a.elo - b.elo);
    }
    return pool.slice(0, state.count);
  }

  function create(state) {
    const bots = pickBots(state);
    const players = bots.map((b) => ({ id: b.id, name: b.name, elo: b.elo, isHuman: false, botId: b.id }));
    if (state.includeMe) {
      const rating = ctx.profile?.ratings?.bots?.rating || 800;
      players.unshift({ id: HUMAN_ID, name: ctx.profile?.name || 'Invitado', elo: Math.round(rating), isHuman: true, botId: null, gamesPlayed: 0 });
    }
    if (players.length < 2) {
      ctx.toast?.('Hacen falta al menos dos participantes.', 'warn');
      return;
    }

    const tc = tcById(state.tc);
    try {
      const t = createTournament({
        id: 't' + Date.now().toString(36),
        name: state.name.trim() || 'Torneo',
        format: state.format,
        rounds: state.rounds,
        players,
        timeControl: { base: tc.base, inc: tc.inc },
        seed: (Date.now() >>> 0) || 1,
      });
      saveTournament(serialize(t));
      ctx.navigate(`#/torneo/${t.id}`);
    } catch (err) {
      ctx.toast?.('No pude crear el torneo: ' + (err?.message || err), 'err');
    }
  }

  /* ------------------------------- detalle ------------------------------ */

  function loadDetail(id) {
    const raw = getTournament(id);
    if (!raw) return null;
    try {
      return deserialize(raw);
    } catch {
      return null;
    }
  }

  function save(t) {
    saveTournament(serialize(t));
  }

  function renderDetail(id) {
    const t = loadDetail(id);
    if (!t) {
      clear(screen);
      screen.appendChild(emptyState('Ese torneo ya no existe.',
        button('Ver torneos', { variant: 'primary', onClick: () => ctx.navigate('#/torneos') })));
      return;
    }

    clear(screen);
    const done = isFinished(t);
    const pending = pendingGames(t);

    screen.appendChild(el('div', { class: 'screen__head' },
      el('div', { class: 'col grow' },
        el('h1', { class: 'h1', text: t.name }),
        el('p', {
          class: 'muted',
          text: `${FORMAT_NAMES[t.format]} · ${t.players.length} jugadores · ${done ? 'terminado' : `ronda ${Math.max(1, t.round)} de ${t.rounds}`}`,
        })),
      button('Volver', { variant: 'ghost', onClick: () => ctx.navigate('#/torneos') })));

    if (done) screen.appendChild(renderPodium(t));

    screen.appendChild(renderActions(t, pending, done));
    screen.appendChild(renderPairings(t));
    screen.appendChild(renderStandings(t));
  }

  function renderActions(t, pending, done) {
    const section = el('section', { class: 'card' });
    const row = el('div', { class: 'row gap-6' });
    section.appendChild(row);
    const info = el('p', { class: 'small muted' });
    section.appendChild(info);

    if (done) {
      info.textContent = 'El torneo ha terminado.';
      return section;
    }

    if (t.round === 0) {
      row.appendChild(button('Empezar el torneo', {
        variant: 'primary',
        onClick: () => advance(t),
      }));
      info.textContent = 'Se sortearán los emparejamientos de la primera ronda.';
      return section;
    }

    const mine = pending.find((g) => isHumanGame(t, g));
    const botGames = pending.filter((g) => !isHumanGame(t, g));

    if (mine) {
      row.appendChild(button('Jugar mi partida', {
        variant: 'primary',
        onClick: () => ctx.navigate(`#/jugar/torneo/${t.id}/${mine.id}`),
      }));
    }
    if (botGames.length) {
      row.appendChild(button(`Simular ${botGames.length} partida${botGames.length === 1 ? '' : 's'} de bots`, {
        onClick: () => simulate(t, botGames, info),
        disabled: simulating,
      }));
    }
    if (!pending.length) {
      row.appendChild(button('Siguiente ronda', { variant: 'primary', onClick: () => advance(t) }));
      info.textContent = 'Ronda completa.';
    } else if (!mine && !botGames.length) {
      info.textContent = 'Esperando resultados.';
    } else {
      info.textContent = `${pending.length} partida${pending.length === 1 ? '' : 's'} sin jugar en esta ronda.`;
    }
    return section;
  }

  function isHumanGame(t, game) {
    const white = tournamentPlayer(t, game.white);
    const black = game.black ? tournamentPlayer(t, game.black) : null;
    return !!(white?.isHuman || black?.isHuman);
  }

  function advance(t) {
    try {
      nextRound(t);
      save(t);
      renderDetail(t.id);
    } catch (err) {
      ctx.toast?.(err?.message || String(err), 'warn');
    }
  }

  /* ------------------- simulacion de partidas entre bots ------------------ */

  async function simulate(t, games, info) {
    if (simulating) return;
    simulating = true;
    let played = 0;
    const bar = el('div', { class: 'row gap-6' }, spinner(16),
      el('span', { class: 'small', text: `Jugando ${games.length} partidas…` }));
    clear(info);
    info.appendChild(bar);

    try {
      for (const game of games) {
        if (destroyed) return;
        const result = await playBotGame(t, game);
        if (destroyed) return;
        const fresh = loadDetail(t.id);
        if (!fresh) return;
        try {
          reportResult(fresh, game.id, result);
          save(fresh);
        } catch {
          /* ya lo habia anotado otra pasada */
        }
        played++;
        bar.lastChild.textContent = `Jugando… ${played} de ${games.length}`;
      }
    } finally {
      simulating = false;
    }
    if (!destroyed) renderDetail(t.id);
  }

  /** Plays a full bot-versus-bot game headlessly and returns its PGN result. */
  async function playBotGame(t, game) {
    const whiteBot = tournamentPlayer(t, game.white)?.botId;
    const blackBot = game.black ? tournamentPlayer(t, game.black)?.botId : null;
    if (!whiteBot || !blackBot) return '1-0';

    const pos = C.createPosition();
    const history = [];
    const seed = (t.seed + game.round * 131 + game.id.length) >>> 0;

    for (let ply = 0; ply < 300; ply++) {
      if (destroyed) return '1/2-1/2';
      const status = C.gameResult(pos);
      if (status.over) {
        if (status.winner === null) return '1/2-1/2';
        return status.winner === C.WHITE ? '1-0' : '0-1';
      }
      const botId = pos.turn === C.WHITE ? whiteBot : blackBot;
      let res;
      try {
        res = await ctx.ai.botMove({
          fen: C.getFen(pos),
          botId,
          history: history.slice(),
          moveNumber: pos.fullmove,
          seed: (seed + ply) >>> 0,
          timeBudgetMs: 90,
        });
      } catch {
        return '1/2-1/2';
      }
      const move = res && res.uci ? C.uciToMove(pos, res.uci) : -1;
      if (move === -1) return '1/2-1/2';
      history.push(res.uci);
      C.makeMove(pos, move);
      /* Un respiro para que la interfaz siga respondiendo. */
      if (ply % 8 === 0) await new Promise((r) => setTimeout(r, 0));
    }
    return '1/2-1/2';
  }

  /* ------------------------- emparejamientos y tabla ---------------------- */

  function renderPairings(t) {
    const section = el('section', { class: 'card' });
    section.appendChild(el('h2', { class: 'card__title', text: `Emparejamientos · ronda ${Math.max(1, t.round)}` }));
    const games = t.games.filter((g) => g.round === t.round);
    if (!games.length) {
      section.appendChild(emptyState('Todavía no hay emparejamientos.'));
      return section;
    }
    for (const game of games) {
      const white = tournamentPlayer(t, game.white);
      const black = game.black ? tournamentPlayer(t, game.black) : null;
      /* Un descanso no es una partida: el motor lo marca con result 'bye', y
         pintarlo como resultado dejaba en pantalla «Fulano bye descansa». */
      const descansa = !black || game.result === 'bye';
      const row = el('div', { class: `pairing${isHumanGame(t, game) ? ' is-yours' : ''}` },
        el('span', { class: 'grow truncate', text: white ? white.name : '—' }),
        descansa
          ? el('span', { class: 'muted small grow', text: 'descansa esta ronda' })
          : el('span', { class: 'mono', text: game.result === null ? 'vs' : game.result }),
        descansa
          ? null
          : el('span', { class: 'grow truncate', text: black ? black.name : '—' }));
      if (game.result === null && isHumanGame(t, game)) {
        row.appendChild(button('Jugar', {
          size: 'sm', variant: 'primary',
          onClick: () => ctx.navigate(`#/jugar/torneo/${t.id}/${game.id}`),
        }));
      }
      section.appendChild(row);
    }
    return section;
  }

  function renderStandings(t) {
    const section = el('section', { class: 'card' });
    section.appendChild(el('h2', { class: 'card__title', text: 'Clasificación' }));

    const table = el('table', { class: 'table' });
    const head = el('tr');
    for (const label of ['#', 'Jugador', 'Pts', 'PJ', 'G', 'T', 'P', 'Buchholz', 'S-B', 'Rend.', 'Δ']) {
      head.appendChild(el('th', { text: label }));
    }
    table.appendChild(el('thead', null, head));

    const body = el('tbody');
    for (const row of standings(t)) {
      const player = tournamentPlayer(t, row.playerId);
      const tr = el('tr', { class: player?.isHuman ? 'is-me' : '' });
      tr.appendChild(el('td', { class: 'num', text: String(row.rank) }));
      tr.appendChild(el('td', null, el('span', { class: 'truncate', text: row.name })));
      tr.appendChild(el('td', { class: 'num strong', text: String(row.points) }));
      tr.appendChild(el('td', { class: 'num', text: String(row.played) }));
      tr.appendChild(el('td', { class: 'num', text: String(row.wins) }));
      tr.appendChild(el('td', { class: 'num', text: String(row.draws) }));
      tr.appendChild(el('td', { class: 'num', text: String(row.losses) }));
      tr.appendChild(el('td', { class: 'num', text: String(row.buchholzCut ?? row.buchholz ?? 0) }));
      tr.appendChild(el('td', { class: 'num', text: String(row.sonnebornBerger ?? 0) }));
      tr.appendChild(el('td', { class: 'num', text: String(Math.round(row.performance || 0)) }));
      tr.appendChild(el('td', { class: 'num' }, deltaSpan(Math.round(row.ratingChange || 0))));
      body.appendChild(tr);
    }
    table.appendChild(body);
    section.appendChild(table);
    return section;
  }

  function renderPodium(t) {
    const section = el('section', { class: 'card' });
    section.appendChild(el('h2', { class: 'card__title', text: 'Podio' }));
    let summary;
    try {
      summary = tournamentSummary(t);
    } catch {
      return section;
    }
    const grid = el('div', { class: 'trophy-grid' });
    const medals = ['🥇', '🥈', '🥉'];
    (summary.podium || []).forEach((entry, i) => {
      const player = tournamentPlayer(t, entry.playerId);
      const bot = player?.botId ? botById(player.botId) : null;
      const item = el('div', { class: 'trophy' },
        el('span', { class: 'h2', text: medals[i] || '🏅' }),
        bot ? botAvatarNode(bot, 56) : el('span', { text: '🧑' }),
        el('span', { class: 'strong truncate', text: entry.name || player?.name || '—' }),
        el('span', { class: 'tiny faint', text: `${entry.points} puntos` }));
      grid.appendChild(item);
    });
    section.appendChild(grid);
    return section;
  }

  /* ------------------------------- arranque ------------------------------ */

  if (params.tournamentId) renderDetail(params.tournamentId);
  else renderList();

  return {
    unmount() {
      destroyed = true;
      /* ctx.ai es perezoso: pedirlo para pararlo arrancaba los workers justo
         al salir de la pantalla. */
      if (ctx.hasAi?.()) { try { ctx.ai.stop(); } catch { /* ya estaba parado */ } }
      clear(root);
    },
  };
}
