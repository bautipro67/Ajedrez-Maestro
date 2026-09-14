/**
 * ws.test.js — La implementacion de WebSocket a mano.
 * Comprueba el apreton de manos contra el ejemplo del propio RFC 6455, el
 * troceado y desenmascarado de tramas (incluyendo fragmentacion y llegada
 * byte a byte), los errores de protocolo con su codigo de cierre, y una
 * conexion TCP de verdad de punta a punta contra un servidor levantado aqui.
 */

import { test, assert, assertEqual, run } from './harness.js';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { connect } from './wsclient.js';
import {
  acceptKey, encodeFrame, encodeClose, createFrameParser, createWebSocketServer, OPCODE,
} from '../server/ws.js';

/* ------------------------------- utilidades ------------------------------ */

/** Trama tal y como la manda un cliente: siempre enmascarada. */
function clientFrame(opcode, payload, { fin = true, mask = [0x37, 0xfa, 0x21, 0x3d] } = {}) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const length = data.length;
  let header;
  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = 0x80 | length;
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  header[0] = (fin ? 0x80 : 0) | opcode;
  const maskBuf = Buffer.from(mask);
  const masked = Buffer.allocUnsafe(length);
  for (let i = 0; i < length; i++) masked[i] = data[i] ^ maskBuf[i & 3];
  return Buffer.concat([header, maskBuf, masked]);
}

/** Lee una trama del servidor (nunca enmascarada). */
function decodeServerFrame(buf) {
  const fin = (buf[0] & 0x80) !== 0;
  const opcode = buf[0] & 0x0f;
  let length = buf[1] & 0x7f;
  let offset = 2;
  if (length === 126) {
    length = buf.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    length = Number(buf.readBigUInt64BE(2));
    offset = 10;
  }
  return { fin, opcode, payload: buf.subarray(offset, offset + length), size: offset + length };
}

function collect(options = {}) {
  const messages = [];
  const controls = [];
  const errors = [];
  const parser = createFrameParser({
    maxPayload: options.maxPayload || 1 << 20,
    onMessage: (payload, binary) => messages.push({ payload, binary }),
    onControl: (opcode, payload) => controls.push({ opcode, payload }),
    onError: (code, reason) => errors.push({ code, reason }),
  });
  return { parser, messages, controls, errors };
}

/* ------------------------------ apreton de manos ------------------------- */

test('acceptKey coincide con el ejemplo del RFC 6455', () => {
  assertEqual(acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=',
    'es el vector de prueba que trae la propia especificacion');
});

/* -------------------------------- tramas --------------------------------- */

test('encodeFrame usa la cabecera corta, media y larga segun el tamano', () => {
  const corta = encodeFrame(OPCODE.TEXT, Buffer.alloc(10));
  assertEqual(corta.length, 12, 'cabecera de 2 bytes');
  assertEqual(corta[0], 0x81, 'FIN + texto');
  assertEqual(corta[1], 10, 'longitud directa');
  assertEqual(corta[1] & 0x80, 0, 'el servidor nunca enmascara');

  const media = encodeFrame(OPCODE.TEXT, Buffer.alloc(200));
  assertEqual(media.length, 204, 'cabecera de 4 bytes');
  assertEqual(media[1], 126, 'marca de longitud extendida a 16 bits');
  assertEqual(media.readUInt16BE(2), 200, 'longitud en 16 bits');

  const larga = encodeFrame(OPCODE.TEXT, Buffer.alloc(70000));
  assertEqual(larga.length, 70010, 'cabecera de 10 bytes');
  assertEqual(larga[1], 127, 'marca de longitud extendida a 64 bits');
  assertEqual(Number(larga.readBigUInt64BE(2)), 70000, 'longitud en 64 bits');
});

test('encodeClose lleva el codigo en dos bytes y el motivo en UTF-8', () => {
  const frame = encodeClose(1009, 'demasiado grande');
  const { opcode, payload } = decodeServerFrame(frame);
  assertEqual(opcode, OPCODE.CLOSE, 'es una trama de cierre');
  assertEqual(payload.readUInt16BE(0), 1009, 'el codigo va primero');
  assertEqual(payload.subarray(2).toString('utf8'), 'demasiado grande', 'y despues el motivo');
});

