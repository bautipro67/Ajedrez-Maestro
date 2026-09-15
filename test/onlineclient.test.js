/**
 * onlineclient.test.js — el cliente de online del navegador (web/js/online.js).
 * Dos cosas que se rompieron en la practica y no se veian desde ningun test:
 * la traduccion de la direccion que escribe el usuario, y hasta cuando insiste
 * el cliente en reconectar cuando no hay nadie al otro lado.
 */

import http from 'node:http';
import { test, assert, assertEqual, run } from './harness.js';
import { createOnline, toEndpoint } from '../web/js/online.js';

const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));

/** Un puerto que con seguridad rechaza: se abre uno y se cierra enseguida. */
async function puertoMuerto() {
  const server = http.createServer();
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const { port } = server.address();
  await new Promise((ok) => server.close(ok));
  return port;
}

/* ---------------------------- la direccion ------------------------------ */

test('la dirección que pega el usuario se traduce a la del socket', () => {
  /* Esto es exactamente lo que se le pide a quien juega desde itch.io: que
     pegue la direccion de su servidor. Tal cual no sirve —el servidor solo
     atiende el upgrade en /ws— y sin esto el cliente se quedaba reintentando
     para siempre contra una puerta que devuelve 404. */
  assertEqual(toEndpoint('https://ajedrez-maestro.onrender.com'),
    'wss://ajedrez-maestro.onrender.com/ws', 'la direccion de una pagina https');
  assertEqual(toEndpoint('https://ajedrez-maestro.onrender.com/'),
    'wss://ajedrez-maestro.onrender.com/ws', 'con barra final es la misma');
  assertEqual(toEndpoint('ajedrez-maestro.onrender.com'),
    'wss://ajedrez-maestro.onrender.com/ws', 'sin esquema se asume seguro');
});

test('en local no se exige https, que no lo hay', () => {
  assertEqual(toEndpoint('http://localhost:8080'), 'ws://localhost:8080/ws');
  assertEqual(toEndpoint('localhost:8080'), 'ws://localhost:8080/ws');
  assertEqual(toEndpoint('127.0.0.1:8080'), 'ws://127.0.0.1:8080/ws');
});

test('una dirección ya completa se respeta tal cual', () => {
  assertEqual(toEndpoint('wss://x.com/ws'), 'wss://x.com/ws');
  assertEqual(toEndpoint('https://x.com/ws'), 'wss://x.com/ws');
  assertEqual(toEndpoint('https://x.com/partidas'), 'wss://x.com/partidas',
    'si alguien puso su servidor en otra ruta, no se la pisamos');
});

test('lo que no se entiende se rechaza en vez de inventarlo', () => {
  /* 'no vale' es el caso que separa a los parsers: Node revienta y Chrome lo
     convierte en el host 'no%20vale'. Tiene que dar null en los dos. */
  for (const basura of ['', '   ', null, undefined, 'ftp://x.com', 'no vale',
    'https://no vale', 'wss://a_b*c/ws', 'https://', '://x.com']) {
    assertEqual(toEndpoint(basura), null, 'deberia rechazar ' + JSON.stringify(basura));
  }
});

/* ------------------------- hasta cuando insiste ------------------------- */

const hayWebSocket = typeof WebSocket !== 'undefined';
const reintentos = { eventos: [], primera: [], despues: 0, segundaTanda: 0 };

if (hayWebSocket) {
  const port = await puertoMuerto();
  const cliente = createOnline({
    url: `ws://127.0.0.1:${port}/ws`,
    backoff: [10, 10],
    maxAttempts: 2,
    onEvent: (msg) => { if (msg.t === 'connection') reintentos.eventos.push(msg); },
  });

  cliente.connect('Prueba');
  await wait(800);
  const hasta = reintentos.eventos.length;
  await wait(400);
  reintentos.despues = reintentos.eventos.length - hasta;
  /* La primera tanda aparte: despues se lanza otra a proposito. */
  reintentos.primera = reintentos.eventos.slice();

  /* El boton «Reintentar ahora» tiene que volver a empezar de cero. */
  const antes = reintentos.eventos.length;
  cliente.connect('Prueba');
  await wait(600);
  reintentos.segundaTanda = reintentos.eventos.length - antes;
  cliente.disconnect();
}

test('el cliente deja de reintentar solo en vez de insistir para siempre', () => {
  if (!hayWebSocket) {
    assert(true, 'sin WebSocket global (Node < 22) no se puede probar aquí');
    return;
  }
  const intentos = reintentos.primera.filter((e) => e.state === 'connecting').length;
  assertEqual(intentos, 3, 'con maxAttempts 2 son el intento inicial y dos reintentos');
  const rendido = reintentos.primera.filter((e) => e.gaveUp).length;
  assertEqual(rendido, 1, 'y avisa una sola vez de que se rindió');
  assert(reintentos.primera[reintentos.primera.length - 1].gaveUp,
    'rendirse tiene que ser lo último que dice, no algo del medio');
});

test('después de rendirse no sigue moviendo nada por su cuenta', () => {
  if (!hayWebSocket) { assert(true, 'sin WebSocket global no aplica'); return; }
  assertEqual(reintentos.despues, 0,
    'siguió intentándolo después de rendirse, que es justo lo que molestaba');
});

test('volver a llamar a connect() empieza una tanda nueva', () => {
  if (!hayWebSocket) { assert(true, 'sin WebSocket global no aplica'); return; }
  assert(reintentos.segundaTanda >= 2,
    'el botón de reintentar tiene que servir después de haberse rendido, y solo ' +
    'produjo ' + reintentos.segundaTanda + ' avisos');
});

run();
