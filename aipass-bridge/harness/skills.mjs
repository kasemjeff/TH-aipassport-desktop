// The playbook library — plain markdown files the model loads on demand.
//
// One file per playbook part, read verbatim and clipped. The folders are read
// on every call, so a part dropped in while the app is open is there the next
// time anyone asks; a missing folder degrades to a one-line message instead
// of failing the run.
//
// A folder may ship an `index.md` — a person's description of what each
// playbook is FOR. It is a preamble, not the index: the list of what is
// actually on disk is generated and always follows it.
//
// Search order: the folders a person wrote into settings (`skillsDirs`), then
// the project (`.aipass/skills` under the root), the user (`~/.aipass/skills`),
// then the repo default shipped next to the CLI. An explicit `--skills`
// replaces the list entirely, which is how the original
// single-folder behaviour stays byte-identical.
import fs from 'node:fs';
import path from 'node:path';
import { aipassHome } from './settings.mjs';

export const SKILL_NAME = /^[a-z0-9][a-z0-9-]*$/i;

/**
 * The one search order every surface uses.
 *
 * The window and the CLI used to disagree about where a configured folder
 * sits — the window put `skillsDirs` first, the CLI put them last — so a name
 * that lived in two libraries loaded a different file depending on who asked.
 * A configured folder is a deliberate choice, so it wins; the project's own
 * library is the most specific of the rest, then the user's, then the shipped
 * defaults.
 */
export function skillDirsFor({ root = process.cwd(), repoDir = null, configured = [] } = {}) {
  const project = path.join(root, '.aipass', 'skills');
  const user = path.join(aipassHome(), 'skills');
  const dirs = [...configured, project, user, ...(repoDir ? [repoDir] : [])].filter(Boolean);
  // The configured folders are named, the two known ones are named after
  // their role: a label that lies about where a playbook lives is how the
  // model decides which copy wins.
  const roles = {};
  for (const dir of configured) roles[path.resolve(dir)] = 'configured';
  roles[path.resolve(project)] = 'project';
  roles[path.resolve(user)] = 'user';
  return { dirs, roles };
}

export class SkillLibrary {
  constructor(dirs = [], { maxResult = 3000, roles = null } = {}) {
    this.dirs = [...new Set(dirs.map((d) => path.resolve(d)))].filter((d) => fs.existsSync(d));
    this.maxResult = maxResult;
    // dir → 'project' | 'user', keyed by path, for the generated index's
    // source labels. Keyed by path, not by position: a workspace with no
    // `.aipass/skills` of its own used to relabel the user's library as the
    // project's (any first-existing-dir assumption does exactly that).
    this.roles = new Map(Object.entries(roles ?? {}).map(([dir, role]) => [path.resolve(dir), role]));
  }

