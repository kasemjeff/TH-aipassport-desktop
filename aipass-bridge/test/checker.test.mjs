// The checker (SPEC_CHECKER.md): one read-only child over the staged tree,
// asked for a verdict before a DONE is accepted. A stub bridge with a reply
// queue per conversation keeps the parent's exchanges and the checker's
// apart — the parent's sends carry no conversation id (they use the bridge
// pointer), the checker's carry its own conversation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { BridgeClient } from '../harness/bridge.mjs';
import { Emitter } from '../harness/events.mjs';
import { Harness } from '../harness/harness.mjs';
import { SessionStore } from '../harness/session.mjs';
import { tempDir } from './harness.mjs';

const BROKEN = 'export const add = (a, b) => a - b;\n';
const CHECK = "import { add } from './math.mjs';\n"
  + "if (add(2, 3) !== 5) { console.error('FAIL: add(2,3) =', add(2, 3)); process.exit(1); }\n"
  + "console.log('PASS');\n";
const RUN_CHECK = 'RUN\nnode check.mjs\nEND\nDONE ran the check\n';

class StubBridge extends BridgeClient {
  constructor(queues, { failCreateAfter = Infinity } = {}) {
    super('http://127.0.0.1:1');
    this.model = 'stub';
    this.queues = queues;      // 'parent' | 'conv-<n>' → scripted replies, in order
    this.turns = new Map();
    this.prompts = [];         // every chat, for "what did the model hear"
    this.created = 0;          // conversations handed out (attempts included)
    this.failCreateAfter = failCreateAfter;
  }
  async chat({ message, conversation } = {}) {
    const key = conversation ?? 'parent';
    this.prompts.push({ conversation: conversation ?? null, message });
    const list = this.queues[key];
    if (!list) throw new Error(`no scripted replies for conversation ${key}`);
    const i = Math.min(this.turns.get(key) ?? 0, list.length - 1);
    this.turns.set(key, i + 1);
    return { text: list[i], reasoning: '' };
  }
  async quota() { return { available: 10 }; }
  async createConversation() {
    this.created += 1;
    return this.created > this.failCreateAfter ? null : { id: `conv-${this.created}` };
  }
  async config() {}
  async status() { return { conversation: 'conv-1' }; }
}

function makeHarness({ root, bridge, options = {} }) {
  const store = new SessionStore(tempDir());
  const events = new Emitter();
  const h = new Harness({
    root, bridge, store, events,
    options: { mode: 'yolo', allowRun: true, subagent: true, maxSteps: 6, ...options },
  });
  return { h, events, store };
}

const statsOf = (h) => h.session.entries.find((e) => e.type === 'run_stats');
const parentPrompts = (bridge) => bridge.prompts.filter((p) => p.conversation === null);

test('a stage-and-DONE reply is checked, and a failing check reaches the model', async () => {
  const root = tempDir({ 'math.mjs': BROKEN, 'check.mjs': CHECK });
  const bridge = new StubBridge({
    parent: [
      // Read-first: CREATE over an existing file needs the file read this
      // run; the fix itself is still the stage-and-DONE reply R4 never sees.
      'NEED file math.mjs\n',
      'CREATE math.mjs\nexport const add = (a, b) => a - b + 1;\nEND\nDONE staged a fix\n',
      'DONE fixed by hand\n',
    ],
    'conv-2': [RUN_CHECK],
  });
  const { h } = makeHarness({ root, bridge });

  const result = await h.run('fix add()');

  assert.equal(result.stopReason, 'done');
  assert.equal(bridge.created, 2, 'one checker conversation (parent + checker)');
  assert.ok(parentPrompts(bridge).some((p) => /check of the staged tree ran and did not pass/.test(p.message)),
    'the failure text reached the parent model');
  assert.ok(parentPrompts(bridge).some((p) => p.message.includes('FAIL')),
    "the failing run's output is the evidence in the report");
  assert.equal(statsOf(h).checks, 1);
  assert.equal(statsOf(h).checkVerdict, 'fail');
});

