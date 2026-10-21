// memory-store.mjs — cross-session memory for a project.
//
// The memory tier (compact.mjs) carries facts across rotations *within* a
// session. This module carries them across *sessions*: a small JSON file per
// project under ~/.aipass/memory/<project-hash>.json holds the durable facts,
// and a new session loads them into its first turn. Dedup and cap match the
// within-session tier (case/space-insensitive dedup, 200 chars/fact, 50 facts).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { aipassHome } from './settings.mjs';
import { writeFileAtomic } from './atomic-write.mjs';

// The store's directory is resolved when it is used, not when this module
// loads. AIPASS_HOME is the switch every surface reads, and a caller that
// points it at a scratch home after the import — the test suite does — must
// still land there: a path frozen at load time wrote into the developer's
// real ~/.aipass/memory instead (one file per temp root, every run).
const defaultDir = () => path.join(aipassHome(), 'memory');
const CAP = 50;
const FACT_CAP = 200;

function norm(f) { return String(f).toLowerCase().replace(/\s+/g, ' ').trim(); }

function mergeFacts(prev, fresh) {
  const out = [];
  const seen = new Set();
  for (const f of [...(prev || []), ...(fresh || [])]) {
    const s = String(f).trim().slice(0, FACT_CAP);
    if (!s) continue;
    const key = norm(s);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  while (out.length > CAP) out.shift();
  return out;
}

function projectHash(root) { return crypto.createHash('sha1').update(path.resolve(root)).digest('hex').slice(0, 12); }

/**
 * Where a project's facts live.
 *
 * The folder and the file hold what the model learned about the project and
 * what the user told it — user data, not scratch. They are owner-only where
 * the OS has modes, like the session store and the credentials file: the
 * mode is set on creation and pinned again afterwards, because a directory
 * that was already there keeps the permissions it had.
 */
function storePath(root, dir = defaultDir()) {
  try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch {}
  // The mode is set on creation and pinned again afterwards: a directory
  // that was already there keeps the permissions it had. Windows has no
  // POSIX modes, so the chmod is best effort there.
  try { fs.chmodSync(dir, 0o700); } catch { /* windows has no POSIX modes */ }
  return path.join(dir, projectHash(root) + '.json');
}

export function loadMemory(root, dir = defaultDir()) {
  try {
    const raw = fs.readFileSync(storePath(root, dir), 'utf8');
    const data = JSON.parse(raw);
    const arr = Array.isArray(data) ? data : (data && Array.isArray(data.facts) ? data.facts : []);
    return arr.map((f) => String(f).trim().slice(0, FACT_CAP)).filter(Boolean).slice(0, CAP);
  } catch {}
  return [];
}

export function saveMemory(root, facts, dir = defaultDir()) {
  const merged = mergeFacts(loadMemory(root, dir), facts).slice(0, CAP);
  // Temp file plus rename: a crash mid-save leaves the previous facts. The
  // direct overwrite this replaces could empty the file, and loadMemory reads
  // a broken file as "no facts" — the loss would look like a fresh project.
  // The mode is pinned on the new file, so the facts are the owner's alone.
  try { writeFileAtomic(storePath(root, dir), JSON.stringify(merged, null, 2) + '\n', { mode: 0o600 }); } catch {}
  return merged;
}

export function clearMemory(root, dir = defaultDir()) {
  try { fs.rmSync(storePath(root, dir), { force: true }); } catch {}
}

/**
 * Re-key a project's facts after its folder moved: the file name is a hash of
 * the path, so a copied home on a machine whose paths differ loads "no facts"
 * for the project it used to know. Merged into whatever the destination
 * already holds (dedup included), the old file removed afterwards. Returns
 * the number of facts re-keyed.
 */
export function moveMemory(fromRoot, toRoot, dir = defaultDir()) {
  const facts = loadMemory(fromRoot, dir);
  if (!facts.length) return 0;
  saveMemory(toRoot, facts, dir);
  clearMemory(fromRoot, dir);
  return facts.length;
}

export function memoryPath(root) { return storePath(root); }
