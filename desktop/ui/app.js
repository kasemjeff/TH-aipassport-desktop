/* aipass desktop — the window.
 *
 * All state lives on the backend (`/rpc`); this file is a view. Runs survive a
 * reload because the session log is on disk, and the live run streams in over
 * `/events` — the window only has to render what it is told.
 */
import { renderMarkdown, splitMarkdownStable } from './md.js';
import { scan, transcript } from './markers.js';

const $ = (id) => document.getElementById(id);
const log = $('log');

/* ------------------------------------------------------------------- rpc */

// When the backend asks for one — AIPASS_REQUIRE_AUTH, the default — every
// /rpc and /events call needs the loopback token. The window is a same-origin
// page served by that same backend, so it asks /token for it once at boot
// instead of anyone pasting a file; when auth is off the endpoint refuses and
// authToken stays null, which is exactly the bare-request shape used before.
let authToken = null;

async function fetchToken() {
  try {
    const res = await fetch('/token');
    if (!res.ok) return null;
    const body = await res.json();
    return typeof body.token === 'string' && body.token ? body.token : null;
  } catch {
    return null;
  }
}

async function rpc(method, params = {}) {
  const send = () => fetch('/rpc', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(authToken ? { authorization: `Bearer ${authToken}` } : {}),
    },
    body: JSON.stringify({ method, params }),
  });
  let res = await send();
  // A 401 on a token-less call means the boot fetch lost a race (or the
  // backend restarted between page load and now): fetch once more and retry,
  // but only when that actually changes what we would send.
  if (res.status === 401) {
    const fresh = await fetchToken();
    if (fresh && fresh !== authToken) { authToken = fresh; res = await send(); }
  }
  const body = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  if (!body.ok) {
    // A failure that knows its step carries it, so the caller can say which
    // door closed instead of only that something did.
    const err = new Error(body.error ?? 'rpc failed');
    if (body.stage) err.stage = body.stage;
    throw err;
  }
  return body.result;
}

/* ---------------------------------------------------------------- helpers */

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

/** The line under the composer: '' hides it; busy adds the pulsing dot. */
const setHint = (text, busy = false) => {
  const h = $('hint');
  h.textContent = text ?? '';
  h.classList.toggle('busy', Boolean(busy && text));
};

/** Make a list row behave like a button: click, Enter and Space all run it. */
const clickable = (row, run) => {
  row.onclick = run;
  row.tabIndex = 0;
  row.setAttribute('role', 'button');
  row.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); run(ev); }
  });
  return row;
};

/* The loop's common failures, said in the language the person reads, each with
   its single next action. Anything unlisted passes through untouched — an
   unknown error is better verbatim than guessed at. */
const ERROR_COPY = [
  [/no extension connected/i, 'ยังไม่มี extension เชื่อมอยู่ — เปิด Chrome แล้วคลิกไอคอน aipass bridge'],
  [/no de\.aipass\.net tab is open/i, 'ยังไม่มีแท็บ de.aipass.net ที่ล็อกอิน — เปิดแท็บนั้นแล้วลองใหม่'],
  [/needs a token|unauthorized|401|403/i, 'bridge ปฏิเสธ token — เปิด popup ของ extension แล้ววาง token จาก ~/.aipass/.token'],
  [/ECONNREFUSED|fetch failed|bridge offline/i, 'bridge ไม่ทำงาน — เริ่มด้วยคำสั่ง aipass ก่อน'],
  [/a run is already in flight/i, 'มี run ค้างอยู่ — กดหยุดก่อนแล้วค่อยส่งใหม่'],
  [/outside project root/i, 'path อยู่นอกโปรเจกต์ — ใช้ไฟล์ในโปรเจกต์เท่านั้น'],
  // The wall every free-tier run eventually hits: quota.available is 0 while
  // the limit is not — distinguishable from "no tab" (which never returns a
  // number at all) so the banner can say which fix applies.
  [/credit|quota|0 of .* left|insufficient/i, 'เครดิตหมด (0) — รอรอบถัดไป หรือสลับไปใช้โมเดล free-credit (gemini-3.1-flash-lite)'],
];
const friendly = (msg) => {
  const s = String(msg ?? '');
  for (const [re, copy] of ERROR_COPY) if (re.test(s)) return copy;
  return s;
};
/** The step a refusal closed, in the words the person is reading in. */
const STAGE_COPY = {
  plan: 'คำสั่งติดตั้ง',
  fetch: 'ดึงไฟล์',
  validate: 'ตรวจโค้ด',
  name: 'ชื่อปลั๊กอิน',
  swap: 'สลับไฟล์',
  finalize: 'โหลดปลั๊กอินใหม่',
};
const stageLabel = (stage) => STAGE_COPY[stage] ?? stage;
/** Follow the conversation only while the reader is already at the bottom.
 *  Scrolling up to read something and being yanked back down by the next line
 *  is the kind of small thing that makes a window feel hostile. */
const atBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight < 80;
const scrollDown = (force = false) => {
  if (force || atBottom()) log.scrollTop = log.scrollHeight;
};

const state = {
  // The project this window shows. rpc tags every run event with the project
  // that emitted it, and the window drops events tagged for another one (see
  // onRun); it also rides every run/cancel call, so the backend runs where the
  // window is looking even if another window moved it since (rpc.mjs run).
  root: null,
  running: false,
  assistant: null,      // { el, text, tail }
  thinking: null,       // { el, text, box, summary, since }
  pending: new Map(),   // file → {checked, added, removed, deleted, isNew}
  attachments: new Map(), // id → {name, bytes, mime}
  sessionId: null,
  settings: null,
  // Which provider the run talks to: the built-in AiPASS one (the local
  // bridge and its tab) or an added API provider. The picker is the switch.
  provider: 'aipass',
  providers: [],
  plugins: null,
  pluginTools: [],      // {marker, takesBody} — what the transcript must hide
  needsTab: false,      // the last run could not proceed for want of a chat tab
  needsCompaction: false, // the budget is close to full and a rotation is coming
  runCursor: null,      // where in the log the live run's rows begin
  stopping: false,      // a stop was asked for; the run is winding down
};

/* -------------------------------------------------------------- transcript */

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
  return state.assistant;
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
    a.stableHtml += (a.stableHtml ? '\n' : '') + renderMarkdown(stable.slice(a.stableText.length));
    a.stableText = stable;
    if (!a.stableEl) {
      a.stableEl = el('div', 'seg md-stable');
      a.el.insertBefore(a.stableEl, a.tailEl);
    }
    a.stableEl.innerHTML = a.stableHtml;
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
      t.el.append(document.createTextNode(t.text.slice(t.painted)));
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
    state.thinking = { el: pre, text: '', box, summary, since: Date.now(), painted: 0 };
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

function addTool({ kind, arg, ok, head, lines = [] }) {
  const row = document.createElement('details');
  row.className = ok ? 'tool' : 'tool bad';
  row.title = kind;
  const summary = el('summary');
  summary.append(el('span', 'mark', ok ? '⏺' : '✗'));
  summary.append(el('span', 'kind', TOOL_LABEL[kind] ?? kind));
  if (arg) summary.append(el('span', 'arg', String(arg)));
  if (head) summary.append(el('span', 'head', head));
  row.append(summary);
  if (lines.length) row.append(el('pre', null, lines.map((line) => String(line)).join('\n')));
  log.append(row);
  scrollDown();
}

/* ------------------------------------------------------------------ panel */

// The PLAN/TODO card is one element for the whole session: built on the first
// todo, re-tallied after that, removed when the session changes. It lives
// outside #log (directly before #pending), so folding the run's trail never
// swallows it — and its list scrolls inside a bounded box (styles.css), so a
// plan of fifty items no longer pushes the conversation off the screen.
let todoPanel = null;
let todoHead = null;
let todoList = null;
let todoRows = []; // [{ li, text }] — lets an unchanged row stay put across updates

/** Drop the plan/todo card — a new session must not show the old one's plan. */
function clearTodo() {
  if (!todoPanel) return;
  todoPanel.remove();
  todoPanel = null;
  todoHead = null;
  todoList = null;
  todoRows = [];
}

function renderTodo(items) {
  // A todo frame is wire data; a malformed one is dropped, never a crash in
  // the middle of the run's stream.
  if (!Array.isArray(items)) return;
  const list = items.map((it) => ({ text: String(it?.text ?? ''), done: Boolean(it?.done) }));
  if (!todoPanel) {
    todoPanel = el('div', 'panel');
    todoPanel.id = 'todo-panel';
    todoHead = el('h4', null, 'plan & todo');
    todoList = el('ul');
    todoPanel.append(todoHead, todoList);
    // #chat contains #pending, so this is the same slot as "before #pending" —
    // spelled with insertBefore because the test suite's fake DOM has no before().
    $('chat').insertBefore(todoPanel, $('pending'));
  }
  const total = list.length;
  const done = list.filter((it) => it.done).length;
  todoHead.textContent = `plan & todo · ${done}/${total}`;
  todoPanel.classList.toggle('complete', total > 0 && done === total);
  // Ticks move constantly while a run works. When the same rows are still
  // there, update them where they stand — a full rebuild on every step makes
  // the card flicker and resets the list's scroll position.
  const same = todoRows.length === list.length && list.every((it, i) => todoRows[i].text === it.text);
  if (same) {
    list.forEach((it, i) => {
      todoRows[i].li.classList.toggle('done', it.done);
      todoRows[i].li.children[0].textContent = it.done ? '☑' : '☐';
    });
    return;
  }
  const keepScroll = todoList.scrollTop;
  todoList.textContent = '';
  todoRows = list.map((it) => {
    const li = el('li', it.done ? 'done' : '');
    li.append(el('span', 'box', it.done ? '☑' : '☐'), el('span', null, it.text));
    todoList.append(li);
    return { li, text: it.text };
  });
  todoList.scrollTop = keepScroll;
}

function renderPending(changes) {
  const wrap = $('pending');
  const list = $('pending-list');
  state.pending.clear();
  for (const c of changes ?? []) state.pending.set(c.file, { ...c, checked: true });

  $('pending-count').textContent = `${state.pending.size} change${state.pending.size === 1 ? '' : 's'}`;
  list.textContent = '';
  for (const [file, info] of state.pending) {
    const li = el('li');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = info.checked;
    box.onchange = () => { info.checked = box.checked; };
    li.append(box, el('span', null, file + (info.isNew ? ' (new)' : info.deleted ? ' (deleted)' : '')));
    const counts = el('span', 'counts');
    counts.append(el('span', 'add', `+${info.added} `), el('span', 'del', `−${info.removed}`));
    li.append(counts, el('span', 'grow'));
    const view = el('button', null, 'diff');
    view.onclick = () => showDiff(file);
    li.append(view);
    list.append(li);
  }
  wrap.classList.toggle('hidden', state.pending.size === 0);

  // The verdict badge: what Apply is about to write was checked by something
  // other than the run itself, or it was not. A turn in flight is skipped —
  // its verdict arrives with 'finished'.
  const badge = $('pending-check');
  const verdict = state.lastCheck?.verdict ?? null;
  const show = state.pending.size > 0 && !state.running;
  badge.textContent = !show ? ''
    : verdict === 'pass' ? '✓ ตรวจผ่าน'
      : verdict === 'fail' ? '✗ ตรวจไม่ผ่าน'
        : '⚠ ยังไม่ผ่านการตรวจ';
  badge.className = `check-badge ${verdict === 'pass' ? 'pass' : verdict === 'fail' ? 'fail' : 'none'}${show ? '' : ' hidden'}`;
}

async function showDiff(file) {
  const change = await rpc('diff', { file }).catch((err) => ({ error: err.message }));
  const body = $('modal-body');
  body.textContent = '';
  if (change.error) {
    body.append(el('p', null, change.error));
  } else {
    const pre = el('pre');
    for (const line of String(change.diff).split('\n')) {
      const cls = line.startsWith('+') && !line.startsWith('+++') ? 'diff-line add'
        : line.startsWith('-') && !line.startsWith('---') ? 'diff-line del'
          : line.startsWith('@@') ? 'diff-line hunk' : 'diff-line';
      pre.append(el('div', cls, line));
    }
    body.append(el('p', 'dim', `${file}  +${change.added} −${change.removed}${change.isNew ? '  (new file)' : ''}`), pre);
  }
  $('modal-title').textContent = 'changes';
  const actions = $('modal-actions');
  actions.textContent = '';
  const close = el('button', 'primary', 'close');
  close.onclick = hideModal;
  actions.append(close);
  $('modal').classList.remove('hidden');
}

function hideModal() {
  $('modal').classList.add('hidden');
  $('modal').classList.remove('settings-sheet');
}

/* ------------------------------------------------------------ permissions */

function askPermission({ id, kind, arg, risk, project = null }) {
  $('modal-title').textContent = `${risk === 'shell' ? 'run this command' : 'change this file'}?`;
  const body = $('modal-body');
  body.textContent = '';
  body.append(el('p', null, arg || kind));
  if (risk === 'shell') {
    const pre = el('pre', null, arg || '');
    body.textContent = '';
    body.append(el('p', 'dim', 'shell command the model wants to run'), pre);
  }
  const foreign = foreignProject(project);
  if (foreign) body.append(el('p', 'dim', `จากโปรเจกต์อื่น (${foreign}) — คำตอบนี้ไปถึง run ของโปรเจกต์นั้น`));

  const actions = $('modal-actions');
  actions.textContent = '';
  // The answer routes by the request's project: with two windows open, this
  // question may belong to the project that is not the backend's current one.
  const answer = (decision) => { hideModal(); rpc('permission.answer', { id, decision, ...(project ? { project } : {}) }); };
  const deny = el('button', null, 'deny');
  deny.onclick = () => answer('deny');
  const allow = el('button', 'primary', 'allow');
  allow.onclick = () => answer('allow');
  const always = el('button', null, 'always');
  always.onclick = () => answer('always');
  actions.append(deny, always, allow);
  $('modal').classList.remove('hidden');
}

function askPlan(project = null) {
  $('modal-title').textContent = 'start this plan?';
  const body = $('modal-body');
  body.textContent = '';
  body.append(el('p', null, 'The model wrote a plan. Approve it and the work begins; decline and the run stops before any change.'));
  const foreign = foreignProject(project);
  if (foreign) body.append(el('p', 'dim', `จากโปรเจกต์อื่น (${foreign}) — คำตอบนี้ไปถึง run ของโปรเจกต์นั้น`));
  const actions = $('modal-actions');
  actions.textContent = '';
  const no = el('button', null, 'decline');
  no.onclick = () => { hideModal(); rpc('plan.answer', { ok: false, ...(project ? { project } : {}) }); };
  const yes = el('button', 'primary', 'approve');
  yes.onclick = () => { hideModal(); rpc('plan.answer', { ok: true, ...(project ? { project } : {}) }); };
  actions.append(no, yes);
  $('modal').classList.remove('hidden');
}

/** A gate the reload swallowed: the run is still waiting on an answer. */
function restoreAsks(asks) {
  if (asks.plan) { askPlan(); return; }
  const list = asks.permissions ?? [];
  if (!list.length) return;
  askPermission(list[0]);
  if (list.length > 1) addNote(`มีคำถามรออนุมัติอีก ${list.length - 1} รายการ — ตอบข้อนี้ก่อน`);
}

/* ------------------------------------------------------------------ events */

// EventSource cannot set headers, so the token (when there is one) rides the
// URL — rpc.mjs accepts `?token=` on /events. This resolves before the stream
// opens: a window under auth never starts in a 401 reconnect loop.
authToken = authToken ?? (await fetchToken());
const stream = new EventSource(authToken ? `/events?token=${encodeURIComponent(authToken)}` : '/events');

// The transport, not the run. When the backend process goes away the stream
// drops and the window used to sit there with a live spinner on a run that no
// longer existed. Now it says so, and gives the run a deadline: if nothing
// arrives for a while, the run is treated as lost rather than hanging forever.
let lastEventAt = Date.now();
stream.addEventListener('open', () => { lastEventAt = Date.now(); void restoreFromSnapshot(); });
stream.addEventListener('message', () => { lastEventAt = Date.now(); });
// rpc.mjs sends a named ping every 15 s precisely so this watchdog reads
// "the backend died", not "the model went quiet": a long RUN or SEARCH streams
// no other frames for a while, and nothing else here refreshes the clock.
stream.addEventListener('ping', () => { lastEventAt = Date.now(); });

/**
 * Put the window back where it was after a reload or a reconnect.
 *
 * The stream itself replays what this listener missed — the backend keeps the
 * last frames and a reconnect carries `Last-Event-ID` — but that only covers
 * the live tail. The parts of the state that live in the session log on disk
 * (a run that finished before the reload, a session opened yesterday) are
 * asked for here, so a window that was reloaded mid-run comes back looking
 * like the run it left instead of a blank page. A window that merely
 * reconnected — the log is not empty — gets the pending list refreshed and
 * nothing redrawn.
 */
async function restoreFromSnapshot() {
  const snap = await rpc('snapshot').catch(() => null);
  if (!snap) return;
  state.sessionId = snap.session?.id ?? null;
  if (!state.sessionId) return;
  // A fresh window adopts the backend's project — the same one its picker
  // shows. Only when the log is empty: on a mid-session reconnect the window
  // keeps showing the project the human chose, even if another window has
  // since moved the backend (rpc.mjs run binds runs to the window's root).
  if (!log.childNodes.length && snap.status?.root) state.root = snap.status.root;
  if (log.childNodes.length) { renderPending(snap.pending); refreshMeter(); restoreAsks(snap.asks ?? {}); return; }
  for (const entry of snap.entries ?? []) {
    if (entry.type === 'task') addTask(entry.text);
    else if (entry.type === 'assistant') replayAssistant(entry.text ?? '');
    // A tool entry is the replay's step boundary: the reply above it is done
    // and the next assistant entry starts a new bubble, the way the live
    // stream splits them at every `step` event.
    else if (entry.type === 'todo' && Array.isArray(entry.items)) renderTodo(entry.items);
    else if (entry.type === 'tool') { addTool({ kind: entry.kind, arg: entry.arg, ok: entry.ok, head: '' }); state.assistant = null; }
    else if (entry.type === 'note') addNote(entry.text);
  }
  endTurn();
  renderPending(snap.pending);
  refreshMeter();
  restoreAsks(snap.asks ?? {});
  // The run may still be in flight when the window reloaded: say so, instead of
  // looking idle while the backend waits on a gate nobody can see.
  if (snap.status?.running) { state.running = true; $('send').textContent = 'หยุด'; setHint('ทำงานอยู่…', true); }
  await refreshSessions();
}

stream.onerror = () => {
  if (stream.readyState === EventSource.CONNECTING) {
    addNote('backend ตัดการเชื่อม — กำลังลองเชื่อมใหม่…');
  }
};

// Every event refreshes the watchdog; a run that stops sending anything is
// reported as lost instead of blocking the composer forever.
setInterval(() => {
  if (!state.running) return;
  if (Date.now() - lastEventAt > 20_000) {
    state.running = false;
    state.stopping = false;
    $('send').textContent = 'ส่ง';
    setHint('');
    // The window has written the run off; the backend is told as well, so the
    // next task does not bump into a run that is still in flight there ("a run
    // is already in flight" was what a lost run looked like from the composer).
    rpc('cancel', { root: state.root ?? undefined }).catch(() => {});
    addNote('run นี้เงียบไป 20 วินาที — ถือว่าหยุดแล้ว (backend อาจหลุด) · ลองส่งใหม่ หรือเช็ค aipass doctor');
    refreshMeter();
  }
}, 5_000);

