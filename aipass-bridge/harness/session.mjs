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
import { writeFileAtomic, tighten } from './atomic-write.mjs';

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
// MoveFileEx with MOVEFILE_REPLACE_EXISTING on Windows). The swap itself
// lives in atomic-write.mjs — the rules store and the memory store need the
// same one, and one implementation is one behavior to pin.

// The header is the first line; rewriting it keeps list() cheap enough that
// the session picker never has to parse whole files. Since every header this
// module writes is padded to HEADER_WIDTH, the common case is a single
// fixed-size write in place — no read of the body, no whole-file rewrite.
// The atomic swap stays as the fallback: an unpadded file (an older version,
// a hand-written one) or a header that outgrew its block.
//
// The in-place write has a crash window the swap does not: a power loss mid
// write can leave a first line that no longer parses, and a session whose
// first line is unreadable used to be a session lost — skipped by the picker,
// null from load(), entries sitting on disk with nobody able to open them.
// The breadcrumb closes it: the same header goes to `${file}.hdr`
// (atomically) before the destructive write, readers fall back to it when the
// first line is torn (see readSessionHeader), and a completed rewrite deletes
// it. A crash now leaves the old header, or the new one plus its breadcrumb —
// never a session nobody can open.
const hdrPath = (file) => `${file}.hdr`;

function cleanBreadcrumb(file) {
  try { fs.rmSync(hdrPath(file), { force: true }); } catch { /* already gone, or not ours to remove */ }
}

