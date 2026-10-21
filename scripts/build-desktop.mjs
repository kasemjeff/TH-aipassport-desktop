#!/usr/bin/env node
// scripts/build-desktop.mjs — the one command that turns this repository into
// a shippable desktop artifact.
//
//   npm run desktop:build
//
// Everything else in the install system hangs off this script:
//
//   1. the three version numbers must agree (package.json, Cargo.toml,
//      tauri.conf.json) — an artifact whose name says 0.2.0 and whose app
//      says 0.2.1 is a rollback nobody can reason about;
//   2. the Node sidecar must be in place for the triple being built (the app
//      ships its own Node; a machine without Node is a supported machine);
//   3. the bundle set is the platform's, not the config's — NSIS on Windows,
//      .app + .dmg on macOS, deb + AppImage on Linux;
//   4. the artifacts land in `dist/` under a name that says what they are,
//      with a SHA256SUMS file and a manifest that says what was built from
//      which commit.
//
// No dependencies: node built-ins only, like the rest of the repository.
//
// The design this implements lives in `docs/INSTALL.md`.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// The triple table is the sidecar script's, imported rather than copied: one
// rule for "what is this platform called", not two. Importing it does not
// copy anything — the copy only runs when that file is the entry point.
import { targetTriple } from '../desktop/sidecar/fetch-node.mjs';

// The one table for "what does this platform ship": the bundle types the
// Tauri bundler is asked for, and the architecture label that goes into an
// artifact name. It is exported so the test can pin it without a build.
//
// The macOS row is the interesting one: the .app bundle is a directory, so
// the artifact that travels is the .dmg around it.
export const PLATFORMS = {
  win32: { label: 'windows', bundles: ['nsis'], arch: { x64: 'x64', arm64: 'arm64' } },
  darwin: { label: 'macos', bundles: ['app', 'dmg'], arch: { arm64: 'arm64', x64: 'x64' } },
  linux: { label: 'linux', bundles: ['deb', 'appimage'], arch: { x64: 'x86_64', arm64: 'aarch64' } },
};

// The bundler's type → the file extension of the artifact it produces, and
// the extra word some of them need in their name (the Windows installer is a
// setup program; the AppImage is not an "appimage" file).
export const BUNDLES = {
  nsis: { ext: '.exe', kind: 'setup' },
  dmg: { ext: '.dmg', kind: '' },
  deb: { ext: '.deb', kind: '' },
  appimage: { ext: '.AppImage', kind: '' },
};

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

/**
 * The plan for one build: which bundles to ask for, which config overlay to
 * merge, and what the artifacts will be called.
 *
 * `target` is the Rust target triple the build runs for. It is null for a
 * native build (the CLI picks the host) and set when AIPASS_DESKTOP_TARGET
 * asks for something else — `universal-apple-darwin` on macOS is the one
 * that earns its keep: one .dmg that runs on Intel and on Apple Silicon.
 */
export function planFor(platform = process.platform, arch = process.arch, target = null) {
  const spec = PLATFORMS[platform];
  if (!spec) {
    throw new Error(`no bundle plan for ${platform} — add it to PLATFORMS in scripts/build-desktop.mjs`);
  }
  const archLabel = target === 'universal-apple-darwin' ? 'universal' : (spec.arch[arch] ?? arch);
  return {
    platform,
    label: spec.label,
    bundles: spec.bundles,
    config: `desktop/src-tauri/tauri.${spec.label}.conf.json`,
    arch: archLabel,
    target,
  };
}

/**
 * The artifact name: what it is, which version, which platform, which
 * architecture. A name that says all four is the difference between a
 * download page and a support question.
 */
export function artifactName({ version, label, arch, kind, ext }) {
  const parts = ['aipass-desktop', version, label, arch];
  if (kind) parts.push(kind);
  return parts.join('-') + ext;
}

/**
 * The three version numbers, read from the three places they live.
 *
 * Cargo.toml is read with a line pattern rather than a TOML parser: the
 * repository carries no dependencies, and the file has exactly one `version`
 * in its `[package]` section — the one rule the installer needs from it.
 */
export function readVersions(repo = REPO) {
  const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
  const cargo = fs.readFileSync(path.join(repo, 'desktop', 'src-tauri', 'Cargo.toml'), 'utf8');
  const cargoVersion = (cargo.match(/^version\s*=\s*"([^"]+)"/m) ?? [])[1] ?? null;
  const tauri = JSON.parse(fs.readFileSync(path.join(repo, 'desktop', 'src-tauri', 'tauri.conf.json'), 'utf8'));
  return { npm: pkg.version, cargo: cargoVersion, tauri: tauri.version };
}

