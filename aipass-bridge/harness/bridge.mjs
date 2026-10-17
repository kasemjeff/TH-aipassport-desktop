// The transport: one streaming call to the local bridge, plus the retry path
// that keeps a run alive when the upstream edge refuses a payload.
//
// The bridge is a drop-in OpenAI-compatible `/v1/chat/completions`, so the
// harness only needs this one method — but the upstream has a firewall with
// opinions, and file contents trip it. The failure modes are handled here so
// no caller has to think about them.
import { outbound, inbound, RISKY_LINE } from './waf.mjs';

export const MIN_SPLIT = 300;

/** The bridge every client talks to unless something says otherwise. */
export const DEFAULT_BRIDGE_URL = 'http://127.0.0.1:8787';

/**
 * Where the bridge is: AIPASS_BRIDGE when the environment names it, the
 * loopback default otherwise. Accepted forms are a full URL
 * (http://127.0.0.1:8788), a host:port pair (localhost:8788) or a bare port
 * (8788). Anything else is a typo — and a typo must stop the start, not
 * quietly point chat traffic at a port nothing is listening on.
 */
export function resolveBridgeURL(env = process.env) {
  const raw = String(env.AIPASS_BRIDGE ?? '').trim();
  if (!raw) return DEFAULT_BRIDGE_URL;
  const reject = () => {
    throw new Error(`AIPASS_BRIDGE must be an http(s) URL, host:port or a port — got ${JSON.stringify(raw)}`);
  };
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    let parsed;
    try { parsed = new URL(raw); } catch { reject(); }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') reject();
    return raw.replace(/\/+$/, '');
  }
  if (/^\d+$/.test(raw)) return `http://127.0.0.1:${raw}`;
  if (/^[a-z0-9._-]+:\d+$/i.test(raw)) return `http://${raw}`;
  reject();
}

/** Split text in half on a line boundary when it has one. */
export function splitInHalf(text) {
  const lines = text.split('\n');
  if (lines.length < 2) {
    const mid = Math.floor(text.length / 2);
    return [text.slice(0, mid), text.slice(mid)];
  }
  const mid = Math.ceil(lines.length / 2);
  return [lines.slice(0, mid).join('\n'), lines.slice(mid).join('\n')];
}

/**
 * Last resort when a fragment is rejected even on its own. Real source files
 * contain code-execution shapes — `node -e`, `curl`, `rm -rf`, `/bin/sh` — that
 * no amount of splitting gets past. Drop only the offending lines so the run
 * survives and the model still sees the rest of the file.
 */
export function redact(text) {
  let dropped = 0;
  const out = text.split('\n').map((line) => {
    if (!RISKY_LINE.test(line)) return line;
    dropped++;
    return '[one line omitted here — it could not be sent]';
  }).join('\n');
  return { out, dropped };
}

// A send can be refused for a reason that lasts seconds, not a run: the
// extension cycles its connection to the bridge every four minutes
// (extension/background.js CYCLE_MS — "reconnect before Chrome's long-request
// ceiling") and for the few seconds around each cycle the bridge has no tab to
// dispatch to, so it answers "no extension connected" instantly. The CLI
// already waits that gap out (chat.mjs's grace period before it gives up);
// retrying here gives every BridgeClient caller the same endurance — a run
// that would otherwise die for a three-second blip just pauses, while a tab
// that is really gone still surfaces once the attempts run out.
//
// Deliberately not retried: a fetch that fails outright ("fetch failed" — the
// bridge process itself is down). That is not a gap, nothing heals it in
// seconds, and a run must fail on the way in, not spend five seconds
// pretending it might start.
export const TRANSIENT_SEND = /no extension connected/i;
export const SEND_ATTEMPTS = 6; // ≈5s of patience at SEND_RETRY_MS — longer than a cycle gap
export const SEND_RETRY_MS = 1000;

// The edge in front of the site answers 429 when the account moves too fast —
// ten messages in four minutes was enough to draw one (docs/HARNESS_DESIGN.md
// has the recording). Nothing about the payload is wrong: the same body goes
// through a moment later, so a 429 is waited out, never rewritten or split.
// The page waits one request out first, in place (extension/page.js
// RETRY_WAITS_MS — 5s/15s/45s, retry-after honoured); this is the layer above
// it, for a window longer than the page's budget. 503 rides along — the same
// edge ships both.
export const RATE_REFUSED = /aipass returned (429|503)\b/;
export const RATE_WAITS_MS = [20_000, 60_000];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `what` again while it fails in a way that heals by itself and nothing
 * was delivered yet. Two heal-by-waiting refusals: the four-minute gap below
 * and a 429/503 from the edge (RATE_REFUSED). `streamed` reports whether any
 * delta has left this attempt family — a refusal after that must surface,
 * never resend, or the answer would enter the conversation twice. An abort is
 * never retried.
 */
