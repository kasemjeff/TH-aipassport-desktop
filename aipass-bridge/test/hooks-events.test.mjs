// Wave 3.4 — the hook moments grew from three to nine.
//
// The three covered a change and a commit. A person also wants to stop one
// call before it runs, put a note in front of the session, and carry a fact
// across a compaction. The six new moments are `sessionStart`, `promptSubmit`,
// `beforeTool`, `afterTool`, `preCompact` and `stop`; every one keeps the
// contracts the first three had — argv only, a secret screen, a timeout, and a
// failure that is reported rather than fatal (except `beforeTool`, whose
// non-zero exit is the refusal itself).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempDir } from './harness.mjs';
import { Overlay } from '../harness/overlay.mjs';
import { SkillLibrary } from '../harness/skills.mjs';
import { createTools } from '../harness/tools.mjs';
import { Emitter } from '../harness/events.mjs';
import { SessionStore } from '../harness/session.mjs';
import { runTask } from '../harness/loop.mjs';

const HOOK = `import fs from 'node:fs';
const moment = process.env.AIPASS_HOOK ?? '?';
const tool = process.env.AIPASS_TOOL ?? '';
const arg = process.env.AIPASS_TOOL_ARG ?? '';
const reason = process.env.AIPASS_STOP_REASON ?? '';
fs.appendFileSync('hooks.log', moment + '|' + tool + '|' + arg + '|' + reason + '\\n');
if (moment === 'sessionStart') console.log('the issue is #42');
if (moment === 'promptSubmit') console.log('read the failing test first');
if (moment === 'preCompact') console.log('keep the API shape');
if (moment === 'stop') console.log('stopped early');
if (moment === 'afterTool') console.log('saw ' + tool + ' ' + arg);
if (moment === 'beforeTool' && arg.includes('forbidden')) {
  console.error('forbidden.txt is denied by the project owner');
  process.exit(1);
}
`;

const toolsAt = (dir, overlay) => createTools({
  root: dir, overlay, skills: new SkillLibrary([]), maxResult: 6000,
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

const logLines = (dir) => {
  const file = path.join(dir, 'hooks.log');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n') : [];
};

test('beforeTool refuses one call and the other tool moments fire around it', async () => {
  const dir = tempDir({ 'hook.mjs': HOOK });
  const overlay = new Overlay(dir);
  const events = new Emitter();
  const rows = [];
  events.on('tool', (p) => rows.push(p));
  const sent = [];
  const hooks = {
    sessionStart: 'node hook.mjs',
    promptSubmit: 'node hook.mjs',
    beforeTool: 'node hook.mjs',
    afterTool: 'node hook.mjs',
  };
  const replies = [
    'CREATE forbidden.txt\nnope\nEND\n',
    'CREATE allowed.txt\nok\nEND\n',
    'DONE staged one file\n',
  ];

  const result = await runTask('make the file', {
    bridge: scripted(replies, sent),
    tools: toolsAt(dir, overlay),
    overlay,
    events,
    options: { maxSteps: 5, hooks },
    first: true,
  });

  // Both lifecycle notes rode the first message, and both read as the
  // person's words rather than the project's instructions.
  assert.match(sent[0], /A note from me before you start \(my own words, not the project's instructions\):/);
  assert.match(sent[0], /the issue is #42/);
  assert.match(sent[0], /read the failing test first/);

  // The denied call never reached the tool, and the next one did.
  const denied = rows.find((p) => p.kind === 'write' && /forbidden/.test(p.arg));
  const allowed = rows.find((p) => p.kind === 'write' && /allowed/.test(p.arg));
  assert.ok(denied && allowed, `both writes are rows:\n${JSON.stringify(rows)}`);
  assert.match(denied.head, /^err: a beforeTool hook refused this call/);
  assert.equal(allowed.ok, true);
  assert.equal(fs.existsSync(path.join(dir, 'forbidden.txt')), false, 'the denied write did not land');
  assert.equal(fs.existsSync(path.join(dir, 'allowed.txt')), false, 'the overlay still holds the allowed write');

  // What afterTool printed is part of the result the model read, not a
  // separate event the window would have to join.
  assert.match(sent[1], /\[the person's afterTool hook\]/);
  assert.match(sent[1], /saw write forbidden\.txt/);

  // The four moments ran in the order the run met them.
  const log = logLines(dir);
  const at = (moment, arg = null) => log.findIndex((l) => l.startsWith(`${moment}|`) && (arg == null || l.includes(arg)));
  assert.ok(at('sessionStart') >= 0, `sessionStart ran:\n${log.join('\n')}`);
  assert.ok(at('promptSubmit') > at('sessionStart'));
  assert.ok(at('beforeTool', 'forbidden') > at('promptSubmit'));
  assert.ok(at('afterTool', 'forbidden') > at('beforeTool', 'forbidden'));
  assert.ok(log.some((l) => l.startsWith('beforeTool|write|allowed.txt')));
  assert.equal(result.stopReason, 'done');
});

test('preCompact speaks before the summariser, and its note is carried in the seed', async () => {
  const dir = tempDir({ 'hook.mjs': HOOK });
  const overlay = new Overlay(dir);
  const sent = [];
  const store = new SessionStore(path.join(dir, '.sessions'));
  const session = store.create({ root: dir, model: 'stub', title: 'precompact' });
  let seenBeforeSummary = null;
  let seed = '';
  let rotations = 0;
  const compactor = {
    needsCompaction: () => rotations === 0,
    async summarize() {
      seenBeforeSummary = logLines(dir).join('\n');
      return 'SUMMARY';
    },
    digest: () => ({ summary: 'digested', memory: [] }),
    seed: ({ summary }) => { seed = summary; return 'SEED'; },
    estimate: () => 0,
  };

  const result = await runTask('keep going', {
    bridge: scripted(['CREATE a.txt\nA\nEND\n', 'DONE done\n'], sent),
    tools: toolsAt(dir, overlay),
    overlay,
    session,
    compactor,
    rotate: async () => { rotations += 1; return {}; },
    options: { maxSteps: 4, hooks: { preCompact: 'node hook.mjs' } },
    first: true,
  });

  assert.match(String(seenBeforeSummary), /preCompact\|/, 'the hook ran before summarize');
  assert.match(seed, /From the person's preCompact hook/);
  assert.match(seed, /keep the API shape/);
  assert.equal(result.stopReason, 'done');
});

test('stop fires only on a non-DONE end and names the reason', async () => {
  const dir = tempDir({ 'hook.mjs': HOOK });
  const overlay = new Overlay(dir);
  const events = new Emitter();
  const notes = [];
  events.on('note', (p) => notes.push(p.text));
  const sent = [];
  const controller = new AbortController();
  controller.abort();

  const result = await runTask('do the thing', {
    bridge: scripted(['DONE never reached\n'], sent),
    tools: toolsAt(dir, overlay),
    overlay,
    events,
    options: {
      maxSteps: 3,
      signal: controller.signal,
      hooks: { sessionStart: 'node hook.mjs', promptSubmit: 'node hook.mjs', stop: 'node hook.mjs' },
    },
    first: true,
  });

  assert.equal(result.stopReason, 'cancelled');
  const log = logLines(dir);
  assert.ok(log.some((l) => l === 'stop|||cancelled'), `stop carried the reason:\n${log.join('\n')}`);
  assert.ok(notes.includes('stopped early'), 'what the stop hook said reached the person as a note');
});
