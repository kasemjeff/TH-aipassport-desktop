// The desktop's backend: HTTP + SSE in front of as many harnesses as there are
// projects.
//
// Why not just talk to the bridge directly: the desktop app needs the whole
// run (permissions, sessions, diffs, compaction) as one addressable thing, and
// it needs to be driven from a window that may be reloaded mid-run. So the
// harnesses live here, in a long-lived Node process, and the window subscribes.
//
//   POST /rpc      {"method":"run","params":{…}}   → {"ok":true,"result":…}
//   GET  /events   Server-Sent Events: every harness event, tagged `ev: <name>`
//
// Everything binds to 127.0.0.1 only — the bridge holds a logged-in browser
// session, so this port is as sensitive as the account is.
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Harness } from './harness.mjs';
import { SessionStore } from './session.mjs';
import { SkillLibrary } from './skills.mjs';
import { Settings, aipassHome } from './settings.mjs';
import { PluginManager } from './plugins.mjs';
import { Emitter } from './events.mjs';
// One resolver for "where the bridge is", shared with the harness's own client
// and with desktop/main.mjs's probe: an explicit bridgeURL wins, otherwise
// AIPASS_BRIDGE decides, otherwise the loopback default.
import { resolveBridgeURL } from './bridge.mjs';

// Re-exported for desktop/main.mjs, whose ensureBridge probe must resolve the
// bridge exactly the way the harness's own client does.
export { resolveBridgeURL };

/**
 * The file under `uiDir` a request path maps to, or null when it would leave
 * ui/. The containment check has to be path.relative, not a string prefix:
 * `target.startsWith(uiDir)` also matches a sibling directory whose name
 * merely begins with ui's — a `ui-x` beside `ui` survives it the moment a
 * request carries a `..` that survives URL normalisation. path.relative is
 * the real boundary, and on Windows it compares the prefix case-insensitively,
 * which is what that filesystem deserves.
 */
export function staticFileFor(uiDir, pathname) {
  const file = pathname === '/' ? 'index.html' : String(pathname).replace(/^\/+/, '');
  const target = path.join(uiDir, path.normalize(file));
  const rel = path.relative(uiDir, target);
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null;
  return target;
}

// The window's static files. In the repo they live in desktop/ui; the shipped
// layout puts ui/ beside aipass-bridge instead — first that exists wins.
const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const UI_DIRS = [path.join(APP_ROOT, 'desktop', 'ui'), path.join(APP_ROOT, 'ui')];
const UI_DIR = UI_DIRS.find((dir) => fs.existsSync(dir)) ?? UI_DIRS[0];

/** Attachment kinds the bridge can carry, with the part shape each needs. */
import { MAX_ATTACHMENT_BYTES, mimeOf } from '../bridge/attachment-types.mjs';

/**
 * Is this request from the machine's own UI, rather than from the open web?
 *
 * Everything this port does is bound to 127.0.0.1 because the bridge behind
 * it carries a logged-in browser session — this port is as sensitive as the
 * account is. But a browser will let *any* page `fetch('http://127.0.0.1:8790/rpc')`,
 * and the methods here drive an agent that writes files. So a request also
 * has to prove it is local:
 *
 *   - Host must be loopback. This is the check that stops DNS rebinding, where
 *     an attacker's domain is made to resolve to 127.0.0.1 so the browser's
 *     same-origin policy believes it is talking to the app. The Host header
 *     is the one thing a rebound page cannot fake.
 *   - Sec-Fetch-Site / Origin, when present, must say "same origin" (or
 *     "none", for address-bar style navigations). Browsers send them on every
 *     fetch; plain tools — curl, node scripts, the test suite — send neither
 *     and pass untouched.
 *
 * `AIPASS_ALLOW_REMOTE=1` opts out, for someone deliberately putting this
 * behind their own proxy.
 */
const loopbackHost = (host) => {
  const h = String(host ?? '').trim().toLowerCase();
  if (!h) return true; // HTTP/1.0-style tools; nothing a web page can rely on
  return /^127(\.\d{1,3}){3}(:\d+)?$/.test(h)   // 127.0.0.1:8790
    || /^\[::1\](:\d+)?$/.test(h)                // [::1]:8790
    || /^localhost(:\d+)?$/.test(h);             // localhost:8790
};

