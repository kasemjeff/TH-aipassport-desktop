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
  // maxSteps: 0 makes the loop exit before its first step: the window accepts
  // the message and answers nothing, with no error anywhere.
  const dir = scratch();
  try {
    const s = new Settings(dir, 'settings.json');
    assert.equal(s.set({ maxSteps: 0 }).maxSteps, 1, 'zero steps is never stored');
    assert.equal(s.set({ maxSteps: 9_999 }).maxSteps, 200, 'and neither is an absurd one');
    assert.equal(s.set({ compaction: { contextTokens: 10 } }).compaction.contextTokens, 1000, 'the budget has a floor');
    assert.equal(s.set({ compactAtPercent: 9_999 }).compactAtPercent, 100, 'the rotation share has a ceiling');
    assert.equal(s.set({ thinking: 'banana' }).thinking, 'low', 'an unknown thinking level falls back, never stores');
    assert.equal(s.set({ thinking: 'high' }).thinking, 'high', 'and a real level passes through');
    assert.equal(s.set({ maxToolCalls: 0 }).maxToolCalls, 300, 'zero tool calls means the default, never zero');
    assert.equal(s.set({ maxToolCalls: 25 }).maxToolCalls, 25, 'a real tool-call cap passes through');
    assert.equal(s.set({ maxToolCalls: 9_999_999 }).maxToolCalls, 10_000, 'the tool-call cap has a ceiling');
    assert.equal(s.set({ maxWallClockMs: 1 }).maxWallClockMs, 10_000, 'the wall clock has a ten-second floor');
    assert.equal(s.set({ maxWallClockMs: 'banana' }).maxWallClockMs, 1_800_000, 'nonsense falls back to the default');
    assert.equal('chatUrl' in s.set({ chatUrl: 'javascript:alert(1)' }), false, 'a chat URL must be http(s)');

    // A hand-edited file is clamped as it is read, not trusted.
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ maxSteps: 0, compaction: { contextTokens: 5 } }));
    const reloaded = new Settings(dir, 'settings.json');
    assert.equal(reloaded.values.maxSteps, 1);
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
