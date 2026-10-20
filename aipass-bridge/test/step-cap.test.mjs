// The step cap is opt-in: 0 (the shipped default) means no cap — a run goes
// until DONE, a guard stops it, or a budget is spent. The child loops (helper,
// checker) keep their own hard caps; an uncapped parent must not unbound them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempDir } from './harness.mjs';
import { Overlay } from '../harness/overlay.mjs';
import { SessionStore } from '../harness/session.mjs';
import { createTools } from '../harness/tools.mjs';
import { Emitter } from '../harness/events.mjs';
import { BridgeClient } from '../harness/bridge.mjs';
import { Harness } from '../harness/harness.mjs';
import { normalizeOptions, runTask } from '../harness/loop.mjs';
import { DEFAULT_MAX_TOOL_CALLS, DEFAULT_MAX_WALL_CLOCK_MS } from '../harness/settings.mjs';

/** A bridge that answers from a list and records what was sent. */
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

test('normalizeOptions clamps the option sheet before the loop sees it', () => {
  const defaults = normalizeOptions();
  assert.equal(defaults.maxSteps, Infinity, '0 means no cap');
  assert.equal(defaults.maxStepsWire, 0, 'Infinity never rides the wire');
  assert.equal(defaults.maxToolCalls, DEFAULT_MAX_TOOL_CALLS);
  assert.equal(defaults.maxWallClockMs, DEFAULT_MAX_WALL_CLOCK_MS);
  assert.equal(defaults.maxCredits, 0, 'the credit cap is off by default');
  assert.equal(defaults.thinking, null, 'no thinking level unless asked');
  assert.equal(defaults.temperature, null, 'the site decides by default');
  assert.equal(defaults.replyLanguage, 'th');
  assert.equal(defaults.langCheck, false);
  assert.equal(defaults.minThaiRatio, 0.4);
  assert.equal(defaults.repeatGuard, false);
  assert.equal(defaults.repeatGuardMax, 4);

  const custom = normalizeOptions({
    maxSteps: '3.9', maxToolCalls: '5.9', maxWallClockMs: '1500.9', maxCredits: '2.5',
    thinking: 'HIGH', temperature: 5, slim: 1, seedText: 'seed', pluginTools: ['x'],
    replyLanguage: 'en', langCheck: 1, minThaiRatio: '2', repeatGuard: 1, repeatGuardMax: '2.9',
  });
  assert.equal(custom.maxSteps, 3);
  assert.equal(custom.maxStepsWire, 3);
  assert.equal(custom.maxToolCalls, 5);
  assert.equal(custom.maxWallClockMs, 1500);
  assert.equal(custom.maxCredits, 2.5);
  assert.equal(custom.thinking, 'high');
  assert.equal(custom.temperature, 2);
  assert.equal(custom.useSlim, true);
  assert.equal(custom.seedText, 'seed');
  assert.deepEqual(custom.pluginTools, ['x']);
  assert.equal(custom.replyLanguage, 'en');
  assert.equal(custom.langCheck, true);
  assert.equal(custom.minThaiRatio, 1);
  assert.equal(custom.repeatGuard, true);
  assert.equal(custom.repeatGuardMax, 2);
});

test('a run with no step cap is not stopped by ten steps', async () => {
  // Eleven steps of real work, then a DONE. The shipped default used to end
  // this at step ten with "reached the step limit".
  const files = {};
  for (let i = 1; i <= 11; i++) files[`f${i}.txt`] = `content ${i}\n`;
  const dir = tempDir(files);
  const overlay = new Overlay(dir);
  const tools = createTools({ root: dir, overlay });
  const events = new Emitter();
  const seen = [];
  events.on('step', (p) => seen.push(p));
  let limits = 0;
  events.on('step_limit', () => limits++);

  const replies = [];
  for (let i = 1; i <= 11; i++) replies.push(`NEED file f${i}.txt\n`);
  replies.push('DONE read all eleven\n');
  const result = await runTask('read every file', {
    bridge: scriptedLoop(replies),
    tools, overlay, events,
    options: { maxSteps: 0 }, first: true,
  });

  assert.equal(result.stopReason, 'done');
  assert.equal(result.steps, 11, 'all eleven calls ran');
  assert.equal(seen.length, 12, 'twelve replies: eleven work steps and the DONE');
  assert.equal(limits, 0, 'the step limit never fired');
  assert.ok(seen.every((s) => s.maxSteps === 0), `the wire says 0 = no cap:\n${JSON.stringify(seen.slice(0, 2))}`);
});

test('a set cap still ends the run, and says so on the last step', async () => {
  const dir = tempDir({ 'f1.txt': 'a\n', 'f2.txt': 'b\n', 'f3.txt': 'c\n' });
  const overlay = new Overlay(dir);
  const tools = createTools({ root: dir, overlay });
  const events = new Emitter();
  const seen = [];
  events.on('step', (p) => seen.push(p));
  let limits = 0;
  events.on('step_limit', () => limits++);

  const result = await runTask('read the files', {
    bridge: scriptedLoop(['NEED file f1.txt\n', 'NEED file f2.txt\n', 'NEED file f3.txt\n']),
    tools, overlay, events,
    options: { maxSteps: 3 }, first: true,
  });

  assert.equal(result.stopReason, 'steps');
  assert.equal(limits, 1, 'step_limit went out once');
  assert.deepEqual(seen.map((s) => s.maxSteps), [3, 3, 3], 'every step carries the cap');
});

test('an uncapped parent still bounds its helper at eight steps', async () => {
  // 0 must not leak downward: Math.min(0, 8) would have made every helper
  // uncapped too. The helper's own cap is 8 regardless of the parent's.
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
      'NEED file src/app.ts\n',
      'DONE checked\n',
      'DONE parent done\n',
    ]),
    store: new SessionStore(tempDir()),
    events,
    options: { mode: 'yolo', allowRun: false, subagent: true, maxSteps: 0 },
  });

  const steps = [];
  events.on('step', (p) => steps.push(p));

  const result = await h.run('delegate the check');
  assert.equal(result.stopReason, 'done');
  const helperSteps = steps.filter((s) => s.maxSteps === 8);
  assert.ok(helperSteps.length >= 1, `the helper ran under a cap of 8:\n${JSON.stringify(steps)}`);
  assert.ok(steps.some((s) => s.maxSteps === 0), 'while the parent stayed uncapped');
});
