// The extension channel, hardened.
//
// A port that answers on the loopback is still a port any local process can
// reach, so the bridge has to be able to tell the extension from everybody
// else: the per-run token (a random value the bridge mints and hands over
// on connect), and the abort a timed-out job sends so a generation stops
// instead of quietly spending the account's credits.
//
// The rest of the file is the same hardening seen from the other side: the
// caps that keep a hostile URL or an oversized body from becoming the
// bridge's problem, and the body errors that are the caller's mistake
// rather than the bridge's.
//
// Every test drives the real bridge over HTTP — the surface the extension
// and the CLIs use — with a FakeExtension that plays the token protocol the
// way the worker does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startBridge, FakeExtension, waitFor } from './harness.mjs';

/** The frames of one streamed answer, as the CLI sees them. */
async function readStream(res) {
  const text = await res.text();
  const frames = text.split('\n\n')
    .map((f) => f.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join(''))
    .filter((d) => d && d !== '[DONE]')
    .map((d) => JSON.parse(d));
  return {
    content: frames.map((f) => f.choices?.[0]?.delta?.content ?? '').join(''),
    error: frames.find((f) => f.error)?.error,
  };
}

const ask = (base, body) => fetch(`${base}/v1/chat/completions`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

/* ------------------------------------------------------- the per-run token */

test('the bridge refuses an /ext post that does not carry the per-run token', async (t) => {
  const bridge = await startBridge();
  t.after(() => bridge.stop());

  const res = await fetch(`${bridge.base}/ext/chunk`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jobId: '00000000-0000-0000-0000-000000000000', parts: [] }),
  });
  assert.equal(res.status, 403, 'a local process that learned a job id is not the extension');
  const body = await res.json();
  assert.equal(body.ok, false);
});

test('the extension is handed a per-run token, and only that token is accepted', async (t) => {
  const bridge = await startBridge();
  t.after(() => bridge.stop());
  const ext = await new FakeExtension(bridge.base).connect();
  t.after(() => ext.disconnect());
  assert.ok(ext.token, 'the ready frame carries the per-run token');

  const wrong = await fetch(`${bridge.base}/ext/chunk`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-aipass-token': 'not-the-token' },
    body: JSON.stringify({ jobId: '00000000-0000-0000-0000-000000000000', parts: [] }),
  });
  assert.equal(wrong.status, 403, 'a wrong token is refused');

  const right = await fetch(`${bridge.base}/ext/chunk`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-aipass-token': ext.token },
    body: JSON.stringify({ jobId: '00000000-0000-0000-0000-000000000000', parts: [] }),
  });
  assert.equal(right.status, 200);
  const body = await right.json();
  assert.equal(body.reason, 'unknown job', 'the token passes; the unknown job id is the only complaint left');
});

test('the per-run token is not the same on the next bridge run', async (t) => {
  const first = await startBridge();
  const second = await startBridge();
  t.after(() => { first.stop(); second.stop(); });

  const one = await new FakeExtension(first.base).connect();
  const two = await new FakeExtension(second.base).connect();
  t.after(() => { one.disconnect(); two.disconnect(); });

  assert.ok(one.token && two.token);
  assert.notEqual(one.token, two.token, 'a token that outlives its bridge is a standing secret');
});

test('the loopback bearer gate still comes before the per-run token', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aipass-token-'));
  const token = 'test-token-' + '0'.repeat(53);
  const bridge = await startBridge({ AIPASS_HOME: home, AIPASS_TOKEN: token, AIPASS_REQUIRE_AUTH: '1' });
  t.after(() => bridge.stop());

  const anonymous = await fetch(`${bridge.base}/ext/chunk`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jobId: 'x', parts: [] }),
  });
  assert.equal(anonymous.status, 401, 'no bearer is still a 401');

  const withBearer = await fetch(`${bridge.base}/ext/chunk`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ jobId: 'x', parts: [] }),
  });
  assert.equal(withBearer.status, 403, 'the bearer opens the door; the per-run token is what is missing');
});

/* --------------------------------------------------------- the dispatch gap */

test('a chat that lands in the reconnect gap waits for the extension to come back', async (t) => {
  // The service worker cycles its stream every few minutes, and a chat that
  // lands in that ~3 s gap used to fail outright.
  const bridge = await startBridge({ AIPASS_DISPATCH_GRACE_MS: '8000' });
  t.after(() => bridge.stop());

  const pending = ask(bridge.base, { stream: true, messages: [{ role: 'user', content: 'hi' }] });
  await new Promise((r) => setTimeout(r, 800));

  const ext = await new FakeExtension(bridge.base).connect();
  t.after(() => ext.disconnect());

  const out = await readStream(await pending);
  assert.equal(out.content, 'ok', 'the job ran once the extension came back');
  assert.equal(out.error, undefined);
});

test('a chat with no extension at all fails once the grace runs out', async (t) => {
  const bridge = await startBridge({ AIPASS_DISPATCH_GRACE_MS: '700' });
  t.after(() => bridge.stop());

  const started = Date.now();
  const res = await ask(bridge.base, { messages: [{ role: 'user', content: 'hi' }] });
  const body = await res.json();
  assert.equal(res.status, 502);
  assert.match(body.error.message, /no extension connected/);
  assert.ok(Date.now() - started >= 600, 'the grace was actually waited out');
});

