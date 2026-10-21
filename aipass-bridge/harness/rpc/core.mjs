// The core of the backend: what the window asks before it asks anything else.
//
// `status` is the whole state of one project in one answer — the bridge, the
// extension, the model, the mode, the staged changes, the context meter — and
// `snapshot` is that answer plus everything a reloaded window needs to look
// like the run it left.
//
// The two live together because `snapshot` reads `status`: a window that
// reloaded mid-run asks for one thing and gets one truth, not two answers
// that can disagree.
import path from 'node:path';
import { APP_VERSION } from '../session.mjs';
import { AIPASS_PROVIDER } from '../providers.mjs';

/**
 * The core methods of the backend.
 *
 * @param {import('./context.mjs').RpcContext} ctx the shared backend state
 */
export function createCoreMethods(ctx) {
  const {
    appSettings,
    plugins,
    harnesses,
    staged,
    targetFor,
    decoratedPlugins,
    root,
    model,
  } = ctx;

  return {
    /* ------------------------------------------------------------ reading */

    async status(params = {}) {
      // The project the caller is looking at, not the one the backend happens
      // to be on: two windows can be open on two projects, and each of them
      // must see its own sessions, files and pending changes.
      const h = targetFor(params);
      const st = await h.bridge.status().catch(() => null);
      return {
        root: h.root,
        // Every project's running flag, not just the current one's: a window
        // on project A must be able to see that B still has a run going, so a
        // switch is an informed move instead of a surprise.
        projects: appSettings.projectList().map((p) => ({
          ...p,
          current: p.path === h.root,
          running: harnesses.get(path.resolve(p.path))?.running === true,
        })),
        bridge: Boolean(st?.ok),
        extensions: st?.extensions ?? 0,
        // Why the extension is not attached: 'missing' means the bridge
        // refused it for want of the loopback token, 'ok' means it never
        // tried. The window shows the difference — "load the extension" and
        // "paste the token" are different jobs, and only one of them is
        // what the reader has to do.
        extensionToken: st?.extensionToken ?? 'ok',
        // Bridge-side cache counters (models/quota/conversation): what rode a
        // cache instead of the tab. Null from a bridge too old to count them —
        // the window's /status omits the line then.
        cache: st?.cache ?? null,
        // What the model list IS: 'live' for the real catalog, 'fallback' for
        // the two-id stub a bridge serves when no tab can be reached, plus the
        // stamp of the last change and the last failure. The window reads it
        // on the status call it already makes every ten seconds, so it learns
        // that the catalog went live without asking for it.
        catalog: st?.catalog ?? null,
        // The build behind this backend: the window shows it (and warns when
        // the packaged shell is older than the repo it was built from), so a
        // stale install reads as a version instead of a mystery.
        app: APP_VERSION ?? null,
        // The two halves of a build, both named, so "which build is this?"
        // always has an answer: the binary's version and the content's.
        shell: process.env.AIPASS_SHELL_VERSION ?? null,
        source: process.env.AIPASS_CONTENT_SOURCE ?? 'bundle',
        // The harness's model first: it is the one a run sends. The bridge's
        // own default is only a fallback, because the bridge remembers whatever
        // the browser tab last used — showing that instead would put a retired
        // model in the header while a different one answers.
        model: h.bridge.model ?? st?.defaultModel ?? null,
        // Which provider the run talks to. The window shows it, so a run that
        // suddenly costs real money instead of credits says why.
        provider: h.providerId ?? AIPASS_PROVIDER,
        conversation: st?.conversation ?? null,
        session: h.session ? h.session.meta() : null,
        running: h.running,
        mode: h.options.mode,
        allowRun: h.options.allowRun,
        maxSteps: h.options.maxSteps,
        plan: h.options.plan,
        subagent: h.options.subagent,
        pending: h.pendingChanges(),
        // Context is invisible until it is not: this meter is the difference
        // between "it is handling that" and "why did it forget what I said".
        context: h.contextUsage(),
        plugins: decoratedPlugins(),
        settings: appSettings.values,
      };
    },

    /**
     * One call that puts a window back where it was: what status knows, the
     * open session and its recorded entries, what is waiting for approval,
     * the context meter, and the library. A window reloaded mid-run has an
     * empty DOM; making it re-derive this from four calls is how it ends up
     * showing half a truth while the run it abandoned is still going.
     */
    async snapshot(params = {}) {
      const h = targetFor(params);
      const status = await ctx.methods.status(params);
      return {
        status,
        session: h.session ? h.session.meta() : null,
        entries: h.session?.entries ?? [],
        // status answered both of these already; asking again was a second
        // diff of every staged file for a single reply.
        pending: status.pending,
        asks: h.pendingAsks(),
        context: status.context,
        skills: h.skills.list(),
      };
    },

    // `force` is the caller's business: the window's refresh button wants a
    // real fetch, its poll wants the cache. Forcing by default made every
    // read of the list poke the site's tab — the same reason `credits` takes
    // a flag.
    async models(params = {}) { return targetFor(params).bridge.models(params.force === true); },
    // Forced by default — a caller that asks for credits wants a number, not
    // a cache — but the window passes force:false while idle so the
    // extension's tab is not poked upstream every 10 seconds forever.
    async credits(params = {}) { return targetFor(params).bridge.quota(params.force !== false); },
  };
}

export default createCoreMethods;
