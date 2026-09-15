/**
 * server.test.js — El servidor de partidas, de punta a punta.
 * Levanta `server/server.js` como proceso aparte en un puerto libre y habla
 * con el por HTTP y por WebSocket igual que lo haria el navegador. Esta escrito
 * contra la seccion 10 de docs/CONTRATO.md, no contra la implementacion: si el
 * servidor cumple el contrato, pasa.
 */

import { test, assert, assertEqual, run } from './harness.js';
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect } from './wsclient.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Un puerto que el sistema nos da por libre. */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/** Descarga por HTTP sin dependencias, devolviendo estado, tipo y cuerpo. */
function fetchPath(port, target) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
    });
    const chunks = [];
    socket.on('data', (c) => chunks.push(c));
    socket.on('error', () => resolve({ status: 0, type: '', body: '' }));
    socket.on('close', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      const split = text.indexOf('\r\n\r\n');
      const head = split === -1 ? text : text.slice(0, split);
      const body = split === -1 ? '' : text.slice(split + 4);
      const status = Number((head.split('\r\n')[0].match(/\s(\d{3})\s/) || [])[1] || 0);
      const type = (head.split('\r\n').find((l) => /^content-type:/i.test(l)) || '')
        .split(':').slice(1).join(':').trim();
      resolve({ status, type, body });
    });
  });
}

/**
 * La partida del lobby a la que se puede uno unir. Ojo: el lobby tambien lista
 * las que ya estan en juego (para mirarlas), asi que hay que descartarlas o se
 * acaba intentando entrar en una partida llena.
 */
function openGameFrom(lobby) {
  const games = Array.isArray(lobby && lobby.games) ? lobby.games : [];
  return games.find((g) => g && g.live !== true && g.status !== 'playing') || null;
}

async function startServer(extraEnv = {}) {
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'server.js')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = [];
  child.stdout.on('data', (d) => log.push(String(d)));
  child.stderr.on('data', (d) => log.push(String(d)));

  /* Se espera a que el puerto conteste, hasta 10 s. */
  const deadline = Date.now() + 10000;
  for (;;) {
    if (Date.now() > deadline) {
      child.kill();
      throw new Error('El servidor no arranco en 10 s. Salida:\n' + log.join(''));
    }
    const res = await fetchPath(port, '/');
    if (res.status > 0) break;
    await wait(150);
  }
  return { port, child, log };
}

/* ------------------------------ el recorrido ---------------------------- */

/**
 * Todo el recorrido vive dentro de un try, arranque del servidor incluido: si
 * `server/server.js` no existe o no levanta, esta suite tiene que fallar con un
 * mensaje legible, no tumbar la ejecucion entera.
 */
