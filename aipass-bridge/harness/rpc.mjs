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
import { SessionStore, APP_VERSION } from './session.mjs';
import { binaryKind } from './overlay.mjs';
import { listSymbols, findDefinition, findReferences } from './symbols.mjs';
import { SkillLibrary, skillDirsFor } from './skills.mjs';
import { Settings, aipassHome } from './settings.mjs';
import { PluginManager } from './plugins.mjs';
import {
  inspectSource, installSource, finalizeInstall, removePlugin, readRegistry,
  decorateDetails, materializeEnabledList, stripFromEnabled, knownNames, NONE_NAME,
} from './install.mjs';
import { loadConfig, addServer, removeServer, setServerEnabled, testServer } from './mcp.mjs';
import { Emitter } from './events.mjs';
// The provider registry: which provider the runs talk to, where it lives and
// where its key comes from. The specs and the keys are two files, and neither
// of them is settings.json.
import { ProviderStore, AIPASS_PROVIDER, publicSpec } from './providers.mjs';
import { clientFor } from './provider-client.mjs';
// One resolver for "where the bridge is", shared with the harness's own client
// and with desktop/main.mjs's probe: an explicit bridgeURL wins, otherwise
// AIPASS_BRIDGE decides, otherwise the loopback default.
import { resolveBridgeURL } from './bridge.mjs';
import { openBrowser } from './browser.mjs';
import { restoreTable } from './waf.mjs';
import { loadOrMintToken, authorized, authorizedQuery, UNAUTHORIZED } from './authtoken.mjs';
import { openLogFile } from './log-file.mjs';
import { formatLogLine } from './log-line.mjs';
import { scrubSecrets } from '../bridge/log-scrub.mjs';

// Re-exported for desktop/main.mjs, whose ensureBridge probe must resolve the
// bridge exactly the way the harness's own client does.
/**
 * The Content-Security-Policy the window is served under.
 *
 * The window is a page that drives an agent that writes files. It is loaded
 * from THIS backend over plain HTTP, so the policy that binds is the one the
 * backend sends — not the one the shell's config declares: a webview loading
 * an external URL is governed by that URL's own headers, and the shell's
 * declaration covers the asset protocol, which this window does not use.
 * The two are kept identical, and a test says so.
 *
 *   script    the app's own modules and nothing else — no inline, no eval
 *   style     'unsafe-inline' because a plugin panel may style itself
 *   img/media the model's own pictures and clips, from the web
 *   connect   this backend, and the loopback it is served from
 *
 * The object is the shape tauri.conf.json wants, so the two can be compared
 * key by key.
 */
export const WINDOW_CSP = {
  'default-src': "'none'",
  'script-src': "'self'",
  'style-src': "'self' 'unsafe-inline'",
  'img-src': "'self' data: blob: https: http:",
  'media-src': "'self' data: blob: https: http:",
  'font-src': "'self' data:",
  'connect-src': "'self' http://127.0.0.1:* http://localhost:*",
  'base-uri': "'self'",
  'form-action': "'none'",
  'frame-ancestors': "'none'",
  'object-src': "'none'",
};

/** The same policy as one header value. */
export const WINDOW_CSP_HEADER = Object.entries(WINDOW_CSP).map(([k, v]) => `${k} ${v}`).join('; ');

export { resolveBridgeURL };

/**
 * The most a `/rpc` body may carry.
 *
 * One 20 MB attachment is ~27 MB of base64 on the wire, so the cap has to
 * fit a couple of them — but it is a cap: the body is buffered in memory
 * before it is parsed.
 */
const MAX_BODY = 64_000_000;

/**
 * The most a file the window opens may weigh.
 *
 * The same cap the tool layer puts on a file it reads: a 500 MB log is data,
 * not a file to open.
 */
const MAX_FILE_READ = 1_000_000;

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

/**
 * Same-origin browser page, proven by the headers only a browser sends.
 * Headerless tools (curl, node) fail this on purpose — they can read the token
 * file directly, so the bootstrap endpoint below refuses them and stays a
 * window-only path a CORS-enabled page from another origin cannot use.
 */
const isBrowserSameOrigin = (req) => {
  if (process.env.AIPASS_ALLOW_REMOTE === '1') return false;
  if (!loopbackHost(req.headers.host)) return false;
  if (req.headers['sec-fetch-site'] === 'same-origin') return true;
  const origin = req.headers['origin'];
  if (origin) {
    try { return loopbackHost(new URL(origin).host); } catch { return false; }
  }
  return false;
};

/**
 * Open a URL in the platform browser — Chrome, because that is where the
 * extension lives. The rule (which browser, which argv, and the bookkeeping
 * that lets a test close what it opened) is in browser.mjs; it is re-exported
 * here because the backend and the desktop launcher are the two surfaces that
 * open a URL, and the tests reach for it from here.
 */
