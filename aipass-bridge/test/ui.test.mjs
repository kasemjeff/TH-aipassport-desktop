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
import { restoreTable } from '../harness/waf.mjs';

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
  set innerHTML(v) { this._html = String(v); this.htmlWrites = (this.htmlWrites ?? 0) + 1; }
  get innerHTML() { return this._html; }
  /** The DOM appends markup without re-parsing what is already there. */
  insertAdjacentHTML(_pos, html) {
    this._html = `${this._html ?? ''}${html}`;
    this.insertions = (this.insertions ?? 0) + 1;
  }
  // append() takes nodes and strings alike, exactly like the DOM — and moves a
  // node that already lives somewhere, exactly like the DOM.
  append(...kids) {
    for (const k of kids) {
      if (k && typeof k === 'object') {
        if (k._parent && k._parent !== this) k._parent.children = k._parent.children.filter((c) => c !== k);
        k._parent = this;
      }
      this.children.push(k);
    }
  }
  insertBefore(node, ref) {
    if (node && typeof node === 'object') {
      if (node._parent && node._parent !== this) node._parent.children = node._parent.children.filter((c) => c !== node);
      node._parent = this;
    }
    const at = ref ? this.children.indexOf(ref) : -1;
    if (at < 0) this.children.push(node);
    else this.children.splice(at, 0, node);
  }
  addEventListener(type, fn) { (this.handlers[type] ??= []).push(fn); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  removeAttribute(k) { delete this.attrs[k]; }
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
    // `target` is the element the event happened on and it stays that one
    // while the event bubbles; `currentTarget` is whoever is handling it.
    const merged = {
      ...ev,
      value: this.value,
      currentTarget: this,
      target: this,
      defaultPrevented: false,
      preventDefault() { merged.defaultPrevented = true; },
      stopPropagation() { merged.stopped = true; },
    };
    this.lastEvent = merged;
    const fire = (node) => {
      for (const fn of node.handlers[type] ?? []) fn(merged);
      // `.onX = fn` is a property assignment, not a registration — the browser
      // fires both, and so does this.
      const inline = node[`on${type}`];
      if (typeof inline === 'function') inline(merged);
    };
    fire(this);
    // The DOM bubbles: the event walks up the tree until something stops it.
    if (merged.stopped) return;
    for (let node = this._parent; node; node = node._parent) {
      fire(node);
      if (merged.stopped) return;
    }
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

/** A bubble's rendered answer, across both paint segments (settled + tail).
 *  app.js paints those as two elements so a streaming answer stops re-parsing
 *  its own finished prefix; the fake DOM keeps innerHTML as a string, so the
 *  text is read there — joined, because where the split falls is not the
 *  contract, what the reader sees is. */
const bubbleHtml = (msg) => (msg?.children?.[0]?.children ?? [])
  .map((seg) => seg.innerHTML ?? '')
  .filter(Boolean)
  .join('\n');

/** Past the filter's debounce: the list is rebuilt a moment after the last key. */
const settle = async () => {
  await new Promise((r) => setTimeout(r, 260));
  await new Promise((r) => setTimeout(r, 5));
};

/**
 * The rows of the history, without the group heads between them.
 *
 * The list groups its rows by day, and a group head is a label — not a
 * session. A test that wants "the first session" wants the first ROW.
 */
const sessionRows = (list) => list.children.filter((li) => !(li.className ?? '').split(/\s+/).includes('day-head'));

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
async function bootApp(backend, { token = null, unauthorizedOnce = false } = {}) {
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
    activeElement: null,
  };
  // The system theme, and the listeners the window registers on it. A window
  // whose theme is "auto" has to follow the machine when it changes its mind.
  const media = { light: false, listeners: new Set() };
  globalThis.window = {
    prompt: () => null,
    // The destructive paths ask first: "ลบได้ไหม" — a test that clicks one
    // of them needs the browser's answer, and the answer a test wants is yes.
    confirm: () => true,
    matchMedia: (query) => ({
      get matches() { return query.includes('light') ? media.light : !media.light; },
      addEventListener: (_type, fn) => media.listeners.add(fn),
      removeEventListener: (_type, fn) => media.listeners.delete(fn),
    }),
  };
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
  // The page's own address. A window that reloads itself — after an update,
  // so the new window files are the ones on screen — asks the browser to do
  // it, and the fake records that it was asked rather than doing it.
  let reloaded = 0;
    globalThis.location = { reload: () => { reloaded += 1; } };
  // The intervals are recorded but never scheduled: the header refresher must
  // not keep the process alive. A test can still see that one was cleared —
  // which is the difference between a timer that dies with its sheet and one
  // that polls the backend forever.
  const intervals = new Map();
  let intervalId = 0;
  globalThis.setInterval = (fn) => { const id = ++intervalId; intervals.set(id, fn); return id; };
  globalThis.clearInterval = (id) => { intervals.delete(id); };
  const shots = []; // { url, headers } — what the token wiring rides on
  // A backend that answers the first call with a 401, the way one does when
  // the token on disk is not the one it minted: the window fetches the token
  // again and retries.
  let unauthorizedLeft = unauthorizedOnce;
  let tokenFetches = 0;
  globalThis.fetch = async (_url, init = {}) => {
    if (String(_url).endsWith('/token')) {
      tokenFetches += 1;
      const value = tokenFetches > 1 ? 'tok-new' : token;
      return value ? { ok: true, json: async () => ({ ok: true, token: value }) } : { json: async () => ({}) };
    }
    const { method, params } = JSON.parse(init.body ?? '{}');
    calls.push(method);
    sent.push({ method, params });
    shots.push({ url: String(_url), headers: { ...(init.headers ?? {}) } });
    if (unauthorizedLeft) {
      unauthorizedLeft = false;
      return { status: 401, json: async () => ({ ok: false, error: 'unauthorized' }) };
    }
    try {
      const result = backend[method]?.(params) ?? { ok: true };
      return { json: async () => ({ ok: true, result }) };
    } catch (err) {
      // A method that throws is the RPC layer's catch: the same shape the real
      // backend answers a refusal with, so the window's error path is the one
      // under test.
      return { json: async () => ({ ok: false, error: String(err.message ?? err), ...(err.stage ? { stage: err.stage } : {}) }) };
    }
  };

  await import(`${APP_BASE}?boot=${++boots}`);
  const tick = () => new Promise((r) => setTimeout(r, 5));
  await tick(); await tick(); await tick(); // let the boot sequence finish
  return {
    node,
    calls,
    sent,
    shots,
    streamUrl: () => globalThis.__stream?.url,
    tick,
    /** The intervals the window is holding right now. */
    timers: intervals,
    /** The system's idea of light or dark, and a way to change its mind. */
    system: {
      get light() { return media.light; },
      set light(v) {
        media.light = v;
        // The DOM snapshots the listener list when it dispatches, so a
        // listener that re-registers itself is not called again by the same
        // event.
        for (const fn of [...media.listeners]) fn({ matches: v });
      },
    },
    dispatch: (type, ev) => globalThis.document.dispatch(type, ev),
    /** How many times the window asked the browser to reload the page. */
    get reloaded() { return reloaded; },
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
    temperature: null,
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
  'providers.list': () => ({
    providers: [
      { id: 'aipass', label: 'AiPASS (de.aipass.net)', kind: 'aipass', baseUrl: '', hasKey: true, builtin: true, models: [] },
      { id: 'openai', label: 'OpenAI', kind: 'openai', baseUrl: 'https://api.openai.com/v1', apiKeyEnv: 'OPENAI_API_KEY', hasKey: false, models: ['gpt-4o'] },
    ],
    active: 'aipass',
  }),
  credits: () => ({ available: 42, limit: 100 }),
  'session.fork': () => ({ id: 's4', title: 'forked' }),
  // The restore table the window asks for at boot: the rules that put the
  // wire spellings back, so a URL the model wrote is a URL the reader sees.
  'waf.table': () => ({ pairs: restoreTable() }),
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
  assert.deepEqual(shown, ['/model', '/models', '/mode', '/memory', '/mcp'], 'commands sharing a prefix all show');
  assert.equal(node('slash').classList.contains('hidden'), false, 'palette stays visible while a command is typed');
});

test('the window carries the loopback token on both transports', async () => {
  // SECURITY.md's claim: the window asks the backend it was served from for
  // the loopback token and attaches it everywhere a browser can — the
  // EventSource as ?token=, /rpc as a bearer. The regression pinned here:
  // /rpc went out bare, so a REQUIRED-auth backend 403ed every panel call.
  const { tick, shots, streamUrl } = await bootApp(BACKEND, { token: 'tok-123' });
  await tick();
  assert.equal(streamUrl(), '/events?token=tok-123', 'the stream carries the token');
  assert.ok(
    shots.some((s) => s.url.endsWith('/rpc') && s.headers.authorization === 'Bearer tok-123'),
    'rpc carries the bearer'
  );
});

