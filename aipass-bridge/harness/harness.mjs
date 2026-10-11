// The facade: one object that owns a run.
//
// A CLI, the desktop UI and the tests all talk to this — never to the loop
// directly — because it is the piece that knows the two facts that shape
// everything: the bridge holds ONE current conversation at a time, and the
// upstream accepts ONE user message per request. Compaction and helpers both
// have to work around that, and both of them live here.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Emitter } from './events.mjs';
import { Overlay } from './overlay.mjs';
import { SkillLibrary } from './skills.mjs';
import { BridgeClient } from './bridge.mjs';
import { createTools } from './tools.mjs';
import { PermissionEngine } from './permissions.mjs';
import { SessionStore } from './session.mjs';
import { Compactor } from './compact.mjs';
import { runTask, applyOverlay } from './loop.mjs';
import { preamble as buildPreamble } from './protocol.mjs';
import { RulesStore } from './rules.mjs';

const REPO_SKILLS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'skills');

const home = () => path.join(os.homedir(), '.aipass');

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
      : new BridgeClient(opts.bridgeURL ?? 'http://127.0.0.1:8787', { model: opts.model ?? this.options.model ?? null });
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
    // Permission rules: the caller's own first, then the project's persisted
    // ones (harness/rules.mjs) — first match wins, so explicit beats stored.
    // "Always" answers write through to the same file, so they survive a
    // restart; previously they died with the process.
    this.rulesStore = opts.rulesStore ?? (opts.rulesFile ? new RulesStore(opts.rulesFile) : new RulesStore());
    const persisted = this.rulesStore.forRoot(this.root);
    this.permissions = new PermissionEngine({
      mode: this.options.mode,
      allowRun: this.options.allowRun,
      rules: [...(opts.rules ?? []), ...persisted.rules],
      events: this.events,
      // How long an unanswered permission question waits before it resolves
      // to deny. The CLI's default suits a terminal someone is watching; the
      // desktop passes 0 — the human may be three minutes into reading a
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
    const made = await this.bridge.createConversation({
      model: this.bridge.model ?? undefined,
      assistant: this.options.assistant ?? undefined,
      temporary: !this.options.permanent,
      message: 'Starting a new working session.',
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

  /* ------------------------------------------------------------------ run */

  async run(task, { first = null, runPluginTool = null } = {}) {
    if (!task?.trim()) throw new Error('no task given');
    if (!this.session) await this.startSession();
    this.running = true;
    this.abort = new AbortController();

    const isFirst = first ?? this.session.entries.every((e) => e.type !== 'task');

    // Context is a rotating resource here, so check it before the turn, not after.
    let seedText = null;
    if (this.compactor.needsCompaction(this.session)) {
      this.events.emit('note', { text: 'context is filling up — summarising earlier work and starting a fresh conversation' });
      const summary = await this.compactor.summarize(this.session, { task, model: this.bridge.model });
      this.session.append('compaction', { summary, firstKeptEntryId: this.session.entries.at(-1)?.id ?? null });
      await this.#rotate(summary, task);
      this.events.emit('compacted', { summary });
      seedText = this.compactor.seed({
        summary,
        task,
        listing: '',
        preambleText: buildPreamble({
          allowRun: Boolean(this.options.allowRun),
          plan: Boolean(this.options.plan),
          subagent: Boolean(this.options.subagent),
        }),
      });
    }

    await this.#ensureConversation();

    try {
      return await runTask(task, {
        bridge: this.bridge,
        tools: this.tools,
        overlay: this.overlay,
        session: this.session,
        permissions: this.permissions,
        events: this.events,
        subagent: this.options.subagent ? this.#makeHelper() : null,
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
   */
  #makeHelper() {
    return async (task) => {
      const child = new Overlay(this.root);
      const childSession = this.store.create({ root: this.root, model: this.bridge.model, title: `helper: ${task.slice(0, 60)}` });
      const childPermissions = new PermissionEngine({ mode: 'yolo', allowRun: false });
      // The helper borrows its own conversation (P2-B) instead of moving the
      // bridge's current one and restoring it afterwards — the old dance left
      // the parent pointing at the child's conversation if anything died
      // mid-helper. adopt:false never touches the pointer, so there is no
      // restore to get wrong.
      const made = await this.bridge.createConversation({ temporary: true, message: task, adopt: false }).catch(() => null);
      const helperConversation = made?.id ?? null;
      this.events.emit('helper_start', { task, session: childSession.id });

      let result;
      try {
        result = await runTask(task, {
          bridge: this.bridge,
          tools: createTools({
            root: this.root, overlay: child, skills: this.skills, bridge: this.bridge,
            model: this.bridge.model, allowRun: false, events: this.events,
            conversation: helperConversation, temporary: true,
          }),
          overlay: child,
          session: childSession,
          permissions: childPermissions,
          events: this.events,
          conversation: helperConversation,
          conversationTemporary: helperConversation ? true : null,
          options: { ...this.options, maxSteps: Math.min(this.options.maxSteps, 8), subagent: false, signal: this.abort.signal },
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
      this.events.emit('helper_end', { task, summary: result.summary ?? '', prepared });

      const lines = [result.summary ?? 'The helper finished without a summary.'];
      if (prepared.length) lines.push(`Files prepared and waiting for approval: ${prepared.join(', ')}`);
      return lines.join('\n\n');
    };
  }
}
