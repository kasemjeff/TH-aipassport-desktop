// launcher.mjs — the desktop launcher's rules, in one place.
//
// The launcher (desktop/main.mjs) does two things: start the bridge if it is
// not running, and start — or adopt — the harness backend the window talks to.
// Both lived in the entry script, and an entry script runs its top level on
// import: the one file that decides which backend the window talks to was the
// one file a test could not touch.
//
// So the rules live here, and the entry script keeps only what only it can do
// (find the code in whichever layout it was started from) and calls in.
//
// Everything here is a plain function with the side effects behind parameters,
// so a test can drive the whole launcher without a window, a browser or the
// developer's own ports.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { openBrowser } from './browser.mjs';
import { authHeaders } from './authtoken.mjs';
import { backendIsUp as probeBackend } from './backend-probe.mjs';
import { openLogFile } from './log-file.mjs';
import { aipassHome } from './settings.mjs';

/** The default port the desktop backend binds. */
export const DEFAULT_DESKTOP_PORT = 8790;

/**
 * The port the desktop backend binds.
 *
 * The port has to be a PORT. `0` means "any free port" to Node and "nothing"
 * to the Tauri shell, which opens http://127.0.0.1:0/ — a window with nothing
 * behind it. An empty value was worse: `Number('')` is 0, so the shell read
 * 8790 and this side bound a random port, and the two never met. A value
 * that is not a number at all reaches `listen()` as NaN and throws there.
 *
 * The digits are decimal only, the way the shell parses it: `Number` reads
 * "0x50" as 80 and "1e3" as 1000, and the shell refuses both — one side
 * taking a port the other refused is how the window ends up on a port
 * nothing is listening on.
 */
export function resolveDesktopPort(env = process.env) {
  const raw = (env.AIPASS_DESKTOP_PORT ?? '').trim();
  if (!raw) return DEFAULT_DESKTOP_PORT;
  if (!/^\+?\d+$/.test(raw)) {
    throw new Error(`AIPASS_DESKTOP_PORT is not a port: ${raw}`);
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`AIPASS_DESKTOP_PORT is not a port: ${raw}`);
  }
  return n;
}

/**
 * The project the backend serves.
 *
 * `--root` names it; without one it is the folder the launcher was started
 * in. It is resolved, so a relative path means the same thing to the backend
 * as it does to the person who typed it.
 */
export function resolveRoot(argv = process.argv, cwd = process.cwd()) {
  const i = argv.indexOf('--root');
  const raw = i === -1 ? cwd : argv[i + 1];
  return path.resolve(cwd, raw ?? cwd);
}

/** Was `--detach` asked for? That is the mode `tauri dev` starts the backend in. */
export function wantsDetach(argv = process.argv) {
  return argv.slice(2).includes('--detach');
}

/** Sleep, so a poll does not spin the CPU while it waits. */
export const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Is the bridge answering? Its /status is the one route that needs no token. */
export async function bridgeIsUp(bridgeUrl, { timeout = 1200 } = {}) {
  return fetch(`${bridgeUrl}/status`, { signal: AbortSignal.timeout(timeout) })
    .then((r) => r.ok)
    .catch(() => false);
}

/** Is our backend answering on this port? The probe knows what "ours" is. */
export async function backendIsUp(port, { env = process.env } = {}) {
  return probeBackend(port, { headers: authHeaders() });
}

/**
 * Open the window in Chrome — the browser the extension lives in — unless told
 * not to.
 *
 * One rule for both surfaces that open a URL (this launcher and the backend's
 * browser.open): which browser, which argv, and the bookkeeping that lets a
 * test close what it opened. The old `cmd /c start "" "${url}"` interpolated,
 * and its `default` from node:child_process is a module object, not a
 * callable, so the throw was swallowed and no window ever opened.
 */
export async function openWindow(url, { env = process.env } = {}) {
  if (env.AIPASS_DESKTOP_NO_OPEN) return false;
  return openBrowser(url, { env });
}

/**
 * The bridge, started if it is not already running.
 *
 * Nobody should have to keep a second terminal open for a logged-in browser
 * tab. Returns the child it started, or null when the bridge was already up.
 */
export async function ensureBridge({
  repo,
  root,
  bridgeUrl,
  detached = false,
  log = null,
  env = process.env,
  out = process.stdout,
  err = process.stderr,
  attempts = 40,
  every = 250,
} = {}) {
  if (await bridgeIsUp(bridgeUrl)) return null;
  const child = spawn(process.execPath, [path.join(repo, 'aipass-bridge', 'bridge', 'server.mjs')], {
    cwd: root,
    stdio: detached ? ['ignore', log, log] : ['ignore', 'pipe', 'pipe'],
    env,
    detached,
  });
  if (!detached) {
    child.stdout.on('data', (d) => out.write(`[bridge] ${d}`));
    child.stderr.on('data', (d) => err.write(`[bridge] ${d}`));
  }
  for (let i = 0; i < attempts; i++) {
    await wait(every);
    if (await bridgeIsUp(bridgeUrl)) return child;
  }
  err.write(`bridge did not come up at ${bridgeUrl}\n`);
  return child;
}

