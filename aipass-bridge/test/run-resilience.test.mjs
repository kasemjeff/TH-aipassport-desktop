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
//
// Its sibling, recorded the same afternoon: the edge answers 429 when the
// account moves too fast (ten messages in four minutes drew one), the page
// waits the request out inside the tab (extension/page.js RETRY_WAITS_MS —
// 5s/15s/45s, retry-after honoured), and the tests below pin the layer above
// it — a rate window longer than the page's budget is waited out here too,
// under the same "never after a delta streamed" rule.
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

/* The 429 layer — a rate window longer than the page's own budget ---------- */

test('a 429 refused send is waited out and retried, not lost', async (t) => {
  let refused = 0;
  const ext = await new FakeExtension(bridge.base, {
    onChat: async (_job, e) => {
      if (refused++ === 0) {
        return void e.error('aipass returned 429  [2046 bytes] {server=cloudflare via=1.1 google} — <!doctype html><title>429</title>');
      }
      await e.text('ผ่านแล้วครับ');
      await e.done();
    },
  }).connect();
  t.after(() => ext.disconnect());

  const notes = [];
  const client = new BridgeClient(bridge.base, { rateWaits: [20, 20], onNote: (text) => notes.push(text) });
  const res = await client.chat({ message: 'hi' });
  assert.match(res.text, /ผ่านแล้วครับ/, 'the retried send reached the extension');
  assert.equal(ext.chats.length, 2, 'refused once, accepted on the second attempt');
  assert.match(notes.join('\n'), /429/, 'and the wait was reported, not silent');
});

test('a 429 that never clears surfaces after the waits, not before them', async (t) => {
  const ext = await new FakeExtension(bridge.base, {
    onChat: async (_job, e) => void e.error('aipass returned 429  [2046 bytes] {server=cloudflare}'),
  }).connect();
  t.after(() => ext.disconnect());

  const client = new BridgeClient(bridge.base, { rateWaits: [10, 10] });
  await assert.rejects(() => client.chat({ message: 'hi' }), /429/);
  assert.equal(ext.chats.length, 3, 'the first send plus two waits — then the failure is real');
});

test('a 429 after the answer started streaming is not retried', async (t) => {
  const ext = await new FakeExtension(bridge.base, {
    onChat: async (_job, e) => {
      await e.text('ครึ่งแรก');
      await e.error('aipass returned 429  [2046 bytes] — pretend the limiter cut the tail');
    },
  }).connect();
  t.after(() => ext.disconnect());

  const client = new BridgeClient(bridge.base, { rateWaits: [10, 10] });
  await assert.rejects(() => client.chat({ message: 'hi' }), /429/);
  assert.equal(ext.chats.length, 1, 'a half-delivered answer is never resent');
});
