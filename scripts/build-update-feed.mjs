#!/usr/bin/env node
// scripts/build-update-feed.mjs — the release feed.
//
//   npm run desktop:feed
//
// The feed is a static file the app fetches to learn what is out there. It
// is signed, and the signature is the whole trust story: a feed that
// verifies against the keyring in the source is a feed the release key
// wrote, and one that does not is refused (`harness/update.mjs`).
//
// The signature is DETACHED and over the exact bytes of the feed, so there
// is no canonical JSON to agree on and no field order to get wrong. The
// `.sig` file is one line: `ed25519:<key id>:<base64>`.
//
// The key comes from the environment and never from the repository:
//   AIPASS_RELEASE_KEY       a path to a PEM file, or the PEM itself
//   AIPASS_RELEASE_KEY_ID    the key id the feed is signed with
//
// No dependencies: node built-ins only, like the rest of the repository.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// The app's own verifier and keyring: the feed this script writes is
// checked with the same code the app checks it with, so a keyring typo or a
// signing mistake is caught HERE, before a release is out — not by the first
// person whose app fetches the feed.
import { verifyFeed } from '../aipass-bridge/harness/update.mjs';
import { KEYRING } from '../aipass-bridge/harness/update-keys.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

/** The signing key: a path, or the PEM itself. */
export function readKey(env = process.env) {
  const raw = (env.AIPASS_RELEASE_KEY ?? '').trim();
  if (!raw) throw new Error('AIPASS_RELEASE_KEY is not set — the feed is signed, and a key that is nowhere is no key');
  if (raw.includes('-----BEGIN')) return raw;
  return fs.readFileSync(raw, 'utf8');
}

/** The id the feed is signed with. It has to name a key in the keyring. */
export const keyId = (env = process.env) => (env.AIPASS_RELEASE_KEY_ID ?? '').trim() || 'aipass-release-2026';

/**
 * The feed.
 *
 * The sequence is the rollback guard: it only ever goes up, and the app
 * refuses a feed that is older than the one it has already seen.
 */
export function buildFeed({ version, commit, artifacts, pack, sequence, releasedAt, notes = '' }) {
  return {
    schema: 1,
    product: 'aipass desktop',
    sequence: Number(sequence),
    channel: 'stable',
    generatedAt: releasedAt,
    releases: [
      {
        version,
        releasedAt,
        commit: commit ?? null,
        notes,
        content: pack
          ? {
              version,
              file: pack.file,
              bytes: pack.bytes,
              sha256: pack.sha256,
              // The oldest shell that can run this content. A content
              // release that needs a newer shell says so, and the app
              // refuses it rather than running code it does not understand.
              minShell: pack.minShell ?? version,
            }
          : null,
        artifacts: artifacts ?? [],
      },
    ],
  };
}

/** Sign the exact bytes of the feed. */
export function signFeed(bytes, pem, id) {
  const signature = crypto.sign(null, bytes, pem);
  return `ed25519:${id}:${signature.toString('base64')}`;
}

/**
 * Verify a written feed against the keyring in the source.
 *
 * The app refuses a feed that does not verify, so a release lane that
 * publishes one has published a release nobody can update from. Catching it
 * at the build is the difference between a broken release and a broken
 * afternoon.
 */
export function verifyWrittenFeed(dir, keyring = KEYRING) {
  const bytes = fs.readFileSync(path.join(dir, 'updates.json'));
  const signature = fs.readFileSync(path.join(dir, 'updates.json.sig'), 'utf8');
  return verifyFeed(bytes, signature, keyring);
}

function readManifest(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * What the artifact's signature state is.
 *
 * This is the gate on the handover: the app refuses to replace its own
 * binary with an UNSIGNED installer, and the only thing that opens the gate
 * is this field — in a feed the release key signed. Windows has no code
 * signing yet (`docs/INSTALL.md`), so every Windows artifact is `unsigned`
 * today and the handover stays closed.
 */
function signingFor(platform, manifest) {
  if (platform === 'macos') return manifest?.signing?.macos ?? 'unsigned';
  return manifest?.signing?.windows ?? 'unsigned';
}

/** The artifacts from the build's manifest, in the feed's shape. */
function artifactsFrom(manifest) {
  const entries = manifest?.artifacts ?? [];
  return entries.map((entry) => {
    const parts = String(entry.file).split('-');
    // aipass-desktop-<version>-<platform>-<arch>[-setup].<ext>
    const platform = parts[3] ?? '';
    const arch = parts[4] ?? '';
    return {
      file: entry.file,
      platform,
      arch,
      kind: entry.type,
      bytes: entry.bytes,
      sha256: entry.sha256,
      signature: signingFor(platform, manifest),
    };
  });
}

function main() {
  const dir = path.join(REPO, 'dist');
  const manifest = readManifest(dir);
  const version = manifest?.version ?? JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version;
  const packName = `aipass-content-${version}.json.gz`;
  const packFile = path.join(dir, packName);
  if (!fs.existsSync(packFile)) {
    console.error(`no content pack at ${packFile} — run: npm run desktop:content-pack`);
    process.exit(1);
  }
  const packBytes = fs.readFileSync(packFile);
  const pack = {
    file: packName,
    bytes: packBytes.length,
    sha256: crypto.createHash('sha256').update(packBytes).digest('hex'),
    minShell: version,
  };

  const feed = buildFeed({
    version,
    commit: manifest?.commit ?? null,
    artifacts: artifactsFrom(manifest),
    pack,
    sequence: Number(process.env.AIPASS_RELEASE_SEQUENCE ?? 1),
    releasedAt: new Date().toISOString(),
    notes: process.env.AIPASS_RELEASE_NOTES ?? '',
  });

  const bytes = Buffer.from(JSON.stringify(feed, null, 2));
  const signature = signFeed(bytes, readKey(), keyId());
  fs.writeFileSync(path.join(dir, 'updates.json'), bytes);
  fs.writeFileSync(path.join(dir, 'updates.json.sig'), `${signature}\n`);
  // The feed is checked with the app's own verifier, against the keyring in
  // the source. A key that is not in the keyring signs a feed the app
  // refuses — so this stops the release rather than shipping it.
  const verdict = verifyWrittenFeed(dir);
  if (!verdict.ok) {
    console.error(`the feed does not verify against the keyring: ${verdict.reason}`);
    console.error('the public key for this key id has to be in aipass-bridge/harness/update-keys.mjs,');
    console.error('and it has to be in the app that ships before this feed is published.');
    process.exit(1);
  }
  console.log(`feed ${version} written to dist/updates.json`);
  console.log(`  signed with ${verdict.keyId}`);
  console.log(`  verified against the keyring in the source`);
  console.log(`  sha256 ${crypto.createHash('sha256').update(bytes).digest('hex')}`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    main();
  } catch (err) {
    console.error(err?.message ?? err);
    process.exit(1);
  }
}
