// A run's own checkout: a second working tree of the person's repository.
//
// WHY it exists: two runs (or a run and the person) editing one repository
// fight over the same files. Devin says it plainly — "if two Cascades edit
// the same file at the same time, the edits can race … consider using
// worktrees". This harness has ONE project root per window, so a second task
// waits, or lands on top of the first.
//
// A worktree is git's answer: a second checkout of the same repository, on
// its own branch, in its own folder. The files the run writes are not the
// files the person is editing; the person merges the branch when they are
// happy, or throws the folder away when they are not.
//
// WHERE it lives: OUTSIDE the project, under `~/.aipass/run/worktrees/` — the
// same rule the sandbox projection follows (harness/sandbox.mjs#sandboxRoot):
// nothing this house makes lands inside the user's project, so a `git add -A`
// can never walk into it.
//
// HOW git is spoken to: an argv array, never a shell string; `windowsHide` on
// every spawn; a timeout on every call — the rules harness/git.mjs keeps. The
// base of the new worktree is a REF the person may name, so a ref that could
// be read as an option (`--orphan`, `-b`) is refused before git sees it.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { aipassHome } from './settings.mjs';
import { realPath } from './overlay.mjs';
import { status as gitStatus } from './git.mjs';

/** How long a git call may take before it is killed. */
const GIT_TIMEOUT = 30_000;

/**
 * Where the worktrees live.
 *
 * Under the home and NOT under the project, for the reason the sandbox
 * projection gives: a second checkout of the user's source inside their own
 * project is a copy a `git add -A` walks into. This folder is the sibling of
 * the projections and the checkpoints — everything this house makes, outside
 * every project.
 */
export function worktreeRoot() {
  return path.join(aipassHome(), 'run', 'worktrees');
}

/**
 * Run git with an argv array.
 *
 * The same shape as harness/git.mjs's runner, and for the same reasons: no
 * shell string (there is no shell to interpret a subcommand with a space in
 * it), `windowsHide` on every spawn (rule 10) and a timeout (a git that asks
 * for a password must not hold the backend open). Async, always: this runs in
 * the backend's process, and a blocked event loop there freezes every window
 * call (rule 9).
 *
 * @param {string} cwd the repository the command runs in
 * @param {string[]} args the argv, one element per argument
 * @returns {Promise<{stdout: string, stderr: string}>}
 */
