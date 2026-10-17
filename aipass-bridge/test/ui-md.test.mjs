/**
 * The stream renderer's split, pinned.
 *
 * app.js paints a streaming reply in two layers: the settled prefix and the
 * moving tail (`splitMarkdownStable` in desktop/ui/md.js). Two properties make
 * that safe, and this file pins both over a corpus that exercises every shape
 * the renderer knows: rendering the pieces and joining them equals the
 * one-shot render, for every line-boundary prefix (so an answer repainted from
 * its pieces never diverges from the whole); and as a source grows line by
 * line the settled prefix only ever gains text (so a paint can append to what
 * it already rendered instead of starting over).
 *
 * Run: node --test aipass-bridge/test/ui-md.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown, splitMarkdownStable } from '../../desktop/ui/md.js';

const SAMPLES = [
  'plain paragraph',
  'para one\n\npara two\n\npara three',
  '# heading one\n\ntext under it\n\n## heading two\n\nmore text',
  'a paragraph\n\n---\n\nafter the rule',
  '- one\n- two\n- three',
  '1. first\n2. second',
  '- bullet\n1. number\n\nplain after the list',
  'text before\n\n```js\nconst a = 1;\n\nconst b = 2;\n```\n\ntext after',
  '```\ncode\nstill code',
  '> quoted line\n> second quote',
  '**bold** and *soft* and `code` and [a link](https://example.com)',
  'ก่อนหน้า\n\nย่อหน้าถัดไปที่ยาวขึ้นเรื่อย ๆ\n\nจบแล้ว',
  'table-ish\n\n| a | b |\n| - | - |\n| 1 | 2 |',
];

/** Every line-boundary prefix of a sample, the whole sample included. */
const prefixes = (sample) => {
  const lines = sample.split('\n');
  return Array.from({ length: lines.length + 1 }, (_, n) => lines.slice(0, n).join('\n'));
};

test('a streamed reply renders the same page from its pieces as in one pass', () => {
  for (const sample of SAMPLES) {
    for (const prefix of prefixes(sample)) {
      const { stable, tail } = splitMarkdownStable(prefix);
      const pieces = [renderMarkdown(stable), renderMarkdown(tail)].filter(Boolean).join('\n');
      assert.equal(pieces, renderMarkdown(prefix), `pieces diverged for:\n${JSON.stringify(prefix)}`);
    }
  }
});

test('the settled prefix only ever grows as a reply streams in', () => {
  // The window's paint cache appends to the settled layer and only resets when
  // this property breaks; a shrunken prefix here would double or lose text on
  // screen, not just cost a repaint.
  for (const sample of SAMPLES) {
    let settled = '';
    for (const prefix of prefixes(sample)) {
      const { stable } = splitMarkdownStable(prefix);
      assert.ok(stable.startsWith(settled), `the settled prefix shrank at:\n${JSON.stringify(prefix)}`);
      settled = stable;
    }
  }
});

test('a settled split is stable text: its rendering does not change as the tail grows', () => {
  // The other half of the append contract: what was declared settled must keep
  // the exact same rendering once more lines arrive — if it could change, the
  // layer on screen would be stale.
  for (const sample of SAMPLES) {
    const lines = sample.split('\n');
    const seen = new Map();
    for (let n = 0; n <= lines.length; n++) {
      const { stable } = splitMarkdownStable(lines.slice(0, n).join('\n'));
      for (const [settled, html] of seen) {
        if (stable.startsWith(settled)) {
          assert.equal(renderMarkdown(settled), html, `a settled stretch re-rendered differently:\n${JSON.stringify(settled)}`);
        }
      }
      seen.set(stable, renderMarkdown(stable));
    }
  }
});
