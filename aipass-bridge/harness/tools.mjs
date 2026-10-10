// The tools the model can drive: everything from reading a file to running
// shell, implemented as one function per marker shape. String in, string out —
// no JSON, no streaming, because the model writes them as prose lines.
//
// Every write goes to the overlay, never to disk; the run applies the overlay
// when the person (or `--apply`) says so. This factory exists so the same
// implementations serve the CLI and the desktop harness — the original agent
// had two copies that had already drifted apart.
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { SKIP, binaryKind, posix, stripGutter } from './overlay.mjs';
import { outbound, inbound } from './waf.mjs';

export function createTools(ctx) {
  const {
    root,
    overlay,
    skills,
    allowRun = false,
    maxResult = 3000,
    readLines = 250,
    bridge = null,
    model = null,
    onReasoning = () => {},
    log = () => {},
  } = ctx;

  const clip = (s) => (s.length > maxResult ? `${s.slice(0, maxResult)}\n… truncated` : s);
  const safe = (p) => overlay.safe(p);
  const existsAt = (abs) => overlay.existsAt(abs);
  const readAt = (abs) => overlay.readAt(abs);

  const TOOLS = {
    // SKILL list (or bare SKILL) prints the library index; SKILL name-part
    // returns one playbook part verbatim. Names are whitelisted, so this is a
    // read-only window onto the library — never a path traversal.
    skill(arg) {
      const found = skills.load(arg);
      if (found.error) return found.error;
      return found.text;
    },
    list(arg) {
      const abs = safe(arg || '.');
      const names = new Set(
        (fs.existsSync(abs) ? fs.readdirSync(abs, { withFileTypes: true }) : [])
          .filter((e) => !SKIP.has(e.name))
          .map((e) => (e.isDirectory() ? `${e.name}/` : e.name)));
      // A file the agent has written this run is readable by `read` and reported
      // by `exists`, so a listing that omits it tells the model its own write
      // failed — issue #32.
      for (const pending of overlay.keys()) overlay.mergeIntoListing(abs, names);
      return clip([...names].sort().join('\n') || '(empty)');
    },
    read(arg) {
      // Accept an optional trailing line range, e.g. `NEED file src/app.ts 200-320`.
      const parts = String(arg).trim().split(/\s+/);
      let range = null;
      if (parts.length > 1 && /^\d+-\d+$/.test(parts.at(-1))) {
        const [a, b] = parts.pop().split('-').map(Number);
        range = [a, b];
      }
      const rel = parts.join(' ');
      const abs = safe(rel);
      if (!existsAt(abs)) return `no such file: ${rel}`;
      const kind = binaryKind(abs, (p) => overlay.has(p));
      if (kind) {
        return `${rel} is ${kind === 'binary' ? 'a binary file' : `a ${kind} file`}, not text.\n`
          + 'These tools only read text, and its bytes would be unreadable. Do not try to read it again.\n'
          + 'To ask a question about this document, attach it to a chat instead:\n'
          + `  npm run chat -- "your question" --file ${rel}`;
      }

      const lines = readAt(abs).split('\n');
      const total = lines.length;
      let start = 1, end = total;
      if (range) { start = Math.max(1, range[0]); end = Math.min(total, range[1]); }
      else if (total > readLines) end = readLines;

      const width = String(end).length;
      const numbered = lines.slice(start - 1, end)
        .map((l, i) => `${String(start + i).padStart(width)} | ${l}`)
        .join('\n');

      let note = '';
      if (end < total) note = `\n… ${total - end} more line(s). To see them: NEED file ${rel} ${end + 1}-${Math.min(total, end + readLines)}`;
      else if (start > 1) note = `\n(lines ${start}-${end} of ${total})`;
      return numbered + note;
    },
    write(arg, rawBody) {
      const body = inbound(rawBody);
      overlay.set(safe(arg), body);
      return `wrote ${arg}, ${body.split('\n').length} lines`;
    },
    replace(arg, rawBody) {
      const abs = safe(arg);
      if (!existsAt(abs)) return `no such file: ${arg}`;
      const before = inbound(stripGutter(rawBody[0]));
      const after = inbound(rawBody[1]);
      const text = readAt(abs);
      if (!before) return `the text to change was empty. Copy the exact lines to find under FIND.`;

      const count = text.split(before).length - 1;
      if (count === 0) return `the text to change was not found in ${arg}. Read it again with NEED file ${arg} and copy the lines exactly.`;
      if (count > 1) return `that text appears ${count} times in ${arg}. Include a few more surrounding lines under FIND so it matches exactly one place.`;

      overlay.set(abs, text.replace(before, after));
      return `updated ${arg} (1 change)`;
    },
    search(arg) {
      const query = String(arg).trim();
      if (!query) return 'give me some text to search for.';
      const needle = inbound(query); // the model may type placeholders like LCLHST
      const hits = [];
      const MAX = 50;
      const walk = (dir) => {
        if (hits.length >= MAX) return;
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          if (SKIP.has(e.name) || e.name.startsWith('.')) continue;
          const full = path.join(dir, e.name);
          if (e.isDirectory()) { walk(full); continue; }
          if (hits.length >= MAX) return;
          let text;
          try { text = readAt(full); } catch { continue; }
          if (text.includes('\u0000')) continue; // skip binary
          const lines = text.split('\n');
          for (let i = 0; i < lines.length && hits.length < MAX; i++) {
            if (lines[i].includes(needle)) {
              hits.push(`${posix(path.relative(root, full))}:${i + 1}: ${lines[i].trim().slice(0, 140)}`);
            }
          }
        }
      };
      walk(root);
      if (!hits.length) return `no matches for "${query}".`;
      const more = hits.length >= MAX ? `\n… stopped at ${MAX} matches; make the search more specific for the rest.` : '';
      return hits.join('\n') + more;
    },
    run(_arg, body) {
      if (!allowRun) return 'shell commands are disabled for this run';
      try {
        // execSync picks the platform shell: /bin/sh on POSIX, cmd.exe on Windows.
        return clip(execSync(body, { cwd: root, encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'] }));
      } catch (err) {
        return clip(`exit ${err.status}\n${String(err.stdout ?? '')}${String(err.stderr ?? '')}`);
      }
    },
    glob(pattern) {
      if (!pattern) return 'give me a glob pattern, e.g. **/*.ts';
      const patParts = pattern.split('/');
      const matchPart = (pat, seg) => {
        if (pat === '**') return true;
        const re = new RegExp('^' + pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*') + '$', 'i');
        return re.test(seg);
      };
      const hits = [];
      const MAX = 200;
      const walk = (dir, depth) => {
        if (hits.length >= MAX) return;
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          if (SKIP.has(e.name) || e.name.startsWith('.')) continue;
          const rel = path.relative(root, path.join(dir, e.name));
          const segs = rel.split(path.sep);
          let match = false;
          if (patParts.includes('**')) {
            const lastPat = patParts.at(-1) ?? '';
            match = matchPart(lastPat, e.name);
          } else {
            match = segs.length === patParts.length && segs.every((s, i) => matchPart(patParts[i] ?? '', s));
          }
          if (match && !e.isDirectory()) hits.push(posix(rel));
          if (e.isDirectory()) walk(path.join(dir, e.name), depth + 1);
        }
      };
      walk(root, 0);
      if (!hits.length) return `no files matched "${pattern}".`;
      const more = hits.length >= MAX ? `\n… stopped at ${MAX} results.` : '';
      return hits.join('\n') + more;
    },
    git(arg) {
      const sub = arg.trim();
      if (!sub) return 'give me a git subcommand, e.g. status';
      const ALLOWED = /^(status|diff|log|show|branch|tag|remote|stash\s+list|ls-files|rev-parse|describe)/i;
      if (!ALLOWED.test(sub))
        return `only read-only git subcommands are allowed (status, diff, log, show, branch, ls-files, …). Got: ${sub}`;
      try {
        return clip(execSync(`git ${sub}`, { cwd: root, encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'] }));
      } catch (err) {
        return clip(`exit ${err.status ?? 1}\n${String(err.stderr ?? err.stdout ?? '')}`);
      }
    },
    async fetch(url) {
      const u = inbound(url.trim());
      if (!u || !/^https?:\/\//i.test(u)) return `invalid URL: ${url}. Must start with http:// or https://`;
      try {
        const res = await globalThis.fetch(u, {
          headers: { 'user-agent': 'aipass-agent/1.0', 'accept': 'text/plain,text/html,*/*' },
          signal: AbortSignal.timeout(20_000),
        });
        if (!res.ok) return `HTTP ${res.status} ${res.statusText} from ${u}`;
        let text = await res.text();
        text = text.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<script[\s\S]*?<\/script>/gi, '');
        text = text.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ');
        text = text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
        return clip(outbound(text));
      } catch (err) {
        return `fetch error: ${err.message}`;
      }
    },
    delete(arg) {
      const rel = arg.trim();
      if (!rel) return 'give me a file path to delete.';
      const abs = safe(rel);
      if (!existsAt(abs)) return `no such file: ${rel}`;
      if (!fs.existsSync(abs)) {
        overlay.discard(abs);
        return `deleted ${rel} from memory (was not yet written to disk).`;
      }
      overlay.markDeleted(abs);
      return `marked ${rel} for deletion. Will be removed on disk when applied.`;
    },
    move(arg) {
      const parts = arg.trim().split(/\s+/);
      if (parts.length < 2) return 'usage: MOVE <from> <to>';
      const [fromRel, toRel] = parts;
      const fromAbs = safe(fromRel);
      const toAbs = safe(toRel);
      if (!existsAt(fromAbs)) return `no such file: ${fromRel}`;
      const content = readAt(fromAbs);
      overlay.set(toAbs, content);
      if (fs.existsSync(fromAbs)) {
        overlay.markDeleted(fromAbs);
      } else {
        overlay.discard(fromAbs);
      }
      return `marked: move ${fromRel} → ${toRel}. Will apply on disk after Apply.`;
    },
    async web(query) {
      const q = inbound(query.trim());
      if (!q) return 'give me a query to search for.';
      if (!bridge) return 'web search is unavailable in this run';

      log('note', `searching web for "${q}"…`);
      const prompt = `Please search the web and provide detailed, up-to-date facts, answers, and sources for: ${q}`;
      let res;
      try {
        res = await bridge.chat({ message: prompt, model, onReasoning });
      } catch (err) {
        return `web search failed: ${err.message}`;
      }
      let sources = '';
      const { text, reasoning } = res;
      if (reasoning && (reasoning.includes('http') || reasoning.includes('sources:'))) sources = '\n' + reasoning;
      const result = (text + (sources ? `\n\n${sources}` : '')).trim();
      return clip(outbound(result || 'no results found'));
    },
  };

  return TOOLS;
}

/** Tools that change the disk — the ones a permission policy can hold back. */
export const WRITERS = new Set(['write', 'replace', 'delete', 'move', 'run']);
/** Tools that only read — always allowed. */
export const READERS = new Set(['list', 'read', 'search', 'glob', 'git', 'skill', 'fetch', 'web']);
/** Tools the harness handles itself rather than through the overlay. */
export const CONTROL = new Set(['plan', 'todo', 'subagent']);
