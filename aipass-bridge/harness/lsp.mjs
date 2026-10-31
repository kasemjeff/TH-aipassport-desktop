// Language servers, the machine's own.
//
// A regex cannot say whether a file type-checks, and a wrong definition
// sends the model to the wrong file with confidence. The machine already has
// the servers (tsserver, pyright, gopls, rust-analyzer) — this module asks
// them. It is a deep module: the tools learn `diagnostics(path)` and nothing
// about LSP framing, server lifecycle, or caching.
//
// The seam is the server adapter: a built-in (resolved from PATH) or a
// home-approved command from ~/.aipass/lsp.json. A project-declared server
// is a repository-started program, so the MCP rule applies — only a
// home-approved one runs.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { aipassHome } from './settings.mjs';

const QUIET_MS = 300;
const HARD_TIMEOUT_MS = 5000;

// Built-in server map by extension. Only commands that are real LSP servers
// (not tsserver, which speaks a different protocol). Home config can add more.
const BUILTIN = {
  '.rs': { command: 'rust-analyzer', args: [] },
};

// Home config: ~/.aipass/lsp.json  { servers: { ".ts": { command, args, approved } } }
function loadHomeConfig(home) {
  try {
    const raw = fs.readFileSync(path.join(home, 'lsp.json'), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function serverSpecFor(ext, home) {
  const cfg = loadHomeConfig(home);
  const fromHome = cfg?.servers?.[ext];
  if (fromHome && fromHome.command) {
    // project-declared commands require home approval (MCP rule)
    if (fromHome.approved !== true) return { kind: 'unapproved', command: fromHome.command };
    return { kind: 'home', command: fromHome.command, args: Array.isArray(fromHome.args) ? fromHome.args : [] };
  }
  const builtin = BUILTIN[ext];
  if (builtin) return { kind: 'builtin', command: builtin.command, args: [...builtin.args] };
  return null;
}

// --- LSP JSON-RPC framing over stdio ---

class LspClient {
  constructor(child) {
    this.child = child;
    this.nextId = 1;
    this.pending = new Map();
    this.notifiers = new Map();
    this.buffer = Buffer.alloc(0);
    this.alive = true;
    child.stdout.on('data', (chunk) => this._onData(chunk));
    child.on('exit', () => { this.alive = false; });
    child.on('error', () => { this.alive = false; });
  }

  _onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;
      const header = this.buffer.slice(0, headerEnd).toString('utf8');
      const m = /Content-Length:\s*(\d+)/i.exec(header);
      if (!m) { this.buffer = this.buffer.slice(headerEnd + 4); continue; }
      const len = Number(m[1]);
      const bodyStart = headerEnd + 4;
      if (this.buffer.length < bodyStart + len) return;
      const body = this.buffer.slice(bodyStart, bodyStart + len).toString('utf8');
      this.buffer = this.buffer.slice(bodyStart + len);
      let msg;
      try { msg = JSON.parse(body); } catch { continue; }
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        resolve(msg);
      } else if (msg.method) {
        const handlers = this.notifiers.get(msg.method) || [];
        for (const h of handlers) h(msg.params);
      }
    }
  }

  request(method, params, timeoutMs = HARD_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      if (!this.alive) return reject(new Error('server is not running'));
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout waiting for ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (msg) => { clearTimeout(timer); resolve(msg); },
      });
      this._send({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method, params) {
    if (!this.alive) return;
    this._send({ jsonrpc: '2.0', method, params });
  }

  onNotification(method, handler) {
    if (!this.notifiers.has(method)) this.notifiers.set(method, []);
    this.notifiers.get(method).push(handler);
  }

  _send(msg) {
    const body = JSON.stringify(msg);
    const header = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n`;
    try { this.child.stdin.write(header + body); } catch { this.alive = false; }
  }

  async close() {
    if (!this.alive) return;
    try { await this.request('shutdown', null, 2000); } catch { /* gone */ }
    try { this.notify('exit', null); } catch { /* gone */ }
    try { this.child.kill(); } catch { /* gone */ }
    this.alive = false;
  }
}

/** Create the language-server pool for one run. */
export function createLanguageServers({ root, home = aipassHome(), log = () => {}, signal = null } = {}) {
  const servers = new Map(); // ext -> { client, spec, dead, diagnostics: Map<uri, items> }
  let closed = false;

  async function ensureServer(ext) {
    if (servers.has(ext)) {
      const s = servers.get(ext);
      if (s.dead) return null;
      return s;
    }
    const spec = serverSpecFor(ext, home);
    if (!spec) return null;
    if (spec.kind === 'unapproved') {
      const s = { ext, spec, dead: true, unapproved: true, client: null, diagnostics: new Map(), waiters: new Map() };
      servers.set(ext, s);
      return s;
    }
    // spawn
    let child;
    try {
      child = spawn(spec.command, spec.args, { cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      const s = { ext, spec, dead: true, error: err?.message, client: null, diagnostics: new Map(), waiters: new Map() };
      servers.set(ext, s);
      return s;
    }
    const client = new LspClient(child);
    const s = { ext, spec, dead: false, client, diagnostics: new Map(), waiters: new Map() };
    servers.set(ext, s);

    // collect diagnostics
    client.onNotification('textDocument/publishDiagnostics', (params) => {
      const uri = params?.uri;
      const items = Array.isArray(params?.diagnostics) ? params.diagnostics : [];
      if (!uri) return;
      s.diagnostics.set(uri, items);
      const w = s.waiters.get(uri);
      if (w) { w.resolve(items); s.waiters.delete(uri); }
    });

    // initialize
    try {
      await client.request('initialize', {
        processId: process.pid,
        rootUri: `file://${root.replace(/\\/g, '/')}`,
        capabilities: { textDocument: { publishDiagnostics: { relatedInformation: true } } },
      });
      client.notify('initialized', {});
    } catch (err) {
      s.dead = true;
      s.error = err?.message;
      try { child.kill(); } catch { /* gone */ }
    }
    return s;
  }

  async function diagnosticsFor(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const s = await ensureServer(ext);
    if (!s) return { none: `no server for ${ext || 'this file type'}` };
    if (s.unapproved) return { none: `server for ${ext} is not home-approved — add it to ~/.aipass/lsp.json with approved: true` };
    if (s.dead) return { none: `the ${s.spec.command} server is not available${s.error ? ` (${s.error})` : ''}` };
    if (closed) return { none: 'language servers are closed' };

    const abs = path.resolve(root, filePath);
    const uri = `file://${abs.replace(/\\/g, '/')}`;
    let text;
    try { text = fs.readFileSync(abs, 'utf8'); } catch (err) {
      return { none: `could not read ${filePath}: ${err?.message}` };
    }

    // open / change
    try {
      s.client.notify('textDocument/didOpen', {
        textDocument: { uri, languageId: ext.slice(1) || 'plaintext', version: 1, text },
      });
    } catch { /* ignore */ }

    // wait for diagnostics
    const items = await new Promise((resolve) => {
      // if already cached for this uri with same content, resolve quickly
      const timer = setTimeout(() => {
        s.waiters.delete(uri);
        resolve(s.diagnostics.get(uri) || []);
      }, HARD_TIMEOUT_MS);
      s.waiters.set(uri, {
        resolve: (its) => { clearTimeout(timer); resolve(its); },
      });
      // also poll in case publishDiagnostics already arrived
      if (s.diagnostics.has(uri)) {
        const w = s.waiters.get(uri);
        if (w) { s.waiters.delete(uri); clearTimeout(timer); resolve(s.diagnostics.get(uri)); }
      }
    });

    const mapped = (items || []).map((d) => ({
      file: filePath,
      line: (d.range?.start?.line ?? 0) + 1,
      col: (d.range?.start?.character ?? 0) + 1,
      severity: d.severity === 1 ? 'error' : d.severity === 2 ? 'warning' : d.severity === 3 ? 'info' : 'hint',
      source: d.source || s.spec.command,
      message: String(d.message ?? ''),
    }));
    return { server: s.spec.command, items: mapped };
  }

  async function close() {
    if (closed) return;
    closed = true;
    for (const s of servers.values()) {
      if (s.client) {
        try { await s.client.close(); } catch { /* gone */ }
      }
    }
    servers.clear();
  }

  if (signal) {
    const onAbort = () => { void close(); };
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  return {
    diagnostics: diagnosticsFor,
    close,
  };
}
