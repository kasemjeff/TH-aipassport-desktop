'use strict';
// The pure half of the extension: the contract with the harness backend, and
// nothing that touches the filesystem, the network or VS Code.
//
// Why this file exists on its own: the parts that can be wrong without an
// editor around them are exactly the parts worth testing — where the port
// comes from, what a request body looks like, how one SSE frame is read, and
// which wire markers must never reach the reader. `selftest.mjs` drives this
// file alone, with no VS Code and no backend.
//
// The contract itself is written down in `../protocol.md`; this file is the
// machine-readable half of it.

/**
 * The port the desktop backend binds when nothing says otherwise.
 *
 * The same number the launcher uses (aipass-bridge/harness/launcher.mjs
 * `DEFAULT_DESKTOP_PORT`), so a client that says 8790 and a backend that
 * binds 8790 are the same fact written twice — not two facts.
 */
const DEFAULT_DESKTOP_PORT = 8790;

/**
 * The only host this extension ever talks to.
 *
 * The backend binds the loopback because the bridge behind it carries a
 * logged-in browser session: that port is as sensitive as the account is
 * (aipass-bridge/harness/rpc.mjs, "Everything binds to 127.0.0.1 only"). The
 * bearer token therefore rides a request to this host and to no other, and the
 * URL builders below hard-code it instead of taking a host.
 */
const LOOPBACK_HOST = '127.0.0.1';

/**
 * The SSE event names the panel renders.
 *
 * These are the names the desktop window already consumes
 * (desktop/ui/app.js `onRun`/`onAny`), so one run looks the same in two
 * surfaces and a second editor can be built on the same list. The list is a
 * contract, not a preference: a name that disappears here is a frame the
 * window would have drawn and this panel would drop.
 */
const EVENT_NAMES = Object.freeze([
  // the transport
  'hello', 'ping',
  // the run
  'task_start', 'assistant_delta', 'reasoning_delta', 'step', 'thinking',
  'tool', 'note', 'firewall_note', 'nudge', 'give_up', 'ignore_done',
  'stagnation', 'repeat_block', 'verify_prompt', 'check_start', 'check_end',
  'lang_prompt', 'budget', 'step_limit', 'error', 'todo', 'diff_update',
  'compacted', 'helper_start', 'helper_end', 'subagent_start', 'subagent_end',
  'plugin_call', 'ask', 'done_line', 'cancelled', 'finished', 'run_stats',
  // the questions the backend asks the client
  'permission_request', 'plan_request',
  // the machine around the run
  'needs_tab', 'tab_opened', 'session', 'session_opened', 'session_forked',
  'conversation', 'project', 'settings', 'plugins', 'applied', 'discarded',
]);

/**
 * The frames that are drawn whatever project they name.
 *
 * The backend broadcasts every harness's events to every listener, so a run
 * left going in another project must not paint in this one — the window's
 * rule (desktop/ui/app.js `onRun`). The questions are the exception: a
 * permission request that was dropped would leave that run waiting for an
 * answer nobody can see, so it is always shown, and it names the project it
 * belongs to.
 */
const ALWAYS_FORWARD = Object.freeze(new Set([
  'hello', 'ping',
  'permission_request', 'plan_request',
  'needs_tab', 'tab_opened',
  'project', 'settings', 'plugins',
  'session', 'session_opened', 'session_forked', 'conversation',
]));

/**
 * The RPC methods the panel is allowed to call.
 *
 * The panel is our own code, but it is still code that runs in a webview: the
 * allowlist is the line between "a panel for the agent" and "a remote shell
 * for the machine". Everything outside this list (the settings sheet, the
 * plugin installer, the update service) belongs to the desktop window, which
 * is where those doors already are.
 */
const RPC_METHODS = Object.freeze([
  'status', 'snapshot', 'credits', 'pending', 'diff', 'apply', 'discard',
  'run', 'cancel', 'permission.answer', 'plan.answer', 'browser.open',
]);

