/**
 * The mid-run inject: a message the person types while a run is working.
 *
 * It must not interrupt the run and must not start a second one — the
 * one-message protocol allows exactly one paste per step, so the message
 * waits in the harness's queue and rides the next step's paste, where the
 * model reads it as part of the task. What this file pins:
 *   - the loop drains the queue from the second step on (never into the
 *     preamble message), says it once, and the text lands in the session
 *     log like everything else the model sees;
 *   - with no run in flight the harness refuses, and the window keeps the
 *     text (the RPC layer just carries the answer);
 *   - a run that ends before a step could carry the queue hands the texts
 *     back as `inject_orphaned` instead of swallowing them;
 *   - the queue is capped at twenty messages, so a paste storm cannot
 *     outrun the compaction budget that guards every send.
 *
 * Run: node --test aipass-bridge/test/inject.test.mjs
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Overlay } from '../harness/overlay.mjs';
import { SessionStore } from '../harness/session.mjs';
import { Emitter } from '../harness/events.mjs';
import { runTask } from '../harness/loop.mjs';
import { Harness } from '../harness/harness.mjs';
import { BridgeClient } from '../harness/bridge.mjs';

// Nothing here may touch the real ~/.aipass.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aipass-inject-home-'));
process.env.AIPASS_HOME = HOME;
after(() => fs.rmSync(HOME, { recursive: true, force: true }));

const tempDir = (files = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aipass-inject-'));
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  return dir;
};

const MARKER = 'The person sent this while the run was in progress';

/* ------------------------------------------------------- the loop, directly */

test('a message typed mid-run rides the next paste, not the first message', async () => {
  const dir = tempDir({ 'a.txt': 'hello\n' });
  const store = new SessionStore(path.join(dir, 'sessions'));
  const session = store.create({ root: dir, model: 'test-model' });
  const events = new Emitter();
  const injected = [];
  const seenEvents = [];
  events.on('injected', (payload) => seenEvents.push(payload));
  const messages = [];
  const replies = ['NEED file a.txt', 'DONE done'];
  const bridge = {
    model: 'test-model',
    waf: false,
    async chat({ message }) {
      messages.push(message);
      return { text: replies[messages.length - 1] ?? 'DONE', reasoning: '' };
    },
    async quota() { return { available: 100 }; },
  };
  const tools = {
    list: () => 'a.txt',
    read: async () => {
      // The person types while the first read is in flight: it must not join
      // the preamble message (already composed) but the results paste after.
      injected.push('ระวังไฟล์ b.txt ด้วย');
      return 'contents of a.txt';
    },
  };

  const result = await runTask('read a.txt', {
    bridge, tools, overlay: new Overlay(dir), session, events,
    injected,
    options: { maxSteps: 5 },
    first: true,
  });

  assert.equal(result.stopReason, 'done');
  assert.equal(messages.length, 2, 'the run took one step and one paste');
  assert.doesNotMatch(messages[0], new RegExp(MARKER), 'the preamble message carries no injected note');
  assert.match(messages[1], new RegExp(MARKER), 'the results paste carries it');
  assert.match(messages[1], /ระวังไฟล์ b\.txt ด้วย/, 'with the text itself, verbatim');
  assert.match(messages[1], /Result of read a\.txt/, 'and the step results ride the same message');
  const userEntry = session.entries.find((e) => e.type === 'user' && e.text?.includes('ระวังไฟล์ b.txt ด้วย'));
  assert.ok(userEntry, 'the injected text is in the session log — model-visible means logged');
  assert.deepEqual(seenEvents, [{ n: 1 }], 'the delivery is said exactly once');
  assert.deepEqual(injected, [], 'the queue is empty after the drain');
});

/* ------------------------------------------------------------ the harness */

