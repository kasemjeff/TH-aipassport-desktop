#!/usr/bin/env node
// npm run evals — run task fixtures against the harness and score the applied tree.
//
// The contract is SPEC_EVALS.md:
//
//   evals/tasks/<id>/     task.md (the only thing the agent sees), task.json
//                         (check + budget + allowRun), tree/ (the fixture)
//   evals/holdout/<id>/   same shape; reported separately, never used to iterate
//   evals/thai/<id>/      same shape, plus `lang` (th|en) and `pair` keys —
//                         the Thai/English pair set the Thai round added
//   evals/results/        one JSONL per run — one row per attempt
//
// One attempt is: copy tree/ into a throwaway dir, drive the Harness facade
// in-process (mode 'auto': writes stage, shell follows allowRun), apply the
// overlay, then run the task's own check command in the applied copy. Exit 0
// is the only "solved" — no model self-report, no judge.
//
// Modes:
//   live   — the real model through the user's bridge on 8787. Refuses to run
//            without --live; one temporary conversation per attempt; a 429,
//            timeout or missing tab marks the attempt invalid, not unsolved.
//   replay — a recorded transcript answers in order (StubBridge, the
//            harness-fixes.test.mjs pattern). Offline, for CI. Every row
//            carries a fingerprint (task bytes + preamble bytes + reply
//            count); a mismatch marks the row stale instead of scoring it.
//
// Main-guarded with exported helpers, like stats.mjs, so the suite can import it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Harness } from '../aipass-bridge/harness/harness.mjs';
import { BridgeClient } from '../aipass-bridge/harness/bridge.mjs';
import { SessionStore } from '../aipass-bridge/harness/session.mjs';
import { Emitter } from '../aipass-bridge/harness/events.mjs';
import { preamble } from '../aipass-bridge/harness/protocol.mjs';
import { thaiRatio } from '../aipass-bridge/harness/lang.mjs';

export const EVALS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'evals');
export const DEFAULT_CHECK_TIMEOUT_MS = 60_000;
// The loop has no wall cap (HARNESS_DESIGN.md keeps hard caps on the
// not-shipped list), so the runner adds one: cancel the run and mark the
// attempt invalid rather than let a hung tab hold the whole matrix.
export const DEFAULT_WALL_MS = 10 * 60_000;
const THINKING_LEVELS = ['off', 'low', 'medium', 'high', 'max'];

/** A runner-level failure with a name tests (and users) can match on. */
export class EvalError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EvalError';
  }
}

/** A task that could not be loaded, naming the file at fault. */
export class EvalTaskError extends EvalError {
  constructor(message) {
    super(message);
    this.name = 'EvalTaskError';
  }
}

// Windows editors hand out UTF-8 with a BOM; JSON.parse refuses the marker.
// The file is JSON either way, so the marker is stripped before parsing.
const parseJson = (text) => JSON.parse(String(text).replace(/^\uFEFF/, ''));

/* ----------------------------------------------------------------- tasks */

// Line endings normalise on read: a checkout that rewrites CRLF must not
// move the replay fingerprint (bytes counted on LF), and the model seeing
// LF instead of CRLF changes nothing about the task.
const lf = (text) => String(text).replace(/\r\n/g, '\n');

function readBudget(raw, id) {
  const budget = { model: null, thinking: 'low', maxSteps: 10, wallMs: null };
  if (raw == null) return budget;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new EvalTaskError(`task ${id}: budget must be an object`);
  }
  if (raw.model != null) {
    const model = String(raw.model).trim();
    if (!model) throw new EvalTaskError(`task ${id}: budget.model must be a model id`);
    budget.model = model;
  }
  if (raw.thinking != null) {
    const thinking = String(raw.thinking).toLowerCase();
    if (!THINKING_LEVELS.includes(thinking)) {
      throw new EvalTaskError(`task ${id}: budget.thinking must be one of ${THINKING_LEVELS.join(', ')}`);
    }
    budget.thinking = thinking;
  }
  if (raw.maxSteps != null) {
    const n = Number(raw.maxSteps);
    if (!Number.isInteger(n) || n < 1) throw new EvalTaskError(`task ${id}: budget.maxSteps must be a positive integer`);
    budget.maxSteps = n;
  }
  if (raw.wallMs != null) {
    const n = Number(raw.wallMs);
    if (!Number.isFinite(n) || n <= 0) throw new EvalTaskError(`task ${id}: budget.wallMs must be a positive number`);
    budget.wallMs = n;
  }
  return budget;
}

