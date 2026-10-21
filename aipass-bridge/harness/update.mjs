// update.mjs — the update service.
//
// What it does, in one line: it knows what is out there, it proves it, and it
// puts it on disk without ever putting anything unverified there.
//
// The trust is the feed's signature. The integrity is the hash inside that
// signed feed. The atomicity is `writeFileAtomic` and a rename. Nothing else
// here is load-bearing.
//
// The rules it obeys, and why:
//
//   - The network is OPTIONAL. A machine that is offline gets the cached
//     feed or nothing, and nothing is nagged — an app that cries wolf about
//     updates is an app people mute.
//   - The page never touches the network. The window's CSP allows the
//     loopback and nothing else, and this module lives on the other side of
//     it: the backend. The page asks over `/rpc` and gains no privilege.
//   - Nothing blocks the event loop. Every walk and every child process is
//     async (`fs.promises`, `spawn`), because a synchronous promotion would
//     freeze every window call for the length of it.
//   - The user's data is never touched. The content is code; the settings,
//     the sessions and the token are the user's, and no update reads or
//     writes them.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { aipassHome } from './settings.mjs';
import { writeFileAtomic } from './atomic-write.mjs';
import { KEYRING } from './update-keys.mjs';
import {
  MARKER,
  activeFile,
  appDir,
  contentDir,
  downloadsDir,
  linkCurrent,
  readActive,
  rootVersion,
  stagingDir,
} from './app-root.mjs';

const gunzip = promisify(zlib.gunzip);

/** Where the release lane publishes the feed. */
export const DEFAULT_FEED_URL =
  'https://github.com/niawjunior/aipass-bridge/releases/latest/download/updates.json';

/** The env override — the only way to point the app at another feed. */
export const feedUrl = () => process.env.AIPASS_UPDATE_FEED?.trim() || DEFAULT_FEED_URL;

/** The directory the feed lives in; the pack and the artifacts sit beside it. */
export const feedBase = (url = feedUrl()) => url.replace(/[^/]*$/, '');

/** How often the feed is asked for. A static file does not need more. */
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** The caps a pack has to fit inside. A signed feed is trusted, but a
 *  corrupt one is still a corrupt one, and an unbounded tree is a way to
 *  fill a disk. */
export const MAX_PACK_BYTES = 64 * 1024 * 1024;
export const MAX_TREE_BYTES = 32 * 1024 * 1024;
export const MAX_FILES = 5000;
/** The Windows installer is 231 MiB; the cap is generous but not endless. */
export const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024;

/** How many content trees are kept, so a rollback always has somewhere to go. */
export const KEEP_CONTENT = 2;

/**
 * The platform labels the feed speaks.
 *
 * They are the same labels `scripts/build-desktop.mjs` puts in an artifact
 * name. That script imports these, so there is one table and not two.
 */
export const PLATFORM_LABELS = { win32: 'windows', darwin: 'macos', linux: 'linux' };
export const ARCH_LABELS = {
  win32: { x64: 'x64', arm64: 'arm64' },
  darwin: { arm64: 'arm64', x64: 'x64' },
  linux: { x64: 'x86_64', arm64: 'aarch64' },
};

export const platformLabel = (platform = process.platform) => PLATFORM_LABELS[platform] ?? platform;
export const archLabel = (platform = process.platform, arch = process.arch) =>
  ARCH_LABELS[platform]?.[arch] ?? arch;

/* --------------------------------------------------------------- versions */

/** "0.2.10" is newer than "0.2.9" — the parts are numbers, not text. */
export function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return 0;
  for (let i = 0; i < 3; i += 1) {
    if (left.nums[i] !== right.nums[i]) return left.nums[i] < right.nums[i] ? -1 : 1;
  }
  if (left.pre === right.pre) return 0;
  // A pre-release is older than the release it leads to.
  if (!left.pre) return 1;
  if (!right.pre) return -1;
  return left.pre < right.pre ? -1 : 1;
}

