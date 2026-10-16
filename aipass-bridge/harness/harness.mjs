// The facade: one object that owns a run.
//
// A CLI, the desktop UI and the tests all talk to this — never to the loop
// directly — because it is the piece that knows the two facts that shape
// everything: the bridge holds ONE current conversation at a time, and the
// upstream accepts ONE user message per request. Compaction and helpers both
// have to work around that, and both of them live here.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Emitter } from './events.mjs';
import { Overlay } from './overlay.mjs';
import { SkillLibrary } from './skills.mjs';
import { BridgeClient, DEFAULT_BRIDGE_URL } from './bridge.mjs';
import { createTools } from './tools.mjs';
import { PermissionEngine } from './permissions.mjs';
import { SessionStore } from './session.mjs';
import { Compactor } from './compact.mjs';
import { runTask, applyOverlay, SUBAGENT_ROLES } from './loop.mjs';
import { preamble as buildPreamble } from './protocol.mjs';
import { RulesStore } from './rules.mjs';
// One address for "where this app keeps its state", shared with the rpc layer:
// AIPASS_HOME when a surface (a test) names one, ~/.aipass otherwise.
import { aipassHome } from './settings.mjs';

const REPO_SKILLS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'skills');

const home = () => aipassHome();

export class Harness {
  /** Resolves the plan-approval gate; null when nobody is waiting on it. */
  #planResolve = null;
  /** The WEB scratch conversation id, created lazily and reused. */
  #scratch = null;

  /**
   * @param {object} opts
   * @param {string} opts.root           directory the agent may touch
   * @param {string} opts.bridgeURL      base URL of the local bridge
   * @param {string} [opts.model]        default model id
   * @param {object} [opts.options]      {maxSteps, allowRun, mode, slim, plan, subagent, requirePlanApproval, conversation, reuse, permanent, assistant}
   * @param {Array}  [opts.rules]        permission path rules
   * @param {Emitter}[opts.events]
   * @param {SessionStore} [opts.store]
   */
  constructor(opts = {}) {
    this.root = path.resolve(opts.root ?? process.cwd());
    this.events = opts.events ?? new Emitter();
    this.options = {
      maxSteps: 10,
      maxToolCalls: 300,
      maxWallClockMs: 1_800_000,
      allowRun: false,
      mode: 'ask',
      plan: false,
      subagent: false,
      requirePlanApproval: false,
      conversation: null,
      reuse: false,
      permanent: false,
      assistant: null,
      searchI: false,
      attach: false,
      webScratch: false,
      parallelHelpers: false,
      ...(opts.options ?? {}),
    };
    this.bridge = opts.bridge instanceof BridgeClient
      ? opts.bridge
      : new BridgeClient(opts.bridgeURL ?? DEFAULT_BRIDGE_URL, { model: opts.model ?? this.options.model ?? null });
    this.skills = opts.skills ?? SkillLibrary.default({ root: this.root, repoDir: REPO_SKILLS });
    this.store = opts.store === 'off' ? null : (opts.store ?? new SessionStore(path.join(home(), 'sessions')));
    this.overlay = new Overlay(this.root);
    this.tools = createTools({
      root: this.root,
      overlay: this.overlay,
      skills: this.skills,
      bridge: this.bridge,
      model: this.bridge.model,
      allowRun: this.options.allowRun,
      events: this.events,
      log: (_level, text) => this.events.emit('note', { text }),
      // WEB on a scratch conversation (P2-B), when the run opts in.
      webConversation: this.options.webScratch ? () => this.#scratchConversation() : null,
    });
    /* ------------------------------------------------------------- path rules *
     *
     * Two stores have held permission rules, and this is where they meet.
     *
     * `settings.rules` (settings.mjs) is the single EDITABLE surface: it is
     * what the window's rules page and rules.get/rules.set speak, and the CLI
     * writes the same file - so there is one list to read and one to edit
     * rather than two that quietly disagree. An explicit `rules` option is that
     * surface, and it is placed AHEAD of the stored ones so an explicit rule
     * always outranks a stored one. The desktop's rpc passes it on every
     * harness it builds.
     *
     * RulesStore (harness/rules.mjs) is the fallback for a caller that passes
     * none, so a rule the CLI persisted for this project still applies to the
     * next run - and it KEEPS owning the persisted "always" grants either way.
     * Those are answers, not policy: they are what makes the desktop stop
     * asking the same question on every run, and they must survive a restart
     * whether or not a settings file exists.
     */
    this.rulesStore = opts.rulesStore ?? (opts.rulesFile ? new RulesStore(opts.rulesFile) : new RulesStore());
    const persisted = this.rulesStore.forRoot(this.root);
    this.permissions = new PermissionEngine({
      mode: this.options.mode,
      allowRun: this.options.allowRun,
      rules: [...(opts.rules ?? []), ...persisted.rules],
      events: this.events,
      // How long an unanswered permission question waits before it resolves
      // to deny. The CLI's default suits a terminal someone is watching; the
      // desktop passes 0 - the human may be three minutes into reading a
      // diff, and a silent deny is worse than a wait.
      timeoutMs: opts.permissionTimeoutMs ?? 120_000,
      onGrant: (kind, arg) => this.rulesStore.addGrant(this.root, kind, arg),
    });
    for (const g of persisted.grants) this.permissions.grants.set(`${g.kind}:${g.arg}`, 'allow');
    this.compactor = new Compactor({ bridge: this.bridge, events: this.events, ...(opts.compaction ?? {}) });
    this.session = null;
    this.conversation = null;
    this.abort = new AbortController();
    this.running = false;
    this.#planResolve = null;
  }

