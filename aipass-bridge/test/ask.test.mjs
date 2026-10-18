// The ASK stop: a run that hits a decision only the human owns pauses there —
// the question is the closing message, and the next user message in the same
// conversation is the answer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BridgeClient } from '../harness/bridge.mjs';
import { Emitter } from '../harness/events.mjs';
import { Harness } from '../harness/harness.mjs';
import { SessionStore } from '../harness/session.mjs';
import { tempDir } from './harness.mjs';

class StubBridge extends BridgeClient {
  constructor(queues) {
    super('http://127.0.0.1:1');
    this.model = 'stub';
    this.queues = queues;
    this.turns = new Map();
    this.prompts = [];   // every chat, for "what did the model hear"
    this.created = 0;
  }
  async chat({ message, conversation } = {}) {
    const key = conversation ?? 'parent';
    this.prompts.push({ conversation: conversation ?? null, message });
    const list = this.queues[key] ?? [];
    const i = Math.min(this.turns.get(key) ?? 0, list.length - 1);
    this.turns.set(key, (this.turns.get(key) ?? 0) + 1);
    return { text: list[i] ?? 'DONE nothing', reasoning: '' };
  }
  async quota() { return { available: 10 }; }
  async createConversation() { this.created += 1; return { id: `conv-${this.created}` }; }
  async config() {}
  async status() { return {}; }
}

const askHarness = (root, queues) => {
  const bridge = new StubBridge(queues);
  const events = new Emitter();
  const store = new SessionStore(tempDir());
  const h = new Harness({
    root, bridge, store, events,
    options: { mode: 'yolo', allowRun: false, maxSteps: 6 },
  });
  return { h, bridge, events };
};

test('ASK pauses the run: the question is the closing line, and no check runs', async () => {
  const root = tempDir({ 'notes.txt': 'hello\n' });
  const { h, events } = askHarness(root, {
    'conv-1': ['Both names fit the format.\nASK should the export keep the old column names?'],
  });
  const asks = [];
  const lines = [];
  events.on('ask', (p) => asks.push(p));
  events.on('done_line', (p) => lines.push(p));

  const result = await h.run('pick the export name');

  assert.equal(result.stopReason, 'ask');
  assert.equal(asks.length, 1, 'the ask event reached the window');
  assert.equal(asks[0].text, 'should the export keep the old column names?');
  assert.equal(lines.length, 1, 'the question is the run’s closing line');
  assert.equal(lines[0].text, 'should the export keep the old column names?');
  const stats = h.session.entries.find((e) => e.type === 'run_stats');
  assert.equal(stats.stopReason, 'ask', 'run_stats records the pause');
  assert.equal(stats.checks, 0, 'a paused run is not a claim — nothing was checked');
});

test('an ASK beside a NEED waits for the read — the question lands one step later', async () => {
  const root = tempDir({ 'notes.txt': 'hello\n' });
  const { h, bridge } = askHarness(root, {
    'conv-1': [
      'ASK which name do you want?\nNEED file notes.txt',
      'ASK which name do you want?',
    ],
  });

  const result = await h.run('ambiguous task');

  assert.equal(result.stopReason, 'ask');
  assert.equal(bridge.prompts.length, 2, 'the read ran first, then the model re-asked');
  assert.match(bridge.prompts[1].message, /hello/, 'the file contents rode back before the question');
});
