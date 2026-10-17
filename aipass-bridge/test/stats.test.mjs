// P2-D: one run_stats line per run, and the aggregation the reader prints.
// The run is driven directly (a stub bridge, a real session) so the line's
// shape is checked without spawning anything.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Overlay } from '../harness/overlay.mjs';
import { SessionStore } from '../harness/session.mjs';
import { createTools } from '../harness/tools.mjs';
import { runTask } from '../harness/loop.mjs';
import { collectRuns, summarize, alerts, renderHtml } from '../stats.mjs';

const tempDir = (files = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aipass-stats-'));
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  return dir;
};

test('a finished run leaves one run_stats line with per-tool refusals', async () => {
  const dir = tempDir({ 'a.txt': 'hello\n' });
  const store = new SessionStore(path.join(dir, 'sessions'));
  const session = store.create({ root: dir, model: 'test-model' });
  const tools = createTools({ root: dir, overlay: new Overlay(dir) });

  const replies = [
    'Looking.\n\nNEED file nope.txt\nNEED file a.txt',
    'DONE read what there was',
  ];
  let turn = 0;
  const bridge = {
    model: 'test-model',
    async chat() { return { text: replies[Math.min(turn++, replies.length - 1)], reasoning: '' }; },
    async quota() { return { available: 1000 }; },
  };

  const result = await runTask('read the project', {
    bridge, tools, overlay: new Overlay(dir), session,
    options: { maxSteps: 5 },
    first: true,
  });

  assert.equal(result.stopReason, 'done');
  const stat = session.entries.find((e) => e.type === 'run_stats');
  assert.ok(stat, 'the run_stats line is in the session');
  assert.equal(stat.stopReason, 'done');
  assert.equal(stat.steps, 2);
  assert.deepEqual(stat.tools.read, { n: 2, fail: 1 }, 'one read refused, one succeeded');
  assert.equal(stat.nudges, 0);
  assert.equal(stat.stagnations, 0, 'the run never repeated a step');
  assert.equal(stat.firewallNotes, 0);
  assert.equal(stat.spent, 0, 'quota did not move');
  assert.equal(stat.stepMs.length, 2, 'one timing per step');
  assert.equal(stat.model, 'test-model', 'the run names the model that produced it');
});

test('a nudge the model recovers from still counts in run_stats', async () => {
  // Live finding (2026-10-15): the counter was reset by any productive reply,
  // so a run that needed a correction and moved on reported `nudges: 0` — the
  // one line that exists to show protocol drift was hiding it.
  const dir = tempDir({ 'a.txt': 'hello\n' });
  const store = new SessionStore(path.join(dir, 'sessions'));
  const session = store.create({ root: dir, model: 'test-model' });
  const tools = createTools({ root: dir, overlay: new Overlay(dir) });

  const replies = [
    'The file looks fine to me.',          // no marker — nudge 1
    'Looking.\n\nNEED file a.txt',         // productive — the streak ends
    'DONE read what there was',
  ];
  let turn = 0;
  const sent = [];
  const bridge = {
    async chat({ message }) { sent.push(message); return { text: replies[Math.min(turn++, replies.length - 1)], reasoning: '' }; },
    async quota() { return { available: 1000 }; },
  };

  const result = await runTask('read the project', {
    bridge, tools, overlay: new Overlay(dir), session,
    options: { maxSteps: 5 },
    first: true,
  });

  assert.equal(result.stopReason, 'done');
  assert.equal(session.entries.find((e) => e.type === 'run_stats').nudges, 1, 'the correction is counted even though the run recovered');
  assert.match(sent[1], /a marker only counts when it starts its own line/, 'the nudge states the rule the reply broke');
  assert.match(sent[2], /wire spellings/, 'every turn after the first carries the wire note');
});

test('collectRuns and summarize aggregate sessions the reader can print', () => {
  const dir = tempDir();
  const store = new SessionStore(path.join(dir, 'sessions'));
  const one = store.create({ root: dir, title: 'one' });
  one.append('run_stats', {
    stopReason: 'done', steps: 3, model: 'm-a',
    tools: { read: { n: 4, fail: 1 }, replace: { n: 1, fail: 0 } },
    nudges: 1, stagnations: 1, firewallNotes: 2, stepMs: [100, 200], spent: 5,
  });
  const otherRoot = tempDir({ 'b.txt': 'other project\n' });
  const two = store.create({ root: otherRoot, title: 'two' });
  two.append('run_stats', {
    stopReason: 'steps', steps: 10, model: 'm-b',
    tools: { read: { n: 9, fail: 0 } },
    nudges: 0, firewallNotes: 0, stepMs: [300], spent: 2,
  });

  const rows = [...collectRuns(one), ...collectRuns(two)];
  assert.equal(rows.length, 2);
  assert.equal(rows[0].refusalRate.toFixed(2), '0.20');

  const totals = summarize(rows);
  assert.equal(totals.runs, 2);
  assert.equal(totals.calls, 14);
  assert.equal(totals.refusals, 1);
  assert.equal(totals.nudges, 1);
  assert.equal(totals.stagnations, 1);
  assert.equal(totals.firewallNotes, 2);
  assert.equal(totals.spent, 7);
  assert.equal(totals.byTool.read.n, 13);
  assert.equal(totals.byTool.read.fail, 1);
  assert.equal(totals.byStop.done, 1);
  assert.equal(totals.byStop.steps, 1);
  // The reliability report groups by the model and the project — one line per
  // group, so a drifting model or workflow is not hidden inside a blend.
  assert.equal(rows[0].model, 'm-a');
  assert.equal(totals.byModel['m-a'].runs, 1);
  assert.equal(totals.byModel['m-a'].calls, 5);
  assert.equal(totals.byModel['m-a'].refusals, 1);
  assert.equal(totals.byModel['m-a'].spent, 5);
  assert.equal(totals.byModel['m-b'].runs, 1);
  assert.equal(Object.keys(totals.byModel).length, 2, 'grouped by the model that ran');
  assert.equal(totals.byRoot[dir].runs, 1);
  assert.equal(totals.byRoot[otherRoot].runs, 1, 'grouped by the project root');
  assert.equal(totals.byRoot[dir].spent, 5);
});

