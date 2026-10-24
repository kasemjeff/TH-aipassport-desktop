// The provider adapters — what a provider that is a plain HTTP API speaks.
//
// The harness talks to ONE client contract (the BridgeClient in bridge.mjs):
// chat, models, quota, config, createConversation. This file implements the
// same contract for a provider that is not de.aipass.net, so the loop, the
// tools, the compactor and the window never learn that a second kind of
// upstream exists.
//
// Three things differ from the AiPASS path, and each one is a rule the rest
// of the app already knows:
//
//   1. The history. de.aipass.net keeps the conversation and accepts one user
//      message per request, so the bridge owns the history. An API provider
//      is given the whole list, so this client keeps it — one array per
//      conversation id, the same id the harness already passes around.
//   2. The firewall. The WAF table (harness/waf.mjs) exists because the edge
//      in front of de.aipass.net refuses ordinary source code. No other
//      provider has that firewall, and encoding for it would hand the model
//      `CONSOLE-LOG` where its file said `console.log`. `waf = false` says so,
//      and the loop reads it.
//   3. The refusal chain. A 429 is a rate limit everywhere, so it is waited
//      out. A 403 on another provider is a permission error, not a refused
//      payload, so nothing is redacted, split or dropped.
import { scrubSecrets } from '../bridge/log-scrub.mjs';
import { BridgeClient, DEFAULT_BRIDGE_URL } from './bridge.mjs';

/** How the app's thinking levels map onto a provider's own reasoning knob. */
const EFFORT = { low: 'low', medium: 'medium', high: 'high', max: 'high' };

/** Anthropic asks for a thinking budget in tokens, not a level. */
const ANTHROPIC_BUDGET = { low: 1024, medium: 4096, high: 8192, max: 16384 };

/**
 * How long the provider's catalog may take.
 *
 * The catalog is asked for at the start of every run and by the sheet's
 * one-click check, so a provider that accepts the connection and never
 * answers must not be able to hang either of them.
 */
const MODELS_TIMEOUT_MS = 10_000;

/**
 * The deadline for one provider's catalog.
 *
 * The spec's own field wins (a provider that is slow on purpose says so),
 * then the environment (a machine behind a slow link says so once), then
 * the default. A value that is not a positive number is ignored: a broken
 * setting must never take the deadline away — that is the hang this exists
 * to end.
 *
 * @param {object} [spec]
 * @returns {number} milliseconds
 */
export function modelsTimeoutMs(spec = null) {
  const fromSpec = Number(spec?.modelsTimeoutMs);
  if (Number.isFinite(fromSpec) && fromSpec > 0) return Math.floor(fromSpec);
  const fromEnv = Number(process.env.AIPASS_PROVIDER_MODELS_TIMEOUT_MS);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return Math.floor(fromEnv);
  return MODELS_TIMEOUT_MS;
}

/**
 * Did the deadline fire?
 *
 * Node's timeout aborts with a TimeoutError; a fetch that was aborted for
 * any other reason says AbortError. Both mean the same thing here: the
 * provider did not answer in time.
 */
const isTimeout = (err) => err?.name === 'TimeoutError' || err?.name === 'AbortError';

/**
 * The two endpoints of a provider, from its base URL.
 *
 * The OpenAI-compatible shape carries its version in the base (`…/v1`), and a
 * bare host would send every request to a path that does not exist — so the
 * missing segment is added here rather than asked of the person typing it.
 * Anthropic puts the version on the path instead, and a base that already
 * ends in `/v1` is trimmed before the path is put back, so both spellings of
 * the same URL land on the same endpoint.
 */
export function endpointsFor(spec) {
  const base = String(spec.baseUrl ?? '').trim().replace(/\/+$/, '');
  if (spec.kind === 'anthropic') {
    const root = base.replace(/\/v1$/i, '');
    return { chat: `${root}/v1/messages`, models: `${root}/v1/models` };
  }
  const root = /\/v\d+$/i.test(base) ? base : `${base}/v1`;
  return { chat: `${root}/chat/completions`, models: `${root}/models` };
}

/**
 * The auth headers of a provider.
 *
 * OpenAI-compatible endpoints take a bearer token; Anthropic takes its own
 * header and wants a version with it. A provider that wants something else
 * (an `x-api-key` without the `Bearer ` prefix, say) says so in its spec —
 * that is what `apiKeyHeader` / `apiKeyPrefix` are for.
 */
export function authHeaders(spec, key) {
  if (!key) return {};
  if (spec.kind === 'anthropic') {
    return { 'x-api-key': key, 'anthropic-version': spec.anthropicVersion ?? '2023-06-01' };
  }
  const header = spec.apiKeyHeader ?? 'authorization';
  const prefix = spec.apiKeyPrefix ?? 'Bearer ';
  return { [header]: prefix ? `${prefix}${key}` : key };
}

