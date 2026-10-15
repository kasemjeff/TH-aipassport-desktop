// A regression test for the bug that made the window stop answering: a settings
// value that breaks a run is now clamped at the one place all surfaces write.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Settings } from '../harness/settings.mjs';

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
