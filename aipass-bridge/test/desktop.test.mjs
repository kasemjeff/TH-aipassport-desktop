// End-to-end tests for the desktop backend: the real bridge, the fake
// extension, and the RPC layer on top — so the window's contract is checked
// without a browser and without spending credits.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startBridge, FakeExtension, scripted, tempDir, freePort, startRpcServer } from './harness.mjs';
import { createRpc, staticFileFor } from '../harness/rpc.mjs';
import { Settings } from '../harness/settings.mjs';
import { SessionStore } from '../harness/session.mjs';
import { backendIsUp } from '../harness/backend-probe.mjs';
import { UNAUTHORIZED } from '../harness/authtoken.mjs';

let bridge;
let ext;
let onChat = () => {};

before(async () => {
  bridge = await startBridge();
  // One extension for the whole file: the bridge round-robins between connected
  // clients, so connecting and disconnecting per test is what hands a test the
  // previous one's replies. The handler is swapped per test instead.
  ext = await new FakeExtension(bridge.base, { onChat: (job, emit) => onChat(job, emit) }).connect();
});
// The shell's readiness probe asks the backend whether it is there. The
// backend refuses every /rpc call without the loopback token (auth.test.mjs
// pins the gate), so a probe that went in bare was answered "unauthorized"
// — which is not the same as "not running": the shell then took the busy
// port as a free one, and the backend `tauri dev` waits for never came up.
test('the desktop shell\'s readiness probe presents the loopback token', () => {
  const src = fs.readFileSync(new URL('../../desktop/main.mjs', import.meta.url), 'utf8');
  const probe = src.slice(src.indexOf('const backendUp'), src.indexOf('const wait ='));
  assert.match(probe, /authHeaders\(\)/, 'the probe carries the token the backend asks for');
});

after(() => { ext.disconnect(); bridge.stop(); });

/** RPC on a free port, rooted at a temp project, answering through `ext`. */
async function startRpc({ files = {}, replies, rpcOptions = {}, ...rest } = {}) {
  const root = rest.root ? path.resolve(rest.root) : tempDir(files);
  onChat = scripted(replies);
  const rpc = await startRpcServer({
    root,
    bridgeURL: bridge.base,
    store: tempDir(),
    // Isolated settings, always: a test must never write the user's real
    // ~/.aipass/settings.json, and a polluted one must never steer a test.
    settings: new Settings(tempDir(), 'settings.json'),
    rulesFile: path.join(tempDir(), 'rules.json'),
    ...rest,
    ...rpcOptions,
  });
  const seen = [];
  rpc.harness.events.on('*', (type, payload) => seen.push({ type, payload }));
  return {
    root,
    rpc,
    ext,
    seen,
    types: (t) => seen.filter((e) => e.type === t).map((e) => e.payload),
    call: async (method, params = {}, headers = {}) => {
      const res = await fetch(`http://127.0.0.1:${rpc.port}/rpc`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ method, params }),
      });
      const body = await res.json();
      if (!body.ok) throw new Error(body.error);
      return body.result;
    },
    stop() { rpc.server.close(); },
  };
}

/** Wait until the harness has emitted one event of this type. */
async function waitForEvent(env, type, timeout = 8000) {
  const until = Date.now() + timeout;
  for (;;) {
    const found = env.types(type);
    if (found.length) return found.at(-1);
    if (Date.now() > until) return null;
    await new Promise((r) => setTimeout(r, 25));
  }
}

test('a run writes nothing until apply, then writes exactly the accepted files', async (t) => {
  const env = await startRpc({
    files: { 'notes.md': 'line one\nline two\n' },
    replies: [
      'EDIT notes.md\nFIND\nline two\nNEW\nline 2\nEND',
      'DONE patched the notes',
    ],
  });
  t.after(() => env.stop());

  const result = await env.call('run', { task: 'fix the second line', mode: 'auto', title: 'first' });
  assert.equal(result.pending.length, 1);
  assert.equal(result.pending[0].file, 'notes.md');
  assert.equal(fs.readFileSync(path.join(env.root, 'notes.md'), 'utf8'), 'line one\nline two\n', 'dry run left the disk alone');

  // The tool, the diff and the pending change were all reported on the wire.
  assert.ok(env.types('tool').some((p) => p.kind === 'replace' && p.ok));
  assert.ok(env.types('diff_update').some((p) => p.changes.some((c) => c.file === 'notes.md')));
  assert.equal(env.types('finished').length, 1);

  const applied = await env.call('apply', { files: ['notes.md'] });
  assert.equal(applied.written, 1);
  assert.equal(fs.readFileSync(path.join(env.root, 'notes.md'), 'utf8'), 'line one\nline 2\n');
  assert.equal((await env.call('pending')).length, 0);
});

test('a desktop run ships the bootstrap snapshot in turn 1', async (t) => {
  // The window's user never sees a --snapshot flag, and the same discovery
  // round trips are just as expensive there; the RPC-built harness turns the
  // snapshot on, and its label no longer claims a CLI flag asked for it.
  const env = await startRpc({
    files: {
      'a.txt': 'hello',
      'package.json': JSON.stringify({ name: 'snapshot-probe', scripts: { test: 'node --test' } }, null, 2),
    },
    replies: ['DONE looked around'],
  });
  t.after(() => env.stop());

  const before = env.ext.chats.length;
  await env.call('run', { task: 'look around', mode: 'auto', title: 'snapshot' });
  const first = env.ext.chats.slice(before)[0];
  assert.ok(first, 'the run sent a first message');
  assert.match(first.text, /Snapshot of where this project stands right now \(bootstrap snapshot\)/);
  assert.match(first.text, /package scripts:/);
  assert.match(first.text, /test: node --test/);
});