test('a run whose session recorded no model either lands in the unrecorded group, not nowhere', () => {
  // The last resort: when neither the run nor its session recorded a model,
  // the row still reports — under an explicit "(unrecorded)" key, so the mix
  // is visible instead of implied.
  const dir = tempDir();
  const store = new SessionStore(path.join(dir, 'sessions'));
  const s = store.create({ root: dir, title: 'old build' });
  s.append('run_stats', { stopReason: 'done', steps: 1, tools: {}, stepMs: [], spent: 0 });

  const totals = summarize(collectRuns(s));
  assert.equal(totals.byModel['(unrecorded)'].runs, 1);
});

test('a run without its own model falls back to the session model it started on', () => {
  // Older builds wrote `run_stats` before it carried `model`; the session
  // header still names the model the run started on, so the grouping keeps
  // the history attributable instead of blending it into "(unrecorded)".
  const dir = tempDir();
  const store = new SessionStore(path.join(dir, 'sessions'));
  const s = store.create({ root: dir, model: 'session-m', title: 'old build, named model' });
  s.append('run_stats', { stopReason: 'done', steps: 1, tools: {}, stepMs: [], spent: 0 });
  s.append('run_stats', { stopReason: 'done', steps: 1, model: 'run-m', tools: {}, stepMs: [], spent: 0 });

  const rows = collectRuns(s);
  assert.equal(rows[0].model, 'session-m', 'no model of its own — the session names it');
  assert.equal(rows[1].model, 'run-m', 'a model on the run itself always wins');
  const totals = summarize(rows);
  assert.equal(totals.byModel['session-m'].runs, 1);
  assert.equal(totals.byModel['run-m'].runs, 1);
  assert.equal(totals.byModel['(unrecorded)'], undefined, 'nothing needs the last-resort bucket');
});

/* The pull-based alerts and the self-contained report page. ----------------- */

/** A synthetic row with exactly the fields alerts()/renderHtml() read. */
const fakeRow = (over = {}) => ({
  ts: Date.UTC(2026, 9, 17), title: 'a task', stopReason: 'done',
  calls: 10, refusals: 0, refusalRate: 0, nudges: 0, stagnations: 0, verifyPrompts: 0,
  repeatBlocks: 0, langPrompts: 0, repeatedResults: 0, checks: 0, checkVerdict: null,
  firewallNotes: 0, stepMs: [], spent: null, tools: {},
  ...over,
});

test('a refusal-heavy window warns, a clean window does not', () => {
  const dirty = Array.from({ length: 12 }, () => fakeRow({ refusals: 5, refusalRate: 0.5 }));
  const warned = alerts(dirty);
  assert.equal(warned.length, 1);
  assert.equal(warned[0].level, 'warn');
  assert.match(warned[0].text, /refusal rate 50%/);

  const clean = Array.from({ length: 12 }, () => fakeRow({ refusals: 1, refusalRate: 0.1 }));
  assert.deepEqual(alerts(clean), []);
});

test('a small sample is left alone — two bad runs are not a trend', () => {
  const few = Array.from({ length: 5 }, () => fakeRow({ refusals: 10, refusalRate: 1 }));
  assert.deepEqual(alerts(few), []);
});

test('guard-trip share and a cost outlier each warn; firewall notes inform', () => {
  const tripping = Array.from({ length: 12 }, (_, i) => fakeRow({ stopReason: i < 4 ? 'stalled' : 'done' }));
  assert.match(alerts(tripping)[0].text, /4 of 12 runs ended stalled/);

  const spends = [1, 1, 1, 1, 100].map((spent) => fakeRow({ spent }));
  assert.match(alerts(spends)[0].text, /cost outlier: a run spent 100 credits/);

  const edge = Array.from({ length: 12 }, () => fakeRow({ firewallNotes: 2 }));
  const firewalled = alerts(edge);
  assert.equal(firewalled.length, 1);
  assert.equal(firewalled[0].level, 'info', 'an info line never fails a strict run');
  assert.match(firewalled[0].text, /24 firewall note/);
});

test('the report page carries the table, the alerts and escaped text', () => {
  const rows = [
    fakeRow({ title: '<script>alert(1)</script>', stopReason: 'done', refusals: 5, refusalRate: 0.5, checks: 1, checkVerdict: 'pass', spent: 3 }),
    ...Array.from({ length: 11 }, () => fakeRow({ refusals: 5, refusalRate: 0.5, firewallNotes: 1 })),
  ];
  const html = renderHtml({ rows, last: 50 });
  assert.match(html, /<table>/);
  assert.match(html, /aipass run report/);
  assert.match(html, /refusal rate 50%/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/, 'a task title is text, never markup');
  assert.equal(html.includes('<script>'), false);
});
