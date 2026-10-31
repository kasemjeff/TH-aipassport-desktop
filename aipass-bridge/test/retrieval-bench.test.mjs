import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildIndex, retrieve } from '../harness/retrieval.mjs';
import { evaluate } from '../../evals/retrieval/evaluate.mjs';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aipass-retrieval-bench-home-'));
process.env.AIPASS_HOME = HOME;
const EVALS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'evals', 'retrieval');

const dirs = [];
const tempDir = (files = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aipass-retrieval-bench-'));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    const p = path.join(dir, name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  return dir;
};

const fixture = () => {
  const dir = tempDir({});
  fs.cpSync(path.join(EVALS, 'tree'), dir, { recursive: true });
  return dir;
};

const load = (name) => JSON.parse(fs.readFileSync(path.join(EVALS, name), 'utf8'));

after(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(HOME, { recursive: true, force: true });
});

test('exact benchmark keeps every expected path in the top eight', async () => {
  const dir = fixture();
  await buildIndex(dir);
  const queries = load('queries-exact.json');
  const result = await evaluate(dir, queries, { requireAll: true });
  console.log('exact:', queries.length, 'queries, recall@8 =', result.recall.toFixed(3), 'MRR@8 =', result.mrr.toFixed(3));
  for (const miss of result.misses) console.log('  miss:', miss.q, 'expected', miss.expect.join(', '), 'got', miss.got.join(', '));
  assert.ok(result.recall >= 0.9, `exact recall@8 ${result.recall} < 0.9`);
  assert.ok(result.mrr >= 0.8, `exact MRR@8 ${result.mrr} < 0.8`);
});

test('paraphrase baseline is measured, not hidden', async () => {
  const dir = fixture();
  await buildIndex(dir);
  const queries = load('queries-paraphrase.json');
  const result = await evaluate(dir, queries);
  console.log('paraphrase:', queries.length, 'queries, recall@8 =', result.anyRecall.toFixed(3), 'MRR@8 =', result.mrr.toFixed(3));
  // The floor is a regression guard for the benchmark itself, not a claim
  // that lexical retrieval understands synonyms. Phase 3 is justified only
  // when this number is measured and low, which it is.
  assert.ok(result.anyRecall >= 0.1, `paraphrase recall@8 ${result.anyRecall} < 0.1`);
});

test('negative queries return no hits', async () => {
  const dir = fixture();
  await buildIndex(dir);
  const queries = load('queries-negative.json');
  for (const q of queries) {
    const res = await retrieve(q, { root: dir, limit: 8, budgetChars: 20000 });
    assert.equal(res.hits.length, 0, `"${q}" should not match the fixture`);
  }
});

test('default budget is respected', async () => {
  const dir = fixture();
  await buildIndex(dir);
  const res = await retrieve('refresh token', { root: dir });
  const total = res.hits.reduce((n, h) => n + h.excerpt.length + h.path.length + 20, 0);
  assert.ok(total <= 6000, 'default budget must be respected');
});
