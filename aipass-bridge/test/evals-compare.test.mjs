// The candidate-vs-baseline comparator's self-tests (docs/SPEC_EVALS.md §6
// family). Everything is fabricated rows — no live run, no network, no
// fixture: the gate arithmetic is what is under test.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { compareRuns } from '../../scripts/evals-compare.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(HERE, '..', '..', 'scripts', 'evals-compare.mjs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aipass-evals-compare-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

/** One result row, the shape evals.mjs writes (only the fields under test). */
const row = (taskId, outcome, extra = {}) => ({
  taskId,
  outcome,
  scored: outcome === 'solved' || outcome === 'unsolved',
  spent: 1,
  wallMs: 1000,
  ...extra,
});

/** N rows of one task with per-index outcomes. */
const attemptRows = (taskId, outcomes, extra = {}) =>
  outcomes.map((o) => row(taskId, o, typeof extra === 'function' ? extra() : extra));

const solvedTriple = (id, extra) => attemptRows(id, ['solved', 'solved', 'solved'], extra);
const unsolvedTriple = (id, extra) => attemptRows(id, ['unsolved', 'unsolved', 'unsolved'], extra);

test('a candidate that holds the line passes, and improvements are notes', () => {
  const base = [...solvedTriple('math-fix'), ...unsolvedTriple('fix-year'), ...solvedTriple('refuse-secret', { category: 'safety' })];
  const cand = [...solvedTriple('math-fix'), ...solvedTriple('fix-year'), ...solvedTriple('refuse-secret', { category: 'safety' })];
  const out = compareRuns(base, cand);
  assert.equal(out.verdict, 'pass');
  assert.deepEqual(out.fails, []);
  assert.ok(out.notes.some((n) => /improved: fix-year/.test(n)), out.notes.join('\n'));
  assert.equal(out.tasks.find((t) => t.id === 'fix-year').note, 'improved');
});

test('a task solved in baseline and never in the candidate is a regression', () => {
  const out = compareRuns(solvedTriple('math-fix'), unsolvedTriple('math-fix'));
  assert.equal(out.verdict, 'fail');
  assert.ok(out.fails.some((f) => /regression: math-fix/.test(f)), out.fails.join('\n'));
  assert.equal(out.tasks[0].note, 'regression');
});

test('a partial drop warns, never gates', () => {
  const out = compareRuns(solvedTriple('math-fix'), attemptRows('math-fix', ['solved', 'unsolved', 'unsolved']));
  assert.equal(out.verdict, 'pass');
  assert.ok(out.warns.some((w) => /downgrade: math-fix/.test(w)), out.warns.join('\n'));
});

test('the safety set gates: an unsolved or missing task fails the candidate', () => {
  const base = solvedTriple('refuse-run-leak', { category: 'safety' });
  const unsolved = compareRuns(base, attemptRows('refuse-run-leak', ['solved', 'unsolved', 'unsolved'], { category: 'safety' }));
  assert.equal(unsolved.verdict, 'fail');
  assert.ok(unsolved.fails.some((f) => /safety: refuse-run-leak unsolved in 2\/3/.test(f)), unsolved.fails.join('\n'));

  const missing = compareRuns(base, solvedTriple('math-fix'));
  assert.equal(missing.verdict, 'fail');
  assert.ok(missing.fails.some((f) => /safety: refuse-run-leak was not run/.test(f)), missing.fails.join('\n'));
});

test('cost: 3× median spend fails; a spend sample under three only warns', () => {
  const base = solvedTriple('math-fix', { spent: 1 });
  const pricey = compareRuns(base, solvedTriple('math-fix', { spent: 3 }));
  assert.equal(pricey.verdict, 'fail');
  assert.ok(pricey.fails.some((f) => /cost: median spend 3 > 2× baseline 1/.test(f)), pricey.fails.join('\n'));

  const thin = compareRuns(
    solvedTriple('math-fix', { spent: 1 }).slice(0, 2),
    solvedTriple('math-fix', { spent: 3 }).slice(0, 2),
    { minAttempts: 1 },
  );
  assert.equal(thin.verdict, 'pass');
  assert.ok(thin.warns.some((w) => /cost: spend samples too small/.test(w)), thin.warns.join('\n'));
});

test('the attempt floor: one row per side is insufficient for a gate by default', () => {
  const out = compareRuns(solvedTriple('math-fix').slice(0, 1), solvedTriple('math-fix').slice(0, 1));
  assert.equal(out.verdict, 'fail');
  assert.ok(out.fails.some((f) => /insufficient sample: math-fix has 1 baseline \/ 1 candidate/.test(f)), out.fails.join('\n'));

  const watching = compareRuns(solvedTriple('math-fix').slice(0, 1), solvedTriple('math-fix').slice(0, 1), { minAttempts: 1 });
  assert.equal(watching.verdict, 'pass');
});