test('settings.set carries verifyCommand and requireCheck into the harness', async (t) => {
  const env = await startRpc({ files: { 'a.txt': 'hello' } });
  t.after(() => env.stop());

  const next = await env.call('settings.set', { verifyCommand: 'node check.mjs', requireCheck: true });
  assert.equal(next.verifyCommand, 'node check.mjs');
  assert.equal(next.requireCheck, true);
  assert.equal(env.rpc.harness.options.verifyCommand, 'node check.mjs');
  assert.equal(env.rpc.harness.options.requireCheck, true);
});

test('discard drops the pending change without touching the disk', async (t) => {
  const env = await startRpc({
    files: { 'a.txt': 'hello' },
    replies: ['EDIT a.txt\nFIND\nhello\nNEW\ngoodbye\nEND', 'DONE done'],
  });
  t.after(() => env.stop());

  await env.call('run', { task: 'change the greeting', mode: 'auto' });
  assert.equal((await env.call('pending')).length, 1);
  await env.call('discard');
  assert.equal((await env.call('pending')).length, 0);
  assert.equal(fs.readFileSync(path.join(env.root, 'a.txt'), 'utf8'), 'hello');
});

test('ask mode holds the write until the window answers, and honours a denial', async (t) => {
  const env = await startRpc({
    files: { 'a.txt': 'hello' },
    replies: ['EDIT a.txt\nFIND\nhello\nNEW\ngoodbye\nEND', 'DONE done'],
  });
  t.after(() => env.stop());

  const run = env.call('run', { task: 'change the greeting', mode: 'ask' });

  // The gate appears with an id; answering it lets the edit through.
  const asked = await waitForEvent(env, 'permission_request');
  assert.ok(asked, `expected a question; saw: ${JSON.stringify(env.seen.map((e) => e.type))}`);
  await env.call('permission.answer', { id: asked.id, decision: 'allow' });

  const result = await run;
  assert.equal(result.pending.length, 1);
  assert.equal(fs.readFileSync(path.join(env.root, 'a.txt'), 'utf8'), 'hello', 'ask mode never writes on its own');

  // A denial is reported back to the model and leaves nothing pending.
  const env2 = await startRpc({
    files: { 'a.txt': 'hi' },
    replies: ['EDIT a.txt\nFIND\nhi\nNEW\nbye\nEND', 'DONE done'],
  });
  t.after(() => env2.stop());
  const run2 = env2.call('run', { task: 'change it', mode: 'ask' });
  const denied = await waitForEvent(env2, 'permission_request');
  assert.ok(denied);
  await env2.call('permission.answer', { id: denied.id, decision: 'deny' });
  const r2 = await run2;
  assert.equal(r2.pending.length, 0);
  assert.ok(env2.seen.some((e) => e.type === 'tool' && /declined/.test(JSON.stringify(e.payload))));
});

test('the stop really stops: a run in flight ends as cancelled, not as done', async (t) => {
  // A reply that never comes: the run sits in the fetch, and the window's stop
  // has to end it there and then — the person pressed stop, so the work stops.
  const env = await startRpc({ files: { 'a.txt': 'hello\n' }, replies: [] });
  t.after(() => env.stop());
  onChat = async (_job, e) => { await e.text('still working on it'); /* never done */ };

  const run = env.call('run', { task: 'a long task', mode: 'auto' });
  await waitForEvent(env, 'task_start');

  const stopped = await env.call('cancel', { root: env.root });
  assert.equal(stopped.ok, true, 'the stop was accepted');

  const result = await run;
  assert.equal(result.stopReason, 'cancelled', 'the run ended as cancelled');
  assert.equal(result.steps, 0, 'and it did no work after the stop');
});

test("run frames carry the run's own session, even when another is opened mid-run", async (t) => {
  const env = await startRpc({
    files: { 'a.txt': 'hello' },
    replies: ['EDIT a.txt\nFIND\nhello\nNEW\ngoodbye\nEND', 'DONE done'],
  });
  t.after(() => env.stop());

  // Two sessions exist; the backend's current one is where the run will go.
  const browsed = await env.call('session.new', { title: 'browsed' });
  const runSession = await env.call('session.new', { title: 'run session' });

  // The tagged bus — exactly what the window's SSE carries.
  const bus = [];
  env.rpc.events.on('*', (type, payload) => bus.push({ type, payload }));

  const run = env.call('run', { task: 'change the greeting', mode: 'ask' });
  const asked = await waitForEvent(env, 'permission_request');
  assert.ok(asked, 'the run paused at the permission gate');

  // The human browses another session while the run is still going.
  await env.call('session.open', { id: browsed.id });
  await env.call('permission.answer', { id: asked.id, decision: 'allow' });
  await run;

  const snap = await env.call('snapshot');
  assert.equal(snap.session.id, browsed.id, 'the backend now shows the browsed session');
  const runFrames = bus.filter((e) => e.payload?.session);
  assert.ok(runFrames.length >= 3, `expected run frames, saw: ${JSON.stringify(bus.map((e) => e.type))}`);
  for (const f of runFrames) {
    assert.equal(f.payload.session, runSession.id, `${f.type} carried the run's session`);
  }
  assert.equal(bus.find((e) => e.type === 'task_start')?.payload.session, runSession.id);
  assert.equal(bus.find((e) => e.type === 'finished')?.payload.session, runSession.id);
});

