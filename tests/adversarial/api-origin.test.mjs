import assert from 'node:assert/strict';
import test from 'node:test';

import { requestApproved } from '../../runtime/api/http.mjs';
import { sweepApi } from '../../runtime/api/sweep.mjs';
import { startHttpFixture } from '../fixtures/http-app.mjs';

const ADMIN_TOKEN = 'sentinel-cross-origin-secret';
const TRANSPORT_KEYS = [
  'outcome',
  'reasonCode',
  'status',
  'durationMs',
  'bytes',
  'redirects',
  'contentType',
  'inspection',
];

function assertExactTransportShape(observation) {
  assert.deepEqual(Reflect.ownKeys(observation), TRANSPORT_KEYS);
  assert.deepEqual(Object.getOwnPropertySymbols(observation), []);
  assert.equal(Reflect.ownKeys(observation).some((key) => /body/iu.test(String(key))), false);
  assert.deepEqual(Object.keys(Object.getOwnPropertyDescriptors(observation)), TRANSPORT_KEYS);
}

test('manual redirects block a cross-origin receiver without forwarding authorization', async (t) => {
  const fixture = await startHttpFixture({ adminToken: ADMIN_TOKEN, userToken: 'unused-user' });
  t.after(() => fixture.close());

  const observation = await requestApproved({
    origin: fixture.origin,
    path: '/redirect/cross',
    method: 'GET',
    headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    timeoutMs: 1000,
    maxBytes: 1024,
    approvedOrigins: [fixture.origin, fixture.receiverOrigin],
  });

  assert.equal(observation.outcome, 'blocked');
  assert.equal(observation.reasonCode, 'REDIRECT_ORIGIN_BLOCKED');
  assert.equal(observation.redirects, 1);
  assert.equal(fixture.receiverRequests.length, 0);
  assertExactTransportShape(observation);
  assert.equal(observation.inspection, null);
  assert.equal(JSON.stringify(observation).includes(ADMIN_TOKEN), false);
  assert.equal(JSON.stringify(observation).includes('authorization'), false);
});

test('follows a same-origin redirect manually and returns a bounded response', async (t) => {
  const fixture = await startHttpFixture({ adminToken: ADMIN_TOKEN, userToken: 'unused-user' });
  t.after(() => fixture.close());

  const observation = await requestApproved({
    origin: fixture.origin,
    path: '/redirect/same',
    method: 'GET',
    headers: {},
    timeoutMs: 1000,
    maxBytes: 1024,
    approvedOrigins: [fixture.origin],
    responses: { '200': { contentType: 'application/json', schemaId: null } },
    schemaRegistry: {},
  });

  assert.equal(observation.outcome, 'response');
  assert.equal(observation.status, 200);
  assert.equal(observation.redirects, 1);
  assert.equal(observation.bytes, 11);
  assert.equal(observation.contentType, 'application/json');
  assertExactTransportShape(observation);
  assert.deepEqual(Reflect.ownKeys(observation.inspection), ['reasonCode', 'schemaViolations']);
  assert.deepEqual(observation.inspection, { reasonCode: null, schemaViolations: [] });
  assert.equal(JSON.stringify(observation).includes('{\\"ok\\":true}'), false);
});

test('inspects exact bounded JSON when an ordinary request header value overlaps it', async (t) => {
  const fixture = await startHttpFixture({ adminToken: ADMIN_TOKEN, userToken: 'unused-user' });
  t.after(() => fixture.close());

  const observation = await requestApproved({
    origin: fixture.origin,
    path: '/public',
    method: 'GET',
    headers: { 'x-marker': 'true' },
    timeoutMs: 1000,
    maxBytes: 1024,
    approvedOrigins: [fixture.origin],
    responses: { '200': { contentType: 'application/json', schemaId: null } },
    schemaRegistry: {},
  });

  assertExactTransportShape(observation);
  assert.deepEqual(observation.inspection, { reasonCode: null, schemaViolations: [] });
});

