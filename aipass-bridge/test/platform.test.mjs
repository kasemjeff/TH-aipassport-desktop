// The platform branches a Windows dev machine cannot run: the argv each OS
// gets when a URL is opened, the sidecar name a mac build asks for, and the
// allowlist that runs before browser.open spawns anything. Extracting the
// rules made them testable from anywhere; the macOS CI lane is what proves
// the parts that need the OS itself (spawning `open`, the window bundle).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openCommandFor } from '../harness/open-command.mjs';
import { openBrowser } from '../harness/rpc.mjs';
import { targetTriple } from '../../desktop/sidecar/fetch-node.mjs';

test('the platform→argv rule: one URL as one argument, three shapes', () => {
  const url = 'https://example.com/a?b=1&c=2';
  assert.deepEqual(openCommandFor('win32', url), ['cmd', ['/c', 'start', '', url]],
    'cmd start keeps its empty title so the URL cannot become the window title');
  assert.deepEqual(openCommandFor('darwin', url), ['open', [url]], 'macOS opens through `open`');
  assert.deepEqual(openCommandFor('linux', url), ['xdg-open', [url]], 'linux opens through `xdg-open`');
  for (const platform of ['win32', 'darwin', 'linux']) {
    const [cmd, args] = openCommandFor(platform, url);
    assert.ok(args.includes(url), `the URL rides as one argv element on ${platform}`);
    assert.ok(!cmd.includes(url), 'the URL is never part of the executable name');
  }
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