/* Which project an event belongs to ---------------------------------------
 *
 * Every run event carries the project that emitted it (rpc.mjs tags harness
 * events with the project root). A window shows one project at a time; a run
 * left going in another project must not paint here — its `step` would fold
 * this answer, its `done_line` would end this turn, its tool rows would trail
 * prose they never followed. `onRun` drops everything tagged for another
 * project; untagged events come from the backend itself (settings, project
 * list) and always pass.
 *
 * Two families listen with `onAny` instead, because they are not this
 * window's transcript: the chat-tab banner (one shared tab serves every
 * project, and one click fixes all of them) and the permission/plan questions
 * — a dropped question would leave that run waiting on an answer nobody can
 * see. Those name the other project so the answer is never blind.
 */
const sameProject = (a, b) => String(a).replace(/\\/g, '/').toLowerCase() === String(b).replace(/\\/g, '/').toLowerCase();

/** null when the event belongs to this window's project; otherwise the
 *  project's folder name, for the answer surfaces that show anyway. */
function foreignProject(project) {
  if (!project || !state.root || sameProject(project, state.root)) return null;
  return String(project).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || String(project);
}

function onRun(name, fn) {
  stream.addEventListener(name, (e) => {
    const data = JSON.parse(e.data);
    if (data.project && state.root && !sameProject(data.project, state.root)) return;
    // A run's frames name the session that run writes to (rpc.mjs tags them
    // at the harness boundary). A window showing a different session must not
    // take them: an `assistant_delta` would write a running task into an old
    // transcript, a `finished` would fold a trail that is not on screen. The
    // `session` announcement is the one exception — adopting the new id is
    // exactly how the window follows a run that opens a session. Untagged
    // frames are backend-level and always pass.
    if (name !== 'session' && data.session && state.sessionId && data.session !== state.sessionId) return;
    fn(data, e);
  });
}

function onAny(name, fn) {
  stream.addEventListener(name, (e) => fn(JSON.parse(e.data), e));
}

/**
 * How a run's ending reads in the window. The backend's word belongs to the
 * transcript and the stats; the person in front of the window reads Thai — and
 * a stop has to say plainly that the work stopped, because that is the whole
 * point of pressing the button.
 */
const STOP_REASON = {
  cancelled: 'หยุดแล้ว',
  'plan-rejected': 'แผนไม่ผ่าน — หยุดก่อนแก้อะไร',
  error: 'รันพัง',
  stalled: 'ค้าง — หยุด',
  stagnation: 'ค้าง — หยุด',
  'credit-limited': 'โควตตาเกิด — หยุด',
  'tools-limited': 'เครื่องมือครบโควตา — หยุด',
  'time-limited': 'หมดเวลา — หยุด',
  steps: 'ครบจำนวนรอบ',
  'done-unverified': 'เสร็จแต่ยังไม่ผ่านการตรวจ',
};

onRun('task_start', (data) => {
  addTask(data.task);
  hideWelcome();
  // Everything appended from here until `finished` is this run's working
  // trail; foldRun() picks it up by this mark so an earlier turn is untouched.
  state.runCursor = log.children.length;
  refreshMeter();
  lastEventAt = Date.now();
});

// A run that cannot proceed because no logged-in chat tab is open is the one
// failure with a one-click fix, so it gets a banner instead of a log line.
onAny('needs_tab', (data) => {
  const { url } = data;
  state.needsTab = true;
  refreshReadiness();
  const bar = el('div', 'note needs-tab');
  bar.append(el('span', null, 'bridge ต้องมีหน้า chat ที่ล็อกอินอยู่ — '));
  const open = el('button', 'mini', 'เปิดให้');
  open.onclick = () => rpc('browser.open', { url }).catch(() => {});
  bar.append(open, el('span', null, `  (${url})`));
  log.append(bar);
  scrollDown();
});
onAny('tab_opened', (data) => {
  state.needsTab = false;
  addNote(`เปิด ${data.url} ในบราวเซอร์แล้ว — รอสักครู่แล้วส่งใหม่`);
  refreshReadiness();
});
onRun('assistant_delta', (data) => assistantText(data.text));
onRun('reasoning_delta', (data) => thinkingText(data.text));
onRun('step', (data) => {
  const { step, maxSteps, elapsed } = data;
  // A step is a boundary: the reply that just streamed is finished and its
  // tools are about to land, so its bubble and reasoning fold close here.
  // Without this reset one balloon collects every step of a run and the tool
  // rows trail prose that was written after them.
  foldThinking();
  state.assistant = null;
  addNote(maxSteps > 0 ? `step ${step}/${maxSteps} · ${elapsed}s` : `step ${step} · ${elapsed}s`);
});
onRun('thinking', (data) => {
  const { text } = data;
  log.append(el('div', 'thinking', '⎿ ' + text));
  scrollDown();
});
onRun('tool', (data) => addTool(data));
onRun('note', (data) => addNote(data.text));
onRun('firewall_note', (data) => addNote(data.text));
onRun('nudge', (data) => addNote(`no marker in that reply — nudging (${data.n}/2)`));
onRun('give_up', () => addNote('no marker after three replies — stopping.'));
onRun('ignore_done', () => addNote('(ignoring DONE — it came before the results it asked for)'));
onRun('stagnation', (data) => {
  const { action, pattern } = data;
  const what = pattern === 'oscillation' ? 'สองคำสั่งสลับกันไปมา' : 'คำสั่งเดิมซ้ำ';
  addNote(action === 'stop' ? `ลูปไม่เดินหน้า (${what}) — หยุดให้แล้ว` : `ลูปไม่เดินหน้า (${what}) — สั่งให้เปลี่ยนวิธีแล้ว`);
});
onRun('verify_prompt', () => addNote('ขอให้โมเดลพิสูจน์สิ่งที่แก้ก่อนจบ — รันเช็ค หรืออ่านการแก้กลับมา'));
onRun('check_start', (data) => addNote(`ก่อนรับ DONE — ให้ read-only child ตรวจงานที่ค้างอยู่ (${data.files.length} ไฟล์)`));
onRun('check_end', (data) => {
  const { verdict, ran, skipped } = data;
  const what = skipped ? 'ข้ามการตรวจ — เปิด conversation แยกไม่สำเร็จ'
    : verdict === 'pass' ? `ตรวจผ่านแล้ว (${ran} command)`
      : verdict === 'fail' ? `ตรวจไม่ผ่าน (${ran} command) — ส่งผลให้โมเดลแก้ต่อ`
        : 'ตรวจแล้ว ไม่มีคำสั่งให้รัน';
  addNote(what);
});
/** A stopped run is a dead end unless the next move is offered: "carry on" is
 *  one click instead of retyping what to do next. */
function offerCarryOn(what) {
  const row = el('div', 'note continue-row');
  row.append(el('span', null, what));
  const on = el('button', 'mini', 'ให้ทำต่อ');
  on.onclick = () => {
    row.remove();
    sendTask('Continue where you left off — pick up the outstanding work and finish it.');
  };
  row.append(on);
  log.append(row);
  scrollDown();
}
onRun('step_limit', () => {
  addNote('reached the step limit');
  offerCarryOn('หยุดเพราะใช้ครบ step — ');
});
// With no step cap set, a spent budget is what ends a long run — the same dead
// end the step limit used to be, so it gets the same way out.
onRun('budget', (data) => {
  const { used } = data;
  addNote(`budget spent (${used}) — stopping`);
  offerCarryOn(`หยุดเพราะครบ budget (${used}) — `);
});
onRun('error', (data) => addNote(`error: ${friendly(data.message)}`));
onRun('todo', (data) => renderTodo(data.items));
onRun('diff_update', (data) => renderPending(data.changes));
// The questions show regardless of project: dropping one would leave that run
// waiting on an answer nobody can see. Their body names the other project, and
// the answer routes back by it (rpc.mjs permission.answer / plan.answer).
onAny('permission_request', (data) => askPermission(data));
onAny('plan_request', (data) => askPlan(data.project));
onRun('compacted', (data) => {
  const { summary } = data;
  addCommandOut(`context เต็ม — สรุปงานที่ผ่านมาแล้วไว้ในบทสนทนาใหม่`);
  // The summary is what survives the rotation. Showing it turns an
  // "it forgot everything" moment into "it carried this forward, and I can see
  // what it chose to carry".
  if (summary) {
    const box = el('div', 'compaction-card');
    box.append(el('h4', null, 'สิ่งที่ยังจำอยู่หลัง rotation'));
    box.append(el('div', 'summary', summary));
    log.append(box);
  }
  scrollDown();
});
onRun('helper_start', (data) => addNote(`helper started: ${data.task}`));
onRun('helper_end', (data) => {
  const { summary, prepared, skipped } = data;
  addNote(`helper finished${prepared?.length ? `, prepared ${prepared.length} file(s) for approval` : ''}${skipped?.length ? `, left ${skipped.length} file(s) alone (a newer version was already staged)` : ''}: ${summary}`);
});
onRun('done_line', (data) => {
  const { text, extra } = data;
  assistantSummary(text || 'done');
  if (extra) assistantSummary(extra);
  endTurn();
});
onRun('plugin_call', (data) => {
  const { marker, arg } = data;
  addNote(`plugin ${marker} ${arg}`.trim());
});
// (stop) The backend heard the stop. The run winds down — the tool in flight
// ends on its own — so the window says so at once: pressing stop used to
// paint nothing at all, and the button looked broken until the run ended.
onRun('cancelled', (data) => {
  if (data?.running === false) return; // there was no run to stop
  state.stopping = true;
  $('send').textContent = 'กำลังหยุด…';
  setHint('กำลังหยุด…', true);
  addNote('รับคำสั่งหยุดแล้ว — กำลังจบงานที่กำลังทำอยู่');
});
onRun('finished', async (data) => {
  const { summary, stopReason, spent, credits, check, todo } = data;
  // The run's verdict rides the pending panel: the badge under the change
  // list says whether Apply is about to write something a check passed.
  state.lastCheck = check ?? null;
  endTurn();
  foldRun(stopReason);
  state.running = false;
  state.stopping = false;
  $('send').textContent = 'ส่ง';
  setHint('');
  refreshMeter();
  if (credits) addNote(`credits  ${credits.available?.toLocaleString?.() ?? credits.available} of ${credits.limit?.toLocaleString?.() ?? credits.limit} left${spent > 0 ? ` · ${spent.toLocaleString()} this run` : ''}`);
  if (stopReason !== 'done') addNote(STOP_REASON[stopReason] ?? `stopped: ${stopReason}`);
  // The checklist's account of the run: the card re-tallies from the final
  // state, and a completed run that still leaves items open says how many and
  // offers the one-click way back in — a plan that ended "done" with open
  // items used to just go quiet. A declined plan (plan-rejected) never gets
  // the offer: that run did what it was told.
  if (Array.isArray(todo) && todo.length) renderTodo(todo);
  if (stopReason === 'done' && Array.isArray(todo) && todo.length) {
    const open = todo.filter((it) => !it?.done).length;
    if (open) {
      addNote(`เช็คลิสต์ยังเหลือ ${open} จาก ${todo.length} รายการ`);
      offerCarryOn('แผนยังเหลือ — ');
    } else {
      addNote(`เช็คลิสต์ครบแล้ว (${todo.length}/${todo.length} รายการ)`);
    }
  }
  // Attachments belong to the message they were sent with.
  for (const id of state.attachments.keys()) rpc('attachment.remove', { id }).catch(() => {});
  state.attachments.clear();
  renderAttachments();
  // Repaint every panel the sidebar holds, in place — a finished run is exactly
  // when the scratchpad's history changed.
  for (const box of $('plugin-panels').children) if (box.dataset.panel) await paintPanel(box, box.dataset.panel);
  await refreshPending();
});
onRun('applied', (data) => {
  const { written, deleted, files } = data;
  addNote(`applied  ${written ?? 0} written, ${deleted ?? 0} deleted${files?.length ? ` — ${files.join(', ')}` : ''}`);
  renderPending([]);
  // The panel is a picture of the tree from a moment ago: without this, a file
  // that just landed on disk stays invisible until a reload.
  void refreshFiles();
});
onRun('discarded', () => { renderPending([]); addNote('discarded.'); });
onRun('session', (data) => {
  const s = data;
  state.sessionId = s.id;
  refreshMeta(s);
});

/** The line above the conversation: what session this is, on what model. */
function refreshMeta(s = null) {
  const model = $('model').value || state.settings?.defaultModel || '';
  // The provider only shows when it is not the built-in one: the header is
  // read often, and "AiPASS" on every line of every session is noise.
  const provider = $('provider').value || state.provider || '';
  const file = s?.file ? s.file.split(/[\\/]/).slice(-2).join('/') : '';
  $('meta').textContent = [
    s?.title ?? 'บทสนทนาใหม่',
    provider && provider !== 'aipass' ? provider : '',
    model,
    s?.id ? `#${s.id.slice(0, 6)}` : '',
    file,
  ].filter(Boolean).join('  ·  ');
}

/* -------------------------------------------------------------- composer */

// One task can be started, cancelled, and re-started from three places: the
// form, the button and the Enter key. They all land here so the rules live in
// one spot — Enter sends, Shift+Enter is a newline, and while a run is live the
// same controls stop it instead.
/* A typed paragraph lost to a stray reload is a small betrayal, so the draft
   lives in the window's storage and comes back on the next boot. */
const DRAFT_KEY = 'aipass.draft';
const loadDraft = () => {
  try { return localStorage.getItem(DRAFT_KEY) ?? ''; } catch { return ''; }
};
const saveDraft = () => {
  try { localStorage.setItem(DRAFT_KEY, $('task').value); } catch { /* storage off */ }
};
$('task').addEventListener('input', saveDraft);
$('task').value = loadDraft();

async function sendTask(seed = null) {
  const text = (seed ?? $('task').value).trim();
  if (!text) return;

  // A line that starts with "/" is a command, not a message — that is how the
  // whole app stays reachable from the keyboard. Commands run while a turn is in
  // flight too: /stop and /status are the two you want exactly then.
  if (text.startsWith('/')) {
    const [name, ...rest] = text.slice(1).split(/\s+/);
    const arg = rest.join(' ').trim();
    const item = COMMANDS.find((c) => c.cmd === name.toLowerCase());
    $('task').value = '';
    closeSlash();
    hideWelcome();
    if (item) { void runCommand(item, arg); return; }
    addNote(`ไม่มีคำสั่ง /${name} — พิมพ์ / ลงไปดูรายการ`);
    return;
  }

  if (state.running) return;
  $('task').value = '';
  closeSlash();
  state.running = true;
  state.stopping = false;
  state.lastCheck = null; // a fresh run's verdict is not the old run's
  $('send').textContent = 'หยุด';
  setHint('ทำงานอยู่…', true);
  try {
    await rpc('run', {
      task: text,
      // The project this window shows. The backend runs where the window is
      // looking even if another window switched it since (rpc.mjs run).
      root: state.root ?? undefined,
      // The select's 'plan' view is not a permission mode: the approved plan is
      // the consent, so the run works under 'auto'. Everything else goes as-is.
      mode: $('mode').value === 'plan' ? 'auto' : ($('mode').value || undefined),
      model: $('model').value || undefined,
      attachments: [...state.attachments.keys()],
      title: text.slice(0, 60),
    });
  } catch (err) {
    addNote(`error: ${friendly(err.message)}`);
    state.running = false;
    state.stopping = false;
    $('send').textContent = 'ส่ง';
    setHint('');
  }
}

function cancelRun() {
  // The stop is a request with an answer, not a hope. The backend says what it
  // stopped: `running: false` means there was nothing to stop, and the window
  // says so instead of sitting on a button that looks busy and is not.
  if (state.stopping) return; // a stop is already on its way
  state.stopping = true;
  $('send').textContent = 'กำลังหยุด…';
  setHint('กำลังหยุด…', true);
  rpc('cancel', { root: state.root ?? undefined })
    .then((res) => {
      if (res && res.ok === false) {
        // Nothing was running: the button goes back to sending, and the line
        // says what the stop found.
        state.stopping = false;
        $('send').textContent = 'ส่ง';
        setHint('');
        addNote(`หยุดไม่ได้ — ไม่มีรันที่กำลังทำอยู่${res.reason ? ` (${res.reason})` : ''}`);
      }
    })
    .catch((err) => {
      state.stopping = false;
      $('send').textContent = 'ส่ง';
      setHint('');
      addNote(`error: ${friendly(err.message)}`);
    });
}

$('composer').onsubmit = (ev) => {
  ev.preventDefault();
  sendTask();
};

$('task').addEventListener('keydown', (ev) => {
  const value = ev.currentTarget.value;

  // Shift+Tab belongs to nobody else in here: it cycles the mode. (The
  // document-level twin only serves focus that is not in this textarea.)
  if (ev.key === 'Tab' && ev.shiftKey) { ev.preventDefault(); cycleMode(); return; }

  // The palette owns the arrow keys, Tab and Enter while a command is being
  // typed; anything typed as an argument belongs to the textarea.
  if (slashTyping(value)) {
    if (!slash.open) openSlash(value);
    if (ev.key === 'ArrowDown') { ev.preventDefault(); moveSlash(1); return; }
    if (ev.key === 'ArrowUp') { ev.preventDefault(); moveSlash(-1); return; }
    if (ev.key === 'Tab' || (ev.key === 'Enter' && !ev.shiftKey)) {
      ev.preventDefault();
      // Nothing matches: let Send deal with it, so "/nosuch" is reported as an
      // unknown command instead of being silently swallowed.
      if (!slash.items.length) { void sendTask(); return; }
      pickSlash(slash.index);
      return;
    }
    if (ev.key === 'Escape') { ev.preventDefault(); closeSlash(); return; }
  }

  if (ev.key === 'Enter' && !ev.shiftKey) {
    ev.preventDefault();
    sendTask();
  }
});

// Typing filters the palette; deleting the "/" dismisses it.
$('task').addEventListener('input', (ev) => {
  const value = ev.currentTarget.value;
  if (slashTyping(value)) { slash.index = 0; renderSlash(value); }
  else closeSlash();
});

// The button stops a live run and sends an idle one.
$('send').onclick = (ev) => {
  ev.preventDefault();
  if (state.running) cancelRun();
  else sendTask();
};

document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && !$('modal').classList.contains('hidden')) hideModal();
  else if (ev.key === 'Escape' && state.running) cancelRun();
  // Ctrl+K goes to the search: once the history is longer than a scroll, the
  // search is the only way back to a conversation you remember.
  else if ((ev.ctrlKey || ev.metaKey) && String(ev.key).toLowerCase() === 'k') {
    ev.preventDefault();
    $('session-filter')?.focus();
  }
  // Shift+Tab cycles ask → auto → plan from the composer or anywhere the
  // window itself has the focus — the one shortcut that has to work without
  // someone typing first. Form controls (the select, the settings sheet) keep
  // their own Tab behaviour.
  else if (ev.key === 'Tab' && ev.shiftKey && ev.target !== $('task')
    && !['INPUT', 'TEXTAREA', 'SELECT'].includes(ev.target?.tagName ?? '')) {
    ev.preventDefault();
    cycleMode();
  }
});

$('slash-btn').onclick = () => {
  // A visible, clickable route into the palело for anyone who does not think to
  // type "/" first. It behaves exactly like typing it.
  $('task').value = '/';
  $('task').focus();
  slash.index = 0;
  renderSlash('/');
  slash.open = true;
};

$('apply').onclick = applyChecked;
$('discard').onclick = discardAll;
$('new-session').onclick = startNewSession;

// The filter re-renders the list it filters, so there is one source of truth
// for what is on screen.
$('session-filter').oninput = () => void refreshSessions();

// The foot of the rail: the two doors to the rest of the app, spelled out.
// A 15px gear in the header is easy to miss, and this is where people look.
$('side-settings').onclick = () => openSettings();
$('side-help').onclick = openHelp;

// Mode is the one setting that decides everything else it might do — may it
// write, may it run, must it plan first — so the header select and the
// Shift+Tab cycle share one apply path. 'plan' is a view, not a permission
// mode: it means plan first, and the approval of that plan is the consent the
// run then works under, which is why its runs use 'auto'.
const MODE_VIEWS = {
  ask: { mode: 'ask', plan: false, requirePlanApproval: false },
  auto: { mode: 'auto', plan: false, requirePlanApproval: false },
  yolo: { mode: 'yolo', plan: false, requirePlanApproval: false },
  plan: { mode: 'auto', plan: true, requirePlanApproval: true },
};
const MODE_CYCLE = ['ask', 'auto', 'plan'];

