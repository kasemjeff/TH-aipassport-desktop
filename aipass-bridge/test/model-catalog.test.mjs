// The catalog pre-flight (docs/HARNESS_DESIGN.md, the live stall of Oct 2026).
//
// A saved model the site no longer offers used to be found out mid-run, when
// the site silently swapped the conversation to a substitute. The loop now
// judges the chosen model against the bridge's live catalog before its first
// send and fails the run by name when it is gone — and never judges what it
// cannot judge: a fallback stub (no extension has connected), a missing
// endpoint, or `auto` (the pick the site delegates to itself) all skip.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { runTask } from '../harness/loop.mjs';
import { createTools } from '../harness/tools.mjs';
import { Overlay } from '../harness/overlay.mjs';
import { tempDir } from './harness.mjs';

const live = (ids) => ({ object: 'list', source: 'live', data: ids.map((id) => ({ id })) });

const ctxFor = (dir, bridge, events = new EventEmitter()) => {
  // Node's EventEmitter throws on an unheard 'error'; the real harness
  // emitter does not. Keep the stub calm unless a test collects them.
  events.on('error', () => {});
  return {
    bridge,
    tools: createTools({ root: dir, overlay: new Overlay(dir) }),
    overlay: new Overlay(dir),
    events,
  };
};

test('a saved model that left the catalog fails the run by name, before any send', async () => {
  const dir = tempDir();
  const sends = [];
  const bridge = {
    model: null,
    async models() { return live(['gemini-3.1-flash-lite', 'claude-sonnet-5@azure']); },
    async chat(args) { sends.push(args); return { text: 'DONE never sent', reasoning: '' }; },
    async quota() { return null; },
  };
  const events = new EventEmitter();
  const errors = [];
  events.on('error', (p) => errors.push(p.message));

  const result = await runTask('do the thing', {
    ...ctxFor(dir, bridge, events),
    options: { model: 'claude-sonnet-5@default' },
    first: true,
  });

  assert.equal(result.stopReason, 'error');
  assert.equal(sends.length, 0, 'nothing may reach the site');
  assert.match(result.summary, /claude-sonnet-5@default/, 'the sentence names the model');
  assert.match(result.summary, /catalog/);
  assert.equal(errors.length, 1, 'and it surfaces as the run\'s error');
});

test('the bridge default is judged when no per-run model is set', async () => {
  const dir = tempDir();
  const bridge = {
    model: 'claude-sonnet-5@default',
    async models() { return live(['gemini-3.1-flash-lite']); },
    async chat() { throw new Error('nothing should be sent'); },
    async quota() { return null; },
  };

  const result = await runTask('do the thing', {
    ...ctxFor(dir, bridge),
    options: { maxSteps: 2 },
    first: true,
  });

  assert.equal(result.stopReason, 'error');
  assert.match(result.summary, /claude-sonnet-5@default/);
});

test('a model still on the catalog runs as before', async () => {
  const dir = tempDir();
  const sends = [];
  const bridge = {
    model: null,
    async models() { return live(['gemini-3.1-flash-lite']); },
    async chat(args) { sends.push(args); return { text: 'DONE read it', reasoning: '' }; },
    async quota() { return null; },
  };

  const result = await runTask('do the thing', {
    ...ctxFor(dir, bridge),
    options: { model: 'gemini-3.1-flash-lite', maxSteps: 2 },
    first: true,
  });

  assert.equal(result.stopReason, 'done');
  assert.equal(sends.length, 1, 'the one reply was enough');
});

test('a fallback stub is never a judgement', async () => {
  const dir = tempDir();
  const sends = [];
  const bridge = {
    model: null,
    async models() {
      return { object: 'list', source: 'fallback', data: [{ id: 'gemini-3.1-flash-lite' }, { id: 'claude-sonnet-5@default' }] };
    },
    async chat(args) { sends.push(args); return { text: 'DONE went ahead', reasoning: '' }; },
    async quota() { return null; },
  };

  const result = await runTask('do the thing', {
    ...ctxFor(dir, bridge),
    options: { model: 'a-model-the-stub-cannot-know', maxSteps: 2 },
    first: true,
  });

  assert.equal(result.stopReason, 'done', 'the stub is not the catalog — the run goes ahead');
  assert.equal(sends.length, 1);
});

test('no models endpoint at all skips the check', async () => {
  const dir = tempDir();
  const sends = [];
  const bridge = {
    model: null,
    async chat(args) { sends.push(args); return { text: 'DONE went ahead', reasoning: '' }; },
    async quota() { return null; },
  };

  const result = await runTask('do the thing', {
    ...ctxFor(dir, bridge),
    options: { model: 'whatever', maxSteps: 2 },
    first: true,
  });

  assert.equal(result.stopReason, 'done');
  assert.equal(sends.length, 1);
});

test('auto delegates the pick to the site and is never judged', async () => {
  const dir = tempDir();
  const sends = [];
  const bridge = {
    model: null,
    async models() { return live(['gemini-3.1-flash-lite']); },
    async chat(args) { sends.push(args); return { text: 'DONE went ahead', reasoning: '' }; },
    async quota() { return null; },
  };

  const result = await runTask('do the thing', {
    ...ctxFor(dir, bridge),
    options: { model: 'auto', maxSteps: 2 },
    first: true,
  });

  assert.equal(result.stopReason, 'done');
  assert.equal(sends.length, 1);
});
