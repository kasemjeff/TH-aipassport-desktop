// The six review findings that made the gate, the git grammar and the spill
// sweeper behave differently from the way their comments said they did.
//
// Each test is the behaviour the finding asked for, not a mirror of the
// implementation: a commit cannot outlive a failed edit, a global git option
// cannot hide a commit, an unknown git subcommand is a write, a leading status
// space survives the snapshot, a bad spill limit is not a deletion order, and
// the spill path does not use the synchronous fs API.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createTools } from '../harness/tools.mjs';
import { Overlay } from '../harness/overlay.mjs';
import { Emitter } from '../harness/events.mjs';
import { PermissionEngine, classify, classifyRun, isGitCommit } from '../harness/permissions.mjs';
import { runTask, bootstrapSnapshot } from '../harness/loop.mjs';
import { parseGitArg, parseGitCommand } from '../harness/git.mjs';
import { pruneSpill, SPILL_KEEP } from '../harness/tools.mjs';

const dirs = [];
const tempDir = (files = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aipass-review-'));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    const p = path.join(dir, name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  return dir;
};
after(() => { for (const dir of dirs) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } } });

const git = (dir, ...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' }).toString();

/** A repository with one commit, and a second file staged for a commit that
 *  must not happen. */
const stagedRepo = () => {
  const dir = tempDir({ 'base.txt': 'base\n' });
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'init');
  fs.writeFileSync(path.join(dir, 'staged.txt'), 'staged\n');
  git(dir, 'add', 'staged.txt');
  return dir;
};

test('a failed edit skips the git commit later in the same reply', async () => {
  const dir = stagedRepo();
  const overlay = new Overlay(dir);
  const tools = createTools({ root: dir, overlay, allowGitWrite: true });
  const replies = [
    'EDIT base.txt\nFIND\nzzz-not-there\nNEW\nreplacement\nEND\n'
    + 'GIT commit -m "must not land"\n',
    'DONE re-planned from the failure\n',
  ];
  const sent = [];
  const bridge = {
    async quota() { return null; },
    async chat({ message }) {
      sent.push(message);
      return { text: replies.shift() ?? 'DONE done\n', reasoning: '' };
    },
  };
  const permissions = new PermissionEngine({ mode: 'yolo', allowRun: true, events: new Emitter() });

  const result = await runTask('edit then commit', {
    bridge, tools, overlay, permissions,
    options: { mode: 'yolo', allowGitWrite: true, maxSteps: 4 },
    first: true,
  });

  assert.equal(result.stopReason, 'done');
  assert.match(sent[1], /skipped — an earlier change/, 'the model is told the commit did not run');
  const log = git(dir, 'log', '--oneline').trim().split('\n');
  assert.equal(log.length, 1, 'the commit after the failed edit never landed');
  assert.match(git(dir, 'status', '--porcelain'), /staged\.txt/, 'the staged file is still staged');
});

test('the git subcommand parser sees through global options everywhere', () => {
  assert.deepEqual(
    parseGitCommand('--git-dir .git --work-tree . commit -m x'),
    { sub: 'commit', args: ['-m', 'x'] },
    'both value-carrying global options are skipped',
  );
  assert.equal(parseGitArg('--git-dir .git commit -m x').kind, 'write');
  assert.equal(parseGitArg('--work-tree=/tmp status').kind, 'read');
  assert.equal(parseGitArg('-C sub -c user.name=x status').kind, 'read');
  assert.equal(parseGitArg('--namespace=feature commit -m x').kind, 'write');

  assert.equal(isGitCommit('git --git-dir .git commit -m x'), true, 'the commit gate sees it');
  assert.equal(classify('git', '', '--git-dir .git commit -m x'), 'write', 'the permission gate sees it');
  assert.equal(classifyRun('git --git-dir .git commit -m x'), 'shell-risk');
});

test('an unknown git subcommand is a write, not a read', () => {
  // These were all absent from the old blocklist, so yolo let them through
  // without a question.
  for (const command of [
    'git update-ref refs/heads/main HEAD',
    'git filter-branch --all',
    'git worktree add ../elsewhere',
    'git config user.name someone',
    'git notes add -m hi',
    'git gc --prune=now',
  ]) {
    assert.equal(classifyRun(command), 'shell-risk', `${command} is a write`);
  }
  assert.equal(classifyRun('git status --short'), 'shell', 'a read stays an ordinary command');
  assert.equal(classifyRun('git diff --cached'), 'shell', 'a read stays an ordinary command');
  assert.equal(parseGitArg('update-ref refs/heads/main HEAD').kind, 'write');
  assert.equal(parseGitArg('status --short').kind, 'read');
});

test('the bootstrap snapshot keeps the first line leading status space', async () => {
  const dir = tempDir({});
  const snapshot = await bootstrapSnapshot({ git: async () => ' M AGENTS.md\n?? new.txt\n' }, dir);
  assert.match(snapshot, /^ {3}M AGENTS\.md$/m, 'the status column survives the snapshot');
  assert.match(snapshot, /^ {2}\?\? new\.txt$/m);
  assert.doesNotMatch(snapshot, /^ {2}M AGENTS\.md$/m);
});

test('an invalid spill limit falls back instead of deleting every spill', async () => {
  const dir = tempDir({});
  for (let i = 0; i < 4; i++) fs.writeFileSync(path.join(dir, `s${i}.txt`), 'spill');
  await pruneSpill(dir, NaN);
  assert.equal(fs.readdirSync(dir).length, 4, 'NaN is not a cap that clears the directory');

  const old = process.env.AIPASS_SPILL_KEEP;
  process.env.AIPASS_SPILL_KEEP = '';
  try {
    const fresh = await import(`../harness/tools.mjs?invalid-spill-keep=${Date.now()}`);
    assert.equal(fresh.SPILL_KEEP, 200, 'an empty environment value uses the documented default');
  } finally {
    if (old === undefined) delete process.env.AIPASS_SPILL_KEEP;
    else process.env.AIPASS_SPILL_KEEP = old;
  }
  assert.ok(Number.isFinite(SPILL_KEEP) && SPILL_KEEP > 0);
});

test('a spill is written without the synchronous fs API', async () => {
  const dir = tempDir({ 'big.txt': Array.from({ length: 300 }, (_, i) => `row ${i + 1} ${'y'.repeat(160)}`).join('\n') });
  const tools = createTools({ root: dir, overlay: new Overlay(dir) });
  const writeFileSync = fs.writeFileSync;
  fs.writeFileSync = () => { throw new Error('the spill used a blocking write'); };
  try {
    const out = await tools.read('big.txt');
    assert.match(out, /more bytes/, 'the long read still spilled');
  } finally {
    fs.writeFileSync = writeFileSync;
  }
});
