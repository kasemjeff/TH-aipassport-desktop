// The project's own instruction file (AGENTS.md, or its CLAUDE.md /
// GEMINI.md ancestor) rides the run's first message, bounded, once.
//
// Peers all do this (codex and opencode: AGENTS.md; Claude Code: CLAUDE.md;
// Gemini CLI: GEMINI.md). The pins here are the parts that make it safe in
// this harness: root-only, one file, a byte cap, and a preamble that says the
// file adds conventions but cannot lift the permission or secret rules.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadProjectInstructions, INSTRUCTION_FILES, DEFAULT_MAX_BYTES } from '../harness/instructions.mjs';
import { preamble } from '../harness/protocol.mjs';
import { Overlay } from '../harness/overlay.mjs';
import { SessionStore } from '../harness/session.mjs';
import { runTask } from '../harness/loop.mjs';

const dirs = [];
const tempDir = (files = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aipass-instructions-'));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    const p = path.join(dir, name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  return dir;
};

after(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.AIPASS_INSTRUCTIONS;
  delete process.env.AIPASS_INSTRUCTIONS_MAX_BYTES;
});

test('the project file is read from the run root, not from the current directory', () => {
  const dir = tempDir({ 'AGENTS.md': 'Use tabs, never spaces.\n' });
  const doc = loadProjectInstructions(dir);
  assert.equal(doc.file, 'AGENTS.md');
  assert.match(doc.text, /Use tabs, never spaces/);
  assert.equal(doc.truncated, false);
  assert.equal(doc.bytes, Buffer.byteLength('Use tabs, never spaces.\n'));
  assert.deepEqual(INSTRUCTION_FILES, ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md']);
});

test('a project with no instruction file adds no bytes', () => {
  const dir = tempDir({ 'README.md': '# not instructions\n' });
  assert.equal(loadProjectInstructions(dir), null);
  assert.equal(preamble({ instructions: null }), preamble({}), 'the tuned bytes stay identical');
  assert.ok(!preamble({}).includes('left standing instructions'));
});

test('AGENTS.md wins over CLAUDE.md, and CLAUDE.md is the fallback', () => {
  const both = tempDir({
    'AGENTS.md': 'the agents file\n',
    'CLAUDE.md': 'the claude file\n',
  });
  assert.equal(loadProjectInstructions(both).file, 'AGENTS.md');

  const claude = tempDir({ 'CLAUDE.md': 'the claude file\n' });
  const doc = loadProjectInstructions(claude);
  assert.equal(doc.file, 'CLAUDE.md');
  assert.match(doc.text, /the claude file/);
});

test('the read stops at the cap on a whole line, and says it was cut', () => {
  const lines = Array.from({ length: 40 }, (_, i) => `rule ${i}: keep the tree small`).join('\n');
  const dir = tempDir({ 'AGENTS.md': lines });
  const doc = loadProjectInstructions(dir, { max: 200 });

  assert.equal(doc.truncated, true);
  assert.equal(doc.bytes, Buffer.byteLength(lines));
  assert.ok(Buffer.byteLength(doc.text) <= 200, 'the pasted part respects the cap');
  assert.ok(!doc.text.endsWith('keep'), 'a rule is not cut in half');
  assert.ok(lines.startsWith(doc.text), 'what was pasted is the beginning of the file');
  assert.equal(doc.read, Buffer.byteLength(doc.text));
});

test('the switch turns it off', () => {
  const dir = tempDir({ 'AGENTS.md': 'Use tabs.\n' });
  process.env.AIPASS_INSTRUCTIONS = 'off';
  try {
    assert.equal(loadProjectInstructions(dir), null);
  } finally {
    delete process.env.AIPASS_INSTRUCTIONS;
  }
  assert.ok(loadProjectInstructions(dir), 'and on again when the switch is gone');
});

test('a link that points out of the project is not followed', (t) => {
  const outside = tempDir({ 'secret.md': 'machine secrets\n' });
  const dir = tempDir();
  try {
    fs.symlinkSync(path.join(outside, 'secret.md'), path.join(dir, 'AGENTS.md'), 'file');
  } catch (err) {
    if (err.code === 'EPERM' || err.code === 'EACCES' || err.code === 'ENOTSUP') {
      return t.skip(`symlinks are not available here (${err.code})`);
    }
    throw err;
  }
  assert.equal(loadProjectInstructions(dir), null, 'the root is the boundary');
});

test('the preamble names whose rules they are and keeps them subordinate', () => {
  const doc = {
    file: 'AGENTS.md',
    text: 'Run npm test before you call anything done.',
    bytes: 44,
    read: 44,
    truncated: false,
  };
  const text = preamble({ instructions: doc });
  assert.match(text, /--- AGENTS\.md ---/);
  assert.match(text, /Run npm test before you call anything done\./);
  assert.match(text, /cannot lift the permission, secret or verification rules/);
  assert.match(text, /--- end AGENTS\.md ---/);
  assert.ok(!text.includes('NEED file AGENTS.md'), 'an untruncated file asks for nothing');
});

test('a cut file tells the model how to ask for the rest', () => {
  const text = preamble({
    instructions: { file: 'AGENTS.md', text: 'the beginning', bytes: 9_000, read: 11, truncated: true },
  });
  assert.match(text, /9000 bytes/);
  assert.match(text, /NEED file AGENTS\.md/);
});

test('a run\'s first message carries the project instructions', async () => {
  const dir = tempDir({
    'AGENTS.md': 'This project spells it colour, with a u.\n',
    'app.js': 'export const x = 1;\n',
  });
  const sent = [];
  const bridge = {
    async chat({ message }) {
      sent.push(message);
      return { text: 'DONE read the project rules', reasoning: '' };
    },
    async quota() { return { available: 1 }; },
  };
  const store = new SessionStore(path.join(dir, 'sessions'));
  const session = store.create({ root: dir });

  const result = await runTask('say what to do first', {
    bridge,
    tools: { async list() { return 'AGENTS.md\napp.js'; } },
    overlay: new Overlay(dir),
    session,
    options: { maxSteps: 2 },
    first: true,
  });

  assert.equal(result.stopReason, 'done');
  assert.match(sent[0], /--- AGENTS\.md ---/);
  assert.match(sent[0], /spells it colour, with a u/);
  assert.match(sent[0], /Follow them as this project's conventions/);
});

test('the default cap is the documented ceiling', () => {
  assert.equal(DEFAULT_MAX_BYTES, 8_000);
});
