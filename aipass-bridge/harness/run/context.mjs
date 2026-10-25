// @ts-check
// The run's own state — one object, one owner.
//
// `runTask` used to be one closure of ~1,150 lines: the send pipeline, the
// DONE gates, the budgets and the guards all shared a handful of `let`
// variables that only existed inside that function. Nothing could be tested
// on its own, and a counter that belonged to the budgets sat next to a flag
// that belonged to the checker.
//
// The context is that state, written down. It holds what the run was given
// (the bridge, the tools, the session) and what the run has done so far (the
// counters, the verdict, the conversation it is sending into). The stages in
// this folder — `send.mjs`, `gates.mjs`, `budgets.mjs` — read and write it,
// and each of them can be exercised without a run around it.
//
// The design of record for the stages is `docs/LOOP_DESIGN.md`.
import fs from 'node:fs';
import path from 'node:path';
import { posix } from '../overlay.mjs';
import { normalizeOptions } from './options.mjs';

/**
 * Everything one run owns.
 *
 * The counters are named after the guards they belong to, not after the
 * sentence in `run_stats` that reports them: `mutations` is the repeat
 * guard's clock, `checks` is the checker's own budget, and `errStreak` is the
 * near-miss guard's streak.
 */
export class RunContext {
  /**
   * @param {string} taskText the task, as the person wrote it
   * @param {Record<string, any>} ctx the wiring the facade hands over
   */
  constructor(taskText, ctx = {}) {
    /* --- what the run was given ------------------------------------------- */
    this.taskText = taskText;
    this.bridge = ctx.bridge;
    this.tools = ctx.tools;
    this.overlay = ctx.overlay;
    this.session = ctx.session ?? null;
    this.permissions = ctx.permissions ?? null;
    this.events = ctx.events ?? null;
    this.subagent = ctx.subagent ?? null;
    this.check = ctx.check ?? null;
    this.approvePlan = ctx.approvePlan ?? null;
    this.runPluginTool = ctx.runPluginTool ?? null;
    this.compactor = ctx.compactor ?? null;
    this.rotate = ctx.rotate ?? null;
    this.listingShown = ctx.listingShown ?? null;
    this.onConversationDead = ctx.onConversationDead ?? null;
    this.onConversationSettled = ctx.onConversationSettled ?? null;
    // Messages the person typed while the run was in flight (Harness.inject):
    // the loop drains this queue at the top of every step after the first, so
    // they ride the next paste — the one message the protocol allows — instead
    // of interrupting the run or waiting for it to end.
    this.injected = Array.isArray(ctx.injected) ? ctx.injected : null;
    this.first = ctx.first !== false;
    // The raw sheet, as the caller wrote it, and the clamped one the run
    // reads. Both are needed: the raw sheet carries the flags the gates ask
    // about (`allowRun`, `requireCheck`, `verifyCommand`), and the clamped
    // one carries the numbers a budget is measured in.
    this.options = ctx.options ?? {};
    this.sheet = normalizeOptions(this.options);

    /* --- the conversation the run sends into ------------------------------- */
    this.conversation = ctx.conversation ?? null;
    this.conversationTemporary = ctx.conversationTemporary ?? null;
    this.swappedConversation = false;

    /* --- the message that is about to go out -------------------------------- */
    // The WAF table is the AiPASS edge's own: it exists because that edge
    // refuses ordinary source code, and it rewrites a README's `localhost`
    // into a placeholder so the payload gets through. A provider that is a
    // plain API has no such firewall, and encoding for it would hand the model
    // `CONSOLE-LOG` where its file said `console.log`. The client says which
    // world this run is in; everything below asks it once.
    this.waf = ctx.bridge?.waf !== false;
    this.next = null;
    this.listingToRecord = null;
    // Attachments ride the first message of the RUN: the server keeps the
    // history, so re-sending the same image every step would re-upload it.
    //
    // The gate used to be the session's own first run, which is a different
    // thing: from the second run of a session onward the picture the person
    // had just attached was read, encoded and then dropped on the floor —
    // the model was asked about a file it had never seen, and the window
    // reported the send as a success. The send stage already keeps the parts
    // to the run's first message (run/send.mjs), which is the rule that was
    // meant all along.
    this.firstParts = Array.isArray(this.options.parts) ? this.options.parts : null;

    /* --- how the run ended ------------------------------------------------ */
    this.summary = null;
    this.stopReason = 'steps';
    this.sendError = null;

    /* --- the send ---------------------------------------------------------- */
    this.sends = 0;
    this.firewallNotes = 0;
    this.sendRecoveries = 0;

    /* --- the work ---------------------------------------------------------- */
    this.toolsRun = 0;
    this.mutations = 0;      // staged changes — the repeat guard's clock
    this.toolStats = new Map(); // kind → { n, fail, ms }
    this.stepMs = [];
    this.todoState = [];
    this.planApproved = !this.options.requirePlanApproval;

    /* --- the nudge path ---------------------------------------------------- */
    this.nudges = 0;         // every "no marker" nudge the run needed
    this.nudgeStreak = 0;    // consecutive ones — the third stops the run

    /* --- the stagnation guard ---------------------------------------------- */
    this.stagnationWarns = 0;
    this.stagnantStep = 0;
    this.lastStepSig = null;
    this.prevSigs = [];
    this.oscillate = 0;
    this.circleStrikes = 0;
    this.circleLen = 0;
    this.circleStates = new Set();

    /* --- the verification nudge (R4) --------------------------------------- */
    this.verifyPrompts = 0;
    this.verifySent = false;
    this.codeTouched = false;
    this.verifiedSinceChange = false;

    /* --- the plan checkpoint ----------------------------------------------- */
    this.todoPrompts = 0;
    this.todoPromptSent = false;

    /* --- the language hook -------------------------------------------------- */
    this.langPrompts = 0;
    this.langSent = false;

    /* --- evidence novelty --------------------------------------------------- */
    this.novelResults = 0;
    this.repeatedResults = 0;
    this.resultSeen = new Set();

    /* --- the repeat guard ---------------------------------------------------- */
    this.repeatBlocks = 0;
    this.repeatTrip = false;
    this.repeatSeen = new Map();

    /* --- the near-miss (err-loop) guard --------------------------------------- */
    this.errKindKey = '';
    this.errStreak = 0;
    this.errLoops = 0;
    this.errTrip = false;
    this.chainSkips = 0;

    /* --- the budgets --------------------------------------------------------- */
    this.budgetHit = null;
    this.creditsBefore = null;
    this.creditBaseline = null;
    this.creditObserved = null;

    /* --- the checker ---------------------------------------------------------- */
    this.checks = 0;
    this.checkResult = null;
    this.mutationsAtLastCheck = -1;
    this.doneUnverified = 0;
    // The declared check (docs/SPEC_CHECKER.md): a `verifyCommand` option when
    // the caller names one, otherwise the first non-comment line of
    // `.aipass/check.txt`, read lazily once. `null` = not read yet; `''` =
    // absent (or unreadable).
    this.declaredCheck = null;
    this.declaredCheckSource = null;
    this.declaredPassAt = -1;
    this.commitBlocks = 0;

    /* --- helpers --------------------------------------------------------------- */
    this.backgroundJobs = new Map();
    this.reportedBg = new Set();

    /* --- the overflow recovery (one compact-and-retry per run) ------------------ */
    this.overflowRetried = false;

    /* --- the clock -------------------------------------------------------------- */
    this.runStart = Date.now();
  }

