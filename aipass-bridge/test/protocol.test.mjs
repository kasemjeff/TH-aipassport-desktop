// The wire-format tests that don't need a bridge: fences, the prose filter,
// and the preamble's honesty about what a helper actually does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse, prose, preamble } from '../harness/protocol.mjs';

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

test('a bare NEED is stripped from prose like any marker', () => {
  assert.equal(prose('Let me look.\nNEED events.mjs\nAnything else?'), 'Let me look.\nAnything else?');
});

test('the preamble does not promise parallel helpers', () => {
  const text = preamble({ subagent: true });
  assert.match(text, /runs to completion/);
  assert.doesNotMatch(text, /keep going yourself while it runs/);
});
