// What a set of eval rows says, in numbers.
//
// The comparator in `scripts/evals-compare.mjs` decides pass or fail between
// two runs; this module is the other half — the reading a human (or the next
// optimizer) needs before and after a change: how many tasks are solved, what
// the safety set did, what it cost and how long it took.
//
// A note on the denominators, because they decide what a number means: a
// row that was INVALID (a 429, a wall kill, a stale replay) is not a failure
// — charging it as one would lie about the model. So every rate here is over
// SCORED rows, and the invalid count is reported beside it.
import fs from 'node:fs/promises';

const median = (xs) => {
  if (!xs.length) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

const isScored = (row) => row.scored !== false && row.outcome !== 'invalid' && row.outcome !== 'stale';

/** Every result row in a file. Bad lines are counted, never thrown. */
export async function readRows(file) {
  let text;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch {
    return { rows: [], bad: 0 };
  }
  const rows = [];
  let bad = 0;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const row = JSON.parse(trimmed);
      if (row && typeof row === 'object' && typeof row.taskId === 'string') rows.push(row);
      else bad += 1;
    } catch {
      bad += 1;
    }
  }
  return { rows, bad };
}

/**
 * The reading of one run's rows. `passAt1` is the share of scored tasks the
 * run solved on its first attempt — the number a harness change is judged on.
 */
export function scoreRows(rows = []) {
  const tasks = new Map();
  let invalid = 0;
  const spend = [];
  const wall = [];
  const tokens = [];

  for (const row of rows) {
    const id = row.taskId;
    const task = tasks.get(id) ?? { id, category: row.category ?? null, attempts: 0, scored: 0, solved: 0, invalid: 0 };
    task.attempts += 1;
    if (!isScored(row)) {
      task.invalid += 1;
      invalid += 1;
    } else {
      task.scored += 1;
      if (row.outcome === 'solved') task.solved += 1;
    }
    if (!task.category && typeof row.category === 'string' && row.category) task.category = row.category;
    tasks.set(id, task);
    if (typeof row.spent === 'number') spend.push(row.spent);
    if (typeof row.wallMs === 'number' && row.wallMs > 0) wall.push(row.wallMs);
    if (typeof row.tokensEst === 'number') tokens.push(row.tokensEst);
  }

  const list = [...tasks.values()].sort((a, b) => a.id.localeCompare(b.id));
  const safety = list.filter((t) => t.category === 'safety');
  const solvedTasks = list.filter((t) => t.solved > 0).length;
  const scoredTasks = list.filter((t) => t.scored > 0).length;
  const safetySolved = safety.filter((t) => t.solved > 0).length;
  const solvedWithTokens = tokens.length ? median(tokens) : null;

  return {
    rows: rows.length,
    tasks: list,
    passAt1: scoredTasks ? solvedTasks / scoredTasks : null,
    solvedTasks,
    scoredTasks,
    invalid,
    safety: {
      tasks: safety.length,
      solved: safetySolved,
      ok: safety.length > 0 ? safetySolved === safety.length : null,
    },
    spend: { median: median(spend), samples: spend.length },
    wall: { median: median(wall), samples: wall.length },
    tokens: { median: solvedWithTokens, samples: tokens.length },
  };
}

/** A one-line reading for a table. */
export function formatScore(score) {
  if (!score || !score.rows) return 'no rows';
  const pass = score.passAt1 == null ? '—' : `${Math.round(score.passAt1 * 100)}%`;
  const spend = score.spend.median == null ? '—' : String(score.spend.median);
  const wall = score.wall.median == null ? '—' : `${(score.wall.median / 1000).toFixed(1)}s`;
  const safety = score.safety.tasks ? `${score.safety.solved}/${score.safety.tasks}` : '—';
  return `pass@1 ${pass} (${score.solvedTasks}/${score.scoredTasks}) · safety ${safety} · spend ${spend} · wall ${wall}`;
}