/** What the select should show for the mode and plan flags on record. */
function applyModeFromSettings() {
  const settings = state.settings ?? {};
  const value = settings.requirePlanApproval ? 'plan' : (settings.mode ?? 'ask');
  $('mode').value = MODE_VIEWS[value] ? value : 'ask';
}

/** The effort chip follows the saved thinking level, the way #mode follows the
 *  saved mode. The settings sheet no longer carries it: how hard the model
 *  thinks is a per-message decision, so it lives where the message is written. */
function applyThinkingFromSettings() {
  const level = state.settings?.thinking ?? 'low';
  $('thinking').value = ['off', 'low', 'medium', 'high', 'max'].includes(level) ? level : 'low';
}

/** The temperature chip mirrors the effort chip: it sits beside the model chip
 *  and writes through settings.set the moment it changes. null (default) means
 *  "leave it to the server's per-model default". */
function applyTemperatureFromSettings() {
  const value = state.settings?.temperature;
  const key = value == null ? 'default' : String(value);
  $('temperature').value = ['default', '0', '0.3', '0.7', '1', '1.5', '2'].includes(key) ? key : 'default';
}

$('thinking').onchange = () => {
  const level = $('thinking').value;
  rpc('settings.set', { thinking: level })
    .then(() => { state.settings = { ...(state.settings ?? {}), thinking: level }; })
    .catch((err) => addNote(`เปลี่ยนระดับ effort ไม่ได้: ${err.message}`));
};

$('temperature').onchange = () => {
  const value = $('temperature').value;
  const next = value === 'default' ? null : Number(value);
  rpc('settings.set', { temperature: next })
    .then(() => { state.settings = { ...(state.settings ?? {}), temperature: next }; })
    .catch((err) => addNote(`ตั้งค่า temperature ไม่ได้: ${err.message}`));
};

/**
 * Move through ask → auto → plan. A view that is not in the cycle (yolo) steps
 * back to the start. The select changes first — it is the state the keypress
 * left behind — and the save follows without blocking the next press.
 */
function cycleMode() {
  const current = $('mode').value;
  const at = MODE_CYCLE.indexOf(current);
  const next = at === -1 ? 'ask' : MODE_CYCLE[(at + 1) % MODE_CYCLE.length];
  const label = setMode(next);
  if (label) addCommandOut(`โหมด: ${label}`);
}

// The two header dropdowns write through to settings, so the choice survives a
// restart and the backend runs with it — not just this window. Changing the mode
// also moves the live policy, which is why it goes through settings.set and not
// a config call that only touches the bridge.
$('mode').onchange = () => { setMode($('mode').value); };
$('model').onchange = () => rpc('config.set', { model: $('model').value })
  .then(() => { state.settings = { ...(state.settings ?? {}), defaultModel: $('model').value }; refreshMeter(); })
  .catch((err) => addNote(`เปลี่ยนโมเดลไม่ได้: ${err.message}`));

/**
 * The provider switch.
 *
 * A provider is who answers the run: the built-in AiPASS one (the local bridge
 * and its tab) or an added API provider. The switch is machine-wide, like
 * every other setting, so it is written through the backend rather than kept
 * in this window — a choice made here is the choice the next run makes, in the
 * terminal too.
 *
 * The model list belongs to the provider, so a switch rebuilds it from
 * scratch: the old options are gone, not merged with the new ones.
 */
$('provider').onchange = async () => {
  const id = $('provider').value;
  try {
    await rpc('provider.set', { id });
    state.provider = id;
    // The backend already moved the model to the new provider's own; ask it
    // which one that is, so the picker and the run agree.
    const st = await rpc('status').catch(() => null);
    await fillModels(st?.model ?? null);
    refreshMeta();
  } catch (err) {
    addNote(`เปลี่ยนผู้ให้บริการไม่ได้: ${err.message}`);
  }
};

/**
 * Fill the provider dropdown.
 *
 * The list says whether a provider has a key — never what the key is — so a
 * provider that cannot answer is visibly not ready before a run needs it.
 */
async function fillProviders(activeId = null) {
  const res = await rpc('providers.list').catch(() => null);
  const list = res?.providers ?? [];
  if (!list.length) return;
  state.providers = list;
  state.provider = activeId ?? res.active ?? state.provider;
  const select = $('provider');
  select.textContent = '';
  for (const p of list) {
    const opt = document.createElement('option');
    opt.value = p.id;
    const ready = p.kind === 'aipass' || p.hasKey;
    opt.textContent = ready ? (p.label || p.id) : `${p.label || p.id} — ไม่มี key`;
    opt.title = ready
      ? `${p.id} — ${p.kind}${p.baseUrl ? ` · ${p.baseUrl}` : ''}`
      : `${p.id} — ยังไม่มี API key (${p.apiKeyEnv ? `$${p.apiKeyEnv}` : 'ใส่ในการตั้งค่า → ผู้ให้บริการ'})`;
    select.append(opt);
  }
  select.value = state.provider;
}

/* ------------------------------------------------------------------- help */

function openHelp() {
  $('modal-title').textContent = 'วิธีใช้';
  const body = $('modal-body');
  body.textContent = '';

  const section = (title, lines) => {
    const h = el('h4', null, title);
    const ul = el('ul');
    for (const line of lines) ul.append(el('li', null, line));
    body.append(h, ul);
  };

  section('พิมพ์ / เพื่อสั่งงาน', [
    'พิมพ์ / ลงไปในช่องพิมพ์ จะขึ้นรายการคำสั่ง — เลื่อนด้วยลูกศร เลือกด้วย Enter/Tab',
    'คุยกับโมเดล: /model /models /mode /status /conversations /fresh /compact',
    'บทสนทนา: /new /resume /fork /plan /stop',
    'ไฟล์: /attach /clip /file /image /open /diff /apply /discard /skills',
    'อื่น ๆ อีก: /project /settings /help',
    'ใส่ argument ได้คราว ๆ เช่น /mode auto หรือ /open README.md',
  ]);
  section('บอกมันทำอะไร', [
    'พิมพ์แล้วกด Enter — ถามคำถาม หรือสั่งแก้ไฟล์ก็ได้',
    'Shift+Enter = ขึ้นบรรทัดใหม่ · Esc = ยกเลิกรันที่กำลังทำ',
    'มันอ่านไฟล์เอง (NEED/SEARCH) เมื่อจำเป็น — ไม่ต้องบอกว่าอ่านแค่ไหน',
  ]);
  section('มันแก้ไฟล์ยังไง', [
    'ไม่มีอะไรเขียนลงดิสก์จนกว่าคุณจะกด "เขียนเลย"',
    'แต่ละไฟล์ติ๊กแยกกันได้ · กดดู diff ก่อนได้',
    'สิทธิ์ "ถามก่อนเขียน" = ยืนยันทุกครั้ง · "เขียนเลย" = ไม่ถาม · "เขียน+รันคำสั่ง" = อนุญาต shell ด้วย',
  ]);
  section('แนบไฟล์', [
    'ลากรูป/เอกสาร/วิดีโอทับหน้านี้ หรือกด "แนบไฟล์"',
    'ไฟล์แนบไปกับข้อความถัดไป แล้วหายไปเองหลังส่ง',
  ]);
  section('เปลี่ยนโปรเจกต์', [
    'เลือกที่ "โปรเจกต์" ด้านบน หรือกด + โฟลเดอร์',
    'แต่ละโปรเจกต์มีบทสนทนา คู่มือ และไฟล์แยกกัน',
  ]);
  section('ถ้าไม่ได้', [
    'แถบด้านบน tells you what is missing: bridge / extension / tab',
    'no tab → กด "เปิดให้" แล้วล็อกอินในหน้า de.aipass.net',
    'settings (gear) ปรับได้หมด: model, สิทธิ์, ขนาด compaction, ปลั๊กอิน',
  ]);

  const actions = $('modal-actions');
  actions.textContent = '';
  const close = el('button', 'primary', 'ปิด');
  close.onclick = hideModal;
  actions.append(close);
  $('modal').classList.remove('hidden');
}
$('help-btn').onclick = openHelp;

async function refreshPending() {
  const pending = await rpc('pending').catch(() => []);
  renderPending(pending);
}

/* Thai day words for the session list. The backend names a session after the
   moment it started ("2026-10-17 09:07"), and a wall of those spells the same
   date twice in every row — those rows show the clock face, and the day it
   belongs to reads as a word. */
const TH_MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
function sessionDay(when) {
  const midnight = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const away = Math.round((midnight(new Date()) - midnight(when)) / 86_400_000);
  if (away <= 0) return 'วันนี้';
  if (away === 1) return 'เมื่อวาน';
  if (away < 7) return `${away} วันก่อน`;
  const day = `${when.getDate()} ${TH_MONTHS[when.getMonth()]}`;
  return when.getFullYear() === new Date().getFullYear() ? day : `${day} ${String(when.getFullYear()).slice(2)}`;
}

/**
 * The session list. 99 sessions on this machine and counting — a list of 40 with
 * no filter is a list nobody scrolls, so it filters as you type, shows the date
 * a session is from, and keeps the newest first.
 */
async function refreshSessions() {
  const list = await rpc('session.list').catch(() => []);
  const ul = $('sessions');
  ul.textContent = '';
  const query = ($('session-filter')?.value ?? '').trim().toLowerCase();
  // How many there are, next to the label — a list whose size is invisible is
  // a list you cannot tell apart from "nothing there".
  const count = $('session-count');
  if (count) count.textContent = list.length ? String(list.length) : '';
  const shown = list
    .filter((s) => !query || `${s.title ?? ''} ${s.id}`.toLowerCase().includes(query))
    .slice(0, 60);
  // Past 40 sessions the picker is a junk drawer, not a list: the one-click
  // archive (nothing deleted, files move to <project>/archive/) sits above it
  // instead of hiding in a settings page. It waits for a search to finish —
  // a tidying button in the middle of a filtered list is noise.
  if (list.length > 40 && !query) {
    const bar = el('li', 'dim archive-bar');
    const btn = el('button', 'mini', `เก็บ ${list.length - 40}+ บทสนทนาเก่า`);
    btn.title = 'ย้ายบทสนทนาที่เงียบเกิน 30 วันไป archive/ (ไม่ลบไฟล์)';
    btn.onclick = async () => {
      btn.disabled = true;
      try {
        const out = await rpc('session.archive', { olderThanDays: 30, limit: 50 });
        addCommandOut(out?.count ? `เก็บ ${out.count} บทสนทนาเก่าเข้า archive/ แล้ว` : 'ไม่มีบทสนทนาเก่าเกิน 30 วันให้เก็บ');
      } catch (err) { addNote(`เก็บไม่ได้: ${err.message}`); }
      await refreshSessions();
    };
    bar.append(btn);
    ul.append(bar);
  }
  if (!shown.length) {
    ul.append(el('li', 'dim', query ? 'ไม่พบบทสนทนาที่ค้น' : 'ยังไม่มีบทสนทนา'));
    return;
  }
  for (const s of shown) {
    const li = el('li', s.id === state.sessionId ? 'active' : '');
    // A timestamp title only needs its clock face in the row; the day is the
    // sub-column's job, said in a word when it is close enough to have a word.
    const stamped = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}:\d{2})/.exec(s.title ?? '');
    const when = s.updated
      ? new Date(s.updated)
      : stamped
        ? new Date(+stamped[1], +stamped[2] - 1, +stamped[3], +stamped[4], +stamped[5])
        : null;
    li.append(el('span', 'name', stamped ? stamped[4] : (s.title || '(untitled)')));
    if (when) li.append(el('span', 'sub', sessionDay(when)));
    li.title = `${s.title ?? '(untitled)'}\n${s.id}\n${when ? when.toLocaleString() : ''}`;
    clickable(li, () => void openSession(s.id));
    ul.append(li);
  }
}

async function refreshSkills() {
  const skills = await rpc('skills.list').catch(() => []);
  const ul = $('skills');
  ul.textContent = '';
  // A section with nothing in it is a row that leads nowhere, so it is not
  // shown at all. The rail should only say what it can show.
  const group = $('skills-group');
  if (group) group.hidden = !skills.length;
  if (!skills.length) return;
  for (const s of skills) {
    const li = el('li');
    li.append(el('span', 'name', s.name));
    li.title = s.file ?? '';
    clickable(li, async () => {
      const found = await rpc('skills.load', { name: s.name }).catch((err) => ({ error: err.message }));
      $('modal-title').textContent = `playbook — ${s.name}`;
      const body = $('modal-body');
      body.textContent = '';
      if (found.error) body.append(el('p', null, found.error));
      else body.append(el('pre', null, found.text));
      $('modal-actions').textContent = '';
      const close = el('button', 'primary', 'close');
      close.onclick = hideModal;
      $('modal-actions').append(close);
      $('modal').classList.remove('hidden');
    });
    ul.append(li);
  }
}

/**
 * The facts the app carries between sessions.
 *
 * They live in the settings sheet now, not in the rail: this is the question
 * "what does it remember about me?", and the place people look for that is
 * the settings — next to the rules and the plugins, not next to the files you
 * are working on. The list is drawn into whatever container the sheet gives
 * it, so opening the sheet always shows what is true right now.
 */
async function renderMemoryFacts(ul, head) {
  const res = await rpc('memory.list').catch(() => null);
  const facts = res?.facts ?? [];
  if (head) head.textContent = facts.length ? `facts ข้าม session (${facts.length})` : 'facts ข้าม session';
  if (!ul) return facts;
  ul.textContent = '';
  if (!facts.length) {
    const li = el('li', 'dim');
    li.append(el('span', 'fact', '(ยังไม่มี — รัน /compact หรือให้ agent ทำงาน)'));
    ul.append(li);
    return facts;
  }
  for (const f of facts) {
    const li = el('li');
    li.append(el('span', 'fact', f));
    ul.append(li);
  }
  return facts;
}

/* --------------------------------------------------------------- the files */

// The file panel used to list one directory and stop: clicking a folder did
// nothing at all. It now walks, keeps a breadcrumb so you can get back, and each
// row carries the two things you actually want to do with a file — read it or
// attach it.
const filesState = { dir: '.', stack: [] };

async function refreshFiles(dir = filesState.dir) {
  filesState.dir = dir;
  const entries = await rpc('fs.list', { dir }).catch(() => []);
  const ul = $('files');
  ul.textContent = '';

  const up = el('li', 'dim up');
  up.textContent = dir === '.' ? '' : '..';
  if (dir !== '.') {
    up.onclick = async () => {
      const parent = dir.split(/[\\/]/).slice(0, -1).join('/') || '.';
      await refreshFiles(parent);
    };
    ul.append(up);
  }

  const shown = [...entries].sort((a, b) => (b.dir ? 1 : 0) - (a.dir ? 1 : 0));
  for (const e of shown.slice(0, 300)) {
    const li = el('li', 'dim');
    li.append(el('span', 'name', e.dir ? `${e.name}/` : e.name));
    if (e.dir) {
      clickable(li, () => void refreshFiles(dir === '.' ? e.name : `${dir}/${e.name}`));
    } else {
      const rel = dir === '.' ? e.name : `${dir}/${e.name}`;
      clickable(li, () => void openFile(rel));
      // Attach straight from the panel: the file is right there, and a picker is
      // a detour.
      const attach = el('button', 'mini', 'แนบ');
      attach.onclick = async (ev) => {
        ev?.stopPropagation?.();
        const item = await rpc('attachment.stage', { path: rel }).catch((err) => ({ error: err.message }));
        if (item.error) { addNote(`แนบไม่ได้: ${friendly(item.error)}`); return; }
        state.attachments.set(item.id, item);
        renderAttachments();
        addCommandOut(`แนบแล้ว: ${item.name}`);
      };
      li.append(attach);
    }
    ul.append(li);
  }

  // A header above the list, so a deep path is visible instead of implied.
  const head = $('files-head');
  if (head) head.textContent = dir === '.' ? 'ไฟล์ในโปรเจกต์' : dir;
}

/* ------------------------------------------------------------ attachments */

const readAsDataUrl = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result);
  reader.onerror = () => reject(reader.error);
  reader.readAsDataURL(file);
});

async function stageFiles(files) {
  for (const file of files) {
    try {
      const dataUrl = await readAsDataUrl(file);
      const item = await rpc('attachment.stage', { name: file.name, dataUrl });
      state.attachments.set(item.id, item);
    } catch (err) {
      addNote(`could not attach ${file.name}: ${err.message}`);
    }
  }
  renderAttachments();
}

function renderAttachments() {
  const ul = $('attachment-list');
  const wrap = $('attachments');
  ul.textContent = '';
  for (const [id, item] of state.attachments) {
    const li = el('li');
    if (item.mime?.startsWith('image/')) {
      const img = document.createElement('img');
      img.src = `data:${item.mime};base64,`; // the backend holds the bytes; a thumbnail is a nice-to-have
      img.alt = '';
      img.style.background = '#0b0e13';
      li.append(img);
    } else {
      li.append(el('span', null, item.mime?.startsWith('video/') ? '🎬' : '📄'));
    }
    li.append(el('span', null, `${item.name} (${Math.max(1, Math.round(item.bytes / 1024))} KB)`));
    const drop = el('button', null, 'x');
    drop.onclick = async () => {
      await rpc('attachment.remove', { id }).catch(() => {});
      state.attachments.delete(id);
      renderAttachments();
    };
    li.append(drop);
    ul.append(li);
  }
  wrap.classList.toggle('hidden', state.attachments.size === 0);
}

$('attach-btn').onclick = () => $('file-picker').click();
$('file-picker').onchange = () => { stageFiles([...$('file-picker').files]); $('file-picker').value = ''; };

// Dropping a file anywhere over the window attaches it.
['dragover', 'drop'].forEach((type) => {
  document.addEventListener(type, (ev) => {
    if (!ev.dataTransfer?.files?.length) return;
    ev.preventDefault();
    stageFiles([...ev.dataTransfer.files]);
  });
});

// Ctrl+V with an image on the clipboard attaches it. The gesture a desktop user
// reaches for first — a screenshot is one keystroke away — used to do nothing at
// all, because only drag-drop and the picker were wired.
document.addEventListener('paste', (ev) => {
  const files = [...(ev.clipboardData?.files ?? [])];
  if (!files.length) return;
  ev.preventDefault();
  stageFiles(files);
});

/* --------------------------------------------------------------- projects */

async function refreshProjects(projects) {
  const select = $('project');
  const previous = select.value;
  select.textContent = '';
  for (const p of projects ?? []) {
    const opt = document.createElement('option');
    opt.value = p.path;
    // A project with a run still going is marked: after a switch that run's
    // events stop painting here (onRun), and the picker is where the window
    // says so instead of the run looking like it evaporated.
    opt.textContent = `${p.name ?? p.path}${p.running && !p.current ? ' • กำลังทำงาน' : ''}`;
    if (p.current) opt.selected = true;
    select.append(opt);
  }
  if (!projects?.length) return;
  // The window follows its picker: this is the project its events are filtered
  // by and the root its runs are sent to.
  const mine = projects.find((p) => p.current) ?? projects[0];
  if (mine?.path) state.root = mine.path;
  if (previous !== select.value) await refreshSessions();
}

$('project').onchange = async () => {
  const result = await rpc('projects.switch', { path: $('project').value }).catch((err) => ({ error: err.message }));
  if (result.error) { addNote(`สลับโปรเจกต์ไม่ได้: ${friendly(result.error)}`); return; }
  state.root = result.root ?? $('project').value;
  log.textContent = '';
  state.sessionId = null;
  renderPending([]);
  addNote(`project: ${$('project').value}`);
  await Promise.all([refreshSessions(), refreshFiles('.'), refreshSkills(), refreshPanels()]);
};