/**
 * The SSE frames of a streaming response, as parsed JSON.
 *
 * Both shapes this file speaks arrive as `data:` lines: the OpenAI-compatible
 * one as `data: {…}` (and `data: [DONE]` at the end), the Anthropic one as
 * `data: {"type":"content_block_delta",…}` with the event name inside the
 * payload. A CRLF server is normal enough, so the frame split tolerates it.
 */
export async function* sseEvents(res) {
  const reader = res.body?.getReader?.();
  if (!reader) return;
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    buf = buf.replace(/\r\n/g, '\n');
    let cut;
    while ((cut = buf.indexOf('\n\n')) !== -1) {
      const frame = buf.slice(0, cut);
      buf = buf.slice(cut + 2);
      const data = frame.split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trim())
        .join('');
      if (!data || data === '[DONE]') continue;
      try {
        yield JSON.parse(data);
      } catch {
        // A frame that is not JSON is not a frame — a comment line, a keepalive.
      }
    }
  }
}

/** The media type of a data URI, or null when it is not one. */
function dataUriOf(url) {
  const m = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(String(url ?? ''));
  if (!m) return null;
  return { mediaType: m[1], base64: Boolean(m[2]), data: m[3] };
}

export class ApiProviderClient {
  /**
   * @param {object} spec      the provider spec (harness/providers.mjs)
   * @param {object} [opts]
   * @param {string} [opts.model]    the model to start on
   * @param {string} [opts.key]      the API key; never written anywhere here
   * @param {Function} [opts.onNote]      progress notes for the person
   * @param {Function} [opts.onStreamNote] notes the provider sends mid-reply
   */
  constructor(spec, { model = null, key = null, onNote = null, onStreamNote = null } = {}) {
    this.spec = spec;
    this.kind = spec.kind;
    this.providerId = spec.id;
    // The edge in front of de.aipass.net is the only firewall in the picture;
    // another provider gets the bytes as they are.
    this.waf = false;
    this._model = model ?? spec.defaultModel ?? null;
    this.key = key ?? null;
    this.onNote = onNote;
    this.onStreamNote = onStreamNote;
    // The history this client owns, one array per conversation id.
    this.conversations = new Map();
    this.current = null;
    this.#seq = 0;
  }

  #seq;

  get model() { return this._model; }
  set model(value) { this._model = value ?? null; }

