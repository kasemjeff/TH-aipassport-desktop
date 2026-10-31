// retrieval.mjs — ranked retrieval over a project's own text.
import fs from 'node:fs';
import path from 'node:path';
import { aipassHome } from './settings.mjs';
import { writeFileAtomic } from './atomic-write.mjs';
import { secretHit } from './permissions.mjs';
import { loadGitignore } from './gitignore.mjs';
import { SKIP, posix, realPath, isNoisePath } from './overlay.mjs';
import { extractSymbols } from './symbols.mjs';
import { tokenize, excerptOf } from './text.mjs';
import { projectKey } from './project-key.mjs';
export { tokenize } from './text.mjs';

export const RETRIEVAL_VERSION = 2;
export const DEFAULT_MAX_FILES = 5000;
export const DEFAULT_MAX_CHUNKS = 20000;
export const DEFAULT_MAX_FILE_BYTES = 512 * 1024;
export const DEFAULT_BUDGET_CHARS = 6000;
export const DEFAULT_MAX_HITS = 6;
export const DEFAULT_INDEX_TTL_MS = 5000;
export const TRIGRAM_WEIGHT = 0.25;
export const EXCERPT_CAPS = [3000, 1800, 1000, 800, 600, 600];

const CODE_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.rs', '.go', '.java', '.c', '.h', '.cc', '.cpp', '.hpp', '.cs', '.rb', '.php', '.sh', '.ps1', '.css', '.scss', '.sql', '.lua', '.swift', '.kt', '.vue', '.svelte']);
const MD_EXT = new Set(['.md', '.mdx']);
const DATA_EXT = new Set(['.json', '.yaml', '.yml', '.toml', '.csv', '.html', '.htm', '.txt']);
const GENERATED = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb|composer\.lock|Cargo\.lock|poetry\.lock|Pipfile\.lock|Gemfile\.lock|.*\.min\.(js|css)|.*\.map)$/i;

function envInt(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function indexDir() {
  const dir = path.join(aipassHome(), 'retrieval');
  try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch {}
  try { fs.chmodSync(dir, 0o700); } catch {}
  return dir;
}
function indexPath(root) { return path.join(indexDir(), projectKey(root) + '.json'); }
async function realpathSafe(p) { try { return await fs.promises.realpath(p); } catch { return path.resolve(p); } }

export function loadIndex(root) {
  const file = indexPath(root);
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  const hit = INDEX_CACHE.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
    // LRU touch
    INDEX_CACHE.delete(file);
    INDEX_CACHE.set(file, hit);
    return hit.data;
  }
  let data = null;
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && parsed.version === RETRIEVAL_VERSION && Array.isArray(parsed.chunks) && parsed.postings && typeof parsed.root === 'string') {
      const real = realPath(root) ?? path.resolve(root);
      if (parsed.root === real) data = parsed;
    }
  } catch {}
  if (data) {
    if (INDEX_CACHE.size >= INDEX_CACHE_MAX) {
      const first = INDEX_CACHE.keys().next().value;
      INDEX_CACHE.delete(first);
    }
    INDEX_CACHE.set(file, { mtimeMs: st.mtimeMs, size: st.size, data });
  } else {
    INDEX_CACHE.delete(file);
  }
  return data;
}
export function saveIndex(root, idx) {
  const file = indexPath(root);
  try { fs.mkdirSync(indexDir(), { recursive: true, mode: 0o700 }); } catch {}
  try { fs.chmodSync(indexDir(), 0o700); } catch {}
  let saved = false;
  try { writeFileAtomic(file, JSON.stringify(idx), { mode: 0o600 }); saved = true; } catch { saved = false; }
  if (saved) {
    try {
      const st = fs.statSync(file);
      if (INDEX_CACHE.size >= INDEX_CACHE_MAX) {
        const first = INDEX_CACHE.keys().next().value;
        INDEX_CACHE.delete(first);
      }
      INDEX_CACHE.set(file, { mtimeMs: st.mtimeMs, size: st.size, data: idx });
    } catch { saved = false; }
  }
  return saved;
}
export function clearIndex(root) {
  const file = indexPath(root);
  // BUILDING is keyed by the real root, not the project key: a clear must
  // cancel the build that is about to write this file, or the build saves it
  // again after the delete.
  const realRoot = realPath(root) ?? path.resolve(root);
  const job = BUILDING.get(realRoot);
  if (job) {
    if (BUILDING.get(realRoot) === job) BUILDING.delete(realRoot);
    try { job.controller.abort(); } catch {}
  }
  INDEX_CACHE.delete(file);
  try { fs.rmSync(file, { force: true }); } catch {}
}
export function status(root) {
  const idx = loadIndex(root);
  if (!idx) return { files: 0, chunks: 0, bytes: 0, builtAt: 0, truncated: false, root: realPath(root) ?? path.resolve(root) };
  let bytes = 0;
  try { bytes = fs.statSync(indexPath(root)).size; } catch {}
  return { files: Object.keys(idx.files || {}).length, chunks: (idx.chunks || []).length, bytes, builtAt: idx.builtAt, truncated: !!idx.truncated, root: idx.root };
}