function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(String(value ?? '').trim());
  if (!match) return null;
  return {
    nums: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] ?? null,
  };
}

/* ------------------------------------------------------------ verification */

// The SPKI header of an ed25519 public key: the prefix every DER-encoded
// ed25519 key starts with. The keyring holds the raw 32 bytes, and this is
// what turns them into something `node:crypto` will verify against.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/**
 * Check a feed against the keyring.
 *
 * The signature is detached and over the exact bytes of the feed, so there
 * is no canonical form to agree on and no field order to get wrong. The feed
 * is parsed only AFTER it verifies — an unverified feed is never read.
 */
export function verifyFeed(bytes, signature, keyring = KEYRING) {
  const text = String(signature ?? '').trim();
  const match = /^ed25519:([A-Za-z0-9._-]+):([A-Za-z0-9+/=]+)$/.exec(text);
  if (!match) return { ok: false, reason: 'the signature file is not in the expected shape' };
  const [, keyId, encoded] = match;
  const entry = keyring.find((key) => key.id === keyId);
  if (!entry) return { ok: false, reason: `no key in this build's keyring is named ${keyId}` };

  let raw;
  try {
    raw = Buffer.from(entry.publicKey, 'base64');
  } catch {
    return { ok: false, reason: 'the keyring entry is not base64' };
  }
  if (raw.length !== 32) return { ok: false, reason: 'the keyring entry is not a 32-byte key' };

  let signatureBytes;
  try {
    signatureBytes = Buffer.from(encoded, 'base64');
  } catch {
    return { ok: false, reason: 'the signature is not base64' };
  }
  if (signatureBytes.length !== 64) {
    return { ok: false, reason: `the signature is ${signatureBytes.length} bytes, not 64` };
  }

  let verified = false;
  try {
    const key = crypto.createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
      format: 'der',
      type: 'spki',
    });
    verified = crypto.verify(null, bytes, key, signatureBytes);
  } catch {
    verified = false;
  }
  if (!verified) return { ok: false, reason: 'the signature does not verify against the keyring' };

  let feed;
  try {
    feed = JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch (err) {
    return { ok: false, reason: `the feed is not JSON: ${err?.message ?? err}` };
  }
  if (!feed || typeof feed !== 'object' || !Array.isArray(feed.releases)) {
    return { ok: false, reason: 'the feed has no releases' };
  }
  return { ok: true, feed, keyId };
}

/* --------------------------------------------------------------- the feed */

/**
 * The two answers the feed can give, which are not the same release.
 *
 * The SHELL update is the newest release that ships an artifact for this
 * platform. The CONTENT update is the newest release whose content this
 * shell can run — a content release that needs a newer shell says so, and
 * the app does not offer it to a shell that cannot read it.
 */
export function pickReleases(feed, { platform, arch, shellVersion } = {}) {
  const releases = Array.isArray(feed?.releases) ? feed.releases : [];
  const sorted = [...releases].sort((a, b) => compareVersions(b?.version, a?.version));
  const plat = platform ?? platformLabel();
  const arc = arch ?? archLabel();
  let shell = null;
  let content = null;
  for (const release of sorted) {
    if (!shell && Array.isArray(release?.artifacts)) {
      const artifact = release.artifacts.find((a) => a?.platform === plat && a?.arch === arc);
      if (artifact) shell = { release, artifact };
    }
    if (!content && release?.content) {
      const min = release.content.minShell ?? '0.0.0';
      if (!shellVersion || compareVersions(shellVersion, min) >= 0) {
        content = { release, pack: release.content };
      }
    }
    if (shell && content) break;
  }
  return { shell, content };
}

/* ---------------------------------------------------------------- storage */

/**
 * An update never lands under a running turn.
 *
 * A run holds the harness in memory; swapping the files under it is how a
 * half-applied state becomes a mystery. The refusal is a function so the
 * rule can be tested without a backend: the window offers the update again
 * when the run ends.
 */