  /**
   * Emit an event, if the run has an emitter.
   * @param {string} type
   * @param {any} payload
   */
  emit(type, payload) {
    this.events?.emit(type, payload);
  }

  /**
   * Write a line into the session log, if the run has one.
   * @param {string} text
   */
  note(text) {
    this.session?.append('note', { text });
  }

  /** The run's stop switch: the person pressed stop. */
  stopped() {
    return this.options.signal?.aborted === true;
  }

  /**
   * The declared check of this run, read once.
   *
   * The red-test gate bars a `git commit` until this exact command has passed
   * at the current tree state, and the checker's verdict names it — so both
   * read the same one command, and it is read once.
   *
   * @returns {string} the command, or '' when the run declares none
   */
  declaredCheckCommand() {
    if (this.declaredCheck !== null) return this.declaredCheck;
    const configured = String(this.options.verifyCommand ?? '').trim();
    if (configured) {
      this.declaredCheck = configured.split('\n')[0].trim().slice(0, 300);
      this.declaredCheckSource = 'run';
      return this.declaredCheck;
    }
    try {
      const raw = fs.readFileSync(path.join(this.overlay.root, '.aipass', 'check.txt'), 'utf8');
      this.declaredCheck = raw.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#')) ?? '';
      if (this.declaredCheck) this.declaredCheckSource = 'project';
    } catch { this.declaredCheck = ''; }
    return this.declaredCheck;
  }

  /**
   * The staged files, as the checker wants them: the paths a run would write,
   * relative to the project, with a delete marked.
   */
  stagedFiles(limit = 20) {
    return this.overlay.keys()
      .map((/** @type {string} */ abs) => ({
        path: posix(path.relative(this.overlay.root, abs)),
        deleted: this.overlay.isDeleted(abs),
      }))
      .slice(0, limit);
  }
}

export default RunContext;
