#!/usr/bin/env node
// Developer Certificate of Origin check.
//
// Every non-merge commit authored by a human must carry a Signed-off-by
// trailer whose email matches the commit author. Bot commits are exempt so
// Dependabot does not need to learn git etiquette.
//
//   node scripts/dco.mjs
//   DCO_BASE_SHA=<sha> DCO_HEAD_SHA=<sha> node scripts/dco.mjs
//
// With no environment variables, the range is origin/main..HEAD when that
// resolves, otherwise HEAD~1..HEAD. CI passes the pull request's base and head
// explicitly.
import { execFileSync } from 'node:child_process';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();

function resolveRange() {
  const head = process.env.DCO_HEAD_SHA?.trim() || 'HEAD';
  const base = process.env.DCO_BASE_SHA?.trim();
  if (base && !/^0+$/.test(base)) return `${base}..${head}`;
  try {
    const mergeBase = git('merge-base', 'origin/main', head);
    if (mergeBase) return `${mergeBase}..${head}`;
  } catch { /* no origin/main in this checkout */ }
  try {
    git('rev-parse', '--verify', `${head}~1`);
    return `${head}~1..${head}`;
  } catch {
    return head;
  }
}

const range = resolveRange();
let raw = '';
try {
  raw = execFileSync('git', [
    'log', '--no-merges', '--format=%H%x1f%an%x1f%ae%x1f%P%x1f%B%x1e', range,
  ], { encoding: 'utf8' });
} catch (err) {
  console.error(`dco: could not read the commit range "${range}": ${err.message}`);
  process.exit(2);
}

const BOT = /(\[bot\]|dependabot|renovate|github-actions)/i;
const records = raw.split('\x1e').map((s) => s.trim()).filter(Boolean);
const failures = [];
let checked = 0;

for (const record of records) {
  const [sha, name, email, parents, ...bodyParts] = record.split('\x1f');
  const body = bodyParts.join('\x1f');
  if (parents.trim().split(/\s+/).filter(Boolean).length > 1) continue;
  if (BOT.test(name) || BOT.test(email)) continue;
  checked += 1;
  const signoff = body
    .split('\n')
    .map((line) => /^Signed-off-by:\s*(.+?)\s*<([^>]+)>\s*$/i.exec(line.trim()))
    .filter(Boolean)
    .map((m) => ({ name: m[1], email: m[2].toLowerCase() }));
  if (!signoff.some((s) => s.email === email.toLowerCase())) {
    const subject = body.split('\n').find((line) => line && !line.startsWith('Signed-off-by:')) ?? '';
    failures.push({ sha: sha.slice(0, 12), name, email, subject });
  }
}

console.log(`dco: ${checked} human commit(s) checked`);
for (const f of failures) {
  console.log(`  MISSING  ${f.sha}  ${f.name} <${f.email}>  ${f.subject}`);
}
if (failures.length) {
  console.log('\nAdd the trailer with `git commit -s` (or amend: `git commit --amend -s --no-edit`).');
  console.log('The trailer email must match the commit author email. See CONTRIBUTING.md.');
  process.exit(1);
}
console.log('dco: every human commit carries a matching Signed-off-by.');
