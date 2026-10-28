// The carry: what a new session's first message takes from the cross-session
// store (harness/memory-store.mjs).
//
// The store caps at 50 facts of 200 characters and the first message used to
// take ALL of them — up to ~2,500 tokens of context every new session paid
// for, most of it about work the task never touched. The carry picks instead:
// the facts the task names first, then the newest of the rest, under a byte
// budget. Alongside it: the save that rewrites nothing when nothing changed,
// and the recall that re-reads nothing it has already parsed — the three
// places the memory tier was paying twice for the same fact.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Harness } from '../harness/harness.mjs';
import { SessionStore } from '../harness/session.mjs';
import { carryFacts, CARRY_BUDGET_CHARS, loadMemory, saveMemory, memoryPath, recallEntries } from '../harness/memory-store.mjs';
import { startBridge, FakeExtension, scripted, tempDir } from './harness.mjs';

// A scratch state home, for the same reason every other file names one: a
// saveMemory without an explicit dir lands in AIPASS_HOME/memory, and a run
// without this line would write into the developer's own.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aipass-carry-home-'));
process.env.AIPASS_HOME = HOME;

let bridge;
before(async () => { bridge = await startBridge(); });
after(() => {
  bridge.stop();
  fs.rmSync(HOME, { recursive: true, force: true });
});

const dirs = [];
const scratch = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aipass-carry-'));
  dirs.push(dir);
  return dir;
};
after(() => { for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true }); });

const FACTS = [
  'decision: the login flow keeps its cookie jar warm',
  'constraint: never run the suite without a scratch home',
  'file: notes.txt — the scratch pad of the project',
  'decision: the export path is keyed by the project hash',
];

test('the carry picks the facts the task names, then the newest of the rest, under the budget', () => {
  const picked = carryFacts(FACTS, 'fix the login flow', { budgetChars: 2400 });
  // The matching fact rides even though it is the oldest…
  assert.match(picked[0], /login flow/);
  // …and everything fits, so the rest ride too, oldest first (the stored order).
  assert.deepEqual(picked, FACTS);
});

test('a tight budget keeps the matching fact and drops newer ones it does not name', () => {
  // 60 characters holds the login fact (51 + the bullet) and nothing else —
  // a newer unrelated fact is what the old behaviour would have shipped.
  const picked = carryFacts(FACTS, 'fix the login flow', { budgetChars: 60 });
  assert.deepEqual(picked, [FACTS[0]], 'the fact about the task outranks the newer ones');

  const noMatch = carryFacts(FACTS, 'do something else entirely', { budgetChars: 60 });
  assert.deepEqual(noMatch, [FACTS[3]], 'with nothing matching, the newest fact is the one that rides');
});

test('the carry is deterministic and leaves the stored list alone', () => {
  const stored = [...FACTS];
  const a = carryFacts(stored, 'fix the login flow');
  const b = carryFacts(stored, 'fix the login flow');
  assert.deepEqual(a, b, 'the same facts and task carry byte-identically');
  assert.deepEqual(stored, FACTS, 'the store list is read, never mutated');
});

test('the budget defaults to the module constant, and the environment can name another one', () => {
  const defaultPicked = carryFacts(FACTS, '');
  assert.ok(defaultPicked.length, 'the default budget carries something');
  assert.ok(defaultPicked.join('').length <= CARRY_BUDGET_CHARS, 'and stays under it');

  process.env.AIPASS_MEMORY_BUDGET = '60';
  try {
    assert.deepEqual(carryFacts(FACTS, ''), [FACTS[3]], 'the env budget decides what a first message takes');
    assert.deepEqual(carryFacts(FACTS, '', { budgetChars: 10 }), [], 'an explicit option outranks the env');
  } finally {
    delete process.env.AIPASS_MEMORY_BUDGET;
  }
});

test('a save that changes nothing rewrites nothing, and a new fact still lands', async () => {
  const dir = scratch();
  saveMemory(dir, FACTS);
  const file = memoryPath(dir);
  const before = fs.statSync(file);
  // The clock has to move: an mtime that cannot move proves nothing. The
  // atomic write renames a NEW file over this one, so any rewrite moves it.
  await new Promise((r) => setTimeout(r, 20));

  saveMemory(dir, [...FACTS]); // every fact a duplicate — the no-op case
  const after = fs.statSync(file);
  assert.equal(after.mtimeMs, before.mtimeMs, 'the duplicate save left the file untouched');
  assert.equal(after.size, before.size, 'and it is the same file');

  saveMemory(dir, ['decision: one more fact']);
  const grown = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(grown.includes('decision: one more fact'), 'a new fact is still written');
  assert.deepEqual(loadMemory(dir), grown, 'and the load reads what was written');
});

test('a recall sees a session that grew since the last recall', async () => {
  const home = scratch();
  const dir = scratch();
  const store = new SessionStore(path.join(home, 'sessions'));
  const session = store.create({ root: dir, model: 'stub', title: 'the first look' });
  session.append('user', { text: 'the login flow is broken on the callback' });

  const first = await recallEntries('login flow', { root: dir, store });
  assert.equal(first.hits.length, 1, 'the first recall reads and answers');

  // The tail cache holds what the first call parsed; the append changes the
  // file's stat, and that is the invalidation — the second call must not
  // answer from a memory of the file.
  session.append('user', { text: 'the login flow callback now retries with a backoff' });
  const second = await recallEntries('login flow', { root: dir, store });
  assert.ok(second.hits.length >= 2, 'the growth is seen, not cached away');
  assert.ok(second.hits.some((h) => /backoff/.test(h.excerpt)), 'and the new words are in it');
});

// The end-to-end seam: a new session's first message takes the picked facts,
// the second run of the same session takes none, and the store keeps
// everything the carry left out.
test('a session carries its facts once, under the budget', async (t) => {
  const dir = tempDir({ 'a.txt': 'x\n' });
  saveMemory(dir, [
    'decision: the login flow keeps its cookie jar warm',
    'file: notes.txt — the scratch pad of the project',
  ]);

  process.env.AIPASS_MEMORY_BUDGET = '60';
  t.after(() => { delete process.env.AIPASS_MEMORY_BUDGET; });

  const handler = scripted(['DONE แรกเสร็จ', 'DONE ที่สองเสร็จ']);
  const ext = await new FakeExtension(bridge.base, { onChat: handler }).connect();
  t.after(() => ext.disconnect());

  const h = new Harness({ root: dir, bridgeURL: bridge.base });
  await h.startSession({ title: 'carry-once' });
  await h.run('fix the login flow');

  assert.match(handler.sent[0], /Facts carried from earlier sessions/, 'the first run carries');
  assert.match(handler.sent[0], /cookie jar warm/, 'the fact the task names rides');
  assert.doesNotMatch(handler.sent[0], /scratch pad/, 'a newer fact the task does not name stays home under this budget');
  assert.match(handler.sent[0], /Task: fix the login flow/, 'and the task is still the task');

  await h.run('the second task');
  assert.doesNotMatch(handler.sent[1], /Facts carried from earlier sessions/, 'a later run of the session does not re-carry');

  const stored = loadMemory(dir);
  assert.equal(stored.length, 2, 'the carry picks — the store keeps everything');
});
