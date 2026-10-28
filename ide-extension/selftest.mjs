// The extension's own self-test.
//
// Run it with:  node ide-extension/selftest.mjs
// (or `npm run selftest` from inside `ide-extension/`).
//
// It drives the PURE parts of the extension — the ones that can be wrong
// without an editor or a backend around them: where the port comes from, how
// the token is read, what a request body looks like, how one SSE frame is
// parsed, and which wire markers must never reach the reader.
//
// It exits non-zero when anything fails, so it can be a gate.
//
// The repository's own suite (node --test over aipass-bridge/test/*.test.mjs)
// is not touched: that directory belongs to another agent, and this file is
// the extension's own contract check.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
// The pure half is CommonJS (the extension host loads it with `require`), so
// the ESM test reaches it through the default export.
import protocol from './lib/protocol.js';
import backend from './lib/backend.js';

const { createBackend, BackendError } = backend;

const here = path.dirname(fileURLToPath(import.meta.url));

/* ------------------------------------------------------------- the tiny runner */

const results = [];
const checks = [];
let failed = 0;

/**
 * One check. It may be async — the transport checks drive a real socket.
 *
 * @param {string} name
 * @param {() => void|Promise<void>} fn
 */
function check(name, fn) {
  checks.push([name, fn]);
}

/* ------------------------------------------------------------------- the port */

check('the port falls back to 8790', () => {
  assert.equal(protocol.resolvePort({}), 8790);
  assert.equal(protocol.resolvePort({ settings: {}, env: {} }), 8790);
  assert.equal(protocol.DEFAULT_DESKTOP_PORT, 8790);
});

check('the settings file may name the port', () => {
  assert.equal(protocol.resolvePort({ settings: { desktopPort: 9100 } }), 9100);
  assert.equal(protocol.resolvePort({ settings: { desktopPort: '9100' } }), 9100);
});

check('the environment wins, because the launcher reads it', () => {
  // harness/launcher.mjs resolveDesktopPort reads AIPASS_DESKTOP_PORT, so a
  // backend started with it is on that port whatever a file says.
  assert.equal(protocol.resolvePort({ settings: { desktopPort: 9100 }, env: { AIPASS_DESKTOP_PORT: '9200' } }), 9200);
});

check('a value that is not a port is ignored, not believed', () => {
  for (const bad of [0, 65536, -1, '0x50', '1e3', '', 'abc', ' ', '8790.5', null, undefined, {}]) {
    assert.equal(protocol.resolvePort({ settings: { desktopPort: bad }, env: { AIPASS_DESKTOP_PORT: bad } }), 8790);
  }
});

check('a port is a port', () => {
  assert.equal(protocol.isPort(8790), true);
  assert.equal(protocol.isPort('8790'), true);
  assert.equal(protocol.isPort('+8790'), true);
  assert.equal(protocol.isPort(0), false);
  assert.equal(protocol.isPort(65536), false);
  assert.equal(protocol.isPort('0x50'), false);
});

/* ------------------------------------------------------------------- the token */

check('the token is trimmed, and an empty file is no token', () => {
  assert.equal(protocol.resolveToken('  abc123\n'), 'abc123');
  assert.equal(protocol.resolveToken('abc123'), 'abc123');
  assert.equal(protocol.resolveToken('   '), null);
  assert.equal(protocol.resolveToken(''), null);
  assert.equal(protocol.resolveToken(null), null);
  assert.equal(protocol.resolveToken(undefined), null);
  assert.equal(protocol.resolveToken(12345), null);
});

/* ------------------------------------------------------------ the request shape */

check('the request body is the backend\'s shape', () => {
  assert.equal(
    protocol.buildRpcBody('run', { task: 'แก้บั๊ก' }),
    '{"method":"run","params":{"task":"แก้บั๊ก"}}',
  );
  assert.equal(protocol.buildRpcBody('status'), '{"method":"status","params":{}}');
});

check('both transports carry the token', () => {
  const headers = protocol.buildRpcHeaders({ token: 'secret', project: 'C:\\p' });
  assert.equal(headers.authorization, 'Bearer secret');
  assert.equal(headers['x-aipass-project'], 'C:\\p');
  assert.equal(headers['content-type'], 'application/json');
  // No token: no header at all — the backend runs with auth off in that case.
  const bare = protocol.buildRpcHeaders({});
  assert.equal('authorization' in bare, false);
  assert.equal('x-aipass-project' in bare, false);
});

