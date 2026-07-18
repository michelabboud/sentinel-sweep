import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CdpClient } from '../../runtime/browser/cdp.mjs';
import { resolveChromeExecutable } from '../../runtime/browser/chrome.mjs';
import { sweepBrowser } from '../../runtime/browser/sweep.mjs';
import { RunBoundary, TargetBoundary } from '../../runtime/lib/fs-boundary.mjs';
import { buildExecutionPlan } from '../../runtime/policy/execution.mjs';

const ADMIN_TOKEN = 'sentinel-browser-admin-secret';
const USER_TOKEN = 'sentinel-browser-user-secret';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

function html(title, body = '') {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><link rel="icon" href="data:,"></head><body>${body}</body></html>`;
}

async function startBrowserFixture(t) {
  const receiverRequests = [];
  const approvedRequests = [];
  const mutations = {
    post: 0,
    delete: 0,
    websocket: 0,
    serviceWorker: 0,
    worker: 0,
    sharedWorker: 0,
    framePost: 0,
    frameDelete: 0,
    popup: 0,
  };
  const receiver = createServer((request, response) => {
    receiverRequests.push({
      path: request.url,
      hasAuthorization: typeof request.headers.authorization === 'string',
    });
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(html('Receiver'));
  });
  await listen(receiver);
  const receiverAddress = receiver.address();
  assert.ok(receiverAddress && typeof receiverAddress === 'object');
  const receiverOrigin = `http://127.0.0.1:${receiverAddress.port}`;

  const approved = createServer((request, response) => {
    const requested = new URL(request.url, 'http://fixture.invalid');
    approvedRequests.push({
      path: requested.pathname,
      authorization: request.headers.authorization ?? null,
    });
    if (requested.pathname === '/service-worker.js') {
      response.writeHead(200, {
        'content-type': 'text/javascript; charset=utf-8',
        'cache-control': 'no-store',
        'service-worker-allowed': '/',
      });
      response.end('self.addEventListener("install", () => { fetch("/sw-mutate", { method: "POST" }).catch(() => {}); });');
      return;
    }
    if (requested.pathname === '/worker.js') {
      response.writeHead(200, {
        'content-type': 'text/javascript; charset=utf-8',
        'cache-control': 'no-store',
      });
      response.end('fetch("/worker-mutate", { method: "POST" }).catch(() => {});');
      return;
    }
    if (requested.pathname === '/shared-worker.js') {
      response.writeHead(200, {
        'content-type': 'text/javascript; charset=utf-8',
        'cache-control': 'no-store',
      });
      response.end('fetch("/shared-worker-mutate", { method: "POST" }).catch(() => {});');
      return;
    }
    if (requested.pathname === '/sw-mutate' && request.method === 'POST') {
      mutations.serviceWorker += 1;
      response.writeHead(204);
      response.end();
      return;
    }
    if (requested.pathname === '/worker-mutate' && request.method === 'POST') {
      mutations.worker += 1;
      response.writeHead(204);
      response.end();
      return;
    }
    if (requested.pathname === '/shared-worker-mutate' && request.method === 'POST') {
      mutations.sharedWorker += 1;
      response.writeHead(204);
      response.end();
      return;
    }
    if (requested.pathname === '/frame-mutate' && request.method === 'POST') {
      mutations.framePost += 1;
      response.writeHead(204);
      response.end();
      return;
    }
    if (requested.pathname === '/frame-mutate' && request.method === 'DELETE') {
      mutations.frameDelete += 1;
      response.writeHead(204);
      response.end();
      return;
    }
    if (requested.pathname === '/popup-mutate' && request.method === 'POST') {
      mutations.popup += 1;
      response.writeHead(204);
      response.end();
      return;
    }
    if (requested.pathname === '/mutate' && request.method === 'POST') {
      mutations.post += 1;
      response.writeHead(204);
      response.end();
      return;
    }
    if (requested.pathname === '/mutate' && request.method === 'DELETE') {
      mutations.delete += 1;
      response.writeHead(204);
      response.end();
      return;
    }
    if (requested.pathname === '/broken-resource') {
      request.socket.destroy();
      return;
    }
    if (requested.pathname === '/cross') {
      response.writeHead(302, { location: `${receiverOrigin}/must-not-receive` });
      response.end();
      return;
    }
    if (requested.pathname === '/frame-child') {
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      });
      response.end(html(
        'Frame child',
        '<script>fetch("/frame-mutate", { method: "POST" }).catch(() => {}); fetch("/frame-mutate", { method: "DELETE" }).catch(() => {})</script>',
      ));
      return;
    }
    if (requested.pathname === '/slow-navigation') {
      setTimeout(() => {
        if (response.destroyed) return;
        response.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
        });
        response.end(html('Slow navigation', '<main>late</main>'));
      }, 3000).unref?.();
      return;
    }

    let status = 200;
    let body;
    if (requested.pathname === '/protected-redirect') {
      if (request.headers.authorization === `Bearer ${ADMIN_TOKEN}`) {
        response.writeHead(302, {
          location: `${receiverOrigin}/protected-must-not-receive`,
          'cache-control': 'no-store',
        });
        response.end();
        return;
      }
      if (request.headers.authorization === `Bearer ${USER_TOKEN}`) {
        status = 403;
        body = html('Forbidden', '<main>forbidden</main>');
      } else {
        status = 401;
        body = html('Unauthorized', '<main>unauthorized</main>');
      }
    } else if (requested.pathname === '/auth-visual') {
      if (request.headers.authorization === `Bearer ${ADMIN_TOKEN}`) {
        body = html(
          'Authenticated failure',
          `<main>${ADMIN_TOKEN}</main><script>console.error("authenticated visual failure")</script>`,
        );
      } else if (request.headers.authorization === `Bearer ${USER_TOKEN}`) {
        status = 403;
        body = html('Forbidden', '<main>forbidden</main>');
      } else {
        status = 401;
        body = html('Unauthorized', '<main>unauthorized</main>');
      }
    } else if (requested.pathname === '/protected') {
      if (request.headers.authorization === `Bearer ${ADMIN_TOKEN}`) {
        body = html('Admin', '<main>admin</main>');
      } else if (request.headers.authorization === `Bearer ${USER_TOKEN}`) {
        status = 403;
        body = html('Forbidden', '<main>forbidden</main>');
      } else {
        status = 401;
        body = html('Unauthorized', '<main>unauthorized</main>');
      }
    } else if (requested.pathname === '/ok') {
      body = html('Ready', '<main>ready</main>');
    } else if (requested.pathname === '/console') {
      body = html('Console', '<script>console.error("target console body must not escape")</script>');
    } else if (requested.pathname === '/exception') {
      body = html('Exception', '<script>setTimeout(() => { throw new Error("target exception body must not escape"); }, 0)</script>');
    } else if (requested.pathname === '/network') {
      body = html('Network', '<img src="/broken-resource" alt="broken">');
    } else if (requested.pathname === '/overflow') {
      body = html('Overflow', '<div style="width:700px;height:10px">wide</div>');
    } else if (requested.pathname === '/delayed-defect') {
      body = html(
        'Delayed defect',
        '<script>setTimeout(() => { console.error("delayed defect"); const node = document.createElement("div"); node.style.width = "700px"; node.style.height = "10px"; node.textContent = "wide"; document.body.append(node); }, 350)</script>',
      );
    } else if (requested.pathname === '/empty') {
      body = html('Empty', '<main id="empty"></main>');
    } else if (requested.pathname === '/internal-nav') {
      body = html('Internal navigation', '<script>setTimeout(() => { location.href = "about:blank"; }, 0)</script>');
    } else if (requested.pathname === '/mutation') {
      body = html('Mutation', '<script>fetch("/mutate", { method: "POST" }).catch(() => {}); fetch("/mutate", { method: "DELETE" }).catch(() => {})</script>');
    } else if (requested.pathname === '/websocket') {
      body = html('WebSocket', '<script>new WebSocket("ws://" + location.host + "/socket")</script>');
    } else if (requested.pathname === '/service-worker') {
      body = html('Service worker', '<script>navigator.serviceWorker.register("/service-worker.js").catch(() => {})</script>');
    } else if (requested.pathname === '/worker') {
      body = html('Worker', '<script>new Worker("/worker.js")</script>');
    } else if (requested.pathname === '/shared-worker') {
      body = html('Shared worker', '<script>new SharedWorker("/shared-worker.js")</script>');
    } else if (requested.pathname === '/frame-mutation') {
      body = html('Frame mutation', '<iframe src="/frame-child"></iframe>');
    } else if (requested.pathname === '/cross-frame') {
      body = html('Cross frame', `<iframe src="${receiverOrigin}/frame-must-not-receive"></iframe>`);
    } else if (requested.pathname === '/popup') {
      body = html(
        'Popup',
        '<a id="open-child" href="/popup-child" target="_blank">open</a><script>document.querySelector("#open-child").click()</script>',
      );
    } else if (requested.pathname === '/popup-child') {
      body = html('Popup child', '<script>fetch("/popup-mutate", { method: "POST" }).catch(() => {})</script>');
    } else {
      status = 404;
      body = html('Missing');
    }
    response.writeHead(status, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    });
    response.end(body);
  });
  approved.on('upgrade', (_request, socket) => {
    mutations.websocket += 1;
    socket.destroy();
  });
  await listen(approved);
  const address = approved.address();
  assert.ok(address && typeof address === 'object');

  t.after(async () => {
    await Promise.all([closeServer(approved), closeServer(receiver)]);
  });
  return {
    origin: `http://127.0.0.1:${address.port}`,
    receiverOrigin,
    approvedRequests,
    receiverRequests,
    mutations,
  };
}