/**
 * Is this value a port?
 *
 * The same rule the launcher applies (launcher.mjs `resolveDesktopPort`): the
 * digits are decimal only, and the number has to be inside the range a port
 * can have. `Number('0x50')` is 80 and `Number('1e3')` is 1000 — a client that
 * accepted those would look for a backend on a port nobody bound.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isPort(value) {
  const raw = String(value ?? '').trim();
  if (!/^\+?\d+$/.test(raw)) return false;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 65535;
}

/**
 * Where the backend is.
 *
 * Two sources, in this order:
 *
 *   1. `AIPASS_DESKTOP_PORT` — the launcher resolves the port from exactly
 *      this variable, so a backend started with it is on that port whatever
 *      any file says. Reading it first is what keeps the client and the
 *      server from disagreeing.
 *   2. `desktopPort` in `~/.aipass/settings.json` — the file every surface
 *      shares (aipass-bridge/harness/settings.mjs), read here so an install
 *      that moves the backend does not need an environment variable.
 *   3. the default, 8790.
 *
 * A value that is not a port is ignored rather than believed: a broken
 * settings file must not send the client to a port nobody is on.
 *
 * @param {{settings?: object|null, env?: object}} [input]
 * @returns {number}
 */
function resolvePort({ settings = null, env = {} } = {}) {
  const fromEnv = env?.AIPASS_DESKTOP_PORT;
  if (isPort(fromEnv)) return Number(String(fromEnv).trim());
  const fromSettings = settings?.desktopPort;
  if (isPort(fromSettings)) return Number(String(fromSettings).trim());
  return DEFAULT_DESKTOP_PORT;
}

/**
 * The loopback bearer token, or null when there is none.
 *
 * The token is a credential: it is never logged, never put in a message to
 * the panel, and never written into a URL (the URL is the one place a token
 * would end up in a log). It rides the `authorization` header and nowhere
 * else.
 *
 * @param {unknown} raw the file's contents
 * @returns {string|null}
 */
function resolveToken(raw) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  return text ? text : null;
}

/**
 * The body of one `/rpc` call.
 *
 * The shape is the backend's, not ours: `{"method":…,"params":…}` answered
 * with `{"ok":true,"result":…}` or `{"ok":false,"error":…}` (rpc.mjs, the
 * `/rpc` route).
 *
 * @param {string} method
 * @param {object} [params]
 * @returns {string}
 */
function buildRpcBody(method, params = {}) {
  return JSON.stringify({ method: String(method), params: params ?? {} });
}

/**
 * The headers one `/rpc` call carries.
 *
 * Two of them are the window's discipline, copied from desktop/ui/rpc.js:
 * the bearer token, and `x-aipass-project` — the project this client is
 * showing. The backend holds one harness per project, and without the header
 * a second window on another project would decide what this one reads.
 *
 * @param {{token?: string|null, project?: string|null}} [input]
 * @returns {Record<string, string>}
 */
function buildRpcHeaders({ token = null, project = null } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (project) headers['x-aipass-project'] = String(project);
  return headers;
}

/**
 * The URL of the RPC route. The host is fixed; the port is not.
 *
 * @param {number} port
 * @returns {string}
 */
function buildRpcUrl(port) {
  return `http://${LOOPBACK_HOST}:${port}/rpc`;
}

/**
 * The URL of the event stream.
 *
 * No token in the query string: the backend accepts a header bearer on
 * `/events` as well as `?token=` (rpc.mjs, the `/events` route), and a URL is
 * the shape that ends up in a log.
 *
 * @param {number} port
 * @returns {string}
 */
function buildEventsUrl(port) {
  return `http://${LOOPBACK_HOST}:${port}/events`;
}

/**
 * Is this host the loopback?
 *
 * The rule the backend itself applies to inbound requests
 * (rpc.mjs `loopbackHost`). A client that asked "is this host local?" is
 * asking because it is about to put a credential on the wire.
 *
 * @param {unknown} host
 * @returns {boolean}
 */