test('a passing check costs the model nothing', async () => {
  const root = tempDir({ 'math.mjs': BROKEN, 'check.mjs': CHECK });
  const bridge = new StubBridge({
    parent: [
      'NEED file math.mjs\n',
      'CREATE math.mjs\nexport const add = (a, b) => a + b;\nEND\nDONE fixed add\n',
    ],
    'conv-2': [RUN_CHECK],
  });
  const { h, events } = makeHarness({ root, bridge });
  const ends = [];
  const finishes = [];
  events.on('check_end', (p) => ends.push(p));
  events.on('finished', (p) => finishes.push(p));

  const result = await h.run('fix add()');

  assert.equal(result.stopReason, 'done');
  assert.equal(parentPrompts(bridge).length, 2, 'a read, then the fix — nothing after DONE');
  assert.ok(!parentPrompts(bridge).some((p) => /did not pass/.test(p.message)), 'a pass costs no extra message');
  assert.equal(ends.length, 1);
  assert.equal(ends[0].verdict, 'pass');
  const own = finishes.find((p) => p.check); // the child's finished carries no check
  assert.equal(own?.check?.verdict, 'pass');
  assert.equal(statsOf(h).checkVerdict, 'pass');
});

test('the checker sees the projection, the disk does not move', async () => {
  const root = tempDir({ 'math.mjs': BROKEN, 'check.mjs': CHECK });
  const bridge = new StubBridge({
    parent: [
      'NEED file math.mjs\n',
      'CREATE math.mjs\nexport const add = (a, b) => a + b;\nEND\nDONE fixed add\n',
    ],
    'conv-2': [RUN_CHECK],
  });
  const { h } = makeHarness({ root, bridge });

  await h.run('fix add()');

  // PASS could only come from the staged version: the disk copy fails the check.
  assert.equal(statsOf(h).checkVerdict, 'pass', 'the checker ran against the staged tree');
  assert.equal(fs.readFileSync(path.join(root, 'math.mjs'), 'utf8'), BROKEN, 'the disk still holds the broken file');
  assert.equal(h.overlay.size, 1, 'the parent still holds the staged fix — nothing was applied');
  const runDir = path.join(root, '.aipass', 'run');
  assert.ok(!fs.existsSync(runDir) || fs.readdirSync(runDir).length === 0, 'the sandbox was cleaned up');
});

test('a staged delete is gone in the projection', async () => {
  const root = tempDir({
    'secret.txt': 'shh\n',
    'check.mjs': "import fs from 'node:fs';\n"
      + "if (fs.existsSync('secret.txt')) { console.error('secret.txt is still here'); process.exit(1); }\n"
      + "console.log('PASS');\n",
  });
  const bridge = new StubBridge({
    // A code file rides along: the checker's gate is R4's — a docs-only
    // delete would skip both — so `app.mjs` is what makes this a claim.
    parent: ['DELETE secret.txt\nCREATE app.mjs\nexport const ok = true;\nEND\nDONE dropped the secret\n'],
    'conv-2': ['RUN\nnode check.mjs\nEND\nDONE checked\n'],
  });
  const { h } = makeHarness({ root, bridge });

  const result = await h.run('drop the secret');

  assert.equal(result.stopReason, 'done');
  assert.equal(statsOf(h).checkVerdict, 'pass', 'the projection left the deleted file out');
  assert.ok(fs.existsSync(path.join(root, 'secret.txt')), 'the disk still has it — nothing was applied');
});

test('writes are refused in the checker, and nothing is merged back', async () => {
  const root = tempDir({ 'check.mjs': "console.log('PASS');\n" });
  const bridge = new StubBridge({
    parent: ['CREATE extra.mjs\nexport const x = 1;\nEND\nDONE staged extra\n'],
    'conv-2': ['CREATE helper.mjs\nexport const y = 2;\nEND\nDONE could not write\n'],
  });
  const { h, store } = makeHarness({ root, bridge });

  await h.run('stage the extra module');

  const child = store.list().map((m) => store.load(m.id)).find((s) => (s.title ?? '').startsWith('check:'));
  assert.ok(child, 'the checker has its own session file');
  const refused = child.entries.find((e) => e.type === 'tool' && e.kind === 'write');
  assert.ok(refused, 'the checker attempted a write');
  assert.equal(refused.ok, false);
  assert.match(refused.out, /^err: the checker is read-only/);
  const pending = h.pendingChanges();
  assert.deepEqual(pending.map((p) => p.file), ['extra.mjs'], 'only the parent edit is pending');
});

test('a second DONE over the same tree does not check again', async () => {
  const root = tempDir({ 'math.mjs': BROKEN, 'check.mjs': CHECK });
  const bridge = new StubBridge({
    parent: [
      'NEED file math.mjs\n',
      'CREATE math.mjs\nexport const add = (a, b) => a - b + 1;\nEND\nDONE staged a fix\n',
      'DONE fixed by hand\n',
    ],
    'conv-2': [RUN_CHECK],
  });
  const { h, events } = makeHarness({ root, bridge });
  const starts = [];
  events.on('check_start', (p) => starts.push(p));

  const result = await h.run('fix add()');

  assert.equal(result.stopReason, 'done');
  assert.equal(starts.length, 1, 'the tree did not move, so the first verdict stands');
  assert.deepEqual(starts[0].files, [{ path: 'math.mjs', deleted: false }]);
  assert.equal(bridge.created, 2, 'no second checker conversation');
  assert.equal(statsOf(h).checks, 1);
});

