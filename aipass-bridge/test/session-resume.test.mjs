// Session resume: a session owns its model-side conversation.
//
// Three defects this pins down. (1) Bleed: opening or creating another session
// used to keep talking in whatever conversation the harness was last on, so
// one session's messages landed in another session's history. (2) Amnesia: a
// session reopened without its conversation (an old file, a fresh process)
// was told "the project is still open" with no memory of the work, and the
// facts meant for a first run never rode a resumed one. (3) A conversation
// that is gone upstream (a temporary that expired) used to end the run.
//
// The binding is persisted on the session header, adopted at open, and
// followed only once a conversation has actually taken a message — a run that
// dies before sending leaves the next one free to start from the transcript.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Harness } from '../harness/harness.mjs';
import { SessionStore } from '../harness/session.mjs';
import { startBridge, FakeExtension, scripted, tempDir } from './harness.mjs';

let bridge;
before(async () => { bridge = await startBridge(); });
after(() => bridge.stop());

const storeFor = () => new SessionStore(tempDir());

test("a new session gets its own conversation, not the previous session's", async (t) => {
  const dir = tempDir({ 'a.txt': 'x\n' });
  const handler = scripted(['DONE งานแรกเสร็จแล้ว', 'DONE งานที่สองเสร็จแล้ว']);
  const ext = await new FakeExtension(bridge.base, { onChat: handler, uniqueTemporaryIds: true }).connect();
  t.after(() => ext.disconnect());

  const store = storeFor();
  const h = new Harness({ root: dir, bridgeURL: bridge.base, store });
  await h.startSession({ title: 'A' });
  await h.run('งานแรก');
  const idA = h.session.id;
  const convA = store.load(idA).header.conversation;
  assert.ok(convA, 'the session records the conversation it worked in');

  // /new in the same process: the next session must not continue in A's.
  await h.startSession({ title: 'B' });
  assert.equal(h.conversation, null, 'a new session starts with no conversation');
  await h.run('งานที่สอง');

  assert.notEqual(store.load(h.session.id).header.conversation, convA, 'B recorded its own conversation');
  assert.equal(ext.chats.length, 2);
  assert.notEqual(ext.chats[1].conversationId, convA, "B's send did not land in A's conversation");
});

test('reopening a session adopts its own conversation instead of a new one', async (t) => {
  const dir = tempDir({ 'a.txt': 'x\n' });
  const handler = scripted(['DONE งานแรกเสร็จแล้ว', 'DONE งานที่สองเสร็จแล้ว']);
  const ext = await new FakeExtension(bridge.base, { onChat: handler, uniqueTemporaryIds: true }).connect();
  t.after(() => ext.disconnect());

  const store = storeFor();
  const h1 = new Harness({ root: dir, bridgeURL: bridge.base, store });
  await h1.startSession({ title: 'warm' });
  await h1.run('งานแรก');
  const id = h1.session.id;
  const conv = h1.conversation;
  assert.equal(ext.created.length, 1, 'one conversation so far');

  // A fresh process over the same store: reopen and continue. The upstream
  // still holds the history, so nothing needs re-seeding — the run goes into
  // the same conversation it was written against.
  const h2 = new Harness({ root: dir, bridgeURL: bridge.base, store });
  await h2.startSession({ sessionId: id });
  assert.equal(h2.conversation, conv, 'the binding is adopted at open');
  await h2.run('งานที่สอง');

  assert.equal(ext.created.length, 1, 'no new conversation was made');
  assert.equal(ext.chats.at(-1).conversationId, conv, "the run continued in the session's own conversation");
  assert.doesNotMatch(handler.sent.at(-1), /no longer attached/, 'a warm resume needs no digest');
});