async function scenario() {
  const vacio = { status: 0, type: '', body: '' };
  const out = {
    errors: [], log: '',
    index: vacio, appJs: vacio, escape: vacio, escape2: vacio,
    welcome: null, welcomeB: null, lobby: { games: [] }, openGame: null,
    startA: null, startB: null, moveWhite: null, moveBlack: null,
    illegal: null, movesAfterIllegal: -1, chat: null, pong: null,
    aliveAfterGarbage: false, overWhite: null, overBlack: null,
  };
  let server = null;

  try {
    server = await startServer();
    const { port } = server;

    /* 1. Estatico */
    out.index = await fetchPath(port, '/');
    out.appJs = await fetchPath(port, '/js/app.js');
    out.escape = await fetchPath(port, '/../package.json');
    out.escape2 = await fetchPath(port, '/..%2fpackage.json');

    /* 2. Presentacion */
    const ana = await connect({ port });
    ana.send({ t: 'hello', name: 'Ana' });
    out.welcome = await ana.waitFor('welcome');

    const beto = await connect({ port });
    beto.send({ t: 'hello', name: 'Beto' });
    const welcomeB = await beto.waitFor('welcome');
    out.welcomeB = welcomeB;

    /* 3. Crear y unirse */
    ana.send({ t: 'create', tc: { base: 300, inc: 3 }, rated: true, color: 'w' });
    await wait(250);
    const lobbyReply = beto.next('lobby');
    beto.send({ t: 'lobby' });
    const lobby = await lobbyReply;
    out.lobby = lobby;
    const open = openGameFrom(lobby);
    out.openGame = open || null;
    if (!open) throw new Error('El lobby no anuncio ninguna partida abierta.');

    beto.send({ t: 'join', gameId: open.id });
    out.startA = await ana.waitFor('gameStart');
    out.startB = await beto.waitFor('gameStart');
    const gameId = out.startA.game.id;

    /* Quien lleva las blancas manda la primera jugada. */
    const whiteIsAna = out.startA.game.white.name === 'Ana';
    const white = whiteIsAna ? ana : beto;
    const black = whiteIsAna ? beto : ana;

    /* 4. Una jugada legal llega a los dos */
    white.send({ t: 'move', gameId, uci: 'e2e4' });
    out.moveWhite = await white.waitFor((m) => m.t === 'move' && m.uci === 'e2e4');
    out.moveBlack = await black.waitFor((m) => m.t === 'move' && m.uci === 'e2e4');

    /* 5. Una ilegal se rechaza y no mueve nada */
    black.send({ t: 'move', gameId, uci: 'e7e5x' });
    black.send({ t: 'move', gameId, uci: 'a1a8' });
    out.illegal = await black.waitFor('error');
    await wait(250);
    out.movesAfterIllegal = black.messages.filter((m) => m.t === 'move').length;

    /* 6. Chat */
    white.send({ t: 'chat', gameId, text: 'suerte' });
    out.chat = await black.waitFor('chat');

    /* 7. Basura variada: el servidor tiene que seguir en pie */
    black.sendRaw('{ esto no es json');
    black.sendRaw('[]');
    black.send({ t: 'move', gameId: 'no-existe', uci: 'e2e4' });
    black.send({ t: 'move' });
    black.send({ t: 'inventado', foo: 1 });
    black.send({ t: 'chat', gameId, text: 'x'.repeat(50000) });
    black.send(12345);
    await wait(400);
    const pongReply = black.next('pong');
    black.send({ t: 'ping', ts: 42 });
    out.pong = await pongReply;
    out.aliveAfterGarbage = !black.isClosed();

    /* 8. Rendirse cierra la partida con cambio de Elo */
    black.send({ t: 'resign', gameId });
    out.overWhite = await white.waitFor('gameOver');
    out.overBlack = await black.waitFor('gameOver');

    ana.close();
    beto.close();
    await wait(150);
  } catch (err) {
    out.errors.push(err && err.message ? err.message : String(err));
  } finally {
    if (server) {
      server.child.kill();
      await wait(200);
      out.log = server.log.join('');
    }
  }
  return out;
}

const s = await scenario();

/* --------------------------------- tests -------------------------------- */

test('el recorrido completo no se topo con nada roto', () => {
  assertEqual(s.errors.length, 0, s.errors.join(' | ') + '\n         salida del servidor:\n' + (s.log || '').slice(0, 900));
});

test('sirve la aplicacion web con los tipos MIME correctos', () => {
  assertEqual(s.index.status, 200, 'la portada responde');
  assert(/text\/html/.test(s.index.type), 'la portada es HTML, no ' + s.index.type);
  assert(/Ajedrez Maestro/.test(s.index.body), 'y trae la pagina de verdad');
  assertEqual(s.appJs.status, 200, 'sirve el javascript');
  assert(/text\/javascript|application\/javascript/.test(s.appJs.type),
    'los ES modules necesitan tipo javascript, y llego: ' + s.appJs.type);
});

test('no se puede salir de web/ con rutas relativas', () => {
  assert(s.escape.status !== 200 || !/"name"\s*:\s*"ajedrez-maestro"/.test(s.escape.body),
    'sirvio package.json con /../');
  assert(s.escape2.status !== 200 || !/"name"\s*:\s*"ajedrez-maestro"/.test(s.escape2.body),
    'sirvio package.json con la barra codificada');
});

test('hello devuelve welcome con token y puntuaciones', () => {
  const w = s.welcome;
  assert(w && w.you, 'welcome trae los datos del jugador');
  assert(typeof w.you.token === 'string' && w.you.token.length >= 8, 'con un token utilizable');
  assertEqual(w.you.name, 'Ana', 'y el nombre que se pidio');
  for (const category of ['bullet', 'blitz', 'rapid', 'classical']) {
    assert(typeof w.you.rating?.[category] === 'number', 'falta la puntuacion de ' + category);
  }
  assert(s.welcomeB.you.token !== s.welcome.you.token, 'cada jugador tiene su propio token');
});

