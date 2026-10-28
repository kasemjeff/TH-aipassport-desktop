/**
 * The interrupted anchor: what the person saw when a send died mid-answer.
 *
 * A stream that delivered words and then died — a stop, or a refusal after
 * the answer started — is a different failure from one that delivered
 * nothing: the message reached the server's context, and the person read the
 * prefix on screen. The transcript has to hold both (dsh records the same
 * shape as an `interrupted: true` assistant anchor), because the next send
 * continues a conversation whose local transcript must say what came before
 * it. What this file pins:
 *   - deltas streamed, then the send died → the user entry AND the delivered
 *     prefix land in the session log, the prefix marked interrupted;
 *   - nothing delivered → nothing recorded (the retry path may resend the
 *     same message; a duplicate user entry would be a lie about what the
 *     server ever received).
 *
 * Run: node --test aipass-bridge/test/interrupted-anchor.test.mjs
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Overlay } from '../harness/overlay.mjs';
import { SessionStore } from '../harness/session.mjs';
import { runTask } from '../harness/loop.mjs';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aipass-anchor-home-'));
process.env.AIPASS_HOME = HOME;
after(() => fs.rmSync(HOME, { recursive: true, force: true }));

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aipass-anchor-'));

/** A session plus the tools a stubbed run needs. */
const setup = () => {
  const dir = tempDir();
  const store = new SessionStore(path.join(dir, 'sessions'));
  const session = store.create({ root: dir, model: 'test-model' });
  return { dir, session };
};

test('a stream that died mid-answer records the message and the delivered prefix', async () => {
  const { dir, session } = setup();
  const bridge = {
    model: 'test-model',
    waf: false,
    async chat({ onText }) {
      // Words reached the screen, then the person pressed stop: the stream
      // died with the abort the stop signal produces.
      onText('The answer starts here but never finishes');
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    },
    async quota() { return { available: 100 }; },
  };

  const result = await runTask('a task', {
    bridge, tools: { list: () => '' }, overlay: new Overlay(dir), session,
    options: { maxSteps: 5 },
    first: true,
  });

  assert.equal(result.stopReason, 'cancelled', 'the stop is still an ending, not a failure');
  const user = session.entries.find((e) => e.type === 'user');
  assert.ok(user, 'the sent message is in the log — the server received it');
  assert.match(user.text, /Here is what I want to know: a task/, 'the composed first message, as sent');
  const assistant = session.entries.find((e) => e.type === 'assistant');
  assert.ok(assistant, 'the delivered prefix is in the log too');
  assert.equal(assistant.text, 'The answer starts here but never finishes');
  assert.equal(assistant.interrupted, true, 'and it is marked as an interrupted answer, not a whole one');
});

test('a send that delivered nothing records nothing', async () => {
  const { dir, session } = setup();
  let sends = 0;
  const bridge = {
    model: 'test-model',
    waf: false,
    async chat() {
      sends += 1;
      throw new Error('the edge refused everything');
    },
    async quota() { return { available: 100 }; },
  };

  const result = await runTask('a task', {
    bridge, tools: { list: () => '' }, overlay: new Overlay(dir), session,
    options: { maxSteps: 5 },
    first: true,
  });

  assert.equal(result.stopReason, 'error');
  assert.equal(sends, 1, 'no retry followed a non-recoverable refusal');
  assert.equal(session.entries.find((e) => e.type === 'user'), undefined,
    'no user entry: the server never received the message');
  assert.equal(session.entries.find((e) => e.type === 'assistant'), undefined,
    'and no assistant entry: nothing was ever on screen');
  assert.ok(session.entries.some((e) => e.type === 'note' && /send failed/.test(e.text ?? '')),
    'the failure itself is still recorded as a note');
});
