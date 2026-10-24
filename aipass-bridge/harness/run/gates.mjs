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

  return { finishCheck, unverifiedDone, refuseUnverifiedDone, replyLangMsg, openTodoMsg };
}

export default createDoneGates;
