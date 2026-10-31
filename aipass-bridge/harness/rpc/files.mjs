// The files domain: the tree, the files, the attachments and the index.
//
// Everything here answers a question the person is asking ("what is in this
// folder", "open that file", "find the thing that says X"), and everything
// here is confined to the project: a path that escapes answers `err:` and
// touches nothing.
import fs from 'node:fs';
import path from 'node:path';
import { binaryKind } from '../overlay.mjs';
import { listSymbols, findDefinition, findReferences } from '../symbols.mjs';
import { status as retrievalStatus, clearIndex as retrievalClear } from '../retrieval.mjs';import { fuzzyMatch } from '../fuzzy.mjs';
import { restoreTable } from '../waf.mjs';
import { openBrowser } from '../browser.mjs';
import { aipassHome } from '../settings.mjs';
// Installing and removing a playbook is a person's act, not a run's: the
// overlay never sees it, and the only writable libraries are the two known ones.
import { installSkill, removeSkill } from '../skills.mjs';
// The undo of an apply (harness/checkpoints.mjs): the store lives outside the
// project, so nothing here writes inside it.
import { list as listCheckpoints, restore as restoreCheckpoint, remove as removeCheckpoint } from '../checkpoints.mjs';

/** The most a file the window opens may weigh. */
const MAX_FILE_READ = 1_000_000;

/** The biggest file a search reads. A 4 MB log is not where the answer is. */
const MAX_GREP_FILE = 512 * 1024;

/**
 * The files methods of the backend.
 *
 * @param {import('./context.mjs').RpcContext} ctx the shared backend state
 */
