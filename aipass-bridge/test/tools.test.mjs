// The tool implementations, unit-level: the glob matcher, the fetch guard,
// and the async shape of the two shell-carrying tools.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createTools } from '../harness/tools.mjs';
import { Overlay } from '../harness/overlay.mjs';
import { SkillLibrary } from '../harness/skills.mjs';

const mk = (files) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aipass-tools-'));
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
  return dir;
};
const dirs = [];
const mkTracked = (files) => { const dir = mk(files); dirs.push(dir); return dir; };
after(() => { for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true }); });

const toolsIn = (dir, extra = {}) => createTools({ root: dir, overlay: new Overlay(dir), ...extra });

test('GLOB honours the directories before **', () => {
  const dir = mkTracked({ 'src/a.ts': 'a', 'src/deep/b.ts': 'b', 'c.ts': 'c', 'src/x.md': 'm' });
  const tools = toolsIn(dir);
  const hit = (pattern) => tools.glob(pattern).split('\n').filter((l) => !l.startsWith('…')).sort();
  assert.deepEqual(hit('src/**/*.ts'), ['src/a.ts', 'src/deep/b.ts'], 'c.ts is outside src/');
  assert.deepEqual(hit('**/*.ts'), ['c.ts', 'src/a.ts', 'src/deep/b.ts']);
  assert.deepEqual(hit('*.ts'), ['c.ts'], 'a bare pattern stays root-only');
  assert.deepEqual(hit('src/**'), ['src/a.ts', 'src/deep/b.ts', 'src/x.md'], 'a trailing ** means everything below');
  assert.match(tools.glob('src/**/*.md'), /src\/x\.md/);
});

test('FETCH refuses private and internal addresses in every spelling', async () => {
  const tools = toolsIn(mkTracked({}));
  for (const url of [
    'http://127.0.0.1:9/x',
    'http://localhost/x',
    'http://169.254.169.254/latest/meta-data',
    'http://[::1]/x',
    'HTTP-URLLOOPBACK-IP:9/x',   // the WAF-shortened spelling a file quote may carry
  ]) {
    const out = await tools.fetch(url);
    assert.match(out, /refusing to fetch/, `${url} must be refused`);
  }
});

test('FETCH truncates at the byte cap instead of riding a giant body upstream', async () => {
  process.env.AIPASS_FETCH_MAX_BYTES = '100';
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('x'.repeat(10_000), { status: 200 });
  try {
    const tools = toolsIn(mkTracked({}));
    const out = await tools.fetch('http://example.com/big');
    assert.match(out, /truncated at the byte cap/);
    assert.ok(out.length < 2_000, 'the result is bounded, not the whole body');
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.AIPASS_FETCH_MAX_BYTES;
  }
});

test('RUN stays async and keeps its refusal when shell is off', async () => {
  const dir = mkTracked({});
  const off = toolsIn(dir);
  assert.equal(await off.run('', 'echo hi'), 'err: shell commands are disabled for this run');

  const on = toolsIn(dir, { allowRun: true });
  assert.match(await on.run('', 'echo aipass-echo-test'), /aipass-echo-test/);
});

test('GIT is async, and shell punctuation cannot ride behind an allowed subcommand', async () => {
  const dir = mkTracked({});
  const tools = toolsIn(dir);
  assert.match(await tools.git('status; echo pwned'), /no shell punctuation/);
  assert.match(await tools.git('status && echo pwned'), /no shell punctuation/);

  execSync('git init', { cwd: dir, stdio: 'ignore' });
  const out = await tools.git('status');
  assert.match(out, /On branch|No commits yet/, 'a real read-only subcommand still works');
});

test('failures carry the err: prefix the loop keys on', () => {
  const dir = mkTracked({ 'a.txt': 'hello\n' });
  const tools = toolsIn(dir, { skills: new SkillLibrary([]) });
  assert.match(tools.read('missing.txt'), /^err: no such file/);
  assert.match(tools.replace('a.txt', ['', 'x']), /^err: the text to change was empty/);
  assert.match(tools.replace('a.txt', ['not there at all', 'x']), /^err: the text to change was not found/);
  assert.match(tools.search('   '), /^err: give me some text/);
  assert.match(tools.glob(''), /^err: give me a glob/);
  assert.match(tools.delete(''), /^err: give me a file path/);
  assert.match(tools.delete('nope.txt'), /^err: no such file/);
  assert.match(tools.move('a.txt'), /^err: usage/);
  assert.match(tools.skill('no-such-playbook'), /^err: no such skill/);
  // Successes stay bare text — the prefix marks failure, nothing else.
  assert.match(tools.read('a.txt'), /^1 \| hello/);
});

