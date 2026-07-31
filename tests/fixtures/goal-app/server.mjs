import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PAGE_FILES = Object.freeze({
  '/ok': 'ok.html',
  '/console': 'console.html',
  '/network': 'network.html',
  '/overflow': 'overflow.html',
  '/empty': 'empty.html',
  '/internal-navigation': 'internal-navigation.html',
  '/page-mutations': 'page-mutations.html',
  '/worker': 'worker.html',
  '/shared-worker': 'shared-worker.html',
  '/service-worker': 'service-worker.html',
  '/popup': 'popup.html',
  '/frame-mutation': 'frame-mutation.html',
  '/cross-frame': 'cross-frame.html',
  '/page-websocket': 'page-websocket.html',
});

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      if (address === null || typeof address !== 'object') {
        reject(new Error('fixture server did not expose a TCP address'));
        return;
      }
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeIdleConnections?.();
  });
}

function json(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
    'content-type': 'application/json; charset=utf-8',
  });
  response.end(body);
}

function html(response, status, body) {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
    'content-type': 'text/html; charset=utf-8',
  });
  response.end(body);
}

function script(response, body) {
  response.writeHead(200, {
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
    'content-type': 'text/javascript; charset=utf-8',
    'service-worker-allowed': '/',
  });
  response.end(body);
}

function zeroCounters() {
  return {
    apiPost: 0,
    apiDelete: 0,
    pagePost: 0,
    pageDelete: 0,
    dedicatedWorkerMutation: 0,
    sharedWorkerMutation: 0,
    serviceWorkerMutation: 0,
    popupMutation: 0,
    framePost: 0,
    frameDelete: 0,
    internalNavigation: 0,
    pageWebSocket: 0,
    workerWebSocket: 0,
  };
}

function safeSnapshot(counters, receiver) {
  return {
    mutations: { ...counters },
    receiver: { ...receiver },
  };
}

