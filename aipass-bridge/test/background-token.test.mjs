// The worker's half of the token protocol.
//
// The bridge hands the extension a random per-run token in the `ready` frame
// and refuses any /ext post that does not carry it, so the worker has to put
// it on every post. The shared worker harness (background-harness.mjs) answers
// the event stream with an empty body, so it cannot hand the worker that
// frame — this loader answers with it, which is what makes the header
// observable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { waitFor } from './harness.mjs';

const BACKGROUND = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'extension', 'background.js');

const loadWorker = ({ token = 'tok-123' } = {}) => {
  const requests = [];
  const listeners = { message: [], connect: [], startup: [], installed: [], alarm: [] };
  let streams = 0;

  const chrome = {
    storage: { local: { get: async (key) => (key === 'bridgeUrl' ? { bridgeUrl: 'http://127.0.0.1:8787' } : {}) } },
    runtime: {
      onConnect: { addListener: (fn) => listeners.connect.push(fn) },
      onMessage: { addListener: (fn) => listeners.message.push(fn) },
      onStartup: { addListener: (fn) => listeners.startup.push(fn) },
      onInstalled: { addListener: (fn) => listeners.installed.push(fn) },
      getManifest: () => ({ version: '0.0.0' }),
    },
    alarms: {
      create: () => {},
      onAlarm: { addListener: (fn) => listeners.alarm.push(fn) },
    },
    tabs: {
      query: async () => [],
      sendMessage: async () => {},
      reload: async () => {},
      onUpdated: { addListener: () => {}, removeListener: () => {} },
    },
    scripting: { executeScript: async () => [] },
  };

  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    requests.push({
      url: u,
      method: init?.method ?? 'GET',
      headers: init?.headers ?? {},
      body: init?.body ?? null,
    });
    if (u.includes('/ext/events')) {
      // The first answer carries the frame the bridge opens every extension
      // connection with — and the per-run token in it. Every later one hangs,
      // so the reconnect loop stops.
      if (streams++ === 0) {
        return new Response(`event: ready\ndata: ${JSON.stringify({ clientId: 'c1', token })}\n\n`, {
          status: 200, headers: { 'content-type': 'text/event-stream' },
        });
      }
      return new Promise(() => {});
    }
    return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
  };

  const quiet = { log: () => {}, warn: () => {}, error: () => {} };
  const unref = (t) => { t?.unref?.(); return t; };
  const setTimeoutShim = (fn, ms, ...args) => unref(setTimeout(fn, ms, ...args));
  const setIntervalShim = (fn, ms, ...args) => unref(setInterval(fn, ms, ...args));

  const src = fs.readFileSync(BACKGROUND, 'utf8');
  const run = new Function('chrome', 'fetch', 'console', 'Response', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', src);
  run(chrome, fetchImpl, quiet, Response, setTimeoutShim, setIntervalShim, clearTimeout, clearInterval);

  return {
    requests,
    fromPage: (payload) => { for (const fn of listeners.message) fn({ type: 'from-page', payload }); },
    posted: (route) => requests.filter((r) => r.method === 'POST' && r.url.endsWith(route)),
  };
};

test('the worker puts the bridge\'s per-run token on its posts', async () => {
  const bg = loadWorker({ token: 'tok-123' });
  await waitFor(() => bg.requests.some((r) => r.url.includes('/ext/events')));

  // The token arrives with the ready frame, which the bridge sends before it
  // sends any job — so the worker knows it before it posts anything. The
  // page replies are offered until one carries the header, so the test does
  // not depend on how fast the frame is read.
  let post = null;
  await waitFor(() => {
    bg.fromPage({ kind: 'chunk', jobId: 'j1', parts: [{ kind: 'text', text: 'hi' }] });
    post = bg.posted('/ext/chunk').at(-1) ?? null;
    return Boolean(post?.headers?.['x-aipass-token']);
  }, { timeout: 5000 });
  assert.equal(post.headers['x-aipass-token'], 'tok-123', 'the post carries the token the bridge handed over');

  // And it stays on every post after that.
  bg.fromPage({ kind: 'done', jobId: 'j1', finishReason: 'stop' });
  await waitFor(() => bg.posted('/ext/done').length > 0);
  assert.equal(bg.posted('/ext/done')[0].headers['x-aipass-token'], 'tok-123');
});
