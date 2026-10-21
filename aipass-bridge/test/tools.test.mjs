// The tool implementations, unit-level: the glob matcher, the fetch guard,
// and the async shape of the two shell-carrying tools.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createTools } from '../harness/tools.mjs';
import { Overlay } from '../harness/overlay.mjs';
import { SkillLibrary } from '../harness/skills.mjs';

const mk = (files) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aipass-tools-'));
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

test('GLOB honours the directories before **', async () => {
  const dir = mkTracked({ 'src/a.ts': 'a', 'src/deep/b.ts': 'b', 'c.ts': 'c', 'src/x.md': 'm' });
  const tools = toolsIn(dir);
  const hit = async (pattern) => (await tools.glob(pattern)).split('\n').filter((l) => !l.startsWith('…')).sort();
  assert.deepEqual(await hit('src/**/*.ts'), ['src/a.ts', 'src/deep/b.ts'], 'c.ts is outside src/');
  assert.deepEqual(await hit('**/*.ts'), ['c.ts', 'src/a.ts', 'src/deep/b.ts']);
  assert.deepEqual(await hit('*.ts'), ['c.ts'], 'a bare pattern stays root-only');
  assert.deepEqual(await hit('src/**'), ['src/a.ts', 'src/deep/b.ts', 'src/x.md'], 'a trailing ** means everything below');
  assert.match(await tools.glob('src/**/*.md'), /src\/x\.md/);
});

test('FETCH refuses private and internal addresses in every spelling', async () => {
  const tools = toolsIn(mkTracked({}));
  for (const url of [
    'http://127.0.0.1:9/x',
    'http://localhost/x',
    'http://169.254.169.254/latest/meta-data',
    'http://[::1]/x',
    'HTTP-URLLOOPBACK-IP:9/x',   // the WAF-shortened spelling a file quote may carry
  ]) {
    const out = await tools.fetch(url);
    assert.match(out, /refusing to fetch/, `${url} must be refused`);
  }
});

test('FETCH truncates at the byte cap instead of riding a giant body upstream', async () => {
  process.env.AIPASS_FETCH_MAX_BYTES = '100';
  // The request is injected: the tool resolves the name, vets the answers and
  // hands the vetted address to the transport, so a test can drive the guard
  // without a network. A literal address skips the resolve, which is what
  // keeps this test offline.
  const transport = async () => new Response('x'.repeat(10_000), { status: 200 });
  try {
    const tools = toolsIn(mkTracked({}), { fetchTransport: transport });
    const out = await tools.fetch('http://93.184.216.34/big');
    assert.match(out, /truncated at the byte cap/);
    assert.match(out, /untrusted input/, 'web content arrives marked as untrusted');
    assert.ok(out.length < 2_000, 'the result is bounded, not the whole body');
  } finally {
    delete process.env.AIPASS_FETCH_MAX_BYTES;
  }
});

test('RUN stays async and keeps its refusal when shell is off', async () => {
  const dir = mkTracked({});
  const off = toolsIn(dir);
  assert.equal(await off.run('', 'echo hi'), 'err: shell commands are disabled for this run');

  const on = toolsIn(dir, { allowRun: true });
  assert.match(await on.run('', 'echo aipass-echo-test'), /aipass-echo-test/);
});

test('GIT is async, and shell punctuation cannot ride behind an allowed subcommand', async () => {
  const dir = mkTracked({});
  const tools = toolsIn(dir);
  assert.match(await tools.git('status; echo pwned'), /no shell punctuation/);
  assert.match(await tools.git('status && echo pwned'), /no shell punctuation/);

  execSync('git init', { cwd: dir, stdio: 'ignore' });
  const out = await tools.git('status');
  assert.match(out, /On branch|No commits yet/, 'a real read-only subcommand still works');
});

test('failures carry the err: prefix the loop keys on', async () => {
  const dir = mkTracked({ 'a.txt': 'hello\n' });
  const tools = toolsIn(dir, { skills: new SkillLibrary([]) });
  assert.match(tools.read('missing.txt'), /^err: no such file/);
  assert.match(await tools.replace('a.txt', ['', 'x']), /^err: the text to change was empty/);
  assert.match(await tools.replace('a.txt', ['not there at all', 'x']), /^err: the text to change was not found/);
  assert.match(await tools.search('   '), /^err: give me some text/);
  assert.match(await tools.glob(''), /^err: give me a glob/);
  assert.match(tools.delete(''), /^err: give me a file path/);
  assert.match(tools.delete('nope.txt'), /^err: no such file/);
  assert.match(tools.move('a.txt'), /^err: usage/);
  assert.match(tools.skill('no-such-playbook'), /^err: no such skill/);
  // Successes stay bare text — the prefix marks failure, nothing else.
  assert.match(tools.read('a.txt'), /^1 \| hello/);
});

