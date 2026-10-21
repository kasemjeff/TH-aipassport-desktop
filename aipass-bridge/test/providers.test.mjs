// The provider layer: the registry that says which provider a run talks to,
// the adapters that speak a plain HTTP API, and the switch that moves a
// harness from one to the other.
//
// The AiPASS path is not tested here — it has its own file. What is tested is
// everything the second kind of provider needs: a spec that survives a
// restart, a key that never reaches the settings file, a client that keeps
// the history the site would have kept, and a switch that lands on every
// harness the backend holds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { tempDir, startRpcServer } from './harness.mjs';
import { ProviderStore, AIPASS_PROVIDER, sanitizeSpec } from '../harness/providers.mjs';
import { ApiProviderClient, clientFor, endpointsFor, authHeaders } from '../harness/provider-client.mjs';
import { RATE_REFUSED, resilientSay } from '../harness/bridge.mjs';
import { Settings } from '../harness/settings.mjs';
import { Harness } from '../harness/harness.mjs';


/** A streaming response, as a provider would send one. */
function sse(frames) {
  return new Response(frames.map((f) => `data: ${f}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  });
}

/** Run `what` with a stubbed fetch, and give back what was called. */
async function withFetch(handler, what) {
  const seen = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    seen.push({ url: String(url), init, body: init.body ? JSON.parse(init.body) : null });
    return handler(seen.length, url, init);
  };
  try {
    return { seen, result: await what() };
  } finally {
    globalThis.fetch = original;
  }
}

const OPENAI_SPEC = {
  id: 'openai', kind: 'openai', baseUrl: 'https://api.example.com/v1',
  apiKeyEnv: '', models: ['gpt-x'], defaultModel: null, headers: {},
};

test('the fields the provider client reads survive the spec', () => {
  // A provider that wants its key under another header, without the "Bearer "
  // prefix, or with its own token ceiling, says so in its spec — and the spec
  // has to KEEP it, or the client quietly falls back to its defaults and the
  // provider turns the key down.
  const home = tempDir();
  const store = new ProviderStore(home);
  store.save({ ...OPENAI_SPEC, apiKeyHeader: 'x-api-key', apiKeyPrefix: '', maxTokens: 4096 });
  const spec = store.get('openai');
  assert.equal(spec.apiKeyHeader, 'x-api-key', 'the header name survives');
  assert.equal(spec.apiKeyPrefix, '', 'and the prefix — an empty one means no prefix');
  assert.equal(spec.maxTokens, 4096, 'and the token ceiling');

  // The client reads the spec, so the header it builds is the one asked for.
  const headers = authHeaders(spec, 'sk-x');
  assert.equal(headers['x-api-key'], 'sk-x', 'the key goes under the header the spec names');
  assert.equal(headers.authorization, undefined, 'and not under the default one');

  // A header name with a newline in it is a header injection, not a name.
  assert.throws(() => sanitizeSpec({ ...OPENAI_SPEC, apiKeyHeader: 'x-key\r\nX-Evil: 1' }), /header name/);
});

test('a provider spec is stored, listed and never carries its key', () => {
  const home = tempDir();
  const store = new ProviderStore(home);
  store.save({ id: 'OpenAI', kind: 'openai', baseUrl: 'https://api.example.com/v1/', apiKeyEnv: 'EXAMPLE_KEY', models: ['gpt-x', 'gpt-x'] });
  store.setKey('openai', 'sk-secret-value');

  const list = store.all();
  assert.equal(list[0].id, AIPASS_PROVIDER, 'the built-in provider is always first');
  const added = list.find((p) => p.id === 'openai');
  assert.ok(added, 'the added provider is listed');
  assert.equal(added.baseUrl, 'https://api.example.com/v1', 'the trailing slash is trimmed');
  assert.deepEqual(added.models, ['gpt-x'], 'the model list is de-duplicated');

  // The key is in the credentials file, and only there.
  const onDisk = fs.readFileSync(path.join(home, 'providers.json'), 'utf8');
  assert.doesNotMatch(onDisk, /sk-secret-value/, 'the spec file holds no key');
  const creds = fs.readFileSync(path.join(home, 'credentials.json'), 'utf8');
  assert.match(creds, /sk-secret-value/, 'the key is in the credentials file');
  assert.equal(store.keyFor('openai'), 'sk-secret-value', 'the key comes back');
});

test('the key comes from the environment first and the credentials file second', () => {
  const home = tempDir();
  const store = new ProviderStore(home);
  store.save({ ...OPENAI_SPEC, apiKeyEnv: 'EXAMPLE_KEY' });
  store.setKey('openai', 'sk-from-file');

  assert.equal(store.keyFor('openai'), 'sk-from-file', 'the file answers when the environment is empty');
  process.env.EXAMPLE_KEY = 'sk-from-env';
  try {
    assert.equal(store.keyFor('openai'), 'sk-from-env', 'the environment wins over the file');
  } finally {
    delete process.env.EXAMPLE_KEY;
  }
  assert.equal(store.hasKey('openai'), true, 'the window is told there is a key without being told what it is');
});

test('the credentials file is owner-only', { skip: process.platform === 'win32' ? 'POSIX modes are not a thing on windows' : false }, () => {
  const home = tempDir();
  const store = new ProviderStore(home);
  store.setKey('openai', 'sk-secret');
  const mode = fs.statSync(path.join(home, 'credentials.json')).mode & 0o777;
  assert.equal(mode, 0o600, 'the key file is readable by its owner only');
});

test('a broken provider row is dropped without losing the others', () => {
  const home = tempDir();
  fs.writeFileSync(path.join(home, 'providers.json'), JSON.stringify({
    providers: [
      { id: 'good', kind: 'openai', baseUrl: 'https://api.example.com/v1' },
      { id: 'bad kind', kind: 'wat', baseUrl: 'https://api.example.com/v1' },
    ],
  }));
  const store = new ProviderStore(home);
  const ids = store.all().map((p) => p.id);
  assert.ok(ids.includes('good'), 'the good row survives');
  assert.ok(!ids.includes('bad kind'), 'the broken row is dropped');
  assert.throws(() => sanitizeSpec({ id: 'x', kind: 'openai', baseUrl: 'ftp://x' }), /base url/, 'a spec that is not http is refused');
});

test('an openai-compatible provider keeps the history the site would have kept', async () => {
  const { seen } = await withFetch(
    () => sse(['{"choices":[{"delta":{"content":"ok"}}]}']),
    async () => {
      const client = new ApiProviderClient(OPENAI_SPEC, { key: 'sk-test', model: 'gpt-x' });
      const conv = await client.createConversation({});
      await client.chat({ message: 'first', conversation: conv.id });
      await client.chat({ message: 'second', conversation: conv.id });
      return client;
    },
  );
  assert.equal(seen[0].body.messages.length, 1, 'the first send carries one message');
  assert.equal(seen.at(-1).body.messages.length, 3, 'the earlier turns are sent back');
  assert.equal(seen.at(-1).body.messages[0].content, 'first');
  assert.equal(seen.at(-1).body.messages[1].role, 'assistant');
  assert.equal(seen.at(-1).body.messages[2].content, 'second');
});

test('a provider is not encoded for a firewall that is not there', async () => {
  const { seen } = await withFetch(
    () => sse(['{"choices":[{"delta":{"content":"ok"}}]}']),
    async () => {
      const client = new ApiProviderClient(OPENAI_SPEC, { key: 'sk-test', model: 'gpt-x' });
      await client.chat({ message: 'console.log("hi") — read http://localhost:3000' });
      return client;
    },
  );
  assert.equal(seen[0].body.messages[0].content, 'console.log("hi") — read http://localhost:3000', 'the bytes go out as they are');
});

test('the loop sends a provider the bytes as they are', async () => {
  // The loop's send path is resilientSay() with the WAF and the firewall chain
  // switched off — the AiPASS edge is the only one that has them.
  const sent = [];
  const say = async (text) => { sent.push(text); return 'the answer'; };
  const res = await resilientSay(say, 'read http://localhost:3000', () => {}, null, 0, { encode: false, firewall: false });
  assert.equal(sent[0], 'read http://localhost:3000', 'the text is not encoded for a firewall that is not there');
  assert.equal(res, 'the answer');
});

test("a provider's refusal is not rewritten — a 403 is a permission error", async () => {
  let calls = 0;
  const say = async () => { calls++; throw new Error('provider returned 403 Forbidden: bad key'); };
  await assert.rejects(
    () => resilientSay(say, 'console.log("x")', () => {}, null, 0, { encode: false, firewall: false }),
    /403/,
  );
  assert.equal(calls, 1, 'the message is neither redacted nor split and sent again');
});

test('an anthropic provider gets its own shape', async () => {
  const { seen } = await withFetch(
    () => sse(['{"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}']),
    async () => {
      const client = new ApiProviderClient(
        { id: 'claude', kind: 'anthropic', baseUrl: 'https://api.anthropic.com', apiKeyEnv: '', models: [], defaultModel: null, headers: {} },
        { key: 'sk-ant', model: 'claude-x' },
      );
      const res = await client.chat({ message: 'hello', thinkingLevel: 'high' });
      assert.equal(res.text, 'hi', 'the anthropic stream is read');
      return client;
    },
  );
  const { url, init, body } = seen[0];
  assert.equal(url, 'https://api.anthropic.com/v1/messages');
  assert.equal(init.headers['x-api-key'], 'sk-ant');
  assert.equal(init.headers['anthropic-version'], '2023-06-01');
  assert.equal(body.thinking.type, 'enabled', 'a thinking level becomes a thinking budget');
  assert.deepEqual(body.messages[0].content, [{ type: 'text', text: 'hello' }]);
});

test('a provider without a key says so before it sends', async () => {
  const client = new ApiProviderClient(OPENAI_SPEC, { model: 'gpt-x' });
  await assert.rejects(() => client.chat({ message: 'hi' }), /no API key/, 'the run stops with the reason');
  assert.equal(endpointsFor(OPENAI_SPEC).chat, 'https://api.example.com/v1/chat/completions');
});

test('the aipass provider is reached through the local bridge', () => {
  const client = clientFor({ id: AIPASS_PROVIDER, kind: 'aipass' }, { bridgeURL: 'http://127.0.0.1:8787' });
  assert.equal(client.waf, true, 'the AiPASS edge is the one with the firewall');
  assert.equal(client.providerId, AIPASS_PROVIDER);
});

test('the harness takes the client it is handed, under one name', () => {
  // A provider is a client, not a second loop (rule 14): the harness talks to
  // one contract, so the client it is given may be the bridge's own or a
  // provider's. ONE option says so — `client` — so a caller cannot hand over
  // one thing and have the harness talk to another.
  const bridge = { providerId: AIPASS_PROVIDER, model: 'gemini', async chat() {}, async quota() { return { available: 1 }; } };
  const h = new Harness({ root: tempDir(), client: bridge, store: 'off' });
  assert.equal(h.bridge, bridge, 'the client it was handed is the one it talks to');
  assert.equal(h.providerId, AIPASS_PROVIDER, 'and it says which provider it is');

  const provider = { providerId: 'openai', model: 'gpt-x', async chat() {}, async quota() { return { available: 1 }; } };
  const h2 = new Harness({ root: tempDir(), client: provider, store: 'off' });
  assert.equal(h2.bridge, provider, 'a provider client is a client too');
  assert.equal(h2.providerId, 'openai', 'and the harness says which provider it is');
});

test('a rate refusal is recognised whoever answers it', () => {
  assert.ok(RATE_REFUSED.test('aipass returned 429 Too Many Requests'), 'the site still counts');
  assert.ok(RATE_REFUSED.test('provider returned 429 Too Many Requests'), 'a provider counts too');
  assert.ok(!RATE_REFUSED.test('provider returned 403 Forbidden'), 'a 403 is a permission error, not a rate limit');
});

test('the provider switch moves every harness and lands in the settings file', async () => {
  const home = tempDir();
  const store = new ProviderStore(home);
  store.save({ ...OPENAI_SPEC, apiKeyEnv: 'EXAMPLE_KEY' });
  process.env.EXAMPLE_KEY = 'sk-example';
  const settings = new Settings(home, 'settings.json');
  const rpc = await startRpcServer({
    root: tempDir(),
    store: tempDir(),
    settings,
    providerStore: store,
    autostartBridge: false,
  });
  const port = rpc.port;
  const call = async (method, params = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method, params }),
    });
    const body = await res.json();
    if (!body.ok) throw new Error(body.error);
    return body.result;
  };
  try {
    const before = await call('status');
    assert.equal(before.provider, AIPASS_PROVIDER, 'the app starts on the built-in provider');

    const listed = await call('providers.list');
    assert.ok(listed.providers.some((p) => p.id === 'openai'), 'the added provider is listed');
    assert.equal(JSON.stringify(listed).includes('sk-example'), false, 'no key leaves the backend');

    const switched = await call('provider.set', { id: 'openai' });
    assert.equal(switched.active, 'openai');
    assert.equal(settings.get('defaultProvider'), 'openai', 'the switch lands in the settings file');

    const after = await call('status');
    assert.equal(after.provider, 'openai', 'the harness moved with it');
    assert.equal(after.model, 'gpt-x', 'the provider brought its own model');

    // And back.
    await call('provider.set', { id: AIPASS_PROVIDER });
    assert.equal((await call('status')).provider, AIPASS_PROVIDER, 'the switch goes both ways');
  } finally {
    rpc.server.close();
    delete process.env.EXAMPLE_KEY;
  }
});

test('a provider is refused before it can be saved half-configured', async () => {
  const home = tempDir();
  const store = new ProviderStore(home);
  assert.throws(() => store.save({ id: 'x', kind: 'openai', baseUrl: 'not-a-url' }), /base url/);
  assert.throws(() => store.save({ id: 'x', kind: 'wat', baseUrl: 'https://x.dev' }), /unknown provider kind/);
  assert.throws(() => store.save({ id: AIPASS_PROVIDER, kind: 'openai', baseUrl: 'https://x.dev' }), /built in/);
  assert.throws(() => store.remove(AIPASS_PROVIDER), /cannot be removed/);
  assert.deepEqual(store.saved(), [], 'nothing was written');
});

/**
 * A fake OpenAI-compatible endpoint: it answers with the marker protocol the
 * agent speaks, one reply at a time, and it records what it was sent.
 */
function fakeProvider(replies) {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    if (String(req.url).startsWith('/v1/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'fake-model' }] }));
      return;
    }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let body = {};
    try { body = JSON.parse(raw || '{}'); } catch { /* an empty body is a body */ }
    seen.push(body);
    const reply = replies.shift() ?? 'DONE nothing left';
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: reply } }] })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  return { server, seen };
}

test('a run works end to end on a provider, not only on the bridge', async () => {
  // The whole chain, on the other kind of upstream: the loop sends, the model
  // answers with a marker, the tool runs, the diff is staged, the DONE ends the
  // run — and the second turn carries the first one back, because the provider
  // keeps no history of its own.
  const home = tempDir();
  const store = new ProviderStore(home);
  const fake = fakeProvider([
    'EDIT notes.md\nFIND\nline two\nNEW\nline 2\nEND',
    'DONE patched the notes',
  ]);
  await new Promise((resolve) => fake.server.listen(0, '127.0.0.1', resolve));
  const port = fake.server.address().port;
  store.save({
    id: 'fake', kind: 'openai', baseUrl: `http://127.0.0.1:${port}/v1`,
    apiKeyEnv: 'FAKE_PROVIDER_KEY', models: ['fake-model'],
  });
  process.env.FAKE_PROVIDER_KEY = 'sk-fake';
  const settings = new Settings(home, 'settings.json');
  settings.set({ defaultProvider: 'fake' });
  const rpc = await startRpcServer({
    root: tempDir({ 'notes.md': 'line one\nline two\n' }),
    store: tempDir(),
    settings,
    providerStore: store,
    autostartBridge: false,
  });
  const rpcPort = rpc.port;
  const call = async (method, params = {}) => {
    const res = await fetch(`http://127.0.0.1:${rpcPort}/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method, params }),
    });
    const body = await res.json();
    if (!body.ok) throw new Error(body.error);
    return body.result;
  };
  try {
    const status = await call('status');
    assert.equal(status.provider, 'fake', 'the run is on the provider');
    assert.equal(status.model, 'fake-model', 'the provider brought its own model');

    const result = await call('run', { task: 'fix the second line', mode: 'auto', title: 'provider run' });
    assert.equal(result.pending.length, 1, 'the edit was staged');
    assert.equal(result.pending[0].file, 'notes.md');
    assert.equal(fs.readFileSync(path.join(rpc.harness.root, 'notes.md'), 'utf8'), 'line one\nline two\n', 'the disk is untouched until apply');

    assert.ok(fake.seen.length >= 2, 'the model answered');
    assert.equal(fake.seen[0].model, 'fake-model');
    assert.equal(fake.seen[1].messages.length, 3, 'the second turn carries the first one back');
    assert.match(fake.seen[1].messages[2].content, /Result of replace/, 'the tool result reached the model');
    assert.doesNotMatch(fake.seen[1].messages[2].content, /CONSOLE-LOG/, 'the reminder names no wire spellings a provider never sees');
  } finally {
    rpc.server.close();
    fake.server.close();
    delete process.env.FAKE_PROVIDER_KEY;
  }
});

/**
 * A fake upstream that records every path it is asked for and answers with a
 * model list.
 *
 * The AiPASS bridge is one kind of upstream and an added provider is another:
 * the same recorder stands in for both, and a test that watches it says, in
 * one line, whether the backend asked the right machine.
 */
function recordingUpstream(modelId) {
  const asked = [];
  const server = http.createServer((req, res) => {
    asked.push(req.url);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: modelId }], source: 'live' }));
  });
  return { server, asked };
}

/** Call the backend the way the window does. */
async function callAt(port, method, params = {}) {
  const res = await fetch(`http://127.0.0.1:${port}/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method, params }),
  });
  const body = await res.json();
  if (!body.ok) throw new Error(body.error);
  return body.result;
}

