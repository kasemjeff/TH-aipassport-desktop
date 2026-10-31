// symbols.mjs — a zero-dependency, regex-based code navigator.
//
// No LSP, no tree-sitter, no native binary: every symbol is found by a
// per-language regular expression over the source text, and the index is a
// JSON file under ~/.aipass/symbols/<project-hash>.json, refreshed when a
// file's mtime changes. It is deliberately approximate — a real language
// server wins on precision — but it is always available, offline, and adds
// no dependency. The three markers it backs (SYMBOLS, DEF, REFS) give the
// model the navigation a grep alone cannot: "where is X defined", "where is
// X used", "what does this file declare".
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { aipassHome } from './settings.mjs';
import { writeFileAtomic } from './atomic-write.mjs';
import { isNoisePath } from './overlay.mjs';

const EXT_LANG = {
  '.js': 'js', '.mjs': 'js', '.cjs': 'js', '.jsx': 'js',
  '.ts': 'ts', '.tsx': 'ts', '.mts': 'ts', '.cts': 'ts',
  '.py': 'py', '.pyi': 'py',
  '.go': 'go',
  '.rs': 'rs',
  '.java': 'java', '.kt': 'java', '.kts': 'java', '.scala': 'java',
  '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.cc': 'cpp', '.cxx': 'cpp',
  '.hpp': 'cpp', '.hh': 'cpp',
  '.rb': 'rb', '.php': 'php', '.swift': 'swift', '.dart': 'dart',
  '.cs': 'cs', '.lua': 'lua', '.sh': 'sh', '.bash': 'sh',
};

function langOf(file) { return EXT_LANG[path.extname(file).toLowerCase()] || 'generic'; }

