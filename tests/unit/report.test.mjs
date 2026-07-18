import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import test from 'node:test';

import { exportCollection } from '../../runtime/export.mjs';
import { appendHistory } from '../../runtime/history.mjs';
import { findingId } from '../../runtime/lib/identity.mjs';
import {
  renderDashboard,
  renderMarkdown,
  renderPrComment,
  summaryExitCode,
} from '../../runtime/report.mjs';

const canonical = JSON.parse(
  await readFile(new URL('../fixtures/report/canonical-findings.json', import.meta.url), 'utf8'),
);
const expectedMarkdown = await readFile(
  new URL('../fixtures/report/expected-report.md', import.meta.url),
  'utf8',
);

function operation({ id, method, path, requestSchemaId = null, responseSchemaId = null, roles = [] }) {
  const mutation = !['GET', 'HEAD', 'OPTIONS'].includes(method);
  return {
    id,
    method,
    path,
    summary: `${method} ${path}`,
    parameters: [{
      name: 'itemId',
      location: 'query',
      required: false,
      schema: { type: 'string' },
      example: 'sensitive-parameter-example',
    }],
    requestBody: requestSchemaId === null ? null : {
      required: true,
      contentType: 'application/json',
      schemaId: requestSchemaId,
    },
    responses: {
      '200': { contentType: 'application/json', schemaId: responseSchemaId },
    },
    auth: roles.length === 0
      ? { state: 'public', allowedRoles: [] }
      : { state: 'required', allowedRoles: roles },
    targetModel: responseSchemaId,
    deleteMode: null,
    sideEffects: { state: 'known', classes: mutation ? ['fixture-write'] : [] },
    rollback: mutation ? 'remove fixture' : null,
    mutation,
    protocol: 'http',
    sweepable: true,
    risk: { score: mutation ? 40 : 0, level: mutation ? 'medium' : 'safe', reasons: [] },
    provenance: {
      adapter: 'openapi-json',
      file: 'openapi.json',
      pointer: `#/paths/${path}/${method.toLowerCase()}`,
    },
  };
}

function exportFixture() {
  const operations = [
    operation({
      id: 'op:post:/items',
      method: 'POST',
      path: '/items',
      requestSchemaId: 'schema:request',
      responseSchemaId: 'schema:response',
      roles: ['admin'],
    }),
    operation({
      id: 'op:patch:/missing-body',
      method: 'PATCH',
      path: '/missing-body',
      responseSchemaId: 'schema:response',
      roles: ['user'],
    }),
    operation({
      id: 'op:get:/status',
      method: 'GET',
      path: '/status',
      responseSchemaId: 'schema:response',
    }),
  ];
  return {
    manifest: {
      schemaVersion: '2.0',
      generatedAt: '2026-07-18T11:59:59.000Z',
      target: { name: 'export-fixture', root: '.' },
      coverage: { status: 'complete', diagnostics: [] },
      routes: [],
      operations,
      schemas: {
        'schema:request': {
          schema: {
            type: 'object',
            required: ['requestOnlyCanary', 'nested', 'secretChoice'],
            properties: {
              requestOnlyCanary: { type: 'string' },
              nested: {
                type: 'object',
                required: ['count'],
                properties: { count: { type: 'integer', minimum: 2 } },
              },
              secretChoice: {
                type: 'string',
                enum: ['SENSITIVE_ENUM_VALUE_MUST_NOT_APPEAR'],
              },
            },
          },
          provenance: {
            adapter: 'openapi-json', file: 'openapi.json', pointer: '#/components/request',
          },
        },
        'schema:response': {
          schema: {
            type: 'object',
            required: ['responseOnlyCanary'],
            properties: { responseOnlyCanary: { type: 'string' } },
          },
          provenance: {
            adapter: 'openapi-json', file: 'openapi.json', pointer: '#/components/response',
          },
        },
      },
    },
    config: {
      approvedOrigins: ['http://127.0.0.1:4317'],
      roles: {
        admin: { tokenRef: 'env:SENTINEL_ADMIN_TOKEN' },
        user: { tokenRef: 'env:SENTINEL_USER_TOKEN' },
      },
    },
  };
}

function artifact(artifacts, suffix) {
  return artifacts.find((entry) => entry.path.endsWith(suffix));
}

function withPrototypeValue(prototype, key, value, callback) {
  const previous = Object.getOwnPropertyDescriptor(prototype, key);
  Object.defineProperty(prototype, key, {
    configurable: true,
    writable: true,
    value,
  });
  try {
    return callback();
  } finally {
    if (previous === undefined) delete prototype[key];
    else Object.defineProperty(prototype, key, previous);
  }
}

function refreshFindingId(finding) {
  finding.id = findingId({
    subjectType: finding.subject.type,
    subjectId: finding.subject.id,
    service: finding.service ?? null,
    role: finding.role,
    category: finding.category,
    reasonCode: finding.reasonCode,
    viewport: Object.hasOwn(finding.evidence, 'viewport')
      ? finding.evidence.viewport
      : null,
    diagnosticSourcePath: null,
    diagnosticPointer: null,
  });
}

function changedCanonical(reasonCode, mutate) {
  const document = structuredClone(canonical);
  const finding = document.findings.find((entry) => entry.reasonCode === reasonCode);
  assert.ok(finding, reasonCode);
  mutate(finding, document);
  return document;
}

function changedContentTypeCanonical(actual, statusCode) {
  return changedCanonical('RBAC_ACCESS_GRANTED', (finding, document) => {
    finding.reasonCode = 'CONTENT_TYPE_MISMATCH';
    finding.category = 'schema';
    finding.severity = 'error';
    finding.evidence = {
      expected: 'application/json',
      actual,
      statusCode,
      durationMs: 12,
    };
    document.summary.critical = 0;
    document.summary.error = 2;
    document.findings = [
      document.findings[1],
      document.findings[0],
      document.findings[2],
      document.findings[3],
    ];
    refreshFindingId(finding);
  });
}

function preImportExport(fixture, format, poisonSource) {
  const moduleUrl = new URL('../../runtime/export.mjs', import.meta.url).href;
  const script = `
    ${poisonSource}
    const { exportCollection: poisonedExportCollection } = await import(
      ${JSON.stringify(moduleUrl)}
    );
    const fixture = ${JSON.stringify(fixture)};
    try {
      const artifacts = poisonedExportCollection({ format: ${JSON.stringify(format)}, ...fixture });
      process.stdout.write(JSON.stringify({ artifacts }));
    } catch (error) {
      process.stdout.write(JSON.stringify({ error: error?.code ?? String(error) }));
    }
  `;
  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', script],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('renders the exact golden Markdown byte-for-byte on repeated calls', () => {
  const first = renderMarkdown(canonical);
  const second = renderMarkdown(structuredClone(canonical));

  assert.equal(first, expectedMarkdown);
  assert.equal(second, expectedMarkdown);
  assert.equal(Buffer.compare(Buffer.from(first), Buffer.from(second)), 0);
});

