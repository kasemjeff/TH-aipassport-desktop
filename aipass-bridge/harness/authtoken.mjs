// @ts-check
// The loopback bearer token — one module so the bridge, the RPC backend, the
// CLIs, and the tests never disagree about where it lives or when it applies.
//
// Why a token when the ports already bind loopback: same-user loopback callers
// need no token (they can read this file anyway), but a token stops the rest —
// sandboxed apps with loopback egress and no filesystem access, other OS users
// when home-dir permissions are loose, and any browser page if CORS is ever
// enabled. File modes (0o700/0o600) are the same-user boundary; the token is
// the cross-boundary one. Both are enforced here, in one place.
//
//   AIPASS_TOKEN=...        explicit token (containers, tests); skips the file
//   AIPASS_REQUIRE_AUTH=0   escape hatch: loopback-only mode, no token needed.
//                           Logs a warning at every boot. For transition only.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { aipassHome } from './settings.mjs';
import { formatLogLine } from './log-line.mjs';

export const TOKEN_FILE = '.token';

/**
 * The refusal a token-less call gets.
 *
 * It is a constant because two places have to agree on it: the backend that
 * answers with it, and the launcher that reads it to tell "a backend is
 * already on this port" from "somebody else's server is on this port".
 */
export const UNAUTHORIZED = 'unauthorized: missing or wrong loopback bearer token';

/** @param {string} [home] @returns {string} */
export const tokenPath = (home = aipassHome()) => path.join(home, TOKEN_FILE);

/** False only under the explicit escape hatch — every other value requires auth. */
export const authRequired = () => process.env.AIPASS_REQUIRE_AUTH !== '0';

// authorized() runs on every /rpc call and on every SSE frame's auth check,
// and each one used to re-read the token file. The read is memoized and the
// memo revalidated from mtime+size: a rotated file is picked up on the next
// call, an unchanged one costs a stat.
/** @type {{ file: string|null, stamp: string, value: string|null }} */
let tokenCache = { file: null, stamp: '', value: null };

/** The active token: explicit env wins, otherwise the minted file (created once).
 * @param {string} [home] @returns {string} */
export function loadOrMintToken(home = aipassHome()) {
  const env = process.env.AIPASS_TOKEN?.trim();
  if (env) return env;
  const file = tokenPath(home);
  // A token that could not be written to disk is held in memory, and it is
  // the SAME token for every call: a new one on every call would lock the
  // window out of the backend it is talking to.
  if (tokenCache.file === file && tokenCache.stamp.startsWith('memory:') && tokenCache.value !== null) {
    return tokenCache.value;
  }
  try {
    const st = fs.statSync(file);
    const stamp = `${st.mtimeMs}:${st.size}`;
    if (tokenCache.file === file && tokenCache.stamp === stamp && tokenCache.value !== null) {
      return tokenCache.value;
    }
    const saved = fs.readFileSync(file, 'utf8').trim();
    if (saved) { tokenCache = { file, stamp, value: saved }; return saved; }
  } catch { /* first run — mint below */ }
  const fresh = crypto.randomBytes(32).toString('hex');
  // The file is written best effort. The mint happens inside a request
  // handler, and a throw there is an unhandled rejection — which ends this
  // backend for every window that is open. A home that cannot be written (a
  // read-only disk, a full one) must not be able to do that: the token still
  // works for this run, because the window reads it from the backend and not
  // from the file.
  let written = false;
  try {
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(home, 0o700); } catch { /* best effort on Windows */ }
    fs.writeFileSync(file, fresh + '\n', { mode: 0o600 });
    try { fs.chmodSync(file, 0o600); } catch { /* best effort on Windows */ }
    written = true;
  } catch (err) {
    console.error(formatLogLine({
      level: 'warn',
      msg: `the loopback token could not be written to ${file} (${err?.code ?? err?.message}) — it is held in memory for this run`,
    }));
  }
  // Cache the token just written, from the recreated file's own stat. Without
  // this the stale pre-delete entry survives with its old mtime:size stamp,
  // and a recreate landing in the same tick (Windows' clock) reports that
  // exact stamp — the next check would then answer "no" to the very token the
  // file now holds (the 2026-10-17 auth flake).
  if (written) {
    try {
      const st = fs.statSync(file);
      tokenCache = { file, stamp: `${st.mtimeMs}:${st.size}`, value: fresh };
    } catch { tokenCache = { file: null, stamp: '', value: null }; }
  } else {
    tokenCache = { file, stamp: `memory:${fresh}`, value: fresh };
  }
  return fresh;
}

/** Headers a loopback client attaches. Empty when auth is off — callers stay uniform.
 * @param {string} [home] @returns {Record<string, string>} */
export function authHeaders(home) {
  if (!authRequired()) return {};
  return { authorization: `Bearer ${loadOrMintToken(home)}` };
}

/**
 * Is this URL the loopback the token belongs to?
 *
 * The token is a cross-boundary credential: it is what stops another OS user,
 * a sandboxed app with loopback egress, and a browser page from driving the
 * account. Attaching it to a host that is not loopback hands all of that
 * away, so the clients attach it to loopback and to nothing else.
 *
 * The old check was "does the URL start with the bridge URL" — and every call
 * site built its URL as `${BRIDGE}${path}`, so the check was true by
 * construction and `--bridge https://collector.example` shipped the token to
 * that host. The question is about the HOST, not about a string prefix.
 *
 * @param {string} url @returns {boolean} */
export function isLoopbackUrl(url) {
  let host;
  try {
    host = new URL(String(url)).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (!host) return false;
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  return host === 'localhost'
    || host === '::1'
    || /^127(\.\d{1,3}){3}$/.test(host);
}

/**
 * The headers a request to `url` carries: the bearer token on loopback, and
 * nothing anywhere else.
 *
 * The bridge gates every route but its health probes, so a client that talks
 * to it presents the token it minted — chat.mjs and doctor.mjs have always
 * done this, and the harness's own bridge client did not, so every run the
 * window started was refused with a 401 that the window blamed on the
 * extension. One spelling of the rule, so the next client cannot forget it
 * again.
 *
 * The test is about the HOST, not a string prefix: a prefix would be true by
 * construction and would ship the token to a remote bridge.
 *
 * @param {string} url @param {string} [home] @returns {Record<string, string>} */
export function authHeadersFor(url, home) {
  if (!authRequired()) return {};
  if (!isLoopbackUrl(url)) return {};
  return { authorization: `Bearer ${loadOrMintToken(home)}` };
}

/** Constant-time bearer check against the active token.
 * @param {import('node:http').IncomingMessage} req @param {string} [home] */
export function authorized(req, home) {
  if (!authRequired()) return true;
  const header = String(req.headers.authorization ?? '');
  const m = /^Bearer (.+)$/.exec(header);
  if (!m) return false;
  const want = Buffer.from(loadOrMintToken(home));
  const got = Buffer.from(m[1].trim());
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

/** Query-string variant for transports that cannot set headers (EventSource).
 * @param {URL} url @param {string} [home] */
export function authorizedQuery(url, home) {
  if (!authRequired()) return true;
  const token = url.searchParams.get('token') ?? '';
  if (!token) return false;
  const want = Buffer.from(loadOrMintToken(home));
  const got = Buffer.from(String(token).trim());
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}
