/**
 * A write into a directory the projection SHARES with the real project.
 *
 * The heavy folders (node_modules, dist) are LINKED into the projection, not
 * copied — a copy of a node_modules costs a minute per run. A write through
 * that link therefore lands in the user's own tree, which breaks the rule the
 * repo holds itself to: the overlay is the only write surface of a run, and
 * the projection lives outside the project.
 *
 * So the write is refused in two places: when the change is staged (the model
 * is told, and it can choose another path), and at the moment of the apply
 * (for a change staged before the rule existed). Both refusals name the
 * folder, because the model has to know WHICH one it may not write to.
 *
 * Run: node --test aipass-bridge/test/shared-write-refusal.test.mjs
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Overlay } from '../harness/overlay.mjs';
import { createTools } from '../harness/tools.mjs';
import { applyOverlay } from '../harness/loop.mjs';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aipass-shared-home-'));
process.env.AIPASS_HOME = HOME;
after(() => fs.rmSync(HOME, { recursive: true, force: true }));

/** A project with one heavy folder and one ordinary file. */
const project = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aipass-shared-'));
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello\n');
  fs.mkdirSync(path.join(dir, 'node_modules', 'dep'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules', 'dep', 'index.js'), 'the real one\n');
  return dir;
};

test('a staged write into a shared heavy directory is refused', async () => {
  const dir = project();
  try {
    const tools = createTools({ root: dir, overlay: new Overlay(dir) });
    const answer = String(await tools.write('node_modules/dep/index.js', 'the staged one\n'));
    assert.match(answer, /^err: /, 'the refusal has the house shape');
    assert.match(answer, /node_modules/, 'and it names the folder');
    assert.equal(
      fs.readFileSync(path.join(dir, 'node_modules', 'dep', 'index.js'), 'utf8'),
      'the real one\n',
      'the real file is untouched',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an apply does not write into a shared heavy directory', async () => {
  // A change staged before the rule existed still sits in the overlay; the
  // apply is the last gate before the disk, so it refuses there and says so.
  const dir = project();
  try {
    const overlay = new Overlay(dir);
    overlay.set(path.join(dir, 'node_modules', 'dep', 'index.js'), 'the staged one\n');
    const notes = [];
    const result = applyOverlay(overlay, null, { events: { emit: (_t, p) => notes.push(p.text) } });
    assert.equal(
      fs.readFileSync(path.join(dir, 'node_modules', 'dep', 'index.js'), 'utf8'),
      'the real one\n',
      'the real tree is untouched',
    );
    assert.equal(result.files.length, 0, 'and nothing was applied');
    assert.ok(notes.some((n) => /node_modules/.test(n)), 'the refusal is named, not silent');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a read into a shared heavy directory still works', async () => {
  // The rule is about WRITES. A model may read a dependency — refusing that
  // would make the folder useless.
  const dir = project();
  try {
    const tools = createTools({ root: dir, overlay: new Overlay(dir) });
    const answer = String(await tools.read('node_modules/dep/index.js'));
    assert.match(answer, /the real one/, 'the read came back');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
