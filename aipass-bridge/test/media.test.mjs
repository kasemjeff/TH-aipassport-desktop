// The media surface: the catalog's media models, the presets, and a
// generation that keeps what it produced.
//
// The bridge is the real one (test/harness.mjs starts it) and the extension
// is the scriptable stand-in — so these tests drive the actual HTTP surface,
// not a mock of it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { startBridge, FakeExtension, tempDir, waitFor } from './harness.mjs';
import { BridgeClient } from '../harness/bridge.mjs';
import { createMediaMethods } from '../harness/rpc/media.mjs';
import {
  generate, listModels, listStyles, listTones, listFormats, mediaTarget,
  mediaTimeoutMs, resolvePreset, splitMedia,
} from '../harness/media.mjs';

// A 1x1 transparent PNG and a short mp4 header — the smallest legal
// payloads, so a test writes bytes it can compare exactly.
const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const MP4 = Buffer.from('AAAAIGZ0eXBpc29t', 'base64');

let bridge;
/** @type {BridgeClient} */
let client;
before(async () => {
  bridge = await startBridge();
  client = new BridgeClient(bridge.base);
});
after(() => bridge.stop());

/**
 * The catalog and the option loaders, warm.
 *
 * What a model accepts is read from them, so a test that asks about a model's
 * options has to make sure they are there: the catalog is fetched by the
 * extension, in the page, from the site.
 */
const warm = async (base = bridge.base) => {
  await waitFor(async () => (await (await fetch(`${base}/v1/models?refresh=1`)).json()).data.length > 1);
  await fetch(`${base}/video-options?refresh=1`);
  await fetch(`${base}/style-options?refresh=1`);
};

test('the media models come with the options they accept', async (t) => {
  const ext = await new FakeExtension(bridge.base, {}).connect();
  t.after(() => ext.disconnect());
  await warm();

  const models = await listModels(client);

  const image = models.image.find((m) => m.id === 'gpt-image-2');
  assert.ok(image, 'the catalog has image models');
  assert.equal(image.kind, 'image');
  // The served values, not a table of our own: the image styles come from
  // the loader the bridge reads.
  assert.deepEqual(image.options.styles, ['img_anime', 'img_minimal']);

  const seedance = models.video.find((m) => m.id === 'seedance-2.0-mini');
  assert.ok(seedance, 'the catalog has video models');
  assert.deepEqual(seedance.options.resolutions, ['480p'], 'the resolutions the provider is served');
  assert.deepEqual(seedance.options.durations, [4, 6], 'the durations it is served');
  assert.deepEqual(seedance.options.aspectRatios, ['16:9', '9:16', '21:9']);
  assert.equal(seedance.options.duration, true);
  assert.equal(seedance.options.cameraFixed, true);
  assert.equal(seedance.options.generateAudio, true);
  assert.equal(seedance.options.images.maximumImages, 9, 'and how many images it takes');

  const veo = models.video.find((m) => m.id === 'veo-3.1-fast-generate-001');
  assert.ok(veo);
  assert.equal(veo.options.duration, false, 'a model that takes no duration does not offer one');
  assert.equal(veo.options.cameraFixed, false);
  assert.equal(veo.options.generateAudio, false);
  assert.deepEqual(veo.options.resolutions, [], 'and it is served no resolution');

  const music = models.music.find((m) => m.id === 'lyria-3-pro-preview');
  assert.ok(music, 'the catalog has music models');
  assert.deepEqual(music.options, {}, 'a music model takes nothing the service publishes');
  assert.ok(!models.video.some((m) => m.id === 'sonar-deep-research'), 'a chat model is not media');
});

test('a generated image is saved where it was asked to go', async (t) => {
  const png = Buffer.from(PNG_1X1, 'base64');
  const ext = await new FakeExtension(bridge.base, {
    onChat: async (_j, e) => { await e.image(`data:image/png;base64,${png.toString('base64')}`); await e.done(); },
  }).connect();
  t.after(() => ext.disconnect());
  await warm();

  const dir = tempDir({});
  const out = await generate({ client, model: 'gpt-image-2', prompt: 'a red bicycle', out: dir });

  assert.equal(out.model, 'gpt-image-2', 'the answer names the model that made it');
  assert.ok(out.path.startsWith(dir), 'the file is where it was asked to go');
  assert.deepEqual(fs.readFileSync(out.path), png, 'and it holds the bytes that came back');
  assert.equal(out.bytes, png.length, 'and it says how big they are');
  assert.equal(out.mime, 'image/png');
});

