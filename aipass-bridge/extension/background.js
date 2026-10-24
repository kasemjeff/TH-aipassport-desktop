// Service worker: holds the long-lived connection to the local bridge and
// routes each job into a de.aipass.net tab.
//
// The connection lives here rather than in the content script because an
// https:// page talking to http://127.0.0.1 runs into mixed-content and
// Private Network Access checks; an extension request with host_permissions
// does not.
const DEFAULT_BRIDGE = 'http://127.0.0.1:8787';
// The page that holds the logged-in session. A job runs there, so this is
// the URL the extension opens when no tab is open yet.
const CHAT_URL = 'https://de.aipass.net/chat';
// The stream is deliberately aborted every four minutes (Chrome's long-request
// ceiling — the cycle below), so the reconnect delay backs off instead of
// being flat: almost at once right after a drop that may just be the cycle,
// and toward the ceiling only while the bridge itself is away. A flat 3 s left
// the bridge showing no extension for seconds, four times an hour.
const RECONNECT_FIRST_MS = 300;
const RECONNECT_MS = 3000;
const CYCLE_MS = 4 * 60 * 1000; // reconnect before Chrome's long-request ceiling

let controller = null;
let connected = false;
let lastError = '';
let retryMs = RECONNECT_FIRST_MS;
const jobTabs = new Map();
// The tab being opened right now, if any. Two jobs that arrive while no tab is
// open both miss in findChatTab(); without this each would open a tab of its
// own, and the person would be left with two sessions to keep alive.
let openingTab = null;
// The per-run token the bridge hands over in its `ready` frame. Every post to
// /ext/* carries it, so the bridge can tell the extension from any other
// local process that learned a job id. It is handed over, never configured:
// nothing is pasted anywhere.
let extToken = '';

// The content script's keepalive port only exists while a de.aipass.net tab is
// open. With no tab the worker is evicted, the SSE stream dies with it, and the
// bridge reports the extension as gone until the one-minute alarm revives it —
// so an offscreen document holds a port of its own, which is a context Chrome
// does not discard.
//
// One in-flight creation at a time: hasDocument() then createDocument() is
// check-then-act, and this is called from the alarm, from connect(), and on a
// port dropping. Same shape as connect() and the model refresh below.
let offscreenSetup = null;

function ensureOffscreenDocument() {
  if (typeof chrome.offscreen === 'undefined') return Promise.resolve();
  if (offscreenSetup) return offscreenSetup;
  offscreenSetup = (async () => {
    try {
      if (await chrome.offscreen.hasDocument?.()) return;
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        // The enum has no value for "keep the worker alive", which is the only
        // thing this document does. BLOBS is a stand-in; nothing here handles a
        // blob, and the justification says what is really going on.
        reasons: ['BLOBS'],
        justification: 'Holds a port open so the service worker survives while no aipass tab is open',
      });
    } catch (err) {
      // Losing a creation race is the outcome we wanted anyway.
      if (!/single offscreen document/i.test(String(err?.message ?? err))) {
        console.warn('[aipass-bg] offscreen document:', err);
      }
    } finally {
      offscreenSetup = null;
    }
  })();
  return offscreenSetup;
}

const bridgeUrl = async () => {
  try {
    const res = await chrome.storage.local.get('bridgeUrl');
    return res?.bridgeUrl || DEFAULT_BRIDGE;
  } catch {
    return DEFAULT_BRIDGE;
  }
};

const bridgeToken = async () => {
  try {
    const res = await chrome.storage.local.get('bridgeToken');
    return res?.bridgeToken || '';
  } catch {
    return '';
  }
};

