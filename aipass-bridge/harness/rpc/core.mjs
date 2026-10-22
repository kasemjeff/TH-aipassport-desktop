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
// The write side of git (harness/git.mjs). These four are the HUMAN's
// buttons: they act on the project's root and report what changed, and they
// do not consult the model's permission mode — a person clicking a button is
// the consent.
import { status as gitStatus, stage as gitStage, commit as gitCommit, branch as gitBranch } from '../git.mjs';
// The worktree surface: a second checkout of the person's repository, so a
// run can work in it without touching the files the person is editing. The
// worktree lives OUTSIDE the project (harness/worktree.mjs), and the run that
// uses it is a run whose root IS that folder.
import {
  create as createWorktree,
  list as listWorktrees,
  remove as removeWorktree,
  status as worktreeStatus,
  sweep as sweepWorktrees,
} from '../worktree.mjs';
import { list as scheduleList, add as scheduleAdd, remove as scheduleRemove, runDue as scheduleRunDue } from '../schedule.mjs';

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

    /* ----------------------------------------------------------- schedule */

    /**
     * The tasks this machine runs at a time of day.
     *
     * The schedule is the machine's, not a project's: the entries name the
     * project they work in themselves, so a task survives the window moving
     * to another folder.
     */
    async 'schedule.list'() {
      return { entries: await scheduleList() };
    },
    /**
     * Add a task.
     *
     * The project is the one the caller is on (the window names it on every
     * call), so the task lands in the folder the person is looking at.
     */
    async 'schedule.add'(params = {}) {
      const root = params.project ?? params.root ?? ctx.current?.root ?? ctx.root;
      return scheduleAdd({
        task: params.task,
        root,
        at: params.at,
        kind: params.kind ?? 'daily',
      });
    },
    async 'schedule.remove'(params = {}) {
      if (!params.id) throw new Error('no schedule entry given');
      const gone = await scheduleRemove(params.id);
      return { ok: gone, id: params.id };
    },
    /**
     * Run the tasks that are due, now.
     *
     * The work starts detached, so this call answers as soon as the jobs are
     * away: the desktop backend must never be held open by a scheduled run.
     */
    async 'schedule.runDue'(params = {}) {
      const now = params.now ? new Date(params.now) : new Date();
      const out = await scheduleRunDue({ now });
      return { ran: out.ran, count: out.count, at: out.at };
    },

    /* ------------------------------------------------------------------ git */

    /**
     * The repository's state, for the window's own buttons.
     *
     * These are the HUMAN's calls, not the model's: they act on the project's
     * root and answer with what changed. The model's own GIT marker is a
     * different road (the permission gate, and the `allowGitWrite` option),
     * and the two cannot be confused.
     */
    async 'git.status'(params = {}) {
      const h = targetFor(params);
      return gitStatus({ root: h.root });
    },
    async 'git.stage'(params = {}) {
      const h = targetFor(params);
      const paths = Array.isArray(params.paths) ? params.paths : (params.path ? [params.path] : []);
      return gitStage({ root: h.root, paths });
    },
    async 'git.commit'(params = {}) {
      const h = targetFor(params);
      return gitCommit({ root: h.root, message: params.message ?? '' });
    },
    async 'git.branch'(params = {}) {
      const h = targetFor(params);
      return gitBranch({ root: h.root, name: params.name ?? '' });
    },

    /* ------------------------------------------------------------- worktree */

    /**
     * The worktrees of this project.
     *
     * The same repository as the project, so the list is the same whether the
     * window is on the project or inside one of its worktrees — and the run
     * that lands in a worktree lands there because the CALL names that folder
     * as the project (rpc.mjs's targetFor), not because the backend moved.
     */
    async 'worktree.list'(params = {}) {
      const h = targetFor(params);
      return listWorktrees({ root: h.root });
    },
    /**
     * Make a worktree for this project.
     *
     * The person's call, like the git buttons above: a worktree is a checkout
     * on the person's disk, so the window asks before it makes one and names
     * the folder it made.
     */
    async 'worktree.create'(params = {}) {
      const h = targetFor(params);
      return createWorktree({ root: h.root, name: params.name ?? '', base: params.base ?? null });
    },
    /**
     * Take a worktree away.
     *
     * `force` is the person's answer to "are you sure?" — the window asks
     * before it sends it, because an uncommitted file inside a worktree
     * exists nowhere else.
     */
    async 'worktree.remove'(params = {}) {
      const h = targetFor(params);
      return removeWorktree({ root: h.root, path: params.path ?? '', force: params.force === true });
    },
    /** What changed inside a worktree: the files and how much of them. */
    async 'worktree.status'(params = {}) {
      const h = targetFor(params);
      return worktreeStatus({ root: h.root, path: params.path ?? '' });
    },
    /**
     * The janitor.
     *
     * A worktree is a whole checkout on the person's disk, so a forgotten one
     * is litter — and this is the house shape for that (harness/sandbox.mjs's
     * sweepSandboxes): only the ones this house made, only the ones with
     * nothing uncommitted in them, and only the ones that have sat there for
     * a while.
     */
    async 'worktree.sweep'(params = {}) {
      const h = targetFor(params);
      return sweepWorktrees({ root: h.root });
    },
  };
}

export default createCoreMethods;
