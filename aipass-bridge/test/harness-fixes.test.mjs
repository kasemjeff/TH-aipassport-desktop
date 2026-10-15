// One test per finding of the harness sweep, each a measured defect:
//
//   H1 the harness walked into its own spill directory — `.aipass` was missing
//      from SKIP, so LIST/SEARCH/GLOB traversed the output of earlier runs
//   H2 glob() matched only the last segment of a `**` pattern, so
//      `src/**/*.ts` returned every .ts file in the tree
//   H3 the git gate was a prefix test, so `branch -D main`, `tag -d v1`,
//      `remote add …` and `-c core.pager=sh status` all passed
//   H4 append() rewrote the whole session file on every entry (O(n²) IO)
//   H5 a rejected send was recorded before it was ever accepted, so the
//      session kept ghost messages the server never saw — and every
//      resilientSay retry wrote a duplicate
//   H7 nothing stopped a run that repeated the same step with the same
//      results until the step limit — a loop that burns the whole budget
//   H8 #makeHelper() built its engine with no rules, so a `.env* → deny` rule
//      was bypassed by every helper run
// (H6, the compaction estimate measuring the message before the WAF rewrites
// it, lives in compact.test.mjs with the rest of the compactor's tests.)
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { tempDir } from './harness.mjs';
import { Overlay } from '../harness/overlay.mjs';
import { SkillLibrary } from '../harness/skills.mjs';
import { SessionStore, HEADER_EVERY } from '../harness/session.mjs';
import { createTools } from '../harness/tools.mjs';
import { PermissionEngine } from '../harness/permissions.mjs';
import { Emitter } from '../harness/events.mjs';
import { BridgeClient } from '../harness/bridge.mjs';
import { Harness } from '../harness/harness.mjs';
import { runTask } from '../harness/loop.mjs';

// Nothing here may touch the real ~/.aipass.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aipass-fixes-home-'));
process.env.AIPASS_HOME = HOME;
after(() => fs.rmSync(HOME, { recursive: true, force: true }));

/** Tools over a plain directory, the way the CLI and the harness build them. */
function toolsIn(dir) {
  return createTools({
    root: dir,
    overlay: new Overlay(dir),
    skills: new SkillLibrary([]),
    allowRun: false,
    maxResult: 6000,
  });
}

/* H1 — the project's own spill directory ---------------------------------- */

test('the spill directory is out of every listing, but still readable', () => {
  const dir = tempDir({
    'a.ts': 'export const needle = 1;\n',
    // What spill() leaves behind after a long tool result: the same "needle",
    // in a file the harness itself wrote.
    '.aipass/spill/x.txt': 'needle from an earlier run\n'.repeat(40),
  });
  const tools = toolsIn(dir);

  const search = tools.search('needle');
  assert.ok(search.includes('a.ts'), 'the real file is still found');
  assert.ok(!search.includes('.aipass'), `an earlier run's spill is not searchable:\n${search}`);

  const listing = tools.list('.').split('\n');
  assert.ok(listing.includes('a.ts'));
  assert.ok(!listing.some((n) => n.startsWith('.aipass')), `.aipass is skipped: ${listing.join(', ')}`);

  // SKIP governs listing/search/glob only. The locator spill() returns points
  // the model straight back at one of these files, so that path must survive.
  const back = tools.read('.aipass/spill/x.txt');
  assert.ok(back.includes('needle from an earlier run'), 'NEED file still reads the spill');

  const globbed = tools.glob('**/*.txt');
  assert.ok(!globbed.includes('.aipass'), 'and a glob does not surface it either');
});

/* H2 — glob honours the prefix before ** ---------------------------------- */

