// The undo of an apply (harness/checkpoints.mjs).
//
// A run stages its edits, the person applies them, and the bytes that were on
// the disk before the apply are what a restore puts back. The store lives
// OUTSIDE the project (root rule 1) — a copy of the user's source inside the
// project could be committed by accident — so the first thing these tests
// check is that nothing of the checkpoint's lands in the tree.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Overlay } from '../harness/overlay.mjs';
import { applyOverlay } from '../harness/loop.mjs';
import { Harness } from '../harness/harness.mjs';
import { list, restore, remove, storeRoot, KEEP } from '../harness/checkpoints.mjs';

// The store lives under the home, so the home is a temp directory of this
// test's own — never the developer's ~/.aipass.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aipass-ckpt-home-'));
process.env.AIPASS_HOME = HOME;

const dirs = [];
const tempDir = (files = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aipass-ckpt-'));
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

/** Every file under a tree, relative — the shape the project is compared in. */
const walk = (dir, base = dir) => {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, base));
    else out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out.sort();
};

test('an applied change can be restored', () => {
  const root = tempDir({ 'a.txt': 'before\n' });
  const overlay = new Overlay(root);
  overlay.set(path.join(root, 'a.txt'), 'after\n');

  const applied = applyOverlay(overlay);

  assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'after\n', 'the apply wrote the file');
  assert.ok(applied.checkpoint?.id, 'the apply left a checkpoint behind');

  const back = restore({ root, id: applied.checkpoint.id });

  assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'before\n', 'the restore put the old bytes back');
  assert.deepEqual(back.restored, ['a.txt'], 'and it says what it changed');
});

test('a restore puts the bytes back exactly', () => {
  // A BOM, CRLF line endings and Thai text: the bytes a text round-trip
  // would quietly change. The restore writes the bytes that were there, not
  // a re-encoding of them.
  const original = Buffer.from('\uFEFFสวัสดี\r\nsecond line\r\n', 'utf8');
  const root = tempDir({ 'notes.txt': original });
  const overlay = new Overlay(root);
  overlay.set(path.join(root, 'notes.txt'), 'replaced\n');

  const applied = applyOverlay(overlay);
  assert.notDeepEqual(fs.readFileSync(path.join(root, 'notes.txt')), original, 'the file really changed');

  restore({ root, id: applied.checkpoint.id });

  assert.deepEqual(fs.readFileSync(path.join(root, 'notes.txt')), original, 'the bytes are the ones that were there');
});

test('a checkpoint never lands inside the project', () => {
  const root = tempDir({ 'a.txt': 'before\n', 'src/b.txt': 'b\n' });
  const before = walk(root);

  const overlay = new Overlay(root);
  overlay.set(path.join(root, 'a.txt'), 'after\n');
  overlay.set(path.join(root, 'src', 'b.txt'), 'after too\n');
  const applied = applyOverlay(overlay);

  assert.ok(applied.checkpoint?.id, 'the apply left a checkpoint behind');
  assert.deepEqual(walk(root), before, 'the project holds no trace of the checkpoint');
  const store = storeRoot();
  assert.ok(store.startsWith(HOME), 'the store is under the home');
  assert.ok(!store.startsWith(root), 'and never inside the project');
  // The bytes live there, though — the store is where the undo comes from.
  const held = fs.readdirSync(store)
    .map((key) => path.join(store, key, applied.checkpoint.id, 'meta.json'))
    .find((meta) => fs.existsSync(meta));
  assert.ok(held, 'the checkpoint is in the store, under the home');
});

test('a checkpoint of a new file removes the file when it is restored', () => {
  const root = tempDir({});
  const overlay = new Overlay(root);
  overlay.set(path.join(root, 'new.txt'), 'hello\n');

  const applied = applyOverlay(overlay);
  assert.ok(fs.existsSync(path.join(root, 'new.txt')), 'the apply created the file');

  const back = restore({ root, id: applied.checkpoint.id });

  assert.ok(!fs.existsSync(path.join(root, 'new.txt')), 'the file is gone again');
  assert.deepEqual(back.removed, ['new.txt'], 'and the restore says so');
});

test('the checkpoints of a project are listed newest first, and the oldest are pruned', () => {
  const root = tempDir({ 'a.txt': 'x\n' });
  for (let i = 0; i < KEEP + 3; i++) {
    const overlay = new Overlay(root);
    overlay.set(path.join(root, 'a.txt'), `v${i}\n`);
    applyOverlay(overlay);
  }

  const found = list({ root });

  assert.equal(found.length, KEEP, 'the store keeps the newest checkpoints only');
  const times = found.map((c) => c.createdAt);
  assert.deepEqual(times, [...times].sort((a, b) => b - a), 'newest first');
  assert.ok(found[0].files.some((f) => f.path === 'a.txt'), 'a checkpoint names the files it holds');
});

test('a checkpoint can be forgotten without restoring it', () => {
  const root = tempDir({ 'a.txt': 'before\n' });
  const overlay = new Overlay(root);
  overlay.set(path.join(root, 'a.txt'), 'after\n');
  const applied = applyOverlay(overlay);

  const gone = remove({ root, id: applied.checkpoint.id });

  assert.equal(gone.removed, true);
  assert.equal(list({ root }).length, 0, 'the checkpoint is gone');
  assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'after\n', 'and the file stays as it was written');
});

test('a checkpoint name is a name, not a path', () => {
  // The id comes from the window, and `remove` deletes what it is given: a
  // name with a separator in it must never reach out of the store.
  const root = tempDir({ 'a.txt': 'before\n' });
  const outside = path.join(root, '..', 'aipass-not-a-checkpoint');
  fs.mkdirSync(outside, { recursive: true });

  assert.throws(() => remove({ root, id: '../aipass-not-a-checkpoint' }), /not a checkpoint name/);
  assert.throws(() => restore({ root, id: '..' }), /not a checkpoint name/);
  assert.ok(fs.existsSync(outside), 'nothing outside the store was touched');
  fs.rmSync(outside, { recursive: true, force: true });
});

test('the window\'s apply button goes through the same checkpoint', async () => {
  // The facade is what the window and the CLI both call: `harness.apply()`
  // writes the same files the way the button does, so the checkpoint has to
  // be there too.
  const root = tempDir({ 'a.txt': 'before\n' });
  const h = new Harness({ root, client: { model: 'stub' }, store: 'off' });
  h.overlay.set(path.join(root, 'a.txt'), 'after\n');

  const result = h.apply();

  assert.ok(result.checkpoint?.id, 'the apply left a checkpoint behind');
  restore({ root, id: result.checkpoint.id });
  assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'before\n', 'and the restore undoes it');
});