test('rejects response inspector callbacks before they can receive raw text', async () => {
  const rawBody = '{"secret":"body-value"}';
  const origin = 'http://127.0.0.1:34567';
  let callbackCalled = false;
  let fetchCalled = false;

  const observation = await requestApproved({
    origin,
    path: '/public',
    method: 'GET',
    headers: {},
    timeoutMs: 1000,
    maxBytes: 1024,
    approvedOrigins: [origin],
    fetchImpl: async () => {
      fetchCalled = true;
      return new Response(rawBody, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
    inspectBody() {
      callbackCalled = true;
      return { reasonCode: null, schemaViolations: [] };
    },
  });

  assertExactTransportShape(observation);
  assert.equal(observation.outcome, 'blocked');
  assert.equal(observation.reasonCode, 'REQUEST_INVALID');
  assert.equal(callbackCalled, false);
  assert.equal(fetchCalled, false);
  assert.equal(JSON.stringify(observation).includes(rawBody), false);
  assert.equal(observation.inspection, null);
});

test('redacts reflected credentials from deterministic schema paths', async () => {
  const origin = 'http://127.0.0.1:34567';
  const encodedToken = Buffer.from(ADMIN_TOKEN).toString('base64');
  const tokenMidpoint = Math.floor(ADMIN_TOKEN.length / 2);
  const tokenParts = [
    ADMIN_TOKEN.slice(0, tokenMidpoint),
    ADMIN_TOKEN.slice(tokenMidpoint),
  ];
  const observation = await requestApproved({
    origin,
    path: '/public',
    method: 'GET',
    headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    timeoutMs: 1000,
    maxBytes: 1024,
    approvedOrigins: [origin],
    responses: { '200': { contentType: 'application/json', schemaId: 'strict' } },
    schemaRegistry: {
      strict: {
        schema: {
          type: 'object',
          properties: {},
          additionalProperties: false,
        },
      },
    },
    fetchImpl: async () => new Response(JSON.stringify({
      [ADMIN_TOKEN]: true,
      [encodedToken]: true,
      [tokenParts[0]]: true,
      [tokenParts[1]]: true,
    }), {
      status: 200,
      headers: { 'content-type': `application/json; note=${ADMIN_TOKEN}` },
    }),
  });

  assertExactTransportShape(observation);
  assert.equal(observation.contentType, null);
  assert.equal(observation.inspection.reasonCode, 'SCHEMA_VIOLATION');
  assert.deepEqual(observation.inspection.schemaViolations, [{
    path: '/[REDACTED]',
    keyword: 'additionalProperties',
  }]);
  const serialized = JSON.stringify(observation);
  assert.equal(serialized.includes(ADMIN_TOKEN), false);
  assert.equal(serialized.includes(encodedToken), false);
  assert.equal(serialized.includes(tokenParts[0]), false);
  assert.equal(serialized.includes(tokenParts[1]), false);
  assert.equal(serialized.includes('Bearer'), false);
});

test('requires trusted non-loopback approval before sweep transport executes', async () => {
  const origin = 'https://example.test';
  const operation = {
    id: 'external-public',
    method: 'GET',
    path: '/public',
    parameters: [],
    responses: { '200': { contentType: 'application/json', schemaId: null } },
    auth: { state: 'public', allowedRoles: [] },
  };
  const manifest = { operations: [operation], schemas: {} };
  const plan = {
    operations: [{
      subjectId: operation.id,
      action: 'execute',
      reasonCode: 'READ_APPROVED',
      originId: 'default',
      parameterValues: {},
    }],
  };
  let requests = 0;
  const fetchImpl = async () => {
    requests += 1;
    return new Response('{"ok":true}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const baseConfig = {
    approvedOrigins: [origin],
    services: [],
    roles: {},
    responseTimeoutMs: 1000,
    maxResponseBytes: 1024,
  };

  const blocked = await sweepApi({
    manifest,
    plan,
    config: { ...baseConfig, allowNonLoopback: false },
    fetchImpl,
  });
  assert.equal(blocked[0].outcome, 'fail');
  assert.equal(blocked[0].reasonCode, 'ORIGIN_NON_LOOPBACK_BLOCKED');
  assert.equal(requests, 0);

  const approved = await sweepApi({
    manifest,
    plan,
    config: { ...baseConfig, allowNonLoopback: true },
    fetchImpl,
  });
  assert.equal(approved[0].outcome, 'pass');
  assert.equal(approved[0].evidence.status, 200);
  assert.equal(requests, 1);
});
