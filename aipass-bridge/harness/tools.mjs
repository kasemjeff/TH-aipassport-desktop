// The tools the model can drive: everything from reading a file to running
// shell, implemented as one function per marker shape. String in, string out —
// no JSON, no streaming, because the model writes them as prose lines.
//
// Every write goes to the overlay, never to disk; the run applies the overlay
// when the person (or `--apply`) says so. This factory exists so the same
// implementations serve the CLI and the desktop harness — the original agent
// had two copies that had already drifted apart.
//
// Failure is spelled `err: …` at the start of the result, success is bare
// text. The loop reads that one word to light the ✗; no tool learns a new
// failure phrase that a regex somewhere has to be taught about.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exec, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { SKIP, binaryKind, posix, stripGutter } from './overlay.mjs';
import { createSandbox, materializeTree, restorePaths } from './sandbox.mjs';
import { outbound, inbound } from './waf.mjs';
import { isPrivateHost } from '../bridge/private-hosts.mjs';
import { loadGitignore } from './gitignore.mjs';
import { MAX_ATTACHMENT_BYTES, mimeOf, isAllowedAttachment } from '../bridge/attachment-types.mjs';

const execP = promisify(exec);

// A file past this size is data, not source: SEARCH used to read 500 MB logs
// line by line, synchronously, in the backend's process.
const MAX_SEARCH_FILE = 1_000_000;

/**
 * A tool result longer than the inline cap is not thrown away.
 *
 * The first `cap` bytes still go to the model, and the whole thing is written
 * to `<root>/.aipass/spill/<id>.txt`, with a locator telling the model how to
 * read the rest with the file tool it already has. Truncation used to end the
 * story at ". truncated", which silently cost the model the tail of every long
 * file it read. (The directory is in overlay's SKIP, so walks never surface
 * it; read() still reaches it, because that is what the locator is for.)
 */
