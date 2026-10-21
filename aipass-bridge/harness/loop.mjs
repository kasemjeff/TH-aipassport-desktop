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
//
// The stages of one step live in `harness/run/`: the state they share is
// `RunContext`, and each stage — the send pipeline, the DONE gates, the
// budgets — is a module of its own. What is left here is the step itself:
// the order the stages run in, and the guards that read the step's evidence.
import fs from 'node:fs';
import path from 'node:path';
import { outbound } from './waf.mjs';
import { parseSources } from './web-sources.mjs';
import {
  REMINDER, REMINDER_HEAD, REMINDER_TAIL, prose, parse, parseTodo, mergeTodo, READING, attemptedMarker,
  preamble as buildPreamble,
} from './protocol.mjs';
import { decode } from './bridge.mjs';
import { classify, classifyPlugin, isGitCommit } from './permissions.mjs';
import { posix } from './overlay.mjs';
import { PATHY, pathVariants, beYearNote } from './argguard.mjs';
import { validateCall } from './validate.mjs';
import { RunContext } from './run/context.mjs';
import { createBudgets } from './run/budgets.mjs';
import { createDoneGates } from './run/gates.mjs';
import { createSender } from './run/send.mjs';

// The option sheet lives in its own module so the context can read it without
// importing the loop that owns the context; it is re-exported here because
// this is where the loop's callers have always found it.
export { normalizeOptions } from './run/options.mjs';

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
  // One object owns the run: what it was given, what it has done so far, and
  // the counters the guards read. The stages below are the same run, seen
  // from one side each.
  const run = new RunContext(taskText, ctx);
  const {
    bridge, tools, overlay, session, permissions, events,
    subagent, check, approvePlan, compactor, rotate, listingShown,
  } = run;
  const {
    maxSteps, maxStepsWire, maxToolCalls, maxWallClockMs, maxCredits,
    model, thinking, temperature, useSlim, seedText, pluginTools,
    replyLanguage, repeatGuard, repeatGuardMax,
  } = run.sheet;

  // The three stages of one run.
  const budgets = createBudgets(run);
  const gates = createDoneGates(run);
  const sender = createSender(run);

  overlay.clear();

  session?.append('task', { text: taskText });
  events?.emit('task_start', { task: taskText, maxSteps: maxStepsWire });

  // The pre-run quota reading: the baseline the optional credit cap is
  // measured against, and the "what did this run cost" number at the end.
  run.creditsBefore = await bridge.quota().catch(() => null);
  run.creditBaseline = run.creditsBefore?.available ?? null;

  // The reminder names the wire spellings, and those exist only when the WAF
  // is on — they are the placeholders the AiPASS edge needs. A provider gets
  // the reminder without that sentence: it would be describing tokens that
  // never appear in what the model gets back.
  const reminder = run.waf ? REMINDER : REMINDER_HEAD + REMINDER_TAIL;

  let listing = '';
  try { listing = run.waf ? outbound(tools.list('.')) : tools.list('.'); } catch { /* ignore */ }

  // (bootstrap snapshot) The head start a fresh run otherwise spends round
  // trips discovering: whether the project is a repo and what is uncommitted,
  // and which scripts package.json carries. It rides the turn-1 listing slot —
  // before the task, only on the first message, only when asked for — so the
  // tuned bytes stay identical while the option is off. The CLI asks with
  // `--snapshot`; the desktop harness ships it on, because the window's user
  // pays the same round trips and never sees the flag.
  const snapshot = run.first && !seedText && run.options.snapshot
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
  const shownListing = run.conversation && listingShown instanceof Map
    ? listingShown.get(run.conversation) ?? null : null;
  const listingSame = listing !== '' && shownListing === listing;

  const again = `The project is still open in front of me and I will paste you whatever you ask for.`
    + (listingSame
      ? `\nTop level: unchanged since my last listing of it — every entry is the same.`
      : `\nTop level right now:\n${listing}`);

  const pre = buildPreamble({
    allowRun: Boolean(run.options.allowRun),
    plan: Boolean(run.options.plan),
    subagent: Boolean(run.options.subagent),
    searchI: Boolean(run.options.searchI),
    attach: Boolean(run.options.attach),
    plugins: pluginTools,
    lang: replyLanguage,
  });

  // What this message shows of the top level, if anything — recorded (by the
  // first accepted send, below) as what this conversation has been shown. The
  // message pastes the table when it is a slim first, a full first, or a full
  // follow-up whose listing moved; a slim follow-up shows none, and the
  // unchanged-note follow-up shows none either (the memory already has it).
  run.listingToRecord = null;
  run.next = useSlim
    ? `${run.first ? `Top level of the project: ${listingBlock}\n\n` : ''}Task: ${taskText}\n\nWhat should I open first?`
    : run.first
      ? `${pre}\n\nTo save you a step, here is what is at the top level already:\n${listingBlock}\n\nHere is what I want to know: ${taskText}\n\nWhat should I open first?`
      : `${again}\n\nNew task: ${taskText}\n\nWhat should I open first?`;
  const pasted = useSlim ? run.first : (run.first || !listingSame);
  if (pasted && listing !== '') run.listingToRecord = listing;

  // A rotated conversation (after compaction) starts from the summary seed
  // instead of a bare task: the fresh conversation has no memory of anything.
  // Not gated on `first`: between-runs compaction fires once the context has
  // grown — on the second run of a session or later — so the run that needs
  // the seed most is exactly the one that is not the first. The seed lists
  // nothing, so the memory must not be written for it.
  if (seedText) { run.next = seedText; run.listingToRecord = null; }

  // The ASK stop: the run pauses with the question as its closing message —
  // no check, no nudge. The next user message in the same conversation is the
  // answer, so the question is all this turn has to deliver.
  const pauseForAsk = (question) => {
    run.summary = String(question || '').replace(/^[-—–:]\s*/, '').trim() || 'over to you — how should I proceed?';
    session?.append('note', { text: 'the run paused on a question (ASK) — the next message answers it' });
    events?.emit('ask', { text: run.summary });
    events?.emit('done_line', { text: run.summary, extra: '' });
    run.stopReason = 'ask';
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
      run.summary = providerId === 'aipass'
        ? `the model "${chosenModel}" is not in the model catalog anymore — the site would have swapped it for a substitute mid-run without saying so. Pick a current model in Settings and start the run again.`
        : `the model "${chosenModel}" is not in ${providerId}'s model list — that provider would refuse the request. Pick a current model in Settings and start the run again.`;
      run.stopReason = 'error';
      session?.append('note', { text: `catalog check: ${run.summary}` });
      events?.emit('error', { message: run.summary });
    }
  }

  for (let step = 1; !modelGone && step <= maxSteps; step++) {
    // A stop ends the run here, before the next reply: the tools of the last
    // reply are done, and nothing new goes out.
    if (run.stopped()) { run.stopReason = 'cancelled'; break; }
    // The wall clock is checked before every reply too, not only between
    // tools: waiting on a slow model is as real a spend as running a command.
    if (budgets.overTime()) { budgets.spendBudget('time-limited'); break; }
    if (await budgets.overCredits()) { budgets.spendBudget('credit-limited'); break; }
    const stepStart = Date.now();
    // Background helper results that finished since the last turn are injected
    // here so the model sees them without having to poll.
    const bgDone = [];
    for (const [id, job] of run.backgroundJobs) {
      if (job.status === 'done' && !run.reportedBg.has(id)) {
        run.reportedBg.add(id);
        bgDone.push(`Background helper ${id}${job.role ? ` (${job.role})` : ''} finished:\n${job.result}`);
      }
    }
    if (bgDone.length) {
      run.next = `${bgDone.join('\n\n')}\n\n${run.next}`;
    }

    // The send. The reply comes back with the stage that owns the ladder.
    const sent = await sender.send();
    if (sent.stopReason) { run.stopReason = sent.stopReason; break; }
    let reply = sent.reply;

    reply = run.waf ? decode(reply) : reply;

    const elapsed = ((Date.now() - stepStart) / 1000).toFixed(1);
    run.stepMs.push(Math.round((Date.now() - stepStart)));
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
        const langMsg = gates.replyLangMsg(proseText, askCall.arg, work.length === 0);
        if (langMsg && step < maxSteps) { run.next = `${langMsg}\n\n${reminder}`; continue; }
        pauseForAsk(askCall.arg);
        break;
      }
      // A reply with no readable call ends the run as done once real work has
      // happened — a closing sentence is an answer. But not when the reply was
      // trying to speak the protocol and mangled it: recorded live, a reply of
      // `NEED list desktop` followed by prose parsed to nothing, and the run
      // was marked done 633ms later with the nudges never sent. A marker-shaped
      // line earns the nudge that teaches the shape instead.
      const effectiveDone = done || (run.toolsRun > 0 && proseText && !attemptedMarker(reply) ? { kind: 'done', arg: 'done' } : null);
      if (effectiveDone) {
        const cleanArg = (effectiveDone.arg || proseText || 'done').replace(/^[-—–:]\s*/, '').trim();
        run.summary = cleanArg || 'done';
        const extra = proseText && effectiveDone.arg && proseText.trim() !== effectiveDone.arg.trim() && proseText.trim() !== cleanArg
          ? '\n' + proseText.trim() : '';
        // A DONE with a staged tree behind it gets the check first; a fail
        // rides the next message instead of ending the run.
        const checkMsg = await gates.finishCheck();
        if (checkMsg && step < maxSteps) {
          run.next = `${checkMsg}\n\n${reminder}`;
          continue;
        }
        // Strict Verify: a DONE over a declared check that is still failing is
        // refused. The failure report already rode back once; a further DONE
        // is the model choosing to end over evidence that disagrees.
        if (gates.refuseUnverifiedDone()) break;
        const todoMsg = step < maxSteps ? gates.openTodoMsg() : null;
        if (todoMsg && step < maxSteps) {
          run.next = `${todoMsg}\n\n${reminder}`;
          continue;
        }
        const langMsg = gates.replyLangMsg(proseText, cleanArg, work.length === 0);
        if (langMsg && step < maxSteps) {
          run.next = `${langMsg}\n\n${reminder}`;
          continue;
        }
        events?.emit('done_line', { text: cleanArg || 'done', extra });
        run.stopReason = 'done';
        break;
      }
      run.nudges += 1;
      if (++run.nudgeStreak > 2) {
        // (checker) A run that keeps answering nothing still gets what a DONE
        // gets: if it staged code nothing checked, run the check now. A fail
        // is a step the model can act on; a pass ends the run as done — the
        // staged tree is the evidence, and a run that produced a verified
        // tree is finished whether or not it found the words for it.
        const checkMsg = await gates.finishCheck();
        if (checkMsg && step < maxSteps) {
          run.nudgeStreak = 0;
          run.next = `${checkMsg}\n\n${reminder}`;
          continue;
        }
        if (run.checks > 0 && run.checkResult?.verdict === 'pass') {
          run.summary = run.summary ?? 'check passed after a stalled step';
          events?.emit('done_line', { text: run.summary, extra: '' });
          run.stopReason = 'done';
          break;
        }
        events?.emit('give_up', {}); run.stopReason = 'stalled'; break;
      }
      events?.emit('nudge', { n: run.nudgeStreak });
      const attempted = attemptedMarker(reply);
      const shapeHint = attempted
        ? `That reply looked like it was trying to act — something in it had the shape of a marker — but it did not parse as one. A marker must sit at the start of its own line, with no indentation, bold or code fence, and use an exact keyword: NEED file notes.md reads that file, NEED dir src (or NEED list src) lists that folder, SEARCH someText finds it, and so on. One call per line. `
        : '';
      run.next = `${shapeHint}That reply had no marker I could act on — a marker only counts when it starts its own line: NEED file notes.md reads that file, NEED dir src (or NEED list src) lists that folder, SEARCH someText finds it. One call per line. If you are done, write DONE on its own line with one sentence after it — if your answer is already written above, that is all the reply needs. I will paste back exactly what you ask for. ${reminder}`;
      continue;
    }
    run.nudgeStreak = 0;

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
    let helperResults = null;
    // Parallel SUBAGENTs fan out before the serial loop, so their wall time is
    // measured here — keyed by the call — and added to the stats when the
    // serial loop walks past that call.
    const helperMs = new Map();
    if (run.options.parallelHelpers && work.some((c) => c.kind === 'subagent')) {
      const helpers = work.filter((c) => c.kind === 'subagent').length;
      if (run.toolsRun + helpers > maxToolCalls) budgets.spendBudget('tools-limited');
      else if (budgets.overTime()) budgets.spendBudget('time-limited');
      else if (await budgets.overCredits()) budgets.spendBudget('credit-limited');
      else {
        helperResults = await Promise.all(work.map(async (c) => {
          if (c.kind !== 'subagent') return null;
          const t0 = Date.now();
          const out = await execute(c, run).catch((err) => `err: ${err.message}`);
          helperMs.set(c, Date.now() - t0);
          return out;
        }));
      }
    }
    if (run.budgetHit) break;

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
      if (run.options.allowRun && call.kind === 'run' && isGitCommit(call.body)) {
        const declared = run.declaredCheckCommand();
        if (declared && run.declaredPassAt !== run.mutations) {
          run.commitBlocks += 1;
          const source = run.declaredCheckSource === 'run' ? '--verify-command' : '.aipass/check.txt';
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
        const seen = run.repeatSeen.get(sig) ?? { count: 0, mark: -1 };
        seen.count += 1;
        if (seen.count >= 3 && seen.mark === run.mutations) {
          run.repeatBlocks += 1;
          if (run.repeatBlocks > repeatGuardMax) run.repeatTrip = true;
          session?.append('note', { text: `repeat guard: refused an identical ${call.kind} call (time ${seen.count}, nothing staged changed in between)` });
          events?.emit('repeat_block', { kind: call.kind, count: seen.count });
          return `err: this exact ${call.kind} call was already made ${seen.count - 1} time(s) and nothing staged has changed since — repeating it cannot produce a different result. Change something first (another file, another range, a different edit) or say DONE and name what is still missing.`;
        }
        seen.mark = run.mutations;
        run.repeatSeen.set(sig, seen);
      }
      let out;
      try { out = String(await execute(call, run)); } catch (err) { out = `err: ${err.message}`; }
      if (/^err:/i.test(out.trimStart()) && PATHY.has(call.kind) && call.arg != null) {
        for (const alt of pathVariants(call.arg)) {
          let again = null;
          try { again = String(await execute({ ...call, arg: alt }, run)); } catch { again = null; }
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
      if (run.stopped()) { run.stopReason = 'cancelled'; break; }
      // One reply can carry a hundred markers; each one is checked against
      // every budget before it executes (tool calls, wall clock, and the
      // credit cap when the run has one).
      if (run.toolsRun >= maxToolCalls) { budgets.spendBudget('tools-limited'); break; }
      if (budgets.overTime()) { budgets.spendBudget('time-limited'); break; }
      if (await budgets.overCredits()) { budgets.spendBudget('credit-limited'); break; }
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
        run.chainSkips += 1;
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
      run.toolsRun += 1;
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
        if (key === run.errKindKey) run.errStreak += 1; else { run.errKindKey = key; run.errStreak = 1; }
        if (run.errStreak === 3) {
          run.errLoops += 1;
          session?.append('note', { text: 'err-loop guard: three calls in a row failed the same way — sending a correction' });
          events?.emit('note', { text: 'err-loop guard: the same failure three times in a row — asking for a different move' });
          loopNote = `\n\nnote: that is the third call in a row to fail the same way — the arguments changed, the failure did not. Repeating the shape cannot move it: change something material (another path, another command), or say DONE and name what blocks the run.`;
        } else if (run.errStreak > repeatGuardMax) {
          run.errTrip = true;
        }
      } else { run.errKindKey = ''; run.errStreak = 0; }
      // (R4) What counts as touching code, and what counts as having checked
      // it: a shell command run in the same step, or a read-back of a file
      // the overlay holds. A refused call changed nothing.
      if (!refused && MUTATING.has(call.kind)) {
        run.codeTouched = run.codeTouched || CODE_FILE.test(String(call.arg ?? ''));
        run.verifiedSinceChange = false;
      } else if (!refused && call.kind === 'run') {
        run.verifiedSinceChange = true;
      } else if (!refused && call.kind === 'read') {
        const target = overlay.trySafe(String(call.arg ?? '').replace(/\s+[\d\u0E50-\u0E59]+-[\d\u0E50-\u0E59]+$/, ''));
        if (target && overlay.has(target)) run.verifiedSinceChange = true;
      }
      // The repeat guard's clock: only staged changes move it.
      if (!refused && (MUTATING.has(call.kind) || call.kind === 'run')) run.mutations += 1;
      // (red-test gate) A declared check that just passed un-bars commits at
      // exactly this tree state; any later change moves the clock and re-arms.
      if (!refused && call.kind === 'run' && run.declaredCheckCommand()
          && String(call.body ?? '').trim() === run.declaredCheckCommand()) {
        run.declaredPassAt = run.mutations;
      }
      const stat = run.toolStats.get(call.kind) ?? { n: 0, fail: 0, ms: 0 };
      stat.n += 1;
      stat.ms += callMs;
      if (refused) stat.fail += 1;
      run.toolStats.set(call.kind, stat);
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
      if (run.resultSeen.has(seenKey)) run.repeatedResults += 1; else { run.resultSeen.add(seenKey); run.novelResults += 1; }
      results.push(`Result of ${call.kind} ${label}:\n${run.waf ? outbound(result) : result}${loopNote ?? ''}`);
    }

    if (run.repeatTrip || run.errTrip) {
      session?.append('note', {
        text: run.errTrip
          ? `err-loop guard: ${run.errStreak} calls in a row failed the same way — stopping`
          : `repeat guard: the run hit its ceiling of ${repeatGuardMax} refused repeats — stopping`,
      });
      events?.emit('give_up', {});
      run.stopReason = 'stalled';
      break;
    }

    // A plan the human has not signed off on stops the run here: the point of
    // plan mode is that the work does not start until it is read.
    if (calls.some((c) => c.kind === 'plan') && !run.planApproved) {
      const ok = approvePlan ? await approvePlan() : true;
      if (!ok) {
        // A stop (cancel) releases the gate too — the run ends as cancelled,
        // not as a declined plan, so the transcript and run_stats say why.
        run.stopReason = run.options.signal?.aborted ? 'cancelled' : 'plan-rejected';
        events?.emit('note', {
          text: run.stopReason === 'cancelled'
            ? 'stopped while waiting for plan approval — the gate was released'
            : 'plan declined — stopping before any change.',
        });
        break;
      }
      run.planApproved = true;
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
    if (run.stopReason === 'cancelled') break;

    // A budget spent mid-step ends the run here — before the DONE handling,
    // so a "DONE" riding the same reply cannot mask why the run stopped. The
    // diff event above still went out: whatever was staged is still staged.
    if (run.budgetHit) break;

    const stillLooking = work.some((c) => READING.has(c.kind));
    // ASK fires in the same gate DONE does. A reply that was still gathering
    // (a NEED beside the ASK) skips it: the preamble says the two do not mix,
    // and running the read first beats stranding its result.
    if (askCall && !stillLooking) {
      const langMsg = gates.replyLangMsg(proseText, askCall.arg, work.length === 0);
      if (langMsg && step < maxSteps) { run.next = `${results.join('\n\n')}\n\n${reminder}\n\n${langMsg}`; continue; }
      pauseForAsk(askCall.arg);
      break;
    }
    if (done && !stillLooking) {
      run.summary = (done.arg || proseText || 'done').replace(/^[-—–:]\s*/, '').trim() || 'done';
      const extra = proseText && done.arg && proseText.trim() !== done.arg.trim() ? '\n' + proseText.trim() : '';
      // A stage-and-DONE reply is exactly the case R4 cannot see: the check
      // runs here, and a fail rides the next message the way the nudge does —
      // through the stagnation guard and the compaction estimate like any
      // other step, so the correction is a step the run actually took.
      const checkMsg = await gates.finishCheck();
      // Strict Verify may end the run here rather than swallow a fresh fail:
      // when no step is left to carry the failure report, the DONE must not be
      // accepted just because the continuation had nowhere to go.
      if (!(checkMsg && step < maxSteps) && gates.refuseUnverifiedDone()) break;
      const todoMsg = !checkMsg && step < maxSteps ? gates.openTodoMsg() : null;
      const langMsg = (checkMsg || todoMsg) ? null : gates.replyLangMsg(proseText, run.summary, work.length === 0);
      if (checkMsg && step < maxSteps) {
        run.next = `${results.join('\n\n')}\n\n${reminder}\n\n${checkMsg}`;
      } else if (todoMsg && step < maxSteps) {
        run.next = `${results.join('\n\n')}\n\n${reminder}\n\n${todoMsg}`;
      } else if (langMsg && step < maxSteps) {
        run.next = `${results.join('\n\n')}\n\n${reminder}\n\n${langMsg}`;
      } else {
        events?.emit('done_line', { text: run.summary, extra });
        run.stopReason = 'done';
        break;
      }
    } else {
      if (done) events?.emit('ignore_done', {});
      run.next = `${results.join('\n\n')}\n\n${reminder}`;
    }

    // (H7/R1) Stagnation guard. Three shapes of a run that cannot move:
    //   - the same step over and over (identical calls, identical results)
    //   - two steps trading places (A, B, A, B …) — every step looks new,
    //     the pair goes nowhere
    //   - a longer round (A, B, C, A, B, C …) — the same circle, wider
    // One strike earns a correction; the next stops the run instead of
    // burning the rest of the budget on calls that change nothing.
    const stepSig = work.map((c, i) => JSON.stringify([c.kind, String(c.arg ?? ''), String(results[i] ?? '').slice(0, 2000)])).join('\n');
    const prevSig = run.prevSigs.at(-1) ?? null;
    const prev2Sig = run.prevSigs.at(-2) ?? null;
    // The window the circle detector reads: the last few signatures, the
    // current one last.
    const window = [...run.prevSigs.slice(-6), stepSig];
    run.prevSigs.push(stepSig);
    if (run.prevSigs.length > 6) run.prevSigs.shift();

    if (stepSig === run.lastStepSig) run.stagnantStep += 1; else { run.lastStepSig = stepSig; run.stagnantStep = 1; }
    if (stepSig === prevSig) run.oscillate = 0;
    else if (prev2Sig !== null && stepSig === prev2Sig) run.oscillate += 1;
    else run.oscillate = 0;
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
      const same = run.circleStates.size === states.size && [...states].every((s) => run.circleStates.has(s));
      run.circleLen = circle;
      if (same) run.circleStrikes += 1; else { run.circleStates = states; run.circleStrikes = 1; }
    } else if (run.circleStates.size && !run.circleStates.has(stepSig)) {
      run.circleStates = new Set();
      run.circleStrikes = 0;
    }

    // The evidence side of the same question: a run whose answers keep coming
    // back the same is not moving, whatever its calls look like. Once most of
    // the results are repeats, the guard stops on the first strike instead of
    // spending a correction on a run that has already shown it is stuck.
    const heard = run.novelResults + run.repeatedResults;
    const echoed = heard >= 4 && run.repeatedResults >= 2 && run.repeatedResults / heard >= 0.5;
    const repeatStop = echoed ? 2 : 3;
    const circleStop = echoed ? 1 : 2;

    if (run.stagnantStep >= repeatStop || run.oscillate >= 2 || run.circleStrikes >= circleStop) {
      const pattern = run.circleStrikes >= circleStop ? 'circle' : (run.stagnantStep >= repeatStop ? 'repeat' : 'oscillation');
      const n = pattern === 'repeat' ? run.stagnantStep : (pattern === 'circle' ? run.circleStrikes : run.oscillate);
      session?.append('note', { text: `stagnation guard: ${pattern === 'repeat' ? `the same step ran ${n} times` : (pattern === 'circle' ? `${run.circleLen} steps went round in a circle` : 'two steps kept trading places')} with identical results — stopping the run` });
      events?.emit('stagnation', { repeats: n, action: 'stop', pattern, cycle: run.circleLen });
      run.stopReason = 'stagnation';
      break;
    }
    if (run.stagnantStep === 2 || run.oscillate === 1 || run.circleStrikes === 1) {
      const pattern = run.circleStrikes === 1 ? 'circle' : (run.stagnantStep === 2 ? 'repeat' : 'oscillation');
      run.stagnationWarns += 1;
      session?.append('note', { text: `stagnation guard: ${pattern === 'repeat' ? 'the step repeated exactly' : (pattern === 'circle' ? `the same ${run.circleLen} steps went round in a circle` : 'the calls are trading places')} — asking for a different move` });
      events?.emit('stagnation', { repeats: pattern === 'repeat' ? run.stagnantStep : (pattern === 'circle' ? run.circleStrikes : run.oscillate), action: 'warn', pattern, cycle: run.circleLen });
      run.next += pattern === 'repeat'
        ? `\n\nThat was the same call with the same result as the step before, so repeating it moves nothing. Do something different — open other files, change the call — or say DONE and tell me what is still open.`
        : (pattern === 'circle'
          ? `\n\nThe last few steps went round in a circle through the same ${run.circleLen} moves, and the answers came back the same every time, so the circle moves nothing. Do something different — open something new, change the call — or say DONE and tell me what is still open.`
          : `\n\nThe calls are going back and forth between the same two moves with identical results, so the pair moves nothing. Do something different — open something new, change the call — or say DONE and tell me what is still open.`);
    }

    // (R4) Verification before DONE, the soft form: once a run has staged
    // code and nothing checked it in the same step, the next message asks
    // for proof — once. The model may still finish, but it has to run a
    // check, read the change back, or say why neither is possible.
    if (run.codeTouched && !run.verifiedSinceChange && !run.verifySent) {
      run.verifySent = true;
      run.verifyPrompts += 1;
      const files = overlay.keys().map((abs) => posix(path.relative(overlay.root, abs))).slice(0, 5);
      session?.append('note', { text: `verify nudge: ${files.join(', ') || 'code'} staged and nothing has checked it yet` });
      events?.emit('verify_prompt', { files });
      run.next += `\n\nBefore we finish: the change(s) in ${files.join(', ') || 'the staged files'} have not been checked by anything yet. Run what proves them — a test, node --check, a build — or read them back and say what you saw; if nothing can be run from here, say DONE and name the check that could not be run.`;
    }

    // The budget is re-checked here, against the message that is about to go
    // out: tool results reach the server's conversation through it, so a long
    // task crosses the line mid-run, not only between runs. If the summarise
    // or the rotation itself fails, the results still go out — losing the
    // step's work to a compaction error would be worse than an over-budget
    // conversation. (H6) `pending` is the raw local text; the compactor
    // measures it after outbound() rewrites, because that is the size the
    // server will actually receive.
    if (compactor && session && compactor.needsCompaction(session, { pending: run.next })) {
      try {
        events?.emit('note', { text: 'context is filling up — summarising this conversation and rotating to a fresh one' });
        // The summariser is a model call like any other, so it rides the run's
        // stop signal: a stop during the summary ends the run there instead of
        // waiting for a round trip nobody asked for.
        const raw = await compactor.summarize(session, { task: taskText, model, conversation: run.conversation, temporary: run.conversationTemporary, signal: run.options.signal ?? null });
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
          run.conversation = rotated.conversation;
          run.conversationTemporary = rotated.temporary === true;
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
        const lastCheck = run.checkResult && run.checkResult.verdict && run.checkResult.verdict !== 'pass' ? run.checkResult : null;
        run.next = `${compactor.seed({ summary: note, memory, task: taskText, preambleText: pre, results: results.join('\n\n'), staged: stagedNow, lastCheck, todo: run.todoState })}\n\n${reminder}`;
      } catch (err) {
        // A stop during the summary is not a compaction failure: the run ends
        // as cancelled, and the error line would only be noise.
        if (run.stopped()) { run.stopReason = 'cancelled'; break; }
        events?.emit('error', { message: `compaction failed, sending the results without it: ${err.message}` });
      }
    }
    if (step === maxSteps) events?.emit('step_limit', {});
  }

  // A budget stop is the run's stop reason, recorded like every other ending.
  if (run.budgetHit) run.stopReason = run.budgetHit;

  const creditsAfter = await bridge.quota(true).catch(() => null);
  const spent = run.creditsBefore && creditsAfter ? run.creditsBefore.available - creditsAfter.available : null;
  const changes = overlay.changes();
  for (const c of changes) session?.append('diff', { file: c.file, added: c.added, removed: c.removed, deleted: c.deleted, decision: 'pending' });

  // One line per run that `npm run stats` aggregates — refusals, nudges,
  // stagnation corrections, verification nudges and firewall notes are how
  // protocol drift shows up before it is guessed at.
  const runStats = {
    stopReason: run.stopReason,
    sendError: run.sendError,
    // The model that produced this run — `stats` groups by it (`byModel`), so
    // "which model drifts" is a field, not a guess. Null on a bridge without one.
    model: bridge.model ?? null,
    // `steps` is executed marker calls (the name the evals rows already read);
    // `turns` is the replies it took — the two denominators were one ambiguous
    // word before, and both are cheap to carry.
    steps: run.toolsRun,
    turns: run.stepMs.length,
    tools: Object.fromEntries(run.toolStats),
    nudges: run.nudges,
    stagnations: run.stagnationWarns,
    verifyPrompts: run.verifyPrompts,
    firewallNotes: run.firewallNotes,
    sendRecoveries: run.sendRecoveries,
    checks: run.checks,
    checkVerdict: run.checkResult?.verdict ?? null,
    // The exact command that verdict is about: `pass` from a project check and
    // `pass` from an inferred test run are not the same evidence, and two runs
    // are only comparable when this matches.
    checkCommand: run.checkResult?.declared ?? (run.declaredCheckCommand() || null),
    doneUnverified: run.doneUnverified,
    todoPrompts: run.todoPrompts,
    repeatBlocks: run.repeatBlocks,
    commitBlocks: run.commitBlocks,
    errLoops: run.errLoops,
    chainSkips: run.chainSkips,
    langPrompts: run.langPrompts,
    novelResults: run.novelResults,
    repeatedResults: run.repeatedResults,
    // The run's closing context size, in the compactor's own estimate — the
    // number that decides when the next run rotates. Real upstream tokens are
    // not observable from a browser tab; this is the same yardstick the
    // rotation uses, so per-run and per-success rates compare like with like.
    estTokens: compactor && session ? compactor.estimate(session) : null,
    stepMs: run.stepMs,
    spent,
  };
  session?.append('run_stats', runStats);
  events?.emit('run_stats', runStats);

  events?.emit('finished', {
    summary: run.summary, steps: run.toolsRun, stopReason: run.stopReason, spent,
    credits: creditsAfter,
    check: run.checkResult,
    changes: changes.map((c) => ({ file: c.file, added: c.added, removed: c.removed, deleted: c.deleted, isNew: c.isNew })),
    // The checklist's final state, as the run itself recorded it: the window
    // re-tallies the plan card from this copy and names what a completed run
    // left open, instead of reconstructing it from the last todo event — which
    // may have arrived steps ago, or not at all after a reload.
    todo: run.todoState.map((it) => ({ ...it })),
  });

  return {
    summary: run.summary, stopReason: run.stopReason, steps: run.toolsRun, changes,
    credits: creditsAfter, spent, check: run.checkResult, todo: run.todoState.map((it) => ({ ...it })),
  };
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
async function execute(call, run) {
  const { tools, permissions, events, subagent, todoState, session, options, runPluginTool, backgroundJobs } = run;

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
