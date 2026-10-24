// The hooks: the person's own commands, at the points that matter.
//
// The harness had rules, skills and plugins, but no place for "run this after
// every edit" or "run this before every commit". A hook is that place: a
// command line the PERSON configured, bound to a moment, run by the harness
// and reported back to the model.
//
// The four contracts below are the ones a hook has to keep:
//   - it runs when the run stages a change,
//   - its output is screened for secrets before it becomes a transcript,
//   - a hook that fails is reported and the run continues,
//   - and it never asks the model for permission, because the person
//     configured it and the model did not.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTools } from '../harness/tools.mjs';
import { Overlay } from '../harness/overlay.mjs';
import { Emitter } from '../harness/events.mjs';
import { SessionStore } from '../harness/session.mjs';
import { BridgeClient } from '../harness/bridge.mjs';
import { Harness } from '../harness/harness.mjs';
import { parseCommandLine, runHooks } from '../harness/hooks.mjs';

// The settings file is the truth, and the harness reads it when a hook
// fires — so the home is pointed at a scratch directory before anything
// else is imported (aipassHome() reads the environment when it is used).
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aipass-hooks-home-'));
process.env.AIPASS_HOME = HOME;

const dirs = [];
const tempDir = (files = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aipass-hooks-'));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    const p = path.join(dir, name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  return dir;
};

/** The settings file the hooks are read from. */
const withHooks = (hooks) => {
  fs.writeFileSync(path.join(HOME, 'settings.json'), JSON.stringify({ hooks }, null, 2));
};

after(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(HOME, { recursive: true, force: true });
});

const HOOK_SCRIPT = `import fs from 'node:fs';
fs.writeFileSync('hook-ran.txt', 'the hook ran\\n');
console.log('HOOK SAID: the check passed');
`;

const toolsIn = (dir) => createTools({ root: dir, overlay: new Overlay(dir) });

/** A bridge that answers with the replies it was given, in order. */
class StubBridge extends BridgeClient {
  constructor(replies) {
    super('http://127.0.0.1:1');
    this.model = 'stub';
    this.replies = replies;
    this.turn = 0;
    this.sends = [];
    this.created = 0;
  }
  async chat({ message } = {}) {
    this.sends.push(message);
    const reply = this.replies[Math.min(this.turn, this.replies.length - 1)];
    this.turn += 1;
    return { text: reply, reasoning: '' };
  }
  async quota() { return { available: 10 }; }
  async createConversation() { this.created += 1; return { id: `conv-${this.created}` }; }
  async config() {}
  async status() { return { conversation: 'conv-1' }; }
}

test('a hook runs after the run stages a change', async () => {
  withHooks({ afterWrite: 'node hook.mjs' });
  const dir = tempDir({ 'hook.mjs': HOOK_SCRIPT });
  const tools = toolsIn(dir);

  const out = await tools.write('notes.txt', 'hello\n');

  assert.match(out, /wrote notes\.txt/, 'the change is staged');
  assert.match(out, /hook \(afterWrite\)/, 'the hook is named in the result');
  assert.match(out, /HOOK SAID: the check passed/, 'and what it said comes back to the model');
  assert.ok(fs.existsSync(path.join(dir, 'hook-ran.txt')), 'the hook ran in the project');
});

test("a hook's output is screened for secrets", async () => {
  withHooks({ afterWrite: 'node hook.mjs' });
  const dir = tempDir({
    'hook.mjs': `console.log('API_KEY=sk-abcdefghij12345');
console.log('token ghp_abcdefghij123456');\n`,
  });
  const tools = toolsIn(dir);

  const out = await tools.write('notes.txt', 'hello\n');

  assert.doesNotMatch(out, /sk-abcdefghij12345/, 'the key does not reach the transcript');
  assert.doesNotMatch(out, /ghp_abcdefghij123456/, 'nor the token');
  assert.match(out, /\[redacted\]/, 'the shape of the secret is still reported');
});

test('a hook that fails is reported, and the run continues', async () => {
  withHooks({ afterWrite: 'node hook.mjs' });
  const dir = tempDir({
    'hook.mjs': `console.log('2 tests failed');
process.exit(1);\n`,
  });
  const overlay = new Overlay(dir);
  const tools = createTools({ root: dir, overlay });

  const out = await tools.write('notes.txt', 'hello\n');

  assert.ok(!/^err:/i.test(out), 'the write itself did not fail — the hook is not the tool');
  assert.match(out, /failed \(exit 1\)/, 'the failure is reported');
  assert.match(out, /2 tests failed/, 'with what the hook said');
  assert.ok(overlay.has(path.join(dir, 'notes.txt')), 'and the change is still staged');
});

