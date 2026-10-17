// The compactor: what counts toward the upstream context, when the budget
// fires, and what a rotated conversation is seeded with. The end-to-end test
// drives the real agent through a mid-run rotation — the only path that can
// prove a long task survives crossing its budget halfway.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Compactor } from '../harness/compact.mjs';
import { Harness } from '../harness/harness.mjs';
import { startBridge, FakeExtension, scripted, tempDir, run, AGENT } from './harness.mjs';

let bridge;
before(async () => { bridge = await startBridge(); });
after(() => bridge.stop());

const agent = (dir, args = [], opts = {}) => run(AGENT, ['task text', '--root', dir, '--bridge', bridge.base, ...args], opts);

const sessionLike = (entries) => ({ entries });
const user = (text) => ({ type: 'user', text, bytes: Buffer.byteLength(text) });
const assistant = (text) => ({ type: 'assistant', text });
// summarize() reads the transcript off session.sentMessages() — user
// messages in send order, each with its own text.
const sentLike = (entries) => ({
  entries,
  sentMessages: () => entries.filter((e) => e.type === 'user').map((e, i) => ({ id: e.id ?? `u${i}`, text: e.text, ts: 0 })),
});
// The summariser talks to the bridge; these tests read the prompt it sends.
const captureBridge = (sent) => ({
  model: 'test-model',
  chat: async ({ message }) => { sent.push(String(message)); return { text: 'a summary' }; },
});

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