test('glob matches the pattern against the whole path, not the last segment', () => {
  const dir = tempDir({
    'index.ts': 'zero\n',
    'src/a.ts': 'one\n',
    'src/deep/b.ts': 'two\n',
    'docs/c.ts': 'three\n',
  });
  const tools = toolsIn(dir);
  const sorted = (s) => s.split('\n').sort();

  assert.deepEqual(sorted(tools.glob('src/**/*.ts')), ['src/a.ts', 'src/deep/b.ts'],
    'the prefix is honoured: docs/c.ts is not under src');
  assert.deepEqual(sorted(tools.glob('src/*.ts')), ['src/a.ts'],
    'a single * still stops at the separator');
  assert.deepEqual(sorted(tools.glob('*.ts')), ['index.ts'], 'and so does a bare pattern');
  // `**` matches no separators as well as many, which is what lets `**/*.ts`
  // reach index.ts at the root while still spanning src/deep.
  assert.deepEqual(sorted(tools.glob('**/*.ts')), ['docs/c.ts', 'index.ts', 'src/a.ts', 'src/deep/b.ts']);

  assert.match(tools.glob('src/**/*.tsx'), /^no files matched "src\/\*\*\/\*\.tsx"\.$/);
});

/* H3 — the git gate ------------------------------------------------------- */

const DANGEROUS = [
  'diff --no-index /etc/passwd /etc/passwd',
  'branch -D main',
  'tag -d v1',
  'remote add evil http://x',
  '-c core.pager=sh status',
];

// The merged git tool is async (a slow `git log` must not stop the backend's
// event loop while the window waits on it), and its refusals carry the `err:`
// prefix the loop keys on - so every call here is awaited and the refusal is
// asserted at its start, which is where the loop reads it. The substance of
// what is refused is unchanged.
test('git refuses the forms that delete, write or reach another repository', async () => {
  const dir = tempDir({ 'a.txt': 'hello\n' });
  execSync('git init -q', { cwd: dir });
  const tools = toolsIn(dir);

  // Sanity: the same gate still runs a plain read-only command.
  const status = await tools.git('status');
  assert.ok(!/^err: only read-only git subcommands/.test(status), `git status still runs:\n${status}`);

  for (const bad of DANGEROUS) {
    const out = await tools.git(bad);
    assert.match(out, /^err: only read-only git subcommands are allowed/, `refused: ${bad}`);
    assert.ok(out.includes(bad), `the message names what was tried: ${out}`);
  }

  // The listing forms are allowed bare, and only bare: `stash` alone is a
  // different command from `stash list`.
  for (const ok of ['branch', 'tag', 'remote', 'stash list', 'ls-files']) {
    assert.ok(!/^err: only read-only git subcommands/.test(await tools.git(ok)), `allowed: ${ok}`);
  }
  for (const refused of ['stash', 'stash apply', 'branch -a', 'tag -l', 'remote -v']) {
    assert.match(await tools.git(refused), /^err: only read-only git subcommands are allowed/, `refused: ${refused}`);
  }
});

/* H4 — the header is rewritten in batches --------------------------------- */

test('append batches the header rewrite, and rename still fixes it at once', (t) => {
  const store = new SessionStore(tempDir());
  const session = store.create({ root: tempDir(), title: 'batch me' });

  // rewriteHeader() is the only thing that rewrites an existing session file,
  // so counting the writeFileSync calls it makes counts exactly the rewrites.
  // appendFileSync has to be told apart from it: on Node 24 an append is
  // implemented as a writeFileSync, so the caller is the only thing that
  // separates "one entry appended" from "the whole file rewritten".
  const real = fs.writeFileSync;
  const rewrites = [];
  fs.writeFileSync = function spied(file, ...rest) {
    if (String(file) === session.file && /rewriteHeader/.test(new Error().stack)) rewrites.push(String(file));
    return real.call(this, file, ...rest);
  };
  t.after(() => { fs.writeFileSync = real; });

  for (let i = 0; i < 60; i++) session.append('note', { text: `note ${i}` });

  // The first append, then one per HEADER_EVERY entries: 1, 25, 50.
  assert.equal(rewrites.length, 3, `bounded rewrites, got ${rewrites.length}`);
  assert.ok(rewrites.length <= 1 + Math.ceil(60 / HEADER_EVERY), 'never more than one rewrite per batch');

  const beforeRename = rewrites.length;
  const renamed = store.rename(session.id, 'renamed now');
  assert.equal(rewrites.length, beforeRename + 1, 'rename fixes the header in the same breath');
  assert.equal(JSON.parse(fs.readFileSync(session.file, 'utf8').split('\n', 1)[0]).title, 'renamed now');
  assert.equal(renamed.title, 'renamed now');

  // The entries themselves were never rewritten — appendFileSync appends — so
  // the whole chain is still on disk and still parses.
  const back = store.load(session.id);
  assert.equal(back.entries.length, 60);
  assert.equal(back.entries.at(-1).text, 'note 59');
  assert.equal(back.meta().updated, back.entries.at(-1).ts, 'meta reads the last entry, not the file');
  assert.equal(back.title, 'renamed now');
});

