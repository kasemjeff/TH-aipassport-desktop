// The provider's catalog has a deadline.
//
// The catalog is asked for at the START of every run (the loop judges the
// chosen model against it) and by the sheet's one-click check, so a provider
// that takes the connection and never answers used to leave every run in the
// project waiting for ever — before the first message was even sent.
//
// What is pinned here:
//   - the fetch carries a deadline, and the deadline fires;
//   - the failure is clean: it names the provider that stayed silent and the
//     time it was given, and the list the person wrote down is still there;
//   - the deadline is the spec's own, then the environment's, then the
//     default — and it survives the registry.
//
// Run: node --test aipass-bridge/test/provider-timeout.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempDir } from './harness.mjs';
import { ApiProviderClient, modelsTimeoutMs } from '../harness/provider-client.mjs';
import { ProviderStore, publicSpec } from '../harness/providers.mjs';

/**
 * A provider that takes the connection and never answers.
 *
 * The stub honours the deadline, the way a socket does: the request is
 * accepted, nothing is ever sent back, and the abort ends it. A stub that
 * ignored the signal would hang the test instead of the run.
 */
function silentProvider(seen) {
  return async (url, init = {}) => {
    seen.push({ url: String(url), init });
    return new Promise((_resolve, reject) => {
      const signal = init.signal;
      if (!signal) return; // no deadline: this promise never settles
      const onAbort = () => reject(signal.reason ?? new Error('aborted'));
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    });
  };
}

const SPEC = {
  id: 'silent', kind: 'openai', baseUrl: 'https://api.example.com/v1',
  models: ['written-down'], defaultModel: null, headers: {},
};

test('a provider that never answers does not hang the run', async () => {
  const seen = [];
  const original = globalThis.fetch;
  globalThis.fetch = silentProvider(seen);
  try {
    const client = new ApiProviderClient({ ...SPEC, modelsTimeoutMs: 400 }, { key: 'sk-test' });

    const started = Date.now();
    const catalog = await client.models();
    const took = Date.now() - started;

    assert.ok(took < 5_000, `the catalog answered in ${took} ms instead of hanging the run`);
    assert.equal(catalog.source, 'spec', 'the list the person wrote down is still the answer');
    assert.deepEqual(catalog.data.map((m) => m.id), ['written-down'], 'and it is intact');
    assert.match(catalog.error, /silent/, 'the failure names the provider that stayed silent');
    assert.match(catalog.error, /400 ms/, 'and the deadline it was given');
    assert.ok(seen[0]?.init?.signal, 'the fetch carried a deadline');
    assert.equal(seen[0].url, 'https://api.example.com/v1/models', 'and it asked the provider for its catalog');
  } finally {
    globalThis.fetch = original;
  }
});

test('the catalog deadline is the provider\'s, then the environment\'s, then the default', () => {
  assert.equal(modelsTimeoutMs({}), 10_000, 'the default is ten seconds');
  assert.equal(modelsTimeoutMs({ modelsTimeoutMs: 1500 }), 1500, "the provider's own deadline wins");
  assert.equal(modelsTimeoutMs({ modelsTimeoutMs: 0 }), 10_000, 'a broken value is ignored, not obeyed');
  assert.equal(modelsTimeoutMs({ modelsTimeoutMs: 'soon' }), 10_000, 'and so is a value that is not a number');

  const previous = process.env.AIPASS_PROVIDER_MODELS_TIMEOUT_MS;
  process.env.AIPASS_PROVIDER_MODELS_TIMEOUT_MS = '250';
  try {
    assert.equal(modelsTimeoutMs({}), 250, 'the environment speaks for every provider');
    assert.equal(modelsTimeoutMs({ modelsTimeoutMs: 1500 }), 1500, 'and the spec still wins over it');
  } finally {
    if (previous === undefined) delete process.env.AIPASS_PROVIDER_MODELS_TIMEOUT_MS;
    else process.env.AIPASS_PROVIDER_MODELS_TIMEOUT_MS = previous;
  }
});

test('the provider\'s own deadline survives the registry', () => {
  // The client reads the field, so the spec has to KEEP it: a row that
  // loses it falls back to the default deadline silently, and the person
  // who set it never learns why it was ignored.
  const store = new ProviderStore(tempDir());
  store.save({ ...SPEC, modelsTimeoutMs: 4500 });
  const spec = store.get('silent');
  assert.equal(spec.modelsTimeoutMs, 4500, 'the stored spec keeps the deadline');
  assert.equal(publicSpec(spec).modelsTimeoutMs, 4500, 'and the sheet sees it');
});
