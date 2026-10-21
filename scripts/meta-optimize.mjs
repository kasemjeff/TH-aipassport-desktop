#!/usr/bin/env node
// meta-optimize — the loop that lets the harness tune itself.
//
// The instruments already exist: `scripts/evals.mjs` scores a run with a
// deterministic check, `scripts/evals-compare.mjs` compares two runs and
// exit-codes the verdict, and the session JSONL is the raw trace of every
// attempt. What was missing is the part that ties them together — the part
// that says WHICH part of the harness to change, shows the optimizer the
// evidence, measures the change against the same matrix, and rolls the change
// back when the score does not move.
//
// The shape is AHE's: one component at a time. A change is a single policy
// document; the other five stay byte-identical; the arms that measure it
// differ in exactly one file, and the command refuses to run when they do
// not.
//
// The evidence is raw. Meta-Harness's hard lesson is that the optimizer must
// read the trace itself, not a summary of it — so the brief quotes the
// transcript lines verbatim, with the file and line they came from, and the
// original stays where it was.
//
// usage:
//   node scripts/meta-optimize.mjs status
//   node scripts/meta-optimize.mjs brief <dimension> [--traces N]
//   node scripts/meta-optimize.mjs propose <dimension> --candidate FILE --hypothesis TEXT
//   node scripts/meta-optimize.mjs apply <id>
//   node scripts/meta-optimize.mjs rollback <id>
//   node scripts/meta-optimize.mjs evaluate <id> [--attempts N] [--min N] [--tasks A,B] [--thai]
//   node scripts/meta-optimize.mjs drive <dimension> [--hypothesis TEXT] [--evaluate]
//   node scripts/meta-optimize.mjs report
//
// exit codes: 0 the change stands, 1 it does not, 2 the command refused.
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { DIMENSIONS, policyDir, loadPolicy, readDocument } from '../aipass-bridge/harness/meta/policy.mjs';
import { COMPONENTS, componentById, sourceDigest, sourceOutline } from '../aipass-bridge/harness/meta/components.mjs';
import { listTraces, readTrace, traceView, failureLines } from '../aipass-bridge/harness/meta/traces.mjs';
import { checkCandidate, RULE_TEXT } from '../aipass-bridge/harness/meta/verify.mjs';
import {
  createProposal, readProposal, listProposals, buildArms, applyProposal, rollbackProposal,
  writeVerdict, readVerdict, newProposalId, metaDir,
} from '../aipass-bridge/harness/meta/proposals.mjs';
import { scoreRows, readRows, formatScore } from '../aipass-bridge/harness/meta/score.mjs';
import { compareRuns } from './evals-compare.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXCERPT_CHARS = 400;

const USAGE = `meta-optimize — let the harness tune itself, one component at a time

usage:
  node scripts/meta-optimize.mjs status
  node scripts/meta-optimize.mjs brief <dimension> [--traces N]
  node scripts/meta-optimize.mjs propose <dimension> --candidate FILE --hypothesis TEXT
  node scripts/meta-optimize.mjs apply <id>
  node scripts/meta-optimize.mjs rollback <id>
  node scripts/meta-optimize.mjs evaluate <id> [options]
  node scripts/meta-optimize.mjs drive <dimension> [--hypothesis TEXT] [--evaluate]
  node scripts/meta-optimize.mjs report

dimensions
  ${DIMENSIONS.join(', ')}

evaluate options
  --attempts N   attempts per task per arm (default 3 — read medians, never the best draw)
  --min N        the sample floor the comparator gates on (default 3)
  --tasks A,B    a subset of the smoke set (default: all of it)
  --thai         the Thai/English pair set instead
  --budget a=b   the same budget override the eval runner takes
  --pause MS     spacing between the attempts of one arm (default 10000)
  --arm-pause MS spacing between the two arms (default 30000 — the edge
                refuses a burst of about ten messages per four minutes)

where things live
  policy documents   ${policyDir()}
  proposals          ${path.join(metaDir(), 'proposals')}
  briefs             ${path.join(metaDir(), 'briefs')}
  results            ${path.join(metaDir(), 'runs')}

exit codes: 0 the change stands, 1 it does not, 2 the command refused.`;

/** Flags and positionals, the way the other CLIs in this repo read them. */
function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    if (eq !== -1) {
      flags[name] = arg.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      flags[name] = true;
      continue;
    }
    flags[name] = next;
    i += 1;
  }
  return { positional, flags };
}

const out = (text = '') => console.log(text);
const err = (text) => console.error(text);

