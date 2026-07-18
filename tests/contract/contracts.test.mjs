import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  loadBundledSchema,
  validateAgainstSchema,
} from '../../runtime/lib/schema.mjs';

const defaults = JSON.parse(
  await readFile(new URL('../../settings.json', import.meta.url), 'utf8'),
);

const documents = {
  settings: defaults,
  'sentinel-manifest': {
    schemaVersion: '2.0',
    generatedAt: '2026-07-18T00:00:00.000Z',
    target: { name: 'fixture', root: '.' },
    coverage: { status: 'complete', diagnostics: [] },
    routes: [],
    operations: [],
    schemas: {},
  },
  findings: {
    schemaVersion: '2.0',
    runId: '2026-07-18T00-00-00-000Z',
    startedAt: '2026-07-18T00:00:00.000Z',
    finishedAt: '2026-07-18T00:00:01.000Z',
    requireCompleteCoverage: false,
    coverage: { status: 'complete', diagnostics: [] },
    summary: {
      critical: 0,
      error: 0,
      warning: 0,
      info: 0,
      skipped: 0,
    },
    findings: [],
  },
  'sweep-history': {
    schemaVersion: '2.0',
    runs: [],
  },
};

const realisticManifest = {
  schemaVersion: '2.0',
  generatedAt: '2026-07-18T00:00:00.000Z',
  target: { name: 'fixture', root: '.' },
  coverage: { status: 'complete', diagnostics: [] },
  routes: [
    {
      id: 'route:/items/{itemId}',
      path: '/items/{itemId}',
      name: 'item-detail',
      component: 'ItemDetail',
      aliases: ['/inventory/{itemId}'],
      auth: { state: 'required', allowedRoles: ['user', 'admin'] },
      parameters: [
        {
          name: 'itemId',
          location: 'path',
          required: true,
          schema: { type: 'string' },
          example: 'known-item',
        },
      ],
      provenance: {
        adapter: 'vue-router-static',
        file: 'src/router.js',
        pointer: '/routes/0',
      },
    },
  ],
  operations: [
    {
      id: 'op:get:/api/items/{itemId}',
      method: 'GET',
      path: '/api/items/{itemId}',
      summary: 'Read one item',
      parameters: [
        {
          name: 'itemId',
          location: 'path',
          required: true,
          schema: { type: 'string' },
          example: 'known-item',
        },
      ],
      requestBody: null,
      responses: {
        200: {
          contentType: 'application/json',
          schemaId: 'schema:openapi:Item',
        },
      },
      auth: { state: 'required', allowedRoles: ['user', 'admin'] },
      targetModel: 'schema:openapi:Item',
      deleteMode: null,
      sideEffects: { state: 'known', classes: [] },
      rollback: null,
      mutation: false,
      protocol: 'http',
      sweepable: true,
      risk: { score: 0, level: 'safe', reasons: [] },
      provenance: {
        adapter: 'openapi-json',
        file: 'openapi.json',
        pointer: '/paths/~1api~1items~1{itemId}/get',
      },
    },
    {
      id: 'op:post:/api/items',
      method: 'POST',
      path: '/api/items',
      summary: 'Create an item',
      parameters: [],
      requestBody: {
        required: true,
        contentType: 'application/json',
        schemaId: 'schema:openapi:ItemCreate',
      },
      responses: {
        201: {
          contentType: 'application/json',
          schemaId: 'schema:openapi:Item',
        },
      },
      auth: { state: 'unknown', allowedRoles: [] },
      targetModel: 'schema:openapi:Item',
      deleteMode: null,
      sideEffects: { state: 'unknown', classes: [] },
      rollback: null,
      mutation: true,
      protocol: 'http',
      sweepable: true,
      risk: { score: 100, level: 'critical', reasons: ['unknown-side-effects'] },
      provenance: {
        adapter: 'openapi-json',
        file: 'openapi.json',
        pointer: '/paths/~1api~1items/post',
      },
    },
    {
      id: 'op:trace:/api/items',
      method: 'TRACE',
      path: '/api/items',
      summary: null,
      parameters: [],
      requestBody: null,
      responses: {
        default: { contentType: null, schemaId: null },
      },
      auth: { state: 'public', allowedRoles: [] },
      targetModel: null,
      deleteMode: null,
      sideEffects: { state: 'unknown', classes: [] },
      rollback: null,
      mutation: true,
      protocol: 'http',
      sweepable: true,
      risk: { score: 100, level: 'critical', reasons: ['unknown-side-effects'] },
      provenance: {
        adapter: 'openapi-json',
        file: 'openapi.json',
        pointer: '/paths/~1api~1items/trace',
      },
    },
  ],
  schemas: {
    'schema:openapi:Item': {
      schema: {
        type: 'object',
        required: ['id'],
        additionalProperties: false,
        properties: { id: { type: 'string' } },
      },
      provenance: {
        adapter: 'openapi-json',
        file: 'openapi.json',
        pointer: '/components/schemas/Item',
      },
    },
    'schema:openapi:ItemCreate': {
      schema: {
        type: 'object',
        required: ['name'],
        additionalProperties: false,
        properties: { name: { type: 'string', minLength: 1 } },
      },
      provenance: {
        adapter: 'openapi-json',
        file: 'openapi.json',
        pointer: '/components/schemas/ItemCreate',
      },
    },
  },
};

