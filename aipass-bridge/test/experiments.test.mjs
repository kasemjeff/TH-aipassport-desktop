// The experiment queue's self-tests (docs/EXPERIMENTS.md): the validator, the
// ordering rule, and the real committed queue — a seed that stops validating
// is a queue that stopped being true.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { QUEUE_FILE, queueOrder, validateQueue, validateRecord } from '../../scripts/experiments.mjs';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'experiments.mjs');

/** A complete record; each test subtracts exactly one thing. */
const base = (over = {}) => ({
  id: 'temp-experiment',
  title: 'A title',
  source: 'audit:2026-10-17',
  status: 'proposed',
  impact: 3,
  risk: 2,
  cost: 1,
  hypothesis: 'the hypothesis',
  baseline: 'the baseline',
  successCriteria: 'the criteria',
  stopRule: 'the stop rule',
  budget: { attempts: 3, maxSteps: 10, maxCredits: 5, wallMs: 600000 },
  ...over,
});

test('a complete record validates; each missing piece is named', () => {
  assert.deepEqual(validateRecord(base()), []);
  for (const key of ['title', 'hypothesis', 'baseline', 'successCriteria', 'stopRule']) {
    const problems = validateRecord(base({ [key]: '  ' }));
    assert.ok(problems.includes(`${key} is required`), `${key}: ${problems.join('; ')}`);
  }
  assert.match(validateRecord(base({ source: 'vibes' })).join('; '), /source must be one of/);
  assert.match(validateRecord(base({ status: 'paused' })).join('; '), /status must be one of/);
  assert.match(validateRecord(base({ impact: 6 })).join('; '), /impact must be an integer 1\.\.5/);
  assert.match(validateRecord(base({ budget: { attempts: 9, maxSteps: 0, maxCredits: -1, wallMs: 0 } })).join('; '), /attempts must be 1\.\.5/);
});

test('risk >= 4 needs mitigations; done/stopped need a result', () => {
  assert.match(validateRecord(base({ risk: 4 })).join('; '), /mitigations/);
  assert.deepEqual(validateRecord(base({ risk: 4, mitigations: 'sandboxed arm, budget-capped' })), []);
  assert.match(validateRecord(base({ status: 'done' })).join('; '), /needs a result/);
  assert.deepEqual(validateRecord(base({ status: 'done', result: 'evals/results/x.jsonl — gate passed' })), []);
  assert.deepEqual(validateRecord(base({ status: 'running' })), []);
});

test('the queue orders by 2×impact − risk − cost, ties by impact then id', () => {
  const ordered = queueOrder([
    base({ id: 'low', impact: 1, risk: 5, cost: 5 }),
    base({ id: 'high', impact: 4, risk: 1, cost: 1 }),
    base({ id: 'tie-b', impact: 3, risk: 1, cost: 1 }),
    base({ id: 'tie-a', impact: 3, risk: 1, cost: 1 }),
    base({ id: 'cheap-low', impact: 3, risk: 2, cost: 0 }),
  ]);
  assert.deepEqual(ordered.map((r) => r.id), ['high', 'cheap-low', 'tie-a', 'tie-b', 'low']);
});

test('duplicate ids and non-arrays fail the queue', () => {
  assert.match(validateQueue([base(), base()]).problems.join('; '), /duplicate id/);
  assert.deepEqual(validateQueue({}).problems, ['queue must be a JSON array']);
});

test('the committed queue validates and seeds the open questions', () => {
  const records = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'));
  const { problems } = validateQueue(records);
  assert.deepEqual(problems, []);
  assert.ok(records.length >= 5, `expected a seeded queue, got ${records.length}`);
  const ids = records.map((r) => r.id);
  for (const id of ['mixed-model-routing', 'memory-cold-warm', 'memory-tier-carry', 'safety-twin-controls', 'best-of-n-selection', 'elision-tier', 'attempts-floor']) {
    assert.ok(ids.includes(id), `queue is missing ${id}`);
  }
  assert.ok(records.every((r) => r.status === 'proposed' || r.status === 'running' || r.result),
    'every closed record carries its result');
});

test('the CLI validates, prints, and names problems (exit codes 0/1/2)', () => {
  const ok = spawnSync(process.execPath, [SCRIPT, '--check'], { encoding: 'utf8', windowsHide: true });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /experiments: OK/);

  const listing = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', windowsHide: true });
  assert.equal(listing.status, 0, listing.stderr);
  assert.match(listing.stdout, /next: safety-twin-controls/);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aipass-experiments-'));
  try {
    const bad = path.join(dir, 'queue.json');
    fs.writeFileSync(bad, JSON.stringify([base({ hypothesis: '' })]));
    const fail = spawnSync(process.execPath, [SCRIPT, '--file', bad], { encoding: 'utf8', windowsHide: true });
    assert.equal(fail.status, 1);
    assert.match(fail.stderr, /hypothesis is required/);

    const noFile = spawnSync(process.execPath, [SCRIPT, '--file', path.join(dir, 'nope.json')], { encoding: 'utf8', windowsHide: true });
    assert.equal(noFile.status, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('--json emits the ordered queue as valid JSON; an unknown flag exits 2', () => {
  const json = spawnSync(process.execPath, [SCRIPT, '--json'], { encoding: 'utf8', windowsHide: true });
  assert.equal(json.status, 0, json.stderr);
  const parsed = JSON.parse(json.stdout);
  assert.ok(Array.isArray(parsed.queue) && parsed.queue.length >= 5);
  assert.equal(parsed.queue.length,
    Object.values(parsed.summary).reduce((a, n) => a + n, 0), 'every record is in the print');
  const score = (r) => r.impact * 2 - r.risk - r.cost;
  const sortCmp = (a, b) => (score(b) - score(a)) || (b.impact - a.impact) || String(a.id).localeCompare(String(b.id));
  for (let i = 1; i < parsed.queue.length; i++) {
    assert.ok(sortCmp(parsed.queue[i - 1], parsed.queue[i]) <= 0, `queue[${i}] is out of order`);
  }

  const unknown = spawnSync(process.execPath, [SCRIPT, '--bogus'], { encoding: 'utf8', windowsHide: true });
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /unknown flag/);
});
