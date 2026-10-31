// The coverage gate: the floor under the code the window and the backend run.
//
// `npm test` says whether the code is right. This says whether the code is
// still WATCHED — a file whose coverage fell through the floor is a file
// nobody is testing any more, and the suite stays green while it happens.
//
// The numbers come from the LCOV the test runner writes, and they are merged
// by file first: the window's app.js is imported once per UI test (each boot
// needs a fresh window, so the import is cache-busted with a query), and the
// runner reports every boot separately. Merging them is the difference
// between "the last boot happened to touch 37% of the file" and "the tests
// together touch 62% of it".
//
// A floor is a promise, not a scoreboard: a file that cannot be watched
// because it is a script nobody imports has no floor, and a file whose floor
// is not met fails the gate.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { suiteEnv } from './suite-env.mjs';
// The browser the suite opened goes with the run: the window is closed (the
// tree, so the renderers go too) and the profile is deleted.
import { closeOpenedBrowsers } from '../aipass-bridge/harness/browser.mjs';
// The bridge the gate started is detached, so it outlives the gate.
import { stopRecordedBridge } from '../aipass-bridge/harness/bridge-pid.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The floors, per file: line, branch and function coverage in percent.
 *
 * A file that is not listed is not gated: a file nobody imports (a script
 * that is only ever run by hand) has no coverage to speak of, and a floor on
 * it would be a floor on nothing.
 *
 * The numbers are the ones the suite measures today, rounded down a little:
 * a floor is a promise that the file stays watched, not a scoreboard to
 * beat. Raise one when the tests for that file grow; lower one only when a
 * file is genuinely gone.
 */
export const FLOORS = {
  // The window's logic, driven in a fake DOM. It is imported once per UI
  // test, so the gate measures the union of the boots.
  'desktop/ui/app.js': { lines: 80, branches: 55, functions: 58 },
  // The window's own modules: the client, the state, the conversation, the
  // sheet, the commands and the two panels.
  'desktop/ui/rpc.js': { lines: 95, branches: 82, functions: 68 },
  'desktop/ui/state.js': { lines: 95, branches: 95, functions: 95 },
  'desktop/ui/transcript.js': { lines: 94, branches: 70, functions: 85 },
  // The notices pinned over the conversation (no chat tab, the extension's
  // token, the model catalog, the update) and the welcome card.
  'desktop/ui/banners.js': { lines: 90, branches: 70, functions: 65 },
  'desktop/ui/settings.js': { lines: 75, branches: 56, functions: 58 },
  'desktop/ui/commands.js': { lines: 70, branches: 62, functions: 59 },
  'desktop/ui/panels/files.js': { lines: 87, branches: 66, functions: 69 },
  'desktop/ui/panels/sessions.js': { lines: 86, branches: 70, functions: 68 },
  'desktop/ui/panels/context.js': { lines: 60, branches: 50, functions: 35 },
  // The backend the window talks to.
  'aipass-bridge/harness/rpc.mjs': { lines: 92, branches: 74, functions: 66 },
  // The backend's methods, one module per domain.
  'aipass-bridge/harness/rpc/core.mjs': { lines: 95, branches: 55, functions: 52 },
  'aipass-bridge/harness/rpc/settings.mjs': { lines: 80, branches: 51, functions: 62 },
  'aipass-bridge/harness/rpc/session.mjs': { lines: 88, branches: 52, functions: 79 },
  'aipass-bridge/harness/rpc/files.mjs': { lines: 69, branches: 62, functions: 71 },
  'aipass-bridge/harness/rpc/plugins.mjs': { lines: 55, branches: 95, functions: 15 },
  'aipass-bridge/harness/rpc/update.mjs': { lines: 60, branches: 95, functions: 14 },
  // The stages of a run: its state, the option sheet, the send pipeline, the
  // DONE gates and the budgets.
  'aipass-bridge/harness/run/context.mjs': { lines: 95, branches: 90, functions: 86 },
  'aipass-bridge/harness/run/options.mjs': { lines: 95, branches: 63, functions: 95 },
  'aipass-bridge/harness/run/send.mjs': { lines: 95, branches: 79, functions: 82 },
  'aipass-bridge/harness/run/gates.mjs': { lines: 94, branches: 85, functions: 95 },
  'aipass-bridge/harness/run/budgets.mjs': { lines: 92, branches: 63, functions: 67 },
  // The launcher's rules.
  'aipass-bridge/harness/launcher.mjs': { lines: 94, branches: 80, functions: 88 },
  // The CLI's client for a running desktop backend.
  'aipass-bridge/harness/desktop-rpc.mjs': { lines: 98, branches: 95, functions: 64 },
};

