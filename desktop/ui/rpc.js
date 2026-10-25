// The window's client for the backend.
//
// Every call the window makes goes through here, so three things live in one
// place: the loopback token, the project header every call carries, and the
// shape of a refusal.
//
// The client is a factory, not a module-level object: the window's tests
// boot the page again and again, and a token that survived from the boot
// before would be the wrong token.

/**
 * The window's backend client.
 *
 * @param {object} ctx
 * @param {() => (string|null)} ctx.getRoot the project this window is showing
 */
export function createRpcClient(ctx) {
  // When the backend asks for one — AIPASS_REQUIRE_AUTH, the default — every
  // /rpc and /events call needs the loopback token. The window is a
  // same-origin page served by that same backend, so it asks /token for it
  // once at boot instead of anyone pasting a file; when auth is off the
  // endpoint refuses and the token stays null, which is exactly the
  // bare-request shape used before.
  let authToken = null;

  async function fetchToken() {
    try {
      const res = await fetch('/token');
      if (!res.ok) return null;
      const body = await res.json();
      return typeof body.token === 'string' && body.token ? body.token : null;
    } catch {
      return null;
    }
  }

  async function rpc(method, params = {}, signal) {
    // The project this window is showing rides on every call, as a header. The
    // backend holds one harness per project, and without this a second window
    // on another project would decide what this one reads — its sessions, its
    // file tree, its pending diffs — and its Apply button would write the
    // other project's staged edits. A header, not a parameter: the scope says
    // WHO is asking, and `root` already means "switch the machine to this
    // project" in settings.set.
    const send = () => fetch('/rpc', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // The token is read here, not above: a 401 below refreshes it, and the
        // retry has to carry the NEW one.
        ...(authToken ? { authorization: `Bearer ${authToken}` } : {}),
        ...(ctx.getRoot?.() ? { 'x-aipass-project': ctx.getRoot() } : {}),
      },
      body: JSON.stringify({ method, params }),
      // The caller owns the deadline when it passes one (the watchdog's probe
      // is the only one today); the retry below rides the same signal, so a
      // cancelled probe cannot sneak a second request past the abort.
      ...(signal ? { signal } : {}),
    });
    let res = await send();
    // A 401 on a token-less call means the boot fetch lost a race (or the
    // backend restarted between page load and now): fetch once more and retry,
    // but only when that actually changes what we would send.
    if (res.status === 401) {
      const fresh = await fetchToken();
      if (fresh && fresh !== authToken) { authToken = fresh; res = await send(); }
    }
    const body = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
    if (!body.ok) {
      // A failure that knows its step carries it, so the caller can say which
      // door closed instead of only that something did.
      const err = new Error(body.error ?? 'rpc failed');
      if (body.stage) err.stage = body.stage;
      throw err;
    }
    return body.result;
  }

  /**
   * The token this window holds, fetched once.
   *
   * The window asks the backend for the token once at boot and keeps it: the
   * extension's popup needs the very same token, and a second fetch would
   * answer with a different one.
   */
  async function ensureToken() {
    if (!authToken) authToken = await fetchToken();
    return authToken;
  }

  return {
    rpc,
    fetchToken,
    ensureToken,
    /** The token this window holds, or null when the backend minted none. */
    token: () => authToken,
  };
}

export default createRpcClient;
