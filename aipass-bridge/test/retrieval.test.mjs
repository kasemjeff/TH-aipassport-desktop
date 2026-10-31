import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildIndex, retrieve, loadIndex, clearIndex, tokenize, chunkFile, ensureIndex, status } from '../harness/retrieval.mjs';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aipass-retrieval-home-'));
process.env.AIPASS_HOME = HOME;

const dirs = [];
const tempDir = (files = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aipass-retrieval-'));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    const p = path.join(dir, name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  return dir;
};

after(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(HOME, { recursive: true, force: true });
});

test('tokenize splits camelCase and Thai', () => {
  const toks = tokenize('refreshToken ระบบค้น');
  assert.ok(toks.includes('refresh'));
  assert.ok(toks.includes('token'));
  assert.ok(toks.includes('ระบบ'));
});

test('chunkFile breaks code at symbols', () => {
  const text = 'import x from "y";\n\nfunction foo() {\n  return 1;\n}\n\nfunction bar() {\n  return 2;\n}\n';
  const chunks = chunkFile('a.js', text);
  assert.ok(chunks.length >= 2);
  assert.ok(chunks.some((c) => c.symbol === 'foo'));
  assert.ok(chunks.some((c) => c.symbol === 'bar'));
});

test('build + retrieve finds a Thai passage', async () => {
  const dir = tempDir({
    'docs/guide.md': '# การค้นหา\n\nระบบค้นคืนความรู้สำหรับโปรเจกต์\n',
    'src/app.js': 'export const login = () => {};\n',
  });
  const { stats } = await buildIndex(dir);
  assert.ok(stats.chunks > 0);
  const res = await retrieve('ค้นคืน', { root: dir });
  assert.ok(res.hits.length >= 1, 'should find the Thai passage');
  assert.match(res.hits[0].path, /guide\.md/);
});

test('retrieve ranks the defining file above a mention', async () => {
  const dir = tempDir({
    'src/auth.ts': 'export function refreshToken() {\n  return token;\n}\n',
    'src/notes.md': 'we should think about token refresh someday\n',
  });
  await buildIndex(dir);
  const res = await retrieve('refresh token', { root: dir });
  assert.ok(res.hits.length >= 1);
  assert.equal(res.hits[0].path, 'src/auth.ts');
});

test('retrieve returns no hits honestly', async () => {
  const dir = tempDir({ 'a.txt': 'hello world\n' });
  await buildIndex(dir);
  const res = await retrieve('kubernetes helm', { root: dir });
  assert.equal(res.hits.length, 0);
});

test('index is cached and reused', async () => {
  const dir = tempDir({ 'a.txt': 'hello world\n' });
  await buildIndex(dir);
  const first = loadIndex(dir);
  const second = loadIndex(dir);
  assert.equal(first.builtAt, second.builtAt);
});

test('clearIndex removes the file', async () => {
  const dir = tempDir({ 'a.txt': 'hello world\n' });
  await buildIndex(dir);
  clearIndex(dir);
  assert.equal(loadIndex(dir), null);
});

test('clearIndex cancels the build that would write the file', async () => {
  const dir = tempDir({ 'a.txt': 'hello world\n' });
  const build = ensureIndex(dir, { force: true });
  clearIndex(dir);
  await assert.rejects(build, /aborted/);
  assert.equal(loadIndex(dir), null, 'a cancelled build leaves no index behind');
});

test('ensureIndex picks up a disk edit after its TTL', async () => {
  const dir = tempDir({ 'a.txt': 'old needle\n' });
  await buildIndex(dir);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'new needle\n');
  fs.utimesSync(path.join(dir, 'a.txt'), new Date(), new Date(Date.now() + 5000));
  await new Promise((r) => setTimeout(r, 10));
  const res = await retrieve('needle', { root: dir, maxAgeMs: 1 });
  assert.ok(res.hits.length >= 1);
  assert.match(res.hits[0].excerpt, /new needle/);
});

test('a staged secret file never enters the answer', async () => {
  const dir = tempDir({ 'app.js': 'export const x = 1;\n' });
  await buildIndex(dir);
  const overlay = {
    entries: () => [[path.join(dir, '.env'), 'API_KEY=supersecret\n']],
  };
  const res = await retrieve('supersecret', { root: dir, overlay });
  assert.equal(res.hits.length, 0, 'the secret floor applies to staged edits too');
});

test('staged overlay is visible without a disk write', async () => {
  const dir = tempDir({ 'a.txt': 'hello world\n' });
  await buildIndex(dir);
  const overlay = {
    entries: () => [[path.join(dir, 'a.txt'), 'brand new staged content about retrieval']],
  };
  const res = await retrieve('retrieval', { root: dir, overlay });
  assert.ok(res.hits.length >= 1);
  assert.match(res.hits[0].excerpt, /retrieval/);
});


test('aborted build writes nothing', async () => {
  const dir = tempDir({ 'a.txt': 'hello world\n', 'b.txt': 'foo bar\n' });
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(buildIndex(dir, { signal: ac.signal }), /aborted/);
  assert.equal(loadIndex(dir), null);
});

