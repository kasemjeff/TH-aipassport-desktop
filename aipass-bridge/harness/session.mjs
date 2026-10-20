// Sessions, stored the way pi stores them: one JSONL file per session, one
// entry per line, every entry carrying the id of the entry before it.
//
// Why local and not the bridge: the upstream keeps its own history, but it only
// ever accepts a single user message per request, so the client is the only
// place that ever sees the whole shape of a conversation. Forks, tree
// navigation and compaction summaries are all facts about that shape.
//
//   {"type":"header",  "id":"a1b2c3d4","parentId":null,"title":…,"root":…}
//   {"type":"user",    "id":"…","parentId":"…","text":…,"ts":…}
//   {"type":"assistant","id":"…","parentId":"…","text":…,"reasoning":…,"ts":…}
//   {"type":"tool",    "id":"…","parentId":"…","kind":"read","arg":…,"out":…,"ok":true}
//   {"type":"diff",    "id":"…","parentId":"…","file":…,"added":n,"removed":n,"decision":"pending|applied|rejected"}
//   {"type":"todo",    "id":"…","parentId":"…,"items":[{text,done}]}
//   {"type":"compaction","id":"…","parentId":…,"summary":…,"memory":[…],"lastSummarizedEntryId":…}
//   {"type":"note",    "id":"…","parentId":…,"text":…}
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The build that wrote a file, recorded in every new header. Reading an old
// file under a newer build is normal here; the one thing that answers "which
// version did this transcript come from?" is a field, not a memory. A read
// that fails (a package layout without package.json beside it) costs the
// field, never the session.
export const APP_VERSION = (() => {
  try { return JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version ?? null; }
  catch { return null; }
})();

const id = () => Math.random().toString(16).slice(2, 10);
const slug = (s) => s.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'root';

/**
 * How many appends share one header rewrite.
 *
 * The header is the first line of the session file, and rewriting it used to
 * happen on every entry - a read of the whole file plus a write of the whole
 * file, per entry, which is O(n^2) IO on a session that has had a long
 * conversation. The header only carries presentation facts (title, updated,
 * entryCount) that list() reads to build the picker, so it is refreshed on the
 * first append and then once per batch of this many.
 *
 * The trade-off, stated plainly: list() ordering and entryCount can lag a
 * session by up to this many entries - the file's header says "updated 25
 * entries ago" for a session that is live right now. Everything that has to be
 * exact is: append() itself appends one line per entry, rename() and fork()
 * rewrite the header unconditionally, and meta() reads the last entry from
 * memory rather than from the file.
 */
export const HEADER_EVERY = 25;

// Every header line this module writes is padded to this many bytes once, at
// create()/fork() time. JSON.parse ignores the trailing spaces, and the fixed
// width turns a header rewrite from read-the-whole-file-plus-swap into one
// 2 KB overwrite at offset 0 — O(1) however long the log has grown. A header
// that outgrows the block (a very long title) falls back to the atomic swap.
export const HEADER_WIDTH = 2048;
const padHeader = (header) => {
  const base = JSON.stringify(header);
  const room = HEADER_WIDTH - Buffer.byteLength(base);
  return room >= 0 ? base + ' '.repeat(room) : null;
};

// A rewrite that writes in place loses the whole file if the process dies
// between the truncate and the last byte. Temp file plus rename makes the
// swap atomic: a crash leaves the previous version on disk, never a half one.
// rename() replaces an existing destination on both platforms (libuv uses
// MoveFileEx with MOVEFILE_REPLACE_EXISTING on Windows).
function writeAtomic(file, text) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  tighten(tmp, 0o600);
  fs.renameSync(tmp, file);
}

// Owner-only where the OS has POSIX modes; Windows keeps ACLs, so the chmod is
// best effort there. The store is the sensitive data class (SECURITY.md) — a
// session holds the user's own words and the model's work, and the token file
// already pins its own modes the same way.
function tighten(target, mode) {
  try { fs.chmodSync(target, mode); } catch { /* best effort on Windows */ }
}

// The header is the first line; rewriting it keeps list() cheap enough that
// the session picker never has to parse whole files. Since every header this
// module writes is padded to HEADER_WIDTH, the common case is a single
// fixed-size write in place — no read of the body, no whole-file rewrite.
// The atomic swap stays as the fallback: an unpadded file (an older version,
// a hand-written one) or a header that outgrew its block.
function rewriteHeader(session) {
  const line = padHeader(session.header);
  if (line) {
    try {
      const first = readFirstLine(session.file);
      if (Buffer.byteLength(first) === HEADER_WIDTH) {
        if (first === line) return;
        const fd = fs.openSync(session.file, 'r+');
        try { fs.writeSync(fd, Buffer.from(line), 0, HEADER_WIDTH, 0); }
        finally { fs.closeSync(fd); }
        return;
      }
    } catch { /* fall through to the atomic rewrite */ }
  }
  const lines = fs.readFileSync(session.file, 'utf8').split('\n');
  lines[0] = line ?? JSON.stringify(session.header);
  while (lines.at(-1) === '') lines.pop();
  writeAtomic(session.file, lines.join('\n') + '\n');
}