function route(name, overrides = {}) {
  return {
    id: `route:/${name}`,
    path: `/${name}`,
    name,
    component: null,
    aliases: [],
    auth: { state: 'public', allowedRoles: [] },
    parameters: [],
    provenance: {
      adapter: 'vue-router-static',
      file: 'src/router.js',
      pointer: `/routes/${name}`,
    },
    ...overrides,
  };
}

function browserManifest(routes) {
  return { routes, operations: [], schemas: {} };
}

function browserConfig(origin, chromePath, overrides = {}) {
  return {
    approvedOrigins: [origin],
    services: [{ name: 'web', approvedOrigin: origin, sourcePath: '.' }],
    roles: {
      admin: { tokenRef: 'env:SENTINEL_BROWSER_ADMIN_TOKEN' },
      user: { tokenRef: 'env:SENTINEL_BROWSER_USER_TOKEN' },
    },
    allowNonLoopback: false,
    responseTimeoutMs: 5000,
    browserSettleMs: 500,
    viewports: [375],
    emptyContainerSelectors: ['#empty'],
    screenshotOnError: true,
    chromePath,
    maxConcurrency: 1,
    ...overrides,
  };
}

async function findChromeOrSkip(t) {
  try {
    return await resolveChromeExecutable({});
  } catch (error) {
    if (error?.code === 'CHROME_NOT_FOUND'
        && process.env.SENTINEL_ALLOW_MISSING_CHROME_FOR_UNIT_TESTS === '1') {
      t.skip('System Chrome is unavailable and the explicit unit-test skip is enabled');
      return null;
    }
    throw error;
  }
}

