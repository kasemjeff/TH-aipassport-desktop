#!/usr/bin/env node
// Local file tools driven by aipass.
//
// The protocol, the tools, the retry path and the run loop all live in
// ./harness/ now — this file is the terminal: it parses flags, prints what the
// harness emits, and owns the one question that has always belonged to a
// person at a prompt ("apply these changes?").
//
// Two constraints shape all of it, both learned the hard way upstream:
//
//  1. Only one user message per request is accepted. An array containing an
//     assistant turn is rejected with a 403 before the model sees it.
//  2. The server keeps the conversation history itself.
//
// So the instructions go out ONCE as the first message of a conversation, and
// every later turn is just the results of what was asked for. Payloads stay
// small, nothing is resent, and no system prompt exists to lean on — the
// preamble becomes part of the history the server already remembers.
import fs from 'node:fs';
import path from 'node:path';
import { Harness } from './harness/harness.mjs';
import { SkillLibrary } from './harness/skills.mjs';

const argv = process.argv.slice(2);
const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
if (argv.includes('--version') || argv.includes('-v')) {
  console.log(`aipass-agent ${VERSION}`);
  process.exit(0);
}
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
const has = (name) => argv.includes(`--${name}`);

const task = argv.filter((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--')).join(' ').trim();
const ROOT = path.resolve(flag('root', process.cwd()));
const BRIDGE = (flag('bridge', 'http://127.0.0.1:8787')).replace(/\/+$/, '');
const MODEL = flag('model', null);
// --max caps this run's steps. Without it (or with 0) the run goes until it is
// DONE, a guard stops it, or a per-run budget is spent.
const MAX_RAW = Number(flag('max', 0));
const MAX_STEPS = Number.isFinite(MAX_RAW) && MAX_RAW > 0 ? Math.floor(MAX_RAW) : 0;
const APPLY = has('apply');
const ALLOW_RUN = has('allow-run');
const MAX_RESULT = Number(flag('max-result', 3000));
// How hard the model thinks before each step: off | low | medium | high | max.
// Same default as the window's (settings.mjs 'thinking'): 'off' asks for
// nothing and lets each model's own default stand.
const THINKING = String(flag('thinking', 'low')).toLowerCase();
const CONVERSATION = flag('conversation', null);
// A conversation carries its own history, so reusing one drags in whatever was
// said before — including any refusal. Each run gets a fresh one by default.
const REUSE = has('reuse');
// A run gets a throwaway conversation by default: it never enters the account's
// chat history, cannot inherit anything said in an earlier run, and expires on
// its own. --permanent keeps the old behaviour of a normal saved conversation.
const PERMANENT = has('permanent');
// When the conversation is bound to a custom aipass assistant that already
// carries the NEED/EDIT/CREATE/DONE instructions, the preamble is redundant —
// and sending it again is just extra payload for the edge to inspect.
const SLIM = has('slim');
// Quote git status and package.json scripts into the first message so a fresh
// run starts oriented — off by default so the tuned turn-1 bytes stay identical.
const SNAPSHOT = has('snapshot');
// Stay open after the first task and take follow-ups on the same conversation,
// so the model keeps everything it has already read in context.
const WATCH = has('watch');
// Bind new conversations to a custom aipass assistant. The field name the
// create form uses is set by AIPASS_ASSISTANT_FIELD on the bridge; here we just
// pass the id through. Implies --slim, since the assistant carries the protocol.
const ASSISTANT = flag('assistant', process.env.AIPASS_ASSISTANT_ID || null);
// Playbook library the model loads on demand with SKILL <name>. Kept one level
// above the repo (scratch/aipass2/skills) so a re-clone never wipes it;
// override with AIPASS_SKILLS_DIR or --skills.
const SKILLS_DIR = flag('skills', null) ?? process.env.AIPASS_SKILLS_DIR;
// Teach the model the SEARCH -i form in the preamble. Off by default so the
// first message stays byte-identical to the protocol it was tuned against.
const SEARCH_I = has('search-i');
// Teach the model the ATTACH marker, for files `read` refuses (images, PDFs).
const ATTACH = has('attach');
// Run WEB lookups in a throwaway scratch conversation, so the search Q&A never
// occupies the working conversation's context.
const WEB_SCRATCH = has('web-scratch');
// Helpers in one reply run beside each other, each on its own conversation
// (P2-B). Off by default: the upstream must be live-verified to accept
// concurrent generations on separate conversations before this earns trust.
const PARALLEL_HELPERS = has('parallel-helpers');
// Teach the model the SUBAGENT marker and let the loop answer it. Without it
// a SUBAGENT marker comes back as an `err:` result.
const SUBAGENT = has('subagent');
// Repeatable --rule "pattern=decision[:kinds]" — the caller's explicit
// instruction for this run. Persisted rules live in ~/.aipass/rules.json
// (harness/rules.mjs); flag rules outrank them because they are more recent
// intent.
const RULES = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] !== '--rule') continue;
  const raw = String(argv[i + 1] ?? '').trim();
  const m = /^([^=]+)=(allow|deny)(?::([a-z,]+))?$/i.exec(raw);
  if (!m) {
    console.error(`bad --rule: "${raw}" — expected "pattern=allow|deny[:kinds]", e.g. --rule "src/**=allow:write"`);
    process.exit(1);
  }
  RULES.push({
    pattern: m[1].trim(),
    decision: m[2].toLowerCase(),
    ...(m[3] ? { kinds: m[3].split(',').map((k) => k.trim()).filter(Boolean) } : {}),
  });
}

