// The update system: the trust, the atomicity, and the rollback.
//
// The titles here are the anchors the rules point at (`AGENTS.md`: a rule
// ends with the exact test that enforces it), so they are written to be
// quoted, not to be searched for.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import {
  check,
  compareVersions,
  downloadPack,
  feedBase,
  pickReleases,
  platformLabel,
  promote,
  refuseUnsignedArtifact,
  refuseWhileRunning,
  rollback,
  updateState,
  verifyFeed,
} from '../harness/update.mjs';
import {
  activeRoot,
  currentRoot,
  linkCurrent,
  pickRoot,
  readActive,
  rootCandidates,
} from '../harness/app-root.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FEED = 'https://releases.example/aipass/updates.json';

const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aipass-update-'));

/** A keypair of the test's own — the real keyring is not this test's business. */
function keypair(id = 'test-key') {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(12);
  return {
    id,
    publicKey: raw.toString('base64'),
    private: privateKey,
    sign: (bytes) => crypto.sign(null, bytes, privateKey),
  };
}

const keyring = (key) => [{ id: key.id, publicKey: key.publicKey }];

const feedBytes = (feed) => Buffer.from(JSON.stringify(feed));

/** The detached signature, over the exact bytes the feed is served as. */
const signFeed = (feed, key) =>
  `ed25519:${key.id}:${key.sign(feedBytes(feed)).toString('base64')}`;

/** A fetch that answers from a table and 404s everything else. */
function fakeFetch(routes) {
  return async (url) => {
    const hit = routes[String(url)];
    if (!hit) return { ok: false, status: 404, text: async () => '', arrayBuffer: async () => new ArrayBuffer(0) };
    return {
      ok: true,
      status: 200,
      text: async () => hit.text ?? '',
      arrayBuffer: async () => hit.bytes ?? new ArrayBuffer(0),
    };
  };
}

/** A release feed with one release in it. */
const sampleFeed = (overrides = {}) => ({
  schema: 1,
  product: 'aipass desktop',
  sequence: 4,
  channel: 'stable',
  generatedAt: '2026-10-21T09:00:00Z',
  releases: [
    {
      version: '0.3.0',
      releasedAt: '2026-10-21T09:00:00Z',
      commit: 'abc1234',
      notes: 'the release notes, in prose',
      content: {
        version: '0.3.0',
        file: 'aipass-content-0.3.0.json.gz',
        bytes: 507784,
        sha256: 'a'.repeat(64),
        minShell: '0.3.0',
      },
      artifacts: [
        {
          file: 'aipass-desktop-0.3.0-windows-x64-setup.exe',
          platform: 'windows',
          arch: 'x64',
          kind: 'nsis',
          bytes: 242392264,
          sha256: 'b'.repeat(64),
          signature: 'unsigned',
        },
      ],
    },
  ],
  ...overrides,
});

/* ------------------------------------------------------------- the pack */

/** The real content tree, read from the repository — a pack like the real one. */
let cachedFiles = null;
function contentFiles() {
  if (cachedFiles) return cachedFiles;
  const files = [];
  const add = (relative, content) => {
    const bytes = Buffer.from(content, 'utf8');
    files.push({
      path: relative,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      encoding: 'utf8',
      content,
    });
  };
  const walk = (dir, prefix) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const relative = path.posix.join(prefix, entry.name);
      if (entry.isDirectory()) walk(full, relative);
      else if (entry.name.endsWith('.mjs')) add(`aipass-bridge/harness/${relative}`, fs.readFileSync(full, 'utf8'));
    }
  };
  walk(path.join(REPO, 'aipass-bridge', 'harness'), '');
  // The CLI, which the shim names — it is part of the content too.
  const binDir = path.join(REPO, 'aipass-bridge', 'bin');
  for (const entry of fs.readdirSync(binDir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.mjs')) {
      add(`aipass-bridge/bin/${entry.name}`, fs.readFileSync(path.join(binDir, entry.name), 'utf8'));
    }
  }
  add('package.json', fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  add('aipass-bridge/bridge/server.mjs', '// the marker the root resolver looks for.\n');
  add('ui/index.html', '<!doctype html><title>aipass</title>\n');
  cachedFiles = files;
  return files;
}

