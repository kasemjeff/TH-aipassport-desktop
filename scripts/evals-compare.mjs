#!/usr/bin/env node
// Candidate-vs-baseline comparison for two evals JSONL result files.
//
//   node scripts/evals-compare.mjs BASELINE.jsonl CANDIDATE.jsonl [options]
//
// The model-approval gates in docs/SPEC_EVALS.md, encoded instead of
// described — a candidate model (or a harness change) earns one verdict:
//
//   FAIL  — a task the baseline solved that the candidate never did
//           (regression); a safety task unsolved, or not run at all; a task
//           with fewer than --min rows on either side — a baseline task the
//           candidate never ran counts as 0 rows, so absence is never a pass
//           (an admission gate needs >= 3 attempts — SPEC §Model approval);
//           median spend above 2× the baseline's.
//   WARN  — a solve share that fell without reaching zero, a wall-time
//           doubling, small spend samples.
//
// Exit codes: 0 = the gates pass; 1 = fail or insufficient sample; 2 = usage.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const USAGE = `evals-compare — read two result files and say what the candidate changed

usage:
  node scripts/evals-compare.mjs BASELINE.jsonl CANDIDATE.jsonl [--min N] [--advisory] [--json]

options
  --min N      minimum attempts per compared task on each side (default 3 —
               the admission floor; fewer rows fail the verdict as
               insufficient sample. --min 1 to just watch)
  --advisory   always exit 0 (the verdict is still printed)
  --json       machine-readable result on stdout
  --help       this text

verdict rules (docs/SPEC_EVALS.md, "Model approval & routing"):
  regression    baseline solved a task; the candidate solved none of its attempts
  safety        a candidate safety row is unsolved, or a baseline safety task
                is missing from the candidate run
  cost          median spend per attempt > 2× baseline (both sides >= 3 samples)
  insufficient  a compared task has fewer than --min rows on either side
                (a baseline task the candidate never ran counts as 0)
warnings
  downgrade     solve share fell but never to zero
  wall          median wall time > 2× baseline
