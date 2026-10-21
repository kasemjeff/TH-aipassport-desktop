#!/usr/bin/env node
// The QA loop: find, fix, verify — as a command you can re-run.
//
//   node scripts/qa-loop.mjs            # one pass
//   node scripts/qa-loop.mjs --loop 5  # five passes, or Ctrl+C when satisfied
//
// Each pass does the same four things a person would do, in the same order:
//
//   1. STATIC   — every RPC method the window calls exists on the backend, and
//                 every file with user-facing text is intact UTF-8.
//   2. TESTS    — the repo's own suite, which is where "it worked in the
//                 browser" becomes "it still works tomorrow".
//   3. WINDOW   — the window's logic driven in a fake DOM, so a stale handler or
//                 a palette that stopped filtering fails here instead of in
//                 front of somebody who wanted to use the app.
//   4. LIVE     — if a desktop backend is running, ask it what it actually
//                 reports now (context budget, model, credits).
//
// It prints one line per check and exits non-zero on the first failing pass, so
// it can be wired into anything that watches an exit code.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { windowContract } from './window-contract.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const here = (p) => path.join(repo, p);
const results = [];
// `--static` is the lane a CI job runs: the checks that need nothing but the
// source. The suite (step 2) and the window (step 3) are the same work the
// test lane already does, and the live backend (step 4) is not there in CI.
const STATIC_ONLY = process.argv.slice(2).includes('--static');

const line = (state, label, detail = '') => {
  results.push({ state, label, detail });
  console.log(`${state === 'ok' ? '✔' : state === 'warn' ? '!' : '✖'} ${label.padEnd(34)} ${detail}`);
};

/**
 * One step of the pass.
 *
 * The step has a ceiling: a step that never finishes must fail the pass, not
 * stall it. The suite has its own ten-minute ceiling, and a QA loop that sits
 * in front of it in silence says nothing for ten minutes — the pass looked
 * hung, and the reason (a test file that never exits) was never named. A
 * killed step is a failed step, and the failure says what it was.
 */
const run = (cmd, args, opts = {}) => {
  const { timeoutMs = 12 * 60 * 1000, ...rest } = opts;
  const r = spawnSync(cmd, args, { encoding: 'utf8', cwd: repo, timeout: timeoutMs, ...rest });
  if (r.error?.code === 'ETIMEDOUT') {
    return { code: 124, out: `the step ran past its ${Math.round(timeoutMs / 60000)} minute ceiling and was killed\n${(r.stdout ?? '') + (r.stderr ?? '')}` };
  }
  return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
};

/* 1 — static checks ------------------------------------------------------- */

// The window's contract with the backend: every method it calls exists. The
// rule lives in scripts/window-contract.mjs so the QA loop and the suite ask
// the same question — one of them runs in CI, the other runs with every
// commit, and neither may answer it differently.
const contract = windowContract();
const missing = contract.missing;
line(missing.length ? 'fail' : 'ok', 'every window rpc method exists',
  missing.length ? `missing: ${missing.join(', ')}` : `${contract.called.length} methods, all wired`);

const encodings = [
  'desktop/ui/app.js', 'desktop/ui/index.html', 'desktop/ui/styles.css',
  'desktop/ui/rpc.js', 'desktop/ui/state.js', 'desktop/ui/transcript.js',
  'desktop/ui/settings.js', 'desktop/ui/commands.js',
  'desktop/ui/panels/files.js', 'desktop/ui/panels/sessions.js',
  'aipass-bridge/harness/rpc.mjs',
  'aipass-bridge/harness/run/context.mjs', 'aipass-bridge/harness/run/options.mjs',
  'aipass-bridge/harness/run/send.mjs', 'aipass-bridge/harness/run/gates.mjs',
  'aipass-bridge/harness/run/budgets.mjs',
  'aipass-bridge/harness/rpc/core.mjs', 'aipass-bridge/harness/rpc/settings.mjs',
  'aipass-bridge/harness/rpc/session.mjs', 'aipass-bridge/harness/rpc/files.mjs',
  'aipass-bridge/harness/rpc/plugins.mjs', 'aipass-bridge/harness/rpc/update.mjs',
].map((f) => ({ f, text: fs.readFileSync(here(f), 'utf8') }));
const mangled = encodings.filter((e) => (e.text.match(/\uFFFD/g) ?? []).length);
line(mangled.length ? 'fail' : 'ok', 'user-facing files are intact UTF-8',
  mangled.length ? mangled.map((m) => m.f).join(', ') : `${encodings.length} files, no replacement chars`);