test('escapes Markdown, HTML, and embedded JSON independently without remote assets', () => {
  const hostile = structuredClone(canonical);
  hostile.findings[0].message = '<script>alert("x")</script>\n# injected | `code` & [link](javascript:x) _italic_\u202e\u2066\u200b\u061c\u0085\t';
  hostile.findings[1].message = `line separator   paragraph   </script><img src=x onerror=alert(1)>`;
  hostile.coverage.diagnostics[0].message = '| table escape <iframe src="https://evil.invalid">';
  hostile.findings.find((finding) => finding.category === 'coverage').message =
    hostile.coverage.diagnostics[0].message;

  const markdown = renderMarkdown(hostile);
  const dashboard = renderDashboard(hostile);
  const pr = renderPrComment(hostile);

  assert.equal(markdown.includes('<script>'), false);
  assert.equal(markdown.includes('\n# injected'), false);
  assert.ok(markdown.includes('&lt;script&gt;'));
  assert.ok(markdown.includes('\\|'));
  assert.equal(markdown.includes('[link](javascript:x)'), false);
  assert.ok(markdown.includes('\\[link\\]\\(javascript:x\\)'));
  assert.equal(markdown.includes('_italic_'), false);
  assert.ok(markdown.includes('\\_italic\\_'));
  assert.equal(pr.includes('<iframe'), false);
  assert.ok(pr.includes('&lt;iframe'));
  for (const output of [markdown, dashboard, pr]) {
    for (const character of ['\u202e', '\u2066', '\u200b', '\u061c', '\u0085', '\t']) {
      assert.equal(output.includes(character), false);
    }
  }
  // Keep the numeric form visibly escaped in Markdown so a renderer cannot
  // decode it back into an active right-to-left override character.
  assert.ok(markdown.includes('&\\#8238;'));
  assert.ok(dashboard.includes('&#8294;'));

  assert.ok(dashboard.includes("default-src 'none'"));
  assert.equal(/<(?:script)[^>]*src=/iu.test(dashboard), false);
  assert.equal(/<(?:link|img)[^>]+https?:/iu.test(dashboard), false);
  assert.equal(dashboard.includes('<script>alert'), false);
  assert.ok(dashboard.includes('&lt;script&gt;'));
  assert.ok(dashboard.includes('&#8232;'));
  assert.ok(dashboard.includes('&#8233;'));

  const embedded = /<script id="sentinel-summary" type="application\/json">([\s\S]*?)<\/script>/u
    .exec(dashboard);
  assert.ok(embedded);
  assert.deepEqual(JSON.parse(embedded[1]), hostile.summary);
  assert.equal(embedded[1].includes('<'), false);
  assert.equal(embedded[1].includes('>'), false);
  assert.equal(embedded[1].includes('&'), false);
  assert.equal(embedded[1].includes(' '), false);
  assert.equal(embedded[1].includes(' '), false);
});

test('does not invoke mutable String replacement intrinsics while escaping reports', () => {
  const hostile = structuredClone(canonical);
  hostile.findings[0].message = '<img src=x onerror=alert(1)> [link](javascript:alert(1))';

  let replaceAllCalls = 0;
  const dashboard = withPrototypeValue(
    String.prototype,
    'replaceAll',
    function forgedReplaceAll() {
      replaceAllCalls += 1;
      return String(this);
    },
    () => renderDashboard(hostile),
  );
  assert.equal(replaceAllCalls, 0);
  assert.equal(dashboard.includes('<img src=x onerror='), false);
  assert.ok(dashboard.includes('&lt;img src=x onerror='));

  let replaceCalls = 0;
  const markdown = withPrototypeValue(
    String.prototype,
    'replace',
    function forgedReplace() {
      replaceCalls += 1;
      return String(this);
    },
    () => renderMarkdown(hostile),
  );
  assert.equal(replaceCalls, 0);
  assert.equal(markdown.includes('[link](javascript:alert(1))'), false);
  assert.ok(markdown.includes('\\[link\\]\\(javascript:alert\\(1\\)\\)'));
});

test('escapes dashboard HTML when String replacements are poisoned before import', () => {
  const moduleUrl = new URL('../../runtime/report.mjs', import.meta.url).href;
  const hostile = structuredClone(canonical);
  hostile.findings[0].message = '<img src=x onerror=alert(1)>';
  const script = `
    let calls = 0;
    String.prototype.replace = function poisonedReplace() {
      calls += 1;
      return String(this);
    };
    String.prototype.replaceAll = function poisonedReplaceAll() {
      calls += 1;
      return String(this);
    };
    const { renderDashboard: render } = await import(${JSON.stringify(moduleUrl)});
    const dashboard = render(${JSON.stringify(hostile)});
    process.stdout.write(JSON.stringify({
      calls,
      raw: dashboard.includes('<img src=x onerror='),
      escaped: dashboard.includes('&lt;img src=x onerror='),
    }));
  `;
  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', script],
    { encoding: 'utf8' },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { calls: 0, raw: false, escaped: true });
});

test('does not invoke a mutable Array iterator while rendering any report format', () => {
  const originalIterator = Array.prototype[Symbol.iterator];
  let iteratorCalls = 0;
  const output = withPrototypeValue(
    Array.prototype,
    Symbol.iterator,
    function countedIterator() {
      iteratorCalls += 1;
      return Reflect.apply(originalIterator, this, []);
    },
    () => ({
      markdown: renderMarkdown(canonical),
      dashboard: renderDashboard(canonical),
      pr: renderPrComment(canonical),
    }),
  );

  assert.equal(iteratorCalls, 0);
  assert.equal(output.markdown, expectedMarkdown);
  assert.ok(output.dashboard.startsWith('<!doctype html>'));
  assert.ok(output.pr.startsWith('## Sentinel sweep'));
});

test('rejects a stored summary that disagrees with canonical finding outcomes', () => {
  const deliberatelyDifferent = structuredClone(canonical);
  deliberatelyDifferent.summary = {
    critical: 0, error: 0, warning: 8, info: 5, skipped: 3,
  };

  for (const consumer of [renderMarkdown, renderDashboard, renderPrComment, summaryExitCode]) {
    assert.throws(
      () => consumer(deliberatelyDifferent),
      (error) => error?.code === 'FINDINGS_DOCUMENT_INVALID',
    );
  }
});