/**
 * Parse an LCOV file into one record per file, per instance.
 *
 * The window's app.js is imported once per UI test (each boot needs a fresh
 * window, so the import is cache-busted with a query), and the runner reports
 * every boot as its own record. The records are kept apart on purpose: the
 * branch ids V8 hands out are per instance, so two boots disagree about which
 * branch is number 7, and merging them by id counts branches that do not
 * exist.
 */
export function mergeLcov(text) {
  const files = new Map();
  let current = null;
  const start = (name) => {
    const file = files.get(name) ?? { name, instances: [] };
    files.set(name, file);
    current = {
      lines: new Map(), branches: new Map(), functions: new Map(),
      branchLines: new Set(), branchLinesHit: new Set(),
    };
    file.instances.push(current);
    return current;
  };
  for (const line of text.split('\n')) {
    if (line.startsWith('SF:')) {
      // The query that busts the import cache is not part of the file's name,
      // and the path separator is not either: the report writes the path the
      // platform uses, and the floors are written the way a person writes a
      // path.
      const name = line.slice(3).replace(/\?.*$/, '').replace(/\\/g, '/');
      start(name);
      continue;
    }
    if (!current) continue;
    if (line.startsWith('DA:')) {
      const [no, count] = line.slice(3).split(',');
      current.lines.set(Number(no), Math.max(current.lines.get(Number(no)) ?? 0, Number(count)));
    } else if (line.startsWith('BRDA:')) {
      const [no, block, branch, taken] = line.slice(5).split(',');
      const key = `${no},${block},${branch}`;
      // '-' means the branch was never taken; a number means it was.
      const was = taken === '-' ? 0 : Number(taken);
      current.branches.set(key, Math.max(current.branches.get(key) ?? 0, was));
      current.branchLines.add(Number(no));
      if (was > 0) current.branchLinesHit.add(Number(no));
    } else if (line.startsWith('FNDA:')) {
      const [count, name] = line.slice(5).split(',');
      current.functions.set(name, Math.max(current.functions.get(name) ?? 0, Number(count)));
    } else if (line === 'end_of_record') {
      current = null;
    }
  }
  return files;
}

/**
 * The percentages for one file.
 *
 * A file imported once is measured exactly as the runner measures it: the
 * share of its lines, its branches and its functions the tests reached.
 *
 * A file imported many times is measured as a union over the boots: a line
 * counts when ANY boot reached it, a function counts when ANY boot called it,
 * and a branch counts by the line it is on — the branch ids are per boot, but
 * the lines are the source's own and do not move.
 */
export function percent(file) {
  const instances = file.instances;
  if (instances.length === 1) {
    const only = instances[0];
    const lines = only.lines.size;
    const linesHit = [...only.lines.values()].filter((c) => c > 0).length;
    const branches = only.branches.size;
    const branchesHit = [...only.branches.values()].filter((c) => c > 0).length;
    const functions = only.functions.size;
    const functionsHit = [...only.functions.values()].filter((c) => c > 0).length;
    const pct = (hit, total) => (total ? (hit / total) * 100 : 100);
    return {
      lines: pct(linesHit, lines),
      branches: pct(branchesHit, branches),
      functions: pct(functionsHit, functions),
      counts: { lines: [linesHit, lines], branches: [branchesHit, branches], functions: [functionsHit, functions] },
      boots: instances.length,
    };
  }
  const lines = new Set();
  const linesHit = new Set();
  const fns = new Set();
  const fnsHit = new Set();
  const branchLines = new Set();
  const branchLinesHit = new Set();
  for (const inst of instances) {
    for (const [no, count] of inst.lines) {
      lines.add(no);
      if (count > 0) linesHit.add(no);
    }
    for (const [name, count] of inst.functions) {
      fns.add(name);
      if (count > 0) fnsHit.add(name);
    }
    for (const no of inst.branchLines) branchLines.add(no);
    for (const no of inst.branchLinesHit) branchLinesHit.add(no);
  }
  const pct = (hit, total) => (total ? (hit / total) * 100 : 100);
  return {
    lines: pct(linesHit.size, lines.size),
    // The branch ids are per boot, so the merged measure is by the line the
    // branch sits on: the share of the branch-bearing lines the tests took a
    // way through.
    branches: pct(branchLinesHit.size, branchLines.size),
    functions: pct(fnsHit.size, fns.size),
    counts: {
      lines: [linesHit.size, lines.size],
      branches: [branchLinesHit.size, branchLines.size],
      functions: [fnsHit.size, fns.size],
    },
    boots: instances.length,
  };
}

/** The floors the gate checks, with the file's real numbers against them. */
export function check(files, floors = FLOORS) {
  const rows = [];
  const failures = [];
  for (const [name, floor] of Object.entries(floors)) {
    const file = files.get(name);
    if (!file) {
      failures.push(`${name}: no coverage was recorded for it at all — the file is not imported by anything the suite runs`);
      continue;
    }
    const got = percent(file);
    const row = { name, floor, got };
    rows.push(row);
    for (const key of ['lines', 'branches', 'functions']) {
      if (got[key] < floor[key]) {
        failures.push(`${name}: ${key} coverage is ${got[key].toFixed(2)}%, the floor is ${floor[key]}%`);
      }
    }
  }
  return { rows, failures };
}

