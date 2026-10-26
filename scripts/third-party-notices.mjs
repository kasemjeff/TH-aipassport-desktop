#!/usr/bin/env node
// Generate the Rust third-party list in THIRD_PARTY_NOTICES.md.
//
// This is a release-time step, not a CI step: it needs Cargo and the crate
// metadata, and it should be run on the release commit so the list matches the
// binary that ships. It writes name, version, SPDX expression and repository
// for every package in desktop/src-tauri/Cargo.toml.
//
//   npm run notices:rust
//
// The full license texts remain the responsibility of the release engineer;
// the generated list names the SPDX expression and the repository so the texts
// can be collected. See docs/RELEASE.md.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(repo, 'THIRD_PARTY_NOTICES.md');
const manifest = path.join(repo, 'desktop', 'src-tauri', 'Cargo.toml');
const begin = '<!-- BEGIN GENERATED RUST -->';
const end = '<!-- END GENERATED RUST -->';

let metadata;
try {
  const raw = execFileSync('cargo', [
    'metadata', '--format-version', '1', '--no-deps', '--manifest-path', manifest,
  ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  metadata = JSON.parse(raw);
} catch (err) {
  console.error('notices:rust: cargo metadata failed.');
  console.error('This step needs Cargo and the Rust toolchain. Install Rust, then run it again.');
  console.error(String(err.message ?? err));
  process.exit(1);
}

const escape = (value) => String(value ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
const packages = (metadata.packages ?? [])
  .slice()
  .sort((a, b) => a.name.localeCompare(b.name) || String(a.version).localeCompare(String(b.version)));

const lines = [
  begin,
  `Generated from \`desktop/src-tauri/Cargo.toml\` on ${new Date().toISOString().slice(0, 10)}.`,
  '',
  '| crate | version | license | repository |',
  '|---|---|---|---|',
  ...packages.map((p) => `| ${escape(p.name)} | ${escape(p.version)} | ${escape(p.license ?? 'see repository')} | ${escape(p.repository ?? '')} |`),
  '',
  `_${packages.length} package(s). Regenerate with \`npm run notices:rust\` before every release._`,
  end,
].join('\n');

const text = fs.readFileSync(target, 'utf8');
const start = text.indexOf(begin);
const stop = text.indexOf(end);
if (start < 0 || stop < 0 || stop < start) {
  console.error('notices:rust: the generated markers are missing from THIRD_PARTY_NOTICES.md');
  process.exit(1);
}
const next = `${text.slice(0, start)}${lines}${text.slice(stop + end.length)}`;
fs.writeFileSync(target, next);
console.log(`notices:rust: wrote ${packages.length} package(s) to THIRD_PARTY_NOTICES.md`);
