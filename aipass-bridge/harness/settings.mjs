// Settings â€” one JSON file, everything the window and the CLI share.
//
// It lives at `~/.aipass/settings.json` on purpose: the CLI, the backend and
// every future surface read the same file, so a change made in the window is
// true in the terminal without a sync step. Nothing here is a secret; the
// bridge's cookie never leaves the browser, and no credential belongs in this
// file.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DEFAULT_MODEL_BUDGETS } from './compact.mjs';
import { writeFileAtomic } from './atomic-write.mjs';
import { formatLogLine } from './log-line.mjs';

/**
 * Where the app's state lives, whichever surface is asking.
 *
 * `AIPASS_HOME` is the override, and it exists for one reason: a test run must
 * not write the user's real settings, sessions or plugins. A suite that resets
 * the live file eats the configuration of whoever is using the app right now.
 */
export const aipassHome = () => process.env.AIPASS_HOME?.trim() || path.join(os.homedir(), '.aipass');

/**
 * The shipped per-run budgets. `loop.mjs` and `harness.mjs` import these for
 * their option fallbacks, so the settings file is the one place the numbers
 * live; changing one here changes every surface.
 */
export const DEFAULT_MAX_TOOL_CALLS = 300;
export const DEFAULT_MAX_WALL_CLOCK_MS = 1_800_000;

/**
 * The moments a hook may be bound to.
 *
 * A hook is a command line the PERSON configured (harness/hooks.mjs). The
 * first three cover a change and a commit; the six added in wave 3.4 are the
 * lifecycle — what a person wants before a call runs, every time a task is
 * sent, and across a compaction. The list lives here because the settings file
 * owns the shape of a setting, and the hook runner reads the shape from here.
 */
export const HOOK_MOMENTS = [
  'sessionStart', 'promptSubmit', 'beforeTool', 'afterTool',
  'afterWrite', 'beforeCommit', 'preCompact', 'done', 'stop',
];

/**
 * The hooks a settings file holds, in the one shape the harness reads.
 *
 * A moment is a string or a list of strings, and the LIST is the chain: each
 * entry is one command, run on its own, in order. Anything that is not a
 * command line is dropped rather than stored — a hook that cannot run is a
 * setting that looks like protection and is not.
 *
 * @param {any} value what the settings file held
 * @returns {Record<string, string[]>}
 */
export function normalizeHooks(value) {
  const out = {};
  for (const moment of HOOK_MOMENTS) out[moment] = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const moment of HOOK_MOMENTS) {
    const raw = value[moment];
    const list = Array.isArray(raw) ? raw : (raw == null ? [] : [raw]);
    const commands = [];
    for (const item of list) {
      if (typeof item !== 'string') continue;
      const text = item.trim();
      // A long command line is a script pasted into a setting; the cap keeps
      // the file readable and the argument list sane.
      if (!text || text.length > 300) continue;
      if (commands.includes(text)) continue;
      commands.push(text);
      if (commands.length >= 10) break;
    }
    out[moment] = commands;
  }
  return out;
}

