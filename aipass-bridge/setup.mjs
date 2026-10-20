#!/usr/bin/env node
// aipass setup — one command to get a machine ready to use aipass.
//
//   aipass setup            (or: npm run setup)
//   aipass setup --no-open  don't open browser pages
//   aipass setup --no-bridge don't start/adopt the bridge
//
// Checks Node, puts `aipass` on PATH, mints the loopback token (and copies it
// to the clipboard), starts the bridge, and opens the extension + site pages so
// the one-time browser steps can be finished. Idempotent — re-run any time.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { homedir, platform } from 'node:os';
import { loadOrMintToken, tokenPath } from './harness/authtoken.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const BRIDGE_DIR = path.join(ROOT, 'aipass-bridge');
const EXT_DIR = path.join(BRIDGE_DIR, 'extension');
const STATE = process.env.AIPASS_HOME?.trim() || path.join(homedir(), '.aipass');
const PORT = process.env.AIPASS_PORT || '8787';
const HOST = process.env.AIPASS_HOST || '127.0.0.1';
const BRIDGE = `http://${HOST}:${PORT}`;

const tty = Boolean(process.stdout.isTTY);
const dim = (s) => (tty ? `\x1b[2m${s}\x1b[0m` : String(s));
const red = (s) => (tty ? `\x1b[31m${s}\x1b[0m` : String(s));
const green = (s) => (tty ? `\x1b[32m${s}\x1b[0m` : String(s));
const bold = (s) => (tty ? `\x1b[1m${s}\x1b[0m` : String(s));

const args = process.argv.slice(2);
const noOpen = args.includes('--no-open');
const noBridge = args.includes('--no-bridge');
const help = args.includes('--help') || args.includes('-h');

if (help) {
  console.log(`aipass setup — first-run machine setup

  aipass setup            check Node, PATH, token, bridge, browser pages
  aipass setup --no-open  don't open browser pages
  aipass setup --no-bridge don't start/adopt the bridge
  aipass setup --help     this help

  (npm run setup does the same thing from the repo directory)`);
  process.exit(0);
}

function step(n, title) { console.log(`\n${bold(`[${n}] ${title}`)}`); }
function ok(msg) { console.log(`  ${green('✓')} ${msg}`); }
function warn(msg) { console.log(`  ${red('✗')} ${msg}`); }
function info(msg) { console.log(`  ${dim(msg)}`); }

// 1. Node
step(1, 'Node');
const major = Number(process.versions.node.split('.')[0]);
if (major < 22) {
  warn(`need Node >= 22 (have ${process.versions.node}) — https://nodejs.org`);
  process.exit(1);
}
ok(`Node ${process.versions.node}`);

// 2. State dir + token
step(2, 'State directory & loopback token');
fs.mkdirSync(STATE, { recursive: true });
const token = loadOrMintToken(STATE);
const tp = tokenPath(STATE);
ok(`state dir: ${STATE}`);
ok(`token file: ${tp}`);
info(`token prefix: ${token.slice(0, 8)}… (full token is in the file above)`);