test('an added provider answers with the models of its own spec', async () => {
  // The list of an added provider lives in its own spec — the AiPASS bridge
  // has never heard of it, so a list read from that bridge is a list of the
  // wrong models. The backend must ask the provider that is in use.
  const home = tempDir();
  const store = new ProviderStore(home);
  store.save({ ...OPENAI_SPEC, models: ['spec-model'] });
  const bridge = recordingUpstream('bridge-model');
  await new Promise((resolve) => bridge.server.listen(0, '127.0.0.1', resolve));
  const settings = new Settings(home, 'settings.json');
  settings.set({ defaultProvider: 'openai' });
  const rpc = await startRpcServer({
    root: tempDir(),
    store: tempDir(),
    settings,
    providerStore: store,
    autostartBridge: false,
    bridgeURL: `http://127.0.0.1:${bridge.server.address().port}`,
  });
  const port = rpc.port;
  try {
    const models = await callAt(port, 'models');
    assert.deepEqual(models.data.map((m) => m.id), ['spec-model'], 'the list is the provider own');
    assert.equal(models.source, 'spec', 'and the answer says where the list came from');
    assert.deepEqual(bridge.asked, [], 'the AiPASS bridge was never asked for it');
  } finally {
    rpc.server.close();
    bridge.server.close();
  }
});

