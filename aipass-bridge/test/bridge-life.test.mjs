// The bridge's own life: it is a background process, so it has to end itself.
//
// The bridge is started DETACHED by the CLI and by the desktop backend, and a
// detached process outlives whatever started it. That is right — a CLI that
// starts the bridge must not take it down when it exits — and it is also how
// one machine ended up with seventy bridges alive at once, each holding sixty
// megabytes, with nothing left that could stop any of them.
//
// These tests pin the two things that make the pile impossible to build:
// the bridge records its own pid (so something can reach it), and it goes
// away when nobody is using it (so nothing has to).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, '..', 'bridge', 'server.mjs');

const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aipass-bridge-life-'));

/** A port the OS hands out and nobody else claims. */
const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.on('error', reject);
  srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});

/**
 * Start the bridge the way the desktop starts it: detached, on a port of its
 * own, with its own home — so its pid file is its own.
 */
function startDetachedBridge({ home, port, idleMs }) {
  const pidFile = path.join(home, 'bridge.pid');
  const child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      AIPASS_HOME: home,
      AIPASS_PORT: String(port),
      AIPASS_BRIDGE_IDLE_MS: String(idleMs),
      AIPASS_REQUIRE_AUTH: '0',
      // The suite points the pid file at its own, so every bridge the suite
      // starts is reachable at the end of the run. This one is the test's
      // own, and it says so — otherwise the test would be reading (and
      // overwriting) the suite's file.
      AIPASS_BRIDGE_PIDFILE: pidFile,
    },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = [];
  child.stdout.on('data', (d) => log.push(String(d)));
  child.stderr.on('data', (d) => log.push(String(d)));
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  return { child, pidFile, log, logText: () => log.join(''), exited };
}

const waitFor = async (check, { timeout = 5000, every = 50 } = {}) => {
  const until = Date.now() + timeout;
  for (;;) {
    if (await check()) return true;
    if (Date.now() > until) return false;
    await new Promise((r) => setTimeout(r, every));
  }
};

test('the bridge records its own pid, and the file names the process that is answering', async (t) => {
  const home = scratch();
  const port = await freePort();
  const bridge = startDetachedBridge({ home, port, idleMs: 600_000 });
  t.after(() => { try { bridge.child.kill('SIGKILL'); } catch { /* gone */ } fs.rmSync(home, { recursive: true, force: true }); });

  const wrote = await waitFor(() => fs.existsSync(bridge.pidFile));
  assert.ok(wrote, 'the bridge wrote its pid file');
  const pids = fs.readFileSync(bridge.pidFile, 'utf8').split('\n').map((l) => Number(l.trim())).filter(Boolean);
  assert.ok(pids.includes(bridge.child.pid), 'and the file names the process that is really answering');
});

test('a bridge nobody is using goes away, and takes its pid file with it', async (t) => {
  const home = scratch();
  const port = await freePort();
  // A window of two seconds, so the test does not have to wait ten minutes
  // for the real window to be honest about what it means.
  const bridge = startDetachedBridge({ home, port, idleMs: 2000 });
  t.after(() => { try { bridge.child.kill('SIGKILL'); } catch { /* gone */ } fs.rmSync(home, { recursive: true, force: true }); });

  const code = await Promise.race([
    bridge.exited,
    new Promise((r) => setTimeout(() => r('still running'), 15_000)),
  ]);
  assert.notEqual(code, 'still running', 'the bridge ended itself');
  assert.equal(code, 0, 'and it ended cleanly, not as a crash');
  assert.match(bridge.logText(), /idle for \d+s/, 'the log says why it went');
  assert.equal(fs.existsSync(bridge.pidFile), false, 'and the pid file went with it');
});

test('a bridge that is being used stays', async (t) => {
  const home = scratch();
  const port = await freePort();
  const bridge = startDetachedBridge({ home, port, idleMs: 2000 });
  t.after(() => { try { bridge.child.kill('SIGKILL'); } catch { /* gone */ } fs.rmSync(home, { recursive: true, force: true }); });

  const answered = await waitFor(async () => {
    const res = await fetch(`http://127.0.0.1:${port}/status`).catch(() => null);
    return Boolean(res?.ok);
  });
  assert.ok(answered, 'the bridge is answering');

  // The window asks for the credits every ten seconds, and the extension
  // holds its event stream open on a four-minute cycle — so a bridge in use
  // is never idle for long. One request has to be enough to prove the point
  // here: the idle window is two seconds, and the request pushes the
  // deadline past it.
  await fetch(`http://127.0.0.1:${port}/status`);
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(bridge.child.exitCode, null, 'the bridge is still up after a request');
});
