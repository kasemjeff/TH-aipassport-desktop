// The media surface of AiPASS: the image, video and music models of the live
// catalog, the presets the service publishes, and the generation itself.
//
// The bridge already speaks all of it — a media model is a chat job with
// options, and the answer carries the picture, the clip or the link to it.
// What was missing was the harness's half: a module that knows which model
// takes which option, drops the ones a model does not declare, and keeps what
// comes back.
//
// Three rules shape the code:
//
//   - the served values win over a table of our own. The bridge reads the
//     options from the site's own loaders, so a model that stops offering
//     720p stops offering it here — and a hardcoded list would keep sending
//     it, which the upstream refuses LATER, once the credits are gone;
//   - a generation waits for the MEDIA timeout, not the idle one. A render
//     sits quiet for minutes, and the idle timeout killed an image that had
//     already spent the credits;
//   - the bytes are kept locally. A signed storage link is short-lived and
//     public: the answer points at it, but the file the person wants is here.
import fs from 'node:fs';
import path from 'node:path';
import { BridgeClient, resolveBridgeURL } from './bridge.mjs';
import { outbound, inbound } from './waf.mjs';
import { scrubOutput } from './output-scrub.mjs';
import { aipassHome } from './settings.mjs';
import { isPrivateHost, resolveVetted, pinnedGet } from '../bridge/private-hosts.mjs';

/** The kinds of model that make media. The rest are chat models. */
const MEDIA_KINDS = ['image', 'video', 'music'];

/** The most a generated file may weigh. A clip is a few MB; this is the backstop. */
const MAX_MEDIA_BYTES = 64 * 1024 * 1024;

/** How long the download of a signed link may take. */
const DOWNLOAD_TIMEOUT_MS = 120_000;

/**
 * How long a generation may take before the harness gives up on it.
 *
 * The MEDIA timeout, not the idle one: the render happens upstream and the
 * answer arrives when it is ready, and a job that sits quiet for three
 * minutes has its credits spent and nothing to show for it. The bridge keeps
 * the same two clocks (AIPASS_MEDIA_TIMEOUT_MS, AIPASS_IDLE_TIMEOUT_MS), and
 * the media path takes the first.
 *
 * @param {string|number} [raw]
 * @returns {number}
 */
export function mediaTimeoutMs(raw = process.env.AIPASS_MEDIA_TIMEOUT_MS) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 900_000;
}

/** The client the media surface talks through: the local bridge, always. */
let shared = null;
/** @param {BridgeClient|null} [client] */
const clientFor = (client) => client ?? (shared ??= new BridgeClient(resolveBridgeURL()));

/**
 * The media models of the live catalog, grouped by kind.
 *
 * The catalog is the bridge's, and it says what kind every model is and — for
 * a video model — the options it accepts. An image model carries no options
 * surface of its own, so what it takes is read from the option loaders
 * instead: an aspect ratio, and one of the image styles the service serves.
 *
 * @param {BridgeClient|null} [client]
 */
export async function listModels(client = null) {
  const c = clientFor(client);
  const [catalog, styles] = await Promise.all([c.mediaModels(), c.styleOptions()]);
  return groupModels(catalog, styles?.imageStyles ?? []);
}

/**
 * The catalog's media models, grouped by kind.
 *
 * @param {any} catalog the bridge's `/v1/models` payload
 * @param {Array<{id: string}>} imageStyles the styles the service serves
 */
function groupModels(catalog, imageStyles) {
  /** @type {Record<string, any[]>} */
  const groups = { image: [], video: [], music: [] };
  for (const m of catalog?.data ?? []) {
    const kind = MEDIA_KINDS.includes(m.kind) ? m.kind : null;
    if (!kind) continue;
    groups[kind].push({
      id: m.id,
      name: m.name ?? m.id,
      kind,
      provider: m.owned_by ?? null,
      free: m.free_credit === true,
      options: surfaceOf(kind, m.options, imageStyles),
    });
  }
  return { source: catalog?.source ?? 'fallback', at: catalog?.at ?? 0, ...groups };
}

