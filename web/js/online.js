/**
 * online.js — WebSocket client for the multiplayer server. It reconnects on its
 * own with exponential backoff — a bounded number of times, then it gives up
 * and says so rather than nagging forever — queues outgoing messages while the
 * link is down, and measures latency. Protocol: docs/CONTRATO.md section 10.
 */

const MAX_QUEUE = 40;
const BACKOFF_STEPS = [1000, 2000, 4000, 8000, 15000];
/* Reintentar para siempre da la lata sin arreglar nada: si no hay servidor, no
   lo va a haber por insistir. Ocho intentos son unos 75 s, de sobra para
   despertar a uno dormido, y despues se para y queda el boton de reintentar. */
const MAX_ATTEMPTS = 8;

export function createOnline({ url, onEvent, backoff, maxAttempts } = {}) {
  const endpoint = toEndpoint(url) || defaultEndpoint();
  const steps = Array.isArray(backoff) && backoff.length ? backoff : BACKOFF_STEPS;
  const topeIntentos = Number.isFinite(maxAttempts) ? maxAttempts : MAX_ATTEMPTS;

  let socket = null;
  let state = 'idle';          // idle | connecting | open | closed
  let attempt = 0;
  let reconnectTimer = null;
  let pingTimer = null;
  let latency = null;
  let manualClose = false;
  let credentials = { name: 'Invitado', token: null };
  const queue = [];

  function emit(msg) {
    if (onEvent) {
      try {
        onEvent(msg);
      } catch {
        /* a listener error must not kill the socket */
      }
    }
  }

  function setState(next, extra = {}) {
    if (state === next && !Object.keys(extra).length) return;
    state = next;
    emit({ t: 'connection', state: next, latency, ...extra });
  }

  function send(msg) {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(msg));
      return true;
    }
    if (queue.length < MAX_QUEUE) queue.push(msg);
    return false;
  }

  function flush() {
    while (queue.length && socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(queue.shift()));
    }
  }

  function startPing() {
    stopPing();
    pingTimer = setInterval(() => {
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ t: 'ping', ts: Date.now() }));
      }
    }, 10000);
  }

  function stopPing() {
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
  }

  function scheduleReconnect() {
    if (manualClose || reconnectTimer) return;
    if (attempt >= topeIntentos) {
      setState('closed', { retryInMs: null, gaveUp: true });
      return;
    }
    const delay = steps[Math.min(attempt, steps.length - 1)];
    attempt += 1;
    setState('closed', { retryInMs: delay });
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      open();
    }, delay);
  }

  function open() {
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
    setState('connecting');
    try {
      socket = new WebSocket(endpoint);
    } catch {
      scheduleReconnect();
      return;
    }

    socket.onopen = () => {
      attempt = 0;
      setState('open');
      socket.send(JSON.stringify({ t: 'hello', name: credentials.name, token: credentials.token }));
      flush();
      startPing();
    };

    socket.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (!msg || typeof msg !== 'object') return;
      if (msg.t === 'pong') {
        latency = Math.max(0, Date.now() - (msg.ts || Date.now()));
        emit({ t: 'connection', state, latency });
        return;
      }
      if (msg.t === 'welcome' && msg.you) {
        credentials = { name: msg.you.name || credentials.name, token: msg.you.token || credentials.token };
      }
      emit(msg);
    };

    socket.onclose = () => {
      stopPing();
      socket = null;
      if (!manualClose) scheduleReconnect();
      else setState('idle');
    };

    socket.onerror = () => {
      // onclose always follows, which is where the reconnect is scheduled.
    };
  }

  return {
    /** Connect (or reconnect) identifying as `name`, resuming `token` if given. */
    connect(name, token = null) {
      credentials = { name: name || credentials.name, token: token || credentials.token };
      manualClose = false;
      attempt = 0;
      open();
    },

    disconnect() {
      manualClose = true;
      stopPing();
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      queue.length = 0;
      if (socket) {
        try { socket.close(1000, 'salida'); } catch { /* ignore */ }
        socket = null;
      }
      setState('idle');
    },

    isConnected: () => !!socket && socket.readyState === WebSocket.OPEN,
    getState: () => state,
    getLatency: () => latency,
    getToken: () => credentials.token,
    getName: () => credentials.name,
    endpoint,

    lobby: () => send({ t: 'lobby' }),
    create: (opts = {}) => send({
      t: 'create',
      tc: opts.tc || { base: 300, inc: 0 },
      rated: opts.rated !== false,
      color: opts.color || 'random',
      private: !!opts.private,
    }),
    join: (gameId) => send({ t: 'join', gameId }),
    quick: (tc, rated = true) => send({ t: 'quick', tc, rated }),
    cancelQuick: () => send({ t: 'cancelQuick' }),
    watch: (gameId) => send({ t: 'watch', gameId }),
    leave: (gameId) => send({ t: 'leave', gameId }),

    move: (gameId, uci, clientClock = null) => send({ t: 'move', gameId, uci, clientClock }),
    resign: (gameId) => send({ t: 'resign', gameId }),
    offerDraw: (gameId) => send({ t: 'drawOffer', gameId }),
    acceptDraw: (gameId) => send({ t: 'drawAccept', gameId }),
    declineDraw: (gameId) => send({ t: 'drawDecline', gameId }),
    rematch: (gameId) => send({ t: 'rematch', gameId }),
    chat: (gameId, text) => send({ t: 'chat', gameId, text: String(text).slice(0, 240) }),
    leaderboard: () => send({ t: 'leaderboard' }),

    raw: send,
  };
}

