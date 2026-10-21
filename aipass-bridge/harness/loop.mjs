// The run loop — the piece the original agent.mjs was.
//
// Shape of one turn, unchanged from the protocol that was tuned against the
// upstream edge:
//
//   send (preamble + task) → model replies with markers → run them all →
//   send the results as ONE new user message → … → DONE
//
// Differences from the original, all forced by what a desktop UI needs:
//   - every step emits events instead of printing, so the same loop drives a
//     terminal, a window, or a test
//   - writes pass a permission gate (ask / auto / yolo) before they land in the
//     overlay, rather than all-or-nothing at the end of the run
//   - PLAN / TODO / SUBAGENT markers exist on top of the original set
import fs from 'node:fs';
import path from 'node:path';
import { outbound } from './waf.mjs';
import { parseSources } from './web-sources.mjs';
import {
  REMINDER, REMINDER_HEAD, REMINDER_TAIL, prose, parse, parseTodo, mergeTodo, READING, attemptedMarker,
  preamble as buildPreamble,
} from './protocol.mjs';
import { resilientSay, decode, recoverWaits, sendRecoverable, waitLabel } from './bridge.mjs';
import { classify, classifyPlugin, isGitCommit } from './permissions.mjs';
import { posix } from './overlay.mjs';
import { thaiRatio } from './lang.mjs';
import { PATHY, pathVariants, beYearNote } from './argguard.mjs';
import { validateCall } from './validate.mjs';
import { DEFAULT_MAX_TOOL_CALLS, DEFAULT_MAX_WALL_CLOCK_MS } from './settings.mjs';

/** A pause the loop itself takes — the recovery waits between send attempts. */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// (R1/R4) The research round's two sets: which call kinds change the overlay,
// and which files count as code for the verification nudge.
const MUTATING = new Set(['write', 'replace', 'delete', 'move']);
const CODE_FILE = /\.(m?js|cjs|tsx?|jsx|py|rb|go|rs|java|cs|php|swift|kt|c|h|cpp|hpp|sh|ps1|css|html?|sql)$/i;

// (chain guard) After a change has failed in the same reply, only calls whose
// outcome cannot touch the tree keep running — reads, git, web, control
// markers. Another edit or a RUN would act on the state the reply was planned
// against, and one real error cascading into three consequential ones is how
// a step gets lost. (Research round, after the false-success findings.)
const SURVIVES_FAILURE = (kind) => !MUTATING.has(kind) && kind !== 'run';

