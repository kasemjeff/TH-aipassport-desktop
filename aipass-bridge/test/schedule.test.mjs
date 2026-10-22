// Scheduled work: when a task is due, when it has run, and who may read the
// file it lives in.
//
// The contract is small and it is the whole point of the feature: a task
// runs once when its time comes, it does not run again that day, a disabled
// task never runs, and the file the schedule lives in is the owner's alone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ScheduleStore } from '../harness/schedule.mjs';
import { createCoreMethods } from '../harness/rpc/core.mjs';

const tmp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aipass-schedule-'));
  scratch.push(dir);
  return dir;
};

// The scratch trees this file makes go when the process does: a run that left
// one behind per test filled the temp directory with litter nobody sweeps.
const scratch = [];
process.on('exit', () => {
  for (const dir of scratch) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});


/** Noon on a fixed local day: the clock must not decide the test. */
const NOW = new Date(2026, 9, 21, 12, 0, 0).getTime();

/**
 * A spawn that starts nothing.
 *
 * The scheduled work is the CLI, and the CLI would start a bridge — so the
 * test hands in its own spawn and watches what it was asked to do.
 */
function fakeSpawner() {
  const calls = [];
  const spawnFn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return { pid: 1000 + calls.length, unref() {} };
  };
  return { calls, spawnFn };
}

test('a due schedule entry is due once and then spent', async () => {
  const dir = tmp();
  const store = new ScheduleStore(path.join(dir, 'schedule.json'));
  const root = path.join(dir, 'proj');
  fs.mkdirSync(root, { recursive: true });

  await store.add({ task: 'summarise the week', root, at: '09:00' });
  await store.add({ task: 'write the report', root, at: '09:00', kind: 'once' });
  await store.add({ task: 'later today', root, at: '23:00' });

  const due = await store.due(NOW);
  assert.equal(due.length, 2, 'the two whose time has come are due');
  assert.ok(due.every((e) => e.at === '09:00'), 'the one whose time has not come is not');

  const { calls, spawnFn } = fakeSpawner();
  const ran = await store.runDue({ now: NOW, spawnFn, cli: path.join(dir, 'aipass.mjs') });

  assert.equal(ran.count, 2, 'both ran');
  assert.equal(calls.length, 2, 'and both started a job');
  for (const call of calls) {
    // The CLI is the front the house uses: `aipass agent "<task>" --root <root>`.
    assert.equal(call.args[0], path.join(dir, 'aipass.mjs'), 'the job runs the CLI');
    assert.equal(call.args[1], 'agent', 'the CLI\'s agent command');
    assert.equal(call.args[3], '--root', 'and the project is named');
    assert.equal(call.args[4], root, 'the project the entry names');
    assert.equal(call.opts.detached, true, 'the job is detached: it outlives the caller');
    assert.equal(call.opts.windowsHide, true, 'and it shows no console window');
    assert.equal(call.opts.stdio, 'ignore', 'and it holds no pipe open');
  }
  assert.deepEqual(calls.map((c) => c.args[2]).sort(), ['summarise the week', 'write the report'], 'each job carries its own task');

  // Due once: the day it ran, it does not run again.
  assert.equal((await store.due(NOW)).length, 0, 'nothing is due after the run');

  const entries = await store.list();
  const daily = entries.find((e) => e.task === 'summarise the week');
  const once = entries.find((e) => e.task === 'write the report');
  assert.equal(daily.lastRunAt, NOW, 'the daily entry remembers when it ran');
  assert.equal(daily.enabled, true, 'and it is still on for tomorrow');
  assert.equal(once.lastRunAt, NOW, 'the once entry remembers when it ran');
  assert.equal(once.enabled, false, 'and it is spent');

  // Tomorrow the daily entry is due again; the once entry never is.
  const tomorrow = new Date(2026, 9, 22, 12, 0, 0).getTime();
  const dueTomorrow = await store.due(tomorrow);
  assert.deepEqual(dueTomorrow.map((e) => e.task), ['summarise the week'], 'the daily entry is due again, the spent one is not');

  // The jobs that started are named in the pid file, the way the bridge's are.
  const pids = await store.readPids();
  assert.deepEqual(pids, [1001, 1002], 'the running jobs are named');
  await store.recordPids([]);
  assert.deepEqual(await store.readPids(), [], 'and a job that ended leaves nothing behind');
});