const PATTERNS = {
  js: [
    { kind: 'class', re: /^\s*(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/ },
    { kind: 'function', re: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/ },
    { kind: 'const', re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/ },
    { kind: 'const', re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?[A-Za-z_$][\w$]*\s*=>/ },
    { kind: 'const', re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*class\b/ },
  ],
  py: [
    { kind: 'class', re: /^\s*class\s+([A-Za-z_]\w*)/ },
    { kind: 'function', re: /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/ },
  ],
  go: [
    { kind: 'function', re: /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/ },
    { kind: 'type', re: /^\s*type\s+([A-Za-z_]\w*)/ },
    { kind: 'const', re: /^\s*const\s+([A-Za-z_]\w*)/ },
    { kind: 'var', re: /^\s*var\s+([A-Za-z_]\w*)/ },
  ],
  rs: [
    { kind: 'function', re: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/ },
    { kind: 'struct', re: /^\s*(?:pub(?:\([^)]*\))?\s+)?struct\s+([A-Za-z_]\w*)/ },
    { kind: 'enum', re: /^\s*(?:pub(?:\([^)]*\))?\s+)?enum\s+([A-Za-z_]\w*)/ },
    { kind: 'trait', re: /^\s*(?:pub(?:\([^)]*\))?\s+)?trait\s+([A-Za-z_]\w*)/ },
    { kind: 'const', re: /^\s*(?:pub(?:\([^)]*\))?\s+)?const\s+([A-Za-z_]\w*)/ },
    { kind: 'type', re: /^\s*(?:pub(?:\([^)]*\))?\s+)?type\s+([A-Za-z_]\w*)/ },
  ],
  java: [
    { kind: 'class', re: /^\s*(?:public|private|protected|static|abstract|final|\s)+class\s+([A-Za-z_]\w*)/ },
    { kind: 'interface', re: /^\s*(?:public|private|protected|static|abstract|final|\s)+interface\s+([A-Za-z_]\w*)/ },
    { kind: 'method', re: /^\s*(?:public|private|protected|static|abstract|final|synchronized|\s)+(?:[\w<>\[\],\s]+)\s+([A-Za-z_]\w*)\s*\(/ },
  ],
  rb: [
    { kind: 'class', re: /^\s*class\s+([A-Za-z_]\w*)/ },
    { kind: 'module', re: /^\s*module\s+([A-Za-z_]\w*)/ },
    { kind: 'method', re: /^\s*def\s+(?:self\.)?([A-Za-z_]\w*[!?=]?)/ },
  ],
  php: [
    { kind: 'class', re: /^\s*(?:abstract\s+|final\s+)?class\s+([A-Za-z_]\w*)/ },
    { kind: 'function', re: /^\s*(?:public|private|protected|static|\s)*function\s+([A-Za-z_]\w*)/ },
  ],
  swift: [
    { kind: 'class', re: /^\s*(?:public|private|internal|open|final|\s)*class\s+([A-Za-z_]\w*)/ },
    { kind: 'struct', re: /^\s*(?:public|private|internal|\s)*struct\s+([A-Za-z_]\w*)/ },
    { kind: 'function', re: /^\s*(?:public|private|internal|\s)*func\s+([A-Za-z_]\w*)/ },
    { kind: 'enum', re: /^\s*(?:public|private|internal|\s)*enum\s+([A-Za-z_]\w*)/ },
    { kind: 'protocol', re: /^\s*(?:public|private|internal|\s)*protocol\s+([A-Za-z_]\w*)/ },
  ],
  dart: [
    { kind: 'class', re: /^\s*class\s+([A-Za-z_]\w*)/ },
  ],
  cs: [
    { kind: 'class', re: /^\s*(?:public|private|protected|internal|static|abstract|sealed|partial|\s)+class\s+([A-Za-z_]\w*)/ },
    { kind: 'interface', re: /^\s*(?:public|private|protected|internal|\s)+interface\s+([A-Za-z_]\w*)/ },
    { kind: 'struct', re: /^\s*(?:public|private|protected|internal|\s)+struct\s+([A-Za-z_]\w*)/ },
  ],
  lua: [
    { kind: 'function', re: /^\s*(?:local\s+)?function\s+([A-Za-z_]\w*)/ },
  ],
  sh: [
    { kind: 'function', re: /^\s*(?:function\s+)?([A-Za-z_]\w*)\s*\(\)\s*\{/ },
  ],
  c: [
    { kind: 'struct', re: /^\s*(?:typedef\s+)?struct\s+([A-Za-z_]\w*)/ },
    { kind: 'enum', re: /^\s*(?:typedef\s+)?enum\s+([A-Za-z_]\w*)/ },
    { kind: 'function', re: /^\s*(?:static\s+)?(?:[\w*]+\s+)+([A-Za-z_]\w*)\s*\(/ },
  ],
};
PATTERNS.ts = PATTERNS.js;

function extractJsMethods(lines, out) {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!/^\s{2,}/.test(line)) continue;
    const m = line.match(/^\s+(?:async\s+|static\s+|get\s+|set\s+)?([A-Za-z_$][\w$]*)\s*\(/);
    if (!m) continue;
    const name = m[1];
    if (['if', 'for', 'while', 'switch', 'catch', 'constructor'].includes(name)) continue;
    out.push({ name, kind: 'method', line: i + 1 });
  }
}

function extractGeneric(lines) {
  const out = [];
  const re = /^\s*(?:export\s+)?(?:async\s+)?(?:function|class|def|fn|func|struct|interface|type|enum|trait|const|let|var)\s+([A-Za-z_]\w*)/;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(re);
    if (m) out.push({ name: m[1], kind: 'symbol', line: i + 1 });
  }
  return out;
}

export function extractSymbols(text, file) {
  const lang = langOf(file);
  const pats = PATTERNS[lang];
  const lines = text.split('\n');
  const out = [];
  if (!pats) return extractGeneric(lines);
  for (let i = 0; i < lines.length; i++) {
    for (const { kind, re } of pats) {
      const m = lines[i].match(re);
      if (m && m[1]) { out.push({ name: m[1], kind, line: i + 1 }); break; }
    }
  }
  if (lang === 'js' || lang === 'ts') extractJsMethods(lines, out);
  const seen = new Set();
  return out.filter((s) => { const k = s.name + ':' + s.line; if (seen.has(k)) return false; seen.add(k); return true; });
}

function projectHash(root) { return crypto.createHash('sha1').update(path.resolve(root)).digest('hex').slice(0, 12); }
// The index lives under the state home, and the home is read at call time —
// like every other surface here. AIPASS_HOME can be pointed elsewhere after
// this module is loaded (a test does exactly that), and a module-level
// capture would write the index into the real ~/.aipass instead.
//
// The index names every source file and every symbol in the project: it is
// the user's code, spelled out. The folder and the file are owner-only where
// the OS has modes, like the session store and the credentials file.
function indexDir() {
  const dir = path.join(aipassHome(), 'symbols');
  try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch {}
  // The mode is set on creation and pinned again afterwards: a directory
  // that was already there keeps the permissions it had. Windows has no
  // POSIX modes, so the chmod is best effort there.
  try { fs.chmodSync(dir, 0o700); } catch { /* windows has no POSIX modes */ }
  return dir;
}
function indexPath(root) { return path.join(indexDir(), projectHash(root) + '.json'); }