test('a 401 refreshes the token, and the retry carries the new one', async () => {
  // The boot fetch can lose a race, or the backend can restart between page
  // load and now: the window fetches the token again and retries. The retry
  // has to carry the NEW token — a header built once, before the refresh, sent
  // the old one and the retry failed with the same 401.
  const { shots, tick } = await bootApp(BACKEND, { token: 'tok-old', unauthorizedOnce: true });
  await tick(); await tick(); await tick();
  const rpcs = shots.filter((s) => s.url.endsWith('/rpc'));
  assert.ok(rpcs.length >= 2, `the call was made and retried (${rpcs.length} calls)`);
  assert.equal(rpcs[0].headers.authorization, 'Bearer tok-old', 'the first try carries the token it had');
  assert.equal(rpcs[1].headers.authorization, 'Bearer tok-new', 'and the retry carries the refreshed one');
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

test('a stop is answered on screen — the window says the run is stopping', async () => {
  // The stop used to paint nothing at all: the backend heard it, the window
  // did not, and the button looked broken until the run ended on its own.
  const { node, tick } = await bootApp(BACKEND);
  const task = node('task');
  task.value = 'a task that keeps going';
  task.dispatch('keydown', { key: 'Enter' });
  await tick();
  assert.equal(node('send').textContent, 'หยุด', 'the button stops the run');

  globalThis.__stream.emit('cancelled', { running: true });
  await tick();
  assert.match(node('log').textContent, /รับคำสั่งหยุดแล้ว/, 'the window says the stop was heard');
  assert.equal(node('send').textContent, 'กำลังหยุด…', 'and the button says the run is stopping');

  globalThis.__stream.emit('finished', { summary: '', stopReason: 'cancelled', spent: 0 });
  await tick();
  assert.equal(node('send').textContent, 'ส่ง', 'and sending is free once the run ended');
  assert.match(node('log').textContent, /หยุดแล้ว/, 'the ending says the run stopped');
});

test('a stop that found nothing to stop says so instead of pretending', async () => {
  const backend = { ...BACKEND, cancel: () => ({ ok: false, running: false, reason: 'no run in /tmp/proj' }) };
  const { node, calls, tick } = await bootApp(backend);
  const task = node('task');
  task.value = 'a task that keeps going';
  task.dispatch('keydown', { key: 'Enter' });
  await tick();

  node('send').dispatch('click'); // the button stops the run
  await tick();
  assert.ok(calls.includes('cancel'), 'the stop was sent');
  assert.match(node('log').textContent, /หยุดไม่ได้/, 'and the window says what the stop found');
  assert.equal(node('send').textContent, 'ส่ง', 'the button is free again — there was nothing to stop');
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

test('the provider picker offers every provider and switches the one in use', async () => {
  // The switch is machine-wide, so it goes through the backend rather than
  // living in this window — a choice made here has to be the choice the
  // terminal makes too.
  const { node, sent, tick } = await bootApp(BACKEND);
  const select = node('provider');
  const ids = select.children.map((c) => c.value);
  assert.deepEqual(ids, ['aipass', 'openai'], 'every provider is offered');
  assert.equal(select.value, 'aipass', 'the built-in provider is the one in use');

  const withoutKey = select.children.find((c) => c.value === 'openai');
  assert.match(withoutKey.textContent, /ไม่มี key/, 'a provider that cannot answer says so before a run needs it');

  select.value = 'openai';
  select.dispatch('change');
  await tick(); await tick();
  const call = sent.find((s) => s.method === 'provider.set');
  assert.ok(call, 'the switch goes through the backend');
  assert.deepEqual(call.params, { id: 'openai' });
});

test('a model the live catalog dropped is marked in the picker', async () => {
  // Recorded live: the saved model was retired from the site and the picker
  // kept it with no sign — the run then stopped at the catalog check and the
  // window showed an error for a choice made days ago. The mark is that
  // verdict, moved to where the fix lives.
  const status = () => ({ root: '/p', bridge: true, extensions: 1, model: 'gemini-3.1-flash-lite', running: false, mode: 'ask', plan: false, pending: [], projects: [{ path: '/p', name: 'p', current: true }], settings: {} });
  const live = { status, models: () => ({ source: 'live', data: [{ id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', kind: 'chat' }] }) };
  const { node } = await bootApp({ ...BACKEND, ...live });
  const select = node('model');
  const dead = select.children.find((c) => c.value === 'gemini-3.1-flash-lite');
  assert.ok(dead, 'the retired model stays in view — hiding it would make the header lie');
  assert.match(dead.textContent, /ไม่มีในรายการของเว็บแล้ว/, 'and it is marked as gone');
  assert.equal(select.value, 'gemini-3.1-flash-lite', 'still the model the header shows');

  // A fallback list cannot judge a pick — no mark, the same rule as the loop's.
  const stale = { status, models: () => ({ source: 'fallback', data: [{ id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', kind: 'chat' }] }) };
  const second = await bootApp({ ...BACKEND, ...stale });
  const kept = second.node('model').children.find((c) => c.value === 'gemini-3.1-flash-lite');
  assert.ok(kept, 'the saved model is still kept in view');
  assert.doesNotMatch(kept.textContent, /ไม่มีในรายการของเว็บแล้ว/, 'a list that cannot judge makes no verdict');
});

/* ------------------------------------------------------- the model catalog */

/** A backend whose catalog carries a stamp the test can move. */
function catalogBackend({ stamp = { at: 1 }, models } = {}) {
  let at = stamp.at;
  const backend = {
    ...BACKEND,
    status: () => ({ ...BACKEND.status(), model: 'gemini-3.8-flash', catalog: { source: 'live', at, count: 2, error: null } }),
    models: () => (models ? models(at) : { source: 'live', at, data: [
      { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', kind: 'chat' },
      { id: 'gemini-3.8-pro', name: 'Gemini 3.8 Pro', kind: 'chat' },
    ] }),
  };
  return {
    backend,
    /** Move the stamp: the site changed its catalog. */
    move(to) { at = to; },
  };
}

test('the window rebuilds the model list when the bridge says the catalog changed', async () => {
  // The catalog changes on the bridge's own schedule — the site retires a
  // model, the tab reattaches — and the status call the window already makes
  // every ten seconds says when it last changed. Comparing that stamp is how
  // the list heals itself: the reader does nothing, and the list catches up.
  const cat = catalogBackend();
  const { node, sent, tick, timers } = await bootApp(cat.backend);
  await tick();
  const select = node('model');
  assert.deepEqual(select.children.map((c) => c.value), ['gemini-3.8-flash', 'gemini-3.8-pro'], 'the list is there');

  cat.move(2);
  for (const fn of timers.values()) fn();
  await tick(); await tick();

  const asked = sent.filter((s) => s.method === 'models');
  assert.ok(asked.length >= 2, 'the window asked for the list again');
  assert.deepEqual(asked.at(-1).params, { force: false }, 'and it rode the cache — the bridge already has it');
});

test('a manual refresh asks the bridge for a fresh catalog', async () => {
  // The move the reader used to make by reloading the whole window: one
  // click, one fetch, and the window keeps its place.
  const cat = catalogBackend();
  const { node, sent, tick } = await bootApp(cat.backend);
  await tick();
  const before = sent.filter((s) => s.method === 'models').length;

  node('model-refresh').dispatch('click');
  await tick(); await tick();

  const asked = sent.filter((s) => s.method === 'models');
  assert.equal(asked.length, before + 1, 'the button asks the backend');
  assert.deepEqual(asked.at(-1).params, { force: true }, 'and it asks for a real fetch');
});

test('a failed model refresh keeps the list it already had', async () => {
  // An empty dropdown after a failed refresh is worse than a stale one: the
  // reader still sees a model they can pick, and the chip says what failed.
  const cat = catalogBackend();
  const { node, tick, timers } = await bootApp(cat.backend);
  await tick();
  const select = node('model');
  assert.equal(select.children.length, 2);

  cat.backend.models = () => { throw new Error('the bridge is down'); };
  cat.move(2);
  for (const fn of timers.values()) fn();
  await tick(); await tick();

  assert.equal(select.children.length, 2, 'the list the reader had is still there');
  assert.equal(select.children[0].value, 'gemini-3.8-flash');
  assert.match(node('model').title, /ดึงรายการไม่สำเร็จ/, 'and the chip says what failed');
});

test('a fallback list says why it is a fallback', async () => {
  // Two models with no explanation read as "the app is broken". The same two
  // models labelled as the stub, with a banner that names the fix, read as
  // "the site has not answered yet".
  const backend = {
    ...BACKEND,
    status: () => ({ ...BACKEND.status(), catalog: { source: 'fallback', at: 0, count: 0, error: null } }),
    models: () => ({ source: 'fallback', at: 0, error: null, data: [
      { id: 'gemini-3.1-flash-lite', name: 'gemini-3.1-flash-lite', kind: 'chat' },
      { id: 'claude-sonnet-5@default', name: 'claude-sonnet-5@default', kind: 'chat' },
    ] }),
  };
  const { node, tick } = await bootApp(backend);
  await tick();

  assert.equal(node('model-note').textContent, 'สำรอง', 'the chip says the list is the stub');
  assert.equal(node('model-note').hidden, false, 'and shows it');

  const bar = node('log').children.find((c) => (c.className ?? '').includes('needs-tab'));
  assert.ok(bar, 'a banner says so');
  assert.match(bar.textContent, /รายการสำรอง/, 'and names what it is');
  const fix = bar.children.find((c) => c.tagName === 'BUTTON');
  assert.ok(fix, 'with a way to try again');
});

test('a refresh keeps the choice the reader had made', async () => {
  // A poll that lands mid-choice must not yank the dropdown out from under
  // the reader: the choice is theirs, and the list arriving is not a reason
  // to take it away.
  const cat = catalogBackend();
  const { node, tick, timers } = await bootApp(cat.backend);
  await tick();
  const select = node('model');
  select.value = 'gemini-3.8-pro';

  cat.move(2);
  for (const fn of timers.values()) fn();
  await tick(); await tick();

  assert.equal(select.value, 'gemini-3.8-pro', 'the choice survived the refresh');
});

test('a provider switch rebuilds the list even when a refresh is in flight', async () => {
  // The list belongs to the provider, so a switch rebuilds it from scratch:
  // the old options are gone, not merged with the new ones. A refresh that is
  // in flight when the switch lands is fetching the OLD provider's list —
  // joining it instead of asking again leaves the previous provider's model in
  // the dropdown, and the switch then says one thing and shows another.
  let active = 'aipass';
  const lists = {
    aipass: [{ id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', kind: 'chat' }],
    openai: [{ id: 'gpt-4o', name: 'GPT-4o', kind: 'chat' }],
  };
  let holdNext = false;
  let release = null;
  const backend = {
    ...BACKEND,
    status: () => ({ ...BACKEND.status(), model: active === 'aipass' ? 'gemini-3.8-flash' : 'gpt-4o' }),
    'provider.set': ({ id }) => { active = id; return { ok: true, active: id }; },
    models: () => new Promise((resolve) => {
      // The list the answer carries is the one that was asked for: a refresh
      // that started before the switch must answer with the old provider's.
      const data = lists[active];
      const give = () => resolve({ source: 'live', data });
      if (holdNext) { holdNext = false; release = give; } else setTimeout(give, 0);
    }),
  };
  const { node, tick } = await bootApp(backend);
  await tick();
  assert.deepEqual(node('model').children.map((c) => c.value), ['gemini-3.8-flash'], 'the list the provider owns');

  // A refresh, held open: it is in flight while the provider is switched.
  holdNext = true;
  node('model-refresh').dispatch('click');
  await tick();
  assert.ok(release, 'the refresh is in flight');

  node('provider').value = 'openai';
  node('provider').dispatch('change');
  await tick(); await tick();

  release();
  for (let i = 0; i < 6; i++) await tick();

  const select = node('model');
  assert.deepEqual(select.children.map((c) => c.value), ['gpt-4o'], "the new provider's models are the list now");
  assert.equal(select.value, 'gpt-4o', 'and the model in use is the one selected');
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

test('a spent budget offers the same carry-on button as the step limit', async () => {
  // With no step cap set, a budget stop is what ends a long run — the dead end
  // the step limit used to be. It gets the same one-click way out.
  const { node, calls, tick } = await bootApp(BACKEND);
  globalThis.__stream.emit('budget', { reason: 'time-limited', used: '1800s of 1800s' });
  await tick();
  const note = node('log').children.find((c) => /budget spent/.test(c.textContent));
  assert.ok(note, 'the stop is named');
  const row = node('log').children.find((c) => /continue-row/.test(c.className));
  assert.ok(row, 'and the row carries a way out');
  const on = row.children.find((c) => c.tagName === 'BUTTON');
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

/* The plan/todo card -------------------------------------------------------- */

test('the plan card ticks items live and counts progress in its header', async () => {
  // The card is the live view of the checklist: a ticked item reads as done
  // and the header counts done/total. It also lives outside #log on purpose —
  // the finished-run fold must never swallow it.
  const { node, tick } = await bootApp(BACKEND);
  globalThis.__stream.emit('todo', { items: [
    { text: 'done one', done: true, kind: 'todo' },
    { text: 'open two', done: false, kind: 'todo' },
  ] });
  await tick();
  const panel = findById(node('chat'), 'todo-panel');
  assert.ok(panel, 'the card appears with the first todo');
  assert.match(panel.children[0].textContent, /plan & todo · 1\/2/, 'the header counts the ticks');
  const rows = panel.children[1].children;
  assert.ok(/\bdone\b/.test(rows[0].className), 'the ticked row is marked done');
  assert.equal(/\bdone\b/.test(rows[1].className), false, 'the open row is not');
  assert.equal(panel.classList.contains('complete'), false, 'and the card is not marked complete yet');
  assert.equal(node('log').children.includes(panel), false, 'the card is outside the transcript fold');
  assert.ok(node('chat').children.includes(panel), 'it sits in #chat, above the pending strip');
});

test('a finished run re-tallies the card from the final checklist and marks it complete', async () => {
  // The live complaint: work finished and the checklist still showed open
  // items. The finished event now carries the run's final todo state, and the
  // card re-renders from it — the one account of what actually closed.
  const { node, tick } = await bootApp(BACKEND);
  globalThis.__stream.emit('todo', { items: [
    { text: 'one', done: false, kind: 'todo' },
    { text: 'two', done: false, kind: 'todo' },
  ] });
  globalThis.__stream.emit('done_line', { text: 'เสร็จแล้ว' });
  globalThis.__stream.emit('finished', {
    summary: 'เสร็จแล้ว', stopReason: 'done', spent: 1,
    todo: [{ text: 'one', done: true, kind: 'todo' }, { text: 'two', done: true, kind: 'todo' }],
  });
  await tick(); await tick();
  const panel = findById(node('chat'), 'todo-panel');
  assert.match(panel.children[0].textContent, /plan & todo · 2\/2/, 'the final state re-tallies the header');
  assert.ok(panel.classList.contains('complete'), 'and a fully ticked card is marked complete');
  assert.match(node('log').textContent, /เช็คลิสต์ครบแล้ว/, 'the run says the checklist closed');
  assert.equal(node('log').children.some((c) => /continue-row/.test(c.className)), false, 'nothing left to carry on with');
});

test('a done run with open items says how many and offers the one click back in', async () => {
  // A run that ended "done" with items still open used to just go quiet. The
  // card names the gap and the carry-on button turns it into the next run
  // instead of a retyped task.
  const { node, calls, tick } = await bootApp(BACKEND);
  globalThis.__stream.emit('finished', {
    summary: 'stopped short', stopReason: 'done', spent: 1,
    todo: [
      { text: 'one', done: true, kind: 'todo' },
      { text: 'two', done: false, kind: 'todo' },
      { text: 'three', done: false, kind: 'todo' },
    ],
  });
  await tick(); await tick();
  const panel = findById(node('chat'), 'todo-panel');
  assert.match(panel.children[0].textContent, /plan & todo · 1\/3/, 'the card shows the final tally');
  assert.match(node('log').textContent, /เช็คลิสต์ยังเหลือ 2 จาก 3 รายการ/, 'the open count is named');
  const row = node('log').children.find((c) => /continue-row/.test(c.className));
  assert.ok(row, 'with the way back in');
  const on = row.children.find((c) => c.tagName === 'BUTTON');
  on.dispatch('click');
  await tick();
  assert.ok(calls.includes('run'), 'clicking it starts the continuation run');
  assert.equal(node('log').children.some((c) => /continue-row/.test(c.className)), false, 'and the row is gone');
});

test('a declined plan never offers a carry-on', async () => {
  // plan-rejected means the human said no to the plan; a "carry on" offer
  // there would be the window arguing with the decision. The card still shows
  // what was proposed — that is the record.
  const { node, tick } = await bootApp(BACKEND);
  globalThis.__stream.emit('finished', {
    summary: '', stopReason: 'plan-rejected', spent: 1,
    todo: [{ text: 'proposed step', done: false, kind: 'plan' }],
  });
  await tick(); await tick();
  assert.equal(node('log').children.some((c) => /continue-row/.test(c.className)), false, 'no way back in is offered');
  assert.ok(findById(node('chat'), 'todo-panel'), 'the proposed plan stays on the card');
});

test('a new session starts without the old session plan card', async () => {
  // The card outlives a run on purpose — it is the session's checklist — but a
  // new conversation must not open onto the old one's plan.
  const { node, tick } = await bootApp(BACKEND);
  globalThis.__stream.emit('todo', { items: [{ text: 'old work', done: false, kind: 'todo' }] });
  await tick();
  assert.ok(findById(node('chat'), 'todo-panel'), 'the card is up');
  node('new-session').dispatch('click');
  await tick(); await tick();
  assert.equal(findById(node('chat'), 'todo-panel'), null, 'and gone with the session');
});

test('opening an old session replays its plan card', async () => {
  const backend = {
    ...BACKEND,
    'session.open': () => [
      { type: 'task', text: 'old task' },
      { type: 'todo', items: [{ text: 'replayed one', done: true, kind: 'todo' }, { text: 'replayed two', done: false, kind: 'todo' }] },
      { type: 'note', text: 'old note' },
    ],
  };
  const { node, tick } = await bootApp(backend);
  await tick();
  sessionRows(node('sessions'))[0].dispatch('click');
  await tick(); await tick();
  const panel = findById(node('chat'), 'todo-panel');
  assert.ok(panel, 'the checklist comes back with the session');
  assert.match(panel.children[0].textContent, /plan & todo · 1\/2/);
  assert.match(node('log').textContent, /old note/);
});

test('a tick updates its row in place — no rebuild, no reset', async () => {
  // While a run works the card re-renders on every step. The rows used to be
  // thrown away and rebuilt each time, which flickered and reset the list's
  // scroll position mid-read; the same rows now stay put and only change state.
  const { node, tick } = await bootApp(BACKEND);
  const items = [
    { text: 'one', done: false, kind: 'todo' },
    { text: 'two', done: false, kind: 'todo' },
  ];
  globalThis.__stream.emit('todo', { items });
  await tick();
  const panel = findById(node('chat'), 'todo-panel');
  const first = panel.children[1].children[0];
  const second = panel.children[1].children[1];
  globalThis.__stream.emit('todo', { items: [{ ...items[0], done: true }, items[1]] });
  await tick();
  assert.equal(panel.children[1].children[0], first, 'the same row element stays');
  assert.equal(panel.children[1].children[1], second, 'and so does the one beside it');
  assert.match(first.className, /\bdone\b/, 'the ticked row now reads done');
  assert.equal(first.children[0].textContent, '☑', 'with a checked box');
  assert.match(panel.children[0].textContent, /plan & todo · 1\/2/, 'and the header follows');
});

test('a longer checklist keeps the reading position', async () => {
  const { node, tick } = await bootApp(BACKEND);
  const two = [
    { text: 'one', done: false, kind: 'todo' },
    { text: 'two', done: false, kind: 'todo' },
  ];
  globalThis.__stream.emit('todo', { items: two });
  await tick();
  const panel = findById(node('chat'), 'todo-panel');
  const ul = panel.children[1];
  ul.scrollTop = 40;
  globalThis.__stream.emit('todo', { items: [...two, { text: 'three', done: false, kind: 'todo' }] });
  await tick();
  assert.equal(ul.scrollTop, 40, 'the scroll position survives the rebuild');
});

test('a malformed todo frame is dropped, not a crash', async () => {
  // The card renders wire data. A frame with no items (an older backend, a
  // truncated relay) used to throw inside the stream handler — mid-run.
  const { node, tick } = await bootApp(BACKEND);
  globalThis.__stream.emit('todo', {});
  globalThis.__stream.emit('todo', { items: 'nope' });
  await tick();
  assert.equal(findById(node('chat'), 'todo-panel'), null, 'nothing junk is rendered');
});

test('opening a second session wins over a load still in flight', async () => {
  // Two quick clicks used to interleave: the slow session's entries landed on
  // top of the newer one's, in one log that belonged to neither. The newest
  // choice owns the screen; a stale load paints nothing.
  const backend = {
    ...BACKEND,
    'session.open': async (params) => {
      if (params.id === 's1') await new Promise((r) => setTimeout(r, 40));
      return [{ type: 'note', text: `opened ${params.id}` }];
    },
  };
  const { node, tick } = await bootApp(backend);
  await tick();
  sessionRows(node('sessions'))[0].dispatch('click');
  await tick();
  sessionRows(node('sessions'))[1].dispatch('click');
  await new Promise((r) => setTimeout(r, 80));
  assert.match(node('log').textContent, /opened s2/, 'the newest pick is on screen');
  assert.equal(/opened s1/.test(node('log').textContent), false, 'the stale load never painted');

  // …and starting a new session beats a load in flight the same way.
  node('sessions').children[0].dispatch('click');
  await tick();
  node('new-session').dispatch('click');
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(/opened s1/.test(node('log').textContent), false, 'the abandoned load stayed quiet');
});

test("a live run's frames stay out of another session's view", async () => {
  // A run streams to ITS session while the human browses an old one. Without
  // the session tag its `assistant_delta` writes a running task into the old
  // transcript — its checklist card and `finished` notes included. rpc.mjs
  // tags every harness frame with the run's session; the window drops foreign
  // ones. The `session` announcement is the exception: adopting the new id is
  // exactly how the window follows a run that opens a session.
  const { node, tick } = await bootApp(BACKEND);
  globalThis.__stream.emit('session', { id: 's2', title: 'the run', file: 'x.jsonl' });
  await tick();
  // Browse s1 while the run is still going.
  sessionRows(node('sessions'))[0].dispatch('click');
  await tick();
  globalThis.__stream.emit('assistant_delta', { text: 'RUN-ONLY', session: 's2' });
  globalThis.__stream.emit('note', { text: 'RUN-NOTE', session: 's2' });
  globalThis.__stream.emit('todo', { items: [{ text: 'RUN-ITEM', done: false }], session: 's2' });
  globalThis.__stream.emit('assistant_delta', { text: 'IN-VIEW', session: 's1' });
  globalThis.__stream.emit('note', { text: 'GLOBAL-NOTE' });
  await tick();
  // Prose paints as markdown segments (innerHTML) and notes as plain text —
  // each family is read the way the window writes it.
  const prose = () => node('log').children
    .filter((c) => c.className.includes('assistant'))
    .map(bubbleHtml)
    .join('\n');
  const notes = node('log').textContent;
  assert.equal(prose().includes('RUN-ONLY'), false, 'the run streaming in s2 painted nothing into s1');
  assert.equal(notes.includes('RUN-NOTE'), false, 'nor did its notes');
  assert.equal(findById(node('chat'), 'todo-panel'), null, 'nor its checklist card');
  assert.ok(prose().includes('IN-VIEW'), 'frames of the open session paint');
  assert.ok(notes.includes('GLOBAL-NOTE'), 'untagged backend notes still paint');
  // Back on the run's session, its frames land again.
  sessionRows(node('sessions'))[1].dispatch('click');
  await tick();
  globalThis.__stream.emit('assistant_delta', { text: 'BACK-TAIL', session: 's2' });
  await tick();
  assert.ok(prose().includes('BACK-TAIL'), 'the run paints again once its session is open');
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

test('reasoning arrives by appending text, not by rewriting the fold each frame', async () => {
  // The fold used to get its whole text reassigned per animation frame — a
  // long think re-created a pre full of text over and over, which is exactly
  // the stutter a long reasoning stream caused. Appended text nodes keep what
  // already arrived.
  const { node, tick } = await bootApp(BACKEND);
  globalThis.__stream.emit('reasoning_delta', { text: 'first thought. ' });
  await tick();
  const box = node('log').children.find((c) => c.tagName === 'DETAILS' && /think/.test(c.className));
  const pre = box.children[1];
  const firstNode = pre.children[0];
  globalThis.__stream.emit('reasoning_delta', { text: 'second thought.' });
  await tick();
  assert.equal(pre.textContent, 'first thought. second thought.');
  assert.equal(pre.children[0], firstNode, 'what was already painted stays put');
  assert.equal(pre.children.length, 2, 'only the new stretch is a new node');
});

test("a search's sources are shown as links, with the address the reader can open", async () => {
  // A web search is the one tool whose result IS a set of addresses, and the
  // row used to keep them to itself: the reader saw prose about the web and
  // no way to reach any of it. The addresses are shown under the row — and
  // the wire spelling is put back, so the link is a real one.
  const { node, tick } = await bootApp(BACKEND);
  globalThis.__stream.emit('tool', {
    kind: 'web',
    arg: 'ai research',
    ok: true,
    head: 'note: this came from the open web',
    sources: [{ label: 'medium.com', url: 'HTTPS-URLmedium.com/@a/post' }],
  });
  await tick();
  const row = node('log').children.find((c) => c.tagName === 'DETAILS' && /(^|\s)tool(\s|$)/.test(c.className ?? ''));
  assert.ok(row, 'the search has its row');
  const box = row.children.find((c) => c.className === 'sources');
  assert.ok(box, 'the row carries the sources');
  const link = box.children[0];
  assert.equal(link.href, 'https://medium.com/@a/post', 'the address is a real one');
  assert.equal(link.textContent, 'https://medium.com/@a/post', 'and it is what the reader sees');
  assert.equal(row.open, true, 'the links are the point of the row, so it opens');
});

test('the step headline is not said twice — the bubble already holds the prose', async () => {
  // The step's headline is the first line of the model's reply, and the reply
  // is in the bubble. The row under the step used to say it again, so a run
  // read the same sentence twice: once in the bubble, once as the step's
  // title. A DONE is said once, and so is this.
  const { node, tick } = await bootApp(BACKEND);
  globalThis.__stream.emit('assistant_delta', { text: 'Let us start with the project overview.\n' });
  await tick();
  globalThis.__stream.emit('step', { step: 1, maxSteps: 0, elapsed: 5.4 });
  globalThis.__stream.emit('thinking', { text: 'Let us start with the project overview.' });
  await tick();
  const heads = node('log').children.filter((c) => /(^|\s)thinking(\s|$)/.test(c.className ?? ''));
  assert.equal(heads.length, 0, 'the bubble says it once already');
  // …and the prose is still there: the row was dropped, not the reply.
  const bubble = node('log').children.find((c) => c.className.includes('assistant'));
  assert.match(bubbleHtml(bubble), /Let us start with the project overview/);
});

test('the step headline is not said twice when the bubble carries the wire spelling', async () => {
  // The bubble is painted from the stream, which carries the wire spelling of
  // the reply; the headline comes from the reply the harness decoded. Both
  // sides are put back before they are compared, or a reply with a trigger
  // token in it would say itself twice.
  const { node, tick } = await bootApp(BACKEND);
  globalThis.__stream.emit('assistant_delta', { text: 'CONSOLE-LOG is how it is said\n' });
  await tick();
  globalThis.__stream.emit('step', { step: 1, maxSteps: 0, elapsed: 1 });
  globalThis.__stream.emit('thinking', { text: 'console.log is how it is said' });
  await tick();
  const heads = node('log').children.filter((c) => /(^|\s)thinking(\s|$)/.test(c.className ?? ''));
  assert.equal(heads.length, 0, 'the bubble says it once already');
});

test('a headline the bubble does not carry still gets its line', async () => {
  // The row is not decoration: a headline that is not in the bubble (a reply
  // that never reached it, another session's turn) still deserves a line.
  const { node, tick } = await bootApp(BACKEND);
  globalThis.__stream.emit('thinking', { text: 'A line no bubble carries' });
  await tick();
  const heads = node('log').children.filter((c) => /(^|\s)thinking(\s|$)/.test(c.className ?? ''));
  assert.equal(heads.length, 1, 'the row is there');
  assert.match(heads[0].textContent, /A line no bubble carries/);
});

test('a link in the chat opens in the browser, not in the window', async () => {
  // The window is a webview on the app's own page: a link that navigated it
  // would take the app away. The click goes to the backend, which opens the
  // address in the browser.
  const { node, tick, sent } = await bootApp(BACKEND);
  globalThis.__stream.emit('tool', {
    kind: 'web',
    arg: 'ai research',
    ok: true,
    sources: [{ label: 'medium.com', url: 'https://medium.com/@a/post' }],
  });
  await tick();
  const row = node('log').children.find((c) => c.tagName === 'DETAILS' && /(^|\s)tool(\s|$)/.test(c.className ?? ''));
  const link = row.children.find((c) => c.className === 'sources').children[0];
  link.dispatch('click');
  await tick();
  assert.ok(
    sent.some((c) => c.method === 'browser.open' && c.params.url === 'https://medium.com/@a/post'),
    `the click opened the address in the browser:\n${JSON.stringify(sent.filter((c) => c.method === 'browser.open'))}`,
  );
});

test('a finished run folds its working trail and leaves the result open', async () => {
  // The run used to leave every step on screen — the answer sat at the bottom
  // of a wall of rows. On done/ask the trail folds under one line and the
  // closing bubble is labelled as the result. (Reported after live use.)
  const { node, tick } = await bootApp(BACKEND);
  globalThis.__stream.emit('task_start', { task: 'ช่วยอ่าน README หน่อย' });
  globalThis.__stream.emit('assistant_delta', { text: 'Let me look.\n' });
  globalThis.__stream.emit('tool', { kind: 'read', arg: 'README.md', ok: true, head: '12 lines' });
  globalThis.__stream.emit('step', { step: 1, maxSteps: 10, elapsed: '1.2' });
  globalThis.__stream.emit('assistant_delta', { text: 'อ่านแล้วนะ\n' });
  globalThis.__stream.emit('done_line', { text: 'อ่าน README แล้ว สรุปสั้น ๆ ได้ว่าเป็นโปรเจกต์ตัวอย่าง' });
  globalThis.__stream.emit('finished', { summary: 'อ่านแล้ว', stopReason: 'done', spent: 1, credits: { available: 9, limit: 10 } });
  await tick(); await tick();

  const log = node('log');
  const isFold = (c) => c.tagName === 'DETAILS' && /(^|\s)run(\s|$)/.test(c.className ?? '');
  const fold = log.children.find(isFold);
  assert.ok(fold, 'the working trail folds into one details row');
  assert.equal(fold.open, false, 'collapsed by default');
  assert.match(fold.textContent, /ระหว่างทำงาน · \d+ รายการ/, 'the summary says how much is inside');
  assert.ok(fold.children.some((c) => c.className === 'tool'), 'the tool row is inside the fold');
  assert.ok(fold.children.some((c) => /note/.test(c.className ?? '') && /step 1\/10/.test(c.textContent)), 'the step note too');

  const result = log.children.find((c) => /(^|\s)result(\s|$)/.test(c.className ?? ''));
  assert.ok(result, 'the closing bubble is marked as the result');
  // The closing summary is painted as markdown into the bubble's segments;
  // the fake DOM keeps innerHTML as a string, so the text is asserted there.
  assert.match(bubbleHtml(result), /อ่าน README แล้ว/, 'and carries the closing text');
  assert.equal(fold.children.includes(result), false, 'the result is not inside the fold');
  assert.ok(log.children.indexOf(fold) < log.children.indexOf(result), 'the fold sits above the result');
});

test('a step-limit stop keeps the trail flat, carry-on button included', async () => {
  // The fold is for runs that reached an answer. A stop short of one — steps,
  // error, stall — is told by its trail, so nothing is hidden, and the
  // carry-on button keeps working.
  const { node, tick } = await bootApp(BACKEND);
  globalThis.__stream.emit('task_start', { task: 'long task' });
  globalThis.__stream.emit('tool', { kind: 'read', arg: 'a.txt', ok: true });
  globalThis.__stream.emit('step_limit', {});
  globalThis.__stream.emit('finished', { summary: 'steps', stopReason: 'steps', spent: 1 });
  await tick(); await tick();

  const log = node('log');
  const isFold = (c) => c.tagName === 'DETAILS' && /(^|\s)run(\s|$)/.test(c.className ?? '');
  assert.equal(log.children.some(isFold), false, 'a non-done ending stays flat');
  const row = log.children.find((c) => /continue-row/.test(c.className));
  assert.ok(row, 'and the carry-on row is still in the open');
  assert.equal(row.children.some((c) => c.tagName === 'BUTTON'), true, 'its button is reachable');
});

test('a no-chat-tab banner is never swallowed by the fold', async () => {
  // The banner carries the one-click fix; folding it away would hide the only
  // click that unblocks the run.
  const { node, tick } = await bootApp(BACKEND);
  globalThis.__stream.emit('task_start', { task: 'x' });
  globalThis.__stream.emit('needs_tab', { url: 'https://de.aipass.net/chat' });
  globalThis.__stream.emit('tool', { kind: 'read', arg: 'a.txt', ok: true });
  globalThis.__stream.emit('done_line', { text: 'ทำต่อไม่ได้จนกว่าจะมี tab' });
  globalThis.__stream.emit('finished', { summary: 'x', stopReason: 'done', spent: 1 });
  await tick(); await tick();

  const log = node('log');
  const bar = log.children.find((c) => /needs-tab/.test(c.className ?? ''));
  assert.ok(bar, 'the banner stays visible');
  const fold = log.children.find((c) => c.tagName === 'DETAILS' && /(^|\s)run(\s|$)/.test(c.className ?? ''));
  assert.ok(fold, 'the trail still folds');
  assert.equal(fold.children.includes(bar), false, 'the banner is not inside');
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

test('/symbols answers from the window, not from a run', async () => {
  // The command used to be a pointer to the markers: it printed "use SYMBOLS in
  // an agent run" and nothing else, so the palette promised a listing it did
  // not have. It asks the backend for the same index the markers use.
  const { node, tick } = await bootApp({
    ...BACKEND,
    'symbols.list': () => ({ file: 'src/app.mjs', symbols: [{ name: 'greet', kind: 'function', line: 3 }] }),
    'symbols.def': () => ({ name: 'greet', definitions: [] }),
    'symbols.refs': () => ({ name: 'greet', references: [] }),
  });
  await tick(); await tick();

  const task = node('task');
  task.value = '/symbols src/app.mjs';
  task.dispatch('keydown', { key: 'Enter' });
  await tick(); await tick(); await tick();
  const out = node('log').textContent;
  assert.match(out, /src\/app\.mjs/, 'the file is named');
  assert.match(out, /greet/, 'and what it declares');
});

test('the palette says what is selected, and the composer says it is open', async () => {
  // A screen reader reads "1 of 29" only if the rows are options and the
  // composer points at the one on it. It used to be a colour.
  const { node, tick } = await bootApp(BACKEND);
  const task = node('task');
  task.value = '/mo';
  task.dispatch('keydown', { key: 'm' });
  await tick(); await tick();

  assert.equal(task.attrs['aria-expanded'], 'true', 'the composer says the palette is open');
  assert.equal(task.attrs['aria-controls'], 'slash-list', 'and which list it is');
  const rows = node('slash-list').children;
  assert.ok(rows.length >= 1, 'the palette has rows');
  assert.equal(rows[0].attrs.role, 'option', 'and a row is an option');
  assert.equal(rows[0].attrs['aria-selected'], 'true', 'the one on it is the selected one');
  assert.ok(task.attrs['aria-activedescendant'], 'and the composer names it');

  task.dispatch('keydown', { key: 'Escape' });
  await tick();
  assert.equal(task.attrs['aria-expanded'], 'false', 'and closing it says so');
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
  assert.equal(sessionRows(node('sessions')).length, 3, 'every session is listed');
  node('session-filter').value = 'UI';
  node('session-filter').dispatch('input');
  await settle();
  assert.equal(sessionRows(node('sessions')).length, 1, 'the filter narrows it');
  assert.match(sessionRows(node('sessions'))[0].textContent, /UI/);

  node('session-filter').value = 'ไม่มีอะไรตรง';
  node('session-filter').dispatch('input');
  await settle();
  assert.match(node('sessions').textContent, /ไม่พบบทสนทนา/, 'and says so when nothing matches');
});

test('a session row opens with Enter, not only with the mouse', async () => {
  // Mouse-only rows leave keyboard users with a list they cannot act on, so
  // every clickable row is a real button now: focusable, Enter and Space alike.
  const { node, calls, tick } = await bootApp({
    ...BACKEND,
    'session.list': () => [{ id: 'aaa', title: 'first', updated: Date.UTC(2026, 9, 10) }],
    'session.open': () => [],
  });
  await tick(); await tick();
  const row = sessionRows(node('sessions'))[0];
  assert.equal(row.attrs.role, 'button', 'the row announces itself as a button');
  assert.equal(row.tabIndex, 0, 'and can take focus');
  row.dispatch('keydown', { key: 'Enter' });
  await tick(); await tick();
  assert.ok(calls.includes('session.open'), 'Enter opens the session');
});

test('the archive is a door both ways', async () => {
  // "เก็บ" (archive) moves a session out of the picker's way, into
  // <project>/archive/ — nothing is deleted, but nothing could bring one back
  // either, which made the archive a one-way door. The row says how many are
  // in there, and each of them can be put back where it was.
  const { node, calls, tick } = await bootApp({
    ...BACKEND,
    'session.archived': () => [{ id: 's9', title: 'the old one', updated: Date.UTC(2026, 9, 1) }],
    'session.unarchive': () => ({ ok: true }),
    'session.prune': () => ({ count: 2 }),
  });
  await tick(); await tick();

  const rail = node('sessions');
  const bar = rail.children.find((li) => (li.className ?? '').includes('archive-bar'));
  assert.ok(bar, 'the archive says it is there');
  const open = bar.children.find((b) => b.tagName === 'BUTTON');
  assert.match(open.textContent, /คืนจากที่เก็บ/, 'and offers the way back');

  open.dispatch('click');
  await tick();
  const box = rail.children.find((c) => (c.className ?? '').includes('archived-box'));
  assert.ok(box, 'the way back opens');
  const row = box.children.find((c) => (c.className ?? '').includes('archived-row'));
  assert.ok(row, 'and the archived session is in it');
  assert.match(row.textContent, /the old one/, 'named as it was');

  const back = row.children.find((b) => b.tagName === 'BUTTON');
  back.dispatch('click');
  await tick(); await tick();
  assert.ok(calls.includes('session.unarchive'), 'and the row puts it back');
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

test('the file field searches the whole project', async () => {
  // A folder with a hundred files is a list nobody scrolls, and a project with
  // a thousand is a tree nobody can walk in their head. The field under the
  // heading searches the project, and every row says which folder it is in.
  const { node, tick } = await bootApp({
    ...BACKEND,
    'fs.list': () => [{ name: 'README.md', dir: false }],
    'fs.search': (params) => (params.query === 'guide'
      ? [
        { path: 'docs/guide.md', name: 'guide.md', dir: false },
        { path: 'ux/guide.md', name: 'guide.md', dir: false },
      ]
      : []),
  });
  await tick(); await tick(); await tick();
  assert.equal(node('files').children.length, 1, 'the folder is listed');
  assert.equal(node('files-count').textContent, '1', 'and the count says how many there are');

  node('file-filter').value = 'guide';
  node('file-filter').dispatch('input');
  await settle();
  const names = node('files').children.map((li) => li.textContent);
  assert.equal(names.length, 2, 'the search finds the file in every folder');
  assert.match(names[0], /guide\.md/);
  assert.match(names[0], /docs/, 'and the row says which folder it lives in');
  assert.equal(node('files-count').textContent, '2', 'and the count says how many there are');

  node('file-filter').value = 'ไม่มีอะไรตรง';
  node('file-filter').dispatch('input');
  await settle();
  assert.match(node('files').textContent, /ไม่พบไฟล์/, 'and it says so when nothing matches');
});

test('the field can search inside the files, not only their names', async () => {
  // "Where is this?" is two questions: which file, and which line. The
  // button at the end of the field flips the search from the name of a file
  // to what is written in it — and the answer says where the word was found.
  const { node, calls, tick } = await bootApp({
    ...BACKEND,
    'fs.list': () => [{ name: 'README.md', dir: false }],
    'fs.grep': () => [{ path: 'docs/notes.md', line: 12, text: 'the answer is 42', at: 4 }],
    'fs.read': () => ({ file: 'docs/notes.md', text: 'one\ntwo\nthe answer is 42' }),
  });
  await tick(); await tick(); await tick();
  node('file-mode').dispatch('click');
  assert.match(node('file-filter').placeholder, /คำในไฟล์/, 'the field says which search it does now');

  node('file-filter').value = 'answer';
  node('file-filter').dispatch('input');
  await settle();
  assert.ok(calls.includes('fs.grep'), 'the search asks for the word inside the files');
  const row = node('files').children[0];
  assert.match(row.textContent, /notes\.md/, 'the row names the file');
  assert.match(row.textContent, /docs:12/, 'and says where in it the word is');

  row.dispatch('click');
  await tick(); await tick();
  assert.ok(calls.includes('fs.read'), 'the row opens the file');
  assert.equal(node('modal-title').textContent, 'docs/notes.md', 'and the sheet says which file it is');
});

test('the file field opens what it found, with the keyboard alone', async () => {
  // A field you can type in but not act on is a form, not a tool: Enter opens
  // the first hit, and the sheet says which file it opened.
  const { node, calls, tick } = await bootApp({
    ...BACKEND,
    'fs.list': () => [{ name: 'README.md', dir: false }],
    'fs.search': () => [{ path: 'docs/guide.md', name: 'guide.md', dir: false }],
    'fs.read': () => ({ file: 'docs/guide.md', text: 'the guide' }),
  });
  await tick(); await tick(); await tick();
  node('file-filter').value = 'guide';
  node('file-filter').dispatch('input');
  await settle();
  node('file-filter').dispatch('keydown', { key: 'Enter' });
  await tick(); await tick();
  assert.ok(calls.includes('fs.read'), 'Enter opens the file the search found');
  assert.equal(node('modal-title').textContent, 'docs/guide.md', 'and the sheet says which file it is');
});

test('the history is grouped by day', async () => {
  // A history of 99 rows with no groups is a wall of clocks. The groups turn
  // it into a few questions, and they are labels — not sessions.
  const { node, tick } = await bootApp({
    ...BACKEND,
    'session.list': () => [
      { id: 'aaa', title: 'one', updated: Date.now() },
      { id: 'bbb', title: 'two', updated: Date.now() - 86_400_000 * 3 },
    ],
  });
  await tick(); await tick();
  const heads = node('sessions').children.filter((li) => li.className === 'day-head');
  assert.equal(heads.length, 2, 'two days, two group heads');
  assert.match(heads[0].textContent, /วันนี้/, 'the newest day is named');
  assert.equal(sessionRows(node('sessions')).length, 2, 'and both sessions are still there');
});

test('the file trail walks back to the root of the project', async () => {
  // A deep folder with no way out is a place you get stuck: the trail under
  // the list is the way back, and every step of it is a click.
  const { node, sent, tick } = await bootApp({
    ...BACKEND,
    'fs.list': (params) => (params.dir === '.' ? [{ name: 'docs', dir: true }] : [{ name: 'guide.md', dir: false }]),
  });
  await tick(); await tick(); await tick();
  node('files').children.find((li) => li.textContent.includes('docs/')).dispatch('click');
  await tick(); await tick();
  const crumbs = node('files-crumbs');
  assert.match(crumbs.textContent, /docs/, 'the trail names the folder you are in');

  const root = crumbs.children.find((c) => c.tagName === 'BUTTON');
  assert.ok(root, 'and the first step is the project itself');
  root.dispatch('click');
  await tick(); await tick();
  const last = sent.filter((s) => s.method === 'fs.list').at(-1);
  assert.equal(last.params.dir, '.', 'clicking it asks for the root of the tree');
});

test('a folder with nothing in it says so', async () => {
  // An empty list and a list that failed to load look the same on screen: a
  // blank box. The panel says which one it is.
  const { node, tick } = await bootApp({ ...BACKEND, 'fs.list': () => [] });
  await tick(); await tick(); await tick();
  assert.match(node('files').textContent, /ยังไม่มีไฟล์/, 'the empty folder says so');
});

test('a folder that cannot be read says so, and offers to read it again', async () => {
  // A refused folder that shows an empty list is a lie: the reader thinks
  // there is nothing there. The panel says what happened, and the one thing
  // that can change it is a click away.
  const { node, tick } = await bootApp({
    ...BACKEND,
    'fs.list': () => { throw new Error('outside project root: ../..'); },
  });
  await tick(); await tick(); await tick();
  assert.match(node('files').textContent, /อ่านไฟล์ไม่ได้/, 'the panel says the folder could not be read');
  assert.match(node('files').textContent, /นอกโปรเจกต์/, 'and says why, in the words the reader reads');
  assert.ok(node('files').textContent.includes('ลองใหม่'), 'and offers to read it again');
});

test('a section folds away, and the reader decides which one', async () => {
  // The rail is 264px and two lists want it. The fold gives the room back,
  // and the window remembers the answer.
  const { node, tick } = await bootApp(BACKEND);
  await tick(); await tick();
  const section = node('files-section');
  node('files-fold').dispatch('click');
  assert.ok(section.classList.contains('folded'), 'the section folds away');
  assert.equal(node('files-fold').attrs['aria-expanded'], 'false', 'and says so');
  node('files-fold').dispatch('click');
  assert.ok(!section.classList.contains('folded'), 'and it opens again');
});

test('the arrow keys walk the list', async () => {
  // A list you can only reach with the mouse is half a list. The keys move
  // from row to row, and they stop at the ends instead of wrapping.
  const { node, tick } = await bootApp({
    ...BACKEND,
    'fs.list': () => [{ name: 'a.md', dir: false }, { name: 'b.md', dir: false }],
  });
  await tick(); await tick(); await tick();
  const rows = node('files').children;
  rows[0].dispatch('keydown', { key: 'ArrowUp' });
  assert.equal(rows[0].lastEvent.defaultPrevented, false, 'there is nothing above the first row');
  rows[0].dispatch('keydown', { key: 'ArrowDown' });
  assert.equal(rows[0].lastEvent.defaultPrevented, true, 'so the key moves down to the next row');
  rows[1].dispatch('keydown', { key: 'ArrowDown' });
  assert.equal(rows[1].lastEvent.defaultPrevented, false, 'and it stops at the last row');
});

test('a session somebody named shows its name, not only its clock', async () => {
  // The clock face is the name of a session nobody named. A session with a
  // title of its own shows the title — the clock is what the day column is
  // for.
  const { node, tick } = await bootApp({
    ...BACKEND,
    'session.list': () => [{ id: 'aaa', title: '2026-10-10 09:15 สรุป README', updated: Date.UTC(2026, 9, 10) }],
  });
  await tick(); await tick();
  const row = sessionRows(node('sessions'))[0];
  assert.match(row.textContent, /สรุป README/, 'the name is in the row');
  assert.doesNotMatch(row.textContent, /09:15/, 'and the clock does not crowd it out');
});

test('the memory page shows carried facts, and forget-all clears them', async () => {
  // Facts carried across sessions were invisible: the model "remembered"
  // something the person could neither see nor drop. They live in the
  // settings sheet now — that is where you look to find out what an app
  // knows about you, so the rail keeps only the work.
  let facts = ['ชอบ indent ด้วยสเปซ', 'โปรเจกต์รันบน Node 20'];
  const { node, calls, tick } = await bootApp({
    ...BACKEND,
    'memory.list': () => ({ facts }),
    'memory.clear': () => { facts = []; return { ok: true }; },
  });
  node('settings-btn').dispatch('click');
  await tick(); await tick(); await tick();

  const shell = node('modal-body').children.find((c) => /settings/.test(c.className));
  const rail = shell.children.find((c) => /settings-nav/.test(c.className));
  const tab = rail.children.find((b) => /ความจำ/.test(b.textContent));
  assert.ok(tab, 'the sheet grew a memory category');
  tab.dispatch('click');
  await tick();

  const pages = shell.children.find((c) => /settings-pages/.test(c.className));
  const page = pages.children.find((p) => p.dataset.page === 'memory');
  assert.ok(page, 'the memory page is in the sheet');
  const walk = (n, out = []) => { out.push(n); for (const c of n.children ?? []) walk(c, out); return out; };
  const list = walk(page).find((n) => n.id === 'memory');
  assert.equal(list.children.length, 2, 'both facts are listed');
  assert.match(walk(page).find((n) => n.id === 'memory-head').textContent, /\(2\)/, 'the header counts them');

  walk(page).find((n) => n.id === 'memory-clear').dispatch('click');
  await tick(); await tick();
  assert.ok(calls.includes('memory.clear'), 'forget-all reaches the backend');
  assert.equal(list.children.length, 1, 'the panel re-renders empty');
  assert.match(list.textContent, /ยังไม่มี/, 'and says so instead of going blank');
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

test('a file the human unticked stays unticked when the panel is rebuilt', async () => {
  // The panel is rebuilt on every diff frame and again when the run ends. It
  // used to re-tick everything it drew, so a file the human had said no to
  // came back ticked — and the Apply button writes what is ticked.
  const changes = [
    { file: 'keep.mjs', added: 1, removed: 0, deleted: false, isNew: false },
    { file: 'skip.mjs', added: 1, removed: 0, deleted: false, isNew: false },
  ];
  const { node, tick } = await bootApp({ ...BACKEND, pending: () => changes });
  globalThis.__stream.emit('diff_update', { changes });
  await tick(); await tick(); await tick();

  const boxes = node('pending-list').children.map((li) => li.children[0]);
  assert.equal(boxes.length, 2, 'both files are on the panel');
  const skip = boxes.find((b) => b._parent.textContent.includes('skip.mjs'));
  assert.ok(skip, 'the file the human objects to is there');
  assert.equal(skip.checked, true, 'it starts ticked');

  // The human says no to that one.
  skip.checked = false;
  skip.dispatch('change');
  assert.equal(skip.checked, false, 'and the box is now unticked');

  // The run stages one more file: the panel is drawn again.
  globalThis.__stream.emit('diff_update', { changes: [...changes, { file: 'new.mjs', added: 1, removed: 0, deleted: false, isNew: true }] });
  await tick(); await tick(); await tick();

  const after = node('pending-list').children.map((li) => ({ text: li.textContent, box: li.children[0] }));
  const skipAfter = after.find((row) => row.text.includes('skip.mjs'));
  assert.equal(skipAfter.box.checked, false, 'the unticked file is still unticked');
  const newRow = after.find((row) => row.text.includes('new.mjs'));
  assert.equal(newRow.box.checked, true, 'a file that is new comes in ticked');
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

test('the temperature chip sits beside the effort chip and writes through', async () => {
  // Sampling temperature is a per-message knob too: it rides beside the effort
  // chip and writes through settings.set the moment it changes; null means the
  // server's per-model default, so the chip boots at "default".
  const { node, sent, tick } = await bootApp(BACKEND);
  assert.equal(node('temperature').value, 'default', 'the chip boots at the default');

  node('temperature').value = '0.7';
  node('temperature').dispatch('change');
  await tick();
  assert.deepEqual(sent.at(-1), { method: 'settings.set', params: { temperature: 0.7 } }, 'a pick is a number on the wire');

  node('temperature').value = 'default';
  node('temperature').dispatch('change');
  await tick();
  assert.deepEqual(sent.at(-1), { method: 'settings.set', params: { temperature: null } }, 'default clears it back to null');
});

test('the saved settings land in the header chips together', async () => {
  // The mode, the effort and the temperature are ONE apply path: a settings
  // change lands in all three chips at once, and none of them is left showing
  // what the machine no longer believes.
  const saved = { ...BACKEND['settings.get'](), mode: 'auto', requirePlanApproval: true, thinking: 'high', temperature: 0.7 };
  const backend = { ...BACKEND, 'settings.get': () => saved, 'settings.set': () => saved };
  const { node, tick } = await bootApp(backend);
  assert.equal(node('mode').value, 'plan', 'the mode chip shows the plan view');
  assert.equal(node('thinking').value, 'high', 'the effort chip shows the saved level');
  assert.equal(node('temperature').value, '0.7', 'the temperature chip shows the saved number');

  // And a save from the sheet moves all three at once, because the sheet
  // asks the same one path to apply what it just wrote.
  node('settings-btn').dispatch('click');
  await tick(); await tick();
  const save = node('modal-actions').children.find((b) => /save|บันทึก/.test(b.textContent));
  assert.ok(save, 'a save button exists');
  save.dispatch('click');
  await tick(); await tick();
  assert.equal(node('mode').value, 'plan', 'the mode chip still shows the plan view');
  assert.equal(node('thinking').value, 'high', 'the effort chip still shows the saved level');
  assert.equal(node('temperature').value, '0.7', 'the temperature chip still shows the saved number');
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

test('a plugin marker asks in its own words, and shows what it was handed', async () => {
  // A plugin marker is neither a file nor a command, so the question cannot
  // say "change this file?" over a marker name: the person would be asked
  // about the wrong thing. The payload matters too — the marker is the code
  // that runs, and the argument is what it is handed.
  const { node, sent, tick } = await bootApp(BACKEND);
  await tick();

  globalThis.__stream.emit('permission_request', {
    id: 'abc', kind: 'plugin', arg: 'NOTE', risk: 'write', preview: 'hello',
  });
  await tick();
  assert.equal(node('modal-title').textContent, 'run this plugin marker?');
  assert.match(node('modal-body').textContent, /NOTE/, 'the marker is named');
  assert.match(node('modal-body').textContent, /hello/, 'and what it was handed');
  assert.equal(node('modal').classList.contains('hidden'), false, 'the question is on screen');

  node('modal-actions').children[2].dispatch('click'); // allow
  await tick();
  assert.deepEqual(sent.at(-1), { method: 'permission.answer', params: { id: 'abc', decision: 'allow' } },
    'the answer goes to the backend');
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
  assert.ok(tabs.some((t) => /สุขภาพ/.test(t)), 'the health check has its own category');
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

  // A negative step limit is refused, with the reason on screen and no write.
  // (Zero is a real value now: "no cap".)
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
  const stepField = inputs.filter((n) => n.type === 'number' && String(n.value) === '10');
  assert.ok(stepField.length, 'the step limit control is found by its value');
  stepField[0].value = '-1';
  stepField[0].onchange({ target: stepField[0] });
  const saveAgain = node('modal-actions').children.find((b) => /save|บันทึก/.test(b.textContent));
  saveAgain.dispatch('click');
  await tick(); await tick();
  assert.equal(calls.filter((c) => c === 'settings.set').length, 1, 'the bad edit never reaches disk');
  // The error row is built with the body but the actions row takes it in the
  // end (append moves a node) — that is where it lives and where it must show.
  const error = node('modal-actions').children.find((c) => /settings-error/.test(c.className));
  assert.ok(error && !error.classList.contains('hidden'), 'and the sheet explains why');
  assert.match(error.textContent, /step/, 'naming the field');
});

test('the plugins page inspects a source, asks, and only then installs', async () => {
  const inspected = [];
  const installed = [];
  const live = { on: false };
  const info = { kind: 'path', ref: '/tmp/chime.mjs', entry: 'chime.mjs', size: 120, sha256: 'ab'.repeat(32) };
  const backend = {
    ...BACKEND,
    'plugins.list': () => (live.on
      ? {
        dir: '/tmp/plugins',
        loaded: [{ name: 'chime', version: '1.0.0', description: 'rings', file: '/tmp/plugins/chime/plugin.mjs', sha256: 'c0ffee' }],
        failed: [], tools: ['CHIME_TOOL'],
        known: ['chime'],
        registry: { chime: { source: { ref: '/tmp/chime.mjs' }, sha256: 'c0ffee' } },
      }
      : { dir: '/tmp/plugins', loaded: [], failed: [], tools: [], known: [], registry: {} }),
    'plugins.inspect': (params) => { inspected.push(params); return info; },
    'plugins.install': (params) => { installed.push(params); live.on = true; return { plugin: { name: 'chime', version: '1.0.0' } }; },
  };
  const { node, tick } = await bootApp(backend);
  node('settings-btn').dispatch('click');
  await tick(); await tick(); await tick();

  const shell = node('modal-body').children.find((c) => /settings/.test(c.className));
  const rail = shell.children.find((c) => /settings-nav/.test(c.className));
  const pluginsTab = rail.children.find((b) => /ปลั๊กอิน/.test(b.textContent));
  assert.ok(pluginsTab, 'the sheet has a plugins category');
  pluginsTab.dispatch('click');
  await tick();
  const pages = shell.children.find((c) => /settings-pages/.test(c.className));
  const page = pages.children.find((p) => p.dataset.page === 'plugins');
  assert.ok(page, 'the plugins page is in the sheet');

  const walk = (n, out = []) => { out.push(n); for (const c of n.children ?? []) walk(c, out); return out; };
  const input = walk(page).find((n) => n.tagName === 'INPUT' && /path|https/.test(n.placeholder ?? ''));
  assert.ok(input, 'the install box has a source field');
  input.value = '/tmp/chime.mjs';
  walk(page).find((n) => n.tagName === 'BUTTON' && n.textContent === 'ตรวจสอบ').dispatch('click');
  await tick(); await tick();

  assert.deepEqual(inspected, [{ source: '/tmp/chime.mjs' }], 'ตรวจสอบ asked the backend to look');
  assert.equal(installed.length, 0, 'inspecting runs nothing — no install before the button');
  assert.match(page.textContent, /sha256 ab/, 'the report shows the hash that is being consented to');
  assert.match(page.textContent, /ชนิด: path/, 'and says where the source comes from');

  const installBtn = walk(page).find((n) => n.tagName === 'BUTTON' && n.textContent === 'ติดตั้ง');
  assert.ok(installBtn, 'the report offers install');
  installBtn.dispatch('click');
  await tick(); await tick(); await tick();

  assert.deepEqual(installed, [{ source: '/tmp/chime.mjs', expectedSha256: info.sha256 }], 'install carries the hash that was shown');
  assert.match(page.textContent, /chime 1\.0\.0/, 'the refreshed card names the plugin');
  assert.match(page.textContent, /ที่มา: \/tmp\/chime\.mjs/, 'and shows where it came from');
});

test('a refused install says which step closed the door', async () => {
  // An install can fail in four places — the fetch, the validation, the
  // name, the swap. A box that only says "err" leaves the person guessing
  // which one happened.
  const backend = {
    ...BACKEND,
    'plugins.inspect': () => ({ kind: 'git', ref: 'github:acme/plugins#main', entry: 'plugin.mjs', size: 120, sha256: 'ab'.repeat(32) }),
    'plugins.install': () => {
      const err = new Error('the source changed since it was inspected — inspect it again');
      err.stage = 'fetch';
      throw err;
    },
  };
  const { node, tick } = await bootApp(backend);
  node('settings-btn').dispatch('click');
  await tick(); await tick(); await tick();

  const shell = node('modal-body').children.find((c) => /settings/.test(c.className));
  const rail = shell.children.find((c) => /settings-nav/.test(c.className));
  rail.children.find((b) => /ปลั๊กอิน/.test(b.textContent)).dispatch('click');
  await tick();
  const pages = shell.children.find((c) => /settings-pages/.test(c.className));
  const page = pages.children.find((p) => p.dataset.page === 'plugins');

  const walk = (n, out = []) => { out.push(n); for (const c of n.children ?? []) walk(c, out); return out; };
  const input = walk(page).find((n) => n.tagName === 'INPUT' && /path|https/.test(n.placeholder ?? ''));
  input.value = 'github:acme/plugins#main';
  walk(page).find((n) => n.tagName === 'BUTTON' && n.textContent === 'ตรวจสอบ').dispatch('click');
  await tick(); await tick();

  assert.match(page.textContent, /ชนิด: git/, 'the report says the source is fetched, not local');

  const installBtn = walk(page).find((n) => n.tagName === 'BUTTON' && n.textContent === 'ติดตั้ง');
  installBtn.dispatch('click');
  await tick(); await tick(); await tick();

  assert.match(page.textContent, /err: the source changed/, 'the refusal is on screen');
  assert.match(page.textContent, /ขั้นตอน: ดึงไฟล์/, 'and it names the step that closed');
});

test('the MCP page lists servers, tests one, and adds one from its form', async () => {
  const added = [];
  const tested = [];
  const servers = [
    { name: 'fs', scope: 'home', enabled: true, connected: true, risk: 'write', command: 'npx', args: ['-y', 'pkg'], tools: 2, error: null, file: '/h/mcp.json' },
    { name: 'slow', scope: 'project', enabled: false, connected: false, risk: 'read', command: 'x', args: [], tools: 0, error: null, file: '/p/mcp.json' },
  ];
  const backend = {
    ...BACKEND,
    'mcp.list': () => ({ servers, tools: [{ marker: 'MCP__fs__read', description: 'read a file', risk: 'write' }] }),
    'mcp.test': (params) => { tested.push(params); return { ok: true, ms: 12, tools: [{ name: 'echo', description: '' }] }; },
    'mcp.add': (params) => { added.push(params); return { server: { name: params.name, scope: params.scope }, servers, tools: [] }; },
  };
  const { node, tick } = await bootApp(backend);
  node('settings-btn').dispatch('click');
  await tick(); await tick(); await tick();

  const shell = node('modal-body').children.find((c) => /settings/.test(c.className));
  const rail = shell.children.find((c) => /settings-nav/.test(c.className));
  const mcpTab = rail.children.find((b) => /MCP/.test(b.textContent));
  assert.ok(mcpTab, 'the sheet grew an MCP category');
  mcpTab.dispatch('click');
  await tick();
  const pages = shell.children.find((c) => /settings-pages/.test(c.className));
  const page = pages.children.find((p) => p.dataset.page === 'mcp');
  assert.ok(page, 'the MCP page is in the sheet');
  assert.match(page.textContent, /fs/, 'the connected server is listed');
  assert.match(page.textContent, /npx -y pkg/, 'with the command it runs');
  assert.match(page.textContent, /slow/, 'and the disabled one too');
  assert.match(page.textContent, /โปรเจกต์นี้/, 'naming its scope');

  const walk = (n, out = []) => { out.push(n); for (const c of n.children ?? []) walk(c, out); return out; };
  const testBtn = walk(page).find((n) => n.tagName === 'BUTTON' && n.textContent === 'ทดสอบ');
  testBtn.dispatch('click');
  await tick(); await tick();
  assert.deepEqual(tested, [{ name: 'fs', scope: 'home' }], 'ทดสอบ asked the backend to connect');
  assert.match(page.textContent, /เชื่อมต่อได้/, 'and the verdict lands in the card');

  const field = (ph) => walk(page).find((n) => n.placeholder === ph);
  field('ชื่อ (a-z 0-9 - _)').value = 'echo';
  field('คำสั่ง เช่น npx').value = 'node';
  field('อาร์กิวเมนต์ บรรทัดละตัว').value = 'srv.mjs\n--flag';
  field('env บรรทัดละ K=V (ไม่บังคับ)').value = 'A=1';
  walk(page).find((n) => n.tagName === 'BUTTON' && n.textContent === 'บันทึก').dispatch('click');
  await tick(); await tick();
  assert.deepEqual(added, [{
    name: 'echo', command: 'node', args: ['srv.mjs', '--flag'], env: { A: '1' }, risk: 'write', scope: 'home',
  }], 'the form sends exactly what the CLI takes');
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

test('the welcome card names an empty credit pool instead of reading as broken', async () => {
  // Credits ride a second rpc (force:false while idle), so the fake backend
  // answers quota separately from status — exactly like the real one.
  const backend = { ...BACKEND, credits: () => ({ available: 0, limit: 10000 }) };
  const { screen, tick } = await bootApp(backend);
  await tick(); await tick(); // refreshReadiness awaits the credits call
  const card = screen('welcome');
  assert.ok(card, 'an empty screen must not be an empty screen');
  assert.match(card.textContent, /เครดิต 0/, 'the pool is named, with its figure');
  assert.match(card.textContent, /free-credit/, 'and the way out is named');
});

test('a spent quota maps to the Thai copy, not the raw English', async () => {
  // The run rpc itself throws: sendTask catches and maps through friendly().
  const backend = { ...BACKEND, run: () => { throw new Error('quota exceeded for this period'); } };
  const { node, tick } = await bootApp(backend);
  node('task').value = 'do work';
  node('task').dispatch('keydown', { key: 'Enter' });
  await tick(); await tick();
  assert.match(node('log').textContent, /เครดิตหมด/, 'the error reads as the fix');
});

test('the window says it is working while a run is in flight', async () => {
  // A run takes minutes, and the question the reader asks it the whole time
  // is "is it still doing something?". The answer has to be on screen the
  // whole time — a bar with a clock over the transcript — and it has to stop
  // when the run stops, or the reader learns not to believe it.
  const { node, tick } = await bootApp(BACKEND);
  assert.equal(node('working').classList.contains('hidden'), true, 'an idle window says nothing');

  const task = node('task');
  task.value = 'a slow task';
  task.dispatch('keydown', { key: 'Enter' });
  await tick();
  assert.equal(node('working').classList.contains('hidden'), false, 'the bar is up while the run works');
  assert.match(node('working-text').textContent, /กำลังทำงาน/, 'and it says what is happening');
  assert.match(node('working-time').textContent, /^\d+s$/, 'and it carries a clock');
  assert.equal(node('log').classList.contains('busy'), true, 'the log makes room for the bar');
  assert.equal(node('send').textContent, 'หยุด', 'and the button is the stop');

  globalThis.__stream.emit('finished', { summary: '', stopReason: 'done', spent: 0 });
  await tick();
  assert.equal(node('working').classList.contains('hidden'), true, 'and it goes down with the run');
  assert.equal(node('log').classList.contains('busy'), false, 'and the log takes its room back');
});

test('a reloaded window comes back with its conversation, not the welcome card', async () => {
  // Ctrl+R reloads the window. What came back used to be the welcome card
  // over an empty screen: the boot paints the card, and the card says
  // "there is nothing here" — over a run that was still going. The card is
  // the note for an EMPTY window, and the conversation has to come back
  // with it.
  const backend = {
    ...BACKEND,
    snapshot: () => ({
      status: { root: '/tmp/proj', running: true },
      session: { id: 's1', title: 'one' },
      entries: [
        { type: 'task', text: 'the question' },
        { type: 'assistant', text: 'the answer' },
      ],
      pending: [],
      asks: {},
    }),
  };
  const { node, tick } = await bootApp(backend);
  assert.ok(node('log').children.some((c) => c.id === 'welcome'), 'the boot paints the welcome card');

  globalThis.__stream.emit('open', {});
  await tick(); await tick(); await tick();

  const log = node('log');
  assert.equal(log.children.some((c) => c.id === 'welcome'), false, 'the card is gone');
  assert.match(log.textContent, /the question/, 'and the conversation is back');
  assert.equal(node('working').classList.contains('hidden'), false, 'and the window says the run is still working');
  assert.equal(node('send').textContent, 'หยุด', 'so the stop is one click away');
});

test('the window hands the extension its token, in one click', async () => {
  // The bridge knows the extension was refused for a missing token. The
  // window cannot paste into the extension's popup, but it can put the token
  // it already holds on the clipboard — so the one step that only the popup
  // can do is a paste, not a hunt through the home directory.
  const backend = {
    ...BACKEND,
    status: () => ({ ...BACKEND.status(), extensions: 0, extensionToken: 'missing' }),
  };
  const written = [];
  const prevNav = globalThis.navigator;
  Object.defineProperty(globalThis, 'navigator', {
    value: { clipboard: { writeText: async (text) => { written.push(text); } } },
    configurable: true, writable: true,
  });
  try {
    const { node, tick } = await bootApp(backend, { token: 'tok-for-the-extension' });
    await tick(); await tick();
    const bar = node('log').children.find((c) => /needs-tab/.test(c.className ?? ''));
    assert.ok(bar, 'the banner appears');
    assert.match(bar.textContent, /token/, 'and it names the token');
    const btn = bar.children.find((c) => c.tagName === 'BUTTON');
    assert.ok(btn, 'with the fix attached');
    btn.dispatch('click');
    await tick(); await tick();
    assert.deepEqual(written, ['tok-for-the-extension'], 'the token went to the clipboard');
  } finally {
    Object.defineProperty(globalThis, 'navigator', { value: prevNav, configurable: true, writable: true });
  }
});

test('a token refusal does not send the reader to the extension popup', async () => {
  // The extension talks to the bridge, not to the window: a token the window
  // or the harness was refused with says nothing about the extension's
  // token, and sending the reader to paste one into the popup fixed
  // nothing. The two sides read the same file.
  const backend = { ...BACKEND, run: () => { throw new Error('bridge returned 401: unauthorized: missing or wrong loopback bearer token'); } };
  const { node, tick } = await bootApp(backend);
  node('task').value = 'do work';
  node('task').dispatch('keydown', { key: 'Enter' });
  await tick(); await tick();
  const text = node('log').textContent;
  assert.doesNotMatch(text, /\.aipass\/\.token/, 'the token file is not the answer any more');
  assert.match(text, /ปฏิเสธ token/, 'but it is still a token refusal');
});

test('the window names the extension\'s token when that is what is missing', async () => {
  // "extensions: 0" hides two jobs: the extension was never loaded, or the
  // bridge refused it for want of the token. The bridge says which, and the
  // window repeats it.
  const backend = {
    ...BACKEND,
    status: () => ({ ...BACKEND.status(), extensions: 0, extensionToken: 'missing' }),
    run: () => { throw new Error('no extension connected'); },
  };
  const { node, tick } = await bootApp(backend);
  node('task').value = 'do work';
  node('task').dispatch('keydown', { key: 'Enter' });
  await tick(); await tick();
  assert.match(node('log').textContent, /extension ยังไม่ได้รับ token/, 'the copy names the token, not the extension');
});

test('every command in the palette has a handler that resolves', async () => {
  const { node, calls, tick } = await bootApp(BACKEND);
  const task = node('task');
  // Exercise the whole list the way a user would: type each one and send it.
  const names = ['/help', '/status', '/paint', '/new', '/resume', '/fork', '/plan', '/skills', '/diff', '/discard', '/project', '/settings', '/stop', '/models', '/conversations', '/fresh'];
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
  const html = bubbleHtml(bubble);
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
  assert.match(bubbleHtml(bubbles[0]), /first step prose/);
  assert.match(bubbleHtml(bubbles[1]), /second step prose/);
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
  const html = bubbleHtml(first);
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
  assert.equal(bubbleHtml(second).split('All clear.').length - 1, 1, 'not doubled');

  // A bare DONE with no prose above it still leaves the reader something.
  globalThis.__stream.emit('assistant_delta', { text: 'DONE fixed the bug' });
  globalThis.__stream.emit('done_line', { text: 'fixed the bug' });
  await tick();
  const third = node('log').children.filter((c) => c.className.includes('assistant')).at(-1);
  assert.match(bubbleHtml(third), /fixed the bug/);
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
  sessionRows(node('sessions'))[0].dispatch('click');
  await tick(); await tick();
  const bodies = node('log').children
    .filter((c) => c.className.includes('assistant'))
    .map((c) => bubbleHtml(c));
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
  const html = bubbleHtml(bubble);
  assert.match(html, /Echoing now\./);
  assert.match(html, /That is all\./);
  assert.equal(/ECHO hello there/.test(html), false, 'the plugin call is a row, not prose');
});

test('a long answer paints its settled paragraphs once and repaints only the tail', async () => {
  // Repainting a streaming answer used to re-parse every paragraph it had
  // already shown, once per frame — the cost of a paint grew with the answer,
  // so long replies stuttered. The settled stretch renders once now; only the
  // unfinished tail is repainted, and a closed paragraph moves into the
  // settled layer without being dropped.
  const { node, tick } = await bootApp(BACKEND);
  globalThis.__stream.emit('assistant_delta', { text: 'para one\n\npara two' });
  await tick();
  const bubble = node('log').children.find((c) => c.className.includes('assistant'));
  const body = bubble.children[0];
  const [settled, moving] = body.children;
  assert.match(settled.innerHTML, /para one/, 'the finished paragraph settles');
  assert.match(moving.innerHTML, /para two/, 'the growing paragraph is the tail');
  const settledHtml = settled.innerHTML;

  globalThis.__stream.emit('assistant_delta', { text: ' continues' });
  await tick();
  assert.equal(body.children[0], settled, 'the settled layer is not replaced');
  assert.equal(body.children[0].innerHTML, settledHtml, 'and it is not repainted while the tail grows');
  assert.match(body.children[1].innerHTML, /para two continues/, 'only the tail moves');

  globalThis.__stream.emit('assistant_delta', { text: '\n\npara three' });
  await tick();
  assert.match(body.children[0].innerHTML, /para two continues/, 'the closed paragraph moved into the settled layer');
  assert.match(body.children[1].innerHTML, /para three/, 'and the new paragraph is the tail');
});

test('the settled layer is appended to, never rewritten', async () => {
  // The settled layer used to have its innerHTML reassigned every time a
  // paragraph closed: the browser re-parsed every paragraph already on screen,
  // so the cost of a frame grew with the answer. It is appended to now, and
  // the string it holds is the same one it always showed.
  const { node, tick } = await bootApp(BACKEND);
  globalThis.__stream.emit('assistant_delta', { text: 'para one\n\npara two' });
  await tick();
  globalThis.__stream.emit('assistant_delta', { text: '\n\npara three' });
  await tick();
  const bubble = node('log').children.find((c) => c.className.includes('assistant'));
  const settled = bubble.children[0].children[0];
  assert.equal(settled.htmlWrites ?? 0, 0, 'the settled layer is never reassigned');
  assert.ok(settled.insertions >= 2, `it is appended to (${settled.insertions} appends)`);
  assert.match(settled.innerHTML, /para one/, 'and it still holds everything');
  assert.match(settled.innerHTML, /para two/, 'including the paragraph that just closed');
});

test('the attach button is a button, and a key on it is its own business', async () => {
  // A file row is a button, and the แนบ button inside it is a button too. The
  // row's key handler used to swallow the key and cancel the inner button's
  // own activation, so Enter on แนบ opened the file instead of attaching it —
  // and a keyboard user could not attach a file at all.
  const { node, calls, tick } = await bootApp({
    ...BACKEND,
    'fs.list': () => [{ name: 'guide.md', dir: false }],
    'fs.read': () => ({ file: 'guide.md', text: 'hello' }),
    'attachment.stage': () => ({ id: 'att1', name: 'guide.md', bytes: 12, mime: 'text/markdown' }),
  });
  await tick(); await tick(); await tick();
  const file = node('files').children.find((li) => li.textContent.includes('guide.md'));
  const attach = file.children.find((c) => c.tagName === 'BUTTON' && c.textContent === 'แนบ');
  assert.ok(attach, 'the row carries an attach button');

  attach.dispatch('keydown', { key: 'Enter' });
  assert.equal(attach.lastEvent.defaultPrevented, false,
    'the row did not cancel the key — the button may act on it');
  await tick(); await tick();
  assert.ok(!calls.includes('fs.read'), 'and the file did not open instead');
});

test('the settings sheet stops its meter when it closes', async () => {
  // The meter's timer used to be written into the modal's dataset and never
  // read, so every "คืนค่าเดิม" — which closes the sheet and opens it again —
  // left another one polling the backend forever.
  const { node, tick, timers } = await bootApp(BACKEND);
  const before = timers.size;
  node('settings-btn').dispatch('click');
  await tick(); await tick(); await tick();
  assert.ok(timers.size > before, 'the sheet started its meter');

  // Close it the way the window does.
  const close = node('modal-actions').children.find((c) => c.textContent === 'ปิด');
  close.dispatch('click');
  await tick(); await tick();
  assert.equal(timers.size, before, 'and closing it stopped the timer');
});

test('the auto theme follows the system when the system changes its mind', async () => {
  // "auto" means the system's choice, and the system's choice changes while
  // the window is open — a machine that goes to bed at sunset. The theme
  // used to be read once and then go stale until the window was reloaded.
  const { node, tick, system } = await bootApp({
    ...BACKEND,
    'settings.get': () => ({ ...BACKEND['settings.get'](), theme: 'auto' }),
  });
  await tick(); await tick();
  assert.equal(globalThis.document.documentElement.dataset.theme, 'dark', 'the system is dark for now');

  system.light = true;
  await tick(); await tick();
  assert.equal(globalThis.document.documentElement.dataset.theme, 'light', 'and the window followed it');
});

test('a failed action says so instead of doing nothing', async () => {
  // The button paths had no error handling: a rejected call was an unhandled
  // rejection in the console and nothing at all on screen — the person
  // pressed Apply and the app went quiet.
  const { node, tick } = await bootApp({
    ...BACKEND,
    'apply': () => { throw new Error('the disk is full'); },
  });
  await tick(); await tick(); await tick();
  globalThis.__stream.emit('diff_update', { changes: [{ file: 'a.mjs', added: 1, removed: 0, deleted: false, isNew: false }] });
  await tick(); await tick();
  const box = node('pending-list').children[0].children[0];
  assert.equal(box.checked, true, 'the change is on the panel');

  node('apply').dispatch('click');
  await tick(); await tick();
  assert.match(node('log').textContent, /เขียนไฟล์ไม่ได้/, 'and the window says what went wrong');
});

test('the paint cache counts hits and misses, and /paint answers with them', async () => {
  // The counters behind the settled layer: a frame that appends to it is a
  // hit, a frame that has to reset it is a miss, and a frame with nothing
  // settled yet is cold. The miss here is the real one the code comment
  // names: the plugin table arrives late, the next paint re-parses the same
  // prose with the marker line now hidden, and the settled stretch has to be
  // rendered again. /paint prints all of it.
  let releasePlugins;
  const pluginsReady = new Promise((resolve) => { releasePlugins = resolve; });
  const backend = {
    ...BACKEND,
    'plugins.list': () => pluginsReady.then(() => ({
      dir: '', loaded: [], failed: [], tools: [], toolDefs: [{ marker: 'ECHO', takesBody: false }], panels: [],
    })),
  };
  const { node, tick } = await bootApp(backend);
  globalThis.__stream.emit('assistant_delta', { text: 'intro para\n\nECHO hello there\n\nend para' });
  await tick();
  globalThis.__stream.emit('assistant_delta', { text: ' more' });
  await tick();
  releasePlugins(); // the table lands between frames
  await tick(); await tick();
  globalThis.__stream.emit('assistant_delta', { text: ' tail' });
  await tick();

  const task = node('task');
  task.value = '/paint';
  task.dispatch('keydown', { key: 'Enter' });
  await tick();
  const out = node('log').textContent;
  assert.match(out, /hit rate 50\.0%/, 'one kept frame of two warm frames — the late table forced a reset');
  assert.match(out, /hit 1/);
  assert.match(out, /miss 1/);
  assert.match(out, /append 43 ตัวอักษร/, 'the settled text that rode the cache adds up: 30 before the reset, 13 after');
  assert.match(out, /repaint 30 ตัวอักษร/, 'the miss names the settled stretch it had to render again');
});

test('a status payload with cache counters prints the cache line', async () => {
  // The bridge counts how often each of its caches (models, credits,
  // conversations) answered instead of the tab; /status carries them and the
  // window prints one line. An old bridge omits the block and the line with it.
  const backend = {
    ...BACKEND,
    status: () => ({
      ...BACKEND.status(),
      cache: {
        models: { hits: 12, fetches: 1 },
        quota: { hits: 30, fetches: 2 },
        conversation: { hits: 3, fetches: 1 },
      },
    }),
  };
  const { node, tick } = await bootApp(backend);
  const task = node('task');
  task.value = '/status';
  task.dispatch('keydown', { key: 'Enter' });
  await tick();
  const out = node('log').textContent;
  assert.match(out, /cache: โมเดล 12 hit \/ 1 fetch · เครดิต 30 hit \/ 2 fetch · บทสนทนา 3 hit \/ 1 fetch/);
});

test('repainting a plugin panel replaces its body instead of stacking copies', async () => {
  // The finished event repaints every panel after every run. The old repaint
  // appended one more body each time — the scratchpad grew a second copy of
  // its history in the sidebar per run. The panels live in the settings sheet
  // now, next to the plugin that draws them.
  let note = 'note one';
  const { node, tick } = await bootApp({
    ...BACKEND,
    'plugins.list': () => ({ dir: '', loaded: [], failed: [], tools: [], panels: [{ id: 'notes', title: 'scratchpad' }] }),
    'panel.render': () => ({ html: `<ul><li>${note}</li></ul>` }),
  });
  node('settings-btn').dispatch('click');
  await tick(); await tick(); await tick();
  const shell = node('modal-body').children.find((c) => /settings/.test(c.className));
  const rail = shell.children.find((c) => /settings-nav/.test(c.className));
  rail.children.find((b) => /ปลั๊กอิน/.test(b.textContent)).dispatch('click');
  await tick();
  const pages = shell.children.find((c) => /settings-pages/.test(c.className));
  const page = pages.children.find((p) => p.dataset.page === 'plugins');
  const holder = page.children.find((c) => /plugin-panels/.test(c.className));
  const box = holder.children.find((c) => c.dataset.panel === 'notes');
  assert.ok(box, 'the panel is in the sheet');
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

test('the theme button says which theme is on', async () => {
  // A title is a tooltip, not a name: a screen reader does not read it when
  // the control takes focus, so the state the button carried was never
  // announced. The button names the theme that is on now.
  const { node, tick } = await bootApp(BACKEND);
  assert.equal(node('theme-toggle').getAttribute('aria-label'), 'ธีม: มืด', 'the saved theme is announced');
  node('theme-toggle').dispatch('click');
  await tick();
  assert.equal(node('theme-toggle').getAttribute('aria-label'), 'ธีม: สว่าง', 'and the name follows the flip');
});

test('the transcript holds its announcements while a run streams, and releases them when it ends', async () => {
  // The log is a live region and the answer is painted frame by frame: a
  // region that announced every frame read the same half-written sentence
  // again and again. aria-busy says "not yet" — the answer is read once, when
  // the run ends.
  const { node, tick } = await bootApp(BACKEND);
  assert.equal(node('log').getAttribute('aria-busy'), 'false', 'the transcript starts quiet');

  globalThis.__stream.emit('task_start', { task: 'do the thing' });
  await tick();
  assert.equal(node('log').getAttribute('aria-busy'), 'true', 'the run holds the announcements');

  globalThis.__stream.emit('finished', { summary: 'เสร็จแล้ว', stopReason: 'done', spent: 0, credits: null });
  await tick(); await tick();
  assert.equal(node('log').getAttribute('aria-busy'), 'false', 'and the end of the run releases them');
});

test('the change count reads in the language of the window around it', async () => {
  // The pending panel is Thai; the badge was the only English left in it.
  const { node, tick } = await bootApp({
    ...BACKEND,
    pending: () => [{ file: 'a.mjs', added: 2, removed: 1, deleted: false, isNew: false }],
  });
  await tick(); await tick();
  assert.equal(node('pending-count').textContent, '1 การเปลี่ยนแปลง');
});

test('the rail folds away and says whether it is open', async () => {
  // The ☰ controls were <label>s: a label is not a widget, so the keyboard
  // could not reach them and a screen reader had no name to announce. They
  // are buttons now, and they say whether the rail is open.
  const { node, tick } = await bootApp(BACKEND);
  assert.equal(node('side-toggle').getAttribute('aria-expanded'), 'true', 'the rail starts open');

  node('side-toggle').dispatch('click');
  await tick();
  assert.equal(node('nav-toggle').checked, true, 'the ☰ folded the rail');
  assert.equal(node('side-toggle').getAttribute('aria-expanded'), 'false', 'and the button says so');

  node('side-toggle-side').dispatch('click');
  await tick();
  assert.equal(node('nav-toggle').checked, false, 'the second ☰ opens it again');
  assert.equal(node('side-toggle-side').getAttribute('aria-expanded'), 'true');
});

test('the rail starts a session, and the foot opens the rest of the app', async () => {
  // The rail used to carry a "New Conversation" line under the history that
  // did the same thing as the button above it, plus two rows that led nowhere
  // (one focused the composer, one duplicated the attach button). The rail is
  // the work now: start a chat, search it, walk the project's files — and the
  // foot is the way to everything else.
  const { node, calls, tick } = await bootApp(BACKEND);
  const before = calls.length;
  node('new-session').dispatch('click');
  await tick();
  assert.ok(calls.slice(before).includes('session.new'), 'แชทใหม่ does what it says');

  node('side-settings').dispatch('click');
  await tick(); await tick(); await tick();
  assert.equal(node('modal').classList.contains('hidden'), false, 'ตั้งค่า opens the sheet');
  assert.equal(node('modal').classList.contains('settings-sheet'), true, 'and it is the settings sheet');

  node('modal-actions').children.find((b) => /ปิด/.test(b.textContent)).dispatch('click');
  node('side-help').dispatch('click');
  await tick();
  assert.equal(node('modal').classList.contains('hidden'), false, 'วิธีใช้ opens the guide');
  assert.match(node('modal-title').textContent, /วิธีใช้/);
});

test('the rail carries no playbook row and no plugin row — the settings sheet has both', async () => {
  // Two folded headings used to sit in the rail: "คู่มือ" and "ปลั๊กอิน".
  // Clicking one opened a box you had to guess at, in a column whose job is the
  // work. Both moved into the settings sheet, next to what configures them.
  const html = fs.readFileSync(path.join(repo, 'desktop', 'ui', 'index.html'), 'utf8');
  assert.ok(!html.includes('id="skills-group"'), 'the rail has no playbook row');
  assert.ok(!html.includes('id="plugins-group"'), 'and no plugin row');

  const { node, tick } = await bootApp({
    ...BACKEND,
    'skills.list': () => [{ name: 'writing', file: 'skills/writing.md' }],
    'plugins.list': () => ({ dir: '/tmp/plugins', loaded: [{ name: 'notes' }], failed: [], tools: [], panels: [{ id: 'notes', title: 'scratchpad' }] }),
  });
  node('settings-btn').dispatch('click');
  await tick(); await tick(); await tick();
  const shell = node('modal-body').children.find((c) => /settings/.test(c.className));
  const pages = shell.children.find((c) => /settings-pages/.test(c.className));

  const skillPage = pages.children.find((p) => p.dataset.page === 'skills');
  assert.ok(skillPage, 'the sheet has a playbook page');
  assert.match(skillPage.textContent, /writing/, 'and it lists the playbooks on disk');

  const pluginPage = pages.children.find((p) => p.dataset.page === 'plugins');
  assert.ok(pluginPage, 'the sheet has a plugins page');
  assert.match(pluginPage.textContent, /scratchpad/, 'and the panels the plugins draw');
});

test('a playbook opens in place, under its own row', async () => {
  // A second modal on top of the settings sheet would take the settings away
  // while you read — so the playbook opens where it is listed.
  const { node, tick } = await bootApp({
    ...BACKEND,
    'skills.list': () => [{ name: 'writing', file: 'skills/writing.md' }],
    'skills.load': () => ({ text: 'step one\nstep two' }),
  });
  node('settings-btn').dispatch('click');
  await tick(); await tick(); await tick();
  const shell = node('modal-body').children.find((c) => /settings/.test(c.className));
  const pages = shell.children.find((c) => /settings-pages/.test(c.className));
  const skillPage = pages.children.find((p) => p.dataset.page === 'skills');
  const row = skillPage.children.find((c) => /skill-list/.test(c.className)).children[0];
  const body = row.children.find((c) => /skill-body/.test(c.className));
  assert.equal(body.hidden, true, 'the playbook is closed to begin with');

  row.dispatch('click');
  await tick(); await tick();
  assert.equal(body.hidden, false, 'clicking the row opens it');
  assert.match(body.textContent, /step one/, 'and the playbook is there');

  row.dispatch('click');
  await tick(); await tick();
  assert.equal(body.hidden, true, 'clicking it again puts it away');
});

test('the search field is a field, and it counts the history it filters', async () => {
  // "ค้นหาแชท" used to be a row that pointed at a box folded away inside
  // another row — clicking it focused something you could not see, so it read
  // as a broken button. The search is now on screen, and it says how much
  // history there is to search.
  const { node, tick } = await bootApp(BACKEND);
  assert.equal(node('session-count').textContent, '2', 'the history says how many sessions there are');

  node('session-filter').value = 'one';
  node('session-filter').dispatch('input');
  await settle();
  const titles = sessionRows(node('sessions')).map((li) => li.textContent);
  assert.equal(titles.length, 1, 'the list is filtered');
  assert.match(titles[0], /one/);
});

/* ------------------------------------------------------------------ updates */

test('the update notice is a banner with one button, and the click is the consent', async () => {
  // The update is OFFERED, never taken: the window shows the version it
  // found, and the person clicks. The click is the only thing that sends
  // anything to the backend.
  const backend = {
    ...BACKEND,
    'update.check': () => ({
      ok: true,
      checkedAt: Date.now(),
      fromCache: false,
      stale: false,
      reason: null,
      current: { content: '0.2.0', shell: '0.2.0', source: 'bundle' },
      available: {
        content: {
          version: '0.2.1',
          file: 'aipass-content-0.2.1.json.gz',
          bytes: 517784,
          sha256: 'a'.repeat(64),
          notes: 'the release notes',
          minShell: '0.2.0',
        },
      },
    }),
    'update.apply': () => ({ ok: true, version: '0.2.1', restart: true }),
  };
  const window_ = await bootApp(backend);
  const { node, calls, tick } = window_;
  await tick(); await tick();
  const log = node('log').textContent;
  assert.match(log, /0\.2\.1/, 'the banner names the version it found');
  assert.equal(calls.includes('update.apply'), false, 'and nothing is applied on its own');

  // The banner's button is the consent.
  const bar = node('log').children.find((c) => (c.className ?? '').includes('update-bar'));
  assert.ok(bar, 'the notice is a bar of its own');
  const install = bar.children.find((c) => c.tagName === 'BUTTON' && /อัปเดต/.test(c.textContent));
  assert.ok(install, 'with the update button on it');
  install.dispatch('click');
  await tick(); await tick();
  assert.ok(calls.includes('update.apply'), 'the click is what applies it');
  // The new content needs a new backend and a new window: the page waits for
  // the backend and reloads, so the window's own files are the new ones.
  // The wait is a poll, not a fixed pause — the reload lands a beat after
  // the backend answers, and a beat is not a fixed number of milliseconds.
  for (let i = 0; i < 50 && window_.reloaded === 0; i += 1) {
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(window_.reloaded, 1, 'and the window reloads once the backend is back');
});

test('the shell update says the app will close, and an unsigned installer is refused', async () => {
  // The binary is replaced by the installer, and the app has to be closed
  // for it — so the button says that, rather than the app vanishing.
  const backend = {
    ...BACKEND,
    'update.check': () => ({
      ok: true,
      checkedAt: Date.now(),
      fromCache: false,
      stale: false,
      reason: null,
      current: { content: '0.2.1', shell: '0.2.0', source: 'bundle' },
      available: {
        shell: {
          version: '0.2.1',
          file: 'aipass-desktop-0.2.1-windows-x64-setup.exe',
          bytes: 242392264,
          sha256: 'b'.repeat(64),
          signature: 'unsigned',
          notes: '',
        },
      },
    }),
    // What the backend answers for an unsigned installer: the refusal, and
    // the reason in the app's own words.
    'update.install': () => ({ ok: false, reason: 'the installer is not signed yet — the app does not replace itself with an unsigned installer' }),
  };
  const { node, calls, tick } = await bootApp(backend);
  await tick(); await tick();
  const bar = node('log').children.find((c) => (c.className ?? '').includes('update-bar'));
  assert.ok(bar, 'the notice is a bar of its own');
  const reinstall = bar.children.find((c) => c.tagName === 'BUTTON' && /ติดตั้งเวอร์ชันนี้/.test(c.textContent));
  assert.ok(reinstall, 'with the install button on it');
  assert.match(reinstall.textContent, /ปิดแล้วเปิดใหม่/, 'and it says the app will close');

  reinstall.dispatch('click');
  await tick(); await tick();
  assert.ok(calls.includes('update.install'), 'the click asks for the handover');
  assert.match(
    node('log').textContent,
    /ไม่ได้ติดตั้ง|not signed|ไม่สำเร็จ/,
    'and the refusal is on screen, not swallowed',
  );
});

test('the update check does not nag when there is nothing new', async () => {
  // An app that cries wolf about updates is an app people mute. No release,
  // no banner.
  const backend = {
    ...BACKEND,
    'update.check': () => ({
      ok: true,
      checkedAt: Date.now(),
      fromCache: false,
      stale: false,
      reason: null,
      current: { content: '0.2.0', shell: '0.2.0', source: 'bundle' },
      available: {},
    }),
  };
  const { node, tick } = await bootApp(backend);
  await tick(); await tick();
  const bar = node('log').children.find((c) => (c.className ?? '').includes('update-bar'));
  assert.equal(bar, undefined, 'no notice when there is nothing to say');
});

test('the status line names both halves of the build', async () => {
  // "Which build is running" has to have an answer, and the build is two
  // things: the binary and the content. The shell's version and the content's
  // are both on screen.
  const backend = {
    ...BACKEND,
    status: () => ({
      ...BACKEND.status(),
      app: '0.2.1',
      shell: '0.2.0',
      source: 'overlay',
    }),
  };
  const { node, tick } = await bootApp(backend);
  const task = node('task');
  task.value = '/status';
  task.dispatch('keydown', { key: 'Enter' });
  await tick(); await tick();
  const log = node('log').textContent;
  assert.match(log, /0\.2\.1/, 'the content version is named');
  assert.match(log, /0\.2\.0/, 'and the shell version');
  assert.match(log, /อัปเดตที่ติดตั้งไว้/, 'and where the code came from');
});