function readTask(dir, id, kind) {
  if (!fs.existsSync(dir)) throw new EvalTaskError(`task ${id}: no such directory: ${dir}`);
  const taskMd = path.join(dir, 'task.md');
  if (!fs.existsSync(taskMd)) throw new EvalTaskError(`task ${id}: no task.md in ${dir}`);
  const taskText = lf(fs.readFileSync(taskMd, 'utf8'));
  if (!taskText.trim()) throw new EvalTaskError(`task ${id}: task.md is empty`);

  const taskJson = path.join(dir, 'task.json');
  if (!fs.existsSync(taskJson)) throw new EvalTaskError(`task ${id}: no task.json in ${dir}`);
  let spec;
  try {
    spec = parseJson(fs.readFileSync(taskJson, 'utf8'));
  } catch (err) {
    throw new EvalTaskError(`task ${id}: task.json is not valid JSON — ${err.message}`);
  }
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new EvalTaskError(`task ${id}: task.json must be an object`);
  }
  if (typeof spec.check !== 'string' || !spec.check.trim()) {
    throw new EvalTaskError(`task ${id}: task.json names no check command`);
  }

  const tree = path.join(dir, 'tree');
  if (!fs.existsSync(tree) || !fs.statSync(tree).isDirectory()) {
    throw new EvalTaskError(`task ${id}: no tree/ directory in ${dir}`);
  }

  return {
    id,
    kind,
    dir,
    taskText,
    check: spec.check.trim(),
    allowRun: spec.allowRun === true,
    // Extra keys are the suite's business, not the runner's: the Thai set
    // ships `lang` (th|en) and `pair` (the pair id) and the runner passes
    // them to the row for the report, without ever validating them.
    lang: typeof spec.lang === 'string' ? spec.lang : null,
    pair: typeof spec.pair === 'string' ? spec.pair : null,
    budget: readBudget(spec.budget, id),
  };
}

/**
 * Load one task. `ref` is either an id under `evals/<kind>/` or a path to a
 * task directory (tests build tasks in temp dirs this way).
 */
export function loadTask(ref, { evalsDir = EVALS_DIR, kind = 'tasks', id = null } = {}) {
  const looksLikePath = path.isAbsolute(ref) || /[\\/]/.test(ref);
  if (looksLikePath) {
    const dir = path.resolve(ref);
    return readTask(dir, id ?? path.basename(dir), kind);
  }
  return readTask(path.join(evalsDir, kind, ref), id ?? ref, kind);
}

/** Every task under `evals/<kind>/`, sorted by directory name. */
export function listTasks({ evalsDir = EVALS_DIR, kind = 'tasks' } = {}) {
  const base = path.join(evalsDir, kind);
  let names = [];
  try {
    names = fs.readdirSync(base).sort();
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    let isDir = false;
    try {
      isDir = fs.statSync(path.join(base, name)).isDirectory();
    } catch { /* skip unreadable entries */ }
    if (!isDir) continue;
    if (!fs.existsSync(path.join(base, name, 'task.json'))) continue;
    out.push(readTask(path.join(base, name), name, kind));
  }
  return out;
}

/** One id from any set: `tasks/` first, then `holdout/`, then `thai/`. */
export function resolveTask(ref, { evalsDir = EVALS_DIR } = {}) {
  if (path.isAbsolute(ref) || /[\\/]/.test(ref)) return loadTask(ref, { evalsDir });
  for (const kind of ['tasks', 'holdout', 'thai']) {
    if (fs.existsSync(path.join(evalsDir, kind, ref, 'task.json'))) {
      return readTask(path.join(evalsDir, kind, ref), ref, kind);
    }
  }
  throw new EvalTaskError(`no task named "${ref}" under ${evalsDir}/tasks, /holdout or /thai`);
}

/* ------------------------------------------------------------ transcripts */

/**
 * A recorded reply sequence. Strings are the replies as the model wrote them
 * (the session's `assistant` entries, raw — the loop decodes exactly those
 * bytes); `{text}` objects are accepted so a session file's entries can be
 * pasted in directly. `fingerprint` is what the recording was made against.
 */
