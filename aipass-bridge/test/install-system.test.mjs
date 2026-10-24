// The install system: what a build asks for, what an artifact is called, and
// the three rules that keep a release honest — the versions agree, the
// sidecar is named after the triple, and the manifest says when nothing is
// signed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PLATFORMS,
  planFor,
  artifactName,
  readVersions,
  versionsAgree,
  sidecarName,
  sidecarUsable,
  signingState,
  bundlerCommand,
} from '../../scripts/build-desktop.mjs';
import { planFor as ladderPlan, versionFromName } from '../../scripts/install-ladder.mjs';
import { downloadUrl } from '../../scripts/build-universal-sidecar.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('the bundle plan is the platform\'s, not the config\'s', () => {
  // One config cannot say "nsis on Windows, a dmg on macOS" — so each
  // platform owns the bundle set, and the plan says which one it is.
  const mac = planFor('darwin', 'arm64');
  assert.deepEqual(mac.bundles, ['app', 'dmg']);
  assert.equal(mac.config, 'desktop/src-tauri/tauri.macos.conf.json');
  assert.equal(mac.arch, 'arm64');

  const win = planFor('win32', 'x64');
  assert.deepEqual(win.bundles, ['nsis']);
  assert.equal(win.config, 'desktop/src-tauri/tauri.windows.conf.json');

  const linux = planFor('linux', 'x64');
  assert.deepEqual(linux.bundles, ['deb', 'appimage']);
  assert.equal(linux.config, 'desktop/src-tauri/tauri.linux.conf.json');
});

test('a universal macOS build is one artifact, not two', () => {
  const plan = planFor('darwin', 'arm64', 'universal-apple-darwin');
  assert.equal(plan.arch, 'universal');
  assert.equal(plan.target, 'universal-apple-darwin');
});

test('an unknown platform is refused rather than guessed', () => {
  assert.throws(() => planFor('sunos', 'x64'), /no bundle plan/);
});

test('an artifact name says what it is', () => {
  // The download page and the support question both read this name: what it
  // is, which version, which platform, which architecture.
  assert.equal(
    artifactName({ version: '0.2.0', label: 'windows', arch: 'x64', kind: 'setup', ext: '.exe' }),
    'aipass-desktop-0.2.0-windows-x64-setup.exe',
  );
  assert.equal(
    artifactName({ version: '0.2.0', label: 'macos', arch: 'arm64', kind: '', ext: '.dmg' }),
    'aipass-desktop-0.2.0-macos-arm64.dmg',
  );
  assert.equal(
    artifactName({ version: '0.2.0', label: 'linux', arch: 'x86_64', kind: '', ext: '.AppImage' }),
    'aipass-desktop-0.2.0-linux-x86_64.AppImage',
  );
});

test('every platform in the table ships something', () => {
  // A platform with no bundle is a platform that cannot be installed on; the
  // table is the place where that shows up first.
  for (const [platform, spec] of Object.entries(PLATFORMS)) {
    assert.ok(spec.bundles.length, `${platform} ships no bundle`);
    assert.ok(spec.label, `${platform} has no label`);
  }
});

test('the three version numbers must agree', () => {
  const versions = readVersions(REPO);
  assert.equal(versions.npm, versions.cargo, 'package.json and Cargo.toml disagree');
  assert.equal(versions.npm, versions.tauri, 'package.json and tauri.conf.json disagree');
  assert.ok(versionsAgree(versions));
  assert.ok(!versionsAgree({ npm: '1.0.0', cargo: '1.0.1', tauri: '1.0.0' }));
});

test('the sidecar is named after the triple the bundler expects', () => {
  // Tauri names the sidecar after the target triple; a file with another
  // name is a file the app never finds and never runs.
  assert.equal(sidecarName('win32', 'x64'), 'node-x86_64-pc-windows-msvc.exe');
  assert.equal(sidecarName('darwin', 'arm64'), 'node-aarch64-apple-darwin');
  assert.equal(sidecarName('darwin', 'x64'), 'node-x86_64-apple-darwin');
  assert.equal(sidecarName('linux', 'x64'), 'node-x86_64-unknown-linux-gnu');
});