export { openBrowser };

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
  // The provider registry. A test (or a second backend) may hand one in; the
  // default reads the same directory the settings live in.
  providerStore = null,
  // The bridge is the browser half of the app. The window's shell is supposed to
  // start it, and the CLI's own entry point does; this is the backstop for a
  // surface that starts only the RPC server (which is what the packaged window
  // does), so a run never fails for want of a listener on 8787. Tests turn it
  // off — they run their own bridge on their own port.
  autostartBridge = true,
  // The most a `/rpc` body may carry. A caller that needs a different cap
  // (a test) says so; the default is the one a real window needs.
  maxBody = MAX_BODY,
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
  let replayBytes = 0;
  // Two bounds, not one count: 500 tiny delta frames covered only seconds of
  // a long run (its middle went missing on reload), while a handful of huge
  // tool results could crowd the same window. The byte bound keeps a
  // reconnecting window's gap small in wall-clock terms; the count is the
  // memory backstop.
  const REPLAY_LIMIT = 5000;
  const REPLAY_BYTES = 4 * 1024 * 1024;
  const emit = (type, payload) => {
    const body = { seq: ++seq, ...(payload ?? {}) };
    const data = JSON.stringify(body);
    replay.push({ event: type, seq: body.seq, data });
    replayBytes += data.length;
    while (replay.length > REPLAY_LIMIT || (replayBytes > REPLAY_BYTES && replay.length > 1)) {
      replayBytes -= replay.shift().data.length;
    }
    const frame = `event: ${type}\nid: ${seq}\ndata: ${data}\n\n`;
    // A listener whose socket died between frames must be dropped, not written
    // to — one dead window must not take down the backend for the live ones.
    for (const res of [...listeners]) {
      try { res.write(frame); } catch { listeners.delete(res); }
    }
  };

  const appSettings = settings ?? new Settings();
  // The provider registry lives beside the settings: same home, same
  // AIPASS_HOME override, so a test that moves the home moves both.
  const providers = providerStore ?? new ProviderStore(appSettings.dir ?? aipassHome());
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
      // Size-capped rotation (harness/log-file.mjs): a bridge left running for
      // weeks used to grow bridge.log without bound.
      const log = openLogFile(path.join(aipassHome(), 'logs', 'bridge.log'));
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
  // abs project path → the session id of the run in flight there (only while
  // one is). A run writes to the session it started in; the harness's own
  // `.session` can move under it (the human opens another session mid-run).
  // Frames are tagged from here so a window showing another session can tell
  // whose stream this is and leaves it alone.
  const runSessions = new Map();
  let current = null;

  /**
   * The provider this install runs on.
   *
   * The setting names one; the registry is the judge of which ids exist, so a
   * provider that was deleted from the file falls back to AiPASS instead of
   * leaving every run without a client.
   */
  const activeProviderId = () => {
    const want = String(appSettings.get('defaultProvider') ?? AIPASS_PROVIDER).trim().toLowerCase();
    return providers.get(want) ? want : AIPASS_PROVIDER;
  };

  /**
   * The model a provider starts on.
   *
   * AiPASS keeps the machine-wide default; every other provider keeps its own,
   * because a model id means nothing across providers — `gpt-4o` is not a
   * thing an Anthropic key can be asked for.
   */
  const modelFor = (providerId) => {
    const spec = providers.get(providerId);
    if (!spec) return null;
    if (spec.kind === 'aipass') return appSettings.get('defaultModel') ?? null;
    return spec.defaultModel ?? spec.models?.[0] ?? null;
  };

  /**
   * The client a provider is reached through.
   *
   * AiPASS is the local bridge and its tab; every other provider is an HTTP
   * API this process calls itself. Both answer the same contract, so nothing
   * below this line ever asks which one it got.
   */
  const clientForProvider = (providerId, { model = null, events = null } = {}) => {
    const spec = providers.get(providerId);
    if (!spec) return null;
    return clientFor(spec, {
      bridgeURL,
      model: model ?? modelFor(providerId),
      key: spec.kind === 'aipass' ? null : providers.keyFor(spec.id),
      onNote: (text) => events?.emit('firewall_note', { text }),
      onStreamNote: (text) => events?.emit('note', { text }),
    });
  };

  /**
   * Point one harness at the provider it should be talking to.
   *
   * A switch replaces the client and nothing else: the harness, the loop and
   * the tools all talk to `h.bridge`, so a client that answers the same
   * contract is the whole of the change. The client is NOT rebuilt when the
   * provider did not change — a provider client owns the conversation
   * history, and a settings save must not drop it.
   */
  const applyProviderTo = (h, providerId = activeProviderId()) => {
    if (!providers.get(providerId)) return;
    // The same provider: the client stays, and so does everything it owns —
    // a provider client keeps the conversation history, and a settings save
    // must not drop it.
    if (h.providerId === providerId && h.bridge) return;
    const client = clientForProvider(providerId, { model: model ?? modelFor(providerId), events: h.events });
    if (client) h.setProvider(client);
  };

  const harnessFor = (projectPath) => {
    const abs = path.resolve(projectPath);
    if (harnesses.has(abs)) return harnesses.get(abs);

    const bridgeModel = model ?? appSettings.get('defaultModel') ?? null;
    const h = new Harness({
      root: abs,
      bridgeURL,
      model: bridgeModel,
      client: clientForProvider(activeProviderId(), { model: bridgeModel }),
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
        maxResult: appSettings.get('maxResult'),
        maxToolCalls: appSettings.get('maxToolCalls'),
        maxWallClockMs: appSettings.get('maxWallClockMs'),
        plan: appSettings.get('plan'),
        requirePlanApproval: appSettings.get('requirePlanApproval'),
        subagent: appSettings.get('subagent'),
        thinking: appSettings.get('thinking'),
        temperature: appSettings.get('temperature'),
        searchI: appSettings.get('searchI'),
        attach: appSettings.get('attach'),
        webScratch: appSettings.get('webScratch'),
        parallelHelpers: appSettings.get('parallelHelpers'),
        // The window's bootstrap start: the same git status + package.json
        // snapshot the CLI asks for with `--snapshot`. On by default here
        // because the window's user pays the same discovery round trips and
        // never sees the flag; a caller can still pass `snapshot: false`.
        snapshot: true,
        // (Thai pack) Reply-language policy and the loop guards the settings
        // sheet owns: language check, repeat guard, and the window's attempt
        // count for a failed checker.
        replyLanguage: appSettings.get('replyLanguage'),
        langCheck: appSettings.get('langCheck'),
        minThaiRatio: appSettings.get('minThaiRatio'),
        repeatGuard: appSettings.get('repeatGuard'),
        repeatGuardMax: appSettings.get('repeatGuardMax'),
        attempts: appSettings.get('attempts'),
        // (docs/SPEC_CHECKER.md) The declared check and the strict Verify gate.
        verifyCommand: appSettings.get('verifyCommand'),
        requireCheck: appSettings.get('requireCheck'),
        // Where the chat tab lives, so a run that needs one can name the right
        // URL on its needs_tab event.
        chatUrl: appSettings.get('chatUrl'),
      },
      // The path rules the window (or the CLI) wrote into settings: a harness
      // built without them would run under the mode alone until restart.
      rules: appSettings.get('rules') ?? [],
      skills: skillLibraryFor(abs),
    });
    // Every frame carries its project and, when there is one, its session:
    // `runSessions` while a run is in flight (the run's own session, whatever
    // the window is looking at), the harness's current session otherwise.
    h.events.on('*', (type, payload) => bus.emit(type, {
      project: abs,
      session: runSessions.get(abs) ?? h.session?.id ?? null,
      ...payload,
    }));
    harnesses.set(abs, h);
    return h;
  };

  const skillLibraryFor = (abs) => {
    // One order for every surface: the folders a person configured, then the
    // project's own library, then the user's, then the ones shipped with the
    // CLI. First match wins. The window and the CLI used to disagree about
    // the first slot, so a name in two libraries loaded a different file
    // depending on who asked.
    const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'skills');
    const { dirs, roles } = skillDirsFor({
      root: abs,
      repoDir,
      configured: appSettings.get('skillsDirs') ?? [],
    });
    // The generated index labels each library by its stated role; the two
    // known folders are named, not inferred from position, so a missing
    // project folder cannot mark the user's library as the project's.
    return new SkillLibrary(dirs, { roles });
  };

  /**
   * Every settings-owned value, applied to one live harness whole.
   *
   * This is the sheet's promise taken literally: what the file says is what
   * the harness runs under, whatever it was built with. `settings.set` walks a
   * save parameter by parameter for every harness the backend holds; a project
   * switch (and `settings.reset`) runs this, so an install whose settings were
   * changed by a side door — a CLI writing the file while this backend ran, a
   * backup restored underneath it — cannot leave a harness running yesterday's
   * temperature, budgets or path rules while every window shows the new ones.
   */
  const applySettingsTo = (h) => {
    h.setPolicy({ mode: appSettings.get('mode'), allowRun: appSettings.get('allowRun'), allowFetch: appSettings.get('allowFetch') });
    Object.assign(h.options, {
      maxSteps: appSettings.get('maxSteps'),
      maxResult: appSettings.get('maxResult'),
      maxToolCalls: appSettings.get('maxToolCalls'),
      maxWallClockMs: appSettings.get('maxWallClockMs'),
      maxCredits: appSettings.get('maxCredits'),
      plan: appSettings.get('plan'),
      requirePlanApproval: appSettings.get('requirePlanApproval'),
      subagent: appSettings.get('subagent'),
      thinking: appSettings.get('thinking'),
      temperature: appSettings.get('temperature'),
      searchI: appSettings.get('searchI'),
      attach: appSettings.get('attach'),
      webScratch: appSettings.get('webScratch'),
      // A fetch the model chose is a question the person sees, unless the
      // settings say the machine has been told to let it through.
      allowFetch: appSettings.get('allowFetch'),
      parallelHelpers: appSettings.get('parallelHelpers'),
      // (Thai pack) the language policy and the loop guards
      replyLanguage: appSettings.get('replyLanguage'),
      langCheck: appSettings.get('langCheck'),
      minThaiRatio: appSettings.get('minThaiRatio'),
      repeatGuard: appSettings.get('repeatGuard'),
      repeatGuardMax: appSettings.get('repeatGuardMax'),
      attempts: appSettings.get('attempts'),
      // The declared check and the strict Verify gate, re-applied so a save in
      // the sheet is live on every harness the backend holds.
      verifyCommand: appSettings.get('verifyCommand'),
      requireCheck: appSettings.get('requireCheck'),
      chatUrl: appSettings.get('chatUrl'),
    });
    // An explicit compaction (a CLI flag, a test) wins whole — the same rule
    // harnessFor applies: it is a budget, and folding a saved share into one
    // the caller did not ask for would be this layer inventing policy.
    if (!compaction) h.compactor = Object.assign(h.compactor, appSettings.get('compaction'), { compactAtPercent: appSettings.get('compactAtPercent') });
    // The explicit pin a CLI or a test passed wins whole (like compaction);
    // otherwise the file is the truth, null included — that is how a reset
    // clears the model a run had picked. The provider is applied first: a
    // harness that is about to be moved to another provider must not keep the
    // old one's model, and each provider remembers its own.
    applyProviderTo(h);
    h.bridge.model = model ?? modelFor(h.providerId) ?? null;
    h.skills = skillLibraryFor(h.root);
    h.setRules(appSettings.get('rules') ?? []);
  };

  const pickRoot = () => {
    const wanted = appSettings.get('root');
    if (wanted && fs.existsSync(wanted)) return path.resolve(wanted);
    return path.resolve(root);
  };

  const switchProject = (projectPath, { remember = true } = {}) => {
    const abs = path.resolve(projectPath);
    if (!fs.existsSync(abs)) throw new Error(`no such folder: ${abs}`);
    // Whatever the backend is leaving behind is left warm but not spawned: an
    // idle harness's MCP servers are child processes, and a long-lived backend
    // that has visited many projects would otherwise collect one set per
    // project it ever ran in. The one being entered keeps its clients (the
    // window is about to use it), and a harness with a run in flight keeps
    // them too — that run may still call an MCP tool. They respawn on demand.
    for (const [otherAbs, other] of harnesses) {
      if (otherAbs !== abs && !other.running) other.mcp.close();
    }
    current = harnessFor(abs);
    // The file is the truth for the harness being entered, even one this
    // backend built long before the last save: without this, a project visited
    // in the morning ran on the morning's temperature, budgets and rules while
    // the sheet (and every window) said the new ones were in force.
    applySettingsTo(current);
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

  /**
   * The harness a call is about.
   *
   * The backend holds one harness per project, and `current` is the one the
   * last window to talk moved it to. A window names the project it is showing
   * on every call, so two windows open on two projects cannot read each
   * other's sessions, files or pending diffs — and one window's Apply button
   * cannot write the other window's staged edits.
   *
   * The named project is looked up, never switched to: a call is a target, not
   * a move of the machine's "current project" (the human's own switch still
   * does that, through projects.switch).
   *
   * The key is `project`, not `root`: in settings.set, `root` already means
   * "switch the machine to this project", and one key cannot mean two things.
   * `root` is still read as a fallback, so a caller that only knows the older
   * spelling keeps working.
   */
  const targetFor = (params = {}) => {
    const wanted = params?.project ?? params?.root;
    if (!wanted) return current;
    const abs = path.resolve(wanted);
    if (abs === current.root) return current;
    if (!fs.existsSync(abs)) throw new Error(`no such folder: ${abs}`);
    const known = harnesses.get(abs);
    if (known) return known;
    // A project the backend has not visited yet still needs a harness to
    // answer for — and it must run under the settings file as it is now, not
    // as it was when the backend started.
    const h = harnessFor(abs);
    applySettingsTo(h);
    return h;
  };

  /* --------------------------------------------------------------- attachments */

  const staged = new Map(); // id → {id, name, path, bytes, mime, at}

  /**
   * Stage an attachment. Either a data URL (drag-drop, picker, clipboard) or a
   * path on disk (/file, /image) — a desktop user usually has the path, not a
   * picker, and re-reading the bytes here keeps the window free of file access.
   *
   * A relative path is relative to the PROJECT the caller is on, not to the
   * folder the backend happened to start in: the window's file panel hands
   * over project-relative paths, and those only resolve for the project the
   * window is showing.
   */
  const stageAttachment = async ({ name, dataUrl, path: fromPath }, baseRoot = root) => {
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
          : path.resolve(baseRoot, typed);
      if (!fs.existsSync(abs)) throw new Error(`no such file: ${fromPath}`);
      // The data-URL branch below enforces MAX_ATTACHMENT_BYTES; a path needs
      // the same cap BEFORE the read, or staging a multi-GB file OOMs the
      // backend (and base64-inflates it again per send in partsFor).
      const size = (await fs.promises.stat(abs)).size;
      if (size > MAX_ATTACHMENT_BYTES) throw new Error(`attachment too large: ${Math.round(size / 1024 / 1024)} MB (cap ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB)`);
      bytes = await fs.promises.readFile(abs);
      base = path.basename(abs);
      const sameDir = path.dirname(abs) === dir;
      const target = path.join(dir, `${id}-${base}`);
      if (!sameDir) {
        await fs.promises.copyFile(abs, target);
        // The copy inherits the source's mode; this one is the backend's, so
        // it is owner-only like the staging dir (best effort on Windows).
        try { fs.chmodSync(target, 0o600); } catch { /* best effort */ }
      }
      // Keep the original readable path so the model can be told where it is.
      // `owned` marks copies the backend may delete; the user's original is
      // never unlinked by dropAttachment.
      staged.set(id, { id, name: base, path: sameDir ? abs : target, source: abs, owned: !sameDir, bytes: bytes.length, mime: mimeOf(base), at: Date.now() });
      return staged.get(id);
    }
    base = path.basename(name ?? 'attachment');
    const mime = /^data:([^;,]+)[;,]/.exec(dataUrl ?? '')?.[1] ?? mimeOf(base);
    bytes = Buffer.from(String(dataUrl ?? '').split(',').at(-1) ?? '', 'base64');
    if (!bytes.length) throw new Error('empty attachment');
    if (bytes.length > MAX_ATTACHMENT_BYTES) throw new Error(`attachment too large: ${Math.round(bytes.length / 1024 / 1024)} MB (cap ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB)`);
    const file = path.join(dir, `${id}-${base}`);
    await fs.promises.writeFile(file, bytes, { mode: 0o600 });
    staged.set(id, { id, name: base, path: file, owned: true, bytes: bytes.length, mime, at: Date.now() });
    return staged.get(id);
  };

  /** Parts the bridge wants, in the order they should be sent. */
  // Async reads: an attachment can be MAX_ATTACHMENT_BYTES, and a sync read +
  // base64 of it inside the run handler freezes every window call (rule 9).
  const partsFor = async (ids = []) => Promise.all(ids.map(async (id) => {
    const item = staged.get(id);
    if (!item) throw new Error(`attachment ${id} is gone — stage it again`);
    const base64 = (await fs.promises.readFile(item.path)).toString('base64');
    if (item.mime.startsWith('image/')) return { type: 'image_url', image_url: { url: `data:${item.mime};base64,${base64}` } };
    return { type: 'file', file: { file_data: `data:${item.mime};base64,${base64}`, filename: item.name } };
  }));

  const dropAttachment = (id) => {
    const item = staged.get(id);
    // Only copies owned by the backend are unlinked; a sameDir stage points
    // at the user's original file, and deleting it would eat their data.
    if (item?.owned) fs.rmSync(item.path, { force: true });
    staged.delete(id);
  };

  /* ---------------------------------------------------- plugins & mcp helpers */

  // The manager's view plus what the installer's registry remembers. Every
  // plugin call that answers with details answers with this one shape — list,
  // reload, install, remove and enable all end here, so the window never has
  // to reconcile two versions of "installed". `known` and `registry` are what
  // let the sheet show a disabled-but-installed plugin as a row with a switch
  // instead of a name that silently vanished.
  const decoratedPlugins = () => {
    const registry = readRegistry(plugins.defaultDir);
    const details = decorateDetails(plugins.details(), registry);
    return { ...details, registry: registry.plugins, known: knownNames(details, registry) };
  };

  const mcpListing = () => ({ servers: current.mcp.status(), tools: current.mcp.toolTable() });

  // The enabled-list rules live in install.mjs as one pure function; this is
  // just the write + reload around it.
  const pluginSetEnabled = async (name, enabled) => {
    if (!name) throw new Error('name is required');
    const names = knownNames(plugins.details(), readRegistry(plugins.defaultDir));
    const list = appSettings.get('plugins');
    if (!names.includes(name) && !(Array.isArray(list) && list.includes(name))) {
      throw new Error(`no plugin named ${name} — see plugins.list for what is installed`);
    }
    const next = materializeEnabledList(list, names, name, enabled);
    appSettings.set({ plugins: next });
    await plugins.load();
    const details = decoratedPlugins();
    emit('plugins', details);
    return { plugins: next, details };
  };

  const mcpSetEnabled = async (params, enabled) => {
    setServerEnabled(params.name, enabled, { home: aipassHome(), root: current.root, scope: params.scope ?? null });
    await current.mcp.reload();
    return mcpListing();
  };

  /* -------------------------------------------------------------------- methods */

  const methods = {
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
        // Bridge-side cache counters (models/quota/conversation): what rode a
        // cache instead of the tab. Null from a bridge too old to count them —
        // the window's /status omits the line then.
        cache: st?.cache ?? null,
        // The build behind this backend: the window shows it (and warns when
        // the packaged shell is older than the repo it was built from), so a
        // stale install reads as a version instead of a mystery.
        app: APP_VERSION ?? null,
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
      const status = await methods.status(params);
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

    async models(params = {}) { return targetFor(params).bridge.models(true); },
    // Forced by default — a caller that asks for credits wants a number, not
    // a cache — but the window passes force:false while idle so the
    // extension's tab is not poked upstream every 10 seconds forever.
    async credits(params = {}) { return targetFor(params).bridge.quota(params.force !== false); },
    async conversations(params = {}) { return targetFor(params).bridge.conversations(); },

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
      await current.bridge.config(Object.fromEntries(Object.entries(params).filter(([k]) => ['model', 'assistant', 'aspectRatio', 'conversation'].includes(k))));
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
      const list = await methods['providers.list']();
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
        const st = await current.bridge.status().catch(() => null);
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

    /* --------------------------------------------------------------- mcp tools */

    async 'mcp.list'(params = {}) {
      await targetFor(params).mcp.ensureLoaded();
      return mcpListing();
    },
    async 'mcp.reload'(params = {}) {
      await targetFor(params).mcp.reload();
      return mcpListing();
    },
    async 'mcp.add'(params = {}) {
      const h = targetFor(params);
      const server = addServer(params, { home: aipassHome(), root: h.root });
      await h.mcp.reload();
      return { server, ...mcpListing() };
    },
    async 'mcp.remove'(params = {}) {
      const h = targetFor(params);
      const out = removeServer(params.name, { home: aipassHome(), root: h.root, scope: params.scope ?? null });
      await h.mcp.reload();
      return { ...out, ...mcpListing() };
    },
    async 'mcp.enable'(params = {}) { return mcpSetEnabled(params, true); },
    async 'mcp.disable'(params = {}) { return mcpSetEnabled(params, false); },
    /**
     * Try a definition that may not be saved yet (a form's "test" button), or
     * a name that is (the card's). A saved name resolves through the config,
     * so the test runs exactly what is on disk — project override included.
     */
    async 'mcp.test'(params = {}) {
      if (!params.name) return testServer(params, { root: current.root });
      const known = loadConfig(current.root).find((s) => s.name === params.name && (!params.scope || s.scope === params.scope));
      if (!known) throw new Error(`no server named ${params.name}`);
      return testServer(known, { root: current.root });
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
    async 'session.list'(params = {}) { const h = targetFor(params); return h.store.list(h.root); },
    async 'session.new'(params = {}) {
      const h = targetFor(params);
      const s = await h.startSession({ title: params.title ?? null });
      return s ? s.meta() : null;
    },
    async 'session.open'(params = {}) {
      const h = targetFor(params);
      const s = await h.startSession({ sessionId: params.id });
      if (!s) throw new Error('session not found');
      emit('session_opened', s.meta());
      return s.entries;
    },
    async 'session.entries'(params = {}) { const h = targetFor(params); return h.session?.entries ?? []; },
    async 'session.rename'(params = {}) {
      const h = targetFor(params);
      h.store.rename(params.id, params.title, { root: h.root });
      return { ok: true };
    },
    async 'session.delete'(params = {}) {
      const h = targetFor(params);
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
      const h = wanted ? harnesses.get(path.resolve(wanted)) : current;
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
      const h = params.project ? harnesses.get(path.resolve(params.project)) : current;
      return { ok: h ? h.answer(params.id, params.decision) : false };
    },
    async 'plan.answer'(params = {}) {
      const h = params.project ? harnesses.get(path.resolve(params.project)) : current;
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
    async apply(params = {}) { return targetFor(params).apply(params.files ?? null); },
    async discard(params = {}) { return { dropped: targetFor(params).discard() }; },

    /* ---------------------------------------------------------- attachments */

    async 'attachment.stage'(params = {}) {
      const h = targetFor(params);
      return stageAttachment(params, h.root);
    },
    async 'attachment.list'() { return [...staged.values()]; },
    async 'attachment.remove'(params = {}) { dropAttachment(params.id); return { ok: true }; },

    /* -------------------------------------------------------------- browser */

    async 'browser.open'(params = {}) { return { ok: await openBrowser(params.url ?? appSettings.get('chatUrl')) }; },

    /* ------------------------------------------------------------------ waf */

    /**
     * The restore table, as data.
     *
     * The window shows the real text behind the wire spellings — the URLs a
     * search brought back are `HTTPS-URL…` until somebody puts them back. It
     * must show the SAME text the model saw, so it rebuilds these rules from
     * this table instead of keeping a copy of them: one table, one owner.
     */
    async 'waf.table'() { return { pairs: restoreTable() }; },

    /* ------------------------------------------------------------- symbols */

    /**
     * The declarations of a file, the definition of a name, the places a name
     * is used.
     *
     * The same index the SYMBOLS/DEF/REFS markers use, asked for from the
     * window instead of from a run. The walk skips the heavy directories and
     * the index is cached under the state home, so a second ask is cheap.
     */
    async 'symbols.list'(params = {}) {
      const h = targetFor(params);
      const file = String(params.file ?? '').trim();
      if (!file) throw new Error('which file? — /symbols <file>');
      const rel = path.isAbsolute(file) ? path.relative(h.root, file) : file;
      // A path outside the project is not in the index, so it has no symbols —
      // the same answer the SYMBOLS marker gives, and no way out of the root.
      return { file: rel.replace(/\\/g, '/'), symbols: listSymbols(h.root, rel) };
    },
    async 'symbols.def'(params = {}) {
      const h = targetFor(params);
      const name = String(params.name ?? '').trim();
      if (!name) throw new Error('which name? — /symbols <name>');
      return { name, definitions: findDefinition(h.root, name) };
    },
    async 'symbols.refs'(params = {}) {
      const h = targetFor(params);
      const name = String(params.name ?? '').trim();
      if (!name) throw new Error('which name? — /symbols <name>');
      return { name, references: findReferences(h.root, name) };
    },

    /* -------------------------------------------------------------- skills */

    async 'skills.list'(params = {}) { return targetFor(params).skills.list(); },
    async 'skills.index'(params = {}) { return { index: targetFor(params).skills.index() }; },
    async 'skills.load'(params = {}) {
      const found = targetFor(params).skills.load(params.name);
      if (found.error) throw new Error(found.error);
      return found;
    },

    /* ------------------------------------------------------------- plugins */
    async 'plugins.list'() { return decoratedPlugins(); },
    async 'plugins.reload'() {
      await plugins.load();
      const details = decoratedPlugins();
      emit('plugins', details);
      return details;
    },
    /** Report on a source (path, folder, URL) — size and hash, nothing runs. */
    async 'plugins.inspect'(params = {}) {
      return inspectSource(params.source, { base: current?.root ?? process.cwd() });
    },
    async 'plugins.install'(params = {}) {
      const result = await installSource(params.source, {
        name: params.name ?? null,
        expectedSha256: params.expectedSha256 ?? null,
        force: Boolean(params.force),
        base: current?.root ?? process.cwd(),
        pluginsDir: plugins.defaultDir,
        installedBy: params.installedBy === 'cli' ? 'cli' : 'desktop-ui',
      });
      // A non-empty enabled-list is an exact list of what runs. Leaving the new
      // plugin out of it would install it into silence, which reads as a failed
      // install; adding it here is the same decision as enabling it.
      const list = appSettings.get('plugins');
      if (Array.isArray(list) && list.length && !list.includes(result.name)) {
        appSettings.set({ plugins: [...list.filter((n) => n !== NONE_NAME), result.name] });
      }
      const details = await finalizeInstall(result, plugins);
      const decorated = decorateDetails(details, readRegistry(plugins.defaultDir));
      emit('plugins', decorated);
      return { plugin: decorated.loaded.find((p) => p.name === result.name) ?? null, details: decorated };
    },
    async 'plugins.remove'(params = {}) {
      const out = removePlugin(params.name, { pluginsDir: plugins.defaultDir, force: Boolean(params.force) });
      // Removing a name from an explicit enabled-list keeps the list exact: a
      // name that no longer exists would otherwise be the only thing standing
      // between "these plugins" and "everything, now and later".
      const list = appSettings.get('plugins');
      if (Array.isArray(list) && list.includes(params.name)) {
        appSettings.set({ plugins: stripFromEnabled(list, params.name) });
      }
      await plugins.load();
      const details = decoratedPlugins();
      emit('plugins', details);
      return { ...out, details };
    },
    async 'plugins.enable'(params = {}) { return pluginSetEnabled(params.name, true); },
    async 'plugins.disable'(params = {}) { return pluginSetEnabled(params.name, false); },
    async 'panel.render'(params = {}) { return plugins.renderPanel(params.id); },

    /* ----------------------------------------------------------------- fs */

    async 'fs.list'(params = {}) {
      const h = targetFor(params);
      const dir = h.overlay.trySafe(params.dir ?? '.');
      if (!dir) throw new Error(`outside project root: ${params.dir ?? '.'}`);
      // A panel click on a directory with thousands of entries: the async read
      // keeps the event loop free for the run's own stream while it fills.
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });
      return entries.map((e) => ({ name: e.name, dir: e.isDirectory() }))
        .filter((e) => !['node_modules', '.git', '.next', 'dist', 'build', '.cache'].includes(e.name));
    },
    async 'fs.read'(params = {}) {
      const h = targetFor(params);
      const abs = h.overlay.trySafe(params.file);
      if (!abs) throw new Error(`outside project root: ${params.file}`);
      if (!h.overlay.existsAt(abs)) throw new Error('no such file');
      // A binary file is not text: read as UTF-8 it is mojibake, and it costs
      // a whole answer's worth of bytes on the wire. The tool layer refuses
      // the same files for the model; the window refuses them for the reader.
      const kind = binaryKind(abs, (p) => h.overlay.has(p));
      if (kind) {
        throw new Error(`${params.file} is ${kind === 'binary' ? 'a binary file' : `a ${kind} file`}, not text`);
      }
      const staged = h.overlay.has(abs);
      const size = staged
        ? Buffer.byteLength(h.overlay.readAt(abs), 'utf8')
        : (await fs.promises.stat(abs)).size;
      if (size > MAX_FILE_READ) {
        throw new Error(`${params.file} is too large to open (${Math.round(size / 1024)} KB, cap ${Math.round(MAX_FILE_READ / 1024)} KB)`);
      }
      const text = staged ? h.overlay.readAt(abs) : await fs.promises.readFile(abs, 'utf8');
      return { file: params.file, text };
    },
  };

  const server = http.createServer(async (req, res) => {
    // A malformed request target throws here, and this is the FIRST statement
    // of an async listener: the rejection escapes the handler, becomes an
    // unhandled rejection, and the process-level handler exits the backend.
    // One request — `GET //[ HTTP/1.1` — was enough to take the whole desktop
    // backend down, from any local process and from any web page (a plain
    // GET needs no preflight). The bridge answers 400 for the same input
    // (bridge/server.mjs); the backend has to answer it here too.
    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    } catch {
      return json(res, 400, { ok: false, error: 'malformed request URL' });
    }

    // Local only, for the reasons spelled out next to `isLocalRequest`. This
    // runs before any route, including the static UI files: a page that can
    // only reach this port from this machine can talk to it, and nothing else
    // can even load it.
    if (!isLocalRequest(req)) {
      return json(res, 403, { ok: false, error: 'local requests only — this port serves the machine it runs on' });
    }

    // Window bootstrap: the desktop window loads over plain navigation, so it
    // cannot present a bearer header until it holds the token. Same-origin
    // browser pages fetch it here; headerless tools read the file instead
    // (and a cross-origin page never passes isBrowserSameOrigin).
    if (url.pathname === '/token' && req.method === 'GET') {
      if (!isBrowserSameOrigin(req)) {
        return json(res, 403, { ok: false, error: 'the token bootstrap is for same-origin browser pages; tools read the token file' });
      }
      return json(res, 200, { ok: true, token: loadOrMintToken() });
    }

    if (url.pathname === '/events' && req.method === 'GET') {
      // EventSource cannot set headers, so the window rides `?token=` (minted
      // at boot via /token). Header bearers are accepted too.
      if (!authorized(req) && !authorizedQuery(url)) {
        return json(res, 401, { ok: false, error: 'unauthorized: missing or wrong loopback bearer token' });
      }
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
          if (frame.seq > since) res.write(`event: ${frame.event}\nid: ${frame.seq}\ndata: ${frame.data}\n\n`);
        }
      }
      res.write(`event: hello\ndata: ${JSON.stringify({ seq })}\n\n`);
      listeners.add(res);
      // A named frame, never a bare `: keepalive` comment: comments are
      // invisible to EventSource, so the window's watchdog (no event for 20 s
      // ⇒ run lost) fired on any long RUN or SEARCH while the backend was
      // perfectly alive. It carries no id — a reconnect's Last-Event-ID still
      // points at the last real frame.
      const ping = setInterval(() => { try { res.write('event: ping\ndata: {}\n\n'); } catch { /* closed */ } }, 15_000);
      req.on('close', () => { clearInterval(ping); listeners.delete(res); });
      return;
    }

    if (url.pathname === '/rpc' && req.method === 'POST') {
      if (!authorized(req)) {
        return json(res, 401, { ok: false, error: UNAUTHORIZED });
      }
      // Chunks collected, joined once: `body += c` re-flattens the whole body
      // on every packet — O(n²) on a big attachments upload — and can split a
      // UTF-8 sequence sitting across two chunks.
      const chunks = [];
      let size = 0;
      let answered = false;
      req.on('data', (c) => {
        size += c.length;
        if (size > maxBody) {
          // A body over the cap gets an ANSWER, not a dead socket. The old
          // code destroyed the request, so the client saw a transport error it
          // could not read — and the window's "attach" of a large file looked
          // like the app had crashed. One 20 MB attachment is ~27 MB of
          // base64, so the cap has to fit a couple of them.
          answered = true;
          json(res, 413, { ok: false, error: `request body too large (cap ${maxBody} bytes)` });
          // The socket is closed after the answer is out: the client is still
          // sending, and killing the socket now would take the answer with it.
          res.on('finish', () => req.destroy());
          req.pause();
          return;
        }
        chunks.push(c);
      });
      req.on('end', async () => {
        if (answered) return;
        let msg = {};
        try {
          msg = JSON.parse(chunks.length ? Buffer.concat(chunks).toString('utf8') : '{}');
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
        // The project the caller is on, when it named one. A window says which
        // project it is showing, so two windows open on two projects cannot
        // read each other's sessions, files or pending diffs — and one
        // window's Apply button cannot write the other window's staged edits.
        // A method that names its own project wins: the header says who is
        // asking, the parameter says what the call is about.
        const params = { ...(msg.params ?? {}) };
        if (params.project == null) {
          const scope = String(req.headers['x-aipass-project'] ?? '').trim();
          if (scope) params.project = scope;
        }
        try {
          return json(res, 200, { ok: true, result: await fn(params) });
        } catch (err) {
          // A failure that knows its step carries it: the window can say which
          // door closed (fetch, validate, swap) instead of only that something
          // did. The step is an extra field, never part of the message.
          return json(res, 200, { ok: false, error: String(err.message ?? err), ...(err.stage ? { stage: err.stage } : {}) });
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
    // The CSP rides with it: the window is a page that drives an agent that
    // writes files, and this is the only header that binds on it — the shell's
    // own declaration covers the asset protocol, which this window does not
    // use, because it is loaded from here.
    res.writeHead(200, {
      'content-type': type,
      'cache-control': 'no-cache',
      'content-security-policy': WINDOW_CSP_HEADER,
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    });
    fs.createReadStream(target).pipe(res);
  });

  // Plugins load last: they may call anything above, and they register the
  // methods the window can then use.
  plugins.load().catch((err) => process.stderr.write(`plugin load failed: ${err.message}\n`));

  // A run that cannot proceed because no chat tab is open is a one-click fix, so
  // the backend offers the click (and takes it when settings allow). This hangs
  // off the shared bus, not the boot harness: every project's harness forwards
  // its events there, so the auto-open keeps working after a project switch.
  bus.on('needs_tab', async ({ url }) => {
    if (appSettings.get('autoOpenTab') === false) return;
    const opened = await openBrowser(url);
    emit('tab_opened', { url, opened });
  });

  server.listen(port, '127.0.0.1');
  // The port the server ACTUALLY got, not the one it was asked for: port 0
  // means "any free port", and a probe-then-bind race (another suite on this
  // machine takes the port between the probe and the bind) is then impossible.
  const boundPort = () => server.address()?.port ?? port;
  return {
    server,
    harness: current,
    get current() { return current; },
    plugins,
    settings: appSettings,
    events: bus,
    get port() { return boundPort(); },
    get url() { return `http://127.0.0.1:${boundPort()}`; },
  };
}

const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
};

// Run standalone: node aipass-bridge/harness/rpc.mjs [--port 8790] [--root DIR]
const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  // Crash visibility, entry point only: tests import createRpc in-process, and
  // a handler that calls process.exit would take the test runner down with it.
  // As the desktop backend, an unrecovered throw used to end the process with
  // nothing but whatever faint line was mid-flight; one scrubbed line names it,
  // and the non-zero exit is what the desktop shell's supervisor watches.
  const fatal = (label, err) => {
    console.error(formatLogLine({ level: 'error', msg: `[fatal] ${label}: ${scrubSecrets(err?.stack ?? String(err))}` }));
    process.exit(1);
  };
  process.on('uncaughtException', (err) => fatal('uncaught exception', err));
  process.on('unhandledRejection', (reason) => fatal('unhandled rejection', reason));

  const argv = process.argv.slice(2);
  const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
  const rpc = createRpc({ port: Number(arg('port', 8790)), root: arg('root', process.cwd()) });
  // The desktop probes the port before spawning, but a race is still possible;
  // name the port instead of dying with a raw EADDRINUSE stack.
  rpc.server.on('error', (err) => fatal('backend cannot bind', err));
  process.stdout.write(`aipass desktop backend on ${rpc.url}\n`);
}
