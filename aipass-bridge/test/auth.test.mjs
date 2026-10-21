// The loopback bearer gate (authtoken.mjs): unauthenticated loopback callers
// get 401 on everything except the health probes; the token mints once per
// AIPASS_HOME and AIPASS_TOKEN overrides it. The rest of the suite runs with
// AIPASS_REQUIRE_AUTH=0 (see test/harness.mjs) — this file is where the gate
// itself is pinned, with the gate explicitly on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startBridge, freePort, tempDir, startRpcServer } from './harness.mjs';

import { Settings } from '../harness/settings.mjs';
import { loadOrMintToken, authorized, tokenPath } from '../harness/authtoken.mjs';

const mkhome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aipass-auth-'));

// Bridge with the gate on and a fixed token: every route is exercised.
test('bridge: health probes stay open, everything else needs the token', async () => {
  const home = mkhome();
  const token = 'test-token-' + '0'.repeat(53);
  const bridge = await startBridge({ AIPASS_HOME: home, AIPASS_TOKEN: token, AIPASS_REQUIRE_AUTH: '1' });
  try {
    const H = { authorization: `Bearer ${token}` };
    // Open without any header.
    assert.equal(await fetch(`${bridge.base}/status`).then((r) => r.status), 200);
    assert.equal(await fetch(`${bridge.base}/health`).then((r) => r.status), 200);
    // Gated without a header.
    for (const [method, p, body] of [
      ['GET', '/v1/models', null], ['GET', '/quota', null], ['GET', '/conversations', null],
      ['POST', '/config', {}], ['POST', '/v1/chat/completions', {}],
      ['GET', '/ext/events', null], ['POST', '/ext/chunk', {}],
    ]) {
      const r = await fetch(`${bridge.base}${p}`, {
        method, ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
      });
      assert.equal(r.status, 401, `${method} ${p} must refuse a tokenless caller`);
    }
    // Wrong token is still 401.
    const bad = await fetch(`${bridge.base}/v1/models`, { headers: { authorization: 'Bearer wrong' } });
    assert.equal(bad.status, 401);
    // Right token opens the gated routes.
    for (const [method, p, body] of [
      ['GET', '/v1/models', null], ['GET', '/quota', null],
      ['POST', '/config', {}],
    ]) {
      const r = await fetch(`${bridge.base}${p}`, {
        method, headers: { ...H, ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      assert.ok(r.status !== 401, `${method} ${p} must accept the token (got ${r.status})`);
    }
  } finally { bridge.stop(); }
});

// The extension that never got the token is the quietest failure there is:
// it retries every three seconds, every retry is a 401, and `/status` says
// only `extensions: 0`. The bridge has to name the remedy, or the reader
// cannot tell a missing extension from a missing token.
test('bridge: a tokenless extension is told what to do', async () => {
  const home = mkhome();
  const bridge = await startBridge({ AIPASS_HOME: home, AIPASS_REQUIRE_AUTH: '1' });
  try {
    const r = await fetch(`${bridge.base}/ext/events`, { headers: { accept: 'text/event-stream' } });
    assert.equal(r.status, 401, 'the extension stream stays closed without the token');
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !/loopback token/.test(bridge.logText())) {
      await new Promise((r2) => setTimeout(r2, 25));
    }
    assert.match(bridge.logText(), /no loopback token/, 'the bridge says why');
    assert.match(bridge.logText(), /\.aipass\/\.token/, 'and where the token is');
  } finally { bridge.stop(); }
});

// File minting: no AIPASS_TOKEN — the token file mints at boot in ~/.aipass/.
test('bridge: token file mints at boot with owner-only intent', async () => {
  const home = mkhome();
  const file = path.join(home, '.token');
  assert.ok(!fs.existsSync(file), 'no token file before boot');
  const bridge = await startBridge({ AIPASS_HOME: home, AIPASS_REQUIRE_AUTH: '1' });
  try {
    assert.ok(fs.existsSync(file), 'boot mints the token file');
    const saved = fs.readFileSync(file, 'utf8').trim();
    assert.match(saved, /^[0-9a-f]{64}$/, 'minted token is 256-bit hex');
    assert.equal(await fetch(`${bridge.base}/v1/models`).then((r) => r.status), 401);
    const r2 = await fetch(`${bridge.base}/v1/models`, { headers: { authorization: `Bearer ${saved}` } });
    assert.ok(r2.status !== 401, `minted token must open the gate (got ${r2.status})`);
  } finally { bridge.stop(); }
});

// RPC backend, in-process like hardening.test.mjs: /rpc gated, /token is
// same-origin-browser-only, /events accepts the query form for EventSource.
test('rpc: /rpc gated, /token is same-origin-browser-only', async () => {
  const home = mkhome();
  const token = 'rpc-token-' + '1'.repeat(54);
  const port = await freePort();
  const prevToken = process.env.AIPASS_TOKEN;
  const prevFlag = process.env.AIPASS_REQUIRE_AUTH;
  process.env.AIPASS_TOKEN = token;
  process.env.AIPASS_REQUIRE_AUTH = '1';
  let rpc = null;
  try {
    rpc = await startRpcServer({
      root: tempDir(), bridgeURL: `http://127.0.0.1:${await freePort()}`,
      autostartBridge: false, store: tempDir(), settings: new Settings(tempDir(), 'settings.json'),
    });
    const port = rpc.port;
    const base = `http://127.0.0.1:${port}`;
    const call = (headers = {}) => fetch(`${base}/rpc`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ method: 'status' }),
    }).then((r) => r.status);
    assert.equal(await call(), 401, 'tokenless /rpc must 401');
    assert.equal(await call({ authorization: 'Bearer nope' }), 401, 'wrong token must 401');
    assert.equal(await call({ authorization: `Bearer ${token}` }), 200, 'right token must pass');
    // Bootstrap: headerless tool-like caller is refused (it reads the file).
    assert.equal(await fetch(`${base}/token`).then((r) => r.status), 403);
    // Same-origin browser page gets the token.
    const boot = await fetch(`${base}/token`, {
      headers: { 'sec-fetch-site': 'same-origin', origin: base },
    }).then((r) => r.json());
    assert.equal(boot.token, token, 'bootstrap hands the active token to same-origin pages');
    // Cross-origin page is refused even though it is a browser.
    const cross = await fetch(`${base}/token`, {
      headers: { 'sec-fetch-site': 'cross-site', origin: 'https://evil.test' },
    }).then((r) => r.status);
    assert.equal(cross, 403);
    // The bootstrapped token opens /events in the EventSource query form. The
    // stream never ends on its own — cancel it after the status check, or the
    // close() below waits on this live connection (7 s on Windows, 16 s on
    // Ubuntu 22, and on the Node 24 runners it never resolved; desktop.test.mjs
    // cancels for the same reason).
    const stream = await fetch(`${base}/events?token=${token}`);
    assert.equal(stream.status, 200);
    await stream.body.cancel();
    const denied = await fetch(`${base}/events`);
    assert.equal(denied.status, 401);
    await denied.body.cancel();
  } finally {
    if (prevToken === undefined) delete process.env.AIPASS_TOKEN; else process.env.AIPASS_TOKEN = prevToken;
    if (prevFlag === undefined) delete process.env.AIPASS_REQUIRE_AUTH; else process.env.AIPASS_REQUIRE_AUTH = prevFlag;
    // Keep-alive sockets from the fetches above would still hold close() for
    // the server's 5 s idle timeout; the test is done — drop them now.
    rpc?.server.closeAllConnections?.();
    await new Promise((resolve) => rpc?.server.close(resolve));
  }
});

