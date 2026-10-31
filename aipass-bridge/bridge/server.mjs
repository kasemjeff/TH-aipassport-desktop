// Local bridge to de.aipass.net's chat.
//
// The bridge never sees a session cookie. It hands work to the Chrome
// extension over SSE; the extension performs the real request from inside a
// de.aipass.net page, where the browser attaches credentials itself.
//
// Scope is deliberately narrow: send the user's message, stream the reply
// back. The server owns the conversation and its history, exactly as it does
// for the web UI, so there is nothing to reconstruct on this side.
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { MAX_ATTACHMENT_BYTES, isAllowedAttachment } from './attachment-types.mjs';
import { recordBridgePid, forgetBridgePid } from '../harness/bridge-pid.mjs';

const PORT = Number(process.env.AIPASS_PORT ?? 8787);
const HOST = process.env.AIPASS_HOST ?? '127.0.0.1';
// Fail closed if someone points the bridge at a LAN/wildcard address without
// opting in: this port spends the account, and binding it off-loopback with no
// auth repeats the pre-Sep-2026 exposure class (SECURITY.md). Opt out with
// AIPASS_ALLOW_REMOTE=1 behind your own proxy/auth.
{
  const loopback = HOST === '127.0.0.1' || HOST === 'localhost' || HOST === '::1' || HOST === '::ffff:127.0.0.1';
  if (!loopback && process.env.AIPASS_ALLOW_REMOTE !== '1') {
    console.error(`refusing to bind ${HOST} without AIPASS_ALLOW_REMOTE=1 (the token is a loopback secret; keep it on 127.0.0.1)`);
    process.exit(1);
  }
}
// The shared DEFAULT port with the token gate OFF is the one combination that
// leaves the account reachable by anything on the machine — and, because a
// cross-origin "simple" request needs no preflight, by any web page the user
// visits. The escape hatch (AIPASS_REQUIRE_AUTH=0) is for a foreground
// `aipass dev` and for the test suite, and neither wants the shared port
// without the token. A bridge on another port is harmless: the port is the
// only thing a web page can guess.
//
// This is the last line of defence for a case that kept happening: a run
// somewhere else started a bridge on 8787 with the gate off and left it
// there, and a web page could blind-POST to it and spend the account's
// credits. Opt out with AIPASS_ALLOW_INSECURE_DEFAULT_PORT=1 if you really
// mean it.
if (!authRequired() && PORT === 8787 && process.env.AIPASS_ALLOW_INSECURE_DEFAULT_PORT !== '1') {
  console.error('refusing to serve 8787 without the loopback bearer token (AIPASS_REQUIRE_AUTH=0).');
  console.error('  The no-token mode is for a foreground `aipass dev` and for the test suite, and neither wants the shared port.');
  console.error('  Use another port (AIPASS_PORT), or say AIPASS_ALLOW_INSECURE_DEFAULT_PORT=1 if you mean it.');
  process.exit(1);
}
const MODELS_FALLBACK = (process.env.AIPASS_MODELS ?? 'gemini-3.1-flash-lite,claude-sonnet-5@default')
  .split(',').map((s) => s.trim()).filter(Boolean);
// Where upstream tool activity (web_search progress, sources) goes:
// 'reasoning' -> delta.reasoning_content, 'text' -> inline, 'off' -> dropped.
const TOOL_VISIBILITY = process.env.AIPASS_TOOL_VISIBILITY ?? 'reasoning';
const PINNED_CONVERSATION = process.env.AIPASS_CONVERSATION_ID ?? '';
const IDLE_TIMEOUT_MS = Number(process.env.AIPASS_IDLE_TIMEOUT_MS ?? 180_000);
// How long a job waits for an extension to (re)connect before it fails. The
// MV3 service worker drops and rebuilds its SSE stream every few minutes, and
// in that gap there is briefly nobody attached — a chat that landed there
// failed outright with "no extension connected", even though the client came
// back seconds later. Loader reads skip the wait: they are best-effort cache
// refreshes, not work somebody is blocked on.
const DISPATCH_GRACE_MS = Number(process.env.AIPASS_DISPATCH_GRACE_MS ?? 5000);
// Rendering a video or a music clip can go quiet for minutes at a stretch. The
// timeout is on silence, not on total time, but three minutes of it is normal
// here and would kill a generation that was going to succeed — and the credits
// are already spent by then.
const MEDIA_TIMEOUT_MS = Number(process.env.AIPASS_MEDIA_TIMEOUT_MS ?? 900_000);
// How often a streaming response emits an SSE comment when it has nothing else
// to say. Comfortably inside the 300s body timeout that Node's own fetch applies.
const KEEPALIVE_MS = Number(process.env.AIPASS_KEEPALIVE_MS ?? 15_000);
// Attachments up to MAX_ATTACHMENT_BYTES travel Base64-inlined in a JSON
// envelope, which costs a third again plus escaping — the client-facing cap has
// to hold that whole envelope or the advertised 20 MB file is undeliverable.
const MAX_BODY = 32 * 1024 * 1024;
// The extension's own posts are trusted and carry generated media inline (a
// video up to the page's 50 MB inline cap is ~67 MB of Base64), so they get a
// higher ceiling than client requests.
const MAX_EXT_BODY = 128 * 1024 * 1024;

let defaultModel = process.env.AIPASS_MODEL ?? 'gemini-3.1-flash-lite';
// Bind newly created conversations to a custom aipass assistant. The form field
// name is not yet confirmed from a capture, so it is configurable; the default
// is the most likely candidate and is harmless if the server ignores it.
let assistantId = process.env.AIPASS_ASSISTANT_ID ?? '';
// Only the image models read this; the chat models ignore it. The web UI offers
// 1:1, 3:4 and 4:3, and a request may override the default per call.
let aspectRatio = process.env.AIPASS_ASPECT_RATIO ?? '1:1';
const ASSISTANT_FIELD = process.env.AIPASS_ASSISTANT_FIELD ?? 'aiAssistantId';