test('el lobby anuncia la partida abierta con el Elo del anfitrion', () => {
  assert(Array.isArray(s.lobby.games), 'lobby trae una lista de partidas');
  const game = s.openGame;
  assert(game && typeof game.id === 'string', 'con su identificador');
  assert(typeof game.hostRating === 'number', 'y la puntuacion del anfitrion');
});

test('unirse arranca la partida para los dos', () => {
  for (const [label, start] of [['anfitrion', s.startA], ['invitado', s.startB]]) {
    assert(start && start.game, 'el ' + label + ' recibio gameStart');
    assert(start.game.white?.name && start.game.black?.name, 'con los dos jugadores');
    assert(typeof start.game.fen === 'string' && start.game.fen.includes('/'), 'y la posicion inicial');
  }
  assertEqual(s.startA.game.id, s.startB.game.id, 'es la misma partida');
  const names = [s.startA.game.white.name, s.startA.game.black.name].sort().join(',');
  assertEqual(names, 'Ana,Beto', 'estan los dos');
});

test('una jugada legal se propaga a ambos con SAN, FEN y relojes', () => {
  for (const [label, move] of [['quien mueve', s.moveWhite], ['el rival', s.moveBlack]]) {
    assert(move, label + ' recibio la jugada');
    assertEqual(move.san, 'e4', 'en notacion algebraica');
    assert(typeof move.fen === 'string' && move.fen.includes(' b '), 'la FEN pasa el turno a las negras');
    assert(move.clocks && typeof move.clocks.w === 'number' && typeof move.clocks.b === 'number',
      'y vienen los dos relojes');
  }
});

test('una jugada ilegal se rechaza sin tocar la partida', () => {
  assert(s.illegal && s.illegal.t === 'error', 'contesta con error');
  assert(typeof s.illegal.message === 'string' && s.illegal.message.length > 3,
    'y explica el motivo en espanol');
  assertEqual(s.movesAfterIllegal, 1, 'la unica jugada sigue siendo la legal');
});

test('el chat llega al rival', () => {
  assert(s.chat && s.chat.text === 'suerte', 'el texto llega tal cual');
  assert(typeof s.chat.from === 'string' && s.chat.from.length > 0, 'y se sabe quien lo dijo');
});

test('la basura no tumba el servidor', () => {
  assert(s.aliveAfterGarbage, 'la conexion sigue viva despues de mandar disparates');
  assert(s.pong && s.pong.t === 'pong', 'y sigue contestando a ping');
});

test('rendirse termina la partida y mueve el Elo de los dos', () => {
  const over = s.overWhite;
  assert(over, 'llega gameOver');
  assert(['1-0', '0-1', '1/2-1/2'].includes(over.result), 'con un resultado valido: ' + over.result);
  assert(typeof over.reason === 'string' && over.reason.length > 2, 'y su motivo en espanol');
  assert(over.ratings?.white && over.ratings?.black, 'con el cambio de puntuacion de ambos');
  for (const side of ['white', 'black']) {
    const r = over.ratings[side];
    assert(typeof r.before === 'number' && typeof r.after === 'number' && typeof r.delta === 'number',
      'el cambio de ' + side + ' viene completo');
  }
  assert(s.overBlack, 'y el rival tambien se entera');
});

/* ------------------- segundo recorrido: lo que falta ---------------------- */

/** Crea una partida entre dos clientes y devuelve todo lo necesario. */
async function pairUp(port, tc = { base: 300, inc: 3 }, names = ['Uno', 'Dos']) {
  const a = await connect({ port });
  a.send({ t: 'hello', name: names[0] });
  const wa = await a.waitFor('welcome');
  const b = await connect({ port });
  b.send({ t: 'hello', name: names[1] });
  const wb = await b.waitFor('welcome');

  a.send({ t: 'create', tc, rated: true, color: 'w' });
  await wait(200);
  const lobbyReply = b.next('lobby');
  b.send({ t: 'lobby' });
  const lobby = await lobbyReply;
  const open = openGameFrom(lobby);
  if (!open) throw new Error('No se anuncio ninguna partida abierta al emparejar.');
  b.send({ t: 'join', gameId: open.id });
  const startA = await a.waitFor('gameStart');
  await b.waitFor('gameStart');
  const gameId = startA.game.id;
  const whiteIsA = startA.game.white.name === names[0];
  return {
    a, b, gameId, startA,
    white: whiteIsA ? a : b,
    black: whiteIsA ? b : a,
    tokenA: wa.you.token, tokenB: wb.you.token,
    nameA: names[0], nameB: names[1],
  };
}

