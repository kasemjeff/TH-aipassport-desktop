#!/usr/bin/env node
// Repeatable retrieval benchmark: the same fixture sets the test asserts on,
// plus an optional real-repo run.
//
//   npm run bench:retrieval
//   npm run bench:retrieval -- --repo D:\aipass
//   npm run bench:retrieval -- --strict
//
// Paraphrase recall is expected to be low. This is a lexical index; the number
// is the evidence for the Phase 3 embedding work in docs/RAG_DESIGN.md, not a
// failure. --strict turns the exact/negative floors into an exit code for a
// release check; the CI test carries the same floors.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildIndex, retrieve } from '../aipass-bridge/harness/retrieval.mjs';
import { evaluate } from '../evals/retrieval/evaluate.mjs';

const argv = process.argv.slice(2);
const has = (name) => argv.includes(`--${name}`);
const flag = (name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? fallback : argv[at + 1];
};

if (has('help')) {
  console.log('usage: npm run bench:retrieval -- [--repo <path>] [--strict]');
  console.log('  --repo <path>  also score evals/retrieval/queries-real.json against that project');
  console.log('  --strict       exit 1 when the exact or negative floor is missed');
  process.exit(0);
}

const EVALS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'evals', 'retrieval');
const load = (name) => JSON.parse(fs.readFileSync(path.join(EVALS, name), 'utf8'));
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aipass-retrieval-bench-home-'));
process.env.AIPASS_HOME = HOME;
const scratch = [];
const pct = (n) => `${(n * 100).toFixed(1)}%`;
const ms = (n) => `${n.toFixed(0)}ms`;

async function report(label, dir, file, opts = {}) {
  const queries = load(file);
  const result = await evaluate(dir, queries, opts);
  const suffix = opts.requireAll ? '' : ` (any-match ${pct(result.anyRecall)})`;
  console.log(`${label}: ${result.total} queries, recall@8 ${pct(result.recall)}, MRR@8 ${result.mrr.toFixed(3)}${suffix}`);
  for (const miss of result.misses) {
    console.log(`  miss: ${miss.q} -> expected ${miss.expect.join(', ')}; got ${miss.got.join(', ')}`);
  }
  return result;
}

/** The query set lives inside this repo; hide it from the corpus or it matches itself. */
function hideBenchmarkFiles(root) {
  const evalDir = path.join(root, 'evals', 'retrieval');
  if (!fs.existsSync(evalDir)) return null;
  const entries = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else entries.push([p, '\u0000DELETE\u0000']);
    }
  };
  walk(evalDir);
  return { entries: () => entries };
}

async function negatives(dir) {
  const queries = load('queries-negative.json');
  let hits = 0;
  for (const q of queries) {
    const res = await retrieve(q, { root: dir, limit: 8, budgetChars: 20000 });
    if (res.hits.length) {
      hits++;
      console.log(`  negative hit: "${q}" -> ${res.hits.map((h) => h.path).join(', ')}`);
    }
  }
  console.log(`negative: ${queries.length - hits}/${queries.length} queries returned no hits`);
  return hits === 0;
}

let strictFail = false;
try {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aipass-retrieval-bench-'));
  scratch.push(dir);
  fs.cpSync(path.join(EVALS, 'tree'), dir, { recursive: true });
  let started = performance.now();
  const built = await buildIndex(dir);
  console.log(`fixture: ${built.stats.files} files, ${built.stats.chunks} chunks, built in ${ms(performance.now() - started)}`);

  const exact = await report('exact', dir, 'queries-exact.json', { requireAll: true });
  await report('paraphrase', dir, 'queries-paraphrase.json');
  const noNegatives = await negatives(dir);
  strictFail = exact.recall < 0.9 || exact.mrr < 0.8 || !noNegatives;

  const repo = flag('repo', null);
  if (repo) {
    const root = path.resolve(repo);
    if (!fs.existsSync(root)) {
      console.error(`repo: ${root} does not exist`);
      process.exitCode = 2;
    } else {
      started = performance.now();
      const cold = await buildIndex(root);
      console.log(`repo: ${cold.stats.files} files, ${cold.stats.chunks} chunks, cold build ${ms(performance.now() - started)}`);
      started = performance.now();
      const inc = await buildIndex(root);
      console.log(`repo: incremental ${ms(performance.now() - started)} (read ${inc.stats.read}, reused ${inc.stats.reused})`);
      const overlay = hideBenchmarkFiles(root);
      await report('real', root, 'queries-real.json', { overlay });

      const times = [];
      const real = load('queries-real.json');
      for (let round = 0; round < 3; round++) {
        for (const q of real) {
          const t = performance.now();
          await retrieve(q.q, { root, limit: 8, budgetChars: 20000, overlay });
          times.push(performance.now() - t);
        }
      }
      times.sort((a, b) => a - b);
      const pick = (p) => times[Math.min(times.length - 1, Math.floor(p * times.length))];
      console.log(`repo: query p50 ${ms(pick(0.5))}, p95 ${ms(pick(0.95))}`);
    }
  }
} finally {
  for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(HOME, { recursive: true, force: true });
  if (strictFail) {
    console.error('benchmark floor missed');
    process.exitCode = 1;
  }
}
