// Wave 3.2 — a RUN can outlive the step that started it.
//
// A test suite, a build and a dev server all take longer than one reply. The
// RUN tool used to await every command to its 120s ceiling, so a long job read
// as a failure and the run had nothing to do while it finished. `RUN
// background` starts the same command in the same world, answers with a job id
// at once, and streams the output to a spill file the `read` tool can reach.
// `JOBS` polls, `JOBS stop` takes the whole tree down, and a DONE over a live
// job is not a silent finish.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempDir } from './harness.mjs';
import { Overlay } from '../harness/overlay.mjs';
import { SkillLibrary } from '../harness/skills.mjs';
import { createTools } from '../harness/tools.mjs';
import { Emitter } from '../harness/events.mjs';
import { runTask } from '../harness/loop.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Prints at once, then leaves a file behind if it is still alive after two
// seconds. A stopped tree never writes it, which is what "the tree, not the
// shell" means in an assertion.
const SLOW = `import fs from 'node:fs';\nconsole.log('background says hi');\nsetTimeout(() => { fs.writeFileSync('late.txt', 'late'); }, 2000);\n`;

const toolsAt = (dir, overlay) => createTools({
  root: dir, overlay, skills: new SkillLibrary([]), allowRun: true, maxResult: 6000,
});

const scripted = (replies, sent) => {
  let turn = 0;
  return {
    async chat({ message }) {
      sent.push(message);
      return { text: replies[Math.min(turn++, replies.length - 1)], reasoning: '' };
    },
    async quota() { return { available: 10 }; },
  };
};

test('a background RUN outlives the turn, its output is readable, and stop takes the tree down', async () => {
  const dir = tempDir({ 'slow.mjs': SLOW });
  const overlay = new Overlay(dir);
  const events = new Emitter();
  const rows = [];
  events.on('tool', (p) => rows.push(p));
  const sent = [];
  const replies = [
    'RUN background\nnode slow.mjs\nEND\n',
    'JOBS\n',
    'JOBS stop run1\n',
    'DONE stopped the build\n',
  ];

  const result = await runTask('start the slow build', {
    bridge: scripted(replies, sent),
    tools: toolsAt(dir, overlay),
    overlay,
    events,
    options: { maxSteps: 6, allowRun: true },
    first: true,
  });

  assert.equal(result.stopReason, 'done');

  const started = rows.find((p) => p.kind === 'run');
  assert.ok(started, `the background RUN ran as a call:\n${JSON.stringify(rows)}`);
  assert.match(started.head, /started background command run1/, 'the job id came back at once');
  // The full answer rides the next message; the event head is capped at 70
  // characters, so the file path is checked where the model read it.
  assert.match(sent[1] ?? '', /\.aipass\/spill\/run1\.txt/, 'and named the output file');

  // The next step saw it still running: that is the command outliving the
  // turn, not merely finishing before the model could poll.
  const polled = rows.find((p) => p.kind === 'jobs' && /run1: running/.test(p.head));
  assert.ok(polled, `JOBS saw the job running:\n${JSON.stringify(rows)}`);
  assert.match(sent[2] ?? '', /output: \.aipass\/spill\/run1\.txt/);

  const stopped = rows.find((p) => p.kind === 'jobs' && /stopped run1/.test(p.head));
  assert.ok(stopped, `JOBS stop answered:\n${JSON.stringify(rows)}`);

  // Output is on disk where `read` can reach it, and the tree is really gone:
  // the script would have written late.txt two seconds after it started.
  const output = fs.readFileSync(path.join(dir, '.aipass', 'spill', 'run1.txt'), 'utf8');
  assert.match(output, /background says hi/, `the output file carries the command's output: ${output}`);
  await sleep(2300);
  assert.equal(fs.existsSync(path.join(dir, 'late.txt')), false, 'the stopped tree never wrote its late file');
});

test('a DONE over a live job is refused once and then ends as jobs-running (not a silent finish)', async () => {
  const dir = tempDir({ 'slow.mjs': SLOW });
  const overlay = new Overlay(dir);
  const events = new Emitter();
  const rows = [];
  events.on('tool', (p) => rows.push(p));
  const sent = [];
  const replies = [
    'RUN background\nnode slow.mjs\nEND\n',
    'DONE everything is fine\n',
    'DONE still fine\n',
  ];

  const result = await runTask('start the slow build and finish', {
    bridge: scripted(replies, sent),
    tools: toolsAt(dir, overlay),
    overlay,
    events,
    options: { maxSteps: 4, allowRun: true },
    first: true,
  });

  // The first DONE bought a nudge naming the job; the second is accepted as
  // an end that says the job is still running.
  assert.equal(result.stopReason, 'jobs-running');
  assert.ok(sent.some((m) => /Before DONE: the background command/.test(m)), 'the gate named the live job');
  assert.match(result.summary, /run1/);
  assert.match(result.summary, /\.aipass\/spill\/run1\.txt/);
});
