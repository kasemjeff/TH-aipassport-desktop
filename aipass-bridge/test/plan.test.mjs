/**
 * The plan/TODO checklist, from the harness side.
 *
 * Three things were reported live: the checklist never ticked, a long plan
 * covered the conversation, and a run that ended with items still open went
 * quiet with no way back in. The parse and the checkpoint live here — a
 * `- [x] item` line (the normal markdown form a model writes) used to parse
 * as OPEN, so the card could not show progress and the DONE checkpoint always
 * saw work outstanding. The final checklist now rides the finished event, so
 * the window can re-tally the card and say what stayed open.
 *
 * The window's half of the same report is pinned in ui.test.mjs; the visual
 * bound (max-height on the card's list) is a styles.css fact no headless test
 * can see.
 *
 * Run: node --test aipass-bridge/test/plan.test.mjs
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tempDir } from './harness.mjs';
import { Overlay } from '../harness/overlay.mjs';
import { SkillLibrary } from '../harness/skills.mjs';
import { SessionStore } from '../harness/session.mjs';
import { createTools } from '../harness/tools.mjs';
import { Emitter } from '../harness/events.mjs';
import { runTask } from '../harness/loop.mjs';
import { parseTodo, mergeTodo } from '../harness/protocol.mjs';

// Nothing here may touch the real ~/.aipass.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aipass-plan-home-'));
process.env.AIPASS_HOME = HOME;
after(() => fs.rmSync(HOME, { recursive: true, force: true }));

/** Tools over a plain directory, the way the CLI and the harness build them. */
function toolsIn(dir) {
  return createTools({
    root: dir,
    overlay: new Overlay(dir),
    skills: new SkillLibrary([]),
    allowRun: false,
    maxResult: 6000,
  });
}

/** A bridge that answers a fixed list of turns and records what was sent. */
function scriptedLoop(replies) {
  const received = [];
  let turn = 0;
  return {
    received,
    async chat({ message }) {
      received.push(message);
      return { text: replies[Math.min(turn++, replies.length - 1)], reasoning: '' };
    },
    async quota() { return { available: 1 }; },
  };
}

/* The parse ---------------------------------------------------------------- */

test('every markdown shape of a ticked item parses as done', () => {
  // The live bug: done was tested against the bulleted line, so `- [x] item`
  // never registered — the card stayed grey and the DONE checkpoint always
  // saw items open. The bullet comes off first now; a bare `[x]` still works.
  const items = parseTodo([
    '- [x] done one',
    '- [ ] open two',
    '[x] bare three',
    '* [x] star four',
    '- plain five',
  ].join('\n'));
  assert.deepEqual(items, [
    { text: 'done one', done: true, kind: 'todo' },
    { text: 'open two', done: false, kind: 'todo' },
    { text: 'bare three', done: true, kind: 'todo' },
    { text: 'star four', done: true, kind: 'todo' },
    { text: 'plain five', done: false, kind: 'todo' },
  ]);
});

/* The merge ---------------------------------------------------------------- */

test('a line repeated in one update is one item, and nothing duplicates on re-merge', () => {
  // The model sometimes lists the same step twice, or a reconnect delivers an
  // update again. Two rows for one step make the count lie and the tick read
  // as half done, so the merge keeps one item per text.
  const once = mergeTodo([], parseTodo('TODO\n- [ ] alpha\n- alpha'));
  assert.deepEqual(once, [{ text: 'alpha', done: false, kind: 'todo' }], 'the repeated line is one item');
  const carried = mergeTodo(once, []);
  assert.deepEqual(carried, once, 'and a re-merge without changes does not stack a copy');
});

test('a tick sticks, and a duplicate an older build wrote collapses', () => {
  const first = mergeTodo([], parseTodo('TODO\n- one'));
  const ticked = mergeTodo(first, parseTodo('TODO\n- [x] one'));
  assert.equal(ticked[0].done, true, 'the tick registers');
  const again = mergeTodo(ticked, parseTodo('TODO\n- [ ] one'));
  assert.equal(again[0].done, true, 'done is sticky — an open line never un-ticks closed work');
  const legacyDup = [...first, { ...first[0] }];
  assert.deepEqual(mergeTodo(legacyDup, []), first, 'a duplicate already in the state reads as one item');
});

