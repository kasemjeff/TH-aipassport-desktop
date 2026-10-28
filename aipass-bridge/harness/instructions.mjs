// The project's own standing instructions: the file an agent finds at the
// root and is expected to read before touching anything.
//
// Every peer harness loads one of these into the model's first message
// (codex and opencode: AGENTS.md; Claude Code: CLAUDE.md; Gemini CLI:
// GEMINI.md). This module keeps the smallest version that is still useful:
// one file at the run's root, a byte budget, and no directory walk.
//
// The root is the boundary the run already keeps. A file above it, or a link
// that points above it, is not read -- a project can hand the model its own
// conventions, never the machine's other files.
//
// The text is project content, not a new protocol: the preamble says whose
// instructions they are and that they lose to the task and the permission
// rules. The switch is AIPASS_INSTRUCTIONS=off.
import fs from 'node:fs';
import path from 'node:path';

// The order peers use, newest convention first. Only one is read: a project
// that keeps both AGENTS.md and CLAUDE.md usually has the second import the
// first, and pasting both would say everything twice.
export const INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md'];
export const DEFAULT_MAX_BYTES = 8_000;

const disabled = () => /^(0|off|false|no)$/i.test(String(process.env.AIPASS_INSTRUCTIONS ?? '').trim());

const budget = () => {
  const n = Number(process.env.AIPASS_INSTRUCTIONS_MAX_BYTES);
  return Number.isFinite(n) && n >= 256 ? Math.min(64_000, Math.round(n)) : DEFAULT_MAX_BYTES;
};

/** Is `file` inside `root`? Lexical, after both were resolved. */
const inside = (root, file) => {
  const rel = path.relative(root, file);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

/**
 * The project's instruction file, read and bounded.
 *
 * @param {string} root the run's project root
 * @param {{ max?: number, enabled?: boolean }} [opts]
 * @returns {{ file: string, text: string, bytes: number, read: number, truncated: boolean } | null}
 *   null when the switch is off, no candidate exists, or the file is empty or
 *   resolves outside the root.
 */
export function loadProjectInstructions(root, opts = {}) {
  const enabled = opts.enabled ?? !disabled();
  const max = opts.max ?? budget();
  if (!enabled || !root) return null;

  const base = path.resolve(root);
  let file = null;
  let name = null;
  for (const candidate of INSTRUCTION_FILES) {
    const full = path.join(base, candidate);
    if (!fs.existsSync(full)) continue;
    file = full;
    name = candidate;
    break;
  }
  if (!file) return null;

  let realRoot;
  let real;
  try {
    realRoot = fs.realpathSync(base);
    real = fs.realpathSync(file);
  } catch {
    return null;
  }
  if (!inside(realRoot, real)) return null;

  let bytes = 0;
  try { bytes = fs.statSync(real).size; } catch { return null; }
  if (bytes === 0) return null;

  // Read at most the budget: a 200 MB file is still a 200 MB file, and the
  // backend serves every window call on this thread.
  let text = '';
  let read = 0;
  const fd = fs.openSync(real, 'r');
  try {
    const buf = Buffer.alloc(Math.min(max, bytes));
    read = fs.readSync(fd, buf, 0, buf.length, 0);
    text = buf.subarray(0, read).toString('utf8').replace(/^\uFEFF/, '');
  } finally {
    fs.closeSync(fd);
  }

  // A cut in the middle of a line reads as a different rule.
  let truncated = bytes > read;
  if (truncated) {
    const cut = text.lastIndexOf('\n');
    if (cut > 0) {
      text = text.slice(0, cut);
      read = Buffer.byteLength(text, 'utf8');
    }
    truncated = text.trim().length > 0;
  }
  text = text.trim();
  if (!text) return null;

  // shortcut: root-level instruction file only; walk nested AGENTS.md files
  // when a monorepo's subprojects need their own rules.
  return { file: name, text, bytes, read, truncated };
}