test('switching projects closes the mcp clients of the idle harness left behind', async (t) => {
  const env = await startRpc({ files: {} });
  t.after(() => env.stop());

  const idle = env.rpc.harness; // the harness the backend opened on
  const idleClosed = [];
  const origIdle = idle.mcp.close.bind(idle.mcp);
  idle.mcp.close = () => { idleClosed.push('x'); return origIdle(); };

  const other = tempDir();
  await env.call('projects.switch', { path: other });
  assert.equal(idleClosed.length, 1, 'the harness left behind has its mcp clients closed');

  const entered = env.rpc.current;
  const enteredClosed = [];
  const origEntered = entered.mcp.close.bind(entered.mcp);
  entered.mcp.close = () => { enteredClosed.push('x'); return origEntered(); };

  // A run in flight keeps its servers: the run may still call an MCP tool.
  entered.running = true;
  await env.call('projects.switch', { path: env.root });
  assert.equal(enteredClosed.length, 0, 'a running harness keeps its clients');
  assert.equal(idleClosed.length, 1, 'the project being entered is not closed');

  entered.running = false;
  await env.call('projects.switch', { path: other });
  assert.equal(idleClosed.length, 2, 'once idle, it is closed on the next visit away');
});

test('a project switch mid-run cannot repoint the run it did not start', async (t) => {
  // Two windows, one backend: the run lands on the project its window named,
  // and everything after its awaits — the returned pending list included —
  // still belongs to that harness when another window makes another project
  // current while the run is paused at its permission gate.
  const env = await startRpc({
    files: { 'notes.md': 'line one\nline two\n' },
    replies: ['EDIT notes.md\nFIND\nline two\nNEW\nline 2\nEND', 'DONE patched the notes'],
  });
  t.after(() => env.stop());

  const run = env.call('run', { task: 'fix the second line', mode: 'ask', root: env.root });
  const asked = await waitForEvent(env, 'permission_request');
  assert.ok(asked, 'the run paused at the permission gate');

  const elsewhere = tempDir({ 'other.txt': 'b\n' });
  await env.call('projects.switch', { path: elsewhere });
  await env.call('permission.answer', { id: asked.id, decision: 'allow', project: env.root });
  const result = await run;

  assert.equal(result.pending.length, 1, "the returned pending list is the run's own project");
  assert.equal(result.pending[0].file, 'notes.md');
  assert.equal(env.types('finished').length, 1, 'the run reported on the harness it started on');
  assert.deepEqual(await env.call('pending'), [], 'the project switched to has nothing pending');
});

test('plan mode parses PLAN and TODO, and stops the run until the plan is approved', async (t) => {
  const env = await startRpc({
    files: { 'a.txt': 'hello' },
    replies: [
      'PLAN\nread the file\nchange one line\nEND\nTODO\n- read the file\n- change one line\nEND\nNEED file a.txt',
      'DONE did the work',
    ],
  });
  t.after(() => env.stop());

  const run = env.call('run', { task: 'do the thing', mode: 'auto', requirePlanApproval: true });

  const todos = await waitForEvent(env, 'todo');
  assert.ok(todos, 'a todo event was emitted');
  assert.deepEqual(todos.items.map((i) => i.text), ['read the file', 'change one line']);
  assert.ok(env.types('plan_request').length === 1, 'the plan waited for approval');

  await env.call('plan.answer', { ok: true });
  const result = await run;
  assert.equal(result.stopReason, 'done');
});

test('context pressure rotates the conversation and records a compaction entry', async (t) => {
  const env = await startRpc({
    files: { 'a.txt': 'x' },
    // Thai closings: with the reply-language hook on by default, an English
    // DONE summary would earn a Thai-rewrite request and eat the summary reply
    // this test pins.
    replies: ['DONE งานแรกเสร็จแล้ว', 'SUMMARY: read a.txt and learned its one line.', 'DONE งานที่สองเสร็จแล้ว'],
    // tiny budget, so the second run has to compact before it starts
    rpcOptions: { compaction: { contextTokens: 60, reserveTokens: 0, keepRecentBytes: 0 } },
  });
  t.after(() => env.stop());

  await env.call('run', { task: 'first task', mode: 'auto' });
  const createdAfterFirst = env.ext.created.length;

  const rpc2 = await env.call('run', { task: 'second task', mode: 'auto' });
  assert.equal(rpc2.stopReason, 'done');
  assert.ok(env.types('compacted').length === 1, 'compaction was announced');
  assert.ok(env.ext.created.length > createdAfterFirst, 'a fresh conversation was created for the rotation');

  const entries = await env.call('session.entries');
  const compaction = entries.find((e) => e.type === 'compaction');
  assert.ok(compaction, 'the session carries the summary');
  assert.match(compaction.summary, /SUMMARY/);
});

test('a helper runs in its own conversation and its edits land in the parent pending list', async (t) => {
  const env = await startRpc({
    files: { 'notes.md': 'one\ntwo\n' },
    replies: [
      'SUBAGENT\ntask: append a line to notes.md\nEND',
      'CREATE notes-helper.txt\nhelper output\nEND\nDONE helper finished its part',
      'DONE main task finished',
    ],
  });
  t.after(() => env.stop());

  const result = await env.call('run', { task: 'delegate a piece', mode: 'auto', subagent: true });
  assert.equal(result.stopReason, 'done');

  assert.ok(env.types('helper_start').length === 1, 'the helper started');
  assert.ok(env.types('helper_end').length === 1, 'the helper reported back');
  assert.ok(env.ext.created.length >= 2, `main + helper conversations were created (${env.ext.created.length})`);

  // The helper could not write to disk itself — its file is a pending proposal.
  assert.equal(fs.existsSync(path.join(env.root, 'notes-helper.txt')), false);
  const pending = await env.call('pending');
  assert.ok(pending.some((p) => p.file === 'notes-helper.txt'), `helper edit is pending: ${JSON.stringify(pending)}`);
});