// Escape hatch: explicit opt-out restores the old loopback-only surface.
test('bridge: AIPASS_REQUIRE_AUTH=0 leaves the loopback surface as before', async () => {
  const bridge = await startBridge({ AIPASS_HOME: mkhome(), AIPASS_REQUIRE_AUTH: '0' });
  try {
    const r = await fetch(`${bridge.base}/v1/models`);
    assert.ok(r.status !== 401, `gate must be off under the escape hatch (got ${r.status})`);
  } finally { bridge.stop(); }
});

// The escape hatch and the SHARED default port are the one combination that
// leaves the account reachable by any web page: a cross-origin "simple"
// request needs no preflight, so the browser sends it and the bridge acts on
// it. The port is the only thing a web page can guess, so a no-token bridge
// on any other port is fine — and on 8787 it is refused.
test('bridge: the no-token mode refuses the shared default port', async () => {
  const { spawn } = await import('node:child_process');
  const { SERVER } = await import('./harness.mjs');
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, AIPASS_REQUIRE_AUTH: '0', AIPASS_PORT: '8787', AIPASS_HOME: mkhome() },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const code = await new Promise((resolve) => {
    child.on('close', resolve);
    setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } resolve('timeout'); }, 8000);
  });
  assert.notEqual(code, 'timeout', 'the bridge did not start');
  assert.notEqual(code, 0, 'it refused to start');
  assert.match(out, /refusing to serve 8787/, 'and it said why');
});

