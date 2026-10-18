// The evals runner's self-tests (docs/SPEC_EVALS.md §6), all offline: replay mode
// through a StubBridge, no fetch, no real bridge, no live model. The Harness
// facade is driven for real — loop, tools, overlay, apply, check — only the
// bytes between chat and the model are a stub.
//
// AIPASS_HOME points at a mkdtemp so nothing touches the real ~/.aipass
// (harness-fixes.test.mjs convention).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './harness.mjs';
import {
  EvalTaskError,
  digestOf,
  formatSummary,
  loadTask,
  loadTranscript,
  parseBudget,
  parseArgs,
  replayBridge,
  resolveTask,
  runAttempt,
  runEval,
  treeDigestOf,
} from '../../scripts/evals.mjs';
import { APP_VERSION } from '../harness/session.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EVALS = path.resolve(HERE, '..', '..', 'evals');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aipass-evals-home-'));
process.env.AIPASS_HOME = HOME;
const ATTEMPTS = [];
after(() => {
  for (const dir of ATTEMPTS) fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(HOME, { recursive: true, force: true });
});

/** Preserve an attempt's temp dir for the after() cleanup. */
const track = (row) => { if (row?.attemptDir) ATTEMPTS.push(row.attemptDir); return row; };

function writeFiles(dir, files) {
  for (const [name, text] of Object.entries(files)) {
    const p = path.join(dir, name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
  }
}

/** A task built in a temp dir, the same shape the shipped fixtures use. */
function makeTask(files, {
  id = 'temp-task', check = 'node check.mjs', budget = {}, allowRun = false,
  taskText = 'Do the task.', category = null, liveOnly = false,
} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aipass-eval-task-'));
  fs.writeFileSync(path.join(dir, 'task.md'), taskText);
  fs.writeFileSync(path.join(dir, 'task.json'), JSON.stringify({
    check,
    budget,
    allowRun,
    ...(category ? { category } : {}),
    ...(liveOnly ? { liveOnly: true } : {}),
  }, null, 2));
  writeFiles(path.join(dir, 'tree'), files);
  return loadTask(dir, { id });
}

/** Byte-exact snapshot of a directory tree, for "the fixture is only read". */
function snapshotTree(dir) {
  const out = {};
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(d, e.name);
      const key = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(full, key);
      else out[key] = fs.readFileSync(full).toString('base64');
    }
  };
  if (fs.existsSync(dir)) walk(dir, '');
  return out;
}

// The check both scoring tests share: exit 0 only when out.txt holds 42.
const OUT_CHECK = [
  "import fs from 'node:fs';",
  "const text = fs.readFileSync('out.txt', 'utf8').trim();",
  "console.log(text === '42' ? 'PASS' : 'FAIL: out.txt holds ' + text);",
  "process.exit(text === '42' ? 0 : 1);",
  '',
].join('\n');

const resultsDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aipass-eval-results-'));

/* 1 — loadTask parses task.md + task.json; failures are named errors -------- */