test('a model the person wrote down by hand stays in the list, and stays a model', async () => {
  // A provider's own catalog does not have to name every model the person
  // wrote down in the spec — a gateway answers with a subset. The written
  // model stays in the list, and it stays a MODEL: an entry whose id is an
  // object reaches the window as "[object Object]" and is sent to the
  // provider as the model to run.
  const home = tempDir();
  const store = new ProviderStore(home);
  const fake = fakeProvider(['DONE']);
  await new Promise((resolve) => fake.server.listen(0, '127.0.0.1', resolve));
  store.save({
    id: 'fake', kind: 'openai', baseUrl: `http://127.0.0.1:${fake.server.address().port}/v1`,
    apiKeyEnv: 'FAKE_PROVIDER_KEY', models: ['fake-model', 'written-model'],
  });
  process.env.FAKE_PROVIDER_KEY = 'sk-fake';
  const settings = new Settings(home, 'settings.json');
  settings.set({ defaultProvider: 'fake' });
  const rpc = await startRpcServer({
    root: tempDir(),
    store: tempDir(),
    settings,
    providerStore: store,
    autostartBridge: false,
  });
  const port = rpc.port;
  try {
    const models = await callAt(port, 'models');
    const written = models.data.find((m) => m.id === 'written-model');
    assert.ok(written, 'the model the person wrote down is in the list');
    assert.equal(typeof written.id, 'string', 'and it is a model, not an object');
    assert.equal(written.name, 'written-model', 'named the way it was written');
    for (const m of models.data) {
      assert.equal(typeof m.id, 'string', `every entry is a model, not an object: ${JSON.stringify(m.id)}`);
    }
  } finally {
    rpc.server.close();
    fake.server.close();
    delete process.env.FAKE_PROVIDER_KEY;
  }
});

