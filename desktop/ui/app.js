/* aipass desktop — the window.
 *
 * All state lives on the backend (`/rpc`); this file is a view. Runs survive a
 * reload because the session log is on disk, and the live run streams in over
 * `/events` — the window only has to render what it is told.
 */
import { renderMarkdown } from './md.js';

const $ = (id) => document.getElementById(id);
const log = $('log');

/* ------------------------------------------------------------------- rpc */

async function rpc(method, params = {}) {
  const res = await fetch('/rpc', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method, params }),
  });
  const body = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  if (!body.ok) throw new Error(body.error ?? 'rpc failed');
  return body.result;
}

/* ---------------------------------------------------------------- helpers */

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
const scrollDown = () => { log.scrollTop = log.scrollHeight; };

const state = {
  running: false,
  assistant: null,      // { el, text }
  thinking: null,       // { el, text }
  pending: new Map(),   // file → {checked, added, removed, deleted, isNew}
  attachments: new Map(), // id → {name, bytes, mime}
  sessionId: null,
  settings: null,
  plugins: null,
};

/* -------------------------------------------------------------- transcript */

function addTask(text) {
  const msg = el('div', 'msg task');
  msg.append(el('div', 'who', 'คุณ'));
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

// Non-blocking toast for success/failure. Kept small and dependency-free;
// nothing on the page blocks while one is up.
function toast(text, kind = 'info', ms = 2600) {
  const host = $('toasts');
  if (!host) return;
  const node = el('div', `toast ${kind}`, text);
  host.append(node);
  requestAnimationFrame(() => node.classList.add('show'));
  setTimeout(() => {
    node.classList.remove('show');
    setTimeout(() => node.remove(), 180);
  }, ms);
}

function ensureAssistant() {
  if (state.assistant) return state.assistant;
  const msg = el('div', 'msg assistant');
  msg.append(el('div', 'who', 'aipass'));
  const body = el('div', 'body');
  msg.append(body);
  log.append(msg);
  state.assistant = { el: body, text: '' };
  return state.assistant;
}

function assistantText(delta) {
  const a = ensureAssistant();
  a.text += delta;
  a.el.innerHTML = renderMarkdown(a.text);
  scrollDown();
}

function thinkingText(delta) {
  if (!state.thinking) {
    const box = el('details', 'think');
    const summary = el('summary', null, 'reasoning…');
    const pre = el('pre');
    box.append(summary, pre);
    log.append(box);
    state.thinking = { el: pre, text: '' };
  }
  state.thinking.text += delta;
  state.thinking.el.textContent = state.thinking.text;
  scrollDown();
}

function endTurn() {
  state.assistant = null;
  state.thinking = null;
}

function addTool({ kind, arg, ok, head, lines = [] }) {
  const row = el('div', ok ? 'tool' : 'tool bad');
  const mark = el('span', 'mark', ok ? '✓ ' : '✗ ');
  row.append(mark, el('span', null, `${kind} ${arg ?? ''} `), el('span', 'dim', head ?? ''));
  for (const line of lines) log.append(el('div', 'note', '      ' + line));
  log.append(row);
  scrollDown();
}

/* ------------------------------------------------------------------ panel */

function renderTodo(items) {
  let panel = $('todo-panel');
  if (!panel) {
    panel = el('div', 'panel');
    panel.id = 'todo-panel';
    panel.append(el('h4', null, 'แผน & สิ่งที่ต้องทำ'));
    const ul = el('ul');
    panel.append(ul);
    $('pending').before(panel);
  }
  const ul = panel.querySelector('ul');
  ul.textContent = '';
  for (const item of items) {
    const li = el('li', item.done ? 'done' : '');
    li.append(el('span', 'box', item.done ? '☑' : '☐'), el('span', null, item.text));
    ul.append(li);
  }
}

function renderPending(changes) {
  const wrap = $('pending');
  const list = $('pending-list');
  state.pending.clear();
  for (const c of changes ?? []) state.pending.set(c.file, { ...c, checked: true });

  const totals = [...state.pending.values()].reduce((a, c) => ({ add: a.add + (c.added ?? 0), del: a.del + (c.removed ?? 0) }), { add: 0, del: 0 });
  $('pending-count').textContent = `${state.pending.size} change${state.pending.size === 1 ? '' : 's'} · +${totals.add} / -${totals.del}`;
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
  $('modal-title').textContent = 'การแก้ไขที่รออนุมัติ';
  const actions = $('modal-actions');
  actions.textContent = '';
  const close = el('button', 'primary', 'ปิด');
  close.onclick = hideModal;
  actions.append(close);
  $('modal').classList.remove('hidden');
}

function hideModal() {
  $('modal').classList.add('hidden');
  $('modal-body').closest('.sheet').classList.remove('settings-sheet');
}
// every modal now has a visual close affordance, not just the Escape key.
try { $('modal-close').onclick = hideModal; } catch { /* loaded outside the window (tests) is fine */ }

/* ------------------------------------------------------------ permissions */

function askPermission({ id, kind, arg, risk }) {
  $('modal-title').textContent = `${risk === 'shell' ? 'รันคำสั่งนี้ไหม' : 'ให้แก้ไฟล์นี้ไหม'}?`;
  const body = $('modal-body');
  body.textContent = '';
  body.append(el('p', null, arg || kind));
  if (risk === 'shell') {
    const pre = el('pre', null, arg || '');
    body.textContent = '';
    body.append(el('p', 'dim', 'คำสั่ง shell ที่โมเดลขอรัน'), pre);
  }

  const actions = $('modal-actions');
  actions.textContent = '';
  const answer = (decision) => { hideModal(); rpc('permission.answer', { id, decision }); };
  const deny = el('button', null, 'ปฏิเสธ');
  deny.onclick = () => answer('deny');
  const allow = el('button', 'primary', 'อนุญาต');
  allow.onclick = () => answer('allow');
  const always = el('button', null, 'อนุญาตตลอด');
  always.onclick = () => answer('always');
  actions.append(deny, always, allow);
  $('modal').classList.remove('hidden');
}

function askPlan() {
  $('modal-title').textContent = 'เริ่มแผนนี้ไหม?';
  const body = $('modal-body');
  body.textContent = '';
  body.append(el('p', null, 'โมเดลเขียนแผนไว้แล้ว — อนุมัติแล้วงานเริ่มทันที, ไม่อนุมัติแล้วรันหยุดก่อนแตะไฟล์ใด ๆ'));
  const actions = $('modal-actions');
  actions.textContent = '';
  const no = el('button', null, 'ไม่เอา');
  no.onclick = () => { hideModal(); rpc('plan.answer', { ok: false }); };
  const yes = el('button', 'primary', 'อนุมัติ');
  yes.onclick = () => { hideModal(); rpc('plan.answer', { ok: true }); };
  actions.append(no, yes);
  $('modal').classList.remove('hidden');
}

/* ------------------------------------------------------------------ events */

const stream = new EventSource('/events');

stream.addEventListener('task_start', (e) => { addTask(JSON.parse(e.data).task); });
stream.addEventListener('assistant_delta', (e) => assistantText(JSON.parse(e.data).text));
stream.addEventListener('reasoning_delta', (e) => thinkingText(JSON.parse(e.data).text));
stream.addEventListener('step', (e) => {
  const { step, maxSteps, elapsed } = JSON.parse(e.data);
  addNote(`step ${step}/${maxSteps} · ${elapsed}s`);
});
stream.addEventListener('thinking', (e) => {
  const { text } = JSON.parse(e.data);
  log.append(el('div', 'thinking', '⎿ ' + text));
  scrollDown();
});
stream.addEventListener('tool', (e) => addTool(JSON.parse(e.data)));
stream.addEventListener('note', (e) => addNote(JSON.parse(e.data).text));
stream.addEventListener('firewall_note', (e) => addNote(JSON.parse(e.data).text));
stream.addEventListener('nudge', (e) => addNote(`no marker in that reply — nudging (${JSON.parse(e.data).n}/2)`));
stream.addEventListener('give_up', () => addNote('no marker after three replies — stopping.'));
stream.addEventListener('ignore_done', () => addNote('(ignoring DONE — it came before the results it asked for)'));
stream.addEventListener('step_limit', () => addNote('reached the step limit'));
stream.addEventListener('error', (e) => addNote(`error: ${JSON.parse(e.data).message}`));
stream.addEventListener('todo', (e) => renderTodo(JSON.parse(e.data).items));
stream.addEventListener('diff_update', (e) => renderPending(JSON.parse(e.data).changes));
stream.addEventListener('permission_request', (e) => askPermission(JSON.parse(e.data)));
stream.addEventListener('plan_request', () => askPlan());
stream.addEventListener('compacted', (e) => addNote(`context full — earlier work summarised and a fresh conversation started`));
stream.addEventListener('helper_start', (e) => addNote(`helper started: ${JSON.parse(e.data).task}`));
stream.addEventListener('helper_end', (e) => {
  const { summary, prepared } = JSON.parse(e.data);
  addNote(`helper finished${prepared?.length ? `, prepared ${prepared.length} file(s) for approval` : ''}: ${summary}`);
});
stream.addEventListener('done_line', (e) => {
  const { text, extra } = JSON.parse(e.data);
  assistantText('\n\n' + (text || 'done'));
  if (extra) assistantText(extra);
  endTurn();
});
stream.addEventListener('plugin_call', (e) => {
  const { marker, arg } = JSON.parse(e.data);
  addNote(`plugin ${marker} ${arg}`.trim());
});
stream.addEventListener('finished', async (e) => {
  const { summary, stopReason, spent, credits } = JSON.parse(e.data);
  endTurn();
  state.running = false;
  $('send').textContent = '➤';
  $('hint').textContent = '';
  if (credits) addNote(`credits เหลือ ${credits.available?.toLocaleString?.() ?? credits.available} จาก ${credits.limit?.toLocaleString?.() ?? credits.limit}${spent > 0 ? ` · รันนี้ใช้ไป ${spent.toLocaleString()}` : ''}`);
  if (stopReason !== 'done') addNote(`หยุดก่อนเสร็จ: ${stopReason}`);
  // Attachments belong to the message they were sent with.
  for (const id of state.attachments.keys()) rpc('attachment.remove', { id }).catch(() => {});
  state.attachments.clear();
  renderAttachments();
  for (const box of document.querySelectorAll('.plugin-panel[data-panel]')) await paintPanel(box, box.dataset.panel);
  await refreshPending();
});
stream.addEventListener('applied', (e) => {
  const { written, deleted, files } = JSON.parse(e.data);
  addNote(`applied  ${written ?? 0} written, ${deleted ?? 0} deleted${files?.length ? ` — ${files.join(', ')}` : ''}`);
  renderPending([]);
});
stream.addEventListener('discarded', () => { renderPending([]); addNote('discarded.'); });
stream.addEventListener('session', (e) => {
  const s = JSON.parse(e.data);
  state.sessionId = s.id;
  $('meta').textContent = `${s.title}  ·  ${s.file}`;
});

/* -------------------------------------------------------------- composer */

// One task can be started, cancelled, and re-started from three places: the
// form, the button and the Enter key. They all land here so the rules live in
// one spot — Enter sends, Shift+Enter is a newline, and while a run is live the
// same controls stop it instead.
async function sendTask() {
  if (state.running) return;
  const text = $('task').value.trim();
  if (!text) return;
  $('task').value = '';
  state.running = true;
  $('send').textContent = '■';
  $('hint').textContent = 'กำลังทำงาน…';
  try {
    await rpc('run', {
      task: text,
      mode: $('mode').value,
      model: $('model').value || undefined,
      attachments: [...state.attachments.keys()],
      title: text.slice(0, 60),
    });
  } catch (err) {
    addNote(`error: ${err.message}`);
    state.running = false;
    $('send').textContent = '➤';
    $('hint').textContent = '';
  }
}

function cancelRun() {
  rpc('cancel').catch(() => {});
}

$('composer').onsubmit = (ev) => {
  ev.preventDefault();
  sendTask();
};

$('task').addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && !ev.shiftKey) {
    ev.preventDefault();
    sendTask();
  }
});

