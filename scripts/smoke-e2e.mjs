#!/usr/bin/env node
// Smoke end-to-end: boot the real bridge on an ephemeral port and exercise its
// HTTP surface the way a client does. Runs in CI (and locally) on every OS, so
// a regression in server startup or routing is caught before a live run spends
// credits. No extension is attached — the bridge must answer cleanly without one.
import { startBridge } from '../aipass-bridge/test/harness.mjs';

let bridge;
try {
  bridge = await startBridge();
  const base = bridge.base;

  // 1. /status answers with a sane shape.
  const st = await fetch(`${base}/status`);
  if (!st.ok) throw new Error(`/status returned ${st.status}`);
  const status = await st.json();
  if (typeof status.extensions !== 'number') throw new Error('/status missing extensions count');

  // 2. A chat request with no extension attached fails cleanly (502 + JSON).
  const chat = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
  });
  if (chat.status !== 502) throw new Error(`expected 502 without extension, got ${chat.status}`);
  const chatBody = await chat.json();
  if (!chatBody?.error?.message) throw new Error('chat error missing message');

  // 3. conversations/new without an extension is a clean 503, not an unhandled dump.
  const conv = await fetch(`${base}/conversations/new`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ temporary: true, message: 'x' }),
  });
  if (conv.status !== 503) throw new Error(`expected 503, got ${conv.status}`);

  console.log(`smoke e2e: OK (bridge up at ${base})`);
} catch (err) {
  console.error('smoke e2e: FAIL', err?.message ?? err);
  if (bridge) console.error(bridge.logText());
  process.exitCode = 1;
} finally {
  if (bridge) bridge.stop();
}
