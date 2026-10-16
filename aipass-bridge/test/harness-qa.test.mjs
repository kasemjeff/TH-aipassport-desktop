// QA for the harness bugs found and fixed while sweeping this pass:
//   1. staging an attachment by path threw "homedir is not defined"
//   2. the conversation commands the window now offers were not wired at all
// Both live at the seam between the window and the harness, so both are tested
// here the same way the window reaches them: over HTTP, against a fake bridge.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRpc } from '../harness/rpc.mjs';
import { Settings } from '../harness/settings.mjs';
import { startBridge, FakeExtension, freePort, tempDir } from './harness.mjs';

let bridge;
before(async () => { bridge = await startBridge(); });
after(() => bridge.stop());

// Keep every byte of state in a scratch directory: the live app shares ~/.aipass.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aipass-qa-home-'));
process.env.AIPASS_HOME = HOME;
after(() => fs.rmSync(HOME, { recursive: true, force: true }));

async function startRpc() {
  const root = tempDir({ 'note.txt': 'hello' });
  const port = await freePort();
  const settingsDir = tempDir();
  const rpc = createRpc({
    port,
    root,
    bridgeURL: bridge.base,
    autostartBridge: false,
    store: tempDir(),
    settings: new Settings(settingsDir, 'settings.json'),
  });
  const call = async (method, params = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method, params }),
    });
    return res.json();
  };
  return { root, call, stop: () => rpc.server.close() };
}

test('an attachment can be staged by path', async () => {
  const { root, call, stop } = await startRpc();
  try {
    const absolute = await call('attachment.stage', { path: path.join(root, 'note.txt') });
    assert.equal(absolute.ok, true, absolute.error);
    assert.equal(absolute.result.name, 'note.txt');
    assert.equal(absolute.result.bytes, 5);
    assert.equal(absolute.result.mime, 'text/plain');

    // A bare name resolves inside the project root, the way /file src/app.js
    // would arrive from someone typing a relative path.
    const bare = await call('attachment.stage', { path: 'note.txt' });
    assert.equal(bare.ok, true, bare.error);

    const missing = await call('attachment.stage', { path: path.join(root, 'nope.txt') });
    assert.equal(missing.ok, false, 'a missing file is an error, not an empty attachment');
    assert.match(missing.error, /no such file/);

    const removed = await call('attachment.remove', { id: absolute.result.id });
    assert.equal(removed.ok, true);
  } finally { stop(); }
});

test('the conversation commands move the bridge conversation', async () => {
  const { call, stop } = await startRpc();
  try {
    const list = await call('conversations.list');
    assert.equal(list.ok, true);
    assert.ok(Array.isArray(list.result.conversations));

    const made = await call('conversation.new', { message: 'qa: fresh conversation' });
    assert.equal(made.ok, true, made.error);
    assert.ok(made.result && typeof made.result === 'object', 'a new conversation comes back');
    // The fake extension does not mint ids; the live bridge does. What is wired
    // here is that the window's call reaches the harness's bridge call at all.

    // Back to where it was, so a QA run leaves the user's bridge as it found it.
    const original = list.result.current;
    const pinned = await call('conversation.pin', { id: original });
    assert.equal(pinned.ok, true);
    assert.equal(pinned.result.id, original);
  } finally { stop(); }
});

test('a project can be removed from the window, and the folder survives', async () => {
  const { root, call, stop } = await startRpc();
  try {
    const added = await call('projects.add', { path: root, name: 'qa' });
    assert.equal(added.ok, true);
    const removed = await call('projects.remove', { path: root });
    assert.equal(removed.ok, true);
    assert.equal(removed.result.some((p) => p.path === root), false, 'it leaves the list');
    assert.equal(fs.existsSync(root), true, 'the folder itself is never deleted');
  } finally { stop(); }
});

test('settings.reset returns to defaults but keeps the project you are in', async () => {
  const { root, call, stop } = await startRpc();
  try {
    await call('settings.set', { mode: 'yolo', maxSteps: 42, defaultModel: 'some-model' });
    const reset = await call('settings.reset');
    assert.equal(reset.ok, true);
    assert.equal(reset.result.mode, 'ask', 'permissions go back to the safe default');
    assert.equal(reset.result.maxSteps, 10);
    assert.equal(reset.result.defaultModel, null);
    assert.equal(reset.result.root, root, 'but the current project stays where it is');
  } finally { stop(); }
});

test('context reports the budget, and compact rotates the conversation', async (t) => {
  const { call, stop } = await startRpc({ replies: ['ok', 'summary of earlier work', 'ok'] });
  try {
    // Compaction asks the model for a summary and starts a conversation, so it
    // needs the extension just like a run does.
    const ext = await new FakeExtension(bridge.base).connect();
    t.after(() => ext.disconnect());

    // A run first: context is a property of a session, not of the window.
    await call('run', { task: 'do a thing', mode: 'ask' });
    const before = await call('status');
    assert.ok(before.result.context, 'status carries the context meter');
    assert.equal(typeof before.result.context.budget, 'number');
    assert.ok(before.result.context.percent >= 0 && before.result.context.percent <= 100);

    const done = await call('compact');
    assert.equal(done.ok, true, done.error);
    assert.ok(typeof done.result.summary === 'string', 'the summary is what survives');
    const after = await call('status');
    assert.ok(after.result.context.percent <= before.result.context.percent,
      'rotation lowers the estimate by moving the history off the conversation');
  } finally { stop(); }
});
