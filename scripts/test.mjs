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
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
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

const extra = process.argv.slice(2); // e.g. --test-name-pattern=…
const result = spawnSync(process.execPath, ['--test', ...extra, ...files], { stdio: 'inherit' });

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