test('rejects duplicate, out-of-order, tampered identities and inconsistent coverage/percentiles', () => {
  const invalid = [];

  const duplicate = structuredClone(canonical);
  duplicate.findings[1].id = duplicate.findings[0].id;
  invalid.push(['duplicate id', duplicate]);

  const outOfOrder = structuredClone(canonical);
  [outOfOrder.findings[0], outOfOrder.findings[1]] = [
    outOfOrder.findings[1], outOfOrder.findings[0],
  ];
  invalid.push(['finding order', outOfOrder]);

  const tampered = structuredClone(canonical);
  tampered.findings[0].id = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
  invalid.push(['tampered id', tampered]);

  const provenanceOrder = structuredClone(canonical);
  provenanceOrder.findings[0].provenance.reverse();
  invalid.push(['provenance order', provenanceOrder]);

  const coverage = structuredClone(canonical);
  coverage.coverage.diagnostics = [];
  invalid.push(['coverage consistency', coverage]);

  const percentiles = structuredClone(canonical);
  percentiles.responseTimePercentiles = { p50: 50, p95: 20, p99: 10, average: 30 };
  invalid.push(['percentile order', percentiles]);

  for (const [name, document] of invalid) {
    assert.throws(
      () => renderMarkdown(document),
      (error) => error?.code === 'FINDINGS_DOCUMENT_INVALID',
      name,
    );
  }
});

test('rejects forged source-specific evidence at report and history consumer boundaries', async () => {
  const forged = [
    ['policy transport evidence', changedCanonical('MUTATION_BLOCKED_DISABLED', (finding) => {
      finding.evidence.statusCode = 200;
      finding.evidence.durationMs = 1;
      finding.evidence.screenshotPath = 'browser-aaaaaaaaaaaaaaaaaaaaaaaa.png';
    })],
    ['policy null transport evidence', changedCanonical('MUTATION_BLOCKED_DISABLED', (finding) => {
      finding.evidence.statusCode = null;
    })],
    ['policy missing expected and actual', changedCanonical('MUTATION_BLOCKED_DISABLED', (finding) => {
      finding.evidence = {};
    })],
    ['API screenshot evidence', changedCanonical('RBAC_ACCESS_GRANTED', (finding) => {
      finding.evidence.screenshotPath = 'browser-bbbbbbbbbbbbbbbbbbbbbbbb.png';
    })],
    ['API missing expected and actual', changedCanonical('RBAC_ACCESS_GRANTED', (finding) => {
      finding.evidence = {};
    })],
    ['API status reason missing transport', changedCanonical('RBAC_ACCESS_GRANTED', (finding) => {
      finding.evidence = { expected: '401 or 403', actual: '200' };
    })],
    ['API pretransport reason with status', changedCanonical('RBAC_ACCESS_GRANTED', (finding) => {
      finding.reasonCode = 'ORIGIN_INVALID';
      finding.category = 'security';
      refreshFindingId(finding);
    })],
    ['API status actual mismatch', changedCanonical('RBAC_ACCESS_GRANTED', (finding) => {
      finding.evidence.actual = '201';
    })],
    ['API inspection reason with denial status', changedContentTypeCanonical(
      'different valid media type',
      401,
    )],
    ['API content-type reason with reflected actual', changedContentTypeCanonical(
      'sentinel-reflected-media-canary',
      200,
    )],
    ['API viewport evidence', changedCanonical('RBAC_ACCESS_GRANTED', (finding) => {
      finding.evidence.viewport = 375;
      refreshFindingId(finding);
    })],
    ['coverage transport evidence', changedCanonical('VUE_DYNAMIC_ROUTE', (finding) => {
      finding.evidence.durationMs = 1;
    })],
    ['browser screenshot without viewport', changedCanonical('UNCAUGHT_EXCEPTION', (finding) => {
      delete finding.evidence.viewport;
      refreshFindingId(finding);
    })],
    ['browser missing expected and actual', changedCanonical('UNCAUGHT_EXCEPTION', (finding) => {
      finding.evidence = { viewport: 375 };
    })],
    ['browser in-attempt reason missing transport', changedCanonical('UNCAUGHT_EXCEPTION', (finding) => {
      finding.evidence = { expected: 'no console errors', actual: 'uncaught exception' };
      refreshFindingId(finding);
    })],
    ['browser preattempt reason with transport', changedCanonical('UNCAUGHT_EXCEPTION', (finding) => {
      finding.reasonCode = 'ORIGIN_INVALID';
      finding.category = 'security';
      refreshFindingId(finding);
    })],
    ['browser screenshot for authenticated role', changedCanonical('UNCAUGHT_EXCEPTION', (finding) => {
      finding.role = 'admin';
      refreshFindingId(finding);
    })],
    ['browser viewport above runtime limit', changedCanonical('UNCAUGHT_EXCEPTION', (finding) => {
      finding.evidence.viewport = 10_001;
      refreshFindingId(finding);
    })],
    ['screenshot capture failure with screenshot', changedCanonical('UNCAUGHT_EXCEPTION', (finding) => {
      finding.reasonCode = 'SCREENSHOT_CAPTURE_FAILED';
      finding.category = 'runtime';
      refreshFindingId(finding);
    })],
    ['browser timeout with screenshot', changedCanonical('UNCAUGHT_EXCEPTION', (finding) => {
      finding.reasonCode = 'BROWSER_TIMEOUT';
      finding.category = 'network';
      refreshFindingId(finding);
    })],
    ['browser runtime error with screenshot', changedCanonical('UNCAUGHT_EXCEPTION', (finding) => {
      finding.reasonCode = 'BROWSER_RUNTIME_ERROR';
      finding.category = 'runtime';
      refreshFindingId(finding);
    })],
    ['forged browser provenance path', changedCanonical('UNCAUGHT_EXCEPTION', (finding) => {
      finding.provenance[1].sourcePath = '/tmp/forged';
    })],
    ['null normalized screenshot', changedCanonical('UNCAUGHT_EXCEPTION', (finding) => {
      finding.evidence.screenshotPath = null;
    })],
  ];
  for (const screenshotPath of [
    '/tmp/stolen.png',
    '../stolen.png',
    'C:\\stolen.png',
    'browser-0123456789abcdef01234567.png\ninjected',
    'dashboard-375.png',
    'browser-short.png',
    'browser-0123456789abcdef01234567.jpg',
  ]) {
    forged.push([
      `unsafe screenshot ${JSON.stringify(screenshotPath)}`,
      changedCanonical('UNCAUGHT_EXCEPTION', (finding) => {
        finding.evidence.screenshotPath = screenshotPath;
      }),
    ]);
  }

  for (const [name, document] of forged) {
    for (const consumer of [renderMarkdown, renderDashboard, renderPrComment, summaryExitCode]) {
      assert.throws(
        () => consumer(document),
        (error) => error?.code === 'FINDINGS_DOCUMENT_INVALID',
        `${name}: ${consumer.name}`,
      );
    }
    await assert.rejects(
      appendHistory({ reportRoot: '/unused-invalid-report-root', findings: document }),
      (error) => error?.code === 'HISTORY_FINDINGS_INVALID',
      `${name}: history`,
    );
  }
});