check('the token never rides a URL', () => {
  const rpc = protocol.buildRpcUrl(8790);
  const events = protocol.buildEventsUrl(8790);
  assert.equal(rpc, 'http://127.0.0.1:8790/rpc');
  assert.equal(events, 'http://127.0.0.1:8790/events');
  assert.equal(/secret|token=/.test(rpc), false);
  assert.equal(/secret|token=/.test(events), false);
});

check('the host is the loopback and nothing else', () => {
  assert.equal(protocol.LOOPBACK_HOST, '127.0.0.1');
  assert.equal(protocol.isLoopbackHost('127.0.0.1'), true);
  assert.equal(protocol.isLoopbackHost('127.0.0.5'), true);
  assert.equal(protocol.isLoopbackHost('localhost'), true);
  assert.equal(protocol.isLoopbackHost('::1'), true);
  assert.equal(protocol.isLoopbackHost('example.com'), false);
  assert.equal(protocol.isLoopbackHost('10.0.0.1'), false);
  assert.equal(protocol.isLoopbackHost(''), false);
  assert.equal(protocol.isLoopbackHost(null), false);
});

/* -------------------------------------------------------------------- projects */

check('two spellings of one project are one project', () => {
  assert.equal(protocol.sameProject('C:\\a\\proj', 'c:/a/proj/'), true);
  assert.equal(protocol.sameProject('/home/me/p', '/home/me/p'), true);
  assert.equal(protocol.sameProject('/home/me/p', '/home/me/q'), false);
  assert.equal(protocol.sameProject(null, '/home/me/p'), false);
  assert.equal(protocol.sameProject('', ''), false);
});

/* ------------------------------------------------------------------- the events */

check('the event list is the one the window consumes', () => {
  // The names desktop/ui/app.js listens for. A name that disappears here is a
  // frame the window would have drawn and this panel would drop.
  const required = [
    'task_start', 'assistant_delta', 'reasoning_delta', 'step', 'thinking',
    'tool', 'note', 'firewall_note', 'done_line', 'finished', 'cancelled',
    'error', 'todo', 'diff_update', 'permission_request', 'plan_request',
    'needs_tab', 'tab_opened', 'applied', 'discarded', 'injected',
    'inject_orphaned', 'hello', 'ping',
  ];
  for (const name of required) {
    assert.ok(protocol.EVENT_NAMES.includes(name), `missing event: ${name}`);
  }
});

check('the event list has no duplicates', () => {
  const seen = new Set();
  for (const name of protocol.EVENT_NAMES) {
    assert.equal(seen.has(name), false, `duplicate event: ${name}`);
    seen.add(name);
  }
});

check('the questions are always drawn, whoever they belong to', () => {
  // A dropped permission request leaves that run waiting for an answer nobody
  // can see, so the questions cross the project line.
  assert.ok(protocol.ALWAYS_FORWARD.has('permission_request'));
  assert.ok(protocol.ALWAYS_FORWARD.has('plan_request'));
  assert.ok(protocol.ALWAYS_FORWARD.has('needs_tab'));
});

check('the panel may only call the methods it is allowed to call', () => {
  for (const method of ['status', 'snapshot', 'credits', 'pending', 'diff', 'apply', 'discard', 'run', 'cancel', 'permission.answer', 'plan.answer']) {
    assert.ok(protocol.RPC_METHODS.includes(method), `missing method: ${method}`);
  }
  assert.equal(protocol.RPC_METHODS.includes('settings.set'), false);
  assert.equal(protocol.RPC_METHODS.includes('plugins.install'), false);
});

/* ------------------------------------------------------------------ the frames */

check('a frame from the backend is read the way it is written', () => {
  const frame = protocol.parseSseBlock('event: tool\nid: 42\ndata: {"kind":"read"}');
  assert.deepEqual(frame, { event: 'tool', id: '42', data: '{"kind":"read"}' });
});

