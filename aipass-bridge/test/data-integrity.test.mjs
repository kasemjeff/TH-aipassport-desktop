// Data integrity pins: what the on-disk formats do with data that is missing,
// duplicated or the wrong type — and what a file written by an older or newer
// build does when this one reads it. The promises here are the ones
// docs/DATA_FORMATS.md states: torn lines are skipped, duplicates load once,
// a wrong-typed header is skipped like a torn one, unknown entry types are
// preserved, and settings merge over DEFAULTS so an old file keeps working.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionStore, HEADER_EVERY } from '../harness/session.mjs';
import { Settings } from '../harness/settings.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aipass-integrity-'));

const writeSession = (file, lines) => {
  fs.writeFileSync(file, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
  return file;
};

const header = (id, extra = {}) => ({
  type: 'header', id, parentId: null, title: `t-${id}`, root: 'C:\\tmp', model: null,
  created: 1, updated: 2, entryCount: 0, schema: 1, ...extra,
});
const entry = (type, id, parentId, extra = {}) => ({ type, id, parentId, ts: 3, ...extra });

test('a torn line is skipped and the rest of the session still loads', () => {
  const dir = tmp();
  const file = path.join(dir, 'session-torn.jsonl');
  writeSession(file, [
    header('torn', { entryCount: 2 }),
    entry('user', 'u1', 'torn', { text: 'hello' }),
    '{"type":"assistant","id":"a1","paren', // killed mid-write
  ]);

  const store = new SessionStore(path.join(dir, 'store'));
  const s = store.load(file);
  assert.ok(s, 'a torn tail does not cost the session');
  assert.deepEqual(s.entries.map((e) => e.id), ['u1']);

  const store2 = new SessionStore(dir); // list() reads dir-for-root style paths
  assert.equal(store2.load(file)?.entries.length, 1);
});

test('a duplicated entry loads once — the chain keeps its shape', () => {
  const dir = tmp();
  const file = path.join(dir, 'session-dup.jsonl');
  const dup = entry('assistant', 'a1', 'u1', { text: 'same bytes twice' });
  writeSession(file, [
    header('dup'),
    entry('user', 'u1', 'dup', { text: 'hi' }),
    dup,
    dup, // a crash between append and fsync could replay one append
    entry('user', 'u2', 'a1', { text: 'again' }),
  ]);

  const s = new SessionStore(dir).load(file);
  assert.deepEqual(s.entries.map((e) => e.id), ['u1', 'a1', 'u2']);
  assert.equal(s.entries[2].parentId, 'a1', 'links still resolve after the drop');
});

test('wrong-typed data never reaches the picker or the chain', () => {
  const dir = tmp();
  const proj = path.join(dir, 'proj'); // list() scans project directories
  fs.mkdirSync(proj, { recursive: true });
  const store = new SessionStore(dir);

  // A first line that parses to something other than a header object: skipped.
  writeSession(path.join(proj, 'session-bad-header.jsonl'), ['"just a string"', entry('user', 'u1', null, { text: 'x' })]);
  // An entry line that parses to an array, and one without an id: both skipped.
  writeSession(path.join(proj, 'session-baden.jsonl'), [
    header('baden'),
    '[1,2,3]',
    { type: 'user', parentId: 'baden', text: 'no id' },
    entry('user', 'u1', 'baden', { text: 'fine' }),
  ]);

  const listed = store.list().map((m) => m.id);
  assert.deepEqual(listed.filter((id) => id === 'bad-header'), [], 'a wrong-typed header is not listed');
  assert.ok(listed.includes('baden'), 'the healthy header still lists');

  const loaded = store.load(path.join(proj, 'session-baden.jsonl'));
  assert.deepEqual(loaded.entries.map((e) => e.id), ['u1']);
  assert.equal(store.load(path.join(proj, 'session-bad-header.jsonl')), null, 'no header object, no session');
});

test('an unknown entry type from a newer build is preserved, not dropped', () => {
  const dir = tmp();
  const file = path.join(dir, 'session-future.jsonl');
  writeSession(file, [
    header('future'),
    entry('user', 'u1', 'future', { text: 'hi' }),
    entry('widget', 'w1', 'u1', { payload: { shape: 'unseen' } }), // a future type
    entry('assistant', 'a1', 'w1', { text: 'ok' }),
  ]);

  const s = new SessionStore(dir).load(file);
  assert.deepEqual(s.entries.map((e) => e.type), ['user', 'widget', 'assistant'], 'unknown types ride along untouched');
  assert.deepEqual(s.find('w1').payload, { shape: 'unseen' });
  assert.equal(typeof s.meta().entryCount, 'number');
});

test('a compaction entry with no summary loads and still reads as a marker', () => {
  const dir = tmp();
  const file = path.join(dir, 'session-bare-compaction.jsonl');
  writeSession(file, [
    header('bare'),
    entry('user', 'u1', 'bare', { text: 'before' }),
    entry('compaction', 'c1', 'u1'), // an older or hand-edited write: no summary
    entry('user', 'u2', 'c1', { text: 'after' }),
  ]);

  const s = new SessionStore(dir).load(file);
  assert.deepEqual(s.entries.map((e) => e.type), ['user', 'compaction', 'user'], 'the marker rides along');
  assert.equal(s.find('c1').summary, undefined, 'nothing invents a summary');
  const md = s.toMarkdown(); // must not throw on the barest marker
  assert.match(md, /compacted: \(no summary\)/, 'the renderer says a summary is missing instead of printing undefined');
  assert.match(md, /after/, 'the rest of the transcript still renders');
});

test('an unknown entry type survives a header rewrite, not just a load', () => {
  const dir = tmp();
  const file = path.join(dir, 'session-future2.jsonl');
  writeSession(file, [
    header('future2'),
    entry('user', 'u1', 'future2', { text: 'hi' }),
    entry('widget', 'w1', 'u1', { payload: { shape: 'unseen' } }), // a future type
  ]);

  const store = new SessionStore(dir);
  store.rename(file, 'renamed after a newer build wrote it');

  const reloaded = store.load(file);
  assert.equal(reloaded.title, 'renamed after a newer build wrote it', 'the rename landed');
  assert.deepEqual(reloaded.find('w1').payload, { shape: 'unseen' }, 'the unknown entry rode the rewrite');
});

test('settings written by an older build merge over DEFAULTS — nothing to migrate', () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'home'), { recursive: true });
  // A file from a build that predates most keys, carrying one unknown key a
  // person put there deliberately — and a schema stamp from a "newer" build
  // than this one: an unknown key, preserved rather than interpreted.
  fs.writeFileSync(path.join(dir, 'home', 'settings.json'), JSON.stringify({ maxSteps: 7, myOwnKey: 'keep me', schema: 99 }));

  const settings = new Settings(path.join(dir, 'home'));
  assert.equal(settings.get('maxSteps'), 7, 'the stored value survives');
  assert.equal(settings.get('mode'), 'ask', 'missing keys take their defaults');
  assert.equal(settings.get('myOwnKey'), 'keep me', 'unknown keys are preserved, not dropped');
  assert.equal(settings.get('schema'), 99, "a newer build's schema stamp survives too");

  settings.set({ thinking: 'high' });
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'home', 'settings.json'), 'utf8'));
  assert.equal(onDisk.myOwnKey, 'keep me', 'a save keeps the unknown key too');
  assert.equal(onDisk.schema, 99, 'and the newer schema stamp');
  assert.equal(onDisk.thinking, 'high');
});

