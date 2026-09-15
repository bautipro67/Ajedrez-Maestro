/**
 * github.js — el Elo en vivo del bot Bauverso, sacado de una cuenta de GitHub.
 *
 * GitHub no tiene Elo, así que hay que fabricarlo. La regla está pensada para
 * que se mueva de verdad —cuando publicás un repo, cuando alguien te sigue,
 * cuando te ponen una estrella— y para que caiga en el rango del plantel en
 * vez de dispararse: un proyecto vale unos 40 puntos, una estrella 12, un
 * seguidor 25, y el tiempo con la cuenta abierta suma poco a poco.
 *
 * Se consulta la API pública (sin credenciales, 60 peticiones por hora) y se
 * guarda el resultado un rato: si falla o no hay red, el bot sigue jugando con
 * el último Elo conocido, o con el de reserva.
 */

/* La primera que exista. `bauverso` es el nombre de itch.io y puede que algún
   día también el de GitHub; hoy la cuenta real es la segunda. */
export const GITHUB_USERS = ['bauverso', 'bautipro67'];

export const FALLBACK_ELO = 1400;
const CACHE_KEY = 'ajedrezMaestro.githubElo';
const CACHE_MS = 30 * 60 * 1000;
const MIN_ELO = 800;
const MAX_ELO = 2900;

/** De estadísticas públicas a Elo. Documentada arriba: nada de magia. */
export function eloFromStats(stats = {}) {
  const repos = Math.max(0, Number(stats.public_repos) || 0);
  const seguidores = Math.max(0, Number(stats.followers) || 0);
  const gists = Math.max(0, Number(stats.public_gists) || 0);
  const estrellas = Math.max(0, Number(stats.stars) || 0);

  let meses = 0;
  if (stats.created_at) {
    const alta = Date.parse(stats.created_at);
    if (Number.isFinite(alta)) meses = Math.max(0, (Date.now() - alta) / (1000 * 60 * 60 * 24 * 30.4));
  }

  const bruto = 1150
    + Math.min(600, repos * 40)
    + Math.min(500, seguidores * 25)
    + Math.min(400, estrellas * 12)
    + Math.min(150, gists * 15)
    + Math.min(300, meses * 6);

  return Math.max(MIN_ELO, Math.min(MAX_ELO, Math.round(bruto / 5) * 5));
}

function leerCache() {
  try {
    const crudo = globalThis.localStorage?.getItem(CACHE_KEY);
    if (!crudo) return null;
    const dato = JSON.parse(crudo);
    if (!dato || typeof dato.elo !== 'number') return null;
    return dato;
  } catch {
    return null;
  }
}

function guardarCache(dato) {
  try {
    globalThis.localStorage?.setItem(CACHE_KEY, JSON.stringify(dato));
  } catch {
    /* Sin almacenamiento se consulta más a menudo y ya está. */
  }
}

async function pedirJson(url) {
  const res = await fetch(url, { headers: { Accept: 'application/vnd.github+json' } });
  if (!res.ok) throw new Error('GitHub respondió ' + res.status);
  return res.json();
}

/** Suma de estrellas de los repos públicos. Si falla, cuenta como cero. */
async function contarEstrellas(login) {
  try {
    const repos = await pedirJson(`https://api.github.com/users/${encodeURIComponent(login)}/repos?per_page=100&sort=updated`);
    if (!Array.isArray(repos)) return 0;
    return repos.reduce((suma, r) => suma + (Number(r.stargazers_count) || 0), 0);
  } catch {
    return 0;
  }
}

/**
 * El Elo en vivo. Devuelve {elo, login, stats, ts, stale} y nunca lanza: si no
 * hay red, devuelve lo último que se supo, o el de reserva.
 *
 * @param {object} opts  force: salta la caché
 */
export async function fetchGithubElo({ force = false } = {}) {
  const cache = leerCache();
  if (!force && cache && Date.now() - (cache.ts || 0) < CACHE_MS) {
    return { ...cache, stale: false };
  }

  for (const login of GITHUB_USERS) {
    try {
      const perfil = await pedirJson(`https://api.github.com/users/${encodeURIComponent(login)}`);
      if (!perfil || !perfil.login) continue;
      const stars = await contarEstrellas(perfil.login);
      const stats = {
        public_repos: perfil.public_repos,
        followers: perfil.followers,
        public_gists: perfil.public_gists,
        created_at: perfil.created_at,
        stars,
      };
      const dato = { elo: eloFromStats(stats), login: perfil.login, stats, ts: Date.now() };
      guardarCache(dato);
      return { ...dato, stale: false };
    } catch {
      /* Esa cuenta no existe o la API no contesta: se prueba la siguiente. */
    }
  }

  if (cache) return { ...cache, stale: true };
  return { elo: FALLBACK_ELO, login: GITHUB_USERS[GITHUB_USERS.length - 1], stats: null, ts: 0, stale: true };
}

/** Lo último que se supo, sin pedir nada. Para pintar sin esperar a la red. */
export function cachedGithubElo() {
  const cache = leerCache();
  return cache ? cache.elo : FALLBACK_ELO;
}
