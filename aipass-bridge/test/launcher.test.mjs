// The desktop launcher's rules, driven directly.
//
// The launcher used to be the entry script's top level: it decided the port,
// found the project, started the bridge and adopted or started the backend.
// An entry script runs its top level on import, so the one file that decides
// which backend the window talks to was the one file no test could touch.
//
// The rules now live in `harness/launcher.mjs` and this file drives them:
// the port rule, the root rule, the bridge probe, the spawn, the adoption and
// the busy port — none of which needs a window, a browser or the developer's
// own ports.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort, startRpcServer, tempDir } from './harness.mjs';
import {
  DEFAULT_DESKTOP_PORT,
  backendIsUp,
  bridgeIsUp,
  ensureBridge,
  openWindow,
  resolveDesktopPort,
  resolveRoot,
  runLauncher,
  wantsDetach,
} from '../harness/launcher.mjs';
import { UNAUTHORIZED } from '../harness/authtoken.mjs';
import { tryDesktopRpc } from '../harness/desktop-rpc.mjs';
// The real backend factory: the busy-port case has to build a server that
// genuinely tries to bind the port that is already taken.
const { createRpc } = await import('../harness/rpc.mjs');

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/* --------------------------------------------------------------- the port rule */

test('the desktop port is a port, on both sides', () => {
  // The rule the shell enforces too (src-tauri/src/main.rs): a value that is
  // not a port is refused, so the two never disagree about what they bound.
  assert.equal(resolveDesktopPort({}), DEFAULT_DESKTOP_PORT, 'no value is the default');
  assert.equal(resolveDesktopPort({ AIPASS_DESKTOP_PORT: '' }), DEFAULT_DESKTOP_PORT, 'an empty value is the default');
  assert.equal(resolveDesktopPort({ AIPASS_DESKTOP_PORT: '  ' }), DEFAULT_DESKTOP_PORT, 'a blank value is the default');
  assert.equal(resolveDesktopPort({ AIPASS_DESKTOP_PORT: '9123' }), 9123, 'a port is a port');

  for (const bad of ['0', '65536', '-1', '12.5', 'abc', '80 80', '0x50']) {
    assert.throws(
      () => resolveDesktopPort({ AIPASS_DESKTOP_PORT: bad }),
      /AIPASS_DESKTOP_PORT is not a port/,
      `${bad} is not a port`,
    );
  }
});

/* --------------------------------------------------------------- the root rule */

test('the launcher serves the project it was pointed at', () => {
  assert.equal(resolveRoot(['node', 'main.mjs'], '/tmp/work'), path.resolve('/tmp/work'),
    'without --root it is the folder the launcher was started in');
  assert.equal(resolveRoot(['node', 'main.mjs', '--root', '/tmp/other'], '/tmp/work'), path.resolve('/tmp/other'),
    '--root names the project');
  assert.equal(resolveRoot(['node', 'main.mjs', '--root', 'sub'], '/tmp/work'), path.resolve('/tmp/work', 'sub'),
    'a relative root is resolved against the folder, not left to the backend');
});

test('the detach mode is asked for on the command line', () => {
  assert.equal(wantsDetach(['node', 'main.mjs']), false, 'the window starts the backend itself');
  assert.equal(wantsDetach(['node', 'main.mjs', '--detach']), true, 'tauri dev asks for the detached mode');
  assert.equal(wantsDetach(['node', 'main.mjs', '--root', '/tmp']), false, 'another flag is not the detached mode');
});

/* ------------------------------------------------------------------ the probes */

test('the launcher tells our bridge from a stranger', async () => {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const server = http.createServer((_req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: UNAUTHORIZED }));
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  try {
    assert.equal(await bridgeIsUp(base), false, 'a 401 is not the bridge answering');
  } finally {
    server.close();
  }

  const up = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise((r) => up.listen(port, '127.0.0.1', r));
  try {
    assert.equal(await bridgeIsUp(base), true, 'the bridge answers /status');
  } finally {
    up.close();
  }
});

test('the launcher tells our backend from a stranger', async () => {
  // The backend is behind the loopback token, so the probe asks with the
  // token and reads the refusal: a 401 that is ours means the backend is up.
  const port = await freePort();
  const ours = http.createServer((_req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: UNAUTHORIZED }));
  });
  await new Promise((r) => ours.listen(port, '127.0.0.1', r));
  try {
    assert.equal(await backendIsUp(port), true, 'our own 401 is still our backend');
  } finally {
    ours.close();
  }

  const stranger = http.createServer((_req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'not our backend' }));
  });
  await new Promise((r) => stranger.listen(port, '127.0.0.1', r));
  try {
    assert.equal(await backendIsUp(port), false, 'a foreign server is not our backend');
  } finally {
    stranger.close();
  }
});

/* --------------------------------------------------------------- the bridge */

