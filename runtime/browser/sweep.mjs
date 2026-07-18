import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';

import { SentinelError } from '../lib/errors.mjs';
import { TargetBoundary } from '../lib/fs-boundary.mjs';
import { parseApprovedOrigin, resolveRequestUrl } from '../lib/origin.mjs';
import { resolveSecret } from '../lib/secrets.mjs';
import { CdpClient } from './cdp.mjs';
import { launchChrome } from './chrome.mjs';

const RESERVED_CREDENTIAL_HEADERS = new Set([
  'authorization',
  'cookie',
  'proxy-authorization',
  'x-access-token',
  'x-api-key',
  'x-auth-token',
]);
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const SETTLE_QUIET_MS = 250;

const SEVERITY_ORDER = new Map([
  ['critical', 0],
  ['error', 1],
  ['warning', 2],
  ['info', 3],
]);

const OUTCOME_ORDER = new Map([
  ['fail', 0],
  ['skip', 1],
  ['pass', 2],
]);

const OVERFLOW_EXPRESSION = `(() => {
  const root = document.documentElement;
  const body = document.body;
  return Math.max(root ? root.scrollWidth : 0, body ? body.scrollWidth : 0) > window.innerWidth;
})()`;

const EMPTY_CONTAINER_FUNCTION = `function (selectors) {
  let empty = 0;
  let invalid = 0;
  for (const selector of selectors) {
    let nodes;
    try { nodes = this.querySelectorAll(selector); } catch { invalid += 1; continue; }
    for (const node of nodes) {
      const text = typeof node.textContent === 'string' ? node.textContent.trim() : '';
      if (text === '' && node.children.length === 0) empty += 1;
    }
  }
  return { empty, invalid };
}`;

const WEBSOCKET_GUARD_BINDING = '__sentinelWebSocketBlocked';
const WEBSOCKET_GUARD_MARKER = '__SENTINEL_BROWSER_WEBSOCKET_BLOCKED__';
const SERVICE_WORKER_GUARD_BINDING = '__sentinelServiceWorkerBlocked';
const SERVICE_WORKER_GUARD_MARKER = '__SENTINEL_BROWSER_SERVICE_WORKER_BLOCKED__';
const WORKER_GUARD_BINDING = '__sentinelWorkerBlocked';
const WORKER_GUARD_MARKER = '__SENTINEL_BROWSER_WORKER_BLOCKED__';
const TARGET_AUTO_ATTACH_FILTER = Object.freeze([
  { type: 'browser', exclude: true },
  {},
]);
const ROOT_AUTO_ATTACH_FILTER = Object.freeze([
  { type: 'browser', exclude: true },
  { type: 'page', exclude: true },
  {},
]);
const PAGE_TARGET_TYPES = new Set(['page', 'iframe']);
const CONTROLLED_TARGET_TYPES = new Set([
  'tab',
  'page',
  'iframe',
]);
const PAGE_GUARD_EXPRESSION = `(() => {
  const notify = globalThis.__sentinelWebSocketBlocked;
  const notifyServiceWorker = globalThis.__sentinelServiceWorkerBlocked;
  const notifyWorker = globalThis.__sentinelWorkerBlocked;
  class SentinelBlockedWebSocket {
    constructor() {
      try { notify(); } catch {}
      try { console.error('__SENTINEL_BROWSER_WEBSOCKET_BLOCKED__'); } catch {}
      throw new DOMException('Blocked by Sentinel browser policy', 'SecurityError');
    }
  }
  Object.defineProperty(globalThis, 'WebSocket', {
    value: SentinelBlockedWebSocket,
    configurable: false,
    writable: false,
  });
  class SentinelBlockedWorker {
    constructor() {
      try { notifyWorker(); } catch {}
      try { console.error('__SENTINEL_BROWSER_WORKER_BLOCKED__'); } catch {}
      throw new DOMException('Blocked by Sentinel browser policy', 'SecurityError');
    }
  }
  Object.defineProperty(globalThis, 'Worker', {
    value: SentinelBlockedWorker,
    configurable: false,
    writable: false,
  });
  Object.defineProperty(globalThis, 'SharedWorker', {
    value: SentinelBlockedWorker,
    configurable: false,
    writable: false,
  });
  const serviceWorkerPrototype = globalThis.ServiceWorkerContainer?.prototype;
  if (serviceWorkerPrototype && typeof serviceWorkerPrototype.register === 'function') {
    Object.defineProperty(serviceWorkerPrototype, 'register', {
      value: function sentinelBlockedServiceWorkerRegistration() {
        try { notifyServiceWorker(); } catch {}
        try { console.error('__SENTINEL_BROWSER_SERVICE_WORKER_BLOCKED__'); } catch {}
        return Promise.reject(
          new DOMException('Blocked by Sentinel browser policy', 'SecurityError'),
        );
      },
      configurable: false,
      writable: false,
    });
  }
})()`;

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function evidence(route, fields = {}) {
  return deepFreeze({
    path: typeof route?.path === 'string' ? route.path : '/',
    status: Number.isInteger(fields.status) ? fields.status : null,
    durationMs: typeof fields.durationMs === 'number' ? Math.max(0, fields.durationMs) : null,
    viewport: Number.isInteger(fields.viewport) ? fields.viewport : null,
    screenshotPath: typeof fields.screenshotPath === 'string' ? fields.screenshotPath : null,
  });
}

function observation(route, fields) {
  return deepFreeze({
    source: 'browser',
    subjectId: typeof route?.id === 'string' ? route.id : 'unknown-route',
    category: fields.category,
    severity: fields.severity,
    outcome: fields.outcome,
    role: fields.role ?? null,
    reasonCode: fields.reasonCode,
    message: fields.message,
    expected: fields.expected ?? null,
    actual: fields.actual ?? null,
    evidence: evidence(route, fields.evidence),
  });
}

