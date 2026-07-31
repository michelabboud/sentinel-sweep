import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { MAX_VUE_LITERAL_DEPTH } from '../../runtime/discovery/limits.mjs';
import { discoverVueRouter } from '../../runtime/discovery/vue-router.mjs';
import { SentinelError } from '../../runtime/lib/errors.mjs';
import { TargetBoundary } from '../../runtime/lib/fs-boundary.mjs';

const fixtureDirectory = fileURLToPath(new URL('../fixtures/discovery/', import.meta.url));
const DISCOVERY_INPUT_LIMIT = 16 * 1024 * 1024;

async function fixtureBoundary() {
  return TargetBoundary.create(fixtureDirectory);
}

test('discovers complete literal Vue Router records with Vue child, alias, auth, and parameter semantics', async () => {
  const boundary = await fixtureBoundary();
  const relativePaths = [
    'vue-complete/public-router.ts',
    'vue-complete/router.js',
  ];

  const first = await discoverVueRouter({ boundary, relativePaths });
  const second = await discoverVueRouter({ boundary, relativePaths: [...relativePaths].reverse() });

  assert.deepEqual(first, second);
  assert.deepEqual(first.coverage, {
    adapter: 'vue-router-static',
    status: 'complete',
    gaps: [],
  });
  assert.deepEqual(first.routes.map((route) => route.path), [
    '/about',
    '/admin',
    '/admin/reports/{slug}',
    '/admin/users/{id}',
    '/files/{pathMatch}',
    '/landing',
    '/login',
  ]);
  assert.equal(first.routes.some((route) => route.path === '/must-not-be-discovered'), false);
  assert.equal(first.routes.filter((route) => route.path === '/landing').length, 1);
  assert.deepEqual(
    first.routes.find((route) => route.path === '/landing'),
    {
      id: 'route:/landing',
      path: '/landing',
      name: 'landing',
      component: 'LandingView',
      aliases: ['/home', '/welcome'],
      auth: { state: 'public', allowedRoles: [] },
      parameters: [],
      provenance: {
        adapter: 'vue-router-static',
        file: 'vue-complete/router.js',
        pointer: '/routes/1/children/0',
      },
    },
  );

  const admin = first.routes.find((route) => route.path === '/admin');
  assert.deepEqual(admin.auth, { state: 'required', allowedRoles: [] });
  assert.deepEqual(admin.aliases, ['/control']);

  const user = first.routes.find((route) => route.path === '/admin/users/{id}');
  assert.deepEqual(user.aliases, ['/admin/members/{id}', '/users/{id}']);
  assert.deepEqual(user.parameters, [{
    name: 'id',
    location: 'path',
    required: true,
    schema: { type: 'string' },
  }]);
  assert.deepEqual(user.auth, { state: 'required', allowedRoles: [] });

  const report = first.routes.find((route) => route.path === '/admin/reports/{slug}');
  assert.deepEqual(report.parameters, [{
    name: 'slug',
    location: 'path',
    required: false,
    schema: { type: 'string' },
  }]);

  const files = first.routes.find((route) => route.path === '/files/{pathMatch}');
  assert.deepEqual(files.aliases, ['/assets/{pathMatch}']);
  assert.deepEqual(files.parameters, [{
    name: 'pathMatch',
    location: 'path',
    required: false,
    schema: { type: 'string' },
  }]);

  assert.deepEqual(
    first.routes.find((route) => route.path === '/login').auth,
    { state: 'public', allowedRoles: [] },
  );
  assert.ok(first.routes.every((route) => route.provenance.adapter === 'vue-router-static'));
});

