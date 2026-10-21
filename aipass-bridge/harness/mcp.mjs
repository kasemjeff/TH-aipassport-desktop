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
//                    "cwd": null } ],
//     "approved": ["fs"] }
//
//   approved    the names the user has approved for project scope. It is
//               read from the HOME file — the one file a repository cannot
//               write — and it is what lets a project-scoped server run at
//               all. A project file is repository content: it arrives with
//               the code, and a repository that ships `.aipass/mcp.json`
//               would otherwise get its program executed the moment the
//               project is opened. The home file is the user's own, so a
//               home-scoped server keeps working without an approval.
//
//   enabled: false   configured but not started — the switch between deleting
//                    a working configuration and turning it off lives here.
//   risk             the permission weight of this server's tools. 'write'
//                    unless the server is known read-only: an MCP tool is
//                    someone else's program on this machine, and trusting it by
//                    default is how a fetch tool becomes a write tool without
//                    anyone deciding that. 'write' means the gate asks in the
//                    modes where writes are asked about; 'read' means never.
//                    A project-scoped server may not declare 'read': the file
//                    that declares it is the repository's, and a repository
//                    cannot vouch for what its own program does. Only the
//                    user's approval makes a declared 'read' count.
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
import { writeFileAtomic } from './atomic-write.mjs';

const INIT_TIMEOUT = 15000;
const CALL_TIMEOUT = 60000;
const TEST_TIMEOUT = 10000;

/**
 * The variables a project-scoped child may see.
 *
 * The harness's own environment carries its credentials — provider keys,
 * tokens, the desktop's session — and a repository's server is not the
 * user's program. It gets the variables its own config names, plus the few
 * the platform needs to run at all (where the programs are, the temp
 * folder, the home folder), and nothing else. A home-scoped server is the
 * user's own file and keeps the whole environment.
 */
const SAFE_ENV_KEYS = [
  'PATH', 'HOME', 'USERPROFILE',
  ...(process.platform === 'win32'
    ? ['SystemRoot', 'SystemDrive', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'APPDATA', 'LOCALAPPDATA']
    : ['TMPDIR', 'LANG', 'LC_ALL']),
];

/** The environment for a project-scoped server: the safe set plus its own. */
function projectEnv(named = {}) {
  const env = {};
  for (const key of SAFE_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  for (const [key, value] of Object.entries(named)) env[key] = value;
  return env;
}

/** The two layers, in resolution order: later wins. */
export function configPaths(root) {
  const home = aipassHome();
  const out = [{ file: path.join(home, 'mcp.json'), scope: 'home' }];
  if (root) out.push({ file: path.join(root, '.aipass', 'mcp.json'), scope: 'project' });
  return out;
}

/** One server definition, normalized — or null when it is too broken to name. */
function normalizeServer(raw, scope, file, approved = false) {
  const name = typeof raw?.name === 'string' ? raw.name.trim() : '';
  const command = typeof raw?.command === 'string' ? raw.command.trim() : '';
  if (!name || !command) return null;
  const env = {};
  if (raw.env && typeof raw.env === 'object' && !Array.isArray(raw.env)) {
    for (const [k, v] of Object.entries(raw.env)) if (typeof v === 'string') env[k] = v;
  }
  // A project file cannot talk itself into the read tier. 'read' is a
  // promise about what the server does, and in a repository's file that
  // promise is made by whoever wrote the repository. The user's approval is
  // what makes it count; without it the server rides the write gate like
  // any other program that is not the user's own.
  const declared = raw.risk === 'read' ? 'read' : 'write';
  const risk = (scope === 'project' && declared === 'read' && !approved) ? 'write' : declared;
  return {
    name,
    command,
    args: Array.isArray(raw.args) ? raw.args.map(String) : [],
    env,
    enabled: raw.enabled !== false,
    risk,
    cwd: typeof raw.cwd === 'string' && raw.cwd.trim() ? raw.cwd.trim() : null,
    scope,
    file,
    approved: scope === 'project' ? Boolean(approved) : true,
  };
}

/**
 * The names the user has approved, read from the HOME file.
 *
 * The list is a flat array of server names. Approval is by name, so a name
 * the user said yes to once is a name they said yes to — the object form
 * below is the stricter spelling, for a user who wants the approval bound
 * to one project folder:
 *
 *   { "approved": ["fs"] }                        every project
 *   { "approved": { "C:\\work\\app": ["fs"] } }   one project
 */
function approvedNames(data, root = null) {
  const list = data?.approved;
  if (Array.isArray(list)) return new Set(list.map((n) => String(n).trim()).filter(Boolean));
  if (list && typeof list === 'object') {
    const wanted = path.resolve(root ?? process.cwd());
    const key = Object.keys(list).find((k) => path.resolve(k) === wanted);
    const forProject = key ? list[key] : null;
    return new Set((Array.isArray(forProject) ? forProject : []).map((n) => String(n).trim()).filter(Boolean));
  }
  return new Set();
}

/**
 * Every configured server, project names overriding home ones. The override is
 * whole-entry: a project does not get to inherit half of a home definition and
 * replace the other half, because "which command is actually running" would
 * stop being a question with one answer.
 */
export function loadConfig(root) {
  const byName = new Map();
  let approved = new Set();
  for (const { file, scope } of configPaths(root)) {
    let data = null;
    try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* missing or malformed: skip */ }
    if (!data || typeof data !== 'object') continue;
    // The approval list is read from the home file only: it is the one file
    // a repository cannot write, so it is the one that can say yes. A
    // project file's own `approved` list is a request, not a consent.
    if (scope === 'home') approved = approvedNames(data, root);
    if (!Array.isArray(data.servers)) continue;
    for (const raw of data.servers) {
      const name = typeof raw?.name === 'string' ? raw.name.trim() : '';
      const server = normalizeServer(raw, scope, file, scope === 'project' && approved.has(name));
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
    // A file that holds only the approval list is still a config file: the
    // keys beside `servers` are kept, not dropped.
    if (data && typeof data === 'object') return { ...data, servers: [] };
  } catch { /* missing or malformed: start clean */ }
  return { servers: [] };
}

/**
 * Atomic, like settings.json: a crash mid-write never leaves half a config.
 *
 * The file holds MCP server `env` blocks, which are routinely API tokens, so
 * it is owner-only where the OS has modes. The mode is pinned on the new
 * file before the swap, and once more after it: a file that was already
 * there with wider permissions does not keep them.
 */
function writeConfigFile(file, data) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* windows has no POSIX modes */ }
  writeFileAtomic(file, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* windows has no POSIX modes */ }
}