function isLoopbackHost(host) {
  const h = String(host ?? '').trim().toLowerCase();
  if (!h) return false;
  if (h === 'localhost' || h === '::1' || h === '[::1]') return true;
  return /^127(\.\d{1,3}){3}$/.test(h);
}

/**
 * Are these two paths the same project?
 *
 * Windows compares paths case-insensitively, and the backend's own project
 * key is the resolved path (rpc.mjs `harnessFor`). The comparison is the
 * window's (desktop/ui/app.js `sameProject`): slashes folded, case folded,
 * the trailing separator dropped — so `C:\a\proj` and `c:/a/proj/` are one
 * project and not two.
 *
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
function sameProject(a, b) {
  if (!a || !b) return false;
  const norm = (v) => String(v).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return norm(a) === norm(b);
}

/**
 * One SSE frame, read out of a block of text.
 *
 * The backend writes `event: <name>\nid: <seq>\ndata: <json>\n\n` (rpc.mjs
 * `emit`), plus a `hello` and a `ping` frame. The parser follows the SSE
 * grammar: `:` starts a comment (ignored), a field without a colon is a field
 * with an empty value, and the data lines of one frame join with `\n`.
 *
 * @param {string} block the text between two blank lines
 * @returns {{event: string, id: string|null, data: string}|null} null when
 *   the block carried nothing at all
 */
function parseSseBlock(block) {
  const text = String(block ?? '');
  if (!text.trim()) return null;
  let event = 'message';
  let id = null;
  const data = [];
  let saw = false;
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith(':')) continue; // a comment or a keepalive
    const at = line.indexOf(':');
    const field = at === -1 ? line : line.slice(0, at);
    let value = at === -1 ? '' : line.slice(at + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    saw = true;
    if (field === 'event') event = value;
    else if (field === 'id') id = value;
    else if (field === 'data') data.push(value);
  }
  if (!saw) return null;
  return { event, id, data: data.join('\n') };
}

/* --------------------------------------------------------------- the markers */

/**
 * The marker grammar, mirrored.
 *
 * Markers are wire protocol: the model writes "EDIT file … END" as its way of
 * calling a tool, and the loop answers every call with its own `tool` event.
 * The reader must see the prose and the rows — never the raw markers, or
 * every change appears twice (root law 12, "markers are wire protocol, never
 * rendered text").
 *
 * The grammar is the harness's (aipass-bridge/harness/protocol.mjs
 * `MARKER_LINE` and `parse()`), mirrored here because the extension cannot
 * import the harness: it is a separate package with its own copy, and the
 * backend is reached over HTTP, not over a module boundary. The window keeps
 * the same mirror in desktop/ui/markers.js, and the suite keeps the two
 * honest against each other (test/ui-markers.test.mjs) — the extension's copy
 * has no such pair, so the self-test checks the keyword list against the
 * harness's own `MARKER_LINE` whenever the harness is next to the extension.
 * See the open risks.
 */
