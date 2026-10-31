#!/usr/bin/env node
// scripts/merge-release-manifests.mjs — collapse a multi-platform release's
// per-platform artifacts into one flat dist/ with one manifest and one checksum
// file, so the feed and the release upload see every platform.
//
//   node scripts/merge-release-manifests.mjs
//
// The build lane writes one manifest.json + SHA256SUMS per platform, and the
// publish lane downloads each platform into its own subdirectory. This script
// merges them: it flattens the bundle files, merges the artifact lists, and
// writes a single dist/manifest.json and dist/SHA256SUMS at the root.
//
// No dependencies: node built-ins only.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const DIST = path.join(REPO, 'dist');

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function readManifests() {
  return walk(DIST)
    .filter((f) => path.basename(f) === 'manifest.json')
    .map((f) => {
      try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
    })
    .filter(Boolean);
}

const manifests = readManifests();
if (!manifests.length) {
  console.error('no manifest.json found under dist/ — nothing to merge');
  process.exit(1);
}

// Flatten: copy every bundle file up to the root, skipping the per-platform
// manifest/checksum files (we regenerate those).
const bundleExts = new Set(['.exe', '.dmg', '.deb', '.AppImage']);
for (const file of walk(DIST)) {
  const base = path.basename(file);
  const rel = path.relative(DIST, file);
  if (!rel.includes(path.sep)) continue; // already at root
  if (base === 'manifest.json' || base === 'SHA256SUMS') {
    // Per-platform metadata is merged into the root files below; drop it so
    // the feed does not read the same artifact twice.
    fs.rmSync(file, { force: true });
    continue;
  }
  const dest = path.join(DIST, base);
  if (!fs.existsSync(dest)) fs.copyFileSync(file, dest);
  // Drop the per-platform copy now that it lives at the root, so a 240 MB
  // installer is not stored twice on the runner's disk.
  try { fs.rmSync(file, { force: true }); } catch { /* leave it */ }
}

// Merge artifacts from every manifest.
const artifacts = [];
let version = null;
let commit = null;
let dirty = null;
let builtAt = null;
let signing = { windows: 'unsigned', macos: 'unsigned' };
for (const m of manifests) {
  if (!version && m.version) version = m.version;
  if (!commit && m.commit) commit = m.commit;
  if (dirty === null && m.dirty !== undefined) dirty = m.dirty;
  if (!builtAt && m.builtAt) builtAt = m.builtAt;
  if (m.signing) signing = { ...signing, ...m.signing };
  for (const a of m.artifacts ?? []) artifacts.push(a);
}

const merged = {
  product: 'aipass desktop',
  version: version ?? JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version,
  commit,
  dirty,
  builtAt: builtAt ?? new Date().toISOString(),
  target: { platform: 'multi', arch: 'multi', triple: null },
  signing,
  artifacts: artifacts.sort((a, b) => String(a.file).localeCompare(String(b.file))),
};

fs.writeFileSync(path.join(DIST, 'manifest.json'), JSON.stringify(merged, null, 2) + '\n');

const entries = [];
for (const file of fs.readdirSync(DIST)) {
  const full = path.join(DIST, file);
  if (!fs.statSync(full).isFile()) continue;
  if (!bundleExts.has(path.extname(file))) continue;
  entries.push(`${crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')}  ${file}`);
}
fs.writeFileSync(path.join(DIST, 'SHA256SUMS'), entries.join('\n') + (entries.length ? '\n' : ''));

console.log(`merged ${manifests.length} manifest(s) → ${artifacts.length} artifact(s)`);
for (const a of artifacts) console.log(`  ${a.file}`);
