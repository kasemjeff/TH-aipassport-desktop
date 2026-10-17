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
import { startBridge, freePort, tempDir } from './harness.mjs';
import { createRpc } from '../harness/rpc.mjs';
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
    rpc = createRpc({
      port, root: tempDir(), bridgeURL: `http://127.0.0.1:${await freePort()}`,
      autostartBridge: false, store: tempDir(), settings: new Settings(tempDir(), 'settings.json'),
    });
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
    // The bootstrapped token opens /events in the EventSource query form.
    assert.equal(await fetch(`${base}/events?token=${token}`).then((r) => r.status), 200);
    assert.equal(await fetch(`${base}/events`).then((r) => r.status), 401);
  } finally {
    if (prevToken === undefined) delete process.env.AIPASS_TOKEN; else process.env.AIPASS_TOKEN = prevToken;
    if (prevFlag === undefined) delete process.env.AIPASS_REQUIRE_AUTH; else process.env.AIPASS_REQUIRE_AUTH = prevFlag;
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