check('the hello and the ping frames are read too', () => {
  assert.deepEqual(protocol.parseSseBlock('event: hello\ndata: {"seq":0}'), { event: 'hello', id: null, data: '{"seq":0}' });
  assert.deepEqual(protocol.parseSseBlock('event: ping\ndata: {}'), { event: 'ping', id: null, data: '{}' });
});

check('a comment-only block is nothing', () => {
  assert.equal(protocol.parseSseBlock(': keepalive'), null);
  assert.equal(protocol.parseSseBlock(''), null);
  assert.equal(protocol.parseSseBlock('   '), null);
});

check('several data lines join with a newline', () => {
  const frame = protocol.parseSseBlock('event: note\ndata: one\ndata: two');
  assert.equal(frame.data, 'one\ntwo');
});

/* ------------------------------------------------------------------ the markers */

check('the markers never reach the reader', () => {
  const reply = [
    'ผมจะอ่านไฟล์ให้นะ',
    'NEED file src/app.js',
    'แล้วจะแก้บรรทัดนี้',
    'EDIT src/app.js',
    'FIND',
    'const a = 1;',
    'const a = 2;',
    'END',
    'เสร็จแล้ว',
    'DONE แก้บั๊กเสร็จแล้ว',
  ].join('\n');
  const prose = protocol.stripMarkers(reply);
  assert.equal(prose.includes('NEED'), false);
  assert.equal(prose.includes('EDIT'), false);
  assert.equal(prose.includes('const a = 1;'), false);
  assert.equal(prose.includes('DONE'), false);
  assert.ok(prose.includes('ผมจะอ่านไฟล์ให้นะ'));
  assert.ok(prose.includes('แล้วจะแก้บรรทัดนี้'));
  assert.ok(prose.includes('เสร็จแล้ว'));
});

check('a marker quoted inside a fence is prose, not a call', () => {
  const reply = ['ตัวอย่าง:', '```', 'NEED file src/app.js', '```', 'จบ'].join('\n');
  const prose = protocol.stripMarkers(reply);
  assert.ok(prose.includes('NEED file src/app.js'));
});

check('every keyword of the grammar is dropped, not only the ones we remember', () => {
  // One line per keyword: the shape the harness parses it in. A keyword that
  // reached the reader would be raw wire on the screen.
  const shapes = {
    NEED: 'NEED file src/app.js',
    SEARCH: 'SEARCH something',
    TREE: 'TREE src',
    STAT: 'STAT src/app.js',
    GLOB: 'GLOB src/**/*.js',
    SYMBOLS: 'SYMBOLS src/app.js',
    DEF: 'DEF someName',
    REFS: 'REFS someName',
    SKILL: 'SKILL playbook',
    GIT: 'GIT status',
    VERIFY: 'VERIFY npm test',
    FETCH: 'FETCH https://example.com',
    WEB: 'WEB a question',
    ATTACH: 'ATTACH desktop/shot.png',
    DELETE: 'DELETE old.txt',
    MOVE: 'MOVE a.txt b.txt',
    EDIT: 'EDIT src/app.js',
    CREATE: 'CREATE new.txt',
    FIND: 'FIND',
    NEW: 'NEW',
    END: 'END',
    RUN: 'RUN',
    PLAN: 'PLAN',
    TODO: 'TODO',
    SUBAGENT: 'SUBAGENT',
    TASK: 'TASK: do the thing',
    ASK: 'ASK what should I do?',
    DONE: 'DONE finished',
    JOBS: 'JOBS',
  };
  for (const [keyword, line] of Object.entries(shapes)) {
    const prose = protocol.stripMarkers(['ข้อความปกติ', line, 'ข้อความท้าย'].join('\n'));
    assert.equal(prose.includes(keyword), false, `${keyword} reached the reader: ${prose}`);
    assert.ok(prose.includes('ข้อความปกติ'), 'the prose around the marker was dropped too');
  }
});

check('a block without an END does not eat the rest of the reply', () => {
  const reply = ['RUN', 'npm test', 'ผลคือผ่าน'].join('\n');
  const prose = protocol.stripMarkers(reply);
  assert.equal(prose.includes('npm test'), false);
});

/* ---------------------------------------------------------------- the transport */

