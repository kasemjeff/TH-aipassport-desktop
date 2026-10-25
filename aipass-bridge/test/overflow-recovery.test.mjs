/**
 * The overflow recovery: the one send-failure a rotation heals.
 *
 * A provider refusal that names the context window used to end the run as an
 * error — yet the server holds the whole conversation, so summarising and
 * rotating to a fresh one fits the same message again (pi-mono's one-shot
 * compact-and-retry, adopted). What this file pins:
 *   - the classifier: the shapes that are overflow, and the near misses that
 *     are not (a bare 400, a rate refusal, a streamed or aborted failure);
 *   - a mid-run send refused for context size → one summarise + rotate, the
 *     same step resent on the fresh conversation, the run finishes done, and
 *     the refused send is recorded exactly once (the server never saw it);
 *   - the second overflow is not retried: one attempt per run, and the error
 *     the sender deferred still gets its record.
 *
 * Run: node --test aipass-bridge/test/overflow-recovery.test.mjs
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Overlay } from '../harness/overlay.mjs';
import { SessionStore } from '../harness/session.mjs';
import { Compactor } from '../harness/compact.mjs';
import { isContextOverflow } from '../harness/bridge.mjs';
import { runTask } from '../harness/loop.mjs';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aipass-overflow-home-'));
process.env.AIPASS_HOME = HOME;
after(() => fs.rmSync(HOME, { recursive: true, force: true }));

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aipass-overflow-'));

/** A session a stubbed run can append to. */
const setup = () => {
  const dir = tempDir();
  const store = new SessionStore(path.join(dir, 'sessions'));
  const session = store.create({ root: dir, model: 'test-model' });
  return { dir, session };
};

const OVERFLOW_ERR = 'aipass returned 400: prompt is too long: 250000 tokens > 200000 maximum';

test('the classifier names the overflow shapes and only them', () => {
  assert.equal(isContextOverflow(new Error(OVERFLOW_ERR)), true);
  assert.equal(isContextOverflow(new Error("This model's maximum context length is 131072 tokens")), true);
  assert.equal(isContextOverflow(new Error('context_length_exceeded: the conversation exceeds the context window')), true);
  assert.equal(isContextOverflow(new Error('too many tokens in the request')), true);
  assert.equal(isContextOverflow(new Error('please reduce the length of the messages')), true);
  // Near misses a rotation cannot heal: a bare status, a pace refusal, a
  // network shape — none of them names the window.
  assert.equal(isContextOverflow(new Error('aipass returned 400')), false);
  assert.equal(isContextOverflow(new Error('aipass returned 429: pace')), false);
  assert.equal(isContextOverflow(new Error('fetch failed')), false);
  // A failure that already streamed words is never retried by a rotation:
  // the server holds what it delivered, and a resend would duplicate it.
  const streamed = new Error('prompt is too long');
  streamed.streamed = true;
  assert.equal(isContextOverflow(streamed), false);
  const abort = new Error('aborted');
  abort.name = 'AbortError';
  assert.equal(isContextOverflow(abort), false);
});

test('a mid-run send refused for context size rotates once and finishes', async () => {
  const { dir, session } = setup();
  const calls = [];
  let sendCount = 0;
  const rotations = [];
  const bridge = {
    model: 'test-model',
    waf: false,
    async chat({ message, conversation }) {
      calls.push({ message, conversation: conversation ?? null });
      // The summariser rides the same bridge, in the conversation being
      // summarised — it is not one of the run's sends.
      if (/Summarise the work carried out so far/.test(message)) {
        return { text: 'The run read a.txt and needs to continue from there.' };
      }
      sendCount += 1;
      if (sendCount === 1) return { text: 'NEED file a.txt' };
      if (sendCount === 2) throw new Error(OVERFLOW_ERR);
      return { text: 'DONE the file was read.' };
    },
    async quota() { return { available: 100 }; },
  };
  const rotate = async (note) => {
    rotations.push(note);
    return { conversation: 'fresh-1', temporary: true };
  };
  const compactor = new Compactor({ bridge, contextTokens: 100_000, keepRecentBytes: 0 });

  const result = await runTask('read a file', {
    bridge,
    // `NEED file` parses to the kind `read` — the stub is named for the kind
    // the loop calls, not the marker the model writes.
    tools: { list: () => '', read: () => 'the file content' },
    overlay: new Overlay(dir), session, compactor, rotate,
    options: { maxSteps: 5 },
    first: true,
  });

  assert.equal(result.stopReason, 'done', 'the overflow became a rotation, not an error');
  assert.equal(result.summary, 'the file was read.');
  assert.deepEqual(rotations, ['The run read a.txt and needs to continue from there.'], 'exactly one rotation');
  const compaction = session.entries.find((e) => e.type === 'compaction');
  assert.ok(compaction, 'the rotation is recorded');
  assert.equal(session.entries.filter((e) => e.type === 'user').length, 2,
    'the first send and the seed — the refused paste is not in the log, the server never saw it');
  // The retry went to the fresh conversation, carrying the seed with the
  // step's tool results — the only place they were ever going to be seen.
  const resent = calls.at(-1);
  assert.equal(resent.conversation, 'fresh-1');
  assert.match(resent.message, /Earlier work, already done/);
  assert.match(resent.message, /the file content/, "the step's tool results ride the seed");
});

test('a second overflow is not retried — one attempt per run, and the error still gets its record', async () => {
  const { dir, session } = setup();
  const calls = [];
  let sendCount = 0;
  let rotations = 0;
  const errors = [];
  const emitter = {
    emit(type, payload) { if (type === 'error') errors.push(payload); },
    on() { return () => {}; },
    isObserved() { return false; },
  };
  const bridge = {
    model: 'test-model',
    waf: false,
    async chat({ message }) {
      calls.push(message);
      if (/Summarise the work carried out so far/.test(message)) {
        return { text: 'A summary.' };
      }
      sendCount += 1;
      if (sendCount === 1) return { text: 'NEED file a.txt' };
      throw new Error(OVERFLOW_ERR);
    },
    async quota() { return { available: 100 }; },
  };
  const rotate = async () => { rotations += 1; return { conversation: 'fresh-1', temporary: true }; };
  const compactor = new Compactor({ bridge, contextTokens: 100_000, keepRecentBytes: 0 });

  const result = await runTask('read a file', {
    bridge,
    tools: { list: () => '', read: () => 'content' },
    overlay: new Overlay(dir), session, compactor, rotate, events: emitter,
    options: { maxSteps: 5 },
    first: true,
  });

  assert.equal(result.stopReason, 'error', 'the retry overflowing too ends the run as the error it is');
  assert.equal(rotations, 1, 'one attempt, not a loop');
  assert.equal(sendCount, 3, 'first send, refused send, retried send');
  assert.equal(errors.length, 1, 'the deferred error is emitted once, when nothing could recover it');
  assert.ok(session.entries.some((e) => e.type === 'note' && /the send failed/.test(e.text ?? '')),
    'and recorded as a note — the session keeps why the run died');
});