const HELP = has('help') || argv.includes('-h');

if (!task || HELP) {
  // Asking for help is not an error, so it leaves with 0; a missing task is.
  const out = HELP ? console.log : console.error;
  out(`usage: npm run agent -- "<task>" [options]

  --root DIR      project root the agent may touch   (default: cwd)
  --skills DIR    playbook library for SKILL         (default: one level above the repo)
  --model ID      model id                           (default: bridge default)
  --thinking LVL  model thinking: off|low|medium|high|max  (default: low)
  --apply         write without asking               (default: ask after the diff)
  --allow-run     let the agent run shell commands   (default: off)
  --max N         cap this run's steps (0 = none)     (default: none)
  --max-result N  truncate each tool result          (default: 3000 bytes)
  --read-lines N  max lines per read page            (default: 250)
  --file PATH     attach a document or image to the session
  --slim          send only the task, without the built-in preamble
  --snapshot      quote git status and package.json scripts into turn 1
  --watch         stay open for follow-up tasks on the same conversation
  --reuse         continue the most recent conversation instead of a new one
  --permanent     keep the conversation in your chat history (default: temporary)
  --assistant ID  bind to a custom aipass assistant  (or AIPASS_ASSISTANT_ID)
  --bridge URL    bridge base URL                    (default: http://127.0.0.1:8787)
  --session ID    continue a saved session (default: a new one)
  --plan          ask for a PLAN/TODO before working (desktop harness feature)
  --search-i      tell the model about SEARCH -i (case-insensitive search)
  --attach        tell the model about ATTACH (hand it an image or document)
  --web-scratch   run WEB lookups in a throwaway conversation
  --parallel-helpers  run several SUBAGENTs of one reply beside each other
  --subagent      tell the model about SUBAGENT and let it hand off work
  --rule R        add a permission rule "pattern=decision" (repeatable, e.g. "src/**=allow")
  --no-session    do not save a session log
  --version       print version and exit

The model receives a tool protocol on turn 1 and drives file edits directly.
A dry run prints a unified diff; reply 'y' or pass --apply to write it to disk.`);
  process.exit(HELP ? 0 : 1);
}

const THINKING_LEVELS = ['off', 'low', 'medium', 'high', 'max'];
if (!THINKING_LEVELS.includes(THINKING)) {
  console.error(`bad --thinking: "${THINKING}" — expected ${THINKING_LEVELS.join(' | ')}`);
  process.exit(1);
}

const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const gray = (s) => `\x1b[90m${s}\x1b[0m`;

/* ------------------------------------------------------- terminal rendering */

// The model's live reasoning gets its own channel and its own look: one dim
// ⟡ line per completed line, capped per step so a long chain cannot push the
// work off the screen. The prose the model writes is a different thing — the
// 'thinking' event below keeps a line of its own for that.
let thoughtBuf = '';
let thoughtShown = 0;
let thoughtHidden = 0;