// The button stops a live run and sends an idle one.
$('send').onclick = (ev) => {
  ev.preventDefault();
  if (state.running) cancelRun();
  else sendTask();
};

document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && !$('modal').classList.contains('hidden')) hideModal();
  else if (ev.key === 'Escape' && state.running) rpc('cancel');
});

$('apply').onclick = async () => {
  const files = [...state.pending.entries()].filter(([, info]) => info.checked).map(([file]) => file);
  await rpc('apply', { files });
  await refreshPending();
};
$('discard').onclick = async () => {
  await rpc('discard');
  await refreshPending();
};
$('mode').onchange = () => rpc('settings.set', { mode: $('mode').value }).catch(() => {});
$('model').onchange = () => rpc('config.set', { model: $('model').value }).catch(() => {});
$('new-session').onclick = async () => {
  log.textContent = '';
  await rpc('session.new');
  await refreshSessions();
};

async function refreshPending() {
  const pending = await rpc('pending').catch(() => []);
  renderPending(pending);
}

async function refreshSessions() {
  const list = await rpc('session.list').catch(() => []);
  const count = $('card-sessions');
  if (count) count.textContent = String(list.length);
  const ul = $('sessions');
  ul.textContent = '';
  for (const s of list.slice(0, 40)) {
    const li = el('li', s.id === state.sessionId ? 'active' : '');
    li.append(el('span', null, s.title || '(untitled)'));
    li.onclick = async () => {
      const entries = await rpc('session.open', { id: s.id });
      state.sessionId = s.id;
      log.textContent = '';
      for (const entry of entries) {
        if (entry.type === 'task') addTask(entry.text);
        else if (entry.type === 'assistant') assistantText(entry.text ?? '');
        else if (entry.type === 'tool') addTool({ kind: entry.kind, arg: entry.arg, ok: entry.ok, head: '' });
        else if (entry.type === 'note') addNote(entry.text);
      }
      endTurn();
      await refreshSessions();
    };
    ul.append(li);
  }
}