  /**
   * The folders a person wrote into settings.
   *
   * Read from the file rather than from a live Settings object, so a library
   * built outside the backend (the CLI's harness) sees the same set the
   * window does — the settings file is the one source of truth both write.
   */
  static configuredDirs() {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(aipassHome(), 'settings.json'), 'utf8'));
      const dirs = Array.isArray(raw?.skillsDirs) ? raw.skillsDirs : [];
      return dirs.filter((d) => typeof d === 'string' && d.trim());
    } catch {
      return [];
    }
  }

  static default({ root = process.cwd(), repoDir = null, extra = [], configured = null } = {}) {
    const { dirs, roles } = skillDirsFor({
      root,
      repoDir,
      configured: [...(configured ?? SkillLibrary.configuredDirs()), ...extra],
    });
    return new SkillLibrary(dirs, { roles });
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
        if (fs.existsSync(file)) {
          return { name, file, dir, role: this.roles.get(dir) ?? 'built-in', bytes: fs.statSync(file).size };
        }
      }
      return { name, file: null, dir: null, role: null, bytes: 0 };
    });
  }

  has(name) { return this.list().some((s) => s.name === name); }

  /**
   * The curated preamble, when a folder ships one.
   *
   * `index.md` is a person's description of what each playbook is FOR. It is
   * prose, so it cannot be trusted to stay in step with the files on disk.
   */
  #curated() {
    for (const dir of this.dirs) {
      const file = path.join(dir, 'index.md');
      if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').trim();
    }
    return '';
  }

  /** The names that are actually on disk, with the library each came from. */
  #render(items) {
    if (this.dirs.length === 1) return items.map((s) => s.name).join('\n');
    const label = (dir) => this.roles.get(dir) ?? 'built-in';
    return items.map((s) => `${s.name}  (${label(s.dir)})`).join('\n');
  }

  /**
   * The text the model sees for `SKILL list`.
   *
   * The curated `index.md` and the generated list are both here, in that
   * order: the prose says what a playbook is for, the list says what the
   * folders hold. The curated file used to BE the index, so a part added
   * yesterday stayed invisible until someone remembered to edit the prose —
   * a playbook that exists but is never named is a playbook that never runs.
   */
  index() {
    const curated = this.#curated();
    const items = this.list();
    if (!items.length) return curated || 'the skills library folder is missing or empty.';
    const generated = this.#render(items);
    if (!curated) return generated;
    // The list is what must survive the clip: it names the files the model
    // can load. The prose around it is a preamble, so it gives way first.
    const room = this.maxResult - generated.length - 2;
    if (room <= 0) return generated;
    const head = curated.length > room ? `${curated.slice(0, room)}\n…` : curated;
    return `${head}\n\n${generated}`;
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

/* -------------------------------------------------------- installing a part */

/** The most one playbook may weigh — the same cap a window's file open has. */
const MAX_SKILL_BYTES = 1_000_000;

/**
 * The library a person may install into, by name. Only the two known ones are
 * writable: a configured folder is somebody else's decision, and the repo's
 * defaults are code — neither is where a paste from the window should land.
 */
export function skillTargetDir(root, target) {
  if (target === 'project') return path.join(root, '.aipass', 'skills');
  if (target === 'user') return path.join(aipassHome(), 'skills');
  return null;
}

/** The one name check install and remove share. The whitelist is the safety:
 *  no slash, no dot, no space — a name cannot carry a path out of its folder. */
function validateSkillName(name) {
  const bare = String(name ?? '').trim();
  if (!bare) throw new Error('which skill name?');
  // Both are the library's own furniture: `list` is the index word, `index.md`
  // is the curated preamble and is skipped by every listing — a part under
  // either name could be read but never seen.
  if (/^(list|index)$/i.test(bare)) throw new Error(`"${bare}" is reserved by the library — pick another name`);
  if (!SKILL_NAME.test(bare)) throw new Error(`not a skill name: ${bare} — letters, digits and dashes only`);
  return bare;
}

/** CRLF is Windows' habit, not the format's: normalize, and end with a newline. */
function normalizeSkillText(text) {
  const body = String(text ?? '').replace(/\r\n/g, '\n');
  if (!body.trim()) throw new Error('the playbook is empty — paste some markdown or pick a file first');
  if (Buffer.byteLength(body, 'utf8') > MAX_SKILL_BYTES) {
    throw new Error(`the playbook is too big — one playbook is capped at ${MAX_SKILL_BYTES} bytes`);
  }
  return body.endsWith('\n') ? body : `${body}\n`;
}

/**
 * Install one playbook from a person's paste or file into a writable library.
 *
 * Replacing an existing playbook needs `overwrite` — the call that would
 * silently drop someone's edits is the one that must come back and say so.
 */
export async function installSkill({ root, name, text, target = 'user', overwrite = false } = {}) {
  const bare = validateSkillName(name);
  const body = normalizeSkillText(text);
  const dir = skillTargetDir(root, target);
  if (!dir) throw new Error(`target must be "user" or "project", not ${JSON.stringify(target)}`);
  const file = path.join(dir, `${bare}.md`);
  const existed = fs.existsSync(file);
  if (existed && !overwrite) {
    throw new Error(`skill ${bare} already exists in the ${target} library — send overwrite to replace it`);
  }
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(file, body, 'utf8');
  return { name: bare, file, dir, target, overwritten: existed };
}

/**
 * Remove a playbook this person installed. Only the user and project
 * libraries are writable, so a name that resolves from somewhere else is
 * refused with the place it actually loads from — a remove that lies about
 * having worked is how a playbook the model still loads gets called gone.
 */
export async function removeSkill({ root, name, target = 'user' } = {}) {
  const bare = validateSkillName(name);
  const dir = skillTargetDir(root, target);
  if (!dir) throw new Error(`target must be "user" or "project", not ${JSON.stringify(target)}`);
  const file = path.join(dir, `${bare}.md`);
  if (!fs.existsSync(file)) {
    const elsewhere = SkillLibrary.default({ root }).list().find((s) => s.name === bare);
    throw new Error(elsewhere?.file
      ? `${bare} is not in the ${target} library — it loads from ${elsewhere.file}`
      : `no skill ${bare} in the ${target} library`);
  }
  await fs.promises.rm(file);
  return { name: bare, file, target, removed: true };
}
