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
import { Compactor, DEFAULT_MODEL_BUDGETS } from './compact.mjs';
import { loadMemory, saveMemory, clearMemory } from './memory-store.mjs';
import { McpManager } from './mcp.mjs';
import { runTask, applyOverlay, SUBAGENT_ROLES } from './loop.mjs';
import { preamble as buildPreamble } from './protocol.mjs';
import { RulesStore } from './rules.mjs';
import { sweepSandboxes } from './sandbox.mjs';
import { loadGitignore } from './gitignore.mjs';
// One address for "where this app keeps its state", shared with the rpc layer:
// AIPASS_HOME when a surface (a test) names one, ~/.aipass otherwise.
import { aipassHome, harnessOptions } from './settings.mjs';

/** @typedef {import('./settings.mjs').HarnessOptions} HarnessOptions */

const REPO_SKILLS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'skills');

export class Harness {
  /** Resolves the plan-approval gate; null when nobody is waiting on it. */
  #planResolve = null;
  /** The WEB scratch conversation id, created lazily and reused. */
  #scratch = null;
  /** A manual rotation's summary + facts, waiting for the next run's seed. */
  #pendingSummary = null;
  /** Facts persisted across sessions for this project (cross-session memory). */
  #crossSessionMemory = [];
  /**
   * (listing delta) The top level each conversation was last shown, keyed by
   * bridge conversation id. The loop reads it to answer an identical listing
   * with a one-line "unchanged" note instead of re-pasting the table, and
   * writes it after the message that carried the listing was accepted. A
   * conversation created or rotated here gets no entry, so it always starts
   * from the full listing.
   */
  #listingShown = new Map();
  /**
   * How `conversation` came about, for the per-send temporary flag: true/false
   * for a conversation this harness created, null when it was pointed at one
   * (an explicit id, or one resolved from the bridge's own pointer).
   */
  #conversationTemporary = null;
  /** The session id the in-memory conversation belongs to, or null (no session yet). */
  #conversationBoundTo = null;
  /**
   * (resume) The boundary a resume seed folds away, waiting for the seed's
   * first accepted send — commiting it earlier would reset the budget
   * estimate against a digest the model never received.
   */
  #pendingResumeBoundary = null;
  /** Ids of the conversations this run made (vs adopted from the session). */
  #madeThisRun = new Set();
  /** The spill warning is said once per harness, not once per run. */
  #warnedSpill = false;

  /**
   * @param {object} opts
   * @param {string} opts.root           directory the agent may touch
   * @param {string} opts.bridgeURL      base URL of the local bridge
   * @param {object} [opts.client]       the client to talk through — a bridge
   *   client or a provider client. ONE name for both, because a provider is a
   *   client and not a second loop (rule 14): the harness needs the contract,
   *   not to know which edge answered it. Without one, it opens a bridge
   *   client of its own.
   * @param {string} [opts.model]        default model id
   * @param {Partial<HarnessOptions>} [opts.options] the run's option sheet —
   *   its defaults live in `settings.mjs` (`HarnessOptions`), so the harness
   *   and the loop read one sheet and cannot drift apart.
   * @param {Array}  [opts.rules]        permission path rules
   * @param {Emitter}[opts.events]
   * @param {SessionStore} [opts.store]
   */
  constructor(opts = {}) {
    this.root = path.resolve(opts.root ?? process.cwd());
    this.events = opts.events ?? new Emitter();
    // One option sheet, one owner: `settings.mjs` holds the defaults and the
    // typedef, so a key cannot be defaulted here and read there. The values
    // themselves are the harness's own — a fetch the model invented is a
    // question, not a read (off until a surface says yes on purpose), helpers
    // are off until the caller asks for them, and the declared check stays
    // advisory until a project or a person names one.
    this.options = harnessOptions(opts.options);
    this.bridge = opts.client ?? new BridgeClient(opts.bridgeURL ?? DEFAULT_BRIDGE_URL, {
      model: opts.model ?? this.options.model ?? null,
      // A 429 wait must read as a pause, not a stuck run: the client's
      // note rides the same dim-note channel as the firewall notes.
      onNote: (text) => this.events.emit('firewall_note', { text }),
      // A mid-reply model switch is the site talking to the person: it
      // belongs in the transcript as a visible note line, not folded
      // into the reasoning beside the tool churn.
      onStreamNote: (text) => this.events.emit('note', { text }),
    });
    // Which provider this harness talks to. The client is the thing that
    // knows; this is the label the window and the session header carry.
    this.providerId = this.bridge.providerId ?? 'aipass';
    // A client from outside (a provider) raises its notes the same way the
    // bridge client does — they are harness events, not client trivia.
    if (opts.client) this.#wireNotes(this.bridge);
    this.skills = opts.skills ?? SkillLibrary.default({ root: this.root, repoDir: REPO_SKILLS });
    this.store = opts.store === 'off' ? null : (opts.store ?? new SessionStore(path.join(aipassHome(), 'sessions')));
    this.overlay = new Overlay(this.root);
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
      // A fetch the model invented is a question the person sees — unless the
      // surface has no window to ask in and has said yes on the command line
      // (`--allow-fetch`), the way `--allow-run` says yes to the shell.
      allowExfil: Boolean(this.options.allowFetch),
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
    const comp = opts.compaction ?? {};
    // A per-model budget map, when one is supplied (or the default one when it is
    // not), wins over the flat contextTokens default — flash-class runs no longer
    // rotate every 9k tokens. An explicit budgets object always overrides.
    const budgets = (comp.budgets && typeof comp.budgets === 'object' && !Array.isArray(comp.budgets) && Object.keys(comp.budgets).length)
      ? comp.budgets
      : DEFAULT_MODEL_BUDGETS;
    this.compactor = new Compactor({ bridge: this.bridge, events: this.events, budgets, ...comp });
    this.mcp = new McpManager({ root: this.root, log: (t) => this.events.emit('note', { text: t }) });
    this.session = null;
    this.conversation = null;
    this.abort = new AbortController();
    this.#crossSessionMemory = loadMemory(this.root);
    this.events.on('compacted', ({ memory }) => {
      if (Array.isArray(memory) && memory.length) {
        try { this.#crossSessionMemory = saveMemory(this.root, [...this.#crossSessionMemory, ...memory]); } catch { /* best effort */ }
      }
    });
    this.running = false;
    this.#planResolve = null;
    // (janitor) A backend that was killed mid-RUN leaves the whole projection
    // behind, and nothing else ever collected it. This harness is the first
    // thing that touches this project again, so it sweeps what no run can
    // still own. Fire and forget: the sweep deletes trees, and a deletion
    // that blocked the backend's event loop would freeze the window.
    void sweepSandboxes(this.root).catch(() => {});
  }

  /**
   * Point this harness at another provider.
   *
   * The client is swapped, not the harness: everything below this line — the
   * loop, the tools, the compactor — talks to `this.bridge` and to nothing
   * else, so a client that answers the same contract is the whole of the
   * change. The compactor keeps its own reference (it summarises with the
   * client), so it moves with it.
   */
  setProvider(client) {
    if (!client) return this.bridge;
    this.#wireNotes(client);
    this.bridge = client;
    this.compactor.bridge = client;
    this.providerId = client.providerId ?? 'aipass';
    return this.bridge;
  }

  /**
   * The notes a client raises — a wait, a mid-reply switch — are the harness's
   * own events, wherever the client came from. A client that already has them
   * (the bridge client does) keeps its own.
   */
  #wireNotes(client) {
    if (!client) return;
    if (typeof client.onNote !== 'function') {
      client.onNote = (text) => this.events.emit('firewall_note', { text });
    }
    if (typeof client.onStreamNote !== 'function') {
      client.onStreamNote = (text) => this.events.emit('note', { text });
    }
  }

