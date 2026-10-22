// Keeps the agent guide honest: every `Verify: "title"` anchor must name a
// real test, every shim must keep pointing at the canon, and the guide files
// must stay inside their size budgets. Part of the "Rule format & freshness"
// section of AGENTS.md, given teeth.
//
// Run standalone (`npm run agents:lint`) or as part of the suite —
// `test/agents-docs.test.mjs` imports lint() and asserts zero problems.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEST_DIR = path.join(ROOT, 'aipass-bridge', 'test');

/** Guide files that may carry Verify anchors, with their size budgets.
 *  A budget is a ceiling, not a wish: the guide is cut to fit, and the
 *  ceiling goes DOWN when it grows — raising it instead is the thing this
 *  check exists to catch.
 *
 *  `test/CONTRACTS.md` is the INDEX of what the suite holds: it carries the
 *  anchors, one line each, and no prose to speak of. Its budget moves with the
 *  contracts — an index that cannot hold them all would be an index that lies
 *  about what the suite holds — but it stays an index: a line of prose here is
 *  a line of prose that does not belong. */
const GUIDE_FILES = [
  { rel: 'AGENTS.md', budget: 218 },
  { rel: 'aipass-bridge/AGENTS.md', budget: 130 },
  { rel: 'aipass-bridge/test/AGENTS.md', budget: 90 },
  { rel: 'aipass-bridge/test/CONTRACTS.md', budget: 108 },
  { rel: 'desktop/AGENTS.md', budget: 88 },
];

/** Thin shim files for tools that do not read AGENTS.md natively. */
const SHIMS = ['CLAUDE.md', 'GEMINI.md', '.github/copilot-instructions.md'];

const ANCHOR_RE = /^Verify:\s*"([^"]+)"\s*$/;

/**
 * Every title passed to `test(...)` in one file. A quote-aware walker, not a
 * regex on the title itself, because titles carry curly quotes, em-dashes and
 * occasionally escaped quotes.
 */
function testTitlesIn(file) {
  const text = fs.readFileSync(file, 'utf8');
  const titles = new Set();
  const opener = /(?:^|[^\w.])test\s*\(/g; // `test(` but never `myTest(` / `x.test(`
  let m;
  while ((m = opener.exec(text))) {
    let i = m.index + m[0].length;
    while (i < text.length && /\s/.test(text[i])) i++;
    const quote = text[i];
    if (quote !== "'" && quote !== '"' && quote !== '`') continue;
    let out = '';
    for (i++; i < text.length; i++) {
      const c = text[i];
      if (c === '\\') { out += c + (text[i + 1] ?? ''); i++; continue; }
      if (c === quote || c === '\n') break;
      out += c;
    }
    titles.add(out.replace(/\\(['"`])/g, '$1'));
  }
  return titles;
}

/** Returns { anchors, titles, problems } — problems empty means healthy. */
export function lint() {
  const problems = [];

  // 1. Every anchor resolves against a real test title.
  const titles = new Set();
  for (const f of fs.readdirSync(TEST_DIR)) {
    if (f.endsWith('.test.mjs')) {
      for (const t of testTitlesIn(path.join(TEST_DIR, f))) titles.add(t);
    }
  }
  let anchors = 0;
  for (const { rel, budget } of GUIDE_FILES) {
    const file = path.join(ROOT, rel);
    if (!fs.existsSync(file)) { problems.push(`${rel}: missing`); continue; }
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    if (lines.length > budget) problems.push(`${rel}: ${lines.length} lines > budget ${budget}`);
    lines.forEach((line, idx) => {
      const m = ANCHOR_RE.exec(line.trim());
      if (!m) return;
      anchors++;
      if (!titles.has(m[1])) {
        problems.push(`${rel}:${idx + 1}: Verify anchor names no test: "${m[1]}"`);
      }
    });
  }

  // 2. Shims keep pointing at the canon (a shim is optional until its tool is used).
  for (const rel of SHIMS) {
    const file = path.join(ROOT, rel);
    if (!fs.existsSync(file)) continue;
    if (!fs.readFileSync(file, 'utf8').includes('AGENTS.md')) {
      problems.push(`${rel}: shim no longer mentions AGENTS.md`);
    }
  }

  // 3. The machine-local notes stay out of git.
  const ignore = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
  if (!/^AGENTS\.local\.md$/m.test(ignore)) {
    problems.push('.gitignore: AGENTS.local.md is not ignored');
  }

  return { anchors, titles: titles.size, problems };
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const { anchors, titles, problems } = lint();
  if (problems.length) {
    for (const p of problems) console.error(`✗ ${p}`);
    console.error(`agents-lint: ${problems.length} problem(s); ${anchors} anchors checked against ${titles} titles`);
    process.exitCode = 1;
  } else {
    console.log(`agents-lint: ok — ${anchors} Verify anchors resolve against ${titles} test titles`);
  }
}