async function scenario2() {
  const out = { errors: [], log: '' };
  let server = null;
  try {
    server = await startServer();
    const { port } = server;

    /* 1. Emparejamiento rapido: dos que buscan lo mismo acaban juntos. */
    const q1 = await connect({ port });
    q1.send({ t: 'hello', name: 'Rapida' });
    await q1.waitFor('welcome');
    const q2 = await connect({ port });
    q2.send({ t: 'hello', name: 'Raudo' });
    await q2.waitFor('welcome');
    q1.send({ t: 'quick', tc: { base: 180, inc: 2 }, rated: true });
    await wait(200);
    q2.send({ t: 'quick', tc: { base: 180, inc: 2 }, rated: true });
    out.quick1 = await q1.waitFor('gameStart', 6000);
    out.quick2 = await q2.waitFor('gameStart', 6000);
    q1.close();
    q2.close();
    await wait(150);

    /* 2. Espectador: ve las jugadas de una partida ajena. */
    const g = await pairUp(port, { base: 300, inc: 3 }, ['Ana2', 'Beto2']);
    const ojo = await connect({ port });
    ojo.send({ t: 'hello', name: 'Mirona' });
    await ojo.waitFor('welcome');
    ojo.send({ t: 'watch', gameId: g.gameId });
    await wait(300);
    g.white.send({ t: 'move', gameId: g.gameId, uci: 'd2d4' });
    out.spectated = await ojo.waitFor((m) => m.t === 'move' && m.uci === 'd2d4', 5000)
      .catch((err) => ({ t: 'fallo', message: err.message }));
    ojo.close();

    /* 3. Tablas: se ofrecen, se rechazan y luego se aceptan. */
    g.black.send({ t: 'drawOffer', gameId: g.gameId });
    out.drawOffer = await g.white.waitFor('drawOffer', 5000);
    g.white.send({ t: 'drawDecline', gameId: g.gameId });
    out.drawDeclined = await g.black.waitFor('drawDeclined', 5000)
      .catch((err) => ({ t: 'fallo', message: err.message }));
    /* La segunda oferta la hace el otro bando: el servidor limita la frecuencia
       con la que uno mismo puede insistir, y con razon. */
    g.white.send({ t: 'drawOffer', gameId: g.gameId });
    out.drawOffer2 = await g.black.waitFor('drawOffer', 5000)
      .catch((err) => ({ t: 'fallo', message: err.message }));
    g.black.send({ t: 'drawAccept', gameId: g.gameId });
    out.drawOver = await g.white.waitFor('gameOver', 5000)
      .catch((err) => ({ t: 'fallo', message: err.message }));
    g.a.close();
    g.b.close();
    await wait(200);

    /* 4. Desconexion y vuelta: el rival se entera y se puede reconectar. */
    const r = await pairUp(port, { base: 300, inc: 3 }, ['Ida', 'Vuelta']);
    const survivor = r.b;            // 'Vuelta' se queda conectada
    const leaverToken = r.tokenA;    // y 'Ida' se cae de golpe, con su token
    r.a.close();
    out.gone = await survivor.waitFor('opponentGone', 8000)
      .catch((err) => ({ t: 'fallo', message: err.message }));

    const again = await connect({ port });
    again.send({ t: 'hello', name: 'Ida', token: leaverToken });
    const back = await again.waitFor('welcome', 6000);
    out.reconnectToken = back.you.token;
    const idaSide = r.startA.game.white.name === 'Ida' ? r.startA.game.white : r.startA.game.black;
    out.reconnectSameId = back.you.id === idaSide.id;
    out.backAgain = await survivor.waitFor('opponentBack', 8000)
      .catch((err) => ({ t: 'fallo', message: err.message }));
    /* La partida que reenvia al reconectar tiene que venir marcada: si no, el
       lobby mete al jugador dentro cada vez que el socket parpadea. */
    out.resumed = await again.waitFor('gameStart', 6000)
      .catch((err) => ({ t: 'fallo', message: err.message }));
    again.close();
    survivor.close();
    await wait(200);

    /* 5. Revancha: hace falta que la pidan los dos, y se cambian los colores. */
    const rv = await pairUp(port, { base: 300, inc: 3 }, ['Otra', 'Vez']);
    rv.black.send({ t: 'resign', gameId: rv.gameId });
    await rv.white.waitFor('gameOver', 5000);
    await wait(200);
    /* Pedirla uno solo no arranca nada. */
    rv.white.send({ t: 'rematch', gameId: rv.gameId });
    await wait(600);
    out.rematchSolo = rv.white.messages.filter((m) => m.t === 'gameStart').length;
    const revanchaA = rv.white.next('gameStart', 6000).catch((e) => ({ t: 'fallo', message: e.message }));
    const revanchaB = rv.black.next('gameStart', 6000).catch((e) => ({ t: 'fallo', message: e.message }));
    rv.black.send({ t: 'rematch', gameId: rv.gameId });
    out.rematchA = await revanchaA;
    out.rematchB = await revanchaB;
    out.rematchPrevio = rv.startA.game;
    rv.a.close();
    rv.b.close();
    await wait(200);

    /* 6. Caida de bandera: sin mover, el reloj decide. */
    const f = await pairUp(port, { base: 2, inc: 0 }, ['Lenta', 'Paciente']);
    out.flagTc = f.startA.game.tc || null;
    out.flag = await f.black.waitFor('gameOver', 12000)
      .catch((err) => ({ t: 'fallo', message: err.message }));
    f.a.close();
    f.b.close();
    await wait(200);
  } catch (err) {
    out.errors.push(err && err.message ? err.message : String(err));
  } finally {
    if (server) {
      server.child.kill();
      await wait(200);
      out.log = server.log.join('');
    }
  }
  return out;
}

