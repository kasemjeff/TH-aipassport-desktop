#!/usr/bin/env node
// Cross-platform entry point for the test suite.
//
// Neither obvious invocation is portable:
//
//   node --test "aipass-bridge/test/*.test.mjs"
//     Windows shells do not expand globs, and Node only learned to expand them
//     itself in v21 — so on Node 20 + Windows the literal string reaches Node
//     and it reports "Could not find '...\*.test.mjs'".
//
//   node --test aipass-bridge/test
//     Node 20 searches the directory (and also executes helpers such as
//     harness.mjs, counting them as test files), while Node 24+ instead tries
//     to load the directory as a module and fails outright.
//
// Resolving the files here and passing them explicitly behaves the same on
// every supported Node version and OS, and new *.test.mjs files are picked up
// automatically so contributors never have to remember to register one.
import { readdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// The browser the suite opened is closed with the suite: one rule, shared
// with the backend that opened it.
import { closeOpenedBrowsers } from '../aipass-bridge/harness/browser.mjs';
// The bridge the suite started is detached, so it outlives the run.
import { stopRecordedBridge } from '../aipass-bridge/harness/bridge-pid.mjs';
// The scratch space a run uses, shared with the coverage gate.
import { suiteEnv } from './suite-env.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testDir = path.join(repoRoot, 'aipass-bridge', 'test');

let entries;
try {
  entries = readdirSync(testDir);
} catch (err) {
  console.error(`cannot read ${testDir}: ${err.message}`);
  process.exit(1);
}

const files = entries
  .filter((name) => name.endsWith('.test.mjs'))
  .sort()
  .map((name) => path.join(testDir, name));

if (!files.length) {
  console.error(`no *.test.mjs files found in ${testDir}`);
  process.exit(1);
}

// The prefixes the project's own helpers create in the temp directory. Every
// scratch tree they make is meant to go with the run that made it, and the
// ones that do not (a helper that never sweeps, a run that was killed) used
// to pile up forever — 167,000 directories and 165 MB in a week of runs.
// Keep this list in step with the mkdtemp prefixes in aipass-bridge/test/*,
// scripts/* and desktop/*.
const SCRATCH_PREFIXES = [
  'aipass-aci-', 'aipass-auth-', 'aipass-chat-', 'aipass-clamp-',
  'aipass-concurrency-home-', 'aipass-credit-', 'aipass-drill-', 'aipass-eval-',
  'aipass-eval-decoy-', 'aipass-eval-results-', 'aipass-eval-task-',
  'aipass-evals-compare-', 'aipass-evals-home-', 'aipass-experiments-',
  'aipass-fixes-home-', 'aipass-gates-home-', 'aipass-hardening-home-',
  'aipass-harness-', 'aipass-integrity-', 'aipass-loadtest-home-',
  'aipass-loadtest-root-', 'aipass-meta-', 'aipass-plan-home-', 'aipass-plugin-',
  'aipass-qa-home-', 'aipass-rules-', 'aipass-sandbox-home-', 'aipass-sbx-',
  'aipass-secret-', 'aipass-skills-', 'aipass-stability-', 'aipass-stats-',
  'aipass-stop-', 'aipass-stop-home-', 'aipass-suite-browser-', 'aipass-suite-home-',
  'aipass-symbols-home-', 'aipass-test-', 'aipass-test-home-', 'aipass-tools-',
  'aipass-ui-', 'aipass-verify-', 'difflib-', 'eval-lint-',
];

// A scratch tree older than an hour belongs to a run that ended long ago:
// the suite's own ceiling is ten minutes, so nothing live is that old — and a
// parallel session's in-flight run is never that old either, so its scratch
// stays untouched.
const STALE_SCRATCH_MS = 60 * 60 * 1000;

/**
 * A port of the suite's own.
 *
 * The OS hands it out atomically when the socket is bound to port 0, so this
 * is "any free port" and nothing else claims it in between.
 */
async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function sweepStaleScratch() {
  const tmp = os.tmpdir();
  let names;
  try {
    names = readdirSync(tmp, { withFileTypes: true });
  } catch {
    return 0;
  }
  const now = Date.now();
  let removed = 0;
  for (const entry of names) {
    if (!entry.isDirectory()) continue;
    if (!SCRATCH_PREFIXES.some((p) => entry.name.startsWith(p))) continue;
    const dir = path.join(tmp, entry.name);
    try {
      if (now - statSync(dir).mtimeMs < STALE_SCRATCH_MS) continue;
      rmSync(dir, { recursive: true, force: true });
      removed++;
    } catch { /* best effort */ }
  }
  return removed;
}

const swept = sweepStaleScratch();
if (swept) console.log(`swept ${swept} stale scratch director${swept === 1 ? 'y' : 'ies'} from ${os.tmpdir()}`);

const extra = process.argv.slice(2); // e.g. --test-name-pattern=…
const coverage = extra.includes('--coverage');
const passThrough = extra.filter((a) => a !== '--coverage');
// Ten minutes is a stuck-run ceiling, not a budget — the suite runs in ~30 s.
// A leaked handle makes the runner wait forever (the Node 24 CI runners did,
// for hours); a timeout fails the step instead of stalling it.
const TEST_TIMEOUT_MS = Number(process.env.AIPASS_TEST_TIMEOUT_MS) || (process.platform === 'win32' ? 20 * 60 * 1000 : 10 * 60 * 1000);
const nodeArgs = ['--test', ...(coverage ? ['--experimental-test-coverage'] : []), ...passThrough, ...files];
// The suite must not write into the developer's real ~/.aipass: the memory
// store, the settings, the sessions and the plugins all live under it. A test
// run that wrote there left one file per temp root behind — the memory
// store's file names are a hash of the project path, so every temp root is a
// new file, and a suite run a day left a hundred of them in the real store.
// A fresh temp home for the run is the floor; a test file that wants its own
// home still sets AIPASS_HOME for itself, and a caller that named one wins.
const HOME = mkdtempSync(path.join(os.tmpdir(), 'aipass-suite-home-'));
// The suite opens a real browser: a run that needs a chat tab asks the
// backend to open one, and the backend does it for you. That browser is
// opened in a private profile of the suite's own — its own process tree, its
// own cookies — so the developer's Chrome is never touched and the window
// can be closed again when the run ends. Without this the suite opened the
// platform's default browser (Edge on a Windows machine) and left a tab
// behind on every run.
const BROWSER_HOME = mkdtempSync(path.join(os.tmpdir(), 'aipass-suite-browser-'));
const BROWSER_PROFILE = path.join(BROWSER_HOME, 'profile');
const BROWSER_PIDS = path.join(BROWSER_HOME, 'pids.txt');
// The suite must not use the developer's bridge port either. A CLI the suite
// runs auto-starts a bridge (aipass-bridge/bin/aipass.mjs) and that bridge
// binds AIPASS_PORT — the real 8787 — with the no-token escape hatch the
// suite turns on, and it is spawned DETACHED, so it outlives the run. Its pid
// landed in the suite's scratch home, where `aipass stop` (which reads the
// developer's real one) could never reach it: an unauthenticated bridge
// squatting the real port, which any web page could blind-POST to. The floor
// here names a port of the suite's own, so a CLI that starts a bridge starts
// it somewhere harmless.
const BRIDGE_PORT = await freePort();
// The environment the suite runs in, shared with the coverage gate
// (scripts/suite-env.mjs): the same scratch home, the same ports, the same
// browser profile. A test that behaves differently under the gate measures
// nothing.
const suite = await suiteEnv({
  home: process.env.AIPASS_HOME?.trim() || HOME,
  browserProfile: BROWSER_PROFILE,
  browserPidFile: BROWSER_PIDS,
});
const result = spawnSync(process.execPath, nodeArgs, {
  stdio: 'inherit',
  timeout: TEST_TIMEOUT_MS,
  env: suite.env,
});

// The browser the suite opened goes with the run: the window is closed (the
// tree, so the renderers go too) and the profile is deleted. A test run must
// leave the machine as it found it.
const closed = await closeOpenedBrowsers({
  env: { AIPASS_BROWSER_PIDFILE: BROWSER_PIDS },
});
if (closed.length) console.log(`closed ${closed.length} browser(s) the suite opened`);
// The bridge goes with it. It is DETACHED, so it outlives the run that
// started it, and a suite that left one behind per run filled the machine
// with sixty of them, each holding sixty megabytes, with nothing left that
// could stop any of them: the pid file is the suite's own, and the suite is
// the only thing that knows where it is.
const stoppedBridge = stopRecordedBridge({ env: suite.env });
if (stoppedBridge.length) console.log(`stopped ${stoppedBridge.length} bridge(s) the suite started (pid ${stoppedBridge.join(', ')})`);
// The browser may still be letting go of its files, so the removal is
// retried before it is given up on: a profile left behind is a hundred
// megabytes of scratch nobody will look at again.
for (let i = 0; i < 5; i++) {
  try {
    rmSync(BROWSER_HOME, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 300));
  }
}

// The scratch home goes with the run: the suite's own state is not evidence,
// and a leftover directory is a leftover directory.
if (!process.env.AIPASS_HOME?.trim()) {
  try { rmSync(HOME, { recursive: true, force: true }); } catch { /* best effort */ }
}

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
