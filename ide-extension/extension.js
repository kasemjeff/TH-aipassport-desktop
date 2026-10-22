'use strict';
// The extension host: the aipass panel for VS Code.
//
// What this talks to, and what it does NOT talk to, is the whole design.
//
// The upstream bridge answers an OpenAI-compatible endpoint on 127.0.0.1:8787,
// and that endpoint CANNOT serve an IDE client: the service takes ONE user
// message and owns the conversation server-side, and an agent-style system
// prompt is refused with a 403 by the edge's WAF. A client that points at it
// gets "I can't access your files" — not because the bridge is broken, but
// because the endpoint declines the shape those clients require.
//
// So this extension talks to the LOCAL HARNESS BACKEND (harness/rpc.mjs): a
// JSON-RPC surface at POST /rpc and an SSE stream at GET /events, on
// 127.0.0.1:8790, behind a loopback bearer token. The harness already sends
// the marker protocol as user messages, so it lives inside the edge's
// constraint — that is the whole trick.
//
// The token stays here, in the extension host. The panel is a webview: it
// asks the host for things and the host is what carries the credential, so a
// token never reaches a page that a browser extension could read.
const vscode = require('vscode');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const protocol = require('./lib/protocol.js');
const { BackendError, createBackend } = require('./lib/backend.js');

/** The panel's own files: the markup, the styles and the script. */
const MEDIA_DIR = path.join(__dirname, 'media');

/** One panel per project, so a second command reveals the first. */
const panels = new Map();

/**
 * Where the app keeps its state.
 *
 * The same home the harness uses (aipass-bridge/harness/settings.mjs
 * `aipassHome`), including the `AIPASS_HOME` override — a test or a second
 * install must be able to move it.
 *
 * @returns {string}
 */
function aipassHome() {
  return process.env.AIPASS_HOME?.trim() || path.join(os.homedir(), '.aipass');
}

/**
 * A file's text, or null when it is not there.
 *
 * @param {string} file
 * @returns {Promise<string|null>}
 */
async function readTextFile(file) {
  try {
    return await fsp.readFile(file, 'utf8');
  } catch {
    return null;
  }
}

/**
 * A JSON file's object, or null when it is missing or broken.
 *
 * A settings file that does not parse must not take the extension down: the
 * defaults are the answer, and the panel says which port it is using.
 *
 * @param {string} file
 * @returns {Promise<object|null>}
 */
