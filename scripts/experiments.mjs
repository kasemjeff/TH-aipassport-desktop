#!/usr/bin/env node
// The experiment queue: what this project is allowed to try next, why, and
// when it must stop. The contract — fields, ordering, budgets, the end of an
// experiment — is docs/EXPERIMENTS.md.
//
//   npm run experiments            # validate the queue and print it in order
//   npm run experiments -- --check # validate only, summary line (CI-shaped)
//   npm run experiments -- --json  # machine-readable
//   npm run experiments -- --file PATH   (tests and scratch queues)
//
// A record is valid when the template is complete (source, hypothesis,
// baseline, success criteria, budget, stop rule) and the discipline holds:
// risk >= 4 needs written mitigations before it may run; a done/stopped
// experiment must carry its result — an experiment that ended silently is a
// re-run waiting to happen. Exit 0 only when the whole queue validates.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const QUEUE_FILE = path.join(ROOT, 'experiments', 'queue.json');
const STATUSES = ['proposed', 'running', 'done', 'stopped'];
const SOURCE_KINDS = ['audit', 'alert', 'regression', 'research'];

/** Validate one record (SPEC-EXPERIMENTS §Record). Returns field-named problems. */
export function validateRecord(rec, seenIds = new Set()) {
  const problems = [];
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return ['record is not an object'];
  const str = (key) => {
    if (typeof rec[key] !== 'string' || !rec[key].trim()) { problems.push(`${key} is required`); return false; }
    return true;
  };
  if (!/^[a-z0-9][a-z0-9-]*$/.test(String(rec.id ?? ''))) problems.push('id must be kebab-case');
  else if (seenIds.has(rec.id)) problems.push(`duplicate id ${rec.id}`);
  else seenIds.add(rec.id);
  str('title');
  str('hypothesis');
  str('baseline');
  str('successCriteria');
  str('stopRule');
  if (!SOURCE_KINDS.some((kind) => String(rec.source ?? '').startsWith(`${kind}:`))) {
    problems.push(`source must be one of ${SOURCE_KINDS.map((k) => `${k}:…`).join(', ')}`);
  }
  if (!STATUSES.includes(rec.status)) problems.push(`status must be one of ${STATUSES.join(' | ')}`);
  for (const key of ['impact', 'risk', 'cost']) {
    const n = rec[key];
    if (!Number.isInteger(n) || n < 1 || n > 5) problems.push(`${key} must be an integer 1..5`);
  }
  const budget = rec.budget;
  if (!budget || typeof budget !== 'object' || Array.isArray(budget)) problems.push('budget is required');
  else {
    if (!Number.isInteger(budget.attempts) || budget.attempts < 1 || budget.attempts > 5) problems.push('budget.attempts must be 1..5 (the eval runner ceiling)');
    if (!Number.isFinite(budget.maxSteps) || budget.maxSteps < 1) problems.push('budget.maxSteps must be >= 1');
    if (typeof budget.maxCredits !== 'number' || budget.maxCredits < 0) problems.push('budget.maxCredits must be >= 0 (0 = no cap)');
    if (typeof budget.wallMs !== 'number' || budget.wallMs <= 0) problems.push('budget.wallMs must be > 0');
  }
  if (rec.risk >= 4 && !(typeof rec.mitigations === 'string' && rec.mitigations.trim())) {
    problems.push('risk >= 4 needs mitigations written down before it runs');
  }
  if ((rec.status === 'done' || rec.status === 'stopped') && !(typeof rec.result === 'string' && rec.result.trim())) {
    problems.push(`status ${rec.status} needs a result (what happened, where it is on disk)`);
  }
  return problems;
}

/** score = 2×impact − risk − cost; bigger first, ties by impact then id. */
export function queueOrder(records) {
  const score = (r) => r.impact * 2 - r.risk - r.cost;
  return [...records].sort((a, b) => score(b) - score(a)
    || b.impact - a.impact
    || String(a.id).localeCompare(String(b.id)));
}

/** Validate a whole queue. `problems` empty means the file is usable. */
export function validateQueue(records) {
  if (!Array.isArray(records)) return { problems: ['queue must be a JSON array'], records: [] };
  const seen = new Set();
  const problems = [];
  for (const rec of records) {
    for (const p of validateRecord(rec, seen)) problems.push(`${rec?.id ?? '(no id)'}: ${p}`);
  }
  return { problems, records: records.filter((r) => r && typeof r === 'object') };
}

function readQueue(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(`cannot read ${file}: ${err.message}`);
  }
  try {
    return JSON.parse(raw.replace(/^\uFEFF/, ''));
  } catch (err) {
    throw new Error(`${file} is not valid JSON — ${err.message}`);
  }
}

const USAGE = `experiments — validate the experiment queue and print it in order

usage:
  npm run experiments [-- --check | --json | --file PATH]

options
  --check      validate only: one summary line, exit 1 on any invalid record
  --json       the validated queue, ordered, on stdout
  --file PATH  read a queue other than experiments/queue.json
  --help       this text

records are defined in docs/EXPERIMENTS.md; ordering is 2×impact − risk − cost.`;

function main(argv) {
  let check = false;
  let json = false;
  let file = QUEUE_FILE;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--check') check = true;
    else if (arg === '--json') json = true;
    else if (arg === '--file') {
      const next = argv[++i];
      if (!next) {
        console.error('--file needs a path');
        return 2;
      }
      file = path.resolve(next);
    } else if (arg === '--help' || arg === '-h') {
      console.log(USAGE);
      return 0;
    } else {
      console.error(`unknown flag ${JSON.stringify(arg)} — --help lists what exists`);
      return 2;
    }
  }

  let queue;
  try {
    queue = readQueue(file);
  } catch (err) {
    console.error(`error: ${err.message}`);
    return 2;
  }
  const { problems, records } = validateQueue(queue);
  if (problems.length) {
    for (const p of problems) console.error(`✖ ${p}`);
    console.error(`\nexperiments: FAIL (${problems.length} problem(s) in ${path.relative(ROOT, file)})`);
    return 1;
  }
  const ordered = queueOrder(records);
  const counts = Object.fromEntries(STATUSES.map((s) => [s, records.filter((r) => r.status === s).length]));
  const summary = `${records.length} records — ${STATUSES.map((s) => `${counts[s]} ${s}`).join(' · ')}`;

  if (json) {
    console.log(JSON.stringify({ file: path.relative(ROOT, file), summary: counts, queue: ordered }, null, 2));
    return 0;
  }
  if (check) {
    console.log(`experiments: OK — ${summary}`);
    return 0;
  }

  const head = { id: 'id', status: 'status', i: 'imp', r: 'risk', c: 'cost', score: 'score', title: 'title' };
  const cells = ordered.map((r) => ({
    id: r.id,
    status: r.status,
    i: String(r.impact),
    r: String(r.risk),
    c: String(r.cost),
    score: String(r.impact * 2 - r.risk - r.cost),
    title: r.title,
  }));
  const width = {};
  for (const key of Object.keys(head)) {
    width[key] = Math.max(head[key].length, ...cells.map((c) => String(c[key]).length));
  }
  const line = (c) => Object.keys(head).map((k) => String(c[k]).padEnd(width[k])).join('  ');
  console.log(line(head));
  for (const c of cells) console.log(line(c));
  console.log('');
  console.log(`queue: ${summary}`);
  const next = ordered.find((r) => r.status === 'proposed' || r.status === 'running');
  if (next) console.log(`next: ${next.id} (score ${next.impact * 2 - next.risk - next.cost}) — ${next.title}`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