export const DEFAULTS = {
  // the model a new run starts on; the window can still switch per session
  defaultModel: null,
  // which provider the runs talk to: 'aipass' (the local bridge and its tab)
  // or an id from ~/.aipass/providers.json. The provider itself — its
  // endpoint, its protocol and where its key comes from — lives in that file
  // and nowhere else, so this stays a single word.
  defaultProvider: 'aipass',
  // who may write: 'ask' (confirm every change), 'auto' (the old --apply),
  // 'yolo' (writes and shell both go through)
  mode: 'ask',
  allowRun: false,
  // May the model run git's WRITE side (stage, commit, branch)? Off by
  // default: a run that can write files is one thing, a run that can rewrite
  // the project's history is another, and the person who turns this on is the
  // one who decides that. A git write still rides the permission gate as a
  // write, so 'ask' asks before it happens.
  allowGitWrite: false,
  // May the model ask for a check (the VERIFY marker)? Off by default, because
  // the check runs a command and a command is the shell gate: the person
  // decides whether the model may run one on its own.
  allowVerify: false,
  // The step cap one run may spend, or 0 for no cap: the run goes until DONE,
  // a guard stops it, or a budget below is spent. A positive cap is 1..200.
  maxSteps: 0,
  // Per-run budgets, checked by the loop and recorded as stop reasons in
  // run_stats: the most tool calls one run may execute, and its wall-clock
  // ceiling in ms. Generous by design â€” they catch a runaway reply (a hundred
  // markers in one message) or a stuck command, not ordinary work. A zero or
  // nonsense value falls back to the default; there is no off switch.
  maxToolCalls: DEFAULT_MAX_TOOL_CALLS,
  maxWallClockMs: DEFAULT_MAX_WALL_CLOCK_MS,
  // The optional credit cap: stop a run once observed spend reaches this many
  // credits. 0 (the default) means no cap â€” the one budget with an off switch.
  // Checked against the bridge's cached quota, which upstream refreshes at
  // most every 30s, so it bounds a runaway run without a request per step.
  maxCredits: 0,
  // plan mode: the model writes a PLAN/TODO first, and (optionally) waits for
  // the human to approve before it touches anything
  plan: false,
  requirePlanApproval: false,
  subagent: true,
  // several SUBAGENTs of one reply run beside each other, each in its own
  // conversation. Live-proven 2026-10-16 (two helpers fanned out 3 ms apart,
  // two borrowed temporary conversations, both generations accepted at once),
  // so the window ships it on; the CLI keeps its explicit --parallel-helpers.
  parallelHelpers: true,
  // consecutive read-only calls of one reply (NEED/SEARCH/TREE/STAT/GLOB and
  // friends) run beside each other. Reads cannot see different states, so
  // this changes wall time, not semantics — the results still come back in
  // marker order. False keeps the old serial walk.
  parallelReads: true,
  // how hard the model thinks before each step: off | low | medium | high |
  // max. It rides every send as `thinking_level`; the bridge drops a level the
  // chosen model does not advertise, so the setting never breaks a run.
  thinking: 'low',
  // Sampling temperature, or null to leave it to the site's per-model
  // default. The OpenAI range 0..2: 0 is as deterministic as the model can be,
  // 2 as varied as it gets. It rides every send as `temperature` when set,
  // and the site ignores a field it does not know — nothing breaks when it
  // does, the run just stays at the default.
  temperature: null,
  // (Thai pack) The reply language and its stop hook. Tool vocabulary stays
  // English whatever this says; the check measures the closing message's Thai
  // share (letters only, code and URLs excluded) and asks for a rewrite once.
  replyLanguage: 'th',
  langCheck: true,
  minThaiRatio: 0.4,
  // (Thai pack) Refuse an identical tool call repeated with nothing staged in
  // between; the third is answered with advice, and a run that collects more
  // than repeatGuardMax refusals stops as stalled.
  repeatGuard: true,
  repeatGuardMax: 4,
  // how many times the window may re-run a task whose checker reports the
  // staged tree still failing. 1 = never retry; each attempt costs a full run.
  attempts: 1,
  // (docs/SPEC_CHECKER.md) The declared check: one command that replaces the
  // project's `.aipass/check.txt` for every run on this machine, so a verdict
  // carries the command it is about; and the strict gate that refuses a DONE
  // while that check is failing. Null/false keeps the checker advisory.
  verifyCommand: null,
  requireCheck: false,
  // per-tool result cap in bytes; 0 is normalised to this default. spill keeps
  // the rest on disk, so raising it cuts round trips without losing data.
  maxResult: 3000,
  // when the context budget is close to full, summarise and rotate
  compaction: { contextTokens: 24_000, reserveTokens: 4_096, keepRecentBytes: 6_000, budgets: DEFAULT_MODEL_BUDGETS },
  // rotate at this share of the budget. The upstream keeps its own history and
  // cannot be trimmed, so waiting until the budget is nearly spent means the
  // last stretch of a run is spent re-sending a context that no longer fits.
  compactAtPercent: 40,
  // where the playbooks are looked up, in order; first match wins
  skillsDirs: [],
  // projects the window offers, most recent first: [{name, path}]
  projects: [],
  // the root a new backend starts on
  root: null,
  // plugins to load, by name, from ~/.aipass/plugins
  plugins: [],
  // permission path rules, checked before the mode: [{pattern, decision, kinds?}]
  // â€” `docs/** â†’ allow` stops a run asking about its own docs, `.env* â†’ deny`
  // keeps secrets out of every mode including yolo. First match wins.
  rules: [],
  // theme: 'dark' | 'light' | follow the system with 'auto'
  theme: 'dark',
  // where the chat tab lives, and whether a run that needs one opens it itself
  chatUrl: 'https://de.aipass.net/chat',
  autoOpenTab: true,
  // What the run's preamble may offer: the case-insensitive SEARCH, the
  // ATTACH of a file that is not plain text, and the scratch conversation
  // for a web question. All three default to false — the harness's own
  // defaults (harness/harness.mjs), which is where the values come from.
  // They were missing here, and the applier in rpc.mjs reads all three: a
  // key that is not there reads as `undefined`, and that overwrote the
  // harness default with nothing.
  searchI: false,
  attach: false,
  webScratch: false,
  // A fetch the model chose is a question the person sees — unless the
  // machine has been told to let it through. The window asks (and says
  // where); the CLI's `--allow-fetch` says yes on the command line.
  allowFetch: false,
  // where staged uploads wait before they are sent
  uploads: null,
  // The person's own commands, at the points that matter (harness/hooks.mjs).
  // A hook is a command line the person configured — not one the model
  // chose — bound to a moment: after a change is staged, before a commit
  // goes through, and when a run ends. Each moment is a string or a list of
  // strings, and the list is the chain: each entry is ONE command.
  hooks: { afterWrite: [], beforeCommit: [], done: [] },
  // May the model look into this project's past? The RECALL marker reads the
  // project's own sessions and answers with what was said — a read of the
  // person's own history, and the only way "what did we decide yesterday?"
  // gets an answer. It is a read, not a power, so it is on by default; the
  // switch is here for a project whose past nobody wants in the model's
  // context.
  recall: true,
  // TREE and STAT (and LIST -l): the preamble teaches the shape-of-the-folder
  // markers when this is on. A read, not a power — the tools answer the same
  // err:/confine rules either way; the switch only decides whether the model
  // is told they exist.
  explore: true,
  // (helper presets) The machine's own SUBAGENT roles, beside the three
  // built-ins: a map of name → { lead, run }. `lead` is the helper's own
  // instructions; `run` (default false) says the helper may run commands —
  // and still only where the run itself was given allowRun, so a preset can
  // never widen the run's powers. Built-in names (verifier, reviewer,
  // summariser) cannot be shadowed; a malformed entry is an error at the
  // helper, named, never a silent fallback.
  helperPresets: {},
};

