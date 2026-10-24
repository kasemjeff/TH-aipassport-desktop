// The write side of git, and the safe wrapper around the binary.
//
// `GIT` in the tool table has always been read-only: the model could look at
// the repository but never change it, so a run never "finished the job" — it
// staged a diff and left the commit to the person. This module is the other
// half: a thin wrapper around the `git` binary that the tool and the
// window's own buttons both speak.
//
// Three rules shape it:
//
//   1. An ARGV ARRAY, never a shell string. The old read path built
//      `git <sub>` and handed it to a shell, which is a hole a subcommand
//      with a space in it walks straight through. Here every argument is one
//      element of an array, so there is no shell to interpret it.
//   2. A path argument is resolved and refused when it leaves the project —
//      LEXICALLY and PHYSICALLY, the same two boundaries every tool path
//      goes through (overlay.mjs#safe): a junction inside the project that
//      points elsewhere is a way out of the root.
//   3. The commit message is never a flag and never a shell word: it goes as
//      ONE argv element, `--message=<text>`, so the model cannot smuggle
//      `-a` or a second command through it.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { realPath } from './overlay.mjs';

/** How long a git call may take before it is killed. */
const GIT_TIMEOUT = 30_000;

/**
 * Run git with an argv array.
 *
 * Async, never `execSync`: this runs in the backend's process, and a blocked
 * event loop there freezes every window call for the length of the command
 * (rule 9). `windowsHide` on every spawn (rule 10), and a timeout so a git
 * that asks for a password cannot hold the run open for ever.
 *
 * @param {string} root the project root — the cwd of the command
 * @param {string[]} args the argv, one element per argument
 * @returns {Promise<{stdout: string, stderr: string}>}
 */
function git(root, args, { timeoutMs = GIT_TIMEOUT } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn('git', args, { cwd: root, windowsHide: true });
    } catch (err) {
      reject(Object.assign(new Error(`git could not be started: ${err.message}`), { code: null, stdout: '', stderr: '' }));
      return;
    }
    let stdout = '';
    let stderr = '';
    let done = false;
    const finish = (fn, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      fn(value);
    };
    child.stdout?.on('data', (d) => { stdout += d; });
    child.stderr?.on('data', (d) => { stderr += d; });
    child.on('error', (error) => {
      // ENOENT is the machine without git — worth saying in words, because
      // the raw error is a puzzle for the model and for the person.
      const message = error?.code === 'ENOENT'
        ? 'git is not available on this machine'
        : `git could not be started: ${error.message}`;
      finish(reject, Object.assign(new Error(message), { code: null, stdout, stderr }));
    });
    child.on('close', (status) => {
      if (status === 0) finish(resolve, { stdout, stderr });
      else finish(reject, Object.assign(new Error(`git ${args[0]} exited with ${status}`), {
        code: status, stdout, stderr,
      }));
    });
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      finish(reject, Object.assign(new Error(`git ${args[0]} timed out after ${timeoutMs} ms`), {
        code: null, stdout, stderr,
      }));
    }, timeoutMs);
    timer.unref?.();
  });
}

/**
 * Resolve a path argument, and refuse the ones that leave the project.
 *
 * Both boundaries, because one is not enough: the LEXICAL one (a prefix test
 * compares case, and Windows does not) and the PHYSICAL one — the real path
 * of the nearest existing ancestor, with the rest of the path put back on
 * top, which is the same answer the sandbox gives for a path that does not
 * exist yet.
 *
 * @param {string} root the project root
 * @param {string} p the path as the caller named it
 * @returns {string} the absolute path inside the project
 */
export function resolveInside(root, p) {
  const base = path.resolve(root);
  const abs = path.resolve(base, String(p ?? ''));
  const rel = path.relative(base, abs);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error(`outside the project: ${p} — git may only touch files inside the project root.`);
  }
  const realRoot = realPath(base) ?? base;
  const real = realPath(abs);
  if (real) {
    const realRel = path.relative(realRoot, real);
    if (realRel === '..' || realRel.startsWith(`..${path.sep}`) || path.isAbsolute(realRel)) {
      throw new Error(`outside the project: ${p} — that path leaves the project through a link.`);
    }
  }
  return abs;
}

// Global options that take a value in the NEXT word. They are skipped when
// looking for the subcommand, so `git --git-dir .git commit` is a commit and
// not a `--git-dir`. The `=` spelling is handled separately.
const GIT_GLOBAL_VALUE = new Set([
  '-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env',
  '--super-prefix', '--attr-source',
]);

/**
 * Split a git invocation into its subcommand and the words after it.
 *
 * One owner for the grammar: the permission engine's RUN classifier, the
 * red-test commit gate and the GIT tool all read this same parse. A raw
 * string (the GIT marker's argument) and an argv array (a RUN's words) are
 * both accepted; the leading `git` itself is not part of either.
 *
 * Every global option Git places before the subcommand is skipped, including
 * the ones that carry a value in the next word (`-C`, `-c`, `--git-dir`,
 * `--work-tree`) and the `--option=value` spelling. An attached short value
 * (`-Cdir`, `-cname=value`) is one word and skips nothing.
 *
 * @param {string|string[]} textOrWords
 * @returns {{sub: string, args: string[]}|null}
 */
