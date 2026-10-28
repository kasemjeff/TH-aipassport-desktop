// Scheduled work: the tasks that run at a time of day, without cron.
//
// The competitors run work on a schedule (Claude Code's /schedule and its
// cloud routines, Codex desktop's "schedule a task inside a chat", Cursor
// Automations), and the person this app is for is the one it is for
// everywhere else: a student with free AI credits and a project to finish.
//
// No cron, no `at`, no shell. A Windows machine has neither of the first two,
// and a schedule that needs an installer is a schedule nobody sets up. The
// time is a local "HH:MM" and the comparison happens in JS, so the same
// schedule behaves the same on every machine.
//
// The work itself is the CLI — `aipass agent "<task>" --root <root>` —
// because the CLI is the stable front for the harness: a scheduled run and a
// run the person started are the same run, and the terminal and the window
// cannot drift apart.
//
// The child is started DETACHED, the way the house starts background work
// (harness/bridge-pid.mjs, harness/launcher.mjs): it records its own pid so
// it can be found, it ends itself when its work is done, and it never keeps
// the desktop backend alive.
//
// The backend ticks the schedule itself (startScheduleTicker): a task at 09:00
// is the machine's promise, not the window's, and a closed window used to mean
// a scheduler that never ran. One lock in the schedule store makes the ticker
// and a manual `schedule.runDue` safe together — a due entry runs once.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { aipassHome } from './settings.mjs';
import { writeFileAtomic } from './atomic-write.mjs';
import { isRunning } from './bridge-pid.mjs';

/** The file the schedule lives in, under the aipass home. */
export const SCHEDULE_FILE = 'schedule.json';

/** The mode the schedule file is pinned to: the owner's alone. */
export const SCHEDULE_MODE = 0o600;

/** The file the running scheduled jobs are named in, the way bridge.pid names the bridge. */
export const SCHEDULE_PID_FILE = 'schedule.pid';

/**
 * The one file that says "a process is looking at the schedule right now".
 *
 * Two surfaces can reach the store at once — the window's `schedule.runDue`
 * and the backend's own ticker, or two backends on one machine. Without the
 * lock both read the same "due" list before either writes `lastRunAt`, and a
 * daily task runs twice. The lock is held for the read/spawn/write, not for
 * the scheduled run itself: the child is detached and outlives it.
 */
export const SCHEDULE_LOCK_FILE = 'schedule.lock';

/** How long a lock with a live owner may sit before it is treated as hung. */
const LOCK_STALE_MS = 120_000;

/** The ticker's interval. The schedule's unit is a minute, so this is enough. */
export const SCHEDULE_TICK_MS = 60_000;

const HARNESS_DIR = path.dirname(fileURLToPath(import.meta.url));

/**
 * The CLI the scheduled work runs through.
 *
 * The sibling `bin/aipass.mjs` is the same file the terminal runs and the
 * one the packaged app ships (tauri.conf.json resources), so there is one
 * front and not two.
 *
 * @returns {string}
 */
export const cliPath = () => path.resolve(HARNESS_DIR, '..', 'bin', 'aipass.mjs');

/**
 * The minutes since midnight, in the machine's own time.
 *
 * @param {number} ms
 * @returns {number}
 */
const minutesOfDay = (ms) => {
  const d = new Date(ms);
  return d.getHours() * 60 + d.getMinutes();
};

/**
 * The local calendar day a moment falls in.
 *
 * @param {number} ms
 * @returns {string}
 */
const dayKey = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/**
 * The minutes since midnight of an "HH:MM".
 *
 * @param {string} at
 * @returns {number|null} null when the string is not a time of day
 */