const schemas = Object.fromEntries(
  await Promise.all(
    Object.keys(documents).map(async (name) => [name, await loadBundledSchema(name)]),
  ),
);

test('loads all four strict v2 bundled schemas', () => {
  assert.deepEqual(
    Object.values(schemas).map((schema) => schema.$id),
    [
      'sentinel-settings-v2',
      'sentinel-manifest-v2',
      'sentinel-findings-v2',
      'sentinel-history-v2',
    ],
  );
});

test('validates bundled defaults and minimal v2 artifacts', () => {
  for (const [name, document] of Object.entries(documents)) {
    assert.doesNotThrow(() => {
      validateAgainstSchema(document, schemas[name], { name });
    });
  }
});

test('requires canonical findings to bind the trusted coverage policy decision', () => {
  const missingPolicyBinding = structuredClone(documents.findings);
  delete missingPolicyBinding.requireCompleteCoverage;

  assert.throws(
    () => validateAgainstSchema(missingPolicyBinding, schemas.findings, { name: 'findings' }),
    (error) => {
      assert.deepEqual(error?.details?.violations, [
        { path: '/requireCompleteCoverage', keyword: 'required' },
      ]);
      return true;
    },
  );
});

test('rejects a bundled history document with 129 runs at the schema boundary', () => {
  const run = {
    startedAt: '2026-07-18T00:00:00.000Z',
    finishedAt: '2026-07-18T00:00:01.000Z',
    coverageStatus: 'complete',
    summary: { critical: 0, error: 0, warning: 0, info: 0, skipped: 0 },
    findingsDigest: '1'.repeat(64),
    markerToken: '2'.repeat(64),
    dev: '1',
    ino: '1',
    birthtimeNs: '1',
    uid: '1000',
    mode: '16832',
  };
  const history = {
    schemaVersion: '2.0',
    runs: Array.from({ length: 129 }, (_, index) => ({
      ...run,
      runId: `2026-07-18T00-00-00-000Z-${(index + 1).toString(16).padStart(8, '0')}`,
    })),
  };

  assert.throws(
    () => validateAgainstSchema(history, schemas['sweep-history'], { name: 'history' }),
    (error) => {
      assert.deepEqual(error?.details?.violations, [
        { path: '/runs', keyword: 'maxItems' },
      ]);
      return true;
    },
  );
});

test('validates a realistic non-empty manifest using later-task interfaces', () => {
  assert.doesNotThrow(() => {
    validateAgainstSchema(
      realisticManifest,
      schemas['sentinel-manifest'],
      { name: 'realistic manifest' },
    );
  });
});

test('rejects whitespace-only rollback instructions', () => {
  const manifest = JSON.parse(JSON.stringify(realisticManifest));
  manifest.operations[1].rollback = ' \t\n';

  assert.throws(
    () => validateAgainstSchema(
      manifest,
      schemas['sentinel-manifest'],
      { name: 'rollback contract' },
    ),
    (error) => {
      assert.deepEqual(error.details.violations, [
        { path: '/operations/1/rollback', keyword: 'pattern' },
      ]);
      return true;
    },
  );
});

