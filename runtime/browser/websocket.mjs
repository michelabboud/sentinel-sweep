import { createHash, randomBytes } from 'node:crypto';
import { request as requestHttp } from 'node:http';
import { request as requestHttps } from 'node:https';
import { TextDecoder } from 'node:util';

import { SentinelError } from '../lib/errors.mjs';

export const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;

const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const HANDSHAKE_TIMEOUT_MS = 10_000;
const VALID_OPCODES = new Set([0, 1, 2, 8, 9, 10]);
const INVALID_CLOSE_CODES = new Set([1004, 1005, 1006]);

function websocketError(code, message) {
  return new SentinelError(code, message);
}

function headerHasToken(value, token) {
  return typeof value === 'string'
    && value.split(',').some((part) => part.trim().toLowerCase() === token);
}

function parseWebSocketUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw websocketError('WEBSOCKET_URL_INVALID', 'WebSocket URL is invalid');
  }
  if ((url.protocol !== 'ws:' && url.protocol !== 'wss:')
      || url.username !== ''
      || url.password !== ''
      || url.hash !== '') {
    throw websocketError('WEBSOCKET_URL_INVALID', 'WebSocket URL is not an approved connection URL');
  }
  return url;
}

function frameHeader(opcode, length) {
  let header;
  if (length <= 125) {
    header = Buffer.alloc(2);
    header[1] = 0x80 | length;
  } else if (length <= 0xffff) {
    header = Buffer.alloc(4);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  header[0] = 0x80 | opcode;
  return header;
}

function closePayload(code) {
  const payload = Buffer.alloc(2);
  payload.writeUInt16BE(code);
  return payload;
}

function validCloseCode(code) {
  return (code >= 1000
      && code <= 1014
      && !INVALID_CLOSE_CODES.has(code))
    || (code >= 3000 && code <= 4999);
}

export class WebSocketConnection {
  static async connect(value) {
    const url = parseWebSocketUrl(value);
    const key = randomBytes(16).toString('base64');
    const expectedAccept = createHash('sha1')
      .update(`${key}${WEBSOCKET_GUID}`)
      .digest('base64');
    const request = url.protocol === 'wss:' ? requestHttps : requestHttp;

    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        reject(error instanceof SentinelError
          ? error
          : websocketError('WEBSOCKET_HANDSHAKE_FAILED', 'WebSocket handshake failed'));
      };
      const handshake = request({
        protocol: url.protocol === 'wss:' ? 'https:' : 'http:',
        hostname: url.hostname,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        headers: {
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Key': key,
          'Sec-WebSocket-Version': '13',
        },
      });
      handshake.setTimeout(HANDSHAKE_TIMEOUT_MS, () => {
        handshake.destroy();
        fail(websocketError('WEBSOCKET_HANDSHAKE_TIMEOUT', 'WebSocket handshake timed out'));
      });
      handshake.once('error', fail);
      handshake.once('response', (response) => {
        response.resume();
        fail(websocketError('WEBSOCKET_HANDSHAKE_REJECTED', 'WebSocket upgrade was rejected'));
      });
      handshake.once('upgrade', (response, socket, head) => {
        if (settled) {
          socket.destroy();
          return;
        }
        if (response.statusCode !== 101
            || response.headers.upgrade?.toLowerCase() !== 'websocket'
            || !headerHasToken(response.headers.connection, 'upgrade')
            || response.headers['sec-websocket-accept'] !== expectedAccept
            || response.headers['sec-websocket-extensions'] !== undefined
            || response.headers['sec-websocket-protocol'] !== undefined) {
          socket.destroy();
          fail(websocketError('WEBSOCKET_HANDSHAKE_INVALID', 'WebSocket upgrade validation failed'));
          return;
        }
        settled = true;
        resolve(new WebSocketConnection(socket, head));
      });
      handshake.end();
    });
  }

  constructor(socket, initialData) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.state = 'open';
    this.fragments = [];
    this.fragmentBytes = 0;
    this.fragmentOpcode = null;
    this.closeInfo = { code: 1006 };
    this.closeEmitted = false;
    this.messageHandlers = new Set();
    this.pendingMessages = [];
    this.pendingMessageBytes = 0;
    this.closeHandlers = new Set();
    this.errorHandlers = new Set();
    this.closed = new Promise((resolve) => { this.resolveClosed = resolve; });

    socket.on('data', (chunk) => this.receive(chunk));
    socket.once('end', () => this.finishClose());
    socket.once('close', () => this.finishClose());
    socket.once('error', () => {
      this.emitError(websocketError('WEBSOCKET_IO_ERROR', 'WebSocket transport failed'));
      this.finishClose();
    });
    if (initialData.length > 0) this.receive(initialData);
  }

  onMessage(handler) {
    if (typeof handler !== 'function') {
      throw websocketError('WEBSOCKET_HANDLER_INVALID', 'WebSocket message handler must be a function');
    }
    this.messageHandlers.add(handler);
    if (this.pendingMessages.length > 0) {
      const pending = this.pendingMessages;
      this.pendingMessages = [];
      this.pendingMessageBytes = 0;
      for (const message of pending) this.emitHandlers(this.messageHandlers, message);
    }
    return () => this.messageHandlers.delete(handler);
  }

  onClose(handler) {
    if (typeof handler !== 'function') {
      throw websocketError('WEBSOCKET_HANDLER_INVALID', 'WebSocket close handler must be a function');
    }
    if (this.closeEmitted) handler(this.closeInfo);
    else this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  onError(handler) {
    if (typeof handler !== 'function') {
      throw websocketError('WEBSOCKET_HANDLER_INVALID', 'WebSocket error handler must be a function');
    }
    this.errorHandlers.add(handler);
    return () => this.errorHandlers.delete(handler);
  }

  emitHandlers(handlers, value) {
    for (const handler of [...handlers]) {
      try {
        handler(value);
      } catch {
        if (handlers !== this.errorHandlers) {
          this.emitError(websocketError(
            'WEBSOCKET_HANDLER_FAILED',
            'WebSocket event handler failed',
          ));
        }
      }
    }
  }

  emitError(error) {
    this.emitHandlers(this.errorHandlers, error);
  }

  sendFrame(opcode, payload) {
    if (this.state !== 'open' && opcode !== 8 && opcode !== 10) {
      throw websocketError('WEBSOCKET_NOT_OPEN', 'WebSocket is not open');
    }
    if (payload.length > MAX_MESSAGE_BYTES) {
      throw websocketError('WEBSOCKET_MESSAGE_TOO_LARGE', 'WebSocket message exceeds 8 MiB');
    }
    const mask = randomBytes(4);
    const masked = Buffer.allocUnsafe(payload.length);
    for (let index = 0; index < payload.length; index += 1) {
      masked[index] = payload[index] ^ mask[index % 4];
    }
    this.socket.write(Buffer.concat([frameHeader(opcode, payload.length), mask, masked]));
  }

  sendJson(value) {
    let text;
    try {
      text = JSON.stringify(value);
    } catch {
      throw websocketError('WEBSOCKET_JSON_INVALID', 'WebSocket value is not JSON serializable');
    }
    if (text === undefined) {
      throw websocketError('WEBSOCKET_JSON_INVALID', 'WebSocket value is not JSON serializable');
    }
    this.sendFrame(1, Buffer.from(text));
  }

  receive(chunk) {
    if (this.state !== 'open') return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    try {
      this.parseFrames();
    } catch (error) {
      this.protocolFailure(error);
    }
  }

  parseFrames() {
    while (this.state === 'open' && this.buffer.length >= 2) {
      const first = this.buffer[0];
      const second = this.buffer[1];
      const fin = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      if ((first & 0x70) !== 0 || !VALID_OPCODES.has(opcode) || (second & 0x80) !== 0) {
        throw websocketError('WEBSOCKET_PROTOCOL_ERROR', 'WebSocket frame is invalid');
      }

      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        if (length < 126) {
          throw websocketError('WEBSOCKET_PROTOCOL_ERROR', 'WebSocket frame length is invalid');
        }
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        const largeLength = this.buffer.readBigUInt64BE(2);
        if ((largeLength >> 63n) !== 0n || largeLength > BigInt(Number.MAX_SAFE_INTEGER)) {
          throw websocketError('WEBSOCKET_PROTOCOL_ERROR', 'WebSocket frame length is invalid');
        }
        if (largeLength < 65_536n) {
          throw websocketError('WEBSOCKET_PROTOCOL_ERROR', 'WebSocket frame length is invalid');
        }
        length = Number(largeLength);
        offset = 10;
      }

      const control = opcode >= 8;
      if (control && (!fin || length > 125)) {
        throw websocketError('WEBSOCKET_PROTOCOL_ERROR', 'WebSocket control frame is invalid');
      }
      const projected = opcode === 0 ? this.fragmentBytes + length : length;
      if (!control && projected > MAX_MESSAGE_BYTES) {
        throw websocketError('WEBSOCKET_MESSAGE_TOO_LARGE', 'WebSocket message exceeds 8 MiB');
      }
      if (this.buffer.length < offset + length) return;

      const payload = Buffer.from(this.buffer.subarray(offset, offset + length));
      this.buffer = this.buffer.subarray(offset + length);
      this.handleFrame(opcode, fin, payload);
      if (this.state !== 'open') this.clearInboundState();
    }
  }

  handleFrame(opcode, fin, payload) {
    if (opcode === 8) {
      if (payload.length === 1) {
        throw websocketError('WEBSOCKET_PROTOCOL_ERROR', 'WebSocket close frame is invalid');
      }
      const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
      if (payload.length >= 2 && !validCloseCode(code)) {
        throw websocketError('WEBSOCKET_PROTOCOL_ERROR', 'WebSocket close status is invalid');
      }
      if (payload.length > 2) {
        try {
          new TextDecoder('utf-8', { fatal: true }).decode(payload.subarray(2));
        } catch {
          throw websocketError('WEBSOCKET_PROTOCOL_ERROR', 'WebSocket close reason is not valid UTF-8');
        }
      }
      this.closeInfo = { code };
      if (this.state === 'open') this.sendFrame(8, payload);
      this.state = 'closing';
      this.clearInboundState();
      this.socket.end();
      return;
    }
    if (opcode === 9) {
      if (this.state === 'open') this.sendFrame(10, payload);
      return;
    }
    if (opcode === 10) return;
    if (opcode === 2) {
      throw websocketError('WEBSOCKET_PROTOCOL_ERROR', 'Binary WebSocket messages are unsupported');
    }

    if (opcode === 0) {
      if (this.fragmentOpcode === null) {
        throw websocketError('WEBSOCKET_PROTOCOL_ERROR', 'Unexpected WebSocket continuation frame');
      }
      this.fragments.push(payload);
      this.fragmentBytes += payload.length;
      if (fin) this.deliverText(Buffer.concat(this.fragments, this.fragmentBytes));
      return;
    }
    if (this.fragmentOpcode !== null) {
      throw websocketError('WEBSOCKET_PROTOCOL_ERROR', 'Interleaved WebSocket messages are invalid');
    }
    if (!fin) {
      this.fragmentOpcode = opcode;
      this.fragments = [payload];
      this.fragmentBytes = payload.length;
      return;
    }
    this.deliverText(payload);
  }

  deliverText(payload) {
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(payload);
    } catch {
      throw websocketError('WEBSOCKET_PROTOCOL_ERROR', 'WebSocket text is not valid UTF-8');
    }
    this.fragments = [];
    this.fragmentBytes = 0;
    this.fragmentOpcode = null;
    if (this.messageHandlers.size === 0) {
      const bytes = Buffer.byteLength(text);
      if (this.pendingMessageBytes + bytes > MAX_MESSAGE_BYTES) {
        throw websocketError('WEBSOCKET_MESSAGE_TOO_LARGE', 'Queued WebSocket messages exceed 8 MiB');
      }
      this.pendingMessages.push(text);
      this.pendingMessageBytes += bytes;
    } else {
      this.emitHandlers(this.messageHandlers, text);
    }
  }

  protocolFailure(error) {
    if (this.state !== 'open') return;
    const normalized = error instanceof SentinelError
      ? error
      : websocketError('WEBSOCKET_PROTOCOL_ERROR', 'WebSocket protocol processing failed');
    this.state = 'closing';
    this.clearInboundState();
    this.emitError(normalized);
    const code = normalized.code === 'WEBSOCKET_MESSAGE_TOO_LARGE' ? 1009 : 1002;
    this.sendFrame(8, closePayload(code));
    this.socket.end();
  }

  clearInboundState() {
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.fragmentBytes = 0;
    this.fragmentOpcode = null;
    this.pendingMessages = [];
    this.pendingMessageBytes = 0;
  }

  finishClose() {
    if (this.closeEmitted) return;
    this.state = 'closed';
    this.closeEmitted = true;
    this.emitHandlers(this.closeHandlers, this.closeInfo);
    this.closeHandlers.clear();
    this.messageHandlers.clear();
    this.clearInboundState();
    this.resolveClosed(this.closeInfo);
  }

  async close() {
    if (this.state === 'closed') return;
    if (this.state === 'open') {
      this.sendFrame(8, closePayload(1000));
      this.state = 'closing';
      this.clearInboundState();
      this.socket.end();
    }
    const timer = setTimeout(() => this.socket.destroy(), 1000);
    timer.unref?.();
    try {
      await this.closed;
    } finally {
      clearTimeout(timer);
    }
  }
}