test('sessions survive the window: list, open, fork', async (t) => {
  const env = await startRpc({
    files: { 'a.txt': 'hello' },
    replies: ['NEED file a.txt', 'DONE read it'],
  });
  t.after(() => env.stop());

  await env.call('run', { task: 'look at a.txt', mode: 'auto', title: 'reading' });
  const list = await env.call('session.list');
  assert.equal(list.length, 1);
  assert.equal(list[0].title, 'reading');

  const opened = await env.call('session.open', { id: list[0].id });
  assert.ok(opened);
  const entries = await env.call('session.entries');
  assert.ok(entries.some((e) => e.type === 'task'));
  assert.ok(entries.some((e) => e.type === 'tool' && e.kind === 'read'));

  const forked = await env.call('session.fork');
  assert.notEqual(forked.id, list[0].id);
  const forkEntries = await env.call('session.open', { id: forked.id });
  assert.ok(forkEntries);
  assert.ok((await env.call('session.list')).length === 2, 'the fork is listed too');
});

test('the event stream pushes frames to a subscriber', async (t) => {
  const env = await startRpc({
    files: { 'a.txt': 'x' },
    replies: ['DONE nothing to do'],
  });
  t.after(() => env.stop());

  const res = await fetch(`http://127.0.0.1:${env.rpc.port}/events`);
  assert.equal(res.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  const reader = res.body.getReader();
  const first = await reader.read();
  const frame = new TextDecoder().decode(first.value);
  assert.match(frame, /event: hello/);
  reader.cancel();
});

/* ------------------------------------------------------------- bridge URL */

/** createRpc with every store hermetic, and no bridgeURL argument at all. */
async function startEnvRpc() {
  return startRpcServer({
    root: tempDir({ 'a.txt': 'x' }),
    store: tempDir(),
    settings: new Settings(tempDir(), 'settings.json'),
    pluginsDir: tempDir(),
    rulesFile: path.join(tempDir(), 'rules.json'),
    // The suite runs its own bridge; a backend that autostarts one would
    // spawn a second listener (and a detached process) for a test that only
    // asks which address the harness client resolved.
    autostartBridge: false,
  });
}

test('AIPASS_BRIDGE reaches the bridge client the harness actually chats with', async (t) => {
  // No bridgeURL is passed: the environment is the only way the client could
  // learn an address, and it must be the same client the run traffic uses.
  const bridgePort = await freePort();
  const saved = process.env.AIPASS_BRIDGE;
  process.env.AIPASS_BRIDGE = `127.0.0.1:${bridgePort}`;
  let rpc;
  try {
    rpc = await startEnvRpc();
    assert.equal(rpc.harness.bridge.base, `http://127.0.0.1:${bridgePort}`);
  } finally {
    rpc?.server.close();
    if (saved === undefined) delete process.env.AIPASS_BRIDGE;
    else process.env.AIPASS_BRIDGE = saved;
  }
});

test('with no AIPASS_BRIDGE the bridge client keeps the loopback default', async (t) => {
  const saved = process.env.AIPASS_BRIDGE;
  delete process.env.AIPASS_BRIDGE;
  let rpc;
  try {
    rpc = await startEnvRpc();
    assert.equal(rpc.harness.bridge.base, 'http://127.0.0.1:8787');
  } finally {
    rpc?.server.close();
    if (saved !== undefined) process.env.AIPASS_BRIDGE = saved;
  }
});

/* ----------------------------------------------------------- request hygiene */

test('a malformed JSON body is answered as bad JSON, not as a missing method', async (t) => {
  const env = await startRpc({ files: {}, replies: [] });
  t.after(() => env.stop());

  const res = await fetch(`http://127.0.0.1:${env.rpc.port}/rpc`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"method":',
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.match(body.error, /bad JSON body/);
  assert.doesNotMatch(body.error, /no such method/, 'the parse failure must not masquerade as an unknown method');

  // An empty body is still "no method given", not a parse error.
  const empty = await fetch(`http://127.0.0.1:${env.rpc.port}/rpc`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '',
  });
  assert.equal(empty.status, 404);
  assert.match((await empty.json()).error, /no such method/);
});

/* ------------------------------------------------------------- static files */

test('the static file guard serves ui/ and nothing beside it', async (t) => {
  // ui/ with a sibling whose name merely begins with ui's: a string-prefix
  // check served the sibling once a request path carried a `..`, because
  // '…\\ui-x\\f' starts with '…\\ui'. The guard has to be a path boundary.
  const parent = tempDir();
  const ui = path.join(parent, 'ui');
  fs.mkdirSync(ui);
  fs.writeFileSync(path.join(ui, 'index.html'), '<title>aipass desktop</title>');
  fs.writeFileSync(path.join(ui, 'app.js'), '// ui code');
  const sibling = path.join(parent, 'ui-x');
  fs.mkdirSync(sibling);
  fs.writeFileSync(path.join(sibling, 'secret.txt'), 'not for the window');

  assert.equal(staticFileFor(ui, '/'), path.join(ui, 'index.html'));
  assert.equal(staticFileFor(ui, '/app.js'), path.join(ui, 'app.js'));
  assert.equal(fs.existsSync(sibling), true, 'the sibling really is outside ui');
  assert.equal(staticFileFor(ui, '/../ui-x/secret.txt'), null, 'a `..` into the sibling must not resolve');
  assert.equal(staticFileFor(ui, '/..'), null, 'the parent of ui is not served either');
  assert.equal(staticFileFor(ui, '/./app.js'), path.join(ui, 'app.js'), 'a harmless dot segment still resolves');

  // path.relative compares case-insensitively on Windows, so the guard does
  // not answer `..` merely because the drive letter or case spelling differs.
  if (process.platform === 'win32') {
    assert.equal(staticFileFor(ui.toUpperCase(), '/INDEX.HTML'), path.join(ui.toUpperCase(), 'INDEX.HTML'),
      'a case-spelled path stays inside ui; the handler isFile check does the rest');
  }

  // Over HTTP the URL parser collapses literal dot segments, so the sibling
  // case is provable at the helper; the wire check pins the behaviour that
  // remains observable there: real files serve, encoded traversal does not.
  const env = await startRpc({ files: {}, replies: [] });
  t.after(() => env.stop());
  const home = await fetch(`http://127.0.0.1:${env.rpc.port}/`);
  assert.equal(home.status, 200);
  const sneaky = await fetch(`http://127.0.0.1:${env.rpc.port}/%2e%2e/ui-x/secret.txt`);
  assert.equal(sneaky.status, 404);
});

/* ------------------------------------------------- settings, projects, uploads */

test('settings are read, changed and persisted', async (t) => {
  const settings = new Settings(tempDir(), 'settings.json');
  const env = await startRpc({ files: { 'a.txt': 'x' }, replies: ['DONE nothing'], settings });
  t.after(() => env.stop());

  const before = await env.call('settings.get');
  assert.equal(before.mode, 'ask');

  const after = await env.call('settings.set', { mode: 'auto', maxSteps: 4 });
  assert.equal(after.mode, 'auto');
  // The live engine took the change too, not just the file.
  assert.equal(env.rpc.current.options.mode, 'auto');

  // A fresh Settings object reads the same file back.
  const reloaded = new Settings(path.dirname(settings.file), 'settings.json');
  assert.equal(reloaded.get('mode'), 'auto');
  assert.equal(reloaded.get('maxSteps'), 4);
});

test('projects are listed, added and switched, each with its own sessions', async (t) => {
  const settings = new Settings(tempDir(), 'settings.json');
  const first = tempDir({ 'a.txt': 'one' });
  const second = tempDir({ 'a.txt': 'two' });
  const env = await startRpc({ files: {}, replies: ['DONE nothing'], root: first, settings });
  t.after(() => env.stop());

  const list = await env.call('projects.list');
  assert.ok(list.some((p) => p.path === path.resolve(first)), 'the starting root is a project');

  await env.call('projects.add', { path: second, name: 'second' });
  const switched = await env.call('projects.switch', { path: second });
  assert.equal(switched.root, path.resolve(second));

  // The file panel now shows the second project's tree.
  const entries = await env.call('fs.list', { dir: '.' });
  assert.ok(entries.some((e) => e.name === 'a.txt'));
  assert.equal((await env.call('fs.read', { file: 'a.txt' })).text, 'two');

  // A run in the second project writes there, and nowhere else.
  onChat = scripted(['CREATE b.txt\nmade in the second\nEND', 'DONE made it']);
  const result = await env.call('run', { task: 'make a file', mode: 'auto' });
  assert.equal(result.pending.length, 1);
  await env.call('apply');
  assert.equal(fs.readFileSync(path.join(second, 'b.txt'), 'utf8'), 'made in the second');
  assert.equal(fs.existsSync(path.join(first, 'b.txt')), false);
});

test('an image or a video is staged, listed and dropped', async (t) => {
  const env = await startRpc({ files: {}, replies: ['DONE nothing'] });
  t.after(() => env.stop());

  // A 1x1 transparent PNG, the smallest legal payload.
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const item = await env.call('attachment.stage', { name: 'pixel.png', dataUrl: png });
  assert.equal(item.mime, 'image/png');
  assert.ok(item.bytes > 0);

  const staged = await env.call('attachment.list');
  assert.equal(staged.length, 1);
  assert.equal(staged[0].name, 'pixel.png');

  await env.call('attachment.remove', { id: item.id });
  assert.equal((await env.call('attachment.list')).length, 0);

  // An empty payload and an unknown kind are both refused, not half-written.
  await assert.rejects(() => env.call('attachment.stage', { name: 'x.png', dataUrl: 'data:image/png;base64,' }));
});

test('staging by path caps size, and dropping never deletes the user original', async (t) => {
  const env = await startRpc({ files: { 'small.txt': 'hello\n' }, replies: ['DONE nothing'] });
  t.after(() => env.stop());

  // A normal path stage copies into the upload dir; dropping removes the copy.
  const copied = await env.call('attachment.stage', { path: 'small.txt' });
  assert.ok(fs.existsSync(copied.path), 'staged copy exists');
  await env.call('attachment.remove', { id: copied.id });
  assert.ok(!fs.existsSync(copied.path), 'the copy is cleaned up');
  assert.ok(fs.existsSync(path.join(env.root, 'small.txt')), 'the project file survives');

  // A file already sitting in the upload dir is referenced, not copied — and
  // dropping the reference must NOT unlink the user's file.
  const uploadDir = env.rpc.settings.uploadDir();
  const mine = path.join(uploadDir, 'mine.txt');
  fs.writeFileSync(mine, 'my own file\n');
  const ref = await env.call('attachment.stage', { path: mine });
  assert.equal(ref.path, mine, 'sameDir stage references the original');
  await env.call('attachment.remove', { id: ref.id });
  assert.ok(fs.existsSync(mine), 'dropping a sameDir reference keeps the original');

  // Oversize path staging is refused BEFORE the read (no OOM on multi-GB files).
  const big = path.join(env.root, 'big.bin');
  fs.writeFileSync(big, Buffer.alloc(21 * 1024 * 1024));
  await assert.rejects(() => env.call('attachment.stage', { path: 'big.bin' }), /too large/);
  fs.rmSync(big);
});

test('a plugin adds a tool the model uses, a panel, and an RPC method', async (t) => {
  const pluginDir = tempDir();
  fs.writeFileSync(path.join(pluginDir, 'echo.mjs'), `
export default {
  name: 'echo',
  version: '2.1.0',
  description: 'repeats back whatever it is given',
  setup(ctx) {
    ctx.tools.register('ECHO', async ({ arg }) => 'echo: ' + arg, { description: 'repeat the text back' });
    ctx.panel({ id: 'echo', title: 'echo panel', render: async () => ({ html: '<ul><li>panel says hi</li></ul>' }) });
    ctx.rpc.method('plugin.echo.ping', async () => 'pong');
  },
};
`);

  const env = await startRpc({
    files: { 'a.txt': 'hello' },
    replies: ['ECHO hello there', 'DONE echoed'],
    rpcOptions: { pluginsDir: pluginDir },
  });
  t.after(() => env.stop());

  const details = await env.call('plugins.list');
  assert.equal(details.loaded.length, 1);
  assert.equal(details.loaded[0].name, 'echo');
  assert.ok(details.tools.includes('ECHO'));

  // The window's sidebar can render the panel.
  const panel = await env.call('panel.render', { id: 'echo' });
  assert.match(panel.html, /panel says hi/);

  // A plugin method answers a window call.
  const ping = await fetch(`http://127.0.0.1:${env.rpc.port}/rpc`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method: 'plugin.echo.ping' }),
  }).then((r) => r.json());
  assert.deepEqual(ping.result, 'pong');

  // And the model can call the tool it registered.
  const result = await env.call('run', { task: 'echo something', mode: 'auto' });
  assert.equal(result.stopReason, 'done');
  assert.ok(env.seen.some((e) => e.type === 'plugin_call' && e.payload.marker === 'ECHO'));
  assert.ok(env.seen.some((e) => e.type === 'tool' && e.payload.arg === 'hello there'));
});

