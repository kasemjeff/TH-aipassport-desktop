// The goal: one durable objective per project, pursued across runs.
//
// Every peer with a long horizon has a version of this (dsh's goal +
// goal-round-driver, Codex's thread goals). The memory store carries what was
// learned; a plan/TODO carries what is left in ONE run. Neither survives the
// run boundary with an answer to "what am I actually trying to finish". This
// file is that answer: a small JSON file per project under
// ~/.aipass/goal/<project-hash>.json, set by the person, read by every run.
//
// The rules that make it safe:
//
//   - one goal per project, and the person owns it — the model can only mark
//     it complete or blocked, never rewrite the objective
//   - `rounds` counts the DONE refusals that actually reached the model, and
//     `maxRounds` bounds them (default 8, hard ceiling 64); at the cap the
//     goal is recorded blocked and the run stops as `goal-rounds`
//   - every mutation re-reads the store first, so a `aipass goal pause|clear`
//     typed in another window mid-run is respected, not overwritten
//
// It stores the person's own words, not secrets, and it is owner-only like the
// session store: 0700 folder, 0600 atomic file.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { aipassHome } from './settings.mjs';
import { writeFileAtomic } from './atomic-write.mjs';
import { projectKey } from './project-key.mjs';

export const DEFAULT_MAX_ROUNDS = 8;
export const MAX_ROUNDS = 64;
export const OBJECTIVE_MAX = 4000;
export const DONE_MAX = 2000;
export const BLOCKED_MAX = 500;

const STATUSES = new Set(['active', 'paused', 'complete', 'blocked']);
// The two a person is still working with: replacing one needs --force.
const LIVE = new Set(['active', 'paused']);

const defaultDir = () => path.join(aipassHome(), 'goal');
// Unified with the retrieval/memory/checkpoint stores: SHA-256 over the real
// root, first 16 hex digits. The old sha1-12 name is read once for migration.
const projectHash = (root) => projectKey(root);
const legacyProjectHash = (root) => crypto.createHash('sha1').update(path.resolve(root)).digest('hex').slice(0, 12);

/**
 * Where a project's goal lives. The folder is created owner-only, once — the
 * same rule the memory store follows (see its storePath for why the chmod is
 * not re-pinned on every call).
 */
function storePath(root, dir = defaultDir()) {
  const existed = fs.existsSync(dir);
  try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch {}
  if (!existed) {
    try { fs.chmodSync(dir, 0o700); } catch { /* windows has no POSIX modes */ }
  }
  return path.join(dir, projectHash(root) + '.json');
}

/** The store file of a project — for `aipass goal path` and for tests. */
export function goalPath(root, dir = defaultDir()) {
  return storePath(root, dir);
}

/**
 * Read the project's goal, or null. A missing or corrupt file reads as "no
 * goal": the store is a convenience, never a reason a run cannot start.
 *
 * @returns {null | {objective: string, status: string, rounds: number, maxRounds: number,
 *   done: string|null, blocked: string|null, created: string|null, updated: string|null}}
 */
export function loadGoal(root, dir = defaultDir()) {
  const file = storePath(root, dir);
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch {
    // Migrate a goal stored under the old sha1-12 name, if present.
    const legacyFile = path.join(dir, legacyProjectHash(root) + '.json');
    try { raw = fs.readFileSync(legacyFile, 'utf8'); } catch { return null; }
    try { fs.writeFileSync(file, raw); fs.rmSync(legacyFile, { force: true }); } catch {}
  }
  let data;
  try { data = JSON.parse(raw); } catch { return null; }
  if (!data || typeof data !== 'object') return null;
  const objective = String(data.objective ?? '').trim();
  const status = String(data.status ?? '');
  if (!objective || !STATUSES.has(status)) return null;
  const rounds = Number.isFinite(Number(data.rounds)) ? Math.max(0, Math.floor(Number(data.rounds))) : 0;
  const maxRounds = Number.isFinite(Number(data.maxRounds))
    ? Math.min(MAX_ROUNDS, Math.max(1, Math.floor(Number(data.maxRounds)))) : DEFAULT_MAX_ROUNDS;
  return {
    objective: objective.slice(0, OBJECTIVE_MAX),
    status,
    rounds,
    maxRounds,
    done: data.done == null ? null : String(data.done).slice(0, DONE_MAX),
    blocked: data.blocked == null ? null : String(data.blocked).slice(0, BLOCKED_MAX),
    created: data.created == null ? null : String(data.created),
    updated: data.updated == null ? null : String(data.updated),
  };
}

function write(root, goal, dir) {
  writeFileAtomic(storePath(root, dir), JSON.stringify(goal, null, 2) + '\n', { mode: 0o600 });
  return goal;
}

/** The live goal, or a throw with the sentence a person needs to read. */
function liveGoal(root, dir) {
  const goal = loadGoal(root, dir);
  if (!goal) throw new Error('this project has no goal — set one with: aipass goal set "<what to finish>"');
  return goal;
}

/**
 * Set (or replace) the project's goal. The objective is the person's words,
 * whitespace-collapsed and capped; a live goal is only replaced with `force`,
 * so a stray `goal set` cannot silently throw away where the work stood.
 */
