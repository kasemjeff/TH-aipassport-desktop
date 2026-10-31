// The pending-edit filesystem.
//
// The agent never writes while it works: every read, edit and delete lands in
// an overlay Map and only reaches the disk when the run is applied. That gives
// the desktop UI a diff to show before anything changes, and it means a run
// that dies halfway leaves the tree exactly as it was.
//
// Semantics are taken verbatim from the original agent.mjs:
//   - values are strings, except the DELETED sentinel
//   - readAt prefers the overlay, throws for deleted paths
//   - a listing merges pending entries so just-written files show up
import fs from 'node:fs';
import path from 'node:path';
import { unifiedDiff } from '../difflib.mjs';
import { writeFileAtomic } from './atomic-write.mjs';

export const SKIP = new Set([
  'node_modules', '.git', '.next', 'dist', 'build', '.cache',
  // The usual suspects the walks kept drowning in: build outputs and
  // dependency/vendor trees that are data to this project, not source.
  'target', 'vendor', 'coverage', '__pycache__', '.venv', 'venv',
  // The harness's own spill directory. spill() in tools.mjs drops long tool
  // results there, so without this every earlier run of this project sits in
  // `.aipass/spill` waiting to be walked and re-read as if it were source -
  // which both buries the real files and spends context re-reading output the
  // model has already been shown. SKIP governs listing/search/glob only:
  // read() is deliberately NOT filtered, because the locator spill() returns
  // points the model straight back at one of those files.
  '.aipass',
]);

// Paths that are never walked. The OS's temp and the app's update staging areas
// put thousands of near-identical paths in a single walk, and a glob of the
// home folder once spilled 160 lines of them into one message the upstream edge
// refused. SKIP (above) covers well-known names; this covers the *path* shapes
// that are noise wherever they appear. Walks only: read() and a flat list() are
// deliberately not filtered, so an explicit NEED file / NEED dir still works.
export function isNoisePath(rel) {
  const norm = '/' + String(rel ?? '').replace(/\\/g, '/').toLowerCase().replace(/^\/+|\/+$/g, '') + '/';
  return norm.includes('/appdata/local/temp/')
    || norm.includes('/appdata/roaming/temp/')
    || /\/aipass-update-[a-z0-9]+(\/|$)/.test(norm);
}

export const DELETED = '\x00DELETE\x00';

// Paths that go to the model come back from it, in a NEED file or an EDIT. On
// Windows path.relative yields `src\a.ts`, so normalise to one separator
// everywhere rather than teaching the model two shapes.
export const posix = (p) => p.split(path.sep).join('/');

/**
 * The path as the filesystem really has it: every link on the way followed.
 *
 * For a path that does not exist yet — a file this run has not written — the
 * nearest existing ancestor is resolved and the rest of the path is put back
 * on top. That is the directory the file would land in, which is what the
 * containment question is actually about.
 *
 * Returns null when nothing on the path exists at all (a root that is not
 * there yet), so the caller can fall back to the lexical answer.
 */
export function realPath(abs) {
  let cur = path.resolve(abs);
  const tail = [];
  for (;;) {
    try {
      // `.native` is the one that expands the OS's aliases too: a Windows
      // short name (`RUNNER~1`) is the same folder as its long spelling, and
      // the plain implementation leaves it short. Both must answer one path.
      const real = fs.realpathSync.native?.(cur) ?? fs.realpathSync(cur);
      return tail.length ? path.join(real, ...tail) : real;
    } catch {
      const parent = path.dirname(cur);
      if (!parent || parent === cur) return null;
      tail.unshift(path.basename(cur));
      cur = parent;
    }
  }
}

// read() shows a line-number gutter so the model can reference ranges. Those
// numbers are display only; strip them off a FIND block in case the model
// copied them back — but only when every non-empty line carries one, so real
// content that merely contains a pipe is left alone.
export function stripGutter(block) {
  const gutter = /^\s{0,6}\d+\s*\|\s?/;
  const lines = block.split('\n');
  const nonEmpty = lines.filter((l) => l.trim());
  if (nonEmpty.length && nonEmpty.every((l) => gutter.test(l))) {
    return lines.map((l) => l.replace(gutter, '')).join('\n');
  }
  return block;
}

