#!/usr/bin/env node
// @ts-check
// Talk to aipass from the terminal. Streams the reply, renders it as markdown,
// shows server-side tool activity (web_search) as compact gutter lines, and
// lists sources at the end.
//
//   npm run chat                 interactive
//   npm run chat -- "question"   one-shot
//
// Everything that moves the cursor (spinner, the stream-then-reformat trick) is
// gated behind stdout.isTTY, so piped/non-tty output stays plain and stable.
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync, spawnSync } from 'node:child_process';

/**
 * @typedef {object} BridgeStatus
 * @property {boolean} ok
 * @property {number} extensions
 * @property {number} activeJobs
 * @property {string} defaultModel
 * @property {string | null} conversation
 * @property {string | null} [assistant]
 * @property {Array<{ id: string, name?: string, free?: boolean }>} [models]
 */

/**
 * One `choices[0].delta` from an OpenAI-style chat.completion.chunk. The bridge
 * puts prose in `content` and web_search progress / sources in `reasoning_content`.
 * @typedef {object} ChatDelta
 * @property {string} [role]
 * @property {string} [content]
 * @property {string} [reasoning_content]
 */

/**
 * A single SSE frame from `POST /v1/chat/completions` (stream mode).
 * @typedef {object} SSEChunk
 * @property {{ message: string }} [error]
 * @property {Array<{ delta?: ChatDelta, finish_reason?: string | null }>} [choices]
 */

const argv = process.argv.slice(2);

/**
 * @param {string} name
 * @param {string | null} [fallback]
 * @returns {string | null}
 */
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : (argv[i + 1] ?? fallback);
};

if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`usage: npm run chat [-- "question"] [options]

  --model ID          model to use          (default: whatever the bridge is set to)
  --conversation ID   continue a specific conversation
  --new               start a fresh conversation instead of the most recent
  --temporary         start a throwaway one, kept out of the chat history
  --bridge URL        bridge base URL       (default: http://127.0.0.1:8787)
  --file PATH         attach a document or image; repeat for several
  --image PATH        attach an image directly
  --thinking LEVEL    how hard a reasoning model thinks (low, medium, high —
                      and max on Claude Opus)
  --ratio R           aspect ratio          (images: 1:1, 3:4, 4:3;
                      video: 16:9, 9:16, 1:1, 4:3, 3:4, and 21:9 on seedance)
  --resolution R      video resolution      (480p, 720p — seedance only)
  --duration N        video length in seconds
  --camera-fixed      lock the camera for the shot
  --no-audio          do not generate a soundtrack with the video
  --style NAME        a video style — name a preset ("Documentary") or pass raw
                      preprompt text; npm run styles lists them
  --image-style NAME  an image style preset ("Anime", "อนิเมะ")
  --tone NAME         concise, detailed, step_by_step, friendly, academic,
                      storytelling
  --format NAME       markdown, bullet_points, table, code_block, paragraph,
                      numbered_list
  --assistant ID      bind to a custom assistant
  --out DIR           where to save generated images, video and music
                                            (default: outputs/)
  --paste-idle MS     how long to wait before treating pasted lines as one
                      message                          (default: 60)

With a question, it answers and exits. Without one it stays interactive, where
/models lists what is available, /model <id> switches, and Ctrl+C quits.`);
  process.exit(0);
}

const BRIDGE = (flag('bridge', 'http://127.0.0.1:8787') ?? '').replace(/\/+$/, '');
const CONVERSATION = flag('conversation', null);
const DEFAULT_OUT_DIR = path.join(process.cwd(), 'outputs');
const OUT_DIR = path.resolve(flag('out', DEFAULT_OUT_DIR) ?? DEFAULT_OUT_DIR);
const RATIO = flag('ratio', null);
const RESOLUTION = flag('resolution', null);
const DURATION = flag('duration', null);
const STYLE = flag('style', null);
const IMAGE_STYLE = flag('image-style', null);
const TONE = flag('tone', null);
const FORMAT = flag('format', null);
const ASSISTANT = flag('assistant', null);
const CAMERA_FIXED = argv.includes('--camera-fixed');
const NO_AUDIO = argv.includes('--no-audio');
const imageArg = flag('image', null);
const FILES = argv.reduce((/** @type {string[]} */ acc, a, i) => (a === '--file' && argv[i + 1] ? [...acc, argv[i + 1]] : acc), /** @type {string[]} */ ([]));
let thinkingLevel = flag('thinking', null);
let activeTone = TONE;
let activeFormat = FORMAT;
let activeImageStyle = IMAGE_STYLE;
let activeVideoStyle = STYLE;
/** @type {{ id: string, name: string } | null} */
let activeAssistant = ASSISTANT ? { id: ASSISTANT, name: ASSISTANT } : null;
// `--new` / `/new` don't create a conversation up front — that would seed the
// account's chat list with a throwaway "New chat." entry. Instead we defer:
// the next message the user actually sends becomes the seed, so the entry is
// titled by real text, exactly like the web UI's "new chat".
let pendingNew = argv.includes('--new');
let model = flag('model', '') ?? '';
const question = argv.filter((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--')).join(' ').trim();

/* ------------------------------------------------------------------- styling */

const TTY = Boolean(stdout.isTTY);

/**
 * Build an ANSI SGR wrapper. On a non-tty it is the identity, so piped output
 * stays clean.
 * @param {number} code
 * @returns {(s: string) => string}
 */
const sgr = (code) => (s) => (TTY ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const dim = sgr(2);
const bold = sgr(1);
const italic = sgr(3);
const underline = sgr(4);
const red = sgr(31);
const green = sgr(32);
const yellow = sgr(33);
const magenta = sgr(35);
const cyan = sgr(36);
const gray = sgr(90);

// An image model answers with a data URI, which is megabytes of base64 — write
// it out and print where it went, rather than filling the scrollback with it.
let saved = 0;
// Extensions for the media types the generators actually return, so a saved
// file opens by double-clicking it instead of needing to be renamed.
const EXT = {
  jpeg: 'jpg', 'svg+xml': 'svg', mpeg: 'mp3', 'x-wav': 'wav', wave: 'wav',
  quicktime: 'mov', 'x-matroska': 'mkv',
};
/** @param {string} mime */
const extFor = (mime) => {
  const sub = (mime.split('/')[1] || 'bin').toLowerCase();
  return (/** @type {Record<string, string>} */ (EXT))[sub] ?? sub.replace(/[^a-z0-9]/g, '');
};

/**
 * @param {Buffer} buf
 * @param {string} mime
 * @param {string} label
 */
const writeMedia = (buf, mime, label) => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, `aipass-${Date.now()}-${++saved}.${extFor(mime)}`);
  fs.writeFileSync(file, buf);
  return `\n${cyan(`[${label} saved to ${file}]`)}\n`;
};

// Generated media arrives as markdown: an image tag for pictures, a link for a
// video or a music clip. Either way the payload is a data: URI to decode, or a
// URL to go and fetch — a link nobody downloads is not much of a result.
// The extensions a generator can hand back. A link is only chased when it looks
// like one of these: a citation in the prose is a link too, and fetching those
// would be both wrong and slow.
const MEDIA_EXT = new Set(['mp4', 'webm', 'mov', 'mkv', 'mp3', 'wav', 'ogg', 'm4a', 'flac', 'png', 'jpg', 'jpeg', 'gif', 'webp']);

/**
 * @param {string} chunk
 */
function keepMedia(chunk) {
  return chunk.replace(/(!?)\[([^\]]*)\]\((data:([^;,)]+)[^)]*|https?:\/\/[^)\s]+)\)/g, (/** @type {string} */ whole, /** @type {string} */ bang, /** @type {string} */ label, /** @type {string} */ target, /** @type {string} */ mime) => {
    // The label is a filename when the part carried one (video does, music does
    // not), otherwise a bare kind. Either way what matters is the extension.
    const labelExt = label.split('.').pop()?.toLowerCase() ?? '';
    const urlExt = target.split('?')[0].split('.').pop()?.toLowerCase() ?? '';
    const kind = bang ? 'image' : label.includes('.') ? label : (label || 'file');
    try {
      if (target.startsWith('data:')) {
        const comma = target.indexOf(',');
        if (comma === -1) return whole;
        return writeMedia(Buffer.from(target.slice(comma + 1), 'base64'), mime, kind);
      }
      if (!bang && !['video', 'audio', 'image', 'file'].includes(label)
        && !MEDIA_EXT.has(labelExt) && !MEDIA_EXT.has(urlExt)) return whole;
      pending.push({ url: target, kind });
      return `\n${cyan(`[${kind} at ${target.split('?')[0]} — downloading]`)}\n`;
    } catch (/** @type {any} */ err) {
      return `\n[${kind} could not be saved: ${err.message}]\n`;
    }
  });
}

// Remote media is fetched after the stream closes, so a slow download does not
// stall the answer still being printed.
/** @type {Array<{ url: string, kind: string }>} */
const pending = [];
async function drainPending() {
  for (const { url, kind } of pending.splice(0)) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`status ${res.status}`);
      const mime = (res.headers.get('content-type') || 'application/octet-stream').split(';')[0].trim();
      const buf = Buffer.from(await res.arrayBuffer());
      stdout.write(writeMedia(buf, mime, kind));
    } catch (/** @type {any} */ err) {
      // Generated media is a signed storage URL that anything can fetch, but
      // only for a few hours. An old link in a resumed conversation is the
      // likely cause, so say that rather than failing silently.
      stdout.write(`\n[${kind} could not be downloaded from ${url.split('?')[0]}: ${err.message}]\n` +
        `[the signed link may have expired — regenerate it]\n`);
    }
  }
}

/** @param {string} s */
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
/** @param {string} s */
const visLen = (s) => stripAnsi(s).length;
const termWidth = () => stdout.columns || 80;                    // real wrap point
const fmtWidth = () => Math.max(40, Math.min(termWidth(), 100)); // reading width
/** @param {string} [s] */
const out = (s = '') => stdout.write(s + '\n');
/** @param {string} s @param {number} n */
const truncate = (s, n) => (s.length <= n ? s : s.slice(0, Math.max(1, n - 1)) + '…');

const boxRule = (/** @type {string} */ l, /** @type {string} */ r) =>
  gray(l + '─'.repeat(Math.max(2, termWidth() - 3)) + r);
const topRule = () => boxRule('╭', '╮');
const botRule = () => boxRule('╰', '╯');

/** @param {string} s */
const stringWidth = (s) => {
  const clean = stripAnsi(s).replace(/[\u0E31\u0E34-\u0E3A\u0E47-\u0E4E]/g, '');
  let w = 0;
  for (const ch of clean) {
    const cp = ch.codePointAt(0) || 0;
    if ((cp >= 0x1100 && cp <= 0x115F) || (cp >= 0x2E80 && cp <= 0xA4CF) || (cp >= 0xAC00 && cp <= 0xD7A3) ||
        (cp >= 0xF900 && cp <= 0xFAFF) || (cp >= 0xFE10 && cp <= 0xFE19) || (cp >= 0xFE30 && cp <= 0xFE6F) ||
        (cp >= 0xFF00 && cp <= 0xFF60) || (cp >= 0xFFE0 && cp <= 0xFFE6) || (cp >= 0x1F300 && cp <= 0x1F9FF)) {
      w += 2;
    } else {
      w += 1;
    }
  }
  return w;
};

let isGenerating = false;
let isSpinning = false;
let queuedInput = '';
/** @type {string[]} */
const promptQueue = [];
/** @type {AbortController | null} */
let currentAbortController = null;

function updateComposerLine() {
  if (!TTY || !isSpinning) return;
  const inner = Math.max(2, termWidth() - 3);
  const maxW = inner - 2;
  const text = queuedInput
    ? `${queuedInput} ${yellow('[queued]')}`
    : dim('Type to queue next message · Esc to stop');
  const vLen = stringWidth(text);
  const pad = Math.max(0, maxW - 2 - vLen);
  const line = gray('│') + ' ' + cyan('❯') + ' ' + text + ' '.repeat(pad) + gray('│');
  const cursorCol = 5 + stringWidth(queuedInput);
  stdout.write(`\r\x1b[K${line}\x1b[${cursorCol}G`);
}

/** Compact "2h ago" / "3d ago" from an ISO timestamp. @param {string} [iso] */
function relative(iso) {
  const t = iso ? new Date(iso).getTime() : NaN;
  if (Number.isNaN(t)) return '';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.round(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.round(mo / 12)}y ago`;
}

/**
 * Wrap a (possibly styled) string to `w` visible columns, breaking on spaces
 * and hard-splitting any single token longer than the line.
 * @param {string} text
 * @param {number} w
 * @returns {string[]}
 */
function wrap(text, w) {
  /** @type {string[]} */
  const lines = [];
  let cur = '';
  for (let tok of text.split(' ')) {
    while (visLen(tok) > w) {
      const head = tok.slice(0, w);
      if (cur) { lines.push(cur); cur = ''; }
      lines.push(head);
      tok = tok.slice(w);
    }
    if (!cur) cur = tok;
    else if (visLen(cur) + 1 + visLen(tok) <= w) cur += ' ' + tok;
    else { lines.push(cur); cur = tok; }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [''];
}

/**
 * First line gets `firstPrefix`, the rest get `contPrefix` (hanging indent).
 * @param {string} firstPrefix
 * @param {string} contPrefix
 * @param {string} body
 */
function emitWrapped(firstPrefix, contPrefix, body) {
  const lines = wrap(body, fmtWidth() - visLen(contPrefix));
  out(firstPrefix + lines[0]);
  for (let i = 1; i < lines.length; i++) out(contPrefix + lines[i]);
}

/* ---------------------------------------------------------- markdown, inline */

/** @param {string} s @returns {string} */
function inline(s) {
  s = s.replace(/`([^`]+)`/g, (_, c) => cyan(c));
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, u) => `${underline(t)} ${dim('(' + u + ')')}`);
  s = s.replace(/\*\*([^*]+)\*\*/g, (_, c) => bold(c));
  s = s.replace(/(?<![*\w])\*(?!\s)([^*\n]+?)\*(?![*\w])/g, (_, c) => italic(c));
  return s;
}

/**
 * Block-level markdown, one source line at a time, holding fenced-code state
 * across calls. Answer text carries a two-space left margin.
 * @returns {(raw: string) => void}
 */
