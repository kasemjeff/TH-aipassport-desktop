// One WAF table, one owner.
//
// chat.mjs used to carry a fork of the substitution table that had already
// diverged from harness/waf.mjs — it was missing the console.* and comparison
// families, so the same file travelled fine from the CLI and drew a 403 from
// the harness. This file pins the single-source rule two ways: a source check
// that there is no second table to drift, and a round trip through the one
// that remains.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { outbound, inbound, SUBSTITUTIONS, RESTORE, restoreTable } from '../harness/waf.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.join(HERE, '..', rel), 'utf8');

test('chat.mjs carries no fork of the WAF table', () => {
  const src = read('chat.mjs');
  assert.ok(!/const SUBSTITUTIONS\s*=/.test(src), 'chat.mjs must not define its own SUBSTITUTIONS');
  assert.ok(!/const RESTORE\s*=/.test(src), 'chat.mjs must not define its own RESTORE');
  assert.match(src, /from '\.\/harness\/waf\.mjs'/, 'chat.mjs imports the shared table');
  // agent.mjs imports the same module through the harness core.
  assert.match(read('harness/waf.mjs'), /export const SUBSTITUTIONS/);
});

// The window shows the real text behind the wire spellings — a URL a search
// brought back is HTTPS-URL… until somebody puts it back. It must show the
// SAME text the model saw, so it asks the backend for the table instead of
// keeping a copy: one table, one owner, whatever surface asks.
test('the window keeps no copy of the WAF table — it asks the backend for it', () => {
  const ui = read('../desktop/ui/waf-restore.js');
  assert.ok(!/HTTPS-URL/.test(ui), 'the window must not spell a placeholder out');
  assert.ok(!/new RegExp\(['"]/.test(ui), 'and must not build rules of its own');
  assert.match(ui, /setRestoreTable/, 'it takes the rules it is given');

  const pairs = restoreTable();
  assert.equal(pairs.length, RESTORE.length, 'the table travels whole');
  const rebuilt = pairs.map(([source, flags, to]) => [new RegExp(source, flags), to]);
  const text = 'see HTTPS-URLmedium.com/a and LCLHST and CONSOLE-LOG';
  const restored = rebuilt.reduce((acc, [re, to]) => acc.replace(re, to), text);
  assert.equal(restored, 'see https://medium.com/a and localhost and console.log',
    'the window puts the text back exactly as the backend would');
});

// Every placeholder has a restore, or a file the model read comes back with a
// hole in it — and every restore rule has a placeholder, or it silently eats
// real text that happens to look like one.
test('every substitution has a matching restore, and vice versa', () => {
  assert.equal(SUBSTITUTIONS.length, RESTORE.length, 'the tables are kept pairwise');
  const placeholders = [...new Set(SUBSTITUTIONS.map(([, to]) => to))];
  for (const p of placeholders) {
    const restored = RESTORE.reduce((s, [re, back]) => s.replace(re, back), p);
    assert.notEqual(restored, p, `no restore rule matches ${p}`);
  }
  for (const [re] of RESTORE) {
    const fresh = new RegExp(re.source, re.flags);
    const matchesSome = placeholders.some((p) => { fresh.lastIndex = 0; return fresh.exec(p); });
    assert.ok(matchesSome, `restore rule ${re} matches no placeholder`);
  }
  assert.equal(placeholders.length, SUBSTITUTIONS.length, 'one placeholder per substitution');
});

test('the shapes the edge refuses do not survive outbound, and come back byte for byte', () => {
  const risky = [
    'const u = "http://localhost:3000"; console.log(u);',
    'if (a === b) { a !== c; }',
    'node:child_process spawn() and process.env.SECRET',
    '<!doctype html>\n<!-- x -->\n<script>javascript:alert(1)</script>',
    'cd ~/project && ./run.sh',
    'console.warn("127.0.0.1 & 0.0.0.0");',
    '@echo off\n"D:\\aipass-build\\target\\release\\node.exe" "D:\\aipass-build\\target\\release\\aipass-bridge\\bin\\aipass.mjs" %*\nsetlocal\nendlocal',
    'call helper.cmd && helper.bat %~dp0',
  ].join('\n');
  const enc = outbound(risky);
  for (const shape of ['console.log', 'console.warn', 'localhost', '===', '!==', 'node:child_process', '<script', 'javascript:', 'process.env', '127.0.0.1', '0.0.0.0', '&&', '<!doctype', '@echo off', '%*', 'node.exe', '.cmd', '.bat', '%~dp0', 'setlocal', 'endlocal']) {
    assert.ok(!enc.includes(shape), `${shape} must not survive outbound`);
  }
  assert.equal(inbound(enc), risky, 'the round trip restores the original bytes');
});

// The one documented lossy edge: outbound is case-insensitive for URLs/hosts,
// restore emits the common lowercase spelling. A mismatch costs a retry, never
// a bad write, so the test pins the actual behaviour rather than pretending.
test('case-insensitive families restore to their lowercase spelling', () => {
  assert.equal(inbound(outbound('HTTP://LocalHost')), 'http://localhost');
  assert.equal(inbound(outbound('https://de.aipass.net')), 'https://de.aipass.net');
});
