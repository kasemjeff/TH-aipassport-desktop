#!/usr/bin/env node
// One command that walks the whole chain and names what is broken.
//
// The failure modes here are all "something upstream of me is not ready", and
// they look identical from a client: a request just does not work. Each check
// below tests exactly one link and, when it fails, prints the one thing to do
// about it — so a broken setup costs a line of output rather than a session of
// guessing.
const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};

if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`usage: npm run doctor [options]

  --bridge URL   bridge base URL     (default: http://127.0.0.1:8787)
  --chat         send a test message even when no free model is available
  --no-chat      skip the round trip entirely

Exits 0 when every check passes, 1 otherwise.`);
  process.exit(0);
}

const BRIDGE = (flag('bridge', process.env.AIPASS_BRIDGE ?? 'http://127.0.0.1:8787')).replace(/\/+$/, '');
const FORCE_CHAT = argv.includes('--chat');
const NO_CHAT = argv.includes('--no-chat');

const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;

const get = (p) => fetch(`${BRIDGE}${p}`).then(async (r) => ({ ok: r.ok, status: r.status, body: await r.json().catch(() => null) }));

let failed = 0;
let warned = 0;

// Every check reports the same three things: what it looked at, what it found,
// and — only when something is wrong — the single next action.
function report(name, state, detail, fix) {
  const mark = state === 'ok' ? green('✓') : state === 'warn' ? yellow('!') : state === 'skip' ? dim('–') : red('✗');
  console.log(`${mark} ${name.padEnd(14)} ${state === 'ok' ? detail : state === 'skip' ? dim(detail) : bold(detail)}`);
  if (fix) console.log(dim(`  ${' '.repeat(14)} → ${fix}`));
  if (state === 'fail') failed++;
  if (state === 'warn') warned++;
}

console.log(bold('\naipass doctor') + dim(`  ${BRIDGE}\n`));

/* 1 — the bridge itself */
let status = null;
try {
  const res = await get('/status');
  if (!res.ok) throw new Error(`responded ${res.status}`);
  status = res.body;
  report('bridge', 'ok', 'responding');
} catch (err) {
  report('bridge', 'fail', `not reachable (${err.message})`, 'start it with: npm run dev');
}

/* 2 — a tab holding the credentialed end of the chain */
if (!status) {
  report('extension', 'skip', 'skipped — no bridge to ask');
} else if (status.extensions > 0) {
  report('extension', 'ok', `${status.extensions} attached`);
} else {
  report('extension', 'fail', 'no tab attached',
    'open https://de.aipass.net/chat and leave it open; the popup should read "connected"');
}

/* 3 — models, which only load for a signed-in session */
let models = [];
if (!status?.extensions) {
  report('login', 'skip', 'skipped — nothing attached to ask');
} else {
  try {
    const res = await get('/v1/models?refresh=1');
    models = res.body?.data ?? [];
    // The bridge falls back to two hard-coded ids when it cannot reach the
    // loader, and those carry no provider — which is how a signed-out session
    // shows up here rather than as an error.
    const real = models.some((m) => m.owned_by && m.owned_by !== 'aipass');
    if (real) report('login', 'ok', `signed in — ${models.length} models`);
    else report('login', 'fail', 'the model list came back empty or fallback-only',
      'sign in at https://de.aipass.net/chat, then reload the tab');
  } catch (err) {
    report('login', 'fail', err.message, 'check the bridge log');
  }
}

/* 4 — credits, a warning rather than a failure: it never blocks a request */
if (!status?.extensions) {
  report('credits', 'skip', 'skipped');
} else {
  const res = await get('/quota').catch(() => ({ ok: false }));
  if (res.ok && res.body?.limit) {
    const c = res.body;
    const n = (v) => v.toLocaleString('en-US', { maximumFractionDigits: v < 100 ? 1 : 0 });
    const pct = Math.round((c.available / c.limit) * 100);
    report('credits', pct <= 5 ? 'warn' : 'ok', `${n(c.available)} of ${n(c.limit)} left (${pct}%)`,
      pct <= 5 ? 'nearly out — only gemini-3.1-flash-lite is free' : null);
  } else {
    report('credits', 'warn', 'could not read the credit pool', 'not fatal — requests still work');
  }
}

/* 5 — a conversation to post into; the server owns these, so one must exist */
if (!status?.extensions) {
  report('conversation', 'skip', 'skipped');
} else {
  const res = await get('/conversations').catch(() => ({ ok: false }));
  const list = res.body?.conversations ?? [];
  if (res.ok && (res.body?.current || list.length)) {
    report('conversation', 'ok', res.body.current ?? `${list.length} available`);
  } else {
    report('conversation', 'fail', 'none found',
      'start one chat at https://de.aipass.net/chat, or POST /conversations/new');
  }
}

/* 6 — the whole chain, end to end. Free by default: this only runs on its own
   when a free-credit model exists, so a healthy check costs nothing. */
const free = models.find((m) => m.free_credit);
if (NO_CHAT || !status?.extensions) {
  report('round trip', 'skip', NO_CHAT ? 'skipped (--no-chat)' : 'skipped');
} else if (!free && !FORCE_CHAT) {
  report('round trip', 'skip', 'skipped — no free-credit model', 'pass --chat to test with a paid one');
} else {
  const model = free?.id ?? status.defaultModel;
  const started = Date.now();
  try {
    const res = await fetch(`${BRIDGE}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Reply with the single word: ok' }] }),
    });
    const body = await res.json();
    const text = body?.choices?.[0]?.message?.content ?? '';
    if (!res.ok || !text.trim()) throw new Error(body?.error?.message ?? `empty reply (${res.status})`);
    report('round trip', 'ok', `${model} replied in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  } catch (err) {
    report('round trip', 'fail', err.message, 'check the bridge log and the tab console');
  }
}

console.log();
if (failed) console.log(red(`${failed} check${failed > 1 ? 's' : ''} failed.`) + dim(' Fix the first one — the rest usually follow.\n'));
else if (warned) console.log(yellow(`all clear, ${warned} warning${warned > 1 ? 's' : ''}.\n`));
else console.log(green('all good.\n'));

process.exit(failed ? 1 : 0);
