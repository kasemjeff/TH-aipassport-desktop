// The MCP client and its config, pinned. The design is
// docs/PLUGINS_MCP_DESIGN.md; these tests hold its promises:
//   - the project layer wins per name, and wins whole
//   - one broken server is a status row, never a dead harness
//   - every tool carries a risk, and "unset" means 'write'
//   - edits go through the helpers, and reload is how they reach the manager
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempDir } from './harness.mjs';
import {
  loadConfig, addServer, removeServer, setServerEnabled, testServer, serverNameProblem, McpManager,
} from '../harness/mcp.mjs';

/**
 * A tiny stdio MCP server for tests: echo and pwd. It speaks the handshake and
 * two tools, which is exactly as much protocol as the client claims to know.
 */
const FIXTURE = `
process.stdin.setEncoding('utf8');
let buf = '';
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    const send = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n');
    if (msg.method === 'initialize') send({ protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fixture', version: '1.0.0' } });
    else if (msg.method === 'tools/list') send({ tools: [
      { name: 'echo', description: 'echoes text back', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
      { name: 'pwd', description: 'the directory the server runs in', inputSchema: { type: 'object', properties: {} } },
    ] });
    else if (msg.method === 'tools/call') {
      const text = msg.params.name === 'pwd' ? process.cwd() : 'echo: ' + (msg.params.arguments?.text ?? '');
      send({ content: [{ type: 'text', text }] });
    }
    else if (msg.id !== undefined) send({});
  }
});
`;

/** A stdio server that never answers — the timeout path. */
const SILENT = `
process.stdin.on('data', () => {});
setInterval(() => {}, 1000);
`;

/** A server that answers the handshake and lists its tools, but never answers
 *  a tool call — the shape a stop has to end. */
const SILENT_CALL = `
process.stdin.setEncoding('utf8');
let buf = '';
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    const send = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n');
    if (msg.method === 'initialize') send({ protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'silent-call', version: '1.0.0' } });
    else if (msg.method === 'tools/list') send({ tools: [
      { name: 'echo', description: 'never answers', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
    ] });
    else if (msg.method === 'tools/call') { /* the call is never answered */ }
    else if (msg.id !== undefined) send({});
  }
});
setInterval(() => {}, 1000);
`;

/** A server that reports one environment variable. */
const ENV = `
process.stdin.setEncoding('utf8');
let buf = '';
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    const send = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n');
    if (msg.method === 'initialize') send({ protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'env', version: '1.0.0' } });
    else if (msg.method === 'tools/list') send({ tools: [
      { name: 'secret', description: 'one environment variable', inputSchema: { type: 'object', properties: {} } },
    ] });
    else if (msg.method === 'tools/call') send({ content: [{ type: 'text', text: process.env.AIPASS_TEST_SECRET ?? '(unset)' }] });
    else if (msg.id !== undefined) send({});
  }
});
`;

/** A server that leaves a canary behind the moment it starts. */
const canary = (file) => `
import fs from 'node:fs';
fs.writeFileSync(${JSON.stringify(file)}, 'ran');
` + FIXTURE;

function writeFixture(dir, name, body) {
  const file = path.join(dir, `${name}.mjs`);
  fs.writeFileSync(file, body);
  return file;
}

/** command + args that run a fixture with this same node. */
function fixtureArgs(dir, name, body) {
  return { command: process.execPath, args: [writeFixture(dir, name, body)] };
}

const writeJson = (file, data) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
};
const readServers = (file) => JSON.parse(fs.readFileSync(file, 'utf8')).servers;
/**
 * Run with AIPASS_HOME pointed at a fresh temp dir: the home layer of the
 * config is read through aipassHome(), and a test must never see the real
 * ~/.aipass/mcp.json.
 */
function withHome(fn) {
  const prev = process.env.AIPASS_HOME;
  const home = tempDir();
  process.env.AIPASS_HOME = home;
  return (async () => fn(home))().finally(() => {
    if (prev === undefined) delete process.env.AIPASS_HOME;
    else process.env.AIPASS_HOME = prev;
  });
}

