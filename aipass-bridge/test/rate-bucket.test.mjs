// The proactive token bucket (harness/bridge.mjs): one token per wire send,
// refilled at a fixed rate, so a parallel burst waits instead of drawing the
// 429 the retry ladder then has to wait out. The clock and sleep are injected,
// so the four-minute pace is pinned without spending four minutes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BridgeClient, TokenBucket, rateBucketConfig } from '../harness/bridge.mjs';

test('the bucket meters a burst and refills one token at a time', async () => {
  let clock = 0;
  const waits = [];
  const bucket = new TokenBucket({
    capacity: 2,
    refillMs: 1000,
    now: () => clock,
    sleep: async (ms) => { waits.push(ms); clock += ms; },
  });

  assert.equal(await bucket.take(), 0, 'the first two sends ride the initial burst');
  assert.equal(await bucket.take(), 0);
  assert.equal(await bucket.take(), 1000, 'the third waits for the next refill');
  assert.deepEqual(waits, [1000]);

  clock += 5000;
  assert.equal(await bucket.take(), 0, 'an idle gap refills up to capacity');
  await bucket.take();
  assert.equal(await bucket.take(), 1000, 'and the spend continues from there');
});

test('the bucket is abortable while it waits', async () => {
  const controller = new AbortController();
  const bucket = new TokenBucket({ capacity: 1, refillMs: 60_000 });
  await bucket.take();
  controller.abort();
  await assert.rejects(
    bucket.take({ signal: controller.signal }),
    (err) => err.name === 'AbortError',
  );
});

test('the environment names a bucket, an override, or off', () => {
  assert.deepEqual(rateBucketConfig(''), { capacity: 4, refillMs: 45_000 });
  assert.deepEqual(rateBucketConfig('2,1000'), { capacity: 2, refillMs: 1000 });
  assert.equal(rateBucketConfig('off'), null);
  assert.equal(rateBucketConfig('false'), null);
  // Nonsense keeps the safe default rather than turning pacing off by typo.
  assert.deepEqual(rateBucketConfig('nonsense'), { capacity: 4, refillMs: 45_000 });
});

test('BridgeClient takes one token per wire attempt, chat and create alike', async () => {
  const calls = [];
  const client = new BridgeClient('http://127.0.0.1:9', { rateBucket: false });
  client.bucket = { take: async (opts) => { calls.push(opts); return 0; } };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => (String(url).includes('/conversations/new')
    ? Response.json({ id: 'conv-test', ok: true })
    : new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }));
  try {
    const said = await client.chat({ message: 'hello' });
    const made = await client.createConversation({ message: 'fresh', adopt: false });
    assert.equal(said.text, 'ok');
    assert.equal(made.id, 'conv-test');
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(calls.length, 2, 'the chat send and the create each took a token');
});

test('rateBucket: false leaves the client unpaced', () => {
  const client = new BridgeClient('http://127.0.0.1:9', { rateBucket: false });
  assert.equal(client.bucket, null);
});