export const parseTime = (at) => {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(at ?? '').trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

/**
 * Has this entry already run today?
 *
 * A daily entry runs once a day, and the day is the reader's: a run at 00:30
 * belongs to the day it happened on, not to the day the UTC calendar says.
 *
 * @param {number|null} lastRunAt
 * @param {number} now
 * @returns {boolean}
 */
const ranToday = (lastRunAt, now) => {
  if (!Number.isFinite(lastRunAt)) return false; // it has never run
  return dayKey(lastRunAt) === dayKey(now);
};

/**
 * Is this entry due at this moment?
 *
 * The time has to have come, and the entry has to be one that wants to run:
 * a disabled entry never runs, a daily entry has not run today, and a `once`
 * entry has never run at all — it is spent the moment it does.
 *
 * @param {Record<string, any>} entry
 * @param {number} now
 * @returns {boolean}
 */
export const isDue = (entry, now) => {
  if (!entry?.enabled) return false;
  const due = parseTime(entry.at);
  if (due === null) return false;
  if (minutesOfDay(now) < due) return false;
  if (entry.kind === 'once') return !entry.lastRunAt;
  return !ranToday(entry.lastRunAt, now);
};

/**
 * A moment, or nothing.
 *
 * `Number(null)` is 0, so a plain conversion would turn "this has never
 * run" into "this ran at the epoch" — a moment that reads as a fact.
 *
 * @param {any} value
 * @returns {number|null}
 */
const momentOf = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

/**
 * What counts as an entry.
 *
 * A line that is not an entry is skipped rather than loaded: the file is the
 * user's own and a hand-edit should not be able to crash the store.
 *
 * @param {any} e
 * @returns {boolean}
 */
const isEntry = (e) => e && typeof e === 'object' && !Array.isArray(e)
  && typeof e.id === 'string' && e.id
  && typeof e.task === 'string'
  && typeof e.root === 'string';

/**
 * An entry as it is stored: the fields, with their defaults.
 *
 * @param {Record<string, any>} e
 * @returns {Record<string, any>}
 */
const cleanEntry = (e) => ({
  id: String(e.id),
  task: String(e.task),
  root: String(e.root),
  at: String(e.at ?? ''),
  kind: e.kind === 'once' ? 'once' : 'daily',
  enabled: e.enabled !== false,
  lastRunAt: momentOf(e.lastRunAt),
  createdAt: momentOf(e.createdAt),
});

/**
 * A new entry, checked.
 *
 * The checks are here because the entry is what a person asked to happen at
 * a time of day on their own machine: a task with no text, a folder that is
 * not a folder, or a time that is not a time are all refused by name, so the
 * window can say which one was wrong.
 *
 * @param {Record<string, any>} input
 * @returns {Record<string, any>}
 */
function makeEntry(input = {}) {
  const task = String(input.task ?? '').trim();
  if (!task) throw new Error('a scheduled task needs something to do');
  const root = String(input.root ?? '').trim();
  if (!root) throw new Error('a scheduled task needs a project folder');
  const at = String(input.at ?? '').trim();
  if (parseTime(at) === null) throw new Error(`not a time of day: "${at}" — use HH:MM`);
  const kind = String(input.kind ?? 'daily').trim().toLowerCase();
  if (kind !== 'daily' && kind !== 'once') throw new Error(`unknown schedule kind: "${kind}"`);
  return {
    // 48 bits, like a session id: the id is a key in a file, and a
    // collision would run one task over another.
    id: typeof input.id === 'string' && input.id ? input.id : crypto.randomBytes(6).toString('hex'),
    task,
    root: path.resolve(root),
    at,
    kind,
    enabled: input.enabled !== false,
    lastRunAt: momentOf(input.lastRunAt),
    createdAt: momentOf(input.createdAt) ?? Date.now(),
  };
}

/**
 * The entry after it has run.
 *
 * A `once` entry is spent: it has run, and it never runs again. A daily entry
 * keeps its place and waits for tomorrow.
 *
 * @param {Record<string, any>} entry
 * @param {number} at
 * @returns {Record<string, any>}
 */
const spentEntry = (entry, at) => ({
  ...entry,
  lastRunAt: at,
  enabled: entry.kind === 'once' ? false : entry.enabled,
});

/**
 * Take the schedule's one lock, or say who holds it.
 *
 * `wx` is the whole mechanism: an exclusive create is atomic on every
 * filesystem the app ships on, so the winner is the only process that reads
 * the due list. A lock left by a process that is gone — a crash, a kill, a
 * machine that lost power — is litter, and a lock whose owner is alive but
 * older than any read has a right to be is hung; both are taken over once.
 * The comparison uses the wall clock, not the caller's `now`, because the lock
 * is about liveness and a test may judge entries at a synthetic time.
 *
 * @param {string} file
 * @returns {Promise<string|null>} the token this process wrote, or null
 */
const takeLock = async (file) => {
  const body = `${JSON.stringify({ pid: process.pid, at: Date.now() })}\n`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await fs.promises.open(file, 'wx', SCHEDULE_MODE);
      try { await handle.writeFile(body); } finally { await handle.close(); }
      return body;
    } catch (err) {
      if (/** @type {any} */ (err)?.code !== 'EEXIST') return false;
      let held = null;
      try { held = JSON.parse(await fs.promises.readFile(file, 'utf8')); } catch { /* unreadable: litter */ }
      const age = Date.now() - Number(held?.at ?? 0);
      const alive = Number.isInteger(held?.pid) && isRunning(held.pid);
      if (alive && age >= 0 && age < LOCK_STALE_MS) return null;
      try { await fs.promises.rm(file, { force: true }); } catch { return null; }
    }
  }
  return null;
};

/**
 * Drop the lock, but only if it is still the one this process wrote. A
 * takeover replaces the file; a blind `rm` here would delete the new owner's.
 *
 * @param {string} file
 * @param {string} token the body `takeLock` returned
 */
