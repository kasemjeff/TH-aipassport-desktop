// The export of a session: markdown, HTML, and the tree the /tree view reads.
//
// A transcript is the one artifact of a run that outlives the run. The window
// shows it, the JSONL on disk keeps it — and every competitor has a way to
// take it away and send it to somebody else (Devin's "Share Conversation",
// Claude Code's /export). The desktop README named both as missing:
// "Session tree view (/tree) and export to markdown/HTML".
//
// Both renderers walk the SAME block list, so the two can never drift: what
// the markdown carries, the HTML carries. A block is one entry of the session
// rendered for a person — the prompt, the reply, the tool call and its
// result, the checklist, the change, the note, the run's ending.
//
// Nothing is dropped. An entry type this build does not know (a newer build
// wrote it) is still in the file, so it is still in the export — with its
// type named and its bytes shown, because a transcript that silently loses a
// line is a transcript nobody can trust.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * The text of a value, whatever shape it has.
 *
 * A tool's `out` is a string today and a structured value tomorrow; the
 * export shows both the same way instead of answering "[object Object]".
 *
 * @param {any} value
 * @returns {string}
 */
const asText = (value) => {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
};

/** The moment, as an ISO string (or null when there is no moment). */
const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);

/**
 * The title of a session, whatever the header calls it.
 *
 * @param {Record<string, any>} header
 * @returns {string}
 */
const titleOf = (header) => {
  const title = typeof header?.title === 'string' ? header.title.trim() : '';
  return title || 'session';
};

/**
 * The local calendar day a moment falls in.
 *
 * The tree groups by the reader's day, not by UTC: a run at 00:30 in Bangkok
 * is "today" to the person looking at it, and a UTC key would file it under
 * yesterday.
 *
 * @param {number|null|undefined} ms
 * @returns {string} 'YYYY-MM-DD', or '' when there is no moment
 */
export const dayKey = (ms) => {
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms);
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
};

/**
 * The credits a session's runs cost.
 *
 * The session carries it on its `run_stats` entries (`spent`, measured
 * against the quota before and after the run). A session written before that
 * was recorded carries none, and then the export carries none either.
 *
 * @param {Array<Record<string, any>>} entries
 * @returns {number|null}
 */
const creditsOf = (entries) => {
  let total = null;
  for (const entry of entries) {
    if (entry?.type !== 'run_stats') continue;
    const spent = Number(entry.spent);
    if (!Number.isFinite(spent)) continue;
    total = (total ?? 0) + spent;
  }
  return total;
};

/**
 * The blocks one session is rendered from.
 *
 * The blocks are the contract between the two renderers: everything the
 * markdown shows is here, and everything here is shown.
 *
 * @param {{header?: Record<string, any>, entries?: Array<Record<string, any>>}} session
 * @param {{root?: string|null}} [opts]
 * @returns {{front: Record<string, any>, blocks: Array<Record<string, any>>}}
 */
