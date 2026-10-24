#!/usr/bin/env node
// scripts/build-content-pack.mjs — the content pack.
//
//   npm run desktop:content-pack
//
// The CONTENT is everything the app runs that is not the binary and not the
// Node sidecar: the harness, the bridge, the CLI, the window's own files.
// It is what an update replaces in place, and it is a twentieth of the
// installer's size — the installer is 231 MiB, and most of that is the
// sidecar and the WebView2 runtime, neither of which changes between
// releases.
//
// The tree is built from the SAME resource list the bundler uses
// (`tauri.conf.json` → `bundle.resources`), so the content tree and the
// installed bundle hold the same files. A pack that shipped something the
// bundle did not would be a pack nobody could test; a bundle that shipped
// something the pack did not would be an update that quietly reverted it.
//
// The pack is JSON, gzipped. JSON because the tree is all text and a person
// can read what a release contains; gzip because `node:zlib` is a builtin
// and a tar parser would be a hundred lines of code to save nothing.
//
// No dependencies: node built-ins only, like the rest of the repository.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const TAURI_DIR = path.join(REPO, 'desktop', 'src-tauri');

/** The version every file in the tree agrees on. */
export function readVersion(repo = REPO) {
  return JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).version;
}

/**
 * The resource list, as pairs of (source, destination).
 *
 * The bundler reads the same list, so this is not a second rule — it is the
 * same rule, read from the same file.
 */
export function resourceList(repo = REPO) {
  const config = JSON.parse(fs.readFileSync(path.join(repo, 'desktop', 'src-tauri', 'tauri.conf.json'), 'utf8'));
  const resources = config?.bundle?.resources ?? {};
  return Object.entries(resources).map(([source, destination]) => ({
    source: path.resolve(TAURI_DIR, source),
    destination: String(destination).replace(/\/+$/, ''),
  }));
}

/** Every file under a directory, as paths relative to it. */
function walk(dir, prefix = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walk(path.join(dir, entry.name), relative));
    else if (entry.isFile()) out.push(relative);
  }
  return out;
}

/**
 * The pack's files: the resource list, plus the version file.
 *
 * `package.json` is not in the resource list — the bundler does not ship it
 * — but the content tree needs it: `APP_VERSION` reads it, and the window
 * shows the content's version. Without it the tree would report no version
 * at all, which is exactly the mystery the two-halves split is meant to
 * remove.
 */
export function collectFiles(repo = REPO) {
  const files = [];
  const add = (relative, bytes) => {
    files.push({
      path: relative,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      encoding: 'utf8',
      content: bytes.toString('utf8'),
    });
  };
  for (const { source, destination } of resourceList(repo)) {
    if (!fs.existsSync(source)) continue;
    if (fs.statSync(source).isDirectory()) {
      for (const relative of walk(source)) {
        add(`${destination}/${relative}`, fs.readFileSync(path.join(source, relative)));
      }
    } else {
      add(destination, fs.readFileSync(source));
    }
  }
  add('package.json', fs.readFileSync(path.join(repo, 'package.json')));
  return files;
}

/** The pack, as bytes. */
export function buildPack(repo = REPO, version = readVersion(repo)) {
  const files = collectFiles(repo);
  const pack = {
    schema: 1,
    product: 'aipass desktop',
    version,
    files,
  };
  return zlib.gzipSync(Buffer.from(JSON.stringify(pack)));
}

function main() {
  const version = readVersion();
  const bytes = buildPack(REPO, version);
  const dir = path.join(REPO, 'dist');
  fs.mkdirSync(dir, { recursive: true });
  const name = `aipass-content-${version}.json.gz`;
  const file = path.join(dir, name);
  fs.writeFileSync(file, bytes);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  fs.writeFileSync(path.join(dir, `${name}.sha256`), `${sha256}  ${name}\n`);
  const raw = collectFiles(REPO).reduce((sum, f) => sum + Buffer.byteLength(f.content, 'utf8'), 0);
  console.log(`content pack ${version}`);
  console.log(`  ${name}  ${(bytes.length / 1024).toFixed(0)} KB (${(raw / 1024).toFixed(0)} KB raw)`);
  console.log(`  sha256 ${sha256}`);
  console.log('\nThe feed that points at it is written by: npm run desktop:feed');
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
