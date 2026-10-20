// The content script, tested directly. Everything here was previously covered by
// nothing: the harness in harness.mjs stands in for the extension, so the frame
// decoder, the media routing and the reattach never ran under test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPage, sseResponse, brokenStream } from './page-harness.mjs';

const chatJob = (over = {}) => ({
  jobId: 'j1', kind: 'chat', conversationId: 'conv1', modelId: 'gemini-3.1-flash-lite',
  text: 'hi', parts: [{ type: 'text', text: 'hi' }], ...over,
});

const textFrames = (t) => [
  { type: 'text-delta', delta: t },
  { type: 'finish', finishReason: 'stop' },
];

test('page-ready is announced as soon as the script loads', () => {
  const page = loadPage({ onFetch: async () => ({}) });
  assert.ok(page.sent.some((m) => m.kind === 'page-ready'));
});

test('a text answer streams back as text parts', async () => {
  const page = loadPage({ onFetch: async () => sseResponse(textFrames('สวัสดี')) });
  page.run(chatJob());
  await page.settled('j1');
  assert.equal(page.parts('j1').filter((p) => p.kind === 'text').map((p) => p.text).join(''), 'สวัสดี');
});

// The edge 403s by pace score as well as by content (harness/bridge.mjs
// EDGE_WAITS_MS has the recording): the message is refused whole and the
// identical bytes go through a moment later. The page waits one out in place
// and sends the same body again — it must not rewrite anything, and it must
// not surface a refusal that only the message layer could mend by splitting.
test('a 403 blip is waited out, and the identical body goes again', async () => {
  let sends = 0;
  const page = loadPage({
    fastTimers: true,
    onFetch: async (url) => {
      if (url.includes('/actions/send-message/') && ++sends === 1) {
        return new Response('', { status: 403, statusText: 'Forbidden', headers: { server: 'cloudflare' } });
      }
      return sseResponse(textFrames('สวัสดี'));
    },
  });
  page.run(chatJob());
  await page.settled('j1');

  const posts = page.requests.filter((r) => r.url.includes('/actions/send-message/'));
  assert.equal(posts.length, 2, 'one refusal, then one resend');
  assert.equal(posts[1].init.body, posts[0].init.body, 'the body went again untouched');
  assert.ok(page.parts('j1').some((p) => p.kind === 'note' && /403/.test(p.text)), 'the pause is explained on the wire');
  assert.equal(page.parts('j1').filter((p) => p.kind === 'text').map((p) => p.text).join(''), 'สวัสดี');
});

test('a 403 that outlasts the waits surfaces with its forensics', async () => {
  let sends = 0;
  const page = loadPage({
    fastTimers: true,
    onFetch: async (url) => {
      if (url.includes('/actions/send-message/')) {
        sends++;
        return new Response('', { status: 403, statusText: 'Forbidden', headers: { server: 'cloudflare' } });
      }
      return sseResponse([]);
    },
  });
  page.run(chatJob());
  const end = await page.settled('j1');

  assert.equal(end.kind, 'error');
  assert.equal(sends, 3, 'the first send plus two bounded waits, then it surfaces');
  assert.match(end.message, /aipass returned 403/);
  assert.match(end.message, /refused at the edge through 2 retries/);
  assert.match(end.message, /server=cloudflare/);
});

// Regression for the frame that used to be dumped into the answer as raw JSON,
// and for sonar, which sends only this and no source-url.
test('web search results become titled sources, not JSON in the answer', async () => {
  const page = loadPage({ onFetch: async () => sseResponse([
    { type: 'text-delta', delta: 'answer' },
    { type: 'data-web_search_results', data: { links: [
      { url: 'https://bbc.com/a', title: 'BBC ไทย', domain: 'bbc.com' },
      { url: 'https://thaigov.go.th/b', domain: 'thaigov.go.th' },
    ] } },
    { type: 'finish', finishReason: 'stop' },
  ]) });
  page.run(chatJob());
  await page.settled('j1');

  const all = page.parts('j1');
  assert.ok(!all.some((p) => /data-web_search_results/.test(p.text)), 'the frame must not reach the answer');
  assert.ok(!all.some((p) => /unhandled/.test(p.text)), 'and must not be reported as unknown');
  const sources = all.find((p) => p.kind === 'status' && p.text.startsWith('sources:'));
  assert.match(sources.text, /BBC ไทย https:\/\/bbc\.com\/a/);
  assert.match(sources.text, /thaigov\.go\.th https:\/\/thaigov\.go\.th\/b/, 'no title falls back to the domain');
});

