/**
 * wsclient.js — cliente WebSocket minimo, solo para los tests.
 * Habla el lado del cliente de RFC 6455 (enmascara sus tramas, verifica la
 * clave del apreton de manos) y ofrece una espera comoda de mensajes JSON.
 * No es para producción: el cliente de verdad es el WebSocket del navegador.
 */

import net from 'node:net';
import { once } from 'node:events';
import { randomBytes, createHash } from 'node:crypto';
import { OPCODE } from '../server/ws.js';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** Trama de cliente: siempre enmascarada, con clave aleatoria. */
function maskedFrame(opcode, payload) {
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
  header[0] = 0x80 | opcode;
  const mask = randomBytes(4);
  const masked = Buffer.allocUnsafe(length);
  for (let i = 0; i < length; i++) masked[i] = data[i] ^ mask[i & 3];
  return Buffer.concat([header, mask, masked]);
}

/**
 * Conecta con un servidor WebSocket y devuelve un cliente de pruebas.
 * `connect({ port, path, host })` -> { send, next, waitFor, messages, close }
 */
export async function connect({ port, path = '/ws', host = '127.0.0.1', timeoutMs = 4000 } = {}) {
  const socket = net.connect(port, host);
  await once(socket, 'connect');

  const key = randomBytes(16).toString('base64');
  const expected = createHash('sha1').update(key + GUID).digest('base64');

  const messages = [];         // mensajes JSON recibidos, en orden
  const raw = [];              // textos tal cual, por si no eran JSON
  const waiters = [];
  let handshake = null;
  let buffer = Buffer.alloc(0);
  let upgraded = false;
  let closed = false;

  function pushMessage(text) {
    raw.push(text);
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { t: '__texto__', text };
    }
    messages.push(parsed);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].test(parsed)) {
        const waiter = waiters.splice(i, 1)[0];
        clearTimeout(waiter.timer);
        waiter.resolve(parsed);
      }
    }
  }

  function readFrames() {
    for (;;) {
      if (buffer.length < 2) return;
      const opcode = buffer[0] & 0x0f;
      let length = buffer[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) return;
        length = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }
      if (buffer.length < offset + length) return;
      const payload = buffer.subarray(offset, offset + length);
      buffer = buffer.subarray(offset + length);

      if (opcode === OPCODE.TEXT) pushMessage(payload.toString('utf8'));
      else if (opcode === OPCODE.PING) socket.write(maskedFrame(OPCODE.PONG, payload));
      else if (opcode === OPCODE.CLOSE) {
        closed = true;
        socket.end();
      }
    }
  }

  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (!upgraded) {
      const end = buffer.indexOf('\r\n\r\n');
      if (end === -1) return;
      handshake = buffer.subarray(0, end).toString('latin1');
      buffer = buffer.subarray(end + 4);
      upgraded = true;
    }
    readFrames();
  });
  socket.on('close', () => { closed = true; });
  socket.on('error', () => { closed = true; });

  socket.write(
    `GET ${path} HTTP/1.1\r\n` +
    `Host: ${host}:${port}\r\n` +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Key: ${key}\r\n` +
    'Sec-WebSocket-Version: 13\r\n\r\n',
  );

  const deadline = Date.now() + timeoutMs;
  while (!upgraded && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
  }
  if (!upgraded) {
    socket.destroy();
    throw new Error('El servidor no completo el apreton de manos.');
  }
  if (!handshake.startsWith('HTTP/1.1 101')) {
    socket.destroy();
    throw new Error('El servidor no acepto la conexion: ' + handshake.split('\r\n')[0]);
  }
  const accept = (handshake.split('\r\n').find((l) => /^sec-websocket-accept:/i.test(l)) || '')
    .split(':').slice(1).join(':').trim();
  if (accept !== expected) {
    socket.destroy();
    throw new Error('La clave del apreton de manos no cuadra.');
  }

  return {
    handshake,
    messages,
    raw,
    isClosed: () => closed,

    send(message) {
      const text = typeof message === 'string' ? message : JSON.stringify(message);
      socket.write(maskedFrame(OPCODE.TEXT, text));
    },

    /** Envia texto crudo, para probar que el servidor aguanta basura. */
    sendRaw(text) {
      socket.write(maskedFrame(OPCODE.TEXT, text));
    },

    /**
     * Espera un mensaje que cumpla el predicado (o de tipo `t`), aceptando uno
     * que ya hubiera llegado. Para peticion-respuesta usa `next()`: si no, un
     * mensaje viejo del mismo tipo se cuela como si fuera la respuesta.
     */
    waitFor(matcher, wait = timeoutMs) {
      const test = typeof matcher === 'function' ? matcher : (m) => m && m.t === matcher;
      const already = messages.find(test);
      if (already) return Promise.resolve(already);
      return this.next(matcher, wait);
    },

    /** Igual, pero solo cuenta lo que llegue a partir de ahora. */
    next(matcher, wait = timeoutMs) {
      const test = typeof matcher === 'function' ? matcher : (m) => m && m.t === matcher;
      return new Promise((resolve, reject) => {
        const waiter = { test, resolve };
        waiter.timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index !== -1) waiters.splice(index, 1);
          const vistos = messages.map((m) => m && m.t).join(', ') || '(ninguno)';
          reject(new Error(`No llego el mensaje esperado en ${wait} ms. Llegaron: ${vistos}`));
        }, wait);
        waiters.push(waiter);
      });
    },

    /**
     * Cierra como lo hace un navegador: manda su trama de cierre y despues
     * suelta el socket. Para el caso feo (alguien al que le quitan el cable)
     * esta `abort()`.
     */
    close() {
      closed = true;
      try {
        const body = Buffer.allocUnsafe(2);
        body.writeUInt16BE(1000, 0);
        socket.write(maskedFrame(OPCODE.CLOSE, body));
        socket.end();
      } catch {
        /* ya estaba cerrado */
      }
      const timer = setTimeout(() => {
        try {
          socket.destroy();
        } catch {
          /* nada que hacer */
        }
      }, 60);
      if (timer.unref) timer.unref();
    },

    /** Corta en seco, sin despedirse. */
    abort() {
      closed = true;
      try {
        socket.destroy();
      } catch {
        /* ya estaba cerrado */
      }
    },
  };
}
