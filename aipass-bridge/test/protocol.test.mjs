// The wire-format tests that don't need a bridge: fences, the prose filter,
// and the preamble's honesty about what a helper actually does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse, prose, preamble, attemptedMarker, MARKER_LINE } from '../harness/protocol.mjs';

test('markers inside a fenced block are a quotation, not a request', () => {
  const reply = [
    'Here is the shape:',
    '```',
    'NEED file src/index.ts',
    'EDIT a.txt',
    'FIND',
    'hello',
    'NEW',
    'goodbye',
    'END',
    '```',
    'Now for real.',
    'NEED file README.md',
    'DONE quoting, not asking',
  ].join('\n');
  const calls = parse(reply);
  assert.deepEqual(calls.map((c) => c.kind), ['read', 'done']);
  assert.equal(calls[0].arg, 'README.md');
});

test('a DONE inside a fence cannot end the run', () => {
  const calls = parse('```\nDONE all finished\n```\nNEED file a.txt');
  assert.deepEqual(calls.map((c) => c.kind), ['read']);
});

test('an unterminated fence swallows everything after it', () => {
  const calls = parse('```\nNEED file a.txt\nNEED file b.txt');
  assert.deepEqual(calls, []);
});

test('a fence inside a CREATE body is content, and the END still closes it', () => {
  const calls = parse('CREATE doc.md\n# title\n```\nan example\n```\nEND\nDONE wrote');
  assert.equal(calls[0].kind, 'write');
  assert.equal(calls[0].body, '# title\n```\nan example\n```');
  assert.deepEqual(calls.slice(1).map((c) => c.kind), ['done']);
});

test('prose keeps fenced lines and strips only real markers', () => {
  const p = prose('thinking out loud\n```\nNEED file x\n```\nDONE fin');
  assert.match(p, /thinking out loud/);
  assert.match(p, /NEED file x/, 'a quoted marker is literal content');
  assert.doesNotMatch(p, /DONE fin/);
});

test('a bare NEED is the file form — the shape weak models reach for', () => {
  const calls = parse('NEED events.mjs\nNEED desktop/\nNEED src/app.js 10-20\nDONE read them');
  assert.deepEqual(calls.map((c) => [c.kind, c.arg]), [
    ['read', 'events.mjs'],
    ['read', 'desktop/'],
    ['read', 'src/app.js 10-20'],
    ['done', 'read them'],
  ]);
});

test('English prose that starts with NEED stays prose', () => {
  const reply = 'NEED to see the logs before deciding.\nDONE decided';
  assert.deepEqual(parse(reply).map((c) => c.kind), ['done'], 'a sentence is not a call');
  assert.match(prose(reply), /NEED to see the logs/, 'and it survives the prose filter');
});

test('NEED list and NEED ls are the dir call — the spellings weak models write', () => {
  // Recorded live: `NEED list desktop` came back as a marker that parsed to
  // nothing, so the run sat on a request the harness never saw.
  const calls = parse('NEED list desktop\nNEED ls src\nNEED file a.txt\nDONE looked');
  assert.deepEqual(calls.map((c) => [c.kind, c.arg]), [
    ['list', 'desktop'],
    ['list', 'src'],
    ['read', 'a.txt'],
    ['done', 'looked'],
  ]);
  assert.ok(MARKER_LINE.test('NEED list desktop'), 'and it counts as a marker line, not prose');
  assert.ok(MARKER_LINE.test('NEED ls src'));
});

test('a bare NEED list or NEED dir means the project root', () => {
  const calls = parse('NEED list\nNEED dir\nNEED ls\nDONE saw it');
  assert.deepEqual(calls.map((c) => [c.kind, c.arg]), [
    ['list', '.'], ['list', '.'], ['list', '.'],
    ['done', 'saw it'],
  ]);
  // `NEED file` with no path is not the listing form — it stays the bare
  // single-token read, so a file literally named "file" is still readable.
  assert.deepEqual(parse('NEED file').map((c) => [c.kind, c.arg]), [['read', 'file']]);
});

test('attemptedMarker sees a broken marker line, but not prose or fences', () => {
  assert.equal(attemptedMarker('NEED\n'), true, 'a keyword with nothing after it is an attempt');
  assert.equal(attemptedMarker('Alright.\n**CREATE** the file next\n'), true, 'bolded keywords count');
  assert.equal(attemptedMarker('Need to check the logs first.'), false, 'sentence case is prose');
  assert.equal(attemptedMarker('```\nNEED file x\n```'), false, 'a quoted marker is a quotation');
  assert.equal(attemptedMarker('The capital of France is Paris.'), false, 'an answer is not an attempt');
});

test('a bare NEED is stripped from prose like any marker', () => {
  assert.equal(prose('Let me look.\nNEED events.mjs\nAnything else?'), 'Let me look.\nAnything else?');
});

test('the preamble does not promise parallel helpers', () => {
  const text = preamble({ subagent: true });
  assert.match(text, /runs to completion/);
  assert.doesNotMatch(text, /keep going yourself while it runs/);
});

test('the preamble documents the helper roles', () => {
  const text = preamble({ subagent: true });
  assert.match(text, /role: verifier/);
  assert.match(text, /role: reviewer/);
  assert.match(text, /role: summariser/);
});

test('ASK parses as its own call, and the question is required', () => {
  const reply = 'One thing is genuinely yours to decide.\nASK should the export keep the old column names?\nDONE asked';
  const calls = parse(reply);
  assert.deepEqual(calls.map((c) => c.kind), ['ask', 'done']);
  assert.equal(calls[0].arg, 'should the export keep the old column names?');
  assert.doesNotMatch(prose(reply), /should the export/, 'the question is not repeated as prose');
  assert.deepEqual(parse('ASK\nDONE only done').map((c) => c.kind), ['done'], 'a bare ASK is not a call');
});

test('the preamble documents the ASK pause', () => {
  const text = preamble({});
  assert.match(text, /ASK should the export keep the old column names\?/);
  assert.match(text, /Never put ASK in the same reply as a NEED/);
});
