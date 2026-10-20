// The service worker, tested directly. The harness in harness.mjs stands in
// for the extension wholesale, so the worker's half of the conversation —
// taking a reply from the page and putting it on the wire — ran under test
// never.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadBackground } from './background-harness.mjs';
import { waitFor } from './harness.mjs';

// The assistant's id is the whole answer to a create-assistant job, and the
// bridge waits for it on /ext/assistant. The worker had no branch for that
// reply, so it was dropped: the job sat until it timed out, and the
// assistant was really created on the account all the same.
test('the assistant the page created is reported back to the bridge', async () => {
  const bg = loadBackground();

  bg.fromPage({ kind: 'assistant', jobId: 'j1', assistantId: 'asst_123', raw: '{}' });
  await waitFor(() => bg.posted('/ext/assistant').length > 0);

  const post = bg.posted('/ext/assistant')[0];
  assert.equal(post.method, 'POST');
  assert.equal(post.body.jobId, 'j1');
  assert.equal(post.body.assistantId, 'asst_123', 'the id is the answer the bridge is waiting for');
});

// A failed assistant creation carries the reason instead, so the bridge can
// fail the job with something better than "timed out waiting for the
// extension".
test('a failed assistant creation is reported with its reason', async () => {
  const bg = loadBackground();

  bg.fromPage({ kind: 'assistant', jobId: 'j2', message: 'createDraft returned no assistantId' });
  await waitFor(() => bg.posted('/ext/assistant').length > 0);

  const post = bg.posted('/ext/assistant')[0];
  assert.equal(post.body.jobId, 'j2');
  assert.equal(post.body.assistantId, undefined);
  assert.match(post.body.message, /createDraft/);
});

test('a text reply from the page is posted as a chunk', async () => {
  const bg = loadBackground();

  bg.fromPage({ kind: 'chunk', jobId: 'j3', parts: [{ kind: 'text', text: 'hello' }] });
  await waitFor(() => bg.posted('/ext/chunk').length > 0);

  const post = bg.posted('/ext/chunk')[0];
  assert.equal(post.body.jobId, 'j3');
  assert.deepEqual(post.body.parts, [{ kind: 'text', text: 'hello' }]);
});

test('the end of a job is posted as a done', async () => {
  const bg = loadBackground();

  bg.fromPage({ kind: 'done', jobId: 'j4', finishReason: 'stop' });
  await waitFor(() => bg.posted('/ext/done').length > 0);

  assert.equal(bg.posted('/ext/done')[0].body.finishReason, 'stop');
});