/**
 * The detached mode: start the bridge and the backend as their own processes
 * and exit.
 *
 * That is what `tauri dev` needs: it waits for the dev URL to answer before
 * it launches the window, and the window then adopts what is already running
 * rather than starting a second backend. Everything lands in ~/.aipass/logs,
 * so a detach that misbehaves is still diagnosable.
 */
export async function detachBackend({
  repo,
  port,
  root,
  bridgeUrl,
  env = process.env,
  out = process.stdout,
  err = process.stderr,
  attempts = 60,
  every = 250,
} = {}) {
  // The home the logs land in is the one this run was given, not the one the
  // process happens to have: a caller that steers the home steers the logs
  // with it.
  const home = env.AIPASS_HOME?.trim() || aipassHome();
  const logDir = path.join(home, 'logs');
  const log = openLogFile(path.join(logDir, 'desktop-backend.log'));
  const bridge = await ensureBridge({ repo, root, bridgeUrl, detached: true, log, env });
  const backend = spawn(process.execPath, [path.join(repo, 'aipass-bridge', 'harness', 'rpc.mjs'), '--port', String(port), '--root', root], {
    cwd: root,
    stdio: ['ignore', log, log],
    env,
    detached: true,
  });
  backend.unref();
  fs.closeSync(log); // the child has its own handle; leaving ours open trips libuv on exit
  for (let i = 0; i < attempts && !(await backendIsUp(port, { env })); i++) await wait(every);
  if (await backendIsUp(port, { env })) {
    out.write(`aipass backend detached on http://127.0.0.1:${port} (bridge ${bridge ? 'started' : 'already running'})\n`);
    return { ok: true, bridge, backend, logDir };
  }
  err.write(`backend did not come up on ${port} — see ${path.join(logDir, 'desktop-backend.log')}\n`);
  return { ok: false, bridge, backend, logDir };
}

/**
 * The whole launcher, as one call.
 *
 * `createRpc` comes in from the entry script: it is the backend's own factory
 * and the entry script already holds it, so the launcher does not import the
 * backend twice.
 */
export async function runLauncher({
  repo,
  port,
  root,
  bridgeUrl,
  createRpc,
  detach = false,
  env = process.env,
  out = process.stdout,
  err = process.stderr,
  onBusy = null,
} = {}) {
  if (detach && (await backendIsUp(port, { env }))) {
    // `tauri dev` runs this before every launch; a backend that already
    // answers is the job done. Spawning another would only land EADDRINUSE
    // in the log.
    out.write(`aipass backend already running on http://127.0.0.1:${port} — leaving it alone\n`);
    return { ok: true, adopted: true };
  }
  if (detach) {
    const done = await detachBackend({ repo, port, root, bridgeUrl, env, out, err });
    if (!done.ok) process.exitCode = 1;
    done.bridge?.unref();
    // let the loop drain; an exit() here trips a libuv assertion on Windows
    return done;
  }
  if (await backendIsUp(port, { env })) {
    // The foreground path holds the same invariant: one backend per port. The
    // user is asking for the window, not for a second server — and a second
    // server dies on EADDRINUSE, which reads as "the app will not open". Adopt
    // the one that answers and hand over the window.
    out.write(`aipass desktop — a backend is already on http://127.0.0.1:${port}; opening the window against it\n`);
    await openWindow(`http://127.0.0.1:${port}`, { env });
    return { ok: true, adopted: true };
  }

  const rpc = createRpc({ port, root, bridgeURL: bridgeUrl, autostartBridge: false });
  // The backend does not start a bridge of its own: the launcher owns the
  // bridge (it is the one that says so in the banner), and two starters race
  // for the same port — the loser's bind fails on EADDRINUSE, and the loser's
  // fifteen-second poll holds the process open after the window is up.
  // The probe can still miss a server that appeared in between. If the port
  // is busy after all, name the port instead of dying with a raw stack.
  rpc.server.on('error', (launcherError) => {
    if (launcherError.code === 'EADDRINUSE') {
      err.write(`port ${port} is busy — close what holds it, or run with AIPASS_DESKTOP_PORT=<other>\n`);
      if (onBusy) onBusy(port);
      return;
    }
    throw launcherError;
  });
  // The bind is what decides whether there is a window to open, so the
  // launcher waits for it: the probe-then-bind race (another suite on this
  // machine takes the port between the probe and the bind) is then a stated
  // outcome instead of a surprise.
  const bound = await new Promise((resolve) => {
    rpc.server.once('listening', () => resolve(true));
    rpc.server.once('error', () => resolve(false));
  });
  if (!bound) {
    // The window has nothing to open. The default is to stop; a caller that
    // wants to say so itself (a test) took the branch over.
    if (!onBusy) process.exit(1);
    return { ok: false, busy: true, adopted: false };
  }

  const bridge = await ensureBridge({ repo, root, bridgeUrl, env, out, err });
  out.write(`aipass desktop\n`);
  out.write(`  root    ${root}\n`);
  out.write(`  bridge  ${bridgeUrl}${bridge ? ' (started)' : ' (already running)'}\n`);
  out.write(`  app     ${rpc.url}\n`);
  out.write(`\nOpen ${rpc.url} in Chrome — or later, the packaged window.\n`);

  await openWindow(rpc.url, { env });

  const shutdown = () => {
    rpc.server.close();
    bridge?.kill();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return { ok: true, adopted: false, rpc, bridge, shutdown };
}