  /** A conversation id this client can own. */
  #newConversation() {
    this.#seq += 1;
    return `${this.providerId}-${Date.now().toString(36)}-${this.#seq}`;
  }

  #history(id) {
    const key = id ?? this.current ?? this.#newConversation();
    if (!this.conversations.has(key)) this.conversations.set(key, []);
    if (!this.current) this.current = key;
    return this.conversations.get(key);
  }

  /**
   * One turn. Streams deltas through the callbacks, resolves with the text.
   *
   * The shape is the BridgeClient's, deliberately: the loop, the compactor
   * and the WEB tool all call it the same way, so a provider is a swap rather
   * than a rewrite.
   */
  async chat(args = {}) {
    const {
      message = '', parts = null, model = null, conversation = null,
      thinkingLevel = null, temperature = null, signal = null,
      onText = () => {}, onReasoning = () => {},
    } = args;
    const key = this.key;
    if (!key) {
      const where = this.spec.apiKeyEnv ? `$${this.spec.apiKeyEnv}` : 'the provider settings';
      throw new Error(`provider "${this.providerId}" has no API key — set ${where}`);
    }
    const useModel = model ?? this._model;
    if (!useModel) throw new Error(`provider "${this.providerId}" has no model selected`);

    const history = this.#history(conversation);
    const userMessage = this.#userMessage(message, parts);
    const body = this.#requestBody({
      model: useModel,
      messages: [...history, userMessage],
      thinkingLevel,
      temperature,
    });
    const res = await this.#post(endpointsFor(this.spec).chat, body, { key, signal });
    const { text, reasoning } = await this.#readStream(res, { onText, onReasoning });
    // The message joins the history only now: a send that failed leaves no
    // trace, so the retry after a 429 does not send it twice.
    history.push(userMessage, { role: 'assistant', content: text });
    return { text, reasoning };
  }

  /**
   * The model's catalog.
   *
   * A provider that cannot be asked for its catalog still has the list the
   * person wrote down, and the source says which one this is — the loop only
   * judges a model against a LIVE catalog (harness/loop.mjs), so a spec list
   * never stops a run over a model the provider still has.
   */
  async models() {
    const spec = this.spec;
    const fallback = (spec.models ?? []).map((id) => ({ id, name: id }));
    if (!this.key) return { data: fallback, source: fallback.length ? 'spec' : 'none' };
    const timeoutMs = modelsTimeoutMs(spec);
    // A deadline that holds the loop while it waits. Node's timeout timer is
    // unref'd, so a process whose only pending work is this fetch — the CLI
    // asking a provider for its catalog — would end with an unsettled promise
    // instead of the message that names the silent provider.
    const deadline = new AbortController();
    const timer = setTimeout(
      () => deadline.abort(new DOMException('the provider did not answer in time', 'TimeoutError')),
      timeoutMs,
    );
    try {
      const res = await fetch(endpointsFor(spec).models, {
        headers: { accept: 'application/json', ...authHeaders(spec, this.key) },
        // A deadline: a provider that takes the connection and never answers
        // would otherwise leave this promise pending for ever — and the loop
        // asks for the catalog at the START of every run, so one silent
        // endpoint hangs every run in the project before the first message.
        signal: deadline.signal,
      });
      if (!res.ok) throw new Error(`provider returned ${res.status}`);
      const body = await res.json();
      const list = Array.isArray(body?.data) ? body.data : (Array.isArray(body?.models) ? body.models : []);
      const rows = list
        .map((m) => ({
          id: String(m?.id ?? m?.name ?? ''),
          name: String(m?.display_name ?? m?.id ?? m?.name ?? ''),
        }))
        .filter((m) => m.id);
      if (!rows.length) throw new Error('the provider returned no models');
      // A model the person wrote down by hand stays in the list even when the
      // provider's own catalog does not name it — some gateways answer with a
      // subset, and the loop refuses a run whose model it cannot find. The
      // written model is a row like any other: an entry whose id is an object
      // reaches the window as "[object Object]" and is sent to the provider
      // as the model to run.
      for (const row of fallback) {
        if (!rows.some((r) => r.id === row.id)) rows.push(row);
      }
      return { data: rows, source: 'live' };
    } catch (err) {
      // The deadline fired: the answer says WHICH provider stayed silent and
      // how long it was given, so the sheet's one-click check and the run
      // that asked for the catalog say the same thing. The list the person
      // wrote down is still the answer — a timeout is not a broken provider.
      const error = isTimeout(err)
        ? `provider "${this.providerId}" did not answer the model list within ${timeoutMs} ms`
        : err.message;
      return { data: fallback, source: fallback.length ? 'spec' : 'none', error };
    } finally {
      // The deadline's timer ends with the fetch, answered or not: a timer
      // left running would hold the loop open for the rest of the process.
      clearTimeout(timer);
    }
  }

  /** A provider that is not aipass has no credit pool to report. */
  async quota() { return null; }

  /** The only thing the bridge's own /config carries that matters here. */
  async config(patch = {}) {
    if ('conversation' in patch) this.current = patch.conversation ?? null;
    return { ok: true };
  }

  /** A fresh conversation — a fresh empty history, owned by this client. */
  async createConversation({ model = null, temporary = true, message = null, adopt = true } = {}) {
    const id = this.#newConversation();
    this.conversations.set(id, []);
    if (adopt !== false) this.current = id;
    // The first message is what the AiPASS bridge would have put in the
    // conversation when it made one; here it is only a title, so it is kept
    // out of the history the model sees.
    void model; void message; void temporary;
    return { id, temporary };
  }

  async conversations() {
    return {
      conversations: [...this.conversations.entries()].map(([id, messages]) => ({
        id,
        title: messages[0]?.content?.slice?.(0, 60) ?? '',
        messages: messages.length,
      })),
    };
  }

  async status() {
    return {
      ok: true,
      provider: this.providerId,
      kind: this.kind,
      defaultModel: this._model,
      extensions: 0,
    };
  }

  /* ------------------------------------------------------------- internals */

  /** The user turn, in the shape this provider speaks. */
  #userMessage(message, parts) {
    if (this.kind === 'anthropic') {
      const blocks = [{ type: 'text', text: String(message ?? '') }];
      for (const part of Array.isArray(parts) ? parts : []) blocks.push(...anthropicBlocks(part));
      return { role: 'user', content: blocks };
    }
    if (Array.isArray(parts) && parts.length) {
      return { role: 'user', content: [{ type: 'text', text: String(message ?? '') }, ...parts] };
    }
    return { role: 'user', content: String(message ?? '') };
  }

  /** The request body, in the shape this provider speaks. */
  #requestBody({ model, messages, thinkingLevel, temperature }) {
    if (this.kind === 'anthropic') {
      const budget = ANTHROPIC_BUDGET[thinkingLevel] ?? null;
      const body = {
        model,
        max_tokens: Number(this.spec.maxTokens) > 0 ? Number(this.spec.maxTokens) : 8192,
        messages: messages.map((m) => ({
          role: m.role,
          content: Array.isArray(m.content)
            ? m.content
            : [{ type: 'text', text: String(m.content ?? '') }],
        })),
        stream: true,
      };
      if (budget) {
        body.thinking = { type: 'enabled', budget_tokens: budget };
        // Anthropic refuses a temperature other than 1 while thinking is on.
        if (body.max_tokens <= budget) body.max_tokens = budget + 4096;
      } else if (typeof temperature === 'number') {
        body.temperature = temperature;
      }
      return body;
    }
    const body = { model, messages, stream: true };
    if (typeof temperature === 'number') body.temperature = temperature;
    const effort = EFFORT[thinkingLevel] ?? null;
    if (effort) body.reasoning_effort = effort;
    return body;
  }

  async #post(url, body, { key, signal }) {
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream, application/json',
          ...authHeaders(this.spec, key),
          ...(this.spec.headers ?? {}),
        },
        body: JSON.stringify(body),
        ...(signal ? { signal } : {}),
      });
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
      throw new Error(`provider "${this.providerId}" is unreachable: ${err.message}`);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`provider returned ${res.status}${res.statusText ? ` ${res.statusText}` : ''}: ${scrubSecrets(body).slice(0, 300)}`);
    }
    return res;
  }

  async #readStream(res, { onText, onReasoning }) {
    const type = String(res.headers.get('content-type') ?? '');
    if (type.includes('application/json')) {
      // A provider that answered with a whole body instead of a stream.
      const body = await res.json();
      const text = String(body?.choices?.[0]?.message?.content ?? body?.content?.[0]?.text ?? '');
      const reasoning = String(body?.choices?.[0]?.message?.reasoning_content ?? '');
      if (reasoning) onReasoning(reasoning);
      if (text) onText(text);
      return { text, reasoning };
    }
    let text = '';
    let reasoning = '';
    for await (const evt of sseEvents(res)) {
      if (evt?.error) {
        throw new Error(`provider returned an error: ${scrubSecrets(JSON.stringify(evt.error)).slice(0, 300)}`);
      }
      if (this.kind === 'anthropic') {
        const delta = evt?.delta ?? {};
        if (delta.type === 'text_delta' && delta.text) {
          text += delta.text;
          onText(delta.text);
        } else if (delta.type === 'thinking_delta' && delta.thinking) {
          reasoning += delta.thinking;
          onReasoning(delta.thinking);
        }
        continue;
      }
      const delta = evt?.choices?.[0]?.delta ?? {};
      const think = delta.reasoning_content ?? delta.reasoning ?? null;
      if (think) {
        reasoning += think;
        onReasoning(think);
      }
      const content = typeof delta.content === 'string' ? delta.content : '';
      if (content) {
        text += content;
        onText(content);
      }
    }
    return { text, reasoning };
  }
}

