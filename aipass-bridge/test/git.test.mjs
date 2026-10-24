// The write side of git (harness/git.mjs) and the gate in front of it.
//
// GIT was read-only for a long time: the model could look at the repository
// but never change it, so a run staged a diff and left the commit to the
// person. The write side has two gates in front of it — the run must have
// been GIVEN the power (`allowGitWrite`, off by default) and the person must
// agree (the permission gate) — and one rule that does not bend: a path that
// leaves the project is refused before git ever sees it.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createTools } from '../harness/tools.mjs';
import { Overlay } from '../harness/overlay.mjs';
import { PermissionEngine } from '../harness/permissions.mjs';
import { SkillLibrary } from '../harness/skills.mjs';
import { Emitter } from '../harness/events.mjs';
import { runTask } from '../harness/loop.mjs';
import { resolveInside, parseGitArg } from '../harness/git.mjs';

const dirs = [];
const tempDir = (files = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aipass-git-'));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    const p = path.join(dir, name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  return dir;
};
after(() => { for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true }); });

/** A repository with one commit in it, so a commit has something to sit on. */
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

const toolsIn = (dir, extra = {}) => createTools({
  root: dir, overlay: new Overlay(dir), skills: new SkillLibrary([]), ...extra,
});

test('a git write asks before it runs', async () => {
  const { dir, git } = repo();
  fs.writeFileSync(path.join(dir, 'b.txt'), 'second\n');
  const questions = [];
  const permissions = new PermissionEngine({
    mode: 'ask',
    askFn: async (q) => { questions.push(q); return 'deny'; },
    events: new Emitter(),
  });
  const replies = ['GIT commit -m "add b"\n', 'DONE stopped\n'];
  let turn = 0;
  const prompts = [];
  const bridge = {
    async quota() { return null; },
    async chat({ message }) {
      prompts.push(message);
      return { text: replies[Math.min(turn++, replies.length - 1)], reasoning: '' };
    },
  };
  const tools = toolsIn(dir, { allowGitWrite: true });

  await runTask('commit the change', {
    bridge, tools, overlay: new Overlay(dir), permissions,
    options: { mode: 'ask', allowGitWrite: true, maxSteps: 4 },
    first: true,
  });

  assert.equal(questions.length, 1, 'the person was asked once');
  assert.equal(questions[0].kind, 'git');
  assert.equal(questions[0].risk, 'write', 'a git write is a write — it rides the write gate');
  assert.match(prompts[1] ?? '', /declined git/, 'the refusal reached the model');
  const log = git('log', '--oneline');
  assert.equal(log.trim().split('\n').length, 1, 'nothing was committed');
  assert.equal(git('status', '--porcelain').includes('b.txt'), true, 'b.txt is still untracked');
});

test('a commit records the staged changes', async () => {
  const { dir, git } = repo();
  fs.writeFileSync(path.join(dir, 'b.txt'), 'second\n');
  const tools = toolsIn(dir, { allowGitWrite: true });

  const staged = await tools.git('stage b.txt');
  assert.match(staged, /staged 1 file\(s\)/, 'the file is staged');

  const committed = await tools.git('commit add b');
  assert.match(committed, /committed [0-9a-f]+ — add b/, 'the commit names itself');

  const log = git('log', '--oneline').trim().split('\n');
  assert.equal(log.length, 2, 'the commit is in the history');
  assert.match(log[0], /add b/, 'with the message the model wrote');
  assert.match(git('show', '--name-only', '--format=', 'HEAD'), /b\.txt/, 'and the file it staged');
  assert.equal(git('status', '--porcelain').trim(), '', 'the tree is clean');
});

test('git refuses a path outside the project', async () => {
  const { dir } = repo();
  const outside = path.join(dir, '..', 'aipass-outside.txt');
  fs.writeFileSync(outside, 'not yours\n');
  const tools = toolsIn(dir, { allowGitWrite: true });

  const out = await tools.git('stage ../aipass-outside.txt');

  assert.match(out, /^err: outside the project/, 'the path left the root and was refused');
  assert.throws(() => resolveInside(dir, '../aipass-outside.txt'), /outside the project/);
  // The same refusal for a path that only leaves the root through a link.
  const linked = path.join(dir, 'link');
  try { fs.symlinkSync(path.dirname(outside), linked, 'junction'); } catch { /* no link here */ }
  assert.throws(() => resolveInside(dir, 'link/aipass-outside.txt'), /outside the project/);
  fs.rmSync(outside, { force: true });
});

test('the GIT tool refuses a write subcommand until it is allowed', async () => {
  const { dir, git } = repo();
  fs.writeFileSync(path.join(dir, 'b.txt'), 'second\n');
  const off = toolsIn(dir);

  assert.match(await off.git('commit add b'), /^err: git write subcommands are not allowed/);
  assert.match(await off.git('stage b.txt'), /^err: git write subcommands are not allowed/);
  assert.match(await off.git('branch feature'), /^err: git write subcommands are not allowed/);
  assert.equal(git('log', '--oneline').trim().split('\n').length, 1, 'nothing was committed');
  assert.equal(git('status', '--porcelain').includes('b.txt'), true, 'nothing was staged');

  const on = toolsIn(dir, { allowGitWrite: true });
  assert.match(await on.git('stage b.txt'), /staged 1 file\(s\)/, 'the same call runs once the run has the power');
});

test('a git read is still a read — nobody is asked', async () => {
  const { dir } = repo();
  const permissions = new PermissionEngine({ mode: 'ask', askFn: async () => 'deny', events: new Emitter() });
  const verdict = permissions.evaluate({ kind: 'git', arg: 'status' });
  assert.equal(verdict.decision, 'allow', 'reading the repository changes nothing');
  const write = permissions.evaluate({ kind: 'git', arg: 'commit -m x' });
  assert.equal(write.decision, 'ask', 'writing the repository is a question');
});

test('the GIT grammar has one owner', () => {
  assert.equal(parseGitArg('status').kind, 'read');
  assert.equal(parseGitArg('diff --cached').kind, 'read');
  assert.equal(parseGitArg('branch').kind, 'read', 'a bare branch lists');
  assert.equal(parseGitArg('branch feature').kind, 'write', 'a branch with a name creates one');
  assert.equal(parseGitArg('commit -m x').kind, 'write');
  assert.equal(parseGitArg('stage a.txt').kind, 'write');
  // A flag is not a branch name, and `branch -D main` deletes a branch: it
  // is a write, not the listing form.
  assert.equal(parseGitArg('branch -D main').kind, 'write');
  // Global options are parsed before the subcommand, including the ones that
  // carry a value in the next word or in `=`.
  assert.equal(parseGitArg('--git-dir .git commit -m x').kind, 'write');
  assert.equal(parseGitArg('--work-tree=/tmp status').kind, 'read');
  assert.equal(parseGitArg('-C sub -c user.name=x status').kind, 'read');
});
