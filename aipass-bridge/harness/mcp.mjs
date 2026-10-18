// mcp.mjs — a minimal Model Context Protocol (MCP) client.
//
// MCP lets an external process expose tools/resources to the model over
// JSON-RPC. This client speaks the stdio transport (the common one): it
// spawns the server, does the initialize handshake, lists its tools, and
// calls them. HTTP/SSE transport is deliberately not implemented yet — the
// stdio path covers the overwhelming majority of published servers.
//
// Config: ~/.aipass/mcp.json (or <project>/.aipass/mcp.json), shape:
//   { "servers": [ { "name": "fs", "command": "npx",
//                    "args": ["-y","@modelcontextprotocol/server-filesystem","."],
//                    "env": {} } ] }
// Servers that fail to start or time out are skipped, never fatal.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { aipassHome } from './settings.mjs';

const INIT_TIMEOUT = 15000;
const CALL_TIMEOUT = 60000;

function configPaths(root) {
  const out = [];
  const home = aipassHome();
  out.push(path.join(home, 'mcp.json'));
  if (root) out.push(path.join(root, '.aipass', 'mcp.json'));
  return out;
}

function loadConfig(root) {
  const servers = [];
  for (const p of configPaths(root)) {
    try {
      const raw = fs.readFileSync(p, 'utf8');
      const data = JSON.parse(raw);
      if (data && Array.isArray(data.servers)) servers.push(...data.servers);
    } catch { /* missing or malformed: skip */ }
  }
  // de-dup by name (project overrides home)
  const seen = new Set();
  const dedup = [];
  for (const s of servers) {
    if (!s || !s.name || !s.command) continue;
    if (seen.has(s.name)) continue;
    seen.add(s.name);
    dedup.push(s);
  }
  return dedup;
}

class StdioClient {
  constructor(server, log) {
    this.server = server;
    this.log = log || (() => {});
    this.proc = null;
    this.nextId = 1;
    this.pending = new Map(); // id -> {resolve, reject, timer}
    this.tools = []; // [{name, description, inputSchema}]
    this.ready = false;
    this.error = null;
  }

  async connect() {
    const env = { ...process.env, ...(this.server.env || {}) };
    this.proc = spawn(this.server.command, this.server.args || [], { env, stdio: ['pipe', 'pipe', 'pipe'] });
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
          if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
          else p.resolve(msg.result);
        }
      }
    });
    this.proc.stderr.on('data', (d) => this.log(`[mcp:${this.server.name}] ${String(d).trim()}`));
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
    }, INIT_TIMEOUT);
    // notification: initialized (no response expected)
    try { this.notify('notifications/initialized', {}); } catch {}
    // tools/list
    const listResult = await this.request('tools/list', {}, INIT_TIMEOUT);
    this.tools = (listResult && Array.isArray(listResult.tools)) ? listResult.tools : [];
    this.ready = true;
    return initResult;
  }

  request(method, params, timeout = CALL_TIMEOUT) {
    return new Promise((resolve, reject) => {
      if (!this.proc || this.proc.killed) { reject(new Error('server not running')); return; }
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout: ${method}`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
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

  async callTool(name, args) {
    const result = await this.request('tools/call', { name, arguments: args || {} }, CALL_TIMEOUT);
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

export class McpManager {
  constructor({ root = null, log = () => {} } = {}) {
    this.root = root;
    this.log = log;
    this.clients = new Map(); // name -> StdioClient
    this.loaded = false;
    this.tools = []; // [{marker, server, tool, description}]
  }

  async ensureLoaded() {
    if (this.loaded) return;
    this.loaded = true;
    const servers = loadConfig(this.root);
    for (const s of servers) {
      const client = new StdioClient(s, this.log);
      try {
        await client.connect();
        this.clients.set(s.name, client);
        for (const t of client.tools) {
          const marker = `MCP__${s.name}__${t.name}`;
          this.tools.push({ marker, server: s.name, tool: t.name, description: t.description || t.name, inputSchema: t.inputSchema });
        }
        this.log(`mcp: ${s.name} connected (${client.tools.length} tools)`);
      } catch (e) {
        this.log(`mcp: ${s.name} failed to connect: ${e.message}`);
        try { client.close(); } catch {}
      }
    }
  }

  toolTable() {
    return this.tools.map((t) => ({ marker: t.marker, takesBody: true, description: t.description, plugin: `mcp:${t.server}`, risk: null }));
  }

  hasTool(marker) {
    return this.tools.some((t) => t.marker === marker);
  }

  async runTool(marker, { arg = '', body = '' } = {}) {
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
      return await client.callTool(t.tool, args);
    } catch (e) {
      return `err: ${e.message}`;
    }
  }

  close() {
    for (const c of this.clients.values()) try { c.close(); } catch {}
    this.clients.clear();
  }
}

export default McpManager;
