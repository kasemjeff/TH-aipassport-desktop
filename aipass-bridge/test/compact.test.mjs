// The compactor: what counts toward the upstream context, when the budget
// fires, and what a rotated conversation is seeded with. The end-to-end test
// drives the real agent through a mid-run rotation — the only path that can
// prove a long task survives crossing its budget halfway.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Compactor } from '../harness/compact.mjs';
import { startBridge, FakeExtension, scripted, tempDir, run, AGENT } from './harness.mjs';

let bridge;
before(async () => { bridge = await startBridge(); });
after(() => bridge.stop());

const agent = (dir, args = [], opts = {}) => run(AGENT, ['task text', '--root', dir, '--bridge', bridge.base, ...args], opts);

const sessionLike = (entries) => ({ entries });
const user = (text) => ({ type: 'user', text, bytes: Buffer.byteLength(text) });
const assistant = (text) => ({ type: 'assistant', text });

test('estimate counts the current conversation only — entries before the last compaction were rotated away', () => {
  const c = new Compactor({ keepRecentBytes: 0 });
  const entries = [
    user('x'.repeat(4000)),
    { type: 'compaction', summary: 'earlier work, summarized' },
    user('y'.repeat(4000)),
  ];
  // Without the reset this estimate would be 2000 forever, and every later
  // run would compact again the moment it started.
  assert.equal(c.estimate(sessionLike(entries)), 1000);
});

test('assistant replies sit in the server context and count alongside the user messages', () => {
  const c = new Compactor({ keepRecentBytes: 0 });
  const entries = [user('a'.repeat(2000)), assistant('b'.repeat(2000))];
  assert.equal(c.estimate(sessionLike(entries)), 1000);
});

test('pending counts the message being assembled, before it is sent', () => {
  const c = new Compactor({ keepRecentBytes: 0 });
  const entries = [user('a'.repeat(4000))];
  assert.equal(c.estimate(sessionLike(entries)), 1000);
  assert.equal(c.estimate(sessionLike(entries), { pending: 'a'.repeat(4000) }), 2000);
});

test('pending is measured after the WAF rewrites, not before (H6)', () => {
  const c = new Compactor({ keepRecentBytes: 0 });
  // 571 URLs, 7 bytes each as written on disk: the server receives HTTP-URL,
  // 8 bytes each. The expansion is part of what the next request carries, so
  // the rotation decision has to see 4568 bytes (1142 tokens), not 3997.
  const raw = 'http://'.repeat(571);
  assert.equal(c.estimate(sessionLike([]), { pending: raw }), 1142);
});

test('keepRecentBytes stays out of the estimate', () => {
  const c = new Compactor({ keepRecentBytes: 1000 });
  const entries = [user('a'.repeat(4000))];
  assert.equal(c.estimate(sessionLike(entries)), 750);
});

test('Latin text divides by four, a mixed conversation by three, Thai by two', () => {
  const c = new Compactor({ keepRecentBytes: 0 });
  const eng = 'abcdefghij'.repeat(400); // 4000 bytes, all ASCII
  assert.equal(c.estimate(sessionLike([user(eng)])), 1000);

  const mostlyEng = 'abcdefghij'.repeat(900) + 'กขคงจฉชซญฎฑฐ'.repeat(100); // 1200 of 10200 chars Thai
  assert.equal(c.estimate(sessionLike([user(mostlyEng)])), 4200, 'a real mix divides by three');

  const thai = 'กขคงจฉชซญฎฑ'.repeat(200); // 2200 chars, 6600 bytes of Thai
  assert.equal(c.estimate(sessionLike([user(thai)])), 3300, 'Thai costs about twice the tokens per byte');
});

test('needsCompaction fires against the budget of the model in use', () => {
  const c = new Compactor({ contextTokens: 1000, reserveTokens: 100, keepRecentBytes: 0 });
  assert.equal(c.needsCompaction(sessionLike([user('a'.repeat(4000))])), true, '1000 tokens > 900');
  assert.equal(c.needsCompaction(sessionLike([user('a'.repeat(2000))])), false, '500 tokens < 900');

  const flash = new Compactor({ contextTokens: 1000, reserveTokens: 100, keepRecentBytes: 0, budgets: { flash: 10_000 } });
  flash.bridge = { model: 'gemini-3.1-flash-lite' };
  assert.equal(flash.needsCompaction(sessionLike([user('a'.repeat(4000))])), false, 'the flash budget is 10k');
  assert.equal(new Compactor().budgetFor(null), 24_000, 'no model, no map — the conservative default');
});

