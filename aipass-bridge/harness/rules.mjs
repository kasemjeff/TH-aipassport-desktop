// Persisted permission rules and "always" grants, per project.
//
// One JSON file (default ~/.aipass/rules.json) keyed by project root:
//
//   { "/home/me/project": {
//       "rules":  [{ "pattern": "src/**", "decision": "allow", "kinds": ["write"] }],
//       "grants": [{ "kind": "write", "arg": "src/config.ts" }]
//   } }
//
// "Always" answers used to die with the process, which made the desktop ask
// the same question on every run; now they survive a restart. The engine does
// not change — this is only where its rules and grants are seeded from, and
// the write-through hook for new grants.
//
// The file is trusted the way settings.json is: it lives in the user's home,
// the agent's tools cannot reach outside the project root, and anything in it
// that does not parse as a rule or grant is skipped rather than loaded.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const isRule = (r) => r && typeof r === 'object'
  && typeof r.pattern === 'string' && r.pattern
  && (r.decision === 'allow' || r.decision === 'deny')
  && (r.kinds === undefined || (Array.isArray(r.kinds) && r.kinds.every((k) => typeof k === 'string')));

const isGrant = (g) => g && typeof g === 'object'
  && typeof g.kind === 'string' && typeof g.arg === 'string';

export class RulesStore {
  constructor(file = path.join(os.homedir(), '.aipass', 'rules.json')) {
    this.file = file;
  }

  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return parsed && typeof parsed === 'object' && parsed.projects ? parsed : { projects: {} };
    } catch {
      return { projects: {} }; // missing or unreadable is the normal first-run case
    }
  }

  save(data) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(data, null, 2) + '\n');
  }

  forRoot(root) {
    const entry = this.load().projects[path.resolve(root)];
    if (!entry || typeof entry !== 'object') return { rules: [], grants: [] };
    return {
      rules: Array.isArray(entry.rules) ? entry.rules.filter(isRule) : [],
      grants: Array.isArray(entry.grants) ? entry.grants.filter(isGrant) : [],
    };
  }

  /** Add one "always" grant for a project and write the file through. */
  addGrant(root, kind, arg = '') {
    if (!isGrant({ kind, arg })) return;
    const data = this.load();
    const key = path.resolve(root);
    const entry = data.projects[key] ?? (data.projects[key] = {});
    entry.grants = Array.isArray(entry.grants) ? entry.grants.filter(isGrant) : [];
    if (entry.grants.some((g) => g.kind === kind && g.arg === arg)) return;
    entry.grants.push({ kind, arg });
    this.save(data);
  }

  /** Replace the persisted rules of a project (the UI's editor writes here). */
  setRules(root, rules) {
    const data = this.load();
    const key = path.resolve(root);
    const entry = data.projects[key] ?? (data.projects[key] = {});
    entry.rules = (Array.isArray(rules) ? rules : []).filter(isRule);
    if (!entry.rules.length && !entry.grants?.length) delete data.projects[key];
    this.save(data);
  }
}