/**
 * The options one run is built from.
 *
 * One shape, one owner: the harness fills it, the loop reads it, and the
 * settings file decides what most of it says. The typedef lives here because
 * this file is where the numbers live — a JSDoc block in `harness.mjs` that
 * listed a third of the keys is what let `this.options.model` be read from an
 * object that never had one.
 *
 * @typedef {object} HarnessOptions
 * @property {string|null} [model]            the model a run starts on
 * @property {number} [maxSteps]              the step cap; 0 = no cap
 * @property {number} [maxToolCalls]          the tool-call budget of one run
 * @property {number} [maxWallClockMs]        the wall-clock budget of one run
 * @property {number} [maxCredits]            the optional credit cap; 0 = off
 * @property {string} [mode]                  'ask' | 'auto' | 'yolo'
 * @property {boolean} [allowRun]             may the run reach the shell
 * @property {boolean} [allowFetch]           may the run send data out
 * @property {boolean} [allowGitWrite]        may the run stage, commit, branch
 * @property {boolean} [allowVerify]          may the run ask for a check
 * @property {boolean} [plan]                 plan mode
 * @property {boolean} [requirePlanApproval]  wait for a human before the work
 * @property {boolean} [subagent]             may the run call a helper
 * @property {boolean} [parallelHelpers]      may helpers run beside each other
 * @property {boolean} [parallelReads]        may consecutive reads run beside each other
 * @property {boolean} [searchI]              the case-insensitive SEARCH
 * @property {boolean} [attach]               the ATTACH of a non-text file
 * @property {boolean} [webScratch]           the scratch conversation
 * @property {boolean} [recall]               may the model look into the past
 * @property {boolean} [explore]              may the preamble teach TREE/STAT
 * @property {string|null} [conversation]     the conversation to send into
 * @property {boolean} [reuse]                reuse the bridge's conversation
 * @property {boolean} [permanent]            keep the conversation afterwards
 * @property {string|null} [assistant]        the assistant persona to run as
 * @property {string|null} [verifyCommand]    the declared check (docs/SPEC_CHECKER.md)
 * @property {boolean} [requireCheck]         the strict DONE gate
 * @property {string|null} [thinking]         'off' | 'low' | … | 'max'
 * @property {number|null} [temperature]      0..2, or null for the site's own
 * @property {'th'|'en'} [replyLanguage]      the language the reply is in
 * @property {boolean} [langCheck]            measure the closing message
 * @property {number} [minThaiRatio]          the share of Thai letters asked for
 * @property {boolean} [repeatGuard]          refuse an identical call
 * @property {number} [repeatGuardMax]        refusals one run may collect
 * @property {boolean} [slim]                 the compact first message
 * @property {string|null} [seedText]         the seed of a rotated conversation
 * @property {Array} [pluginTools]            the plugin markers this run may use
 * @property {Array} [pluginSections]         the plugin blocks the turn-1 message carries
 * @property {Object<string, {lead: string, run: string}>} [helperPresets] the machine's own SUBAGENT roles
 * @property {AbortSignal|null} [signal]      the run's stop switch
 * @property {Array|null} [parts]             the attachments of the first send
 */

