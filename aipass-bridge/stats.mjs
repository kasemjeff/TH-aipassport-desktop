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
import fs from 'node:fs';
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

/** The stop reasons the alerts treat as "a guard tripped" — one list, two readers. */
const GUARD_STOPS = new Set(['stalled', 'stagnation', 'error']);

/** The run_stats lines of one session, shaped into comparable rows. */
export function collectRuns(session) {
  // Runs written before `run_stats.model` existed carry no model of their own;
  // the session's header still names the model a fresh run started on, so the
  // byModel grouping keeps that history attributable instead of blending it
  // into "(unrecorded)" — which stays for sessions that recorded nothing.
  const sessionModel = session.meta().model ?? null;
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
      model: e.model ?? sessionModel,
      steps: e.steps ?? 0,
      turns: e.turns ?? (Array.isArray(e.stepMs) ? e.stepMs.length : 0),
      calls,
      refusals,
      refusalRate: calls ? refusals / calls : 0,
      nudges: e.nudges ?? 0,
      stagnations: e.stagnations ?? 0,
      verifyPrompts: e.verifyPrompts ?? 0,
      repeatBlocks: e.repeatBlocks ?? 0,
      commitBlocks: e.commitBlocks ?? 0,
      langPrompts: e.langPrompts ?? 0,
      novelResults: e.novelResults ?? 0,
      repeatedResults: e.repeatedResults ?? 0,
      checks: e.checks ?? 0,
      checkVerdict: e.checkVerdict ?? null,
      // The command the verdict is about, and whether the strict gate refused
      // a DONE over it: without the command two verdicts are not comparable,
      // and without the count a refused DONE is invisible in the totals.
      checkCommand: e.checkCommand ?? null,
      doneUnverified: e.doneUnverified ?? 0,
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
    doneUnverified: 0,
    commitBlocks: 0,
    firewallNotes: 0,
    spent: 0,
    byTool: {},
    byStop: {},
    byModel: {},
    byRoot: {},
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
    totals.doneUnverified += r.doneUnverified ?? 0;
    totals.commitBlocks += r.commitBlocks ?? 0;
    totals.firewallNotes += r.firewallNotes;
    totals.spent += r.spent ?? 0;
    totals.byStop[r.stopReason] = (totals.byStop[r.stopReason] ?? 0) + 1;
    // The reliability report the round asked for: the same rows grouped by the
    // model that produced them and the project they ran in, so a drifting
    // model or workflow shows up as its own line instead of inside a blend.
    const byM = totals.byModel[r.model ?? '(unrecorded)'] ?? { runs: 0, calls: 0, refusals: 0, guardStops: 0, spent: 0 };
    byM.runs += 1; byM.calls += r.calls; byM.refusals += r.refusals; byM.spent += r.spent ?? 0;
    if (GUARD_STOPS.has(r.stopReason)) byM.guardStops += 1;
    totals.byModel[r.model ?? '(unrecorded)'] = byM;
    const byR = totals.byRoot[r.root ?? '?'] ?? { runs: 0, guardStops: 0, spent: 0 };
    byR.runs += 1; byR.spent += r.spent ?? 0;
    if (GUARD_STOPS.has(r.stopReason)) byR.guardStops += 1;
    totals.byRoot[r.root ?? '?'] = byR;
    for (const [kind, s] of Object.entries(r.tools)) {
      const t = totals.byTool[kind] ?? { n: 0, fail: 0, ms: 0 };
      t.n += s.n ?? 0;
      t.fail += s.fail ?? 0;
      t.ms += s.ms ?? 0;
      totals.byTool[kind] = t;
    }
    for (const ms of r.stepMs) { totals.stepMsTotal += ms; totals.stepMsCount++; }
  }
  return totals;
}

const pct = (n) => `${Math.round(n * 100)}%`;
const credits = (n) => (n ? n.toLocaleString('en-US', { maximumFractionDigits: n < 100 ? 2 : 0 }) : '0');
const when = (ts) => (ts ? new Date(ts).toISOString().slice(5, 16).replace('T', ' ') : '?');

/**
 * The alerts a local install can act on, computed from the same rows the
 * report reads. There is no server here to push them, so they are pull-based
 * on purpose: `--alerts` prints them and `--strict` turns any warning into a
 * non-zero exit — the shape a scheduled task or a release checklist keys on.
 * Info lines never fail a strict run; only warnings do.
 */
