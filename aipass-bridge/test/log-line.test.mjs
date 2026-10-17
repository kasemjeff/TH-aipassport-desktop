// The log line format: a person reads the default, a collector reads the JSON,
// and the request id is the one field both share.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatLogLine, requestId } from '../harness/log-line.mjs';

test('the text form is HH:MM:SS, a level tag only when it is not info, and the rid', () => {
  const at = Date.UTC(2026, 9, 17, 12, 34, 56);
  assert.equal(formatLogLine({ ts: at, msg: 'models loaded' }), '12:34:56 models loaded');
  assert.equal(
    formatLogLine({ ts: at, level: 'warn', rid: 'a1b2c3', msg: 'slow' }),
    '12:34:56 WARN [a1b2c3] slow',
  );
});

test('json mode emits one object per line with the same fields', () => {
  const at = Date.UTC(2026, 9, 17, 12, 34, 56);
  process.env.AIPASS_LOG_FORMAT = 'json';
  try {
    const line = formatLogLine({ ts: at, level: 'error', rid: 'dead01', msg: 'boom' });
    assert.equal(line.includes('\n'), false, 'one line, no newline inside');
    assert.deepEqual(JSON.parse(line), { ts: '2026-10-17T12:34:56.000Z', level: 'error', rid: 'dead01', msg: 'boom' });
    const bare = JSON.parse(formatLogLine({ ts: at, msg: 'plain' }));
    assert.deepEqual(bare, { ts: '2026-10-17T12:34:56.000Z', level: 'info', msg: 'plain' }, 'no rid key when there is none');
  } finally {
    delete process.env.AIPASS_LOG_FORMAT;
  }
});

test('a request id is short, lowercase hex and not obviously repeating', () => {
  const ids = new Set(Array.from({ length: 50 }, () => requestId()));
  assert.ok([...ids].every((id) => /^[0-9a-f]{4,8}$/.test(id)));
  assert.ok(ids.size > 45, '50 draws do not collide into a handful');
});
