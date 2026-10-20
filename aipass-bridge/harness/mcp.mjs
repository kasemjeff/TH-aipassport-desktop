// mcp.mjs — a minimal Model Context Protocol (MCP) client, its config, and the
// functions that edit that config.
//
// MCP lets an external process expose tools to the model over JSON-RPC. This
// client speaks the stdio transport (the common one): it spawns the server,
// does the initialize handshake, lists its tools, and calls them. HTTP/SSE
// transport is deliberately not implemented — the stdio path covers the
// overwhelming majority of published servers.
//
// Config lives in two layers, and the project's line wins per name:
//   ~/.aipass/mcp.json            scope "home"    — every project
//   <project>/.aipass/mcp.json    scope "project" — this project only
//
//   { "servers": [ { "name": "fs", "command": "npx",
//                    "args": ["-y","@modelcontextprotocol/server-filesystem","."],
//                    "env": {}, "enabled": true, "risk": "write",
//                    "cwd": null } ] }
//
//   enabled: false   configured but not started — the switch between deleting
//                    a working configuration and turning it off lives here.
//   risk             the permission weight of this server's tools. 'write'
//                    unless the server is known read-only: an MCP tool is
//                    someone else's program on this machine, and trusting it by
//                    default is how a fetch tool becomes a write tool without
//                    anyone deciding that. 'write' means the gate asks in the
//                    modes where writes are asked about; 'read' means never.
//   cwd              the directory the server is spawned in, resolved against
//                    the project root. Servers that read *relative* paths
//                    default to the current process's cwd, which is not what
//                    "this project's filesystem server" should mean.
//
// Two rules the code keeps:
//   - A server that fails to start, exits or times out is skipped and named in
//     the status — never fatal. One broken server may not take the harness down.
//   - Every spawn hides its console window (windowsHide): the window is the
//     point of the desktop app, and a server opening its own is a bug report.
//
// Nothing here blocks: reading the config is small synchronous I/O at load
// time (like settings.json), and everything that spawns or waits is async.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { aipassHome } from './settings.mjs';

const INIT_TIMEOUT = 15000;
const CALL_TIMEOUT = 60000;
const TEST_TIMEOUT = 10000;

/** The two layers, in resolution order: later wins. */
export function configPaths(root) {
  const home = aipassHome();
  const out = [{ file: path.join(home, 'mcp.json'), scope: 'home' }];
  if (root) out.push({ file: path.join(root, '.aipass', 'mcp.json'), scope: 'project' });
  return out;
}

/** One server definition, normalized — or null when it is too broken to name. */
function normalizeServer(raw, scope, file) {
  const name = typeof raw?.name === 'string' ? raw.name.trim() : '';
  const command = typeof raw?.command === 'string' ? raw.command.trim() : '';
  if (!name || !command) return null;
  const env = {};
  if (raw.env && typeof raw.env === 'object' && !Array.isArray(raw.env)) {
    for (const [k, v] of Object.entries(raw.env)) if (typeof v === 'string') env[k] = v;
  }
  return {
    name,
    command,
    args: Array.isArray(raw.args) ? raw.args.map(String) : [],
    env,
    enabled: raw.enabled !== false,
    risk: raw.risk === 'read' ? 'read' : 'write',
    cwd: typeof raw.cwd === 'string' && raw.cwd.trim() ? raw.cwd.trim() : null,
    scope,
    file,
  };
}

/**
 * Every configured server, project names overriding home ones. The override is
 * whole-entry: a project does not get to inherit half of a home definition and
 * replace the other half, because "which command is actually running" would
 * stop being a question with one answer.
 */
export function loadConfig(root) {
  const byName = new Map();
  for (const { file, scope } of configPaths(root)) {
    let data = null;
    try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* missing or malformed: skip */ }
    if (!data || !Array.isArray(data.servers)) continue;
    for (const raw of data.servers) {
      const server = normalizeServer(raw, scope, file);
      if (server) byName.set(server.name, server);
    }
  }
  return [...byName.values()];
}

export function serverNameProblem(name) {
  const s = String(name ?? '').trim();
  if (!s) return 'the name is empty';
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(s)) return `"${s}" is not a usable name — lowercase letters, digits, dash, underscore; start alphanumeric`;
  return null;
}

/** The file one scope writes to — and the refusal when the scope has no home. */
export function configFileFor(scope, { home = aipassHome(), root = null } = {}) {
  if (scope === 'project') {
    if (!root) throw new Error('this project has no folder on disk — a project-scoped server needs one');
    return path.join(root, '.aipass', 'mcp.json');
  }
  return path.join(home, 'mcp.json');
}

