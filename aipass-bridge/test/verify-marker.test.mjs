// The VERIFY marker: the model may ask for a check.
//
// The DONE checker has always been the harness's own move — a read-only child
// the loop invokes before it accepts a DONE — and the model could not ask for
// one (docs/WORKLOG.md: "no VERIFY marker"). The marker closes that: the
// model writes VERIFY, the run runs the project's check (or asks the checker
// for a verdict) and the result comes back as an ordinary tool result.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BridgeClient } from '../harness/bridge.mjs';
import { Emitter } from '../harness/events.mjs';
import { Harness } from '../harness/harness.mjs';
import { SessionStore } from '../harness/session.mjs';
import { parse, attemptedMarker, MARKER_LINE } from '../harness/protocol.mjs';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aipass-verify-home-'));
process.env.AIPASS_HOME = HOME;

const dirs = [];
const tempDir = (files = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aipass-verify-'));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    const p = path.join(dir, name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  return dir;
};
after(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(HOME, { recursive: true, force: true });
});

class StubBridge extends BridgeClient {
  constructor(queues) {
    super('http://127.0.0.1:1');
    this.model = 'stub';
    this.queues = queues;
    this.turns = new Map();
    this.prompts = [];
    this.created = 0;
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
  async createConversation() { this.created += 1; return { id: `conv-${this.created}` }; }
  async config() {}
  async status() { return { conversation: 'conv-1' }; }
}

const parentPrompts = (bridge) => bridge.prompts.filter((p) => p.conversation === 'conv-1' || p.conversation === null);

test('the model can ask for a check', async () => {
  const root = tempDir({ 'check.mjs': "console.log('PASS');\n" });
  const bridge = new StubBridge({
    'conv-1': ['VERIFY\n', 'DONE checked\n'],
  });
  const h = new Harness({
    root, client: bridge, store: new SessionStore(tempDir()), events: new Emitter(),
    options: { mode: 'yolo', allowRun: true, verifyCommand: 'node check.mjs', maxSteps: 4 },
  });

  const result = await h.run('check the project');

  assert.equal(result.stopReason, 'done');
  const second = parentPrompts(bridge)[1]?.message ?? '';
  assert.match(second, /the check passed/, 'the result of the check came back to the model');
  assert.match(second, /PASS/, 'with the output of the command');
});

test('a VERIFY without a declared check says so', async () => {
  // No declared check, and no checker: a run that may not use a helper has
  // no checker either (the DONE gate's rule). There is nothing to verify
  // with, and the answer says so instead of inventing a pass.
  const root = tempDir({ 'a.txt': 'x\n' });
  const bridge = new StubBridge({
    'conv-1': ['VERIFY\n', 'DONE nothing to check\n'],
  });
  const h = new Harness({
    root, client: bridge, store: new SessionStore(tempDir()), events: new Emitter(),
    options: { mode: 'yolo', allowRun: true, maxSteps: 4 },
  });

  await h.run('check the project');

  const second = parentPrompts(bridge)[1]?.message ?? '';
  assert.match(second, /err: /, 'the answer is a refusal, in the one failure shape');
  assert.match(second, /no check/i, 'and it says why');
});

test('the marker is one line, and the argument is the command', () => {
  const calls = parse('VERIFY\n');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].kind, 'verify');
  assert.equal(calls[0].arg, '');

  const named = parse('VERIFY node test.mjs\n');
  assert.equal(named[0].kind, 'verify');
  assert.equal(named[0].arg, 'node test.mjs');

  // The grammar is single-sourced: the line is stripped from the prose, and
  // a misspelt marker is still an attempt.
  assert.ok(MARKER_LINE.test('VERIFY node test.mjs'), 'the marker line is a marker');
  assert.ok(attemptedMarker('VERIFY'), 'a VERIFY the parser cannot read is still an attempt');
});
