import { SentinelError } from '../lib/errors.mjs';
import { WebSocketConnection } from './websocket.mjs';

const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const MAX_COMMAND_TIMEOUT_MS = 120_000;
export const MAX_QUEUED_EVENTS = 1024;
export const MAX_QUEUED_EVENT_BYTES = 8 * 1024 * 1024;

function cdpError(code, message, details = {}) {
  return new SentinelError(code, message, details);
}

function commandName(value) {
  return typeof value === 'string'
    && /^[A-Za-z][A-Za-z0-9]*\.[A-Za-z][A-Za-z0-9]*$/u.test(value);
}

function boundedPositiveInteger(value, maximum) {
  return Number.isInteger(value) && value >= 1 && value <= maximum;
}

function abortSignal(value) {
  return value !== null
    && typeof value === 'object'
    && typeof value.aborted === 'boolean'
    && typeof value.addEventListener === 'function'
    && typeof value.removeEventListener === 'function';
}

export class CdpClient {
  static async connect(url, options = {}) {
    return new CdpClient(await WebSocketConnection.connect(url), options);
  }

  constructor(connection, {
    commandTimeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
    maxQueuedEventCount = MAX_QUEUED_EVENTS,
    maxQueuedEventBytes = MAX_QUEUED_EVENT_BYTES,
  } = {}) {
    if (!boundedPositiveInteger(commandTimeoutMs, MAX_COMMAND_TIMEOUT_MS)
        || !boundedPositiveInteger(maxQueuedEventCount, MAX_QUEUED_EVENTS)
        || !boundedPositiveInteger(maxQueuedEventBytes, MAX_QUEUED_EVENT_BYTES)) {
      throw cdpError('CDP_OPTIONS_INVALID', 'CDP client limits are invalid');
    }
    this.connection = connection;
    this.commandTimeoutMs = commandTimeoutMs;
    this.maxQueuedEventCount = maxQueuedEventCount;
    this.maxQueuedEventBytes = maxQueuedEventBytes;
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Map();
    this.state = 'open';
    this.disconnectError = null;
    this.transportClosePromise = null;
    this.eventQueue = [];
    this.queuedEventCount = 0;
    this.queuedEventBytes = 0;
    this.nextEventSequence = 0;
    this.completedEventSequence = 0;
    this.eventPumpScheduled = false;
    this.eventProcessing = false;
    this.flushWaiters = new Set();

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

  send(method, params = {}, sessionId, { timeoutMs = this.commandTimeoutMs, signal } = {}) {
    if (this.state !== 'open') {
      return Promise.reject(this.disconnectError
        ?? cdpError('CDP_DISCONNECTED', 'CDP client is disconnected'));
    }
    if (!commandName(method)
        || params === null
        || typeof params !== 'object'
        || Array.isArray(params)
        || (sessionId !== undefined && (typeof sessionId !== 'string' || sessionId.length === 0))
        || !boundedPositiveInteger(timeoutMs, MAX_COMMAND_TIMEOUT_MS)
        || (signal !== undefined && !abortSignal(signal))) {
      return Promise.reject(cdpError('CDP_COMMAND_INVALID', 'CDP command is invalid'));
    }
    if (signal?.aborted) {
      return Promise.reject(cdpError('CDP_COMMAND_ABORTED', 'CDP command was aborted', { method }));
    }

    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      let timeout;
      const cleanup = () => {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', onAbort);
      };
      const rejectAndDelete = (error) => {
        if (!this.pending.delete(id)) return;
        cleanup();
        reject(error);
      };
      const onAbort = () => rejectAndDelete(
        cdpError('CDP_COMMAND_ABORTED', 'CDP command was aborted', { method }),
      );
      timeout = setTimeout(() => rejectAndDelete(
        cdpError('CDP_COMMAND_TIMEOUT', `CDP command timed out: ${method}`, { method }),
      ), timeoutMs);
      timeout.unref?.();
      signal?.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, { method, resolve, reject, cleanup });
      try {
        this.connection.sendJson({
          id,
          method,
          params,
          ...(sessionId === undefined ? {} : { sessionId }),
        });
      } catch {
        rejectAndDelete(cdpError(
          'CDP_SEND_FAILED',
          `CDP command could not be sent: ${method}`,
          { method },
        ));
      }
    });
  }

  receive(text) {
    if (this.state !== 'open') return;
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
      pending.cleanup();
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
    const bytes = Buffer.byteLength(text);
    if (this.queuedEventCount + 1 > this.maxQueuedEventCount
        || this.queuedEventBytes + bytes > this.maxQueuedEventBytes) {
      this.disconnect('CDP_EVENT_QUEUE_OVERFLOW');
      return;
    }
    this.nextEventSequence += 1;
    this.eventQueue.push({
      bytes,
      handlers,
      metadata: Object.freeze({
        sessionId: typeof message.sessionId === 'string' ? message.sessionId : null,
      }),
      params: message.params ?? {},
      sequence: this.nextEventSequence,
    });
    this.queuedEventCount += 1;
    this.queuedEventBytes += bytes;
    this.scheduleEventPump();
  }

  scheduleEventPump() {
    if (this.eventPumpScheduled || this.eventProcessing || this.state !== 'open') return;
    this.eventPumpScheduled = true;
    queueMicrotask(() => {
      this.eventPumpScheduled = false;
      void this.pumpEvents();
    });
  }

  async pumpEvents() {
    if (this.eventProcessing || this.state !== 'open') return;
    this.eventProcessing = true;
    try {
      while (this.state === 'open' && this.eventQueue.length > 0) {
        const event = this.eventQueue.shift();
        try {
          for (const handler of event.handlers) {
            if (this.state !== 'open') break;
            await handler(event.params, event.metadata);
          }
        } catch {
          this.disconnect('CDP_EVENT_HANDLER_FAILED');
        } finally {
          this.queuedEventCount = Math.max(0, this.queuedEventCount - 1);
          this.queuedEventBytes = Math.max(0, this.queuedEventBytes - event.bytes);
          this.completedEventSequence = Math.max(this.completedEventSequence, event.sequence);
          this.resolveFlushWaiters();
        }
      }
    } finally {
      this.eventProcessing = false;
      if (this.eventQueue.length > 0) this.scheduleEventPump();
    }
  }

  disconnect(code) {
    if (this.state === 'closed') return;
    this.state = 'closed';
    const error = cdpError(code, 'CDP connection closed');
    this.disconnectError = error;
    for (const pending of this.pending.values()) {
      pending.cleanup();
      pending.reject(error);
    }
    this.pending.clear();
    this.eventQueue = [];
    this.queuedEventCount = 0;
    this.queuedEventBytes = 0;
    for (const waiter of this.flushWaiters) {
      waiter.cleanup();
      waiter.reject(error);
    }
    this.flushWaiters.clear();
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

  waitForEventSequence(sequence, signal) {
    if (this.state !== 'open') return Promise.reject(this.disconnectError);
    if (this.completedEventSequence >= sequence) return Promise.resolve();
    if (signal?.aborted) {
      return Promise.reject(cdpError('CDP_COMMAND_ABORTED', 'CDP event flush was aborted'));
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        sequence,
        resolve,
        reject,
        cleanup: () => signal?.removeEventListener('abort', onAbort),
      };
      const onAbort = () => {
        if (!this.flushWaiters.delete(waiter)) return;
        waiter.cleanup();
        reject(cdpError('CDP_COMMAND_ABORTED', 'CDP event flush was aborted'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.flushWaiters.add(waiter);
    });
  }

  resolveFlushWaiters() {
    for (const waiter of [...this.flushWaiters]) {
      if (this.completedEventSequence < waiter.sequence) continue;
      this.flushWaiters.delete(waiter);
      waiter.cleanup();
      waiter.resolve();
    }
  }

  async flushEvents({ signal } = {}) {
    if (signal !== undefined && !abortSignal(signal)) {
      throw cdpError('CDP_COMMAND_INVALID', 'CDP event flush signal is invalid');
    }
    let sequence;
    do {
      sequence = this.nextEventSequence;
      await this.waitForEventSequence(sequence, signal);
    } while (this.nextEventSequence > sequence);
  }

  async roundTrip(
    method,
    params = {},
    sessionId,
    { timeoutMs = this.commandTimeoutMs, signal } = {},
  ) {
    if (!boundedPositiveInteger(timeoutMs, MAX_COMMAND_TIMEOUT_MS)
        || (signal !== undefined && !abortSignal(signal))) {
      throw cdpError('CDP_COMMAND_INVALID', 'CDP round-trip options are invalid');
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    const timer = setTimeout(abort, timeoutMs);
    timer.unref?.();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    try {
      const result = await this.send(method, params, sessionId, {
        timeoutMs,
        signal: controller.signal,
      });
      await this.flushEvents({ signal: controller.signal });
      return result;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }

  async close() {
    if (this.state !== 'closed') this.disconnect('CDP_DISCONNECTED');
    await this.closeTransport();
  }
}