export function refuseWhileRunning(running) {
  return running
    ? { ok: false, reason: 'a run is in flight — the update waits for it to finish' }
    : null;
}

const readJson = (file, fallback = null) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
};

const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
};

const feedStateFile = (home) => path.join(appDir(home), 'feed-state.json');
const feedCacheFile = (home) => path.join(appDir(home), 'feed-cache.json');

/* ----------------------------------------------------------------- check */

/**
 * What is out there.
 *
 * The cached feed answers when the network does not, and the cache is only
 * ever written after a feed has verified — so a hostile host cannot poison
 * it. A feed that is OLDER than the one already seen is refused: that is the
 * rollback guard, and an attacker who captured an old signed feed cannot
 * replay it to pull the app back to an old build.
 */
export async function check({
  home = aipassHome(),
  root = null,
  platform,
  arch,
  shellVersion = process.env.AIPASS_SHELL_VERSION ?? null,
  contentVersion = null,
  keyring = KEYRING,
  fetchImpl = fetch,
  now = Date.now(),
  url = feedUrl(),
  force = false,
} = {}) {
  const state = readJson(feedStateFile(home), {}) ?? {};
  const cached = readJson(feedCacheFile(home), null);
  const current = currentVersions({ root, home, shellVersion, contentVersion });

  const fresh = !force && Number(state.checkedAt ?? 0) > 0
    && now - Number(state.checkedAt) < CHECK_INTERVAL_MS;
  if (fresh && cached?.feed) {
    return answer(cached.feed, { home, current, checkedAt: Number(state.checkedAt), fromCache: true, stale: false });
  }

  let bytes = null;
  let signature = null;
  let failure = null;
  try {
    const [feedResponse, signatureResponse] = await Promise.all([
      fetchImpl(url, { signal: AbortSignal.timeout(15000) }),
      fetchImpl(`${url}.sig`, { signal: AbortSignal.timeout(15000) }),
    ]);
    if (!feedResponse.ok) failure = `the feed answered ${feedResponse.status}`;
    else if (!signatureResponse.ok) failure = `the signature answered ${signatureResponse.status}`;
    else {
      bytes = Buffer.from(await feedResponse.arrayBuffer());
      signature = await signatureResponse.text();
    }
  } catch (err) {
    failure = `the update feed could not be reached: ${err?.message ?? err}`;
  }

  if (bytes) {
    const verdict = verifyFeed(bytes, signature, keyring);
    if (!verdict.ok) {
      // A feed that does not verify is neither used nor cached. The CACHE is
      // still good — it was verified when it was fetched — so a machine that
      // meets a broken or a hostile host keeps working from it.
      const reason = `the update feed did not verify: ${verdict.reason}`;
      if (cached?.feed) {
        return answer(cached.feed, { home, current, checkedAt: now, fromCache: true, stale: true, reason });
      }
      return { ok: false, reason, checkedAt: now, current, available: {} };
    }
    const sequence = Number(verdict.feed.sequence ?? 0);
    const seen = Number(state.sequence ?? 0);
    if (Number.isFinite(seen) && seen > 0 && sequence < seen) {
      const reason = `the update feed is older than the one already seen (${sequence} < ${seen}) — refused`;
      if (cached?.feed) {
        return answer(cached.feed, { home, current, checkedAt: now, fromCache: true, stale: true, reason });
      }
      return { ok: false, reason, checkedAt: now, current, available: {} };
    }
    writeJson(feedCacheFile(home), { feed: verdict.feed, checkedAt: now });
    writeJson(feedStateFile(home), { sequence, checkedAt: now });
    return answer(verdict.feed, { home, current, checkedAt: now, fromCache: false, stale: false });
  }

  // The network failed. The cache answers; nothing is nagged.
  if (cached?.feed) {
    return answer(cached.feed, { home, current, checkedAt: now, fromCache: true, stale: true, reason: failure });
  }
  return { ok: false, reason: failure, checkedAt: now, current, available: {} };
}

