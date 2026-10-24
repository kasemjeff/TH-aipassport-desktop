# AGENTS.md — desktop

> Local law for the window. Root law: `../AGENTS.md`. Verify: `npm test`.

The window is this repository's own work — the product — and so is the harness
under `../aipass-bridge/harness/` it drives. The bridge, extension and CLI under
`../aipass-bridge/` are upstream: extend them, do not fork them.

## Shape

- `main.mjs` — the entry point; the launcher's rules live in `../aipass-bridge/harness/launcher.mjs` (testable: an entry script runs its top level on import).
- `ui/` — the chat UI: plain ES modules, **no framework, no build step**. `ui/app.js` is the entry; `ui/state.js`, `ui/rpc.js`, `ui/transcript.js`, `ui/settings.js`, `ui/commands.js` and `ui/panels/` are modules of their own.
- `sidecar/` — the local Node copy for packaged builds (`npm run desktop:sidecar`); `src-tauri/` — Tauri config (`npm run desktop:build`).
- `plugins-example/` — example plugin panels; the `*.md` and `*.html` at this level are the human's working documents.

## UI laws

- **Markers are wire protocol, never text.** The bubble renders prose only;
  tool calls are rows; plugin markers go through `ui/markers.js`.
  Verify: "the bubble holds the prose, never the wire — calls live in their rows"
- **DONE is said once** — streamed prose and the harvested summary must not double.
  Verify: "a DONE is said once — streamed prose and the harvested summary never double"
- **Paints coalesce and append.** Use the paint queue (`queuePaint`), never
  re-render the reply synchronously per delta; a paint appends to what settled.
  Verify: "a long answer paints its settled paragraphs once and repaints only the tail"
  Verify: "reasoning arrives by appending text, not by rewriting the fold each frame"
- **Transport**: `fetchToken()` → `/token`; `EventSource(/events?token=…)`);
  `rpc()` → POST `/rpc` with `Authorization: Bearer` — both carry the token.
  Verify: "the window carries the loopback token on both transports"
  Verify: "the window hands the extension its token, in one click"
- Reconnects are cheap: the backoff resets and the SSE replay fills the gap.
- Errors surface as banners with a one-click fix where one exists.
  Verify: "a run with no chat tab gets a banner with a one-click fix"
- **Every palette command does what it says** — a command that only points at
  another surface is a promise the window does not keep.
  Verify: "every command in the palette has a handler that resolves"
  Verify: "/symbols answers from the window, not from a run"
- **A stop says what it stopped.** The window answers the stop at once, and a
  stop that found no run says so instead of pretending.
  Verify: "a stop is answered on screen — the window says the run is stopping"
- **The provider switch is machine-wide**: the picker's choice lands in the settings file, so the terminal sees it too.
  Verify: "the provider picker offers every provider and switches the one in use"
- **The window names the project it is on.** Every call carries `x-aipass-project`: two windows on two projects must not read each other's state.
  Verify: "two windows on two projects do not share state, and Apply writes only its own"
- **A file the human unticked stays unticked.** The pending panel is rebuilt on every diff frame; re-ticking it would write what the human said no to.
  Verify: "a file the human unticked stays unticked when the panel is rebuilt"
- **The page is granted nothing it does not use.** The page never calls Tauri — the Rust side owns the window, the tray and the sidecar, so `withGlobalTauri` is off.
  Verify: "the shell grants the page no more than it uses"
- **The window is served under a policy.** It is loaded FROM the backend, so the
  header the backend sends binds; the two policies are the same, key for key.
  Verify: "the window is served under a policy, not without one"
- **The window hears the end of a run once.** The attempts are one run from the
  window's point of view: a frame after every attempt put its working bar down
  while the next attempt was still going.
  Verify: "the window hears the end of a run once, after the last attempt"
- **The sheet is a dialog, and a row owns its own keys.** The sheet takes the
  focus when it opens and gives it back when it closes.
  Verify: "the window says what it is to a screen reader"
  Verify: "the attach button is a button, and a key on it is its own business"
- **Every control is named, and the window says its state.** An icon button and
  a select each carry an aria-label — a title is a tooltip, not a name.
  Verify: "every control in the window carries a name a screen reader can read"
  Verify: "the transcript holds its announcements while a run streams, and releases them when it ends"
- **The window shows what it has, and what it dropped.** The transcript is
  bounded: the oldest rows go and a line says how many (the session file still
  holds everything). The help reads the palette, so a command that exists is named.
  Verify: "the transcript drops its oldest rows and says how many"
  Verify: "the help lists every command the palette has"
- **The update notice is a banner, and the click is the consent.** It never
  interrupts a run, never applies anything on its own, and it names the version it found.
  Verify: "an update is never applied while a run is in flight"
- **A busy port is named, not looped on.** The backend says "the port was taken";
  the supervisor adopts ours and names a stranger's.
  Verify: "a busy port is a named condition, not a crash"
  Verify: "the shell and the launcher ask the port the same question"
- **The model list says what it is.** A window that cannot reach a tab sees a
  two-model stub: the window names that list and never loses it to a failed refresh.
  Verify: "a fallback list says why it is a fallback"
  Verify: "a failed model refresh keeps the list it already had"
  Verify: "a refresh keeps the choice the reader had made"
- **The window says it is working, and a reload brings the conversation back.** The bar over the transcript carries a clock while a run is alive, and it goes down when the run ends; a reloaded window comes back with its conversation, not the welcome card.
  Verify: "the window says it is working while a run is in flight"
  Verify: "a reloaded window comes back with its conversation, not the welcome card"

## Testing the UI

`ui.test.mjs` boots `app.js` against a fake DOM/fetch/EventSource and asserts behavior. Extend the tests — not the fake — and keep the assertions about what the user sees.
