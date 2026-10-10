#!/usr/bin/env node
// aipass desktop — the entry point the window (or the browser, until the
// Tauri shell exists) starts.
//
// It owns exactly two things:
//   1. the bridge, started if it is not already running, so nobody has to keep
//      a second terminal open for a logged-in browser tab
//   2. the harness backend (`/rpc` + `/events`), which the window talks to
//
// Everything else — sessions, permissions, diffs, compaction — is the harness's
// business, shared unchanged with `aipass agent`.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRpc } from '../aipass-bridge/harness/rpc.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const BRIDGE_URL = process.env.AIPASS_BRIDGE ?? 'http://127.0.0.1:8787';
const PORT = Number(process.env.AIPASS_DESKTOP_PORT ?? 8790);

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};
const ROOT = path.resolve(arg('root', process.cwd()));

const bridgeUp = () => fetch(`${BRIDGE_URL}/status`, { signal: AbortSignal.timeout(1200) })
  .then((r) => r.ok)
  .catch(() => false);

const backendUp = () => fetch(`http://127.0.0.1:${PORT}/rpc`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ method: 'status' }), signal: AbortSignal.timeout(1200),
}).then((r) => r.ok).catch(() => false);

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// `--detach` starts the backend and exits. That is what `tauri dev` needs: it
// waits for the dev URL to answer before it launches the window, and the window
// (in dev) adopts the backend this leaves running instead of starting a second.
const DETACH = process.argv.slice(2).includes('--detach');

async function ensureBridge({ detached = false, log = null } = {}) {
  if (await bridgeUp()) return null;
  const child = spawn(process.execPath, [path.join(REPO, 'aipass-bridge', 'bridge', 'server.mjs')], {
    cwd: ROOT,
    stdio: detached ? ['ignore', log, log] : ['ignore', 'pipe', 'pipe'],
    env: process.env,
    detached,
  });
  if (!detached) {
    child.stdout.on('data', (d) => process.stdout.write(`[bridge] ${d}`));
    child.stderr.on('data', (d) => process.stderr.write(`[bridge] ${d}`));
  }
  for (let i = 0; i < 40; i++) {
    await wait(250);
    if (await bridgeUp()) return child;
  }
  process.stderr.write(`bridge did not come up at ${BRIDGE_URL}\n`);
  return child;
}

if (DETACH) {
  // `--detach` starts the bridge and the backend as their own processes and
  // exits. That is what `tauri dev` needs: it waits for the dev URL to answer
  // before it launches the window, and the window then adopts what is already
  // running rather than starting a second backend. Everything lands in
  // ~/.aipass/logs, so a detach that misbehaves is still diagnosable.
  const logDir = path.join(os.homedir(), '.aipass', 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const log = fs.openSync(path.join(logDir, 'desktop-backend.log'), 'a');
  const bridge = await ensureBridge({ detached: true, log });
  const backend = spawn(process.execPath, [path.join(REPO, 'aipass-bridge', 'harness', 'rpc.mjs'), '--port', String(PORT), '--root', ROOT], {
    cwd: ROOT,
    stdio: ['ignore', log, log],
    env: process.env,
    detached: true,
  });
  backend.unref();
  fs.closeSync(log); // the child has its own handle; leaving ours open trips libuv on exit
  for (let i = 0; i < 60 && !(await backendUp()); i++) await wait(250);
  if (await backendUp()) {
    process.stdout.write(`aipass backend detached on http://127.0.0.1:${PORT} (bridge ${bridge ? 'started' : 'already running'})\n`);
  } else {
    process.stderr.write(`backend did not come up on ${PORT} — see ${path.join(logDir, 'desktop-backend.log')}\n`);
    process.exitCode = 1;
  }
  bridge?.unref();
  // let the loop drain; an exit() here trips a libuv assertion on Windows
} else {
  const rpc = createRpc({ port: PORT, root: ROOT });

  const bridge = await ensureBridge();
  process.stdout.write(`aipass desktop\n`);
  process.stdout.write(`  root    ${ROOT}\n`);
  process.stdout.write(`  bridge  ${BRIDGE_URL}${bridge ? ' (started)' : ' (already running)'}\n`);
  process.stdout.write(`  app     ${rpc.url}\n`);
  process.stdout.write(`\nOpen ${rpc.url} in Chrome — or later, the packaged window.\n`);

  if (!process.env.AIPASS_DESKTOP_NO_OPEN) {
    const url = rpc.url;
    const open = async () => {
      try {
        const { default: opener } = await import('node:child_process');
        if (process.platform === 'win32') opener(`cmd /c start "" "${url}"`);
        else if (process.platform === 'darwin') opener(`open ${url}`);
        else opener(`xdg-open ${url}`);
      } catch { /* a headless start is fine too */ }
    };
    await open();
  }

  const shutdown = () => {
    rpc.server.close();
    bridge?.kill();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
