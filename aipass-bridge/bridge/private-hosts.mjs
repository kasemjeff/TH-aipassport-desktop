// @ts-check
// Which hostnames must a local agent refuse to fetch. One module so the
// bridge's attachment path and the harness's FETCH tool cannot drift — the
// guard is only as good as its weakest caller.
//
// True for the addresses of the IANA special-purpose registry: loopback,
// link-local, RFC1918, and the rest of the ranges a name on the internet can
// point at. The URL parser has already normalised integer, hex and octal
// spellings of an IPv4 address to dotted-quad by the time this sees the
// hostname, so those need no case of their own. A bare domain name is not
// classified here — that would need DNS resolution — so this blocks the
// literal-IP SSRF attempts, which is what a URL in a chat message looks like.
//
// The same module carries the connection that follows the verdict: the
// address that was checked is the address that is connected to, so a name
// that answers public for the check and private for the request has no
// window left to use.
import { lookup as dnsLookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import { urlToHttpOptions } from 'node:url';

/**
 * The private IPv4 ranges, by their first two octets.
 *
 * The list is the IANA special-purpose registry, not a summary of it: every
 * range here is one a name on the internet can point at, and one that
 * answers with something the caller did not mean to ask for.
 *
 * @param {number} a @param {number} b
 */
const privateV4 = (a, b) =>
  a === 0 || a === 127 || a === 10                     // this-host, loopback, private
  || (a === 169 && b === 254)                          // link-local incl. cloud metadata
  || (a === 192 && b === 168)
  || (a === 172 && b >= 16 && b <= 31)                 // 172.16.0.0/12
  || (a === 100 && b >= 64 && b <= 127)                // 100.64.0.0/10 CGNAT (RFC 6598) — also Tailscale's 100.x
  || (a === 192 && b === 0)                            // 192.0.0.0/24 IETF protocol assignments — 192.0.0.192 is Oracle Cloud's metadata
  || (a === 198 && (b === 18 || b === 19))             // 198.18.0.0/15 benchmarking (RFC 2544)
  || a >= 240;                                         // 240.0.0.0/4 reserved — 255.255.255.255 included

/** @param {string} host */
export function isPrivateHost(host) {
  let h = String(host).toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === '::' || h === '::1') return true;                 // unspecified / loopback
  if (/^fe[89ab][0-9a-f]:/.test(h)) return true;               // fe80::/10 link-local
  if (/^f[cd][0-9a-f]{2}:/.test(h)) return true;               // fc00::/7 unique-local
  // An IPv4 address carried inside an IPv6 one. The URL parser rewrites
  // ::ffff:127.0.0.1 into the hex form ::ffff:7f00:1, so both spellings have
  // to be unwrapped to the IPv4 address they carry — which a plain
  // dotted-quad match never sees. Three prefixes carry one:
  //   ::ffff:0:0/96  IPv4-mapped      (RFC 4291)
  //   ::/96          IPv4-compatible  (RFC 4291, deprecated but still routed)
  //   64:ff9b::/96  NAT64            (RFC 6052)
  // The last two are the ones that mattered here: the bridge skips the DNS
  // check for any host containing ':', so this classifier is the only gate
  // in front of them, and ::7f00:1 is 127.0.0.1 to every stack that answers
  // it.
  const embedded = h.startsWith('::ffff:') ? h.slice(7)
    : h.startsWith('64:ff9b::') ? h.slice('64:ff9b::'.length)
    : h.startsWith('::') ? h.slice(2)
    : '';
  if (embedded.includes('.')) return isPrivateHost(embedded);
  const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(embedded);
  if (hex) {
    // The last 32 bits are the IPv4 address: 7f00:1 is 127.0.0.1.
    const bits = (hex[1].padStart(4, '0') + hex[2].padStart(4, '0'));
    return privateV4(parseInt(bits.slice(0, 2), 16), parseInt(bits.slice(2, 4), 16));
  }
  if (/^[0-9a-f]{1,4}$/.test(embedded)) {
    // A single group: the upper half of that IPv4 address is zero, so this
    // is 0.0.x.y — the "this network" range, which is never a public answer.
    return privateV4(0, 0);
  }
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  return privateV4(Number(m[1]), Number(m[2]));
}

// A bare domain can resolve to a private address (DNS rebinding / split-horizon
// DNS) — the literal-IP check above cannot see it. Resolve and refuse when ANY
// answer is loopback / RFC1918 / link-local. Shared by the bridge attachment
// path and the harness FETCH tool so neither drifts.
//
// The question fails OPEN on a DNS failure (the literal check already ran,
// and a name that does not resolve cannot be fetched either); the CONNECTION
// fails closed, because there the answer has to be known before the socket
// opens. Failures are never cached.
//
// The TTL is SHORT on purpose, and that is the whole point of the change: a
// long verdict cache is what makes rebinding reliable, not harder. The
// attacker answers the check with a public address and the request with a
// private one, and a 60 s freeze on "public" guarantees that window is open.
// Five seconds shrinks it to something an attacker cannot plan around.
//
// The cache exists for the latency, not for the verdict: one run can fetch
// the same host on every hop of a redirect chain, and a resolver round trip
// per hop is pure latency.
//
// The cache holds the ADDRESSES, not only the verdict, because the
// connection is pinned to them (pinnedGet below): a cached verdict with a
// fresh lookup at request time would be the old hole back.
const DNS_TTL_MS = 5_000;

