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
import crypto from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { writeFileAtomic, tighten, sleepSync } from './atomic-write.mjs';

// The build that wrote a file, recorded in every new header. Reading an old
// file under a newer build is normal here; the one thing that answers "which
// version did this transcript come from?" is a field, not a memory. A read
// that fails (a package layout without package.json beside it) costs the
// field, never the session.
export const APP_VERSION = (() => {
  try { return JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version ?? null; }
  catch { return null; }
})();

/**
 * The id of a session, and of every entry in one.
 *
 * It used to be eight hex digits of `Math.random()`: 32 bits, from a source
 * that is not a CSPRNG and is re-seeded per process. A session id is a FILE
 * NAME, so a collision is not a duplicate key that gets rejected — it is
 * `writeFileAtomic` replacing an existing session with a brand new one, and
 * the whole conversation is gone without a word. 32 bits is a birthday
 * problem at 77 thousand sessions; 48 bits from the crypto module moves it
 * to 16 million.
 */
const id = () => crypto.randomBytes(6).toString('hex');

const slug = (s) => s.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'root';

/**
 * Are two project roots the same folder?
 *
 * The header carries the root as `path.resolve()` wrote it, and the caller
 * may spell the same folder differently (`d:\aipass` and `D:\aipass`). On
 * Windows those are one folder; on a case-sensitive filesystem they are two,
 * and the comparison follows the platform.
 *
 * @param {string|null|undefined} a
 * @param {string|null|undefined} b
 * @returns {boolean}
 */
export function sameRoot(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = path.resolve(a);
  const y = path.resolve(b);
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}

/**
 * The most a session file may weigh before it is refused.
 *
 * A session grows by appends and nothing ever trims it: 20 KB of tool output
 * per call, a thousand calls, and the file is 20 MB. `load()` reads the whole
 * thing, so a file this size is a memory bomb in a desktop app that also
 * holds a browser. Past the cap the session is refused with a clear reason
 * rather than taking the window down with it.
 */
export const MAX_SESSION_BYTES = 64 * 1024 * 1024;

/**
 * The cap in force right now.
 *
 * The environment variable is the same switch the other knobs have
 * (AIPASS_KEEP_RECENT_BYTES, AIPASS_MAX_RESULT): a machine that runs out of
 * memory on a long session can lower the ceiling instead of losing the
 * session, and a test can exercise the refusal without writing 64 MB.
 *
 * @returns {number}
 */
export const maxSessionBytes = () => {
  const raw = Number(process.env.AIPASS_MAX_SESSION_BYTES);
  return Number.isFinite(raw) && raw > 0 ? raw : MAX_SESSION_BYTES;
};

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

/**
 * The lock that guards a header rewrite.
 *
 * A session file is written by whichever process is talking to it, and there
 * can be more than one: the desktop backend and the CLI work on the same
 * store, and a user can have a window open on a project while a command line
 * runs in it. A header rewrite is a read-modify-write, so without a lock the
 * second writer puts back a copy of the header that is older than the file's
 * — a title, an entry count or a conversation binding the first writer had
 * already changed goes back to the value it had before.
 *
 * The lock is a file next to the session, created with O_EXCL so only one
 * writer can hold it. A lock left behind by a process that died is litter
 * rather than a lock, so a lock older than this is taken over.
 */
const LOCK_STALE_MS = 15_000;
const LOCK_WAIT_MS = 5_000;
const lockPath = (file) => `${file}.lock`;
const NOT_LOCKED = Symbol('header lock not taken');

function withHeaderLock(file, fn) {
  const lock = lockPath(file);
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      const fd = fs.openSync(lock, 'wx', 0o600);
      try { fs.writeSync(fd, String(process.pid)); } finally { fs.closeSync(fd); }
      break;
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
      try {
        const st = fs.statSync(lock);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) { fs.rmSync(lock, { force: true }); continue; }
      } catch { /* the lock is gone — take it */ continue; }
      if (Date.now() > deadline) return NOT_LOCKED;
      sleepSync(5);
    }
  }
  try { return fn(); } finally { try { fs.rmSync(lock, { force: true }); } catch { /* best effort */ } }
}

/**
 * The fields a caller changes, applied to the header.
 *
 * A delta, not a whole header: the header on disk is the truth about the
 * other writer's changes, and this call knows only what it changed itself.
 * `undefined` means "this key is gone" (a conversation that was unbound, a
 * temporary flag that no longer applies).
 */