/** A bridge that answers with canned replies and fires a hook per send. */
class HookedBridge extends BridgeClient {
  constructor(replies, hooks = {}) {
    super('http://127.0.0.1:1');
    this.model = 'stub';
    this.replies = replies;
    this.hooks = hooks;
    this.turn = 0;
    this.sends = 0;
  }
  async chat(opts) {
    this.sends += 1;
    this.hooks[`send${this.sends}`]?.(opts);
    return { text: this.replies[Math.min(this.turn++, this.replies.length - 1)] ?? 'DONE', reasoning: '' };
  }
  async quota() { return { available: 100 }; }
  async createConversation() { return { id: 'stub-conversation' }; }
  async config() {}
  async status() { return { conversation: 'stub-conversation' }; }
}

const makeHarness = (bridge, events) => new Harness({
  root: tempDir({ 'a.txt': 'hello\n' }),
  client: bridge,
  store: new SessionStore(path.join(tempDir(), 'sessions')),
  options: { mode: 'yolo' },
  events,
});

test('inject with no run in flight is refused, and the window keeps the text', () => {
  const h = makeHarness(new HookedBridge(['DONE']), new Emitter());
  const res = h.inject('hello?');
  assert.equal(res.refused, 'no run in flight', 'the answer names why');
  assert.equal(res.running, false);
  assert.equal(res.queued, 0, 'nothing was queued');
});

test('a message queued mid-run is delivered by the next step, said once', async () => {
  const events = new Emitter();
  const captured = [];
  events.on('inject_queued', (p) => captured.push(['queued', p]));
  events.on('injected', (p) => captured.push(['injected', p]));
  events.on('inject_orphaned', (p) => captured.push(['orphaned', p]));
  let h = null;
  const bridge = new HookedBridge(['NEED file a.txt', 'DONE done'], {
    // The person types while the run is still inside its first send.
    send1: () => { h?.inject('ถามกลางรันได้ไหม'); },
  });
  h = makeHarness(bridge, events);

  const result = await h.run('read a.txt');
  assert.equal(result.stopReason, 'done');
  assert.deepEqual(captured.filter(([k]) => k === 'queued'), [['queued', { n: 1 }]], 'queued once');
  assert.deepEqual(captured.filter(([k]) => k === 'injected'), [['injected', { n: 1 }]], 'delivered once');
  assert.deepEqual(captured.filter(([k]) => k === 'orphaned'), [], 'nothing was orphaned');
  // The queue drained at the top of step 2, so the second message carries it.
  const userEntries = h.session.entries.filter((e) => e.type === 'user');
  assert.ok(userEntries.some((e) => e.text?.includes('ถามกลางรันได้ไหม')), 'the text reached the session log');
});

test('a run that ends before delivering the queue hands the texts back', async () => {
  const events = new Emitter();
  const orphaned = [];
  events.on('inject_orphaned', (p) => orphaned.push(p));
  let h = null;
  const bridge = new HookedBridge(['DONE finished'], {
    // The queue call lands while the run is inside its only send — too late
    // for any step to carry it, so the ending must give the text back.
    send1: () => { h?.inject('ยังไม่ได้ส่ง'); },
  });
  h = makeHarness(bridge, events);

  const result = await h.run('a task');
  assert.equal(result.stopReason, 'done');
  assert.deepEqual(orphaned, [{ texts: ['ยังไม่ได้ส่ง'] }], 'the orphan drain returned the text');
  assert.deepEqual(h.inject('after'), { queued: 0, running: false, refused: 'no run in flight' },
    'and the queue is empty once the run has ended');
});

test('the mid-run queue is capped at twenty messages', async () => {
  const events = new Emitter();
  let h = null;
  const answers = [];
  const bridge = new HookedBridge(['NEED file a.txt', 'DONE done'], {
    send1: () => {
      for (let i = 1; i <= 21; i++) answers.push(h?.inject(`ข้อความ ${i}`));
    },
  });
  h = makeHarness(bridge, events);

  const result = await h.run('read a.txt');
  assert.equal(result.stopReason, 'done');
  assert.equal(answers.filter((r) => r?.refused).length, 1, 'exactly the twenty-first is refused');
  assert.match(answers[20].refused, /queue full/, 'and the refusal says why');
  assert.equal(answers[20].queued, 20, 'the queue stayed at its cap');
});
