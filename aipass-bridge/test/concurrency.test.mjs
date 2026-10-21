// Concurrent requests: the window fires several RPC calls at once (snapshot,
// session list, settings) and a burst must not interleave into half-written
// state. Two pins — many parallel reads answer consistently, and parallel
// session creation loses none of the files. The heavier, measurable version of
// this is `npm run loadtest`; that one is run by hand, this one by CI.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { freePort, tempDir, startRpcServer } from './harness.mjs';

import { Settings } from '../harness/settings.mjs';

// Same rule as the other suites: nothing may touch the real ~/.aipass.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aipass-concurrency-home-'));
process.env.AIPASS_HOME = HOME;
after(() => fs.rmSync(HOME, { recursive: true, force: true }));

async function startBackend() {
  const rpc = await startRpcServer({
    root: tempDir(),
    bridgeURL: `http://127.0.0.1:${await freePort()}`,
    autostartBridge: false,
    store: tempDir(),
    settings: new Settings(tempDir(), 'settings.json'),
  });
  const port = rpc.port;
  const call = async (method, params = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method, params }),
    });
    const body = await res.json();
    if (!body.ok) throw new Error(body.error);
    return body.result;
  };
  return { rpc, call };
}

test('40 parallel reads all answer with the same settings object', async (t) => {
  const env = await startBackend();
  t.after(() => env.rpc.server.close());

  const out = await Promise.all(Array.from({ length: 40 }, () => env.call('settings.get')));
  assert.equal(out.length, 40);
  for (const settings of out) assert.deepEqual(settings, out[0], 'every reader sees one shape');
  assert.equal(typeof out[0].maxSteps, 'number');
});

test('24 parallel session.new calls all land and the listing has no duplicates', async (t) => {
  const env = await startBackend();
  t.after(() => env.rpc.server.close());

  const created = await Promise.all(
    Array.from({ length: 24 }, (_, i) => env.call('session.new', { title: `burst-${i}` })),
  );
  assert.equal(created.length, 24);
  for (const meta of created) assert.ok(meta?.id, 'every creation answered with an id');

  const listed = await env.call('session.list');
  const ids = new Set(listed.map((m) => m.id));
  for (const meta of created) assert.ok(ids.has(meta.id), `session ${meta.id} survived the burst`);
  assert.equal(ids.size, listed.length, 'no duplicate rows in the listing');
});