function observationFor(observations, subjectId, reasonCode, role = null) {
  return observations.find((entry) => (
    entry.subjectId === subjectId
      && entry.reasonCode === reasonCode
      && entry.role === role
  ));
}

async function pngFiles(root) {
  return (await readdir(root)).filter((name) => name.endsWith('.png')).sort();
}

async function createBrowserBoundaries(temporary) {
  const targetRoot = path.join(temporary, 'target');
  await mkdir(targetRoot);
  return {
    runBoundary: await RunBoundary.create(path.join(temporary, 'run')),
    targetBoundary: await TargetBoundary.create(targetRoot),
  };
}

test('runs real browser/RBAC/console/network/layout checks without leaking origins or credentials', async (t) => {
  const chromePath = await findChromeOrSkip(t);
  if (chromePath === null) return;
  const fixture = await startBrowserFixture(t);
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'sentinel-browser-sweep-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const { runBoundary, targetBoundary } = await createBrowserBoundaries(temporary);
  const routes = [
    route('ok'),
    route('protected', { auth: { state: 'required', allowedRoles: ['admin'] } }),
    route('protected-redirect', { auth: { state: 'required', allowedRoles: ['admin'] } }),
    route('console'),
    route('exception'),
    route('network'),
    route('cross'),
    route('overflow'),
    route('delayed-defect'),
    route('empty'),
    route('internal-nav'),
    route('mutation'),
    route('websocket'),
    route('service-worker'),
    route('worker'),
    route('shared-worker'),
    route('frame-mutation'),
    route('cross-frame'),
    route('popup'),
    route('auth-visual', { auth: { state: 'required', allowedRoles: ['admin'] } }),
  ];
  const manifest = browserManifest(routes);
  const config = browserConfig(fixture.origin, chromePath);
  const plan = buildExecutionPlan({
    manifest,
    config,
    mode: 'browser',
    sandboxAcknowledged: false,
  });
  const observations = await sweepBrowser({
    manifest,
    plan,
    config,
    env: {
      SENTINEL_BROWSER_ADMIN_TOKEN: ADMIN_TOKEN,
      SENTINEL_BROWSER_USER_TOKEN: USER_TOKEN,
    },
    runBoundary,
    targetBoundary,
  });

  const ready = observationFor(observations, 'route:/ok', 'DOCUMENT_STATUS_EXPECTED');
  assert.ok(ready, JSON.stringify(observations));
  assert.equal(ready.outcome, 'pass');
  assert.equal(ready.evidence.status, 200);

  const unauthenticated = observationFor(
    observations,
    'route:/protected',
    'RBAC_DENIAL_EXPECTED',
  );
  const lowerPrivilege = observationFor(
    observations,
    'route:/protected',
    'RBAC_DENIAL_EXPECTED',
    'user',
  );
  const authorized = observationFor(
    observations,
    'route:/protected',
    'DOCUMENT_STATUS_EXPECTED',
    'admin',
  );
  assert.equal(unauthenticated.evidence.status, 401);
  assert.equal(lowerPrivilege.evidence.status, 403);
  assert.equal(authorized.evidence.status, 200);
  const protectedRedirect = observationFor(
    observations,
    'route:/protected-redirect',
    'NAVIGATION_ORIGIN_BLOCKED',
    'admin',
  );
  assert.equal(protectedRedirect.category, 'security');
  assert.ok(fixture.approvedRequests.some((request) => (
    request.path === '/protected-redirect'
      && request.authorization === `Bearer ${ADMIN_TOKEN}`
  )));

  assert.equal(observationFor(observations, 'route:/console', 'CONSOLE_ERROR').outcome, 'fail');
  assert.equal(observationFor(observations, 'route:/exception', 'UNCAUGHT_EXCEPTION').outcome, 'fail');
  assert.equal(observationFor(observations, 'route:/network', 'RESOURCE_LOAD_FAILED').outcome, 'fail');
  const blockedNavigation = observationFor(
    observations,
    'route:/cross',
    'NAVIGATION_ORIGIN_BLOCKED',
  );
  assert.ok(blockedNavigation, JSON.stringify(observations));
  assert.equal(blockedNavigation.category, 'security');
  assert.equal(observationFor(observations, 'route:/overflow', 'HORIZONTAL_OVERFLOW').evidence.viewport, 375);
  assert.equal(
    observationFor(observations, 'route:/delayed-defect', 'CONSOLE_ERROR').outcome,
    'fail',
  );
  const delayedOverflow = observationFor(
    observations,
    'route:/delayed-defect',
    'HORIZONTAL_OVERFLOW',
  );
  assert.ok(delayedOverflow, JSON.stringify(
    observations.filter((entry) => entry.subjectId === 'route:/delayed-defect'),
  ));
  assert.equal(delayedOverflow.outcome, 'fail');
  assert.equal(observationFor(observations, 'route:/empty', 'EMPTY_CONTAINER').outcome, 'fail');
  assert.equal(
    observationFor(observations, 'route:/internal-nav', 'NAVIGATION_ORIGIN_BLOCKED').category,
    'security',
  );
  assert.equal(
    observationFor(observations, 'route:/mutation', 'BROWSER_MUTATION_BLOCKED').category,
    'security',
  );
  const blockedWebSocket = observationFor(
    observations,
    'route:/websocket',
    'BROWSER_WEBSOCKET_BLOCKED',
  );
  assert.ok(blockedWebSocket, JSON.stringify(observations));
  assert.equal(blockedWebSocket.category, 'security');
  const blockedServiceWorker = observationFor(
    observations,
    'route:/service-worker',
    'SERVICE_WORKER_BLOCKED',
  );
  assert.ok(blockedServiceWorker, JSON.stringify({ observations, mutations: fixture.mutations }));
  assert.equal(blockedServiceWorker.category, 'security');
  const blockedWorker = observationFor(
    observations,
    'route:/worker',
    'WORKER_BLOCKED',
  );
  assert.ok(blockedWorker, JSON.stringify({
    observations: observations.filter((entry) => entry.subjectId === 'route:/worker'),
    mutations: fixture.mutations,
  }));
  assert.equal(blockedWorker.category, 'security');
  const blockedSharedWorker = observationFor(
    observations,
    'route:/shared-worker',
    'WORKER_BLOCKED',
  );
  assert.ok(blockedSharedWorker, JSON.stringify({
    observations: observations.filter((entry) => entry.subjectId === 'route:/shared-worker'),
    mutations: fixture.mutations,
  }));
  assert.equal(blockedSharedWorker.category, 'security');
  const blockedFrameMutation = observationFor(
    observations,
    'route:/frame-mutation',
    'FRAME_MUTATION_BLOCKED',
  );
  assert.ok(blockedFrameMutation, JSON.stringify({
    observations: observations.filter((entry) => entry.subjectId === 'route:/frame-mutation'),
    mutations: fixture.mutations,
  }));
  assert.equal(blockedFrameMutation.category, 'security');
  assert.equal(
    observationFor(observations, 'route:/cross-frame', 'NAVIGATION_ORIGIN_BLOCKED').category,
    'security',
  );
  const blockedPopup = observationFor(
    observations,
    'route:/popup',
    'UNEXPECTED_TARGET_BLOCKED',
  );
  assert.ok(blockedPopup, JSON.stringify({
    observations: observations.filter((entry) => entry.subjectId === 'route:/popup'),
    mutations: fixture.mutations,
  }));
  assert.equal(blockedPopup.category, 'security');
  const authenticatedFailure = observationFor(
    observations,
    'route:/auth-visual',
    'CONSOLE_ERROR',
    'admin',
  );
  assert.equal(authenticatedFailure.outcome, 'fail');
  assert.equal(authenticatedFailure.evidence.screenshotPath, null);
  assert.equal(
    fixture.mutations.serviceWorker,
    0,
    'service-worker installation must not reach the mutation endpoint',
  );
  assert.deepEqual(fixture.mutations, {
    post: 0,
    delete: 0,
    websocket: 0,
    serviceWorker: 0,
    worker: 0,
    sharedWorker: 0,
    framePost: 0,
    frameDelete: 0,
    popup: 0,
  });
  assert.equal(fixture.receiverRequests.length, 0);

  const screenshots = await pngFiles(runBoundary.root);
  const observedScreenshotPaths = [...new Set(
    observations
      .map((entry) => entry.evidence.screenshotPath)
      .filter((value) => typeof value === 'string'),
  )].sort();
  assert.deepEqual(screenshots, observedScreenshotPaths);
  for (const name of screenshots) {
    const bytes = await readFile(path.join(runBoundary.root, name));
    assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  }
  for (const entry of observations.filter((candidate) => (
    candidate.outcome === 'fail' && candidate.role === null
  ))) {
    if (entry.evidence.screenshotPath !== null) {
      assert.ok(entry.evidence.screenshotPath.endsWith('.png'));
      continue;
    }
    assert.ok(observations.some((candidate) => (
      candidate.subjectId === entry.subjectId
        && candidate.role === entry.role
        && candidate.evidence.viewport === entry.evidence.viewport
        && candidate.reasonCode === 'SCREENSHOT_CAPTURE_FAILED'
    )), JSON.stringify(entry));
  }
  assert.ok(observations.filter((entry) => entry.role !== null)
    .every((entry) => entry.evidence.screenshotPath === null));
  assert.ok(observations.filter((entry) => entry.outcome !== 'fail')
    .every((entry) => entry.evidence.screenshotPath === null));

  for (const entry of observations) {
    assert.ok(Object.isFrozen(entry));
    assert.ok(Object.isFrozen(entry.evidence));
    assert.equal(entry.source, 'browser');
  }
  const severityOrder = new Map([
    ['critical', 0], ['error', 1], ['warning', 2], ['info', 3],
  ]);
  const outcomeOrder = new Map([['fail', 0], ['skip', 1], ['pass', 2]]);
  const sorted = [...observations].sort((left, right) => (
    left.subjectId.localeCompare(right.subjectId)
      || (left.role ?? '').localeCompare(right.role ?? '')
      || (left.evidence.viewport ?? 0) - (right.evidence.viewport ?? 0)
      || severityOrder.get(left.severity) - severityOrder.get(right.severity)
      || outcomeOrder.get(left.outcome) - outcomeOrder.get(right.outcome)
      || left.category.localeCompare(right.category)
      || left.reasonCode.localeCompare(right.reasonCode)
  ));
  assert.deepEqual(observations, sorted);
  const serialized = JSON.stringify(observations);
  assert.equal(serialized.includes(ADMIN_TOKEN), false);
  assert.equal(serialized.includes(USER_TOKEN), false);
  assert.equal(serialized.includes(fixture.origin), false);
  assert.equal(serialized.includes(fixture.receiverOrigin), false);
  assert.equal(serialized.includes('<html'), false);
  assert.equal(serialized.includes('target console body'), false);
  assert.equal(serialized.includes('target exception body'), false);
  assert.equal(serialized.includes(chromePath), false);
});

