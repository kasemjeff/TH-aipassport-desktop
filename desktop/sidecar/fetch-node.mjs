#!/usr/bin/env node
// Copy the local Node into the sidecar slot Tauri's externalBin expects.
//
// The packaged app ships Node so it never depends on the machine having it:
// the whole backend is .mjs files run by this binary. Tauri names the sidecar
// after the target triple it is bundling for, so the target name is decided
// here rather than in a per-platform script — one file that does the right
// thing on each machine, the same rule the rest of this repo keeps.
//
//   node desktop/sidecar/fetch-node.mjs
//
// The artifact itself is gitignored on purpose: a ~90 MB executable does not
// belong in a repo.
import { copyFileSync, existsSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Node's own name for the platform being built for — Tauri's triple. */
function targetTriple() {
  const { platform, arch } = process;
  const table = {
    'win32-x64': 'x86_64-pc-windows-msvc',
    'darwin-x64': 'x86_64-apple-darwin',
    'darwin-arm64': 'aarch64-apple-darwin',
    'linux-x64': 'x86_64-unknown-linux-gnu',
    'linux-arm64': 'aarch64-unknown-linux-gnu',
  };
  const triple = table[`${platform}-${arch}`];
  if (!triple) {
    console.error(`no sidecar name for ${platform}-${arch} — add it to the table in ${path.basename(fileURLToPath(import.meta.url))}`);
    process.exit(1);
  }
  return triple;
}

const node = process.execPath;
const target = path.join(HERE, `node-${targetTriple()}${process.platform === 'win32' ? '.exe' : ''}`);

copyFileSync(node, target);
if (process.platform !== 'win32') {
  // A sidecar the OS cannot execute is a sidecar that might as well be absent,
  // and a copy loses nothing by keeping the mode.
  execFileSync('chmod', ['755', target]);
}
const version = execFileSync(node, ['--version'], { encoding: 'utf8' }).trim();
console.log(`sidecar ready: ${target} (${Math.round(statSync(target).size / 1e6)} MB, node ${version})`);

if (!existsSync(target)) {
  // Unreachable after a successful copy; the guard is here so a silent
  // no-write failure can never look like success.
  console.error('copy reported success but the file is not there');
  process.exit(1);
}
