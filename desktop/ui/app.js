/* aipass desktop — the window.
 *
 * All state lives on the backend (`/rpc`); this file is a view. Runs survive a
 * reload because the session log is on disk, and the live run streams in over
 * `/events` — the window only has to render what it is told.
 */
import { restoreText, setRestoreTable } from './waf-restore.js';
import { createState } from './state.js';
import { createRpcClient } from './rpc.js';
import { createTranscript } from './transcript.js';
import { createFilesPanel } from './panels/files.js';
import { createSessionsPanel } from './panels/sessions.js';
import { createContextPanel } from './panels/context.js';
import { createWorktrees } from './features/worktrees.js';
import { createGitSchedule } from './features/git-schedule.js';
import { createMedia } from './features/media.js';
import { createMiscCommands } from './features/misc-commands.js';
import { createPending } from './features/pending.js';
import { createSessionTree } from './features/session-tree.js';
import { createCheckpoints } from './features/checkpoints.js';
import { createCommands } from './commands.js';
import { createBanners } from './banners.js';
import { createSettings } from './settings.js';

const $ = (id) => document.getElementById(id);
const log = $('log');

/* ------------------------------------------------------------------- state */

// What the window remembers between two calls to the backend. The modules of
// the window all read this one object, so there is one answer to "what is the
// window showing right now" (see state.js).
const state = createState();

// The backend client: one place knows the loopback token, the project header
// every call carries, and the shape of a refusal (see rpc.js).
//
// The header names the folder the window is WORKING in, which is the project
// itself or the worktree the run is in: inside a worktree every call has to
// be about that checkout, or the diffs, the files and the apply would all
// talk about the project the worktree was made from.
const client = createRpcClient({ getRoot: () => state.runRoot ?? state.root });
const rpc = client.rpc;

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

/* ----------------------------------------------------------------- working */

/**
 * The window's heartbeat: is the app still working?
 *
 * A run takes minutes — a model that reads twenty files does not answer in a
 * second — and the window has to keep saying so the whole time. A word that
 * appears once and then sits there is not a signal; motion and a clock are.
 *
 * Three things say it, and they say it at once:
 *   - the bar over the foot of the transcript: bouncing dots and a clock,
 *   - the pulsing dot under the composer (setHint above),
 *   - the send button, which becomes the stop.
 *
 * The bar floats over the transcript rather than sitting at the end of it: a
 * marker at the bottom of a long answer cannot answer "is it still working?"
 * to a reader who has scrolled up to re-read something. It is decoration for
 * the eye — the screen reader gets the same news from the hint line, which
 * says it once instead of every second.
 */
let workingSince = 0;
let workingLabel = 'กำลังทำงาน';
let workingClock = null;

/** The bar as it stands: what the run is doing, and for how long. */
function paintWorking() {
  const text = $('working-text');
  if (text) text.textContent = workingLabel;
  const clock = $('working-time');
  if (clock) {
    const secs = workingSince ? Math.floor((Date.now() - workingSince) / 1000) : 0;
    clock.textContent = `${secs}s`;
  }
}

/**
 * Say that the app is working — or that it stopped.
 *
 * @param {boolean} on
 * @param {{label?: string}} [opts] the words, for the moment that is not
 *   plain work (a stop winding down, say).
 */
function setWorking(on, { label = 'กำลังทำงาน' } = {}) {
  workingLabel = label;
  if (on) {
    // One clock per run: a second run in the same window starts a new one.
    if (!workingClock) {
      workingSince = Date.now();
      workingClock = setInterval(paintWorking, 1000);
    }
  } else if (workingClock) {
    clearInterval(workingClock);
    workingClock = null;
    workingSince = 0;
  }
  $('working')?.classList.toggle('hidden', !on);
  // The log grows a little at the foot while the bar is up, so the bar never
  // sits on top of the last line of the answer.
  log.classList.toggle('busy', Boolean(on));
  if (on) paintWorking();
}
// The window says it is quiet from the first frame, so the state is never
// "shown because nobody said it is not".
setWorking(false);

/** Make a list row behave like a button: click, Enter and Space all run it. */
const clickable = (row, run) => {
  row.onclick = run;
  row.tabIndex = 0;
  row.setAttribute('role', 'button');
  row.addEventListener('keydown', (ev) => {
    // A key pressed on a control INSIDE the row is that control's business.
    // The row's handler used to swallow it and call preventDefault, which
    // cancelled the control's own activation: Enter on the "แนบ" button
    // opened the file instead of attaching it — the one thing the button is
    // there for.
    if (ev.target && ev.target !== row) return;
    if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); run(ev); }
  });
  return row;
};

/* The loop's common failures, said in the language the person reads, each with
   its single next action. Anything unlisted passes through untouched — an
   unknown error is better verbatim than guessed at. A copy may be a function:
   some failures have two causes with two fixes, and the window knows which
   one it is looking at. */
