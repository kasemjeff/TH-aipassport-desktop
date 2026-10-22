/**
 * The worktree surface, over the backend's own door.
 *
 * The harness side (`harness/worktree.mjs`) has its own tests; this file
 * pins the CONTRACT the window uses: the five methods, their parameters and
 * what they answer. A worktree is a checkout on the person's disk, so the
 * person is the one who asks for it — the window's buttons and these methods
 * are two halves of the same promise.
 *
 * Run: node --test aipass-bridge/test/worktree-rpc.test.mjs
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tempDir, startRpcServer } from './harness.mjs';
import { Settings } from '../harness/settings.mjs';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aipass-wt-rpc-home-'));
process.env.AIPASS_HOME = HOME;
after(() => fs.rmSync(HOME, { recursive: true, force: true }));

/** A repository with one commit — git cannot make a worktree without a HEAD. */
const repo = () => {
  const dir = tempDir({ 'a.txt': 'hello\n' });
  const git = (...args) => execFileSync('git', args, { cwd: dir, windowsHide: true, stdio: 'ignore' });
  git('init');
  git('config', 'user.email', 'aipass@example.test');
  git('config', 'user.name', 'aipass test');
  git('add', '-A');
  git('commit', '-m', 'first');
  return dir;
};

/** The backend, with no bridge and nobody to talk to. */
async function startRpc(root) {
  const rpc = await startRpcServer({
    root,
    bridgeURL: 'http://127.0.0.1:1',
    autostartBridge: false,
    store: tempDir(),
    settings: new Settings(tempDir(), 'settings.json'),
    rulesFile: path.join(tempDir(), 'rules.json'),
  });
  const port = rpc.port;
  return {
    rpc,
    call: async (method, params = {}) => {
      const res = await fetch(`http://127.0.0.1:${port}/rpc`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ method, params }),
      });
      const body = await res.json();
      if (!body.ok) throw new Error(body.error);
      return body.result;
    },
    stop() { rpc.server.close(); },
  };
}

test('the worktree methods make, list, read and take away a checkout', async (t) => {
  const root = repo();
  const env = await startRpc(root);
  t.after(() => env.stop());

  const empty = await env.call('worktree.list');
  // `git worktree list` names the main checkout too — the window's question is
  // "what did WE make", and only the ones under our home are ours.
  assert.equal(empty.worktrees.filter((w) => w.ours).length, 0, 'a fresh repository has no worktree of ours');

  const made = await env.call('worktree.create', { name: 'try' });
  assert.ok(made.path, 'the worktree has a path');
  assert.equal(made.path.includes(root), false, 'and it is outside the project');
  assert.ok(fs.existsSync(path.join(made.path, 'a.txt')), 'it is a real checkout');

  const listed = await env.call('worktree.list');
  assert.equal(listed.worktrees.filter((w) => w.ours).length, 1, 'the worktree is listed');

  const status = await env.call('worktree.status', { path: made.path });
  assert.equal(status.clean, true, 'and it is clean to begin with');

  const gone = await env.call('worktree.remove', { path: made.path });
  assert.equal(gone.ok, true, 'the worktree can be taken away');
  assert.equal(fs.existsSync(made.path), false, 'and it is gone');
});

test('the sweep keeps a worktree that is still young', async (t) => {
  // The sweep takes the ones nobody wants: clean, ours, and older than a
  // fortnight. A worktree from this minute is somebody's work in progress.
  const root = repo();
  const env = await startRpc(root);
  t.after(() => env.stop());

  const made = await env.call('worktree.create', { name: 'young' });
  const swept = await env.call('worktree.sweep');
  assert.ok(Array.isArray(swept.removed), 'the sweep answers what it removed');
  assert.equal(swept.removed.length, 0, 'and it removed nothing yet');
  assert.equal(fs.existsSync(made.path), true, 'the young worktree is still there');
});