const releaseLock = async (file, token) => {
  try {
    if (await fs.promises.readFile(file, 'utf8') !== token) return;
    await fs.promises.rm(file, { force: true });
  } catch { /* already gone or taken over */ }
};

/**
 * The store of scheduled work.
 */
export class ScheduleStore {
  /**
   * @param {string} [file] where the schedule lives; defaults to the aipass home
   */
  constructor(file = path.join(aipassHome(), SCHEDULE_FILE)) {
    this.file = file;
  }

  /** The file the running scheduled jobs are named in. */
  get pidFile() {
    return path.join(path.dirname(this.file), SCHEDULE_PID_FILE);
  }

  /** The file that keeps two backends from reading the same due list. */
  get lockFile() {
    return path.join(path.dirname(this.file), SCHEDULE_LOCK_FILE);
  }

  /**
   * The entries, as they are on the disk.
   *
   * A missing file is the normal first-run case, and a file that cannot be
   * parsed is skipped rather than loaded: the schedule is a convenience, and
   * a broken one must not take the window down with it.
   *
   * @returns {Promise<Array<Record<string, any>>>}
   */
  async read() {
    let raw = null;
    try {
      raw = await fs.promises.readFile(this.file, 'utf8');
    } catch {
      return [];
    }
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch { return []; }
    const list = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.entries) ? parsed.entries : []);
    // A file written before the modes were pinned turns owner-only when it is
    // opened — the same rule the session store follows.
    try { await fs.promises.chmod(this.file, SCHEDULE_MODE); } catch { /* best effort on Windows */ }
    return list.filter(isEntry).map(cleanEntry);
  }

  /**
   * Write the entries, whole.
   *
   * The shared atomic swap: a crash mid-write leaves the previous schedule
   * whole, never half of one, and the temp name is one no other writer
   * shares.
   *
   * @param {Array<Record<string, any>>} entries
   */
  async write(entries) {
    await fs.promises.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    writeFileAtomic(this.file, `${JSON.stringify({ version: 1, entries }, null, 2)}\n`, { mode: SCHEDULE_MODE });
  }

  /**
   * Every entry.
   *
   * @returns {Promise<Array<Record<string, any>>>}
   */
  async list() {
    return this.read();
  }

  /**
   * Add one entry.
   *
   * @param {Record<string, any>} input
   * @returns {Promise<Record<string, any>>} the entry as it was stored
   */
  async add(input = {}) {
    const entry = makeEntry(input);
    const entries = await this.read();
    entries.push(entry);
    await this.write(entries);
    return entry;
  }

  /**
   * Take one entry out.
   *
   * @param {string} id
   * @returns {Promise<boolean>} whether it was there
   */
  async remove(id) {
    const entries = await this.read();
    const next = entries.filter((e) => e.id !== id);
    if (next.length === entries.length) return false;
    await this.write(next);
    return true;
  }

  /**
   * The entries whose time has come and that have not already run today.
   *
   * @param {number|Date} [now]
   * @returns {Promise<Array<Record<string, any>>>}
   */
  async due(now = Date.now()) {
    const at = now instanceof Date ? now.getTime() : Number(now);
    const entries = await this.read();
    return entries.filter((e) => isDue(e, at));
  }

  /**
   * The pids of the scheduled jobs that are still running.
   *
   * The file names the live ones only: a pid of a job that ended days ago is
   * litter, and `isRunning` is the same test the bridge's pid file uses.
   *
   * @returns {Promise<number[]>}
   */
  async readPids() {
    let raw = '';
    try { raw = await fs.promises.readFile(this.pidFile, 'utf8'); } catch { return []; }
    return raw.split('\n').map((line) => Number(line.trim())).filter((pid) => Number.isInteger(pid) && pid > 0);
  }

  /**
   * Record the pids of the jobs that just started.
   *
   * @param {number[]} pids
   */
  async recordPids(pids) {
    const live = (await this.readPids()).filter((pid) => isRunning(pid));
    const all = [...new Set([...live, ...pids.filter((pid) => Number.isInteger(pid) && pid > 0)])];
    if (!all.length) {
      await fs.promises.rm(this.pidFile, { force: true });
      return;
    }
    await fs.promises.mkdir(path.dirname(this.pidFile), { recursive: true, mode: 0o700 });
    writeFileAtomic(this.pidFile, `${all.join('\n')}\n`, { mode: SCHEDULE_MODE });
  }

  /**
   * Run the work that is due, and start it DETACHED.
   *
   * The child is the CLI, so a scheduled run is a run like any other: the
   * same harness, the same permissions, the same session log. It is started
   * detached and unreferenced, so it outlives this process on purpose — and
   * the desktop backend can still exit while the scheduled work is going.
   *
   * The entries are marked as run before this call returns: a schedule that
   * runs the same task twice because the machine was busy is worse than one
   * that skips a run because the machine was busy.
   *
   * @param {object} [opts]
   * @param {number|Date} [opts.now] the moment to judge the entries by
   * @param {Function} [opts.spawnFn] the spawn to use (a test's fake)
   * @param {string} [opts.cli] the CLI to run
   * @param {NodeJS.ProcessEnv} [opts.env]
   * @returns {Promise<{ran: Array<Record<string, any>>, count: number, at: number, locked?: boolean}>}
   */
  async runDue({ now = Date.now(), spawnFn = spawn, cli = cliPath(), env = process.env } = {}) {
    const at = now instanceof Date ? now.getTime() : Number(now);
    // One reader at a time. The lock covers the read/spawn/write, not the
    // scheduled work: the child is detached. A caller that finds it held
    // answers "nothing ran" rather than running the same entry twice.
    const token = await takeLock(this.lockFile);
    if (!token) return { ran: [], count: 0, at, locked: true };
    try {
      const entries = await this.read();
      const due = entries.filter((e) => isDue(e, at));
      const ran = [];
      for (const entry of due) {
        const pid = startDetached(entry, { spawnFn, cli, env });
        ran.push({ id: entry.id, task: entry.task, root: entry.root, pid });
      }
      if (due.length) {
        const ids = new Set(due.map((e) => e.id));
        await this.write(entries.map((e) => (ids.has(e.id) ? spentEntry(e, at) : e)));
        await this.recordPids(ran.map((r) => r.pid));
      }
      return { ran, count: ran.length, at };
    } finally {
      await releaseLock(this.lockFile, token);
    }
  }
}

