// The hardening pass, one test per decision the window depends on:
//
//   1. the port is local-only   — a web page in any browser on this machine
//      must not be able to drive the agent through it
//   2. events carry seq/id      — a reconnect or a reloaded window gets the
//      frames it missed instead of losing the middle of a run
//   3. one run per harness      — a second run refuses instead of corrupting
//      the first, and a failed run does not lock the project out
//   4. settings apply on save   — the sheet claims live; the process has to
//      agree for every key that reaches a module of its own
//   5. snapshot                 — one call that rebuilds a window's view
//   6. the desktop shell        — CSP declared (not null), and no test suite
//      riding along in the installer
//   7. the extension            — host access is the aipass origin + loopback
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort, tempDir } from './harness.mjs';
import { createRpc } from '../harness/rpc.mjs';
import { Harness } from '../harness/harness.mjs';
import { SessionStore } from '../harness/session.mjs';
import { Settings } from '../harness/settings.mjs';

// Same rule as the desktop suite: nothing here may touch the real ~/.aipass.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aipass-hardening-home-'));
process.env.AIPASS_HOME = HOME;
after(() => fs.rmSync(HOME, { recursive: true, force: true }));

/** An RPC backend with its own bridge, sessions, settings and port. No
 *  autostart: these tests do not need a bridge, and a run that does must
 *  start its own. */
async function startBackend({ root } = {}) {
  const port = await freePort();
  const rpc = createRpc({
    port,
    root: root ?? tempDir(),
    bridgeURL: `http://127.0.0.1:${await freePort()}`,
    autostartBridge: false,
    store: tempDir(),
    settings: new Settings(tempDir(), 'settings.json'),
  });
  return {
    port,
    rpc,
    url: (p = '/') => `http://127.0.0.1:${port}${p}`,
    call: async (method, params = {}) => {
      const res = await fetch(`http://127.0.0.1:${port}/rpc`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ method, params }),
      });
      const body = await res.json();
      if (!body.ok) throw new Error(body.error);
      return body.result;
    },
    /** A raw request: fetch will not let a test set Host or Origin, and
     *  those are exactly the headers the gate has to be able to see. */
    raw: (pathname, { method = 'POST', headers = {}, body = '' } = {}) => new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers }, (res) => {
        let text = '';
        res.on('data', (c) => { text += c; });
        res.on('end', () => resolve({ status: res.statusCode, text }));
      });
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    }),
    /** Read the SSE stream for a moment and return what arrived, so the
     *  replay buffer can be asserted frame by frame. `afterConnect` fires
     *  once the response headers are in — the server has already registered
     *  the listener by then — which is what makes a live-emit test possible. */
    readEvents: ({ since = null, lastEventId = null, headers = {}, ms = 300, afterConnect = null } = {}) => new Promise((resolve) => {
      const query = since == null ? '' : `?since=${since}`;
      const req = http.get({
        host: '127.0.0.1', port, path: `/events${query}`,
        headers: lastEventId != null ? { ...headers, 'last-event-id': String(lastEventId) } : headers,
      }, (res) => {
        let buf = '';
        res.on('data', (c) => { buf += String(c); });
        afterConnect?.();
        setTimeout(() => { req.destroy(); resolve(buf); }, ms);
      });
    }),
    stop() { rpc.server.close(); },
  };
}

/** `event: …\nid: …\ndata: …\n\n` → the frames, parsed. */
function frames(text) {
  return String(text).split('\n\n')
    .map((block) => block.trim())
    .filter((block) => block.startsWith('event:'))
    .map((block) => ({
      event: block.match(/^event: (.*)$/m)?.[1] ?? null,
      id: Number(block.match(/^id: (\d+)$/m)?.[1] ?? 0),
      data: JSON.parse(block.match(/^data: (.*)$/m)?.[1] ?? '{}'),
    }));
}

/* 1 — local only ---------------------------------------------------------- */

