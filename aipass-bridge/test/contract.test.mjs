// The /rpc contract: one list of method names, kept in step with the factories.
//
// The contract (harness/rpc/contract.mjs) is the one place that names every
// method the backend answers. A method added to a factory without being added
// here is drift, and this test fails the build instead of leaving a 404 for
// the reader. The reverse (a name here with no factory) is caught too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { METHODS } from '../harness/rpc/contract.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function collectFactoryMethods() {
  const dir = path.join(REPO, 'harness', 'rpc');
  const names = new Set();
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.mjs') || file === 'contract.mjs' || file === 'context.mjs') continue;
    const src = fs.readFileSync(path.join(dir, file), 'utf8');
    // Method keys look like:  async 'foo.bar'(params = {}) {   or   'foo.bar'() {
    for (const m of src.matchAll(/async\s+'([a-zA-Z][a-zA-Z0-9_.]*)'\s*\(/g)) names.add(m[1]);
    // Unquoted async shorthand:  async status(params = {}) {
    for (const m of src.matchAll(/^\s{4}async\s+([a-zA-Z][a-zA-Z0-9_]*)\s*\(/gm)) names.add(m[1]);
    // Unquoted sync shorthand:  cancel(params = {}) {
    for (const m of src.matchAll(/^\s{4}([a-zA-Z][a-zA-Z0-9_]*)\s*\([^)]*\)\s*\{/gm)) {
      const n = m[1];
      if (!['if', 'for', 'while', 'switch', 'catch', 'function'].includes(n)) names.add(n);
    }
  }
  return [...names].sort();
}

test('the contract lists every method the factories define', () => {
  const actual = collectFactoryMethods();
  const declared = [...METHODS].sort();
  const missing = actual.filter((n) => !declared.includes(n));
  const extra = declared.filter((n) => !actual.includes(n));
  assert.deepEqual(missing, [], `methods defined in factories but missing from the contract: ${missing.join(', ')}`);
  assert.deepEqual(extra, [], `methods named in the contract but not defined in any factory: ${extra.join(', ')}`);
});

test('the contract is sorted and unique', () => {
  const sorted = [...METHODS].sort();
  assert.deepEqual([...METHODS], sorted, 'METHODS must be sorted');
  assert.equal(new Set(METHODS).size, METHODS.length, 'METHODS must have no duplicates');
  assert.ok(METHODS.length > 100, 'the contract should name the whole surface');
});

test('hasMethod agrees with the list', async () => {
  const { hasMethod } = await import('../harness/rpc/contract.mjs');
  assert.equal(hasMethod('status'), true);
  assert.equal(hasMethod('does.not.exist'), false);
});

test('every factory method name is a dotted-or-simple identifier', () => {
  for (const n of collectFactoryMethods()) {
    assert.match(n, /^[a-zA-Z][a-zA-Z0-9_.]*$/, `bad method name: ${n}`);
  }
});
