/**
 * The rail, driven directly.
 *
 * `app.js` owns the window, but the rail's logic — the day words, the folds,
 * the session rows, the archive, the playbooks and the facts — is a panel that
 * takes its context. Booting the whole window to test a date label would make
 * the test depend on the backend and on every other panel; this file builds
 * the smallest context the panel needs and drives the handlers it wires.
 *
 * The fake DOM is intentionally small: an element is a tag, a class list, a
 * text value and a list of children. That is the whole contract the panel uses.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSessionsPanel } from '../../desktop/ui/panels/sessions.js';

/* ------------------------------------------------------------------ the dom */

class El {
  constructor(tag = 'div', className = '', text = '') {
    this.tagName = String(tag).toUpperCase();
    this.className = className ?? '';
    this.children = [];
    this.attrs = {};
    this.dataset = {};
    this.style = {};
    this.handlers = {};
    this.hidden = false;
    this.disabled = false;
    this.value = '';
    this.tabIndex = -1;
    this.title = '';
    this._text = String(text ?? '');
  }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return `${this._text}${this.children.map((c) => c.textContent ?? '').join('')}`; }
  append(...kids) { this.children.push(...kids); }
  setAttribute(key, value) { this.attrs[key] = String(value); }
  getAttribute(key) { return this.attrs[key] ?? null; }
  addEventListener(type, fn) { (this.handlers[type] ??= []).push(fn); }
  focus() { this.focused = true; }
  scrollIntoView() { this.scrolled = true; }
  click() { this.clicked = true; }
  get classList() {
    const set = () => new Set(this.className.split(/\s+/).filter(Boolean));
    return {
      add: (name) => { this.className = [...set(), name].join(' '); },
      remove: (name) => { this.className = [...set()].filter((n) => n !== name).join(' '); },
      contains: (name) => set().has(name),
      toggle: (name, on) => ((on ?? !set().has(name)) ? this.classList.add(name) : this.classList.remove(name)),
    };
  }
}

const el = (tag, className, text) => new El(tag, className ?? '', text ?? '');

/* ---------------------------------------------------------------- the context */

function makeStorage({ data = {}, failGet = false, failSet = false } = {}) {
  return {
    data,
    failGet,
    failSet,
    getItem(key) {
      if (this.failGet) throw new Error('storage off');
      return Object.hasOwn(this.data, key) ? this.data[key] : null;
    },
    setItem(key, value) {
      if (this.failSet) throw new Error('storage full');
      this.data[key] = String(value);
    },
  };
}

/**
 * Build the window context the panel expects. Returns the panel, the elements
 * by id, the recorded side effects and a small RPC router.
 */
function setup({
  storage = makeStorage(),
  folds = {},
  filter = '',
  withCount = true,
  withSections = true,
  withSaveDraft = true,
  ids = {},
} = {}) {
  storage.data['aipass.side.fold'] = JSON.stringify(folds);
  const nodes = new Map();
  const make = (id) => { const node = new El(); node.id = id; nodes.set(id, node); return node; };
  for (const id of [
    'sessions', 'files', 'task', 'modal-title', 'modal-body', 'modal-actions',
    'sessions-fold', 'files-fold',
  ]) make(id);
  if (withSections) { make('sessions-section'); make('files-section'); }
  if (withCount) make('session-count');
  if (filter !== null) make('session-filter').value = filter;
  for (const [id, node] of Object.entries(ids)) nodes.set(id, node);

  const notes = [];
  const outputs = [];
  const opened = [];
  const exported = [];
  const rpcCalls = [];
  const rpcHandlers = new Map();
  let saveDrafts = 0;
  let modals = 0;

  const rpc = async (method, params) => {
    rpcCalls.push({ method, params });
    const handler = rpcHandlers.get(method);
    if (handler instanceof Error) throw handler;
    if (typeof handler === 'function') return handler(params);
    return handler ?? [];
  };

  const ctx = {
    $: (id) => nodes.get(id) ?? null,
    el,
    state: { sessionId: null, skills: [] },
    rpc,
    clickable: (node, fn) => { node.onActivate = fn; },
    addNote: (text) => notes.push(text),
    addCommandOut: (text) => outputs.push(text),
    hideModal: () => { modals += 1; },
    openModal: () => { modals += 1; },
    openSession: (id) => opened.push(id),
    exportSession: (id, title) => exported.push({ id, title }),
  };
  if (withSaveDraft) ctx.saveDraft = () => { saveDrafts += 1; };

  let panel;
  const previousStorage = globalThis.localStorage;
  globalThis.localStorage = storage;
  try {
    panel = createSessionsPanel(ctx);
  } finally {
    // The panel reads localStorage when its handlers run, so leave the fake
    // in place for the test that is about to drive them; the caller restores
    // it. Tests in one file run in order, so nothing else observes it.
    void previousStorage;
  }

  return {
    panel, ctx, nodes, storage, notes, outputs, opened, exported, rpcCalls, rpcHandlers,
    setRpc: (method, handler) => rpcHandlers.set(method, handler),
    saveDrafts: () => saveDrafts,
    modals: () => modals,
    restore: () => { globalThis.localStorage = previousStorage; },
  };
}