async function refreshSkills() {
  const skills = await rpc('skills.list').catch(() => []);
  const ul = $('skills');
  ul.textContent = '';
  for (const s of skills) {
    const li = el('li');
    li.append(el('span', null, s.name));
    li.title = s.file ?? '';
    li.onclick = async () => {
      const found = await rpc('skills.load', { name: s.name }).catch((err) => ({ error: err.message }));
      $('modal-title').textContent = `playbook — ${s.name}`;
      const body = $('modal-body');
      body.textContent = '';
      if (found.error) body.append(el('p', null, found.error));
      else body.append(el('pre', null, found.text));
      $('modal-actions').textContent = '';
      const close = el('button', 'primary', 'ปิด');
      close.onclick = hideModal;
      $('modal-actions').append(close);
      $('modal').classList.remove('hidden');
    };
    ul.append(li);
  }
}

async function refreshFiles() {
  const entries = await rpc('fs.list', { dir: '.' }).catch(() => []);
  const ul = $('files');
  ul.textContent = '';
  for (const e of entries.slice(0, 200)) {
    const li = el('li', 'dim');
    li.textContent = e.dir ? e.name + '/' : e.name;
    li.onclick = async () => {
      if (e.dir) return;
      const found = await rpc('fs.read', { file: e.name }).catch((err) => ({ error: err.message }));
      $('modal-title').textContent = e.name;
      const body = $('modal-body');
      body.textContent = '';
      if (found.error) body.append(el('p', null, found.error));
      else body.append(el('pre', null, found.text.slice(0, 20000)));
      $('modal-actions').textContent = '';
      const close = el('button', 'primary', 'ปิด');
      close.onclick = hideModal;
      $('modal-actions').append(close);
      $('modal').classList.remove('hidden');
    };
    ul.append(li);
  }
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
      img.style.background = '#e6edf7';
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

/* --------------------------------------------------------------- projects */

async function refreshProjects(projects) {
  const select = $('project');
  const previous = select.value;
  select.textContent = '';
  for (const p of projects ?? []) {
    const opt = document.createElement('option');
    opt.value = p.path;
    opt.textContent = p.name ?? p.path;
    if (p.current) opt.selected = true;
    select.append(opt);
  }
  if (!projects?.length) return;
  if (previous !== select.value) await refreshSessions();
}

$('project').onchange = async () => {
  const result = await rpc('projects.switch', { path: $('project').value }).catch((err) => ({ error: err.message }));
  if (result.error) { addNote(`could not switch project: ${result.error}`); return; }
  log.textContent = '';
  state.sessionId = null;
  renderPending([]);
  addNote(`project: ${$('project').value}`);
  await Promise.all([refreshSessions(), refreshFiles(), refreshSkills(), refreshPanels()]);
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

// Settings are grouped into sections; the dialog shows one section at a time
// behind a category rail. Every field saves on change — there is no OK button
// to forget.
const SETTINGS_SECTIONS = [
  {
    id: 'general',
    icon: '👤',
    title: 'ทั่วไป',
    sub: 'ชื่อเรียกและหน้าตาของแอป',
    fields: [
      { key: 'displayName', label: 'ชื่อที่ใช้ทักทาย', type: 'text', note: 'แสดงในหน้าทักทายและโปรไฟล์มุมล่าง' },
      { key: 'theme', label: 'ธีม', type: 'select', options: [['light', 'สว่าง (light)'], ['dark', 'มืด (dark)']], note: 'เปลี่ยนทั้งหน้าต่างทันที' },
    ],
  },
  {
    id: 'agent',
    icon: '🤖',
    title: 'โมเดล & การทำงาน',
    sub: 'พฤติกรรมของ AI เวลารันงาน',
    fields: [
      { key: 'defaultModel', label: 'โมเดลเริ่มต้น', type: 'text', note: 'model id เช่น gemini-3.5-flash-lite' },
      { key: 'maxSteps', label: 'จำนวน step สูงสุด', type: 'number', note: 'จำกัดความยาวของงานหนึ่งชิ้น' },
      { key: 'subagent', label: 'ผู้ช่วยย่อย (helpers)', type: 'checkbox', note: 'แตกงานย่อยให้ผู้ช่วยทำแยกได้' },
      { key: 'plan', label: 'โหมดวางแผน (plan)', type: 'checkbox', note: 'เขียนแผนก่อนลงมือทุกครั้ง' },
      { key: 'requirePlanApproval', label: 'รออนุมัติแผนก่อนลงมือ', type: 'checkbox', note: 'แผนต้องผ่านคุณก่อนแตะไฟล์จริง' },
      { key: 'compaction.contextTokens', label: 'งบ context ก่อนสรุปย่อ', type: 'number', note: 'เกินแล้วจะสรุปงานเก่าและเริ่มบทสนทนาใหม่' },
    ],
  },
  {
    id: 'permissions',
    icon: '🛡️',
    title: 'สิทธิ์ & ความปลอดภัย',
    sub: 'คุมว่า AI เขียนไฟล์และรันคำสั่งได้แค่ไหน',
    fields: [
      { key: 'mode', label: 'สิทธิ์การเขียน (mode)', type: 'select', options: [['ask', 'ask — ยืนยันก่อนเขียนทุกไฟล์'], ['auto', 'auto — เขียนผ่านอัตโนมัติ'], ['yolo', 'yolo — เขียนและ shell ผ่านหมด']], note: 'เปลี่ยนได้เร็ว ๆ ที่แถบพิมพ์ข้อความ' },
      { key: 'allowRun', label: 'อนุญาตรัน shell', type: 'checkbox', note: 'ปิดไว้เมื่อไม่อยากให้รันคำสั่งใด ๆ' },
    ],
  },
  {
    id: 'playbooks',
    icon: '📘',
    title: 'Playbooks',
    sub: 'แหล่งที่ใช้ค้นหา playbook',
    fields: [
      { key: 'skillsDirs', label: 'โฟลเดอร์ playbook', type: 'dirs', note: 'คั่นด้วย ; — โฟลเดอร์แรกที่เจอใช้ก่อน' },
    ],
  },
];

// One labelled row: title + note on the left, the control on the right.
// Checkboxes render as switches, `dirs` is a ;-separated list of folders.
function fieldRow(field, get, set) {
  const row = el('div', 'set-row');
  const info = el('div', 'set-info');
  info.append(el('div', 'set-title', field.label));
  if (field.note) info.append(el('div', 'set-note', field.note));
  const control = el('div', 'set-control');
  const value = get(field.key);

  if (field.type === 'checkbox') {
    const lab = el('label', 'switch');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = Boolean(value);
    box.onchange = () => set(field.key, box.checked);
    lab.append(box, el('span', 'track'));
    control.append(lab);
  } else if (field.type === 'select') {
    const select = document.createElement('select');
    for (const [v, text] of field.options) {
      const opt = document.createElement('option');
      opt.value = v; opt.textContent = text;
      if (v === value) opt.selected = true;
      select.append(opt);
    }
    select.onchange = () => set(field.key, select.value);
    control.append(select);
  } else if (field.type === 'dirs') {
    const input = document.createElement('input');
    input.type = 'text';
    input.classList.add('wide');
    input.value = (value ?? []).join('; ');
    input.onchange = () => set(field.key, input.value.split(';').map((s) => s.trim()).filter(Boolean));
    control.append(input);
  } else {
    const input = document.createElement('input');
    input.type = field.type;
    input.value = value ?? '';
    if (field.type === 'number') { input.min = '0'; input.classList.add('narrow'); }
    input.onchange = () => set(field.key, field.type === 'number' ? Number(input.value) : input.value);
    control.append(input);
  }

  row.append(info, control);
  return row;
}

// Cards for the plugins page: loaded ones, load failures, the marker list and
// the reload action, which reopens the dialog to show the fresh state.
function pluginNodes(details) {
  const nodes = [];
  const loaded = details?.loaded ?? [];
  const failed = details?.failed ?? [];
  if (!loaded.length && !failed.length) {
    const hint = el('p', 'settings-empty');
    hint.append('ยังไม่มีปลั๊กอิน — ลากไฟล์ .mjs ใส่ ');
    hint.append(el('code', null, details?.dir ?? 'โฟลเดอร์ปลั๊กอิน'));
    hint.append(' แล้วกดโหลดใหม่');
    nodes.push(hint);
  }
  for (const p of loaded) {
    const card = el('div', 'plugin-card');
    card.append(el('div', 'plugin-name', `${p.name} ${p.version}`));
    card.append(el('div', 'plugin-desc', p.description || 'ไม่มีคำอธิบาย'));
    nodes.push(card);
  }
  for (const f of failed) {
    const card = el('div', 'plugin-card bad');
    card.append(el('div', 'plugin-name', `โหลดไม่สำเร็จ — ${f.file}`));
    card.append(el('div', 'plugin-desc', f.error));
    nodes.push(card);
  }
  if (details?.tools?.length) {
    const p = el('p', 'plugin-markers');
    p.append('markers: ');
    p.append(el('code', null, details.tools.join(', ')));
    nodes.push(p);
  }
  const reload = el('button', 'soft', '↻ โหลดปลั๊กอินใหม่');
  reload.onclick = async () => { await rpc('plugins.reload'); hideModal(); openSettings(); };
  nodes.push(reload);
  return nodes;
}

async function openSettings() {
  const settings = await rpc('settings.get').catch(() => null);
  if (!settings) { addNote('could not read settings'); return; }
  state.settings = settings;

  const get = (key) => key.split('.').reduce((o, k) => (o ?? {})[k], settings);
  const set = (key, value) => {
    const patch = {};
    if (key.includes('.')) {
      const [head, tail] = key.split('.');
      patch[head] = { ...(settings[head] ?? {}), [tail]: value };
    } else patch[key] = value;
    return rpc('settings.set', patch);
  };

  const plugins = await rpc('plugins.list').catch(() => null);
  const sections = plugins
    ? [...SETTINGS_SECTIONS, { id: 'plugins', icon: '🧩', title: 'ปลั๊กอิน', sub: 'โค้ดเสริมที่โหลดจากโฟลเดอร์ปลั๊กอิน' }]
    : SETTINGS_SECTIONS;

  const root = el('div', 'settings');
  const nav = el('nav', 'settings-nav');
  const pages = el('div', 'settings-pages');
  const show = (id) => {
    for (const b of nav.querySelectorAll('button')) b.classList.toggle('active', b.dataset.cat === id);
    for (const p of pages.querySelectorAll('.settings-page')) p.classList.toggle('active', p.dataset.page === id);
  };

  sections.forEach((section, i) => {
    const tab = el('button', i === 0 ? 'active' : '');
    tab.dataset.cat = section.id;
    tab.append(el('span', 'nav-icon', section.icon), el('span', null, section.title));
    tab.onclick = () => show(section.id);
    nav.append(tab);

    const page = el('section', i === 0 ? 'settings-page active' : 'settings-page');
    page.dataset.page = section.id;
    page.append(el('h4', 'settings-page-title', section.title));
    page.append(el('p', 'settings-page-sub', section.sub));
    if (section.id === 'plugins') {
      page.append(...pluginNodes(plugins));
    } else {
      const group = el('div', 'set-group');
      for (const field of section.fields) group.append(fieldRow(field, get, set));
      page.append(group);
    }
    pages.append(page);
  });

  root.append(nav, pages);
  $('modal-title').textContent = 'ตั้งค่า';
  const body = $('modal-body');
  body.textContent = '';
  body.append(root);
  body.closest('.sheet').classList.add('settings-sheet');

  const actions = $('modal-actions');
  actions.textContent = '';
  const close = el('button', 'primary', 'ปิด');
  close.onclick = hideModal;
  actions.append(close);
  $('modal').classList.remove('hidden');
}

$('settings-btn').onclick = () => openSettings();

/* ---------------------------------------------------------- plugin panels */

async function refreshPanels() {
  const holder = $('plugin-panels');
  const details = await rpc('plugins.list').catch(() => null);
  if (!details?.panels?.length) { holder.classList.add('hidden'); return; }
  holder.classList.remove('hidden');
  holder.textContent = '';
  holder.append(el('h3', null, 'ปลั๊กอิน'));
  for (const panel of details.panels) {
    const box = el('div', 'plugin-panel');
    box.id = `panel-${panel.id}`;
    box.append(el('h5', null, panel.title));
    box.dataset.panel = panel.id;
    holder.append(box);
    await paintPanel(box, panel.id);
  }
}

async function paintPanel(box, id) {
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
  $('status').append(dot(st.bridge, 'bridge'), dot(st.extensions > 0, `extension ×${st.extensions}`));

  // The greeting cards say the same thing in sentences instead of dots.
  const line = (ok, text) => {
    const s = el('span');
    s.append(el('span', 'dot ' + (ok ? 'ok' : 'no')), document.createTextNode(' ' + text));
    return s;
  };
  const bridgeCell = $('card-bridge');
  if (bridgeCell) {
    bridgeCell.textContent = '';
    bridgeCell.append(line(st.bridge, st.bridge ? 'เชื่อมต่อ bridge แล้ว' : 'ยังไม่เชื่อมต่อ bridge — เปิด Chrome ที่ล็อกอิน de.aipass.net ไว้'));
    const ext = $('card-ext');
    ext.textContent = '';
    ext.append(line(st.extensions > 0, st.extensions > 0 ? `extension พร้อมทำงาน ${st.extensions} ตัว` : 'ยังไม่เห็น extension'));
  }
  if (st.model) {
    const credits = await rpc('credits').catch(() => null);
    if (credits) $('status').append(el('span', null, `credits ${credits.available?.toLocaleString?.() ?? credits.available} / ${credits.limit?.toLocaleString?.() ?? credits.limit}`));
    const cell = $('card-credits');
    if (cell) cell.textContent = credits ? `credits ${credits.available?.toLocaleString?.() ?? credits.available} / ${credits.limit?.toLocaleString?.() ?? credits.limit}` : '';
  }
  const cur = (st.projects ?? []).find((p) => p.current);
  const name = $('card-project-name');
  if (name) name.textContent = cur?.name ?? st.root ?? 'ยังไม่ได้เปิดโฟลเดอร์';
  const model = $('card-model');
  if (model) model.textContent = st.model ?? 'auto';

  if (st.model && !$('model').options.length) {
    const models = await rpc('models').catch(() => null);
    const list = models?.data ?? models?.models ?? [];
    for (const m of list) {
      const opt = document.createElement('option');
      opt.value = m.id ?? m;
      opt.textContent = m.id ?? m;
      $('model').append(opt);
    }
    // The upstream default may not be in the advertised list; keep it visible.
    if (st.model && ![...$('model').options].some((o) => o.value === st.model)) {
      const opt = document.createElement('option');
      opt.value = st.model;
      opt.textContent = st.model;
      $('model').prepend(opt);
    }
    if (st.model) $('model').value = st.model;
  }
}

setInterval(refreshHeader, 10_000);

/* ---------------------------------------------------------- window chrome */

// The sidebar collapses to nothing and its width is draggable; both choices
// persist across reloads in localStorage.
function applySide(open) {
  document.body.classList.toggle('side-collapsed', !open);
}
$('side-toggle').onclick = () => {
  const open = document.body.classList.contains('side-collapsed');
  applySide(open);
  localStorage.setItem('aipass.side', open ? '1' : '0');
};
applySide(localStorage.getItem('aipass.side') !== '0');

const savedWidth = Number(localStorage.getItem('aipass.sideW'));
if (savedWidth >= 220 && savedWidth <= 440) {
  document.documentElement.style.setProperty('--side-w', `${savedWidth}px`);
}
$('side-resize').onpointerdown = (ev) => {
  ev.preventDefault();
  const move = (e) => {
    const w = Math.min(440, Math.max(220, e.clientX));
    document.documentElement.style.setProperty('--side-w', `${w}px`);
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    localStorage.setItem('aipass.sideW', document.documentElement.style.getPropertyValue('--side-w'));
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
};

// Inside the Tauri shell the UI owns the window chrome: minimize, maximize and
// close ride the global API (withGlobalTauri) — no npm dependency. In a plain
// browser there is nothing to control, so the buttons stay hidden.
const tauriWin = () => window.__TAURI__?.window?.getCurrentWindow?.();
if (tauriWin()) {
  $('win-controls').classList.remove('hidden');
  $('win-min').onclick = () => tauriWin().minimize();
  $('win-max').onclick = () => tauriWin().toggleMaximize();
  $('win-close').onclick = () => tauriWin().close();
}

// Desktop keyboard conventions: Ctrl+B folds the sidebar, Ctrl+N starts a new
// plan, Ctrl+, opens settings.
document.addEventListener('keydown', (ev) => {
  if (!ev.ctrlKey || ev.altKey || ev.shiftKey) return;
  const key = ev.key.toLowerCase();
  if (key === 'b') { ev.preventDefault(); $('side-toggle').click(); }
  else if (key === ',') { ev.preventDefault(); openSettings(); }
  else if (key === 'n') { ev.preventDefault(); $('new-session').click(); }
});

// The greeting is the empty-session view: it shows until the first message
// lands in the log, and comes back when the log empties.
new MutationObserver(() => {
  $('chat').classList.toggle('has-messages', log.children.length > 0);
}).observe(log, { childList: true });

// Suggestion chips drop an opening line into the composer instead of sending
// it blind — the task usually needs the user's own words appended.
for (const chip of document.querySelectorAll('.chip')) {
  chip.onclick = () => {
    $('task').value = chip.dataset.prompt ?? '';
    growTask();
    $('task').focus();
  };
}

// Theme and the greeting name ride the settings object; the backend emits a
// `settings` event on every settings.set, so modal edits apply live.
function applySettings(s) {
  if (!s) return;
  document.documentElement.dataset.theme = s.theme === 'dark' ? 'dark' : 'light';
  const name = (s.displayName ?? '').trim();
  $('greeting-title').textContent = name ? `สวัสดีครับ ${name}` : 'สวัสดีครับ 👋';
  $('profile-name').textContent = name || 'aipass desktop';
  $('profile-sub').textContent = name ? 'aipass desktop' : 'ตั้งชื่อได้ใน settings';
  $('profile-avatar').textContent = (name[0] ?? 'A').toUpperCase();
  if (document.activeElement !== $('mode')) $('mode').value = s.mode ?? 'ask';
}
stream.addEventListener('settings', (e) => applySettings(JSON.parse(e.data)));
$('profile').onclick = () => openSettings();
$('card-open-folder').onclick = () => $('add-project').click();

// The composer textarea grows with its content, like the upstream pill.
function growTask() {
  const t = $('task');
  t.style.height = 'auto';
  t.style.height = Math.min(t.scrollHeight, 200) + 'px';
}
$('task').addEventListener('input', growTask);

/* ------------------------------------------------------------------ boot */

(async function boot() {
  applySettings(await rpc('settings.get').catch(() => null));
  await refreshHeader();
  await refreshProjects((await rpc('status').catch(() => null))?.projects);
  await refreshSessions();
  await refreshSkills();
  await refreshFiles();
  await refreshPanels();
  await refreshPending();
  $('task').focus();
})();