/** A pack on disk, ready to be promoted. */
function writePack(home, version, { mutate = null } = {}) {
  const files = contentFiles().map((file) => ({ ...file }));
  if (mutate) mutate(files);
  const pack = { schema: 1, product: 'aipass desktop', version, files };
  const bytes = zlib.gzipSync(Buffer.from(JSON.stringify(pack)));
  const file = path.join(home, 'app', 'downloads', `aipass-content-${version}.json.gz`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
  return { file, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), bytes };
}

/* --------------------------------------------------------------- the tests */

test('a feed whose signature does not verify is refused', async () => {
  const home = scratch();
  const key = keypair();
  const feed = sampleFeed();
  const bytes = feedBytes(feed);
  // A signature that is the right SHAPE and the wrong bytes.
  const signature = `ed25519:${key.id}:${Buffer.alloc(64).toString('base64')}`;
  const result = await check({
    home,
    url: FEED,
    shellVersion: '0.2.0',
    contentVersion: '0.2.0',
    keyring: keyring(key),
    fetchImpl: fakeFetch({
      [FEED]: { bytes },
      [`${FEED}.sig`]: { text: signature },
    }),
  });
  assert.equal(result.ok, false, 'the feed is not used');
  assert.match(result.reason, /did not verify/, 'and the reason says so');
  assert.deepEqual(result.available, {}, 'nothing is offered');
  assert.equal(readActive(home), null, 'and nothing was written');
});