// Revocation, the desktop way: the token file *is* the credential. Deleting
// it (or `~/.aipass` whole) revokes the token — the next read mints a fresh
// one, and the deleted token stops opening anything.
test('deleting the token file revokes it — the next load mints a different one', () => {
  const home = mkhome();
  const prevToken = process.env.AIPASS_TOKEN;
  const prevFlag = process.env.AIPASS_REQUIRE_AUTH;
  delete process.env.AIPASS_TOKEN;
  process.env.AIPASS_REQUIRE_AUTH = '1';
  try {
    const req = (t) => ({ headers: { authorization: `Bearer ${t}` } });
    const first = loadOrMintToken(home);
    assert.match(first, /^[0-9a-f]{64}$/, 'minted token is 256-bit hex');
    assert.equal(authorized(req(first), home), true, 'the minted token authorizes');

    fs.rmSync(tokenPath(home));
    assert.equal(authorized(req(first), home), false, 'the deleted token is dead at once');

    const second = loadOrMintToken(home);
    assert.notEqual(second, first, 'a fresh token is minted');
    assert.equal(authorized(req(second), home), true);
    assert.equal(authorized(req(first), home), false, 'the old one stays dead');
  } finally {
    if (prevToken === undefined) delete process.env.AIPASS_TOKEN; else process.env.AIPASS_TOKEN = prevToken;
    if (prevFlag === undefined) delete process.env.AIPASS_REQUIRE_AUTH; else process.env.AIPASS_REQUIRE_AUTH = prevFlag;
  }
});

// Windows' clock is coarse enough that delete + mint can land in the same
// tick: the recreated file reports the same mtime:size stamp the memo holds.
// That collision made the check answer "no" to the token the file itself had
// just been given (the 2026-10-17 Windows flake) — the disk must win.
test('a recreated token file with a colliding stamp is still the file, not the memo', () => {
  const home = mkhome();
  const prevToken = process.env.AIPASS_TOKEN;
  const prevFlag = process.env.AIPASS_REQUIRE_AUTH;
  delete process.env.AIPASS_TOKEN;
  process.env.AIPASS_REQUIRE_AUTH = '1';
  try {
    const req = (t) => ({ headers: { authorization: `Bearer ${t}` } });
    const first = loadOrMintToken(home);
    // Normalize to a whole second first, so the same utimes input below lands
    // on bit-identical stamps for both files.
    const whole = Math.floor(Date.now() / 1000);
    fs.utimesSync(tokenPath(home), whole, whole);
    const stamp = fs.statSync(tokenPath(home)).mtimeMs;
    assert.equal(authorized(req(first), home), true, 'and fills the memo with that stamp');

    fs.rmSync(tokenPath(home));
    const second = loadOrMintToken(home);
    assert.notEqual(second, first, 'the delete minted a fresh token');
    fs.utimesSync(tokenPath(home), stamp / 1000, stamp / 1000); // the collision the tick would cause
    assert.equal(fs.statSync(tokenPath(home)).mtimeMs, stamp, 'the fixture reproduces the colliding stamp');
    assert.equal(loadOrMintToken(home), second, 'the file is the truth when the stamp collides');
    assert.equal(authorized(req(second), home), true, 'and the new token is what authorizes');
  } finally {
    if (prevToken === undefined) delete process.env.AIPASS_TOKEN; else process.env.AIPASS_TOKEN = prevToken;
    if (prevFlag === undefined) delete process.env.AIPASS_REQUIRE_AUTH; else process.env.AIPASS_REQUIRE_AUTH = prevFlag;
  }
});
