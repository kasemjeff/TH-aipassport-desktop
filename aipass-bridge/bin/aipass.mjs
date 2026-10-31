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
//   aipass providers       list the API providers (add/remove/use)
//   aipass conversations   list conversations
//   aipass status          check node / bridge / extension
//   aipass stop            stop a bridge that `aipass` started
//
//   env: AIPASS_PORT (8787), AIPASS_HOST (127.0.0.1)
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { bridgePidFile, forgetBridgePid, stopRecordedBridge } from '../harness/bridge-pid.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const sibling = (name) => join(HERE, '..', name);          // aipass-bridge/<name>
const HOST = process.env.AIPASS_HOST || '127.0.0.1';
const PORT = process.env.AIPASS_PORT || '8787';
const BRIDGE = `http://${HOST}:${PORT}`;
const STATE = process.env.AIPASS_HOME?.trim() || join(homedir(), '.aipass');
// The pid file belongs to the bridge: the bridge writes it when it binds, so
// it always names the process that is really answering. `aipass stop` reads
// exactly this file, and the test suite points it somewhere it can reach.
const PIDFILE = bridgePidFile();

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

// Exit by drain, not process.exit(): on Windows, process.exit() right after
// network I/O races Node's teardown and trips libuv's assert in
// win/async.c:94 (0xC0000409) — the process aborts *after* printing a
// perfect report, so `aipass status` showed everything and still exited with
// a crash code (nodejs/node#56645). Setting exitCode and letting the loop
// run out produces the same code cleanly.
//
// The loop only runs out once the keep-alive socket is gone, so the sockets
// are drained on the way out: an open connection would hold the process for
// seconds after the work is done.
function finish(code = 0) {
  process.exitCode = code;
  try { globalThis[Symbol.for('undici.globalDispatcher.1')]?.destroy?.(); } catch { /* nothing to drain */ }
}

/** Ensure the bridge is running — starting it in the background if it is not. */
async function ensureBridge() {
  if (await bridgeUp()) return true;
  // The help text has always promised `aipass` starts the bridge itself; this
  // is that promise. Detached, stdio ignored, pid recorded — `aipass stop`
  // reads exactly this file — then wait for /status before talking to it.
  mkdirSync(STATE, { recursive: true });
  const child = spawn(process.execPath, [sibling('bridge/server.mjs')], { detached: true, stdio: 'ignore', env: process.env });
  child.unref();
  // The pid file belongs to the BRIDGE, not to whoever started it: the bridge
  // writes it when it binds, so the file always names the process that is
  // really answering. A starter that wrote it here could leave the file
  // naming a process that lost the race for the port and died — and then
  // `aipass stop` would stop nothing and the live bridge would stay.
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await bridgeUp()) {
      console.log(dim(`started the bridge in the background (pid ${child.pid}; aipass stop ends it)`));
      return true;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  try { process.kill(child.pid); } catch { /* never started */ }
  forgetPidIfOurs(child.pid);
  process.stderr.write(
    red(`\n✗ Bridge not running at ${BRIDGE}\n`) +
    dim(`  It was started in the background but did not answer. Run it in the foreground to see why:\n`) +
    `  ${dim('$')} \x1b[36maipass dev\x1b[0m   ${dim('(or npm run dev)')}\n\n`
  );
  finish(1);
  return false;
}

/**
 * Drop this pid from the pid file, and only this one.
 *
 * The file is the bridge's, and the bridge writes it when it binds. A bridge
 * that DID bind and answered — while our probe was too slow to see it — must
 * not have its pid removed by the starter that gave up, and the bridges that
 * are still up must stay in the file.
 */
function forgetPidIfOurs(pid) {
  try { forgetBridgePid({ pid }); } catch { /* never written */ }
}

function stopBridge() {
  if (!existsSync(PIDFILE)) {
    console.log('no background bridge running (a `aipass dev` / `npm run dev` bridge you stop with Ctrl+C)');
    return;
  }
  // The file names EVERY bridge of ours that is still running — the desktop's
  // and a second one on another port are both real — and this ends them all.
  const ended = stopRecordedBridge();
  if (!ended.length) {
    console.log('no background bridge running (a `aipass dev` / `npm run dev` bridge you stop with Ctrl+C)');
    return;
  }
  for (const pid of ended) console.log(`stopped the bridge (pid ${pid})`);
}

