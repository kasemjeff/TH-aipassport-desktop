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
import { Overlay } from '../harness/overlay.mjs';

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
  const store = new SessionStore(path.join(dir, 'store'));
  // The fixture lives INSIDE the store: a session handle may only name a file
  // in the store's own directories (an id that carried a separator used to be
  // taken as a raw path, and `session.delete` deleted whatever it named), and
  // the torn line — not the path — is what this test is about.
  const file = path.join(store.dir, 'session-torn.jsonl');
  writeSession(file, [
    header('torn', { entryCount: 2 }),
    entry('user', 'u1', 'torn', { text: 'hello' }),
    '{"type":"assistant","id":"a1","paren', // killed mid-write
  ]);

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

test('remove() reports the file gone, and archiveIdle moves only idle sessions', () => {
  const dir = tmp();
  const store = new SessionStore(path.join(dir, 'store'));
  const root = path.join(dir, 'proj');
  const now = Date.now();

  // remove: the old return read existsSync() AFTER deletion — always false
  // on success is the wrong polarity for "did it go away".
  const s = store.create({ root, title: 'gone' });
  assert.equal(store.remove(s.id), true, 'a removed session reports gone');

  // archive: one idle, one fresh, one live-but-idle. Only the first moves.
  const idle = store.create({ root, title: 'idle' });
  const fresh = store.create({ root, title: 'fresh' });
  const live = store.create({ root, title: 'live' });
  const touch = (session, updated) => {
    const loaded = store.load(session.id);
    loaded.header.updated = updated;
    fs.writeFileSync(loaded.file, fs.readFileSync(loaded.file, 'utf8').replace(/"updated":\d+/, `"updated":${updated}`));
  };
  touch(idle, now - 40 * 24 * 3600 * 1000);
  touch(live, now - 40 * 24 * 3600 * 1000);
  touch(fresh, now);

  const out = store.archiveIdle(root, { olderThanMs: 30 * 24 * 3600 * 1000, limit: 50, keepId: live.id });
  assert.deepEqual(out.archived, [idle.id], 'only the idle non-live session moves');
  assert.equal(store.list(root).some((e) => e.id === idle.id), false, 'archived leaves the picker');
  assert.equal(store.list(root).some((e) => e.id === fresh.id), true, 'fresh stays');
  assert.equal(store.list(root).some((e) => e.id === live.id), true, 'live stays even when idle');
});

test('an archived session can be taken back', () => {
  // The archive is a place a session can be put AND a place it can be taken
  // from. Without a way back, "archive" was a one-way door and a session that
  // went in could only come out by hand.
  const dir = tmp();
  const store = new SessionStore(path.join(dir, 'store'));
  const root = path.join(dir, 'proj');
  const idle = store.create({ root, title: 'idle' });
  const live = store.create({ root, title: 'live' });

  store.archiveIdle(root, { olderThanMs: 1, keepId: live.id });
  assert.equal(store.list(root).some((e) => e.id === idle.id), false, 'it left the picker');
  const archived = store.listArchived(root);
  assert.equal(archived.some((e) => e.id === idle.id), true, 'and it is in the archive');

  assert.equal(store.restore(idle.id, { root }), true, 'and it comes back');
  assert.equal(store.list(root).some((e) => e.id === idle.id), true, 'into the picker');
  assert.equal(store.load(idle.id, { root })?.title, 'idle', 'and it still opens');
  assert.equal(store.listArchived(root).length, 0, 'the archive is empty again');
});

test('an archive under the old project folder still lists and restores', () => {
  // The project folder gained a path hash, but the archive an older build left
  // one directory over is still this project's work. Reading only the new
  // folder made those sessions look deleted even though their bytes were
  // intact, and the way back could not find them.
  const dir = tmp();
  const store = new SessionStore(path.join(dir, 'store'));
  const root = path.join(dir, 'proj');
  const old = store.create({ root, title: 'archived before the rename' });
  const legacyArchive = path.join(store.legacyDirFor(root), 'archive');
  fs.mkdirSync(legacyArchive, { recursive: true });
  const legacyFile = path.join(legacyArchive, path.basename(old.file));
  fs.renameSync(old.file, legacyFile);

  assert.equal(store.list(root).some((e) => e.id === old.id), false, 'it is not a live session');
  const archived = store.listArchived(root);
  assert.equal(archived.some((e) => e.id === old.id), true, 'but it is still in the archive');
  assert.equal(archived.find((e) => e.id === old.id)?.file, legacyFile, 'with its old path');

  assert.equal(store.restore(old.id, { root }), true, 'and the way back finds it');
  assert.equal(store.list(root).some((e) => e.id === old.id), true, 'it comes back to the picker');
  assert.equal(fs.existsSync(legacyFile), false, 'the old copy is gone');
  assert.equal(store.listArchived(root).length, 0, 'the old archive is empty');
});

