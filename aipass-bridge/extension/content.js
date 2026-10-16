// ISOLATED world. Two jobs: relay between page.js and the service worker, and
// keep that worker alive.
(() => {
const GEN = (window.__aipassBridgeContentGen ?? 0) + 1;
window.__aipassBridgeContentGen = GEN;
const current = () => window.__aipassBridgeContentGen === GEN;

const TAG = '__aipass_bridge';

// Sending to an evicted worker both wakes it and can transiently fail, so
// retry rather than dropping deltas on the floor. The upstream fetch keeps
// running in the page throughout.
async function toWorker(payload, attempt = 0) {
  try {
    await chrome.runtime.sendMessage({ type: 'from-page', payload });
  } catch {
    if (attempt >= 5) return;
    setTimeout(() => toWorker(payload, attempt + 1), 200 * (attempt + 1));
  }
}

window.addEventListener('message', (event) => {
  if (!current()) return;
  if (event.source !== window) return;
  const msg = event.data;
  if (!msg || typeof msg !== 'object' || msg[TAG] !== 'res') return;
  const { [TAG]: _, ...payload } = msg;
  toWorker(payload);
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!current()) return;
  if (msg?.type === 'run') window.postMessage({ [TAG]: 'req', job: msg.job }, window.location.origin);
  else if (msg?.type === 'abort') window.postMessage({ [TAG]: 'abort', jobId: msg.jobId }, window.location.origin);
  else if (msg?.type === 'ping') { sendResponse({ ok: true }); return true; }
});

// Chrome evicts an idle MV3 worker after ~30s, and inbound SSE data does not
// count as activity — without this the bridge sees a disconnect/reconnect
// cycle every half minute, and any job landing in that window fails. An open
// port does count, so hold one and cycle it before Chrome's 5-minute ceiling.
function keepAlive() {
  let port;
  try { port = chrome.runtime.connect({ name: 'keepalive' }); }
  catch { setTimeout(keepAlive, 1000); return; }

  const beat = setInterval(() => {
    try { port.postMessage({ t: Date.now() }); } catch { /* disconnect handles it */ }
  }, 20_000);
  const cycle = setTimeout(() => port.disconnect(), 4 * 60 * 1000);

  port.onDisconnect.addListener(() => {
    clearInterval(beat);
    clearTimeout(cycle);
    setTimeout(keepAlive, 250);
  });
}
keepAlive();
})();
