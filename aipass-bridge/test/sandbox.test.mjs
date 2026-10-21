/**
 * The sandbox: the projection a RUN works in, and the boundary around it.
 *
 * Four things are pinned here, each one a measured hole:
 *   - a command's OUTPUT is screened for secrets (the command is screened for
 *     secret FILES; the output is the machine's mouth, and `set` prints the
 *     whole environment);
 *   - the containment is LEXICAL (case, on Windows) and PHYSICAL (a link out
 *     of the project is a link out of the root);
 *   - the projection lives OUTSIDE the project, so a copy of the user's
 *     source — and of whatever secrets it holds — cannot be committed;
 *   - the janitor collects the projections a killed backend left behind.
 *
 * Run: node --test aipass-bridge/test/sandbox.test.mjs
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Overlay } from '../harness/overlay.mjs';
import { createTools } from '../harness/tools.mjs';
import { createSandbox, materializeTree, sweepSandboxes, sandboxRoot } from '../harness/sandbox.mjs';
import { scrubOutput, isSecretName } from '../harness/output-scrub.mjs';
import { aipassHome } from '../harness/settings.mjs';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aipass-sandbox-home-'));
process.env.AIPASS_HOME = HOME;
after(() => fs.rmSync(HOME, { recursive: true, force: true }));

const tempDir = (files = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aipass-sbx-'));
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  return dir;
};

/* ------------------------------------------------------- the output screen */

test('a command output is screened for secrets', async () => {
  const dir = tempDir();
  const printer = path.join(dir, 'print.mjs');
  fs.writeFileSync(printer, "console.log('sk-abcdefgh12345678');\nconsole.log('API_KEY=supersecret');\nconsole.log('PORT=3000');\n");
  const tools = createTools({ root: dir, overlay: new Overlay(dir), allowRun: true });

  const out = String(await tools.run('', `node "${printer}"`));
  assert.equal(/sk-abcdefgh12345678/.test(out), false, 'the token shape is redacted');
  assert.equal(/supersecret/.test(out), false, 'the credential assignment is redacted');
  assert.match(out, /PORT=3000/, 'an ordinary assignment is left alone');
  assert.match(out, /\[redacted\]/, 'and the redaction says so');
});

test('the screen knows which names carry a credential', () => {
  assert.equal(isSecretName('API_KEY'), true);
  assert.equal(isSecretName('GITHUB_TOKEN'), true);
  assert.equal(isSecretName('_authToken'), true);
  assert.equal(isSecretName('AWS_SECRET_ACCESS_KEY'), true);
  assert.equal(isSecretName('DB_PASSWORD'), true);
  assert.equal(isSecretName('PORT'), false);
  assert.equal(isSecretName('MONKEY'), false, 'a name that merely contains a word is not one');
  assert.equal(isSecretName('PATH'), false);
});

test('the screen keeps what a query string carries', () => {
  const out = scrubOutput('GET https://example.com/x?api_key=abc123&page=2');
  assert.equal(/abc123/.test(out), false, 'the credential is gone');
  assert.match(out, /page=2/, 'and the rest of the URL is intact');
});

/* -------------------------------------------------------- the containment */

test('a path that differs only in case is inside the project', () => {
  const dir = tempDir({ 'a.txt': 'hello\n' });
  const overlay = new Overlay(dir);
  const abs = path.join(dir, 'a.txt');
  assert.doesNotThrow(() => overlay.safe(abs.toUpperCase()), 'Windows does not care about case');
  assert.doesNotThrow(() => overlay.safe(abs.toLowerCase()));
  assert.throws(() => overlay.safe(path.join(dir, '..', 'outside.txt')), /outside project root/);
});

test('a link out of the project is a link out of the root', async (t) => {
  const dir = tempDir({ 'inside.txt': 'mine\n' });
  const outside = tempDir({ 'secret.txt': 'not yours\n' });
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'link'), { recursive: true });
  try {
    fs.symlinkSync(outside, path.join(dir, 'link', 'away'), 'junction');
  } catch (err) {
    return t.skip(`links cannot be made here: ${err.code}`);
  }
  const tools = createTools({ root: dir, overlay: new Overlay(dir) });
  await assert.rejects(
    async () => tools.read('link/away/secret.txt'),
    /outside project root/,
    'a path that leaves the project through a link is refused',
  );
  assert.match(String(await tools.read('inside.txt')), /mine/, 'and the project is still readable');
});

/* ------------------------------------------------------------ the sandbox */

