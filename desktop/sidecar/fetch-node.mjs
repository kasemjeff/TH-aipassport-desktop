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

/**
 * Node's own name for the platform being built for — Tauri's triple.
 * Exported with injectable platform/arch so the table (the two darwin rows
 * included) is testable from any machine, the macOS one being the point.
 */
export function targetTriple(platform = process.platform, arch = process.arch) {
  const table = {
    'win32-x64': 'x86_64-pc-windows-msvc',
    'darwin-x64': 'x86_64-apple-darwin',
    'darwin-arm64': 'aarch64-apple-darwin',
    'linux-x64': 'x86_64-unknown-linux-gnu',
    'linux-arm64': 'aarch64-unknown-linux-gnu',
  };
  const triple = table[`${platform}-${arch}`];
  if (!triple) {
    throw new Error(`no sidecar name for ${platform}-${arch} — add it to the table in ${path.basename(fileURLToPath(import.meta.url))}`);
  }
  return triple;
}

/**
 * The Node major the sidecar is pinned to. The sidecar IS the build
 * machine's Node, so without a pin the runtime a package ships varied with
 * whoever's machine ran the build. A newer major is a deliberate bump of
 * this one number, never an accident of the environment.
 */
export const REQUIRED_NODE_MAJOR = 24;

/** The pin, checked against a version string — pure, so a test can drive it. */
export function sidecarNodeGate(version = process.version) {
  const major = Number(String(version).replace(/^v/, '').split('.')[0]);
  if (!Number.isInteger(major)) {
    return { ok: false, reason: `node version unreadable: ${version}` };
  }
  if (major !== REQUIRED_NODE_MAJOR) {
    const here = path.basename(fileURLToPath(import.meta.url));
    return {
      ok: false,
      reason: `the sidecar node is pinned to major ${REQUIRED_NODE_MAJOR} — this machine has ${version}; bump REQUIRED_NODE_MAJOR in desktop/sidecar/${here} to move the pin`,
    };
  }
  return { ok: true };
}

// The copy only runs when the script is invoked, not when a test imports the
// table: importing must never copy a ~90 MB binary or chmod anything.
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  // The pin first: a build from the wrong major must not start.
  const gate = sidecarNodeGate();
  if (!gate.ok) {
    console.error(gate.reason);
    process.exit(1);
  }

  let target;
  try {
    target = path.join(HERE, `node-${targetTriple()}${process.platform === 'win32' ? '.exe' : ''}`);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  copyFileSync(process.execPath, target);
  if (process.platform !== 'win32') {
    // A sidecar the OS cannot execute is a sidecar that might as well be absent,
    // and a copy loses nothing by keeping the mode.
    execFileSync('chmod', ['755', target]);
  }
  if (!existsSync(target)) {
    // A copy that reports success but wrote nothing is a sidecar that might
    // as well be absent — name it before anything else reads the file.
    console.error('copy reported success but the file is not there');
    process.exit(1);
  }
  const version = execFileSync(process.execPath, ['--version'], { encoding: 'utf8' }).trim();
  console.log(`sidecar ready: ${target} (${Math.round(statSync(target).size / 1e6)} MB, node ${version})`);
}
