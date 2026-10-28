/**
 * Preamble sections: what a plugin contributes to the run's first message.
 *
 * The shape follows the dsh system-prompt registry, cut to this harness's
 * size: named sections contributed at load, built fresh per run, appended
 * after the machine's own words, attributed so the model knows whose
 * sentence it reads, and empty or failing ones dropped — a plugin must never
 * break a run. What this file pins:
 *   - with nothing registered, the preamble is byte-identical to a run
 *     without the feature (the CLI's turn-1 bytes stay pinned);
 *   - a registered section rides the first message, named, in load order;
 *   - a failing or empty builder disappears without breaking the build;
 *   - a second plugin claiming a taken name fails at load, and the first
 *     owner keeps the slot.
 *
 * Run: node --test aipass-bridge/test/preamble-sections.test.mjs
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { preamble } from '../harness/protocol.mjs';
import { PluginManager } from '../harness/plugins.mjs';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aipass-sections-home-'));
process.env.AIPASS_HOME = HOME;
after(() => fs.rmSync(HOME, { recursive: true, force: true }));

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aipass-sections-'));

/** A plugin file with the given body. `file` is the full path. */
const writePlugin = (file, name, body) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `export default { name: '${name}', setup(ctx) { ${body} } };\n`);
};

test('with no sections the preamble is byte-identical to the tuned bytes', () => {
  const withDefault = preamble({ subagent: true, verify: true, lang: 'en' });
  const withEmpty = preamble({ subagent: true, verify: true, lang: 'en', sections: [] });
  assert.equal(withDefault, withEmpty);
  assert.ok(!withDefault.includes('extension installed on this machine'),
    'no attribution line appears when nothing registered');
});

test('a registered section rides the first message, named and in load order', () => {
  const dir = tempDir();
  writePlugin(path.join(dir, 'first.mjs'), 'first',
    `ctx.preamble.section('docs', () => 'Prefer reading docs/ before the sources.');`);
  writePlugin(path.join(dir, 'second.mjs'), 'second',
    `ctx.preamble.section('house-style', () => 'This project spells colour with a u.');`);
  const manager = new PluginManager({ dir });
  return manager.load().then((details) => {
    assert.equal(details.failed.length, 0, `both loaded: ${details.failed.map((f) => f.error).join('; ')}`);
    assert.deepEqual(details.preamble, ['docs', 'house-style']);
    const text = preamble({ sections: manager.preambleSections() });
    const at = text.indexOf('From the "docs" extension');
    assert.ok(at > 0, 'the section is attributed by name');
    assert.ok(text.includes('Prefer reading docs/ before the sources.'), 'with its text');
    assert.ok(text.indexOf('From the "house-style" extension') > at, 'and load order holds');
    // The section sits AFTER the machine's own words: the closing policy
    // paragraph the preamble always ends with is above it.
    assert.ok(text.indexOf('When you have changed code') < at, 'the machine speaks first');
  });
});

test('a section that throws or returns nothing is dropped, and the build lives', () => {
  const dir = tempDir();
  writePlugin(path.join(dir, 'broken.mjs'), 'broken',
    `ctx.preamble.section('broken', () => { throw new Error('boom'); });
     ctx.preamble.section('quiet', () => '   ');
     ctx.preamble.section('works', () => 'This line survives.');`);
  const manager = new PluginManager({ dir });
  return manager.load().then((details) => {
    assert.equal(details.failed.length, 0, 'a throwing builder is a build-time concern, not a load failure');
    const text = preamble({ sections: manager.preambleSections() });
    assert.ok(!text.includes('boom'), 'the throw never surfaced');
    assert.ok(!text.includes('From the "broken" extension'));
    assert.ok(!text.includes('From the "quiet" extension'), 'an empty text is no section at all');
    assert.ok(text.includes('This line survives.'), 'the working section is untouched');
  });
});

test('a second plugin claiming a taken name fails at load', () => {
  const dir = tempDir();
  writePlugin(path.join(dir, 'a.mjs'), 'a',
    `ctx.preamble.section('taken', () => 'first owner');`);
  writePlugin(path.join(dir, 'b.mjs'), 'b',
    `ctx.preamble.section('taken', () => 'second claimant');`);
  const manager = new PluginManager({ dir });
  return manager.load().then((details) => {
    assert.equal(details.loaded.length, 1, 'the first owner loaded');
    assert.equal(details.failed.length, 1, 'the second failed');
    assert.match(details.failed[0].error, /already owned by a/, 'and the refusal names the owner');
    const text = preamble({ sections: manager.preambleSections() });
    assert.ok(text.includes('first owner'), 'the slot kept its first text');
    assert.ok(!text.includes('second claimant'), 'and never the later claim');
  });
});

test('a malformed registration fails the plugin at load, not at run time', () => {
  const dir = tempDir();
  writePlugin(path.join(dir, 'bad.mjs'), 'bad',
    `ctx.preamble.section('not a name!', () => 'text');`);
  const manager = new PluginManager({ dir });
  return manager.load().then((details) => {
    assert.equal(details.failed.length, 1, 'the plugin is refused');
    assert.match(details.failed[0].error, /preamble\.section/, 'with the shape to fix');
    assert.equal(details.preamble.length, 0, 'and nothing of it stayed registered');
  });
});