// Binary file magic signatures, checked on NEED file. Trying to read binary
// content as UTF-8 costs a whole run of the model trying to make sense of
// mojibake — refuse up front by signature or by NUL byte, and tell the user
// how to attach it to a chat instead.
const MAGIC = [
  ['PDF', (b) => b.subarray(0, 4).toString('latin1') === '%PDF'],
  ['a zip-based document (docx, xlsx, pptx)', (b) => b.subarray(0, 4).toString('latin1') === 'PK\x03\x04'],
  ['PNG', (b) => b.subarray(1, 4).toString('latin1') === 'PNG'],
  ['JPEG', (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ['GIF', (b) => b.subarray(0, 3).toString('latin1') === 'GIF'],
  ['gzip', (b) => b[0] === 0x1f && b[1] === 0x8b],
  ['MP4 or MOV', (b) => b.subarray(4, 8).toString('latin1') === 'ftyp'],
  ['RIFF media (wav, avi, webp)', (b) => b.subarray(0, 4).toString('latin1') === 'RIFF'],
  ['Ogg', (b) => b.subarray(0, 4).toString('latin1') === 'OggS'],
  ['MP3', (b) => b.subarray(0, 3).toString('latin1') === 'ID3'],
  ['a compiled binary', (b) => b.subarray(1, 4).toString('latin1') === 'ELF'],
];

/** `pending(abs)` reports whether the overlay already holds the path. */
export function binaryKind(abs, pending = () => false) {
  if (pending(abs)) return null; // written by the agent this run, so text
  let fd;
  try {
    fd = fs.openSync(abs, 'r');
    const buf = Buffer.alloc(4096);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const head = buf.subarray(0, n);
    for (const [name, test] of MAGIC) if (test(head)) return name;
    // Nothing recognised it, so fall back to the oldest test there is.
    return head.includes(0) ? 'binary' : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* already closed */ } }
  }
}

export class Overlay {
  constructor(root, { clip = (s) => s, base = null } = {}) {
    this.root = path.resolve(root);
    this.map = new Map();
    this.clip = clip;
    // A read-through layer: a parallel helper stages edits of its own but
    // treats the parent's staged tree as its starting point (harness.mjs), so
    // `read`, `exists` and listings see the work in progress. Only the read
    // surfaces consult it — the staged map, keys and diffs never do, so what
    // the helper proposes stays distinctly its own work.
    this.base = base;
    // The window polls pending diffs after every step and on a timer, and each
    // poll used to re-read every staged file's disk copy and re-run the diff.
    // Two memos fix that: diskText keyed by the file's mtime+size, and the
    // change record keyed by (staged value, disk stamp). Staged strings are
    // immutable, so reference identity is a sound cache key for them.
    this.diskMemo = new Map();    // abs → { stamp, text }
    this.changeMemo = new Map();  // abs → { next, stamp, record }
    // The root as the filesystem really has it — the answer to "where does
    // this project really live", which the containment check needs (see
    // safe()): a project reached through a junction has two names, and only
    // the real one is worth comparing against.
    this.realRoot = realPath(this.root);
  }

  get size() { return this.map.size; }

  /**
   * The one path check every tool goes through: a model-supplied path must
   * stay inside the project.
   *
   * Two boundaries, because one is not enough:
   *
   *   - the LEXICAL one: `path.relative`, not a string prefix. A prefix test
   *     compares case, and Windows does not: `d:\proj\file.txt` IS inside
   *     `D:\proj` on that filesystem, and the prefix test refused it. The
   *     same reasoning (and the same fix) is already in rpc.mjs's
   *     `staticFileFor`.
   *   - the PHYSICAL one: the path must still be inside the root after the
   *     filesystem has followed every link on the way. A junction inside the
   *     project that points elsewhere is a way out of the root that a
   *     resolved string cannot see — `NEED file link/away/secret.txt` used
   *     to read a file outside the project, which is exactly what the
   *     confinement exists to prevent.
   */
  safe(p) {
    const abs = path.resolve(this.root, p);
    const rel = path.relative(this.root, abs);
    const outside = rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
    if (outside) {
      throw new Error(`outside project root: ${p} — this run can only read and write inside the project; if the human named this path, tell them instead of moving it.`);
    }
    // The real path of the target — or of the nearest ancestor that exists,
    // for a file this run has not written yet. Compared against the real root.
    const realRoot = this.realRoot ?? this.root;
    const real = realPath(abs);
    if (real) {
      const realRel = path.relative(realRoot, real);
      const out = realRel === '..' || realRel.startsWith(`..${path.sep}`) || path.isAbsolute(realRel);
      if (out) {
        throw new Error(`outside project root: ${p} — this path leaves the project through a link; this run can only read and write inside the project.`);
      }
    }
    return abs;
  }

  /** Resolve a model-supplied path, or null when it escapes the root. */
  trySafe(p) {
    try { return this.safe(p); } catch { return null; }
  }

  has(abs) { return this.map.has(abs) || (this.base?.has(abs) ?? false); }
  isDeleted(abs) {
    if (this.map.has(abs)) return this.map.get(abs) === DELETED;
    return this.base?.isDeleted(abs) ?? false;
  }
  keys() { return [...this.map.keys()]; }
  entries() { return [...this.map.entries()]; }

