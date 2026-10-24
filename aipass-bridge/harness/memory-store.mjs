// memory-store.mjs — cross-session memory for a project, and the recall over
// what the project said before.
//
// The memory tier (compact.mjs) carries facts across rotations *within* a
// session. This module carries them across *sessions*: a small JSON file per
// project under ~/.aipass/memory/<project-hash>.json holds the durable facts,
// and a new session loads them into its first turn. Dedup and cap match the
// within-session tier (case/space-insensitive dedup, 200 chars/fact, 50 facts).
//
// The RECALL is the other half: the facts are what the machine carried, and
// the recall is what the PERSON asks for — "what did we say about this last
// week?". It reads the project's own session store (harness/session.mjs) and
// answers with the entries that are about the query: a plain word match,
// scored, with the newest first as the tiebreak, and a cap on how much comes
// back. No embedding, no network, no new dependency — the honest answer to
// "what was said" is a word match, and it says so.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { aipassHome } from './settings.mjs';
import { writeFileAtomic } from './atomic-write.mjs';
// The store the sessions live in, read through its own public API: the
// header's `root` is the authority on which project a session belongs to,
// and the store is what knows that.
import { SessionStore } from './session.mjs';

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
 * mode is set when the store creates the folder, and a folder that was
 * already there keeps the permissions it had.
 */
function storePath(root, dir = defaultDir()) {
  // The mode belongs to the folder, and it is set once: when the store
  // creates it. Re-pinning it on every call took the permissions away from
  // whoever set them - a read-only home, a folder another tool locked, and
  // the failure drill the suite runs (a read-only folder must make a save
  // fail) all lost their lock, because the chmod handed the write
  // permission back before the write.
  const existed = fs.existsSync(dir);
  try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch {}
  if (!existed) {
    // Windows has no POSIX modes, so the chmod is best effort there.
    try { fs.chmodSync(dir, 0o700); } catch { /* windows has no POSIX modes */ }
  }
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

/* ------------------------------------------------------------------- recall
 *
 * The past, on demand. A person who worked with the agent yesterday wants
 * what was said then, and the sessions hold it — but the sessions are files,
 * and a run that loaded every one of them to answer a question would cost
 * more than the question.
 */

/** The entry types that carry what was SAID. A tool result is not talk. */
const SPOKEN = new Set(['user', 'task', 'assistant', 'note', 'compaction']);

/** How many sessions one recall looks at. */
const MAX_SESSIONS = 30;

/** How many bytes of one session file a recall reads. */
const MAX_SESSION_BYTES = 128 * 1024;

/** How many entries one recall returns. */
const MAX_HITS = 8;

/** How long an excerpt may be. */
const EXCERPT_CAP = 280;

/**
 * The words of a query.
 *
 * A plain split — letters and digits, nothing shorter than two characters,
 * because a one-letter word matches half the store. Thai has no spaces
 * between its words, so a Thai phrase arrives here as one long word and is
 * matched as a phrase, which is what the person who typed it meant.
 *
 * @param {string} query
 * @returns {string[]}
 */
export function queryWords(query) {
  const out = [];
  for (const w of String(query ?? '').toLowerCase().split(/[^\p{L}\p{N}_]+/u)) {
    if (w.length < 2) continue;
    if (!out.includes(w)) out.push(w);
  }
  return out;
}

/**
 * The text an entry carries, or '' when it carries none.
 *
 * @param {Record<string, any>} entry
 * @returns {string}
 */
function textOf(entry) {
  if (!entry || typeof entry !== 'object') return '';
  if (entry.type === 'compaction') return String(entry.summary ?? '');
  return String(entry.text ?? '');
}

/**
 * How much an entry is about the query.
 *
 * One point for every word of the query the entry carries, and one more when
 * the whole phrase is in it. That is the whole of it: a word match, scored.
 *
 * @param {string} haystack the entry's text, lower-cased
 * @param {string[]} words
 * @param {string} phrase the whole query, lower-cased
 * @returns {number}
 */
function scoreOf(haystack, words, phrase) {
  let score = 0;
  for (const w of words) if (haystack.includes(w)) score += 1;
  if (score && phrase && haystack.includes(phrase)) score += 1;
  return score;
}

/**
 * The passage around the first match.
 *
 * The window is where the answer is, so the excerpt starts a little before
 * the match and stops a little after it — and says so with an ellipsis when
 * it does, so a reader never mistakes a fragment for the whole entry.
 *
 * @param {string} text
 * @param {string[]} words
 * @returns {string}
 */
export function excerptOf(text, words) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  const low = flat.toLowerCase();
  let at = -1;
  for (const w of words) {
    const i = low.indexOf(w);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  if (at < 0) return flat.slice(0, EXCERPT_CAP);
  const before = 80;
  const start = Math.max(0, at - before);
  const end = Math.min(flat.length, at + EXCERPT_CAP - before);
  return (start > 0 ? '… ' : '') + flat.slice(start, end).trim() + (end < flat.length ? ' …' : '');
}

/**
 * The entries of one session file, cheaply.
 *
 * A session file grows by appends and nothing trims it, so the recall does
 * not LOAD it: the tail is read (the newest entries, which is where the
 * answer usually is) and only that is parsed. A file small enough is read
 * whole — most sessions are.
 *
 * @param {string} file
 * @param {number} maxBytes
 * @returns {Promise<Array<Record<string, any>>>}
 */
async function readEntries(file, maxBytes) {
  let text = '';
  try {
    const handle = await fs.promises.open(file, 'r');
    try {
      const stat = await handle.stat();
      const start = Math.max(0, stat.size - maxBytes);
      const buffer = Buffer.alloc(stat.size - start);
      if (buffer.length) await handle.read(buffer, 0, buffer.length, start);
      text = buffer.toString('utf8');
      if (start > 0) {
        // The first line of a tail is cut in half — the part that is there is
        // not a line. Drop it rather than parse a fragment.
        const cut = text.indexOf('\n');
        text = cut >= 0 ? text.slice(cut + 1) : '';
      }
    } finally {
      await handle.close();
    }
  } catch {
    return [];
  }
  const entries = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry && typeof entry === 'object' && !Array.isArray(entry)) entries.push(entry);
    } catch { /* a torn line is skipped, not fatal */ }
  }
  return entries;
}

