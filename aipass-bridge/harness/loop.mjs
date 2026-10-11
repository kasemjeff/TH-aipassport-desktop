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
import { outbound } from './waf.mjs';
import {
  REMINDER, prose, parse, parseTodo, mergeTodo, READING,
  preamble as buildPreamble,
} from './protocol.mjs';
import { resilientSay, decode } from './bridge.mjs';
import { classify } from './permissions.mjs';

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
 * @param {Function} [ctx.approvePlan] async () => boolean
 * @param {Function} [ctx.runPluginTool] async (marker, {arg, body}) => string
 * @param {object} [ctx.options]
 * @param {boolean} [first]       first turn of this conversation (send the preamble)
 */
export async function runTask(taskText, ctx = {}) {
  const {
    bridge, tools, overlay, session = null, permissions = null, events = null,
    subagent = null, approvePlan = null, options = {}, first = true,
    runPluginTool = null, compactor = null, rotate = null,
    conversation = null, conversationTemporary = null,
  } = ctx;  const maxSteps = Number(options.maxSteps ?? 10);
  const model = options.model ?? null;
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
    session?.append('user', { text, bytes: Buffer.byteLength(text) });
    const res = await bridge.chat({
      message: text,
      parts: withParts ?? null,
      model,
      ...(conversation ? { conversation, temporary: conversationTemporary } : {}),
      signal: options.signal ?? null,
      onText: (t) => events?.emit('assistant_delta', { text: t }),
      onReasoning: (t) => events?.emit('reasoning_delta', { text: t }),
    });
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

  let nudges = 0;
  let toolsRun = 0;
  let summary = null;
  let stopReason = 'steps';

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
    catch (err) { events?.emit('error', { message: err.message }); stopReason = 'error'; break; }
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
        events?.emit('done_line', { text: cleanArg || 'done', extra });
        stopReason = 'done';
        break;
      }
      if (++nudges > 2) { events?.emit('give_up', {}); stopReason = 'stalled'; break; }
      events?.emit('nudge', { n: nudges });
      next = `I could not tell what to open from that. I have the project open here and I am pasting you whatever you name — nothing happens on your side. ${REMINDER}`;
      continue;
    }
    nudges = 0;

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
      events?.emit('done_line', { text: summary, extra });
      stopReason = 'done';
      break;
    }
    if (done) events?.emit('ignore_done', {});
    next = `${results.join('\n\n')}\n\n${REMINDER}`;

    // The budget is re-checked here, against the message that is about to go
    // out: tool results reach the server's conversation through it, so a long
    // task crosses the line mid-run, not only between runs. If the summarise
    // or the rotation itself fails, the results still go out — losing the
    // step's work to a compaction error would be worse than an over-budget
    // conversation.
    if (compactor && session && compactor.needsCompaction(session, { pendingBytes: Buffer.byteLength(next) })) {
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

  // One line per run that `npm run stats` aggregates — refusals, nudges and
  // firewall notes are how protocol drift shows up before it is guessed at.
  const runStats = {
    stopReason,
    steps: toolsRun,
    tools: Object.fromEntries(toolStats),
    nudges,
    firewallNotes,
    stepMs,
    spent,
  };
  session?.append('run_stats', runStats);
  events?.emit('run_stats', runStats);

  events?.emit('finished', {
    summary, steps: toolsRun, stopReason, spent,
    credits: creditsAfter,
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
  if (permissions && risk !== 'read' && permissions.evaluate({ kind: call.kind, arg: call.arg }).decision !== 'allow') {
    const decision = await permissions.request({ kind: call.kind, arg: call.arg, preview: previewOf(call) });
    if (decision === 'deny') return `err: the person watching declined ${call.kind} ${call.arg}`.slice(0, 300);
    if (decision === 'always') { permissions.grant(call.kind, call.arg); }
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
