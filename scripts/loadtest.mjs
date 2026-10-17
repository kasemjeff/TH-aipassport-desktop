#!/usr/bin/env node
// Local-API load smoke: fire concurrent RPC calls at an in-process backend and
// report latency plus memory movement.
//
// Not a soak test and not wired into CI: it answers "did this change make the
// window's backend slower or leakier", run by hand before a release and after
// touching rpc.mjs / session.mjs / tools.mjs.
//
//   npm run loadtest
//   npm run loadtest -- --calls 2000 --concurrency 50
//   npm run loadtest -- --strict        # exit 1 when a threshold is crossed
//
// The limits are loose on purpose: without --expose-gc, RSS counts memory the
// collector has not returned yet, and this process is both client and server.
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRpc } from '../aipass-bridge/harness/rpc.mjs';
import { authHeaders } from '../aipass-bridge/harness/authtoken.mjs';
import { Settings } from '../aipass-bridge/harness/settings.mjs';
import { SessionStore } from '../aipass-bridge/harness/session.mjs';

const argv = process.argv.slice(2);
const has = (name) => argv.includes(`--${name}`);
const flag = (name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? fallback : argv[at + 1];
};

if (has('help')) {
  console.log('usage: npm run loadtest -- [--calls N] [--concurrency N] [--strict] [--p95 MS] [--rss MB]');
  console.log('  --calls N        total requests (default 400)');
  console.log('  --concurrency N  requests in flight (default 25)');
  console.log('  --strict         exit 1 when p95, RSS growth or a failure crosses its limit');
  console.log('  --p95 MS         p95 latency limit for --strict (default 250)');
  console.log('  --rss MB         RSS-growth limit for --strict (default 150)');
  process.exit(0);
}

const CALLS = Math.max(1, Number(flag('calls', 400)) || 400);
const CONCURRENCY = Math.max(1, Number(flag('concurrency', 25)) || 25);
const STRICT = has('strict');
const P95_LIMIT_MS = Math.max(1, Number(flag('p95', 250)) || 250);
const RSS_LIMIT_MB = Math.max(1, Number(flag('rss', 150)) || 150);
const METHODS = ['settings.get', 'projects.list', 'session.list'];

// A throwaway home and root: nothing here may touch the real ~/.aipass. Auth is
// left ON — the load path should be the real one, token and all.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aipass-loadtest-home-'));
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'aipass-loadtest-root-'));
process.env.AIPASS_HOME = HOME;
process.env.AIPASS_REQUIRE_AUTH = '1';

const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.once('error', reject);
  srv.listen(0, '127.0.0.1', () => {
    const port = srv.address().port;
    srv.close(() => resolve(port));
  });
});

const port = await freePort();
const rpc = createRpc({
  port,
  root: ROOT,
  bridgeURL: `http://127.0.0.1:${await freePort()}`,
  autostartBridge: false,
  store: new SessionStore(path.join(HOME, 'sessions')),
  settings: new Settings(HOME, 'settings.json'),
});

const auth = authHeaders(HOME);
const latency = [];
let failures = 0;

const oneCall = async (method) => {
  const started = performance.now();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth },
      body: JSON.stringify({ method, params: {} }),
    });
    const body = await res.json();
    if (!body.ok) failures += 1;
  } catch {
    failures += 1;
  }
  latency.push(performance.now() - started);
};

/** Fire `total` jobs with at most `width` in flight, like a busy window. */
const pool = async (total, width, worker) => {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(width, total) }, async () => {
    while (next < total) {
      const i = next++;
      await worker(i);
    }
  }));
};

const before = process.memoryUsage();
const wallStart = performance.now();
await pool(CALLS, CONCURRENCY, (i) => oneCall(METHODS[i % METHODS.length]));
const wallMs = performance.now() - wallStart;
global.gc?.();
const after = process.memoryUsage();

const sorted = latency.slice().sort((a, b) => a - b);
const at = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
const toMb = (n) => n / (1024 * 1024);

console.log(`aipass loadtest — ${CALLS} calls, ${CONCURRENCY} in flight, methods: ${METHODS.join(', ')}`);
console.log(`latency   p50 ${at(0.5).toFixed(1)}ms · p95 ${at(0.95).toFixed(1)}ms · max ${sorted.at(-1).toFixed(1)}ms · wall ${(wallMs / 1000).toFixed(2)}s`);
console.log(`failures  ${failures}/${CALLS}`);
console.log(`memory    rss ${toMb(after.rss - before.rss) >= 0 ? '+' : ''}${toMb(after.rss - before.rss).toFixed(1)} MB `
  + `(${toMb(before.rss).toFixed(0)} → ${toMb(after.rss).toFixed(0)}) · heap +${toMb(after.heapUsed - before.heapUsed).toFixed(1)} MB`);

const breaches = [];
if (at(0.95) > P95_LIMIT_MS) breaches.push(`p95 ${at(0.95).toFixed(1)}ms > ${P95_LIMIT_MS}ms`);
if (after.rss - before.rss > RSS_LIMIT_MB * 1024 * 1024) breaches.push(`rss +${toMb(after.rss - before.rss).toFixed(1)}MB > ${RSS_LIMIT_MB}MB`);
if (failures) breaches.push(`${failures} failed request(s)`);
console.log(`verdict   ${breaches.length ? `watch: ${breaches.join(' · ')}` : `ok (limits p95 ${P95_LIMIT_MS}ms, rss +${RSS_LIMIT_MB}MB)`}`);

await new Promise((resolve) => rpc.server.close(resolve));
fs.rmSync(HOME, { recursive: true, force: true });
fs.rmSync(ROOT, { recursive: true, force: true });
if (STRICT && breaches.length) process.exit(1);