function policySkip(route, decision) {
  return observation(route, {
    category: 'security',
    severity: 'info',
    outcome: 'skip',
    reasonCode: decision?.reasonCode ?? 'POLICY_DECISION_MISSING',
    message: 'Browser route was skipped by the execution policy',
    expected: 'policy approval',
    actual: decision?.reasonCode ?? 'missing decision',
  });
}

function resolveOrigin(config, originId) {
  if (originId === 'default'
      && Array.isArray(config?.approvedOrigins)
      && config.approvedOrigins.length === 1) {
    return config.approvedOrigins[0];
  }
  if (!Array.isArray(config?.services)) return null;
  const matches = config.services.filter((service) => service?.name === originId);
  return matches.length === 1 ? matches[0].approvedOrigin : null;
}

function configuredRoles(config) {
  if (config?.roles === null || typeof config?.roles !== 'object' || Array.isArray(config.roles)) {
    return [];
  }
  return Object.keys(config.roles).sort();
}

function attemptsFor(route, config) {
  if (route?.auth?.state === 'public') return [{ role: null, accessExpected: true }];
  const allowed = new Set(
    (Array.isArray(route?.auth?.allowedRoles) ? route.auth.allowedRoles : [])
      .filter((role) => typeof role === 'string' && role !== 'unauthenticated'),
  );
  const roles = [...new Set([...allowed, ...configuredRoles(config)])].sort();
  return [
    { role: null, accessExpected: false },
    ...roles.map((role) => ({ role, accessExpected: allowed.has(role) })),
  ];
}

function scalar(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function materializePath(route, parameterValues) {
  let result = route.path;
  for (const [key, value] of Object.entries(parameterValues ?? {})) {
    if (!key.startsWith('path:')) continue;
    result = result.split(`{${key.slice(5)}}`).join(encodeURIComponent(scalar(value)));
  }
  return result;
}

function roleCredential(config, role, env) {
  if (role === null) return { token: null };
  const tokenRef = config?.roles?.[role]?.tokenRef;
  if (typeof tokenRef !== 'string') return { error: 'ROLE_CREDENTIAL_UNCONFIGURED' };
  try {
    return { token: resolveSecret(tokenRef, env) };
  } catch (error) {
    return { error: error?.code ?? 'SECRET_UNAVAILABLE' };
  }
}

function requestHeaders(headers, token) {
  const result = [];
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (!RESERVED_CREDENTIAL_HEADERS.has(name.toLowerCase())) {
      result.push({ name, value: String(value) });
    }
  }
  if (token !== null) result.push({ name: 'Authorization', value: `Bearer ${token}` });
  return result;
}

function exactNetworkOrigin(value, approvedOrigin) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'internal';
    return url.origin === approvedOrigin ? 'approved' : 'blocked';
  } catch {
    return 'blocked';
  }
}

function recordOnce(records, fields) {
  if (!records.some((record) => record.reasonCode === fields.reasonCode)) records.push(fields);
}

function compareRecords(left, right) {
  return (SEVERITY_ORDER.get(left.severity) ?? 99) - (SEVERITY_ORDER.get(right.severity) ?? 99)
    || (OUTCOME_ORDER.get(left.outcome) ?? 99) - (OUTCOME_ORDER.get(right.outcome) ?? 99)
    || left.category.localeCompare(right.category)
    || left.reasonCode.localeCompare(right.reasonCode);
}

function compareObservations(left, right) {
  return left.subjectId.localeCompare(right.subjectId)
    || (left.role ?? '').localeCompare(right.role ?? '')
    || (left.evidence.viewport ?? 0) - (right.evidence.viewport ?? 0)
    || compareRecords(left, right);
}

function statusRecord(status, accessExpected) {
  if (!Number.isInteger(status)) {
    return {
      category: 'health', severity: 'error', outcome: 'fail',
      reasonCode: 'DOCUMENT_STATUS_UNAVAILABLE',
      message: 'Browser navigation did not produce a document response',
      expected: accessExpected ? 'successful document response' : '401 or 403',
      actual: 'no document status',
    };
  }
  if (!accessExpected) {
    if (status === 401 || status === 403) {
      return {
        category: 'rbac', severity: 'info', outcome: 'pass',
        reasonCode: 'RBAC_DENIAL_EXPECTED',
        message: 'Browser route denied an unauthorized role',
        expected: '401 or 403', actual: String(status),
      };
    }
    return {
      category: 'rbac', severity: status >= 200 && status < 300 ? 'critical' : 'error',
      outcome: 'fail',
      reasonCode: status >= 200 && status < 300 ? 'RBAC_ACCESS_GRANTED' : 'RBAC_DENIAL_NOT_PROVEN',
      message: 'Browser route did not prove the expected authorization denial',
      expected: '401 or 403', actual: String(status),
    };
  }
  if (status === 401 || status === 403) {
    return {
      category: 'rbac', severity: 'error', outcome: 'fail',
      reasonCode: 'RBAC_ACCESS_DENIED',
      message: 'Browser route denied an authorized role',
      expected: 'successful document response', actual: String(status),
    };
  }
  if (status >= 200 && status < 400) {
    return {
      category: 'health', severity: 'info', outcome: 'pass',
      reasonCode: 'DOCUMENT_STATUS_EXPECTED',
      message: 'Browser route returned an expected document status',
      expected: '200-399', actual: String(status),
    };
  }
  return {
    category: 'health', severity: 'error', outcome: 'fail',
    reasonCode: 'DOCUMENT_STATUS_UNEXPECTED',
    message: 'Browser route returned an unexpected document status',
    expected: '200-399', actual: String(status),
  };
}