  /**
   * The tool table for one run.
   *
   * A fresh table per run is what the read-first gate needs: `readSet`
   * (tools.mjs) is the list of files THIS run has looked at, and a table
   * shared across runs carries a mark from a previous run into the next —
   * letting a blind CREATE past the very gate that exists to refuse it. The
   * ATTACH queue rides the same lifetime: a part belongs to the message it
   * was queued for, not to the harness. Building here also keeps the table's
   * copy of live options (allowRun's refusal text, the web scratch hook) in
   * step with setPolicy between runs.
   */
  #makeTools() {
    return createTools({
      root: this.root,
      overlay: this.overlay,
      skills: this.skills,
      bridge: this.bridge,
      model: this.bridge.model,
      allowRun: this.options.allowRun,
      // The CLI's --max-result / --read-lines are per-run knobs: without this
      // plumbing they sat in this.options and the tools kept their defaults,
      // so the flags were notes nobody read.
      maxResult: this.options.maxResult,
      readLines: this.options.readLines,
      events: this.events,
      log: (_level, text) => this.events.emit('note', { text }),
      // This run's stop switch: a RUN that is in flight when the person
      // presses stop is killed with the tree, instead of running to its own
      // timeout while the window says the run has stopped.
      signal: this.abort.signal,
      // WEB on a scratch conversation (P2-B), when the run opts in.
      webConversation: this.options.webScratch ? () => this.#scratchConversation() : null,
    });
  }

  /* ------------------------------------------------------------ sessions */

  async startSession({ title = null, sessionId = null } = {}) {
    // Another session's rotation must not seed this one.
    this.#pendingSummary = null;
    this.#pendingResumeBoundary = null;
    if (!this.store) { this.session = null; return null; }
    const prevSessionId = this.session?.id ?? null;
    this.session = sessionId ? this.store.load(sessionId, { root: this.root }) : null;
    if (!this.session) {
      this.session = this.store.create({ root: this.root, model: this.bridge.model, title });
    }
    // A session owns its conversation. Adopting the session's own binding is
    // what makes reopening one a warm resume — the upstream still holds the
    // history the transcript was written against. A fresh session gets none,
    // and what must never happen is the PREVIOUS session's conversation
    // riding along: that is how one session's messages used to land in
    // another session's history. A conversation made before any session
    // existed (the CLI's prepareConversation) belongs to the harness, not to
    // a session, and is kept; a caller that pinned a conversation (or asked
    // to reuse the bridge's own) is left to #ensureConversation, which honors
    // and records it.
    if (this.options.conversation || this.options.reuse) {
      this.conversation = null;
      this.#conversationTemporary = null;
      this.#conversationBoundTo = null;
    } else if (this.session.header.conversation) {
      this.conversation = this.session.header.conversation;
      this.#conversationTemporary = this.session.header.conversationTemporary ?? null;
      this.#conversationBoundTo = this.session.id;
    } else if (this.#conversationBoundTo && this.#conversationBoundTo !== this.session.id) {
      this.conversation = null;
      this.#conversationTemporary = null;
      this.#conversationBoundTo = null;
    } else if (this.running && prevSessionId && prevSessionId !== this.session.id) {
      // Switching sessions under a live run: the in-flight conversation is
      // that run's, and the new session must not inherit it.
      this.conversation = null;
      this.#conversationTemporary = null;
      this.#conversationBoundTo = null;
    }
    this.events.emit('session', { id: this.session.id, title: this.session.title, file: this.session.file });
    return this.session;
  }

  /* ---------------------------------------------------------- conversation */

  /** Bring the bridge onto a conversation this run can talk to. */
  async #ensureConversation({ resume = false } = {}) {
    if (this.conversation) return;
    if (this.options.conversation) {
      await this.bridge.config({ conversation: this.options.conversation });
      this.conversation = this.options.conversation;
      this.#conversationTemporary = null;
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
      message: resume ? 'Continuing earlier work.' : 'Starting a new working session.',
    }).catch((err) => {
      if (/no extension connected/i.test(err.message)) return null;
      throw err;
    });
    this.conversation = made?.id ?? null;
    this.#conversationTemporary = made?.id ? !this.options.permanent : null;
    // Binding happens on the first accepted send (#settleConversation), not
    // here: a conversation that never heard anything is not this session's,
    // and a run that dies before sending must leave the next one free to
    // start from the transcript again.
    if (made?.id) this.#madeThisRun.add(made.id);
    this.events.emit('conversation', { id: this.conversation, temporary: !this.options.permanent });
  }

  /** Bring the bridge onto a conversation this run can talk to. */
  async prepareConversation() { return this.#ensureConversation(); }

  /**
   * The conversation a session adopted turned out to be gone upstream — a
   * temporary that expired, one deleted by hand. Forget it everywhere (the
   * session header included), make a fresh one, and hand back the transcript
   * digest so the loop can continue instead of starting blind. The fresh
   * conversation becomes the session's on its first accepted send
   * (#settleConversation), not before. Null — the loop keeps its error — when
   * the bridge cannot make one (no tab, bridge down), and also when the
   * caller pinned a conversation or asked to reuse one: those are its to own.
   */
  async replaceDeadConversation(task = '') {
    if (this.options.conversation || this.options.reuse || !this.session) return null;
    this.conversation = null;
    this.#conversationTemporary = null;
    this.session.bindConversation(null);
    const made = await this.bridge.createConversation({
      model: this.bridge.model ?? undefined,
      assistant: this.options.assistant ?? undefined,
      temporary: !this.options.permanent,
      message: 'Continuing earlier work.',
    }).catch(() => null);
    if (!made?.id) return null;
    this.conversation = made.id;
    this.#conversationTemporary = !this.options.permanent;
    this.#madeThisRun.add(made.id);
    this.events.emit('conversation', { id: this.conversation, temporary: this.#conversationTemporary, resumed: true });
    return { conversation: this.conversation, temporary: this.#conversationTemporary, seedText: this.#resumeSeed(task) };
  }

  /**
   * Change who may write what, mid-session. Both the options and the engine
   * have to move together, or a mode switch from the window would change what
   * the UI reports and not what the loop does.
   */
  setPolicy({ mode = null, allowRun = null, allowFetch = null } = {}) {
    if (mode) { this.options.mode = mode; this.permissions.mode = mode; }
    if (allowRun != null) { this.options.allowRun = Boolean(allowRun); this.permissions.allowRun = Boolean(allowRun); }
    // The exfil tier travels with the policy: a fetch the model chose is a
    // question, and the machine may have been told to stop asking.
    if (allowFetch != null) { this.options.allowFetch = Boolean(allowFetch); this.permissions.allowExfil = Boolean(allowFetch); }
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
  /**
   * The staged files, deletes marked — what a rotation must not let a summary
   * compress away. Read live: a manual rotation's seed is built at the next
   * run, and by then the overlay may hold more than it did at rotation time.
   */
  #stagedList() {
    return this.overlay.keys().map((abs) => {
      const rel = path.relative(this.root, abs).split(path.sep).join('/');
      return this.overlay.isDeleted(abs) ? `${rel} (deleted)` : rel;
    }).slice(0, 20);
  }

  /** The latest PLAN/TODO checklist the session recorded, or null. A run that
   *  rotates mid-flight or a manual /compact must not forget the plan the
   *  previous conversation was working against. */
  #sessionTodo() {
    const entry = [...(this.session?.entries ?? [])].reverse().find((e) => e.type === 'todo' && Array.isArray(e.items));
    return entry?.items ?? null;
  }

  /**
   * The bounded digest of a session's own transcript, for a fresh conversation
   * that has to continue it. Entries the newest compaction already folded away
   * stay folded (its summary stands in for them); what happened since rides as
   * the tasks that were given and the model's own last words — the two facts
   * that say where the work stood. The open checklist is not repeated here:
   * seed() renders the full one from the same source.
   */
  #resumeDigest() {
    const entries = this.session?.entries ?? [];
    const lastCompaction = [...entries].reverse().find((e) => e.type === 'compaction' && e.summary);
    const boundary = lastCompaction?.lastSummarizedEntryId ?? lastCompaction?.firstKeptEntryId ?? null;
    const at = boundary ? entries.findIndex((e) => e.id === boundary) : -1;
    const live = at >= 0 ? entries.slice(at + 1) : entries;
    const tasks = live.filter((e) => e.type === 'task')
      .map((e) => String(e.text ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean);
    const last = [...live].reverse().find((e) => e.type === 'assistant' && String(e.text ?? '').trim());
    const lines = [];
    if (lastCompaction) lines.push(String(lastCompaction.summary));
    if (tasks.length) {
      const shown = tasks.slice(-3).map((t) => (t.length > 240 ? `${t.slice(0, 240)}…` : t));
      lines.push(`Tasks given to this session since (newest last):\n${shown.map((t) => `- ${t}`).join('\n')}`);
    }
    const words = last ? String(last.text).replace(/\s+/g, ' ').trim() : '';
    if (words) lines.push(`The model's own last words in this session:\n${words.length > 600 ? `${words.slice(0, 600)}…` : words}`);
    return lines.join('\n\n');
  }

  /**
   * The first message a resumed session's fresh conversation gets, instead of
   * starting blind. Built only when the transcript has something to say; the
   * boundary it folds away is committed by #settleConversation once the seed
   * was accepted — the budget estimate measures from there on, and a later
   * seed reuses this digest as the narrative instead of re-reading what it
   * already covers.
   */
  #resumeSeed(task) {
    const digest = this.#resumeDigest();
    if (!digest) return null;
    const summary = `This session's earlier conversation is no longer attached — the digest below is what its local transcript records of it.\n\n${digest}`;
    const seedText = this.compactor.seed({
      summary,
      memory: this.#crossSessionMemory,
      task,
      preambleText: buildPreamble({
        allowRun: Boolean(this.options.allowRun),
        plan: Boolean(this.options.plan),
        subagent: Boolean(this.options.subagent),
        searchI: Boolean(this.options.searchI),
        attach: Boolean(this.options.attach),
        plugins: this.options.pluginTools ?? [],
        lang: this.options.replyLanguage === 'en' ? 'en' : 'th',
      }),
      staged: this.#stagedList(),
      todo: this.#sessionTodo(),
    });
    this.#pendingResumeBoundary = { summary: digest, entryId: this.session?.entries.at(-1)?.id ?? null };
    return seedText;
  }

  /**
   * A conversation just took its first accepted word of this session: it is
   * the session's now (persisted, so a reopen adopts it), and a resume seed
   * that rode that send has its boundary committed. Called by the loop after
   * every accepted send — idempotent, so the calls after the first cost a
   * string compare and nothing else. The session is passed in, not read off
   * `this`: a run must stay bound to its own session even if the window opens
   * another one mid-flight.
   */
  #settleConversation(session, conversation, temporary) {
    if (!session || !conversation) return;
    this.#conversationBoundTo = session.id;
    try {
      if (session.header?.conversation !== conversation) session.bindConversation(conversation, temporary);
    } catch { /* best effort: a header that will not rewrite must not end a run */ }
    const pending = this.#pendingResumeBoundary;
    this.#pendingResumeBoundary = null;
    if (pending?.entryId) {
      try { session.append('compaction', { summary: pending.summary, lastSummarizedEntryId: pending.entryId }); } catch { /* best effort */ }
    }
  }

  async #rotate(summary, task) {
    // The id the create just returned, not a re-read of the bridge's shared
    // pointer: another harness may adopt its own conversation in the gap
    // between create and status, and `status` would then hand this run the
    // other session's conversation to continue in.
    const made = await this.bridge.createConversation({ temporary: true, message: 'Continuing earlier work.' });
    this.conversation = made?.id ?? this.conversation;
    this.#conversationTemporary = true;
    if (made?.id) this.#madeThisRun.add(made.id);
    this.events.emit('conversation', { id: this.conversation, temporary: true, rotated: true });
    // The session binding follows the first accepted send into the new
    // conversation (#settleConversation): a rotation the run dies before
    // using must not make a reopen adopt a conversation nothing ever entered.
    // The loop re-binds its own send target from this: its copy of the id is
    // what names every message until the run ends.
    return { conversation: this.conversation, temporary: this.#conversationTemporary };
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
   * @returns {Promise<{summary: string, memory: string[], seedText: string}>}
   */
  async compactNow(task = '') {
    if (!this.session) throw new Error('no session to compact');
    const raw = await this.compactor.summarize(this.session, {
      task, model: this.bridge.model,
      conversation: this.conversation, temporary: this.#conversationTemporary,
    });
    // The reply digests into the narrative and the merged facts — the facts
    // accumulate across rotations (digest reads the session's compaction
    // entries), so this rotation's seed carries everything earlier ones kept.
    const { summary, memory } = this.compactor.digest(this.session, raw);
    // Rotate first, record second — the loop's rotation keeps the same order:
    // a compaction entry for a rotation that failed would reset the estimate
    // against a conversation the model never carried.
    await this.#rotate(summary, task);
    this.session.append('compaction', { summary, ...(memory.length ? { memory } : {}), lastSummarizedEntryId: this.session.entries.at(-1)?.id ?? null });
    this.events.emit('compacted', { summary });
    // Persist the merged facts across sessions (cross-session memory).
    if (memory.length) {
      try { this.#crossSessionMemory = saveMemory(this.root, [...this.#crossSessionMemory, ...memory]); } catch { /* best effort */ }
    }
    // The staged list rides along (deletes marked): a rotation is where a
    // pending edit gets forgotten, and the fresh conversation must know the
    // tree is not what the disk says yet.
    const staged = this.#stagedList();
    const seedText = this.compactor.seed({
      summary,
      memory,
      task,
      // The same preamble the run would send, flags and all: a rotation that
      // silently dropped SEARCH -i, ATTACH or a plugin's markers was a
      // different run wearing the same name (the loop's own rotation passes
      // every one of them).
      preambleText: buildPreamble({
        allowRun: Boolean(this.options.allowRun),
        plan: Boolean(this.options.plan),
        subagent: Boolean(this.options.subagent),
        searchI: Boolean(this.options.searchI),
        attach: Boolean(this.options.attach),
        plugins: this.options.pluginTools ?? [],
        lang: this.options.replyLanguage === 'en' ? 'en' : 'th',
      }),
      staged,
      todo: this.#sessionTodo(),
    });
    return { summary, memory, seedText };
  }

  /**
   * Carry a manual rotation's summary into the next run. The window's
   * /compact has no run in flight, so without this the summary it just paid
   * for would never reach the fresh conversation — the next run would be
   * told "the project is still open" with nothing remembered. The merged
   * facts ride along or a long session's spine is cut at the rotation. The
   * seed is built there, against that run's own task: at rotation time
   * nobody knows what the next task will be, and losing it would be worse
   * than the memory the seed restores. Consumed once, by run().
   */
  rememberSummary(summary, memory = null) {
    const s = String(summary ?? '').trim() || null;
    this.#pendingSummary = s ? { summary: s, memory: Array.isArray(memory) ? memory : [] } : null;
    if (s && Array.isArray(memory) && memory.length) {
      try { this.#crossSessionMemory = saveMemory(this.root, [...this.#crossSessionMemory, ...memory]); } catch { /* best effort */ }
    }
    return s;
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

  /**
   * The harness's own directories live inside the project (`.aipass/spill`
   * holds the long tool results a run reads back). A project that is a git
   * repository and does not ignore `.aipass/` can commit them — so say so,
   * once, where the person is looking.
   */
  #warnSpillOnce() {
    if (this.#warnedSpill) return;
    this.#warnedSpill = true;
    try {
      if (!fs.existsSync(path.join(this.root, '.git'))) return; // not a repository
      if (loadGitignore(this.root).ignored('.aipass', true)) return;
      this.events.emit('note', { text: "this project is a git repository and does not ignore .aipass/ — the harness's own spill files could end up in a commit; add /.aipass/ to .gitignore" });
    } catch { /* best effort */ }
  }

  async run(task, { first = null, runPluginTool = null } = {}) {
    if (!task?.trim()) throw new Error('no task given');
    // One run per harness. The bridge holds exactly one current conversation
    // and one position in it, so a second run would overwrite the first's
    // abort controller and interleave its replies into the same conversation.
    // The flag goes up before the first await: two callers arriving at once
    // must not both squeeze past the check while `startSession` is pending.
    if (this.running) throw new Error('a run is already in flight - cancel it first (/stop)');
    this.running = true;
    // (janitor) The same sweep, before every run and not only at boot: a
    // long-lived backend (the window) touches a project many times over, and a
    // projection a killed backend left behind should not wait for the next
    // restart to go. Async: the sweep deletes trees, and that must not block
    // the event loop the window's stream runs on.
    void sweepSandboxes(this.root).catch(() => {});
    // A resume seed's boundary and the conversations this run may make are
    // facts about THIS run; nothing from an earlier one may leak into it.
    this.#pendingResumeBoundary = null;
    this.#madeThisRun = new Set();
    // This run's stop switch, created BEFORE the first await. It used to be
    // created after `startSession()` — a stop that landed in that window
    // aborted the previous run's controller, and the run that had just started
    // went on with a fresh, un-aborted one: the stop was simply lost, and the
    // person watched the work carry on after they had told it to stop.
    this.abort = new AbortController();
    try {
      this.#warnSpillOnce();
      if (!this.session) await this.startSession();
      const runSession = this.session;
      const settled = new Set();

      // MCP: lazy-load configured servers once per harness, then merge their
      // tools into the plugin tool table so the preamble and the loop see them.
      try { await this.mcp.ensureLoaded(); } catch { /* best effort */ }
      const mcpTools = this.mcp.toolTable();
      const basePluginTools = (this.options.pluginTools ?? []).filter((t) => !String(t?.marker ?? '').startsWith('MCP__'));
      this.options.pluginTools = [...basePluginTools, ...mcpTools];

      const isFirst = first ?? this.session.entries.every((e) => e.type !== 'task');

      // (resume) A session reopened with no conversation of its own — a file
      // written before bindings existed, one whose conversation was dropped —
      // would otherwise continue blind: the model never saw this session's
      // history and "the project is still open" reads as a lie. The new
      // conversation is made first (the digest needs somewhere to land), then
      // seeded from the transcript. Before the budget check below, on purpose:
      // the estimate describes a conversation that no longer exists.
      let seedText = null;
      if (!isFirst && !this.conversation && !this.options.conversation && !this.options.reuse) {
        await this.#ensureConversation({ resume: true });
        if (this.conversation) {
          seedText = this.#resumeSeed(task);
          if (seedText) {
            this.events.emit('note', { text: "this session's earlier conversation is not attached anymore - the fresh one is seeded from the local transcript" });
          }
        }
      }

      // Context is a rotating resource here, so check it before the turn, not after.
      // A manual rotation's summary rides the next run (rememberSummary): the
      // seed is built here, against this run's own task — at rotation time
      // nobody knew it yet. Consumed once: a second run must not repeat the
      // seed into a conversation that already carries it.
      if (!seedText && this.#pendingSummary) {
        const { summary, memory } = this.#pendingSummary;
        this.#pendingSummary = null;
        seedText = this.compactor.seed({
          summary,
          memory,
          task,
          preambleText: buildPreamble({
            allowRun: Boolean(this.options.allowRun),
            plan: Boolean(this.options.plan),
            subagent: Boolean(this.options.subagent),
            searchI: Boolean(this.options.searchI),
            attach: Boolean(this.options.attach),
            plugins: this.options.pluginTools ?? [],
            lang: this.options.replyLanguage === 'en' ? 'en' : 'th',
          }),
          staged: this.#stagedList(),
          todo: this.#sessionTodo(),
        });
      }
      if (!seedText && this.compactor.needsCompaction(this.session)) {
        this.events.emit('note', { text: 'context is filling up - summarising earlier work and starting a fresh conversation' });
        seedText = (await this.compactNow(task)).seedText;
      }

      await this.#ensureConversation();

      // Cross-session memory: on the first run of a session, carry forward the
      // facts persisted from earlier sessions so the model does not rediscover
      // them. Only on the first run — a later run in the same session already
      // has them in context.
      const effectiveTask = isFirst && this.#crossSessionMemory.length
        ? `Facts carried from earlier sessions (durable; re-check anything that may have gone stale):\n${this.#crossSessionMemory.map((f) => '- ' + f).join('\n')}\n\nTask: ${task}`
        : task;

      try {
        return await runTask(effectiveTask, {
          bridge: this.bridge,
          // The run talks in its own conversation, named on every send: with
          // several projects running at once the bridge's shared pointer can be
          // moved by any of them, and a nameless send would land wherever it
          // happens to point. The temporary flag rides along because every turn
          // of a temporary conversation has to repeat it.
          conversation: this.conversation,
          conversationTemporary: this.conversation ? this.#conversationTemporary : null,
          tools: this.#makeTools(),
          overlay: this.overlay,
          session: runSession,
          permissions: this.permissions,
          events: this.events,
          subagent: this.options.subagent ? this.#makeHelper() : null,
          check: this.#makeChecker(task),
          runPluginTool: (marker, args) => {
            // The stop rides the call: an MCP tool the person stopped does not
            // keep the run waiting for the server's answer.
            if (this.mcp.hasTool(marker)) return this.mcp.runTool(marker, { ...args, signal: this.abort.signal });
            const pluginRunner = runPluginTool ?? this.runPluginTool ?? null;
            if (pluginRunner) return pluginRunner(marker, args);
            return `no such tool: ${marker}`;
          },
          approvePlan: this.options.requirePlanApproval
            ? () => new Promise((resolve) => { this.events.emit('plan_request', {}); this.#planResolve = resolve; })
            : null,
          compactor: this.compactor,
          rotate: (summary) => this.#rotate(summary, task),
          // (resume) The conversation this session adopted can be gone upstream
          // (a temporary that expired, one deleted by hand). The loop only asks
          // on the run's first send, before anything of this run entered it;
          // the answer carries the fresh conversation and the transcript digest
          // it must be started with. See replaceDeadConversation.
          onConversationDead: () => this.replaceDeadConversation(task),
          // (resume) A conversation that just took one of this session's
          // messages is the session's now (persisted for a reopen), and a
          // resume seed's boundary is committed once it went out. The loop
          // calls this after every accepted send; the work itself is
          // idempotent.
          onConversationSettled: ({ conversation, temporary } = {}) => {
            if (conversation) settled.add(conversation);
            this.#settleConversation(runSession, conversation, temporary);
          },
          // (listing delta) The per-conversation listing memory the loop reads
          // and updates; see #listingShown.
          listingShown: this.#listingShown,
          options: {
            ...this.options,
            signal: this.abort.signal,
            seedText,
          },
          first: isFirst,
        });
      } finally {
        // (resume) A conversation this run made that never took a message —
        // the first send died, or a rotation's seed never went out — is
        // dropped: the next run starts from the transcript again instead of
        // talking into a tab that never heard who it is. Adopted conversations
        // (bound, or pinned by the caller) are not this run's to drop, and the
        // drop is in-memory only: nothing was persisted for them yet.
        const current = this.conversation;
        if (current && !settled.has(current) && this.#madeThisRun.has(current) && this.session === runSession) {
          this.conversation = null;
          this.#conversationTemporary = null;
          this.#conversationBoundTo = null;
        }
        // The run is over: everything it appended is on the disk. The header
        // rewrite fsyncs the file once per batch, so without this the last
        // entries of a finished run would sit in the OS's hands until
        // something else happened to flush them — and a power cut would take
        // the end of the conversation with it.
        try { runSession?.flush?.(); } catch { /* best effort */ }
      }
    } finally {
      // Every failure before the loop - a session that will not open, a
      // compaction that fails - has to clear the flag too, or one bad run
      // locks the project out for the rest of the process's life.
      this.running = false;
    }
  }

  /** Test-time scaling: run the task N times, keep the best by check verdict. */
  async scale(task, n = 3, opts = {}) {
    const attempts = Math.min(5, Math.max(1, Math.floor(Number(n) || 3)));
    const results = [];
    for (let i = 1; i <= attempts; i++) {
      this.events.emit('note', { text: `scale: attempt ${i} of ${attempts}` });
      try {
        const r = await this.run(task, opts);
        results.push({ attempt: i, summary: r.summary, stopReason: r.stopReason, steps: r.steps, check: r.check ?? null, changes: r.changes ?? [] });
        if (r.check?.verdict === 'pass') break;
      } catch (e) {
        results.push({ attempt: i, error: e.message });
      }
    }
    const rank = (v) => (v === 'pass' ? 2 : v === 'none' ? 1 : 0);
    const best = results.reduce((a, b) => (rank(a?.check?.verdict) >= rank(b?.check?.verdict) ? a : b), results[0]);
    return { attempts: results.length, results, best };
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

  /** Cross-session memory facts (read-only copy). */
  crossSessionMemory() { return [...this.#crossSessionMemory]; }
  /** Forget all cross-session facts for this project. */
  clearCrossSessionMemory() { this.#crossSessionMemory = []; clearMemory(this.root); }

  /** Drop everything pending without writing. */
  discard() {
    const n = this.overlay.size;
    this.overlay.clear();
    this.events.emit('discarded', { files: n });
    return n;
  }

  cancel() {
    // A run parked on a gate must not stay parked: abort first so the run's own
    // signal reads 'cancelled', then release the plan gate (resolved as a
    // decline) and deny every permission question still open, so the run leaves
    // the gate instead of waiting forever behind a window that may have reloaded
    // and lost the modal.
    // `running` says whether there was anything to stop: the window shows the
    // difference between "stopped" and "there was no run here".
    const running = this.running;
    this.abort.abort();
    this.answerPlan(false);
    this.permissions.cancelPending();
    this.events.emit('cancelled', { running });
  }

  pendingChanges() {
    return this.overlay.changes().map(({ file, added, removed, deleted, isNew }) => ({ file, added, removed, deleted, isNew }));
  }

  /** What the run is still waiting on the human for — used by a window that
   *  just reloaded to put the modal back on screen. */
  pendingAsks() {
    return {
      permissions: this.permissions.pendingList(),
      plan: this.#planResolve !== null,
    };
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
      // The helper reads through the parent's staged tree (Overlay.base): the
      // work in progress is its starting point, so its edit builds on what the
      // parent staged instead of re-deriving it from disk. Its own edits stay
      // in `child.map` — the copy-back below merges them.
      const child = new Overlay(this.root, { base: this.overlay });
      // What the parent looked like when this helper started. The copy-back
      // uses it to tell this helper's own edits apart from a version staged
      // while it was running — by the parent itself or by a sibling helper.
      const before = new Map(this.overlay.map);
      const childSession = this.store.create({ root: this.root, model: this.bridge.model, title: `${role ? `${role}: ` : 'helper: '}${task.slice(0, 60)}` });
      // The parent's path rules travel with the helper. They are statements
      // about the project (`.env*  deny`), not about which run is editing, so
      // a rule-free engine here would make every one of them a lie the moment
      // the model handed the work to a helper.
      // The event bus travels too: a helper that fetches a URL or attaches a
      // file asks a question, and a question with nobody to answer it is a
      // refusal — the parent's window is where that question belongs.
      const childPermissions = new PermissionEngine({ mode: 'yolo', allowRun: canRun, rules: this.permissions.rules, events: this.events });
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
            signal: this.abort.signal,
          }),
          overlay: child,
          session: childSession,
          permissions: childPermissions,
          events: this.events,
          conversation: helperConversation,
          conversationTemporary: helperConversation ? true : null,
          // A helper is a bounded subtask: its cap is 8, and a capped parent
          // can only lower it — an uncapped parent does not uncap a helper.
          options: { ...this.options, maxSteps: this.options.maxSteps > 0 ? Math.min(this.options.maxSteps, 8) : 8, subagent: false, allowRun: canRun, signal: this.abort.signal },
          first: true,
        });
      } catch (err) {
        result = { summary: `helper failed: ${err.message}` };
      }

      const prepared = [];
      const skipped = [];
      for (const [abs, value] of child.map) {
        const rel = path.relative(this.root, abs).split(path.sep).join('/');
        // Last-write-wins is how a sibling's finished work disappears without
        // a trace: when the parent staged something here after this helper
        // started, the helper's version does not overwrite it — it is named
        // in the reply instead, so it can be redone or merged deliberately.
        const stagedSinceStart = this.overlay.map.has(abs)
          ? this.overlay.map.get(abs) !== before.get(abs)
          : before.has(abs);
        if (stagedSinceStart && this.overlay.map.get(abs) !== value) {
          skipped.push(rel);
          continue;
        }
        this.overlay.map.set(abs, value);
        prepared.push(rel);
      }
      if (prepared.length) {
        this.events.emit('diff_update', { changes: this.pendingChanges() });
        this.session?.append('note', { text: `helper prepared edits pending approval: ${prepared.join(', ')}` });
      }
      if (skipped.length) {
        this.session?.append('note', { text: `a newer version was already staged, so the helper's edits were not applied: ${skipped.join(', ')}` });
      }
      this.events.emit('helper_end', { task, role: role || null, summary: result.summary ?? '', prepared, skipped });

      const lines = [result.summary ?? 'The helper finished without a summary.'];
      if (prepared.length) lines.push(`Files prepared and waiting for approval: ${prepared.join(', ')}`);
      if (skipped.length) lines.push(`Not applied — a newer version of these files was already staged by the parent run or a parallel helper, so this helper's edits were left alone: ${skipped.join(', ')}. Read them back if they still need changing.`);
      return lines.join('\n\n');
    };
  }

  /**
   * The checker (docs/SPEC_CHECKER.md): one read-only child run over the staged
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

      // (declared check) A run can name the one command that decides
      // correctness — `verifyCommand`, so two runs' verdicts are comparable by
      // construction — and a project can name it in the first non-comment line
      // of `.aipass/check.txt`. The option wins; the file is read from DISK,
      // not the overlay, so a value staged in this run cannot bend the command
      // that judges it. Absent both, the checker infers the project's checks
      // the way it always has.
      let declared = null;
      let declaredSource = null;
      const configured = String(this.options.verifyCommand ?? '').trim();
      if (configured) {
        declared = configured.split('\n')[0].trim().slice(0, 300);
        declaredSource = 'run';
      } else {
        try {
          const declaredFile = path.join(this.root, '.aipass', 'check.txt');
          if (fs.existsSync(declaredFile)) {
            const line = fs.readFileSync(declaredFile, 'utf8').split('\n')
              .map((l) => l.trim()).find((l) => l && !l.startsWith('#'));
            if (line) { declared = line.slice(0, 300); declaredSource = 'project'; }
          }
        } catch { declared = null; declaredSource = null; }
      }
      // The parent's path rules travel, as they do to a helper. The engine is
      // permissive because the readOnly tools are the real gate: the checker
      // cannot write even where a rule would have allowed it. The event bus
      // travels too — the checker fetches the project's own sources, and a
      // question with nobody to answer it is a refusal.
      const childPermissions = new PermissionEngine({ mode: 'yolo', allowRun: true, rules: this.permissions.rules, events: this.events });
      const prompt = [
        `You are the checker: a read-only pass over work that is already staged for this project.`,
        taskText ? `The run was working on: ${String(taskText).slice(0, 500)}` : '',
        `These pending edits are already applied in the tree you are looking at: ${label}.`,
        touchedTests.length
          ? `Note: this pending set includes test files: ${touchedTests.slice(0, 8).join(', ')}. Treat test edits as part of the change under review, and say plainly what you ran.`
          : '',
        declared
          ? `${declaredSource === 'run' ? 'This run declares its own check command' : 'The project declares its own check command'}. Run exactly this, as one command, and let its output decide:\n${declared}`
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
            signal: this.abort.signal,
          }),
          overlay: new Overlay(this.root),
          session: childSession,
          permissions: childPermissions,
          events: childEvents,
          conversation: checkerConversation,
          conversationTemporary: true,
          options: {
            ...this.options,
            // The checker is run-and-report, bounded at 6: an uncapped parent
            // does not uncap it, a capped one can only lower it.
            maxSteps: this.options.maxSteps > 0 ? Math.min(this.options.maxSteps, 6) : 6,
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
      // A run the chain guard skipped never executed — the entry only exists
      // to say why — so it is evidence of nothing, least of all a failure.
      // Counting it turned a refused edit in the checker's own reply into a
      // reported fail the parent had to answer.
      const runs = (childSession?.entries ?? []).filter((e) => (
        e.type === 'tool' && e.kind === 'run' && !/^skipped\b/.test(String(e.out ?? ''))
      ));
      const failed = runs.filter((e) => !e.ok);
      const verdict = failed.length ? 'fail' : runs.length ? 'pass' : 'none';
      const evidence = failed.slice(0, 3).map((e) => String(e.out ?? '').trim()).filter(Boolean).join('\n\n');
      const text = [result.summary, evidence].filter(Boolean).join('\n\n').slice(0, 4000) || 'the check produced no output';
      const noteAbout = touchedTests.length
        ? `\n\nnote: this run modified test files: ${touchedTests.slice(0, 8).join(', ')} — the check above ran against the staged copies.`
        : '';
      return {
        verdict,
        text: (text + noteAbout).slice(0, 4400),
        ran: runs.length,
        testsTouched: touchedTests.length,
        declared,
        declaredSource,
      };
    };
  }
}