test('the divisor samples the current conversation, not what a rotation left behind', () => {
  const c = new Compactor({ keepRecentBytes: 0 });
  const thai = 'กขคงจฉชซญฎฑ'.repeat(400);   // 4400 chars, 13200 bytes
  const eng = 'a'.repeat(4000);
  // The rotated-away Thai must not drag the fresh Latin section's divisor
  // down: the estimate would read double the tokens and keep compacting early
  // for a conversation that is no longer what the divisor was measured on.
  const entries = [user(thai), { type: 'compaction', summary: 'old work' }, user(eng)];
  assert.equal(c.estimate(sessionLike(entries)), 1000);
  const flipped = [user(eng), { type: 'compaction', summary: 'old work' }, user(thai)];
  assert.equal(c.estimate(sessionLike(flipped)), 6600, 'fresh Thai still divides by two');
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
  const between = c.seed({ summary: 'did things', task: 'the task', preambleText: 'PRE' });
  assert.match(between, /Earlier work, already done/);
  assert.match(between, /What should I open first\?/);

  const mid = c.seed({
    summary: 'did things', task: 'the task', preambleText: 'PRE',
    results: 'Result of read big.txt:\n…contents…',
  });
  assert.match(mid, /Earlier work, already done/);
  assert.match(mid, /Result of read big\.txt/);
  assert.doesNotMatch(mid, /What should I open first\?/, 'the model is mid-task, not starting');

  // The two pins a rotation must not drop: the staged list (with deletes
  // marked) and the last check that has not passed, verbatim enough to act on.
  const pinned = c.seed({
    summary: 'did things', task: 'the task', preambleText: 'PRE',
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

// A manual compaction must re-seed the conversation with every marker the run
// has - the loop's own rotation passes them all, and a manual rotation that
// dropped SEARCH -i, ATTACH or a plugin's markers was a different run.
test('a manual compaction re-seeds with every marker the run has', async (t) => {
  const dir = tempDir({ 'a.txt': 'x\n' });
  const handler = scripted(['a tight summary of the work so far']);
  const ext = await new FakeExtension(bridge.base, { onChat: handler }).connect();
  t.after(() => ext.disconnect());

  const h = new Harness({
    root: dir,
    bridgeURL: bridge.base,
    options: {
      mode: 'ask', searchI: true, attach: true,
      pluginTools: [{ marker: 'ECHO', takesBody: false, description: 'echo it back' }],
    },
  });
  await h.startSession({ title: 'compact markers' });
  const { seedText } = await h.compactNow('keep the markers');

  assert.match(seedText, /NEED dir \./, 'the seed still carries the base preamble');
  assert.match(seedText, /-i first/, 'the SEARCH -i hint survives a manual compaction');
  assert.match(seedText, /ATTACH/, 'the ATTACH marker survives a manual compaction');
  assert.match(seedText, /ECHO/, "a plugin's marker survives a manual compaction");
});

// The between-runs rotation fires precisely when the session has grown — on
// the second run or later. The seed used to be gated on `first`, so the fresh
// conversation was left with a bare "the project is still open" message: the
// summary was paid for, recorded, and never sent, and the model restarted
// from nothing.
test('a between-runs rotation seeds the fresh conversation, first run or not', async (t) => {
  const dir = tempDir({ 'a.txt': 'x\n' });
  const handler = scripted([
    'DONE งานแรกเสร็จแล้ว',
    'the summary the second run carries',
    'DONE งานที่สองเสร็จแล้ว',
  ]);
  const ext = await new FakeExtension(bridge.base, { onChat: handler }).connect();
  t.after(() => ext.disconnect());

  const h = new Harness({
    root: dir,
    bridgeURL: bridge.base,
    // Tiny budget: run two must compact before it starts, which is exactly
    // the moment this test is about.
    compaction: { contextTokens: 60, reserveTokens: 0, keepRecentBytes: 0 },
  });
  await h.startSession({ title: 'between-runs' });
  await h.run('first task');
  await h.run('second task');

  assert.equal(handler.sent.length, 3, 'task one, the summary request, task two');
  assert.match(handler.sent[2], /Earlier work, already done/, 'the rotated conversation is seeded, not left empty');
  assert.match(handler.sent[2], /the summary the second run carries/, 'and the summary it paid for rides it');
  assert.match(handler.sent[2], /Task: second task/, "seeded with the run's own task");
  assert.ok(h.session.entries.some((e) => e.type === 'compaction'), 'the session records the boundary');
});

// /compact has no run in flight, so its summary has nowhere to ride until the
// next one — and that seed must be built against the next run's OWN task,
// which nobody knew at rotation time.
test('a manual /compact hands its summary to the next run, and to that run only', async (t) => {
  const dir = tempDir({ 'a.txt': 'x\n' });
  const handler = scripted([
    'DONE งานแรกเสร็จแล้ว',
    'the manual summary',
    'DONE งานที่สองเสร็จแล้ว',
    'DONE งานที่สามเสร็จแล้ว',
  ]);
  const ext = await new FakeExtension(bridge.base, { onChat: handler }).connect();
  t.after(() => ext.disconnect());

  const h = new Harness({ root: dir, bridgeURL: bridge.base });
  await h.startSession({ title: 'manual-seed' });
  await h.run('first task');
  const { summary } = await h.compactNow('keep going');
  h.rememberSummary(summary);   // what rpc's compact() does
  await h.run('second task');
  await h.run('third task');

  assert.equal(handler.sent.length, 4, 'task one, manual summary, seeded task two, plain task three');
  assert.match(handler.sent[2], /Earlier work, already done/, 'the manual rotation seeds the next run');
  assert.match(handler.sent[2], /the manual summary/);
  assert.match(handler.sent[2], /Task: second task/, "built against the run's own task, not the empty one at rotation time");
  assert.doesNotMatch(handler.sent[3], /Earlier work, already done/, 'consumed once — a second run must not repeat it');
});

// A rotation failure used to leave the compaction entry behind: the record
// said "compacted" while the upstream conversation still held everything,
// and the estimate reset against memory the model never carried.
test('a rotation that fails leaves no compaction entry behind', async (t) => {
  const dir = tempDir({ 'a.txt': 'x\n' });
  const handler = scripted(['DONE งานแรกเสร็จแล้ว', 'a summary that will never be used']);
  const ext = await new FakeExtension(bridge.base, { onChat: handler }).connect();
  t.after(() => ext.disconnect());

  const h = new Harness({ root: dir, bridgeURL: bridge.base });
  await h.startSession({ title: 'rotate-fail' });
  await h.run('first task');

  h.bridge.createConversation = async () => { throw new Error('the extension went away'); };
  await assert.rejects(() => h.compactNow('second try'), /the extension went away/);
  assert.equal(h.session.entries.some((e) => e.type === 'compaction'), false,
    'nothing is recorded for a rotation that never happened');
});

// The same failure mid-run: the loop must announce it and send the results
// anyway — losing the step's work to a compaction error is the worse outcome.
test('a mid-run rotation that fails keeps the run alive and the ledger honest', async (t) => {
  const dir = tempDir({ 'big.txt': `${'z'.repeat(6000)}\nmarker-end\n` });
  const handler = scripted([
    'Reading it now.\n\nNEED file big.txt',
    'a summary that will never be used',
    'DONE finished despite the failed rotation',
  ]);
  const ext = await new FakeExtension(bridge.base, { onChat: handler }).connect();
  t.after(() => ext.disconnect());

  const h = new Harness({
    root: dir,
    bridgeURL: bridge.base,
    // The same numbers the CLI end-to-end test tunes with, so the rotation
    // fires at the same point: after the big read, before its results go out.
    compaction: { contextTokens: 5000, keepRecentBytes: 200 },
  });
  await h.startSession({ title: 'rotate-fail-mid-run' });
  const errors = [];
  h.events.on('error', (e) => errors.push(e.message));
  const real = h.bridge.createConversation.bind(h.bridge);
  let creates = 0;
  h.bridge.createConversation = async (...args) => {
    if (++creates > 1) throw new Error('the extension went away');
    return real(...args);
  };

  const res = await h.run('read big.txt and finish');
  assert.match(res.summary, /finished despite the failed rotation/, 'the run carries on after the failure');
  assert.ok(errors.some((m) => /compaction failed/.test(m)), 'the failure is announced, not swallowed');
  assert.equal(h.session.entries.some((e) => e.type === 'compaction'), false, 'and nothing is recorded');
  assert.match(handler.sent.at(-1), /Result of read big\.txt/, 'the step results still went out');
});

/* -------------------------- the elision and memory tiers (context management) */

test('the elision tier is off unless asked; the memory tier is on unless switched off', () => {
  const c = new Compactor();
  assert.equal(c.elideStaleResults, false, 'the elision default stays with the queue record');
  assert.equal(c.carryMemory, true);
  assert.equal(new Compactor({ elideStaleResults: true }).elideStaleResults, true);
  assert.equal(new Compactor({ carryMemory: false }).carryMemory, false);

  process.env.AIPASS_ELIDE = '1';
  process.env.AIPASS_MEMORY = 'off';
  try {
    const env = new Compactor();
    assert.equal(env.elideStaleResults, true, 'AIPASS_ELIDE turns the tier on for a terminal run');
    assert.equal(env.carryMemory, false, 'AIPASS_MEMORY=off switches the tier off');
  } finally {
    delete process.env.AIPASS_ELIDE;
    delete process.env.AIPASS_MEMORY;
  }
});

test('the summary transcript slices as before while the elision tier is off', async () => {
  const sent = [];
  const c = new Compactor({ bridge: captureBridge(sent) });
  const entries = Array.from({ length: 12 }, (_, i) => user(`OLD-${i} ${'x'.repeat(3000)}`));
  const res = await c.summarize(sentLike(entries), { task: 't' });
  assert.equal(res, 'a summary', 'the reply is still the whole product');
  assert.ok(sent[0].includes('x'.repeat(600)), 'old sends ride the plain 1200-char slice');
  assert.doesNotMatch(sent[0], /elided \d+ chars/);
});

test('the elision tier cuts stale bulky sends to a counted head…tail stub', async () => {
  const sent = [];
  const c = new Compactor({ bridge: captureBridge(sent), elideStaleResults: true });
  // One distinct filler per message, so a whole-slice assertion names exactly
  // which message it is talking about. Twelve senders, the newest eight of
  // which are inside the recency window.
  const entries = Array.from({ length: 12 }, (_, i) => user(`OLD-${i}-HEAD ${String.fromCharCode(97 + i).repeat(3000)} OLD-${i}-TAIL`));
  await c.summarize(sentLike(entries), { task: 't' });
  const prompt = sent[0];
  assert.match(prompt, /elided 2542 chars of a stale tool result/, 'the marker counts the chars it saved');
  assert.ok(prompt.includes('OLD-2-HEAD') && prompt.includes('OLD-2-TAIL'), 'the head names what it was, the tail how it ended');
  assert.ok(!prompt.includes('c'.repeat(600)), 'the stale bulk is gone, not merely sliced');
  assert.ok(prompt.includes('e'.repeat(600)), 'the recency window keeps its slices whole');
});

test('the elision tier never touches short sends or the opening seed', async () => {
  const sent = [];
  const c = new Compactor({ bridge: captureBridge(sent), elideStaleResults: true });
  const entries = [
    user(`SEED-HEAD ${'s'.repeat(3000)} SEED-TAIL`), // the opening seed — stale, exempt
    user('SMALL-STALE-MESSAGE'),                    // stale, under the cut — untouched
    user(`BULK ${'z'.repeat(2000)}`),               // stale and bulky — the one elided
    ...Array.from({ length: 8 }, (_, i) => user(`recent ${i}`)),
  ];
  await c.summarize(sentLike(entries), { task: 't' });
  const prompt = sent[0];
  assert.ok(prompt.includes('s'.repeat(600)), 'the opening seed is never elided');
  assert.ok(prompt.includes('SMALL-STALE-MESSAGE'), 'short sends are never elided');
  assert.match(prompt, /elided \d+ chars/, 'the stale bulk past the window still is');
});

test('the summary reply splits into narrative and facts, leniently', () => {
  const c = new Compactor();
  const split = c.splitSummary('The work went well.\n\n**MEMORY:**\n- decision: keep the flag\n* constraint: never push without a word\n1. file: a.txt — the fixture\n- \n');
  assert.equal(split.summary, 'The work went well.');
  assert.deepEqual(split.memory, ['decision: keep the flag', 'constraint: never push without a word', 'file: a.txt — the fixture']);
  assert.deepEqual(c.splitSummary('no section here'), { summary: 'no section here', memory: [] }, 'no section, no facts — and nothing lost');
  assert.deepEqual(c.splitSummary(''), { summary: '', memory: [] });
});

test('facts merge across rotations: deduped, clipped, newest survive the cap', () => {
  const c = new Compactor();
  assert.deepEqual(
    c.mergeMemory(['decision: use the flag', 'file: a.txt — the fixture'], ['DECISION:   use the flag', 'constraint: no push without a word']),
    ['decision: use the flag', 'file: a.txt — the fixture', 'constraint: no push without a word'],
    'a restated fact rides once; case and spacing do not fork it',
  );
  const long = c.mergeMemory([], [`file: ${'p'.repeat(300)}`]);
  assert.equal(long[0].length, 200, 'one runaway fact is clipped to the cap');
  assert.ok(long[0].endsWith('…'));
  const many = c.mergeMemory(Array.from({ length: 25 }, (_, i) => `fact ${i}`), []);
  assert.equal(many.length, 20);
  assert.equal(many[0], 'fact 5', 'an overflow drops the oldest, never the newest');
  assert.equal(many.at(-1), 'fact 24');
});

test('digest merges against the session, and the off-switch means off', () => {
  const raw = 'Summary here.\n\nMEMORY:\n- decision: one more\n';
  const session = sessionLike([
    user('x'),
    { type: 'compaction', summary: 'older', memory: ['decision: from last time'] },
    user('y'),
  ]);
  assert.deepEqual(new Compactor().digest(session, raw), {
    summary: 'Summary here.',
    memory: ['decision: from last time', 'decision: one more'],
  });
  assert.deepEqual(new Compactor({ carryMemory: false }).digest(session, raw), { summary: 'Summary here.', memory: [] },
    'off means off, even with facts already on disk');
});

test('a seed carries the merged facts, and a seed without them is byte-identical to before', () => {
  const c = new Compactor();
  const plain = { summary: 'did things', task: 'the task', preambleText: 'PRE' };
  const before = c.seed(plain);
  assert.equal(c.seed({ ...plain, memory: [] }), before, 'no facts, no block — the old shape byte for byte');
  const withFacts = c.seed({ ...plain, memory: ['decision: keep the flag', 'file: a.txt — the fixture'] });
  assert.match(withFacts, /Facts carried from earlier rotations/);
  assert.match(withFacts, /- decision: keep the flag/);
  assert.match(withFacts, /- file: a\.txt — the fixture/);
  assert.doesNotMatch(before, /Facts carried/);
});

// The seam the loop actually uses: one rotation, one record, one seed — with
// the MEMORY: section the model writes riding from the summary reply onto the
// compaction entry and into the fresh conversation.
test('a mid-run rotation records the facts and seeds them into the fresh conversation', async (t) => {
  const dir = tempDir({ 'big.txt': `${'z'.repeat(6000)}\nmarker-end\n` });
  const handler = scripted([
    'Reading it now.\n\nNEED file big.txt',
    'a short summary of the work so far\n\nMEMORY:\n- decision: keep the elision flag off by default\n- file: big.txt — the fixture',
    'DONE finished with facts',
  ]);
  const ext = await new FakeExtension(bridge.base, { onChat: handler }).connect();
  t.after(() => ext.disconnect());

  const h = new Harness({
    root: dir,
    bridgeURL: bridge.base,
    compaction: { contextTokens: 5000, keepRecentBytes: 200 },
  });
  await h.startSession({ title: 'facts-mid-run' });
  const res = await h.run('read big.txt and finish');
  assert.match(res.summary, /finished with facts/);
  assert.equal(handler.sent.length, 3, 'task, summary request, seeded continuation');

  const record = h.session.entries.filter((e) => e.type === 'compaction').at(-1);
  assert.ok(record, 'the rotation is recorded');
  assert.equal(record.summary, 'a short summary of the work so far', 'the narrative records without its MEMORY tail');
  assert.deepEqual(record.memory, ['decision: keep the elision flag off by default', 'file: big.txt — the fixture']);

  assert.match(handler.sent[2], /Facts carried from earlier rotations/, 'the fresh conversation carries them');
  assert.match(handler.sent[2], /- file: big\.txt — the fixture/);
  assert.doesNotMatch(handler.sent[2], /MEMORY:/, 'the label itself does not leak — the facts do');
});

test("a manual rotation's facts ride the next run, and only that run", async (t) => {
  const dir = tempDir({ 'a.txt': 'x\n' });
  const handler = scripted([
    'DONE งานแรกเสร็จแล้ว',
    'the manual summary\n\nMEMORY:\n- constraint: never push without a word',
    'DONE งานที่สองเสร็จแล้ว',
    'DONE งานที่สามเสร็จแล้ว',
  ]);
  const ext = await new FakeExtension(bridge.base, { onChat: handler }).connect();
  t.after(() => ext.disconnect());

  const h = new Harness({ root: dir, bridgeURL: bridge.base });
  await h.startSession({ title: 'manual-facts' });
  await h.run('first task');
  const { summary, memory } = await h.compactNow('keep going');
  assert.deepEqual(memory, ['constraint: never push without a word']);
  h.rememberSummary(summary, memory); // what rpc's compact() does
  await h.run('second task');
  await h.run('third task');

  assert.equal(handler.sent.length, 4, 'task one, manual summary, seeded task two, plain task three');
  assert.match(handler.sent[2], /Facts carried from earlier rotations/, 'the manual seed carries the facts');
  assert.match(handler.sent[2], /- constraint: never push without a word/);
  assert.match(handler.sent[2], /Task: second task/, "built against the run's own task");
  assert.doesNotMatch(handler.sent[3], /Facts carried from earlier rotations/, 'consumed once — a second run must not repeat it');
});