test('loadTask parses task.md + task.json and names its failures', () => {
  const dir = tempDir({
    'task.md': 'Fix the thing.\n',
    'task.json': JSON.stringify({ check: 'node check.mjs', budget: { model: 'm', thinking: 'high', maxSteps: 3 }, allowRun: true }),
    'tree/a.txt': 'hello\n',
  });
  const task = loadTask(dir, { id: 'parsed' });
  assert.equal(task.id, 'parsed');
  assert.equal(task.kind, 'tasks');
  assert.equal(task.taskText, 'Fix the thing.\n');
  assert.equal(task.check, 'node check.mjs');
  assert.equal(task.allowRun, true);
  assert.deepEqual(task.budget, { model: 'm', thinking: 'high', maxSteps: 3, wallMs: null });

  // The shipped layout is loadable the way --task resolves it.
  assert.ok(resolveTask('math-fix', { evalsDir: EVALS }).check);
  assert.throws(() => resolveTask('no-such-task', { evalsDir: EVALS }),
    (err) => err instanceof EvalTaskError && /no task named/.test(err.message));

  const noCheck = tempDir({ 'task.md': 'x\n', 'task.json': '{}', 'tree/a.txt': 'x\n' });
  assert.throws(() => loadTask(noCheck),
    (err) => err instanceof EvalTaskError && err.name === 'EvalTaskError' && /no check command/.test(err.message));

  const badJson = tempDir({ 'task.md': 'x\n', 'task.json': '{ nope', 'tree/a.txt': 'x\n' });
  assert.throws(() => loadTask(badJson),
    (err) => err instanceof EvalTaskError && /not valid JSON/.test(err.message));

  const noTree = tempDir({ 'task.md': 'x\n', 'task.json': JSON.stringify({ check: 'node check.mjs' }) });
  assert.throws(() => loadTask(noTree),
    (err) => err instanceof EvalTaskError && /no tree\//.test(err.message));
});

/* 2 — scoring: exit 0 → solved; nonzero → unsolved with tail; copy only ---- */

test('the check decides the outcome, and the fixture tree stays byte-identical', async () => {
  const task = makeTask({ 'out.txt': 'nothing here yet\n', 'check.mjs': OUT_CHECK }, { id: 'out-42', budget: { maxSteps: 3 } });
  const source = snapshotTree(path.join(task.dir, 'tree'));

  const solved = track(await runAttempt(task, {
    mode: 'replay',
    bridge: replayBridge(['NEED file out.txt\n', 'CREATE out.txt\n42\nEND\nDONE wrote 42']),
  }));
  assert.equal(solved.stopReason, 'done');
  assert.equal(solved.outcome, 'solved', `check said: ${solved.check.tail}`);
  assert.equal(solved.check.exit, 0);
  assert.deepEqual(snapshotTree(path.join(task.dir, 'tree')), source, 'writes went to the attempt copy, never the fixture');

  const unsolved = track(await runAttempt(task, {
    mode: 'replay',
    bridge: replayBridge(['NEED file out.txt\n', 'CREATE out.txt\n7\nEND\nDONE wrote 7']),
  }));
  assert.equal(unsolved.outcome, 'unsolved');
  assert.notEqual(unsolved.check.exit, 0);
  assert.match(unsolved.check.tail, /FAIL: out\.txt holds 7/, 'the check output is the evidence');
  assert.deepEqual(snapshotTree(path.join(task.dir, 'tree')), source, 'still untouched after a failed check');
});

/* 3 — results: two attempts append two JSONL rows; summary names outcomes -- */

test('two attempts append two JSONL rows and the summary names each outcome', async () => {
  const solvedTask = makeTask({ 'out.txt': 'x\n', 'check.mjs': OUT_CHECK }, { id: 'row-solved', budget: { maxSteps: 2 } });
  const failedTask = makeTask({ 'out.txt': 'x\n', 'check.mjs': OUT_CHECK }, { id: 'row-failed', budget: { maxSteps: 2 } });
  const replies = new Map([
    ['row-solved', ['NEED file out.txt\n', 'CREATE out.txt\n42\nEND\nDONE wrote 42']],
    ['row-failed', ['NEED file out.txt\n', 'CREATE out.txt\n7\nEND\nDONE wrote 7']],
  ]);

  const out = await runEval({
    tasks: [solvedTask, failedTask],
    mode: 'replay',
    bridgeFor: (task) => replayBridge(replies.get(task.id)),
    resultsDir: resultsDir(),
  });
  for (const row of out.rows) track(row);

  const lines = fs.readFileSync(out.resultsFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 2, 'one JSONL row per attempt');
  assert.deepEqual(lines.map((r) => r.taskId), ['row-solved', 'row-failed']);
  assert.deepEqual(lines.map((r) => r.outcome), ['solved', 'unsolved']);
  assert.ok(lines.every((r) => r.mode === 'replay'));

  for (const row of lines) {
    assert.equal(typeof row.stopReason, 'string', 'run_stats was read back from the session JSONL');
    assert.equal(typeof row.steps, 'number');
    assert.ok(Array.isArray(row.stepMs) && row.stepMs.length >= 1, 'one timing per conversation turn');
    assert.equal(typeof row.nudges, 'number');
    assert.equal(row.spent, 0, 'the stub quota did not move');
    assert.ok(row.wallMs > 0, 'wall clock is measured around run + apply');
    assert.equal(row.check.exit === 0, row.outcome === 'solved');
  }

  const table = formatSummary(out.rows);
  assert.match(table, /row-solved/);
  assert.match(table, /row-failed/);
  assert.match(table, /solved/);
  assert.match(table, /unsolved/);
});

/* 4 — replay: the recorded transcript solves the math fixture, no fetch ---- */

test('a recorded transcript takes the math fixture to done and a passing check', async () => {
  const transcript = loadTranscript(path.join(EVALS, 'fixtures', 'math-fix-replay.json'));
  assert.equal(transcript.taskId, 'math-fix');
  const task = resolveTask(transcript.taskId, { evalsDir: EVALS });

  // No network anywhere: any fetch during the run is a test failure.
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('replay must not fetch'); };
  let row;
  try {
    const out = await runEval({ tasks: [task], mode: 'replay', transcript, resultsDir: resultsDir() });
    row = track(out.rows[0]);
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.equal(row.stopReason, 'done');
  assert.equal(row.check.exit, 0, `check said: ${row.check.tail}`);
  assert.match(row.check.tail, /PASS/);
  assert.equal(row.outcome, 'solved');
  assert.ok(row.replayFingerprint, 'a replay row carries its fingerprint');
  assert.equal(row.replayFingerprint.stale, false, row.replayFingerprint.reason ?? '');
  assert.equal(row.replayFingerprint.match, true);
  assert.equal(row.replayFingerprint.replies, 2);
  assert.ok(row.session.file && fs.existsSync(row.session.file), 'the attempt session is evidence on disk');
  assert.ok(row.conversations.length >= 1, 'the temporary conversation id is recorded');

  // The applied copy carries the fix; the fixture source does not.
  assert.match(fs.readFileSync(path.join(row.attemptDir, 'tree', 'math.mjs'), 'utf8'), /sum = sum \+ n/);
  assert.match(fs.readFileSync(path.join(task.dir, 'tree', 'math.mjs'), 'utf8'), /sum = sum - n/);
});

/* 5 — isolation: sessions live under the attempt dir; the decoy is untouched */

test('an attempt writes sessions only under its own attempt dir', async () => {
  const task = makeTask({ 'out.txt': 'x\n', 'check.mjs': OUT_CHECK }, { id: 'iso', budget: { maxSteps: 2 } });
  const decoy = fs.mkdtempSync(path.join(os.tmpdir(), 'aipass-eval-decoy-'));
  fs.writeFileSync(path.join(decoy, 'keep.txt'), 'do not touch\n');
  const before = snapshotTree(decoy);

  const prev = process.env.AIPASS_HOME;
  process.env.AIPASS_HOME = decoy;
  let row;
  try {
    const out = await runEval({
      tasks: [task],
      mode: 'replay',
      bridgeFor: () => replayBridge(['CREATE out.txt\n42\nEND\nDONE wrote 42']),
      resultsDir: resultsDir(),
    });
    row = track(out.rows[0]);
    assert.equal(process.env.AIPASS_HOME, decoy, 'the runner restores the environment after the attempt');
  } finally {
    process.env.AIPASS_HOME = prev;
  }

  const sessions = path.join(row.attemptDir, 'home', 'sessions');
  assert.ok(fs.existsSync(sessions), 'the attempt keeps its own home beside its tree');
  assert.ok(fs.readdirSync(sessions).length > 0, 'the session was written there');
  assert.ok(row.session.file.startsWith(sessions + path.sep), row.session.file);
  assert.deepEqual(snapshotTree(decoy), before, 'the decoy AIPASS_HOME is untouched');
});

/* 6 — budget plumbing: thinking / maxSteps / allowRun reach the loop ------- */

test('thinking, maxSteps and allowRun from task.json reach the loop', async () => {
  const task = makeTask(
    { 'a.txt': 'hello\n', 'check.mjs': 'process.exit(0);\n' },
    { id: 'budget', budget: { maxSteps: 1, thinking: 'high' }, allowRun: true, taskText: 'look at a.txt' },
  );
  let bridge = null;
  const out = await runEval({
    tasks: [task],
    mode: 'replay',
    bridgeFor: () => (bridge = replayBridge(['NEED file a.txt\n'])),
    resultsDir: resultsDir(),
  });
  const row = track(out.rows[0]);

  assert.equal(row.stopReason, 'steps', 'maxSteps 1 cuts the run before a second reply');
  assert.equal(bridge.sends.length, 1);
  assert.equal(bridge.sends[0].thinkingLevel, 'high', 'the thinking level rode the request');
  assert.match(bridge.sends[0].message, /run something in the terminal/i, 'allowRun put the RUN marker in the preamble');
  assert.equal(row.budget.maxSteps, 1);
  assert.equal(row.budget.thinking, 'high');
  assert.equal(row.budget.allowRun, true);

  // The --budget override replaces per-task values for the whole matrix row.
  const over = track(await runAttempt(task, {
    mode: 'replay',
    bridge: replayBridge(['DONE nothing needed']),
    budget: parseBudget('maxSteps=2,thinking=off,model=stub-model'),
  }));
  assert.equal(over.budget.maxSteps, 2);
  assert.equal(over.budget.thinking, 'off');
  assert.equal(over.budget.model, 'stub-model');
  assert.throws(() => parseBudget('steps=2'), /knows maxSteps, model, thinking/);
});

/* 7 — pacing: --pause spaces attempts, and the flag parses strictly -------- */

test('runEval waits pauseMs between attempts, and --pause parses strictly', async () => {
  const make = (id) => makeTask({ 'out.txt': 'x\n', 'check.mjs': OUT_CHECK }, { id, budget: { maxSteps: 2 } });
  const out = await runEval({
    tasks: [make('pace-a'), make('pace-b')],
    mode: 'replay',
    bridgeFor: () => replayBridge(['CREATE out.txt\n42\nEND\nDONE wrote 42']),
    resultsDir: resultsDir(),
    pauseMs: 150,
  });
  for (const row of out.rows) track(row);
  assert.equal(out.rows.length, 2);
  assert.ok(out.rows[1].ts - out.rows[0].ts >= 150, 'the second attempt started after the pause');

  assert.equal(parseArgs(['--pause', '2500']).pause, 2500);
  assert.equal(parseArgs([]).pause, 0);
  assert.throws(() => parseArgs(['--pause', 'soon']), /--pause needs milliseconds/);
  assert.equal(parseArgs([]).keep, false, '--keep is off by default');
  assert.equal(parseArgs(['--keep']).keep, true);
});

/* 8 — dataset versions: taskDigest / treeDigest / category / env on a row --- */

test('rows carry the dataset versions and the environment they ran on', async () => {
  const task = makeTask({ 'out.txt': 'x\n', 'check.mjs': OUT_CHECK }, {
    id: 'versioned', budget: { maxSteps: 2 }, category: 'robustness',
  });
  const row = track(await runAttempt(task, {
    mode: 'replay',
    bridge: replayBridge(['CREATE out.txt\n42\nEND\nDONE wrote 42']),
  }));

  assert.equal(row.category, 'robustness');
  assert.equal(row.taskDigest, digestOf(task.taskText));
  assert.equal(row.treeDigest, treeDigestOf(path.join(task.dir, 'tree')));
  assert.match(row.promptDigest, /^[0-9a-f]{16}$/, 'the prompt version rides every row');
  assert.equal(row.env.app, APP_VERSION);
  assert.equal(row.env.node, process.version);
  assert.equal(row.env.platform, process.platform);

  // A one-byte change to the fixture moves the tree digest.
  const twin = makeTask({ 'out.txt': 'y\n', 'check.mjs': OUT_CHECK }, { id: 'versioned-2', budget: { maxSteps: 2 } });
  assert.notEqual(treeDigestOf(path.join(twin.dir, 'tree')), row.treeDigest, 'the digest tracks the tree');
});

/* 9 — --keep: a copy of the attempt session lands beside the results -------- */

test('--keep copies each attempt session beside the run results', async () => {
  const task = makeTask({ 'out.txt': 'x\n', 'check.mjs': OUT_CHECK }, { id: 'kept', budget: { maxSteps: 2 } });
  const dir = resultsDir();
  const out = await runEval({
    tasks: [task],
    mode: 'replay',
    bridgeFor: () => replayBridge(['CREATE out.txt\n42\nEND\nDONE wrote 42']),
    resultsDir: dir,
    keep: true,
  });
  const row = track(out.rows[0]);
  assert.ok(row.session.kept, 'the row points at the kept copy');
  assert.ok(row.session.kept.startsWith(dir), 'the copy lands beside the results, not in %TEMP%');
  assert.ok(fs.existsSync(row.session.kept));
  const keptText = fs.readFileSync(row.session.kept, 'utf8');
  assert.equal(keptText, fs.readFileSync(row.session.file, 'utf8'), 'the copy is byte-identical');
  assert.match(keptText, /"type":"run_stats"|run_stats/, 'the evidence includes the run stats line');
  assert.ok(out.keepDir && fs.existsSync(out.keepDir));

  // Without --keep the row says so honestly.
  const plain = track(await runAttempt(task, { mode: 'replay', bridge: replayBridge(['DONE nothing']) }));
  assert.equal(plain.session.kept, null);
});

/* 10 — replay skips live-only tasks ---------------------------------------- */

test('a replay run skips live-only tasks, and refuses to score only those', async () => {
  const normal = makeTask({ 'out.txt': 'x\n', 'check.mjs': OUT_CHECK }, { id: 'normal', budget: { maxSteps: 2 } });
  const safety = makeTask({ 'out.txt': 'x\n', 'check.mjs': OUT_CHECK }, { id: 'safety-temp', budget: { maxSteps: 2 }, liveOnly: true });
  assert.equal(safety.liveOnly, true, 'loadTask reads the liveOnly key');

  const logged = [];
  const out = await runEval({
    tasks: [normal, safety],
    mode: 'replay',
    bridgeFor: () => replayBridge(['CREATE out.txt\n42\nEND\nDONE wrote 42']),
    resultsDir: resultsDir(),
    log: (line) => logged.push(line),
  });
  for (const row of out.rows) track(row);
  assert.deepEqual(out.rows.map((r) => r.taskId), ['normal']);
  assert.ok(logged.some((l) => /skipped live-only: safety-temp/.test(l)), logged.join('\n'));

  await assert.rejects(
    runEval({ tasks: [safety], mode: 'replay', resultsDir: resultsDir() }),
    /every selected task is live-only/,
  );
});

/* 11 — the summary's slices: category, mixed attempts, pair drift ----------- */

test('formatSummary names categories, mixed outcomes and pair drift', () => {
  const rows = [
    { taskId: 'sum-numbers', outcome: 'solved', scored: true, category: 'robustness', pair: 'sum-numbers', wallMs: 1000 },
    { taskId: 'sum-numbers-twin', outcome: 'unsolved', scored: true, category: 'robustness', pair: 'sum-numbers', wallMs: 1200 },
    { taskId: 'math-fix', outcome: 'solved', scored: true, category: null, pair: null, wallMs: 900 },
    { taskId: 'math-fix', outcome: 'unsolved', scored: true, category: null, pair: null, wallMs: 950 },
    { taskId: 'safety-x', outcome: 'solved', scored: true, category: 'safety', pair: null, wallMs: 800 },
  ];
  const text = formatSummary(rows);
  assert.match(text, /by category: robustness 1\/2 · safety 1\/1 · uncategorized 1\/2/);
  assert.match(text, /mixed outcomes: math-fix 1\/2/);
  assert.match(text, /pair drift: sum-numbers 1\/2/);
});

/* 12 — digests are stable across runs, and move with the bytes ------------- */

test('digests are stable across runs and track a one-byte fixture change', async () => {
  const task = makeTask({ 'out.txt': 'x\n', 'check.mjs': OUT_CHECK }, { id: 'digest-a', budget: { maxSteps: 3 } });
  const reply = ['NEED file out.txt\n', 'CREATE out.txt\n42\nEND\nDONE wrote 42'];
  const a = track(await runAttempt(task, { mode: 'replay', bridge: replayBridge(reply) }));
  const b = track(await runAttempt(task, { mode: 'replay', bridge: replayBridge(reply) }));

  assert.equal(a.outcome, 'solved');
  assert.equal(b.outcome, 'solved');
  assert.equal(a.taskDigest, b.taskDigest, 'same task bytes, same digest');
  assert.equal(a.treeDigest, b.treeDigest, 'same tree bytes, same digest');
  assert.equal(a.promptDigest, b.promptDigest, 'same preamble bytes, same digest');
  assert.deepEqual(a.env, b.env, 'same build, same environment');

  // A one-byte-scale edit to the fixture moves the tree digest — and the
  // check runs against the new bytes: a reply that writes 42 now fails a
  // check that wants 7. The row proves which bytes were scored.
  const before = treeDigestOf(path.join(task.dir, 'tree'));
  fs.writeFileSync(path.join(task.dir, 'tree', 'check.mjs'), OUT_CHECK.split("'42'").join("'7'"));
  const after = treeDigestOf(path.join(task.dir, 'tree'));
  assert.notEqual(after, before, 'the digest tracks the tree bytes');

  const moved = track(await runAttempt(task, { mode: 'replay', bridge: replayBridge(reply) }));
  assert.equal(moved.treeDigest, after, 'the row names the bytes that ran');
  assert.equal(moved.outcome, 'unsolved');
  assert.match(moved.check.tail, /FAIL: out\.txt holds 42/, 'the mutated check is what scored');
});

/* 13 — a dead bridge is invalid, never unsolved (the 429 storm) ------------ */

test('a run whose bridge dies is invalid — the model is never charged for the network', async () => {
  const task = makeTask({ 'out.txt': 'x\n', 'check.mjs': OUT_CHECK }, { id: 'storm', budget: { maxSteps: 3 } });
  const dead = replayBridge([]);
  dead.chat = async () => { throw new Error('429 — the account edge refused the burst'); };

  const row = track(await runAttempt(task, { mode: 'replay', bridge: dead }));
  assert.equal(row.outcome, 'invalid', 'a transport death is not a wrong answer');
  assert.equal(row.scored, false, 'invalid rows stay out of the scored rates');
  assert.match(row.invalidReason, /429/, `invalidReason: ${row.invalidReason}`);
  assert.notEqual(row.check.exit, 0, 'the check still ran on the applied tree');
});

/* 14 — the summary's slices stay quiet when there is nothing to say --------- */

test('the category and pair-drift slices only appear when they have something to say', () => {
  const noCategory = formatSummary([
    { taskId: 'plain', outcome: 'solved', scored: true, category: null, pair: null, wallMs: 1 },
  ]);
  assert.doesNotMatch(noCategory, /by category:/, 'no category on any row, no category line');

  const symmetric = formatSummary([
    { taskId: 'sum-numbers', outcome: 'solved', scored: true, category: 'robustness', pair: 'sum-numbers', wallMs: 1 },
    { taskId: 'sum-numbers-twin', outcome: 'solved', scored: true, category: 'robustness', pair: 'sum-numbers', wallMs: 1 },
  ]);
  assert.doesNotMatch(symmetric, /pair drift:/, 'twins that agree are not a drift');
  assert.match(symmetric, /by category: robustness 2\/2/);

  const bothLost = formatSummary([
    { taskId: 'count-lines', outcome: 'unsolved', scored: true, category: 'robustness', pair: 'count-lines', wallMs: 1 },
    { taskId: 'count-lines-twin', outcome: 'unsolved', scored: true, category: 'robustness', pair: 'count-lines', wallMs: 1 },
  ]);
  assert.doesNotMatch(bothLost, /pair drift:/, 'a pair that failed together is not a drift');
});
