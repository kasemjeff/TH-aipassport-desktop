// Which browser opens a URL, and the argv that does it — one rule, shared by
// the two surfaces that need it (the RPC's `browser.open` and the desktop
// launcher's `openWindow`) and pinned by the suite from any OS, because a
// Windows dev machine cannot run the darwin or linux branches.
//
// Chrome first, and that is not a preference: the AiPASS extension is a
// Chrome MV3 extension (`extension/background.js` speaks chrome.* APIs), so
// a chat tab opened in Edge carries no extension and the run stops with
// "no de.aipass.net tab is open". The platform default is only the fallback
// for a machine with no Chrome at all.
//
// argv, never a shell string: the URL is passed whole, so a `&` in it cannot
// split the command and no shell parses it. On Windows cmd's `start` needs
// its empty title spelled as a bare "" — without it the first quoted argument
// (`start`'s title slot) would swallow the URL and no window would open.
import fs from 'node:fs';
import path from 'node:path';

// The separators are spelled out, not taken from the host: this rule is
// pinned by the suite from every OS, and a path built with the host's
// separator would be a different string on each of them.
const winPath = (...parts) => parts.join('\\');
const isLinux = (platform) => platform !== 'win32' && platform !== 'darwin';

/**
 * Where Chrome lives, per platform, most likely first.
 *
 * A user install (LOCALAPPDATA) comes before the machine-wide one: that is
 * where Chrome puts itself when the person installs it without admin rights,
 * and a machine can have both.
 */
export function chromeCandidates(platform, env = process.env) {
  if (platform === 'win32') {
    return [env.LOCALAPPDATA, env.ProgramFiles, env['ProgramFiles(x86)']]
      .filter(Boolean)
      .map((base) => winPath(base, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  }
  if (platform === 'darwin') {
    return ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
  }
  // Linux keeps its names: the binary is on PATH, not in a fixed folder.
  return ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'];
}

/** The Chrome on this machine, or null. `exists` is injected so the rule is testable from any OS. */
export function chromeExecutable(platform, { env = process.env, exists = fs.existsSync } = {}) {
  for (const candidate of chromeCandidates(platform, env)) {
    if (isLinux(platform)) {
      if (onPath(candidate, env, exists)) return candidate;
      continue;
    }
    try {
      if (exists(candidate)) return candidate;
    } catch { /* an unreadable path is not a Chrome */ }
  }
  return null;
}

const onPath = (name, env, exists) => (env.PATH ?? '')
  .split(path.posix.delimiter)
  .filter(Boolean)
  .some((dir) => {
    try { return exists(path.posix.join(dir, name)); } catch { return false; }
  });

/**
 * The argv that opens `target`, or null when there is no browser to open it
 * with.
 *
 * `profile` names a private Chrome profile directory. The browser then runs
 * as an instance of its own — its own process tree, its own cookies — which
 * is what lets a test open a real Chrome and close it again afterwards
 * without touching the Chrome the developer is using. A profiled run never
 * falls back to the platform default: a default browser has no profile to
 * isolate and no tree to close.
 */
export function openCommandFor(platform, target, { env = process.env, exists = fs.existsSync, profile = null } = {}) {
  const chrome = chromeExecutable(platform, { env, exists });
  if (chrome) {
    // macOS opens through `open -a`, which cannot carry a private profile
    // (`--args` and the document argument do not mix), so a profiled run
    // execs the binary itself.
    if (platform === 'darwin' && !profile) return ['open', ['-a', 'Google Chrome', target]];
    const args = profile
      ? [target, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check']
      : [target];
    return [chrome, args];
  }
  if (profile) return null;
  if (platform === 'win32') return ['cmd', ['/c', 'start', '', target]];
  if (platform === 'darwin') return ['open', [target]];
  return ['xdg-open', [target]];
}
