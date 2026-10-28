/**
 * Helper presets: the machine's own SUBAGENT roles, beside the built-ins.
 *
 * dsh composes each agent's capabilities from a named preset; here the same
 * idea lands at this harness's size — settings `helperPresets` names extra
 * shapes a `role:` line may ask for, each judged by the same rule a built-in
 * is: read-only by construction, and `run` true only where the run itself
 * was given allowRun. What this file pins:
 *   - a settings preset leads the helper's brief, like a built-in does;
 *   - a built-in name cannot be shadowed by a settings entry;
 *   - a malformed preset is an error at the helper, named, never a silent
 *     fallback to "no role";
 *   - an unknown role still answers with the names that exist — the
 *     machine's own included.
 *
 * Run: node --test aipass-bridge/test/helper-presets.test.mjs
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionStore } from '../harness/session.mjs';
import { Emitter } from '../harness/events.mjs';
import { Harness } from '../harness/harness.mjs';
import { resolveHelperPreset, SUBAGENT_ROLES } from '../harness/loop.mjs';
import { BridgeClient } from '../harness/bridge.mjs';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aipass-presets-home-'));
process.env.AIPASS_HOME = HOME;
after(() => fs.rmSync(HOME, { recursive: true, force: true }));

const tempDir = (files = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aipass-presets-'));
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  return dir;
};

/** A bridge that answers with canned replies and records every message. */
class RecordingBridge extends BridgeClient {
  constructor(replies) {
    super('http://127.0.0.1:1');
    this.model = 'stub';
    this.replies = replies;
    this.turn = 0;
    this.messages = [];
  }
  async chat({ message }) {
    this.messages.push(message);
    return { text: this.replies[Math.min(this.turn++, this.replies.length - 1)] ?? 'DONE', reasoning: '' };
  }
  async quota() { return { available: 100 }; }
  async createConversation() { return { id: 'stub-conversation' }; }
  async config() {}
  async status() { return { conversation: 'stub-conversation' }; }
}

const makeHarness = (bridge, extraOptions = {}) => new Harness({
  root: tempDir({ 'notes.md': 'hello\n' }),
  client: bridge,
  store: new SessionStore(path.join(tempDir(), 'sessions')),
  options: { mode: 'yolo', subagent: true, ...extraOptions },
  events: new Emitter(),
});

test('a settings preset leads the helper brief the way a built-in does', async () => {
  const bridge = new RecordingBridge([
    'SUBAGENT\nrole: docs-reader\ntask: read notes.md\nEND',
    'DONE notes say hello',
    'DONE the helper reported',
  ]);
  const h = makeHarness(bridge, {
    helperPresets: {
      'docs-reader': { lead: 'You are a docs reader. Read the named documents and answer only from them.', run: false },
    },
  });

  const result = await h.run('have the helper read notes.md');
  assert.equal(result.stopReason, 'done');
  // The helper's own first message carries the brief — the preset's lead
  // with the task beneath it, the same shape a built-in role gets.
  const brief = bridge.messages.find((m) => m.includes('You are a docs reader.'));
  assert.ok(brief, 'the helper brief carries the preset lead');
  assert.match(brief, /Task: read notes\.md/, 'with the task beneath it');
  // And a preset cannot widen the run's powers: the child was built without
  // allowRun, so `run` stayed false however the entry spelled it.
  assert.ok(
    h.session.entries.some((e) => e.type === 'note' && (e.text ?? '').includes('docs-reader')),
    'the helper run is recorded in the session log',
  );
});

test('a settings entry cannot shadow a built-in role', async () => {
  const bridge = new RecordingBridge([
    'SUBAGENT\nrole: verifier\ntask: check notes.md\nEND',
    'DONE verdict: pass',
    'DONE the verifier reported',
  ]);
  const h = makeHarness(bridge, {
    allowRun: true,
    helperPresets: { verifier: { lead: 'A shadowed lead.', run: false } },
  });

  const result = await h.run('check notes.md');
  assert.equal(result.stopReason, 'done');
  const brief = bridge.messages.find((m) => m.includes('You are a verifier.'));
  assert.ok(brief, 'the built-in lead is what ran');
  assert.ok(!bridge.messages.some((m) => m.includes('A shadowed lead.')), 'the shadow never spoke');
  // And the built-in's powers are the built-in's: the entry's run:false did
  // not narrow a verifier, either — spec powers are the built-in's own.
  const spec = resolveHelperPreset('verifier', { verifier: { lead: 'x', run: false } }).spec;
  assert.equal(spec, SUBAGENT_ROLES.verifier, 'the resolve returns the built-in object whole');
});

test('a malformed settings preset is an error at the helper, named', async () => {
  const bridge = new RecordingBridge([
    'SUBAGENT\nrole: broken\ntask: anything\nEND',
    'DONE ok',
  ]);
  const h = makeHarness(bridge, { helperPresets: { broken: { run: true } } });

  const result = await h.run('use the broken preset');
  assert.equal(result.stopReason, 'done');
  // The err rides back as the SUBAGENT's tool result — the model reads why;
  // the run itself goes on (a refused helper is a correction, not a stop).
  const toolEntry = h.session.entries.filter((e) => e.type === 'tool').at(-1);
  assert.match(toolEntry?.out ?? '', /err: helper preset "broken" is malformed/, 'the model reads why');
});

test('an unknown role names the machine presets among the choices', async () => {
  const presets = { 'docs-reader': { lead: 'Read docs.', run: false } };
  const miss = resolveHelperPreset('no-such-role', presets);
  assert.match(miss.error, /verifier, reviewer, summariser, docs-reader/, 'built-ins and presets both listed');
  const builtInMiss = resolveHelperPreset('no-such-role', {});
  assert.match(builtInMiss.error, /verifier, reviewer, summariser/, 'and the built-ins alone when there are none');
});

test('a preset spelled with capitals still answers its lowercase role line', () => {
  const { spec, error } = resolveHelperPreset('docs_reader', { 'Docs_Reader': { lead: 'Read.', run: false } });
  assert.equal(error, null);
  assert.equal(spec.lead, 'Read.', 'matched without letter case');
  assert.equal(spec.run, false, 'run defaults to false when the entry omits it');
});