test('an edited provider is live at once — the new endpoint, the new list', async () => {
  // The person changes the endpoint or the model list of the provider that is
  // in use. The change must be live, not on the next start: a client that
  // still holds the old endpoint answers for the old provider, and the list
  // on screen is the old list.
  const home = tempDir();
  const store = new ProviderStore(home);
  const first = recordingUpstream('first-model');
  const second = recordingUpstream('second-model');
  await new Promise((resolve) => first.server.listen(0, '127.0.0.1', resolve));
  await new Promise((resolve) => second.server.listen(0, '127.0.0.1', resolve));
  store.save({
    id: 'fake', kind: 'openai', baseUrl: `http://127.0.0.1:${first.server.address().port}/v1`,
    apiKeyEnv: 'FAKE_PROVIDER_KEY', models: ['first-model'],
  });
  process.env.FAKE_PROVIDER_KEY = 'sk-fake';
  const settings = new Settings(home, 'settings.json');
  settings.set({ defaultProvider: 'fake' });
  const rpc = await startRpcServer({
    root: tempDir(),
    store: tempDir(),
    settings,
    providerStore: store,
    autostartBridge: false,
  });
  const port = rpc.port;
  try {
    const before = await callAt(port, 'models');
    assert.ok(before.data.some((m) => m.id === 'first-model'), 'the list is the old one to begin with');

    await callAt(port, 'provider.save', {
      id: 'fake', kind: 'openai', baseUrl: `http://127.0.0.1:${second.server.address().port}/v1`,
      apiKeyEnv: 'FAKE_PROVIDER_KEY', models: ['second-model'],
    });

    const after = await callAt(port, 'models');
    assert.ok(after.data.some((m) => m.id === 'second-model'), 'the list is the new one');
    assert.equal(after.data.some((m) => m.id === 'first-model'), false, 'the old list is gone');
    assert.ok(second.asked.length, 'the new endpoint is the one that answered');
    assert.equal(first.asked.length, 1, 'and the old endpoint was not asked again');
  } finally {
    rpc.server.close();
    first.server.close();
    second.server.close();
    delete process.env.FAKE_PROVIDER_KEY;
  }
});