test('a disabled schedule entry never runs', async () => {
  const dir = tmp();
  const store = new ScheduleStore(path.join(dir, 'schedule.json'));
  const root = path.join(dir, 'proj');
  fs.mkdirSync(root, { recursive: true });

  await store.add({ task: 'off today', root, at: '09:00', enabled: false });
  await store.add({ task: 'not yet', root, at: '23:00' });

  assert.equal((await store.due(NOW)).length, 0, 'neither is due');

  const { calls, spawnFn } = fakeSpawner();
  const ran = await store.runDue({ now: NOW, spawnFn, cli: path.join(dir, 'aipass.mjs') });

  assert.equal(ran.count, 0, 'nothing ran');
  assert.equal(calls.length, 0, 'and no job was started');
  const entries = await store.list();
  assert.equal(entries.find((e) => e.task === 'off today').lastRunAt, null, 'the disabled entry has never run');
});

test('the schedule store keeps its file owner-only', async () => {
  const dir = tmp();
  const file = path.join(dir, 'schedule.json');
  const store = new ScheduleStore(file);

  // The write asks for 0600: on a machine with POSIX modes that is the mode
  // the file gets, and on Windows it is the mode the store asked for.
  const asked = [];
  const real = fs.chmodSync;
  fs.chmodSync = (target, mode) => { asked.push([String(target), mode]); return real(target, mode); };
  try {
    await store.add({ task: 'write the report', root: dir, at: '09:00' });
  } finally {
    fs.chmodSync = real;
  }

  assert.ok(fs.existsSync(file), 'the schedule is on the disk');
  if (process.platform === 'win32') {
    assert.ok(
      asked.some(([target, mode]) => mode === 0o600 && target.startsWith(file)),
      'the store pins the file owner-only',
    );
    return;
  }
  assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'the file is the owner\'s alone');
});

test('the schedule methods of the backend list, add, remove and run', async () => {
  const home = tmp();
  const saved = process.env.AIPASS_HOME;
  process.env.AIPASS_HOME = home;
  try {
    const methods = createCoreMethods({
      appSettings: { projectList: () => [] },
      plugins: {},
      harnesses: new Map(),
      runSessions: new Map(),
      staged: new Map(),
      targetFor: () => ({}),
      decoratedPlugins: () => [],
      current: { root: home },
      root: home,
      model: null,
    });

    const added = await methods['schedule.add']({ task: 'summarise the week', at: '09:00', project: home });
    assert.ok(added.id, 'the entry has an id');
    assert.equal(added.root, home, 'and the project the caller is on');

    const listed = await methods['schedule.list']();
    assert.equal(listed.entries.length, 1, 'the schedule holds it');

    // Nothing is due: the entry is disabled, so `runDue` finds nothing and
    // starts nothing.
    const off = await methods['schedule.add']({ task: 'not today', at: '09:00', project: home, kind: 'daily' });
    const store = new ScheduleStore(path.join(home, 'schedule.json'));
    const entries = await store.list();
    entries.forEach((e) => { e.enabled = false; });
    await store.write(entries);

    const ran = await methods['schedule.runDue']({ now: NOW });
    assert.equal(ran.count, 0, 'nothing was due');
    assert.deepEqual(ran.ran, [], 'and nothing ran');

    const gone = await methods['schedule.remove']({ id: added.id });
    assert.equal(gone.ok, true, 'the entry is removed');
    assert.equal((await methods['schedule.list']()).entries.length, 1, 'the other one stays');

    const missing = await methods['schedule.remove']({ id: 'nope' });
    assert.equal(missing.ok, false, 'removing an entry that is not there says so');

    await assert.rejects(() => methods['schedule.remove']({}), /no schedule entry/);
    await assert.rejects(() => methods['schedule.add']({ task: '', at: '09:00', project: home }), /needs something to do/);
    await assert.rejects(() => methods['schedule.add']({ task: 'x', at: '25:00', project: home }), /not a time of day/);
    assert.ok(off.id, 'the second entry was added');
  } finally {
    if (saved === undefined) delete process.env.AIPASS_HOME;
    else process.env.AIPASS_HOME = saved;
  }
});
