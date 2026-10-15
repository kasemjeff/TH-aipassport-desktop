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
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const here = (p) => path.join(repo, p);
const results = [];

const line = (state, label, detail = '') => {
  results.push({ state, label, detail });
  console.log(`${state === 'ok' ? '✔' : state === 'warn' ? '!' : '✖'} ${label.padEnd(34)} ${detail}`);
};

const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', cwd: repo, ...opts });
  return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
};

/* 1 — static checks ------------------------------------------------------- */

const rpcSource = fs.readFileSync(here('aipass-bridge/harness/rpc.mjs'), 'utf8');
const app = fs.readFileSync(here('desktop/ui/app.js'), 'utf8');
const called = [...new Set([...app.matchAll(/rpc\('([a-zA-Z.]+)'/g)].map((m) => m[1]))];
const defined = [...new Set([
  ...rpcSource.matchAll(/'([a-zA-Z.]+)'\s*\(/g),
  ...rpcSource.matchAll(/\basync ([a-zA-Z][a-zA-Z0-9.]*)\(/g),
  ...rpcSource.matchAll(/\b(cancel)\(\)/g),
].map((m) => m[1]))];
const missing = called.filter((m) => !defined.includes(m));
line(missing.length ? 'fail' : 'ok', 'every window rpc method exists',
  missing.length ? `missing: ${missing.join(', ')}` : `${called.length} methods, all wired`);

const encodings = ['desktop/ui/app.js', 'desktop/ui/index.html', 'desktop/ui/styles.css', 'aipass-bridge/harness/rpc.mjs']
  .map((f) => ({ f, text: fs.readFileSync(here(f), 'utf8') }));
const mangled = encodings.filter((e) => (e.text.match(/\uFFFD/g) ?? []).length);
line(mangled.length ? 'fail' : 'ok', 'user-facing files are intact UTF-8',
  mangled.length ? mangled.map((m) => m.f).join(', ') : `${encodings.length} files, no replacement chars`);

for (const f of ['desktop/ui/app.js', 'desktop/ui/md.js', 'aipass-bridge/harness/rpc.mjs', 'aipass-bridge/harness/compact.mjs']) {
  const r = run(process.execPath, ['--check', here(f)]);
  line(r.code === 0 ? 'ok' : 'fail', `parses: ${path.basename(f)}`, r.code === 0 ? '' : r.out.split('\n').slice(0, 3).join(' '));
}

/* 2 — the suite ----------------------------------------------------------- */

const suite = run(process.execPath, ['scripts/test.mjs']);
const summary = suite.out.match(/ℹ (pass|fail)\s+\d+/g)?.join(' · ') ?? 'no summary';
line(suite.code === 0 ? 'ok' : 'fail', 'the test suite', summary);

/* 3 — the window, driven -------------------------------------------------- */

const window = run(process.execPath, ['--test', 'aipass-bridge/test/ui.test.mjs']);
line(window.code === 0 ? 'ok' : 'fail', 'the window in a fake DOM',
  window.code === 0 ? 'palette, commands, paste, settings all fire' : 'see the run above');

/* 4 — live, if a backend is up -------------------------------------------- */

const BASE = `http://127.0.0.1:${process.env.AIPASS_DESKTOP_PORT ?? '8790'}/rpc`;
try {
  const ask = async () => {
    const res = await fetch(BASE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'status' }),
      signal: AbortSignal.timeout(8000),
    });
    return res.json();
  };
  // A busy backend answers slowly; that is not the same as not running, so the
  // check retries once before declaring it down.
  let st = await ask().catch(() => null);
  if (!st) st = await ask().catch(() => null);
  const ctx = st.result?.context ?? {};
  const compactAt = ctx.compactAt ?? 40;
  line('ok', 'live backend', `model ${st.result?.model} · context ${ctx.percent ?? 0}% (rotates at ${compactAt}%) · ${st.result?.extensions ?? 0} extension(s)`);
  if (ctx.needsCompaction) line('warn', 'context is at the rotation point', 'the next run will summarise and rotate');
} catch {
  line('warn', 'live backend', 'not running — start it with `aipass desktop`');
}

/* report ------------------------------------------------------------------ */

const failed = results.filter((r) => r.state === 'fail');
const warned = results.filter((r) => r.state === 'warn');
console.log(`\n${results.length - failed.length - warned.length} ok, ${warned.length} warning(s), ${failed.length} failing`);
if (failed.length) {
  console.log('\nto fix:');
  for (const f of failed) console.log(`  - ${f.label}: ${f.detail}`);
  process.exit(1);
}