test('config layers merge by name, and the project line wins whole', () => withHome(async (home) => {
  const root = tempDir();
  writeJson(path.join(home, 'mcp.json'), {
    servers: [
      { name: 'fs', command: 'home-fs', args: ['a'], risk: 'read' },
      { name: 'shared', command: 'both' },
    ],
  });
  writeJson(path.join(root, '.aipass', 'mcp.json'), {
    servers: [
      { name: 'fs', command: 'project-fs', args: ['b'], enabled: false },
      { name: 'proj', command: 'p' },
      { name: '', command: 'nameless — skipped' },
      { name: 'no-command' },
    ],
  });

  const servers = loadConfig(root);
  assert.deepEqual(servers.map((s) => s.name), ['fs', 'shared', 'proj'], 'unnameable entries are skipped, not guessed at');
  const fsServer = servers.find((s) => s.name === 'fs');
  assert.equal(fsServer.command, 'project-fs', 'the project layer is the one that runs');
  assert.equal(fsServer.scope, 'project');
  assert.equal(fsServer.enabled, false);
  assert.equal(fsServer.risk, 'write', 'an unset risk is write — the safe direction');
  assert.equal(servers.find((s) => s.name === 'shared').scope, 'home');
  assert.equal(servers.find((s) => s.name === 'shared').risk, 'write');

  // No root means no project layer at all — home stands alone.
  assert.deepEqual(loadConfig(null).map((s) => s.name), ['fs', 'shared']);
}));

test('a broken server is a status row, never a dead harness — and every tool carries a risk', () => withHome(async (home) => {
  const dir = tempDir();
  const root = tempDir();
  writeJson(path.join(home, 'mcp.json'), {
    servers: [
      { name: 'readonly', ...fixtureArgs(dir, 'ok', FIXTURE), risk: 'read' },
      { name: 'plain', ...fixtureArgs(dir, 'plain', FIXTURE) },
      { name: 'broken', command: process.execPath, args: [path.join(dir, 'missing.mjs')] },
      { name: 'gone', command: path.join(dir, 'no-such-binary') },
      { name: 'off', ...fixtureArgs(dir, 'off', FIXTURE), enabled: false },
    ],
  });

  const manager = new McpManager({ root, log: () => {} });
  try {
    await manager.ensureLoaded();
    const rows = manager.status();
    assert.deepEqual(rows.map((r) => r.name), ['readonly', 'plain', 'broken', 'gone', 'off']);

    assert.equal(rows.find((r) => r.name === 'readonly').connected, true);
    assert.equal(rows.find((r) => r.name === 'readonly').tools, 2);
    assert.equal(rows.find((r) => r.name === 'plain').connected, true);

    const brokenRow = rows.find((r) => r.name === 'broken');
    assert.equal(brokenRow.connected, false);
    assert.ok(brokenRow.error, 'the failure is named');
    const goneRow = rows.find((r) => r.name === 'gone');
    assert.equal(goneRow.connected, false);
    assert.ok(goneRow.error, 'a command that does not exist fails as a row, not a crash');
    const offRow = rows.find((r) => r.name === 'off');
    assert.equal(offRow.enabled, false);
    assert.equal(offRow.connected, false, 'disabled means not spawned');

    const table = manager.toolTable();
    assert.deepEqual(table.map((t) => t.marker).sort(), ['MCP__plain__echo', 'MCP__plain__pwd', 'MCP__readonly__echo', 'MCP__readonly__pwd']);
    assert.equal(table.find((t) => t.marker === 'MCP__readonly__echo').risk, 'read', 'a declared read-only server stays read');
    assert.equal(table.find((t) => t.marker === 'MCP__plain__echo').risk, 'write', 'unset is write — an MCP tool is someone else\'s program');

    assert.equal(await manager.runTool('MCP__readonly__echo', { body: '{"text":"hi"}' }), 'echo: hi');
    assert.equal(await manager.runTool('MCP__off__echo', {}), 'no such mcp tool: MCP__off__echo');
  } finally {
    manager.close();
  }
}));

