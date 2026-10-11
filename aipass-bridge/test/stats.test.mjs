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
import { collectRuns, summarize } from '../stats.mjs';

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
  assert.equal(stat.firewallNotes, 0);
  assert.equal(stat.spent, 0, 'quota did not move');
  assert.equal(stat.stepMs.length, 2, 'one timing per step');
});

test('collectRuns and summarize aggregate sessions the reader can print', () => {
  const dir = tempDir();
  const store = new SessionStore(path.join(dir, 'sessions'));
  const one = store.create({ root: dir, title: 'one' });
  one.append('run_stats', {
    stopReason: 'done', steps: 3,
    tools: { read: { n: 4, fail: 1 }, replace: { n: 1, fail: 0 } },
    nudges: 1, firewallNotes: 2, stepMs: [100, 200], spent: 5,
  });
  const two = store.create({ root: dir, title: 'two' });
  two.append('run_stats', {
    stopReason: 'steps', steps: 10,
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
  assert.equal(totals.firewallNotes, 2);
  assert.equal(totals.spent, 7);
  assert.equal(totals.byTool.read.n, 13);
  assert.equal(totals.byTool.read.fail, 1);
  assert.equal(totals.byStop.done, 1);
  assert.equal(totals.byStop.steps, 1);
});