const daysBack = (n) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
};

const click = async (node, ev = {}) => {
  await node.onclick?.(ev);
};

/** The delete handler is fire-and-forget (`void removeSkillRow`); let it run. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

/* --------------------------------------------------------------- day words */

test('sessionDay names today, yesterday, this week, this year and an old year', () => {
  const t = setup();
  const { sessionDay, sessionBucket } = t.panel;

  assert.equal(sessionDay(new Date()), 'วันนี้');
  assert.equal(sessionDay(daysBack(1)), 'เมื่อวาน');
  assert.equal(sessionDay(daysBack(3)), '3 วันก่อน');

  // The day-of-month format only exists for dates at least a week old. In the
  // first week of January there is no such date in the current year, so the
  // same-year check is conditional rather than a flaky assertion.
  const janFirst = new Date(new Date().getFullYear(), 0, 1);
  if (daysBack(0) - janFirst >= 7 * 86_400_000) {
    assert.equal(sessionDay(janFirst), '1 ม.ค.');
  }
  assert.equal(sessionDay(new Date(2001, 0, 2)), '2 ม.ค. 01');

  assert.equal(sessionBucket(null), 'เก่ากว่านั้น');
  assert.equal(sessionBucket(new Date('not a date')), 'เก่ากว่านั้น');
  assert.equal(sessionBucket(daysBack(-1)), 'วันนี้');
  assert.equal(sessionBucket(daysBack(0)), 'วันนี้');
  assert.equal(sessionBucket(daysBack(1)), 'เมื่อวาน');
  assert.equal(sessionBucket(daysBack(3)), 'สัปดาห์นี้');
  assert.equal(sessionBucket(daysBack(10)), 'เดือนนี้');
  assert.equal(sessionBucket(daysBack(40)), 'เก่ากว่านั้น');
  t.restore();
});

/* ------------------------------------------------------------------- folds */

test('the fold toggles, remembers, and survives storage being unavailable', () => {
  const storage = makeStorage();
  const t = setup({ storage, folds: { 'sessions-section': true } });
  const { nodes } = t;

  // A remembered fold is applied when the panel is built.
  assert.match(nodes.get('sessions-section').className, /folded/);
  assert.equal(nodes.get('sessions-fold').attrs['aria-expanded'], 'false');

  nodes.get('sessions-fold').onclick();
  assert.doesNotMatch(nodes.get('sessions-section').className, /folded/);
  assert.equal(nodes.get('sessions-fold').attrs['aria-expanded'], 'true');
  assert.equal(JSON.parse(storage.data['aipass.side.fold'])['sessions-section'], false);

  nodes.get('files-fold').onclick();
  assert.match(nodes.get('files-section').className, /folded/);

  // A section that is not in the DOM does not throw: optional chaining is the
  // whole reason a panel can be built while a sheet is closed.
  nodes.delete('files-section');
  nodes.get('files-fold').onclick();
  assert.equal(JSON.parse(storage.data['aipass.side.fold'])['files-section'], true);

  // Storage can be read-only (a private window, a quota). The toggle still
  // happens; only the memory of it is lost.
  storage.failSet = true;
  nodes.get('sessions-fold').onclick();
  assert.match(nodes.get('sessions-section').className, /folded/);
  t.restore();
});

