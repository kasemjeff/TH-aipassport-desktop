// The platform branches a Windows dev machine cannot run: the argv each OS
// gets when a URL is opened, the sidecar name a mac build asks for, and the
// allowlist that runs before browser.open spawns anything. Extracting the
// rules made them testable from anywhere; the macOS CI lane is what proves
// the parts that need the OS itself (spawning `open`, the window bundle).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openCommandFor } from '../harness/open-command.mjs';
// openBrowser comes from the backend's own surface (it re-exports the rule),
// the bookkeeping from the module that owns it.
import { openBrowser } from '../harness/rpc.mjs';
import { recordBrowser, closeOpenedBrowsers } from '../harness/browser.mjs';
import { targetTriple, sidecarNodeGate, REQUIRED_NODE_MAJOR } from '../../desktop/sidecar/fetch-node.mjs';

const URL_UNDER_TEST = 'https://example.com/a?b=1&c=2';
const WINDOWS_CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

test('the platform→argv rule: one URL as one argument, three shapes', () => {
  const url = URL_UNDER_TEST;
  // No Chrome on the machine: the platform default is the fallback, and it
  // keeps its shape — cmd's `start` with its empty title, so the URL cannot
  // become the window title.
  const none = () => false;
  assert.deepEqual(openCommandFor('win32', url, { exists: none }), ['cmd', ['/c', 'start', '', url]],
    'cmd start keeps its empty title so the URL cannot become the window title');
  assert.deepEqual(openCommandFor('darwin', url, { exists: none }), ['open', [url]], 'macOS opens through `open`');
  assert.deepEqual(openCommandFor('linux', url, { env: { PATH: '/usr/bin' }, exists: none }), ['xdg-open', [url]],
    'linux opens through `xdg-open`');
  for (const platform of ['win32', 'darwin', 'linux']) {
    const [cmd, args] = openCommandFor(platform, url, { exists: none });
    assert.ok(args.includes(url), `the URL rides as one argv element on ${platform}`);
    assert.ok(!cmd.includes(url), 'the URL is never part of the executable name');
  }
});

test('the browser rule: Chrome first, because that is where the extension lives', () => {
  const url = URL_UNDER_TEST;
  // Windows: the Chrome that is installed gets the URL as one argument.
  assert.deepEqual(
    openCommandFor('win32', url, { env: { ProgramFiles: 'C:\\Program Files' }, exists: (p) => p === WINDOWS_CHROME }),
    [WINDOWS_CHROME, [url]],
    'the chat tab opens in Chrome, not in the machine default');
  // macOS goes through `open -a`, so the Chrome that is already running is
  // reused instead of a second one being started.
  assert.deepEqual(
    openCommandFor('darwin', url, { exists: (p) => p.startsWith('/Applications/Google Chrome.app') }),
    ['open', ['-a', 'Google Chrome', url]],
    'macOS asks for Chrome by name');
  // Linux finds the binary on PATH and calls it by name — the OS resolves it.
  assert.deepEqual(
    openCommandFor('linux', url, { env: { PATH: '/usr/bin' }, exists: (p) => p === '/usr/bin/google-chrome' }),
    ['google-chrome', [url]],
    'linux uses the Chrome on PATH');
});

test('a private profile opens a browser of its own, and never the default one', () => {
  const url = 'https://de.aipass.net/chat';
  const profile = path.join(os.tmpdir(), 'aipass-suite-browser-x', 'profile');
  const [cmd, args] = openCommandFor('win32', url, {
    env: { ProgramFiles: 'C:\\Program Files' },
    exists: (p) => p === WINDOWS_CHROME,
    profile,
  });
  assert.equal(cmd, WINDOWS_CHROME, 'a private profile is still Chrome');
  assert.ok(args.includes(`--user-data-dir=${profile}`), 'the browser gets its own profile directory');
  assert.ok(args.includes('--no-first-run'), 'and no welcome tab');
  assert.equal(openCommandFor('win32', url, { exists: () => false, profile }), null,
    'no Chrome means no browser: the default one has no profile to isolate and no tree to close');
});

test('a browser the run opened is remembered, and the run that ends closes it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aipass-browser-'));
  const pidFile = path.join(dir, 'pids.txt');
  const env = { AIPASS_BROWSER_PIDFILE: pidFile };
  await recordBrowser(4242, env);
  await recordBrowser(4243, env);
  assert.equal(fs.readFileSync(pidFile, 'utf8').trim().split('\n').length, 2, 'both browsers are on the list');

  // The close ends a tree, so the kill is stubbed here: the bookkeeping is
  // what is under test, not the taskkill.
  const killed = [];
  const closed = await closeOpenedBrowsers({
    env,
    kill: async (pid) => { killed.push(pid); return true; },
  });
  assert.deepEqual(killed, [4242, 4243], 'every browser the run opened is closed');
  assert.deepEqual(closed, [4242, 4243], 'and the run says which ones it closed');
  assert.equal(fs.existsSync(pidFile), false, 'the list goes with the run');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('browser.open refuses anything that is not an allowlisted http(s) URL, before any spawn', async () => {
  for (const bad of [
    'file:///etc/passwd',
    'javascript:alert(1)',
    'ftp://example.com/x',
    'https://example.com/"quoted"',
    'https://example.com/`tick`',
    'https://example.com/x&y',
    'not a url',
  ]) {
    assert.equal(await openBrowser(bad), false, `refused without spawning: ${bad}`);
  }
});

test('the sidecar asks for the right Tauri triple on every machine it ships to', () => {
  assert.equal(targetTriple('win32', 'x64'), 'x86_64-pc-windows-msvc');
  assert.equal(targetTriple('darwin', 'x64'), 'x86_64-apple-darwin', 'the Intel mac build');
  assert.equal(targetTriple('darwin', 'arm64'), 'aarch64-apple-darwin', 'Apple silicon');
  assert.equal(targetTriple('linux', 'x64'), 'x86_64-unknown-linux-gnu');
  assert.equal(targetTriple('linux', 'arm64'), 'aarch64-unknown-linux-gnu');
  assert.throws(() => targetTriple('darwin', 'ia32'), /add it to the table/, 'an unmapped pair is named, not guessed');
});

test('the sidecar node is pinned to one major, and a different one is named', () => {
  // The sidecar is the build machine's Node, so without the pin a package's
  // runtime varied with whoever ran the build. The gate is what fetch-node
  // checks before it copies anything.
  const pinned = sidecarNodeGate(`v${REQUIRED_NODE_MAJOR}.18.0`);
  assert.equal(pinned.ok, true, `the pinned major passes: ${pinned.reason ?? ''}`);
  const newer = sidecarNodeGate(`v${REQUIRED_NODE_MAJOR + 1}.1.0`);
  assert.equal(newer.ok, false, 'a newer major does not ride through');
  assert.match(newer.reason, /pinned to major/);
  assert.match(newer.reason, /bump REQUIRED_NODE_MAJOR/, 'the fix is named, not just refused');
  const older = sidecarNodeGate(`v${REQUIRED_NODE_MAJOR - 1}.14.0`);
  assert.equal(older.ok, false, 'an older major is refused too');
  assert.equal(sidecarNodeGate('not-a-version').ok, false, 'an unreadable version is refused');
});