test('the projection lives outside the project', async () => {
  const dir = tempDir({ 'a.txt': 'hello\n' });
  const sandbox = createSandbox(dir);
  try {
    assert.equal(sandbox.startsWith(path.resolve(dir) + path.sep), false, 'not inside the project');
    assert.equal(sandbox.startsWith(path.join(aipassHome(), 'run')), true, 'but under the home');
    assert.ok(fs.existsSync(sandbox), 'and it exists');
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test('two projects never share a projection folder', () => {
  const a = sandboxRoot('D:/one/project');
  const b = sandboxRoot('D:/one/project-two');
  assert.notEqual(a, b, 'the folder name carries the path, not only the slug');
});

test('the janitor collects what a killed backend left behind', async () => {
  const dir = tempDir();
  const root = sandboxRoot(dir);
  fs.mkdirSync(root, { recursive: true });
  const stale = path.join(root, 'run-stale');
  const fresh = path.join(root, 'run-fresh');
  fs.mkdirSync(stale, { recursive: true });
  fs.mkdirSync(fresh, { recursive: true });
  fs.writeFileSync(path.join(stale, 'copy.txt'), 'x');
  // The stale one is older than a live run could ever be.
  const old = new Date(Date.now() - 12 * 60 * 60 * 1000);
  fs.utimesSync(stale, old, old);

  const removed = await sweepSandboxes(dir, { maxAgeMs: 6 * 60 * 60 * 1000 });
  assert.equal(removed, 1, 'the abandoned projection is gone');
  assert.equal(fs.existsSync(stale), false);
  assert.equal(fs.existsSync(fresh), true, 'and a live one is left alone');
  fs.rmSync(fresh, { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
});

test('a projection whose owner is gone is collected long before the age margin', async () => {
  // The crash case: the backend died mid-RUN and the copy of the project is
  // still on disk. Waiting six hours for it is six hours of disk for a
  // projection nobody can ever finish — so a dead owner waits out minutes.
  const dir = tempDir();
  const root = sandboxRoot(dir);
  fs.mkdirSync(root, { recursive: true });
  const dead = path.join(root, 'run-dead');
  fs.mkdirSync(dead, { recursive: true });
  fs.writeFileSync(path.join(dead, 'copy.txt'), 'x');
  // A pid that cannot be running: the stamp names a process that is gone.
  fs.writeFileSync(`${dead}.owner`, JSON.stringify({ pid: 0x7ffffffe, at: Date.now() }));
  const old = new Date(Date.now() - 30 * 60 * 1000);
  fs.utimesSync(dead, old, old);

  const removed = await sweepSandboxes(dir, { maxAgeMs: 6 * 60 * 60 * 1000, deadGraceMs: 10 * 60 * 1000 });
  assert.equal(removed, 1, 'the dead owner\'s projection is gone');
  assert.equal(fs.existsSync(dead), false);
  assert.equal(fs.existsSync(`${dead}.owner`), false, 'and so is its stamp');
  fs.rmSync(root, { recursive: true, force: true });
});

test('a projection a live run owns is left alone, however old it looks', async () => {
  const dir = tempDir();
  const root = sandboxRoot(dir);
  fs.mkdirSync(root, { recursive: true });
  const live = path.join(root, 'run-live');
  fs.mkdirSync(live, { recursive: true });
  // This process is the owner, and it is running.
  fs.writeFileSync(`${live}.owner`, JSON.stringify({ pid: process.pid, at: Date.now() }));
  // Older than the dead owner's grace, younger than the age margin: this is
  // the case the dead-owner path must not touch.
  const old = new Date(Date.now() - 30 * 60 * 1000);
  fs.utimesSync(live, old, old);

  const removed = await sweepSandboxes(dir, { maxAgeMs: 6 * 60 * 60 * 1000, deadGraceMs: 10 * 60 * 1000 });
  assert.equal(removed, 0, 'a live owner keeps its projection');
  assert.equal(fs.existsSync(live), true);
  fs.rmSync(live, { recursive: true, force: true });
  fs.rmSync(`${live}.owner`, { force: true });
  fs.rmSync(root, { recursive: true, force: true });
});

test('the projection leaves out a link that points outside the project', async (t) => {
  const dir = tempDir({ 'a.txt': 'hello\n' });
  const outside = tempDir({ 'secret.txt': 'not yours\n' });
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
  try {
    // A directory link, not a file one: on Windows a file symlink needs
    // privileges a normal machine does not have, a junction does not.
    fs.symlinkSync(outside, path.join(dir, 'sub', 'away'), 'junction');
  } catch (err) {
    return t.skip(`links cannot be made here: ${err.code}`);
  }
  const overlay = new Overlay(dir);
  const sandbox = createSandbox(dir);
  try {
    await materializeTree(dir, overlay, sandbox);
    assert.equal(fs.existsSync(path.join(sandbox, 'sub', 'away', 'secret.txt')), false,
      'the outside file is not projected');
    assert.equal(fs.existsSync(path.join(sandbox, 'a.txt')), true, 'and the project is');
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test('a RUN says which folders are shared with the real project', async () => {
  const dir = tempDir({ 'a.txt': 'hello\n' });
  fs.mkdirSync(path.join(dir, 'node_modules', 'pkg'), { recursive: true });
  const overlay = new Overlay(dir);
  overlay.set(path.join(dir, 'a.txt'), 'changed\n');
  const tools = createTools({ root: dir, overlay, allowRun: true });

  const out = String(await tools.run('', 'node -e "console.log(1)"'));
  assert.match(out, /node_modules/, 'the shared folder is named');
  assert.match(out, /REAL folders/i, 'and the truth about it is said');
});

test('a file over the cap is left out of the projection, and named', async () => {
  const dir = tempDir({ 'a.txt': 'hello\n' });
  fs.writeFileSync(path.join(dir, 'huge.bin'), Buffer.alloc(3 * 1024 * 1024));
  const previous = process.env.AIPASS_SANDBOX_MAX_FILE_MB;
  process.env.AIPASS_SANDBOX_MAX_FILE_MB = '1';
  try {
    const overlay = new Overlay(dir);
    overlay.set(path.join(dir, 'a.txt'), 'changed\n');
    const tools = createTools({ root: dir, overlay, allowRun: true });
    const out = String(await tools.run('', 'node -e "console.log(1)"'));
    assert.match(out, /huge\.bin/, 'the file that was left out is named');
    assert.match(out, /not copied/i, 'and it says why');
  } finally {
    if (previous === undefined) delete process.env.AIPASS_SANDBOX_MAX_FILE_MB;
    else process.env.AIPASS_SANDBOX_MAX_FILE_MB = previous;
  }
});