test('accepts only finite persisted content-type mismatch phrases and the redacted marker', () => {
  for (const actual of [
    'different valid media type',
    'missing or invalid content type',
    '[REDACTED]',
  ]) {
    const document = changedContentTypeCanonical(actual, 200);
    for (const consumer of [renderMarkdown, renderDashboard, renderPrComment, summaryExitCode]) {
      assert.doesNotThrow(() => consumer(document), `${actual}: ${consumer.name}`);
    }
  }
});

test('rejects accessor/proxy/prototype/symbol report inputs without invoking attacker code', () => {
  const accessor = structuredClone(canonical);
  let accessorReads = 0;
  Object.defineProperty(accessor.summary, 'critical', {
    enumerable: true,
    get() {
      accessorReads += 1;
      return accessorReads === 1 ? 0 : '<img src=x onerror=alert(1)>';
    },
  });
  assert.throws(
    () => renderDashboard(accessor),
    (error) => error?.code === 'FINDINGS_DOCUMENT_INVALID',
  );
  assert.equal(accessorReads, 0);

  let proxyReads = 0;
  const proxy = new Proxy(structuredClone(canonical), {
    get(target, property, receiver) {
      proxyReads += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  assert.throws(
    () => summaryExitCode(proxy),
    (error) => error?.code === 'FINDINGS_DOCUMENT_INVALID',
  );
  assert.equal(proxyReads, 0);

  const inherited = structuredClone(canonical);
  Object.setPrototypeOf(inherited.summary, { inherited: true });
  assert.throws(
    () => renderPrComment(inherited),
    (error) => error?.code === 'FINDINGS_DOCUMENT_INVALID',
  );

  const symbolBacked = structuredClone(canonical);
  symbolBacked.findings[0][Symbol('hidden')] = true;
  assert.throws(
    () => renderMarkdown(symbolBacked),
    (error) => error?.code === 'FINDINGS_DOCUMENT_INVALID',
  );
});

test('exports deterministic parseable Postman, Insomnia, and Bruno artifacts without response bodies or secrets', () => {
  const { manifest, config } = exportFixture();

  for (const format of ['postman', 'insomnia', 'bruno']) {
    const first = exportCollection({ format, manifest, config });
    const reordered = exportCollection({
      format,
      manifest: { ...manifest, operations: [...manifest.operations].reverse() },
      config,
    });
    assert.deepEqual(first, reordered, format);
    assert.ok(Object.isFrozen(first));
    assert.ok(first.every(Object.isFrozen));
    assert.equal(new Set(first.map((entry) => entry.path)).size, first.length);
    assert.ok(first.every((entry) => (
      typeof entry.path === 'string'
      && !entry.path.startsWith('/')
      && !entry.path.includes('..')
      && typeof entry.mediaType === 'string'
      && typeof entry.content === 'string'
    )));

    const serialized = JSON.stringify(first);
    assert.ok(serialized.includes('requestOnlyCanary'), format);
    assert.equal(serialized.includes('responseOnlyCanary'), false, format);
    assert.equal(serialized.includes('SENSITIVE_ENUM_VALUE_MUST_NOT_APPEAR'), false, format);
    assert.equal(serialized.includes('sensitive-parameter-example'), false, format);
    assert.equal(serialized.includes('schema:response'), false, format);
    assert.equal(serialized.includes('env:'), false, format);
    assert.ok(serialized.includes('SENTINEL_ADMIN_TOKEN'), format);
    assert.ok(serialized.includes('SENTINEL_USER_TOKEN'), format);

    if (format === 'postman') {
      assert.equal(first.length, 1);
      const document = JSON.parse(first[0].content);
      assert.equal(document.info.schema, 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json');
      assert.ok(document.variable.every((entry) => entry.key === 'baseUrl' || entry.value === ''));
      const post = document.item.find((entry) => entry.request.method === 'POST');
      const patch = document.item.find((entry) => entry.request.method === 'PATCH');
      assert.deepEqual(JSON.parse(post.request.body.raw), {
        nested: { count: 2 },
        requestOnlyCanary: '',
        secretChoice: '',
      });
      assert.equal(Object.hasOwn(patch.request, 'body'), false);
    } else if (format === 'insomnia') {
      assert.equal(first.length, 1);
      const document = JSON.parse(first[0].content);
      assert.equal(document._type, 'export');
      const requests = document.resources.filter((entry) => entry._type === 'request');
      assert.equal(requests.length, 3);
      assert.equal(Object.hasOwn(requests.find((entry) => entry.method === 'PATCH'), 'body'), false);
    } else {
      assert.ok(artifact(first, 'bruno.json'));
      assert.ok(artifact(first, 'sentinel.bru'));
      assert.equal(first.filter((entry) => entry.path.startsWith('requests/')).length, 3);
      JSON.parse(artifact(first, 'bruno.json').content);
      assert.ok(first.filter((entry) => entry.path.endsWith('.bru'))
        .every((entry) => /\{[\s\S]*\}/u.test(entry.content)));
    }
  }
});

test('rejects WebSocket operations instead of exporting them as HTTP and retains unsweepable HTTP', () => {
  for (const format of ['postman', 'insomnia', 'bruno']) {
    const websocket = exportFixture();
    websocket.manifest.operations[2].protocol = 'websocket';
    websocket.manifest.operations[2].sweepable = false;
    assert.throws(
      () => exportCollection({ format, ...websocket }),
      (error) => error?.code === 'EXPORT_PROTOCOL_UNSUPPORTED',
      `${format}: websocket`,
    );

    const http = exportFixture();
    http.manifest.operations[2].sweepable = false;
    const artifacts = exportCollection({ format, ...http });
    assert.ok(JSON.stringify(artifacts).includes('/status'), `${format}: unsweepable HTTP`);
  }
});

test('rejects Bruno control injection when RegExp.test is poisoned before module import', () => {
  const fixture = exportFixture();
  fixture.manifest.operations = [fixture.manifest.operations[2]];
  const maliciousPath = '/ok\n}\nheaders {\n  X-Injected: yes\n}\nget {\n  url: http://evil.invalid';
  const moduleUrl = new URL('../../runtime/export.mjs', import.meta.url).href;
  const script = `
    const originalTest = RegExp.prototype.test;
    RegExp.prototype.test = function poisonedTest(value) {
      if (this.source.includes('\\\\p{Cc}') || this.source === '[{}]') return false;
      return Reflect.apply(originalTest, this, [value]);
    };
    const { exportCollection } = await import(${JSON.stringify(moduleUrl)});
    const fixture = ${JSON.stringify(fixture)};
    fixture.manifest.operations[0].path = ${JSON.stringify(maliciousPath)};
    try {
      const artifacts = exportCollection({ format: 'bruno', ...fixture });
      process.stdout.write(JSON.stringify(artifacts));
      process.exitCode = 9;
    } catch (error) {
      if (error?.code !== 'EXPORT_PATH_INVALID') {
        process.stderr.write(String(error?.code ?? error));
        process.exitCode = 8;
      }
    }
  `;
  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', script],
    { encoding: 'utf8' },
  );

  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.equal(result.stdout.includes('X-Injected'), false);
  assert.equal(result.stdout.includes('evil.invalid'), false);
});

test('validates final Bruno artifact paths independently of mutable slug replacements', () => {
  const fixture = exportFixture();
  const originalReplace = String.prototype.replace;
  const result = withPrototypeValue(
    String.prototype,
    'replace',
    function forgedSlug() {
      if (String(this).includes('{{baseUrl}}')) return '../../escape';
      return Reflect.apply(originalReplace, this, arguments);
    },
    () => {
      try {
        return { artifacts: exportCollection({ format: 'bruno', ...fixture }) };
      } catch (caught) {
        return { error: caught };
      }
    },
  );

  if (result.error !== undefined) {
    assert.equal(result.error.code, 'EXPORT_ARTIFACT_INVALID');
  } else {
    assert.ok(result.artifacts.every((entry) => (
      !entry.path.startsWith('/') && !entry.path.includes('..') && !entry.path.includes('\\')
    )));
  }
});

test('preserves export semantics under selective pre-import ambient prototype poisoning', () => {
  const simpleFixture = () => {
    const fixture = exportFixture();
    fixture.manifest.operations = [operation({
      id: 'op:get:/safe', method: 'GET', path: '/safe', roles: ['admin'],
    })];
    fixture.manifest.operations[0].parameters = [];
    return fixture;
  };
  const queryFixture = () => {
    const fixture = simpleFixture();
    fixture.manifest.operations[0].parameters = [{
      name: 'q', location: 'query', required: true, schema: { type: 'string' },
    }];
    return fixture;
  };

  const reference = exportFixture();
  reference.manifest.operations = [operation({
    id: 'op:post:/safe',
    method: 'POST',
    path: '/safe',
    requestSchemaId: 'schema:request',
  })];
  reference.manifest.operations[0].parameters = [];
  reference.manifest.schemas['schema:request'].schema = {
    type: 'object',
    properties: { payload: { $ref: '#/$defs/safe' } },
    $defs: {
      safe: { type: 'string' },
      evil: { type: 'object', properties: { injected: { type: 'string' } } },
    },
  };
  const referenceResult = preImportExport(reference, 'postman', `
    const original = String.prototype.replaceAll;
    String.prototype.replaceAll = function poisonedReplaceAll(search, replacement) {
      if (String(this) === 'safe' && search === '~1') return 'evil';
      return Reflect.apply(original, this, [search, replacement]);
    };
  `);
  assert.equal(referenceResult.error, undefined);
  const referenceDocument = JSON.parse(referenceResult.artifacts[0].content);
  assert.deepEqual(JSON.parse(referenceDocument.item[0].request.body.raw), { payload: '' });

  const iteratorResult = preImportExport(queryFixture(), 'postman', `
    const original = Array.prototype[Symbol.iterator];
    Array.prototype[Symbol.iterator] = function poisonedIterator() {
      if (this.length === 1 && this[0]?.name === 'q' && this[0]?.location === 'query') {
        return Reflect.apply(original, [], []);
      }
      return Reflect.apply(original, this, []);
    };
  `);
  assert.equal(iteratorResult.error, undefined);
  assert.ok(JSON.parse(iteratorResult.artifacts[0].content).item[0].request.url.raw
    .includes('?q={{q}}'));

  const filterResult = preImportExport(queryFixture(), 'postman', `
    const original = Array.prototype.filter;
    Array.prototype.filter = function poisonedFilter(callback, receiver) {
      if (this.length === 1 && this[0] === 'q') return [];
      return Reflect.apply(original, this, [callback, receiver]);
    };
  `);
  assert.equal(filterResult.error, undefined);
  assert.ok(JSON.parse(filterResult.artifacts[0].content).variable
    .some((entry) => entry.key === 'q'));

  for (const [name, poisonSource] of [
    ['map', `
      const original = Array.prototype.map;
      Array.prototype.map = function poisonedMap(callback, receiver) {
        if (this.length === 1 && this[0]?.id === 'op:get:/safe') {
          return [{ ...this[0], id: 'op:delete:/admin', method: 'DELETE', path: '/admin',
            mutation: true, sweepable: false }];
        }
        return Reflect.apply(original, this, [callback, receiver]);
      };
    `],
    ['sort', `
      const original = Array.prototype.sort;
      Array.prototype.sort = function poisonedSort(compare) {
        if (this.length === 1 && this[0]?.id === 'op:get:/safe') {
          this[0] = { ...this[0], id: 'op:delete:/admin', method: 'DELETE', path: '/admin',
            mutation: true, sweepable: false };
          return this;
        }
        return Reflect.apply(original, this, [compare]);
      };
    `],
  ]) {
    const result = preImportExport(simpleFixture(), 'postman', poisonSource);
    assert.equal(result.error, undefined, name);
    const request = JSON.parse(result.artifacts[0].content).item[0].request;
    assert.equal(request.method, 'GET', name);
    assert.equal(request.url.raw, '{{baseUrl}}/safe', name);
  }

  const duplicates = simpleFixture();
  duplicates.manifest.operations = [
    { ...structuredClone(duplicates.manifest.operations[0]), id: 'op:get:duplicate', path: '/one' },
    { ...structuredClone(duplicates.manifest.operations[0]), id: 'op:get:duplicate', path: '/two' },
  ];
  const duplicateResult = preImportExport(duplicates, 'insomnia', `
    const original = Set.prototype.add;
    Set.prototype.add = function poisonedSetAdd(value) {
      if (typeof value === 'string' && value.startsWith('op:')) return this;
      return Reflect.apply(original, this, [value]);
    };
  `);
  assert.equal(duplicateResult.error, 'EXPORT_OPERATION_INVALID');

  const authResult = preImportExport(simpleFixture(), 'postman', `
    const original = Map.prototype.set;
    Map.prototype.set = function poisonedMapSet(key, value) {
      if (key === 'admin' && value === 'SENTINEL_ADMIN_TOKEN') return this;
      return Reflect.apply(original, this, [key, value]);
    };
  `);
  assert.equal(authResult.error, undefined);
  const authDocument = JSON.parse(authResult.artifacts[0].content);
  assert.ok(authDocument.variable.some((entry) => entry.key === 'SENTINEL_ADMIN_TOKEN'));
  assert.deepEqual(authDocument.item[0].request.header.find(
    (entry) => entry.key === 'Authorization',
  ), {
    key: 'Authorization', value: 'Bearer {{SENTINEL_ADMIN_TOKEN}}', type: 'text',
  });
});

test('rejects parameter contracts that collection formats cannot represent faithfully', () => {
  const unsupported = [
    { name: 'session', location: 'cookie' },
    { name: 'Authorization', location: 'header' },
    { name: 'X-API-Key', location: 'header' },
    { name: 'Cookie', location: 'header' },
  ];
  for (const format of ['postman', 'insomnia', 'bruno']) {
    for (const parameter of unsupported) {
      const fixture = exportFixture();
      fixture.manifest.operations[2].parameters = [{
        ...parameter,
        required: true,
        schema: { type: 'string' },
      }];
      assert.throws(
        () => exportCollection({ format, ...fixture }),
        (error) => error?.code === 'EXPORT_PARAMETER_UNSUPPORTED',
        `${format}: ${parameter.location} ${parameter.name}`,
      );
    }

    const represented = exportFixture();
    represented.manifest.operations[2].parameters = [{
      name: 'X-Trace-Id',
      location: 'header',
      required: true,
      schema: { type: 'string' },
    }];
    assert.ok(
      JSON.stringify(exportCollection({ format, ...represented })).includes('X-Trace-Id'),
      `${format}: ordinary header`,
    );
  }
});

test('rejects request bodies on methods without an implemented collection-body contract', () => {
  for (const format of ['postman', 'insomnia', 'bruno']) {
    for (const method of ['GET', 'HEAD', 'OPTIONS', 'TRACE']) {
      const fixture = exportFixture();
      fixture.manifest.operations = [operation({
        id: `op:${method.toLowerCase()}:/body`,
        method,
        path: '/body',
        requestSchemaId: 'schema:request',
      })];
      assert.throws(
        () => exportCollection({ format, ...fixture }),
        (error) => error?.code === 'EXPORT_BODY_UNSUPPORTED',
        `${format}: ${method}`,
      );
    }
  }

  for (const schemaId of [null, 'schema:missing']) {
    const fixture = exportFixture();
    fixture.manifest.operations[0].requestBody.schemaId = schemaId;
    assert.throws(
      () => exportCollection({ format: 'postman', ...fixture }),
      (error) => error?.code === 'EXPORT_SCHEMA_INVALID',
      `request schema ${String(schemaId)}`,
    );
  }
});

test('exports JSON media types faithfully and rejects non-JSON request encodings', () => {
  const supported = [
    'application/json',
    'application/json;charset=utf-8',
    'application/problem+json',
    'application/problem+json; profile=example',
  ];
  const unsupported = [
    'text/plain',
    'application/x-www-form-urlencoded',
    'multipart/form-data',
  ];
  for (const format of ['postman', 'insomnia', 'bruno']) {
    for (const contentType of supported) {
      const fixture = exportFixture();
      fixture.manifest.operations[0].requestBody.contentType = contentType;
      const artifacts = exportCollection({ format, ...fixture });
      assert.ok(JSON.stringify(artifacts).includes(contentType), `${format}: ${contentType}`);
      assert.ok(JSON.stringify(artifacts).includes('requestOnlyCanary'), `${format}: JSON body`);
    }
    for (const contentType of unsupported) {
      const fixture = exportFixture();
      fixture.manifest.operations[0].requestBody.contentType = contentType;
      assert.throws(
        () => exportCollection({ format, ...fixture }),
        (error) => error?.code === 'EXPORT_MEDIA_TYPE_UNSUPPORTED',
        `${format}: ${contentType}`,
      );
    }
  }
});

test('rejects ambiguous origins, unsupported formats, unsafe paths, limits, and malformed secret references', () => {
  const { manifest, config } = exportFixture();
  const failures = [
    {
      code: 'EXPORT_FORMAT_UNSUPPORTED',
      call: () => exportCollection({ format: 'curl', manifest, config }),
    },
    {
      code: 'EXPORT_ORIGIN_AMBIGUOUS',
      call: () => exportCollection({
        format: 'postman', manifest, config: { ...config, approvedOrigins: [] },
      }),
    },
    {
      code: 'EXPORT_ORIGIN_AMBIGUOUS',
      call: () => exportCollection({
        format: 'postman',
        manifest,
        config: { ...config, approvedOrigins: ['http://127.0.0.1:1', 'http://127.0.0.1:2'] },
      }),
    },
    {
      code: 'EXPORT_SECRET_REF_INVALID',
      call: () => exportCollection({
        format: 'postman',
        manifest,
        config: { ...config, roles: { admin: { tokenRef: 'literal-secret' } } },
      }),
    },
  ];
  const unsafePaths = [
    'https://evil.invalid/items',
    '//evil.invalid/items',
    '/items\\child',
    '/items?admin=true',
    '/items#fragment',
    '/items/../admin',
    '/items/%2e%2e/admin',
    '/items/%252e%252e/admin',
    '/items/%2Fadmin',
    '/items/%253fadmin',
    '/items\u0000admin',
  ];
  for (const unsafePath of unsafePaths) {
    const changed = structuredClone(manifest);
    changed.operations[0].path = unsafePath;
    failures.push({
      code: 'EXPORT_PATH_INVALID',
      call: () => exportCollection({ format: 'postman', manifest: changed, config }),
    });
  }

  const tooMany = structuredClone(manifest);
  tooMany.operations = Array.from({ length: 1001 }, (_, index) => ({
    ...structuredClone(manifest.operations[2]),
    id: `op:get:/bounded/${index}`,
    path: `/bounded/${index}`,
  }));
  failures.push({
    code: 'EXPORT_LIMIT_EXCEEDED',
    call: () => exportCollection({ format: 'postman', manifest: tooMany, config }),
  });

  const tooDeep = structuredClone(manifest);
  let schema = { type: 'string' };
  for (let index = 0; index < 25; index += 1) {
    schema = {
      type: 'object',
      required: [`level${index}`],
      properties: { [`level${index}`]: schema },
    };
  }
  tooDeep.schemas['schema:request'].schema = schema;
  failures.push({
    code: 'EXPORT_LIMIT_EXCEEDED',
    call: () => exportCollection({ format: 'postman', manifest: tooDeep, config }),
  });

  for (const failure of failures) {
    assert.throws(failure.call, (error) => error?.code === failure.code, failure.code);
  }
});

test('rejects trusted-variable collisions and header-injecting request media types', () => {
  const { manifest, config } = exportFixture();
  const collisions = ['baseUrl', 'SENTINEL_ADMIN_TOKEN'];
  for (const name of collisions) {
    const changed = structuredClone(manifest);
    changed.operations[0].parameters = [{
      name,
      location: 'query',
      required: false,
      schema: { type: 'string' },
    }];
    assert.throws(
      () => exportCollection({ format: 'postman', manifest: changed, config }),
      (error) => error?.code === 'EXPORT_VARIABLE_COLLISION',
      name,
    );
  }

  const injectedMediaType = structuredClone(manifest);
  injectedMediaType.operations[0].requestBody.contentType = 'application/json\nAuthorization: injected';
  assert.throws(
    () => exportCollection({ format: 'bruno', manifest: injectedMediaType, config }),
    (error) => error?.code === 'EXPORT_SCHEMA_INVALID',
  );
});

test('preserves an own __proto__ request-schema property without mutating prototypes', () => {
  const { manifest, config } = exportFixture();
  manifest.schemas['schema:request'].schema = JSON.parse(`{
    "type": "object",
    "required": ["__proto__", "safe"],
    "properties": {
      "__proto__": { "type": "string" },
      "safe": { "type": "string" }
    }
  }`);

  const exported = exportCollection({ format: 'postman', manifest, config });
  const document = JSON.parse(exported[0].content);
  const post = document.item.find((entry) => entry.request.method === 'POST');
  const body = JSON.parse(post.request.body.raw);

  assert.equal(Object.hasOwn(body, '__proto__'), true);
  assert.deepEqual(body.__proto__, '');
  assert.equal(Object.prototype.polluted, undefined);
});

test('collision-proofs sanitized Bruno request filenames', () => {
  const { manifest, config } = exportFixture();
  manifest.operations = [
    operation({ id: 'op:get:/foo_bar', method: 'GET', path: '/foo_bar' }),
    operation({ id: 'op:get:/foo-bar', method: 'GET', path: '/foo-bar' }),
  ];
  const artifacts = exportCollection({ format: 'bruno', manifest, config });
  const requests = artifacts.filter((entry) => entry.path.startsWith('requests/'));

  assert.equal(requests.length, 2);
  assert.notEqual(requests[0].path, requests[1].path);
  assert.ok(requests.every((entry) => /^requests\/[0-9]{3}-[a-z0-9-]+-[a-f0-9]{12}\.bru$/u
    .test(entry.path)));
});

test('rejects non-canonical findings documents at every report boundary', () => {
  const invalid = structuredClone(canonical);
  invalid.summary.injected = 1;

  for (const consumer of [renderMarkdown, renderDashboard, renderPrComment, summaryExitCode]) {
    assert.throws(
      () => consumer(invalid),
      (error) => error?.code === 'FINDINGS_DOCUMENT_INVALID',
    );
  }
});

test('resolves request-only registry and local schema references without consulting responses', () => {
  const { manifest, config } = exportFixture();
  manifest.schemas['schema:request'].schema = {
    type: 'object',
    properties: {
      nested: { $ref: 'schema:openapi:Nested' },
      local: { $ref: '#/$defs/local' },
    },
    $defs: {
      local: {
        type: 'object',
        properties: { localRequestCanary: { type: 'string' } },
      },
    },
  };
  manifest.schemas['schema:openapi:Nested'] = {
    schema: {
      type: 'object',
      properties: { registryRequestCanary: { type: 'string' } },
    },
    provenance: {
      adapter: 'openapi-json', file: 'openapi.json', pointer: '#/components/Nested',
    },
  };

  const artifacts = exportCollection({ format: 'postman', manifest, config });
  const serialized = JSON.stringify(artifacts);
  assert.ok(serialized.includes('registryRequestCanary'));
  assert.ok(serialized.includes('localRequestCanary'));
  assert.equal(serialized.includes('responseOnlyCanary'), false);
});

test('rejects request schemas inherited from Object.prototype', () => {
  const fixture = exportFixture();
  const schemaId = 'schema:prototype-only';
  const inheritedCanary = 'INHERITED_REQUEST_SCHEMA_CANARY';
  fixture.manifest.operations[1].requestBody = {
    required: true,
    contentType: 'application/json',
    schemaId,
  };
  const previous = Object.getOwnPropertyDescriptor(Object.prototype, schemaId);
  Object.defineProperty(Object.prototype, schemaId, {
    configurable: true,
    enumerable: false,
    value: {
      schema: {
        type: 'object',
        properties: { [inheritedCanary]: { type: 'string' } },
      },
    },
  });

  try {
    assert.throws(
      () => exportCollection({ format: 'postman', ...fixture }),
      (error) => error?.code === 'EXPORT_SCHEMA_INVALID'
        && !JSON.stringify(error).includes(inheritedCanary),
    );
  } finally {
    if (previous === undefined) delete Object.prototype[schemaId];
    else Object.defineProperty(Object.prototype, schemaId, previous);
  }
});

test('rejects fixed-point encoded traversal and Unicode line separators in every export format', () => {
  for (const format of ['postman', 'insomnia', 'bruno']) {
    const traversal = exportFixture();
    let encodedTraversal = '%2e%2e';
    for (let layer = 1; layer < 5; layer += 1) {
      encodedTraversal = encodedTraversal.replaceAll('%', '%25');
    }
    traversal.manifest.operations[0].path = `/${encodedTraversal}/escape`;
    assert.throws(
      () => exportCollection({ format, ...traversal }),
      (error) => error?.code === 'EXPORT_PATH_INVALID',
      `${format} traversal`,
    );

    const separator = exportFixture();
    separator.manifest.operations[0].path = '/items\u2028injected\u2029block';
    assert.throws(
      () => exportCollection({ format, ...separator }),
      (error) => error?.code === 'EXPORT_PATH_INVALID',
      `${format} line separator`,
    );
  }
});

test('normalizes the single approved origin through the canonical origin parser', () => {
  const { manifest, config } = exportFixture();
  config.approvedOrigins = ['HTTP://LOCALHOST:80'];
  const artifacts = exportCollection({ format: 'postman', manifest, config });
  const document = JSON.parse(artifacts[0].content);
  assert.deepEqual(document.variable.find((entry) => entry.key === 'baseUrl'), {
    key: 'baseUrl', value: 'http://localhost', type: 'string',
  });
});

test('rejects accessor-backed paths and media types before any getter can inject output', () => {
  const pathFixture = exportFixture();
  let pathReads = 0;
  Object.defineProperty(pathFixture.manifest.operations[0], 'path', {
    enumerable: true,
    get() {
      pathReads += 1;
      return pathReads === 1 ? '/items' : '/items\u2028headers { injected: yes }';
    },
  });
  assert.throws(
    () => exportCollection({ format: 'bruno', ...pathFixture }),
    (error) => error?.code === 'EXPORT_INPUT_INVALID',
  );
  assert.equal(pathReads, 0);

  const mediaFixture = exportFixture();
  let mediaReads = 0;
  Object.defineProperty(mediaFixture.manifest.operations[0].requestBody, 'contentType', {
    enumerable: true,
    get() {
      mediaReads += 1;
      return mediaReads < 3 ? 'application/json' : 'application/json\u2028headers { injected: yes }';
    },
  });
  assert.throws(
    () => exportCollection({ format: 'bruno', ...mediaFixture }),
    (error) => error?.code === 'EXPORT_INPUT_INVALID',
  );
  assert.equal(mediaReads, 0);
});

test('strictly snapshots export manifest/config trees and rejects inherited or non-JSON input', () => {
  const cases = [];

  const unknownManifest = exportFixture();
  unknownManifest.manifest.operations[0].injected = true;
  cases.push(unknownManifest);

  const unknownRole = exportFixture();
  unknownRole.config.roles.admin.plaintext = 'must-not-be-accepted';
  cases.push(unknownRole);

  const inherited = exportFixture();
  Object.setPrototypeOf(inherited.config.roles, { inherited: true });
  cases.push(inherited);

  const symbolBacked = exportFixture();
  symbolBacked.manifest[Symbol('hidden')] = true;
  cases.push(symbolBacked);

  const cyclic = exportFixture();
  cyclic.config.roles.admin.cycle = cyclic.config.roles.admin;
  cases.push(cyclic);

  const nonFinite = exportFixture();
  nonFinite.manifest.operations[0].parameters[0].example = Number.POSITIVE_INFINITY;
  cases.push(nonFinite);

  for (const value of cases) {
    assert.throws(
      () => exportCollection({ format: 'postman', ...value }),
      (error) => ['EXPORT_INPUT_INVALID', 'EXPORT_MANIFEST_INVALID', 'EXPORT_CONFIG_INVALID']
        .includes(error?.code),
    );
  }
});

test('accepts trusted null-prototype export manifest and config trees', () => {
  function nullPrototype(value) {
    if (Array.isArray(value)) return value.map(nullPrototype);
    if (value === null || typeof value !== 'object') return value;
    const result = Object.create(null);
    for (const [key, child] of Object.entries(value)) {
      Object.defineProperty(result, key, {
        configurable: true,
        enumerable: true,
        value: nullPrototype(child),
        writable: true,
      });
    }
    return result;
  }

  const fixture = exportFixture();
  const artifacts = exportCollection(nullPrototype({ format: 'postman', ...fixture }));
  assert.equal(artifacts.length, 1);
  assert.doesNotThrow(() => JSON.parse(artifacts[0].content));
});

test('enforces global schema-work, parameter, body, and artifact-byte budgets', () => {
  const branching = exportFixture();
  branching.manifest.schemas['schema:request'].schema = {
    allOf: Array.from({ length: 142 }, () => ({
      allOf: Array.from({ length: 142 }, () => ({ type: 'string' })),
    })),
  };
  assert.throws(
    () => exportCollection({ format: 'postman', ...branching }),
    (error) => error?.code === 'EXPORT_LIMIT_EXCEEDED',
    'global schema work',
  );

  const parameters = exportFixture();
  parameters.manifest.operations = [parameters.manifest.operations[2]];
  parameters.manifest.operations[0].parameters = Array.from({ length: 10_001 }, (_, index) => ({
    name: `p${index}`,
    location: 'query',
    required: false,
    schema: { type: 'string' },
    example: null,
  }));
  assert.throws(
    () => exportCollection({ format: 'postman', ...parameters }),
    (error) => error?.code === 'EXPORT_LIMIT_EXCEEDED',
    'global parameters',
  );

  const output = exportFixture();
  const wideProperties = Object.fromEntries(Array.from({ length: 200 }, (_, index) => [
    `${String(index).padStart(3, '0')}-${'x'.repeat(240)}`,
    { type: 'string' },
  ]));
  output.manifest.schemas['schema:request'].schema = {
    type: 'object', properties: wideProperties,
  };
  output.manifest.operations = Array.from({ length: 80 }, (_, index) => ({
    ...structuredClone(output.manifest.operations[0]),
    id: `op:post:/bulk-${index}`,
    path: `/bulk-${index}`,
  }));
  assert.throws(
    () => exportCollection({ format: 'postman', ...output }),
    (error) => error?.code === 'EXPORT_LIMIT_EXCEEDED',
    'global output bytes',
  );
});

test('exports a deeply shared request-schema DAG within bounded validation time', () => {
  const fixture = exportFixture();
  let shared = { type: 'string' };
  for (let depth = 0; depth < 20; depth += 1) {
    shared = { allOf: [shared, shared] };
  }
  fixture.manifest.schemas['schema:request'].schema = shared;

  const startedAt = performance.now();
  const artifacts = exportCollection({ format: 'postman', ...fixture });
  const elapsedMs = performance.now() - startedAt;

  assert.ok(elapsedMs < 1000, `shared DAG validation took ${elapsedMs.toFixed(1)}ms`);
  assert.equal(artifacts.length, 1);
});
