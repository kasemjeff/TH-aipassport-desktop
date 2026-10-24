// The tab a job runs in. A job that arrives while no de.aipass.net tab is open
// used to be refused; now the worker opens one. These tests pin that it opens
// exactly one however many jobs are waiting, reuses a tab that exists, and says
// so honestly when Chrome refuses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadBackground } from './background-harness.mjs';
import { waitFor } from './harness.mjs';

const job = (id) => `event: job\ndata: ${JSON.stringify({ jobId: id, kind: 'chat' })}\n\n`;
const runs = (bg) => bg.sent.filter((m) => m.message?.type === 'run');

test('two jobs that arrive while no tab is open share one new tab', async () => {
  const bg = loadBackground({ firstFrames: job('a') + job('b') });
  await waitFor(() => runs(bg).length === 2);

  assert.equal(bg.created.length, 1, 'one tab was opened, not one per job');
  const [first, second] = runs(bg);
  assert.equal(first.tabId, second.tabId, 'both jobs run in the same tab');
});

test('a tab that is already open is reused, not duplicated', async () => {
  // No scheme on purpose: the worker only looks for the chat route in the url.
  const bg = loadBackground({
    firstFrames: job('c'),
    initialTabs: [{ id: 7, url: 'de.aipass.net/chat', status: 'complete' }],
  });
  await waitFor(() => runs(bg).length === 1);

  assert.equal(bg.created.length, 0, 'no second session was opened');
  assert.equal(runs(bg)[0].tabId, 7);
});

test('a tab that cannot be opened is reported with its reason', async () => {
  const bg = loadBackground({ firstFrames: job('d'), createError: 'the browser is closing' });
  await waitFor(() => bg.posted('/ext/error').length > 0);

  const post = bg.posted('/ext/error')[0];
  assert.equal(post.body.jobId, 'd');
  assert.match(post.body.message, /could not open a de\.aipass\.net tab: the browser is closing/);
  assert.equal(runs(bg).length, 0, 'nothing was sent to a tab that does not exist');
});

test('open-chat-tab message reuses existing tab without opening a duplicate', async () => {
  const bg = loadBackground({
    initialTabs: [{ id: 42, url: 'https://de.aipass.net/chat', status: 'complete' }],
  });
  const res = await bg.sendMessage({ type: 'open-chat-tab' });
  assert.equal(res.ok, true);
  assert.equal(res.tabId, 42);
  assert.equal(bg.created.length, 0, 'did not create a second tab');
});