// The live stall of Oct 2026: the site swapped the run's model mid-reply and
// the frame fell to the unknown handler, where the text died inside the
// reasoning fold. It must arrive as a note — a line the person can see.
test('a mid-reply model switch surfaces as a note, not an unhandled frame', async () => {
  const page = loadPage({ onFetch: async () => sseResponse([
    { type: 'text-delta', delta: 'answer' },
    { type: 'data-model_switched', modelId: 'gemini-3.5-flash-lite' },
    { type: 'finish', finishReason: 'stop' },
  ]) });
  page.run(chatJob());
  await page.settled('j1');

  const all = page.parts('j1');
  assert.ok(!all.some((p) => /unhandled/.test(p.text)), 'a known frame must not be reported as unknown');
  const note = all.find((p) => p.kind === 'note');
  assert.ok(note, 'the switch reaches the bridge as a note part');
  assert.match(note.text, /gemini-3\.5-flash-lite/);
});

test('generated media is routed by its media type', async () => {
  const cases = [
    ['audio/mpeg', 'audio'],
    ['video/mp4', 'video'],
    ['image/png', 'image'],
    ['application/pdf', 'file'],
  ];
  for (const [mediaType, kind] of cases) {
    const page = loadPage({ onFetch: async () => sseResponse([
      { type: 'file', mediaType, url: 'https://storage.googleapis.com/x/y.bin?X-Goog-Signature=a' },
      { type: 'finish', finishReason: 'stop' },
    ]) });
    page.run(chatJob());
    await page.settled('j1');
    assert.ok(page.parts('j1').some((p) => p.kind === kind), `${mediaType} should route to ${kind}`);
  }
});

// The shape a real seedance run returns: no `url` at all. Reading only `url`
// discarded every generated video in silence.
test('a video part carrying snapshotUrl and no url is not dropped', async () => {
  const page = loadPage({ onFetch: async () => sseResponse([
    { type: 'file', mediaType: 'video/mp4', filename: '01a065f9.mp4',
      storageKey: 'video-generations/x', snapshotUrl: 'https://storage.googleapis.com/v.mp4?X-Goog-Signature=b' },
    { type: 'finish', finishReason: 'stop' },
  ]) });
  page.run(chatJob());
  await page.settled('j1');
  const video = page.parts('j1').find((p) => p.kind === 'video');
  assert.ok(video, 'snapshotUrl must be read when url is absent');
  assert.equal(video.filename, '01a065f9.mp4');
  assert.match(video.text, /X-Goog-Signature=b/, 'the signature must survive or the link is dead');
});

test('a signed storage link is passed through, not fetched and inlined', async () => {
  const page = loadPage({ onFetch: async () => sseResponse([
    { type: 'file', mediaType: 'audio/mpeg', url: 'https://storage.googleapis.com/m.mp3?X-Goog-Signature=c' },
    { type: 'finish', finishReason: 'stop' },
  ]) });
  page.run(chatJob());
  await page.settled('j1');
  assert.equal(page.requests.length, 1, 'only the send-message call — a public link needs no cookie');
  assert.match(page.parts('j1').find((p) => p.kind === 'audio').text, /^https:\/\/storage\.googleapis\.com/);
});

// fetch does not reject on a 4xx or a 5xx, and the body of one is an error
// page, not the media. Reading it anyway carried a login page back as if it
// were the picture.
test('a media URL that answers with an error is not carried inline', async () => {
  const page = loadPage({
    onFetch: async (url) => (url.includes('/actions/send-message')
      ? sseResponse([
        { type: 'file', mediaType: 'image/png', url: '/media/shot.png' },
        { type: 'finish', finishReason: 'stop' },
      ])
      : new Response('<html>please sign in</html>', { status: 401, headers: { 'content-type': 'text/html' } })),
  });

  page.run(chatJob());
  await page.settled('j1');

  const parts = page.parts('j1');
  const media = parts.find((p) => p.kind === 'image');
  assert.ok(media, 'the media is still reported');
  assert.match(media.text, /\/media\/shot\.png$/, 'as the link, not as the error page');
  assert.doesNotMatch(media.text, /data:/, 'the error body must not be carried inline');
  assert.ok(parts.some((p) => p.kind === 'status' && /could not read it here/.test(p.text)),
    'and the caller is told why');
});

// A frame can carry `url: ""` beside a real `snapshotUrl`, and `??` keeps the
// empty string — which loses the media altogether.
test('a media frame with an empty url still uses its snapshotUrl', async () => {
  const page = loadPage({
    onFetch: async () => sseResponse([
      { type: 'file', mediaType: 'video/mp4', url: '', snapshotUrl: 'https://storage.googleapis.com/clip.mp4' },
      { type: 'finish', finishReason: 'stop' },
    ]),
  });

  page.run(chatJob());
  await page.settled('j1');

  const video = page.parts('j1').find((p) => p.kind === 'video');
  assert.ok(video, 'the video must not be dropped');
  assert.equal(video.text, 'https://storage.googleapis.com/clip.mp4');
});

