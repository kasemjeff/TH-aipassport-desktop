// The Thai pack's guards and hooks, one test per behaviour:
//
//   - invisible characters and Thai digits in an argument that fails to
//     resolve earn one normalized retry, and the result says so (argguard.mjs
//     + the loop wiring)
//   - a NEED range written in Thai digits still counts as one marker, and the
//     argument rides raw until the guard has to normalize it
//   - an identical call repeated with nothing staged in between is refused on
//     the third time, counted, and a run past the refusal cap stops as stalled
//   - the reply-language hook asks exactly once for Thai when the closing
//     message comes back English
//   - a stalled run still gets the checker's one shot at the staged tree
//   - the preamble carries the language rules, and the settings clamp like
//     the rest of the sheet
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tempDir } from './harness.mjs';
import { Overlay } from '../harness/overlay.mjs';
import { SessionStore } from '../harness/session.mjs';
import { createTools } from '../harness/tools.mjs';
import { Emitter } from '../harness/events.mjs';
import { runTask } from '../harness/loop.mjs';
import { parse, preamble, MARKER_LINE } from '../harness/protocol.mjs';
import { pathVariants, beYearNote } from '../harness/argguard.mjs';
import { Settings } from '../harness/settings.mjs';
import { resolveTask, formatSummary } from '../../scripts/evals.mjs';

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

/** Everything one loop test needs: tools, session, and the stats line. */
function boot(dir, replies, options = {}, extra = {}) {
  const overlay = new Overlay(dir);
  const store = new SessionStore(path.join(dir, 'sessions'));
  const session = store.create({ root: dir });
  const tools = createTools({ root: dir, overlay });
  const bridge = scriptedLoop(replies);
  const events = new Emitter();
  const call = (more = {}) => runTask('do the task', {
    bridge, tools, overlay, session, events,
    options: { maxSteps: 8, ...options, ...more },
    first: true,
    ...extra,
  });
  const stats = () => [...session.entries].reverse().find((e) => e.type === 'run_stats');
  const toolEntry = (kind) => session.entries.find((e) => e.type === 'tool' && e.kind === kind);
  return { call, stats, toolEntry, bridge, session, overlay, tools, events, dir };
}

/* Tests 1-3: the pure pieces ---------------------------------------------- */

test('path variants normalize invisibles and Thai digits, in that order', () => {
  const v = pathVariants('notes\u200B๑.txt');
  assert.ok(v.includes('notes๑.txt'), 'the invisible character alone');
  assert.ok(v.includes('notes\u200B1.txt'), 'the Thai digit alone');
  assert.ok(v.includes('notes1.txt'), 'both');
  assert.deepEqual(pathVariants('plain.txt'), [], 'nothing to fix yields no retry');
  assert.match(beYearNote('date -d 2569-01-02'), /2569 looks like a Buddhist-era year \(= 2026 CE\)/);
  assert.equal(beYearNote('node --check app.mjs'), null, 'a plain command earns no note');
});

test('a NEED range in Thai digits still parses as one marker', () => {
  const calls = parse('NEED file log.txt ๑-๒').filter((c) => c.kind === 'read');
  assert.equal(calls.length, 1, 'the line is a marker, not prose');
  assert.equal(calls[0].arg, 'log.txt ๑-๒', 'raw — the guard normalizes only on refusal');
  assert.ok(MARKER_LINE.test('NEED file log.txt ๑-๒'));
});

test('the preamble asks for Thai replies and keeps tooling English', () => {
  const th = preamble({});
  assert.match(th, /talk to me in Thai/);
  assert.match(th, /Never translate Thai content/);
  assert.ok(!th.includes('Answer in English'), 'the old blanket sentence is gone');
  const en = preamble({ lang: 'en' });
  assert.match(en, /talk to me in English/);
});

test('the language settings clamp like the rest of the sheet', () => {
  const s = Settings.sane({
    replyLanguage: 'fr', langCheck: 0, minThaiRatio: 5,
    repeatGuard: 1, repeatGuardMax: 0, attempts: 99,
  });
  assert.equal(s.replyLanguage, 'th', 'an unknown language falls back');
  assert.equal(s.langCheck, false);
  assert.equal(s.minThaiRatio, 1, 'the ratio is clamped to 0..1');
  assert.equal(s.repeatGuard, true);
  assert.equal(s.repeatGuardMax, 1, 'a zero cap means the floor, not no guard');
  assert.equal(s.attempts, 5, 'attempts are clamped to 1..5');
});

/* Tests 4-5: the arg guard reaches the loop --------------------------------- */

test('a read whose path carries an invisible character is retried normalized', async () => {
  const dir = tempDir({ 'note.txt': 'hello there\n' });
  const b = boot(dir, ['NEED file note\u200B.txt', 'DONE read it']);
  const result = await b.call();

  assert.equal(result.stopReason, 'done');
  const entry = b.toolEntry('read');
  assert.match(entry.out, /hello there/, 'the retry found the real file');
  assert.match(entry.out, /invisible characters/, 'and the result says what happened');
  assert.equal(entry.ok, true, 'the row is a success, not a refusal');
  assert.equal(b.stats().tools.read.fail, 0);
});