// The bridge has a bearer gate — every route but /status and /health needs
// the loopback token — so it is not open to whoever finds the port. The
// token is a loopback secret, though, and a page in the user's browser can
// still reach 127.0.0.1, so CORS is OFF by default: the CLI clients ignore
// CORS entirely and the extension reaches the bridge with host-permission
// privilege, so neither needs it. Set AIPASS_CORS_ORIGIN only if you
// deliberately want a browser page to call the bridge. Admin/deployment
// routes stay off unless AIPASS_ADMIN=1.
const CORS_ORIGIN = process.env.AIPASS_CORS_ORIGIN ?? '';
const ADMIN = process.env.AIPASS_ADMIN === '1';
// A random per-run token, handed to the extension over its own event stream
// and checked on every /ext post. The Host check keeps other machines out,
// but any local process could still POST as the extension once it learned a
// jobId from a log or a /status answer — the token is what tells the
// extension from every other local caller, and it changes with every bridge
// run, so nothing about it is worth carrying around.
const EXT_TOKEN = randomUUID();
// One-time pairing codes for the extension to claim the loopback token without
// a manual paste. code -> { expires, claimed }.
const pairCodes = new Map();
const ALLOWED_HOSTS = new Set([
  '127.0.0.1', 'localhost', '::1', '[::1]',
  ...(process.env.AIPASS_ALLOWED_HOSTS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
]);

// A DNS-rebinding attacker points a name they control at 127.0.0.1 and has the
// victim's browser POST here. Loopback literals are fine; an unexpected domain
// in the Host header is not.
function hostAllowed(req) {
  const hostname = String(req.headers.host ?? '').replace(/:\d+$/, '').toLowerCase();
  return !hostname || ALLOWED_HOSTS.has(hostname);
}

const corsHeaders = () => (CORS_ORIGIN
  ? { 'access-control-allow-origin': CORS_ORIGIN, 'access-control-allow-private-network': 'true' }
  : {});

// The scrub patterns live in their own module so tests pin the same list the
// logger uses (OWASP Logging Cheat Sheet: never log secrets).
import { scrubSecrets } from './log-scrub.mjs';
import { formatLogLine, requestId } from '../harness/log-line.mjs';

const log = (...a) => console.log(formatLogLine({ msg: a.map((x) => scrubSecrets(x instanceof Error ? x.stack : String(x))).join(' ') }));

// An extension without the loopback token is a silent loop: it retries every
// three seconds, every retry is a 401, and `/status` only says
// `extensions: 0` — nothing says why. The bridge says it once, with the
// remedy, instead of leaving the reader to guess between "no extension
// loaded" and "the token was never pasted". Throttled, because the retry
// loop would otherwise fill the log with the same line.
let lastUnauthExtensionLog = 0;
const UNAUTH_EXTENSION_LOG_EVERY_MS = 30_000;
// The same fact, for the readers that ask instead of reading the log: the
// window shows "extensions: 0" as "no extension connected" and sends the
// reader to load an extension that is already loaded. A refused extension is
// a different problem with a different fix, so the bridge remembers which
// one it is. Not a secret — it names a state, not a credential.
let extensionTokenMissing = false;
function noteUnauthenticatedExtension() {
  extensionTokenMissing = true;
  const now = Date.now();
  if (now - lastUnauthExtensionLog < UNAUTH_EXTENSION_LOG_EVERY_MS) return;
  lastUnauthExtensionLog = now;
  log('the extension was refused: it has no loopback token — paste the contents of '
    + '~/.aipass/.token into the extension popup (Advanced -> Loopback token) and save');
}

/* ------------------------------------------------- react-router turbo-stream */

// The app's .data loaders return a flat pool of values where objects address
// their keys and values by index.
function decodeTurboStream(text) {
  const flat = JSON.parse(text);
  const seen = new Map();
  const resolve = (ref) => {
    if (typeof ref !== 'number') return ref;
    if (ref < 0) return null; // undefined / null sentinels
    if (seen.has(ref)) return seen.get(ref);
    const v = flat[ref];
    if (Array.isArray(v)) {
      const out = [];
      seen.set(ref, out);
      for (const e of v) out.push(resolve(e));
      return out;
    }
    if (v && typeof v === 'object') {
      const out = {};
      seen.set(ref, out);
      for (const [k, valueRef] of Object.entries(v)) out[resolve(Number(k.slice(1)))] = resolve(valueRef);
      return out;
    }
    seen.set(ref, v);
    return v;
  };
  return resolve(0);
}

const LOADERS = {
  models: '/loaders/list-models.data?_routes=routes%2Floaders%2Flist-models',
  conversations: '/loaders/list-conversations.data?_routes=routes%2Floaders%2Flist-converstaions',
  // Unlike the other two this one answers with plain JSON and takes no _routes
  // parameter, so it is parsed rather than turbo-stream decoded.
  quota: '/loaders/get-usage-quota',
  assistants: '/loaders/list-ai-assistants.data?_routes=routes%2Floaders%2Flist-ai-assistants',
  // The four that describe what a video model will accept. Each answers with
  // rows keyed by *provider* — seedance, veo, or "all" — never by model id.
  videoResolutions: '/loaders/list-video-resolutions.data?_routes=routes%2Floaders%2Flist-video-resolutions',
  videoDurations: '/loaders/list-video-durations.data?_routes=routes%2Floaders%2Flist-video-durations',
  videoAspectRatios: '/loaders/list-video-aspect-ratios.data?_routes=routes%2Floaders%2Flist-video-aspect-ratios',
  videoStyles: '/loaders/list-video-styles.data?_routes=routes%2Floaders%2Flist-video-styles',
  // Image styles carry no preprompt — they are sent by id as imageStyleId,
  // unlike a video style, which is sent as its preprompt text.
  imageStyles: '/loaders/list-image-styles.data?_routes=routes%2Floaders%2Flist-image-styles',
  outputStyles: '/loaders/list-output-styles.data?_routes=routes%2Floaders%2Flist-output-styles',
};

// list-models carries no category field — the tabs in the web UI (สนทนา,
// สร้างรูปภาพ, สร้างวิดีโอ, สร้างเพลง, ค้นคว้าเชิงลึก) are built client-side, so
// the grouping has to be made here. These lists are the app's own, lifted
// verbatim from its bundle rather than guessed, and include ids the account
// cannot currently see — a model that appears later is then already classified.
const KIND_IDS = {
  image: ['gemini-2.5-flash-image', 'gemini-3.1-flash-image', 'gemini-3.1-flash-lite-image',
    'gemini-3-pro-image', 'FLUX.2-pro', 'gpt-image-2', 'seedream-4.0', 'seedream-4.5',
    'seedream-5.0-lite', 'flux2-klein-4b@jts', 'mock-remote-image'],
  video: ['veo-3.0-generate-001', 'veo-3.1-generate-001', 'veo-3.1-fast-generate-001', 'sora-2',
    'seedance-2.0', 'seedance-2.0-fast', 'seedance-2.0-mini', 'wan2.2@jts', 'mock-remote-video'],
  music: ['lyria-3-clip-preview', 'lyria-3-pro-preview'],
  research: ['gemini-2.5-pro-deep-research', 'openai-deep-research', 'sonar-deep-research',
    'mock-remote-deep-research'],
};
const KIND_BY_ID = new Map(Object.entries(KIND_IDS).flatMap(([kind, ids]) => ids.map((id) => [id, kind])));

// A model the lists have never heard of still has to land somewhere, so the old
// name-shaped rules stay as a fallback for anything new.
const KIND_PATTERNS = [
  ['image', /seedream|gpt-image|flux|-image$|image-preview/i],
  ['video', /^veo-|seedance|^sora-|^wan\d/i],
  ['music', /lyria/i],
  ['research', /deep-research/i],
];

const kindOf = (id) => KIND_BY_ID.get(id) ?? KIND_PATTERNS.find(([, re]) => re.test(id))?.[0] ?? 'chat';

// The submit route validates `provider` against its own small enum — veo, sora,
// seedance, wan — which is NOT the model's display provider (seedance's is
// "byteplus"). It is derived from the id prefix, the same way the app derives
// it, and a body carrying the wrong one is rejected as "Invalid request body".
const VIDEO_PROVIDERS = [
  ['seedance', /^seedance/i],
  ['veo', /^veo/i],
  ['sora', /^sora/i],
  ['wan', /^wan/i],
];
const videoProviderOf = (id) => VIDEO_PROVIDERS.find(([, re]) => re.test(id))?.[0];

// Last-resort resolutions, used only when the loader cannot be read — no tab, or
// the route moved. These came from the app bundle, and the live loader disagrees
// with them: it serves 480p alone for this account. That disagreement is the
// whole reason the served values win.
const VIDEO_RESOLUTIONS_FALLBACK = { seedance: ['480p', '720p'] };

// What the four video-option loaders returned, refreshed with the model list.
let videoOptions = { at: 0, resolutions: [], durations: [], aspectRatios: [], styles: [] };
// Image styles, and the tone/format presets that apply to any chat model.
let styleOptions = { at: 0, imageStyles: [], tones: [], formats: [] };

// Every one of those loaders answers with the same row shape, so one reader
// covers all four: the first array of objects carrying a string id.
function extractRows(decoded) {
  let rows = null;
  const walk = (v) => {
    if (!v || typeof v !== 'object' || rows) return;
    if (Array.isArray(v)) {
      if (v.length && v.every((x) => x && typeof x === 'object' && typeof x.id === 'string')) { rows = v; return; }
      return void v.forEach(walk);
    }
    Object.values(v).forEach(walk);
  };
  walk(decoded);
  return (rows ?? []).filter((r) => r.is_active !== false);
}

// Rows that apply to one provider. An "all" row applies to every provider, which
// is how 16:9 reaches veo while 21:9 stays specific to seedance.
const forProvider = (rows, provider) =>
  rows.filter((r) => r.provider === provider || r.provider === 'all');

const valuesFor = (rows, provider) => [...new Set(forProvider(rows, provider).map((r) => r.value))];

async function refreshVideoOptions() {
  const read = async (key) => {
    try { return extractRows(decodeTurboStream(await fetchLoader(LOADERS[key]))); }
    catch { return []; }
  };
  const [resolutions, durations, aspectRatios, styles] = await Promise.all([
    read('videoResolutions'), read('videoDurations'), read('videoAspectRatios'), read('videoStyles'),
  ]);
  if (resolutions.length || durations.length || aspectRatios.length || styles.length) {
    videoOptions = { at: Date.now(), resolutions, durations, aspectRatios, styles };
    log(`video options: ${resolutions.length} resolution(s), ${durations.length} duration(s), `
      + `${aspectRatios.length} ratio(s), ${styles.length} style(s)`);
  }
  return videoOptions;
}

async function refreshStyleOptions() {
  const read = async (key) => {
    try { return decodeTurboStream(await fetchLoader(LOADERS[key])); }
    catch { return null; }
  };
  const [imageDecoded, outputDecoded] = await Promise.all([read('imageStyles'), read('outputStyles')]);
  const imageStyles = imageDecoded ? extractRows(imageDecoded) : [];
  // Output styles answer with two named lists rather than one array, so they are
  // picked out by name instead of going through extractRows.
  let tones = [];
  let formats = [];
  const walk = (v) => {
    if (!v || typeof v !== 'object') return;
    if (Array.isArray(v.tones)) tones = v.tones;
    if (Array.isArray(v.formats)) formats = v.formats;
    Object.values(v).forEach(walk);
  };
  if (outputDecoded) walk(outputDecoded);
  if (imageStyles.length || tones.length || formats.length) {
    styleOptions = { at: Date.now(), imageStyles, tones, formats };
    log(`styles: ${imageStyles.length} image, ${tones.length} tone(s), ${formats.length} format(s)`);
  }
  return styleOptions;
}

// Match a preset by its English name, its Thai name, or its code — whichever the
// caller happened to have to hand.
const matchPreset = (rows, wanted) => {
  const want = String(wanted).trim().toLowerCase();
  return rows.find((r) =>
    String(r.name_en ?? r.nameEn ?? '').toLowerCase() === want
    || String(r.name_th ?? r.nameTh ?? '').trim() === String(wanted).trim()
    || String(r.code ?? '').toLowerCase() === want
    || String(r.id ?? '').toLowerCase() === want);
};

// A style may be named rather than pasted: --style Documentary resolves to that
// preset's preprompt, which is what the web client actually sends.
function stylePreprompt(text) {
  const wanted = String(text).trim().toLowerCase();
  const hit = videoOptions.styles.find((v) =>
    String(v.name_en ?? '').toLowerCase() === wanted || String(v.name_th ?? '').trim() === String(text).trim());
  return hit?.preprompt ?? text;
}

// How many images a video model will take alongside the prompt, and in which
// role. Not used to send anything yet; reported on /v1/models so a client can
// see what the model would accept.
const VIDEO_IMAGE_LIMITS = {
  'veo-3.0-generate-001': { maximumImages: 1, sourceImage: true, referenceImages: false },
  'veo-3.1-generate-001': { maximumImages: 3, sourceImage: true, referenceImages: true },
  'veo-3.1-fast-generate-001': { maximumImages: 3, sourceImage: true, referenceImages: true },
  'sora-2': { maximumImages: 1, sourceImage: true, referenceImages: false },
  'seedance-2.0': { maximumImages: 9, sourceImage: false, referenceImages: true },
  'seedance-2.0-fast': { maximumImages: 9, sourceImage: false, referenceImages: true },
  'seedance-2.0-mini': { maximumImages: 9, sourceImage: false, referenceImages: true },
  'wan2.2@jts': { maximumImages: 1, sourceImage: true, referenceImages: false },
};

// 'all' is the default: an image model you cannot see is one you cannot select.
// Set AIPASS_MODEL_FILTER=chat to get only the models a text client can drive.
const MODEL_FILTER = process.env.AIPASS_MODEL_FILTER ?? 'all';

function extractModels(decoded) {
  const out = [];
  const walk = (v) => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (!v || typeof v !== 'object') return;
    const id = v.id ?? v.modelId;
    if (typeof id === 'string' && id && !out.some((m) => m.id === id)) {
      const kind = kindOf(id);
      out.push({
        id,
        name: v.displayName ?? v.name ?? id,
        provider: v.providerName ?? v.provider ?? null,
        providerId: v.provider ?? null,
        description: v.description ?? null,
        kind,
        free: v.isFreeCredit === true,
        ready: v.ready !== false,
        // One model in the live list is ready but not selectable
        // (openthai2.0-legal@jts); the web UI does not offer it.
        selectable: v.selectable !== false,
        isDefault: v.isDefault === true,
        thinking: Array.isArray(v.thinkingConfig?.supportedLevels) ? v.thinkingConfig.supportedLevels : null,
        media: kind !== 'chat' && kind !== 'research',
      });
    }
    Object.values(v).forEach(walk);
  };
  walk(decoded);
  const usable = out.filter((m) => m.ready && m.selectable);
  return MODEL_FILTER === 'chat' ? usable.filter((m) => !m.media) : usable;
}

/* ---------------------------------------------------------------- job hub */

const jobs = new Map();
const extClients = new Set();
/** The cache warm already ran for this process; see extEvents(). */
let warmLoaded = false;
let rr = 0;

const pickClient = () => {
  const list = [...extClients];
  return list.length ? list[rr++ % list.length] : null;
};

const sendToClient = (client, event, data) => {
  try {
    client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    return true;
  } catch {
    return false; // socket died mid-dispatch — the caller fails the job, not the process
  }
};

/** Deltas buffer this long before one flush downstream; see Job.delta. */
const DELTA_FLUSH_MS = 25;
/** Part kinds whose text coalesces harmlessly when adjacent. */
const TEXT_KINDS = new Set(['content', 'reasoning', 'status']);