test('a request from the open web is refused, a local one is served', async (t) => {
  const env = await startBackend();
  t.after(() => env.stop());

  // A page on another origin: the browser sends Sec-Fetch-Site and Origin on
  // every fetch, so this is exactly what an attack looks like on the wire.
  const crossSite = await env.raw('/rpc', {
    headers: { 'sec-fetch-site': 'cross-site', 'content-type': 'application/json' },
    body: JSON.stringify({ method: 'status' }),
  });
  assert.equal(crossSite.status, 403);

  const foreignOrigin = await env.raw('/rpc', {
    headers: { origin: 'https://example.com', 'content-type': 'application/json' },
    body: JSON.stringify({ method: 'status' }),
  });
  assert.equal(foreignOrigin.status, 403);

  // DNS rebinding: the attacker's domain resolves to 127.0.0.1, so the
  // browser believes it is same-origin. Host is the one thing it cannot fake.
  const rebound = await env.raw('/rpc', {
    headers: { host: 'evil.example.com', 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
    body: JSON.stringify({ method: 'status' }),
  });
  assert.equal(rebound.status, 403);

  // The window itself, and any plain tool: same machine, no browser headers.
  const local = await env.raw('/rpc', {
    headers: { host: `127.0.0.1:${env.port}`, 'content-type': 'application/json' },
    body: JSON.stringify({ method: 'status' }),
  });
  assert.equal(local.status, 200);

  const loopbackName = await env.raw('/rpc', {
    headers: { host: `localhost:${env.port}`, 'content-type': 'application/json' },
    body: JSON.stringify({ method: 'status' }),
  });
  assert.equal(loopbackName.status, 200);

  // The UI files are gated too: a rebound host must not even load the page.
  const ui = await env.raw('/', { method: 'GET', headers: { host: 'evil.example.com' } });
  assert.equal(ui.status, 403);
  const events = await env.raw('/events', { method: 'GET', headers: { host: 'evil.example.com' } });
  assert.equal(events.status, 403);
});

/* 2 — event replay -------------------------------------------------------- */

test('a reconnecting listener is replayed the frames it missed, once', async (t) => {
  const env = await startBackend();
  t.after(() => env.stop());

  for (let i = 1; i <= 4; i++) env.rpc.events.emit('note', { text: `note ${i}` });

  // Hello carries the current seq, so a window always knows where it stands.
  const fresh = frames(await env.readEvents());
  const hello = fresh.at(-1);
  assert.equal(hello.event, 'hello');
  assert.ok(hello.data.seq >= 4, 'the newest seq is on the wire');

  // since=1 replays everything the buffer holds past that cursor. What the
  // cursor number itself is does not matter here — the boot spends a seq or
  // two of its own (a plugins frame), which is exactly why the assertions
  // below are written against the ids that came back, not against constants.
  const replayed = frames(await env.readEvents({ since: 1 })).filter((f) => f.event === 'note');
  assert.deepEqual(replayed.map((f) => f.data.text), ['note 1', 'note 2', 'note 3', 'note 4']);
  const ids = replayed.map((f) => f.id);
  assert.ok(ids.every((id) => id > 1), 'the cursor itself is not sent twice');
  assert.deepEqual(ids, [...ids].sort((a, b) => a - b), 'frames arrive in order');

  // A browser EventSource reconnect speaks Last-Event-ID, not ?since=: the
  // frame with that id is not repeated, only the ones after it.
  const byHeader = frames(await env.readEvents({ lastEventId: ids[0] })).filter((f) => f.event === 'note');
  assert.deepEqual(byHeader.map((f) => f.data.text), ['note 2', 'note 3', 'note 4']);

  // A cursor one before the oldest kept frame replays from the buffer start
  // rather than from zero: no duplicate of the whole conversation.
  const fromEdge = frames(await env.readEvents({ since: ids[0] - 1 })).filter((f) => f.event === 'note');
  assert.deepEqual(fromEdge.map((f) => f.data.text), ['note 1', 'note 2', 'note 3', 'note 4']);

  // A cursor older than the buffer keeps what the buffer still has; a cursor
  // of zero asks for nothing, which is the fresh-window case (it gets its
  // state from `snapshot` instead).
  const stale = frames(await env.readEvents({ since: 0 }));
  assert.ok(stale.at(-1).event === 'hello');
});

test('live frames keep flowing to a connected listener', async (t) => {
  const env = await startBackend();
  t.after(() => env.stop());
  // Emitted after the connection is up, so this is the live path rather than
  // the replay path: the listener must be registered by then.
  const buf = await env.readEvents({
    since: 0,
    ms: 150,
    afterConnect: () => { env.rpc.events.emit('note', { text: 'live 1' }); },
  });
  const live = frames(buf).filter((f) => f.event === 'note');
  assert.deepEqual(live.map((f) => f.data.text), ['live 1']);
  assert.ok(live[0].id > 0, 'and the frame is numbered like every other');
});

/* 3 — one run per harness -------------------------------------------------- */

test('a second run is refused while the first is in flight', async (t) => {
  const h = new Harness({ root: tempDir(), store: new SessionStore(tempDir()), bridgeURL: 'http://127.0.0.1:1' });
  h.running = true;
  await assert.rejects(() => h.run('another task'), /already in flight/);
});

test('a run that fails before the loop does not lock the project out', async (t) => {
  // Port 1 has nothing listening: the run cannot create its conversation, so
  // it fails on the way in. The flag has to come down anyway, or one bad run
  // would refuse every task for the rest of the process's life.
  const h = new Harness({ root: tempDir(), store: new SessionStore(tempDir()), bridgeURL: 'http://127.0.0.1:1' });
  await assert.rejects(() => h.run('do something'), /fetch failed|refused|ECONN/);
  assert.equal(h.running, false, 'the harness is unlocked again');
  await assert.rejects(() => h.run('try again'), /fetch failed|refused|ECONN/);
});

/* 4 — settings apply on save ------------------------------------------------ */

test('settings.set moves every module the sheet claims, not just the file', async (t) => {
  const env = await startBackend();
  t.after(() => env.stop());

  const skillsDir = tempDir({ 'probe.md': '# probe' });
  await env.call('settings.set', {
    maxSteps: 7,
    plan: true,
    requirePlanApproval: true,
    subagent: false,
    skillsDirs: [skillsDir],
  });

  const { rpc } = env;
  assert.equal(rpc.current.options.maxSteps, 7, 'the loop reads its step limit from the harness');
  assert.equal(rpc.current.options.plan, true);
  assert.equal(rpc.current.options.requirePlanApproval, true);
  assert.equal(rpc.current.options.subagent, false);
  assert.ok(rpc.current.skills.dirs.includes(path.resolve(skillsDir)), 'the library is rebuilt by name');

  // …and the file agrees, so a restart keeps what the sheet promised.
  const st = await env.call('status');
  assert.equal(st.maxSteps, 7);
  assert.equal(st.settings.maxSteps, 7);
});

/* 5 — snapshot --------------------------------------------------------------- */

test('snapshot rebuilds the window view in one call', async (t) => {
  const env = await startBackend();
  t.after(() => env.stop());

  const made = await env.call('session.new', { title: 'reload me' });
  const snap = await env.call('snapshot');
  assert.equal(snap.session.id, made.id);
  assert.equal(snap.session.title, 'reload me');
  assert.ok(Array.isArray(snap.entries));
  assert.deepEqual(snap.pending, []);
  assert.equal(snap.context.budget > 0, true);
  assert.ok(Array.isArray(snap.skills));
  assert.equal(snap.status.running, false);
  assert.equal(snap.status.root, env.rpc.current.root);
});

/* 6 — the desktop shell ------------------------------------------------------- */

// The window is a WebView: without a CSP it would trust whatever ends up in
// the document. The config also used to cart the whole test suite into the
// installer — developer files the packaged app never reads.
test('the desktop config keeps its CSP and ships no test suite', (t) => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const confPath = path.join(here, '..', '..', 'desktop', 'src-tauri', 'tauri.conf.json');
  if (!fs.existsSync(confPath)) return t.skip('desktop/ is not part of this checkout');
  const conf = JSON.parse(fs.readFileSync(confPath, 'utf8'));

  const csp = conf?.app?.security?.csp;
  assert.ok(csp && typeof csp === 'object', 'app.security.csp must be declared, not null');
  assert.equal(csp['script-src'], "'self'", 'scripts come from the app itself — no inline, no eval');
  assert.equal(csp['object-src'], "'none'");
  assert.equal(csp['base-uri'], "'self'");
  assert.match(String(csp['connect-src']), /http:\/\/127\.0\.0\.1/, 'the window must still reach the loopback backend');

  const resources = conf?.bundle?.resources ?? {};
  const shipped = Object.values(resources).join(' ');
  assert.ok(!shipped.includes('aipass-bridge/test'), 'the test suite must not ride along in the installer');
});

/* 7 — the extension ----------------------------------------------------------- */

// Least privilege: host access is the aipass origin and the loopback bridge,
// nothing else. storage.googleapis.com rode along once and no extension-context
// code ever called it — page.js fetches media as the page, not as the worker.
test('the extension requests only the hosts it uses', (t) => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const confPath = path.join(here, '..', 'extension', 'manifest.json');
  if (!fs.existsSync(confPath)) return t.skip('extension/ is not part of this checkout');
  const m = JSON.parse(fs.readFileSync(confPath, 'utf8'));
  assert.deepEqual(new Set(m.host_permissions ?? []), new Set([
    'https://*.aipass.net/*', 'https://aipass.net/*', 'http://127.0.0.1/*', 'http://localhost/*',
  ]), 'host access is the aipass origin plus the loopback bridge');
  for (const cs of m.content_scripts ?? []) {
    assert.ok(cs.matches.every((p) => p.includes('aipass.net')), 'content scripts stay on the aipass origin');
  }
});
