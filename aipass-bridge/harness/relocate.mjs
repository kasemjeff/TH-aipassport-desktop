// relocate.mjs — re-key a project's data after its folder moved.
//
// Everything the app stores for a project is keyed by its absolute path:
// `sessions/<slug>/`, `memory/<hash>.json`, `goal/<hash>.json`, the
// `rules.json` entry, the project list in `settings.json`. That is what makes a
// backup a plain folder copy — and what made a move silent: a home copied to
// another machine (or a project renamed) kept every byte and lost every
// association, with sessions invisible in the picker, facts and the goal not
// loading and rules not applying, all of it sitting on disk under the old
// spelling.
//
// This module is the remap. It reads only from the home directory — the old
// folder does not need to exist anymore, which is the normal state after the
// move — and writes the new keys in place, merging into whatever already
// lives at the destination. It does not touch the project's files themselves:
// moving the folder is the person's move, this reconnects the bookkeeping.
import fs from 'node:fs';
import path from 'node:path';
import { Settings, aipassHome } from './settings.mjs';
import { SessionStore } from './session.mjs';
import { RulesStore } from './rules.mjs';
import { moveMemory } from './memory-store.mjs';
import { moveGoal } from './goal.mjs';

/**
 * Point every per-project store at `to` instead of `from`.
 *
 * @param {object} opts
 * @param {string} opts.from  the absolute path the data was keyed under
 * @param {string} opts.to    where the project lives now (must exist)
 * @param {string} [opts.home] the install's home directory (tests, AIPASS_HOME)
 * @returns {{from: string, to: string, sessions: object, facts: number,
 *            goal: object|null, rules: object, settings: boolean}}
 */
export function relocateProject({ from, to, home = aipassHome() } = {}) {
  if (!from || !to) throw new Error('relocate needs both paths: <old> <new>');
  const fromAbs = path.resolve(from);
  const toAbs = path.resolve(to);
  if (fromAbs === toAbs) throw new Error('the old and new paths are the same');
  // The project's new home has to exist: this rewrites keys, it cannot
  // conjure the folder, and a typo in the new path would silently re-key a
  // whole history onto a path nobody is ever going to open.
  let stat = null;
  try { stat = fs.statSync(toAbs); } catch { /* reported below */ }
  if (!stat?.isDirectory()) throw new Error(`no such folder: ${toAbs} (the project must already be there)`);

  const sessions = new SessionStore(path.join(home, 'sessions')).reassign(fromAbs, toAbs);
  const facts = moveMemory(fromAbs, toAbs, path.join(home, 'memory'));
  const goal = moveGoal(fromAbs, toAbs, path.join(home, 'goal'));
  const rules = new RulesStore(path.join(home, 'rules.json')).moveRoot(fromAbs, toAbs);
  const settings = new Settings(home).moveProject(fromAbs, toAbs);
  return { from: fromAbs, to: toAbs, sessions, facts, goal, rules, settings };
}