for (const invalidCase of [
  { operationIndex: 2, method: 'DELETE', mutation: false },
  { operationIndex: 2, method: 'TRACE', mutation: false },
  { operationIndex: 0, method: 'GET', mutation: true },
]) {
  test(`rejects ${invalidCase.method} with mutation=${invalidCase.mutation} at the operation consistency combinator`, () => {
    const manifest = JSON.parse(JSON.stringify(realisticManifest));
    const operation = manifest.operations[invalidCase.operationIndex];
    operation.method = invalidCase.method;
    operation.mutation = invalidCase.mutation;

    assert.throws(
      () => validateAgainstSchema(
        manifest,
        schemas['sentinel-manifest'],
        { name: 'method mutation consistency' },
      ),
      (error) => {
        assert.deepEqual(error.details.violations, [
          {
            path: `/operations/${invalidCase.operationIndex}`,
            keyword: 'oneOf',
          },
        ]);
        return true;
      },
      `${invalidCase.method} with mutation=${invalidCase.mutation}`,
    );
  });
}

test('bundled defaults are explicit and fail closed', () => {
  assert.deepEqual(defaults, {
    schemaVersion: '2.0',
    requireConfigPath: true,
    reportDir: 'sentinel-reports',
    approvedOrigins: [],
    roles: {},
    allowMutations: false,
    mutationAllowlist: [],
    allowNonLoopback: false,
    targetEnvironment: 'unknown',
    requireCompleteCoverage: true,
    maxConcurrency: 4,
    responseTimeoutMs: 5000,
    browserSettleMs: 500,
    viewports: [375, 768, 1280],
    screenshotOnError: true,
  });
});

test('browser settle quiet window is required and strictly bounded', () => {
  assert.deepEqual(
    schemas.settings.required.includes('browserSettleMs'),
    true,
  );
  assert.deepEqual(schemas.settings.properties.browserSettleMs, {
    type: 'integer',
    minimum: 1,
    maximum: 10000,
  });
  for (const browserSettleMs of [0, 1.5, 10001]) {
    assert.throws(
      () => validateAgainstSchema(
        { ...defaults, browserSettleMs },
        schemas.settings,
        { name: 'settings' },
      ),
      (error) => error.code === 'SCHEMA_INVALID'
        && error.details.violations.some((violation) => (
          violation.path === '/browserSettleMs'
        )),
    );
  }
});

test('rejects legacy schema versions', () => {
  for (const [name, document] of Object.entries(documents)) {
    assert.throws(
      () => validateAgainstSchema(
        { ...document, schemaVersion: '1.8' },
        schemas[name],
        { name },
      ),
      (error) => error.code === 'SCHEMA_INVALID',
      `${name} should reject schemaVersion 1.8`,
    );
  }
});

test('rejects plaintext password and token role fields', () => {
  for (const forbidden of ['password', 'token']) {
    assert.throws(
      () => validateAgainstSchema(
        {
          ...defaults,
          roles: {
            admin: { [forbidden]: 'plaintext-secret' },
          },
        },
        schemas.settings,
        { name: 'settings' },
      ),
      (error) => error.code === 'SCHEMA_INVALID'
        && !JSON.stringify(error.toJSON()).includes('plaintext-secret'),
    );
  }
});

test('requires exact uppercase bounded environment secret references', () => {
  const tokenRefPattern = schemas.settings.$defs.role.properties.tokenRef.pattern;
  assert.equal(tokenRefPattern, '^env:[A-Z][A-Z0-9_]{1,127}$');

  const validRefs = [
    'env:A_',
    'env:ADMIN_TOKEN',
    `env:A${'_'.repeat(127)}`,
  ];
  for (const tokenRef of validRefs) {
    assert.doesNotThrow(() => {
      validateAgainstSchema(
        { ...defaults, roles: { admin: { tokenRef } } },
        schemas.settings,
        { name: 'settings' },
      );
    }, tokenRef);
  }

  const invalidRefs = [
    'env:A',
    'env:admin_token',
    'env:_ADMIN_TOKEN',
    'env:ADMIN-TOKEN',
    'env:ADMIN_TOKEN ',
    `env:A${'_'.repeat(128)}`,
    'plaintext-secret',
  ];
  for (const tokenRef of invalidRefs) {
    assert.throws(
      () => validateAgainstSchema(
        { ...defaults, roles: { admin: { tokenRef } } },
        schemas.settings,
        { name: 'settings' },
      ),
      (error) => error.code === 'SCHEMA_INVALID'
        && error.details.violations.some((violation) => (
          violation.path === '/roles/admin/tokenRef'
          && violation.keyword === 'pattern'
        )),
      tokenRef,
    );
  }
});

test('rejects unknown properties at every top-level contract', () => {
  for (const [name, document] of Object.entries(documents)) {
    assert.throws(
      () => validateAgainstSchema(
        { ...document, unexpected: true },
        schemas[name],
        { name },
      ),
      (error) => error.code === 'SCHEMA_INVALID',
      `${name} should reject unknown top-level properties`,
    );
  }
});

