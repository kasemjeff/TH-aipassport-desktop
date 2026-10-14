// A context Chrome does not discard, holding one port open so the service worker
// is not evicted while no de.aipass.net tab is available to do it.
//
// The port is the whole mechanism: an open runtime port with traffic on it is
// what resets the worker's idle timer. Nothing else here needs to happen.

let port = null;

function connect() {
  try {
    port = chrome.runtime.connect({ name: 'offscreen-keepalive' });
    port.onDisconnect.addListener(() => {
      port = null;
      setTimeout(connect, 1000);
    });
  } catch (err) {
    console.warn('[aipass-offscreen] connect:', err);
    setTimeout(connect, 2000);
  }
}

connect();

// Comfortably inside Chrome's ~30 second idle window, and no tighter — this runs
// for as long as the browser does.
setInterval(() => {
  if (!port) return void connect();
  try { port.postMessage({ t: Date.now() }); }
  catch { connect(); }
}, 20_000);