test('keeps proven literal Vue routes and reports every unsupported route expression with provenance', async () => {
  const boundary = await fixtureBoundary();
  const result = await discoverVueRouter({
    boundary,
    relativePaths: ['vue-partial/router.ts'],
  });

  assert.deepEqual(result.routes.map((route) => route.path), [
    '/conflict',
    '/literal',
    '/literal-with-dynamics',
  ]);
  assert.equal(result.routes.filter((route) => route.path === '/conflict').length, 1);
  assert.equal(
    result.routes.find((route) => route.path === '/conflict').name,
    'conflict-first',
  );
  assert.equal(result.routes.some((route) => route.path === '/users'), false);
  assert.deepEqual(
    result.routes.find((route) => route.path === '/literal-with-dynamics'),
    {
      id: 'route:/literal-with-dynamics',
      path: '/literal-with-dynamics',
      name: null,
      component: 'LiteralView',
      aliases: [],
      auth: { state: 'unknown', allowedRoles: [] },
      parameters: [],
      provenance: {
        adapter: 'vue-router-static',
        file: 'vue-partial/router.ts',
        pointer: '/routes/5',
      },
    },
  );
  assert.deepEqual(result.coverage, {
    adapter: 'vue-router-static',
    status: 'partial',
    gaps: [
      'computed-path:vue-partial/router.ts#/routes/2/path',
      'computed-path:vue-partial/router.ts#/routes/4/path',
      'imported-routes:vue-partial/router.ts#/createRouter/1/routes',
      'interpolated-template:vue-partial/router.ts#/routes/3/path',
      'route-conflict:vue-partial/router.ts#/routes/7',
      'spread:vue-partial/router.ts#/routes/1',
      'unsupported-expression:vue-partial/router.ts#/routes/5/alias',
      'unsupported-expression:vue-partial/router.ts#/routes/5/name',
    ],
  });
  assert.deepEqual(
    result.diagnostics.map(({ code, sourcePath, pointer }) => ({ code, sourcePath, pointer })),
    [
      {
        code: 'VUE_COMPUTED_PATH',
        sourcePath: 'vue-partial/router.ts',
        pointer: '/routes/2/path',
      },
      {
        code: 'VUE_COMPUTED_PATH',
        sourcePath: 'vue-partial/router.ts',
        pointer: '/routes/4/path',
      },
      {
        code: 'VUE_IMPORTED_ROUTES',
        sourcePath: 'vue-partial/router.ts',
        pointer: '/createRouter/1/routes',
      },
      {
        code: 'VUE_INTERPOLATED_TEMPLATE',
        sourcePath: 'vue-partial/router.ts',
        pointer: '/routes/3/path',
      },
      {
        code: 'VUE_ROUTE_CONFLICT',
        sourcePath: 'vue-partial/router.ts',
        pointer: '/routes/7',
      },
      {
        code: 'VUE_SPREAD',
        sourcePath: 'vue-partial/router.ts',
        pointer: '/routes/1',
      },
      {
        code: 'VUE_UNSUPPORTED_EXPRESSION',
        sourcePath: 'vue-partial/router.ts',
        pointer: '/routes/5/alias',
      },
      {
        code: 'VUE_UNSUPPORTED_EXPRESSION',
        sourcePath: 'vue-partial/router.ts',
        pointer: '/routes/5/name',
      },
    ],
  );
});

test('bounds Vue Router reads and reports an oversized input as coverage evidence', async () => {
  const observed = [];
  const result = await discoverVueRouter({
    boundary: {
      async readText(relativePath, options) {
        observed.push([relativePath, options]);
        if (relativePath === 'oversized.js') {
          throw new SentinelError(
            'INPUT_SIZE_LIMIT',
            'Input exceeds the configured read limit',
            { maxBytes: DISCOVERY_INPUT_LIMIT },
          );
        }
        return 'export const routes = [{ path: "/bounded", meta: { public: true } }];';
      },
    },
    relativePaths: ['bounded.js', 'oversized.js'],
  });

  assert.deepEqual(observed, [
    ['bounded.js', { maxBytes: DISCOVERY_INPUT_LIMIT }],
    ['oversized.js', { maxBytes: DISCOVERY_INPUT_LIMIT }],
  ]);
  assert.deepEqual(result.routes.map((route) => route.path), ['/bounded']);
  assert.deepEqual(result.coverage, {
    adapter: 'vue-router-static',
    status: 'partial',
    gaps: ['size-limit:oversized.js#/'],
  });
  assert.deepEqual(result.diagnostics, [{
    code: 'VUE_SIZE_LIMIT',
    message: `Vue Router discovery input oversized.js exceeds the ${DISCOVERY_INPUT_LIMIT}-byte limit`,
    sourcePath: 'oversized.js',
    pointer: '/',
  }]);
});