const ERROR_COPY = [
  // The extension is not attached. Two jobs hide behind the same
  // "extensions: 0": the extension was never loaded, or the bridge refused
  // it for want of the loopback token. The bridge says which (see /status),
  // so the reader is not sent to load an extension that is already loaded.
  [/no extension connected/i, () => (state.extensionToken === 'missing'
    ? 'extension ยังไม่ได้รับ token — เปิด popup ของ extension แล้ววาง token จาก ~/.aipass/.token'
    : 'ยังไม่มี extension เชื่อมอยู่ — เปิด Chrome แล้วคลิกไอคอน aipass bridge')],
  [/no de\.aipass\.net tab is open/i, 'ยังไม่มีแท็บ de.aipass.net ที่ล็อกอิน — เปิดแท็บนั้นแล้วลองใหม่'],
  // A refusal the extension's popup cannot fix. The extension talks to the
  // bridge, not to the window, so a token the window or the harness got
  // refused says nothing about the extension's token — and sending the
  // reader to paste one there fixed nothing. The two sides read the same
  // file; when they disagree, the app has to be started again.
  [/needs a token|unauthorized/i, 'bridge ปฏิเสธ token — ปิดแล้วเปิด aipass ใหม่ (backend กับ bridge ต้องอ่าน token เดียวกัน)'],
  [/401/i, 'หน้าต่างส่ง token ไม่ถูก — ปิดหน้าต่างนี้แล้วเปิดใหม่'],
  // Not a token problem: the request itself was refused (the wrong host, the
  // wrong port, a page that is not the one the backend serves).
  [/403/i, 'คำขอถูกปฏิเสธ (403) — ตรวจว่าหน้าต่างเปิดจาก 127.0.0.1 ของ bridge'],
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
  for (const [re, copy] of ERROR_COPY) if (re.test(s)) return typeof copy === 'function' ? copy() : copy;
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
// A step boundary drops a burst of rows — the step note, the tool rows, the
// next bubble — and each row used to ask "are we at the bottom?" the moment it
// landed. That question reads scrollHeight, which forces a layout of the whole
// transcript before it can answer: N rows, N synchronous layouts inside one
// turn, and the window hitched at every step. The burst now shares one frame —
// a row only marks the need, and the frame asks once, against the burst's
// final state. A forced scroll (nobody uses one today) stays synchronous,
// because it does not need the answer to a question.
let scrollQueued = false;
const nextScrollFrame = typeof requestAnimationFrame === 'function'
  ? requestAnimationFrame
  : (fn) => setTimeout(fn, 0);
const scrollDown = (force = false) => {
  if (force) { log.scrollTop = log.scrollHeight; return; }
  if (scrollQueued) return;
  scrollQueued = true;
  nextScrollFrame(() => {
    scrollQueued = false;
    if (atBottom()) log.scrollTop = log.scrollHeight;
  });
};

/**
 * Whether the transcript is mid-run.
 *
 * #log is a live region: a streaming answer is announced as it arrives. But
 * the answer is painted frame by frame, so "as it arrives" meant the screen
 * reader read the tail again every time a frame rewrote it — the same
 * sentence, dozens of times, while one answer was still being written.
 * `aria-busy` is the way to say "not yet": the region holds its
 * announcements until the run ends, and then the answer is read once, whole.
 *
 * @param {boolean} busy
 */
function setLogBusy(busy) {
  log.setAttribute('aria-busy', busy ? 'true' : 'false');
}
// The window says it is quiet from the first frame, so the state is never
// "not announced because nobody said".
setLogBusy(false);

/* ----------------------------------------------------------------- context */

// What the window's modules share: the DOM helpers, the state and the
// backend client. Every module of the window takes this one object, so there
// is one answer to "what is the window showing right now" — and a module that
// needs another module's work reaches it through here.
const ctx = { $, el, log, state, scrollDown, atBottom, rpc, client, clickable, friendly, stageLabel };
// The context meter's timer. The sheet starts it and the sheet's close stops
// it — one timer, shared through the context, so a "คืนค่าเดิม" (which
// closes the sheet and opens it again) cannot leave one polling forever.
ctx.meterTimer = null;
// The modules reach each other through the context. Every function below is a
// declaration, so it is hoisted and can be wired before the modules that use
// them are built.
ctx.renderAttachments = renderAttachments;
ctx.setWorking = setWorking;
ctx.setHint = setHint;
// The ONE stop: the send button's, with its stopping guard and the bar that
// comes back down when the backend answers there was nothing to stop. The
// /stop command reaches it through here — a second stop of its own used to
// leave the bar beating for a run that did not exist.
ctx.cancelRun = cancelRun;
// The banners are built after the modules they talk through (the transcript's
// notes, the commands' refresh), but /update reaches them from the commands,
// which are built before — so the context carries a wrapper that resolves
// when the first command runs.
let banners = null;
ctx.checkForUpdate = (...a) => banners.checkForUpdate(...a);
// The file panel and the rail open sessions and files through the commands.
ctx.openFile = openFile;
ctx.openSession = openSession;
ctx.pickFile = pickFile;
ctx.hideModal = hideModal;
ctx.openModal = openModal;
ctx.fillModels = fillModels;
ctx.refreshModels = refreshModels;
ctx.fillProviders = fillProviders;
ctx.refreshHeader = refreshHeader;
ctx.refreshMeta = refreshMeta;
ctx.openHelp = openHelp;
ctx.listModels = listModels;
ctx.pickConversation = pickConversation;
ctx.freshConversation = freshConversation;
ctx.attachPath = attachPath;
ctx.clipPaste = clipPaste;
ctx.startNewSession = startNewSession;
ctx.resumeSession = resumeSession;
ctx.forkSession = forkSession;
ctx.togglePlan = togglePlan;
ctx.showSkills = showSkills;
ctx.pickProject = pickProject;
ctx.paintPluginPanels = paintPluginPanels;
ctx.refreshPanels = refreshPanels;
ctx.applyTheme = applyTheme;
ctx.applySettingsToUi = applySettingsToUi;
// The surfaces the palette reaches: the undo points, the export, the tree and
// the state of the machine's own work (git, the schedule, the media models).
const transcript = createTranscript(ctx);
// The transcript's own words are what every other module writes into.
Object.assign(ctx, transcript);
const { addTask, addNote, addCommandOut, assistantText, assistantSummary, replayAssistant, thinkingText, foldThinking, endTurn, foldRun, addTool, paintCacheStats, bubbleSays, resetLog } = transcript;

/**
 * The word a tool row shows.
 *
 * The rows carry the loop's own kind names, and the label table lives with
 * the transcript. VERIFY — the loop's own kind, the marker that asks for the
 * project's check — has no entry in that table, so the row would read
 * "verify" where every other row reads a word. The label is applied here.
 */
const TOOL_KIND = { verify: 'Verify' };
const toolKind = (kind) => TOOL_KIND[kind] ?? kind;

// The rail: the session list, the playbooks and the facts the app remembers.
const sessionsPanel = createSessionsPanel(ctx);
const { refreshSessions, refreshSkills, renderSkillList, renderMemoryFacts, useSkill, installSkillDialog, sessionDay, sessionBucket } = sessionsPanel;
Object.assign(ctx, sessionsPanel);


const worktrees = createWorktrees(ctx);
const { showWorktrees, enterWorktree, leaveWorktree, removeWorktree, renderWorktreeBar, worktreeLocked } = worktrees;
ctx.showWorktrees = showWorktrees;
ctx.enterWorktree = enterWorktree;
ctx.leaveWorktree = leaveWorktree;
ctx.removeWorktree = removeWorktree;
ctx.renderWorktreeBar = renderWorktreeBar;
ctx.worktreeLocked = worktreeLocked;
Object.assign(ctx, worktrees);
const contextPanel = createContextPanel(ctx);
const { refresh: refreshContextPanel } = contextPanel;
ctx.refreshContextPanel = refreshContextPanel;
// Exposed for the test harness (ui.test.mjs drives the panel directly).
globalThis.__ctx = ctx;

// The settings sheet: one page per tab, one save for all of them.
const settingsSheet = createSettings(ctx);
const { openSettings } = settingsSheet;
ctx.openSettings = openSettings;

// The commands: the palette and the handlers behind it. They are built here,
// before the composer, because the composer wires its buttons to them.
// The commands start runs through the same send path the composer uses, so a
// /review is a run like any other. Assigned before the commands are built:
// they read this object once, and a handler cannot reach a later assignment.
ctx.sendTask = sendTask;
const gitSchedule = createGitSchedule(ctx);
const { showGitStatus, showSchedule } = gitSchedule;
ctx.showGitStatus = showGitStatus;
ctx.showSchedule = showSchedule;
Object.assign(ctx, gitSchedule);
const media = createMedia(ctx);
const { showMediaModels } = media;
ctx.showMediaModels = showMediaModels;
Object.assign(ctx, media);
const misc = createMiscCommands(ctx);
const { showMemory, showGoal, showMcp, showSymbols, showIndex } = misc;
ctx.showMemory = showMemory;
ctx.showGoal = showGoal;
ctx.showMcp = showMcp;
ctx.showSymbols = showSymbols;
ctx.showIndex = showIndex;
Object.assign(ctx, misc);
const pending = createPending(ctx);
const { showPendingDiff, applyChecked, discardAll } = pending;
ctx.showPendingDiff = showPendingDiff;
ctx.applyChecked = applyChecked;
ctx.discardAll = discardAll;
Object.assign(ctx, pending);
const sessionTree = createSessionTree(ctx);
const { exportSession, showSessionTree } = sessionTree;
ctx.exportSession = exportSession;
ctx.showSessionTree = showSessionTree;
Object.assign(ctx, sessionTree);
const checkpoints = createCheckpoints(ctx);
const { refreshCheckpoints, renderCheckpoints, restoreCheckpoint, removeCheckpoint, showCheckpoints } = checkpoints;
ctx.refreshCheckpoints = refreshCheckpoints;
ctx.renderCheckpoints = renderCheckpoints;
ctx.restoreCheckpoint = restoreCheckpoint;
ctx.removeCheckpoint = removeCheckpoint;
ctx.showCheckpoints = showCheckpoints;
Object.assign(ctx, checkpoints);
const commands = createCommands(ctx);
const {
  COMMANDS, slash, slashMatches, slashTyping, MODE_VIEWS, MODE_CYCLE, renderSlash, openSlash, closeSlash, moveSlash, pickSlash, runCommand,
  setMode, setModel, setProvider, pickProvider, pickModel, pickMode, compactNow,
  showPaintStats, showStatus, refreshMeter,
} = commands;

// The banners: the notices pinned over the conversation (no chat tab, the
// extension's token, the model catalog, the update) and the welcome card.
// They are built after the transcript and the commands — they talk through
// both — and the event wiring below hands the frames to them.
banners = createBanners(ctx);
const { syncExtensionToken, syncCatalogBanner, hasConversation, hideWelcome, refreshReadiness, checkForUpdate } = banners;

/**
 * The one place that empties the transcript.
 *
 * Four flows cleared #log by hand, and every clear stranded the pieces that
 * hold references into it: the trim marker (the next trim then counted rows
 * the window never showed) and the pinned banners (their syncs saw the state
 * still failing and a bar "already up", so the notice never came back). The
 * welcome card re-enters through its own refresh; the banners, on the next
 * poll.
 */
function resetTranscript() {
  resetLog();
  banners.reset();
  // The "no chat tab" note is about the run that asked, not the transcript:
  // a new session (or a project switch) starts with nothing to say about
  // tabs — the next run that needs one asks again.
  state.needsTab = false;
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
  // A file the human unticked stays unticked. The panel is rebuilt on every
  // diff frame and again when the run ends, and a reset to "checked" would
  // re-select exactly the files they said no to — right before they press
  // Apply. A file that was not in the list before is new, so it comes in
  // checked.
  const before = new Map(state.pending);
  state.pending.clear();
  for (const c of changes ?? []) state.pending.set(c.file, { ...c, checked: before.get(c.file)?.checked ?? true });

  // The count reads in the language of the window around it: the panel is
  // Thai, the badge was the only English left in it.
  $('pending-count').textContent = `${state.pending.size} การเปลี่ยนแปลง`;
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
  openModal();
}
ctx.showDiff = showDiff;

/**
 * Open the sheet.
 *
 * It is a dialog, so the keyboard goes in with it: the focus lands on its
 * first control, and where the focus came from is remembered so closing it
 * puts the user back where they were.
 */
function openModal() {
  const modal = $('modal');
  if (modal.classList.contains('hidden')) {
    state.modalReturnFocus = document.activeElement ?? null;
  }
  modal.classList.remove('hidden');
  const first = modal.querySelector?.('button, input, select, textarea, [tabindex]');
  first?.focus?.();
}

/**
 * Keep Tab inside the sheet.
 *
 * A dialog that lets the focus walk out into the page behind it is a dialog
 * the keyboard user has lost: they cannot tell where they are, and Escape is
 * the only way back. Tab from the last control wraps to the first, and
 * Shift+Tab from the first wraps to the last.
 */
function trapFocus(ev) {
  const modal = $('modal');
  const items = [...(modal.querySelectorAll?.('button, input, select, textarea, a[href], [tabindex]') ?? [])]
    .filter((n) => n.getClientRects?.().length !== 0 || n.offsetParent !== null);
  if (!items.length) return false;
  const first = items[0];
  const last = items.at(-1);
  const active = document.activeElement;
  if (ev.shiftKey && (active === first || !items.includes(active))) {
    last.focus?.();
    return true;
  }
  if (!ev.shiftKey && (active === last || !items.includes(active))) {
    first.focus?.();
    return true;
  }
  return false;
}

function hideModal() {
  $('modal').classList.add('hidden');
  $('modal').classList.remove('settings-sheet');
  // The model picker is gone, so its Ctrl+R is gone with it: the shortcut
  // belongs to the picker, not to the window.
  state.modelPicker = false;
  // The sheet is gone, so its panel area is gone: a repaint after this would
  // write into a box nobody can see.
  state.panelHost = null;
  // The meter's timer dies with the sheet. It used to be written into the
  // modal's dataset and never read, so every "คืนค่าเดิม" — which closes the
  // sheet and opens it again — left another one polling the backend forever.
  if (ctx.meterTimer) { clearInterval(ctx.meterTimer); ctx.meterTimer = null; }
  // And the focus goes back where it came from: a sheet that opens and takes
  // the keyboard with it, and then leaves the user at the top of the page.
  if (state.modalReturnFocus && document.activeElement !== state.modalReturnFocus) {
    state.modalReturnFocus.focus?.();
  }
  state.modalReturnFocus = null;
}

/* ------------------------------------------------------------ permissions */

function askPermission({ id, kind, arg, risk, preview, project = null }) {
  // A plugin marker is not a file and not a command: it is code the model
  // wants to run, and the person is asked about the marker and what it was
  // handed. The title says so, because "change this file?" over a marker
  // name would be a lie about what the answer does.
  //
  // The exfil tier is neither: it is data LEAVING the machine, and the
  // destination is the model's own choice — so the question names the
  // destination, because "change this file?" would be a lie about a call that
  // changes nothing here and everything there.
  const plugin = kind === 'plugin';
  const exfil = risk === 'exfil';
  $('modal-title').textContent = plugin
    ? 'run this plugin marker?'
    : exfil
      ? 'send this out?'
      : `${risk === 'shell' ? 'run this command' : 'change this file'}?`;
  const body = $('modal-body');
  body.textContent = '';
  if (plugin) {
    body.append(el('p', 'dim', 'plugin marker the model wants to run'));
    body.append(el('p', null, arg || kind));
    if (preview) body.append(el('pre', null, preview));
  } else if (exfil) {
    body.append(el('p', 'dim', 'the model wants to send this off the machine'));
    body.append(el('pre', null, arg || ''));
  } else if (risk === 'shell') {
    body.append(el('p', 'dim', 'shell command the model wants to run'), el('pre', null, arg || ''));
  } else {
    body.append(el('p', null, arg || kind));
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
  openModal();
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
  openModal();
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
const token = await client.ensureToken();
const stream = new EventSource(token ? `/events?token=${encodeURIComponent(token)}` : '/events');

// The transport, not the run. When the backend process goes away the stream
// drops and the window used to sit there with a live spinner on a run that no
// longer existed. Now it says so, and gives the run a deadline: if nothing
// arrives for a while, the run is treated as lost rather than hanging forever.
let lastEventAt = Date.now();
let quietSince = 0;
stream.addEventListener('open', () => { lastEventAt = Date.now(); quietSince = 0; void restoreFromSnapshot(); });
stream.addEventListener('message', () => { lastEventAt = Date.now(); quietSince = 0; });
// rpc.mjs sends a named ping every 15 s precisely so this watchdog reads
// "the backend died", not "the model went quiet": a long RUN or SEARCH streams
// no other frames for a while, and nothing else here refreshes the clock.
stream.addEventListener('ping', () => { lastEventAt = Date.now(); quietSince = 0; });

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
  const entries = snap.entries ?? [];
  // The welcome card is not the conversation: it is the "nothing here yet"
  // note, and it must not stand in for one. The boot paints the card before
  // the stream opens, and the card then said "there is nothing here" over a
  // run that was still going — a reload that looked like a lost app.
  const painted = hasConversation();
  // A fresh window adopts the backend's project — the same one its picker
  // shows. Only when the log is empty: on a mid-session reconnect the window
  // keeps showing the project the human chose, even if another window has
  // since moved the backend (rpc.mjs run binds runs to the window's root).
  if (!painted && snap.status?.root) state.root = snap.status.root;
  if (painted) { renderPending(snap.pending); refreshMeter(); ctx.refreshContextPanel?.(); restoreAsks(snap.asks ?? {}); return; }
  // The card comes off only when there is a conversation to put in its place:
  // an idle window keeps the note that says what this is.
  if (entries.length) hideWelcome();
  for (const entry of entries) {
    if (entry.type === 'task') addTask(entry.text);
    else if (entry.type === 'assistant') replayAssistant(entry.text ?? '');
    // A tool entry is the replay's step boundary: the reply above it is done
    // and the next assistant entry starts a new bubble, the way the live
    // stream splits them at every `step` event.
    else if (entry.type === 'todo' && Array.isArray(entry.items)) renderTodo(entry.items);
    else if (entry.type === 'tool') { addTool({ kind: toolKind(entry.kind), arg: entry.arg, ok: entry.ok, head: '', sources: entry.sources }); state.assistant = null; }
    else if (entry.type === 'note') addNote(entry.text);
  }
  endTurn();
  renderPending(snap.pending);
  refreshMeter();
  ctx.refreshContextPanel?.();
  restoreAsks(snap.asks ?? {});
  // The run may still be in flight when the window reloaded: say so, instead of
  // looking idle while the backend waits on a gate nobody can see.
  if (snap.status?.running) {
    state.running = true;
    setLogBusy(true);
    $('send').textContent = 'หยุด';
    setHint('ทำงานอยู่…', true);
    setWorking(true);
  }
  await refreshSessions();
}

stream.onerror = () => {
  if (stream.readyState === EventSource.CONNECTING) {
    addNote('backend ตัดการเชื่อม — กำลังลองเชื่อมใหม่…');
  }
};

// Every event refreshes the watchdog; a run that stops sending anything is
// reported as lost instead of blocking the composer forever.
//
// But a quiet stream is not the same as a dead run, and the difference
// matters: the window used to write the run off AND cancel it upstream after
// twenty silent seconds. A run whose backend was briefly unreachable — the
// laptop slept, the stream was reconnecting, the backend was restarting — is
// still running on the backend, and cancelling it threw away work that was
// going to finish. The window's own snapshot recovery then showed a run that
// had been stopped for no reason at all.
//
// So the watchdog asks before it cancels: the backend is asked whether it is
// alive. If it answers, the run is legitimate and the window waits. If it
// does not, the backend really is gone, and the run is written off.
//
// The probe is bounded, and only one flies at a time. A backend that accepts
// and never answers would otherwise leave a pending fetch behind on every
// tick, and the browser's per-origin connection cap would stall every other
// call the window makes — including the ones that would have noticed the
// backend coming back. An aborted probe means "cannot say": it is not a
// refusal, so it gets three strikes before the write-off, but a refusal
// (connection refused, the process gone) is answered at once.
let statusProbe = null;
let probeGen = 0;
let probeFails = 0;
let warnedSilence = false;
const HARD_SILENCE_CEILING_MS = 180_000; // 3 minutes continuous silence ceiling

setInterval(async () => {
  if (!state.running) {
    quietSince = 0;
    warnedSilence = false;
    return;
  }
  const now = Date.now();
  if (now - lastEventAt <= 20_000) {
    // The stream is back, so any strikes the last outage collected mean
    // nothing: the next one starts from zero.
    probeFails = 0;
    quietSince = 0;
    warnedSilence = false;
    return;
  }

  if (!quietSince) quietSince = lastEventAt;

  // Hard ceiling check: if the stream has been continuously silent for over 3 minutes,
  // do not spin forever even if the backend process answers.
  if (now - quietSince > HARD_SILENCE_CEILING_MS) {
    state.running = false;
    state.stopping = false;
    setLogBusy(false);
    $('send').textContent = 'ส่ง';
    setHint('');
    setWorking(false);
    rpc('cancel', { root: state.root ?? undefined }).catch(() => {});
    addNote('run นี้เงียบเกิน 3 นาทีต่อเนื่อง แม้ backend ยังเปิดอยู่ — ถือว่าหยุดแล้ว · ลองส่งใหม่ หรือเช็ค aipass doctor');
    refreshMeter();
  ctx.refreshContextPanel?.();
    quietSince = 0;
    warnedSilence = false;
    return;
  }

  // The transport is down but the backend may not be. A reconnecting
  // EventSource is CONNECTING, and the backend is still running behind it.
  const reconnecting = stream.readyState === EventSource.CONNECTING;
  // Ask the backend whether THIS run is still going, not merely whether it
  // answers: pass root so we check the exact project the window is running.
  if (statusProbe) statusProbe.abort();
  probeGen += 1;
  const gen = probeGen;
  const ctrl = new AbortController();
  statusProbe = ctrl;
  const probeTimer = setTimeout(() => ctrl.abort(), 4_000);
  const st = await rpc('status', { root: state.root ?? undefined }, statusProbe.signal)
    .catch((err) => (err?.name === 'AbortError' ? 'hung' : null))
    .finally(() => clearTimeout(probeTimer));
  if (gen !== probeGen) return; // a newer probe superseded this one
  statusProbe = null;
  const answered = st && st !== 'hung';
  if (answered) {
    probeFails = 0;
  } else if (st === 'hung' && ++probeFails < 3) {
    return; // cannot say yet — the backend may just be slow; wait for the next tick
  }
  const ended = Boolean(answered) && st.running === false && (!state.root || st.root === state.root);
  const alive = Boolean(answered) && !ended;
  if (alive) {
    // The backend answered: the run is still going, and the silence was the
    // transport, not the run. Wait. The clock is refreshed so the watchdog
    // does not fire again on every tick until the stream is back.
    lastEventAt = Date.now();
    if (!reconnecting && !warnedSilence) {
      warnedSilence = true;
      addNote('backend ยังตอบอยู่แต่สตรีมเงียบ — รอสตรีมกลับมา');
    }
    return;
  }
  // The backend does not answer or the run has ended.
  state.running = false;
  state.stopping = false;
  setLogBusy(false);
  $('send').textContent = 'ส่ง';
  setHint('');
  // The run is written off, so the window stops saying it is working: a
  // heartbeat that keeps beating for a run nobody has is a lie.
  setWorking(false);
  // The window has written the run off; the backend is told as well, so the
  // next task does not bump into a run that is still in flight there ("a run
  // is already in flight" was what a lost run looked like from the composer).
  rpc('cancel', { root: state.root ?? undefined }).catch(() => {});
  addNote(ended
    ? 'run นี้จบไปแล้วที่ backend แต่สตรีมไม่ได้ส่งสัญญาณจบมา — ถือว่าหยุดแล้ว'
    : st === 'hung'
      ? 'backend ไม่ตอบสนองสักที (สถานะค้าง) — ถือว่า run หยุดแล้ว · ลองส่งใหม่ หรือเช็ค aipass doctor'
      : 'run นี้เงียบไป 20 วินาที และ backend ไม่ตอบ — ถือว่าหยุดแล้ว · ลองส่งใหม่ หรือเช็ค aipass doctor');
  refreshMeter();
  ctx.refreshContextPanel?.();
  quietSince = 0;
  warnedSilence = false;
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
ctx.sameProject = sameProject;

/**
 * Is this project one of ours?
 *
 * Two, when the window is inside a worktree: the project the worktree was
 * made from, and the worktree itself. The run's frames carry the folder they
 * happened in, and a frame from the worktree is as much ours as one from the
 * project — otherwise the run in the worktree would be invisible.
 */
const isOwnProject = (project) => !project || !state.root
  || sameProject(project, state.root)
  || (state.runRoot && sameProject(project, state.runRoot));

/** null when the event belongs to this window's project; otherwise the
 *  project's folder name, for the answer surfaces that show anyway. */
function foreignProject(project) {
  if (!project || isOwnProject(project)) return null;
  return String(project).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || String(project);
}

function onRun(name, fn) {
  stream.addEventListener(name, (e) => {
    const data = JSON.parse(e.data);
    if (data.project && state.root && !isOwnProject(data.project)) return;
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
  'credit-limited': 'โควตาหมด — หยุด',
  'tools-limited': 'เครื่องมือครบโควตา — หยุด',
  'time-limited': 'หมดเวลา — หยุด',
  steps: 'ครบจำนวนรอบ',
  'done-unverified': 'เสร็จแต่ยังไม่ผ่านการตรวจ',
  'goal-rounds': 'ครบรอบเป้าหมาย — หยุด',
};

onRun('task_start', (data) => {
  // The run has started: the transcript is busy, so the live region keeps
  // its announcements until the run ends instead of reading the answer's
  // half-written tail over and over.
  setLogBusy(true);
  // And the window says it is working, from the first frame of the run: a
  // run takes minutes, and the reader's question is "is it still doing
  // something?".
  setWorking(true);
  addTask(data.task);
  hideWelcome();
  // Everything appended from here until `finished` is this run's working
  // trail; foldRun() picks it up by this mark so an earlier turn is untouched.
  state.runCursor = log.children.length;
  refreshMeter();
  ctx.refreshContextPanel?.();
  lastEventAt = Date.now();
  quietSince = 0;
  warnedSilence = false;
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
/* The frames the window missed -----------------------------------------------
 *
 * The backend's fan-out keeps a bounded queue per subscriber and drops the
 * OLDEST frames when a window stops reading — a backgrounded window, a
 * suspended laptop. It counts what it dropped and says so in a frame of its
 * own. A window that silently loses frames is a window that shows a run it
 * did not fully see, so the loss is a line in the conversation.
 */
onAny('fell_behind', (data) => {
  const dropped = Number(data?.dropped ?? 0);
  if (!dropped) return;
  addNote(`ตกหล่น ${dropped} ข้อความจาก backend (หน้าต่างไม่ได้อ่านเร็วพอ) — บทสนทนาที่เหลืออาจไม่ครบ`);
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
// (mid-run inject) The message the person queued mid-run went out with a
// step's paste. The window that queued it already said so when the RPC
// answered; this says it was delivered — including in a second window.
onRun('injected', (data) => {
  addNote(`ส่งข้อความของคุณถึงโมเดลแล้ว (กลางรัน${Number(data?.n) > 1 ? ` ${data.n} ข้อความ` : ''})`);
});

// The run ended before a step could carry the queued message: it comes back
// to the composer — a message the person wrote is their intent, not litter.
// A composer the person has typed into since is left alone.
onRun('inject_orphaned', (data) => {
  const texts = Array.isArray(data?.texts) ? data.texts : [];
  if (!texts.length) return;
  if (!$('task').value.trim()) {
    $('task').value = texts.join('\n\n');
    saveDraft();
  }
  addNote('รันจบก่อนข้อความจะถูกส่ง — ข้อความกลับมาอยู่ในช่องพิมพ์ กดส่งได้เลย');
});

onRun('thinking', (data) => {
  const { text } = data;
  // The headline is the first line of the reply, and the bubble is already
  // showing that reply: a line under the step that says it again is the
  // duplication the UI prose policy rules out (a DONE is said once, and so is
  // this). The row is only worth a line when the bubble does not carry the
  // same words.
  if (bubbleSays(state.lastBubble, text)) return;
  log.append(el('div', 'thinking', '⎿ ' + text));
  scrollDown();
});
onRun('tool', (data) => addTool({ ...data, kind: toolKind(data.kind) }));
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
// The goal's three moments: a DONE refused because the project still has work,
// the model declaring the objective met, and the model asking for a person.
onRun('goal_round', (data) => addNote(`เป้าหมายยังไม่เสร็จ — เริ่มรอบ ${data.round}/${data.max}`));
onRun('goal_done', (data) => addNote(`ปิดเป้าหมายแล้ว${data.done ? ` — ${data.done}` : ''}`));
onRun('goal_blocked', (data) => addNote(`เป้าหมายติด (${data.reason || 'ไม่ระบุเหตุผล'}) — บอกโมเดลได้ที่ /goal resume`));
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
  // The stop is not the end of the work — the tool in flight ends on its own
  // — so the bar keeps beating, with the words that match the moment.
  setWorking(true, { label: 'กำลังหยุด…' });
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
  setLogBusy(false);
  $('send').textContent = 'ส่ง';
  setHint('');
  // The run is over, so the heartbeat stops. A bar that keeps beating after
  // the answer has landed is the one thing that would teach the reader not
  // to believe it.
  setWorking(false);
  refreshMeter();
  ctx.refreshContextPanel?.();
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
  // Repaint every panel the plugins draw, in place — a finished run is
  // exactly when the scratchpad's history changed. The panels are in the rail
  // as well as in the sheet, and both are repainted.
  await repaintPanels();
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
  const provider = $('provider').value || state.provider || '';
  const file = s?.file ? s.file.split(/[\\/]/).slice(-2).join('/') : '';
  const meta = $('meta');
  meta.textContent = '';
  meta.append(el('span', 'meta-title', s?.title ?? 'new session'));
  if (model) meta.append(el('span', 'meta-chip', (provider && provider !== 'aipass' ? provider + ' \u00b7 ' : '') + model));
  if (s?.id) meta.append(el('span', 'meta-chip', '#' + s.id.slice(0, 6)));
  if (file) meta.append(el('span', 'meta-file', file));
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
// The modules that fill the composer for the reader (a playbook's "ใช้", the
// /skill command) save the draft through this — an assignment fires no input
// event, so without it the next boot comes back without what was set.
ctx.saveDraft = saveDraft;

/**
 * The options a run carries, when the machine has them.
 *
 * The two switches the option sheet owns are read from the settings the
 * window already holds. A key the machine does not know is left out rather
 * than sent as false: a backend that does not have the option keeps its own
 * default, and one that has it gets the person's choice.
 */
function runOptions() {
  const out = {};
  const s = state.settings ?? {};
  if (s.allowGitWrite !== undefined) out.allowGitWrite = Boolean(s.allowGitWrite);
  if (s.allowVerify !== undefined) out.allowVerify = Boolean(s.allowVerify);
  return out;
}

async function sendTask(seed = null, opts = {}) {
  const text = (seed ?? $('task').value).trim();
  if (!text) return;

  // A line that starts with "/" is a command, not a message — that is how the
  // whole app stays reachable from the keyboard. Commands run while a turn is in
  // flight too: /stop and /status are the two you want exactly then.
  if (text.startsWith('/')) {
    const [name, ...rest] = text.slice(1).split(/\s+/);
    const arg = rest.join(' ').trim();
    const item = COMMANDS.find((c) => c.cmd === name.toLowerCase());
    // Assignment fires no input event, so the storage still holds the text
    // that was just sent — synced here, or the next boot comes back
    // pre-filled with work that is already done.
    $('task').value = '';
    saveDraft();
    closeSlash();
    hideWelcome();
    if (item) { void runCommand(item, arg); return; }
    addNote(`ไม่มีคำสั่ง /${name} — พิมพ์ / ลงไปดูรายการ`);
    return;
  }

  // A message typed while the run is working does not interrupt it: it goes
  // into the mid-run queue (run.inject) and rides the next step's paste. The
  // composer stays usable for exactly this — and /commands above still run
  // while a turn is in flight.
  if (state.running) { void injectMidrun(text); return; }
  $('task').value = '';
  saveDraft();
  closeSlash();
  state.running = true;
  state.stopping = false;
  state.lastCheck = null; // a fresh run's verdict is not the old run's
  $('send').textContent = 'หยุด';
  setHint('ทำงานอยู่…', true);
  // The bar comes up the moment the task is sent, not when the backend
  // answers: the wait between the keypress and the first frame is exactly
  // where the reader wonders whether anything happened at all.
  setWorking(true);
  try {
    await rpc('run', {
      task: text,
      // Where the run works. Normally the project the window is showing; a
      // worktree is a SECOND checkout of the same repository, and the run has
      // to land in it — the harness's root is that folder, so every tool path
      // is confined to it and the overlay writes there. The backend reads the
      // project before the root (rpc.mjs's targetFor), so the worktree is
      // named as the project: the header alone would not do, because the
      // window's project is still the project the worktree was made from.
      project: state.runRoot ?? undefined,
      root: state.runRoot ?? state.root ?? undefined,
      // The select's 'plan' view is not a permission mode: the approved plan is
      // the consent, so the run works under 'auto'. Everything else goes as-is.
      mode: $('mode').value === 'plan' ? 'auto' : ($('mode').value || undefined),
      model: $('model').value || undefined,
      attachments: [...state.attachments.keys()],
      title: text.slice(0, 60),
      // A review is a run property, not a saved mode: the window states it on
      // this one call and the backend's next run is ordinary again.
      ...(opts.review ? { review: true, reviewBase: opts.reviewBase } : {}),
      // The two switches the option sheet owns: the model may write to git,
      // and it may ask for the project's check. They ride the run the way
      // every other option does — and only when the machine has them, so a
      // backend that does not know the option keeps its own default.
      ...runOptions(),
    });
  } catch (err) {
    addNote(`error: ${friendly(err.message)}`);
    state.running = false;
    state.stopping = false;
    setLogBusy(false);
    $('send').textContent = 'ส่ง';
    setHint('');
    // The run never started, so there is nothing to be working on.
    setWorking(false);
  }
}

/**
 * A message typed while a run is working: queued on the backend (run.inject)
 * and delivered with the next step's paste. The backend answers `refused`
 * when the run ended in the meantime — the text goes back in the composer
 * rather than vanishing, because a message the person wrote is their intent.
 */
async function injectMidrun(text) {
  $('task').value = '';
  saveDraft();
  closeSlash();
  try {
    const res = await rpc('run.inject', {
      text,
      project: state.runRoot ?? undefined,
      root: state.runRoot ?? state.root ?? undefined,
    });
    if (res?.refused) {
      $('task').value = text;
      saveDraft();
      addNote('รันจบไปแล้ว — ข้อความกลับมาอยู่ในช่องพิมพ์ กดส่งได้เลย');
      return;
    }
    addNote(`เข้าคิวแล้ว — จะส่งให้โมเดลพร้อมผลสเต็ปถัดไป (คิว ${res?.queued ?? 1})`);
  } catch (err) {
    $('task').value = text;
    saveDraft();
    addNote(`error: ${friendly(err.message)}`);
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
  // The bar keeps beating, and says what it is waiting for: the work in
  // flight ends on its own, and until it does the window is still busy.
  setWorking(true, { label: 'กำลังหยุด…' });
  rpc('cancel', { root: state.root ?? undefined })
    .then((res) => {
      if (res && res.ok === false) {
        // Nothing was running: the button goes back to sending, and the line
        // says what the stop found. The bar comes down with it — a window that
        // keeps beating says it is working, and nothing is.
        state.stopping = false;
        $('send').textContent = 'ส่ง';
        setHint('');
        setWorking(false);
        addNote(`หยุดไม่ได้ — ไม่มีรันที่กำลังทำอยู่${res.reason ? ` (${res.reason})` : ''}`);
      }
    })
    .catch((err) => {
      state.stopping = false;
      $('send').textContent = 'ส่ง';
      setHint('');
      setWorking(false);
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
  const modalOpen = !$('modal').classList.contains('hidden');
  if (ev.key === 'Escape' && modalOpen) hideModal();
  else if (ev.key === 'Escape' && state.running) cancelRun();
  // Ctrl+K goes to the search: once the history is longer than a scroll, the
  // search is the only way back to a conversation you remember.
  else if ((ev.ctrlKey || ev.metaKey) && String(ev.key).toLowerCase() === 'k') {
    ev.preventDefault();
    $('session-filter')?.focus();
  }
  // Ctrl+P is the file filter: the muscle memory for "show me the files" is
  // the same in every editor, and a shortcut nobody knows about is a shortcut
  // nobody has.
  else if ((ev.ctrlKey || ev.metaKey) && String(ev.key).toLowerCase() === 'p') {
    ev.preventDefault();
    $('file-filter')?.focus();
  }
  // Ctrl+Shift+F is the grep every editor has: the same field, but it looks
  // INSIDE the files.
  else if ((ev.ctrlKey || ev.metaKey) && ev.shiftKey && String(ev.key).toLowerCase() === 'f') {
    ev.preventDefault();
    setSearchMode(filesState.mode === 'content' ? 'name' : 'content');
    $('file-filter')?.focus();
  }
  // Ctrl+R inside the model picker refreshes the list where it stands, and
  // the picker stays open on the new list. The global Ctrl+R stays a page
  // reload on purpose: a wedged page needs its escape hatch, and the reason
  // the reader was reaching for it — a list that never arrives — is what the
  // refresh button and the stamp on the status call are for.
  else if ((ev.ctrlKey || ev.metaKey) && String(ev.key).toLowerCase() === 'r' && state.modelPicker) {
    ev.preventDefault();
    void refreshModels().then(() => pickModel());
  }
  // The welcome card promises "?" as the way into the guide, and the keys
  // keep that promise: it opens from anywhere the window itself has the
  // focus. A form field keeps its question marks, and an open sheet keeps
  // its own keys.
  else if (ev.key === '?' && !modalOpen && !ev.ctrlKey && !ev.metaKey && !ev.altKey
    && !['INPUT', 'TEXTAREA', 'SELECT'].includes(ev.target?.tagName ?? '')) {
    ev.preventDefault();
    openHelp();
  }
  // The sheet is a dialog: Tab stays inside it, so a keyboard user cannot
  // wander out into the page behind the scrim and lose the sheet.
  else if (ev.key === 'Tab' && modalOpen) {
    if (trapFocus(ev)) ev.preventDefault();
  }
  // Shift+Tab cycles ask → auto → plan from the composer or anywhere the
  // window itself has the focus — the one shortcut that has to work without
  // someone typing first. Form controls (the select, the settings sheet) keep
  // their own Tab behaviour, and an open sheet keeps its own too.
  else if (ev.key === 'Tab' && ev.shiftKey && !modalOpen && ev.target !== $('task')
    && !['INPUT', 'TEXTAREA', 'SELECT'].includes(ev.target?.tagName ?? '')) {
    ev.preventDefault();
    cycleMode();
  }
});

$('slash-btn').onclick = () => {
  // A visible, clickable route into the palette for anyone who does not think
  // to type "/" first. It behaves exactly like typing it — and typing "/"
  // only ever starts an empty composer: text already typed is the person's
  // answer in progress, not something a button may replace.
  if (!$('task').value.trim()) {
    $('task').value = '/';
    slash.index = 0;
    renderSlash('/');
    slash.open = true;
  }
  $('task').focus();
};

$('apply').onclick = applyChecked;
$('discard').onclick = discardAll;
$('new-session').onclick = startNewSession;

// The filter re-renders the list it filters, so there is one source of truth
// for what is on screen.
// The filter is a text field: a round trip and a whole list rebuilt for every
// keystroke is a lot of work for a person typing one word. The wait is short
// enough to feel immediate and long enough to be one call.
let filterTimer = null;
$('session-filter').oninput = () => {
  clearTimeout(filterTimer);
  filterTimer = setTimeout(() => void refreshSessions(), 180);
};

// The foot of the rail: the two doors to the rest of the app, spelled out.
// A 15px gear in the header is easy to miss, and this is where people look.
$('side-settings').onclick = () => openSettings();
$('side-help').onclick = openHelp;

// The composer's controls follow the saved settings: the mode select and the
// effort chip. They are ONE apply path, not two — a settings change lands in
// both at once, and neither can be left showing what the machine no longer
// believes.
//
// Mode is the one setting that decides everything else it might do — may it
// write, may it run, must it plan first — so the select beside the composer
// and the Shift+Tab cycle share this path. 'plan' is a view, not a permission
// mode: it means plan first, and the approval of that plan is the consent the
// run then works under, which is why its runs use 'auto'.
// The views themselves live with the commands (commands.js).
//
// The effort chip follows the saved thinking level, the way #mode follows the
// saved mode. The settings sheet no longer carries it: how hard the model
// thinks is a per-message decision, so it lives where the message is written.
// Temperature went the other way (the sheet's คุยกับโมเดล page owns it now):
// unlike effort it is not a per-message judgement call but a rarely-touched
// model parameter, and a knob nobody turns has no business sitting in the row
// read on every message.
function applySettingsToUi(settings = state.settings ?? {}) {
  const mode = settings.requirePlanApproval ? 'plan' : (settings.mode ?? 'ask');
  $('mode').value = MODE_VIEWS[mode] ? mode : 'ask';

  const level = settings.thinking ?? 'low';
  $('thinking').value = ['off', 'low', 'medium', 'high', 'max'].includes(level) ? level : 'low';
}

$('thinking').onchange = () => {
  const level = $('thinking').value;
  rpc('settings.set', { thinking: level })
    .then(() => { state.settings = { ...(state.settings ?? {}), thinking: level }; })
    .catch((err) => addNote(`เปลี่ยนระดับ effort ไม่ได้: ${err.message}`));
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
  .then(() => { state.settings = { ...(state.settings ?? {}), defaultModel: $('model').value }; refreshMeter(); ctx.refreshContextPanel?.(); })
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
    'คำสั่งทั้งหมดอยู่ท้ายหน้านี้ — รวมที่เพิ่งมาใหม่ ไม่มีคำสั่งที่หน้าต่างมีแต่หน้านี้ไม่บอก',
    'ใส่ argument ได้คราว ๆ เช่น /mode auto หรือ /open README.md',
  ]);
  section('บอกมันทำอะไร', [
    'พิมพ์แล้วกด Enter — ถามคำถาม หรือสั่งแก้ไฟล์ก็ได้',
    'Shift+Enter = ขึ้นบรรทัดใหม่ · Esc = ยกเลิกรันที่กำลังทำ',
    'โหมดการทำงานอยู่ข้างช่องพิมพ์ — ask · auto · yolo · plan (Shift+Tab วนโหมดได้)',
    'มันอ่านไฟล์เอง (NEED/SEARCH) เมื่อจำเป็น — ไม่ต้องบอกว่าอ่านแค่ไหน',
  ]);
  section('มันแก้ไฟล์ยังไง', [
    'ไม่มีอะไรเขียนลงดิสก์จนกว่าคุณจะกด "เขียนเลย"',
    'แต่ละไฟล์ติ๊กแยกกันได้ · กดดู diff ก่อนได้',
    'โหมด ask = ถามก่อนเขียนทุกไฟล์ · auto = เขียนเลยไม่ถาม · yolo = เขียน + รันคำสั่ง shell · plan = ร่างแผนให้อนุมัติก่อนลงมือ',
  ]);
  section('แนบไฟล์', [
    'ลากรูป/เอกสาร/วิดีโอทับหน้านี้ หรือกด "แนบไฟล์"',
    'ไฟล์แนบไปกับข้อความถัดไป แล้วหายไปเองหลังส่ง',
  ]);
  section('เปลี่ยนโปรเจกต์', [
    'เลือกที่ "โปรเจกต์" ด้านบน หรือกด + โฟลเดอร์',
    'แต่ละโปรเจกต์มีบทสนทนา คู่มือ และไฟล์แยกกัน',
  ]);
  section('ปรับแต่งโมเดล', [
    'โมเดล ผู้ให้บริการ และ effort เลือกได้ข้างช่องพิมพ์',
    'temperature (ความสุ่มของคำตอบ — 0 นิ่ง … 2 หลากหลาย) อยู่ที่ ตั้งค่า → คุยกับโมเดล',
    'ค่าเริ่มต้น (default) คือปล่อยให้แต่ละโมเดลใช้ค่าของตัวเอง',
  ]);
  section('ถ้าไม่ได้', [
    'แถบด้านบนบอกว่าขาดอะไร: bridge / extension / tab',
    'ไม่มีแท็บ → กด "เปิดให้" แล้วล็อกอินในหน้า de.aipass.net',
    'ตั้งค่าได้หมด: โมเดล temperature ขนาด compaction ปลั๊กอิน MCP และความจำข้ามเซสชัน',
  ]);

  // Every command the window has, taken from the palette itself.
  //
  // The list used to be written out by hand here, and a hand-written list goes
  // stale the moment a command is added: the window grew four commands the
  // help never mentioned. A command that exists but is not in the help is a
  // command nobody finds, so the help reads the palette — one list, and it
  // cannot lie about what the window can do.
  section('คำสั่งทั้งหมด', COMMANDS.map((c) => `/${c.cmd} — ${c.desc}`));

  const actions = $('modal-actions');
  actions.textContent = '';
  const close = el('button', 'primary', 'ปิด');
  close.onclick = hideModal;
  actions.append(close);
  openModal();
}
$('help-btn').onclick = openHelp;

async function refreshPending() {
  const pending = await rpc('pending').catch(() => []);
  renderPending(pending);
}
ctx.refreshPending = refreshPending;

const filesPanel = createFilesPanel(ctx);
const { filesState, renderFiles, refreshFiles, searchFiles, openFolder, setSearchMode } = filesPanel;
Object.assign(ctx, filesPanel);

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
      // The backend holds the bytes and does not hand them back, so there is
      // no thumbnail to show — an <img> with an empty data URL is a broken
      // image, not a placeholder. The name and the size say what it is.
      li.append(el('span', null, '🖼'));
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
// The quick-attach in the rail was a <label for="file-picker">: a label is not
// a widget, so the keyboard could not reach it and the control behind it is
// hidden. It is a button now, and it opens the same picker.
$('new-chat-quick').onclick = () => $('file-picker').click();
$('file-picker').onchange = () => { stageFiles([...$('file-picker').files]); $('file-picker').value = ''; };

// The refresh beside the model: the site's catalog, now. This is the move the
// reader had to make by reloading the whole window, and it costs one fetch
// instead of the window.
$('model-refresh').onclick = () => { void refreshModels(); };

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
    select.append(opt);
  }
  if (!projects?.length) return;
  // The window keeps the project it is on. A fresh window adopts the one the
  // backend names; a window that already has one keeps it, because the
  // backend's "current" is whichever window spoke last — and this window's
  // file panel, its sessions and its pending changes are the ones its user is
  // looking at. Two windows on two projects must not trade places.
  const inList = state.root ? projects.find((p) => sameProject(p.path, state.root)) : null;
  const mine = inList ?? projects.find((p) => p.current) ?? projects[0];
  if (mine?.path) {
    if (!inList) state.root = mine.path;
    select.value = mine.path;
  }
  if (previous !== select.value) await refreshSessions();
}

$('project').onchange = async () => {
  const result = await rpc('projects.switch', { path: $('project').value }).catch((err) => ({ error: err.message }));
  if (result.error) { addNote(`สลับโปรเจกต์ไม่ได้: ${friendly(result.error)}`); return; }
  state.root = result.root ?? $('project').value;
  // The worktree belongs to the project it was made from, so switching
  // project leaves it too — otherwise the run would land in a checkout of
  // the project the window just left.
  if (state.runRoot) { state.runRoot = null; renderWorktreeBar(); }
  resetTranscript();
  state.sessionId = null;
  renderPending([]);
  // Another project's tree is another project's tree: the filter that was
  // narrowing the old one means nothing here.
  filesState.query = '';
  filesState.results = null;
  filesState.searching = false;
  $('file-filter').value = '';
  addNote(`project: ${$('project').value}`);
  await Promise.all([refreshSessions(), refreshFiles('.'), refreshSkills(), refreshPanels(), refreshCheckpoints()]);
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

/* -------------------------------------------------------------- the rail */

/**
 * The ☰ that folds the rail away.
 *
 * The CSS still does the folding: the checkbox is the state holder and
 * `#nav-toggle:checked ~ main` moves the rail out of the way. The two ☰
 * controls are real buttons now — a <label> is not a widget, so the keyboard
 * could not reach the control and a screen reader had no name to announce.
 * All the JS does is move the state and say whether the rail is open.
 */
const RAIL_TOGGLES = ['side-toggle', 'side-toggle-side'];
function syncRailState() {
  const open = !$('nav-toggle')?.checked;
  for (const id of RAIL_TOGGLES) $(id)?.setAttribute('aria-expanded', String(open));
}
for (const id of RAIL_TOGGLES) {
  $(id)?.addEventListener?.('click', () => {
    const box = $('nav-toggle');
    if (!box) return;
    box.checked = !box.checked;
    syncRailState();
  });
}
syncRailState();

/* The Session panel toggle. Same pattern as the rail: checkbox holds state,
   CSS does the folding, JS mirrors into aria-expanded + persists the choice. */
function isNarrow() { return window.innerWidth <= 1100; }
function syncPanelState() {
  const open = !$('panel-toggle')?.checked;
  $('panel-btn')?.setAttribute('aria-expanded', String(open));
  // hide the toggle affordance entirely when the panel is forced off-screen
  // by the media query (no overlay possible without a backdrop).
  if ($('panel-btn')) $('panel-btn').hidden = false;
}
$('panel-btn')?.addEventListener?.('click', () => {
  const box = $('panel-toggle');
  if (!box) return;
  box.checked = !box.checked;
  try { localStorage.setItem('aipass.panel.open', String(!box.checked)); } catch {}
  if (isNarrow()) try { sessionStorage.setItem('aipass.panel.narrow', box.checked ? 'closed' : 'open'); } catch {}
  syncPanelState();
});
// restore persisted preference (default open on wide screens)
try {
  if (!isNarrow() && localStorage.getItem('aipass.panel.open') === 'false') {
    const box = $('panel-toggle');
    if (box) box.checked = true;
  }
  if (isNarrow()) {
    const box = $('panel-toggle');
    if (box && sessionStorage.getItem('aipass.panel.narrow') !== 'open') box.checked = true;
  }
} catch {}
syncPanelState();
if (typeof window.addEventListener === 'function') window.addEventListener('resize', () => {
  const box = $('panel-toggle');
  if (!box) return;
  if (isNarrow() && sessionStorage.getItem('aipass.panel.narrow') !== 'open') box.checked = true;
  syncPanelState();
});

// Close the panel overlay when clicking outside it on narrow screens.
document.addEventListener('click', (e) => {
  if (!isNarrow()) return;
  const box = $('panel-toggle');
  if (!box || box.checked) return; // already closed
  const panel = $('context-panel');
  if (panel && !panel.contains(e.target) && e.target !== $('panel-btn')) {
    box.checked = true;
    try { sessionStorage.setItem('aipass.panel.narrow', 'closed'); } catch {}
    syncPanelState();
  }
});

// Sidebar resize handle.
(function () {
  const handle = $('side-resize');
  if (!handle) return;
  // restore persisted width
  try {
    if (window.innerWidth > 960) {
      const w = parseInt(localStorage.getItem('aipass.side.w') || '', 10);
      if (w >= 200 && w <= 500) document.documentElement.style.setProperty('--side-w', w + 'px');
    }
  } catch {}
  let dragging = false;
  handle.addEventListener('mousedown', (e) => {
    dragging = true;
    handle.classList.add('dragging');
    e.preventDefault();
  });
  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    if (window.innerWidth <= 960) return;
    const rect = document.documentElement.getBoundingClientRect();
    let w = e.clientX - rect.left;
    w = Math.max(200, Math.min(500, w));
    document.documentElement.style.setProperty('--side-w', w + 'px');
  });
  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('dragging');
    const v = getComputedStyle(document.documentElement).getPropertyValue('--side-w').trim();
    try { localStorage.setItem('aipass.side.w', v); } catch {}
  });
})();

// Keyboard shortcuts for the two drawers.
document.addEventListener('keydown', (e) => {
  if (!e.ctrlKey && !e.metaKey) return;
  if (e.key === 'b' && !e.shiftKey) {
    e.preventDefault();
    $('side-toggle')?.dispatchEvent?.(new Event('click'));
  } else if (e.key === 'B' && e.shiftKey) {
    e.preventDefault();
    $('panel-btn')?.dispatchEvent?.(new Event('click'));
  }
});

/* ---------------------------------------------------------- plugin panels */

async function refreshPanels() {
  const details = await rpc('plugins.list').catch(() => null);
  // The transcript renderer hides plugin marker calls from the bubble, so it
  // has to know the current marker table; takesBody decides whether a block's
  // inner lines are eaten with the header. An older backend without toolDefs
  // still works: plain markers, single-line.
  state.pluginTools = (details?.toolDefs ?? (details?.tools ?? []).map((marker) => ({ marker })))
    .filter((t) => t?.marker);
  // The panels a plugin draws are a widget, not a configuration row: they are
  // the plugin's own work surface, so they live in the rail — and in the
  // settings sheet, next to the plugin that draws them.
  state.pluginPanels = details?.panels ?? [];
  await paintPluginPanels();
}

/**
 * Draw the panels the installed plugins paint.
 *
 * Two places, and both of them are the point: the rail (so a window at work
 * shows them) and the settings sheet (so the plugin that draws them is next
 * to them). The sheet used to be the only place, and the sheet releases its
 * panel area when it closes — so a plugin's scratchpad was visible exactly
 * while a settings page happened to be open, and nowhere else.
 */
async function paintPluginPanels() {
  const panels = state.pluginPanels ?? [];
  await paintPanelsInto($('plugin-panels'), panels, 'rail-panel-');
  if (state.panelHost) await paintPanelsInto(state.panelHost, panels, 'panel-');
  const section = $('panels-section');
  // The class, not the attribute: the section's own rule says `display: flex`,
  // and a rule beats the browser's default for `hidden`.
  if (section) section.classList.toggle('hidden', panels.length === 0);
}

/** Fill one holder with the panels. A plugin with nothing to say says so. */
async function paintPanelsInto(holder, panels, idPrefix) {
  if (!holder) return;
  holder.textContent = '';
  if (!panels.length) {
    holder.append(el('p', 'settings-empty', 'ยังไม่มีแผงที่ปลั๊กอินวาดไว้ — ปลั๊กอินที่วาดแผงจะมาอยู่ตรงนี้'));
    return;
  }
  for (const panel of panels) {
    const box = el('div', 'plugin-panel');
    box.id = `${idPrefix}${panel.id}`;
    box.dataset.panel = panel.id;
    box.dataset.title = panel.title ?? panel.id;
    holder.append(box);
    await paintPanel(box, panel.id);
  }
}

/**
 * Repaint every panel that is on screen, wherever it is.
 *
 * A finished run is exactly when a plugin's panel changed, so every holder
 * that has a panel in it is repainted in place.
 */
async function repaintPanels() {
  for (const holder of [$('plugin-panels'), state.panelHost].filter(Boolean)) {
    for (const box of holder.children) if (box.dataset.panel) await paintPanel(box, box.dataset.panel);
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

/* ------------------------------------------------------- the work surfaces */


/**
 * The media models of the live catalog.
 *
 * A media model is a chat model that makes pictures, clips or songs, and the
 * bridge is what knows which: a window that cannot reach a tab sees nothing
 * here, and says so.
 */

/* ------------------------------------------------------------ header state */
let lastScheduleTick = 0;
async function runDueSchedule({ force = false } = {}) {
  const now = Date.now();
  if (!force && now - lastScheduleTick < 60_000) return null;
  lastScheduleTick = now;
  const out = await ctx.rpc('schedule.runDue').catch(() => null);
  if (!out) return null;
  if (out.count) ctx.addNote(`ตั้งเวลา: เริ่ม ${out.count} งานที่ครบเวลาแล้ว`);
  return out;
}

async function refreshHeader() {
  const st = await rpc('status').catch(() => null);
  const dot = (ok, label) => {
    const s = el('span');
    s.append(el('span', 'dot ' + (ok ? 'ok' : 'no')));
    s.append(document.createTextNode(label));
    return s;
  };
  if (!st) {
    // A failed poll used to leave the last dots untouched, so a window whose
    // backend had died kept saying "bridge ● extension ×1" — the exact lie a
    // person reads as "connected" while nothing can be sent. Say what is true.
    $('status').textContent = '';
    $('status').append(dot(false, 'backend ไม่ตอบ'));
    return;
  }
  // The schedule rides on this poll: the window is what runs the work that is
  // due, and the header already talks to the backend every ten seconds.
  void runDueSchedule();
  $('status').textContent = '';
  // The bridge and the extension are the AiPASS path. Another provider is
  // reached by the backend itself, so a red "bridge" would name a problem
  // that does not exist — the provider's own line says who is answering.
  if (st.provider && st.provider !== 'aipass') {
    $('status').append(dot(true, `provider ${st.provider}`));
  } else {
    $('status').append(dot(st.bridge, 'bridge'), dot(st.extensions > 0, `extension ×${st.extensions}`));
  }
  // The bridge's own answer about the extension's token: the extension can
  // be loaded and still refused, and only the bridge knows which. It is
  // ambient state, so it is read here with everything else.
  state.extensionToken = st.extensionToken === 'missing' ? 'missing' : 'ok';
  syncExtensionToken();
  refreshMeter(st);
  if (st.model) {
    // Live while a run spends credits; idle windows ride the bridge's cache
    // instead of poking the de.aipass.net tab every ten seconds.
    const credits = await rpc('credits', { force: Boolean(state.running) }).catch(() => null);
    if (credits) $('status').append(el('span', null, `credits ${credits.available?.toLocaleString?.() ?? credits.available} / ${credits.limit?.toLocaleString?.() ?? credits.limit}`));
  }
  if (st.model && !$('model').options.length) await fillModels(st.model);
  // The catalog changes on the bridge's own schedule — the site retires a
  // model, the tab reattaches, the bridge heals its own stub — and the status
  // call above already says when it last changed. Comparing that stamp is how
  // the list heals itself: no extra request, and the tab is not poked for
  // nothing. The read rides the cache on purpose — the bridge has just
  // fetched, so asking it to fetch again would be the same catalog twice.
  if (st.catalog?.at && st.catalog.at !== modelState.at) await loadModels();
}

/* ------------------------------------------------------- the model catalog */

/**
 * What the model dropdown is looking at.
 *
 * The catalog is not fetched by the app: the Chrome extension fetches it, in
 * the page, from the site. A window that cannot reach a tab is therefore
 * looking at a two-id stub — and until now nothing said so, so the only way
 * to get the real list was to reload the window. These fields are what the
 * backend reports about the catalog, and they are what the window shows.
 */
const modelState = {
  source: 'unknown',   // 'live' | 'fallback' | 'spec' | 'none' | 'unknown'
  at: 0,               // the stamp of the list on screen
  error: null,         // why the last refresh failed
  loading: false,
  promise: null,       // the refresh in flight, so a poll and a click join one
};
// The catalog's banner reads this through the context: the banners are built
// before the catalog's state exists, and only reach for it when a refresh ends.
ctx.modelState = modelState;

/** The chip's marker: what the list is, in a word. */
const CATALOG_LABEL = {
  live: '',
  fallback: 'สำรอง',
  spec: 'จากสเปก',
  none: 'ไม่มีรายการ',
  unknown: '',
};

/** The chip's title: why the list is what it is. */
const CATALOG_TITLE = {
  live: 'โมเดล — รายการสดจากเว็บ',
  fallback: 'โมเดล — นี่คือรายการสำรองสองรายการ ยังไม่ได้ต่อกับหน้า de.aipass.net (หรือ extension ไม่ได้ต่ออยู่) กดรีเฟรชเพื่อลองอีกครั้ง',
  spec: 'โมเดล — รายการนี้มาจากสเปกของผู้ให้บริการ ไม่ใช่รายการสดจากเว็บ',
  none: 'โมเดล — ผู้ให้บริการไม่ได้ตอบว่ามีโมเดลอะไรบ้าง',
  unknown: 'โมเดล',
};

/**
 * Fill the model dropdown with the models that can actually hold a
 * conversation.
 *
 * `currentModel` is the model in use, and it wins over whatever the dropdown
 * had selected: a provider switch must not leave the previous provider's
 * model selectable.
 */
async function fillModels(currentModel) {
  return loadModels({ prefer: 'model', currentModel });
}

/**
 * Refresh the list from the site, now.
 *
 * This is the move the reader used to make by reloading the whole window.
 */
async function refreshModels(opts = {}) {
  return loadModels({ force: true, ...opts });
}

/**
 * Fetch the catalog and rebuild the dropdown.
 *
 * Three rules this holds to:
 *  - One at a time. A refresh already in flight is joined, not duplicated:
 *    the header asks every ten seconds and a click asks too.
 *  - A failed refresh never takes the list away. An empty dropdown after a
 *    failure is worse than a stale one — the reader still sees a model they
 *    can pick.
 *  - The rebuild keeps the reader's CHOICE, not just the model in use. A poll
 *    that lands mid-choice must not yank the dropdown out from under them.
 *
 * `prefer` says whose choice survives the rebuild: 'choice' keeps what the
 * reader had picked (a refresh), 'model' keeps the model in use (a provider
 * switch).
 */
async function loadModels({ force = false, prefer = 'choice', currentModel = null } = {}) {
  // One at a time: a load already in flight is joined, not duplicated — the
  // header asks every ten seconds and a click asks too.
  if (modelState.promise) {
    // ...but a caller that needs a DIFFERENT list is not swallowed by it. A
    // provider switch wants the new provider's models, and the load in flight
    // is fetching the old provider's; a forced refresh wants a fetch, not the
    // cache the load in flight is riding. Joining either would drop the
    // request on the floor: the dropdown would keep offering the previous
    // provider's model, and the refresh button would do nothing at all.
    // That one is queued — it runs the moment the load in flight ends, and
    // the caller waits for it.
    if (prefer === 'choice' && !force) return modelState.promise;
    return modelState.promise.then(() => loadModels({ force, prefer, currentModel }));
  }
  modelState.loading = true;
  paintModelChip();
  const mine = (async () => {
    try {
      const res = await rpc('models', { force });
      const all = res?.data ?? res?.models ?? [];
      modelState.source = res?.source ?? 'unknown';
      modelState.at = res?.at ?? modelState.at;
      modelState.error = res?.error ?? null;
      renderModelOptions(all, currentModel, prefer);
      return res;
    } catch (err) {
      // The list on screen stays: a failed refresh must not cost the reader
      // the models they already had.
      modelState.error = err.message;
      return null;
    } finally {
      modelState.loading = false;
      paintModelChip();
      syncCatalogBanner();
    }
  })();
  modelState.promise = mine;
  try {
    return await mine;
  } finally {
    // The handle goes when THIS load is done — a queued one has its own.
    if (modelState.promise === mine) modelState.promise = null;
  }
}

/**
 * Rebuild the dropdown from a list.
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
function renderModelOptions(all, currentModel = null, prefer = 'choice') {
  const select = $('model');
  // What the reader had picked, before the options are torn down.
  const chosen = prefer === 'model'
    ? (currentModel || null)
    : (select.value || currentModel || null);
  const chat = all.filter((m) => !m.kind || m.kind === 'chat');
  const list = chat.some((m) => (m.id ?? m) === chosen)
    ? chat
    : [...chat, ...all.filter((m) => (m.id ?? m) === chosen)];
  // `aipass/`-prefixed ids compare bare, the same way the loop's check does.
  const bare = (id) => String(id ?? '').replace(/^aipass\//, '');
  const dropped = Boolean(chosen) && modelState.source === 'live'
    && !all.some((m) => bare(m.id ?? m) === bare(chosen));
  if (chosen && !list.some((m) => (m.id ?? m) === chosen)) list.push({ id: chosen });
  // The list is rebuilt when the provider changes, so the old options go
  // first: a model of the previous provider must not stay selectable.
  select.textContent = '';
  for (const m of list) {
    const opt = document.createElement('option');
    const id = m.id ?? m;
    opt.value = id;
    opt.textContent = m.name && m.name !== id ? m.name : id;
    opt.title = `${id}${m.description ? ` — ${m.description}` : ''}`;
    if (dropped && id === chosen) {
      opt.textContent += ' — ไม่มีในรายการของเว็บแล้ว';
      opt.title = `${id} — the site no longer offers this model; a run would stop and ask for a current pick`;
    }
    select.append(opt);
  }
  if (list.length) select.value = chosen ?? select.options[0].value;
}

/**
 * Say what the list on screen IS.
 *
 * A two-item dropdown with no explanation reads as "the app is broken"; the
 * same dropdown labelled "สำรอง" reads as "the site has not answered yet".
 */
function paintModelChip() {
  const note = $('model-note');
  const btn = $('model-refresh');
  const select = $('model');
  const label = CATALOG_LABEL[modelState.source] ?? '';
  if (note) {
    note.textContent = label;
    note.hidden = !label;
    note.title = CATALOG_TITLE[modelState.source] ?? '';
  }
  if (btn) {
    btn.disabled = modelState.loading;
    btn.classList.toggle('busy', modelState.loading);
    btn.title = modelState.loading
      ? 'กำลังดึงรายชื่อโมเดล…'
      : 'ดึงรายชื่อโมเดลใหม่จากเว็บ';
  }
  if (select) {
    select.title = modelState.error
      ? `โมเดล — ดึงรายการไม่สำเร็จ: ${modelState.error}`
      : (CATALOG_TITLE[modelState.source] ?? 'โมเดล');
  }
}

setInterval(refreshHeader, 10_000);

// The update check, on the clock the comment above it promises: once at
// startup and then every six hours. The backend serves the cached answer in
// between, so the ask is cheap — and a window left open for days still hears
// about a new content release, instead of waiting for a reload to find out.
setInterval(() => { void checkForUpdate().catch(() => {}); }, 6 * 60 * 60 * 1000);

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
    openModal();
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
  resetTranscript();
  clearTodo();
  const made = await rpc('session.new').catch((err) => ({ error: err.message }));
  if (made.error) { addNote(`เริ่มบทสนทนาใหม่ไม่ได้: ${friendly(made.error)}`); return; }
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
      // Export: the transcript as a file the person can keep or send to
      // somebody else. The shape and the path are the person's to choose.
      const out = el('button', 'mini', 'ส่งออก');
      out.onclick = () => { hideModal(); exportSession(s.id, s.title); };
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
        if (state.sessionId === s.id) { state.sessionId = null; resetTranscript(); clearTodo(); }
        await refreshSessions();
        resumeSession();
      };
      row.append(rename, out, del);
      body.append(row);
    }
    $('modal-actions').textContent = '';
    const close = el('button', 'primary', 'ปิด');
    close.onclick = hideModal;
    $('modal-actions').append(close);
    openModal();
  });
}

async function openSession(id) {
  const seq = ++viewSeq;
  const opened = await rpc('session.open', { id }).catch((err) => ({ error: err.message }));
  if (opened.error) { addNote(`เปิดบทสนทนาไม่ได้: ${friendly(opened.error)}`); return; }
  const entries = opened;
  // While this load was in flight the human may have picked another session
  // (or started a new one): the newest choice owns the screen. Without this,
  // two quick clicks interleaved their entries into one transcript.
  if (seq !== viewSeq) return;
  state.sessionId = id;
  resetTranscript();
  clearTodo();
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (entry.type === 'task') addTask(entry.text);
    else if (entry.type === 'assistant') replayAssistant(entry.text ?? '');
    // The session's checklist is replayed like any other entry, so an old
    // conversation reopens with the plan card it was left with.
    else if (entry.type === 'todo' && Array.isArray(entry.items)) renderTodo(entry.items);
    else if (entry.type === 'tool') { addTool({ kind: toolKind(entry.kind), arg: entry.arg, ok: entry.ok, head: '', sources: entry.sources }); state.assistant = null; }
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
  const saved = await rpc('settings.set', { plan: next, requirePlanApproval: next }).catch((err) => ({ error: err.message }));
  if (saved.error) { addNote(`เปลี่ยน plan mode ไม่ได้: ${friendly(saved.error)}`); return; }
  state.settings = { ...(state.settings ?? {}), plan: next, requirePlanApproval: next };
  applySettingsToUi(state.settings);
  addCommandOut(`plan mode: ${next ? 'เปิด — ร่างแผนแล้วรออนุมัติก่อนทำ' : 'ปิด'}`);
}

/**
 * Open a file. A line number puts the reader on the line the search found —
 * the answer to "where is this?" is not the file, it is the line.
 */
async function openFile(file, line = null) {
  const found = await rpc('fs.read', { file }).catch((err) => ({ error: err.message }));
  $('modal-title').textContent = file;
  const body = $('modal-body');
  body.textContent = '';
  let hit = null;
  if (found.error) body.append(el('p', null, found.error));
  else {
    const pre = el('pre');
    const lines = String(found.text ?? '').slice(0, 20000).split('\n');
    lines.forEach((text, i) => {
      const on = Boolean(line) && i === Number(line) - 1;
      const span = el('span', on ? 'hit-line' : null, text);
      if (on) hit = span;
      pre.append(span);
      pre.append(document.createTextNode('\n'));
    });
    body.append(pre);
  }
  $('modal-actions').textContent = '';
  const close = el('button', 'primary', 'ปิด');
  close.onclick = hideModal;
  $('modal-actions').append(close);
  openModal();
  // The line the reader came for is in view, not somewhere below the fold.
  hit?.scrollIntoView?.({ block: 'center' });
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
  openModal();
}

function showSkills() {
  void rpc('skills.list').catch(() => []).then((skills) => {
    $('modal-title').textContent = 'คู่มือ (playbook)';
    const body = $('modal-body');
    body.textContent = '';
    // The one list the settings sheet draws: rows that open in place, a ใช้
    // that fills the composer, and — for the libraries a person may write — a
    // remove. The modal is a second door into the same list, not a third
    // rendering of it.
    const list = el('ul', 'list dim skill-list');
    renderSkillList(list, skills);
    body.append(list);
    $('modal-actions').textContent = '';
    const install = el('button', 'primary', 'ติดตั้งคู่มือ…');
    install.onclick = () => installSkillDialog({
      onInstalled: async () => renderSkillList(list, await refreshSkills()),
    });
    const close = el('button', null, 'ปิด');
    close.onclick = hideModal;
    $('modal-actions').append(install, close);
    openModal();
  });
}

function pickProject() {
  void ctx.rpc('projects.list').catch(() => []).then((projects) => {
    ctx.$('modal-title').textContent = 'เลือกโปรเจกต์';
    const body = ctx.$('modal-body');
    body.textContent = '';
    for (const p of projects) {
      const row = ctx.el('div', 'session-row');
      const open = ctx.el('button', p.current ? 'primary' : null, `${p.name ?? p.path} — ${p.path}`);
      open.onclick = () => { ctx.$('project').value = p.path; ctx.hideModal(); ctx.$('project').onchange(); };
      row.append(open);
      if (!p.current) {
        const remove = ctx.el('button', 'mini', 'เอาออก');
        remove.onclick = async () => {
          await ctx.rpc('projects.remove', { path: p.path }).catch((err) => ctx.addNote(err.message));
          await ctx.refreshProjects(await ctx.rpc('projects.list').catch(() => []));
          pickProject();
        };
        row.append(remove);
      }
      body.append(row);
    }
    ctx.$('modal-actions').textContent = '';
    const close = ctx.el('button', 'primary', 'ปิด');
    close.onclick = ctx.hideModal;
    ctx.$('modal-actions').append(close);
    ctx.openModal();
  });
}

/* --------------------------------------------------------------- boot */

/**
 * Apply the theme for real. `theme` sat in the settings file doing nothing at
 * all — a setting that changes nothing is worse than no setting, because it
 * looks like a feature and behaves like a lie.
 */

/** What the system asks for right now. `auto` means exactly this. */
const systemTheme = () => (window.matchMedia?.('(prefers-color-scheme: light)')?.matches ? 'light' : 'dark');

/**
 * Follow the system while it is the one in charge.
 *
 * A machine that goes to bed at sunset changes its mind while the window is
 * open. "auto" has to follow it, or the theme is stale until the window is
 * reloaded — which is the one thing "auto" is supposed to save you from.
 */
let systemThemeQuery = null;
const watchSystemTheme = () => {
  const mq = window.matchMedia?.('(prefers-color-scheme: light)');
  if (!mq) return;
  if (systemThemeQuery === mq) return;
  systemThemeQuery?.removeEventListener?.('change', onSystemTheme);
  systemThemeQuery = mq;
  mq.addEventListener?.('change', onSystemTheme);
};
const onSystemTheme = () => {
  if ((state.settings?.theme ?? 'dark') === 'auto') applyTheme('auto');
};

function applyTheme(theme) {
  const picked = theme === 'auto' ? systemTheme() : (theme === 'light' ? 'light' : 'dark');
  if (theme === 'auto') watchSystemTheme();
  document.documentElement.dataset.theme = picked;
  const btn = $('theme-toggle');
  if (btn) {
    // The button says which theme is ON, not only what pressing it will do.
    // A tooltip is no name a screen reader can rely on, so the state it
    // carried was never announced — the reader had no way to know what the
    // window looked like. The icons stay in the markup: the CSS picks the one
    // that matches, and writing a glyph over them threw them away.
    btn.setAttribute('aria-label', picked === 'dark' ? 'ธีม: มืด' : 'ธีม: สว่าง');
    btn.title = picked === 'dark' ? 'สลับเป็นธีมสว่าง' : 'สลับเป็นธีมมืด';
  }
}

(async function boot() {
  // The wire spellings first: the model writes a URL as HTTPS-URL…, and the
  // reader must see the address itself. The table comes from the backend
  // that owns it, so the window never keeps a copy of the rules.
  const table = await rpc('waf.table').catch(() => null);
  if (Array.isArray(table?.pairs)) setRestoreTable(table.pairs);
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
  await refreshCheckpoints();
  applySettingsToUi(state.settings);
  // The update check runs after the window is up and never before it: it is
  // one GET of a static file, and the app must not wait for it.
  void checkForUpdate().catch(() => {});
  $('task').focus();
})();

// A playbook dropped into a library folder while the window was in the
// background is there the next time the window is looked at: the backend reads
// the folders on every call, so the window only has to ask again. One small
// request, and only when the window comes back — not a poll.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') void refreshSkills().catch(() => {});
  // The tree of the project is the other thing that goes stale while the
  // window is in the background — a file lands, and the list still shows the
  // folder as it was.
  if (document.visibilityState === 'visible') void refreshFiles().catch(() => {});
});
