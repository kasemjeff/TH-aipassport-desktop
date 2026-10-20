// The tool contracts that came out of the ACI (agent-computer interface)
// research round: command output keeps its tail, search hits carry their
// surroundings, every oversized result goes through the same cap, and the
// two mutations that could silently destroy a file refuse instead. The
// happy paths of all these tools stay in tools.test.mjs.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTools } from '../harness/tools.mjs';
import { Overlay } from '../harness/overlay.mjs';

const mk = (files) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aipass-aci-'));
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
  return dir;
};
const dirs = [];
const mkTracked = (files) => { const dir = mk(files); dirs.push(dir); return dir; };
after(() => { for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true }); });

const toolsIn = (dir, extra = {}) => createTools({ root: dir, overlay: new Overlay(dir), ...extra });

test('a long RUN keeps its head and its tail, and the locator names the elided middle', async () => {
  const dir = mkTracked({
    // The shape of every test runner: progress at the top, the verdict last.
    'emit.mjs': "let out = '';\n"
      + 'for (let i = 1; i <= 400; i++) out += `line ${i} of filler\\n`;\n'
      + "out += 'FAILED: 3 tests failed\\n';\n"
      + 'process.stdout.write(out);\n',
  });
  const tools = toolsIn(dir, { allowRun: true });
  const out = await tools.run('', 'node emit.mjs');

  assert.match(out, /line 1 of filler/, 'the head still rides the message');
  assert.match(out, /FAILED: 3 tests failed/, 'the diagnosis in the tail survives');
  assert.match(out, /more bytes/);
  assert.match(out, /NEED file \.aipass\/spill\/[a-f0-9]+\.txt \d+-\d+/, 'the locator names the elided line range');
  assert.doesNotMatch(out, /line 200 of filler/, 'the middle does not');
  const rel = out.match(/\.aipass\/spill\/[a-f0-9]+\.txt/)[0];
  assert.match(fs.readFileSync(path.join(dir, rel), 'utf8'), /line 200 of filler/, 'the spilled copy is complete');
});

test('a SEARCH hit carries one line of context on each side', async () => {
  const dir = mkTracked({ 'app.js': 'const before = 1;\nconst needle = 2;\nconst after = 3;\n' });
  const out = await toolsIn(dir).search('needle');
  assert.match(out, /app\.js:1- const before = 1;/);
  assert.match(out, /app\.js:2: const needle = 2;/);
  assert.match(out, /app\.js:3- const after = 3;/);
});

test('adjacent hits do not repeat their shared context line', async () => {
  const dir = mkTracked({ 'app.js': 'needle one\nneedle two\nplain\n' });
  const out = await toolsIn(dir).search('needle');
  assert.match(out, /app\.js:1: needle one/);
  assert.match(out, /app\.js:2: needle two/, 'a line first queued as context is upgraded to a match');
  assert.match(out, /app\.js:3- plain/);
  assert.equal(out.split('\n').filter((l) => /app\.js:\d[-:] plain/.test(l)).length, 1, 'the shared context line appears once');
});

test('GLOB output goes through the same cap as every other result', async () => {
  const files = {};
  for (let i = 0; i < 200; i++) files[`src/long-directory-name-${i}/file-with-a-long-name-${i}.ts`] = 'x';
  const dir = mkTracked(files);
  const out = await toolsIn(dir).glob('**/*.ts');
  assert.match(out, /src\/long-directory-name-0\/file-with-a-long-name-0\.ts/, 'the head of the list still shows');
  assert.match(out, /more bytes/, 'the rest is locatable');
  assert.ok(out.length < 3500, `clipped to the inline cap (${out.length} chars)`);
});

test('an empty RUN says what to do instead of running nothing', async () => {
  const tools = toolsIn(mkTracked({}), { allowRun: true });
  const out = await tools.run('', '   \n');
  assert.match(out, /^err: the RUN block has no command/);
});

test('MOVE refuses to land on an existing file, and a free name still works', () => {
  const dir = mkTracked({ 'a.txt': 'one\n', 'b.txt': 'two\n' });
  const tools = toolsIn(dir);
  const out = tools.move('a.txt b.txt');
  assert.match(out, /^err: b\.txt already exists/);
  assert.match(out, /DELETE b\.txt/);
  assert.match(tools.read('b.txt'), /two/, 'the file that was there is untouched');
  assert.match(tools.move('a.txt c.txt'), /^marked: move a\.txt → c\.txt/);
});

test('a spill read hands back the verbatim range — never a spill of a spill', () => {
  const rows = Array.from({ length: 300 }, (_, i) => `row ${i + 1} ${'y'.repeat(160)}`);
  const dir = mkTracked({ 'big.txt': rows.join('\n') + '\n' });
  const tools = toolsIn(dir);

  const first = tools.read('big.txt');
  const loc = first.match(/NEED file (\.aipass\/spill\/[a-f0-9]+\.txt) (\d+)-(\d+)/);
  assert.ok(loc, `the first read spilled and handed a locator:\n${first.slice(0, 300)}`);
  const start = Number(loc[2]);

  // The whole suggested range is too big for one message: it is cut here,
  // not spilled again — no second locator, no nested file.
  const whole = tools.read(`${loc[1]} ${loc[2]}-${loc[3]}`);
  assert.match(whole, /the range was cut/, 'a giant range is cut');
  assert.doesNotMatch(whole, /more bytes,/, 'a spill read is never spilled again');

  // A range that fits comes back exactly as the content sits on disk: one
  // gutter (the original), no second layer of numbering.
  const page = tools.read(`${loc[1]} ${start}-${start + 50}`);
  assert.doesNotMatch(page, /more bytes,/, 'still no second spill');
  assert.doesNotMatch(page, /^\s*\d+ \| \s*\d+ \| /m, 'no second gutter stacked on the first');
  assert.match(page, new RegExp(`row ${start} `));
  assert.match(page, new RegExp(`row ${start + 50} `));
});

test('the spill locator starts where the head really ended, not where the byte cap guessed', () => {
  // The start line was guessed from the byte cap (80 characters a line), and
  // the cap says nothing about how long the lines are: on long-lined files
  // the guess pointed past lines the model had never seen, so the range it
  // handed back skipped them for good.
  const rows = Array.from({ length: 40 }, (_, i) => `row ${i + 1} ${'y'.repeat(160)}`);
  const dir = mkTracked({ 'long.txt': rows.join('\n') + '\n' });
  const tools = toolsIn(dir);

  const out = tools.read('long.txt');
  const loc = out.match(/NEED file (\.aipass\/spill\/[a-f0-9]+\.txt) (\d+)-(\d+)/);
  assert.ok(loc, `the read spilled and handed a locator:\n${out.slice(0, 300)}`);

  // The head is what rode the message. The first line it did not carry is
  // where the rest has to be read from.
  const head = out.slice(0, out.indexOf('\n. '));
  const firstMissing = head.split('\n').length;
  assert.equal(Number(loc[2]), firstMissing, 'the range starts at the first line the head did not carry');

  const spilled = fs.readFileSync(path.join(dir, loc[1]), 'utf8').split('\n');
  assert.equal(Number(loc[3]), spilled.length, 'and it ends at the last line of the spill');

  // Nothing is skipped: the row the head broke on is the row the range opens
  // with.
  const page = tools.read(`${loc[1]} ${loc[2]}-${Number(loc[2]) + 1}`);
  assert.match(page, new RegExp(`row ${firstMissing} `), 'the row after the head is the row the range starts with');
});
