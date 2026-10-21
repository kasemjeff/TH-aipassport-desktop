// The trace store: the raw transcripts, read as they were written.
//
// Meta-Harness's one hard lesson: the optimizer must read the RAW trace, not
// a summary of it. A summary drops the exact wording that made the
// difference, and on a bad run the wording IS the bug. So nothing here
// rewrites a trace: the index is a view for scanning, the JSONL on disk
// stays the source of truth, and every excerpt carries its file and line so
// the original is one read away.
//
// The same rule governs compaction elsewhere in this harness (Scroll's
// "compaction is a view, the original must be recoverable"): a summary that
// replaces the original is a loss, not a compaction. This module therefore
// never writes over a trace and never returns a paraphrase of one.
import fs from 'node:fs/promises';
import path from 'node:path';
import { aipassHome } from '../settings.mjs';

/** Where the sessions live. `AIPASS_HOME` is the switch every surface reads. */
const sessionsRoot = (home = aipassHome()) => path.join(home, 'sessions');

/**
 * Every session file under the sessions root, newest first.
 *
 * The walk is two levels deep by construction: `<root-slug>/session-<id>.jsonl`.
 * A slug is a path with the separators replaced, so the depth is fixed and
 * the walk cannot run away.
 */
export async function listTraces({ home = aipassHome(), limit = 50 } = {}) {
  const root = sessionsRoot(home);
  let projects;
  try {
    projects = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const dir = path.join(root, project.name);
    let files;
    try {
      files = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.isFile() || !file.name.startsWith('session-') || !file.name.endsWith('.jsonl')) continue;
      const full = path.join(dir, file.name);
      const stat = await fs.stat(full).catch(() => null);
      if (!stat) continue;
      out.push({
        file: full,
        id: file.name.slice('session-'.length, -'.jsonl'.length),
        project: project.name,
        bytes: stat.size,
        mtime: stat.mtimeMs,
      });
    }
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out.slice(0, limit);
}

/**
 * Read a trace. The raw text comes back with it: `raw` is the file's bytes as
 * text, `lines` is that text split — the excerpts below are slices of it, not
 * reconstructions.
 */
export async function readTrace(file) {
  const raw = await fs.readFile(file, 'utf8');
  const lines = raw.split('\n');
  const entries = [];
  const bad = [];
  lines.forEach((line, i) => {
    const text = line.trim();
    if (!text) return;
    try {
      const entry = JSON.parse(text);
      if (entry && typeof entry === 'object') entries.push(entry);
      else bad.push(i + 1);
    } catch {
      bad.push(i + 1);
    }
  });
  const header = entries.find((e) => e.type === 'header') ?? null;
  return { file, raw, lines, entries, bad, header };
}

/**
 * A trace's view: the numbers a scan needs. This is a VIEW — it never
 * replaces the trace, and every field here can be recomputed from the raw
 * file. `trace.file` is the way back to the original.
 */
export function traceView(trace) {
  const entries = trace.entries ?? [];
  const header = trace.header ?? {};
  const tools = entries.filter((e) => e.type === 'tool');
  const byKind = {};
  const repeats = new Map();
  for (const tool of tools) {
    const kind = String(tool.kind ?? '?');
    byKind[kind] = (byKind[kind] ?? 0) + 1;
    const key = `${kind} ${String(tool.arg ?? '').trim()}`;
    repeats.set(key, (repeats.get(key) ?? 0) + 1);
  }
  const failed = tools.filter((t) => t.ok === false);
  const stats = [...entries].reverse().find((e) => e.type === 'run_stats') ?? null;
  const task = entries.find((e) => e.type === 'task') ?? null;
  const lastAssistant = [...entries].reverse().find((e) => e.type === 'assistant' && String(e.text ?? '').trim()) ?? null;
  const compactions = entries.filter((e) => e.type === 'compaction').length;
  return {
    file: trace.file,
    id: header.id ?? null,
    root: header.root ?? null,
    model: header.model ?? null,
    app: header.app ?? null,
    created: header.created ?? null,
    updated: header.updated ?? null,
    task: task?.text ? String(task.text) : null,
    lastWords: lastAssistant ? String(lastAssistant.text) : null,
    tools: tools.length,
    byKind,
    failedTools: failed.length,
    repeated: [...repeats.entries()].filter(([, n]) => n > 1).map(([key, n]) => ({ key, n })),
    stopReason: stats?.stopReason ?? null,
    steps: stats?.steps ?? null,
    turns: stats?.turns ?? null,
    spent: stats?.spent ?? null,
    compactions,
    entries: entries.length,
  };
}

/**
 * The raw lines of a trace that match a pattern, with their line numbers.
 *
 * The excerpt is verbatim: the same bytes the file holds, so what the
 * optimizer reads is what the model saw. `kind` narrows the search to one
 * entry type without touching the text.
 */
export function grepTrace(trace, { pattern = null, kind = null, limit = 60, flags = 'i' } = {}) {
  const re = pattern ? new RegExp(pattern, flags) : null;
  const hits = [];
  const lines = trace.lines ?? [];
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i];
    if (!text.trim()) continue;
    if (kind) {
      let entry = null;
      try { entry = JSON.parse(text); } catch { /* a bad line is still a line */ }
      if (!entry || entry.type !== kind) continue;
    }
    if (re && !re.test(text)) continue;
    hits.push({ line: i + 1, text });
    if (hits.length >= limit) break;
  }
  return { file: trace.file, hits, total: hits.length };
}

/**
 * The failure lines of a trace, verbatim. Rule 3 of the root guide: a tool
 * failure starts with `err:` — so the failures are findable by that one word,
 * and this is where the optimizer's evidence comes from.
 */
export function failureLines(trace, { limit = 40 } = {}) {
  const out = [];
  const lines = trace.lines ?? [];
  for (let i = 0; i < lines.length; i++) {
    if (!/err:/i.test(lines[i])) continue;
    out.push({ line: i + 1, text: lines[i] });
    if (out.length >= limit) break;
  }
  return out;
}
