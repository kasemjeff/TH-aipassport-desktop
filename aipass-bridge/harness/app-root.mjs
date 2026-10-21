// One rule for "where the app's files are", shared by the surfaces that have
// to agree on it.
//
// The app runs from one of three roots, in this order:
//
//   1. the CONTENT OVERLAY — a promoted content tree under `~/.aipass/app/`.
//      It is put there by the update system, from a pack whose hash is in a
//      signed feed, so it is a verified release of the content and not a
//      stray directory.
//   2. the BUNDLE — the resources inside the installed app.
//   3. the REPOSITORY — a checkout, found by walking up from the executable.
//
// The overlay comes first for the reason the shell's own comment gives: an
// app that runs the REPOSITORY's files when a checkout happens to sit on the
// same machine is not the build that was installed. The overlay is not a
// checkout — it is the newest thing a person deliberately chose, and it is
// the only thing here that was checked against a signature.
//
// The Rust shell implements the same rule (`desktop/src-tauri/src/main.rs`),
// because the shell is the one that spawns the backend and the shell cannot
// import JavaScript. Two implementations of one rule can drift, so a test
// says the two agree on the same fixtures.
import fs from 'node:fs';
import path from 'node:path';
import { aipassHome } from './settings.mjs';

/** The file that says "this directory is an app root". */
export const MARKER = 'aipass-bridge/bridge/server.mjs';

/** The directory the app's own state lives in, under the aipass home. */
export const appDir = (home = aipassHome()) => path.join(home, 'app');

/** The pointer to the content that is live. */
export const activeFile = (home = aipassHome()) => path.join(appDir(home), 'active.json');

/** Where promoted content trees live. */
export const contentDir = (home = aipassHome()) => path.join(appDir(home), 'content');

/** Where a pack is unpacked before it is promoted. */
export const stagingDir = (home = aipassHome()) => path.join(appDir(home), 'staging');

/** Where the downloaded artifacts live. */
export const downloadsDir = (home = aipassHome()) => path.join(appDir(home), 'downloads');

/** Where the backend leaves a command for the shell to read. */
export const commandsDir = (home = aipassHome()) => path.join(appDir(home), 'commands');

/** One command file: the handover to the installer. */
export const installCommandFile = (home = aipassHome()) => path.join(commandsDir(home), 'install.json');

/** The stable path the CLI shim names — a link to the live content root. */
export const currentLink = (home = aipassHome()) => path.join(appDir(home), 'current');

/** Read the active pointer. A missing or broken file means "no overlay". */
export function readActive(home = aipassHome()) {
  try {
    const raw = fs.readFileSync(activeFile(home), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const current = parsed.current && typeof parsed.current.root === 'string'
      ? { version: String(parsed.current.version ?? ''), root: parsed.current.root }
      : null;
    const previous = parsed.previous && typeof parsed.previous.root === 'string'
      ? { version: String(parsed.previous.version ?? ''), root: parsed.previous.root }
      : null;
    if (!current) return null;
    return { schema: Number(parsed.schema ?? 1), current, previous, updatedAt: Number(parsed.updatedAt ?? 0) };
  } catch {
    return null;
  }
}

/** The overlay root, when one is active and is still on disk. */
export function activeRoot(home = aipassHome()) {
  const active = readActive(home);
  if (!active?.current?.root) return null;
  const root = active.current.root;
  if (!fs.existsSync(path.join(root, MARKER))) return null;
  return root;
}

/**
 * The candidates, in the order they are tried.
 *
 * `bundleRoot` is where the installed app's resources are; `repoRoot` is a
 * checkout. Both are optional — a packaged app has no repo, and a checkout
 * has no bundle.
 */
export function rootCandidates({ home = aipassHome(), bundleRoot = null, repoRoot = null } = {}) {
  const candidates = [];
  const overlay = activeRoot(home);
  if (overlay) candidates.push({ root: overlay, source: 'overlay' });
  if (bundleRoot) candidates.push({ root: bundleRoot, source: 'bundle' });
  if (repoRoot) candidates.push({ root: repoRoot, source: 'repo' });
  return candidates;
}

/** The first candidate that is really an app root. */
export function pickRoot(candidates) {
  for (const candidate of candidates ?? []) {
    if (fs.existsSync(path.join(candidate.root, MARKER))) return candidate;
  }
  return null;
}

/** Where the root's version lives — the same file `APP_VERSION` reads. */
export function rootVersion(root) {
  try {
    const raw = fs.readFileSync(path.join(root, 'package.json'), 'utf8');
    const parsed = JSON.parse(raw);
    return typeof parsed?.version === 'string' ? parsed.version : null;
  } catch {
    return null;
  }
}

/** Do two paths name the same place on disk? */
const samePlace = (a, b) => {
  try {
    return fs.realpathSync(a) === fs.realpathSync(b);
  } catch {
    return false;
  }
};

/**
 * Point the stable `current` link at the live content root.
 *
 * The CLI shim names this link, not a versioned directory, so a content
 * update does not leave the CLI running yesterday's code. A link is used
 * rather than a copied file because the shim has to reach a directory tree.
 *
 * Replacing a live link is a window where the shim has nothing to run, so a
 * link that already points at the right place is left exactly as it is.
 */
export function linkCurrent(home = aipassHome(), root) {
  if (!root) return false;
  const link = currentLink(home);
  try {
    fs.mkdirSync(appDir(home), { recursive: true });
    if (samePlace(link, root)) return true;
    fs.rmSync(link, { recursive: true, force: true });
    // 'junction' is a directory link on Windows and is ignored elsewhere,
    // where Node makes a directory symlink — which is what is wanted there.
    fs.symlinkSync(path.resolve(root), link, 'junction');
    return true;
  } catch {
    return false;
  }
}

/** The root the link points at, when the link is there. */
export function currentRoot(home = aipassHome()) {
  const link = currentLink(home);
  try {
    if (!fs.existsSync(link)) return null;
    return fs.realpathSync(link);
  } catch {
    return null;
  }
}