for (const f of [...encodings.map((e) => e.f).filter((f) => /\.[cm]?js$/.test(f)), 'desktop/ui/md.js', 'aipass-bridge/harness/compact.mjs']) {
  const r = run(process.execPath, ['--check', here(f)]);
  line(r.code === 0 ? 'ok' : 'fail', `parses: ${path.basename(f)}`, r.code === 0 ? '' : r.out.split('\n').slice(0, 3).join(' '));
}

// `--static` is the lane a CI job runs: the checks that need nothing but the
// source. The suite (step 2) and the window (step 3) are the same work the
// test lane already does, and the live backend (step 4) is not there in CI.
if (STATIC_ONLY) {
  process.exit(report());
}

/* 2 — the suite ----------------------------------------------------------- */

const suite = run(process.execPath, ['scripts/test.mjs']);
const summary = suite.out.match(/ℹ (pass|fail)\s+\d+/g)?.join(' · ') ?? 'no summary';
line(suite.code === 0 ? 'ok' : 'fail', 'the test suite', summary);

/* 3 — the window, driven -------------------------------------------------- */

const window = run(process.execPath, ['--test', 'aipass-bridge/test/ui.test.mjs'], { timeoutMs: 5 * 60 * 1000 });
line(window.code === 0 ? 'ok' : 'fail', 'the window in a fake DOM',
  window.code === 0 ? 'palette, commands, paste, settings all fire' : (window.out.split('\n').slice(-6).join(' ') || 'see the run above'));

/* 4 — live, if a backend is up -------------------------------------------- */

const BASE = `http://127.0.0.1:${process.env.AIPASS_DESKTOP_PORT ?? '8790'}/rpc`;

/**
 * The backend's own gate, read the way the window reads it.
 *
 * The backend refuses a call that carries no token, and a check that does not
 * carry one is answered with a 401 it would read as "the backend is up and
 * says nothing" — a green line with `model undefined` on it. The token lives
 * in the state home; a backend that answers 401 anyway is reported as
 * refusing the check, which is what it is.
 */
const loopbackToken = () => {
  const env = process.env.AIPASS_TOKEN?.trim();
  if (env) return env;
  const home = process.env.AIPASS_HOME?.trim() || path.join(os.homedir(), '.aipass');
  try { return fs.readFileSync(path.join(home, '.token'), 'utf8').trim() || null; } catch { return null; }
};

try {
  const ask = async () => {
    const headers = { 'content-type': 'application/json' };
    const token = loopbackToken();
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await fetch(BASE, {
      method: 'POST',
      headers,
      body: JSON.stringify({ method: 'status' }),
      signal: AbortSignal.timeout(8000),
    });
    return res.json();
  };
  // A busy backend answers slowly; that is not the same as not running, so the
  // check retries once before declaring it down.
  let st = await ask().catch(() => null);
  if (!st) st = await ask().catch(() => null);
  if (!st?.ok) {
    line('warn', 'live backend', st?.error
      ? `refused the check: ${st.error}`
      : 'not running — start it with `aipass desktop`');
  } else {
    const ctx = st.result?.context ?? {};
    const compactAt = ctx.compactAt ?? 40;
    line('ok', 'live backend', `model ${st.result?.model} · context ${ctx.percent ?? 0}% (rotates at ${compactAt}%) · ${st.result?.extensions ?? 0} extension(s)`);
    if (ctx.needsCompaction) line('warn', 'context is at the rotation point', 'the next run will summarise and rotate');
  }
} catch {
  line('warn', 'live backend', 'not running — start it with `aipass desktop`');
}

/* report ------------------------------------------------------------------ */

function report() {
  const failed = results.filter((r) => r.state === 'fail');
  const warned = results.filter((r) => r.state === 'warn');
  console.log(`\n${results.length - failed.length - warned.length} ok, ${warned.length} warning(s), ${failed.length} failing`);
  if (failed.length) {
    console.log('\nto fix:');
    for (const f of failed) console.log(`  - ${f.label}: ${f.detail}`);
  }
  return failed.length ? 1 : 0;
}

process.exit(report());
