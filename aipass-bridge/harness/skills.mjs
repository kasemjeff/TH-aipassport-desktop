// The playbook library — plain markdown files the model loads on demand.
//
// One file per playbook part, read verbatim and clipped. The index is a plain
// file so the library can grow without code changes; a missing folder degrades
// to a one-line message instead of failing the run.
//
// Search order: project (`.aipass/skills` under the root), user
// (`~/.aipass/skills`), then the repo default shipped next to the CLI. An
// explicit `--skills` / `AIPASS_SKILLS_DIR` replaces the list entirely, which is
// how the original single-folder behaviour stays byte-identical.
import fs from 'node:fs';
import path from 'node:path';
import { aipassHome } from './settings.mjs';

export const SKILL_NAME = /^[a-z0-9][a-z0-9-]*$/i;

export class SkillLibrary {
  constructor(dirs = [], { maxResult = 3000 } = {}) {
    this.dirs = [...new Set(dirs.map((d) => path.resolve(d)))].filter((d) => fs.existsSync(d));
    this.maxResult = maxResult;
  }

  static default({ root = process.cwd(), repoDir = null, extra = [] } = {}) {
    const dirs = [
      path.join(root, '.aipass', 'skills'),
      path.join(aipassHome(), 'skills'),
      ...(repoDir ? [repoDir] : []),
      ...extra,
    ].filter(Boolean);
    return new SkillLibrary(dirs);
  }

  /** Where each name resolves from; first match wins, later dirs are fallbacks. */
  list() {
    const names = new Set();
    for (const dir of this.dirs) {
      let entries = [];
      try { entries = fs.readdirSync(dir); } catch { continue; }
      for (const f of entries) {
        if (f.endsWith('.md') && f !== 'index.md') names.add(f.slice(0, -3));
      }
    }
    return [...names].sort().map((name) => {
      for (const dir of this.dirs) {
        const file = path.join(dir, `${name}.md`);
        if (fs.existsSync(file)) return { name, file, dir, bytes: fs.statSync(file).size };
      }
      return { name, file: null, dir: null, bytes: 0 };
    });
  }

  has(name) { return this.list().some((s) => s.name === name); }

  /** The text the model sees for `SKILL list`. */
  index() {
    for (const dir of this.dirs) {
      const file = path.join(dir, 'index.md');
      if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
    }
    const items = this.list();
    if (!items.length) return 'the skills library folder is missing or empty.';
    if (this.dirs.length === 1) return items.map((s) => s.name).join('\n');
    const label = (dir) => (dir === this.dirs[0] ? 'project' : dir === path.join(aipassHome(), 'skills') ? 'user' : 'built-in');
    return items.map((s) => `${s.name}  (${label(s.dir)})`).join('\n');
  }

  clip(s) { return s.length > this.maxResult ? `${s.slice(0, this.maxResult)}\n… truncated` : s; }

  /** Loads one part verbatim. Names are whitelisted, so this is a read-only
   *  window onto the library — never a path traversal. */
  load(name) {
    const bare = String(name || '').trim();
    if (!bare || /^list$/i.test(bare)) return { name: 'list', text: this.clip(this.index()) };
    if (!SKILL_NAME.test(bare)) return { name: bare, error: `no such skill: ${name}. Use SKILL list to see the library.` };
    for (const dir of this.dirs) {
      const file = path.join(dir, `${bare}.md`);
      if (fs.existsSync(file)) {
        return { name: bare, file, text: this.clip(fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')) };
      }
    }
    return { name: bare, error: `no such skill: ${bare}. Use SKILL list to see the library, and load its parts in order.` };
  }
}