const FENCE_LINE = /^\s*(```|~~~)/;

/**
 * Every keyword the harness's grammar knows.
 *
 * The list is the contract the self-test compares: a marker added to the
 * harness must be added here, or it would reach the reader as raw wire.
 */
const MARKER_KEYWORDS = Object.freeze([
  'NEED', 'SEARCH', 'GLOB', 'SYMBOLS', 'DEF', 'REFS', 'RECALL', 'SKILL', 'GIT', 'VERIFY',
  'FETCH', 'WEB', 'DELETE', 'MOVE', 'EDIT', 'CREATE', 'ATTACH', 'FIND', 'NEW',
  'END', 'RUN', 'PLAN', 'TODO', 'SUBAGENT', 'TASK', 'ASK', 'DONE', 'JOBS',
]);

// The single-line calls, in the harness's own order.
const SINGLE_MARKERS = [
  /^\s*NEED\s+(?:dir|list|ls|file)\s+\S/i,
  /^\s*NEED\s+(?:dir|list|ls)\s*$/i,
  /^\s*NEED\s+\S/i,
  /^\s*SEARCH\s+/i,
  /^\s*GLOB\s+/i,
  /^\s*SYMBOLS\s+/i,
  /^\s*DEF\s+/i,
  /^\s*REFS\s+/i,
  /^\s*SKILL\s+/i,
  /^\s*GIT\s+/i,
  // VERIFY asks for a check; the command is optional (harness protocol.mjs).
  /^\s*VERIFY\b/i,
  // RECALL asks what the project said before; the question is required.
  /^\s*RECALL\s+/i,
  /^\s*FETCH\s+/i,
  /^\s*WEB\s+/i,
  /^\s*ATTACH\s+/i,
  /^\s*DELETE\s+/i,
  /^\s*MOVE\s+/i,
  /^\s*TASK\s*:/i,
  // A bare ASK is prose (the harness's rule): the question is required.
  /^\s*ASK\b[:\s—–-]*(.+)$/i,
];

// The block markers: a header line and a body that ends with END.
const BLOCK_MARKERS = [
  /^\s*EDIT\s+/i,
  /^\s*CREATE\s+/i,
  /^\s*RUN\s*$/i,
  /^\s*PLAN\s*$/i,
  /^\s*TODO\s*$/i,
  /^\s*SUBAGENT\s*$/i,
];

// The lines that belong to a block: its own body markers, plus the ones that
// stand alone (JOBS polls the helpers, DONE ends the run).
const BLOCK_BODY = [
  /^\s*FIND\s*$/i,
  /^\s*NEW\s*$/i,
  /^\s*END\s*$/i,
  /^\s*JOBS\s*$/i,
  /^\s*(?:\*{1,3}|#{1,6}\s*)?DONE\b/i,
];

/**
 * The reply's prose, with every marker call dropped.
 *
 * A quoted marker inside a fenced block stays: inside a fence it is an
 * example, never a call (the same rule the harness applies — F1 in
 * docs/HARNESS_DESIGN.md).
 *
 * @param {unknown} reply
 * @returns {string}
 */
function stripMarkers(reply) {
  const lines = String(reply ?? '').split('\n');
  const kept = [];
  let inFence = false;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (FENCE_LINE.test(line)) { inFence = !inFence; kept.push(line); i += 1; continue; }
    if (inFence) { kept.push(line); i += 1; continue; }

    let isBlock = false;
    for (const re of BLOCK_MARKERS) {
      if (!re.test(line)) continue;
      isBlock = true;
      i += 1;
      // The body runs until END. A body that never ends must not eat the rest
      // of the reply: the END is optional in the wire, and a reply that ends
      // without one is prose again.
      while (i < lines.length && !/^\s*END\s*$/i.test(lines[i])) {
        if (FENCE_LINE.test(lines[i])) inFence = !inFence;
        i += 1;
      }
      if (i < lines.length) i += 1; // the END itself
      break;
    }
    if (isBlock) continue;

    let isBody = false;
    for (const re of BLOCK_BODY) {
      if (!re.test(line)) continue;
      isBody = true;
      break;
    }
    if (isBody) { i += 1; continue; }

    let isSingle = false;
    for (const re of SINGLE_MARKERS) {
      if (!re.test(line)) continue;
      isSingle = true;
      break;
    }
    if (isSingle) { i += 1; continue; }

    kept.push(line);
    i += 1;
  }
  return kept.join('\n').trim();
}

module.exports = {
  DEFAULT_DESKTOP_PORT,
  LOOPBACK_HOST,
  EVENT_NAMES,
  ALWAYS_FORWARD,
  MARKER_KEYWORDS,
  RPC_METHODS,
  isPort,
  resolvePort,
  resolveToken,
  buildRpcBody,
  buildRpcHeaders,
  buildRpcUrl,
  buildEventsUrl,
  isLoopbackHost,
  sameProject,
  parseSseBlock,
  stripMarkers,
};
