// Data flow between the surfaces that share one machine: the settings file,
// every project's live harness, and the data a person moves between machines.
// Each test pins a seam that used to be a promise on one side and a stale copy
// on the other.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { Settings } from '../harness/settings.mjs';
import { SessionStore } from '../harness/session.mjs';
import { RulesStore } from '../harness/rules.mjs';
import { loadMemory, saveMemory } from '../harness/memory-store.mjs';
import { loadGoal, setGoal } from '../harness/goal.mjs';
import { relocateProject } from '../harness/relocate.mjs';
import { tempDir, freePort, startRpcServer } from './harness.mjs';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'relocate.mjs');

/**
 * An RPC server over throwaway projects and settings. These flows never send a
 * chat, so the bridge is an address with nobody on it and no autostart: a test
 * must not leave a listener behind.
 */
async function startRpc({ files = {}, ...rest } = {}) {
  const root = rest.root ? path.resolve(rest.root) : tempDir(files);
  const rpc = await startRpcServer({
    root,
    bridgeURL: 'http://127.0.0.1:1',
    autostartBridge: false,
    store: tempDir(),
    settings: new Settings(tempDir(), 'settings.json'),
    rulesFile: path.join(tempDir(), 'rules.json'),
    ...rest,
  });
  const port = rpc.port;
  return {
    root,
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

/* ------------------------------------------------------ settings to the harness */

test('a project visited later is entered under the settings saved since it was last open', async (t) => {
  const visited = tempDir({ 'a.txt': 'a\n' });
  const env = await startRpc({ files: { 'b.txt': 'b\n' } });
  t.after(() => env.stop());

  // The second project is opened once, under the settings of that moment: its
  // harness now exists, warm, inside the backend.
  await env.call('projects.switch', { path: visited });
  assert.equal(env.rpc.current.options.temperature, null);

  // On the first project the sheet saves — and tells every window the value is
  // in force.
  await env.call('projects.switch', { path: env.root });
  await env.call('settings.set', { temperature: 1.5, maxSteps: 7 });

  // Entering the visited project must land on the saved values, not the ones
  // that were in force when it was first opened.
  await env.call('projects.switch', { path: visited });
  assert.equal(env.rpc.current.options.temperature, 1.5, 'the saved temperature is in force here');
  assert.equal(env.rpc.current.options.maxSteps, 7, 'and the saved budget');
});

test('a save moves every harness the backend holds, not only the current one', async (t) => {
  const visited = tempDir({ 'a.txt': 'a\n' });
  const env = await startRpc({ files: { 'b.txt': 'b\n' } });
  t.after(() => env.stop());

  await env.call('projects.switch', { path: visited });
  const behind = env.rpc.current; // the harness of the project left behind
  await env.call('projects.switch', { path: env.root });

  await env.call('settings.set', { temperature: 0.25, thinking: 'high' });
  assert.equal(behind.options.temperature, 0.25, 'the harness left behind follows the save');
  assert.equal(behind.options.thinking, 'high', 'and the thinking level');
});

test('a model picked in the header reaches every live harness too', async (t) => {
  const visited = tempDir({ 'a.txt': 'a\n' });
  const env = await startRpc({ files: { 'b.txt': 'b\n' } });
  t.after(() => env.stop());

  await env.call('projects.switch', { path: visited });
  const behind = env.rpc.current;
  await env.call('projects.switch', { path: env.root });

  await env.call('config.set', { model: 'some-model' });
  assert.equal(env.rpc.current.bridge.model, 'some-model');
  assert.equal(behind.bridge.model, 'some-model', 'the harness left behind follows the pick');
  assert.equal(env.rpc.settings.get('defaultModel'), 'some-model', 'and the file remembers it');
});

test('a path rule saved in one project is enforced in every live harness', async (t) => {
  const other = tempDir({ 'vendor/x.js': 'x\n' });
  const env = await startRpc({ files: {} });
  t.after(() => env.stop());

  await env.call('projects.switch', { path: other });
  const otherHarness = env.rpc.current;
  await env.call('projects.switch', { path: env.root });

  await env.call('rules.set', { rules: [{ pattern: 'vendor/**', decision: 'deny' }] });
  assert.equal(env.rpc.current.permissions.evaluate({ kind: 'write', arg: 'vendor/x.js' }).decision, 'deny');
  assert.equal(otherHarness.permissions.evaluate({ kind: 'write', arg: 'vendor/x.js' }).decision, 'deny',
    'a rule is not a note on one project: the engine in the other project carries it too');
});

test('settings.reset returns every harness to the defaults, not just the current one', async (t) => {
  const visited = tempDir({ 'a.txt': 'a\n' });
  const env = await startRpc({ files: { 'b.txt': 'b\n' } });
  t.after(() => env.stop());

  await env.call('projects.switch', { path: visited });
  const behind = env.rpc.current;
  await env.call('projects.switch', { path: env.root });

  await env.call('settings.set', { temperature: 1.75 });
  assert.equal(behind.options.temperature, 1.75);

  await env.call('settings.reset');
  assert.equal(env.rpc.current.options.temperature, null, 'the current harness is back at the default');
  assert.equal(behind.options.temperature, null, 'and so is the harness left behind');
});

/* ------------------------------------------- moving a project to a new path */

test('a moved project keeps its sessions, facts, rules and list entry', async (t) => {
  const home = tempDir();
  const oldRoot = path.join(home, 'project');
  const newRoot = path.join(home, 'moved');
  fs.mkdirSync(newRoot);

  // A full project's worth of keyed data, written the way the app writes it.
  const store = new SessionStore(path.join(home, 'sessions'));
  const kept = store.create({ root: oldRoot, model: 'm', title: 'kept' });
  kept.append('user', { text: 'hello' });
  const archived = store.create({ root: oldRoot, model: 'm', title: 'archived' });
  const oldDir = store.dirFor(oldRoot); // captured before the move: must be gone after
  await new Promise((r) => setTimeout(r, 5));
  store.archiveIdle(oldRoot, { olderThanMs: 1, keepId: kept.id });
  saveMemory(oldRoot, ['the build is npm run build'], path.join(home, 'memory'));
  setGoal(oldRoot, 'ship the release', { dir: path.join(home, 'goal') });
  const rules = new RulesStore(path.join(home, 'rules.json'));
  rules.setRules(oldRoot, [{ pattern: 'vendor/**', decision: 'deny' }]);
  rules.addGrant(oldRoot, 'write', 'src/config.ts');
  new Settings(home).addProject(oldRoot);

  const out = relocateProject({ from: oldRoot, to: newRoot, home });
  assert.equal(out.from, path.resolve(oldRoot));
  assert.equal(out.facts, 1);
  assert.equal(out.goal.objective, 'ship the release');
  assert.equal(out.rules.rules, 1);
  assert.equal(out.settings, true);

  // Sessions: still openable by id, now listed for the new path, header root
  // rewritten — and the archive travelled with them.
  const moved = store.list(newRoot);
  assert.deepEqual(moved.map((s) => s.title), ['kept'], 'the live session is listed under the new path');
  assert.equal(store.load(kept.id).entries.length, 1, 'entries survive the move');
  assert.equal(store.load(kept.id).header.root, path.resolve(newRoot));
  assert.equal(fs.existsSync(oldDir), false, 'the emptied old directories are gone (not left as litter)');
  assert.equal(store.list(oldRoot).length, 0, 'nothing is left under the old key');
  const archiveFile = path.join(store.dirFor(newRoot), 'archive', `session-${archived.id}.jsonl`);
  assert.equal(fs.existsSync(archiveFile), true, 'the archive moved with its project');
  assert.equal(JSON.parse(fs.readFileSync(archiveFile, 'utf8').split('\n')[0]).root, path.resolve(newRoot),
    'archived sessions are re-keyed too');

  // Facts load for the project at its new home; the old file is gone.
  assert.deepEqual(loadMemory(newRoot, path.join(home, 'memory')), ['the build is npm run build']);
  assert.deepEqual(loadMemory(oldRoot, path.join(home, 'memory')), []);

  // The goal travelled too: a moved project is still chasing the same objective.
  assert.equal(loadGoal(newRoot, path.join(home, 'goal')).objective, 'ship the release');
  assert.equal(loadGoal(oldRoot, path.join(home, 'goal')), null);

  // Rules and grants follow the key; the file still parses as one store.
  assert.deepEqual(rules.forRoot(newRoot).rules, [{ pattern: 'vendor/**', decision: 'deny' }]);
  assert.deepEqual(rules.forRoot(newRoot).grants, [{ kind: 'write', arg: 'src/config.ts' }]);
  assert.deepEqual(rules.forRoot(oldRoot), { rules: [], grants: [] });

  // The project list (and the startup root) point at the new path.
  const after = new Settings(home);
  assert.deepEqual(after.projectList().map((p) => p.path), [path.resolve(newRoot)]);
  assert.equal(after.get('root'), path.resolve(newRoot));
});

test('relocation merges into data already stored at the new path', async (t) => {
  const home = tempDir();
  const oldRoot = path.join(home, 'old');
  const newRoot = path.join(home, 'new');
  fs.mkdirSync(newRoot);

  const store = new SessionStore(path.join(home, 'sessions'));
  store.create({ root: oldRoot, title: 'from the old place' });
  store.create({ root: newRoot, title: 'already here' });
  const memoryDir = path.join(home, 'memory');
  saveMemory(oldRoot, ['old fact'], memoryDir);
  saveMemory(newRoot, ['new fact'], memoryDir);
  const rules = new RulesStore(path.join(home, 'rules.json'));
  rules.setRules(oldRoot, [{ pattern: 'old/**', decision: 'deny' }]);
  rules.setRules(newRoot, [{ pattern: 'new/**', decision: 'allow' }]);

  relocateProject({ from: oldRoot, to: newRoot, home });

  assert.deepEqual(store.list(newRoot).map((s) => s.title).sort(), ['already here', 'from the old place']);
  assert.deepEqual(loadMemory(newRoot, memoryDir).sort(), ['new fact', 'old fact']);
  assert.deepEqual(rules.forRoot(newRoot).rules.map((r) => r.pattern).sort(), ['new/**', 'old/**']);
});

test('two paths that slugify the same are re-keyed in place, not moved twice', async (t) => {
  const home = tempDir();
  const spaced = path.join(home, 'a b');
  const dashed = path.join(home, 'a-b');
  fs.mkdirSync(dashed);

  const store = new SessionStore(path.join(home, 'sessions'));
  const session = store.create({ root: spaced, title: 'both spellings' });

  relocateProject({ from: spaced, to: dashed, home });

  // One directory (the slug is the same for both), header repointed, the
  // session listed under the new path exactly once.
  assert.deepEqual(store.list(dashed).map((s) => s.id), [session.id]);
  assert.equal(store.load(session.id).header.root, path.resolve(dashed));
  const dirs = fs.readdirSync(path.join(home, 'sessions')).filter((d) => !d.endsWith('.tmp'));
  assert.equal(dirs.length, 1);
});

test('relocation repairs a session whose header was torn in a crash', async (t) => {
  const home = tempDir();
  const oldRoot = path.join(home, 'project');
  const newRoot = path.join(home, 'moved');
  fs.mkdirSync(newRoot);

  const store = new SessionStore(path.join(home, 'sessions'));
  const s = store.create({ root: oldRoot, title: 'torn' });
  // The crash state a mid-rewrite power loss leaves: a breadcrumb holding the
  // header, the file's first line no longer parsing.
  fs.writeFileSync(`${s.file}.hdr`, JSON.stringify(store.load(s.id).header) + '\n');
  const fd = fs.openSync(s.file, 'r+');
  try { fs.writeSync(fd, Buffer.from('xxxx torn header'), 0, 16, 0); } finally { fs.closeSync(fd); }

  const out = relocateProject({ from: oldRoot, to: newRoot, home });
  assert.equal(out.sessions.moved, 1);
  const [listed] = store.list(newRoot);
  assert.equal(listed.id, s.id, 'the torn session is recovered, not lost');
  assert.equal(listed.root, path.resolve(newRoot));
  assert.equal(fs.existsSync(`${listed.file}.hdr`), false, 'the breadcrumb is cleaned after the repair');
});

test('relocation refuses nonsense instead of re-keying the wrong data', async (t) => {
  const home = tempDir();
  const root = path.join(home, 'project');
  fs.mkdirSync(root);
  assert.throws(() => relocateProject({ from: root, to: root, home }), /same/);
  assert.throws(() => relocateProject({ from: root, to: path.join(home, 'nope'), home }), /no such folder/);
  assert.throws(() => relocateProject({ from: '', to: root, home }), /needs both paths/);
});

test('the relocate CLI re-keys the home it is pointed at, and refuses while the app runs', async (t) => {
  const home = tempDir();
  const oldRoot = path.join(home, 'project');
  const newRoot = path.join(home, 'moved');
  fs.mkdirSync(oldRoot);
  fs.mkdirSync(newRoot);
  const store = new SessionStore(path.join(home, 'sessions'));
  store.create({ root: oldRoot, title: 'cli move' });
  saveMemory(oldRoot, ['a fact for the cli'], path.join(home, 'memory'));

  // Async spawn, not spawnSync: the fake backend below lives in this process,
  // and a blocked event loop would look exactly like "nobody is listening".
  const run = (extraEnv = {}) => new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, oldRoot, newRoot], {
      windowsHide: true,
      env: { ...process.env, AIPASS_HOME: home, ...extraEnv },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });

  // While a desktop backend answers, the CLI refuses before touching a file:
  // the running backend holds the old paths and its open sessions.
  const port = await freePort();
  const backend = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, result: {} }));
  });
  await new Promise((r) => backend.listen(port, '127.0.0.1', r));
  t.after(() => backend.close());
  const refused = await run({ AIPASS_DESKTOP_PORT: String(port) });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /desktop app is running/);
  assert.equal(store.list(newRoot).length, 0, 'nothing moved on the refusal');

  // Nothing on the desktop port: the CLI does the work for real.
  const done = await run({ AIPASS_DESKTOP_PORT: String(await freePort()) });
  assert.equal(done.status, 0, done.stderr);
  assert.match(done.stdout, /relocated/);
  assert.equal(store.list(newRoot).length, 1, 'the CLI re-keyed the real home');
  assert.deepEqual(loadMemory(newRoot, path.join(home, 'memory')), ['a fact for the cli']);
});