  /* ------------------------------------------------------------ sessions */

  async startSession({ title = null, sessionId = null } = {}) {
    if (!this.store) { this.session = null; return null; }
    this.session = sessionId ? this.store.load(sessionId) : null;
    if (!this.session) {
      this.session = this.store.create({ root: this.root, model: this.bridge.model, title });
    }
    this.events.emit('session', { id: this.session.id, title: this.session.title, file: this.session.file });
    return this.session;
  }

  /* ---------------------------------------------------------- conversation */

  /** Bring the bridge onto a conversation this run can talk to. */
  async #ensureConversation() {
    if (this.conversation) return;
    if (this.options.conversation) {
      await this.bridge.config({ conversation: this.options.conversation });
      this.conversation = this.options.conversation;
      return;
    }
    if (this.options.reuse) {
      // The bridge resolves its own most recent conversation at request time;
      // creating one here would defeat the point of reusing.
      return;
    }
    // A tab that cannot be reached is the loop's story to tell (needs_tab,
    // one click to fix), so that refusal falls back to null here — the create
    // retry inside BridgeClient already absorbed a reconnect gap first. Any
    // other failure (the bridge itself being down) must reject the run on the
    // way in, not start one that cannot send.
    const made = await this.bridge.createConversation({
      model: this.bridge.model ?? undefined,
      assistant: this.options.assistant ?? undefined,
      temporary: !this.options.permanent,
      message: 'Starting a new working session.',
    }).catch((err) => {
      if (/no extension connected/i.test(err.message)) return null;
      throw err;
    });
    this.conversation = made?.id ?? null;
    this.events.emit('conversation', { id: this.conversation, temporary: !this.options.permanent });
  }

  /** Bring the bridge onto a conversation this run can talk to. */
  async prepareConversation() { return this.#ensureConversation(); }

  /**
   * Change who may write what, mid-session. Both the options and the engine
   * have to move together, or a mode switch from the window would change what
   * the UI reports and not what the loop does.
   */
  setPolicy({ mode = null, allowRun = null } = {}) {
    if (mode) { this.options.mode = mode; this.permissions.mode = mode; }
    if (allowRun != null) { this.options.allowRun = Boolean(allowRun); this.permissions.allowRun = Boolean(allowRun); }
    return this.options;
  }

  /**
   * Replace the path rules on the live engine, mid-session.
   *
   * The engine reads `this.rules` on every evaluate(), so swapping the array
   * is enough - but it has to happen on the *engine*, not just in settings:
   * a rule that only exists in the file changes nothing until the next
   * start, which is precisely the lie the window must not tell. The caller
   * (rpc's rules.set / settings.set) has already written the settings file;
   * this is the half that makes the save true right now.
   */
  setRules(rules = []) {
    this.permissions.rules = Array.isArray(rules) ? rules : [];
    return this.permissions.rules;
  }
  async #rotate(summary, task) {
    await this.bridge.createConversation({ temporary: true, message: 'Continuing earlier work.' });
    const st = await this.bridge.status().catch(() => null);
    this.conversation = st?.conversation ?? this.conversation;
    this.events.emit('conversation', { id: this.conversation, temporary: true, rotated: true });
    return summary;
  }

  /** One throwaway conversation all WEB lookups share (P2-B), lazily made. */
  async #scratchConversation() {
    if (this.#scratch) return this.#scratch;
    const made = await this.bridge
      .createConversation({ temporary: true, message: 'Web search scratch space.', adopt: false })
      .catch(() => null);
    this.#scratch = made?.id ?? null;
    if (this.#scratch) this.events.emit('conversation', { id: this.#scratch, temporary: true, scratch: true });
    return this.#scratch;
  }

  /**
   * Rotate the conversation now, carrying the work so far as a summary.
   *
   * The upstream cannot trim its own history, so this is the only lever there
   * is: ask the model for a summary of what has been done, record it in the
   * session, start a fresh conversation, and re-seed it with the summary and
   * the task. It runs automatically when the budget is close to full and on
   * demand from the window's compact button - the same path, because a manual
   * rotation that behaved differently would be a surprise waiting to happen.
   *
   * @returns {Promise<{summary: string, seedText: string}>}
   */
  async compactNow(task = '') {
    if (!this.session) throw new Error('no session to compact');
    const summary = await this.compactor.summarize(this.session, { task, model: this.bridge.model });
    this.session.append('compaction', { summary, firstKeptEntryId: this.session.entries.at(-1)?.id ?? null });
    await this.#rotate(summary, task);
    this.events.emit('compacted', { summary });
    // The staged list rides along (deletes marked): a rotation is where a
    // pending edit gets forgotten, and the fresh conversation must know the
    // tree is not what the disk says yet.
    const staged = this.overlay.keys().map((abs) => {
      const rel = path.relative(this.root, abs).split(path.sep).join('/');
      return this.overlay.isDeleted(abs) ? `${rel} (deleted)` : rel;
    }).slice(0, 20);
    const seedText = this.compactor.seed({
      summary,
      task,
      listing: '',
      preambleText: buildPreamble({
        allowRun: Boolean(this.options.allowRun),
        plan: Boolean(this.options.plan),
        subagent: Boolean(this.options.subagent),
        lang: this.options.replyLanguage === 'en' ? 'en' : 'th',
      }),
      staged,
    });
    return { summary, seedText };
  }

  /** How full the context budget is right now, for whoever is watching. */
  contextUsage() {
    const used = this.compactor.estimate(this.session);
    const budget = this.compactor.budgetFor(this.bridge.model);
    const percent = budget ? Math.min(100, Math.round((used / budget) * 100)) : 0;
    return {
      used,
      budget,
      reserved: this.compactor.reserveTokens,
      percent,
      compactAt: this.compactor.triggerPercent,
      needsCompaction: this.compactor.needsCompaction(this.session),
      entries: this.session?.entries.length ?? 0,
    };
  }

  /* ------------------------------------------------------------------ run */

  async run(task, { first = null, runPluginTool = null } = {}) {
    if (!task?.trim()) throw new Error('no task given');
    // One run per harness. The bridge holds exactly one current conversation
    // and one position in it, so a second run would overwrite the first's
    // abort controller and interleave its replies into the same conversation.
    // The flag goes up before the first await: two callers arriving at once
    // must not both squeeze past the check while `startSession` is pending.
    if (this.running) throw new Error('a run is already in flight - cancel it first (/stop)');
    this.running = true;
    try {
      if (!this.session) await this.startSession();
      this.abort = new AbortController();

      const isFirst = first ?? this.session.entries.every((e) => e.type !== 'task');

      // Context is a rotating resource here, so check it before the turn, not after.
      let seedText = null;
      if (this.compactor.needsCompaction(this.session)) {
        this.events.emit('note', { text: 'context is filling up - summarising earlier work and starting a fresh conversation' });
        seedText = (await this.compactNow(task)).seedText;
      }

      await this.#ensureConversation();

      return await runTask(task, {
        bridge: this.bridge,
        tools: this.tools,
        overlay: this.overlay,
        session: this.session,
        permissions: this.permissions,
        events: this.events,
        subagent: this.options.subagent ? this.#makeHelper() : null,
        check: this.#makeChecker(task),
        runPluginTool: runPluginTool ?? this.runPluginTool ?? null,
        approvePlan: this.options.requirePlanApproval
          ? () => new Promise((resolve) => { this.events.emit('plan_request', {}); this.#planResolve = resolve; })
          : null,
        compactor: this.compactor,
        rotate: (summary) => this.#rotate(summary, task),
        options: {
          ...this.options,
          signal: this.abort.signal,
          seedText,
        },
        first: isFirst,
      });
    } finally {
      // Every failure before the loop - a session that will not open, a
      // compaction that fails - has to clear the flag too, or one bad run
      // locks the project out for the rest of the process's life.
      this.running = false;
    }
  }

  /** The human answered a plan gate. */
  answerPlan(ok) { this.#planResolve?.(ok); this.#planResolve = null; }

  /** The human answered a permission question. */
  answer(id, decision) { return this.permissions.answer(id, decision); }

  /** Write the accepted files (null = everything pending). */
  apply(files = null) {
    const result = applyOverlay(this.overlay, files, { session: this.session, events: this.events });
    this.overlay.clear();
    return result;
  }

  /** Drop everything pending without writing. */
  discard() {
    const n = this.overlay.size;
    this.overlay.clear();
    this.events.emit('discarded', { files: n });
    return n;
  }

  cancel() {
    this.abort.abort();
    this.events.emit('cancelled', {});
  }

  pendingChanges() {
    return this.overlay.changes().map(({ file, added, removed, deleted, isNew }) => ({ file, added, removed, deleted, isNew }));
  }

  /* ------------------------------------------------------------- helpers */

  /**
   * A helper run: its own session file, its own overlay, its own temporary
   * conversation. It cannot write to disk — its edits are moved into the
   * parent overlay, where they wait for the same approval anything else does.
   * That is why its permission engine is permissive: everything it "writes" is
   * a proposal, never a change.
   *
   * A `role:` on the marker narrows it (SUBAGENT_ROLES): the role's own
   * instructions lead the task, and the helper is read-only — its write
   * markers answer with `err:` before anything is staged. A verifier may RUN
   * checks; the other roles only read.
   */
  #makeHelper() {
    return async (task, role = null) => {
      const spec = role ? (SUBAGENT_ROLES[role] ?? null) : null;
      const brief = spec ? `${spec.lead}\n\nTask: ${task}` : task;
      // A verifier may RUN checks, but only where the run itself may: the
      // child narrows the parent's permissions, never widens them.
      const canRun = Boolean(spec?.run) && Boolean(this.options.allowRun);
      const child = new Overlay(this.root);
      const childSession = this.store.create({ root: this.root, model: this.bridge.model, title: `${role ? `${role}: ` : 'helper: '}${task.slice(0, 60)}` });
      // The parent's path rules travel with the helper. They are statements
      // about the project (`.env*  deny`), not about which run is editing, so
      // a rule-free engine here would make every one of them a lie the moment
      // the model handed the work to a helper.
      const childPermissions = new PermissionEngine({ mode: 'yolo', allowRun: canRun, rules: this.permissions.rules });
      // The helper borrows its own conversation (P2-B) instead of moving the
      // bridge's current one and restoring it afterwards — the old dance left
      // the parent pointing at the child's conversation if anything died
      // mid-helper. adopt:false never touches the pointer, so there is no
      // restore to get wrong.
      const made = await this.bridge.createConversation({ temporary: true, message: brief, adopt: false }).catch(() => null);
      const helperConversation = made?.id ?? null;
      this.events.emit('helper_start', { task, role: role || null, session: childSession.id });

      let result;
      try {
        result = await runTask(brief, {
          bridge: this.bridge,
          tools: createTools({
            root: this.root, overlay: child, skills: this.skills, bridge: this.bridge,
            model: this.bridge.model, allowRun: canRun, events: this.events,
            readOnly: Boolean(spec),
            readOnlyNote: spec ? 'this helper is read-only — report it in your summary instead.' : null,
            conversation: helperConversation, temporary: true,
          }),
          overlay: child,
          session: childSession,
          permissions: childPermissions,
          events: this.events,
          conversation: helperConversation,
          conversationTemporary: helperConversation ? true : null,
          options: { ...this.options, maxSteps: Math.min(this.options.maxSteps, 8), subagent: false, allowRun: canRun, signal: this.abort.signal },
          first: true,
        });
      } catch (err) {
        result = { summary: `helper failed: ${err.message}` };
      }

      const prepared = [];
      for (const [abs, value] of child.map) {
        this.overlay.map.set(abs, value);
        prepared.push(path.relative(this.root, abs).split(path.sep).join('/'));
      }
      if (prepared.length) {
        this.events.emit('diff_update', { changes: this.pendingChanges() });
        this.session?.append('note', { text: `helper prepared edits pending approval: ${prepared.join(', ')}` });
      }
      this.events.emit('helper_end', { task, role: role || null, summary: result.summary ?? '', prepared });

      const lines = [result.summary ?? 'The helper finished without a summary.'];
      if (prepared.length) lines.push(`Files prepared and waiting for approval: ${prepared.join(', ')}`);
      return lines.join('\n\n');
    };
  }

  /**
   * The checker (SPEC_CHECKER.md): one read-only child run over the staged
   * tree — the piece that puts a verdict behind a DONE. Its tools read a
   * snapshot of the parent's staged files, so `read` and `run` see the tree
   * Apply would produce, and every `run` goes through the projection for the
   * same reason any run does. It may not write anything, and its verdict is
   * computed from what it actually ran, never from its prose. A fail report
   * rides back to the model; a pass finishes silently.
   */
  #makeChecker(taskText) {
    return async ({ files }) => {
      const label = files.map((f) => (f.deleted ? `${f.path} (deleted)` : f.path)).join(', ') || 'the staged tree';
      // Its own conversation, adopt:false — the P2-B pattern. The parent's
      // context is the exact resource a check exists to protect, so falling
      // back to it is never allowed; a check without its own conversation is
      // skipped, and the skip says why.
      const made = await this.bridge
        .createConversation({ temporary: true, message: `Checking the staged changes: ${label}`, adopt: false })
        .catch(() => null);
      const checkerConversation = made?.id ?? null;
      if (!checkerConversation) {
        this.session?.append('note', { text: 'check skipped: could not open a separate conversation for it' });
        return { verdict: 'none', text: 'check could not run: no separate conversation is available', ran: 0, skipped: true };
      }

      // The tools' view: the parent's staged map, one-for-one (deletes
      // included, so the projection leaves those files out). The run's own
      // overlay stays empty — the checker stages nothing, and runTask clears
      // its overlay on entry, so these have to be two objects.
      const staged = new Overlay(this.root);
      for (const [abs, value] of this.overlay.map) staged.map.set(abs, value);
      // (SPEC_CHECKER) The staged set may include the project's own tests. The
      // checker runs what the checked-out project would run, so tests the run
      // edited are visible to it — name them, so a passing check that also
      // edited its tests is not read as proof of the code.
      const touchedTests = [...staged.map.keys()]
        .map((abs) => path.relative(this.root, abs).split(path.sep).join('/'))
        .filter((p) => /(^|\/)(tests?|__tests__|spec)\//i.test(p) || /\.(test|spec)\.[cm]?[jt]sx?$/i.test(p));

      const childSession = this.store?.create({ root: this.root, model: this.bridge.model, title: `check: ${label.slice(0, 60)}` });

      // (declared check) A project can name the one command that decides
      // correctness: the first non-comment line of `.aipass/check.txt`. Read
      // from DISK, not the overlay — a value staged in this run must not bend
      // the command that judges it. Absent, the checker infers the project's
      // checks the way it always has.
      let declared = null;
      try {
        const declaredFile = path.join(this.root, '.aipass', 'check.txt');
        if (fs.existsSync(declaredFile)) {
          const line = fs.readFileSync(declaredFile, 'utf8').split('\n')
            .map((l) => l.trim()).find((l) => l && !l.startsWith('#'));
          if (line) declared = line.slice(0, 300);
        }
      } catch { declared = null; }
      // The parent's path rules travel, as they do to a helper. The engine is
      // permissive because the readOnly tools are the real gate: the checker
      // cannot write even where a rule would have allowed it.
      const childPermissions = new PermissionEngine({ mode: 'yolo', allowRun: true, rules: this.permissions.rules });
      const prompt = [
        `You are the checker: a read-only pass over work that is already staged for this project.`,
        taskText ? `The run was working on: ${String(taskText).slice(0, 500)}` : '',
        `These pending edits are already applied in the tree you are looking at: ${label}.`,
        touchedTests.length
          ? `Note: this pending set includes test files: ${touchedTests.slice(0, 8).join(', ')}. Treat test edits as part of the change under review, and say plainly what you ran.`
          : '',
        declared
          ? `The project declares its own check command. Run exactly this, as one command, and let its output decide:\n${declared}`
          : `Run the project's own checks against them — the test command, a build, a typecheck, node --check on the changed files. Prefer the smallest command that would prove or disprove the change.`,
        `You cannot edit anything, and a fix is not yours to make. Say DONE with one line on what you ran and what it showed; if nothing can be run from here, say exactly that.`,
      ].filter(Boolean).join('\n\n');

      // A fresh, silent emitter: the checker's own `done_line` and `finished`
      // must not render as the parent's (the window would end the wrong
      // turn), while the outer loop brackets the whole lookup with
      // check_start / check_end.
      const childEvents = new Emitter();

      let result;
      try {
        result = await runTask(prompt, {
          bridge: this.bridge,
          tools: createTools({
            root: this.root, overlay: staged, skills: this.skills, bridge: this.bridge,
            model: this.bridge.model, allowRun: true, events: childEvents,
            conversation: checkerConversation, temporary: true, readOnly: true,
          }),
          overlay: new Overlay(this.root),
          session: childSession,
          permissions: childPermissions,
          events: childEvents,
          conversation: checkerConversation,
          conversationTemporary: true,
          options: {
            ...this.options,
            maxSteps: Math.min(this.options.maxSteps, 6),
            plan: false,
            requirePlanApproval: false,
            subagent: false,
            signal: this.abort.signal,
          },
          first: true,
        });
      } catch (err) {
        result = { summary: `check could not run: ${err.message}` };
      }

      // The verdict is computed, not read: from what the child actually ran.
      const runs = (childSession?.entries ?? []).filter((e) => e.type === 'tool' && e.kind === 'run');
      const failed = runs.filter((e) => !e.ok);
      const verdict = failed.length ? 'fail' : runs.length ? 'pass' : 'none';
      const evidence = failed.slice(0, 3).map((e) => String(e.out ?? '').trim()).filter(Boolean).join('\n\n');
      const text = [result.summary, evidence].filter(Boolean).join('\n\n').slice(0, 4000) || 'the check produced no output';
      const noteAbout = touchedTests.length
        ? `\n\nnote: this run modified test files: ${touchedTests.slice(0, 8).join(', ')} — the check above ran against the staged copies.`
        : '';
      return { verdict, text: (text + noteAbout).slice(0, 4400), ran: runs.length, testsTouched: touchedTests.length, declared };
    };
  }
}
