import http from 'node:http';

export const HTTP_REDIRECT_QUERY_CANARY = 'sentinel-api-redirect-query-secret';

function json(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'content-length': Buffer.byteLength(body),
    'content-type': 'application/json; charset=utf-8',
  });
  response.end(body);
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
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

export async function startHttpFixture({ adminToken, userToken, slowDelayMs = 150 }) {
  if (!Number.isInteger(slowDelayMs) || slowDelayMs < 1) {
    throw new TypeError('slowDelayMs must be a positive integer');
  }
  const receiverRequests = [];
  const approvedRequests = [];
  const mutations = { post: 0, delete: 0 };

  const receiver = http.createServer((request, response) => {
    receiverRequests.push({ ...request.headers });
    json(response, 200, { received: true });
  });
  const receiverOrigin = await listen(receiver);

  const approved = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://fixture.invalid');
    const authorization = request.headers.authorization;
    approvedRequests.push({
      method: request.method,
      path: url.pathname,
      headers: { ...request.headers },
    });

    if (request.method === 'GET' && url.pathname === '/public') {
      json(response, 200, { ok: true });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/public-login-redirect') {
      response.writeHead(302, {
        location: `/login?token=${encodeURIComponent(HTTP_REDIRECT_QUERY_CANARY)}`,
      });
      response.end();
      return;
    }

    if (request.method === 'GET' && url.pathname === '/user') {
      if (authorization === undefined) {
        json(response, 401, { error: 'authentication required' });
      } else if (authorization === `Bearer ${userToken}`
          || authorization === `Bearer ${adminToken}`) {
        json(response, 200, { name: 'reader' });
      } else {
        json(response, 403, { error: 'forbidden' });
      }
      return;
    }

    if (request.method === 'GET' && url.pathname === '/admin') {
      if (authorization === undefined) {
        json(response, 401, { error: 'authentication required' });
      } else if (authorization === `Bearer ${adminToken}`) {
        json(response, 200, { healthy: true });
      } else {
        json(response, 403, { error: 'forbidden' });
      }
      return;
    }

    if (request.method === 'GET' && url.pathname === '/admin-login-redirect') {
      if (authorization === undefined) {
        json(response, 401, { error: 'authentication required' });
      } else if (authorization === `Bearer ${adminToken}`) {
        response.writeHead(302, { location: '/login' });
        response.end();
      } else {
        json(response, 403, { error: 'forbidden' });
      }
      return;
    }

    if (request.method === 'GET' && url.pathname === '/login') {
      json(response, 200, { login: true });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/drift') {
      json(response, 200, { healthy: 'yes' });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/json-text') {
      const body = '{"ok":true}';
      response.writeHead(200, {
        'content-length': Buffer.byteLength(body),
        'content-type': 'text/plain; charset=utf-8',
      });
      response.end(body);
      return;
    }

    if (request.method === 'GET' && url.pathname === '/json-malformed') {
      const body = '{"ok":';
      response.writeHead(200, {
        'content-length': Buffer.byteLength(body),
        'content-type': 'application/json',
      });
      response.end(body);
      return;
    }

    if (request.method === 'GET' && url.pathname === '/json-valid') {
      json(response, 200, { ok: true });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/json-problem') {
      const body = '{"problem":false}';
      response.writeHead(200, {
        'content-length': Buffer.byteLength(body),
        'content-type': 'application/problem+json; charset=utf-8',
      });
      response.end(body);
      return;
    }

    if (request.method === 'GET' && url.pathname === '/redirect/same') {
      response.writeHead(302, { location: '/public' });
      response.end();
      return;
    }

    if (request.method === 'GET' && url.pathname === '/redirect/cross') {
      response.writeHead(302, { location: `${receiverOrigin}/capture` });
      response.end();
      return;
    }

    if (request.method === 'GET' && url.pathname === '/slow') {
      const slowTimer = setTimeout(() => {
        if (!response.destroyed) json(response, 200, { ok: true });
      }, slowDelayMs);
      response.once('close', () => clearTimeout(slowTimer));
      return;
    }

    if (request.method === 'GET' && url.pathname === '/oversized') {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      response.write('{"payload":"');
      response.end(`${'x'.repeat(4096)}"}`);
      return;
    }

    if (request.method === 'POST' && url.pathname === '/post') {
      mutations.post += 1;
      json(response, 201, { created: true });
      return;
    }

    if (request.method === 'DELETE' && url.pathname === '/delete') {
      mutations.delete += 1;
      response.writeHead(204);
      response.end();
      return;
    }

    json(response, 404, { error: 'not found' });
  });

  try {
    const origin = await listen(approved);
    return {
      origin,
      receiverOrigin,
      receiverRequests,
      approvedRequests,
      mutations,
      async close() {
        await Promise.all([close(approved), close(receiver)]);
      },
    };
  } catch (error) {
    await close(receiver);
    throw error;
  }
}
