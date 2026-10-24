# aipass — the VS Code extension

A panel in VS Code that drives the **local AiPASS agent**: send a task, watch
the run, answer the permission and plan questions, see the staged changes,
stop it, and watch the credit meter.

It is one surface of the harness. The desktop window is another, and
`aipass agent "task"` is a third. All three drive the same agent core.

## Why it does NOT talk to the bridge

The upstream bridge serves an OpenAI-compatible endpoint on
`http://127.0.0.1:8787/v1`, and **that endpoint cannot serve an IDE client**.
The service takes ONE user message and owns the conversation server-side, and
an agent-style system prompt is refused with a 403 by the edge's WAF. A tool
like Cline or Cursor pointed at the bridge answers as if it had no abilities
at all — *"I can't access your files"* — not because the bridge is broken, but
because the endpoint declines the shape those tools require.

So this extension talks to the **local harness backend** instead:
`aipass-bridge/harness/rpc.mjs`, which serves

- `POST /rpc` — JSON-RPC, and
- `GET /events` — an SSE stream,

both on `127.0.0.1:8790` by default, behind the loopback bearer token in
`~/.aipass/.token`. The harness already sends the marker protocol as *user
messages*, so it lives inside the edge's constraint. That is the whole trick.

The exact contract is written down in [`protocol.md`](./protocol.md).

## What it needs

- **The desktop backend running.** The extension is a client, not a server:
  it never starts the agent itself.
  - `aipass desktop` — the installed command, or
  - `npm run desktop` — from a checkout of this repository.
- **The AiPASS Chrome extension attached** and a **logged-in
  `de.aipass.net/chat` tab open** — that is what the harness itself talks to.
  The extension cannot fix that for you; it says so when a run needs the tab.
- **A workspace folder open in VS Code.** The panel is the view of ONE
  project, the first folder of the workspace.

The token is read from `~/.aipass/.token` (or `$AIPASS_HOME/.token`). It is
never printed, never put in a URL, and never handed to the webview: the panel
is a page, and the token stays in the extension host.

## Running it from source

1. Open this repository in VS Code.
2. Open `ide-extension/` in the editor.
3. Press **F5** — "Run Extension" — which starts a second VS Code window
   (the Extension Development Host) with this extension loaded.
4. In that window: **Ctrl+Shift+P → `AiPASS: เปิดแผงผู้ช่วย`** (open the agent
   panel), with the desktop backend already running.

There is no build step and no dependency to install: the extension is plain
CommonJS plus plain browser JavaScript, and the VS Code API comes from the
host.

## What the panel can do

| | |
|---|---|
| **Send a task** | One task at a time, exactly like the window. |
| **Stream the run** | The prose as it arrives, one row per tool call, the notes, the reasoning folded, the checklist card. |
| **Answer the questions** | The backend asks; the client answers. Permission: deny / always / allow. Plan: approve / decline. The answer carries the project, so a question about another project is never answered blind. |
| **Show the staged changes** | The file list with the tick boxes and a diff per file. Nothing reaches the disk until you press **เขียนเลย** (apply). |
| **Stop a run** | The stop is a request with an answer: the panel says what the stop found. |
| **Show the credit meter** | The backend's `credits` method, refreshed while the panel is open. |
| **Degrade honestly** | When the backend is not running, the panel says so and names the command that starts it. It never pretends to be working. |

## The honest limits

- **It is a client, not the app.** The desktop window stays the place where
  the settings sheet, the plugin installer, the MCP servers and the update
  service live. The panel calls a fixed list of methods and nothing else.
- **One project per panel.** The backend holds one harness per project; the
  panel is the view of the first workspace folder. Open a second window for a
  second project.
- **The prose is cleaned in the extension host**, with the marker grammar
  mirrored from the harness. The window keeps the same mirror and the
  repository's suite keeps the two honest against each other; this copy has
  **no parity test**, but the self-test compares its keyword list against the
  harness's own `MARKER_LINE` whenever the harness is next to the extension —
  so a marker added to the harness fails the self-test until the mirror is
  updated. (It already caught one: `VERIFY` was added to the harness while
  this extension was being written.)
- **No diff editor, no file tree, no session browser.** The panel is the run,
  the questions, the changes and the meter. The window is the app.
- **The backend must be running.** There is no in-panel "start the backend"
  button: the extension does not spawn processes, so it cannot leave a
  half-started agent behind.
- **The package needs a human sign-off.** `ide-extension/` is an npm package
  directory (VS Code requires a `package.json` there), and the repository's
  rule 11 says an npm package needs one. It has **zero dependencies** and
  **zero devDependencies**, and it is marked `private`.

## The self-test

The repository's own suite (`node --test` over `aipass-bridge/test/*.test.mjs`)
belongs to another agent, so this extension carries its own check:

```bash
node ide-extension/selftest.mjs
# or, from inside this directory:
npm run selftest
```

It drives the pure parts — where the port comes from, how the token is read,
what a request body looks like, how one SSE frame is parsed, which markers
must never reach the reader — and the transport itself against a fake backend
on a loopback socket, and the panel's own script against a fake DOM. It exits
non-zero when anything fails.

Two of the checks are drift detectors, and they skip when the repository is
not next to the extension: **every event the harness emits must be one the
panel knows**, and **every keyword in the harness's marker grammar must be one
the mirror drops**.

## The files

| path | what it is |
|---|---|
| `extension.js` | The extension host: the panel, the backend client, the message bridge. |
| `lib/protocol.js` | The pure half: the port, the token, the request shape, the SSE parser, the marker stripper. |
| `lib/backend.js` | The transport: one JSON-RPC call, one event stream. |
| `media/panel.html` · `media/panel.css` · `media/panel.js` | The panel itself: plain HTML, plain CSS, plain JS. No framework, no build step. |
| `selftest.mjs` | The self-test. |
| `protocol.md` | The backend contract, for anyone building another editor on it. |
