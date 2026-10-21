// Persisted permission rules and "always" grants, per project.
//
// One JSON file (default ~/.aipass/rules.json) keyed by project root:
//
//   { "/home/me/project": {
//       "rules":  [{ "pattern": "src/**", "decision": "allow", "kinds": ["write"] }],
//       "grants": [{ "kind": "write", "arg": "src/config.ts" }]
//   } }
//
// A shell grant is shaped differently, because a shell call is not named by
// its argument: a RUN carries the command in its body and `arg: ''`, so a
// grant keyed by the argument was the same grant for every command that
// would ever run — one "always" on a benign command authorised the rest of
// them, for good, across restarts. A shell grant therefore carries the
// command's shape:
//
//   "grants": [{ "kind": "run", "arg": "git status",
//                "head": "git status", "fingerprint": "6f2a1c9d0b7e4a35" }]
//
// `arg` is the command (a RUN's own argument is empty by protocol, so the
// argument of a shell grant IS the command), `head` is what a person reads
// in the file (the program, and the verb under it), and `fingerprint` is
// what decides: the same command line, or it is a new command and it is
// asked about again. A grant written before this shape existed — the bare
// `{ "kind": "run", "arg": "" }` — answers nothing; the safe reading of a
// blanket shell grant is "ask again".
//
// "Always" answers used to die with the process, which made the desktop ask
// the same question on every run; now they survive a restart. The engine
// does not change — this is only where its rules and grants are seeded from,
// and the write-through hook for new grants.
//
// The file is trusted the way settings.json is: it lives in the user's home,
// the agent's tools cannot reach outside the project root, and anything in it
// that does not parse as a rule or grant is skipped rather than loaded.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { aipassHome } from './settings.mjs';
import { writeFileAtomic } from './atomic-write.mjs';

const isRule = (r) => r && typeof r === 'object'
  && typeof r.pattern === 'string' && r.pattern
  && (r.decision === 'allow' || r.decision === 'deny')
  && (r.kinds === undefined || (Array.isArray(r.kinds) && r.kinds.every((k) => typeof k === 'string')));

const isGrant = (g) => g && typeof g === 'object'
  && typeof g.kind === 'string' && typeof g.arg === 'string'
  && (g.head === undefined || typeof g.head === 'string')
  && (g.fingerprint === undefined || typeof g.fingerprint === 'string');

/**
 * The kinds whose argument is not a path.
 *
 * A RUN carries the command in its body and `arg: ''` (protocol.mjs), so a
 * grant for one cannot be keyed by that argument: every shell call would
 * share the key `run:` and one "always" would answer all of them.
 */
const SHELL_KINDS = new Set(['run', 'shell']);

/**
 * The keys a grant must not carry.
 *
 * The same rule as the settings file: `__proto__` in an own property is
 * what a later `Object.assign` acts on, and the inherited setter it reaches
 * replaces the target's prototype.
 */
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** A grant with the dangerous keys gone, and nothing else changed. */
const safeGrant = (g) => {
  const out = {};
  for (const [k, v] of Object.entries(g)) {
    if (DANGEROUS_KEYS.has(k)) continue;
    out[k] = v;
  }
  return out;
};

/** The grants of a list, read back from the file. */
const cleanGrants = (list) => (Array.isArray(list) ? list : []).filter(isGrant).map(safeGrant);

/** A command line as a grant compares it: one space between the words. */
export function normaliseCommand(command) {
  return String(command ?? '').trim().replace(/\s+/g, ' ');
}

// The shape of a command is decided by the words that change what it does,
// so the separators that chain commands are named here: `a && b` is two
// commands and a grant on one does not cover the other.
const RUN_SPLIT = /&&|\|\||;/;

// A word that may be part of a shape: letters, digits, dot, dash, underscore.
// A path, a URL or a quoted string is not — those carry the command's
// payload, and a grant must never write a payload into a file.
const PLAIN_WORD = /^[a-z0-9._-]{1,40}$/i;

/**
 * The shape of a shell command: the part a remembered "always" may cover.
 *
 * The program, plus the first plain word after it — the verb that decides
 * what the program does. `git status` and `git push` are different things, and
 * a grant that cannot tell them apart cannot say what it allows. A chained
 * command (`a && b`) is two commands, and the shape names both, so a grant on
 * one does not cover the other.
 *
 * The word has to be a plain one: a path, a URL or a quoted string carries
 * the command's payload, and a grant must never write a payload into a file.
 *
 * This is the ONE definition of the shape. The engine (harness/permissions.mjs)
 * and the stored format (here) compare the same thing, so a grant written by
 * one answers in the other.
 */