export function setGoal(root, objective, { maxRounds = DEFAULT_MAX_ROUNDS, force = false, dir } = {}) {
  const text = String(objective ?? '').replace(/\s+/g, ' ').trim().slice(0, OBJECTIVE_MAX);
  if (!text) throw new Error('a goal needs an objective: aipass goal set "<what to finish>"');
  const cap = Number(maxRounds);
  if (!Number.isFinite(cap) || cap < 1 || cap > MAX_ROUNDS) {
    throw new Error(`--rounds must be a whole number from 1 to ${MAX_ROUNDS}`);
  }
  const current = loadGoal(root, dir);
  if (current && LIVE.has(current.status) && !force) {
    throw new Error(`this project already has ${current.status === 'active' ? 'an' : 'a'} ${current.status} goal — finish it (aipass goal done), clear it, or replace it with --force`);
  }
  const now = new Date().toISOString();
  return write(root, {
    objective: text,
    status: 'active',
    rounds: 0,
    maxRounds: Math.floor(cap),
    done: null,
    blocked: null,
    created: now,
    updated: now,
  }, dir);
}

/**
 * Pause an active goal. A paused goal is not shown to the model and earns no
 * rounds; the work can still be done, it just is not chased automatically.
 */
export function pauseGoal(root, dir) {
  const goal = liveGoal(root, dir);
  if (goal.status === 'paused') return goal;
  if (!LIVE.has(goal.status)) throw new Error(`the goal is already ${goal.status} — nothing to pause`);
  return write(root, { ...goal, status: 'paused', updated: new Date().toISOString() }, dir);
}

/**
 * Resume a paused or blocked goal. A blocked one gets a fresh allowance —
 * otherwise `aipass goal resume` after the round cap would block on the very
 * next DONE, which is not what the person asked for.
 */
export function resumeGoal(root, dir) {
  const goal = liveGoal(root, dir);
  if (goal.status === 'active') return goal;
  const fresh = goal.status === 'blocked';
  return write(root, {
    ...goal,
    status: 'active',
    ...(fresh ? { rounds: 0, blocked: null } : {}),
    updated: new Date().toISOString(),
  }, dir);
}

/** Mark the goal complete, with the model's (or the person's) closing words. */
export function completeGoal(root, done = '', dir) {
  const goal = liveGoal(root, dir);
  return write(root, {
    ...goal,
    status: 'complete',
    done: String(done ?? '').replace(/\s+/g, ' ').trim().slice(0, DONE_MAX) || goal.done,
    updated: new Date().toISOString(),
  }, dir);
}

/** Mark the goal blocked — `round-limit` when the cap was reached. */
export function blockGoal(root, reason = '', dir) {
  const goal = liveGoal(root, dir);
  return write(root, {
    ...goal,
    status: 'blocked',
    blocked: String(reason ?? '').replace(/\s+/g, ' ').trim().slice(0, BLOCKED_MAX) || 'no reason given',
    updated: new Date().toISOString(),
  }, dir);
}

/** Forget the goal entirely (the file goes away). */
export function clearGoal(root, dir = defaultDir()) {
  const file = storePath(root, dir);
  try { fs.rmSync(file, { force: true }); } catch {}
}

/**
 * Re-key a project's goal after its folder moved: the file name is a hash of
 * the path, so a moved project silently lost the objective every run was
 * chasing. The moved goal wins over one already at the destination — it is the
 * history of this folder, and a copy there can only be the same leftover.
 * A corrupt source reads as no goal and stays where it is.
 */
export function moveGoal(fromRoot, toRoot, dir = defaultDir()) {
  const goal = loadGoal(fromRoot, dir);
  if (!goal) return null;
  write(toRoot, goal, dir);
  clearGoal(fromRoot, dir);
  return goal;
}

/**
 * One run's view of the goal. Every method reads the store fresh, so the
 * answer is what the person last wrote — not what was true when the run began.
 *
 * `done()` is the DONE gate's question: a plain DONE arrived. null means "let
 * it end" (no goal, or the person paused/cleared/completed it mid-run).
 */
export function createGoalController(root, dir) {
  return {
    /** The active goal, or null. Paused/complete/blocked goals are invisible. */
    current() {
      const goal = loadGoal(root, dir);
      return goal?.status === 'active' ? goal : null;
    },

    /**
     * A DONE arrived while the goal was active: buy one more round, or block
     * at the cap. The objective rides the nudge — the model may have lost it
     * between conversations.
     */
    done() {
      const goal = loadGoal(root, dir);
      if (!goal || goal.status !== 'active') return null;
      if (goal.rounds >= goal.maxRounds) {
        const blocked = blockGoal(root, 'round-limit', dir);
        return {
          stop: true,
          summary: `the goal is still unfinished after ${blocked.rounds} round(s) — recorded as blocked (round-limit). Resume it with \`aipass goal resume\` when the plan changes.`,
        };
      }
      const round = goal.rounds + 1;
      write(root, { ...goal, rounds: round, updated: new Date().toISOString() }, dir);
      return {
        stop: false,
        rounds: round,
        maxRounds: goal.maxRounds,
        msg: `Not finished yet — this project has an active goal, and this is round ${round} of ${goal.maxRounds}:\n${goal.objective}\n\nKeep working toward it, then write DONE. When the goal is genuinely complete, write GOAL DONE on its own line before the DONE; if you cannot make progress, write GOAL BLOCKED <reason> and finish with DONE.`,
      };
    },

    /** GOAL DONE — the model says the objective is met. */
    complete(done) { return completeGoal(root, done, dir); },

    /** GOAL BLOCKED — the model needs the person. */
    block(reason) { return blockGoal(root, reason, dir); },
  };
}

export default createGoalController;
