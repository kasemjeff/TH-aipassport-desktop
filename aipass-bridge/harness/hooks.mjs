// hooks.mjs — the person's own commands, at the points that matter.
//
// The harness has rules, skills and plugins, but no place for "run this after
// every edit" or "run this before every commit". A hook is that place: a
// command line the PERSON configured, bound to a moment.
//
//   afterWrite   — after the run stages a change (a check on the content, not
//                  a rewrite of it: the staged bytes are still the run's)
//   beforeCommit — before a git commit goes through (the write side of git)
//   done         — when a run ends
//
// Wave 3.4 grew the list from three to nine. The six added moments are the
// ones people ask for first — stop a call before it runs, put a note in front
// of the session, carry something across a compaction:
//
//   sessionStart — once, before the first task of a session
//   promptSubmit — before every task the person sends
//   beforeTool   — before one tool call; a non-zero exit refuses that call,
//                  and no permission mode can override the person's command
//   afterTool    — after one tool call; what it prints rides the result
//   preCompact   — before the conversation is summarised and rotated
//   stop         — when a run ends without a DONE (cancelled, budget, stalled)
//
// Four rules shape every hook:
//
//   1. An ARGV ARRAY, never a shell string. The same rule the git wrapper
//      keeps (harness/git.mjs): a command line is split into a program and
//      its arguments, and no shell ever interprets it. A hook that wants two
//      commands is two ENTRIES in the list — the list is the chain.
//
//   2. The output is SCREENED (harness/output-scrub.mjs) before it becomes
//      part of a transcript, and a command that NAMES a secret file is not
//      run at all. The secret judgement is permissions.mjs's — the same table
//      the tools and the gate use — so a secret stays on this machine
//      whatever the person configured.
//
//   3. A hook that FAILS is reported, never fatal: the run continues and the
//      model is told what the hook said, because the person wants the
//      command's verdict and not silence. The one place a failure stops
//      something is the moment's own gate: a `beforeCommit` hook that fails
//      refuses the commit, which is what "before a commit" means.
//
//   4. A hook is the PERSON's command, not the model's, so it never asks the
//      model — or the person — for permission. The person configured it; the
//      run did not ask for it. It still runs inside the project (the project's
//      root is its cwd) and it still respects the secret floor.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { scrubOutput } from './output-scrub.mjs';
import { secretHit } from './permissions.mjs';
// The settings file owns the shape of a setting, and the moments are part of
// that shape: the list is read from there, not declared twice.
import { aipassHome, normalizeHooks, HOOK_MOMENTS } from './settings.mjs';

export { HOOK_MOMENTS };

/** How long one hook may run before it is killed. */
export const HOOK_TIMEOUT_MS = 30_000;

/** How much of a hook's output is kept. A hook that prints a megabyte must
 *  not turn the next message into a megabyte. */
const OUTPUT_CAP = 64 * 1024;

/** How much of it rides the result. A verdict is a line or two; a build log
 *  is not, and the middle of one is what nobody reads. */
const RESULT_CAP = 8_000;

/**
 * A hook's output, head and tail.
 *
 * The same shape the RUN tool keeps (harness/tools.mjs#clipRun): a failing
 * check's diagnosis is in its last lines and its first error is in the first
 * ones, so the middle is what goes. What was elided is counted, not hidden.
 *
 * @param {string} text
 * @param {number} [cap]
 * @returns {string}
 */
export function clipOutput(text, cap = RESULT_CAP) {
  const body = String(text ?? '');
  if (body.length <= cap) return body;
  const head = Math.max(1, Math.round(cap * 0.4));
  const tail = cap - head;
  const elided = body.length - cap;
  return `${body.slice(0, head)}\n… ${elided} more characters of the hook's output are not shown.\n${body.slice(-tail)}`;
}

/**
 * A command line as an argv array.
 *
 * The split is the shell's, minus the shell: whitespace separates the words
 * and a quoted run stays one word. There is no expansion, no glob and no
 * substitution — a command the person wrote is run as it was written. A
 * backslash is never an escape here: on Windows it is a path separator, and
 * `C:\Program Files\tool` has to keep its backslashes.
 *
 * @param {string} line
 * @returns {string[]}
 */