class Job {
  constructor({ kind = 'chat', modelId, text, parts, conversationId, aspectRatio: ratio, url, message, requestId, assistant, assistantField, temporary, thinkingLevel, temperature, video, spec, imageStyleId, outputTone, outputFormat, rewriteOnRefusal, timeoutMs, onDelta, onDone, onError }) {
    this.id = randomUUID();
    this.kind = kind;
    this.url = url;
    this.message = message;
    this.requestId = requestId;
    this.assistant = assistant;
    this.assistantField = assistantField;
    this.temporary = temporary;
    this.thinkingLevel = thinkingLevel;
    this.temperature = (typeof temperature === 'number' && Number.isFinite(temperature))
      ? Math.min(2, Math.max(0, temperature)) : undefined;
    this.video = video;
    this.spec = spec;
    this.imageStyleId = imageStyleId;
    this.outputTone = outputTone;
    this.outputFormat = outputFormat;
    // The client says it rewrites a refused message (the harness does — it
    // holds the chain that can fix one). The extension then hands a 403 back
    // at once instead of re-sending the same bytes, so the client's own fix
    // is one request away rather than 75 seconds away.
    this.rewriteOnRefusal = rewriteOnRefusal === true;
    this.timeoutMs = timeoutMs ?? IDLE_TIMEOUT_MS;
    this.modelId = modelId;
    this.text = text;
    this.parts = parts;
    this.conversationId = conversationId;
    this.aspectRatio = ratio;
    this.onDelta = onDelta;
    this.onDone = onDone;
    this.onError = onError;
    this.settled = false;
    this.touch();
    jobs.set(this.id, this);
  }
  touch() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.fail('timed out waiting for the extension'), this.timeoutMs);
  }
  dispatch() {
    const client = pickClient();
    if (!client) {
      // A loader read is this bridge refreshing its own cache: nobody is
      // blocked on it, so it fails at once.
      if (this.kind === 'loader') {
        return this.fail('no extension connected — open a de.aipass.net tab and check the popup');
      }
      // The service worker cycles its SSE connection every few minutes, and in
      // that gap there is briefly nobody attached. A job that lands there used
      // to fail outright, even though a client reappears seconds later — so
      // wait a little for one before giving up.
      if ((this.waited ?? 0) >= DISPATCH_GRACE_MS) {
        return this.fail('no extension connected — open a de.aipass.net tab and check the popup');
      }
      const waited = this.waited ?? 0;
      const timer = setTimeout(() => {
        if (this.settled || jobs.get(this.id) !== this) return;
        this.waited = waited + 500;
        this.dispatch();
      }, 500);
      // The wait must not hold the process open on its own.
      timer.unref?.();
      return;
    }
    this.client = client;
    try {
      const ok = sendToClient(client, 'job', this.kind === 'loader'
      ? { jobId: this.id, kind: 'loader', url: this.url }
      : this.kind === 'create'
      ? { jobId: this.id, kind: 'create', modelId: this.modelId, message: this.message, requestId: this.requestId, assistant: this.assistant, assistantField: this.assistantField, temporary: this.temporary }
      : this.kind === 'assistant'
      ? { jobId: this.id, kind: 'assistant', ...this.spec }
      : this.kind === 'video'
      ? { jobId: this.id, kind: 'video', conversationId: this.conversationId, modelId: this.modelId, text: this.text, ...this.video }
      : { jobId: this.id, kind: 'chat', conversationId: this.conversationId, modelId: this.modelId, text: this.text, parts: this.parts, aspectRatio: this.aspectRatio, temporary: this.temporary, thinkingLevel: this.thinkingLevel, temperature: this.temperature, imageStyleId: this.imageStyleId, outputTone: this.outputTone, outputFormat: this.outputFormat, rewriteOnRefusal: this.rewriteOnRefusal });
      // A dead socket must fail this job now — not leak it until the idle
      // timeout fires minutes later with jobs.size inflated.
      if (!ok) return this.fail('extension disconnected mid-dispatch — reconnect the tab and retry');
    } catch (err) {
      return this.fail(`could not dispatch to the extension: ${err.message}`);
    }
  }
  // Deltas arrive in bursts (the page already batches at 40 ms), and each part
  // used to become its own SSE frame downstream. Buffer for one short tick,
  // then flush: adjacent text of the same kind merges into one part — the same
  // bytes, in the same order, as a fraction of the frames. Flushing before
  // done/fail/abort makes the buffer invisible at every edge, so nothing is
  // ever lost to the timer.
  delta(part) {
    if (this.settled) return;
    this.touch();
    (this.pending ??= []).push(part);
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => { this.flushTimer = null; this.flush(); }, DELTA_FLUSH_MS);
    this.flushTimer.unref?.();
  }
  flush() {
    const parts = this.pending;
    this.pending = undefined;
    if (!parts) return;
    const out = [];
    for (const p of parts) {
      const last = out.at(-1);
      if (last && last.kind === p.kind && TEXT_KINDS.has(p.kind)
        && typeof last.text === 'string' && typeof p.text === 'string') {
        last.text += p.text;
        continue;
      }
      out.push({ ...p });
    }
    for (const p of out) {
      // A frame the handler cannot use must not take the job down with it.
      // The flush runs inside a timer, so an exception here would take the
      // whole bridge process with it; and a job left unsettled waits out its
      // timeout before the client hears anything at all.
      try { this.onDelta(p); } catch (err) { log('delta dropped:', err.message); }
    }
  }
  done(value) { if (this.settled) return; this.flush(); this.cleanup(); this.onDone(value ?? 'stop'); }
  fail(message) {
    if (this.settled) return;
    this.flush();
    // A timeout or an upstream failure is not the end of the work: the page
    // keeps polling a video job and keeps a generation running upstream. Tell
    // it to stop the same way abort() does, or the account keeps paying for a
    // result nobody will collect.
    if (this.client) sendToClient(this.client, 'abort', { jobId: this.id });
    this.cleanup();
    this.onError(message);
  }
  abort() {
    if (this.settled) return;
    this.flush();
    if (this.client) sendToClient(this.client, 'abort', { jobId: this.id });
    this.cleanup();
  }
  cleanup() { this.settled = true; clearTimeout(this.timer); clearTimeout(this.flushTimer); jobs.delete(this.id); }
}

const fetchLoader = (url, timeoutMs = 20_000) =>
  new Promise((resolve, reject) => {
    const job = new Job({ kind: 'loader', url, timeoutMs, onDelta: () => {}, onDone: resolve, onError: (m) => reject(new Error(m)) });
    job.dispatch();
  });


/* ------------------------------------------------------------------ models */

let modelCache = { at: 0, models: [] };
let modelRefresh = null;
const MODEL_TTL_MS = 60_000;

/* What the window is looking at, said plainly.
 *
 * The catalog is fetched by the extension, in the page, from the site — so a
 * window that cannot reach a tab is looking at a two-id stub and nothing
 * says so. `source` is 'live' for the real catalog and 'fallback' for the
 * stub; `at` is the stamp of the last CHANGE (not the last fetch), so a
 * window can watch it and rebuild only when the list really moved; `error`
 * is the last failure, which used to be logged and then lost — that is why
 * the window could not say what went wrong.
 *
 * `/status` carries this under `catalog`: the bridge's own `models` field is
 * the list itself, and two things called `models` would be a trap. */
const modelState = { source: 'fallback', at: 0, count: 0, error: null };

/** 'live' when the cache holds a real catalog, 'fallback' for the stub. */
const catalogSource = () => (modelCache.models.length ? 'live' : 'fallback');

/** The list's identity — two lists are the same list when their ids match. */
const catalogSignature = () => modelCache.models.map((m) => m.id).join(',');

/* What the caches saved. A hit is a caller answered without starting upstream
 * work — a fresh TTL entry, a refresh already in flight that this call joined,
 * or the last-known figures while no tab is attached. A fetch is the call that
 * actually went to the browser. `/status` reports them under `cache` and the
 * window prints the line, so "why is it poking my tab" has an answer with
 * numbers (test/bridge.test.mjs). */
const cacheStats = {
  models: { hits: 0, fetches: 0 },
  quota: { hits: 0, fetches: 0 },
  conversation: { hits: 0, fetches: 0 },
};

const cachedModels = () =>
  modelCache.models.length
    ? modelCache.models
    : MODELS_FALLBACK.map((id) => ({ id, name: id, provider: null, free: false, ready: true, selectable: true, kind: kindOf(id), thinking: null }));

// The thinking level a model will actually accept, or undefined. Falls back to
// the common three when the model list has not been fetched yet, so a request
// made before the first refresh is not silently stripped.
function thinkingLevelFor(modelId, level) {
  const known = cachedModels().find((m) => m.id === modelId)?.thinking;
  const allowed = Array.isArray(known) && known.length ? known : ['low', 'medium', 'high'];
  return allowed.includes(level) ? level : undefined;
}

async function listModels({ force = false } = {}) {
  if (!force && modelCache.models.length && Date.now() - modelCache.at < MODEL_TTL_MS) {
    cacheStats.models.hits += 1;
    return modelCache.models;
  }
  if (!extClients.size) {
    if (modelCache.models.length) cacheStats.models.hits += 1;
    return cachedModels();
  }
  if (modelRefresh) { // several callers can race; only one should hit the API
    cacheStats.models.hits += 1;
    return modelRefresh;
  }
  cacheStats.models.fetches += 1;
  modelRefresh = (async () => {
    const before = catalogSignature();
    const source = modelState.source;
    try {
      const models = extractModels(decodeTurboStream(await fetchLoader(LOADERS.models)));
      if (models.length) {
        modelCache = { at: Date.now(), models };
        modelState.error = null;
        const free = models.filter((m) => m.free).map((m) => m.id);
        const byKind = [...new Set(models.map((m) => m.kind))]
          .map((k) => `${models.filter((m) => m.kind === k).length} ${k}`).join(', ');
        log(`${models.length} models (${byKind})${free.length ? ` · free credit: ${free.join(', ')}` : ''}`);
      } else {
        modelState.error = 'the site answered with no models';
      }
    } catch (err) {
      modelState.error = err.message;
      log('model refresh failed:', err.message);
    } finally {
      modelState.source = catalogSource();
      modelState.count = modelCache.models.length;
      // The stamp is the last CHANGE, not the last fetch: a window watches it
      // and rebuilds the dropdown when it moves, so a fetch that returned the
      // same list must not cost a rebuild — and a catalog that just became
      // live must move it even though the ids did not change.
      if (modelState.source !== source || catalogSignature() !== before) modelState.at = Date.now();
      modelRefresh = null;
    }
    return cachedModels();
  })();
  return modelRefresh;
}

/* A stub is the bridge's own failure state, so the bridge retries it.
 *
 * The one-shot warm at attach time is not enough: it can land before the
 * page is logged in, and then nothing else ever asks again — the window sits
 * on the stub until somebody reloads it. This retries while the catalog is
 * still a stub and an extension is attached, and it stops the moment a real
 * catalog lands. A tab nobody is using is not poked forever: the retry exists
 * only in the state where there is nothing to show.
 *
 * `AIPASS_MODEL_RETRY_MS=0` turns it off. */
const MODEL_RETRY_MS = Number(process.env.AIPASS_MODEL_RETRY_MS ?? 30_000);
let modelRetry = null;

function armModelRetry() {
  if (modelRetry || MODEL_RETRY_MS <= 0) return;
  modelRetry = setInterval(() => {
    if (modelCache.models.length) { clearInterval(modelRetry); modelRetry = null; return; }
    if (!extClients.size) return;   // nothing to fetch from — wait for a tab
    listModels({ force: false }).catch(() => {});
  }, MODEL_RETRY_MS);
  // The timer is not a reason to stay alive: it only fires while the server
  // is holding the process open.
  modelRetry.unref?.();
}

/* --------------------------------------------------------------- credits */

// Everything but gemini-3.1-flash-lite draws on a credit pool, and until now the
// only place that number appeared was the web UI. Raw figures are integers
// scaled by creditsDecimals: 10000000000 at 6 decimals is a pool of 10,000.
let quotaCache = { at: 0, value: null };
let quotaRefresh = null;
const QUOTA_TTL_MS = 30_000;

function extractQuota(payload) {
  const credits = payload?.creditStatus?.credits;
  if (!credits) return null;
  const scale = 10 ** Number(payload.creditStatus.creditsDecimals ?? 0);
  const scaled = (v) => (v == null ? null : Number(v) / scale);
  const video = payload?.videoQuotaStatus?.count ?? null;
  return {
    limit: scaled(credits.limit),
    used: scaled(credits.used),
    available: scaled(credits.available),
    periodEndsAt: payload.creditStatus.periodEndsAt ?? null,
    video: video ? { limit: video.limit, used: video.used, remaining: video.remaining, period: video.period } : null,
    fetchedAt: payload.creditStatusFetchedAt ?? Date.now(),
  };
}

// Returns the last known figures rather than throwing when nothing is attached,
// so a caller can render "unknown" instead of an error.
async function getQuota({ force = false } = {}) {
  if (!force && quotaCache.value && Date.now() - quotaCache.at < QUOTA_TTL_MS) {
    cacheStats.quota.hits += 1;
    return quotaCache.value;
  }
  if (!extClients.size) {
    if (quotaCache.value) cacheStats.quota.hits += 1;
    return quotaCache.value;
  }
  if (quotaRefresh) { // several callers can race; only one should hit the API
    cacheStats.quota.hits += 1;
    return quotaRefresh;
  }
  cacheStats.quota.fetches += 1;
  quotaRefresh = (async () => {
    try {
      const value = extractQuota(JSON.parse(await fetchLoader(LOADERS.quota)));
      if (value) {
        // The window polls credits every 10s while idle, so this line used to
        // repeat identically thousands of times a day. Log only a change —
        // the first sighting, a different figure, or a new limit.
        //
        // The change is measured on the figures the LINE shows, rounded: a
        // balance that moves by a fraction prints the same numbers again, and
        // printing the same line is the noise this guard exists to stop.
        const shown = (v) => Number(v).toFixed(0);
        const prev = quotaCache.value;
        const changed = !prev
          || shown(prev.available) !== shown(value.available)
          || shown(prev.limit) !== shown(value.limit);
        quotaCache = { at: Date.now(), value };
        if (changed) {
          log(`credits ${shown(value.available)} of ${shown(value.limit)} left`);
        }
      }
    } catch (err) {
      log('credit refresh failed:', err.message);
    } finally {
      quotaRefresh = null;
    }
    return quotaCache.value;
  })();
  return quotaRefresh;
}

/* ----------------------------------------------------------- conversations */

// Conversations are created by the server; posting to an invented id is
// rejected. Reuse the most recent, and move on if one stops accepting messages.
let conversationCache = null;
// Whether the cached conversation was created with intent=create-temporary-chat.
// Every turn of a temporary chat has to repeat the flag, so it is tracked here.
let conversationIsTemporary = false;
let conversationList = [];
let conversationIndex = 0;

async function loadConversations() {
  if (!extClients.size) throw new Error('no extension connected — cannot look up a conversation');
  // One upstream list read, wherever it was asked for: resolving a nameless
  // send or the explicit GET /conversations route. Counting it here keeps the
  // two paths from drifting (and a call with no tab attached is not a fetch).
  cacheStats.conversation.fetches += 1;
  const decoded = decodeTurboStream(await fetchLoader(LOADERS.conversations));
  const list = [];
  const walk = (v) => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (!v || typeof v !== 'object') return;
    if (typeof v.id === 'string' && typeof v.updatedAt === 'string') list.push(v);
    Object.values(v).forEach(walk);
  };
  walk(decoded);
  list.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  conversationList = list;
  return list;
}

