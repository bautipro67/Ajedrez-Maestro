/**
 * app.js — boot, shared context and hash router. Screens live in ui/ and are
 * imported on demand; each exports mount(root, ctx, params) and returns an
 * object with unmount().
 */

import * as storage from './storage.js';
import * as sound from './sound.js';
import { createAI } from './ai.js';
import { createOnline } from './online.js';
import { setLiveElo } from './bots.js';
import { fetchGithubElo, cachedGithubElo } from './github.js';
import { ratingTier } from './elo.js';
import { userAvatarSvg } from './pieces.js';
import { el, clear, toast, modal, confirmDialog, achievementToast } from './ui/components.js';
import { achievementById } from './achievements.js';

const ROUTES = [
  { test: /^#?\/?$/, load: () => import('./ui/home.js'), params: () => ({}), nav: '#/' },
  { test: /^#\/bots\/?$/, load: () => import('./ui/botpicker.js'), params: () => ({}), nav: '#/bots' },
  {
    test: /^#\/jugar\/bot\/([\w-]+)(?:\?(.*))?$/,
    load: () => import('./ui/gamescreen.js'),
    params: (m) => ({ mode: 'bot', botId: m[1], query: parseQuery(m[2]) }),
    nav: '#/bots',
  },
  {
    test: /^#\/jugar\/local(?:\?(.*))?$/,
    load: () => import('./ui/gamescreen.js'),
    params: (m) => ({ mode: 'local', query: parseQuery(m[1]) }),
    nav: '#/jugar/local',
  },
  {
    test: /^#\/jugar\/online\/([\w-]+)$/,
    load: () => import('./ui/gamescreen.js'),
    params: (m) => ({ mode: 'online', gameId: m[1] }),
    nav: '#/online',
  },
  {
    test: /^#\/jugar\/torneo\/([\w-]+)\/([\w-]+)$/,
    load: () => import('./ui/gamescreen.js'),
    params: (m) => ({ mode: 'tournament', tournamentId: m[1], gameId: m[2] }),
    nav: '#/torneos',
  },
  { test: /^#\/online\/?$/, load: () => import('./ui/online.js'), params: () => ({}), nav: '#/online' },
  { test: /^#\/torneos\/?$/, load: () => import('./ui/tournaments.js'), params: () => ({}), nav: '#/torneos' },
  {
    test: /^#\/entrenamiento(?:\/(propias))?\/?$/,
    load: () => import('./ui/puzzles.js'),
    params: (m) => ({ source: m[1] || 'juego' }),
    nav: '#/entrenamiento',
  },
  {
    test: /^#\/torneo\/([\w-]+)$/,
    load: () => import('./ui/tournaments.js'),
    params: (m) => ({ tournamentId: m[1] }),
    nav: '#/torneos',
  },
  { test: /^#\/perfil\/?$/, load: () => import('./ui/profile.js'), params: () => ({}), nav: '#/perfil' },
  { test: /^#\/ajustes\/?$/, load: () => import('./ui/settings.js'), params: () => ({}), nav: '#/ajustes' },
  {
    test: /^#\/analisis(?:\/(.*))?$/,
    load: () => import('./ui/analysis.js'),
    params: (m) => ({ gameId: m[1] || null }),
    nav: '#/analisis',
  },
];

function parseQuery(raw) {
  const out = {};
  if (!raw) return out;
  for (const pair of String(raw).split('&')) {
    if (!pair) continue;
    const [key, value = ''] = pair.split('=');
    out[decodeURIComponent(key)] = decodeURIComponent(value);
  }
  return out;
}

/* ------------------------------- context -------------------------------- */

const root = document.getElementById('app-root');
const state = {
  profile: storage.loadProfile(),
  settings: storage.loadSettings(),
  ai: null,
  online: null,
  current: null,
};

sound.initSound(state.settings);

const ctx = {
  get profile() { return state.profile; },
  get settings() { return state.settings; },

  storage,
  sound,

  /** Lazily created so a user who never plays a bot never spawns a worker. */
  get ai() {
    if (!state.ai) {
      const cores = typeof navigator !== 'undefined' && navigator.hardwareConcurrency
        ? navigator.hardwareConcurrency : 2;
      state.ai = createAI({ workers: Math.max(1, Math.min(3, cores - 1)) });
    }
    return state.ai;
  },

  /** Lazily created so the app works fine with the server offline. */
  get online() {
    if (!state.online) {
      state.online = createOnline({
        url: (state.settings && state.settings.serverUrl) || undefined,
        token: (state.settings && state.settings.onlineToken) || null,
        name: state.profile?.name || null,
        onEvent: (msg) => {
          /* El pase que da el servidor se guarda: es lo que te devuelve a tu
             misma identidad —y a tu partida— cuando recargas la pagina. */
          if (msg && msg.t === 'welcome' && msg.you && msg.you.token
              && msg.you.token !== state.settings?.onlineToken) {
            try { ctx.saveSettings({ onlineToken: msg.you.token }); } catch { /* ignore */ }
          }
          for (const cb of onlineListeners) cb(msg);
        },
      });
    }
    return state.online;
  },

  onOnlineEvent(cb) {
    onlineListeners.add(cb);
    return () => onlineListeners.delete(cb);
  },

  saveProfile(profile) {
    if (profile) state.profile = profile;
    storage.saveProfile(state.profile);
    renderUser();
  },

  reloadProfile() {
    state.profile = storage.loadProfile();
    renderUser();
    return state.profile;
  },

  saveSettings(patch) {
    state.settings = storage.saveSettings(patch);
    sound.setEnabled(state.settings.sound);
    sound.setVolume(state.settings.volume);
    return state.settings;
  },

  navigate(route) {
    if (location.hash === route) render();
    else location.hash = route;
  },

  toast,
  modal,
  confirm: confirmDialog,

  /** Show a toast per newly unlocked achievement. */
  celebrate(unlockedIds) {
    (unlockedIds || []).forEach((id, index) => {
      const achievement = achievementById(id);
      if (!achievement) return;
      setTimeout(() => achievementToast(achievement), 500 + index * 900);
    });
  },
};

const onlineListeners = new Set();

/* -------------------------------- topbar -------------------------------- */

function bestRating(profile) {
  const entries = Object.entries(profile.ratings || {});
  let best = { key: 'bots', rating: 800, games: 0 };
  for (const [key, value] of entries) {
    if ((value.games || 0) > (best.games || 0)) best = { key, ...value };
  }
  if (!best.games) best = { key: 'bots', ...(profile.ratings?.bots || { rating: 800, games: 0 }) };
  return best;
}

function renderUser() {
  const host = document.getElementById('topbar-user');
  if (!host) return;
  clear(host);
  const profile = state.profile;
  const rating = bestRating(profile);
  const tier = ratingTier(rating.rating);

  const avatar = el('span', { style: { display: 'block', width: '32px', height: '32px' } });
  avatar.innerHTML = userAvatarSvg(profile.avatarSeed || profile.name, 32);

  host.appendChild(el('a', {
    href: '#/perfil',
    class: 'row gap-6',
    style: { color: 'var(--text)', textDecoration: 'none' },
    title: `${profile.name} — ${tier.name}`,
  },
  avatar,
  el('span', { class: 'col', style: { gap: '0', lineHeight: '1.15' } },
    el('span', { class: 'strong small', text: profile.name }),
    el('span', { class: 'tiny', style: { color: tier.color }, text: `${tier.icon} ${Math.round(rating.rating)}` }))));

  host.appendChild(el('a', { href: '#/ajustes', class: 'btn btn--ghost btn--icon', title: 'Ajustes', text: '⚙' }));
}

function markNav(navKey) {
  for (const link of document.querySelectorAll('.topbar__link')) {
    link.classList.toggle('is-active', link.getAttribute('href') === navKey);
  }
}

/* -------------------------------- router -------------------------------- */

function matchRoute(hash) {
  for (const route of ROUTES) {
    const m = route.test.exec(hash);
    if (m) return { route, params: route.params(m) };
  }
  return null;
}

let renderToken = 0;

async function render() {
  const token = ++renderToken;
  const hash = location.hash || '#/';

  if (state.current && state.current.unmount) {
    try { state.current.unmount(); } catch { /* keep navigating */ }
  }
  state.current = null;

  const matched = matchRoute(hash);
  if (!matched) {
    clear(root);
    root.appendChild(notFound());
    markNav('');
    return;
  }

  markNav(matched.route.nav || '');
  clear(root);
  root.appendChild(el('div', { class: 'screen center', style: { minHeight: '40vh' } },
    el('div', { class: 'spinner', style: { width: '28px', height: '28px' } })));

  let module;
  try {
    module = await matched.route.load();
  } catch (error) {
    if (token !== renderToken) return;
    clear(root);
    root.appendChild(loadError(error));
    return;
  }
  if (token !== renderToken) return;

  clear(root);
  try {
    state.current = module.mount(root, ctx, matched.params) || null;
  } catch (error) {
    clear(root);
    root.appendChild(loadError(error));
  }
  root.focus({ preventScroll: true });
  root.scrollTop = 0;   // el scroll vive en .main, no en la ventana
}

function notFound() {
  return el('div', { class: 'screen col center gap-16', style: { minHeight: '45vh', textAlign: 'center' } },
    el('h1', { class: 'h1', text: 'Esa página no existe' }),
    el('p', { class: 'muted', text: 'El enlace que seguiste no lleva a ninguna parte.' }),
    el('a', { class: 'btn btn--primary', href: '#/', text: 'Volver al inicio' }));
}

function loadError(error) {
  return el('div', { class: 'screen col center gap-16', style: { minHeight: '45vh', textAlign: 'center' } },
    el('h1', { class: 'h1', text: 'No se pudo cargar la pantalla' }),
    el('p', { class: 'muted', text: String(error && error.message ? error.message : error) }),
    el('p', { class: 'tiny faint', text: 'Si abriste el archivo directamente, iniciá el servidor con: node server/server.js' }),
    el('a', { class: 'btn', href: '#/', text: 'Volver al inicio' }));
}

/* --------------------------------- boot --------------------------------- */

window.addEventListener('hashchange', render);
window.addEventListener('error', (event) => {
  if (event.message && /ResizeObserver/.test(event.message)) return;
});

/* Bauverso no tiene puntuacion propia: la saca de GitHub. Se pone primero la
   ultima conocida para no enseñar un numero falso mientras carga, y luego se
   pide la de verdad. Si no hay red, se queda con la de antes. */
setLiveElo('bauverso', cachedGithubElo());
fetchGithubElo()
  .then((dato) => { if (dato && dato.elo) setLiveElo('bauverso', dato.elo); })
  .catch(() => { /* sin red, el bot juega con el Elo que ya tenia */ });

renderUser();
render();

export { ctx };
