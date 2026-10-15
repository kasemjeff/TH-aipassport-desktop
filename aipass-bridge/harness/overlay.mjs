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
export const DELETED = '\x00DELETE\x00';

// Paths that go to the model come back from it, in a NEED file or an EDIT. On
// Windows path.relative yields `src\a.ts`, so normalise to one separator
// everywhere rather than teaching the model two shapes.
export const posix = (p) => p.split(path.sep).join('/');

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
  constructor(root, { clip = (s) => s } = {}) {
    this.root = path.resolve(root);
    this.map = new Map();
    this.clip = clip;
  }

  get size() { return this.map.size; }

  safe(p) {
    const abs = path.resolve(this.root, p);
    if (abs !== this.root && !abs.startsWith(this.root + path.sep)) throw new Error(`path escapes root: ${p}`);
    return abs;
  }

  /** Resolve a model-supplied path, or null when it escapes the root. */
  trySafe(p) {
    try { return this.safe(p); } catch { return null; }
  }

  has(abs) { return this.map.has(abs); }
  isDeleted(abs) { return this.map.get(abs) === DELETED; }
  keys() { return [...this.map.keys()]; }
  entries() { return [...this.map.entries()]; }

  set(abs, content) { this.map.set(abs, content); }
  markDeleted(abs) { this.map.set(abs, DELETED); }
  discard(abs) { this.map.delete(abs); }
  clear() { this.map.clear(); }

  readAt(abs) {
    if (this.map.has(abs)) {
      const val = this.map.get(abs);
      if (val === DELETED) throw new Error(`file was deleted: ${posix(path.relative(this.root, abs))}`);
      return val;
    }
    return fs.readFileSync(abs, 'utf8');
  }

  existsAt(abs) {
    if (this.map.has(abs)) return this.map.get(abs) !== DELETED;
    return fs.existsSync(abs);
  }

  /** Bytes currently on disk, ignoring the overlay. */
  diskText(abs) { return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : ''; }

  // A file the agent has written this run is readable by `read` and reported by
  // `exists`, so a listing that omits it tells the model its own write failed.
  // It then re-creates the file, doubts the tools, and eventually concludes it
  // cannot reach the filesystem at all — issue #32.
  mergeIntoListing(abs, names) {
    const rel = path.relative(abs, this.root);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return;
    const [first, ...rest] = rel.split(path.sep);
    names.add(rest.length ? `${first}/` : first);
  }

  /**
   * One record per pending path: before/after text, a unified diff and counts.
   * `accepted` defaults to every entry; the desktop UI flips individual files
   * off before applying, so an agent edit can be taken file by file.
   */
  changes() {
    const out = [];
    for (const [abs, next] of this.map) {
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
      out.push({
        file: posix(path.relative(this.root, abs)),
        abs,
        before,
        after,
        deleted,
        isNew: !before,
        added,
        removed,
        diff,
      });
    }
    return out;
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
        fs.writeFileSync(abs, text);
        written++;
      }
      files.push(posix(path.relative(this.root, abs)));
    }
    return { written, deleted, files };
  }
}