test('an option a model does not declare is dropped before the request', async (t) => {
  const ext = await new FakeExtension(bridge.base, {
    onChat: async (_j, e) => { await e.media('video', `data:video/mp4;base64,${MP4.toString('base64')}`); await e.done(); },
  }).connect();
  t.after(() => ext.disconnect());
  await warm();
  const before = bridge.log.length;

  const dir = tempDir({});
  const out = await generate({
    client,
    model: 'seedance-2.0-mini',
    prompt: 'a street in the rain',
    ratio: '21:9',
    resolution: '720p',   // the provider is served 480p alone
    duration: 9,          // and the durations it is served are 4 and 6
    out: dir,
  });

  assert.deepEqual(out.dropped, ['resolution=720p', 'duration=9'], 'the answer says what it left out');
  const job = ext.videos.at(-1);
  assert.equal(job.aspectRatio, '21:9', 'the ratio the model does offer is kept');
  assert.equal(job.resolution, undefined, 'a resolution it does not offer never reaches the bridge');
  assert.equal(job.duration, undefined, 'and neither does a duration it does not offer');
  // The bridge drops what it does not want too, and says so in its log — so
  // the log is the proof that the option never got that far: the credits are
  // spent by the time the bridge would refuse it.
  assert.doesNotMatch(bridge.log.slice(before).join(''), /does not offer/, 'the bridge never saw them either');
});

test('a media generation waits for the media timeout, not the idle one', async (t) => {
  // The idle timeout is the bridge's: a job with no delta for that long is
  // failed. A render sits quiet for minutes, so the media path waits for the
  // MEDIA timeout instead — the idle one killed an image that had already
  // spent the credits.
  const idle = process.env.AIPASS_IDLE_TIMEOUT_MS;
  const media = process.env.AIPASS_MEDIA_TIMEOUT_MS;
  process.env.AIPASS_IDLE_TIMEOUT_MS = '400';
  process.env.AIPASS_MEDIA_TIMEOUT_MS = '8000';
  t.after(() => {
    if (idle === undefined) delete process.env.AIPASS_IDLE_TIMEOUT_MS;
    else process.env.AIPASS_IDLE_TIMEOUT_MS = idle;
    if (media === undefined) delete process.env.AIPASS_MEDIA_TIMEOUT_MS;
    else process.env.AIPASS_MEDIA_TIMEOUT_MS = media;
  });

  const slow = await startBridge({ AIPASS_IDLE_TIMEOUT_MS: '400', AIPASS_MEDIA_TIMEOUT_MS: '8000' });
  t.after(() => slow.stop());
  const ext = await new FakeExtension(slow.base, {
    onChat: async (_j, e) => {
      await new Promise((r) => setTimeout(r, 1500));   // longer than the idle timeout
      await e.media('video', `data:video/mp4;base64,${MP4.toString('base64')}`);
      await e.done();
    },
  }).connect();
  t.after(() => ext.disconnect());
  await warm(slow.base);

  assert.equal(mediaTimeoutMs(), 8000, 'the media path waits for the media timeout');
  const dir = tempDir({});
  const out = await generate({
    client: new BridgeClient(slow.base),
    model: 'seedance-2.0-mini',
    prompt: 'a river at dusk',
    out: dir,
  });
  assert.ok(out.path, 'the generation outlived the idle timeout');
  assert.deepEqual(fs.readFileSync(out.path), MP4);
});