test('AIPASS_CONTEXT_TOKENS overrides the budget for a terminal run', () => {
  process.env.AIPASS_CONTEXT_TOKENS = '1234';
  try {
    assert.equal(new Compactor().budgetFor('any-model'), 1234);
  } finally {
    delete process.env.AIPASS_CONTEXT_TOKENS;
  }
});

test('seed keeps its between-runs shape, and pastes the step results on a mid-run rotation', () => {
  const c = new Compactor();
  const between = c.seed({ summary: 'did things', task: 'the task', listing: '', preambleText: 'PRE' });
  assert.match(between, /Earlier work, already done/);
  assert.match(between, /What should I open first\?/);

  const mid = c.seed({
    summary: 'did things', task: 'the task', listing: '', preambleText: 'PRE',
    results: 'Result of read big.txt:\n…contents…',
  });
  assert.match(mid, /Earlier work, already done/);
  assert.match(mid, /Result of read big\.txt/);
  assert.doesNotMatch(mid, /What should I open first\?/, 'the model is mid-task, not starting');

  // The two pins a rotation must not drop: the staged list (with deletes
  // marked) and the last check that has not passed, verbatim enough to act on.
  const pinned = c.seed({
    summary: 'did things', task: 'the task', listing: '', preambleText: 'PRE',
    staged: ['math.mjs', 'old.txt (deleted)'],
    lastCheck: { verdict: 'fail', text: 'FAIL: add(2,3) = 0' },
  });
  assert.match(pinned, /Staged but not on disk yet/);
  assert.match(pinned, /- math\.mjs/);
  assert.match(pinned, /- old\.txt \(deleted\)/);
  assert.match(pinned, /did not pass \(fail\)/);
  assert.match(pinned, /FAIL: add\(2,3\) = 0/);
  assert.match(pinned, /Task: the task/, 'the task stays verbatim');
  assert.doesNotMatch(between, /Staged but not on disk/, 'no staged files, no block');
});

test('a long run rotates mid-run: summarise, fresh conversation, results still delivered', async (t) => {
  const dir = tempDir({ 'big.txt': `${'z'.repeat(6000)}\nmarker-end\n` });
  const handler = scripted([
    'Reading it now.\n\nNEED file big.txt',
    'a short summary of the work so far',
    'DONE finished after rotating',
  ]);
  const ext = await new FakeExtension(bridge.base, { onChat: handler }).connect();
  t.after(() => ext.disconnect());

  // The tuned defaults (24k tokens, 6k kept) would need a huge fixture; the
  // env is the CLI's tuning channel, and these numbers put the threshold a
  // step past the turn-1 preamble but well under the big read's paste.
  const { out } = await agent(dir, [], { env: { AIPASS_CONTEXT_TOKENS: '5000', AIPASS_KEEP_RECENT_BYTES: '200' } });

  assert.match(out, /finished after rotating/);
  assert.equal(handler.sent.length, 3, 'task, summary request, seeded continuation');
  assert.match(handler.sent[1], /Summarise the work carried out so far/);
  assert.match(handler.sent[2], /Earlier work, already done/);
  assert.match(handler.sent[2], /a short summary of the work so far/, 'the summary the fresh conversation is seeded with');
  // The step's results survive the rotation clipped, and with a locator for the
  // rest: read() caps a long page and spills it to .aipass/spill, so the tail
  // of big.txt is on disk and the seeded message names where to read it. What
  // no longer holds is that the whole file rides the message verbatim - the
  // cap is the point, and the locator is what keeps the tail reachable.
  assert.match(handler.sent[2], /Result of read big\.txt:/, 'the step results survive the rotation');
  assert.match(handler.sent[2], /\.aipass\/spill\/[a-f0-9]+\.txt/, 'and the spilled tail is reachable from it');
  assert.equal(ext.created.length, 2, 'the starting conversation plus the rotation');
});