test('the window only reaches for elements that exist', async (t) => {  // A typo in an id is invisible until runtime, and a window that half-works
  // is worse than one that does not — so the contract is checked here.
  const uiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'desktop', 'ui');
  const html = fs.readFileSync(path.join(uiDir, 'index.html'), 'utf8');
  const js = fs.readFileSync(path.join(uiDir, 'app.js'), 'utf8');
  const referenced = [...new Set([...js.matchAll(/\$\('([a-z0-9-]+)'\)/g)].map((m) => m[1]))];
  const createdAtRuntime = [...new Set([...js.matchAll(/\.id = '([a-z0-9-]+)'/g)].map((m) => m[1]))];
  const missing = referenced.filter((id) => !createdAtRuntime.includes(id) && !html.includes(`id="${id}"`));
  assert.deepEqual(missing, [], `app.js references ids the html does not have: ${missing.join(', ')}`);
});

test('the backend serves the window files in every layout', async (t) => {
  // UI_DIR is a candidate chain (desktop/ui in the repo, ui/ beside
  // aipass-bridge in the shipped layout) — whichever layout the backend runs
  // from, the window must get the real files and nothing else.
  const env = await startRpc({ files: {}, replies: [] });
  t.after(() => env.stop());

  const home = await fetch(`http://127.0.0.1:${env.rpc.port}/`);
  assert.equal(home.status, 200);
  assert.match(await home.text(), /<title>aipass desktop<\/title>/);

  const missing = await fetch(`http://127.0.0.1:${env.rpc.port}/no-such-file.js`);
  assert.equal(missing.status, 404);
});