function screenshotName(route, role, viewport) {
  const identity = createHash('sha256')
    .update(`${route.id}\0${role ?? 'unauthenticated'}\0${viewport}`)
    .digest('hex')
    .slice(0, 24);
  return `browser-${identity}.png`;
}

function attemptTimeoutError() {
  return new SentinelError(
    'BROWSER_ATTEMPT_TIMEOUT',
    'Browser attempt exceeded its wall-clock deadline',
  );
}

class AttemptDeadline {
  constructor(timeoutMs) {
    this.expiresAt = performance.now() + timeoutMs;
    this.controller = new AbortController();
    this.timer = setTimeout(() => this.controller.abort(), timeoutMs);
    this.timer.unref?.();
  }

  get signal() { return this.controller.signal; }

  get expired() { return this.signal.aborted || performance.now() >= this.expiresAt; }

  remainingMs() {
    if (this.expired) throw attemptTimeoutError();
    return Math.max(1, Math.ceil(this.expiresAt - performance.now()));
  }

  send(client, method, params = {}, sessionId) {
    return client.send(method, params, sessionId, {
      timeoutMs: this.remainingMs(),
      signal: this.signal,
    });
  }

  flush(client) {
    this.remainingMs();
    return client.flushEvents({ signal: this.signal });
  }

  wait(milliseconds) {
    const bounded = Math.min(Math.max(0, milliseconds), this.remainingMs());
    if (bounded === 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let timer;
      const cleanup = () => {
        clearTimeout(timer);
        this.signal.removeEventListener('abort', onAbort);
      };
      const onAbort = () => {
        cleanup();
        reject(attemptTimeoutError());
      };
      timer = setTimeout(() => {
        cleanup();
        resolve();
      }, bounded);
      timer.unref?.();
      this.signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  race(promise) {
    this.remainingMs();
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        cleanup();
        reject(attemptTimeoutError());
      };
      const cleanup = () => this.signal.removeEventListener('abort', onAbort);
      this.signal.addEventListener('abort', onAbort, { once: true });
      Promise.resolve(promise).then(
        (value) => { cleanup(); resolve(value); },
        (error) => { cleanup(); reject(error); },
      );
    });
  }

  close() {
    clearTimeout(this.timer);
  }
}

async function waitForBrowserSettle({ client, deadline, inFlightRequests, activity }) {
  while (true) {
    await deadline.flush(client);
    const quietFor = performance.now() - activity.lastAt;
    if (inFlightRequests.size === 0 && quietFor >= SETTLE_QUIET_MS) {
      const version = activity.version;
      await deadline.flush(client);
      if (inFlightRequests.size === 0 && activity.version === version) return;
      continue;
    }
    const waitMs = inFlightRequests.size === 0
      ? SETTLE_QUIET_MS - quietFor
      : 25;
    await deadline.wait(Math.max(1, waitMs));
  }
}

