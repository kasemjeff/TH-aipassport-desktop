// Wave 3.7 — the schedule ticks itself.
//
// The schedule page shipped but the backend "ticks nothing by itself — the
// window asks it to run what is due". A person who closes the window had a
// scheduler that never ran. The backend now runs due entries on start and on
// an interval, and one lock in the schedule store keeps the ticker and a
// manual `schedule.runDue` — or two backends — from running one entry twice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ScheduleStore, startScheduleTicker, SCHEDULE_LOCK_FILE } from '../harness/schedule.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aipass-tick-'));
// Local noon, so an entry at 09:00 is due whatever the machine's zone is.
const NOW = new Date(2026, 9, 28, 12, 0, 0).getTime();

/** A spawn that only records its argv: no child is started by a test. */
const fakeSpawn = (calls) => (...args) => {
  calls.push(args);
  return { pid: 4242, unref() { /* nothing to release */ } };
};

test('a due task runs once with the window closed, and two backends do not both run it', async () => {
  const dir = tmp();
  const store = new ScheduleStore(path.join(dir, 'schedule.json'));
  await store.add({ task: 'summarise the week', root: dir, at: '09:00' });
  const calls = [];
  const spawnFn = fakeSpawn(calls);

  // Two readers arrive together: the window's manual call and the ticker, or
  // two backends. One read/spawn/write wins the lock; the other says so.
  const [a, b] = await Promise.all([
    store.runDue({ now: NOW, spawnFn, cli: 'aipass.mjs' }),
    store.runDue({ now: NOW, spawnFn, cli: 'aipass.mjs' }),
  ]);

  assert.equal(calls.length, 1, 'one entry started one child');
  assert.equal(a.count + b.count, 1);
  assert.equal([a, b].some((r) => r.locked), true, 'the loser was told the lock was held');
  assert.equal(fs.existsSync(path.join(dir, SCHEDULE_LOCK_FILE)), false, 'the lock was released');

  const entries = await store.list();
  assert.ok(entries[0].lastRunAt, 'the entry is marked as run');
  const again = await store.runDue({ now: NOW, spawnFn, cli: 'aipass.mjs' });
  assert.equal(again.count, 0, 'a second call the same day is not due');
  assert.equal(calls.length, 1);
});

test('a lock left by a dead backend does not block the next one', async () => {
  const dir = tmp();
  const store = new ScheduleStore(path.join(dir, 'schedule.json'));
  await store.add({ task: 't', root: dir, at: '09:00' });
  // A pid no process can hold, and a stamp older than the stale window.
  fs.writeFileSync(path.join(dir, SCHEDULE_LOCK_FILE), JSON.stringify({ pid: 2147483646, at: Date.now() - 10 * 60_000 }));

  const calls = [];
  const out = await store.runDue({ now: NOW, spawnFn: fakeSpawn(calls), cli: 'aipass.mjs' });
  assert.equal(out.count, 1, 'the stale lock was taken over');
  assert.equal(calls.length, 1);
  assert.equal(fs.existsSync(path.join(dir, SCHEDULE_LOCK_FILE)), false);
});

test('the ticker runs a due entry on its own, and stop ends it', async () => {
  const dir = tmp();
  const store = new ScheduleStore(path.join(dir, 'schedule.json'));
  await store.add({ task: 'nightly build', root: dir, at: '09:00' });
  const calls = [];
  const ticker = startScheduleTicker({
    store,
    intervalMs: 25,
    runDue: { now: NOW, spawnFn: fakeSpawn(calls), cli: 'aipass.mjs' },
  });

  await sleep(80);
  ticker.stop();
  assert.equal(calls.length, 1, 'the start tick ran the due entry once; later ticks found it spent');

  await sleep(60);
  assert.equal(calls.length, 1, 'no tick after stop');
  assert.equal(fs.existsSync(path.join(dir, SCHEDULE_LOCK_FILE)), false);
});
