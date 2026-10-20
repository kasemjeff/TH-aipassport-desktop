// Runs extension/background.js in this process, so the worker's half of the
// conversation can be tested like anything else. The harness in harness.mjs
// stands in for the extension wholesale, which leaves the routing from a page
// reply to a bridge POST covered by nothing at all — and it is exactly where
// a reply gets dropped on the floor.
//
// It needs a chrome, but not much of one: the worker touches storage, the
// runtime listeners, the alarms and the tabs, and none of them have to do
// anything for a message to be routed. The event stream is the one call that
// must not come back — a worker that reconnects forever would keep the test
// process alive.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const BACKGROUND = path.join(here, '..', 'extension', 'background.js');

export function loadBackground({ bridgeUrl = 'http://127.0.0.1:8787', eventsStatus = 200 } = {}) {
  const requests = [];
  const listeners = { message: [], connect: [], startup: [], installed: [], alarm: [] };
  let streams = 0;

  const chrome = {
    storage: { local: { get: async (key) => (key === 'bridgeUrl' ? { bridgeUrl } : {}) } },
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
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body ?? null,
    });
    if (u.includes('/ext/events')) {
      // The first attempt answers, so the worker's reaction to it can be
      // observed. Every later one hangs, so the reconnect loop stops.
      if (streams++ === 0) {
        return new Response('', { status: eventsStatus, headers: { 'content-type': 'text/event-stream' } });
      }
      return new Promise(() => {});
    }
    return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
  };

  // The worker warns about a refused bridge; the test output does not need it.
  const quiet = { log: () => {}, warn: () => {}, error: () => {} };

  // The worker reconnects forever, and its cycle timer runs for four minutes.
  // Unref'd, neither keeps the test process alive.
  const unref = (t) => { t?.unref?.(); return t; };
  const setTimeoutShim = (fn, ms, ...args) => unref(setTimeout(fn, ms, ...args));
  const setIntervalShim = (fn, ms, ...args) => unref(setInterval(fn, ms, ...args));

  const src = fs.readFileSync(BACKGROUND, 'utf8');
  const run = new Function('chrome', 'fetch', 'console', 'Response', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', src);
  run(chrome, fetchImpl, quiet, Response, setTimeoutShim, setIntervalShim, clearTimeout, clearInterval);

  return {
    requests,
    // Hand the worker a page reply, the way the content script does.
    fromPage: (payload) => { for (const fn of listeners.message) fn({ type: 'from-page', payload }); },
    // Ask the worker how it is doing; the answer carries the last error.
    status: () => new Promise((resolve) => {
      let answered = false;
      const respond = (r) => { if (!answered) { answered = true; resolve(r); } };
      for (const fn of listeners.message) fn({ type: 'status' }, { id: 'test' }, respond);
      setTimeout(() => respond(null), 1000);
    }),
    // Every POST the worker made to a bridge route.
    posted: (route) => requests.filter((r) => r.method === 'POST' && r.url.endsWith(route)),
  };
}