export function parseCommandLine(line) {
  const text = String(line ?? '').trim();
  if (!text) return [];
  const out = [];
  let cur = '';
  let quoted = null;
  let has = false;
  for (const ch of text) {
    if (quoted) {
      if (ch === quoted) { quoted = null; continue; }
      cur += ch;
      has = true;
      continue;
    }
    if (ch === '"' || ch === "'") { quoted = ch; has = true; continue; }
    if (/\s/.test(ch)) {
      if (has) { out.push(cur); cur = ''; has = false; }
      continue;
    }
    cur += ch;
    has = true;
  }
  if (has) out.push(cur);
  return out;
}

/**
 * The shell punctuation a command may not carry.
 *
 * A hook is ONE command: there is no shell to interpret `&&` or a redirect,
 * so a command carrying them would run the wrong thing and say so in a way
 * nobody could read. The settings hold a LIST, and the list is the chain —
 * two commands are two entries, each run on its own.
 *
 * The check is on the ARGV, not on the raw line: a URL with a `&` in it is
 * one argument, and a shell would not have split it either.
 */
const CHAIN_TOKENS = new Set(['&&', '||', ';', '|', '&', '>', '>>', '<', '`', '$(']);
const hasChain = (argv) => argv.some((a) => CHAIN_TOKENS.has(a) || /[><]/.test(a));

/**
 * The tree, not the shell alone.
 *
 * The same tree-kill the RUN tool keeps (harness/tools.mjs#killTree): a hook
 * that hangs must not leave the processes it started behind, and on Windows
 * the shell alone is not enough to reach them. Spawned, not run inline, so
 * the kill never blocks the backend's event loop (rule 9).
 */
function killTree(child) {
  if (process.platform === 'win32') {
    const tk = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    tk.on('error', () => { try { child.kill(); } catch { /* already gone */ } });
    tk.on('close', (code) => { if (code !== 0) { try { child.kill(); } catch { /* already gone */ } } });
    return;
  }
  try { process.kill(-child.pid, 'SIGKILL'); } catch { /* the tree is already gone */ }
  try { child.kill(); } catch { /* already gone */ }
}

/**
 * The hooks the settings file holds.
 *
 * The file is the truth and it is read when a hook fires, not when the
 * backend starts: a hook configured in the window has to work on the next
 * write, without a restart. The read is async (rule 9) and a file that is
 * not there is simply "no hooks".
 *
 * @param {string} [dir] the home the settings live in
 * @returns {Promise<{afterWrite: string[], beforeCommit: string[], done: string[]}>}
 */
export async function loadHooks(dir = aipassHome()) {
  try {
    const raw = await fs.promises.readFile(path.join(dir, 'settings.json'), 'utf8');
    const parsed = JSON.parse(raw);
    return normalizeHooks(parsed?.hooks);
  } catch {
    return normalizeHooks(null);
  }
}

/**
 * Run one hook command and report what it said.
 *
 * @param {string} command the command line the person configured
 * @param {{root: string, timeoutMs?: number, signal?: AbortSignal|null, env?: Record<string, string>|null}} opts
 * @returns {Promise<{ok: boolean, code: number|null, output: string, note: string, command: string}>}
 */