/** The versions must agree — a mismatch is a broken artifact, not a warning. */
export function versionsAgree(versions) {
  const values = Object.values(versions);
  return values.every((v) => typeof v === 'string' && v === values[0]);
}

/** The git commit the artifact was built from, and whether the tree was dirty. */
export function gitState(repo = REPO) {
  const run = (args) => {
    const out = spawnSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true });
    return out.status === 0 ? out.stdout.trim() : null;
  };
  const commit = run(['rev-parse', '--short', 'HEAD']);
  if (!commit) return { commit: null, dirty: null };
  const status = run(['status', '--porcelain']);
  return { commit, dirty: Boolean(status) };
}

/**
 * Where cargo puts the build. Asked of cargo itself, because CARGO_TARGET_DIR
 * is only one of the ways the answer can be spelled.
 */
export function targetDir(repo = REPO) {
  const meta = spawnSync('cargo', ['metadata', '--format-version', '1', '--no-deps'], {
    cwd: repo,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (meta.status === 0) {
    try {
      const parsed = JSON.parse(meta.stdout);
      if (parsed?.target_directory) return path.resolve(parsed.target_directory);
    } catch { /* fall through to the env */ }
  }
  if (process.env.CARGO_TARGET_DIR) return path.resolve(repo, process.env.CARGO_TARGET_DIR);
  return path.join(repo, 'target');
}

/**
 * The sidecar file a build needs: the local node for a native build, and the
 * named triple when the build is for another architecture (a cross build
 * cannot conjure the other node — a human has to put it there).
 */
export function sidecarName(platform = process.platform, arch = process.arch, target = null) {
  const triple = target ?? targetTriple(platform, arch);
  return `node-${triple}${platform === 'win32' ? '.exe' : ''}`;
}

/** The sidecar's path in the tree. */
export function sidecarPath(repo = REPO, platform = process.platform, arch = process.arch, target = null) {
  return path.join(repo, 'desktop', 'sidecar', sidecarName(platform, arch, target));
}

/**
 * Whether a sidecar is usable: it is there, and it is a binary rather than
 * a note somebody left in the slot. A Node build is never small, so a
 * one-megabyte floor catches a truncated copy and an empty file — and the
 * build script copies the real node over the top of one, rather than
 * shipping an app that cannot start.
 */
export function sidecarUsable(file) {
  try {
    return fs.statSync(file).size >= 1024 * 1024;
  } catch {
    return false;
  }
}

const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** Run a command, inheriting the output. Returns the exit code. */
function run(cmd, args, cwd) {
  const isWindows = process.platform === 'win32';
  // Windows resolves `tauri` to the npm shim, which is a .cmd — a shell is
  // the only way to run one without carrying its path around. The command is
  // therefore assembled here, quoted once, rather than handed over as an
  // argument list a shell would concatenate unescaped.
  const quote = (a) => (isWindows && /[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a);
  const out = isWindows
    ? spawnSync([cmd, ...args].map(quote).join(' '), {
        cwd,
        stdio: 'inherit',
        windowsHide: true,
        shell: true,
      })
    : spawnSync(cmd, args, { cwd, stdio: 'inherit', windowsHide: true });
  if (out.error) {
    // ENOENT means the command is not on PATH. For the bundler that is the
    // Tauri CLI, and the fix is one line - so say it, instead of leaving
    // "spawnSync tauri ENOENT" as the only word in a CI log.
    if (out.error.code === 'ENOENT') {
      throw new Error(`"${cmd}" is not on PATH - the Tauri CLI is needed for the build: cargo install tauri-cli --version "^2"`);
    }
    throw out.error;
  }
  return out.status ?? 1;
}

/** Every bundle file the bundler wrote, keyed by its bundle type. */
function collectBundles(dir, types) {
  const found = new Map();
  if (!fs.existsSync(dir)) return found;
  for (const type of types) {
    const typeDir = path.join(dir, type);
    if (!fs.existsSync(typeDir)) continue;
    for (const name of fs.readdirSync(typeDir)) {
      const file = path.join(typeDir, name);
      // The .app on macOS is a directory — it travels inside the .dmg, so
      // there is nothing to checksum here.
      if (!fs.statSync(file).isFile()) continue;
      if (!found.has(type)) found.set(type, []);
      found.get(type).push(file);
    }
  }
  return found;
}

/**
 * What the artifact's signature is — or is not. The manifest says it out
 * loud, because "unsigned" in a manifest is an honest answer and "unsigned"
 * on a download page is a surprise.
 */
export function signingState(env = process.env) {
  const identity = env.APPLE_SIGNING_IDENTITY || env.APPLE_CERTIFICATE || null;
  const notarized = Boolean(env.APPLE_API_KEY || env.APPLE_ID);
  return {
    windows: 'unsigned',
    macos: identity ? (notarized ? 'signed+notarized' : 'signed') : 'unsigned',
  };
}

export function main() {
  const repo = REPO;
  const target = process.env.AIPASS_DESKTOP_TARGET?.trim() || null;
  const plan = planFor(process.platform, process.arch, target);

  const versions = readVersions(repo);
  if (!versionsAgree(versions)) {
    console.error(`the versions disagree: npm ${versions.npm} · cargo ${versions.cargo} · tauri ${versions.tauri}`);
    console.error('they must be the same string — an installer that names one version and ships another cannot be rolled back.');
    process.exit(1);
  }
  const version = versions.npm;
  console.log(`aipass desktop ${version} · ${plan.label}/${plan.arch}`);

  // The sidecar: the app ships its own Node, so the build must have one for
  // the triple being built. A missing one is fetched from the local node —
  // for the host's triple only; another architecture's node is a human's job.
  const sidecar = sidecarPath(repo, process.platform, process.arch, target);
  if (!sidecarUsable(sidecar)) {
    if (target) {
      console.error(`the sidecar for ${target} is missing: ${sidecar}`);
      console.error(`a cross build cannot copy the local node into that slot — put a node for ${target} there and run again.`);
      process.exit(1);
    }
    console.log('sidecar missing — copying the local node into place');
    const code = run(process.execPath, [path.join('desktop', 'sidecar', 'fetch-node.mjs')], repo);
    if (code !== 0 || !sidecarUsable(sidecar)) {
      console.error(`the sidecar is still missing: ${sidecar}`);
      process.exit(1);
    }
  }

  const args = [
    'build',
    '--config', 'desktop/src-tauri/tauri.conf.json',
    '--config', plan.config,
    '--bundles', plan.bundles.join(','),
  ];
  if (plan.target) args.push('--target', plan.target);
  console.log(`tauri ${args.join(' ')}`);
  const code = run(process.env.AIPASS_TAURI_CLI?.trim() || 'tauri', args, repo);
  if (code !== 0) {
    console.error(`the bundler failed (exit ${code})`);
    process.exit(code);
  }

  // The artifacts: whatever the bundler wrote, renamed to a name that says
  // what it is, with a checksum beside it.
  const base = targetDir(repo);
  const dirs = [path.join(base, 'release', 'bundle')];
  if (plan.target) dirs.push(path.join(base, plan.target, 'release', 'bundle'));
  const bundles = new Map();
  for (const dir of dirs) {
    for (const [type, files] of collectBundles(dir, plan.bundles)) {
      bundles.set(type, [...(bundles.get(type) ?? []), ...files]);
    }
  }
  if (!bundles.size) {
    console.error(`no bundles under ${base} — nothing to publish`);
    process.exit(1);
  }

  const dist = path.join(repo, 'dist');
  fs.rmSync(dist, { recursive: true, force: true });
  fs.mkdirSync(dist, { recursive: true });
  const entries = [];
  for (const [type, files] of bundles) {
    const spec = BUNDLES[type];
    for (const file of files) {
      const name = artifactName({
        version,
        label: plan.label,
        arch: plan.arch,
        kind: spec?.kind ?? '',
        ext: spec?.ext ?? path.extname(file),
      });
      const dest = path.join(dist, name);
      fs.copyFileSync(file, dest);
      entries.push({ type, file: name, bytes: fs.statSync(dest).size, sha256: sha256(dest) });
    }
  }

  fs.writeFileSync(
    path.join(dist, 'SHA256SUMS'),
    entries.map((e) => `${e.sha256}  ${e.file}`).join('\n') + '\n',
  );
  const state = gitState(repo);
  fs.writeFileSync(
    path.join(dist, 'manifest.json'),
    JSON.stringify(
      {
        product: 'aipass desktop',
        version,
        commit: state.commit,
        dirty: state.dirty,
        builtAt: new Date().toISOString(),
        target: { platform: plan.label, arch: plan.arch, triple: plan.target ?? null },
        signing: signingState(),
        artifacts: entries.sort((a, b) => a.file.localeCompare(b.file)),
      },
      null,
      2,
    ) + '\n',
  );

  console.log('');
  for (const entry of entries) console.log(`  ${entry.file}  ${(entry.bytes / 1e6).toFixed(1)} MB`);
  console.log('\ndist/SHA256SUMS and dist/manifest.json written');
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
