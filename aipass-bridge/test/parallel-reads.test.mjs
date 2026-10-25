// Consecutive read-only calls in one reply run beside each other.
//
// The loop has always walked a reply in marker order and awaited each tool.
// Reads cannot see different states, so their wall time is the only thing
// serialization bought — and a reply of five NEED lines paid it five times.
// The group is deliberately local reads only: results and events are still
// processed in marker order, and a write always ends the group, so nothing
// after a mutation can be read against the state before it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tempDir } from './harness.mjs';
import { Overlay } from '../harness/overlay.mjs';
import { SessionStore } from '../harness/session.mjs';
import { runTask } from '../harness/loop.mjs';

/** A bridge that answers a fixed list of turns and records what was sent. */
function scripted(replies) {
  const sent = [];
  return {
    sent,
    async chat({ message }) {
      sent.push(message);
      return { text: replies[Math.min(sent.length - 1, replies.length - 1)], reasoning: '' };
    },
    async quota() { return { available: 1 }; },
  };
}

function setup(tools) {
  const dir = tempDir({ 'a.txt': 'one\n', 'b.txt': 'two\n', 'c.txt': 'three\n' });
  const store = new SessionStore(path.join(dir, 'sessions'));
  const session = store.create({ root: dir });
  const overlay = new Overlay(dir);
  return { dir, session, overlay, tools };
}

/** A read that records how many reads were in flight at once. */
function instrumentedReads() {
  const state = { active: 0, peak: 0 };
  return {
    state,
    tools: {
      async list() { return 'a.txt\nb.txt\nc.txt'; },
      async read(arg) {
        state.active += 1;
        state.peak = Math.max(state.peak, state.active);
        await new Promise((resolve) => setTimeout(resolve, 25));
        state.active -= 1;
        return `content:${arg}`;
      },
    },
  };
}

test('consecutive reads overlap, and their results keep marker order', async () => {
  const { state, tools } = instrumentedReads();
  const ctx = setup(tools);
  const bridge = scripted([
    'NEED file a.txt\nNEED file b.txt\nNEED file c.txt',
    'DONE read them',
  ]);

  const result = await runTask('read three files', {
    bridge, tools: ctx.tools, overlay: ctx.overlay, session: ctx.session,
    options: { parallelReads: true, maxSteps: 6 }, first: true,
  });

  assert.equal(result.stopReason, 'done');
  assert.ok(state.peak >= 2, `the reads overlapped (peak ${state.peak})`);

  // The next message is the model's evidence: it must read in marker order,
  // whatever order the reads finished in.
  const evidence = bridge.sent[1];
  const at = (text) => evidence.indexOf(text);
  assert.ok(at('content:a.txt') >= 0 && at('content:b.txt') >= 0 && at('content:c.txt') >= 0);
  assert.ok(at('content:a.txt') < at('content:b.txt'), 'a before b');
  assert.ok(at('content:b.txt') < at('content:c.txt'), 'b before c');
});

test('parallelReads: false keeps the serial walk', async () => {
  const { state, tools } = instrumentedReads();
  const ctx = setup(tools);
  const bridge = scripted([
    'NEED file a.txt\nNEED file b.txt\nNEED file c.txt',
    'DONE read them',
  ]);

  const result = await runTask('read three files', {
    bridge, tools: ctx.tools, overlay: ctx.overlay, session: ctx.session,
    options: { parallelReads: false, maxSteps: 6 }, first: true,
  });

  assert.equal(result.stopReason, 'done');
  assert.equal(state.peak, 1, 'the switch turns the group off');
});