/**
 * The store the sessions live in, made once per home.
 *
 * A store is a handle on a directory, not a reading, and the recall asks for
 * it on every call: one per home keeps that from becoming a mkdir per
 * question.
 */
const STORES = new Map();
function storeFor(dir) {
  let store = STORES.get(dir);
  if (!store) {
    store = new SessionStore(path.join(dir, 'sessions'));
    STORES.set(dir, store);
  }
  return store;
}

/**
 * The past entries of this project that are about a query.
 *
 * The sessions of the project are walked newest first (the store's own
 * order), each one's tail is read, and every entry that carries talk is
 * scored against the query. The newest is the tiebreak: two entries about
 * the same thing, the later one is the one being asked about.
 *
 * @param {string} query what the person is asking about
 * @param {{root: string, store?: object|null, limit?: number, maxSessions?: number, maxBytes?: number}} opts
 * @returns {Promise<{hits: Array<object>, matches: number, sessions: number, words: string[]}>}
 */
export async function recallEntries(query, { root, store = null, limit = MAX_HITS, maxSessions = MAX_SESSIONS, maxBytes = MAX_SESSION_BYTES } = {}) {
  const words = queryWords(query);
  const phrase = String(query ?? '').trim().toLowerCase();
  if (!words.length) return { hits: [], matches: 0, sessions: 0, words };
  const theStore = store ?? storeFor(aipassHome());
  let sessions = [];
  try {
    sessions = theStore.list(root).slice(0, maxSessions);
  } catch {
    return { hits: [], matches: 0, sessions: 0, words };
  }
  const found = [];
  for (const session of sessions) {
    const entries = await readEntries(session.file, maxBytes);
    for (const entry of entries) {
      if (!SPOKEN.has(String(entry.type ?? ''))) continue;
      const text = textOf(entry);
      if (!text) continue;
      const score = scoreOf(text.toLowerCase(), words, phrase);
      if (!score) continue;
      found.push({
        score,
        ts: Number(entry.ts ?? session.updated ?? 0) || 0,
        type: String(entry.type),
        session: String(session.id ?? ''),
        title: String(session.title ?? 'session'),
        excerpt: excerptOf(text, words),
      });
    }
  }
  found.sort((a, b) => b.score - a.score || b.ts - a.ts);
  return { hits: found.slice(0, limit), matches: found.length, sessions: sessions.length, words };
}
