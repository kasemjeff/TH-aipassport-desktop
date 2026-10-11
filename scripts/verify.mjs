#!/usr/bin/env node
// `npm run verify` — the standing "is everything still working" check.
//
// Three stages, each reported PASS / FAIL / SKIP, nonzero exit on any FAIL:
//
//   tests  the full suite (`npm test`, parallel — the invocation the test
//          runner exists to make portable), with its tail and summary echoed
//   smoke  a sandboxed live smoke: starts the real bridge and the real
//          desktop backend from this source tree on free ports (8792+) with a
//          throwaway HOME/USERPROFILE, asserts the bridge endpoints, the
//          backend RPC handshake and the served window, then shuts everything
//          down and deletes the sandbox
//   chat   only with `--chat`: one tiny real chat through the sandbox bridge,
//          but only when a Chrome extension is connected to it — otherwise
//          PENDING-LOGIN and a SKIP (the extension normally lives on your
//          live bridge, so this is the expected outcome, not a failure)
//
// Safety around a live aipass stack: ports 8787 (bridge) and 8790 (backend)
// are protected — the tool refuses to bind, probe or send a request to either,
// and it strips any inherited AIPASS_* environment so the smoke can only ever
// talk to the sandbox it just started. No credentials are read, held or sent;
// the chat path goes through the bridge's normal extension route or not at all.
//
// Zero dependencies, Node >= 20 builtins only. HTTP goes through node:http
// with a no-keep-alive agent and exit happens by draining the loop
// (process.exitCode, never process.exit) — on Windows, process.exit() after
// network I/O races Node's teardown and trips libuv's win/async.c assert
// (see the chat.mjs fix for the full story).
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The user's live stack owns these — never bind, probe or request them. */
const PROTECTED_PORTS = new Set([8787, 8790]);
/** Where the sandbox looks for free ports (above both live-stack ports). */
const PORT_BASE = 8792;
const READY_TIMEOUT_MS = 20_000;
const CHAT_TIMEOUT_MS = 60_000;

const USAGE = `\
usage: node scripts/verify.mjs [--chat] [--skip-tests] [--bridge-port N] [--backend-port N]

  --chat            stage 3: one real chat when an extension is connected to the
                    sandbox bridge; PENDING-LOGIN + SKIP otherwise
  --skip-tests      skip stage 1 (the suite) — for quick smoke iterations
  --bridge-port N   pin the sandbox bridge port (used as given; never 8787/8790)
  --backend-port N  pin the sandbox backend port (used as given; never 8787/8790)
`;

/* ------------------------------------------------------------------ output */

const say = (line = '') => process.stdout.write(`${line}\n`);

function tailOf(text, lines = 30) {
  const all = String(text ?? '').split(/\r?\n/);
  const cut = all.slice(-lines);
  return (all.length > lines ? `… (${all.length - lines} earlier lines omitted)\n` : '') + cut.join('\n');
}

/* ---------------------------------------------------------- protected ports */

function assertSafePort(port, label) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${label}: not a port: ${JSON.stringify(port)}`);
  }
  if (PROTECTED_PORTS.has(port)) {
    throw new Error(
      `${label} ${port} is a protected port — a live aipass stack may own it; the sandbox only uses ${PORT_BASE}+`,
    );
  }
}

/** Preflight: is this port free right now? (Binds and immediately releases.) */
function portIsFree(port) {
  assertSafePort(port, 'port probe');
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', (err) => {
      if (err.code === 'EADDRINUSE') resolve(false);
      else reject(err);
    });
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
}

/**
 * Pick the port a sandbox server will bind. An explicit port is used as given
 * (and fails the stage when occupied — a pinned port that was silently swapped
 * would hide exactly the kind of problem this tool exists to catch); the
 * automatic path scans upward from PORT_BASE for the first free one.
 */
async function pickPort(explicit, label) {
  if (explicit != null) {
    assertSafePort(explicit, label);
    if (!(await portIsFree(explicit))) {
      throw new Error(`${label} ${explicit} is already in use — a pinned port is used as pinned, not bumped`);
    }
    return explicit;
  }
  for (let p = PORT_BASE; p < PORT_BASE + 64; p++) {
    if (PROTECTED_PORTS.has(p)) continue; // belt and braces; the scan starts above them
    if (await portIsFree(p)) return p;
  }
  throw new Error(`no free port found in ${PORT_BASE}..${PORT_BASE + 63}`);
}

/** Every request the tool makes goes through here, so a stray URL cannot reach a protected port. */
function assertRequestablePort(port) {
  assertSafePort(port, 'request to');
}

/**
 * One plain HTTP exchange against 127.0.0.1:<port>, no keep-alive (agent:
 * false — nothing lingers in a connection pool to race the exit).
 * Returns { status, headers, body, stream } where `stream` is the raw
 * IncomingMessage (only when `streaming`); otherwise the whole body is read.
 */
function httpExchange(port, { method = 'GET', pathname = '/', headers = {}, body = null, streaming = false, timeoutMs = 5_000 } = {}) {
  assertRequestablePort(port);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method, path: pathname, headers, agent: false },
      (res) => {
        if (streaming) return resolve({ status: res.statusCode, headers: res.headers, stream: res });
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', reject);
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timed out after ${timeoutMs} ms`)));
    req.on('error', reject);
    if (body != null) req.end(body);
    else req.end();
  });
}