/**
 * Tercer recorrido: el margen de gracia agotado. Se arranca un servidor con
 * AJEDREZ_ABANDON_MS corto para no esperar el minuto entero; lo que se prueba
 * es el mecanismo, y que el minuto de verdad es el que anuncia el servidor por
 * defecto ya lo comprueba el test de `opponentGone`.
 */
async function scenario3() {
  const out = { errors: [], log: '' };
  let server = null;
  try {
    server = await startServer({ AJEDREZ_ABANDON_MS: '2500' });
    const g = await pairUp(server.port, { base: 300, inc: 3 }, ['Fugaz', 'Espera']);
    const survivor = g.b;
    const leaverWasWhite = g.startA.game.white.name === 'Fugaz';
    g.a.abort();                       // se va sin despedirse, como un corte de luz
    out.gone = await survivor.waitFor('opponentGone', 8000)
      .catch((err) => ({ t: 'fallo', message: err.message }));
    out.goneSeconds = out.gone && out.gone.secondsLeft;
    out.over = await survivor.waitFor('gameOver', 12000)
      .catch((err) => ({ t: 'fallo', message: err.message }));
    out.expected = leaverWasWhite ? '0-1' : '1-0';
    survivor.close();
    await wait(200);
  } catch (err) {
    out.errors.push(err && err.message ? err.message : String(err));
  } finally {
    if (server) {
      server.child.kill();
      await wait(200);
      out.log = server.log.join('');
    }
  }
  return out;
}

const s2 = await scenario2();
const s3 = await scenario3();

test('el segundo recorrido llego hasta el final', () => {
  assertEqual(s2.errors.length, 0,
    s2.errors.join(' | ') + '\n         salida del servidor:\n' + (s2.log || '').slice(0, 900));
});

test('el emparejamiento rapido junta a dos que buscan lo mismo', () => {
  assert(s2.quick1 && s2.quick1.game, 'el primero entro en partida');
  assert(s2.quick2 && s2.quick2.game, 'el segundo tambien');
  assertEqual(s2.quick2.game.id, s2.quick1.game.id, 'y es la misma partida');
  const nombres = [s2.quick1.game.white.name, s2.quick1.game.black.name].sort().join(',');
  assertEqual(nombres, 'Rapida,Raudo', 'con los dos que estaban buscando');
});

test('un espectador recibe las jugadas de la partida que mira', () => {
  assert(s2.spectated && s2.spectated.t === 'move',
    'la jugada no llego al espectador: ' + (s2.spectated?.message || '—'));
  assertEqual(s2.spectated.san, 'd4', 'y con su notacion');
});

test('las tablas se ofrecen, se rechazan y se aceptan', () => {
  assert(s2.drawOffer && s2.drawOffer.t === 'drawOffer', 'la oferta llega al rival');
  assert(s2.drawDeclined && s2.drawDeclined.t === 'drawDeclined',
    'y el rechazo tambien: ' + (s2.drawDeclined?.message || '—'));
  assert(s2.drawOffer2 && s2.drawOffer2.t === 'drawOffer',
    'la segunda oferta, del otro bando, tambien llega: ' + (s2.drawOffer2?.message || '—'));
  assert(s2.drawOver && s2.drawOver.t === 'gameOver',
    'aceptarlas termina la partida: ' + (s2.drawOver?.message || '—'));
  assertEqual(s2.drawOver.result, '1/2-1/2', 'en tablas');
});

