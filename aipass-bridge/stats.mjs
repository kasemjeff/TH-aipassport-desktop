#!/usr/bin/env node
// npm run stats — what the runs actually did, from the session files.
//
// Every run appends one `run_stats` line to its session JSONL: which tools ran
// and how many refused, nudges, stagnation corrections, firewall notes,
// per-step timings, credits.
// This reader aggregates those lines — the last N runs plus lifetime totals.
// Refusal-rate and firewall trends are how protocol drift gets caught instead
// of guessed at (docs/HARNESS_DESIGN.md, P2-D).
//
//   npm run stats                       last 20 runs, all projects
//   npm run stats -- --root DIR         one project
//   npm run stats -- --store DIR        another sessions directory
//   npm run stats -- --last 50
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { SessionStore } from './harness/session.mjs';

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
const has = (name) => argv.includes(`--${name}`);

/** The run_stats lines of one session, shaped into comparable rows. */
export function collectRuns(session) {
  const rows = [];
  for (const e of session.entries) {
    if (e.type !== 'run_stats') continue;
    const tools = e.tools ?? {};
    const calls = Object.values(tools).reduce((a, s) => a + (s.n ?? 0), 0);
    const refusals = Object.values(tools).reduce((a, s) => a + (s.fail ?? 0), 0);
    rows.push({
      sessionId: session.id,
      title: session.title,
      root: session.root,
      ts: e.ts,
      stopReason: e.stopReason,
      steps: e.steps ?? 0,
      calls,
      refusals,
      refusalRate: calls ? refusals / calls : 0,
      nudges: e.nudges ?? 0,
      stagnations: e.stagnations ?? 0,
      verifyPrompts: e.verifyPrompts ?? 0,
      repeatBlocks: e.repeatBlocks ?? 0,
      langPrompts: e.langPrompts ?? 0,
      novelResults: e.novelResults ?? 0,
      repeatedResults: e.repeatedResults ?? 0,
      checks: e.checks ?? 0,
      checkVerdict: e.checkVerdict ?? null,
      firewallNotes: e.firewallNotes ?? 0,
      stepMs: Array.isArray(e.stepMs) ? e.stepMs : [],
      spent: e.spent ?? null,
      tools,
    });
  }
  return rows;
}

/** Lifetime totals over a set of rows. */
export function summarize(rows) {
  const totals = {
    runs: rows.length,
    calls: 0,
    refusals: 0,
    nudges: 0,
    stagnations: 0,
    verifyPrompts: 0,
    repeatBlocks: 0,
    langPrompts: 0,
    repeatedResults: 0,
    checks: 0,
    checkFails: 0,
    firewallNotes: 0,
    spent: 0,
    byTool: {},
    byStop: {},
    stepMsTotal: 0,
    stepMsCount: 0,
  };
  for (const r of rows) {
    totals.calls += r.calls;
    totals.refusals += r.refusals;
    totals.nudges += r.nudges;
    totals.stagnations += r.stagnations;
    totals.verifyPrompts += r.verifyPrompts;
    totals.repeatBlocks += r.repeatBlocks ?? 0;
    totals.langPrompts += r.langPrompts ?? 0;
    totals.repeatedResults += r.repeatedResults ?? 0;
    totals.checks += r.checks;
    if (r.checkVerdict === 'fail') totals.checkFails += 1;
    totals.firewallNotes += r.firewallNotes;
    totals.spent += r.spent ?? 0;
    totals.byStop[r.stopReason] = (totals.byStop[r.stopReason] ?? 0) + 1;
    for (const [kind, s] of Object.entries(r.tools)) {
      const t = totals.byTool[kind] ?? { n: 0, fail: 0 };
      t.n += s.n ?? 0;
      t.fail += s.fail ?? 0;
      totals.byTool[kind] = t;
    }
    for (const ms of r.stepMs) { totals.stepMsTotal += ms; totals.stepMsCount++; }
  }
  return totals;
}

const pct = (n) => `${Math.round(n * 100)}%`;
const credits = (n) => (n ? n.toLocaleString('en-US', { maximumFractionDigits: n < 100 ? 2 : 0 }) : '0');
const when = (ts) => (ts ? new Date(ts).toISOString().slice(5, 16).replace('T', ' ') : '?');

function main() {
  if (has('help')) {
    console.log('usage: npm run stats -- [--root DIR] [--store DIR] [--last N]');
    process.exit(0);
  }
  const store = new SessionStore(flag('store', path.join(os.homedir(), '.aipass', 'sessions')));
  const root = flag('root', null);
  const last = Number(flag('last', 20)) || 20;

  const rows = [];
  for (const meta of store.list(root)) {
    const session = store.load(meta.id);
    if (session) rows.push(...collectRuns(session));
  }
  rows.sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0));

  if (!rows.length) {
    console.log('no run_stats found — runs record one after each finished task');
    return;
  }

  const totals = summarize(rows);
  console.log(`lifetime  ${totals.runs} run(s) · ${totals.calls} tool call(s) · refusals ${pct(totals.calls ? totals.refusals / totals.calls : 0)} · nudges ${totals.nudges} · stagnation ${totals.stagnations} · verify ${totals.verifyPrompts} · repeat ${totals.repeatBlocks} · lang ${totals.langPrompts} · checks ${totals.checks}${totals.checkFails ? ` (${totals.checkFails}✗)` : ''} · firewall ${totals.firewallNotes} · ${credits(totals.spent)} credits`);
  const avgStep = totals.stepMsCount ? Math.round(totals.stepMsTotal / totals.stepMsCount / 100) / 10 : null;
  const stops = Object.entries(totals.byStop).map(([k, n]) => `${k}×${n}`).join(', ');
  if (avgStep !== null) console.log(`          avg step ${avgStep}s · ends: ${stops}`);
  const toolLine = Object.entries(totals.byTool)
    .sort((a, b) => b[1].n - a[1].n)
    .map(([kind, s]) => `${kind} ${s.fail ? `${s.fail}✗/` : ''}${s.n}`)
    .join(' · ');
  if (toolLine) console.log(`          tools: ${toolLine}`);

  console.log(`\nlast ${Math.min(last, rows.length)} of ${rows.length}:`);
  console.log('  when           stop      calls  ✗rate  nudge stag  fw  chk  credits');
  for (const r of rows.slice(0, last)) {
    const title = r.title.length > 34 ? `${r.title.slice(0, 33)}…` : r.title;
    console.log(
      `  ${when(r.ts)}  ${String(r.stopReason ?? '?').padEnd(9)} ${String(r.calls).padStart(5)}  `
      + `${pct(r.refusalRate).padStart(5)}  ${String(r.nudges).padStart(5)}  ${String(r.stagnations).padStart(4)}  `
      + `${String(r.firewallNotes).padStart(2)}  `
      + `${(r.checks ? (r.checkVerdict ?? '?').slice(0, 1).toUpperCase() : '-').padStart(3)}  `
      + `${credits(r.spent).padStart(7)}  ${title}`,
    );
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