test('no RUN enabled, no check — the DONE is accepted as before', async () => {
  const root = tempDir({ 'math.mjs': BROKEN, 'check.mjs': CHECK });
  const bridge = new StubBridge({
    parent: [
      'NEED file math.mjs\n',
      'CREATE math.mjs\nexport const add = (a, b) => a + b;\nEND\nDONE staged the fix\n',
    ],
  });
  const { h, events } = makeHarness({ root, bridge, options: { allowRun: false } });
  const starts = [];
  events.on('check_start', (p) => starts.push(p));

  const result = await h.run('fix add()');

  assert.equal(result.stopReason, 'done');
  assert.equal(starts.length, 0, 'a check is an execution; without RUN there is none');
  assert.equal(bridge.created, 1, 'no checker conversation');
  assert.equal(statsOf(h).checks, 0);
  assert.equal(statsOf(h).checkVerdict, null);
});

test('a checker conversation that will not open is skipped, never the parent one', async () => {
  const root = tempDir({ 'math.mjs': BROKEN, 'check.mjs': CHECK });
  const bridge = new StubBridge({
    parent: [
      'NEED file math.mjs\n',
      'CREATE math.mjs\nexport const add = (a, b) => a + b;\nEND\nDONE staged the fix\n',
    ],
  }, { failCreateAfter: 1 });
  const { h, events } = makeHarness({ root, bridge });
  const ends = [];
  events.on('check_end', (p) => ends.push(p));

  const result = await h.run('fix add()');

  assert.equal(result.stopReason, 'done', 'the DONE is accepted');
  assert.equal(bridge.created, 2, 'the check was attempted once');
  assert.equal(ends.length, 1);
  assert.equal(ends[0].skipped, true);
  assert.equal(parentPrompts(bridge).length, 2, 'a read and the fix — nothing extra reached the parent conversation');
  assert.ok(h.session.entries.some((e) => e.type === 'note' && /check skipped/.test(e.text)), 'the skip says why');
  assert.equal(statsOf(h).checks, 0);
  assert.equal(statsOf(h).checkVerdict, 'none');
});

test('a run that checked itself still earns the child check', async () => {
  // A self-run is exactly the weak evidence the checker exists for: the run
  // "verified" itself with a run in the same reply and the old gate let it
  // through unchecked. The check now runs regardless of what the run claims,
  // and the verdict is the child's own.
  const root = tempDir({ 'math.mjs': BROKEN, 'check.mjs': CHECK });
  const bridge = new StubBridge({
    parent: [
      // Read-first: CREATE over an existing file needs the file read this run.
      'NEED file math.mjs\n',
      'CREATE math.mjs\nexport const add = (a, b) => a + b;\nEND\n'
      + 'RUN\nnode check.mjs\nEND\nDONE ran the check myself\n',
    ],
    'conv-2': [RUN_CHECK],
  });
  const { h, events } = makeHarness({ root, bridge });
  const starts = [];
  events.on('check_start', (p) => starts.push(p));

  const result = await h.run('fix add()');

  assert.equal(result.stopReason, 'done');
  assert.equal(starts.length, 1, 'the self-run did not stand the check down');
  assert.equal(statsOf(h).checks, 1);
  assert.equal(statsOf(h).checkVerdict, 'pass');
  assert.equal(bridge.created, 2, 'one checker conversation (parent + checker)');
});

test('a fix after a failed check earns one re-check, and a pass ends it', async () => {
  const root = tempDir({ 'math.mjs': BROKEN, 'check.mjs': CHECK });
  const bridge = new StubBridge({
    parent: [
      // Read-first, then the fix: the re-check below rides on the tree moving.
      'NEED file math.mjs\n',
      'CREATE math.mjs\nexport const add = (a, b) => a - b + 1;\nEND\nDONE staged a fix\n',
      'CREATE math.mjs\nexport const add = (a, b) => a + b;\nEND\nDONE fixed it properly\n',
    ],
    'conv-2': [RUN_CHECK],
    'conv-3': [RUN_CHECK],
  });
  const { h, events } = makeHarness({ root, bridge });
  const ends = [];
  events.on('check_end', (p) => ends.push(p));

  const result = await h.run('fix add()');

  assert.equal(result.stopReason, 'done');
  assert.deepEqual(ends.map((e) => e.verdict), ['fail', 'pass'], 'the fix moved the tree, so it was judged again');
  assert.equal(statsOf(h).checks, 2);
  assert.equal(result.check?.verdict, 'pass');
  assert.equal(bridge.created, 3, 'one checker conversation per verdict');
});

