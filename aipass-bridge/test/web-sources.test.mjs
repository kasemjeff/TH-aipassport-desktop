/**
 * The links a web search brings back.
 *
 * A search answers with prose and a `sources:` block — one line per link, a
 * label and an address. Two things have to be true of that block: the window
 * must be able to show those links to the reader, and the model must be able
 * to quote them in its answer. So the block is read out of the text — and the
 * opaque redirect links the search edge answers with are followed to the
 * address they point at, under the same private-host guard the FETCH tool
 * uses, because a reader who cannot see where a link goes cannot use it.
 *
 * Run: node --test aipass-bridge/test/web-sources.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempDir } from './harness.mjs';
import { parseSources, resolveUrl, resolveSources, rewriteSources, withResolvedSources } from '../harness/web-sources.mjs';
import { SessionStore } from '../harness/session.mjs';
import { Emitter } from '../harness/events.mjs';
import { BridgeClient } from '../harness/bridge.mjs';
import { Harness } from '../harness/harness.mjs';

const BLOCK = `Here is what the web says.

sources:
  - medium.com HTTPS-URLvertexaisearch.cloud.google.com/grounding-api-redirect/AUZI=
  - bbc.co.th HTTPS-URLbbc.co.th/thai/news-1
  - example.org https://example.org/post?id=7
`;

/** A fetch that answers with a redirect for the addresses it knows. */
const fakeFetch = (redirects = {}) => async (url) => {
  const target = redirects[String(url)];
  if (target) {
    return { status: 302, headers: { get: (h) => (h === 'location' ? target : null) }, body: { cancel: async () => {} } };
  }
  return { status: 200, headers: { get: () => null }, body: { cancel: async () => {} } };
};

test('the sources a search printed are read out of the block', () => {
  const sources = parseSources(BLOCK);
  assert.equal(sources.length, 3, 'every line of the block is a source');
  assert.deepEqual(sources[0], {
    label: 'medium.com',
    url: 'HTTPS-URLvertexaisearch.cloud.google.com/grounding-api-redirect/AUZI=',
  }, 'the wire spelling is kept as it came — the window puts it back');
  assert.deepEqual(sources[1], { label: 'bbc.co.th', url: 'HTTPS-URLbbc.co.th/thai/news-1' });
  assert.deepEqual(sources[2], { label: 'example.org', url: 'https://example.org/post?id=7' },
    'a plain address is a source too');
});

test('a text without a sources block has no sources', () => {
  assert.deepEqual(parseSources('Just an answer, with https://example.com/x inside it.'), []);
  assert.deepEqual(parseSources(''), []);
});

test('a redirect is followed once and the address it points at is what is left', async () => {
  const fetchImpl = fakeFetch({
    'https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZI=': 'https://www.medium.com/@someone/the-article',
  });
  const resolved = await resolveSources(parseSources(BLOCK), { fetchImpl });
  assert.equal(resolved[0].url, 'https://www.medium.com/@someone/the-article',
    'the reader gets the article, not the search host');
  assert.equal(resolved[0].label, 'medium.com', 'the label stays the label');
  assert.equal(resolved[2].url, 'https://example.org/post?id=7',
    'a link that is already an address stays as it is');
});

test('the block keeps its shape when it is rewritten', () => {
  const rewritten = rewriteSources(BLOCK, [{ label: 'medium.com', url: 'https://www.medium.com/@someone/the-article' }]);
  assert.match(rewritten, /sources:\n {2}- medium\.com https:\/\/www\.medium\.com\/@someone\/the-article/,
    'the block is still a block, one label and one address per line');
  assert.match(rewritten, /Here is what the web says\./, 'the answer above the block is untouched');
});

test('a link that points into the machine is refused, not followed', async () => {
  let asked = 0;
  const fetchImpl = async () => { asked += 1; return { status: 302, headers: { get: () => 'http://127.0.0.1/' }, body: { cancel: async () => {} } }; };
  assert.equal(await resolveUrl('https://127.0.0.1/x', { fetchImpl }), null);
  assert.equal(await resolveUrl('https://localhost:8080/x', { fetchImpl }), null);
  assert.equal(asked, 0, 'the guard runs before the request, not after it');
});

test('a redirect into the machine is refused at the hop', async () => {
  const fetchImpl = fakeFetch({ 'https://public.invalid/x': 'http://169.254.169.254/latest/meta-data/' });
  assert.equal(await resolveUrl('https://public.invalid/x', { fetchImpl }), null,
    'the metadata address is not an article');
});

test('a link that cannot be read is left as it came', async () => {
  const failing = async () => { throw new Error('offline'); };
  assert.equal(await resolveUrl('https://public.invalid/x', { fetchImpl: failing }), null);
  const sources = await resolveSources([{ label: 'x', url: 'https://public.invalid/x' }], { fetchImpl: failing });
  assert.equal(sources[0].url, 'https://public.invalid/x', 'the link the search gave is still there');
});

test('a search result comes back with the sources resolved', async () => {
  const fetchImpl = fakeFetch({
    'https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZI=': 'https://www.medium.com/@someone/the-article',
  });
  const out = await withResolvedSources(BLOCK, { fetchImpl });
  assert.match(out, /- medium\.com https:\/\/www\.medium\.com\/@someone\/the-article/);
});

/* The loop's own end of it: a search's sources reach the window. ---------- */

class StubBridge extends BridgeClient {
  constructor(replies) {
    super('http://127.0.0.1:1');
    this.model = 'stub';
    this.replies = replies;
    this.turn = 0;
  }
  async chat({ message } = {}) {
    const text = String(message ?? '');
    // The search is asked for by its own words, and the scratch space (when
    // the run keeps one) is a message of its own — so the answers do not
    // depend on how many turns came before them.
    if (/Please search the web/.test(text)) {
      return { text: 'The web says this.\n\nsources:\n  - medium.com HTTPS-URLsearch.invalid/article-1\n', reasoning: '' };
    }
    if (/scratch space/i.test(text)) return { text: 'ok\n', reasoning: '' };
    return { text: this.replies[Math.min(this.turn++, this.replies.length - 1)] ?? '', reasoning: '' };
  }
  async quota() { return { available: 10 }; }
  async createConversation() { return { id: 'stub-conversation' }; }
  async config() {}
  async status() { return { conversation: 'stub-conversation' }; }
}

test("a search's sources ride along with the tool row, so the window can show them", async () => {
  const root = tempDir({ 'README.md': 'read me\n' });
  const events = new Emitter();
  const h = new Harness({
    root,
    client: new StubBridge([
      'WEB ai research\n',
      'DONE looked it up\n',
    ]),
    store: new SessionStore(tempDir()),
    events,
    options: { mode: 'yolo', allowRun: false, maxSteps: 3 },
  });
  const rows = [];
  events.on('tool', (p) => rows.push(p));
  // A search is the tier that moves data OUT, so it is asked about in every
  // mode — the person has to see it before anything leaves the machine. The
  // test is that person.
  events.on('permission_request', (q) => { h.answer(q.id, 'allow'); });

  const result = await h.run('what does the web say?');
  assert.equal(result.stopReason, 'done');

  const web = rows.find((r) => r.kind === 'web');
  assert.ok(web, `the search ran:\n${JSON.stringify(rows)}`);
  assert.deepEqual(web.sources, [{ label: 'medium.com', url: 'HTTPS-URLsearch.invalid/article-1' }],
    'the sources travel with the row the window draws');
});