/**
 * The options one model takes.
 *
 * The video surface is the catalog's own — the bridge computes it from the
 * option loaders, so it is the service's answer and not ours. The image
 * surface is composed from the served image styles, because the catalog says
 * nothing about an image model beyond its kind. A music model takes the
 * prompt and nothing the service publishes.
 *
 * @param {string} kind
 * @param {any} options
 * @param {Array<{id: string}>} imageStyles
 */
function surfaceOf(kind, options, imageStyles) {
  if (kind === 'video') {
    const o = options ?? {};
    const resolutions = Array.isArray(o.resolutions) ? o.resolutions : [];
    return {
      provider: o.provider ?? null,
      aspectRatio: o.aspectRatio === true,
      aspectRatios: Array.isArray(o.aspectRatios) ? o.aspectRatios : [],
      stylePreprompt: o.stylePreprompt === true,
      duration: o.duration === true,
      durations: Array.isArray(o.durations) ? o.durations : [],
      // The catalog reports the resolutions a model is served, not a flag:
      // a provider that serves none has no resolution to send.
      resolution: resolutions.length > 0,
      resolutions,
      cameraFixed: o.cameraFixed === true,
      generateAudio: o.generateAudio === true,
      images: o.images ?? null,
    };
  }
  if (kind === 'image') {
    return {
      aspectRatio: true,
      aspectRatios: [],
      style: true,
      styles: imageStyles.map((s) => s.id),
    };
  }
  return {};
}

/**
 * Every preset the service publishes, in one read of each loader: the image
 * styles, the video styles, the tones and the formats.
 *
 * @param {BridgeClient|null} [client]
 */
export async function presets(client = null) {
  const c = clientFor(client);
  const [styles, video] = await Promise.all([c.styleOptions(), c.videoOptions()]);
  return {
    image: styles?.imageStyles ?? [],
    video: video?.styles ?? [],
    tones: styles?.tones ?? [],
    formats: styles?.formats ?? [],
  };
}

/**
 * The presets the service publishes.
 *
 * With a name, the one preset that name resolves to — the English name, the
 * Thai name, the code or the id, whichever the caller had to hand. The bridge
 * resolves a preset the same way (bridge/server.mjs, matchPreset), so a name
 * that works here works there.
 *
 * @param {BridgeClient|null} [client]
 * @param {string|null} [name]
 */
export async function listStyles(client = null, name = null) {
  const all = await presets(client);
  if (!name) return { image: all.image, video: all.video };
  return resolvePreset(all.image, name) ?? resolvePreset(all.video, name);
}

/**
 * The tone presets — the shape of the answer, not of a picture.
 *
 * @param {BridgeClient|null} [client]
 * @param {string|null} [name]
 */
export async function listTones(client = null, name = null) {
  const styles = await clientFor(client).styleOptions();
  const tones = styles?.tones ?? [];
  return name ? resolvePreset(tones, name) : tones;
}

/**
 * The format presets — the shape of the answer, not of a picture.
 *
 * @param {BridgeClient|null} [client]
 * @param {string|null} [name]
 */
export async function listFormats(client = null, name = null) {
  const styles = await clientFor(client).styleOptions();
  const formats = styles?.formats ?? [];
  return name ? resolvePreset(formats, name) : formats;
}

/**
 * Match a preset by its English name, its Thai name, its code or its id.
 *
 * @param {Array<any>} rows
 * @param {string} wanted
 */
export function resolvePreset(rows, wanted) {
  const want = String(wanted ?? '').trim().toLowerCase();
  if (!want) return null;
  return (rows ?? []).find((r) => (
    String(r.name ?? r.nameEn ?? '').trim().toLowerCase() === want
    || String(r.nameTh ?? r.name_th ?? '').trim() === String(wanted).trim()
    || String(r.code ?? '').trim().toLowerCase() === want
    || String(r.id ?? '').trim().toLowerCase() === want
  )) ?? null;
}

/**
 * The option surface: what one model accepts, or — with no model named — the
 * whole of it: the image styles, the video styles, what each video provider
 * is served, and the tone and format presets.
 *
 * @param {BridgeClient|null} [client]
 * @param {string|null} [model]
 */