test('a NEED range in Thai digits resolves through the guard', async () => {
  const dir = tempDir({ 'log.txt': 'one\ntwo\nthree\nfour\n' });
  const b = boot(dir, ['NEED file log.txt ๑-๒', 'DONE read two lines']);
  const result = await b.call();

  assert.equal(result.stopReason, 'done');
  const entry = b.toolEntry('read');
  assert.match(entry.out, /1 \| one/);
  assert.match(entry.out, /2 \| two/);
  assert.ok(!entry.out.includes('three'), 'the range stopped at the second line');
});

/* Tests 6-7: the repeat guard ------------------------------------------------ */

test('an identical call is refused on the third time and counted', async () => {
  const dir = tempDir({ 'a.txt': 'hello\n' });
  const b = boot(dir, ['NEED file a.txt', 'NEED file a.txt', 'NEED file a.txt', 'DONE read it'],
    { repeatGuard: true });
  const blocks = [];
  b.events.on('repeat_block', (p) => blocks.push(p));
  const result = await b.call();

  assert.equal(result.stopReason, 'done', 'the run still finishes');
  assert.equal(blocks.length, 1, 'exactly one refusal');
  const stat = b.stats();
  assert.equal(stat.repeatBlocks, 1);
  assert.deepEqual(stat.tools.read, { n: 3, fail: 1 }, 'the third read is the refused one');
  assert.ok(stat.repeatedResults >= 1 && stat.novelResults >= 2, 'the novel/repeat split is real');
  assert.match(b.bridge.received[3], /repeating it cannot produce a different result|already made/i,
    'the refusal reached the model');
});

test('refusals past the cap stop the run as stalled', async () => {
  const dir = tempDir({ 'a.txt': 'hello\n' });
  const b = boot(dir, ['NEED file a.txt', 'NEED file a.txt', 'NEED file a.txt', 'NEED file a.txt', 'NEED file a.txt'],
    { maxSteps: 10, repeatGuard: true, repeatGuardMax: 1 });
  const result = await b.call();

  assert.equal(result.stopReason, 'stalled');
  assert.equal(b.stats().repeatBlocks, 2, 'two refusals: the cap is one');
});

/* Test 8: the reply-language hook ------------------------------------------- */

test('an English closing message earns one Thai rewrite request', async () => {
  const dir = tempDir({ 'a.txt': 'hello\n' });
  const b = boot(dir, [
    'NEED file a.txt',
    'I read the file and everything looks fine to me. DONE done',
    'อ่านไฟล์แล้ว เรียบร้อยดีครับ ทุกอย่างผ่าน\nDONE เสร็จแล้วครับ',
  ], { langCheck: true, minThaiRatio: 0.25 });
  const result = await b.call();

  assert.equal(result.stopReason, 'done');
  assert.match(b.bridge.received[2], /Language check: I read Thai/, 'the nudge reached the model');
  assert.equal(b.stats().langPrompts, 1, 'exactly one nudge per run');
});

/* Test 9: the checker's one shot at a stalled run ---------------------------- */

test('a stalled run still gets the checker’s one attempt', async () => {
  const dir = tempDir({ 'app.mjs': 'export const x = 1;\n' });
  const seenFiles = [];
  // Empty replies, not prose: a reply with words is the loop's "the model
  // answered" shape. The nudge streak (and its stalled exit) is what a model
  // that keeps saying nothing walks into.
  const b = boot(dir, [
    'EDIT app.mjs\nFIND\nexport const x = 1;\nNEW\nexport const x = 2;\nEND',
    '', '', '',
    'DONE all good',
  ], { maxSteps: 10, subagent: true, allowRun: true }, {
    check: async ({ files }) => {
      seenFiles.push(files);
      return { verdict: 'fail', text: 'node --check app.mjs failed: boom', ran: 1 };
    },
  });
  const result = await b.call();

  assert.equal(seenFiles.length, 1, 'the check ran exactly once');
  assert.equal(result.stopReason, 'done', 'the fail rode a step; the run carried on');
  assert.match(b.bridge.received[4], /did not pass/, 'the fail report reached the model');
  assert.equal(result.check?.verdict, 'fail', 'the loop hands the verdict back');
  const stat = b.stats();
  assert.equal(stat.checks, 1);
  assert.equal(stat.checkVerdict, 'fail');
  assert.equal(stat.nudges, 3, 'three no-marker replies before the stall');
});

/* Test 10: the runner knows the Thai set ------------------------------------- */

test('the runner resolves thai tasks and reports the new metrics', () => {
  const th = resolveTask('fix-year');
  assert.equal(th.kind, 'thai');
  assert.equal(th.lang, 'th');
  const en = resolveTask('fix-year-en');
  assert.equal(en.lang, 'en');
  assert.equal(en.pair, th.pair, 'both sides carry the same pair id');

  const out = formatSummary([{
    taskId: 'fix-year', kind: 'thai', lang: 'th', outcome: 'solved', scored: true,
    stopReason: 'done', turns: 3, calls: { total: 4, refusals: 1 }, nudges: 1,
    stagnations: 0, verifyPrompts: 0, firewallNotes: 0,
    repeatBlocks: 2, langPrompts: 1, replyThai: 0.9, tokensEst: 2500,
    spent: 1, wallMs: 1200, checks: 0, checkVerdict: null,
  }]);
  assert.match(out, /metrics: success 100% \(1\/1 scored\)/);
  assert.match(out, /tool errors 25%/);
  assert.match(out, /repeat-blocks 2/);
  assert.match(out, /replies in Thai 90%/);
  assert.match(out, /tokens\/solved/);
});