function loadIndex(root) {
  try {
    const raw = fs.readFileSync(indexPath(root), 'utf8');
    const data = JSON.parse(raw);
    if (data && data.root === path.resolve(root) && data.files) return data;
  } catch {}
  return { root: path.resolve(root), files: {} };
}

// The swap is atomic, so a crash cannot leave a half-written index behind:
// a broken index reads as "nothing indexed" and the project is re-read. The
// mode is pinned on the new file, so the index is the owner's alone.
function saveIndex(root, idx) {
  // No index, no write: `JSON.stringify(undefined)` is undefined, and
  // writeFileSync would throw on it - a throw swallowed by the catch below,
  // so the index silently never landed and every run re-read the project.
  if (!idx) return;
  try { writeFileAtomic(indexPath(root), JSON.stringify(idx), { mode: 0o600 }); } catch {}
}

const SKIP_DIRS = new Set(['node_modules', '.git', '.aipass', 'dist', 'build', 'coverage', '.next', 'target', 'vendor']);

function walkFiles(root, dir = root, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      const rel = path.relative(root, full).replace(/\\/g, '/');
      if (isNoisePath(rel)) continue;
      walkFiles(root, full, out);
    } else if (e.isFile()) {
      const ext = path.extname(e.name).toLowerCase();
      if (EXT_LANG[ext]) out.push(path.relative(root, full).replace(/\\/g, '/'));
    }
  }
  return out;
}

export function indexProject(root) {
  const idx = loadIndex(root);
  const files = walkFiles(root);
  const fileSet = new Set(files);
  for (const f of Object.keys(idx.files)) if (!fileSet.has(f)) delete idx.files[f];
  for (const rel of files) {
    const full = path.join(root, rel);
    let st;
    try { st = fs.statSync(full); } catch { continue; }
    const prev = idx.files[rel];
    if (prev && prev.mtime === st.mtimeMs) continue;
    let text = '';
    try { text = fs.readFileSync(full, 'utf8'); } catch { continue; }
    idx.files[rel] = { mtime: st.mtimeMs, symbols: extractSymbols(text, rel) };
  }
  saveIndex(root, idx);
  return idx;
}

export function listSymbols(root, file) {
  const idx = indexProject(root);
  const rel = path.isAbsolute(file) ? path.relative(root, file).replace(/\\/g, '/') : file.replace(/\\/g, '/');
  const entry = idx.files[rel];
  if (!entry) return [];
  return entry.symbols;
}

export function findDefinition(root, name) {
  const idx = indexProject(root);
  const out = [];
  for (const [file, entry] of Object.entries(idx.files)) {
    for (const s of entry.symbols) {
      if (s.name === name) out.push({ file, line: s.line, kind: s.kind, name: s.name });
    }
  }
  return out;
}

export function findReferences(root, name) {
  const idx = indexProject(root);
  const re = new RegExp('\\b' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'g');
  const out = [];
  for (const rel of Object.keys(idx.files)) {
    const full = path.join(root, rel);
    let text;
    try { text = fs.readFileSync(full, 'utf8'); } catch { continue; }
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      re.lastIndex = 0;
      if (re.test(lines[i])) out.push({ file: rel, line: i + 1, snippet: lines[i].trim().slice(0, 120) });
    }
  }
  return out;
}

export function formatSymbols(syms) {
  if (!syms.length) return '(no symbols found)';
  return syms.map((s) => `${s.line}: ${s.kind} ${s.name}`).join('\n');
}

export function formatDefs(defs) {
  if (!defs.length) return 'err: no definition found';
  return defs.map((d) => `${d.file}:${d.line}  ${d.kind} ${d.name}`).join('\n');
}

export function formatRefs(refs, cap = 60) {
  if (!refs.length) return '(no references found)';
  const shown = refs.slice(0, cap);
  const more = refs.length > cap ? `\n… ${refs.length - cap} more` : '';
  return shown.map((r) => `${r.file}:${r.line}: ${r.snippet}`).join('\n') + more;
}