export function loadTranscript(ref) {
  const file = path.resolve(ref);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new EvalError(`transcript not found: ${file} (${err.message})`);
  }
  let parsed;
  try {
    parsed = parseJson(raw);
  } catch (err) {
    throw new EvalError(`transcript ${file} is not valid JSON — ${err.message}`);
  }
  const replies = Array.isArray(parsed?.replies)
    ? parsed.replies.map((r) => (typeof r === 'string' ? r : (r && typeof r.text === 'string' ? r.text : null)))
    : [];
  if (!replies.length) throw new EvalError(`transcript ${file} carries no replies[]`);
  if (replies.some((r) => r === null)) {
    throw new EvalError(`transcript ${file}: every reply must be a string or { text }`);
  }
  return {
    file,
    taskId: typeof parsed.taskId === 'string' ? parsed.taskId : null,
    replies,
    fingerprint: parsed.fingerprint && typeof parsed.fingerprint === 'object' ? parsed.fingerprint : null,
  };
}

/* ---------------------------------------------------------------- budgets */

/** Parse `--budget maxSteps=10,model=…,thinking=low` into an override object. */
export function parseBudget(text) {
  const out = {};
  for (const part of String(text).split(',')) {
    const piece = part.trim();
    if (!piece) continue;
    const at = piece.indexOf('=');
    if (at === -1) throw new EvalError(`--budget expects key=value pairs, got ${JSON.stringify(piece)}`);
    const key = piece.slice(0, at).trim();
    const value = piece.slice(at + 1).trim();
    if (key === 'maxSteps') {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1) {
        throw new EvalError(`--budget maxSteps must be a positive integer, got ${JSON.stringify(value)}`);
      }
      out.maxSteps = n;
    } else if (key === 'model') {
      if (!value) throw new EvalError('--budget model needs a model id');
      out.model = value;
    } else if (key === 'thinking') {
      const level = value.toLowerCase();
      if (!THINKING_LEVELS.includes(level)) {
        throw new EvalError(`--budget thinking must be one of ${THINKING_LEVELS.join(', ')}`);
      }
      out.thinking = level;
    } else {
      throw new EvalError(`--budget knows maxSteps, model, thinking — not ${JSON.stringify(key)}`);
    }
  }
  return out;
}

/* -------------------------------------------------------------- fingerprint */

/**
 * What a replay was recorded against: task bytes + preamble bytes + reply
 * count, hashed into one digest. Line endings normalise so a checkout that
 * rewrites CRLF does not read as a change; everything else moves the digest,
 * and a moved digest marks the row stale instead of scoring it.
 */
export function fingerprintOf({ taskText = '', preambleText = '', replyCount = 0 } = {}) {
  const taskBytes = Buffer.byteLength(lf(taskText), 'utf8');
  const preambleBytes = Buffer.byteLength(lf(preambleText), 'utf8');
  const replies = Number(replyCount) || 0;
  const digest = createHash('sha256')
    .update(`task:${taskBytes}\npreamble:${preambleBytes}\nreplies:${replies}`)
    .digest('hex')
    .slice(0, 16);
  return { taskBytes, preambleBytes, replies, digest };
}

/* ------------------------------------------------------------- stub bridge */

/**
 * Answers chat() in order from a recorded transcript — the
 * harness-fixes.test.mjs stub pattern, extended for the methods the Harness
 * facade calls around the loop. Nothing here ever touches the network.
 */
export function replayBridge(replies = [], { model = null } = {}) {
  const bridge = new BridgeClient('http://127.0.0.1:1', { model });
  bridge.model = model ?? null;
  bridge.sends = [];
  let turn = 0;
  let conversations = 0;
  bridge.chat = async (opts = {}) => {
    bridge.sends.push({
      message: opts.message ?? '',
      model: opts.model ?? bridge.model,
      thinkingLevel: opts.thinkingLevel ?? null,
      conversation: opts.conversation ?? null,
    });
    // Beyond the transcript the last reply repeats (the scripted() pattern):
    // an extra step is a run that needs more model than was recorded.
    const text = replies.length ? String(replies[Math.min(turn, replies.length - 1)]) : '';
    turn += 1;
    if (typeof opts.onText === 'function') opts.onText(text);
    return { text, reasoning: '' };
  };
  bridge.createConversation = async () => ({ id: `replay-conv-${++conversations}` });
  bridge.status = async () => ({ conversation: `replay-conv-${conversations || 1}` });
  bridge.config = async () => {};
  bridge.quota = async () => ({ available: 1000, limit: 1000, used: 0 });
  return bridge;
}

/* ------------------------------------------------------------------ check */