/** What this build is, as the feed needs to know it. */
function currentVersions({ root, home, shellVersion, contentVersion }) {
  const active = readActive(home);
  const content = contentVersion ?? (root ? rootVersion(root) : null) ?? active?.current?.version ?? null;
  return {
    content,
    shell: shellVersion ?? null,
    source: active?.current?.root && root && samePath(active.current.root, root) ? 'overlay' : 'bundle',
  };
}

const samePath = (a, b) => {
  try {
    return path.resolve(a) === path.resolve(b);
  } catch {
    return false;
  }
};

/** The answer the window reads: what is running, and what is out there. */
function answer(feed, { home, current, checkedAt, fromCache, stale, reason = null }) {
  const { shell, content } = pickReleases(feed, { shellVersion: current.shell });
  const available = {};

  if (content?.pack && compareVersions(content.pack.version ?? content.release.version, current.content ?? '0.0.0') > 0) {
    available.content = {
      version: String(content.pack.version ?? content.release.version),
      file: content.pack.file,
      bytes: Number(content.pack.bytes ?? 0),
      sha256: content.pack.sha256,
      releasedAt: content.release.releasedAt ?? null,
      notes: content.release.notes ?? '',
      minShell: content.pack.minShell ?? '0.0.0',
    };
  }
  if (shell?.artifact && current.shell && compareVersions(shell.release.version, current.shell) > 0) {
    available.shell = {
      version: String(shell.release.version),
      file: shell.artifact.file,
      bytes: Number(shell.artifact.bytes ?? 0),
      sha256: shell.artifact.sha256,
      signature: shell.artifact.signature ?? 'unsigned',
      releasedAt: shell.release.releasedAt ?? null,
      notes: shell.release.notes ?? '',
    };
  }
  return { ok: true, checkedAt, fromCache, stale, reason, current, available, home };
}

/* -------------------------------------------------------------- download */

/**
 * Fetch a file the feed names and check it against the feed.
 *
 * The hash is the one in the SIGNED feed, so this is not "the download
 * matches itself" — it is "the download matches what the release key signed".
 *
 * The bytes are streamed to disk: the shell's artifact is 231 MiB, and
 * holding that in memory to hash it is a machine that runs out of memory on
 * the update.
 */
export async function downloadVerified(release, { home = aipassHome(), fetchImpl = fetch, url = feedUrl() } = {}) {
  if (!release?.file || !release?.sha256) return { ok: false, reason: 'the release names no file' };
  const name = path.basename(String(release.file));
  const target = path.join(downloadsDir(home), name);
  const address = `${feedBase(url)}${name}`;
  let response;
  try {
    response = await fetchImpl(address, { signal: AbortSignal.timeout(600000) });
  } catch (err) {
    return { ok: false, reason: `the file could not be fetched: ${err?.message ?? err}` };
  }
  if (!response.ok) return { ok: false, reason: `the file answered ${response.status}` };

  await fsp.mkdir(downloadsDir(home), { recursive: true });
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  const sink = fs.createWriteStream(target);
  try {
    if (response.body) {
      for await (const chunk of response.body) {
        const buf = Buffer.from(chunk);
        hash.update(buf);
        bytes += buf.length;
        if (bytes > MAX_ARTIFACT_BYTES) throw new Error(`more than the ${MAX_ARTIFACT_BYTES} allowed`);
        if (!sink.write(buf)) await once(sink, 'drain');
      }
      await new Promise((resolve, reject) => sink.end((err) => (err ? reject(err) : resolve())));
    } else {
      const buf = Buffer.from(await response.arrayBuffer());
      hash.update(buf);
      bytes = buf.length;
      sink.end(buf);
      await new Promise((resolve) => sink.on('close', resolve));
    }
  } catch (err) {
    sink.destroy();
    await fsp.rm(target, { force: true });
    return { ok: false, reason: `the download failed: ${err?.message ?? err}` };
  }

  const digest = hash.digest('hex');
  if (digest !== String(release.sha256)) {
    // A file that does not match the feed is not kept: a half-written
    // artifact in the downloads directory is a thing a later run might
    // mistake for a good one.
    await fsp.rm(target, { force: true });
    return { ok: false, reason: 'the file does not match the hash in the feed' };
  }
  return { ok: true, file: target, sha256: digest, bytes };
}

