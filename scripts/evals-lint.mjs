#!/usr/bin/env node
// The eval-set lint: prove the set can be trusted before a live run is spent on it.
//
//   node scripts/evals-lint.mjs          # shape, LF pin, and every check
//   node scripts/evals-lint.mjs --fast   # shape + LF only, no spawns
//
// Three things are true of a set worth scoring against:
//
//   1. fail-before — every task's own check FAILS on its untouched tree. A
//      check that already passes scores nothing, and a fixture that drifted
//      into "already correct" would silently become free credits.
//   2. pair shape  — evals/thai is a Thai/English pair set: every -en twin
//      has its Thai original, both name the same `pair`, and `lang` is
//      th|en accordingly. The report groups by pair, so a broken folder
//      would misreport the whole point of the set.
//   3. LF pin      — evals/** is `text eol=lf` in .gitattributes. A checkout
//      that rewrites CRLF makes byte-wise checks fail on Windows only —
//      exactly how fix-year behaved on a CRLF tree (see evals/thai/README.md).
//
// Exit 0 when everything holds, 1 on a failed category, 2 for a bad flag.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { loadTask } from './evals.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EVALS = path.join(ROOT, 'evals');
const CHECK_TIMEOUT_MS = 20_000;
const KINDS = ['tasks', 'holdout', 'thai'];

/** Task directories under `evals/<kind>/`, sorted. */
function taskDirs(kind) {
  const base = path.join(EVALS, kind);
  if (!fs.existsSync(base)) return [];
  return fs.readdirSync(base, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(base, e.name, 'task.json')))
    .map((e) => path.join(base, e.name))
    .sort();
}

/** Run one task's check against a fresh copy of its untouched tree. */
function checkOnUntouchedTree(dir) {
  const task = loadTask(dir, { id: path.basename(dir) });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-lint-'));
  try {
    fs.cpSync(path.join(dir, 'tree'), tmp, { recursive: true });
    const res = spawnSync(task.check, {
      cwd: tmp, shell: true, timeout: CHECK_TIMEOUT_MS, windowsHide: true, encoding: 'utf8',
    });
    if (res.error) {
      const why = res.error.code === 'ETIMEDOUT' ? `check timed out after ${CHECK_TIMEOUT_MS}ms` : res.error.message;
      return { ok: false, why };
    }
    if (res.status === 0) return { ok: false, why: 'check PASSES on the untouched tree — it scores nothing' };
    return { ok: true };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** The pair-shape rules only the Thai set has. */
function pairProblems() {
  const thai = path.join(EVALS, 'thai');
  const ids = taskDirs('thai').map((d) => path.basename(d));
  const problems = [];
  for (const id of ids) {
    const spec = JSON.parse(fs.readFileSync(path.join(thai, id, 'task.json'), 'utf8'));
    const isEn = id.endsWith('-en');
    const base = isEn ? id.slice(0, -3) : id;
    const twin = isEn ? base : `${id}-en`;
    if (!ids.includes(twin)) problems.push(`${id}: twin ${twin} is missing`);
    if (spec.lang !== (isEn ? 'en' : 'th')) problems.push(`${id}: lang is ${JSON.stringify(spec.lang)}, expected ${isEn ? 'en' : 'th'}`);
    if (spec.pair !== base) problems.push(`${id}: pair is ${JSON.stringify(spec.pair)}, expected ${base}`);
  }
  return { count: ids.length, problems };
}

/** Every file under evals/ that still carries a CR byte. */
function crlfFiles(dir) {
  const bad = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (fs.readFileSync(p).includes(13)) bad.push(path.relative(ROOT, p));
    }
  };
  walk(dir);
  return bad;
}

const okLine = (label, detail) => console.log(`✔ ${label.padEnd(34)} ${detail}`);
const badLine = (text) => console.log(`✖ ${text}`);

function main() {
  const fast = process.argv.includes('--fast');
  if (process.argv.slice(2).some((a) => a !== '--fast')) {
    console.error('usage: node scripts/evals-lint.mjs [--fast]');
    return 2;
  }
  let failing = 0;

  // 1. fail-before.
  if (fast) {
    okLine('fail-before', 'skipped (--fast)');
  } else {
    let checked = 0;
    let bad = 0;
    const started = Date.now();
    for (const kind of KINDS) {
      for (const dir of taskDirs(kind)) {
        checked += 1;
        const res = checkOnUntouchedTree(dir);
        if (!res.ok) {
          bad += 1;
          badLine(`${kind}/${path.basename(dir)}: ${res.why}`);
        }
      }
    }
    if (bad) failing += 1;
    else okLine('fail-before', `${checked} checks fail on their untouched tree (${((Date.now() - started) / 1000).toFixed(1)}s)`);
  }

  // 2. Pair shape.
  const pairs = pairProblems();
  if (pairs.problems.length) {
    failing += 1;
    for (const p of pairs.problems) badLine(`pairs: ${p}`);
  } else {
    okLine('pair shape', `${pairs.count / 2} th/en pairs, twins · langs · pair ids agree`);
  }

  // 3. The LF pin.
  const attrs = fs.existsSync(path.join(ROOT, '.gitattributes'))
    ? fs.readFileSync(path.join(ROOT, '.gitattributes'), 'utf8') : '';
  const pinned = /^evals\/\*\*\s+text\s+eol=lf\s*$/m.test(attrs);
  const dirty = crlfFiles(EVALS);
  if (!pinned) {
    failing += 1;
    badLine('LF pin: .gitattributes is missing the evals/** text eol=lf rule');
  } else if (dirty.length) {
    failing += 1;
    for (const f of dirty.slice(0, 20)) badLine(`LF pin: ${f} carries a CR byte`);
    if (dirty.length > 20) badLine(`LF pin: …and ${dirty.length - 20} more`);
  } else {
    okLine('LF pin', '.gitattributes rule present, no CR bytes under evals/');
  }

  console.log(failing ? '\nevals-lint: FAIL' : '\nevals-lint: OK');
  return failing ? 1 : 0;
}

process.exitCode = main();