test('does not create screenshots when screenshot-on-error is disabled', async (t) => {
  const chromePath = await findChromeOrSkip(t);
  if (chromePath === null) return;
  const fixture = await startBrowserFixture(t);
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'sentinel-browser-no-shot-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const { runBoundary, targetBoundary } = await createBrowserBoundaries(temporary);
  const manifest = browserManifest([route('console')]);
  const config = browserConfig(fixture.origin, chromePath, { screenshotOnError: false });
  const plan = buildExecutionPlan({ manifest, config, mode: 'browser' });

  const observations = await sweepBrowser({
    manifest,
    plan,
    config,
    env: {},
    runBoundary,
    targetBoundary,
  });

  assert.equal(observationFor(observations, 'route:/console', 'CONSOLE_ERROR').outcome, 'fail');
  assert.deepEqual(await pngFiles(runBoundary.root), []);
  assert.ok(observations.every((entry) => entry.evidence.screenshotPath === null));
});

test('retains earlier findings when CDP screenshot capture fails', async (t) => {
  const chromePath = await findChromeOrSkip(t);
  if (chromePath === null) return;
  const fixture = await startBrowserFixture(t);
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'sentinel-browser-shot-failure-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const { runBoundary, targetBoundary } = await createBrowserBoundaries(temporary);
  const manifest = browserManifest([route('console')]);
  const config = browserConfig(fixture.origin, chromePath);
  const plan = buildExecutionPlan({ manifest, config, mode: 'browser' });
  const connect = CdpClient.connect;
  CdpClient.connect = async (...args) => {
    const client = await connect.call(CdpClient, ...args);
    const send = client.send.bind(client);
    client.send = (method, ...sendArgs) => {
      if (method === 'Page.captureScreenshot') {
        return Promise.reject(new Error('injected screenshot capture failure'));
      }
      return send(method, ...sendArgs);
    };
    return client;
  };
  t.after(() => { CdpClient.connect = connect; });

  const observations = await sweepBrowser({
    manifest,
    plan,
    config,
    runBoundary,
    targetBoundary,
  });

  const consoleFailure = observationFor(observations, 'route:/console', 'CONSOLE_ERROR');
  const captureFailure = observationFor(
    observations,
    'route:/console',
    'SCREENSHOT_CAPTURE_FAILED',
  );
  assert.equal(consoleFailure.outcome, 'fail');
  assert.equal(captureFailure.outcome, 'fail');
  assert.equal(consoleFailure.evidence.screenshotPath, null);
  assert.equal(captureFailure.evidence.screenshotPath, null);
  assert.deepEqual(await pngFiles(runBoundary.root), []);
});