function findValue(node, key) {
  if (Array.isArray(node)) {
    for (const v of node) { const hit = findValue(v, key); if (hit != null) return hit; }
    return null;
  }
  if (!node || typeof node !== 'object') return null;
  if (typeof node[key] === 'string') return node[key];
  for (const v of Object.values(node)) { const hit = findValue(v, key); if (hit != null) return hit; }
  return null;
}

// The chat page creates a conversation by posting its first message to
// /chat.data; the server derives the id from clientCreateRequestId.
// `temporary: true` posts intent=create-temporary-chat instead. The server
// mints a conversation that never appears in the account's history and expires
// on its own — which is what an agent run wants: nothing to clean up, nothing
// to rotate past, and no earlier conversation to inherit.
// `adopt` is false for conversations a caller only borrows — a helper run, a
// WEB scratch space — so the bridge's current-conversation pointer is not
// moved and no save/restore dance is needed around the borrower.
async function createConversation({ modelId = defaultModel, message = 'Hello', assistant, temporary = false, adopt = true } = {}) {
  const requestId = randomUUID();
  const raw = await new Promise((resolve, reject) => {
    const job = new Job({
      kind: 'create', modelId, message, requestId, temporary,
      assistant: assistant ?? assistantId, assistantField: ASSISTANT_FIELD,
      timeoutMs: 30_000,
      onDelta: () => {}, onDone: resolve, onError: (m) => reject(new Error(m)),
    });
    job.dispatch();
  });
  const decoded = decodeTurboStream(raw);
  // create-conversation answers with conversationId; create-temporary-chat
  // answers with the conversation object, whose id lives under `id`.
  const id = findValue(decoded, 'conversationId') ?? findValue(decoded, 'id');
  if (!id) throw new Error(`could not read a conversation id from the response: ${raw.slice(0, 200)}`);
  if (adopt) {
    conversationCache = id;
    conversationIsTemporary = Boolean(temporary);
    conversationIndex = 0;
    conversationList = [];
  }
  log(`created ${temporary ? 'temporary ' : ''}conversation ${id}${adopt ? '' : ' (borrowed)'}`);
  return id;
}

async function resolveConversation() {
  if (PINNED_CONVERSATION) return PINNED_CONVERSATION;
  // A temporary conversation is the private working space of whichever session
  // minted it (a desktop run, an agent run). Adopting it as the shared pointer
  // is fine — the session keeps passing the id itself — but a caller with no
  // conversation of its own must not be handed it: its send would land inside
  // another session's private conversation, reading context it never saw
  // written. Such a caller resolves from the account's own list instead.
  if (conversationCache && !conversationIsTemporary) {
    cacheStats.conversation.hits += 1;
    return conversationCache;
  }
  // A temporary pointer is private to the session that made it, so a nameless
  // caller falls through to the account's list. That list is itself a cache:
  // after the first load, picking from it is a hit, not another upstream read.
  const fromCachedList = conversationList.length > 0;
  if (!fromCachedList) await loadConversations();
  const pick = conversationList[conversationIndex];
  if (!pick) {
    throw new Error('no usable conversation — open https://de.aipass.net/chat, start one, then POST /config {"conversation":null}');
  }
  if (fromCachedList) cacheStats.conversation.hits += 1;
  conversationCache = pick.id;
  conversationIsTemporary = pick.isTemporary === true;
  log(`conversation ${conversationCache} (${pick.title ?? 'untitled'})`);
  return conversationCache;
}

/* --------------------------------------------------------------- chat flow */

// A 404 means the conversation was deleted; a 409 means the server still
// believes a generation is running there. Neither recovers on its own.
function startChat({ modelId, text, parts, aspectRatio: ratio, thinkingLevel, temperature, video, imageStyleId, outputTone, outputFormat, rewriteOnRefusal = false, conversation: fixedConversation = null, temporary: fixedTemporary = null, onDelta, onDone, onError }) {
  // A video model does not go through /actions/send-message at all — it is a
  // job submitted to /actions/video-generation and then polled. Same Job
  // machinery, different kind, so retries and aborts behave the same way.
  const isVideo = kindOf(modelId) === 'video';
  let attempts = 0;
  let delivered = 0;
  let current = null;
  // The conversation lookup is a loader read, and a loader read needs an
  // attached tab. If the extension is merely mid-reconnect, wait it out — the
  // same grace a job with no conversation work left gets from dispatch().
  const deadline = Date.now() + DISPATCH_GRACE_MS;

  const attempt = async () => {
    attempts++;
    let conversationId;
    let jobTemporary;
    if (fixedConversation) {
      // A named conversation belongs to its caller: no cache resolution, and
      // no rotation onto the next conversation when it rejects — the caller
      // decides what a dead conversation means for it.
      conversationId = fixedConversation;
      jobTemporary = fixedTemporary === true;
    } else {
      try { conversationId = await resolveConversation(); }
      catch (err) {
        if (/no extension connected/.test(err.message) && Date.now() < deadline) {
          setTimeout(attempt, 500);
          return;
        }
        return onError(err.message);
      }
      jobTemporary = conversationIsTemporary;
    }

    current = new Job({
      kind: isVideo ? 'video' : 'chat',
      modelId, text, parts, conversationId, aspectRatio: ratio, thinkingLevel, temperature,
      imageStyleId, outputTone, outputFormat, rewriteOnRefusal,
      temporary: jobTemporary,
      // No aspect-ratio fallback here: videoOptionsFor already read the request
      // and dropped a ratio this provider is not served. Re-adding the raw value
      // would put back exactly what validation just removed.
      video: isVideo ? video : undefined,
      // An image generation goes quiet for the whole render, exactly like a
      // video: the 3-minute idle timeout killed image jobs that were about to
      // succeed, with the credits already spent.
      timeoutMs: ['video', 'music', 'image'].includes(kindOf(modelId)) ? MEDIA_TIMEOUT_MS : IDLE_TIMEOUT_MS,
      onDelta: (part) => { delivered++; onDelta(part); },
      onDone,
      onError: (message) => {
        const rejected = /conversation not found|returned 404|returned 409/i.test(message);
        if (rejected && attempts <= 3 && delivered === 0 && !PINNED_CONVERSATION && !fixedConversation) {
          log(`conversation ${conversationId} rejected, trying the next one`);
          conversationIndex++;
          conversationCache = null;
          attempt();
          return;
        }
        onError(message);
      },
    });
    current.dispatch();
  };

  attempt();
  return { abort: () => current?.abort() };
}

// The private-network classifier lives in its own module so the harness's
// FETCH tool guards with exactly the same rules as the attachment path here.
import { isPrivateHost, hostResolvesPrivate, pinnedGet, resolveVetted } from './private-hosts.mjs';
import { authorized, authRequired, tokenPath, loadOrMintToken } from '../harness/authtoken.mjs';

// What may be attached to a message — the table is shared with the desktop's
// staged uploads and the agent's ATTACH tool, in bridge/attachment-types.mjs,
// so the three cannot drift.

// Fetch a remote attachment and convert it to a Base64 data URI, with the SSRF
// guard. `kind` narrows what content-type is acceptable: an image_url part will
// take nothing but an image, a file part will also take a document.
//
// Redirects are followed manually so every hop is re-checked: fetch's own
// follow would happily deliver a public URL that 302s to 169.254.169.254,
// which is the classic way past a first-URL-only guard.
//
// `transport` is the request that carries the vetted address to the socket
// (private-hosts.mjs); it is a parameter so the guard can be driven without
// a network in a test. `resolve` is the resolver for the same reason: the
// name is vetted by the answers it gives, and every answer is checked.
async function fetchRemoteAsDataUri(urlStr, kind = 'image', { transport = pinnedGet, resolve = resolveVetted } = {}) {
  const REDIRECTS = new Set([301, 302, 303, 307, 308]);
  let current = new URL(urlStr);
  for (let hop = 0; ; hop++) {
    if (current.protocol !== 'http:' && current.protocol !== 'https:') {
      throw new Error(`unsupported protocol: ${current.protocol}`);
    }
    const host = current.hostname.toLowerCase();
    if (isPrivateHost(host)) {
      throw new Error(`refusing private/internal network fetch: ${host}`);
    }
    // The name is resolved ONCE and the connection is pinned to the answer
    // that was vetted. Resolving twice — once for the check, once for the
    // request — is the DNS-rebinding hole: a name with a TTL of zero answers
    // public for the check and private for the request, and the request
    // lands on 127.0.0.1 while the guard saw a public address.
    let addresses = null;
    if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(host) && !host.includes(':')) {
      let vetted;
      try {
        vetted = await resolve(host);
      } catch {
        // No answer, no verdict: a name that cannot be resolved cannot be
        // vetted, and an unvetted name is not fetched.
        throw new Error(`refusing fetch: ${host} could not be resolved, and an unresolvable name cannot be vetted`);
      }
      if (vetted.private) {
        throw new Error(`refusing fetch: ${host} resolves to a private/internal address`);
      }
      addresses = vetted.addresses;
    }

    let res;
    try {
      res = await transport(current, {
        addresses,
        maxBytes: MAX_ATTACHMENT_BYTES,
        timeoutMs: 15_000,
        headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      });
    } catch (err) {
      // The transport refuses an announced size over the cap before it reads
      // a byte of it; this path says so in the attachment's own words.
      if (err?.code === 'BODY_TOO_LARGE') throw new Error(`attachment too large: ${err.message}`);
      throw err;
    }
    if (REDIRECTS.has(res.status)) {
      try { await res.body?.cancel(); } catch { /* already gone */ }
      const location = res.headers.get('location');
      if (!location) throw new Error('redirect carried no Location header');
      if (hop >= 4) throw new Error('too many redirects');
      current = new URL(location, current); // the next hop gets the same checks
      continue;
    }
    if (!res.ok) throw new Error(`remote fetch failed with status ${res.status}`);
    // The announced size is refused before the body is read: a hostile URL
    // otherwise turns the bridge into a memory hose. The transport refuses it
    // too — this is the second line, for a transport that is not the pinned
    // one.
    const declared = Number(res.headers.get('content-length') || 0);
    if (Number.isFinite(declared) && declared > MAX_ATTACHMENT_BYTES) {
      try { await res.body?.cancel(); } catch { /* already gone */ }
      throw new Error(`attachment too large: ${declared} bytes over the ${MAX_ATTACHMENT_BYTES} byte limit`);
    }
    const contentType = (res.headers.get('content-type') || 'image/jpeg').split(';')[0].trim();
    if (!isAllowedAttachment(contentType, kind)) {
      throw new Error(`unsupported content-type: ${contentType}`);
    }
    const arrayBuffer = await res.arrayBuffer();
    if (res.truncated || arrayBuffer.byteLength > MAX_ATTACHMENT_BYTES) {
      throw new Error(`attachment too large: over ${MAX_ATTACHMENT_BYTES} bytes`);
    }
    const base64 = Buffer.from(arrayBuffer).toString('base64');
    return `data:${contentType};base64,${base64}`;
  }
}

// The mime type a data URI declares, or '' when it is not a data URI.
const dataUriType = (s) => (s.match(/^data:([^;,]+)/)?.[1] || '').toLowerCase();

// The bytes a data URI carries, once its Base64 is decoded. The cap is on
// the media, not on the envelope: Base64 inflates by a third, and the
// envelope is what the body limit already bounds.
const dataUriBytes = (s) => {
  const at = s.indexOf(',');
  if (at < 0) return 0;
  return Math.floor((s.length - at - 1) * 3 / 4);
};

// A filename the upstream file picker would have produced, so an attachment
// without one still arrives named rather than as `undefined`.
function defaultFilename(mediaType) {
  const ext = ({
    'application/pdf': 'pdf',
    'application/msword': 'doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.ms-excel': 'xls',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'application/vnd.ms-powerpoint': 'ppt',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
    'text/plain': 'txt',
    'text/markdown': 'md',
    'text/csv': 'csv',
    'application/json': 'json',
  })[mediaType] || (mediaType.split('/')[1] || 'bin').replace(/^jpeg$/, 'jpg');
  return `attachment.${ext}`;
}