/**
 * (research) The signature of one failure, for the err-loop guard: the first
 * line of the error, lowercased, with the call's own argument (and a RUN's
 * command) masked out, then any path-shaped tokens. Three different missing
 * files — or three spellings of the same broken command — collapse to one
 * key; a genuinely different failure keeps its own.
 *
 * Only whole tokens of at least four characters are masked. A short, ordinary
 * argument ("not", "the") must not erase that word from the error text, or two
 * unrelated failures could be counted as the same kind.
 */
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function errKindOf(call, text) {
  let line = String(text).split('\n')[0].toLowerCase().slice(0, 200);
  const bits = [String(call.arg ?? ''), call.kind === 'run' ? String(call.body ?? '').split('\n')[0] : '']
    .map((b) => b.trim().toLowerCase())
    .filter((b) => b.length >= 4);
  for (const b of bits) {
    const token = new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(b)}(?![\\p{L}\\p{N}_])`, 'gu');
    line = line.replace(token, '<arg>');
  }
  return `${call.kind}::${line.replace(/[\w.\\/:-]*[\\/][\w.\\/:-]*/g, '<path>').replace(/\s+/g, ' ').trim()}`;
}

const previewOf = (call) => {
  if (call.kind === 'replace') return String(call.body?.[1] ?? '').slice(0, 4000);
  if (call.body) return String(call.body).slice(0, 4000);
  return '';
};

/**
 * (bootstrap snapshot) What a run otherwise learns one round trip at a time:
 * the git working-tree state (read-only, through the same GIT tool the model
 * has) and the package.json scripts. Both reads are bounded and both failures
 * are silent — a head start, never a blocker — and the caller places the result
 * in turn 1 only. The desktop harness enables it by default; the CLI offers
 * `--snapshot`.
 */
export async function bootstrapSnapshot(tools, root) {
  const parts = [];
  try {
    const status = String(await tools.git('status --short')).trim();
    if (status && !/^err:/i.test(status)) {
      const lines = status.split('\n');
      const shown = lines.slice(0, 15).map((l) => `  ${l}`).join('\n');
      parts.push(`git status:\n${shown}${lines.length > 15 ? `\n  … ${lines.length - 15} more file(s)` : ''}`);
    } else if (!status) {
      parts.push('git status: clean — nothing uncommitted');
    }
  } catch { /* not a repository, or git is absent — the snapshot skips it */ }
  try {
    const pkg = JSON.parse(await fs.promises.readFile(path.join(root, 'package.json'), 'utf8'));
    const scripts = Object.entries(pkg.scripts ?? {}).filter(([, v]) => typeof v === 'string').slice(0, 12);
    if (scripts.length) parts.push(`package scripts:\n${scripts.map(([k, v]) => `  ${k}: ${v}`).join('\n')}`);
  } catch { /* no package.json — the snapshot skips it */ }
  const text = parts.join('\n');
  return text.length > 1500 ? `${text.slice(0, 1500)}…` : text;
}

/**
 * The length of the cycle a window of step signatures closes, or 0.
 *
 * A run that cannot move has a shape. The same step again and again is one;
 * two steps trading places is another (the old oscillation); and a run can
 * also go round a longer circle — read file A, edit file B, run the test,
 * read file A again, edit file B again — where every single step looks new
 * and the whole round trip goes nowhere. The two-state case is left where it
 * was; this finds the longer ones.
 *
 * A cycle of length p is the last p+1 signatures where the first and the
 * last are the same and the p in between are all different from each other —
 * a round, not a palindrome. The signatures carry the results, so the states
 * that repeat are the ones that returned the same answer.
 *
 * @param {string[]} window the step signatures, oldest first, the current one last
 * @param {number} [minPeriod] the shortest cycle to look for
 * @returns {number} the period, or 0 when the window closes no cycle
 */
export function cycleLength(window, minPeriod = 3) {
  const sigs = Array.isArray(window) ? window : [];
  const n = sigs.length;
  for (let p = minPeriod; p < n; p++) {
    if (sigs[n - 1] !== sigs[n - 1 - p]) continue;
    const states = sigs.slice(n - 1 - p, n - 1);
    if (new Set(states).size === states.length) return p; // every state different
  }
  return 0;
}

/**
 * Normalize the loose option sheet once, before a run touches state. Pure:
 * every clamp and default lives here, so the loop body reads typed values and
 * a test can pin the policy without a bridge, a tool set or a session.
 */
export function normalizeOptions(options = {}) {
  // The step cap, or no cap at all: 0 (the shipped default) means the
  // run goes until it is DONE, a guard stops it, or a budget below is spent. A
  // positive number caps the run, and the last step says so (step_limit).
  const rawCap = Number(options.maxSteps ?? 0);
  const maxSteps = Number.isFinite(rawCap) && rawCap > 0 ? Math.floor(rawCap) : Infinity;
  // 0 on the wire means "no cap" — Infinity does not survive JSON, so events
  // carry the option as the surfaces know it.
  const maxStepsWire = Number.isFinite(maxSteps) ? maxSteps : 0;
  // Per-run budgets — the defaults are imported from the settings file so the
  // fallback and the shipped setting can never drift apart. A reply full of
  // markers used to execute every one of them, and a yolo RUN can hold one
  // step open for minutes; either budget spent stops the run with its own stop
  // reason in run_stats — the real bound once the step cap is off.
  const maxToolCalls = Number(options.maxToolCalls) > 0
    ? Math.floor(Number(options.maxToolCalls)) : DEFAULT_MAX_TOOL_CALLS;
  const maxWallClockMs = Number(options.maxWallClockMs) > 0
    ? Math.floor(Number(options.maxWallClockMs)) : DEFAULT_MAX_WALL_CLOCK_MS;
  // (credit cap) Optional ceiling on observed spend, in credits. 0 = no cap.
  // The check rides the bridge's cached quota (its own 30s TTL), so it bounds
  // a runaway run without turning into an upstream request per step.
  const maxCredits = Number(options.maxCredits) > 0 ? Number(options.maxCredits) : 0;
  const model = options.model ?? null;
  // How hard the model thinks before each reply. 'off' (or nothing) means the
  // request never asks; the level that does go out is checked by the bridge
  // against the model, so a level it lacks never breaks a run.
  const thinking = options.thinking && String(options.thinking).toLowerCase() !== 'off'
    ? String(options.thinking).toLowerCase() : null;
  // Sampling temperature: a number 0..2 rides every send; anything else (the
  // null default included) never asks, so the server's own default stands.
  const temperature = typeof options.temperature === 'number' && Number.isFinite(options.temperature)
    ? Math.min(2, Math.max(0, options.temperature)) : null;
  const useSlim = Boolean(options.slim);
  const seedText = options.seedText ?? null;
  const pluginTools = options.pluginTools ?? [];
  // (Thai pack) Language policy. `replyLanguage` is what the preamble tells
  // the model; `langCheck` is the stop hook that measures it — the closing
  // message's share of Thai letters (code and URLs excluded) must reach
  // `minThaiRatio`, or the run rewrites it once. Tool vocabulary stays
  // English regardless; that separation is the whole point.
  const replyLanguage = options.replyLanguage === 'en' ? 'en' : 'th';
  const langCheck = Boolean(options.langCheck);
  const minThaiRatio = Number.isFinite(Number(options.minThaiRatio))
    ? Math.min(1, Math.max(0, Number(options.minThaiRatio))) : 0.4;
  // (Thai pack) The pre-tool guard. repeatGuard refuses an identical call
  // (same kind, argument and body) already made twice with nothing staged in
  // between — a loop, not a step; repeatGuardMax is how many such refusals
  // one run may collect before it is stopped as stalled.
  const repeatGuard = Boolean(options.repeatGuard);
  const repeatGuardMax = Number(options.repeatGuardMax) > 0 ? Math.floor(Number(options.repeatGuardMax)) : 4;
  return {
    maxSteps, maxStepsWire, maxToolCalls, maxWallClockMs, maxCredits,
    model, thinking, temperature, useSlim, seedText, pluginTools,
    replyLanguage, langCheck, minThaiRatio, repeatGuard, repeatGuardMax,
  };
}

/**
 * Drive one task to a DONE — or to whatever ends it first: a guard, a cap, a budget.
 *
 * @param {string} taskText
 * @param {object} ctx
 * @param {object} ctx.bridge      BridgeClient
 * @param {object} ctx.tools       tool implementations (createTools)
 * @param {object} ctx.overlay     Overlay
 * @param {object} [ctx.session]   Session to record into
 * @param {object} [ctx.permissions] PermissionEngine
 * @param {object} [ctx.events]    Emitter
 * @param {Function} [ctx.subagent] async (task) => summary text
 * @param {Function} [ctx.check]    async ({files}) => {verdict, text, ran}
 * @param {Function} [ctx.approvePlan] async () => boolean
 * @param {Function} [ctx.runPluginTool] async (marker, {arg, body}) => string
 * @param {object} [ctx.options]
 * @param {Map<string,string>} [ctx.listingShown] per-conversation memory of the
 *   top level each conversation was last shown. The loop reads it to answer an
 *   identical listing with a one-line "unchanged" note instead of re-pasting
 *   the table, and writes it after the message carrying the listing was
 *   accepted — never before, or a send that failed could make a later task
 *   claim "unchanged" about ground the model never received.
 * @param {boolean} [first]       first turn of this conversation (send the preamble)
 */
export async function runTask(taskText, ctx = {}) {
  const {
    bridge, tools, overlay, session = null, permissions = null, events = null,
    subagent = null, check = null, approvePlan = null, options = {}, first = true,
    runPluginTool = null, compactor = null, rotate = null, listingShown = null,
    onConversationDead = null, onConversationSettled = null,
  } = ctx;
  let conversation = ctx.conversation ?? null;
  let conversationTemporary = ctx.conversationTemporary ?? null;
  const {
    maxSteps, maxStepsWire, maxToolCalls, maxWallClockMs, maxCredits,
    model, thinking, temperature, useSlim, seedText, pluginTools,
    replyLanguage, langCheck, minThaiRatio, repeatGuard, repeatGuardMax,
  } = normalizeOptions(options);
  // (stop) The run's own stop switch. `options.signal` is the harness's
  // AbortController, and a stop aborts it. The signal used to reach only the
  // next send (the fetch rejected with an AbortError), so the tools of the
  // reply that was running went on one after another, and a RUN kept its
  // child process alive — the person had pressed stop and the run carried on
  // as if nothing had happened. Every place the loop can wait checks it now.
  const stopped = () => options.signal?.aborted === true;
  const runStart = Date.now();
  // Background helper jobs: spawned by a SUBAGENT with `background: true`, run
  // without blocking the step, and report when polled (JOBS) or when their
  // result is injected into a later turn.
  const backgroundJobs = new Map();
  const reportedBg = new Set();

  overlay.clear();
  const todoState = [];
  let planApproved = !options.requirePlanApproval;

  session?.append('task', { text: taskText });
  events?.emit('task_start', { task: taskText, maxSteps: maxStepsWire });

  const creditsBefore = await bridge.quota().catch(() => null);
  // Spent-so-far, for the optional credit cap: the pre-run reading is the
  // baseline, and when that was unavailable the first successful reading
  // becomes one. null until a reading lands — an unknown spend never stops a
  // run on its own.
  let creditBaseline = creditsBefore?.available ?? null;
  let creditObserved = null;
  const creditSpent = async () => {
    if (!maxCredits) return null;
    const q = await bridge.quota().catch(() => null);
    if (!q || q.available == null) return null;
    if (creditBaseline == null) creditBaseline = q.available;
    creditObserved = creditBaseline - q.available;
    return creditObserved;
  };

  // Per-run metrics (P2-D): the session already records every tool call and
  // the run records credits; these counters are what turns that into rates —
  // and, since per-tool latency landed, `ms` carries the wall time each kind
  // spent in total, so stats can print where a slow run actually went.
  const toolStats = new Map(); // kind → { n, fail, ms }
  let firewallNotes = 0;
  let sendRecoveries = 0;  // (stats) refused sends the loop paused and tried again
  const stepMs = [];

  // The WAF table is the AiPASS edge's own: it exists because that edge
  // refuses ordinary source code, and it rewrites a README's `localhost` into
  // a placeholder so the payload gets through. A provider that is a plain API
  // has no such firewall, and encoding for it would hand the model
  // `CONSOLE-LOG` where its file said `console.log`. The client says which
  // world this run is in; everything below asks it once.
  const waf = bridge?.waf !== false;

  // The reminder names the wire spellings, and those exist only when the WAF
  // is on — they are the placeholders the AiPASS edge needs. A provider gets
  // the reminder without that sentence: it would be describing tokens that
  // never appear in what the model gets back.
  const reminder = waf ? REMINDER : REMINDER_HEAD + REMINDER_TAIL;

  const say = async (text, withParts = null) => {
    const res = await bridge.chat({
      message: text,
      parts: withParts ?? null,
      model,
      thinkingLevel: thinking,
      temperature,
      ...(conversation ? { conversation, temporary: conversationTemporary } : {}),
      signal: options.signal ?? null,
      onText: (t) => events?.emit('assistant_delta', { text: t }),
      onReasoning: (t) => events?.emit('reasoning_delta', { text: t }),
    });
    // (H5) Recorded only after the send was accepted. A message the firewall
    // rejected never reached the server's context, and recording it before the
    // attempt would turn every resilientSay retry into a duplicate — the
    // session must hold the conversation the server actually remembers, or the
    // compaction estimate counts ghosts. `text` is the outbound-encoded (and
    // possibly redacted/split) version here, which is exactly what the server
    // saw; an error raised after acceptance is the one case this can miss.
    session?.append('user', { text, bytes: Buffer.byteLength(text) });
    session?.append('assistant', { text: res.text, reasoning: res.reasoning });
    return res.text;
  };
  // The run's first message carries the protocol, so it is never shortened:
  // a protocol with its middle cut out is worse than a message that waited.
  const saySafe = (text, parts = null) => resilientSay(say, text, (_level, t) => {
    firewallNotes++;
    events?.emit('firewall_note', { text: t });
  }, parts, 0, { encode: waf, firewall: waf, shrink: sends > 0 });

  let listing = '';
  try { listing = waf ? outbound(tools.list('.')) : tools.list('.'); } catch { /* ignore */ }

  // (bootstrap snapshot) The head start a fresh run otherwise spends round
  // trips discovering: whether the project is a repo and what is uncommitted,
  // and which scripts package.json carries. It rides the turn-1 listing slot —
  // before the task, only on the first message, only when asked for — so the
  // tuned bytes stay identical while the option is off. The CLI asks with
  // `--snapshot`; the desktop harness ships it on, because the window's user
  // pays the same round trips and never sees the flag.
  const snapshot = first && !seedText && options.snapshot
    ? await bootstrapSnapshot(tools, overlay.root)
    : '';
  const listingBlock = snapshot
    ? `${listing}\n\nSnapshot of where this project stands right now (bootstrap snapshot):\n${snapshot}`
    : listing;
  // (listing delta) A follow-up task used to paste the whole top level again
  // even when not one entry had moved — the conversation already holds the
  // earlier listing, so those tokens bought nothing. `listingShown` is the
  // harness's per-conversation memory of the last listing a conversation was
  // told; only an identical listing is answered with the one-line note. A
  // created, rotated or freshly pinned conversation has no entry, so it still
  // gets the full table.
  const shownListing = conversation && listingShown instanceof Map
    ? listingShown.get(conversation) ?? null : null;
  const listingSame = listing !== '' && shownListing === listing;

  const again = `The project is still open in front of me and I will paste you whatever you ask for.`
    + (listingSame
      ? `\nTop level: unchanged since my last listing of it — every entry is the same.`
      : `\nTop level right now:\n${listing}`);

  const pre = buildPreamble({
    allowRun: Boolean(options.allowRun),
    plan: Boolean(options.plan),
    subagent: Boolean(options.subagent),
    searchI: Boolean(options.searchI),
    attach: Boolean(options.attach),
    plugins: pluginTools,
    lang: replyLanguage,
  });

  // What this message shows of the top level, if anything — recorded (by the
  // first accepted send, below) as what this conversation has been shown. The
  // message pastes the table when it is a slim first, a full first, or a full
  // follow-up whose listing moved; a slim follow-up shows none, and the
  // unchanged-note follow-up shows none either (the memory already has it).
  let listingToRecord = null;
  let next = useSlim
    ? `${first ? `Top level of the project: ${listingBlock}\n\n` : ''}Task: ${taskText}\n\nWhat should I open first?`
    : first
      ? `${pre}\n\nTo save you a step, here is what is at the top level already:\n${listingBlock}\n\nHere is what I want to know: ${taskText}\n\nWhat should I open first?`
      : `${again}\n\nNew task: ${taskText}\n\nWhat should I open first?`;
  const pasted = useSlim ? first : (first || !listingSame);
  if (pasted && listing !== '') listingToRecord = listing;

  // A rotated conversation (after compaction) starts from the summary seed
  // instead of a bare task: the fresh conversation has no memory of anything.
  // Not gated on `first`: between-runs compaction fires once the context has
  // grown — on the second run of a session or later — so the run that needs
  // the seed most is exactly the one that is not the first. The seed lists
  // nothing, so the memory must not be written for it.
  if (seedText) { next = seedText; listingToRecord = null; }

  let nudges = 0;            // (stats) every "no marker" nudge the run needed
  let nudgeStreak = 0;       // consecutive ones — the third stops the run

  // The ASK stop: the run pauses with the question as its closing message —
  // no check, no nudge. The next user message in the same conversation is the
  // answer, so the question is all this turn has to deliver.
  const pauseForAsk = (question) => {
    summary = String(question || '').replace(/^[-—–:]\s*/, '').trim() || 'over to you — how should I proceed?';
    session?.append('note', { text: 'the run paused on a question (ASK) — the next message answers it' });
    events?.emit('ask', { text: summary });
    events?.emit('done_line', { text: summary, extra: '' });
    stopReason = 'ask';
  };
  let toolsRun = 0;
  let stagnationWarns = 0;   // (H7) steps corrected by the stagnation guard
  let stagnantStep = 0;      // consecutive steps with the same signature
  let lastStepSig = null;
  let prevSigs = [];         // (R1) recent step signatures, for oscillation
  let oscillate = 0;         // consecutive A/B swings with identical results
  let circleStrikes = 0;     // laps of a longer round (A, B, C, A …)
  let circleLen = 0;         // how many states that round has
  let circleStates = new Set(); // the states of the round being counted
  let verifyPrompts = 0;     // (R4) one "prove it" nudge per run
  let verifySent = false;
  let codeTouched = false;   // a code file was staged this run
  let verifiedSinceChange = false;
  let todoPrompts = 0;      // (plan checkpoint) one nudge when DONE arrives with open plan items
  let todoPromptSent = false;
  let sendError = null;      // the message that ended the run, when stopReason is 'error'
  let summary = null;
  let stopReason = 'steps';

  // (Thai pack) Counters for the guard and the language hook, plus the
  // evidence-novelty pair: run_stats is where a loop shows up as numbers
  // before anyone reads the transcript.
  let repeatBlocks = 0;      // identical calls the repeat guard refused
  let repeatTrip = false;    // the refusal ceiling was hit — stop after this step
  const repeatSeen = new Map(); // call signature → { count, mark }
  let mutations = 0;         // staged changes this run — the guard's clock
  // (red-test gate) The run's declared check (docs/SPEC_CHECKER.md): a
  // `verifyCommand` option when the caller names one, otherwise the first
  // non-comment line of `.aipass/check.txt`, read lazily once. The option makes
  // the verdict comparable across runs even before a project commits the file,
  // and it is what the checker prompt and the gate both use. The gate bars a
  // `git commit` RUN until that exact command has *passed* at the current
  // mutation count — a commit of a tree nobody verified is how a red test lands
  // in history. Any later change moves the clock and re-arms it; no declared
  // check, no gate.
  let declaredCheck = null;   // null = not read yet; '' = absent (or unreadable)
  let declaredCheckSource = null; // 'run' (--verify-command) or 'project' (the file)
  let declaredPassAt = -1;    // the mutation count the declared check passed at
  let commitBlocks = 0;       // (stats) git commits the gate refused
  const declaredCheckCommand = () => {
    if (declaredCheck !== null) return declaredCheck;
    const configured = String(options.verifyCommand ?? '').trim();
    if (configured) {
      declaredCheck = configured.split('\n')[0].trim().slice(0, 300);
      declaredCheckSource = 'run';
      return declaredCheck;
    }
    try {
      const raw = fs.readFileSync(path.join(overlay.root, '.aipass', 'check.txt'), 'utf8');
      declaredCheck = raw.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#')) ?? '';
      if (declaredCheck) declaredCheckSource = 'project';
    } catch { declaredCheck = ''; }
    return declaredCheck;
  };
  let langPrompts = 0;       // reply-language nudges sent (at most one per run)
  let langSent = false;
  let novelResults = 0;      // tool results that said something new
  let repeatedResults = 0;   // …and ones whose text was already seen
  const resultSeen = new Set();

  // (research) The near-miss loop: arguments change, the failure does not —
  // three spellings of one broken call never trip the exact-match repeat
  // guard. One key per failure kind; a streak of three earns one correction,
  // and a streak past the repeat guard's ceiling stops the run the same way.
  // The chain guard's counters ride here too: a failed change stops the later
  // changes of the same reply (reads still run), and run_stats counts it.
  let errKindKey = '';       // the current failure-kind streak's key
  let errStreak = 0;         // consecutive calls that failed with that kind
  let errLoops = 0;          // (stats) corrections sent for such streaks
  let errTrip = false;       // the streak ceiling was hit — stop after this step
  let chainSkips = 0;        // (stats) calls skipped after a failed change

  // A spent budget is an ending, and it is recorded like one: the session
  // keeps the note, the window keeps the event, run_stats keeps the reason.
  let budgetHit = null;      // 'tools-limited' | 'time-limited' | 'credit-limited'
  const spendBudget = (reason) => {
    budgetHit = reason;
    const used = reason === 'tools-limited'
      ? `${toolsRun}/${maxToolCalls} tool calls`
      : reason === 'credit-limited'
        ? `≈${creditObserved ?? 0} of ${maxCredits} credits`
        : `${Math.round((Date.now() - runStart) / 1000)}s of ${Math.round(maxWallClockMs / 1000)}s`;
    session?.append('note', { text: `budget guard: the run has spent its ${reason === 'tools-limited' ? 'tool-call' : reason === 'credit-limited' ? 'credit' : 'wall-clock'} budget (${used}) — stopping the run` });
    events?.emit('budget', { reason, used });
  };

  // (checker, docs/SPEC_CHECKER.md) A DONE over staged code earns a read-only
  // check before it is accepted — always, even when the run "verified" itself
  // with a run or a read-back: a temporary assertion is not a verdict, and
  // only the child's own runs decide. It is an execution, so it runs only
  // where the run itself could run things, and it is bounded at
  // CHECK_ROUNDS_MAX per run: a failed check that earned a fix (the tree
  // moved since the last verdict) earns one re-check; a DONE over the tree
  // the check already judged earns none.
  const CHECK_ROUNDS_MAX = 2;
  let checks = 0;            // (stats) how many checks actually ran
  let checkResult = null;    // what the last check answered, or null
  let mutationsAtLastCheck = -1; // the tree state the last check judged
  let doneUnverified = 0;    // (stats) DONEs the strict gate refused

  const finishCheck = async () => {
    if (!check || !options.subagent || !options.allowRun) return null;
    if (!overlay.size || !codeTouched) return null;
    if (checks >= CHECK_ROUNDS_MAX) return null;
    if (checks > 0 && mutations === mutationsAtLastCheck) return null;
    mutationsAtLastCheck = mutations;
    verifySent = true; // the run is being checked; R4 stands down
    const files = overlay.keys()
      .map((abs) => ({ path: posix(path.relative(overlay.root, abs)), deleted: overlay.isDeleted(abs) }))
      .slice(0, 20);
    const label = files.map((f) => (f.deleted ? `${f.path} (deleted)` : f.path)).join(', ') || 'the staged tree';
    session?.append('note', { text: `check: ${label} staged — a read-only child is looking at the tree Apply would produce` });
    events?.emit('check_start', { files, command: declaredCheckCommand() || null });
    try {
      checkResult = await check({ files });
    } catch (err) {
      // Structural failure never crosses the boundary.
      checkResult = { verdict: 'none', text: `check could not run: ${err.message}`, ran: 0 };
    }
    if (!checkResult.skipped) checks += 1;
    session?.append('note', { text: `check ${checkResult.verdict}: ${String(checkResult.text ?? '').slice(0, 2000)}` });
    events?.emit('check_end', {
      verdict: checkResult.verdict,
      ran: checkResult.ran ?? 0,
      skipped: Boolean(checkResult.skipped),
      // The exact command the verdict is about, so two runs' `checkVerdict`
      // values are only ever compared when the `checkCommand` matches.
      command: checkResult.declared ?? null,
      commandSource: checkResult.declaredSource ?? null,
    });
    return checkResult.verdict === 'fail'
      ? `Before DONE, a check of the staged tree ran and did not pass:\n${String(checkResult.text ?? '').slice(0, 4000)}\n\nFix the staged files, or explain why the failure is not yours to fix.`
      : null;
  };

  // (strict Verify) `requireCheck` turns the advisory checker into a gate: when
  // the run's declared check is failing, a DONE is a claim the evidence does
  // not support. The first fail still rides back as a correction; the gate
  // fires when a later DONE arrives over the tree the check already judged, or
  // when no step is left to carry the correction. It is terminal on purpose —
  // the model already saw the failure report and chose to end anyway.
  const unverifiedDone = () => {
    if (!options.requireCheck) return null;
    if (!check || !options.subagent || !options.allowRun) return null;
    if (!overlay.size || !codeTouched) return null;
    if (checkResult?.verdict !== 'fail') return null;
    return declaredCheckCommand() || null;
  };
  const refuseUnverifiedDone = () => {
    const failing = unverifiedDone();
    if (!failing) return false;
    doneUnverified += 1;
    summary = `DONE not accepted — the declared check (${failing}) is still failing.`;
    session?.append('note', { text: `strict Verify: ${summary}` });
    events?.emit('note', { text: `strict Verify: ${failing} is still failing — the run stops without accepting DONE` });
    stopReason = 'done-unverified';
    return true;
  };

  // (Thai pack) The reply-language stop hook. When a finished run's closing
  // message is mostly not Thai while the person reads Thai, ask for a rewrite
  // — once. A short closing never triggers it (a dozen letters is a glance,
  // not a message), and code, commands and URLs do not count toward the
  // ratio. `closing` is the line the window will keep as the run's summary.
  //
  // `plain` says the closing reply was prose only. A reply that also carried
  // calls shows their bodies in `proseText` — a CREATE's file body, a plan
  // block — and a body is content, not a message: only the closing line is
  // judged then, so a run that ends by writing its file is not re-prompted
  // over the file's language. What is measured is the user-facing text.
  const replyLangMsg = (proseText, closing, plain = true) => {
    if (!langCheck || langSent) return null;
    const judged = plain ? `${proseText ?? ''}\n${closing ?? ''}` : `${closing ?? ''}`;
    const { ratio, letters } = thaiRatio(judged);
    if (letters < 12 || ratio >= minThaiRatio) return null;
    langSent = true;
    langPrompts += 1;
    session?.append('note', { text: `language check: the closing message was ${Math.round(ratio * 100)}% Thai — asking for a Thai rewrite` });
    events?.emit('lang_prompt', { ratio: Number(ratio.toFixed(3)), min: minThaiRatio });
    return `Language check: I read Thai. Of the letters in that closing message ${Math.round(ratio * 100)}% were Thai, under the ${Math.round(minThaiRatio * 100)}% I ask for. Rewrite the closing message in Thai — keep code, commands, file paths and tool arguments exactly as they are.`;
  };

  // Attachments ride the first message only: the server keeps the history, so
  // re-sending the same image on every step would re-upload it and occupy the
  // context again for nothing. ATTACH queues (the tool's own) drain into the
  // next message, whatever turn that is.
  // (plan checkpoint) A run that wrote a PLAN or a TODO carries a checklist of
  // what "done" means. DONE used to be accepted with items still open — a long
  // plan could end half-finished and nothing said so. One nudge (once per run)
  // names the open items, so the model either finishes them, ticks them with a
  // TODO update, or says plainly why they are dropped. A second DONE after it
  // ends the run either way.
  const openTodoMsg = () => {
    if (todoPromptSent || !todoState.length) return null;
    const open = todoState.filter((it) => !it.done);
    if (!open.length) return null;
    todoPromptSent = true;
    todoPrompts += 1;
    const cap = 8;
    const named = open.slice(0, cap).map((it) => `- ${it.text}`).join('\n');
    session?.append('note', { text: `plan checkpoint: DONE arrived with ${open.length} open item(s) — asking for them first` });
    events?.emit('note', { text: `plan checkpoint: the checklist still has ${open.length} open item(s) — asking the model to close or drop them` });
    return `Before I take that as done: the plan/TODO this run recorded still lists ${open.length} open item(s):\n${named}${open.length > cap ? `\n… and ${open.length - cap} more` : ''}\n\nIf they are finished, send a TODO list with [x] on them; if any is dropped, say which and why; otherwise continue with the open items and then say DONE. A DONE after this message ends the run either way.`;
  };

  const firstParts = first ? (options.parts ?? null) : null;
  let sends = 0;
  // (resume) One dead-conversation swap per run: the conversation the session
  // adopted is gone, and the harness replaced it. Only the first send can use
  // it — nothing of this run has entered the old one yet.
  let swappedConversation = false;
  const partsForSend = () => {
    const queued = Array.isArray(tools.pendingParts) ? tools.pendingParts.splice(0) : [];
    const base = sends === 0 && Array.isArray(firstParts) ? firstParts : [];
    return base.length || queued.length ? [...base, ...queued] : null;
  };

  // (stability, the live stall of Oct 2026) A saved model the site no longer
  // offers used to be found out mid-run, when the site swapped the
  // conversation to a substitute and the transcript never said so. The
  // catalog is the judge now: when the bridge serves a live list and the
  // chosen model is not on it, the run fails here, by name, before any send.
  // A missing or fallback list skips the check — it may never block a run it
  // cannot judge — and `auto` is never judged: it delegates the pick to the
  // site by design.
  const chosenModel = String(model ?? bridge?.model ?? '').trim();
  let modelGone = false;
  if (chosenModel && chosenModel !== 'auto' && typeof bridge?.models === 'function') {
    const catalog = await bridge.models().catch(() => null);
    const ids = Array.isArray(catalog?.data) ? catalog.data.map((m) => m?.id).filter(Boolean) : [];
    if (catalog?.source === 'live' && ids.length
        && !ids.includes(chosenModel.replace(/^aipass\//, ''))) {
      modelGone = true;
      // The site swaps a model it no longer offers for a substitute mid-run
      // and never says so; a provider answers with a plain 404 instead. The
      // check is the same, but the promise behind it is not, so the wording
      // names the provider that refused.
      const providerId = bridge?.providerId ?? 'aipass';
      summary = providerId === 'aipass'
        ? `the model "${chosenModel}" is not in the model catalog anymore — the site would have swapped it for a substitute mid-run without saying so. Pick a current model in Settings and start the run again.`
        : `the model "${chosenModel}" is not in ${providerId}'s model list — that provider would refuse the request. Pick a current model in Settings and start the run again.`;
      stopReason = 'error';
      session?.append('note', { text: `catalog check: ${summary}` });
      events?.emit('error', { message: summary });
    }
  }

  for (let step = 1; !modelGone && step <= maxSteps; step++) {
    // A stop ends the run here, before the next reply: the tools of the last
    // reply are done, and nothing new goes out.
    if (stopped()) { stopReason = 'cancelled'; break; }
    // The wall clock is checked before every reply too, not only between
    // tools: waiting on a slow model is as real a spend as running a command.
    if (Date.now() - runStart > maxWallClockMs) { spendBudget('time-limited'); break; }
    if (maxCredits && (await creditSpent()) >= maxCredits) { spendBudget('credit-limited'); break; }
    const stepStart = Date.now();
    // Background helper results that finished since the last turn are injected
    // here so the model sees them without having to poll.
    const bgDone = [];
    for (const [id, job] of backgroundJobs) {
      if (job.status === 'done' && !reportedBg.has(id)) {
        reportedBg.add(id);
        bgDone.push(`Background helper ${id}${job.role ? ` (${job.role})` : ''} finished:\n${job.result}`);
      }
    }
    if (bgDone.length) {
      next = `${bgDone.join('\n\n')}\n\n${next}`;
    }
    let reply;
    let sendGivenUp = false;
    const recover = recoverWaits();
    // The parts are taken once, before the attempts, not once per attempt: the
    // queue is emptied by taking them, so an attempt after a refused send
    // found it empty and the attachment queued for this message was lost —
    // silently, because the tool had already answered "queued … it goes out
    // with your next message".
    const parts = partsForSend();
    for (let attempt = 0; ; attempt++) {
      try {
        reply = await saySafe(next, parts);
        // (listing delta) The memory only becomes true once the message that
        // carries the listing was accepted. The first send of the run is the
        // composed `next`; every later message carries results or the seed,
        // never the table.
        if (sends === 0 && listingToRecord != null && conversation && listingShown instanceof Map) {
          listingShown.set(conversation, listingToRecord);
        }
        sends++;
        // (resume) The conversation just took one of this session's messages:
        // the harness settles the binding (persisted for a reopen) and commits
        // a resume seed's boundary. Idempotent, and failures here must never
        // end a run — the message is already out.
        try { onConversationSettled?.({ conversation, temporary: conversationTemporary }); } catch { /* best effort */ }
        break;
      }
      catch (err) {
        // The user pressed stop: the signal ends the in-flight fetch with an
        // AbortError, which is an ending, not a failure — the transcript should
        // not read "error" for something the user did on purpose.
        if (err?.name === 'AbortError') { stopReason = 'cancelled'; sendGivenUp = true; break; }
        // (resume) The conversation this session adopted is gone upstream — a
        // temporary that expired, one deleted by hand. Only the run's first
        // send can recover: nothing of this run has entered the old one, so
        // the harness can hand back a fresh conversation plus the transcript
        // digest. Mid-run the history is already there to lose, and an error
        // stays the honest ending. The check runs before the generic recovery
        // below: a dead named conversation never heals by waiting.
        if (attempt === 0 && sends === 0 && !swappedConversation && onConversationDead
            && /conversation not found|returned 404|returned 409/i.test(String(err?.message ?? ''))) {
          swappedConversation = true;
          const swapped = await Promise.resolve()
            .then(() => onConversationDead())
            .catch(() => null);
          if (swapped?.conversation) {
            conversation = swapped.conversation;
            conversationTemporary = swapped.temporary === true;
            if (swapped.seedText) { next = swapped.seedText; listingToRecord = null; }
            const line = `the session's conversation is gone upstream - a fresh one (${swapped.conversation}) was created and seeded from the transcript`;
            session?.append('note', { text: line });
            events?.emit('note', { text: line });
            continue;
          }
        }
        // A send that delivered nothing and heals by waiting — the extension's
        // cycle, a tab mid-reload, a rate window, a 403 the rewrite chain could
        // not clear — is paused and given the same message again before it is
        // allowed to end the run (sendRecoverable says which shapes; the waits
        // are bounded). The ending below is what stays when they are spent.
        if (attempt < recover.length && sendRecoverable(err)) {
          const wait = recover[attempt];
          sendRecoveries++;
          const line = `the send was refused — waiting ${waitLabel(wait)}, then sending it again (recovery ${attempt + 1}/${recover.length})`;
          session?.append('note', { text: line });
          events?.emit('firewall_note', { text: line });
          await sleep(wait);
          continue;
        }
        events?.emit('error', { message: err.message });
        // Keep the reason a run died: the UI event is ephemeral, and 40% of
        // runs ended this way before the recovery above — without a note the
        // session keeps no trace of why.
        session?.append('note', { text: `the send failed: ${err.message}` });
        sendError = String(err.message ?? err);
        // The one failure with an obvious cause and an obvious fix: the bridge is
        // up and the extension is connected, but no logged-in chat tab is open, so
        // there is nowhere for the request to run. Say so on its own event, and
        // whoever is watching gets to fix it in one click instead of reading a
        // stack trace. Both spellings: the dispatch refusal ("no extension
        // connected — open a de.aipass.net tab") and the tab's own report.
        if (/no extension connected|no de\.aipass\.net tab is open/i.test(err.message)) {
          events?.emit('needs_tab', { url: options.chatUrl ?? 'https://de.aipass.net/chat', reason: err.message });
        }
        stopReason = 'error';
        sendGivenUp = true;
        break;
      }
    }
    if (sendGivenUp) break;
    reply = waf ? decode(reply) : reply;

    const elapsed = ((Date.now() - stepStart) / 1000).toFixed(1);
    stepMs.push(Math.round((Date.now() - stepStart)));
    events?.emit('step', { step, maxSteps: maxStepsWire, elapsed });

    const proseText = prose(reply, pluginTools);
    const calls = parse(reply, { plugins: pluginTools });
    const done = calls.find((c) => c.kind === 'done');
    const askCall = calls.find((c) => c.kind === 'ask');
    const work = calls.filter((c) => c.kind !== 'done' && c.kind !== 'ask');

    if (proseText) {
      const firstLine = proseText.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#')) || proseText.split('\n')[0].trim();
      if (firstLine) events?.emit('thinking', { text: firstLine, hasMore: work.length > 0 || Boolean(done) });
    }

    if (!work.length) {
      // ASK is the one ending that wants an answer, not a verdict: the
      // question rides the finished turn and the next message resumes.
      if (askCall) {
        const langMsg = replyLangMsg(proseText, askCall.arg, work.length === 0);
        if (langMsg && step < maxSteps) { next = `${langMsg}\n\n${reminder}`; continue; }
        pauseForAsk(askCall.arg);
        break;
      }
      // A reply with no readable call ends the run as done once real work has
      // happened — a closing sentence is an answer. But not when the reply was
      // trying to speak the protocol and mangled it: recorded live, a reply of
      // `NEED list desktop` followed by prose parsed to nothing, and the run
      // was marked done 633ms later with the nudges never sent. A marker-shaped
      // line earns the nudge that teaches the shape instead.
      const effectiveDone = done || (toolsRun > 0 && proseText && !attemptedMarker(reply) ? { kind: 'done', arg: 'done' } : null);
      if (effectiveDone) {
        const cleanArg = (effectiveDone.arg || proseText || 'done').replace(/^[-—–:]\s*/, '').trim();
        summary = cleanArg || 'done';
        const extra = proseText && effectiveDone.arg && proseText.trim() !== effectiveDone.arg.trim() && proseText.trim() !== cleanArg
          ? '\n' + proseText.trim() : '';
        // A DONE with a staged tree behind it gets the check first; a fail
        // rides the next message instead of ending the run.
        const checkMsg = await finishCheck();
        if (checkMsg && step < maxSteps) {
          next = `${checkMsg}\n\n${reminder}`;
          continue;
        }
        // Strict Verify: a DONE over a declared check that is still failing is
        // refused. The failure report already rode back once; a further DONE
        // is the model choosing to end over evidence that disagrees.
        if (refuseUnverifiedDone()) break;
        const todoMsg = step < maxSteps ? openTodoMsg() : null;
        if (todoMsg && step < maxSteps) {
          next = `${todoMsg}\n\n${reminder}`;
          continue;
        }
        const langMsg = replyLangMsg(proseText, cleanArg, work.length === 0);
        if (langMsg && step < maxSteps) {
          next = `${langMsg}\n\n${reminder}`;
          continue;
        }
        events?.emit('done_line', { text: cleanArg || 'done', extra });
        stopReason = 'done';
        break;
      }
      nudges += 1;
      if (++nudgeStreak > 2) {
        // (checker) A run that keeps answering nothing still gets what a DONE
        // gets: if it staged code nothing checked, run the check now. A fail
        // is a step the model can act on; a pass ends the run as done — the
        // staged tree is the evidence, and a run that produced a verified
        // tree is finished whether or not it found the words for it.
        const checkMsg = await finishCheck();
        if (checkMsg && step < maxSteps) {
          nudgeStreak = 0;
          next = `${checkMsg}\n\n${reminder}`;
          continue;
        }
        if (checks > 0 && checkResult?.verdict === 'pass') {
          summary = summary ?? 'check passed after a stalled step';
          events?.emit('done_line', { text: summary, extra: '' });
          stopReason = 'done';
          break;
        }
        events?.emit('give_up', {}); stopReason = 'stalled'; break;
      }
      events?.emit('nudge', { n: nudgeStreak });
      const attempted = attemptedMarker(reply);
      const shapeHint = attempted
        ? `That reply looked like it was trying to act — something in it had the shape of a marker — but it did not parse as one. A marker must sit at the start of its own line, with no indentation, bold or code fence, and use an exact keyword: NEED file notes.md reads that file, NEED dir src (or NEED list src) lists that folder, SEARCH someText finds it, and so on. One call per line. `
        : '';
      next = `${shapeHint}That reply had no marker I could act on — a marker only counts when it starts its own line: NEED file notes.md reads that file, NEED dir src (or NEED list src) lists that folder, SEARCH someText finds it. One call per line. If you are done, write DONE on its own line with one sentence after it — if your answer is already written above, that is all the reply needs. I will paste back exactly what you ask for. ${reminder}`;
      continue;
    }
    nudgeStreak = 0;

    // Helpers fan out when the run opts in (P2-B): each carries its own
    // conversation, so several can work beside each other. Results are
    // reassembled in marker order either way. The fan-out happens before the
    // serial loop, so the budgets are enforced here as well — a reply with a
    // hundred SUBAGENT lines must trip the cap before it starts a hundred
    // helper runs, not after.
    // The background-job table rides in the context: execute() is a
    // module-level function, so the map the run owns is not in its scope, and
    // a helper started in the background needs the very map the run injects
    // results from — a copy would start a job nothing could ever poll.
    const execCtx = { tools, permissions, events, subagent, todoState, session, approvePlan, options, runPluginTool, backgroundJobs };
    let helperResults = null;
    // Parallel SUBAGENTs fan out before the serial loop, so their wall time is
    // measured here — keyed by the call — and added to the stats when the
    // serial loop walks past that call.
    const helperMs = new Map();
    if (options.parallelHelpers && work.some((c) => c.kind === 'subagent')) {
      const helpers = work.filter((c) => c.kind === 'subagent').length;
      if (toolsRun + helpers > maxToolCalls) spendBudget('tools-limited');
      else if (Date.now() - runStart > maxWallClockMs) spendBudget('time-limited');
      else if (maxCredits && (await creditSpent()) >= maxCredits) spendBudget('credit-limited');
      else {
        helperResults = await Promise.all(work.map(async (c) => {
          if (c.kind !== 'subagent') return null;
          const t0 = Date.now();
          const out = await execute(c, execCtx).catch((err) => `err: ${err.message}`);
          helperMs.set(c, Date.now() - t0);
          return out;
        }));
      }
    }
    if (budgetHit) break;

    // (Thai pack) The pre-tool guard. The call always runs as written first;
    // the guard corrects evidence, never intent:
    //   - an identical call (kind + argument + body) already made twice with
    //     nothing staged in between is a loop — refused with advice, and a run
    //     that collects more refusals than repeatGuardMax stops as stalled;
    //   - a path call refused for a missing file gets one retry with invisible
    //     characters stripped and Thai digits swapped, and the result says so;
    //   - a machine-facing year in the 2400s gets an advisory CE note.
    const guarded = async (call) => {
      // (red-test gate) A `git commit` RUN is refused while the declared check
      // has not passed at the current tree state. The gate sits ahead of the
      // permission ask on purpose: this is not a question to override, it is
      // "run the check first" — the command that un-bars it is named in full.
      if (options.allowRun && call.kind === 'run' && isGitCommit(call.body)) {
        const declared = declaredCheckCommand();
        if (declared && declaredPassAt !== mutations) {
          commitBlocks += 1;
          const source = declaredCheckSource === 'run' ? '--verify-command' : '.aipass/check.txt';
          session?.append('note', { text: `red-test gate: refused a git commit — the declared check (${source}: ${declared}) has not passed since the last change in this run` });
          events?.emit('note', { text: 'red-test gate: a git commit was refused — run the declared check first, then commit' });
          return `err: a git commit was requested, but this run declares a check (${source}: ${declared}) and it has not passed since the last change. Run it first (RUN\n${declared}\nEND) and commit once it passes — a commit of an unverified tree is exactly what the gate exists to stop.`;
        }
      }
      const sig = `${call.kind}\u0000${String(call.arg ?? '')}\u0000${call.kind === 'run' ? String(call.body ?? '') : ''}`;
      // A poll is not an action: the same JOBS call twice is a wait for a
      // background job, not a loop, and the guard's "nothing changed in
      // between" is false — the job's own state changes.
      if (repeatGuard && !['plan', 'todo', 'subagent', 'done', 'jobs'].includes(call.kind)) {
        const seen = repeatSeen.get(sig) ?? { count: 0, mark: -1 };
        seen.count += 1;
        if (seen.count >= 3 && seen.mark === mutations) {
          repeatBlocks += 1;
          if (repeatBlocks > repeatGuardMax) repeatTrip = true;
          session?.append('note', { text: `repeat guard: refused an identical ${call.kind} call (time ${seen.count}, nothing staged changed in between)` });
          events?.emit('repeat_block', { kind: call.kind, count: seen.count });
          return `err: this exact ${call.kind} call was already made ${seen.count - 1} time(s) and nothing staged has changed since — repeating it cannot produce a different result. Change something first (another file, another range, a different edit) or say DONE and name what is still missing.`;
        }
        seen.mark = mutations;
        repeatSeen.set(sig, seen);
      }
      let out;
      try { out = String(await execute(call, execCtx)); } catch (err) { out = `err: ${err.message}`; }
      if (/^err:/i.test(out.trimStart()) && PATHY.has(call.kind) && call.arg != null) {
        for (const alt of pathVariants(call.arg)) {
          let again = null;
          try { again = String(await execute({ ...call, arg: alt }, execCtx)); } catch { again = null; }
          if (again !== null && !/^err:/i.test(again.trimStart())) {
            session?.append('note', { text: `arg guard: ${call.kind} matched after normalizing invisible characters or non-ASCII digits in the path` });
            out = `${again}\n\nnote: the path in the call contained invisible characters or non-ASCII digits; it resolved once they were normalized. Copy paths from a listing next time.`;
            break;
          }
        }
      }
      if (call.kind === 'run' || call.kind === 'git') {
        const note = beYearNote(`${call.arg ?? ''}\n${call.body ?? ''}`);
        if (note) out = `${out}\n\n${note}`;
      }
      return out;
    };

    const results = [];
    let brokenBy = null;    // the first change that failed in this reply …
    let chainNoted = false; // … and whether the skip was spoken yet
    for (let i = 0; i < work.length; i++) {
      // A stop ends the reply's remaining tools: the person said stop, and the
      // calls after this one were planned against a state they no longer want.
      // The one in flight cannot be recalled — it ends on its own (a RUN dies
      // with the signal, tools.mjs) — but nothing new starts.
      if (stopped()) { stopReason = 'cancelled'; break; }
      // One reply can carry a hundred markers; each one is checked against
      // every budget before it executes (tool calls, wall clock, and the
      // credit cap when the run has one).
      if (toolsRun >= maxToolCalls) { spendBudget('tools-limited'); break; }
      if (Date.now() - runStart > maxWallClockMs) { spendBudget('time-limited'); break; }
      if (maxCredits && (await creditSpent()) >= maxCredits) { spendBudget('credit-limited'); break; }
      const call = work[i];
      // A RUN's label is its command: the parser puts the command in the body,
      // so `arg` alone leaves a row that says "run" and nothing else — in the
      // window, in the replayed session, and in the step result the model reads
      // back. The first line is the label; a wrapped command reads until the
      // first break, which is what fits a row.
      const label = call.kind === 'run' && !call.arg ? String(call.body ?? '').split('\n')[0].trim() : call.arg;
      // (chain guard) The first failed change poisons the rest of the reply:
      // whatever else touches the tree was planned against the state the
      // refusal just invalidated. It does not run — the model gets the skip
      // spelled out and re-plans from the new state; reads keep running,
      // because they are how it learns that state.
      if (brokenBy && !SURVIVES_FAILURE(call.kind)) {
        chainSkips += 1;
        if (!chainNoted) {
          chainNoted = true;
          session?.append('note', { text: `chain guard: ${brokenBy.kind} ${brokenBy.arg ?? ''} failed — the reply's later changes were skipped so the model plans from the new state` });
          events?.emit('note', { text: 'an earlier change failed — later changes in the same reply were skipped (reads still ran)' });
        }
        events?.emit('tool', { kind: call.kind, arg: label, ok: false, head: 'skipped — an earlier change failed', lines: [], isLast: i === work.length - 1 && !done });
        session?.append('tool', { kind: call.kind, arg: label, out: 'skipped — an earlier change in the same reply failed; this call did not run', ok: false });
        results.push(`Result of ${call.kind} ${label}:\nerr: skipped — an earlier change in this same reply failed, so this call did not run on the stale state. Read the results above and plan again from there.`);
        continue;
      }
      toolsRun++;
      const callStartedAt = Date.now();
      const result = helperResults && call.kind === 'subagent'
        ? helperResults[i]
        : await guarded(call);
      // A serial call is timed where it ran; a parallel SUBAGENT carries the
      // wall time measured at its fan-out (its `await` already happened).
      const callMs = helperResults && call.kind === 'subagent'
        ? (helperMs.get(call) ?? 0)
        : Date.now() - callStartedAt;
      const text = String(result);
      const [head, ...rest] = text.split('\n');
      // Tools answer with an `err: …` prefix when they failed (the tool
      // contract, rule 2). The loop reads that one word instead of guessing
      // failure phrases — every new failure message used to miss the old
      // regexes silently.
      const refused = /^err:/i.test(text.trimStart());
      if (refused && MUTATING.has(call.kind) && !brokenBy) brokenBy = call;
      // (research) The near-miss loop: same kind, same failure text with the
      // argument masked, different arguments each time. Three in a row earn a
      // correction; past the repeat guard's ceiling the run is stopped — a
      // streak survives because every call in it changes something, which is
      // exactly what the exact-match guard cannot see.
      let loopNote = null;
      if (refused) {
        const key = errKindOf(call, text);
        if (key === errKindKey) errStreak += 1; else { errKindKey = key; errStreak = 1; }
        if (errStreak === 3) {
          errLoops += 1;
          session?.append('note', { text: 'err-loop guard: three calls in a row failed the same way — sending a correction' });
          events?.emit('note', { text: 'err-loop guard: the same failure three times in a row — asking for a different move' });
          loopNote = `\n\nnote: that is the third call in a row to fail the same way — the arguments changed, the failure did not. Repeating the shape cannot move it: change something material (another path, another command), or say DONE and name what blocks the run.`;
        } else if (errStreak > repeatGuardMax) {
          errTrip = true;
        }
      } else { errKindKey = ''; errStreak = 0; }
      // (R4) What counts as touching code, and what counts as having checked
      // it: a shell command run in the same step, or a read-back of a file
      // the overlay holds. A refused call changed nothing.
      if (!refused && MUTATING.has(call.kind)) {
        codeTouched = codeTouched || CODE_FILE.test(String(call.arg ?? ''));
        verifiedSinceChange = false;
      } else if (!refused && call.kind === 'run') {
        verifiedSinceChange = true;
      } else if (!refused && call.kind === 'read') {
        const target = overlay.trySafe(String(call.arg ?? '').replace(/\s+[\d\u0E50-\u0E59]+-[\d\u0E50-\u0E59]+$/, ''));
        if (target && overlay.has(target)) verifiedSinceChange = true;
      }
      // The repeat guard's clock: only staged changes move it.
      if (!refused && (MUTATING.has(call.kind) || call.kind === 'run')) mutations += 1;
      // (red-test gate) A declared check that just passed un-bars commits at
      // exactly this tree state; any later change moves the clock and re-arms.
      if (!refused && call.kind === 'run' && declaredCheckCommand()
          && String(call.body ?? '').trim() === declaredCheckCommand()) {
        declaredPassAt = mutations;
      }
      const stat = toolStats.get(call.kind) ?? { n: 0, fail: 0, ms: 0 };
      stat.n += 1;
      stat.ms += callMs;
      if (refused) stat.fail += 1;
      toolStats.set(call.kind, stat);
      const isLast = i === work.length - 1 && !done;
      // (web links) A search brings its sources with it: the window shows them
      // as links under the Web row, so the reader can open the article the
      // answer came from instead of trusting a line of prose about it.
      const sources = call.kind === 'web' ? parseSources(text) : [];
      events?.emit('tool', { kind: call.kind, arg: label, ok: !refused, head: head.slice(0, 70), lines: refused ? rest : [], sources, isLast });
      session?.append('tool', { kind: call.kind, arg: label, out: text.slice(0, 20_000), ok: !refused, sources });
      // (Thai pack) Evidence novelty: a result already seen this run is what a
      // loop smells like in the stats, before anyone reads the transcript.
      const seenKey = text.slice(0, 600);
      if (resultSeen.has(seenKey)) repeatedResults += 1; else { resultSeen.add(seenKey); novelResults += 1; }
      results.push(`Result of ${call.kind} ${label}:\n${waf ? outbound(result) : result}${loopNote ?? ''}`);
    }

    if (repeatTrip || errTrip) {
      session?.append('note', {
        text: errTrip
          ? `err-loop guard: ${errStreak} calls in a row failed the same way — stopping`
          : `repeat guard: the run hit its ceiling of ${repeatGuardMax} refused repeats — stopping`,
      });
      events?.emit('give_up', {});
      stopReason = 'stalled';
      break;
    }

    // A plan the human has not signed off on stops the run here: the point of
    // plan mode is that the work does not start until it is read.
    if (calls.some((c) => c.kind === 'plan') && !planApproved) {
      const ok = approvePlan ? await approvePlan() : true;
      if (!ok) {
        // A stop (cancel) releases the gate too — the run ends as cancelled,
        // not as a declined plan, so the transcript and run_stats say why.
        stopReason = options.signal?.aborted ? 'cancelled' : 'plan-rejected';
        events?.emit('note', {
          text: stopReason === 'cancelled'
            ? 'stopped while waiting for plan approval — the gate was released'
            : 'plan declined — stopping before any change.',
        });
        break;
      }
      planApproved = true;
      events?.emit('note', { text: 'plan approved — continuing.' });
    }

    if (overlay.size) {
      const changes = overlay.changes().map(({ file, added, removed, deleted, isNew }) => ({ file, added, removed, deleted, isNew }));
      events?.emit('diff_update', { changes });
    }

    // A stop ends the step here: the tools that were still queued did not
    // run, and the run does not go on to the next send. The diff event above
    // still went out — whatever is staged is still staged: the person stopped
    // the run, not the work.
    if (stopReason === 'cancelled') break;

    // A budget spent mid-step ends the run here — before the DONE handling,
    // so a "DONE" riding the same reply cannot mask why the run stopped. The
    // diff event above still went out: whatever was staged is still staged.
    if (budgetHit) break;

    const stillLooking = work.some((c) => READING.has(c.kind));
    // ASK fires in the same gate DONE does. A reply that was still gathering
    // (a NEED beside the ASK) skips it: the preamble says the two do not mix,
    // and running the read first beats stranding its result.
    if (askCall && !stillLooking) {
      const langMsg = replyLangMsg(proseText, askCall.arg, work.length === 0);
      if (langMsg && step < maxSteps) { next = `${results.join('\n\n')}\n\n${reminder}\n\n${langMsg}`; continue; }
      pauseForAsk(askCall.arg);
      break;
    }
    if (done && !stillLooking) {
      summary = (done.arg || proseText || 'done').replace(/^[-—–:]\s*/, '').trim() || 'done';
      const extra = proseText && done.arg && proseText.trim() !== done.arg.trim() ? '\n' + proseText.trim() : '';
      // A stage-and-DONE reply is exactly the case R4 cannot see: the check
      // runs here, and a fail rides the next message the way the nudge does —
      // through the stagnation guard and the compaction estimate like any
      // other step, so the correction is a step the run actually took.
      const checkMsg = await finishCheck();
      // Strict Verify may end the run here rather than swallow a fresh fail:
      // when no step is left to carry the failure report, the DONE must not be
      // accepted just because the continuation had nowhere to go.
      if (!(checkMsg && step < maxSteps) && refuseUnverifiedDone()) break;
      const todoMsg = !checkMsg && step < maxSteps ? openTodoMsg() : null;
      const langMsg = (checkMsg || todoMsg) ? null : replyLangMsg(proseText, summary, work.length === 0);
      if (checkMsg && step < maxSteps) {
        next = `${results.join('\n\n')}\n\n${reminder}\n\n${checkMsg}`;
      } else if (todoMsg && step < maxSteps) {
        next = `${results.join('\n\n')}\n\n${reminder}\n\n${todoMsg}`;
      } else if (langMsg && step < maxSteps) {
        next = `${results.join('\n\n')}\n\n${reminder}\n\n${langMsg}`;
      } else {
        events?.emit('done_line', { text: summary, extra });
        stopReason = 'done';
        break;
      }
    } else {
      if (done) events?.emit('ignore_done', {});
      next = `${results.join('\n\n')}\n\n${reminder}`;
    }

    // (H7/R1) Stagnation guard. Three shapes of a run that cannot move:
    //   - the same step over and over (identical calls, identical results)
    //   - two steps trading places (A, B, A, B …) — every step looks new,
    //     the pair goes nowhere
    //   - a longer round (A, B, C, A, B, C …) — the same circle, wider
    // One strike earns a correction; the next stops the run instead of
    // burning the rest of the budget on calls that change nothing.
    const stepSig = work.map((c, i) => JSON.stringify([c.kind, String(c.arg ?? ''), String(results[i] ?? '').slice(0, 2000)])).join('\n');
    const prevSig = prevSigs.at(-1) ?? null;
    const prev2Sig = prevSigs.at(-2) ?? null;
    // The window the circle detector reads: the last few signatures, the
    // current one last.
    const window = [...prevSigs.slice(-6), stepSig];
    prevSigs.push(stepSig);
    if (prevSigs.length > 6) prevSigs.shift();

    if (stepSig === lastStepSig) stagnantStep += 1; else { lastStepSig = stepSig; stagnantStep = 1; }
    if (stepSig === prevSig) oscillate = 0;
    else if (prev2Sig !== null && stepSig === prev2Sig) oscillate += 1;
    else oscillate = 0;
    // The longer circle: three states or more, going round. It is counted
    // apart from the two-state swing above, because the correction it earns
    // says something different — the pair moving is not the same failure as
    // a round trip that never leaves the same three steps.
    //
    // The counter counts LAPS, not detections: in a three-state round only
    // every third step closes the loop, so a counter that reset in between
    // would never see two. A step that is not one of the round's states ends
    // the round, and the next one starts a new count.
    const circle = cycleLength(window, 3);
    if (circle) {
      const states = new Set(window.slice(window.length - 1 - circle, window.length - 1));
      const same = circleStates.size === states.size && [...states].every((s) => circleStates.has(s));
      circleLen = circle;
      if (same) circleStrikes += 1; else { circleStates = states; circleStrikes = 1; }
    } else if (circleStates.size && !circleStates.has(stepSig)) {
      circleStates = new Set();
      circleStrikes = 0;
    }

    // The evidence side of the same question: a run whose answers keep coming
    // back the same is not moving, whatever its calls look like. Once most of
    // the results are repeats, the guard stops on the first strike instead of
    // spending a correction on a run that has already shown it is stuck.
    const heard = novelResults + repeatedResults;
    const echoed = heard >= 4 && repeatedResults >= 2 && repeatedResults / heard >= 0.5;
    const repeatStop = echoed ? 2 : 3;
    const circleStop = echoed ? 1 : 2;

    if (stagnantStep >= repeatStop || oscillate >= 2 || circleStrikes >= circleStop) {
      const pattern = circleStrikes >= circleStop ? 'circle' : (stagnantStep >= repeatStop ? 'repeat' : 'oscillation');
      const n = pattern === 'repeat' ? stagnantStep : (pattern === 'circle' ? circleStrikes : oscillate);
      session?.append('note', { text: `stagnation guard: ${pattern === 'repeat' ? `the same step ran ${n} times` : (pattern === 'circle' ? `${circleLen} steps went round in a circle` : 'two steps kept trading places')} with identical results — stopping the run` });
      events?.emit('stagnation', { repeats: n, action: 'stop', pattern, cycle: circleLen });
      stopReason = 'stagnation';
      break;
    }
    if (stagnantStep === 2 || oscillate === 1 || circleStrikes === 1) {
      const pattern = circleStrikes === 1 ? 'circle' : (stagnantStep === 2 ? 'repeat' : 'oscillation');
      stagnationWarns += 1;
      session?.append('note', { text: `stagnation guard: ${pattern === 'repeat' ? 'the step repeated exactly' : (pattern === 'circle' ? `the same ${circleLen} steps went round in a circle` : 'the calls are trading places')} — asking for a different move` });
      events?.emit('stagnation', { repeats: pattern === 'repeat' ? stagnantStep : (pattern === 'circle' ? circleStrikes : oscillate), action: 'warn', pattern, cycle: circleLen });
      next += pattern === 'repeat'
        ? `\n\nThat was the same call with the same result as the step before, so repeating it moves nothing. Do something different — open other files, change the call — or say DONE and tell me what is still open.`
        : (pattern === 'circle'
          ? `\n\nThe last few steps went round in a circle through the same ${circleLen} moves, and the answers came back the same every time, so the circle moves nothing. Do something different — open something new, change the call — or say DONE and tell me what is still open.`
          : `\n\nThe calls are going back and forth between the same two moves with identical results, so the pair moves nothing. Do something different — open something new, change the call — or say DONE and tell me what is still open.`);
    }

    // (R4) Verification before DONE, the soft form: once a run has staged
    // code and nothing checked it in the same step, the next message asks
    // for proof — once. The model may still finish, but it has to run a
    // check, read the change back, or say why neither is possible.
    if (codeTouched && !verifiedSinceChange && !verifySent) {
      verifySent = true;
      verifyPrompts += 1;
      const files = overlay.keys().map((abs) => posix(path.relative(overlay.root, abs))).slice(0, 5);
      session?.append('note', { text: `verify nudge: ${files.join(', ') || 'code'} staged and nothing has checked it yet` });
      events?.emit('verify_prompt', { files });
      next += `\n\nBefore we finish: the change(s) in ${files.join(', ') || 'the staged files'} have not been checked by anything yet. Run what proves them — a test, node --check, a build — or read them back and say what you saw; if nothing can be run from here, say DONE and name the check that could not be run.`;
    }

    // The budget is re-checked here, against the message that is about to go
    // out: tool results reach the server's conversation through it, so a long
    // task crosses the line mid-run, not only between runs. If the summarise
    // or the rotation itself fails, the results still go out — losing the
    // step's work to a compaction error would be worse than an over-budget
    // conversation. (H6) `pending` is the raw local text; the compactor
    // measures it after outbound() rewrites, because that is the size the
    // server will actually receive.
    if (compactor && session && compactor.needsCompaction(session, { pending: next })) {
      try {
        events?.emit('note', { text: 'context is filling up — summarising this conversation and rotating to a fresh one' });
        // The summariser is a model call like any other, so it rides the run's
        // stop signal: a stop during the summary ends the run there instead of
        // waiting for a round trip nobody asked for.
        const raw = await compactor.summarize(session, { task: taskText, model, conversation, temporary: conversationTemporary, signal: options.signal ?? null });
        // The reply is two products: the narrative and (when the tier is on)
        // the trailing MEMORY: facts, merged across rotations. A reply
        // without the section digests to the plain summary, so an older
        // model's answer still lands.
        const { summary: note, memory } = compactor.digest(session, raw);
        // Rotate first, record second: an append that lands while the rotation
        // fails would leave a compaction entry behind and reset the estimate
        // to a conversation the model never carried — a session claiming
        // memory it does not have. Failing this way only retries next step.
        const rotated = await rotate?.(note);
        // The fresh conversation is where the seed and every later send must
        // go. The harness hands its new id back because this loop's own
        // `conversation` binding would otherwise keep naming the conversation
        // the rotation just left behind.
        if (rotated?.conversation) {
          conversation = rotated.conversation;
          conversationTemporary = rotated.temporary === true;
        }
        session.append('compaction', { summary: note, ...(memory.length ? { memory } : {}), lastSummarizedEntryId: session.entries.at(-1)?.id ?? null });
        events?.emit('compacted', { summary: note, memory });
        // The fresh conversation keeps what a summary would drop: the files
        // staged so far (deletes marked) and the last check that has not
        // passed — the two constraints a rotation loses most expensively.
        const stagedNow = overlay.keys().map((abs) => {
          const rel = posix(path.relative(overlay.root, abs));
          return overlay.isDeleted(abs) ? `${rel} (deleted)` : rel;
        }).slice(0, 20);
        const lastCheck = checkResult && checkResult.verdict && checkResult.verdict !== 'pass' ? checkResult : null;
        next = `${compactor.seed({ summary: note, memory, task: taskText, preambleText: pre, results: results.join('\n\n'), staged: stagedNow, lastCheck, todo: todoState })}\n\n${reminder}`;
      } catch (err) {
        // A stop during the summary is not a compaction failure: the run ends
        // as cancelled, and the error line would only be noise.
        if (stopped()) { stopReason = 'cancelled'; break; }
        events?.emit('error', { message: `compaction failed, sending the results without it: ${err.message}` });
      }
    }
    if (step === maxSteps) events?.emit('step_limit', {});
  }

  // A budget stop is the run's stop reason, recorded like every other ending.
  if (budgetHit) stopReason = budgetHit;

  const creditsAfter = await bridge.quota(true).catch(() => null);
  const spent = creditsBefore && creditsAfter ? creditsBefore.available - creditsAfter.available : null;
  const changes = overlay.changes();
  for (const c of changes) session?.append('diff', { file: c.file, added: c.added, removed: c.removed, deleted: c.deleted, decision: 'pending' });

  // One line per run that `npm run stats` aggregates — refusals, nudges,
  // stagnation corrections, verification nudges and firewall notes are how
  // protocol drift shows up before it is guessed at.
  const runStats = {
    stopReason,
    sendError,
    // The model that produced this run — `stats` groups by it (`byModel`), so
    // "which model drifts" is a field, not a guess. Null on a bridge without one.
    model: bridge.model ?? null,
    // `steps` is executed marker calls (the name the evals rows already read);
    // `turns` is the replies it took — the two denominators were one ambiguous
    // word before, and both are cheap to carry.
    steps: toolsRun,
    turns: stepMs.length,
    tools: Object.fromEntries(toolStats),
    nudges,
    stagnations: stagnationWarns,
    verifyPrompts,
    firewallNotes,
    sendRecoveries,
    checks,
    checkVerdict: checkResult?.verdict ?? null,
    // The exact command that verdict is about: `pass` from a project check and
    // `pass` from an inferred test run are not the same evidence, and two runs
    // are only comparable when this matches.
    checkCommand: checkResult?.declared ?? (declaredCheckCommand() || null),
    doneUnverified,
    todoPrompts,
    repeatBlocks,
    commitBlocks,
    errLoops,
    chainSkips,
    langPrompts,
    novelResults,
    repeatedResults,
    // The run's closing context size, in the compactor's own estimate — the
    // number that decides when the next run rotates. Real upstream tokens are
    // not observable from a browser tab; this is the same yardstick the
    // rotation uses, so per-run and per-success rates compare like with like.
    estTokens: compactor && session ? compactor.estimate(session) : null,
    stepMs,
    spent,
  };
  session?.append('run_stats', runStats);
  events?.emit('run_stats', runStats);

  events?.emit('finished', {
    summary, steps: toolsRun, stopReason, spent,
    credits: creditsAfter,
    check: checkResult,
    changes: changes.map((c) => ({ file: c.file, added: c.added, removed: c.removed, deleted: c.deleted, isNew: c.isNew })),
    // The checklist's final state, as the run itself recorded it: the window
    // re-tallies the plan card from this copy and names what a completed run
    // left open, instead of reconstructing it from the last todo event — which
    // may have arrived steps ago, or not at all after a reload.
    todo: todoState.map((it) => ({ ...it })),
  });

  return { summary, stopReason, steps: toolsRun, changes, credits: creditsAfter, spent, check: checkResult, todo: todoState.map((it) => ({ ...it })) };
}