const jsonBody = (value) => JSON.stringify(value);
const httpJson = async (port, opts) => {
  const { body, ...rest } = opts;
  const res = await httpExchange(port, {
    ...rest,
    ...(body != null ? { headers: { 'content-type': 'application/json', ...rest.headers }, body: jsonBody(body) } : {}),
  });
  let parsed = null;
  try { parsed = JSON.parse(res.body); } catch { /* a non-JSON answer is a failed check, not a crash */ }
  return { ...res, body: parsed, rawBody: res.body };
};

/* ------------------------------------------------------------------ children */

function startChild(args, env, label) {
  const child = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  child.label = label;
  child.captured = { out: '', err: '' };
  const cap = (slot) => (chunk) => {
    child.captured[slot] += chunk;
    if (child.captured[slot].length > 64_000) child.captured[slot] = child.captured[slot].slice(-48_000);
  };
  child.stdout.on('data', cap('out'));
  child.stderr.on('data', cap('err'));
  return child;
}

/**
 * Graceful close: signal, then wait for the real exit AND the stdio pipes to
 * flush ('close'), escalating to SIGKILL if the process ignores the first.
 */
function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    let hardTimer = null;
    const finish = () => { clearTimeout(hardTimer); resolve(); };
    child.once('close', finish);
    child.kill('SIGTERM');
    // Ignored? Escalate. Even after SIGKILL, 'close' must arrive — never hang
    // the verifier on a wedged child, so a final bail-out resolves regardless.
    hardTimer = setTimeout(() => {
      child.kill('SIGKILL');
      setTimeout(finish, 10_000).unref();
    }, 5_000);
  });
}

const childDied = (child) => child.exitCode !== null || child.signalCode !== null;

async function waitReady(label, child, probe) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    if (childDied(child)) {
      throw new Error(`${label} exited during startup (code ${child.exitCode}, signal ${child.signalCode})\n${tailOf(child.captured.err || child.captured.out, 10)}`);
    }
    try {
      if (await probe()) return;
    } catch { /* not up yet — keep polling until the deadline */ }
    if (Date.now() > deadline) {
      throw new Error(`${label} not ready after ${READY_TIMEOUT_MS / 1000}s\n${tailOf(child.captured.err || child.captured.out, 10)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/* ------------------------------------------------------------- stage 1: tests */

/** Stage 1 — the full suite, exactly `npm test` (node scripts/test.mjs). */
async function runTests() {
  const t0 = Date.now();
  say('  running the full suite (npm test — parallel; its tail is shown when done)…');
  const child = spawn(process.execPath, [path.join(REPO, 'scripts', 'test.mjs')], {
    cwd: REPO,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let out = '';
  let err = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { err += c; });
  await new Promise((resolve) => {
    const bail = setTimeout(() => child.kill('SIGKILL'), 300_000); // never hang forever on a stuck suite
    bail.unref();
    child.once('close', () => { clearTimeout(bail); resolve(); });
  });
  const code = child.exitCode;
  const all = `${out}\n${err}`;

  // node:test summary lines, in either reporter: TAP's "# pass 209" or the
  // spec reporter's "ℹ pass 209" (what Node 24 emits even when piped). The
  // exit code stays the primary verdict; the summary is the human-readable
  // half of the evidence.
  const grab = (name) => {
    const m = all.match(new RegExp(`^[#ℹ]\\s*${name} (\\d+)\\s*$`, 'm'));
    return m ? Number(m[1]) : null;
  };
  const pass = grab('pass');
  const fail = grab('fail');
  const total = grab('tests');
  const seconds = since(t0);

  say('');
  say(tailOf(all.trimEnd(), 30));

  if (code !== 0) {
    return { status: 'FAIL', detail: `suite exited ${code} (${seconds}s)`, seconds };
  }
  if (fail !== null && fail > 0) {
    return { status: 'FAIL', detail: `${fail} test(s) failed although exit was 0 (${seconds}s)`, seconds };
  }
  if (pass === null) {
    // Could not parse the summary — the exit code still decides, said honestly.
    return { status: 'PASS', detail: `suite exited 0 (test summary not parsed — reported from the exit code; ${seconds}s)`, seconds };
  }
  return { status: 'PASS', detail: `${pass}/${total ?? '?'} tests passed, ${fail} failed (${seconds}s)`, seconds };
}

/* ------------------------------------------------------------- stage 2: smoke */

function sandboxEnv({ home, bridgePort, backendPort }) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^AIPASS_/i.test(key)) delete env[key]; // nothing of the user's live setup may leak in
  }
  env.HOME = home;
  env.USERPROFILE = home;
  env.AIPASS_PORT = String(bridgePort);
  env.AIPASS_DESKTOP_PORT = String(backendPort);
  env.AIPASS_BRIDGE = `http://127.0.0.1:${bridgePort}`; // the chat-path client must find the sandbox bridge
  return env;
}