// Extract multimodal parts (text and images) from OpenAI formatted messages
async function extractUserParts(messages) {
  const lastUser = (messages ?? []).filter((m) => m.role === 'user').at(-1);
  if (!lastUser) return { text: '', parts: [] };

  if (typeof lastUser.content === 'string') {
    const text = lastUser.content.trim();
    return {
      text,
      parts: text ? [{ type: 'text', text }] : []
    };
  }

  if (Array.isArray(lastUser.content)) {
    const parts = [];
    const textPieces = [];

    for (const item of lastUser.content) {
      if (!item || typeof item !== 'object') continue;

      if (item.type === 'text' && typeof item.text === 'string') {
        const t = item.text.trim();
        if (t) {
          textPieces.push(t);
          parts.push({ type: 'text', text: t });
        }
      } else if (item.type === 'image_url' || item.type === 'image') {
        const rawUrl = item.image_url?.url || item.url || item.image || item.data || null;
        if (typeof rawUrl === 'string' && rawUrl.trim()) {
          const urlStr = rawUrl.trim();
          let dataUri = '';
          if (urlStr.startsWith('data:image/')) {
            // The body limit bounds the envelope, not the media: a data: URI
            // under 32 MB can still carry 24 MB of picture, and the extension
            // uploads it to the account. The remote path caps the same thing
            // at MAX_ATTACHMENT_BYTES, so an inline picture is capped the same
            // way — otherwise the limit is only there for the polite callers.
            const bytes = dataUriBytes(urlStr);
            if (bytes > MAX_ATTACHMENT_BYTES) {
              log(`warning: refusing inline image over ${MAX_ATTACHMENT_BYTES} bytes (${bytes})`);
            } else {
              dataUri = urlStr;
            }
          } else if (/^https?:\/\//i.test(urlStr)) {
            try {
              dataUri = await fetchRemoteAsDataUri(urlStr, 'image');
            } catch (err) {
              log(`warning: failed to fetch remote image ${urlStr}: ${err.message}`);
            }
          }
          if (dataUri) {
            parts.push({
              type: 'image',
              image: dataUri
            });
          }
        }
      } else if (item.type === 'file') {
        // OpenAI's own shape is {type:'file', file:{filename, file_data}}; the
        // looser {url}/{data} spellings are accepted too. A remote URL goes
        // through the SSRF guard and arrives as a data URI, so the extension is
        // never asked to fetch it with the user's cookies.
        const raw = item.file?.file_data || item.file?.url || item.url || item.data || '';
        if (typeof raw === 'string' && raw.trim()) {
          const str = raw.trim();
          let dataUri = '';
          if (str.startsWith('data:')) {
            const declared = dataUriType(str);
            const bytes = dataUriBytes(str);
            if (!isAllowedAttachment(declared, 'file')) {
              log(`warning: refusing attachment of type ${declared || 'unknown'}`);
            } else if (bytes > MAX_ATTACHMENT_BYTES) {
              // Same cap as the remote path: an inline attachment is not a
              // smaller thing than a fetched one.
              log(`warning: refusing inline attachment over ${MAX_ATTACHMENT_BYTES} bytes (${bytes})`);
            } else {
              dataUri = str;
            }
          } else if (/^https?:\/\//i.test(str)) {
            try {
              dataUri = await fetchRemoteAsDataUri(str, 'file');
            } catch (err) {
              log(`warning: failed to fetch remote file ${str}: ${err.message}`);
            }
          }
          if (dataUri) {
            const mediaType = dataUriType(dataUri) || 'application/octet-stream';
            // An image sent as a file part is still an image to the model.
            if (mediaType.startsWith('image/')) {
              parts.push({ type: 'image', image: dataUri });
            } else {
              parts.push({
                type: 'file',
                mediaType,
                filename: item.file?.filename || item.filename || defaultFilename(mediaType),
                data: dataUri,
              });
            }
          }
        }
      }
    }

    // A message that is nothing but an attachment still needs text, or the
    // upstream composer treats it as empty. Name the file when there is one.
    //
    // The placeholder has to be a part and not only the text field: the
    // extension builds the upstream message from the parts and ignores the
    // text whenever there are parts, so a name that lived only in `text`
    // never reached the model at all.
    const named = parts.find((p) => p.type === 'file')?.filename;
    const spoken = textPieces.join('\n').trim();
    const placeholder = spoken ? '' : named ? `[${named}]` : parts.length ? '[Image]' : '';
    if (placeholder) parts.unshift({ type: 'text', text: placeholder });
    const text = spoken || placeholder;
    return {
      text,
      parts: parts.length ? parts : (text ? [{ type: 'text', text }] : [])
    };
  }

  return { text: '', parts: [] };
}

/* ------------------------------------------------------------ http plumbing */

// A body failure carries the status it is answered with, so every route says
// the same thing about the same mistake.
class BodyError extends Error {
  /** @param {string} message @param {number} status */
  constructor(message, status) {
    super(message);
    this.name = 'BodyError';
    this.status = status;
  }
}

/**
 * The body of a request, up to the limit.
 *
 * A body over the limit is a 413, not a reset: the old reader destroyed the
 * socket mid-body, so the client saw ECONNRESET and never learned why. The
 * refusal is raised instead, the answer is written, and the rest of the body
 * is discarded by Node — nothing of it is ever buffered.
 */
function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const parts = [];
    let refused = false;
    // The announced size is enough to refuse on: a body that says it is over
    // the limit is refused before a byte of it is read.
    const declared = Number(req.headers['content-length'] ?? 0);
    if (Number.isFinite(declared) && declared > limit) {
      refused = true;
      reject(new BodyError(`body too large: over ${limit} bytes`, 413));
      return;
    }
    req.on('data', (c) => {
      if (refused) return;
      size += c.length;
      if (size > limit) {
        refused = true;
        parts.length = 0;
        reject(new BodyError(`body too large: over ${limit} bytes`, 413));
        return;
      }
      parts.push(c);
    });
    req.on('end', () => { if (!refused) resolve(Buffer.concat(parts).toString('utf8')); });
    req.on('error', (err) => { if (!refused) reject(err); });
  });
}

/**
 * A JSON body, as an object.
 *
 * A body that parses to null is not a body: JSON.parse('null') is a legal
 * parse of a legal JSON document, but every route reads fields off the
 * result, and `null.model` is a TypeError — which the generic handler
 * answered with a 500. It is a client mistake, so it is a 400.
 */
async function readJson(req, limit = MAX_BODY) {
  const text = await readBody(req, limit);
  let value;
  try { value = JSON.parse(text || '{}'); }
  catch { throw new BodyError('invalid JSON body', 400); }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new BodyError('body must be a JSON object', 400);
  }
  return value;
}

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    ...corsHeaders(),
  });
  res.end(body);
}

const oaiError = (res, status, message, type = 'invalid_request_error') =>
  json(res, status, { error: { message, type } });

/* ---------------------------------------------------------- chat completions */

// The video options a request may carry, filtered to what the model will take.
// The app gates only `resolution` by model and sends the rest whenever they are
// set, so this does the same rather than inventing stricter rules of its own.
// What a model will take beyond a prompt. Computed when the response is built,
// never cached onto the model — the video loaders land after the model list, so
// a surface baked in at fetch time reports the fallback for the rest of the run.
function optionSurface(id) {
  if (kindOf(id) !== 'video') return null;
  const provider = videoProviderOf(id);
  const served = valuesFor(videoOptions.resolutions, provider);
  return {
    provider: provider ?? null,
    aspectRatio: true,
    stylePreprompt: true,
    duration: /^seedance/i.test(id),
    cameraFixed: /^seedance/i.test(id),
    generateAudio: /^seedance/i.test(id),
    resolutions: served.length ? served : (VIDEO_RESOLUTIONS_FALLBACK[provider] ?? null),
    durations: valuesFor(videoOptions.durations, provider),
    aspectRatios: valuesFor(videoOptions.aspectRatios, provider),
    images: VIDEO_IMAGE_LIMITS[id] ?? null,
  };
}

function videoOptionsFor(modelId, payload) {
  if (kindOf(modelId) !== 'video') return undefined;
  const bool = (v) => (typeof v === 'boolean' ? v : undefined);
  const provider = videoProviderOf(modelId);
  // The app attaches these four only for a seedance model; veo and sora take
  // the prompt, the aspect ratio and the style, and nothing else.
  const seedance = /^seedance/i.test(modelId);

  // What this provider is actually offered, straight from the loaders. Falling
  // back to the bundle's table only matters when no tab is attached to ask.
  const served = valuesFor(videoOptions.resolutions, provider);
  const allowed = served.length ? served : (VIDEO_RESOLUTIONS_FALLBACK[provider] ?? []);
  const durations = valuesFor(videoOptions.durations, provider);
  const ratios = valuesFor(videoOptions.aspectRatios, provider);

  const drop = (what, value, list) =>
    log(`warning: ${modelId} does not offer ${what} ${value}${list.length ? ` (${list.join(', ')})` : ''}`);

  const resolution = String(payload.resolution ?? '').trim();
  const okResolution = Boolean(resolution) && allowed.includes(resolution);
  if (resolution && !okResolution) drop('resolution', resolution, allowed);

  const duration = Number(payload.duration);
  // Durations are a served short list, not a free number. Sending one outside it
  // is accepted at submit and rejected later, once the quota is already spent.
  const okDuration = Number.isFinite(duration) && duration > 0
    && (!durations.length || durations.includes(duration));
  if (Number.isFinite(duration) && !okDuration) drop('duration', duration, durations);

  const ratio = String(payload.aspect_ratio ?? payload.aspectRatio ?? '').trim();
  const okRatio = Boolean(ratio) && (!ratios.length || ratios.includes(ratio));
  if (ratio && !okRatio) drop('aspect ratio', ratio, ratios);

  const style = payload.style_preprompt ?? payload.stylePreprompt;

  return {
    provider,
    ...(okRatio ? { aspectRatio: ratio } : {}),
    // A style is sent as its preprompt text, not as an id. A caller may name the
    // preset instead — "Documentary" — and it is resolved to that text here.
    ...(style ? { stylePreprompt: stylePreprompt(String(style)) } : {}),
    ...(seedance && okResolution ? { resolution } : {}),
    ...(seedance && okDuration ? { duration } : {}),
    ...(seedance && bool(payload.camera_fixed ?? payload.cameraFixed) !== undefined ? { cameraFixed: bool(payload.camera_fixed ?? payload.cameraFixed) } : {}),
    ...(seedance && bool(payload.generate_audio ?? payload.generateAudio) !== undefined ? { generateAudio: bool(payload.generate_audio ?? payload.generateAudio) } : {}),
  };
}

// Chat completions have no field for generated media, so it goes into the
// content as markdown — which every client already renders. An image gets an
// image tag; a video or a music clip gets a link, because an mp4 in an image
// tag is a broken image in every renderer there is.
const MEDIA_KINDS = new Set(['image', 'video', 'audio', 'file']);
function mediaMarkdown(kind, target, filename) {
  // A media frame with no payload is a broken frame, not a crash. Returning
  // nothing keeps the rest of the answer; throwing used to take the whole job
  // down with it, and the client then waited out the idle timeout for a reply
  // that was never coming.
  if (!target) return '';
  if (kind === 'image') return `\n![image](${target})\n`;
  // A video part carries its own filename; music does not. Failing that, the
  // signed storage URL's path holds the real extension before the query
  // (…/01a065ef.mp3?X-Goog-Signature=…), and a data URI declares it in the mime.
  if (filename) return `\n[${filename}](${target})\n`;
  const name = ['video', 'audio', 'file'].includes(kind) ? kind : 'file';
  const ext = (target.match(/^data:([^;,]+)/)?.[1]?.split('/')[1]
    ?? target.split('?')[0].match(/\.([a-z0-9]{2,4})$/i)?.[1] ?? '').replace(/[^a-z0-9]/gi, '');
  return `\n[${ext ? `${name}.${ext}` : name}](${target})\n`;
}

