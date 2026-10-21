// The CLI dispatcher (bin/aipass.mjs) — the command a person actually types.
// It talks to the bridge over HTTP and then has to end the way a terminal
// expects: the child's exit code, and no crash on the way out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startBridge, run } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', 'bin', 'aipass.mjs');

// `aipass status` fetches /status twice (is the bridge up? what does it say?)
// and then ends the process. With process.exit() in between, Windows aborts
// the process in libuv's teardown — 0xC0000409, the "Assertion failed:
// !(handle->flags & UV_HANDLE_CLOSING)" in win/async.c — after the report is
// already on screen. The report looked perfect; the exit code said the tool
// had crashed. (nodejs/node#56645; doctor.mjs and list.mjs already drain
// instead of exiting, the dispatcher did not.)
test('cli: aipass status ends cleanly after its bridge fetches', async () => {
  const bridge = await startBridge();
  try {
    const r = await run(CLI, ['status'], { env: { AIPASS_PORT: String(bridge.port), AIPASS_HOST: '127.0.0.1' } });
    assert.equal(r.code, 0, `the CLI must end with a clean code, not a crash: ${r.out}`);
    assert.match(r.out, /bridge\s+http:\/\/127\.0\.0\.1:\d+\s+ok/, 'and it says the bridge is up');
  } finally { bridge.stop(); }
});
