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
  '| name | score |\n| :--- | ---: |\n| a | 1 |\n| b | 2 |',
  'before\n| a | b |\n| - | - |\n| 1 | 2 |\nafter',
  '![cat](https://example.com/cat.png)',
  'text\n![cat](https://example.com/cat.png)\nmore',
  'see ![cat](https://example.com/cat.png) here',
  '`![x](https://example.com/x.png)`',
  '![a*b](https://example.com/a*b.png)',
  '![clip](https://example.com/clip.mp4)',
  '[demo](https://example.com/demo.mp4)',
  '[clip.mp4](https://storage.example.com/signed/abc?token=1)',
  'https://example.com/clip.mp4',
  '![x](javascript:alert(1))',
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

test('pipe tables render a header, a body and per-column alignment', () => {
  const html = renderMarkdown('| name | score |\n| :--- | ---: |\n| a | 1 |\n| b | 2 |');
  assert.match(html, /^<div class="md-table-wrap"><table><thead><tr>/);
  assert.match(html, /<th class="al-left">name<\/th>/);
  assert.match(html, /<th class="al-right">score<\/th>/);
  assert.match(html, /<tbody>/);
  assert.match(html, /<td class="al-left">a<\/td><td class="al-right">1<\/td>/);
});

test('table cells keep escaped pipes, code spans and HTML escaped', () => {
  const html = renderMarkdown('| a | b |\n| --- | --- |\n| <b> | x \\| y |\n| `one|two` | 2 |');
  assert.ok(html.includes('&lt;b&gt;'), html);
  assert.ok(html.includes('x | y'), html);
  assert.ok(html.includes('<code>one|two</code>'), html);
  assert.ok(!html.includes('<b>'), html);
});

test('a table needs its separator row', () => {
  const html = renderMarkdown('| a | b |\nnot a separator');
  assert.ok(!html.includes('<table>'), html);
  assert.match(html, /<p>\| a \| b \| not a separator<\/p>/);
});

test('a standalone image becomes a figure and escapes URL and caption', () => {
  const html = renderMarkdown('![<cat> & "dog"](https://example.com/cat.png?a=1&b=2)');
  assert.match(html, /^<figure class="md-figure"><img class="md-image"/);
  assert.ok(html.includes('src="https://example.com/cat.png?a=1&amp;b=2"'), html);
  assert.ok(!html.includes('&amp;amp;'), html);
  assert.ok(html.includes('alt="&lt;cat&gt; &amp; &quot;dog&quot;"'), html);
  assert.ok(html.includes('<figcaption>&lt;cat&gt; &amp; &quot;dog&quot;</figcaption>'), html);
});

test('an image inside prose stays inline', () => {
  const html = renderMarkdown('see ![cat](https://example.com/cat.png) here');
  assert.match(html, /^<p>see <img class="md-image md-image-inline"/);
  assert.ok(html.includes('alt="cat"'), html);
  assert.ok(html.includes(' here</p>'), html);
});

test('image URLs that can run code are never fetched', () => {
  const html = renderMarkdown('![x](javascript:alert(1))');
  assert.ok(!html.includes('<img'), html);
  assert.ok(html.includes('![x](javascript:alert(1))'), html);
});

test('markdown quoted in backticks stays code, never a live image', () => {
  const html = renderMarkdown('`![x](https://example.com/x.png)`');
  assert.equal(html, '<p><code>![x](https://example.com/x.png)</code></p>');
});

test('emphasis characters inside an image URL or alt text are left alone', () => {
  const html = renderMarkdown('![a*b](https://example.com/a*b.png)');
  assert.ok(html.includes('src="https://example.com/a*b.png"'), html);
  assert.ok(html.includes('alt="a*b"'), html);
  assert.ok(!html.includes('<em>'), html);
});

test('a standalone video URL or media line becomes a player', () => {
  const bare = renderMarkdown('https://example.com/demo.mp4?t=10');
  assert.match(bare, /<figure class="md-figure md-video-figure">/);
  assert.ok(bare.includes('<video class="md-video" controls preload="metadata" playsinline src="https://example.com/demo.mp4?t=10"></video>'), bare);

  const labelled = renderMarkdown('![demo](https://example.com/demo.webm)');
  assert.ok(labelled.includes('src="https://example.com/demo.webm"'), labelled);
  assert.ok(labelled.includes('<figcaption>demo</figcaption>'), labelled);

  const linked = renderMarkdown('[demo](https://example.com/demo.mp4)');
  assert.ok(linked.includes('src="https://example.com/demo.mp4"'), linked);
  assert.ok(linked.includes('<figcaption>demo</figcaption>'), linked);

  // Signed storage URLs often carry the filename only in the label.
  const signed = renderMarkdown('[clip.mp4](https://storage.example.com/signed/abc?token=1)');
  assert.ok(signed.includes('src="https://storage.example.com/signed/abc?token=1"'), signed);
  assert.ok(signed.includes('<figcaption>clip.mp4</figcaption>'), signed);
});

test('a bare non-video URL stays prose', () => {
  assert.equal(renderMarkdown('https://example.com/'), '<p>https://example.com/</p>');
});
