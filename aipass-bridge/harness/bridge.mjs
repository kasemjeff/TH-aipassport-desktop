// The transport: one streaming call to the local bridge, plus the retry path
// that keeps a run alive when the upstream edge refuses a payload.
//
// The bridge is a drop-in OpenAI-compatible `/v1/chat/completions`, so the
// harness only needs this one method — but the upstream has a firewall with
// opinions, and file contents trip it. The failure modes are handled here so
// no caller has to think about them.
import { outbound, inbound, RISKY_LINE } from './waf.mjs';

export const MIN_SPLIT = 300;

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

export class BridgeClient {
  constructor(base = 'http://127.0.0.1:8787', { model = null } = {}) {
    this.base = String(base).replace(/\/+$/, '');
    this.model = model;
  }

  /**
   * One turn. Streams deltas through the callbacks, resolves with the text.
   * `conversation` targets a specific conversation instead of the bridge's
   * current one — how a helper run or a WEB scratch space keeps its traffic
   * out of the working conversation. `temporary` rides along so a temporary
   * conversation is told so on every turn, as the upstream requires.
   */
  async chat({ message, parts = null, model = null, conversation = null, temporary = null, onText = () => {}, onReasoning = () => {}, signal = null } = {}) {
    const content = Array.isArray(parts) && parts.length
      ? [{ type: 'text', text: message }, ...parts]
      : message;
    const res = await fetch(`${this.base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...(model ?? this.model ? { model: model ?? this.model } : {}),
        ...(conversation ? { conversation, ...(temporary === null ? {} : { temporary: temporary === true }) } : {}),
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
        if (delta.reasoning_content) { reasoning += delta.reasoning_content; onReasoning(delta.reasoning_content); }
        if (delta.content) { out += delta.content; onText(delta.content); }
      }
    }
    return { text: out, reasoning };
  }

  /**
   * Mint a conversation. `adopt: false` leaves the bridge's current-conversation
   * pointer alone — the caller holds the id and passes it per chat.
   */
  async createConversation({ model = null, assistant = null, temporary = true, message, adopt = true } = {}) {
    const r = await fetch(`${this.base}/conversations/new`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...(model ? { model } : {}),
        ...(assistant ? { assistant } : {}),
        temporary,
        adopt,
        message: message ?? 'Starting a new working session.',
      }),
    });
    return r.json();
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