test('a model chosen for an added provider is filed with that provider', async () => {
  // A model id means nothing across providers: `gpt-4o` is not a thing the
  // AiPASS bridge can be asked for. So a model chosen while an added provider
  // is in use belongs to THAT provider — and the machine-wide default stays
  // the AiPASS one, or a later switch back would send the site a model it has
  // never heard of.
  const home = tempDir();
  const store = new ProviderStore(home);
  store.save({ ...OPENAI_SPEC, apiKeyEnv: 'EXAMPLE_KEY', defaultModel: 'gpt-x' });
  process.env.EXAMPLE_KEY = 'sk-example';
  const settings = new Settings(home, 'settings.json');
  settings.set({ defaultProvider: 'openai' });
  const rpc = await startRpcServer({
    root: tempDir(),
    store: tempDir(),
    settings,
    providerStore: store,
    autostartBridge: false,
  });
  const port = rpc.port;
  try {
    await callAt(port, 'config.set', { model: 'gpt-4o' });
    assert.equal(store.get('openai').defaultModel, 'gpt-4o', 'the model is filed with the provider that answers to it');
    assert.notEqual(settings.get('defaultModel'), 'gpt-4o', 'and the machine-wide default is not taken over by it');
    assert.equal((await callAt(port, 'status')).model, 'gpt-4o', 'the harness runs on the model that was chosen');
  } finally {
    rpc.server.close();
    delete process.env.EXAMPLE_KEY;
  }
});