function applyHeaderDelta(next, delta) {
  for (const [key, value] of Object.entries(delta)) {
    if (value === undefined) delete next[key];
    else next[key] = value;
  }
  return next;
}

/**
 * Write the header line of a session file.
 *
 * The padded first line is overwritten in place (a fixed-size write at
 * offset 0, O(1) however long the log grew); everything else falls back to
 * the atomic swap. `swapOnly` skips the in-place write — that is the path
 * taken when the lock could not be taken, where the whole-file swap is the
 * only write that cannot tear the file.
 */
function writeHeader(file, header, { swapOnly = false } = {}) {
  const line = padHeader(header);
  if (line && !swapOnly) {
    try {
      const first = readFirstLine(file);
      if (Buffer.byteLength(first) === HEADER_WIDTH) {
        if (first === line) { cleanBreadcrumb(file); return; }
        writeFileAtomic(hdrPath(file), JSON.stringify(header) + '\n', { mode: 0o600 });
        const fd = fs.openSync(file, 'r+');
        try { fs.writeSync(fd, Buffer.from(line), 0, HEADER_WIDTH, 0); }
        finally { fs.closeSync(fd); }
        cleanBreadcrumb(file);
        return;
      }
    } catch { /* fall through to the atomic rewrite */ }
  }
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines[0] = line ?? JSON.stringify(header);
  while (lines.at(-1) === '') lines.pop();
  writeFileAtomic(file, lines.join('\n') + '\n', { mode: 0o600 });
  cleanBreadcrumb(file);
}

/**
 * Put the header back on disk, merged against what is on disk.
 *
 * The delta is what this call changed; the rest of the header is read fresh
 * from the file, so another writer's title, count or binding survives. The
 * lock makes the read-modify-write one writer's at a time; the merge is what
 * makes the result correct even when the other writer's change landed
 * between this session being loaded and this call being made.
 *
 * @param {Session} session
 * @param {Record<string, any>|null} [delta] the fields this call changes
 * @returns {Record<string, any>} the header as it now stands
 */
