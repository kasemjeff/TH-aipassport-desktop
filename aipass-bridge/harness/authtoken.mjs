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

export const TOKEN_FILE = '.token';

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
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(home, 0o700); } catch { /* best effort on Windows */ }
  fs.writeFileSync(file, fresh + '\n', { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* best effort on Windows */ }
  return fresh;
}

/** Headers a loopback client attaches. Empty when auth is off — callers stay uniform.
 * @param {string} [home] @returns {Record<string, string>} */
export function authHeaders(home) {
  if (!authRequired()) return {};
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