check('the transport carries the token on both calls, and never in a URL', async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    if (req.url === '/rpc' && req.method === 'POST') {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        seen.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, result: { answered: true } }));
      });
      return;
    }
    if (req.url === '/events') {
      seen.push({ url: req.url, headers: req.headers });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: tool\nid: 7\ndata: {"kind":"read"}\n\n');
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const frames = [];
  const client = createBackend({
    port,
    token: 'secret-token',
    project: 'C:\\proj',
    onEvent: (frame) => frames.push(frame),
    onState: () => {},
  });
  try {
    const result = await client.rpc('status', { a: 1 });
    assert.deepEqual(result, { answered: true });
    client.start();
    await new Promise((resolve) => setTimeout(resolve, 400));
    client.close();

    const rpcCall = seen.find((s) => s.url === '/rpc');
    assert.ok(rpcCall, 'the rpc call never arrived');
    assert.equal(rpcCall.headers.authorization, 'Bearer secret-token');
    assert.equal(rpcCall.headers['x-aipass-project'], 'C:\\proj');
    assert.deepEqual(JSON.parse(rpcCall.body), { method: 'status', params: { a: 1 } });

    const stream = seen.find((s) => s.url === '/events');
    assert.ok(stream, 'the event stream never opened');
    assert.equal(stream.headers.authorization, 'Bearer secret-token');
    assert.equal(stream.url.includes('secret-token'), false, 'the token must not ride a URL');

    assert.ok(frames.length >= 1, 'no frame arrived');
    assert.equal(frames[0].event, 'tool');
    assert.equal(frames[0].data, '{"kind":"read"}');
    assert.equal(frames[0].id, '7');
  } finally {
    client.close();
    server.close();
  }
});

check('a refused call says what refused it', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/events') { res.writeHead(401); res.end(); return; }
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'no such method: nope', stage: 'validate' }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const client = createBackend({ port, token: 't', project: 'p', onEvent: () => {}, onState: () => {} });
  try {
    await assert.rejects(() => client.rpc('nope'), (err) => {
      assert.ok(err instanceof BackendError);
      assert.equal(err.kind, 'refused');
      assert.equal(err.stage, 'validate');
      return true;
    });
  } finally {
    client.close();
    server.close();
  }
});

check('a backend that is not there is an offline, not a crash', async () => {
  // A port that was open a moment ago and is closed now: the client must say
  // "offline" plainly rather than throw something the reader cannot act on.
  const probe = http.createServer(() => {});
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const client = createBackend({ port, token: 't', project: 'p', onEvent: () => {}, onState: () => {} });
  try {
    await assert.rejects(() => client.rpc('status'), (err) => {
      assert.ok(err instanceof BackendError);
      assert.equal(err.kind, 'offline');
      return true;
    });
  } finally {
    client.close();
  }
});

/* ------------------------------------------------------------------ the panel */

/**
 * A node in the panel's little DOM.
 *
 * Enough of Element for the panel's script: the markup it builds, the
 * handlers it wires, and the few properties it reads. It is not a browser —
 * it is a place where a typo in an element id shows up as a null.
 */
class FakeNode {
  constructor(tag = 'div') {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.attrs = {};
    this.handlers = {};
    this.className = '';
    this.id = '';
    this.title = '';
    this.value = '';
    this.type = '';
    this.checked = false;
    this.style = {};
    this.scrollHeight = 0;
    this.scrollTop = 0;
    this.clientHeight = 0;
    this._text = '';
  }

  get textContent() { return this._text; }

  set textContent(value) { this._text = String(value ?? ''); this.children = []; }

  append(...nodes) { for (const node of nodes) this.appendChild(node); }

  appendChild(node) { node._parent = this; this.children.push(node); return node; }

  addEventListener(type, fn) { (this.handlers[type] ??= []).push(fn); }

  setAttribute(key, value) { this.attrs[key] = String(value); }

  getAttribute(key) { return this.attrs[key] ?? null; }

  focus() {}

  remove() {
    if (this._parent) this._parent.children = this._parent.children.filter((c) => c !== this);
  }

  get classList() {
    const set = () => new Set(this.className.split(/\s+/).filter(Boolean));
    return {
      add: (c) => { this.className = [...set(), c].join(' '); },
      remove: (c) => { this.className = [...set()].filter((x) => x !== c).join(' '); },
      contains: (c) => set().has(c),
      toggle: (c, on) => { (on ?? !set().has(c)) ? this.classList.add(c) : this.classList.remove(c); },
    };
  }