test('SEARCH -i matches without letter case; plain SEARCH stays exact', () => {
  const dir = mkTracked({ 'case.txt': 'Hello World\nbye\n' });
  const tools = toolsIn(dir);
  assert.match(tools.search('hello world'), /no matches/);
  assert.match(tools.search('-i hello world'), /case\.txt:1: Hello World/);
});

test('SEARCH and GLOB honour .gitignore, and the SKIP suspects are out even without one', () => {
  const dir = mkTracked({
    '.gitignore': '*.log\nbuild-out/\n/root-only.txt\n!keep.log\n',
    'app.log': 'needle in a log\n',
    'keep.log': 'needle worth keeping\n',
    'src/code.js': 'const needle = 1\n',
    'build-out/gen.js': 'const needle = 2\n',
    'root-only.txt': 'needle at root\n',
    'nested/root-only.txt': 'needle nested\n',
    'target/debug/x.js': 'needle in target\n',
    'vendor/lib.js': 'needle in vendor\n',
    'coverage/lcov.info': 'needle in coverage\n',
  });
  const tools = toolsIn(dir);
  const hits = tools.search('needle');
  assert.match(hits, /src\/code\.js/);
  assert.match(hits, /keep\.log/, 'a negation re-includes the file');
  assert.match(hits, /nested\/root-only\.txt/, 'a rooted rule ignores the root copy only');
  assert.doesNotMatch(hits, /app\.log/);
  assert.doesNotMatch(hits, /build-out/);
  assert.doesNotMatch(hits, /(^|\/)root-only\.txt: \d+: needle at root/);
  assert.doesNotMatch(hits, /target\/|vendor\/|coverage\//, 'SKIP suspects are excluded with no gitignore at all');

  assert.deepEqual(tools.glob('**/*.log').split('\n'), ['keep.log']);
});

test('SEARCH skips files over the 1 MB cap instead of reading them line by line', () => {
  const dir = mkTracked({
    'big.txt': `${'x'.repeat(1_100_000)}\nneedle\n`,
    'small.txt': 'needle here\n',
  });
  const tools = toolsIn(dir);
  const hits = tools.search('needle');
  assert.match(hits, /small\.txt/);
  assert.doesNotMatch(hits, /big\.txt/);
});

test('ATTACH queues a part the loop can send, and refuses what cannot ride a chat', () => {
  const dir = mkTracked({
    // NUL byte marks it binary, so the extension names the type: image/png
    'shot.png': '\x89PNG\r\n\x1a\n\x00\x01\x02\x03',
    'notes.md': '# notes\n',
    'prog.exe': '\x00\x01binary',
  });
  const tools = toolsIn(dir);
  assert.match(tools.attach('shot.png'), /queued shot\.png \(image\/png/);
  assert.equal(tools.pendingParts.length, 1);
  assert.equal(tools.pendingParts[0].type, 'image_url');
  assert.match(tools.pendingParts[0].image_url.url, /^data:image\/png;base64,/);
  tools.pendingParts.splice(0);

  assert.match(tools.attach('notes.md'), /queued notes\.md \(text\/plain/);
  assert.equal(tools.pendingParts[0].type, 'file');
  assert.equal(tools.pendingParts[0].file.filename, 'notes.md');
  assert.match(tools.pendingParts[0].file.file_data, /^data:text\/plain;base64,/);
  tools.pendingParts.splice(0);

  assert.match(tools.attach('missing.png'), /^err: no such file/);
  assert.match(tools.attach('node_modules/x.png'), /^err: .*skipped/);
  assert.match(tools.attach('prog.exe'), /^err: .*not an attachable type/);
  assert.match(tools.attach(''), /^err: give me a file path/);
  assert.equal(tools.pendingParts.length, 0);
});

test('ATTACH serves a file the run wrote itself, from the overlay', () => {
  const dir = mkTracked({});
  const tools = toolsIn(dir);
  tools.write('made.txt', 'freshly written\n');
  assert.match(tools.attach('made.txt'), /queued made\.txt/);
  assert.equal(tools.pendingParts[0].type, 'file');
  assert.match(tools.pendingParts[0].file.file_data, /^data:text\/plain;base64,/);
});
