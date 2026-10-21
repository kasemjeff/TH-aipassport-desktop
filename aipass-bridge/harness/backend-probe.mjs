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
import { pathToFileURL } from 'node:url';

/**
 * @param {number} port       the backend's port
 * @param {object} [options]
 * @param {object} [options.headers]  headers to send (the bearer token)
 * @param {number} [options.timeoutMs]
 * @returns {Promise<boolean>}  true when a backend is answering there
 */
/**
 * Is this the backend's own answer?
 *
 * A 200 on its own is not enough: something that is not our backend can hold
 * the port and answer 200 to anything, and a probe that believed every 200
 * would adopt it — and the window would then talk to a program that has
 * never heard of aipass. So the answer has to carry our shape: the status
 * the backend answers with, and not a stranger's "ok".
 *
 * @param {any} body the parsed body
 * @returns {boolean}
 */
function isOurStatus(body) {
  const result = body?.result;
  return body?.ok === true
    && !!result
    && typeof result === 'object'
    && typeof result.root === 'string'
    && typeof result.extensions === 'number';
}

export async function backendIsUp(port, { headers = {}, timeoutMs = 1200 } = {}) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ method: 'status' }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok) return isOurStatus(await res.json().catch(() => null));
    if (res.status !== 401) return false;
    const body = await res.json().catch(() => null);
    return String(body?.error ?? '') === UNAUTHORIZED;
  } catch {
    // Nothing is listening, or it never answered in time. Either way there is
    // no backend to adopt.
    return false;
  }
}

/**
 * Run standalone: `node backend-probe.mjs <port>`.
 *
 * The desktop shell has no HTTP client of its own — it is a window, a tray
 * and a supervisor — and it has to answer the same question the launcher
 * answers: is the thing on this port OUR backend, or something else? So it
 * asks the app's own Node, and this module is the one implementation of the
 * question: the shell cannot drift from the launcher, because it IS the
 * launcher.
 *
 * The answer is a word on stdout: `ours` or `other`. A failure to answer at
 * all is a non-zero exit, and the shell reads that as "could not say" rather
 * than as "not ours" — guessing either way would be worse than saying so.
 */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.argv[2]);
  if (!Number.isInteger(port) || port <= 0) {
    process.stderr.write('usage: node backend-probe.mjs <port>\n');
    process.exit(2);
  }
  const { authHeaders } = await import('./authtoken.mjs');
  const up = await backendIsUp(port, { headers: authHeaders() });
  process.stdout.write(up ? 'ours\n' : 'other\n');
}