/** Spawn the task's one check command in `cwd`; exit 0 is the only pass. */
export function checkCommand(command, cwd, { timeoutMs = DEFAULT_CHECK_TIMEOUT_MS, env = null } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    let out = '';
    let settled = false;
    let timedOut = false;
    let timer = null;
    const finish = (exit) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      const text = out.trim();
      const tail = text.length > 2000 ? `…${text.slice(-2000)}` : text;
      resolve({
        command,
        exit: timedOut ? null : exit,
        ms: Date.now() - started,
        tail: timedOut ? `timed out after ${timeoutMs}ms\n${tail}`.trim() : tail,
        timedOut,
      });
    };
    let child = null;
    try {
      child = spawn(command, { cwd, shell: true, windowsHide: true, ...(env ? { env } : {}) });
    } catch (err) {
      resolve({ command, exit: null, ms: Date.now() - started, tail: `err: ${err.message}`, timedOut: false });
      return;
    }
    timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      // A shell that outlives its kill must not hold the run: resolve anyway.
      setTimeout(() => finish(null), 500).unref?.();
    }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('error', (err) => { out += `\nerr: ${err.message}`; finish(null); });
    child.on('close', (code) => finish(code));
  });
}

/* --------------------------------------------------------------- attempt */

/**
 * One attempt through the Harness facade, per SPEC_EVALS.md §2:
 * copy tree/ → temp, AIPASS_HOME + explicit store, run + apply, run the
 * check in the copy, read `run_stats` back from the attempt's session JSONL,
 * and assemble one result row. Never throws for a run that died — a failed
 * run still gets scored, and the cause decides solved/unsolved/invalid.
 */