// Where a delta goes, as the fields of one frame. One function, so the
// streaming reply and the plain one cannot drift apart — they did:
// AIPASS_TOOL_VISIBILITY=text put the tool activity inline in one and in the
// reasoning field in the other, so the same request answered differently
// depending on how the client asked.
//
//   'status'  tool activity (web_search progress, sources). Follows
//             AIPASS_TOOL_VISIBILITY: 'reasoning' puts it in the reasoning
//             field, 'text' puts it inline in the answer, 'off' drops it.
//   'note'    a line for the person, not the answer and not tool churn — a
//             mid-reply model switch arrives this way. It rides its own
//             delta so the harness can show a transcript note, and keeps
//             the reasoning echo for clients that never learned the field
//             (the chat console reads reasoning), so nothing loses the line.
//             It never rides in the content: a client must not quote it
//             back as the answer.
function routeDelta(part) {
  if (part.kind === 'status') {
    if (TOOL_VISIBILITY === 'off') return null;
    if (TOOL_VISIBILITY === 'text') return { content: `\n${part.text}\n` };
    return { reasoning_content: `${part.text}\n` };
  }
  if (part.kind === 'note') {
    return { note: part.text, ...(TOOL_VISIBILITY !== 'off' ? { reasoning_content: `${part.text}\n` } : {}) };
  }
  if (MEDIA_KINDS.has(part.kind)) return { content: mediaMarkdown(part.kind, part.text, part.filename) };
  if (part.kind === 'reasoning') return { reasoning_content: part.text };
  return { content: part.text };
}