export function createFilesMethods(ctx) {
  const {
    appSettings,
    staged,
    targetFor,
    stageAttachment,
    dropAttachment,
    fileIndex,
    dropIndex,
    root,
    model,
  } = ctx;

  return {

    /* ---------------------------------------------------------- attachments */

    async 'attachment.stage'(params = {}) {
      const h = targetFor(params);
      return stageAttachment(params, h.root);
    },
    async 'attachment.list'() { return [...staged.values()]; },
    async 'attachment.remove'(params = {}) { dropAttachment(params.id); return { ok: true }; },

    /* ----------------------------------------------------------- checkpoints */

    /**
     * The checkpoints of this project — what an apply can be taken back from.
     *
     * The store lives OUTSIDE the project (root rule 1), so listing it never
     * touches the tree the person is looking at.
     */
    async 'checkpoints.list'(params = {}) {
      const h = targetFor(params);
      const checkpoints = listCheckpoints({ root: h.root });
      return {
        root: h.root,
        checkpoints: checkpoints.map((c) => ({
          id: c.id,
          createdAt: c.createdAt,
          files: (c.files ?? []).map((f) => ({ path: f.path, deleted: Boolean(f.deleted) })),
        })),
      };
    },

    /** Put a checkpoint's files back as they were. */
    async 'checkpoints.restore'(params = {}) {
      const h = targetFor(params);
      const id = String(params.id ?? '').trim();
      if (!id) throw new Error('which checkpoint? — /checkpoints restore <id>');
      // The tree just changed: the index of it is a picture of the past.
      dropIndex(h.overlay.trySafe('.'));
      return restoreCheckpoint({ root: h.root, id });
    },

    /** Forget a checkpoint without restoring it. */
    async 'checkpoints.remove'(params = {}) {
      const h = targetFor(params);
      const id = String(params.id ?? '').trim();
      if (!id) throw new Error('which checkpoint? — /checkpoints remove <id>');
      return removeCheckpoint({ root: h.root, id });
    },

    /* -------------------------------------------------------------- browser */

    async 'browser.open'(params = {}) { return { ok: await openBrowser(params.url ?? appSettings.get('chatUrl')) }; },
  async 'shell.reveal'(params = {}) {
    const target = params.path ?? params.target;
    if (!target || typeof target !== 'string') return { ok: false, reason: 'no path' };
    const { spawn } = await import('node:child_process');
    const platform = process.platform;
    try {
      if (platform === 'win32') spawn('explorer.exe', [target], { detached: true, stdio: 'ignore' }).unref();
      else if (platform === 'darwin') spawn('open', [target], { detached: true, stdio: 'ignore' }).unref();
      else spawn('xdg-open', [target], { detached: true, stdio: 'ignore' }).unref();
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: err?.message ?? String(err) };
    }
  },
  async 'extension.install'() {
    // Zero-cost distribution: the extension ships inside the installer, and
    // the same tree is downloadable from the GitHub repo (Code -> Download
    // ZIP) for machines that only want the extension. Open that page so the
    // person can grab it without a store listing or a clone.
    const url = 'https://github.com/kasemjeff/aipass';
    try { await openBrowser(url); } catch { /* fall through — the url is still returned */ }
    return { ok: true, url };
  },

    /* ------------------------------------------------------------------ waf */

    /**
     * The restore table, as data.
     *
     * The window shows the real text behind the wire spellings — the URLs a
     * search brought back are `HTTPS-URL…` until somebody puts them back. It
     * must show the SAME text the model saw, so it rebuilds these rules from
     * this table instead of keeping a copy of them: one table, one owner.
     */
    async 'waf.table'() { return { pairs: restoreTable() }; },

    /* ------------------------------------------------------------- symbols */

    /**
     * The declarations of a file, the definition of a name, the places a name
     * is used.
     *
     * The same index the SYMBOLS/DEF/REFS markers use, asked for from the
     * window instead of from a run. The walk skips the heavy directories and
     * the index is cached under the state home, so a second ask is cheap.
     */
    async 'symbols.list'(params = {}) {
      const h = targetFor(params);
      const file = String(params.file ?? '').trim();
      if (!file) throw new Error('which file? — /symbols <file>');
      const rel = path.isAbsolute(file) ? path.relative(h.root, file) : file;
      // A path outside the project is not in the index, so it has no symbols —
      // the same answer the SYMBOLS marker gives, and no way out of the root.
      return { file: rel.replace(/\\/g, '/'), symbols: listSymbols(h.root, rel) };
    },
    async 'symbols.def'(params = {}) {
      const h = targetFor(params);
      const name = String(params.name ?? '').trim();
      if (!name) throw new Error('which name? — /symbols <name>');
      return { name, definitions: findDefinition(h.root, name) };
    },
    async 'symbols.refs'(params = {}) {
      const h = targetFor(params);
      const name = String(params.name ?? '').trim();
      if (!name) throw new Error('which name? — /symbols <name>');
      return { name, references: findReferences(h.root, name) };
    },

    async 'retrieval.status'(params = {}) {
      const h = targetFor(params);
      return retrievalStatus(h.root);
    },
    async 'retrieval.clear'(params = {}) {
      const h = targetFor(params);
      retrievalClear(h.root);
      return { cleared: true };
    },

    /* -------------------------------------------------------------- skills */

    async 'skills.list'(params = {}) { return targetFor(params).skills.list(); },
    async 'skills.index'(params = {}) { return { index: targetFor(params).skills.index() }; },
    async 'skills.load'(params = {}) {
      const found = targetFor(params).skills.load(params.name);
      if (found.error) throw new Error(found.error);
      return found;
    },
    async 'skills.install'(params = {}) {
      const h = targetFor(params);
      return installSkill({ root: h.root, name: params.name, text: params.text, target: params.target, overwrite: Boolean(params.overwrite) });
    },
    async 'skills.remove'(params = {}) {
      const h = targetFor(params);
      return removeSkill({ root: h.root, name: params.name, target: params.target });
    },

    /* ----------------------------------------------------------------- fs */

    async 'fs.list'(params = {}) {
      const h = targetFor(params);
      const dir = h.overlay.trySafe(params.dir ?? '.');
      if (!dir) throw new Error(`outside project root: ${params.dir ?? '.'}`);
      // A panel click on a directory with thousands of entries: the async read
      // keeps the event loop free for the run's own stream while it fills.
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });
      const kept = entries.map((e) => ({ name: e.name, dir: e.isDirectory() }))
        .filter((e) => !['node_modules', '.git', '.next', 'dist', 'build', '.cache'].includes(e.name));
      // The window shows a file's size and age in its row: a list of names
      // alone makes you open every file to learn whether it matters. One lstat
      // per entry, async, so a folder with hundreds of files does not freeze
      // the run that is streaming next to it.
      await Promise.all(kept.map(async (e) => {
        if (e.dir) return;
        try {
          // lstat, not stat: a link out of the project is not followed, and the
          // listing already calls a link a file.
          const st = await fs.promises.lstat(path.join(dir, e.name));
          e.size = st.size;
          e.mtime = st.mtimeMs;
        } catch { /* gone between the readdir and the stat */ }
      }));
      return kept;
    },
    async 'fs.search'(params = {}) {
      const h = targetFor(params);
      const query = String(params.query ?? '').trim();
      if (!query) return [];
      const base = h.overlay.trySafe('.');
      if (!base) throw new Error('outside project root: .');
      const limit = Math.min(Math.max(Number(params.limit ?? 120) || 120, 1), 300);
      const entries = await fileIndex(h, base);
      // The word is matched against the PATH, so "docs/b" finds the file
      // under docs/ and "apjs" finds app.js — and the score says which of the
      // matches is the one the reader meant.
      const scored = [];
      for (const e of entries) {
        const m = fuzzyMatch(query, e.path);
        if (!m) continue;
        scored.push({ ...e, score: m.score, hits: m.hits });
      }
      scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path, 'th'));
      return scored.slice(0, limit);
    },
    async 'fs.grep'(params = {}) {
      const h = targetFor(params);
      const query = String(params.query ?? '').trim();
      if (!query) return [];
      const base = h.overlay.trySafe('.');
      if (!base) throw new Error('outside project root: .');
      const limit = Math.min(Math.max(Number(params.limit ?? 60) || 60, 1), 200);
      const perFile = Math.min(Math.max(Number(params.perFile ?? 5) || 5, 1), 20);
      const entries = await fileIndex(h, base);
      const needle = query.toLowerCase();
      const out = [];
      for (const e of entries) {
        if (out.length >= limit) break;
        if (e.dir) continue;
        // A big file is not read for a search: the answer is somewhere else.
        if (e.size > MAX_GREP_FILE) continue;
        let text;
        try {
          const abs = path.join(base, e.path);
          text = h.overlay.has(abs) ? h.overlay.readAt(abs) : await fs.promises.readFile(abs, 'utf8');
        } catch { continue; }
        if (text.includes('\u0000')) continue; // binary
        let found = 0;
        const lines = text.split('\n');
        for (let i = 0; i < lines.length && out.length < limit && found < perFile; i++) {
          // The line is trimmed for reading, so the place of the word in it
          // is found in the trimmed text — the window picks the word out with
          // that number, and it has to point at the right character.
          const trimmed = lines[i].trim();
          const at = trimmed.toLowerCase().indexOf(needle);
          if (at === -1) continue;
          found++;
          // The window around the word, so the answer is visible and not a
          // line of a thousand characters.
          const from = Math.max(0, at - 60);
          out.push({
            path: e.path,
            line: i + 1,
            text: trimmed.slice(from, from + 240),
            at: at - from,
          });
        }
      }
      return out;
    },
    async 'fs.read'(params = {}) {
      const h = targetFor(params);
      const abs = h.overlay.trySafe(params.file);
      if (!abs) throw new Error(`outside project root: ${params.file}`);
      if (!h.overlay.existsAt(abs)) throw new Error('no such file');
      // A binary file is not text: read as UTF-8 it is mojibake, and it costs
      // a whole answer's worth of bytes on the wire. The tool layer refuses
      // the same files for the model; the window refuses them for the reader.
      const kind = binaryKind(abs, (p) => h.overlay.has(p));
      if (kind) {
        throw new Error(`${params.file} is ${kind === 'binary' ? 'a binary file' : `a ${kind} file`}, not text`);
      }
      const staged = h.overlay.has(abs);
      const size = staged
        ? Buffer.byteLength(h.overlay.readAt(abs), 'utf8')
        : (await fs.promises.stat(abs)).size;
      if (size > MAX_FILE_READ) {
        throw new Error(`${params.file} is too large to open (${Math.round(size / 1024)} KB, cap ${Math.round(MAX_FILE_READ / 1024)} KB)`);
      }
      const text = staged ? h.overlay.readAt(abs) : await fs.promises.readFile(abs, 'utf8');
      return { file: params.file, text };
    },
  };
}

export default createFilesMethods;
