#!/usr/bin/env node
// aipass goal — the one durable objective this project is working toward.
// Sets, inspects and controls it without spending a model turn (dsh's /goal).
//
//   aipass goal                        show it
//   aipass goal set "<objective>"      set or replace it (--rounds N, --force)
//   aipass goal pause | resume
//   aipass goal done [what was finished]
//   aipass goal block [reason]
//   aipass goal clear
//   aipass goal path
import {
  loadGoal, setGoal, pauseGoal, resumeGoal, completeGoal, blockGoal, clearGoal, goalPath,
  DEFAULT_MAX_ROUNDS,
} from './harness/goal.mjs';

const args = process.argv.slice(2);
const cmd = args.shift() || 'show';
const at = args.indexOf('--rounds');
const rounds = at >= 0 ? args.splice(at, 2)[1] : DEFAULT_MAX_ROUNDS;
const force = args.includes('--force');
const text = args.filter((a) => a !== '--force').join(' ').trim();
const root = process.cwd();

const fail = (err) => {
  console.error(`aipass goal: ${err.message}`);
  process.exit(1);
};

try {
  if (cmd === 'set') {
    const goal = setGoal(root, text, { maxRounds: rounds, force });
    console.log(`goal set (rounds 1-${goal.maxRounds}): ${goal.objective}`);
    process.exit(0);
  }
  if (cmd === 'pause') {
    const goal = pauseGoal(root);
    console.log(`goal paused: ${goal.objective}`);
    process.exit(0);
  }
  if (cmd === 'resume') {
    const goal = resumeGoal(root);
    console.log(`goal resumed (rounds 1-${goal.maxRounds}): ${goal.objective}`);
    process.exit(0);
  }
  if (cmd === 'done') {
    const goal = completeGoal(root, text);
    console.log(`goal complete: ${goal.objective}${goal.done ? ` — ${goal.done}` : ''}`);
    process.exit(0);
  }
  if (cmd === 'block') {
    const goal = blockGoal(root, text);
    console.log(`goal blocked: ${goal.objective} — ${goal.blocked}`);
    process.exit(0);
  }
  if (cmd === 'clear') {
    clearGoal(root);
    console.log('goal cleared for this project');
    process.exit(0);
  }
  if (cmd === 'path') {
    console.log(goalPath(root));
    process.exit(0);
  }
  if (cmd === 'show' || cmd === 'list' || cmd === 'ls') {
    const goal = loadGoal(root);
    if (!goal) {
      console.log('(no goal for this project — set one with: aipass goal set "<what to finish>")');
      process.exit(0);
    }
    console.log(`goal (${goal.status}): ${goal.objective}`);
    console.log(`  rounds: ${goal.rounds} of ${goal.maxRounds}`);
    if (goal.blocked) console.log(`  blocked: ${goal.blocked}`);
    if (goal.done) console.log(`  done: ${goal.done}`);
    if (goal.updated) console.log(`  updated: ${goal.updated}`);
    process.exit(0);
  }
  console.error('usage: aipass goal [show|set|pause|resume|done|block|clear|path] — set "<objective>" [--rounds N] [--force]');
  process.exit(1);
} catch (err) {
  fail(err);
}
