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

/**
 * Where the app's state lives, whichever surface is asking.
 *
 * `AIPASS_HOME` is the override, and it exists for one reason: a test run must
 * not write the user's real settings, sessions or plugins. A suite that resets
 * the live file eats the configuration of whoever is using the app right now.
 */
export const aipassHome = () => process.env.AIPASS_HOME?.trim() || path.join(os.homedir(), '.aipass');

export const DEFAULTS = {
  // the model a new run starts on; the window can still switch per session
  defaultModel: null,
  // who may write: 'ask' (confirm every change), 'auto' (the old --apply),
  // 'yolo' (writes and shell both go through)
  mode: 'ask',
  allowRun: false,
  maxSteps: 10,
  // plan mode: the model writes a PLAN/TODO first, and (optionally) waits for
  // the human to approve before it touches anything
  plan: false,
  requirePlanApproval: false,
  subagent: true,
  // how hard the model thinks before each step: off | low | medium | high |
  // max. It rides every send as `thinking_level`; the bridge drops a level the
  // chosen model does not advertise, so the setting never breaks a run.
  thinking: 'low',
  // when the context budget is close to full, summarise and rotate
  compaction: { contextTokens: 24_000, reserveTokens: 4_096, keepRecentBytes: 6_000 },
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
   * `maxSteps: 0` is the case that justifies this: the loop exits before its
   * first step, the window accepts the message and answers nothing, and no error
   * appears anywhere. Rather than trusting every caller, the numbers that govern
   * a run are clamped here — the one place the CLI, the window and any future
   * surface all write through.
   */
  static sane(values) {
    const next = structuredClone(values);
    const num = (v, min, max, fallback) => {
      const n = Number(v);
      if (!Number.isFinite(n)) return fallback;
      return Math.min(max, Math.max(min, Math.round(n)));
    };
    next.maxSteps = num(next.maxSteps, 1, 200, 10);
    // An unknown thinking level would reach the bridge and come back stripped,
    // which reads as "thinking is on" in the form and "off" in the run. The
    // one place every surface writes keeps the two equal.
    if (!['off', 'low', 'medium', 'high', 'max'].includes(next.thinking)) next.thinking = DEFAULTS.thinking;
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
    if (next.compaction) {
      const budget = num(next.compaction.contextTokens, 1000, 4_000_000, 24_000);
      const reserve = num(next.compaction.reserveTokens, 128, budget - 1, 4_096);
      next.compaction = { ...next.compaction, contextTokens: budget, reserveTokens: reserve };
    }
    const share = Number(next.compactAtPercent);
    if (next.compactAtPercent != null) next.compactAtPercent = Number.isFinite(share) ? Math.min(100, Math.max(5, Math.round(share))) : 40;
    if (next.chatUrl && !/^https?:\/\//.test(String(next.chatUrl))) delete next.chatUrl;
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

  /** Upload staging area: ~/.aipass/uploads by default. */
  uploadDir() {
    const dir = this.values.uploads ?? path.join(this.dir, 'uploads');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }
}

export default Settings;
