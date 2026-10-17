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
import path from 'node:path';
import { outbound } from './waf.mjs';
import {
  REMINDER, prose, parse, parseTodo, mergeTodo, READING,
  preamble as buildPreamble,
} from './protocol.mjs';
import { resilientSay, decode } from './bridge.mjs';
import { classify } from './permissions.mjs';
import { posix } from './overlay.mjs';
import { thaiRatio } from './lang.mjs';
import { PATHY, pathVariants, beYearNote } from './argguard.mjs';

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
 */
function errKindOf(call, text) {
  let line = String(text).split('\n')[0].toLowerCase().slice(0, 200);
  const bits = [String(call.arg ?? ''), call.kind === 'run' ? String(call.body ?? '').split('\n')[0] : '']
    .map((b) => b.trim().toLowerCase())
    .filter((b) => b.length >= 3);
  for (const b of bits) line = line.split(b).join('<arg>');
  return `${call.kind}::${line.replace(/[\w.\\/:-]*[\\/][\w.\\/:-]*/g, '<path>').replace(/\s+/g, ' ').trim()}`;
}

const previewOf = (call) => {
  if (call.kind === 'replace') return String(call.body?.[1] ?? '').slice(0, 4000);
  if (call.body) return String(call.body).slice(0, 4000);
  return '';
};

/**
 * Drive one task to a DONE (or the step limit).
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
 * @param {boolean} [first]       first turn of this conversation (send the preamble)
 */
