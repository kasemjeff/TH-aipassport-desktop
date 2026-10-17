// The log scrubber (bridge/log-scrub.mjs): the credential shapes that must
// never reach stdout / bridge.log, pinned one pattern at a time — this list
// is what the OWASP Logging rule means in this codebase.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scrubSecrets } from '../bridge/log-scrub.mjs';

const CASES = [
  ['OpenAI-style key', 'sk-abcdefgh12345678'],
  ['Slack token', 'xoxb-1234567890-abcdefghijklm'],
  ['GitHub PAT', 'ghp_ABCDEFGH12345678'],
  ['GitHub OAuth', 'gho_ABCDEFGH12345678'],
  ['AWS key id', 'AKIAIOSFODNN7EXAMPLE'],
  ['Google API key', 'AIzaSyA1234567890abcdefghijklmnop'],
  ['Bearer header', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig'],
];

test('every credential shape is redacted', () => {
  for (const [name, secret] of CASES) {
    const out = scrubSecrets(`before ${secret} after`);
    assert.ok(!out.includes(secret), `${name}: the raw value must be gone (got ${out})`);
    assert.ok(out.startsWith('before ') && out.endsWith(' after'), `${name}: surrounding text survives`);
    assert.ok(out.includes('[redacted]'), `${name}: the placeholder marks the spot`);
  }
  // One line with several secrets redacts all of them.
  assert.equal(scrubSecrets('sk-abcdefgh12345678 and ghp_ABCDEFGH12345678'), '[redacted] and [redacted]');
});

test('ordinary text and non-strings pass through untouched', () => {
  const prose = 'the bridge returned 401: missing or wrong loopback bearer token';
  assert.equal(scrubSecrets(prose), prose, 'the word bearer alone is not a secret');
  assert.equal(scrubSecrets(42), 42);
  assert.equal(scrubSecrets(null), null);
  assert.equal(scrubSecrets(undefined), undefined);
});