async function runAttempt({
  client,
  route,
  decision,
  config,
  approvedOrigin,
  role,
  accessExpected,
  token,
  viewport,
  runBoundary,
}) {
  const startedAt = performance.now();
  const rawClient = client;
  const deadline = new AttemptDeadline(config.responseTimeoutMs);
  client = Object.freeze({
    flushEvents: () => deadline.flush(rawClient),
    on: (...args) => rawClient.on(...args),
    send: (method, params = {}, controlledSessionId) => (
      deadline.send(rawClient, method, params, controlledSessionId)
    ),
  });
  const records = [];
  const requestTypes = new Map();
  const inFlightRequests = new Set();
  const activity = { lastAt: performance.now(), version: 0 };
  const noteActivity = () => {
    activity.lastAt = performance.now();
    activity.version += 1;
  };
  let documentStatus = null;
  let blockedOrigin = false;
  let navigationStarted = false;
  let mainFrameId = null;
  let browserContextId;
  let targetId;
  let sessionId;
  let discoverTargetsEnabled = false;
  let rootAutoAttachEnabled = false;
  let attemptActive = true;
  let fatalError = null;
  let screenshotBytes = null;
  let screenshotPath = null;
  const controlledSessions = new Set();
  const sessionTargetIds = new Map();
  const sessionTargetTypes = new Map();
  const unsubscriptions = [];
  let settleNavigation;
  const navigationSettled = new Promise((resolve) => { settleNavigation = resolve; });
  let resolveMainSession;
  const mainSessionReady = new Promise((resolve) => { resolveMainSession = resolve; });

  try {
    ({ browserContextId } = await client.send('Target.createBrowserContext', {
      disposeOnDetach: true,
    }));
    await client.send('Browser.setDownloadBehavior', {
      behavior: 'deny',
      browserContextId,
    });

    const stopMainLoading = async () => {
      if (sessionId !== undefined) {
        await client.send('Page.stopLoading', {}, sessionId).catch(() => {});
      }
    };
    const closeControlledSession = async (controlledSessionId) => {
      const controlledTargetId = sessionTargetIds.get(controlledSessionId);
      if (controlledTargetId !== undefined && controlledTargetId !== targetId) {
        await client.send('Target.closeTarget', { targetId: controlledTargetId }).catch(() => {});
      }
    };
    const recordEventHandlerFailure = async (controlledSessionId) => {
      recordOnce(records, {
        category: 'runtime', severity: 'error', outcome: 'fail',
        reasonCode: 'BROWSER_EVENT_HANDLER_FAILED',
        message: 'Browser event processing failed inside the trusted runtime',
        expected: 'bounded browser event handling', actual: 'event handling failed',
      });
      await stopMainLoading();
      await closeControlledSession(controlledSessionId);
      settleNavigation('event-failed');
    };
    const scoped = (handler, { mainOnly = false } = {}) => async (params, metadata) => {
      const controlledSessionId = metadata.sessionId;
      if (!attemptActive
          || controlledSessionId === null
          || !controlledSessions.has(controlledSessionId)
          || (mainOnly && controlledSessionId !== sessionId)) return;
      noteActivity();
      try {
        await handler(params, controlledSessionId);
      } catch {
        await recordEventHandlerFailure(controlledSessionId);
      }
    };

    const configureControlledSession = async (
      controlledSessionId,
      targetType,
      { resume = false } = {},
    ) => {
      if (targetType === 'tab') {
        await client.send('Target.setAutoAttach', {
          autoAttach: true,
          waitForDebuggerOnStart: true,
          flatten: true,
          filter: TARGET_AUTO_ATTACH_FILTER,
        }, controlledSessionId);
        return;
      }
      await client.send('Fetch.enable', {
        patterns: [{ urlPattern: '*', requestStage: 'Request' }],
      }, controlledSessionId);
      await client.send('Network.enable', {}, controlledSessionId);
      await client.send('Network.setBypassServiceWorker', {
        bypass: true,
      }, controlledSessionId);
      await client.send('Network.setCacheDisabled', {
        cacheDisabled: true,
      }, controlledSessionId);
      await client.send('Network.setBlockedURLs', {
        urls: ['ws://*/*', 'wss://*/*'],
      }, controlledSessionId);
      await client.send('Runtime.enable', {}, controlledSessionId);
      if (PAGE_TARGET_TYPES.has(targetType)) {
        await client.send('Page.enable', {}, controlledSessionId);
        await client.send('Runtime.addBinding', {
          name: WEBSOCKET_GUARD_BINDING,
        }, controlledSessionId);
        await client.send('Runtime.addBinding', {
          name: SERVICE_WORKER_GUARD_BINDING,
        }, controlledSessionId);
        await client.send('Runtime.addBinding', {
          name: WORKER_GUARD_BINDING,
        }, controlledSessionId);
        await client.send('Page.addScriptToEvaluateOnNewDocument', {
          source: PAGE_GUARD_EXPRESSION,
        }, controlledSessionId);
      }
      await client.send('Target.setAutoAttach', {
        autoAttach: true,
        waitForDebuggerOnStart: true,
        flatten: true,
        filter: TARGET_AUTO_ATTACH_FILTER,
      }, controlledSessionId);
      if (resume) {
        await client.send('Runtime.runIfWaitingForDebugger', {}, controlledSessionId);
      }
    };

    unsubscriptions.push(client.on('Target.attachedToTarget', async (params, metadata) => {
      if (!attemptActive) return;
      noteActivity();
      const childSessionId = params?.sessionId;
      const targetInfo = params?.targetInfo;
      if (typeof childSessionId !== 'string'
          || childSessionId.length === 0
          || targetInfo === null
          || typeof targetInfo !== 'object') return;
      const parentControlled = metadata.sessionId !== null
        && controlledSessions.has(metadata.sessionId);
      const contextControlled = targetInfo.browserContextId === browserContextId;
      if (!parentControlled && !contextControlled) {
        await client.send('Runtime.runIfWaitingForDebugger', {}, childSessionId).catch(() => {});
        return;
      }

      const targetType = typeof targetInfo.type === 'string' ? targetInfo.type : 'unknown';
      if (targetType === 'worker' || targetType === 'shared_worker') {
        recordOnce(records, {
          category: 'security', severity: 'critical', outcome: 'fail',
          reasonCode: 'WORKER_BLOCKED',
          message: 'Browser closed a worker target before it could execute',
          expected: 'no page-initiated worker targets', actual: 'worker target attempted',
        });
        if (typeof targetInfo.targetId === 'string') {
          await client.send('Target.closeTarget', { targetId: targetInfo.targetId }).catch(() => {});
        }
        return;
      }
      if (targetType === 'service_worker') {
        recordOnce(records, {
          category: 'security', severity: 'critical', outcome: 'fail',
          reasonCode: 'SERVICE_WORKER_BLOCKED',
          message: 'Browser closed a service-worker target before it could execute',
          expected: 'no page-initiated service workers', actual: 'service worker target attempted',
        });
        if (typeof targetInfo.targetId === 'string') {
          await client.send('Target.closeTarget', { targetId: targetInfo.targetId }).catch(() => {});
        }
        return;
      }
      const mainPage = targetType === 'page'
        && (targetInfo.targetId === targetId || sessionId === undefined);
      if ((targetType === 'page' && !mainPage) || !CONTROLLED_TARGET_TYPES.has(targetType)) {
        recordOnce(records, {
          category: 'security', severity: 'critical', outcome: 'fail',
          reasonCode: 'UNEXPECTED_TARGET_BLOCKED',
          message: 'Browser closed an unexpected child target before it could execute',
          expected: 'no unexpected browser child targets', actual: 'unexpected target attempted',
        });
        if (typeof targetInfo.targetId === 'string') {
          await client.send('Target.closeTarget', { targetId: targetInfo.targetId }).catch(() => {});
        }
        const parentTargetId = metadata.sessionId === null
          ? undefined
          : sessionTargetIds.get(metadata.sessionId);
        if (parentTargetId !== undefined) {
          await client.send('Target.closeTarget', { targetId: parentTargetId }).catch(() => {});
        }
        return;
      }

      controlledSessions.add(childSessionId);
      sessionTargetTypes.set(childSessionId, targetType);
      if (typeof targetInfo.targetId === 'string') {
        sessionTargetIds.set(childSessionId, targetInfo.targetId);
      }
      if (mainPage) sessionId = childSessionId;
      try {
        await configureControlledSession(childSessionId, targetType, {
          resume: targetType !== 'tab',
        });
        if (metadata.sessionId !== null
            && sessionTargetTypes.get(metadata.sessionId) === 'tab'
            && targetType !== 'tab') {
          await client.send('Runtime.runIfWaitingForDebugger', {}, metadata.sessionId);
        }
        if (mainPage) resolveMainSession(childSessionId);
      } catch {
        recordOnce(records, {
          category: 'security', severity: 'critical', outcome: 'fail',
          reasonCode: 'BROWSER_TARGET_POLICY_FAILED',
          message: 'Browser closed a child target whose network policy could not be installed',
          expected: 'network policy before target execution', actual: 'target policy failed',
        });
        if (typeof targetInfo.targetId === 'string') {
          await client.send('Target.closeTarget', { targetId: targetInfo.targetId }).catch(() => {});
        }
        if (mainPage) resolveMainSession(null);
        settleNavigation('target-policy-failed');
      }
    }));
    unsubscriptions.push(client.on('Target.detachedFromTarget', async (params) => {
      if (!attemptActive) return;
      noteActivity();
      if (typeof params?.sessionId === 'string') {
        controlledSessions.delete(params.sessionId);
        sessionTargetIds.delete(params.sessionId);
        sessionTargetTypes.delete(params.sessionId);
      }
    }));

    unsubscriptions.push(client.on('Fetch.requestPaused', scoped(async (params, controlledSessionId) => {
      const method = typeof params?.request?.method === 'string'
        ? params.request.method.toUpperCase()
        : 'UNKNOWN';
      if (!READ_METHODS.has(method)) {
        const frameMutation = mainFrameId !== null
          && typeof params?.frameId === 'string'
          && params.frameId !== mainFrameId;
        recordOnce(records, {
          category: 'security', severity: 'critical', outcome: 'fail',
          reasonCode: frameMutation ? 'FRAME_MUTATION_BLOCKED' : 'BROWSER_MUTATION_BLOCKED',
          message: frameMutation
            ? 'Browser blocked a frame-initiated mutation before dispatch'
            : 'Browser blocked a page-initiated mutation before dispatch',
          expected: 'GET, HEAD, or OPTIONS', actual: 'mutation method',
        });
        await client.send('Fetch.failRequest', {
          requestId: params.requestId,
          errorReason: 'BlockedByClient',
        }, controlledSessionId);
        await stopMainLoading();
        await closeControlledSession(controlledSessionId);
        settleNavigation('mutation-blocked');
        return;
      }
      const classification = exactNetworkOrigin(params?.request?.url, approvedOrigin);
      if (classification === 'blocked'
          || (classification === 'internal' && params?.resourceType === 'Document')) {
        blockedOrigin = true;
        recordOnce(records, {
          category: 'security', severity: 'critical', outcome: 'fail',
          reasonCode: 'NAVIGATION_ORIGIN_BLOCKED',
          message: 'Browser blocked a request outside the exact approved origin',
          expected: 'exact approved origin', actual: 'unapproved origin',
        });
        await client.send('Fetch.failRequest', {
          requestId: params.requestId,
          errorReason: 'BlockedByClient',
        }, controlledSessionId);
        await stopMainLoading();
        await closeControlledSession(controlledSessionId);
        settleNavigation('blocked');
        return;
      }
      await client.send('Fetch.continueRequest', {
        requestId: params.requestId,
        headers: requestHeaders(params?.request?.headers, classification === 'approved' ? token : null),
      }, controlledSessionId);
    })));
    unsubscriptions.push(client.on('Network.requestWillBeSent', scoped(async (params, controlledSessionId) => {
      const requestKey = `${controlledSessionId}:${params.requestId}`;
      const origin = exactNetworkOrigin(params?.request?.url, approvedOrigin);
      requestTypes.set(`${controlledSessionId}:${params.requestId}`, {
        type: params.type,
        origin,
      });
      if (origin === 'approved') inFlightRequests.add(requestKey);
      if (origin === 'blocked') {
        blockedOrigin = true;
        recordOnce(records, {
          category: 'security', severity: 'critical', outcome: 'fail',
          reasonCode: 'NAVIGATION_ORIGIN_BLOCKED',
          message: 'Browser blocked a request outside the exact approved origin',
          expected: 'exact approved origin', actual: 'unapproved origin',
        });
        await stopMainLoading();
        settleNavigation('blocked');
      }
    })));
    unsubscriptions.push(client.on('Network.loadingFinished', scoped(async (
      params,
      controlledSessionId,
    ) => {
      const requestKey = `${controlledSessionId}:${params.requestId}`;
      inFlightRequests.delete(requestKey);
      requestTypes.delete(requestKey);
    })));
    unsubscriptions.push(client.on('Network.responseReceived', scoped(async (params, controlledSessionId) => {
      const classification = exactNetworkOrigin(params?.response?.url, approvedOrigin);
      if (controlledSessionId === sessionId
          && params.type === 'Document'
          && classification === 'approved') {
        documentStatus = Number.isInteger(params?.response?.status)
          ? params.response.status
          : Math.trunc(params?.response?.status);
      } else if (classification === 'approved'
          && Number(params?.response?.status) >= 400) {
        recordOnce(records, {
          category: 'network', severity: 'error', outcome: 'fail',
          reasonCode: 'RESOURCE_STATUS_ERROR',
          message: 'A same-origin page resource returned an error status',
          expected: 'resource status below 400', actual: 'resource response error',
        });
      }
    })));
    unsubscriptions.push(client.on('Network.loadingFailed', scoped(async (params, controlledSessionId) => {
      const requestKey = `${controlledSessionId}:${params.requestId}`;
      const request = requestTypes.get(requestKey);
      inFlightRequests.delete(requestKey);
      requestTypes.delete(requestKey);
      if (request?.type !== 'Document' && request?.origin === 'approved') {
        recordOnce(records, {
          category: 'network', severity: 'error', outcome: 'fail',
          reasonCode: 'RESOURCE_LOAD_FAILED',
          message: 'A same-origin page resource failed to load',
          expected: 'successful same-origin resource load', actual: 'resource load failed',
        });
      }
    })));
    unsubscriptions.push(client.on('Network.webSocketCreated', scoped(async (_params, controlledSessionId) => {
      recordOnce(records, {
        category: 'security', severity: 'critical', outcome: 'fail',
        reasonCode: 'BROWSER_WEBSOCKET_BLOCKED',
        message: 'Browser blocked a page-initiated WebSocket channel',
        expected: 'no page-initiated WebSocket channels', actual: 'WebSocket attempted',
      });
      await stopMainLoading();
      await closeControlledSession(controlledSessionId);
    })));
    unsubscriptions.push(client.on('Runtime.bindingCalled', scoped(async (params) => {
      if (params?.name !== WEBSOCKET_GUARD_BINDING
          && params?.name !== SERVICE_WORKER_GUARD_BINDING
          && params?.name !== WORKER_GUARD_BINDING) return;
      const serviceWorker = params.name === SERVICE_WORKER_GUARD_BINDING;
      const worker = params.name === WORKER_GUARD_BINDING;
      recordOnce(records, {
        category: 'security', severity: 'critical', outcome: 'fail',
        reasonCode: serviceWorker
          ? 'SERVICE_WORKER_BLOCKED'
          : worker ? 'WORKER_BLOCKED' : 'BROWSER_WEBSOCKET_BLOCKED',
        message: serviceWorker
          ? 'Browser blocked page-initiated service-worker registration'
          : worker
            ? 'Browser blocked page-initiated worker construction'
            : 'Browser blocked a page-initiated WebSocket channel',
        expected: serviceWorker
          ? 'no page-initiated service workers'
          : worker
            ? 'no page-initiated workers'
            : 'no page-initiated WebSocket channels',
        actual: serviceWorker
          ? 'service worker attempted'
          : worker ? 'worker attempted' : 'WebSocket attempted',
      });
      await stopMainLoading();
    })));
    unsubscriptions.push(client.on('Runtime.consoleAPICalled', scoped(async (params) => {
      if (params.type === 'error') {
        const blockedWebSocket = Array.isArray(params.args)
          && params.args.some((argument) => argument?.value === WEBSOCKET_GUARD_MARKER);
        const blockedServiceWorker = Array.isArray(params.args)
          && params.args.some((argument) => argument?.value === SERVICE_WORKER_GUARD_MARKER);
        const blockedWorker = Array.isArray(params.args)
          && params.args.some((argument) => argument?.value === WORKER_GUARD_MARKER);
        recordOnce(records, {
          category: blockedWebSocket || blockedServiceWorker || blockedWorker
            ? 'security'
            : 'console',
          severity: blockedWebSocket || blockedServiceWorker || blockedWorker
            ? 'critical'
            : 'error',
          outcome: 'fail',
          reasonCode: blockedServiceWorker
            ? 'SERVICE_WORKER_BLOCKED'
            : blockedWorker
              ? 'WORKER_BLOCKED'
              : blockedWebSocket ? 'BROWSER_WEBSOCKET_BLOCKED' : 'CONSOLE_ERROR',
          message: blockedServiceWorker
            ? 'Browser blocked page-initiated service-worker registration'
            : blockedWorker
              ? 'Browser blocked page-initiated worker construction'
            : blockedWebSocket
              ? 'Browser blocked a page-initiated WebSocket channel'
              : 'The page reported a console error',
          expected: blockedServiceWorker
            ? 'no page-initiated service workers'
            : blockedWorker
              ? 'no page-initiated workers'
            : blockedWebSocket
              ? 'no page-initiated WebSocket channels'
              : 'no console errors',
          actual: blockedServiceWorker
            ? 'service worker attempted'
            : blockedWorker
              ? 'worker attempted'
              : blockedWebSocket ? 'WebSocket attempted' : 'console error reported',
        });
      }
    })));
    unsubscriptions.push(client.on('Runtime.exceptionThrown', scoped(async () => {
      recordOnce(records, {
        category: 'console', severity: 'error', outcome: 'fail',
        reasonCode: 'UNCAUGHT_EXCEPTION',
        message: 'The page raised an uncaught exception',
        expected: 'no uncaught exceptions', actual: 'uncaught exception reported',
      });
    })));
    unsubscriptions.push(client.on('Log.entryAdded', scoped(async (params) => {
      if (params?.entry?.level === 'error'
          && params?.entry?.source !== 'network') {
        recordOnce(records, {
          category: 'console', severity: 'error', outcome: 'fail',
          reasonCode: 'BROWSER_LOG_ERROR',
          message: 'The browser reported an error log entry',
          expected: 'no browser error log entries', actual: 'browser error logged',
        });
      }
    })));
    unsubscriptions.push(client.on('Page.loadEventFired', scoped(async () => {
      settleNavigation('loaded');
    }, { mainOnly: true })));
    unsubscriptions.push(client.on('Page.frameNavigated', scoped(async (params) => {
      if (params?.frame?.parentId === undefined && typeof params?.frame?.id === 'string') {
        mainFrameId = params.frame.id;
      }
      if (!navigationStarted || params?.frame?.parentId !== undefined) return;
      if (exactNetworkOrigin(params?.frame?.url, approvedOrigin) !== 'approved') {
        blockedOrigin = true;
        recordOnce(records, {
          category: 'security', severity: 'critical', outcome: 'fail',
          reasonCode: 'NAVIGATION_ORIGIN_BLOCKED',
          message: 'Browser blocked a navigation outside the exact approved origin',
          expected: 'exact approved origin', actual: 'unapproved origin',
        });
        await stopMainLoading();
        settleNavigation('blocked');
      }
    }, { mainOnly: true })));

    await client.send('Target.setDiscoverTargets', { discover: true });
    discoverTargetsEnabled = true;
    await client.send('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
      filter: ROOT_AUTO_ATTACH_FILTER,
    });
    rootAutoAttachEnabled = true;
    ({ targetId } = await client.send('Target.createTarget', {
      url: 'about:blank',
      browserContextId,
    }));
    sessionId = await deadline.race(mainSessionReady);
    if (sessionId === null) throw new Error('main target policy unavailable');
    await client.send('Log.enable', {}, sessionId);
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: viewport,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    }, sessionId);

    const requestedPath = materializePath(route, decision.parameterValues);
    const navigationUrl = resolveRequestUrl(approvedOrigin, requestedPath);
    let navigationError = null;
    navigationStarted = true;
    void client.send('Page.navigate', { url: navigationUrl }, sessionId).catch((error) => {
      navigationError = error;
      settleNavigation('failed');
    });
    await deadline.race(navigationSettled);
    await client.flushEvents();
    if (navigationError !== null && !blockedOrigin) {
      if (rawClient.disconnectError !== null) throw rawClient.disconnectError;
      if (!deadline.expired) {
        recordOnce(records, {
          category: 'network', severity: 'error', outcome: 'fail',
          reasonCode: 'NAVIGATION_FAILED',
          message: 'Browser navigation failed before a document loaded',
          expected: 'successful bounded navigation', actual: 'navigation failed',
        });
      }
    }

    await waitForBrowserSettle({
      client: rawClient,
      deadline,
      inFlightRequests,
      activity,
    });
    if (!blockedOrigin) {
      const overflow = await client.send('Runtime.evaluate', {
        expression: OVERFLOW_EXPRESSION,
        returnByValue: true,
      }, sessionId);
      if (overflow?.result?.value === true) {
        recordOnce(records, {
          category: 'layout', severity: 'error', outcome: 'fail',
          reasonCode: 'HORIZONTAL_OVERFLOW',
          message: 'The page overflows horizontally at the configured viewport',
          expected: 'content width within viewport', actual: 'horizontal overflow',
        });
      }

      const selectors = Array.isArray(config.emptyContainerSelectors)
        ? config.emptyContainerSelectors
        : [];
      if (selectors.length > 0) {
        const documentResult = await client.send('Runtime.evaluate', {
          expression: 'document',
          returnByValue: false,
        }, sessionId);
        const empty = await client.send('Runtime.callFunctionOn', {
          objectId: documentResult?.result?.objectId,
          functionDeclaration: EMPTY_CONTAINER_FUNCTION,
          arguments: [{ value: selectors }],
          returnByValue: true,
        }, sessionId);
        const result = empty?.result?.value;
        if (Number(result?.invalid) > 0) {
          recordOnce(records, {
            category: 'configuration', severity: 'error', outcome: 'fail',
            reasonCode: 'EMPTY_SELECTOR_INVALID',
            message: 'A configured empty-container selector is invalid',
            expected: 'valid CSS selectors', actual: 'invalid selector',
          });
        }
        if (Number(result?.empty) > 0) {
          recordOnce(records, {
            category: 'content', severity: 'error', outcome: 'fail',
            reasonCode: 'EMPTY_CONTAINER',
            message: 'A configured container is present but empty',
            expected: 'non-empty configured container', actual: `${result.empty} empty container(s)`,
          });
        }
      }
    }

    recordOnce(records, statusRecord(documentStatus, accessExpected));
    if (role === null
        && config.screenshotOnError === true
        && records.some((record) => record.outcome === 'fail')) {
      try {
        const captured = await client.send('Page.captureScreenshot', {
          format: 'png', fromSurface: true, captureBeyondViewport: false,
        }, sessionId);
        const bytes = Buffer.from(captured?.data ?? '', 'base64');
        if (bytes.length < 8
            || !bytes.subarray(0, 8)
              .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
          throw new Error('invalid PNG screenshot');
        }
        screenshotPath = screenshotName(route, role, viewport);
        screenshotBytes = bytes;
      } catch (error) {
        if (deadline.expired
            || error?.code === 'BROWSER_ATTEMPT_TIMEOUT'
            || error?.code === 'CDP_COMMAND_ABORTED'
            || error?.code === 'CDP_COMMAND_TIMEOUT'
            || rawClient.disconnectError !== null) throw error;
        screenshotPath = null;
        screenshotBytes = null;
        recordOnce(records, {
          category: 'runtime', severity: 'error', outcome: 'fail',
          reasonCode: 'SCREENSHOT_CAPTURE_FAILED',
          message: 'Chrome could not provide a valid PNG screenshot',
          expected: 'valid PNG bytes', actual: 'screenshot capture failed',
        });
      }
    }
  } catch (error) {
    const disconnected = rawClient.disconnectError;
    if (disconnected?.code === 'CDP_EVENT_QUEUE_OVERFLOW') {
      fatalError = disconnected;
    } else if (disconnected !== null && !deadline.expired) {
      fatalError = disconnected;
    } else if (deadline.expired
        || error?.code === 'BROWSER_ATTEMPT_TIMEOUT'
        || error?.code === 'CDP_COMMAND_ABORTED'
        || error?.code === 'CDP_COMMAND_TIMEOUT') {
      recordOnce(records, {
        category: 'network', severity: 'error', outcome: 'fail',
        reasonCode: 'BROWSER_TIMEOUT',
        message: 'Browser attempt exceeded the configured wall-clock timeout',
        expected: 'completed browser attempt before timeout', actual: 'timeout',
      });
    } else {
      recordOnce(records, {
        category: 'runtime', severity: 'error', outcome: 'fail',
        reasonCode: 'BROWSER_RUNTIME_ERROR',
        message: 'Browser check failed inside the trusted runtime',
        expected: 'completed bounded browser check', actual: 'runtime error',
      });
    }
    recordOnce(records, statusRecord(documentStatus, accessExpected));
  } finally {
    attemptActive = false;
    for (const unsubscribe of unsubscriptions) unsubscribe();
    let cleanupComplete = rawClient.state === 'open';
    if (cleanupComplete) {
      try {
        if (targetId !== undefined) await client.send('Target.closeTarget', { targetId });
        if (browserContextId !== undefined) {
          await client.send('Target.disposeBrowserContext', { browserContextId });
        }
        if (rootAutoAttachEnabled) {
          await client.send('Target.setAutoAttach', {
            autoAttach: false,
            waitForDebuggerOnStart: false,
            flatten: true,
          });
        }
        if (discoverTargetsEnabled) {
          await client.send('Target.setDiscoverTargets', { discover: false });
        }
        await client.flushEvents();
      } catch (error) {
        cleanupComplete = false;
        if (error?.code === 'CDP_EVENT_QUEUE_OVERFLOW'
            || rawClient.disconnectError?.code === 'CDP_EVENT_QUEUE_OVERFLOW') {
          fatalError = rawClient.disconnectError ?? error;
        }
      }
    }
    if (!cleanupComplete && rawClient.state === 'open') {
      rawClient.disconnect('CDP_ATTEMPT_CLEANUP_FAILED');
    }
    if (rawClient.disconnectError?.code === 'CDP_EVENT_QUEUE_OVERFLOW') {
      fatalError = rawClient.disconnectError;
    }
    try {
      if (screenshotBytes !== null && fatalError === null) {
        await deadline.race(runBoundary.writeBytes(screenshotPath, screenshotBytes));
      }
    } finally {
      deadline.close();
    }
  }

  if (fatalError !== null) throw fatalError;
  records.sort(compareRecords);
  const durationMs = Math.max(0, performance.now() - startedAt);
  return records.map((record) => observation(route, {
    ...record,
    role,
    evidence: {
      status: documentStatus,
      durationMs,
      viewport,
      screenshotPath: record.outcome === 'fail' ? screenshotPath : null,
    },
  }));
}