/**
 * One OpenAI-shaped attachment part, in Anthropic's own blocks.
 *
 * A data URI becomes a base64 source; a plain https URL becomes a url source.
 * A part that is neither is dropped — Anthropic would refuse the whole turn
 * for a shape it does not know, and a dropped image is better than a failed
 * run.
 */
function anthropicBlocks(part) {
  const url = part?.image_url?.url ?? part?.file?.file_data ?? null;
  if (!url) return [];
  const uri = dataUriOf(url);
  if (uri) {
    const type = part?.type === 'file' ? 'document' : 'image';
    return [{
      type,
      source: { type: 'base64', media_type: uri.mediaType, data: uri.data },
    }];
  }
  if (/^https?:\/\//i.test(String(url))) {
    return [{ type: 'image', source: { type: 'url', url: String(url) } }];
  }
  return [];
}

export default ApiProviderClient;

/**
 * The client for a provider spec.
 *
 * AiPASS is the local bridge and its tab; every other provider is an HTTP API
 * this process calls itself. Both answer the same contract, so the harness is
 * handed one or the other and never asks which it got.
 */
export function clientFor(spec, { model = null, key = null, bridgeURL = null, onNote = null, onStreamNote = null } = {}) {
  if (!spec || spec.kind === 'aipass') {
    return new BridgeClient(bridgeURL ?? DEFAULT_BRIDGE_URL, { model, onNote, onStreamNote });
  }
  return new ApiProviderClient(spec, { model, key, onNote, onStreamNote });
}