test('a storage read failure starts unfolded instead of taking the window down', () => {
  const t = setup({ storage: makeStorage({ failGet: true }) });
  assert.doesNotMatch(t.nodes.get('sessions-section').className, /folded/);
  t.nodes.get('sessions-fold').onclick();
  assert.match(t.nodes.get('sessions-section').className, /folded/);
  t.restore();
});

test('a missing section and a missing fold button are both tolerated', () => {
  const t = setup({ withSections: false });
  // The handlers exist and call applyFold/toggleFold with no section in the
  // map, exercising both optional-chain misses.
  t.nodes.get('sessions-fold').onclick();
  t.nodes.get('files-fold').onclick();
  assert.equal(t.storage.data['aipass.side.fold'], JSON.stringify({
    'sessions-section': true, 'files-section': true,
  }));
  t.restore();
});

test('arrow keys move between focusable rows and stop at the ends', () => {
  const t = setup();
  const list = t.nodes.get('sessions');
  const rows = [new El(), new El(), new El(), new El()];
  rows[0].tabIndex = 0;
  rows[1].tabIndex = 0;
  rows[2].tabIndex = 0;
  rows[3].tabIndex = -1;
  list.append(...rows);
  const onKey = list.handlers.keydown[0];

  const ev = (key, target) => ({ key, target, preventDefault() { this.prevented = true; } });

  onKey(ev('Enter', rows[0]));
  onKey(ev('ArrowDown', rows[2]));            // last focusable row: no next
  onKey(ev('ArrowUp', rows[0]));              // first focusable row: no previous
  const down = ev('ArrowDown', rows[0]);
  onKey(down);
  assert.equal(down.prevented, true);
  assert.equal(rows[1].focused, true);
  assert.equal(rows[1].scrolled, true);

  // A row without focus/scroll helpers still moves the selection.
  rows[1].focus = undefined;
  rows[1].scrollIntoView = undefined;
  onKey(ev('ArrowDown', rows[0]));

  // A non-focusable target is treated as "above the first row".
  onKey(ev('ArrowUp', rows[3]));

  // An empty list is a no-op.
  list.children = [];
  onKey(ev('ArrowDown', rows[0]));

  // A list that is not in the DOM at all (the sheet was not painted) is a
  // no-op too, not a crash.
  t.nodes.delete('sessions');
  onKey(ev('ArrowDown', rows[0]));
  t.restore();
});

/* ---------------------------------------------------------- the session list */