/**
 * @typedef {{ address: string, family: number }} VettedAddress
 * @typedef {{ addresses: VettedAddress[], private: boolean }} VettedHost
 */

/** @type {Map<string, { at: number } & VettedHost>} */
const dnsCache = new Map(); // host → { at, addresses, private }

/**
 * The addresses a name resolves to, and whether any of them is private.
 *
 * EVERY answer is vetted, not just the first: the connection picks one of
 * them and the attacker picks which, so a name that answers with both a
 * public and a private address is refused.
 *
 * The resolver is a parameter so the guard can be driven without a network —
 * the same trick `pinnedGet` plays for the request. A caller that brings its
 * own resolver gets no cache unless it asks for one: the cache is shared
 * state, and a test's stub must never be what the next caller reads.
 *
 * A failure is never cached. The throw happens before the entry is written,
 * so a name that could not be resolved a moment ago can be resolved now —
 * and a name that could be resolved must not stay private for the TTL.
 *
 * @param {string} host
 * @param {{ lookup?: (host: string, opts: { all: true }) => Promise<{ address: string, family: number }[]>, cache?: boolean }} [opts]
 * @returns {Promise<VettedHost>}
 */
export async function resolveVetted(host, { lookup = dnsLookup, cache = lookup === dnsLookup } = {}) {
  const key = String(host).toLowerCase();
  if (cache) {
    const hit = dnsCache.get(key);
    if (hit && Date.now() - hit.at < DNS_TTL_MS) return hit;
  }
  const answers = await lookup(key, { all: true });
  const addresses = (answers ?? []).map((a) => ({ address: a.address, family: a.family }));
  const entry = { at: Date.now(), addresses, private: addresses.some((a) => isPrivateHost(a.address)) };
  if (cache) dnsCache.set(key, entry);
  return entry;
}

/**
 * Does this name point at a private address?
 *
 * Fails OPEN on a DNS failure: the literal-IP check has already run, and a
 * name that does not resolve cannot be fetched either. The callers that
 * CONNECT use resolveVetted instead, which fails closed — there the answer
 * has to be known before the socket opens.
 *
 * @param {string} host
 * @returns {Promise<boolean>}
 */
export async function hostResolvesPrivate(host) {
  try {
    return (await resolveVetted(host)).private;
  } catch { return false; }
}

/**
 * A Response, with the two facts the transport adds to it.
 * @typedef {Response & { truncated: boolean, size: number }} PinnedResponse
 */

/**
 * A lookup that answers with the address that was vetted.
 *
 * Node's http/https client calls this instead of the resolver, so the socket
 * goes to the address the guard checked. The name is never resolved again —
 * that is the whole point: a name with a TTL of zero can answer public for
 * the check and private for the connection, and there is no second lookup
 * left to be fooled by.
 *
 * @param {VettedAddress[]} addresses
 * @returns {import('node:net').LookupFunction}
 */
const pinnedLookup = (addresses) => (hostname, options, callback) => {
  const family = options?.family === 'IPv4' ? 4 : options?.family === 'IPv6' ? 6 : options?.family;
  const usable = addresses.filter((a) => !family || a.family === family);
  if (!usable.length) {
    callback(new Error(`no vetted address for ${hostname}`), '', 0);
    return;
  }
  if (options?.all) callback(null, usable);
  else callback(null, usable[0].address, usable[0].family);
};

/**
 * The bytes of a stream, cut at the cap.
 *
 * @param {import('node:stream').Readable} stream
 * @param {number} cap
 * @param {boolean} rejectOnError a broken connection is an error; a body cut
 *   short is not
 * @returns {Promise<{ body: Buffer, truncated: boolean }>}
 */
function collect(stream, cap, rejectOnError) {
  return new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    const chunks = [];
    let size = 0;
    let truncated = false;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve({ body: Buffer.concat(chunks), truncated });
    };
    stream.on('data', (chunk) => {
      size += chunk.length;
      if (size > cap) {
        truncated = true;
        chunks.push(chunk.subarray(0, Math.max(0, cap - (size - chunk.length))));
        stream.destroy();
        return;
      }
      chunks.push(chunk);
    });
    stream.on('end', finish);
    stream.on('close', finish);
    stream.on('error', (err) => {
      if (done) return;
      if (rejectOnError && !truncated) { done = true; reject(err); return; }
      finish();
    });
  });
}

