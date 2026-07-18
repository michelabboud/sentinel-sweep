import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { exportCollection } from '../../runtime/export.mjs';
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
      requestSchemaId: 'schema:missing',
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

test('renders the exact golden Markdown byte-for-byte on repeated calls', () => {
  const first = renderMarkdown(canonical);
  const second = renderMarkdown(structuredClone(canonical));

  assert.equal(first, expectedMarkdown);
  assert.equal(second, expectedMarkdown);
  assert.equal(Buffer.compare(Buffer.from(first), Buffer.from(second)), 0);
});

test('escapes Markdown, HTML, and embedded JSON independently without remote assets', () => {
  const hostile = structuredClone(canonical);
  hostile.findings[0].message = '<script>alert("x")</script>\n# injected | `code` & [link](javascript:x) _italic_';
  hostile.findings[1].message = `line separator   paragraph   </script><img src=x onerror=alert(1)>`;
  hostile.coverage.diagnostics[0].message = '| table escape <iframe src="https://evil.invalid">';

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

test('uses the canonical summary for PR output and exit status without recomputing findings', () => {
  const deliberatelyDifferent = structuredClone(canonical);
  deliberatelyDifferent.summary = {
    critical: 0, error: 0, warning: 8, info: 5, skipped: 3,
  };

  const pr = renderPrComment(deliberatelyDifferent);
  assert.ok(pr.includes('Critical 0'));
  assert.ok(pr.includes('Error 0'));
  assert.ok(pr.includes('Warning 8'));
  assert.ok(pr.includes('Info 5'));
  assert.ok(pr.includes('Skipped 3'));
  assert.equal(summaryExitCode(deliberatelyDifferent), 0);

  deliberatelyDifferent.summary.error = 1;
  assert.equal(summaryExitCode(deliberatelyDifferent), 2);
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
