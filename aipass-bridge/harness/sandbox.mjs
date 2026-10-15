// A child-visible projection of the pending tree, for the length of one RUN.
//
// The overlay is invisible to a child process by design — that is what makes
// "nothing on disk until apply" true — but it also made RUN a liar: a model
// that staged a fix and ran the check to verify it read the stale disk copy,
// saw the old failure, and concluded the save had failed (the smoke run of
// 2026-10-15). The fix keeps every invariant and makes the check real: before
// a RUN executes, the tree is projected into a throwaway copy under
// `.aipass/run/` with the staged edits written in, the command runs there, and
// the copy is deleted. Nothing is ever written to the real paths.
//
// Source files are copied — they are small, and a copy means a command that
// writes in place cannot touch the real file. Heavy directories (node_modules,
// .git, build outputs) are junctions: the same bytes in any worktree, and
// copying them would turn a two-second check into a minute. A write through a
// junction is exactly the write a RUN on the real tree would have done. The
// sandbox sits inside the project so every path in a stack trace still points
// into the project; restorePaths() puts the project root back in the output.
import fs from 'node:fs';
import path from 'node:path';
import { SKIP } from './overlay.mjs';

// Directories that are junctioned instead of copied. `.aipass` is excluded
// below: it holds the spill directory and the sandbox itself, and a run has no
// business walking either.
const HEAVY = new Set([...SKIP].filter((name) => name !== '.aipass'));

/** A fresh sandbox directory for one RUN. */
export function createSandbox(root) {
  const runRoot = path.join(root, '.aipass', 'run');
  fs.mkdirSync(runRoot, { recursive: true });
  return fs.mkdtempSync(path.join(runRoot, 'run-'));
}

/**
 * Project the tree at `root` into `dest`, overlay applied:
 *   - every staged path (except deletes) is written as its staged content
 *   - everything else is copied, except HEAVY dirs, which are junctioned
 *     unless a staged edit lives inside them
 *   - `.aipass` never enters the projection
 */
export function materializeTree(root, overlay, dest) {
  const staged = overlay.keys();
  const underStaged = (abs) => staged.some((p) => p.startsWith(abs + path.sep));

  // Staged paths first, creation order: a staged new file whose directory does
  // not exist on disk yet still has to appear.
  for (const abs of staged) {
    const rel = path.relative(root, abs);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue; // outside the tree
    const target = path.join(dest, rel);
    if (overlay.isDeleted(abs)) continue; // deleted for this run: not projected
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, overlay.readAt(abs));
  }

  const skip = new Set(staged);
  const walk = (srcDir, dstDir) => {
    fs.mkdirSync(dstDir, { recursive: true });
    let entries;
    try { entries = fs.readdirSync(srcDir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === '.aipass') continue;
      const src = path.join(srcDir, e.name);
      const dst = path.join(dstDir, e.name);
      if (skip.has(src)) continue; // projected already
      if (e.isDirectory()) {
        if (HEAVY.has(e.name) && !underStaged(src)) {
          try { fs.symlinkSync(src, dst, 'junction'); continue; } catch { /* copy instead */ }
        }
        walk(src, dst);
        continue;
      }
      if (e.isFile()) { fs.copyFileSync(src, dst); continue; }
      // Symlinks and anything exotic: recreate what it points at, the cheapest
      // honest shape. A broken link is left out.
      try {
        const target = path.resolve(srcDir, fs.readlinkSync(src));
        if (fs.statSync(target).isDirectory()) fs.symlinkSync(target, dst, 'junction');
        else fs.copyFileSync(target, dst);
      } catch { /* left out */ }
    }
  };
  walk(root, dest);
  return dest;
}

/**
 * Put the project root back into the run's own output, so a stack trace reads
 * `D:\proj\check.mjs:5` rather than naming a throwaway directory the model has
 * never seen. Both separator shapes appear in the wild — raw paths and
 * file:/// URLs — so both are swapped, case-insensitively on Windows. This
 * also keeps identical commands byte-identical across steps: without it, every
 * repeat would carry a fresh sandbox name and the stagnation guard (R1) could
 * not recognize the repeat.
 */
export function restorePaths(text, from, to) {
  if (!text) return text;
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const swap = (a, b) => {
    const replacement = b.replace(/\$/g, '$$$$'); // a literal string, not $1 groups
    text = text.replace(new RegExp(esc(a), 'gi'), replacement);
  };
  swap(from, to);
  swap(from.split(path.sep).join('/'), to.split(path.sep).join('/'));
  return text;
}