test('el parser desenmascara un mensaje de texto', () => {
  const { parser, messages, errors } = collect();
  parser.feed(clientFrame(OPCODE.TEXT, 'hola mundo'));
  assertEqual(errors.length, 0, 'sin errores');
  assertEqual(messages.length, 1, 'un mensaje');
  assertEqual(messages[0].payload, 'hola mundo', 'texto desenmascarado');
  assertEqual(messages[0].binary, false, 'entregado como texto');
});

test('el parser aguanta que los bytes lleguen de uno en uno', () => {
  const { parser, messages, errors } = collect();
  const frame = clientFrame(OPCODE.TEXT, 'llega a trozos');
  for (const byte of frame) parser.feed(Buffer.from([byte]));
  assertEqual(errors.length, 0, 'sin errores');
  assertEqual(messages.length, 1, 'se reconstruyo el mensaje');
  assertEqual(messages[0].payload, 'llega a trozos', 'intacto');
});

test('el parser separa varias tramas que llegan pegadas', () => {
  const { parser, messages } = collect();
  parser.feed(Buffer.concat([
    clientFrame(OPCODE.TEXT, 'una'),
    clientFrame(OPCODE.TEXT, 'dos'),
    clientFrame(OPCODE.TEXT, 'tres'),
  ]));
  assertEqual(messages.map((m) => m.payload).join(','), 'una,dos,tres', 'las tres por separado');
});

test('el parser junta los mensajes fragmentados', () => {
  const { parser, messages, errors } = collect();
  parser.feed(clientFrame(OPCODE.TEXT, 'primera ', { fin: false }));
  parser.feed(clientFrame(OPCODE.CONTINUATION, 'segunda ', { fin: false }));
  parser.feed(clientFrame(OPCODE.CONTINUATION, 'y tercera'));
  assertEqual(errors.length, 0, 'sin errores');
  assertEqual(messages.length, 1, 'un solo mensaje al final');
  assertEqual(messages[0].payload, 'primera segunda y tercera', 'en orden');
});

test('un ping entre fragmentos no rompe el mensaje', () => {
  const { parser, messages, controls } = collect();
  parser.feed(clientFrame(OPCODE.TEXT, 'antes ', { fin: false }));
  parser.feed(clientFrame(OPCODE.PING, 'latido'));
  parser.feed(clientFrame(OPCODE.CONTINUATION, 'despues'));
  assertEqual(controls.length, 1, 'el ping se entrego aparte');
  assertEqual(controls[0].opcode, OPCODE.PING, 'era un ping');
  assertEqual(messages.length, 1, 'y el mensaje llego entero');
  assertEqual(messages[0].payload, 'antes despues', 'sin perder nada');
});

test('las tramas binarias se entregan como Buffer', () => {
  const { parser, messages } = collect();
  parser.feed(clientFrame(OPCODE.BINARY, Buffer.from([1, 2, 3, 250])));
  assertEqual(messages.length, 1, 'un mensaje');
  assertEqual(messages[0].binary, true, 'marcado como binario');
  assert(Buffer.isBuffer(messages[0].payload), 'y es un Buffer');
  assertEqual([...messages[0].payload].join(','), '1,2,3,250', 'bytes intactos');
});

/* --------------------------- errores de protocolo ------------------------ */

test('una trama sin enmascarar del cliente es un error 1002', () => {
  const { parser, errors } = collect();
  parser.feed(encodeFrame(OPCODE.TEXT, Buffer.from('sin mascara')));
  assertEqual(errors.length, 1, 'se detecto');
  assertEqual(errors[0].code, 1002, 'error de protocolo');
});

test('los bits reservados son un error 1002', () => {
  const { parser, errors } = collect();
  const frame = clientFrame(OPCODE.TEXT, 'hola');
  frame[0] |= 0x40;
  parser.feed(frame);
  assertEqual(errors.length, 1, 'se detecto');
  assertEqual(errors[0].code, 1002, 'error de protocolo');
});

test('un codigo de operacion desconocido es un error 1002', () => {
  const { parser, errors } = collect();
  parser.feed(clientFrame(0x3, 'raro'));
  assertEqual(errors.length, 1, 'se detecto');
  assertEqual(errors[0].code, 1002, 'error de protocolo');
});