test('every top-level aipass-bridge cli is in the packaged resources', async (t) => {
  // tauri.conf.json enumerates resources file-by-file: a new CLI at
  // aipass-bridge/*.mjs that nobody adds there ships a window whose command
  // is missing. The dirs (bin/, bridge/, harness/, extension/, deploy/) ride
  // as whole trees, so only the loose files need this pin.
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const conf = JSON.parse(fs.readFileSync(path.join(repo, 'desktop', 'src-tauri', 'tauri.conf.json'), 'utf8'));
  const resources = conf.bundle.resources ?? {};
  const shipped = new Set(Object.values(resources).map((v) => String(v).replace(/\/$/, '')));
  const loose = fs.readdirSync(path.join(repo, 'aipass-bridge'))
    .filter((f) => f.endsWith('.mjs'));
  const missing = loose.filter((f) => !shipped.has(`aipass-bridge/${f}`));
  assert.deepEqual(missing, [], `packaged resources miss: ${missing.join(', ')} — add them to desktop/src-tauri/tauri.conf.json`);
});

test('the shell\'s JSON files parse — a byte order mark breaks the Rust build', async (t) => {
  // A BOM in front of a JSON file is invisible in an editor and fatal to the
  // build: the Rust build script says "failed to parse JSON" and nothing else.
  // The suite reads the same files, so it says it first.
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const files = [
    path.join(repo, 'desktop', 'src-tauri', 'tauri.conf.json'),
    path.join(repo, 'desktop', 'src-tauri', 'capabilities', 'default.json'),
  ];
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    const raw = fs.readFileSync(file);
    assert.equal(raw[0], 0x7b, `${path.basename(file)} must start with "{" — a byte order mark breaks the build`);
    assert.doesNotThrow(() => JSON.parse(raw.toString('utf8')), `${path.basename(file)} must parse`);
  }
});

