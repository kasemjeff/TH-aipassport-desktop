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
  REMINDER, prose, parse, parseTodo, mergeTodo,
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
    runPluginTool = null,
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

  const say = async (text, withParts = null) => {
    session?.append('user', { text, bytes: Buffer.byteLength(text) });
    const res = await bridge.chat({
      message: text,
      parts: withParts ?? null,
      model,
      signal: options.signal ?? null,
      onText: (t) => events?.emit('assistant_delta', { text: t }),
      onReasoning: (t) => events?.emit('reasoning_delta', { text: t }),
    });
    session?.append('assistant', { text: res.text, reasoning: res.reasoning });
    return res.text;
  };
  const saySafe = (text, parts = null) => resilientSay(say, text, (_level, t) => events?.emit('firewall_note', { text: t }), parts);

  let listing = '';
  try { listing = outbound(tools.list('.')); } catch { /* ignore */ }

  const again = `The project is still open in front of me and I will paste you whatever you ask for.`
    + `\nTop level right now:\n${listing}`;

  const pre = buildPreamble({
    allowRun: Boolean(options.allowRun),
    plan: Boolean(options.plan),
    subagent: Boolean(options.subagent),
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

  for (let step = 1; step <= maxSteps; step++) {
    const stepStart = Date.now();
    let reply;
    try { reply = await saySafe(next, first ? (options.parts ?? null) : null); }
    catch (err) { events?.emit('error', { message: err.message }); stopReason = 'error'; break; }
    reply = decode(reply);

    const elapsed = ((Date.now() - stepStart) / 1000).toFixed(1);
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

    const results = [];
    for (let i = 0; i < work.length; i++) {
      const call = work[i];
      toolsRun++;
      let result;
      let blocked = false;
      try {
        result = await execute(call, { tools, permissions, events, subagent, todoState, session, approvePlan, options, runPluginTool });
      } catch (err) {
        result = `error: ${err.message}`;
        blocked = true;
      }
      const [head, ...rest] = String(result).split('\n');
      const refused = blocked || /^(no such|error|the text|that text)/.test(result) || / is (a|an) .*, not text\.$/.test(head);
      const isLast = i === work.length - 1 && !done;
      events?.emit('tool', { kind: call.kind, arg: call.arg, ok: !refused, head: head.slice(0, 70), lines: refused ? rest : [], isLast });
      session?.append('tool', { kind: call.kind, arg: call.arg, out: String(result).slice(0, 20_000), ok: !refused });
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

    const stillLooking = work.some((c) => c.kind === 'list' || c.kind === 'read' || c.kind === 'search' || c.kind === 'skill');
    if (done && !stillLooking) {
      summary = (done.arg || proseText || 'done').replace(/^[-—–:]\s*/, '').trim() || 'done';
      const extra = proseText && done.arg && proseText.trim() !== done.arg.trim() ? '\n' + proseText.trim() : '';
      events?.emit('done_line', { text: summary, extra });
      stopReason = 'done';
      break;
    }
    if (done) events?.emit('ignore_done', {});
    next = `${results.join('\n\n')}\n\n${REMINDER}`;
    if (step === maxSteps) events?.emit('step_limit', {});
  }

  const creditsAfter = await bridge.quota(true).catch(() => null);
  const spent = creditsBefore && creditsAfter ? creditsBefore.available - creditsAfter.available : null;
  const changes = overlay.changes();
  for (const c of changes) session?.append('diff', { file: c.file, added: c.added, removed: c.removed, deleted: c.deleted, decision: 'pending' });

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
    if (!subagent) return 'no helper is available in this run';
    const body = String(call.body ?? '');
    const task = (body.match(/^\s*task:\s*(.+)$/im)?.[1] ?? body).split('\n')[0].trim();
    if (!task) return 'give the helper a task, on a `task:` line inside SUBAGENT';
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
    if (!runPluginTool) return `no plugin tool named ${call.name} is installed`;
    events?.emit('plugin_call', { marker: call.name, arg: call.arg });
    try {
      return String(await runPluginTool(call.name, { arg: call.arg, body: call.body ?? '' }) ?? '');
    } catch (err) {
      return `error: ${err.message}`;
    }
  }

  const risk = classify(call.kind);
  // Shell when it was never enabled: the tool itself owns that message, and
  // letting the gate refuse it instead would hide why.
  if (call.kind === 'run' && !options.allowRun) return await tools.run('', call.body);
  if (permissions && risk !== 'read' && permissions.evaluate({ kind: call.kind, arg: call.arg }).decision !== 'allow') {
    const decision = await permissions.request({ kind: call.kind, arg: call.arg, preview: previewOf(call) });
    if (decision === 'deny') return `the person watching declined ${call.kind} ${call.arg}`.slice(0, 300);
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