export function commandShape(command) {
  const text = normaliseCommand(command);
  if (!text) return '';
  const segments = text.split(RUN_SPLIT).map((s) => s.trim()).filter(Boolean);
  return segments.map(segmentShape).filter(Boolean).join(' && ');
}

/** One segment's shape: the program, and the first plain word after it. */
function segmentShape(segment) {
  const words = normaliseCommand(segment).split(' ').filter(Boolean);
  if (!words.length) return '';
  const program = words[0];
  const word = words.slice(1).find((w) => !w.startsWith('-') && PLAIN_WORD.test(w));
  return word ? `${program} ${word}` : program;
}

/**
 * The program a command runs, and the verb under it when the program has
 * one: `git status` and `git push` are different things, and a grant that
 * cannot tell them apart cannot say what it allows.
 */
export function commandHead(command) {
  return commandShape(command);
}

/** A fingerprint of the whole command line: the same command, the same grant. */
export function commandFingerprint(command) {
  const text = normaliseCommand(command);
  if (!text) return null;
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/**
 * The command a shell grant is about.
 *
 * The command rides in the body (a RUN's argument is empty by protocol),
 * but a caller that puts it in the argument is read too: the grant has to
 * be keyed by the command either way, and the engine may hand it over as
 * either one.
 */
const grantCommand = (kind, arg, body) => {
  const text = String(body ?? '').trim();
  if (text) return text;
  if (SHELL_KINDS.has(String(kind ?? '').toLowerCase())) return String(arg ?? '').trim();
  return '';
};

/**
 * The grant for one call, in the shape it is stored in.
 *
 * A path-shaped kind keeps the shape it always had — `{kind, arg}` — so an
 * existing rules.json stays readable and a grant for a file still names the
 * file.
 *
 * A shell kind carries the command's shape: the command in the argument (a
 * RUN's own argument is empty by protocol, so the argument of a shell grant
 * IS the command), the program (and verb) a person reads in the file, and a
 * fingerprint of the whole command line.
 */
export function makeGrant(kind, arg = '', body = '') {
  const command = grantCommand(kind, arg, body);
  if (!command) return { kind: String(kind ?? ''), arg: String(arg ?? '') };
  const text = normaliseCommand(command);
  const shape = commandShape(text);
  return {
    kind: String(kind ?? ''),
    // The SHAPE is what the engine keys a grant by, and what decides whether
    // a grant answers a call — so the stored argument is the shape too. The
    // fingerprint is the exact command the grant was given for; it is what a
    // person reads to see WHICH command it was, and it is not what decides:
    // a grant on `npm test` has to cover `npm test -- --watch`, or every
    // spelling of the same command would need its own grant.
    arg: shape,
    head: shape,
    fingerprint: commandFingerprint(text),
  };
}

/** Two grants are the same grant: the same call, answered the same way. */
const sameGrant = (a, b) => a.kind === b.kind && a.arg === b.arg
  && (a.fingerprint ?? null) === (b.fingerprint ?? null);

/**
 * Whether a grant already answered this call.
 *
 * @param {Array<object>} grants the persisted grants of one project — the
 *   `grants` array of `RulesStore.forRoot(root)`
 * @param {string} kind the call's kind ('run', 'write', 'replace', ...)
 * @param {string} [arg] the call's argument — the path a write names
 * @param {string} [body] the call's body — the command line a RUN names
 * @returns {boolean} true when a grant answers this call
 *
 * A path-shaped kind is answered by a grant of the same kind for the same
 * path, exactly as it always was.
 *
 * A shell kind is answered ONLY by a grant that carries the command's shape:
 * the same command line. The command is read from `body` when it is there
 * and from `arg` when it is not — a RUN's argument is empty by protocol, so
 * the engine may hand the command over as either one. A grant written before
 * that shape existed — the constant `run:` every RUN shared — answers
 * nothing, because "always, for every command that would ever run" is not
 * an answer anybody gave. The safe reading of an old blanket grant is "ask
 * again".
 *
 * A grant that names no kind at all answers nothing either: it is not an
 * answer to a call that was never made.
 */
export function grantCovers(grants, kind, arg = '', body = '') {
  const list = Array.isArray(grants) ? grants : [];
  const want = String(kind ?? '');
  if (SHELL_KINDS.has(want.toLowerCase())) {
    const command = grantCommand(want, arg, body);
    if (!command) return false;
    // The shape decides: the same command line, or it is another command.
    // Both sides are reduced to their shape first, so a grant written in the
    // older shape (the whole command in its argument) and one written now
    // (the shape itself) answer the same call the same way.
    const shape = commandShape(command);
    if (!shape) return false;
    return list.some((g) => {
      if (!isGrant(g)) return false;
      if (String(g.kind).toLowerCase() !== want.toLowerCase()) return false;
      return commandShape(g.arg) === shape;
    });
  }
  return list.some((g) => isGrant(g) && g.kind !== '' && g.kind === want && g.arg === String(arg ?? ''));
}

/** The per-project record, replaced when the file holds something else there. */
const entryOf = (data, key) => (data.projects[key] && typeof data.projects[key] === 'object' && !Array.isArray(data.projects[key])
  ? data.projects[key]
  : (data.projects[key] = {}));

export class RulesStore {
  // The default honours AIPASS_HOME like every other surface: a test run must
  // not read - let alone write - the configuration of whoever is using the app
  // right now.
  constructor(file = path.join(aipassHome(), 'rules.json')) {
    this.file = file;
  }

  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { projects: {} };
      // `projects` must be a plain object: a hand-edited file with a string
      // there used to crash the writer below (cannot create a property on a
      // primitive) the moment the next "always" answer tried to save. The
      // reader already refused to trust it; the shape is repaired once, for
      // both.
      const projects = parsed.projects && typeof parsed.projects === 'object' && !Array.isArray(parsed.projects)
        ? parsed.projects
        : {};
      return { ...parsed, projects };
    } catch {
      return { projects: {} }; // missing or unreadable is the normal first-run case
    }
  }

  save(data) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    // Temp file plus rename: a crash mid-save leaves the previous rules — the
    // whole file used to be overwritten in place, so one bad moment lost
    // every project's rules AND grants, and the app asked for them all again.
    writeFileAtomic(this.file, JSON.stringify(data, null, 2) + '\n');
  }

  forRoot(root) {
    const entry = this.load().projects[path.resolve(root)];
    if (!entry || typeof entry !== 'object') return { rules: [], grants: [] };
    return {
      rules: Array.isArray(entry.rules) ? entry.rules.filter(isRule) : [],
      grants: cleanGrants(entry.grants),
    };
  }

  /**
   * Add one "always" grant for a project and write the file through.
   *
   * `body` is the command line of a shell grant: a RUN's argument is empty
   * by protocol, so without it every shell grant would be the same grant.
   */
  addGrant(root, kind, arg = '', body = '') {
    const grant = makeGrant(kind, arg, body);
    if (!isGrant(grant)) return;
    const data = this.load();
    const key = path.resolve(root);
    const entry = entryOf(data, key);
    entry.grants = cleanGrants(entry.grants);
    if (entry.grants.some((g) => sameGrant(g, grant))) return;
    entry.grants.push(grant);
    this.save(data);
  }

  /** Replace the persisted rules of a project (the UI's editor writes here). */
  setRules(root, rules) {
    const data = this.load();
    const key = path.resolve(root);
    const entry = entryOf(data, key);
    entry.rules = (Array.isArray(rules) ? rules : []).filter(isRule);
    if (!entry.rules.length && !entry.grants?.length) delete data.projects[key];
    this.save(data);
  }

  /**
   * Re-key one project's rules and grants to a new absolute root — the half
   * of a folder move the file cannot do by itself, because the key IS the
   * path. Anything already stored at the destination is merged into, never
   * replaced: both projects' rules were real. Returns what moved.
   */
  moveRoot(from, to) {
    const data = this.load();
    const oldKey = path.resolve(from);
    const newKey = path.resolve(to);
    if (oldKey === newKey) return { rules: 0, grants: 0 };
    const entry = data.projects[oldKey];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return { rules: 0, grants: 0 };
    const rules = Array.isArray(entry.rules) ? entry.rules.filter(isRule) : [];
    const grants = cleanGrants(entry.grants);
    const dest = entryOf(data, newKey);
    const mergedRules = Array.isArray(dest.rules) ? dest.rules.filter(isRule) : [];
    for (const rule of rules) {
      if (!mergedRules.some((r) => JSON.stringify(r) === JSON.stringify(rule))) mergedRules.push(rule);
    }
    const mergedGrants = cleanGrants(dest.grants);
    for (const grant of grants) {
      if (!mergedGrants.some((g) => sameGrant(g, grant))) mergedGrants.push(grant);
    }
    dest.rules = mergedRules;
    dest.grants = mergedGrants;
    if (!mergedRules.length && !mergedGrants.length) delete data.projects[newKey];
    delete data.projects[oldKey];
    this.save(data);
    return { rules: rules.length, grants: grants.length };
  }
}