  querySelector(selector) { return findBySelector(this, selector, true); }

  querySelectorAll(selector) { return findBySelector(this, selector, false); }

  /** Fire a handler the way the browser would. */
  dispatch(type, ev = {}) {
    const merged = { preventDefault() {}, stopPropagation() {}, ...ev, target: this, currentTarget: this };
    for (const fn of this.handlers[type] ?? []) fn(merged);
    const inline = this[`on${type}`];
    if (typeof inline === 'function') inline(merged);
  }
}

/**
 * The nodes under `root` that match `selector` — a class or a tag.
 *
 * @param {FakeNode} root
 * @param {string} selector
 * @param {boolean} first only the first match
 * @returns {any}
 */
function findBySelector(root, selector, first) {
  const want = selector.trim();
  const isClass = want.startsWith('.');
  const name = isClass ? want.slice(1) : want.toUpperCase();
  const out = [];
  const walk = (node) => {
    for (const child of node.children ?? []) {
      const hit = isClass
        ? String(child.className ?? '').split(/\s+/).includes(name)
        : child.tagName === name;
      if (hit) out.push(child);
      walk(child);
    }
  };
  walk(root);
  return first ? (out[0] ?? null) : out;
}

/**
 * Boot the panel's script against the fake DOM.
 *
 * The element ids come out of panel.html, so an id the script asks for and
 * the markup does not have is a null here — the same null the browser would
 * hand over.
 */
function bootPanel() {
  const html = fs.readFileSync(path.join(here, 'media', 'panel.html'), 'utf8');
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
  const nodes = new Map();
  for (const id of ids) {
    const node = new FakeNode('div');
    node.id = id;
    nodes.set(id, node);
  }
  const posts = [];
  const fakeWindow = { _handlers: {} };
  fakeWindow.addEventListener = (type, fn) => { fakeWindow._handlers[type] = fn; };
  const context = {
    acquireVsCodeApi: () => ({
      postMessage: (message) => posts.push(message),
      getState: () => ({}),
      setState: () => {},
    }),
    window: fakeWindow,
    document: {
      getElementById: (id) => nodes.get(id) ?? null,
      createElement: (tag) => new FakeNode(tag),
    },
    console,
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(here, 'media', 'panel.js'), 'utf8'), context);
  return {
    nodes,
    posts,
    send: (message) => fakeWindow._handlers.message({ data: message }),
  };
}

/**
 * Every bit of text under a node, at any depth.
 *
 * The panel nests: a bubble holds a body, a summary holds a line. A shallow
 * read would miss both.
 *
 * @param {FakeNode} node
 * @returns {string}
 */
function textOf(node) {
  if (!node) return '';
  const own = node.textContent ?? '';
  const kids = (node.children ?? []).map((child) => textOf(child)).join('\n');
  return [own, kids].filter(Boolean).join('\n');
}

check('the panel boots and asks the host for the state', () => {
  const { posts } = bootPanel();
  assert.equal(posts.length, 1);
  assert.equal(posts[0].kind, 'ready');
});

check('the panel draws the machine it is told about', () => {
  const { nodes, send } = bootPanel();
  send({
    kind: 'state',
    project: 'C:\\work\\proj',
    events: ['tool'],
    status: { root: 'C:\\work\\proj', model: 'aipass/x', provider: 'aipass', running: false },
    credits: { available: 1200, limit: 10000, used: 8800 },
    pending: [],
  });
  assert.equal(nodes.get('project').textContent, 'proj');
  assert.ok(nodes.get('model').textContent.includes('aipass/x'));
  assert.ok(nodes.get('credits').textContent.includes('1200'));
  assert.ok(nodes.get('credits').textContent.includes('10000'));
});

check('a tool call is a row, and the prose is the text', () => {
  const { nodes, send } = bootPanel();
  send({ kind: 'prose', text: 'ผมจะอ่านไฟล์ให้นะ' });
  send({ kind: 'event', name: 'tool', data: { kind: 'read', arg: 'src/app.js', ok: true, head: '42 lines' } });
  const log = nodes.get('log');
  const text = JSON.stringify(log.children.map((c) => ({ cls: c.className, txt: textOf(c) })));
  assert.ok(text.includes('ผมจะอ่านไฟล์ให้นะ'), 'the prose is not on the stage');
  assert.ok(text.includes('tool'), 'the tool call is not a row');
  assert.ok(text.includes('อ่าน'), 'the row has no label');
  assert.ok(text.includes('src/app.js'), 'the row has no argument');
});