/**
 * Stage 2 — sandboxed live smoke. Starts bridge + backend from source, checks
 * them, takes everything down again. Every failure path still runs teardown —
 * unless `--chat` asked for the bridge to be kept alive for stage 3, in which
 * case teardown is handed up to the orchestrator as `context.finalize`.
 */
async function runSmoke({ keepBridge = false, bridgePort: explicitBridgePort = null, backendPort: explicitBackendPort = null } = {}) {
  const t0 = Date.now();
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'aipass-verify-'));
  const home = path.join(sandbox, 'home');
  const project = path.join(sandbox, 'project');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(project, { recursive: true });

  let bridgePort;
  let backendPort;
  let bridge;
  let backend;
  let keep = false; // --chat and the smoke passed: the bridge stays up for stage 3
  const notes = [];
  const cleanup = async () => {
    await stopChild(bridge);
    try { fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 3 }); } catch { /* temp dir best-effort */ }
  };

  try {
    bridgePort = await pickPort(explicitBridgePort, 'bridge port');
    backendPort = await pickPort(explicitBackendPort ?? bridgePort + 1, 'backend port');
    if (backendPort === bridgePort) throw new Error('bridge and backend sandbox ports must differ');
    const env = sandboxEnv({ home, bridgePort, backendPort });

    bridge = startChild([path.join(REPO, 'aipass-bridge', 'bridge', 'server.mjs')], env, 'bridge');
    backend = startChild(
      [path.join(REPO, 'aipass-bridge', 'harness', 'rpc.mjs'), '--port', String(backendPort), '--root', project],
      env,
      'backend',
    );

    await waitReady('bridge', bridge, async () => {
      const { status, body } = await httpJson(bridgePort, { pathname: '/health' });
      return status === 200 && body?.ok === true;
    });
    await waitReady('backend', backend, async () => {
      const { status, body } = await httpJson(backendPort, { method: 'POST', pathname: '/rpc', body: { method: 'settings.get' } });
      return status === 200 && body?.ok === true;
    });

    const rpcCall = () => httpJson(backendPort, { method: 'POST', pathname: '/rpc', body: { method: 'settings.get' } });
    const checks = [
      ['bridge GET /health', async () => {
        const { status, body } = await httpJson(bridgePort, { pathname: '/health' });
        if (status !== 200 || body?.ok !== true) throw new Error(`status ${status}, ok=${body?.ok}`);
      }],
      ['bridge GET /status', async () => {
        const { status, body } = await httpJson(bridgePort, { pathname: '/status' });
        const ok = status === 200 && body?.ok === true
          && body.extensions === 0 && Array.isArray(body.models);
        if (!ok) throw new Error(`status ${status}, extensions=${body?.extensions}, models=${Array.isArray(body?.models) ? 'array' : typeof body?.models}`);
      }],
      ['bridge GET /v1/models', async () => {
        const { status, body } = await httpJson(bridgePort, { pathname: '/v1/models' });
        const ok = status === 200 && body?.object === 'list' && Array.isArray(body?.data)
          && body.data.length > 0 && body.data.every((m) => typeof m?.id === 'string' && m.id.length > 0);
        if (!ok) throw new Error(`status ${status}, object=${body?.object}, entries=${body?.data?.length}`);
      }],
      ['backend RPC handshake (settings.get)', async () => {
        const { status, body } = await rpcCall();
        if (status !== 200 || body?.ok !== true || typeof body?.result !== 'object' || body.result === null) {
          throw new Error(`status ${status}, ok=${body?.ok}, result=${typeof body?.result}`);
        }
      }],
      ['backend GET / serves the window', async () => {
        const { status, body: html } = await httpExchange(backendPort, { pathname: '/' });
        if (status !== 200) throw new Error(`status ${status}`);
        if (!html.includes('<title>aipass desktop</title>')) throw new Error('window title not found in GET /');
      }],
      ['backend GET /app.js serves a UI asset', async () => {
        const { status, headers } = await httpExchange(backendPort, { pathname: '/app.js' });
        const type = String(headers['content-type'] ?? '');
        if (status !== 200) throw new Error(`status ${status}`);
        if (!type.includes('javascript')) throw new Error(`content-type ${type}`);
      }],
      ['sandbox isolation (writes land in the throwaway HOME, not yours)', async () => {
        const marker = path.join(home, '.aipass', 'settings.json');
        const deadline = Date.now() + 3_000;
        while (!fs.existsSync(marker) && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
        if (!fs.existsSync(marker)) throw new Error(`no settings file appeared under the sandbox HOME (${home})`);
        notes.push(`sandbox HOME saw the backend's settings write (${path.join('.aipass', 'settings.json')})`);
      }],
    ];

    const failures = [];
    for (const [name, check] of checks) {
      try {
        await check();
        say(`    ok   ${name}`);
      } catch (err) {
        say(`    FAIL ${name} — ${err.message}`);
        failures.push(`${name}: ${err.message}`);
      }
    }

    if (failures.length) {
      return {
        status: 'FAIL',
        detail: `${checks.length - failures.length}/${checks.length} checks passed — ${failures.join('; ')}`,
        seconds: since(t0),
        context: { bridgePort, backendPort },
      };
    }
    keep = keepBridge;
    return {
      status: 'PASS',
      detail: `${checks.length}/${checks.length} checks (bridge 127.0.0.1:${bridgePort}, backend 127.0.0.1:${backendPort})${notes.length ? ` — ${notes.join('; ')}` : ''}`,
      seconds: since(t0),
      context: { bridgePort, ...(keep ? { finalize: cleanup } : {}) },
    };
  } catch (err) {
    return { status: 'FAIL', detail: err.message, seconds: since(t0), context: bridgePort ? { bridgePort } : {} };
  } finally {
    await stopChild(backend);
    if (!keep) await cleanup();
  }
}