test('a session reopened without its conversation is seeded from its transcript', async (t) => {
  const dir = tempDir({ 'a.txt': 'x\n' });
  const handler = scripted([
    'อ่านแล้วครับ\n\nTODO\n- [ ] finish the report\n- [x] read a.txt\nEND\nDONE งานแรกเสร็จแล้ว',
    'DONE ปิดงานแรกแล้ว',
    'DONE งานที่สองเสร็จแล้ว',
  ]);
  const ext = await new FakeExtension(bridge.base, { onChat: handler, uniqueTemporaryIds: true }).connect();
  t.after(() => ext.disconnect());

  const store = storeFor();
  const h1 = new Harness({ root: dir, bridgeURL: bridge.base, store });
  await h1.startSession({ title: 'amnesia' });
  await h1.run('งานแรก');
  const id = h1.session.id;
  assert.equal(handler.sent.length, 2, 'the task and the plan-checkpoint nudge');

  // Simulate a file written before bindings existed (or one whose conversation
  // was dropped): no header binding, so the reopened run has nowhere warm to go.
  store.load(id).bindConversation(null);

  // Tiny budget on purpose: without the resume seed's recorded boundary, the
  // stale transcript estimate would fire a rotation at run start — asking a
  // model that just met this session to summarise it.
  const h2 = new Harness({ root: dir, bridgeURL: bridge.base, store, compaction: { contextTokens: 60, reserveTokens: 0, keepRecentBytes: 0 } });
  await h2.startSession({ sessionId: id });
  assert.equal(h2.conversation, null, 'nothing warm to adopt');
  await h2.run('งานที่สอง');

  assert.equal(handler.sent.length, 3, 'no summary request — only the seeded first send');
  const seed = handler.sent[2];
  assert.match(seed, /no longer attached/, 'the seed says the old conversation is gone');
  assert.match(seed, /- งานแรก/, 'the tasks the session was given ride the digest');
  assert.match(seed, /DONE ปิดงานแรกแล้ว/, "the model's own last words ride it");
  assert.match(seed, /\[ \] finish the report/, 'the open checklist rides it');
  assert.match(seed, /Task: งานที่สอง/, "and the run's own task");
  const boundary = h2.session.entries.filter((e) => e.type === 'compaction').at(-1);
  assert.ok(boundary?.lastSummarizedEntryId, 'the folded boundary is recorded once the seed went out');
});

test('a conversation that is gone upstream is replaced and the run continues', async (t) => {
  const dir = tempDir({ 'a.txt': 'x\n' });
  const sent = [];
  const dead = [];
  const replies = ['DONE งานแรกเสร็จแล้ว', 'DONE งานที่สองเสร็จแล้ว'];
  let turn = 0;
  // The conversation is alive while the first session works; it is gone by the
  // time the session is reopened (a temporary that expired).
  let gone = false;
  const handler = async (job, e) => {
    if (gone && job.conversationId === 'tmp0001') { dead.push(job.text); return void e.error('conversation not found'); }
    sent.push(job.text);
    await e.text(replies[Math.min(turn++, replies.length - 1)]);
    await e.done();
  };
  const ext = await new FakeExtension(bridge.base, { onChat: handler, uniqueTemporaryIds: true }).connect();
  t.after(() => ext.disconnect());

  const store = storeFor();
  const h1 = new Harness({ root: dir, bridgeURL: bridge.base, store });
  await h1.startSession({ title: 'expired' });
  await h1.run('งานแรก');
  const id = h1.session.id;
  assert.equal(ext.created.length, 1);
  gone = true;

  const h2 = new Harness({ root: dir, bridgeURL: bridge.base, store });
  await h2.startSession({ sessionId: id });
  const res = await h2.run('งานที่สอง');

  assert.equal(res.stopReason, 'done', 'the run finished instead of dying on the dead conversation');
  assert.equal(dead.length, 1, 'the adopted conversation was tried once');
  assert.equal(ext.created.length, 2, 'a fresh conversation was made');
  assert.equal(sent.length, 2, 'the first task and the retried send');
  assert.match(sent[1], /no longer attached/, 'the retry carried the transcript digest, not a blind "still open"');
  assert.match(sent[1], /Task: งานที่สอง/);
  assert.equal(h2.session.header.conversation, 'tmp0002', 'the session rebound to the fresh conversation');
});