test('reading helpers: file listing, file text, and the playbook library', async (t) => {
  const env = await startRpc({
    files: {
      'a.txt': 'hello world',
      'sub/b.txt': 'nested',
      // The playbook library is machine-local user data (one level above the
      // repo, or ~/.aipass/skills) that never ships inside the repo, so a
      // fresh clone has none. Seed the project library to keep this test
      // hermetic instead of depending on whatever the machine happens to have.
      '.aipass/skills/playbook.md': 'step one\nstep two\n',
    },
    replies: ['DONE nothing'],
  });
  t.after(() => env.stop());

  const listing = await env.call('fs.list', { dir: '.' });
  assert.ok(listing.some((e) => e.name === 'a.txt'));
  const read = await env.call('fs.read', { file: 'a.txt' });
  assert.equal(read.text, 'hello world');

  const skills = await env.call('skills.list');
  assert.ok(skills.length > 0, 'the playbook library is listed');
  const first = await env.call('skills.load', { name: skills[0].name });
  assert.ok(first.text.length > 0);

  // A path outside the root is refused, not served.
  await assert.rejects(() => env.call('fs.read', { file: '../outside.txt' }));
});

// The same slip with a helper: DONE in the SUBAGENT's own reply used to end
// the run before the summary arrived - the helper's whole report went unread.
test('a DONE beside a SUBAGENT waits for the helper summary', async (t) => {
  const env = await startRpc({
    files: { 'notes.md': 'one\ntwo\n' },
    replies: [
      'SUBAGENT\ntask: say what notes.md holds\nEND\nDONE delegated it',
      'The helper read notes.md and reports two short lines',
      'DONE the helper summary is in',
    ],
  });
  t.after(() => env.stop());

  const result = await env.call('run', { task: 'delegate a piece', mode: 'auto', subagent: true });
  assert.equal(result.stopReason, 'done');
  assert.equal(env.types('helper_end').length, 1, 'the helper reported back');
  assert.equal(env.types('ignore_done').length, 1, 'the premature DONE was not accepted');
  assert.equal(env.types('done_line').at(-1)?.text, 'the helper summary is in',
    'the run carried on with the summary and ended on the second DONE');
});

/* ------------------------------------------------------- two windows, two projects */

test('two windows on two projects do not share state, and Apply writes only its own', async (t) => {
  // The backend holds one harness per project, and the window says which
  // project it is showing. Without that, the window that spoke last decided
  // what the other one read — and one window's Apply button wrote the other
  // window's staged edits.
  const env = await startRpc({
    files: { 'notes.md': 'line one\n' },
    replies: ['EDIT notes.md\nFIND\nline one\nNEW\nline 2\nEND', 'DONE patched the notes'],
  });
  t.after(() => env.stop());
  const other = tempDir({ 'other.md': 'other\n' });
  await env.call('projects.add', { path: other });

  // A run in the first project stages a change there.
  await env.call('run', { task: 'patch the notes', mode: 'auto' }, { 'x-aipass-project': env.root });
  const mine = await env.call('pending', {}, { 'x-aipass-project': env.root });
  assert.equal(mine.length, 1, 'the change is staged in the first project');

  // The second window, on the other project, sees nothing — and writes nothing.
  const theirs = await env.call('pending', {}, { 'x-aipass-project': other });
  assert.equal(theirs.length, 0, 'the other window sees no pending change');
  const writtenByOther = await env.call('apply', {}, { 'x-aipass-project': other });
  assert.equal(writtenByOther.written, 0, 'the other window wrote nothing');
  assert.equal(fs.readFileSync(path.join(env.root, 'notes.md'), 'utf8'), 'line one\n',
    "the first project's file is untouched");

  // And the first window's own Apply still writes its own change.
  const applied = await env.call('apply', {}, { 'x-aipass-project': env.root });
  assert.equal(applied.written, 1, 'the first window applied its own change');
  assert.equal(fs.readFileSync(path.join(env.root, 'notes.md'), 'utf8'), 'line 2\n');
});

test('a session list belongs to the project the caller named', async (t) => {
  const env = await startRpc({ files: { 'a.txt': 'a' }, replies: [] });
  t.after(() => env.stop());
  const other = tempDir({ 'b.txt': 'b' });
  await env.call('projects.add', { path: other });

  const inFirst = await env.call('session.new', { title: 'in the first' }, { 'x-aipass-project': env.root });
  const inSecond = await env.call('session.new', { title: 'in the second' }, { 'x-aipass-project': other });

  const first = await env.call('session.list', {}, { 'x-aipass-project': env.root });
  const second = await env.call('session.list', {}, { 'x-aipass-project': other });
  assert.deepEqual(first.map((s) => s.id), [inFirst.id], 'the first window sees its own session');
  assert.deepEqual(second.map((s) => s.id), [inSecond.id], 'the second window sees its own session');
});

test('a relative attachment path is relative to the project, not to the backend', async (t) => {
  // The window's file panel hands over project-relative paths. They resolved
  // against the folder the backend started in, so "แนบ" failed for every
  // project except that one.
  const env = await startRpc({ files: { 'notes.txt': 'hello' }, replies: [] });
  t.after(() => env.stop());
  const other = tempDir({ 'far.txt': 'far away' });
  await env.call('projects.add', { path: other });

  const staged = await env.call('attachment.stage', { path: 'far.txt' }, { 'x-aipass-project': other });
  assert.equal(staged.name, 'far.txt', 'the file in the named project was staged');
  await env.call('attachment.remove', { id: staged.id });
});