// The reattach added for the run that cost 551 credits and returned nothing.
// It is deliberately narrow, and both halves of that matter.
test('a stream that dies before any content is reattached', async () => {
  const page = loadPage({
    onFetch: async (url, _init, n) => {
      if (n === 1) return brokenStream([{ type: 'start' }]);
      assert.match(url, /^\/actions\/resume-stream\/conv1$/, 'reattach goes to the conversation');
      return sseResponse(textFrames('recovered'));
    },
  });
  page.run(chatJob());
  const end = await page.settled('j1');
  assert.equal(end.kind, 'done', 'the job survives rather than failing');
  assert.equal(page.parts('j1').filter((p) => p.kind === 'text').map((p) => p.text).join(''), 'recovered');
  assert.ok(page.parts('j1').some((p) => p.kind === 'status' && /reattached/.test(p.text)));
});

test('a stream that dies after content is NOT reattached', async () => {
  const page = loadPage({
    onFetch: async (_url, _init, n) => {
      if (n === 1) return brokenStream([{ type: 'text-delta', delta: 'half an answer' }]);
      return sseResponse(textFrames('half an answer and more'));
    },
  });
  page.run(chatJob());
  const end = await page.settled('j1');
  assert.equal(end.kind, 'error', 'resuming here would deliver the answer twice');
  assert.equal(page.requests.length, 1, 'no resume was attempted');
});

test('an aborted job does not try to reattach', async () => {
  const page = loadPage({ onFetch: async () => brokenStream([{ type: 'start' }]) });
  page.run(chatJob());
  page.abort('j1');
  await page.settled('j1');
  assert.equal(page.requests.length, 1, 'an abort is not a dropped connection');
});

// The edge in front of de.aipass.net answers 429 (Cloudflare) when the
// account is moving too fast. The old path failed the run on the spot — for a
// pause that clears in seconds. The page waits it out with retry-after when
// the edge sends one, then backoff; only after the waits run out is the
// failure real.
test('a 429 is waited out and retried, not failed on the spot', async () => {
  // fastTimers: after a refusal the tab paces sends 3s apart by design; the
  // capped timer keeps the test about the order of attempts, not the clock.
  const page = loadPage({
    fastTimers: true,
    onFetch: async (_url, _init, n) => (n === 1
      ? new Response('<!doctype html><title>429</title>429 Too Many Requests', {
          status: 429, headers: { 'retry-after': '0', server: 'cloudflare' },
        })
      : sseResponse(textFrames('สวัสดีหลังรอ'))),
  });
  page.run(chatJob());
  const end = await page.settled('j1');
  assert.equal(end.kind, 'done', 'the job survives the pause');
  assert.equal(page.requests.length, 2, 'one retry after the 429');
  assert.equal(page.parts('j1').filter((p) => p.kind === 'text').map((p) => p.text).join(''), 'สวัสดีหลังรอ');
  assert.ok(page.parts('j1').some((p) => p.kind === 'note' && /429/.test(p.text)), 'and the wait is reported as a note, not tool status');
});

test('a 429 that never clears surfaces as the real failure, after the retries', async () => {
  const page = loadPage({
    fastTimers: true, // the paced retries are 3s apart by design; see above
    onFetch: async () => new Response('<html>429 Too Many Requests</html>', {
      status: 429, headers: { 'retry-after': '0' },
    }),
  });
  page.run(chatJob());
  const end = await page.settled('j1');
  assert.equal(end.kind, 'error', 'the retries are bounded, not a hang');
  assert.equal(page.requests.length, 4, 'the first try plus three retries');
  assert.match(end.message, /429/);
  assert.match(end.message, /rate-limited through 3 retries/, 'the message says it did not give up instantly');
});

test('an abort during the wait stops the retrying', async () => {
  const page = loadPage({
    onFetch: async () => new Response('', { status: 429, headers: { 'retry-after': '30' } }),
  });
  page.run(chatJob());
  await new Promise((r) => setTimeout(r, 30));
  page.abort('j1');
  const end = await page.settled('j1');
  assert.equal(end.kind, 'done', 'a cancel is still a cancel, not an error');
  assert.equal(page.requests.length, 1, 'no second attempt after the cancel');
});

// The rate clock is shared, and it outlives the request that set it. Probes
// are themselves requests and count against the window they are waiting for —
// that is how a retry storm keeps its own limiter hot — so one job's 429 is
// one pause for the whole tab, and for a while after any refusal the sends
// are paced apart instead of bursting back.
test('a rate refusal pauses the whole tab, not just the refused job', async () => {
  const page = loadPage({
    fastTimers: true,
    onFetch: async (_url, _init, n) => (n === 1
      ? new Response('', { status: 429, headers: { 'retry-after': '5' } })
      : sseResponse(textFrames('ok'))),
  });
  page.run(chatJob());
  const first = await page.settled('j1');
  assert.equal(first.kind, 'done');

  page.run(chatJob({ jobId: 'j2' }));
  const second = await page.settled('j2');
  assert.equal(second.kind, 'done', 'the second job waited the first job\'s clock out, not its own');
  assert.ok(
    page.parts('j2').some((p) => p.kind === 'note' && /pacing sends — waiting [45]s/.test(p.text)),
    'the tab-wide wait is reported for the job that did not draw the 429',
  );
});

