// The loopback surface: the backend's own front door.
//
// Everything here is about the boundary between the user's machine and the
// processes that reach for it — a web page in any browser, another program on
// the machine, a repository the agent was pointed at. The four things the
// desktop app gets wrong in that boundary are all one-request, one-file
// mistakes, and each of them was live:
//
//   1. a malformed request target took the whole backend down
//   2. a session handle that carried a separator was a raw file path
//   3. the bearer token rode along to whatever host the bridge URL named
//   4. the suite auto-started a bridge on the developer's real port
//
// The rest of the suite covers the harness's interior; this file covers the
// door.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startRpcServer, tempDir } from './harness.mjs';
import { SessionStore } from '../harness/session.mjs';
import { isLoopbackUrl } from '../harness/authtoken.mjs';
import { isOpenableUrl } from '../harness/browser.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');

/* 1 — a malformed request target answers 400, it does not kill the backend --- */

// `new URL(req.url, ...)` threw on a malformed target, and it was the first
// statement of an async listener: the rejection became an unhandled rejection
// and the process-level handler exited the backend. One request — `GET //[`
// HTTP/1.1 — was enough, from any local process and from any web page (a
// plain GET needs no preflight).
test('a malformed request target is refused, and the backend lives', async (t) => {
  // No autostart: this test is about the backend's own front door, and a real
  // bridge is a process this test would then have to own.
  const rpc = await startRpcServer({ root: tempDir(), autostartBridge: false });
  t.after(() => { rpc.server.closeAllConnections?.(); rpc.server.close(); });
  const port = rpc.server.address().port;

  // A raw socket, because a well-behaved HTTP client will not send a target
  // the server cannot parse — the browser will, and that is the point.
  const raw = await new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1', () => {
      sock.write('GET //[ HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');
    });
    let buf = '';
    sock.on('data', (d) => { buf += d.toString(); });
    sock.on('close', () => resolve(buf));
    sock.on('error', () => resolve(buf));
  });

  assert.match(raw, /^HTTP\/1\.[01] 400/, `a malformed target is answered, not thrown: ${raw.slice(0, 120)}`);

  // The backend is still serving: it did not exit, and it did not fall over.
  // Any HTTP answer proves it — the backend has no /status route (that is the
  // bridge's), so a 404 is the alive answer here.
  const after = await new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/status', method: 'GET', headers: { Host: `127.0.0.1:${port}` } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', () => resolve(0));
    req.end();
  });
  assert.notEqual(after, 0, 'the backend still answers after a malformed target');
});

/* 2 — a session handle is a handle, not a path ----------------------------- */

// An id that carried a separator was used as a raw path: `session.delete`
// deleted whatever it named, and `session.rename` rewrote its first line.
// The id is the only handle the window acts on, so it may only name a file
// inside the store.
test('a session handle that is a path cannot reach outside the store', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aipass-session-path-'));
  const store = new SessionStore(path.join(home, 'sessions'));
  const root = tempDir();

  const outside = path.join(home, 'precious.txt');
  fs.writeFileSync(outside, 'SENSITIVE — must survive\n');

  store.remove(outside, { root });
  assert.ok(fs.existsSync(outside), 'session.delete did not touch a file outside the store');

  store.rename(outside, 'OWNED', { root });
  assert.equal(fs.readFileSync(outside, 'utf8'), 'SENSITIVE — must survive\n',
    'session.rename did not rewrite a file outside the store');

  // The legitimate handle still works: the window lists sessions with their
  // absolute path and passes that back to open one.
  const made = store.create({ root, title: 'kept' });
  assert.ok(fs.existsSync(made.file), 'the session was created');
  const loaded = store.load(made.file, { root });
  assert.ok(loaded, 'a session inside the store still opens by its path');
  assert.equal(loaded.header.title, 'kept');

  fs.rmSync(home, { recursive: true, force: true });
});

/* 3 — the bearer token goes to loopback and nowhere else ------------------- */