export class Session {
  constructor({ file, header, entries = [] }) {
    this.file = file;
    this.header = header;
    this.entries = entries;
    /** Appends since the last header rewrite; see HEADER_EVERY. */
    this.appendsSinceRewrite = 0;
  }

  get id() { return this.header.id; }
  get title() { return this.header.title; }
  get root() { return this.header.root; }

  /** Append one entry to the chain; returns the stored entry. */
  append(type, data = {}) {
    const entry = {
      type,
      id: id(),
      parentId: this.entries.at(-1)?.id ?? null,
      ts: Date.now(),
      ...data,
    };
    this.entries.push(entry);
    fs.appendFileSync(this.file, JSON.stringify(entry) + '\n', { mode: 0o600 });
    if (type !== 'header') {
      this.header.updated = entry.ts;
      this.header.entryCount = (this.header.entryCount ?? 1) + 1;
      this.appendsSinceRewrite += 1;
      // Monotonic on purpose: resetting here would make "the first append" true
      // again after every rewrite, and the batching would quietly do nothing.
      if (this.appendsSinceRewrite === 1 || this.appendsSinceRewrite % HEADER_EVERY === 0) {
        rewriteHeader(this);
      }
    }
    return entry;
  }

  find(entryId) { return this.entries.find((e) => e.id === entryId) ?? null; }

  /** The chain of entries from the start up to and including one entry. */
  chainTo(entryId) {
    const at = this.entries.findIndex((e) => e.id === entryId);
    return at === -1 ? this.entries.slice() : this.entries.slice(0, at + 1);
  }

  /** Everything the model was sent, in order — the compaction input. */
  sentMessages() {
    return this.entries.filter((e) => e.type === 'user').map((e) => ({ id: e.id, text: e.text, ts: e.ts }));
  }

  meta() {
    const last = this.entries.at(-1);
    return {
      id: this.id,
      title: this.title,
      root: this.root,
      model: this.header.model ?? null,
      created: this.header.created,
      updated: last?.ts ?? this.header.created,
      entryCount: this.entries.length,
      file: this.file,
    };
  }

  /** Fork a branch: copy everything up to one entry into a new session file. */
  fork(store, { fromEntryId = null, title = null } = {}) {
    const chain = fromEntryId ? this.chainTo(fromEntryId) : this.entries.slice();
    const kept = chain.filter((e) => e.type !== 'header');
    // The header is a copy of the parent's, so it carried the parent's
    // entryCount — and a fork from one entry holds fewer than that. The
    // count may lag, never overstate (root rule 8), so the fork states its
    // own.
    const header = { ...this.header, id: id(), title: title ?? `${this.title} (fork)`, created: Date.now(), updated: Date.now(), entryCount: kept.length, forkedFrom: this.id };
    const file = path.join(path.dirname(this.file), `session-${header.id}.jsonl`);
    writeAtomic(file, [padHeader(header) ?? JSON.stringify(header), ...kept.map((e) => JSON.stringify(e))].join('\n') + '\n');
    return new Session({ file, header, entries: kept });
  }

  toMarkdown() {
    const lines = [`# ${this.title}`, '', `root: ${this.root}`, ''];
    for (const e of this.entries) {
      if (e.type === 'user') lines.push(`## you`, '', e.text, '');
      else if (e.type === 'assistant') lines.push(`## assistant`, '', e.text ?? '', e.reasoning ? `\n_${e.reasoning}_` : '', '');
      else if (e.type === 'tool') lines.push(`**${e.kind} ${e.arg}**`, '', '```', String(e.out ?? '').slice(0, 4000), '```', '');
      else if (e.type === 'diff') lines.push(`**${e.file}** — +${e.added} −${e.removed} (${e.decision})`, '');
      else if (e.type === 'compaction') lines.push(`> compacted: ${e.summary ?? '(no summary)'}`, '');
      else if (e.type === 'todo') lines.push('**todo**', '', ...e.items.map((i) => `- [${i.done ? 'x' : ' '}] ${i.text}`), '');
      else if (e.type === 'note') lines.push(`_${e.text}_`, '');
    }
    return lines.join('\n');
  }
}