/** A config file as an object with a servers array — whatever it held before. */
function readConfigFile(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (data && typeof data === 'object' && Array.isArray(data.servers)) return data;
  } catch { /* missing or malformed: start clean */ }
  return { servers: [] };
}

/** Atomic, like settings.json: a crash mid-write never leaves half a config. */
function writeConfigFile(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/**
 * Add a server to one layer. The refusals are the point: a name that cannot be
 * spoken, a missing command, a duplicate in the target file, and — for a home
 * entry a project entry would silently shadow — a name that would never run.
 */
export function addServer(input = {}, { home = aipassHome(), root = null } = {}) {
  const scope = input.scope === 'project' ? 'project' : 'home';
  const file = configFileFor(scope, { home, root });
  const name = String(input.name ?? '').trim();
  const problem = serverNameProblem(name);
  if (problem) throw new Error(problem);
  const command = String(input.command ?? '').trim();
  if (!command) throw new Error('command is required — the program that speaks MCP on stdin/stdout');

  const current = readConfigFile(file);
  if (current.servers.some((s) => s && s.name === name)) {
    throw new Error(`${name} already exists in ${file}`);
  }
  if (scope === 'home' && root) {
    const projectFile = path.join(root, '.aipass', 'mcp.json');
    if (readConfigFile(projectFile).servers.some((s) => s && s.name === name)) {
      throw new Error(`${name} is already defined for this project — a home server of that name would never run (project entries win)`);
    }
  }

  const args = Array.isArray(input.args) ? input.args.map(String) : String(input.args ?? '').split(/\s+/).filter(Boolean);
  const env = {};
  if (input.env && typeof input.env === 'object' && !Array.isArray(input.env)) {
    for (const [k, v] of Object.entries(input.env)) if (typeof v === 'string') env[k] = v;
  }
  const entry = { name, command, args };
  if (Object.keys(env).length) entry.env = env;
  if (input.enabled === false) entry.enabled = false;
  if (input.risk === 'read') entry.risk = 'read';
  if (typeof input.cwd === 'string' && input.cwd.trim()) entry.cwd = input.cwd.trim();

  current.servers.push(entry);
  writeConfigFile(file, current);
  return { ...normalizeServer(entry, scope, file) };
}

/**
 * Where a named server actually is: the project's file first (it wins), then
 * home. Editing what runs means editing the entry that runs.
 */
function editFiles(root, home) {
  const out = [];
  if (root) out.push(path.join(root, '.aipass', 'mcp.json'));
  out.push(path.join(home, 'mcp.json'));
  return out;
}

/** Remove one server. Prefers the layer that wins, so a project override is editable without touching home. */
export function removeServer(name, { home = aipassHome(), root = null, scope = null } = {}) {
  const wanted = scope ? [configFileFor(scope, { home, root })] : editFiles(root, home);
  for (const file of wanted) {
    const data = readConfigFile(file);
    const idx = data.servers.findIndex((s) => s && s.name === name);
    if (idx === -1) continue;
    data.servers.splice(idx, 1);
    writeConfigFile(file, data);
    return { removed: true, name, file };
  }
  throw new Error(`no server named ${name} in ${wanted.join(' or ')}`);
}

/** Turn a server on/off in place — the entry, and everything in it, stays. */
export function setServerEnabled(name, enabled, { home = aipassHome(), root = null, scope = null } = {}) {
  const wanted = scope ? [configFileFor(scope, { home, root })] : editFiles(root, home);
  for (const file of wanted) {
    const data = readConfigFile(file);
    const entry = data.servers.find((s) => s && s.name === name);
    if (!entry) continue;
    if (enabled) delete entry.enabled; else entry.enabled = false;
    writeConfigFile(file, data);
    return { name, enabled: Boolean(enabled), file };
  }
  throw new Error(`no server named ${name} in ${wanted.join(' or ')}`);
}

/** Where a server's cwd points, if it declares one. */
function resolveCwd(server, root) {
  if (!server.cwd) return undefined;
  return path.resolve(root ?? process.cwd(), server.cwd);
}

class StdioClient {
  constructor(server, log, { cwd = undefined, timeoutMs = INIT_TIMEOUT } = {}) {
    this.server = server;
    this.log = log || (() => {});
    this.cwd = cwd;
    this.timeoutMs = timeoutMs;
    this.proc = null;
    this.nextId = 1;
    this.pending = new Map(); // id -> {resolve, reject, timer}
    this.tools = []; // [{name, description, inputSchema}]
    this.ready = false;
    this.error = null;
  }

  async connect() {
    const env = { ...process.env, ...(this.server.env || {}) };
    this.proc = spawn(this.server.command, this.server.args || [], {
      env,
      ...(this.cwd ? { cwd: this.cwd } : {}),
      stdio: ['pipe', 'pipe', 'pipe'],
      // The desktop window is the point; a server opening its own console is
      // not. Every spawn in this repo hides it.
      windowsHide: true,
    });
    this.proc.stdout.setEncoding('utf8');
    let buf = '';
    this.proc.stdout.on('data', (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          clearTimeout(p.timer);
          if (p.signal && p.onAbort) p.signal.removeEventListener('abort', p.onAbort);
          if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
          else p.resolve(msg.result);
        }
      }
    });
    this.proc.stderr.on('data', (d) => this.log(`[mcp:${this.server.name}] ${String(d).trim()}`));
    // A command that does not exist fails asynchronously: without this listener
    // the 'error' event is unhandled and takes the whole backend down, and a
    // typo in mcp.json would stop being a named failure in the status row.
    this.proc.on('error', (e) => {
      this.ready = false;
      this.error = e.message;
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error(e.message)); }
      this.pending.clear();
    });
    // The same shape on the write side: a server that died between the spawn
    // and our first line EPIPEs, and the exit handler above already names it.
    this.proc.stdin.on('error', () => {});
    this.proc.on('exit', (code) => {
      this.ready = false;
      this.error = `exited (${code})`;
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('server exited')); }
      this.pending.clear();
    });

    // initialize
    const initResult = await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'aipass', version: '0.2.0' },
    }, this.timeoutMs);
    // notification: initialized (no response expected)
    try { this.notify('notifications/initialized', {}); } catch {}
    // tools/list
    const listResult = await this.request('tools/list', {}, this.timeoutMs);
    this.tools = (listResult && Array.isArray(listResult.tools)) ? listResult.tools : [];
    this.ready = true;
    return initResult;
  }

  request(method, params, timeout = CALL_TIMEOUT, { signal = null } = {}) {
    return new Promise((resolve, reject) => {
      if (!this.proc || this.proc.killed) { reject(new Error('server not running')); return; }
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout: ${method}`));
      }, timeout);
      // (stop) A stop ends the call: the server may keep working, but the run
      // is not waiting for an answer nobody asked for. The server itself stays
      // up — it belongs to the harness, not to this one call.
      const onAbort = () => {
        clearTimeout(timer);
        this.pending.delete(id);
        const err = new Error('the run was stopped');
        err.name = 'AbortError';
        reject(err);
      };
      if (signal) {
        if (signal.aborted) { onAbort(); return; }
        signal.addEventListener('abort', onAbort, { once: true });
      }
      this.pending.set(id, { resolve, reject, timer, onAbort, signal });
      try {
        this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      } catch (e) {
        clearTimeout(timer); this.pending.delete(id); reject(e);
      }
    });
  }

  notify(method, params) {
    if (!this.proc || this.proc.killed) return;
    this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  async callTool(name, args, { signal = null } = {}) {
    const result = await this.request('tools/call', { name, arguments: args || {} }, CALL_TIMEOUT, { signal });
    // MCP result: { content: [{type, text}], isError? }
    const parts = Array.isArray(result?.content) ? result.content : [];
    const text = parts.map((p) => (p.type === 'text' ? p.text : JSON.stringify(p))).join('\n');
    if (result?.isError) return `err: ${text || 'tool error'}`;
    return text || '(no output)';
  }

  close() {
    try { this.proc?.kill(); } catch {}
    this.ready = false;
  }
}

/**
 * Try one server definition without saving it: connect, list tools, close.
 * Returns a structured verdict (never throws for connection problems — the
 * caller is usually a form that wants to show the error, not crash on it).
 */
export async function testServer(input = {}, { root = null, log = () => {}, timeoutMs = TEST_TIMEOUT } = {}) {
  const raw = {
    name: String(input.name ?? 'test').trim() || 'test',
    command: input.command,
    args: Array.isArray(input.args) ? input.args : String(input.args ?? '').split(/\s+/).filter(Boolean),
    env: input.env,
    risk: input.risk,
    cwd: input.cwd,
  };
  const server = normalizeServer(raw, 'test', null);
  const started = Date.now();
  if (!server) return { ok: false, ms: 0, error: 'command is required — the program that speaks MCP on stdin/stdout' };
  const client = new StdioClient(server, log, { cwd: resolveCwd(server, root), timeoutMs });
  try {
    await client.connect();
    return {
      ok: true,
      ms: Date.now() - started,
      tools: client.tools.map((t) => ({ name: t.name, description: t.description || '' })),
    };
  } catch (e) {
    return { ok: false, ms: Date.now() - started, error: e.message };
  } finally {
    client.close();
  }
}

export class McpManager {
  constructor({ root = null, log = () => {} } = {}) {
    this.root = root;
    this.log = log;
    this.clients = new Map(); // name -> StdioClient
    this.loaded = false;
    this.tools = []; // [{marker, server, tool, description, inputSchema, risk}]
    this.statusRows = []; // one row per configured server, including the ones that did not connect
  }

  async ensureLoaded() {
    if (this.loaded) return;
    this.loaded = true;
    const servers = loadConfig(this.root);
    this.statusRows = servers.map((s) => ({
      name: s.name,
      scope: s.scope,
      file: s.file,
      enabled: s.enabled,
      risk: s.risk,
      command: s.command,
      args: s.args,
      cwd: s.cwd,
      envKeys: Object.keys(s.env),
      connected: false,
      error: null,
      tools: 0,
    }));
    const rowFor = new Map(this.statusRows.map((r) => [r.name, r]));
    for (const s of servers) {
      const row = rowFor.get(s.name);
      if (!s.enabled) continue;
      const client = new StdioClient(s, this.log, { cwd: resolveCwd(s, this.root) });
      try {
        await client.connect();
        this.clients.set(s.name, client);
        for (const t of client.tools) {
          const marker = `MCP__${s.name}__${t.name}`;
          this.tools.push({ marker, server: s.name, tool: t.name, description: t.description || t.name, inputSchema: t.inputSchema, risk: s.risk });
        }
        row.connected = true;
        row.tools = client.tools.length;
        this.log(`mcp: ${s.name} connected (${client.tools.length} tools)`);
      } catch (e) {
        row.error = e.message;
        this.log(`mcp: ${s.name} failed to connect: ${e.message}`);
        try { client.close(); } catch {}
      }
    }
  }

  /** One row per configured server: what it is, and how it went. */
  status() {
    return this.statusRows.map((r) => ({ ...r }));
  }

  /** The marker table handed to the protocol parser and the preamble. */
  toolTable() {
    return this.tools.map((t) => ({ marker: t.marker, takesBody: true, description: t.description, plugin: `mcp:${t.server}`, risk: t.risk }));
  }

  hasTool(marker) {
    return this.tools.some((t) => t.marker === marker);
  }

  async runTool(marker, { arg = '', body = '', signal = null } = {}) {
    const t = this.tools.find((x) => x.marker === marker);
    if (!t) return `no such mcp tool: ${marker}`;
    const client = this.clients.get(t.server);
    if (!client || !client.ready) return `err: mcp server ${t.server} not connected`;
    // Build arguments: try JSON from body/arg; otherwise single-string heuristic.
    let args = {};
    const raw = (body && body.trim()) ? body.trim() : (arg && arg.trim() ? arg.trim() : '');
    if (raw) {
      try { args = JSON.parse(raw); }
      catch {
        // single required string param heuristic
        const schema = t.inputSchema || {};
        const props = schema.properties || {};
        const keys = Object.keys(props);
        const req = schema.required || [];
        if (keys.length === 1) args = { [keys[0]]: raw };
        else if (req.length === 1) args = { [req[0]]: raw };
        else args = { input: raw };
      }
    }
    try {
      return await client.callTool(t.tool, args, { signal });
    } catch (e) {
      if (e?.name === 'AbortError') return 'err: the run was stopped before the mcp tool answered';
      return `err: ${e.message}`;
    }
  }

  /**
   * Drop every client and load again — the one path a config edit takes to the
   * running harness, whether the edit came from the window or a file on disk.
   */
  async reload() {
    this.close();
    this.loaded = false;
    this.tools = [];
    this.statusRows = [];
    await this.ensureLoaded();
    return this.status();
  }

  close() {
    for (const c of this.clients.values()) try { c.close(); } catch {}
    this.clients.clear();
    this.loaded = false;
  }
}

export default McpManager;
