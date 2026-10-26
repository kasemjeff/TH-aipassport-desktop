#!/usr/bin/env node
// Check that relative Markdown links resolve.
//
// External URLs are not fetched: this is a repository-integrity check, not a
// network probe. It catches the links that break when a file moves — the ones
// a reader only discovers after clicking.
//
//   node scripts/link-check.mjs
//
// Rules:
//   - fenced code blocks and inline code are ignored (they contain examples);
//   - http(s), mailto:, tel:, data: and #anchors are ignored;
//   - an anchor on a relative link is ignored for the existence check;
//   - a link containing a placeholder (…, <...>, ${...}) is ignored.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'target', 'sidecar']);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.github') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(full, out);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      out.push(full);
    }
  }
  return out;
}

/** Remove fenced blocks, inline code and HTML comments before looking for links. */
function stripNonMarkdown(text) {
  return text
    .replace(/^```[\s\S]*?^```/gm, '')
    .replace(/^~~~[\s\S]*?^~~~/gm, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/(`+)([^`\n]*?)\1/g, '');
}

/** All Markdown link targets in a file, in source order. */
function linksIn(text) {
  const clean = stripNonMarkdown(text);
  const links = [];
  const re = /!?\[[^\]]*\]\(\s*(<[^>]*>|[^)\s]+)(?:\s+["'][^"']*["'])?\s*\)/g;
  let m;
  while ((m = re.exec(clean))) links.push(m[1].replace(/^<|>$/g, ''));
  return links;
}

function isExternal(target) {
  return /^(https?:|mailto:|tel:|data:|javascript:|#)/i.test(target)
    || target.includes('…')
    || /[<>]|\$\{/.test(target);
}

function checkFile(file) {
  const text = fs.readFileSync(file, 'utf8');
  const broken = [];
  for (const raw of linksIn(text)) {
    if (isExternal(raw)) continue;
    const target = raw.split('#')[0].split('?')[0];
    if (!target) continue;
    const decoded = (() => { try { return decodeURIComponent(target); } catch { return target; } })();
    const resolved = decoded.startsWith('/')
      ? path.join(repo, decoded.slice(1))
      : path.resolve(path.dirname(file), decoded);
    if (!fs.existsSync(resolved)) broken.push({ raw, resolved });
  }
  return broken;
}

const files = walk(repo).sort();
const broken = [];
for (const file of files) {
  for (const hit of checkFile(file)) {
    broken.push({ file: path.relative(repo, file), ...hit });
  }
}

console.log(`docs:check: ${files.length} Markdown files, ${broken.length} broken relative link(s)`);
for (const b of broken) {
  console.log(`  ${b.file} -> ${b.raw}  (resolved: ${path.relative(repo, b.resolved)})`);
}
if (broken.length) {
  console.log('\nFix the link or remove it. Fenced code and inline code are ignored already.');
  process.exit(1);
}