const since = (t0) => Number(((Date.now() - t0) / 1000).toFixed(1));

/* ------------------------------------------------------------- stage 3: chat */

/**
 * Stage 3 (`--chat`) — one tiny real chat, through the bridge's normal
 * extension path only. No extension connected is PENDING-LOGIN and a SKIP:
 * the smoke stage proved the bridge itself is healthy.
 */
async function runChat({ bridgePort } = {}) {
  const t0 = Date.now();
  if (!bridgePort) {
    return { status: 'SKIP', detail: 'no sandbox bridge from the smoke stage to chat through', seconds: since(t0) };
  }
  const how = `To exercise the chat path here, load the extension (aipass-bridge/extension) pointed at this sandbox bridge — AIPASS_BRIDGE=http://127.0.0.1:${bridgePort} — open a logged-in de.aipass.net tab, then re-run with --chat.`;

  let status;
  try {
    ({ body: status } = await httpJson(bridgePort, { pathname: '/status' }));
  } catch (err) {
    return { status: 'SKIP', detail: `sandbox bridge /status unreachable (${err.message}) — see the smoke stage's result`, seconds: since(t0) };
  }
  const extensions = status?.extensions;
  if (!Number.isInteger(extensions) || extensions === 0) {
    return {
      status: 'SKIP',
      detail: `PENDING-LOGIN — no extension connected to the sandbox bridge (127.0.0.1:${bridgePort}); this is not a failure. ${how}`,
      seconds: since(t0),
    };
  }

  try {
    const { status: code, stream } = await httpExchange(bridgePort, {
      method: 'POST',
      pathname: '/v1/chat/completions',
      headers: { 'content-type': 'application/json' },
      body: jsonBody({ stream: true, messages: [{ role: 'user', content: 'Reply with exactly: ok' }] }),
      streaming: true,
      timeoutMs: CHAT_TIMEOUT_MS,
    });
    if (code === 503) {
      stream.resume(); // drain whatever error body follows
      return { status: 'SKIP', detail: `PENDING-LOGIN — the bridge answered 503 (extension gone?). ${how}`, seconds: since(t0) };
    }
    if (code !== 200) {
      stream.resume();
      return { status: 'FAIL', detail: `bridge returned ${code}`, seconds: since(t0) };
    }

    let text = '';
    const timeout = setTimeout(() => stream.destroy(new Error(`chat exceeded ${CHAT_TIMEOUT_MS / 1000}s`)), CHAT_TIMEOUT_MS);
    try {
      for await (const chunk of stream) {
        for (const line of chunk.toString('utf8').split('\n')) {
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (!data || data === '[DONE]') continue;
          try {
            const evt = JSON.parse(data);
            text += evt.choices?.[0]?.delta?.content ?? '';
          } catch { /* keep-alive or partial frame */ }
        }
        if (text.toLowerCase().includes('ok')) break; // enough — one turn proved the path
      }
    } finally {
      clearTimeout(timeout);
    }
    if (!text.trim()) return { status: 'FAIL', detail: 'chat stream completed with no text', seconds: since(t0) };
    return { status: 'PASS', detail: `extension answered through the sandbox bridge: ${JSON.stringify(text.trim().slice(0, 40))}`, seconds: since(t0) };
  } catch (err) {
    return { status: 'FAIL', detail: `chat failed: ${err.message}`, seconds: since(t0) };
  }
}