// 3. PATH
step(3, 'Putting `aipass` on your PATH');
function aipassOnPath() {
  try {
    const cmd = platform() === 'win32' ? 'where' : 'which';
    const out = execFileSync(cmd, ['aipass'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return out.split(/\r?\n/)[0] || null;
  } catch {
    return null;
  }
}
const ourBin = path.join(BRIDGE_DIR, 'bin', 'aipass.mjs');
let installed = false;
const found = aipassOnPath();
if (found) {
  ok(`already installed: ${found}`);
  installed = true;
} else if (platform() === 'win32') {
  try {
    execFileSync('npm', ['link'], { cwd: ROOT, stdio: 'inherit' });
    ok('installed via `npm link`');
    installed = true;
  } catch {
    warn('`npm link` failed');
    info('manual: npm config set prefix "$env:LOCALAPPDATA\\npm"; npm link');
    info(`or call directly: node "${ourBin}" --help`);
  }
} else {
  const binds = [path.join(homedir(), '.local', 'bin'), path.join(homedir(), 'bin')];
  const onPathBind = binds.find((d) => (process.env.PATH || '').split(':').includes(d));
  if (onPathBind) {
    fs.mkdirSync(onPathBind, { recursive: true });
    const link = path.join(onPathBind, 'aipass');
    try { fs.unlinkSync(link); } catch { /* not there */ }
    try {
      fs.symlinkSync(ourBin, link);
      try { fs.chmodSync(ourBin, 0o755); } catch { /* best effort */ }
      ok(`symlinked: ${link} -> ${ourBin}`);
      installed = true;
    } catch (e) {
      warn(`symlink failed: ${e.message}`);
    }
  }
  if (!installed) {
    try {
      execFileSync('npm', ['link'], { cwd: ROOT, stdio: 'inherit' });
      ok('installed via `npm link`');
      installed = true;
    } catch {
      warn('`npm link` failed');
      info('manual options: sh aipass-bridge/install.sh');
    }
  }
}
if (!installed) {
  info(`you can still run without installing: node "${ourBin}" --help`);
}

// 4. Clipboard (best effort)
step(4, 'Copying the token to your clipboard (best effort)');
let copied = false;
try {
  if (platform() === 'darwin') {
    execFileSync('pbcopy', [], { input: token, stdio: ['pipe', 'ignore', 'ignore'] });
    copied = true;
  } else if (platform() === 'win32') {
    execFileSync('clip', [], { input: token, stdio: ['pipe', 'ignore', 'ignore'] });
    copied = true;
  } else {
    try { execFileSync('xclip', ['-selection', 'clipboard'], { input: token, stdio: ['pipe', 'ignore', 'ignore'] }); copied = true; }
    catch { try { execFileSync('xsel', ['--clipboard', '--input'], { input: token, stdio: ['pipe', 'ignore', 'ignore'] }); copied = true; } catch { /* no clipboard tool */ } }
  }
} catch { /* clipboard unavailable */ }
if (copied) ok('token copied to clipboard — paste it into the extension popup -> Advanced -> Loopback token');
else info(`clipboard unavailable; copy the token from ${tp}`);

// 5. Bridge
if (!noBridge) {
  step(5, 'Bridge');
  async function bridgeUp() {
    try { const r = await fetch(`${BRIDGE}/status`, { signal: AbortSignal.timeout(1500) }); return r.ok; } catch { return false; }
  }
  if (await bridgeUp()) {
    ok(`bridge already running at ${BRIDGE}`);
  } else {
    const child = spawn(process.execPath, [path.join(BRIDGE_DIR, 'bridge', 'server.mjs')], { detached: true, stdio: 'ignore', env: process.env });
    child.unref();
    fs.mkdirSync(STATE, { recursive: true });
    fs.writeFileSync(path.join(STATE, 'bridge.pid'), `${child.pid}\n`);
    const deadline = Date.now() + 15000;
    let up = false;
    while (Date.now() < deadline) {
      if (await bridgeUp()) { up = true; break; }
      await new Promise((r) => setTimeout(r, 300));
    }
    if (up) ok(`started bridge in background (pid ${child.pid})`);
    else warn('bridge did not answer; run `aipass dev` to see why');
  }
  try {
    const s = await fetch(`${BRIDGE}/status`).then((r) => r.json());
    const ext = typeof s.extensions === 'number' ? s.extensions : 0;
    info(`extension: ${ext} connected  |  model: ${s?.defaultModel ?? '?'}  |  conversation: ${s?.conversation ?? '(resolves on first message)'}`);
  } catch { /* ignore */ }
}

// 6. Browser pages
if (!noOpen) {
  step(6, 'Opening the browser steps');
  info(`extension folder: ${EXT_DIR}`);
  function openUrl(url) {
    try {
      if (platform() === 'win32') execFileSync('cmd', ['/c', 'start', '', url], { stdio: 'ignore' });
      else if (platform() === 'darwin') execFileSync('open', [url], { stdio: 'ignore' });
      else execFileSync('xdg-open', [url], { stdio: 'ignore' });
      return true;
    } catch { return false; }
  }
  if (openUrl('https://de.aipass.net/chat')) ok('opened https://de.aipass.net/chat — log in and leave the tab open');
  else info('open manually: https://de.aipass.net/chat');
  let openedExt = false;
  try {
    if (platform() === 'win32') { execFileSync('cmd', ['/c', 'start', '', 'chrome://extensions'], { stdio: 'ignore' }); openedExt = true; }
    else if (platform() === 'darwin') { execFileSync('open', ['-a', 'Google Chrome', 'chrome://extensions'], { stdio: 'ignore' }); openedExt = true; }
    else { execFileSync('xdg-open', ['chrome://extensions'], { stdio: 'ignore' }); openedExt = true; }
  } catch { /* best effort */ }
  if (openedExt) ok('opened chrome://extensions — Developer mode -> Load unpacked -> select the folder above');
  else info('open manually: chrome://extensions -> Developer mode -> Load unpacked -> select the folder above');
}

console.log(`\n${bold('Setup complete.')}`);
console.log(dim('  Next:'));
console.log('    aipass            open the chat (starts the bridge for you if needed)');
console.log('    aipass status     check node / bridge / extension');
console.log('    aipass doctor     full diagnostics');
console.log('    aipass --help     everything else');
console.log(dim('\n  One-time browser step (if not done yet):'));
console.log(dim(`    1. chrome://extensions -> Developer mode -> Load unpacked -> ${EXT_DIR}`));
console.log(dim('    2. https://de.aipass.net/chat -> log in, leave the tab open'));
console.log(dim('    3. extension popup -> Advanced -> paste the token (already on your clipboard) -> save'));
console.log(dim('\n  Uninstall the command: npm rm -g aipass  (or remove the symlink aipass setup created)'));
