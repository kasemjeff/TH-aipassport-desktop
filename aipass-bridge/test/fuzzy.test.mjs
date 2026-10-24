/**
 * The fuzzy matcher: the word a person types, and the many paths it could
 * mean.
 *
 * The rules are the ones every quick-open has, and they are worth pinning
 * down: the file name beats a folder name, the start of a word beats the
 * middle of one, and the letters the match used are reported so the window
 * can pick them out.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fuzzyMatch } from '../harness/fuzzy.mjs';

test('a word finds a file whose letters are not next to each other', () => {
  const hit = fuzzyMatch('apjs', 'desktop/ui/app.js');
  assert.ok(hit, 'the file is found');
  assert.ok(hit.hits.length === 4, 'and every letter of the word is reported');
  const letters = hit.hits.map((i) => 'desktop/ui/app.js'[i]).join('');
  assert.equal(letters, 'apjs', 'and they are the letters that matched');
});

test('a word that is nowhere finds nothing', () => {
  assert.equal(fuzzyMatch('xyz', 'desktop/ui/app.js'), null);
  assert.equal(fuzzyMatch('zzz', 'aipass-bridge/harness/loop.mjs'), null);
});

test('the file name beats a folder name', () => {
  // "app" fits "desktop/ui/app.js" in the name, and "aipass/app/x.md" only
  // in a folder. The name is what a person remembers.
  const inName = fuzzyMatch('app', 'desktop/ui/app.js');
  const inFolder = fuzzyMatch('app', 'aipass/app/x.md');
  assert.ok(inName.score > inFolder.score, 'the match in the name wins');
});

test('the start of a word beats the middle of one', () => {
  // Both paths fail to fit the word in the file name, so both are scored on
  // the path — and the one where the word begins a folder beats the one where
  // it is buried inside a name.
  const atStart = fuzzyMatch('ui', 'desktop/ui/styles.css');
  const inMiddle = fuzzyMatch('ui', 'desktop/quix/styles.css');
  assert.ok(atStart.score > inMiddle.score, 'a word that begins a folder beats one buried in it');
});

test('a run of letters beats the same letters apart', () => {
  const together = fuzzyMatch('app', 'desktop/ui/app.js');
  const apart = fuzzyMatch('app', 'desktop/a/p/p.js');
  assert.ok(together.score > apart.score, 'the tight match wins');
});

test('the hits point at the characters of the original text', () => {
  // The matcher lowercases a copy, and the copy must be the same length as
  // the original — or every hit would point at the wrong character.
  const text = 'Desktop/UI/App.JS';
  const hit = fuzzyMatch('duia', text);
  assert.ok(hit, 'the word is found');
  assert.equal(hit.hits.map((i) => text[i]).join(''), 'DUIA', 'and the hits are the original letters');
});

test('the best way the word fits wins, not the first one', () => {
  // In "xa_ab" the word "ab" fits twice: at the "a" buried inside "xa", and
  // at the "a" that begins the second word. The second is the one a reader
  // meant, and only a matcher that tries every way knows that — a greedy one
  // takes the first and never looks.
  const hit = fuzzyMatch('ab', 'xa_ab');
  assert.ok(hit, 'the word is found');
  assert.deepEqual(hit.hits, [3, 4], 'and the letters are the ones that begin a word');
  assert.equal(hit.hits.map((i) => 'xa_ab'[i]).join(''), 'ab');
});

test('an empty word matches everything, with nothing picked out', () => {
  const hit = fuzzyMatch('', 'desktop/ui/app.js');
  assert.deepEqual(hit, { score: 0, hits: [] });
});
