import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseApprovedOrigin,
  resolveRequestUrl,
  validateRedirect,
} from '../../runtime/lib/origin.mjs';

const loopbackOnly = { allowNonLoopback: false };

test('parseApprovedOrigin normalizes loopback HTTP origins', () => {
  assert.equal(
    parseApprovedOrigin('HTTP://LOCALHOST:3000/', loopbackOnly),
    'http://localhost:3000',
  );
  assert.equal(
    parseApprovedOrigin('https://[::1]:8443', loopbackOnly),
    'https://[::1]:8443',
  );
});

test('parseApprovedOrigin rejects credentials, query, fragment, and non-HTTP schemes', () => {
  assert.throws(
    () => parseApprovedOrigin('http://user:pass@localhost:3000', loopbackOnly),
    { code: 'ORIGIN_USERINFO' },
  );
  assert.throws(() => parseApprovedOrigin('http://localhost:3000?debug=1', loopbackOnly));
  assert.throws(() => parseApprovedOrigin('http://localhost:3000/#fragment', loopbackOnly));
  assert.throws(() => parseApprovedOrigin('file:///tmp/socket', loopbackOnly));
});

test('parseApprovedOrigin requires explicit approval for non-loopback hosts', () => {
  assert.throws(() => parseApprovedOrigin('https://example.test', loopbackOnly));
  assert.equal(
    parseApprovedOrigin('https://example.test', { allowNonLoopback: true }),
    'https://example.test',
  );
});

test('resolveRequestUrl only accepts paths beginning with exactly one slash', () => {
  assert.equal(
    resolveRequestUrl('http://localhost:3000', '/v1/health?deep=true'),
    'http://localhost:3000/v1/health?deep=true',
  );
  assert.throws(
    () => resolveRequestUrl('http://localhost:3000', '//attacker.example/x'),
    { code: 'PATH_ABSOLUTE_URL' },
  );
  assert.throws(() => resolveRequestUrl('http://localhost:3000', 'v1/health'));
  assert.throws(() => resolveRequestUrl('http://localhost:3000', '///attacker.example/x'));
});

test('validateRedirect resolves same-origin redirects and blocks unapproved origins', () => {
  const start = 'http://localhost:3000/login';
  const approved = ['http://localhost:3000'];
  assert.equal(
    validateRedirect(start, '/session', approved),
    'http://localhost:3000/session',
  );
  assert.throws(
    () => validateRedirect(start, 'https://attacker.example/x', approved),
    { code: 'REDIRECT_ORIGIN_BLOCKED' },
  );
});

test('validateRedirect rejects malformed approved-origin entries', () => {
  const start = 'http://localhost:3000/login';
  const malformed = [
    ['http://localhost:3000/base', 'ORIGIN_BASE_PATH'],
    ['http://localhost:3000?debug=1', 'ORIGIN_QUERY'],
    ['http://localhost:3000#fragment', 'ORIGIN_FRAGMENT'],
    ['http://user:pass@localhost:3000', 'ORIGIN_USERINFO'],
  ];

  for (const [approvedEntry, code] of malformed) {
    assert.throws(
      () => validateRedirect(start, '/session', [approvedEntry]),
      { code },
    );
  }
});
