// The browser that opens the AiPASS chat tab, and the bookkeeping that lets
// the test suite close it again.
//
// The chat tab is not just a page: the extension (a Chrome MV3 extension) is
// what answers the bridge from inside that tab, so the tab has to be in the
// browser the extension is loaded in — Chrome. The backend opens it; the
// suite closes it.
//
// Closing is only possible for a browser the run owns. Chrome started with a
// private `--user-data-dir` is an instance of its own: its own process tree,
// its own cookies, its own window. A tab in the developer's own Chrome
// cannot be closed from here without reaching into their session, so the
// suite never opens one — it opens a private profile and ends that tree.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { openCommandFor } from './open-command.mjs';

/** The private profile a run opens its browser in, or null. */
export const browserProfile = (env = process.env) => env.AIPASS_BROWSER_PROFILE?.trim() || null;

/** The file the opened browsers' pids are written to, or null. */
export const browserPidFile = (env = process.env) => env.AIPASS_BROWSER_PIDFILE?.trim() || null;

/**
 * Is this a URL the opener may hand to a shell?
 *
 * The allowlist is the shell metacharacters, because the Windows fallback
 * (`cmd /c start`) hands the URL to cmd.exe, which parses its own command
 * line: `&` `|` `^` `;` split the command and `%VAR%` expands an environment
 * variable into it. argv alone does not save the URL there — cmd.exe re-parses
 * whatever it is given, and a URL with a query string is an ordinary thing to
 * have an `&` in.
 *
 * @param {string} url @returns {boolean} */
export const isOpenableUrl = (url) => {
  const target = String(url ?? '').trim();
  return /^https?:\/\/[^\s"'<>\\^|&;`$%]+$/i.test(target);
};

/**
 * Open a URL in the browser the run should use: Chrome when it is installed
 * (the extension is a Chrome extension), the platform default otherwise — and
 * never the default when the run asked for a private profile, because a
 * default browser has no profile to isolate and no tree to close.
 *
 * No shell, no interpolation: the URL is allowlisted, then passed as argv.
 * This method is reachable from loopback without auth, so a string-built
 * `cmd /c start "" "${url}"` would be RCE.
 */
export async function openBrowser(url, { env = process.env, platform = process.platform } = {}) {
  const target = String(url ?? '').trim();
  if (!isOpenableUrl(target)) return false;
  const profile = browserProfile(env);
  const command = openCommandFor(platform, target, { env, profile });
  if (!command) return false; // no browser to open it with — not a failure to report
  const [cmd, args] = command;
  try {
    const pid = await new Promise((resolve) => {
      let settled = false;
      const done = (value) => { if (!settled) { settled = true; resolve(value); } };
      // spawn, not execFile: execFile ignores `stdio` and keeps three pipes
      // open for the browser's whole life, so the process that opened it
      // could never exit. Here the browser's streams are dropped and the
      // handle is unreferenced — the window outlives the opener, which is
      // the point of a tab.
      const child = spawn(cmd, args, {
        stdio: 'ignore',
        windowsHide: true,
        // A POSIX group leader is what lets the close below reach the
        // browser's children; on Windows the tree is addressed by taskkill /T.
        detached: platform !== 'win32',
      });
      child.unref();
      // The pid is the answer, not the exit: Chrome hands the URL to a
      // running instance and exits at once, and that instance is still the
      // one this run has to close.
      child.on('spawn', () => done(child.pid ?? null));
      child.on('error', () => done(null));
    });
    if (pid === null) return false;
    await recordBrowser(pid, env);
    return true;
  } catch {
    return false;
  }
}

/**
 * Remember a browser this run opened, so the run that ends can close it.
 *
 * The pid goes to a file, not to memory: the browser is opened by the
 * process that runs the test, and closed by the one that ran it.
 */
export async function recordBrowser(pid, env = process.env) {
  const file = browserPidFile(env);
  if (!file || !Number.isInteger(pid) || pid <= 0) return;
  try {
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.appendFile(file, `${pid}\n`);
  } catch { /* a browser nobody can close is not worth failing a run over */ }
}

/**
 * Close every browser the run opened, and say which ones it closed.
 *
 * The tree is killed, not the process: Chrome's renderers and its zygote
 * are children of the process that was spawned, and the window lives in
 * them.
 */
export async function closeOpenedBrowsers({ env = process.env, platform = process.platform, kill = killPidTree } = {}) {
  const file = browserPidFile(env);
  if (!file) return [];
  let pids = [];
  try {
    pids = fs.readFileSync(file, 'utf8')
      .split(/\s+/)
      .map((n) => Number(n))
      .filter((n) => Number.isInteger(n) && n > 0);
  } catch {
    return []; // nothing was ever opened
  }
  const closed = [];
  for (const pid of pids) {
    if (await kill(pid, { platform })) closed.push(pid);
  }
  try { fs.rmSync(file, { force: true }); } catch { /* best effort */ }
  return closed;
}

/**
 * End a process tree by pid — the same tree the RUN kill uses
 * (`harness/tools.mjs`), addressed by pid.
 *
 * The answer is "is it gone", not "did the killer say so": taskkill walks
 * the tree through the parent links, and a browser whose parent has already
 * exited (the process that opened it is long gone by the time the run ends)
 * makes taskkill report a failure for a process it did kill. The window is
 * what matters, so the window is what is checked.
 */
export async function killPidTree(pid, { platform = process.platform } = {}) {
  if (platform === 'win32') {
    // Spawned, not run inline: the kill must not block the caller's event
    // loop. /T walks the tree while it is still linked.
    const said = await new Promise((resolve) => {
      let out = '';
      const tk = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      tk.stdout.on('data', (d) => { out += d.toString(); });
      tk.on('error', () => resolve(''));
      tk.on('close', () => resolve(out));
    });
    // taskkill names the process it ended, which is worth more than its
    // exit code.
    if (said.includes(`SUCCESS: The process with PID ${pid}`)) return true;
  } else {
    try { process.kill(-pid, 'SIGKILL'); } catch { /* the tree is already gone */ }
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
  return await gone(pid);
}

/** Is the process still there? Signal 0 asks without sending anything. */
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM'; // it is there, and it is not ours to signal
  }
};

/** Wait for a process to go: a killed browser needs a moment to leave. */
const gone = async (pid) => {
  for (let i = 0; i < 60; i++) {
    if (!alive(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return !alive(pid);
};