test('una trama de control fragmentada es un error 1002', () => {
  const { parser, errors } = collect();
  parser.feed(clientFrame(OPCODE.PING, 'x', { fin: false }));
  assertEqual(errors.length, 1, 'se detecto');
  assertEqual(errors[0].code, 1002, 'las de control no se fragmentan');
});

test('una continuacion sin trama inicial es un error 1002', () => {
  const { parser, errors } = collect();
  parser.feed(clientFrame(OPCODE.CONTINUATION, 'huerfana'));
  assertEqual(errors.length, 1, 'se detecto');
  assertEqual(errors[0].code, 1002, 'error de protocolo');
});

test('pasarse del tamano maximo es un error 1009', () => {
  const { parser, errors, messages } = collect({ maxPayload: 64 });
  parser.feed(clientFrame(OPCODE.TEXT, Buffer.alloc(200, 97)));
  assertEqual(messages.length, 0, 'no se entrega');
  assertEqual(errors.length, 1, 'se detecto');
  assertEqual(errors[0].code, 1009, 'mensaje demasiado grande');
});

test('un fragmentado que se pasa de tamano tambien es 1009', () => {
  const { parser, errors } = collect({ maxPayload: 100 });
  parser.feed(clientFrame(OPCODE.TEXT, Buffer.alloc(60, 97), { fin: false }));
  parser.feed(clientFrame(OPCODE.CONTINUATION, Buffer.alloc(60, 97)));
  assertEqual(errors.length, 1, 'se detecto al sumar');
  assertEqual(errors[0].code, 1009, 'mensaje demasiado grande');
});

test('el texto que no es UTF-8 valido es un error 1007', () => {
  const { parser, errors, messages } = collect();
  /* 0xC3 abre una secuencia de dos bytes que nunca se cierra. */
  parser.feed(clientFrame(OPCODE.TEXT, Buffer.from([0x68, 0xc3, 0x28])));
  assertEqual(messages.length, 0, 'no se entrega basura');
  assertEqual(errors.length, 1, 'se detecto');
  assertEqual(errors[0].code, 1007, 'datos incoherentes con el tipo');
});

test('tras un error el parser deja de entregar mensajes', () => {
  const { parser, errors, messages } = collect();
  parser.feed(clientFrame(0x3, 'raro'));
  parser.feed(clientFrame(OPCODE.TEXT, 'esto ya no deberia llegar'));
  assertEqual(errors.length, 1, 'un solo error');
  assertEqual(messages.length, 0, 'y nada despues');
});

/* ------------------------- conexion real de punta a punta ---------------- */

