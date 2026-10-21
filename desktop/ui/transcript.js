// The transcript: what the reader sees in the conversation.
//
// The reply is painted as it streams: a settled stretch that only ever grows,
// and a moving tail that is rewritten. The tool rows, the notes and the folded
// reasoning live here too — everything that ends up in #log.
//
// The paint cache lives with the painter: a frame that leaves the settled
// layer standing is a hit, and only the tail re-parses.

import { renderMarkdown, splitMarkdownStable } from './md.js';
import { restoreText } from './waf-restore.js';
import { scan, transcript } from './markers.js';

/**
 * The transcript painter: the conversation, the tool rows, the notes.
 *
 * @param {object} ctx the window it draws into
 */
export function createTranscript(ctx) {
  const { el, log, state, scrollDown, atBottom, rpc } = ctx;


function addTask(text) {
  const msg = el('div', 'msg task');
  const body = el('div', 'body');
  body.append(el('span', null, text));
  msg.append(body);
  log.append(msg);
  scrollDown();
}

function addNote(text) {
  log.append(el('div', 'note', text));
  scrollDown();
}

/**
 * What a slash command printed. The conversation is dim by design, so command
 * output gets its own accent-barred line — otherwise "hard to see" is literally
 * true: a command that answers and cannot be found has not answered.
 */
function addCommandOut(text) {
  log.append(el('div', 'cmd-out', text));
  scrollDown();
}

function ensureAssistant() {
  if (state.assistant) return state.assistant;
  const msg = el('div', 'msg assistant');
  const body = el('div', 'body');
  msg.append(body);
  log.append(msg);
  // The settled stretch and the moving tail paint into two wrappers (`.seg`,
  // boxless by CSS): the window used to re-parse the whole reply per frame,
  // which is exactly the cost that grows with the answer. The cache fields
  // keep what has already been rendered, so a frame only touches the tail.
  state.assistant = { el: body, text: '', tail: '', stableEl: null, tailEl: null, stableText: '', stableHtml: '' };
  // The last bubble outlives the step boundary that closes it: the step's
  // headline comes after that boundary, and it is the first line of the prose
  // this bubble is already showing.
  state.lastBubble = state.assistant;
  return state.assistant;
}

/**
 * Whether the bubble is already showing this line.
 *
 * The step's headline is the first line of the model's reply, and the reply is
 * in the bubble. The comparison is per line and trimmed on both sides: the
 * harness hands over a trimmed line, the bubble holds the raw reply — and the
 * bubble's text is the wire spelling of it (the harness decodes the reply it
 * reads, the stream that painted the bubble did not), so both sides are put
 * back before they are compared.
 *
 * @param {{text: string}|null} bubble
 * @param {string} text
 * @returns {boolean}
 */
function bubbleSays(bubble, text) {
  const wanted = restoreText(String(text ?? '').trim());
  if (!bubble || !wanted) return false;
  return transcript(bubble.text, state.pluginTools)
    .split('\n')
    .some((l) => restoreText(l.trim()) === wanted);
}

/**
 * The bubble is the reply's prose — markers never render. Every call the model
 * made already showed up as its own tool row when the loop executed it, so
 * repeating "EDIT … END" inside the bubble would show one change twice, once
 * as wire protocol and once as the thing that happened. `tail` carries the
 * sentences appended out-of-band (the DONE summary), which are already clean
 * text and must not be scanned like a reply.
 */
/* The paint cache's account of itself. A frame that leaves the settled layer
 * standing is a hit — only the tail re-parses and the new settled text
 * appends. A frame that resets the layer (a late plugin report or DONE
 * summary rewrote earlier prose) is a miss, and `repainted` counts the
 * characters that had to come back through the renderer. `cold` frames had
 * nothing settled yet to save. The counters live for the window's lifetime;
 * `/paint` prints them, so "long answers feel slow" can answer with a number
 * instead of a shrug (test/ui.test.mjs). */
const paintCache = { paints: 0, hits: 0, misses: 0, cold: 0, appended: 0, repainted: 0 };

function paintCacheStats() {
  const warm = paintCache.hits + paintCache.misses;
  return { ...paintCache, hitRate: warm ? paintCache.hits / warm : null };
}

function paintAssistant(a) {
  // Painted as a settled stretch plus a moving tail (splitMarkdownStable):
  // the settled layer renders once and only ever gains text, so a frame
  // re-parses just the tail instead of the whole answer. A cache miss — the
  // rewrite a late plugin report or DONE summary can cause — resets the layer
  // and repaints it whole, once.
  const full = transcript(a.text, state.pluginTools) + a.tail;
  const { stable, tail } = splitMarkdownStable(full);
  paintCache.paints += 1;
  const kept = stable.startsWith(a.stableText);
  if (!a.stableText) paintCache.cold += 1;
  else if (kept) paintCache.hits += 1;
  else { paintCache.misses += 1; paintCache.repainted += a.stableText.length; }
  if (!kept) { a.stableText = ''; a.stableHtml = ''; }
  if (stable.length > a.stableText.length) {
    paintCache.appended += stable.length - a.stableText.length;
    const delta = renderMarkdown(stable.slice(a.stableText.length));
    a.stableHtml += (a.stableHtml ? '\n' : '') + delta;
    a.stableText = stable;
    if (!a.stableEl) {
      a.stableEl = el('div', 'seg md-stable');
      a.el.insertBefore(a.stableEl, a.tailEl);
    }
    // The settled layer is APPENDED to, never rewritten: assigning its
    // innerHTML re-parsed every paragraph that was already on screen, so a
    // long answer paid for its own prefix again on every block. The string
    // is still kept — it is what the layer is made of, and what a reset
    // (a late plugin report, a DONE summary) empties.
    if (typeof a.stableEl.insertAdjacentHTML === 'function') {
      a.stableEl.insertAdjacentHTML('beforeend', delta);
    } else {
      a.stableEl.innerHTML = a.stableHtml;
    }
  } else if (a.stableEl && !a.stableText) {
    a.stableEl.remove();
    a.stableEl = null;
  }
  const tailHtml = renderMarkdown(tail);
  if (tailHtml) {
    if (!a.tailEl) { a.tailEl = el('div', 'seg md-tail'); a.el.append(a.tailEl); }
    a.tailEl.innerHTML = tailHtml;
  } else if (a.tailEl) {
    a.tailEl.remove();
    a.tailEl = null;
  }
}

/**
 * Paints at most once per frame. The stream delivers dozens of deltas a
 * second and each one used to re-render the whole reply — a long answer spent
 * most of its time re-rendering its own prefix. Text accumulates as it
 * arrives; the queued frame paints the latest state once, and the queue holds
 * bubble objects, so a step that closed one bubble and opened the next still
 * paints both. With no frame clock (the test window) a 0 ms timeout stands in
 * — still a task later, so a burst inside one turn coalesces there too.
 */
const paintQueue = new Set();
let thinkingDirty = false;
let paintQueued = false;
const nextFrame = typeof requestAnimationFrame === 'function'
  ? requestAnimationFrame
  : (fn) => setTimeout(fn, 0);
function flushPaints() {
  paintQueued = false;
  const due = [...paintQueue];
  paintQueue.clear();
  // One layout read for the whole frame, before any of the writes below: the
  // per-paint scrollDown() used to force a synchronous layout per bubble, so
  // a frame with reasoning and prose paid for two. Whether the reader was at
  // the bottom is the same question for every write in the frame.
  const pinned = atBottom();
  for (const b of due) paintAssistant(b);
  if (thinkingDirty) {
    thinkingDirty = false;
    const t = state.thinking;
    // Reasoning only ever grows; appending what arrived beats reassigning the
    // whole text node per frame, which re-laid out a pre that can be long.
    if (t && t.text.length > t.painted) {
      // The fold shows the reasoning as it was written: a wire spelling (the
      // address a search brought back) goes back before the text is painted.
      // It still grows by appending — the restored text differs from what was
      // painted only when a spelling completed across a delta, and then the
      // tail is rewritten once.
      const restored = restoreText(t.text);
      if (restored.startsWith(t.shown)) {
        t.el.append(document.createTextNode(restored.slice(t.shown.length)));
      } else {
        t.el.textContent = restored;
      }
      t.shown = restored;
      t.painted = t.text.length;
    }
  }
  if (pinned) log.scrollTop = log.scrollHeight;
}
function queuePaint(bubble = null) {
  if (bubble) paintQueue.add(bubble); else thinkingDirty = true;
  if (paintQueued) return;
  paintQueued = true;
  nextFrame(flushPaints);
}

function assistantText(delta) {
  const a = ensureAssistant();
  a.text += delta;
  queuePaint(a);
}

/**
 * The sentence a DONE carried, said once. The streamed prose is already on
 * screen, so a summary the reader can already see is not repeated — the raw
 * reply shows "DONE …" nowhere (it is a marker), and the streamed prose above
 * it may well be the same sentence.
 */
function assistantSummary(text) {
  const a = ensureAssistant();
  const line = String(text ?? '').trim() || 'done';
  const visible = transcript(a.text, state.pluginTools).trim();
  if (visible && visible.toLowerCase().includes(line.toLowerCase())) return;
  a.tail += (visible ? '\n\n' : '') + line;
  paintAssistant(a);
  scrollDown();
}

/**
 * An assistant entry read back from a session log is a whole raw reply,
 * markers and all. The live path showed its prose plus the DONE summary the
 * loop harvested, so a replay reconstructs the same picture instead of a
 * bubble that ends mid-thought.
 */
function replayAssistant(raw) {
  const text = String(raw ?? '');
  assistantText(text);
  const done = scan(text, { plugins: state.pluginTools }).reverse().find((c) => c.kind === 'done');
  if (!done) return;
  assistantSummary(done.arg || transcript(text, state.pluginTools).trim() || 'done');
}

function thinkingText(delta) {
  if (!state.thinking) {
    const box = el('details', 'think');
    box.open = true;      // watch it think; the fold closes when the turn ends
    const summary = el('summary', null, '✻ reasoning…');
    const pre = el('pre');
    box.append(summary, pre);
    log.append(box);
    state.thinking = { el: pre, text: '', box, summary, since: Date.now(), painted: 0, shown: '' };
  }
  state.thinking.text += delta;
  queuePaint();
}

/** Like the terminal's steps: when the turn ends the reasoning folds away,
 *  leaving one line that says it happened and for how long. Each step gets its
 *  own fold — the assistant bubble is closed at the same moment, so a run
 *  reads as a sequence of steps instead of one balloon. */
function foldThinking() {
  const t = state.thinking;
  if (!t) return;
  const secs = Math.max(1, Math.round((Date.now() - t.since) / 1000));
  t.summary.textContent = `✻ reasoning · ${secs}s`;
  t.box.open = false;
  state.thinking = null;
}

function endTurn() {
  foldThinking();
  state.assistant = null;
}

/**
 * The run is over: fold its working trail — tool rows, step notes, folded
 * reasoning, the intermediate prose — into one collapsed line, so the closing
 * bubble is the answer and nothing else competes with it. Two kinds of row
 * stay in the open, because their buttons have to stay reachable when the run
 * stopped short: a step-limit "carry on" row and a no-chat-tab banner. Only a
 * run that ended with something to say (done or a question) folds; an error or
 * a stall keeps the whole trail visible — what went wrong is the result then.
 */
function foldRun(stopReason) {
  const start = state.runCursor;
  state.runCursor = null;
  if (start == null) return;
  if (!['done', 'ask'].includes(stopReason)) return;
  const kids = [...log.children].slice(start);
  if (!kids.length) return;

  // The closing bubble — the last assistant reply of the run — is the result.
  let result = null;
  for (let i = kids.length - 1; i >= 0; i--) {
    if (/\bassistant\b/.test(kids[i].className ?? '')) { result = kids[i]; break; }
  }
  const foldable = kids.filter((k) => k !== result && !/continue-row|needs-tab/.test(k.className ?? ''));
  if (!result || !foldable.length) return; // a plain Q&A turn has nothing to fold

  const wrap = el('details', 'run');
  wrap.open = false;
  wrap.append(el('summary', null, `✻ ระหว่างทำงาน · ${foldable.length} รายการ`));
  for (const k of foldable) wrap.append(k); // append moves the node
  log.insertBefore(wrap, result);
  result.classList.add('result');
  scrollDown();
}

/**
 * One line per tool call, opening to the detail. A run of ten steps has to read
 * as ten lines — what the model asked for and what it changed stay one click
 * away without filling the conversation. The label is the verb a reader would
 * use for the call ("Edit", "Run"), not the wire's kind name; the raw kind
 * stays in the row's tooltip.
 */
const TOOL_LABEL = {
  read: 'Read', list: 'List', search: 'Search', glob: 'Glob', run: 'Run',
  replace: 'Edit', write: 'Create', delete: 'Delete', move: 'Move',
  git: 'Git', fetch: 'Fetch', web: 'Web', skill: 'Skill', attach: 'Attach',
  plan: 'Plan', todo: 'Todo', subagent: 'Agent', plugin: 'Plugin',
  symbols: 'Symbols', def: 'Definition', refs: 'References', jobs: 'Jobs',
};

/**
 * The links a web search brought back, under the Web row.
 *
 * A search is the one tool whose result is a set of addresses, and the row
 * used to keep them to itself — the reader saw a line of prose about the web
 * and no way to reach any of it. Each source is a link the reader can open,
 * with the address in the text: a link that cannot be copied is a link that
 * cannot be used anywhere else.
 */
function sourceLinks(sources) {
  const box = el('div', 'sources');
  let n = 0;
  for (const s of Array.isArray(sources) ? sources : []) {
    const url = restoreText(String(s?.url ?? '').trim());
    if (!/^https?:\/\//i.test(url)) continue;
    const label = restoreText(String(s?.label ?? '').trim());
    // The address is the link's text, not just its target: a URL the reader
    // cannot see is a URL they cannot copy into another window.
    const a = el('a', 'md-link', url);
    a.href = url;
    a.title = label ? `${label} — ${url}` : url;
    box.append(a);
    n++;
  }
  return n ? box : null;
}

/**
 * A link in the chat opens in the browser, not in this window.
 *
 * The window is a webview on the app's own page: a link that navigated it
 * would take the app away with it, and the shell has no opener of its own.
 * So the click goes to the backend, which checks the address and opens it in
 * Chrome — where the reader's other tabs are, and where the extension lives.
 */
log.addEventListener('click', (ev) => {
  const a = ev.target?.closest?.('.md-link');
  if (!a) return;
  const href = String(a.href ?? '').trim();
  if (!/^https?:\/\//i.test(href)) return;
  ev.preventDefault?.();
  rpc('browser.open', { url: href }).catch(() => {});
});

function addTool({ kind, arg, ok, head, lines = [], sources = [] }) {
  const row = document.createElement('details');
  row.className = ok ? 'tool' : 'tool bad';
  row.title = kind;
  const summary = el('summary');
  summary.append(el('span', 'mark', ok ? '⏺' : '✗'));
  summary.append(el('span', 'kind', TOOL_LABEL[kind] ?? kind));
  if (arg) summary.append(el('span', 'arg', String(arg)));
  if (head) summary.append(el('span', 'head', restoreText(head)));
  row.append(summary);
  if (lines.length) row.append(el('pre', null, restoreText(lines.map((line) => String(line)).join('\n'))));
  const links = sourceLinks(sources);
  if (links) {
    row.append(links);
    // The links are the point of a search row, so it opens on its own.
    row.open = true;
  }
  log.append(row);
  scrollDown();
}


  return { addTask, addNote, addCommandOut, assistantText, assistantSummary, replayAssistant, thinkingText, foldThinking, endTurn, foldRun, addTool, paintCacheStats, bubbleSays };
}

export default createTranscript;
