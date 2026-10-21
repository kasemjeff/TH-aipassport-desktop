// The settings domain: the file every surface shares.
//
// What lives here is the machine's own configuration — the mode, the budgets,
// the providers, the projects and the path rules — and the promise that a save
// in the window lands on every harness the backend holds, not only the current
// one. A project visited later in the day must not keep the values of the
// moment it was first opened.
//
// The providers are here too: they are one file beside the settings (not in
// it), and the sheet's provider field and its "use this one" button are the
// same decision — so both are written from one place.
import fs from 'node:fs';
import path from 'node:path';
import { formatLogLine } from '../log-line.mjs';
import { publicSpec, AIPASS_PROVIDER } from '../providers.mjs';
import { clientFor } from '../provider-client.mjs';

/**
 * The settings methods of the backend.
 *
 * @param {import('./context.mjs').RpcContext} ctx the shared backend state
 */
export function createSettingsMethods(ctx) {
  const {
    appSettings,
    providers,
    plugins,
    harnesses,
    targetFor,
    switchProject,
    applySettingsTo,
    applyProviderTo,
    activeProviderId,
    skillLibraryFor,
    emit,
    root,
    model,
  } = ctx;

  return {

    async 'config.set'(params = {}) {
      if (params.model != null) {
        // The same setting `settings.set({defaultModel})` writes, so it lands
        // wherever that lands: a model chosen in the open window is the
        // machine's default — "the choice survives a restart and the backend
        // runs with it, not just this window" — not this project's private
        // preference. A harness left holding the old model used to greet the
        // next run in its project with it, while the sheet said otherwise.
        //
        // A provider other than AiPASS keeps its own model: the id means
        // nothing across providers, so it is filed with the provider that
        // answers to it and the machine-wide default stays the AiPASS one.
        const active = providers.get(activeProviderId());
        if (!active || active.kind === 'aipass') {
          appSettings.set({ defaultModel: params.model });
        } else {
          providers.save({ ...active, defaultModel: params.model });
        }
        for (const h of harnesses.values()) h.bridge.model = params.model;
      }
      await ctx.current.bridge.config(Object.fromEntries(Object.entries(params).filter(([k]) => ['model', 'assistant', 'aspectRatio', 'conversation'].includes(k))));
      return { ok: true };
    },

    /* ----------------------------------------------------------- providers */

    /**
     * The providers this install knows: the built-in AiPASS one and every
     * added one.
     *
     * The keys are never in this answer — only whether there is one — so the
     * window can show a green dot without a secret leaving the backend.
     */
    async 'providers.list'() {
      return {
        providers: providers.all().map((p) => ({
          ...publicSpec(p),
          hasKey: p.kind === 'aipass' ? true : providers.hasKey(p.id),
        })),
        active: activeProviderId(),
      };
    },

    /**
     * Switch the provider every harness runs on.
     *
     * The switch is machine-wide, like every other setting: the window, the
     * CLI and the backend read the same file, so a choice made here is the
     * choice the next run makes.
     */
    async 'provider.set'(params = {}) {
      const id = String(params.id ?? '').trim().toLowerCase();
      const spec = providers.get(id);
      if (!spec) throw new Error(`no provider "${id}"`);
      appSettings.set({ defaultProvider: spec.id });
      for (const h of harnesses.values()) applyProviderTo(h, spec.id);
      const list = await ctx.methods['providers.list']();
      return { ok: true, active: spec.id, providers: list.providers };
    },

    /**
     * Add a provider, or change one that is already there.
     *
     * The spec and the key travel together because they are one thing to
     * configure: a provider without a key cannot answer, and a key without a
     * spec has nowhere to go.
     */
    async 'provider.save'(params = {}) {
      const spec = providers.save(params);
      if (params.key) providers.setKey(spec.id, params.key);
      // A provider whose spec just changed is rebuilt on every harness that
      // runs on it, so the change is live and not only on the next start.
      for (const h of harnesses.values()) {
        if (h.providerId === spec.id) applyProviderTo(h, spec.id);
      }
      return { ok: true, provider: publicSpec(spec), hasKey: providers.hasKey(spec.id) };
    },

    async 'provider.remove'(params = {}) {
      const id = String(params.id ?? '').trim().toLowerCase();
      if (id === AIPASS_PROVIDER) throw new Error('the aipass provider cannot be removed');
      providers.remove(id);
      if (activeProviderId() === id) {
        appSettings.set({ defaultProvider: AIPASS_PROVIDER });
        for (const h of harnesses.values()) applyProviderTo(h, AIPASS_PROVIDER);
      }
      return { ok: true, active: activeProviderId() };
    },

    /**
     * Ask a provider whether it answers — the one-click check in the sheet.
     *
     * The check is a request the provider recognises, not a guess: its own
     * model list, which is the cheapest thing it can be asked for.
     */
    async 'provider.test'(params = {}) {
      const id = String(params.id ?? '').trim().toLowerCase();
      const spec = providers.get(id);
      if (!spec) throw new Error(`no provider "${id}"`);
      if (spec.kind === 'aipass') {
        const st = await ctx.current.bridge.status().catch(() => null);
        return {
          ok: Boolean(st?.ok),
          detail: st?.ok ? 'the bridge is answering' : 'the bridge is not answering',
        };
      }
      const key = providers.keyFor(id);
      if (!key) {
        return { ok: false, detail: `no API key — set ${spec.apiKeyEnv ? `$${spec.apiKeyEnv}` : 'one here'}` };
      }
      const client = clientFor(spec, { key, model: spec.defaultModel ?? null });
      const models = await client.models();
      return {
        ok: models.source === 'live',
        detail: models.source === 'live'
          ? `${models.data.length} model(s)`
          : (models.error ?? 'the provider did not answer with a model list'),
      };
    },

    /* ------------------------------------------------------------ settings */

    async 'settings.get'() { return appSettings.values; },
    async 'settings.set'(params = {}) {
      // The scope key names the project the call is about; it is not a
      // setting, and the settings file is not where that lives.
      const patch = { ...params };
      delete patch.project;
      const next = appSettings.set(patch);
      // A change of root moves the live run onto another project first: every
      // policy below it belongs to the harness that keeps running.
      if (params.root != null) switchProject(params.root);
      // A change of mode or root is not a note in a file: it moves every live
      // run. Settings are one file for the whole machine, so the save lands on
      // every harness the backend holds, not only the current one — a project
      // visited later in the day must not keep the values of the moment it was
      // first opened. The guards stay per-parameter: a save that does not name
      // the mode must not stomp a mode a run set for itself.
      for (const h of harnesses.values()) {
        if (params.mode || params.allowRun != null) h.setPolicy({ mode: params.mode ?? null, allowRun: params.allowRun ?? null });
        // The settings sheet claims a value is live the moment Save is pressed,
        // so every setting that reaches a module of its own is re-applied here
        // rather than at the next start. A half-applied form is worse than no
        // form: it writes one truth and keeps the process running another.
        if (params.maxSteps != null) h.options.maxSteps = appSettings.get('maxSteps');
        // The budgets are read once per run from the harness options; without
        // this a budget change was a note for the next backend start while the
        // sheet said it was live.
        if (params.maxToolCalls != null) h.options.maxToolCalls = appSettings.get('maxToolCalls');
        if (params.maxWallClockMs != null) h.options.maxWallClockMs = appSettings.get('maxWallClockMs');
        if (params.maxCredits != null) h.options.maxCredits = appSettings.get('maxCredits');
        if (params.plan != null) h.options.plan = appSettings.get('plan');
        if (params.requirePlanApproval != null) h.options.requirePlanApproval = appSettings.get('requirePlanApproval');
        if (params.subagent != null) h.options.subagent = appSettings.get('subagent');
        if (params.thinking != null) h.options.thinking = appSettings.get('thinking');
        if (params.temperature !== undefined) h.options.temperature = appSettings.get('temperature');
        if (params.defaultModel != null) h.bridge.model = params.defaultModel;
        // A provider named in the same save is applied here, not only by the
        // dedicated switch: the sheet's provider field and its "use this one"
        // button are the same decision, and a save that wrote one and not the
        // other would leave the run on the old provider.
        if (params.defaultProvider != null) {
          const want = String(params.defaultProvider).trim().toLowerCase();
          if (providers.get(want)) applyProviderTo(h, want);
        }
        if (params.compaction) h.compactor = Object.assign(h.compactor, params.compaction);
        // The rotation share is its own setting, not part of the budget object:
        // it is the knob a person turns, the budget is the ceiling.
        if (params.compactAtPercent != null) h.compactor.compactAtPercent = params.compactAtPercent;
        // (Thai pack) The language keys and the loop guards read their options
        // per run, so the sheet's save has to move the live copies too.
        for (const key of ['replyLanguage', 'langCheck', 'minThaiRatio', 'repeatGuard', 'repeatGuardMax', 'attempts', 'verifyCommand', 'requireCheck']) {
          if (params[key] != null) h.options[key] = appSettings.get(key);
        }
        // The playbook folders are per project, so each harness rebuilds its
        // own list. The plugin list is one module for the whole backend and is
        // reloaded once below.
        if (params.skillsDirs != null) h.skills = skillLibraryFor(h.root);
        // Path rules are read on every evaluate(), so they are the cheapest kind
        // of live: the engine swaps the array and the next marker sees them.
        if (params.rules != null) h.setRules(appSettings.get('rules') ?? []);
      }
      // The plugin list is the other setting a module of its own owns; it is
      // rebuilt by name here so the sheet has one contract instead of a
      // footnote saying "restart for this one".
      // `void` DETACHES the promise: a rejection would become an unhandled
      // rejection, and the process-level handler exits the backend. The RPC
      // has already answered `{ok:true}` by then, so the window would show a
      // saved setting over a dead backend.
      if (params.plugins != null) {
        plugins.load().catch((err) => console.error(formatLogLine({ level: 'error', msg: `plugin load failed: ${err?.message ?? err}` })));
      }
      emit('settings', next);
      return next;
    },

    /**
     * The path rules as the running engine sees them — the ones actually in
     * force, not a second copy the window keeps. Reading them back is how the
     * sheet proves a save landed.
     */
    async 'rules.get'(params = {}) {
      return { rules: targetFor(params).permissions.rules ?? [] };
    },

    /**
     * Replace the path rules. Written through settings so the CLI and the
     * window share one file, and applied to the live engine in the same
     * breath: a rule that only exists on disk changes nothing until restart,
     * which is exactly the lie this method exists to not tell.
     */
    async 'rules.set'(params = {}) {
      const next = appSettings.set({ rules: params.rules ?? [] });
      // Every live harness, not just the current one: a path rule is a
      // boundary, and an engine in another project must not keep running
      // without hearing about it.
      for (const h of harnesses.values()) h.setRules(next.rules ?? []);
      return { rules: next.rules ?? [] };
    },

    /** Back to the defaults, projects and all. The escape hatch from a form. */
    async 'settings.reset'() {
      const next = appSettings.reset();
      // A reset is a save of every default: it lands on every harness the
      // same way any other save does, or the form would be true on disk and
      // half-true in the process it just claimed to reset.
      for (const h of harnesses.values()) applySettingsTo(h);
      emit('settings', next);
      return next;
    },

    /* ------------------------------------------------------- cross-session memory */

    async 'memory.list'(params = {}) {
      return { facts: targetFor(params).crossSessionMemory() };
    },
    async 'memory.clear'(params = {}) {
      targetFor(params).clearCrossSessionMemory();
      return { ok: true };
    },

    /* ------------------------------------------------------------ projects */

    async 'projects.list'() { return appSettings.projectList(); },
    async 'projects.add'(params = {}) {
      const abs = path.resolve(params.path ?? '');
      if (!fs.existsSync(abs)) throw new Error(`no such folder: ${abs}`);
      appSettings.addProject(abs, params.name ?? null);
      return appSettings.projectList();
    },
    async 'projects.remove'(params = {}) {
      appSettings.removeProject(params.path);
      return appSettings.projectList();
    },
    async 'projects.switch'(params = {}) {
      const h = switchProject(params.path);
      return {
        root: h.root,
        sessions: h.store.list(h.root).slice(0, 50),
        settings: appSettings.values,
      };
    },
  };
}

export default createSettingsMethods;
