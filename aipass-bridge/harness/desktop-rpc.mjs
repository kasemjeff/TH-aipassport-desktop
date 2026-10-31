// @ts-check
// desktop-rpc.mjs — the CLIs' client for a running desktop backend.
//
// The CLI edits the same files the desktop backend reads, but a backend that is
// already running will not notice a file edit — its plugin manager and MCP
// clients are in memory. So every mutating CLI command tries the backend
// first; when it answers, the open window is already showing the truth. The
// three outcomes mean three different things to the caller:
//
//   { ok: true,  result }  the backend did it — nothing left to do here
//   { ok: false, error }   the backend answered and refused — that refusal is
//                          the answer; falling back to a file edit would do
//                          the same thing behind its back
//   null                   nothing is listening — edit the files directly
import { authHeaders } from './authtoken.mjs';

/** Where the desktop backend listens, shared with desktop/main.mjs. */
export const desktopPort = () => Number(process.env.AIPASS_DESKTOP_PORT ?? 8790);

/** @param {any} method */
export async function tryDesktopRpc(method, params = {}, { port = desktopPort(), timeoutMs = 4000 } = {}) {
  let res;
  try {
    res = await fetch(`http://127.0.0.1:${port}/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return null; // connection refused, timeout — no backend
  }
  // Errors answer as 200 { ok: false }; any other shape on this port is not
  // this backend, and a file edit is still the honest fallback.
  if (!res.ok) return null;
  const body = /** @type {any} */ (await res.json().catch(() => null));
  if (body?.ok) return { ok: true, result: body.result };
  // `stage` is the step that failed, when the failure knows it — the CLI
  // reports it so a refusal names the door it closed.
  return { ok: false, error: String(body?.error ?? 'the backend refused the call'), stage: body?.stage ?? null };
}
