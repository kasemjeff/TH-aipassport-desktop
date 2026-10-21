// @ts-check
// The links a web search brings back.
//
// A search answers with prose plus a `sources:` block — one line per link,
// `  - <label> <url>`. Two things are done to that block here:
//
//   - the URLs are read out of it, so the window can show them as links and
//     the model can quote them in its answer;
//   - the redirects are resolved. The search edge answers with opaque
//     redirect links (a long token on a search host) that only turn into an
//     article when they are opened, so a reader cannot tell where the link
//     points and cannot paste it anywhere. The reader wants the article's own
//     address: each redirect is followed once — under the same private-host
//     guard the FETCH tool uses — and the block is rewritten to the address
//     it points at.
//
// One module so the reader and the writer cannot drift: the block is parsed
// once and rewritten from that same parse.
import { inbound } from './waf.mjs';
import { isPrivateHost, hostResolvesPrivate } from '../bridge/private-hosts.mjs';

/** The block the edge prints, and the line shape it prints it in. */
const HEADER = /^\s*sources\s*:?\s*$/i;
const LINE = /^\s*[-*]\s+(.*)$/;
// The URL is the last thing on the line. The edge sends it in the wire
// spelling when the WAF is on (HTTPS-URL…), and a plain address when it is
// not — both are links, and both are read the same way.
const URL_AT_END = /((?:HTTPS-URL|HTTP-URL)\S*|https?:\/\/\S+)\s*$/;

/** How many links are resolved, and how long one may take. */
const MAX_LINKS = 10;
const TIMEOUT_MS = 5000;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/**
 * Is the host a literal address rather than a name?
 * @param {string} h
 */
const isLiteralIP = (h) => /^(\d{1,3}\.){3}\d{1,3}$/.test(h) || h.includes(':');

/**
 * A host the agent may talk to: not a private address, and not a name that
 * resolves to one. The same classifier the FETCH tool uses, so a link from
 * the open web cannot aim the backend at the machine it runs on.
 * @param {string} host
 */
async function publicHost(host) {
  if (isPrivateHost(host)) return false;
  if (!isLiteralIP(host) && await hostResolvesPrivate(host)) return false;
  return true;
}

/**
 * The host of a link, whatever spelling it carries.
 * @param {string} url
 */
function hostOf(url) {
  try { return new URL(inbound(String(url ?? '').trim())).hostname; } catch { return ''; }
}

/**
 * The sources a search printed, in the order it printed them. The URL keeps
 * the spelling the text carries — the wire spelling when the edge sent one.
 * @param {string} text
 * @returns {Array<{label: string, url: string}>}
 */
export function parseSources(text) {
  const out = [];
  let inBlock = false;
  for (const line of String(text ?? '').split('\n')) {
    if (!inBlock) {
      if (HEADER.test(line)) inBlock = true;
      continue;
    }
    const m = LINE.exec(line);
    // A blank line is not the end of the block; anything else is.
    if (!m) { if (line.trim()) break; continue; }
    const url = URL_AT_END.exec(m[1]);
    if (!url) continue;
    out.push({ label: m[1].slice(0, url.index).trim(), url: url[1] });
  }
  return out;
}

/**
 * The address a link points at: its redirect followed once, when it has one.
 *
 * A link that is already an address stays as it is (null), and a link that
 * cannot be followed safely — a private host, a timeout, a scheme that is
 * not http — is refused rather than guessed at. The answer is the address,
 * never a guess: the reader is about to click it.
 *
 * @param {string} url
 * @param {{fetchImpl?: typeof fetch, timeoutMs?: number, signal?: AbortSignal|null}} [opts]
 * @returns {Promise<string|null>}
 */
export async function resolveUrl(url, { fetchImpl = globalThis.fetch, timeoutMs = TIMEOUT_MS, signal = null } = {}) {
  const real = inbound(String(url ?? '').trim());
  if (!/^https?:\/\//i.test(real)) return null;
  let current;
  try { current = new URL(real); } catch { return null; }
  if (!(await publicHost(current.hostname))) return null;

  const timer = AbortSignal.timeout(timeoutMs);
  const both = signal ? AbortSignal.any([timer, signal]) : timer;
  const request = async (/** @type {string} */ method) => {
    try {
      return await fetchImpl(current, {
        redirect: 'manual',
        method,
        headers: { 'user-agent': 'aipass-agent/1.0' },
        signal: both,
      });
    } catch { return null; }
  };

  // HEAD is the cheap question ("where do you point?"). A few servers refuse
  // it, so the same question is asked again with GET before giving up.
  let res = await request('HEAD');
  if (res && (res.status === 405 || res.status === 501)) res = await request('GET');
  if (!res) return null;
  const status = res.status;
  const location = res.headers.get('location');
  try { await res.body?.cancel(); } catch { /* already gone */ }
  if (!REDIRECTS.has(status)) return null;   // no redirect: the link is the address
  if (!location) return null;
  let next;
  try { next = new URL(location, current); } catch { return null; }
  if (next.protocol !== 'http:' && next.protocol !== 'https:') return null;
  if (!(await publicHost(next.hostname))) return null;
  return next.href;
}

/**
 * The sources with their redirects followed: the article's own address where
 * there is one, the link as it came where there is not.
 * @param {Array<{label: string, url: string}>} sources
 * @param {{fetchImpl?: typeof fetch, timeoutMs?: number, signal?: AbortSignal|null}} [opts]
 */
export async function resolveSources(sources, opts = {}) {
  const list = (Array.isArray(sources) ? sources : []).slice(0, MAX_LINKS);
  return Promise.all(list.map(async (s) => {
    const to = await resolveUrl(s.url, opts);
    return to ? { label: s.label, url: to } : s;
  }));
}

/**
 * The text with the sources block rewritten to the given links. The block
 * keeps its shape — the label, then the address — so everything that reads
 * it (the terminal's renderer, the model's own quoting) still finds what it
 * found before.
 * @param {string} text
 * @param {Array<{label: string, url: string}>} sources
 */
export function rewriteSources(text, sources) {
  const list = Array.isArray(sources) ? sources : [];
  if (!list.length) return String(text ?? '');
  const lines = String(text ?? '').split('\n');
  let n = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!HEADER.test(lines[i])) continue;
    for (let j = i + 1; j < lines.length; j++) {
      const m = LINE.exec(lines[j]);
      if (!m) { if (lines[j].trim()) break; continue; }
      const s = list[n++];
      if (!s) break;
      lines[j] = `  - ${s.label || hostOf(s.url)} ${s.url}`;
    }
    break;
  }
  return lines.join('\n');
}

/**
 * A search result with the sources read out and their redirects followed —
 * the text the model is given, and the text the window shows, both carrying
 * the address a reader can click.
 * @param {string} text
 * @param {{fetchImpl?: typeof fetch, timeoutMs?: number, signal?: AbortSignal|null}} [opts]
 */
export async function withResolvedSources(text, opts = {}) {
  const sources = parseSources(text);
  if (!sources.length) return String(text ?? '');
  return rewriteSources(text, await resolveSources(sources, opts));
}
