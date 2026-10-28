// Wave 3.3 — a run that reviews a change and stages nothing.
//
// The person who wants "look at this diff and tell me what is wrong" gets a
// run whose tool table is read-only and whose preamble teaches findings
// instead of edits. The overlay is the change under review: the run reads it,
// reports on it, and every CREATE/EDIT/DELETE/MOVE — plus the shell — answers
// `err:` by construction. A closing message without findings earns one nudge,
// because a review that read the change still has to say what it found.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempDir } from './harness.mjs';
import { Overlay } from '../harness/overlay.mjs';
import { SkillLibrary } from '../harness/skills.mjs';
import { createTools } from '../harness/tools.mjs';
import { Emitter } from '../harness/events.mjs';
import { runTask } from '../harness/loop.mjs';
import { hasFindings, reviewBrief, REVIEW_DIFF_CAP } from '../harness/review.mjs';

const toolsAt = (dir, overlay, extra = {}) => createTools({
  root: dir, overlay, skills: new SkillLibrary([]), maxResult: 6000, ...extra,
});

const scripted = (replies, sent) => {
  let turn = 0;
  return {
    async chat({ message }) {
      sent.push(message);
      return { text: replies[Math.min(turn++, replies.length - 1)], reasoning: '' };
    },
    async quota() { return { available: 10 }; },
  };
};

test('a review run stages nothing and names each finding with a file and a line', async () => {
  const dir = tempDir({ 'app.mjs': 'export const b = 1;\n' });
  const overlay = new Overlay(dir);
  // The change under review: staged, not on disk. A run clears the overlay on
  // entry, so a review that did the same would have nothing to read.
  overlay.set(path.join(dir, 'app.mjs'), 'export const b = 2;\n');
  const events = new Emitter();
  const rows = [];
  events.on('tool', (p) => rows.push(p));
  const sent = [];
  const replies = [
    'EDIT app.mjs\nFIND\nexport const b = 1;\nNEW\nexport const b = 3;\nEND\n',
    'DONE the diff looks fine\n',
    'DONE\n- major app.mjs:1 — the change drops the a + b export — keep the named export.\n',
  ];

  const result = await runTask('review the staged change', {
    bridge: scripted(replies, sent),
    tools: toolsAt(dir, overlay, { readOnly: true, allowRun: false }),
    overlay,
    events,
    options: { maxSteps: 5, review: true },
    first: true,
  });

  // The first message carried the staged diff and the findings shape, and not
  // the edit section. That is the tool-less half of the floor.
  assert.match(sent[0], /^--- app\.mjs$/m, `the diff rode the task:\n${sent[0]}`);
  assert.match(sent[0], /-export const b = 1;/);
  assert.match(sent[0], /\+export const b = 2;/);
  assert.match(sent[0], /blocker, major or minor, then the path and the line/);
  assert.doesNotMatch(sent[0], /If you want a file changed/, 'the edit block is gone');

  // The EDIT was refused before any tool saw it, and the staged bytes are
  // exactly what the person left there.
  const edit = rows.find((p) => p.kind === 'replace');
  assert.ok(edit, `the EDIT was a call of its own:\n${JSON.stringify(rows)}`);
  assert.match(edit.head, /^err: this is a review run/);
  const changes = overlay.changes();
  assert.equal(changes.length, 1);
  assert.equal(changes[0].after, 'export const b = 2;\n', 'the review did not touch the staged change');
  assert.equal(fs.readFileSync(path.join(dir, 'app.mjs'), 'utf8'), 'export const b = 1;\n', 'nor the disk');

  // A closing message without findings was refused once, with the shape.
  assert.ok(sent.some((m) => /Review check: this run is a review/.test(m)), 'the findings gate nudged once');
  assert.equal(result.stopReason, 'done');
  assert.match(result.summary, /major app\.mjs:1/);
  assert.equal(hasFindings(result.summary), true);
});

test('yolo and a writable tool table cannot widen a review', async () => {
  const dir = tempDir({ 'app.mjs': 'export const b = 1;\n' });
  const overlay = new Overlay(dir);
  const events = new Emitter();
  const rows = [];
  events.on('tool', (p) => rows.push(p));
  const sent = [];
  const replies = [
    'CREATE pwned.txt\nwritten by a review\nEND\n',
    'RUN\necho pwned > pwned.txt\nEND\n',
    'DONE no findings: the tree is clean\n',
  ];

  const result = await runTask('review this', {
    bridge: scripted(replies, sent),
    // The facade in review mode builds this table read-only. The test hands in
    // the widest one instead: the loop's floor must refuse it anyway.
    tools: toolsAt(dir, overlay, { readOnly: false, allowRun: true, allowGitWrite: true }),
    overlay,
    events,
    options: { maxSteps: 4, review: true, allowRun: true, allowGitWrite: true, mode: 'yolo' },
    first: true,
  });

  const write = rows.find((p) => p.kind === 'write');
  const run = rows.find((p) => p.kind === 'run');
  assert.match(write.head, /^err: this is a review run/);
  assert.match(run.head, /^err: this is a review run/);
  assert.equal(fs.existsSync(path.join(dir, 'pwned.txt')), false, 'nothing was written');
  assert.equal(overlay.changes().length, 0, 'nothing was staged');
  assert.equal(result.stopReason, 'done');
  assert.match(result.summary, /no findings/);
});

test('the brief names a ref when one is given, and caps a huge diff', () => {
  const base = reviewBrief('look at it', { base: 'origin/main' });
  assert.match(base, /git ref "origin\/main"/);
  assert.match(base, /GIT diff origin\/main/);

  const huge = { changes: () => [{ file: 'big.js', diff: '+x\n'.repeat(REVIEW_DIFF_CAP), isNew: false, deleted: false }] };
  const cut = reviewBrief('look', { overlay: huge });
  assert.match(cut, /the diff was cut at/);

  assert.equal(hasFindings('no findings: read app.mjs'), true);
  assert.equal(hasFindings('blocker src/a.ts:9 — null deref'), true);
  assert.equal(hasFindings('looks good to me'), false);
});