export function alerts(rows) {
  const out = [];
  const totals = summarize(rows);
  if (rows.length >= 10) {
    const refusalRate = totals.calls ? totals.refusals / totals.calls : 0;
    if (refusalRate > 0.3) {
      out.push({ level: 'warn', text: `tool refusal rate ${pct(refusalRate)} over ${rows.length} runs — protocol drift, not bad luck (see the tools list)` });
    }
    const guardStops = [...GUARD_STOPS].reduce((a, k) => a + (totals.byStop[k] ?? 0), 0);
    if (guardStops / rows.length > 0.25) {
      out.push({ level: 'warn', text: `${guardStops} of ${rows.length} runs ended stalled/stagnation/error — the guards are tripping often` });
    }
  }
  const spent = rows.map((r) => r.spent).filter((n) => n != null).sort((a, b) => a - b);
  if (spent.length >= 5) {
    const median = spent[Math.floor(spent.length / 2)];
    const worst = spent.at(-1);
    if (median > 0 && worst > median * 4) {
      out.push({ level: 'warn', text: `cost outlier: a run spent ${worst} credits against a median of ${median} — find it in the table` });
    }
  }
  if (totals.firewallNotes > 0) {
    out.push({ level: 'info', text: `${totals.firewallNotes} firewall note(s) across these runs — the edge refused content at least once` });
  }
  return out;
}

/** A self-contained report page — the same numbers, openable without a server. */
export function renderHtml({ rows = [], totals = summarize(rows), last = 50 } = {}) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const found = alerts(rows);
  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 16);
  const alertLines = found.length
    ? found.map((a) => `<li class="${a.level}">${esc(a.text)}</li>`).join('\n      ')
    : '<li class="none">none</li>';
  const modelLine = Object.entries(totals.byModel ?? {})
    .sort((a, b) => b[1].runs - a[1].runs)
    .map(([m, s]) => `${m} ×${s.runs}${s.guardStops ? ` (${s.guardStops} guard)` : ''}`)
    .join(' · ');
  const tableRows = rows.slice(0, last).map((r) => `<tr>
      <td>${esc(when(r.ts))}</td><td>${esc(r.stopReason ?? '?')}</td>
      <td class="n">${r.calls}</td><td class="n">${pct(r.refusalRate)}</td>
      <td class="n">${r.nudges}</td><td class="n">${r.stagnations}</td><td class="n">${r.firewallNotes}</td>
      <td class="n">${r.checks ? esc((r.checkVerdict ?? '?').slice(0, 1).toUpperCase()) : '-'}</td>
      <td class="n">${esc(credits(r.spent))}</td><td>${esc(r.title)}</td>
    </tr>`).join('\n');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>aipass run report</title>