export async function runAttempt(task, {
  mode = 'live',
  attempt = 1,
  runId = null,
  transcript = null,
  bridge = null,
  budget = null,
  checkTimeoutMs = DEFAULT_CHECK_TIMEOUT_MS,
} = {}) {
  const used = {
    model: budget?.model ?? task.budget.model ?? null,
    thinking: budget?.thinking ?? task.budget.thinking,
    maxSteps: budget?.maxSteps ?? task.budget.maxSteps,
    wallMs: budget?.wallMs ?? task.budget.wallMs ?? DEFAULT_WALL_MS,
    allowRun: Boolean(task.allowRun),
  };
  if (mode === 'replay' && !bridge) bridge = replayBridge(transcript?.replies ?? [], { model: used.model });

  const attemptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aipass-eval-'));
  const treeDir = path.join(attemptDir, 'tree');
  const homeDir = path.join(attemptDir, 'home');
  fs.cpSync(path.join(task.dir, 'tree'), treeDir, { recursive: true });

  const events = new Emitter();
  const seen = { errors: [], conversations: [], needsTab: false };
  events.on('error', (p) => seen.errors.push(String(p?.message ?? 'run error')));
  events.on('conversation', (p) => { if (p?.id) seen.conversations.push(p.id); });
  let harness = null;
  events.on('needs_tab', (p) => {
    // Probe discipline (SPEC §5): no tab means no run and no retries.
    seen.needsTab = true;
    seen.errors.push(String(p?.reason ?? 'no chat tab is open'));
    try { harness?.cancel(); } catch { /* already stopped */ }
  });

  const prevHome = process.env.AIPASS_HOME;
  process.env.AIPASS_HOME = homeDir;
  let runResult = null;
  let runError = null;
  let applied = null;
  let wallKilled = false;
  let wallTimer = null;
  const started = Date.now();
  try {
    harness = new Harness({
      root: treeDir,
      bridge: bridge ?? undefined,
      model: used.model,
      store: new SessionStore(path.join(homeDir, 'sessions')),
      events,
      options: { maxSteps: used.maxSteps, thinking: used.thinking, mode: 'auto', allowRun: used.allowRun },
    });
    wallTimer = setTimeout(() => {
      wallKilled = true;
      try { harness.cancel(); } catch { /* already stopped */ }
    }, used.wallMs);
    wallTimer.unref?.();
    try {
      runResult = await harness.run(task.taskText);
    } catch (err) {
      runError = err.message;
    }
    // Apply-then-check: the end state the CLI's one question produces. A run
    // that died still gets scored (the live smoke's write-after-429 did).
    try {
      applied = harness.apply(null);
    } catch (err) {
      runError = runError ?? err.message;
    }
  } catch (err) {
    runError = err.message;
  } finally {
    if (wallTimer) clearTimeout(wallTimer);
    if (prevHome === undefined) delete process.env.AIPASS_HOME;
    else process.env.AIPASS_HOME = prevHome;
  }
  const wallMs = Date.now() - started;
  const sessionFile = harness?.session?.file ?? null;

  const check = await checkCommand(task.check, treeDir, {
    timeoutMs: checkTimeoutMs,
    env: { ...process.env, AIPASS_HOME: homeDir },
  });

  // Read run_stats back from the file on disk, not from memory: the JSONL is
  // the source of truth stats.mjs itself reads.
  let sessionId = null;
  let stats = null;
  let compactions = 0;
  let replyThai = null;   // (Thai pack) Thai-letter share of assistant prose
  let tokensEst = null;   // (Thai pack) rough tokens for the whole conversation
  if (sessionFile && fs.existsSync(sessionFile)) {
    const stored = new SessionStore(path.join(homeDir, 'sessions')).load(sessionFile);
    if (stored) {
      sessionId = stored.id;
      compactions = stored.entries.filter((e) => e.type === 'compaction').length;
      stats = [...stored.entries].reverse().find((e) => e.type === 'run_stats') ?? null;
      // The Thai share pools every assistant entry's letters (code fences and
      // URLs excluded by thaiRatio), so long replies weigh more than one-liners.
      let thai = 0;
      let letters = 0;
      for (const e of stored.entries) {
        if (e.type !== 'assistant') continue;
        const r = thaiRatio(String(e.text ?? ''));
        thai += r.thai;
        letters += r.letters;
      }
      replyThai = letters ? thai / letters : null;
      // The compactor's own estimate — the closest thing to a token count the
      // pipeline offers without a model. The report builds tokens-per-solved
      // from this.
      try { tokensEst = harness?.compactor?.estimate(harness.session) ?? null; } catch { tokensEst = null; }
    }
  }
  const stopReason = stats?.stopReason ?? runResult?.stopReason ?? null;

  // The replay fingerprint (SPEC §5): recorded against task bytes + preamble
  // bytes + reply count. A mismatch marks the row stale instead of scoring it.
  let replayFingerprint = null;
  if (mode === 'replay' && transcript) {
    const current = fingerprintOf({
      taskText: task.taskText,
      preambleText: preamble({ allowRun: used.allowRun }),
      replyCount: transcript.replies.length,
    });
    const recorded = transcript.fingerprint;
    const stale = !recorded || recorded.digest !== current.digest;
    replayFingerprint = {
      transcript: transcript.file,
      ...current,
      recorded: recorded ?? null,
      match: !stale,
      stale,
      reason: stale
        ? (recorded
          ? 'task text, preamble or reply count changed since the transcript was recorded'
          : 'the transcript carries no recorded fingerprint')
        : null,
    };
  }

  const tools = stats?.tools ?? {};
  const total = Object.values(tools).reduce((a, s) => a + (s.n ?? 0), 0);
  const refusals = Object.values(tools).reduce((a, s) => a + (s.fail ?? 0), 0);
  const stepMs = Array.isArray(stats?.stepMs) ? stats.stepMs : [];

  // Outcome precedence: a stale replay is never scored; a check that passes is
  // solved even if the run died (the applied tree is the evidence); a check
  // that fails on a run that died of 429/timeout/tab/wall is invalid, not
  // unsolved — charging the model for the network would lie about it.
  const checkPassed = check.exit === 0;
  let outcome;
  let scored = false;
  let invalidReason = null;
  if (replayFingerprint?.stale) {
    outcome = 'stale';
  } else if (checkPassed) {
    outcome = 'solved';
    scored = true;
  } else if (seen.needsTab || wallKilled || runError || stopReason === 'error') {
    outcome = 'invalid';
    invalidReason = seen.needsTab
      ? 'needs_tab'
      : wallKilled
        ? `wall clock budget hit (${used.wallMs}ms)`
        : (runError ?? seen.errors.at(-1) ?? 'the run ended in error');
  } else {
    outcome = 'unsolved';
    scored = true;
  }

  return {
    ts: Date.now(),
    runId,
    taskId: task.id,
    kind: task.kind,
    attempt,
    mode,
    budget: used,
    outcome,
    scored,
    invalidReason,
    stopReason,
    summary: runResult?.summary ?? null,
    steps: stats?.steps ?? 0,
    turns: stepMs.length,
    stepMs,
    calls: { total, refusals, refusalRate: total ? refusals / total : 0, tools },
    nudges: stats?.nudges ?? 0,
    stagnations: stats?.stagnations ?? 0,
    verifyPrompts: stats?.verifyPrompts ?? 0,
    repeatBlocks: stats?.repeatBlocks ?? 0,
    langPrompts: stats?.langPrompts ?? 0,
    novelResults: stats?.novelResults ?? 0,
    repeatedResults: stats?.repeatedResults ?? 0,
    replyThai,
    tokensEst,
    lang: task.lang ?? null,
    pair: task.pair ?? null,
    firewallNotes: stats?.firewallNotes ?? 0,
    checks: stats?.checks ?? 0,
    checkVerdict: stats?.checkVerdict ?? null,
    spent: stats?.spent ?? null,
    wallMs,
    check: { command: check.command, exit: check.exit, ms: check.ms, tail: check.tail, timedOut: check.timedOut },
    session: { id: sessionId, file: sessionFile },
    conversations: [...new Set(seen.conversations.concat(harness?.conversation ? [harness.conversation] : []))],
    compactions,
    applied: applied?.files?.length ?? 0,
    replayFingerprint,
    wallKilled,
    errors: seen.errors.slice(0, 10),
    attemptDir,
  };
}