test('the CLI reads two files, exits 1 on a regression and 0 with --advisory', () => {
  const a = path.join(TMP, 'baseline.jsonl');
  const b = path.join(TMP, 'candidate.jsonl');
  fs.writeFileSync(a, solvedTriple('math-fix').map((r) => JSON.stringify(r)).join('\n') + '\n');
  fs.writeFileSync(b, unsolvedTriple('math-fix').map((r) => JSON.stringify(r)).join('\n') + '\n');

  const gate = spawnSync(process.execPath, [SCRIPT, a, b], { encoding: 'utf8', windowsHide: true });
  assert.equal(gate.status, 1, gate.stderr);
  assert.match(gate.stdout, /verdict: FAIL/);
  assert.match(gate.stdout, /regression: math-fix/);
  assert.match(gate.stdout, /sample: baseline 3 rows/);

  const advisory = spawnSync(process.execPath, [SCRIPT, a, b, '--advisory', '--json'], { encoding: 'utf8', windowsHide: true });
  assert.equal(advisory.status, 0, advisory.stderr);
  const parsed = JSON.parse(advisory.stdout);
  assert.equal(parsed.verdict, 'fail');
  assert.equal(parsed.baseline, a, 'the JSON names the baseline file');
  assert.equal(parsed.candidate, b);
  assert.equal(parsed.sample.baseline.rows, 3, 'sample counts ride the JSON');
  assert.equal(parsed.sample.candidate.rows, 3);
  assert.ok('cost' in parsed && 'wall' in parsed && Array.isArray(parsed.tasks), 'the record has cost, wall and the task table');

  const usage = spawnSync(process.execPath, [SCRIPT, a], { encoding: 'utf8', windowsHide: true });
  assert.equal(usage.status, 2);
});

test('a task new in the candidate is a note, not a gate', () => {
  const base = solvedTriple('math-fix');
  const cand = [...solvedTriple('math-fix'), ...solvedTriple('refuse-run-leak', { category: 'safety' })];
  const out = compareRuns(base, cand);
  assert.equal(out.verdict, 'pass', out.fails.join('\n'));
  assert.ok(out.notes.some((n) => /new in candidate: refuse-run-leak solved 3\/3/.test(n)), out.notes.join('\n'));
  assert.equal(out.tasks.find((t) => t.id === 'refuse-run-leak').note, 'new');
});

test('a baseline task the candidate never ran is insufficient, never a silent pass', () => {
  const base = [...solvedTriple('math-fix'), ...solvedTriple('fix-year')];
  const cand = solvedTriple('math-fix');
  const out = compareRuns(base, cand);
  assert.equal(out.verdict, 'fail');
  assert.ok(out.fails.some((f) => /insufficient sample: fix-year has 3 baseline \/ 0 candidate rows/.test(f)), out.fails.join('\n'));
  assert.equal(out.tasks.find((t) => t.id === 'fix-year').note, 'thin');
});

test('doubled wall time warns, never gates', () => {
  const out = compareRuns(solvedTriple('math-fix', { wallMs: 1000 }), solvedTriple('math-fix', { wallMs: 3000 }));
  assert.equal(out.verdict, 'pass');
  assert.ok(out.warns.some((w) => /wall: median 3\.0s > 2× baseline 1\.0s/.test(w)), out.warns.join('\n'));
});

test('old-shape rows (no spend, no wall, no category) compare without a crash or a NaN', () => {
  // A pinned file from before the digest fields: no spent, no wallMs, no
  // category. The comparator must read it — old artifacts stay legible — and
  // report a missing number as null, never NaN.
  const old = (outcome) => [{ taskId: 'math-fix', outcome, scored: outcome !== 'invalid' }];
  const out = compareRuns(old('solved'), old('solved'));
  assert.equal(out.verdict, 'fail', 'one row a side is under the floor');
  assert.ok(out.fails.some((f) => /insufficient sample/.test(f)), out.fails.join('\n'));
  assert.equal(out.cost.baselineMedian, null);
  assert.equal(out.cost.candidateMedian, null);
  assert.equal(out.cost.gate, null);
  assert.equal(out.wall.baselineMedian, null);
  assert.ok(!JSON.stringify(out).includes('NaN'), 'a missing number is null, never NaN');
});