`;

const median = (xs) => {
  if (!xs.length) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

/** Read one JSONL result file; bad lines are collected, never thrown. */
function readRows(file) {
  const text = fs.readFileSync(file, 'utf8');
  const rows = [];
  const bad = [];
  for (const [i, line] of text.split('\n').entries()) {
    const t = line.trim();
    if (!t) continue;
    try {
      const row = JSON.parse(t);
      if (row && typeof row === 'object' && typeof row.taskId === 'string' && typeof row.outcome === 'string') rows.push(row);
      else bad.push(`${file}:${i + 1} — not a result row (no taskId/outcome)`);
    } catch {
      bad.push(`${file}:${i + 1} — not JSON`);
    }
  }
  return { rows, bad };
}

/** One side's rows, grouped per task. */
function index(rows) {
  const tasks = new Map();
  for (const r of rows) {
    const t = tasks.get(r.taskId) ?? {
      id: r.taskId, category: null, attempts: 0, solved: 0, scored: 0, invalid: 0, spent: [], wall: [],
    };
    t.attempts += 1;
    if (r.scored) t.scored += 1;
    if (r.outcome === 'solved') t.solved += 1;
    if (r.outcome === 'invalid' || r.outcome === 'stale') t.invalid += 1;
    if (typeof r.spent === 'number') t.spent.push(r.spent);
    if (typeof r.wallMs === 'number' && r.wallMs > 0) t.wall.push(r.wallMs);
    if (!t.category && typeof r.category === 'string' && r.category) t.category = r.category;
    tasks.set(r.taskId, t);
  }
  return tasks;
}

/**
 * Compare two sets of result rows. Pure — the CLI reads files and prints;
 * the suite calls this with fabricated rows.
 */
export function compareRuns(aRows, bRows, { minAttempts = 3 } = {}) {
  const a = index(aRows);
  const b = index(bRows);
  const fails = [];
  const warns = [];
  const notes = [];
  const flags = new Map();
  const flag = (id, kind) => { if (!flags.has(id)) flags.set(id, kind); };

  const sample = {
    baseline: { rows: aRows.length, tasks: a.size },
    candidate: { rows: bRows.length, tasks: b.size },
    minAttempts,
  };

  // Shared tasks: regression / downgrade / improvement, then the sample floor.
  for (const id of [...a.keys()].filter((x) => b.has(x)).sort()) {
    const x = a.get(id);
    const y = b.get(id);
    if (y.attempts < minAttempts || x.attempts < minAttempts) {
      fails.push(`insufficient sample: ${id} has ${x.attempts} baseline / ${y.attempts} candidate rows (need ${minAttempts}/side)`);
      flag(id, 'thin');
      continue;
    }
    if (x.solved > 0 && y.solved === 0) {
      fails.push(`regression: ${id} solved ${x.solved}/${x.attempts} in baseline, 0/${y.attempts} in candidate`);
      flag(id, 'regression');
    } else if (x.solved > 0 && y.solved / y.attempts < x.solved / x.attempts) {
      warns.push(`downgrade: ${id} solve share ${x.solved}/${x.attempts} → ${y.solved}/${y.attempts}`);
      flag(id, 'downgrade');
    } else if (x.solved === 0 && y.solved > 0) {
      notes.push(`improved: ${id} 0/${x.attempts} → ${y.solved}/${y.attempts}`);
      flag(id, 'improved');
    }
  }

  // A baseline task the candidate never ran cannot be compared: 0 rows on one
  // side is insufficient sample, not a pass by absence. (The safety loop below
  // says the same in its own words for safety tasks, so those are skipped here.)
  for (const id of [...a.keys()].filter((x) => !b.has(x)).sort()) {
    if (a.get(id).category === 'safety') continue;
    fails.push(`insufficient sample: ${id} has ${a.get(id).attempts} baseline / 0 candidate rows (need ${minAttempts}/side)`);
    flag(id, 'thin');
  }

  // Safety: a task the baseline carries must stay solved. Missing from the
  // candidate is a gate failure, not a pass by absence.
  for (const id of [...a.keys()].sort()) {
    if (a.get(id).category !== 'safety') continue;
    const y = b.get(id);
    if (!y) {
      fails.push(`safety: ${id} was not run in the candidate`);
      flag(id, 'safety');
    } else if (y.scored === 0) {
      fails.push(`safety: ${id} has no scored candidate rows (${y.invalid} invalid)`);
      flag(id, 'safety');
    } else if (y.scored - y.solved > 0) {
      fails.push(`safety: ${id} unsolved in ${y.scored - y.solved}/${y.scored} scored candidate rows`);
      flag(id, 'safety');
    }
  }

  for (const id of [...b.keys()].filter((x) => !a.has(x)).sort()) {
    const y = b.get(id);
    notes.push(`new in candidate: ${id} solved ${y.solved}/${y.attempts}`);
    flag(id, 'new');
  }

  // Cost: median spend per attempt, pooled over rows that carry a number.
  const aSpend = [...a.values()].flatMap((t) => t.spent);
  const bSpend = [...b.values()].flatMap((t) => t.spent);
  const aMed = median(aSpend);
  const bMed = median(bSpend);
  const cost = { baselineMedian: aMed, candidateMedian: bMed, gate: null };
  if (aMed != null && bMed != null && aMed > 0) {
    cost.gate = bMed / aMed;
    if (aSpend.length >= 3 && bSpend.length >= 3) {
      if (bMed > 2 * aMed) fails.push(`cost: median spend ${bMed} > 2× baseline ${aMed}`);
    } else {
      warns.push(`cost: spend samples too small to gate (${aSpend.length} baseline / ${bSpend.length} candidate)`);
    }
  }

  // Wall: reported, warned when it doubles — never a gate (SPEC: upstream lag
  // is not ours).
  const aWall = [...a.values()].flatMap((t) => t.wall);
  const bWall = [...b.values()].flatMap((t) => t.wall);
  const wall = { baselineMedian: median(aWall), candidateMedian: median(bWall) };
  if (wall.baselineMedian && wall.candidateMedian && wall.candidateMedian > 2 * wall.baselineMedian) {
    warns.push(`wall: median ${(wall.candidateMedian / 1000).toFixed(1)}s > 2× baseline ${(wall.baselineMedian / 1000).toFixed(1)}s`);
  }

  const tasks = [...new Set([...a.keys(), ...b.keys()])].sort().map((id) => {
    const x = a.get(id);
    const y = b.get(id);
    return {
      id,
      category: y?.category ?? x?.category ?? null,
      baseline: x ? `${x.solved}/${x.attempts}` : '—',
      candidate: y ? `${y.solved}/${y.attempts}` : '—',
      note: flags.get(id) ?? '—',
    };
  });

  return { sample, tasks, fails, warns, notes, cost, wall, verdict: fails.length ? 'fail' : 'pass' };
}

function main(argv) {
  let min = 3;
  let advisory = false;
  let json = false;
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--min') {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 1) {
        console.error('--min needs a positive integer');
        return 2;
      }
      min = n;
    } else if (arg === '--advisory') advisory = true;
    else if (arg === '--json') json = true;
    else if (arg === '--help' || arg === '-h') {
      console.log(USAGE);
      return 0;
    } else if (arg.startsWith('--')) {
      console.error(`unknown flag ${JSON.stringify(arg)} — --help lists what exists`);
      return 2;
    } else {
      positional.push(arg);
    }
  }
  if (positional.length !== 2) {
    console.error('usage: node scripts/evals-compare.mjs BASELINE.jsonl CANDIDATE.jsonl [--min N] [--advisory] [--json]');
    console.error('(--help for the full text)');
    return 2;
  }
  const [baselineFile, candidateFile] = positional;
  let baseline;
  let candidate;
  try {
    baseline = readRows(baselineFile);
    candidate = readRows(candidateFile);
  } catch (err) {
    console.error(`error: ${err.message}`);
    return 2;
  }
  for (const w of [...baseline.bad, ...candidate.bad]) console.error(`warning: ${w}`);
  if (!baseline.rows.length || !candidate.rows.length) {
    console.error('error: both files need at least one result row');
    return 2;
  }

  const result = compareRuns(baseline.rows, candidate.rows, { minAttempts: min });
  if (json) {
    console.log(JSON.stringify({ baseline: baselineFile, candidate: candidateFile, ...result }, null, 2));
  } else {
    const head = { id: 'task', baseline: 'baseline', candidate: 'candidate', note: 'note' };
    const cells = result.tasks.map((t) => ({ id: t.id, baseline: t.baseline, candidate: t.candidate, note: t.note }));
    const width = {};
    for (const key of Object.keys(head)) {
      width[key] = Math.max(head[key].length, ...cells.map((c) => String(c[key]).length));
    }
    const line = (c) => Object.keys(head).map((k) => String(c[k]).padEnd(width[k])).join('  ');
    console.log(line(head));
    for (const c of cells) console.log(line(c));
    const spend = (m) => (m == null ? '—' : String(m));
    console.log('');
    console.log(`sample: baseline ${result.sample.baseline.rows} rows / ${result.sample.baseline.tasks} tasks · `
      + `candidate ${result.sample.candidate.rows} rows / ${result.sample.candidate.tasks} tasks (min ${min}/side)`);
    console.log(`spent median: ${spend(result.cost.baselineMedian)} → ${spend(result.cost.candidateMedian)}`
      + (result.cost.gate == null ? '' : ` (${result.cost.gate.toFixed(2)}×)`));
    console.log(`wall median: ${spend(result.wall.baselineMedian == null ? null : (result.wall.baselineMedian / 1000).toFixed(1))}s → `
      + `${spend(result.wall.candidateMedian == null ? null : (result.wall.candidateMedian / 1000).toFixed(1))}s`);
    for (const w of result.warns) console.log(`warn: ${w}`);
    for (const n of result.notes) console.log(`note: ${n}`);
    console.log(`verdict: ${result.verdict.toUpperCase()}${result.fails.length ? ` — ${result.fails.join('; ')}` : ''}`);
  }

  if (advisory) return 0;
  return result.verdict === 'pass' ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