export async function options(client = null, model = null) {
  const c = clientFor(client);
  if (model) {
    const found = findModel(await listModels(c), model);
    if (!found) throw new Error(`no media model called ${model}`);
    return { model: found.id, kind: found.kind, options: found.options };
  }
  const [styles, video] = await Promise.all([c.styleOptions(), c.videoOptions()]);
  return {
    image: { styles: styles?.imageStyles ?? [] },
    video: { styles: video?.styles ?? [], byProvider: video?.byProvider ?? {} },
    tones: styles?.tones ?? [],
    formats: styles?.formats ?? [],
  };
}

/**
 * One model of the grouped catalog.
 *
 * @param {{image: any[], video: any[], music: any[]}} catalog
 * @param {string} id
 */
function findModel(catalog, id) {
  const want = String(id ?? '').trim().toLowerCase();
  for (const kind of MEDIA_KINDS) {
    const hit = (catalog?.[kind] ?? []).find((m) => m.id.toLowerCase() === want);
    if (hit) return hit;
  }
  return null;
}

// The media an answer carries. A picture arrives as a markdown image — a data
// URI or a link — and a video or a music clip as a link, because an mp4 in an
// image tag is a broken image in every renderer there is (the bridge's
// mediaMarkdown builds them that way).
const MEDIA_LINK = /(!?)\[([^\]]*)\]\(([^)\s]+)\)/g;

// The extensions the generators hand back. A link is only chased when it
// looks like one of these: a citation in the prose is a link too, and
// fetching that would be both wrong and slow (chat.mjs reads them the same
// way).
const MEDIA_EXT = new Set([
  'mp4', 'webm', 'mov', 'mkv', 'mp3', 'wav', 'ogg', 'm4a', 'flac',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg',
]);

/** The extension of a label or of a path. */
function extOf(label, target) {
  const labelExt = String(label ?? '').split('.').pop()?.toLowerCase() ?? '';
  if (MEDIA_EXT.has(labelExt)) return labelExt;
  const pathExt = String(target ?? '').split('?')[0].split('.').pop()?.toLowerCase() ?? '';
  return MEDIA_EXT.has(pathExt) ? pathExt : '';
}

/** What kind of media a link carries. */
function kindOf(label, target) {
  const ext = extOf(label, target);
  if (ext === 'mp4' || ext === 'webm' || ext === 'mov' || ext === 'mkv') return 'video';
  if (ext === 'mp3' || ext === 'wav' || ext === 'ogg' || ext === 'm4a' || ext === 'flac') return 'audio';
  if (ext) return 'image';
  const word = String(label ?? '').trim().toLowerCase();
  if (word === 'video') return 'video';
  if (word === 'audio' || word === 'music') return 'audio';
  if (word === 'image') return 'image';
  return 'file';
}

/** The name a file should carry, when the answer names one. */
function filenameOf(label, target) {
  const text = String(label ?? '').trim();
  if (text && text.includes('.')) return text;
  const base = String(target ?? '').split('?')[0].split('/').pop() ?? '';
  return base.includes('.') ? base : '';
}

/**
 * The media an answer carries, and the prose around it.
 *
 * The two are separated BEFORE the answer is decoded: the WAF restore is a
 * text operation, and a megabyte of base64 spells "LCLHST" often enough to
 * corrupt a picture if it were decoded along with it.
 *
 * @param {string} text
 */
