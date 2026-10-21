// @ts-check
// The budgets: what a run may spend before it is stopped.
//
// Three of them, and they are checked at different moments — the wall clock
// before every reply (waiting on a slow model is as real a spend as running a
// command), the credit cap against the bridge's cached quota, and the tool
// count before every call. A budget spent is an ending, and it is recorded
// like one: the session keeps the note, the window keeps the event, run_stats
// keeps the reason.
//
// The stage lives in its own module so the policy can be read — and pinned —
// without a run around it.
import { RunContext } from './context.mjs';

/**
 * The budget stage of one run.
 *
 * @param {RunContext} run
 */
export function createBudgets(run) {
  /**
   * The spend observed so far, in credits.
   *
   * The pre-run reading is the baseline, and when that was unavailable the
   * first successful reading becomes one. null until a reading lands — an
   * unknown spend never stops a run.
   *
   * @returns {Promise<number|null>}
   */
  const creditSpent = async () => {
    if (!run.sheet.maxCredits) return null;
    const q = await run.bridge.quota().catch(() => null);
    if (!q || q.available == null) return null;
    if (run.creditBaseline == null) run.creditBaseline = q.available;
    run.creditObserved = run.creditBaseline - q.available;
    return run.creditObserved;
  };

  /**
   * Spend a budget: the run is over, and the reason is recorded.
   *
   * @param {'tools-limited'|'time-limited'|'credit-limited'} reason
   */
  const spendBudget = (reason) => {
    run.budgetHit = reason;
    const used = reason === 'tools-limited'
      ? `${run.toolsRun}/${run.sheet.maxToolCalls} tool calls`
      : reason === 'credit-limited'
        ? `≈${run.creditObserved ?? 0} of ${run.sheet.maxCredits} credits`
        : `${Math.round((Date.now() - run.runStart) / 1000)}s of ${Math.round(run.sheet.maxWallClockMs / 1000)}s`;
    run.note(`budget guard: the run has spent its ${reason === 'tools-limited' ? 'tool-call' : reason === 'credit-limited' ? 'credit' : 'wall-clock'} budget (${used}) — stopping the run`);
    run.emit('budget', { reason, used });
  };

  /** Has the wall clock run out? */
  const overTime = () => Date.now() - run.runStart > run.sheet.maxWallClockMs;

  /** Has the optional credit cap been reached? */
  const overCredits = async () => {
    if (!run.sheet.maxCredits) return false;
    const spent = await creditSpent();
    return spent != null && spent >= run.sheet.maxCredits;
  };

  /**
   * Check every budget that applies before the next unit of work.
   *
   * The tool count is checked by the caller — it counts calls, not time — so
   * this one answers for the clock and the credits.
   *
   * @returns {Promise<string|null>} the reason a budget was spent, or null
   */
  const checkBudgets = async () => {
    if (overTime()) return 'time-limited';
    if (await overCredits()) return 'credit-limited';
    return null;
  };

  return { creditSpent, spendBudget, overTime, overCredits, checkBudgets };
}

export default createBudgets;