/** Levanta un servidor, hace el apreton de manos por TCP y prueba a hablar. */
async function endToEnd() {
  const server = http.createServer((req, res) => {
    res.writeHead(200);
    res.end('ok');
  });
  const wss = createWebSocketServer({ server, path: '/ws', heartbeatMs: 0 });
  const seen = [];
  wss.on('connection', (client) => {
    client.on('message', (text) => {
      seen.push(text);
      client.send('eco:' + text);
    });
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();

  const socket = net.connect(port, '127.0.0.1');
  await once(socket, 'connect');

  const chunks = [];
  socket.on('data', (c) => chunks.push(c));

  socket.write(
    'GET /ws HTTP/1.1\r\n' +
    `Host: 127.0.0.1:${port}\r\n` +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
    'Sec-WebSocket-Version: 13\r\n\r\n',
  );

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  await wait(120);

  const head = Buffer.concat(chunks).toString('latin1');
  const status = head.split('\r\n')[0];
  const acceptLine = head.split('\r\n').find((l) => /^sec-websocket-accept:/i.test(l)) || '';
  const headerEnd = Buffer.concat(chunks).indexOf('\r\n\r\n') + 4;

  chunks.length = 0;
  socket.write(clientFrame(OPCODE.TEXT, 'hola'));
  socket.write(clientFrame(OPCODE.PING, 'ping'));
  /* Un mensaje partido en dos, para probar el camino completo. */
  socket.write(clientFrame(OPCODE.TEXT, 'par', { fin: false }));
  socket.write(clientFrame(OPCODE.CONTINUATION, 'tido'));
  await wait(200);

  const replies = [];
  let rest = Buffer.concat(chunks);
  while (rest.length >= 2) {
    const frame = decodeServerFrame(rest);
    replies.push({ opcode: frame.opcode, payload: frame.payload.toString('utf8') });
    rest = rest.subarray(frame.size);
  }

  socket.destroy();
  wss.close();
  server.close();
  await wait(50);

  return { status, acceptLine, headerEnd, seen, replies };
}

const e2e = await endToEnd();

test('el apreton de manos responde 101 con la clave correcta', () => {
  assertEqual(e2e.status, 'HTTP/1.1 101 Switching Protocols', 'cambia de protocolo');
  assertEqual(e2e.acceptLine.trim(), 'Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=',
    'la clave calculada coincide con la del RFC');
  assert(e2e.headerEnd > 0, 'las cabeceras terminan en linea en blanco');
});

test('el servidor recibe los mensajes del cliente, enteros y en orden', () => {
  assertEqual(e2e.seen.join(','), 'hola,partido', 'incluido el fragmentado');
});

test('el servidor contesta con eco y con el pong del ping', () => {
  const textos = e2e.replies.filter((r) => r.opcode === OPCODE.TEXT).map((r) => r.payload);
  const pongs = e2e.replies.filter((r) => r.opcode === OPCODE.PONG);
  assertEqual(textos.join(','), 'eco:hola,eco:partido', 'los dos ecos');
  assertEqual(pongs.length, 1, 'un pong');
  assertEqual(pongs[0].payload, 'ping', 'devuelve el mismo contenido del ping');
});

/* ------------------- el cliente de pruebas contra el servidor ------------ */

/** Deja listo `test/wsclient.js`, del que dependen los tests del servidor. */
async function clientRoundTrip() {
  const server = http.createServer();
  const wss = createWebSocketServer({ server, path: '/ws', heartbeatMs: 0 });
  wss.on('connection', (client) => {
    client.on('message', (text) => {
      let msg;
      try {
        msg = JSON.parse(text);
      } catch {
        client.send({ t: 'error', message: 'no era JSON' });
        return;
      }
      client.send({ t: 'respuesta', eco: msg.saludo });
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();

  const client = await connect({ port });
  client.send({ t: 'saluda', saludo: 'hola mundo' });
  const reply = await client.waitFor('respuesta');
  client.sendRaw('esto no es JSON');
  const error = await client.waitFor('error');

  client.close();
  wss.close();
  server.close();
  await new Promise((r) => setTimeout(r, 50));
  return { reply, error };
}

/**
 * Un cliente que desaparece: cierre limpio y corte en seco. El servidor tiene
 * que enterarse de los dos, o las partidas se quedan colgadas esperando a
 * alguien que ya no esta.
 */
async function disconnects() {
  const server = http.createServer();
  const wss = createWebSocketServer({ server, path: '/ws', heartbeatMs: 0 });
  const closes = [];
  wss.on('connection', (client) => {
    client.on('message', (text) => client.send('eco:' + text));
    client.on('close', (code) => closes.push(code));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  const limpio = await connect({ port });
  limpio.send('hola');
  await limpio.waitFor((m) => m.t === '__texto__');
  limpio.close();
  await wait(500);
  const trasCierreLimpio = closes.length;

  const seco = await connect({ port });
  seco.send('hola');
  await seco.waitFor((m) => m.t === '__texto__');
  seco.abort();
  await wait(2500);
  const trasCorteSeco = closes.length;

  wss.close();
  server.close();
  await wait(50);
  return { trasCierreLimpio, trasCorteSeco, clientesVivos: wss.clients.size };
}

const bajas = await disconnects();

test('el servidor detecta al que se va, se despida o no', () => {
  assertEqual(bajas.trasCierreLimpio, 1, 'no vio marcharse al que cerro bien');
  assertEqual(bajas.trasCorteSeco, 2, 'no vio marcharse al que corto en seco');
  assertEqual(bajas.clientesVivos, 0, 'y no deja conexiones fantasma en la lista');
});

const roundTrip = await clientRoundTrip();

test('el cliente de pruebas completa el apreton y habla JSON', () => {
  assertEqual(roundTrip.reply.t, 'respuesta', 'llego la respuesta');
  assertEqual(roundTrip.reply.eco, 'hola mundo', 'con el contenido correcto');
  assertEqual(roundTrip.error.t, 'error', 'y el servidor puede contestar a la basura');
});

run('ws.js');
