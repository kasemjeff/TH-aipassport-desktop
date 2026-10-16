// The four-minute blip, pinned.
//
// The extension cycles its SSE connection to the bridge every four minutes
// (extension/background.js CYCLE_MS — "reconnect before Chrome's long-request
// ceiling"), and for the few seconds around each cycle the bridge has no tab
// to dispatch to, so a send that lands in that gap is refused instantly with
// "no extension connected". Recorded failure: the user's runs of Oct 16,
// 10:57 local, died with stopReason "error" mid-task — one dispatch line in
// the backend log sits between "extension disconnected" and "extension
// connected". These tests pin the client-side cure: the gap is retried, a
// refusal after the answer started streaming is not (a resend would deliver
// the text twice), and a conversation create survives the same gap.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startBridge, FakeExtension, scripted, waitFor } from './harness.mjs';
import { BridgeClient } from '../harness/bridge.mjs';

let bridge;
before(async () => { bridge = await startBridge(); });
after(() => bridge.stop());

const extCount = () => fetch(`${bridge.base}/status`).then((r) => r.json()).then((s) => s.extensions);
const noExtension = () => waitFor(async () => (await extCount()) === 0, { timeout: 3000 });

test('a send refused while the extension is away is retried, not lost', async (t) => {
  await noExtension();
  const client = new BridgeClient(bridge.base);

  // The first attempt hits a bridge with no extension attached — the exact
  // refusal a cycle gap leaves behind. The extension comes back well inside
  // the retry window, the way it does in the browser three seconds later.
  const pending = client.chat({ message: 'hi' });
  const ext = await new FakeExtension(bridge.base, { onChat: scripted(['กลับมาแล้วครับ']) }).connect();
  t.after(() => ext.disconnect());

  const res = await pending;
  assert.match(res.text, /กลับมาแล้วครับ/, 'the retried send reached the extension');
  assert.equal(ext.chats.length, 1, 'and it was delivered exactly once');
});

test('a refusal after the answer started streaming is not retried', async (t) => {
  const ext = await new FakeExtension(bridge.base, {
    onChat: async (_job, e) => {
      await e.text('ครึ่งแรก');
      await e.error('no extension connected — pretend the pipe broke mid-answer');
    },
  }).connect();
  t.after(() => ext.disconnect());

  const client = new BridgeClient(bridge.base);
  await assert.rejects(() => client.chat({ message: 'hi' }), /no extension connected/);
  assert.equal(ext.chats.length, 1, 'the refusal surfaced instead of resending the half-delivered text');
});

test('a conversation create survives the same gap', async (t) => {
  await noExtension();
  const client = new BridgeClient(bridge.base);

  const pending = client.createConversation({ temporary: true, message: 'Starting a new working session.' });
  const ext = await new FakeExtension(bridge.base).connect();
  t.after(() => ext.disconnect());

  const made = await pending;
  assert.ok(made?.id, 'the create answered with an id after the retry');
  assert.equal(ext.created.length, 1, 'one create reached the extension');
});
