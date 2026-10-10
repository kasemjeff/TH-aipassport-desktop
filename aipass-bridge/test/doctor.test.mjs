import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startBridge, FakeExtension, run, DOCTOR, freePort } from './harness.mjs';

let bridge;
before(async () => { bridge = await startBridge(); });
after(() => bridge.stop());

const doctor = (base, args = []) => run(DOCTOR, ['--bridge', base, ...args]);

test('a healthy chain passes every check and exits 0', async (t) => {
  const ext = await new FakeExtension(bridge.base).connect();
  t.after(() => ext.disconnect());

  const { code, out } = await doctor(bridge.base);
  assert.equal(code, 0, out);
  assert.match(out, /✓ bridge/);
  assert.match(out, /✓ extension\s+1 attached/);
  assert.match(out, /✓ login\s+signed in/);
  assert.match(out, /✓ credits\s+9,833 of 10,000 left/);
  assert.match(out, /✓ conversation/);
  // The round trip runs unasked only because a free-credit model exists, so a
  // clean bill of health costs nothing.
  assert.match(out, /✓ round trip\s+gemini-3\.1-flash-lite replied/);
  assert.match(out, /all good/);
});

test('a dead bridge is named, with the command that starts it', async () => {
  const port = await freePort();
  const { code, out } = await doctor(`http://127.0.0.1:${port}`);
  assert.equal(code, 1);
  assert.match(out, /✗ bridge\s+not reachable/);
  assert.match(out, /npm run dev/);
  // Everything downstream is skipped rather than reported as broken too.
  assert.match(out, /– extension\s+skipped/);
});

test('a bridge with no tab attached says which tab to open', async () => {
  const solo = await startBridge();
  try {
    const { code, out } = await doctor(solo.base);
    assert.equal(code, 1);
    assert.match(out, /✓ bridge/);
    assert.match(out, /✗ extension\s+no tab attached/);
    assert.match(out, /de\.aipass\.net\/chat/);
    assert.match(out, /1 check failed/);
  } finally {
    solo.stop();
  }
});

test('--no-chat skips the round trip', async (t) => {
  const ext = await new FakeExtension(bridge.base).connect();
  t.after(() => ext.disconnect());

  const { code, out } = await doctor(bridge.base, ['--no-chat']);
  assert.equal(code, 0);
  assert.match(out, /– round trip\s+skipped \(--no-chat\)/);
});

// Asking for help is not an error, and `npm run models -- --help` puts the flag
// after the subcommand — both of which were wrong when --help was first added.
test('every CLI answers --help and exits 0', async () => {
  const { AGENT, CHAT } = await import('./harness.mjs');
  const LIST = DOCTOR.replace('doctor.mjs', 'list.mjs');

  for (const [name, script, args] of [
    ['doctor', DOCTOR, ['--help']],
    ['chat', CHAT, ['--help']],
    ['agent', AGENT, ['--help']],
    ['list', LIST, ['--help']],
    ['list after a subcommand', LIST, ['models', '--help']],
  ]) {
    const { code, out } = await run(script, args);
    assert.equal(code, 0, `${name} should exit 0, got ${code}`);
    assert.match(out, /usage:/, `${name} should print usage`);
  }
});