/** Runs exact-origin browser checks and returns immutable, credential-free observations. */
export async function sweepBrowser({
  manifest,
  plan,
  config,
  env = process.env,
  runBoundary,
  targetBoundary,
} = {}) {
  if (!(targetBoundary instanceof TargetBoundary)) {
    throw new SentinelError(
      'BROWSER_TARGET_BOUNDARY_INVALID',
      'A trusted TargetBoundary is required for browser sweeps',
    );
  }
  const routes = Array.isArray(manifest?.routes) ? manifest.routes : [];
  const decisions = Array.isArray(plan?.routes) ? plan.routes : [];
  const decisionsById = new Map(decisions.map((decision) => [decision.subjectId, decision]));
  const observations = [];
  const profileDir = path.join(
    runBoundary.root,
    `.chrome-profile-${process.pid}-${randomBytes(8).toString('hex')}`,
  );
  const chrome = await launchChrome({
    executablePath: config?.chromePath ?? undefined,
    profileDir,
    targetRoot: targetBoundary.root,
    headless: true,
    timeoutMs: config?.responseTimeoutMs,
  });
  let client;
  try {
    client = await CdpClient.connect(chrome.webSocketUrl);
    routeLoop: for (const route of routes) {
      const decision = decisionsById.get(route?.id);
      if (decision?.action !== 'execute') {
        observations.push(policySkip(route, decision));
        continue;
      }
      const configuredOrigin = resolveOrigin(config, decision.originId);
      let approvedOrigin;
      try {
        if (!Array.isArray(config?.approvedOrigins)
            || !config.approvedOrigins.includes(configuredOrigin)) {
          throw new Error('origin not approved');
        }
        approvedOrigin = parseApprovedOrigin(configuredOrigin, {
          allowNonLoopback: config?.allowNonLoopback === true,
        });
      } catch (error) {
        observations.push(observation(route, {
          category: 'security', severity: 'error', outcome: 'fail',
          reasonCode: error?.code ?? 'ORIGIN_NOT_APPROVED',
          message: 'Browser route has no valid exact approved origin',
          expected: 'approved exact origin', actual: 'origin unavailable',
        }));
        continue;
      }

      for (const attempt of attemptsFor(route, config)) {
        const credential = roleCredential(config, attempt.role, env);
        if (credential.error) {
          observations.push(observation(route, {
            category: 'security', severity: 'error', outcome: 'fail', role: attempt.role,
            reasonCode: credential.error,
            message: 'Browser role credential is unavailable',
            expected: 'trusted environment secret reference', actual: credential.error,
          }));
          continue;
        }
        for (const viewport of config.viewports) {
          const attemptObservations = await runAttempt({
            client, route, decision, config, approvedOrigin,
            role: attempt.role,
            accessExpected: attempt.accessExpected,
            token: credential.token,
            viewport,
            runBoundary,
          });
          observations.push(...attemptObservations);
          if (client.state !== 'open') break routeLoop;
        }
      }
    }
    observations.sort(compareObservations);
    return deepFreeze(observations);
  } finally {
    await client?.close();
    await chrome.close();
  }
}