test('the session rows filter, group, count, export and open', async () => {
  const t = setup({ filter: '' });
  t.ctx.state.sessionId = 's2';
  t.setRpc('session.archived', []);

  const now = new Date();
  now.setHours(9, 7, 0, 0);
  const yesterday = daysBack(1);
  yesterday.setHours(9, 7, 0, 0);
  const sessions = [
    { id: 's1', title: '2026-10-20 09:07 deploy check', updated: now.toISOString() },
    { id: 's2', title: '2026-10-20 09:07', updated: yesterday.toISOString() },
    { id: 's3', title: undefined, updated: daysBack(3).toISOString() },
    { id: 's4', title: 'plain name', updated: daysBack(10).toISOString() },
    { id: 's5', title: 'old', updated: daysBack(40).toISOString() },
    { id: 's6', title: 'no timestamp' },
    // No `updated`: the timestamp inside the title is the only date there is.
    { id: 's7', title: '2026-10-20 09:07 stamped only' },
    ...Array.from({ length: 40 }, (_, i) => ({
      id: `pad${i}`, title: `padding ${i}`, updated: daysBack(2).toISOString(),
    })),
  ];
  t.setRpc('session.list', sessions);

  await t.panel.refreshSessions();
  const list = t.nodes.get('sessions');
  const rows = list.children.filter((li) => !li.className.split(/\s+/).includes('day-head'));

  assert.equal(t.nodes.get('session-count').textContent, String(sessions.length));
  assert.ok(rows.some((li) => li.className.includes('active')), 'the open session is marked');

  const named = rows.find((li) => li.textContent.includes('deploy check'));
  assert.ok(named, 'the named part of a stamped title is the label');
  assert.ok(named.textContent.includes('09:07'), 'the clock is the sub-column');

  const clockOnly = rows.find((li) => li.title.includes('\ns2\n'));
  assert.ok(clockOnly.textContent.includes('09:07'));

  const untitled = rows.find((li) => li.title.includes('\ns3\n'));
  assert.ok(untitled.textContent.includes('(untitled)'));

  // The export button stops the click that would open the session, and the
  // row itself opens it through the clickable helper.
  const exportBtn = named.children.find((c) => c.tagName === 'BUTTON');
  await exportBtn.onclick({ stopPropagation() { this.stopped = true; } });
  await exportBtn.onclick({});
  assert.deepEqual(t.exported[0], { id: 's1', title: sessions[0].title });
  await named.onActivate();
  assert.equal(t.opened.at(-1), 's1');

  // More than forty sessions offers the archive action, and both answers from
  // the backend are reported.
  const bar = () => list.children.find((li) => li.className.includes('archive-bar'));
  t.setRpc('session.archive', { count: 2 });
  await click(bar().children[0]);
  assert.match(t.outputs.at(-1), /2/);
  t.setRpc('session.archive', { count: 0 });
  await click(bar().children[0]);
  assert.match(t.outputs.at(-1), /ไม่มีบทสนทนาเก่า/);
  t.setRpc('session.archive', new Error('disk'));
  await click(bar().children[0]);
  assert.match(t.notes.at(-1), /เก็บไม่ได้: disk/);

  // A search counts what it let through, and a miss says so.
  t.nodes.get('session-filter').value = 'deploy';
  await t.panel.refreshSessions();
  assert.equal(t.nodes.get('session-count').textContent, `1/${sessions.length}`);
  t.nodes.get('session-filter').value = 'nothing-matches';
  await t.panel.refreshSessions();
  assert.ok(list.textContent.includes('ไม่พบบทสนทนาที่ค้น'));

  // No sessions and no filter is the empty-history sentence.
  t.setRpc('session.list', []);
  t.nodes.get('session-filter').value = '';
  await t.panel.refreshSessions();
  assert.ok(list.textContent.includes('ยังไม่มีบทสนทนา'));

  // The filter and the count are both optional: the panel is usable in a
  // smaller layout without them.
  t.nodes.delete('session-filter');
  t.nodes.delete('session-count');
  await t.panel.refreshSessions();
  assert.ok(list.textContent.includes('ยังไม่มีบทสนทนา'));
  t.restore();
});

test('an invalid updated date falls into the oldest group instead of throwing', async () => {
  const t = setup();
  t.setRpc('session.list', [{ id: 'bad', title: 'broken', updated: 'not a date' }]);
  t.setRpc('session.archived', []);
  await t.panel.refreshSessions();
  assert.ok(t.nodes.get('sessions').textContent.includes('เก่ากว่านั้น'));
  t.restore();
});

/* ---------------------------------------------------------- the archive */