/* ------------------------------------------------------------------ sessions */

test('a short session id does not delete a session', async (t) => {
  // Every session file is named session-<id>.jsonl, so a substring match made
  // a one-character id land on whichever session came first. The match has to
  // be the whole name.
  const env = await startRpc({ files: {}, replies: [] });
  t.after(() => env.stop());
  const s = await env.call('session.new', { title: 'only one' });
  assert.equal((await env.call('session.list')).length, 1);

  await env.call('session.delete', { id: s.id.slice(0, 1) });
  const left = await env.call('session.list');
  assert.equal(left.length, 1, 'the session nobody named is still there');
});

test('the window cannot be made to read a huge file, or a binary one as text', async (t) => {
  // The file panel opens a file in the project. It used to read whatever it
  // was pointed at — a 500 MB log filled the backend's memory and the answer
  // with it, and a PNG read as UTF-8 is a screenful of mojibake.
  const env = await startRpc({ files: { 'notes.txt': 'hello' }, replies: [] });
  t.after(() => env.stop());

  fs.writeFileSync(path.join(env.root, 'big.log'), 'x'.repeat(1_200_000));
  await assert.rejects(() => env.call('fs.read', { file: 'big.log' }), /too large to open/);

  fs.writeFileSync(path.join(env.root, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  await assert.rejects(() => env.call('fs.read', { file: 'logo.png' }), /PNG file/);

  const read = await env.call('fs.read', { file: 'notes.txt' });
  assert.equal(read.text, 'hello', 'a text file still opens');
});

test('a body over the cap is answered, not dropped on the floor', async (t) => {
  // The old cap destroyed the request without a word, so the client saw a
  // transport error it could not read — the window's "attach" of a large file
  // looked like the app had crashed.
  const env = await startRpc({ files: {}, replies: [], rpcOptions: { maxBody: 2048 } });
  t.after(() => env.stop());

  const res = await fetch(`http://127.0.0.1:${env.rpc.port}/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method: 'status', params: { pad: 'x'.repeat(4096) } }),
  }).catch((err) => ({ error: String(err) }));
  assert.equal(res.error, undefined, `the request was answered, not cut: ${res.error ?? ''}`);
  assert.equal(res.status, 413, 'and the answer says the body was too large');
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.match(body.error, /too large/);
});

test('the window is served under a policy, not without one', async (t) => {
  // The window is a page that drives an agent that writes files, and it is
  // loaded from this backend over plain HTTP. The shell's own declaration
  // covers the asset protocol, which this window does not use — so the header
  // the backend sends is the one that binds, and there was none.
  const env = await startRpc({ files: {}, replies: [] });
  t.after(() => env.stop());

  const res = await fetch(`${env.rpc.url}/`);
  assert.equal(res.status, 200);
  const csp = res.headers.get('content-security-policy');
  assert.ok(csp, 'the document carries a policy');
  assert.match(csp, /script-src 'self'/, 'scripts come from the app itself — no inline, no eval');
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /frame-ancestors 'none'/, 'and the window cannot be framed');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
});

test('the code-navigation index answers for the window', async (t) => {
  // The SYMBOLS/DEF/REFS markers use this index from inside a run. The window
  // asks for the same thing from outside one, so a person can find a
  // declaration without starting a run for it.
  const env = await startRpc({
    files: {
      'src/app.mjs': 'export function greet(name) {\n  return name;\n}\n',
      'src/other.mjs': 'import { greet } from "./app.mjs";\ngreet("x");\n',
    },
    replies: [],
  });
  t.after(() => env.stop());

  const list = await env.call('symbols.list', { file: 'src/app.mjs' });
  assert.ok(list.symbols.some((s) => s.name === 'greet'), 'the file declares it');

  const def = await env.call('symbols.def', { name: 'greet' });
  assert.ok(def.definitions.length >= 1, 'the name is defined somewhere');
  assert.ok(def.definitions.some((d) => d.file === 'src/app.mjs'), 'in the file that declares it');

  const refs = await env.call('symbols.refs', { name: 'greet' });
  assert.ok(refs.references.length >= 1, 'and it is used somewhere');

  // The index is the project's: a path outside it has no symbols, and no way
  // to reach a file that is not in the project.
  const outside = await env.call('symbols.list', { file: '../outside.mjs' });
  assert.deepEqual(outside.symbols, [], 'nothing outside the project answers');
});

/* ------------------------------------------------------------------- launcher */
test('the launcher finds a backend that is already running', async (t) => {
  // The backend's /rpc is behind the loopback token, so a probe without one
  // gets a 401. A launcher that only accepts 200 never sees the running
  // backend, starts a second one, and the window opens on "port is busy".
  const port = await freePort();
  const ours = http.createServer((_req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: UNAUTHORIZED }));
  });
  await new Promise((r) => ours.listen(port, '127.0.0.1', r));
  t.after(() => ours.close());
  assert.equal(await backendIsUp(port), true, 'our own 401 is still our backend');
});

test('the launcher does not adopt somebody else\'s server', async (t) => {
  // A 401 that is not ours means the port belongs to something else. The
  // launcher has to say "the port is busy", not adopt a stranger.
  const port = await freePort();
  const stranger = http.createServer((_req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'not our backend' }));
  });
  await new Promise((r) => stranger.listen(port, '127.0.0.1', r));
  t.after(() => stranger.close());
  assert.equal(await backendIsUp(port), false, 'a foreign server is not our backend');
});