test('a stop ends an mcp call the server never answers', () => withHome(async (home) => {
  const dir = tempDir();
  const root = tempDir();
  writeJson(path.join(root, '.aipass', 'mcp.json'), {
    servers: [{ name: 'silent', ...fixtureArgs(dir, 'silent', SILENT_CALL) }],
  });
  // A project-scoped server runs only when the user has approved it by
  // name, and the approval is kept in the home file.
  writeJson(path.join(home, 'mcp.json'), { servers: [], approved: ['silent'] });

  const manager = new McpManager({ root, log: () => {} });
  try {
    await manager.ensureLoaded();
    const controller = new AbortController();
    const started = Date.now();
    const pending = manager.runTool('MCP__silent__echo', { body: '{"text":"hi"}', signal: controller.signal });
    setTimeout(() => controller.abort(), 150);
    const out = await pending;
    const took = Date.now() - started;
    assert.match(out, /err: the run was stopped/, 'the call ended with the stop');
    assert.ok(took < 5_000, `and it did not wait for the server's timeout (it took ${took} ms)`);
  } finally {
    manager.close();
  }
}));

test("a server's cwd is where it runs, not where the harness happens to stand", () => withHome(async (home) => {
  const dir = tempDir();
  const root = tempDir();
  fs.mkdirSync(path.join(root, 'work'));
  writeJson(path.join(root, '.aipass', 'mcp.json'), {
    servers: [{ name: 'here', ...fixtureArgs(dir, 'pwd', FIXTURE), cwd: 'work' }],
  });
  writeJson(path.join(home, 'mcp.json'), { servers: [], approved: ['here'] });

  const manager = new McpManager({ root, log: () => {} });
  try {
    await manager.ensureLoaded();
    const out = await manager.runTool('MCP__here__pwd', {});
    assert.equal(path.resolve(out), path.resolve(root, 'work'));
  } finally {
    manager.close();
  }
}));

test('reload is how a config edit reaches the running manager', () => withHome(async (home) => {
  const dir = tempDir();
  const root = tempDir();
  addServer({ name: 'fixture', ...fixtureArgs(dir, 'a', FIXTURE) }, { home, root });

  const manager = new McpManager({ root, log: () => {} });
  try {
    await manager.ensureLoaded();
    assert.equal(manager.toolTable().length, 2);

    setServerEnabled('fixture', false, { home, root });
    await manager.reload();
    assert.equal(manager.toolTable().length, 0, 'off means off after a reload');
    assert.equal(manager.status()[0].enabled, false);

    setServerEnabled('fixture', true, { home, root });
    await manager.reload();
    assert.equal(manager.toolTable().length, 2, 'and on means on again');
  } finally {
    manager.close();
  }
}));

test('switching projects does not duplicate the MCP markers', () => withHome(async (home) => {
  // A project switch closes the manager of the project being LEFT (rpc.mjs
  // does it for every other harness it holds), and the next run there loads
  // it again. The tool table belongs to the clients: a table that outlives
  // them is told to the model twice — once for the tools that are there and
  // once for the tools whose servers are gone — and it grows with every
  // switch for the life of the backend.
  const dir = tempDir();
  const root = tempDir();
  writeJson(path.join(home, 'mcp.json'), {
    servers: [{ name: 'fixture', ...fixtureArgs(dir, 'switch', FIXTURE) }],
  });

  const manager = new McpManager({ root, log: () => {} });
  try {
    await manager.ensureLoaded();
    assert.deepEqual(manager.toolTable().map((t) => t.marker), ['MCP__fixture__echo', 'MCP__fixture__pwd']);

    manager.close(); // the switch away
    assert.deepEqual(manager.toolTable(), [], 'closing drops the tools with the clients');
    assert.deepEqual(manager.status(), [], 'and the rows of the servers that are gone');

    await manager.ensureLoaded(); // the switch back
    const markers = manager.toolTable().map((t) => t.marker);
    assert.deepEqual(markers, ['MCP__fixture__echo', 'MCP__fixture__pwd'], 'the tools are back');
    assert.equal(new Set(markers).size, markers.length, 'and each marker is listed once, not twice');
  } finally {
    manager.close();
  }
}));

