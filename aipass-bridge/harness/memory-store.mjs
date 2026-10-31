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
import { projectKey } from './project-key.mjs';
import { writeFileAtomic } from './atomic-write.mjs';
// The store the sessions live in, read through its own public API: the
// header's `root` is the authority on which project a session belongs to,
// and the store is what knows that.
import { SessionStore } from './session.mjs';
import { tokenize, queryWords, excerptOf } from './text.mjs';
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
function legacyStorePath(root, dir = defaultDir()) { return path.join(dir, projectHash(root) + '.json'); }

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
  return path.join(dir, projectKey(root) + '.json');
}

export function loadMemory(root, dir = defaultDir()) {
  const newFile = storePath(root, dir);
  const legacyFile = legacyStorePath(root, dir);
  const read = (file) => {
    const raw = fs.readFileSync(file, 'utf8');
    const data = JSON.parse(raw);
    const arr = Array.isArray(data) ? data : (data && Array.isArray(data.facts) ? data.facts : []);
    return arr.map((f) => String(f).trim().slice(0, FACT_CAP)).filter(Boolean).slice(0, CAP);
  };
  if (fs.existsSync(newFile)) {
    try { return read(newFile); } catch {
      // Fall back to the legacy store if the new one is corrupt.
      try { return read(legacyFile); } catch { return []; }
    }
  }
  try { return read(legacyFile); } catch { return []; }
}

export function saveMemory(root, facts, dir = defaultDir()) {
  const merged = mergeFacts(loadMemory(root, dir), facts).slice(0, CAP);
  const next = JSON.stringify(merged, null, 2) + '\n';
  const file = storePath(root, dir);
  // A compaction re-emits facts the store already holds, so most saves are
  // no-ops — the merged list is byte-identical to what is on disk. Skipping
  // the rewrite costs one read and saves the atomic write (temp file, rename,
  // fsync) that would otherwise run on every rotation for nothing.
  try { if (fs.readFileSync(file, 'utf8') === next) return merged; } catch { /* a file that cannot be read is written */ }
  // Temp file plus rename: a crash mid-save leaves the previous facts. The
  // direct overwrite this replaces could empty the file, and loadMemory reads
  // a broken file as "no facts" — the loss would look like a fresh project.
  // The mode is pinned on the new file, so the facts are the owner's alone.
  try { writeFileAtomic(file, next, { mode: 0o600 }); } catch {}
  return merged;
}

