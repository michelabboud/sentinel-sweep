import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import test from 'node:test';

import {
  MAX_MESSAGE_BYTES,
  WebSocketConnection,
} from '../../runtime/browser/websocket.mjs';
import { CdpClient } from '../../runtime/browser/cdp.mjs';

const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function withTimeout(promise, label, timeoutMs = 5000) {
  let timeout;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timeout));
}

function encodeServerFrame({ opcode, payload = Buffer.alloc(0), fin = true }) {
  const bytes = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  let header;
  if (bytes.length <= 125) {
    header = Buffer.alloc(2);
    header[1] = bytes.length;
  } else if (bytes.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(bytes.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(bytes.length), 2);
  }
  header[0] = (fin ? 0x80 : 0) | opcode;
  return Buffer.concat([header, bytes]);
}

function oversizedServerFrameHeader(length) {
  const header = Buffer.alloc(10);
  header[0] = 0x81;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(length), 2);
  return header;
}

function createClientFrameCollector(socket, initial = Buffer.alloc(0)) {
  let buffer = initial;
  const frames = [];
  const waiters = [];

  function deliver(frame) {
    const waiter = waiters.shift();
    if (waiter) waiter.resolve(frame);
    else frames.push(frame);
  }

  function fail(error) {
    while (waiters.length > 0) waiters.shift().reject(error);
  }

  function parse() {
    while (buffer.length >= 2) {
      const first = buffer[0];
      const second = buffer[1];
      const lengthCode = second & 0x7f;
      let offset = 2;
      let length = lengthCode;
      if (lengthCode === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (lengthCode === 127) {
        if (buffer.length < 10) return;
        const largeLength = buffer.readBigUInt64BE(2);
        assert.ok(largeLength <= BigInt(Number.MAX_SAFE_INTEGER));
        length = Number(largeLength);
        offset = 10;
      }

      const masked = (second & 0x80) !== 0;
      if (masked) offset += 4;
      if (buffer.length < offset + length) return;

      const mask = masked ? buffer.subarray(offset - 4, offset) : null;
      const payload = Buffer.from(buffer.subarray(offset, offset + length));
      if (mask) {
        for (let index = 0; index < payload.length; index += 1) {
          payload[index] ^= mask[index % 4];
        }
      }
      buffer = buffer.subarray(offset + length);
      deliver({
        fin: (first & 0x80) !== 0,
        opcode: first & 0x0f,
        masked,
        lengthCode,
        payload,
      });
    }
  }

  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    try {
      parse();
    } catch (error) {
      fail(error);
    }
  });
  socket.on('error', fail);

  if (initial.length > 0) parse();

  return {
    nextFrame() {
      if (frames.length > 0) return Promise.resolve(frames.shift());
      return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
    },
  };
}