/* H8 — a helper is judged by the rules the person configured --------------- */

test('a helper engine keeps the parent path rules', () => {
  const engine = new PermissionEngine({ mode: 'yolo', allowRun: false, rules: [{ pattern: '.env*', decision: 'deny' }] });
  assert.equal(engine.evaluate({ kind: 'write', arg: '.env' }).decision, 'deny');
  assert.equal(engine.evaluate({ kind: 'write', arg: '.env.local' }).decision, 'deny');
  assert.equal(engine.evaluate({ kind: 'write', arg: 'src/app.ts' }).decision, 'allow',
    'yolo still lets everything the rules do not name through');
});

test('a helper run that edits a denied path is declined, and nothing is staged', async () => {
  const root = tempDir({ 'src/app.ts': 'export const a = 1;\n' });

  // A bridge that answers with scripted turns, and does nothing else: chat()
  // hands them out in order — the parent delegates, the helper tries the
  // edit, the parent finishes.
  class StubBridge extends BridgeClient {
    constructor(replies) {
      super('http://127.0.0.1:1');
      this.model = 'stub';
      this.replies = replies;
      this.turn = 0;
    }
    async chat() {
      return { text: this.replies[Math.min(this.turn++, this.replies.length - 1)], reasoning: '' };
    }
    async quota() { return { available: 10 }; }
    async createConversation() { return { id: 'stub-conversation' }; }
    async config() {}
    async status() { return { conversation: 'stub-conversation' }; }
  }
  const events = new Emitter();
  const h = new Harness({
    root,
    bridge: new StubBridge([
      'SUBAGENT\ntask: change the secret\nEND\n',
      'EDIT .env\nFIND\nSECRET=1\nNEW\nSECRET=2\nEND\nDONE helper done\n',
      'DONE parent done\n',
    ]),
    store: new SessionStore(tempDir()),
    rules: [{ pattern: '.env*', decision: 'deny' }],
    events,
    options: { mode: 'yolo', allowRun: false, subagent: true, maxSteps: 3 },
  });

  const seen = [];
  events.on('tool', (p) => seen.push(p));

  const result = await h.run('delegate the secret change');
  assert.equal(result.stopReason, 'done');

  const declined = seen.find((p) => p.kind === 'replace' && p.arg === '.env');
  assert.ok(declined, `the helper tried the edit:\n${JSON.stringify(seen)}`);
  assert.match(declined.head, /the person watching declined replace \.env/,
    'the rule answered before the tool could touch anything');
  assert.equal(h.overlay.size, 0, 'and nothing was staged in the overlay');
  assert.deepEqual(h.pendingChanges(), []);
  assert.equal(fs.existsSync(path.join(root, '.env')), false, 'nothing was written to disk either');
});

/* H5 — only the sends the server accepted are recorded --------------------- */

test('nothing is recorded for a send that failed outright (H5)', async () => {
  const dir = tempDir({ 'a.txt': 'hello\n' });
  const store = new SessionStore(path.join(dir, 'sessions'));
  const session = store.create({ root: dir });
  const tools = createTools({ root: dir, overlay: new Overlay(dir) });

  const result = await runTask('read the project', {
    bridge: {
      async chat() { throw new Error('bridge is unreachable'); },
      async quota() { return { available: 1 }; },
    },
    tools, overlay: new Overlay(dir), session,
    options: { maxSteps: 2 }, first: true,
  });

  assert.equal(result.stopReason, 'error');
  assert.equal(session.entries.filter((e) => e.type === 'user').length, 0,
    'the server never received anything, so nothing may look like it did');
});