/** Starts the dependency-free real HTTP target and its unapproved receiver. */
export async function startGoalApp({ root, adminToken, userToken } = {}) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) {
    throw new TypeError('goal fixture root must be absolute');
  }
  if (typeof adminToken !== 'string' || adminToken.length < 8
      || typeof userToken !== 'string' || userToken.length < 8
      || adminToken === userToken) {
    throw new TypeError('goal fixture credentials must be distinct non-trivial strings');
  }

  const counters = zeroCounters();
  const receiverCounters = { requests: 0, authorizationHeaders: 0 };
  const controlNonce = randomBytes(24).toString('hex');

  const receiver = http.createServer((request, response) => {
    receiverCounters.requests += 1;
    if (typeof request.headers.authorization === 'string') {
      receiverCounters.authorizationHeaders += 1;
    }
    json(response, 200, { received: true });
  });
  const receiverOrigin = await listen(receiver);

  const approved = http.createServer(async (request, response) => {
    const requested = new URL(request.url, 'http://fixture.invalid');
    const authorization = request.headers.authorization;

    if (request.method === 'GET'
        && requested.pathname === `/__sentinel-control/${controlNonce}`) {
      json(response, 200, safeSnapshot(counters, receiverCounters));
      return;
    }

    if (request.method === 'GET' && requested.pathname === '/api/public') {
      json(response, 200, { ok: true });
      return;
    }
    if (request.method === 'GET' && requested.pathname === '/api/user') {
      if (authorization === `Bearer ${userToken}`) json(response, 200, { name: 'user' });
      else json(response, authorization === undefined ? 401 : 403, { error: 'denied' });
      return;
    }
    if (request.method === 'GET' && requested.pathname === '/api/admin') {
      // Deliberate RBAC defect: the unauthenticated request is incorrectly accepted.
      if (authorization === undefined || authorization === `Bearer ${adminToken}`) {
        json(response, 200, { healthy: true });
      } else {
        json(response, 403, { error: 'denied' });
      }
      return;
    }
    if (request.method === 'GET' && requested.pathname === '/api/drift') {
      json(response, 200, { healthy: 'not-a-boolean' });
      return;
    }
    if (request.method === 'GET' && requested.pathname === '/api/cross-origin') {
      response.writeHead(302, { location: `${receiverOrigin}/api-must-not-receive` });
      response.end();
      return;
    }
    if (request.method === 'GET' && requested.pathname === '/api/malformed') {
      const body = '{"ok":';
      response.writeHead(200, {
        'cache-control': 'no-store',
        'content-length': Buffer.byteLength(body),
        'content-type': 'application/json',
      });
      response.end(body);
      return;
    }
    if (request.method === 'GET' && requested.pathname === '/api/oversized') {
      response.writeHead(200, {
        'cache-control': 'no-store',
        'content-type': 'application/json',
      });
      response.end(JSON.stringify({ ok: true, padding: 'x'.repeat(8192) }));
      return;
    }
    if (request.method === 'POST' && requested.pathname === '/api/items') {
      counters.apiPost += 1;
      json(response, 201, { id: 'created', name: 'created' });
      return;
    }
    if (request.method === 'DELETE' && requested.pathname === '/api/items/fixture-item') {
      counters.apiDelete += 1;
      response.writeHead(204);
      response.end();
      return;
    }

    if (request.method === 'GET' && requested.pathname === '/cross-origin') {
      response.writeHead(302, { location: `${receiverOrigin}/browser-must-not-receive` });
      response.end();
      return;
    }
    if (request.method === 'GET' && requested.pathname === '/admin') {
      if (authorization === `Bearer ${adminToken}`) {
        html(response, 200, await readFile(path.join(root, 'public/admin.html'), 'utf8'));
      } else {
        html(response, authorization === undefined ? 401 : 403, '<!doctype html><title>Denied</title><main>denied</main>');
      }
      return;
    }
    if (request.method === 'GET' && requested.pathname === '/auth-visual') {
      if (authorization === `Bearer ${adminToken}`) {
        const body = (await readFile(path.join(root, 'public/auth-visual.html'), 'utf8'))
          .replace('__ADMIN_TOKEN__', adminToken);
        html(response, 200, body);
      } else {
        html(response, authorization === undefined ? 401 : 403, '<!doctype html><title>Denied</title><main>denied</main>');
      }
      return;
    }

    if (request.method === 'GET' && Object.hasOwn(PAGE_FILES, requested.pathname)) {
      let body = await readFile(path.join(root, 'public', PAGE_FILES[requested.pathname]), 'utf8');
      body = body.replace('__RECEIVER_ORIGIN__', receiverOrigin);
      html(response, 200, body);
      return;
    }
    if (request.method === 'GET' && requested.pathname === '/broken-resource') {
      request.socket.destroy();
      return;
    }
    if (request.method === 'GET' && requested.pathname === '/dedicated-worker.js') {
      script(response, "fetch('/dedicated-worker-mutate', {method:'POST'}).catch(()=>{}); new WebSocket('ws://' + location.host + '/worker-socket')");
      return;
    }
    if (request.method === 'GET' && requested.pathname === '/shared-worker.js') {
      script(response, "fetch('/shared-worker-mutate', {method:'POST'}).catch(()=>{}); new WebSocket('ws://' + location.host + '/worker-socket')");
      return;
    }
    if (request.method === 'GET' && requested.pathname === '/service-worker.js') {
      script(response, "self.addEventListener('install', () => { fetch('/service-worker-mutate', {method:'POST'}).catch(()=>{}) })");
      return;
    }
    if (request.method === 'GET' && requested.pathname === '/popup-child') {
      html(response, 200, "<!doctype html><title>Popup child</title><script>fetch('/popup-mutate',{method:'POST'}).catch(()=>{})</script>");
      return;
    }
    if (request.method === 'GET' && requested.pathname === '/frame-child') {
      html(response, 200, "<!doctype html><title>Frame child</title><script>fetch('/frame-mutate',{method:'POST'}).catch(()=>{}); fetch('/frame-mutate',{method:'DELETE'}).catch(()=>{})</script>");
      return;
    }

    if (requested.pathname === '/page-mutate' && request.method === 'POST') counters.pagePost += 1;
    else if (requested.pathname === '/page-mutate' && request.method === 'DELETE') counters.pageDelete += 1;
    else if (requested.pathname === '/dedicated-worker-mutate' && request.method === 'POST') counters.dedicatedWorkerMutation += 1;
    else if (requested.pathname === '/shared-worker-mutate' && request.method === 'POST') counters.sharedWorkerMutation += 1;
    else if (requested.pathname === '/service-worker-mutate' && request.method === 'POST') counters.serviceWorkerMutation += 1;
    else if (requested.pathname === '/popup-mutate' && request.method === 'POST') counters.popupMutation += 1;
    else if (requested.pathname === '/frame-mutate' && request.method === 'POST') counters.framePost += 1;
    else if (requested.pathname === '/frame-mutate' && request.method === 'DELETE') counters.frameDelete += 1;
    else if (requested.pathname === '/internal-escape' && request.method === 'GET') counters.internalNavigation += 1;
    else {
      json(response, 404, { error: 'not found' });
      return;
    }
    response.writeHead(204);
    response.end();
  });

  approved.on('upgrade', (request, socket) => {
    if (request.url === '/worker-socket') counters.workerWebSocket += 1;
    else counters.pageWebSocket += 1;
    socket.destroy();
  });

  try {
    const origin = await listen(approved);
    return Object.freeze({
      origin,
      receiverOrigin,
      async readCounters() {
        const response = await fetch(`${origin}/__sentinel-control/${controlNonce}`);
        if (!response.ok) throw new Error('fixture control endpoint failed');
        return response.json();
      },
      async close() {
        await Promise.all([close(approved), close(receiver)]);
      },
    });
  } catch (error) {
    await close(receiver);
    throw error;
  }
}

const invokedPath = typeof process.argv[1] === 'string' ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const app = await startGoalApp({
    root,
    adminToken: process.env.SENTINEL_GOAL_ADMIN_TOKEN ?? '',
    userToken: process.env.SENTINEL_GOAL_USER_TOKEN ?? '',
  });
  process.stdout.write(`${app.origin}\n`);
  const closeOnSignal = async () => {
    await app.close();
    process.exitCode = 0;
  };
  process.once('SIGINT', closeOnSignal);
  process.once('SIGTERM', closeOnSignal);
}