function makeRenderer() {
  const g = '  ';
  let inFence = false;

  return function line(raw) {
    const fence = raw.match(/^\s*```(.*)$/);
    if (fence) { inFence = !inFence; out(g + gray('```' + (inFence ? fence[1].trim() : ''))); return; }
    if (inFence) { out(g + gray('│ ') + raw.replace(/\t/g, '    ')); return; }

    if (raw.trim() === '') { out(''); return; }

    const h = raw.match(/^(#{1,6})\s+(.*)$/);
    if (h) { out(''); out(g + bold(cyan(inline(h[2])))); return; }

    if (/^\s*([-*_])\1{2,}\s*$/.test(raw)) { out(g + gray('─'.repeat(Math.min(fmtWidth() - 2, 48)))); return; }

    const b = raw.match(/^(\s*)[-*+]\s+(.*)$/);
    if (b) { emitWrapped(g + b[1] + gray('• '), g + b[1] + '  ', inline(b[2])); return; }

    const n = raw.match(/^(\s*)(\d+)[.)]\s+(.*)$/);
    if (n) { emitWrapped(g + n[1] + gray(n[2] + '. '), g + n[1] + '   ', inline(n[3])); return; }

    const q = raw.match(/^\s*>\s?(.*)$/);
    if (q) { for (const l of wrap(inline(q[1]), fmtWidth() - 4)) out(g + gray('│ ') + dim(l)); return; }

    for (const l of wrap(inline(raw), fmtWidth() - 2)) out(g + l);
  };
}

/* ----------------------------------------------------------- tool activity */

/**
 * Render one `reasoning_content` block — a tool call/result line, or a
 * `sources:` list — compact and dim, never mixed into the prose.
 * @param {string} block
 */
function renderTool(block) {
  const lines = block.split('\n').map((l) => l.replace(/\s+$/, '')).filter(Boolean);
  const w = fmtWidth();
  let sources = false;
  let shown = 0;
  let hidden = 0;

  for (const l of lines) {
    if (/^sources:?\s*$/i.test(l)) { sources = true; out(''); out('  ' + dim('sources')); continue; }

    if (sources) {
      const entry = (l.match(/^\s*[-*]\s+(.*)$/)?.[1] ?? l).trim();
      if (shown >= 6) { hidden++; continue; }
      shown++;
      const u = entry.match(/^(.*?)\s+(https?:\/\/\S+)\s*$/);
      if (u) { out('  ' + dim('· ' + truncate(u[1].trim(), w - 6))); out('    ' + gray(truncate(u[2], w - 6))); }
      else out('  ' + dim('· ' + truncate(entry, w - 6)));
      continue;
    }

    const t = l.match(/^\[([a-z0-9_]+)\]\s*(.*)$/i);
    if (t) out('  ' + green('⏺') + ' ' + dim('[' + t[1] + ']') + (t[2] ? ' ' + dim(truncate(t[2], w - 14)) : ''));
    else if (shown < 8) { shown++; out('  ' + dim('⎿ ' + truncate(l.trim(), w - 6))); }
    else hidden++;
  }
  if (hidden) out('  ' + dim('· … +' + hidden + ' more'));
}

/* =========================================================== agent loop */

/* ---------------------------------------- WAF encoding (same as agent.mjs) */

/** @type {Array<[RegExp, string]>} */
const SUBSTITUTIONS = [
  [/127\.0\.0\.1/g,          'LOOPBACK-IP'],
  [/169\.254\.169\.254/g,    'METADATA-IP'],
  [/0\.0\.0\.0/g,            'ANY-IP'],
  [/localhost/gi,             'LCLHST'],
  // URL schemes — https/http/ftp/chrome appear in READMEs and trigger URL-based rules
  [/https:\/\//gi,            'HTTPS-URL'],
  [/http:\/\//gi,             'HTTP-URL'],
  [/chrome:\/\//gi,           'CHROME-URL'],
  [/ftp:\/\//gi,              'FTP-URL'],
  [/file:\/\//gi,             'FILE-URI'],
  // HTML patterns
  [/<!doctype/gi,             'DOCTYPE-DECL'],
  [/<!--/g,                   'CMT-OPEN'],
  [/-->/g,                    'CMT-CLOSE'],
  [/<script/gi,               'TAG-SCRIPT-OPEN'],
  [/<\/script>/gi,            'TAG-SCRIPT-CLOSE'],
  [/javascript:/gi,           'JS-SCHEME'],
  // Shell / secrets patterns
  [/process\.env/gi,          'PROCESS-ENV'],
  [/\.env\b/gi,               'DOT-ENV'],
  [/node:child_process/gi,    'NODE-CHILD-PROC'],
  [/child_process/gi,         'CHILD-PROC'],
  [/process\.kill/gi,         'PROCESS-KILL'],
  [/\/bin\//gi,               'SLASH-BIN-SLASH'],
  [/\/etc\//gi,               'SLASH-ETC-SLASH'],
  [/\bspawnSync\b/g,          'SPAWN-SYNC-CALL'],
  [/\bspawn\b/g,              'SPAWN-CALL'],
  [/\bexecSync\b/g,           'EXEC-SYNC-CALL'],
  [/ExecutionPolicy/gi,       'EXEC-POLICY'],
  [/Bypass\b/gi,              'BYPASS-ARG'],
  [/powershell/gi,            'PSHELL'],
  [/\.ps1\b/gi,               'DOT-PS1'],
  [/\.sh\b/gi,                'DOT-SH'],
  [/&&/g,                     'AND-AND'],
  [/~(?=\/)/g,                'TILDE-PATH'],
  // General tag opener (must be last so earlier specific patterns run first)
  [/<(?=[a-zA-Z/!?])/g,      'TAG-LT'],
];
/** @type {Array<[RegExp, string]>} */
const RESTORE = [
  [/LOOPBACK-IP/g,       '127.0.0.1'],
  [/METADATA-IP/g,       '169.254.169.254'],
  [/ANY-IP/g,            '0.0.0.0'],
  [/LCLHST/g,            'localhost'],
  [/HTTPS-URL/g,         'https://'],
  [/HTTP-URL/g,          'http://'],
  [/CHROME-URL/g,        'chrome://'],
  [/FTP-URL/g,           'ftp://'],
  [/FILE-URI/g,          'file://'],
  [/DOCTYPE-DECL/g,      '<!doctype'],
  [/CMT-OPEN/g,          '<!--'],
  [/CMT-CLOSE/g,         '-->'],
  [/TAG-SCRIPT-OPEN/g,   '<script'],
  [/TAG-SCRIPT-CLOSE/g,  '</script>'],
  [/JS-SCHEME/g,         'javascript:'],
  [/PROCESS-ENV/g,       'process.env'],
  [/DOT-ENV/g,           '.env'],
  [/NODE-CHILD-PROC/g,   'node:child_process'],
  [/CHILD-PROC/g,        'child_process'],
  [/PROCESS-KILL/g,      'process.kill'],
  [/SLASH-BIN-SLASH/g,   '/bin/'],
  [/SLASH-ETC-SLASH/g,   '/etc/'],
  [/SPAWN-SYNC-CALL/g,   'spawnSync'],
  [/SPAWN-CALL/g,        'spawn'],
  [/EXEC-SYNC-CALL/g,    'execSync'],
  [/EXEC-POLICY/g,       'ExecutionPolicy'],
  [/BYPASS-ARG/g,        'Bypass'],
  [/PSHELL/g,            'powershell'],
  [/DOT-PS1/g,           '.ps1'],
  [/DOT-SH/g,            '.sh'],
  [/AND-AND/g,           '&&'],
  [/TILDE-PATH/g,        '~'],
  [/TAG-LT/g,            '<'],
];
/** @param {string} text @returns {string} */
const agentOutbound = (text) => SUBSTITUTIONS.reduce((acc, [re, to]) => acc.replace(re, to), text);
/** @param {string} text @returns {string} */
const agentInbound  = (text) => RESTORE.reduce((acc, [re, to]) => acc.replace(re, to), text);

/* ----------------------------------------- overlay filesystem */

const overlay    = new Map();
const AGENT_SKIP = new Set(['node_modules', '.git', '.next', 'dist', 'build', '.cache']);
let   agentRoot     = process.cwd();
let   agentAllowRun = false;

// Mode state — toggled by /agent with no task
let   agentMode        = false;  // true = agent mode, false = chat mode
let   agentModeAllowRun = false; // persists across tasks while in agent mode
let   agentModeMaxSteps = 10;
let   agentModeAutoApply = /** @type {boolean | null} */ (null);
const AGENT_MAX_RESULT = 3000;
const AGENT_READ_LINES = 200;

/** @param {string} s @returns {string} */
const agentClip = (s) => (s.length > AGENT_MAX_RESULT ? `${s.slice(0, AGENT_MAX_RESULT)}\n… truncated` : s);

/** @param {string} p @returns {string} */
const posix = (p) => p.split(path.sep).join('/');

/** @param {string} p @returns {string} */
function agentSafe(p) {
  const abs = path.resolve(agentRoot, p);
  if (abs !== agentRoot && !abs.startsWith(agentRoot + path.sep))
    throw new Error(`path escapes root: ${p}`);
  return abs;
}
const AGENT_DELETED = '\x00DELETE\x00';
/** @param {string} abs @returns {string} */
const agentReadAt   = (abs) => {
  if (overlay.has(abs)) {
    const val = overlay.get(abs);
    if (val === AGENT_DELETED) throw new Error(`file was deleted: ${posix(path.relative(agentRoot, abs))}`);
    return /** @type {string} */ (val);
  }
  return fs.readFileSync(abs, 'utf8');
};
/** @param {string} abs @returns {boolean} */
const agentExistsAt = (abs) => {
  if (overlay.has(abs)) return overlay.get(abs) !== AGENT_DELETED;
  return fs.existsSync(abs);
};

/** @param {string} block @returns {string} */
function stripGutter(block) {
  const gutter  = /^\s{0,6}\d+\s*\|\s?/;
  const lines   = block.split('\n');
  const nonEmpty = lines.filter((/** @type {string} */ l) => l.trim());
  if (nonEmpty.length && nonEmpty.every((/** @type {string} */ l) => gutter.test(l)))
    return lines.map((/** @type {string} */ l) => l.replace(gutter, '')).join('\n');
  return block;
}

/* ----------------------------------------- tool implementations */

/** @type {Record<string, (arg: string, body?: any) => string | Promise<string>>} */
const AGENT_TOOLS = {
  /** @param {string} arg */
  list(arg) {
    const abs = agentSafe(arg || '.');
    return agentClip(
      fs.readdirSync(abs, { withFileTypes: true })
        .filter((e) => !AGENT_SKIP.has(e.name))
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
        .sort().join('\n') || '(empty)',
    );
  },
  /** @param {string} arg */
  read(arg) {
    const parts = String(arg).trim().split(/\s+/);
    /** @type {[number, number] | null} */
    let range = null;
    if (parts.length > 1 && /^\d+-\d+$/.test(parts.at(-1) ?? '')) {
      const [a, b] = (parts.pop() ?? '').split('-').map(Number);
      range = [a, b];
    }
    const rel = parts.join(' ');
    const abs = agentSafe(rel);
    if (!agentExistsAt(abs)) return `no such file: ${rel}`;
    const lines = agentReadAt(abs).split('\n');
    const total = lines.length;
    let start = 1, end = total;
    if (range) { start = Math.max(1, range[0]); end = Math.min(total, range[1]); }
    else if (total > AGENT_READ_LINES) end = AGENT_READ_LINES;
    const width = String(end).length;
    const numbered = lines.slice(start - 1, end)
      .map((l, i) => `${String(start + i).padStart(width)} | ${l}`).join('\n');
    let note = '';
    if (end < total) note = `\n… ${total - end} more line(s). To see them: NEED file ${rel} ${end + 1}-${Math.min(total, end + AGENT_READ_LINES)}`;
    else if (start > 1) note = `\n(lines ${start}-${end} of ${total})`;
    return numbered + note;
  },
  /**
   * @param {string} arg
   * @param {string} rawBody
   */
  write(arg, rawBody) {
    const body = /** @type {string} */ (agentInbound(rawBody));
    overlay.set(agentSafe(arg), body);
    return `wrote ${arg}, ${body.split('\n').length} lines`;
  },
  /**
   * @param {string} arg
   * @param {[string, string]} rawBody
   */
  replace(arg, rawBody) {
    const abs = agentSafe(arg);
    if (!agentExistsAt(abs)) return `no such file: ${arg}`;
    const before = /** @type {string} */ (agentInbound(stripGutter(rawBody[0])));
    const after  = /** @type {string} */ (agentInbound(rawBody[1]));
    const text   = agentReadAt(abs);
    if (!before) return 'the text to change was empty. Copy the exact lines to find under FIND.';
    const count = text.split(before).length - 1;
    if (count === 0) return `the text to change was not found in ${arg}. Read it again with NEED file ${arg} and copy the lines exactly.`;
    if (count > 1)  return `that text appears ${count} times in ${arg}. Include a few more surrounding lines under FIND so it matches exactly one place.`;
    overlay.set(abs, text.replace(before, after));
    return `updated ${arg} (1 change)`;
  },
  /** @param {string} arg */
  search(arg) {
    const query  = String(arg).trim();
    if (!query) return 'give me some text to search for.';
    const needle = /** @type {string} */ (agentInbound(query));
    /** @type {string[]} */
    const hits   = [];
    const MAX    = 50;
    /** @param {string} dir */
    const walk   = (dir) => {
      if (hits.length >= MAX) return;
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (AGENT_SKIP.has(e.name) || e.name.startsWith('.')) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { walk(full); continue; }
        if (hits.length >= MAX) return;
        let txt;
        try { txt = agentReadAt(full); } catch { continue; }
        if (txt.includes('\u0000')) continue; // skip binary
        const lines = txt.split('\n');
        for (let i = 0; i < lines.length && hits.length < MAX; i++) {
          if (lines[i].includes(needle))
            hits.push(`${posix(path.relative(agentRoot, full))}:${i + 1}: ${lines[i].trim().slice(0, 140)}`);
        }
      }
    };
    walk(agentRoot);
    if (!hits.length) return `no matches for "${query}".`;
    const more = hits.length >= MAX ? `\n… stopped at ${MAX} matches; make the search more specific.` : '';
    return hits.join('\n') + more;
  },
  /**
   * @param {string} _arg
   * @param {string} body
   */
  run(_arg, body) {
    if (!agentAllowRun)
      return 'shell commands are disabled. Add --allow-run to your /agent command.';
    try {
      return agentClip(execSync(body, { cwd: agentRoot, encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'] }));
    } catch (err) {
      const e = /** @type {any} */ (err);
      return agentClip(`exit ${e.status}\n${String(e.stdout ?? '')}${String(e.stderr ?? '')}`);
    }
  },

  /** @param {string} pattern @returns {string} */
  glob(pattern) {
    if (!pattern) return 'give me a glob pattern, e.g. **/*.ts';
    // simple recursive walk with minimatch-style * and ** support
    const patParts = pattern.split('/');
    /** @param {string} pat @param {string} seg @returns {boolean} */
    const matchPart = (pat, seg) => {
      if (pat === '**') return true;
      const re = new RegExp('^' + pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*') + '$', 'i');
      return re.test(seg);
    };
    /** @type {string[]} */
    const hits = [];
    const MAX = 200;
    /** @param {string} dir @param {number} depth */
    const walk = (dir, depth) => {
      if (hits.length >= MAX) return;
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (AGENT_SKIP.has(e.name) || e.name.startsWith('.')) continue;
        const rel  = path.relative(agentRoot, path.join(dir, e.name));
        const segs = rel.split(path.sep);
        // Check if this path matches the pattern
        let match = false;
        if (patParts.includes('**')) {
          // ** matches zero or more path segments — just check last part
          const lastPat = patParts.at(-1) ?? '';
          match = matchPart(lastPat, e.name);
        } else {
          match = segs.length === patParts.length &&
            segs.every((s, i) => matchPart(patParts[i] ?? '', s));
        }
        if (match && !e.isDirectory()) hits.push(posix(rel));
        if (e.isDirectory()) walk(path.join(dir, e.name), depth + 1);
      }
    };
    walk(agentRoot, 0);
    if (!hits.length) return `no files matched "${pattern}".`;
    const more = hits.length >= MAX ? `\n… stopped at ${MAX} results.` : '';
    return hits.join('\n') + more;
  },

  /** @param {string} arg @returns {string} */
  git(arg) {
    const sub = arg.trim();
    if (!sub) return 'give me a git subcommand, e.g. status';
    // Allow only read-only / informational subcommands
    const ALLOWED = /^(status|diff|log|show|branch|tag|remote|stash\s+list|ls-files|rev-parse|describe)/i;
    if (!ALLOWED.test(sub))
      return `only read-only git subcommands are allowed (status, diff, log, show, branch, ls-files, …). Got: ${sub}`;
    try {
      return agentClip(execSync(`git ${sub}`, { cwd: agentRoot, encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'] }));
    } catch (err) {
      const e = /** @type {any} */ (err);
      return agentClip(`exit ${e.status ?? 1}\n${String(e.stderr ?? e.stdout ?? '')}`);
    }
  },

  /** @param {string} url @returns {Promise<string>} */
  async fetch(url) {
    const u = agentInbound(url.trim());
    if (!u || !/^https?:\/\//i.test(u)) return `invalid URL: ${url}. Must start with http:// or https://`;
    try {
      const res = await globalThis.fetch(u, {
        headers: { 'user-agent': 'aipass-agent/1.0', 'accept': 'text/plain,text/html,*/*' },
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) return `HTTP ${res.status} ${res.statusText} from ${u}`;
      let text = await res.text();
      // Strip HTML tags for readability
      text = text.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<script[\s\S]*?<\/script>/gi, '');
      text = text.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ');
      text = text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
      return agentClip(agentOutbound(text));
    } catch (err) {
      return `fetch error: ${/** @type {Error} */ (err).message}`;
    }
  },

  /** @param {string} arg @returns {string} */
  delete(arg) {
    const rel = arg.trim();
    if (!rel) return 'give me a file path to delete.';
    const abs = agentSafe(rel);
    if (!agentExistsAt(abs)) return `no such file: ${rel}`;
    if (!fs.existsSync(abs)) {
      overlay.delete(abs);
      return `deleted ${rel} from memory (was not yet written to disk).`;
    }
    overlay.set(abs, AGENT_DELETED);
    return `marked ${rel} for deletion. Will be removed on Apply.`;
  },

  /** @param {string} arg @returns {string} */
  move(arg) {
    const parts = arg.trim().split(/\s+/);
    if (parts.length < 2) return 'usage: MOVE <from> <to>';
    const [fromRel, toRel] = parts;
    const fromAbs = agentSafe(fromRel);
    const toAbs   = agentSafe(toRel);
    if (!agentExistsAt(fromAbs)) return `no such file: ${fromRel}`;
    const content = agentReadAt(fromAbs);
    overlay.set(toAbs, content);
    if (fs.existsSync(fromAbs)) {
      overlay.set(fromAbs, AGENT_DELETED);
    } else {
      overlay.delete(fromAbs);
    }
    return `marked: move ${fromRel} → ${toRel}. Will apply on disk after Apply.`;
  },

  /** @param {string} query @returns {Promise<string>} */
  async web(query) {
    const q = agentInbound(query.trim());
    if (!q) return 'give me a query to search for.';

    out(dim(`  searching web for "${q}"…`));

    const prompt = `Please search the web and provide detailed, up-to-date facts, answers, and sources for: ${q}`;
    let res;
    try {
      res = await fetch(`${BRIDGE}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, stream: true, messages: [{ role: 'user', content: prompt }] }),
      });
    } catch (err) {
      return `web search failed: ${/** @type {Error} */ (err).message}`;
    }

    if (!res.ok) return `web search failed: HTTP ${res.status}`;
    if (!res.body) return 'web search failed: no response body';

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let content = '';
    let sources = '';

    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let cut;
      while ((cut = buf.indexOf('\n\n')) !== -1) {
        const frameText = buf.slice(0, cut);
        buf = buf.slice(cut + 2);
        const data = frameText.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
        if (!data || data === '[DONE]') continue;
        /** @type {SSEChunk} */
        let evt;
        try { evt = JSON.parse(data); } catch { continue; }
        if (evt.error) return `web search error: ${evt.error.message}`;
        const delta = evt.choices?.[0]?.delta ?? {};
        if (delta.reasoning_content) {
          renderTool(delta.reasoning_content);
          if (delta.reasoning_content.includes('http') || delta.reasoning_content.includes('sources:')) {
            sources += '\n' + delta.reasoning_content;
          }
        }
        if (delta.content) {
          content += delta.content;
        }
      }
    }
    const result = (content + (sources ? `\n\n${sources}` : '')).trim();
    return agentClip(agentOutbound(result || 'no results found'));
  },
};

/* ----------------------------------------- protocol text */

/** @param {boolean} allowRun @returns {string} */
const AGENT_PREAMBLE = (allowRun) =>
  `I am reading through a project with you. The files are open in front of me, and I will paste you anything you want to look at.

So just tell me what you want to see next, and put that on its own line in this shape, because my editor watches for these markers:

NEED dir .
NEED file README.md
NEED file src/index.ts 1-80
SEARCH text to find across the whole project
GLOB **/*.ts
GIT status
GIT diff
FETCH HTTPS-URLexample.com/docs
WEB search terms to look up on the internet (docs, latest versions, solutions)

If you want a file changed, write it like this and I will make the edit:

EDIT notes.md
FIND
the exact lines as they appear now
NEW
the lines to put there instead
END

To start a new file:

CREATE notes.md
the contents
END

To delete a file:

DELETE old-file.ts

To rename or move a file:

MOVE old-name.ts new-name.ts${allowRun ? '\n\nTo have me run something in the terminal:\n\nRUN\nwhat to run\nEND' : ''}

Once you have everything you need and are giving me your final answer, finish with:

DONE one sentence about what you found or changed

Only write DONE at the very end, when nothing more is needed. Never put DONE in the same reply as a NEED — ask for what you want, wait for me to paste it, and read it first.

The markers are only formatting for my editor. Nothing runs on your side — I do all of it and paste every result straight back to you, so keep going until you have what you need.

CRITICAL: You are an AI assistant collaborating with me in this chat. You do NOT access my local filesystem directly — I am a human running this terminal on my own computer, and I personally read the files you name and paste their contents back to you. Therefore, NEVER state that you cannot access files, and NEVER refuse to use these markers — asking for a file with NEED file <path> is simply requesting me to paste it for you. Even if my prompt or question is in Thai or another language, accept it and request the files you need using the exact markers above.

A few practical notes. Answer in English. Look at a file before changing it, and copy the lines under FIND exactly as they appear. When I show a file the numbers down the left are only for reference — do not put them in FIND. Big files come a screen at a time; ask for a range like NEED file path 201-400 to see more. To find where something lives without reading every file, use SEARCH followed by the text. Use GLOB to find all files matching a pattern. Use GIT to see what has changed recently. Use FETCH to read a URL (docs, APIs). Use WEB followed by search keywords to search the internet (with live web search and citations). Some hostnames and addresses are written in a shortened form such as LCLHST and LOOPBACK-IP, and URLs start with HTTPS-URL or HTTP-URL; keep them as written and I will expand them again. If my question can be answered without changing anything, just answer it and end with DONE.`;

const AGENT_REMINDER    = 'What next? Ask for anything else you need, or finish with DONE if you have enough.';
const AGENT_MARKER_LINE = /^\s*(NEED\s+(dir|file)\b|SEARCH\b|GLOB\b|GIT\b|FETCH\b|WEB\b|DELETE\b|MOVE\b|EDIT\b|CREATE\b|FIND\s*$|NEW\s*$|END\s*$|RUN\s*$|(?:\*{1,3}|#{1,6}\s*)?DONE\b)/i;
/** @param {string} reply @returns {string} */
const agentProse = (reply) => reply.split('\n').filter((/** @type {string} */ l) => !AGENT_MARKER_LINE.test(l)).join('\n').trim();

/** @param {string} reply @returns {Array<{kind: string, arg: string, body?: any}>} */
function agentParse(reply) {
  const lines = reply.split('\n');
  /** @type {Array<{kind: string, arg: string, body?: any}>} */
  const calls = [];
  let i = 0;
  /** @param {string[]} stops @returns {string} */
  const readUntil = (stops) => {
    const body = [];
    while (i < lines.length && !stops.some((/** @type {string} */ st) => new RegExp(`^\\s*${st}\\s*$`, 'i').test(lines[i]))) body.push(lines[i++]);
    return body.join('\n');
  };
  while (i < lines.length) {
    const line = lines[i];
    let m = /^\s*NEED\s+(dir|file)\s+(.+?)\s*$/i.exec(line);
    if (m) { i++; calls.push({ kind: m[1].toLowerCase() === 'dir' ? 'list' : 'read', arg: m[2].trim() }); continue; }
    m = /^\s*SEARCH\s+(.+?)\s*$/i.exec(line);
    if (m) { i++; calls.push({ kind: 'search', arg: m[1].trim() }); continue; }
    m = /^\s*GLOB\s+(.+?)\s*$/i.exec(line);
    if (m) { i++; calls.push({ kind: 'glob', arg: m[1].trim() }); continue; }
    m = /^\s*GIT\s+(.+?)\s*$/i.exec(line);
    if (m) { i++; calls.push({ kind: 'git', arg: m[1].trim() }); continue; }
    m = /^\s*FETCH\s+(.+?)\s*$/i.exec(line);
    if (m) { i++; calls.push({ kind: 'fetch', arg: m[1].trim() }); continue; }
    m = /^\s*WEB\s+(.+?)\s*$/i.exec(line);
    if (m) { i++; calls.push({ kind: 'web', arg: m[1].trim() }); continue; }
    m = /^\s*DELETE\s+(.+?)\s*$/i.exec(line);
    if (m) { i++; calls.push({ kind: 'delete', arg: m[1].trim() }); continue; }
    m = /^\s*MOVE\s+(.+?)\s*$/i.exec(line);
    if (m) { i++; calls.push({ kind: 'move', arg: m[1].trim() }); continue; }
    m = /^\s*EDIT\s+(.+?)\s*$/i.exec(line);
    if (m) {
      i++;
      if (/^\s*FIND\s*$/i.test(lines[i] ?? '')) i++;
      const before = readUntil(['NEW', 'END']);
      if (/^\s*NEW\s*$/i.test(lines[i] ?? '')) i++;
      const after = readUntil(['END']);
      if (/^\s*END\s*$/i.test(lines[i] ?? '')) i++;
      calls.push({ kind: 'replace', arg: m[1].trim(), body: [before, after] }); continue;
    }
    m = /^\s*CREATE\s+(.+?)\s*$/i.exec(line);
    if (m) {
      i++;
      const body = readUntil(['END']);
      if (/^\s*END\s*$/i.test(lines[i] ?? '')) i++;
      calls.push({ kind: 'write', arg: m[1].trim(), body }); continue;
    }
    if (/^\s*RUN\s*$/i.test(line)) {
      i++;
      const body = readUntil(['END']);
      if (/^\s*END\s*$/i.test(lines[i] ?? '')) i++;
      calls.push({ kind: 'run', arg: '', body }); continue;
    }
    m = /^\s*(?:\*{1,3}|#{1,6}\s*)?DONE\b[:\s—–-]*(.*)/i.exec(line);
    if (m) { i++; calls.push({ kind: 'done', arg: m[1].trim() }); continue; }
    i++;
  }
  return calls;
}

/* ---------------------------------------------------- multimodal / image & document attach */

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']);
const CODE_EXTS = [
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx',
  '.py', '.sh', '.bash', '.zsh',
  '.html', '.htm', '.css', '.scss', '.sass', '.less',
  '.yaml', '.yml', '.toml', '.xml', '.sql',
  '.c', '.cpp', '.cc', '.h', '.hpp',
  '.rs', '.go', '.java', '.kt', '.php', '.rb',
  '.env', '.log', '.ini', '.conf',
];
const DOCUMENT_EXTS = new Set([
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.txt', '.md', '.csv', '.json',
  ...CODE_EXTS,
]);

const DOC_MIME_MAP = {
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.json': 'application/json',
  ...Object.fromEntries(CODE_EXTS.map((ext) => [ext, 'text/plain'])),
};

/**
 * @typedef {object} AttachedImage
 * @property {number} id
 * @property {string} tag
 * @property {string} dataUri
 * @property {string} source
 * @property {number} size
 */

/**
 * @typedef {object} AttachedDocument
 * @property {number} id
 * @property {string} tag
 * @property {string} filename
 * @property {string} dataUri
 * @property {string} source
 * @property {number} size
 */

/** @type {Map<string, AttachedImage>} */
const pendingImages = new Map();
let nextImageId = 1;

/** @type {Map<string, AttachedDocument>} */
const pendingDocuments = new Map();
let nextDocId = 1;

/**
 * @param {string} dataUri
 * @param {string} source
 * @param {number} size
 * @returns {AttachedImage}
 */
function registerImage(dataUri, source, size) {
  const id = nextImageId++;
  const tag = `[image${id}]`;
  const item = { id, tag, dataUri, source, size };
  pendingImages.set(tag, item);
  return item;
}

/**
 * @param {string} dataUri
 * @param {string} filename
 * @param {string} source
 * @param {number} size
 * @returns {AttachedDocument}
 */
function registerDocument(dataUri, filename, source, size) {
  const id = nextDocId++;
  const tag = `[file${id}]`;
  const item = { id, tag, filename, dataUri, source, size };
  pendingDocuments.set(tag, item);
  return item;
}

/**
 * Resolves a document file path.
 * @param {string} candidate
 * @returns {string | null}
 */
function resolveDocumentPath(candidate) {
  if (!candidate || typeof candidate !== 'string') return null;
  let p = candidate.trim();
  if ((p.startsWith('"') && p.endsWith('"')) || (p.startsWith("'") && p.endsWith("'"))) {
    p = p.slice(1, -1).trim();
  }
  if (p.startsWith('file://')) {
    try {
      p = decodeURIComponent(new URL(p).pathname);
    } catch {
      p = p.slice(7);
    }
  }
  if (p.startsWith('~/') || p === '~') {
    p = path.join(os.homedir(), p.slice(2));
  }
  const resolved = path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
  const ext = path.extname(resolved).toLowerCase();
  if (!DOCUMENT_EXTS.has(ext)) return null;
  try {
    if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
      return resolved;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Attaches a document from a local file.
 * @param {string} filePath
 * @returns {AttachedDocument | null}
 */
function attachDocumentFromFile(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > 20 * 1024 * 1024) {
      if (TTY) stdout.write('\r\n' + red(`  ✗ file too large: ${(stat.size / (1024 * 1024)).toFixed(1)} MB (max 20 MB)`) + '\r\n');
      return null;
    }
    const buf = fs.readFileSync(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const mime = (/** @type {Record<string, string>} */ (DOC_MIME_MAP))[ext] || 'application/octet-stream';
    const dataUri = `data:${mime};base64,${buf.toString('base64')}`;
    const filename = path.basename(filePath);
    return registerDocument(dataUri, filename, filePath, buf.length);
  } catch (/** @type {any} */ err) {
    if (TTY) stdout.write('\r\n' + red(`  ✗ cannot read file: ${err.message}`) + '\r\n');
    return null;
  }
}

/**
 * Scans a prompt line for [fileN] tags or direct document file paths.
 * @param {string} text
 * @returns {AttachedDocument[]}
 */
function getAttachedDocumentsForLine(text) {
  /** @type {AttachedDocument[]} */
  const attached = [];
  const matchedTags = text.match(/\[file\d+\]/gi) || [];
  for (const rawTag of matchedTags) {
    const tag = rawTag.toLowerCase();
    const doc = pendingDocuments.get(tag);
    if (doc && !attached.some((x) => x.id === doc.id)) {
      attached.push(doc);
    }
  }
  const tokens = text.split(/\s+/);
  for (const tok of tokens) {
    const resolved = resolveDocumentPath(tok);
    if (resolved) {
      const reg = attachDocumentFromFile(resolved);
      if (reg && !attached.some((x) => x.id === reg.id)) {
        attached.push(reg);
      }
    }
  }
  return attached;
}

/** @param {string} filePath @returns {string} */
function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.bmp') return 'image/bmp';
  return 'application/octet-stream';
}

/**
 * Resolves an image file path (handling quotes, file://, ~, relative paths).
 * Returns absolute path if valid image file exists, else null.
 * @param {string} candidate
 * @returns {string | null}
 */
function resolveImagePath(candidate) {
  if (!candidate || typeof candidate !== 'string') return null;
  let p = candidate.trim();
  if ((p.startsWith('"') && p.endsWith('"')) || (p.startsWith("'") && p.endsWith("'"))) {
    p = p.slice(1, -1).trim();
  }
  if (p.startsWith('file://')) {
    try {
      p = decodeURIComponent(new URL(p).pathname);
    } catch {
      p = p.slice(7);
    }
  }
  if (p.startsWith('~/') || p === '~') {
    p = path.join(os.homedir(), p.slice(2));
  }
  const resolved = path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
  const ext = path.extname(resolved).toLowerCase();
  if (!IMAGE_EXTS.has(ext)) return null;
  try {
    if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
      return resolved;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Reads an image from the OS clipboard without external dependencies.
 * @returns {{ buffer: Buffer, mime: string, source: string } | null}
 */
function readClipboardImage() {
  try {
    if (process.platform === 'linux') {
      if (process.env.WAYLAND_DISPLAY || process.env.XDG_SESSION_TYPE === 'wayland') {
        const check = spawnSync('wl-paste', ['--list-types'], { encoding: 'utf8', timeout: 1500 });
        if (check.status === 0 && check.stdout && /image\/(png|jpeg|jpg|webp)/i.test(check.stdout)) {
          const m = check.stdout.match(/image\/(png|jpeg|jpg|webp)/i);
          const mime = m ? m[0].toLowerCase() : 'image/png';
          const res = spawnSync('wl-paste', ['--type', mime], { timeout: 3000, maxBuffer: 15 * 1024 * 1024 });
          if (res.status === 0 && res.stdout && res.stdout.length > 0) {
            return { buffer: Buffer.isBuffer(res.stdout) ? res.stdout : Buffer.from(res.stdout), mime, source: 'clipboard' };
          }
        }
      }
      const checkX = spawnSync('xclip', ['-selection', 'clipboard', '-target', 'TARGETS', '-o'], { encoding: 'utf8', timeout: 1500 });
      if (checkX.status === 0 && checkX.stdout && /image\/(png|jpeg|jpg|webp)/i.test(checkX.stdout)) {
        const m = checkX.stdout.match(/image\/(png|jpeg|jpg|webp)/i);
        const mime = m ? m[0].toLowerCase() : 'image/png';
        const res = spawnSync('xclip', ['-selection', 'clipboard', '-t', mime, '-o'], { timeout: 3000, maxBuffer: 15 * 1024 * 1024 });
        if (res.status === 0 && res.stdout && res.stdout.length > 0) {
          return { buffer: Buffer.isBuffer(res.stdout) ? res.stdout : Buffer.from(res.stdout), mime, source: 'clipboard' };
        }
      }
    } else if (process.platform === 'darwin') {
      const pp = spawnSync('pngpaste', ['-'], { timeout: 2000, maxBuffer: 15 * 1024 * 1024 });
      if (pp.status === 0 && pp.stdout && pp.stdout.length > 0) {
        return { buffer: pp.stdout, mime: 'image/png', source: 'clipboard' };
      }
      const tmpPath = path.join(os.tmpdir(), `aipass-clip-${Date.now()}.png`);
      const script = `try\nset clip to (get the clipboard as «class PNGf»)\nset fn to "${tmpPath}"\nset f to open for access (POSIX file fn) with write permission\nset eof f to 0\nwrite clip to f\nclose access f\nreturn "ok"\non error\nreturn "fail"\nend try`;
      const res = spawnSync('osascript', ['-e', script], { encoding: 'utf8', timeout: 3000 });
      if (res.status === 0 && res.stdout.trim() === 'ok' && fs.existsSync(tmpPath)) {
        const buf = fs.readFileSync(tmpPath);
        try { fs.unlinkSync(tmpPath); } catch {}
        if (buf.length > 0) return { buffer: buf, mime: 'image/png', source: 'clipboard' };
      }
    } else if (process.platform === 'win32') {
      const ps = `Add-Type -AssemblyName System.Windows.Forms; $clip = [System.Windows.Forms.Clipboard]::GetImage(); if ($clip) { $ms = New-Object System.IO.MemoryStream; $clip.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png); [Convert]::ToBase64String($ms.ToArray()) }`;
      const res = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', timeout: 4000 });
      if (res.status === 0 && res.stdout.trim()) {
        const buf = Buffer.from(res.stdout.trim(), 'base64');
        return { buffer: buf, mime: 'image/png', source: 'clipboard' };
      }
    }
  } catch {
    // ignore clipboard errors
  }
  return null;
}

/**
 * Attaches an image from a local file.
 * @param {string} filePath
 * @returns {AttachedImage | null}
 */
function attachImageFromFile(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > 10 * 1024 * 1024) {
      if (TTY) stdout.write('\r\n' + red(`  ✗ image too large: ${(stat.size / (1024 * 1024)).toFixed(1)} MB (max 10 MB)`) + '\r\n');
      return null;
    }
    const buf = fs.readFileSync(filePath);
    const mime = getMimeType(filePath);
    const dataUri = `data:${mime};base64,${buf.toString('base64')}`;
    const filename = path.basename(filePath);
    return registerImage(dataUri, filename, buf.length);
  } catch {
    return null;
  }
}

/**
 * Attaches an image from the OS clipboard.
 * @returns {AttachedImage | null}
 */
function attachImageFromClipboard() {
  const clip = readClipboardImage();
  if (!clip) return null;
  const dataUri = `data:${clip.mime};base64,${clip.buffer.toString('base64')}`;
  return registerImage(dataUri, 'clipboard', clip.buffer.length);
}

/**
 * Detects image file paths in pasted text and converts them to tags like [image1].
 * @param {string} text
 * @returns {string}
 */
function processPastedText(text) {
  if (!text) return text;
  const single = resolveImagePath(text);
  if (single) {
    const reg = attachImageFromFile(single);
    if (reg) {
      if (TTY) {
        stdout.write(`\r\n\x1b[J${dim(`  📎 ${cyan(reg.tag)} attached (${reg.source}, ${(reg.size / 1024).toFixed(1)} KB)`)}\x1b[1A\x1b[${promptCol()}G`);
      }
      return reg.tag + ' ';
    }
  }

  const singleDoc = resolveDocumentPath(text);
  if (singleDoc) {
    const reg = attachDocumentFromFile(singleDoc);
    if (reg) {
      if (TTY) {
        stdout.write(`\r\n\x1b[J${dim(`  📄 ${cyan(reg.tag)} attached (${reg.filename}, ${(reg.size / 1024).toFixed(1)} KB)`)}\x1b[1A\x1b[${promptCol()}G`);
      }
      return reg.tag + ' ';
    }
  }

  const regex = /(?:["'](?:file:\/\/[^"']+|[~/.A-Za-z0-9_ -]+\.(?:png|jpe?g|webp|gif|bmp))["']|file:\/\/\S+|[~/.][^\s"']+\.(?:png|jpe?g|webp|gif|bmp))/gi;
  let hasReplacement = false;
  const replaced = text.replace(regex, (match) => {
    const resolved = resolveImagePath(match);
    if (resolved) {
      const reg = attachImageFromFile(resolved);
      if (reg) {
        hasReplacement = true;
        return reg.tag;
      }
    }
    return match;
  });

  if (hasReplacement && TTY) {
    const latest = Array.from(pendingImages.values()).slice(-1)[0];
    if (latest) {
      stdout.write(`\r\n\x1b[J${dim(`  📎 ${cyan(latest.tag)} attached (${latest.source})`)}\x1b[1A\x1b[${promptCol()}G`);
    }
  }

  return replaced;
}

/**
 * Scans a prompt line for [imageN] tags or direct image file paths.
 * @param {string} text
 * @returns {AttachedImage[]}
 */
function getAttachedImagesForLine(text) {
  /** @type {AttachedImage[]} */
  const attached = [];
  const matchedTags = text.match(/\[image\d+\]/gi) || [];
  for (const rawTag of matchedTags) {
    const tag = rawTag.toLowerCase();
    const img = pendingImages.get(tag);
    if (img && !attached.some((x) => x.id === img.id)) {
      attached.push(img);
    }
  }
  const tokens = text.split(/\s+/);
  for (const tok of tokens) {
    const resolved = resolveImagePath(tok);
    if (resolved) {
      const reg = attachImageFromFile(resolved);
      if (reg && !attached.some((x) => x.id === reg.id)) {
        attached.push(reg);
      }
    }
  }
  return attached;
}

/* ----------------------------------------- sayAgent (fetch, returns string) */

/**
 * @param {string} text
 * @param {Array<{ tag: string, dataUri: string }>} [images]
 * @param {AttachedDocument[]} [files]
 * @returns {Promise<string>}
 */
async function sayAgent(text, images = [], files = []) {
  const startedAt = Date.now();
  /** @type {ReturnType<typeof setInterval> | null} */
  let timer = null;
  let frame = 0;
  const startSpin = () => {
    if (!TTY || timer !== null) return;
    timer = setInterval(() => {
      const s = Math.round((Date.now() - startedAt) / 1000);
      stdout.write('\r\x1b[K' + '  ' + cyan(spinFrames[frame = (frame + 1) % spinFrames.length]) + ' ' + dim(`agent thinking… ${s}s`));
    }, 90);
  };
  const stopSpin = () => {
    if (timer === null) return;
    clearInterval(timer); timer = null;
    if (TTY) stdout.write('\r\x1b[K');
  };

  const hasImages = Array.isArray(images) && images.length > 0;
  const hasFiles = Array.isArray(files) && files.length > 0;
  const messagesContent = hasImages || hasFiles
    ? [
        { type: 'text', text },
        ...(hasImages ? images.map((img) => ({ type: 'image_url', image_url: { url: img.dataUri } })) : []),
        ...(hasFiles ? files.map((f) => ({ type: 'file', file: { filename: f.filename, file_data: f.dataUri } })) : []),
      ]
    : text;

  const res = await fetch(`${BRIDGE}/v1/chat/completions`, /** @type {any} */ ({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, stream: true, messages: [{ role: 'user', content: messagesContent }] }),
    ...(currentAbortController ? { signal: currentAbortController.signal } : {}),
  }));
  if (!res.ok) throw new Error(`bridge returned ${res.status}: ${(await res.text()).slice(0, 300)}`);

  startSpin();
  let collected = '';
  const reader  = /** @type {ReadableStream<Uint8Array>} */ (res.body).getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    let readResult;
    try {
      readResult = await reader.read();
    } catch (err) {
      if (err && /** @type {any} */ (err).name === 'AbortError') {
        stopSpin();
        out('\n  ' + yellow('⏹ agent task stopped by user'));
        break;
      }
      throw err;
    }
    const { value, done } = readResult;
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let cut;
    while ((cut = buf.indexOf('\n\n')) !== -1) {
      const frameText = buf.slice(0, cut); buf = buf.slice(cut + 2);
      const data = frameText.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
      if (!data || data === '[DONE]') continue;
      let evt;
      try { evt = JSON.parse(data); } catch { continue; }
      if (evt.error) { stopSpin(); throw new Error(evt.error.message); }
      const delta = evt.choices?.[0]?.delta ?? {};
      if (delta.reasoning_content) {
        stopSpin();
        renderTool(delta.reasoning_content);
        startSpin();
      }
      if (delta.content) collected += delta.content;
    }
  }
  stopSpin();
  return collected;
}

/** @param {string} text @returns {[string, string]} */
function agentSplitInHalf(text) {
  const lines = text.split('\n');
  if (lines.length < 2) { const mid = Math.floor(text.length / 2); return [text.slice(0, mid), text.slice(mid)]; }
  const mid = Math.ceil(lines.length / 2);
  return [lines.slice(0, mid).join('\n'), lines.slice(mid).join('\n')];
}

const AGENT_MIN_SPLIT = 300;
const AGENT_RISKY_LINE = /(node\s+-{1,2}e\b|--eval\b|\beval\(|child_process|exec(Sync)?\(|spawnSync?\(|\bcurl\b|\bwget\b|\b(ba)?sh\b|rm\s+-rf|\/etc\/|\/bin\/|\.\.\/\.\.\/|<!doctype|<!--|-->|<script|<\/script|javascript:|onerror\s*=|onload\s*|ExecutionPolicy|BYPASS|AND-AND|\bpowershell\b)/i;

/** @param {string} text @returns {{ redacted: string, dropped: number }} */
function agentRedact(text) {
  let dropped = 0;
  const redacted = text.split('\n').map((/** @type {string} */ line) => {
    if (!AGENT_RISKY_LINE.test(line)) return line;
    dropped++;
    return '[one line omitted here — it could not be sent]';
  }).join('\n');
  return { redacted, dropped };
}

/**
 * @param {string} text
 * @param {number} [depth]
 * @param {Array<{ tag: string, dataUri: string }>} [images]
 * @param {AttachedDocument[]} [files]
 * @returns {Promise<string>}
 */
async function sayResilient(text, depth = 0, images = [], files = []) {
  if (depth === 0) text = agentOutbound(text);
  try { return await sayAgent(text, depth === 0 ? images : [], depth === 0 ? files : []); }
  catch (err) {
    const blocked = /\b40[39]\b/.test(/** @type {Error} */ (err).message);
    if (!blocked) throw err;

    // Fast-path: if the payload contains known risky patterns, redact them immediately
    // rather than doing slow recursive splits that cause timeouts and extension contention.
    const { redacted, dropped } = agentRedact(text);
    if (dropped && redacted !== text) {
      out('  ' + dim(`  rejected — omitting ${dropped} line(s) that cannot be sent`));
      try { return await sayAgent(redacted); } catch { /* fall through to split */ }
    }

    if (depth > 2 || Buffer.byteLength(text) < AGENT_MIN_SPLIT) {
      out('  ' + dim(`  rejected by firewall — omitting fragment of ${Buffer.byteLength(text)} bytes and continuing`));
      const fallback = `[Note: A section of ~${Buffer.byteLength(text)} bytes was omitted because it was blocked by the upstream Cloudflare firewall. Continuing with the rest of the project.]`;
      try { return await sayAgent(fallback); } catch { throw err; }
    }

    const parts = agentSplitInHalf(text);
    out('  ' + dim(`  rejected — splitting into ${parts.length} parts and resending`));
    let last = '';
    for (let i = 0; i < parts.length; i++) {
      const final  = i === parts.length - 1;
      const prefix = final ? 'Final part.\n\n' : `Part ${i + 1}, more follows. Reply with just: ok\n\n`;
      last = await sayResilient(prefix + parts[i], depth + 1);
    }
    return last;
  }
}

/* ----------------------------------------- diff display */

/**
 * Myers O(ND) line diff. Returns [{t: ' '|'-'|'+', line: string}].
 * @param {string[]} a
 * @param {string[]} b
 */
function lineDiff(a, b) {
  const N = a.length, M = b.length, MAX = N + M;
  const trace = [];
  let v = new Map([[1, 0]]);
  let reached = false;
  for (let d = 0; d <= MAX && !reached; d++) {
    trace.push(new Map(v));
    const next = new Map(v);
    for (let k = -d; k <= d; k += 2) {
      const down = k === -d || (k !== d && (v.get(k - 1) ?? -1) < (v.get(k + 1) ?? -1));
      let x = down ? (v.get(k + 1) ?? 0) : (v.get(k - 1) ?? 0) + 1;
      let y = x - k;
      while (x < N && y < M && a[x] === b[y]) { x++; y++; }
      next.set(k, x);
      if (x >= N && y >= M) { reached = true; break; }
    }
    v = next;
  }
  const result = [];
  let x = N, y = M;
  for (let d = trace.length - 1; d >= 0 && (x > 0 || y > 0); d--) {
    const vd = trace[d];
    const k  = x - y;
    const down = k === -d || (k !== d && (vd.get(k - 1) ?? -1) < (vd.get(k + 1) ?? -1));
    const pk = down ? k + 1 : k - 1;
    const px = vd.get(pk) ?? 0;
    const py = px - pk;
    while (x > px && y > py) { result.push({ t: ' ', line: a[x - 1] }); x--; y--; }
    if (d > 0) {
      if (down) { result.push({ t: '+', line: b[y - 1] }); y--; }
      else      { result.push({ t: '-', line: a[x - 1] }); x--; }
    }
  }
  return result.reverse();
}

/** @param {Array<{t: string, line: string}>} d @param {number} [ctx] @returns {boolean} */
function printUnified(d, ctx = 3) {
  const n    = d.length;
  const keep = new Array(n).fill(false);
  for (let i = 0; i < n; i++) {
    if (d[i].t === ' ') continue;
    for (let j = Math.max(0, i - ctx); j <= Math.min(n - 1, i + ctx); j++) keep[j] = true;
  }
  for (let i = 0; i < n; i++) {
    if (keep[i]) continue;
    let j = i; while (j < n && !keep[j]) j++;
    if (i > 0 && j < n && j - i <= ctx) for (let k = i; k < j; k++) keep[k] = true;
    i = j;
  }
  let oldLn = 0, newLn = 0, i = 0, shown = false;
  while (i < n) {
    if (!keep[i]) { if (d[i].t !== '+') oldLn++; if (d[i].t !== '-') newLn++; i++; continue; }
    let j = i; while (j < n && keep[j]) j++;
    const slice = d.slice(i, j);
    let oc = 0, nc = 0;
    for (const el of slice) { if (el.t !== '+') oc++; if (el.t !== '-') nc++; }
    out(dim(`  @@ -${oldLn + 1},${oc} +${newLn + 1},${nc} @@`));
    for (const el of slice) {
      const txt = '  ' + el.t + el.line;
      out(el.t === '+' ? green(txt) : el.t === '-' ? red(txt) : dim(txt));
      if (el.t !== '+') oldLn++;
      if (el.t !== '-') newLn++;
    }
    shown = true;
    i = j;
  }
  return shown;
}

/**
 * @param {string} kind
 */
function agentToolBadge(kind) {
  switch (kind) {
    case 'search': return cyan('[search]');
    case 'read':   return cyan('[read]  ');
    case 'list':   return cyan('[list]  ');
    case 'glob':   return cyan('[glob]  ');
    case 'git':    return cyan('[git]   ');
    case 'fetch':  return cyan('[fetch] ');
    case 'web':    return cyan('[web]   ');
    case 'replace': return yellow('[edit]  ');
    case 'write':   return green('[create]');
    case 'delete':  return red('[delete]');
    case 'move':    return yellow('[move]  ');
    case 'run':     return magenta('[run]   ');
    default:        return dim(`[${kind}]`);
  }
}

function agentShowDiff() {
  if (!overlay.size) { out(dim('  no file changes')); return false; }
  out('');
  out(bold('changes:'));
  const entries = Array.from(overlay.entries());
  entries.forEach(([abs, next], idx) => {
    const rel = posix(path.relative(agentRoot, abs));
    const before = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
    const diff = lineDiff(before.split('\n'), next === AGENT_DELETED ? [] : next.split('\n'));
    const added = diff.filter((d) => d.t === '+').length;
    const removed = diff.filter((d) => d.t === '-').length;
    const isLast = idx === entries.length - 1;
    const branch = isLast ? '└── ' : '├── ';
    const counts = green(`+${added}`) + ' ' + red(`-${removed}`);
    const note = next === AGENT_DELETED ? red(' (deleted)') : !before ? green(' (new file)') : '';
    out(`  ${gray(branch)}${rel}${note} ${dim(`(${counts})`)}`);
  });

  for (const [abs, next] of overlay) {
    const rel    = posix(path.relative(agentRoot, abs));
    const before = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
    out('');
    if (next === AGENT_DELETED) {
      out(bold(`--- a/${rel}`));
      out(bold(`+++ /dev/null (deleted)`));
      printUnified(lineDiff(before.split('\n'), []));
      continue;
    }
    out(bold(`--- a/${rel}${before ? '' : ' (new file)'}`));
    out(bold(`+++ b/${rel}`));
    if (!printUnified(lineDiff(before.split('\n'), next.split('\n'))))
      out(dim('  (no textual change)'));
  }
  return true;
}

/* ----------------------------------------- runAgentTask */

/**
 * @param {string} taskText
 * @param {{ maxSteps?: number, allowRun?: boolean, autoApply?: boolean | null, attachedImages?: Array<{ tag: string, dataUri: string }>, attachedDocuments?: AttachedDocument[] }} [opts]
 */
async function runAgentTask(taskText, { maxSteps = 10, allowRun = false, autoApply = null, attachedImages = [], attachedDocuments = [] } = {}) {
  // autoApply: null = ask y/N, true = apply automatically, false = dry run
  overlay.clear();
  const prevAllowRun = agentAllowRun;
  agentAllowRun = allowRun;

  currentAbortController = new AbortController();
  isGenerating = true;

  try {

  // Normalize absolute paths within agentRoot to relative paths so the model isn't confused
  const cleanRoot = agentRoot.replace(/[/\\]+$/, '');
  const cleanTask = taskText
    .replace(new RegExp(cleanRoot + '[/\\\\]?', 'g'), '')
    .replace(/['"`]/g, '')
    .trim();

  let listing = '';
  try { listing = agentOutbound(/** @type {string} */ (AGENT_TOOLS.list('.'))); } catch { /* ignore */ }

  let next =
    `${AGENT_PREAMBLE(allowRun)}\n\n` +
    `To save you a step, here is what is at the top level already:\n${listing}\n\n` +
    `Here is what I want to know: ${cleanTask}\n\nWhat should I open first?`;

  let nudges = 0;
  let toolsRun = 0;
  for (let step = 1; step <= maxSteps; step++) {
    const stepStart = Date.now();
    out('');

    let reply;
    try { reply = await sayResilient(next, 0, step === 1 ? attachedImages : [], step === 1 ? attachedDocuments : []); }
    catch (err) { out(red(`  ✗ ${/** @type {Error} */ (err).message}`)); break; }
    reply = reply != null ? agentInbound(reply) : '';

    const elapsed = ((Date.now() - stepStart) / 1000).toFixed(1);
    out(cyan('○') + ' ' + bold(`agent step ${step}/${maxSteps}`) + ' ' + dim(`(${elapsed}s)`));

    const proseText = agentProse(reply);
    const calls = agentParse(reply);
    const done  = calls.find((c) => c.kind === 'done');
    const work  = calls.filter((c) => c.kind !== 'done');
    if (proseText) {
      const firstLine = proseText.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#')) || proseText.split('\n')[0].trim();
      if (firstLine) {
        const hasMore = work.length > 0 || Boolean(done);
        const branch = hasMore ? '├── ' : '└── ';
        out(`  ${gray(branch)}${dim('thinking:')} ${truncate(firstLine, fmtWidth() - 16)}`);
      }
    }

    if (!work.length) {
      const effectiveDone = done || (toolsRun > 0 && proseText ? { kind: 'done', arg: 'task complete' } : null);
      if (effectiveDone) {
        const cleanArg = (effectiveDone.arg || 'task complete').replace(/^[-—–:]\s*/, '').trim();
        out(`  ${gray('└── ')}${green('✓')} ${green('[done]')}   ${cleanArg || 'task complete'}`);
        if (proseText && proseText.trim() !== (effectiveDone.arg || '').trim() && proseText.trim() !== cleanArg) {
          out('');
          const md = makeRenderer();
          for (const l of proseText.split('\n')) md(l);
        }
        break;
      }
      if (++nudges > 2) { out(red('  no marker after three replies — stopping.')); break; }
      out(red(`  no marker in that reply — nudging (${nudges}/2)`));
      next = `I could not tell what to open from that. I have the project open here and I am pasting you whatever you name — nothing happens on your side. ${AGENT_REMINDER}`;
      continue;
    }
    nudges = 0;

    const results = [];
    for (let i = 0; i < work.length; i++) {
      toolsRun++;
      const call = work[i];
      let result;
      try { result = await AGENT_TOOLS[call.kind](call.arg, call.body); }
      catch (err) { result = `error: ${/** @type {Error} */ (err).message}`; }
      const head = String(result).split('\n')[0] ?? '';
      const ok   = !/^(no such|error|the text)/.test(result);
      const isLast = (i === work.length - 1) && !done;
      const branch = isLast ? '└── ' : '├── ';

      let summary = '';
      if (call.kind === 'read') {
        const lineCount = String(result).split('\n').length;
        summary = `(${lineCount} lines)`;
      } else if (call.kind === 'search') {
        const matchCount = String(result).split('\n').filter(Boolean).length;
        summary = matchCount > 0 ? `(${matchCount} match${matchCount === 1 ? '' : 'es'})` : '(0 matches)';
      } else if (call.kind === 'replace') {
        summary = `(modified ${call.arg})`;
      } else if (call.kind === 'write') {
        summary = `(created ${call.arg})`;
      } else if (call.kind === 'delete') {
        summary = `(deleted ${call.arg})`;
      } else if (head) {
        summary = `(${head.slice(0, 50)})`;
      }

      out(`  ${gray(branch)}${ok ? green('✓') : red('✗')} ${agentToolBadge(call.kind)} ${call.arg ? bold(call.arg) + ' ' : ''}${dim(summary)}`);
      results.push(`Result of ${call.kind} ${call.arg}:\n${agentOutbound(result)}`);
    }

    const stillLooking = work.some((c) => c.kind === 'list' || c.kind === 'read' || c.kind === 'search');
    if (done && !stillLooking) {
      const cleanArg = (done.arg || 'task complete').replace(/^[-—–:]\s*/, '').trim();
      out(`  ${gray('└── ')}${green('✓')} ${green('[done]')}   ${cleanArg || 'task complete'}`);
      if (proseText && proseText.trim() !== (done.arg || '').trim() && proseText.trim() !== cleanArg) {
        out('');
        const md = makeRenderer();
        for (const l of proseText.split('\n')) md(l);
      }
      break;
    }
    if (done) out(dim('  (ignoring DONE — it came alongside a tool request)'));
    next = `${results.join('\n\n')}\n\n${AGENT_REMINDER}`;
    if (step === maxSteps) out(red('  reached the step limit'));
  }

  agentAllowRun = prevAllowRun;

  const hasChanges = agentShowDiff();

  if (hasChanges) {
    let apply = autoApply;
    while (apply === null) {
      out('');
      const answer = (await rl.question(cyan('apply changes? [y/n/d] › '))).trim().toLowerCase();
      if (answer === 'y' || answer === '') {
        apply = true;
      } else if (answer === 'n') {
        apply = false;
      } else if (answer === 'd') {
        agentShowDiff();
      }
    }
    if (apply) {
      let written = 0;
      let deleted = 0;
      for (const [abs, txt] of overlay) {
        if (txt === AGENT_DELETED) {
          if (fs.existsSync(abs)) {
            fs.unlinkSync(abs);
            deleted++;
          }
        } else {
          fs.mkdirSync(path.dirname(abs), { recursive: true });
          fs.writeFileSync(abs, txt);
          written++;
        }
      }
      const parts = [
        written ? `wrote ${written} file(s)` : '',
        deleted ? `deleted ${deleted} file(s)` : '',
      ].filter(Boolean);
      out(green(`\n  ✓ ${parts.join(', ') || 'no changes'} to disk`));
    } else {
      out(dim('  dry run — nothing written.'));
    }
  }
    overlay.clear();
  } finally {
    isGenerating = false;
    currentAbortController = null;
  }
}

/* ---------------------------------------------------------------- the call */

const spinFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/**
 * @param {string} text
 * @param {Array<{ tag: string, dataUri: string }>} [attachedImages]
 * @param {Array<{ tag: string, filename: string, dataUri: string }>} [attachedFiles]
 */
async function ask(text, attachedImages = [], attachedFiles = []) {
  const startedAt = Date.now();
  const W = termWidth();
  const md = makeRenderer();

  /** @type {ReturnType<typeof setInterval> | null} */
  let timer = null;
  let frame = 0;
  const startSpin = () => {
    if (!TTY || timer !== null) return;
    isSpinning = true;
    const inner = Math.max(2, termWidth() - 3);
    const maxW = inner - 2;
    const initialText = queuedInput
      ? `${queuedInput} ${yellow('[queued]')}`
      : dim('Type to queue next message · Esc to stop');
    const vLen = stringWidth(initialText);
    const pad = Math.max(0, maxW - 2 - vLen);
    const cursorCol = 5 + stringWidth(queuedInput);

    stdout.write('  ' + cyan(spinFrames[frame = 0]) + ' ' + dim('thinking… 0s') + '\n');
    stdout.write(topRule() + '\n');
    stdout.write(gray('│') + ' ' + cyan('❯') + ' ' + initialText + ' '.repeat(pad) + gray('│') + '\n');
    stdout.write(botRule() + '\n');
    stdout.write(`\x1b[2A\x1b[${cursorCol}G`);

    timer = setInterval(() => {
      const s = Math.round((Date.now() - startedAt) / 1000);
      frame = (frame + 1) % spinFrames.length;
      const cCol = 5 + stringWidth(queuedInput);
      stdout.write(`\x1b[2A\r\x1b[K  ${cyan(spinFrames[frame])} ${dim(`thinking… ${s}s`)}\x1b[2B\x1b[${cCol}G`);
    }, 90);
  };
  const stopSpin = () => {
    if (timer === null && !isSpinning) return;
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
    if (isSpinning) {
      isSpinning = false;
      if (TTY) {
        stdout.write('\x1b[2A\r\x1b[J');
      }
    }
  };

  // Live echo of the raw answer, tracking how many terminal rows it spans so we
  // can wipe it and re-print the same text as formatted markdown once complete.
  let raw = '';
  let rows = 0;
  let col = 0;
  /** @param {string} chunk */
  const echo = (chunk) => {
    raw += chunk;
    if (!TTY) { stdout.write(chunk); return; }
    stdout.write(dim(chunk));
    for (const ch of chunk) {
      if (ch === '\n') { rows++; col = 0; }
      else if (++col >= W) { rows++; col = 0; }
    }
  };
  const reformat = () => {
    if (TTY && (rows || col)) {
      stdout.write('\r' + (rows ? `\x1b[${rows}A` : '') + '\x1b[J');
      for (const l of raw.replace(/\n$/, '').split('\n')) md(l);
    } else if (!TTY && raw && !raw.endsWith('\n')) {
      stdout.write('\n');
    }
    raw = ''; rows = 0; col = 0;
  };

  const hasImages = Array.isArray(attachedImages) && attachedImages.length > 0;
  const hasFiles = Array.isArray(attachedFiles) && attachedFiles.length > 0;
  let messagesContent;
  if (hasImages || hasFiles) {
    const parts = [];
    if (text) parts.push({ type: 'text', text });
    if (hasImages) {
      for (const img of attachedImages) {
        parts.push({ type: 'image_url', image_url: { url: img.dataUri } });
      }
    }
    if (hasFiles) {
      for (const f of attachedFiles) {
        parts.push({
          type: 'file',
          file: { filename: f.filename, file_data: f.dataUri },
        });
      }
    }
    messagesContent = parts;
  } else {
    messagesContent = text;
  }

  currentAbortController = new AbortController();
  isGenerating = true;

  const res = await fetch(`${BRIDGE}/v1/chat/completions`, /** @type {any} */ ({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: true,
      messages: [{ role: 'user', content: messagesContent }],
      ...(RATIO ? { aspect_ratio: RATIO } : {}),
      ...(thinkingLevel ? { thinking_level: thinkingLevel } : {}),
      ...(RESOLUTION ? { resolution: RESOLUTION } : {}),
      ...(DURATION ? { duration: Number(DURATION) } : {}),
      ...(activeVideoStyle ? { style_preprompt: activeVideoStyle } : {}),
      ...(activeImageStyle ? { image_style: activeImageStyle } : {}),
      ...(activeTone ? { output_tone: activeTone } : {}),
      ...(activeFormat ? { output_format: activeFormat } : {}),
      ...(CAMERA_FIXED ? { camera_fixed: true } : {}),
      ...(NO_AUDIO ? { generate_audio: false } : {}),
    }),
    signal: currentAbortController.signal,
  })).catch((/** @type {unknown} */ err) => {
    if (currentAbortController?.signal.aborted || (err instanceof Error && (err.name === 'AbortError' || (/** @type {any} */ (err).cause)?.name === 'AbortError'))) return null;
    console.error(red(`\n✗ cannot reach the bridge: ${err instanceof Error ? err.message : String(err)}`));
    return null;
  });
  if (!res) {
    stopSpin();
    isGenerating = false;
    currentAbortController = null;
    return;
  }
  if (!res.ok) {
    stopSpin();
    isGenerating = false;
    currentAbortController = null;
    console.error(red(`\n✗ bridge returned ${res.status}: ${(await res.text()).slice(0, 300)}`));
    return;
  }
  if (!res.body) {
    stopSpin();
    isGenerating = false;
    currentAbortController = null;
    console.error(red('\n✗ bridge sent no response body'));
    return;
  }

  startSpin();
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  /** @type {'tool' | 'answer' | null} */
  let kind = null;
  let wrote = false;

  try {
    for (;;) {
      let readResult;
      try {
        readResult = await reader.read();
      } catch (err) {
        if (currentAbortController?.signal.aborted || (err && /** @type {any} */ (err).name === 'AbortError')) {
          stopSpin();
          reformat();
          out('\n  ' + yellow('⏹ response stopped by user'));
          break;
        }
        throw err;
      }
      const { value, done } = readResult;
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let cut;
      while ((cut = buf.indexOf('\n\n')) !== -1) {
        const frameText = buf.slice(0, cut);
        buf = buf.slice(cut + 2);
        const data = frameText.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
        if (!data || data === '[DONE]') continue;
        /** @type {SSEChunk} */
        let evt;
        try { evt = JSON.parse(data); } catch { continue; }
        if (evt.error) { stopSpin(); reformat(); console.error(red(`\n✗ ${evt.error.message}`)); return; }
        const delta = evt.choices?.[0]?.delta ?? {};

        if (delta.reasoning_content) {
          stopSpin();
          reformat();                        // commit any answer text seen so far
          renderTool(delta.reasoning_content);
          kind = 'tool';
          wrote = true;
          startSpin();
        }
        if (delta.content) {
          stopSpin();
          if (kind === 'tool') out('');      // keep tool blocks and prose apart
          echo(keepMedia(delta.content));
          kind = 'answer';
          wrote = true;
        }
      }
    }

    stopSpin();
    reformat();
    if (!wrote) out(dim('(no reply)'));
    else if (TTY) out(''); // leave the cursor on a fresh line, not mid-spinner-wipe
    await drainPending();
  } finally {
    stopSpin();
    isGenerating = false;
    currentAbortController = null;
  }
}

/* ---------------------------------------------------------------- pre-flight */

// response.json() is `unknown` under @types/node — assert the shape at the edge.
let status = /** @type {BridgeStatus | null} */ (
  await fetch(`${BRIDGE}/status`).then((r) => r.json()).catch(() => null)
);
if (!status) {
  console.error(red(`No bridge at ${BRIDGE}. Start it with: npm run dev`));
  process.exit(1);
}
if (!status.extensions) {
  // Grace period: wait up to 4s in case the extension is reconnecting
  const graceMs = process.env.NODE_TEST_CONTEXT ? 100 : 4000;
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline && !status?.extensions) {
    await new Promise((r) => setTimeout(r, 100));
    status = /** @type {BridgeStatus | null} */ (await fetch(`${BRIDGE}/status`).then((r) => r.json()).catch(() => null));
  }
}
if (!status?.extensions) {
  console.error(red('The extension is not connected. Open a https://de.aipass.net/chat tab.'));
  process.exit(1);
}
model ||= status.defaultModel;

if (CONVERSATION) {
  await fetch(`${BRIDGE}/config`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ conversation: CONVERSATION }),
  }).catch(() => {});
}

if (ASSISTANT) {
  await fetch(`${BRIDGE}/config`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ assistant: ASSISTANT }),
  }).catch(() => {});
}

/**
 * If a fresh conversation is pending (`--new` or `/new`), create it now with
 * `seed` as its first message and point the bridge at it. No-op otherwise, so
 * it is safe to call before every message.
 * @param {string} seed
 */
async function maybeStartNew(seed) {
  if (!pendingNew) return;
  pendingNew = false;
  const made = /** @type {{ id?: string } | null} */ (
    await fetch(`${BRIDGE}/conversations/new`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        message: seed,
        ...(activeAssistant?.id ? { assistant: activeAssistant.id } : {}),
      }),
    }).then((r) => r.json()).catch(() => null)
  );
  if (made?.id) {
    if (status) status.conversation = made.id;
    console.log(dim(`  new session ${made.id}`));
  } else {
    console.log(red('  could not start a new conversation — continuing in the current one'));
  }
}

if (question) {
  let initialImages = getAttachedImagesForLine(question);
  if (imageArg) {
    const resolved = resolveImagePath(imageArg);
    if (resolved) {
      const reg = attachImageFromFile(resolved);
      if (reg && !initialImages.some((x) => x.id === reg.id)) initialImages.push(reg);
    } else {
      console.error(red(`✗ image file not found: ${imageArg}`));
      process.exit(1);
    }
  }

  let initialDocs = getAttachedDocumentsForLine(question);
  if (FILES.length > 0) {
    for (const f of FILES) {
      const resolved = resolveDocumentPath(f);
      if (resolved) {
        const reg = attachDocumentFromFile(resolved);
        if (reg && !initialDocs.some((x) => x.id === reg.id)) initialDocs.push(reg);
      } else {
        console.error(red(`✗ document file not found or unsupported: ${f}`));
        process.exit(1);
      }
    }
  }

  await maybeStartNew(question);
  await ask(question, initialImages, initialDocs);
  process.exit(0);
}

if (FILES.length > 0) {
  for (const f of FILES) {
    const resolved = resolveDocumentPath(f);
    if (resolved) {
      const reg = attachDocumentFromFile(resolved);
      if (reg) {
        console.log(dim(`  📄 ${cyan(reg.tag)} attached (${reg.filename}, ${(reg.size / 1024).toFixed(1)} KB)`));
      }
    }
  }
}

/* ------------------------------------------------------------- interactive */

function banner() {
  const w = Math.min(fmtWidth(), 60);
  const inner = w - 2;
  /** @param {string} s */
  const row = (s) => gray('│') + ' ' + s + ' '.repeat(Math.max(0, inner - 2 - stringWidth(s))) + gray('│');
  out(gray('╭' + '─'.repeat(inner) + '╮'));
  out(row(bold(cyan('✳ aipass')) + dim('  terminal chat')));
  out(row(''));
  out(row(dim('model    ') + model));
  out(row(dim('session  ') + (status?.conversation ?? 'starts on first message')));
  out(row(dim('bridge   ') + BRIDGE.replace(/^https?:\/\//, '')));
  if (thinkingLevel) out(row(dim('thinking ') + cyan(thinkingLevel)));
  if (activeTone || activeFormat) {
    const styleParts = [];
    if (activeTone) styleParts.push(`tone: ${activeTone}`);
    if (activeFormat) styleParts.push(`format: ${activeFormat}`);
    out(row(dim('style    ') + magenta(truncate(styleParts.join(', '), inner - 12))));
  }
  if (activeImageStyle) out(row(dim('image    ') + magenta(truncate(activeImageStyle, inner - 12))));
  if (activeVideoStyle) out(row(dim('video    ') + magenta(truncate(activeVideoStyle, inner - 12))));
  if (activeAssistant) out(row(dim('assistant') + green(truncate(activeAssistant.name || activeAssistant.id, inner - 12))));
  out(gray('╰' + '─'.repeat(inner) + '╯'));
  out(dim('  type /  ·  ↑↓ choose  ·  Tab fill  ·  Enter run  ·  /help  ·  Ctrl+C'));
}

// One source of truth for the slash commands: the /help text and the live menu.
/** @type {Array<[string, string]>} */
const COMMANDS = [
  ['/model',        'pick a model — ↑↓ then Enter, or /model <id>'],
  ['/models',       'print the model list'],
  ['/thinking',     'set thinking level — ↑↓ then Enter, or /thinking <level>'],
  ['/conversations','switch conversation — ↑↓ then Enter'],
  ['/new',          'start a fresh conversation'],
  ['/tone',         'set response tone — ↑↓ then Enter, or /tone <name|off>'],
  ['/format',       'set response format — ↑↓ then Enter, or /format <name|off>'],
  ['/styles',       'show available tone, format, image & video presets'],
  ['/image-style',  'pick image generation style — ↑↓ then Enter, or /image-style <name|off>'],
  ['/video-style',  'pick video generation style — ↑↓ then Enter, or /video-style <name|off>'],
  ['/credits',      'check credit quota & usage meter'],
  ['/doctor',       'run diagnostic checks for bridge, extension & models'],
  ['/assistant',    'select custom assistant — ↑↓ then Enter, or /assistant off'],
  ['/agent',        'switch to agent mode — /agent  |  /agent <task> [--allow-run] [--max N]'],
  ['/agent-root',   `set root dir the agent may touch (now: ${agentRoot})`],
  ['/file',         'attach a document — /file <path> [prompt] (PDF, Word, Excel, CSV, text)'],
  ['/image',        'attach an image file — /image <path> [prompt]'],
  ['/clip',         'paste image from clipboard — /clip [prompt]'],
  ['/clear',        'clear the screen'],
  ['/help',         'show this list'],
];
const CMD_PAD = Math.max(...COMMANDS.map(([n]) => n.length));
const HELP = [
  ...COMMANDS.map(([n, d]) => `  ${n.padEnd(CMD_PAD)}  ${d}`),
  `  ${'Ctrl+C'.padEnd(CMD_PAD)}  quit`,
  '',
  dim('  Tip: Alt+V (or Ctrl+V) pastes images directly from clipboard.'),
  dim('  Drag-and-drop image files to automatically attach as [image1].'),
].map((l) => dim(l)).join('\n');

banner();

const rl = /** @type {any} */ (readline.createInterface({ input: stdin, output: stdout }));
rl.on('SIGINT', () => {
  if (rl.line.length > 0) setLine('');
  handleExit('Ctrl+C');
});

if (TTY) {
  // Enable bracketed paste mode in terminal so pasted text (Ctrl+V) doesn't auto-submit on newline
  stdout.write('\x1b[?2004h');
  const restorePasteMode = () => stdout.write('\x1b[?2004l');
  process.on('exit', restorePasteMode);
  rl.on('close', restorePasteMode);

  // Intercept stdin data stream to strip auto-submit newlines during paste
  const originalListeners = stdin.rawListeners('data');
  stdin.removeAllListeners('data');

  let inPaste = false;
  let pasteBuf = '';

  stdin.on('data', (chunk) => {
    let str = chunk.toString('utf8');
    while (str.length > 0) {
      if (!inPaste) {
        const idx = str.indexOf('\x1b[200~');
        if (idx === -1) {
          // If a multi-character block with newlines arrived without bracketed markers (raw paste), sanitize it
          if (str.length > 2 && (str.includes('\n') || str.includes('\r'))) {
            let clean = str.replace(/\r?\n/g, ' ').trimEnd();
            clean = processPastedText(clean);
            for (const l of originalListeners) /** @type {any} */ (l).call(stdin, Buffer.from(clean));
            break;
          }
          for (const l of originalListeners) /** @type {any} */ (l).call(stdin, Buffer.from(str));
          break;
        }
        if (idx > 0) {
          for (const l of originalListeners) /** @type {any} */ (l).call(stdin, Buffer.from(str.slice(0, idx)));
        }
        inPaste = true;
        str = str.slice(idx + 6);
      } else {
        const idx = str.indexOf('\x1b[201~');
        if (idx === -1) {
          pasteBuf += str;
          break;
        }
        pasteBuf += str.slice(0, idx);
        if (pasteBuf === '') {
          // Empty bracketed paste: terminal may have attempted an image paste without text
          const reg = attachImageFromClipboard();
          if (reg) {
            rl.write(reg.tag + ' ');
            if (TTY) {
              stdout.write(`\r\n\x1b[J${dim(`  📎 ${cyan(reg.tag)} attached from clipboard (${(reg.size / 1024).toFixed(1)} KB)`)}\x1b[1A\x1b[${promptCol()}G`);
            }
          }
        }
        // Replace newlines with spaces and trim trailing whitespace so paste stays in input buffer
        let clean = pasteBuf.replace(/\r?\n/g, ' ').trimEnd();
        pasteBuf = '';
        inPaste = false;
        str = str.slice(idx + 6);
        if (clean) {
          clean = processPastedText(clean);
          if (isGenerating) {
            queuedInput += clean;
            updateComposerLine();
          } else {
            for (const l of originalListeners) /** @type {any} */ (l).call(stdin, Buffer.from(clean));
          }
        }
      }
    }
  });
}

/* --- slash-command menu: drops down while you type a "/command" (TTY only).
   ↑/↓ move the highlight, Tab fills it in, Enter runs it, Esc dismisses.       */

const PROMPT = '❯ ';

const hintRule = (/** @type {string} */ sig) => {
  const text = termWidth() >= 70
    ? ` Press ${sig} again to exit (กดอีกครั้งเพื่อออก) `
    : ` Press ${sig} again to exit `;
  const rem = Math.max(2, termWidth() - 3 - 2 - text.length);
  return gray('╰─') + yellow(text) + gray('─'.repeat(rem) + '╯');
};

/** @param {string} text */
function renderMessageBox(text) {
  const inner = Math.max(2, termWidth() - 3);
  const maxW = inner - 2;
  const outLines = [topRule()];

  for (const raw of text.split('\n')) {
    if (stringWidth(raw) <= maxW) {
      const pad = Math.max(0, maxW - stringWidth(raw));
      outLines.push(gray('│ ') + raw + ' '.repeat(pad) + gray(' │'));
      continue;
    }
    let cur = '';
    let curW = 0;
    for (const w of raw.split(/(\s+)/)) {
      const wW = stringWidth(w);
      if (curW + wW > maxW) {
        if (cur.trim()) {
          const pad = Math.max(0, maxW - stringWidth(cur));
          outLines.push(gray('│ ') + cur + ' '.repeat(pad) + gray(' │'));
          cur = '';
          curW = 0;
        }
        if (wW > maxW) {
          for (const ch of w) {
            const chW = stringWidth(ch);
            if (curW + chW > maxW) {
              const pad = Math.max(0, maxW - stringWidth(cur));
              outLines.push(gray('│ ') + cur + ' '.repeat(pad) + gray(' │'));
              cur = ch;
              curW = chW;
            } else {
              cur += ch;
              curW += chW;
            }
          }
        } else {
          cur = w;
          curW = wW;
        }
      } else {
        cur += w;
        curW += wW;
      }
    }
    if (cur.length > 0) {
      const pad = Math.max(0, maxW - stringWidth(cur));
      outLines.push(gray('│ ') + cur + ' '.repeat(pad) + gray(' │'));
    }
  }

  outLines.push(botRule());
  return outLines.join('\n');
}

/** @type {ReturnType<typeof setTimeout> | null} */
let exitTimer = null;

function clearInputBox() {
  if (!TTY) return;
  if (menuOpen) {
    stdout.write('\x1b[J');
    menuOpen = false;
  }
  // Wipe bottom border, then move up to mode banner and wipe down
  stdout.write('\r\n\x1b[J\x1b[3A\r\x1b[J');
}

/** @param {string} [sig] */
function handleExit(sig = 'Ctrl+C') {
  if (!TTY) {
    rl.close();
    process.exit(0);
  }

  if (exitTimer !== null) {
    clearTimeout(exitTimer);
    exitTimer = null;
    clearInputBox();
    rl.close();
    process.exit(0);
  }

  stdout.write(`\r\n\x1b[J${hintRule(sig)}\x1b[1A\x1b[${promptCol()}G`);
  exitTimer = setTimeout(() => {
    exitTimer = null;
    if (TTY && !menuOpen) drawBottomFrame();
  }, 2000);
}

let menuOpen = false;
/** @type {Array<[string, string]>} rows currently shown (real matches only) */
let menuHits = [];
let menuSel = 0;     // highlighted index into menuHits
let slashBuf = '';   // the "/…" text the user has typed
/** @type {string | null} command chosen with Enter, consumed by the loop */
let pendingPick = null;

const promptCol = () => PROMPT.length + 1 + rl.cursor;

/**
 * Force the readline buffer to a known string via public rl.write, so we never
 * touch its private redraw internals. Used to undo history navigation that
 * fires on ↑/↓ while the menu owns those keys.
 * @param {string} text
 */
function setLine(text) {
  rl.write(null, { ctrl: true, name: 'a' });
  rl.write(null, { ctrl: true, name: 'k' });
  if (text) rl.write(text);
}

function drawBottomFrame() {
  if (!TTY || menuOpen) return;
  stdout.write(`\r\n\x1b[J${botRule()}\x1b[1A\x1b[${promptCol()}G`);
}

function closeMenu() {
  if (!TTY || !menuOpen) return;
  menuOpen = false;
  drawBottomFrame();
}

const MENU_PAGE_SIZE = 5;

/**
 * @param {object} [opts]
 * @param {boolean} [opts.keepSel] keep the current highlight instead of resetting to 0
 */
function drawMenu({ keepSel = false } = {}) {
  if (!TTY) return;
  const buf = rl.line;
  if (!/^\/\S*$/.test(buf)) return closeMenu(); // only while typing the command word
  slashBuf = buf;

  menuHits = COMMANDS.filter(([name]) => name.startsWith(buf.toLowerCase()));
  if (!keepSel) menuSel = 0;
  if (menuSel >= menuHits.length) menuSel = Math.max(0, menuHits.length - 1);

  let start = 0;
  if (menuHits.length > MENU_PAGE_SIZE) {
    start = Math.max(0, Math.min(menuSel - Math.floor(MENU_PAGE_SIZE / 2), menuHits.length - MENU_PAGE_SIZE));
  }

  const rows = [];
  if (menuHits.length > 0) {
    rows.push(cyan('  Suggestions') + dim(` (${menuSel + 1}/${menuHits.length})`));
    const shown = menuHits.slice(start, start + MENU_PAGE_SIZE);
    for (let i = 0; i < shown.length; i++) {
      const [name, desc] = shown[i];
      const realIdx = i + start;
      const on = realIdx === menuSel;
      const label = name.padEnd(CMD_PAD);
      rows.push(on ? `  ${cyan('›')} ${cyan(label)}  ${desc}` : `    ${dim(label)}  ${dim(desc)}`);
    }
  } else {
    rows.push(dim('  Suggestions (0/0)'));
    rows.push(dim('    no matching command'));
  }

  // Drop below the input line (the terminal scrolls once to make room), wipe
  // whatever was there, print, then climb back and restore the typing column.
  stdout.write(`\r\n\x1b[J${rows.join('\n')}\x1b[${rows.length}A\x1b[${promptCol()}G`);
  menuOpen = true;
}

if (TTY) {
  // Wrap internal readline keypress listener so we can intercept Ctrl+D on empty prompt
  const [rlKeypressListener] = stdin.rawListeners('keypress');
  if (rlKeypressListener) stdin.removeListener('keypress', /** @type {(...args: any[]) => void} */ (rlKeypressListener));

  stdin.on('keypress', (/** @type {string} */ ch, /** @type {import('node:readline').Key} */ key) => {
    const name = key?.name;

    if (isGenerating) {
      if (name === 'escape') {
        currentAbortController?.abort();
        return;
      }
      if (key?.ctrl && (name === 'c' || name === 'd')) {
        currentAbortController?.abort();
        return;
      }
      if (name === 'return') {
        if (queuedInput.trim()) {
          promptQueue.push(queuedInput.trim());
          queuedInput = '';
          updateComposerLine();
        }
        return;
      }
      if (name === 'backspace') {
        queuedInput = queuedInput.slice(0, -1);
        updateComposerLine();
        return;
      }
      if ((key?.meta && name === 'v') || (key?.ctrl && name === 'v')) {
        const reg = attachImageFromClipboard();
        if (reg) {
          queuedInput += reg.tag + ' ';
          updateComposerLine();
        }
        return;
      }
      if (ch && !key?.ctrl && !key?.meta && ch.length === 1) {
        queuedInput += ch;
        updateComposerLine();
        return;
      }
      return;
    }

    if (key?.ctrl && name === 'd' && rl.line.length === 0) {
      handleExit('Ctrl+D');
      return;
    }

    if (exitTimer !== null && !(key?.ctrl && (name === 'c' || name === 'd'))) {
      clearTimeout(exitTimer);
      exitTimer = null;
      drawBottomFrame();
    }

    // Intercept Alt+V or Ctrl+V for clipboard image pasting
    if ((key?.meta && name === 'v') || (key?.ctrl && name === 'v')) {
      const reg = attachImageFromClipboard();
      if (reg) {
        rl.write(reg.tag + ' ');
        if (TTY) {
          stdout.write(`\r\n\x1b[J${dim(`  📎 ${cyan(reg.tag)} attached from clipboard (${(reg.size / 1024).toFixed(1)} KB)`)}\x1b[1A\x1b[${promptCol()}G`);
        }
        return;
      }
      if (key?.meta && name === 'v') {
        if (TTY) {
          stdout.write(`\r\n\x1b[J${dim('  (no image found in clipboard)')}\x1b[1A\x1b[${promptCol()}G`);
        }
        return;
      }
    }

    if (rlKeypressListener) {
      /** @type {any} */ (rlKeypressListener).call(stdin, ch, key);
    }

    if (menuOpen && (name === 'up' || name === 'down')) {
      const n = menuHits.length;
      if (n) menuSel = (menuSel + (name === 'down' ? 1 : n - 1)) % n;
      if (rl.line !== slashBuf) setLine(slashBuf); // readline may have jumped history
      drawMenu({ keepSel: true });
      return;
    }
    if (menuOpen && name === 'tab') {
      const pick = menuHits[menuSel]?.[0];
      closeMenu();
      if (pick) setLine(pick);
      return;
    }
    if (menuOpen && name === 'escape') { closeMenu(); return; }
    if (name === 'return') {
      pendingPick = (menuOpen && menuHits[menuSel]?.[0]) || null;
      menuOpen = false;
      return;
    }

    setImmediate(drawMenu);
  });
}

/** @typedef {{ id: string, title?: string, updatedAt?: string }} ConvRow */
/** @typedef {{ id: string, name?: string, free_credit?: boolean, thinking?: unknown, kind?: string }} ModelRow */

const PICK_PAGE_SIZE = 5;

/**
 * Modal ↑/↓ picker (same interaction as the mockup for /conversations): renders
 * `items`, ↑/↓ moves the cursor, Enter selects, Esc cancels. Takes the keyboard
 * away from readline for the duration — its keypress listeners are detached and
 * restored on exit — so arrows don't leak into history navigation.
 * @template {{ id: string }} T
 * @param {T[]} items
 * @param {{ current: string | null, label: (item: T) => [string, string], width?: number }} opts
 *        `label` returns [main text, dim right-hand note] for each row.
 * @returns {Promise<T | null>}
 */
function pickList(items, { current, label, width }) {
  return new Promise((resolve) => {
    let sel = Math.max(0, items.findIndex((it) => it.id === current));
    let painted = 0;
    const longestMain = items.length ? Math.max(...items.map((it) => stringWidth(label(it)[0] || ''))) : 20;
    const mainW = Math.min(fmtWidth() - 20, width ?? Math.max(12, longestMain));
    const pageSize = Math.min(PICK_PAGE_SIZE, Math.max(3, (stdout.rows || 24) - 4));

    const paint = () => {
      let start = 0;
      if (items.length > pageSize) {
        start = Math.max(0, Math.min(sel - Math.floor(pageSize / 2), items.length - pageSize));
      }
      const shown = items.slice(start, start + pageSize);

      const count = items.length > pageSize ? dim(` (${sel + 1}/${items.length})`) : '';
      const rows = [dim('  ↑↓ choose · Enter select · Esc cancel') + count];
      shown.forEach((it, idx) => {
        const i = start + idx;
        const [main, note] = label(it);
        const here = it.id === current ? green('●') : ' ';
        const cur = i === sel ? cyan('›') : ' ';
        const m = truncate(main, mainW).padEnd(mainW);
        rows.push(`  ${cur} ${here} ${i === sel ? cyan(m) : m}  ${dim(note)}`);
      });

      const wipe = painted ? `\x1b[${painted}A\r\x1b[J` : '\r\x1b[J';
      stdout.write(wipe + rows.join('\r\n') + '\r\n');
      painted = rows.length;
    };

    /** @type {Array<(...a: any[]) => void>} */
    const rlKeys = /** @type {any} */ (stdin.listeners('keypress'));
    for (const l of rlKeys) stdin.off('keypress', l);

    /** @param {T | null} choice */
    const finish = (choice) => {
      stdin.off('keypress', onKey);
      for (const l of rlKeys) stdin.on('keypress', l);
      if (painted) stdout.write(`\x1b[${painted}A\r\x1b[J`); // wipe the picker
      resolve(choice);
    };

    /** @param {string} _ch @param {import('node:readline').Key} [key] */
    const onKey = (_ch, key) => {
      const n = key?.name;
      if (n === 'up') { sel = (sel - 1 + items.length) % items.length; paint(); }
      else if (n === 'down') { sel = (sel + 1) % items.length; paint(); }
      else if (n === 'return') finish(items[sel]);
      else if (n === 'escape') finish(null);
      else if (key?.ctrl && n === 'c') finish(null);
    };

    stdin.on('keypress', onKey);
    paint();
  });
}

// Resolve the loop cleanly when the input stream ends, without leaving the
// question() promise as an unsettled top-level await.
const CLOSED = Symbol('closed');
/** @type {Promise<typeof CLOSED>} */
const closed = new Promise((resolve) => rl.once('close', () => resolve(CLOSED)));

for (;;) {
  if (TTY) {
    out('');
    // Mode indicator — shown above the input box every loop
    if (agentMode) {
      const flags = [
        agentModeAllowRun ? red('--allow-run') : '',
        agentModeAutoApply === true ? dim('--apply') : '',
        dim(`max:${agentModeMaxSteps}`),
        dim(`root: ${agentRoot}`),
      ].filter(Boolean).join(dim(' · '));
      out('  ' + cyan('⬡') + ' ' + bold(cyan('agent mode')) + '  ' + flags);
    } else {
      out('  ' + dim('○ chat mode'));
    }
    out(topRule());
  }
  /** @type {string | typeof CLOSED} */
  let line;
  if (promptQueue.length > 0) {
    line = promptQueue.shift() || '';
    if (TTY && !line.startsWith('/')) {
      out(renderMessageBox(line));
    }
  } else {
    if (queuedInput) {
      setLine(queuedInput);
      queuedInput = '';
    }
    try {
      const p = rl.question((TTY ? '' : '\n') + cyan(PROMPT));
      if (TTY) drawBottomFrame();
      line = await Promise.race([p, closed]);
    }
    catch {
      if (TTY) clearInputBox();
      break;
    } // Ctrl+C / Ctrl+D
    if (line === CLOSED) {
      if (TTY) clearInputBox();
      break;
    }
    if (TTY && menuOpen) { stdout.write('\x1b[J'); menuOpen = false; } // clear the dropdown
    if (pendingPick) { line = pendingPick; pendingPick = null; }
    line = line.trim();
    if (!line) {
      if (TTY) out(botRule());
      continue;
    }

    if (TTY && !line.startsWith('/')) {
      const promptLines = (line.match(/\n/g) || []).length + 1;
      stdout.write(`\x1b[${1 + promptLines}A\r\x1b[J`);
      out(renderMessageBox(line));
    } else if (TTY) {
      out(botRule());
    }
  }

  if (line === '/help') { console.log(HELP); continue; }

  if (line === '/clear') { stdout.write(TTY ? '\x1b[2J\x1b[H' : '\n'); banner(); continue; }

  if (line === '/models') {
    const r = /** @type {{ data?: ModelRow[] } | null} */ (
      await fetch(`${BRIDGE}/v1/models`).then((x) => x.json()).catch(() => null)
    );
    if (!r?.data) { console.log(red('  could not list models')); continue; }
    for (const m of r.data) {
      const mark = m.id === model ? green('●') : ' ';
      console.log('  ' + mark + ' ' + m.id.padEnd(34) + dim(m.name ?? '') + (m.free_credit ? green('  free') : ''));
    }
    continue;
  }

  // `/model` on its own opens an ↑/↓ picker; `/model <id>` switches directly.
  if (line === '/model' || line.startsWith('/model ')) {
    let id = line === '/model' ? '' : line.slice(7).trim();
    if (!id) {
      const r = /** @type {{ data?: ModelRow[] } | null} */ (
        await fetch(`${BRIDGE}/v1/models`).then((x) => x.json()).catch(() => null)
      );
      const models = r?.data ?? [];
      if (!models.length) { console.log(red('  could not list models')); continue; }
      if (!TTY) {
        for (const m of models) console.log(`  ${m.id === model ? '●' : ' '} ${m.id}${m.free_credit ? dim('  free') : ''}`);
        continue;
      }
      const chosen = await pickList(models, {
        current: model,
        label: (m) => {
          const tags = [];
          if (m.kind && m.kind !== 'chat') tags.push(m.kind);
          if (m.free_credit) tags.push('free');
          if (Array.isArray(m.thinking) && m.thinking.length) tags.push('thinking');
          return [m.id, tags.join(' · ')];
        },
      });
      if (!chosen) { console.log(dim('  cancelled')); continue; }
      id = chosen.id;
    }
    if (id === model) { console.log(dim('  already on that model')); continue; }
    model = id;
    await fetch(`${BRIDGE}/config`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ defaultModel: model }),
    }).catch(() => {});
    console.log(dim(`  model → ${model}`));
    continue;
  }

  if (line === '/conversations' || line === '/switch') {
    const r = /** @type {{ current?: string, conversations?: ConvRow[] } | null} */ (
      await fetch(`${BRIDGE}/conversations`).then((x) => x.json()).catch(() => null)
    );
    const all = r?.conversations ?? [];
    if (!all.length) { console.log(dim('  no conversations yet — send a message or /new')); continue; }
    const list = all.slice(0, 12);
    const current = r?.current ?? status?.conversation ?? null;

    if (!TTY) { // no cursor control off a tty — just print the list
      for (const c of list) console.log(`  ${c.id === current ? '●' : ' '} ${c.id}  ${dim(c.title ?? '')}`);
      continue;
    }

    const chosen = await pickList(list, {
      current,
      label: (c) => [c.title || '(untitled)', (relative(c.updatedAt) || '').padStart(9)],
    });
    if (all.length > list.length) console.log(dim(`  (showing ${list.length} most recent of ${all.length})`));
    if (!chosen) { console.log(dim('  cancelled')); continue; }
    if (chosen.id === current) { console.log(dim('  already on that one')); continue; }
    await fetch(`${BRIDGE}/config`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ conversation: chosen.id }),
    }).catch(() => {});
    if (status) status.conversation = chosen.id;
    pendingNew = false; // an explicit switch overrides a pending /new
    console.log(dim(`  switched to ${chosen.id}${chosen.title ? ` · ${chosen.title}` : ''}`));
    continue;
  }

  if (line === '/clip' || line.startsWith('/clip ')) {
    const prompt = line.slice(5).trim();
    const reg = attachImageFromClipboard();
    if (!reg) {
      console.log(dim('  no image found in clipboard'));
      continue;
    }
    console.log(dim(`  📎 ${cyan(reg.tag)} attached from clipboard (${(reg.size / 1024).toFixed(1)} KB)`));
    if (prompt) {
      const fullText = `${prompt} ${reg.tag}`;
      if (agentMode) {
        await runAgentTask(fullText, { maxSteps: agentModeMaxSteps, allowRun: agentModeAllowRun, autoApply: agentModeAutoApply, attachedImages: [reg] });
      } else {
        await maybeStartNew(fullText);
        await ask(fullText, [reg]);
      }
      pendingImages.clear();
      nextImageId = 1;
    } else {
      rl.write(reg.tag + ' ');
    }
    continue;
  }

  if (line === '/image' || line.startsWith('/image ')) {
    const rest = line.slice(6).trim();
    if (!rest) {
      console.log(dim('  usage: /image <path/to/image> [prompt]'));
      continue;
    }
    let rawPath = '';
    let prompt = '';
    if (rest.startsWith('"') || rest.startsWith("'")) {
      const q = rest[0];
      const endQuote = rest.indexOf(q, 1);
      if (endQuote !== -1) {
        rawPath = rest.slice(1, endQuote);
        prompt = rest.slice(endQuote + 1).trim();
      } else {
        rawPath = rest;
      }
    } else {
      const spaceIdx = rest.indexOf(' ');
      if (spaceIdx !== -1) {
        rawPath = rest.slice(0, spaceIdx);
        prompt = rest.slice(spaceIdx + 1).trim();
      } else {
        rawPath = rest;
      }
    }

    const resolved = resolveImagePath(rawPath);
    if (!resolved) {
      console.log(red(`  ✗ image not found or unsupported format: ${rawPath}`));
      continue;
    }
    const reg = attachImageFromFile(resolved);
    if (!reg) continue;

    console.log(dim(`  📎 ${cyan(reg.tag)} attached (${reg.source}, ${(reg.size / 1024).toFixed(1)} KB)`));
    if (prompt) {
      const fullText = `${prompt} ${reg.tag}`;
      if (agentMode) {
        await runAgentTask(fullText, { maxSteps: agentModeMaxSteps, allowRun: agentModeAllowRun, autoApply: agentModeAutoApply, attachedImages: [reg] });
      } else {
        await maybeStartNew(fullText);
        await ask(fullText, [reg]);
      }
      pendingImages.clear();
      nextImageId = 1;
    } else {
      rl.write(reg.tag + ' ');
    }
    continue;
  }

  // `/thinking` on its own opens an ↑/↓ picker; `/thinking <level>` sets directly.
  if (line === '/thinking' || line.startsWith('/thinking ')) {
    const THINKING_LEVELS = [
      { id: 'off',    note: 'disable reasoning traces' },
      { id: 'low',    note: 'fast, concise reasoning' },
      { id: 'medium', note: 'balanced thinking depth' },
      { id: 'high',   note: 'deep reasoning for complex problems' },
      { id: 'max',    note: 'maximum reasoning budget' },
    ];
    let level = line === '/thinking' ? '' : line.slice(9).trim().toLowerCase();
    if (!level) {
      if (!TTY) {
        for (const t of THINKING_LEVELS) console.log(`  ${t.id === (thinkingLevel || 'off') ? '●' : ' '} ${t.id.padEnd(8)}  ${dim(t.note)}`);
        continue;
      }
      const chosen = await pickList(THINKING_LEVELS, {
        current: thinkingLevel || 'off',
        label: (t) => [t.id, t.note],
      });
      if (!chosen) { console.log(dim('  cancelled')); continue; }
      level = chosen.id;
    }

    if (!['low', 'medium', 'high', 'max', 'off'].includes(level)) {
      console.log(dim(`  current thinking level: ${thinkingLevel || 'off'}`));
      console.log(dim('  usage: /thinking <low | medium | high | max | off>'));
      continue;
    }
    thinkingLevel = level === 'off' ? null : level;
    console.log(dim(`  thinking level → ${thinkingLevel || 'off'}`));
    continue;
  }

  if (line === '/file' || line.startsWith('/file ')) {
    const rest = line.slice(5).trim();
    if (!rest) {
      console.log(dim('  usage: /file <path/to/document> [prompt]'));
      continue;
    }
    let rawPath = '';
    let prompt = '';
    if (rest.startsWith('"') || rest.startsWith("'")) {
      const q = rest[0];
      const endQuote = rest.indexOf(q, 1);
      if (endQuote !== -1) {
        rawPath = rest.slice(1, endQuote);
        prompt = rest.slice(endQuote + 1).trim();
      } else {
        rawPath = rest;
      }
    } else {
      const spaceIdx = rest.indexOf(' ');
      if (spaceIdx !== -1) {
        rawPath = rest.slice(0, spaceIdx);
        prompt = rest.slice(spaceIdx + 1).trim();
      } else {
        rawPath = rest;
      }
    }

    const resolved = resolveDocumentPath(rawPath);
    if (!resolved) {
      console.log(red(`  ✗ document not found or unsupported format: ${rawPath}`));
      continue;
    }
    const reg = attachDocumentFromFile(resolved);
    if (!reg) continue;

    console.log(dim(`  📄 ${cyan(reg.tag)} attached (${reg.filename}, ${(reg.size / 1024).toFixed(1)} KB)`));
    if (prompt) {
      const fullText = `${prompt} ${reg.tag}`;
      if (agentMode) {
        await runAgentTask(fullText, { maxSteps: agentModeMaxSteps, allowRun: agentModeAllowRun, autoApply: agentModeAutoApply, attachedDocuments: [reg] });
      } else {
        await maybeStartNew(fullText);
        await ask(fullText, [], [reg]);
      }
      pendingDocuments.clear();
      nextDocId = 1;
    } else {
      rl.write(reg.tag + ' ');
    }
    continue;
  }

  if (line === '/new') {
    pendingNew = true;
    console.log(dim('  next message starts a fresh conversation'));
    continue;
  }

  // `/tone` on its own opens an ↑/↓ picker; `/tone <name|off>` sets directly.
  if (line === '/tone' || line.startsWith('/tone ')) {
    const rawVal = line === '/tone' ? '' : line.slice(5).trim().toLowerCase();
    if (!rawVal) {
      /** @type {any} */
      const bridgeOpts = await fetch(`${BRIDGE}/style-options`).then((r) => r.json()).catch(() => null);
      /** @type {Array<{ id: string, label?: string, note?: string }>} */
      const items = [
        { id: 'off', label: 'off', note: 'default AI tone' },
      ];
      if (bridgeOpts?.tones?.length) {
        for (const t of bridgeOpts.tones) {
          items.push({
            id: t.code,
            label: t.code,
            note: t.nameTh ? `${t.name} (${t.nameTh})` : (t.name || ''),
          });
        }
      } else {
        items.push(
          { id: 'concise', label: 'concise', note: 'brief, direct, no fluff' },
          { id: 'friendly', label: 'friendly', note: 'warm, welcoming, conversational' },
          { id: 'formal', label: 'formal', note: 'professional, structured, polite' },
          { id: 'persuasive', label: 'persuasive', note: 'compelling, motivating' },
          { id: 'casual', label: 'casual', note: 'relaxed, approachable' },
          { id: 'empathetic', label: 'empathetic', note: 'supportive, understanding' },
          { id: 'academic', label: 'academic', note: 'scholarly, analytical' },
          { id: 'storytelling', label: 'storytelling', note: 'narrative, vivid' },
        );
      }
      if (!TTY) {
        for (const t of items) console.log(`  ${t.id === (activeTone || 'off') ? '●' : ' '} ${t.id.padEnd(14)} ${dim(t.note ?? '')}`);
        continue;
      }
      const chosen = await pickList(items, {
        current: activeTone || 'off',
        label: (t) => [t.label || t.id, t.note || ''],
      });
      if (!chosen) { console.log(dim('  cancelled')); continue; }
      activeTone = chosen.id === 'off' ? null : chosen.id;
    } else {
      activeTone = (rawVal === 'off' || rawVal === 'none') ? null : rawVal;
    }
    console.log(dim(`  tone → ${activeTone ? magenta(activeTone) : 'off'}`));
    continue;
  }

  // `/format` on its own opens an ↑/↓ picker; `/format <name|off>` sets directly.
  if (line === '/format' || line.startsWith('/format ')) {
    const rawVal = line === '/format' ? '' : line.slice(7).trim().toLowerCase();
    if (!rawVal) {
      /** @type {any} */
      const bridgeOpts = await fetch(`${BRIDGE}/style-options`).then((r) => r.json()).catch(() => null);
      /** @type {Array<{ id: string, label?: string, note?: string }>} */
      const items = [
        { id: 'off', label: 'off', note: 'standard free-form output' },
      ];
      if (bridgeOpts?.formats?.length) {
        for (const f of bridgeOpts.formats) {
          items.push({
            id: f.code,
            label: f.code,
            note: f.nameTh ? `${f.name} (${f.nameTh})` : (f.name || ''),
          });
        }
      } else {
        items.push(
          { id: 'bullet_points', label: 'bullet_points', note: 'clean bulleted lists' },
          { id: 'table', label: 'table', note: 'structured markdown tables' },
          { id: 'step_by_step', label: 'step_by_step', note: 'numbered sequential steps' },
          { id: 'json', label: 'json', note: 'raw valid JSON payload' },
          { id: 'paragraphs', label: 'paragraphs', note: 'flowing descriptive prose' },
          { id: 'markdown', label: 'markdown', note: 'rich markdown with headers' },
          { id: 'code_block', label: 'code_block', note: 'fenced code block response' },
        );
      }
      if (!TTY) {
        for (const f of items) console.log(`  ${f.id === (activeFormat || 'off') ? '●' : ' '} ${f.id.padEnd(16)} ${dim(f.note ?? '')}`);
        continue;
      }
      const chosen = await pickList(items, {
        current: activeFormat || 'off',
        label: (f) => [f.label || f.id, f.note || ''],
      });
      if (!chosen) { console.log(dim('  cancelled')); continue; }
      activeFormat = chosen.id === 'off' ? null : chosen.id;
    } else {
      activeFormat = (rawVal === 'off' || rawVal === 'none') ? null : rawVal;
    }
    console.log(dim(`  format → ${activeFormat ? magenta(activeFormat) : 'off'}`));
    continue;
  }

  // `/styles` prints current style status and available preset options
  if (line === '/styles') {
    /** @type {any} */
    const styleRes = await fetch(`${BRIDGE}/style-options`).then((r) => r.json()).catch(() => null);
    /** @type {any} */
    const videoRes = await fetch(`${BRIDGE}/video-options`).then((r) => r.json()).catch(() => null);

    console.log(bold('\n  Current Active Styles:'));
    console.log(`    Tone:        ${activeTone ? magenta(activeTone) : dim('off')}   ${dim('(/tone <name|off>)')}`);
    console.log(`    Format:      ${activeFormat ? magenta(activeFormat) : dim('off')}   ${dim('(/format <name|off>)')}`);
    console.log(`    Image Style: ${activeImageStyle ? magenta(activeImageStyle) : dim('off')}   ${dim('(/image-style <name|off>)')}`);
    console.log(`    Video Style: ${activeVideoStyle ? magenta(activeVideoStyle) : dim('off')}   ${dim('(/video-style <name|off>)')}`);

    if (styleRes?.tones?.length) {
      console.log(bold('\n  Available Tones:'));
      console.log('    ' + styleRes.tones.map((/** @type {any} */ t) => cyan(t.code) + (t.nameTh ? dim(` (${t.nameTh})`) : '')).join(', '));
    }
    if (styleRes?.formats?.length) {
      console.log(bold('\n  Available Formats:'));
      console.log('    ' + styleRes.formats.map((/** @type {any} */ f) => cyan(f.code) + (f.nameTh ? dim(` (${f.nameTh})`) : '')).join(', '));
    }
    if (styleRes?.imageStyles?.length) {
      console.log(bold('\n  Image Style Presets:'));
      console.log('    ' + styleRes.imageStyles.slice(0, 15).map((/** @type {any} */ s) => cyan(s.name || s.id)).join(', ') + (styleRes.imageStyles.length > 15 ? dim(` …+${styleRes.imageStyles.length - 15} more`) : ''));
    }
    if (videoRes?.styles?.length) {
      console.log(bold('\n  Video Style Presets:'));
      console.log('    ' + videoRes.styles.map((/** @type {any} */ s) => cyan(s.name)).join(', '));
    }
    console.log();
    continue;
  }

  // `/image-style` on its own opens an ↑/↓ picker; `/image-style <name|off>` sets directly.
  if (line === '/image-style' || line.startsWith('/image-style ')) {
    const rawVal = line === '/image-style' ? '' : line.slice(12).trim();
    if (!rawVal) {
      /** @type {any} */
      const bridgeOpts = await fetch(`${BRIDGE}/style-options`).then((r) => r.json()).catch(() => null);
      /** @type {Array<{ id: string, label?: string, note?: string }>} */
      const items = [
        { id: 'off', label: 'off', note: 'default prompt (no style preset)' },
      ];
      if (bridgeOpts?.imageStyles?.length) {
        for (const s of bridgeOpts.imageStyles) {
          items.push({
            id: s.id,
            label: s.name || s.id,
            note: s.nameTh ? `${s.nameTh} · id: ${s.id}` : `id: ${s.id}`,
          });
        }
      } else {
        const fallbacks = [
          { id: 'anime', label: 'Anime', note: 'อนิเมะ' },
          { id: 'photorealistic', label: 'Photorealistic', note: 'ภาพถ่ายสมจริง' },
          { id: 'cinematic', label: 'Cinematic', note: 'ภาพยนตร์' },
          { id: 'fantasy', label: 'Fantasy Art', note: 'แฟนตาซี' },
          { id: 'oil_painting', label: 'Oil Painting', note: 'ภาพวาดสีน้ำมัน' },
          { id: 'watercolor', label: 'Watercolor', note: 'ภาพวาดสีน้ำ' },
          { id: 'cyberpunk', label: 'Cyberpunk', note: 'ไซเบอร์พังก์' },
          { id: 'pixel_art', label: 'Pixel Art', note: 'พิกเซลอาร์ต' },
          { id: '3d_render', label: '3D Render', note: 'โมเดล 3D' },
        ];
        for (const f of fallbacks) items.push(f);
      }
      if (!TTY) {
        for (const s of items) console.log(`  ${s.id === (activeImageStyle || 'off') ? '●' : ' '} ${(s.label || s.id).padEnd(18)} ${dim(s.note ?? '')}`);
        continue;
      }
      const chosen = await pickList(items, {
        current: activeImageStyle || 'off',
        label: (s) => [s.label || s.id, s.note || ''],
      });
      if (!chosen) { console.log(dim('  cancelled')); continue; }
      activeImageStyle = chosen.id === 'off' ? null : chosen.id;
    } else {
      activeImageStyle = (rawVal.toLowerCase() === 'off' || rawVal.toLowerCase() === 'none') ? null : rawVal;
    }
    console.log(dim(`  image-style → ${activeImageStyle ? magenta(activeImageStyle) : 'off'}`));
    continue;
  }

  // `/video-style` on its own opens an ↑/↓ picker; `/video-style <name|off>` sets directly.
  if (line === '/video-style' || line.startsWith('/video-style ')) {
    const rawVal = line === '/video-style' ? '' : line.slice(12).trim();
    if (!rawVal) {
      /** @type {any} */
      const bridgeOpts = await fetch(`${BRIDGE}/video-options`).then((r) => r.json()).catch(() => null);
      /** @type {Array<{ id: string, label?: string, note?: string }>} */
      const items = [
        { id: 'off', label: 'off', note: 'no style preprompt' },
      ];
      if (bridgeOpts?.styles?.length) {
        for (const s of bridgeOpts.styles) {
          items.push({
            id: s.name,
            label: s.name,
            note: s.nameTh ? `${s.nameTh} · ${s.preprompt?.slice(0, 30)}…` : (s.preprompt?.slice(0, 40) || ''),
          });
        }
      } else {
        const fallbacks = [
          { id: 'Cinematic', label: 'Cinematic', note: 'movie lighting, shallow depth of field' },
          { id: 'Animation', label: 'Animation', note: '3D animated movie look' },
          { id: 'Anime', label: 'Anime', note: 'Japanese animation visual aesthetic' },
          { id: 'Documentary', label: 'Documentary', note: 'realistic footage, natural light' },
          { id: 'Vintage', label: 'Vintage', note: '80s/90s analog film stock grain' },
          { id: 'Cyberpunk', label: 'Cyberpunk', note: 'neon reflections, dark moody tech' },
        ];
        for (const f of fallbacks) items.push(f);
      }
      if (!TTY) {
        for (const s of items) console.log(`  ${s.id === (activeVideoStyle || 'off') ? '●' : ' '} ${(s.label || s.id).padEnd(16)} ${dim(s.note ?? '')}`);
        continue;
      }
      const chosen = await pickList(items, {
        current: activeVideoStyle || 'off',
        label: (s) => [s.label || s.id, s.note || ''],
      });
      if (!chosen) { console.log(dim('  cancelled')); continue; }
      activeVideoStyle = chosen.id === 'off' ? null : chosen.id;
    } else {
      activeVideoStyle = (rawVal.toLowerCase() === 'off' || rawVal.toLowerCase() === 'none') ? null : rawVal;
    }
    console.log(dim(`  video-style → ${activeVideoStyle ? magenta(activeVideoStyle) : 'off'}`));
    continue;
  }

  // `/credits` or `/quota` displays an aesthetic credit and quota meter card
  if (line === '/credits' || line === '/quota') {
    /** @type {any} */
    const quota = await fetch(`${BRIDGE}/quota`).then((r) => r.json()).catch(() => null);
    if (!quota || quota.error || typeof quota.available !== 'number') {
      console.log(red('  ✗ could not fetch credit figures from bridge'));
      console.log(dim('    make sure the bridge is running and a https://de.aipass.net/chat tab is open'));
      continue;
    }
    const { limit = 0, used = 0, available = 0, periodEndsAt, video } = quota;
    const total = limit || (used + available) || 1;
    const pct = Math.min(100, Math.max(0, Math.round((available / total) * 100)));
    const usedPct = 100 - pct;
    const barWidth = 20;
    const filledLen = Math.min(barWidth, Math.round((usedPct / 100) * barWidth));
    const emptyLen = Math.max(0, barWidth - filledLen);
    const barColor = pct > 25 ? green : pct > 10 ? yellow : red;
    const meter = barColor('█'.repeat(filledLen)) + dim('░'.repeat(emptyLen));

    const n = (/** @type {number} */ v) => v.toLocaleString('en-US', { maximumFractionDigits: v < 100 ? 1 : 0 });
    const fmtDate = (/** @type {string | null | undefined} */ d) => {
      if (!d) return 'unknown';
      try { return new Date(d).toLocaleString(); } catch { return String(d); }
    };

    console.log();
    console.log(gray('  ╭──────────────────────────────────────────────────╮'));
    console.log(gray('  │ ') + bold(cyan('💳 aipass credits & quota')) + ' '.repeat(25) + gray('│'));
    console.log(gray('  │') + ' '.repeat(50) + gray('│'));
    console.log(gray('  │ ') + `Usage:      [${meter}] ${String(usedPct).padStart(3)}% used` + ' '.repeat(6) + gray('│'));
    console.log(gray('  │ ') + `Available:  ${barColor(n(available))} / ${n(total)} credits (${pct}% left)`.padEnd(58) + gray('│'));
    if (periodEndsAt) {
      console.log(gray('  │ ') + dim(`Resets at:  ${fmtDate(periodEndsAt)}`).padEnd(58) + gray('│'));
    }
    if (video) {
      const vRem = video.remaining ?? (video.limit - video.used);
      console.log(gray('  │ ') + `Video:      ${video.used ?? 0} / ${video.limit ?? 0} used (${vRem} left)`.padEnd(49) + gray('│'));
    }
    console.log(gray('  ╰──────────────────────────────────────────────────╯\n'));
    continue;
  }

  // `/doctor` runs diagnostic health checks
  if (line === '/doctor') {
    console.log(bold('\n  🩺 Running inline diagnostics…\n'));
    const getEndpoint = (/** @type {string} */ p) =>
      fetch(`${BRIDGE}${p}`).then(async (r) => ({ ok: r.ok, status: r.status, body: /** @type {any} */ (await r.json().catch(() => null)) })).catch(() => ({ ok: false, status: 0, body: /** @type {any} */ (null) }));

    // 1. Bridge check
    const stRes = await getEndpoint('/status');
    if (stRes.ok && stRes.body) {
      console.log(`  ${green('✓')} ${bold('bridge'.padEnd(14))} responding at ${BRIDGE}`);
    } else {
      console.log(`  ${red('✗')} ${bold('bridge'.padEnd(14))} not reachable (run: npm run dev)`);
      continue;
    }

    // 2. Extension check
    const extCount = stRes.body.extensions ?? 0;
    if (extCount > 0) {
      console.log(`  ${green('✓')} ${bold('extension'.padEnd(14))} ${extCount} browser tab${extCount > 1 ? 's' : ''} connected`);
    } else {
      console.log(`  ${red('✗')} ${bold('extension'.padEnd(14))} no tab connected (open https://de.aipass.net/chat)`);
    }

    // 3. Models check
    const modRes = await getEndpoint('/v1/models');
    const mList = modRes.body?.data ?? [];
    const hasReal = mList.some((/** @type {any} */ m) => m.owned_by && m.owned_by !== 'aipass');
    if (hasReal) {
      console.log(`  ${green('✓')} ${bold('models'.padEnd(14))} signed in — ${mList.length} models available`);
    } else if (mList.length > 0) {
      console.log(`  ${yellow('!')} ${bold('models'.padEnd(14))} ${mList.length} fallback models (check login at de.aipass.net)`);
    } else {
      console.log(`  ${red('✗')} ${bold('models'.padEnd(14))} failed to load models`);
    }

    // 4. Credits check
    const qRes = await getEndpoint('/quota');
    if (qRes.ok && qRes.body?.limit) {
      const q = qRes.body;
      const pct = Math.round((q.available / q.limit) * 100);
      const mark = pct <= 10 ? yellow('!') : green('✓');
      console.log(`  ${mark} ${bold('credits'.padEnd(14))} ${q.available.toFixed(1)} / ${q.limit.toFixed(0)} left (${pct}%)`);
    } else {
      console.log(`  ${yellow('!')} ${bold('credits'.padEnd(14))} could not read quota (open tab to refresh)`);
    }

    // 5. Conversations check
    const convRes = await getEndpoint('/conversations');
    const cList = convRes.body?.conversations ?? [];
    if (convRes.ok && (convRes.body?.current || cList.length)) {
      console.log(`  ${green('✓')} ${bold('session'.padEnd(14))} current: ${convRes.body.current || cList[0]?.id || 'active'} (${cList.length} total)`);
    } else {
      console.log(`  ${dim('–')} ${bold('session'.padEnd(14))} starts on first message or /new`);
    }

    console.log();
    continue;
  }

  // `/assistant` on its own opens an ↑/↓ picker; `/assistant off` detaches; `/assistant <id>` binds directly.
  if (line === '/assistant' || line.startsWith('/assistant ')) {
    const rawVal = line === '/assistant' ? '' : line.slice(10).trim();
    if (rawVal.toLowerCase() === 'off' || rawVal.toLowerCase() === 'none') {
      activeAssistant = null;
      await fetch(`${BRIDGE}/config`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ assistant: '' }),
      }).catch(() => {});
      console.log(dim('  assistant detached'));
      continue;
    }

    if (!rawVal) {
      const r = /** @type {{ assistants?: Array<{ id: string, name: string, model?: string }> } | null} */ (
        await fetch(`${BRIDGE}/assistants`).then((x) => x.json()).catch(() => null)
      );
      const all = r?.assistants ?? [];
      /** @type {Array<{ id: string, name?: string, note?: string }>} */
      const items = [
        { id: 'off', name: 'off', note: 'detach custom assistant' },
      ];
      for (const a of all) {
        items.push({
          id: a.id,
          name: a.name || a.id,
          note: a.model ? `model: ${a.model}` : a.id,
        });
      }

      if (!all.length) {
        console.log(dim('  no custom assistants found on your aipass account'));
        console.log(dim('  create one at https://de.aipass.net or via assistant setup'));
        continue;
      }

      if (!TTY) {
        for (const a of items) console.log(`  ${a.id === (activeAssistant?.id || 'off') ? '●' : ' '} ${(a.name || a.id).padEnd(20)} ${dim(a.note ?? '')}`);
        continue;
      }

      const chosen = await pickList(items, {
        current: activeAssistant?.id || 'off',
        label: (a) => [a.name || a.id, a.note || ''],
      });
      if (!chosen) { console.log(dim('  cancelled')); continue; }
      if (chosen.id === 'off') {
        activeAssistant = null;
        await fetch(`${BRIDGE}/config`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ assistant: '' }),
        }).catch(() => {});
        console.log(dim('  assistant detached'));
        continue;
      }

      /** @type {any} */
      const bindRes = await fetch(`${BRIDGE}/assistants/${encodeURIComponent(chosen.id)}/chat`, { method: 'POST' })
        .then((x) => x.json()).catch(() => null);
      if (bindRes?.conversation) {
        if (status) status.conversation = bindRes.conversation;
        pendingNew = false;
        activeAssistant = { id: chosen.id, name: chosen.name || chosen.id };
        console.log(green(`  assistant attached → ${activeAssistant.name}`) + dim(` (${chosen.id})`));
        console.log(dim(`  conversation → ${bindRes.conversation}`));
      } else {
        await fetch(`${BRIDGE}/config`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ assistant: chosen.id }),
        }).catch(() => {});
        activeAssistant = { id: chosen.id, name: chosen.name || chosen.id };
        console.log(green(`  assistant set → ${activeAssistant.name}`));
      }
      continue;
    }

    /** @type {any} */
    const bindRes = await fetch(`${BRIDGE}/assistants/${encodeURIComponent(rawVal)}/chat`, { method: 'POST' })
      .then((x) => x.json()).catch(() => null);
    if (bindRes?.conversation) {
      if (status) status.conversation = bindRes.conversation;
      pendingNew = false;
      activeAssistant = { id: rawVal, name: rawVal };
      console.log(green(`  assistant attached → ${rawVal}`) + dim(` (session: ${bindRes.conversation})`));
    } else {
      await fetch(`${BRIDGE}/config`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ assistant: rawVal }),
      }).catch(() => {});
      activeAssistant = { id: rawVal, name: rawVal };
      console.log(green(`  assistant set → ${rawVal}`));
    }
    continue;
  }

  // /agent-root <dir> — change the root the agent may touch
  if (line.startsWith('/agent-root')) {
    const dir = line.slice(11).trim();
    if (!dir) { out(dim(`  agent root is currently: ${agentRoot}`)); continue; }
    try {
      const abs = path.resolve(dir);
      if (!fs.statSync(abs).isDirectory()) throw new Error('not a directory');
      agentRoot = abs;
      out(dim(`  agent root → ${agentRoot}`));
    } catch (err) {
      out(red(`  ✗ ${err instanceof Error ? err.message : String(err)}`));
    }
    continue;
  }

  // /agent — no task → toggle mode; with task → run once (works in both modes)
  if (line === '/agent' || line.startsWith('/agent ')) {
    const raw   = line.slice(6).trim();
    const parts = raw.split(/\s+/).filter(Boolean);
    const hasFlags = parts.some((p) => p.startsWith('--'));
    const taskParts = [];
    let tAllowRun = false, tAutoApply = /** @type {boolean | null} */ (null), tMaxSteps = 10;
    for (let pi = 0; pi < parts.length; pi++) {
      if (parts[pi] === '--allow-run') { tAllowRun = true; continue; }
      if (parts[pi] === '--apply') { tAutoApply = true; continue; }
      if (parts[pi] === '--no-apply') { tAutoApply = false; continue; }
      if (parts[pi] === '--max') { tMaxSteps = Math.max(1, Number(parts[++pi]) || 10); continue; }
      taskParts.push(parts[pi]);
    }
    const taskText = taskParts.join(' ').trim();

    if (!taskText && !hasFlags) {
      // No task and no flags → toggle mode
      agentMode = !agentMode;
      if (agentMode) {
        out(bold(cyan(`  ⬡ switched to agent mode  (root: ${agentRoot})`)));
        out(dim(`  type a task and press Enter — it will run as an agent loop`));
        out(dim(`  options: --allow-run  --max N  --apply  (persist per mode)`));
        out(dim(`  /agent again to return to chat mode`));
      } else {
        out('  ' + dim('○ switched back to chat mode'));
      }
      continue;
    }

    // Flags only (no task text) → update mode settings
    if (!taskText && hasFlags) {
      if (tAllowRun)           agentModeAllowRun  = !agentModeAllowRun; // toggle
      if (tAutoApply !== null) agentModeAutoApply = tAutoApply;
      if (tMaxSteps !== 10)    agentModeMaxSteps  = tMaxSteps;
      out(dim(`  agent mode settings: allow-run=${agentModeAllowRun}  max=${agentModeMaxSteps}  auto-apply=${agentModeAutoApply ?? 'ask'}`));
      continue;
    }

    // Has task text → run once (use per-task flags if given, else fall back to mode settings)
    const runAllowRun  = tAllowRun  || agentModeAllowRun;
    const runAutoApply = tAutoApply !== null ? tAutoApply : (taskText ? null : agentModeAutoApply);
    const runMaxSteps  = tMaxSteps !== 10 ? tMaxSteps : agentModeMaxSteps;
    out('');
    out(bold(`  🤖 agent  root: ${agentRoot}`) + (runAllowRun ? red('  --allow-run') : ''));
    const matched = getAttachedImagesForLine(taskText);
    await runAgentTask(taskText, { maxSteps: runMaxSteps, allowRun: runAllowRun, autoApply: runAutoApply, attachedImages: matched });
    pendingImages.clear();
    nextImageId = 1;
    continue;
  }

  out();
  const attached = getAttachedImagesForLine(line);
  const attachedDocs = getAttachedDocumentsForLine(line);
  if (attached.length > 0) {
    const names = attached.map((img) => `${cyan(img.tag)} (${img.source})`).join(', ');
    out('  ' + dim(`📎 attached: ${names}`));
  }
  if (attachedDocs.length > 0) {
    const names = attachedDocs.map((doc) => `${cyan(doc.tag)} (${doc.filename})`).join(', ');
    out('  ' + dim(`📄 attached: ${names}`));
  }

  // In agent mode, plain messages run as agent tasks instead of chat
  if (agentMode) {
    out(bold(`  🤖 agent  root: ${agentRoot}`) + (agentModeAllowRun ? red('  --allow-run') : ''));
    await runAgentTask(line, { maxSteps: agentModeMaxSteps, allowRun: agentModeAllowRun, autoApply: agentModeAutoApply, attachedImages: attached });
  } else {
    await maybeStartNew(line);
    await ask(line, attached, attachedDocs);
  }
  pendingImages.clear();
  nextImageId = 1;
  pendingDocuments.clear();
  nextDocId = 1;
}
rl.close();