/**
 * The shipped defaults for a run's options.
 *
 * The numbers come from the settings file, so the shipped setting and the
 * fallback can never drift apart — the same promise `DEFAULTS` makes for the
 * file itself. Everything the loop clamps lives here too: `harness.mjs` and
 * `loop.mjs` read one sheet, so a key cannot be defaulted in one place and
 * read in another.
 */
export const HARNESS_OPTION_DEFAULTS = Object.freeze({
  // the model a run starts on; the window can still switch per session
  model: null,
  // the step cap: 0 = no cap, the run goes until DONE, a guard or a budget
  maxSteps: 0,
  // the per-run budgets — the real bound once the step cap is off
  maxToolCalls: DEFAULT_MAX_TOOL_CALLS,
  maxWallClockMs: DEFAULT_MAX_WALL_CLOCK_MS,
  maxCredits: 0,
  // who may write, and who may reach the shell
  mode: 'ask',
  allowRun: false,
  allowFetch: false,
  // The write side of git and the VERIFY marker: both are powers a run is
  // GIVEN, never powers it takes. Off by default; the person turns them on.
  allowGitWrite: false,
  allowVerify: false,
  // plan mode: the model writes a plan first, and waits for the human
  plan: false,
  requirePlanApproval: false,
  // A review run: read a change and report findings, stage nothing. It is not
  // a saved setting — a run is given it (the window's /review, the CLI's
  // --review) and the next run is ordinary again — so it lives on the run's
  // own sheet and not in DEFAULTS.
  review: false,
  reviewBase: null,
  // helpers: one at a time, or several beside each other
  subagent: false,
  parallelHelpers: false,
  // consecutive read-only calls in one reply run beside each other. Reads
  // cannot see different states, so this changes wall time, not semantics;
  // results and events stay in marker order.
  parallelReads: true,
  // what the preamble may offer the model
  searchI: false,
  attach: false,
  webScratch: false,
  // the RECALL marker: the model may ask what this project said before
  recall: true,
  // TREE and STAT (and LIST -l): the preamble teaches them when this is on
  explore: true,
  // the conversation the run sends into
  conversation: null,
  reuse: false,
  permanent: false,
  assistant: null,
  // the declared check and the strict DONE gate
  verifyCommand: null,
  requireCheck: false,
  // how hard the model thinks, and how varied the answer is
  thinking: null,
  temperature: null,
  // the reply-language policy: the preamble says which language, the hook
  // measures the closing message
  replyLanguage: 'th',
  langCheck: false,
  minThaiRatio: 0.4,
  // the pre-tool guards
  repeatGuard: false,
  repeatGuardMax: 4,
  // the compact first message, and the seed of a rotated conversation
  slim: false,
  seedText: null,
  pluginTools: [],
  // What a plugin contributed to the run's first message, and the machine's
  // own helper roles beside SUBAGENT_ROLES. Wiring, not settings: the values
  // arrive through the option sheet so the run reads one object.
  pluginSections: [],
  helperPresets: {},
  // the run's own switch, and the parts its first message carries
  signal: null,
  parts: null,
});

/**
 * One option sheet: the shipped defaults, with what the caller passed on top.
 *
 * A key whose value is `undefined` counts as "not said" and keeps the
 * default — the alternative is a sheet where `maxToolCalls: undefined` reads
 * as "no budget" and a run stops before its first step.
 *
 * @param {Partial<HarnessOptions>} [overrides]
 * @returns {HarnessOptions}
 */