/* ---------------------------------------------------------------- orchestration */

function parseArgs(argv) {
  const opts = { chat: false, skipTests: false, bridgePort: null, backendPort: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const num = (label) => {
      const v = Number(argv[++i]);
      if (!Number.isInteger(v) || v < 1 || v > 65535) throw new Error(`${label} needs an integer port, got ${argv[i] ?? '(nothing)'}`);
      return v;
    };
    if (arg === '--chat') opts.chat = true;
    else if (arg === '--skip-tests') opts.skipTests = true;
    else if (arg === '--bridge-port') opts.bridgePort = num('--bridge-port');
    else if (arg === '--backend-port') opts.backendPort = num('--backend-port');
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else throw new Error(`unknown argument: ${arg}\n${USAGE}`);
  }
  return opts;
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    say(err.message);
    process.exitCode = 2;
    return;
  }
  if (opts.help) {
    say(USAGE);
    return;
  }

  say(`aipass verify — Node ${process.version} — ${new Date().toISOString()}`);
  say(`repo ${REPO}; live-stack ports ${[...PROTECTED_PORTS].join('/')} are protected; sandbox uses ${PORT_BASE}+`);
  say('');

  const stages = [];
  if (!opts.skipTests) stages.push(['tests', () => runTests()]);
  stages.push(['smoke', () => runSmoke({
    keepBridge: opts.chat,
    bridgePort: opts.bridgePort,
    backendPort: opts.backendPort,
  })]);
  if (opts.chat) stages.push(['chat', (ctx) => runChat(ctx)]);

  const results = [];
  const ctx = {};
  try {
    for (let i = 0; i < stages.length; i++) {
      const [name, run] = stages[i];
      say(`[${i + 1}/${stages.length}] stage ${name} — starting`);
      let result;
      try {
        result = await run(ctx);
      } catch (err) {
        result = { status: 'FAIL', detail: err.message, seconds: 0 };
      }
      if (result.context) Object.assign(ctx, result.context);
      results.push({ name, ...result });
      say(`[${i + 1}/${stages.length}] stage ${name} — ${result.status}${result.seconds != null ? ` (${result.seconds}s)` : ''}`);
      if (result.detail) say(`         ${result.detail}`);
      say('');
    }
  } finally {
    if (ctx.finalize) await ctx.finalize(); // the sandbox bridge --chat kept alive
  }

  const failed = results.filter((r) => r.status === 'FAIL');
  const skipped = results.filter((r) => r.status === 'SKIP');
  const passed = results.filter((r) => r.status === 'PASS');
  const totalSeconds = results.reduce((sum, r) => sum + (r.seconds ?? 0), 0).toFixed(1);

  say('──────────────────────────────');
  for (const r of results) say(`  ${r.name.padEnd(6)} ${r.status}${r.detail ? `  ${r.detail}` : ''}`);
  say('──────────────────────────────');
  if (failed.length) {
    say(`result: FAILED — ${failed.length} stage(s) failed, ${passed.length} passed, ${skipped.length} skipped (${totalSeconds}s total)`);
    process.exitCode = 1;
    return;
  }
  say(`result: OK — ${passed.length} stage(s) passed, ${skipped.length} skipped (${totalSeconds}s total)`);
  // No process.exit here: the loop drains on its own, with no keep-alive
  // sockets (agent: false) and no live children left to hold it open.
}

main().catch((err) => {
  say(`verify crashed: ${err?.stack ?? err}`);
  process.exitCode = 1;
});
