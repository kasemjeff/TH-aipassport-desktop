/**
 * The window's own logic, run without a browser.
 *
 * desktop/ui/app.js is a view over the backend — but the parts a user actually
 * touches (the slash palette, what Enter does, what a run sends) are pure
 * client-side logic, and a browser cannot be automated from a test run. So this
 * boots the real app.js against a minimal fake DOM and drives it: if the palette
 * stops filtering, or Enter stops sending, it fails here instead of in front of
 * somebody who just wanted to use the app.
 *
 * Run: node --test aipass-bridge/test/ui.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const APP_BASE = pathToFileURL(path.join(repo, 'desktop', 'ui', 'app.js')).href;

/* ------------------------------------------------------------------ the dom */

/** Enough of an element for app.js to build its screen and take input. */
class El {
  constructor(tag = 'div') {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.attrs = {};
    this.dataset = {};
    this.style = {};
    // The meter bar sizes itself with custom properties; the fake style object
    // has to accept them the way CSSStyleDeclaration does.
    this.style.setProperty = (name, value) => { this.style[name] = value; };
    this.className = '';
    this.value = '';
    this.handlers = {};
    this.checked = false;
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.id = '';
  }
  set textContent(v) { this._text = String(v); this.children = []; }
  get textContent() { return `${this._text ?? ''}${this.children.map((c) => c.textContent ?? '').join('')}`; }
  set innerHTML(v) { this._html = String(v); }
  get innerHTML() { return this._html; }
  // append() takes nodes and strings alike, exactly like the DOM.
  append(...kids) {
    for (const k of kids) {
      if (k && typeof k === 'object') k._parent = this;
      this.children.push(k);
    }
  }
  addEventListener(type, fn) { (this.handlers[type] ??= []).push(fn); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  focus() {}
  remove() { if (this._parent) this._parent.children = this._parent.children.filter((c) => c !== this); }
  /** Enough of Element.closest for the settings sheet to find its container. */
  closest(selector) {
    const want = selector.replace(/^\./, '');
    let node = this;
    while (node) {
      if ((node.className ?? '').split(/\s+/).includes(want)) return node;
      node = node._parent;
    }
    return null;
  }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  get selectedOptions() { return [this]; }
  /** A select's options are its children, as in a real one. */
  get options() { return this.children; }
  get classList() {
    const set = () => new Set(this.className.split(/\s+/).filter(Boolean));
    return {
      add: (c) => { this.className = [...set(), c].join(' '); },
      remove: (c) => { this.className = [...set()].filter((x) => x !== c).join(' '); },
      contains: (c) => set().has(c),
      toggle: (c, on) => { (on ?? !set().has(c)) ? this.classList.add(c) : this.classList.remove(c); },
    };
  }
  /** Type into it the way the browser would: run the handler for that event. */
  dispatch(type, ev = {}) {
    const merged = { ...ev, value: this.value, currentTarget: this, preventDefault() {} };
    for (const fn of this.handlers[type] ?? []) fn(merged);
    // `.onX = fn` is a property assignment, not a registration — the browser
    // fires both, and so does this.
    const inline = this[`on${type}`];
    if (typeof inline === 'function') inline(merged);
  }
  /** Enough of CSSStyleDeclaration for the meter bar to size itself. */
  setProperty(name, value) { (this.style ??= {})[name.replace(/^--/, '')] = value; }
}

/** Search a built tree for the element carrying an id, as document.getElementById would. */
const findById = (root, id) => {
  if (root.id === id) return root;
  for (const child of root.children ?? []) {
    const hit = findById(child, id);
    if (hit) return hit;
  }
  return null;
};

let boots = 0;

/**
 * Boot app.js against a fake DOM and a fake backend. Returns both halves.
 *
 * The cache is busted on purpose: app.js wires its handlers to the elements it
 * finds at import time, so a fresh import is the only way to get a fresh window.
 * AIPASS_HOME is set for the same reason: anything the harness writes on disk —
 * settings, sessions, plugins — must land in this test's scratch directory, not
 * in the real ~/.aipass of whoever is running the suite.
 */
async function bootApp(backend) {
  process.env.AIPASS_HOME = fs.mkdtempSync(path.join(tmpdir(), 'aipass-ui-'));

  const nodes = new Map();
  const node = (id) => { if (!nodes.has(id)) nodes.set(id, new El()); return nodes.get(id); };
  const calls = [];
  /** Every rpc with its params — some assertions need the payload, not the name. */
  const sent = [];
  const docHandlers = {};

  globalThis.document = {
    documentElement: { dataset: {} },
    createElement: (tag) => new El(tag),
    createTextNode: (text) => ({ textContent: String(text) }),
    getElementById: (id) => node(id),
    addEventListener: (type, fn) => { (docHandlers[type] ??= []).push(fn); },
    /** Fire a document-level event the way the browser would (paste, drop). */
    dispatch: (type, ev = {}) => { for (const fn of docHandlers[type] ?? []) fn(ev); },
    querySelectorAll: () => [],
  };
  globalThis.window = { prompt: () => null };
  globalThis.EventSource = class {
  constructor(url) { this.url = url; this.readyState = 1; this.handlers = {}; this.onerror = null; globalThis.__stream = this; }
  addEventListener(type, fn) { (this.handlers[type] ??= []).push(fn); }
  /** Fire an event the way the browser would. */
  emit(type, data) {
    globalThis.__lastEventAt = Date.now();
    for (const fn of this.handlers[type] ?? []) fn({ data: JSON.stringify(data) });
    if (type === 'message') this.onmessage?.({ data: JSON.stringify(data) });
  }
  close() {}
};
  globalThis.setInterval = () => 0; // the header refresher must not keep the process alive
  globalThis.fetch = async (_url, init = {}) => {
    const { method, params } = JSON.parse(init.body ?? '{}');
    calls.push(method);
    sent.push({ method, params });
    const result = backend[method]?.(params) ?? { ok: true };
    return { json: async () => ({ ok: true, result }) };
  };

  await import(`${APP_BASE}?boot=${++boots}`);
  const tick = () => new Promise((r) => setTimeout(r, 5));
  await tick(); await tick(); await tick(); // let the boot sequence finish
  return {
    node,
    calls,
    sent,
    tick,
    dispatch: (type, ev) => globalThis.document.dispatch(type, ev),
    /** The built screen, for everything app.js creates with an id at runtime. */
    screen: (id) => findById(node('log'), id) ?? node(id),
  };
}

const BACKEND = {
  status: () => ({ root: '/tmp/proj', bridge: true, extensions: 1, model: 'gemini-3.5-flash-lite', context: { used: 4800, budget: 24000, reserved: 4096, percent: 20, compactAt: 40, needsCompaction: false, entries: 6 }, running: false, mode: 'ask', plan: false, subagent: true, pending: [], projects: [{ path: '/tmp/proj', name: 'proj', current: true }], settings: {} }),
  'settings.get': () => ({
    // What the real backend returns: DEFAULTS merged with the file, so a field
    // the user never touched still has a value.
    defaultModel: 'gemini-3.5-flash-lite',
    mode: 'ask',
    allowRun: false,
    maxSteps: 10,
    maxToolCalls: 300,
    maxWallClockMs: 1_800_000,
    plan: false,
    requirePlanApproval: false,
    subagent: true,
    parallelHelpers: true,
    thinking: 'low',
    compaction: { contextTokens: 24000, reserveTokens: 4096, keepRecentBytes: 6000 },
    compactAtPercent: 40,
    skillsDirs: [],
    theme: 'dark',
    chatUrl: 'https://de.aipass.net/chat',
    autoOpenTab: true,
    uploads: null,
  }),
  'projects.list': () => [{ path: '/tmp/proj', name: 'proj', current: true }],
  'session.list': () => [{ id: 's1', title: 'one' }, { id: 's2', title: 'two' }],
  'session.new': () => ({ id: 's3', title: 'new' }),
  'session.open': () => [{ type: 'note', text: 'old note' }],
  'skills.list': () => [{ name: 'writing', file: 'skills/writing.md' }],
  'fs.list': () => [{ name: 'README.md', dir: false }],
  pending: () => [],
  'plugins.list': () => ({ dir: '~/.aipass/plugins', loaded: [], failed: [], tools: [], panels: [] }),
  models: () => ({ data: [{ id: 'm' }, { id: 'other' }] }),
  credits: () => ({ available: 42, limit: 100 }),
  'session.fork': () => ({ id: 's4', title: 'forked' }),
};

/* -------------------------------------------------------------------- tests */

test('typing "/" opens the palette and filters it as you type', async (t) => {
  const { node, tick } = await bootApp(BACKEND);
  await t.test('no palette before the first slash', () => {
    assert.equal(node('slash-list').children.length, 0, 'nothing to pick yet');
  });
  const task = node('task');
  task.value = '/m';
  task.dispatch('keydown', { key: 'm' });
  await tick();
  const shown = node('slash-list').children.map((li) => li.children[0].textContent);
  assert.deepEqual(shown, ['/model', '/models', '/mode'], 'commands sharing a prefix all show');
  assert.equal(node('slash').classList.contains('hidden'), false, 'palette stays visible while a command is typed');
});

test('a slash that matches nothing says so instead of vanishing', async () => {
  // The palette used to disappear on no match, which reads as "the / did
  // nothing". It now stays open and tells you, which is the same information a
  // user would get from a CLI.
  const { node, tick } = await bootApp(BACKEND);
  const task = node('task');
  task.value = '/zzz';
  task.dispatch('keydown', { key: 'z' });
  await tick();
  const rows = node('slash-list').children;
  assert.equal(rows.length, 1, 'one row: the "nothing matched" answer');
  assert.match(rows[0].textContent, /ไม่พบคำสั่ง/, 'and it names the problem');
  assert.equal(node('slash').classList.contains('hidden'), false, 'the palette stays put');
});

test('arrows move the selection, Enter picks it, and an argument asks for itself', async () => {
  const { node, calls, tick } = await bootApp(BACKEND);
  const task = node('task');
  task.value = '/m';
  task.dispatch('keydown', { key: 'm' });
  await tick();
  task.dispatch('keydown', { key: 'ArrowDown', preventDefault() {} });
  task.dispatch('keydown', { key: 'ArrowDown' });
  await tick();
  const list = node('slash-list').children;
  assert.equal(list.findIndex((li) => li.attrs['aria-selected'] === 'true'), 2, 'ArrowDown walks past /model and /models');
  task.dispatch('keydown', { key: 'Enter' });
  await tick();
  // /mode takes an argument, so it must leave a stub rather than guess one.
  assert.equal(task.value, '/mode ');
});

test('a whole command name beats a longer one that shares its prefix', async () => {
  // "/mode" matches /model too, because "mode" is a prefix of "model". Entering
  // a complete command must still select that command, not its longer cousin.
  const { node, tick } = await bootApp(BACKEND);
  const task = node('task');
  task.value = '/mode';
  task.dispatch('keydown', { key: 'Enter' });
  await tick();
  const list = node('slash-list').children;
  const selected = list.findIndex((li) => li.attrs['aria-selected'] === 'true');
  assert.equal(list[selected].children[0].textContent, '/mode');
  assert.equal(task.value, '/mode ', 'the stub names the command that was typed');
});

test('a command typed in full runs without the palette', async () => {
  const { node, calls, tick } = await bootApp(BACKEND);
  const task = node('task');
  task.value = '/mode auto';
  task.dispatch('keydown', { key: 'Enter' });
  await tick();
  assert.ok(calls.includes('settings.set'), 'mode is saved in settings, not just this run');
  assert.equal(node('mode').value, 'auto');
  assert.equal(task.value, '');
});

test('typing a model command reaches the backend', async () => {
  const { node, calls, tick } = await bootApp(BACKEND);
  const task = node('task');
  task.value = '/model gemini-3.5-flash-lite';
  task.dispatch('keydown', { key: 'Enter' });
  await tick();
  assert.ok(calls.includes('config.set'), 'model is pushed to the bridge');
});

test('an unknown command reports instead of sending a message', async () => {
  const { node, calls, tick } = await bootApp(BACKEND);
  const task = node('task');
  task.value = '/nosuchthing';
  task.dispatch('keydown', { key: 'Enter' });
  await tick();
  assert.equal(calls.includes('run'), false, 'never sent to the model');
  assert.equal(calls.includes('cancel'), false);
  assert.equal(task.value, '', 'the composer is cleared, not left stuck');
});

test('plain text sends a run and closes the palette', async () => {
  const { node, calls, tick } = await bootApp(BACKEND);
  const task = node('task');
  task.value = '/';
  task.dispatch('keydown', { key: '/' });
  await tick();
  assert.equal(node('slash').classList.contains('hidden'), false, 'palette opened for "/"');
  task.value = 'summarize the README';
  task.dispatch('input');
  await tick();
  assert.equal(node('slash').classList.contains('hidden'), true, 'palette closes when the slash is gone');
  task.dispatch('keydown', { key: 'Enter' });
  await tick();
  assert.ok(calls.includes('run'), 'Enter sends the message');
});

test('Shift+Enter is a newline, not a send', async () => {
  const { node, calls, tick } = await bootApp(BACKEND);
  const task = node('task');
  task.value = 'line one';
  task.dispatch('keydown', { key: 'Enter', shiftKey: true });
  await tick();
  assert.equal(calls.includes('run'), false);
});

test('/stop works while a turn is still running', async () => {
  // A run holds the window until it finishes, and the two commands you want
  // then — /stop and /status — used to be swallowed by the same guard.
  const hanging = { ...BACKEND, run: () => new Promise(() => {}) };
  const { node, calls, tick } = await bootApp(hanging);
  const task = node('task');
  task.value = 'a task that never finishes';
  task.dispatch('keydown', { key: 'Enter' });
  await tick();
  assert.ok(calls.includes('run'), 'the run started');

  task.value = '/stop';
  task.dispatch('keydown', { key: 'Enter' });
  await tick();
  assert.ok(calls.includes('cancel'), '/stop cancels even mid-run');

  task.value = '/status';
  task.dispatch('keydown', { key: 'Enter' });
  await tick();
  assert.equal(task.value, '', 'the composer was freed again');
});

test('the model list holds only models that can talk', async () => {
  // The bridge offers image, video and music models too; selecting one would
  // fail every run, so the dropdown is filtered and named for humans.
  const models = {
    status: () => ({ root: '/p', bridge: true, extensions: 1, model: 'gemini-3.8-flash', running: false, mode: 'ask', plan: false, pending: [], projects: [{ path: '/p', name: 'p', current: true }], settings: {} }),
    models: () => ({
      data: [
        { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', kind: 'chat' },
        { id: 'veo-3.1-fast-generate-001', name: 'Veo 3.1 Fast', kind: 'video' },
        { id: 'seedream-4.0', name: 'Seedream 4.0', kind: 'image' },
        { id: 'lyria-3-clip-preview', name: 'Lyria 3 Clip', kind: 'music' },
      ],
    }),
  };
  const { node } = await bootApp({ ...BACKEND, ...models });
  const select = node('model');
  const shown = select.children.map((c) => c.textContent);
  assert.deepEqual(shown, ['Gemini 3.8 Flash'], 'only the chat model is offered');
  assert.equal(select.children[0].value, 'gemini-3.8-flash', 'the id stays the value');
  assert.equal(select.children[0].title, 'gemini-3.8-flash', 'the id stays visible too');
  assert.equal(select.value, 'gemini-3.8-flash', 'the model in use is selected');
});

test('a model in use that the filter would drop stays visible', async () => {
  // If the saved model is not a chat model, hiding it would make the header lie
  // about which model runs. It is kept in the list instead.
  const models = {
    status: () => ({ root: '/p', bridge: true, extensions: 1, model: 'seedream-4.0', running: false, mode: 'ask', plan: false, pending: [], projects: [{ path: '/p', name: 'p', current: true }], settings: {} }),
    models: () => ({ data: [{ id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', kind: 'chat' }, { id: 'seedream-4.0', name: 'Seedream 4.0', kind: 'image' }] }),
  };
  const { node } = await bootApp({ ...BACKEND, ...models });
  const select = node('model');
  const shown = select.children.map((c) => c.textContent);
  assert.deepEqual(shown, ['Gemini 3.8 Flash', 'Seedream 4.0']);
  assert.equal(select.value, 'seedream-4.0', 'the header shows the model that will run');
});

test('a run that stops for want of steps offers the next move', async () => {
  // Three dead-end reports used to just say "stopped". A "carry on" button turns
  // the same event into a run.
  const { node, calls, tick } = await bootApp(BACKEND);
  globalThis.__stream.emit('step_limit', {});
  await tick();
  const row = node('log').children.find((c) => /continue-row/.test(c.className));
  assert.ok(row, 'the step limit row carries a way out');
  const on = row.children.find((c) => c.tagName === 'BUTTON');
  assert.ok(on, 'with a button');
  on.dispatch('click');
  await tick();
  assert.ok(calls.includes('run'), 'clicking it starts a run');
  assert.equal(node('log').children.some((c) => /continue-row/.test(c.className)), false, 'and the row is gone');
});

test('a compaction shows what the model carried over', async () => {
  const { node, tick } = await bootApp(BACKEND);
  globalThis.__stream.emit('compacted', { summary: 'read the bridge, changed nothing, still to do: tests' });
  await tick();
  const card = node('log').children.find((c) => /compaction-card/.test(c.className));
  assert.ok(card, 'the summary is shown in the conversation');
  assert.match(card.textContent, /still to do: tests/);
});

test('thinking streams into an open fold that closes when the turn ends', async () => {
  // The model's reasoning is its own channel: a box you can watch while it
  // thinks, which folds itself away and leaves one line when the turn ends —
  // so the thinking never reads as the answer.
  const { node, tick } = await bootApp(BACKEND);
  globalThis.__stream.emit('reasoning_delta', { text: '**Solving the Riddle**\n' });
  await tick();
  const box = node('log').children.find((c) => c.tagName === 'DETAILS' && /think/.test(c.className));
  assert.ok(box, 'the reasoning box appears with the first delta');
  assert.equal(box.open, true, 'open while it is still thinking');
  assert.match(box.textContent, /Solving the Riddle/);

  globalThis.__stream.emit('finished', { summary: 'done', stopReason: 'done', spent: 1, credits: { available: 99, limit: 100 } });
  await tick();
  assert.equal(box.open, false, 'folded away when the turn ends');
  assert.match(box.textContent, /reasoning · \d+s/, 'and the summary says it happened');
});

test('a run with no chat tab gets a banner with a one-click fix', async () => {
  const { node, calls, tick } = await bootApp(BACKEND);
  globalThis.__stream.emit('needs_tab', { url: 'https://de.aipass.net/chat' });
  await tick();
  const bar = node('log').children.find((c) => /needs-tab/.test(c.className));
  assert.ok(bar, 'the banner appears');
  const open = bar.children.find((c) => c.tagName === 'BUTTON');
  assert.ok(open, 'with the fix attached');
  open.dispatch('click');
  await tick();
  assert.ok(calls.includes('browser.open'), 'clicking it opens the tab');
});

test('a finished run releases the composer', async () => {
  const { node, tick } = await bootApp(BACKEND);
  node('task').value = 'work';
  node('task').dispatch('keydown', { key: 'Enter' });
  await tick();
  assert.equal(node('send').textContent, 'หยุด', 'the button becomes stop while running');
  globalThis.__stream.emit('finished', { summary: 'done', stopReason: 'done', spent: 3, credits: { available: 99, limit: 100 } });
  await tick();
  assert.equal(node('send').textContent, 'ส่ง', 'and send again when the run ends');
});

test('the apply panel carries the run’s check verdict', async () => {
  // The person clicks Apply on this panel: if the run's changes never passed a
  // check — the check said fail, nothing checked them, no RUN was allowed —
  // the panel has to say so before the write, not after.
  const changes = [{ file: 'a.mjs', added: 2, removed: 1, deleted: false, isNew: false }];
  let pendingNow = changes;
  const { node, tick } = await bootApp({ ...BACKEND, pending: () => pendingNow });
  const done = (extra) => {
    globalThis.__stream.emit('finished', { summary: 'done', stopReason: 'done', changes, ...extra });
  };

  done({ check: { verdict: 'fail', text: 'boom' } });
  await tick(); await tick(); await tick();
  const badge = node('pending-check');
  assert.match(badge.textContent, /ตรวจไม่ผ่าน/, 'a failed check is worn on the panel');
  assert.equal(badge.classList.contains('hidden'), false);

  done({});
  await tick(); await tick(); await tick();
  assert.match(badge.textContent, /ยังไม่ผ่านการตรวจ/, 'no check at all reads as unverified');

  done({ check: { verdict: 'pass' } });
  await tick(); await tick(); await tick();
  assert.match(badge.textContent, /ตรวจผ่าน/, 'a passing check reads pass');

  pendingNow = [];
  done({ check: { verdict: 'pass' } });
  await tick(); await tick(); await tick();
  assert.equal(badge.classList.contains('hidden'), true, 'nothing pending, nothing to say');
});

test('a typed draft survives a reload', async () => {
  // The composer keeps what you typed in the window's own storage, so a stray
  // reload does not cost the paragraph.
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  const { node, tick } = await bootApp(BACKEND);
  node('task').value = 'a paragraph worth keeping';
  node('task').dispatch('input');
  assert.equal(store.get('aipass.draft'), 'a paragraph worth keeping', 'the draft is stored as you type');
  void tick;
});

test('the session list filters as you type', async () => {
  // 99 sessions on the machine this was written on; a list with no filter is a
  // list nobody scrolls.
  const { node, tick } = await bootApp({
    ...BACKEND,
    'session.list': () => [
      { id: 'aaa', title: 'สรุป README', updated: Date.UTC(2026, 9, 10) },
      { id: 'bbb', title: 'แก้บั๊ก UI', updated: Date.UTC(2026, 9, 9) },
      { id: 'ccc', title: 'วางแผนสปรินต์', updated: Date.UTC(2026, 9, 8) },
    ],
  });
  await tick(); await tick();
  assert.equal(node('sessions').children.length, 3, 'every session is listed');
  node('session-filter').value = 'UI';
  node('session-filter').dispatch('input');
  await tick(); await tick();
  assert.equal(node('sessions').children.length, 1, 'the filter narrows it');
  assert.match(node('sessions').children[0].textContent, /UI/);

  node('session-filter').value = 'ไม่มีอะไรตรง';
  node('session-filter').dispatch('input');
  await tick(); await tick();
  assert.match(node('sessions').textContent, /ไม่พบบทสนทนา/, 'and says so when nothing matches');
});

test('the file panel walks into folders and attaches a file', async () => {
  // The panel listed one directory and stopped: a folder was a dead click.
  const { node, calls, tick } = await bootApp({
    ...BACKEND,
    'fs.list': (params) => (params.dir === '.' ? [{ name: 'docs', dir: true }, { name: 'README.md', dir: false }]
      : [{ name: 'guide.md', dir: false }]),
    'attachment.stage': () => ({ id: 'att1', name: 'guide.md', bytes: 12, mime: 'text/markdown' }),
  });
  await tick(); await tick(); await tick();
  const rows = node('files').children.map((li) => li.textContent);
  assert.ok(rows.some((t) => t.includes('docs/')), 'folders are listed, marked as folders');

  const folder = node('files').children.find((li) => li.textContent.includes('docs/'));
  folder.dispatch('click');
  await tick(); await tick();
  assert.ok(calls.some((c) => c === 'fs.list'), 'clicking a folder asks for its contents');
  assert.equal(node('files-head').textContent, 'docs', 'and the header shows where you are');
  assert.ok(node('files').children.some((li) => li.textContent.includes('guide.md')), 'with the files inside');

  const file = node('files').children.find((li) => li.textContent.includes('guide.md'));
  const attach = file.children.find((c) => c.tagName === 'BUTTON' && c.textContent === 'แนบ');
  assert.ok(attach, 'a file row carries an attach button');
  attach.dispatch('click');
  await tick(); await tick();
  assert.ok(calls.includes('attachment.stage'), 'clicking it stages the file');
  assert.match(node('log').textContent, /แนบแล้ว: guide\.md/);
});

test('an apply refreshes the file panel, so the new file is on screen', async () => {
  // The panel is a listing from a moment ago; a just-applied file used to stay
  // invisible until somebody reloaded the window or walked out of the folder.
  let entries = [{ name: 'desktop', dir: true }];
  const { node, tick } = await bootApp({ ...BACKEND, 'fs.list': () => entries });
  await tick(); await tick(); await tick();
  assert.ok(!node('files').children.some((li) => li.textContent.includes('overview.md')), 'nothing there before the apply');

  entries = [{ name: 'desktop', dir: true }, { name: 'overview.md', dir: false }];
  globalThis.__stream.emit('applied', { written: 1, deleted: 0, files: ['overview.md'] });
  await tick(); await tick(); await tick();
  assert.ok(node('files').children.some((li) => li.textContent.includes('overview.md')), 'and it is listed right after the apply');
});

test('the saved theme is applied when the window boots', async () => {
  // A theme setting that only takes effect after you open the settings sheet is
  // a setting that lies on every reload.
  await bootApp({ ...BACKEND, 'settings.get': () => ({ ...BACKEND['settings.get'](), theme: 'light' }) });
  assert.equal(globalThis.document.documentElement.dataset.theme, 'light');
});

test('the header dropdowns save what you pick', async () => {
  // Both of them lost their wiring once during a rewrite: the header showed the
  // new value and forgot it on the next start.
  const { node, calls, tick } = await bootApp(BACKEND);
  node('mode').value = 'auto';
  node('mode').dispatch('change');
  await tick();
  assert.ok(calls.includes('settings.set'), 'mode goes to settings, so it persists');

  node('model').value = 'some-other-model';
  node('model').dispatch('change');
  await tick();
  assert.ok(calls.includes('config.set'), 'model goes to the bridge');
});

test('the effort level is picked in the composer, not buried in settings', async () => {
  // How hard the model thinks is a per-message decision, so it lives next to
  // the model chip instead of three clicks into the settings sheet.
  const { node, sent, tick } = await bootApp(BACKEND);
  assert.equal(node('thinking').value, 'low', 'the chip boots at the saved level');

  node('thinking').value = 'high';
  node('thinking').dispatch('change');
  await tick();
  assert.deepEqual(sent.at(-1), { method: 'settings.set', params: { thinking: 'high' } }, 'a pick is written through right away');

  // And the sheet that used to ask for it no longer does.
  node('settings-btn').dispatch('click');
  await tick(); await tick(); await tick();
  assert.equal(/thinking level/.test(node('modal-body').textContent), false, 'the sheet does not ask for the effort anymore');
});

test('shift+tab cycles ask, auto and plan — and writes each through', async () => {
  // The mode is the one control worth its own key: it decides what the next
  // run may do, and "just edit it" lived in chat before.
  const { node, sent, tick } = await bootApp(BACKEND);
  assert.equal(node('mode').value, 'ask', 'the window starts where the settings say');

  node('task').dispatch('keydown', { key: 'Tab', shiftKey: true });
  await tick();
  assert.equal(node('mode').value, 'auto', 'one press: it may edit');
  assert.deepEqual(sent.at(-1), { method: 'settings.set', params: { mode: 'auto', plan: false, requirePlanApproval: false } }, 'and the backend is told, plan flags and all');

  node('task').dispatch('keydown', { key: 'Tab', shiftKey: true });
  await tick();
  assert.equal(node('mode').value, 'plan', 'two presses: plan first');
  assert.deepEqual(sent.at(-1).params, { mode: 'auto', plan: true, requirePlanApproval: true }, 'plan runs under auto once the plan is approved');

  node('task').dispatch('keydown', { key: 'Tab', shiftKey: true });
  await tick();
  assert.equal(node('mode').value, 'ask', 'three presses: back to square one');
});

test('a plan-mode run sends a real permission mode, not the view name', async () => {
  // The select shows 'plan'; the engine only knows ask/auto/yolo.
  const { node, sent, tick } = await bootApp({
    ...BACKEND,
    'settings.get': () => ({ ...BACKEND['settings.get'](), mode: 'auto', plan: true, requirePlanApproval: true }),
  });
  assert.equal(node('mode').value, 'plan', 'a saved plan mode boots as the plan view');

  node('task').value = 'จัดบ้านให้หน่อย';
  node('task').dispatch('keydown', { key: 'Enter' });
  await tick();
  const run = [...sent].reverse().find((c) => c.method === 'run');
  assert.ok(run, 'the task went out');
  assert.equal(run.params.mode, 'auto', 'under the hood it is auto');
  assert.equal(run.params.task, 'จัดบ้านให้หน่อย');
});

test('a plan gate opens the approve modal, and both answers reach the backend', async () => {
  // The backend stops the run and emits plan_request; the window is the only
  // thing that can answer it. The modal used to exist without a test — the
  // run then waited for an answer nobody could give.
  const { node, sent, tick } = await bootApp(BACKEND);
  await tick();

  globalThis.__stream.emit('plan_request', {});
  await tick();
  assert.equal(node('modal-title').textContent, 'start this plan?');
  assert.equal(node('modal').classList.contains('hidden'), false, 'the gate is on screen');

  node('modal-actions').children[1].dispatch('click'); // approve
  await tick();
  assert.deepEqual(sent.at(-1), { method: 'plan.answer', params: { ok: true } }, 'approve goes to the backend');
  assert.equal(node('modal').classList.contains('hidden'), true, 'and the gate closes');

  globalThis.__stream.emit('plan_request', {});
  await tick();
  node('modal-actions').children[0].dispatch('click'); // decline
  await tick();
  assert.deepEqual(sent.at(-1), { method: 'plan.answer', params: { ok: false } }, 'decline goes too');
});

test('/plan turns plan mode on together with the approval gate', async () => {
  // One concept, two flags: a plan that drafts but never waits was the state
  // /plan used to leave behind. The header view has to agree, too.
  let saved = { ...BACKEND['settings.get']() };
  const { node, sent, tick } = await bootApp({
    ...BACKEND,
    'settings.get': () => saved,
    'settings.set': (params) => { saved = { ...saved, ...params }; return saved; },
  });
  const task = node('task');

  task.value = '/plan';
  task.dispatch('keydown', { key: 'Enter' });
  await tick(); await tick();
  assert.deepEqual(sent.at(-1), { method: 'settings.set', params: { plan: true, requirePlanApproval: true } }, 'both flags move together');
  assert.equal(node('mode').value, 'plan', 'and the header shows the plan view');

  task.value = '/plan';
  task.dispatch('keydown', { key: 'Enter' });
  await tick(); await tick();
  assert.deepEqual(sent.at(-1).params, { plan: false, requirePlanApproval: false }, 'off moves both back');
  assert.equal(node('mode').value, 'ask', 'and the header leaves the plan view');
});

test('the context meter reports a budget and a trigger', async () => {
  const { node } = await bootApp(BACKEND);
  const ctx = node('context');
  assert.equal(ctx.classList.contains('hidden'), false, 'the meter is shown');
  assert.match(ctx.textContent, /context \d+%/, 'and it names itself');
  assert.ok(ctx.title.includes('/compact'), 'and says what happens at the limit');
});

test('the settings sheet shows its categories and saves once', async () => {
  const { node, calls, tick } = await bootApp(BACKEND);
  node('settings-btn').dispatch('click');
  await tick(); await tick(); await tick();

  const body = node('modal-body');
  // A wrapper holding a rail of categories on the left and one page of settings
  // per category on the right.
  const shell = body.children.find((c) => /settings/.test(c.className));
  assert.ok(shell, 'the sheet builds its shell');
  const rail = shell.children.find((c) => /settings-nav/.test(c.className));
  assert.ok(rail, 'the sheet has a category rail');
  const tabs = rail.children.map((b) => b.textContent);
  assert.ok(tabs.length >= 4, `at least four categories, got ${tabs.length}`);
  const pages = shell.children.find((c) => /settings-pages/.test(c.className));
  assert.ok(pages, 'and one page per category');
  assert.equal(node('modal').classList.contains('settings-sheet'), true, 'the sheet is marked');

  // Switching a category shows its page and only its page.
  const pluginTab = rail.children.find((b) => /plugins|ปลั๋กอิน/.test(b.textContent));
  if (pluginTab) {
    pluginTab.dispatch('click');
    await tick();
    const active = pages.children.filter((p) => p.classList.contains('active'));
    assert.equal(active.length, 1, 'exactly one page is shown');
    assert.match(active[0].textContent, /plugins|ปลั๋กอิน/);
  }

  // Save as-is: the defaults are valid, so the whole path runs and writes once.
  const save = node('modal-actions').children.find((b) => /save|บันทึก/.test(b.textContent));
  assert.ok(save, 'a save button exists');
  save.dispatch('click');
  await tick(); await tick();
  assert.equal(calls.filter((c) => c === 'settings.set').length, 1, 'one write for one save');

  // A step limit of zero is refused, with the reason on screen and no write.
  node('settings-btn').dispatch('click');
  await tick(); await tick();
  // The control is on whichever page owns it, however deep that page nests
  // it, so walk the whole sheet rather than assuming a shape.
  const inputs = [];
  const walk = (n) => {
    if (n.tagName === 'INPUT' || n.tagName === 'SELECT' || n.tagName === 'TEXTAREA') inputs.push(n);
    for (const c of n.children ?? []) walk(c);
  };
  walk(node('modal-body'));
  const zeros = inputs.filter((n) => n.type === 'number' && String(n.value) === '10');
  assert.ok(zeros.length, 'the step limit control is found by its value');
  zeros[0].value = '0';
  zeros[0].onchange({ target: zeros[0] });
  const saveAgain = node('modal-actions').children.find((b) => /save|บันทึก/.test(b.textContent));
  saveAgain.dispatch('click');
  await tick(); await tick();
  assert.equal(calls.filter((c) => c === 'settings.set').length, 1, 'the bad edit never reaches disk');
  const error = node('modal-body').children.find((c) => /settings-error/.test(c.className));
  assert.ok(error && !error.classList.contains('hidden'), 'and the sheet explains why');
  assert.match(error.textContent, /step/, 'naming the field');
});

test('the welcome card explains the app and shows what is missing', async () => {
  const { screen } = await bootApp(BACKEND);
  const card = screen('welcome');
  assert.ok(card, 'an empty screen must not be an empty screen');
  const text = card.textContent;
  assert.match(text, /de\.aipass\.net/, 'it names the site it bridges to');
  assert.match(text, /ตัวกลาง/, 'and says the local bridge is one of the three things it needs');
  assert.match(text, /ที่ล็อกอินอยู่/, 'and that a logged-in tab is another');
  assert.match(text, /พิมพ์ข้อความลงข้างล่าง|ข้างล่าง/, 'and tells you to type');
});

test('every command in the palette has a handler that resolves', async () => {
  const { node, calls, tick } = await bootApp(BACKEND);
  const task = node('task');
  // Exercise the whole list the way a user would: type each one and send it.
  const names = ['/help', '/status', '/new', '/resume', '/fork', '/plan', '/skills', '/diff', '/discard', '/project', '/settings', '/stop', '/models', '/conversations', '/fresh'];
  for (const name of names) {
    task.value = name;
    task.dispatch('keydown', { key: 'Enter' });
    await tick();
    assert.equal(task.value, '', `${name} cleared the composer`);
  }
  // The ones that take arguments must not fire on an empty one.
  for (const name of ['/model', '/mode', '/open', '/file', '/image']) {
    task.value = name;
    task.dispatch('keydown', { key: 'Enter' });
    await tick();
    assert.equal(task.value.length > name.length, true, `${name} asks for its argument`);
  }
  // The clipboard reader acts on its own, with nothing typed after it.
  task.value = '/clip';
  task.dispatch('keydown', { key: 'Enter' });
  await tick();
  assert.equal(task.value, '', '/clip needs no argument');
  // The conversation commands reach the backend, not just the UI.
  assert.ok(calls.includes('conversation.new'), '/fresh creates a bridge conversation');
});

test('pasting an image attaches it', async () => {
  // A screenshot is one keystroke away in a desktop app; paste is the gesture
  // people try first, and it used to do nothing.
  const { dispatch, node, tick } = await bootApp(BACKEND);
  globalThis.FileReader = class {
    readAsDataURL() { this.result = 'data:image/png;base64,AAAA'; this.onload(); }
  };
  const staged = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init = {}) => {
    const { method, params } = JSON.parse(init.body ?? '{}');
    if (method === 'attachment.stage') {
      staged.push(params.name);
      return { json: async () => ({ ok: true, result: { id: 'a1', name: params.name, bytes: 4, mime: 'image/png' } }) };
    }
    return realFetch(_url, init);
  };
  dispatch('paste', { clipboardData: { files: [{ name: 'screenshot.png', type: 'image/png' }] }, preventDefault() {} });
  await tick(); await tick();
  assert.deepEqual(staged, ['screenshot.png'], 'the pasted file is staged');
  assert.equal(node('attachments').classList.contains('hidden'), false, 'the attachment strip opens');
});

/* ------------------------------------------------- the transcript */

test('the bubble holds the prose, never the wire — calls live in their rows', async () => {
  const { node, tick } = await bootApp(BACKEND);
  globalThis.__stream.emit('assistant_delta', { text: 'I checked the file.\nEDIT notes.md\nFIND\nline two\nNEW\nline 2\nEND\nLooks right.' });
  await tick();
  const bubble = node('log').children.find((c) => c.className.includes('assistant'));
  const html = bubble.children[0].innerHTML;
  assert.match(html, /I checked the file\./, 'the prose before the block is there');
  assert.match(html, /Looks right\./, 'and so is the prose after it');
  assert.equal(/EDIT|FIND|NEW|END/.test(html), false, 'no raw marker survives in the bubble');
  assert.equal(/line 2/.test(html), false, 'the block body is wire, not prose');

  globalThis.__stream.emit('tool', { kind: 'replace', arg: 'notes.md', ok: true, head: '2 lines → 2 lines' });
  await tick();
  const row = node('log').children.find((c) => c.className.includes('tool'));
  assert.ok(row, 'the call has its own row');
  assert.match(row.textContent, /⏺/);
  assert.match(row.textContent, /Edit/, 'labelled with the verb, not the wire kind');
  assert.match(row.textContent, /notes\.md/);
});

test('each step gets its own bubble, so rows sit under the step that made them', async () => {
  const { node, tick } = await bootApp(BACKEND);
  globalThis.__stream.emit('assistant_delta', { text: 'first step prose' });
  globalThis.__stream.emit('step', { step: 1, maxSteps: 10, elapsed: '1.2' });
  globalThis.__stream.emit('tool', { kind: 'read', arg: 'a.txt', ok: true, head: '3 lines' });
  globalThis.__stream.emit('assistant_delta', { text: 'second step prose' });
  await tick();
  const kids = node('log').children;
  const bubbles = kids.filter((c) => c.className.includes('assistant'));
  assert.equal(bubbles.length, 2, 'one bubble per step');
  assert.match(bubbles[0].children[0].innerHTML, /first step prose/);
  assert.match(bubbles[1].children[0].innerHTML, /second step prose/);
  const firstAt = kids.findIndex((c) => c.className.includes('assistant'));
  const rowAt = kids.findIndex((c) => c.className.includes('tool'));
  const lastAt = kids.map((c) => c.className.includes('assistant')).lastIndexOf(true);
  assert.ok(firstAt < rowAt && rowAt < lastAt, 'order on screen: prose, its rows, the next step');
});

test('a DONE is said once — streamed prose and the harvested summary never double', async () => {
  const { node, tick } = await bootApp(BACKEND);
  globalThis.__stream.emit('assistant_delta', { text: 'Wired it up.\nDONE wired the widget' });
  globalThis.__stream.emit('done_line', { text: 'wired the widget' });
  await tick();
  const first = node('log').children.find((c) => c.className.includes('assistant'));
  const html = first.children[0].innerHTML;
  const count = (needle) => html.split(needle).length - 1;
  assert.equal(count('Wired it up.'), 1, 'prose once');
  assert.equal(count('wired the widget'), 1, 'the summary once');
  assert.equal(/DONE/.test(html), false, 'the marker word never renders');

  // When the DONE carried no sentence of its own, the prose above it is the
  // summary — appending it again would say the same thing twice.
  globalThis.__stream.emit('assistant_delta', { text: 'All clear.\nDONE' });
  globalThis.__stream.emit('done_line', { text: 'All clear.' });
  await tick();
  const second = node('log').children.filter((c) => c.className.includes('assistant')).at(-1);
  assert.equal(second.children[0].innerHTML.split('All clear.').length - 1, 1, 'not doubled');

  // A bare DONE with no prose above it still leaves the reader something.
  globalThis.__stream.emit('assistant_delta', { text: 'DONE fixed the bug' });
  globalThis.__stream.emit('done_line', { text: 'fixed the bug' });
  await tick();
  const third = node('log').children.filter((c) => c.className.includes('assistant')).at(-1);
  assert.match(third.children[0].innerHTML, /fixed the bug/);
});

test('opening a session replays prose without markers, DONE summary included', async () => {
  const backend = {
    ...BACKEND,
    'session.open': () => [
      { type: 'task', text: 'look at things' },
      { type: 'assistant', text: 'Read the file.\nNEED file a.txt' },
      { type: 'tool', kind: 'read', arg: 'a.txt', ok: true },
      { type: 'assistant', text: 'All clear.\nDONE read it all' },
    ],
  };
  const { node, tick } = await bootApp(backend);
  await tick();
  node('sessions').children[0].dispatch('click');
  await tick(); await tick();
  const bodies = node('log').children
    .filter((c) => c.className.includes('assistant'))
    .map((c) => c.children[0].innerHTML);
  assert.equal(bodies.length, 2, 'one bubble per replayed reply');
  assert.match(bodies[0], /Read the file\./);
  assert.equal(/NEED|DONE/.test(bodies[0]), false, 'no raw wire in the replay');
  assert.match(bodies[1], /All clear\./);
  assert.match(bodies[1], /read it all/, 'the DONE summary survived the round trip');
});

test('a plugin marker the backend reports is hidden too', async () => {
  const backend = {
    ...BACKEND,
    'plugins.list': () => ({ dir: '', loaded: [], failed: [], tools: ['ECHO'], toolDefs: [{ marker: 'ECHO', takesBody: false }], panels: [] }),
  };
  const { node, tick } = await bootApp(backend);
  await tick();
  globalThis.__stream.emit('assistant_delta', { text: 'Echoing now.\nECHO hello there\nThat is all.' });
  await tick();
  const bubble = node('log').children.find((c) => c.className.includes('assistant'));
  const html = bubble.children[0].innerHTML;
  assert.match(html, /Echoing now\./);
  assert.match(html, /That is all\./);
  assert.equal(/ECHO hello there/.test(html), false, 'the plugin call is a row, not prose');
});

test('repainting a plugin panel replaces its body instead of stacking copies', async () => {
  // The finished event repaints every panel after every run. The old repaint
  // appended one more body each time — the scratchpad grew a second copy of
  // its history in the sidebar per run.
  let note = 'note one';
  const { node, tick } = await bootApp({
    ...BACKEND,
    'plugins.list': () => ({ dir: '', loaded: [], failed: [], tools: [], panels: [{ id: 'notes', title: 'scratchpad' }] }),
    'panel.render': () => ({ html: `<ul><li>${note}</li></ul>` }),
  });
  const holder = node('plugin-panels');
  const box = holder.children.find((c) => c.dataset.panel === 'notes');
  assert.ok(box, 'the panel is in the sidebar');
  assert.equal(box.children.length, 2, 'one title row and one rendered body');
  assert.match(box.children[1].innerHTML, /note one/);

  note = 'note two';
  globalThis.__stream.emit('finished', { summary: '', stopReason: 'done', spent: 0, credits: null });
  await tick(); await tick(); await tick();
  assert.equal(box.children.length, 2, 'the repaint replaces the body, it does not add one');
  assert.match(box.children[1].innerHTML, /note two/, 'and the body is the fresh render');
});

/* ------------------------------------------------- the chrome */

test('the theme button flips the window and remembers', async () => {
  const { node, sent, tick } = await bootApp(BACKEND);
  assert.equal(globalThis.document.documentElement.dataset.theme, 'dark', 'the saved theme boots first');
  node('theme-toggle').dispatch('click');
  await tick();
  assert.equal(globalThis.document.documentElement.dataset.theme, 'light');
  assert.deepEqual(sent.at(-1), { method: 'settings.set', params: { theme: 'light' } }, 'the choice is written through');
  node('theme-toggle').dispatch('click');
  await tick();
  assert.equal(globalThis.document.documentElement.dataset.theme, 'dark');
});

test('the New Conversation line starts a session like the button above it', async () => {
  const { node, calls, tick } = await bootApp(BACKEND);
  const before = calls.length;
  node('new-conv').dispatch('click');
  await tick();
  assert.ok(calls.slice(before).includes('session.new'), 'the line does what it says');
});