<style>
  body { font: 14px/1.5 system-ui, sans-serif; margin: 2rem auto; max-width: 72rem; padding: 0 1rem; color: #222; }
  h1 { font-size: 1.25rem; } .lifetime { color: #555; }
  ul.alerts { padding-left: 1.2rem; } li.warn { color: #a33; } li.info { color: #555; } li.none { color: #888; }
  table { border-collapse: collapse; width: 100%; margin-top: 1rem; }
  th, td { text-align: left; padding: 4px 8px; border-bottom: 1px solid #ddd; }
  td.n, th.n { text-align: right; } footer { color: #888; margin-top: 1rem; font-size: 12px; }
</style></head><body>
<h1>aipass run report</h1>
<p class="lifetime">${totals.runs} run(s) · ${totals.calls} tool call(s) · refusals ${pct(totals.calls ? totals.refusals / totals.calls : 0)} · checks ${totals.checks}${totals.checkFails ? ` (${totals.checkFails} failed)` : ''} · ${credits(totals.spent)} credits${modelLine ? ` · models ${esc(modelLine)}` : ''} · generated ${stamp}</p>
<ul class="alerts">
      ${alertLines}
</ul>
<table>
  <thead><tr><th>when</th><th>stop</th><th class="n">calls</th><th class="n">✗rate</th><th class="n">nudge</th><th class="n">stag</th><th class="n">fw</th><th class="n">chk</th><th class="n">credits</th><th>task</th></tr></thead>
  <tbody>
${tableRows}
  </tbody>
</table>
<footer>machine-local report — regenerate with <code>npm run stats -- --html report.html</code></footer>
</body></html>`;
}

function main() {
  if (has('help')) {
    console.log('usage: npm run stats -- [--root DIR] [--store DIR] [--last N] [--alerts] [--strict] [--json] [--html FILE]');
    console.log('  --alerts   print the warnings a local install can act on (pull-based; nothing pushes for you)');
    console.log('  --strict   exit 1 when any warning fired — what a scheduled task or a release step keys on');
    console.log('  --json     machine-readable: {lifetime, alerts, rows}');
    console.log('  --html F   write a self-contained report page to F');
    process.exit(0);
  }
  const jsonOut = has('json');
  const strict = has('strict');
  const wantAlerts = has('alerts') || strict;
  const htmlFile = flag('html', null);
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
    if (jsonOut) console.log(JSON.stringify({ lifetime: null, alerts: [], rows: [] }, null, 2));
    else console.log('no run_stats found — runs record one after each finished task');
    return;
  }

  const totals = summarize(rows);
  const found = alerts(rows);

  if (htmlFile) {
    fs.writeFileSync(htmlFile, renderHtml({ rows, totals, last }));
    console.log(`report written: ${htmlFile}`);
    if (strict && found.some((a) => a.level === 'warn')) process.exit(1);
    return;
  }
  if (jsonOut) {
    console.log(JSON.stringify({ lifetime: totals, alerts: found, rows: rows.slice(0, last) }, null, 2));
    if (strict && found.some((a) => a.level === 'warn')) process.exit(1);
    return;
  }

  console.log(`lifetime  ${totals.runs} run(s) · ${totals.calls} tool call(s) · refusals ${pct(totals.calls ? totals.refusals / totals.calls : 0)} · nudges ${totals.nudges} · stagnation ${totals.stagnations} · verify ${totals.verifyPrompts} · repeat ${totals.repeatBlocks} · lang ${totals.langPrompts} · checks ${totals.checks}${totals.checkFails ? ` (${totals.checkFails}✗)` : ''} · firewall ${totals.firewallNotes}${totals.commitBlocks ? ` · commit-gate ${totals.commitBlocks}` : ''}${totals.doneUnverified ? ` · unverified ${totals.doneUnverified}` : ''} · ${credits(totals.spent)} credits`);
  const avgStep = totals.stepMsCount ? Math.round(totals.stepMsTotal / totals.stepMsCount / 100) / 10 : null;
  const stops = Object.entries(totals.byStop).map(([k, n]) => `${k}×${n}`).join(', ');
  if (avgStep !== null) console.log(`          avg step ${avgStep}s · ends: ${stops}`);
  // Per-tool latency: the mean wall time each kind spent, next to its refusal
  // count — a slow run names where it went without reading the transcript.
  const toolLine = Object.entries(totals.byTool)
    .sort((a, b) => b[1].n - a[1].n)
    .map(([kind, s]) => `${kind} ${s.fail ? `${s.fail}✗/` : ''}${s.n}${s.ms && s.n ? ` ${Math.round(s.ms / s.n)}ms` : ''}`)
    .join(' · ');
  if (toolLine) console.log(`          tools: ${toolLine}`);
  const modelLine = Object.entries(totals.byModel)
    .sort((a, b) => b[1].runs - a[1].runs)
    .map(([m, s]) => `${m} ${s.runs}r${s.guardStops ? `/${s.guardStops}guard` : ''}/${pct(s.calls ? s.refusals / s.calls : 0)}✗`)
    .join(' · ');
  if (modelLine) console.log(`          models: ${modelLine}`);
  const rootLine = Object.entries(totals.byRoot)
    .sort((a, b) => b[1].runs - a[1].runs).slice(0, 5)
    .map(([r, s]) => `${r.split(/[\\/]/).filter(Boolean).at(-1) || r} ${s.runs}r${s.guardStops ? `/${s.guardStops}guard` : ''}`)
    .join(' · ');
  if (rootLine) console.log(`          projects: ${rootLine}`);

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

  if (wantAlerts) {
    console.log('');
    if (!found.length) console.log('alerts    none');
    else for (const a of found) console.log(`alert     ${a.level === 'warn' ? '⚠' : '·'} ${a.text}`);
  }
  if (strict && found.some((a) => a.level === 'warn')) process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