test('a sidecar that is not a binary is not a sidecar', () => {
  // A note somebody left in the slot must not pass for the Node the app
  // runs on: the build copies the real one over the top of it instead.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aipass-sidecar-'));
  try {
    const empty = path.join(dir, 'node-empty');
    fs.writeFileSync(empty, '');
    assert.equal(sidecarUsable(empty), false);

    const note = path.join(dir, 'node-note');
    fs.writeFileSync(note, 'not a node, just a note');
    assert.equal(sidecarUsable(note), false);

    const real = path.join(dir, 'node-real');
    fs.writeFileSync(real, Buffer.alloc(2 * 1024 * 1024));
    assert.equal(sidecarUsable(real), true);

    assert.equal(sidecarUsable(path.join(dir, 'node-absent')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the manifest says when nothing is signed', () => {
  // "unsigned" in a manifest is an honest answer; unsigned on a download
  // page is a surprise.
  assert.equal(signingState({}).macos, 'unsigned');
  assert.equal(signingState({}).windows, 'unsigned');
  assert.equal(signingState({ APPLE_SIGNING_IDENTITY: 'Developer ID Application: x' }).macos, 'signed');
  assert.equal(
    signingState({ APPLE_SIGNING_IDENTITY: 'x', APPLE_API_KEY: 'y' }).macos,
    'signed+notarized',
  );
});

test('the ladder knows what each platform installs', () => {
  // A platform with no plan has no ladder: the release procedure would fall
  // back to "do it by hand" without saying so.
  const windows = ladderPlan('win32', 'aipass-desktop-0.2.0-windows-x64-setup.exe', {}, 'C:\\Users\\x');
  assert.equal(windows.kind, 'nsis');
  assert.ok(windows.candidates.length, 'the install folder is looked up, not assumed');

  const mac = ladderPlan('darwin', 'aipass-desktop-0.2.0-macos-arm64.dmg');
  assert.equal(mac.kind, 'dmg');

  const linux = ladderPlan('linux', 'aipass-desktop-0.2.0-linux-x86_64.AppImage');
  assert.equal(linux.kind, 'appimage');

  const deb = ladderPlan('linux', 'aipass-desktop-0.2.0-linux-x86_64.deb');
  assert.equal(deb.kind, 'deb');

  assert.throws(() => ladderPlan('sunos', 'aipass-desktop-0.2.0-sunos-x86_64.tar.gz'), /no ladder/);
});

test('the ladder reads the version out of the artifact name', () => {
  assert.equal(versionFromName('aipass-desktop-0.2.0-windows-x64-setup.exe'), '0.2.0');
  assert.equal(versionFromName('aipass-desktop-1.4.7-macos-arm64.dmg'), '1.4.7');
  assert.equal(versionFromName('something-else.exe'), null);
});

test('the universal sidecar is built from the two official Node builds', () => {
  // A merged binary has to come from the real Node releases: a home-made one
  // is not a Node.
  assert.equal(
    downloadUrl('24.0.0', 'arm64'),
    'https://nodejs.org/dist/v24.0.0/node-v24.0.0-darwin-arm64.tar.gz',
  );
  assert.equal(
    downloadUrl('24.0.0', 'x64'),
    'https://nodejs.org/dist/v24.0.0/node-v24.0.0-darwin-x64.tar.gz',
  );
});

test('the bundler is called under whichever name the machine has', () => {
  // The Tauri CLI comes in two spellings: the npm shim (`tauri`) and the
  // cargo one (`cargo tauri` - the `tauri-cli` crate installs `cargo-tauri`,
  // NOT `tauri`). This repository installs no npm packages, so the build
  // lane gets the cargo spelling.
  const saved = process.env.AIPASS_TAURI_CLI;
  delete process.env.AIPASS_TAURI_CLI;
  try {
    assert.deepEqual(
      bundlerCommand(['build'], { has: (n) => n === 'tauri' }),
      { cmd: 'tauri', args: ['build'] },
    );
    assert.deepEqual(
      bundlerCommand(['build'], { has: (n) => n === 'cargo' }),
      { cmd: 'cargo', args: ['tauri', 'build'] },
    );
    assert.throws(() => bundlerCommand(['build'], { has: () => false }), /not on PATH/);

    // The override names the binary to run, and it wins over both.
    process.env.AIPASS_TAURI_CLI = '/opt/tauri';
    assert.deepEqual(
      bundlerCommand(['build'], { has: () => true }),
      { cmd: '/opt/tauri', args: ['build'] },
    );
  } finally {
    if (saved === undefined) delete process.env.AIPASS_TAURI_CLI;
    else process.env.AIPASS_TAURI_CLI = saved;
  }
});