test('si alguien se cae, el rival se entera y se puede volver', () => {
  assert(s2.gone && s2.gone.t === 'opponentGone',
    'no llego opponentGone: ' + (s2.gone?.message || '—'));
  assert(typeof s2.gone.secondsLeft === 'number', 'con la cuenta atras de gracia');
  assert(s2.gone.secondsLeft > 50 && s2.gone.secondsLeft <= 60,
    'el margen por defecto tiene que ser el minuto que dice el contrato, y anuncia ' +
    s2.gone.secondsLeft + ' s');
  assert(typeof s2.reconnectToken === 'string' && s2.reconnectToken.length >= 8,
    'la reconexion devuelve un token');
  assert(s2.reconnectSameId, 'y te devuelve tu misma identidad, no una nueva');
  assert(s2.backAgain && s2.backAgain.t === 'opponentBack',
    'no llego opponentBack: ' + (s2.backAgain?.message || '—'));
});

test('la partida que reenvia al reconectar viene marcada como reanudada', () => {
  assert(s2.resumed && s2.resumed.t === 'gameStart',
    'no reenvio la partida al reconectar: ' + (s2.resumed?.message || '—'));
  assertEqual(s2.resumed.resume, true,
    'sin la marca, el lobby no distingue «esta ya la estabas jugando» de «acaba de ' +
    'empezar una» y te arrastra a la vieja en cada reconexion');
  assertEqual(s2.resumed.game.status, 'playing', 'y la partida sigue en marcha');
});

test('la revancha necesita que la pidan los dos y cambia los colores', () => {
  assertEqual(s2.rematchSolo, 1,
    'pedirla uno solo arranco una partida nueva, y no deberia: ' + s2.rematchSolo +
    ' gameStart en vez de 1 (el de la partida original)');
  assert(s2.rematchA && s2.rematchA.t === 'gameStart',
    'no llego la revancha a quien la pidio primero: ' + (s2.rematchA?.message || '—'));
  assert(s2.rematchB && s2.rematchB.t === 'gameStart',
    'ni al segundo: ' + (s2.rematchB?.message || '—'));
  assertEqual(s2.rematchB.game.id, s2.rematchA.game.id, 'es la misma partida nueva');
  assert(s2.rematchA.game.id !== s2.rematchPrevio.id, 'y distinta de la anterior');
  assertEqual(s2.rematchA.game.white.name, s2.rematchPrevio.black.name,
    'quien llevaba negras ahora lleva blancas');
  assertEqual(s2.rematchA.game.black.name, s2.rematchPrevio.white.name,
    'y al reves');
});

test('la bandera caida termina la partida', () => {
  assert(s2.flag && s2.flag.t === 'gameOver',
    'el reloj no termino la partida: ' + (s2.flag?.message || '—'));
  assert(['1-0', '0-1', '1/2-1/2'].includes(s2.flag.result),
    'con un resultado valido: ' + s2.flag.result);
  assert(/tiempo|bandera/i.test(String(s2.flag.reason)),
    'y el motivo dice que fue el reloj, no "' + s2.flag.reason + '"');
});

test('el tercer recorrido llego hasta el final', () => {
  assertEqual(s3.errors.length, 0,
    s3.errors.join(' | ') + ' · salida del servidor: ' + (s3.log || '').slice(0, 600));
});

test('agotado el margen de gracia, gana quien se quedo', () => {
  assert(s3.gone && s3.gone.t === 'opponentGone',
    'no aviso de la desconexion: ' + (s3.gone?.message || '—'));
  assert(s3.goneSeconds > 0, 'la cuenta atras arranca por encima de cero');
  assert(s3.over && s3.over.t === 'gameOver',
    'la partida no se cerro al agotarse el margen: ' + (s3.over?.message || '—'));
  assertEqual(s3.over.result, s3.expected, 'gana quien se quedo esperando');
  assert(/reconexi|abandon|desconect/i.test(String(s3.over.reason)),
    'y el motivo lo explica, no dice "' + s3.over.reason + '"');
});

run('server.js');
