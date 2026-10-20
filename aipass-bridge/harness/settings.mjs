// Settings — one JSON file, everything the window and the CLI share.
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
  // The step cap one run may spend, or 0 for no cap: the run goes until DONE,
  // a guard stops it, or a budget below is spent. A positive cap is 1..200.
  maxSteps: 0,
  // Per-run budgets, checked by the loop and recorded as stop reasons in
  // run_stats: the most tool calls one run may execute, and its wall-clock
  // ceiling in ms. Generous by design — they catch a runaway reply (a hundred
  // markers in one message) or a stuck command, not ordinary work. A zero or
  // nonsense value falls back to the default; there is no off switch.
  maxToolCalls: DEFAULT_MAX_TOOL_CALLS,
  maxWallClockMs: DEFAULT_MAX_WALL_CLOCK_MS,
  // The optional credit cap: stop a run once observed spend reaches this many
  // credits. 0 (the default) means no cap — the one budget with an off switch.
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
  // — `docs/** → allow` stops a run asking about its own docs, `.env* → deny`
  // keeps secrets out of every mode including yolo. First match wins.
  rules: [],
  // theme: 'dark' | 'light' | follow the system with 'auto'
  theme: 'dark',
  // where the chat tab lives, and whether a run that needs one opens it itself
  chatUrl: 'https://de.aipass.net/chat',
  autoOpenTab: true,
  // where staged uploads wait before they are sent
  uploads: null,
};

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
 * and only for mutation kinds — opening package.json is how the model answers
 * most questions, and a question per read would make the tool unusable.
 *
 * Each name appears twice: a nested pattern keeps its leading `**` and a
 * separator, so it cannot also match the top-level spelling — each is a
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
 * kinds only) these carry no `kinds`, so they match reads too — NEED/CREATE
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

export class Settings {
  /** @param {string} [dir] where the file lives; defaults to `aipassHome()` */
  constructor(dir = aipassHome(), file = 'settings.json') {
    this.dir = dir;
    this.file = path.join(dir, file);
    this.values = structuredClone(DEFAULTS);
    this.reload();
  }

  reload() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.values = Settings.sane({ ...structuredClone(DEFAULTS), ...parsed, compaction: { ...DEFAULTS.compaction, ...(parsed.compaction ?? {}) } });
    } catch {
      // Missing or unreadable is the normal first-run case; defaults apply.
    }
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
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n');
    fs.renameSync(tmp, this.file);
    this.values = next;
    return next;
  }

  /**
   * Clamp the values that can silently break a run.
   *
   * A negative or unparsable step count is the case that justifies this: it
   * used to reach the loop and stop a run before its first step — the window
   * accepted the message and answered nothing, no error anywhere. Zero no
   * longer belongs in that family (it means "no cap" by design), so only the
   * values that break a run are clamped here — the one place the CLI, the
   * window and any future surface all write through.
   */
  static sane(values) {
    const next = structuredClone(values);
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
    // Path-shaped keys are resolved by whoever reads them first — the window's
    // project list, the backend's root pick, the uploads staging folder, the
    // skill library's dirs — so a wrong-shaped value is not state, it is a
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
    let next = { ...this.values, ...patch };
    if (patch.compaction) next.compaction = { ...this.values.compaction, ...patch.compaction };
    next = Settings.sane(next);
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n');
    fs.renameSync(tmp, this.file); // atomic: a crash mid-write never loses settings
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
    const abs = path.resolve(projectPath);
    const projects = (this.values.projects ?? []).filter((p) => p.path !== abs);
    projects.unshift({ name: name ?? path.basename(abs), path: abs });
    return this.set({ projects: projects.slice(0, 40), root: abs });
  }

  removeProject(projectPath) {
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