const INDEX_CACHE_MAX = 4;
const INDEX_CACHE = new Map();

function makeChunk(rel, lines, start, end, kind, symbol, heading) {
  const text = lines.slice(start, end).join('\n').replace(/\s+$/g, '');
  if (!text.trim()) return null;
  return { path: rel, start: start + 1, end: end, kind, symbol: symbol || null, heading: heading || null, text };
}
function chunkLines(rel, text, size, overlap, kind) {
  const lines = text.split('\n');
  const chunks = [];
  if (lines.length <= size) {
    const c = makeChunk(rel, lines, 0, lines.length, kind, null, null);
    if (c) chunks.push(c);
    return chunks;
  }
  for (let i = 0; i < lines.length; i += Math.max(1, size - overlap)) {
    const end = Math.min(lines.length, i + size);
    const c = makeChunk(rel, lines, i, end, kind, null, null);
    if (c) chunks.push(c);
    if (end === lines.length) break;
  }
  return chunks;
}
function chunkCode(rel, text) {
  const lines = text.split('\n');
  const syms = extractSymbols(text, rel).slice().sort((a, b) => a.line - b.line);
  const chunks = [];
  if (!syms.length) return chunkLines(rel, text, 80, 15, 'code');
  const first = syms[0].line - 1;
  if (first > 0) {
    for (const c of chunkLines(rel, lines.slice(0, first).join('\n'), 80, 15, 'code')) chunks.push(c);
  }
  for (let i = 0; i < syms.length; i++) {
    const s = syms[i];
    const symStart = s.line - 1;
    const nextStart = i + 1 < syms.length ? syms[i + 1].line - 1 : lines.length;
    const end = Math.max(symStart + 1, nextStart);
    const sliceText = lines.slice(symStart, end).join('\n');
    const sub = chunkLines(rel, sliceText, 80, 15, 'code');
    for (const c of sub) {
      c.start += symStart;
      c.end += symStart;
      c.symbol = s.name;
      chunks.push(c);
    }
  }
  return chunks.filter((c) => c && c.text.trim());
}
function chunkMarkdown(rel, text) {
  const lines = text.split('\n');
  const sections = [];
  let cur = { heading: null, start: 0, lines: [] };
  for (let i = 0; i < lines.length; i++) {
    if (/^#{1,3}\s/.test(lines[i])) {
      if (cur.lines.length) sections.push(cur);
      cur = { heading: lines[i].replace(/^#+\s*/, '').trim(), start: i, lines: [lines[i]] };
    } else {
      cur.lines.push(lines[i]);
    }
  }
  if (cur.lines.length) sections.push(cur);
  if (sections.length === 0) sections.push({ heading: null, start: 0, lines: lines.slice() });
  const chunks = [];
  for (const sec of sections) {
    const secText = sec.lines.join('\n');
    if (secText.trim().length === 0) continue;
    if (secText.length <= 1200) {
      const c = makeChunk(rel, sec.lines, 0, sec.lines.length, 'markdown', null, sec.heading);
      if (c) { c.start += sec.start; c.end += sec.start; chunks.push(c); }
    } else {
      const sub = chunkLines(rel, secText, 40, 8, 'markdown');
      for (const c of sub) { c.start += sec.start; c.end += sec.start; c.heading = sec.heading; chunks.push(c); }
    }
  }
  return chunks.length ? chunks : chunkLines(rel, text, 60, 10, 'markdown');
}
export function chunkFile(rel, text) {
  const ext = path.extname(rel).toLowerCase();
  if (MD_EXT.has(ext)) return chunkMarkdown(rel, text);
  if (CODE_EXT.has(ext)) return chunkCode(rel, text);
  return chunkLines(rel, text, 60, 10, 'text');
}

function rankExt(rel) {
  const ext = path.extname(rel).toLowerCase();
  if (CODE_EXT.has(ext)) return 0;
  if (MD_EXT.has(ext)) return 1;
  if (DATA_EXT.has(ext)) return 2;
  return 3;
}

async function walk(root, dir, ign, out, signal, cap, realRoot) {
  if (out.length >= cap) return;
  let entries;
  try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    if (out.length >= cap) return;
    if (signal?.aborted) return;
    if (SKIP.has(e.name)) continue;
    const full = path.join(dir, e.name);
    const rel = posix(path.relative(root, full));
    if (isNoisePath(rel)) continue;
    if (e.isDirectory()) {
      if (e.name.startsWith('.')) continue;
      if (ign.ignored(rel, true)) continue;
      await walk(root, full, ign, out, signal, cap, realRoot);
      continue;
    }
    if (!e.isFile() && !e.isSymbolicLink()) continue;
    if (e.name.startsWith('.')) continue;
    if (ign.ignored(rel, false)) continue;
    if (secretHit(rel)) continue;
    if (GENERATED.test(rel)) continue;
    if (e.isSymbolicLink()) {
      let target;
      try { target = await fs.promises.realpath(full); } catch { continue; }
      if (target !== realRoot && !target.startsWith(realRoot + path.sep)) continue;
      if (secretHit(target)) continue;
    }
    out.push(rel);
  }
}

export async function buildIndex(root, opts = {}) {
  const signal = opts.signal ?? null;
  const maxFiles = opts.maxFiles ?? envInt('AIPASS_RETRIEVAL_MAX_FILES', DEFAULT_MAX_FILES);
  const maxChunks = opts.maxChunks ?? envInt('AIPASS_RETRIEVAL_MAX_CHUNKS', DEFAULT_MAX_CHUNKS);
  const maxFileBytes = opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const realRoot = realPath(root) ?? path.resolve(root);
  const ign = loadGitignore(root);
  const walkCap = Math.min(maxFiles * 4, 20000);
  const collected = [];
  await walk(root, root, ign, collected, signal, walkCap, realRoot);
  if (signal?.aborted) throw new Error('index build aborted');
  collected.sort((a, b) => rankExt(a) - rankExt(b) || a.localeCompare(b));
  let fileCapHit = collected.length >= walkCap;
  const files = collected.length > maxFiles ? collected.slice(0, maxFiles) : collected;
  if (collected.length > maxFiles) fileCapHit = true;

  const old = loadIndex(root);
  const canReuse = !!(old && old.version === RETRIEVAL_VERSION && old.root === realRoot);

  const idx = { version: RETRIEVAL_VERSION, root: realRoot, builtAt: 0, files: {}, chunks: [], postings: {}, lengths: [], avgLen: 0, truncated: false };
  const termMap = new Map();
  const keepMap = new Map(); // old chunk id -> new chunk id (reused)
  let chunksSoFar = 0;
  let readCount = 0;
  let reusedCount = 0;
  let aborted = false;

  const pushChunk = (chunk, tf, len) => {
    if (chunksSoFar >= maxChunks) { idx.truncated = true; return -1; }
    const id = idx.chunks.length;
    idx.chunks.push(chunk);
    idx.lengths.push(len);
    chunksSoFar++;
    for (const [t, f] of tf) {
      if (!termMap.has(t)) termMap.set(t, new Map());
      termMap.get(t).set(id, f);
    }
    return id;
  };

  const addFileTokens = (rel, text, chunks) => {
    const pathTokens = tokenize(rel);
    const pathTf = new Map();
    for (const t of pathTokens) pathTf.set(t, (pathTf.get(t) || 0) + 2);
    const ids = [];
    for (const c of chunks) {
      if (chunksSoFar >= maxChunks) { idx.truncated = true; break; }
      const tf = new Map();
      for (const t of tokenize(c.text)) tf.set(t, (tf.get(t) || 0) + 1);
      for (const [t, f] of pathTf) tf.set(t, (tf.get(t) || 0) + f);
      if (c.symbol) for (const t of tokenize(c.symbol)) tf.set(t, (tf.get(t) || 0) + 2);
      if (c.heading) for (const t of tokenize(c.heading)) tf.set(t, (tf.get(t) || 0) + 2);
      let len = 0;
      for (const [t, f] of tf) if (!t.startsWith('t:')) len += f;
      if (len === 0) len = 1;
      const id = pushChunk(c, tf, len);
      if (id === -1) break;
      ids.push(id);
    }
    return ids;
  };

  for (const rel of files) {
    if (signal?.aborted) { aborted = true; break; }
    if (chunksSoFar >= maxChunks) { idx.truncated = true; break; }
    if (secretHit(rel)) continue;
    const full = path.join(root, rel);
    let st;
    try { st = await fs.promises.stat(full); } catch { continue; }
    if (st.size > maxFileBytes) continue;

    const prevFile = canReuse ? (old.files || {})[rel] : null;
    const prevChunksValid = !!(prevFile && prevFile.mtime === st.mtimeMs && prevFile.size === st.size &&
      Array.isArray(prevFile.chunks) && prevFile.chunks.every((id) => old.chunks[id] && Number.isFinite(old.lengths[id])));
    if (prevChunksValid) {
      const ids = [];
      for (const oldId of prevFile.chunks) {
        if (chunksSoFar >= maxChunks) { idx.truncated = true; break; }
        const newId = idx.chunks.length;
        idx.chunks.push({ ...old.chunks[oldId] });
        idx.lengths.push(old.lengths[oldId]);
        chunksSoFar++;
        keepMap.set(oldId, newId);
        ids.push(newId);
      }
      idx.files[rel] = { mtime: st.mtimeMs, size: st.size, chunks: ids };
      reusedCount++;
      continue;
    }

    // read + chunk + tokenize
    let text;
    try { text = await fs.promises.readFile(full, 'utf8'); } catch { continue; }
    readCount++;
    if (text.includes('\u0000')) continue;
    const chunks = chunkFile(rel, text);
    const ids = addFileTokens(rel, text, chunks);
    idx.files[rel] = { mtime: st.mtimeMs, size: st.size, chunks: ids };
    await new Promise((r) => setImmediate(r));
  }

  if (aborted || signal?.aborted) {
    throw new Error('index build aborted');
  }

  // copy postings for reused chunks
  if (canReuse && old.postings) {
    for (const [t, arr] of Object.entries(old.postings)) {
      let target = termMap.get(t);
      for (let i = 0; i < arr.length; i += 2) {
        const oldId = arr[i], f = arr[i + 1];
        const newId = keepMap.get(oldId);
        if (newId === undefined) continue;
        if (!target) { target = new Map(); termMap.set(t, target); }
        target.set(newId, f);
      }
    }
  }

  if (fileCapHit) idx.truncated = true;

  // postings
  for (const [t, m] of termMap) {
    const arr = [];
    for (const [id, f] of m) { arr.push(id, f); }
    idx.postings[t] = arr;
  }
  const n = idx.lengths.length;
  idx.avgLen = n ? idx.lengths.reduce((a, b) => a + b, 0) / n : 0;
  idx.chunkCount = n;

  if (signal?.aborted) throw new Error('index build aborted');
  idx.builtAt = Date.now();
  const saved = saveIndex(root, idx);
  idx.saved = saved;
  return { index: idx, stats: { files: Object.keys(idx.files).length, chunks: n, truncated: idx.truncated, read: readCount, reused: reusedCount, saved } };
}

const BUILDING = new Map();
export async function ensureIndex(root, opts = {}) {
  const signal = opts.signal ?? null;
  if (signal?.aborted) throw new Error('index build aborted');
  const realRoot = realPath(root) ?? path.resolve(root);
  const idx = loadIndex(root);
  const now = Date.now();
  // Short enough that a disk edit is visible without a restart, long enough
  // that a burst of questions does not walk the tree for each one. Staged
  // edits bypass this: buildView folds them in on every query.
  const maxAgeMs = Number.isFinite(opts.maxAgeMs) ? Math.max(0, opts.maxAgeMs) : DEFAULT_INDEX_TTL_MS;
  if (idx && !opts.force && now - (idx.builtAt || 0) < maxAgeMs) return idx;

  let job = BUILDING.get(realRoot);
  if (!job) {
    const controller = new AbortController();
    const promise = buildIndex(root, { ...opts, signal: controller.signal }).then((r) => r.index);
    job = { promise, controller, waiters: 0 };
    BUILDING.set(realRoot, job);
    promise.then(
      () => { if (BUILDING.get(realRoot) === job) BUILDING.delete(realRoot); },
      () => { if (BUILDING.get(realRoot) === job) BUILDING.delete(realRoot); }
    );
  }
  job.waiters++;
  try {
    if (!signal) return await job.promise;
    return await new Promise((resolve, reject) => {
      const onAbort = () => reject(new Error('index build aborted'));
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener('abort', onAbort, { once: true });
      job.promise.then(
        (v) => { signal.removeEventListener('abort', onAbort); resolve(v); },
        (e) => { signal.removeEventListener('abort', onAbort); reject(e); }
      );
    });
  } finally {
    job.waiters--;
    if (job.waiters === 0) {
      if (BUILDING.get(realRoot) === job) BUILDING.delete(realRoot);
      try { job.controller.abort(); } catch {}
    }
  }
}

const STATS = new WeakMap();
function baseStats(idx) {
  let s = STATS.get(idx);
  if (s) return s;
  const df = new Map();
  for (const [term, arr] of Object.entries(idx.postings || {})) df.set(term, arr.length / 2);
  const lengths = (idx.lengths && idx.lengths.length === (idx.chunks || []).length)
    ? idx.lengths : (idx.chunks || []).map(() => 1);
  let total = 0;
  for (const l of lengths) total += (l || 0);
  s = { df, N: (idx.chunks || []).length, lengths, total, avgLen: (idx.avgLen && idx.avgLen > 0) ? idx.avgLen : ((idx.chunks || []).length ? total / (idx.chunks || []).length : 0) };
  STATS.set(idx, s);
  return s;
}

const BODY_TOKENS = new WeakMap();
function bodyTokens(chunk) {
  let s = BODY_TOKENS.get(chunk);
  if (!s) { s = new Set(tokenize(chunk.text)); BODY_TOKENS.set(chunk, s); }
  return s;
}

function buildView(idx, root, overlay) {
  const base = baseStats(idx);
  const removed = new Set();
  const staged = [];
  let removedLen = 0;
  if (overlay && typeof overlay.entries === 'function') {
    const realRoot = realPath(root) ?? path.resolve(root);
    const stagedMap = new Map();
    const deleted = new Set();
    for (const [abs, text] of overlay.entries()) {
      const absReal = realPath(String(abs)) ?? path.resolve(String(abs));
      if (absReal !== realRoot && !absReal.startsWith(realRoot + path.sep)) continue;
      const rel = posix(path.relative(realRoot, absReal));
      if (text === '\u0000DELETE\u0000') { deleted.add(rel); continue; }
      if (typeof text !== 'string' || text.includes('\u0000')) continue;
      // The disk walk never indexes a dotfile, a secret name, or a generated
      // file; an overlay edit must not become a side door around that rule.
      if (secretHit(rel) || GENERATED.test(rel) || rel.split('/').some((seg) => seg.startsWith('.'))) continue;
      stagedMap.set(rel, text);
    }
    // removed chunks from deleted + staged paths
    for (const rel of new Set([...deleted, ...stagedMap.keys()])) {
      const cf = (idx.files || {})[rel];
      if (cf && Array.isArray(cf.chunks)) for (const id of cf.chunks) { removed.add(id); removedLen += base.lengths[id] || 0; }
    }
    for (const [rel, text] of stagedMap) {
      const cs = chunkFile(rel, text);
      for (const c of cs) {
        const tf = new Map();
        for (const t of tokenize(c.text)) tf.set(t, (tf.get(t) || 0) + 1);
        const pathTokens = tokenize(rel);
        for (const t of pathTokens) tf.set(t, (tf.get(t) || 0) + 2);
        if (c.symbol) for (const t of tokenize(c.symbol)) tf.set(t, (tf.get(t) || 0) + 2);
        if (c.heading) for (const t of tokenize(c.heading)) tf.set(t, (tf.get(t) || 0) + 2);
        let len = 0;
        for (const [t, f] of tf) if (!t.startsWith('t:')) len += f;
        if (len === 0) len = 1;
        staged.push({ chunk: c, tf, len });
      }
    }
  }

  const baseN = base.N;
  const stagedCount = staged.length;
  const removedCount = removed.size;
  const N = baseN - removedCount + stagedCount;
  let total = base.total - removedLen;
  for (const s of staged) total += s.len;
  const avgLen = N ? total / N : 0;

  const dfOf = (t) => {
    let d = base.df.get(t) || 0;
    // A removed chunk is a posting entry, so count it there rather than
    // walking the removed set for every term.
    const arr = (idx.postings || {})[t];
    if (arr) {
      let rc = 0;
      for (let i = 0; i < arr.length; i += 2) if (removed.has(arr[i])) rc++;
      d -= rc;
    }
    for (const s of staged) if (s.tf.has(t)) d++;
    if (d < 0) d = 0;
    return d;
  };

  const idfCache = new Map();
  const idfOf = (t) => {
    if (idfCache.has(t)) return idfCache.get(t);
    const d = dfOf(t);
    const v = Math.log(1 + (N - d + 0.5) / (d + 0.5));
    idfCache.set(t, v);
    return v;
  };

  const chunkAt = (id) => {
    if (id < baseN) return (idx.chunks || [])[id];
    return staged[id - baseN].chunk;
  };
  const lenAt = (id) => {
    if (id < baseN) return base.lengths[id] || 1;
    return staged[id - baseN].len;
  };
  const postings = idx.postings || {};
  const hasRemoved = removed.size > 0;

  return {
    idx, base, baseN, N, avgLen, total, removed, staged, hasRemoved,
    dfOf, idfOf, chunkAt, lenAt, postings, removedCount, stagedCount,
  };
}

export async function retrieve(query, opts = {}) {
  const root = opts.root;
  const overlay = opts.overlay ?? null;
  const limit = opts.limit ?? DEFAULT_MAX_HITS;
  const budgetChars = opts.budgetChars ?? envInt('AIPASS_RETRIEVAL_BUDGET', DEFAULT_BUDGET_CHARS);
  const signal = opts.signal ?? null;
  const qTokensAll = [...new Set(tokenize(query))];
  if (!qTokensAll.length) return { hits: [], stats: status(root), words: [] };
  if (signal?.aborted) throw new Error('retrieve aborted');
  let idx;
  try { idx = await ensureIndex(root, { signal, force: opts.force, maxAgeMs: opts.maxAgeMs }); } catch (err) { throw err; }
  if (!idx) return { hits: [], stats: status(root), words: qTokensAll };
  if (signal?.aborted) throw new Error('retrieve aborted');

  const view = buildView(idx, root, overlay);
  const chunks = view; // not an array; use chunkAt
  const N = view.N;
  if (!N) return { hits: [], stats: { files: Object.keys(idx.files || {}).length, chunks: 0, builtAt: idx.builtAt, truncated: !!idx.truncated, matches: 0, saved: idx.saved !== false }, words: qTokensAll };

  const primary = qTokensAll.filter((t) => !t.startsWith('t:'));
  const trigrams = qTokensAll.filter((t) => t.startsWith('t:'));
  const scoreTokens = primary.length ? primary : trigrams;

  const scores = new Map();
  const k1 = 1.2;
  const avg = view.avgLen || 1;
  const weightFor = (t) => (t.startsWith('t:') ? TRIGRAM_WEIGHT : 1);
  const addToken = (t, wMul) => {
    const idfVal = view.idfOf(t);
    const arr = view.postings[t];
    if (arr) {
      for (let i = 0; i < arr.length; i += 2) {
        const id = arr[i], f = arr[i + 1];
        if (view.removed.has(id)) continue;
        const len = view.lenAt(id);
        const add = wMul * weightFor(t) * idfVal * (f * 2.2) / (f + 1.2 * (1 - 0.75 + 0.75 * len / avg));
        scores.set(id, (scores.get(id) || 0) + add);
      }
    }
    for (let j = 0; j < view.staged.length; j++) {
      const s = view.staged[j];
      const f = s.tf.get(t) || 0;
      if (!f) continue;
      const id = view.baseN + j;
      const len = s.len;
      const add = wMul * weightFor(t) * idfVal * (f * 2.2) / (f + 1.2 * (1 - 0.75 + 0.75 * len / avg));
      scores.set(id, (scores.get(id) || 0) + add);
    }
  };

  for (const t of scoreTokens) addToken(t, 1);

  // trigram supplement when primary present. The weight is applied once here
  // via weightFor(t), so do not multiply by TRIGRAM_WEIGHT again (that would
  // square it to 0.0625).
  if (primary.length && trigrams.length) {
    for (const t of trigrams) addToken(t, 1);
  }

  if (signal?.aborted) throw new Error('retrieve aborted');

  // phrase bonus (non-trigram tokens only)
  const phrase = String(query).trim().toLowerCase();
  if (phrase.length >= 3 && scores.size) {
    const bonusTokens = primary.length ? primary : qTokensAll;
    const bonus = 0.5 * bonusTokens.reduce((a, t) => a + view.idfOf(t), 0);
    for (const id of scores.keys()) {
      const c = view.chunkAt(id);
      if (String(c.text).toLowerCase().includes(phrase)) scores.set(id, scores.get(id) + bonus);
    }
  }

  const scored = [...scores.entries()].map(([id, score]) => ({ id, score })).sort((a, b) => b.score - a.score);
  const chosen = [];
  const chosenSets = [];
  const chosenFiles = new Map();
  const pool = scored.slice(0, 40);
  while (chosen.length < limit && pool.length) {
    let best = -1;
    let bestVal = -Infinity;
    for (let i = 0; i < pool.length; i++) {
      const cand = pool[i];
      const c = view.chunkAt(cand.id);
      if ((chosenFiles.get(c.path) || 0) >= 2) continue;
      const toks = bodyTokens(c);
      let maxSim = 0;
      for (const s of chosenSets) {
        let inter = 0;
        for (const t of toks) if (s.has(t)) inter++;
        const union = toks.size + s.size - inter;
        const sim = union ? inter / union : 0;
        if (sim > maxSim) maxSim = sim;
      }
      const val = 0.7 * cand.score - 0.3 * maxSim * cand.score;
      if (val > bestVal) { bestVal = val; best = i; }
    }
    if (best === -1) break;
    const pick = pool.splice(best, 1)[0];
    chosen.push(pick);
    chosenSets.push(bodyTokens(view.chunkAt(pick.id)));
    const p = view.chunkAt(pick.id).path;
    chosenFiles.set(p, (chosenFiles.get(p) || 0) + 1);
  }

  const hits = [];
  let used = 0;
  const words = primary.length ? primary : qTokensAll;
  for (let i = 0; i < chosen.length; i++) {
    const { id, score } = chosen[i];
    const c = view.chunkAt(id);
    const cap = EXCERPT_CAPS[i] ?? 600;
    const overhead = c.path.length + 20;
    const remaining = budgetChars - used - overhead;
    if (remaining <= 0 && hits.length) break;
    const actualCap = Math.min(cap, Math.max(0, remaining));
    if (actualCap < 80 && hits.length) break;
    const excerpt = excerptOf(c.text, words, actualCap, { keepLines: c.kind === 'code' });
    const cost = excerpt.length + overhead;
    if (used + cost > budgetChars && hits.length) break;
    used += cost;
    hits.push({ score: Math.round(score * 100) / 100, path: c.path, start: c.start, end: c.end, kind: c.kind, symbol: c.symbol, heading: c.heading, excerpt });
  }

  if (signal?.aborted) throw new Error('retrieve aborted');

  return {
    hits,
    stats: { files: Object.keys(idx.files || {}).length, chunks: N, builtAt: idx.builtAt, truncated: !!idx.truncated, matches: scored.length, saved: idx.saved !== false },
    words: qTokensAll,
  };
}