test('a model chosen on the built-in provider is the machine default', async () => {
  // The other half of the rule: on AiPASS the model IS the machine-wide
  // default, so the choice survives a restart and the next backend starts
  // with it.
  const home = tempDir();
  const settings = new Settings(home, 'settings.json');
  const rpc = await startRpcServer({
    root: tempDir(),
    store: tempDir(),
    settings,
    providerStore: new ProviderStore(home),
    autostartBridge: false,
  });
  const port = rpc.port;
  try {
    await callAt(port, 'config.set', { model: 'gemini-3.8-flash' });
    assert.equal(settings.get('defaultModel'), 'gemini-3.8-flash', 'the machine default is the model that was chosen');
  } finally {
    rpc.server.close();
  }
});

test('the bridge is not asked for the models of a provider that has a key', async () => {
  // The same question with a provider that can answer it: the live list
  // comes from the provider, and the bridge is still never touched — it is
  // the other provider, and its models are not this one's.
  const home = tempDir();
  const store = new ProviderStore(home);
  const fake = fakeProvider(['DONE']);
  await new Promise((resolve) => fake.server.listen(0, '127.0.0.1', resolve));
  store.save({
    id: 'fake', kind: 'openai', baseUrl: `http://127.0.0.1:${fake.server.address().port}/v1`,
    apiKeyEnv: 'FAKE_PROVIDER_KEY', models: ['spec-model'],
  });
  process.env.FAKE_PROVIDER_KEY = 'sk-fake';
  const bridge = recordingUpstream('bridge-model');
  await new Promise((resolve) => bridge.server.listen(0, '127.0.0.1', resolve));
  const settings = new Settings(home, 'settings.json');
  settings.set({ defaultProvider: 'fake' });
  const rpc = await startRpcServer({
    root: tempDir(),
    store: tempDir(),
    settings,
    providerStore: store,
    autostartBridge: false,
    bridgeURL: `http://127.0.0.1:${bridge.server.address().port}`,
  });
  const port = rpc.port;
  try {
    const models = await callAt(port, 'models');
    assert.equal(models.source, 'live', 'the provider own catalog answered');
    assert.ok(models.data.some((m) => m.id === 'fake-model'), 'the list is the provider own');
    assert.equal(models.data.some((m) => m.id === 'bridge-model'), false, 'the bridge list is not in it');
    assert.deepEqual(bridge.asked, [], 'the AiPASS bridge was never asked for it');
  } finally {
    rpc.server.close();
    bridge.server.close();
    fake.server.close();
    delete process.env.FAKE_PROVIDER_KEY;
  }
});