  set(abs, content) { this.map.set(abs, content); }
  markDeleted(abs) { this.map.set(abs, DELETED); }
  discard(abs) { this.map.delete(abs); }
  clear() {
    this.map.clear();
    // The memos describe the map/disk as they were; a clear is the one moment
    // both definitely change together.
    this.changeMemo.clear();
    this.diskMemo.clear();
  }

  readAt(abs) {
    if (this.map.has(abs)) {
      const val = this.map.get(abs);
      if (val === DELETED) throw new Error(`file was deleted: ${posix(path.relative(this.root, abs))}`);
      return val;
    }
    if (this.base) return this.base.readAt(abs);
    return fs.readFileSync(abs, 'utf8');
  }

  existsAt(abs) {
    if (this.map.has(abs)) return this.map.get(abs) !== DELETED;
    if (this.base) return this.base.existsAt(abs);
    return fs.existsSync(abs);
  }

  /** Bytes currently on disk, ignoring the overlay. */
  diskText(abs) {
    let stamp = 'gone';
    try { const st = fs.statSync(abs); stamp = `${st.mtimeMs}:${st.size}`; } catch { /* missing */ }
    const hit = this.diskMemo.get(abs);
    if (hit && hit.stamp === stamp) return hit.text;
    const text = stamp === 'gone' ? '' : fs.readFileSync(abs, 'utf8');
    this.diskMemo.set(abs, { stamp, text });
    return text;
  }

  // A file the agent has written this run is readable by `read` and reported by
  // `exists`, so a listing that omits it tells the model its own write failed.
  // It then re-creates the file, doubts the tools, and eventually concludes it
  // cannot reach the filesystem at all — issue #32.
  //
  // Merges every pending path under the listed directory: deleted entries are
  // skipped (exists() reports them gone, so the listing must agree).
  mergeIntoListing(abs, names) {
    for (const [key, value] of this.map) {
      if (value === DELETED) continue;
      const rel = path.relative(abs, key);
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue;
      const [first, ...rest] = rel.split(path.sep);
      names.add(rest.length ? `${first}/` : first);
    }
    // A helper's listing must also carry what the parent staged: a file the
    // parent just created exists in the run's view, even if not on disk yet.
    this.base?.mergeIntoListing(abs, names);
  }

  /**
   * One record per pending path: before/after text, a unified diff and counts.
   * `accepted` defaults to every entry; the desktop UI flips individual files
   * off before applying, so an agent edit can be taken file by file.
   */
  changes() {
    const out = [];
    for (const abs of this.map.keys()) out.push(this.changeFor(abs));
    return out;
  }

  /**
   * One pending path's record, the shape changes() lists — so asking for a
   * single file's diff does not diff every other staged file on the way.
   */
  changeFor(abs) {
    const next = this.map.get(abs);
    if (next === undefined) return null;
    let stamp = 'gone';
    try { const st = fs.statSync(abs); stamp = `${st.mtimeMs}:${st.size}`; } catch { /* missing */ }
    const hit = this.changeMemo.get(abs);
    if (hit && hit.next === next && hit.stamp === stamp) return hit.record;
    const before = this.diskText(abs);
    const deleted = next === DELETED;
    const after = deleted ? '' : next;
    const diff = unifiedDiff(before, after) + (deleted && !before ? '' : '');
    let added = 0;
    let removed = 0;
    for (const line of diff.split('\n')) {
      if (line.startsWith('+') && !line.startsWith('+++')) added++;
      else if (line.startsWith('-') && !line.startsWith('---')) removed++;
    }
    const record = {
      file: posix(path.relative(this.root, abs)),
      abs,
      before,
      after,
      deleted,
      isNew: !before,
      added,
      removed,
      diff,
    };
    this.changeMemo.set(abs, { next, stamp, record });
    return record;
  }

  /** Write the accepted subset to disk. Returns what was written. */
  applyToDisk(accepted) {
    const keep = new Set(accepted ?? this.keys());
    let written = 0;
    let deleted = 0;
    const files = [];
    for (const [abs, text] of this.map) {
      if (!keep.has(abs)) continue;
      if (text === DELETED) {
        if (fs.existsSync(abs)) { fs.unlinkSync(abs); deleted++; }
      } else {
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        // Temp file plus rename in the same directory: a crash mid-apply
        // leaves the old file or the new one, never a half-written user file
        // — and nothing here keeps a backup, the overlay is it. An existing
        // file's mode is the one thing a replacement would otherwise change
        // (the exec bit on a script must survive the swap), so it is read
        // and pinned on the temp before the rename.
        let mode = null;
        try { mode = fs.statSync(abs).mode & 0o777; } catch { /* a new file */ }
        writeFileAtomic(abs, text, { mode });
        written++;
      }
      files.push(posix(path.relative(this.root, abs)));
    }
    return { written, deleted, files };
  }
}