test('the archive opens, returns a session, and only prunes after a confirmation', async () => {
  const t = setup();
  t.setRpc('session.list', []);
  t.setRpc('session.archived', [
    { id: 'a1', title: 'first', updated: new Date().toISOString() },
    { id: 'a2' },
  ]);
  globalThis.window = { confirm: () => true };
  globalThis.confirm = () => true;

  await t.panel.refreshSessions();
  const list = t.nodes.get('sessions');
  const bar = () => list.children.find((li) => li.className.includes('archive-bar'));
  const box = () => list.children.find((li) => li.className.includes('archived-box'));

  const open = bar().children[0];
  open.onclick();
  assert.equal(open.textContent, 'ปิดที่เก็บ (2)');
  assert.equal(box().hidden, false);
  assert.equal(box().children.length, 2);
  assert.equal(box().children[0].children.at(-2).textContent, 'วันนี้');

  open.onclick();
  assert.equal(open.textContent, 'คืนจากที่เก็บ (2)');
  assert.equal(box().hidden, true);
  open.onclick();

  // A successful return says so; the untitled row falls back to "(untitled)".
  t.setRpc('session.unarchive', {});
  // Refreshing rebuilds the rail, so hold the box and both rows before the
  // first click. The old nodes keep their handlers even after the rebuild.
  const oldBox = box();
  const backOne = oldBox.children[0].children.at(-1);
  const backTwo = oldBox.children[1].children.at(-1);
  await click(backOne);
  assert.match(t.outputs.at(-1), /first/);
  await click(backTwo);
  assert.match(t.outputs.at(-1), /\(untitled\)/);

  // A failed return is a note, not an unhandled rejection.
  t.setRpc('session.unarchive', new Error('gone'));
  await click(oldBox.children[0].children.at(-1));
  assert.match(t.notes.at(-1), /คืนไม่ได้: gone/);

  // Prune asks first. A "no" is a no-op; yes prunes and reports both counts.
  const prune = () => bar().children[1];
  globalThis.window.confirm = () => false;
  const before = t.rpcCalls.filter((c) => c.method === 'session.prune').length;
  await click(prune());
  assert.equal(t.rpcCalls.filter((c) => c.method === 'session.prune').length, before);

  globalThis.window.confirm = () => true;
  t.setRpc('session.prune', { count: 1 });
  await click(prune());
  assert.match(t.outputs.at(-1), /1 รายการ/);
  t.setRpc('session.prune', { count: 0 });
  await click(prune());
  assert.match(t.outputs.at(-1), /ไม่มีบทสนทนาที่เก็บเก่า/);
  t.setRpc('session.prune', new Error('read-only'));
  await click(prune());
  assert.match(t.notes.at(-1), /ลบไม่ได้: read-only/);

  delete globalThis.window;
  delete globalThis.confirm;
  t.restore();
});

/* ---------------------------------------------------------- the playbooks */