export function harnessOptions(overrides = {}) {
  const out = { ...HARNESS_OPTION_DEFAULTS };
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * The safety floor under every mode: a MUTATION of a file a build resolves
 * through is asked about before anything changes, because that mistake is
 * invisible until something else breaks (a dependency silently floats, a
 * tsconfig stops being the tuned one, a lockfile drifts from the manifest).
 *
 * Deliberately NOT part of DEFAULTS.rules: the settings list is the user's
 * editable one, and folding these into it would duplicate them into the file
 * on every save (Settings.set writes every key) and freeze a copy there. The
 * engine checks them after the user's own rules, so an explicit rule wins,
 * and only for mutation kinds â€” opening package.json is how the model answers
 * most questions, and a question per read would make the tool unusable.
 *
 * Each name appears twice: a nested pattern keeps its leading `**` and a
 * separator, so it cannot also match the top-level spelling â€” each is a
 * pattern of its own (globMatch has no implicit prefix).
 */
const MUTATIONS = ['write', 'replace', 'delete', 'move'];
const asks = (pattern) => ({ pattern, decision: 'ask', kinds: MUTATIONS });
export const SAFETY_RULES = [
  asks('package.json'), asks('**/package.json'),
  asks('tsconfig*.json'), asks('**/tsconfig*.json'),
  asks('.*rc*'), asks('**/.*rc*'),
  asks('package-lock.json'), asks('**/package-lock.json'),
  asks('yarn.lock'), asks('**/yarn.lock'),
  asks('pnpm-lock.yaml'), asks('**/pnpm-lock.yaml'),
];

/**
 * The secret floor: files that must never reach the model without an explicit
 * human override, in ANY mode including yolo. Unlike SAFETY_RULES (mutation
 * kinds only) these carry no `kinds`, so they match reads too â€” NEED/CREATE
 * with a .env path is denied before the mode is consulted.
 *
 * Each name appears twice (top-level plus a nested `**`-prefixed spelling)
 * because globMatch has no implicit prefix. Sources: OWASP Logging Cheat
 * Sheet (never log secrets) + common secret-file layouts (.env, cloud creds,
 * private keys).
 */
const denys = (pattern) => ({ pattern, decision: 'deny' });
export const SECRET_RULES = [
  denys('.env*'), denys('**/.env*'),
  denys('*.pem'), denys('**/*.pem'),
  denys('*.key'), denys('**/*.key'),
  denys('*.p12'), denys('**/*.p12'),
  denys('*.pfx'), denys('**/*.pfx'),
  denys('id_rsa*'), denys('**/id_rsa*'),
  denys('id_ed25519*'), denys('**/id_ed25519*'),
  denys('*.jks'), denys('**/*.jks'),
  denys('credentials.json'), denys('**/credentials.json'),
  denys('secrets.json'), denys('**/secrets.json'),
  denys('.aws/**'), denys('**/.aws/**'),
  denys('.gnupg/**'), denys('**/.gnupg/**'),
  denys('**/*.har'),
  denys('apipass*.md'), denys('**/apipass*.md'),
  denys('aipass*.md'), denys('**/aipass*.md'),
];

/**
 * The keys that must never enter a settings object.
 *
 * `__proto__` is the one that bites. `JSON.parse` puts it in as an own
 * property, and `Object.assign(target, settings)` copies own properties with
 * a SET — the inherited `__proto__` setter then replaces the target's
 * prototype. So a settings file (or an RPC payload) carrying
 * `{"compaction": {"__proto__": {...}}}` could hand every consumer of a
 * `Settings` object an object whose prototype somebody else chose, and the
 * next `Object.assign` in the chain would copy the injected keys onto it.
 * `constructor` and `prototype` are the other two names a merge walks into.
 *
 * The rule is therefore not "the prototype must not change" — that is what
 * the spread and the clone already guarantee — but "the key must not be
 * there at all", because the key is what a later `Object.assign` acts on.
 */
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Every dangerous key, at every depth, gone. */
function stripDangerousKeys(value, depth = 0) {
  if (depth > 12 || !value || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    for (const item of value) stripDangerousKeys(item, depth + 1);
    return value;
  }
  for (const key of Object.keys(value)) {
    if (DANGEROUS_KEYS.has(key)) {
      // The OWN property, never the inherited one: `delete` on a name the
      // object does not own would be a no-op, and going through the setter
      // would be worse than the thing we are removing.
      Reflect.deleteProperty(value, key);
      continue;
    }
    stripDangerousKeys(value[key], depth + 1);
  }
  return value;
}

export class Settings {
  /**
   * @param {string} [dir] where the file lives; defaults to `aipassHome()`
   * @param {string} [file] the file's name inside that directory
   * @param {Function} [log] where a problem with the file is reported; the
   *   default writes one line to stderr, so a broken file is never silent
   */
  constructor(dir = aipassHome(), file = 'settings.json', log = null) {
    this.dir = dir;
    this.file = path.join(dir, file);
    this.log = typeof log === 'function'
      ? log
      : (text) => console.error(formatLogLine({ level: 'warn', msg: text }));
    this.values = structuredClone(DEFAULTS);
    // What the last load found wrong, newest last. The window can read it;
    // the logger says it out loud.
    this.problems = [];
    this.reload();
  }

  /** A problem with the settings file, said once and kept. */
  #problem(text) {
    this.problems.push(text);
    try { this.log(text); } catch { /* a logger must not break the load */ }
  }

  /**
   * Read the file again and adopt what it says.
   *
   * A file that is not there is the normal first run: the defaults are the
   * answer and there is nothing to report. A file that IS there and cannot
   * be read — or cannot be parsed — is a problem, and it is reported: both
   * were swallowed alike, so a corrupted file looked exactly like an empty
   * one and the app went quietly back to `mode: 'ask'` with no rules, as if
   * the person had never set anything. The safe defaults still apply; they
   * are just no longer the only thing that happened.
   */
  reload() {
    this.problems = [];
    let raw;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch (err) {
      if (err?.code !== 'ENOENT') {
        this.#problem(`the settings file ${this.file} cannot be read (${err?.code ?? err?.message}) — the defaults are in use`);
      }
      this.values = structuredClone(DEFAULTS);
      return this.values;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      this.#problem(`the settings file ${this.file} is not valid JSON (${err?.message}) — the defaults are in use`);
      this.values = structuredClone(DEFAULTS);
      return this.values;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      this.#problem(`the settings file ${this.file} is not a settings object — the defaults are in use`);
      this.values = structuredClone(DEFAULTS);
      return this.values;
    }
    this.values = Settings.sane({ ...structuredClone(DEFAULTS), ...parsed, compaction: { ...DEFAULTS.compaction, ...(parsed.compaction ?? {}) } });
    return this.values;
  }

  /**
   * Back to the shipped defaults, written through the same atomic path as `set`.
   *
   * `root` and `projects` are deliberately kept: resetting the form should not
   * teleport the user out of the folder they are working in.
   */
  reset() {
    const keep = { root: this.values.root, projects: this.values.projects };
    const next = Settings.sane({ ...structuredClone(DEFAULTS), ...keep });
    fs.mkdirSync(this.dir, { recursive: true });
    // The shared atomic swap, not a copy of it: a second copy of a swap is a
    // second copy that can disagree with the first about what "atomic" means.
    writeFileAtomic(this.file, JSON.stringify(next, null, 2) + '\n');
    this.values = next;
    return next;
  }

  /**
   * Clamp the values that can silently break a run.
   *
   * A negative or unparsable step count is the case that justifies this: it
   * used to reach the loop and stop a run before its first step â€” the window
   * accepted the message and answered nothing, no error anywhere. Zero no
   * longer belongs in that family (it means "no cap" by design), so only the
   * values that break a run are clamped here â€” the one place the CLI, the
   * window and any future surface all write through.
   */
  static sane(values) {
    const next = structuredClone(values);
    // The dangerous keys go first, before anything reads a value out of the
    // object: the sanitiser is the one place every surface writes through,
    // so a settings file and an RPC payload are both clean by the time any
    // consumer can see them.
    stripDangerousKeys(next);
    const num = (v, min, max, fallback) => {
      const n = Number(v);
      if (!Number.isFinite(n)) return fallback;
      return Math.min(max, Math.max(min, Math.round(n)));
    };
    // 0 is the deliberate escape the step cap has: no cap at all, with the
    // budgets below as the only bound. A positive count is a cap within 1..200;
    // a negative or unparsable one falls back to the default (no cap).
    const steps = Number(next.maxSteps);
    next.maxSteps = Number.isFinite(steps) && steps >= 0
      ? Math.min(200, Math.round(steps))
      : DEFAULTS.maxSteps;
    // The per-run budgets follow the step limit's rule; a zero or nonsense
    // value means "use the default" rather than "instantly stop the run".
    const toolCalls = Number(next.maxToolCalls);
    next.maxToolCalls = Number.isFinite(toolCalls) && toolCalls > 0
      ? Math.min(10_000, Math.max(1, Math.round(toolCalls))) : DEFAULTS.maxToolCalls;
  const maxResult = Number(next.maxResult);
  next.maxResult = Number.isFinite(maxResult) && maxResult >= 500
    ? Math.min(100_000, Math.max(500, Math.round(maxResult))) : DEFAULTS.maxResult;
    const wallClock = Number(next.maxWallClockMs);
    next.maxWallClockMs = Number.isFinite(wallClock) && wallClock > 0
      ? Math.min(86_400_000, Math.max(10_000, Math.round(wallClock))) : DEFAULTS.maxWallClockMs;
    // The credit cap's rule differs on purpose: 0 is a real value (no cap),
    // not a value to replace with a default.
    const creditCap = Number(next.maxCredits);
    next.maxCredits = Number.isFinite(creditCap) && creditCap > 0
      ? Math.min(10_000_000, Math.round(creditCap)) : 0;
    // An unknown thinking level would reach the bridge and come back stripped,
    // which reads as "thinking is on" in the form and "off" in the run. The
    // one place every surface writes keeps the two equal.
    if (!['off', 'low', 'medium', 'high', 'max'].includes(next.thinking)) next.thinking = DEFAULTS.thinking;
    // temperature: null is "whatever the server defaults to" — the one "not
    // set" value every surface agrees on. A number (or a numeric string,
    // which is what a select's value is) is clamped to the OpenAI range 0..2;
    // anything else falls back to the default rather than riding a request.
    const rawTemperature = next.temperature;
    const parsedTemperature = rawTemperature == null || rawTemperature === ''
      ? null
      : (typeof rawTemperature === 'number' || (typeof rawTemperature === 'string' && rawTemperature.trim() !== ''))
        ? Number(rawTemperature) : null;
    next.temperature = parsedTemperature !== null && Number.isFinite(parsedTemperature)
      ? Math.min(2, Math.max(0, Math.round(parsedTemperature * 100) / 100)) : null;
    // (Thai pack) The language keys follow the thinking level's rule: a value
    // nobody recognises becomes the default instead of reaching a run.
    if (!['th', 'en'].includes(next.replyLanguage)) next.replyLanguage = DEFAULTS.replyLanguage;
    const ratio = Number(next.minThaiRatio);
    next.minThaiRatio = Number.isFinite(ratio)
      ? Math.min(1, Math.max(0, Math.round(ratio * 100) / 100)) : DEFAULTS.minThaiRatio;
    next.langCheck = Boolean(next.langCheck);
    // The RECALL marker is a read, and a read is a switch like any other: a
    // settings file that says "true" as a string says no.
    next.recall = Boolean(next.recall);
    next.repeatGuard = Boolean(next.repeatGuard);
    next.repeatGuardMax = num(next.repeatGuardMax, 1, 50, DEFAULTS.repeatGuardMax);
    next.attempts = num(next.attempts, 1, 5, DEFAULTS.attempts);
    // The declared check is a command line, and only a command line: a value
    // with a newline would reach the checker prompt as several commands, which
    // is exactly what "comparable across runs" must not allow. First line,
    // trimmed, capped like the checker's own 300-char read.
    next.verifyCommand = typeof next.verifyCommand === 'string' && next.verifyCommand.trim()
      ? next.verifyCommand.split(/\r?\n/)[0].trim().slice(0, 300)
      : null;
    next.requireCheck = Boolean(next.requireCheck);
    // The two new powers are booleans and nothing else: a settings file that
    // says "true" as a string is a file that says no.
    next.allowGitWrite = Boolean(next.allowGitWrite);
    next.allowVerify = Boolean(next.allowVerify);
    // Path rules are policy, and policy that a typo silently disables is worse
    // than no policy: a rule with no pattern would never match anything, and a
    // decision of "yes" would never be honoured by the engine. Both are dropped
    // here rather than stored where they look like protection.
    next.rules = Array.isArray(next.rules)
      ? next.rules
        .filter((r) => r && typeof r.pattern === 'string' && r.pattern.trim())
        .map((r) => ({
          pattern: r.pattern.trim(),
          decision: ['allow', 'deny', 'ask'].includes(r.decision) ? r.decision : 'ask',
          ...(Array.isArray(r.kinds) && r.kinds.length ? { kinds: r.kinds.map(String) } : {}),
        }))
        .slice(0, 100)
      : [];
    // Path-shaped keys are resolved by whoever reads them first â€” the window's
    // project list, the backend's root pick, the uploads staging folder, the
    // skill library's dirs â€” so a wrong-shaped value is not state, it is a
    // crash waiting for the next call. Dropped here, like every other value
    // that cannot work.
    next.root = typeof next.root === 'string' && next.root.trim() ? next.root : null;
    next.projects = Array.isArray(next.projects)
      ? next.projects
        .filter((p) => p && typeof p.path === 'string' && p.path.trim())
        .map((p) => ({
          ...(typeof p.name === 'string' && p.name.trim() ? { name: p.name } : {}),
          path: p.path,
        }))
        .slice(0, 40)
      : [];
    next.uploads = typeof next.uploads === 'string' && next.uploads.trim() ? next.uploads : null;
    next.skillsDirs = Array.isArray(next.skillsDirs)
      ? next.skillsDirs.filter((d) => typeof d === 'string' && d.trim())
      : [];
    next.plugins = Array.isArray(next.plugins)
      ? next.plugins.filter((n) => typeof n === 'string' && n.trim())
      : [];
    // The hooks are commands the person configured, so the file keeps the
    // shape the runner reads: three moments, each a list of command lines.
    // A hand-edited file with anything else in it is normalized here rather
    // than at the moment a hook fires — the same place every other value
    // that cannot work is dropped.
    next.hooks = normalizeHooks(next.hooks);
    if (next.compaction) {
      const budget = num(next.compaction.contextTokens, 1000, 4_000_000, 24_000);
      const reserve = num(next.compaction.reserveTokens, 128, budget - 1, 4_096);
    let budgets = next.compaction.budgets;
    if (!budgets || typeof budgets !== 'object' || Array.isArray(budgets)) budgets = DEFAULT_MODEL_BUDGETS;
    next.compaction = { ...next.compaction, contextTokens: budget, reserveTokens: reserve, budgets };
    }
    const share = Number(next.compactAtPercent);
    if (next.compactAtPercent != null) next.compactAtPercent = Number.isFinite(share) ? Math.min(100, Math.max(5, Math.round(share))) : 40;
    if (next.chatUrl && !/^https?:\/\//.test(String(next.chatUrl))) delete next.chatUrl;
    // The provider id is a word, not a URL: it names a row in the provider
    // registry. An unknown one is kept as it is — the registry is the judge of
    // which ids exist, and a provider that was removed from the file must not
    // make the whole settings file unreadable.
    if (typeof next.defaultProvider !== 'string' || !next.defaultProvider.trim()) {
      next.defaultProvider = DEFAULTS.defaultProvider;
    } else {
      next.defaultProvider = next.defaultProvider.trim();
    }
    return next;
  }

  /** Merge a patch in and write it back. Returns the whole object. */
  set(patch = {}) {
    // The file is the truth, and another surface may have written it since
    // this process last looked: the CLI, a second backend, a backup restored
    // underneath it. Merging into the copy this process happens to hold
    // would write that other change back out unchanged — the window's save
    // would quietly undo it, and a project that had been moved would land
    // back under its old path. So the file is read again before the merge.
    //
    // The window between the read and the write is still open (two surfaces
    // writing at the same moment is a lost update either way), but it is now
    // a moment instead of the whole life of the process.
    this.reload();
    let next = { ...this.values, ...patch };
    if (patch.compaction) next.compaction = { ...this.values.compaction, ...patch.compaction };
    next = Settings.sane(next);
    fs.mkdirSync(this.dir, { recursive: true });
    // The shared atomic swap: a crash mid-write never loses settings, and
    // two writers (this one and a CLI) never share a temp name.
    writeFileAtomic(this.file, JSON.stringify(next, null, 2) + '\n');
    this.values = next;
    return next;
  }

  get(key, fallback = null) {
    return key == null ? this.values : (this.values[key] ?? fallback);
  }

  get dirs() { return this.dir; }

  /** Project list, most recent first, de-duplicated, with a name for each. */
  projectList() {
    const seen = new Set();
    const out = [];
    for (const p of this.values.projects ?? []) {
      if (!p?.path || seen.has(p.path)) continue;
      seen.add(p.path);
      out.push({ name: p.name ?? path.basename(p.path), path: path.resolve(p.path) });
    }
    if (this.values.root) {
      const abs = path.resolve(this.values.root);
      if (!seen.has(abs)) out.unshift({ name: path.basename(abs), path: abs });
    }
    return out;
  }

  /** Remember a project and make it the current root. */
  addProject(projectPath, name = null) {
    // The list is read from the file first: the copy this process holds may
    // be older than a change another surface made to it, and a list built from
    // a stale copy would write that change back out.
    this.reload();
    const abs = path.resolve(projectPath);
    const projects = (this.values.projects ?? []).filter((p) => p.path !== abs);
    projects.unshift({ name: name ?? path.basename(abs), path: abs });
    return this.set({ projects: projects.slice(0, 40), root: abs });
  }

  removeProject(projectPath) {
    this.reload();
    const abs = path.resolve(projectPath);
    const projects = (this.values.projects ?? []).filter((p) => p.path !== abs);
    const root = path.resolve(this.values.root ?? '') === abs ? null : this.values.root;
    return this.set({ projects, root });
  }

  /**
   * Re-key the project list (and the startup root) after a folder moved to a
   * new absolute path. A list entry the person renamed keeps the name they
   * typed; a default name follows the folder. Returns whether anything
   * pointed at the old path at all — a project the list never held has
   * nothing to rewrite here.
   */
  moveProject(from, to) {
    const oldAbs = path.resolve(from);
    const newAbs = path.resolve(to);
    if (oldAbs === newAbs) return false;
    let found = false;
    const projects = (this.values.projects ?? []).map((p) => {
      if (path.resolve(p.path ?? '') !== oldAbs) return p;
      found = true;
      const name = p.name && p.name !== path.basename(oldAbs) ? p.name : path.basename(newAbs);
      return { ...p, name, path: newAbs };
    });
    // root null must not be read as "the current directory": only an actual
    // setting that pointed at the old path moves.
    const root = this.values.root && path.resolve(this.values.root) === oldAbs ? newAbs : this.values.root;
    if (root !== this.values.root) found = true;
    if (!found) return false;
    this.set({ projects, root });
    return true;
  }

  /** Upload staging area: ~/.aipass/uploads by default. */
  uploadDir() {
    const dir = this.values.uploads ?? path.join(this.dir, 'uploads');
    // Owner-only when this call creates it; a directory the user configured
    // already is left exactly as they set it up.
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }
}

export default Settings;
