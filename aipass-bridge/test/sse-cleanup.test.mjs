// SSE cleanup tests: ensures dropped or half-open connections (whether from
// socket error, sudden destroy, or peer disconnect) are cleaned up promptly
// and idempotently.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startBridge, startRpcServer, tempDir, waitFor } from './harness.mjs';
import { Settings } from '../harness/settings.mjs';

test('rpc /events: dropped client socket cleans up subscriber promptly', async (t) => {
  const rpc = await startRpcServer({
    root: tempDir(),
    store: tempDir(),
    settings: new Settings(tempDir(), 'settings.json'),
    autostartBridge: false,
  });
  t.after(() => rpc.server.close());

  assert.equal(rpc.fanout.subscribers.size, 0);

  // Connect via http.request to have full control of the raw socket
  const clientReq = http.request({
    hostname: '127.0.0.1',
    port: rpc.port,
    path: '/events',
    method: 'GET',
  });

  await new Promise((resolve) => {
    clientReq.on('response', (res) => {
      resolve(res);
    });
    clientReq.end();
  });

  await waitFor(() => rpc.fanout.subscribers.size === 1);

  // Abruptly destroy the client socket (half-open / connection drop simulation)
  clientReq.destroy();

  await waitFor(() => rpc.fanout.subscribers.size === 0);
  assert.equal(rpc.fanout.subscribers.size, 0, 'subscriber was unsubscribed cleanly');
});

test('bridge /ext/events: dropped extension connection cleans up extClients', async (t) => {
  const bridge = await startBridge();
  t.after(() => bridge.stop());

  // Connect to /ext/events
  const clientReq = http.request({
    hostname: '127.0.0.1',
    port: bridge.port,
    path: '/ext/events',
    method: 'GET',
  });

  await new Promise((resolve) => {
    clientReq.on('response', (res) => {
      resolve(res);
    });
    clientReq.end();
  });

  // Check status reports 1 extension
  await waitFor(async () => {
    const res = await fetch(`${bridge.base}/status`);
    const st = await res.json();
    return st.extensions === 1;
  });

  // Destroy client socket abruptly
  clientReq.destroy();

  // Extension count must return to 0
  await waitFor(async () => {
    const res = await fetch(`${bridge.base}/status`);
    const st = await res.json();
    return st.extensions === 0;
  });

  const res = await fetch(`${bridge.base}/status`);
  const st = await res.json();
  assert.equal(st.extensions, 0, 'extClients emptied after dropped connection');
});
