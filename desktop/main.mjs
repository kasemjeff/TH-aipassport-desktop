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
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// In the repo this file is desktop/main.mjs and aipass-bridge is a sibling of
// the repo root; the packaged layout ships it beside aipass-bridge/ instead.
const REPO = fs.existsSync(path.join(HERE, 'aipass-bridge', 'bridge', 'server.mjs')) ? HERE : path.resolve(HERE, '..');
// A static relative import can only ever see one of the two layouts, so resolve
// the backend from REPO — `node main.mjs` then works from both.
const { createRpc, resolveBridgeURL } = await import(pathToFileURL(path.join(REPO, 'aipass-bridge', 'harness', 'rpc.mjs')));
// The one resolver for state, shared with the backend and the CLI, so
// AIPASS_HOME steers every surface including the detached log below.
const { aipassHome } = await import(pathToFileURL(path.join(REPO, 'aipass-bridge', 'harness', 'settings.mjs')));
// Size-capped log files, the same helper the backend uses for bridge.log.
const { openLogFile } = await import(pathToFileURL(path.join(REPO, 'aipass-bridge', 'harness', 'log-file.mjs')));
// One resolver for the probe and the harness client alike: AIPASS_BRIDGE
// (http(s)://host:port, host:port or a bare port) or the loopback default.
const BRIDGE_URL = resolveBridgeURL();
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

/** Open the window in the default browser, unless told not to. */
const openWindow = async (url) => {
  if (process.env.AIPASS_DESKTOP_NO_OPEN) return;
  const target = String(url ?? '');
  if (!/^https?:\/\//i.test(target)) return;
  try {
    // argv, not a shell string — the same shape the backend's browser.open
    // uses. The old `cmd /c start "" "${url}"` interpolated, and its
    // `default` from node:child_process is a module object, not a callable,
    // so the throw was swallowed and no window ever opened.
    const { execFile } = await import('node:child_process');
    const [cmd, args] = process.platform === 'win32'
      // '' becomes a bare "" on the command line — cmd's canonical empty
      // title for `start`, which is what keeps a URL with & from being
      // eaten as the window title.
      ? ['cmd', ['/c', 'start', '', target]]
      : process.platform === 'darwin'
        ? ['open', [target]]
        : ['xdg-open', [target]];
    await new Promise((resolve) => {
      const child = execFile(cmd, args, { windowsHide: true }, () => resolve());
      child.on('error', () => resolve());
    });
  } catch { /* a headless start is fine too */ }
};

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

if (DETACH && (await backendUp())) {
  // `tauri dev` runs this before every launch; a backend that already answers
  // is the job done. Spawning another would only land EADDRINUSE in the log.
  process.stdout.write(`aipass backend already running on http://127.0.0.1:${PORT} — leaving it alone\n`);
} else if (DETACH) {
  // `--detach` starts the bridge and the backend as their own processes and
  // exits. That is what `tauri dev` needs: it waits for the dev URL to answer
  // before it launches the window, and the window then adopts what is already
  // running rather than starting a second backend. Everything lands in
  // ~/.aipass/logs, so a detach that misbehaves is still diagnosable.
  // openLogFile makes the directory, rotates past the size cap, and appends;
  // logDir stays for the "did not come up" message below.
  const logDir = path.join(aipassHome(), 'logs');
  const log = openLogFile(path.join(logDir, 'desktop-backend.log'));
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
} else if (await backendUp()) {
  // The foreground path holds the same invariant: one backend per port. The
  // user is asking for the window, not for a second server — and a second
  // server dies on EADDRINUSE, which reads as "the app will not open". Adopt
  // the one that answers and hand over the window.
  process.stdout.write(`aipass desktop — a backend is already on http://127.0.0.1:${PORT}; opening the window against it\n`);
  await openWindow(`http://127.0.0.1:${PORT}`);
} else {
  const rpc = createRpc({ port: PORT, root: ROOT, bridgeURL: BRIDGE_URL });
  // The probe can still miss a server that appeared in between. If the port
  // is busy after all, name the port instead of dying with a raw stack.
  rpc.server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      process.stderr.write(`port ${PORT} is busy — close what holds it, or run with AIPASS_DESKTOP_PORT=<other>\n`);
      process.exit(1);
    }
    throw err;
  });

  const bridge = await ensureBridge();
  process.stdout.write(`aipass desktop\n`);
  process.stdout.write(`  root    ${ROOT}\n`);
  process.stdout.write(`  bridge  ${BRIDGE_URL}${bridge ? ' (started)' : ' (already running)'}\n`);
  process.stdout.write(`  app     ${rpc.url}\n`);
  process.stdout.write(`\nOpen ${rpc.url} in Chrome — or later, the packaged window.\n`);

  await openWindow(rpc.url);

  const shutdown = () => {
    rpc.server.close();
    bridge?.kill();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