function spill(text, cap, root, tailShare = 0) {
  const id = Math.random().toString(16).slice(2, 10);
  const dir = path.join(root, '.aipass', 'spill');
  try {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${id}.txt`);
    fs.writeFileSync(file, text);
    const rel = `.aipass/spill/${id}.txt`;
    const lines = text.split('\n').length;
    if (tailShare > 0) {
      // Shell output is the one result whose diagnosis sits in the tail — a
      // runner prints "3 failing" and the assertion last — while the head
      // still carries the first error. Keeping only one end costs the model
      // a round trip to the other, so the budget is split and the locator
      // names the elided middle. "Lost in the middle" (Liu et al. 2023) is
      // the same bet: beginnings and ends get attended to, middles do not.
      const headCap = Math.max(1, Math.round(cap * (1 - tailShare)));
      const tailCap = Math.max(1, cap - headCap);
      const head = text.slice(0, headCap);
      const tail = text.slice(-tailCap);
      const elidedStart = head.split('\n').length; // first line whose end is gone
      const elidedEnd = Math.max(elidedStart, lines - tail.split('\n').length + 1);
      return `${head}\n… ${text.length - cap} more bytes, lines ${elidedStart}-${elidedEnd} of ${lines} `
        + `are on disk at ${rel} - read them with: NEED file ${rel} ${elidedStart}-${elidedEnd}. `
        + `Do not ask for it again; it is already saved.\n${tail}`;
    }
    return `${text.slice(0, cap)}\n. ${text.length - cap} more bytes, ${lines} lines in total. `
      + `The rest is on disk at ${rel} - read it with: NEED file ${rel} ${Math.ceil(cap / 80) + 1}-${lines}. `
      + `Do not ask for it again; it is already saved.`;
  } catch {
    // A read-only project still deserves the head of the result.
    return `${text.slice(0, cap)}\n. truncated`;
  }
}

// Deterministic edit diagnostics (research round R2): an edit whose target is
// JavaScript is syntax-checked with the runtime that will load it, and the
// verdict rides the tool result. Of the harness components that survive
// ablations — structured tools carrying validation — this is the cheapest
// check there is: a syntax error is either there or it is not, and catching
// it inside the run costs one round trip instead of a broken apply later.
const JS_FILE = /\.(mjs|cjs|js)$/i;

function syntaxNote(rel, text) {
  if (!JS_FILE.test(rel) || text.length > 512 * 1024) return '';
  // The extension decides the grammar: .mjs is a module, .cjs a script. A
  // project .js file is whichever its package.json says, so sniff the one
  // marker that changes the parse.
  let ext = path.extname(rel).toLowerCase();
  if (ext === '.js') ext = /^\s*(import\b|export\b)/m.test(text) ? '.mjs' : '.cjs';
  const tmp = path.join(os.tmpdir(), `aipass-check-${process.pid}-${Math.random().toString(16).slice(2, 8)}${ext}`);
  try {
    fs.writeFileSync(tmp, text);
    const res = spawnSync(process.execPath, ['--check', tmp], { encoding: 'utf8', timeout: 15_000 });
    if (res.error || res.status === null) return '';
    if (res.status === 0) return 'syntax check ok';
    const line = String(res.stderr ?? '').split('\n').map((l) => l.trim()).find((l) => /^\w*Error\b/.test(l)) || 'the content does not parse';
    return `syntax check failed — the staged content does not parse:\n${line}`;
  } catch {
    return '';
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* the temp copy is best-effort */ }
  }
}

// Subcommands whose reading form and their writing form share a name -
// `branch -D`, `tag -d`, `remote add` all delete or push somewhere - so they
// are allowed bare, with no arguments at all.
const GIT_BARE = new Set(['branch', 'tag', 'remote']);
const GIT_READONLY = new Set(['status', 'diff', 'log', 'show', 'branch', 'tag', 'remote', 'stash', 'ls-files', 'rev-parse', 'describe']);
// Options that turn a reading command into something else: another repo
// (--git-dir/--work-tree), a file on disk (--no-index writes a diff patch,
// --output writes one too), a config override (-c) or a transport the model
// gets to choose.
const GIT_FLAGS = new Set(['--no-index', '--output', '-o', '-D', '-d', '--delete', '--force', '-f', '--exec-path', '--git-dir', '--work-tree', '-c', '--upload-pack', '--receive-pack']);

/**
 * The whole GIT gate, as one predicate.
 *
 * A prefix test is not a gate: `git -c core.pager=sh status` and
 * `git branch -D main` both start with an allowed word. So only the first
 * token is matched, against the whole set rather than as a prefix; `stash`
 * must be exactly `stash list`; `branch`/`tag`/`remote` must be bare; and no
 * argument may carry one of GIT_FLAGS.
 */
function gitAllowed(sub) {
  const parts = sub.split(/\s+/);
  const cmd = parts[0].toLowerCase();
  if (!GIT_READONLY.has(cmd)) return false;
  const args = parts.slice(1);
  if (GIT_BARE.has(cmd)) return args.length === 0;
  if (cmd === 'stash') return args.length === 1 && args[0].toLowerCase() === 'list';
  return !args.some((a) => GIT_FLAGS.has(a));
}

export function createTools(ctx) {
  const {
    root,
    overlay,
    skills,
    allowRun = false,
    readOnly = false,
    maxResult = 3000,
    readLines = 250,
    bridge = null,
    model = null,
    conversation = null,
    temporary = null,
    webConversation = null,
    onReasoning = () => {},
    log = () => {},
  } = ctx;

  // A result past the inline cap is spilled to disk rather than truncated: the
  // head still rides the message, and the locator tells the model how to read
  // the rest with the tool it already has.
  const clip = (s) => (s.length > maxResult ? spill(s, maxResult, root) : s);
  // Command output gets the split view instead — head and tail, middle on
  // disk (spill's tailShare). The last lines of a failing command are the
  // diagnosis; the first are where it went wrong first.
  const clipRun = (s) => (s.length > maxResult ? spill(s, maxResult, root, 0.6) : s);
  const safe = (p) => overlay.safe(p);
  const existsAt = (abs) => overlay.existsAt(abs);
  const readAt = (abs) => overlay.readAt(abs);

  // ATTACH queues parts here; the loop drains the queue into the very next
  // message it sends. A tool cannot send anything itself — the message is the
  // loop's one channel, so attaching is a proposal like any write.
  const queuedParts = [];

  const TOOLS = {
    // SKILL list (or bare SKILL) prints the library index; SKILL name-part
    // returns one playbook part verbatim. Names are whitelisted, so this is a
    // read-only window onto the library — never a path traversal.
    skill(arg) {
      const found = skills.load(arg);
      if (found.error) return `err: ${found.error}`;
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
      if (!existsAt(abs)) return `err: no such file: ${rel}`;
      const kind = binaryKind(abs, (p) => overlay.has(p));
      if (kind) {
        return `err: ${rel} is ${kind === 'binary' ? 'a binary file' : `a ${kind} file`}, not text.\n`
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
      // A page of a minified file is as big as a page of a hundred short ones,
      // so the page itself is capped through clip() — which spills the whole
      // thing to disk and hands the model a locator — but the note that says
      // how to continue is appended after, because losing it strands the model
      // on half a file.
      return clip(numbered) + note;
    },
    write(arg, rawBody) {
      const body = inbound(rawBody);
      overlay.set(safe(arg), body);
      const note = syntaxNote(arg, body);
      return `wrote ${arg}, ${body.split('\n').length} lines${note ? '\n' + note : ''}`;
    },
    replace(arg, rawBody) {
      const abs = safe(arg);
      if (!existsAt(abs)) return `err: no such file: ${arg}`;
      const before = inbound(stripGutter(rawBody[0]));
      const after = inbound(rawBody[1]);
      const text = readAt(abs);
      if (!before) return `err: the text to change was empty. Copy the exact lines to find under FIND.`;

      const count = text.split(before).length - 1;
      if (count === 0) return `err: the text to change was not found in ${arg}. Read it again with NEED file ${arg} and copy the lines exactly.`;
      if (count > 1) return `err: that text appears ${count} times in ${arg}. Include a few more surrounding lines under FIND so it matches exactly one place.`;

      const updated = text.replace(before, after);
      overlay.set(abs, updated);
      const note = syntaxNote(arg, updated);
      return `updated ${arg} (1 change)${note ? '\n' + note : ''}`;
    },
    search(arg) {
      const raw = String(arg).trim();
      const ci = /^-i\s+/i.test(raw);
      const query = (ci ? raw.slice(2) : raw).trim();
      if (!query) return 'err: give me some text to search for. (SEARCH -i text matches without letter case.)';
      const needle = inbound(query); // the model may type placeholders like LCLHST
      const wanted = ci ? needle.toLowerCase() : needle;
      const hits = [];
      let matches = 0; // only match lines count toward MAX; context rides along
      const MAX = 50;
      const ign = loadGitignore(root);
      const walk = (dir) => {
        if (matches >= MAX) return;
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          if (SKIP.has(e.name) || e.name.startsWith('.')) continue;
          const full = path.join(dir, e.name);
          const rel = posix(path.relative(root, full));
          if (e.isDirectory()) {
            if (!ign.ignored(rel, true)) walk(full);
            continue;
          }
          if (matches >= MAX) return;
          if (ign.ignored(rel, false)) continue;
          let size = 0;
          try { size = fs.statSync(full).size; } catch { /* overlay-only or vanished: read it anyway */ }
          if (size > MAX_SEARCH_FILE) continue;
          let text;
          try { text = readAt(full); } catch { continue; }
          if (text.includes('\u0000')) continue; // skip binary
          const lines = text.split('\n');
          // One line of context on each side, ripgrep-style: a match line
          // keeps the `rel:N: text` shape every other tool prints, a context
          // line trades the colon for a dash. A bare hit line makes the model
          // read the file just to learn what surrounds it, and the line
          // around a hit is usually what says whether it is the hit it wants
          // (Anthropic's tool-writing guidance, 2025: return the relevant
          // lines and some surrounding context).
          const shown = new Map(); // idx → slot in hits, so a line first seen as context can be upgraded to a match
          const show = (idx, isMatch) => {
            if (idx < 0 || idx >= lines.length) return;
            const line = `${rel}:${idx + 1}${isMatch ? ':' : '-'} ${lines[idx].trim().slice(0, 140)}`;
            if (shown.has(idx)) {
              if (isMatch) hits[shown.get(idx)] = line;
              return;
            }
            shown.set(idx, hits.length);
            hits.push(line);
          };
          for (let i = 0; i < lines.length && matches < MAX; i++) {
            const line = ci ? lines[i].toLowerCase() : lines[i];
            if (!line.includes(wanted)) continue;
            matches++;
            show(i - 1, false);
            show(i, true);
            show(i + 1, false);
          }
        }
      };
      walk(root);
      if (!hits.length) return `no matches for "${query}".`;
      const more = matches >= MAX ? `\n… stopped at ${MAX} matches; make the search more specific for the rest.` : '';
      return clip(hits.join('\n') + more);
    },
    async run(_arg, body) {
      if (!allowRun) return 'err: shell commands are disabled for this run';
      if (!String(body ?? '').trim()) {
        return 'err: the RUN block has no command. One command per RUN, e.g. RUN\nnode check.mjs\nEND.';
      }
      // With anything staged, the command runs against a projection of the
      // tree that has the staged edits written in (sandbox.mjs) — the disk
      // itself is untouched. Without staged changes it runs in the project,
      // exactly as before. Either way the child's own paths are put back to
      // the project's, so the output reads as if it ran where the model
      // thinks it did.
      let sandbox = null;
      if (overlay.size) {
        try {
          sandbox = createSandbox(root);
          materializeTree(root, overlay, sandbox);
        } catch {
          if (sandbox) { try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* left under .aipass */ } }
          sandbox = null; // a projection that cannot be built must not block the run
        }
      }
      const scrub = (text) => (sandbox ? restorePaths(text, sandbox, root) : text);
      try {
        // Async, not execSync: this runs in the backend's process, and a
        // blocked event loop there freezes every window call for the length
        // of the command. The platform shell is picked for us: /bin/sh on
        // POSIX, cmd.exe on Windows.
        const { stdout } = await execP(body, {
          cwd: sandbox ?? root, timeout: 120_000, windowsHide: true, maxBuffer: 10 * 1024 * 1024,
        });
        return clipRun(scrub(stdout));
      } catch (err) {
        return clipRun(scrub(`err: exit ${err.code ?? err.signal ?? '?'}\n${String(err.stdout ?? '')}${String(err.stderr ?? '')}`));
      } finally {
        if (sandbox) { try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* left under .aipass */ } }
      }
    },
    glob(pattern) {
      if (!pattern) return 'err: give me a glob pattern, e.g. **/*.ts';
      const patParts = String(pattern).split('/').filter(Boolean);
      // Segment-wise: every pattern part matches one path segment, except `**`
      // which spans any number of them. Matching only the last part when `**`
      // was present (the old shape) made `src/**/*.ts` answer with every .ts
      // in the project — and the model then trusted that and edited the wrong
      // tree. Case folded, as before, for Windows-shaped listings.
      const segRe = (pat) => new RegExp('^' + pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*') + '$', 'i');
      const matchFrom = (segs, pats) => {
        if (!pats.length) return segs.length === 0;
        if (pats[0] === '**') {
          if (pats.length === 1) return true; // everything below, at any depth
          for (let skip = 0; skip <= segs.length; skip++) {
            if (matchFrom(segs.slice(skip), pats.slice(1))) return true;
          }
          return false;
        }
        if (!segs.length || !segRe(pats[0]).test(segs[0])) return false;
        return matchFrom(segs.slice(1), pats.slice(1));
      };
      const hits = [];
      const MAX = 200;
      const ign = loadGitignore(root);
      const walk = (dir) => {
        if (hits.length >= MAX) return;
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          if (SKIP.has(e.name) || e.name.startsWith('.')) continue;
          const full = path.join(dir, e.name);
          const rel = posix(path.relative(root, full));
          if (ign.ignored(rel, e.isDirectory())) continue;
          if (!e.isDirectory() && matchFrom(rel.split('/'), patParts)) {
            hits.push(rel);
            if (hits.length >= MAX) return;
          }
          if (e.isDirectory()) walk(full);
        }
      };
      walk(root);
      if (!hits.length) return `no files matched "${pattern}".`;
      const more = hits.length >= MAX ? `\n… stopped at ${MAX} results.` : '';
      // A glob answer goes through the same cap as every other result: a
      // deep tree can name thousands of files, and the raw list used to ride
      // the message whole.
      return clip(hits.join('\n') + more);
    },
    async git(arg) {
      const sub = arg.trim();
      if (!sub) return 'err: give me a git subcommand, e.g. status';
      // Shell punctuation first: whether this string is one command at all is a
      // question about the transport, and `status; echo pwned` is answered more
      // honestly by this refusal than by the allowlist's. Without it, whatever
      // reaches execP could ride a second command on the platform shell.
      if (/[;&|`$<>]/.test(sub))
        return `err: one read-only git subcommand, no shell punctuation. Got: ${sub}`;
      if (!gitAllowed(sub))
        return `err: only read-only git subcommands are allowed (status, diff, log, show, branch, ls-files, …). Got: ${sub}`;
      try {
        // Async for the same reason `run` is: a slow `git log` must not stop
        // the backend's event loop while the window waits on it.
        const { stdout } = await execP(`git ${sub}`, {
          cwd: root, timeout: 15_000, windowsHide: true, maxBuffer: 10 * 1024 * 1024,
        });
        return clip(stdout);
      } catch (err) {
        const detail = String(err.stderr ?? err.stdout ?? '');
        // `git diff` outside a repository answers with a page of option help
        // and exit 129 (live finding, 2026-10-15). The one fact worth having
        // fits in a line — say the fact, not the wall.
        if (/not a git repository/i.test(detail)) return 'err: not a git repository — GIT only works inside one. Run git init first, or skip git here.';
        return clip(`err: exit ${err.code ?? err.status ?? 1}\n${detail}`);
      }
    },
    async fetch(url) {
      const u = inbound(url.trim());
      if (!u || !/^https?:\/\//i.test(u)) return `err: invalid URL: ${url}. Must start with http:// or https://`;

      // The model pastes file content and README text back and forth, so URLs
      // arrive in their WAF-shortened spellings too — inbound() restores them
      // first, and the guard runs on what will actually be fetched. The same
      // classifier the bridge uses for attachments, so the two cannot drift.
      // AIPASS_FETCH_ALLOW_PRIVATE=1 lifts this for the legit case — checking
      // your own localhost dev server — and costs the tool its innocence.
      const host = new URL(u).hostname;
      const allowPrivate = process.env.AIPASS_FETCH_ALLOW_PRIVATE === '1';
      if (!allowPrivate && isPrivateHost(host)) {
        return `err: refusing to fetch ${host} — private and internal addresses are blocked. Fetch a public URL instead.`;
      }

      // Body reads are capped: a giant response would otherwise ride whole
      // into the next message, and the message is the only channel there is.
      const MAX_BYTES = Number(process.env.AIPASS_FETCH_MAX_BYTES ?? 2_000_000);
      try {
        const res = await globalThis.fetch(u, {
          headers: { 'user-agent': 'aipass-agent/1.0', 'accept': 'text/plain,text/html,*/*' },
          signal: AbortSignal.timeout(20_000),
        });
        if (!res.ok) return `err: HTTP ${res.status} ${res.statusText} from ${u}`;
        let size = 0;
        const parts = [];
        if (res.body) {
          const reader = res.body.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > MAX_BYTES) { reader.cancel().catch(() => {}); break; }
            parts.push(Buffer.from(value));
          }
        } else {
          const buf = Buffer.from(await res.arrayBuffer());
          size = buf.byteLength;
          parts.push(buf);
        }
        let text = Buffer.concat(parts).toString('utf8');
        if (size > MAX_BYTES) text += '\n… truncated at the byte cap; fetch a more specific URL for the rest.';
        text = text.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<script[\s\S]*?<\/script>/gi, '');
        text = text.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ');
        text = text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
        return clip(outbound(text));
      } catch (err) {
        return `err: fetch error: ${err.message}`;
      }
    },
    delete(arg) {
      const rel = arg.trim();
      if (!rel) return 'err: give me a file path to delete.';
      const abs = safe(rel);
      if (!existsAt(abs)) return `err: no such file: ${rel}`;
      if (!fs.existsSync(abs)) {
        overlay.discard(abs);
        return `deleted ${rel} from memory (was not yet written to disk).`;
      }
      overlay.markDeleted(abs);
      return `marked ${rel} for deletion. Will be removed on disk when applied.`;
    },
    move(arg) {
      const parts = arg.trim().split(/\s+/);
      if (parts.length < 2) return 'err: usage: MOVE <from> <to>';
      const [fromRel, toRel] = parts;
      const fromAbs = safe(fromRel);
      const toAbs = safe(toRel);
      if (!existsAt(fromAbs)) return `err: no such file: ${fromRel}`;
      if (existsAt(toAbs)) {
        // Landing on an existing file would read as success while one file's
        // content displaced another's — a data-loss shape the model almost
        // never intends. Refuse, and name both ways out.
        return `err: ${toRel} already exists. Delete it first (DELETE ${toRel}) or move to another name.`;
      }
      const content = readAt(fromAbs);
      overlay.set(toAbs, content);
      if (fs.existsSync(fromAbs)) {
        overlay.markDeleted(fromAbs);
      } else {
        overlay.discard(fromAbs);
      }
      return `marked: move ${fromRel} → ${toRel}. Will apply on disk after Apply.`;
    },
    // ATTACH queues a part for the next outgoing message — the only way to
    // hand the model something `read` refuses (a binary). A file the run wrote
    // itself attaches from the overlay as text; everything else comes off the
    // disk, capped at the same 20 MB the bridge enforces.
    attach(arg) {
      const rel = String(arg).trim();
      if (!rel) return 'err: give me a file path to attach.';
      if (rel.split('/').some((s) => SKIP.has(s))) {
        return `err: ${rel} sits under a directory that is skipped (dependencies, build output) — attach a copy from outside it.`;
      }
      const abs = safe(rel);
      let mime, bytes;
      if (overlay.has(abs)) {
        mime = 'text/plain';
        bytes = Buffer.from(readAt(abs), 'utf8');
      } else {
        if (!fs.existsSync(abs)) return `err: no such file: ${rel}`;
        bytes = fs.readFileSync(abs);
        // A NUL byte is the cheap binary tell; the extension then names the type.
        mime = bytes.includes(0) ? mimeOf(rel) : 'text/plain';
      }
      if (bytes.length > MAX_ATTACHMENT_BYTES) {
        return `err: ${rel} is ${Math.round(bytes.length / 1024 / 1024)} MB — the cap is ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB.`;
      }
      if (!isAllowedAttachment(mime, 'file')) {
        return `err: ${mime} is not an attachable type. Images, pdf, office documents, text, csv, json and mp4/mov/webm video can ride a chat; ${mime} cannot.`;
      }
      const uri = `data:${mime};base64,${bytes.toString('base64')}`;
      queuedParts.push(mime.startsWith('image/')
        ? { type: 'image_url', image_url: { url: uri } }
        : { type: 'file', file: { file_data: uri, filename: path.basename(rel) } });
      return `queued ${rel} (${mime}, ${(bytes.length / 1024).toFixed(1)} KB) — it goes out with your next message.`;
    },
    async web(query) {
      const q = inbound(query.trim());
      if (!q) return 'err: give me a query to search for.';
      if (!bridge) return 'err: web search is unavailable in this run';

      log('note', `searching web for "${q}"…`);
      const prompt = `Please search the web and provide detailed, up-to-date facts, answers, and sources for: ${q}`;
      // A scratch conversation (P2-B) keeps the search Q&A out of the working
      // conversation's context; without one the lookup spends the current one.
      const scratch = typeof webConversation === 'function'
        ? await webConversation().catch(() => null)
        : (webConversation ?? null);
      const target = scratch ?? conversation;
      let res;
      try {
        res = await bridge.chat({
          message: prompt, model, onReasoning,
          ...(target ? { conversation: target, temporary: temporary === true } : {}),
        });
      } catch (err) {
        return `err: web search failed: ${err.message}`;
      }
      let sources = '';
      const { text, reasoning } = res;
      if (reasoning && (reasoning.includes('http') || reasoning.includes('sources:'))) sources = '\n' + reasoning;
      const result = (text + (sources ? `\n\n${sources}` : '')).trim();
      return clip(outbound(result || 'no results found'));
    },
  };

  // The checker's hand is tied (SPEC_CHECKER.md): every marker that would
  // change the tree answers with the reason instead, so a read-only run
  // cannot stage a proposal that lands after the run it was checking.
  if (readOnly) {
    for (const kind of ['write', 'replace', 'delete', 'move']) {
      TOOLS[kind] = () => 'err: the checker is read-only — report it in your summary instead.';
    }
  }

  TOOLS.pendingParts = queuedParts;
  return TOOLS;
}