test('requires a trusted TargetBoundary and ignores a forged manifest target root', async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'sentinel-browser-boundary-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const targetRoot = path.join(temporary, 'target');
  const forgedRoot = path.join(temporary, 'forged-safe-root');
  const runRoot = path.join(temporary, 'run');
  await Promise.all([mkdir(targetRoot), mkdir(forgedRoot)]);
  const fakeChrome = path.join(targetRoot, 'chrome');
  await writeFile(fakeChrome, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  await chmod(fakeChrome, 0o700);
  const targetBoundary = await TargetBoundary.create(targetRoot);
  const runBoundary = await RunBoundary.create(runRoot);
  const manifest = {
    ...browserManifest([]),
    target: { root: forgedRoot },
  };
  const config = browserConfig('http://127.0.0.1:1', fakeChrome, {
    responseTimeoutMs: 500,
    browserSettleMs: 100,
  });
  const plan = buildExecutionPlan({ manifest, config, mode: 'browser' });

  await assert.rejects(
    sweepBrowser({ manifest, plan, config, runBoundary, targetBoundary }),
    { code: 'CHROME_TARGET_LOCAL' },
  );
  await assert.rejects(
    sweepBrowser({ manifest, plan, config, runBoundary }),
    { code: 'BROWSER_TARGET_BOUNDARY_INVALID' },
  );
});

