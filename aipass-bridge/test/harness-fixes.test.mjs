// One test per finding of the harness sweep, each a measured defect:
//
//   H1 the harness walked into its own spill directory — `.aipass` was missing
//      from SKIP, so LIST/SEARCH/GLOB traversed the output of earlier runs
//   H2 glob() matched only the last segment of a `**` pattern, so
//      `src/**/*.ts` returned every .ts file in the tree
//   H3 the git gate was a prefix test, so `branch -D main`, `tag -d v1`,
//      `remote add …` and `-c core.pager=sh status` all passed
//   H4 append() rewrote the whole session file on every entry (O(nÂ²) IO)
//   H5 a rejected send was recorded before it was ever accepted, so the
//      session kept ghost messages the server never saw — and every
//      resilientSay retry wrote a duplicate
//   H7 nothing stopped a run that repeated the same step with the same
//      results until the step limit — a loop that burns the whole budget
//   H8 #makeHelper() built its engine with no rules, so a `.env* → deny` rule
//      was bypassed by every helper run
//   H9 the same `.env* → deny` rule stopped writes but not reads — `NEED file
//      .env` still sent the secrets upstream; reads consult the rules now
//   H10 a reply that tried to speak the protocol and mangled it parsed to
//      nothing, and the implicit-done path read that as an answer — a
//      marker-shaped line now earns the shape-teaching nudge instead
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
// The 403 waits are pinned by their own tests; here H5 only needs the retry
// order, not the clock.
process.env.AIPASS_EDGE_WAITS_MS = '0';
// The run-level pause before a refused send is given the message again.
process.env.AIPASS_RECOVER_WAITS_MS = '0';
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

test('the spill directory is out of every listing, but still readable', async () => {
  const dir = tempDir({
    'a.ts': 'export const needle = 1;\n',
    // What spill() leaves behind after a long tool result: the same "needle",
    // in a file the harness itself wrote.
    '.aipass/spill/x.txt': 'needle from an earlier run\n'.repeat(40),
  });
  const tools = toolsIn(dir);

  const search = await tools.search('needle');
  assert.ok(search.includes('a.ts'), 'the real file is still found');
  assert.ok(!search.includes('.aipass'), `an earlier run's spill is not searchable:\n${search}`);

  const listing = tools.list('.').split('\n');
  assert.ok(listing.includes('a.ts'));
  assert.ok(!listing.some((n) => n.startsWith('.aipass')), `.aipass is skipped: ${listing.join(', ')}`);

  // SKIP governs listing/search/glob only. The locator spill() returns points
  // the model straight back at one of these files, so that path must survive.
  const back = tools.read('.aipass/spill/x.txt');
  assert.ok(back.includes('needle from an earlier run'), 'NEED file still reads the spill');

  const globbed = await tools.glob('**/*.txt');
  assert.ok(!globbed.includes('.aipass'), 'and a glob does not surface it either');
});

/* H2 — glob honours the prefix before ** ---------------------------------- */

