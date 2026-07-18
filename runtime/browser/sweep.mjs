import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';

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
const WEBSOCKET_GUARD_EXPRESSION = `(() => {
  const notify = globalThis.__sentinelWebSocketBlocked;
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

function timeoutPromise(timeoutMs, value) {
  let timer;
  const promise = new Promise((resolve) => {
    timer = setTimeout(() => resolve(value), timeoutMs);
    timer.unref?.();
  });
  return { promise, cancel: () => clearTimeout(timer) };
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
  const records = [];
  const requestTypes = new Map();
  let documentStatus = null;
  let blockedOrigin = false;
  let navigationStarted = false;
  let browserContextId;
  let targetId;
  let sessionId;
  const unsubscriptions = [];
  let settleNavigation;
  const navigationSettled = new Promise((resolve) => { settleNavigation = resolve; });

  try {
    ({ browserContextId } = await client.send('Target.createBrowserContext', {
      disposeOnDetach: true,
    }));
    await client.send('Browser.setDownloadBehavior', {
      behavior: 'deny',
      browserContextId,
    });
    ({ targetId } = await client.send('Target.createTarget', {
      url: 'about:blank',
      browserContextId,
    }));
    ({ sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true }));

    const scoped = (handler) => async (params, metadata) => {
      if (metadata.sessionId !== sessionId) return;
      try {
        await handler(params);
      } catch {
        recordOnce(records, {
          category: 'runtime', severity: 'error', outcome: 'fail',
          reasonCode: 'BROWSER_EVENT_HANDLER_FAILED',
          message: 'Browser event processing failed inside the trusted runtime',
          expected: 'bounded browser event handling', actual: 'event handling failed',
        });
        await client.send('Page.stopLoading', {}, sessionId).catch(() => {});
        settleNavigation('event-failed');
      }
    };
    unsubscriptions.push(client.on('Fetch.requestPaused', scoped(async (params) => {
      const method = typeof params?.request?.method === 'string'
        ? params.request.method.toUpperCase()
        : 'UNKNOWN';
      if (!READ_METHODS.has(method)) {
        recordOnce(records, {
          category: 'security', severity: 'critical', outcome: 'fail',
          reasonCode: 'BROWSER_MUTATION_BLOCKED',
          message: 'Browser blocked a page-initiated mutation before dispatch',
          expected: 'GET, HEAD, or OPTIONS', actual: 'mutation method',
        });
        await client.send('Fetch.failRequest', {
          requestId: params.requestId,
          errorReason: 'BlockedByClient',
        }, sessionId);
        await client.send('Page.stopLoading', {}, sessionId).catch(() => {});
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
        }, sessionId);
        await client.send('Page.stopLoading', {}, sessionId).catch(() => {});
        settleNavigation('blocked');
        return;
      }
      await client.send('Fetch.continueRequest', {
        requestId: params.requestId,
        headers: requestHeaders(params?.request?.headers, classification === 'approved' ? token : null),
      }, sessionId);
    })));
    unsubscriptions.push(client.on('Network.requestWillBeSent', scoped(async (params) => {
      requestTypes.set(params.requestId, {
        type: params.type,
        origin: exactNetworkOrigin(params?.request?.url, approvedOrigin),
      });
      if (exactNetworkOrigin(params?.request?.url, approvedOrigin) === 'blocked') {
        blockedOrigin = true;
        recordOnce(records, {
          category: 'security', severity: 'critical', outcome: 'fail',
          reasonCode: 'NAVIGATION_ORIGIN_BLOCKED',
          message: 'Browser blocked a request outside the exact approved origin',
          expected: 'exact approved origin', actual: 'unapproved origin',
        });
        await client.send('Page.stopLoading', {}, sessionId).catch(() => {});
        settleNavigation('blocked');
      }
    })));
    unsubscriptions.push(client.on('Network.responseReceived', scoped(async (params) => {
      const classification = exactNetworkOrigin(params?.response?.url, approvedOrigin);
      if (params.type === 'Document' && classification === 'approved') {
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
    unsubscriptions.push(client.on('Network.loadingFailed', scoped(async (params) => {
      const request = requestTypes.get(params.requestId);
      if (request?.type !== 'Document' && request?.origin === 'approved') {
        recordOnce(records, {
          category: 'network', severity: 'error', outcome: 'fail',
          reasonCode: 'RESOURCE_LOAD_FAILED',
          message: 'A same-origin page resource failed to load',
          expected: 'successful same-origin resource load', actual: 'resource load failed',
        });
      }
    })));
    unsubscriptions.push(client.on('Network.webSocketCreated', scoped(async () => {
      recordOnce(records, {
        category: 'security', severity: 'critical', outcome: 'fail',
        reasonCode: 'BROWSER_WEBSOCKET_BLOCKED',
        message: 'Browser blocked a page-initiated WebSocket channel',
        expected: 'no page-initiated WebSocket channels', actual: 'WebSocket attempted',
      });
      await client.send('Page.stopLoading', {}, sessionId).catch(() => {});
    })));
    unsubscriptions.push(client.on('Runtime.bindingCalled', scoped(async (params) => {
      if (params?.name !== WEBSOCKET_GUARD_BINDING) return;
      recordOnce(records, {
        category: 'security', severity: 'critical', outcome: 'fail',
        reasonCode: 'BROWSER_WEBSOCKET_BLOCKED',
        message: 'Browser blocked a page-initiated WebSocket channel',
        expected: 'no page-initiated WebSocket channels', actual: 'WebSocket attempted',
      });
      await client.send('Page.stopLoading', {}, sessionId).catch(() => {});
    })));
    unsubscriptions.push(client.on('Runtime.consoleAPICalled', scoped(async (params) => {
      if (params.type === 'error') {
        const blockedWebSocket = Array.isArray(params.args)
          && params.args.some((argument) => argument?.value === WEBSOCKET_GUARD_MARKER);
        recordOnce(records, {
          category: blockedWebSocket ? 'security' : 'console',
          severity: blockedWebSocket ? 'critical' : 'error',
          outcome: 'fail',
          reasonCode: blockedWebSocket ? 'BROWSER_WEBSOCKET_BLOCKED' : 'CONSOLE_ERROR',
          message: blockedWebSocket
            ? 'Browser blocked a page-initiated WebSocket channel'
            : 'The page reported a console error',
          expected: blockedWebSocket
            ? 'no page-initiated WebSocket channels'
            : 'no console errors',
          actual: blockedWebSocket ? 'WebSocket attempted' : 'console error reported',
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
    })));
    unsubscriptions.push(client.on('Page.frameNavigated', scoped(async (params) => {
      if (!navigationStarted || params?.frame?.parentId !== undefined) return;
      if (exactNetworkOrigin(params?.frame?.url, approvedOrigin) !== 'approved') {
        blockedOrigin = true;
        recordOnce(records, {
          category: 'security', severity: 'critical', outcome: 'fail',
          reasonCode: 'NAVIGATION_ORIGIN_BLOCKED',
          message: 'Browser blocked a navigation outside the exact approved origin',
          expected: 'exact approved origin', actual: 'unapproved origin',
        });
        await client.send('Page.stopLoading', {}, sessionId).catch(() => {});
        settleNavigation('blocked');
      }
    })));

    await client.send('Page.enable', {}, sessionId);
    await client.send('Runtime.enable', {}, sessionId);
    await client.send('Runtime.addBinding', { name: WEBSOCKET_GUARD_BINDING }, sessionId);
    await client.send('Page.addScriptToEvaluateOnNewDocument', {
      source: WEBSOCKET_GUARD_EXPRESSION,
    }, sessionId);
    await client.send('Network.enable', {}, sessionId);
    await client.send('Network.setBypassServiceWorker', { bypass: true }, sessionId);
    await client.send('Network.setCacheDisabled', { cacheDisabled: true }, sessionId);
    await client.send('Network.setBlockedURLs', { urls: ['ws://*/*', 'wss://*/*'] }, sessionId);
    await client.send('Log.enable', {}, sessionId);
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: viewport,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    }, sessionId);
    await client.send('Fetch.enable', {
      patterns: [{ urlPattern: '*', requestStage: 'Request' }],
    }, sessionId);

    const requestedPath = materializePath(route, decision.parameterValues);
    const navigationUrl = resolveRequestUrl(approvedOrigin, requestedPath);
    const navigationTimeout = timeoutPromise(config.responseTimeoutMs, 'timeout');
    try {
      try {
        navigationStarted = true;
        await client.send('Page.navigate', { url: navigationUrl }, sessionId);
      } catch {
        await client.flushEvents();
        if (!blockedOrigin) {
          recordOnce(records, {
            category: 'network', severity: 'error', outcome: 'fail',
            reasonCode: 'NAVIGATION_FAILED',
            message: 'Browser navigation failed before a document loaded',
            expected: 'successful bounded navigation', actual: 'navigation failed',
          });
          settleNavigation('failed');
        }
      }
      const navigationResult = await Promise.race([navigationSettled, navigationTimeout.promise]);
      if (navigationResult === 'timeout') {
        await client.send('Page.stopLoading', {}, sessionId).catch(() => {});
        recordOnce(records, {
          category: 'network', severity: 'error', outcome: 'fail',
          reasonCode: 'BROWSER_TIMEOUT',
          message: 'Browser navigation exceeded the configured timeout',
          expected: 'navigation before timeout', actual: 'timeout',
        });
      }
    } finally {
      navigationTimeout.cancel();
    }

    await new Promise((resolve) => setTimeout(resolve, 75));
    await client.flushEvents();
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

    records.push(statusRecord(documentStatus, accessExpected));
    let screenshotPath = null;
    if (config.screenshotOnError === true && records.some((record) => record.outcome === 'fail')) {
      const captured = await client.send('Page.captureScreenshot', {
        format: 'png', fromSurface: true, captureBeyondViewport: false,
      }, sessionId);
      const bytes = Buffer.from(captured?.data ?? '', 'base64');
      if (bytes.length >= 8
          && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
        screenshotPath = screenshotName(route, role, viewport);
        await runBoundary.writeBytes(screenshotPath, bytes);
      } else {
        recordOnce(records, {
          category: 'runtime', severity: 'error', outcome: 'fail',
          reasonCode: 'SCREENSHOT_CAPTURE_FAILED',
          message: 'Chrome did not return a valid PNG screenshot',
          expected: 'valid PNG bytes', actual: 'invalid screenshot data',
        });
      }
    }

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
  } catch {
    return [observation(route, {
      category: 'runtime', severity: 'error', outcome: 'fail', role,
      reasonCode: 'BROWSER_RUNTIME_ERROR',
      message: 'Browser check failed inside the trusted runtime',
      expected: 'completed bounded browser check', actual: 'runtime error',
      evidence: { durationMs: performance.now() - startedAt, viewport },
    })];
  } finally {
    for (const unsubscribe of unsubscriptions) unsubscribe();
    if (targetId !== undefined) await client.send('Target.closeTarget', { targetId }).catch(() => {});
    if (browserContextId !== undefined) {
      await client.send('Target.disposeBrowserContext', { browserContextId }).catch(() => {});
    }
  }
}

/** Runs exact-origin browser checks and returns immutable, credential-free observations. */
export async function sweepBrowser({
  manifest,
  plan,
  config,
  env = process.env,
  runBoundary,
} = {}) {
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
    targetRoot: typeof manifest?.target?.root === 'string' ? manifest.target.root : undefined,
    headless: true,
    timeoutMs: config?.responseTimeoutMs,
  });
  let client;
  try {
    client = await CdpClient.connect(chrome.webSocketUrl);
    for (const route of routes) {
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
          observations.push(...await runAttempt({
            client, route, decision, config, approvedOrigin,
            role: attempt.role,
            accessExpected: attempt.accessExpected,
            token: credential.token,
            viewport,
            runBoundary,
          }));
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
