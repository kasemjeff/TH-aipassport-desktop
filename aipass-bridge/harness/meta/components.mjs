// The harness, cut into six components.
//
// MemoHarness splits a harness into six dimensions and tunes them per case;
// AHE splits it into files and edits one at a time, keeping the change only
// when the score moves. This is that cut for THIS harness: every dimension
// names the policy document an optimizer may edit, and the source files it
// must read before editing it.
//
// The source list is not a formality. Meta-Harness has the optimizer read the
// harness's own code — not a summary of it — because a summary drops the
// exact wording that decides the behavior, and the wording is often the
// bug. So a component names files, and the brief that reaches the optimizer
// quotes them with their digests.
//
// The code here is read-only ground. A dimension's policy may add a rule; it
// cannot change what the code does. That is the honest split: prose steers,
// code decides.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HARNESS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_DIR = path.resolve(HARNESS_DIR, '..', '..');

/**
 * The six components. `sources` are relative to the repository root and are
 * the files an optimizer must read to judge the dimension; `decides` is the
 * question the dimension answers, in one line, so the brief can state what a
 * change is allowed to be about.
 */
export const COMPONENTS = [
  {
    id: 'generation',
    title: 'How the model is instructed',
    decides: 'What the model is told before it starts: the protocol, the language, the shape of an answer.',
    sources: [
      { rel: 'aipass-bridge/harness/protocol.mjs', why: 'the preamble — the first message, and the only system prompt this harness has' },
      { rel: 'aipass-bridge/harness/loop.mjs', why: 'the end-of-turn reminder and the nudges' },
      { rel: 'aipass-bridge/harness/lang.mjs', why: 'the Thai share of a reply, and the language nudge' },
    ],
  },
  {
    id: 'tool',
    title: 'What the model may do',
    decides: 'Which markers exist, how a tool result is read, and what a tool call is allowed to touch.',
    sources: [
      { rel: 'aipass-bridge/harness/tools.mjs', why: 'the marker tools and their result shape' },
      { rel: 'aipass-bridge/harness/permissions.mjs', why: 'the permission gate every write and shell call rides' },
    ],
  },
  {
    id: 'context',
    title: 'What the model still sees',
    decides: 'What survives a long conversation: compaction, elision, and the tool-result budget.',
    sources: [
      { rel: 'aipass-bridge/harness/compact.mjs', why: 'the compactor, the seed, the token estimate' },
      { rel: 'aipass-bridge/harness/settings.mjs', why: 'the context budget the compaction rides' },
    ],
  },
  {
    id: 'memory',
    title: 'What carries over',
    decides: 'Which facts survive a rotation, a session or a compaction.',
    sources: [
      { rel: 'aipass-bridge/harness/memory-store.mjs', why: 'the cross-session fact store' },
      { rel: 'aipass-bridge/harness/compact.mjs', why: 'the within-session memory tier' },
    ],
  },
  {
    id: 'orchestration',
    title: 'How the run is driven',
    decides: 'The steps, the stops, the stagnation guard, the sandbox a run lives in.',
    sources: [
      { rel: 'aipass-bridge/harness/loop.mjs', why: 'the run loop and its guards' },
      { rel: 'aipass-bridge/harness/sandbox.mjs', why: 'the projection a run edits in' },
    ],
  },
  {
    id: 'output',
    title: 'How an answer is judged',
    decides: 'What counts as done, what a DONE needs behind it, and how a claim is checked.',
    sources: [
      { rel: 'aipass-bridge/harness/loop.mjs', why: 'the DONE checker and the verification nudge' },
      { rel: 'aipass-bridge/harness/protocol.mjs', why: 'the DONE contract the model is held to' },
      { rel: 'docs/SPEC_CHECKER.md', why: 'the checker, as designed' },
    ],
  },
];

const byId = new Map(COMPONENTS.map((c) => [c.id, c]));

export const componentById = (id) => byId.get(id) ?? null;

/** The absolute path of a source file named in a component. */
export const sourcePath = (rel) => path.join(REPO_DIR, rel);

/**
 * A file's digest and size. The brief carries these so a reader can tell
 * whether the file it read is the file the brief was written against.
 */
export function sourceDigest(rel) {
  const file = sourcePath(rel);
  try {
    const bytes = fs.readFileSync(file);
    return {
      rel,
      file,
      bytes: bytes.length,
      lines: bytes.toString('utf8').split('\n').length,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 16),
    };
  } catch (err) {
    return { rel, file, bytes: 0, lines: 0, sha256: null, error: String(err.message ?? err) };
  }
}

/**
 * A file's outline: the exported names and the section banners, with their
 * line numbers. It is a VIEW of the source, not a substitute for it — the
 * optimizer that wants the real thing opens the file, and the brief says so.
 */
export function sourceOutline(rel, { limit = 60 } = {}) {
  const file = sourcePath(rel);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return { rel, file, error: String(err.message ?? err), entries: [] };
  }
  const entries = [];
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    const trimmed = line.trim();
    const isExport = /^export\s+(const|function|class|default|async function)/.test(trimmed);
    const isBanner = /^\/\/ ─{2,}/.test(trimmed);
    if (!isExport && !isBanner) return;
    const name = isExport
      ? (/^export\s+(?:const|function|class|async function)\s+([A-Za-z0-9_]+)/.exec(trimmed) ?? [])[1]
      : trimmed.replace(/^\/\/\s*[─\s]*/, '').slice(0, 80);
    if (!name) return;
    entries.push({ line: i + 1, name });
  });
  return { rel, file, entries: entries.slice(0, limit), total: entries.length };
}