test('the launcher adopts a bridge that is already running', async () => {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  try {
    const child = await ensureBridge({ repo, root: tempDir(), bridgeUrl: base });
    assert.equal(child, null, 'a bridge that answers is adopted, not started again');
  } finally {
    server.close();
  }
});

test('the launcher starts the bridge when it is not running', async () => {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const root = tempDir();
  const lines = [];
  const child = await ensureBridge({
    repo,
    root,
    bridgeUrl: base,
    // The bridge binds AIPASS_PORT; the suite's own port, never the
    // developer's.
    env: { ...process.env, AIPASS_PORT: String(port), AIPASS_REQUIRE_AUTH: '0' },
    out: { write: (s) => lines.push(s) },
    err: { write: (s) => lines.push(s) },
  });
  try {
    assert.ok(child, 'the bridge was started');
    assert.equal(await bridgeIsUp(base), true, 'and it answers');
  } finally {
    child?.kill('SIGKILL');
  }
});

/* --------------------------------------------------------------- the launcher */

test('the launcher opens the window only when it is asked to', async () => {
  // AIPASS_DESKTOP_NO_OPEN is how a test (and the headless install ladder)
  // says "the backend, but no browser".
  assert.equal(await openWindow('http://127.0.0.1:1/', { env: { AIPASS_DESKTOP_NO_OPEN: '1' } }), false,
    'the window stays closed');
});

test('the launcher adopts a backend that is already running', async () => {
  const port = await freePort();
  // The bridge URL points at nothing: the backend must not open a client to a
  // bridge that is not there, and the suite must not talk to the developer's.
  const rpc = await startRpcServer({
    root: tempDir(),
    store: tempDir(),
    bridgeURL: 'http://127.0.0.1:1/',
    autostartBridge: false,
  });
  const lines = [];
  try {
    const done = await runLauncher({
      repo,
      port: rpc.port,
      root: tempDir(),
      bridgeUrl: 'http://127.0.0.1:1/',
      createRpc: () => { throw new Error('the launcher must not start a second backend'); },
      env: { AIPASS_DESKTOP_NO_OPEN: '1' },
      out: { write: (s) => lines.push(s) },
      err: { write: (s) => lines.push(s) },
    });
    assert.equal(done.adopted, true, 'the running backend was adopted');
    assert.ok(lines.join('').includes('a backend is already on'), `it says so: ${lines.join('')}`);
  } finally {
    rpc.server.close(); rpc.server.closeAllConnections?.();
  }
});

test('the detached launcher leaves a running backend alone', async () => {
  // `tauri dev` runs this before every launch. A second backend would only
  // land EADDRINUSE in the log.
  const port = await freePort();
  const rpc = await startRpcServer({
    root: tempDir(),
    store: tempDir(),
    bridgeURL: 'http://127.0.0.1:1/',
    autostartBridge: false,
  });
  const lines = [];
  try {
    const done = await runLauncher({
      repo,
      port: rpc.port,
      root: tempDir(),
      bridgeUrl: 'http://127.0.0.1:1/',
      createRpc: () => { throw new Error('the launcher must not start a second backend'); },
      detach: true,
      env: { AIPASS_DESKTOP_NO_OPEN: '1' },
      out: { write: (s) => lines.push(s) },
      err: { write: (s) => lines.push(s) },
    });
    assert.equal(done.adopted, true, 'the running backend was left alone');
    assert.ok(lines.join('').includes('already running on'), `it says so: ${lines.join('')}`);
  } finally {
    rpc.server.close(); rpc.server.closeAllConnections?.();
  }
});

test('the launcher names the port that is busy, not a stack trace', async () => {
  // The window has nothing to open, so the launcher stops — but it says which
  // port and what to do about it. The holder answers like a stranger, so the
  // launcher does not adopt it and the bind is what fails.
  const port = await freePort();
  const holder = http.createServer((_req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'not our backend' }));
  });
  await new Promise((r) => holder.listen(port, '127.0.0.1', r));
  const lines = [];
  try {
    const done = await runLauncher({
      repo,
      port,
      root: tempDir(),
      bridgeUrl: 'http://127.0.0.1:1/',
      createRpc,
      env: { AIPASS_DESKTOP_NO_OPEN: '1' },
      out: { write: (s) => lines.push(s) },
      err: { write: (s) => lines.push(s) },
      onBusy: () => {},
    });
    assert.equal(done.busy, true, 'the launcher stopped at the busy port');
  } finally {
    holder.close();
  }
  assert.ok(lines.join('').includes(`port ${port} is busy`), `the port is named: ${lines.join('')}`);
  assert.ok(lines.join('').includes('AIPASS_DESKTOP_PORT'), 'and the way out is named');
});