function git(cwd, args, { timeoutMs = GIT_TIMEOUT } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn('git', args, { cwd, windowsHide: true });
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
      const message = error?.code === 'ENOENT'
        ? 'git is not available on this machine'
        : `git could not be started: ${error.message}`;
      finish(reject, Object.assign(new Error(message), { code: null, stdout, stderr }));
    });
    child.on('close', (status) => {
      if (status === 0) finish(resolve, { stdout, stderr });
      else {
        // git's own words are the answer: "not a git repository" and "already
        // checked out" say what a person can act on, and a wrapper that
        // replaced them with "git exited with 128" would not.
        const why = (stderr || stdout).trim().split('\n').filter(Boolean).slice(-1)[0] ?? '';
        finish(reject, Object.assign(new Error(`git ${args[0]} failed: ${why || `exited with ${status}`}`), {
          code: status, stdout, stderr,
        }));
      }
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
 * The folder a worktree of this name lives in.
 *
 * The person's own name, cleaned of what a path cannot hold: a Windows path
 * may not carry `< > : " / \ | ? *`, and a name may not end with a dot. Thai
 * is kept — the window is written in Thai first, and a person who names their
 * worktree in Thai should get a folder they can recognise.
 */
const folderName = (name) => {
  const cleaned = String(name ?? '')
    .replace(/[<>:"/\\|?*\x00-]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/[. ]+$/g, '')
    .slice(0, 60)
    .trim();
  if (!cleaned) throw new Error('a worktree needs a name');
  return cleaned;
};

/**
 * The branch the new worktree checks out.
 *
 * ASCII only, because a git ref cannot hold a space (git check-ref-format
 * refuses one) — so a Thai name gives a branch the person did not type, and
 * the window shows both. The prefix says who made it.
 */
const branchName = (name) => {
  const ascii = String(name ?? '')
    .replace(/[^A-Za-z0-9._/-]+/g, '-')
    .replace(/^[-/]+|[-/]+$/g, '')
    .slice(0, 40);
  return `aipass/${ascii || 'work'}`;
};

/** The base of the new worktree: a ref the person named, or the current HEAD. */
const baseRef = (base) => {
  const text = String(base ?? '').trim();
  if (!text) return 'HEAD';
  // A ref that starts with a dash is an OPTION to git (`--orphan` is a real
  // one), so it is refused before git can read it as one.
  if (text.startsWith('-')) throw new Error(`not a usable base: ${text}`);
  if (/\s/.test(text)) throw new Error(`not a usable base: ${text}`);
  return text;
};

/** A branch name that is not taken yet — two worktrees may share a name. */
async function freeBranch(root, wanted) {
  const taken = async (name) => (await git(root, ['branch', '--list', name])).stdout.trim();
  if (!await taken(wanted)) return wanted;
  for (let i = 2; i < 50; i++) {
    const next = `${wanted}-${i}`;
    if (!await taken(next)) return next;
  }
  return `${wanted}-${Date.now()}`;
}

/**
 * A path inside the folder it was given.
 *
 * Two boundaries, because one is not enough: the LEXICAL one (path.relative,
 * not a string prefix — Windows compares case, a prefix test does not) and
 * the PHYSICAL one (a junction inside the folder that points elsewhere is a
 * way out of it). This is the same two boundaries every tool path goes
 * through (overlay.mjs#safe, git.mjs#resolveInside).
 */
function resolveInside(dir, p) {
  const base = path.resolve(dir);
  const abs = path.resolve(base, String(p ?? ''));
  const within = (from, to) => {
    const rel = path.relative(from, to);
    return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel) && rel !== '';
  };
  const lexical = within(base, abs);
  const realBase = realPath(base) ?? base;
  const real = realPath(abs);
  const physical = real ? within(realBase, real) : null;
  // The lexical answer is the usual one. The physical one makes the long
  // spelling of a short name (and macOS's /private/var for /var) the same
  // folder; it also says no when a junction inside the folder leads out.
  if (physical === false) {
    throw new Error(`outside the worktree folder: ${p} — that path leaves it through a link`);
  }
  if (lexical || physical === true) return abs;
  throw new Error(`outside the worktree folder: ${p} — a worktree of this house lives in ${base}`);
}

/** Do two paths name the same place on disk? */
const samePath = (a, b) => {
  const one = path.resolve(a);
  const two = path.resolve(b);
  if (one === two) return true;
  return (realPath(one) ?? one) === (realPath(two) ?? two);
};

/**
 * The worktrees of a repository, as `git worktree list` reports them.
 *
 * The porcelain form, because the human-readable one truncates a long path
 * with "..." — and a worktree's path is the one thing the person needs.
 */
function parseWorktrees(text) {
  const out = [];
  let cur = null;
  const flush = () => { if (cur) { out.push(cur); cur = null; } };
  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) { flush(); continue; }
    const space = line.indexOf(' ');
    const key = space === -1 ? line : line.slice(0, space);
    const value = space === -1 ? '' : line.slice(space + 1);
    if (key === 'worktree') {
      flush();
      cur = { path: value, head: null, branch: null, detached: false, bare: false, locked: false, prunable: false };
      continue;
    }
    if (!cur) continue;
    if (key === 'HEAD') cur.head = value;
    else if (key === 'branch') cur.branch = value.replace(/^refs\/heads\//, '');
    else if (key === 'detached') cur.detached = true;
    else if (key === 'bare') cur.bare = true;
    else if (key === 'locked') cur.locked = true;
    else if (key === 'prunable') cur.prunable = true;
  }
  flush();
  return out;
}

/**
 * The worktrees of this project.
 *
 * Every worktree of the REPOSITORY is listed — the person's own checkouts
 * too — and the ones this house made are marked (`ours`), because those are
 * the ones it may sweep and the ones it may take away. The first entry is
 * the repository's main checkout: it is the project itself, not a worktree
 * of it, and it is never removed.
 *
 * @param {{root: string}} params the project
 */
export async function list({ root } = {}) {
  const project = path.resolve(root ?? '');
  const { stdout } = await git(project, ['worktree', 'list', '--porcelain']);
  const home = worktreeRoot();
  const worktrees = parseWorktrees(stdout).map((w, i) => ({
    ...w,
    // git spells a path with forward slashes; the window (and every other
    // path in this house) spells it the way the filesystem does.
    path: path.resolve(w.path),
    main: i === 0,
    ours: isOurs(w.path, home),
  }));
  return { worktrees, root: project, home };
}

/**
 * Is this path inside the folder this house keeps its worktrees in?
 *
 * The answer is physical as well as lexical: git reports a worktree by the
 * path it stored, and that can be the long spelling of a Windows short name
 * or `/private/var` for macOS's `/var`. Both name the folder this house made,
 * so both are ours.
 */
function isOurs(target, home = worktreeRoot()) {
  const lexicalBase = path.resolve(home);
  const lexicalAbs = path.resolve(target);
  const lexicalRel = path.relative(lexicalBase, lexicalAbs);
  const lexical = lexicalRel !== '..' && !lexicalRel.startsWith(`..${path.sep}`)
    && !path.isAbsolute(lexicalRel) && lexicalRel !== '';
  if (lexical) return true;
  const base = realPath(lexicalBase) ?? lexicalBase;
  const abs = realPath(lexicalAbs) ?? lexicalAbs;
  const rel = path.relative(base, abs);
  return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel) && rel !== '';
}

/**
 * Make a worktree for this project.
 *
 * The new checkout is a branch of its own (`aipass/<name>`), because git
 * refuses to check the same branch out in two folders — the project's branch
 * is already checked out in the project. The base is the current HEAD unless
 * the person names another ref.
 *
 * @param {{root: string, name: string, base?: string}} params
 * @returns {Promise<{path: string, name: string, branch: string, base: string, head: string}>}
 */
export async function create({ root, name, base = null } = {}) {
  const project = path.resolve(root ?? '');
  if (!fs.existsSync(project)) throw new Error(`no such folder: ${project}`);
  const folder = folderName(name);
  const baseRefName = baseRef(base);
  const branch = await freeBranch(project, branchName(name));
  const target = path.join(worktreeRoot(), folder);
  // A worktree that is already there is one the person made: overwriting it
  // would throw their work away, so the name has to be another one.
  if (fs.existsSync(target)) throw new Error(`a worktree named "${folder}" is already there: ${target}`);
  await fs.promises.mkdir(worktreeRoot(), { recursive: true });
  await git(project, ['worktree', 'add', '-b', branch, target, baseRefName]);
  const head = (await git(project, ['rev-parse', 'HEAD'])).stdout.trim();
  return { path: target, name: folder, branch, base: baseRefName, head, root: project };
}

/**
 * Take a worktree away.
 *
 * `git worktree remove` refuses a worktree that still holds changes, and
 * that refusal is the honest answer: those bytes exist nowhere else. The
 * person can say "yes, throw it away" (`force`), and the window asks before
 * it does.
 *
 * @param {{root: string, path: string, force?: boolean}} params
 */
export async function remove(params = {}) {
  if (!params.path) throw new Error('no worktree given');
  const project = path.resolve(params.root ?? '');
  const target = resolveInside(worktreeRoot(), params.path);
  const force = params.force === true;
  const listed = await list({ root: project });
  const known = listed.worktrees.find((w) => samePath(w.path, target));
  if (!known) throw new Error(`that is not a worktree of this project: ${target}`);
  if (known.main) throw new Error('that is the project itself — not a worktree of it');
  const args = ['worktree', 'remove'];
  if (force) args.push('--force');
  args.push(target);
  await git(project, args);
  // The registration goes with the folder: without the prune, git keeps
  // listing a checkout that is no longer there.
  await git(project, ['worktree', 'prune']).catch(() => {});
  return { ok: true, path: target, branch: known.branch };
}

/**
 * What changed inside a worktree.
 *
 * The changed files and the diff stat — what the person needs to decide
 * whether to merge it or throw it away. The status itself is the house's own
 * (harness/git.mjs#status), so there is one reading of "what changed".
 *
 * @param {{root: string, path: string}} params
 */
export async function status(params = {}) {
  if (!params.path) throw new Error('no worktree given');
  const target = resolveInside(worktreeRoot(), params.path);
  if (!fs.existsSync(target)) throw new Error(`there is no worktree at ${target}`);
  const st = await gitStatus({ root: target });
  const stat = await diffStat(target);
  const files = [...new Set([...st.staged, ...st.unstaged, ...st.untracked])];
  // The counts the person reads: how much changed, in lines. A file the run
  // CREATED is untracked, and `git diff` says nothing about untracked files —
  // so its lines are counted here, or the answer would read "nothing changed"
  // for a worktree full of new files.
  const counts = await countLines(target, st);
  return {
    path: target,
    branch: st.branch,
    clean: st.clean,
    staged: st.staged,
    unstaged: st.unstaged,
    untracked: st.untracked,
    files,
    stat,
    added: counts.added,
    removed: counts.removed,
  };
}

/** The diff stat of a tree: what is staged and what is not, one line each. */
async function diffStat(dir) {
  const unstaged = await git(dir, ['diff', '--stat', '--no-color']).catch(() => ({ stdout: '' }));
  const staged = await git(dir, ['diff', '--cached', '--stat', '--no-color']).catch(() => ({ stdout: '' }));
  return [staged.stdout.trim(), unstaged.stdout.trim()].filter(Boolean).join('\n');
}

/** The lines a diff adds and removes, untracked files included. */
async function countLines(dir, st) {
  let added = 0;
  let removed = 0;
  for (const args of [[], ['--cached']]) {
    const { stdout } = await git(dir, ['diff', '--numstat', '--no-color', ...args]).catch(() => ({ stdout: '' }));
    for (const line of stdout.split('\n')) {
      const [a, d] = line.split('\t');
      added += Number(a) || 0;
      removed += Number(d) || 0;
    }
  }
  for (const file of st.untracked ?? []) {
    added += await lineCount(path.join(dir, file));
  }
  return { added, removed };
}

/** How many lines a file holds — the only number a new file has. */
async function lineCount(abs) {
  try {
    const text = await fs.promises.readFile(abs, 'utf8');
    if (!text) return 0;
    return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  } catch {
    return 0;
  }
}

/**
 * The janitor: the worktrees nobody wants any more.
 *
 * A worktree is a directory on the person's disk — a whole checkout of their
 * repository — so a forgotten one is litter, and it is litter that grows. The
 * house already has a janitor for the sandbox projections
 * (harness/sandbox.mjs#sweepSandboxes), and this one follows its shape.
 *
 * What may go:
 *   - only the ones this house made (`ours`) — a checkout the person made by
 *     hand is theirs;
 *   - only the ones with NO changes in them. The branch keeps the COMMITS, so
 *     a commit is never lost by taking the checkout away — but an uncommitted
 *     file lives in that folder and nowhere else, and that is not ours to
 *     throw away;
 *   - only the ones that have sat there for a while (fourteen days by
 *     default): a worktree the person is thinking about is not litter.
 *
 * @param {{root: string, maxAgeMs?: number}} params
 */
export async function sweep({ root, maxAgeMs = 14 * 24 * 60 * 60 * 1000 } = {}) {
  const project = path.resolve(root ?? '');
  const listed = await list({ root: project });
  const now = Date.now();
  const removed = [];
  let kept = 0;
  for (const w of listed.worktrees) {
    if (w.main || !w.ours) { kept++; continue; }
    let age = 0;
    try {
      age = now - (await fs.promises.stat(w.path)).mtimeMs;
    } catch {
      // The folder is already gone: the registration is litter, and the prune
      // below is what takes it away.
      removed.push(w.path);
      continue;
    }
    if (age < maxAgeMs) { kept++; continue; }
    const st = await gitStatus({ root: w.path }).catch(() => null);
    if (!st || !st.clean) { kept++; continue; }
    try {
      await git(project, ['worktree', 'remove', '--force', w.path]);
      removed.push(w.path);
    } catch {
      kept++;
    }
  }
  if (removed.length) await git(project, ['worktree', 'prune']).catch(() => {});
  return { removed, kept, maxAgeMs };
}

export default { worktreeRoot, create, list, remove, status, sweep };