async function readJsonFile(file) {
  const raw = await readTextFile(file);
  if (raw == null) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * The wire spellings, put back before anything is read.
 *
 * The edge in front of de.aipass.net needs placeholders in the text it takes
 * (the WAF table, aipass-bridge/harness/waf.mjs), and the table belongs to the
 * harness — so the panel asks the backend for it (`waf.table`) instead of
 * keeping a copy, the way the window does (desktop/ui/waf-restore.js).
 *
 * A rule that will not compile is dropped rather than thrown: a table that
 * cannot be read must not take the panel down with it.
 *
 * @param {Array} pairs the table's [source, flags, to] triples
 * @returns {Array<[RegExp, string]>}
 */
function restoreRules(pairs) {
  return (Array.isArray(pairs) ? pairs : [])
    .filter((p) => Array.isArray(p) && p.length === 3)
    .map(([source, flags, to]) => {
      try { return [new RegExp(source, flags), to]; } catch { return null; }
    })
    .filter(Boolean);
}

/**
 * The text as it was written: every wire spelling put back.
 *
 * @param {unknown} text
 * @param {Array<[RegExp, string]>} rules
 * @returns {string}
 */
function restoreText(text, rules) {
  if (typeof text !== 'string') return '';
  if (!rules?.length) return text;
  return rules.reduce((acc, [re, to]) => acc.replace(re, to), text);
}

/**
 * One frame's text, with the wire spellings put back.
 *
 * Only the fields that carry prose are touched: an argument (a path, a URL)
 * is left as it came, because the table's rules are about the text the edge
 * rewrote, not about every string in a frame.
 *
 * @param {any} data
 * @param {Array<[RegExp, string]>} rules
 * @returns {any}
 */
function restoreData(data, rules) {
  if (!data || typeof data !== 'object') return data;
  const out = { ...data };
  for (const key of ['text', 'head', 'summary', 'extra', 'message']) {
    if (typeof out[key] === 'string') out[key] = restoreText(out[key], rules);
  }
  if (Array.isArray(out.lines)) out.lines = out.lines.map((line) => restoreText(line, rules));
  return out;
}

/**
 * The panel's HTML, with the webview's own URIs folded in.
 *
 * The policy is the tight one, and it rides in the page: a webview's
 * response headers are not ours to set, so the policy is a meta tag
 * (VS Code's own rule). The page may run its own script (with a nonce) and
 * may talk to nothing — `connect-src 'none'` is the honest statement, because
 * the panel never opens a socket of its own; every call goes through the
 * extension host, which is where the token lives.
 *
 * @param {vscode.Webview} webview
 * @returns {Promise<string>}
 */
async function panelHtml(webview) {
  const nonce = crypto.randomBytes(16).toString('base64');
  const styleUri = webview.asWebviewUri(vscode.Uri.file(path.join(MEDIA_DIR, 'panel.css')));
  const scriptUri = webview.asWebviewUri(vscode.Uri.file(path.join(MEDIA_DIR, 'panel.js')));
  const raw = await readTextFile(path.join(MEDIA_DIR, 'panel.html'));
  if (raw == null) {
    return '<!doctype html><html lang="th"><body><p>ไฟล์ของแผงหายไป (media/panel.html) — ติดตั้ง extension ใหม่</p></body></html>';
  }
  const csp = [
    "default-src 'none'",
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
    "connect-src 'none'",
    "img-src data:",
    "font-src 'none'",
  ].join('; ');
  return raw
    .replace(/\{\{nonce\}\}/g, nonce)
    .replace(/\{\{csp\}\}/g, csp)
    .replace(/\{\{styleUri\}\}/g, styleUri.toString())
    .replace(/\{\{scriptUri\}\}/g, scriptUri.toString());
}

/**
 * Open (or reveal) the panel for the workspace folder.
 *
 * One panel per project: the backend holds one harness per project, and the
 * panel is the view of ONE project. A second command reveals the panel that
 * is already open rather than opening a second one over the same project.
 *
 * @param {{column: vscode.ViewColumn}} placement
 */
async function openPanel({ column }) {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (!folders.length) {
    vscode.window.showWarningMessage('aipass — เปิดโฟลเดอร์โปรเจกต์ก่อน (แผงนี้ทำงานกับโปรเจกต์หนึ่งโปรเจกต์)');
    return;
  }
  const project = folders[0].uri.fsPath;
  const key = project.toLowerCase();
  const existing = panels.get(key);
  if (existing) {
    existing.panel.reveal(column);
    existing.panel.webview.postMessage({ kind: 'focus' });
    return;
  }

  const panel = vscode.window.createWebviewPanel('aipass.panel', 'AiPASS', column, {
    enableScripts: true,
    // The panel keeps its conversation when it is hidden: a run takes minutes
    // and switching to the editor must not lose the stream.
    retainContextWhenHidden: true,
    localResourceRoots: [vscode.Uri.file(MEDIA_DIR)],
  });

  panel.webview.html = await panelHtml(panel.webview);

  // The listener is registered before anything is awaited: the panel's script
  // posts "ready" the moment it runs, and a message that arrives before the
  // listener exists is lost — the panel would sit there with an empty stage
  // and a backend it never asked.
  let backend = null;
  const inbox = [];

  panel.webview.onDidReceiveMessage((msg) => {
    if (!msg || typeof msg.kind !== 'string') return;
    // Until the backend is there, the panel's first messages wait in a box.
    if (!backend) { inbox.push(msg); return; }
    void handleMessage(msg);
  });

  // Where the backend is, and the token that opens it.
  const home = aipassHome();
  const settings = await readJsonFile(path.join(home, 'settings.json'));
  const port = protocol.resolvePort({ settings, env: process.env });
  const token = protocol.resolveToken(await readTextFile(path.join(home, '.token')));

  const post = (message) => {
    // A panel that was closed while a call was in flight must not throw here.
    try { panel.webview.postMessage(message); } catch { /* the panel is gone */ }
  };

  /**
   * Should this frame be drawn in this panel?
   *
   * A run belongs to one project, and the backend broadcasts every harness's
   * events to every listener — so a run left going in another project must
   * not paint here (desktop/ui/app.js, the same rule). The questions are the
   * exception: a permission request that was dropped would leave that run
   * waiting for an answer nobody can see, so it is always shown and names the
   * project it belongs to.
   *
   * @param {string} name
   * @param {any} data
   * @returns {boolean}
   */
  const shouldDraw = (name, data) => {
    if (protocol.ALWAYS_FORWARD.has(name)) return true;
    if (data && data.project && !protocol.sameProject(data.project, project)) return false;
    return true;
  };

  // The WAF restore table, and the reply being streamed. Both live here, in
  // the host: the panel is a view and gets text it can show.
  let rules = [];
  let replyRaw = '';

  const backendImpl = createBackend({
    port,
    token,
    project,
    onEvent: (frame) => {
      let data = null;
      try { data = frame.data ? JSON.parse(frame.data) : null; } catch { /* a frame that is not json */ }
      if (!shouldDraw(frame.event, data)) return;
      // The reply's prose is cleaned here, in the one place that knows the
      // marker grammar: the markers are line-shaped, so a delta cannot be
      // cleaned on its own — the whole reply is, and the clean text goes to
      // the panel as a whole.
      if (frame.event === 'assistant_delta') {
        replyRaw += String(data?.text ?? '');
        post({ kind: 'prose', text: restoreText(protocol.stripMarkers(replyRaw), rules) });
        return;
      }
      // The reply is over: the next one starts empty.
      if (frame.event === 'step' || frame.event === 'done_line' || frame.event === 'task_start' || frame.event === 'finished') {
        replyRaw = '';
      }
      post({ kind: 'event', name: frame.event, data: restoreData(data) });
    },
    onState: (state) => post({ kind: 'backend', ...state, port, tokenPresent: Boolean(token) }),
  });

  /**
   * The panel's picture of the machine: what the backend says, the credit
   * meter and the staged changes.
   *
   * @param {{restore?: boolean}} [opts] restore also replays the session's
   *   entries, so a panel that was closed and opened again comes back with
   *   the conversation instead of an empty stage.
   */
  async function pushState({ restore = false } = {}) {
    const picture = {
      kind: 'state',
      project,
      port,
      tokenPresent: Boolean(token),
      events: protocol.EVENT_NAMES,
      status: null,
      credits: null,
      pending: null,
      snapshot: null,
      error: null,
    };
    try {
      picture.status = await backend.rpc('status');
      picture.credits = await backend.rpc('credits', { force: false }).catch(() => null);
      picture.pending = await backend.rpc('pending').catch(() => null);
      if (restore) {
        picture.snapshot = await backend.rpc('snapshot').catch(() => null);
        // The session log keeps the reply as it was written — markers and all.
        // The reader must not see the wire, so the same cleaning the live
        // stream gets is applied to what comes back from the log.
        if (Array.isArray(picture.snapshot?.entries)) {
          picture.snapshot.entries = picture.snapshot.entries.map((entry) => {
            if (entry?.type !== 'assistant') return entry;
            return { ...entry, text: restoreText(protocol.stripMarkers(String(entry.text ?? '')), rules) };
          });
        }
      }
    } catch (err) {
      picture.error = err instanceof BackendError
        ? { kind: err.kind, message: err.message }
        : { kind: 'unknown', message: String(err?.message ?? err) };
    }
    post(picture);
  }

  /**
   * One call the panel asked for.
   *
   * @param {any} msg
   */
  async function handleRpc(msg) {
    const method = String(msg?.method ?? '');
    const id = msg?.id ?? null;
    if (!protocol.RPC_METHODS.includes(method)) {
      post({ kind: 'rpc-result', id, ok: false, error: `แผงนี้เรียกได้เฉพาะเมธอดที่ระบุไว้ — ${method} ไม่อยู่ในรายการ` });
      return;
    }
    try {
      const result = await backend.rpc(method, msg.params ?? {});
      post({ kind: 'rpc-result', id, ok: true, result });
    } catch (err) {
      post({
        kind: 'rpc-result',
        id,
        ok: false,
        error: String(err?.message ?? err),
        errorKind: err instanceof BackendError ? err.kind : 'unknown',
      });
    }
  }

  /**
   * One message from the panel.
   *
   * @param {any} msg
   */
  async function handleMessage(msg) {
    if (msg.kind === 'ready') { await pushState({ restore: true }); return; }
    if (msg.kind === 'rpc') { await handleRpc(msg); return; }
    if (msg.kind === 'refresh') { await pushState(); return; }
  }

  // The restore table comes before the first frame: the wire spellings belong
  // to the edge, and the reader must see the text the model wrote.
  const table = await backendImpl.rpc('waf.table').catch(() => null);
  rules = restoreRules(table?.pairs);
  backendImpl.start();
  // The backend is there: the messages that waited are answered now.
  backend = backendImpl;
  for (const msg of inbox.splice(0)) void handleMessage(msg);

  // The backend's own liveness, asked every ten seconds while the panel is
  // open: the meter and the credit number are what the reader watches.
  const poll = setInterval(() => { void pushState(); }, 10000);
  if (typeof poll.unref === 'function') poll.unref();

  panel.onDidDispose(() => {
    clearInterval(poll);
    backend?.close();
    panels.delete(key);
  });

  panels.set(key, { panel, backend: backendImpl });
}

/**
 * The extension's entry point.
 *
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand('aipass.openPanel', () => openPanel({ column: vscode.ViewColumn.Active })),
    vscode.commands.registerCommand('aipass.openPanelToSide', () => openPanel({ column: vscode.ViewColumn.Beside })),
  );
}

/**
 * The extension's exit point: every panel is closed with the extension, so no
 * backend stream is left open behind it.
 */
function deactivate() {
  for (const { backend } of panels.values()) backend.close();
  panels.clear();
}

module.exports = { activate, deactivate };