async function chatCompletions(req, res) {
  let payload;
  try { payload = await readJson(req); }
  catch (err) { return oaiError(res, err.status ?? 400, err.message); }

  const model = String(payload.model ?? defaultModel).replace(/^aipass\//, '');
  // Not an OpenAI field, so a client that knows about it can send either
  // spelling; otherwise the bridge default applies.
  const ratio = String(payload.aspect_ratio ?? payload.imageAspectRatio ?? aspectRatio).trim() || '1:1';
  // The levels are per model — most reasoning models take low | medium | high,
  // but Claude Opus also advertises `max` — so the model's own supportedLevels
  // decide. A level the model does not list is dropped rather than sent.
  const thinking = String(payload.thinking_level ?? payload.thinkingLevel ?? '').trim().toLowerCase();
  const thinkingLevel = thinking ? thinkingLevelFor(model, thinking) : undefined;
  const video = videoOptionsFor(model, payload);
  // temperature: an OpenAI client's field. Clamped to the OpenAI range 0..2;
  // a value that is not a number is dropped with a warning. null/absent/empty
  // means "leave it to the site's per-model default" — and null must not be
  // read as Number(null) = 0.
  const rawTemperature = payload.temperature;
  let temperature;
  if (rawTemperature !== undefined && rawTemperature !== null && rawTemperature !== '') {
    const t = Number(rawTemperature);
    if (Number.isFinite(t)) temperature = Math.min(2, Math.max(0, Math.round(t * 100) / 100));
    else log(`warning: temperature ${JSON.stringify(rawTemperature)} is not a number 0..2 — ignored`);
  }
  // OpenAI sampling fields the bridge cannot forward. Ignoring them silently
  // reads as "the setting had no effect" — say so, once per request, naming
  // them. `temperature` is handled above, so it is not on this list. A field
  // present but null is "not set", not a setting being dropped.
  const IGNORED_REQUEST_FIELDS = ['top_p', 'topP', 'top_k', 'topK', 'max_tokens', 'maxTokens', 'presence_penalty', 'frequency_penalty', 'seed', 'stop', 'logit_bias', 'logprobs', 'response_format', 'reasoning_effort', 'n'];
  const ignored = IGNORED_REQUEST_FIELDS.filter((k) => payload[k] !== undefined && payload[k] !== null);
  if (ignored.length) log(`warning: ignoring unsupported request field${ignored.length > 1 ? 's' : ''}: ${ignored.join(', ')}`);

  // An image style is sent by id; a tone and a format by their code. Each is
  // resolved from whatever the caller named — English, Thai, or the code — and
  // dropped with a warning when it matches no preset, rather than being passed
  // through as a string the server will not recognise.
  const preset = (rows, wanted, field, what) => {
    if (!wanted) return undefined;
    const hit = matchPreset(rows, wanted);
    if (!hit) { log(`warning: no ${what} called ${wanted}`); return undefined; }
    return hit[field];
  };
  const imageStyleId = kindOf(model) === 'image'
    ? preset(styleOptions.imageStyles, payload.image_style ?? payload.imageStyle, 'id', 'image style')
    : undefined;
  const outputTone = preset(styleOptions.tones, payload.output_tone ?? payload.outputTone, 'code', 'tone');
  const outputFormat = preset(styleOptions.formats, payload.output_format ?? payload.outputFormat, 'code', 'format');
  if (thinking && !thinkingLevel) log(`warning: ${model} does not offer thinking level ${thinking}`);
  const { text, parts } = await extractUserParts(payload.messages);
  if (!text && (!parts || parts.length === 0)) return oaiError(res, 400, 'no user message');

  // A client that manages its own conversations — the harness, its helpers, a
  // pool — names one per request here. Without it the bridge's current
  // conversation is used unless that pointer is a temporary conversation
  // someone else minted (resolveConversation skips those).
  const conversation = typeof payload.conversation === 'string' && payload.conversation.trim()
    ? payload.conversation.trim()
    : null;
  const conversationTemporary = conversation ? payload.temporary === true : null;

  const id = `chatcmpl-${randomUUID().replace(/-/g, '').slice(0, 24)}`;
  const created = Math.floor(Date.now() / 1000);
  const imageCount = (parts ?? []).filter(p => p.type === 'image').length;
  log(`chat -> ${model} (${Buffer.byteLength(text)} bytes text${imageCount ? `, ${imageCount} image(s)` : ''})`);

  // The client says it rewrites a message the edge refuses (the harness does:
  // it holds the chain that can fix one — drop the risky lines, shorten it,
  // halve it). The extension then hands the refusal back at once instead of
  // re-sending the same bytes, so the client's fix is the next request rather
  // than one a minute and a quarter away. A client that does not say so keeps
  // the extension's own ladder — it has no rewrite to offer.
  const rewriteOnRefusal = payload.rewrite_on_refusal === true || payload.rewriteOnRefusal === true;

  if (payload.stream) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      ...corsHeaders(),
    });
    // A video job can sit on one progress figure for minutes, and a stream that
    // sends nothing for five hits the default body timeout in Node's fetch —
    // undici's UND_ERR_BODY_TIMEOUT — killing a generation that was going to
    // succeed, with the quota already spent. An SSE comment is ignored by every
    // conforming parser and keeps the connection producing bytes.
    const keepalive = setInterval(() => { try { res.write(': keepalive\n\n'); } catch { /* closed */ } }, KEEPALIVE_MS);
    keepalive.unref?.();
    const stopKeepalive = () => clearInterval(keepalive);
    res.on('close', stopKeepalive);

    const emit = (delta, finish = null) => {
      res.write(`data: ${JSON.stringify({
        id, object: 'chat.completion.chunk', created, model,
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`);
    };
    emit({ role: 'assistant', content: '' });

    const job = startChat({
      modelId: model, text, parts, aspectRatio: ratio, thinkingLevel, temperature, video,
      imageStyleId, outputTone, outputFormat, rewriteOnRefusal,
      conversation, temporary: conversationTemporary,
      onDelta: (part) => {
        const frame = routeDelta(part);
        if (frame) emit(frame);
      },
      onDone: (finishReason) => {
        stopKeepalive();
        emit({}, finishReason === 'length' ? 'length' : 'stop');
        res.write('data: [DONE]\n\n');
        res.end();
      },
      onError: (message) => {
        stopKeepalive();
        res.write(`data: ${JSON.stringify({ error: { message, type: 'upstream_error' } })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      },
    });
    res.on('close', () => job.abort());
    return;
  }

  let out = '';
  let reasoning = '';
  await new Promise((resolve) => {
    const job = startChat({
      modelId: model, text, parts, aspectRatio: ratio, thinkingLevel, temperature, video,
      imageStyleId, outputTone, outputFormat, rewriteOnRefusal,
      conversation, temporary: conversationTemporary,
      onDelta: (p) => {
        const frame = routeDelta(p);
        if (!frame) return;
        if (frame.content !== undefined) out += frame.content;
        if (frame.reasoning_content !== undefined) reasoning += frame.reasoning_content;
      },
      onDone: (finishReason) => {
        json(res, 200, {
          id, object: 'chat.completion', created, model,
          choices: [{
            index: 0,
            message: { role: 'assistant', content: out, ...(reasoning ? { reasoning_content: reasoning } : {}) },
            finish_reason: finishReason === 'length' ? 'length' : 'stop',
          }],
          // Estimates: the upstream stream reports no token counts, but some
          // clients refuse a response without a usage block.
          usage: {
            prompt_tokens: Math.ceil(text.length / 4),
            completion_tokens: Math.ceil(out.length / 4),
            total_tokens: Math.ceil((text.length + out.length) / 4),
          },
        });
        resolve();
      },
      onError: (message) => { oaiError(res, 502, message, 'upstream_error'); resolve(); },
    });
    res.on('close', () => { job.abort(); resolve(); });
  });
}

/* -------------------------------------------------------- extension channel */

// The extension's SSE cycles every few minutes (background.js reconnects
// before Chrome's long-request ceiling), so connect/disconnect pairs arrive
// all day long. Log the transition 1→0 / 0→1 only — a cycle that keeps at
// least one tab attached is routine, not news.
let hadExtension = false;

function extEvents(req, res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    ...corsHeaders(),
  });
  const client = { id: randomUUID(), res };
  const wasEmpty = extClients.size === 0;
  extClients.add(client);
  // The extension is here and it got past the gate, so whatever token problem
  // the bridge recorded is over.
  extensionTokenMissing = false;
  if (wasEmpty && !hadExtension) {
    log(`extension connected (${extClients.size} total)`);
  }
  hadExtension = true;
  sendToClient(client, 'ready', { clientId: client.id, token: EXT_TOKEN });
  // A reconnecting service worker means in-flight jobs may still be running in
  // the page (their deltas arrive over plain POSTs, not this stream).
  // Re-adopt any job whose client went away, so a later abort reaches it and
  // a done post from the old generation is not answered with 'unknown job'.
  for (const job of jobs.values()) if (!job.client) job.client = client;
  // A stub is healed by retrying it, not by hoping the next reader asks: the
  // warm below is a one-shot and can land before the page is logged in. The
  // retry waits for that and keeps asking until a real catalog arrives.
  armModelRetry();
  // Warm the caches a moment after the tab attaches — but only if this client
  // is still the reason to: a tab that closed in the meantime would otherwise
  // send a loader job to whoever connected next. Once per process: the tab's
  // SSE cycles every few minutes, and four forced upstream fetches on every
  // cycle bought nothing the caches' own TTLs do not already cover.
  const warm = (fn, ms) => setTimeout(() => { if (extClients.has(client)) fn().catch(() => {}); }, ms);
  if (!warmLoaded) {
    warmLoaded = true;
    warm(() => listModels({ force: false }), 500);
    warm(() => getQuota({ force: false }), 900);
    warm(() => refreshVideoOptions(), 1300);
    warm(() => refreshStyleOptions(), 1700);
  }

  // A write to a socket the peer has dropped does not throw: it is accepted
  // into the buffer and reported later through the callback, or not at all. So
  // the ping is also the probe — a stream that is already destroyed, or a write
  // that comes back with an error, ends the client here instead of waiting for
  // a `close` that a half-open connection may never send. TCP keepalive is the
  // other half: it lets the kernel notice a peer that went away without a FIN,
  // which then surfaces as `close` on the socket.
  req.socket?.setKeepAlive?.(true, 15_000);
  const ping = setInterval(() => {
    if (res.destroyed || res.writableEnded) { cleanup(); return; }
    try { res.write(': ping\n\n', (err) => { if (err) cleanup(); }); } catch { cleanup(); }
  }, 15_000);
  // One cleanup, from every signal a dropped connection can give.
  //
  // The extension's stream cycles every few minutes, and a laptop that sleeps
  // or a proxy that resets the connection can leave the response half-open
  // without ever firing `req.on('close')`. The client then stays in
  // `extClients` for ever: the bridge believes an extension is attached, so it
  // dispatches jobs to a socket nobody reads, and those jobs sit until they
  // time out — a hang the person sees as "the app is stuck".
  //
  // So the cleanup is idempotent and runs on whichever comes first: the
  // request ending, the request aborting, the response erroring, the
  // response closing, or the socket going away.
  let closed = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(ping);
    extClients.delete(client);
    // The 1→0 edge only: a cycle leaves another tab attached, a real
    // disconnect empties the set. The /* … left) */ shape stays so log
    // scrapers keep matching.
    if (extClients.size === 0 && hadExtension) {
      log(`extension disconnected (${extClients.size} left)`);
      hadExtension = false;
    }
    // Do NOT fail in-flight chat jobs. The upstream fetch lives in the page and
    // survives the worker being evicted, which is exactly what happens during
    // a long web_search when no deltas flow to reset the worker's idle timer.
    // A loader job is different: it is only this bridge refreshing a cache, so
    // its only possible answer left with the page — fail it now instead of
    // stalling every refresh=1 caller behind the single-flight for its full
    // timeout (the next attachment re-warms the caches anyway).
    for (const job of jobs.values()) {
      if (job.client !== client) continue;
      job.client = null;
      if (job.kind === 'loader') job.fail('extension disconnected');
    }
  };
  req.on('close', cleanup);
  res.on('close', cleanup);
  res.on('error', cleanup);
  req.socket?.on('error', cleanup);
  req.socket?.on('close', cleanup);
}

async function extPost(req, res, kind) {
  let body;
  try { body = await readJson(req, MAX_EXT_BODY); }
  catch (err) { return json(res, err.status ?? 400, { ok: false, error: err.message }); }
  // `parts` is the payload of every delta: an object where an array belongs
  // is not a chunk the job can read, and iterating it would hand the model
  // whatever the keys happened to be. The shape is checked before the job is
  // looked up — a malformed body is malformed whoever it names.
  if (kind === 'chunk' && !Array.isArray(body.parts)) {
    return json(res, 400, { ok: false, reason: 'parts must be an array' });
  }
  const job = jobs.get(body.jobId);
  if (!job) return json(res, 200, { ok: false, reason: 'unknown job' });
  if (kind === 'chunk') {
    for (const part of body.parts) job.delta(part);
  }
  else if (kind === 'done') job.done(body.finishReason);
  else if (kind === 'loader') {
    if (typeof body.raw === 'string') job.done(body.raw);
    else job.fail(body.message ?? 'loader fetch failed');
  } else if (kind === 'assistant') {
    // One channel for three shapes: a created id, a bound conversation, or a
    // deletion. The caller knows which it asked for.
    if (body.conversationId) job.done(body.conversationId);
    else if (body.deleted) job.done('deleted');
    else if (body.assistantId) job.done(body.assistantId);
    else job.fail(body.message ?? 'assistant action failed');
  } else job.fail(body.message ?? 'extension reported an error');
  return json(res, 200, { ok: true });
}

/* ------------------------------------------------------- the bridge's own life */

// The bridge is a background process. The CLI starts it and walks away; the
// desktop backend starts it DETACHED, so it outlives whatever started it.
// Detached is right — a CLI that starts the bridge must not take it down when
// it exits — and it is also how one machine ended up with sixty bridges alive
// at once, each holding sixty megabytes, with nothing left that could stop
// any of them: the pid file is overwritten by the next bridge, and the
// scratch home the test suite used went with the suite.
//
// So the bridge ends itself. It is not idle while somebody is using it: the
// window asks for the credits every ten seconds, and the extension holds its
// event stream open on a four-minute cycle. A bridge nobody has touched for
// IDLE_EXIT_MS has no work left, and the memory it holds is better spent on
// the work that is.
//
// `AIPASS_BRIDGE_IDLE_MS=0` turns the timer off, for a bridge somebody wants
// to keep for ever.
const IDLE_EXIT_MS = Number(process.env.AIPASS_BRIDGE_IDLE_MS ?? 600_000);

// When the last request arrived, and when each in-flight request started.
// The oldest in-flight start is what decides "busy": a request that has been
// open longer than the idle window is a request that will never finish, and
// it must not keep the bridge alive on its own.
let lastActivity = Date.now();
const inFlight = new Set();

const markActivity = () => { lastActivity = Date.now(); };

/** The bridge is busy while a request it started recently is still open. */
const bridgeIsBusy = (now) => {
  for (const started of inFlight) {
    if (now - started < IDLE_EXIT_MS) return true;
  }
  return false;
};

// The pid file is how `aipass stop` — and the test suite's cleanup — find
// this process. The CLI that starts the bridge writes the pid it spawned; a
// bridge the desktop backend started has no such CLI, so the bridge records
// itself, when it binds, which is the moment it really IS the bridge on this
// port. A bridge that lost the race for the port never writes anything, so
// the file always names the one that is answering.
const recordPid = () => {
  try {
    recordBridgePid();
  } catch { /* the pid file is a convenience, not a contract */ }
};

const forgetPid = () => {
  try {
    forgetBridgePid();
  } catch { /* already gone */ }
};

if (IDLE_EXIT_MS > 0) {
  // The check runs often enough that the window means what it says: a window
  // of two seconds is honoured in two seconds, not in the next half minute.
  const checkEvery = Math.max(250, Math.min(30_000, Math.floor(IDLE_EXIT_MS / 4)));
  const idleCheck = setInterval(() => {
    const now = Date.now();
    if (bridgeIsBusy(now)) { markActivity(); return; }
    const idleFor = now - lastActivity;
    if (idleFor < IDLE_EXIT_MS) return;
    clearInterval(idleCheck);
    log(`idle for ${Math.round(idleFor / 1000)}s — nothing is using this bridge, so it is going away`);
    forgetPid();
    process.exit(0);
  }, checkEvery);
  // The timer is not a reason to stay alive; it only fires while the server
  // is holding the process open.
  idleCheck.unref?.();
}

/* --------------------------------------------------------------- the server */

const server = http.createServer(async (req, res) => {
  // Every request counts as the bridge being used. The idle timer is what
  // ends a bridge nobody is talking to, so the count has to include the
  // requests that are still open — a long generation holds the bridge busy
  // for as long as it lasts, and the request that started it is the proof.
  // The key is the request's own id, not a timestamp: two requests that start
  // in the same millisecond shared one key, and the first to close deleted it
  // while the second was still running — the bridge then looked idle with a
  // request in flight.
  const rid = requestId();
  markActivity();
  inFlight.add(rid);
  res.on('close', () => inFlight.delete(rid));
  // Every request gets a short id: it rides the response header and any error
  // line this request produces, so one quoted log line points back at the
  // exchange it came from.
  res.setHeader('x-aipass-rid', rid);
  // The Host check comes first and reads the raw header, because the URL
  // construction below it throws on a malformed one — an async handler that
  // throws before the try block is an unhandled rejection, and Node exits.
  if (!hostAllowed(req)) {
    res.writeHead(403, { 'content-type': 'text/plain' });
    return res.end('forbidden: unexpected Host header\n');
  }

  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  } catch {
    return oaiError(res, 400, 'malformed request URL');
  }
  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (req.method === 'OPTIONS') {
    // Without an explicit AIPASS_CORS_ORIGIN this preflight carries no
    // allow-origin, so a browser page cannot call the bridge cross-origin.
    res.writeHead(204, {
      ...corsHeaders(),
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': '*',
      'access-control-max-age': '86400',
    });
    return res.end();
  }

  // Loopback bearer gate: everything except the health probes needs the token
  // (minted once at ~/.aipass/.token, overridable with AIPASS_TOKEN).
  // Preflight above stays open — browsers never carry auth on OPTIONS.
  // Pairing endpoints are open: the extension has no loopback token yet, which
  // is the whole point of pairing. The code itself is the secret.
  const PAIR_OPEN = (path === '/pair/code' && req.method === 'GET') || (path === '/pair/claim' && req.method === 'POST');
  if (!(PAIR_OPEN || (req.method === 'GET' && (path === '/status' || path === '/health')))) {
    if (!authorized(req)) {
      if (path === '/ext/events') noteUnauthenticatedExtension();
      res.writeHead(401, { 'content-type': 'text/plain', ...corsHeaders() });
      return res.end('unauthorized: missing or wrong loopback bearer token\n');
    }
  }

  try {
    if (path === '/v1/chat/completions' && req.method === 'POST') return await chatCompletions(req, res);

    if (path === '/quota' || path === '/credits') {
      const quota = await getQuota({ force: url.searchParams.get('refresh') === '1' });
      if (!quota) return oaiError(res, 503, 'no credit figures yet — open a de.aipass.net tab', 'unavailable');
      return json(res, 200, quota);
    }

    if (path === '/v1/models') {
      const all = await listModels({ force: url.searchParams.get('refresh') === '1' });
      // ?kind=image (or a comma-separated set) narrows the list the way the web
      // UI's tabs do.
      const want = (url.searchParams.get('kind') ?? '').split(',').map((k) => k.trim()).filter(Boolean);
      const models = want.length ? all.filter((m) => want.includes(m.kind)) : all;
      return json(res, 200, {
        object: 'list',
        // 'live' once the site's catalog filled the cache, 'fallback' while
        // the two-id stub is all there is. A caller about to judge a saved
        // model against the catalog (the harness pre-flight) must see a real
        // one — the stub is not the catalog.
        source: catalogSource(),
        // The stamp of the last CHANGE and the last failure. A caller that
        // watches the stamp rebuilds only when the list really moved, and a
        // caller that hit a failure is told what it was instead of being
        // handed a stub with no explanation.
        at: modelState.at,
        error: modelState.error,
        data: models.map((m) => ({
          id: m.id, object: 'model', created: 0, owned_by: m.provider ?? 'aipass',
          name: m.name, free_credit: m.free, thinking: m.thinking,
          kind: m.kind, description: m.description, is_default: m.isDefault,
          // The surface is computed once: it reads the served video options,
          // and asking twice for every model in the list was asking twice.
          ...(() => { const o = optionSurface(m.id); return o ? { options: o } : {}; })(),
        })),
      });
    }

    if (path === '/conversations/new' && req.method === 'POST') {
      let body;
      try { body = await readJson(req); }
      catch (err) {
        return json(res, err.status ?? 400, {
          ok: false,
          error: err.status === 413 ? err.message : `bad JSON body: ${err.message}`,
        });
      }
      const adopt = body.adopt !== false;
      const temporary = body.temporary === true;
      try {
        const id = await createConversation({
          modelId: body.model, message: body.message, assistant: body.assistant,
          temporary, adopt,
        });
        return json(res, 200, { id, temporary });
      } catch (err) {
        // A create fails here when no extension is attached to carry it (and
        // when the upstream answer cannot be read). Both are conditions the
        // caller can see and act on — answer them as one clean JSON line
        // instead of an unhandled-rejection dump through the generic handler.
        log(`conversation create failed: ${err.message}`);
        return json(res, 503, { ok: false, error: err.message });
      }
    }
    if (path === '/conversations') {
      await loadConversations().catch(() => {});
      return json(res, 200, {
        current: PINNED_CONVERSATION || conversationCache,
        conversations: conversationList.map((c) => ({ id: c.id, title: c.title, updatedAt: c.updatedAt })),
      });
    }

    // The custom assistant that carries the agent's tool protocol. Listing is a
    // plain loader read; creating goes through the extension, which owns the
    // path and the intents it will post.
    if (path === '/assistants' && req.method === 'GET') {
      try {
        const decoded = decodeTurboStream(await fetchLoader(LOADERS.assistants));
        const found = [];
        const walk = (v) => {
          if (!v || typeof v !== 'object') return;
          if (Array.isArray(v)) return void v.forEach(walk);
          if (typeof v.id === 'string' && typeof (v.name ?? v.assistantName) === 'string') {
            found.push({ id: v.id, name: v.name ?? v.assistantName, model: v.model ?? v.modelId ?? null });
          }
          Object.values(v).forEach(walk);
        };
        walk(decoded);
        const seen = new Set();
        return json(res, 200, { assistants: found.filter((a) => !seen.has(a.id) && seen.add(a.id)) });
      } catch (err) {
        return oaiError(res, 502, `could not list assistants: ${err.message}`);
      }
    }

    if (path === '/assistants' && req.method === 'POST') {
      let body;
      try { body = await readJson(req); }
      catch (err) { return oaiError(res, err.status ?? 400, err.message); }
      const spec = {
        name: String(body.name ?? '').trim(),
        detail: String(body.detail ?? '').trim(),
        character: String(body.character ?? ''),
        type: String(body.type ?? '').trim(),
        model: String(body.model ?? '').trim(),
        tags: Array.isArray(body.tags) ? body.tags.map(String).filter(Boolean) : [],
      };
      // The form enforces these before it will submit, so failing here saves a
      // round trip and a half-made draft on the account.
      const tooLong = spec.name.length > 100 ? 'name over 100 characters'
        : spec.detail.length > 200 ? 'detail over 200 characters'
        : spec.character.length > 1000 ? 'character over 1000 characters'
        : '';
      const missing = ['name', 'detail', 'character', 'type', 'model'].find((k) => !spec[k]);
      if (missing) return oaiError(res, 400, `${missing} is required`);
      if (!spec.tags.length) return oaiError(res, 400, 'at least one tag is required');
      if (tooLong) return oaiError(res, 400, tooLong);

      try {
        const id = await new Promise((resolve, reject) => {
          const job = new Job({
            kind: 'assistant', spec, timeoutMs: 60_000,
            onDelta: () => {}, onDone: resolve, onError: (m) => reject(new Error(m)),
          });
          job.dispatch();
        });
        log(`created assistant ${id} (${spec.name})`);
        return json(res, 200, { id, name: spec.name });
      } catch (err) {
        return oaiError(res, 502, err.message);
      }
    }

    // Start a conversation already bound to an assistant, so nobody has to open
    // the web UI and copy an id out of the address bar.
    if (path.startsWith('/assistants/') && path.endsWith('/chat') && req.method === 'POST') {
      const assistantId = decodeURIComponent(path.slice('/assistants/'.length, -'/chat'.length));
      if (!assistantId) return oaiError(res, 400, 'assistant id is required');
      try {
        const conversationId = await new Promise((resolve, reject) => {
          const job = new Job({
            kind: 'assistant', spec: { op: 'start-chat', assistantId }, timeoutMs: 60_000,
            onDelta: () => {}, onDone: resolve, onError: (m) => reject(new Error(m)),
          });
          job.dispatch();
        });
        // Adopt it, the way /conversations/new does — the point of binding is
        // that the next message goes to it.
        conversationCache = conversationId;
        conversationIsTemporary = false;
        conversationIndex = 0;
        log(`assistant ${assistantId} -> conversation ${conversationId}`);
        return json(res, 200, { assistantId, conversation: conversationId });
      } catch (err) {
        return oaiError(res, 502, err.message);
      }
    }

    if (path.startsWith('/assistants/') && req.method === 'DELETE') {
      const assistantId = decodeURIComponent(path.slice('/assistants/'.length));
      if (!assistantId) return oaiError(res, 400, 'assistant id is required');
      try {
        await new Promise((resolve, reject) => {
          const job = new Job({
            kind: 'assistant', spec: { op: 'delete', assistantId }, timeoutMs: 60_000,
            onDelta: () => {}, onDone: resolve, onError: (m) => reject(new Error(m)),
          });
          job.dispatch();
        });
        log(`deleted assistant ${assistantId}`);
        return json(res, 200, { deleted: assistantId });
      } catch (err) {
        return oaiError(res, 502, err.message);
      }
    }

    if (path === '/style-options' && req.method === 'GET') {
      if (url.searchParams.get('refresh') === '1' || !styleOptions.at) await refreshStyleOptions();
      return json(res, 200, {
        imageStyles: styleOptions.imageStyles.map((v) => ({ id: v.id, name: v.name_en, nameTh: v.name_th })),
        tones: styleOptions.tones.map((v) => ({ code: v.code, name: v.nameEn, nameTh: v.nameTh })),
        formats: styleOptions.formats.map((v) => ({ code: v.code, name: v.nameEn, nameTh: v.nameTh })),
      });
    }

    if (path === '/video-options' && req.method === 'GET') {
      if (url.searchParams.get('refresh') === '1' || !videoOptions.at) await refreshVideoOptions();
      return json(res, 200, {
        styles: videoOptions.styles.map((v) => ({
          name: v.name_en, nameTh: v.name_th, preprompt: v.preprompt,
        })),
        byProvider: Object.fromEntries(VIDEO_PROVIDERS.map(([provider]) => [provider, {
          resolutions: valuesFor(videoOptions.resolutions, provider),
          durations: valuesFor(videoOptions.durations, provider),
          aspectRatios: valuesFor(videoOptions.aspectRatios, provider),
        }])),
      });
    }

    if (path === '/config' && req.method === 'POST') {
      let body;
      try { body = await readJson(req); }
      catch (err) { return oaiError(res, err.status ?? 400, err.message); }
      if (typeof body.defaultModel === 'string' && body.defaultModel.trim()) {
        defaultModel = body.defaultModel.trim();
        log(`default model ${defaultModel}`);
      }
      if (typeof body.assistant === 'string') { assistantId = body.assistant.trim(); log(assistantId ? `assistant ${assistantId}` : 'assistant cleared'); }
      if (typeof body.aspectRatio === 'string' && body.aspectRatio.trim()) {
        aspectRatio = body.aspectRatio.trim();
        log(`aspect ratio ${aspectRatio}`);
      }
      if (body.conversation === null || typeof body.conversation === 'string') {
        // Pinning an id says nothing about how it was created, so it is treated
        // as an ordinary conversation unless the caller declares otherwise.
        conversationCache = body.conversation || null;
        conversationIsTemporary = body.temporary === true;
        conversationIndex = 0;
        if (!conversationCache) conversationList = [];
        log(conversationCache ? `conversation ${conversationCache}` : 'conversation cleared');
      }
      return json(res, 200, { ok: true, defaultModel, assistant: assistantId || null, aspectRatio, conversation: PINNED_CONVERSATION || conversationCache, temporary: conversationIsTemporary });
    }

    // Container-management routes. Only the Docker deployment needs these, and
    // they can restart processes, so they stay off unless AIPASS_ADMIN=1.
    if (ADMIN) {
      if (path === '/restart' && req.method === 'POST') {
        json(res, 200, { ok: true, message: 'restarting bridge server' });
        setTimeout(() => process.exit(0), 50);
        return;
      }

      if (path === '/logs') {
        const fs = await import('node:fs');
        const target = url.searchParams.get('file') || 'bridge';
        // Whitelist the name: this is interpolated into a path, so anything
        // with a separator or dot would escape /var/log.
        if (!/^[a-z0-9_-]+$/i.test(target)) {
          return json(res, 400, { ok: false, error: 'invalid log name' });
        }
        const logFile = `/var/log/${target}.log`;
        try {
          const content = fs.readFileSync(logFile, 'utf8');
          return json(res, 200, { ok: true, file: logFile, lines: content.slice(-4000) });
        } catch (err) {
          return json(res, 500, { ok: false, error: err.message });
        }
      }

      if (path === '/browser/restart' && req.method === 'POST') {
        import('node:child_process').then(({ exec }) => {
          exec('pkill -f chromium || pkill -f chrome || true');
        });
        return json(res, 200, { ok: true, message: 'restarting browser' });
      }

      if (path === '/ext/reload' && req.method === 'POST') {
        for (const client of extClients) sendToClient(client, 'reload_extension', {});
        return json(res, 200, { ok: true, message: 'reloading extension' });
      }

      if (path === '/tab/reload' && req.method === 'POST') {
        for (const client of extClients) sendToClient(client, 'reload_tab', {});
        return json(res, 200, { ok: true, message: 'reloading tab' });
      }
    }

    if (path === '/ext/events' && req.method === 'GET') return extEvents(req, res);
    if (path.startsWith('/ext/') && req.method === 'POST') {
      // The extension carries the per-run token it was handed on connect;
      // anything else posting here is not the extension, however it learned
      // the jobId.
      if (req.headers['x-aipass-token'] !== EXT_TOKEN) {
        return json(res, 403, { ok: false, reason: 'bad token' });
      }
      const kind = path.slice('/ext/'.length);
      if (!['chunk', 'done', 'error', 'loader', 'assistant'].includes(kind)) {
        return json(res, 404, { ok: false, reason: 'unknown ext route' });
      }
      return await extPost(req, res, kind);
    }

    if (path === '/status' || path === '/health') {
      return json(res, 200, {
        ok: true,
        extensions: extClients.size,
        // Why the extension is not attached. 'missing' means it tried and the
        // bridge refused it for want of the loopback token; 'ok' means either
        // it is connected or it never tried. A reader that only saw
        // `extensions: 0` could not tell "load the extension" from "paste the
        // token", and those are different jobs.
        extensionToken: extensionTokenMissing ? 'missing' : 'ok',
        activeJobs: jobs.size,
        defaultModel,
        conversation: PINNED_CONVERSATION || conversationCache,
        temporary: conversationIsTemporary,
        assistant: assistantId || null,
        aspectRatio,
        models: cachedModels(),
        // What that list IS, said plainly — see modelState. The window reads
        // this on the status call it already makes every ten seconds, so it
        // learns that the catalog went live without asking for it.
        catalog: { ...modelState },
        credits: quotaCache.value,
        cache: cacheStats,
      });
    }

    // Pairing: the app asks for a short code, shows it, and puts it on the
    // clipboard; the extension claims it and gets the loopback token back.
    // Codes live in memory for five minutes and can be claimed once.
    if (path === '/pair/code' && req.method === 'GET') {
      const code = Math.random().toString(36).slice(2, 8).toUpperCase();
      pairCodes.set(code, { expires: Date.now() + 5 * 60 * 1000, claimed: false });
      return json(res, 200, { code, expiresAt: Date.now() + 5 * 60 * 1000 });
    }
    if (path === '/pair/claim' && req.method === 'POST') {
      const body = await readJson(req);
      const code = String(body?.code ?? '').trim().toUpperCase();
      const entry = pairCodes.get(code);
      if (!entry || entry.claimed || Date.now() > entry.expires) {
        return json(res, 400, { ok: false, reason: 'invalid or expired code' });
      }
      entry.claimed = true;
      pairCodes.delete(code);
      return json(res, 200, { ok: true, token: loadOrMintToken() });
    }

    return oaiError(res, 404, `no route for ${req.method} ${path}`, 'not_found');
  } catch (err) {
    log('unhandled', `[${rid}]`, err);
    if (!res.headersSent) oaiError(res, 500, String(err?.message ?? err), 'server_error');
    else res.end();
  }
});

let eaddrLoggedAt = 0;
server.on('error', (err) => {
  if (/** @type {any} */ (err).code === 'EADDRINUSE') {
    // A second starter is routine (desktop + CLI, two windows): the first
    // process keeps answering, so say that once a minute at most and leave
    // with code 0 — the supervisor's restart is what used to turn this into
    // a wall of red in bridge.log.
    const now = Date.now();
    if (now - eaddrLoggedAt > 60_000) {
      eaddrLoggedAt = now;
      console.error('port ' + PORT + ' is busy — a bridge is already answering there; leaving it alone');
      console.error('  (kill it first only if it should not be: pkill -f "bridge/server.mjs" — or check ~/.aipass/bridge.pid)');
    }
    process.exit(0);
  }
  throw err;
});

server.listen(PORT, HOST, () => {
  // The bridge that bound the port is the bridge on this port, so this is the
  // moment the pid file becomes true. A bridge that lost the race never gets
  // here, and never overwrites the pid of the one that won.
  recordPid();
  log(`aipass bridge on http://${HOST}:${PORT}`);
  log(`  default model : ${defaultModel}`);
  log(`  conversation  : ${PINNED_CONVERSATION || 'most recent on the account'}`);
  if (process.env.AIPASS_REQUIRE_AUTH === '0') {
    log('  WARNING: AIPASS_REQUIRE_AUTH=0 — loopback bearer token NOT required');
  } else {
    // Mint before the first request, so the token file exists by the time the
    // log line below tells the human where to copy it from.
    loadOrMintToken();
    log(`  auth token    : ${tokenPath()} (paste into the extension popup once)`);
  }
  log('  waiting for the Chrome extension…');
});

// Crash visibility, entry point only. A server-side throw that no handler
// caught used to end the process with at most a stray log line; the same death
// is now named, with the non-zero exit code a supervisor keys on. Not
// registered when this module is imported in-process — the test suite does
// exactly that — because one background throw would otherwise exit the runner.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const fatal = (label, err) => {
    log(`[fatal] ${label}:`, err?.stack ?? err);
    process.exit(1);
  };
  process.on('uncaughtException', (err) => fatal('uncaught exception', err));
  process.on('unhandledRejection', (reason) => fatal('unhandled rejection', reason));
}

// For tests: the SSRF guard's redirect behaviour cannot be driven through the
// HTTP surface without a public host, so it is exercised directly, and the
// imported server handle lets the test file release the port when it is done.
export { isPrivateHost, fetchRemoteAsDataUri, hostResolvesPrivate, server };