test('the check cap holds: two verdicts, then the DONE is taken as it stands', async () => {
  // A fix that keeps failing cannot farm infinite checks — CHECK_ROUNDS_MAX
  // bounds the loop, and the last verdict stays on the finished event so the
  // apply panel can say the change never passed.
  const root = tempDir({ 'math.mjs': BROKEN, 'check.mjs': CHECK });
  const bridge = new StubBridge({
    parent: [
      'NEED file math.mjs\n',
      'CREATE math.mjs\nexport const add = (a, b) => a - b + 1;\nEND\nDONE attempt one\n',
      'CREATE math.mjs\nexport const add = (a, b) => a - b - 1;\nEND\nDONE attempt two\n',
      'DONE leaving it at that\n',
    ],
    'conv-2': [RUN_CHECK],
    'conv-3': [RUN_CHECK],
  });
  const { h, events } = makeHarness({ root, bridge });
  const starts = [];
  events.on('check_start', (p) => starts.push(p));

  const result = await h.run('fix add()');

  assert.equal(result.stopReason, 'done');
  assert.equal(starts.length, 2, 'the cap stopped a third check');
  assert.equal(statsOf(h).checks, 2);
  assert.equal(result.check?.verdict, 'fail', 'the last verdict rides the finished event');
  assert.equal(bridge.created, 3);
});

test('the checker and its verdict name the staged test files', async () => {
  // A check that also edited the tests is weaker evidence than one that did
  // not; both the prompt and the verdict text now say which files those were.
  const root = tempDir({
    'math.mjs': BROKEN,
    'check.mjs': CHECK,
    'math.test.mjs': "import { add } from './math.mjs';\nif (add(2, 3) !== 5) process.exit(1);\n",
  });
  const bridge = new StubBridge({
    parent: [
      'NEED file math.mjs\nNEED file math.test.mjs\n',
      'CREATE math.mjs\nexport const add = (a, b) => a + b;\nEND\n'
      + 'CREATE math.test.mjs\nimport { add } from \'./math.mjs\';\nif (add(2, 3) !== 5) process.exit(1);\nEND\n'
      + 'DONE fixed add and its test\n',
    ],
    'conv-2': [RUN_CHECK],
  });
  const { h } = makeHarness({ root, bridge });

  const result = await h.run('fix add()');

  assert.equal(result.stopReason, 'done');
  const checkerPrompt = bridge.prompts.find((p) => p.conversation === 'conv-2');
  assert.ok(checkerPrompt, 'the checker was asked');
  assert.match(checkerPrompt.message, /math\.test\.mjs/, 'the prompt names the staged test file');
  assert.match(checkerPrompt.message, /test files/, 'and says why it matters');
  assert.equal(result.check?.verdict, 'pass');
  assert.equal(result.check?.testsTouched, 1, 'the verdict counts it');
  assert.match(result.check?.text ?? '', /modified test files/, 'and the text keeps the note');
});

test('a declared check is run verbatim, read from disk', async () => {
  const root = tempDir({
    'math.mjs': BROKEN,
    'check.mjs': CHECK,
    // First non-comment line wins; it is read from DISK, so a value staged
    // in the run could not bend the command that judges it even if it tried.
    '.aipass/check.txt': '# the project check\nnode check.mjs\n',
  });
  const bridge = new StubBridge({
    parent: [
      'NEED file math.mjs\n',
      'CREATE math.mjs\nexport const add = (a, b) => a + b;\nEND\nDONE fixed add\n',
    ],
    'conv-2': [RUN_CHECK],
  });
  const { h } = makeHarness({ root, bridge });

  const result = await h.run('fix add()');

  assert.equal(result.stopReason, 'done');
  const checkerPrompt = bridge.prompts.find((p) => p.conversation === 'conv-2');
  assert.ok(checkerPrompt, 'the checker was asked');
  assert.match(checkerPrompt.message, /declares its own check command/);
  assert.match(checkerPrompt.message, /node check\.mjs/, 'the declared command is named verbatim');
  assert.equal(result.check?.verdict, 'pass');
  assert.equal(result.check?.declared, 'node check.mjs');
});
