// Path rules — the permission engine's escape hatch, now reachable.
//
// Three layers, one contract:
//   1. the engine  — rules outrank the mode, first match wins, kinds narrow a rule
//   2. settings    — malformed rules are dropped, not stored where they look
//                    like protection
//   3. the window  — rules.get/rules.set write through to the same settings
//                    file the CLI reads AND to the live engine, in one breath
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PermissionEngine, globMatch } from '../harness/permissions.mjs';
import { Settings } from '../harness/settings.mjs';
import { RulesStore } from '../harness/rules.mjs';
import { createRpc } from '../harness/rpc.mjs';
import { freePort, tempDir } from './harness.mjs';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aipass-rules-'));
process.env.AIPASS_HOME = HOME;
after(() => fs.rmSync(HOME, { recursive: true, force: true }));

/* 1 — the engine ---------------------------------------------------------- */

test('a rule outranks the mode, and the first match wins', () => {
  const engine = new PermissionEngine({
    mode: 'ask',
    rules: [
      { pattern: 'docs/**', decision: 'allow' },
      { pattern: '**/*.md', decision: 'deny' },
    ],
  });

  // The mode says ask; the rule says allow. The rule wins.
  assert.equal(engine.evaluate({ kind: 'write', arg: 'docs/readme.md' }).decision, 'allow');
  // First match only: the `**/*.md` deny rule never sees docs/readme.md.
  assert.equal(engine.evaluate({ kind: 'write', arg: 'notes/plan.md' }).decision, 'deny');
  // Untouched paths still fall through to the mode — including a top-level
  // .md, which `**/*.md` does not reach: `**/` needs a separator, which is
  // worth pinning down because it surprises everyone exactly once.
  assert.equal(engine.evaluate({ kind: 'write', arg: 'readme.md' }).decision, 'ask');
  assert.equal(engine.evaluate({ kind: 'write', arg: 'src/app.js' }).decision, 'ask');
});

test('a deny rule holds even in yolo, and kinds narrow a rule', () => {
  const engine = new PermissionEngine({
    mode: 'yolo',
    rules: [{ pattern: '.env*', decision: 'deny' }],
  });
  assert.equal(engine.evaluate({ kind: 'write', arg: '.env.local' }).decision, 'deny');

  const onlyShell = new PermissionEngine({ mode: 'ask', rules: [{ pattern: 'scripts/**', decision: 'allow', kinds: ['run'] }] });
  assert.equal(onlyShell.evaluate({ kind: 'run', arg: 'scripts/build.sh' }).decision, 'allow');
  // A write under the same path is not covered by a run-only rule.
  assert.equal(onlyShell.evaluate({ kind: 'write', arg: 'scripts/build.sh' }).decision, 'ask');
});

test('a denied rule refuses without asking — nobody is asked, nobody waits', async () => {
  const asked = [];
  const engine = new PermissionEngine({
    mode: 'ask',
    rules: [{ pattern: 'secrets/**', decision: 'deny' }],
    askFn: (q) => { asked.push(q); return 'allow'; },
  });
  assert.equal(await engine.request({ kind: 'write', arg: 'secrets/key.txt' }), 'deny');
  assert.equal(asked.length, 0, 'a rule that already answered is not a question');
});

test('the glob: ** spans path separators, * does not, and it is case-blind', () => {
  assert.equal(globMatch('docs/**', 'docs/a/b/c.md'), true);
  assert.equal(globMatch('docs/*', 'docs/a/b.md'), false);
  assert.equal(globMatch('.env*', '.ENV.LOCAL'), true);
  assert.equal(globMatch('src/**/*.test.*', 'src/a/b/thing.test.js'), true);
});

/* 2 — settings ------------------------------------------------------------- */

test('settings drop rules that would never fire', () => {
  const s = new Settings(tempDir(), 'settings.json');
  s.set({
    rules: [
      { pattern: 'docs/**', decision: 'allow' },
      { pattern: '   ', decision: 'allow' },        // no pattern: never matches
      { pattern: 'x/**', decision: 'yes' },          // decision the engine can't honour
      { pattern: 'y/**', decision: 'deny', kinds: ['run'] },
      'not even an object',
    ],
  });
  const rules = s.get('rules');
  assert.deepEqual(rules, [
    { pattern: 'docs/**', decision: 'allow' },
    { pattern: 'x/**', decision: 'ask' },
    { pattern: 'y/**', decision: 'deny', kinds: ['run'] },
  ]);
});

/* 3 — the window's API ------------------------------------------------------ */