test('a loader read fails fast, because nobody is blocked on a cache refresh', async (t) => {
  const bridge = await startBridge({ AIPASS_DISPATCH_GRACE_MS: '8000' });
  t.after(() => bridge.stop());

  const started = Date.now();
  const res = await fetch(`${bridge.base}/conversations`, { headers: { accept: 'application/json' } });
  await res.json().catch(() => {});
  assert.ok(Date.now() - started < 3000, 'the loader read did not wait out the grace');
});

/* ---------------------------------------------- a timeout tells the page to stop */

test('a job that times out tells the extension to stop', async (t) => {
  const bridge = await startBridge({ AIPASS_IDLE_TIMEOUT_MS: '600' });
  t.after(() => bridge.stop());
  // never answers: the timeout is the only thing that ends this job
  const ext = await new FakeExtension(bridge.base, { onChat: async () => {} }).connect();
  t.after(() => ext.disconnect());

  const res = await ask(bridge.base, { messages: [{ role: 'user', content: 'hi' }] });
  const body = await res.json();
  assert.match(body.error.message, /timed out/);

  await waitFor(() => ext.aborts.length > 0, { timeout: 3000 });
  assert.ok(ext.aborts.length > 0, 'the extension was told to stop, so the page stops polling upstream');
});

test('a reconnecting extension adopts the job its predecessor left behind', async (t) => {
  const bridge = await startBridge({ AIPASS_IDLE_TIMEOUT_MS: '1500' });
  t.after(() => bridge.stop());
  const first = await new FakeExtension(bridge.base, { onChat: async () => {} }).connect();

  const pending = ask(bridge.base, { messages: [{ role: 'user', content: 'hi' }] });
  await waitFor(() => first.chats.length > 0);
  // The worker is evicted and its stream is rebuilt — the job is still running
  // in the page, but the bridge no longer knows who is holding it.
  await first.disconnect();

  const second = await new FakeExtension(bridge.base, { onChat: async () => {} }).connect();
  t.after(() => { first.disconnect(); second.disconnect(); });
  pending.catch(() => {});

  await waitFor(() => second.aborts.length > 0, { timeout: 5000 });
  assert.ok(second.aborts.length > 0, 'the abort reached the client that came back');
});

/* ------------------------------------------------------------------- the caps */

test('an inline picture over the cap is dropped, not forwarded', async (t) => {
  const bridge = await startBridge();
  t.after(() => bridge.stop());
  const ext = await new FakeExtension(bridge.base).connect();
  t.after(() => ext.disconnect());

  // The cap is 20 MB of media; this is 21 MB of it, in Base64.
  const big = 'A'.repeat(28_000_000);
  const res = await ask(bridge.base, {
    messages: [{
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: `data:image/png;base64,${big}` } },
        { type: 'text', text: 'look at this' },
      ],
    }],
  });
  assert.equal(res.status, 200);
  const job = ext.chats.at(-1);
  assert.ok(job, 'the chat reached the extension');
  assert.equal((job.parts ?? []).filter((p) => p.type === 'image').length, 0,
    'the oversized picture was not forwarded to the account');
  assert.match(bridge.logText(), /refusing inline image over/);
});

test('a chunk whose parts are not an array is refused', async (t) => {
  const bridge = await startBridge();
  t.after(() => bridge.stop());
  const ext = await new FakeExtension(bridge.base).connect();
  t.after(() => ext.disconnect());

  const res = await fetch(`${bridge.base}/ext/chunk`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-aipass-token': ext.token },
    body: JSON.stringify({ jobId: '00000000-0000-0000-0000-000000000000', parts: { kind: 'text', text: 'hi' } }),
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.reason, /parts must be an array/);
});

/* --------------------------------------------------------------- body errors */

test('a null JSON body is a 400, not a 500', async (t) => {
  const bridge = await startBridge();
  t.after(() => bridge.stop());

  const chat = await fetch(`${bridge.base}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: 'null',
  });
  assert.equal(chat.status, 400, 'a null body is the caller\'s mistake');
  assert.match((await chat.json()).error.message, /JSON object/);

  const config = await fetch(`${bridge.base}/config`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: 'null',
  });
  assert.equal(config.status, 400);
  assert.doesNotMatch(bridge.logText(), /unhandled/, 'and it is not an unhandled crash');
});

test('a body over the limit is a 413, not a reset', async (t) => {
  const bridge = await startBridge();
  t.after(() => bridge.stop());

  // The body limit is 32 MB; this is over it. The old reader destroyed the
  // socket, so the client saw ECONNRESET and never learned why.
  const res = await fetch(`${bridge.base}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: 'x'.repeat(33 * 1024 * 1024),
  });
  assert.equal(res.status, 413);
  assert.match((await res.json()).error.message, /too large/);
});

/* ---------------------------------------------------------- the media timeout */

test('an image model gets the media silence allowance, not the chat one', async (t) => {
  // An image generation sits quiet for the whole render: with the chat
  // timeout it was killed minutes before it could answer, with the credits
  // already spent.
  const bridge = await startBridge({ AIPASS_IDLE_TIMEOUT_MS: '400', AIPASS_MEDIA_TIMEOUT_MS: '8000' });
  t.after(() => bridge.stop());
  const ext = await new FakeExtension(bridge.base, { onChat: async () => {} }).connect();
  t.after(() => ext.disconnect());

  let settled = false;
  const pending = ask(bridge.base, { model: 'gpt-image-2', messages: [{ role: 'user', content: 'a cat' }] })
    .then((r) => { settled = true; return r; }, (e) => { settled = true; throw e; });
  pending.catch(() => {});

  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(settled, false, 'the image job outlived the chat idle timeout');
});
