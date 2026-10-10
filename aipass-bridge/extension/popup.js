const $ = (id) => document.getElementById(id);

const CHAT_URL = 'https://de.aipass.net/chat';
let bridge = 'http://127.0.0.1:8787';
let modelSignature = '';
let currentAction = null;   // what the hero button does right now
let pollTimer = null;

/* ------------------------------------------------------------------ helpers */

// Write only when the value actually changed. The popup polls, and blindly
// re-rendering fights the user mid-selection and makes the panel flicker.
function setText(el, value) {
  const v = String(value);
  if (el.textContent !== v) el.textContent = v;
}

function setClass(el, base, variant) {
  const next = `${base} ${variant}`;
  if (el.className !== next) el.className = next;
}

let toastTimer;
function toast(message) {
  const el = $('toast');
  setText(el, message);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 1600);
}

const shortId = (id) => (id && id.length > 10 ? `${id.slice(0, 8)}…` : id || '–');

/* -------------------------------------------------------------- data access */

async function swStatus() {
  try { return await chrome.runtime.sendMessage({ type: 'status' }); }
  catch { return null; }
}

async function bridgeStatus() {
  try {
    const res = await fetch(`${bridge}/status`, { cache: 'no-store' });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------- the 3 states */

// Everything the popup shows derives from one of these, so the guidance and the
// action button can never disagree with the indicator.
function derive(sw, srv) {
  if (!sw) {
    return { key: 'bad', label: 'Extension error', pill: 'error',
      hint: 'The extension worker is not responding. Reload it from chrome://extensions.' };
  }
  if (!srv || !sw.connected) {
    return { key: 'bad', label: 'Bridge offline', pill: 'offline',
      hint: 'Nothing is listening on the bridge URL. Start it with `npm run dev`.',
      action: { text: 'Retry connection', run: reconnect } };
  }
  if (!sw.tab) {
    return { key: 'warn', label: 'No AiPASS tab', pill: 'waiting',
      hint: 'The bridge is up, but a de.aipass.net tab must stay open for requests to run.',
      action: { text: 'Open AiPASS tab', run: openChatTab } };
  }
  if (!srv.extensions) {
    return { key: 'warn', label: 'Tab not linked', pill: 'waiting',
      hint: 'The tab is open but has not attached yet. Reloading it usually fixes this.',
      action: { text: 'Reload the tab', run: reloadChatTab } };
  }
  return { key: 'ok', label: 'Connected', pill: 'ready',
    hint: 'Ready. Point any OpenAI-compatible client at the bridge URL.' };
}

/* ----------------------------------------------------------------- actions */

async function reconnect() {
  await chrome.runtime.sendMessage({ type: 'reconnect' }).catch(() => {});
  toast('Reconnecting…');
  setTimeout(render, 400);
}

async function openChatTab() {
  await chrome.tabs.create({ url: CHAT_URL });
  window.close();
}

async function reloadChatTab() {
  const sw = await swStatus();
  if (sw?.tab) await chrome.tabs.reload(sw.tab.id).catch(() => {});
  toast('Reloading tab…');
  setTimeout(render, 600);
}

/* ------------------------------------------------------------------ render */

// The list now carries image, video and music generators alongside chat models,
// so a flat 30-entry dropdown would be unusable. Group it the way the web UI's
// tabs do — the bridge derives the kind, since the loader sends none.
const KIND_LABELS = {
  chat: 'สนทนา · Chat',
  research: 'ค้นคว้าเชิงลึก · Deep research',
  image: 'สร้างรูปภาพ · Image',
  video: 'สร้างวิดีโอ · Video',
  music: 'สร้างเพลง · Music',
};
const KIND_ORDER = ['chat', 'research', 'image', 'video', 'music'];

function renderModels(models, selected) {
  // Only rebuild when the list or the selection actually changed.
  const signature = `${models.map((m) => m.id).join('|')}::${selected}`;
  if (signature === modelSignature) return;
  modelSignature = signature;

  const sel = $('model');
  sel.textContent = '';

  const known = models.some((m) => m.id === selected);
  if (!known && selected) {
    const opt = document.createElement('option');
    opt.value = selected;
    opt.textContent = selected;
    opt.selected = true;
    sel.append(opt);
  }

  const option = (m) => {
    const opt = document.createElement('option');
    opt.value = m.id;
    const bits = [m.name || m.id];
    if (m.provider) bits.push(`· ${m.provider}`);
    if (m.free) bits.push('· free');
    opt.textContent = bits.join(' ');
    opt.selected = m.id === selected;
    return opt;
  };

  const kinds = KIND_ORDER.filter((k) => models.some((m) => m.kind === k))
    .concat([...new Set(models.map((m) => m.kind))].filter((k) => k && !KIND_ORDER.includes(k)));

  if (kinds.length <= 1) {
    for (const m of models) sel.append(option(m));
  } else {
    for (const kind of kinds) {
      const group = document.createElement('optgroup');
      group.label = KIND_LABELS[kind] ?? kind;
      for (const m of models.filter((m) => m.kind === kind)) group.append(option(m));
      sel.append(group);
    }
  }
  setText($('count'), models.length ? `(${models.length})` : '');
}

// Only gemini-3.1-flash-lite is free; everything else draws this pool down, and
// until now the number lived solely in the web UI.
//
// The panel stays visible whenever the bridge answers, because a section that
// vanishes reads as a missing feature rather than as a missing number — and the
// two reasons it can be missing need different fixes. A bridge predating this
// feature omits the key entirely; a current one sends null until a tab reports.
function renderCredits(srv) {
  const box = $('creditsBox');
  if (!srv) { box.hidden = true; return; }
  box.hidden = false;

  const credits = srv.credits;
  if (!credits || !credits.limit) {
    const stale = !('credits' in srv);
    $('creditsFill').style.width = '0%';
    setClass($('creditsFill'), 'meter-fill', '');
    setText($('creditsPct'), '');
    setText($('creditsLeft'), '–');
    setText($('creditsOf'), stale ? 'bridge is out of date — restart it' : 'waiting for the tab');
    setText($('creditsReset'), '');
    return;
  }

  const n = (v) => v.toLocaleString('en-US', { maximumFractionDigits: v < 100 ? 1 : 0 });
  const share = Math.max(0, Math.min(1, credits.available / credits.limit));
  const pct = Math.round(share * 100);

  const fill = $('creditsFill');
  fill.style.width = `${Math.max(share * 100, share > 0 ? 2 : 0)}%`;
  setClass(fill, 'meter-fill', pct <= 5 ? 'gone' : pct <= 20 ? 'low' : '');

  setText($('creditsPct'), `(${pct}%)`);
  setText($('creditsLeft'), n(credits.available));
  setText($('creditsOf'), `of ${n(credits.limit)} left`);
  setText($('creditsReset'), credits.periodEndsAt ? `resets ${credits.periodEndsAt.slice(5, 10)}` : '');
}

async function render() {
  const sw = await swStatus();
  if (sw?.bridgeUrl) bridge = sw.bridgeUrl;
  const srv = sw ? await bridgeStatus() : null;

  const state = derive(sw, srv);

  setClass($('dot'), 'dot', `state-${state.key}`);
  setClass($('pill'), 'pill', `pill-${state.key}`);
  setText($('state'), state.label);
  setText($('pill'), state.pill);

  // lastError is more specific than the generic hint when present.
  setText($('hint'), sw?.lastError && state.key !== 'ok' ? sw.lastError : state.hint);

  const act = $('act');
  const btn = $('actBtn');
  if (state.action) {
    setText(btn, state.action.text);
    currentAction = state.action.run;
    act.classList.add('show');
  } else {
    currentAction = null;
    act.classList.remove('show');
  }

  setText($('sJobs'), srv ? srv.activeJobs ?? 0 : '–');
  setText($('sModels'), srv ? (srv.models?.length ?? 0) : '–');
  setText($('sChat'), srv ? shortId(srv.conversation) : '–');

  if (srv) renderModels(srv.models ?? [], srv.defaultModel);
  renderCredits(srv);

  // Don't clobber the field while it is being edited.
  if (document.activeElement !== $('url')) $('url').value = bridge;
}

/* ------------------------------------------------------------------- wiring */

$('actBtn').addEventListener('click', () => currentAction?.());

$('model').addEventListener('change', async () => {
  const value = $('model').value;
  try {
    await fetch(`${bridge}/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ defaultModel: value }),
    });
    modelSignature = '';           // let the next poll confirm from the server
    toast(`Default: ${value}`);
  } catch {
    toast('Could not reach the bridge');
  }
});

$('save').addEventListener('click', async () => {
  const url = $('url').value.trim().replace(/\/+$/, '');
  if (!/^https?:\/\/.+/i.test(url)) return toast('Enter a full http:// URL');
  await chrome.storage.local.set({ bridgeUrl: url });
  await chrome.runtime.sendMessage({ type: 'reconnect' }).catch(() => {});
  bridge = url;
  modelSignature = '';
  toast('Saved');
  setTimeout(render, 400);
});

$('refresh').addEventListener('click', async () => {
  try {
    await fetch(`${bridge}/v1/models?refresh=1`, { cache: 'no-store' });
    await fetch(`${bridge}/quota?refresh=1`, { cache: 'no-store' }).catch(() => {});
    modelSignature = '';
    toast('Refreshed');
  } catch {
    toast('Could not reach the bridge');
  }
  render();
});

// Enter in the URL field saves.
$('url').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('save').click(); });

try { setText($('ver'), `v${chrome.runtime.getManifest().version}`); } catch { /* not in an extension context */ }

render();
pollTimer = setInterval(render, 2000);
window.addEventListener('unload', () => clearInterval(pollTimer));