/**
 * The named helper shapes a `role:` line may ask for.
 *
 * Every role is read-only by construction: the helper's value is the report
 * that comes back, never an edit — its write markers answer with `err:` and
 * the child overlay stays empty, so nothing it "writes" could ever ride the
 * parent's approval. A verifier may RUN (a test, a build, node --check) to
 * prove or disprove the work; the other two only read. Without a role line a
 * SUBAGENT keeps its original shape: it may stage edits, and they wait for
 * the same approval as the parent's own.
 */
export const SUBAGENT_ROLES = {
  verifier: {
    run: true,
    lead: 'You are a verifier. Check the work named in the task the way a careful reviewer would: read the files, run what proves or disproves it (a test, a build, node --check), and change nothing — this run is read-only, and any edit is refused. Answer with what you checked, the exact output that proves it, and a verdict: pass, fail, or not-checkable-from-here.',
  },
  reviewer: {
    run: false,
    lead: 'You are a reviewer. Read what the task names and report problems, risks and open questions — this run is read-only, and any edit is refused. Answer with concrete findings, each naming the file (and line) it comes from.',
  },
  summariser: {
    run: false,
    lead: 'You are a summariser. Read what the task names and return one tight summary: what matters, where it lives (with file paths), and what is unclear — this run is read-only, and any edit is refused.',
  },
};