/**
 * Record a name as approved in the home file.
 *
 * The approval list lives beside the user's own servers, because that is the
 * one file a repository cannot write. A project file's `approved` list is a
 * request; this one is the answer.
 */
function approveInHome(home, name) {
  const file = path.join(home, 'mcp.json');
  const data = readConfigFile(file);
  const list = Array.isArray(data.approved) ? data.approved : [];
  if (list.includes(name)) return;
  data.approved = [...list, name];
  writeConfigFile(file, data);
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
  // A project-scoped server runs only when the user has approved it by
  // name, and adding one is the user saying so: the approval is recorded in
  // the home file, next to the user's own servers.
  if (scope === 'project') approveInHome(home, name);
  return { ...normalizeServer(entry, scope, file, scope === 'project') };
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
    // A project-scoped server is the repository's program, not the user's:
    // it gets the variables its own config names and a small safe set, not
    // the harness's whole environment with the credentials in it. A
    // home-scoped server is the user's own file and keeps everything.
    const env = this.server.scope === 'project'
      ? projectEnv(this.server.env)
      : { ...process.env, ...(this.server.env || {}) };
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
  // A server that came from the project layer keeps its scope, so it is
  // tried with the same environment it would get in the harness. Testing it
  // is the user asking for it — the approval is about running it unattended.
  const scope = input.scope === 'project' ? 'project' : 'test';
  const server = normalizeServer(raw, scope, input.file ?? null, scope === 'project' ? Boolean(input.approved) : true);
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

/**
 * What the user has to do to let a project-scoped server run.
 *
 * The message names the file that declares the server, the file the
 * approval goes in, and the edit itself: an approval nobody can spell out
 * is an approval nobody makes.
 */
function approvalMessage(server, { home = aipassHome() } = {}) {
  const file = path.join(home, 'mcp.json');
  return `not approved — ${server.file} declares this server, and a project file may not start a program on its own. `
    + `Approve it by name: add "${server.name}" to the "approved" list in ${file} — { "approved": ["${server.name}"] }`;
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
      approved: s.approved,
      blocked: false,
      connected: false,
      error: null,
      tools: 0,
    }));
    const rowFor = new Map(this.statusRows.map((r) => [r.name, r]));
    for (const s of servers) {
      const row = rowFor.get(s.name);
      if (!s.enabled) continue;
      // A project file is repository content. Its server does not run until
      // the user has approved it by name — the approval the home file
      // carries. Until then it is a status row that says what to do, not a
      // program that was started.
      if (s.scope === 'project' && !s.approved) {
        row.blocked = true;
        row.error = approvalMessage(s);
        this.log(`mcp: ${s.name} not started — ${row.error}`);
        continue;
      }
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