export function clearMemory(root, dir = defaultDir()) {
  try { fs.rmSync(storePath(root, dir), { force: true }); } catch {}
  try { fs.rmSync(legacyStorePath(root, dir), { force: true }); } catch {}
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

/* ------------------------------------------------------------------ carry
 *
 * What a new session's first message takes from the store. The store caps at
 * 50 facts of 200 characters — 10,000 characters, roughly 2,500 tokens — and
 * injecting ALL of it into every new session paid for facts the task never
 * touched. The carry picks: the facts about this task first, then the newest
 * of the rest, under a byte budget. Nothing is deleted from the store; a fact
 * left out of one first message is still there for the next task, and the
 * recall tool still reaches everything.
 */

/** The carry block's default budget, in characters (~600 tokens at 4 chars/token). */
export const CARRY_BUDGET_CHARS = 2400;

/**
 * The budget, as the environment names it — the tuning channel a terminal run
 * has (the same channel `AIPASS_CONTEXT_TOKENS` and friends use, for the same
 * reason: the CLI builds no settings object).
 */
function carryBudget() {
  const n = Number(process.env.AIPASS_MEMORY_BUDGET);
  return Number.isFinite(n) && n > 0 ? n : CARRY_BUDGET_CHARS;
}

/**
 * The facts this task's first message carries, picked under a byte budget.
 *
 * A fact the task names wins a seat over a newer fact it does not: the whole
 * point of the carry is that the model does not rediscover what the project
 * already knows, and a fact about the task at hand is the one it would have
 * spent turns rediscovering. The rest fill what is left, newest first — the
 * newest are what a live project is building on (the store itself drops the
 * oldest on overflow). Whatever is picked renders in the stored order,
 * oldest first, so the block reads as one continuous record — and the same
 * facts and task always render byte-identically.
 *
 * @param {string[]} facts the stored facts, oldest first
 * @param {string} task the task the first message is about
 * @param {{budgetChars?: number}} [opts]
 * @returns {string[]} the carried facts, oldest first
 */
export function carryFacts(facts, task, { budgetChars = carryBudget() } = {}) {
  const list = (Array.isArray(facts) ? facts : []).map((f) => String(f).trim()).filter(Boolean);
  if (!list.length || !(budgetChars > 0)) return [];
  const words = queryWords(task);
  const matched = [];
  const rest = [];
  for (let i = 0; i < list.length; i++) {
    const low = list[i].toLowerCase();
    (words.some((w) => low.includes(w)) ? matched : rest).push(i);
  }
  const picked = [];
  let used = 0;
  const take = (i) => {
    const cost = list[i].length + 2; // the "- " bullet
    if (used + cost > budgetChars) return;
    used += cost;
    picked.push(i);
  };
  for (const i of matched) take(i);
  for (let n = rest.length - 1; n >= 0; n--) take(rest[n]);
  return picked.sort((a, b) => a - b).map((i) => list[i]);
}

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
 * The parsed tails, keyed by file and valid while the file's stat is
 * unchanged. One recall walks up to 30 tails, and a run may recall several
 * times — without this, every call re-read and re-parsed files it parsed a
 * second ago. Sessions grow by appends (and a header rewrite), and both
 * change the stat, so the check is the invalidation: a file that grew is
 * re-read, a file that did not is answered from the cache. The array is
 * shared read-only — recallEntries never mutates it.
 */
const TAIL_CACHE = new Map();
const TAIL_CACHE_MAX = 64;

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
  let stat = null;
  try { stat = await fs.promises.stat(file); } catch { return []; }
  const hit = TAIL_CACHE.get(file);
  if (hit && hit.maxBytes === maxBytes && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) {
    return hit.entries;
  }
  let text = '';
  try {
    const handle = await fs.promises.open(file, 'r');
    try {
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
  if (TAIL_CACHE.size >= TAIL_CACHE_MAX) TAIL_CACHE.delete(TAIL_CACHE.keys().next().value);
  TAIL_CACHE.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, maxBytes, entries });
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
  const qTokens = [...new Set(tokenize(query))];
  if (!words.length) return { hits: [], matches: 0, sessions: 0, words };
  const theStore = store ?? storeFor(aipassHome());
  let sessions = [];
  try {
    sessions = theStore.list(root).slice(0, maxSessions);
  } catch {
    return { hits: [], matches: 0, sessions: 0, words };
  }
  // collect candidates
  const cands = [];
  for (const session of sessions) {
    const entries = await readEntries(session.file, maxBytes);
    for (const entry of entries) {
      if (!SPOKEN.has(String(entry.type ?? ''))) continue;
      const text = textOf(entry);
      if (!text) continue;
      cands.push({
        text,
        ts: Number(entry.ts ?? session.updated ?? 0) || 0,
        type: String(entry.type),
        session: String(session.id ?? ''),
        title: String(session.title ?? 'session'),
      });
    }
  }
  // memory facts as documents
  try {
    const facts = loadMemory(root);
    facts.forEach((f, i) => {
      cands.push({ text: f, ts: 0, type: 'fact', session: '', title: 'memory' });
    });
  } catch {}
  if (!cands.length) return { hits: [], matches: 0, sessions: sessions.length, words };
  // BM25 over tokenize(text)
  const tfArr = cands.map((c) => {
    const m = new Map();
    for (const t of tokenize(c.text)) m.set(t, (m.get(t) || 0) + 1);
    return m;
  });
  const N = cands.length;
  const df = new Map();
  for (const m of tfArr) for (const t of m.keys()) df.set(t, (df.get(t) || 0) + 1);
  // Trigrams are a matching aid, not text: weight them in the score via idf but
  // do not let them inflate the document length (matches the retrieval index).
  const lenOf = (m) => [...m.entries()].reduce((a, [t, f]) => a + (t.startsWith('t:') ? 0 : f), 0) || 1;
  const avgLen = tfArr.reduce((a, m) => a + lenOf(m), 0) / N;
  function idf(t) { const d = df.get(t) || 0; return Math.log(1 + (N - d + 0.5) / (d + 0.5)); }
  const scored = cands.map((c, i) => {
    const m = tfArr[i];
    const len = lenOf(m);
    let score = 0;
    for (const t of qTokens) {
      const f = m.get(t) || 0;
      if (!f) continue;
      const idfVal = idf(t);
      score += idfVal * (f * 2.2) / (f + 1.2 * (1 - 0.75 + 0.75 * len / (avgLen || 1)));
    }
    const hay = c.text.toLowerCase();
    const phrase = String(query ?? '').trim().toLowerCase();
    if (phrase.length >= 3 && hay.includes(phrase)) score += 0.5 * qTokens.reduce((a, t) => a + idf(t), 0);
    // recency boost for sessions (facts have ts 0)
    if (c.ts > 0) score *= 1 + 0.2 * Math.exp(-(Date.now() - c.ts) / (30 * 86400000));
    return { i, score };
  }).filter((x) => x.score > 0);
  const maxScore = scored.reduce((m, x) => Math.max(m, x.score), 0) || 1;
  scored.sort((a, b) => {
    if (Math.abs(a.score - b.score) > 0.25 * maxScore) return b.score - a.score;
    return (cands[b.i].ts || 0) - (cands[a.i].ts || 0) || b.score - a.score;
  });
  const found = scored.map(({ i, score }) => {
    const c = cands[i];
    return {
      score,
      ts: c.ts,
      type: c.type,
      session: c.session,
      title: c.title,
      excerpt: excerptOf(c.text, words),
    };
  });
  return { hits: found.slice(0, limit), matches: found.length, sessions: sessions.length, words };
}
