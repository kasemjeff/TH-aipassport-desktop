// The project goal (harness/goal.mjs): one durable objective, the rounds a
// plain DONE buys while it is active, and the person's own CLI over it.
//
// The pins here are the parts that make it safe in this harness: the store is
// per project and owner-only, the model can only complete or block it (never
// rewrite it), a paused/cleared goal is respected mid-run, helpers and the
// checker never touch it, and the preamble stays byte-identical without one.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  loadGoal, setGoal, pauseGoal, resumeGoal, completeGoal, blockGoal, clearGoal, goalPath,
  createGoalController, DEFAULT_MAX_ROUNDS, MAX_ROUNDS,
} from '../harness/goal.mjs';
import { preamble, parse, attemptedMarker } from '../harness/protocol.mjs';
import { validateCall } from '../harness/validate.mjs';
import { runTask } from '../harness/loop.mjs';
import { Overlay } from '../harness/overlay.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', 'bin', 'aipass.mjs');
const dirs = [];
const tempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aipass-goal-'));
  dirs.push(dir);
  return dir;
};
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

/** A project in a scratch folder, plus a scratch AIPASS_HOME for its store. */
const project = () => {
  const root = tempDir();
  const home = tempDir();
  const dir = path.join(home, 'goal');
  process.env.AIPASS_HOME = home;
  return { root, home, dir };
};

/** One scripted reply per model turn; anything past the script ends as DONE. */
const scripted = (replies) => {
  const sent = [];
  const bridge = {
    async chat({ message }) {
      sent.push(message);
      return { text: replies.shift() ?? 'DONE end', reasoning: '' };
    },
    async quota() { return { available: 1 }; },
  };
  return { bridge, sent };
};

const runWith = (root, bridge, { first = true, goal, slim = false } = {}) => runTask('finish the job', {
  bridge,
  tools: { async list() { return ''; } },
  overlay: new Overlay(root),
  options: { maxSteps: 10, ...(slim ? { slim: true } : {}) },
  ...(goal === undefined ? {} : { goal }),
  first,
});

// --- the store ---------------------------------------------------------------

test('the store: set, read, replace refused without force', () => {
  const { root } = project();
  const goal = setGoal(root, '  ship   the parser ');
  assert.equal(goal.objective, 'ship the parser');
  assert.equal(goal.status, 'active');
  assert.equal(goal.rounds, 0);
  assert.equal(goal.maxRounds, DEFAULT_MAX_ROUNDS);
  assert.equal(goalPath(root), goalPath(root));
  assert.deepEqual(loadGoal(root), goal);

  // A live goal is where the work stood: replacing it is deliberate.
  assert.throws(() => setGoal(root, 'something else'), /--force/);
  const replaced = setGoal(root, 'something else', { force: true, maxRounds: 3 });
  assert.equal(replaced.objective, 'something else');
  assert.equal(replaced.maxRounds, 3);
  // A finished goal needs no force.
  completeGoal(root, 'done');
  assert.equal(setGoal(root, 'next').objective, 'next');
});

test('the store: rounds are clamped, pauses and resumes are real', () => {
  const { root } = project();
  setGoal(root, 'ship it', { maxRounds: 2 });
  assert.equal(pauseGoal(root).status, 'paused');
  assert.equal(loadGoal(root).status, 'paused');
  assert.equal(resumeGoal(root).status, 'active');
  assert.throws(() => setGoal(root, 'x', { maxRounds: MAX_ROUNDS + 1 }), /1 to 64/);

  // A blocked goal resumed is a fresh allowance, not an instant block.
  fs.writeFileSync(goalPath(root), JSON.stringify({ ...loadGoal(root), status: 'blocked', blocked: 'round-limit', rounds: 2 }));
  const resumed = resumeGoal(root);
  assert.equal(resumed.status, 'active');
  assert.equal(resumed.rounds, 0);
  assert.equal(resumed.blocked, null);

  clearGoal(root);
  assert.equal(loadGoal(root), null);
  assert.equal(createGoalController(root).current(), null);
});

test('the store: a corrupt file reads as no goal, never a crash', () => {
  const { root } = project();
  setGoal(root, 'ship it');
  fs.writeFileSync(goalPath(root), '{not json');
  assert.equal(loadGoal(root), null);
});

// --- the wire format ---------------------------------------------------------

test('the preamble: no goal adds no bytes; an active goal teaches the markers', () => {
  assert.equal(preamble({ plan: true }), preamble({ plan: true, goal: null }));
  // Paused and complete goals are the person's business, not the model's.
  assert.equal(preamble({}), preamble({ goal: { status: 'paused', objective: 'x', rounds: 0, maxRounds: 8 } }));
  assert.equal(preamble({}), preamble({ goal: { status: 'complete', objective: 'x', rounds: 1, maxRounds: 8 } }));

  const text = preamble({ goal: { status: 'active', objective: 'ship the parser', rounds: 2, maxRounds: 8 } });
  assert.match(text, /ship the parser/);
  assert.match(text, /round 3 of 8/);
  assert.match(text, /GOAL DONE/);
  assert.match(text, /GOAL BLOCKED <reason>/);
});