export function blocksOf(session, { root = null } = {}) {
  const header = session?.header ?? {};
  const entries = Array.isArray(session?.entries) ? session.entries : [];
  const blocks = [];
  // The closing summary of a run is the assistant's last words before the
  // run's stats — the DONE line, said exactly once (root rule 12). It is
  // marked here so the renderers can head it as the result rather than as
  // one more turn of the conversation.
  let lastReply = null;
  for (const entry of entries) {
    const type = String(entry?.type ?? '');
    if (type === 'assistant') {
      const block = { kind: 'reply', text: asText(entry.text), reasoning: asText(entry.reasoning), closing: false };
      blocks.push(block);
      lastReply = block;
      continue;
    }
    if (type === 'user' || type === 'task') {
      blocks.push({ kind: 'prompt', label: type === 'task' ? 'Task' : 'You', text: asText(entry.text) });
      continue;
    }
    if (type === 'tool') {
      blocks.push({
        kind: 'tool',
        name: asText(entry.kind),
        arg: asText(entry.arg),
        out: asText(entry.out),
        ok: entry.ok !== false,
      });
      continue;
    }
    if (type === 'diff') {
      blocks.push({
        kind: 'change',
        file: asText(entry.file),
        added: Number(entry.added ?? 0) || 0,
        removed: Number(entry.removed ?? 0) || 0,
        decision: asText(entry.decision),
      });
      continue;
    }
    if (type === 'todo') {
      blocks.push({
        kind: 'plan',
        items: (Array.isArray(entry.items) ? entry.items : []).map((item) => ({
          text: asText(item?.text),
          done: Boolean(item?.done),
        })),
      });
      continue;
    }
    if (type === 'compaction') {
      blocks.push({
        kind: 'compaction',
        summary: asText(entry.summary),
        memory: (Array.isArray(entry.memory) ? entry.memory : []).map((fact) => asText(fact)),
      });
      continue;
    }
    if (type === 'run_stats') {
      if (lastReply) lastReply.closing = true;
      blocks.push({
        kind: 'run',
        stopReason: asText(entry.stopReason) || 'ended',
        steps: Number.isFinite(entry.steps) ? entry.steps : null,
        turns: Number.isFinite(entry.turns) ? entry.turns : null,
        spent: Number.isFinite(entry.spent) ? entry.spent : null,
        model: entry.model ? asText(entry.model) : null,
        estTokens: Number.isFinite(entry.estTokens) ? entry.estTokens : null,
      });
      continue;
    }
    if (type === 'note') {
      blocks.push({ kind: 'note', text: asText(entry.text) });
      continue;
    }
    // An entry type this build does not know: the file keeps it untouched, so
    // the export has to keep it too.
    blocks.push({ kind: 'entry', type: type || 'entry', text: asText(entry) });
  }

  const last = entries.at(-1);
  const updated = last?.ts ?? header.updated ?? null;
  const front = {};
  const put = (key, value) => { if (value !== null && value !== undefined && value !== '') front[key] = value; };
  put('title', titleOf(header));
  put('id', header.id ?? null);
  put('created', iso(header.created ?? null));
  put('updated', iso(updated));
  put('model', header.model ?? null);
  // The header's own root is the authority on which project a session belongs
  // to (bridge AGENTS.md), so it wins; the caller's root is the fallback for a
  // file written before the field existed.
  put('root', typeof header.root === 'string' && header.root.trim() ? header.root : (root ?? null));
  const credits = creditsOf(entries);
  if (credits !== null) front.credits = credits;
  return { front, blocks };
}

/**
 * A fence long enough to hold what it wraps.
 *
 * Tool output is the model's own bytes and can hold a code fence of its own;
 * a fence of exactly three backticks would end at that one and the rest of
 * the output would pour into the page as markup.
 *
 * @param {string} text
 * @returns {string}
 */