$('add-project').onclick = async () => {
  let chosen = null;
  // The File System Access API gives a real picker in a Chromium webview; a
  // typed path is the fallback for anything that does not have it.
  if (window.showDirectoryPicker) {
    try {
      const handle = await window.showDirectoryPicker({ mode: 'read' });
      chosen = handle.name;
      await rpc('projects.add', { name: chosen, path: nameToPath(chosen) });
    } catch { /* cancelled */ }
  }
  if (!chosen) {
    const typed = window.prompt('folder to open (full path):');
    if (typed) await rpc('projects.add', { path: typed }).catch((err) => addNote(err.message));
  }
  const projects = await rpc('projects.list').catch(() => []);
  await refreshProjects(projects);
};

// A picker returns a display name, not a path; the backend resolves it against
// the home directory, which is where the picker starts.
function nameToPath(name) { return `~/${name}`; }

/* --------------------------------------------------------------- settings */

/* Grouped into pages behind the category rail; every field says what it
   changes. A flat list of thirteen settings is a form nobody reads. */
const SETTINGS_SECTIONS = [
  {
    id: 'model',
    icon: '🤖',
    title: 'คุยกับโมเดล',
    sub: 'โมเดล สิทธิ์ และขีดจำกัดของแต่ละรัน',
    fields: [
      { key: 'defaultModel', label: 'โมเดลเริ่มต้น', type: 'text', note: 'id ของโมเดล — ดูรายการได้ที่ /models หรือกดที่หัวหน้าต่าง' },
      { key: 'mode', label: 'สิทธิ์แก้ไฟล์', type: 'select', options: [['ask', 'ถามก่อนเขียนทุกไฟล์'], ['auto', 'เขียนเลยไม่ถาม'], ['yolo', 'เขียน + รันคำสั่ง shell']] },
      { key: 'allowRun', label: 'อนุญาตให้รันคำสั่ง shell', type: 'checkbox', note: 'ปิด = โมเดลแก้ไฟล์ได้อย่างอื่นไม่ได้' },
      { key: 'maxSteps', label: 'สูงสุดกี่ Step ต่อคำสั่ง', type: 'number', note: '0 = ไม่จำกัด — งานยาวไปจนจบ; เบรกจริงคือ budget ด้านล่าง (tool calls / เวลา)' },
      { key: 'maxToolCalls', label: 'สูงสุดกี่ tool call ต่อคำสั่ง', type: 'number', note: 'เพดานกันหลุด — คำตอบเดียวที่สั่งเครื่องมือร้อยครั้งจะหยุดเมื่อถึงตัวเลขนี้ (ค่าเริ่มต้น 300)' },
      { key: 'maxWallClockMin', label: 'เวลาสูงสุดต่อคำสั่ง (นาที)', type: 'number', note: 'เพดานเวลา — งานที่ค้างจะหยุดเอง (ค่าเริ่มต้น 30)' },
      { key: 'maxCredits', label: 'เพดานเครดิตต่อคำสั่ง', type: 'number', note: '0 = ไม่จำกัด — หยุดงานเมื่อใช้เครดิตถึงเพดาน (เช็คกับยอดที่แคชไว้ ~30 วิ ต่อครั้ง)' },
      { key: 'maxResult', label: 'สูงสุดกี่ byte ต่อผลเครื่องมือ', type: 'number', note: '0 = ค่าเริ่มต้น (3000) — ที่เหลือ spill ลงดิสก์ให้อ่านต่อได้; ใหญ่ขึ้น = รอบน้อยลง' },
      { key: 'plan', label: 'plan mode', type: 'checkbox', note: 'โมเดลร่างแผนก่อนลงมือ' },
      { key: 'requirePlanApproval', label: 'รอให้อนุมัติแผนก่อนทำ', type: 'checkbox', note: 'ใช้ได้ก็ต่อเมื่อ plan mode เปิด' },
      { key: 'subagent', label: 'ให้เรียก helper ย่อย', type: 'checkbox', note: 'งานยาวถูกแบ่งให้ตัวช่วย แล้วรีพอร์ตกลับ' },
      { key: 'replyLanguage', label: 'ภาษาที่ตอบผู้ใช้', type: 'select', options: [['th', 'ไทย — ค่าเริ่มต้น'], ['en', 'English']], note: 'โค้ด คำสั่ง และพาธเป็นอังกฤษเสมอ ไม่ว่าตัวนี้จะตั้งไว้อย่างไร' },
      { key: 'langCheck', label: 'เตือนเมื่อลืมตอบไทย', type: 'checkbox', note: 'ตรวจสัดส่วนอักษรไทยของข้อความปิดงานก่อนรับ DONE — เตือนหนึ่งครั้ง' },
      { key: 'minThaiRatio', label: 'สัดส่วนอักษรไทยขั้นต่ำ', type: 'number', note: '0-1 (ค่าเริ่มต้น 0.4) — ไม่นับบล็อกโค้ด/ลิงก์' },
      { key: 'repeatGuard', label: 'กันเรียกซ้ำซาก', type: 'checkbox', note: 'เรียก tool เดิม + อาร์กิวเมนต์เดิมครั้งที่สามโดยไม่มีอะไรเปลี่ยน = ถูกบล็อกพร้อมคำแนะนำ' },
      { key: 'repeatGuardMax', label: 'เพดานการบล็อกซ้ำต่อรอบ', type: 'number', note: 'เกินแล้วหยุดรอบเป็น stalled (ค่าเริ่มต้น 4)' },
      { key: 'attempts', label: 'รอบลองสูงสุดต่อคำสั่ง', type: 'number', note: 'ลองซ้ำเมื่อ checker ไม่ผ่าน (1 = ไม่ลอง; ทุกรอบคิดเครดิตเต็ม)' },
      { key: 'verifyCommand', label: 'คำสั่งตรวจ (verify command)', type: 'text', note: 'ถ้าใส่ จะใช้แทน .aipass/check.txt และบันทึกมากับผลตรวจ — เว้นว่าง = ใช้ไฟล์ของโปรเจกต์' },
      { key: 'requireCheck', label: 'บังคับให้ check ผ่านก่อน DONE', type: 'checkbox', note: 'ถ้ามีคำสั่งตรวจและ checker ยัง fail จะไม่รับ DONE — หยุดเป็น done-unverified' },
    ],
  },
  { id: 'context', icon: '📊', title: 'บริบท (context)', sub: 'งบ token และจังหวะการบีบเอ็น', custom: 'context' },
  { id: 'providers', icon: '🌐', title: 'ผู้ให้บริการ', sub: 'ใครตอบรัน — AiPASS (ผ่าน bridge) หรือ API อื่น', custom: 'providers' },
  { id: 'memory', icon: '🧠', title: 'ความจำข้ามเซสชัน', sub: 'สิ่งที่แอปจำไว้จากบทสนทนาก่อน ๆ — ดูได้ ลบได้ทันที', custom: 'memory' },
  { id: 'window', icon: '🪟', title: 'หน้าต่าง', sub: 'ธีมและหน้า chat ที่ใช้เชื่อมต่อ', fields: [
    { key: 'theme', label: 'ธีม', type: 'select', options: [['dark', 'มืด'], ['light', 'สว่าง'], ['auto', 'ตามเครื่อง']], note: 'สลับดูได้ทันทีตอนเลือก' },
    { key: 'chatUrl', label: 'หน้า chat ที่ล็อกอินอยู่', type: 'text', note: 'bridge ใช้ tab นี้พูดกับโมเดล' },
    { key: 'autoOpenTab', label: 'เปิด tab ให้เองเมื่อต้องการ', type: 'checkbox', note: 'run ที่ไม่มี tab จะเปิดบราวเซอร์ให้แทนที่จะพัง' },
  ] },
  { id: 'skills', icon: '📘', title: 'คู่มือ (playbook)', sub: 'โฟลเดอร์ที่ใช้ค้นหาคู่มือ', custom: 'skillsDirs' },
  { id: 'rules', icon: '🛡️', title: 'กฎไฟล์', sub: 'path ที่มีกฎละเว้นโหมด — first match wins', custom: 'rules' },
  // Health is pull-based on purpose (docs/RELIABILITY.md): no daemon pages
  // anyone, so the check lives where the person already looks — one button,
  // same answers as `aipass doctor` + `npm run stats -- --alerts`.
  { id: 'health', icon: '🩺', title: 'สุขภาพ', sub: 'bridge · extension · tab · credits — กดตรวจตอนนี้', custom: 'health' },
];
/**
 * The settings sheet — a category rail on the left, one page of settings on the
 * right, so a section you never touch is one click away instead of one scroll
 * away. What the older sheet got right, this keeps: edits are staged in a draft
 * and only "บันทึก" writes them, validation names the problem instead of saving
 * a bad number, and the context meter ticks live while the sheet is open.
 */