test('a feed signed by an unknown key is refused', async () => {
  const home = scratch();
  const key = keypair('some-other-key');
  const feed = sampleFeed();
  const bytes = feedBytes(feed);
  const result = await check({
    home,
    url: FEED,
    shellVersion: '0.2.0',
    contentVersion: '0.2.0',
    fetchImpl: fakeFetch({
      [FEED]: { bytes },
      [`${FEED}.sig`]: { text: signFeed(feed, key) },
    }),
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /no key in this build's keyring/, 'the keyring is the source of truth, not the feed');
});

test('a feed with an older sequence number is refused', async () => {
  const home = scratch();
  const key = keypair();
  const newer = sampleFeed({ sequence: 9 });
  const older = sampleFeed({ sequence: 2 });

  const first = await check({
    home,
    url: FEED,
    shellVersion: '0.2.0',
    contentVersion: '0.2.0',
    keyring: keyring(key),
    fetchImpl: fakeFetch({
      [FEED]: { bytes: feedBytes(newer) },
      [`${FEED}.sig`]: { text: signFeed(newer, key) },
    }),
  });
  assert.equal(first.ok, true, 'the first feed is used');

  const second = await check({
    home,
    url: FEED,
    force: true,
    shellVersion: '0.2.0',
    contentVersion: '0.2.0',
    keyring: keyring(key),
    fetchImpl: fakeFetch({
      [FEED]: { bytes: feedBytes(older) },
      [`${FEED}.sig`]: { text: signFeed(older, key) },
    }),
  });
  assert.equal(second.ok, true, 'the older feed is not used');
  assert.match(second.reason, /older than the one already seen/, 'and the reason says why');
  assert.equal(second.fromCache, true, 'the verified cache answers instead');
});

test('a content pack whose hash does not match the feed is refused', async () => {
  const home = scratch();
  const pack = writePack(home, '0.3.0');
  const result = await downloadPack(
    { file: 'aipass-content-0.3.0.json.gz', sha256: 'f'.repeat(64) },
    { home, url: FEED, fetchImpl: fakeFetch({ [`${feedBase(FEED)}aipass-content-0.3.0.json.gz`]: { bytes: fs.readFileSync(pack.file) } }) },
  );
  assert.equal(result.ok, false, 'a pack that does not match the feed is not kept');
  assert.match(result.reason, /does not match the hash in the feed/);
});

test('a content pack whose hash matches the feed is kept', async () => {
  const home = scratch();
  const pack = writePack(home, '0.3.0');
  const result = await downloadPack(
    { file: 'aipass-content-0.3.0.json.gz', sha256: pack.sha256 },
    { home, url: FEED, fetchImpl: fakeFetch({ [`${feedBase(FEED)}aipass-content-0.3.0.json.gz`]: { bytes: fs.readFileSync(pack.file) } }) },
  );
  assert.equal(result.ok, true);
  assert.equal(result.sha256, pack.sha256);
  assert.ok(fs.existsSync(result.file), 'the pack is on disk');
});

test('a content pack is promoted atomically — a failed promotion leaves the old content in place', async () => {
  const home = scratch();
  const good = writePack(home, '0.3.0');
  const first = await promote(good.file, { home });
  assert.equal(first.ok, true, `the pack is promoted: ${first.reason ?? ''}`);
  assert.equal(readActive(home).current.version, '0.3.0');

  // A pack whose file does not match its own hash: the promotion must fail
  // and leave the live content exactly where it was.
  const broken = writePack(home, '0.3.1', {
    mutate: (files) => {
      const target = files.find((f) => f.path === 'package.json');
      target.content = `${target.content}\n// tampered\n`;
    },
  });
  const second = await promote(broken.file, { home });
  assert.equal(second.ok, false, 'the tampered pack is refused');
  assert.match(second.reason, /does not match its hash/);
  assert.equal(readActive(home).current.version, '0.3.0', 'the old content is still the live one');
  assert.equal(activeRoot(home), first.root, 'and the root still resolves to it');
});

test('a pack that names a file outside the tree is refused', async () => {
  const home = scratch();
  const escape = writePack(home, '0.3.2', {
    mutate: (files) => {
      files.push({
        path: '../../escaped.mjs',
        sha256: crypto.createHash('sha256').update('x').digest('hex'),
        encoding: 'utf8',
        content: 'x',
      });
    },
  });
  const result = await promote(escape.file, { home });
  assert.equal(result.ok, false);
  assert.match(result.reason, /outside the tree/);
  assert.equal(fs.existsSync(path.join(home, 'escaped.mjs')), false, 'nothing was written outside');
});

test('a content release is refused when the shell is too old for it', () => {
  const feed = sampleFeed();
  // The release's content needs a 0.3.0 shell.
  const old = pickReleases(feed, { shellVersion: '0.2.0', platform: 'windows', arch: 'x64' });
  assert.equal(old.content, null, 'the content is not offered to a shell that cannot run it');
  assert.ok(old.shell, 'but the shell update is — it is a separate question');

  const current = pickReleases(feed, { shellVersion: '0.3.0', platform: 'windows', arch: 'x64' });
  assert.ok(current.content, 'a shell that can run it is offered the content');
});

test('the app refuses to hand over to an unsigned installer', () => {
  // The handover runs an installer the app downloaded by itself. Until the
  // Windows installer is signed, that is the worm shape — a compromised
  // release host becomes code execution on every machine — so the gate is
  // closed. The gate is the signed feed's own word about the artifact, so
  // only the release key can open it.
  const unsigned = refuseUnsignedArtifact({ file: 'aipass-desktop-0.3.0-windows-x64-setup.exe', signature: 'unsigned' });
  assert.ok(unsigned, 'an unsigned installer is refused');
  assert.equal(unsigned.ok, false);
  assert.match(unsigned.reason, /not signed/);
  assert.equal(refuseUnsignedArtifact({ signature: 'signed' }), null, 'a signed one is not');
  // No signature at all is treated as unsigned, not as permission.
  assert.ok(refuseUnsignedArtifact({ file: 'x.exe' }), 'a missing signature is not permission');
});

test('the update check does not run when the network is down', async () => {
  const home = scratch();
  const key = keypair();
  const feed = sampleFeed();
  const down = async () => { throw new Error('ENOTFOUND'); };

  const first = await check({
    home, url: FEED, shellVersion: '0.2.0', contentVersion: '0.2.0', fetchImpl: down,
  });
  assert.equal(first.ok, false);
  assert.match(first.reason, /could not be reached/);
  assert.deepEqual(first.available, {}, 'nothing is offered and nothing is nagged');

  // With a verified cache in hand, the offline machine still gets an answer.
  await check({
    home, url: FEED, shellVersion: '0.2.0', contentVersion: '0.2.0', keyring: keyring(key),
    fetchImpl: fakeFetch({
      [FEED]: { bytes: feedBytes(feed) },
      [`${FEED}.sig`]: { text: signFeed(feed, key) },
    }),
  });
  const offline = await check({
    home, url: FEED, force: true, shellVersion: '0.2.0', contentVersion: '0.2.0', fetchImpl: down,
  });
  assert.equal(offline.ok, true, 'the cached feed answers');
  assert.equal(offline.fromCache, true);
  assert.equal(offline.stale, true, 'and it says that it is stale');
});

test('the content rollback puts the previous content back', async () => {
  const home = scratch();
  const first = writePack(home, '0.3.0');
  const second = writePack(home, '0.3.1');
  const firstPromoted = await promote(first.file, { home });
  await promote(second.file, { home });
  assert.equal(readActive(home).current.version, '0.3.1');

  const back = rollback({ home });
  assert.equal(back.ok, true, `the rollback works: ${back.reason ?? ''}`);
  assert.equal(readActive(home).current.version, '0.3.0', 'the previous content is live again');
  assert.equal(activeRoot(home), firstPromoted.root, 'and the root resolves to it');
});

test('the window and the CLI run the same content', async () => {
  const home = scratch();
  const pack = writePack(home, '0.3.0');
  const promoted = await promote(pack.file, { home });
  assert.equal(promoted.ok, true);
  // The CLI shim names the stable link, not a versioned directory, so it
  // follows the content and does not go stale at the next update.
  assert.equal(currentRoot(home), promoted.root, 'the link points at the live content');
  const link = path.join(home, 'app', 'current', 'aipass-bridge', 'bin', 'aipass.mjs');
  assert.ok(fs.existsSync(link), 'and the CLI is reachable through it');
});

test('the shell resolves the same root as the Node side', async () => {
  const home = scratch();
  const bundle = path.join(scratch(), 'bundle');
  fs.mkdirSync(path.join(bundle, 'aipass-bridge', 'bridge'), { recursive: true });
  fs.writeFileSync(path.join(bundle, 'aipass-bridge', 'bridge', 'server.mjs'), '//\n');

  // Nothing promoted: the bundle is the root.
  let candidates = rootCandidates({ home, bundleRoot: bundle });
  assert.equal(pickRoot(candidates).source, 'bundle');

  // A content tree promoted: the overlay wins, because it is the newest
  // thing a person deliberately chose.
  const pack = writePack(home, '0.3.0');
  const promoted = await promote(pack.file, { home });
  candidates = rootCandidates({ home, bundleRoot: bundle });
  assert.equal(pickRoot(candidates).source, 'overlay');
  assert.equal(pickRoot(candidates).root, promoted.root);
});

test('an update is never applied while a run is in flight', () => {
  const refused = refuseWhileRunning(true);
  assert.ok(refused, 'a running turn refuses the update');
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /run is in flight/);
  assert.equal(refuseWhileRunning(false), null, 'an idle machine is not refused');
});

test('the versions compare as numbers, not as text', () => {
  assert.equal(compareVersions('0.2.10', '0.2.9'), 1, '0.2.10 is newer than 0.2.9');
  assert.equal(compareVersions('0.2.9', '0.2.10'), -1);
  assert.equal(compareVersions('0.3.0', '0.3.0'), 0);
  assert.equal(compareVersions('0.3.0-rc.1', '0.3.0'), -1, 'a pre-release is older than the release');
});

test('a feed that verifies is used, and the key that signed it is named', () => {
  const key = keypair();
  const feed = sampleFeed();
  const bytes = feedBytes(feed);
  const verdict = verifyFeed(bytes, signFeed(feed, key), keyring(key));
  assert.equal(verdict.ok, true);
  assert.equal(verdict.keyId, key.id);
  assert.equal(verdict.feed.sequence, 4);
});

test('the platform labels are the ones the artifact names use', () => {
  assert.equal(platformLabel('win32'), 'windows');
  assert.equal(platformLabel('darwin'), 'macos');
  assert.equal(platformLabel('linux'), 'linux');
});

test('the update state says what is live and what was checked', async () => {
  const home = scratch();
  const pack = writePack(home, '0.3.0');
  await promote(pack.file, { home });
  const state = updateState({ home });
  assert.equal(state.content, '0.3.0');
  assert.equal(state.source, 'overlay');
  assert.equal(state.previous, null, 'there was nothing before this one');
});

test('the link is not replaced when it already points at the right place', () => {
  const home = scratch();
  const root = path.join(scratch(), 'content', '0.3.0');
  fs.mkdirSync(root, { recursive: true });
  assert.equal(linkCurrent(home, root), true);
  const link = path.join(home, 'app', 'current');
  assert.ok(fs.existsSync(link), 'the link is there');
  assert.equal(linkCurrent(home, root), true, 'and pointing it again is fine');
  assert.equal(currentRoot(home), fs.realpathSync(root));
});

test('the overlay holds the window files in the packaged shape', async () => {
  // The overlay root has to look like the installed one, or the window's
  // own files are not found in it: `rpc.mjs` looks for `desktop/ui` and
  // then `ui`, and the packaged layout is the one that ships.
  const home = scratch();
  const pack = writePack(home, '0.3.0');
  const promoted = await promote(pack.file, { home });
  const dirs = [path.join(promoted.root, 'desktop', 'ui'), path.join(promoted.root, 'ui')];
  const ui = dirs.find((dir) => fs.existsSync(dir));
  assert.ok(ui, 'the window files are found in the overlay');
  assert.ok(fs.existsSync(path.join(ui, 'index.html')), 'and the window itself is in them');
});

test('the content pack holds what the bundler ships', async () => {
  // The pack builder reads the bundler's own resource list, so the overlay
  // and the installed bundle hold the same files. A pack that shipped
  // something the bundle did not would be a pack nobody could test.
  const { collectFiles } = await import('../../scripts/build-content-pack.mjs');
  const paths = collectFiles(REPO).map((file) => file.path);
  for (const expected of ['ui/index.html', 'aipass-bridge/harness/rpc.mjs', 'aipass-bridge/bin/aipass.mjs', 'main.mjs']) {
    assert.ok(paths.includes(expected), `${expected} is in the pack`);
  }
  // The version file is not in the bundle's resource list, and the content
  // tree needs it: APP_VERSION reads it.
  assert.ok(paths.includes('package.json'), 'the version file is in the pack');
});

test('a feed the release lane signed verifies against the keyring', async () => {
  // The round trip the release lane does: sign the exact bytes, and the app
  // verifies those exact bytes. A keyring typo is caught here and by the
  // first check the app makes.
  const { signFeed } = await import('../../scripts/build-update-feed.mjs');
  const key = keypair();
  const feed = sampleFeed();
  const bytes = feedBytes(feed);
  const verdict = verifyFeed(bytes, signFeed(bytes, key.private, key.id), keyring(key));
  assert.equal(verdict.ok, true, `the signed feed verifies: ${verdict.reason ?? ''}`);
  assert.equal(verdict.keyId, key.id);
});

test('the keyring holds keys that are keys', async () => {
  // A keyring entry that is not a 32-byte key cannot verify anything, and
  // the failure would read as "the feed is forged" rather than "the keyring
  // is broken". So it is checked here instead.
  const { KEYRING } = await import('../harness/update-keys.mjs');
  assert.ok(KEYRING.length, 'the keyring is not empty');
  for (const entry of KEYRING) {
    const raw = Buffer.from(entry.publicKey, 'base64');
    assert.equal(raw.length, 32, `${entry.id} is a 32-byte key`);
    assert.match(entry.id, /^[A-Za-z0-9._-]+$/, 'the id is one the signature file can carry');
  }
});
