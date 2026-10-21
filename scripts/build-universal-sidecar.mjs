#!/usr/bin/env node
// scripts/build-universal-sidecar.mjs — one Node binary that runs on both
// kinds of Mac.
//
//   npm run desktop:sidecar:universal
//
// A universal build (AIPASS_DESKTOP_TARGET=universal-apple-darwin) needs the
// sidecar to be universal too: the bundler looks for
// `node-universal-apple-darwin`, and a binary that is only one architecture
// cannot answer for the other.
//
// So this takes the two official Node builds for the running Node's version —
// one arm64, one x86_64 — and merges them with `lipo`, which is a macOS tool.
// That is why this script refuses to run anywhere else: the merge cannot be
// done elsewhere, and a half-universal binary would be worse than none.
//
// The merged binary carries no signature (lipo breaks the one Node shipped),
// so the bundler signs it with the app's identity when it signs the bundle.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const TARGET = 'node-universal-apple-darwin';

/** The official download for one architecture of one Node version. */
export function downloadUrl(version, arch) {
  const platform = arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64';
  return `https://nodejs.org/dist/v${version}/node-v${version}-${platform}.tar.gz`;
}

/** Run a command and wait for it. Returns its exit code. */
function run(cmd, args, opts = {}) {
  const out = spawnSync(cmd, args, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: opts.timeout ?? 20 * 60 * 1000,
    stdio: opts.quiet ? 'ignore' : 'inherit',
  });
  if (out.error) throw out.error;
  return { code: out.status ?? 1, stdout: out.stdout ?? '', stderr: out.stderr ?? '' };
}

async function main() {
  if (process.platform !== 'darwin') {
    console.error('a universal Node is a macOS job: lipo is a macOS tool, and the merge cannot be done elsewhere.');
    console.error('run this on a Mac, then build with AIPASS_DESKTOP_TARGET=universal-apple-darwin npm run desktop:build');
    process.exit(1);
  }

  const version = process.versions.node;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'aipass-universal-node-'));
  const binaries = [];
  try {
    for (const arch of ['arm64', 'x64']) {
      const url = downloadUrl(version, arch);
      console.log(`fetching ${url}`);
      const archive = path.join(work, path.basename(url));
      const curl = run('curl', ['-fsSL', '-o', archive, url]);
      if (curl.code !== 0) fail(`the download failed: ${url}`);
      run('tar', ['-xzf', archive, '-C', work]);
      const binary = path.join(work, `node-v${version}-darwin-${arch === 'arm64' ? 'arm64' : 'x64'}`, 'bin', 'node');
      if (!fs.existsSync(binary)) fail(`the archive holds no node binary (${binary})`);
      binaries.push(binary);
    }

    const target = path.join(REPO, 'desktop', 'sidecar', TARGET);
    const lipo = run('lipo', ['-create', '-output', target, ...binaries]);
    if (lipo.code !== 0) fail('lipo could not merge the two binaries');
    run('chmod', ['755', target]);

    // A merged binary has no signature of its own; the bundler signs it with
    // the app's identity, and this only says what it is.
    const info = run('lipo', ['-info', target]);
    console.log(info.stdout.trim() || 'merged');

    // If an identity is configured, sign it now — a notarized bundle needs
    // every nested binary signed with the hardened runtime.
    const identity = process.env.APPLE_SIGNING_IDENTITY;
    if (identity) {
      const sign = run('codesign', ['--force', '--sign', identity, '--options', 'runtime', '--timestamp', target]);
      if (sign.code !== 0) fail('the merged binary could not be signed');
      console.log(`signed with ${identity}`);
    } else {
      console.log('no APPLE_SIGNING_IDENTITY in the environment — the merged binary is unsigned');
      console.log('the bundler signs it with the app identity when it signs the bundle');
    }
    console.log(`\nsidecar ready: ${target}`);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

const fail = (message) => {
  console.error(`\n  ✖ ${message}`);
  process.exit(1);
};

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(err?.message ?? err);
    process.exit(1);
  });
}