async function openSettings() {
  const settings = await rpc('settings.get').catch(() => null);
  if (!settings) { addNote('อ่านการตั้งค่าไม่ได้'); return; }
  state.settings = settings;

  const draft = structuredClone(settings);
  draft.compaction = { contextTokens: 24000, reserveTokens: 4096, keepRecentBytes: 6000, ...(settings.compaction ?? {}) };
  // The wall-clock budget is stored in milliseconds; the sheet asks in
  // minutes, because typing 1800000 to mean half an hour is a trap.
  draft.maxWallClockMin = Math.max(1, Math.round(Number(settings.maxWallClockMs ?? 1_800_000) / 60_000));

  $('modal-title').textContent = 'การตั้งค่า';
  $('modal').classList.add('settings-sheet');
  const body = $('modal-body');
  body.textContent = '';

  const read = (key) => key.split('.').reduce((o, k) => (o ?? {})[k], draft);
  const write = (key, value) => {
    if (!key.includes('.')) { draft[key] = value; return; }
    const [head, tail] = key.split('.');
    draft[head] = { ...(draft[head] ?? {}), [tail]: value };
  };

  const control = (field) => {
    const value = read(field.key);
    if (field.type === 'checkbox') {
      const lab = el('label', 'switch');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = Boolean(value);
      box.onchange = () => write(field.key, box.checked);
      lab.append(box, el('span', 'track'));
      return lab;
    }
    if (field.type === 'select') {
      const select = document.createElement('select');
      for (const [v, text] of field.options) {
        const opt = document.createElement('option');
        opt.value = v;
        opt.textContent = text;
        if (v === value) opt.selected = true;
        select.append(opt);
      }
      select.onchange = () => {
        write(field.key, select.value);
        // The theme shows its effect immediately: a setting you have to save
        // before you can see it is a setting you guess at.
        if (field.key === 'theme') applyTheme(select.value);
      };
      return select;
    }
    if (field.type === 'textarea') {
      const area = document.createElement('textarea');
      area.rows = 4;
      area.value = Array.isArray(value) ? value.join('\n') : String(value ?? '');
      area.oninput = () => write(field.key, area.value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
      return area;
    }
    const input = document.createElement('input');
    input.type = field.type;
    input.value = value ?? '';
    if (field.type === 'number') input.min = '0';
    input.onchange = () => write(field.key, field.type === 'number' ? Number(input.value) : input.value);
    return input;
  };

  // One labelled row: title + note on the left, control on the right. `stack`
  // drops the control underneath — a textarea in a side-by-side row would be
  // 300px wide for four lines of paths.
  const row = (label, note, node) => {
    const r = el('div', 'set-row');
    const info = el('div', 'set-info');
    info.append(el('div', 'set-title', label));
    if (note) info.append(el('div', 'set-note', note));
    const c = el('div', 'set-control');
    if (node.tagName === 'TEXTAREA') r.classList.add('stack');
    c.append(node);
    r.append(info, c);
    return r;
  };

  const details = await rpc('plugins.list').catch(() => null);
  // The MCP section is live connection state, not a file — it only means
  // something when the backend answers mcp.list with rows (an older backend,
  // or a test stub, answers nothing useful and gets no section).
  const mcpList = await rpc('mcp.list').catch(() => null);
  const mcpReady = mcpList && Array.isArray(mcpList.servers) ? mcpList : null;
  const sections = details
    ? [...SETTINGS_SECTIONS,
      { id: 'plugins', icon: '🧩', title: 'ปลั๊กอิน', sub: `โค้ดเสริมจาก ${details.dir}`, custom: 'plugins' },
      ...(mcpReady ? [{ id: 'mcp', icon: '🔌', title: 'MCP', sub: 'เซิร์ฟเวอร์เครื่องมือภายนอก — เพิ่ม ปิด ทดสอบ', custom: 'mcp' }] : [])]
    : SETTINGS_SECTIONS;

  const nav = el('nav', 'settings-nav');
  const pages = el('div', 'settings-pages');
  const show = (id) => {
    for (const b of nav.querySelectorAll('button')) b.classList.toggle('active', b.dataset.cat === id);
    for (const p of pages.querySelectorAll('.settings-page')) p.classList.toggle('active', p.dataset.page === id);
  };

  for (const section of sections) {
    const tab = el('button');
    tab.dataset.cat = section.id;
    tab.append(el('span', 'nav-icon', section.icon), el('span', null, section.title));
    tab.onclick = () => show(section.id);
    nav.append(tab);

    const page = el('section', 'settings-page');
    page.dataset.page = section.id;
    page.append(el('h4', 'settings-page-title', section.title));
    page.append(el('p', 'settings-page-sub', section.sub));
    pages.append(page);

    if (section.custom === 'context') {
      // The context meter, live: what is used, what happens at the limit, and
      // the three numbers that decide when the rotation fires.
      const meter = el('div', 'ctx-meter');
      const st = await rpc('status').catch(() => null);
      const use = st?.context ?? {};
      const pct = use.percent ?? 0;
      const at = use.compactAt ?? 40;
      const bar = el('div', `ctx-bar ${use.needsCompaction ? 'full' : pct >= at ? 'warm' : ''}`);
      bar.id = 'ctx-bar';
      bar.style.setProperty('--pct', `${pct}%`);
      bar.style.setProperty('--at', `${at}%`);
      bar.title = `ใช้ ${pct}% — จะบีบเอ็นตอน ${at}%`;
      meter.append(bar, el('span', 'dim', `ใช้ ~${(use.used ?? 0).toLocaleString()} จากงบ ${(use.budget ?? 0).toLocaleString()} token (${pct}%) · ${use.entries ?? 0} รายการในบทสนทนา`));
      page.append(meter);
      page.append(el('p', 'settings-empty', `de.aipass.net เก็บบริบทไว้บนเซิร์ฟเวอร์และลบไม่ได้ — พอ context ถึง ${at}% ระบบจะสรุปงานเก่าแล้วเริ่มบทสนทนาใหม่เอง (หรือพิมพ์ /compact ตอนนี้)`));
      const group = el('div', 'set-group');
      group.append(row('บีบเอ็นตอน context เต็มกี่ %', `ตอนนี้ ${at}% — ค่าต่ำ = สรุปบ่อย ประหยัดบริบทแต่เสียรายละเอียด`, control({ key: 'compactAtPercent', type: 'number' })));
      group.append(row('งบบริบทก่อนหมุนเวียน (token)', 'ยิ่งสูงยิ่งจำได้มาก แต่เสียเครดิตเร็วขึ้น เพราะส่งบริบทเก่าซ้ำ', control({ key: 'compaction.contextTokens', type: 'number' })));
      group.append(row('สำรองสำหรับคำตอบ (token)', 'ที่ว่างไว้ให้โมเดลตอบ — ต้องน้อยกว่างบทั้งหมด', control({ key: 'compaction.reserveTokens', type: 'number' })));
      group.append(row('บทสนทนาล่าสุดที่เก็บดิบ (bytes)', 'ส่วนท้ายของบทสนทนาจะคงอยู่ตรง ๆ ไม่ถูกย่อรวม', control({ key: 'compaction.keepRecentBytes', type: 'number' })));
      page.append(group);
      continue;
    }

    if (section.custom === 'providers') {
      // Who answers the run: the built-in AiPASS provider (the local bridge
      // and its tab) and every added API provider.
      //
      // The key is typed here once and filed by the backend — it never comes
      // back out, so the list can only say whether a provider has one. A
      // provider whose env var is named needs no key here at all: the
      // environment answers first, and the file is only the fallback for a
      // desktop that has no shell to export into.
      const list = el('div', 'provider-list');
      const out = el('div', 'install-out dim', '');
      page.append(list);

      const paint = async () => {
        const res = await rpc('providers.list').catch(() => null);
        const rows = res?.providers ?? [];
        state.providers = rows;
        list.textContent = '';
        for (const p of rows) {
          const card = el('div', 'provider-card');
          const head = el('div', 'plugin-head');
          head.append(el('div', 'plugin-name', p.label || p.id));
          const state_ = p.id === res.active ? 'ใช้อยู่'
            : (p.kind === 'aipass' ? 'ในตัว' : (p.hasKey ? 'มี key' : 'ยังไม่มี key'));
          head.append(el('span', `plugin-state${p.id === res.active ? ' on' : ''}`, state_));
          card.append(head);
          card.append(el('div', 'plugin-desc', p.kind === 'aipass'
            ? 'de.aipass.net ผ่าน bridge และแท็บที่ล็อกอินอยู่ — ใช้เครดิตของเว็บ'
            : `${p.kind} · ${p.baseUrl}${p.apiKeyEnv ? ` · key: $${p.apiKeyEnv}` : ''}${p.models?.length ? ` · ${p.models.length} โมเดล` : ''}`));
          const actions = el('div', 'plugin-actions');
          if (p.kind !== 'aipass') {
            const use = el('button', null, p.id === res.active ? 'ใช้อยู่' : 'ใช้ตัวนี้');
            use.disabled = p.id === res.active;
            use.onclick = async () => {
              use.disabled = true;
              await rpc('provider.set', { id: p.id })
                .catch((e) => { out.className = 'install-out err'; out.textContent = `err: ${e.message}`; });
              await paint();
              await fillProviders(p.id);
            };
            const test = el('button', null, 'ทดสอบ');
            test.onclick = async () => {
              test.disabled = true;
              out.className = 'install-out dim';
              out.textContent = 'กำลังทดสอบ…';
              const answer = await rpc('provider.test', { id: p.id }).catch((e) => ({ ok: false, detail: e.message }));
              out.className = answer.ok ? 'install-out' : 'install-out err';
              out.textContent = answer.ok ? `พร้อม — ${answer.detail}` : `ไม่ผ่าน — ${answer.detail}`;
              test.disabled = false;
            };
            const del = el('button', 'danger-btn', 'ลบ');
            del.onclick = async () => {
              if (!window.confirm(`ลบผู้ให้บริการ "${p.id}"? (key ที่บันทึกไว้จะหายด้วย)`)) return;
              await rpc('provider.remove', { id: p.id })
                .catch((e) => { out.className = 'install-out err'; out.textContent = `err: ${e.message}`; });
              await paint();
              await fillProviders();
            };
            actions.append(use, test, del);
          }
          card.append(actions);
          list.append(card);
        }
      };
      await paint();

      // The form that adds one. Everything here is the spec; the key is the
      // only secret, and it is written once.
      const form = el('div', 'set-group');
      const field = (label, note, node) => {
        const input = document.createElement('input');
        input.type = 'text';
        node.append(input);
        return row(label, note, node);
      };
      const idBox = el('div');
      const labelBox = el('div');
      const kindBox = el('div');
      const kindSel = document.createElement('select');
      for (const [v, text] of [['openai', 'OpenAI-compatible (OpenAI, OpenRouter, Groq, Ollama…)'], ['anthropic', 'Anthropic (Messages API)']]) {
        const opt = document.createElement('option');
        opt.value = v;
        opt.textContent = text;
        kindSel.append(opt);
      }
      kindBox.append(kindSel);
      const urlBox = el('div');
      const envBox = el('div');
      const modelsBox = el('div');
      const keyBox = el('div');
      const keyIn = document.createElement('input');
      keyIn.type = 'password';
      keyIn.placeholder = 'ว่างไว้ = ใช้ตัวแปรสภาพแวดล้อม';
      keyBox.append(keyIn);
      form.append(
        field('id', 'ตัวอักษรเล็ก ตัวเลข . _ - เช่น openai, my-gateway', idBox),
        field('ชื่อที่แสดง', 'เช่น OpenAI (ผ่าน gateway)', labelBox),
        row('โปรโตคอล', 'ชนิด API ที่ปลายทางพูด', kindBox),
        field('base url', 'เช่น https://api.openai.com/v1 หรือ http://localhost:11434/v1', urlBox),
        field('ตัวแปรสภาพแวดล้อมของ key', 'เช่น OPENAI_API_KEY — ถ้าตั้งไว้ ตัวนี้มาก่อนไฟล์', envBox),
        field('โมเดล', 'คั่นด้วยจุลภาค — เว้นว่างไว้ถ้าไม่รู้ (จะถามจาก provider ตอนใช้)', modelsBox),
        row('API key', 'เก็บใน ~/.aipass/credentials.json (สิทธิ์เฉพาะเจ้าของ) — ไม่มีก็ใช้ตัวแปรสภาพแวดล้อมแทน', keyBox),
      );
      const save = el('button', 'primary', 'เพิ่มผู้ให้บริการ');
      save.onclick = async () => {
        save.disabled = true;
        out.className = 'install-out dim';
        out.textContent = 'กำลังบันทึก…';
        const body = {
          id: idBox.querySelector('input')?.value?.trim(),
          label: labelBox.querySelector('input')?.value?.trim(),
          kind: kindSel.value,
          baseUrl: urlBox.querySelector('input')?.value?.trim(),
          apiKeyEnv: envBox.querySelector('input')?.value?.trim(),
          models: (modelsBox.querySelector('input')?.value ?? '').split(/[,\s]+/).map((s) => s.trim()).filter(Boolean),
          key: keyIn.value?.trim(),
        };
        const answer = await rpc('provider.save', body).catch((e) => ({ error: e.message }));
        if (answer?.error) {
          out.className = 'install-out err';
          out.textContent = `err: ${answer.error}`;
          save.disabled = false;
          return;
        }
        out.className = 'install-out';
        out.textContent = `เพิ่ม "${body.id}" แล้ว — เลือกใช้ได้จากช่องผู้ให้บริการใต้ช่องพิมพ์`;
        keyIn.value = '';
        idBox.querySelector('input').value = '';
        labelBox.querySelector('input').value = '';
        urlBox.querySelector('input').value = '';
        envBox.querySelector('input').value = '';
        modelsBox.querySelector('input').value = '';
        save.disabled = false;
        await paint();
        await fillProviders();
      };
      const actionsRow = el('div', 'plugin-actions');
      actionsRow.append(save);
      form.append(actionsRow);
      page.append(form, out);
      continue;
    }

    if (section.custom === 'memory') {
      // What the app remembers between sessions, and the one button that
      // makes it forget. It used to sit in the rail as a row folded away
      // under a heading nobody could place — a thing the app did that you
      // could only find by guessing. Here it is a page, next to the rules.
      const head = el('div', 'set-title');
      head.id = 'memory-head';
      const list = el('ul', 'list dim memory-list');
      list.id = 'memory';
      const clear = el('button', 'mini', 'ลืมทั้งหมด');
      clear.id = 'memory-clear';
      clear.title = 'ลบ facts ที่จำไว้ข้าม session ทั้งหมด';
      clear.onclick = async () => {
        await rpc('memory.clear').catch(() => {});
        addCommandOut('ลืม facts ข้าม session ทั้งหมดแล้ว');
        await renderMemoryFacts(list, head);
      };
      page.append(head, list, clear);
      await renderMemoryFacts(list, head);
      continue;
    }

    if (section.custom === 'skillsDirs') {
      const group = el('div', 'set-group');
      group.append(row('โฟลเดอร์คู่มือ', 'ทีละ path ต่อบรรทัด · ลองโฟลเดอร์ในโปรเจกต์ก่อน แล้วค่อย ~/.aipass/skills · /skills = ดูที่มี · รายการรีเฟรชเองเมื่อบันทึก', control({ key: 'skillsDirs', type: 'textarea' })));
      page.append(group);
      continue;
    }

    if (section.custom === 'plugins') {
      let live = details;

      // The install box: a source in, a report out — inspect runs nothing.
      // The click on "ติดตั้ง" is the consent moment: it is the first thing
      // that loads the code, so nothing may happen before the report is read.
      const box = el('div', 'set-group');
      const line = el('div', 'install-line');
      const src = document.createElement('input');
      src.type = 'text';
      src.placeholder = 'path ของไฟล์ .mjs หรือโฟลเดอร์ · https://… · github:owner/repo · npm:<package>';
      const check = el('button', null, 'ตรวจสอบ');
      line.append(src, check);
      const out = el('div', 'install-out dim', 'วางที่อยู่แล้วกดตรวจสอบ — ยังไม่มีอะไรถูกรันจนกว่าจะกดติดตั้ง');
      box.append(line, out);
      page.append(box);

      const empty = el('p', 'settings-empty');
      empty.append('ยังไม่มีปลั๊กอินที่ติดตั้งผ่านแอป — วางที่อยู่ด้านบน หรือวางไฟล์ .mjs ลง ');
      empty.append(el('code', null, details.dir));
      const cards = el('div');
      const markers = el('div', 'plugin-markers');
      page.append(empty, cards, markers);

      const paint = () => {
        const known = live.known ?? live.loaded.map((pl) => pl.name);
        empty.style.display = (!known.length && !live.failed.length) ? '' : 'none';
        cards.textContent = '';
        for (const name of known) {
          const pl = live.loaded.find((x) => x.name === name) ?? null;
          const rec = live.registry?.[name] ?? pl?.installed ?? null;
          const on = Boolean(pl);
          const card = el('div', `plugin-card${on ? '' : ' off'}`);
          const head = el('div', 'plugin-head');
          head.append(el('div', 'plugin-name', `${name}${pl ? ` ${pl.version}` : ''}`));
          head.append(el('span', `plugin-state${on ? ' on' : ''}`, on ? 'เปิด' : 'ปิด'));
          card.append(head);
          card.append(el('div', 'plugin-desc', pl?.description || (on ? 'ไม่มีคำอธิบาย' : 'ปิดอยู่ — ไม่ถูกโหลด')));
          if (rec) {
            const note = el('div', 'plugin-source dim');
            note.textContent = `ที่มา: ${rec.source?.ref ?? '?'} · sha ${rec.sha256 ?? '?'}`;
            if (pl?.hashChanged) note.textContent += ' · ไฟล์เปลี่ยนหลังติดตั้ง — กดโหลดใหม่หรือติดตั้งทับถ้าไม่ใช่ฝีมือคุณ';
            card.append(note);
          } else {
            card.append(el('div', 'plugin-source dim', 'วางไฟล์เอง — ไม่ได้ติดตั้งผ่านแอป (ลบต้องยืนยันเป็นพิเศษ)'));
          }
          const actions = el('div', 'plugin-actions');
          const toggle = el('button', null, on ? 'ปิด' : 'เปิด');
          toggle.onclick = async () => {
            toggle.disabled = true;
            const res = await rpc(on ? 'plugins.disable' : 'plugins.enable', { name }).catch((e) => {
              out.className = 'install-out err';
              out.textContent = `err: ${e.message}${e.stage ? ` · ขั้นตอน: ${stageLabel(e.stage)}` : ''}`;
              return null;
            });
            if (res) await refresh();
            else toggle.disabled = false;
          };
          const del = el('button', 'danger-btn', 'ลบ');
          del.onclick = async () => {
            const first = rec
              ? `ลบปลั๊กอิน "${name}"? ไฟล์จะถูกเก็บไว้ใน .trash (กู้คืนได้)`
              : `"${name}" ไม่ได้ติดตั้งผ่านแอป — ไฟล์นี้คือผลงานของคุณ ยืนยันว่าจะย้ายไป .trash?`;
            if (!window.confirm(first)) return;
            if (!rec && !window.confirm('ยืนยันอีกครั้ง: ย้ายโฟลเดอร์นี้ไป .trash?')) return;
            del.disabled = true;
            const res = await rpc('plugins.remove', { name, force: true }).catch((e) => {
              out.className = 'install-out err';
              out.textContent = `err: ${e.message}${e.stage ? ` · ขั้นตอน: ${stageLabel(e.stage)}` : ''}`;
              return null;
            });
            if (res) await refresh();
            else del.disabled = false;
          };
          actions.append(toggle, del);
          card.append(actions);
          cards.append(card);
        }
        for (const f of live.failed) {
          const card = el('div', 'plugin-card bad');
          card.append(el('div', 'plugin-name', `โหลดไม่ได้ — ${f.file}`));
          card.append(el('div', 'plugin-desc', f.error));
          cards.append(card);
        }
        markers.textContent = '';
        if (live.tools.length) {
          markers.append('markers: ');
          markers.append(el('code', null, live.tools.join(', ')));
        }
      };

      const refresh = async () => {
        live = await rpc('plugins.list').catch(() => live);
        paint();
        // The rail's plugin section follows what is installed: a plugin you
        // just installed has a panel, and the panel should be there now —
        // not after a reload of the window.
        await refreshPanels();
      };

      check.onclick = async () => {
        const source = src.value.trim();
        if (!source) { out.className = 'install-out err'; out.textContent = 'ใส่ path หรือ URL ก่อน'; return; }
        // The box says what it is doing while it does it: a source that has
        // to be fetched looks the same as one that is already on disk, and the
        // wait is the difference between the two.
        check.disabled = true;
        src.disabled = true;
        out.className = 'install-out dim';
        out.textContent = 'กำลังตรวจสอบแหล่งที่มา… (ยังไม่มีอะไรถูกรัน)';
        const info = await rpc('plugins.inspect', { source }).catch((e) => {
          out.className = 'install-out err';
          out.textContent = `err: ${e.message}${e.stage ? ` · ขั้นตอน: ${stageLabel(e.stage)}` : ''}`;
          return null;
        });
        check.disabled = false;
        src.disabled = false;
        if (!info) return;
        out.className = 'install-out';
        out.textContent = '';
        out.append(el('div', null, `ที่มา: ${info.ref}`));
        out.append(el('div', 'dim', `ชนิด: ${info.kind}${info.kind === 'path' ? '' : ' — ดึงมาจากที่นั้นเพื่ออ่าน ยังไม่มีอะไรถูกรัน'}`));
        out.append(el('div', 'dim', `${info.entry} · ${info.size.toLocaleString()} bytes · sha256 ${info.sha256.slice(0, 16)}…`));
        out.append(el('div', 'dim', 'ติดตั้ง = โหลดโค้ดนี้ในโปรเซสของแอปจริง ๆ ไม่มี sandbox — เทียบ sha256 กับต้นทางก่อนถ้าไม่แน่ใจ'));
        const install = el('button', 'primary', 'ติดตั้ง');
        install.onclick = async () => {
          install.disabled = true;
          check.disabled = true;
          src.disabled = true;
          out.className = 'install-out dim';
          out.textContent = 'กำลังติดตั้ง… (ดึงแหล่งที่มา → ตรวจโค้ด → สลับเข้าโฟลเดอร์ปลั๊กอิน)';
          const res = await rpc('plugins.install', { source: info.ref, expectedSha256: info.sha256 }).catch((e) => {
            out.className = 'install-out err';
            out.textContent = `err: ${e.message}${e.stage ? ` · ขั้นตอน: ${stageLabel(e.stage)}` : ''}`;
            // A folder that is not the installer's is refused by default; this
            // second click is the explicit force, and it still keeps a copy.
            if (/not installed by aipass|already exists/.test(e.message)) {
              const force = el('button', null, 'ติดตั้งทับ (เก็บสำเนาเดิมใน .trash)');
              force.onclick = async () => {
                force.disabled = true;
                out.className = 'install-out dim';
                out.textContent = 'กำลังติดตั้งทับ…';
                const forced = await rpc('plugins.install', { source: info.ref, expectedSha256: info.sha256, force: true }).catch((e2) => {
                  out.className = 'install-out err';
                  out.textContent = `err: ${e2.message}${e2.stage ? ` · ขั้นตอน: ${stageLabel(e2.stage)}` : ''}`;
                  return null;
                });
                if (forced) {
                  out.className = 'install-out ok-text';
                  out.textContent = `ติดตั้งทับ ${forced.plugin?.name ?? ''} ${forced.plugin?.version ?? ''} แล้ว — สำเนาเดิมอยู่ใน .trash`;
                  check.disabled = false;
                  src.disabled = false;
                  await refresh();
                } else force.disabled = false;
              };
              out.append(force);
            }
            check.disabled = false;
            src.disabled = false;
            return null;
          });
          if (res) {
            out.className = 'install-out ok-text';
            out.textContent = `ติดตั้ง ${res.plugin?.name ?? ''} ${res.plugin?.version ?? ''} แล้ว`;
            check.disabled = false;
            src.disabled = false;
            await refresh();
          } else install.disabled = false;
        };
        out.append(install);
      };

      const reload = el('button', null, 'โหลดปลั๊กอินใหม่');
      reload.onclick = async () => { await rpc('plugins.reload').catch(() => null); await refresh(); };
      page.append(reload);
      paint();
      continue;
    }

    if (section.custom === 'mcp') {
      let live = mcpReady;
      const wrap = el('div');
      page.append(wrap);

      const paintMcp = () => {
        wrap.textContent = '';
        for (const s of live.servers ?? []) {
          const card = el('div', 'plugin-card');
          const head = el('div', 'plugin-head');
          head.append(el('div', 'plugin-name', s.name));
          const state = !s.enabled ? 'ปิด' : s.connected ? `${s.tools} tools` : 'เชื่อมต่อไม่ได้';
          head.append(el('span', `plugin-state${!s.enabled ? '' : s.connected ? ' on' : ' bad'}`, state));
          card.append(head);
          card.append(el('div', 'plugin-source dim',
            `${s.scope === 'project' ? 'โปรเจกต์นี้' : 'ทุกโปรเจกต์'} · ${s.command}${s.args?.length ? ` ${s.args.join(' ')}` : ''}${s.risk === 'read' ? ' · อ่านอย่างเดียว' : ' · เขียน (ถามตามโหมด)'}`));
          if (s.error) card.append(el('div', 'plugin-desc', s.error));
          const actions = el('div', 'plugin-actions');
          const toggle = el('button', null, s.enabled ? 'ปิด' : 'เปิด');
          toggle.onclick = async () => {
            toggle.disabled = true;
            const res = await rpc(s.enabled ? 'mcp.disable' : 'mcp.enable', { name: s.name, scope: s.scope }).catch(() => null);
            if (res) { live = res; paintMcp(); } else toggle.disabled = false;
          };
          const note = el('div', 'plugin-source dim');
          const test = el('button', null, 'ทดสอบ');
          test.onclick = async () => {
            test.disabled = true;
            note.className = 'plugin-source dim';
            note.textContent = 'กำลังเชื่อมต่อ…';
            const r = await rpc('mcp.test', { name: s.name, scope: s.scope }).catch((e) => ({ ok: false, error: e.message }));
            note.className = r.ok ? 'plugin-source ok-text' : 'plugin-source err-text';
            note.textContent = r.ok
              ? `เชื่อมต่อได้ใน ${r.ms} ms — ${r.tools.length} tools${r.tools.length ? `: ${r.tools.map((t) => t.name).join(', ')}` : ''}`
              : `err: ${r.error}`;
            test.disabled = false;
          };
          const del = el('button', 'danger-btn', 'ลบ');
          del.onclick = async () => {
            if (!window.confirm(`ลบ MCP server "${s.name}" ออกจาก${s.scope === 'project' ? 'โปรเจกต์นี้' : 'การตั้งค่าส่วนกลาง'}?`)) return;
            del.disabled = true;
            const res = await rpc('mcp.remove', { name: s.name, scope: s.scope }).catch(() => null);
            if (res) { live = res; paintMcp(); } else del.disabled = false;
          };
          actions.append(toggle, test, del);
          card.append(actions, note);
          wrap.append(card);
        }

        // The add form carries every field `aipass mcp add` takes — a form
        // that cannot express what the command can is half a feature.
        const nameI = document.createElement('input');
        nameI.type = 'text';
        nameI.placeholder = 'ชื่อ (a-z 0-9 - _)';
        const cmdI = document.createElement('input');
        cmdI.type = 'text';
        cmdI.placeholder = 'คำสั่ง เช่น npx';
        const argsI = document.createElement('textarea');
        argsI.rows = 2;
        argsI.placeholder = 'อาร์กิวเมนต์ บรรทัดละตัว';
        const envI = document.createElement('textarea');
        envI.rows = 2;
        envI.placeholder = 'env บรรทัดละ K=V (ไม่บังคับ)';
        const cwdI = document.createElement('input');
        cwdI.type = 'text';
        cwdI.placeholder = 'โฟลเดอร์ทำงาน สัมพัทธ์กับโปรเจกต์ (ไม่บังคับ)';
        const scopeS = document.createElement('select');
        for (const [v, text] of [['home', 'ทุกโปรเจกต์'], ['project', 'เฉพาะโปรเจกต์นี้']]) {
          const opt = document.createElement('option');
          opt.value = v;
          opt.textContent = text;
          scopeS.append(opt);
        }
        const riskS = document.createElement('select');
        for (const [v, text] of [['write', 'เขียน — ผ่านการถามตามโหมด'], ['read', 'อ่านอย่างเดียว — ไม่ถามเลย']]) {
          const opt = document.createElement('option');
          opt.value = v;
          opt.textContent = text;
          riskS.append(opt);
        }

        const form = el('div', 'set-group');
        form.append(el('div', 'set-title', 'เพิ่มเซิร์ฟเวอร์'));
        form.append(row('ชื่อ', 'ใช้เป็นส่วนหนึ่งของ marker: MCP__ชื่อ__tool', nameI));
        form.append(row('คำสั่ง', 'โปรแกรมที่พูด MCP ผ่าน stdio', cmdI));
        form.append(row('อาร์กิวเมนต์', 'ทีละตัวต่อบรรทัด', argsI));
        form.append(row('env', 'บรรทัดละ K=V', envI));
        form.append(row('โฟลเดอร์ทำงาน', 'ไม่บังคับ — เซิร์ฟเวอร์ที่อ่าน path สัมพัทธ์จะอ้างจากที่นี่', cwdI));
        form.append(row('ขอบเขต', 'ชื่อซ้ำกัน: โปรเจกต์นี้ทับค่าส่วนกลางเสมอ', scopeS));
        form.append(row('ความเสี่ยง', 'MCP tool คือโปรแกรมของคนอื่น — ค่าเริ่มต้นคือ "เขียน" ให้ผ่านการถาม', riskS));

        const readForm = () => {
          const env = {};
          for (const l of envI.value.split(/\r?\n/).map((x) => x.trim()).filter(Boolean)) {
            const eq = l.indexOf('=');
            if (eq < 1) throw new Error(`env ต้องเป็น K=V: "${l}"`);
            env[l.slice(0, eq)] = l.slice(eq + 1);
          }
          const params = {
            name: nameI.value.trim(),
            command: cmdI.value.trim(),
            args: argsI.value.split(/\r?\n/).map((x) => x.trim()).filter(Boolean),
            env,
            // A select always has a value in the browser; the fallbacks are for
            // the answer this form gives when nothing was ever chosen.
            risk: riskS.value || 'write',
            scope: scopeS.value || 'home',
          };
          if (cwdI.value.trim()) params.cwd = cwdI.value.trim();
          return params;
        };

        const fout = el('div', 'plugin-source dim');
        const testBtn = el('button', null, 'ทดสอบ');
        testBtn.onclick = async () => {
          let params;
          try { params = readForm(); } catch (e) { fout.className = 'plugin-source err-text'; fout.textContent = e.message; return; }
          testBtn.disabled = true;
          fout.className = 'plugin-source dim';
          fout.textContent = 'กำลังเชื่อมต่อ…';
          const r = await rpc('mcp.test', params).catch((e) => ({ ok: false, error: e.message }));
          fout.className = r.ok ? 'plugin-source ok-text' : 'plugin-source err-text';
          fout.textContent = r.ok
            ? `เชื่อมต่อได้ — ${r.tools.length} tools${r.tools.length ? `: ${r.tools.map((t) => t.name).join(', ')}` : ''}`
            : `err: ${r.error}`;
          testBtn.disabled = false;
        };
        const saveBtn = el('button', 'primary', 'บันทึก');
        saveBtn.onclick = async () => {
          let params;
          try { params = readForm(); } catch (e) { fout.className = 'plugin-source err-text'; fout.textContent = e.message; return; }
          saveBtn.disabled = true;
          const res = await rpc('mcp.add', params).catch((e) => {
            fout.className = 'plugin-source err-text';
            fout.textContent = `err: ${e.message}`;
            return null;
          });
          saveBtn.disabled = false;
          if (res) { live = res; paintMcp(); }
        };
        const btnRow = el('div', 'plugin-actions');
        btnRow.append(testBtn, saveBtn);
        form.append(btnRow, fout);
        wrap.append(form);
      };

      paintMcp();
      continue;
    }

    if (section.custom === 'rules') {
      draft.rules = Array.isArray(draft.rules) ? draft.rules : [];
      page.append(el('p', 'settings-empty',
        'กฎถูกเช็คก่อนโหมดเสมอ — กฎเองก่อน · `docs/** → อนุญาต` = เลิกถามเรื่องไฟล์ใน docs · '
        + '`.env* → ห้าม` = ล็อก secrets ไม่ให้เขียนแม้ในโหมด yolo · `**` ข้ามโฟลเดอร์ได้ `*` ไม่ได้ · '
        + 'ทีละ pattern เพียง 1 กฎ — กฎแรกที่ match ชนะ'));
      const group = el('div', 'set-group');

      // The same glob the engine uses, copied on purpose: a tester that matched
      // differently from the gate would prove nothing at all.
      const globMatch = (pattern, text) => new RegExp('^' + String(pattern)
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*/g, '\u0000')
        .replace(/\*/g, '[^/]*')
        .replace(/\u0000/g, '.*') + '$', 'i').test(text);

      const probe = document.createElement('input');
      probe.type = 'text';
      probe.placeholder = 'ลองพิมพ์ path — .env.local';
      const probeKind = document.createElement('select');
      for (const [v, text] of [['write', 'แก้ไฟล์'], ['run', 'รันคำสั่ง']]) {
        const opt = document.createElement('option');
        opt.value = v;
        opt.textContent = text;
        probeKind.append(opt);
      }
      const verdict = el('span', 'rule-verdict dim', 'ยังไม่ทดสอบ');
      const drawVerdict = () => {
        const p = probe.value.trim().split(/\s+/)[0] ?? '';
        if (!p) { verdict.textContent = 'ยังไม่ทดสอบ'; verdict.className = 'rule-verdict dim'; return; }
        const kind = probeKind.value;
        const idx = draft.rules.findIndex((r) => r.pattern
          && globMatch(r.pattern, p)
          && (!(r.kinds ?? []).length || r.kinds.includes(kind)));
        if (idx === -1) {
          verdict.textContent = `ไม่มีกฎ — ${p} ไปใช้โหมดที่ตั้งไว้`;
          verdict.className = 'rule-verdict dim';
          return;
        }
        const r = draft.rules[idx];
        const label = { allow: 'อนุญาต (ไม่ถาม)', deny: 'ห้ามหยุดอยู่ ๆ', ask: 'ถามก่อน' }[r.decision ?? 'ask'];
        verdict.textContent = `กฎที่ ${idx + 1} (${r.pattern}) → ${label}`;
        verdict.className = `rule-verdict ${r.decision === 'allow' ? 'ok' : r.decision === 'deny' ? 'bad' : ''}`;
      };
      probe.oninput = drawVerdict;
      probeKind.onchange = drawVerdict;

      const tester = el('div', 'rule-test');
      tester.append(probe, probeKind, verdict);
      group.append(tester);

      const list = el('div', 'set-group');
      const redraw = () => {
        list.textContent = '';
        if (!draft.rules.length) {
          list.append(el('p', 'settings-empty', 'ยังไม่มีกฎ — ทุกอย่างไปใช้โหมดที่เลือกข้างบน · กด “เพิ่มกฎ” เอาอันแรก'));
        }
        draft.rules.forEach((rule, i) => {
          const row = el('div', 'rule-row');
          row.append(el('span', 'rule-index', String(i + 1)));
          const pattern = document.createElement('input');
          pattern.type = 'text';
          pattern.value = rule.pattern ?? '';
          pattern.placeholder = 'docs/** · .env* · src/**/*.test.*';
          pattern.oninput = () => { rule.pattern = pattern.value; drawVerdict(); };
          const decision = document.createElement('select');
          for (const [v, text] of [['allow', 'อนุญาต'], ['deny', 'ห้าม'], ['ask', 'ถาม']]) {
            const opt = document.createElement('option');
            opt.value = v;
            opt.textContent = text;
            if ((rule.decision ?? 'ask') === v) opt.selected = true;
            decision.append(opt);
          }
          decision.onchange = () => { rule.decision = decision.value; drawVerdict(); };
          const kinds = document.createElement('select');
          for (const [v, text] of [['', 'ทุกอย่าง'], ['write,replace,delete,move', 'แก้ไฟล์'], ['run', 'รันคำสั่ง']]) {
            const opt = document.createElement('option');
            opt.value = v;
            opt.textContent = text;
            if ((rule.kinds ?? []).join(',') === v) opt.selected = true;
            kinds.append(opt);
          }
          kinds.onchange = () => { rule.kinds = kinds.value ? kinds.value.split(',') : undefined; drawVerdict(); };
          const del = el('button', 'mini', 'ลบ');
          del.onclick = () => { draft.rules.splice(i, 1); redraw(); };
          row.append(pattern, decision, kinds, del);
          list.append(row);
        });
      };
      redraw();
      group.append(list);
      const add = el('button', null, 'เพิ่มกฎ');
      add.onclick = () => { draft.rules.push({ pattern: '', decision: 'ask' }); redraw(); };
      group.append(add);
      page.append(group);
      continue;
    }

    if (section.custom === 'health') {
      // One button, same answers as the terminal: bridge up, extension
      // attached, quota figures — plus the fix for whatever is red. `status`
      // is token-free by design; `credits` rides the bridge cache so an idle
      // check does not poke the tab upstream.
      const out = el('div', 'set-group');
      const lines = el('div', 'dim', 'ยังไม่ได้ตรวจ — กดปุ่มด้านล่าง');
      out.append(lines);
      const run = el('button', 'primary', 'ตรวจตอนนี้');
      run.onclick = async () => {
        run.disabled = true;
        lines.textContent = '';
        lines.className = 'dim';
        try {
          const st = await rpc('status');
          const credits = await rpc('credits', { force: false }).catch(() => null);
          const rows = [
            ['bridge', st?.bridge ? 'พร้อม' : 'ไม่พร้อม', st?.bridge ? '' : 'รัน aipass dev หรือเปิดแอปใหม่'],
            ['extension', (st?.extensions ?? 0) > 0 ? `เชื่อมอยู่ ×${st.extensions}` : 'ยังไม่มี', (st?.extensions ?? 0) > 0 ? '' : 'โหลดโฟลเดอร์ aipass-bridge/extension ใน chrome://extensions'],
            ['tab', state.needsTab ? 'ยังไม่มี — run ล่าสุดขอ tab' : 'พร้อม (หรือยังไม่เคยขอ)', state.needsTab ? 'กด “เปิดให้” จาก welcome card' : ''],
            ['credits', credits ? `${credits.available} / ${credits.limit}` : 'ไม่ทราบ (ไม่มี tab)', credits && Number(credits.available) <= 0 ? 'รอรอบถัดไป หรือใช้โมเดล free-credit' : ''],
            ['build', st?.app ?? 'ไม่ทราบ', ''],
          ];
          for (const [k, v, fix] of rows) {
            const line = el('div', null, `${k}: ${v}${fix ? ` — ${fix}` : ''}`);
            lines.append(line);
          }
        } catch (err) {
          lines.className = 'install-out err';
          lines.textContent = `ตรวจไม่ได้: ${friendly(err.message)}`;
        }
        run.disabled = false;
      };
      page.append(out, run);
      continue;
    }

    const group = el('div', 'set-group');
    for (const field of section.fields) group.append(row(field.label, field.note, control(field)));
    page.append(group);
  }

  show(sections[0].id);
  const root = el('div', 'settings');
  root.append(nav, pages);
  body.append(root);

  // Inserted, not just built: a Save that says nothing when it refuses is the
  // same silence the sheet exists to prevent.
  const error = el('p', 'settings-error hidden');
  body.append(error);

  const actions = $('modal-actions');
  actions.textContent = '';

  const reset = el('button', null, 'คืนค่าเดิม');
  reset.onclick = async () => {
    await rpc('settings.reset');
    hideModal();
    openSettings();
    addCommandOut('คืนการตั้งค่าทั้งหมดเป็นค่าเริ่มต้นแล้ว');
  };

  const save = el('button', 'primary', 'บันทึก');
  save.onclick = async () => {
    // Check before writing: a budget under its reserve is a mistake the person
    // should hear about — not a setting that quietly misbehaves on the next
    // run. Zero steps is no mistake: it is the deliberate "no cap".
    const problems = [];
    const maxSteps = Number(draft.maxSteps);
    if (!Number.isFinite(maxSteps) || maxSteps < 0) problems.push('สูงสุดกี่ step ต้องเป็น 0 ขึ้นไป (0 = ไม่จำกัด)');
    const maxToolCalls = Number(draft.maxToolCalls);
    if (!Number.isFinite(maxToolCalls) || maxToolCalls < 1) problems.push('สูงสุดกี่ tool call ต้องเป็นตัวเลขอย่างน้อย 1');
    const maxWallClockMin = Number(draft.maxWallClockMin);
    if (!Number.isFinite(maxWallClockMin) || maxWallClockMin < 1) problems.push('เวลาสูงสุดต่อคำสั่ง ต้องเป็นตัวเลขอย่างน้อย 1 นาที');
    if (draft.maxCredits != null) {
      const creditCap = Number(draft.maxCredits);
      if (!Number.isFinite(creditCap) || creditCap < 0) problems.push('เพดานเครดิตต้องเป็น 0 (ไม่จำกัด) หรือตัวเลขบวก');
    }
     if (draft.maxResult != null) {
       const resultCap = Number(draft.maxResult);
       if (!Number.isFinite(resultCap) || (resultCap !== 0 && resultCap < 500)) problems.push('สูงสุดกี่ byte ต่อผลเครื่องมือ ต้องเป็น 0 (ค่าเริ่มต้น) หรืออย่างน้อย 500');
     }
    // The language keys are checked only when the payload carries them: a
    // window talking to a backend that predates them must still save (the
    // server's own sane() fills the defaults), and an absent key is not an
    // invalid one.
    if (draft.replyLanguage != null && !['th', 'en'].includes(draft.replyLanguage)) problems.push('ภาษาที่ตอบผู้ใช้ต้องเป็น th หรือ en');
    if (draft.minThaiRatio != null) {
      const minRatio = Number(draft.minThaiRatio);
      if (!Number.isFinite(minRatio) || minRatio < 0 || minRatio > 1) problems.push('สัดส่วนอักษรไทยขั้นต่ำต้องอยู่ระหว่าง 0 ถึง 1');
    }
    if (draft.repeatGuardMax != null) {
      const repeatMax = Number(draft.repeatGuardMax);
      if (!Number.isFinite(repeatMax) || repeatMax < 1) problems.push('เพดานการบล็อกซ้ำต้องเป็นตัวเลขอย่างน้อย 1');
    }
    if (draft.attempts != null) {
      const attemptsN = Number(draft.attempts);
      if (!Number.isFinite(attemptsN) || attemptsN < 1 || attemptsN > 5) problems.push('รอบลองสูงสุดต่อคำสั่งต้องอยู่ระหว่าง 1 ถึง 5');
    }
    if (draft.verifyCommand) {
      const command = String(draft.verifyCommand);
      if (/[\r\n]/.test(command)) problems.push('คำสั่งตรวจต้องเป็นบรรทัดเดียว (คำสั่งเดียว)');
      else if (command.trim().length > 300) problems.push('คำสั่งตรวจยาวเกิน 300 ตัวอักษร');
    }
    const budget = Number(draft.compaction?.contextTokens);
    const reserve = Number(draft.compaction?.reserveTokens);
    if (!Number.isFinite(budget) || budget < 1000) problems.push('งบบริบทควร 1000 token ขึ้นไป');
    if (!Number.isFinite(reserve) || reserve < 128) problems.push('ส่วนสำรองควรอย่างน้อย 128 token');
    if (Number.isFinite(budget) && Number.isFinite(reserve) && reserve >= budget) problems.push('ส่วนสำรองต้องน้อยกว่างบทั้งหมด');
    if (draft.chatUrl && !/^https?:\/\//.test(String(draft.chatUrl))) problems.push('หน้า chat ต้องขึ้นต้นด้วย http:// หรือ https://');
    // Path rules get the same treatment: an empty pattern would be dropped by
    // the server silently, and a duplicate pattern is a rule that can never be
    // reached — first match wins. Both look like protection and behave like
    // nothing, which is the exact failure the sheet exists to prevent.
    const rules = Array.isArray(draft.rules) ? draft.rules : [];
    for (const [i, r] of rules.entries()) {
      if (!r.pattern?.trim()) problems.push(`กฎที่ ${i + 1} ยังไม่มี pattern`);
    }
    const seen = new Set();
    for (const r of rules) {
      const p = r.pattern?.trim();
      if (!p) continue;
      if (seen.has(p)) problems.push(`pattern "${p}" ซ้ำ — กฎแรกที่ match ชนะ อันหลังไม่ทำงาน`);
      seen.add(p);
    }
    if (problems.length) { error.textContent = problems.join(' · '); error.classList.remove('hidden'); return; }
    error.classList.add('hidden');
    // The sheet's minutes go back to the stored milliseconds before the save.
    draft.maxWallClockMs = Math.round(maxWallClockMin) * 60_000;
    delete draft.maxWallClockMin;
    const next = await rpc('settings.set', draft).catch((err) => ({ error: err.message }));
    if (next.error) { error.textContent = next.error; error.classList.remove('hidden'); return; }
    state.settings = next;
    applyTheme(next.theme);
    hideModal();
    await refreshHeader();
    // The playbook library is rebuilt by the backend when skillsDirs changes,
    // and the rail shows what the folders hold — so the rail asks again.
    await refreshSkills();
    applyModeFromSettings();
    applyThinkingFromSettings();
    applyTemperatureFromSettings();
    addCommandOut('บันทึกการตั้งค่าแล้ว');
  };

  const close = el('button', null, 'ปิด');
  close.onclick = () => { hideModal(); applyTheme(state.settings?.theme ?? 'dark'); };
  actions.append(error, reset, close, save);
  $('modal').classList.remove('hidden');

  // The meter follows the live session while the sheet is open.
  const timer = setInterval(async () => {
    if ($('modal').classList.contains('hidden')) { clearInterval(timer); return; }
    const live = await rpc('status').catch(() => null);
    const bar = $('ctx-bar');
    if (!bar) { clearInterval(timer); return; }
    const pct = live?.context?.percent ?? 0;
    bar.className = `ctx-bar ${pct >= 85 ? 'full' : pct >= 60 ? 'warm' : ''}`;
    bar.style.setProperty('--pct', `${pct}%`);
    bar.title = `${pct}% ของงบบริบท`;
  }, 2000);
  $('modal').dataset.meterTimer = String(timer);
}


/**
 * Apply the theme for real. `theme` sat in settings doing nothing at all — a
 * setting that changes nothing is worse than no setting, because it looks like
 * a feature and behaves like a lie.
 */


/* --------------------------------------------------------------- settings */

$('settings-btn').onclick = () => openSettings();

// The moon in the header used to be a label with nothing behind it — a control
// whose name is the promise it broke. It flips the theme now and writes the
// choice through, because a theme that flips back on the next reload is worse
// than one that never moved.
$('theme-toggle').onclick = async () => {
  const current = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
  const next = current === 'light' ? 'dark' : 'light';
  applyTheme(next);
  state.settings = await rpc('settings.set', { theme: next }).catch(() => state.settings ?? {});
};

/* ---------------------------------------------------------- plugin panels */

async function refreshPanels() {
  const holder = $('plugin-panels');
  const details = await rpc('plugins.list').catch(() => null);
  // The transcript renderer hides plugin marker calls from the bubble, so it
  // has to know the current marker table; takesBody decides whether a block's
  // inner lines are eaten with the header. An older backend without toolDefs
  // still works: plain markers, single-line.
  state.pluginTools = (details?.toolDefs ?? (details?.tools ?? []).map((marker) => ({ marker })))
    .filter((t) => t?.marker);
  // No plugin, no panel, no row. The section only appears when a plugin has
  // something to draw — an empty "ปลั๊กอิน" heading read as a broken feature.
  const group = $('plugins-group');
  if (!details?.panels?.length) {
    holder.classList.add('hidden');
    if (group) { group.hidden = true; group.open = false; }
    return;
  }
  holder.classList.remove('hidden');
  if (group) {
    // It opens the first time it appears and stays as you left it after that.
    const wasHidden = group.hidden;
    group.hidden = false;
    if (wasHidden) group.open = true;
  }
  holder.textContent = '';
  for (const panel of details.panels) {
    const box = el('div', 'plugin-panel');
    box.id = `panel-${panel.id}`;
    box.dataset.panel = panel.id;
    box.dataset.title = panel.title ?? panel.id;
    holder.append(box);
    await paintPanel(box, panel.id);
  }
}

/** Paint one panel's body. A repaint replaces the whole box: the finished event
 *  refreshes every panel after every run, and appending a fresh body each time
 *  stacked the scratchpad's history into the sidebar a copy at a time. */
async function paintPanel(box, id) {
  box.textContent = '';
  box.append(el('h5', null, box.dataset.title ?? id));
  try {
    const { html } = await rpc('panel.render', { id });
    const body = el('div', 'plugin-body');
    body.innerHTML = html; // plugin markup is trusted: plugins are installed code
    box.append(body);
  } catch (err) {
    box.append(el('p', 'dim', err.message));
  }
}

/* ------------------------------------------------------------ header state */

async function refreshHeader() {
  const st = await rpc('status').catch(() => null);
  if (!st) return;
  $('status').textContent = '';
  const dot = (ok, label) => {
    const s = el('span');
    s.append(el('span', 'dot ' + (ok ? 'ok' : 'no')));
    s.append(document.createTextNode(label));
    return s;
  };
  // The bridge and the extension are the AiPASS path. Another provider is
  // reached by the backend itself, so a red "bridge" would name a problem
  // that does not exist — the provider's own line says who is answering.
  if (st.provider && st.provider !== 'aipass') {
    $('status').append(dot(true, `provider ${st.provider}`));
  } else {
    $('status').append(dot(st.bridge, 'bridge'), dot(st.extensions > 0, `extension ×${st.extensions}`));
  }
  refreshMeter();
  if (st.model) {
    // Live while a run spends credits; idle windows ride the bridge's cache
    // instead of poking the de.aipass.net tab every ten seconds.
    const credits = await rpc('credits', { force: Boolean(state.running) }).catch(() => null);
    if (credits) $('status').append(el('span', null, `credits ${credits.available?.toLocaleString?.() ?? credits.available} / ${credits.limit?.toLocaleString?.() ?? credits.limit}`));
  }
  if (st.model && !$('model').options.length) await fillModels(st.model);
}

/**
 * Fill the model dropdown with the models that can actually hold a
 * conversation.
 *
 * The bridge offers 38 of them, 15 of which make images, video, or music — a chat
 * run cannot use those, and picking one fails in a way that looks like the app
 * broke. The list is filtered to kind === 'chat', labelled with the human name
 * (the id stays the value), and the model in use is always kept in view so the
 * header never shows a different model than the one that would run.
 *
 * A saved model the live catalog no longer lists carries the run's own verdict
 * on its option — the catalog check in harness/loop.mjs refuses such a run
 * before any send — so the picker says "the site dropped this" before the run
 * has to say it as an error. A fallback list cannot judge, so it never marks.
 */
async function fillModels(currentModel) {
  const models = await rpc('models').catch(() => null);
  const all = models?.data ?? models?.models ?? [];
  const chat = all.filter((m) => !m.kind || m.kind === 'chat');
  const list = chat.some((m) => (m.id ?? m) === currentModel)
    ? chat
    : [...chat, ...all.filter((m) => (m.id ?? m) === currentModel)];
  // `aipass/`-prefixed ids compare bare, the same way the loop's check does.
  const bare = (id) => String(id ?? '').replace(/^aipass\//, '');
  const dropped = Boolean(currentModel) && models?.source === 'live'
    && !all.some((m) => bare(m.id ?? m) === bare(currentModel));
  if (currentModel && !list.some((m) => (m.id ?? m) === currentModel)) list.push({ id: currentModel });
  // The list is rebuilt when the provider changes, so the old options go
  // first: a model of the previous provider must not stay selectable.
  $('model').textContent = '';
  for (const m of list) {
    const opt = document.createElement('option');
    const id = m.id ?? m;
    opt.value = id;
    opt.textContent = m.name && m.name !== id ? m.name : id;
    opt.title = `${id}${m.description ? ` — ${m.description}` : ''}`;
    if (dropped && id === currentModel) {
      opt.textContent += ' — ไม่มีในรายการของเว็บแล้ว';
      opt.title = `${id} — the site no longer offers this model; a run would stop and ask for a current pick`;
    }
    $('model').append(opt);
  }
  if (list.length) $('model').value = currentModel ?? $('model').options[0].value;
}

setInterval(refreshHeader, 10_000);

/* ------------------------------------------------------------------ boot */

/**
 * What the window says when there is nothing to show yet.
 *
 * An empty main area reads as "broken" — the first thing on screen has to say
 * what this is, whether it can run right now, and what to type. It disappears
 * the moment a task starts, and comes back when a session is empty again.
 */
function showWelcome(readiness) {
  hideWelcome();
  const card = el('div', 'welcome');
  card.id = 'welcome';

  card.append(el('h2', null, 'aipass desktop'));
  card.append(el('p', null, 'คุยกับโมเดลของ de.aipass.net จากหน้านี้ แล้วสั่งให้แก้ไฟล์ในโปรเจกต์ของคุณ'));

  const list = el('ul');
  const items = [
    ['คุย', 'พิมพ์คำถามแล้วกด Enter — ตอบสตรีมตรง ๆ ไม่ต้องเปิดบราวเซอร์'],
    ['สั่งแก้ไฟล์', 'บอกอย่าง "สรุป README ให้สั้นลง" มันอ่านแล้วแก้ให้ โดยอนุมัติทุกไฟล์ก่อนเขียน'],
    ['แนบไฟล์', 'ลากรุป เอกสาร หรือวิดีโอมาวางบนหน้านี้ แล้วถามเกี่ยวมันได้เลย'],
  ];
  for (const [head, body] of items) {
    const li = el('li');
    li.append(el('strong', null, head), el('span', null, ' — ' + body));
    list.append(li);
  }
  card.append(list);

  const ready = el('div', 'ready');
  const rows = readiness.provider
    // Another provider is reached by the backend itself: the bridge, the
    // extension and the chat tab are not part of that path, so listing them
    // as "not ready" would name a problem that does not exist.
    ? [['provider', `ผู้ให้บริการ ${readiness.provider}`, readiness.providerOk !== false]]
    : [
      ['bridge', 'ตัวกลาง local', readiness.bridge],
      ['extension', 'ส่วนขยายใน Chrome', readiness.extensions > 0],
      ['tab', 'หน้า de.aipass.net ที่ล็อกอินอยู่', readiness.tab],
      // A fourth row only when the quota is known: 0 available reads as
      // "broken" without it, while null (no tab) means the tab row already
      // explains what to fix.
      ...(readiness.credits === null || readiness.credits === undefined ? [] : [[
        'credits',
        `เครดิต ${readiness.credits.available} / ${readiness.credits.limit}`,
        Number(readiness.credits.available) > 0,
      ]]),
    ];
  for (const [key, label, ok] of rows) {
    const row = el('div', 'ready-row ' + (ok ? 'ok' : 'no'));
    row.append(el('span', 'dot ' + (ok ? 'ok' : 'no')));
    row.append(el('span', null, `${ok ? 'พร้อม — ' : 'ยังไม่ได้ — '}${label}`));
    row.append(el('span', 'grow'));
    if (!ok && key === 'tab') {
      const fix = el('button', 'mini', 'เปิดให้');
      fix.onclick = () => rpc('browser.open', { url: appSettingsUrl() }).catch(() => {});
      row.append(fix);
    }
    if (!ok && key === 'credits') row.append(el('span', 'dim', 'รอรอบถัดไป หรือใช้โมเดล free-credit'));
    if (!ok && key === 'extension') row.append(el('span', 'dim', 'โหลดจากโฟลเดอร์ aipass-bridge/extension'));
    if (!ok && key === 'bridge') row.append(el('span', 'dim', 'รัน aipass dev'));
    ready.append(row);
  }
  card.append(ready);

  card.append(el('p', 'dim', 'เริ่มจากพิมพ์ข้อความข้างล่างได้เลย · กด ? เพื่อดูวิธีใช้ทั้งหมด'));
  log.append(card);
}

function hideWelcome() { $('welcome')?.remove(); }

const appSettingsUrl = () => state.settings?.chatUrl ?? 'https://de.aipass.net/chat';

async function refreshReadiness() {
  const st = await rpc('status').catch(() => null);
  if (!st) { showWelcome({ bridge: false, extensions: 0, tab: false }); return; }
  // A provider that is not AiPASS is reached by the backend itself, so the
  // bridge and the chat tab are not on its path.
  if (st.provider && st.provider !== 'aipass') {
    showWelcome({ provider: st.provider, providerOk: true });
    return;
  }
  // The quota is what tells "no tab" (null — the tab row names the fix) from
  // "tab attached but the pool is empty" (0 — the new credits row names its
  // own fix). Idle windows ride the bridge cache (force:false); a run spends,
  // so it forces.
  const credits = await rpc('credits', { force: Boolean(state.running) }).catch(() => null);
  showWelcome({
    bridge: st.bridge,
    extensions: st.extensions ?? 0,
    // A run can only tell us "no tab" by failing, so the strip stays neutral
    // until that happens; the banner flips it and offers the fix.
    tab: !state.needsTab,
    credits: credits ?? null,
  });
}

/* ------------------------------------------------------------------ slash */

/* Every command the app has, reachable by typing "/". The header carries three
 * controls and the rest live here — nothing important is hidden behind a menu
 * you have to guess at, and the list itself explains what the app does. */
const COMMANDS = [
  { cmd: 'help', desc: 'วิธีใช้ทั้งหมด', run: openHelp },
  { cmd: 'model', desc: 'เปลี่ยนโมเดล — /model หรือ /model <id>', args: true, run: (arg) => (arg ? setModel(arg) : pickModel()) },
  { cmd: 'provider', desc: 'สลับผู้ให้บริการ — /provider หรือ /provider <id>', args: true, run: (arg) => (arg ? setProvider(arg) : pickProvider()) },
  { cmd: 'models', desc: 'ดูรายการโมเดลที่ใช้คุยได้', run: listModels },
  { cmd: 'mode', desc: 'สิทธิ์แก้ไฟล์ — /mode ask|auto|yolo', args: true, run: (arg) => (arg ? setMode(arg) : pickMode()) },
  { cmd: 'status', desc: 'สถานะ bridge / extension / tab / credits', run: showStatus },
  { cmd: 'paint', desc: 'สถิติ paint cache ของการสตรีม — hit/miss ต่อเฟรม', run: showPaintStats },
  { cmd: 'conversations', desc: 'เลือกบทสนทนาของ bridge (ความจำของโมเดล)', run: pickConversation },
  { cmd: 'fresh', desc: 'เริ่มบทสนทนาบน bridge ใหม่ (ความจำ wiped)', run: freshConversation },
  { cmd: 'compact', desc: 'บีบบริบททันที (สรุปงานเก่าแล้วเริ่ม conversation ใหม่)', run: compactNow },
  { cmd: 'memory', desc: 'ดู facts ที่จำข้าม session — /memory clear ลืมทั้งหมด', args: true, run: (arg) => showMemory(arg) },
  { cmd: 'mcp', desc: 'ดู servers/tools จาก MCP (จัดการที่ /settings → MCP)', run: showMcp },
  { cmd: 'symbols', desc: 'ดู declarations ของไฟล์ — /symbols <file>', args: true, run: (arg) => showSymbols(arg) },
  { cmd: 'new', desc: 'เริ่มบทสนทนาใหม่ในหน้าต่าง', run: startNewSession },
  { cmd: 'resume', desc: 'เปิดบทสนทนาเดิม', run: resumeSession },
  { cmd: 'fork', desc: 'แยกบทสนทนาจุดนี้ไปแก้ต่อแยก', run: forkSession },
  { cmd: 'plan', desc: 'เปิด/ปิด plan mode (ร่างแผนให้อนุมัติก่อนทำ)', run: togglePlan },
  { cmd: 'attach', desc: 'แนบรูป เอกสาร หรือวิดีโอ', run: () => $('file-picker').click() },
  { cmd: 'clip', desc: 'แนบจากคลิปบอร์ด (เช่น screenshot ที่ Ctrl+V)', run: clipPaste },
  { cmd: 'file', desc: 'แนบไฟล์จาก path — /file <path>', args: true, run: (arg) => attachPath(arg, 'file') },
  { cmd: 'image', desc: 'แนบรูปจาก path — /image <path>', args: true, run: (arg) => attachPath(arg, 'image') },
  { cmd: 'open', desc: 'เปิดดูไฟล์ — /open <path>', args: true, run: (arg) => (arg ? openFile(arg) : pickFile()) },
  { cmd: 'skills', desc: 'คู่มือ (playbook) ที่มี', run: showSkills },
  { cmd: 'diff', desc: 'ดูการเปลี่ยนแปลงที่รอเขียน', run: showPendingDiff },
  { cmd: 'apply', desc: 'เขียนไฟล์ที่อนุมัติลงดิสก์', run: applyChecked },
  { cmd: 'discard', desc: 'ทิ้งไฟล์ที่รออยู่ทั้งหมด', run: discardAll },
  { cmd: 'project', desc: 'เลือกโฟลเดอร์โปรเจกต์', run: pickProject },
  { cmd: 'settings', desc: 'ตั้งค่าทั้งหมด', run: openSettings },
  { cmd: 'stop', desc: 'ยกเลิกรันที่กำลังทำ', run: () => rpc('cancel', { root: state.root ?? undefined }).then((res) => addCommandOut(res && res.ok === false ? `หยุดไม่ได้ — ไม่มีรันที่กำลังทำอยู่${res.reason ? ` (${res.reason})` : ''}` : 'ยกเลิกแล้ว')) },
];

const slash = { open: false, items: [], index: 0 };

const slashMatches = (value) => {
  const typed = value.slice(1).split(/\s+/)[0].toLowerCase();
  return COMMANDS.filter((c) => c.cmd.startsWith(typed));
};

// "/" opens the palette while the first word is still being typed; a space
// means an argument is being written and the palette has done its job.
const slashTyping = (value) => value.startsWith('/') && !/\s/.test(value.slice(1));

function renderSlash(value, keepSelection = false) {
  slash.items = slashMatches(value);
  // A typed word that is already a whole command selects it: "/mode" has to mean
  // /mode, not /model, even though "mode" is a prefix of "model".
  const typed = value.slice(1).split(/\s+/)[0].toLowerCase();
  const exact = slash.items.findIndex((c) => c.cmd === typed);
  slash.index = keepSelection || exact < 0 ? slash.index : exact;
  if (slash.index >= slash.items.length) slash.index = 0;
  const list = $('slash-list');
  list.textContent = '';
  slash.items.forEach((item, i) => {
    const li = el('li');
    li.setAttribute('aria-selected', i === slash.index ? 'true' : 'false');
    li.append(el('span', 'cmd', '/' + item.cmd), el('span', 'desc', item.desc));
    li.onmousedown = (ev) => { ev.preventDefault(); pickSlash(i); };
    list.append(li);
  });
  // Nothing matches: say so instead of vanishing. A palette that silently
  // disappears looks like the "/" did nothing at all.
  if (!slash.items.length) {
    const li = el('li', 'empty');
    li.setAttribute('aria-selected', 'false');
    li.append(el('span', 'desc', `ไม่พบคำสั่งที่ขึ้นต้นด้วย "/${typed}" — ลอง /help`));
    list.append(li);
  }
  $('slash').classList.remove('hidden');
}

function openSlash(value) {
  slash.open = true;
  renderSlash(value);
}

function closeSlash() {
  slash.open = false;
  $('slash').classList.add('hidden');
}

function moveSlash(delta) {
  if (!slash.items.length) return;
  slash.index = (slash.index + delta + slash.items.length) % slash.items.length;
  renderSlash($('task').value, true); // arrows override the exact-match preference
}

/** Run the highlighted command. One with arguments leaves "/cmd " in the box so
 *  the argument can be typed instead of silently guessing. */
function pickSlash(index) {
  const item = slash.items[index];
  if (!item) return;
  closeSlash();
  const arg = $('task').value.slice(1).split(/\s+/).slice(1).join(' ').trim();
  $('task').value = '';
  if (item.args && !arg) {
    $('task').value = `/${item.cmd} `;
    $('task').focus();
    return;
  }
  void runCommand(item, arg);
}

function runCommand(item, arg) {
  addCommandOut(`/${item.cmd}${arg ? ` ${arg}` : ''}`);
  return Promise.resolve()
    .then(() => item.run(arg))
    .catch((err) => addNote(`คำสั่งไม่สำเร็จ: ${err.message}`));
}

/* ------------------------------------------------------- command handlers */

async function setModel(id) {
  await rpc('config.set', { model: id });
  state.settings = await rpc('settings.get').catch(() => null);
  await refreshHeader();
  addCommandOut(`โมเดล: ${id}`);
}

/**
 * Switch the provider.
 *
 * The switch is machine-wide, so it goes through the backend and lands in the
 * settings file — the terminal sees it too. The model list is rebuilt
 * afterwards: the models of one provider mean nothing to another.
 */
async function setProvider(id) {
  await rpc('provider.set', { id });
  state.provider = id;
  await fillProviders(id);
  const st = await rpc('status').catch(() => null);
  await fillModels(st?.model ?? null);
  refreshMeta();
  addCommandOut(`ผู้ให้บริการ: ${id}`);
}

function pickProvider() {
  rpc('providers.list').then((res) => {
    const list = res?.providers ?? [];
    $('modal-title').textContent = 'เลือกผู้ให้บริการ';
    const body = $('modal-body');
    body.textContent = '';
    if (!list.length) body.append(el('p', 'dim', 'ยังไม่มีผู้ให้บริการที่ตั้งไว้ — เพิ่มได้ที่ /settings → ผู้ให้บริการ'));
    for (const p of list) {
      const row = el('button', p.id === ($('provider').value) ? 'primary' : null,
        `${p.label || p.id}${p.id === res.active ? ' — ใช้อยู่' : ''}${p.kind !== 'aipass' && !p.hasKey ? ' — ยังไม่มี key' : ''}`);
      row.style.display = 'block';
      row.style.width = '100%';
      row.style.textAlign = 'left';
      row.style.marginBottom = '6px';
      row.onclick = () => { hideModal(); void setProvider(p.id); };
      body.append(row);
    }
    $('modal-actions').textContent = '';
    const close = el('button', 'primary', 'ปิด');
    close.onclick = hideModal;
    $('modal-actions').append(close);
    $('modal').classList.remove('hidden');
  }).catch((err) => addNote(err.message));
}

function pickModel() {
  rpc('models').then((res) => {
    const list = res?.data ?? res?.models ?? [];
    $('modal-title').textContent = 'เลือกโมเดล';
    const body = $('modal-body');
    body.textContent = '';
    if (!list.length) body.append(el('p', 'dim', 'bridge ยังไม่ส่งรายการโมเดลมา'));
    for (const m of list) {
      const row = el('button', (m.id ?? m) === $('model').value ? 'primary' : null, `${m.id ?? m}${m.name && m.name !== m.id ? ` — ${m.name}` : ''}`);
      row.style.display = 'block';
      row.style.width = '100%';
      row.style.textAlign = 'left';
      row.style.marginBottom = '6px';
      row.onclick = () => { hideModal(); void setModel(m.id ?? m); };
      body.append(row);
    }
    $('modal-actions').textContent = '';
    const close = el('button', 'primary', 'ปิด');
    close.onclick = hideModal;
    $('modal-actions').append(close);
    $('modal').classList.remove('hidden');
  }).catch((err) => addNote(err.message));
}

function setMode(mode) {
  if (!MODE_VIEWS[mode]) { addNote('โหมดที่ใช้ได้: ask | auto | yolo | plan'); return null; }
  $('mode').value = mode;
  const patch = MODE_VIEWS[mode];
  state.settings = { ...(state.settings ?? {}), ...patch };
  rpc('settings.set', patch).catch((err) => addNote(`เปลี่ยนโหมดไม่ได้: ${err.message}`));
  return $('mode').selectedOptions[0].textContent;
}

function pickMode() {
  $('modal-title').textContent = 'สิทธิ์ในการแก้ไฟล์';
  const body = $('modal-body');
  body.textContent = '';
  const rows = [
    ['ask', 'ถามก่อนเขียนทุกไฟล์ — เห็น diff แล้วติ๊กก่อนลงดิสก์'],
    ['auto', 'เขียนเลย — ไม่ต้องอนุมัติทีละไฟล์'],
    ['yolo', 'เขียน + รันคำสั่ง shell ได้ด้วย'],
    ['plan', 'วางแผนก่อน — ร่างแผนให้อนุมัติ แล้วทำตามแผนในโหมด auto'],
  ];
  for (const [value, text] of rows) {
    const row = el('button', value === $('mode').value ? 'primary' : null, `${value} — ${text}`);
    row.style.display = 'block';
    row.style.width = '100%';
    row.style.textAlign = 'left';
    row.style.marginBottom = '6px';
    row.onclick = () => { hideModal(); void setMode(value); };
    body.append(row);
  }
  $('modal-actions').textContent = '';
  const close = el('button', 'primary', 'ปิด');
  close.onclick = hideModal;
  $('modal-actions').append(close);
  $('modal').classList.remove('hidden');
}

/** Rotate the context now: the model summarises what it has done, that summary
 *  is recorded in the session, and the next run starts from it. */
async function compactNow() {
  const before = await rpc('status').then((s) => s.context).catch(() => null);
  addCommandOut(`บีบบริบท… ใช้ ${before?.used?.toLocaleString?.() ?? '?'} / ${before?.budget?.toLocaleString?.() ?? '?'} token — สรุปงานเก่าก่อน`);
  const done = await rpc('compact').catch((err) => ({ error: err.message }));
  if (done.error) { addNote(`บีบไม่ได้: ${done.error}`); return; }
  refreshMeter();
  if (done.summary) {
    const box = el('div', 'compaction-card');
    box.append(el('h4', null, 'สิ่งที่ยังจำอยู่หลังบีบ'));
    box.append(el('div', 'summary', done.summary));
    log.append(box);
    scrollDown();
  }
}

/**
 * The context meter. The upstream cannot trim its own history, so the only
 * control a user has over "it's losing the thread" is seeing the budget fill and
 * being able to rotate it. A percentage on its own would be noise next to the
 * model name; it earns its place by being the one number that explains a run
 * suddenly forgetting the beginning of the conversation.
 */
function refreshMeter() {
  rpc('status').then((st) => {
    const use = st?.context;
    const slot = $('context');
    if (!slot) return;
    if (!use || !use.budget) { slot.classList.add('hidden'); return; }
    slot.classList.remove('hidden');
    const pct = use.percent;
    slot.textContent = `context ${pct}%`;
    slot.className = `context ${pct >= 85 ? 'full' : pct >= 60 ? 'warm' : ''}`;
    slot.title = `ใช้ไป ~${use.used.toLocaleString()} จากงว ${use.budget.toLocaleString()} token (สำรอง ${use.reserved.toLocaleString()} สำหรับคำตอบ)\n`
      + `${use.entries} รายการในบทสนทนา — ครบงบแล้วมันจะสรุปเก่าไว้แล้วเริ่มบทใหม่ให้เอง (/compact บีบได้เอง)`;
    if (use.needsCompaction && !state.needsCompaction) {
      state.needsCompaction = true;
      addNote('บริบทใกล้เต็ม — run ถัดไปจะสรุปงานเก่าไว้และเริ่มบทสนทนาใหม่ให้เอง (หรือกด /compact ตอนนี้)');
    }
    if (!use.needsCompaction) state.needsCompaction = false;
  }).catch(() => {});
}

/** The paint cache's numbers in one breath: how often a frame appended to the
 *  settled layer instead of re-rendering it, and what the misses cost. */
function showPaintStats() {
  const s = paintCacheStats();
  const pct = s.hitRate == null ? '— (ยังไม่มี settled layer)' : `${(s.hitRate * 100).toFixed(1)}%`;
  addCommandOut(`paint cache — hit rate ${pct} · hit ${s.hits.toLocaleString()} · miss ${s.misses.toLocaleString()} · cold ${s.cold.toLocaleString()} (รวม ${s.paints.toLocaleString()} เฟรม)`);
  addCommandOut(`settled ต่อเพิ่มแบบ append ${s.appended.toLocaleString()} ตัวอักษร · miss ต้อง repaint ${s.repainted.toLocaleString()} ตัวอักษร`);
  addCommandOut('hit = settled layer อยู่ครบ ต่อท้ายอย่างเดียว · miss = เขียนย้อนหลัง ต้อง repaint ทั้งก้อน · cold = ยังไม่มีอะไรให้แคช');
}

async function showStatus() {
  const st = await rpc('status').catch(() => null);
  if (!st) { addNote('bridge ไม่ตอบ'); return; }
  const credits = await rpc('credits').catch(() => null);
  const lines = [
    `bridge: ${st.bridge ? 'พร้อม' : 'ไม่พร้อม'} · extension: ${st.extensions ?? 0} · โปรเจกต์: ${st.root}`,
    `โมเดล: ${st.model ?? '-'} · mode: ${st.mode} · plan: ${st.plan ? 'เปิด' : 'ปิด'} · รันอยู่: ${st.running ? 'ใช่' : 'ไม่'}`,
    `ไฟล์รอเขียน: ${st.pending?.length ?? 0}`,
  ];
  if (st.app) lines.push(`build: ${st.app}`);
  // The bridge's caches (models/quota/conversation) report what rode the cache
  // instead of the tab; a bridge too old to count them omits the block.
  if (st.cache) {
    const pair = (v) => v ? `${(v.hits ?? 0).toLocaleString()} hit / ${(v.fetches ?? 0).toLocaleString()} fetch` : '—';
    lines.push(`cache: โมเดล ${pair(st.cache.models)} · เครดิต ${pair(st.cache.quota)} · บทสนทนา ${pair(st.cache.conversation)}`);
  }
  if (credits) lines.push(`credits: ${credits.available?.toLocaleString?.() ?? credits.available} / ${credits.limit?.toLocaleString?.() ?? credits.limit}`);
  if (state.needsTab) lines.push('⚠ ยังไม่มี tab de.aipass.net ที่ล็อกอิน — กดปุ่มเปิดได้จาก welcome card');
  for (const line of lines) addCommandOut(line);
}

async function showMemory(arg) {
  if (arg && arg.trim().toLowerCase() === 'clear') {
    await rpc('memory.clear').catch(() => {});
    addCommandOut('ลืม facts ข้าม session ทั้งหมดแล้ว');
    return;
  }
  const res = await rpc('memory.list').catch(() => null);
  const facts = res?.facts ?? [];
  if (!facts.length) { addCommandOut('(ยังไม่มี facts ข้าม session — รัน /compact หรือให้ agent ทำงานสักพัก)'); return; }
  addCommandOut(`facts ข้าม session ${facts.length} รายการ:`);
  for (const f of facts) addCommandOut(`  - ${f}`);
  addCommandOut('ลืมทั้งหมด: /memory clear');
}

async function showMcp() {
  const res = await rpc('mcp.list').catch(() => null);
  if (!res) { addCommandOut('bridge ไม่ตอบ'); return; }
  const servers = res.servers ?? [];
  if (!servers.length) { addCommandOut('(ยังไม่มี MCP server — เพิ่มที่ /settings → MCP หรือ `aipass mcp add`)'); return; }
  addCommandOut(`MCP: ${servers.length} server · ${(res.tools ?? []).length} tool:`);
  for (const s of servers) {
    const state = !s.enabled ? 'ปิด' : s.connected ? `เชื่อมต่อแล้ว ${s.tools} tools` : `เชื่อมต่อไม่ได้: ${s.error ?? '?'}`;
    addCommandOut(`  ${s.name} [${s.scope}] — ${state}${s.risk === 'read' ? '' : ' · เขียน'}`);
  }
  for (const t of res.tools ?? []) addCommandOut(`      ${t.marker}  ${t.description}`);
}

async function showSymbols(arg) {
  const file = (arg || '').trim();
  if (!file) { addCommandOut('usage: /symbols <file>  (หรือใช้ marker SYMBOLS <file> ใน agent run)'); return; }
  addCommandOut(`SYMBOLS ใช้ใน agent run: SYMBOLS ${file}  (หรือ DEF <name> / REFS <name>)`);
}

async function listModels() {
  const models = await rpc('models').catch(() => null);
  const list = (models?.data ?? models?.models ?? []).filter((m) => !m.kind || m.kind === 'chat');
  if (!list.length) { addCommandOut('bridge ยังไม่ส่งรายการโมเดลมา'); return; }
  const current = $('model').value;
  addCommandOut(`โมเดลที่คุยได้ ${list.length} ตัว (ตัวที่ใช้อยู่มี >):`);
  for (const m of list) {
    addCommandOut(`${(m.id ?? m) === current ? '>' : ' '} ${m.name ?? m.id ?? m}  ${m.free_credit ? '[ฟรี]' : ''}`);
  }
}

function pickConversation() {
  void rpc('conversations.list').catch(() => null).then((res) => {
    const list = res?.conversations ?? [];
    const currentId = res?.current ?? null;
    $('modal-title').textContent = 'บทสนทนาของ bridge';
    const body = $('modal-body');
    body.textContent = '';
    body.append(el('p', 'dim', 'ความจำของโมเดลอยู่ฝั่ง bridge — สลับที่นี่ = เปลี่ยนสิ่งที่มันจำได้ ไม่กระทบไฟล์สครินช็อตในเครื่อง'));
    const pick = (id, label, primary = false) => {
      const row = el('button', primary ? 'primary' : null, label);
      row.style.display = 'block';
      row.style.width = '100%';
      row.style.textAlign = 'left';
      row.style.marginBottom = '6px';
      row.onclick = async () => { hideModal(); await rpc('conversation.pin', { id }); addCommandOut(`สลับบทสนทนาแล้ว: ${label}`); };
      body.append(row);
    };
    for (const c of list) pick(c.id, `${c.title ?? c.id}  (${c.id})`, c.id === currentId);
    if (!list.length) body.append(el('p', 'dim', 'ยังไม่มีบทสนทนาเก่า'));
    $('modal-actions').textContent = '';
    const close = el('button', 'primary', 'ปิด');
    close.onclick = hideModal;
    $('modal-actions').append(close);
    $('modal').classList.remove('hidden');
  });
}

async function freshConversation() {
  const made = await rpc('conversation.new').catch((err) => ({ error: err.message }));
  if (made.error) { addNote(`เริ่มใหม่ไม่ได้: ${made.error}`); return; }
  addCommandOut(`เริ่มบทสนทนาบน bridge ใหม่แล้ว (${made.id ?? '?'}) — ความจำเก่าถูกตัด`);
}

/** Attach a file by typed path, the way the CLI's /file and /image do. A desktop
 *  user often has the path from the file manager rather than a picker. */
async function attachPath(path, kind) {
  if (!path) { addNote(`${kind === 'image' ? '/image' : '/file'} ต้องมี path ต่อท้าย`); return; }
  const item = await rpc('attachment.stage', { path }).catch((err) => ({ error: err.message }));
  if (item.error) { addNote(`แนบไม่ได้: ${item.error}`); return; }
  state.attachments.set(item.id, item);
  renderAttachments();
  addCommandOut(`แนบแล้ว: ${item.name}`);
}

/** Paste an image straight from the clipboard. A desktop app that cannot take a
 *  screenshot with Ctrl+V is missing the obvious gesture. */
async function clipPaste() {
  try {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      const type = item.types.find((t) => t.startsWith('image/'));
      if (!type) continue;
      const blob = await item.getType(type);
      await stageFiles([new File([blob], 'clipboard.png', { type })]);
      return;
    }
    addCommandOut('คลิปบอร์ดไม่มีรูป — กด Ctrl+V ตอนมี screenshot ค้างอยู่ได้เลย');
  } catch {
    addCommandOut('อ่านคลิปบอร์ดไม่ได้ — ลากไฟล์มาวาง หรือกด Ctrl+V ในหน้านี้');
  }
}

// Which session view should be on screen: opening a session is async, and a
// slow load must never paint over a newer choice. Every entry point that
// replaces the view bumps this counter; a load that comes back to find a
// higher number paints nothing.
let viewSeq = 0;

async function startNewSession() {
  viewSeq += 1;
  log.textContent = '';
  clearTodo();
  await rpc('session.new');
  await refreshSessions();
  await refreshReadiness();
}

function resumeSession() {
  void rpc('session.list').catch(() => []).then((list) => {
    $('modal-title').textContent = 'เปิดบทสนทนาเดิม';
    const body = $('modal-body');
    body.textContent = '';
    if (!list.length) body.append(el('p', 'dim', 'ยังไม่มีบทสนทนาเก่า'));
    for (const s of list.slice(0, 40)) {
      const row = el('div', 'session-row');
      const open = el('button', null, s.title || '(ไม่มีชื่อ)');
      open.onclick = () => { hideModal(); void openSession(s.id); };
      row.append(open);
      // Rename and delete: the sidebar has no room for them, so they live here.
      // Without them a session list only grows, and old runs are unfindable.
      const rename = el('button', 'mini', 'เปลี่ยนชื่อ');
      rename.onclick = async () => {
        const next = window.prompt('ชื่อใหม่:', s.title ?? '');
        if (!next) return;
        await rpc('session.rename', { id: s.id, title: next }).catch((err) => addNote(err.message));
        await refreshSessions();
        resumeSession();
      };
      const del = el('button', 'mini', 'ลบ');
      del.onclick = async () => {
        if (!window.confirm(`ลบบทสนทนา "${s.title ?? s.id}"?`)) return;
        await rpc('session.delete', { id: s.id }).catch((err) => addNote(err.message));
        if (state.sessionId === s.id) { state.sessionId = null; log.textContent = ''; clearTodo(); }
        await refreshSessions();
        resumeSession();
      };
      row.append(rename, del);
      body.append(row);
    }
    $('modal-actions').textContent = '';
    const close = el('button', 'primary', 'ปิด');
    close.onclick = hideModal;
    $('modal-actions').append(close);
    $('modal').classList.remove('hidden');
  });
}

async function openSession(id) {
  const seq = ++viewSeq;
  const entries = await rpc('session.open', { id });
  // While this load was in flight the human may have picked another session
  // (or started a new one): the newest choice owns the screen. Without this,
  // two quick clicks interleaved their entries into one transcript.
  if (seq !== viewSeq) return;
  state.sessionId = id;
  log.textContent = '';
  clearTodo();
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (entry.type === 'task') addTask(entry.text);
    else if (entry.type === 'assistant') replayAssistant(entry.text ?? '');
    // The session's checklist is replayed like any other entry, so an old
    // conversation reopens with the plan card it was left with.
    else if (entry.type === 'todo' && Array.isArray(entry.items)) renderTodo(entry.items);
    else if (entry.type === 'tool') { addTool({ kind: entry.kind, arg: entry.arg, ok: entry.ok, head: '' }); state.assistant = null; }
    else if (entry.type === 'note') addNote(entry.text);
  }
  endTurn();
  await refreshSessions();
}