test('a hook is not asked for permission — the person configured it', async () => {
  withHooks({ afterWrite: 'node hook.mjs' });
  const dir = tempDir({ 'hook.mjs': HOOK_SCRIPT });

  // The harness in `ask` mode: the write itself is a question, and the hook
  // that runs with it is not. The question is answered here, the way the
  // window answers it.
  const events = new Emitter();
  const asked = [];

  const bridge = new StubBridge(['CREATE notes.txt\nhello\nEND\n', 'DONE wrote it\n']);
  const harness = new Harness({
    root: dir, client: bridge, store: new SessionStore(tempDir()), events,
    options: { mode: 'ask', maxSteps: 4 },
  });
  // The permission engine asks on the bus and waits for an answer; the
  // answer is the one the person would give, and every question is counted
  // — a hook that asked one would be a second question the person never
  // configured.
  events.on('permission_request', (payload) => {
    asked.push(payload);
    harness.permissions.answer(payload.id, 'allow');
  });

  await harness.run('write a note');

  assert.equal(asked.length, 1, 'the write asked once — and the hook asked nothing');
  assert.ok(fs.existsSync(path.join(dir, 'hook-ran.txt')), 'the hook still ran');
  const second = bridge.sends[1] ?? '';
  assert.match(second, /HOOK SAID: the check passed/, 'and its verdict rode back to the model');
});

test('a hook that names a secret file is not run', async () => {
  withHooks({ afterWrite: 'node show.mjs .env' });
  const dir = tempDir({ 'show.mjs': "console.log('the secret');\n" });
  const tools = toolsIn(dir);

  const out = await tools.write('notes.txt', 'hello\n');

  assert.match(out, /was not run/, 'the hook is refused');
  assert.match(out, /\.env/, 'and it says which file it named');
  assert.doesNotMatch(out, /the secret/, 'the secret never ran');
});

test('a hook command is one command, split into an argv array', () => {
  assert.deepEqual(parseCommandLine('npm run lint'), ['npm', 'run', 'lint']);
  assert.deepEqual(parseCommandLine('"C:\\Program Files\\tool.exe" --check'), ['C:\\Program Files\\tool.exe', '--check']);
  // A chain is refused rather than half-run: there is no shell to interpret
  // it, and the settings hold a list for exactly this.
  const dir = tempDir();
  return runHooks('afterWrite', { root: dir, hooks: { afterWrite: 'echo one && echo two' } }).then((result) => {
    assert.equal(result.ok, false);
    assert.match(result.text, /more than one command/);
  });
});

test('a hook runs when the run ends', async () => {
  withHooks({ done: 'node done.mjs' });
  const dir = tempDir({ 'done.mjs': `import fs from 'node:fs';\nfs.writeFileSync('done-ran.txt', 'the run ended\\n');\n` });
  const events = new Emitter();
  const notes = [];
  events.on('note', (payload) => notes.push(payload?.text ?? ''));
  const bridge = new StubBridge(['DONE nothing to do\n']);
  const harness = new Harness({
    root: dir, client: bridge, store: new SessionStore(tempDir()), events,
    options: { mode: 'yolo', maxSteps: 4 },
  });

  await harness.run('do nothing');
  // The hook runs when the run has ended, so it is not part of the run's
  // answer — the person sees it as a note.
  await new Promise((resolve) => setTimeout(resolve, 400));

  assert.ok(fs.existsSync(path.join(dir, 'done-ran.txt')), 'the command ran when the run ended');
  assert.ok(notes.some((text) => /hook \(done\)/.test(text)), 'and the person is told what it said');
});

test('a hook before a commit refuses the commit when it fails', async () => {
  withHooks({ beforeCommit: 'node check.mjs' });
  const dir = tempDir({ 'check.mjs': `console.log('the check failed');\nprocess.exit(1);\n` });
  const tools = createTools({ root: dir, overlay: new Overlay(dir), allowGitWrite: true });

  const out = await tools.git('commit -m "the message"');

  assert.ok(/^err:/i.test(out), 'the commit is refused');
  assert.match(out, /beforeCommit/, 'and it names the hook that refused it');
  assert.match(out, /the check failed/, 'with what the hook said');
});