test('ensureIndex: an aborted waiter does not fail the others', async () => {
  const dir = tempDir({});
  for (let i = 0; i < 60; i++) fs.writeFileSync(path.join(dir, 'f' + i + '.txt'), 'hello world ' + i + '\n');
  const p1 = ensureIndex(dir, { force: true });
  const ac = new AbortController();
  ac.abort();
  const p2 = ensureIndex(dir, { force: true, signal: ac.signal });
  await assert.rejects(p2, /aborted/);
  const idx = await p1;
  assert.ok(idx && idx.chunks.length > 0);
});

test('incremental build reads only changed files', async () => {
  const dir = tempDir({ 'a.txt': 'hello world\n', 'b.txt': 'foo bar\n' });
  const first = await buildIndex(dir);
  assert.equal(first.stats.read, 2);
  assert.equal(first.stats.reused, 0);
  // touch b.txt with new content + distinct mtime
  fs.writeFileSync(path.join(dir, 'b.txt'), 'foo bar baz\n');
  fs.utimesSync(path.join(dir, 'b.txt'), new Date(), new Date(Date.now() + 5000));
  const second = await buildIndex(dir);
  assert.equal(second.stats.read, 1);
  assert.equal(second.stats.reused, 1);
});

test('loadIndex returns the same cached object', async () => {
  const dir = tempDir({ 'a.txt': 'hello world\n' });
  await buildIndex(dir);
  assert.strictEqual(loadIndex(dir), loadIndex(dir));
});

test('retrieve fills the budget with longer excerpts', async () => {
  const long = '# title\n\n' + 'needle word '.repeat(400) + '\n';
  const dir = tempDir({ 'docs/guide.md': long });
  await buildIndex(dir);
  const res = await retrieve('needle', { root: dir });
  assert.ok(res.hits.length >= 1);
  assert.ok(res.hits[0].excerpt.length > 280, 'top hit excerpt should exceed the old 280 cap');
  const total = res.hits.reduce((n, h) => n + h.excerpt.length, 0);
  assert.ok(total <= 6000, 'excerpt total must respect the budget');
});

test('thai long phrase is found', async () => {
  const dir = tempDir({
    'docs/guide.md': '# การค้นหา\n\nระบบค้นคืนความรู้สำหรับโปรเจกต์นี้ทำงานได้ดี\n',
    'src/app.js': 'export const login = () => {};\n',
  });
  await buildIndex(dir);
  const res = await retrieve('ค้นคืนความรู้', { root: dir });
  assert.ok(res.hits.length >= 1);
  assert.match(res.hits[0].path, /guide\.md/);
});

test('thai plus english mixed query', async () => {
  const dir = tempDir({
    'src/auth.ts': 'export function refreshToken() {\n  return token;\n}\n',
    'docs/note.md': 'we renew the login token สำหรับผู้ใช้\n',
  });
  await buildIndex(dir);
  const res = await retrieve('refresh token ผู้ใช้', { root: dir });
  assert.ok(res.hits.length >= 1);
});

test('code-first truncation skips generated files', async () => {
  const dir = tempDir({
    'docs/aaa.md': 'hello world\n',
    'src/zzz.js': 'export const x = 1;\n',
    'package-lock.json': '{ "lockfileVersion": 3 }\n',
    'bundle.min.js': 'var x=1;\n',
  });
  const { stats } = await buildIndex(dir, { maxFiles: 1 });
  assert.ok(stats.truncated);
  const idx = loadIndex(dir);
  assert.ok(idx.files['src/zzz.js'], 'code file should be indexed');
  assert.ok(!idx.files['docs/aaa.md'], 'docs should be dropped when capped');
  assert.ok(!idx.files['package-lock.json'], 'lockfile should never be indexed');
  assert.ok(!idx.files['bundle.min.js'], 'minified file should never be indexed');
});

test('trigram is not counted in chunk length', async () => {
  const dir = tempDir({ 'a.txt': 'ระบบค้นคืนความรู้สำหรับโปรเจกต์\n' });
  await buildIndex(dir);
  const idx = loadIndex(dir);
  const raw = tokenize('ระบบค้นคืนความรู้สำหรับโปรเจกต์');
  const trigrams = raw.filter((t) => t.startsWith('t:')).length;
  assert.ok(trigrams > 0);
  // length excludes trigrams but includes the path token weight
  assert.ok(idx.lengths[0] < raw.length, 'length must exclude trigram tokens');
});

test('spelling variant still matches via trigrams', async () => {
  const dir = tempDir({ 'docs/guide.md': '# โปรเจกต์\n\nระบบค้นคืนความรู้สำหรับโปรเจกต์นี้\n' });
  await buildIndex(dir);
  const res = await retrieve('โปรเจค', { root: dir });
  assert.ok(res.hits.length >= 1, 'a spelling variant should still find the passage');
});