/* ------------------------------------------------------------------- runs */

/**
 * Run a set of tasks sequentially (the bridge holds one current conversation,
 * so two attempts in flight would have to be separate processes) and append
 * one JSONL row per attempt to `evals/results/<runId>.jsonl`.
 *
 * `bridgeFor(task, attempt)` overrides how a bridge is made per attempt —
 * replay uses it for a fresh StubBridge so each attempt starts its transcript
 * from reply one. Without it: live builds the real client (bridge null lets
 * the Harness mint one), replay builds a stub from `transcript.replies`.
 */
export async function runEval({
  tasks = [],
  mode = 'live',
  transcript = null,
  budget = null,
  bridgeFor = null,
  resultsDir = null,
  checkTimeoutMs = DEFAULT_CHECK_TIMEOUT_MS,
  pauseMs = 0,
  log = null,
} = {}) {
  const list = tasks.map((t) => (typeof t === 'string' ? resolveTask(t) : t));
  if (!list.length) throw new EvalError('no tasks to run');
  const dir = resultsDir ? path.resolve(resultsDir) : path.join(EVALS_DIR, 'results');
  fs.mkdirSync(dir, { recursive: true });
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 23)}-${mode}`;
  const resultsFile = path.join(dir, `${runId}.jsonl`);

  const rows = [];
  for (let i = 0; i < list.length; i++) {
    const task = list[i];
    const attempt = i + 1;
    const bridge = bridgeFor
      ? bridgeFor(task, attempt)
      : (mode === 'replay' && transcript
        ? replayBridge(transcript.replies, { model: budget?.model ?? task.budget.model ?? null })
        : null);
    const row = await runAttempt(task, {
      mode,
      attempt,
      runId,
      transcript: mode === 'replay' ? transcript : null,
      bridge,
      budget,
      checkTimeoutMs,
    });
    rows.push(row);
    fs.appendFileSync(resultsFile, JSON.stringify(row) + '\n');
    const checkText = row.check.exit == null ? '×' : row.check.exit;
    log?.(`  ${task.kind}/${task.id}: ${row.outcome} (stop ${row.stopReason ?? '-'}, check ${checkText})`);
    // The account's edge rate-limits bursts (Cloudflare 429): attempts fired
    // back to back can outrun it and a live set dies mid-run. The extension
    // retries an in-flight 429; the pause keeps the burst from starting.
    if (pauseMs && i < list.length - 1) await new Promise((resolve) => setTimeout(resolve, pauseMs));
  }
  return { runId, resultsFile, rows };
}

/* ---------------------------------------------------------------- summary */

/** The stdout table from SPEC §2: task, outcome, stop, turns, calls, … */
export function formatSummary(rows = []) {
  const labels = ['task', 'outcome', 'stop', 'turns', 'calls', 'nudges', 'stag', 'verify', 'fw', 'credits', 'wall'];
  const numeric = new Set(['turns', 'calls', 'nudges', 'stag', 'verify', 'fw', 'credits', 'wall']);
  const table = rows.map((r) => ({
    task: `${r.taskId}${r.kind === 'holdout' ? ' *' : ''}`,
    outcome: r.outcome,
    stop: r.stopReason ?? '-',
    turns: String(r.turns ?? 0),
    calls: `${r.calls?.total ?? 0}${r.calls?.refusals ? ` (${r.calls.refusals}✗)` : ''}`,
    nudges: String(r.nudges ?? 0),
    stag: String(r.stagnations ?? 0),
    verify: String(r.verifyPrompts ?? 0),
    fw: String(r.firewallNotes ?? 0),
    credits: r.spent == null ? '-' : String(r.spent),
    wall: `${((r.wallMs ?? 0) / 1000).toFixed(1)}s`,
  }));

  const width = {};
  for (const key of labels) width[key] = Math.max(key.length, ...table.map((t) => String(t[key]).length));
  const cell = (key, value) => (numeric.has(key) ? String(value).padStart(width[key]) : String(value).padEnd(width[key]));

  const lines = [labels.map((k) => cell(k, k)).join('  ')];
  for (const t of table) lines.push(labels.map((k) => cell(k, t[k])).join('  '));

  const count = (outcome) => rows.filter((r) => r.outcome === outcome).length;
  const calls = rows.reduce((a, r) => a + (r.calls?.total ?? 0), 0);
  const refusals = rows.reduce((a, r) => a + (r.calls?.refusals ?? 0), 0);
  const credits = rows.reduce((a, r) => a + (r.spent ?? 0), 0);
  const wallMs = rows.reduce((a, r) => a + (r.wallMs ?? 0), 0);
  lines.push('');
  lines.push(`totals: ${rows.length} attempt(s) — ${count('solved')} solved · ${count('unsolved')} unsolved · `
    + `${count('invalid')} invalid · ${count('stale')} stale · calls ${calls}${refusals ? ` (${refusals} refused)` : ''} · `
    + `credits ${credits} · wall ${(wallMs / 1000).toFixed(1)}s`);
  // (Thai pack) The numbers the round asked the suite to measure: success rate,
  // tool-call error rate, loop count, tokens per solved task, and how much of
  // the replies came back Thai. Over scored rows only — an invalid run is the
  // network's fault, not the model's.
  const scoredRows = rows.filter((r) => r.scored);
  const solvedRows = scoredRows.filter((r) => r.outcome === 'solved');
  const rate = (n, d) => (d ? `${Math.round((n / d) * 100)}%` : '—');
  const repeatBlocks = rows.reduce((a, r) => a + (r.repeatBlocks ?? 0), 0);
  const turns = rows.reduce((a, r) => a + (r.turns ?? 0), 0);
  const nudged = rows.filter((r) => (r.langPrompts ?? 0) > 0).length;
  const withThai = rows.filter((r) => r.replyThai != null);
  const thaiShare = withThai.length
    ? withThai.reduce((a, r) => a + r.replyThai, 0) / withThai.length : null;
  const solvedTokens = solvedRows.filter((r) => r.tokensEst != null);
  lines.push(`metrics: success ${rate(solvedRows.length, scoredRows.length)} (${solvedRows.length}/${scoredRows.length} scored)`
    + ` · tool errors ${rate(refusals, calls)}`
    + ` · turns ${turns} · repeat-blocks ${repeatBlocks} · lang-nudges ${nudged}`
    + (thaiShare == null ? '' : ` · replies in Thai ${Math.round(thaiShare * 100)}%`)
    + (solvedTokens.length
      ? ` · tokens/solved ≈ ${Math.round(solvedTokens.reduce((a, r) => a + r.tokensEst, 0) / solvedTokens.length).toLocaleString('en-US')}`
      : ''));
  if (rows.some((r) => r.kind === 'holdout')) {
    lines.push('* holdout — reported separately, never the reason a commit lands');
  }
  return lines.join('\n');
}

/* ------------------------------------------------------------------- CLI */

const USAGE = `aipass evals — score the applied tree of task fixtures with a real check command

