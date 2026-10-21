/**
 * The stop button, end to end.
 *
 * Pressing stop has to end the WORK, not just the conversation: the tools of
 * the reply that was running, the command that was in flight, and the run that
 * had only just started. Each of these used to carry on after the person had
 * said stop — the signal reached the next send and nothing else — so the
 * window looked broken and the work went on regardless.
 *
 * Run: node --test aipass-bridge/test/stop.test.mjs
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Overlay } from '../harness/overlay.mjs';
import { SessionStore } from '../harness/session.mjs';
import { createTools } from '../harness/tools.mjs';
import { createSandbox, materializeTree } from '../harness/sandbox.mjs';
import { runTask } from '../harness/loop.mjs';
import { Harness } from '../harness/harness.mjs';
import { BridgeClient } from '../harness/bridge.mjs';

// Nothing here may touch the real ~/.aipass.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aipass-stop-home-'));
process.env.AIPASS_HOME = HOME;
after(() => fs.rmSync(HOME, { recursive: true, force: true }));

const tempDir = (files = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aipass-stop-'));
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  return dir;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------- the loop, directly */

test('a stop ends the tools that were still queued in the reply', async () => {
  const dir = tempDir({ 'a.txt': 'hello\n' });
  const store = new SessionStore(path.join(dir, 'sessions'));
  const session = store.create({ root: dir, model: 'test-model' });
  const controller = new AbortController();
  const read = [];
  const tools = {
    list: () => 'a.txt',
    read: async (arg) => {
      read.push(arg);
      // The person presses stop while this read is in flight.
      if (read.length === 1) controller.abort();
      await sleep(20);
      return `contents of ${arg}`;
    },
  };
  const bridge = {
    model: 'test-model',
    async chat({ signal }) {
      if (signal?.aborted) { const err = new Error('aborted'); err.name = 'AbortError'; throw err; }
      return { text: 'NEED file a.txt\nNEED file b.txt', reasoning: '' };
    },
    async quota() { return { available: 100 }; },
  };

  const result = await runTask('read two files', {
    bridge, tools, overlay: new Overlay(dir), session,
    options: { maxSteps: 5, signal: controller.signal },
    first: true,
  });

  assert.deepEqual(read, ['a.txt'], 'the second read never happened');
  assert.equal(result.stopReason, 'cancelled', 'the run ended as cancelled');
  const stat = session.entries.find((e) => e.type === 'run_stats');
  assert.equal(stat.stopReason, 'cancelled', 'and the session records why the run ended');
});

test('a stop before the first reply sends nothing', async () => {
  const dir = tempDir();
  const store = new SessionStore(path.join(dir, 'sessions'));
  const session = store.create({ root: dir, model: 'test-model' });
  const controller = new AbortController();
  controller.abort();
  let sends = 0;
  const bridge = {
    model: 'test-model',
    async chat() { sends += 1; return { text: 'DONE never', reasoning: '' }; },
    async quota() { return { available: 100 }; },
  };

  const result = await runTask('a task', {
    bridge, tools: { list: () => '' }, overlay: new Overlay(dir), session,
    options: { maxSteps: 5, signal: controller.signal },
    first: true,
  });

  assert.equal(sends, 0, 'the model was never asked');
  assert.equal(result.stopReason, 'cancelled', 'the run ended as cancelled');
});

/* ------------------------------------------------------------ the harness */

/** A bridge that answers with canned replies and counts the sends. */
class StubBridge extends BridgeClient {
  constructor(replies) {
    super('http://127.0.0.1:1');
    this.model = 'stub';
    this.replies = replies;
    this.turn = 0;
    this.sends = 0;
  }
  async chat() {
    this.sends += 1;
    return { text: this.replies[Math.min(this.turn++, this.replies.length - 1)] ?? 'DONE', reasoning: '' };
  }
  async quota() { return { available: 100 }; }
  async createConversation() { return { id: 'stub-conversation' }; }
  async config() {}
  async status() { return { conversation: 'stub-conversation' }; }
}

test('a stop that lands right after the run started is not lost', async () => {
  const dir = tempDir();
  const bridge = new StubBridge(['DONE never reached']);
  const h = new Harness({
    root: dir,
    client: bridge,
    store: new SessionStore(path.join(dir, 'sessions')),
    options: { mode: 'yolo' },
  });

  const running = h.run('do something');
  h.cancel(); // the person pressed stop while the run was still starting
  const result = await running;

  assert.equal(bridge.sends, 0, 'the run never went out to the model');
  assert.equal(result.stopReason, 'cancelled', 'the run ended as cancelled, not as done');
});

/* --------------------------------------------------------------- the tools */

test('a RUN in flight is killed when the run is stopped', async () => {
  const dir = tempDir();
  const sleeper = path.join(dir, 'sleeper.mjs');
  fs.writeFileSync(sleeper, 'setTimeout(() => {}, 30000);\n');
  const controller = new AbortController();
  const tools = createTools({
    root: dir, overlay: new Overlay(dir), allowRun: true, signal: controller.signal,
  });

  const started = Date.now();
  const pending = tools.run('', `node "${sleeper}"`);
  setTimeout(() => controller.abort(), 250);
  const out = await pending;
  const took = Date.now() - started;

  assert.match(out, /err: the run was stopped/, 'the command was stopped, not failed');
  assert.ok(took < 10_000, `the command died with the stop (it took ${took} ms)`);
});

test('a stopped run stages no more edits', async () => {
  const dir = tempDir({ 'a.txt': 'hello\n' });
  const controller = new AbortController();
  const overlay = new Overlay(dir);
  const tools = createTools({
    root: dir, overlay, allowRun: false, signal: controller.signal,
  });

  const before = await tools.write('b.txt', 'first\n');
  assert.match(before, /^wrote b\.txt/, 'the write works while the run is live');
  assert.equal(overlay.has(path.join(dir, 'b.txt')), true, 'and the change is staged');

  controller.abort();
  const after = await tools.write('c.txt', 'second\n');
  assert.match(after, /err: the run was stopped/, 'a stopped run stages nothing more');
  assert.equal(overlay.has(path.join(dir, 'c.txt')), false, 'and the tree is untouched');
});

test('a stop ends the projection a RUN waits for', async () => {
  const dir = tempDir({ 'a.txt': 'hello\n' });
  const overlay = new Overlay(dir);
  overlay.set(path.join(dir, 'a.txt'), 'after\n');
  const controller = new AbortController();
  controller.abort();
  const sandbox = createSandbox(dir);
  try {
    // The copy is the longest wait a RUN has before its command starts, and it
    // used to run to the end while the window said the run was stopping.
    await assert.rejects(
      () => materializeTree(dir, overlay, sandbox, { signal: controller.signal }),
      (err) => err?.name === 'AbortError',
    );
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});