test('duplicate projects load once — first entry wins', () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'home'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'home', 'settings.json'), JSON.stringify({
    projects: [
      { name: 'a', path: 'C:\\p\\a' },
      { name: 'a again', path: 'C:\\p\\a' }, // same path, different name
      { name: 'b', path: 'C:\\p\\b' },
    ],
  }));
  const settings = new Settings(path.join(dir, 'home'));
  assert.deepEqual(settings.projectList().map((p) => p.path), ['C:\\p\\a', 'C:\\p\\b']);
  assert.equal(settings.projectList()[0].name, 'a', 'the first entry keeps its name');
});

test('HEADER_EVERY is what the docs say — the header is presentation, not truth', () => {
  const dir = tmp();
  const store = new SessionStore(dir);
  const s = store.create({ root: dir, model: 'm' });
  for (let i = 0; i < HEADER_EVERY + 2; i++) s.append('note', { text: `n${i}` });

  const onDisk = fs.readFileSync(s.file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(onDisk[0].type, 'header');
  assert.ok(onDisk[0].entryCount <= s.entries.length, 'the header may lag, never overstate');
  assert.equal(onDisk.length, s.entries.length + 1, 'every append is a line, whatever the header says');
});

test('deleting a session removes the file and the listing drops it', () => {
  const dir = tmp();
  const store = new SessionStore(path.join(dir, 'store'));
  const root = path.join(dir, 'proj');
  const s = store.create({ root, title: 'doomed' });
  assert.equal(store.list(root).length, 1);

  store.remove(s.id);
  assert.equal(store.load(s.id), null, 'the session no longer loads');
  assert.deepEqual(store.list(root), [], 'and the picker no longer lists it');
  assert.equal(store.remove(s.id), false, 'a repeat remove is a no-op');
});

test('a new session header records the app that wrote it, through a rewrite', () => {
  const dir = tmp();
  const store = new SessionStore(path.join(dir, 'store'));
  const s = store.create({ root: path.join(dir, 'proj'), title: 'stamped' });
  const pkg = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.equal(s.header.app, pkg.version, 'the header names the build');
  assert.equal(store.load(s.id).header.app, pkg.version, 'and it round-trips through the file');

  // The first append rewrites the header in place; fields the module does not
  // know (a newer build's header field included) must ride that rewrite.
  s.header.fromNewer = 'kept';
  s.append('note', { text: 'one' });
  const reloaded = store.load(s.id);
  assert.equal(reloaded.header.app, pkg.version, 'app survives the rewrite');
  assert.equal(reloaded.header.fromNewer, 'kept', 'and so does a field from a newer build');
});

// The store is the sensitive data class (SECURITY.md, Data classes): a session
// holds the user's own words and the model's work, and staged uploads are
// copies of the user's files. Where the OS has POSIX modes everything this
// code creates is owner-only, and opening an old file tightens it. Windows
// keeps ACLs instead of modes, so the assertions are skipped there.
test('the session and upload stores are owner-only where the OS has modes',
  { skip: process.platform === 'win32' }, () => {
    const dir = tmp();
    const store = new SessionStore(path.join(dir, 'sessions'));
    assert.equal(fs.statSync(store.dir).mode & 0o777, 0o700, 'the store dir is 0o700');

    const s = store.create({ root: path.join(dir, 'proj'), title: 'modes' });
    assert.equal(fs.statSync(s.file).mode & 0o777, 0o600, 'a new session file is 0o600');
    assert.equal(fs.statSync(path.dirname(s.file)).mode & 0o777, 0o700, 'the per-project dir is 0o700');

    // A file an older build wrote readable is tightened when it is opened.
    fs.chmodSync(s.file, 0o644);
    assert.ok(store.load(s.file), 'the session still loads');
    assert.equal(fs.statSync(s.file).mode & 0o777, 0o600, 'an opened old file turns owner-only');

    const settings = new Settings(path.join(dir, 'home'));
    assert.equal(fs.statSync(settings.uploadDir()).mode & 0o777, 0o700, 'the upload staging dir is 0o700');
  });
