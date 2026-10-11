// A small .gitignore reader for the tools that walk the tree (SEARCH, GLOB).
//
// Only the common grammar is honoured — blank lines, `#` comments, `!`
// negation, a trailing `/` for directory-only rules, a leading `/` to anchor
// at the root, and `*`, `?`, `**` in the pattern itself. Nested .gitignore
// files are out of scope on purpose: the root one is where build outputs and
// dependency directories get named, and that is the walk's actual problem.
// SKIP (node_modules, .git, …) still applies before this — gitignore only
// ever narrows further.
import fs from 'node:fs';
import path from 'node:path';

// A gitignore pattern body → regex over a posix relative path. `**` spans
// directories, `*` and `?` never cross a `/`. A pattern with no slash in it
// matches at any depth, as git's would; one with a slash is anchored to the
// root (the leading `/` has already been stripped by the parser).
const ruleRe = (body, anchored) => {
  const src = body
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\u0000\//g, '(?:.*/)?')
    .replace(/\/\u0000/g, '(?:/.*)?')
    .replace(/\u0000/g, '.*');
  return new RegExp(anchored ? `^${src}$` : `^(?:.*/)?${src}$`);
};

export function parseGitignore(text) {
  const rules = [];
  for (const raw of String(text).split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    let negate = false;
    if (line.startsWith('!')) { negate = true; line = line.slice(1); }
    const anchored = line.startsWith('/');
    if (anchored) line = line.slice(1);
    const dirOnly = line.endsWith('/');
    if (dirOnly) line = line.slice(0, -1);
    if (!line) continue;
    rules.push({ negate, dirOnly, re: ruleRe(line, anchored || line.includes('/')) });
  }
  return rules;
}

/** Last matching rule wins, exactly as git reads the file. */
export const ignoredBy = (rules, rel, isDir) => {
  let hit = false;
  for (const r of rules) {
    if (r.dirOnly && !isDir) continue;
    if (r.re.test(rel)) hit = !r.negate;
  }
  return hit;
};

/** Read `<root>/.gitignore` once per walk; a missing or unreadable file ignores nothing. */
export function loadGitignore(root) {
  let rules = [];
  try { rules = parseGitignore(fs.readFileSync(path.join(root, '.gitignore'), 'utf8')); } catch { /* no file, no rules */ }
  return { ignored: (rel, isDir) => ignoredBy(rules, rel, isDir) };
}