function emitThought(line) {
  const t = line.trim();
  if (!t) return;
  if (thoughtShown >= 12) { thoughtHidden++; return; }
  thoughtShown++;
  console.log('  ' + dim('⟡ ' + truncate(t, Math.max(40, (process.stdout.columns ?? 80) - 4))));
}

function processReasoning(text) {
  thoughtBuf += text;
  let cut;
  while ((cut = thoughtBuf.indexOf('\n')) !== -1) {
    emitThought(thoughtBuf.slice(0, cut));
    thoughtBuf = thoughtBuf.slice(cut + 1);
  }
}

function flushThought() {
  if (thoughtBuf.trim()) emitThought(thoughtBuf);
  thoughtBuf = '';
  if (thoughtHidden) console.log('  ' + dim('⟡ … +' + thoughtHidden + ' more'));
  thoughtShown = 0;
  thoughtHidden = 0;
}
const truncate = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

// Myers O(ND) line diff — no external `diff` binary, so it works the same on
// Windows. Returns [{ t: ' '|'-'|'+', line }].
function lineDiff(a, b) {
  const N = a.length, M = b.length, MAX = N + M;
  const trace = [];
  let v = new Map([[1, 0]]);
  let reached = false;
  for (let d = 0; d <= MAX && !reached; d++) {
    trace.push(new Map(v));
    const next = new Map(v);
    for (let k = -d; k <= d; k += 2) {
      const down = k === -d || (k !== d && (v.get(k - 1) ?? -1) < (v.get(k + 1) ?? -1));
      let x = down ? (v.get(k + 1) ?? 0) : (v.get(k - 1) ?? 0) + 1;
      let y = x - k;
      while (x < N && y < M && a[x] === b[y]) { x++; y++; }
      next.set(k, x);
      if (x >= N && y >= M) { reached = true; break; }
    }
    v = next;
  }
  const out = [];
  let x = N, y = M;
  for (let d = trace.length - 1; d >= 0 && (x > 0 || y > 0); d--) {
    const vd = trace[d];
    const k = x - y;
    const down = k === -d || (k !== d && (vd.get(k - 1) ?? -1) < (vd.get(k + 1) ?? -1));
    const pk = down ? k + 1 : k - 1;
    const px = vd.get(pk) ?? 0;
    const py = px - pk;
    while (x > px && y > py) { out.push({ t: ' ', line: a[x - 1] }); x--; y--; }
    if (d > 0) {
      if (down) { out.push({ t: '+', line: b[y - 1] }); y--; }
      else { out.push({ t: '-', line: a[x - 1] }); x--; }
    }
  }
  return out.reverse();
}

// Print `d` as a coloured unified diff with `ctx` lines of context. Returns
// false when there is nothing to show.
function printUnified(d, ctx = 3) {
  const n = d.length;
  const keep = new Array(n).fill(false);
  for (let i = 0; i < n; i++) {
    if (d[i].t === ' ') continue;
    for (let j = Math.max(0, i - ctx); j <= Math.min(n - 1, i + ctx); j++) keep[j] = true;
  }
  for (let i = 0; i < n; i++) {                 // bridge small gaps between hunks
    if (keep[i]) continue;
    let j = i; while (j < n && !keep[j]) j++;
    if (i > 0 && j < n && j - i <= ctx) for (let k = i; k < j; k++) keep[k] = true;
    i = j;
  }
  let oldLn = 0, newLn = 0, i = 0, shown = false;
  while (i < n) {
    if (!keep[i]) { if (d[i].t !== '+') oldLn++; if (d[i].t !== '-') newLn++; i++; continue; }
    let j = i; while (j < n && keep[j]) j++;
    const slice = d.slice(i, j);
    let oc = 0, nc = 0;
    for (const el of slice) { if (el.t !== '+') oc++; if (el.t !== '-') nc++; }
    console.log(dim(`@@ -${oldLn + 1},${oc} +${newLn + 1},${nc} @@`));
    for (const el of slice) {
      const txt = el.t + el.line;
      console.log(el.t === '+' ? green(txt) : el.t === '-' ? red(txt) : dim(txt));
      if (el.t !== '+') oldLn++;
      if (el.t !== '-') newLn++;
    }
    shown = true;
    i = j;
  }
  return shown;
}

