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
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
  'aipass-loadtest-root-', 'aipass-plan-home-', 'aipass-plugin-',
  'aipass-qa-home-', 'aipass-rules-', 'aipass-sandbox-home-', 'aipass-sbx-',
  'aipass-secret-', 'aipass-skills-', 'aipass-stability-', 'aipass-stats-',
  'aipass-stop-', 'aipass-stop-home-', 'aipass-suite-home-',
  'aipass-symbols-home-', 'aipass-test-', 'aipass-test-home-', 'aipass-tools-',
  'aipass-ui-', 'aipass-verify-', 'difflib-', 'eval-lint-',
];

// A scratch tree older than an hour belongs to a run that ended long ago:
// the suite's own ceiling is ten minutes, so nothing live is that old — and a
// parallel session's in-flight run is never that old either, so its scratch
// stays untouched.
const STALE_SCRATCH_MS = 60 * 60 * 1000;

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
const nodeArgs = ['--test', ...(coverage ? ['--experimental-test-coverage'] : []), ...passThrough, ...files];
// The suite must not write into the developer's real ~/.aipass: the memory
// store, the settings, the sessions and the plugins all live under it. A test
// run that wrote there left one file per temp root behind — the memory
// store's file names are a hash of the project path, so every temp root is a
// new file, and a suite run a day left a hundred of them in the real store.
// A fresh temp home for the run is the floor; a test file that wants its own
// home still sets AIPASS_HOME for itself, and a caller that named one wins.
const HOME = mkdtempSync(path.join(os.tmpdir(), 'aipass-suite-home-'));
const result = spawnSync(process.execPath, nodeArgs, {
  stdio: 'inherit',
  timeout: 10 * 60 * 1000,
  // The token bucket in BridgeClient paces real sends at nine per four
  // minutes; the suite's bridges are loopback fakes and must not pay that wall
  // clock. A test that pins the bucket passes an explicit `rateBucket`
  // option, so this floor never hides the production default from tests.
  env: {
    ...process.env,
    AIPASS_HOME: process.env.AIPASS_HOME?.trim() || HOME,
    AIPASS_RATE_BUCKET: process.env.AIPASS_RATE_BUCKET ?? 'off',
  },
});

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