/** The raw line, trimmed to a readable width. The cut is marked, and the
 *  citation beside it is the original. */
function excerpt(text, limit = EXCERPT_CHARS) {
  const flat = String(text ?? '').replace(/\r/g, '');
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

const json = (flags) => flags.json === true || flags.json === 'true';

// ---------------------------------------------------------------- status ---

async function cmdStatus({ flags }) {
  const dir = policyDir();
  const policy = loadPolicy(dir);
  const proposals = await listProposals();

  if (json(flags)) {
    out(JSON.stringify({
      policyDir: dir,
      override: process.env.AIPASS_POLICY_DIR ?? null,
      digest: policy.digest,
      bytes: policy.bytes,
      enabled: policy.enabled,
      documents: Object.fromEntries(Object.entries(policy.documents).map(([k, v]) => [k, {
        exists: v.exists, enabled: v.enabled, bytes: v.bytes, digest: v.digest, file: v.file,
      }])),
      proposals: proposals.map((p) => ({ id: p.id, dimension: p.dimension, status: p.status, verdict: p.verdict })),
    }, null, 2));
    return 0;
  }

  out(`policy     ${dir}${process.env.AIPASS_POLICY_DIR ? '  (AIPASS_POLICY_DIR)' : ''}`);
  out(`digest     ${policy.digest ?? '—'}   bytes ${policy.bytes}`);
  out('');
  out('dimension      document                        state');
  for (const component of COMPONENTS) {
    const doc = policy.documents[component.id];
    const state = !doc.exists ? '—' : `${String(doc.bytes).padStart(5)} B  ${doc.digest}  ${doc.enabled ? 'on' : 'off'}`;
    out(`  ${component.id.padEnd(12)}  ${path.basename(doc.file).padEnd(30)}  ${state}`);
  }
  if (proposals.length) {
    out('');
    out('proposals');
    for (const proposal of proposals) {
      const verdict = proposal.verdict ? ` · ${proposal.verdict}` : '';
      out(`  ${proposal.id}  ${proposal.dimension.padEnd(14)} ${proposal.status}${verdict}`);
    }
  }
  const results = await latestResults();
  if (results.length) {
    out('');
    out('latest results');
    for (const { file, score } of results) out(`  ${path.basename(file)}  ${formatScore(score)}`);
  } else {
    out('');
    out('no eval results on disk — run `npm run evals -- --all --live` for a baseline');
  }
  return 0;
}

/** The newest result files, each with its reading. */
async function latestResults({ dir = path.join(REPO, 'evals', 'results'), limit = 3 } = {}) {
  let names;
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const files = names.filter((n) => n.endsWith('.jsonl'));
  const out_ = [];
  for (const name of files.sort().reverse().slice(0, limit)) {
    const file = path.join(dir, name);
    const { rows } = await readRows(file);
    if (!rows.length) continue;
    out_.push({ file, score: scoreRows(rows) });
  }
  return out_;
}

// ----------------------------------------------------------------- brief ---

/**
 * The evidence pack. It is the optimizer's whole input: the contract, the
 * component, the source it must read, the current document, the raw traces
 * and the current score.
 */
async function cmdBrief({ positional, flags }) {
  const dimension = positional[0];
  const component = componentById(dimension);
  if (!component) {
    err(`unknown dimension: ${dimension ?? '(none)'}\nthe dimensions are: ${DIMENSIONS.join(', ')}`);
    return 2;
  }
  const want = Number(flags.traces ?? 5) || 5;
  const doc = readDocument(dimension);
  const policy = loadPolicy();
  const score = await currentScore();
  const traces = await collectTraces(want);
  const brief = renderBrief({ component, doc, policy, score, traces });

  const id = newProposalId();
  const file = path.join(metaDir(), 'briefs', `${dimension}-${id}.md`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, brief, 'utf8');
  out(`brief written: ${file}`);
  out(`  dimension ${dimension} · ${traces.length} traces · ${brief.length} bytes`);
  return 0;
}

/** The newest traces, with the project's own sessions first. */
async function collectTraces(want) {
  const files = await listTraces({ limit: want * 3 });
  const out_ = [];
  for (const info of files) {
    if (out_.length >= want) break;
    const trace = await readTrace(info.file);
    out_.push({ info, trace, view: traceView(trace) });
  }
  return out_;
}

/** The score the arms will be compared against, if a result file exists. */
async function currentScore() {
  const results = await latestResults({ limit: 1 });
  if (!results.length) return null;
  return { file: results[0].file, score: results[0].score };
}

function renderBrief({ component, doc, policy, score, traces }) {
  const lines = [];
  const push = (...text) => lines.push(...text);

  push(`# Harness change brief — ${component.id}`);
  push('');
  push(`**${component.title}.** ${component.decides}`);
  push('');
  push('## The contract');
  push('');
  push('A change here is one document, and it is judged by the score:');
  push('');
  for (const rule of RULE_TEXT.split('\n')) push(`- ${rule}`);
  push('');
  push('## The source you must read first');
  push('');
  push('The optimizer reads the harness\'s own code, not a summary of it. These are the');
  push('files that decide this dimension:');
  push('');
  for (const source of component.sources) {
    const digest = sourceDigest(source.rel);
    const outline = sourceOutline(source.rel);
    push(`### ${source.rel}`);
    push('');
    push(`- why: ${source.why}`);
    push(`- ${digest.bytes} bytes, ${digest.lines} lines, sha256 ${digest.sha256}`);
    if (outline.entries?.length) {
      push('- outline:');
      for (const entry of outline.entries.slice(0, 20)) push(`  - L${entry.line} ${entry.name}`);
      if (outline.total > 20) push(`  - … ${outline.total - 20} more`);
    }
    push(`- open: ${digest.file}`);
    push('');
  }
  push('## The policy document as it stands');
  push('');
  if (doc.exists) {
    push(`\`${doc.file}\` — ${doc.bytes} bytes, sha256 ${doc.digest}, ${doc.enabled ? 'enabled' : 'disabled'}`);
    push('');
    push('```markdown');
    push(doc.text.trimEnd());
    push('```');
  } else {
    push(`There is no document yet: \`${doc.file}\` does not exist. The dimension`);
    push('runs on the built-in behavior alone.');
  }
  push('');
  push('## What the traces say');
  push('');
  if (!traces.length) {
    push('No sessions on disk — there is no evidence to read.');
  } else {
    push('Excerpts are the transcript lines themselves, trimmed for width; the');
    push('citation is the original, and the original was not changed.');
    push('');
    for (const { info, trace, view } of traces) {
      push(`### ${info.project}/${path.basename(info.file)} — ${info.bytes} bytes`);
      push('');
      push(`- model ${view.model ?? '—'} · entries ${view.entries} · tools ${view.tools} (${view.failedTools} failed) · stop ${view.stopReason ?? '—'}`);
      if (view.repeated.length) {
        push('- repeated calls:');
        for (const repeat of view.repeated.slice(0, 5)) push(`  - ${repeat.n}× ${repeat.key}`);
      }
      const failures = failureLines(trace, { limit: 8 });
      if (failures.length) {
        push('- failures:');
        for (const failure of failures) push(`  - L${failure.line} ${excerpt(failure.text)}`);
      }
      if (view.lastWords) {
        push("- the model's last words:");
        push(`  - ${excerpt(view.lastWords, 600)}`);
      }
      push('');
    }
  }
  push('## The score as it stands');
  push('');
  if (score) {
    push(`\`${score.file}\``);
    push('');
    push(`- ${formatScore(score.score)}`);
    for (const task of score.score.tasks) {
      push(`  - ${task.id} — ${task.solved}/${task.scored} solved${task.invalid ? ` (${task.invalid} invalid)` : ''}${task.category ? ` · ${task.category}` : ''}`);
    }
  } else {
    push('No eval results on disk. The arms cannot be compared against nothing:');
    push('run the matrix first (`npm run evals -- --all --live --attempts 3 --keep`).');
  }
  push('');
  push('## What to produce');
  push('');
  push(`A new \`${component.id}.md\`, under ${1200} bytes, that changes this dimension and`);
  push('nothing else. It is checked before it is measured: a candidate that weakens');
  push('the floor, or that carries a token the outbound table rewrites, is refused.');
  push('');
  return lines.join('\n');
}

// --------------------------------------------------------------- propose ---

async function cmdPropose({ positional, flags }) {
  const dimension = positional[0];
  const component = componentById(dimension);
  if (!component) {
    err(`unknown dimension: ${dimension ?? '(none)'}\nthe dimensions are: ${DIMENSIONS.join(', ')}`);
    return 2;
  }
  const file = flags.candidate;
  if (!file || file === true) {
    err('propose needs --candidate FILE — the new document');
    return 2;
  }
  let candidate;
  try {
    candidate = await fs.readFile(path.resolve(String(file)), 'utf8');
  } catch (e) {
    err(`cannot read the candidate: ${e.message}`);
    return 2;
  }
  const base = readDocument(dimension);
  const check = checkCandidate({ dimension, text: candidate, base: base.text });
  if (!check.ok) {
    err('the candidate is refused:');
    for (const problem of check.problems) err(`  - [${problem.rule}] ${problem.detail}`);
    return 2;
  }
  for (const warning of check.warnings) out(`  note [${warning.rule}] ${warning.detail}`);
  const record = await createProposal({
    dimension,
    hypothesis: String(flags.hypothesis ?? ''),
    rationale: String(flags.rationale ?? ''),
    evidence: String(flags.evidence ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    candidate,
    base: base.exists ? base.text : null,
  });
  out(`proposal ${record.id} (${dimension})`);
  out(`  candidate: ${check.bytes} bytes · hypothesis: ${record.hypothesis || '(none given)'}`);
  out(`  measure it: node scripts/meta-optimize.mjs evaluate ${record.id}`);
  return 0;
}

// ------------------------------------------------------- apply / rollback ---

async function cmdApply({ positional }) {
  const id = positional[0];
  if (!id) {
    err('apply needs a proposal id');
    return 2;
  }
  const record = await applyProposal({ id, policyDir: policyDir() });
  out(`applied ${record.id} (${record.dimension}) → ${path.join(policyDir(), `${record.dimension}.md`)}`);
  out('  the next run picks it up; roll back with:');
  out(`    node scripts/meta-optimize.mjs rollback ${record.id}`);
  return 0;
}

async function cmdRollback({ positional }) {
  const id = positional[0];
  if (!id) {
    err('rollback needs a proposal id');
    return 2;
  }
  const record = await rollbackProposal({ id, policyDir: policyDir() });
  out(`rolled back ${record.id} (${record.dimension}) — the baseline bytes are live again`);
  return 0;
}

// -------------------------------------------------------------- evaluate ---

/** Run the eval runner in one arm and return the rows it wrote. */
function runEvals(armDir, { attempts, tasks, thai, budget, pause, resultsDir }) {
  const args = [path.join(REPO, 'scripts', 'evals.mjs')];
  if (tasks?.length) for (const task of tasks) args.push('--task', task);
  else if (thai) args.push('--thai');
  else args.push('--all');
  args.push('--live');
  if (attempts) args.push('--attempts', String(attempts));
  if (budget) args.push('--budget', String(budget));
  if (pause) args.push('--pause', String(pause));
  args.push('--results', resultsDir);
  args.push('--keep');
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: REPO,
      env: { ...process.env, AIPASS_POLICY_DIR: armDir },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/** The result file the runner wrote in a directory. */
async function newestResult(dir) {
  let names;
  try {
    names = await fs.readdir(dir);
  } catch {
    return null;
  }
  const files = names.filter((n) => n.endsWith('.jsonl'));
  if (!files.length) return null;
  files.sort();
  return path.join(dir, files[files.length - 1]);
}

async function cmdEvaluate({ positional, flags }) {
  const id = positional[0];
  if (!id) {
    err('evaluate needs a proposal id');
    return 2;
  }
  const proposal = await readProposal({ id });
  if (!proposal) {
    err(`no proposal: ${id}`);
    return 2;
  }
  const arms = await buildArms({ id, policyDir: policyDir() });
  if (arms.changed.length !== 1) {
    err(`the arms differ in ${arms.changed.length} files (${arms.changed.join(', ') || 'none'}) — one dimension per change`);
    err('  a comparison over two changes at once measures nothing');
    return 2;
  }
  out(`proposal ${id} (${proposal.dimension}) — the arms differ in ${arms.changed[0]} and nothing else`);

  const attempts = Number(flags.attempts ?? 3) || 3;
  const min = Number(flags.min ?? 3) || 3;
  const tasks = flags.tasks ? String(flags.tasks).split(',').map((s) => s.trim()).filter(Boolean) : [];
  const thai = flags.thai === true || flags.thai === 'true';
  // Probe discipline (SPEC_EVALS §5): the account edge refuses a burst of
  // about ten messages per four minutes, and the second arm runs right after
  // the first. The pause inside a run and the pause between the arms are what
  // keep a measurement from being a rate-limit report.
  const pause = Number(flags.pause ?? 10000) || 0;
  const armPause = Number(flags['arm-pause'] ?? 30000) || 0;
  const runsDir = path.join(metaDir(), 'runs', id);
  const rows = { baseline: [], candidate: [] };
  for (const arm of ['baseline', 'candidate']) {
    if (arm === 'candidate' && armPause) {
      out('');
      out(`— waiting ${Math.round(armPause / 1000)}s between the arms (the edge refuses a burst)`);
      await new Promise((resolve) => setTimeout(resolve, armPause));
    }
    const resultsDir = path.join(runsDir, arm);
    await fs.mkdir(resultsDir, { recursive: true });
    out('');
    out(`— ${arm} arm: ${arms[arm === 'baseline' ? 'baselineDir' : 'candidateDir']}`);
    const run = await runEvals(arms[arm === 'baseline' ? 'baselineDir' : 'candidateDir'], {
      attempts, tasks, thai, budget: flags.budget, pause, resultsDir,
    });
    const file = await newestResult(resultsDir);
    const { rows: armRows } = file ? await readRows(file) : { rows: [] };
    rows[arm] = armRows;
    out(`  exit ${run.code} · ${armRows.length} rows${file ? ` · ${path.basename(file)}` : ''}`);
    if (!armRows.length) out(`  ${run.stderr.trim().split('\n').slice(-4).join('\n  ')}`);
    const invalid = armRows.filter((r) => r.outcome === 'invalid');
    const reasons = [...new Set(invalid.map((r) => r.invalidReason ?? 'unknown'))];
    const scored = armRows.filter((r) => r.scored !== false && r.outcome !== 'invalid' && r.outcome !== 'stale');
    if (armRows.length && !scored.length) {
      err('');
      err(`the ${arm} arm produced no scored rows — the measurement did not happen, so nothing was compared.`);
      err(`  ${invalid.length} invalid attempt(s): ${reasons.join(', ')}`);
      err('  an invalid attempt is not a failure (SPEC_EVALS §5): the bridge, the tab or the edge refused it.');
      err('  is the bridge up?  npm run dev');
      return 2;
    }
    if (invalid.length) {
      out(`  ${invalid.length} attempt(s) were invalid (${reasons.join(', ')}) — the sample is thinner than it looks`);
    }
  }

  const verdict = compareRuns(rows.baseline, rows.candidate, { minAttempts: min });
  const payload = {
    verdict: verdict.verdict,
    fails: verdict.fails,
    warns: verdict.warns,
    notes: verdict.notes,
    cost: verdict.cost,
    wall: verdict.wall,
    sample: verdict.sample,
    tasks: verdict.tasks,
    baseline: scoreRows(rows.baseline),
    candidate: scoreRows(rows.candidate),
    arms,
  };
  await writeVerdict({ id, verdict: payload });

  out('');
  out(`baseline   ${formatScore(payload.baseline)}`);
  out(`candidate  ${formatScore(payload.candidate)}`);
  for (const note of verdict.notes) out(`  + ${note}`);
  for (const warn of verdict.warns) out(`  ! ${warn}`);
  for (const fail of verdict.fails) out(`  x ${fail}`);
  out('');
  out(`verdict: ${verdict.verdict.toUpperCase()}`);
  if (verdict.verdict === 'pass') {
    out(`  apply it:  node scripts/meta-optimize.mjs apply ${id}`);
  } else {
    out(`  it stays proposed. The candidate is at ${path.join(metaDir(), 'proposals', id, 'candidate', `${proposal.dimension}.md`)}`);
  }
  if (json(flags)) out(JSON.stringify(payload, null, 2));
  return verdict.verdict === 'pass' ? 0 : 1;
}

// ----------------------------------------------------------------- drive ---

/**
 * The self-driving arm: build the brief, let the model write the candidate,
 * measure it, and apply it only if the score moved. The model is the one
 * that reads the brief and the source; this command only holds the ground
 * rules (one dimension, deterministic checks, the score decides).
 */
async function cmdDrive({ positional, flags }) {
  const dimension = positional[0];
  const component = componentById(dimension);
  if (!component) {
    err(`unknown dimension: ${dimension ?? '(none)'}\nthe dimensions are: ${DIMENSIONS.join(', ')}`);
    return 2;
  }
  const want = Number(flags.traces ?? 5) || 5;
  const doc = readDocument(dimension);
  const score = await currentScore();
  const traces = await collectTraces(want);
  const brief = renderBrief({ component, doc, policy: loadPolicy(), score, traces });

  const id = newProposalId();
  const work = path.join(metaDir(), 'work', id);
  await fs.mkdir(path.join(work, 'policy'), { recursive: true });
  await fs.writeFile(path.join(work, 'BRIEF.md'), brief, 'utf8');
  await fs.writeFile(path.join(work, 'policy', `${dimension}.md`), doc.exists ? doc.text : '', 'utf8');

  const task = [
    `Read BRIEF.md in this project. It describes one change to the harness policy: the file policy/${dimension}.md.`,
    `Rewrite that file with the new policy document — follow the contract in the brief, keep it under 1200 bytes,`,
    'and change nothing else. When the file is written, say DONE with one sentence about what you changed and why.',
  ].join(' ');

  out(`— the model writes the candidate (${id})`);
  const run = await new Promise((resolve) => {
    const child = spawn(process.execPath, [
      path.join(REPO, 'aipass-bridge', 'agent.mjs'), task, '--root', work, '--apply',
    ], { cwd: REPO, env: { ...process.env }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
  if (run.code !== 0) {
    err(`the agent run failed (exit ${run.code})`);
    err(run.stderr.trim().split('\n').slice(-6).join('\n'));
    return 1;
  }
  const written = await fs.readFile(path.join(work, 'policy', `${dimension}.md`), 'utf8').catch(() => null);
  if (!written || !written.trim()) {
    err('the agent wrote no candidate');
    return 1;
  }
  const check = checkCandidate({ dimension, text: written, base: doc.text });
  if (!check.ok) {
    err('the candidate the model wrote is refused:');
    for (const problem of check.problems) err(`  - [${problem.rule}] ${problem.detail}`);
    err(`  the draft is kept at ${path.join(work, 'policy', `${dimension}.md`)}`);
    return 2;
  }
  const record = await createProposal({
    id,
    dimension,
    hypothesis: String(flags.hypothesis ?? ''),
    rationale: 'written by the model from the brief',
    evidence: traces.map((t) => t.info.file),
    candidate: written,
    base: doc.exists ? doc.text : null,
  });
  out(`proposal ${record.id} (${dimension}) — ${check.bytes} bytes`);
  if (!flags.evaluate) {
    out(`  measure it: node scripts/meta-optimize.mjs evaluate ${record.id}`);
    return 0;
  }
  const code = await cmdEvaluate({ positional: [record.id], flags });
  if (code === 0) {
    await applyProposal({ id: record.id, policyDir: policyDir() });
    out(`applied ${record.id} (${dimension})`);
  } else {
    out(`not applied — the score did not move (${record.id})`);
  }
  return code;
}

// ---------------------------------------------------------------- report ---

async function cmdReport({ flags }) {
  const proposals = await listProposals();
  if (!proposals.length) {
    out('no proposals yet');
    return 0;
  }
  if (json(flags)) {
    const out_ = [];
    for (const proposal of proposals) {
      const verdict = await readVerdict({ id: proposal.id });
      out_.push({ id: proposal.id, dimension: proposal.dimension, status: proposal.status, hypothesis: proposal.hypothesis, verdict });
    }
    out(JSON.stringify(out_, null, 2));
    return 0;
  }
  out(`  ${'id'.padEnd(26)} ${'dimension'.padEnd(13)} ${'status'.padEnd(12)} ${'verdict'.padEnd(8)} hypothesis`);
  for (const proposal of proposals) {
    const verdict = proposal.verdict ?? '—';
    out(`  ${proposal.id.padEnd(26)} ${proposal.dimension.padEnd(13)} ${String(proposal.status).padEnd(12)} ${verdict.padEnd(8)} ${proposal.hypothesis || ''}`);
  }
  return 0;
}

// ------------------------------------------------------------------ main ---

async function main(argv) {
  const { positional, flags } = parseArgs(argv);
  if (flags.help || flags.h || positional[0] === 'help') {
    out(USAGE);
    return 0;
  }
  const command = positional.shift();
  switch (command) {
    case 'status': return cmdStatus({ flags });
    case 'brief': return cmdBrief({ positional, flags });
    case 'propose': return cmdPropose({ positional, flags });
    case 'apply': return cmdApply({ positional, flags });
    case 'rollback': return cmdRollback({ positional, flags });
    case 'evaluate': return cmdEvaluate({ positional, flags });
    case 'drive': return cmdDrive({ positional, flags });
    case 'report': return cmdReport({ flags });
    case undefined:
      out(USAGE);
      return 2;
    default:
      err(`unknown command: ${command}\n`);
      out(USAGE);
      return 2;
  }
}

const code = await main(process.argv.slice(2));
process.exit(code);
