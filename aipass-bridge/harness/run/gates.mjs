// @ts-check
// The DONE gates: what has to be true before a run may end.
//
// Four gates sit between a model's "DONE" and the end of the run:
//
//   1. the checker  — staged code earns a read-only verdict before a DONE is
//      accepted; a `fail` rides the next message instead of ending the run
//   2. the strict gate — with `requireCheck` on, a DONE over a declared check
//      that is still failing is refused outright
//   3. the plan checkpoint — a DONE that arrives with plan/TODO items still
//      open names them and asks for a ticked TODO
//   4. the language hook — a closing message that is mostly not Thai while the
//      person reads Thai is asked for a rewrite, once
//
// They live together because they share one order and one set of counters:
// checker → checkpoint → language → done_line (docs/LOOP_DESIGN.md).
import path from 'node:path';
import { posix } from '../overlay.mjs';
import { thaiRatio } from '../lang.mjs';
import { hasFindings } from '../review.mjs';
import { RunContext } from './context.mjs';

/**
 * The DONE gates of one run.
 *
 * @param {RunContext} run
 */
export function createDoneGates(run) {
  // The checker is bounded per run: a failed check that earned a fix (the
  // tree moved since the last verdict) earns one re-check; a DONE over the
  // tree the check already judged earns none.
  const CHECK_ROUNDS_MAX = 2;

  /**
   * Run the checker over the staged tree, if it can run.
   *
   * A DONE over staged code earns a read-only check before it is accepted —
   * always, even when the run "verified" itself with a run or a read-back: a
   * temporary assertion is not a verdict, and only the child's own runs
   * decide. It is an execution, so it runs only where the run itself could
   * run things.
   *
   * @returns {Promise<string|null>} the failure report that rides back, or null
   */
  const finishCheck = async () => {
    if (!run.check || !run.options.subagent || !run.options.allowRun) return null;
    if (!run.overlay.size || !run.codeTouched) return null;
    if (run.checks >= CHECK_ROUNDS_MAX) return null;
    if (run.checks > 0 && run.mutations === run.mutationsAtLastCheck) return null;
    run.mutationsAtLastCheck = run.mutations;
    run.verifySent = true; // the run is being checked; R4 stands down
    const files = run.stagedFiles(20);
    const label = files.map((/** @type {{path: string, deleted: boolean}} */ f) => (f.deleted ? `${f.path} (deleted)` : f.path)).join(', ') || 'the staged tree';
    run.note(`check: ${label} staged — a read-only child is looking at the tree Apply would produce`);
    run.emit('check_start', { files, command: run.declaredCheckCommand() || null });
    try {
      run.checkResult = await run.check({ files });
    } catch (err) {
      // Structural failure never crosses the boundary.
      const why = /** @type {any} */ (err);
      run.checkResult = { verdict: 'none', text: `check could not run: ${why.message}`, ran: 0 };
    }
    if (!run.checkResult.skipped) run.checks += 1;
    run.note(`check ${run.checkResult.verdict}: ${String(run.checkResult.text ?? '').slice(0, 2000)}`);
    run.emit('check_end', {
      verdict: run.checkResult.verdict,
      ran: run.checkResult.ran ?? 0,
      skipped: Boolean(run.checkResult.skipped),
      // The exact command the verdict is about, so two runs' `checkVerdict`
      // values are only ever compared when the `checkCommand` matches.
      command: run.checkResult.declared ?? null,
      commandSource: run.checkResult.declaredSource ?? null,
    });
    return run.checkResult.verdict === 'fail'
      ? `Before DONE, a check of the staged tree ran and did not pass:\n${String(run.checkResult.text ?? '').slice(0, 4000)}\n\nFix the staged files, or explain why the failure is not yours to fix.`
      : null;
  };

  /**
   * The command whose check is still failing, when the strict gate applies.
   *
   * @returns {string|null}
   */
  const unverifiedDone = () => {
    if (!run.options.requireCheck) return null;
    if (!run.check || !run.options.subagent || !run.options.allowRun) return null;
    if (!run.overlay.size || !run.codeTouched) return null;
    if (run.checkResult?.verdict !== 'fail') return null;
    return run.declaredCheckCommand() || null;
  };

  /**
   * Refuse a DONE that the strict gate covers.
   *
   * The gate fires when a later DONE arrives over the tree the check already
   * judged, or when no step is left to carry the correction. It is terminal on
   * purpose — the model already saw the failure report and chose to end
   * anyway.
   *
   * @returns {boolean} whether the run was stopped here
   */
  const refuseUnverifiedDone = () => {
    const failing = unverifiedDone();
    if (!failing) return false;
    run.doneUnverified += 1;
    run.summary = `DONE not accepted — the declared check (${failing}) is still failing.`;
    run.note(`strict Verify: ${run.summary}`);
    run.emit('note', { text: `strict Verify: ${failing} is still failing — the run stops without accepting DONE` });
    run.stopReason = 'done-unverified';
    return true;
  };

  /**
   * The goal gate: while the person's project goal is active, a plain DONE is
   * not the end. Each refused DONE buys one more round, up to the goal's own
   * cap; at the cap the goal is recorded blocked and the run stops.
   *
   * The controller re-reads the store before every change, so a `aipass goal
   * pause|clear` typed in another window while this run was working is
   * respected — a run cannot resurrect a goal the person put down.
   *
   * Called only when a step is left to carry the nudge: a round that would
   * never reach the model must not be spent (dsh's rule).
   *
   * @returns {{stop: boolean, msg: string|null}|null}
   */
  const goalGate = () => {
    const out = run.goal?.done();
    if (!out) return null;
    if (out.stop) {
      run.summary = out.summary;
      run.stopReason = 'goal-rounds';
      run.note(`goal: ${out.summary}`);
      run.emit('note', { text: out.summary });
      return { stop: true, msg: null };
    }
    run.note(`goal round: DONE refused — round ${out.rounds} of ${out.maxRounds}`);
    run.emit('goal_round', { round: out.rounds, max: out.maxRounds });
    return { stop: false, msg: out.msg };
  };

  /**
   * The language hook: ask for a Thai rewrite of the closing message, once.
   *
   * A short closing never triggers it (a dozen letters is a glance, not a
   * message), and code, commands and URLs do not count toward the ratio.
   * `plain` says the closing reply was prose only. A reply that also carried
   * calls shows their bodies in `proseText` — a CREATE's file body, a plan
   * block — and a body is content, not a message: only the closing line is
   * judged then.
   *
   * @param {string} proseText the prose the reply carried
   * @param {string} closing the closing line
   * @param {boolean} [plain] whether the reply was prose only
   * @returns {string|null} the correction that rides back, or null
   */
  const replyLangMsg = (proseText, closing, plain = true) => {
    if (!run.sheet.langCheck || run.langSent) return null;
    const judged = plain ? `${proseText ?? ''}\n${closing ?? ''}` : `${closing ?? ''}`;
    const { ratio, letters } = thaiRatio(judged);
    if (letters < 12 || ratio >= run.sheet.minThaiRatio) return null;
    run.langSent = true;
    run.langPrompts += 1;
    run.note(`language check: the closing message was ${Math.round(ratio * 100)}% Thai — asking for a Thai rewrite`);
    run.emit('lang_prompt', { ratio: Number(ratio.toFixed(3)), min: run.sheet.minThaiRatio });
    return `Language check: I read Thai. Of the letters in that closing message ${Math.round(ratio * 100)}% were Thai, under the ${Math.round(run.sheet.minThaiRatio * 100)}% I ask for. Rewrite the closing message in Thai — keep code, commands, file paths and tool arguments exactly as they are.`;
  };

  /**
   * The plan checkpoint: name the open items of the checklist, once.
   *
   * A run that wrote a PLAN or a TODO carries a checklist of what "done"
   * means. DONE used to be accepted with items still open — a long plan could
   * end half-finished and nothing said so.
   *
   * @returns {string|null} the nudge that rides back, or null
   */
  const openTodoMsg = () => {
    if (run.todoPromptSent || !run.todoState.length) return null;
    const open = run.todoState.filter((it) => !it.done);
    if (!open.length) return null;
    run.todoPromptSent = true;
    run.todoPrompts += 1;
    const cap = 8;
    const named = open.slice(0, cap).map((it) => `- ${it.text}`).join('\n');
    run.note(`plan checkpoint: DONE arrived with ${open.length} open item(s) — asking for them first`);
    run.emit('note', { text: `plan checkpoint: the checklist still has ${open.length} open item(s) — asking the model to close or drop them` });
    return `Before I take that as done: the plan/TODO this run recorded still lists ${open.length} open item(s):\n${named}${open.length > cap ? `\n… and ${open.length - cap} more` : ''}\n\nIf they are finished, send a TODO list with [x] on them; if any is dropped, say which and why; otherwise continue with the open items and then say DONE. A DONE after this message ends the run either way.`;
  };

  /**
   * The background-command gate: a run does not say DONE over a job it left
   * running.
   *
   * The first DONE earns one nudge that names the jobs and the two ways out
   * (wait and poll, or stop). A DONE after that is accepted only as an end
   * that says so: the run stops with `jobs-running` and the summary names the
   * output files, so the person is not told the work finished when a build is
   * still going. A job that finished between steps is already not counted.
   *
   * @param {boolean} canNudge whether a step is left to carry the nudge
   * @returns {{stop: boolean, msg: string|null}}
   */
  const jobsGate = (canNudge) => {
    const running = [...run.backgroundJobs.values()].filter((j) => j.kind === 'run' && j.status === 'running');
    if (!running.length) return { stop: false, msg: null };
    const ids = running.map((j) => j.id);
    if (!run.jobsPromptSent && canNudge) {
      run.jobsPromptSent = true;
      run.note(`background commands still running: ${ids.join(', ')} — asking before DONE`);
      run.emit('note', { text: `background command(s) ${ids.join(', ')} are still running — asking the model to wait or stop them before DONE` });
      const lines = running.map((j) => `- ${j.id}: ${j.task} — output: ${j.outputRel}`);
      return { stop: false, msg: `Before DONE: the background command(s) this run started are still running:\n${lines.join('\n')}\n\nPoll with JOBS until they finish, or end one with JOBS stop <id> (the whole tree). A DONE you send anyway ends the run and leaves the job to the person.` };
    }
    run.summary = `DONE with background command(s) still running: ${ids.join(', ')} — their output is in ${running.map((j) => j.outputRel).join(', ')}`;
    run.stopReason = 'jobs-running';
    run.note(`background commands left running at DONE: ${ids.join(', ')}`);
    run.emit('note', { text: run.summary });
    return { stop: true, msg: null };
  };

  /**
   * The review check: a review's closing message must carry the findings it
   * exists to produce.
   *
   * One nudge, then the answer stands — the language hook's shape. The gate
   * is advisory on purpose: a wrong-shaped answer is still the model's
   * answer, and refusing to end would spend steps to no one's benefit. The
   * FLOOR is elsewhere (the loop refuses every mutating marker), so this only
   * decides whether the report reads as a report.
   *
   * @returns {string|null} the nudge that rides back, or null
   */
  const reviewMsg = () => {
    if (!run.options.review || run.reviewPrompted) return null;
    if (hasFindings(run.summary)) return null;
    run.reviewPrompted = true;
    run.note('review check: the closing message carried no findings block — asking once');
    run.emit('note', { text: 'review check: asking for the findings list' });
    return 'Review check: this run is a review, and the closing message did not carry findings. Send the list — one line per finding, "blocker|major|minor path:line — what is wrong — the smallest fix" — or write "no findings" and name what you read.';
  };

  return { finishCheck, unverifiedDone, refuseUnverifiedDone, goalGate, replyLangMsg, openTodoMsg, jobsGate, reviewMsg };
}

export default createDoneGates;
