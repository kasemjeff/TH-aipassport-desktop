/**
 * The event map is a contract, not a description.
 *
 * docs/EVENTS.md names every event the harness emits. This test scans
 * harness/ for every emit('type') literal and holds the two sets equal in
 * both directions: an event renamed without the table, or a table row whose
 * event nobody emits, is exactly the doc drift the suite exists to catch.
 * The same equality is what lets plugins.mjs point at the map — a plugin
 * author reading docs/EVENTS.md is reading the whole vocabulary.
 *
 * Run: node --test aipass-bridge/test/event-map.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HARNESS_DIR = path.resolve(HERE, '..', 'harness');
const DOC = path.resolve(HERE, '..', '..', 'docs', 'EVENTS.md');

/** Every .mjs file under harness/, recursively. */
function* sources(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* sources(full);
    else if (entry.isFile() && entry.name.endsWith('.mjs')) yield full;
  }
}

/** The event names the harness emits, as literals. */
function emittedTypes() {
  const found = new Set();
  const EMIT = /\bemit\(\s*['"]([a-z_]+)['"]/g;
  for (const file of sources(HARNESS_DIR)) {
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(EMIT)) found.add(m[1]);
  }
  return found;
}

/** The event names the map documents: backticked names in a table's first column. */
function documentedTypes() {
  const text = fs.readFileSync(DOC, 'utf8');
  const found = new Set();
  for (const line of text.split('\n')) {
    const m = /^\|\s*`([a-z_]+)`\s*\|/.exec(line);
    if (m) found.add(m[1]);
  }
  return found;
}

test('every event the harness emits is named in docs/EVENTS.md', () => {
  const emitted = emittedTypes();
  const documented = documentedTypes();
  const missing = [...emitted].filter((t) => !documented.has(t));
  assert.deepEqual(missing, [],
    `events emitted by harness/ but absent from docs/EVENTS.md: ${missing.join(', ')}`);
});

test('every event named in docs/EVENTS.md is emitted by the harness', () => {
  const emitted = emittedTypes();
  const documented = documentedTypes();
  const extra = [...documented].filter((t) => !emitted.has(t));
  assert.deepEqual(extra, [],
    `rows in docs/EVENTS.md the harness never emits: ${extra.join(', ')}`);
});

test('the mid-run inject events exist and are wired by name', async () => {
  // The inject round added three events; their names are the contract the
  // window and the CLI both key on, so a rename here must fail this test,
  // the map test above, and the doc in the same change.
  const loop = fs.readFileSync(path.join(HARNESS_DIR, 'loop.mjs'), 'utf8');
  const facade = fs.readFileSync(path.join(HARNESS_DIR, 'harness.mjs'), 'utf8');
  assert.match(loop, /emit\('injected'/, 'the loop says when the queue was drained');
  assert.match(facade, /emit\('inject_queued'/, 'the facade says when a message was queued');
  assert.match(facade, /emit\('inject_orphaned'/, 'the facade returns undelivered messages to the window');
});