/**
 * The body of a response, decoded and cut at the cap.
 *
 * A server may answer compressed even when asked not to (`Accept-Encoding:
 * identity` is a request, not a promise), and the bytes of a gzip body are
 * not the bytes the caller should read. node:zlib is a builtin, so the body
 * is decoded here — the same thing fetch did on our behalf — and the decode
 * is capped too: a small compressed body can expand into something huge.
 *
 * @param {import('node:http').IncomingMessage} incoming
 * @param {number} cap
 * @returns {Promise<{ body: Buffer, truncated: boolean }>}
 */
async function readBody(incoming, cap) {
  const encoding = String(incoming.headers['content-encoding'] ?? '').toLowerCase().trim();
  const decoder = encoding === 'gzip' || encoding === 'x-gzip' ? zlib.createGunzip()
    : encoding === 'deflate' ? zlib.createInflate()
    : encoding === 'br' ? zlib.createBrotliDecompress()
    : null;
  if (!decoder) return collect(incoming, cap, true);
  decoder.on('error', () => { /* a body cut short: what decoded is what we have */ });
  decoder.on('close', () => { try { incoming.destroy(); } catch { /* already gone */ } });
  const out = collect(decoder, cap, false);
  incoming.on('error', () => { /* the decoder reports what it could */ });
  incoming.pipe(decoder);
  return out;
}

/**
 * A GET whose connection is pinned to an address that was already vetted.
 *
 * The hole this closes: the name is resolved for the check, and then the
 * HTTP client resolves it AGAIN for the connection. A name the attacker
 * controls, with a TTL of zero, can answer public for the first lookup and
 * private for the second — the request lands on 127.0.0.1 while the guard
 * saw a public address. Node's fetch cannot be told which address to
 * connect to, so this asks node:http/node:https for one, with a `lookup`
 * that hands back the vetted address.
 *
 * The answer is a Response, the shape fetch returns, so the callers keep the
 * code they had. Two extra properties ride on it: `truncated` (the body was
 * cut at the byte cap) and `size` (the bytes it holds).
 *
 * @param {URL|string} url
 * @param {{ addresses?: VettedAddress[]|null, headers?: Record<string, string>, timeoutMs?: number, signal?: AbortSignal|null, maxBytes?: number }} [opts]
 * @returns {Promise<PinnedResponse>}
 */
export async function pinnedGet(url, { addresses = null, headers = {}, timeoutMs = 15_000, signal = null, maxBytes = 2_000_000 } = {}) {
  const u = url instanceof URL ? url : new URL(String(url));
  const timer = AbortSignal.timeout(timeoutMs);
  const both = signal ? AbortSignal.any([timer, signal]) : timer;
  const options = {
    ...urlToHttpOptions(u),
    method: 'GET',
    headers: { 'accept-encoding': 'identity', accept: '*/*', ...headers },
    // A fresh agent per request: the shared agent pools sockets per
    // host:port, and a pooled socket is reused WITHOUT the lookup running
    // again — the request would go wherever the earlier one went, not to
    // the address that was vetted.
    agent: false,
    signal: both,
    ...(addresses?.length ? { lookup: pinnedLookup(addresses) } : {}),
  };
  try {
    return await new Promise((resolve, reject) => {
      /** @param {import('node:http').IncomingMessage} incoming */
      const onResponse = (incoming) => {
        const status = incoming.statusCode ?? 0;
        if (status < 200 || status > 599) {
          incoming.destroy();
          reject(new Error(`unexpected status ${status}`));
          return;
        }
        // The announced size is enough to refuse on. A server that says it is
        // sending 2 GB is refused before a byte of it is read, so a hostile
        // URL cannot turn the bridge into a memory hose — the streaming cap
        // below is the backstop for a body that lies about its size.
        const declared = Number(incoming.headers['content-length'] ?? 0);
        if (Number.isFinite(declared) && declared > maxBytes) {
          incoming.destroy();
          reject(Object.assign(
            new Error(`response too large: ${declared} bytes over the ${maxBytes} byte limit`),
            { code: 'BODY_TOO_LARGE' },
          ));
          return;
        }
        readBody(incoming, maxBytes).then(({ body, truncated }) => {
          /** @type {Record<string, string>} */
          const plain = {};
          for (const [k, v] of Object.entries(incoming.headers)) {
            if (v == null) continue;
            plain[k] = Array.isArray(v) ? v.join(', ') : v;
          }
          const res = /** @type {PinnedResponse} */ (new Response(
            [204, 205, 304].includes(status) ? null : body,
            { status, statusText: http.STATUS_CODES[status] ?? '', headers: plain },
          ));
          res.truncated = truncated;
          res.size = body.length;
          resolve(res);
        }, reject);
      };
      const req = u.protocol === 'https:'
        ? https.request(options, onResponse)
        : http.request(options, onResponse);
      req.on('error', reject);
      req.end();
    });
  } catch (err) {
    // A timeout or a stop arrives as an abort; say that, not "socket hang up".
    if (both.aborted) throw both.reason ?? err;
    throw err;
  }
}