// `$$`, `$&` and `` $` `` are replacement patterns in String.replace. The
// model writes shell scripts and JavaScript, where they are ordinary text,
// and a string replacement expanded them into something the model never
// wrote — while reporting the edit as applied.
test('an edit does not expand $ patterns in the replacement', async () => {
  const dir = mkTracked({ 'script.sh': 'echo hi\n' });
  const tools = toolsIn(dir);
  const out = await tools.replace('script.sh', ['echo hi', 'echo $$HOME and $&']);
  assert.match(out, /^updated script\.sh \(1 change\)/, 'the edit is applied');
  assert.equal(
    tools.read('script.sh').split('\n')[0],
    '1 | echo $$HOME and $&',
    'the bytes are the ones the model wrote',
  );
});

// The range is the model's own arithmetic, and it gets it wrong. A start
// past the end of the file used to produce an empty read and a note claiming
// "lines 500-100 of 100" — which reads like the file is empty, and the model
// then creates it again.
test('a range past the end of the file says so, instead of reading nothing', async () => {
  const dir = mkTracked({ 'small.txt': 'one\ntwo\n' });
  const tools = toolsIn(dir);
  const out = tools.read('small.txt 500-600');
  assert.match(out, /^err: small\.txt has 2 line\(s\)/);
  assert.match(out, /past the end/);
  assert.doesNotMatch(out, /lines 500-/, 'and no nonsensical range');
});

// A trailing newline ends the last line; it does not begin an empty one.
// Splitting on "\n" alone invents a phantom last line for every file that
// ends with one, and the model copies what it is shown.
test('a file that ends with a newline has no phantom last line', async () => {
  const dir = mkTracked({ 'notes.txt': 'one\ntwo\n' });
  const tools = toolsIn(dir);
  const out = tools.read('notes.txt');
  assert.match(out, /1 \| one/);
  assert.match(out, /2 \| two/);
  assert.doesNotMatch(out, /3 \|/, 'there is no third line');
});

test('SEARCH -i matches without letter case; plain SEARCH stays exact', async () => {  const dir = mkTracked({ 'case.txt': 'Hello World\nbye\n' });
  const tools = toolsIn(dir);
  assert.match(await tools.search('hello world'), /no matches/);
  assert.match(await tools.search('-i hello world'), /case\.txt:1: Hello World/);
});