/** The content pack is a file like any other: it is fetched the same way. */
export const downloadPack = downloadVerified;

/**
 * The handover is refused for an unsigned installer.
 *
 * The Windows installer is unsigned today (`docs/INSTALL.md`), and an app
 * that downloads and runs an unsigned installer on its own is the worm
 * shape — a compromised release host becomes code execution on every
 * machine. The gate is the signed feed's own word about the artifact, so
 * only the release key can open it, and the key is the maintainer's.
 */
export function refuseUnsignedArtifact(release) {
  const state = String(release?.signature ?? 'unsigned');
  if (state === 'unsigned' || !state) {
    return {
      ok: false,
      reason: 'the installer is not signed yet — the app does not replace itself with an unsigned installer',
    };
  }
  return null;
}

/* --------------------------------------------------------------- promote */

/**
 * Put a verified pack into place.
 *
 * The order matters, and every step leaves the app working:
 *   1. unpack into a staging directory — the live tree is untouched;
 *   2. check every file against its own hash in the pack;
 *   3. run the staged tree's loadability probe, in its own process;
 *   4. rename the staging tree into place — one atomic move;
 *   5. point `active.json` at it with the atomic swap.
 *
 * A failure at any step leaves the previous content live, because
 * `active.json` has not moved yet.
 */
export async function promote(packFile, { home = aipassHome(), nodePath = process.execPath } = {}) {
  let raw;
  try {
    raw = await fsp.readFile(packFile);
  } catch (err) {
    return { ok: false, reason: `the pack could not be read: ${err?.message ?? err}` };
  }
  if (raw.length > MAX_PACK_BYTES) {
    return { ok: false, reason: `the pack is ${raw.length} bytes, over the ${MAX_PACK_BYTES} allowed` };
  }
  let pack;
  try {
    pack = JSON.parse((await gunzip(raw)).toString('utf8'));
  } catch (err) {
    return { ok: false, reason: `the pack is not a readable pack: ${err?.message ?? err}` };
  }
  const version = String(pack?.version ?? '');
  if (!version) return { ok: false, reason: 'the pack names no version' };
  const files = Array.isArray(pack.files) ? pack.files : [];
  if (!files.length) return { ok: false, reason: 'the pack holds no files' };
  if (files.length > MAX_FILES) {
    return { ok: false, reason: `the pack holds ${files.length} files, over the ${MAX_FILES} allowed` };
  }

  const staging = path.join(stagingDir(home), version);
  const discard = async () => { await fsp.rm(staging, { recursive: true, force: true }); };
  await discard();
  await fsp.mkdir(staging, { recursive: true });

  let total = 0;
  for (const file of files) {
    const relative = String(file?.path ?? '');
    const target = path.join(staging, relative);
    // The path has to stay inside the staging tree: a pack that names
    // "../../something" writes outside it.
    const inside = path.relative(staging, target);
    if (!relative || !inside || inside === '..' || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)) {
      await discard();
      return { ok: false, reason: `the pack names a file outside the tree: ${relative}` };
    }
    const bytes = file?.encoding === 'base64'
      ? Buffer.from(String(file.content ?? ''), 'base64')
      : Buffer.from(String(file.content ?? ''), 'utf8');
    total += bytes.length;
    if (total > MAX_TREE_BYTES) {
      await discard();
      return { ok: false, reason: `the pack unpacks to more than the ${MAX_TREE_BYTES} allowed` };
    }
    if (file?.sha256) {
      const digest = crypto.createHash('sha256').update(bytes).digest('hex');
      if (digest !== String(file.sha256)) {
        await discard();
        return { ok: false, reason: `the file ${relative} does not match its hash` };
      }
    }
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, bytes);
  }

  // The loadability probe: the staged tree has to import, in its own
  // process, before it is allowed to be the live one.
  const probe = path.join(staging, 'aipass-bridge', 'harness', 'health.mjs');
  const smoke = await runProbe(nodePath, probe);
  if (!smoke.ok) {
    await discard();
    return { ok: false, reason: `the staged content did not load: ${smoke.detail}` };
  }

  await fsp.mkdir(contentDir(home), { recursive: true });
  const target = path.join(contentDir(home), version);
  await fsp.rm(target, { recursive: true, force: true });
  await fsp.rename(staging, target);

  const active = readActive(home);
  const next = {
    schema: 1,
    current: { version, root: target },
    previous: active?.current ?? null,
    updatedAt: Date.now(),
  };
  writeJson(activeFile(home), next);
  linkCurrent(home, target);
  await pruneContent(home, target);
  return { ok: true, version, root: target, previous: active?.current?.version ?? null };
}

