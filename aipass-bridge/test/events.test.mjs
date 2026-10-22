// The event surface: the observer the harness talks through, and the fan-out
// that keeps a window's backlog bounded.
//
// Two things are pinned here:
//   - the observer keeps its shape (a listener that throws never breaks a
//     run, and the wildcard listener sees every event);
//   - a window that stops reading does not make the backend's memory grow.
//     The frames wait in a bounded queue, the oldest go when it overflows,
//     the losses are counted, and the window is told it fell behind.
//
// Run: node --test aipass-bridge/test/events.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Emitter, EventFanout } from '../harness/events.mjs';

test('a listener that throws never breaks the run', () => {
  const bus = new Emitter();
  const seen = [];
  bus.on('note', () => { throw new Error('a listener that cannot cope'); });
  bus.on('note', (payload) => seen.push(payload.text));
  bus.on('*', (type, payload) => seen.push(`${type}:${payload.text}`));

  bus.emit('note', { text: 'hello' });
  assert.deepEqual(seen, ['hello', 'note:hello'], 'the other listeners still heard it');
  assert.equal(bus.hasListeners('note'), true);
  assert.equal(bus.isObserved('other'), true, 'the wildcard listener sees every event');
  assert.equal(new Emitter().isObserved('note'), false, 'a gate with no listener must not block');
});

test('a subscriber that stops reading does not grow the backend without bound', () => {
  // The window that stopped reading: a backgrounded tab, a sleeping laptop.
  // Its socket takes the frames and stops keeping up, and everything after
  // that would queue in THIS process — the transcript the window never read.
  const fanout = new EventFanout({ frames: 8, bytes: 4096 });
  let stopped = false;
  const sub = fanout.subscribe((frame) => {
    if (stopped) return false;   // taken, but the sink is not keeping up
    return true;
  });

  stopped = true;
  for (let i = 0; i < 5000; i++) fanout.publish(`event: delta\ndata: {"n":${i}}\n\n`);

  const stats = fanout.stats();
  assert.ok(stats.queued <= 8, `the queue is bounded — it holds ${stats.queued} frames, not 5000`);
  assert.ok(stats.bytes <= 4096, `and it is bounded in bytes too (${stats.bytes})`);
  assert.ok(stats.dropped > 0, 'the frames that did not fit were dropped');
  // Every published frame is accounted for: the sink took the one that made
  // it stop keeping up, the rest are queued or counted as lost.
  assert.equal(stats.dropped + stats.queued, 4999, 'no frame is quietly forgotten');
  assert.equal(stats.owed, 1, 'and the window owes one notice');
});

test('a window that keeps up loses nothing, and the order is the order', () => {
  const fanout = new EventFanout({ frames: 4, bytes: 4096 });
  const taken = [];
  const sub = fanout.subscribe((frame) => { taken.push(frame); return true; });

  for (let i = 0; i < 50; i++) fanout.publish(`event: delta\ndata: {"n":${i}}\n\n`);
  assert.equal(taken.length, 50, 'every frame arrived');
  assert.equal(taken[0], 'event: delta\ndata: {"n":0}\n\n', 'and the first one is still the first');
  assert.equal(taken.at(-1), 'event: delta\ndata: {"n":49}\n\n', 'and the last one is the last');
  assert.equal(fanout.stats().dropped, 0, 'nothing was dropped');
});

test('the window is told it fell behind, and how much it lost', () => {
  const fanout = new EventFanout({ frames: 4, bytes: 4096 });
  const taken = [];
  let stopped = false;
  const sub = fanout.subscribe((frame) => {
    taken.push(frame);
    return !stopped;
  });

  stopped = true;
  for (let i = 0; i < 200; i++) fanout.publish(`event: delta\ndata: {"n":${i}}\n\n`);
  const dropped = fanout.stats().dropped;
  assert.ok(dropped > 0, 'frames were lost on the way');

  // The window starts reading again: the notice comes first, then the frames
  // that survived — the NEWEST ones, because the oldest are what went.
  stopped = false;
  sub.flush();

  const notice = taken.find((f) => f.startsWith('event: fell_behind'));
  assert.ok(notice, 'the window is told it fell behind');
  const payload = JSON.parse(notice.split('data: ')[1]);
  assert.equal(payload.dropped, dropped, 'and the notice carries the number of frames that were lost');
  assert.ok(!notice.includes('id:'), 'the notice is not part of the replay stream — Last-Event-ID still points at the last real frame');

  const deltas = taken.filter((f) => f.startsWith('event: delta'));
  // The frame that made the sink stop keeping up was still taken, and the
  // queue that fitted held four more — the rest were dropped.
  assert.ok(deltas.length <= 5, `only the frames that fit are delivered (${deltas.length})`);
  assert.match(deltas.at(-1), /"n":199\}/, 'and the newest one is among them');
  assert.equal(fanout.stats().queued, 0, 'and the queue is empty again');
});

test('a frame the sink took while it was behind is not written twice', () => {
  // The sink takes the frame and says it is behind: the frame is not owed
  // again. The queue that follows is written on the next flush — and the
  // frame that made the sink stop keeping up must not be in it a second
  // time. It was: the window saw the same frame twice.
  const fanout = new EventFanout({ frames: 8, bytes: 4096 });
  const taken = [];
  let behind = false;
  const sub = fanout.subscribe((frame) => { taken.push(frame); return !behind; });

  fanout.publish('event: delta\ndata: {"n":0}\n\n');
  behind = true;
  fanout.publish('event: delta\ndata: {"n":1}\n\n');   // taken, and the sink is behind
  fanout.publish('event: delta\ndata: {"n":2}\n\n');   // queued
  behind = false;
  sub.flush();

  const deltas = taken.filter((f) => f.startsWith('event: delta'));
  assert.deepEqual(deltas.map((d) => d.match(/"n":(\d+)/)?.[1]), ['0', '1', '2'], 'every frame arrived exactly once');
  assert.equal(fanout.stats().queued, 0, 'and the queue is empty again');
});

test('a window that closed is dropped, not written to', () => {
  const fanout = new EventFanout();
  const sub = fanout.subscribe(() => { throw new Error('socket closed'); });
  fanout.publish('event: delta\ndata: {}\n\n');
  assert.equal(fanout.stats().subscribers, 0, 'the dead subscriber is gone');
  assert.equal(sub.dead, true);
});