export function splitMedia(text) {
  const src = String(text ?? '');
  /** @type {any[]} */
  const frames = [];
  let prose = '';
  let last = 0;
  for (const m of src.matchAll(MEDIA_LINK)) {
    const [whole, bang, label, target] = m;
    if (!/^data:|^https?:\/\//i.test(target)) continue;
    const word = String(label ?? '').trim().toLowerCase();
    const isMedia = bang === '!'
      || ['video', 'audio', 'image', 'file'].includes(word)
      || Boolean(extOf(label, target));
    if (!isMedia) continue;   // a citation in the prose, not a result
    prose += src.slice(last, m.index);
    last = m.index + whole.length;
    frames.push({
      kind: bang ? 'image' : kindOf(label, target),
      label,
      url: target,
      filename: filenameOf(label, target),
    });
  }
  prose += src.slice(last);
  return { prose, frames };
}

/**
 * The payload of a media frame.
 *
 * A video carries no `url` at all — only a `snapshotUrl` beside its storage
 * key and its filename — and a frame can carry `url: ""` beside a real
 * `snapshotUrl`. Reading only `url` dropped every generated video on the
 * floor, so both are read here and the empty string falls through too
 * (extension/page.js reads it the same way).
 *
 * @param {any} frame
 */
export function mediaTarget(frame) {
  const d = frame?.data ?? {};
  return String(frame?.url || frame?.snapshotUrl || d.url || d.snapshotUrl || '');
}

/**
 * Run a media generation and keep what it produced.
 *
 * `out` is where the file goes; the default is the state home's media folder,
 * OUTSIDE the project, so a render can never end up in a repository by
 * accident (the same reason the sandbox projection lives outside the project).
 * A caller that names a path gets that path — a relative one is relative to
 * the project, the house's rule for every path the window hands over.
 *
 * The result says what was written, how big it is and which model made it —
 * and which options were dropped, because an option a model does not declare
 * is dropped BEFORE the request: the upstream takes one it will not use and
 * refuses it later, once the credits are gone.
 *
 * @param {object} args
 * @param {string|null} [args.model]
 * @param {string|null} [args.prompt]
 * @param {string|null} [args.ratio]
 * @param {string|null} [args.resolution]
 * @param {number|string|null} [args.duration]
 * @param {string|null} [args.style]
 * @param {boolean|null} [args.cameraFixed]
 * @param {boolean|null} [args.generateAudio]
 * @param {string|null} [args.tone]
 * @param {string|null} [args.format]
 * @param {string|null} [args.out]
 * @param {string|null} [args.root]
 * @param {BridgeClient|null} [args.client]
 * @param {AbortSignal|null} [args.signal]
 */
export async function generate({
  model = null,
  prompt = null,
  ratio = null,
  resolution = null,
  duration = null,
  style = null,
  cameraFixed = null,
  generateAudio = null,
  tone = null,
  format = null,
  out = null,
  root = null,
  client = null,
  signal = null,
} = {}) {
  const c = clientFor(client);
  const id = String(model ?? '').trim();
  if (!id) throw new Error('which model? — media.generate needs a model id');
  const ask = String(prompt ?? '').trim();
  if (!ask) throw new Error('what should it make? — media.generate needs a prompt');

  // One read of each: the catalog says what kind a model is, the loaders say
  // what it takes.
  const [catalog, styles, video] = await Promise.all([
    c.mediaModels(), c.styleOptions(), c.videoOptions(),
  ]);
  const entry = findModel(groupModels(catalog, styles?.imageStyles ?? []), id);
  if (!entry) throw new Error(`no media model called ${id} — media.models lists the ones the catalog has`);

  const { sent, dropped } = buildOptions(entry, {
    ratio, resolution, duration, style, cameraFixed, generateAudio,
  }, {
    image: styles?.imageStyles ?? [],
    video: video?.styles ?? [],
    tones: styles?.tones ?? [],
    formats: styles?.formats ?? [],
  });

  // Where the file lands is settled BEFORE the generation: a render that
  // cannot be written is a render nobody should pay for.
  const dir = mediaDir({ out, root });
  if (!out && root && inside(root, dir)) {
    throw new Error(`the media folder (${dir}) is inside the project — set AIPASS_HOME elsewhere, or name a path outside it`);
  }
  await fs.promises.mkdir(dir, { recursive: true });

  // The prompt goes out encoded and the answer comes back decoded, like
  // every other word this harness sends (harness/waf.mjs).
  let text;
  try {
    ({ text } = await c.chat({
      message: outbound(ask),
      model: id,
      options: sent,
      timeoutMs: mediaTimeoutMs(),
      signal,
    }));
  } catch (err) {
    // The bridge's own job clock ended the render. For an image model that
    // clock is the IDLE one — the bridge gives the media timeout to a video
    // and a music model only — and the credits are spent by then.
    if (/timed out waiting for the extension/i.test(String(err?.message ?? err))) {
      throw new Error('the render was killed by the bridge\'s idle timeout — the credits for it may already be spent');
    }
    throw err;
  }

  const { prose, frames } = splitMedia(text);
  if (!frames.length) {
    const said = inbound(prose).trim().slice(0, 200);
    throw new Error(`the answer carried no media${said ? ` — it said: ${said}` : ''}`);
  }

  /** @type {any[]} */
  const files = [];
  for (const frame of frames) {
    const payload = await payloadOf(frame);
    if (!payload) continue;
    files.push(await writeMedia(dir, payload, frame, entry));
  }
  if (!files.length) throw new Error('the media carried no bytes — nothing was written');

  return {
    ok: true,
    model: id,
    kind: entry.kind,
    path: files[0].path,
    bytes: files[0].bytes,
    mime: files[0].mime,
    files,
    dropped,
    text: scrubOutput(inbound(prose)).trim(),
  };
}

/**
 * The options the request carries, and the ones it does not.
 *
 * A model that does not declare an option does not get it: the upstream
 * accepts a value it will not use and refuses it once the generation has
 * already been paid for. The served values decide what is on the list, so a
 * model that stopped offering 720p stops being asked for it.
 */
function buildOptions(entry, asked, published) {
  const o = entry.options ?? {};
  /** @type {Record<string, any>} */
  const sent = {};
  /** @type {string[]} */
  const dropped = [];
  const drop = (what, value) => dropped.push(`${what}=${value}`);

  if (asked.ratio) {
    const ratios = o.aspectRatios ?? [];
    if (o.aspectRatio && (!ratios.length || ratios.includes(asked.ratio))) sent.aspectRatio = asked.ratio;
    else drop('ratio', asked.ratio);
  }
  if (asked.resolution) {
    const list = o.resolutions ?? [];
    if (o.resolution && (!list.length || list.includes(asked.resolution))) sent.resolution = asked.resolution;
    else drop('resolution', asked.resolution);
  }
  if (asked.duration !== null && asked.duration !== undefined && asked.duration !== '') {
    const d = Number(asked.duration);
    const list = o.durations ?? [];
    if (o.duration && Number.isFinite(d) && d > 0 && (!list.length || list.includes(d))) sent.duration = d;
    else drop('duration', asked.duration);
  }
  if (asked.style) {
    // A video style rides as its preprompt text; an image style by its id.
    if (o.stylePreprompt) {
      const hit = resolvePreset(published.video, asked.style);
      sent.stylePreprompt = hit?.preprompt ?? asked.style;
    } else if (o.style && o.styles?.length) {
      const hit = resolvePreset(published.image, asked.style);
      if (hit) sent.imageStyle = hit.id;
      else drop('style', asked.style);
    } else drop('style', asked.style);
  }
  if (asked.cameraFixed !== null && asked.cameraFixed !== undefined) {
    if (o.cameraFixed) sent.cameraFixed = asked.cameraFixed === true;
    else drop('cameraFixed', asked.cameraFixed);
  }
  if (asked.generateAudio !== null && asked.generateAudio !== undefined) {
    if (o.generateAudio) sent.generateAudio = asked.generateAudio === true;
    else drop('generateAudio', asked.generateAudio);
  }
  // A tone and a format shape the answer, not the picture, and they belong to
  // every model — but a name the service does not publish is still dropped.
  if (asked.tone) {
    const hit = resolvePreset(published.tones, asked.tone);
    if (hit) sent.tone = hit.code;
    else drop('tone', asked.tone);
  }
  if (asked.format) {
    const hit = resolvePreset(published.formats, asked.format);
    if (hit) sent.format = hit.code;
    else drop('format', asked.format);
  }
  return { sent, dropped };
}

/**
 * Where a generated file is written.
 *
 * @param {{out?: string|null, root?: string|null}} args
 */
export function mediaDir({ out = null, root = null } = {}) {
  if (out) {
    const typed = String(out).trim();
    return path.isAbsolute(typed) ? path.resolve(typed) : path.resolve(root ?? process.cwd(), typed);
  }
  return path.join(aipassHome(), 'media');
}

/** Is a path inside a root? */
function inside(root, target) {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * The bytes of one media item.
 *
 * A picture arrives as a data URI — the extension inlines small media — and
 * a video or a clip as a signed link. The link is short-lived and public: it
 * is fetched ONCE, here, and the bytes are kept locally, because a link that
 * expires in a few hours is not a file anybody can keep.
 */
async function payloadOf(frame) {
  const target = mediaTarget(frame);
  if (!target) return null;
  if (/^data:/i.test(target)) {
    const comma = target.indexOf(',');
    if (comma === -1) return null;
    const mime = target.slice(5, comma).split(';')[0] || 'application/octet-stream';
    return { bytes: Buffer.from(target.slice(comma + 1), 'base64'), mime };
  }
  return fetchMedia(target);
}

/**
 * The bytes behind a signed link.
 *
 * The same guard the FETCH tool uses: a link must not aim the backend at the
 * machine it runs on. AIPASS_FETCH_ALLOW_PRIVATE=1 lifts it, and costs the
 * download its innocence.
 */
async function fetchMedia(url) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error(`the media link is not a URL: ${url}`); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`the media link speaks ${parsed.protocol} — only http and https are fetched`);
  }
  let addresses = null;
  if (process.env.AIPASS_FETCH_ALLOW_PRIVATE !== '1') {
    const host = parsed.hostname;
    if (isPrivateHost(host)) {
      throw new Error(`refusing to fetch ${host} — private and internal addresses are blocked`);
    }
    const vetted = await resolveVetted(host);
    if (vetted.private) {
      throw new Error(`refusing to fetch ${host} — it resolves to a private/internal address`);
    }
    addresses = vetted.addresses;
  }
  const res = await pinnedGet(parsed, {
    addresses,
    timeoutMs: DOWNLOAD_TIMEOUT_MS,
    maxBytes: MAX_MEDIA_BYTES,
  });
  if (!res.ok) throw new Error(`the media link answered ${res.status}`);
  if (res.truncated) {
    throw new Error(`the media is over the ${Math.round(MAX_MEDIA_BYTES / 1024 / 1024)} MB cap — it was not written`);
  }
  const mime = (res.headers.get('content-type') || 'application/octet-stream').split(';')[0].trim();
  return { bytes: Buffer.from(await res.arrayBuffer()), mime };
}