const fenceFor = (text) => {
  const runs = String(text ?? '').match(/`{3,}/g) ?? [];
  const longest = runs.reduce((max, run) => Math.max(max, run.length), 0);
  return '`'.repeat(Math.max(3, longest + 1));
};

/**
 * The session as markdown: the front matter, then the entries in order.
 *
 * @param {{header?: Record<string, any>, entries?: Array<Record<string, any>>}} session
 * @param {{root?: string|null}} [opts] the project the session belongs to
 * @returns {string}
 */
export function toMarkdown(session, { root = null } = {}) {
  const { front, blocks } = blocksOf(session, { root });
  const lines = ['---'];
  for (const [key, value] of Object.entries(front)) {
    lines.push(`${key}: ${typeof value === 'number' ? value : JSON.stringify(String(value))}`);
  }
  lines.push('---', '', `# ${front.title ?? 'session'}`, '');

  for (const block of blocks) {
    if (block.kind === 'prompt') {
      lines.push(`## ${block.label}`, '', block.text, '');
      continue;
    }
    if (block.kind === 'reply') {
      lines.push(`## ${block.closing ? 'Result' : 'Assistant'}`, '', block.text, '');
      if (block.reasoning) {
        lines.push('> **reasoning**', ...block.reasoning.split('\n').map((l) => `> ${l}`), '');
      }
      continue;
    }
    if (block.kind === 'tool') {
      lines.push(`## Tool — ${block.name}${block.arg ? ` \`${block.arg}\`` : ''}${block.ok ? '' : ' (failed)'}`, '');
      const call = [block.name, block.arg].filter(Boolean).join(' ');
      const callFence = fenceFor(call);
      lines.push(callFence, call, callFence, '');
      const outFence = fenceFor(block.out);
      lines.push(outFence, block.out, outFence, '');
      continue;
    }
    if (block.kind === 'plan') {
      lines.push('## Plan', '');
      for (const item of block.items) lines.push(`- [${item.done ? 'x' : ' '}] ${item.text}`);
      lines.push('');
      continue;
    }
    if (block.kind === 'change') {
      lines.push(`## Change — ${block.file}`, '', `+${block.added} −${block.removed}${block.decision ? ` (${block.decision})` : ''}`, '');
      continue;
    }
    if (block.kind === 'note') {
      lines.push('## Note', '', block.text, '');
      continue;
    }
    if (block.kind === 'compaction') {
      lines.push('## Compaction', '', `> ${block.summary}`, '');
      for (const fact of block.memory) lines.push(`- carried: ${fact}`);
      if (block.memory.length) lines.push('');
      continue;
    }
    if (block.kind === 'run') {
      const facts = [`stopped: ${block.stopReason}`];
      if (block.steps !== null) facts.push(`${block.steps} steps`);
      if (block.turns !== null) facts.push(`${block.turns} turns`);
      if (block.spent !== null) facts.push(`${block.spent} credits`);
      if (block.estTokens !== null) facts.push(`≈${block.estTokens} tokens of context`);
      lines.push('## Run', '', facts.join(' · '), '');
      continue;
    }
    // An entry type this build does not know: named, and shown whole.
    lines.push(`## ${block.type}`, '', '```', block.text, '```', '');
  }
  return lines.join('\n');
}

/**
 * Escape the five characters that can change what a page means.
 *
 * @param {any} value
 * @returns {string}
 */
export const escapeHtml = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

/**
 * The session as one self-contained HTML page.
 *
 * No script, no external asset, no font to fetch: the file is opened from
 * disk, on a machine that may be offline, and it has to read the same there
 * as it does here. Everything the session says is escaped — a transcript holds
 * the model's own words, and words can carry markup.
 *
 * @param {{header?: Record<string, any>, entries?: Array<Record<string, any>>}} session
 * @param {{root?: string|null}} [opts] the project the session belongs to
 * @returns {string}
 */
export function toHtml(session, { root = null } = {}) {
  const { front, blocks } = blocksOf(session, { root });
  const meta = Object.entries(front)
    .map(([key, value]) => `<div class="meta"><dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd></div>`)
    .join('');

  const body = blocks.map((block) => {
    if (block.kind === 'prompt') {
      return `<section class="block prompt"><h2>${escapeHtml(block.label)}</h2><pre>${escapeHtml(block.text)}</pre></section>`;
    }
    if (block.kind === 'reply') {
      const reasoning = block.reasoning
        ? `<details class="reasoning"><summary>reasoning</summary><pre>${escapeHtml(block.reasoning)}</pre></details>`
        : '';
      return `<section class="block reply"><h2>${block.closing ? 'Result' : 'Assistant'}</h2><pre>${escapeHtml(block.text)}</pre>${reasoning}</section>`;
    }
    if (block.kind === 'tool') {
      return `<section class="block tool"><h2>Tool — ${escapeHtml(block.name)}${block.arg ? ` <code>${escapeHtml(block.arg)}</code>` : ''}${block.ok ? '' : ' (failed)'}</h2><pre>${escapeHtml(block.out)}</pre></section>`;
    }
    if (block.kind === 'plan') {
      const items = block.items
        .map((item) => `<li class="${item.done ? 'done' : 'open'}"><span class="mark">${item.done ? '&#10003;' : '&#9633;'}</span> ${escapeHtml(item.text)}</li>`)
        .join('');
      return `<section class="block plan"><h2>Plan</h2><ul class="checklist">${items}</ul></section>`;
    }
    if (block.kind === 'change') {
      return `<section class="block change"><h2>Change — ${escapeHtml(block.file)}</h2><p class="counts"><span class="add">+${block.added}</span> <span class="del">&minus;${block.removed}</span>${block.decision ? ` <span class="decision">${escapeHtml(block.decision)}</span>` : ''}</p></section>`;
    }
    if (block.kind === 'note') {
      return `<section class="block note"><h2>Note</h2><pre>${escapeHtml(block.text)}</pre></section>`;
    }
    if (block.kind === 'compaction') {
      const facts = block.memory.map((fact) => `<li>${escapeHtml(fact)}</li>`).join('');
      return `<section class="block compaction"><h2>Compaction</h2><blockquote>${escapeHtml(block.summary)}</blockquote>${facts ? `<ul class="carried">${facts}</ul>` : ''}</section>`;
    }
    if (block.kind === 'run') {
      const facts = [`stopped: ${block.stopReason}`];
      if (block.steps !== null) facts.push(`${block.steps} steps`);
      if (block.turns !== null) facts.push(`${block.turns} turns`);
      if (block.spent !== null) facts.push(`${block.spent} credits`);
      if (block.estTokens !== null) facts.push(`≈${block.estTokens} tokens of context`);
      return `<section class="block run"><h2>Run</h2><p>${escapeHtml(facts.join(' · '))}</p></section>`;
    }
    return `<section class="block unknown"><h2>${escapeHtml(block.type)}</h2><pre>${escapeHtml(block.text)}</pre></section>`;
  }).join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(front.title ?? 'session')}</title>
<style>
:root { color-scheme: light dark; --bg: #ffffff; --fg: #1c1c1e; --muted: #6b6b70; --line: #e3e3e6; --accent: #2f6f4f; --code: #f5f5f7; }
@media (prefers-color-scheme: dark) { :root { --bg: #161618; --fg: #ececef; --muted: #9a9aa2; --line: #2c2c30; --accent: #7fc7a0; --code: #1e1e22; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 52rem; margin: 0 auto; padding: 2rem 1.25rem 4rem; }
h1 { font-size: 1.6rem; margin: 0 0 .25rem; }
h2 { font-size: .82rem; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); margin: 0 0 .5rem; }
.meta { display: grid; grid-template-columns: max-content 1fr; gap: .1rem .75rem; margin: 0 0 2rem; font-size: .85rem; }
.meta dt { color: var(--muted); }
.meta dd { margin: 0; }
.block { border-top: 1px solid var(--line); padding: 1.1rem 0; }
pre { margin: 0; white-space: pre-wrap; word-break: break-word; font: inherit; }
code { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: .9em; background: var(--code); padding: .1rem .3rem; border-radius: .25rem; }
.prompt pre { background: var(--code); padding: .75rem .9rem; border-radius: .5rem; }
.tool pre, .unknown pre { background: var(--code); padding: .75rem .9rem; border-radius: .5rem; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: .85rem; }
.checklist { list-style: none; margin: 0; padding: 0; }
.checklist li { padding: .15rem 0; }
.checklist .mark { display: inline-block; width: 1.2rem; color: var(--accent); }
.checklist .done { color: var(--muted); }
.counts .add { color: var(--accent); }
.counts .del { color: #b3261e; }
.decision { color: var(--muted); }
.note pre { color: var(--muted); font-style: italic; }
.compaction blockquote { margin: 0; padding-left: .9rem; border-left: 2px solid var(--line); color: var(--muted); }
.carried { color: var(--muted); font-size: .9rem; }
.reasoning { margin-top: .6rem; color: var(--muted); font-size: .9rem; }
.reasoning summary { cursor: pointer; }
</style>
</head>
<body>
<main>
<h1>${escapeHtml(front.title ?? 'session')}</h1>
<dl class="meta">${meta}</dl>
${body}
</main>
</body>
</html>
`;
}

/**
 * The sessions of a project, grouped by the day they belong to.
 *
 * The window's own history rail groups its rows by day; this is the same
 * grouping as data, so the `/tree` view and the rail cannot disagree about
 * where a session sits.
 *
 * @param {{root?: string|null, sessions?: Array<Record<string, any>>}} [opts]
 * @returns {{root: string|null, count: number, days: Array<{day: string, sessions: Array<Record<string, any>>}>, sessions: Array<Record<string, any>>}}
 */
export function tree({ root = null, sessions = [] } = {}) {
  const rows = (Array.isArray(sessions) ? sessions : []).map((s) => {
    const updated = Number(s?.updated ?? 0) || null;
    const created = Number(s?.created ?? 0) || null;
    return {
      id: s?.id ?? null,
      title: typeof s?.title === 'string' && s.title.trim() ? s.title : 'session',
      root: s?.root ?? root,
      model: s?.model ?? null,
      created,
      updated,
      entryCount: Number(s?.entries ?? s?.entryCount ?? 0) || 0,
      file: s?.file ?? null,
      day: dayKey(updated ?? created),
    };
  });
  // Newest first, like the rail: the session a person came back for is the
  // one at the top.
  rows.sort((a, b) => (b.updated ?? b.created ?? 0) - (a.updated ?? a.created ?? 0));
  const days = [];
  for (const row of rows) {
    let group = days.find((d) => d.day === row.day);
    if (!group) {
      group = { day: row.day, sessions: [] };
      days.push(group);
    }
    group.sessions.push(row);
  }
  return { root, count: rows.length, days, sessions: rows };
}

/**
 * The name an exported file gets when the person did not choose one.
 *
 * @param {string} id
 * @param {string} [extension]
 * @returns {string}
 */
export const exportFileName = (id, extension = 'md') =>
  `session-${String(id ?? 'export').replace(/[^a-z0-9_-]+/gi, '-')}.${extension}`;

/**
 * The path an export is written to, with a relative path read against the
 * project (the window's convention: "a relative path is relative to the
 * project", not to the backend).
 *
 * @param {string} target
 * @param {string|null|undefined} root
 * @returns {string}
 */
export const resolveExportPath = (target, root = null) => {
  const raw = String(target ?? '').trim();
  if (!raw) throw new Error('no path given');
  if (path.isAbsolute(raw)) return path.resolve(raw);
  if (!root) return path.resolve(raw);
  return path.resolve(root, raw);
};

/**
 * Write an export, atomically, without holding the backend still.
 *
 * The shared swap (harness/atomic-write.mjs) is synchronous, and a session
 * is not small: one can be tens of megabytes, and writing that on the
 * request path would freeze every window call while it lands. So the same
 * three steps are taken with the async fs — a temp file no other writer
 * shares, the bytes fsynced, the rename that swaps it in — and the file is
 * owner-only, because a transcript is the person's own words.
 *
 * @param {string} target
 * @param {string} text
 * @returns {Promise<string>} the path that was written
 */
export async function writeExport(target, text) {
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  let handle = null;
  try {
    // 'wx' is O_CREAT|O_EXCL: the temp name must not be there already, or a
    // name another local user planted is a clean failure instead of a write
    // THROUGH it.
    handle = await fs.promises.open(tmp, 'wx', 0o600);
    await handle.writeFile(text, 'utf8');
    // The bytes have to be on the disk before the name that points at them
    // is swapped: a rename is atomic against a process crash, not against a
    // power cut.
    await handle.sync();
    await handle.close();
    handle = null;
    // The mode is pinned after the write: a umask takes bits off the one the
    // open asked for.
    await fs.promises.chmod(tmp, 0o600).catch(() => { /* best effort on Windows */ });
    await fs.promises.rename(tmp, target);
  } catch (err) {
    if (handle) { try { await handle.close(); } catch { /* already closed */ } }
    // A failed write leaves nothing behind.
    await fs.promises.rm(tmp, { force: true }).catch(() => { /* best effort */ });
    throw err;
  }
  return target;
}