async function forkSession() {
  const forked = await rpc('session.fork').catch((err) => ({ error: err.message }));
  if (forked.error) { addNote(`แยกไม่ได้: ${forked.error}`); return; }
  await refreshSessions();
  addCommandOut(`แยกเป็นบทสนทนาใหม่แล้ว: ${forked.id}`);
}

async function togglePlan() {
  const settings = await rpc('settings.get').catch(() => null);
  const next = !(settings?.plan ?? false);
  // Plan mode in the window is one thing — draft, then wait for the yes — the
  // same pair the Shift+Tab 'plan' view writes. The two flags move together so
  // the toggle and the view cannot mean two different states.
  await rpc('settings.set', { plan: next, requirePlanApproval: next });
  state.settings = { ...(state.settings ?? {}), plan: next, requirePlanApproval: next };
  applyModeFromSettings();
  addCommandOut(`plan mode: ${next ? 'เปิด — ร่างแผนแล้วรออนุมัติก่อนทำ' : 'ปิด'}`);
}

async function openFile(file) {
  const found = await rpc('fs.read', { file }).catch((err) => ({ error: err.message }));
  $('modal-title').textContent = file;
  const body = $('modal-body');
  body.textContent = '';
  if (found.error) body.append(el('p', null, found.error));
  else body.append(el('pre', null, found.text.slice(0, 20000)));
  $('modal-actions').textContent = '';
  const close = el('button', 'primary', 'ปิด');
  close.onclick = hideModal;
  $('modal-actions').append(close);
  $('modal').classList.remove('hidden');
}