export function parseGitCommand(textOrWords) {
  const words = Array.isArray(textOrWords)
    ? textOrWords.map((w) => String(w))
    : String(textOrWords ?? '').trim().split(/\s+/).filter(Boolean);
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (!word) continue;
    if (word === '--') continue; // end of options; the next word is the subcommand
    if (!word.startsWith('-')) return { sub: word.toLowerCase(), args: words.slice(i + 1) };
    const eq = word.indexOf('=');
    const name = eq < 0 ? word : word.slice(0, eq);
    // A short option with its value attached (`-Cdir`, `-cname=value`) is
    // self-contained. For the bare form, the next word is the value.
    if ((name === '-C' || name === '-c') && eq < 0 && word.length === 2) {
      i++;
      continue;
    }
    if (word.startsWith('--') && eq < 0 && GIT_GLOBAL_VALUE.has(name)) i++;
  }
  return null;
}

// The subcommands that only read. This is an ALLOWLIST: a subcommand that is
// not named here is a write, so a command added by a newer git — update-ref,
// filter-branch, worktree, config — cannot inherit "read" by being unknown.
export const GIT_READ_SUBCOMMANDS = new Set([
  'status', 'diff', 'log', 'show', 'blame', 'rev-parse', 'ls-files', 'grep',
  'ls-tree', 'cat-file', 'describe', 'shortlog', 'show-ref', 'for-each-ref',
  'merge-base', 'rev-list', 'name-rev', 'whatchanged', 'count-objects',
  'check-ignore', 'check-attr', 'check-ref-format', 'var', 'version', 'help',
]);

// `--output=<file>` and `-o <file>` turn a reading command into a writer.
const GIT_OUTPUT_FLAG = /^(?:--output(?:=|$)|-o$)/;

// The flags that keep `branch` and `tag` in their listing shape. A bare word
// is a name (create), and any flag not named here can rename or delete, so
// both are writes. The `=` spelling is compared by its flag word.
const GIT_LIST_FLAGS = new Set([
  '-a', '--all', '-r', '--remotes', '-l', '--list', '-v', '-vv', '--verbose',
  '--show-current', '--omit-empty', '--no-column', '--no-color', '--color',
  '--column', '--ignore-case', '-i', '--merged', '--no-merged', '--contains',
  '--no-contains', '--points-at', '--sort', '--format', '--abbrev', '-n',
  '--verify',
]);

const onlyListFlags = (words) => words.every((w) => {
  if (!w.startsWith('-')) return false;
  return GIT_LIST_FLAGS.has(w.split('=')[0]);
});

/**
 * Does this subcommand change anything?
 *
 * The read allowlist is the default answer; the few names whose reading and
 * writing forms share a word (`branch`, `tag`, `remote`, `stash`) are read
 * only in their listing shape. A false positive costs one question; a false
 * negative costs the repository.
 */
export function gitSubcommandWrites(sub, args = []) {
  const cmd = String(sub ?? '').toLowerCase();
  if (!cmd) return false;
  const words = Array.isArray(args) ? args.map(String) : [];
  if (words.some((a) => GIT_OUTPUT_FLAG.test(a))) return true;
  if (cmd === 'branch' || cmd === 'tag') {
    // `branch -a`, `tag -l` and their other listing flags read; a name or a
    // mutation flag writes.
    return words.length > 0 && !onlyListFlags(words);
  }
  if (cmd === 'remote') {
    if (!words.length) return false;
    if (words.every((a) => a === '-v' || a === '--verbose')) return false;
    // `remote show origin` and `remote get-url origin` only read.
    return !['show', 'get-url'].includes(words[0]);
  }
  if (cmd === 'stash') {
    const first = words.find((a) => !a.startsWith('-'));
    return first !== 'list' && first !== 'show';
  }
  return !GIT_READ_SUBCOMMANDS.has(cmd);
}

/**
 * What a GIT argument asks for.
 *
 * One owner for the grammar: the tool and the permission engine both read it,
 * so a write can never be a read for one of them and a write for the other.
 *
 * @returns {{op: string, kind: 'read'|'write', args: string[]}|null}
 */
export function parseGitArg(sub) {
  const parsed = parseGitCommand(sub);
  if (!parsed) return null;
  const { sub: cmd, args } = parsed;
  if (cmd === 'stage' || cmd === 'add') return { op: 'stage', kind: 'write', args };
  if (cmd === 'commit') return { op: 'commit', kind: 'write', args };
  // `branch` alone lists; a NAME creates one, and `-D` deletes one. The
  // writer names are shared with the RUN classifier (gitSubcommandWrites),
  // so `branch -D main` cannot be a read for one and a write for the other.
  if (cmd === 'branch') {
    return { op: 'branch', kind: gitSubcommandWrites(cmd, args) ? 'write' : 'read', args };
  }
  return { op: cmd, kind: gitSubcommandWrites(cmd, args) ? 'write' : 'read', args };
}