const isLocalRequest = (req) => {
  if (process.env.AIPASS_ALLOW_REMOTE === '1') return true;
  if (!loopbackHost(req.headers.host)) return false;
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return false;
  const origin = req.headers['origin'];
  if (origin) {
    try { return loopbackHost(new URL(origin).host); } catch { return false; }
  }
  return true;
};

export function createRpc({
  port = 8790,
  root = process.cwd(),
  // Read at the rpc/harness boundary: an explicit bridgeURL (tests, the
  // desktop) wins; otherwise AIPASS_BRIDGE decides, otherwise the loopback
  // default. One resolver, so the window's probe and the client the harness
  // chats with can never disagree.
  bridgeURL = resolveBridgeURL(),
  model = null,
  store = null,
  compaction = null,
  settings = null,
  pluginsDir = null,
  rulesFile = null,
  // The bridge is the browser half of the app. The window's shell is supposed to
  // start it, and the CLI's own entry point does; this is the backstop for a
  // surface that starts only the RPC server (which is what the packaged window
  // does), so a run never fails for want of a listener on 8787. Tests turn it
  // off — they run their own bridge on their own port.
  autostartBridge = true,
} = {}) {
  const listeners = new Set();
  // Every frame carries a monotonic `seq` and an SSE `id:` of the same value,
  // and the last REPLAY_LIMIT of them stay in a buffer. Two things need that:
  //   - a window that reloaded mid-run has an empty DOM and needs the recent
  //     tail of the conversation back before it can look like the run it left
  //   - an EventSource that drops and reconnects sends `Last-Event-ID`, so the
  //     backend replays exactly what that listener missed instead of losing
  //     the middle of a run or duplicating what it already rendered
  let seq = 0;
  const replay = [];
  const REPLAY_LIMIT = 500;
  const emit = (type, payload) => {
    const body = { seq: ++seq, ...(payload ?? {}) };
    replay.push({ event: type, seq: body.seq, body });
    if (replay.length > REPLAY_LIMIT) replay.shift();
    const frame = `event: ${type}\nid: ${seq}\ndata: ${JSON.stringify(body)}\n\n`;
    for (const res of listeners) res.write(frame);
  };

  const appSettings = settings ?? new Settings();
  // `store` is a directory (tests pass a temp one); a SessionStore instance is
  // accepted too, for callers that already made one.
  const storeDir = typeof store === 'string' ? store : (store?.dir ?? path.join(aipassHome(), 'sessions'));

  /**
   * Where this process's own files are: the install root in the packaged layout
   * (aipass-bridge/ beside the running script), the repo root when run from a
   * checkout. Both are real, and the bridge script has to be found in whichever
   * one is true rather than assumed.
   */
  const bridgeScript = () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    for (const dir of [path.resolve(here, '..', '..'), path.resolve(here, '..'), here]) {
      const candidate = path.join(dir, 'bridge', 'server.mjs');
      if (fs.existsSync(candidate)) return candidate;
    }
    return null;
  };

  /** Start the bridge if nothing is answering, and wait for it. */
  const ensureBridge = async () => {
    if (!autostartBridge) return;
    const up = () => fetch(bridgeURL, { signal: AbortSignal.timeout(1200) }).then((r) => r.ok).catch(() => false);
    if (await up()) return;
    const script = bridgeScript();
    if (!script) return;
    try {
      const logDir = path.join(aipassHome(), 'logs');
      fs.mkdirSync(logDir, { recursive: true });
      const log = fs.openSync(path.join(logDir, 'bridge.log'), 'a');
      const child = spawn(process.execPath, [script], { cwd: root, stdio: ['ignore', log, log], detached: true, env: process.env });
      child.unref();
      fs.closeSync(log);
      for (let i = 0; i < 60 && !(await up()); i++) await new Promise((r) => setTimeout(r, 250));
    } catch {
      // A bridge that will not start is reported on the first run, where the
      // error is visible, rather than crashing the backend that would explain it.
    }
  };
  void ensureBridge();
  // The plugin event surface. plugins.mjs documents `ctx.events.on(type, fn)`,
  // and a bare `{ emit }` object made every subscribing plugin throw in setup
  // and land in `failed`. This is a real Emitter: every harness event is
  // routed onto it below (tagged with its project), and everything on it —
  // a plugin's own emits included — reaches the window over SSE exactly like
  // a harness event always did.
  const bus = new Emitter();
  bus.on('*', (type, payload) => emit(type, payload));
  const plugins = new PluginManager({ settings: appSettings, events: bus, dir: pluginsDir ?? path.join(aipassHome(), 'plugins') });

  /* -------------------------------------------------------- harness per project */

  const harnesses = new Map(); // abs project path → Harness
  let current = null;

  const harnessFor = (projectPath) => {
    const abs = path.resolve(projectPath);
    if (harnesses.has(abs)) return harnesses.get(abs);

    const bridgeModel = model ?? appSettings.get('defaultModel') ?? null;
    const h = new Harness({
      root: abs,
      bridgeURL,
      model: bridgeModel,
      store: new SessionStore(storeDir),
      // The budget the sheet owns, plus the share of it the rotation knob
      // names. An explicit `compaction` (a test, a CLI flag) wins whole: it is
      // a budget, and folding a share into one the caller did not ask for
      // would be this layer inventing policy.
      compaction: compaction ?? { ...appSettings.get('compaction'), compactAtPercent: appSettings.get('compactAtPercent') },
      // The window's human may be reading a diff when the question lands; the
      // run waits for their answer instead of denying after two minutes.
      permissionTimeoutMs: 0,
      rulesFile,
      options: {
        mode: appSettings.get('mode'),
        allowRun: appSettings.get('allowRun'),
        maxSteps: appSettings.get('maxSteps'),
        maxToolCalls: appSettings.get('maxToolCalls'),
        maxWallClockMs: appSettings.get('maxWallClockMs'),
        plan: appSettings.get('plan'),
        requirePlanApproval: appSettings.get('requirePlanApproval'),
        subagent: appSettings.get('subagent'),
        thinking: appSettings.get('thinking'),
        searchI: appSettings.get('searchI'),
        attach: appSettings.get('attach'),
        webScratch: appSettings.get('webScratch'),
        parallelHelpers: appSettings.get('parallelHelpers'),
        // (Thai pack) Reply-language policy and the loop guards the settings
        // sheet owns: language check, repeat guard, and the window's attempt
        // count for a failed checker.
        replyLanguage: appSettings.get('replyLanguage'),
        langCheck: appSettings.get('langCheck'),
        minThaiRatio: appSettings.get('minThaiRatio'),
        repeatGuard: appSettings.get('repeatGuard'),
        repeatGuardMax: appSettings.get('repeatGuardMax'),
        attempts: appSettings.get('attempts'),
        // Where the chat tab lives, so a run that needs one can name the right
        // URL on its needs_tab event.
        chatUrl: appSettings.get('chatUrl'),
      },
      // The path rules the window (or the CLI) wrote into settings: a harness
      // built without them would run under the mode alone until restart.
      rules: appSettings.get('rules') ?? [],
      skills: skillLibraryFor(abs),
    });
    h.events.on('*', (type, payload) => bus.emit(type, { project: abs, ...payload }));
    harnesses.set(abs, h);
    return h;
  };

  const skillLibraryFor = (abs) => {
    // Order: explicit folders from settings, then the project's own library,
    // then the user's, then the ones shipped with the CLI. First match wins.
    const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'skills');
    const userDir = path.join(aipassHome(), 'skills');
    const dirs = [
      ...(appSettings.get('skillsDirs') ?? []),
      path.join(abs, '.aipass', 'skills'),
      userDir,
      repoDir,
    ].filter(Boolean);
    return new SkillLibrary(dirs);
  };

  const pickRoot = () => {
    const wanted = appSettings.get('root');
    if (wanted && fs.existsSync(wanted)) return path.resolve(wanted);
    return path.resolve(root);
  };

  const switchProject = (projectPath, { remember = true } = {}) => {
    const abs = path.resolve(projectPath);
    if (!fs.existsSync(abs)) throw new Error(`no such folder: ${abs}`);
    current = harnessFor(abs);
    if (remember) {
      appSettings.addProject(abs);
      emit('project', { root: abs });
    }
    return current;
  };

  current = switchProject(pickRoot(), { remember: false });
  // The root a backend starts on is the root it will be opened on again, so it
  // becomes the first entry in the project list rather than a setting on its own.
  appSettings.addProject(current.root);

  /* --------------------------------------------------------------- attachments */

