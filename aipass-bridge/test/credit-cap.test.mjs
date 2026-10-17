// The credit cap (`maxCredits`): the one per-run budget that is about money
// rather than shape. 0 disables it; a positive value stops a run once the
// observed spend against the bridge's cached quota reaches it. The quota is
// the stub's here, so the spend curve is exact and the stop is deterministic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Overlay } from '../harness/overlay.mjs';
import { SessionStore } from '../harness/session.mjs';
import { createTools } from '../harness/tools.mjs';
import { runTask } from '../harness/loop.mjs';
import { Settings, DEFAULTS } from '../harness/settings.mjs';

const tempDir = (files = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aipass-credit-'));
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  return dir;
};

/** A bridge whose quota drops 100 per reading — a run that spends as it works. */
function spendingBridge(start = 1000) {
  let reads = 0;
  return {
    get reads() { return reads; },
    async chat() { return { text: 'NEED file a.txt', reasoning: '' }; },
    async quota() { reads += 1; return { available: Math.max(0, start - reads * 100) }; },
  };
}

test('the credit cap stops a run whose observed spend reaches the ceiling', async () => {
  const dir = tempDir({ 'a.txt': 'hello\n' });
  const store = new SessionStore(path.join(dir, 'sessions'));
  const session = store.create({ root: dir, model: 'test-model' });
  const tools = createTools({ root: dir, overlay: new Overlay(dir) });
  const bridge = spendingBridge();

  const result = await runTask('read until the money runs out', {
    bridge, tools, overlay: new Overlay(dir), session,
    options: { maxSteps: 10, maxCredits: 150 },
    first: true,
  });

  assert.equal(result.stopReason, 'credit-limited', 'the cap is the stop reason');
  const stat = session.entries.find((e) => e.type === 'run_stats');
  assert.equal(stat.stopReason, 'credit-limited', 'and it is recorded like every other ending');
  const note = session.entries.find((e) => e.type === 'note' && /credit budget/.test(e.text ?? ''));
  assert.ok(note, 'the stop is spoken in the session');
  assert.match(note.text, /of 150 credits/, 'the note names the ceiling');
});

test('maxCredits 0 is the off switch — the same run finishes on its own', async () => {
  const dir = tempDir({ 'a.txt': 'hello\n' });
  const store = new SessionStore(path.join(dir, 'sessions'));
  const session = store.create({ root: dir, model: 'test-model' });
  const tools = createTools({ root: dir, overlay: new Overlay(dir) });
  const bridge = spendingBridge();

  const result = await runTask('same work, no cap', {
    bridge, tools, overlay: new Overlay(dir), session,
    options: { maxSteps: 2, maxCredits: 0 },
    first: true,
  });

  assert.notEqual(result.stopReason, 'credit-limited', 'no credit stop with the cap off');
  const note = session.entries.find((e) => e.type === 'note' && /credit budget/.test(e.text ?? ''));
  assert.equal(note, undefined, 'and no credit note was written');
});

test('the credit cap is clamped, and 0 stays a real value', () => {
  const sane = (v) => Settings.sane({ ...DEFAULTS, maxCredits: v }).maxCredits;
  assert.equal(sane(12.7), 13, 'fractional credits round to whole ones');
  assert.equal(sane('nonsense'), 0, 'a nonsense value means no cap, not a broken one');
  assert.equal(sane(-5), 0);
  assert.equal(sane(0), 0);
  assert.equal(sane(99_999_999), 10_000_000, 'the ceiling is a ceiling');
});