async function pickFile() {
  const entries = await rpc('fs.list', { dir: '.' }).catch(() => []);
  $('modal-title').textContent = 'ไฟล์ในโปรเจกต์';
  const body = $('modal-body');
  body.textContent = '';
  for (const e of entries.slice(0, 200).filter((x) => !x.dir)) {
    const row = el('button', null, e.name);
    row.style.display = 'block';
    row.style.width = '100%';
    row.style.textAlign = 'left';
    row.style.marginBottom = '4px';
    row.onclick = () => { hideModal(); void openFile(e.name); };
    body.append(row);
  }
  $('modal-actions').textContent = '';
  const close = el('button', 'primary', 'ปิด');
  close.onclick = hideModal;
  $('modal-actions').append(close);
  $('modal').classList.remove('hidden');
}

function showSkills() {
  void rpc('skills.list').catch(() => []).then((skills) => {
    $('modal-title').textContent = 'คู่มือ (playbook)';
    const body = $('modal-body');
    body.textContent = '';
    if (!skills.length) body.append(el('p', 'dim', 'ยังไม่มีคู่มือ — วางไฟล์ .md ใน skillsDirs'));
    for (const s of skills) {
      const row = el('div');
      row.append(el('strong', null, s.name), el('div', 'dim', s.file ?? ''));
      const view = el('button', 'mini', 'ดู');
      view.onclick = () => {
        rpc('skills.load', { name: s.name }).then((found) => {
          $('modal-title').textContent = `คู่มือ — ${s.name}`;
          const b = $('modal-body');
          b.textContent = '';
          b.append(el('pre', null, found.text));
        }).catch((err) => addNote(err.message));
      };
      row.append(view);
      row.style.marginBottom = '10px';
      body.append(row);
    }
    $('modal-actions').textContent = '';
    const close = el('button', 'primary', 'ปิด');
    close.onclick = hideModal;
    $('modal-actions').append(close);
    $('modal').classList.remove('hidden');
  });
}

