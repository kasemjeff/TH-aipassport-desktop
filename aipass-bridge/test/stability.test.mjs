// Stability pins: the parts that keep a long-running install from rotting.
//
// Four failure modes with one test each:
//   - logs that grow with no cap            (harness/log-file.mjs)
//   - session files lost to a crash mid-write (harness/session.mjs, atomic swap)
//   - spill files piling up per project      (harness/tools.mjs, pruneSpill)
//   - a command's process tree outliving its timeout (harness/tools.mjs, runShell)
//
// Plus the entry-point guard: importing the bridge or the backend in-process
// must NOT install process-level crash handlers, because a handler that calls
// process.exit would take the test runner down with it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openLogFile, LOG_MAX_BYTES } from '../harness/log-file.mjs';
import { SessionStore, HEADER_EVERY } from '../harness/session.mjs';
import { pruneSpill, runShell } from '../harness/tools.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aipass-stability-'));

test('a log past the cap rotates to .1 and starts clean', () => {
  const dir = tmp();
  try {
    const file = path.join(dir, 'bridge.log');
    const big = 'x'.repeat(300);
    fs.writeFileSync(file, big);

    fs.closeSync(openLogFile(file, { maxBytes: 100 }));
    assert.equal(fs.readFileSync(`${file}.1`, 'utf8'), big, 'the old file becomes the .1');
    assert.equal(fs.readFileSync(file, 'utf8'), '', 'the new log starts empty');

    // Under the cap again: no second rotation, appended content survives.
    fs.appendFileSync(file, 'small');
    fs.closeSync(openLogFile(file, { maxBytes: 100 }));
    assert.equal(fs.readFileSync(file, 'utf8'), 'small');
    assert.equal(fs.readFileSync(`${file}.1`, 'utf8'), big, 'the .1 is untouched');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a stale .1 is replaced, not merged with the new rotation', () => {
  const dir = tmp();
  try {
    const file = path.join(dir, 'desktop-backend.log');
    fs.writeFileSync(`${file}.1`, 'a much older generation');
    fs.writeFileSync(file, 'y'.repeat(200));

    fs.closeSync(openLogFile(file, { maxBytes: 100 }));
    assert.equal(fs.readFileSync(`${file}.1`, 'utf8'), 'y'.repeat(200));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the default cap is a real number and the file is created when missing', () => {
  const dir = tmp();
  try {
    assert.ok(LOG_MAX_BYTES > 0);
    const file = path.join(dir, 'nested', 'fresh.log');
    const fd = openLogFile(file);
    fs.writeSync(fd, 'hello');
    fs.closeSync(fd);
    assert.equal(fs.readFileSync(file, 'utf8'), 'hello', 'the directory is made and the file appended');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a session rewrite swaps atomically and leaves no temp behind', () => {
  const dir = tmp();
  try {
    const store = new SessionStore(dir);
    const session = store.create({ root: dir, title: 'atomic' });
    for (let i = 0; i < HEADER_EVERY + 5; i++) session.append('user', { text: `m${i}` });

    const files = fs.readdirSync(path.dirname(session.file));
    assert.ok(!files.some((f) => f.endsWith('.tmp')), 'no half-written temp survives the rewrite');

    const again = store.load(session.id);
    assert.equal(again.entries.length, HEADER_EVERY + 5, 'every entry is still readable');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a torn last line is skipped rather than losing the session', () => {
  const dir = tmp();
  try {
    const store = new SessionStore(dir);
    const session = store.create({ root: dir, title: 'torn' });
    session.append('user', { text: 'first' });
    session.append('assistant', { text: 'second' });
    // Exactly what a crash mid-append leaves: half a JSON line.
    fs.appendFileSync(session.file, '{"type":"assistant","id":"brok');

    const again = store.load(session.id);
    assert.equal(again.entries.length, 2, 'the two whole entries survive');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a stray .tmp never shadows the session it came from', () => {
  const dir = tmp();
  try {
    const store = new SessionStore(dir);
    const session = store.create({ root: dir, title: 'shadow' });
    session.append('user', { text: 'the real one' });
    fs.writeFileSync(`${session.file}.tmp`, JSON.stringify({ type: 'header', id: 'junk' }) + '\n');

    const loaded = store.load(session.id);
    assert.equal(loaded.file, session.file, 'the .jsonl wins');
    assert.equal(loaded.title, 'shadow');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('SessionStore.default resolves under the home directory', () => {
  // This used to throw: the module called os.homedir() without importing
  // node:os, so only the explicit-base path ever worked.
  const store = SessionStore.default();
  assert.ok(path.resolve(store.dir).endsWith(path.join('.aipass', 'sessions')));
});

test('spill files are pruned to the newest N, foreign files untouched', () => {
  const dir = tmp();
  try {
    for (let i = 0; i < 8; i++) {
      const p = path.join(dir, `s${i}.txt`);
      fs.writeFileSync(p, `spill ${i}`);
      const t = 1_700_000_000 + i; // distinct, increasing mtimes
      fs.utimesSync(p, t, t);
    }
    fs.writeFileSync(path.join(dir, 'keep.md'), 'not a spill');

    pruneSpill(dir, 5);
    const left = fs.readdirSync(dir).sort();
    assert.equal(left.length, 6, 'five spills plus the foreign file');
    assert.ok(left.includes('keep.md'), 'non-spill files are never swept');
    for (const gone of ['s0.txt', 's1.txt', 's2.txt']) assert.ok(!left.includes(gone), `${gone} was the oldest`);
    for (const kept of ['s7.txt', 's6.txt', 's5.txt']) assert.ok(left.includes(kept), `${kept} is the newest`);

    pruneSpill(dir, 0);
    assert.deepEqual(fs.readdirSync(dir), ['keep.md'], 'a cap of zero clears every spill');

    pruneSpill(path.join(dir, 'missing'), 5); // must not throw on a missing directory
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a command past its timeout takes its whole process tree down', async () => {
  // `exec`'s timeout killed the shell alone; the command's own children — a
  // server it started, a watcher — survived and kept holding the files they
  // had open (a later RUN met EBUSY from a process nobody could see). The
  // tree is killed now, so the grandchild never gets to write its marker.
  //
  // The margin is the point, and it has to be generous: the pin is "the tree
  // is killed when the timeout fires", not "the machine kills a tree within
  // 600 ms". The grandchild writes well after the timeout, so a slow kill
  // under load (this suite runs in parallel with other sessions') cannot let
  // the marker land — the old numbers left 600 ms for that, and one run in
  // fifteen failed on a busy machine.
  const dir = tmp();
  try {
    const marker = path.join(dir, 'alive.txt');
    const script = path.join(dir, 'wrapper.cjs');
    const write = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'alive'), 4000)`;
    fs.writeFileSync(script, [
      "const { spawn } = require('node:child_process');",
      `spawn(process.execPath, ['-e', ${JSON.stringify(write)}], { stdio: 'ignore' });`,
      'setTimeout(() => {}, 8000); // the parent outlives the timeout, so the tree must be killed',
    ].join('\n'));

    const err = await runShell(`"${process.execPath}" "${script}"`, { cwd: dir, timeoutMs: 600 })
      .then(() => null, (e) => e);
    assert.ok(err, 'the timeout rejects with the captured output');
    assert.equal(err.signal, 'SIGTERM', 'and it says the command was killed');
    await new Promise((r) => setTimeout(r, 5200));
    assert.equal(fs.existsSync(marker), false, 'nothing in the tree survived to write');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('importing the bridge in-process installs no crash handlers', async () => {
  // The handlers exist for the supervised entry point only; the suite imports
  // the module directly, and a process.exit on a stray rejection would kill
  // the runner mid-file.
  process.env.AIPASS_PORT = '0';
  process.env.AIPASS_REQUIRE_AUTH = '0';
  const before = {
    uncaught: process.listenerCount('uncaughtException'),
    rejection: process.listenerCount('unhandledRejection'),
  };
  const bridge = await import('../bridge/server.mjs');
  assert.equal(process.listenerCount('uncaughtException'), before.uncaught);
  assert.equal(process.listenerCount('unhandledRejection'), before.rejection);
  bridge.server.close();
  bridge.server.closeAllConnections?.();
});

test('importing the backend in-process installs no crash handlers', async () => {
  const before = {
    uncaught: process.listenerCount('uncaughtException'),
    rejection: process.listenerCount('unhandledRejection'),
  };
  await import('../harness/rpc.mjs');
  assert.equal(process.listenerCount('uncaughtException'), before.uncaught);
  assert.equal(process.listenerCount('unhandledRejection'), before.rejection);
});
