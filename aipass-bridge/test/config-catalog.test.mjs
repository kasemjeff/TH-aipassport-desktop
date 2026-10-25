/**
 * The configuration catalog is a contract, not a description.
 *
 * docs/CONFIG.md names every AIPASS_* environment variable the product
 * reads, every settings key, and every harness option. This test holds the
 * three tables equal to the code in both directions: a knob added or
 * renamed without the catalog fails the suite, and a catalog row whose knob
 * nobody reads fails too — a documented switch that does nothing is worse
 * than an undocumented one, because it promises a control that is not there.
 *
 * A name that appears only in a comment is not a knob. The env scan reads
 * access shapes (`process.env.AIPASS_X`, `env.AIPASS_X`, and the quoted
 * helper argument `envFlag('AIPASS_X', …)`), so prose that merely mentions a
 * variable never counts — which is how the stale `AIPASS_SKILLS_DIR` and
 * `AIPASS_MAX_RESULT` comments were caught by this catalog in the first
 * place.
 *
 * Run: node --test aipass-bridge/test/config-catalog.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULTS, HARNESS_OPTION_DEFAULTS } from '../harness/settings.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE_ROOT = path.resolve(HERE, '..');
const REPO_ROOT = path.resolve(BRIDGE_ROOT, '..');
const DOC = path.join(REPO_ROOT, 'docs', 'CONFIG.md');

/** Product sources that may read an AIPASS_* variable. */
const SCAN_ROOTS = [
  path.join(BRIDGE_ROOT, 'bin'),
  path.join(BRIDGE_ROOT, 'bridge'),
  path.join(BRIDGE_ROOT, 'harness'),
  path.join(BRIDGE_ROOT, 'deploy'),
  path.join(REPO_ROOT, 'scripts'),
];

/** Every .mjs file under dir, recursively. */
function* sources(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* sources(full);
    else if (entry.isFile() && entry.name.endsWith('.mjs')) yield full;
  }
}

/**
 * The AIPASS_* names the product actually reads, in either access shape:
 * `process.env.AIPASS_X` / `env.AIPASS_X`, or the quoted argument of the
 * env helpers (`envFlag('AIPASS_X', …)`, `envPositive(…)`) and of the
 * named-constant pattern (`const ENV = 'AIPASS_X'`).
 */
function readEnvNames() {
  const found = new Set();
  const ACCESS = /\b(?:process\.env|env)\.(AIPASS_[A-Z0-9_]+)/g;
  const QUOTED = /(['"])AIPASS_[A-Z0-9_]+\1/g;
  for (const root of SCAN_ROOTS) {
    for (const file of sources(root)) {
      const text = fs.readFileSync(file, 'utf8');
      for (const m of text.matchAll(ACCESS)) found.add(m[1]);
      for (const m of text.matchAll(QUOTED)) found.add(m[0].slice(1, -1));
    }
  }
  return found;
}

/**
 * The backticked names in every catalog section whose title starts with
 * `sectionTitle` — the env tables are three sections (backend, bridge,
 * build) under one family, and each row's first cell matches `cellPattern`.
 */
function catalogSection(sectionTitle, cellPattern) {
  const text = fs.readFileSync(DOC, 'utf8');
  const lines = text.split('\n');
  const found = new Set();
  let inSection = false;
  for (const line of lines) {
    if (line.startsWith('## ')) inSection = line.slice(3).trimStart().startsWith(sectionTitle);
    if (!inSection) continue;
    const m = cellPattern.exec(line);
    if (m) found.add(m[1]);
  }
  assert.ok(found.size > 0, `docs/CONFIG.md has a "${sectionTitle}" section with rows`);
  return found;
}

const envCell = () => /^\|\s*`(AIPASS_[A-Z0-9_]+)`/;
const keyCell = () => /^\|\s*`([a-zA-Z][a-zA-Z0-9]*)`/;

test('every AIPASS_* variable the product reads is named in docs/CONFIG.md', () => {
  const read = readEnvNames();
  const cataloged = catalogSection('Environment variables', envCell());
  const missing = [...read].filter((n) => !cataloged.has(n));
  assert.deepEqual(missing, [],
    `env vars read by the product but absent from docs/CONFIG.md: ${missing.join(', ')}`);
});

test('every AIPASS_* variable in docs/CONFIG.md is read by the product', () => {
  const read = readEnvNames();
  const cataloged = catalogSection('Environment variables', envCell());
  const extra = [...cataloged].filter((n) => !read.has(n));
  assert.deepEqual(extra, [],
    `rows in docs/CONFIG.md the product never reads: ${extra.join(', ')}`);
});

test('every settings key is named in docs/CONFIG.md, and every row is a real key', () => {
  const cataloged = catalogSection('Settings keys', keyCell());
  const real = new Set(Object.keys(DEFAULTS));
  const missing = [...real].filter((k) => !cataloged.has(k));
  const extra = [...cataloged].filter((k) => !real.has(k));
  assert.deepEqual(missing, [], `settings keys absent from docs/CONFIG.md: ${missing.join(', ')}`);
  assert.deepEqual(extra, [], `settings rows with no such key in DEFAULTS: ${extra.join(', ')}`);
});

test('every harness option is named in docs/CONFIG.md, and every row is a real option', () => {
  const cataloged = catalogSection('Harness options', keyCell());
  const real = new Set(Object.keys(HARNESS_OPTION_DEFAULTS));
  const missing = [...real].filter((k) => !cataloged.has(k));
  const extra = [...cataloged].filter((k) => !real.has(k));
  assert.deepEqual(missing, [], `harness options absent from docs/CONFIG.md: ${missing.join(', ')}`);
  assert.deepEqual(extra, [], `harness-option rows with no such key in HARNESS_OPTION_DEFAULTS: ${extra.join(', ')}`);
});
