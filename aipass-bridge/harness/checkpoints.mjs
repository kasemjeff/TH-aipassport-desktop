// The undo of an apply.
//
// A run stages its edits in the overlay, the person approves them, and the
// apply writes real files — and until now there was no way back: the docs
// told the reader to run `git restore` by hand, which is not an answer for a
// person who never asked for git in the first place. Every competitor in this
// category (Cline's checkpoints, Windsurf's named checkpoints, OpenCode's undo)
// can roll an apply back, so this store is that ability, kept deliberately
// boring: the bytes that were on the disk before the apply, and nothing else.
//
// WHERE it lives is the first rule of the root guide: the overlay is the only
// write surface of a run, and a copy of the user's source inside the project
// could be committed by accident. So the store sits under
// `~/.aipass/run/checkpoints/<projectKey>/` — outside every project, beside
// the sandbox projections, which are outside for the same reason.
//
// The store is SYNCHRONOUS, and that is a deliberate exception to the async
// discipline of rule 9. Two reasons, both facts about this codebase: the
// apply path it serves is synchronous by construction (`agent.mjs` calls
// `harness.apply()` without awaiting it, and that file is not ours to change),
// and the shared atomic swap (`harness/atomic-write.mjs`) is synchronous too —
// one owner of "atomic" is worth more than a second copy of it that can
// disagree about what atomic means. What it touches is bounded: a handful of
// small files per checkpoint and at most KEEP checkpoints per project. It is
// not a tree walk, which is what rule 9 is about.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { aipassHome } from './settings.mjs';
import { writeFileAtomic } from './atomic-write.mjs';
import { realPath } from './overlay.mjs';
import { projectKey } from './project-key.mjs';
export { projectKey };

/**
 * How many checkpoints one project keeps.
 *
 * The knob is here and not in the settings sheet: a person who wants a deeper
 * history changes this one number, and the window does not grow a field for
 * it. The oldest is pruned when a new one lands.
 */
export const KEEP = 20;

/** Where the store lives — outside every project (root rule 1). */
export const storeRoot = () => path.join(aipassHome(), 'run', 'checkpoints');

// projectKey is now shared via ./project-key.mjs (single source of truth).

/** The directory one project's checkpoints live in. */
const projectDir = (root) => path.join(storeRoot(), projectKey(root));

/**
 * One checkpoint's name.
 *
 * The millisecond stamp leads, so the names sort into the order they were
 * taken in — which is how the pruning knows what is oldest.
 */
const newId = (stamp = Date.now()) => `${stamp}-${crypto.randomBytes(4).toString('hex')}`;

/** The bytes on the disk right now, or null when there is no file there. */
const readBytes = (abs) => {
  try { return fs.readFileSync(abs); } catch { return null; }
};

/** The meta of one checkpoint, or null when the directory holds no readable one. */
const readMeta = (dir) => {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
    if (!parsed || typeof parsed !== 'object' || !parsed.id) return null;
    return parsed;
  } catch {
    return null;
  }
};

/**
 * Is that path inside the project?
 *
 * Two boundaries, the same two the tools use: the lexical one (a prefix test
 * compares case, and Windows does not) and the physical one (a link out of
 * the project is a link out of the root). A restore writes real files, so it
 * asks the question before it writes.
 */
function inside(root, abs) {
  const base = path.resolve(root);
  const target = path.resolve(abs);
  const rel = path.relative(base, target);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return false;
  const realRoot = realPath(base) ?? base;
  const real = realPath(target);
  // A file that is not there yet (one the apply created) has no real path
  // yet; the lexical answer stands for it.
  if (!real) return true;
  const realRel = path.relative(realRoot, real);
  return !(realRel === '..' || realRel.startsWith(`..${path.sep}`) || path.isAbsolute(realRel));
}

/**
 * The name of one checkpoint, as a name and nothing else.
 *
 * The id comes from the window, so it is checked before it is put into a
 * path: a name with a separator in it would reach out of the store, and
 * `remove` deletes what it is given.
 */
function checkpointDir(root, id) {
  const name = String(id ?? '').trim();
  if (!name || !/^[A-Za-z0-9._-]+$/.test(name) || name === '.' || name === '..') {
    throw new Error(`not a checkpoint name: ${id}`);
  }
  return path.join(projectDir(root), name);
}

