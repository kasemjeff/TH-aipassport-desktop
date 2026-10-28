/**
 * The window's transcript renderer, checked against the protocol it mirrors.
 *
 * desktop/ui/markers.js walks a reply and hides the marker calls from the
 * bubble. The walk is a copy of protocol.parse(), and a copy is exactly the
 * kind of thing that drifts: the day the protocol grows a marker, the window
 * would start showing raw wire again — quietly. The parity battery below runs
 * both walks over the same corpus and fails on any disagreement, so drift is
 * a test failure instead of something a user notices mid-run.
 *
 * Run: node --test aipass-bridge/test/ui-markers.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../harness/protocol.mjs';
import { scan, transcript } from '../../desktop/ui/markers.js';

/* The corpus: every built-in marker, both block shapes, the quoting edge
   cases, and the near-misses that must NOT be calls. */
const REPLIES = [
  'Just a quick answer with no markers at all.',
  'I looked at it.\nNEED file src/app.js\nAnything else?',
  'NEED dir src',
  'SEARCH classify(kind\nGLOB **/*.test.mjs\nSKILL writing\nGIT status\nFETCH https://x\nWEB search terms\nATTACH screenshot.png',
  'DELETE old.txt\nMOVE a.txt b.txt',
  'EDIT a.js\nFIND\nconst a = 1;\nNEW\nconst a = 2;\nEND\nDone with that.',
  'EDIT b.js\nNEW\nfresh file\nEND',
  'EDIT no-end.js\nFIND\nold\nNEW\nnew',
  'CREATE c.txt\nhello\nworld\nEND',
  'RUN\nnode test.mjs\nEND\nResults were green.',
  'RUN\nnode x.mjs',
  'PLAN\n- [ ] one\n- [x] two\nEND\nTODO\n- [ ] three\nEND',
  'SUBAGENT\ntask: do the thing\nEND',
  'SYMBOLS src/index.ts\nDEF someName\nREFS someName\nJOBS',
  'ASK should the export keep the old column names?\nDONE asked',
  '## DONE shipped it',
  '**DONE** bold summary',
  'DONE',
  'DONE: colon form',
  'Some prose.\nDONE the last line.',
  'A fence:\n```\nNEED file quoted.js\nEDIT x\nEND\n```\nBut DONE for real.',
  '~~~\nRUN\nrm nothing\nEND\n~~~\nthen NEED file real.js',
  'NEEDdir is not a marker\nbut this is: NEED file z.js',
  'GOAL DONE the parser ships\nDONE shipped it',
  'NEED events.mjs\nDONE read it',
  'NEED desktop/\nDONE listed the folder',
  'NEED list desktop\nNEED ls src\nNEED list\nDONE listed them all',
  'NEED src/app.js 10-20\nDONE looked at a page',
  'NEED to check the logs before deciding\nDONE decided',
  'NEED desktop/index.js (or whatever entry point exists in desktop/)\nDONE left it as prose',
  'NEED file a.js\nNEED dir src\nDONE wrap up',
  'word NEE D mid-line is not a marker',
  'A heading ## DONE-like is not done\nbut ## DONE real is',
];

/** parse() carries bodies the window does not need; compare everything else. */
const shape = (calls) => calls.map(({ body, ...rest }) => rest);

test('scan() agrees with protocol.parse() call for call', () => {
  for (const reply of REPLIES) {
    assert.deepEqual(scan(reply), shape(parse(reply)), `disagreement on: ${JSON.stringify(reply)}`);
  }
});

test('plugin markers parse the same once plugins.list has reported them', () => {
  const plugins = [
    { marker: 'ECHO', takesBody: false },
    { marker: 'NOTE', takesBody: true },
    // A plugin may not shadow a built-in name: both walks take the built-in.
    { marker: 'RUN', takesBody: true },
  ];
  const replies = [
    'ECHO hello there\nDONE echoed',
    'NOTE section\nhidden body\nEND\nvisible prose',
    'NOTE never closed\nbody to the end',
    'ECHO but no plugin list knows it yet',
    'RUN\nnode x.mjs\nEND',
  ];
  for (const reply of replies) {
    assert.deepEqual(scan(reply, { plugins }), shape(parse(reply, { plugins })), `with plugins: ${JSON.stringify(reply)}`);
    // And with no list at all, an unknown marker is prose on both sides.
    assert.deepEqual(scan(reply), shape(parse(reply)), `without plugins: ${JSON.stringify(reply)}`);
  }
});

test('transcript() keeps the prose and drops the blocks', () => {
  assert.equal(
    transcript('Prose before.\nEDIT a.js\nFIND\nold\nNEW\nnew\nEND\nProse after.'),
    'Prose before.\nProse after.',
    'the whole EDIT block is hidden, prose on both sides stays',
  );
  assert.equal(transcript('Wired it.\nDONE wired the widget'), 'Wired it.', 'DONE is a marker, not prose');
  assert.equal(transcript('DONE fixed it'), '', 'a marker-only reply leaves an empty bubble');
  assert.equal(transcript('RUN\nls\nEND\nall green'), 'all green');
  assert.equal(transcript('I saw it.\nEDIT a.js\nFIND\nold'), 'I saw it.', 'a block still streaming to EOF is already hidden');
});

test('a fenced example is a quotation, never a call', () => {
  const quoted = 'The shape is:\n```\nNEED file example.js\nEND\n```\nThat is all.';
  assert.equal(transcript(quoted), quoted, 'markers inside a fence stay visible and uncalled');
  assert.deepEqual(scan(quoted), [], 'and scan() does not act on them');
});

test('transcript() is idempotent — re-rendering never eats more', () => {
  // The live bubble re-renders on every delta, so the filter has to agree with
  // itself: what it already showed must survive the next pass.
  for (const reply of REPLIES) {
    const once = transcript(reply);
    assert.equal(transcript(once), once, `not idempotent on: ${JSON.stringify(reply)}`);
  }
});
