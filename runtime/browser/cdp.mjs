import { SentinelError } from '../lib/errors.mjs';
import { WebSocketConnection } from './websocket.mjs';

const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;

function cdpError(code, message, details = {}) {
  return new SentinelError(code, message, details);
}

function commandName(value) {
  return typeof value === 'string'
    && /^[A-Za-z][A-Za-z0-9]*\.[A-Za-z][A-Za-z0-9]*$/u.test(value);
}

export class CdpClient {
  static async connect(url) {
    return new CdpClient(await WebSocketConnection.connect(url));
  }

  constructor(connection) {
    this.connection = connection;
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Map();
    this.state = 'open';
    this.eventChain = Promise.resolve();
    this.transportClosePromise = null;

    connection.onMessage((text) => this.receive(text));
    connection.onError(() => this.disconnect('CDP_TRANSPORT_FAILED'));
    connection.onClose(() => this.disconnect('CDP_DISCONNECTED'));
  }

  on(method, handler) {
    if (!commandName(method) || typeof handler !== 'function') {
      throw cdpError('CDP_HANDLER_INVALID', 'CDP event registration is invalid');
    }
    const list = this.handlers.get(method) ?? [];
    list.push(handler);
    this.handlers.set(method, list);
    return () => {
      const current = this.handlers.get(method);
      if (!current) return;
      const index = current.indexOf(handler);
      if (index >= 0) current.splice(index, 1);
      if (current.length === 0) this.handlers.delete(method);
    };
  }

  send(method, params = {}, sessionId) {
    if (this.state !== 'open') {
      return Promise.reject(cdpError('CDP_DISCONNECTED', 'CDP client is disconnected'));
    }
    if (!commandName(method)
        || params === null
        || typeof params !== 'object'
        || Array.isArray(params)
        || (sessionId !== undefined && (typeof sessionId !== 'string' || sessionId.length === 0))) {
      return Promise.reject(cdpError('CDP_COMMAND_INVALID', 'CDP command is invalid'));
    }

    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(cdpError('CDP_COMMAND_TIMEOUT', `CDP command timed out: ${method}`, { method }));
      }, DEFAULT_COMMAND_TIMEOUT_MS);
      timeout.unref?.();
      this.pending.set(id, { method, resolve, reject, timeout });
      try {
        this.connection.sendJson({
          id,
          method,
          params,
          ...(sessionId === undefined ? {} : { sessionId }),
        });
      } catch {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(cdpError('CDP_SEND_FAILED', `CDP command could not be sent: ${method}`, { method }));
      }
    });
  }

  receive(text) {
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      this.disconnect('CDP_MESSAGE_INVALID');
      return;
    }
    if (message === null || typeof message !== 'object' || Array.isArray(message)) {
      this.disconnect('CDP_MESSAGE_INVALID');
      return;
    }
    if (Number.isSafeInteger(message.id)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timeout);
      if (message.error !== undefined) {
        pending.reject(cdpError(
          'CDP_COMMAND_FAILED',
          `CDP command failed: ${pending.method}`,
          { method: pending.method },
        ));
      } else {
        pending.resolve(message.result ?? {});
      }
      return;
    }
    if (!commandName(message.method)) {
      this.disconnect('CDP_MESSAGE_INVALID');
      return;
    }

    const handlers = [...(this.handlers.get(message.method) ?? [])];
    if (handlers.length === 0) return;
    const metadata = Object.freeze({
      sessionId: typeof message.sessionId === 'string' ? message.sessionId : null,
    });
    this.eventChain = this.eventChain.then(async () => {
      for (const handler of handlers) {
        await handler(message.params ?? {}, metadata);
      }
    }).catch(() => this.disconnect('CDP_EVENT_HANDLER_FAILED'));
  }

  disconnect(code) {
    if (this.state === 'closed') return;
    this.state = 'closed';
    const error = cdpError(code, 'CDP connection closed');
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
    void this.closeTransport();
  }

  closeTransport() {
    if (this.transportClosePromise === null) {
      this.transportClosePromise = Promise.resolve()
        .then(() => this.connection.close())
        .catch(() => {});
    }
    return this.transportClosePromise;
  }

  async flushEvents() {
    await this.eventChain;
  }

  async close() {
    if (this.state !== 'closed') this.disconnect('CDP_DISCONNECTED');
    await this.closeTransport();
  }
}