export async function runTask(taskText, ctx = {}) {
  const {
    bridge, tools, overlay, session = null, permissions = null, events = null,
    subagent = null, check = null, approvePlan = null, options = {}, first = true,
    runPluginTool = null, compactor = null, rotate = null,
    conversation = null, conversationTemporary = null,
  } = ctx;  const maxSteps = Number(options.maxSteps ?? 10);
  // Per-run budgets — the same defaults the settings file ships. A reply full
  // of markers used to execute every one of them, and a yolo RUN can hold one
  // step open for minutes; either budget spent stops the run the way the step
  // limit does, with its own stop reason in run_stats.
  const maxToolCalls = Number(options.maxToolCalls) > 0 ? Math.floor(Number(options.maxToolCalls)) : 300;
  const maxWallClockMs = Number(options.maxWallClockMs) > 0 ? Math.floor(Number(options.maxWallClockMs)) : 1_800_000;
  // (credit cap) Optional ceiling on observed spend, in credits. 0 = no cap.
  // The check rides the bridge's cached quota (its own 30s TTL), so it bounds
  // a runaway run without turning into an upstream request per step.
  const maxCredits = Number(options.maxCredits) > 0 ? Number(options.maxCredits) : 0;
  const runStart = Date.now();
  const model = options.model ?? null;
  // How hard the model thinks before each reply. 'off' (or nothing) means the
  // request never asks; the level that does go out is checked by the bridge
  // against the model, so a level it lacks never breaks a run.
  const thinking = options.thinking && String(options.thinking).toLowerCase() !== 'off'
    ? String(options.thinking).toLowerCase() : null;
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
    ? Math.min(1, Math.max(0, Number(options.minThaiRatio))) : 0.25;
  // (Thai pack) The pre-tool guard. repeatGuard refuses an identical call
  // (same kind, argument and body) already made twice with nothing staged in
  // between — a loop, not a step; repeatGuardMax is how many such refusals
  // one run may collect before it is stopped as stalled.
  const repeatGuard = Boolean(options.repeatGuard);
  const repeatGuardMax = Number(options.repeatGuardMax) > 0 ? Math.floor(Number(options.repeatGuardMax)) : 4;

  overlay.clear();
  const todoState = [];
  let planApproved = !options.requirePlanApproval;

  session?.append('task', { text: taskText });
  events?.emit('task_start', { task: taskText, maxSteps });

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
  // the run records credits; these counters are what turns that into rates.
  const toolStats = new Map(); // kind → { n, fail }
  let firewallNotes = 0;
  const stepMs = [];

  const say = async (text, withParts = null) => {
    const res = await bridge.chat({
      message: text,
      parts: withParts ?? null,
      model,
      thinkingLevel: thinking,
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
  const saySafe = (text, parts = null) => resilientSay(say, text, (_level, t) => {
    firewallNotes++;
    events?.emit('firewall_note', { text: t });
  }, parts);

  let listing = '';
  try { listing = outbound(tools.list('.')); } catch { /* ignore */ }

  const again = `The project is still open in front of me and I will paste you whatever you ask for.`
    + `\nTop level right now:\n${listing}`;

  const pre = buildPreamble({
    allowRun: Boolean(options.allowRun),
    plan: Boolean(options.plan),
    subagent: Boolean(options.subagent),
    searchI: Boolean(options.searchI),
    attach: Boolean(options.attach),
    plugins: pluginTools,
    lang: replyLanguage,
  });

  let next = useSlim
    ? `${first ? `Top level of the project: ${listing}\n\n` : ''}Task: ${taskText}\n\nWhat should I open first?`
    : first
      ? `${pre}\n\nTo save you a step, here is what is at the top level already:\n${listing}\n\nHere is what I want to know: ${taskText}\n\nWhat should I open first?`
      : `${again}\n\nNew task: ${taskText}\n\nWhat should I open first?`;

  // A rotated conversation (after compaction) starts from the summary seed
  // instead of a bare task: the fresh conversation has no memory of anything.
  if (first && seedText) next = seedText;

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
  let verifyPrompts = 0;     // (R4) one "prove it" nudge per run
  let verifySent = false;
  let codeTouched = false;   // a code file was staged this run
  let verifiedSinceChange = false;
  let summary = null;
  let stopReason = 'steps';

  // (Thai pack) Counters for the guard and the language hook, plus the
  // evidence-novelty pair: run_stats is where a loop shows up as numbers
  // before anyone reads the transcript.
  let repeatBlocks = 0;      // identical calls the repeat guard refused
  let repeatTrip = false;    // the refusal ceiling was hit — stop after this step
  const repeatSeen = new Map(); // call signature → { count, mark }
  let mutations = 0;         // staged changes this run — the guard's clock
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
    events?.emit('check_start', { files });
    try {
      checkResult = await check({ files });
    } catch (err) {
      // Structural failure never crosses the boundary.
      checkResult = { verdict: 'none', text: `check could not run: ${err.message}`, ran: 0 };
    }
    if (!checkResult.skipped) checks += 1;
    session?.append('note', { text: `check ${checkResult.verdict}: ${String(checkResult.text ?? '').slice(0, 2000)}` });
    events?.emit('check_end', { verdict: checkResult.verdict, ran: checkResult.ran ?? 0, skipped: Boolean(checkResult.skipped) });
    return checkResult.verdict === 'fail'
      ? `Before DONE, a check of the staged tree ran and did not pass:\n${String(checkResult.text ?? '').slice(0, 4000)}\n\nFix the staged files, or explain why the failure is not yours to fix.`
      : null;
  };

  // (Thai pack) The reply-language stop hook. When a finished run's closing
  // message is mostly not Thai while the person reads Thai, ask for a rewrite
  // — once. A short closing never triggers it (a dozen letters is a glance,
  // not a message), and code, commands and URLs do not count toward the
  // ratio. `closing` is the line the window will keep as the run's summary.
  const replyLangMsg = (proseText, closing) => {
    if (!langCheck || langSent) return null;
    const { ratio, letters } = thaiRatio(`${proseText ?? ''}\n${closing ?? ''}`);
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
  const firstParts = first ? (options.parts ?? null) : null;
  let sends = 0;
  const partsForSend = () => {
    const queued = Array.isArray(tools.pendingParts) ? tools.pendingParts.splice(0) : [];
    const base = sends === 0 && Array.isArray(firstParts) ? firstParts : [];
    return base.length || queued.length ? [...base, ...queued] : null;
  };

  for (let step = 1; step <= maxSteps; step++) {
    // The wall clock is checked before every reply too, not only between
    // tools: waiting on a slow model is as real a spend as running a command.
    if (Date.now() - runStart > maxWallClockMs) { spendBudget('time-limited'); break; }
    if (maxCredits && (await creditSpent()) >= maxCredits) { spendBudget('credit-limited'); break; }
    const stepStart = Date.now();
    let reply;
    try { reply = await saySafe(next, partsForSend()); sends++; }
    catch (err) {
      // The user pressed stop: the signal ends the in-flight fetch with an
      // AbortError, which is an ending, not a failure — the transcript should
      // not read "error" for something the user did on purpose.
      if (err?.name === 'AbortError') { stopReason = 'cancelled'; break; }
      events?.emit('error', { message: err.message });
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
      break;
    }
    reply = decode(reply);

    const elapsed = ((Date.now() - stepStart) / 1000).toFixed(1);
    stepMs.push(Math.round((Date.now() - stepStart)));
    events?.emit('step', { step, maxSteps, elapsed });

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
        const langMsg = replyLangMsg(proseText, askCall.arg);
        if (langMsg && step < maxSteps) { next = `${langMsg}\n\n${REMINDER}`; continue; }
        pauseForAsk(askCall.arg);
        break;
      }
      const effectiveDone = done || (toolsRun > 0 && proseText ? { kind: 'done', arg: 'done' } : null);
      if (effectiveDone) {
        const cleanArg = (effectiveDone.arg || proseText || 'done').replace(/^[-—–:]\s*/, '').trim();
        summary = cleanArg || 'done';
        const extra = proseText && effectiveDone.arg && proseText.trim() !== effectiveDone.arg.trim() && proseText.trim() !== cleanArg
          ? '\n' + proseText.trim() : '';
        // A DONE with a staged tree behind it gets the check first; a fail
        // rides the next message instead of ending the run.
        const checkMsg = await finishCheck();
        if (checkMsg && step < maxSteps) {
          next = `${checkMsg}\n\n${REMINDER}`;
          continue;
        }
        const langMsg = replyLangMsg(proseText, cleanArg);
        if (langMsg && step < maxSteps) {
          next = `${langMsg}\n\n${REMINDER}`;
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
          next = `${checkMsg}\n\n${REMINDER}`;
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
      next = `That reply had no marker I could act on — a marker only counts when it starts its own line: NEED file notes.md reads that file, NEED dir src lists that folder, SEARCH someText finds it. One call per line. If you are done, write DONE on its own line with one sentence after it. I will paste back exactly what you ask for. ${REMINDER}`;
      continue;
    }
    nudgeStreak = 0;

    // Helpers fan out when the run opts in (P2-B): each carries its own
    // conversation, so several can work beside each other. Results are
    // reassembled in marker order either way. The fan-out happens before the
    // serial loop, so the budgets are enforced here as well — a reply with a
    // hundred SUBAGENT lines must trip the cap before it starts a hundred
    // helper runs, not after.
    const execCtx = { tools, permissions, events, subagent, todoState, session, approvePlan, options, runPluginTool };
    let helperResults = null;
    if (options.parallelHelpers && work.some((c) => c.kind === 'subagent')) {
      const helpers = work.filter((c) => c.kind === 'subagent').length;
      if (toolsRun + helpers > maxToolCalls) spendBudget('tools-limited');
      else if (Date.now() - runStart > maxWallClockMs) spendBudget('time-limited');
      else if (maxCredits && (await creditSpent()) >= maxCredits) spendBudget('credit-limited');
      else {
        helperResults = await Promise.all(work.map((c) => c.kind === 'subagent'
          ? execute(c, execCtx).catch((err) => `err: ${err.message}`)
          : null));
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
      const sig = `${call.kind}\u0000${String(call.arg ?? '')}\u0000${call.kind === 'run' ? String(call.body ?? '') : ''}`;
      if (repeatGuard && !['plan', 'todo', 'subagent', 'done'].includes(call.kind)) {
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
      // One reply can carry a hundred markers; each one is checked against
      // both budgets before it executes.
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
      const result = helperResults && call.kind === 'subagent'
        ? helperResults[i]
        : await guarded(call);
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
      const stat = toolStats.get(call.kind) ?? { n: 0, fail: 0 };
      stat.n += 1;
      if (refused) stat.fail += 1;
      toolStats.set(call.kind, stat);
      const isLast = i === work.length - 1 && !done;
      events?.emit('tool', { kind: call.kind, arg: label, ok: !refused, head: head.slice(0, 70), lines: refused ? rest : [], isLast });
      session?.append('tool', { kind: call.kind, arg: label, out: text.slice(0, 20_000), ok: !refused });
      // (Thai pack) Evidence novelty: a result already seen this run is what a
      // loop smells like in the stats, before anyone reads the transcript.
      const seenKey = text.slice(0, 600);
      if (resultSeen.has(seenKey)) repeatedResults += 1; else { resultSeen.add(seenKey); novelResults += 1; }
      results.push(`Result of ${call.kind} ${label}:\n${outbound(result)}${loopNote ?? ''}`);
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
      if (!ok) { stopReason = 'plan-rejected'; events?.emit('note', { text: 'plan declined — stopping before any change.' }); break; }
      planApproved = true;
      events?.emit('note', { text: 'plan approved — continuing.' });
    }

    if (overlay.size) {
      const changes = overlay.changes().map(({ file, added, removed, deleted, isNew }) => ({ file, added, removed, deleted, isNew }));
      events?.emit('diff_update', { changes });
    }

    // A budget spent mid-step ends the run here — before the DONE handling,
    // so a "DONE" riding the same reply cannot mask why the run stopped. The
    // diff event above still went out: whatever was staged is still staged.
    if (budgetHit) break;

    const stillLooking = work.some((c) => READING.has(c.kind));
    // ASK fires in the same gate DONE does. A reply that was still gathering
    // (a NEED beside the ASK) skips it: the preamble says the two do not mix,
    // and running the read first beats stranding its result.
    if (askCall && !stillLooking) {
      const langMsg = replyLangMsg(proseText, askCall.arg);
      if (langMsg && step < maxSteps) { next = `${results.join('\n\n')}\n\n${REMINDER}\n\n${langMsg}`; continue; }
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
      const langMsg = checkMsg && step < maxSteps ? null : replyLangMsg(proseText, summary);
      if (checkMsg && step < maxSteps) {
        next = `${results.join('\n\n')}\n\n${REMINDER}\n\n${checkMsg}`;
      } else if (langMsg && step < maxSteps) {
        next = `${results.join('\n\n')}\n\n${REMINDER}\n\n${langMsg}`;
      } else {
        events?.emit('done_line', { text: summary, extra });
        stopReason = 'done';
        break;
      }
    } else {
      if (done) events?.emit('ignore_done', {});
      next = `${results.join('\n\n')}\n\n${REMINDER}`;
    }

    // (H7/R1) Stagnation guard. Two shapes of a run that cannot move:
    //   - the same step over and over (identical calls, identical results)
    //   - two steps trading places (A, B, A, B …) — every step looks new,
    //     the pair goes nowhere
    // One strike earns a correction; the next stops the run instead of
    // burning the rest of the budget on calls that change nothing.
    const stepSig = work.map((c, i) => JSON.stringify([c.kind, String(c.arg ?? ''), String(results[i] ?? '').slice(0, 2000)])).join('\n');
    const prevSig = prevSigs.at(-1) ?? null;
    const prev2Sig = prevSigs.at(-2) ?? null;
    prevSigs.push(stepSig);
    if (prevSigs.length > 6) prevSigs.shift();

    if (stepSig === lastStepSig) stagnantStep += 1; else { lastStepSig = stepSig; stagnantStep = 1; }
    if (stepSig === prevSig) oscillate = 0;
    else if (prev2Sig !== null && stepSig === prev2Sig) oscillate += 1;
    else oscillate = 0;

    if (stagnantStep >= 3 || oscillate >= 2) {
      const pattern = stagnantStep >= 3 ? 'repeat' : 'oscillation';
      const n = pattern === 'repeat' ? stagnantStep : oscillate;
      session?.append('note', { text: `stagnation guard: ${pattern === 'repeat' ? `the same step ran ${n} times` : 'two steps kept trading places'} with identical results — stopping the run` });
      events?.emit('stagnation', { repeats: n, action: 'stop', pattern });
      stopReason = 'stagnation';
      break;
    }
    if (stagnantStep === 2 || oscillate === 1) {
      const pattern = stagnantStep === 2 ? 'repeat' : 'oscillation';
      stagnationWarns += 1;
      session?.append('note', { text: `stagnation guard: ${pattern === 'repeat' ? 'the step repeated exactly' : 'the calls are trading places'} — asking for a different move` });
      events?.emit('stagnation', { repeats: pattern === 'repeat' ? stagnantStep : oscillate, action: 'warn', pattern });
      next += pattern === 'repeat'
        ? `\n\nThat was the same call with the same result as the step before, so repeating it moves nothing. Do something different — open other files, change the call — or say DONE and tell me what is still open.`
        : `\n\nThe calls are going back and forth between the same two moves with identical results, so the pair moves nothing. Do something different — open something new, change the call — or say DONE and tell me what is still open.`;
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
        const note = await compactor.summarize(session, { task: taskText, model });
        session.append('compaction', { summary: note, firstKeptEntryId: session.entries.at(-1)?.id ?? null });
        await rotate?.(note);
        events?.emit('compacted', { summary: note });
        // The fresh conversation keeps what a summary would drop: the files
        // staged so far (deletes marked) and the last check that has not
        // passed — the two constraints a rotation loses most expensively.
        const stagedNow = overlay.keys().map((abs) => {
          const rel = posix(path.relative(overlay.root, abs));
          return overlay.isDeleted(abs) ? `${rel} (deleted)` : rel;
        }).slice(0, 20);
        const lastCheck = checkResult && checkResult.verdict && checkResult.verdict !== 'pass' ? checkResult : null;
        next = `${compactor.seed({ summary: note, task: taskText, listing: '', preambleText: pre, results: results.join('\n\n'), staged: stagedNow, lastCheck })}\n\n${REMINDER}`;
      } catch (err) {
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
    // The model that produced this run — `stats` groups by it (`byModel`), so
    // "which model drifts" is a field, not a guess. Null on a bridge without one.
    model: bridge.model ?? null,
    steps: toolsRun,
    tools: Object.fromEntries(toolStats),
    nudges,
    stagnations: stagnationWarns,
    verifyPrompts,
    firewallNotes,
    checks,
    checkVerdict: checkResult?.verdict ?? null,
    repeatBlocks,
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
  });

  return { summary, stopReason, steps: toolsRun, changes, credits: creditsAfter, spent, check: checkResult };
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
  const { tools, permissions, events, subagent, todoState, session, options, runPluginTool } = ctx;

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
    // The optional `role:` line narrows the helper before it starts: its own
    // instructions and its own limits (SUBAGENT_ROLES). An unknown role is
    // refused here, before anything starts, and the error names the set.
    const role = (body.match(/^\s*role:\s*([A-Za-z][\w-]*)/im)?.[1] ?? '').toLowerCase();
    if (role && !SUBAGENT_ROLES[role]) {
      return `err: no helper role called "${role}" — use one of: ${Object.keys(SUBAGENT_ROLES).join(', ')} (or drop the role line).`;
    }
    const taskLine = body.match(/^\s*task:\s*(.+)$/im)?.[1];
    const task = (taskLine ?? body.split('\n').find((l) => l.trim() && !/^\s*role:/i.test(l)) ?? '').trim();
    if (!task) return 'err: give the helper a task, on a `task:` line inside SUBAGENT';
    events?.emit('subagent_start', { task, role: role || null });
    const out = await subagent(task, role || null);
    events?.emit('subagent_end', { task, role: role || null, out });
    session?.append('note', { text: `helper${role ? ` (${role})` : ''}: ${task}\n${String(out).slice(0, 2000)}` });
    return out;
  }

  // A marker a plugin registered. It is the plugin's own code, so it is also
  // the plugin's own responsibility: the result is a string, or an error
  // string, and nothing here interprets it.
  if (call.kind === 'plugin') {
    if (!runPluginTool) return `err: no plugin tool named ${call.name} is installed`;
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
