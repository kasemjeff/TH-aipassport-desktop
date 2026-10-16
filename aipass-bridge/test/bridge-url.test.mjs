// resolveBridgeURL: the one place that decides where the bridge is. The forms
// it accepts and the default it keeps are the desktop's contract for
// AIPASS_BRIDGE, so they are pinned here — hermetically, no server involved.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_BRIDGE_URL, resolveBridgeURL } from '../harness/bridge.mjs';

test('unset, empty or blank AIPASS_BRIDGE keeps the loopback default', () => {
  assert.equal(resolveBridgeURL({}), DEFAULT_BRIDGE_URL);
  assert.equal(resolveBridgeURL({ AIPASS_BRIDGE: undefined }), DEFAULT_BRIDGE_URL);
  assert.equal(resolveBridgeURL({ AIPASS_BRIDGE: '' }), DEFAULT_BRIDGE_URL);
  assert.equal(resolveBridgeURL({ AIPASS_BRIDGE: '   ' }), DEFAULT_BRIDGE_URL);
  assert.equal(DEFAULT_BRIDGE_URL, 'http://127.0.0.1:8787');
});

test('a full URL passes through, minus trailing slashes', () => {
  assert.equal(resolveBridgeURL({ AIPASS_BRIDGE: 'http://127.0.0.1:8788' }), 'http://127.0.0.1:8788');
  assert.equal(resolveBridgeURL({ AIPASS_BRIDGE: 'http://localhost:8788/' }), 'http://localhost:8788');
  assert.equal(resolveBridgeURL({ AIPASS_BRIDGE: 'http://127.0.0.1:8788///' }), 'http://127.0.0.1:8788');
  assert.equal(resolveBridgeURL({ AIPASS_BRIDGE: 'https://bridge.example.net:8443/api/' }), 'https://bridge.example.net:8443/api');
});

test('host:port and bare port forms are accepted', () => {
  assert.equal(resolveBridgeURL({ AIPASS_BRIDGE: '127.0.0.1:8799' }), 'http://127.0.0.1:8799');
  assert.equal(resolveBridgeURL({ AIPASS_BRIDGE: 'localhost:8799' }), 'http://localhost:8799');
  assert.equal(resolveBridgeURL({ AIPASS_BRIDGE: '8799' }), 'http://127.0.0.1:8799');
});

test('anything else is a typo and stops the start', () => {
  for (const bad of ['nonsense', 'ftp://127.0.0.1:21', 'http:/missing-slashes', '127.0.0.1:8788/base', 'host:port']) {
    assert.throws(() => resolveBridgeURL({ AIPASS_BRIDGE: bad }), /AIPASS_BRIDGE/, bad);
  }
});

test('the real environment is the default source', () => {
  const saved = process.env.AIPASS_BRIDGE;
  try {
    process.env.AIPASS_BRIDGE = '127.0.0.1:8801';
    assert.equal(resolveBridgeURL(), 'http://127.0.0.1:8801');
  } finally {
    if (saved === undefined) delete process.env.AIPASS_BRIDGE;
    else process.env.AIPASS_BRIDGE = saved;
  }
});