/**
 * Lo que la gente pega en «Servidor de partidas» es la direccion de su sitio
 * —https://lo-que-sea.onrender.com—, no la del socket, y tal cual no sirve: el
 * servidor solo atiende el upgrade en /ws, asi que sin ruta devuelve 404 y el
 * cliente se pasa la vida reintentando contra una puerta que no existe. Aqui
 * se traduce: http(s) pasa a ws(s), sin esquema se asume wss (ws en local) y
 * si no viene ruta se añade /ws. Devuelve null si no hay nada aprovechable.
 */
export function toEndpoint(raw) {
  const texto = String(raw == null ? '' : raw).trim();
  if (!texto) return null;

  let candidato = texto;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(candidato)) {
    const local = /^(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(candidato);
    candidato = (local ? 'ws://' : 'wss://') + candidato;
  }

  let u;
  try { u = new URL(candidato); } catch { return null; }
  if (u.protocol === 'http:') u.protocol = 'ws:';
  else if (u.protocol === 'https:') u.protocol = 'wss:';
  if (u.protocol !== 'ws:' && u.protocol !== 'wss:') return null;
  /* Cada navegador parsea distinto: Node revienta con "no vale" y Chrome lo
     acepta como el host "no%20vale". Se exige un nombre de maquina de verdad
     para que la validacion diga lo mismo en todas partes. */
  const host = u.hostname;
  const nombreValido = /^\[[0-9a-f:.]+\]$/i.test(host)
    || /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i.test(host);
  if (!nombreValido) return null;
  if (!u.pathname || u.pathname === '/') u.pathname = '/ws';
  u.search = '';
  u.hash = '';
  return u.toString();
}

function defaultEndpoint() {
  if (typeof location === 'undefined') return 'ws://localhost:8080/ws';
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${location.host}/ws`;
}

/** Spanish labels for the error codes the server may send. */
export const ONLINE_ERRORS = {
  noSuchGame: 'Esa partida ya no existe.',
  gameFull: 'La partida ya tiene dos jugadores.',
  notYourTurn: 'No es tu turno.',
  illegalMove: 'Esa jugada no es legal.',
  rateLimited: 'Vas demasiado rápido, esperá un momento.',
  badRequest: 'El servidor no entendió la petición.',
  notFound: 'No se encontró lo que pediste.',
};