test('a firewall rejection is not logged, and each accepted retry exactly once (H5)', async () => {
  const dir = tempDir({ 'a.txt': 'hello\n' });
  const store = new SessionStore(path.join(dir, 'sessions'));
  const session = store.create({ root: dir });
  const tools = createTools({ root: dir, overlay: new Overlay(dir) });

  const received = [];
  let calls = 0;
  const bridge = {
    async chat({ message }) {
      received.push(message);
      calls += 1;
      if (calls === 1) throw new Error('bridge returned 403: rejected at the edge');
      return { text: 'DONE looked around', reasoning: '' };
    },
    async quota() { return { available: 1 }; },
  };

  const result = await runTask('read the project', {
    bridge, tools, overlay: new Overlay(dir), session,
    options: { maxSteps: 2 }, first: true,
  });

  assert.equal(result.stopReason, 'done');
  assert.ok(calls > 1, 'the rejected attempt was retried');
  const users = session.entries.filter((e) => e.type === 'user');
  // received[0] is the rejected attempt — it must have left no trace. Every
  // accepted send (split halves, the redaction, the fallback note) is what the
  // server's context holds, so each has to be there, once, in order.
  assert.deepEqual(users.map((u) => u.text), received.slice(1));
});

/* H7 — the stagnation guard ------------------------------------------------ */

/** A bridge that answers a fixed list of turns and records what was sent. */
function scriptedLoop(replies) {
  const received = [];
  let turn = 0;
  return {
    received,
    async chat({ message }) {
      received.push(message);
      return { text: replies[Math.min(turn++, replies.length - 1)], reasoning: '' };
    },
    async quota() { return { available: 1 }; },
  };
}

test('a step repeated three times with identical results stops the run (H7)', async () => {
  const dir = tempDir({ 'a.txt': 'hello\n' });
  const store = new SessionStore(path.join(dir, 'sessions'));
  const session = store.create({ root: dir });
  const tools = createTools({ root: dir, overlay: new Overlay(dir) });
  const events = new Emitter();
  const seen = [];
  events.on('stagnation', (p) => seen.push(p));

  const result = await runTask('read the file', {
    bridge: scriptedLoop(['NEED file a.txt', 'NEED file a.txt', 'NEED file a.txt', 'NEED file a.txt']),
    tools, overlay: new Overlay(dir), session, events,
    options: { maxSteps: 8 }, first: true,
  });

  assert.equal(result.stopReason, 'stagnation');
  assert.deepEqual(seen.map((p) => p.action), ['warn', 'stop']);
  const stat = session.entries.find((e) => e.type === 'run_stats');
  assert.equal(stat.stagnations, 1, 'one correction went out before the stop');
  assert.equal(stat.stopReason, 'stagnation');
});

test('one repeat earns a correction, and a different move clears the guard (H7)', async () => {
  const dir = tempDir({ 'a.txt': 'hello\n' });
  const store = new SessionStore(path.join(dir, 'sessions'));
  const session = store.create({ root: dir });
  const tools = createTools({ root: dir, overlay: new Overlay(dir) });
  const events = new Emitter();
  const seen = [];
  events.on('stagnation', (p) => seen.push(p));

  const bridge = scriptedLoop(['NEED file a.txt', 'NEED file a.txt', 'DONE read it']);
  const result = await runTask('read the file', {
    bridge, tools, overlay: new Overlay(dir), session, events,
    options: { maxSteps: 8 }, first: true,
  });

  assert.equal(result.stopReason, 'done');
  assert.deepEqual(seen.map((p) => p.action), ['warn'], 'warned once, never stopped');
  assert.match(bridge.received[2], /repeating it moves nothing/, 'the correction reached the model');
});
