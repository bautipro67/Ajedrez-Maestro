/**
 * ws.js — WebSocket server (RFC 6455) written by hand over node:http, with no
 * dependencies. Handles the upgrade handshake, frame parsing and masking,
 * fragmentation, ping/pong and the closing handshake. Only text messages are
 * delivered upwards; binary frames are accepted but handed over as Buffers.
 */

import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export const OPCODE = Object.freeze({
  CONTINUATION: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa,
});

/** The `Sec-WebSocket-Accept` value for a client key. */
export function acceptKey(key) {
  return createHash('sha1').update(String(key) + GUID).digest('base64');
}

/** Builds a server frame. Server frames are never masked. */
export function encodeFrame(opcode, payload = Buffer.alloc(0), { fin = true } = {}) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const length = data.length;
  let header;
  if (length < 126) {
    header = Buffer.allocUnsafe(2);
    header[1] = length;
  } else if (length < 65536) {
    header = Buffer.allocUnsafe(4);
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  header[0] = (fin ? 0x80 : 0) | (opcode & 0x0f);
  return Buffer.concat([header, data]);
}

/** Close frame body: 2-byte big-endian code plus an optional UTF-8 reason. */
export function encodeClose(code = 1000, reason = '') {
  const text = Buffer.from(String(reason), 'utf8').subarray(0, 123);
  const body = Buffer.allocUnsafe(2 + text.length);
  body.writeUInt16BE(code, 0);
  text.copy(body, 2);
  return encodeFrame(OPCODE.CLOSE, body);
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

/**
 * Incremental frame parser. Feed it socket chunks; it calls back with whole
 * messages and control frames, or with a protocol error and its close code.
 */
export function createFrameParser({ maxPayload = 1 << 20, onMessage, onControl, onError }) {
  let buffer = Buffer.alloc(0);
  let fragments = [];
  let fragmentOpcode = 0;
  let fragmentLength = 0;
  let broken = false;

  function fail(code, reason) {
    if (broken) return;
    broken = true;
    buffer = Buffer.alloc(0);
    if (onError) onError(code, reason);
  }

  function deliver(opcode, payload) {
    if (opcode === OPCODE.TEXT) {
      let text;
      try {
        text = utf8.decode(payload);
      } catch {
        fail(1007, 'El texto no es UTF-8 valido.');
        return;
      }
      if (onMessage) onMessage(text, false);
      return;
    }
    if (onMessage) onMessage(payload, true);
  }

  function parse() {
    for (;;) {
      if (broken) return;
      if (buffer.length < 2) return;

      const first = buffer[0];
      const second = buffer[1];
      const fin = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;

      if ((first & 0x70) !== 0) return fail(1002, 'No se admiten extensiones (bits RSV).');
      if (!masked) return fail(1002, 'El cliente debe enmascarar sus tramas.');

      if (length === 126) {
        if (buffer.length < offset + 2) return;
        length = buffer.readUInt16BE(offset);
        offset += 2;
      } else if (length === 127) {
        if (buffer.length < offset + 8) return;
        const big = buffer.readBigUInt64BE(offset);
        offset += 8;
        if (big > BigInt(maxPayload)) return fail(1009, 'Mensaje demasiado grande.');
        length = Number(big);
      }
      if (length > maxPayload) return fail(1009, 'Mensaje demasiado grande.');
      if (buffer.length < offset + 4 + length) return;

      const mask = buffer.subarray(offset, offset + 4);
      offset += 4;
      const payload = Buffer.allocUnsafe(length);
      for (let i = 0; i < length; i++) payload[i] = buffer[offset + i] ^ mask[i & 3];
      offset += length;
      buffer = buffer.subarray(offset);

      /* Tramas de control: ni fragmentadas ni de mas de 125 bytes. */
      if (opcode >= 0x8) {
        if (!fin) return fail(1002, 'Una trama de control no puede fragmentarse.');
        if (length > 125) return fail(1002, 'Trama de control demasiado larga.');
        if (opcode !== OPCODE.CLOSE && opcode !== OPCODE.PING && opcode !== OPCODE.PONG) {
          return fail(1002, 'Codigo de control desconocido: ' + opcode);
        }
        if (onControl) onControl(opcode, payload);
        continue;
      }

      if (opcode === OPCODE.CONTINUATION) {
        if (fragmentOpcode === 0) return fail(1002, 'Continuacion sin trama inicial.');
        fragmentLength += length;
        if (fragmentLength > maxPayload) return fail(1009, 'Mensaje demasiado grande.');
        fragments.push(payload);
        if (fin) {
          const whole = Buffer.concat(fragments);
          const op = fragmentOpcode;
          fragments = [];
          fragmentOpcode = 0;
          fragmentLength = 0;
          deliver(op, whole);
        }
        continue;
      }

      if (opcode !== OPCODE.TEXT && opcode !== OPCODE.BINARY) {
        return fail(1002, 'Codigo de operacion desconocido: ' + opcode);
      }
      if (fragmentOpcode !== 0) return fail(1002, 'Llego un mensaje nuevo sin cerrar el anterior.');

      if (fin) {
        deliver(opcode, payload);
        continue;
      }
      fragmentOpcode = opcode;
      fragments = [payload];
      fragmentLength = length;
    }
  }

  return {
    feed(chunk) {
      if (broken) return;
      buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
      parse();
    },
    get pending() { return buffer.length; },
  };
}

/* ---------------------------- una conexion ----------------------------- */

class WsConnection extends EventEmitter {
  constructor(socket, request, options) {
    super();
    this.socket = socket;
    this.request = request;
    this.remoteAddress = socket.remoteAddress || '';
    this.alive = true;
    this.closed = false;
    this.data = {};              // sitio libre para que el servidor cuelgue cosas

    this.parser = createFrameParser({
      maxPayload: options.maxPayload,
      onMessage: (payload, binary) => {
        if (binary) this.emit('binary', payload);
        else this.emit('message', payload);
      },
      onControl: (opcode, payload) => this.handleControl(opcode, payload),
      onError: (code, reason) => {
        this.emit('protocolError', code, reason);
        this.close(code, reason);
      },
    });

    socket.on('data', (chunk) => {
      try {
        this.parser.feed(chunk);
      } catch (err) {
        this.emitError(err);
        this.terminate();
      }
    });
    socket.on('close', () => this.finish(1006, 'Conexion cortada.'));
    /* El peer puede irse de tres maneras: FIN limpio, corte en seco (error) o
       cierre del socket. Si solo se escucha 'close' hay casos en los que el
       servidor no se entera de que el rival ya no esta. */
    socket.on('end', () => this.finish(1006, 'El otro extremo cerro la conexion.'));
    socket.on('error', (err) => {
      this.emitError(err);
      this.finish(1006, 'Error de red.');
    });
    socket.setTimeout(0);
    socket.setNoDelay(true);
    /* Keepalive del sistema: detecta al que desaparece sin avisar. */
    try {
      socket.setKeepAlive(true, 15000);
    } catch {
      /* si la plataforma no deja, queda el latido de ping/pong */
    }
  }

  /**
   * Un socket roto (ECONNRESET y compania) es rutina en un servidor: si nadie
   * escucha 'error', EventEmitter lanzaria y tumbaria el proceso entero. Aqui
   * el aviso se emite solo si hay quien lo recoja.
   */
  emitError(err) {
    if (this.listenerCount('error') > 0) this.emit('error', err);
  }

  handleControl(opcode, payload) {
    if (opcode === OPCODE.PING) {
      this.write(encodeFrame(OPCODE.PONG, payload));
      this.emit('ping');
      return;
    }
    if (opcode === OPCODE.PONG) {
      this.alive = true;
      this.emit('pong');
      return;
    }
    /* CLOSE: se devuelve el eco y se cierra. */
    let code = 1005;
    let reason = '';
    if (payload.length >= 2) {
      code = payload.readUInt16BE(0);
      try {
        reason = utf8.decode(payload.subarray(2));
      } catch {
        reason = '';
      }
    }
    if (!this.closed) {
      this.closed = true;
      this.write(encodeClose(code === 1005 ? 1000 : code, ''));
    }
    this.socket.end();
    this.finish(code, reason);
  }

  write(buffer) {
    if (this.socket.destroyed || !this.socket.writable) return false;
    try {
      return this.socket.write(buffer);
    } catch {
      return false;
    }
  }

  /** Sends one text message. Objects are serialised as JSON. */
  send(message) {
    if (this.closed) return false;
    const text = typeof message === 'string' ? message : JSON.stringify(message);
    return this.write(encodeFrame(OPCODE.TEXT, Buffer.from(text, 'utf8')));
  }

  ping() {
    if (this.closed) return;
    this.alive = false;
    this.write(encodeFrame(OPCODE.PING, Buffer.alloc(0)));
  }

  close(code = 1000, reason = '') {
    if (this.closed) return;
    this.closed = true;
    this.write(encodeClose(code, reason));
    /* Un margen para que salga la trama antes de cortar. */
    const timer = setTimeout(() => this.terminate(), 250);
    if (timer.unref) timer.unref();
    this.socket.end();
  }

  terminate() {
    this.closed = true;
    try {
      this.socket.destroy();
    } catch {
      /* ya estaba cerrado */
    }
    this.finish(1006, 'Conexion terminada.');
  }

  finish(code, reason) {
    if (this.finished) return;
    this.finished = true;
    this.closed = true;
    this.emit('close', code, reason);
  }
}

/* ----------------------------- el servidor ----------------------------- */

/**
 * Attaches a WebSocket endpoint to an existing node:http server.
 * Emits 'connection' with a WsConnection for every accepted client.
 */
export function createWebSocketServer({
  server,
  path = '/ws',
  maxPayload = 1 << 20,
  heartbeatMs = 30000,
} = {}) {
  if (!server) throw new Error('createWebSocketServer necesita un servidor http.');

  const emitter = new EventEmitter();
  const clients = new Set();

  function reject(socket, status, message) {
    socket.write(
      `HTTP/1.1 ${status} ${message}\r\n` +
      'Connection: close\r\n' +
      'Content-Length: 0\r\n\r\n',
    );
    socket.destroy();
  }

  function onUpgrade(request, socket, head) {
    const url = request.url || '';
    const route = url.split('?')[0];
    if (route !== path) return reject(socket, 404, 'Not Found');

    const headers = request.headers;
    const upgrade = String(headers.upgrade || '').toLowerCase();
    const connection = String(headers.connection || '').toLowerCase();
    const key = headers['sec-websocket-key'];
    const version = String(headers['sec-websocket-version'] || '');

    if (upgrade !== 'websocket' || !connection.includes('upgrade')) {
      return reject(socket, 400, 'Bad Request');
    }
    if (!key || Buffer.from(String(key), 'base64').length !== 16) {
      return reject(socket, 400, 'Bad Request');
    }
    if (version !== '13') {
      socket.write(
        'HTTP/1.1 426 Upgrade Required\r\n' +
        'Sec-WebSocket-Version: 13\r\n' +
        'Connection: close\r\n' +
        'Content-Length: 0\r\n\r\n',
      );
      socket.destroy();
      return;
    }

    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
    );

    const client = new WsConnection(socket, request, { maxPayload });
    clients.add(client);
    client.on('close', () => clients.delete(client));
    if (head && head.length) client.parser.feed(head);
    emitter.emit('connection', client, request);
  }

  server.on('upgrade', onUpgrade);

  /* Latido: quien no conteste al ping se considera caido. */
  const beat = heartbeatMs > 0 ? setInterval(() => {
    for (const client of clients) {
      if (!client.alive) {
        client.terminate();
        continue;
      }
      client.ping();
    }
  }, heartbeatMs) : null;
  if (beat && beat.unref) beat.unref();

  return {
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
    clients,
    /** Sends the same message to every open client. */
    broadcast(message) {
      for (const client of clients) client.send(message);
    },
    close() {
      if (beat) clearInterval(beat);
      server.off('upgrade', onUpgrade);
      for (const client of clients) client.close(1001, 'El servidor se apaga.');
      clients.clear();
    },
  };
}