test('the old archive is pruned too, so it cannot keep files forever', () => {
  // Pruning is the one place that deletes. If it reads only the new folder,
  // sessions archived by an older build can never age out - and nobody can
  // see them to ask why the disk is growing.
  const dir = tmp();
  const store = new SessionStore(path.join(dir, 'store'));
  const root = path.join(dir, 'proj');
  const old = store.create({ root, title: 'old archived' });
  const legacyArchive = path.join(store.legacyDirFor(root), 'archive');
  fs.mkdirSync(legacyArchive, { recursive: true });
  const legacyFile = path.join(legacyArchive, path.basename(old.file));
  fs.renameSync(old.file, legacyFile);

  const out = store.pruneArchived(root, { olderThanMs: -1 });
  assert.deepEqual(out.pruned, [old.id], 'the old archive entry is pruned');
  assert.equal(fs.existsSync(legacyFile), false, 'and its file is gone');
});

test('a session of another project is not reachable by its path either', () => {
  // The window lists sessions with their path, and a path names a session at
  // least as precisely as an id does. The guard on the id branch was a guard
  // on one spelling of the handle only.
  const dir = tmp();
  const store = new SessionStore(path.join(dir, 'store'));
  const here = path.join(dir, 'here');
  const there = path.join(dir, 'there');
  fs.mkdirSync(here); fs.mkdirSync(there);
  const theirs = store.create({ root: there, title: 'theirs' });
  theirs.append('user', { text: 'a secret of another project' });

  assert.equal(store.resolveFile(theirs.file, { root: here }), null, 'the path does not resolve');
  assert.equal(store.load(theirs.file, { root: here }), null, 'and the session does not open');
  assert.equal(store.remove(theirs.file, { root: here }), false, 'and it is not deleted');
  assert.equal(fs.existsSync(theirs.file), true, 'the file is still there');
  const foreign = store.foreignFor(theirs.file, { root: here });
  assert.equal(foreign?.root, path.resolve(there), 'the refusal names the project it belongs to');
});

test('two projects whose readable names collide get their own session folders', () => {
  // The folder name carries a hash of the whole path, so `a b` and `a-b` -
  // one slug under the old naming - no longer share a bucket, and two long
  // temporary paths that differ only past the old 60-character cut do not
  // either.
  const dir = tmp();
  const store = new SessionStore(path.join(dir, 'store'));
  const a = path.join(dir, 'a b');
  const b = path.join(dir, 'a-b');
  const long = 'a'.repeat(80);
  const c = path.join(dir, `${long}-one`);
  const d = path.join(dir, `${long}-two`);
  fs.mkdirSync(a); fs.mkdirSync(b);
  const mine = store.create({ root: a, title: 'mine' });
  const theirs = store.create({ root: b, title: 'theirs' });

  assert.notEqual(store.dirFor(a), store.dirFor(b), 'a hash keeps two paths apart when the readable part matches');
  assert.notEqual(store.dirFor(c), store.dirFor(d), 'and when the difference is past the old 60-character cut');
  assert.deepEqual(store.list(a).map((s) => s.id), [mine.id], 'each project sees its own');
  assert.deepEqual(store.list(b).map((s) => s.id), [theirs.id], 'and only its own');
});