const openBrowser = async (url) => {
  const cmd = process.platform === 'win32' ? `cmd /c start "" "${url}"`
    : process.platform === 'darwin' ? `open ${url}`
      : `xdg-open ${url}`;
  try {
    const { exec } = await import('node:child_process');
    await new Promise((resolve) => exec(cmd, () => resolve()));
    return true;
  } catch {
    return false;
  }
};

  const staged = new Map(); // id → {id, name, path, bytes, mime, at}

  /**
   * Stage an attachment. Either a data URL (drag-drop, picker, clipboard) or a
   * path on disk (/file, /image) — a desktop user usually has the path, not a
   * picker, and re-reading the bytes here keeps the window free of file access.
   */
  const stageAttachment = ({ name, dataUrl, path: fromPath }) => {
    const id = Math.random().toString(16).slice(2, 10);
    const dir = appSettings.uploadDir();
    let bytes;
    let base;
    if (fromPath) {
      // "~" for home, absolute as given, anything else relative to the project
      // root — a user typing /file src/app.js means the file they can see.
      const typed = String(fromPath).trim();
      const abs = typed.startsWith('~')
        ? path.resolve(typed.replace(/^~(?=\/|\\|$)/, os.homedir()))
        : path.isAbsolute(typed)
          ? path.resolve(typed)
          : path.resolve(root, typed);
      if (!fs.existsSync(abs)) throw new Error(`no such file: ${fromPath}`);
      bytes = fs.readFileSync(abs);
      base = path.basename(abs);
      const sameDir = path.dirname(abs) === dir;
      const target = path.join(dir, `${id}-${base}`);
      if (!sameDir) fs.copyFileSync(abs, target);
      // Keep the original readable path so the model can be told where it is.
      staged.set(id, { id, name: base, path: sameDir ? abs : target, source: abs, bytes: bytes.length, mime: mimeOf(base), at: Date.now() });
      return staged.get(id);
    }
    base = path.basename(name ?? 'attachment');
    const mime = /^data:([^;,]+)[;,]/.exec(dataUrl ?? '')?.[1] ?? mimeOf(base);
    bytes = Buffer.from(String(dataUrl ?? '').split(',').at(-1) ?? '', 'base64');
    if (!bytes.length) throw new Error('empty attachment');
    if (bytes.length > MAX_ATTACHMENT_BYTES) throw new Error(`attachment too large: ${Math.round(bytes.length / 1024 / 1024)} MB (cap ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB)`);
    const file = path.join(dir, `${id}-${base}`);
    fs.writeFileSync(file, bytes);
    staged.set(id, { id, name: base, path: file, bytes: bytes.length, mime, at: Date.now() });
    return staged.get(id);
  };

  /** Parts the bridge wants, in the order they should be sent. */
  const partsFor = (ids = []) => ids.map((id) => {
    const item = staged.get(id);
    if (!item) throw new Error(`attachment ${id} is gone — stage it again`);
    if (item.mime.startsWith('image/')) return { type: 'image_url', image_url: { url: `data:${item.mime};base64,${fs.readFileSync(item.path).toString('base64')}` } };
    return { type: 'file', file: { file_data: `data:${item.mime};base64,${fs.readFileSync(item.path).toString('base64')}`, filename: item.name } };
  });

  const dropAttachment = (id) => {
    const item = staged.get(id);
    if (item) fs.rmSync(item.path, { force: true });
    staged.delete(id);
  };

  /* -------------------------------------------------------------------- methods */

  const methods = {
    /* ------------------------------------------------------------ reading */

    async status() {
      const st = await current.bridge.status().catch(() => null);
      return {
        root: current.root,
        projects: appSettings.projectList().map((p) => ({ ...p, current: p.path === current.root })),
        bridge: Boolean(st?.ok),
        extensions: st?.extensions ?? 0,
        // The harness's model first: it is the one a run sends. The bridge's
        // own default is only a fallback, because the bridge remembers whatever
        // the browser tab last used — showing that instead would put a retired
        // model in the header while a different one answers.
        model: current.bridge.model ?? st?.defaultModel ?? null,
        conversation: st?.conversation ?? null,
        session: current.session ? current.session.meta() : null,
        running: current.running,
        mode: current.options.mode,
        allowRun: current.options.allowRun,
        maxSteps: current.options.maxSteps,
        plan: current.options.plan,
        subagent: current.options.subagent,
        pending: current.pendingChanges(),
        // Context is invisible until it is not: this meter is the difference
        // between "it is handling that" and "why did it forget what I said".
        context: current.contextUsage(),
        plugins: plugins.details(),
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
    async snapshot() {
      return {
        status: await methods.status(),
        session: current.session ? current.session.meta() : null,
        entries: current.session?.entries ?? [],
        pending: current.pendingChanges(),
        context: current.contextUsage(),
        skills: current.skills.list(),
      };
    },

    async models() { return current.bridge.models(true); },
    async credits() { return current.bridge.quota(true); },
    async conversations() { return current.bridge.conversations(); },

    async 'config.set'(params = {}) {
      if (params.model != null) { current.bridge.model = params.model; appSettings.set({ defaultModel: params.model }); }
      await current.bridge.config(Object.fromEntries(Object.entries(params).filter(([k]) => ['model', 'assistant', 'aspectRatio', 'conversation'].includes(k))));
      return { ok: true };
    },

    /* ------------------------------------------------------- conversations */

    // The upstream holds one conversation per browser tab and cannot be trimmed,
    // so switching conversations is the only way to start clean without losing
    // the local session history. The CLI has had it all along; the window had
    // no way in, which is why a "new session" kept answering from yesterday.
    async 'conversations.list'() { return current.bridge.conversations(); },
    async 'conversation.new'(params = {}) {
      // No tab reachable answers {id: null} like it always did — the window
      // offers to open one instead of reading a stack trace. The create retry
      // inside BridgeClient has already waited out a reconnect gap; anything
      // else (the bridge being down) throws for the window to show.
      const made = await current.bridge.createConversation({
        model: params.model ?? current.bridge.model ?? undefined,
        temporary: true,
        message: params.message ?? 'Starting a new working session.',
      }).catch((err) => {
        if (/no extension connected/i.test(err.message)) return null;
        throw err;
      });
      await current.bridge.config({ conversation: made?.id ?? null });
      current.conversation = made?.id ?? null;
      emit('conversation', { id: current.conversation, temporary: true });
      return made ?? { id: null };
    },
    async 'conversation.pin'(params = {}) {
      await current.bridge.config({ conversation: params.id ?? null });
      current.conversation = params.id ?? null;
      emit('conversation', { id: current.conversation });
      return { ok: true, id: params.id ?? null };
    },

    /* ------------------------------------------------------------ settings */

    async 'settings.get'() { return appSettings.values; },
    async 'settings.set'(params = {}) {
      const next = appSettings.set(params);
      // A change of root moves the live run onto another project first: every
      // policy below it belongs to the harness that keeps running.
      if (params.root != null) switchProject(params.root);
      // A change of mode or root is not a note in a file: it moves the live run.
      if (params.mode || params.allowRun != null) current.setPolicy({ mode: params.mode ?? null, allowRun: params.allowRun ?? null });
      // The settings sheet claims a value is live the moment Save is pressed,
      // so every setting that reaches a module of its own is re-applied here
      // rather than at the next start. A half-applied form is worse than no
      // form: it writes one truth and keeps the process running another.
      if (params.maxSteps != null) current.options.maxSteps = appSettings.get('maxSteps');
      if (params.plan != null) current.options.plan = appSettings.get('plan');
      if (params.requirePlanApproval != null) current.options.requirePlanApproval = appSettings.get('requirePlanApproval');
      if (params.subagent != null) current.options.subagent = appSettings.get('subagent');
      if (params.thinking != null) current.options.thinking = appSettings.get('thinking');
      if (params.defaultModel != null) current.bridge.model = params.defaultModel;
      if (params.compaction) current.compactor = Object.assign(current.compactor, params.compaction);
      // The rotation share is its own setting, not part of the budget object:
      // it is the knob a person turns, the budget is the ceiling.
      if (params.compactAtPercent != null) current.compactor.compactAtPercent = params.compactAtPercent;
      // (Thai pack) The language keys and the loop guards read their options
      // per run, so the sheet's save has to move the live copies too.
      for (const key of ['replyLanguage', 'langCheck', 'minThaiRatio', 'repeatGuard', 'repeatGuardMax', 'attempts']) {
        if (params[key] != null) current.options[key] = appSettings.get(key);
      }
      // The playbook folders and the plugin list are the two settings a module
      // of their own owns; both are rebuilt by name here so the sheet has one
      // contract instead of a footnote saying "restart for these two".
      if (params.skillsDirs != null) current.skills = skillLibraryFor(current.root);
      if (params.plugins != null) void plugins.load();
      // Path rules are read on every evaluate(), so they are the cheapest kind
      // of live: the engine swaps the array and the next marker sees them.
      if (params.rules != null) current.setRules(appSettings.get('rules') ?? []);
      emit('settings', next);
      return next;
    },

    /**
     * The path rules as the running engine sees them — the ones actually in
     * force, not a second copy the window keeps. Reading them back is how the
     * sheet proves a save landed.
     */
    async 'rules.get'() {
      return { rules: current.permissions.rules ?? [] };
    },

    /**
     * Replace the path rules. Written through settings so the CLI and the
     * window share one file, and applied to the live engine in the same
     * breath: a rule that only exists on disk changes nothing until restart,
     * which is exactly the lie this method exists to not tell.
     */
    async 'rules.set'(params = {}) {
      const next = appSettings.set({ rules: params.rules ?? [] });
      current.setRules(next.rules ?? []);
      return { rules: next.rules ?? [] };
    },

    /** Back to the defaults, projects and all. The escape hatch from a form. */
    async 'settings.reset'() {
      const next = appSettings.reset();
      current.setPolicy({ mode: next.mode, allowRun: next.allowRun });
      current.bridge.model = next.defaultModel;
      emit('settings', next);
      return next;
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

    /* ------------------------------------------------------------ sessions */

    // Scoped to the project the window is on: the store keeps one directory
    // per root, and an unscoped list mixes in every other project — on this
    // machine that was thousands of test leftovers, not conversations.
    async 'session.list'() { return current.store.list(current.root); },
    async 'session.new'(params = {}) {
      const s = await current.startSession({ title: params.title ?? null });
      return s ? s.meta() : null;
    },
    async 'session.open'(params = {}) {
      const s = await current.startSession({ sessionId: params.id });
      if (!s) throw new Error('session not found');
      emit('session_opened', s.meta());
      return s.entries;
    },
    async 'session.entries'() { return current.session?.entries ?? []; },
    async 'session.rename'(params = {}) { current.store.rename(params.id, params.title); return { ok: true }; },
    async 'session.delete'(params = {}) { current.store.remove(params.id); return { ok: true }; },
    async 'session.fork'(params = {}) {
      if (!current.session) throw new Error('no session to fork');
      const forked = current.session.fork(current.store, { fromEntryId: params.from ?? null });
      emit('session_forked', forked.meta());
      return forked.meta();
    },

    /* ----------------------------------------------------------------- run */

    async run(params = {}) {
      if (!params.task?.trim()) throw new Error('no task given');
      current.setPolicy({ mode: params.mode ?? null, allowRun: params.allowRun ?? null });
      Object.assign(current.options, {
        plan: params.plan ?? current.options.plan,
        subagent: params.subagent ?? current.options.subagent,
        // Unlike maxSteps and friends this one is only ever a saved setting:
        // the window flips plan mode through settings.set and never through
        // the run call, so the live value is the default — an explicit run
        // param still wins.
        requirePlanApproval: Boolean(params.requirePlanApproval ?? current.options.requirePlanApproval),
        maxSteps: params.maxSteps ?? current.options.maxSteps,
        maxToolCalls: params.maxToolCalls ?? current.options.maxToolCalls,
        maxWallClockMs: params.maxWallClockMs ?? current.options.maxWallClockMs,
        searchI: params.searchI ?? current.options.searchI,
        attach: params.attach ?? current.options.attach,
        webScratch: params.webScratch ?? current.options.webScratch,
        parallelHelpers: params.parallelHelpers ?? current.options.parallelHelpers,
        attempts: params.attempts ?? current.options.attempts,
        parts: partsFor(params.attachments ?? []),
        pluginTools: plugins.toolTable(),
      });
      if (params.model) current.bridge.model = params.model;
      if (!current.session) await current.startSession({ title: params.title ?? null });
      // (Thai pack) Attempts: when the checker reports the staged tree still
      // fails, the window may re-run the task instead of handing a known-bad
      // tree back. Every attempt starts from a cleared overlay (the loop
      // clears it on entry) in the same conversation, so the model sees its
      // own failure and tries a different route; the first attempt whose
      // check passes is the one kept. Each attempt costs a full run.
      const attempts = Math.min(5, Math.max(1, Math.floor(Number(current.options.attempts ?? 1))));
      let result = null;
      let used = 0;
      for (let i = 1; i <= attempts; i++) {
        used = i;
        result = await current.run(params.task, { runPluginTool: (marker, args) => plugins.runTool(marker, args) });
        const verdict = result.check?.verdict ?? null;
        if (used === attempts || verdict !== 'fail') break;
        emit('note', { text: `check failed after attempt ${used} of ${attempts} — running the task again` });
      }
      return {
        summary: result.summary,
        stopReason: result.stopReason,
        steps: result.steps,
        spent: result.spent,
        attempts: used,
        check: result.check?.verdict ?? null,
        pending: current.pendingChanges(),
      };
    },

    cancel() { current.cancel(); return { ok: true }; },

    /* -------------------------------------------------------- permissions */

    async 'permission.answer'(params = {}) { return { ok: current.answer(params.id, params.decision) }; },
    async 'plan.answer'(params = {}) { current.answerPlan(Boolean(params.ok)); return { ok: true }; },

    /* -------------------------------------------------------------- diffs */

    async pending() { return current.pendingChanges(); },
    async compact() {
      if (!current.session) throw new Error('no session yet — send something first');
      const done = await current.compactNow();
      return { summary: done.summary, context: current.contextUsage() };
    },
    async diff(params = {}) {
      const abs = current.overlay.safe(params.file);
      if (!current.overlay.has(abs)) throw new Error('no pending change for that file');
      return current.overlay.changes().find((c) => c.abs === abs) ?? null;
    },
    async apply(params = {}) { return current.apply(params.files ?? null); },
    async discard() { return { dropped: current.discard() }; },

    /* ---------------------------------------------------------- attachments */

    async 'attachment.stage'(params = {}) { return stageAttachment(params); },
    async 'attachment.list'() { return [...staged.values()]; },
    async 'attachment.remove'(params = {}) { dropAttachment(params.id); return { ok: true }; },

    /* -------------------------------------------------------------- browser */

    async 'browser.open'(params = {}) { return { ok: await openBrowser(params.url ?? appSettings.get('chatUrl')) }; },

    /* ------------------------------------------------------------- skills */

    async 'skills.list'() { return current.skills.list(); },
    async 'skills.index'() { return { index: current.skills.index() }; },
    async 'skills.load'(params = {}) {
      const found = current.skills.load(params.name);
      if (found.error) throw new Error(found.error);
      return found;
    },

    /* ------------------------------------------------------------- plugins */
    async 'plugins.list'() { return plugins.details(); },
    async 'plugins.reload'() {
      await plugins.load();
      emit('plugins', plugins.details());
      return plugins.details();
    },
    async 'panel.render'(params = {}) { return plugins.renderPanel(params.id); },

    /* ----------------------------------------------------------------- fs */

    async 'fs.list'(params = {}) {
      const dir = current.overlay.trySafe(params.dir ?? '.');
      if (!dir) throw new Error(`outside project root: ${params.dir ?? '.'}`);
      return fs.readdirSync(dir, { withFileTypes: true }).map((e) => ({ name: e.name, dir: e.isDirectory() }))
        .filter((e) => !['node_modules', '.git', '.next', 'dist', 'build', '.cache'].includes(e.name));
    },
    async 'fs.read'(params = {}) {
      const abs = current.overlay.trySafe(params.file);
      if (!abs) throw new Error(`outside project root: ${params.file}`);
      if (!current.overlay.existsAt(abs)) throw new Error('no such file');
      return { file: params.file, text: current.overlay.readAt(abs) };
    },
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    // Local only, for the reasons spelled out next to `isLocalRequest`. This
    // runs before any route, including the static UI files: a page that can
    // only reach this port from this machine can talk to it, and nothing else
    // can even load it.
    if (!isLocalRequest(req)) {
      return json(res, 403, { ok: false, error: 'local requests only — this port serves the machine it runs on' });
    }

    if (url.pathname === '/events' && req.method === 'GET') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      // A reconnect carries `?since=` (and a browser EventSource reconnect
      // carries Last-Event-ID); replay what that listener missed before the
      // live stream continues. A brand-new listener with no cursor gets
      // nothing replayed — it starts from here, like the wire always did.
      const since = Number(
        req.headers['last-event-id']
        ?? url.searchParams.get('since')
        ?? 0,
      );
      if (Number.isFinite(since) && since > 0) {
        for (const frame of replay) {
          if (frame.seq > since) res.write(`event: ${frame.event}\nid: ${frame.seq}\ndata: ${JSON.stringify(frame.body)}\n\n`);
        }
      }
      res.write(`event: hello\ndata: ${JSON.stringify({ seq })}\n\n`);
      listeners.add(res);
      const ping = setInterval(() => res.write(': keepalive\n\n'), 15_000);
      req.on('close', () => { clearInterval(ping); listeners.delete(res); });
      return;
    }

    if (url.pathname === '/rpc' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 32_000_000) req.destroy(); });
      req.on('end', async () => {
        let msg = {};
        try {
          msg = JSON.parse(body || '{}');
        } catch (err) {
          // A body that does not parse is the caller's bug — say so, instead of
          // letting `msg = {}` fall through to "no such method: undefined",
          // which sends whoever wrote the request looking in the wrong place.
          return json(res, 400, { ok: false, error: `bad JSON body: ${err.message}` });
        }

        const fn = methods[msg.method];
        if (!fn) {
          // Not a built-in — maybe a plugin provides it. A plugin may not
          // shadow anything above, so the built-in check comes first.
          if (plugins.hasMethod(msg.method)) {
            try {
              return json(res, 200, { ok: true, result: await plugins.callMethod(msg.method, msg.params ?? {}) });
            } catch (err) {
              return json(res, 200, { ok: false, error: String(err.message ?? err) });
            }
          }
          return json(res, 404, { ok: false, error: `no such method: ${msg.method}` });
        }
        try {
          return json(res, 200, { ok: true, result: await fn(msg.params ?? {}) });
        } catch (err) {
          return json(res, 200, { ok: false, error: String(err.message ?? err) });
        }
      });
      return;
    }

    // The UI itself: a handful of static files, no build step.
    const target = staticFileFor(UI_DIR, url.pathname);
    if (!target || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
      return json(res, 404, { ok: false, error: 'not found' });
    }
    const type = target.endsWith('.html') ? 'text/html; charset=utf-8'
      : target.endsWith('.css') ? 'text/css; charset=utf-8'
        : target.endsWith('.js') ? 'text/javascript; charset=utf-8'
          : 'application/octet-stream';
    // No headers the browser can revalidate with, so a cached copy would be
    // served blind — and this UI is edited live. no-cache forces the request
    // back to this server every reload; the file is on local disk anyway.
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache' });
    fs.createReadStream(target).pipe(res);
  });

  // Plugins load last: they may call anything above, and they register the
  // methods the window can then use.
  plugins.load().catch((err) => process.stderr.write(`plugin load failed: ${err.message}\n`));

  // A run that cannot proceed because no chat tab is open is a one-click fix, so
  // the backend offers the click (and takes it when settings allow).
  current.events.on('needs_tab', async ({ url }) => {
    if (appSettings.get('autoOpenTab') === false) return;
    const opened = await openBrowser(url);
    emit('tab_opened', { url, opened });
  });

  server.listen(port, '127.0.0.1');
  return { server, harness: current, get current() { return current; }, plugins, settings: appSettings, events: bus, port, url: `http://127.0.0.1:${port}` };
}

const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
};

// Run standalone: node aipass-bridge/harness/rpc.mjs [--port 8790] [--root DIR]
const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const argv = process.argv.slice(2);
  const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
  const rpc = createRpc({ port: Number(arg('port', 8790)), root: arg('root', process.cwd()) });
  process.stdout.write(`aipass desktop backend on ${rpc.url}\n`);
}