check('the permission question is asked, and the answer goes back to the run', () => {
  const { nodes, posts, send } = bootPanel();
  send({
    kind: 'event',
    name: 'permission_request',
    data: { id: 'q1', kind: 'write', arg: 'src/app.js', risk: 'write', project: 'C:\\other' },
  });
  const ask = nodes.get('ask');
  assert.equal(ask.classList.contains('hidden'), false, 'the question never appeared');
  const buttons = nodes.get('ask-actions').querySelectorAll('button');
  assert.equal(buttons.length, 3, 'the question is not the three doors the window has');
  // The allow button is the last one.
  buttons[2].dispatch('click');
  const answer = posts.find((p) => p.kind === 'rpc' && p.method === 'permission.answer');
  assert.ok(answer, 'the answer never went back');
  assert.equal(answer.params.id, 'q1');
  assert.equal(answer.params.decision, 'allow');
  assert.equal(answer.params.project, 'C:\\other', 'the answer must name the project it belongs to');
});

check('the plan question is asked the same way', () => {
  const { nodes, posts, send } = bootPanel();
  send({ kind: 'event', name: 'plan_request', data: { project: 'C:\\work\\proj' } });
  const buttons = nodes.get('ask-actions').querySelectorAll('button');
  assert.equal(buttons.length, 2);
  buttons[0].dispatch('click');
  const answer = posts.find((p) => p.kind === 'rpc' && p.method === 'plan.answer');
  assert.ok(answer);
  assert.equal(answer.params.ok, false);
});

check('the staged changes are listed, and a file the human unticked stays unticked', () => {
  const { nodes, send } = bootPanel();
  const changes = [{ file: 'a.js', added: 2, removed: 1 }, { file: 'b.js', added: 1, removed: 0 }];
  send({ kind: 'event', name: 'diff_update', data: { changes } });
  const list = nodes.get('pending-list');
  assert.equal(list.children.length, 2);
  assert.equal(nodes.get('pending-count').textContent, '2 การเปลี่ยนแปลง');
  // Untick the first file, then let the panel be rebuilt.
  const box = list.children[0].children[0];
  box.checked = false;
  box.dispatch('change');
  send({ kind: 'event', name: 'diff_update', data: { changes } });
  const after = nodes.get('pending-list');
  assert.equal(after.children[0].children[0].checked, false, 'the tick came back on its own');
  assert.equal(after.children[1].children[0].checked, true);
});

check('a run that ends says the DONE once', () => {
  const { nodes, send } = bootPanel();
  send({ kind: 'event', name: 'done_line', data: { text: 'แก้เสร็จแล้ว', extra: '' } });
  send({ kind: 'event', name: 'finished', data: { summary: 'แก้เสร็จแล้ว', stopReason: 'done', spent: 3 } });
  const said = nodes.get('log').children.filter((c) => textOf(c).includes('แก้เสร็จแล้ว'));
  assert.equal(said.length, 1, `the DONE was said ${said.length} times`);
});

check('a backend that is not there is said plainly', () => {
  const { nodes, send } = bootPanel();
  send({ kind: 'state', project: 'C:\\p', error: { kind: 'offline', message: 'ไม่ติดต่อ backend ได้' } });
  const text = nodes.get('log').children.map((c) => textOf(c)).join('\n');
  assert.ok(text.includes('aipass desktop'), 'the panel must name the command that starts the backend');
});

/* -------------------------------------------------------------- the packaging */