test('settings contract accepts only canonical discovery and trusted overrides', () => {
  const operation = '4ebcfbf48f6c96aeeb09c6a09bb2ae383d006ff8198a62c0fe6a1d3335c00acf';
  const route = '7b9bf97b401a4283c8aea2004d995d774faea945f8fe6c66e92248d49e585979';
  const canonical = {
    ...defaults,
    discovery: {
      openapi: ['openapi.json'],
      vueRouter: ['src/router.ts'],
    },
    trustedOverrides: {
      operations: {
        [operation]: {
          allowedRoles: ['admin'],
          parameterExamples: [
            { location: 'query', name: 'page', value: 1 },
          ],
          targetModel: 'Admin',
          deleteMode: 'hard',
          sideEffects: { classes: ['data-delete'] },
          rollback: 'restore-admin',
        },
      },
      routes: {
        [route]: {
          allowedRoles: ['admin'],
          parameterExamples: [
            { location: 'path', name: 'id', value: 'known-admin' },
          ],
        },
      },
    },
  };

  assert.doesNotThrow(() => {
    validateAgainstSchema(canonical, schemas.settings, { name: 'canonical settings' });
  });
});

test('settings contract rejects every discovery and override alias', () => {
  const id = '4ebcfbf48f6c96aeeb09c6a09bb2ae383d006ff8198a62c0fe6a1d3335c00acf';
  const discovery = { discovery: { openapi: ['openapi.json'] } };
  const aliases = [
    { openapi: ['openapi.json'] },
    { openapiPaths: ['openapi.json'] },
    { vueRouter: ['src/router.ts'] },
    { vueRouterPaths: ['src/router.ts'] },
    { ...discovery, operationOverrides: { [id]: { allowedRoles: ['admin'] } } },
    { ...discovery, routeOverrides: {} },
    { ...discovery, operationRoles: { [id]: ['admin'] } },
    { ...discovery, routeRoles: {} },
    {
      ...discovery,
      parameterExamples: [{
        operationId: id,
        location: 'query',
        name: 'page',
        value: 1,
      }],
    },
    {
      ...discovery,
      trustedOverrides: { [id]: { allowedRoles: ['admin'] } },
    },
    {
      ...discovery,
      trustedOverrides: {
        operations: { [id]: { parameterExamples: { page: 1 } } },
      },
    },
    {
      ...discovery,
      trustedOverrides: {
        operations: { [id]: { sideEffects: ['data-write'] } },
      },
    },
    {
      ...discovery,
      trustedOverrides: {
        operations: {
          [id]: { sideEffects: { classes: ['data-write'], rollback: 'undo' } },
        },
      },
    },
  ];

  for (const alias of aliases) {
    assert.throws(
      () => validateAgainstSchema(
        { ...defaults, ...alias },
        schemas.settings,
        { name: 'alias settings' },
      ),
      (error) => error?.code === 'SCHEMA_INVALID',
      JSON.stringify(alias),
    );
  }
});

test('settings contract rejects unknown properties at every canonical nested level', () => {
  const id = '4ebcfbf48f6c96aeeb09c6a09bb2ae383d006ff8198a62c0fe6a1d3335c00acf';
  const cases = [
    { discovery: { openapi: ['openapi.json'], unknown: true } },
    {
      discovery: { openapi: ['openapi.json'] },
      trustedOverrides: { operations: {}, routes: {}, unknown: true },
    },
    {
      discovery: { openapi: ['openapi.json'] },
      trustedOverrides: { operations: { [id]: { unknown: true } }, routes: {} },
    },
    {
      discovery: { openapi: ['openapi.json'] },
      trustedOverrides: {
        operations: { [id]: { sideEffects: { classes: [], unknown: true } } },
        routes: {},
      },
    },
    {
      discovery: { openapi: ['openapi.json'] },
      trustedOverrides: {
        operations: {
          [id]: {
            parameterExamples: [
              { location: 'query', name: 'page', value: 1, unknown: true },
            ],
          },
        },
        routes: {},
      },
    },
  ];

  for (const nested of cases) {
    assert.throws(
      () => validateAgainstSchema(
        { ...defaults, ...nested },
        schemas.settings,
        { name: 'strict nested settings' },
      ),
      (error) => error?.code === 'SCHEMA_INVALID',
      JSON.stringify(nested),
    );
  }
});
