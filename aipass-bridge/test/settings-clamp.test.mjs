// A regression test for the bug that made the window stop answering: a settings
// value that breaks a run is now clamped at the one place all surfaces write.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Settings } from '../harness/settings.mjs';
import { SkillLibrary } from '../harness/skills.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aipass-clamp-'));

test('a value that would break a run is clamped, not stored', () => {
  // A negative step count is the case that justifies this: it would reach the
  // loop and stop a run before its first step. Zero is different — it is the
  // deliberate "no cap" and is stored as written.
  const dir = scratch();
  try {
    const s = new Settings(dir, 'settings.json');
    assert.equal(s.set({ maxSteps: 0 }).maxSteps, 0, 'zero means no cap, by design');
    assert.equal(s.set({ maxSteps: -5 }).maxSteps, 0, 'a negative count falls back to the default (no cap)');
    assert.equal(s.set({ maxSteps: 9_999 }).maxSteps, 200, 'and an absurd one is clamped to the ceiling');
    assert.equal(s.set({ compaction: { contextTokens: 10 } }).compaction.contextTokens, 1000, 'the budget has a floor');
    assert.equal(s.set({ compactAtPercent: 9_999 }).compactAtPercent, 100, 'the rotation share has a ceiling');
    assert.equal(s.set({ thinking: 'banana' }).thinking, 'low', 'an unknown thinking level falls back, never stores');
    assert.equal(s.set({ thinking: 'high' }).thinking, 'high', 'and a real level passes through');
    assert.equal(s.set({ temperature: 0.7 }).temperature, 0.7, 'a real temperature passes through');
    assert.equal(s.set({ temperature: 5 }).temperature, 2, 'an out-of-range temperature is clamped to the ceiling');
    assert.equal(s.set({ temperature: -1 }).temperature, 0, 'a negative temperature is clamped to the floor');
    assert.equal(s.set({ temperature: 'banana' }).temperature, null, 'nonsense falls back to the default, never a request');
    assert.equal(s.set({ temperature: null }).temperature, null, 'null means "the site decides"');
    assert.equal(s.set({ maxToolCalls: 0 }).maxToolCalls, 300, 'zero tool calls means the default, never zero');
    assert.equal(s.set({ maxToolCalls: 25 }).maxToolCalls, 25, 'a real tool-call cap passes through');
    assert.equal(s.set({ maxToolCalls: 9_999_999 }).maxToolCalls, 10_000, 'the tool-call cap has a ceiling');
    assert.equal(s.set({ maxWallClockMs: 1 }).maxWallClockMs, 10_000, 'the wall clock has a ten-second floor');
    assert.equal(s.set({ maxWallClockMs: 'banana' }).maxWallClockMs, 1_800_000, 'nonsense falls back to the default');
    assert.equal('chatUrl' in s.set({ chatUrl: 'javascript:alert(1)' }), false, 'a chat URL must be http(s)');
    // The declared check is one command line: a pasted second line must not
    // reach the checker prompt as another command.
    assert.equal(s.set({ verifyCommand: 'node check.mjs\necho not-a-check' }).verifyCommand, 'node check.mjs');
    assert.equal(s.set({ verifyCommand: '   ' }).verifyCommand, null, 'an empty declared check is "none"');
    assert.equal(s.set({ verifyCommand: 42 }).verifyCommand, null, 'a non-string is not a command');
    assert.equal(s.set({ requireCheck: 1 }).requireCheck, true);
    assert.equal(s.set({ requireCheck: 0 }).requireCheck, false);

    // A hand-edited file is clamped as it is read, not trusted.
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ maxSteps: -1, compaction: { contextTokens: 5 } }));
    const reloaded = new Settings(dir, 'settings.json');
    assert.equal(reloaded.values.maxSteps, 0);
    assert.equal(reloaded.values.compaction.contextTokens, 1000);

    // Sane values pass through untouched.
    const good = s.set({ maxSteps: 12, compaction: { contextTokens: 30_000, reserveTokens: 4_096 } });
    assert.equal(good.maxSteps, 12);
    assert.equal(good.compaction.contextTokens, 30_000);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

void repo;

test('the user skills folder follows AIPASS_HOME, not the real home', () => {
  const home = scratch();
  const root = scratch();
  const prev = process.env.AIPASS_HOME;
  process.env.AIPASS_HOME = home;
  try {
    fs.mkdirSync(path.join(home, 'skills'), { recursive: true });
    fs.writeFileSync(path.join(home, 'skills', 'probe.md'), '# probe\n');
    const lib = SkillLibrary.default({ root });
    assert.ok(
      lib.dirs.includes(path.resolve(home, 'skills')),
      `the user folder answers to AIPASS_HOME:\n${lib.dirs.join('\n')}`,
    );
    assert.equal(lib.has('probe'), true, 'and a skill in it is found');
  } finally {
    if (prev === undefined) delete process.env.AIPASS_HOME; else process.env.AIPASS_HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a path-shaped key of the wrong shape is dropped, not saved to crash a surface', () => {
  // Each of these values reaches a path.resolve() or an iterable spread in
  // some surface — the window's project list, the backend's root pick, the
  // uploads folder, the skill library's dirs. A file that was hand-edited, or
  // written by an older build, must not take those surfaces down.
  const dir = scratch();
  try {
    const s = new Settings(dir, 'settings.json');
    const v = s.set({
      root: 42,
      projects: [{ path: 123 }, null, 'not-an-entry', { path: 'keep/me', name: 'kept' }],
      uploads: { nope: true },
      skillsDirs: 5,
      plugins: 'alpha',
    });
    assert.equal(v.root, null);
    assert.deepEqual(v.projects, [{ path: 'keep/me', name: 'kept' }]);
    assert.equal(v.uploads, null);
    assert.deepEqual(v.skillsDirs, []);
    assert.deepEqual(v.plugins, []);
    // projectList used to throw on the first junk entry — the window's first call.
    assert.deepEqual(s.projectList(), [{ name: 'kept', path: path.resolve('keep/me') }]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
