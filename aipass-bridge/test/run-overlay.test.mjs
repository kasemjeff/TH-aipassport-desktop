// RUN-vs-overlay, the gap of the 2026-10-15 smoke: a staged fix never reached
// the child process, so `node check.mjs` read the stale disk copy, concluded
// the save had failed, and the run burned itself re-editing. A RUN now sees
// the staged tree — projected into a throwaway copy under `.aipass/run` that
// is deleted afterwards — and the real paths are never written.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempDir } from './harness.mjs';
import { Overlay } from '../harness/overlay.mjs';
import { SkillLibrary } from '../harness/skills.mjs';
import { createTools } from '../harness/tools.mjs';
import { createSandbox, materializeTree, restorePaths } from '../harness/sandbox.mjs';

const toolsAt = (dir, overlay) => createTools({
  root: dir, overlay, skills: new SkillLibrary([]), allowRun: true, maxResult: 6000,
});

const BROKEN_MATH = 'export const add = (a, b) => a - b;\n';
const FIXED_MATH = 'export const add = (a, b) => a + b;\n';
const CHECK = "import { add } from './math.mjs';\nif (add(2, 3) !== 5) { console.log('FAIL'); process.exit(1); }\nconsole.log('PASS');\n";

test('a staged file shows up in listings (issue #32)', () => {
  const dir = tempDir({ 'real.txt': 'on disk\n' });
  const overlay = new Overlay(dir);
  overlay.set(path.join(dir, 'staged.txt'), 'staged, not yet applied\n');
  overlay.set(path.join(dir, 'sub', 'nested.txt'), 'nested staged\n');
  const names = new Set(['real.txt']);
  overlay.mergeIntoListing(dir, names);
  assert.ok(names.has('staged.txt'), 'staged top-level file is listed');
  assert.ok(names.has('sub/'), 'staged nested file surfaces its directory');
  assert.ok(names.has('real.txt'), 'on-disk files are untouched');
  // A file outside the listed directory never leaks in.
  const other = new Set();
  overlay.mergeIntoListing(path.join(dir, 'sub'), other);
  assert.ok(!other.has('staged.txt'), 'sibling staged file stays out of a sub-listing');
  assert.ok(other.has('nested.txt'), 'nested staged file lists under its own dir');
  // Deleted entries agree with exists(): gone from the listing too.
  overlay.markDeleted(path.join(dir, 'staged.txt'));
  const after = new Set(['real.txt']);
  overlay.mergeIntoListing(dir, after);
  assert.ok(!after.has('staged.txt'), 'staged delete is hidden from the listing');
});

test('a staged edit is what a RUN sees, and the disk stays untouched', async () => {
  const dir = tempDir({ 'math.mjs': BROKEN_MATH, 'check.mjs': CHECK });
  const overlay = new Overlay(dir);
  overlay.set(path.join(dir, 'math.mjs'), FIXED_MATH);
  const tools = toolsAt(dir, overlay);

  const out = await tools.run('', 'node check.mjs');
  assert.match(out, /PASS/, `the staged fix is what runs, got: ${out}`);
  assert.equal(fs.readFileSync(path.join(dir, 'math.mjs'), 'utf8'), BROKEN_MATH, 'the disk file is still the broken one');
  const runRoot = path.join(dir, '.aipass', 'run');
  const left = fs.existsSync(runRoot) ? fs.readdirSync(runRoot) : [];
  assert.deepEqual(left, [], 'the sandbox is deleted after the run');
});

test('with nothing staged, a RUN is the real tree it always was', async () => {
  const dir = tempDir({ 'a.txt': 'hello\n' });
  const tools = toolsAt(dir, new Overlay(dir));

  const out = await tools.run('', 'node -e "require(\'fs\').writeFileSync(\'made-by-run.txt\', \'x\')"');
  assert.ok(fs.existsSync(path.join(dir, 'made-by-run.txt')), `the write landed on the real tree, got: ${out}`);
});

test('a staged delete is hidden, and output paths name the project, not the sandbox', async () => {
  const dir = tempDir({ 'secret.txt': 'shh\n', 'a.txt': 'a\n' });
  const overlay = new Overlay(dir);
  overlay.markDeleted(path.join(dir, 'secret.txt'));
  overlay.set(path.join(dir, 'a.txt'), 'a changed\n'); // anything staged forces the projection
  const tools = toolsAt(dir, overlay);

  const exists = await tools.run('', 'node -e "console.log(require(\'fs\').existsSync(\'secret.txt\'))"');
  assert.equal(exists.trim(), 'false', 'the deleted file is not in the projection');

  const cwd = await tools.run('', 'node -e "console.log(process.cwd())"');
  // macOS spells a temporary directory two ways (`/var/folders/...` is a link
  // to `/private/var/folders/...`); the two names are one directory, so the
  // comparison is made on the real paths.
  assert.equal(fs.realpathSync(cwd.trim()), fs.realpathSync(dir), 'the child path is put back to the project root');
  assert.ok(!cwd.toLowerCase().includes('.aipass'), 'no sandbox path leaks to the model');
});

test('a child that prints the canonical spelling still gets the project root back', () => {
  // macOS hands a child the resolved path (`/private/var/…` for `/var/…`), so
  // the literal sandbox spelling is not the only one that must swap back. A
  // symlinked alias reproduces "the child's spelling differs from the sandbox
  // string" on every platform.
  const dir = tempDir({ 'keep.txt': 'keep\n' });
  const alias = path.join(dir, 'alias');
  fs.symlinkSync(dir, alias, 'junction');
  const from = path.join(alias, '.aipass', 'run', 'run-x');
  fs.mkdirSync(from, { recursive: true });
  const canonical = fs.realpathSync(from);
  assert.notEqual(canonical, from, 'the fixture produces a second spelling');

  assert.equal(restorePaths(`cwd: ${canonical}`, from, dir), `cwd: ${dir}`, 'the resolved spelling swaps too');
  const url = `file:///${canonical.split(path.sep).join('/')}`;
  assert.equal(restorePaths(`at ${url}`, from, dir), `at file:///${dir.split(path.sep).join('/')}`, 'plain and file:// forms');
});

test('deleting the sandbox never follows a junction into the project', () => {
  const dir = tempDir({ 'keep.txt': 'keep\n' });
  const sandbox = createSandbox(dir);
  fs.symlinkSync(dir, path.join(sandbox, 'linked'), 'junction');

  fs.rmSync(sandbox, { recursive: true, force: true });
  assert.ok(fs.existsSync(path.join(dir, 'keep.txt')), 'the project survives sandbox cleanup');
});

test('a heavy directory is linked, not copied, and staged files sit beside it', async () => {
  const dir = tempDir({ 'src/app.js': 'x\n' });
  fs.mkdirSync(path.join(dir, 'node_modules', 'dep'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules', 'dep', 'index.js'), 'module.exports = 1;\n');
  const overlay = new Overlay(dir);
  overlay.set(path.join(dir, 'src', 'app.js'), 'x changed\n');
  const sandbox = createSandbox(dir);
  try {
    await materializeTree(dir, overlay, sandbox);

    assert.ok(fs.lstatSync(path.join(sandbox, 'node_modules')).isSymbolicLink(), 'node_modules is a junction');
    assert.equal(fs.readFileSync(path.join(sandbox, 'src', 'app.js'), 'utf8'), 'x changed\n', 'the staged content is in the projection');
    assert.equal(fs.readFileSync(path.join(dir, 'src', 'app.js'), 'utf8'), 'x\n', 'the disk file is untouched');
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});