async function showPendingDiff() {
  const pending = await rpc('pending').catch(() => []);
  if (!pending.length) { addNote('ไม่มีไฟล์รอเขียน'); return; }
  await showDiff(pending[0].file);
}

async function applyChecked() {
  const files = [...state.pending.entries()].filter(([, info]) => info.checked).map(([file]) => file);
  if (!files.length) { addNote('ยังไม่มีไฟล์ที่ติ๊ก'); return; }
  await rpc('apply', { files });
  await refreshPending();
}

async function discardAll() {
  await rpc('discard');
  await refreshPending();
}

function pickProject() {
  void rpc('projects.list').catch(() => []).then((projects) => {
    $('modal-title').textContent = 'เลือกโปรเจกต์';
    const body = $('modal-body');
    body.textContent = '';
    for (const p of projects) {
      const row = el('div', 'session-row');
      const open = el('button', p.current ? 'primary' : null, `${p.name ?? p.path} — ${p.path}`);
      open.onclick = () => { $('project').value = p.path; hideModal(); $('project').onchange(); };
      row.append(open);
      if (!p.current) {
        const remove = el('button', 'mini', 'เอาออก');
        remove.onclick = async () => {
          await rpc('projects.remove', { path: p.path }).catch((err) => addNote(err.message));
          await refreshProjects(await rpc('projects.list').catch(() => []));
          pickProject();
        };
        row.append(remove);
      }
      body.append(row);
    }
    $('modal-actions').textContent = '';
    const close = el('button', 'primary', 'ปิด');
    close.onclick = hideModal;
    $('modal-actions').append(close);
    $('modal').classList.remove('hidden');
  });
}

/* --------------------------------------------------------------- boot */

/**
 * Apply the theme for real. `theme` sat in the settings file doing nothing at
 * all — a setting that changes nothing is worse than no setting, because it
 * looks like a feature and behaves like a lie.
 */
function applyTheme(theme) {
  const picked = theme === 'auto'
    ? (window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
    : (theme === 'light' ? 'light' : 'dark');
  document.documentElement.dataset.theme = picked;
  const btn = $('theme-toggle');
  if (btn) {
    btn.textContent = picked === 'dark' ? '☀' : '☾';
    btn.title = picked === 'dark' ? 'สลับเป็นธีมสว่าง' : 'สลับเป็นธีมมืด';
  }
}

(async function boot() {
  // The provider switch comes first: the model list belongs to a provider,
  // so the picker has to know which one is in use before the models are read.
  await fillProviders();
  await refreshHeader();
  state.settings = await rpc('settings.get').catch(() => null);
  // A reloaded window has to look like the saved theme, not like the default.
  applyTheme(state.settings?.theme ?? 'dark');
  await refreshReadiness();
  await refreshProjects((await rpc('status').catch(() => null))?.projects);
  await refreshSessions();
  await refreshFiles();
  await refreshSkills();
  await refreshPanels();
  await refreshPending();
  applyModeFromSettings();
  applyThinkingFromSettings();
  applyTemperatureFromSettings();
  $('task').focus();
})();

// A playbook dropped into a library folder while the window was in the
// background is there the next time the window is looked at: the backend reads
// the folders on every call, so the rail only has to ask again. One small
// request, and only when the window comes back — not a poll.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') void refreshSkills().catch(() => {});
});
