// The session domain: the conversations, the runs and the staged changes.
//
// A session is the local record of a conversation; a run is the work inside
// one. Both are scoped to the project the window is on, so two windows open
// on two projects cannot read each other's sessions — and one window's Apply
// button cannot write the other window's staged edits.
import path from 'node:path';

/**
 * The session methods of the backend.
 *
 * @param {import('./context.mjs').RpcContext} ctx the shared backend state
 */
export function createSessionMethods(ctx) {
  const {
    plugins,
    harnesses,
    runSessions,
    staged,
    targetFor,
    applySettingsTo,
    partsFor,
    dropIndex,
    emit,
    root,
    model,
  } = ctx;

  /**
   * A session of another project is refused here, and the refusal names the
   * project it belongs to.
   *
   * The store does not resolve such an id — a session is opened, renamed and
   * deleted in the project the window is on — but "nothing happened" is an
   * answer nobody can act on, and the id is usually in front of the person
   * who asked. The path says whose it is.
   */
  const refuseForeign = (h, id) => {
    if (!id || !h?.store) return;
    const foreign = h.store.foreignFor(id, { root: h.root });
    if (!foreign) return;
    throw new Error(`that session belongs to another project (${foreign.root})`);
  };

  return {

    /* ------------------------------------------------------------ sessions */

    // Scoped to the project the window is on: the store keeps one directory
    // per root, and an unscoped list mixes in every other project — on this
    // machine that was thousands of test leftovers, not conversations.
    async 'session.list'(params = {}) { const h = targetFor(params); return h.store.list(h.root); },
    async 'session.new'(params = {}) {
      const h = targetFor(params);
      const s = await h.startSession({ title: params.title ?? null });
      return s ? s.meta() : null;
    },
    async 'session.open'(params = {}) {
      const h = targetFor(params);
      refuseForeign(h, params.id);
      const s = await h.startSession({ sessionId: params.id });
      if (!s) throw new Error('session not found');
      emit('session_opened', s.meta());
      return s.entries;
    },
    async 'session.entries'(params = {}) { const h = targetFor(params); return h.session?.entries ?? []; },
    async 'session.rename'(params = {}) {
      const h = targetFor(params);
      refuseForeign(h, params.id);
      h.store.rename(params.id, params.title, { root: h.root });
      return { ok: true };
    },
    async 'session.delete'(params = {}) {
      const h = targetFor(params);
      refuseForeign(h, params.id);
      h.store.remove(params.id, { root: h.root });
      return { ok: true };
    },
    /**
     * Move idle sessions out of the picker's way. Nothing is deleted — files
     * move to `<project>/archive/` — and the live session is always kept even
     * when idle. `olderThanDays` 30 by default; `limit` caps the move count.
     */
    async 'session.archive'(params = {}) {
      const h = targetFor(params);
      const days = Number(params.olderThanDays ?? 30);
      const out = h.store.archiveIdle(h.root, {
        olderThanMs: Number.isFinite(days) && days >= 0 ? days * 24 * 3600 * 1000 : 30 * 24 * 3600 * 1000,
        limit: Math.min(200, Math.max(1, Math.floor(Number(params.limit ?? 50)) || 50)),
        keepId: h.session?.id ?? null,
      });
      return { archived: out.archived, count: out.archived.length };
    },
    async 'session.fork'(params = {}) {
      const h = targetFor(params);
      if (!h.session) throw new Error('no session to fork');
      const forked = h.session.fork(h.store, { fromEntryId: params.from ?? null });
      emit('session_forked', forked.meta());
      return forked.meta();
    },
    async conversations(params = {}) { return targetFor(params).bridge.conversations(); },

    /* ------------------------------------------------------- conversations */

    // The upstream holds one conversation per browser tab and cannot be trimmed,
    // so switching conversations is the only way to start clean without losing
    // the local session history. The CLI has had it all along; the window had
    // no way in, which is why a "new session" kept answering from yesterday.
    async 'conversations.list'() { return ctx.current.bridge.conversations(); },
    async 'conversation.new'(params = {}) {
      // No tab reachable answers {id: null} like it always did — the window
      // offers to open one instead of reading a stack trace. The create retry
      // inside BridgeClient has already waited out a reconnect gap; anything
      // else (the bridge being down) throws for the window to show.
      const made = await ctx.current.bridge.createConversation({
        model: params.model ?? ctx.current.bridge.model ?? undefined,
        temporary: true,
        message: params.message ?? 'Starting a new working session.',
      }).catch((err) => {
        if (/no extension connected/i.test(err.message)) return null;
        throw err;
      });
      await ctx.current.bridge.config({ conversation: made?.id ?? null });
      ctx.current.conversation = made?.id ?? null;
      emit('conversation', { id: ctx.current.conversation, temporary: true });
      return made ?? { id: null };
    },
    async 'conversation.pin'(params = {}) {
      await ctx.current.bridge.config({ conversation: params.id ?? null });
      ctx.current.conversation = params.id ?? null;
      emit('conversation', { id: ctx.current.conversation });
      return { ok: true, id: params.id ?? null };
    },

    /* ----------------------------------------------------------------- run */

    async run(params = {}) {
      if (!params.task?.trim()) throw new Error('no task given');
      // The window names the project it is looking at. Another window may have
      // moved the backend since — running where `current` happens to point
      // would put the task in the wrong project and stream it to a window that
      // is not showing that project. The project is looked up, not switched
      // to: a run is a target, not a move of the machine's current project.
      const h = targetFor(params);
      // The file is the truth for the harness this run lands on, even one this
      // backend built long before the last save: without this, a project
      // visited in the morning ran on the morning's temperature, budgets and
      // rules while the sheet (and every window) said the new ones were in
      // force. The run's own mode and allow-run are applied on top of it.
      applySettingsTo(h);
      h.setPolicy({ mode: params.mode ?? null, allowRun: params.allowRun ?? null });
      Object.assign(h.options, {
        plan: params.plan ?? h.options.plan,
        subagent: params.subagent ?? h.options.subagent,
        // Unlike maxSteps and friends this one is only ever a saved setting:
        // the window flips plan mode through settings.set and never through
        // the run call, so the live value is the default — an explicit run
        // param still wins.
        requirePlanApproval: Boolean(params.requirePlanApproval ?? h.options.requirePlanApproval),
        maxSteps: params.maxSteps ?? h.options.maxSteps,
        maxToolCalls: params.maxToolCalls ?? h.options.maxToolCalls,
        maxWallClockMs: params.maxWallClockMs ?? h.options.maxWallClockMs,
        maxCredits: params.maxCredits ?? h.options.maxCredits,
        searchI: params.searchI ?? h.options.searchI,
        attach: params.attach ?? h.options.attach,
        webScratch: params.webScratch ?? h.options.webScratch,
        parallelHelpers: params.parallelHelpers ?? h.options.parallelHelpers,
        attempts: params.attempts ?? h.options.attempts,
        verifyCommand: params.verifyCommand !== undefined ? params.verifyCommand : h.options.verifyCommand,
        requireCheck: Boolean(params.requireCheck ?? h.options.requireCheck),
        parts: await partsFor(params.attachments ?? []),
        pluginTools: plugins.toolTable(),
      });
      if (params.model) h.bridge.model = params.model;
      if (!h.session) await h.startSession({ title: params.title ?? null });
      // (Thai pack) Attempts: when the checker reports the staged tree still
      // fails, the window may re-run the task instead of handing a known-bad
      // tree back. Every attempt starts from a cleared overlay (the loop
      // clears it on entry) in the same conversation, so the model sees its
      // own failure and tries a different route; the first attempt whose
      // check passes is the one kept. Each attempt costs a full run.
      const attempts = Math.min(5, Math.max(1, Math.floor(Number(h.options.attempts ?? 1))));
      // The session this run writes to, read once at the boundary: the human
      // may open another session while it streams — `h.session` moves, the
      // run's entries do not. Frames carry this id (see harnessFor's tag), so
      // a window showing another session can tell whose stream this is and
      // leaves it alone.
      const runSessionId = h.session?.id ?? null;
      runSessions.set(h.root, runSessionId);
      let result = null;
      let used = 0;
      try {
        for (let i = 1; i <= attempts; i++) {
          used = i;
          result = await h.run(params.task, { runPluginTool: (marker, args) => plugins.runTool(marker, args) });
          const verdict = result.check?.verdict ?? null;
          if (used === attempts || verdict !== 'fail') break;
          emit('note', { text: `check failed after attempt ${used} of ${attempts} — running the task again`, project: h.root, session: runSessionId });
        }
      } finally {
        runSessions.delete(h.root);
      }
      return {
        summary: result.summary,
        stopReason: result.stopReason,
        steps: result.steps,
        spent: result.spent,
        attempts: used,
        check: result.check?.verdict ?? null,
        pending: h.pendingChanges(),
      };
    },

    cancel(params = {}) {
      // A window cancels what it is looking at: when it names a project, the
      // cancel goes to that project's harness — another window may have made
      // a different project current since this window's run started. A root
      // with no harness (nothing ever ran there) has nothing to cancel.
      const wanted = params.project ?? params.root;
      const h = wanted ? harnesses.get(path.resolve(wanted)) : ctx.current;
      if (!h) return { ok: false, running: false, reason: `no run in ${wanted ?? 'this project'}` };
      // What the harness says about the run it stopped: `running` was false
      // when the stop arrived, so there was nothing to stop and the window
      // says so instead of pretending the work ended.
      const running = h.running;
      h.cancel();
      return { ok: true, running };
    },

    /* -------------------------------------------------------- permissions */

    async 'permission.answer'(params = {}) {
      // The question names its project: a window may be answering a request
      // that belongs to a run the backend has since switched away from.
      const h = params.project ? harnesses.get(path.resolve(params.project)) : ctx.current;
      return { ok: h ? h.answer(params.id, params.decision) : false };
    },
    async 'plan.answer'(params = {}) {
      const h = params.project ? harnesses.get(path.resolve(params.project)) : ctx.current;
      h?.answerPlan(Boolean(params.ok));
      return { ok: true };
    },

    /* -------------------------------------------------------------- diffs */

    async pending(params = {}) { return targetFor(params).pendingChanges(); },
    async compact(params = {}) {
      const h = targetFor(params);
      if (!h.session) throw new Error('no session yet — send something first');
      // A rotation replaces the conversation a running loop is sending into —
      // its next message would land in a context that never carried the run.
      if (h.running) throw new Error('a run is in flight — compact when it ends');
      const done = await h.compactNow();
      // The summary has no run of its own yet: the next run builds its seed
      // against that run's task and carries it — facts included, or a long
      // session's spine is cut at the rotation.
      h.rememberSummary(done.summary, done.memory);
      return { summary: done.summary, context: h.contextUsage() };
    },
    async diff(params = {}) {
      const h = targetFor(params);
      const abs = h.overlay.safe(params.file);
      if (!h.overlay.has(abs)) throw new Error('no pending change for that file');
      // One file's diff, not every staged file's diff searched for one: a
      // diff is the expensive part and the panel asks a file at a time.
      return h.overlay.changeFor(abs);
    },
    async apply(params = {}) {
      const h = targetFor(params);
      // The tree just changed: the index of it is a picture of the past.
      dropIndex(h.overlay.trySafe('.'));
      return h.apply(params.files ?? null);
    },
    async discard(params = {}) { return { dropped: targetFor(params).discard() }; },
  };
}

export default createSessionMethods;
