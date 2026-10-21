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
// The methods of the backend, one module per domain. They share one context:
// the harnesses, the settings, the plugins — everything a handler may touch.
import { createCoreMethods } from './rpc/core.mjs';
import { createSettingsMethods } from './rpc/settings.mjs';
import { createSessionMethods } from './rpc/session.mjs';
import { createFilesMethods } from './rpc/files.mjs';
import { createPluginMethods } from './rpc/plugins.mjs';
import { createUpdateMethods } from './rpc/update.mjs';
import { SessionStore } from './session.mjs';
import { SKIP, posix } from './overlay.mjs';
// The permission rules own the name of a secret file: the file index skips
// those, so a search never offers a .env or a key file as a result.
import { secretHit } from './permissions.mjs';
import { SkillLibrary, skillDirsFor } from './skills.mjs';
import { Settings, aipassHome } from './settings.mjs';
import { PluginManager } from './plugins.mjs';
import {
  readRegistry, decorateDetails, materializeEnabledList, knownNames,
} from './install.mjs';
// The MCP switch: turning a server on or off is a config edit and a reload,
// and both belong to the manager that owns the clients.
import { setServerEnabled } from './mcp.mjs';
import { Emitter } from './events.mjs';
// The provider registry: which provider the runs talk to, where it lives and
// where its key comes from. The specs and the keys are two files, and neither
// of them is settings.json.
import { ProviderStore, AIPASS_PROVIDER } from './providers.mjs';
import { clientFor } from './provider-client.mjs';
import { openBrowser } from './browser.mjs';
// One resolver for "where the bridge is", shared with the harness's own client
// and with desktop/main.mjs's probe: an explicit bridgeURL wins, otherwise
// AIPASS_BRIDGE decides, otherwise the loopback default.
import { resolveBridgeURL } from './bridge.mjs';


import { loadOrMintToken, authorized, authorizedQuery, UNAUTHORIZED } from './authtoken.mjs';
import { loadGitignore } from './gitignore.mjs';


import { openLogFile } from './log-file.mjs';
import { formatLogLine } from './log-line.mjs';

import { scrubSecrets } from '../bridge/log-scrub.mjs';
// The update service: the backend is the side that talks to the network,
// because the window's policy allows the loopback and nothing else, and
// because the keyring is the backend's business anyway.
import { check as checkForUpdate } from './update.mjs';


// The exit code that means "the port was taken". A busy port is not a crash:
// it is a fact about the machine, and the shell has to be able to tell it
// apart from a backend that broke, because the two need opposite answers.
// One of ours is already answering there → adopt it. Something else is
// holding it → restarting cannot fix that, and a loop that cannot win is
// what made the app look broken.
const PORT_BUSY_EXIT = 43;


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
 * The file under `uiDir` a request path maps to, or null when it would leave
 * ui/. The containment check has to be path.relative, not a string prefix:
 * `target.startsWith(uiDir)` also matches a sibling directory whose name
 * merely begins with ui's — a `ui-x` beside `ui` survives it the moment a
 * request carries a `..` that survives URL normalisation. path.relative is
 * the real boundary, and on Windows it compares the prefix case-insensitively,
 * which is what that filesystem deserves.
 */
