// The code-navigation markers — SYMBOLS, DEF, REFS — and the JOBS poll.
//
// The tools and the marker grammar were both there from the start, and the
// markers never reached the tools: parse() had no rule for them, so a reply
// that used one lost the line (MARKER_LINE strips it from the prose) and
// produced no call at all. The model got a nudge about a marker it had
// spelled exactly right, and the feature the README documents was dead code.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { tempDir } from './harness.mjs';
import { Overlay } from '../harness/overlay.mjs';
import { createTools } from '../harness/tools.mjs';
import { runTask } from '../harness/loop.mjs';
import { saveMemory, memoryPath } from '../harness/memory-store.mjs';

// The symbol index is cached under the state home. Point it at a temp dir so
// the suite never writes into the real ~/.aipass.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aipass-symbols-home-'));
process.env.AIPASS_HOME = HOME;
after(() => fs.rmSync(HOME, { recursive: true, force: true }));

const PROJECT = {
  'src/app.js': [
    'export function greet(name) {',
    '  return `hi ${name}`;',
    '}',
    'export class Widget {',
    '  render() { return 1; }',
    '}',
    '',
  ].join('\n'),
  'src/use.js': [
    'import { greet } from "./app.js";',
    'export const hi = greet("x");',
    '',
  ].join('\n'),
};

const toolsIn = (dir) => createTools({ root: dir, overlay: new Overlay(dir) });

test('SYMBOLS, DEF and REFS answer from the project', async () => {
  const tools = toolsIn(tempDir(PROJECT));

  const syms = await tools.symbols('src/app.js');
  assert.match(syms, /1: function greet/, 'the file lists what it declares');
  assert.match(syms, /4: class Widget/);

  const def = await tools.def('greet');
  assert.match(def, /src\/app\.js:1 {2}function greet/, 'the definition names the file and the line');

  const refs = await tools.refs('greet');
  assert.match(refs, /src\/use\.js:2/, 'and the reference names the other file');
});

test("the index and the memory store are the owner's alone", { skip: process.platform === 'win32' ? 'POSIX modes only' : false }, async () => {
  // Both hold user data: the index names every source file and every symbol
  // in the project, and the memory store holds the model's durable facts
  // about it. Neither may be world-readable.
  const root = tempDir(PROJECT);
  const tools = toolsIn(root);
  await tools.symbols('src/app.js');

  const hash = crypto.createHash('sha1').update(path.resolve(root)).digest('hex').slice(0, 12);
  const indexFile = path.join(HOME, 'symbols', `${hash}.json`);
  assert.ok(fs.existsSync(indexFile), 'the index was written');
  assert.equal(fs.statSync(indexFile).mode & 0o777, 0o600, "the index is the owner's alone");
  assert.equal(fs.statSync(path.join(HOME, 'symbols')).mode & 0o777, 0o700, 'and so is the folder it is in');

  saveMemory(root, ['the build is npm run build']);
  const facts = memoryPath(root);
  assert.ok(fs.existsSync(facts), 'the facts were written');
  assert.equal(fs.statSync(facts).mode & 0o777, 0o600, "the memory file is the owner's alone");
  assert.equal(fs.statSync(path.dirname(facts)).mode & 0o777, 0o700, 'and so is the folder it is in');
});

test('a code-navigation marker in a reply reaches the tool', async () => {
  const dir = tempDir(PROJECT);
  const overlay = new Overlay(dir);
  const tools = toolsIn(dir);
  const sent = [];
  const replies = ['SYMBOLS src/app.js\nDEF greet\n', 'DONE read the symbols\n'];
  let turn = 0;
  const result = await runTask('what does the project declare?', {
    bridge: {
      async chat({ message }) {
        sent.push(message);
        return { text: replies[Math.min(turn++, replies.length - 1)], reasoning: '' };
      },
      async quota() { return { available: 10 }; },
    },
    tools, overlay,
    options: { maxSteps: 3 }, first: true,
  });

  assert.equal(result.stopReason, 'done');
  const results = sent[1] ?? '';
  assert.match(results, /1: function greet/, 'the declarations rode the results back');
  assert.match(results, /src\/app\.js:1 {2}function greet/, 'and so did the definition');
});
