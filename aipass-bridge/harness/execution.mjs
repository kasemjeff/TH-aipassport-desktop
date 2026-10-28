// @ts-check
// The execution world: what tree a RUN or a VERIFY command sees, and how its
// answer reads as if it had run in the project.
//
// dsh keeps filesystem and subprocess behind one execution world, so pointing
// them at another backend moves everything at once (its capability-seams map).
// This is that seam at this harness's size. The tool layer (`tools.mjs`) owns
// the guards — the shell gate, the secret screen — and the text policy
// (`clipRun`, the spill); this module owns the world itself:
//
//   plain       nothing staged — the command runs in the project, as always
//   projection  anything staged — the staged tree is copied into a throwaway
//               directory OUTSIDE the project (`sandbox.mjs`) and the command
//               runs there; the disk itself is still never written by a run
//
// The world is picked per command, not per run: a reply can stage its first
// edit and RUN in the same step, and the step's later commands must see what
// the earlier ones staged. A second world — a shell inside a worktree (a
// worktree run's root already IS its world, so its RUNs project from there),
// or a remote sandbox — is another branch of `pickWorld`, not a second copy
// of the RUN tool.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createSandbox, materializeTree, removeSandbox, restorePaths, sandboxRoot, sharedDirs } from './sandbox.mjs';
import { scrubOutput } from './output-scrub.mjs';
import { scrubSecretDiff } from './permissions.mjs';

/**
 * Run one shell command to completion, and take the whole process tree down
 * when the timeout runs out. `exec`'s timeout kills the shell alone: on
 * Windows the command's own children — a server it started, a watcher —
 * survived the timeout and kept holding the files they had open, so a later
 * RUN met "EBUSY" from a process nobody could see. taskkill /T (or a POSIX
 * process-group signal) ends the tree instead.
 *
 * Rejects the way `exec` did — an Error carrying `code`, `signal`, `stdout`
 * and `stderr` — so callers keep formatting `err: exit …` the same way.
 *
 * @param {string} cmd   the shell line, run through the platform shell
 * @param {object} [opts]
 * @param {string} [opts.cwd]
 * @param {number} [opts.timeoutMs]
 * @param {number} [opts.maxBuffer]
 * @param {AbortSignal|null} [opts.signal]
 * @returns {Promise<{stdout: string, stderr: string}>}
 */
export function runShell(cmd, { cwd, timeoutMs, maxBuffer = 10 * 1024 * 1024, signal = null } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, {
      cwd,
      shell: true,
      windowsHide: true,
      // A POSIX group leader is what lets `kill(-pid)` below reach the
      // grandchildren; on Windows the tree is addressed by taskkill /T.
      detached: process.platform !== 'win32',
    });
    let stdout = '';
    let stderr = '';
    let done = false;
    const cap = (/** @type {string} */ s, /** @type {string|Buffer} */ d) => (s.length >= maxBuffer ? s : s + String(d));
    child.stdout?.on('data', (d) => { stdout = cap(stdout, d); });
    child.stderr?.on('data', (d) => { stderr = cap(stderr, d); });
    const finish = (/** @type {(v: any) => void} */ fn, /** @type {any} */ v) => {
      if (done) return;
      done = true;
      clearTimeout(t);
      // The listener is dropped with the child: a stop that lands after the
      // command is over must not go and kill a tree that is already gone.
      if (signal) signal.removeEventListener('abort', onAbort);
      fn(v);
    };
    const t = setTimeout(() => {
      killTree(child);
      finish(reject, Object.assign(new Error(`timed out after ${timeoutMs} ms`), {
        code: null, signal: 'SIGTERM', killed: true, stdout, stderr,
      }));
    }, timeoutMs);
    t.unref?.();
    // (stop) A stop kills the command, tree and all. The command used to run
    // to its own timeout (two minutes) after the person pressed stop: the
    // window said the run was stopping while the build kept going, holding
    // the files it needed and the next task waiting behind it.
    function onAbort() {
      killTree(child);
      finish(reject, Object.assign(new Error('the run was stopped'), {
        code: null, signal: 'SIGTERM', killed: true, stdout, stderr,
      }));
    }
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }
    child.on('error', (error) => finish(reject, Object.assign(error, { stdout, stderr })));
    child.on('close', (code, killedBy) => {
      if (code === 0 && !killedBy) finish(resolve, { stdout, stderr });
      else finish(reject, Object.assign(new Error(`exited with ${code ?? killedBy}`), { code, signal: killedBy, stdout, stderr }));
    });
  });
}

