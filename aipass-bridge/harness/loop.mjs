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

// (R1/R4) The research round's two sets: which call kinds change the overlay,
// and which files count as code for the verification nudge.
const MUTATING = new Set(['write', 'replace', 'delete', 'move']);
const CODE_FILE = /\.(m?js|cjs|tsx?|jsx|py|rb|go|rs|java|cs|php|swift|kt|c|h|cpp|hpp|sh|ps1|css|html?|sql)$/i;

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
  const model = options.model ?? null;
  // How hard the model thinks before each reply. 'off' (or nothing) means the
  // request never asks; the level that does go out is checked by the bridge
  // against the model, so a level it lacks never breaks a run.
  const thinking = options.thinking && String(options.thinking).toLowerCase() !== 'off'
    ? String(options.thinking).toLowerCase() : null;
  const useSlim = Boolean(options.slim);
  const seedText = options.seedText ?? null;
  const pluginTools = options.pluginTools ?? [];

  overlay.clear();
  const todoState = [];
  let planApproved = !options.requirePlanApproval;

  session?.append('task', { text: taskText });
  events?.emit('task_start', { task: taskText, maxSteps });

  const creditsBefore = await bridge.quota().catch(() => null);

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

  // (checker, SPEC_CHECKER.md) A DONE over staged code earns one read-only
  // check before it is accepted. The gate mirrors R4's so the two stages
  // cannot disagree — code staged, nothing verified it — plus the two
  // conditions only a check has: it is an execution, so it runs only where
  // the run itself could run things, and it is one per run (up before the
  // first await).
  let checkTried = false;
  let checks = 0;            // (stats) 1 when a check actually ran
  let checkResult = null;    // what the check answered, or null

  const finishCheck = async () => {
    if (checkTried || !check || !options.subagent || !options.allowRun) return null;
    if (!overlay.size || !codeTouched || verifiedSinceChange) return null;
    checkTried = true;
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
    if (!checkResult.skipped) checks = 1;
    session?.append('note', { text: `check ${checkResult.verdict}: ${String(checkResult.text ?? '').slice(0, 2000)}` });
    events?.emit('check_end', { verdict: checkResult.verdict, ran: checkResult.ran ?? 0, skipped: Boolean(checkResult.skipped) });
    return checkResult.verdict === 'fail'
      ? `Before DONE, a check of the staged tree ran and did not pass:\n${String(checkResult.text ?? '').slice(0, 4000)}\n\nFix the staged files, or explain why the failure is not yours to fix.`
      : null;
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
    const stepStart = Date.now();
    let reply;
    try { reply = await saySafe(next, partsForSend()); sends++; }
    catch (err) {
      events?.emit('error', { message: err.message });
      // The one failure with an obvious cause and an obvious fix: the bridge is
      // up and the extension is connected, but no logged-in chat tab is open, so
      // there is nowhere for the request to run. Say so on its own event, and
      // whoever is watching gets to fix it in one click instead of reading a
      // stack trace.
      if (/no de\.aipass\.net tab is open/i.test(err.message)) {
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
    const work = calls.filter((c) => c.kind !== 'done');

    if (proseText) {
      const firstLine = proseText.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#')) || proseText.split('\n')[0].trim();
      if (firstLine) events?.emit('thinking', { text: firstLine, hasMore: work.length > 0 || Boolean(done) });
    }

    if (!work.length) {
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
        events?.emit('done_line', { text: cleanArg || 'done', extra });
        stopReason = 'done';
        break;
      }
      nudges += 1;
      if (++nudgeStreak > 2) { events?.emit('give_up', {}); stopReason = 'stalled'; break; }
      events?.emit('nudge', { n: nudgeStreak });
      next = `That reply had no marker I could act on — a marker only counts when it starts its own line. If you are done, write DONE on its own line with one sentence after it; if you need something, name it with one marker per line (NEED file path, SEARCH text, …) and I will paste the result straight back. ${REMINDER}`;
      continue;
    }
    nudgeStreak = 0;

    // Helpers fan out when the run opts in (P2-B): each carries its own
    // conversation, so several can work beside each other. Results are
    // reassembled in marker order either way.
    const execCtx = { tools, permissions, events, subagent, todoState, session, approvePlan, options, runPluginTool };
    const helperResults = options.parallelHelpers && work.some((c) => c.kind === 'subagent')
      ? await Promise.all(work.map((c) => c.kind === 'subagent'
          ? execute(c, execCtx).catch((err) => `err: ${err.message}`)
          : null))
      : null;

    const results = [];
    for (let i = 0; i < work.length; i++) {
      const call = work[i];
      toolsRun++;
      let result;
      let blocked = false;
      if (helperResults && call.kind === 'subagent') {
        result = helperResults[i];
      } else {
        try {
          result = await execute(call, execCtx);
        } catch (err) {
          result = `err: ${err.message}`;
          blocked = true;
        }
      }
      const text = String(result);
      const [head, ...rest] = text.split('\n');
      // Tools answer with an `err: …` prefix when they failed (the tool
      // contract, rule 2). The loop reads that one word instead of guessing
      // failure phrases — every new failure message used to miss the old
      // regexes silently.
      const refused = blocked || /^err:/i.test(text.trimStart());
      // (R4) What counts as touching code, and what counts as having checked
      // it: a shell command run in the same step, or a read-back of a file
      // the overlay holds. A refused call changed nothing.
      if (!refused && MUTATING.has(call.kind)) {
        codeTouched = codeTouched || CODE_FILE.test(String(call.arg ?? ''));
        verifiedSinceChange = false;
      } else if (!refused && call.kind === 'run') {
        verifiedSinceChange = true;
      } else if (!refused && call.kind === 'read') {
        const target = overlay.trySafe(String(call.arg ?? '').replace(/\s+\d+-\d+$/, ''));
        if (target && overlay.has(target)) verifiedSinceChange = true;
      }
      const stat = toolStats.get(call.kind) ?? { n: 0, fail: 0 };
      stat.n += 1;
      if (refused) stat.fail += 1;
      toolStats.set(call.kind, stat);
      const isLast = i === work.length - 1 && !done;
      events?.emit('tool', { kind: call.kind, arg: call.arg, ok: !refused, head: head.slice(0, 70), lines: refused ? rest : [], isLast });
      session?.append('tool', { kind: call.kind, arg: call.arg, out: text.slice(0, 20_000), ok: !refused });
      results.push(`Result of ${call.kind} ${call.arg}:\n${outbound(result)}`);
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

    const stillLooking = work.some((c) => READING.has(c.kind));
    if (done && !stillLooking) {
      summary = (done.arg || proseText || 'done').replace(/^[-—–:]\s*/, '').trim() || 'done';
      const extra = proseText && done.arg && proseText.trim() !== done.arg.trim() ? '\n' + proseText.trim() : '';
      // A stage-and-DONE reply is exactly the case R4 cannot see: the check
      // runs here, and a fail rides the next message the way the nudge does —
      // through the stagnation guard and the compaction estimate like any
      // other step, so the correction is a step the run actually took.
      const checkMsg = await finishCheck();
      if (checkMsg && step < maxSteps) {
        next = `${results.join('\n\n')}\n\n${REMINDER}\n\n${checkMsg}`;
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
        next = `${compactor.seed({ summary: note, task: taskText, listing: '', preambleText: pre, results: results.join('\n\n') })}\n\n${REMINDER}`;
      } catch (err) {
        events?.emit('error', { message: `compaction failed, sending the results without it: ${err.message}` });
      }
    }
    if (step === maxSteps) events?.emit('step_limit', {});
  }

  const creditsAfter = await bridge.quota(true).catch(() => null);
  const spent = creditsBefore && creditsAfter ? creditsBefore.available - creditsAfter.available : null;
  const changes = overlay.changes();
  for (const c of changes) session?.append('diff', { file: c.file, added: c.added, removed: c.removed, deleted: c.deleted, decision: 'pending' });

  // One line per run that `npm run stats` aggregates — refusals, nudges,
  // stagnation corrections, verification nudges and firewall notes are how
  // protocol drift shows up before it is guessed at.
  const runStats = {
    stopReason,
    steps: toolsRun,
    tools: Object.fromEntries(toolStats),
    nudges,
    stagnations: stagnationWarns,
    verifyPrompts,
    firewallNotes,
    checks,
    checkVerdict: checkResult?.verdict ?? null,
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

  return { summary, stopReason, steps: toolsRun, changes, credits: creditsAfter, spent };
}

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
    const task = (body.match(/^\s*task:\s*(.+)$/im)?.[1] ?? body).split('\n')[0].trim();
    if (!task) return 'err: give the helper a task, on a `task:` line inside SUBAGENT';
    events?.emit('subagent_start', { task });
    const out = await subagent(task);
    events?.emit('subagent_end', { task, out });
    session?.append('note', { text: `helper: ${task}\n${String(out).slice(0, 2000)}` });
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

  const risk = classify(call.kind);
  // Shell when it was never enabled: the tool itself owns that message, and
  // letting the gate refuse it instead would hide why.
  if (call.kind === 'run' && !options.allowRun) return await tools.run('', call.body);
  if (permissions) {
    const verdict = permissions.evaluate({ kind: call.kind, arg: call.arg });
    if (risk === 'read') {
      // Reads are never asked about, but a deny rule still stops one before
      // the file is opened — `.env* → deny` is how secrets stay local.
      if (verdict.decision === 'deny') {
        return `err: ${verdict.reason} denies reading ${call.arg}; the file stays on this machine`.slice(0, 300);
      }
    } else if (verdict.decision !== 'allow') {
      const decision = await permissions.request({ kind: call.kind, arg: call.arg, preview: previewOf(call) });
      if (decision === 'deny') return `err: the person watching declined ${call.kind} ${call.arg}`.slice(0, 300);
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
