#!/usr/bin/env bash
# test-manifest-schema.sh — Exercise the shipped v2 schemas with Sentinel's runtime validator.
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_ROOT"

node --input-type=module <<'NODE'
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  loadBundledSchema,
  validateAgainstSchema,
} from './runtime/lib/schema.mjs';

async function readJson(relativePath) {
  return JSON.parse(await readFile(relativePath, 'utf8'));
}

const schemaNames = ['settings', 'sentinel-manifest', 'findings', 'sweep-history'];
const schemas = Object.fromEntries(
  await Promise.all(schemaNames.map(async (name) => [name, await loadBundledSchema(name)])),
);

assert.deepEqual(
  schemaNames.map((name) => schemas[name].$id),
  [
    'sentinel-settings-v2',
    'sentinel-manifest-v2',
    'sentinel-findings-v2',
    'sentinel-history-v2',
  ],
);

const settings = await readJson('settings.json');
const manifest = {
  ...await readJson('tests/fixtures/discovery/openapi-complete.manifest.json'),
  generatedAt: '2026-07-18T00:00:00.000Z',
};
const findings = await readJson('tests/fixtures/report/canonical-findings.json');
const history = await readJson('tests/fixtures/sample-sweep-history.json');

for (const [name, document] of [
  ['settings', settings],
  ['sentinel-manifest', manifest],
  ['findings', findings],
  ['sweep-history', history],
]) {
  assert.doesNotThrow(
    () => validateAgainstSchema(document, schemas[name], { name }),
    `${name} fixture must satisfy its bundled v2 schema`,
  );
}

for (const field of ['maxConcurrency', 'retentionRuns']) {
  assert.equal(
    Object.hasOwn(schemas.settings.properties, field),
    false,
    `settings schema must not advertise ignored field ${field}`,
  );
  assert.equal(
    Object.hasOwn(settings, field),
    false,
    `bundled settings must not advertise ignored field ${field}`,
  );
}

for (const field of ['framework', 'auth', 'service', 'analysis']) {
  assert.equal(
    Object.hasOwn(schemas['sentinel-manifest'].$defs, field),
    false,
    `manifest schema must not retain unused definition ${field}`,
  );
}

function expectAdditionalPropertyRejection({ name, schema, document, mutate, path }) {
  const candidate = structuredClone(document);
  mutate(candidate);
  assert.throws(
    () => validateAgainstSchema(candidate, schema, { name }),
    (error) => error?.code === 'SCHEMA_INVALID'
      && error.details?.violations?.some((violation) => (
        violation.path === path && violation.keyword === 'additionalProperties'
      )),
    `${name} must reject legacy field ${path}`,
  );
}

const cases = [
  {
    name: 'settings maxConcurrency',
    schema: schemas.settings,
    document: settings,
    mutate: (value) => { value.maxConcurrency = 4; },
    path: '/maxConcurrency',
  },
  {
    name: 'settings retentionRuns',
    schema: schemas.settings,
    document: settings,
    mutate: (value) => { value.retentionRuns = 16; },
    path: '/retentionRuns',
  },
  {
    name: 'settings responseTimeout alias',
    schema: schemas.settings,
    document: settings,
    mutate: (value) => { value.responseTimeout = 5000; },
    path: '/responseTimeout',
  },
  {
    name: 'manifest top-level auth',
    schema: schemas['sentinel-manifest'],
    document: manifest,
    mutate: (value) => { value.auth = { method: 'bearer' }; },
    path: '/auth',
  },
  {
    name: 'manifest top-level services',
    schema: schemas['sentinel-manifest'],
    document: manifest,
    mutate: (value) => { value.services = [{ name: 'legacy' }]; },
    path: '/services',
  },
  ...[
    'i18n',
    'a11y',
    'deadCode',
    'deadCss',
    'n1Queries',
    'vulnerabilities',
    'apiVersioning',
    'migrationDrift',
    'rateLimiting',
  ].map((field) => ({
    name: `manifest top-level ${field}`,
    schema: schemas['sentinel-manifest'],
    document: manifest,
    mutate: (value) => { value[field] = null; },
    path: `/${field}`,
  })),
  {
    name: 'manifest target framework',
    schema: schemas['sentinel-manifest'],
    document: manifest,
    mutate: (value) => {
      value.target.framework = { frontend: 'vue', backend: 'express' };
    },
    path: '/target/framework',
  },
  {
    name: 'findings metadata',
    schema: schemas.findings,
    document: findings,
    mutate: (value) => { value.metadata = { mode: 'api' }; },
    path: '/metadata',
  },
  {
    name: 'history run duration',
    schema: schemas['sweep-history'],
    document: history,
    mutate: (value) => { value.runs[0].duration = '30s'; },
    path: '/runs/0/duration',
  },
];

for (const testCase of cases) expectAdditionalPropertyRejection(testCase);

console.log(`Schema tests: 4 current v2 documents and ${cases.length} legacy-field rejections passed`);
NODE