async function status() {
  const major = Number(process.versions.node.split('.')[0]);
  console.log(`node          ${process.versions.node}${major >= 20 ? '' : red('  ✗ need >= 20')}`);

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
  aipass providers       list / add / remove / use the API providers
  aipass styles          list video & image style presets
  aipass conversations   list conversations
  aipass credits         check credit quota
  aipass doctor          run diagnostics
  aipass setup-assistant configure custom assistant
  aipass setup           first-run setup: Node, PATH, token, bridge, browser pages
  aipass memory          list/clear facts carried across sessions for this project
  aipass goal            set/show the one durable goal this project is working toward
  aipass sessions        list/archive/restore this project's conversations
  aipass relocate        re-key a project's stored data after its folder moved
  aipass scale "task"    test-time scaling: run a task N times, keep the best
  aipass plugin          install/inspect/enable/disable/remove plugins
  aipass mcp             add/remove/list MCP servers and call their tools
  aipass status          check node / bridge / extension status
  aipass stop            stop any lingering background bridge

  env: AIPASS_PORT (${PORT}), AIPASS_HOST (${HOST})`;

switch (cmd) {
  case undefined:
  case 'chat':
    if (!(await ensureBridge())) break;
    finish(await run('chat.mjs', ['--bridge', BRIDGE, ...rest]));
    break;

  case 'dev':
    finish(await run('bridge/server.mjs', rest));
    break;

  case 'desktop':
    // The desktop window: bridge (if needed) + harness backend + UI.
    finish(await run('../../desktop/main.mjs', rest));
    break;

  case 'agent':
    if (!(await ensureBridge())) break;
    // agent.mjs already defaults --root to the current directory.
    finish(await run('agent.mjs', [...rest, '--bridge', BRIDGE]));
    break;

  case 'models':
  case 'conversations':
  case 'credits':
  case 'styles':
    if (!(await ensureBridge())) break;
    finish(await run('list.mjs', [cmd, ...rest], { env: { ...process.env, AIPASS_BRIDGE: BRIDGE } }));
    break;

  case 'providers':
    // The provider registry is a file, not a bridge: it is read and written
    // here, so it needs no bridge and no extension.
    finish(await run('providers.mjs', rest));
    break;

  case 'doctor':
    finish(await run('doctor.mjs', ['--bridge', BRIDGE, ...rest]));
    break;

  case 'setup-assistant':
    if (!(await ensureBridge())) break;
    finish(await run('setup-assistant.mjs', ['--bridge', BRIDGE, ...rest]));
    break;

  case 'setup':
    finish(await run('setup.mjs', rest));
    break;

  case 'memory':
    finish(await run('memory.mjs', rest));
    break;

  case 'goal':
    // The goal is a local file, like memory: no bridge, no model turn.
    finish(await run('goal.mjs', rest));
    break;

  case 'sessions':
    // The conversations on disk: list them, move the idle ones into the
    // archive, take one back out of it, or delete the ones that have sat in
    // the archive too long. No bridge needed — the store is local.
    finish(await run('sessions.mjs', rest));
    break;

  case 'relocate':
    finish(await run('relocate.mjs', rest));
    break;

  case 'scale':
    finish(await run('scale.mjs', rest));
    break;

  case 'acp':
    // ACP over stdio: no bridge needed, the harness is the brain.
    finish(await run('acp.mjs', rest));
    break;

  case 'mcp':
    finish(await run('mcp.mjs', rest));
    break;

  case 'plugin':
    finish(await run('plugin.mjs', rest));
    break;

  case 'status':
    await status();
    finish(0);
    break;

  case 'stop':
    stopBridge();
    finish(0);
    break;

  case 'help':
  case '--help':
  case '-h':
    console.log(HELP);
    finish(0);
    break;

  default:
    // Anything else is treated as a one-shot question.
    if (!(await ensureBridge())) break;
    finish(await run('chat.mjs', ['--bridge', BRIDGE, cmd, ...rest]));
}