test('a project-scoped server is not spawned without the user approving it by name', () => withHome(async (home) => {
  // A project file is repository content: it arrives with the code, and a
  // repository that ships .aipass/mcp.json would otherwise get its program
  // executed the moment the project is opened.
  const dir = tempDir();
  const root = tempDir();
  const started = path.join(dir, 'STARTED');
  const projectFile = path.join(root, '.aipass', 'mcp.json');
  writeJson(projectFile, {
    servers: [{ name: 'repo', ...fixtureArgs(dir, 'repo', canary(started)) }],
  });

  const manager = new McpManager({ root, log: () => {} });
  try {
    await manager.ensureLoaded();
    const row = manager.status().find((r) => r.name === 'repo');
    assert.equal(row.connected, false, 'a repository does not get to start a program');
    assert.equal(row.blocked, true, 'the row says it is waiting for the user');
    assert.equal(fs.existsSync(started), false, 'and the program never ran');
    assert.deepEqual(manager.toolTable(), [], 'no tools from a server that never started');

    // The reason names the file that declares the server, the file the
    // approval goes in, and the edit itself.
    assert.match(row.error, /not approved/);
    assert.ok(row.error.includes(projectFile), 'the file that declares it');
    assert.ok(row.error.includes(path.join(home, 'mcp.json')), 'the file the approval goes in');
    assert.ok(row.error.includes('"approved": ["repo"]'), 'and the exact edit');

    // The approval is the user's, kept in the home file — the one file a
    // repository cannot write.
    writeJson(path.join(home, 'mcp.json'), { servers: [], approved: ['repo'] });
    await manager.reload();
    const approved = manager.status().find((r) => r.name === 'repo');
    assert.equal(approved.connected, true, 'approved is allowed');
    assert.equal(fs.existsSync(started), true, 'and the program runs');
  } finally {
    manager.close();
  }
}));

test('a project file cannot talk itself into the read tier', () => withHome(async (home) => {
  const dir = tempDir();
  const root = tempDir();
  writeJson(path.join(home, 'mcp.json'), {
    servers: [{ name: 'home-read', ...fixtureArgs(dir, 'home-read', FIXTURE), risk: 'read' }],
  });
  writeJson(path.join(root, '.aipass', 'mcp.json'), {
    servers: [{ name: 'repo-read', ...fixtureArgs(dir, 'repo-read', FIXTURE), risk: 'read' }],
  });

  const servers = loadConfig(root);
  assert.equal(servers.find((s) => s.name === 'home-read').risk, 'read', "the user's own file keeps its declared risk");
  assert.equal(servers.find((s) => s.name === 'repo-read').risk, 'write', 'a repository file does not get the read tier');

  // The user's approval is what makes a declared read count.
  writeJson(path.join(home, 'mcp.json'), {
    servers: [{ name: 'home-read', ...fixtureArgs(dir, 'home-read', FIXTURE), risk: 'read' }],
    approved: ['repo-read'],
  });
  assert.equal(loadConfig(root).find((s) => s.name === 'repo-read').risk, 'read', 'approved by name, the declared risk counts');
}));

test('a project-scoped child does not inherit the harness environment', () => withHome(async (home) => {
  const dir = tempDir();
  const root = tempDir();
  process.env.AIPASS_TEST_SECRET = 'do-not-leak';
  try {
    writeJson(path.join(home, 'mcp.json'), {
      servers: [{ name: 'home-env', ...fixtureArgs(dir, 'home-env', ENV) }],
      approved: ['repo-env'],
    });
    writeJson(path.join(root, '.aipass', 'mcp.json'), {
      servers: [{ name: 'repo-env', ...fixtureArgs(dir, 'repo-env', ENV) }],
    });

    const manager = new McpManager({ root, log: () => {} });
    try {
      await manager.ensureLoaded();
      assert.equal(await manager.runTool('MCP__home-env__secret', {}), 'do-not-leak', "the user's own server keeps the environment");
      assert.equal(await manager.runTool('MCP__repo-env__secret', {}), '(unset)', "a repository's server does not get the harness's credentials");
    } finally {
      manager.close();
    }
  } finally {
    delete process.env.AIPASS_TEST_SECRET;
  }
}));

test("the config file holds tokens, so it is owner-only", { skip: process.platform === 'win32' ? 'POSIX modes only' : false }, () => withHome(async (home) => {
  const root = tempDir();
  addServer({ name: 'secretive', command: 'echo', env: { TOKEN: 'abc' } }, { home, root });
  const file = path.join(home, 'mcp.json');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600, "the file is the owner's alone");
  assert.equal(fs.statSync(path.join(home)).mode & 0o777, 0o700, 'and so is the folder it is in');
}));

