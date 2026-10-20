import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startBridge, FakeExtension, run, DOCTOR, freePort, tempDir } from './harness.mjs';

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

test('doctor --json emits a machine-readable summary', async (t) => {
  const ext = await new FakeExtension(bridge.base).connect();
  t.after(() => ext.disconnect());

  const { code, out } = await doctor(bridge.base, ['--no-chat', '--json']);
  assert.equal(code, 0, out);
  const lines = out.trim().split(/\r?\n/);
  const last = JSON.parse(lines.at(-1));
  assert.equal(last.failed, 0);
  assert.equal(last.warned, 0);
  assert.equal(last.ok, true);
});

// The extension checks read local files, so they hold without a window: a
// plugin that fails to load is named, and untested MCP config is a warning
// rather than silence. A dead desktop port keeps the MCP path deterministic.
test('a plugin that fails to load is named, and MCP config reads without a backend', async () => {
  const home = tempDir({
    'settings.json': '{}',
    'mcp.json': JSON.stringify({ servers: [{ name: 'dead', command: 'node', args: ['-e', ''] }] }),
  });
  fs.mkdirSync(path.join(home, 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(home, 'plugins', 'ok.mjs'),
    "export default { name: 'ok', version: '1.0.0', setup() {} };\n");
  const env = { AIPASS_HOME: home, AIPASS_DESKTOP_PORT: '1' };

  const good = await run(DOCTOR, ['--bridge', bridge.base, '--no-chat'], { env });
  assert.match(good.out, /✓ plugins\s+1 loaded/);
  assert.match(good.out, /! mcp\s+1 enabled server\(s\) — not tested/, good.out);

  fs.writeFileSync(path.join(home, 'plugins', 'broken.mjs'),
    "export default { name: 'broken', version: '1.0.0', setup() { throw new Error('nope'); } };\n");
  const bad = await run(DOCTOR, ['--bridge', bridge.base, '--no-chat'], { env });
  assert.equal(bad.code, 1, bad.out);
  assert.match(bad.out, /✗ plugins\s+1 failed to load/);
  assert.match(bad.out, /broken\.mjs/);
  assert.match(bad.out, /aipass plugin list/);
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