async function post(path, body) {
  try {
    const token = await bridgeToken();
    const res = await fetch(`${await bridgeUrl()}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(extToken ? { 'x-aipass-token': extToken } : {}),
      },
      body: JSON.stringify(body),
    });
    // Retrying would duplicate deltas, so a refused post is surfaced, not
    // repeated — without this a rejected body (too large, unknown job) vanished
    // and the caller waited out its timeout for a reply that never came.
    if (!res.ok) {
      lastError = `bridge refused ${path} with ${res.status}`;
      console.warn('[aipass-bg] POST rejected:', path, res.status);
    }
  } catch (err) {
    lastError = String(err?.message ?? err);
    console.warn('[aipass-bg] POST error:', path, lastError);
  }
}

async function findChatTab() {
  const tabs = await chrome.tabs.query({ url: ['https://*.aipass.net/*', 'https://aipass.net/*'] });
  if (!tabs.length) return null;
  const live = tabs.filter((t) => !t.discarded && t.status !== 'unloaded');
  const pool = live.length ? live : tabs;
  // Prefer a tab already sitting on a chat route.
  return pool.find((t) => t.url?.includes('/chat')) ?? pool[0];
}

/**
 * Open the chat tab, and wait for it to be ready.
 *
 * The tab is not optional: the extension is a Chrome extension, so the page
 * that holds the logged-in session has to be a real tab in the browser the
 * extension lives in. A request that arrives while no tab is open used to
 * fail with "no de.aipass.net tab is open", which is what the person saw as
 * a 502 they could not do anything about — the fix (open the tab) was in the
 * extension's hands, not theirs.
 *
 * So the extension opens it itself and carries on. The tab is opened at the
 * chat route, and the job waits for it to load: a request that has to wait a
 * few seconds is better than one that is refused outright.
 */
async function openChatTab() {
  const tab = await chrome.tabs.create({ url: CHAT_URL, active: true });
  try {
    await waitForComplete(tab.id, 30_000);
  } catch {
    // A tab that did not report "complete" may still be usable — the page
    // loads its own data and the content script attaches on document_start.
  }
  return tab;
}

/**
 * The tab a job should run in: the one that is already open, or a new one.
 *
 * Reuse first: a tab that is already logged in and sitting on the chat route
 * is exactly what the job wants, and opening another one would only add a
 * second session to keep alive.
 */
async function tabForJob() {
  if (openingTab) return openingTab;
  // Lock tab acquisition so concurrent jobs awaiting tab resolution share
  // the exact same promise and never trigger duplicate tab creation.
  openingTab = (async () => {
    const existing = await findChatTab();
    if (existing) return existing;
    return await openChatTab();
  })().finally(() => {
    openingTab = null;
  });
  return openingTab;
}

function waitForComplete(tabId, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { chrome.tabs.onUpdated.removeListener(onUpdated); reject(new Error('tab did not finish loading')); }, timeoutMs);
    function onUpdated(id, info) {
      if (id !== tabId || info.status !== 'complete') return;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    }
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

async function ensureContentScript(tab) {
  const ping = () => chrome.tabs.sendMessage(tab.id, { type: 'ping' });
  let ok = false;
  try { await ping(); ok = true; } catch { /* not there yet */ }

  if (!ok && (tab.discarded || tab.status === 'unloaded')) {
    await chrome.tabs.reload(tab.id);
    await waitForComplete(tab.id);
  }

  await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'MAIN', files: ['page.js'] }).catch(() => {});
  if (!ok) {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'ISOLATED', files: ['content.js'] }).catch(() => {});
    await ping();
  }
}

async function handleJob(job) {
  // The tab a job runs in: the one that is already open, or a new one.
  //
  // Opening it here is the fix for the request that arrived while nobody had
  // a chat tab open. The old answer was a refusal — "no de.aipass.net tab is
  // open" — which the person could only fix by opening a tab themselves, and
  // which read as a broken app when the bridge was perfectly fine. The
  // extension knows how to open the tab, so it opens it.
  //
  // If it cannot be opened at all — Chrome refuses, the browser is closing —
  // the refusal is still the old one, and it is still honest. `tabForJob`
  // answers a tab or throws, so there is no third shape to handle here.
  let tab;
  try {
    tab = await tabForJob();
  } catch (err) {
    await post('/ext/error', {
      jobId: job.jobId,
      message: `could not open a de.aipass.net tab: ${err?.message ?? err}`,
    });
    return;
  }
  jobTabs.set(job.jobId, tab.id);
  try {
    await ensureContentScript(tab);
    await chrome.tabs.sendMessage(tab.id, { type: 'run', job });
  } catch (err) {
    jobTabs.delete(job.jobId);
    await post('/ext/error', {
      jobId: job.jobId,
      message: `could not reach the de.aipass.net tab (${tab.url ?? tab.id}): ${err?.message ?? err}`,
    });
  }
}

function handleEvent(name, data) {
  if (name === 'job') handleJob(data);
  else if (name === 'abort') {
    const tabId = jobTabs.get(data.jobId);
    if (tabId != null) chrome.tabs.sendMessage(tabId, { type: 'abort', jobId: data.jobId }).catch(() => {});
    jobTabs.delete(data.jobId);
  } else if (name === 'reload_extension') {
    try { chrome.runtime.reload(); } catch { /* ignore */ }
  } else if (name === 'reload_tab') {
    (async () => {
      const tab = await findChatTab();
      if (tab) chrome.tabs.reload(tab.id).catch(() => {});
    })();
  }
}

async function connect() {
  if (controller) return;
  controller = new AbortController();
  const signal = controller.signal;
  const cycle = setTimeout(() => controller?.abort(), CYCLE_MS);

  ensureOffscreenDocument();

  try {
    const token = await bridgeToken();
    const res = await fetch(`${await bridgeUrl()}/ext/events`, {
      headers: {
        accept: 'text/event-stream',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      signal,
    });
    if (res.status === 401) {
      lastError = 'bridge needs the loopback token — paste it in the popup settings once';
      console.warn('[aipass-bg] bridge requires a token; set it in the popup');
    }
    if (!res.ok || !res.body) throw new Error(`bridge responded ${res.status}`);

    connected = true;
    lastError = '';
    retryMs = RECONNECT_FIRST_MS; // a live stream earns the fast retry again
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let pending = '';

    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });

      let cut;
      while ((cut = pending.search(/\r?\n\r?\n/)) !== -1) {
        const frame = pending.slice(0, cut);
        pending = pending.slice(cut + pending.slice(cut).match(/^\r?\n\r?\n/)[0].length);

        let name = 'message';
        const dataLines = [];
        for (const line of frame.split(/\r?\n/)) {
          if (line.startsWith('event:')) name = line.slice(6).trim();
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
        }
        if (!dataLines.length) continue; // comment / keepalive
        try {
          const data = JSON.parse(dataLines.join('\n'));
          // The bridge's per-run token arrives with the `ready` frame, before
          // any job does — so it is known by the time anything is posted.
          if (name === 'ready' && typeof data.token === 'string') extToken = data.token;
          handleEvent(name, data);
        } catch { /* ignore */ }
      }
    }
  } catch (err) {
    if (err?.name !== 'AbortError') lastError = String(err?.message ?? err);
  } finally {
    clearTimeout(cycle);
    connected = false;
    controller = null;
    setTimeout(connect, retryMs);
    retryMs = Math.min(RECONNECT_MS, retryMs * 2);
  }
}

// A content script and the offscreen document each hold one of these open, which
// is what stops Chrome evicting the worker.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'keepalive' && port.name !== 'offscreen-keepalive') return;
  connect(); // a tab just appeared, or the worker just woke
  port.onMessage.addListener(() => {});
  port.onDisconnect.addListener(() => {
    void chrome.runtime.lastError;
    // The content port cycles by design every four minutes; the offscreen one
    // dropping means the document itself went away.
    if (port.name === 'offscreen-keepalive') ensureOffscreenDocument();
  });
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'from-page') {
    const p = msg.payload;
    if (p.kind === 'chunk') post('/ext/chunk', { jobId: p.jobId, parts: p.parts });
    else if (p.kind === 'done') { jobTabs.delete(p.jobId); post('/ext/done', { jobId: p.jobId, finishReason: p.finishReason }); }
    else if (p.kind === 'error') { jobTabs.delete(p.jobId); post('/ext/error', { jobId: p.jobId, message: p.message }); }
    else if (p.kind === 'loader') { jobTabs.delete(p.jobId); post('/ext/loader', { jobId: p.jobId, raw: p.raw, message: p.message }); }
    // The assistant's id is the whole answer to a create-assistant job, and
    // the bridge waits for it on /ext/assistant. This branch was missing, so
    // the reply was dropped: the job sat until it timed out, and the
    // assistant was really created on the account all the same.
    else if (p.kind === 'assistant') { jobTabs.delete(p.jobId); post('/ext/assistant', { jobId: p.jobId, assistantId: p.assistantId, conversationId: p.conversationId, deleted: p.deleted, raw: p.raw, message: p.message }); }
    return;
  }
  if (msg?.type === 'status') {
    (async () => {
      const tab = await findChatTab();
      sendResponse({
        connected,
        lastError,
        bridgeUrl: await bridgeUrl(),
        tab: tab ? { id: tab.id, url: tab.url } : null,
        activeJobs: jobTabs.size,
      });
    })();
    return true;
  }
  if (msg?.type === 'open-chat-tab') {
    (async () => {
      try {
        const tab = await tabForJob();
        if (tab?.id) await chrome.tabs.update(tab.id, { active: true });
        sendResponse({ ok: true, tabId: tab?.id });
      } catch (err) {
        sendResponse({ ok: false, error: String(err?.message ?? err) });
      }
    })();
    return true;
  }
  if (msg?.type === 'reconnect') { controller?.abort(); connect(); sendResponse({ ok: true }); return true; }
});

// The worker can still be evicted; the alarm brings it back, and the connect()
// guard makes a duplicate call harmless.
chrome.alarms.create('keepalive', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(() => {
  ensureOffscreenDocument();
  connect();
});

chrome.runtime.onStartup.addListener(() => {
  ensureOffscreenDocument();
  connect();
});

chrome.runtime.onInstalled.addListener(() => {
  ensureOffscreenDocument();
  connect();
});

// Initialize immediately
ensureOffscreenDocument();
connect();
