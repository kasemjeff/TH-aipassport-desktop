# AGENTS.md — desktop

> Local law for the window. Root law: `../AGENTS.md`. Verify: `npm test`.

## Shape

- `main.mjs` — the desktop shell (spawns or attaches to the bridge backend).
- `ui/` — the chat UI: plain ES modules, **no framework, no build step**.
  `ui/app.js` holds state, transcript and panels; `ui/markers.js` is the
  marker scanner/renderer; markup and CSS live beside them.
- `sidecar/` — the local Node copy for packaged builds
  (`npm run desktop:sidecar`). `src-tauri/` — Tauri config; packaged builds
  via `npm run tauri:build` (Windows NSIS by default).
- `plugins-example/` — example plugin panels for the UI.
- The `*.md` and `*.html` files at this level (research reports, landing-page
  experiments) are the human's working documents — leave them alone unless
  asked.

## UI laws

- **Markers are wire protocol, never text.** The bubble renders prose only;
  tool calls are rows; plugin markers go through `ui/markers.js`.
  Verify: "the bubble holds the prose, never the wire — calls live in their rows"
- **DONE is said once** — streamed prose and the harvested summary must not
  double.
  Verify: "a DONE is said once — streamed prose and the harvested summary never double"
- **Paints coalesce.** Use the paint queue (`queuePaint`), never re-render the
  reply synchronously per delta. In tests the frame clock is a 0 ms timeout;
  assert after `await tick()`.
- **A streaming paint appends to what settled; it never re-renders it.**
  Prose paints as settled blocks plus the open tail (`splitMarkdownStable` in
  `ui/md.js`); reasoning appends text nodes. The cost of a frame stays with
  the tail, not with how long the answer has already grown.
  Verify: "a long answer paints its settled paragraphs once and repaints only the tail"
  Verify: "reasoning arrives by appending text, not by rewriting the fold each frame"
- **Transport**: `fetchToken()` → `/token`; `EventSource(/events?token=…)`;
  `rpc()` → POST `/rpc` with `Authorization: Bearer`. Both transports must
  carry the token or a required-auth backend 403s every call.
  Verify: "the window carries the loopback token on both transports"
- Reconnects are cheap by design: backoff resets on success and the SSE
  replay (`since`) fills the gap.
- Errors surface as banners with a one-click fix where one exists (e.g. no
  chat tab open).
  Verify: "a run with no chat tab gets a banner with a one-click fix"
- Every palette command must map to a real handler.
  Verify: "every command in the palette has a handler that resolves"

## Testing the UI

`ui.test.mjs` boots `app.js` against a fake DOM/fetch/EventSource and asserts
behavior. When you add a panel, command or transport change, extend the tests
— not the fake — and keep the assertions about what the user sees.