test('a relocation does not carry another project\'s sessions with it', () => {
  const dir = tmp();
  const store = new SessionStore(path.join(dir, 'store'));
  const a = path.join(dir, 'a b');
  const b = path.join(dir, 'a-b');
  fs.mkdirSync(a); fs.mkdirSync(b);
  store.create({ root: a, title: 'mine' });
  const theirs = store.create({ root: b, title: 'theirs' });

  const out = store.reassign(a, path.join(dir, 'moved'));
  assert.equal(out.moved, 1, 'only this project\'s session moves');
  assert.equal(fs.existsSync(theirs.file), true, 'the neighbour\'s session is still on disk');
  const header = JSON.parse(fs.readFileSync(theirs.file, 'utf8').split('\n')[0]);
  assert.equal(header.root, path.resolve(b), 'and it still names its own project');
});

test('two writers on one session do not lose each other\'s header changes', () => {
  // The desktop backend and the CLI write the same store, and a window can be
  // open on a project while a command line runs in it. A header rewrite is a
  // read-modify-write: without a lock and a merge, the second writer puts
  // back a copy of the header that is older than the file's.
  const dir = tmp();
  const store = new SessionStore(path.join(dir, 'store'));
  const root = path.join(dir, 'proj');
  const shared = store.create({ root, title: 'shared' });
  const w1 = store.load(shared.id, { root });
  const w2 = store.load(shared.id, { root });

  store.rename(shared.id, 'renamed', { root });
  w2.append('user', { text: 'after the rename' });
  let head = JSON.parse(fs.readFileSync(shared.file, 'utf8').split('\n')[0]);
  assert.equal(head.title, 'renamed', 'a rename survives the other writer\'s append');

  w1.bindConversation('conv-1', true);
  w2.append('user', { text: 'after the binding' });
  head = JSON.parse(fs.readFileSync(shared.file, 'utf8').split('\n')[0]);
  assert.equal(head.conversation, 'conv-1', 'and so does the conversation binding');

  const before = head.entryCount;
  w1.append('user', { text: 'one more' });
  head = JSON.parse(fs.readFileSync(shared.file, 'utf8').split('\n')[0]);
  assert.ok(head.entryCount >= before, 'and the count never goes backwards');
  assert.equal(store.load(shared.id, { root }).entries.length, 3, 'every entry is on disk');
});

test('a session id is not a birthday collision waiting to happen', () => {
  // A session id is a FILE NAME, so a collision is not a key that gets
  // refused: the new session replaces the old one and the whole conversation
  // is gone without a word. 32 bits of Math.random made that a question of
  // how many sessions a machine has; 48 bits of the crypto module does not.
  const dir = tmp();
  const store = new SessionStore(path.join(dir, 'store'));
  const root = path.join(dir, 'proj');
  const ids = new Set();
  for (let i = 0; i < 400; i++) ids.add(store.create({ root }).id);
  assert.equal(ids.size, 400, 'every id is its own');
  assert.ok([...ids][0].length >= 12, 'and long enough that the birthday is far away');
});

test('a session file that is too large to open is refused, not loaded', () => {
  // A session grows by appends and nothing trims it. A file this size is a
  // memory bomb in a desktop app that also holds a browser, so it is refused
  // with a reason instead of taking the window down with it.
  const dir = tmp();
  const store = new SessionStore(path.join(dir, 'store'));
  const root = path.join(dir, 'proj');
  const s = store.create({ root, title: 'huge' });
  s.append('user', { text: 'x'.repeat(5000) });
  const before = process.env.AIPASS_MAX_SESSION_BYTES;
  process.env.AIPASS_MAX_SESSION_BYTES = '1024';
  try {
    assert.throws(() => store.load(s.id, { root }), /too large/, 'the session is refused with a reason');
  } finally {
    if (before === undefined) delete process.env.AIPASS_MAX_SESSION_BYTES;
    else process.env.AIPASS_MAX_SESSION_BYTES = before;
  }
  assert.ok(store.load(s.id, { root }), 'and it opens again once the ceiling is back');
});