test('addServer refuses the names and shapes that would never run', () => withHome(async (home) => {
  const root = tempDir();
  assert.equal(serverNameProblem('Bad Name'), '"Bad Name" is not a usable name — lowercase letters, digits, dash, underscore; start alphanumeric');
  assert.throws(() => addServer({ name: 'Bad Name', command: 'x' }, { home, root }), /not a usable name/);
  assert.throws(() => addServer({ name: 'ok', command: '' }, { home, root }), /command is required/);
  assert.throws(() => addServer({ name: 'ok', command: 'x', scope: 'project' }, { home, root: null }), /no folder/);

  const added = addServer({ name: 'ok', command: 'echo', args: ['a', 'b'], env: { TOKEN: 't' }, risk: 'read', cwd: 'sub' }, { home, root });
  assert.equal(added.scope, 'home');
  assert.throws(() => addServer({ name: 'ok', command: 'twice' }, { home, root }), /already exists/);

  // A project file owns a name the home file is not allowed to shadow: the
  // home entry would be written and then never run.
  addServer({ name: 'mine', command: 'echo', scope: 'project' }, { home, root });
  assert.throws(() => addServer({ name: 'mine', command: 'echo' }, { home, root }), /would never run/);

  assert.deepEqual(readServers(path.join(home, 'mcp.json'))[0], {
    name: 'ok', command: 'echo', args: ['a', 'b'], env: { TOKEN: 't' }, risk: 'read', cwd: 'sub',
  });
  assert.ok(fs.existsSync(path.join(root, '.aipass', 'mcp.json')), 'the project layer landed in the project');
}));

test('editing a name edits the layer that runs — remove and enable prefer the project entry', () => withHome(async (home) => {
  const root = tempDir();
  writeJson(path.join(home, 'mcp.json'), {
    servers: [{ name: 'dup', command: 'home' }, { name: 'only-home', command: 'x' }],
  });
  writeJson(path.join(root, '.aipass', 'mcp.json'), { servers: [{ name: 'dup', command: 'project' }] });

  const out = removeServer('dup', { home, root });
  assert.equal(out.file, path.join(root, '.aipass', 'mcp.json'));
  assert.deepEqual(readServers(path.join(root, '.aipass', 'mcp.json')), [], 'the project layer was the one edited');
  assert.equal(readServers(path.join(home, 'mcp.json')).find((s) => s.name === 'dup').command, 'home', 'home is untouched');

  setServerEnabled('dup', false, { home, root });
  assert.equal(readServers(path.join(home, 'mcp.json')).find((s) => s.name === 'dup').enabled, false);
  setServerEnabled('dup', true, { home, root });
  assert.equal(readServers(path.join(home, 'mcp.json')).find((s) => s.name === 'dup').enabled, undefined, 'enabling strips the flag rather than writing true');

  assert.throws(() => removeServer('nope', { home, root }), /no server named nope/);
  // An explicit scope edits that file, not the winning one.
  setServerEnabled('dup', false, { home, root, scope: 'home' });
  assert.equal(readServers(path.join(home, 'mcp.json')).find((s) => s.name === 'dup').enabled, false);
}));

test('testServer answers with the tools, or the reason there were none', () => withHome(async () => {
  const dir = tempDir();
  const ok = await testServer({ ...fixtureArgs(dir, 'good', FIXTURE) }, { timeoutMs: 8000 });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.tools.map((t) => t.name).sort(), ['echo', 'pwd']);
  assert.ok(ok.ms >= 0);

  const broken = await testServer({ command: process.execPath, args: [path.join(dir, 'missing.mjs')] });
  assert.equal(broken.ok, false);
  assert.ok(broken.error);

  const silent = await testServer({ command: process.execPath, args: [writeFixture(dir, 'silent', SILENT)] }, { timeoutMs: 300 });
  assert.equal(silent.ok, false);
  assert.match(silent.error, /timeout/);

  const empty = await testServer({});
  assert.equal(empty.ok, false);
  assert.match(empty.error, /command is required/);
}));
