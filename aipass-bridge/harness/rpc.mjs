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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Harness } from './harness.mjs';
import { SessionStore } from './session.mjs';
import { SkillLibrary } from './skills.mjs';
import { Settings } from './settings.mjs';
import { PluginManager } from './plugins.mjs';

// The window's static files. In the repo they live in desktop/ui; the shipped
// layout puts ui/ beside aipass-bridge instead — first that exists wins.
const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const UI_DIRS = [path.join(APP_ROOT, 'desktop', 'ui'), path.join(APP_ROOT, 'ui')];
const UI_DIR = UI_DIRS.find((dir) => fs.existsSync(dir)) ?? UI_DIRS[0];

/** Attachment kinds the bridge can carry, with the part shape each needs. */
import { MAX_ATTACHMENT_BYTES, mimeOf } from '../bridge/attachment-types.mjs';

export function createRpc({
  port = 8790,
  root = process.cwd(),
  bridgeURL = 'http://127.0.0.1:8787',
  model = null,
  store = null,
  compaction = null,
  settings = null,
  pluginsDir = null,
  rulesFile = null,
} = {}) {
  const listeners = new Set();
  const emit = (type, payload) => {
    const frame = `event: ${type}\ndata: ${JSON.stringify(payload ?? {})}\n\n`;
    for (const res of listeners) res.write(frame);
  };

  const appSettings = settings ?? new Settings();
  // `store` is a directory (tests pass a temp one); a SessionStore instance is
  // accepted too, for callers that already made one.
  const storeDir = typeof store === 'string' ? store : (store?.dir ?? path.join(os.homedir(), '.aipass', 'sessions'));
  const plugins = new PluginManager({ settings: appSettings, events: { emit }, dir: pluginsDir ?? path.join(os.homedir(), '.aipass', 'plugins') });

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
      compaction: compaction ?? appSettings.get('compaction'),
      // The window's human may be reading a diff when the question lands;
      // the run waits for their answer instead of denying after two minutes.
      permissionTimeoutMs: 0,
      rulesFile,
      options: {
        mode: appSettings.get('mode'),
        allowRun: appSettings.get('allowRun'),
        maxSteps: appSettings.get('maxSteps'),
        plan: appSettings.get('plan'),
        requirePlanApproval: appSettings.get('requirePlanApproval'),
        subagent: appSettings.get('subagent'),
        searchI: appSettings.get('searchI'),
        attach: appSettings.get('attach'),
        webScratch: appSettings.get('webScratch'),
        parallelHelpers: appSettings.get('parallelHelpers'),
      },
      skills: skillLibraryFor(abs),
    });
    h.events.on('*', (type, payload) => emit(type, { project: abs, ...payload }));
    harnesses.set(abs, h);
    return h;
  };

  const skillLibraryFor = (abs) => {
    // Order: explicit folders from settings, then the project's own library,
    // then the user's, then the ones shipped with the CLI. First match wins.
    const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'skills');
    const userDir = path.join(os.homedir(), '.aipass', 'skills');
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

  const staged = new Map(); // id → {id, name, path, bytes, mime, at}

  const stageAttachment = ({ name, dataUrl }) => {
    const id = Math.random().toString(16).slice(2, 10);
    const mime = /^data:([^;,]+)[;,]/.exec(dataUrl ?? '')?.[1] ?? mimeOf(name);
    const base64 = String(dataUrl ?? '').split(',').at(-1) ?? '';
    const bytes = Buffer.from(base64, 'base64');
    if (!bytes.length) throw new Error('empty attachment');
    if (bytes.length > MAX_ATTACHMENT_BYTES) throw new Error(`attachment too large: ${Math.round(bytes.length / 1024 / 1024)} MB (cap ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB)`);
    const dir = appSettings.uploadDir();
    const file = path.join(dir, `${id}-${path.basename(name)}`);
    fs.writeFileSync(file, bytes);
    staged.set(id, { id, name: path.basename(name), path: file, bytes: bytes.length, mime, at: Date.now() });
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
        model: st?.defaultModel ?? current.bridge.model ?? null,
        conversation: st?.conversation ?? null,
        session: current.session ? current.session.meta() : null,
        running: current.running,
        mode: current.options.mode,
        allowRun: current.options.allowRun,
        plan: current.options.plan,
        subagent: current.options.subagent,
        pending: current.pendingChanges(),
        plugins: plugins.details(),
        settings: appSettings.values,
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

    /* ------------------------------------------------------------ settings */

    async 'settings.get'() { return appSettings.values; },
    async 'settings.set'(params = {}) {
      const next = appSettings.set(params);
      // A change of mode or root is not a note in a file: it moves the live run.
      if (params.mode || params.allowRun != null) current.setPolicy({ mode: params.mode ?? null, allowRun: params.allowRun ?? null });
      if (params.defaultModel != null) current.bridge.model = params.defaultModel;
      if (params.compaction) current.compactor = Object.assign(current.compactor, params.compaction);
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
        sessions: h.store.list().slice(0, 50),
        settings: appSettings.values,
      };
    },

    /* ------------------------------------------------------------ sessions */

    async 'session.list'() { return current.store.list(); },
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
        requirePlanApproval: Boolean(params.requirePlanApproval),
        maxSteps: params.maxSteps ?? current.options.maxSteps,
        searchI: params.searchI ?? current.options.searchI,
        attach: params.attach ?? current.options.attach,
        webScratch: params.webScratch ?? current.options.webScratch,
        parallelHelpers: params.parallelHelpers ?? current.options.parallelHelpers,
        parts: partsFor(params.attachments ?? []),
        pluginTools: plugins.toolTable(),
      });
      if (params.model) current.bridge.model = params.model;
      if (!current.session) await current.startSession({ title: params.title ?? null });
      const result = await current.run(params.task, { runPluginTool: (marker, args) => plugins.runTool(marker, args) });
      return {
        summary: result.summary,
        stopReason: result.stopReason,
        steps: result.steps,
        spent: result.spent,
        pending: current.pendingChanges(),
      };
    },

    cancel() { current.cancel(); return { ok: true }; },

    /* -------------------------------------------------------- permissions */

    async 'permission.answer'(params = {}) { return { ok: current.answer(params.id, params.decision) }; },
    async 'plan.answer'(params = {}) { current.answerPlan(Boolean(params.ok)); return { ok: true }; },

    /* -------------------------------------------------------------- diffs */

    async pending() { return current.pendingChanges(); },
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
      if (!dir) throw new Error('path escapes root');
      return fs.readdirSync(dir, { withFileTypes: true }).map((e) => ({ name: e.name, dir: e.isDirectory() }))
        .filter((e) => !['node_modules', '.git', '.next', 'dist', 'build', '.cache'].includes(e.name));
    },
    async 'fs.read'(params = {}) {
      const abs = current.overlay.trySafe(params.file);
      if (!abs) throw new Error('path escapes root');
      if (!current.overlay.existsAt(abs)) throw new Error('no such file');
      return { file: params.file, text: current.overlay.readAt(abs) };
    },
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname === '/events' && req.method === 'GET') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.write('event: hello\ndata: {}\n\n');
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
        try { msg = JSON.parse(body || '{}'); } catch { /* handled below */ }

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
    const file = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
    const target = path.join(UI_DIR, path.normalize(file));
    if (!target.startsWith(UI_DIR) || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
      return json(res, 404, { ok: false, error: 'not found' });
    }
    const type = target.endsWith('.html') ? 'text/html; charset=utf-8'
      : target.endsWith('.css') ? 'text/css; charset=utf-8'
        : target.endsWith('.js') ? 'text/javascript; charset=utf-8'
          : 'application/octet-stream';
    res.writeHead(200, { 'content-type': type });
    fs.createReadStream(target).pipe(res);
  });

  // Plugins load last: they may call anything above, and they register the
  // methods the window can then use.
  plugins.load().catch((err) => process.stderr.write(`plugin load failed: ${err.message}\n`));

  server.listen(port, '127.0.0.1');
  return { server, harness: current, get current() { return current; }, plugins, settings: appSettings, events: { emit }, port, url: `http://127.0.0.1:${port}` };
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
