import assert from 'node:assert/strict';
import test from 'node:test';

import { requestApproved } from '../../runtime/api/http.mjs';
import { sweepApi } from '../../runtime/api/sweep.mjs';
import { startHttpFixture } from '../fixtures/http-app.mjs';

const ADMIN_TOKEN = 'sentinel-cross-origin-secret';

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
  });

  assert.equal(observation.outcome, 'response');
  assert.equal(observation.status, 200);
  assert.equal(observation.redirects, 1);
  assert.equal(observation.bytes, 11);
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