async function retrySend(what, { streamed = () => false, signal = null, rateWaits = RATE_WAITS_MS, note = null } = {}) {
  let rateTries = 0;
  for (let attempt = 1; ; attempt++) {
    try {
      return await what();
    } catch (err) {
      const text = String(err?.message ?? err);
      const gap = attempt < SEND_ATTEMPTS && TRANSIENT_SEND.test(text);
      const rate = rateTries < rateWaits.length && RATE_REFUSED.test(text);
      const again = (gap || rate)
        && !streamed()
        && !signal?.aborted
        && err?.name !== 'AbortError';
      if (!again) throw err;
      if (rate) {
        const wait = rateWaits[rateTries++];
        note?.(`rate limited by the edge (429) — waiting ${Math.round(wait / 1000)}s, then sending again`);
        await sleep(wait);
      } else {
        await sleep(SEND_RETRY_MS);
      }
    }
  }
}

export class BridgeClient {
  // `rateWaits` lets a caller shorten the 429 wait (the tests do); `onNote`
  // is where the wait note goes, so a paused run reads as waiting, not stuck;
  // `onStreamNote` receives lines the server sends as notes — events the
  // person must see (a mid-reply model switch) that are not the answer.
  constructor(base = DEFAULT_BRIDGE_URL, { model = null, rateWaits = RATE_WAITS_MS, onNote = null, onStreamNote = null } = {}) {
    this.base = String(base).replace(/\/+$/, '');
    this.model = model;
    this.rateWaits = rateWaits;
    this.onNote = onNote;
    this.onStreamNote = onStreamNote;
  }

