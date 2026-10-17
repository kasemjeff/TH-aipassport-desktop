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
//   {"type":"compaction","id":"…","parentId":…,"summary":…,"firstKeptEntryId":…}
//   {"type":"note",    "id":"…","parentId":…,"text":…}
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

// A rewrite that writes in place loses the whole file if the process dies
// between the truncate and the last byte. Temp file plus rename makes the
// swap atomic: a crash leaves the previous version on disk, never a half one.
// rename() replaces an existing destination on both platforms (libuv uses
// MoveFileEx with MOVEFILE_REPLACE_EXISTING on Windows).
function writeAtomic(file, text) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

// The header is the first line; rewriting it keeps list() cheap enough that
// the session picker never has to parse whole files.
function rewriteHeader(session) {
  const lines = fs.readFileSync(session.file, 'utf8').split('\n');
  lines[0] = JSON.stringify(session.header);
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
    fs.appendFileSync(this.file, JSON.stringify(entry) + '\n');
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
    const header = { ...this.header, id: id(), title: title ?? `${this.title} (fork)`, created: Date.now(), updated: Date.now(), forkedFrom: this.id };
    const file = path.join(path.dirname(this.file), `session-${header.id}.jsonl`);
    writeAtomic(file, [header, ...chain.filter((e) => e.type !== 'header')].map((e) => JSON.stringify(e)).join('\n') + '\n');
    return new Session({ file, header, entries: chain.filter((e) => e.type !== 'header') });
  }

  toMarkdown() {
    const lines = [`# ${this.title}`, '', `root: ${this.root}`, ''];
    for (const e of this.entries) {
      if (e.type === 'user') lines.push(`## you`, '', e.text, '');
      else if (e.type === 'assistant') lines.push(`## assistant`, '', e.text ?? '', e.reasoning ? `\n_${e.reasoning}_` : '', '');
      else if (e.type === 'tool') lines.push(`**${e.kind} ${e.arg}**`, '', '```', String(e.out ?? '').slice(0, 4000), '```', '');
      else if (e.type === 'diff') lines.push(`**${e.file}** — +${e.added} −${e.removed} (${e.decision})`, '');
      else if (e.type === 'compaction') lines.push(`> compacted: ${e.summary}`, '');
      else if (e.type === 'todo') lines.push('**todo**', '', ...e.items.map((i) => `- [${i.done ? 'x' : ' '}] ${i.text}`), '');
      else if (e.type === 'note') lines.push(`_${e.text}_`, '');
    }
    return lines.join('\n');
  }
}

export class SessionStore {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
  }

  static default(base = path.join(os.homedir(), '.aipass', 'sessions')) {
    return new SessionStore(base);
  }

  dirFor(root) {
    const dir = path.join(this.dir, slug(path.resolve(root)));
    fs.mkdirSync(dir, { recursive: true });
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
      schema: 1,
    };
    const file = path.join(dir, `session-${header.id}.jsonl`);
    writeAtomic(file, JSON.stringify(header) + '\n');
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
          const first = fs.readFileSync(file, 'utf8').split('\n', 1)[0];
          const header = JSON.parse(first);
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
    let header = null;
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        if (e.type === 'header') header = e;
        else entries.push(e);
      } catch { /* skip a torn line rather than lose the session */ }
    }
    if (!header) return null;
    return new Session({ file, header, entries });
  }

  rename(id, title) {
    const s = this.load(id);
    if (s) { s.header.title = title; s.header.updated = Date.now(); rewriteHeader(s); }
    return s;
  }

  remove(idOrFile) {
    const file = idOrFile.includes(path.sep) || idOrFile.includes('/') ? idOrFile : findById(this.dir, idOrFile);
    if (file && fs.existsSync(file)) fs.rmSync(file);
    return Boolean(file && fs.existsSync(file));
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