test('cleans up a timed-out attempt and continues with the next route', async (t) => {
  const chromePath = await findChromeOrSkip(t);
  if (chromePath === null) return;
  const fixture = await startBrowserFixture(t);
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'sentinel-browser-timeout-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const { runBoundary, targetBoundary } = await createBrowserBoundaries(temporary);
  const manifest = browserManifest([route('slow-navigation'), route('ok')]);
  const config = browserConfig(fixture.origin, chromePath, {
    responseTimeoutMs: 600,
    browserSettleMs: 100,
    screenshotOnError: false,
  });
  const plan = buildExecutionPlan({ manifest, config, mode: 'browser' });
  const startedAt = performance.now();

  const observations = await sweepBrowser({
    manifest,
    plan,
    config,
    runBoundary,
    targetBoundary,
  });

  assert.ok(performance.now() - startedAt < 2500, JSON.stringify(observations));
  assert.equal(
    observationFor(observations, 'route:/slow-navigation', 'BROWSER_TIMEOUT').outcome,
    'fail',
  );
  assert.equal(
    observationFor(observations, 'route:/ok', 'DOCUMENT_STATUS_EXPECTED').outcome,
    'pass',
  );
});

test('rejects the sweep when timeout cleanup cannot restore CDP state', async (t) => {
  const chromePath = await findChromeOrSkip(t);
  if (chromePath === null) return;
  const fixture = await startBrowserFixture(t);
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'sentinel-browser-cleanup-failure-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const { runBoundary, targetBoundary } = await createBrowserBoundaries(temporary);
  const manifest = browserManifest([route('slow-navigation'), route('ok')]);
  const config = browserConfig(fixture.origin, chromePath, {
    responseTimeoutMs: 600,
    browserSettleMs: 100,
    screenshotOnError: false,
  });
  const plan = buildExecutionPlan({ manifest, config, mode: 'browser' });
  const connect = CdpClient.connect;
  CdpClient.connect = async (...args) => {
    const client = await connect.call(CdpClient, ...args);
    const send = client.send.bind(client);
    client.send = (method, ...sendArgs) => {
      if (method === 'Target.disposeBrowserContext') {
        return Promise.reject(new Error('injected cleanup failure'));
      }
      return send(method, ...sendArgs);
    };
    return client;
  };
  t.after(() => { CdpClient.connect = connect; });

  await assert.rejects(
    sweepBrowser({ manifest, plan, config, runBoundary, targetBoundary }),
    { code: 'BROWSER_ATTEMPT_CLEANUP_FAILED' },
  );
});

test('propagates screenshot artifact write failures as fatal run errors', async (t) => {
  const chromePath = await findChromeOrSkip(t);
  if (chromePath === null) return;
  const fixture = await startBrowserFixture(t);
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'sentinel-browser-artifact-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const boundaries = await createBrowserBoundaries(temporary);
  const manifest = browserManifest([route('console')]);
  const config = browserConfig(fixture.origin, chromePath);
  const plan = buildExecutionPlan({ manifest, config, mode: 'browser' });
  const rejectingRunBoundary = {
    root: boundaries.runBoundary.root,
    async writeBytes() { throw new Error('sentinel artifact write failed'); },
  };

  await assert.rejects(
    sweepBrowser({
      manifest,
      plan,
      config,
      runBoundary: rejectingRunBoundary,
      targetBoundary: boundaries.targetBoundary,
    }),
    /sentinel artifact write failed/u,
  );
});