test('SEARCH and GLOB honour .gitignore, and the SKIP suspects are out even without one', async () => {
  const dir = mkTracked({
    '.gitignore': '*.log\nbuild-out/\n/root-only.txt\n!keep.log\n',
    'app.log': 'needle in a log\n',
    'keep.log': 'needle worth keeping\n',
    'src/code.js': 'const needle = 1\n',
    'build-out/gen.js': 'const needle = 2\n',
    'root-only.txt': 'needle at root\n',
    'nested/root-only.txt': 'needle nested\n',
    'target/debug/x.js': 'needle in target\n',
    'vendor/lib.js': 'needle in vendor\n',
    'coverage/lcov.info': 'needle in coverage\n',
  });
  const tools = toolsIn(dir);
  const hits = await tools.search('needle');
  assert.match(hits, /src\/code\.js/);
  assert.match(hits, /keep\.log/, 'a negation re-includes the file');
  assert.match(hits, /nested\/root-only\.txt/, 'a rooted rule ignores the root copy only');
  assert.doesNotMatch(hits, /app\.log/);
  assert.doesNotMatch(hits, /build-out/);
  assert.doesNotMatch(hits, /(^|\/)root-only\.txt: \d+: needle at root/);
  assert.doesNotMatch(hits, /target\/|vendor\/|coverage\//, 'SKIP suspects are excluded with no gitignore at all');

  assert.deepEqual((await tools.glob('**/*.log')).split('\n'), ['keep.log']);
});

test('GLOB expands brace alternation and single-char ? like the shells do', async () => {
  const dir = mkTracked({
    'index.html': 'x\n',
    'about.html': 'x\n',
    'app.js': 'x\n',
    'app.css': 'x\n',
    'README.md': 'x\n',
  });
  const tools = toolsIn(dir);
  assert.deepEqual(
    (await tools.glob('**/*.{js,css,html}')).split('\n').sort(),
    ['about.html', 'app.css', 'app.js', 'index.html'],
  );
  assert.deepEqual(
    (await tools.glob('index.?tml')).split('\n').sort(),
    ['index.html'],
  );
  assert.match(await tools.glob('**/*.{ts,tsx}'), /^no files matched/);
});

test('SEARCH skips files over the 1 MB cap instead of reading them line by line', async () => {
  const dir = mkTracked({
    'big.txt': `${'x'.repeat(1_100_000)}\nneedle\n`,
    'small.txt': 'needle here\n',
  });
  const tools = toolsIn(dir);
  const hits = await tools.search('needle');
  assert.match(hits, /small\.txt/);
  assert.doesNotMatch(hits, /big\.txt/);
});

test('ATTACH queues a part the loop can send, and refuses what cannot ride a chat', async () => {
  const dir = mkTracked({
    // NUL byte marks it binary, so the extension names the type: image/png
    'shot.png': '\x89PNG\r\n\x1a\n\x00\x01\x02\x03',
    'notes.md': '# notes\n',
    'prog.exe': '\x00\x01binary',
  });
  const tools = toolsIn(dir);
  assert.match(await tools.attach('shot.png'), /queued shot\.png \(image\/png/);
  assert.equal(tools.pendingParts.length, 1);
  assert.equal(tools.pendingParts[0].type, 'image_url');
  assert.match(tools.pendingParts[0].image_url.url, /^data:image\/png;base64,/);
  tools.pendingParts.splice(0);

  assert.match(await tools.attach('notes.md'), /queued notes\.md \(text\/plain/);
  assert.equal(tools.pendingParts[0].type, 'file');
  assert.equal(tools.pendingParts[0].file.filename, 'notes.md');
  assert.match(tools.pendingParts[0].file.file_data, /^data:text\/plain;base64,/);
  tools.pendingParts.splice(0);

  assert.match(await tools.attach('missing.png'), /^err: no such file/);
  assert.match(await tools.attach('node_modules/x.png'), /^err: .*skipped/);
  assert.match(await tools.attach('prog.exe'), /^err: .*not an attachable type/);
  assert.match(await tools.attach(''), /^err: give me a file path/);
  assert.equal(tools.pendingParts.length, 0);
});

test('ATTACH refuses an oversized file on its size, before it is read', async () => {
  const dir = mkTracked({});
  // A sparse file: the size is what the guard reads, and a real 21 MB of
  // zeroes would make the test slow for no reason.
  const fd = fs.openSync(path.join(dir, 'big.bin'), 'w');
  fs.ftruncateSync(fd, 21 * 1024 * 1024);
  fs.closeSync(fd);
  const tools = toolsIn(dir);
  const out = await tools.attach('big.bin');
  assert.match(out, /^err: big\.bin is 21 MB — the cap is 20 MB/);
  assert.equal(tools.pendingParts.length, 0, 'nothing was queued');
});

test('ATTACH serves a file the run wrote itself, from the overlay', async () => {
  const dir = mkTracked({});
  const tools = toolsIn(dir);
  await tools.write('made.txt', 'freshly written\n');
  assert.match(await tools.attach('made.txt'), /queued made\.txt/);
  assert.equal(tools.pendingParts[0].type, 'file');
  assert.match(tools.pendingParts[0].file.file_data, /^data:text\/plain;base64,/);
});

test('a write answers with a read-back of what it staged', async () => {
  const dir = mkTracked({});
  const tools = toolsIn(dir);
  const out = await tools.write('notes.txt', 'first line\nmiddle\nlast line');
  assert.match(out, /^wrote notes\.txt, 3 lines/);
  assert.match(out, /read-back: 1: first line/);
  assert.match(out, / \| 3: last line/, 'and the last line, so a body cut short shows');
});

test('CREATE over an existing file requires a read first', async () => {
  const dir = mkTracked({ 'notes.txt': 'original text\n' });
  const tools = toolsIn(dir);
  const refused = await tools.write('notes.txt', 'replacement\n');
  assert.match(refused, /^err: notes\.txt already exists on disk and has not been read/);
  assert.match(refused, /NEED file notes\.txt/, 'the way out is named');
  assert.equal(fs.readFileSync(`${dir}/notes.txt`, 'utf8'), 'original text\n', 'the disk was never touched');
  assert.match(tools.read('notes.txt'), /original text/, 'reading clears the gate');
  assert.match(await tools.write('notes.txt', 'replacement\n'), /^wrote notes\.txt/);
  // A file the run staged itself can be rewritten — it is the run's own work.
  assert.match(await tools.write('fresh.txt', 'one\n'), /^wrote fresh\.txt/);
  assert.match(await tools.write('fresh.txt', 'two\n'), /^wrote fresh\.txt/);
});

test('a missed FIND answers with the closest line, a repeated one with its places', async () => {
  const dir = mkTracked({ 'a.txt': 'const total = price * qty;\nconst label = "Total";\n' });
  const tools = toolsIn(dir);
  const missed = await tools.replace('a.txt', ['const total = price * quantity;', 'x']);
  assert.match(missed, /^err: the text to change was not found/);
  assert.match(missed, /closest line in the file: 1: "const total = price \* qty;"/);
  const twice = await tools.replace('a.txt', ['const ', 'let ']);
  assert.match(twice, /appears 2 times in a\.txt \(lines 1, 2\)/);
});

// A `**` spans any number of path segments, and the matcher tries every way
// of splitting the path for each one: 32 of them cost 2^32 attempts per
// file, which is seconds per file on a real tree.
test('a glob with too many ** segments is refused at once', async () => {
  const dir = mkTracked({ 'a.ts': 'a\n' });
  const tools = toolsIn(dir);
  const pattern = Array.from({ length: 32 }, () => '**').join('/');
  const started = Date.now();
  const out = await tools.glob(pattern);
  assert.match(out, /^err: the pattern has 32 "\*\*" segments — the cap is 8/);
  assert.ok(Date.now() - started < 2_000, 'and it is refused before the walk, not after it');
});

// Brace expansion recurses once per brace group, so a pattern with 20,000
// braces used to end the run with a RangeError.
test('a deeply nested brace pattern is refused, not a stack overflow', async () => {
  const dir = mkTracked({ 'a.ts': 'a\n' });
  const tools = toolsIn(dir);
  const pattern = `${'{'.repeat(20_000)}a${'}'.repeat(20_000)}`;
  const out = await tools.glob(pattern);
  assert.match(out, /^err: the pattern nests braces \d+ deep — the cap is 8/);
});

test('a brace pattern that expands too wide is refused, not silently cut', async () => {
  const dir = mkTracked({ 'a.ts': 'a\n' });
  const tools = toolsIn(dir);
  const out = await tools.glob('{a,b}{c,d}{e,f}{g,h}{i,j}{k,l}');
  assert.match(out, /^err: the pattern expands to more than 32 alternatives/);
});

// `read` had no ceiling at all: a multi-GB file answered with an
// out-of-memory crash instead of with a page.
test('read refuses a file past the cap instead of loading it', () => {
  const dir = mkTracked({});
  // A sparse file: the size is what the guard reads.
  const fd = fs.openSync(path.join(dir, 'huge.txt'), 'w');
  fs.ftruncateSync(fd, 2 * 1024 * 1024);
  fs.closeSync(fd);
  const tools = toolsIn(dir);
  const out = tools.read('huge.txt');
  assert.match(out, /^err: huge\.txt is 2 MB — the read cap is 1 MB/);
  assert.match(out, /Search it with SEARCH/, 'and the way out is named');
});

// A link out of the project is a link out of the root: the walks follow it
// only to find that it leaves.
test('SEARCH and GLOB do not walk into a link out of the project', async (t) => {
  const dir = mkTracked({ 'inside.txt': 'needle inside\n' });
  const outside = mkTracked({ 'secret.txt': 'needle outside\n' });
  try {
    fs.symlinkSync(outside, path.join(dir, 'away'), 'junction');
  } catch (err) {
    return t.skip(`links cannot be made here: ${err.code}`);
  }
  const tools = toolsIn(dir);
  const hits = await tools.search('needle');
  assert.match(hits, /inside\.txt/);
  assert.doesNotMatch(hits, /away/, 'the link out of the project is not searched');
  const listed = await tools.glob('**');
  assert.doesNotMatch(listed, /^away$/m, 'and it is not listed as a file of the project');
});

// The secret screen has to see the file a link really is: a link called
// "notes.txt" that points at a secret is the secret, whatever the link is
// named.
test('the secret screen sees the target of a link, not the name it borrows', async (t) => {
  const dir = mkTracked({ 'secrets.json': '{"token":"nope"}\n' });
  try {
    fs.symlinkSync(path.join(dir, 'secrets.json'), path.join(dir, 'notes.txt'), 'file');
  } catch (err) {
    return t.skip(`file links cannot be made here: ${err.code}`);
  }
  const tools = toolsIn(dir);
  const hits = await tools.search('nope');
  assert.doesNotMatch(hits, /notes\.txt/, 'the secret behind the link is not a search result');
});

test('FETCH refuses a name that resolves private, and one it cannot resolve', async () => {
  const transport = async () => new Response('never fetched', { status: 200 });
  const tools = toolsIn(mkTracked({}), { fetchTransport: transport });
  // `localhost.` is the same name to the resolver and a different one to the
  // literal check — the split the DNS pass exists to close.
  const priv = await tools.fetch('http://localhost./x');
  assert.match(priv, /^err: refusing to fetch localhost\./);
  assert.match(priv, /resolves to a private\/internal address/);
  // RFC 2606 reserves .invalid: it never resolves, so it cannot be vetted.
  const unknown = await tools.fetch('http://public.invalid/x');
  assert.match(unknown, /^err: refusing to fetch public\.invalid/);
  assert.match(unknown, /could not be resolved/);
});