/* The DONE checkpoint ------------------------------------------------------ */

test('DONE with open items earns one checkpoint; ticking them ends the run', async () => {
  const dir = tempDir({});
  const store = new SessionStore(path.join(dir, 'sessions'));
  const session = store.create({ root: dir });
  const events = new Emitter();
  const finished = [];
  events.on('finished', (p) => finished.push(p));

  const bridge = scriptedLoop([
    'TODO\n- [ ] alpha\n- [ ] beta\nEND',
    'DONE first try',
    'TODO\n- [x] alpha\n- [x] beta\nEND\nDONE closed them all',
  ]);
  const result = await runTask('do the thing', {
    bridge, tools: toolsIn(dir), overlay: new Overlay(dir), session, events,
    options: { maxSteps: 8 }, first: true,
  });

  assert.equal(result.stopReason, 'done');
  assert.match(bridge.received[2], /still lists 2 open item\(s\)/, 'the checkpoint named how much was open');
  assert.match(bridge.received[2], /send a TODO list with \[x\] on them/, 'and taught the tick that closes them');
  const stats = session.entries.find((e) => e.type === 'run_stats');
  assert.equal(stats.todoPrompts, 1, 'one checkpoint per run, however many DONEs');
  assert.deepEqual(finished.at(-1).todo, [
    { text: 'alpha', done: true, kind: 'todo' },
    { text: 'beta', done: true, kind: 'todo' },
  ], 'the finished event carries the final ticks');
  assert.deepEqual(result.todo, finished.at(-1).todo, 'and the run result carries the same copy');
  const todos = session.entries.filter((e) => e.type === 'todo');
  assert.equal(todos.at(-1).items.every((it) => it.done), true, 'the session log stores the final state');
});

test('a run that ignores the checkpoint still ends done, and the payload says what is open', async () => {
  // A second DONE ends the run either way — the checkpoint is a question, not
  // a gate. What it must not do is let the ending go quiet: the finished
  // payload names the item still open, which is what the window tells on.
  const dir = tempDir({});
  const store = new SessionStore(path.join(dir, 'sessions'));
  const session = store.create({ root: dir });
  const events = new Emitter();
  const finished = [];
  events.on('finished', (p) => finished.push(p));

  const bridge = scriptedLoop([
    'TODO\n- [ ] only item\nEND',
    'DONE early',
    'DONE again, nothing to add',
  ]);
  const result = await runTask('do the thing', {
    bridge, tools: toolsIn(dir), overlay: new Overlay(dir), session, events,
    options: { maxSteps: 8 }, first: true,
  });

  assert.equal(result.stopReason, 'done', 'the closing DONE is still honored');
  assert.equal(session.entries.find((e) => e.type === 'run_stats').todoPrompts, 1, 'asked once, never nagged');
  assert.deepEqual(finished.at(-1).todo, [{ text: 'only item', done: false, kind: 'todo' }]);
});

test('a run with no plan carries an empty checklist, not a missing field', async () => {
  // The window reads finished.todo on every run; a run that never wrote one
  // must still deliver the field, or every plain Q&A turn would look like it
  // "has a checklist" to code that tests for the key.
  const dir = tempDir({});
  const store = new SessionStore(path.join(dir, 'sessions'));
  const session = store.create({ root: dir });
  const events = new Emitter();
  const finished = [];
  events.on('finished', (p) => finished.push(p));

  const bridge = scriptedLoop(['DONE nothing to do']);
  const result = await runTask('say hi', {
    bridge, tools: toolsIn(dir), overlay: new Overlay(dir), session, events,
    options: { maxSteps: 8 }, first: true,
  });

  assert.equal(result.stopReason, 'done');
  assert.deepEqual(result.todo, []);
  assert.deepEqual(finished.at(-1).todo, []);
  assert.equal(session.entries.find((e) => e.type === 'run_stats').todoPrompts, 0, 'nothing to checkpoint');
});
