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
  // when the context budget is close to full, summarise and rotate
  compaction: { contextTokens: 24_000, reserveTokens: 4_096, keepRecentBytes: 6_000 },
  // where the playbooks are looked up, in order; first match wins
  skillsDirs: [],
  // projects the window offers, most recent first: [{name, path}]
  projects: [],
  // the root a new backend starts on
  root: null,
  // plugins to load, by name, from ~/.aipass/plugins
  plugins: [],
  // theme: 'dark' | 'light' | follow the system with 'auto'
  theme: 'dark',
  // where staged uploads wait before they are sent
  uploads: null,
};

export class Settings {
  constructor(dir = path.join(os.homedir(), '.aipass'), file = 'settings.json') {
    this.dir = dir;
    this.file = path.join(dir, file);
    this.values = structuredClone(DEFAULTS);
    this.reload();
  }

  reload() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.values = { ...structuredClone(DEFAULTS), ...parsed, compaction: { ...DEFAULTS.compaction, ...(parsed.compaction ?? {}) } };
    } catch {
      // Missing or unreadable is the normal first-run case; defaults apply.
    }
    return this.values;
  }

  /** Merge a patch in and write it back. Returns the whole object. */
  set(patch = {}) {
    const next = { ...this.values, ...patch };
    if (patch.compaction) next.compaction = { ...this.values.compaction, ...patch.compaction };
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