check('every placeholder in the panel markup is filled by the host', () => {
  const html = fs.readFileSync(path.join(here, 'media', 'panel.html'), 'utf8');
  const host = fs.readFileSync(path.join(here, 'extension.js'), 'utf8');
  const placeholders = [...new Set([...html.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]))];
  assert.ok(placeholders.length > 0, 'the markup has no placeholder at all');
  // The host fills the placeholders with regular expressions, so the
  // backslashes are taken off before the names are looked for.
  const flat = host.replace(/\\/g, '');
  for (const name of placeholders) {
    assert.ok(flat.includes(`{{${name}}}`), `the host does not fill {{${name}}}`);
  }
  // A webview's response headers are not ours to set: the policy of the page
  // rides in the page, or it does not ride at all.
  assert.ok(html.includes('http-equiv="Content-Security-Policy"'), 'the panel has no policy of its own');
  assert.ok(host.includes("connect-src 'none'"), 'the policy must forbid the panel its own sockets');
  assert.ok(host.includes("script-src 'nonce-"), 'the script must be bound by a nonce');
});

check('the package carries no dependency at all', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(here, 'package.json'), 'utf8'));
  assert.deepEqual(manifest.dependencies ?? {}, {});
  assert.deepEqual(manifest.devDependencies ?? {}, {});
  assert.deepEqual(manifest.peerDependencies ?? {}, {});
  assert.equal(manifest.main, './extension.js');
  assert.ok(manifest.engines?.vscode, 'the manifest needs engines.vscode');
  assert.ok(Array.isArray(manifest.contributes?.commands) && manifest.contributes.commands.length > 0);
});

check('the extension code imports node builtins and the host API only', () => {
  const sources = ['extension.js', 'lib/protocol.js', 'media/panel.js'];
  for (const file of sources) {
    const text = fs.readFileSync(path.join(here, file), 'utf8');
    const requires = [...text.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
    for (const name of requires) {
      const own = name.startsWith('./') || name.startsWith('../');
      assert.ok(
        name === 'vscode' || name.startsWith('node:') || own,
        `${file} requires ${name} — only node:* builtins, the VS Code API and this package's own files are allowed`,
      );
    }
  }
});

/* ------------------------------------------- the optional drift check (skip) */

check('the marker mirror knows every keyword the harness knows', () => {
  const file = path.join(here, '..', 'aipass-bridge', 'harness', 'protocol.mjs');
  if (!fs.existsSync(file)) {
    results.push('  skip the marker drift check — the harness is not next to this extension');
    return;
  }
  const text = fs.readFileSync(file, 'utf8');
  const line = /MARKER_LINE\s*=\s*\/(.*?)\/([a-z]*);/s.exec(text);
  assert.ok(line, 'the harness MARKER_LINE was not found — the mirror cannot be checked');
  const harness = new Set([...line[1].matchAll(/\b([A-Z]{2,})\b/g)].map((m) => m[1]));
  const mirror = new Set(protocol.MARKER_KEYWORDS);
  const missing = [...harness].filter((k) => !mirror.has(k));
  const extra = [...mirror].filter((k) => !harness.has(k));
  assert.deepEqual(missing, [], `the harness knows markers this mirror does not: ${missing.join(', ')}`);
  assert.deepEqual(extra, [], `this mirror knows markers the harness does not: ${extra.join(', ')}`);
});

check('every event the backend emits is one this panel knows', () => {
  const harness = path.join(here, '..', 'aipass-bridge', 'harness');
  if (!fs.existsSync(harness)) {
    results.push('  skip the backend drift check — the harness is not next to this extension');
    return;
  }
  const seen = new Set();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.mjs')) continue;
      const text = fs.readFileSync(full, 'utf8');
      for (const m of text.matchAll(/emit\(\s*'([a-z_]+)'/g)) seen.add(m[1]);
    }
  };
  walk(harness);
  const unknown = [...seen].filter((name) => !protocol.EVENT_NAMES.includes(name));
  assert.deepEqual(unknown, [], `the backend emits events this panel does not know: ${unknown.join(', ')}`);
});

/* ---------------------------------------------------------------------- report */

for (const [name, fn] of checks) {
  try {
    await fn();
    results.push(`  ok   ${name}`);
  } catch (err) {
    failed += 1;
    results.push(`  FAIL ${name}\n       ${err?.message ?? err}`);
  }
}

console.log('aipass ide-extension — selftest');
console.log(results.join('\n'));
console.log(failed === 0 ? `\npass ${results.length} checks — 0 failed` : `\n${failed} of ${results.length} checks FAILED`);
process.exit(failed === 0 ? 0 : 1);
