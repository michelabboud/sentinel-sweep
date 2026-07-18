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
    viewports: [375, 768, 1280],
    screenshotOnError: true,
  });
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