/** Run the staged tree's probe, in its own process. */
function runProbe(nodePath, probe) {
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let child;
    try {
      child = spawn(nodePath, [probe], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ ok: false, detail: error?.message ?? String(error) });
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
    }, 20000);
    child.stdout?.on('data', (chunk) => { out += chunk; });
    child.stderr?.on('data', (chunk) => { err += chunk; });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ ok: false, detail: error?.message ?? String(error) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const detail = (err || out).trim().split('\n').slice(-3).join(' / ');
        resolve({ ok: false, detail: detail || `the probe exited ${code}` });
        return;
      }
      try {
        const last = out.trim().split('\n').filter(Boolean).pop() ?? '';
        const answer = JSON.parse(last);
        resolve(answer?.ok ? { ok: true } : { ok: false, detail: 'the probe did not answer ok' });
      } catch {
        resolve({ ok: false, detail: 'the probe did not answer' });
      }
    });
  });
}

/** Keep the last few content trees; the rest are older than the rollback. */
async function pruneContent(home, keepRoot) {
  const dir = contentDir(home);
  let entries = [];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  const trees = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const full = path.join(dir, entry.name);
    let stamp = 0;
    try { stamp = (await fsp.stat(full)).mtimeMs; } catch { stamp = 0; }
    trees.push({ full, stamp });
  }
  trees.sort((a, b) => b.stamp - a.stamp);
  for (const tree of trees.slice(KEEP_CONTENT)) {
    // The live one is never pruned, whatever the mtimes say.
    if (path.resolve(tree.full) === path.resolve(keepRoot)) continue;
    await fsp.rm(tree.full, { recursive: true, force: true });
  }
}

/* -------------------------------------------------------------- rollback */

/**
 * Go back to the previous content tree.
 *
 * The rollback is a pointer flip: the previous tree was kept on disk when
 * the current one was promoted, so this does not need the network and does
 * not need the pack.
 */
export function rollback({ home = aipassHome() } = {}) {
  const active = readActive(home);
  if (!active?.previous?.root) return { ok: false, reason: 'there is no previous content to go back to' };
  const root = active.previous.root;
  if (!fs.existsSync(path.join(root, MARKER))) {
    return { ok: false, reason: 'the previous content is not on disk any more' };
  }
  const next = {
    schema: 1,
    current: { version: active.previous.version, root },
    previous: active.current,
    updatedAt: Date.now(),
  };
  writeJson(activeFile(home), next);
  linkCurrent(home, root);
  return { ok: true, version: active.previous.version, root };
}

/** What the app knows about its own update state — for `/update` and the log. */
export function updateState({ home = aipassHome() } = {}) {
  const active = readActive(home);
  const state = readJson(feedStateFile(home), {}) ?? {};
  return {
    content: active?.current?.version ?? null,
    previous: active?.previous?.version ?? null,
    source: active?.current ? 'overlay' : 'bundle',
    checkedAt: Number(state.checkedAt ?? 0),
    sequence: Number(state.sequence ?? 0),
  };
}