/** How many files this process has written — the name has to be unique. */
let written = 0;

/**
 * Write one file, and say what was written.
 */
async function writeMedia(dir, payload, frame, entry) {
  const ext = extFor(payload.mime) || extOf(frame.label, frame.url) || 'bin';
  const file = path.join(dir, `aipass-${entry.kind}-${Date.now()}-${++written}.${ext}`);
  const bytes = screenPayload(payload.bytes, payload.mime);
  await fs.promises.writeFile(file, bytes);
  return { path: file, bytes: bytes.length, mime: payload.mime, kind: frame.kind };
}

/**
 * The house screen, applied to what is about to be written.
 *
 * A command's OUTPUT is screened before it reaches the transcript
 * (harness/output-scrub.mjs), and generated media is output too. A text
 * render — an SVG, a JSON, a caption — is screened as text; a binary picture
 * is not, because the shapes the screen looks for are text shapes and a
 * megabyte of PNG spells "token=" often enough to refuse half the pictures.
 */
function screenPayload(bytes, mime) {
  const type = String(mime ?? '').toLowerCase();
  const textual = type.startsWith('text/')
    || type === 'application/json'
    || type === 'application/xml'
    || type === 'image/svg+xml';
  if (!textual) return bytes;
  return Buffer.from(scrubOutput(bytes.toString('utf8')), 'utf8');
}

// The extensions for the media types the generators actually return, so a
// saved file opens by double-clicking it instead of needing a rename (the
// same table the terminal client uses).
const EXT = {
  jpeg: 'jpg', 'svg+xml': 'svg', mpeg: 'mp3', 'x-wav': 'wav', wave: 'wav',
  quicktime: 'mov', 'x-matroska': 'mkv',
};

/** @param {string} mime */
function extFor(mime) {
  const sub = (String(mime ?? '').split('/')[1] || 'bin').toLowerCase();
  return (/** @type {Record<string, string>} */ (EXT))[sub] ?? sub.replace(/[^a-z0-9]/g, '');
}