/** A backend with its own bridge and port; no run is started, only policy. */
async function startBackend() {
  const port = await freePort();
  const settings = new Settings(tempDir(), 'settings.json');
  const rpc = createRpc({
    port,
    root: tempDir(),
    bridgeURL: `http://127.0.0.1:${await freePort()}`,
    autostartBridge: false,
    store: tempDir(),
    settings,
  });
  const call = async (method, params = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}/rpc`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method, params }),
    });
    const body = await res.json();
    if (!body.ok) throw new Error(body.error);
    return body.result;
  };
  return { port, rpc, call, stop() { rpc.server.close(); } };
}

test('rules.set writes the file AND moves the live engine', async (t) => {
  const env = await startBackend();
  t.after(() => env.stop());

  const { rules } = await env.call('rules.set', { rules: [
    { pattern: 'docs/**', decision: 'allow' },
    { pattern: '.env*', decision: 'deny' },
  ] });
  assert.equal(rules.length, 2);

  // The engine the next marker will be judged by has them — not just the file.
  const engine = env.rpc.current.permissions;
  assert.equal(engine.evaluate({ kind: 'write', arg: 'docs/plan.md' }).decision, 'allow');
  assert.equal(engine.evaluate({ kind: 'write', arg: '.env' }).decision, 'deny');

  // …and the CLI that reads the same settings.json sees the same rules.
  assert.deepEqual(env.rpc.settings.get('rules'), rules);
});

test('rules.get reports what is actually in force', async (t) => {
  const env = await startBackend();
  t.after(() => env.stop());
  assert.deepEqual((await env.call('rules.get')).rules, []);
  await env.call('rules.set', { rules: [{ pattern: 'dist/**', decision: 'ask' }] });
  assert.deepEqual((await env.call('rules.get')).rules, [{ pattern: 'dist/**', decision: 'ask' }]);
});

test('the settings sheet path applies rules live too', async (t) => {
  const env = await startBackend();
  t.after(() => env.stop());
  // The window saves the whole draft, rules included — the same code path the
  // dedicated method uses, or the sheet would be a second class citizen.
  await env.call('settings.set', { rules: [{ pattern: 'vendor/**', decision: 'deny' }] });
  assert.equal(env.rpc.current.permissions.evaluate({ kind: 'write', arg: 'vendor/lib.js' }).decision, 'deny');
});

test('a harness built later inherits the rules from settings', async (t) => {
  const env = await startBackend();
  t.after(() => env.stop());
  await env.call('rules.set', { rules: [{ pattern: 'tmp/**', decision: 'allow' }] });
  // A second project is a fresh harness: it must not run rule-free until the
  // next restart just because it was built after the rules were written.
  const other = await env.call('session.new'); // touches the current harness
  assert.ok(other.id);
  const fresh = env.rpc.current;
  assert.equal(fresh.permissions.evaluate({ kind: 'write', arg: 'tmp/x' }).decision, 'allow');
});

/* 4 — the file on disk ------------------------------------------------------ */

test('a corrupt project record is repaired on the next write, not thrown at', () => {
  // The reader skips a record that is not an object; the writer must hold the
  // same line, or the "always" button crashes on the very file the reader
  // just declared unreadable.
  const file = path.join(tempDir(), 'rules.json');
  const root = tempDir();
  fs.writeFileSync(file, JSON.stringify({ projects: { [path.resolve(root)]: 'oops' } }));
  const store = new RulesStore(file);

  assert.deepEqual(store.forRoot(root), { rules: [], grants: [] });
  store.addGrant(root, 'write', 'x.txt');
  assert.deepEqual(store.forRoot(root), { rules: [], grants: [{ kind: 'write', arg: 'x.txt' }] });
  store.setRules(root, [{ pattern: 'docs/**', decision: 'allow' }]);
  assert.deepEqual(store.forRoot(root).rules, [{ pattern: 'docs/**', decision: 'allow' }]);

  // The file-level shape too: `projects` itself, not just the record.
  fs.writeFileSync(file, JSON.stringify({ projects: 'oops' }));
  assert.deepEqual(store.forRoot(root), { rules: [], grants: [] });
  store.addGrant(root, 'write', 'y.txt');
  assert.deepEqual(store.forRoot(root).grants, [{ kind: 'write', arg: 'y.txt' }]);
});

test('a rules save that cannot complete leaves the previous rules intact', () => {
  const file = path.join(tempDir(), 'rules.json');
  const root = tempDir();
  const store = new RulesStore(file);
  store.addGrant(root, 'write', 'a.txt');
  const before = fs.readFileSync(file, 'utf8');
  assert.match(before, /a\.txt/);

  // A directory where the temp file would go: the write fails before the
  // swap, the way a full disk or a dead handle would. The old rules — every
  // project's, not just this one's — must be exactly as they were: the direct
  // overwrite this replaces could lose the whole file to one bad moment.
  fs.mkdirSync(file + '.tmp');
  assert.throws(() => store.addGrant(root, 'shell', 'rm -rf /'));
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'a failed save changes nothing');

  fs.rmSync(file + '.tmp', { recursive: true, force: true });
  store.addGrant(root, 'shell', 'rm -rf /');
  assert.deepEqual(store.forRoot(root).grants.map((g) => g.kind).sort(), ['shell', 'write'], 'and the next save lands');
});