/**
 * Run the suite with coverage and check the floors.
 *
 * Each test file is run in its own process with its own lcov file: the
 * runner's reporter writes to ONE destination, and every child process
 * overwrites the one before it — so a single run's report is the last file's
 * coverage and nothing else. One destination per file is the whole difference
 * between measuring the suite and measuring its last file.
 *
 * The files run in parallel, the way the suite runs them: the test runner
 * already gives every file its own process, so this is the same work, with
 * the reports kept apart.
 */
export async function runGate({ repo: root = repo, floors = FLOORS, argv = [], concurrency = 4 } = {}) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'aipass-coverage-'));
  const testDir = path.join(root, 'aipass-bridge', 'test');
  const files = fs.readdirSync(testDir).filter((f) => f.endsWith('.test.mjs')).sort();
  const suite = await suiteEnv();
  try {
    let next = 0;
    const failures = [];
    const worker = async () => {
      for (;;) {
        const i = next++;
        if (i >= files.length) return;
        const file = path.join(testDir, files[i]);
        const destination = path.join(scratch, `${String(i).padStart(3, '0')}.info`);
        // A browser profile of this file's own: the files run in parallel,
        // and two of them opening a browser in the SAME profile is a race
        // that ends with one file's cleanup killing the other's window.
        const browserHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aipass-gate-browser-'));
        const env = {
          ...suite.env,
          AIPASS_BROWSER_PROFILE: path.join(browserHome, 'profile'),
          AIPASS_BROWSER_PIDFILE: path.join(browserHome, 'pids.txt'),
        };
        try {
          const run = spawnSync(process.execPath, [
            '--test',
            '--experimental-test-coverage',
            '--test-reporter=lcov',
            `--test-reporter-destination=${destination}`,
            ...argv,
            file,
          ], { encoding: 'utf8', cwd: root, env, timeout: 10 * 60 * 1000, stdio: ['ignore', 'pipe', 'pipe'] });
          if (run.status !== 0) {
            failures.push(`${files[i]}: the suite did not pass — the coverage of the whole run cannot be trusted`);
            process.stderr.write(run.stdout ?? '');
            process.stderr.write(run.stderr ?? '');
          }
        } finally {
          // The browser this file opened goes with it: a gate must leave the
          // machine as it found it.
          await closeOpenedBrowsers({ env: { AIPASS_BROWSER_PIDFILE: env.AIPASS_BROWSER_PIDFILE } });
          fs.rmSync(browserHome, { recursive: true, force: true });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, worker));

    const merged = new Map();
    for (const name of fs.readdirSync(scratch)) {
      if (!name.endsWith('.info')) continue;
      for (const [file, record] of mergeLcov(fs.readFileSync(path.join(scratch, name), 'utf8'))) {
        const existing = merged.get(file) ?? { name: file, instances: [] };
        existing.instances.push(...record.instances);
        merged.set(file, existing);
      }
    }
    const { rows, failures: under } = check(merged, floors);
    return { ok: failures.length === 0 && under.length === 0, rows, failures: [...failures, ...under], files: merged };
  } finally {
    // The bridge the gate started is detached, so it outlives the gate. It
    // goes with the gate: a gate that leaves one behind per run fills the
    // machine with bridges nothing can stop.
    stopRecordedBridge({ env: suite.env });
    fs.rmSync(scratch, { recursive: true, force: true });
    fs.rmSync(suite.browserHome, { recursive: true, force: true });
    if (!process.env.AIPASS_HOME?.trim()) fs.rmSync(suite.home, { recursive: true, force: true });
  }
}

/* the command --------------------------------------------------------------- */

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const { ok, rows, failures } = await runGate();
  console.log('\ncoverage floors');
  for (const r of rows) {
    const mark = (got, floor) => (got >= floor ? 'ok  ' : 'FAIL');
    console.log(
      `  ${r.name.padEnd(42)} lines ${mark(r.got.lines, r.floor.lines)} ${r.got.lines.toFixed(1).padStart(5)}% (floor ${r.floor.lines}%)`
      + `  branches ${mark(r.got.branches, r.floor.branches)} ${r.got.branches.toFixed(1).padStart(5)}% (floor ${r.floor.branches}%)`
      + `  functions ${mark(r.got.functions, r.floor.functions)} ${r.got.functions.toFixed(1).padStart(5)}% (floor ${r.floor.functions}%)`,
    );
  }
  if (!ok) {
    console.log('\nunder the floor:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log('\nevery floored file is still watched.');
}
