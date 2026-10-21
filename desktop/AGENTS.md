# AGENTS.md — desktop

> Local law for the window. Root law: `../AGENTS.md`. Verify: `npm test`.

The window is this repository's own work — the product — and so is the
harness under `../aipass-bridge/harness/` that it drives. The bridge, the
extension and the CLI under `../aipass-bridge/` are upstream and continued
here: extend them when the window needs more, do not fork them.

## Shape

- `main.mjs` — the desktop shell (spawns or attaches to the bridge backend).
- `ui/` — the chat UI: plain ES modules, **no framework, no build step**.
  `ui/app.js` holds state, transcript and panels; `ui/markers.js` is the
  marker scanner/renderer; markup and CSS live beside them.
- `sidecar/` — the local Node copy for packaged builds
  (`npm run desktop:sidecar`). `src-tauri/` — Tauri config; packaged builds
  via `npm run desktop:build` (the install system is `docs/INSTALL.md`).
- `plugins-example/` — example plugin panels for the UI.
- The `*.md` and `*.html` files at this level are the human's working
  documents — leave them alone unless asked.

## UI laws

- **Markers are wire protocol, never text.** The bubble renders prose only;
  tool calls are rows; plugin markers go through `ui/markers.js`.
  Verify: "the bubble holds the prose, never the wire — calls live in their rows"
- **DONE is said once** — streamed prose and the harvested summary must not
  double.
  Verify: "a DONE is said once — streamed prose and the harvested summary never double"
- **Paints coalesce.** Use the paint queue (`queuePaint`), never re-render the
  reply synchronously per delta; in tests the frame clock is a 0 ms timeout.
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
- Reconnects are cheap by design: the backoff resets and the SSE replay fills
  the gap.
- Errors surface as banners with a one-click fix where one exists.
  Verify: "a run with no chat tab gets a banner with a one-click fix"
- Every palette command must map to a real handler.
  Verify: "every command in the palette has a handler that resolves"
- **A stop says what it stopped.** The window answers the stop at once — the
  button reads "stopping" while the run winds down — and a stop that found no
  run says so instead of pretending.
  Verify: "a stop is answered on screen — the window says the run is stopping"
- **The provider switch is machine-wide.** The picker's choice goes through
  the backend and lands in the settings file, so the terminal sees it too.
  Verify: "the provider picker offers every provider and switches the one in use"
- **The window names the project it is on.** Every call carries
  `x-aipass-project`, and the backend answers for THAT project — two windows
  on two projects must not read each other's state, and one window's Apply
  button must never write the other window's staged edits. The scope is a
  header, not a parameter: `root` in settings.set already means "switch the
  machine to this project".
  Verify: "two windows on two projects do not share state, and Apply writes only its own"
- **A file the human unticked stays unticked.** The pending panel is rebuilt
  on every diff frame; re-ticking what was unticked would write the files the
  human said no to.
  Verify: "a file the human unticked stays unticked when the panel is rebuilt"
- **The page is granted nothing it does not use.** The page never calls
  Tauri — the Rust side owns the window, the tray and the sidecar — so
  `withGlobalTauri` is off and `core:default` is not granted.
  Verify: "the shell grants the page no more than it uses"
- **The window is served under a policy.** The window is loaded FROM the
  backend, so the header the backend sends is the one that binds; the two
  policies are the same, key for key, and a test says so.
  Verify: "the window is served under a policy, not without one"
- **Every palette command does what it says.** A command that only points at
  another surface is a promise the window does not keep.
  Verify: "/symbols answers from the window, not from a run"
- **The sheet is a dialog, and a row owns its own keys.** The sheet takes
  the focus when it opens, keeps Tab inside itself, and gives the focus back
  when it closes; a key on a control inside a row is that control's own
  business, so the row may not swallow it.
  Verify: "the window says what it is to a screen reader"
  Verify: "the attach button is a button, and a key on it is its own business"

## Testing the UI

`ui.test.mjs` boots `app.js` against a fake DOM/fetch/EventSource and asserts
behavior. When you add a panel, command or transport change, extend the tests
— not the fake — and keep the assertions about what the user sees.