/** The tree, not the shell alone — see runShell for why.
 *
 * @param {import('node:child_process').ChildProcess} child
 */
function killTree(child) {
  // A pid the child never got (spawn can fail before one is handed out)
  // leaves nothing to address: the direct kill is all that can happen.
  if (!child.pid) { try { child.kill(); } catch { /* already gone */ } return; }
  if (process.platform === 'win32') {
    // Spawned, not run inline: the kill must not block the backend's event
    // loop. /T walks the tree while it is still linked, so the shell is left
    // standing here — killing it first orphans the children that taskkill
    // would otherwise have walked to (the first version did exactly that,
    // and the grandchild outlived its timeout).
    const tk = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    tk.on('error', () => { try { child.kill(); } catch { /* already gone */ } });
    tk.on('close', (code) => { if (code !== 0) { try { child.kill(); } catch { /* already gone */ } } });
    return;
  }
  try { process.kill(-child.pid, 'SIGKILL'); } catch { /* the tree is already gone */ }
  try { child.kill(); } catch { /* already gone */ }
}

/**
 * The world one command runs in: where its cwd is, how its output is mapped
 * back to the project, and what the honest limits of that world are.
 *
 * `projection` builds the staged copy through sandbox.mjs and maps the
 * sandbox's paths back to the project root; `plain` runs in the project with
 * nothing to map. A projection that cannot be built refuses the command
 * (`err: …`) rather than degrading to `plain`: with edits staged, the plain
 * world would hide them from the command and let its writes reach the real
 * project over staged work.
 *
 * @param {object} opts
 * @param {string} opts.root      the project root (or a worktree's root — the
 *   run's root is whichever folder the run works in)
 * @param {import('./overlay.mjs').Overlay} opts.overlay   the run's pending-edit filesystem
 * @param {AbortSignal|null} [opts.signal]
 * @returns {Promise<{kind: 'projection'|'plain', cwd: string, scrub: (text: string) => string, notes: () => string, dispose: () => void}>}
 */
async function pickWorld({ root, overlay, signal }) {
  if (!overlay?.size) {
    return { kind: 'plain', cwd: root, scrub: (text) => text, notes: () => '', dispose: () => {} };
  }
  let sandbox = null;
  const tooBig = /** @type {string[]} */ ([]);
  try {
    sandbox = createSandbox(root);
    await materializeTree(root, overlay, sandbox, { signal, onSkip: (rel, bytes) => tooBig.push(`${rel} (${Math.round(bytes / 1024 / 1024)} MB)`) });
  } catch (err) {
    if (sandbox) removeSandbox(sandbox);
    throw err;
  }
  return {
    kind: 'projection',
    cwd: sandbox,
    // The child's own paths are put back to the project's, so the output
    // reads as if it ran where the model thinks it did.
    scrub: (text) => restorePaths(text, sandbox, root),
    // The honest limit of the projection, said out loud: the heavy
    // directories are shared with the real project (a copy of node_modules
    // would cost a minute per RUN), so a write into one of them lands in the
    // user's project. And what the projection left out, said too: a command
    // that trips over a missing file deserves to know it was left out on
    // purpose.
    notes: () => {
      const shared = sharedDirs(root);
      const parts = [];
      if (shared.length) parts.push(`note: ${shared.join(', ')} — in this projection those are the REAL folders, not copies: a write there changes your project.`);
      if (tooBig.length) parts.push(`note: not copied into this projection (too large): ${tooBig.slice(0, 5).join(', ')}${tooBig.length > 5 ? `, and ${tooBig.length - 5} more` : ''}.`);
      return parts.length ? `\n\n${parts.join('\n\n')}` : '';
    },
    dispose: () => { if (sandbox) removeSandbox(sandbox); },
  };
}