test('the playbook list draws every role, invokes, opens and deletes', async () => {
  const t = setup();
  const list = new El('ul');

  t.panel.renderSkillList(list, []);
  assert.ok(list.textContent.includes('ยังไม่มีคู่มือ'));

  t.ctx.state.skills = [
    { name: 'mine', role: 'user', file: '/home/me/mine.md' },
    { name: 'shared', role: 'project' },
    { name: 'preset', role: 'configured' },
    { name: 'odd', role: 'oddball' },
    { name: 'plain' },
  ];
  t.panel.renderSkillList(list);
  const rows = list.children.map((li) => li.children[0]);
  assert.ok(list.textContent.includes('ผู้ใช้'));
  assert.ok(list.textContent.includes('โปรเจกต์'));
  assert.ok(list.textContent.includes('ตั้งไว้'));
  assert.ok(list.textContent.includes('oddball'));
  assert.equal(rows[0].children[0].title, '/home/me/mine.md');
  assert.equal(rows[1].children[0].title, '');
  // Only the writable libraries carry the delete action.
  assert.ok(rows[0].textContent.includes('ลบ'));
  assert.ok(rows[1].textContent.includes('ลบ'));
  assert.ok(!rows[2].textContent.includes('ลบ'));

  // Invoke fills the composer and saves the draft.
  const use = rows[0].children.at(-1).children[0];
  use.onclick({ stopPropagation() {} });
  assert.match(t.nodes.get('task').value, /mine/);
  assert.equal(t.saveDrafts(), 1);
  assert.equal(t.nodes.get('task').focused, true);

  // A skill body opens on the first activation and closes on the second.
  t.setRpc('skills.load', { text: 'body text' });
  const firstLi = list.children[0];
  const view = firstLi.children.at(-1);
  await firstLi.onActivate();
  assert.equal(view.textContent, 'body text');
  assert.equal(view.hidden, false);
  await firstLi.onActivate();
  assert.equal(view.hidden, true);

  // A load error is shown in the body, not thrown.
  t.setRpc('skills.load', new Error('unreadable'));
  await firstLi.onActivate();
  assert.match(view.textContent, /unreadable/);
  t.setRpc('skills.load', {});
  view.hidden = true;   // the previous load left the body open
  await firstLi.onActivate();
  assert.equal(view.textContent, '');

  // Delete is armed by the first click and done by the second. A successful
  // delete re-reads the library.
  t.setRpc('skills.list', [{ name: 'mine', role: 'user' }]);
  t.setRpc('skills.remove', {});
  const del = list.children[0].children[0].children.at(-1).children.at(-1);
  await del.onclick({ stopPropagation() {} });
  assert.equal(del.textContent, 'ยืนยันลบ?');
  await del.onclick({ stopPropagation() {} });
  await flush();
  assert.match(t.outputs.at(-1), /ลบคู่มือ mine/);
  assert.equal(t.ctx.state.skills.length, 1);

  // A failed delete is a note; the row stays.
  t.panel.renderSkillList(list, [{ name: 'mine', role: 'user' }]);
  t.setRpc('skills.remove', new Error('denied'));
  const delAgain = list.children[0].children[0].children.at(-1).children.at(-1);
  await delAgain.onclick({ stopPropagation() {} });
  await delAgain.onclick({ stopPropagation() {} });
  await flush();
  assert.match(t.notes.at(-1), /ลบไม่ได้: denied/);
  t.restore();
});

test('refreshSkills keeps the state empty when the backend is unavailable', async () => {
  const t = setup();
  t.setRpc('skills.list', [{ name: 'a' }]);
  assert.deepEqual(await t.panel.refreshSkills(), [{ name: 'a' }]);
  t.setRpc('skills.list', new Error('offline'));
  assert.deepEqual(await t.panel.refreshSkills(), []);
  t.restore();
});

test('useSkill works without a saveDraft hook', () => {
  const t = setup({ withSaveDraft: false });
  t.panel.useSkill('deploy');
  assert.match(t.nodes.get('task').value, /deploy/);
  t.restore();
});

/* ------------------------------------------------------ the install dialog */

