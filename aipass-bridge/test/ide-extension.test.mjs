// The IDE extension self-test adapter: runs ide-extension/selftest.mjs as part
// of the repository's test suite to ensure the editor extension's protocol mirror
// never drifts from the backend harness grammar.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const selftestScript = path.join(repoRoot, 'ide-extension', 'selftest.mjs');

test('ide-extension selftest passes all protocol and marker contract checks', () => {
  const result = spawnSync(process.execPath, [selftestScript], {
    cwd: repoRoot,
    encoding: 'utf8',
  });

  if (result.status !== 0) {
    console.error('selftest output:\n', result.stdout, result.stderr);
  }
  assert.equal(result.status, 0, `ide-extension/selftest.mjs failed with exit code ${result.status}`);
  assert.match(result.stdout, /pass \d+ checks — 0 failed/);
});