/**
 * One command against the run's world — the whole of what RUN and VERIFY
 * execute through, guards aside. The `clip` hook is the tool layer's text
 * policy (head+tail clipping with a spill locator); the world owns
 * everything else: projection, output scrubbing, the shared/too-big notes,
 * and the two stop/exit endings that are not the command's own failure.
 *
 * @param {object} opts
 * @param {string} opts.root
 * @param {import('./overlay.mjs').Overlay} opts.overlay
 * @param {AbortSignal|null} [opts.signal]
 * @param {string} opts.command   the shell line to run
 * @param {number} [opts.timeoutMs]
 * @param {(text: string) => (string|Promise<string>)} [opts.clip]
 * @returns {Promise<string>} the command's result, `err: …` on failure
 */
export async function runInProjectWorld({ root, overlay, signal = null, command, timeoutMs = 120_000, clip = (text) => text }) {
  let world;
  try {
    world = await pickWorld({ root, overlay, signal });
  } catch (err) {
    const e = /** @type {any} */ (err);
    // A stop during the projection ends the run: the copy is the longest
    // wait a RUN has, and it used to finish while the window said the
    // run was stopping.
    if (e?.name === 'AbortError') return 'err: the run was stopped before the command could start';
    // A projection that cannot be built is the one failure the plain world
    // cannot absorb: with edits staged in the overlay, the plain world hides
    // them from the command — the stale-tree lie the projection exists to fix
    // — and a write would land on the real project over staged work. The
    // honest answer is a refusal the model can act on.
    const why = String(e?.message ?? e).replace(/\s+/g, ' ').trim().slice(0, 200);
    return `err: the projection could not be built (${why || 'unknown reason'}) — the command was not run, and nothing on disk changed. Retry once; if it fails again, tell the person to check disk space and permissions under ${sandboxRoot(root)}.`;
  }
  try {
    const { stdout } = await runShell(command, { cwd: world.cwd, timeoutMs, signal });
    return (await clip(scrubSecretDiff(world.scrub(scrubOutput(stdout))))) + world.notes();
  } catch (err) {
    const e = /** @type {any} */ (err);
    // A stop that killed the command says so: "exit SIGTERM" would read as
    // the command's own failure, and the person did ask for it.
    if (e?.killed && /stopped/i.test(String(e.message ?? ''))) {
      return clip(scrubSecretDiff(world.scrub('err: the run was stopped before the command finished')));
    }
    return clip(scrubSecretDiff(world.scrub(scrubOutput(`err: exit ${e.code ?? e.signal ?? '?'}\n${String(e.stdout ?? '')}${String(e.stderr ?? '')}`))));
  } finally {
    world.dispose();
  }
}

export default { runShell, runInProjectWorld, startBackgroundRun };

/** How much of a background command's output is kept on disk. */
export const BACKGROUND_OUTPUT_CAP = 20 * 1024 * 1024;

/**
 * Start one command as a job: same world as a RUN, output streamed to a file.
 *
 * A background command cannot borrow `runShell`: that one holds the output in
 * memory and kills the tree at a timeout, which is the opposite of what a
 * build or a dev server needs. This one streams complete lines through the
 * same screen a foreground RUN's output gets, to a spill file the `read` tool
 * can reach while the job is still running. The world (a projection when
 * anything is staged) lives until the job ends and is removed with it.
 *
 * The promise never rejects: the job's own end condition is the result.
 *
 * @param {object} opts
 * @param {string} opts.root
 * @param {import('./overlay.mjs').Overlay} opts.overlay
 * @param {AbortSignal|null} [opts.signal]
 * @param {string} opts.command
 * @param {string} opts.name   file name (without .txt) under `.aipass/spill`
 * @returns {Promise<{outputRel: string, done: Promise<{code: number|null, signal: string|null, stopped: boolean}>, stop: () => Promise<any>}|{error: string}>}
 */