/** The working tree's state: what is staged, what is not, and the branch. */
export async function status({ root }) {
  const { stdout } = await git(root, ['status', '--porcelain=v1', '--branch']);
  const lines = stdout.split('\n').filter((l) => l.length);
  const branchLine = lines.find((l) => l.startsWith('##'));
  const entries = lines.filter((l) => !l.startsWith('##')).map((l) => ({
    x: l[0] ?? ' ', y: l[1] ?? ' ', path: l.slice(3),
  }));
  // `## main...origin/main [ahead 1]` — the name is the part before the
  // upstream, and a detached HEAD has no branch at all.
  const named = branchLine ? branchLine.slice(3).split('...')[0].trim() : null;
  return {
    branch: named && !named.startsWith('HEAD') ? named : null,
    entries,
    staged: entries.filter((e) => e.x !== ' ' && e.x !== '?').map((e) => e.path),
    unstaged: entries.filter((e) => e.y !== ' ' && e.y !== '?').map((e) => e.path),
    untracked: entries.filter((e) => e.x === '?' && e.y === '?').map((e) => e.path),
    clean: entries.length === 0,
    output: stdout,
  };
}

/** The diff — of the working tree, or of what is staged. */
export async function diff({ root, cached = false } = {}) {
  const args = ['diff', '--no-color'];
  if (cached) args.push('--cached');
  const { stdout } = await git(root, args);
  return { output: stdout };
}

/** Stage the named paths. Nothing else is staged — the human names the files. */
export async function stage({ root, paths } = {}) {
  const named = (Array.isArray(paths) ? paths : [paths])
    .map((p) => String(p ?? '').trim())
    .filter(Boolean);
  if (!named.length) throw new Error('name the files to stage');
  const abs = named.map((p) => resolveInside(root, p));
  await git(root, ['add', '--', ...abs]);
  const after = await status({ root });
  return {
    staged: abs.map((a) => path.relative(root, a).split(path.sep).join('/')),
    entries: after.entries,
    output: after.output,
  };
}

/**
 * Commit what is staged.
 *
 * Two refusals, both facts rather than opinions: a commit needs a message,
 * and a commit with nothing staged is a commit of nothing — git would say so
 * itself, but the message would be an answer about git rather than about the
 * work.
 */
export async function commit({ root, message } = {}) {
  const text = String(message ?? '').trim();
  if (!text) throw new Error('a commit needs a message');
  const staged = await git(root, ['diff', '--cached', '--name-only']);
  if (!staged.stdout.trim()) throw new Error('nothing is staged — stage the files first');
  // The message is ONE argv element: `--message=<text>` can never be read as
  // a flag, and there is no shell to split it on spaces.
  const { stdout } = await git(root, ['commit', `--message=${text}`]);
  const head = await git(root, ['rev-parse', '--short', 'HEAD']);
  return {
    commit: head.stdout.trim(),
    message: text,
    files: staged.stdout.split('\n').filter(Boolean),
    output: stdout,
  };
}

/** Create a branch. It is not checked out: the window's tree stays as it is. */
export async function branch({ root, name } = {}) {
  const text = String(name ?? '').trim();
  if (!text) throw new Error('a branch needs a name');
  if (text.startsWith('-') || !/^[\w][\w./-]*$/.test(text)) {
    throw new Error(`not a usable branch name: ${text} — letters, digits, dash, dot and slash only`);
  }
  const { stdout } = await git(root, ['branch', text]);
  return { branch: text, output: stdout };
}

/** Every local branch. */
export async function branches({ root } = {}) {
  const { stdout } = await git(root, ['branch', '--list']);
  const names = stdout.split('\n').map((l) => l.replace(/^[*+]\s*/, '').replace(/\s+\(.*\)$/, '').trim()).filter(Boolean);
  return { branches: names, current: (await currentBranch({ root })).branch, output: stdout };
}

/** The branch the working tree is on. */
export async function currentBranch({ root } = {}) {
  const { stdout } = await git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return { branch: stdout.trim() };
}

/** The last commits, one line each. */
export async function log({ root, n = 10 } = {}) {
  const count = Math.min(Math.max(Number(n) || 10, 1), 100);
  const { stdout } = await git(root, ['log', '--oneline', `-${count}`]);
  return {
    entries: stdout.split('\n').filter(Boolean).map((line) => {
      const at = line.indexOf(' ');
      return { commit: line.slice(0, at), subject: line.slice(at + 1) };
    }),
    output: stdout,
  };
}

export default {
  status, diff, stage, commit, branch, branches, currentBranch, log,
  parseGitArg, parseGitCommand, gitSubcommandWrites, resolveInside,
};