async function startRawWebSocketServer(t, {
  initialServerFrame = null,
  responseHeaders = [],
  duplicateAccept = false,
} = {}) {
  const sockets = new Set();
  let resolvePeer;
  let rejectPeer;
  const peerPromise = new Promise((resolve, reject) => {
    resolvePeer = resolve;
    rejectPeer = reject;
  });
  const server = createServer();

  server.on('upgrade', (request, socket, head) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    try {
      const key = request.headers['sec-websocket-key'];
      assert.equal(typeof key, 'string');
      const accept = createHash('sha1').update(`${key}${WEBSOCKET_GUID}`).digest('base64');
      const response = Buffer.from([
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${accept}`,
        ...(duplicateAccept ? [`Sec-WebSocket-Accept: ${accept}`] : []),
        ...responseHeaders,
        '',
        '',
      ].join('\r\n'));
      socket.write(initialServerFrame === null
        ? response
        : Buffer.concat([response, initialServerFrame]));
      const collector = createClientFrameCollector(socket, head);
      resolvePeer({
        socket,
        nextFrame: collector.nextFrame,
        send(frame) { socket.write(frame); },
      });
    } catch (error) {
      rejectPeer(error);
      socket.destroy();
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });

  return {
    url: `ws://127.0.0.1:${address.port}/devtools/browser/test`,
    peer: withTimeout(peerPromise, 'WebSocket peer'),
  };
}

test('masks every client JSON frame and encodes 7, 16, and 64-bit lengths', async (t) => {
  const server = await startRawWebSocketServer(t);
  const connection = await WebSocketConnection.connect(server.url);
  const peer = await server.peer;

  const values = [
    { value: 'small' },
    { value: 'm'.repeat(200) },
    { value: 'l'.repeat(70_000) },
  ];
  for (const value of values) connection.sendJson(value);

  const frames = [];
  for (let index = 0; index < values.length; index += 1) {
    frames.push(await withTimeout(peer.nextFrame(), `client frame ${index}`));
  }
  assert.deepEqual(frames.map((frame) => frame.masked), [true, true, true]);
  assert.deepEqual(frames.map((frame) => frame.opcode), [1, 1, 1]);
  assert.deepEqual(frames.map((frame) => frame.lengthCode), [values[0]
    ? Buffer.byteLength(JSON.stringify(values[0]))
    : 0, 126, 127]);
  assert.deepEqual(frames.map((frame) => JSON.parse(frame.payload.toString('utf8'))), values);

  const closing = connection.close();
  const closeFrame = await withTimeout(peer.nextFrame(), 'client close frame');
  assert.equal(closeFrame.opcode, 8);
  assert.equal(closeFrame.masked, true);
  peer.send(encodeServerFrame({ opcode: 8, payload: closeFrame.payload }));
  peer.socket.end();
  await closing;
});

test('reassembles fragmented text, replies to ping with a masked pong, and completes close', async (t) => {
  const server = await startRawWebSocketServer(t);
  const connection = await WebSocketConnection.connect(server.url);
  const peer = await server.peer;
  const message = withTimeout(new Promise((resolve) => connection.onMessage(resolve)), 'message');
  const closed = withTimeout(new Promise((resolve) => connection.onClose(resolve)), 'close');

  peer.send(encodeServerFrame({ opcode: 1, payload: '{"answer":', fin: false }));
  peer.send(encodeServerFrame({ opcode: 9, payload: 'sentinel-ping' }));
  const pong = await withTimeout(peer.nextFrame(), 'masked pong');
  assert.equal(pong.opcode, 10);
  assert.equal(pong.masked, true);
  assert.equal(pong.payload.toString('utf8'), 'sentinel-ping');

  peer.send(encodeServerFrame({ opcode: 0, payload: '42}', fin: true }));
  assert.equal(await message, '{"answer":42}');

  const closePayload = Buffer.alloc(2);
  closePayload.writeUInt16BE(1000);
  peer.send(encodeServerFrame({ opcode: 8, payload: closePayload }));
  const closeReply = await withTimeout(peer.nextFrame(), 'close reply');
  assert.equal(closeReply.opcode, 8);
  assert.equal(closeReply.masked, true);
  peer.socket.end();
  const closeInfo = await closed;
  assert.equal(closeInfo.code, 1000);
});

test('fails closed on malformed opcodes and messages larger than 8 MiB', async (t) => {
  await t.test('malformed opcode', async (subtest) => {
    const server = await startRawWebSocketServer(subtest);
    const connection = await WebSocketConnection.connect(server.url);
    const peer = await server.peer;
    const errored = withTimeout(new Promise((resolve) => connection.onError(resolve)), 'protocol error');

    peer.send(encodeServerFrame({ opcode: 3, payload: 'target-opcode-payload' }));
    const error = await errored;
    assert.equal(error.code, 'WEBSOCKET_PROTOCOL_ERROR');
    assert.equal(error.message.includes('target-opcode-payload'), false);
    peer.socket.destroy();
    await connection.close();
  });

  await t.test('maximum complete message', async (subtest) => {
    const server = await startRawWebSocketServer(subtest);
    const connection = await WebSocketConnection.connect(server.url);
    const peer = await server.peer;
    const errored = withTimeout(new Promise((resolve) => connection.onError(resolve)), 'size error');

    peer.send(oversizedServerFrameHeader(MAX_MESSAGE_BYTES + 1));
    const error = await errored;
    assert.equal(error.code, 'WEBSOCKET_MESSAGE_TOO_LARGE');
    peer.socket.destroy();
    await connection.close();
  });
});

test('CDP correlates out-of-order numeric responses and delivers event handlers in registration order', async (t) => {
  const server = await startRawWebSocketServer(t);
  const client = await CdpClient.connect(server.url);
  const peer = await server.peer;

  const first = client.send('Runtime.evaluate', { expression: 'first' });
  const second = client.send('Runtime.evaluate', { expression: 'second' });
  const firstRequest = JSON.parse((await peer.nextFrame()).payload.toString('utf8'));
  const secondRequest = JSON.parse((await peer.nextFrame()).payload.toString('utf8'));
  peer.send(encodeServerFrame({
    opcode: 1,
    payload: JSON.stringify({ id: secondRequest.id, result: { value: 'two' } }),
  }));
  peer.send(encodeServerFrame({
    opcode: 1,
    payload: JSON.stringify({ id: firstRequest.id, result: { value: 'one' } }),
  }));
  assert.deepEqual(await first, { value: 'one' });
  assert.deepEqual(await second, { value: 'two' });

  const order = [];
  let resolveDelivered;
  const delivered = new Promise((resolve) => { resolveDelivered = resolve; });
  client.on('Runtime.consoleAPICalled', () => { order.push('first'); });
  client.on('Runtime.consoleAPICalled', () => {
    order.push('second');
    resolveDelivered();
  });
  peer.send(encodeServerFrame({
    opcode: 1,
    payload: JSON.stringify({ method: 'Runtime.consoleAPICalled', params: { type: 'error' } }),
  }));
  await withTimeout(delivered, 'ordered CDP event');
  assert.deepEqual(order, ['first', 'second']);

  const closing = client.close();
  const closeFrame = await peer.nextFrame();
  peer.send(encodeServerFrame({ opcode: 8, payload: closeFrame.payload }));
  peer.socket.end();
  await closing;
});

test('CDP rejects pending requests when the transport disconnects', async (t) => {
  const server = await startRawWebSocketServer(t);
  const client = await CdpClient.connect(server.url);
  const peer = await server.peer;

  const pending = client.send('Runtime.evaluate', { expression: 'pending' });
  await peer.nextFrame();
  const closePayload = Buffer.alloc(2);
  closePayload.writeUInt16BE(1001);
  peer.send(encodeServerFrame({ opcode: 8, payload: closePayload }));
  await peer.nextFrame();
  peer.socket.end();

  await assert.rejects(pending, { code: 'CDP_DISCONNECTED' });
  await client.close();
});

test('queues a complete message received in the HTTP upgrade head until a listener registers', async (t) => {
  const server = await startRawWebSocketServer(t, {
    initialServerFrame: encodeServerFrame({ opcode: 1, payload: '{"head":true}' }),
  });
  const connection = await WebSocketConnection.connect(server.url);
  const peer = await server.peer;

  const message = await withTimeout(
    new Promise((resolve) => connection.onMessage(resolve)),
    'queued upgrade-head message',
  );
  assert.equal(message, '{"head":true}');

  const closing = connection.close();
  const closeFrame = await peer.nextFrame();
  peer.send(encodeServerFrame({ opcode: 8, payload: closeFrame.payload }));
  peer.socket.end();
  await closing;
});

test('rejects invalid close status codes and malformed UTF-8 reasons as protocol failures', async (t) => {
  for (const [name, payload] of [
    ['reserved status code', Buffer.from([0x03, 0xed])],
    ['malformed UTF-8 reason', Buffer.from([0x03, 0xe8, 0xc3, 0x28])],
  ]) {
    await t.test(name, async (subtest) => {
      const server = await startRawWebSocketServer(subtest);
      const connection = await WebSocketConnection.connect(server.url);
      const peer = await server.peer;
      const errored = withTimeout(
        new Promise((resolve) => connection.onError(resolve)),
        `${name} protocol error`,
      );

      peer.send(encodeServerFrame({ opcode: 8, payload }));
      assert.equal((await errored).code, 'WEBSOCKET_PROTOCOL_ERROR');
      const reply = await peer.nextFrame();
      assert.equal(reply.opcode, 8);
      assert.equal(reply.payload.readUInt16BE(0), 1002);
      peer.socket.destroy();
      await connection.close();
    });
  }
});

class FakeWebSocketConnection {
  constructor() {
    this.handlers = {};
    this.closeCalls = 0;
    this.sent = [];
  }

  onMessage(handler) { this.handlers.message = handler; }

  onError(handler) { this.handlers.error = handler; }

  onClose(handler) { this.handlers.close = handler; }

  sendJson(value) { this.sent.push(value); }

  async close() { this.closeCalls += 1; }
}

test('actively closes the transport on invalid CDP messages and event-handler failures', async (t) => {
  await t.test('invalid message', async () => {
    const connection = new FakeWebSocketConnection();
    const client = new CdpClient(connection);
    connection.handlers.message('{not-json');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(connection.closeCalls, 1);
    await client.close();
  });

  await t.test('event handler failure', async () => {
    const connection = new FakeWebSocketConnection();
    const client = new CdpClient(connection);
    client.on('Runtime.consoleAPICalled', () => { throw new Error('handler failure'); });
    connection.handlers.message(JSON.stringify({
      method: 'Runtime.consoleAPICalled',
      params: { type: 'error' },
    }));
    await assert.rejects(client.flushEvents(), { code: 'CDP_EVENT_HANDLER_FAILED' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(connection.closeCalls, 1);
    await client.close();
  });
});

test('rejects unsolicited WebSocket extension and subprotocol negotiation', async (t) => {
  for (const [name, header] of [
    ['extension', 'Sec-WebSocket-Extensions: permessage-deflate'],
    ['subprotocol', 'Sec-WebSocket-Protocol: target-protocol'],
  ]) {
    await t.test(name, async (subtest) => {
      const server = await startRawWebSocketServer(subtest, { responseHeaders: [header] });
      await assert.rejects(WebSocketConnection.connect(server.url), {
        code: 'WEBSOCKET_HANDSHAKE_INVALID',
      });
    });
  }
});

test('rejects a duplicate WebSocket accept header', async (t) => {
  const server = await startRawWebSocketServer(t, { duplicateAccept: true });
  await assert.rejects(WebSocketConnection.connect(server.url), {
    code: 'WEBSOCKET_HANDSHAKE_INVALID',
  });
});

test('stops WebSocket input permanently after close or protocol failure', async (t) => {
  await t.test('close frame with trailing text in one packet', async (subtest) => {
    const closePayload = Buffer.alloc(2);
    closePayload.writeUInt16BE(1000);
    const server = await startRawWebSocketServer(subtest);
    const connection = await WebSocketConnection.connect(server.url);
    const peer = await server.peer;
    const messages = [];
    connection.onMessage((message) => messages.push(message));

    peer.send(Buffer.concat([
      encodeServerFrame({ opcode: 8, payload: closePayload }),
      encodeServerFrame({ opcode: 1, payload: 'must-not-deliver' }),
    ]));
    await withTimeout(peer.nextFrame(), 'close reply');
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(messages, []);
    peer.socket.destroy();
    await connection.close();
  });

  await t.test('malformed text with buffered trailing text', async (subtest) => {
    const server = await startRawWebSocketServer(subtest);
    const connection = await WebSocketConnection.connect(server.url);
    const peer = await server.peer;
    const messages = [];
    connection.onMessage((message) => messages.push(message));
    const errored = withTimeout(
      new Promise((resolve) => connection.onError(resolve)),
      'malformed text error',
    );

    peer.send(Buffer.concat([
      encodeServerFrame({ opcode: 1, payload: Buffer.from([0xc3, 0x28]) }),
      encodeServerFrame({ opcode: 1, payload: 'must-not-deliver' }),
    ]));
    await errored;
    connection.receive(Buffer.alloc(0));
    assert.deepEqual(messages, []);
    peer.socket.destroy();
    await connection.close();
  });

  await t.test('fragment state after protocol failure', async (subtest) => {
    const server = await startRawWebSocketServer(subtest);
    const connection = await WebSocketConnection.connect(server.url);
    const peer = await server.peer;
    const messages = [];
    connection.onMessage((message) => messages.push(message));
    const errored = withTimeout(
      new Promise((resolve) => connection.onError(resolve)),
      'fragment protocol error',
    );

    peer.send(encodeServerFrame({ opcode: 1, payload: 'partial-', fin: false }));
    peer.send(encodeServerFrame({ opcode: 3, payload: 'invalid' }));
    await errored;
    connection.receive(encodeServerFrame({ opcode: 0, payload: 'must-not-deliver' }));
    assert.deepEqual(messages, []);
    peer.socket.destroy();
    await connection.close();
  });
});

test('discards messages queued before a WebSocket protocol failure', async (t) => {
  const server = await startRawWebSocketServer(t, {
    initialServerFrame: Buffer.concat([
      encodeServerFrame({ opcode: 1, payload: 'queued-before-failure' }),
      encodeServerFrame({ opcode: 3, payload: 'invalid' }),
    ]),
  });
  const connection = await WebSocketConnection.connect(server.url);
  const messages = [];
  connection.onMessage((message) => messages.push(message));
  assert.deepEqual(messages, []);
  await connection.close();
});

test('ignores CDP messages after malformed input or transport close', async (t) => {
  for (const mode of ['malformed', 'closed']) {
    await t.test(mode, async () => {
      const connection = new FakeWebSocketConnection();
      const client = new CdpClient(connection);
      let delivered = 0;
      client.on('Runtime.consoleAPICalled', () => { delivered += 1; });

      if (mode === 'malformed') connection.handlers.message('{invalid-json');
      else connection.handlers.close({ code: 1000 });
      connection.handlers.message(JSON.stringify({
        method: 'Runtime.consoleAPICalled',
        params: { type: 'error' },
      }));
      await assert.rejects(client.flushEvents(), {
        code: mode === 'malformed' ? 'CDP_MESSAGE_INVALID' : 'CDP_DISCONNECTED',
      });
      assert.equal(delivered, 0);
      await client.close();
    });
  }
});

test('honors a bounded per-command CDP timeout', async () => {
  const connection = new FakeWebSocketConnection();
  const client = new CdpClient(connection);
  const startedAt = performance.now();

  await assert.rejects(
    withTimeout(
      client.send('Runtime.evaluate', {}, undefined, { timeoutMs: 25 }),
      'per-command CDP timeout',
      250,
    ),
    { code: 'CDP_COMMAND_TIMEOUT' },
  );
  assert.ok(performance.now() - startedAt < 200);
  await client.close();
});

test('flushes CDP events to a fixed point when a handler queues another event', async () => {
  const connection = new FakeWebSocketConnection();
  const client = new CdpClient(connection);
  const delivered = [];
  client.on('Runtime.consoleAPICalled', ({ index }) => {
    delivered.push(index);
    if (index === 1) {
      connection.handlers.message(JSON.stringify({
        method: 'Runtime.consoleAPICalled',
        params: { index: 2 },
      }));
    }
  });
  connection.handlers.message(JSON.stringify({
    method: 'Runtime.consoleAPICalled',
    params: { index: 1 },
  }));

  await client.flushEvents();

  assert.deepEqual(delivered, [1, 2]);
  await client.close();
});

test('CDP barrier includes an event from a later transport turn before its response', async () => {
  const connection = new FakeWebSocketConnection();
  const client = new CdpClient(connection);
  const delivered = [];
  let releaseHandler;
  const handlerReleased = new Promise((resolve) => { releaseHandler = resolve; });
  let resolveResponseSeen;
  const responseSeen = new Promise((resolve) => { resolveResponseSeen = resolve; });
  client.on('Runtime.consoleAPICalled', async ({ marker }) => {
    delivered.push(marker);
    await handlerReleased;
  });

  let barrierResolved = false;
  const barrier = client.roundTrip(
    'Page.getFrameTree',
    {},
    'page-session',
    { timeoutMs: 250 },
  ).then(() => { barrierResolved = true; });
  const request = connection.sent[0];
  assert.equal(request.method, 'Page.getFrameTree');
  assert.equal(request.sessionId, 'page-session');
  setImmediate(() => {
    connection.handlers.message(JSON.stringify({
      method: 'Runtime.consoleAPICalled',
      sessionId: 'page-session',
      params: { marker: 'later-transport-turn' },
    }));
    setImmediate(() => {
      connection.handlers.message(JSON.stringify({ id: request.id, result: {} }));
      resolveResponseSeen();
    });
  });

  await responseSeen;
  await Promise.resolve();
  assert.equal(barrierResolved, false);
  releaseHandler();

  await barrier;

  assert.deepEqual(delivered, ['later-transport-turn']);
  await client.close();
});

test('disconnects before a queued CDP event-count flood can execute', async () => {
  const connection = new FakeWebSocketConnection();
  const client = new CdpClient(connection);
  let releaseHandler;
  const blocked = new Promise((resolve) => { releaseHandler = resolve; });
  let delivered = 0;
  client.on('Runtime.consoleAPICalled', async () => {
    delivered += 1;
    await blocked;
  });

  for (let index = 0; index < 1100; index += 1) {
    connection.handlers.message(JSON.stringify({
      method: 'Runtime.consoleAPICalled',
      params: { index },
    }));
  }
  await new Promise((resolve) => setImmediate(resolve));
  const closeCalls = connection.closeCalls;
  releaseHandler();
  await assert.rejects(client.flushEvents(), { code: 'CDP_EVENT_QUEUE_OVERFLOW' });
  assert.equal(closeCalls, 1);
  assert.equal(delivered, 0);
  await assert.rejects(client.send('Runtime.evaluate'), { code: 'CDP_EVENT_QUEUE_OVERFLOW' });
  await client.close();
});

test('disconnects before a queued CDP event-byte flood can execute', async () => {
  const connection = new FakeWebSocketConnection();
  const client = new CdpClient(connection);
  let releaseHandler;
  const blocked = new Promise((resolve) => { releaseHandler = resolve; });
  let delivered = 0;
  client.on('Runtime.consoleAPICalled', async () => {
    delivered += 1;
    await blocked;
  });
  const large = 'x'.repeat(1024 * 1024);

  for (let index = 0; index < 9; index += 1) {
    connection.handlers.message(JSON.stringify({
      method: 'Runtime.consoleAPICalled',
      params: { index, large },
    }));
  }
  await new Promise((resolve) => setImmediate(resolve));
  const closeCalls = connection.closeCalls;
  releaseHandler();
  await assert.rejects(client.flushEvents(), { code: 'CDP_EVENT_QUEUE_OVERFLOW' });
  assert.equal(closeCalls, 1);
  assert.equal(delivered, 0);
  await client.close();
});