test('a signed link is downloaded once and the bytes are kept', async (t) => {
  const body = Buffer.from('fake mp4 bytes');
  const origin = await new Promise((resolve) => {
    const srv = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'video/mp4' });
      res.end(body);
    });
    srv.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${srv.address().port}/clip.mp4?X-Goog-Signature=abc`, srv }));
  });
  t.after(() => origin.srv.close());
  // The link is on loopback here, and the house's fetch guard says a link
  // must not aim the backend at the machine it runs on. The lift is the
  // house's own escape hatch.
  const allow = process.env.AIPASS_FETCH_ALLOW_PRIVATE;
  process.env.AIPASS_FETCH_ALLOW_PRIVATE = '1';
  t.after(() => {
    if (allow === undefined) delete process.env.AIPASS_FETCH_ALLOW_PRIVATE;
    else process.env.AIPASS_FETCH_ALLOW_PRIVATE = allow;
  });

  const ext = await new FakeExtension(bridge.base, {
    onChat: async (_j, e) => { await e.media('video', origin.url); await e.done(); },
  }).connect();
  t.after(() => ext.disconnect());
  await warm();

  const dir = tempDir({});
  const out = await generate({ client, model: 'seedance-2.0-mini', prompt: 'a cat', out: dir });
  assert.deepEqual(fs.readFileSync(out.path), body, 'the bytes are kept locally, not left as a link');
  assert.equal(out.mime, 'video/mp4');
});

test('a video frame with no url is read from its snapshotUrl', () => {
  // The upstream bug, in one shape: a video carries no `url` at all, only a
  // `snapshotUrl` beside its storage key — and a frame can carry `url: ""`
  // beside a real one. Reading only `url` dropped every generated video.
  const frame = {
    type: 'file',
    mediaType: 'video/mp4',
    url: '',
    snapshotUrl: 'https://storage.googleapis.com/clip.mp4?X-Goog-Signature=b',
    storageKey: 'video-generations/x',
    filename: 'clip.mp4',
  };
  assert.equal(mediaTarget(frame), 'https://storage.googleapis.com/clip.mp4?X-Goog-Signature=b');
  assert.equal(mediaTarget({ url: 'https://example.com/a.mp4' }), 'https://example.com/a.mp4');
  assert.equal(mediaTarget({}), '', 'a frame with no payload has no target');
});

test('the media an answer carries is separated from the prose around it', () => {
  const answer = 'Here it is:\n\n![image](data:image/png;base64,AAAA)\n\nand the [source](https://example.com/paper) is cited.';
  const { prose, frames } = splitMedia(answer);
  assert.equal(frames.length, 1, 'the citation is not media');
  assert.equal(frames[0].kind, 'image');
  assert.match(prose, /Here it is/);
  assert.match(prose, /the \[source\]/);
});

test('a preset is resolved by its English name, its Thai name or its code', async (t) => {
  const ext = await new FakeExtension(bridge.base, {}).connect();
  t.after(() => ext.disconnect());
  await warm();

  const styles = await listStyles(client);
  assert.ok(styles.image.some((s) => s.id === 'img_anime'), 'the image styles are published');
  assert.ok(styles.video.some((s) => s.name === 'Documentary'), 'and the video styles');
  assert.equal((await listStyles(client, 'อนิเมะ'))?.id, 'img_anime', 'a Thai name resolves');
  assert.equal((await listStyles(client, 'Anime'))?.id, 'img_anime', 'and so does an English one');
  assert.equal((await listTones(client, 'concise'))?.code, 'concise', 'a tone resolves by its code');
  assert.equal((await listFormats(client, 'ตาราง'))?.code, 'table', 'and a format by its Thai name');
  assert.equal(resolvePreset([{ code: 'x', name: 'Y' }], 'nope'), null, 'a name nobody publishes resolves to nothing');
});

test('the media methods are the ones the window calls', async (t) => {
  const ext = await new FakeExtension(bridge.base, {}).connect();
  t.after(() => ext.disconnect());
  await warm();

  const methods = createMediaMethods({
    bridgeURL: bridge.base,
    root: process.cwd(),
    targetFor: () => ({ root: process.cwd() }),
  });
  assert.deepEqual(
    Object.keys(methods).sort(),
    ['media.generate', 'media.models', 'media.options', 'media.styles'],
    'the window calls these four',
  );
  const models = await methods['media.models']();
  assert.ok(models.image.length, 'and the models answer over the real bridge');
  const options = await methods['media.options']({ model: 'seedance-2.0-mini' });
  assert.equal(options.model, 'seedance-2.0-mini');
  assert.deepEqual(options.options.resolutions, ['480p']);
  const styles = await methods['media.styles']();
  assert.ok(styles.tones.length && styles.formats.length, 'the presets come with them');
});