/** One marker: run it behind the permission gate, or handle it here. */
async function execute(call, ctx) {
  const { tools, permissions, events, subagent, todoState, session, options, runPluginTool, backgroundJobs } = ctx;

  // One shape check before anything is dispatched: built-in tools, plugin
  // markers and MCP tools all answer a malformed call with the same `err: …`
  // sentence, and no tool implementation has to own the parser's contract.
  const invalid = validateCall(call, { pluginTools: options?.pluginTools ?? [], runPluginTool });
  if (invalid) return invalid;

  if (call.kind === 'plan' || call.kind === 'todo') {
    const items = parseTodo(call.body ?? '');
    if (items.length) {
      const merged = mergeTodo(todoState, items);
      todoState.length = 0;
      todoState.push(...merged);
      session?.append('todo', { items: merged });
      events?.emit('todo', { items: merged });
    }
    return `noted ${items.length} item(s)`;
  }

  if (call.kind === 'subagent') {
    if (!subagent) return 'err: no helper is available in this run';
    const body = String(call.body ?? '');
    const background = /^\s*background:\s*(true|yes|1)\s*$/im.test(body);
    // The optional `role:` line narrows the helper before it starts: its own
    // instructions and its own limits (SUBAGENT_ROLES). An unknown role is
    // refused here, before anything starts, and the error names the set.
    const role = (body.match(/^\s*role:\s*([A-Za-z][\w-]*)/im)?.[1] ?? '').toLowerCase();
    if (role && !SUBAGENT_ROLES[role]) {
      return `err: no helper role called "${role}" — use one of: ${Object.keys(SUBAGENT_ROLES).join(', ')} (or drop the role line).`;
    }
    const taskLine = body.match(/^\s*task:\s*(.+)$/im)?.[1];
    const task = (taskLine ?? body.split('\n').find((l) => l.trim() && !/^\s*role:/i.test(l) && !/^\s*background:/i.test(l)) ?? '').trim();
    if (!task) return 'err: give the helper a task, on a `task:` line inside SUBAGENT';
    if (background) {
      if (!backgroundJobs) return 'err: background helpers are not available in this run';
      const id = `bg${backgroundJobs.size + 1}`;
      const job = { id, task, role: role || null, status: 'running', result: null };
      backgroundJobs.set(id, job);
      const promise = (async () => {
        events?.emit('subagent_start', { task, role: role || null, background: true });
        try {
          const out = await subagent(task, role || null);
          job.status = 'done';
          job.result = String(out ?? '');
          events?.emit('subagent_end', { task, role: role || null, out: job.result, background: true });
          session?.append('note', { text: `background helper ${id}${role ? ` (${role})` : ''}: ${task}\n${job.result.slice(0, 2000)}` });
        } catch (e) {
          job.status = 'error';
          job.result = `err: ${e.message}`;
        }
      })();
      job.promise = promise;
      return `started background job ${id} — poll with JOBS`;
    }
    events?.emit('subagent_start', { task, role: role || null });
    const out = await subagent(task, role || null);
    events?.emit('subagent_end', { task, role: role || null, out });
    session?.append('note', { text: `helper${role ? ` (${role})` : ''}: ${task}\n${String(out).slice(0, 2000)}` });
    return out;
  }

  if (call.kind === 'jobs') {
    if (!backgroundJobs || !backgroundJobs.size) return '(no background jobs)';
    const lines = [];
    for (const [id, job] of backgroundJobs) {
      lines.push(`${id}: ${job.status}${job.role ? ` (${job.role})` : ''} — ${job.task.slice(0, 60)}${job.status !== 'running' ? '\n  ' + String(job.result).slice(0, 400) : ''}`);
    }
    return lines.join('\n');
  }

  // A marker a plugin registered. It is the plugin's own code, so the result
  // is a string, or an error string, and nothing here interprets it. But the
  // marker still rides the permission gate a built-in rides: the risk is the
  // plugin's own word when it declared one, and without a declaration the
  // marker is classified like a write — a plugin's code runs in this process
  // with the harness's access, so "nobody said" is not "it only reads". A
  // model that asks for a plugin marker by accident, or a file it read that
  // told it to, is stopped by the same question a built-in would be.
  if (call.kind === 'plugin') {
    if (!runPluginTool) return `err: no plugin tool named ${call.name} is installed`;
    const declared = (options.pluginTools ?? []).find((t) => t?.marker === call.name);
    const risk = classifyPlugin(declared?.risk ?? null);
    // The kinds the rules may name to match this call: the marker's own, and
    // the one it behaves as — so the safety floor and the user's path rules
    // reach a plugin exactly as they reach a built-in write.
    const ruleKinds = risk === 'read' ? ['plugin'] : ['plugin', risk === 'shell' ? 'run' : 'write'];
    // What the person watching is shown: the marker's name, and the payload
    // it was asked to work on. The marker's own name is the grant key, so an
    // "always" answer covers the marker rather than one argument of it.
    const shown = [call.arg, previewOf(call)].filter(Boolean).join('\n');
    if (permissions) {
      const verdict = permissions.evaluate({
        kind: 'plugin', arg: call.name, body: call.body, risk, paths: [call.arg], ruleKinds,
        secretText: call.body,
      });
      if (verdict.decision !== 'allow') {
        if (verdict.decision === 'deny') {
          // The floor refused it before anybody was asked — say which one, so
          // the refusal is a fact and not a shrug.
          return `err: plugin marker ${call.name} was refused${verdict.reason ? ` — ${verdict.reason}` : ''}`.slice(0, 300);
        }
        const decision = await permissions.request({
          kind: 'plugin', arg: call.name, preview: shown, body: call.body, risk,
          paths: [call.arg], ruleKinds, secretText: call.body,
        });
        if (decision === 'deny') {
          // The reason rides along: a marker refused by the secret floor and
          // a marker the person turned down are different events, and the
          // model is told which one it was.
          const why = verdict.reason ? ` — ${verdict.reason}` : '';
          return `err: the person watching declined plugin marker ${call.name}${why}`;
        }
        if (decision === 'always') permissions.grant('plugin', call.name);
      }
    }
    events?.emit('plugin_call', { marker: call.name, arg: call.arg });
    try {
      return String(await runPluginTool(call.name, { arg: call.arg, body: call.body ?? '' }) ?? '');
    } catch (err) {
      return `err: ${err.message}`;
    }
  }

  const risk = classify(call.kind, call.body);
  // Shell when it was never enabled: the tool itself owns that message, and
  // letting the gate refuse it instead would hide why.
  if (call.kind === 'run' && !options.allowRun) return await tools.run('', call.body);
  if (permissions) {
    const verdict = permissions.evaluate({ kind: call.kind, arg: call.arg, body: call.body });
    if (risk === 'read') {
      // Reads are never asked about, but a deny rule still stops one before
      // the file is opened — `.env* → deny` is how secrets stay local.
      if (verdict.decision === 'deny') {
        return `err: ${verdict.reason} denies reading ${call.arg}; the file stays on this machine`.slice(0, 300);
      }
    } else if (verdict.decision !== 'allow') {
      const decision = await permissions.request({ kind: call.kind, arg: call.arg, preview: previewOf(call), body: call.body });
      if (decision === 'deny') {
        // A RUN carries its command in `body`, not `arg` — name it so the
        // model and the person watching can see exactly what was refused.
        const what = call.kind === 'run' ? String(call.body ?? '').trim().split('\n')[0] : call.arg;
        return `err: the person watching declined ${call.kind} ${what}`.slice(0, 300);
      }
      if (decision === 'always') { permissions.grant(call.kind, call.arg); }
    }
  }

  return await tools[call.kind](call.arg, call.body);
}

/**
 * Write the accepted subset of the overlay to disk. `accepted` is a list of
 * posix-relative paths; null means everything.
 */
export function applyOverlay(overlay, accepted = null, { session = null, events = null } = {}) {
  const wanted = accepted ? new Set(accepted.map((f) => overlay.safe(f))) : null;
  const result = overlay.applyToDisk(wanted);
  for (const file of result.files) session?.append('diff', { file, decision: 'applied' });
  events?.emit('applied', result);
  return result;
}