const posix = (p) => p.split(path.sep).join('/');

function showDiff(overlay) {
  if (!overlay.size) { console.log(dim('\nno file changes')); return; }
  console.log(bold('\nchanges:'));
  const entries = overlay.entries();
  entries.forEach(([abs, next], idx) => {
    const rel = posix(path.relative(ROOT, abs));
    const before = overlay.diskText(abs);
    const diff = lineDiff(before.split('\n'), next === '\x00DELETE\x00' ? [] : next.split('\n'));
    const added = diff.filter((d) => d.t === '+').length;
    const removed = diff.filter((d) => d.t === '-').length;
    const isLast = idx === entries.length - 1;
    const branch = isLast ? '└── ' : '├── ';
    const counts = green(`+${added}`) + ' ' + red(`-${removed}`);
    const note = next === '\x00DELETE\x00' ? red(' (deleted)') : !before ? green(' (new file)') : '';
    console.log(`  ${gray(branch)}${rel}${note} ${dim(`(${counts})`)}`);
  });
  console.log(bold(`\n${overlay.size} file(s) changed:\n`));
  for (const [abs, next] of overlay.entries()) {
    const rel = posix(path.relative(ROOT, abs));
    const before = overlay.diskText(abs);
    if (next === '\x00DELETE\x00') {
      console.log(bold(`--- a/${rel}`));
      console.log(bold(`+++ /dev/null (deleted)`));
      printUnified(lineDiff(before.split('\n'), []));
      console.log('');
      continue;
    }
    console.log(bold(`--- a/${rel}${before ? '' : ' (new file)'}`));
    console.log(bold(`+++ b/${rel}`));
    if (!printUnified(lineDiff(before.split('\n'), next.split('\n')))) console.log(dim('  (no textual change)'));
    console.log('');
  }
}

/* ------------------------------------------------------------ the harness */

// The CLI keeps the original end-of-run gate: writes collect in the overlay and
// one question at the end decides whether they reach the disk. The desktop app
// asks per write; both are the same permission engine in a different mode.
const harness = new Harness({
  root: ROOT,
  bridgeURL: BRIDGE,
  model: MODEL,
  rules: RULES,
  skills: SKILLS_DIR ? new SkillLibrary([SKILLS_DIR], { maxResult: MAX_RESULT }) : undefined,
  options: {
    maxSteps: MAX_STEPS,
    thinking: THINKING,
    allowRun: ALLOW_RUN,
    mode: 'auto',
    slim: SLIM || Boolean(ASSISTANT),
    snapshot: SNAPSHOT,
    plan: has('plan'),
    searchI: SEARCH_I,
    attach: ATTACH,
    webScratch: WEB_SCRATCH,
    parallelHelpers: PARALLEL_HELPERS,
    subagent: SUBAGENT,
    conversation: CONVERSATION,
    reuse: REUSE,
    permanent: PERMANENT,
    assistant: ASSISTANT,
    maxResult: MAX_RESULT,
    readLines: Number(flag('read-lines', 250)),
  },
  store: has('no-session') ? 'off' : undefined,
  events: undefined,
});

const { events } = harness;

events.on('assistant_delta', ({ text }) => process.stdout.write(dim(text)));
events.on('reasoning_delta', ({ text }) => processReasoning(text));
events.on('step', ({ step, maxSteps, elapsed }) => {
  flushThought();
  console.log(bold(`\n○ agent ${maxSteps > 0 ? `step ${step}/${maxSteps}` : `step ${step}`}`) + ' ' + dim(`(${elapsed}s)`));
});
events.on('thinking', ({ text, hasMore }) =>
  console.log(`  ${gray(hasMore ? '├── ' : '└── ')}${dim('thinking:')} ${truncate(text, 80)}`));
