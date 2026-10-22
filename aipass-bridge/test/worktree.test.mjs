// A run's own checkout: the worktree (harness/worktree.mjs).
//
// The gap it closes: two runs — or a run and the person — editing one
// repository fight over the same files. Devin says it plainly: "if two
// Cascades edit the same file at the same time, the edits can race … consider
// using worktrees". A worktree is git's answer: a second checkout of the same
// repository, on its own branch, OUTSIDE the project — so the files a run
// writes are not the files the person is editing.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Overlay } from '../harness/overlay.mjs';
import { create, list, remove, status, sweep, worktreeRoot } from '../harness/worktree.mjs';

const dirs = [];
const tempDir = (files = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aipass-worktree-'));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    const p = path.join(dir, name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  return dir;
};

// The house's own folder: `~/.aipass/run/worktrees/`. The tests move the
// home, so nothing this suite makes lands in the real one.
process.env.AIPASS_HOME = tempDir();

after(() => { for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true }); });

/** A repository with one commit in it, so a worktree has something to check out. */
const repo = (files = { 'a.txt': 'hello\n' }) => {
  const dir = tempDir(files);
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' }).toString();
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('add', '-A');
  git('commit', '-qm', 'init');
  return { dir, git };
};

/** Do two paths name the same place on disk? */
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

test('a worktree is made outside the project, and it is a real checkout', async () => {
  const { dir } = repo();
  const made = await create({ root: dir, name: 'ทดลอง' });

  // Outside the project: a checkout of the user's source inside their own
  // project is a copy a `git add -A` walks into, and the sandbox projection
  // (harness/sandbox.mjs) is outside for exactly that reason.
  assert.equal(samePath(made.path, dir), false, 'the worktree is not the project');
  assert.ok(
    path.relative(dir, made.path).startsWith('..'),
    `the worktree is outside the project (${made.path})`,
  );
  assert.ok(made.path.startsWith(worktreeRoot()), 'and it lives in the house folder');

  // A REAL checkout: the committed file is on disk, and git sees a clean tree
  // on a branch of its own (the project's branch is checked out already, so
  // the new one has to be a branch).
  assert.match(fs.readFileSync(path.join(made.path, 'a.txt'), 'utf8'), /hello/, 'the committed file is there');
  assert.match(made.branch, /^aipass\//, 'the worktree has a branch of its own');
  const st = await status({ root: dir, path: made.path });
  assert.equal(st.clean, true, 'nothing changed in it yet');
  assert.equal(st.branch, made.branch);
  assert.deepEqual(st.files, []);
});

test('the files a run wrote in a worktree are not in the working tree', async () => {
  const { dir, git } = repo();
  const made = await create({ root: dir, name: 'งานที่สอง' });

  // What a run does with its root: the overlay IS the write surface of a run
  // (root rule 1), and its root is the folder the run was given. So a run
  // whose root is the worktree cannot write into the project — the project is
  // not even inside its reach.
  const overlay = new Overlay(made.path);
  overlay.set(overlay.safe('b.txt'), 'written by the run\n');
  assert.equal(overlay.trySafe('../a.txt'), null, 'the project is out of the run\'s reach');
  overlay.applyToDisk();

  assert.equal(fs.existsSync(path.join(made.path, 'b.txt')), true, 'the file landed in the worktree');
  assert.equal(fs.existsSync(path.join(dir, 'b.txt')), false, "the project did not get the file");
  assert.equal(git('status', '--porcelain').trim(), '', "and the project's tree is untouched");

  // The person has to be able to see what changed in there, to decide whether
  // to merge it or throw it away. A file the run CREATED is untracked, and
  // `git diff` says nothing about those — so the counts have to include it.
  const st = await status({ root: dir, path: made.path });
  assert.deepEqual(st.files, ['b.txt'], 'the worktree names the file that changed');
  assert.equal(st.clean, false);
  assert.deepEqual(st.untracked, ['b.txt']);
  assert.equal(st.added, 1, 'and the change is counted');
  assert.equal(st.removed, 0);
});

test('a worktree can be taken away again', async () => {
  const { dir } = repo();
  const made = await create({ root: dir, name: 'ทิ้งไป' });

  const gone = await remove({ root: dir, path: made.path });
  assert.equal(gone.ok, true);
  assert.equal(fs.existsSync(made.path), false, 'the folder is gone');

  const listed = await list({ root: dir });
  assert.equal(
    listed.worktrees.some((w) => samePath(w.path, made.path)),
    false,
    'and git does not list it any more',
  );
  assert.equal(listed.worktrees.length, 1, 'only the project itself is left');
});

test('a worktree nobody wants is swept, and one with work in it is kept', async () => {
  const { dir } = repo();
  const litter = await create({ root: dir, name: 'ขยะ' });
  const work = await create({ root: dir, name: 'งานค้าง' });
  // An uncommitted file lives in that folder and nowhere else: the branch
  // keeps the COMMITS, but these bytes are only here.
  fs.writeFileSync(path.join(work.path, 'c.txt'), 'ยังไม่เสร็จ\n');

  const out = await sweep({ root: dir, maxAgeMs: 0 });

  assert.deepEqual(out.removed, [litter.path], 'the clean and forgotten one went');
  assert.equal(fs.existsSync(litter.path), false);
  assert.equal(fs.existsSync(work.path), true, 'the one with work in it stayed');
});

test('a path that leaves the worktree folder is refused', async () => {
  const { dir } = repo();
  // The folder this house keeps its worktrees in is the boundary: a path
  // outside it is not a worktree of ours, and taking it away would be a way
  // out of the folder it was given.
  await assert.rejects(() => remove({ root: dir, path: dir }), /outside the worktree folder/);
  await assert.rejects(() => status({ root: dir, path: dir }), /outside the worktree folder/);
});