test('glob matches the pattern against the whole path, not the last segment', async () => {
  const dir = tempDir({
    'index.ts': 'zero\n',
    'src/a.ts': 'one\n',
    'src/deep/b.ts': 'two\n',
    'docs/c.ts': 'three\n',
  });
  const tools = toolsIn(dir);
  const sorted = async (p) => (await tools.glob(p)).split('\n').sort();

  assert.deepEqual(await sorted('src/**/*.ts'), ['src/a.ts', 'src/deep/b.ts'],
    'the prefix is honoured: docs/c.ts is not under src');
  assert.deepEqual(await sorted('src/*.ts'), ['src/a.ts'],
    'a single * still stops at the separator');
  assert.deepEqual(await sorted('*.ts'), ['index.ts'], 'and so does a bare pattern');
  // `**` matches no separators as well as many, which is what lets `**/*.ts`
  // reach index.ts at the root while still spanning src/deep.
  assert.deepEqual(await sorted('**/*.ts'), ['docs/c.ts', 'index.ts', 'src/a.ts', 'src/deep/b.ts']);

  assert.match(await tools.glob('src/**/*.tsx'), /^no files matched "src\/\*\*\/\*\.tsx"\.$/);
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

test('git outside a repository answers in one line, not a page of help', async () => {
  // Live finding (2026-10-15): `git diff` in a plain folder printed the whole
  // option help with exit 129 and spilled 4 KB of context. The one fact worth
  // having fits in a line.
  const dir = tempDir({ 'a.txt': 'hello\n' });
  const tools = toolsIn(dir);

  const out = await tools.git('diff');
  assert.match(out, /^err: not a git repository/);
  assert.ok(out.split('\n').length <= 2, `one line of reason, got:\n${out}`);
});

/* H4 — the header is rewritten in batches --------------------------------- */

test('append batches the header rewrite, and rename still fixes it at once', (t) => {
  const store = new SessionStore(tempDir());
  const session = store.create({ root: tempDir(), title: 'batch me' });

  // rewriteHeader() is the only thing that rewrites an existing session file.
  // Since headers are padded to a fixed width, a rewrite is normally one
  // writeSync at offset 0 (the atomic writeFileSync swap remains the fallback
  // for unpadded files) — so both write paths count as one rewrite. That also
  // tells appendFileSync apart from it: on Node 24 an append is implemented as
  // a writeFileSync, and the caller in the stack is what separates "one entry
  // appended" from "the header rewritten".
  const realWrite = fs.writeFileSync;
  const realWriteSync = fs.writeSync;
  const rewrites = [];
  const count = (file) => {
    const target = String(file) === session.file || String(file) === `${session.file}.tmp`;
    if (target && /rewriteHeader/.test(new Error().stack)) rewrites.push(String(file));
  };
  fs.writeFileSync = function spied(file, ...rest) {
    count(file);
    return realWrite.call(this, file, ...rest);
  };
  fs.writeSync = function spiedSync(fd, ...rest) {
    if (typeof fd === 'number') count(session.file);
    return realWriteSync.call(this, fd, ...rest);
  };
  t.after(() => { fs.writeFileSync = realWrite; fs.writeSync = realWriteSync; });

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

/* H9 — a deny rule stops reads as well -------------------------------------- */

test('a deny rule keeps secrets out of reads too (H9)', () => {
  const engine = new PermissionEngine({ mode: 'yolo', allowRun: false, rules: [{ pattern: '.env*', decision: 'deny' }] });
  assert.equal(engine.evaluate({ kind: 'read', arg: '.env' }).decision, 'deny');
  assert.equal(engine.evaluate({ kind: 'read', arg: '.env.local' }).decision, 'deny');
  assert.equal(engine.evaluate({ kind: 'read', arg: '.env 1-20' }).decision, 'deny', 'a ranged read is the same file');
  assert.equal(engine.evaluate({ kind: 'read', arg: 'src/app.ts' }).decision, 'allow',
    'every read a rule does not name is still always allowed');

  // `kinds` still narrows a rule, so a writes-only rule stays out of reads.
  const writesOnly = new PermissionEngine({ mode: 'yolo', allowRun: false, rules: [{ pattern: '.env*', decision: 'deny', kinds: ['write'] }] });
  assert.equal(writesOnly.evaluate({ kind: 'read', arg: '.env' }).decision, 'allow');
  assert.equal(writesOnly.evaluate({ kind: 'write', arg: '.env' }).decision, 'deny');
});

test('a denied read is refused with a reason before the file is opened (H9)', async () => {
  const root = tempDir({ '.env': 'SECRET=1\n' });

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
    bridge: new StubBridge(['NEED file .env\n', 'DONE kept it local\n']),
    store: new SessionStore(tempDir()),
    rules: [{ pattern: '.env*', decision: 'deny' }],
    events,
    options: { mode: 'yolo', maxSteps: 3 },
  });

  const seen = [];
  events.on('tool', (p) => seen.push(p));
  const result = await h.run('read the env file');

  assert.equal(result.stopReason, 'done');
  const denied = seen.find((p) => p.kind === 'read' && p.arg === '.env');
  assert.ok(denied, `the model asked for the file:\n${JSON.stringify(seen)}`);
  assert.match(denied.head, /denies reading \.env/, `the rule answered before the read happened:\n${denied.head}`);
});

/* H5 — only the sends the server accepted are recorded --------------------- */

/* H12 — an attachment queued for the next message rides every attempt of it - */

test('an attachment queued for the next message survives a refused send (H12)', async () => {
  const dir = tempDir({ 'shot.png': 'pretend this is a picture\n' });
  const store = new SessionStore(path.join(dir, 'sessions'));
  const session = store.create({ root: dir });
  const tools = createTools({ root: dir, overlay: new Overlay(dir) });

  // The model asks for the file, the tool queues it, and the send that
  // carries it is refused once and retried. The parts are taken by handing
  // them over, and they were taken again on the retry — so the retry went
  // out without the attachment, and nothing said so: the tool had already
  // answered "queued … it goes out with your next message".
  const replies = ['ATTACH shot.png', 'DONE attached'];
  const sent = [];
  let calls = 0;
  const result = await runTask('attach the shot', {
    bridge: {
      async chat({ message, parts }) {
        calls++;
        sent.push({ message, parts });
        if (calls === 2) throw new Error('bridge returned 503');
        return { text: replies[Math.min(calls - 1, replies.length - 1)] };
      },
      async quota() { return { available: 1 }; },
    },
    tools, overlay: new Overlay(dir), session,
    options: { maxSteps: 3 }, first: true,
  });

  assert.ok(calls >= 3, `the refused send was retried (calls: ${calls})`);
  assert.ok(sent[1].parts?.length, 'the first attempt carried the attachment');
  assert.ok(sent[2].parts?.length, 'and the retry carried it too');
  assert.equal(sent[2].parts[0].type, 'file');
  assert.equal(result.stopReason, 'done');
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

test('a send that failed outright records why it died (note + run_stats.sendError)', async () => {
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
  const note = session.entries.find((e) => e.type === 'note' && /the send failed: bridge is unreachable/.test(e.text));
  assert.ok(note, 'the failure was written to the session, not just emitted');
  const stats = session.entries.find((e) => e.type === 'run_stats');
  assert.equal(stats.sendError, 'bridge is unreachable', 'run_stats carries the cause');
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

/* H10 — a broken marker is an attempt, not an answer ------------------------ */

test('a marker-shaped line that parses to nothing earns the nudge, not a silent done (H10)', async () => {
  // Recorded live (session f5acb222): the model asked for a folder with a line
  // that parsed to nothing, and the run was marked done 633ms later with zero
  // nudges — the implicit-done path treats "prose after real work" as an
  // answer, and a mangled marker is not an answer.
  const dir = tempDir({ 'a.txt': 'hello\n' });
  const store = new SessionStore(path.join(dir, 'sessions'));
  const session = store.create({ root: dir });
  const events = new Emitter();
  const nudged = [];
  events.on('nudge', (p) => nudged.push(p));

  const bridge = scriptedLoop(['NEED file a.txt', 'NEED\n\nHere is what I have so far.', 'DONE finished']);
  const result = await runTask('read the file', {
    bridge, tools: toolsIn(dir), overlay: new Overlay(dir), session, events,
    options: { maxSteps: 8 }, first: true,
  });

  assert.equal(result.stopReason, 'done', 'the run still finishes — after the nudge');
  assert.deepEqual(nudged.map((p) => p.n), [1], 'the broken marker earned exactly one nudge');
  assert.match(bridge.received[2], /no marker I could act on/, 'the nudge teaches the shape instead of ending the run');
  assert.match(bridge.received[2], /if your answer is already written above, that is all the reply needs/, 'and a written answer plus DONE is enough');
  assert.equal(session.entries.find((e) => e.type === 'run_stats').nudges, 1);
});

test('a plain answer after real work still ends the run, un-nudged (H10)', async () => {
  // The guard above must not turn every prose ending into a nudge. A run that
  // did real work and closes with a sentence — no marker lookalike — is done.
  const dir = tempDir({ 'a.txt': 'hello\n' });
  const store = new SessionStore(path.join(dir, 'sessions'));
  const session = store.create({ root: dir });
  const events = new Emitter();
  const nudged = [];
  events.on('nudge', (p) => nudged.push(p));

  const bridge = scriptedLoop(['NEED file a.txt', 'The file says hello, nothing else to do.']);
  const result = await runTask('read the file', {
    bridge, tools: toolsIn(dir), overlay: new Overlay(dir), session, events,
    options: { maxSteps: 8 }, first: true,
  });

  assert.equal(result.stopReason, 'done', 'a closing sentence is still an answer');
  assert.deepEqual(nudged, [], 'and it is not nudged');
  assert.equal(result.steps, 1);
});

/* A RUN's label is its command --------------------------------------------- */

test('a run row carries the command, not an empty string', async () => {
  // The parser puts a RUN command in the body, so `arg` used to be '' — the
  // window showed a row that said "Run" and nothing else, the replayed session
  // the same, and the step result read "Result of run :" to the model.
  const dir = tempDir({});
  const store = new SessionStore(path.join(dir, 'sessions'));
  const session = store.create({ root: dir });
  const tools = createTools({ root: dir, overlay: new Overlay(dir) });
  const events = new Emitter();
  const seen = [];
  events.on('tool', (p) => seen.push(p));

  const bridge = scriptedLoop(['RUN\necho one\necho two\nEND', 'DONE ran it']);
  const result = await runTask('run the check', {
    bridge, tools, overlay: new Overlay(dir), session, events,
    permissions: new PermissionEngine({ mode: 'yolo', allowRun: true }),
    options: { maxSteps: 4 }, first: true,
  });

  assert.equal(result.stopReason, 'done');
  const run = seen.find((p) => p.kind === 'run');
  assert.ok(run, `the command ran:\n${JSON.stringify(seen)}`);
  assert.equal(run.arg, 'echo one', 'the row shows the first line of the command');
  // The session records the same label, so a replayed window reads the same row.
  const entry = session.entries.find((e) => e.type === 'tool' && e.kind === 'run');
  assert.equal(entry.arg, 'echo one');
});

/* Per-run budgets — the caps that stop a runaway reply or a stuck command --- */

test('a run whose wall clock is spent stops like the step limit (time-limited)', async () => {
  const dir = tempDir({ 'a.txt': 'hello\n' });
  const overlay = new Overlay(dir);
  const tools = createTools({ root: dir, overlay });
  let chats = 0;
  const result = await runTask('read the project', {
    bridge: {
      async chat() { chats++; await new Promise((r) => setTimeout(r, 350)); return { text: 'NEED file a.txt\n', reasoning: '' }; },
      async quota() { return { available: 10 }; },
    },
    tools, overlay,
    options: { maxSteps: 5, maxWallClockMs: 150 }, first: true,
  });

  assert.equal(result.stopReason, 'time-limited', 'the budget is the stop reason');
  assert.equal(result.steps, 0, 'the tool call the reply asked for never ran');
  assert.ok(chats <= 1, 'and the run never sent another step');
});

test('a reply full of markers stops at the tool-call cap (tools-limited)', async () => {
  const dir = tempDir({ 'a.txt': 'a\n', 'b.txt': 'b\n' });
  const overlay = new Overlay(dir);
  const tools = createTools({ root: dir, overlay });
  let chats = 0;
  const result = await runTask('read both files', {
    bridge: {
      async chat() { chats++; return { text: 'NEED file a.txt\n\nNEED file b.txt\n', reasoning: '' }; },
      async quota() { return { available: 10 }; },
    },
    tools, overlay,
    options: { maxSteps: 5, maxToolCalls: 1 }, first: true,
  });

  assert.equal(result.stopReason, 'tools-limited');
  assert.equal(result.steps, 1, 'exactly one call executed before the cap answered');
  assert.equal(chats, 1, 'and the run never sent another step');
});

/* SUBAGENT roles — a named helper is read-only and knows its job ------------ */

test('a role line reaches the helper, and the task text stays the task', async () => {
  const dir = tempDir({ 'a.txt': 'hello\n' });
  const overlay = new Overlay(dir);
  const tools = createTools({ root: dir, overlay });
  const calls = [];
  let chats = 0;
  const result = await runTask('check the thing', {
    bridge: {
      async chat() {
        return { text: ++chats === 1
          ? 'SUBAGENT\nrole: verifier\ntask: confirm a.txt says hello\nEND\n'
          : 'DONE checked\n', reasoning: '' };
      },
      async quota() { return { available: 10 }; },
    },
    tools, overlay,
    subagent: async (task, role) => { calls.push({ task, role }); return 'verdict: pass — a.txt says hello'; },
    options: { maxSteps: 3, subagent: true }, first: true,
  });

  assert.equal(result.stopReason, 'done');
  assert.deepEqual(calls, [{ task: 'confirm a.txt says hello', role: 'verifier' }],
    'the helper got the task, not the role line');
});

test('an unknown role is refused before any helper starts', async () => {
  const dir = tempDir({ 'a.txt': 'hello\n' });
  const overlay = new Overlay(dir);
  const tools = createTools({ root: dir, overlay });
  const events = new Emitter();
  const seen = [];
  events.on('tool', (p) => seen.push(p));
  let chats = 0;
  let helpers = 0;
  const result = await runTask('check the thing', {
    bridge: {
      async chat() {
        return { text: ++chats === 1
          ? 'SUBAGENT\nrole: wizard\ntask: do magic\nEND\n'
          : 'DONE gave up on the wizard\n', reasoning: '' };
      },
      async quota() { return { available: 10 }; },
    },
    tools, overlay, events,
    subagent: async () => { helpers++; return 'SHOULD NOT RUN'; },
    options: { maxSteps: 3, subagent: true }, first: true,
  });

  assert.equal(result.stopReason, 'done');
  assert.equal(helpers, 0, 'the helper never started');
  const refused = seen.find((p) => p.kind === 'subagent');
  assert.ok(refused && refused.ok === false && /no helper role/.test(refused.head),
    `the refusal names the problem:\n${JSON.stringify(seen)}`);
});

test('a roled helper is read-only: its edit is refused and nothing is staged', async () => {
  const root = tempDir({ 'src/app.ts': 'export const a = 1;\n' });

  class StubBridge extends BridgeClient {
    constructor(replies) {
      super('http://127.0.0.1:1');
      this.model = 'stub';
      this.replies = replies;
      this.turn = 0;
    }
    async chat() { return { text: this.replies[Math.min(this.turn++, this.replies.length - 1)], reasoning: '' }; }
    async quota() { return { available: 10 }; }
    async createConversation() { return { id: 'stub-conversation' }; }
    async config() {}
    async status() { return { conversation: 'stub-conversation' }; }
  }
  const events = new Emitter();
  const h = new Harness({
    root,
    bridge: new StubBridge([
      'SUBAGENT\nrole: verifier\ntask: check src/app.ts\nEND\n',
      'EDIT src/app.ts\nFIND\nconst a = 1;\nNEW\nconst a = 2;\nEND\nDONE ran the check\n',
      'DONE parent done\n',
    ]),
    store: new SessionStore(tempDir()),
    events,
    options: { mode: 'yolo', allowRun: false, subagent: true, maxSteps: 3 },
  });

  const seen = [];
  events.on('tool', (p) => seen.push(p));
  const result = await h.run('delegate the check');

  assert.equal(result.stopReason, 'done');
  const refused = seen.find((p) => p.kind === 'replace');
  assert.ok(refused && refused.ok === false && /read-only/.test(refused.head),
    `the helper's edit was refused by its role:\n${JSON.stringify(seen)}`);
  assert.equal(h.overlay.size, 0, 'nothing was staged, in the helper or the parent');
});

/* Helper reads the parent's staged tree, not the disk ------------------------ */

test("a helper reads the parent staged edit, not the disk", async () => {
  const root = tempDir({ 'notes.md': 'one\ntwo\n' });
  class StubBridge extends BridgeClient {
    constructor(replies) {
      super('http://127.0.0.1:1');
      this.model = 'stub';
      this.replies = replies;
      this.turn = 0;
    }
    async chat() { return { text: this.replies[Math.min(this.turn++, this.replies.length - 1)], reasoning: '' }; }
    async quota() { return { available: 10 }; }
    async createConversation() { return { id: 'stub-conversation' }; }
    async config() {}
    async status() { return { conversation: 'stub-conversation' }; }
  }
  const events = new Emitter();
  const helperEnds = [];
  events.on('helper_end', (p) => helperEnds.push(p));
  const seen = [];
  events.on('tool', (p) => seen.push(p));
  const h = new Harness({
    root,
    bridge: new StubBridge([
      `EDIT notes.md
FIND
two
NEW
2
END
`,
      `SUBAGENT
task: adjust the notes
END
`,
      `EDIT notes.md
FIND
2
NEW
three
END
DONE adjusted
`,
      `DONE parent done
`,
    ]),
    store: new SessionStore(tempDir()),
    events,
    options: { mode: 'yolo', allowRun: false, subagent: true, parallelHelpers: true, maxSteps: 6 },
  });

  const result = await h.run('adjust the notes');
  assert.equal(result.stopReason, 'done');

  const after = h.overlay.map.get(path.join(root, 'notes.md'));
  assert.equal(after, 'one\nthree\n', 'the helper edited the staged version, not the disk');
  assert.ok(seen.some((p) => p.kind === 'replace' && p.arg === 'notes.md' && p.ok),
    'the helper replace succeeded because it saw the staged version');
  assert.equal(helperEnds.length, 1, 'the helper reported back');
  assert.deepEqual(helperEnds[0].prepared, ['notes.md'], 'its edit was prepared for approval');
});

/* Parallel helpers: a conflict is reported, not silently lost ------------- */

test("parallel helpers editing one file: the first version lands and the other is told, not lost", async () => {
  const root = tempDir({});
  class StubBridge extends BridgeClient {
    constructor(replies) {
      super('http://127.0.0.1:1');
      this.model = 'stub';
      this.replies = replies;
      this.turn = 0;
    }
    async chat() { return { text: this.replies[Math.min(this.turn++, this.replies.length - 1)], reasoning: '' }; }
    async quota() { return { available: 10 }; }
    async createConversation() { return { id: 'stub-conversation' }; }
    async config() {}
    async status() { return { conversation: 'stub-conversation' }; }
  }
  const events = new Emitter();
  const helperEnds = [];
  events.on('helper_end', (p) => helperEnds.push(p));
  const h = new Harness({
    root,
    bridge: new StubBridge([
      `SUBAGENT
task: write A
END
SUBAGENT
task: write B
END
`,
      `CREATE shared.txt
A
END
DONE wrote A
`,
      `CREATE shared.txt
B
END
DONE wrote B
`,
      `DONE parent done
`,
    ]),
    store: new SessionStore(tempDir()),
    events,
    options: { mode: 'yolo', allowRun: false, subagent: true, parallelHelpers: true, maxSteps: 6 },
  });

  const result = await h.run('write shared');
  assert.equal(result.stopReason, 'done');
  assert.equal(helperEnds.length, 2, 'both helpers reported back');
  const prepared = helperEnds.flatMap((e) => e.prepared || []);
  const skipped = helperEnds.flatMap((e) => e.skipped || []);
  assert.deepEqual(prepared, ['shared.txt'], 'one version landed');
  assert.deepEqual(skipped, ['shared.txt'], 'the other was named, not silently dropped');
  const value = h.overlay.map.get(path.join(root, 'shared.txt'));
  assert.ok(value === 'A' || value === 'B', 'got: ' + JSON.stringify(value));
});

/* readSet is per run, not per harness -------------------------------------- */

test("a read in an earlier run does not license a blind CREATE in the next", async () => {
  const root = tempDir({ 'notes.txt': 'original text\n' });
  class StubBridge extends BridgeClient {
    constructor(replies) {
      super('http://127.0.0.1:1');
      this.model = 'stub';
      this.replies = replies;
      this.turn = 0;
    }
    async chat() { return { text: this.replies[Math.min(this.turn++, this.replies.length - 1)], reasoning: '' }; }
    async quota() { return { available: 10 }; }
    async createConversation() { return { id: 'stub-conversation' }; }
    async config() {}
    async status() { return { conversation: 'stub-conversation' }; }
  }
  const events = new Emitter();
  const seen = [];
  events.on('tool', (p) => seen.push(p));
  const h = new Harness({
    root,
    bridge: new StubBridge([
      'NEED file notes.txt\n',
      'DONE noted\n',
      'CREATE notes.txt\nreplacement\nEND\n',
      'DONE done\n',
    ]),
    store: new SessionStore(tempDir()),
    events,
    options: { mode: 'yolo', allowRun: false, maxSteps: 6 },
  });

  const r1 = await h.run('read it');
  assert.equal(r1.stopReason, 'done');
  const r2 = await h.run('replace it');
  assert.equal(r2.stopReason, 'done');
  const blindCreate = seen.find((p) => p.kind === 'write' && p.arg === 'notes.txt');
  assert.ok(blindCreate, 'the second run tried the blind CREATE');
  assert.equal(blindCreate.ok, false, 'and it was refused, because the first run read does not carry over');
  assert.match(blindCreate.head, /has not been read this run/i, 'the refusal names the missing read');
  assert.equal(h.overlay.size, 0, 'the blind CREATE staged nothing');
});

/* A rotation keeps the conversation its create returned ---------------------- */

test("a rotation keeps the conversation its create returned, not the shared pointer", async () => {
  const root = tempDir({ 'a.txt': 'x\n' });
  class StubBridge extends BridgeClient {
    constructor(replies) {
      super('http://127.0.0.1:1');
      this.model = 'stub';
      this.replies = replies;
      this.turn = 0;
      this.created = 0;
      this.chatConversations = [];
    }
    async chat({ conversation } = {}) {
      this.chatConversations.push(conversation || null);
      return { text: this.replies[Math.min(this.turn++, this.replies.length - 1)], reasoning: '' };
    }
    async quota() { return { available: 10 }; }
    async createConversation() { this.created += 1; return { id: 'created-' + this.created }; }
    async config() {}
    async status() { return { conversation: 'someone-elses-conversation' }; }
  }
  const bridge = new StubBridge(['a summary of the work so far', 'DONE still nothing to do']);
  const events = new Emitter();
  const compacted = [];
  events.on('compacted', (p) => compacted.push(p));
  const h = new Harness({
    root,
    bridge,
    store: new SessionStore(tempDir()),
    events,
    options: { mode: 'yolo', allowRun: false, maxSteps: 3 },
  });

  await h.run('first task');
  assert.equal(h.conversation, 'created-1', 'the first run talks in its own created conversation');
  assert.equal(bridge.chatConversations.at(-1), 'created-1');

  await h.compactNow('first task');
  assert.equal(compacted.length, 1, 'the rotation happened');
  assert.equal(h.conversation, 'created-2', 'the rotation adopted the id its create returned');
  assert.notEqual(h.conversation, 'someone-elses-conversation');

  await h.run('carry on');
  assert.equal(bridge.chatConversations.at(-1), 'created-2', 'sends after the rotation go to the rotated conversation');
});

/* A mid-run compaction rebinds the loop send target ---------------------- */

test("a mid-run compaction keeps sending to the rotated conversation", async () => {
  const root = tempDir({ 'a.txt': 'x\n' });
  class StubBridge extends BridgeClient {
    constructor(replies) {
      super('http://127.0.0.1:1');
      this.model = 'stub';
      this.replies = replies;
      this.turn = 0;
      this.created = 0;
      this.chatConversations = [];
    }
    async chat({ conversation } = {}) {
      this.chatConversations.push(conversation || null);
      return { text: this.replies[Math.min(this.turn++, this.replies.length - 1)], reasoning: '' };
    }
    async quota() { return { available: 10 }; }
    async createConversation() { this.created += 1; return { id: 'created-' + this.created }; }
    async config() {}
    async status() { return { conversation: 'someone-elses-conversation' }; }
  }
  const bridge = new StubBridge([
    `CREATE a.txt
hello
END
`,
    'a summary of the work so far',
    'DONE planted\n',
  ]);
  const events = new Emitter();
  const compacted = [];
  events.on('compacted', (p) => compacted.push(p));
  const h = new Harness({
    root,
    bridge,
    store: new SessionStore(tempDir()),
    events,
    compaction: { contextTokens: 60, reserveTokens: 0, keepRecentBytes: 0 },
    options: { mode: 'yolo', allowRun: false, maxSteps: 6 },
  });

  const result = await h.run('plant the file');
  assert.equal(result.stopReason, 'done');
  assert.equal(compacted.length, 1, 'the budget crossed mid-run');
  assert.ok(bridge.chatConversations.includes('created-2'), 'a send went out on the rotated conversation');
  assert.equal(bridge.chatConversations.at(-1), 'created-2', 'the last send used the rotated conversation, not the one it left');
});
/* H11 - the run's max-result and read-lines reach the tools ------------------ */

test("a run's max-result and read-lines options reach the tools (H11)", async () => {
  // Both flags were parsed into the run's options and never forwarded to the
  // tool context, so every tool kept the 3,000-byte / 250-line defaults
  // whatever the run asked for ΓÇö `--max-result` was a note nobody read
  // (aipass-bridge/AGENTS.md: "Tool results are capped at --max-result bytes").
  const root = tempDir({
    'big.txt': 'x'.repeat(6000) + '\n',
    'lines.txt': Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n'),
  });

  class StubBridge extends BridgeClient {
    constructor(replies) {
      super('http://127.0.0.1:1');
      this.model = 'stub';
      this.replies = replies;
      this.turn = 0;
      this.received = [];
    }
    async chat({ message }) {
      this.received.push(message);
      return { text: this.replies[Math.min(this.turn++, this.replies.length - 1)], reasoning: '' };
    }
    async quota() { return { available: 10 }; }
    async createConversation() { return { id: 'stub-conversation' }; }
    async config() {}
    async status() { return { conversation: 'stub-conversation' }; }
  }

  const bridge = new StubBridge(['NEED file big.txt\nNEED file lines.txt\n', 'DONE read both\n']);
  const h = new Harness({
    root,
    bridge,
    store: new SessionStore(tempDir()),
    events: new Emitter(),
    options: { mode: 'auto', maxSteps: 3, maxResult: 500, readLines: 3 },
  });

  const result = await h.run('read the files');
  assert.equal(result.stopReason, 'done');

  const resultsMessage = bridge.received[1];
  assert.ok(resultsMessage, 'the results message was sent');
  // 6,001 bytes against the run's 500-byte cap: the head rides the message,
  // the rest waits on disk behind the locator.
  assert.match(resultsMessage, /more bytes/, 'the max-result cap spilled instead of inlining');
  assert.match(resultsMessage, /\.aipass\/spill\/[a-f0-9]+\.txt/, 'with the locator to the rest');
  assert.ok(!resultsMessage.includes('x'.repeat(600)), 'nothing past the cap rides the message');

  // Ten lines against the run's 3-line page: the page stops at three and the
  // note says how to continue.
  assert.match(resultsMessage, /7 more line\(s\)/, 'the read-lines cap paginated the file');
});