test('bounds literal nesting with a VUE_DEPTH_LIMIT coverage diagnostic', async () => {
  const nestedArrays = (depth) => `${'['.repeat(depth)}null${']'.repeat(depth)}`;
  const sources = new Map([
    ['bounded.js', `export const routes = [{ path: '/bounded', meta: { public: true, data: ${nestedArrays(32)} } }];`],
    ['too-deep.js', `export const routes = [{ path: '/too-deep', meta: { public: true, data: ${nestedArrays(128)} } }];`],
  ]);
  const result = await discoverVueRouter({
    boundary: {
      async readText(relativePath) {
        return sources.get(relativePath);
      },
    },
    relativePaths: ['bounded.js', 'too-deep.js'],
  });

  assert.deepEqual(result.routes.map((route) => route.path), ['/bounded', '/too-deep']);
  assert.equal(result.diagnostics.some((diagnostic) => (
    diagnostic.code === 'VUE_DEPTH_LIMIT'
      && diagnostic.sourcePath === 'too-deep.js'
      && diagnostic.message.includes('64')
  )), true);
  assert.equal(result.diagnostics.some((diagnostic) => (
    diagnostic.code === 'VUE_DEPTH_LIMIT' && diagnostic.sourcePath === 'bounded.js'
  )), false);
});

test('pins the exact literal-nesting boundary at the documented limit', async () => {
  // The limit bounds TOTAL nesting from the parse root, which is what actually
  // protects the stack — so the enclosing structure spends part of the budget:
  // the routes array, the route object, and `meta` are three containers deep
  // before a value in `meta` is even reached. Pinning both sides of the real
  // boundary means a future tweak to MAX_VUE_LITERAL_DEPTH cannot drift silently.
  const ENCLOSING_CONTAINERS = 3;
  const affordable = MAX_VUE_LITERAL_DEPTH - ENCLOSING_CONTAINERS;
  const nestedArrays = (depth) => `${'['.repeat(depth)}null${']'.repeat(depth)}`;
  const sources = new Map([
    ['at-limit.js', `export const routes = [{ path: '/at-limit', meta: { public: true, data: ${nestedArrays(affordable)} } }];`],
    ['over-limit.js', `export const routes = [{ path: '/over-limit', meta: { public: true, data: ${nestedArrays(affordable + 1)} } }];`],
  ]);
  const result = await discoverVueRouter({
    boundary: {
      async readText(relativePath) {
        return sources.get(relativePath);
      },
    },
    relativePaths: ['at-limit.js', 'over-limit.js'],
  });

  const limited = (file) => result.diagnostics.some((diagnostic) => (
    diagnostic.code === 'VUE_DEPTH_LIMIT' && diagnostic.sourcePath === file
  ));
  assert.equal(limited('at-limit.js'), false, 'exactly the limit must parse');
  assert.equal(limited('over-limit.js'), true, 'one past the limit must degrade');
});

test('rejects implicit, absolute, URL-like, and non-source Vue Router inputs', async () => {
  const boundary = await fixtureBoundary();

  for (const relativePaths of [
    [],
    ['/tmp/router.js'],
    ['//example.invalid/router.js'],
    ['https://example.invalid/router.js'],
    ['vue-complete/router.json'],
  ]) {
    await assert.rejects(
      discoverVueRouter({ boundary, relativePaths }),
      (error) => error?.code === 'VUE_PATH_INVALID',
    );
  }
});