/**
 * The first line of a file, without reading the rest of it. A run's log grows
 * to megabytes, and the picker only ever needs the header: listing the whole
 * store used to read every session end to end.
 */
function readFirstLine(file, cap = 64 * 1024) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(cap);
    const n = fs.readSync(fd, buf, 0, cap, 0);
    return buf.subarray(0, n).toString('utf8').split('\n', 1)[0];
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* already closed */ } }
  }
}

export class SessionStore {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // A store an older build (or a loose umask) left readable turns owner-only
    // the first time it is opened.
    tighten(dir, 0o700);
  }

  static default(base = path.join(os.homedir(), '.aipass', 'sessions')) {
    return new SessionStore(base);
  }

  dirFor(root) {
    const dir = path.join(this.dir, slug(path.resolve(root)));
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    tighten(dir, 0o700);
    return dir;
  }

  create({ root = process.cwd(), model = null, title = null, forkedFrom = null }) {
    const dir = this.dirFor(root);
    const header = {
      type: 'header',
      id: id(),
      parentId: null,
      title: title ?? new Date().toISOString().slice(0, 16).replace('T', ' '),
      root: path.resolve(root),
      model,
      created: Date.now(),
      updated: Date.now(),
      entryCount: 0,
      forkedFrom,
      app: APP_VERSION,
      schema: 1,
    };
    const file = path.join(dir, `session-${header.id}.jsonl`);
    writeAtomic(file, (padHeader(header) ?? JSON.stringify(header)) + '\n');
    return new Session({ file, header });
  }

  list(root = null) {
    const out = [];
    const dirs = root ? [this.dirFor(root)] : readDirs(this.dir);
    for (const dir of dirs) {
      let files = [];
      try { files = fs.readdirSync(dir); } catch { continue; }
      for (const f of files) {
        if (!f.endsWith('.jsonl')) continue;
        const file = path.join(dir, f);
        try {
          const first = readFirstLine(file);
          const header = JSON.parse(first);
          // Wrong-type data must not reach the picker: a first line that parses
          // to anything but a header object is skipped like a torn one.
          if (!header || typeof header !== 'object' || typeof header.id !== 'string') continue;
          out.push({ ...header, file, entries: header.entryCount ?? 0 });
        } catch { /* a half-written file is skipped, not fatal */ }
      }
    }
    return out.sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0));
  }

  load(idOrFile) {
    const file = idOrFile.includes(path.sep) || idOrFile.includes('/')
      ? idOrFile
      : findById(this.dir, idOrFile);
    if (!file || !fs.existsSync(file)) return null;
    const entries = [];
    const seen = new Set(); // entry ids already loaded — a duplicated append
    let header = null;      // (a crash between write and fsync) loads once
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        if (!e || typeof e !== 'object' || Array.isArray(e)) continue;
        if (e.type === 'header') { header = e; continue; }
        if (typeof e.id !== 'string' || seen.has(e.id)) continue;
        seen.add(e.id);
        entries.push(e);
      } catch { /* skip a torn line rather than lose the session */ }
    }
    if (!header || typeof header.id !== 'string') return null;
    // A file written before the modes were pinned turns owner-only when opened.
    tighten(file, 0o600);
    return new Session({ file, header, entries });
  }

  rename(id, title) {
    const s = this.load(id);
    if (s) { s.header.title = title; s.header.updated = Date.now(); rewriteHeader(s); }
    return s;
  }

  remove(idOrFile) {
    const file = idOrFile.includes(path.sep) || idOrFile.includes('/') ? idOrFile : findById(this.dir, idOrFile);
    // The answer is "did I remove it?", so the existence check has to happen
    // before the unlink — after it, the file is gone and the answer is always
    // no, however well the removal went.
    // The answer is "did I remove it?", so the existence check has to happen
    // before the unlink — after it, the file is gone and the answer is always
    // no, however well the removal went.
    const there = Boolean(file && fs.existsSync(file));
    if (there) fs.rmSync(file);
    return there;
  }
}

function readDirs(dir) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  return entries.filter((e) => e.isDirectory()).map((e) => path.join(dir, e.name));
}

function findById(dir, id) {
  for (const d of [dir, ...readDirs(dir)]) {
    let files = [];
    try { files = fs.readdirSync(d); } catch { continue; }
    // Only real session files: a .tmp left behind by a crash mid-rewrite must
    // never shadow the session it was born from.
    const hit = files.find((f) => f.endsWith('.jsonl') && f.includes(id));
    if (hit) return path.join(d, hit);
  }
  return null;
}