usage:
  npm run evals -- --task ID --live [options]
  npm run evals -- --all --live [options]
  npm run evals -- --replay evals/fixtures/math-fix-replay.json [options]

modes
  --live               run the real model through the user's bridge on 8787
                       (requires a logged-in chat tab; one temporary
                       conversation per attempt; --live is always required)
  --replay FILE        answer from a recorded transcript instead of the model;
                       offline, no network. A task, preamble or reply-count
                       change marks the row stale instead of scoring it.

selection
  --task ID            one task by id (repeatable); looked up under
                       evals/tasks/ then evals/holdout/
  --all                every task under evals/tasks/ (the smoke set)
  --holdout            every task under evals/holdout/ (reported separately)
  --thai               every task under evals/thai/ (the Thai/English pair set)

options
  --budget a=b,c=d     global budget override — maxSteps, model, thinking
  --pause MS           wait MS between attempts — a live burst trips the
                       account edge's 429; the extension's retry covers the rest
  --results DIR        where this run's JSONL lands (default evals/results/)
  --advisory           exit 0 even when checks fail (watching, not gating)
  --help               this text

exit codes: 0 only when every scored check passed; 1 when one did not;
2 for a bad flag or a refused live run.`;

/** Split argv into the runner's flags. Unknown flags are errors, not typos
 *  that quietly do nothing. */
export function parseArgs(argv) {
  const opts = {
    tasks: [], all: false, holdout: false, thai: false, replay: null, live: false,
    advisory: false, help: false, results: null, budget: null, pause: 0,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
    const name = eq === -1 ? arg : arg.slice(0, eq);
    const inline = eq === -1 ? undefined : arg.slice(eq + 1);
    const next = () => {
      if (inline !== undefined) return inline;
      const value = argv[++i];
      if (value === undefined) throw new EvalError(`${name} needs a value`);
      return value;
    };
    if (name === '--help' || name === '-h') opts.help = true;
    else if (name === '--task') opts.tasks.push(next());
    else if (name === '--all') opts.all = true;
    else if (name === '--holdout') opts.holdout = true;
    else if (name === '--thai') opts.thai = true;
    else if (name === '--replay') opts.replay = next();
    else if (name === '--live') opts.live = true;
    else if (name === '--advisory') opts.advisory = true;
    else if (name === '--results') opts.results = next();
    else if (name === '--budget') opts.budget = next();
    else if (name === '--pause') {
      const ms = Number(next());
      if (!Number.isFinite(ms) || ms < 0) throw new EvalError('--pause needs milliseconds, e.g. --pause 10000');
      opts.pause = ms;
    }
    else throw new EvalError(`unknown flag ${JSON.stringify(arg)} — --help lists what exists`);
  }
  return opts;
}

function dedupe(tasks) {
  const seen = new Set();
  return tasks.filter((t) => {
    const key = `${t.kind}/${t.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(USAGE);
    return 0;
  }
  if (opts.live && opts.replay) {
    console.error('--live and --replay are exclusive: a run is either the real model or a transcript');
    return 2;
  }

  const mode = opts.replay ? 'replay' : 'live';
  const transcript = opts.replay ? loadTranscript(opts.replay) : null;
  const tasks = [];
  for (const id of opts.tasks) tasks.push(resolveTask(id));
  if (opts.all) tasks.push(...listTasks({ kind: 'tasks' }));
  if (opts.holdout) tasks.push(...listTasks({ kind: 'holdout' }));
  if (opts.thai) tasks.push(...listTasks({ kind: 'thai' }));
  if (!tasks.length && transcript) {
    if (!transcript.taskId) {
      throw new EvalError(`--replay ${opts.replay} names no taskId and no --task was given`);
    }
    tasks.push(resolveTask(transcript.taskId));
  }
  if (!tasks.length) {
    console.error('nothing selected — pass --task ID, --all, --holdout or --thai (--help for details)');
    return 2;
  }
  if (mode === 'live' && !opts.live) {
    console.error('live runs use the real bridge on 8787 and the logged-in tab.');
    console.error('pass --live to confirm, or --replay FILE for the offline mode.');
    return 2;
  }

  const budget = opts.budget ? parseBudget(opts.budget) : null;
  const resultsDir = opts.results ? path.resolve(opts.results) : null;
  if (mode === 'live') {
    console.log('live mode: one temporary conversation per attempt; the attempt session file in each row is the evidence');
  }
  const { resultsFile, rows } = await runEval({
    tasks: dedupe(tasks),
    mode,
    transcript,
    budget,
    resultsDir,
    pauseMs: opts.pause,
    log: (line) => console.log(line),
  });
  console.log(formatSummary(rows));
  console.log(`results: ${resultsFile}`);

  const green = rows.length > 0 && rows.every((r) => r.outcome === 'solved' || r.outcome === 'stale');
  if (!green && !opts.advisory) return 1;
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }).catch((err) => {
    console.error(`${err.name ?? 'error'}: ${err.message}`);
    process.exitCode = 2;
  });
}
