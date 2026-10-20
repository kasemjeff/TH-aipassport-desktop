#!/usr/bin/env node
// aipass mcp — configure, inspect and call MCP servers and their tools.
//
//   aipass mcp                                    list servers + tools
//   aipass mcp add <name> [--scope home|project] [--risk read|write]
//              [--env K=V]... [--cwd dir] -- <command> [args...]
//   aipass mcp remove <name> [--scope home|project]
//   aipass mcp enable|disable <name> [--scope ...]
//   aipass mcp test <name> [--scope ...]          connect, list tools, exit
//   aipass mcp test -- <command> [args...]        test one that is not saved
//   aipass mcp call <marker> [json-args]          call one tool
//
// Mutating commands go through the desktop backend when one is listening, so
// an open window updates live; with none they edit ~/.aipass/mcp.json or the
// project's .aipass/mcp.json directly, and the next desktop start reads them.
import { McpManager, loadConfig, addServer, removeServer, setServerEnabled, testServer } from './harness/mcp.mjs';
import { tryDesktopRpc } from './harness/desktop-rpc.mjs';

const argv = process.argv.slice(2);
const cmd = argv[0] || 'list';
const root = process.cwd();

// `--flag value` pairs, repeatable --env, and everything after `--` as a
// literal command line (so `-y` and package names are not read as flags).
const opts = { env: [] };
const positional = [];
let afterDash = null;
for (let i = 1; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--') { afterDash = argv.slice(i + 1); break; }
  if (a === '--scope' || a === '--risk' || a === '--cwd') { opts[a.slice(2)] = argv[++i]; continue; }
  if (a === '--env') { opts.env.push(argv[++i]); continue; }
  positional.push(a);
}

const say = (line) => console.log(line);
const usage = () => {
  say('usage: aipass mcp [list|add|remove|enable|disable|test|call] — see the header of mcp.mjs');
  process.exit(1);
};
const scope = () => {
  if (opts.scope == null) return null;
  if (opts.scope !== 'home' && opts.scope !== 'project') { console.error('err: --scope is home or project'); process.exit(1); }
  return opts.scope;
};
const risk = () => {
  const r = opts.risk ?? 'write';
  if (r !== 'read' && r !== 'write') { console.error('err: --risk is read or write'); process.exit(1); }
  return r;
};
const envPairs = () => {
  const env = {};
  for (const pair of opts.env) {
    const eq = String(pair).indexOf('=');
    if (eq < 1) { console.error(`err: --env expects K=V, got "${pair}"`); process.exit(1); }
    env[String(pair).slice(0, eq)] = String(pair).slice(eq + 1);
  }
  return env;
};
const reportTest = (result) => {
  if (!result.ok) { console.error(`err: ${result.error}`); return false; }
  say(`connected in ${result.ms} ms — ${result.tools.length} tool(s):`);
  for (const t of result.tools) say(`  ${t.name}  ${t.description}`);
  return true;
};

try {
  if (cmd === 'list' || cmd === 'ls') {
    // A running backend knows its live connections; with none, connect here.
    const viaBackend = await tryDesktopRpc('mcp.list');
    let servers;
    let tools;
    if (viaBackend?.ok) {
      ({ servers, tools } = viaBackend.result);
    } else {
      const mcp = new McpManager({ root, log: (t) => console.error(t) });
      await mcp.ensureLoaded();
      servers = mcp.status();
      tools = mcp.toolTable();
    }
    if (!servers.length) {
      say('(no MCP servers configured — aipass mcp add <name> -- <command> [args...])');
      process.exit(0);
    }
    say(`${servers.length} server(s), ${tools.length} tool(s):`);
    for (const s of servers) {
      const state = !s.enabled ? '[off]' : s.connected ? '[on] ' : '[!]  ';
      const detail = !s.enabled
        ? 'disabled'
        : s.connected ? `${s.tools} tool(s), risk: ${s.risk}` : (s.error ?? 'not connected');
      say(`  ${state} ${s.name} [${s.scope}] — ${detail}`);
    }
    for (const t of tools) say(`      ${t.marker}  ${t.description}`);
    process.exit(0);
  }

  if (cmd === 'add') {
    const name = positional[0];
    const command = afterDash?.[0] ?? positional[1];
    const commandArgs = afterDash ? afterDash.slice(1) : positional.slice(2);
    if (!name || !command) usage();
    const params = { name, command, args: commandArgs, env: envPairs(), risk: risk(), scope: opts.scope ?? 'home' };
    if (opts.cwd) params.cwd = opts.cwd;

    const viaBackend = await tryDesktopRpc('mcp.add', params);
    if (viaBackend && !viaBackend.ok) { console.error(`err: ${viaBackend.error}`); process.exit(1); }
    if (viaBackend?.ok) {
      const row = viaBackend.result.servers.find((s) => s.name === name);
      const state = row?.connected ? ` — connected (${row.tools} tools)` : row?.error ? ` — could not connect: ${row.error}` : '';
      say(`added ${name} [${params.scope}]${state}`);
      process.exit(0);
    }
    const added = addServer(params, { root });
    say(`added ${name} [${added.scope}] — the desktop app connects it at its next start`);
    process.exit(0);
  }

  if (cmd === 'remove' || cmd === 'rm' || cmd === 'enable' || cmd === 'disable') {
    const name = positional[0];
    if (!name) usage();
    const method = cmd === 'rm' ? 'remove' : cmd;

    const viaBackend = await tryDesktopRpc(`mcp.${method}`, { name, scope: scope() });
    if (viaBackend && !viaBackend.ok) { console.error(`err: ${viaBackend.error}`); process.exit(1); }
    if (viaBackend?.ok) {
      say(method === 'remove' ? `removed ${name}` : `${name} is ${method === 'enable' ? 'enabled' : 'disabled'}`);
      process.exit(0);
    }
    if (method === 'remove') {
      const out = removeServer(name, { root, scope: scope() });
      say(`removed ${name} (${out.file})`);
    } else {
      setServerEnabled(name, method === 'enable', { root, scope: scope() });
      say(`${name} is ${method === 'enable' ? 'enabled' : 'disabled'} — the desktop app reads this at its next start`);
    }
    process.exit(0);
  }

  if (cmd === 'test') {
    const name = afterDash ? null : positional[0];
    if (name) {
      const viaBackend = await tryDesktopRpc('mcp.test', { name, scope: scope() });
      if (viaBackend && !viaBackend.ok) { console.error(`err: ${viaBackend.error}`); process.exit(1); }
      if (viaBackend?.ok) process.exit(reportTest(viaBackend.result) ? 0 : 1);
      const known = loadConfig(root).find((s) => s.name === name && (!scope() || s.scope === scope()));
      if (!known) { console.error(`err: no server named ${name}`); process.exit(1); }
      process.exit(reportTest(await testServer(known, { root })) ? 0 : 1);
    }
    const command = afterDash?.[0];
    if (!command) usage();
    const result = await testServer({ command, args: afterDash.slice(1), env: envPairs(), risk: risk() }, { root });
    process.exit(reportTest(result) ? 0 : 1);
  }

  if (cmd === 'call') {
    const marker = positional[0];
    if (!marker) { console.error('usage: aipass mcp call <marker> [json-args]'); process.exit(1); }
    const args = positional[1] ? JSON.parse(positional[1]) : {};
    const mcp = new McpManager({ root, log: (t) => console.error(t) });
    await mcp.ensureLoaded();
    say(await mcp.runTool(marker, { body: JSON.stringify(args) }));
    process.exit(0);
  }

  usage();
} catch (err) {
  console.error(`err: ${err.message ?? err}`);
  process.exit(1);
}