test('the markers: GOAL parses, refuses a bare word, and takes two actions', () => {
  const calls = parse('GOAL DONE shipped it\nDONE shipped it');
  assert.deepEqual(calls.map((c) => c.kind), ['goal', 'done']);
  assert.equal(calls[0].arg, 'DONE shipped it');
  assert.equal(parse('GOAL BLOCKED need a token')[0].arg, 'BLOCKED need a token');
  // A bare GOAL is a shape mistake, not prose and not a silent finish.
  assert.equal(parse('GOAL').length, 0);
  assert.equal(attemptedMarker('GOAL'), true);

  assert.equal(validateCall({ kind: 'goal', arg: 'DONE shipped it' }), null);
  assert.equal(validateCall({ kind: 'goal', arg: 'blocked the vendor' }), null);
  assert.match(validateCall({ kind: 'goal', arg: '' }), /GOAL takes DONE or BLOCKED/);
  assert.match(validateCall({ kind: 'goal', arg: 'maybe later' }), /GOAL takes DONE or BLOCKED/);
});

// --- the run -----------------------------------------------------------------

test('a plain DONE while the goal is active buys a round; GOAL DONE ends it', async () => {
  const { root } = project();
  setGoal(root, 'add the parser and its tests');
  const { bridge, sent } = scripted(['DONE first pass', 'GOAL DONE parser and tests ship\nDONE parser and tests ship']);

  const result = await runWith(root, bridge);

  assert.equal(result.stopReason, 'done');
  assert.equal(loadGoal(root).status, 'complete');
  assert.equal(loadGoal(root).done, 'parser and tests ship');
  assert.equal(loadGoal(root).rounds, 1);
  // The nudge named the objective and the round, and the run continued.
  assert.match(sent[1], /round 1 of 8/);
  assert.match(sent[1], /add the parser and its tests/);
});

test('the round cap blocks the goal and stops the run as goal-rounds', async () => {
  const { root } = project();
  setGoal(root, 'never finishes', { maxRounds: 2 });
  const { bridge } = scripted(['DONE one', 'DONE two', 'DONE three', 'DONE four']);

  const result = await runWith(root, bridge);

  assert.equal(result.stopReason, 'goal-rounds');
  assert.match(result.summary, /round-limit/);
  const goal = loadGoal(root);
  assert.equal(goal.status, 'blocked');
  assert.equal(goal.blocked, 'round-limit');
  assert.equal(goal.rounds, 2);
});

test('a goal paused mid-run is respected: DONE is accepted, not resurrected', async () => {
  const { root } = project();
  setGoal(root, 'ship it');
  const sent = [];
  const bridge = {
    async chat({ message }) {
      sent.push(message);
      if (sent.length === 1) return { text: 'DONE first pass', reasoning: '' };
      pauseGoal(root); // the person, from another window
      return { text: 'DONE stopped pursuing it', reasoning: '' };
    },
    async quota() { return { available: 1 }; },
  };

  const result = await runWith(root, bridge);

  assert.equal(result.stopReason, 'done');
  assert.equal(loadGoal(root).status, 'paused');
  assert.equal(loadGoal(root).rounds, 1);
});

test('a follow-up run carries the goal in the task; goal:false runs do not', async () => {
  const { root } = project();
  setGoal(root, 'ship the parser');
  const first = scripted([]);
  await runWith(root, first.bridge, { first: false });
  assert.match(first.sent[0], /goal is still active \(round 1 of 8\): ship the parser/);

  const second = scripted([]);
  await runWith(root, second.bridge, { first: false, goal: false });
  assert.doesNotMatch(second.sent[0], /goal is still active/);
});

test('a slim first message carries the goal too, before the task', async () => {
  // Slim sends no preamble, so the goal only reached the model at the first
  // DONE nudge. A first message must say what the run is chasing.
  const { root } = project();
  setGoal(root, 'ship the parser', { maxRounds: 2 });
  const { bridge, sent } = scripted([]);
  await runWith(root, bridge, { slim: true });

  assert.match(sent[0], /goal is still active \(round 1 of 2\): ship the parser/);
  assert.match(sent[0], /Task: finish the job/);
  assert.ok(sent[0].indexOf('goal is still active') < sent[0].indexOf('Task:'),
    'the goal comes before the task it governs');
});

// --- the CLI -----------------------------------------------------------------

test('cli: aipass goal sets, shows, and refuses a silent replace', () => {
  const { root, home } = project();
  const env = { ...process.env, AIPASS_HOME: home };
  const cli = (...args) => spawnSync(process.execPath, [CLI, 'goal', ...args], { cwd: root, env, encoding: 'utf8' });

  const set = cli('set', 'ship the parser', '--rounds', '3');
  assert.equal(set.status, 0, set.stderr);
  assert.match(set.stdout, /ship the parser/);

  const show = cli();
  assert.equal(show.status, 0, show.stderr);
  assert.match(show.stdout, /goal \(active\): ship the parser/);
  assert.match(show.stdout, /rounds: 0 of 3/);

  const twice = cli('set', 'something else');
  assert.equal(twice.status, 1);
  assert.match(twice.stderr, /--force/);

  assert.equal(cli('pause').status, 0);
  assert.match(cli().stdout, /goal \(paused\)/);
  assert.equal(cli('done', 'shipped').status, 0);
  assert.match(cli().stdout, /goal \(complete\)/);
  assert.equal(cli('clear').status, 0);
  assert.match(cli().stdout, /no goal/);
});