test('the install dialog validates, reads a file, and handles overwrite', async () => {
  const t = setup();
  const pick = new El('input');
  globalThis.document = {
    createElement: (tag) => (tag === 'input' ? pick : new El(tag)),
  };
  globalThis.FileReader = class {
    readAsText(file) { this.result = `content of ${file.name}`; this.onload(); }
  };
  globalThis.confirm = () => false;

  let installed = 0;
  t.setRpc('skills.list', []);
  t.panel.installSkillDialog({ onInstalled: () => { installed += 1; } });
  assert.equal(t.modals(), 1);
  assert.equal(t.nodes.get('modal-title').textContent, 'ติดตั้งคู่มือ (playbook)');

  const body = t.nodes.get('modal-body');
  const row = body.children[0];
  const nameIn = row.children[0];
  const targetSel = row.children[1];
  const textIn = body.children[1];
  const fileBtn = body.children[2];
  const install = t.nodes.get('modal-actions').children[0];
  const close = t.nodes.get('modal-actions').children[1];

  // The file button opens the hidden picker.
  fileBtn.onclick();
  assert.equal(pick.clicked, true);

  // A change with no file does nothing; with a file it fills the empty name
  // and reads the text. A name already typed is kept.
  pick.handlers.change[0]();
  pick.files = [{ name: 'my-playbook.md' }];
  pick.handlers.change[0]();
  assert.equal(nameIn.value, 'my-playbook');
  assert.equal(textIn.value, 'content of my-playbook.md');

  nameIn.value = 'typed-name';
  pick.files = [{ name: 'other.txt' }];
  pick.handlers.change[0]();
  assert.equal(nameIn.value, 'typed-name');

  // A name with a space and empty content are refused before the backend.
  nameIn.value = 'bad name';
  await click(install);
  assert.match(t.notes.at(-1), /ชื่อคู่มือ/);
  nameIn.value = 'good-name';
  textIn.value = '   ';
  await click(install);
  assert.match(t.notes.at(-1), /ยังไม่มีเนื้อหา/);

  // An existing playbook asks. "No" leaves it alone.
  textIn.value = 'body';
  targetSel.value = 'project';
  t.setRpc('skills.install', { error: 'already exists' });
  await click(install);
  assert.match(t.notes.at(-1), /ยกเลิกการเขียนทับ/);

  // "Yes" retries with overwrite and reports the project library.
  globalThis.confirm = () => true;
  let calls = 0;
  t.setRpc('skills.install', () => (++calls === 1
    ? { error: 'already exists' }
    : { overwritten: true }));
  await click(install);
  assert.match(t.outputs.at(-1), /โปรเจกต์/);
  assert.match(t.outputs.at(-1), /เขียนทับ/);
  assert.equal(installed, 1);

  // With no confirm function the retry still happens, and a plain success
  // omits the overwrite suffix.
  delete globalThis.confirm;
  calls = 0;
  t.setRpc('skills.install', () => (++calls === 1
    ? { error: 'already exists' }
    : { overwritten: false }));
  await click(install);
  assert.doesNotMatch(t.outputs.at(-1), /เขียนทับ/);

  // A retry that fails reports the error; a first failure that is not an
  // overwrite prompt is reported without a retry.
  calls = 0;
  t.setRpc('skills.install', () => (++calls === 1
    ? { error: 'already exists' }
    : { error: 'still locked' }));
  await click(install);
  assert.match(t.notes.at(-1), /ติดตั้งไม่ได้: still locked/);

  t.setRpc('skills.install', { error: 'disk full' });
  await click(install);
  assert.match(t.notes.at(-1), /ติดตั้งไม่ได้: disk full/);

  const beforeClose = t.modals();
  close.onclick();
  assert.equal(t.modals(), beforeClose + 1);

  delete globalThis.document;
  delete globalThis.FileReader;
  delete globalThis.confirm;
  t.restore();
});

/* -------------------------------------------------------------- the facts */

test('renderMemoryFacts draws the list, the empty state, and survives an error', async () => {
  const t = setup();
  const ul = new El('ul');
  const head = new El();

  t.setRpc('memory.list', { facts: ['one', 'two'] });
  const facts = await t.panel.renderMemoryFacts(ul, head);
  assert.deepEqual(facts, ['one', 'two']);
  assert.equal(head.textContent, 'facts ข้าม session (2)');
  assert.equal(ul.children.length, 2);

  // The sheet may ask for the facts without giving a list to draw into.
  const returned = await t.panel.renderMemoryFacts(undefined, head);
  assert.deepEqual(returned, ['one', 'two']);

  // No facts: the header says so and the list explains what creates one.
  t.setRpc('memory.list', { facts: [] });
  await t.panel.renderMemoryFacts(ul, head);
  assert.equal(head.textContent, 'facts ข้าม session');
  assert.ok(ul.textContent.includes('ยังไม่มี'));

  // A backend that is down reads as "no facts", not a rejection.
  t.setRpc('memory.list', new Error('offline'));
  const empty = await t.panel.renderMemoryFacts(ul, head);
  assert.deepEqual(empty, []);
  t.restore();
});
