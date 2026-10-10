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
  msg.append(el('div', 'who', 'you'));
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
    panel.append(el('h4', null, 'plan & todo'));
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

function hideModal() { $('modal').classList.add('hidden'); }

/* ------------------------------------------------------------ permissions */

function askPermission({ id, kind, arg, risk }) {
  $('modal-title').textContent = `${risk === 'shell' ? 'run this command' : 'change this file'}?`;
  const body = $('modal-body');
  body.textContent = '';
  body.append(el('p', null, arg || kind));
  if (risk === 'shell') {
    const pre = el('pre', null, arg || '');
    body.textContent = '';
    body.append(el('p', 'dim', 'shell command the model wants to run'), pre);
  }

  const actions = $('modal-actions');
  actions.textContent = '';
  const answer = (decision) => { hideModal(); rpc('permission.answer', { id, decision }); };
  const deny = el('button', null, 'deny');
  deny.onclick = () => answer('deny');
  const allow = el('button', 'primary', 'allow');
  allow.onclick = () => answer('allow');
  const always = el('button', null, 'always');
  always.onclick = () => answer('always');
  actions.append(deny, always, allow);
  $('modal').classList.remove('hidden');
}

function askPlan() {
  $('modal-title').textContent = 'start this plan?';
  const body = $('modal-body');
  body.textContent = '';
  body.append(el('p', null, 'The model wrote a plan. Approve it and the work begins; decline and the run stops before any change.'));
  const actions = $('modal-actions');
  actions.textContent = '';
  const no = el('button', null, 'decline');
  no.onclick = () => { hideModal(); rpc('plan.answer', { ok: false }); };
  const yes = el('button', 'primary', 'approve');
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
  $('send').textContent = 'send';
  $('hint').textContent = '';
  if (credits) addNote(`credits  ${credits.available?.toLocaleString?.() ?? credits.available} of ${credits.limit?.toLocaleString?.() ?? credits.limit} left${spent > 0 ? ` · ${spent.toLocaleString()} this run` : ''}`);
  if (stopReason !== 'done') addNote(`stopped: ${stopReason}`);
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
  $('send').textContent = 'stop';
  $('hint').textContent = 'working…';
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
    $('send').textContent = 'send';
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
$('mode').onchange = () => rpc('config.set', {}).catch(() => {});
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
      const close = el('button', 'primary', 'close');
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
      const close = el('button', 'primary', 'close');
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

const SETTINGS_FORM = [
  { key: 'defaultModel', label: 'default model', type: 'text', note: 'model id, e.g. gemini-3.5-flash-lite' },
  { key: 'mode', label: 'write permission', type: 'select', options: [['ask', 'ask — confirm every write'], ['auto', 'auto — writes go through'], ['yolo', 'yolo — writes and shell']] },
  { key: 'allowRun', label: 'allow shell', type: 'checkbox' },
  { key: 'maxSteps', label: 'max steps', type: 'number' },
  { key: 'plan', label: 'plan mode', type: 'checkbox' },
  { key: 'requirePlanApproval', label: 'wait for plan approval', type: 'checkbox' },
  { key: 'subagent', label: 'helpers', type: 'checkbox' },
  { key: 'theme', label: 'theme', type: 'select', options: [['dark', 'dark'], ['light', 'light']] },
  { key: 'compaction.contextTokens', label: 'compaction budget', type: 'number', note: 'summarise and rotate past this' },
];

async function openSettings() {
  const settings = await rpc('settings.get').catch(() => null);
  if (!settings) { addNote('could not read settings'); return; }
  state.settings = settings;

  $('modal-title').textContent = 'settings';
  const body = $('modal-body');
  body.textContent = '';
  const form = el('div', 'settings-grid');

  const get = (key) => key.split('.').reduce((o, k) => (o ?? {})[k], settings);
  const set = (key, value) => {
    const patch = {};
    if (key.includes('.')) {
      const [head, tail] = key.split('.');
      patch[head] = { ...(settings[head] ?? {}), [tail]: value };
    } else patch[key] = value;
    return rpc('settings.set', patch);
  };

  for (const field of SETTINGS_FORM) {
    const label = el('label', null, field.label);
    form.append(label);
    const value = get(field.key);
    if (field.type === 'checkbox') {
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = Boolean(value);
      box.onchange = () => set(field.key, box.checked);
      form.append(box);
      if (field.note) { form.append(el('span')); form.append(el('span', 'dim', field.note)); }
    } else if (field.type === 'select') {
      const select = document.createElement('select');
      for (const [v, text] of field.options) {
        const opt = document.createElement('option');
        opt.value = v; opt.textContent = text;
        if (v === value) opt.selected = true;
        select.append(opt);
      }
      select.onchange = () => set(field.key, select.value);
      form.append(select);
      if (field.note) { form.append(el('span')); form.append(el('span', 'dim', field.note)); }
    } else {
      const input = document.createElement('input');
      input.type = field.type;
      input.value = value ?? '';
      if (field.type === 'number') input.min = '0';
      input.onchange = () => set(field.key, field.type === 'number' ? Number(input.value) : input.value);
      form.append(input);
      if (field.note) { form.append(el('span')); form.append(el('span', 'dim', field.note)); }
    }
  }

  // Playbook folders, one per line, resolved in order.
  form.append(el('label', null, 'playbook folders'));
  const dirs = document.createElement('input');
  dirs.type = 'text';
  dirs.value = (settings.skillsDirs ?? []).join('; ');
  dirs.onchange = () => rpc('settings.set', { skillsDirs: dirs.value.split(';').map((s) => s.trim()).filter(Boolean) });
  form.append(dirs);
  form.append(el('span'));
  form.append(el('span', 'dim', 'semicolon separated, first match wins'));

  body.append(form);

  // Plugins, listed from the manager.
  const details = await rpc('plugins.list').catch(() => null);
  if (details) {
    body.append(el('h4', null, `plugins — ${details.dir}`));
    if (!details.loaded.length && !details.failed.length) {
      body.append(el('p', 'dim', `drop a .mjs file in ${details.dir} to add one`));
    }
    for (const p of details.loaded) {
      body.append(el('p', null, `${p.name} ${p.version} — ${p.description || 'no description'}`));
    }
    for (const f of details.failed) {
      body.append(el('p', null, `failed: ${f.file} — ${f.error}`));
    }
    if (details.tools.length) {
      body.append(el('p', 'dim', `markers: ${details.tools.join(', ')}`));
    }
  }

  const actions = $('modal-actions');
  actions.textContent = '';
  const reload = el('button', null, 'reload plugins');
  reload.onclick = async () => { await rpc('plugins.reload'); hideModal(); openSettings(); };
  const close = el('button', 'primary', 'close');
  close.onclick = hideModal;
  actions.append(reload, close);
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
  holder.append(el('h3', null, 'plugins'));
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
  if (st.model) {
    const credits = await rpc('credits').catch(() => null);
    if (credits) $('status').append(el('span', null, `credits ${credits.available?.toLocaleString?.() ?? credits.available} / ${credits.limit?.toLocaleString?.() ?? credits.limit}`));
  }
  if (st.model && !$('model').options.length) {
    const models = await rpc('models').catch(() => null);
    const list = models?.data ?? models?.models ?? [];
    for (const m of list) {
      const opt = document.createElement('option');
      opt.value = m.id ?? m;
      opt.textContent = m.id ?? m;
      $('model').append(opt);
    }
    if (st.model) $('model').value = st.model;
  }
}

setInterval(refreshHeader, 10_000);

/* ------------------------------------------------------------------ boot */

(async function boot() {
  await refreshHeader();
  await refreshProjects((await rpc('status').catch(() => null))?.projects);
  await refreshSessions();
  await refreshSkills();
  await refreshFiles();
  await refreshPanels();
  await refreshPending();
  $('task').focus();
})();