// The clients decided "is this a bridge request?" by asking whether the URL
// STARTED WITH the bridge URL — and every call site built its URL as
// `${BRIDGE}${path}`, so the answer was yes by construction. `--bridge
// https://collector.example` shipped the token there.
test('the bearer token is attached to loopback only', () => {
  assert.equal(isLoopbackUrl('http://127.0.0.1:8790/rpc'), true);
  assert.equal(isLoopbackUrl('http://127.0.0.5:8790/rpc'), true);
  assert.equal(isLoopbackUrl('http://localhost:8790/rpc'), true);
  assert.equal(isLoopbackUrl('http://[::1]:8790/rpc'), true);
  assert.equal(isLoopbackUrl('https://collector.example/rpc'), false);
  assert.equal(isLoopbackUrl('http://127.0.0.1.evil.example/rpc'), false);
  assert.equal(isLoopbackUrl('not a url'), false);
});

/* 4 — a URL may not carry a cmd.exe metacharacter -------------------------- */

// The Windows fallback opens a URL with `cmd /c start`. cmd.exe parses its
// own command line, so `&`, `|`, `^` and `%` are not inert inside it — and a
// URL with a query string is an ordinary thing to have an `&` in.
test('openBrowser refuses a URL that cmd.exe would re-parse', () => {
  const bad = [
    'http://x.test/a?b=1&c=2',
    'http://x.test/a|c',
    'http://x.test/a^b',
    'http://x.test/a%PATH%b',
    'http://x.test/a;b',
    'http://x.test/a`b',
    'http://x.test/a$b',
    'http://x.test/a"b',
    'javascript:alert(1)',
    'file:///C:/Windows/System32/calc.exe',
  ];
  for (const url of bad) {
    assert.equal(isOpenableUrl(url), false, `${url} was refused`);
  }
  // The ordinary case still opens.
  assert.equal(isOpenableUrl('http://x.test/a?b=1'), true, 'a plain URL is allowed');
  assert.equal(isOpenableUrl('https://de.aipass.net/chat'), true, 'a plain https URL is allowed');
});

/* 5 — the suite never touches the developer's bridge port ------------------ */

// The suite turns the no-token escape hatch on for its own bridges, and a CLI
// the suite runs auto-starts a bridge — DETACHED, with the environment
// inherited. That bridge bound the developer's real port 8787 with the token
// gate off and outlived the run: any web page could blind-POST to it and
// spend the account's credits.
test('the suite does not use the developer\'s bridge port', () => {
  assert.notEqual(process.env.AIPASS_PORT, '8787',
    'the suite must not bind the developer\'s bridge port');
  assert.ok(process.env.AIPASS_PORT?.trim(), 'the suite names its own port');
  assert.equal(process.env.AIPASS_REQUIRE_AUTH, '0',
    'the suite\'s own bridges run without the token, so they must not be the developer\'s');
});

/* 6 — the desktop shell and the backend agree on what a port is ------------ */

// The shell read `AIPASS_DESKTOP_PORT` as a u16 and the backend read it as a
// Number. Zero is a port number to one and "any free port" to the other, and
// an empty value was 8790 to one and 0 to the other — so the window opened
// http://127.0.0.1:0/ with nothing behind it.
test('the desktop port is validated on both sides', () => {
  const node = fs.readFileSync(path.join(repo, 'desktop', 'main.mjs'), 'utf8');
  assert.match(node, /AIPASS_DESKTOP_PORT is not a port/,
    'the backend refuses a value that is not a port');
  assert.match(node, /n < 1 \|\| n > 65535/,
    'the backend refuses port 0 and anything above the port range');

  const rust = fs.readFileSync(path.join(repo, 'desktop', 'src-tauri', 'src', 'main.rs'), 'utf8');
  assert.match(rust, /AIPASS_DESKTOP_PORT is not a port/,
    'the shell refuses a value that is not a port');
  assert.match(rust, /if port == 0/,
    'the shell refuses port 0 — it is a port number, not a port');
});