test('a finished session is flushed to the disk', () => {
  // The header rewrite fsyncs the file once per batch, so the entries of a
  // finished run must not sit in the OS's hands: a power cut would take the
  // end of the conversation with it.
  const dir = tmp();
  const store = new SessionStore(path.join(dir, 'store'));
  const root = path.join(dir, 'proj');
  const s = store.create({ root, title: 'durable' });
  const real = fs.fsyncSync;
  let flushed = 0;
  fs.fsyncSync = function spied(...args) { flushed += 1; return real.apply(this, args); };
  try {
    s.append('user', { text: 'one' });
    // The first append rewrites the header, and the rewrite flushes the file
    // with it — the entries and the header that counts them land together.
    const afterFirst = flushed;
    assert.ok(afterFirst > 0, 'the first append flushes the file it counts');
    s.append('user', { text: 'two' });
    assert.equal(flushed, afterFirst, 'an append that does not rewrite the header does not flush');
    s.flush();
    assert.ok(flushed > afterFirst, 'but a finished session does');
  } finally { fs.fsyncSync = real; }
});

test('the picker sees a renamed session, and a memoized header does not hide it', () => {
  // The store memoizes the headers it has read, on the file's mtime+size, so
  // the picker does not open and parse every session on every refresh. A
  // memo that hid a change would be worse than the cost it saves.
  const dir = tmp();
  const store = new SessionStore(path.join(dir, 'store'));
  const root = path.join(dir, 'proj');
  const s = store.create({ root, title: 'before' });
  assert.equal(store.list(root)[0].title, 'before', 'the picker shows the name');
  store.rename(s.id, 'after');
  assert.equal(store.list(root)[0].title, 'after', 'and the new one after a rename');
  s.append('user', { text: 'an entry' });
  const row = store.list(root)[0];
  assert.equal(typeof row.entries, 'number', 'the row carries a count');
  assert.ok(row.entries >= 0, 'and it is a number');
  assert.equal(store.list(root).length, 1, 'the session is still there');
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

test('an entry-shaped first line is skipped like a torn one', () => {
  const dir = tmp();
  const proj = path.join(dir, 'proj');
  fs.mkdirSync(proj, { recursive: true });
  // A file whose header line was lost — something appended to it after an
  // external delete — starts with an entry. Every entry carries a string id,
  // so the picker's old "object with an id" test listed it as a session that
  // then refused to open. A line is a header only when it says so.
  writeSession(path.join(proj, 'session-orphan1.jsonl'), [entry('note', 'n1', null, { text: 'x' })]);
  const store = new SessionStore(dir);
  assert.equal(store.list().some((m) => m.id === 'n1'), false, 'an entry is not a picker header');
  assert.equal(store.load(path.join(proj, 'session-orphan1.jsonl')), null, 'and it does not load as a session');
});

test('a torn header costs the session nothing — the breadcrumb carries it', () => {
  const dir = tmp();
  const store = new SessionStore(path.join(dir, 'store'));
  const proj = path.join(dir, 'proj');
  const s = store.create({ root: proj, title: 'crashed' });
  s.append('user', { text: 'hello' });
  s.append('assistant', { text: 'hi' });

  // A power loss mid in-place header rewrite: the first line is torn and the
  // breadcrumb the rewrite writes before it is still there. Before the
  // breadcrumb this was a session lost — skipped by the picker, null from
  // load(), entries sitting on disk with nobody able to open them.
  const raw = fs.readFileSync(s.file, 'utf8');
  fs.writeFileSync(s.file, '{"type":"hea\n' + raw.slice(raw.indexOf('\n') + 1));
  fs.writeFileSync(`${s.file}.hdr`, JSON.stringify(s.header) + '\n');

  const listed = store.list(proj).find((m) => m.id === s.id);
  assert.ok(listed, 'the picker still shows it');
  assert.equal(listed.title, 'crashed', 'with the header the breadcrumb kept');

  const loaded = store.load(s.id);
  assert.ok(loaded, 'the session opens');
  assert.equal(loaded.title, 'crashed');
  assert.deepEqual(loaded.entries.map((e) => e.type), ['user', 'assistant'], 'and every entry is there');
  assert.equal(fs.existsSync(`${s.file}.hdr`), false, 'the repair deletes the breadcrumb');
  assert.equal(JSON.parse(fs.readFileSync(s.file, 'utf8').split('\n')[0]).title, 'crashed', 'the first line is a header again');

  const reread = store.load(s.id); // no breadcrumb involved this time
  assert.equal(reread.title, 'crashed');
  assert.deepEqual(reread.entries.map((e) => e.type), ['user', 'assistant']);
});

test('a breadcrumb left by a crash that damaged nothing is cleaned up on load', () => {
  const dir = tmp();
  const store = new SessionStore(path.join(dir, 'store'));
  const s = store.create({ root: path.join(dir, 'proj'), title: 'fine' });
  s.append('note', { text: 'x' });
  // Crash between the breadcrumb write and the in-place write: the first line
  // is the old (valid) header and the breadcrumb holds the newer one. The
  // interrupted rewrite rolls back to what the file actually says.
  fs.writeFileSync(`${s.file}.hdr`, JSON.stringify({ ...s.header, title: 'stale' }) + '\n');
  const loaded = store.load(s.id);
  assert.equal(loaded.title, 'fine', 'the valid first line answers first');
  assert.equal(fs.existsSync(`${s.file}.hdr`), false, 'the leftover breadcrumb goes');
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
  // Platform-absolute paths: Settings.projectList() resolves each entry with
  // path.resolve(), which is a no-op for an already-absolute path on Windows
  // but would otherwise anchor a relative value to cwd (and silently pass on
  // Windows while failing on POSIX). Build the inputs already resolved so the
  // assertion is identical on every OS.
  const root = path.parse(process.cwd()).root; // 'C:\\' on Windows, '/' on POSIX
  const pa = path.resolve(root, 'p', 'a');
  const pb = path.resolve(root, 'p', 'b');
  fs.writeFileSync(path.join(dir, 'home', 'settings.json'), JSON.stringify({
    projects: [
      { name: 'a', path: pa },
      { name: 'a again', path: pa }, // same path, different name
      { name: 'b', path: pb },
    ],
  }));
  const settings = new Settings(path.join(dir, 'home'));
  assert.deepEqual(settings.projectList().map((p) => p.path), [pa, pb]);
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

// The answer is "did I remove it?", so a removal that worked has to say so.
// The existence check used to run after the unlink, so the answer was always
// no — and the only test of it asserted the repeat case, which is no either
// way.
test('a removal says whether it removed anything', () => {
  const dir = tmp();
  const store = new SessionStore(path.join(dir, 'store'));
  const s = store.create({ root: path.join(dir, 'proj'), title: 'doomed' });
  assert.equal(store.remove(s.id), true, 'the first removal did the work');
  assert.equal(store.remove(s.id), false, 'and the second found nothing');
});

// The header may lag, never overstate — and a fork's header was a copy of
// the parent's, so a fork from one entry claimed the parent's whole count.
test('a forked session states its own entry count, never the parent\'s', () => {
  const dir = tmp();
  const store = new SessionStore(path.join(dir, 'store'));
  const s = store.create({ root: path.join(dir, 'proj'), title: 'parent' });
  s.append('user', { text: 'one' });
  s.append('assistant', { text: 'two' });
  s.append('user', { text: 'three' });
  s.append('assistant', { text: 'four' });

  const fork = s.fork(store, { fromEntryId: s.entries[1].id });
  assert.equal(fork.entries.length, 2, 'the fork holds the prefix');
  assert.equal(fork.header.entryCount, 2, 'and the header says so');
  assert.ok(fork.header.entryCount < s.header.entryCount, 'not the parent\'s count');

  // and the file on disk agrees, so the listing does not overstate either
  const reloaded = store.load(fork.id);
  assert.equal(reloaded.header.entryCount, 2, 'the count round-trips through the file');
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

test('a session records the conversation it works in; a fork starts unbound', () => {
  const dir = tmp();
  const store = new SessionStore(path.join(dir, 'store'));
  const s = store.create({ root: path.join(dir, 'proj'), title: 'bound' });
  assert.equal(s.bindConversation('conv-1', true), 'conv-1');
  const reloaded = store.load(s.id);
  assert.equal(reloaded.header.conversation, 'conv-1', 'the binding round-trips through the file');
  assert.equal(reloaded.header.conversationTemporary, true, 'and so does the temporary flag');

  // A fork is a new branch, not a second writer: it must not inherit the
  // conversation the original is still working in.
  const fork = reloaded.fork(store);
  assert.equal(fork.header.conversation, undefined, 'the fork starts unbound');
  assert.equal(store.load(fork.id).header.conversation, undefined, 'on disk too');

  // Rebinding overwrites; clearing removes both fields.
  reloaded.bindConversation('conv-2');
  assert.equal(store.load(s.id).header.conversation, 'conv-2');
  assert.equal(store.load(s.id).header.conversationTemporary, false, 'a missing temporary flag reads as false');
  reloaded.bindConversation(null);
  assert.equal(store.load(s.id).header.conversation, undefined, 'cleared');
  assert.equal(store.load(s.id).header.conversationTemporary, undefined, 'both fields go');
});

test('a memory save that cannot complete leaves the previous facts intact', async () => {
  const home = tmp();
  const prev = process.env.AIPASS_HOME;
  process.env.AIPASS_HOME = home;
  try {
    // Imported here, with the home in place, because the store directory is
    // computed from it at module load.
    const { saveMemory, loadMemory, memoryPath } = await import('../harness/memory-store.mjs');
    const root = path.join(home, 'proj');
    saveMemory(root, ['fact one']);
    assert.deepEqual(loadMemory(root), ['fact one']);

    const before = fs.readFileSync(memoryPath(root), 'utf8');
    // The swap cannot land. The temp file's name is unique per write now, so
    // it cannot be blocked by planting something at a known path — the
    // DESTINATION is what the swap cannot take away: read-only on Windows, a
    // read-only directory on POSIX.
    const target = memoryPath(root);
    if (process.platform === 'win32') {
      fs.chmodSync(target, 0o444);
      saveMemory(root, ['fact two']);        // best effort: never throws
      fs.chmodSync(target, 0o600);
    } else {
      fs.chmodSync(path.dirname(target), 0o555);
      saveMemory(root, ['fact two']);        // best effort: never throws
      fs.chmodSync(path.dirname(target), 0o755);
    }
    assert.equal(fs.readFileSync(memoryPath(root), 'utf8'), before, 'the old facts survive a failed save');

    saveMemory(root, ['fact two']);
    assert.deepEqual(loadMemory(root).sort(), ['fact one', 'fact two'], 'and the next save lands');
  } finally {
    if (prev === undefined) delete process.env.AIPASS_HOME;
    else process.env.AIPASS_HOME = prev;
  }
});

test('the cross-session store follows the home it is given, not the real one', async () => {
  // The store's directory is resolved when it is used, not when the module
  // loads: a caller that points AIPASS_HOME at a scratch home after the
  // import (the suite does) must still land there. A path frozen at load time
  // wrote the suite's facts into the developer's real ~/.aipass/memory — one
  // file per temp root, every run.
  const home = tmp();
  const prev = process.env.AIPASS_HOME;
  process.env.AIPASS_HOME = home;
  try {
    const { saveMemory, loadMemory, memoryPath } = await import('../harness/memory-store.mjs');
    const root = path.join(home, 'proj');
    saveMemory(root, ['fact one']);
    assert.deepEqual(loadMemory(root), ['fact one'], 'the fact lands and reads back');
    assert.ok(memoryPath(root).startsWith(path.join(home, 'memory')), 'in the home it was given');
    assert.ok(
      !memoryPath(root).startsWith(path.join(os.homedir(), '.aipass', 'memory')),
      'and never in the real one'
    );
  } finally {
    if (prev === undefined) delete process.env.AIPASS_HOME;
    else process.env.AIPASS_HOME = prev;
  }
});

test('an applied edit replaces a file in one swap and keeps its mode', () => {
  const dir = tmp();
  const file = path.join(dir, 'script.sh');
  fs.writeFileSync(file, 'echo old\n');
  try { fs.chmodSync(file, 0o755); } catch { /* Windows keeps ACLs */ }

  const overlay = new Overlay(dir);
  overlay.set(overlay.safe('script.sh'), 'echo new\n');
  const out = overlay.applyToDisk();
  assert.deepEqual(out.files, ['script.sh']);
  assert.equal(fs.readFileSync(file, 'utf8'), 'echo new\n', 'the staged text is the file');
  assert.equal(fs.existsSync(`${file}.tmp`), false, 'the swap leaves no temp behind');
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(file).mode & 0o777, 0o755, 'the exec bit survives the replacement');
  }
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