test('after a rate refusal the tab paces its sends apart', async () => {
  let refused = 0;
  const page = loadPage({
    fastTimers: true,
    onFetch: async () => {
      if (refused++ === 0) return new Response('', { status: 429, headers: { 'retry-after': '0' } });
      return sseResponse(textFrames('ok'));
    },
  });
  page.run(chatJob());
  const end = await page.settled('j1');
  assert.equal(end.kind, 'done');
  assert.equal(page.requests.length, 2, 'the retry still happened');
  assert.ok(
    page.parts('j1').some((p) => p.kind === 'note' && /pacing sends — waiting [23]s/.test(p.text)),
    'the retry after a refusal is itself paced, so the burst cannot re-draw the limiter',
  );
});

// A pace-score 403 is the same limiter family as the 429 above, and it used
// to arm only the refused job's own clock: the next job left at full pace
// into the window that had just said no, which is how one pace refusal became
// an episode. The 403 now cools the tab exactly as a 429 does.
test('a 403 refusal pauses the whole tab, not just the refused job', async () => {
  const page = loadPage({
    fastTimers: true,
    onFetch: async (_url, _init, n) => (n === 1
      ? new Response('', { status: 403, statusText: 'Forbidden', headers: { server: 'cloudflare' } })
      : sseResponse(textFrames('ok'))),
  });
  page.run(chatJob());
  const first = await page.settled('j1');
  assert.equal(first.kind, 'done');

  page.run(chatJob({ jobId: 'j2' }));
  const second = await page.settled('j2');
  assert.equal(second.kind, 'done', 'the second job waited the first job\'s clock out, not its own');
  assert.equal(page.requests.length, 3, 'the refusal, its identical resend, and the next job');
  assert.ok(
    page.parts('j2').some((p) => p.kind === 'note' && /pacing sends — waiting [45]s/.test(p.text)),
    'the tab-wide wait is reported for the job that did not draw the 403',
  );
});

// The extension owns which paths and intents the bridge may reach. A job asking
// for anything else has to be refused here, not upstream.
test('the assistant job refuses an intent outside its allowlist', async () => {
  const page = loadPage({ onFetch: async () => ({ assistantId: 'a1' }) });
  page.run({ jobId: 'a', kind: 'assistant', op: 'delete', assistantId: 'x' });
  await page.settled('a');
  assert.match(page.requests.at(-1).url, /^\/actions\/ai-assistant-actions$/);

  const form = page.requests.at(-1).init.body;
  assert.equal(form.get('intent'), 'delete');
  assert.equal(form.get('assistantId'), 'x');
});

test('starting a bound chat posts one field to its own route', async () => {
  const page = loadPage({ onFetch: async () => ({ conversationId: 'bound99' }) });
  page.run({ jobId: 'b', kind: 'assistant', op: 'start-chat', assistantId: 'a1' });
  const end = await page.settled('b');
  assert.equal(end.conversationId, 'bound99');
  assert.match(page.requests.at(-1).url, /ai-assistant-start-chat$/);
  assert.equal(page.requests.at(-1).init.body.get('aiAssistantId'), 'a1');
});

test('a video job posts only the options it was given', async () => {
  const page = loadPage({
    onFetch: async (url, _init, n) => {
      if (n === 1) return { jobId: 'vid1', status: 'pending' };
      return { jobId: 'vid1', status: 'completed', progress: 100, videoUrl: 'https://storage.googleapis.com/v.mp4?X-Goog-Signature=z' };
    },
  });
  page.run({
    jobId: 'v', kind: 'video', conversationId: 'conv1', modelId: 'seedance-2.0-mini',
    text: 'a street', provider: 'seedance', resolution: '480p', duration: 6, generateAudio: false,
  });
  const end = await page.settled('v', 8000);
  assert.equal(end.kind, 'done');

  const body = JSON.parse(page.requests[0].init.body);
  assert.equal(body.provider, 'seedance');
  assert.equal(body.resolution, '480p');
  assert.equal(body.duration, 6);
  assert.equal(body.generateAudio, false, 'false must survive, not be dropped as falsy');
  assert.ok(!('cameraFixed' in body), 'what was not set is not sent');
  assert.match(page.parts('v').find((p) => p.kind === 'video').text, /X-Goog-Signature=z/);
});