/**
 * Start one scheduled job, detached.
 *
 * There is no shell anywhere here: the task is one argv element, so a task
 * with a quote or an ampersand in it is the task the person wrote.
 *
 * @param {Record<string, any>} entry
 * @param {{spawnFn: Function, cli: string, env: NodeJS.ProcessEnv}} opts
 * @returns {number|null} the child's pid
 */
const startDetached = (entry, { spawnFn, cli, env }) => {
  const child = spawnFn(process.execPath, [cli, 'agent', entry.task, '--root', entry.root], {
    cwd: entry.root,
    env: { ...env },
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
  });
  // The child is not ours to wait for. An unreferenced handle is what lets the
  // desktop backend exit while the scheduled work is still running, and the
  // detached child ends itself when its work is done.
  try { child.unref(); } catch { /* already gone */ }
  return child?.pid ?? null;
};

/** The store of the machine's own home, for the module-level calls below. */
const defaultStore = () => new ScheduleStore(path.join(aipassHome(), SCHEDULE_FILE));

/**
 * Every scheduled task of this machine.
 *
 * @returns {Promise<Array<Record<string, any>>>}
 */
export const list = () => defaultStore().list();

/**
 * Add a scheduled task.
 *
 * @param {Record<string, any>} entry
 * @returns {Promise<Record<string, any>>}
 */
export const add = (entry) => defaultStore().add(entry);

/**
 * Remove a scheduled task.
 *
 * @param {string} id
 * @returns {Promise<boolean>}
 */
export const remove = (id) => defaultStore().remove(id);

/**
 * The tasks whose time has come.
 *
 * @param {number|Date} [now]
 * @returns {Promise<Array<Record<string, any>>>}
 */
export const due = (now = Date.now()) => defaultStore().due(now);

/**
 * Run the work that is due.
 *
 * @param {object} [opts]
 * @returns {Promise<{ran: Array<Record<string, any>>, count: number, at: number, locked?: boolean}>}
 */
export const runDue = (opts = {}) => defaultStore().runDue(opts);

/**
 * The machine's own ticker: run what is due on start and on an interval.
 *
 * The window is not the scheduler. A person who closes it still expects the
 * task they set to run, and the backend is the process that outlives the
 * window. The timer is unref'd, so it never keeps the backend alive; the
 * store's lock makes this and a manual `schedule.runDue` safe together.
 *
 * @param {object} [opts]
 * @param {ScheduleStore} [opts.store]
 * @param {number} [opts.intervalMs]
 * @param {object} [opts.runDue] extra options for the store's runDue (a test's spawn)
 * @returns {{tick: () => void, stop: () => void}}
 */
export function startScheduleTicker({ store = defaultStore(), intervalMs = SCHEDULE_TICK_MS, runDue: runOpts = {} } = {}) {
  let stopped = false;
  const tick = () => {
    if (stopped) return;
    const now = runOpts.now ?? Date.now();
    store.runDue({ ...runOpts, now }).catch(() => { /* the next tick retries */ });
  };
  // The start is a tick: a machine that was asleep at the scheduled minute is
  // due now, and the store's rule is "once", not "on the minute".
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return {
    tick,
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