export function staticFileFor(uiDir, pathname) {
  // A name that needs percent-encoding on the wire ("my file.js") is the
  // decoded name on disk. A malformed escape is not a name at all, so it
  // falls back to the raw path and the containment check below refuses it
  // like any other path that tries to leave ui/.
  let name = String(pathname);
  try { name = decodeURIComponent(name); } catch { /* not a decodable path */ }
  const file = name === '/' ? 'index.html' : name.replace(/^\/+/, '');
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
      // The notes a client raises — a 429 wait, the pace between sends — are
      // the harness's own events, and the window shows them. So they are wired
      // to an emitter WHEN THERE IS ONE: a client built before its harness
      // exists gets no note handler at all, and the harness wires it to its
      // own emitter (Harness.#wireNotes). A handler bound to a missing
      // emitter would swallow every note instead: a run waiting out a rate
      // limit looks exactly like a stuck one.
      ...(events ? {
        onNote: (text) => events.emit('firewall_note', { text }),
        onStreamNote: (text) => events.emit('note', { text }),
      } : {}),
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
   *
   * `force` is for the one case that is not a settings save: the provider's
   * SPEC changed (a new endpoint, a new model list), so the client that
   * answers for the old spec is the wrong client and has to go.
   */
  const applyProviderTo = (h, providerId = activeProviderId(), { force = false } = {}) => {
    if (!providers.get(providerId)) return;
    // The same provider: the client stays, and so does everything it owns —
    // a provider client keeps the conversation history, and a settings save
    // must not drop it.
    if (!force && h.providerId === providerId && h.bridge) return;
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
    // The file is read again first: the promise above is that a change made
    // by a side door is in force, and a harness that kept yesterday's copy
    // would keep running yesterday's temperature, budgets and path rules
    // while every window shows the new ones. One small file, once per run.
    appSettings.reload();
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

  // The MCP listing belongs to the project the call is about: two windows on
  // two projects must not read each other's servers, and the sheet's
  // enable/disable must not write the other project's config.
  const mcpListing = (h) => ({ servers: h.mcp.status(), tools: h.mcp.toolTable() });

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
    // The harness the call is about, not the one the backend happens to be on.
    const h = targetFor(params);
    setServerEnabled(params.name, enabled, { home: aipassHome(), root: h.root, scope: params.scope ?? null });
    await h.mcp.reload();
    return mcpListing(h);
  };

  /* -------------------------------------------------------------------- methods */

  /**
   * What is out there.
   *
   * The root is this backend's own root, so the content version it compares
   * against is the one that is actually running — the bundle's, or the
   * overlay's when a content update has been applied.
   */
  const checkForUpdates = (options = {}) => checkForUpdate({
    home: aipassHome(),
    root: APP_ROOT,
    shellVersion: process.env.AIPASS_SHELL_VERSION ?? null,
    ...options,
  });

  /* ---------------------------------------------------------------- the index */

  /**
   * Every path of a project, kept for a minute.
   *
   * "Find the file" is asked on every keystroke, and walking the tree again
   * for each letter is how a search comes to feel slow. The index is built
   * once, filtered in memory, and dropped when it goes stale — a minute is
   * short enough that a file written a moment ago is still found.
   *
   * The rules are the ones the tools already walk by: the skipped folders
   * (build output, dependency trees), .gitignore, the secret files, and the
   * links that point out of the project. A file the model may not read is a
   * file the window may not offer either.
   */
  const indexes = new Map(); // base → { at, entries }
  const INDEX_TTL = 60_000;

  /** Forget the index of a project: its tree just changed under us. */
  const dropIndex = (base) => indexes.delete(base);

  async function fileIndex(h, base) {
    const hit = indexes.get(base);
    const now = Date.now();
    if (hit && now - hit.at < INDEX_TTL) return hit.entries;
    const ign = loadGitignore(h.root);
    const entries = [];
    const walk = async (dir) => {
      let list;
      try { list = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of list) {
        if (SKIP.has(e.name)) continue;
        const full = path.join(dir, e.name);
        const rel = posix(path.relative(base, full));
        if (e.isDirectory()) {
          if (ign.ignored(rel, true)) continue;
          entries.push({ path: rel, name: e.name, dir: true });
          await walk(full);
          continue;
        }
        if (ign.ignored(rel, false)) continue;
        if (secretHit(rel)) continue; // a secret file is not a search result
        // A link is not a file of this project: it can point anywhere.
        if (e.isSymbolicLink() && !h.overlay.trySafe(full)) continue;
        let size = 0;
        let mtime = 0;
        try {
          const st = await fs.promises.lstat(full);
          size = st.size;
          mtime = st.mtimeMs;
        } catch { /* gone between the readdir and the stat */ }
        entries.push({ path: rel, name: e.name, dir: false, size, mtime });
      }
    };
    await walk(base);
    indexes.set(base, { at: now, entries });
    return entries;
  }

  // One context for the domain modules: the state they share, written down.
  // `current` is a getter because the person may switch the project under a
  // live backend, and `methods` is a getter because the domains call each
  // other (a provider switch answers with the provider list).
  const ctx = {
    appSettings, providers, plugins, harnesses, runSessions, staged,
    targetFor, switchProject, applySettingsTo, applyProviderTo,
    activeProviderId, modelFor, clientForProvider, skillLibraryFor,
    decoratedPlugins, pluginSetEnabled, mcpListing, mcpSetEnabled,
    stageAttachment, dropAttachment, partsFor, dropIndex, fileIndex,
    checkForUpdates, emit,
    bridgeURL, root, model, APP_ROOT,
    get current() { return current; },
    get methods() { return methods; },
  };

  const methods = {
    ...createCoreMethods(ctx),
    ...createSettingsMethods(ctx),
    ...createSessionMethods(ctx),
    ...createFilesMethods(ctx),
    ...createPluginMethods(ctx),
    ...createUpdateMethods(ctx),
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
    // A file that is not there is a 404, never a crash. The content update
    // replaces the tree under the running backend, and a window that reloads
    // in that window must get a page it can read — not take the whole backend
    // down with it. `existsSync` and `statSync` are two syscalls, so the file
    // can also vanish between the two.
    let stat = null;
    if (target) { try { stat = fs.statSync(target); } catch { stat = null; } }
    if (!stat?.isFile()) {
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
    // The stream can still fail after the stat: the file may be gone by the
    // time it is opened, and a stream with no error handler ends the process
    // (an uncaught exception takes this backend down for every window).
    const stream = fs.createReadStream(target);
    stream.on('error', () => { try { res.destroy(); } catch { /* the socket is already gone */ } });
    stream.pipe(res);
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
  const port = Number(arg('port', 8790));
  const rpc = createRpc({ port, root: arg('root', process.cwd()) });
  // The desktop probes the port before spawning, but a race is still possible;
  // name the port instead of dying with a raw EADDRINUSE stack. And a busy
  // port gets its OWN exit code: it is a fact about the machine, not a crash,
  // and the shell answers the two differently.
  rpc.server.on('error', (err) => {
    if (err?.code === 'EADDRINUSE') {
      console.error(formatLogLine({
        level: 'error',
        msg: `[busy] port ${port} is already in use — another aipass backend is answering there, or something else holds it`,
      }));
      process.exit(PORT_BUSY_EXIT);
    }
    fatal('backend cannot bind', err);
  });
  // The line that says the backend is up is printed when the bind SUCCEEDS.
  // Printing it right after `listen()` was a lie on a busy port: the log said
  // "aipass desktop backend on 8790" and then, a line later, the same port
  // was refused — so the log claimed a backend that was not there.
  rpc.server.on('listening', () => {
    process.stdout.write(`aipass desktop backend on ${rpc.url}\n`);
  });
}
