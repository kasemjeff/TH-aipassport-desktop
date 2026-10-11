// The permission engine's waiting behaviour: timeoutMs 0 means the question
// stays open until a human answers — the desktop's shape — while a timeout
// resolves to deny, never a hang. Plus the persisted rules and grants
// (harness/rules.mjs): "always" answers survive a restart, project rules are
// seeded from the file, and the caller's own rules outrank them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Emitter } from '../harness/events.mjs';
import { PermissionEngine } from '../harness/permissions.mjs';
import { RulesStore } from '../harness/rules.mjs';
import { Harness } from '../harness/harness.mjs';

const tick = (ms) => new Promise((r) => setTimeout(r, ms));
const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aipass-rules-'));

test('timeoutMs 0 waits for the answer instead of denying', async () => {
  const events = new Emitter();
  let question = null;
  events.on('permission_request', (q) => { question = q; });

  const engine = new PermissionEngine({ mode: 'ask', events, timeoutMs: 0 });
  const pending = engine.request({ kind: 'write', arg: 'src/a.ts', preview: 'x' });
  let settled = false;
  pending.then(() => { settled = true; }, () => { settled = true; });

  await tick(150);
  assert.equal(settled, false, 'no silent deny while the human reads the diff');
  assert.ok(question, 'the question is on the events for the window to show');

  engine.answer(question.id, 'allow');
  assert.equal(await pending, 'allow');
});

test('a timeout still resolves to deny rather than hanging', async () => {
  const events = new Emitter();
  let question = null;
  events.on('permission_request', (q) => { question = q; });

  const engine = new PermissionEngine({ mode: 'ask', events, timeoutMs: 50 });
  const verdict = await engine.request({ kind: 'write', arg: 'a.txt', preview: 'x' });
  assert.equal(verdict, 'deny');
  assert.equal(engine.answer(question.id, 'allow'), false, 'a decided question is closed');
});

test('an "always" answer writes through to the store and is honoured after a restart', () => {
  const dir = tempDir();
  const root = path.join(dir, 'proj');
  fs.mkdirSync(root);
  const file = path.join(dir, 'rules.json');
  const store = new RulesStore(file);

  const first = new PermissionEngine({
    mode: 'ask',
    onGrant: (kind, arg) => store.addGrant(root, kind, arg),
  });
  first.grant('write', 'src/config.ts');

  // A process restart: a fresh store, a fresh engine seeded from the file.
  const seeded = new RulesStore(file).forRoot(root);
  assert.deepEqual(seeded.grants, [{ kind: 'write', arg: 'src/config.ts' }]);
  const second = new PermissionEngine({ mode: 'ask', rules: seeded.rules });
  for (const g of seeded.grants) second.grants.set(`${g.kind}:${g.arg}`, 'allow');
  assert.equal(second.evaluate({ kind: 'write', arg: 'src/config.ts' }).decision, 'allow');
  assert.equal(second.evaluate({ kind: 'write', arg: 'src/other.ts' }).decision, 'ask', 'one file, not the directory');

  // Granting the same thing twice does not duplicate the entry.
  first.grant('write', 'src/config.ts');
  assert.equal(new RulesStore(file).forRoot(root).grants.length, 1);
});

test('Harness seeds persisted rules, honours grants, and caller rules outrank the file', () => {
  const dir = tempDir();
  const root = path.join(dir, 'proj');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  const file = path.join(dir, 'rules.json');
  const store = new RulesStore(file);
  store.setRules(root, [
    { pattern: '.env*', decision: 'deny' },
    { pattern: 'src/**', decision: 'allow' },
  ]);

  const h = new Harness({ root, rulesFile: file, store: 'off', bridgeURL: 'http://127.0.0.1:1' });
  assert.equal(h.permissions.evaluate({ kind: 'write', arg: '.env' }).decision, 'deny', 'persisted deny applies');
  assert.equal(h.permissions.evaluate({ kind: 'write', arg: 'src/x.ts' }).decision, 'allow', 'persisted allow applies');
  assert.equal(h.permissions.evaluate({ kind: 'write', arg: 'other.ts' }).decision, 'ask', 'no rule — the mode decides');

  // The caller's own rules come first, so they outrank the file.
  const h2 = new Harness({
    root, rulesFile: file, store: 'off', bridgeURL: 'http://127.0.0.1:1',
    rules: [{ pattern: 'src/**', decision: 'deny' }],
  });
  assert.equal(h2.permissions.evaluate({ kind: 'write', arg: 'src/x.ts' }).decision, 'deny');

  // A grant made through the harness is written through and survives.
  h.permissions.grant('write', 'one.ts');
  const grants = new RulesStore(file).forRoot(root).grants;
  assert.ok(grants.some((g) => g.kind === 'write' && g.arg === 'one.ts'), 'the grant is persisted');
});