test('the detached launcher starts the backend and leaves it running', async () => {
  // `tauri dev` starts the backend this way: its own process, out of this
  // one, so the window can come up and go away on its own schedule.
  const port = await freePort();
  const bridgePort = await freePort();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aipass-launcher-home-'));
  const lines = [];
  const done = await runLauncher({
    repo,
    port,
    root: tempDir(),
    bridgeUrl: `http://127.0.0.1:${bridgePort}`,
    createRpc,
    detach: true,
    env: {
      ...process.env,
      AIPASS_HOME: home,
      AIPASS_PORT: String(bridgePort),
      AIPASS_DESKTOP_NO_OPEN: '1',
    },
    out: { write: (s) => lines.push(s) },
    err: { write: (s) => lines.push(s) },
  });
  try {
    assert.equal(done.ok, true, 'the backend came up');
    assert.ok(lines.join('').includes('backend detached on'), `it says so: ${lines.join('')}`);
    // The window it will open is really serving.
    const home2 = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(home2.status, 200, 'the window is served');
    // And the log the launcher's own failure would point at is where it says.
    assert.ok(fs.existsSync(path.join(home, 'logs', 'desktop-backend.log')), 'the log is where it says it is');
  } finally {
    done.backend?.kill('SIGKILL');
    done.bridge?.kill('SIGKILL');
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('the launcher stops the backend and the bridge when it is told to', async () => {
  const port = await freePort();
  const bridgePort = await freePort();
  const lines = [];
  const done = await runLauncher({
    repo,
    port,
    root: tempDir(),
    bridgeUrl: `http://127.0.0.1:${bridgePort}`,
    createRpc,
    env: {
      ...process.env,
      AIPASS_PORT: String(bridgePort),
      AIPASS_DESKTOP_NO_OPEN: '1',
    },
    out: { write: (s) => lines.push(s) },
    err: { write: (s) => lines.push(s) },
  });
  assert.ok(done.shutdown, 'the launcher can be stopped');
  done.rpc.server.closeAllConnections?.();
  done.rpc.server.close();
  done.bridge?.kill('SIGKILL');
});

/* ------------------------------------------------- the CLI's client for a backend */

test('the CLI asks the backend first, and a refusal is the answer', async () => {
  // The CLI edits the same files the desktop backend reads, but a backend
  // that is already running will not notice a file edit. So every mutating
  // CLI command tries the backend first — and the three outcomes mean three
  // different things to the caller.
  const port = await freePort();
  const seen = [];
  const backend = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      seen.push(JSON.parse(body || '{}'));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'the backend refused the call', stage: 'apply' }));
    });
  });
  await new Promise((r) => backend.listen(port, '127.0.0.1', r));
  try {
    // A refusal is not a failure to reach the backend: falling back to a file
    // edit would do the same thing behind the backend's back.
    const refused = await tryDesktopRpc('apply', { files: ['a.txt'] }, { port });
    assert.equal(refused.ok, false, 'the refusal is the answer');
    assert.equal(refused.error, 'the backend refused the call');
    assert.equal(refused.stage, 'apply', 'and the step that closed the door is named');
    assert.equal(seen.length, 1, 'the backend was asked');
    assert.equal(seen[0].method, 'apply', 'with the method the caller wanted');
  } finally {
    backend.close();
  }
});

test('the CLI falls back to the files when nothing is listening', async () => {
  const port = await freePort();
  // Nothing is there: the answer is null, and the caller edits the files.
  assert.equal(await tryDesktopRpc('apply', {}, { port }), null, 'no backend, no answer');
});

test('the CLI takes the backend\'s answer when it is ok', async () => {
  const port = await freePort();
  const backend = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, result: { written: 2 } }));
  });
  await new Promise((r) => backend.listen(port, '127.0.0.1', r));
  try {
    const done = await tryDesktopRpc('apply', {}, { port });
    assert.equal(done.ok, true);
    assert.deepEqual(done.result, { written: 2 });
  } finally {
    backend.close();
  }
});

/* The real backend factory, imported once so the busy-port case can build a
   server that genuinely tries to bind the port that is already taken. */
test('the launcher starts the backend and says where it is', async () => {
  const port = await freePort();
  // The bridge the launcher starts binds AIPASS_PORT — the suite's own port,
  // never the developer's.
  const bridgePort = await freePort();
  const lines = [];
  const done = await runLauncher({
    repo,
    port,
    root: tempDir(),
    bridgeUrl: `http://127.0.0.1:${bridgePort}`,
    createRpc,
    env: {
      ...process.env,
      AIPASS_PORT: String(bridgePort),
      AIPASS_DESKTOP_NO_OPEN: '1',
    },
    out: { write: (s) => lines.push(s) },
    err: { write: (s) => lines.push(s) },
  });
  try {
    assert.equal(done.adopted, false, 'the launcher started the backend');
    const said = lines.join('');
    assert.ok(said.includes('aipass desktop'), 'it announces itself');
    assert.ok(said.includes(`app     http://127.0.0.1:${port}`), `it names the address: ${said}`);
    // And the window it would have opened is really serving.
    const home = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(home.status, 200, 'the window is served');
  } finally {
    done.rpc?.server.close(); done.rpc?.server.closeAllConnections?.();
    done.bridge?.kill('SIGKILL');
  }
});