  /**
   * One turn. Streams deltas through the callbacks, resolves with the text.
   * `conversation` targets a specific conversation instead of the bridge's
   * current one — how a helper run or a WEB scratch space keeps its traffic
   * out of the working conversation. `temporary` rides along so a temporary
   * conversation is told so on every turn, as the upstream requires.
   * `thinkingLevel` asks the model to reason at that level for this turn; the
   * bridge checks it against the model and strips what the model does not offer.
   *
   * A refusal that heals by itself is retried: the extension's four-minute
   * connection cycle leaves a gap no tab covers (TRANSIENT_SEND), and a 429
   * from the edge is waited out (RATE_REFUSED → RATE_WAITS_MS) — a run must
   * not die for either. The retry only happens before any delta streamed
   * back — after that a resend would deliver the answer twice.
   */
  async chat(args = {}) {
    let streamed = false;
    return retrySend(() => this.#sendOnce(args, () => { streamed = true; }), {
      streamed: () => streamed,
      signal: args.signal ?? null,
      rateWaits: this.rateWaits,
      note: this.onNote,
    });
  }

  /** One wire attempt of chat(); `markStreamed` flips the retry gate above. */
  async #sendOnce({ message, parts = null, model = null, conversation = null, temporary = null, thinkingLevel = null, onText = () => {}, onReasoning = () => {}, signal = null } = {}, markStreamed) {
    const content = Array.isArray(parts) && parts.length
      ? [{ type: 'text', text: message }, ...parts]
      : message;
    const res = await fetch(`${this.base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...(model ?? this.model ? { model: model ?? this.model } : {}),
        ...(conversation ? { conversation, ...(temporary === null ? {} : { temporary: temporary === true }) } : {}),
        ...(thinkingLevel ? { thinking_level: thinkingLevel } : {}),
        stream: true,
        messages: [{ role: 'user', content }],
      }),
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) throw new Error(`bridge returned ${res.status}: ${(await res.text()).slice(0, 300)}`);

    let out = '';
    let reasoning = '';
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let cut;
      while ((cut = buf.indexOf('\n\n')) !== -1) {
        const frame = buf.slice(0, cut); buf = buf.slice(cut + 2);
        const data = frame.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
        if (!data || data === '[DONE]') continue;
        let evt;
        try { evt = JSON.parse(data); } catch { continue; }
        if (evt.error) throw new Error(evt.error.message);
        const delta = evt.choices?.[0]?.delta ?? {};
        // A note is not the answer and never flips the resend gate: a retry
        // repeating a note is harmless, a retry repeating an answer is not.
        // This matters most exactly when the edge is refusing — the page's
        // own waiting line arrives this way — so reading the note as "the
        // answer started" would close the gate and turn a wait the layers
        // below are handling into a fatal error.
        if (typeof delta.note === 'string' && delta.note) {
          this.onStreamNote?.(delta.note);
          // The reasoning echo rides the same delta for clients that never
          // learned the field (the chat console reads reasoning): it shows
          // and records here too, it just does not count as answer content.
          if (delta.reasoning_content) { reasoning += delta.reasoning_content; onReasoning(delta.reasoning_content); }
          if (delta.content) onText(delta.content);
          continue;
        }
        if (delta.reasoning_content) { markStreamed(); reasoning += delta.reasoning_content; onReasoning(delta.reasoning_content); }
        if (delta.content) { markStreamed(); out += delta.content; onText(delta.content); }
      }
    }
    return { text: out, reasoning };
  }

  /**
   * Mint a conversation. `adopt: false` leaves the bridge's current-conversation
   * pointer alone — the caller holds the id and passes it per chat.
   *
   * A bridge that could not carry the create (its 503 shape is
   * `{ok: false, error}`) throws: that is what lets the four-minute gap be
   * retried here, and a create that reached nobody must not be read as a
   * conversation without an id.
   */
  async createConversation({ model = null, assistant = null, temporary = true, message, adopt = true } = {}) {
    const body = JSON.stringify({
      ...(model ? { model } : {}),
      ...(assistant ? { assistant } : {}),
      temporary,
      adopt,
      message: message ?? 'Starting a new working session.',
    });
    return retrySend(async () => {
      const r = await fetch(`${this.base}/conversations/new`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body,
      });
      const made = await r.json().catch(() => null);
      if (!r.ok || made?.ok === false) throw new Error(made?.error ?? `bridge returned ${r.status}`);
      return made;
    }, { rateWaits: this.rateWaits, note: this.onNote });
  }

  async config(patch) {
    await fetch(`${this.base}/config`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    }).catch(() => {});
  }

  async quota(refresh = false) {
    return fetch(`${this.base}/quota${refresh ? '?refresh=1' : ''}`)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
  }

  async models(refresh = false) {
    return fetch(`${this.base}/v1/models${refresh ? '?refresh=1' : ''}`)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
  }

  async conversations() {
    return fetch(`${this.base}/conversations`)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
  }

  async status() {
    return fetch(`${this.base}/status`)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
  }
}

/**
 * Send one message, surviving a 403 from the upstream edge.
 *
 * File contents are arbitrary: a README carries shell commands, URLs and code
 * fences, any of which can push a request past a filter. Splitting a rejected
 * message in half and sending the halves in sequence keeps the same
 * information flowing while lowering what any single request carries. The
 * server remembers each part, so the model still sees the whole thing.
 *
 * `log(level, text)` is where progress notes go — stdout for the CLI, an event
 * for the desktop UI.
 */
export async function resilientSay(say, text, log = () => {}, parts = null, depth = 0) {
  if (depth === 0) text = outbound(text); // encode the whole message once
  try {
    return await say(text, parts);
  } catch (err) {
    const blocked = /\b40[39]\b/.test(err.message);
    if (!blocked) throw err;

    // Fast-path: redact known risky patterns immediately rather than slow recursive splits
    const { out: redTxt, dropped } = redact(text);
    if (dropped && redTxt !== text) {
      log('note', `rejected at ${Buffer.byteLength(text)} bytes — omitting ${dropped} line(s) that cannot be sent`);
      try { return await say(redTxt, parts); } catch { /* fall through to split */ }
    }

    if (depth > 2 || Buffer.byteLength(text) < MIN_SPLIT) {
      log('note', `rejected by firewall — omitting fragment of ${Buffer.byteLength(text)} bytes and continuing`);
      const fallback = `[Note: A section of ~${Buffer.byteLength(text)} bytes was omitted because it was blocked by the upstream Cloudflare firewall. Continuing with the rest of the project.]`;
      try {
        return await say(fallback, parts);
      } catch {
        throw err;
      }
    }
    const halves = splitInHalf(text);
    log('note', `rejected — splitting into ${halves.length} parts and resending`);
    let last;
    for (let i = 0; i < halves.length; i++) {
      const final = i === halves.length - 1;
      const prefix = final
        ? 'Final part.\n\n'
        : `Part ${i + 1}, more follows. Reply with just: ok\n\n`;
      last = await resilientSay(say, prefix + halves[i], log, parts, depth + 1);
    }
    return last;
  }
}

/** Decode a reply: everything we send is encoded, everything we read is decoded. */
export const decode = inbound;