function rewriteHeader(session) {
  const line = padHeader(session.header);
  if (line) {
    try {
      const first = readFirstLine(session.file);
      if (Buffer.byteLength(first) === HEADER_WIDTH) {
        if (first === line) { cleanBreadcrumb(session.file); return; }
        writeFileAtomic(hdrPath(session.file), JSON.stringify(session.header) + '\n', { mode: 0o600 });
        const fd = fs.openSync(session.file, 'r+');
        try { fs.writeSync(fd, Buffer.from(line), 0, HEADER_WIDTH, 0); }
        finally { fs.closeSync(fd); }
        cleanBreadcrumb(session.file);
        return;
      }
    } catch { /* fall through to the atomic rewrite */ }
  }
  const lines = fs.readFileSync(session.file, 'utf8').split('\n');
  lines[0] = line ?? JSON.stringify(session.header);
  while (lines.at(-1) === '') lines.pop();
  writeFileAtomic(session.file, lines.join('\n') + '\n', { mode: 0o600 });
  cleanBreadcrumb(session.file);
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

  /**
   * Bind this session to the model-side conversation it is working in, or
   * clear the binding. Persisted in the header, so reopening the session
   * adopts its OWN conversation: without it the harness kept whatever
   * conversation it was last on — one session's messages landed in another
   * session's history (bleed), and a session reopened in a fresh process
   * started with amnesia. One header rewrite per call.
   */
  bindConversation(conversation, temporary = null) {
    if (conversation) {
      this.header.conversation = conversation;
      this.header.conversationTemporary = temporary === true;
    } else {
      delete this.header.conversation;
      delete this.header.conversationTemporary;
    }
    rewriteHeader(this);
    return this.header.conversation ?? null;
  }

  /** Fork a branch: copy everything up to one entry into a new session file. */
  fork(store, { fromEntryId = null, title = null } = {}) {
    const chain = fromEntryId ? this.chainTo(fromEntryId) : this.entries.slice();
    const header = { ...this.header, id: id(), title: title ?? `${this.title} (fork)`, created: Date.now(), updated: Date.now(), forkedFrom: this.id };
    // A fork is a new branch, not a second writer: it must not inherit the
    // conversation the original is still working in.
    delete header.conversation;
    delete header.conversationTemporary;
    const file = path.join(path.dirname(this.file), `session-${header.id}.jsonl`);
    writeFileAtomic(file, [padHeader(header) ?? JSON.stringify(header), ...chain.filter((e) => e.type !== 'header').map((e) => JSON.stringify(e))].join('\n') + '\n', { mode: 0o600 });
    return new Session({ file, header, entries: chain.filter((e) => e.type !== 'header') });
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

// What counts as a header object — the rule load() has always applied to
// header lines: a line is a header only when it says so. `id` alone is not
// enough: every entry carries one, and a file whose first line is a bare
// entry (appended to after an external delete) used to list as a session in
// the picker while refusing to load.
const isHeaderObject = (h) => Boolean(h) && typeof h === 'object' && !Array.isArray(h)
  && h.type === 'header' && typeof h.id === 'string';

/**
 * The header of a session file. The first line answers when it parses;
 * otherwise the breadcrumb an interrupted in-place rewrite left behind does
 * (see rewriteHeader), and `recovered` says so — load() writes it back.
 */
function readSessionHeader(file) {
  try {
    const header = JSON.parse(readFirstLine(file));
    if (isHeaderObject(header)) return { header, recovered: false };
  } catch { /* a torn or unreadable first line — the breadcrumb may know */ }
  try {
    const header = JSON.parse(fs.readFileSync(hdrPath(file), 'utf8'));
    if (isHeaderObject(header)) return { header, recovered: true };
  } catch { /* no breadcrumb either */ }
  return { header: null, recovered: false };
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

  /**
   * Where a session id may live.
   *
   * The project's own directory comes first — a session id is the one thing a
   * window acts on (open it, rename it, delete it), and the answer must be the
   * one in the project the caller is looking at. The store's other
   * directories follow, so a session whose project folder moved still opens by
   * id.
   */
  dirsFor(root = null) {
    return root ? [this.dirFor(root), this.dir, ...readDirs(this.dir)] : [this.dir, ...readDirs(this.dir)];
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
    writeFileAtomic(file, (padHeader(header) ?? JSON.stringify(header)) + '\n', { mode: 0o600 });
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
          // Wrong-type data must not reach the picker: a first line that is
          // not a header object is skipped like a torn one — and a torn one
          // itself is recovered from the breadcrumb, not dropped.
          const { header } = readSessionHeader(file);
          if (!header) continue;
          out.push({ ...header, file, entries: header.entryCount ?? 0 });
        } catch { /* a half-written file is skipped, not fatal */ }
      }
    }
    return out.sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0));
  }

  /**
   * The file a session handle names, or null when it names nothing here.
   *
   * A handle is an id, not a path — but the window lists sessions with their
   * absolute `file`, and passes that back to open one, so an absolute path
   * inside this store is a legitimate handle. A path OUTSIDE the store is
   * not: an id that carried a separator used to be taken as a raw path, so
   * `session.delete` with `id: 'C:\\Users\\ASUS\\.ssh\\id_rsa'` deleted that
   * file and `session.rename` rewrote its first line. The containment check
   * is `path.relative`, not a string prefix — a prefix would also match a
   * sibling directory whose name merely begins with the store's.
   */
  resolveFile(idOrFile, { root = null } = {}) {
    const dirs = this.dirsFor(root);
    if (!idOrFile.includes(path.sep) && !idOrFile.includes('/')) {
      return findById(dirs, idOrFile);
    }
    const abs = path.resolve(idOrFile);
    for (const dir of dirs) {
      const rel = path.relative(path.resolve(dir), abs);
      if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) continue;
      return abs;
    }
    return null;
  }

  load(idOrFile, { root = null } = {}) {
    const file = this.resolveFile(idOrFile, { root });
    if (!file || !fs.existsSync(file)) return null;
    const { header, recovered } = readSessionHeader(file);
    if (!header) return null;
    const entries = [];
    const seen = new Set(); // entry ids already loaded — a duplicated append
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        if (!e || typeof e !== 'object' || Array.isArray(e)) continue;
        if (e.type === 'header') continue; // the header came from line 1 or the breadcrumb
        if (typeof e.id !== 'string' || seen.has(e.id)) continue;
        seen.add(e.id);
        entries.push(e);
      } catch { /* skip a torn line rather than lose the session */ }
    }
    // A file written before the modes were pinned turns owner-only when opened.
    tighten(file, 0o600);
    const session = new Session({ file, header, entries });
    if (recovered) {
      // The breadcrumb's header is written back so the next open reads it the
      // ordinary way, and the entries are the file's own. Best effort: a
      // read-only copy still loads from the breadcrumb every time.
      try { rewriteHeader(session); } catch { /* the session loads anyway */ }
    } else {
      cleanBreadcrumb(file); // stale residue of a crash that cost nothing
    }
    return session;
  }

  rename(id, title, { root = null } = {}) {
    const s = this.load(id, { root });
    if (s) { s.header.title = title; s.header.updated = Date.now(); rewriteHeader(s); }
    return s;
  }

  remove(idOrFile, { root = null } = {}) {
    const file = this.resolveFile(idOrFile, { root });
    if (file && fs.existsSync(file)) {
      fs.rmSync(file);
      cleanBreadcrumb(file); // a breadcrumb without its session is litter
    }
    return Boolean(file && !fs.existsSync(file));
  }

  /**
   * Re-key a project's sessions after its folder moved.
   *
   * `sessions/<slug>` and the header's `root` are both derived from the
   * absolute path, so a copied home on a machine whose paths differ shows an
   * empty picker and conversations that no longer know which project they
   * belonged to. This moves every file of `fromRoot` into `toRoot`'s
   * directory — the archive too, breadcrumbs alongside their sessions — and
   * rewrites each header's root. Ids and entries are untouched, so a session
   * still opens by id from wherever it now sits. Two paths can share one slug
   * (`a b` and `a-b` slugify the same); then the files are already in the
   * right directory and only the headers change.
   */
  reassign(fromRoot, toRoot) {
    const from = path.resolve(fromRoot);
    const to = path.resolve(toRoot);
    const fromDir = path.join(this.dir, slug(from));
    const toDir = this.dirFor(to);
    const same = path.resolve(fromDir) === path.resolve(toDir);
    // A header read from a breadcrumb (a torn in-place rewrite) is written
    // back to the file here, so a session that was broken before the move is
    // repaired by it. A file with no header at all moves as it is.
    const rekey = (file) => {
      const { header } = readSessionHeader(file);
      if (!header) return;
      header.root = to;
      try { rewriteHeader({ file, header }); } catch { /* the session still opens */ }
    };
    let moved = 0;
    for (const [srcDir, dstDir] of [[fromDir, toDir], [path.join(fromDir, 'archive'), path.join(toDir, 'archive')]]) {
      let names = [];
      try { names = fs.readdirSync(srcDir); } catch { continue; }
      for (const name of names) {
        if (!name.endsWith('.jsonl')) continue; // breadcrumbs move with their file, below
        const src = path.join(srcDir, name);
        let dst = path.join(dstDir, name);
        if (!same) {
          fs.mkdirSync(dstDir, { recursive: true, mode: 0o700 });
          // Only a hand-copied duplicate can collide (ids are per-session);
          // both survive, the second under a suffixed name.
          for (let n = 2; fs.existsSync(dst); n++) dst = path.join(dstDir, `${name}.${n}`);
          fs.renameSync(src, dst);
          const crumb = hdrPath(src);
          if (fs.existsSync(crumb)) {
            try { fs.renameSync(crumb, `${dst}.hdr`); } catch { /* best effort */ }
          }
        }
        rekey(dst);
        moved++;
      }
    }
    // The emptied directories go, the archive before its parent. A directory
    // still holding something (an orphan breadcrumb, a file that was never a
    // session) is left where it is rather than swept.
    for (const dir of same ? [] : [path.join(fromDir, 'archive'), fromDir]) {
      try { if (!fs.readdirSync(dir).length) fs.rmdirSync(dir); } catch { /* not empty, or not ours */ }
    }
    return { moved, dir: toDir };
  }

  /**
   * Archive sessions idle longer than `olderThanMs`, newest-first.
   *
   * A project that has lived for months carries dozens of dead sessions in
   * the picker — on this machine that was 61 files in one project. The
   * archive is a sibling directory (`<root>/archive/`) holding the same
   * JSONL files, so nothing is deleted, only moved out of the picker's way;
   * `list()` never reads the archive dir. `limit` caps how many move per
   * call so one call cannot surprise with a mass move. The live session
   * (`keepId`) is never archived even when idle.
   */
  archiveIdle(root, { olderThanMs = 30 * 24 * 3600 * 1000, limit = 50, keepId = null } = {}) {
    const dir = this.dirFor(root);
    const now = Date.now();
    const idle = this.list(root)
      .filter((s) => s.id !== keepId && (now - (s.updated ?? 0)) > olderThanMs)
      .sort((a, b) => (a.updated ?? 0) - (b.updated ?? 0));
    const picked = idle.slice(0, Math.max(0, limit));
    if (!picked.length) return { archived: [], archiveDir: path.join(dir, 'archive') };
    const archiveDir = path.join(dir, 'archive');
    fs.mkdirSync(archiveDir, { recursive: true, mode: 0o700 });
    tighten(archiveDir, 0o700);
    const archived = [];
    for (const s of picked) {
      try {
        const file = s.file ?? findById(this.dirsFor(root), s.id);
        if (!file || !fs.existsSync(file)) continue;
        fs.renameSync(file, path.join(archiveDir, path.basename(file)));
        // The breadcrumb is part of the session on disk when a crash left
        // one; it moves with it (best effort — never the session's problem).
        try { if (fs.existsSync(hdrPath(file))) fs.renameSync(hdrPath(file), path.join(archiveDir, path.basename(hdrPath(file)))); } catch { /* litter at worst */ }
        archived.push(s.id);
      } catch { /* one stuck file must not block the rest */ }
    }
    return { archived, archiveDir };
  }
}

function readDirs(dir) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  return entries.filter((e) => e.isDirectory()).map((e) => path.join(dir, e.name));
}

/**
 * The session file for an id.
 *
 * The name is exact — `session-<id>.jsonl` — and a substring match is a
 * data-loss bug waiting to happen: every session file carries the id inside
 * its name, so `f.includes(id)` made `session.delete {id:"a"}` land on
 * whichever session happened to come first. The id is the whole name, or it
 * is nothing.
 */
function findById(dirs, id) {
  const wanted = `session-${id}.jsonl`;
  for (const d of dirs) {
    let files = [];
    try { files = fs.readdirSync(d); } catch { continue; }
    // Only real session files: a .tmp left behind by a crash mid-rewrite must
    // never shadow the session it was born from.
    const hit = files.find((f) => f === wanted);
    if (hit) return path.join(d, hit);
  }
  return null;
}