export async function runHook(command, { root, timeoutMs = HOOK_TIMEOUT_MS, signal = null, env = null } = {}) {
  const text = String(command ?? '').trim();
  const failed = (note) => ({ ok: false, code: null, output: '', note, command: text });
  if (!text) return { ok: true, code: null, output: '', note: '', command: text };

  // The secret floor, before anything runs: a command that names a secret
  // file is not run at all. The judgement is permissions.mjs's (the same
  // SECRET_RULES table the tools and the gate use), so a hook cannot be the
  // way a secret leaves this machine.
  const secret = secretHit(text);
  if (secret) {
    return failed(`was not run: it names ${secret.token} (${secret.pattern}) — secret files stay on this machine.`);
  }

  const argv = parseCommandLine(text);
  if (!argv.length) return failed('is not a command.');
  if (hasChain(argv)) {
    return failed('is more than one command. A hook is one command — put the second one in the list.');
  }

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), {
        cwd: root,
        windowsHide: true,
        shell: false,
        // The moment and the call ride the environment, so one script can be
        // configured for several moments and read what it is looking at. A
        // variable the caller did not set stays out rather than becoming the
        // string "undefined".
        env: env ? { ...process.env, ...env } : process.env,
        // A POSIX group leader is what lets the tree-kill reach the
        // grandchildren; on Windows the tree is addressed by taskkill /T.
        detached: process.platform !== 'win32',
      });
    } catch (err) {
      resolve(failed(`could not start: ${String(err?.message ?? err)}`));
      return;
    }
    let stdout = '';
    let stderr = '';
    let done = false;
    const cap = (s, d) => (s.length >= OUTPUT_CAP ? s : s + String(d));
    child.stdout?.on('data', (d) => { stdout = cap(stdout, d); });
    child.stderr?.on('data', (d) => { stderr = cap(stderr, d); });
    // The two streams together, in the order a terminal would show them:
    // what the command said, then what it complained about.
    const stdoutText = () => (stdout && stderr ? `${stdout}\n${stderr}` : (stdout || stderr));
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve(value);
    };
    const timer = setTimeout(() => {
      killTree(child);
      finish({
        ok: false,
        code: null,
        output: clipOutput(scrubOutput(stdoutText())),
        note: `timed out after ${Math.round(timeoutMs / 1000)}s and was killed.`,
        command: text,
      });
    }, timeoutMs);
    timer.unref?.();
    // A stop kills the hook too: the person pressed stop, and a command that
    // keeps running after that is a command nobody asked for any more.
    function onAbort() {
      killTree(child);
      finish({ ok: false, code: null, output: clipOutput(scrubOutput(stdoutText())), note: 'was stopped with the run.', command: text });
    }
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }
    child.on('error', (err) => {
      finish({
        ok: false,
        code: null,
        output: '',
        note: `could not start: ${err?.code === 'ENOENT' ? `${argv[0]} is not on this machine` : String(err?.message ?? err)}`,
        command: text,
      });
    });
    child.on('close', (code) => {
      finish({
        ok: code === 0,
        code,
        output: clipOutput(scrubOutput(stdoutText())),
        note: code === 0 ? '' : `failed (exit ${code ?? '?'})`,
        command: text,
      });
    });
  });
}

/**
 * The line a hook's verdict is written on.
 *
 * The verdict is what the person wanted: the command, and what it said. A
 * failure says so in words, and the output rides under it.
 */
function verdictLine(moment, result) {
  const head = `hook (${moment}) ${result.command}`;
  if (result.note) return `${head} ${result.note}`;
  return `${head}: exit ${result.code ?? 0}`;
}

/**
 * What a moment's hooks SAID, without the exit-0 verdict lines.
 *
 * A lifecycle hook that prints nothing has nothing to add, and a line saying
 * "exit 0" on every tool call would be noise in the transcript. A failure is
 * still named: "reported, not fatal" means the model reads it. The caller
 * decides where the text goes — the task, the tool result, the summary.
 *
 * @param {{moment: string, ran: Array<{ok: boolean, output: string, note: string, command: string}>}|null} result
 * @returns {string}
 */
export function hookSaid(result) {
  const lines = [];
  for (const r of result?.ran ?? []) {
    const said = String(r.output ?? '').trim();
    if (said) lines.push(said);
    else if (!r.ok) lines.push(verdictLine(result.moment, r));
  }
  return lines.join('\n');
}

/**
 * Run the hooks of one moment, in order, and report every verdict.
 *
 * The list is the chain: every command runs, so no verdict is hidden behind
 * an earlier failure. `ok` is false when any of them failed — that is the
 * gate a `beforeCommit` moment uses.
 *
 * @param {string} moment one of HOOK_MOMENTS
 * @param {{root: string, hooks?: object|null, timeoutMs?: number, signal?: AbortSignal|null, env?: Record<string, string>|null}} opts
 * @returns {Promise<{moment: string, ok: boolean, ran: Array<object>, text: string}>}
 */
export async function runHooks(moment, { root, hooks = null, timeoutMs = HOOK_TIMEOUT_MS, signal = null, env = null } = {}) {
  const conf = hooks ? normalizeHooks(hooks) : await loadHooks();
  const list = Array.isArray(conf?.[moment]) ? conf[moment] : [];
  if (!list.length) return { moment, ok: true, ran: [], text: '' };
  // Every hook knows which moment it is running for, without the settings file
  // repeating it in each command line.
  const fullEnv = { AIPASS_HOOK: moment, ...(env ?? {}) };
  const ran = [];
  for (const command of list) {
    ran.push(await runHook(command, { root, timeoutMs, signal, env: fullEnv }));
  }
  const lines = [];
  for (const result of ran) {
    lines.push(verdictLine(moment, result));
    const said = String(result.output ?? '').trim();
    if (said) lines.push(said);
  }
  return { moment, ok: ran.every((r) => r.ok), ran, text: lines.join('\n') };
}

export default { HOOK_MOMENTS, HOOK_TIMEOUT_MS, loadHooks, parseCommandLine, runHook, runHooks, hookSaid };