events.on('nudge', ({ n }) => console.log(red(`\nno marker in that reply — nudging (${n}/2)`)));
events.on('give_up', () => console.log(red('\nno marker after three replies — stopping.')));
events.on('ignore_done', () => console.log(dim('  (ignoring DONE — it came before the results it asked for)')));
events.on('step_limit', () => console.log(red('\nreached the step limit')));
events.on('budget', ({ used }) => console.log(red(`\nbudget spent — ${used}; stopping`)));
events.on('firewall_note', ({ text }) => console.log(dim(`  ${text}`)));
events.on('error', ({ message }) => { flushThought(); console.error(red(`\n${message}`)); });
events.on('tool', ({ kind, arg, ok, head, lines, isLast }) => {
  console.log(`  ${gray(isLast ? '└── ' : '├── ')}${!ok ? red('✗') : green('✓')} ${kind} ${arg} ${dim(head)}`);
  for (const line of lines) console.log(dim(`      ${line}`));
});
events.on('done_line', ({ text, extra }) => {
  console.log(`  ${gray('└── ')}${green('✓')} ${text}`);
  if (extra) console.log(extra);
});
events.on('finished', ({ credits: after, spent }) => {
  if (!after) return;
  const spentTxt = spent > 0 ? `${credits(spent)} this run · ` : '';
  console.log(dim(`\ncredits  ${spentTxt}${credits(after.available)} of ${credits(after.limit)} left`));
});
const credits = (n) => n.toLocaleString('en-US', { maximumFractionDigits: n < 100 ? 2 : 0 });

let rl = null;
let rlEnded = false;
let awaiting = null;

async function prompt(text) {
  if (rlEnded) return null;
  if (!rl) {
    const { createInterface } = await import('node:readline');
    rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.on('close', () => { rlEnded = true; const settle = awaiting; awaiting = null; settle?.(null); });
  }
  return new Promise((resolve) => {
    awaiting = resolve;
    rl.question(text, (answer) => { awaiting = null; resolve(answer); });
  });
}

const canPrompt = () => Boolean(process.stdin.isTTY) || !WATCH;

/* ------------------------------------------------------------------- main */

await harness.prepareConversation();
const bridgeStatus = await fetch(`${BRIDGE}/status`).then((r) => r.json()).catch(() => null);

console.log(bold('root  ') + ROOT);
console.log(bold('mode  ') + (APPLY ? green('APPLY — files will be written') : 'dry run (pass --apply to write)'));
console.log(bold('chat  ') + (bridgeStatus?.conversation ?? 'resolves on first message') +
  dim(CONVERSATION ? '  (continuing)' : REUSE ? '  (reusing the most recent)' : PERMANENT ? '  (new)' : '  (new, temporary)') +
  (ASSISTANT ? dim(`  · assistant ${ASSISTANT}`) : ''));
console.log(bold('think ') + (THINKING === 'off' ? dim('off') : THINKING));

const runOne = async (text, first) => {
  await harness.run(text, { first });
  const overlay = harness.overlay;
  showDiff(overlay);
  if (!overlay.size) return;
  if (APPLY) {
    const { written, deleted } = harness.apply(null);
    const parts = [written ? `wrote ${written} file(s)` : '', deleted ? `deleted ${deleted} file(s)` : ''].filter(Boolean);
    console.log(green(`\n${parts.join(', ') || 'done'} to disk`));
    return;
  }

  const answer = canPrompt() ? await prompt(bold(`\napply ${overlay.size} change(s)? [y/N] `)) : null;
  if (answer === null) console.log(dim('\ndry run — nothing written. re-run with --apply'));
  else if (/^y(es)?$/i.test(answer.trim())) {
    const { written, deleted } = harness.apply(null);
    const parts = [written ? `wrote ${written} file(s)` : '', deleted ? `deleted ${deleted} file(s)` : ''].filter(Boolean);
    console.log(green(`\n${parts.join(', ') || 'done'} to disk`));
  }
  else console.log(dim('nothing written.'));
  harness.discard();
};

await runOne(task, true);

if (WATCH) {
  console.log(dim('\n— watching. type another task, or press Ctrl+C to stop —'));
  for (;;) {
    const raw = await prompt(bold('\ntask> '));
    if (raw === null) break;
    const line = raw.trim();
    if (line === 'exit' || line === 'quit') break;
    if (line) await runOne(line, false);
  }
  rl?.close();
  console.log(dim('\ndone.'));
}
