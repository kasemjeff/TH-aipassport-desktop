#!/usr/bin/env node
// aipass — one command for the bridge, the chat client, and the file agent.
// Zero dependencies; every subcommand just spawns one of the sibling *.mjs
// files. `aipass` on its own starts the bridge in the background if it isn't
// already up, then opens the chat.
//
//   aipass                 open the chat TUI
//   aipass "question"      one-shot
//   aipass dev             run the bridge in the foreground (Ctrl+C to stop)
//   aipass agent "task"    run the file agent against the current directory
//   aipass models          list models
//   aipass conversations   list conversations
//   aipass status          check node / bridge / extension
//   aipass stop            stop a bridge that `aipass` started
//
//   env: AIPASS_PORT (8787), AIPASS_HOST (127.0.0.1)
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync, existsSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const sibling = (name) => join(HERE, '..', name);          // aipass-bridge/<name>
const HOST = process.env.AIPASS_HOST || '127.0.0.1';
const PORT = process.env.AIPASS_PORT || '8787';
const BRIDGE = `http://${HOST}:${PORT}`;
const STATE = process.env.AIPASS_HOME?.trim() || join(homedir(), '.aipass');
const PIDFILE = join(STATE, 'bridge.pid');

const tty = Boolean(process.stdout.isTTY);
const dim = (s) => (tty ? `\x1b[2m${s}\x1b[0m` : String(s));
const red = (s) => (tty ? `\x1b[31m${s}\x1b[0m` : String(s));

const [cmd, ...rest] = process.argv.slice(2);

/** Run one of the sibling CLIs, inheriting stdio so the TUI works. */
const run = (file, args, opts = {}) =>
  new Promise((resolve) => {
    const c = spawn(process.execPath, [sibling(file), ...args], { stdio: 'inherit', ...opts });
    c.on('close', (code) => resolve(code ?? 0));
  });

const bridgeUp = () =>
  fetch(`${BRIDGE}/status`, { signal: AbortSignal.timeout(1500) })
    .then((r) => r.ok)
    .catch(() => false);

/** Ensure the bridge is running — starting it in the background if it is not. */
async function ensureBridge() {
  if (await bridgeUp()) return;
  // The help text has always promised `aipass` starts the bridge itself; this
  // is that promise. Detached, stdio ignored, pid recorded — `aipass stop`
  // reads exactly this file — then wait for /status before talking to it.
  mkdirSync(STATE, { recursive: true });
  const child = spawn(process.execPath, [sibling('bridge/server.mjs')], { detached: true, stdio: 'ignore', env: process.env });
  child.unref();
  writeFileSync(PIDFILE, `${child.pid}\n`);
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await bridgeUp()) {
      console.log(dim(`started the bridge in the background (pid ${child.pid}; aipass stop ends it)`));
      return;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  try { process.kill(child.pid); } catch { /* never started */ }
  rmSync(PIDFILE, { force: true });
  process.stderr.write(
    red(`\n✗ Bridge not running at ${BRIDGE}\n`) +
    dim(`  It was started in the background but did not answer. Run it in the foreground to see why:\n`) +
    `  ${dim('$')} \x1b[36maipass dev\x1b[0m   ${dim('(or npm run dev)')}\n\n`
  );
  process.exit(1);
}

function stopBridge() {
  if (!existsSync(PIDFILE)) {
    console.log('no background bridge running (a `aipass dev` / `npm run dev` bridge you stop with Ctrl+C)');
    return;
  }
  const pid = Number(readFileSync(PIDFILE, 'utf8').trim());
  try { process.kill(pid); console.log(`stopped the bridge (pid ${pid})`); }
  catch { console.log(`bridge pid ${pid} was not running`); }
  rmSync(PIDFILE, { force: true });
}

async function status() {
  const major = Number(process.versions.node.split('.')[0]);
  console.log(`node          ${process.versions.node}${major >= 22 ? '' : red('  ✗ need >= 22')}`);

  const up = await bridgeUp();
  console.log(`bridge        ${up ? `${BRIDGE}  ok` : `${BRIDGE}  ${red('not running')} — run \`aipass dev\` (or npm run dev)`}`);
  if (!up) return;

  const s = await fetch(`${BRIDGE}/status`).then((r) => r.json()).catch(() => null);
  const ext = s && typeof s.extensions === 'number' ? s.extensions : 0;
  console.log(`extension     ${ext ? `${ext} connected` : red('0') + ' — load aipass-bridge/extension in Chrome and open a https://de.aipass.net/chat tab'}`);
  console.log(`model         ${s?.defaultModel ?? '?'}`);
  console.log(`conversation  ${s?.conversation ?? dim('(resolves on first message)')}`);
  console.log(`active jobs   ${s?.activeJobs ?? 0}`);
}

const HELP = `aipass — de.aipass.net from your terminal

  aipass dev             run the bridge in the foreground (Ctrl+C to stop)
  aipass desktop         open the desktop app (bridge + agent window)
  aipass                 open the chat TUI (requires bridge running)
  aipass "question"      one-shot question
  aipass agent "task"    run the file agent against the current directory
  aipass models          list models
  aipass styles          list video & image style presets
  aipass conversations   list conversations
  aipass credits         check credit quota
  aipass doctor          run diagnostics
  aipass setup-assistant configure custom assistant
  aipass setup           first-run setup: Node, PATH, token, bridge, browser pages
  aipass memory          list/clear facts carried across sessions for this project
  aipass scale "task"    test-time scaling: run a task N times, keep the best
  aipass mcp             list/call tools from configured MCP servers
  aipass status          check node / bridge / extension status
  aipass stop            stop any lingering background bridge

  env: AIPASS_PORT (${PORT}), AIPASS_HOST (${HOST})`;

switch (cmd) {
  case undefined:
  case 'chat':
    await ensureBridge();
    process.exit(await run('chat.mjs', ['--bridge', BRIDGE, ...rest]));
    break;

  case 'dev':
    process.exit(await run('bridge/server.mjs', rest));
    break;

  case 'desktop':
    // The desktop window: bridge (if needed) + harness backend + UI.
    process.exit(await run('../../desktop/main.mjs', rest));
    break;

  case 'agent':
    await ensureBridge();
    // agent.mjs already defaults --root to the current directory.
    process.exit(await run('agent.mjs', [...rest, '--bridge', BRIDGE]));
    break;

  case 'models':
  case 'conversations':
  case 'credits':
  case 'styles':
    await ensureBridge();
    process.exit(await run('list.mjs', [cmd, ...rest], { env: { ...process.env, AIPASS_BRIDGE: BRIDGE } }));
    break;

  case 'doctor':
    process.exit(await run('doctor.mjs', ['--bridge', BRIDGE, ...rest]));
    break;

  case 'setup-assistant':
    await ensureBridge();
    process.exit(await run('setup-assistant.mjs', ['--bridge', BRIDGE, ...rest]));
    break;

  case 'setup':
    process.exit(await run('setup.mjs', rest));
    break;

  case 'memory':
    process.exit(await run('memory.mjs', rest));
    break;

  case 'scale':
    process.exit(await run('scale.mjs', rest));
    break;

  case 'mcp':
    process.exit(await run('mcp.mjs', rest));
    break;

  case 'status':
    await status();
    process.exit(0);
    break;

  case 'stop':
    stopBridge();
    process.exit(0);
    break;

  case 'help':
  case '--help':
  case '-h':
    console.log(HELP);
    process.exit(0);
    break;

  default:
    // Anything else is treated as a one-shot question.
    await ensureBridge();
    process.exit(await run('chat.mjs', ['--bridge', BRIDGE, cmd, ...rest]));
}