function rewriteHeader(session, delta = null) {
  const file = session.file;
  // The header as it should now stand: what is on disk, plus what this call
  // changed. The rest of the header is the other writer's business.
  const merge = () => {
    const onDisk = readSessionHeader(file).header;
    const next = { ...(onDisk ?? session.header) };
    // A field this build does not know about — a newer build's header field —
    // rides the rewrite: it is in memory and the file has never seen it, so
    // it is carried in rather than dropped. A field the file DOES know about
    // is the file's business: the other writer's value is newer than ours.
    for (const [key, value] of Object.entries(session.header)) {
      if (!(key in next)) next[key] = value;
    }
    if (delta) applyHeaderDelta(next, delta);
    else Object.assign(next, session.header);
    return next;
  };
  const out = withHeaderLock(file, () => {
    const next = merge();
    writeHeader(file, next);
    return next;
  });
  // The lock was not taken within its window: the whole-file swap still
  // cannot tear the file, so the change lands — it just may lose a race it
  // would have won.
  const header = out === NOT_LOCKED
    ? (() => { const next = merge(); writeHeader(file, next, { swapOnly: true }); return next; })()
    : out;
  // The session's own header object is updated in place: other code holds a
  // reference to it, and a replaced object would leave them reading the old
  // values.
  for (const key of Object.keys(session.header)) if (!(key in header)) delete session.header[key];
  Object.assign(session.header, header);
  return session.header;
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
      this.header.entryCount = (this.header.entryCount ?? 0) + 1;
      this.appendsSinceRewrite += 1;
      // Monotonic on purpose: resetting here would make "the first append" true
      // again after every rewrite, and the batching would quietly do nothing.
      if (this.appendsSinceRewrite === 1 || this.appendsSinceRewrite % HEADER_EVERY === 0) {
        // The count is the FILE's, not this session's memory of it: another
        // writer may have appended to the same file since, and the count on
        // disk is the one the picker reads. The base is the count as of the
        // last rewrite; this session's own appends sit on top of it.
        const onDisk = readSessionHeader(this.file).header?.entryCount ?? 0;
        const base = Math.max(onDisk, (this.header.entryCount ?? 0) - this.appendsSinceRewrite);
        rewriteHeader(this, { updated: entry.ts, entryCount: base + this.appendsSinceRewrite });
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
      rewriteHeader(this, { conversation, conversationTemporary: temporary === true });
    } else {
      // `undefined` is "this key is gone" in a delta — an unbound session
      // must not keep the conversation it had.
      rewriteHeader(this, { conversation: undefined, conversationTemporary: undefined });
    }
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
    // A fork is a new file with a new name, and the name is an id: a
    // collision would replace the session that is already there. 48 bits
    // makes it unlikely; the check makes it impossible to lose one.
    let file = path.join(path.dirname(this.file), `session-${header.id}.jsonl`);
    for (let attempt = 0; attempt < 8 && fs.existsSync(file); attempt += 1) {
      header.id = id();
      file = path.join(path.dirname(this.file), `session-${header.id}.jsonl`);
    }
    if (fs.existsSync(file)) throw new Error('could not find a free session id');
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

/**
 * The lines of a file, one at a time, without holding the file in memory.
 *
 * A session is a log that only ever grows: 20 KB of tool output per call, a
 * thousand calls, and the file is 20 MB. `readFileSync(...).split('\n')` read
 * all of it AND built an array of every line — twice the file, plus the
 * array — before a single entry was parsed, in a desktop app that also holds
 * a browser. This walks it in chunks instead, and the decoder keeps a
 * multi-byte character that straddles a chunk boundary intact.
 *
 * The file is capped: past MAX_SESSION_BYTES the session is refused with a
 * reason, rather than taking the window down with it.
 *
 * @param {string} file
 * @returns {Generator<string>}
 */
function* readLines(file, { maxBytes = maxSessionBytes() } = {}) {
  let size = 0;
  try { size = fs.statSync(file).size; } catch { /* unreadable — the walk says so */ }
  if (size > maxBytes) {
    throw new Error(`that session file is too large to open (${Math.round(size / 1e6)} MB)`);
  }
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const decoder = new StringDecoder('utf8');
    const buf = Buffer.alloc(64 * 1024);
    let carry = '';
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n <= 0) break;
      carry += decoder.write(buf.subarray(0, n));
      let at;
      while ((at = carry.indexOf('\n')) !== -1) {
        yield carry.slice(0, at);
        carry = carry.slice(at + 1);
      }
    }
    carry += decoder.end();
    if (carry.length) yield carry;
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

  /**
   * The session with this id that belongs to ANOTHER project, if there is one.
   *
   * A refusal needs a name: "no such session" and "that session is another
   * project's" are different answers, and the person who has the id in front
   * of them needs to know which one it is. The project it belongs to is named
   * by its path, so the window can say whose it is.
   *
   * @param {string} idOrFile
   * @param {{root?: string|null}} [opts]
   * @returns {{file: string, root: string}|null}
   */
  foreignFor(idOrFile, { root = null } = {}) {
    if (!root) return null;
    const own = path.resolve(root);
    // A path handle names a session at least as precisely as an id does, so
    // it is asked the same question: is this file another project's? The id
    // branch below can only recognise an id-shaped handle, and a path is
    // every bit as able to cross the line.
    if (idOrFile.includes(path.sep) || idOrFile.includes('/')) {
      const abs = path.resolve(idOrFile);
      if (!this.contains(abs)) return null;
      const other = rootOfFile(abs);
      if (!other || sameRoot(other, own)) return null;
      if (!belongsToLiveProject(other, own)) return null;
      return { file: abs, root: other };
    }
    for (const dir of this.dirsFor(root)) {
      const file = findById([dir], idOrFile);
      if (!file) continue;
      const other = rootOfFile(file);
      if (!other || sameRoot(other, own)) continue;
      if (!belongsToLiveProject(other, own)) continue;
      return { file, root: other };
    }
    return null;
  }

  /**
   * Is this path inside the store?
   *
   * The check is `path.relative`, not a string prefix: a prefix would also
   * match a sibling directory whose name merely begins with the store's.
   *
   * @param {string} abs
   * @returns {boolean}
   */
  contains(abs) {
    const rel = path.relative(path.resolve(this.dir), path.resolve(abs));
    return Boolean(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
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
    // The id is the file name, so a collision is not a rejected key: the
    // write below would REPLACE the session that is already there and its
    // whole conversation with it. 48 bits makes a collision unlikely; this
    // makes it impossible to lose one.
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const candidate = path.join(dir, `session-${header.id}.jsonl`);
      if (!fs.existsSync(candidate)) {
        writeFileAtomic(candidate, (padHeader(header) ?? JSON.stringify(header)) + '\n', { mode: 0o600 });
        return new Session({ file: candidate, header });
      }
      header.id = id();
    }
    throw new Error('could not find a free session id');
  }

  /**
   * The sessions of one project.
   *
   * The store keeps one directory per project, and the directory NAME is a
   * slug of the path: two different paths can slugify to the same name
   * (`C:\a b` and `C:\a-b`), and a long path is cut at 60 characters. So the
   * directory is a bucket, not a boundary — the header's own `root` is the
   * authority on which project a session belongs to, and a session whose
   * header names another project is not this project's to show, open or
   * delete, however the directory worked out.
   *
   * A header with no root at all is a file from before the field existed: it
   * is kept, because it sits in this project's own directory and there is
   * nothing else to attribute it to.
   */
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
          if (root && header.root && !sameRoot(header.root, root)) continue;
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
      // The project's own directory is the answer when it has one: a session
      // id is the one thing a window acts on, and the session it opens must
      // be the one in the project the caller is looking at.
      const own = root ? findById([this.dirFor(root)], idOrFile) : null;
      if (own) return own;
      // The other directories follow, but only for a session whose project
      // folder is gone: that is the one case where the id still belongs to
      // this project — the folder was moved and nobody ran the relocate. A
      // session of ANOTHER project that is still sitting there is not this
      // project's to open, rename or delete, however its id was learned.
      for (const dir of dirs) {
        const found = findById([dir], idOrFile);
        if (!found) continue;
        if (root && belongsToLiveProject(rootOfFile(found), root)) continue;
        return found;
      }
      return null;
    }
    // A path handle is a path, and it is checked against the same rule the
    // id branch is: a file inside the store may be named, but a session that
    // belongs to ANOTHER project that is still sitting on disk is not this
    // project's to open, rename or delete — and a path names a session at
    // least as precisely as an id does. Without this, the id branch's guard
    // was a guard on one spelling of the handle only.
    const abs = path.resolve(idOrFile);
    for (const dir of dirs) {
      const rel = path.relative(path.resolve(dir), abs);
      if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) continue;
      if (root && belongsToLiveProject(rootOfFile(abs), root)) return null;
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
    for (const line of readLines(file)) {
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

  /**
   * Open a session, but only the entries of the kinds asked for.
   *
   * `load()` brings the whole transcript into memory, and the entries of a
   * session are 95% tool output that a reader of one kind does not want: the
   * statistics page wants the run_stats lines and the header, nothing else.
   * The file is walked the same way either way — the difference is what is
   * kept — so a report over a store of a thousand sessions does not have to
   * hold a thousand transcripts at once.
   *
   * @param {string} idOrFile
   * @param {{root?: string|null, types?: string[]|null}} [opts]
   * @returns {Session|null}
   */
  open(idOrFile, { root = null, types = null } = {}) {
    if (!types) return this.load(idOrFile, { root });
    const file = this.resolveFile(idOrFile, { root });
    if (!file || !fs.existsSync(file)) return null;
    const { header } = readSessionHeader(file);
    if (!header) return null;
    const wanted = new Set(types);
    const entries = [];
    const seen = new Set();
    for (const line of readLines(file)) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        if (!e || typeof e !== 'object' || Array.isArray(e)) continue;
        if (e.type === 'header') continue;
        if (!wanted.has(e.type)) continue;
        if (typeof e.id !== 'string' || seen.has(e.id)) continue;
        seen.add(e.id);
        entries.push(e);
      } catch { /* skip a torn line rather than lose the session */ }
    }
    const last = entries.at(-1);
    return {
      id: header.id,
      title: header.title,
      root: header.root,
      entries,
      meta: () => ({
        id: header.id,
        title: header.title,
        root: header.root,
        model: header.model ?? null,
        created: header.created,
        updated: last?.ts ?? header.created,
        entryCount: entries.length,
        file,
      }),
    };
  }

  rename(id, title, { root = null } = {}) {
    const s = this.load(id, { root });
    if (s) rewriteHeader(s, { title, updated: Date.now() });
    return s;
  }

  remove(idOrFile, { root = null } = {}) {
    const file = this.resolveFile(idOrFile, { root });
    if (file && fs.existsSync(file)) {
      // `force` so a file that vanished between the check and the delete is
      // not an error: the answer the caller wants is "it is gone", and it is.
      fs.rmSync(file, { force: true });
      cleanBreadcrumb(file); // a breadcrumb without its session is litter
      try { fs.rmSync(lockPath(file), { force: true }); } catch { /* no lock left */ }
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
      try { rewriteHeader({ file, header }, { root: to }); } catch { /* the session still opens */ }
    };
    // A rename across filesystems fails (EXDEV): the store and the project
    // can sit on two drives. The move is a copy and then an unlink, so the
    // bytes land before the old copy goes.
    const move = (src, dst) => {
      try { fs.renameSync(src, dst); }
      catch (err) {
        if (err?.code !== 'EXDEV') throw err;
        fs.copyFileSync(src, dst);
        fs.rmSync(src, { force: true });
      }
    };
    let moved = 0;
    for (const [srcDir, dstDir] of [[fromDir, toDir], [path.join(fromDir, 'archive'), path.join(toDir, 'archive')]]) {
      let names = [];
      try { names = fs.readdirSync(srcDir); } catch { continue; }
      for (const name of names) {
        if (!name.endsWith('.jsonl')) continue; // breadcrumbs move with their file, below
        const src = path.join(srcDir, name);
        // The directory is a bucket, not a boundary: another project's session
        // can sit in the same one (two paths that slugify the same). Only the
        // sessions that name THIS project move — carrying a neighbour's
        // transcript along with them would re-key another project's history.
        const { header } = readSessionHeader(src);
        if (header?.root && !sameRoot(header.root, from)) continue;
        let dst = path.join(dstDir, name);
        if (!same) {
          fs.mkdirSync(dstDir, { recursive: true, mode: 0o700 });
          // Only a hand-copied duplicate can collide (ids are per-session);
          // both survive, the second under a suffixed name.
          for (let n = 2; fs.existsSync(dst); n++) dst = path.join(dstDir, `${name}.${n}`);
          move(src, dst);
          const crumb = hdrPath(src);
          if (fs.existsSync(crumb)) {
            try { move(crumb, `${dst}.hdr`); } catch { /* best effort */ }
          }
        }
        rekey(dst);
        moved++;
      }
    }
    // The emptied directories go, the archive before its parent. A directory
    // still holding something (an orphan breadcrumb, a lock a crashed writer
    // left behind, a file that was never a session) is left where it is
    // rather than swept — except for the litter this module owns, which goes.
    for (const dir of same ? [] : [path.join(fromDir, 'archive'), fromDir]) {
      try {
        for (const name of fs.readdirSync(dir)) {
          if (name.endsWith('.lock') || name.endsWith('.hdr')) {
            try { fs.rmSync(path.join(dir, name), { force: true }); } catch { /* best effort */ }
          }
        }
        if (!fs.readdirSync(dir).length) fs.rmdirSync(dir);
      } catch { /* not empty, or not ours */ }
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
        // A lock a crashed writer left behind is litter too.
        try { fs.rmSync(lockPath(file), { force: true }); } catch { /* best effort */ }
        archived.push(s.id);
      } catch { /* one stuck file must not block the rest */ }
    }
    return { archived, archiveDir };
  }

  /**
   * The sessions of a project that are in the archive.
   *
   * The archive is a place a session can be put and a place it can be taken
   * from: without this, "archive" was a one-way door and a session that went
   * in could only come back by hand.
   *
   * @param {string} root
   * @returns {Array<Record<string, any>>}
   */
  listArchived(root) {
    const dir = path.join(this.dirFor(root), 'archive');
    let names = [];
    try { names = fs.readdirSync(dir); } catch { return []; }
    const out = [];
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const file = path.join(dir, name);
      try {
        const { header } = readSessionHeader(file);
        if (!header) continue;
        // The archive is a bucket too: only this project's sessions are ours.
        if (header.root && !sameRoot(header.root, root)) continue;
        out.push({ ...header, file, archived: true });
      } catch { /* a half-written file is skipped, not fatal */ }
    }
    return out.sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0));
  }

  /**
   * Take a session back out of the archive.
   *
   * The file moves to the project's own directory and its header is
   * re-stamped with the project it belongs to — the archive does not change
   * what a session is, it only changes where it sits.
   *
   * @param {string} idOrFile the session's id, or its path in the archive
   * @param {{root?: string|null}} [opts]
   * @returns {boolean} whether the session came back
   */
  restore(idOrFile, { root = null } = {}) {
    if (!root) return false;
    const own = path.resolve(root);
    const archiveDir = path.join(this.dirFor(root), 'archive');
    let file = null;
    if (idOrFile.includes(path.sep) || idOrFile.includes('/')) {
      const abs = path.resolve(idOrFile);
      if (abs.startsWith(path.resolve(archiveDir) + path.sep)) file = abs;
    } else {
      file = findById([archiveDir], idOrFile);
    }
    if (!file || !fs.existsSync(file)) return false;
    const { header } = readSessionHeader(file);
    if (header?.root && !sameRoot(header.root, own)) return false;
    const target = path.join(this.dirFor(root), path.basename(file));
    let dst = target;
    for (let n = 2; fs.existsSync(dst); n++) dst = path.join(this.dirFor(root), `${path.basename(file)}.${n}`);
    try { fs.renameSync(file, dst); }
    catch (err) {
      if (err?.code !== 'EXDEV') throw err;
      fs.copyFileSync(file, dst);
      fs.rmSync(file, { force: true });
    }
    const crumb = hdrPath(file);
    if (fs.existsSync(crumb)) {
      try { fs.renameSync(crumb, `${dst}.hdr`); } catch { /* litter at worst */ }
    }
    // The session comes back with the project it belongs to, whatever the
    // archive said about it.
    try { rewriteHeader({ file: dst, header: header ?? {} }, { root: own, updated: Date.now() }); } catch { /* the session still opens */ }
    return true;
  }

  /**
   * Delete archived sessions that have been in the archive longer than
   * `olderThanMs`.
   *
   * The archive is where a project puts the sessions it does not want in the
   * picker — but it is still a copy, and a project that has lived for years
   * can hold a lot of it. This is the one place in the store that DELETES, so
   * it is deliberately narrow: only files in the archive directory, only
   * those older than the threshold, and only as many as the limit says. The
   * live session is never in the archive, so it is never touched.
   *
   * @param {string} root
   * @param {{olderThanMs?: number, limit?: number}} [opts]
   * @returns {{pruned: string[], count: number}}
   */
  pruneArchived(root, { olderThanMs = 90 * 24 * 3600 * 1000, limit = 20 } = {}) {
    const dir = path.join(this.dirFor(root), 'archive');
    let names = [];
    try { names = fs.readdirSync(dir); } catch { return { pruned: [], count: 0 }; }
    const now = Date.now();
    const picked = [];
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const file = path.join(dir, name);
      const { header } = readSessionHeader(file);
      if (header?.root && !sameRoot(header.root, root)) continue;
      const updated = header?.updated ?? 0;
      if (now - updated <= olderThanMs) continue;
      picked.push({ file, id: header?.id ?? name, updated });
    }
    picked.sort((a, b) => (a.updated ?? 0) - (b.updated ?? 0));
    const pruned = [];
    for (const p of picked.slice(0, Math.max(0, limit))) {
      try {
        fs.rmSync(p.file, { force: true });
        cleanBreadcrumb(p.file);
        pruned.push(p.id);
      } catch { /* one stuck file must not block the rest */ }
    }
    return { pruned, count: pruned.length };
  }
}

/**
 * The project a session file belongs to, as its own header says.
 *
 * @param {string} file
 * @returns {string|null}
 */
function rootOfFile(file) {
  const { header } = readSessionHeader(file);
  const root = header?.root;
  return typeof root === 'string' && root.trim() ? path.resolve(root) : null;
}

/**
 * Is that another project, and is it still there?
 *
 * The folder is what decides: a project that was moved leaves its sessions
 * behind under the old spelling, and those are still this person's work — the
 * id belongs to the project they are working in. A project that is still
 * sitting on disk is a live neighbour, and its sessions are its own.
 *
 * @param {string|null} other the root the session's header names
 * @param {string} own the root of the caller
 * @returns {boolean}
 */
function belongsToLiveProject(other, own) {
  if (!other) return false;
  if (sameRoot(other, own)) return false;
  try { return fs.statSync(other).isDirectory(); } catch { return false; }
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
