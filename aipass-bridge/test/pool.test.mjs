// P2-A and P2-B end to end, against the real bridge surface: the ATTACH
// marker, WEB's scratch conversation, helpers running beside each other, and
// a client that names its own conversation per request.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startBridge, FakeExtension, tempDir, run, AGENT } from './harness.mjs';

let bridge;
before(async () => { bridge = await startBridge(); });
after(() => bridge.stop());

const agent = (dir, args = [], opts = {}) => run(AGENT, ['task text', '--root', dir, '--bridge', bridge.base, ...args], opts);

test('a client may name the conversation per request (P2-B)', async (t) => {
  const jobs = [];
  const handler = async (job, e) => {
    if (job.kind !== 'chat') return;
    jobs.push(job);
    await e.text('the named conversation answered');
    await e.done();
  };
  const ext = await new FakeExtension(bridge.base, { onChat: handler }).connect();
  t.after(() => ext.disconnect());

  const res = await fetch(`${bridge.base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      stream: false,
      conversation: 'pooltest00000001',
      messages: [{ role: 'user', content: 'hello' }],
    }),
  });
  assert.ok(res.ok, await res.text());
  assert.equal(jobs[0].conversationId, 'pooltest00000001');
});

test('ATTACH rides the next message, and a DONE beside it does not drop it', async (t) => {
  const dir = tempDir({ 'shot.png': '\x89PNG\r\n\x1a\n\x00\x01\x02' });
  const jobs = [];
  let parentTurns = 0;
  const handler = async (job, e) => {
    if (job.kind !== 'chat') return;
    jobs.push(job);
    const reply = parentTurns++ === 0
      ? 'Attaching it.\n\nATTACH shot.png\n\nDONE look at that'
      : 'DONE attached and done';
    await e.text(reply);
    await e.done();
  };
  const ext = await new FakeExtension(bridge.base, { onChat: handler }).connect();
  t.after(() => ext.disconnect());

  const { out } = await agent(dir, ['--attach']);
  assert.match(out, /attached and done/);
  assert.equal(jobs.length, 2, 'ATTACH + DONE in one reply must not end the run');
  // The job's own parts array carries the text part too; what matters is the
  // attachment beside it.
  assert.equal((jobs[0].parts ?? []).filter((p) => p.type !== 'text').length, 0, 'the first message carries no attachment');
  const attached = jobs[1].parts.filter((p) => p.type !== 'text');
  assert.equal(attached.length, 1);
  assert.equal(attached[0].type, 'image');
  assert.match(attached[0].image, /^data:image\/png;base64,/);
});

test('WEB spends a scratch conversation, not the working one (P2-B)', async (t) => {
  const dir = tempDir({});
  const jobs = [];
  let parentTurns = 0;
  const handler = async (job, e) => {
    if (job.kind !== 'chat') return;
    jobs.push(job);
    if (job.text.includes('Please search the web')) {
      await e.text('search says: node 26 is current');
      return void e.done();
    }
    const reply = parentTurns++ === 0
      ? 'Let me look it up.\n\nWEB node version'
      : 'DONE looked up';
    await e.text(reply);
    await e.done();
  };
  const ext = await new FakeExtension(bridge.base, { onChat: handler, uniqueTemporaryIds: true }).connect();
  t.after(() => ext.disconnect());

  const { out } = await agent(dir, ['--web-scratch']);
  assert.match(out, /looked up/);

  const searchJob = jobs.find((j) => j.text.includes('Please search the web'));
  const parentJobs = jobs.filter((j) => !j.text.includes('Please search the web'));
  assert.ok(searchJob && parentJobs.length >= 2);
  assert.notEqual(searchJob.conversationId, parentJobs[0].conversationId, 'the lookup runs on the scratch conversation');
  assert.ok(parentJobs[1].text.includes('node 26 is current'), 'the result still reaches the working conversation');
});

test('two helpers of one reply run beside each other, each on its own conversation (P2-B)', async (t) => {
  const dir = tempDir({ 'a.txt': 'alpha\n', 'b.txt': 'beta\n' });
  const jobs = [];
  let parentTurns = 0;
  const handler = async (job, e) => {
    if (job.kind !== 'chat') return;
    jobs.push(job);
    if (job.text.includes('want to know: read a.txt')) { await e.text('DONE summary of a'); return void e.done(); }
    if (job.text.includes('want to know: read b.txt')) { await e.text('DONE summary of b'); return void e.done(); }
    const reply = parentTurns++ === 0
      ? 'Handing off.\n\nSUBAGENT\ntask: read a.txt\nEND\n\nSUBAGENT\ntask: read b.txt\nEND'
      : 'DONE both helpers reported';
    await e.text(reply);
    await e.done();
  };
  const ext = await new FakeExtension(bridge.base, { onChat: handler, uniqueTemporaryIds: true }).connect();
  t.after(() => ext.disconnect());

  const { out } = await agent(dir, ['--subagent', '--parallel-helpers']);
  assert.match(out, /both helpers reported/);

  const parent = jobs.filter((j) => !/want to know: read [ab]\.txt/.test(j.text));
  const helpers = jobs.filter((j) => /want to know: read [ab]\.txt/.test(j.text));
  assert.equal(helpers.length, 2);
  const conversations = new Set(helpers.map((j) => j.conversationId));
  assert.equal(conversations.size, 2, 'each helper has its own conversation');
  assert.ok(!conversations.has(parent[0].conversationId), 'neither helper sits on the parent conversation');
  assert.equal(parent[0].conversationId, parent[1].conversationId, 'the parent never leaves its conversation');
  assert.ok(parent[1].text.includes('summary of a') && parent[1].text.includes('summary of b'), 'both summaries reach the results message');
});
