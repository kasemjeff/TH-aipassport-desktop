// "Is a backend already answering on this port?"
//
// The launcher asks this before it starts one, and the answer decides whether
// the window opens against what is already running or a second backend dies on
// EADDRINUSE. The question is small; the ways to get it wrong are not:
//
//   - The backend's /rpc is behind the loopback token, so a token-less probe
//     gets a 401. A probe that only accepts 200 therefore never sees a
//     running backend at all, and the launcher starts a second one — which is
//     exactly the "port is busy, the app does not open" report this file
//     exists to prevent.
//   - Somebody else's server on the port is not our backend. Its 401 is not
//     ours either, and the "port is busy" message must still be able to say
//     so.
//
// So: 200 is ours, a 401 carrying the backend's own refusal is ours too (the
// token on disk differs from the one the running backend minted — it is still
// running), and anything else is not.
import { UNAUTHORIZED } from './authtoken.mjs';

/**
 * @param {number} port       the backend's port
 * @param {object} [options]
 * @param {object} [options.headers]  headers to send (the bearer token)
 * @param {number} [options.timeoutMs]
 * @returns {Promise<boolean>}  true when a backend is answering there
 */
export async function backendIsUp(port, { headers = {}, timeoutMs = 1200 } = {}) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ method: 'status' }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok) return true;
    if (res.status !== 401) return false;
    const body = await res.json().catch(() => null);
    return String(body?.error ?? '') === UNAUTHORIZED;
  } catch {
    // Nothing is listening, or it never answered in time. Either way there is
    // no backend to adopt.
    return false;
  }
}