export async function startBackgroundRun({ root, overlay, signal = null, command, name }) {
  let world;
  try {
    world = await pickWorld({ root, overlay, signal });
  } catch (err) {
    const e = /** @type {any} */ (err);
    if (e?.name === 'AbortError') return { error: 'the run was stopped before the command could start' };
    const why = String(e?.message ?? e).replace(/\s+/g, ' ').trim().slice(0, 200);
    return { error: `the projection could not be built (${why || 'unknown reason'}) — the command was not started` };
  }

  const rel = `.aipass/spill/${name}.txt`;
  const file = path.join(root, '.aipass', 'spill', `${name}.txt`);
  try {
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    // 'w': a stale file from an earlier job with the same id is not this one's
    // output, and appending would make JOBS point at a mixture of two runs.
    await fs.promises.writeFile(file, '');
  } catch (err) {
    world.dispose();
    const e = /** @type {any} */ (err);
    return { error: `the output file could not be created: ${String(e?.message ?? e).slice(0, 200)}` };
  }

  let child;
  try {
    child = spawn(command, {
      cwd: world.cwd,
      shell: true,
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
  } catch (err) {
    world.dispose();
    const e = /** @type {any} */ (err);
    return { error: `the command could not start: ${String(e?.message ?? e).slice(0, 200)}` };
  }

  let stopped = false;
  let settled = false;
  let written = 0;
  let clipped = false;
  let pending = '';
  const out = fs.createWriteStream(file, { flags: 'a' });
  const write = (/** @type {string} */ text) => {
    if (!text || settled) return;
    if (written >= BACKGROUND_OUTPUT_CAP) {
      if (!clipped) {
        clipped = true;
        out.write(`\n… output stopped at ${Math.round(BACKGROUND_OUTPUT_CAP / 1024 / 1024)} MB — the rest was dropped.\n`);
      }
      return;
    }
    written += text.length;
    out.write(text);
  };
  const feed = (/** @type {any} */ chunk) => {
    pending += String(chunk);
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) write(world.scrub(scrubSecretDiff(scrubOutput(line))) + '\n');
  };
  child.stdout?.on('data', feed);
  child.stderr?.on('data', feed);
  const finishJob = (/** @type {number|null} */ code, /** @type {string|null} */ sig) => /** @type {Promise<void>} */ (new Promise((resolve) => {
    if (settled) return resolve();
    if (pending) write(world.scrub(scrubSecretDiff(scrubOutput(pending))));
    pending = '';
    const notes = world.notes();
    if (notes) write(`\n${notes}\n`);
    if (signal) signal.removeEventListener('abort', onAbort);
    settled = true;
    // The stream is closed after every line is written, and the job is only
    // settled when the file is: a model that reads the locator the same
    // second must not find a half-written file.
    out.once('error', () => resolve());
    out.end(() => { world.dispose(); resolve(); });
  }));
  const onAbort = () => {
    stopped = true;
    killTree(child);
  };
  if (signal) {
    if (signal.aborted) { onAbort(); }
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  const done = new Promise((resolve) => {
    child.on('error', (err) => {
      write(`\nerr: the command could not start: ${String(err?.message ?? err)}\n`);
      void finishJob(null, null).then(() => resolve({ code: null, signal: null, stopped }));
    });
    child.on('close', (code, sig) => {
      void finishJob(code, sig ?? null).then(() => resolve({ code: stopped ? null : code, signal: sig ?? null, stopped }));
    });
  });

  return {
    outputRel: rel,
    done,
    stop: async () => {
      stopped = true;
      killTree(child);
      await done;
      return { stopped: true };
    },
  };
}