/**
 * Take a checkpoint of the files an apply is about to write.
 *
 * `changes` is what the apply touches: `{abs, file, deleted, after}` — the
 * absolute path, the project-relative name, whether the file is removed, and
 * the bytes about to be written (null for a delete). The bytes currently on
 * the disk are read HERE, before the write, so a restore puts back what was
 * really there and not what the overlay remembers.
 *
 * @returns {object|null} the checkpoint's meta, or null when there was
 *   nothing to checkpoint.
 */
export function take({ root, changes }) {
  const list = (changes ?? []).filter(Boolean);
  if (!list.length) return null;
  // One stamp for the name and the answer: list() sorts by name, and
  // createdAt is the same order, ties included.
  const stamp = Date.now();
  const id = newId(stamp);
  const dir = path.join(projectDir(root), id);
  const files = [];
  const blobs = [];
  for (const [i, change] of list.entries()) {
    const before = readBytes(change.abs);
    const after = change.deleted ? null : Buffer.from(String(change.after ?? ''), 'utf8');
    const entry = {
      path: change.file,
      abs: change.abs,
      deleted: Boolean(change.deleted),
      // A file that was not there before has no "before": its restore removes
      // it again.
      before: before === null ? null : `before-${i}.bin`,
      after: after === null ? null : `after-${i}.bin`,
    };
    files.push(entry);
    if (before !== null) blobs.push([entry.before, before]);
    if (after !== null) blobs.push([entry.after, after]);
  }
  const meta = { id, createdAt: stamp, root: path.resolve(root), files };
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, data] of blobs) writeFileAtomic(path.join(dir, name), data);
  writeFileAtomic(path.join(dir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`);
  prune(root);
  return meta;
}

/** The checkpoints of one project, newest first. */
export function list({ root }) {
  const dir = projectDir(root);
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  // The names lead with the millisecond stamp, so the reverse sort is the
  // newest first.
  for (const name of names.sort().reverse()) {
    const meta = readMeta(path.join(dir, name));
    if (meta) out.push(meta);
  }
  return out;
}

/**
 * Put the files back as they were before the checkpoint.
 *
 * The bytes go back with the shared atomic swap (write-then-rename), so a
 * crash mid-restore leaves the old file or the new one and never half of
 * either. A file whose "before" was null did not exist before the apply, so
 * the restore takes it away again.
 *
 * @returns {{id: string, restored: string[], removed: string[], skipped: string[]}}
 */
export function restore({ root, id }) {
  const dir = checkpointDir(root, id);
  const meta = readMeta(dir);
  if (!meta) throw new Error(`no checkpoint named ${id}`);
  const restored = [];
  const removed = [];
  const skipped = [];
  for (const file of meta.files ?? []) {
    if (!inside(root, file.abs)) {
      skipped.push(file.path);
      continue;
    }
    if (file.before === null) {
      try { fs.rmSync(file.abs, { force: true }); removed.push(file.path); } catch { skipped.push(file.path); }
      continue;
    }
    const data = fs.readFileSync(path.join(dir, file.before));
    // The mode of the file that is there now: a restore that drops the exec
    // bit of a script is a restore that broke the project.
    let mode = null;
    try { mode = fs.statSync(file.abs).mode & 0o777; } catch { /* the file is gone; a new one gets the default */ }
    fs.mkdirSync(path.dirname(file.abs), { recursive: true });
    writeFileAtomic(file.abs, data, { mode });
    restored.push(file.path);
  }
  return { id: meta.id, restored, removed, skipped };
}

/** Forget one checkpoint. */
export function remove({ root, id }) {
  const dir = checkpointDir(root, id);
  fs.rmSync(dir, { recursive: true, force: true });
  return { id, removed: true };
}

/** Keep the newest KEEP checkpoints; the oldest go. */
function prune(root) {
  const dir = projectDir(root);
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return; }
  if (names.length <= KEEP) return;
  names.sort();
  for (const name of names.slice(0, names.length - KEEP)) {
    try { fs.rmSync(path.join(dir, name), { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

export default { take, list, restore, remove, projectKey, storeRoot, KEEP };
