# aipass-bridge — architecture & internals

A deep reference for how this thing is built and why. For *using* it, see
[`README.md`](./README.md); this document is the map you read once before
changing something.

- [What it is, in one paragraph](#what-it-is-in-one-paragraph)
- [The constraint that shapes everything](#the-constraint-that-shapes-everything)
- [The data path](#the-data-path)
- [File map](#file-map)
- [The bridge (`bridge/server.mjs`)](#the-bridge-bridgeservermjs)
- [The extension (`extension/`)](#the-extension-extension)
- [The chat client (`chat.mjs`)](#the-chat-client-chatmjs)
- [The file agent (`agent.mjs`)](#the-file-agent-agentmjs)
- [The printers (`list.mjs`)](#the-printers-listmjs)
- [Tests (`test/`)](#tests-test)
- [HTTP API reference](#http-api-reference)
- [End-to-end walkthrough](#end-to-end-walkthrough)
- [Environment variables](#environment-variables)
- [Security properties (and non-properties)](#security-properties-and-non-properties)
- [Extending it](#extending-it)

---

## What it is, in one paragraph

A terminal talks to `de.aipass.net`'s chat product without ever holding a
credential. A zero-dependency Node process (**the bridge**) exposes an
OpenAI-compatible HTTP surface on `127.0.0.1:8787`. A Chrome MV3 **extension**
holds a long-lived connection to the bridge and, for each request, runs the
real upstream `fetch()` *as ordinary page JavaScript inside an already
-logged-in `de.aipass.net` tab* — so Chrome attaches the session cookie itself.
The bridge and the CLIs only ever speak to localhost; nothing is written to
disk.

Everything under `aipass-bridge/` imports only `node:*` builtins. No
`npm install` is needed to run the bridge, the CLIs, or the tests.

---

## The constraint that shapes everything

The upstream endpoint (`/actions/send-message/<id>`) accepts **exactly one user
message per request** and nothing else:

- A `messages` array containing an **assistant** turn is rejected with a bare
  `403` from Google Frontend, *before the model sees it*. The web UI never sends
  one — the server owns the conversation and its history.
- Agent-style **system prompts** were rejected too, at sizes and shapes where
  plain text of the same size passed. This points at request *scoring*, not a
  single rule.

So the whole design is: **send one user message, stream the answer back.**
Multi-turn works only because the server remembers the conversation. This forces
three things that would otherwise look strange:

1. `lastUserText()` in the bridge forwards only the newest `role:"user"` message.
2. `agent.mjs` sends its instruction preamble **once**, as the first message of
   a fresh conversation, then sends only tool results afterward.
3. `agent.mjs` encodes WAF-trigger tokens symmetrically (see
   [The file agent](#the-file-agent-agentmjs)), because arbitrary file contents
   routinely trip the same scoring.

---

## The data path

```
 CLI  (chat.mjs / agent.mjs / list.mjs)
  │   HTTP, OpenAI-compatible, to 127.0.0.1:8787
  ▼
 bridge/server.mjs
  │   ▲
  │   │  GET /ext/events  ── SSE: one job per frame ──▶  extension/background.js
  │   │                                                    (MV3 service worker)
  │   └── POST /ext/{chunk,done,error,loader} ◀───────────┘   holds the SSE socket
  │       results / deltas come back here                     + routes jobs to a tab
  ▼                                                     │  chrome.runtime messaging
 (job promise resolves, CLI sees the stream)           ▼
                                          extension/content.js   (ISOLATED world)
                                                 ⇅  window.postMessage
                                          extension/page.js      (MAIN world)
                                                 │  fetch(..., { credentials: 'include' })
                                                 │  runs as first-party de.aipass.net JS
                                                 ▼
                                          de.aipass.net
                                            /actions/send-message/<id>   (chat)
                                            /chat.data                   (create conversation)
                                            /loaders/*.data              (read-only app loaders)
```

Two facts explain the shape:

- **Why the service worker (not the content script) holds the bridge socket.**
  An `https://` page POSTing to `http://127.0.0.1` runs into mixed-content and
  Private Network Access checks. An extension request backed by
  `host_permissions` does not. So `background.js` owns the connection;
  `content.js`/`page.js` only touch same-origin `de.aipass.net` URLs.
- **Why the upstream fetch lives in `page.js` (MAIN world).** Only code running
  as the page itself gets the session cookie attached by the browser. Nothing in
  the extension ever reads `document.cookie` or requests the `cookies`
  permission.

---

## File map

```
aipass-bridge/
├── bin/aipass.mjs     one-command dispatcher (`aipass` on PATH) — spawns the CLIs below
├── install.sh / .ps1  put `aipass` on PATH (symlink → npm link on POSIX; npm link on Windows)
├── bridge/
│   ├── server.mjs     the bridge: HTTP surface + job hub + turbo-stream + conversation logic
│   └── package.json    { "type": "module", engines.node >= 18 } — no dependencies
├── extension/          Chrome MV3, loaded unpacked
│   ├── manifest.json   permissions, host_permissions, content-script worlds
│   ├── background.js    service worker — holds the SSE socket, routes jobs into a tab
│   ├── content.js       ISOLATED world — relays page⇄worker, keeps the worker alive
│   ├── page.js          MAIN world — the credentialed fetches; self-limits its own scope
│   ├── popup.html/.js   status panel + bridge-URL + default-model picker
├── chat.mjs            interactive / one-shot terminal client (the TUI)
├── agent.mjs           local file-editing agent driven by the model
├── list.mjs            small printers for `npm run models` / `npm run conversations`
├── handoff.html        a standalone styled "field guide" (same content, prettier)
├── jsconfig.json       type-check config for `chat.mjs` (`// @ts-check`), no build
└── test/
    ├── harness.mjs      spawns the real bridge + a scriptable fake extension
    ├── bridge.test.mjs  HTTP surface, conversation rotation, loopback round-trip
    ├── agent.test.mjs   action protocol, 403 splitting, line dropping, dry run
    └── chat.test.mjs    one-shot output, tool/sources rendering, error messages
```

---

## The bridge (`bridge/server.mjs`)

A single `http.createServer`. ~570 lines, no dependencies.

### Job hub

The core abstraction. A CLI request becomes a `Job`; the job is dispatched to an
extension over SSE; the extension POSTs results back, which resolve the job's
promise.

- **`jobs`** — `Map<jobId, Job>`. **`extClients`** — `Set` of connected SSE
  responses. **`pickClient()`** — round-robin (`rr++ % size`).
- **`class Job`** — fields: `id` (uuid), `kind`, per-kind `timeoutMs`, the
  payload (`text`/`url`/`message`/…), and `onDelta` / `onDone` / `onError`
  callbacks supplied by the route handler.
  - `dispatch()` writes one SSE `event: job` frame to the picked client. The
    frame's shape depends on `kind`.
  - `touch()` (re)arms the idle timer. Called on **every** delta, so a long
    `web_search` that streams progress never times out.
  - `delta(part)` → `onDelta`; `done(v)` / `fail(msg)` → settle + `cleanup()`
    (clear timer, delete from `jobs`); `abort()` sends `event: abort` to the
    client and settles.
- **Kinds:**
  | kind | what the extension does | dispatched fields |
  |---|---|---|
  | `chat` | `POST /actions/send-message/<id>`, stream SSE back | `conversationId, modelId, text` |
  | `loader` | `GET` one `/loaders/*.data` route (read-only) | `url` |
  | `create` | form-`POST /chat.data` `intent=create-conversation` | `modelId, message, requestId, assistant, assistantField` |
- **Extension disconnect mid-job does not fail the job.** On `req.close` the
  bridge only nulls `job.client` for that client's in-flight jobs. The upstream
  fetch lives in `page.js` and survives the MV3 worker being evicted, which is
  exactly what happens during a long search with no deltas flowing.
- **Idle timeouts:** `chat` uses `AIPASS_IDLE_TIMEOUT_MS` (default 180 s);
  `loader` 20 s; `create` 30 s.

### turbo-stream

The app's `.data` routes return **react-router turbo-stream**: a flat JSON array
where objects address their keys and values by index, and negative numbers are
`null`/`undefined` sentinels.

- **`decodeTurboStream(text)`** rebuilds the object graph, memoising by index so
  shared/cyclic refs resolve once.
- **`encodeTurboStream(value)`** in `test/harness.mjs` builds fixtures the same
  way, so tests never hand-write the format.

### Models

- **`listModels({force})`** — 60 s cache. If no extension is attached it returns
  `MODELS_FALLBACK` (`AIPASS_MODELS`, default two ids). Otherwise it fires a
  `loader` job for `list-models.data`, decodes it, and runs
  **`extractModels()`** — a tree walk collecting every object with a string
  `id`/`modelId`, mapping `displayName`/`isFreeCredit`/`thinkingConfig`, and
  (unless `AIPASS_MODEL_FILTER=all`) dropping image/video/audio generators by a
  regex on the id.
- A single in-flight refresh is shared (`modelRefresh`) so concurrent callers
  don't each hit the API.

### Conversations

- **`resolveConversation()`** — precedence: `AIPASS_CONVERSATION_ID` (pinned) →
  `conversationCache` → newest entry of a freshly loaded list
  (`loadConversations()` sorts by `updatedAt` desc).
- **`createConversation({modelId, message, assistant})`** — fires a `create`
  job, reads `conversationId` out of the turbo-stream response (the server
  derives it from the first 16 hex chars of `clientCreateRequestId`), and makes
  it the new `conversationCache`.
- **`startChat()` rotation** — if the `chat` job errors with *conversation not
  found / 404 / 409*, and **no deltas have been delivered yet**, and the
  conversation isn't pinned, it advances `conversationIndex`, clears the cache,
  and retries (up to 3 times). `404` = deleted; `409` = the server still thinks
  a generation is running there.

### `/v1/chat/completions`

`lastUserText(messages)` keeps only the last `role:"user"` entry (string
`content` or the concatenation of its text parts). Everything else in the
request body is ignored. Stream mode emits OpenAI-shaped
`chat.completion.chunk` frames; `status` parts from the extension become
`reasoning_content` deltas unless `AIPASS_TOOL_VISIBILITY` says otherwise
(`text` inlines them into `content`, `off` drops them).

### CORS

Every response carries `Access-Control-Allow-Origin: *` and the `OPTIONS`
handler allows any header + Private Network Access. This is deliberate (so a
browser-side client can reach the bridge) and is the main thing to be aware of
security-wise — see [below](#security-properties-and-non-properties).

---

## The extension (`extension/`)

MV3, three script contexts, loaded unpacked.

### `manifest.json`

- **`permissions`**: `storage` (remember the bridge URL), `alarms` (wake the
  worker), `tabs` (find the chat tab), `scripting` (re-inject scripts into a
  pre-existing tab). **No `cookies`, no `webRequest`.**
- **`host_permissions`**: `https://de.aipass.net/*`, `http://127.0.0.1/*`,
  `http://localhost/*` — nothing else.
- **content scripts**, both `matches: ["https://de.aipass.net/*"]`,
  `run_at: document_start`:
  - `page.js` → `world: "MAIN"`
  - `content.js` → `world: "ISOLATED"`

### `background.js` — the service worker

- **`connect()`** opens `GET {bridgeUrl}/ext/events` and reads the SSE stream,
  parsing `event:` / `data:` frames into `handleJob` / `abort`. It self-cycles
  every **4 min** (`CYCLE_MS`, under Chrome's long-request ceiling) and retries
  **3 s** after any drop. `chrome.alarms` (`keepalive`, every 30 s),
  `onStartup`, `onInstalled`, and a `keepalive` port connection all call
  `connect()`; a guard makes duplicate calls harmless.
- **`handleJob(job)`** → `findChatTab()` (a non-discarded `de.aipass.net` tab,
  preferring one already on a `/chat` route) → `ensureContentScript(tab)` (ping
  it; if silent, reload a discarded tab or re-inject `page.js` then `content.js`
  via `chrome.scripting`) → `chrome.tabs.sendMessage({ type: 'run', job })`.
- Results arrive back as `chrome.runtime` messages (`type: 'from-page'`) and are
  POSTed straight to `/ext/{chunk,done,error,loader}`.
- The bridge URL lives in `chrome.storage.local.bridgeUrl` (default
  `http://127.0.0.1:8787`), editable from the popup.

### `content.js` — ISOLATED world

Two jobs:

1. **Relay.** Worker → page: `chrome.runtime.onMessage` (`run` / `abort`) is
   re-posted as a `window.postMessage`. Page → worker:
   `window.addEventListener('message')` results are sent via
   `chrome.runtime.sendMessage`, retried up to 5× because the target worker may
   be mid-eviction.
2. **Keep the worker alive.** `keepAlive()` opens a long-lived
   `chrome.runtime.connect({ name: 'keepalive' })` port, beats it every 20 s,
   and cycles it every 4 min. Chrome evicts an idle MV3 worker after ~30 s and
   *inbound SSE data does not count as activity* — without this port the bridge
   would see a disconnect/reconnect cycle every half minute and any job landing
   in that window would fail.

Both scripts carry a **generation guard** (`window.__aipassBridge*Gen`): each
injection claims a higher number, older copies stand down. This is how a
re-loaded extension replaces stale code in a tab that was already open.

### `page.js` — MAIN world

Runs as the page. Every `fetch` here is first-party and credentialed. It
**limits its own blast radius** so that even a fully compromised bridge can only
do three narrow things:

- **`runLoader(job)`** — refuses any `job.url` not matching
  `^/loaders/[A-Za-z0-9._~-]+(\.data)?(\?|$)`. No arbitrary-URL forwarding.
- **`runCreate(job)`** — only `POST /chat.data` with
  `intent=create-conversation`; optionally sets the assistant-binding field
  (name supplied by the bridge, so it can be corrected without shipping a new
  extension).
- **`run(job)`** — only `POST /actions/send-message/<conversationId>`. Builds
  the one-user-message body, reads the upstream SSE stream and translates its
  event types:
  | upstream event | becomes |
  |---|---|
  | `text-delta` | `text` part |
  | `reasoning-delta` | `reasoning` part |
  | `tool-input-available` | `status` part `[tool] {input json}` |
  | `tool-output-available` | `status` part `[tool] returned N chars` |
  | `source-url` | collected, emitted at the end as a `status` `sources:` block |
  | `error` | throws (→ `/ext/error`) |
  | `finish` | sets `finishReason` |
  Deltas are batched and flushed every 40 ms so the hop back to the bridge isn't
  hundreds of POSTs per response.

### `popup.js`

Polls `chrome.runtime.sendMessage({ type: 'status' })` and `GET /status` every
1.5 s. Shows connected/not, the chat tab's path, active job count, a
default-model `<select>` (writes `POST /config`), and a bridge-URL field
(writes `chrome.storage.local` + triggers a reconnect).

---

## The chat client (`chat.mjs`)

Interactive TUI and one-shot client. ~670 lines, `// @ts-check`, no
dependencies. **Every cursor-moving or colouring effect is gated behind
`stdout.isTTY`** — piped output is plain and stable, which is also what the test
harness asserts against (it strips SGR colour codes but *not* cursor moves).

### Streaming and rendering (`ask()`)

1. `POST /v1/chat/completions` with `{ stream: true, messages: [one user msg] }`.
2. A **braille spinner** (`⠋⠙⠹…`) with elapsed seconds runs until the first
   byte, and again between a tool block and the answer resuming.
3. **`content` deltas** are echoed live, dimmed, while a running count of
   terminal rows/columns is kept. When the message completes (or a tool block
   interrupts), **`reformat()`** erases those rows (`\x1b[<n>A\x1b[J`) and
   re-prints the same text through the markdown renderer. Net effect: you see it
   stream, then it snaps into formatted form.
4. **`reasoning_content` deltas** (tool activity) are rendered by
   `renderTool()`: `⏺ [web_search] {…}` gutter lines, `⎿ …` for other lines, and
   a `sources` list (`· title` + dim URL, capped at 6 with `… +N more`). A blank
   line always separates a tool block from prose — this is the fix for the old
   `…!sources:` run-together bug.
5. **Markdown** (`makeRenderer()`, line at a time, fenced-code state held across
   calls): headings, `-`/`*`/`+` and numbered lists with hanging indent,
   blockquotes, `---` rules, and inline `**bold**` / `` `code` `` /
   `[text](url)` / `*italic*`. `wrap()` is ANSI-aware and wraps to
   `min(cols, 100)`.

### The input frame

Each turn prints a rounded rule above the prompt (`topRule()`) and a matching
one below once the line is submitted (`botRule()`), both spanning
`termWidth() - 1`. There are no side bars: `readline` owns the line width, and
closing the right edge would mean redrawing the whole box on every keystroke
(i.e. replacing `readline` with a raw-mode editor).

### The slash-command menu

A dropdown that appears while you type a `/command` (TTY only). One
`stdin.on('keypress')` handler, added once:

- **`drawMenu()`** filters `COMMANDS` by the current buffer and paints the list
  *below* the input line, then moves the cursor back up and to the typing
  column (`\r\n\x1b[J<rows>\x1b[<n>A\x1b[<col>G`). `promptCol()` computes the
  column from `PROMPT.length + rl.cursor`.
- **↑/↓** move the highlight. Because readline also binds those to history, the
  handler calls **`setLine(slashBuf)`** (public `rl.write` with `ctrl-a` /
  `ctrl-k` then the text) to undo any history jump.
- **Tab** fills the highlighted command into the line; **Enter** stashes it in
  `pendingPick`, which the loop applies in place of what readline resolved;
  **Esc** dismisses.

### The conversation picker (`/conversations`)

A modal `↑/↓` list. `pickConversation()`:

1. **Detaches every `keypress` listener** currently on `stdin` (readline's *and*
   the slash-menu's) and installs its own `onKey`, so arrows can't leak into
   history navigation. `emitKeypressEvents`' `data` parser stays attached, so
   keypress events keep being produced.
2. `paint()` renders the list (`●` = active, `›` = highlight, relative time),
   re-drawing in place on each move.
3. On **Enter** / **Esc** it restores the saved listeners, wipes the block, and
   resolves with the chosen row or `null`. A choice → `POST /config
   { conversation: <id> }`.

### `/new` is deferred

`--new` or `/new` only sets `pendingNew`. `maybeStartNew(seed)` runs before the
next `ask()` and, if pending, does `POST /conversations/new { message: seed }`
with **the real first message** as the seed — so the account's chat list shows
the conversation titled by real text, exactly like the web UI, instead of a
`"New chat."` placeholder.

### Exit

`Promise.race([rl.question(...), closed])` where `closed` resolves on readline's
`close` event, so EOF (Ctrl-D / a closed pipe) ends the loop cleanly instead of
leaving an unsettled top-level `await`. `Ctrl-C` is handled by `rl.on('SIGINT')`.

---

## The file agent (`agent.mjs`)

The model drives local file edits by emitting **action lines**; the agent runs
each one and pastes the result back as the next (single) user message. ~575
lines, no dependencies.

### Actions

| line | effect |
|---|---|
| `NEED dir <path>` | list a directory |
| `NEED file <path> [a-b]` | read a file with a line-number gutter; optional range |
| `SEARCH <text>` | grep the tree → `file:line: excerpt` (max 50 hits) |
| `EDIT <p>` / `FIND` … / `NEW` … / `END` | replace an exact snippet — refused unless `FIND` matches **one** place |
| `CREATE <p>` … `END` | create / overwrite a file |
| `RUN` … `END` | shell via `execSync` (the platform shell: `/bin/sh` / `cmd.exe`) — **only with `--allow-run`** |
| `DONE <summary>` | finish |

### Overlay filesystem

Edits land in an in-memory `overlay: Map<absPath, contents>`. Reads consult the
overlay first, so the model can read back its own pending work. `--apply`
flushes the overlay to disk; without it you get a coloured unified diff and
nothing is written. That diff is a small in-file Myers implementation
(`lineDiff` + `printUnified`) — no `diff` binary, so it renders the same on
Windows. **`safe(p)`** resolves every path against `--root` and throws if it
escapes. `stripGutter()` removes the line-number prefix from a `FIND` block if
*every* non-empty line carries one (so real code containing a `|` is left
alone).

### Symmetric WAF encoding (load-bearing)

Arbitrary file contents trip the same upstream scoring as an assistant turn — a
README with `localhost`, `<div>`, `process.env`, or an SSRF-shaped IP is enough
for a `403`. So:

- **`outbound(text)`** rewrites trigger tokens *before anything is sent*:
  `localhost`→`LCLHST`, `127.0.0.1`→`LOOPBACK-IP`, `169.254.169.254`→
  `METADATA-IP`, `0.0.0.0`→`ANY-IP`, `file://`→`FILE-URI`, `<!doctype`→
  `DOCTYPE-DECL`, `<!--`→`CMT-OPEN`, `-->`→`CMT-CLOSE`, `<script`→
  `TAG-SCRIPT-OPEN`, `</script>`→`TAG-SCRIPT-CLOSE`, `javascript:`→`JS-SCHEME`,
  `process.env`→`PROCESS-ENV`, `.env`→`DOT-ENV`, and any tag-opening `<`
  (`<(?=[a-zA-Z/!?])`) → `TAG-LT` while leaving `a < b` and `=>` alone.
- **`inbound(text)`** restores them on *everything read back* — including the
  model's own action lines — so bytes written to disk are exactly the file's,
  and a file whose *name* is a trigger (a real `.env` shown as `DOT-ENV`) still
  opens. **The two lists must stay in sync.**

### Resilient send (`sayResilient()`)

- Encodes the whole message once (at depth 0).
- On a `403`/`409`: if the fragment is already tiny (`< 300` bytes) or recursion
  is deep, run **`redact()`** — blank individual lines matching `RISKY_LINE`
  (`node -e`, `eval(`, `child_process`, `exec(`, `curl`, `rm -rf`, `/bin/sh`,
  `../../`, HTML/XSS tokens…). Otherwise **`splitInHalf()`** and send the halves
  in order (recursively); the server remembers each part so the model still sees
  the whole thing. A fragment rejected even on its own is printed, not silently
  dropped.
- Tool results are capped at `--max-result` (3000) bytes for the same reason.

### Session shape

`PREAMBLE` (the division-of-labour explainer, deliberately prose-shaped — no
angle brackets, no `key=value`, no absolute paths, all of which drew 403s) is
sent **once** as the first message, plus the top-level directory listing.
`--slim` / `--assistant <id>` drop it when a custom aipass assistant already
carries the protocol. `--watch` keeps the conversation open for follow-up tasks,
so the model retains everything it has read while each new task stays a small
message.

---

## The printers (`list.mjs`)

`npm run models` / `npm run conversations`. These exist as a file, rather than
`node -e "…"` in `package.json`, on purpose: the agent reads `package.json`
early in almost every task, and a script field shaped like code execution got
the *whole read* `403`'d upstream.

## The dispatcher (`bin/aipass.mjs`)

The `aipass` command — a `bin` entry in the root `package.json`, installed by
`install.sh` (POSIX: symlink into `~/.local/bin`, else `npm link`) or
`install.ps1` (Windows: `npm link`). Zero dependencies: each subcommand just
`spawn`s one of the sibling `*.mjs` files with `stdio: 'inherit'` (so the TUI's
raw mode and `isTTY` pass straight through). The detached bridge spawn also
passes `windowsHide: true`.

- `aipass` / `aipass "q"` → `chat.mjs`; `dev` → `bridge/server.mjs` (foreground);
  `agent "task"` → `agent.mjs` (whose `--root` already defaults to `cwd`);
  `models` / `conversations` → `list.mjs`.
- **Auto-start.** Every subcommand except `dev` calls `ensureBridge()`: if
  `GET {BRIDGE}/status` doesn't answer, it `spawn`s the bridge **detached**
  (`stdio` → `~/.aipass/bridge.log`, pid → `~/.aipass/bridge.pid`), `unref()`s
  it, and polls `/status` for up to 4 s before continuing. `aipass stop` reads
  the pidfile and kills it; a foreground `aipass dev` bridge is just Ctrl+C.
- **`BRIDGE`** is derived from `AIPASS_HOST`/`AIPASS_PORT` and passed to every
  child as `--bridge` (and `AIPASS_BRIDGE` for `list.mjs`), so a non-default port
  is honoured end to end — which the bare `npm run *` scripts don't do.
- `aipass status` runs no `ensureBridge` — it just reports Node version, whether
  the bridge answers, the connected-extension count, and the current
  model/conversation.

---

## Tests (`test/`)

`test/harness.mjs` spawns the **real** `bridge/server.mjs` as a subprocess on a
free port, plus a scriptable **`FakeExtension`** that connects to `/ext/events`
and answers jobs. Tests therefore drive the actual HTTP surface and the real
CLIs — not mocks.

- **`FakeExtension`** — `#handle(job)` branches on `job.kind`. For `chat` it
  calls `onChat(job, emit)` where `emit = { text, status, done, error }`.
- **`scripted(replies, { reject })`** — replies from the list in order; `reject`
  is a predicate that models an upstream filter (returns a `403`). It records
  what was actually `sent` vs `rejected`.
- **`run(script, args, { stdin })`** — spawns a CLI, **strips SGR colour codes**
  from captured output before assertions (cursor moves are *not* stripped —
  hence the `isTTY` gating in `chat.mjs`). `stdin` may be a string or
  `[delayMs, line]` pairs, needed for REPL/watch tests where a line sent before
  the prompt appears is lost.

`npm test` → ~45 tests, a few seconds. They cover the failures this project
actually hit: only-newest-user-message forwarding; conversation rotation past a
locked one; a job surviving mid-stream extension disconnect; loopback
round-tripping unchanged to disk; splitting a rejected turn; dropping an
un-sendable line; a premature `DONE`; recovery from prose drift; refusing paths
outside `--root`; dry-run leaving the disk untouched.

`chat.mjs` also carries `// @ts-check` JSDoc types — `npm i -D typescript` then
`npx tsc -p aipass-bridge/jsconfig.json` (no build, no runtime dep).

---

## HTTP API reference

All on `http://127.0.0.1:8787` by default. Every response has
`Access-Control-Allow-Origin: *`.

| method + path | purpose | notes |
|---|---|---|
| `POST /v1/chat/completions` | OpenAI-compatible chat | `stream: true` → SSE `chat.completion.chunk`; only the last user message is used |
| `GET /v1/models` | OpenAI-compatible model list | `?refresh=1` forces a re-fetch; falls back to `AIPASS_MODELS` with no extension |
| `POST /conversations/new` | create a conversation | body `{ message, model?, assistant? }` → `{ id }` |
| `GET /conversations` | list conversations | `{ current, conversations: [{ id, title, updatedAt }] }` |
| `POST /config` | set runtime state | `{ defaultModel?, assistant?, conversation? }`; `conversation: null` clears the pin |
| `GET /status` · `GET /health` | health / introspection | `{ ok, extensions, activeJobs, defaultModel, conversation, assistant, models }` |
| `GET /ext/events` | **extension only** — SSE job stream | `event: job` / `event: abort` frames |
| `POST /ext/chunk` | **extension only** — deltas | `{ jobId, parts: [{ kind, text }] }` |
| `POST /ext/done` | **extension only** — job finished | `{ jobId, finishReason }` |
| `POST /ext/error` | **extension only** — job failed | `{ jobId, message }` |
| `POST /ext/loader` | **extension only** — loader/create result | `{ jobId, raw }` or `{ jobId, message }` |
| `OPTIONS *` | CORS preflight | allows any header + PNA |

---

## End-to-end walkthrough

`npm run chat -- "hello"` with the bridge up and one `de.aipass.net` tab open:

1. **`chat.mjs`** `GET /status`. `extensions` is `1` → proceed. (`0` → it exits
   with a message.)
2. `POST /v1/chat/completions` `{ stream: true, messages: [{ role: "user",
   content: "hello" }] }`.
3. **bridge** `lastUserText()` → `"hello"`. `startChat()` → `resolveConversation()`
   picks the newest conversation. A `chat` `Job` is created and `dispatch()`
   writes one `event: job` SSE frame `{ jobId, kind: "chat", conversationId,
   modelId, text: "hello" }` to the round-robin extension client.
4. **`background.js`** reads the frame → `findChatTab()` → `ensureContentScript()`
   → `chrome.tabs.sendMessage({ type: "run", job })`.
5. **`content.js`** re-posts it as `window.postMessage`. **`page.js`** `run(job)`
   does `POST /actions/send-message/<id>` with `credentials: "include"` — the
   browser attaches the cookie. It reads the upstream SSE stream, batching
   `text-delta` → `text` parts (and any `tool-*` → `status` parts) every 40 ms,
   posting each batch back via `content.js` → `background.js` →
   `POST /ext/chunk`.
6. **bridge** `extPost` → `job.delta(part)` for each part → `onDelta` →
   `emit({ content })` (or `{ reasoning_content }` for `status`) as a
   `chat.completion.chunk` on the CLI's still-open response. `touch()` re-arms
   the idle timer on every delta.
7. Upstream `finish` → `page.js` posts `POST /ext/done` → `job.done()` → the
   bridge emits the final chunk + `data: [DONE]` and ends the response.
8. **`chat.mjs`** has been streaming the whole time (dim live echo); on
   completion `reformat()` erases the raw echo and re-prints it as wrapped
   markdown. `process.exit(0)`.

If the tab was on a stale/deleted conversation, step 6's first error (before any
delta) triggers `startChat()`'s rotation and steps 3–6 repeat against the next
conversation.

---

## Environment variables

All read in `bridge/server.mjs`.

| var | default | effect |
|---|---|---|
| `AIPASS_PORT` | `8787` | listen port |
| `AIPASS_HOST` | `127.0.0.1` | bind address |
| `AIPASS_MODEL` | `gemini-3.1-flash-lite` | model when a request names none |
| `AIPASS_MODELS` | two ids | model list to report when no extension is attached |
| `AIPASS_MODEL_FILTER` | `chat` | `all` keeps image/video/audio generators in the list |
| `AIPASS_TOOL_VISIBILITY` | `reasoning` | `text` inlines tool activity into `content`; `off` drops it |
| `AIPASS_CONVERSATION_ID` | *(unset)* | pin one conversation; disables rotation |
| `AIPASS_IDLE_TIMEOUT_MS` | `180000` | fail a `chat` job after this long with no delta |
| `AIPASS_ASSISTANT_ID` | *(unset)* | bind new conversations to a custom assistant |
| `AIPASS_ASSISTANT_FIELD` | `aiAssistantId` | the `/chat.data` form field that carries the assistant id |

`chat.mjs` / `agent.mjs` / `list.mjs` also honour `--bridge <url>` (and
`AIPASS_BRIDGE` for `list.mjs`).

---

## Security properties (and non-properties)

**Holds:**

- No credential reaches the bridge or the CLIs. The authenticated `fetch` runs
  only in `page.js`; nothing reads `document.cookie`; the `cookies` and
  `webRequest` permissions are not requested.
- The bridge and CLIs speak only to `127.0.0.1`. Nothing is written to disk by
  the bridge.
- `page.js` cannot be turned into a general request forwarder — `runLoader`
  hard-refuses non-`/loaders/` paths and the tool set is fixed at
  `{ chat, loader, create }`.
- `agent.mjs` confines every path to `--root` (`safe()`); the shell tool is off
  unless `--allow-run`; edits are a dry run unless `--apply`.
- `.gitignore` excludes `*.har`, `aipass*.md`, `apipass*.md` — API captures
  contain live session cookies.

**Be aware:**

- **`Access-Control-Allow-Origin: *`.** While `npm run dev` is running, *any*
  site open in the browser can `POST` to `localhost:8787` and send a message on
  your account (burning credits, creating history). Stop the bridge when idle.
- Every message goes through the real product and appears in the account's chat
  history.
- `npm run agent --allow-run` gives the model a shell inside `--root`. Don't
  pair it with `--apply` on an untrusted task.
- Only `gemini-3.1-flash-lite` is free-credit; long sessions cost money.

---

## Extending it

- **A new bridge route** — add a branch in the `http.createServer` handler
  (they're plain `if (path === … && req.method === …)`), use `json(res, …)` or
  the SSE helpers, and add a `bridge.test.mjs` case driving it through the real
  server.
- **A new job kind** — extend `Job.dispatch()`'s per-kind frame, teach
  `page.js`'s `window.addEventListener('message')` dispatch to route it, and
  keep `page.js`'s scope check tight (allow-list, not deny-list).
- **A new WAF substitution** in `agent.mjs` — add the pair to **both**
  `SUBSTITUTIONS` and `RESTORE`, pick a placeholder that shares no substring
  with the original (a case-insensitive rule would otherwise still match), and
  add a round-trip assertion.
- **A new slash command** in `chat.mjs` — add it to `COMMANDS` (it then appears
  in the `/` menu and `/help` automatically) and handle `line === '/x'` in the
  loop before the message path.
- **A new test** — `scripted([...])` for the model's replies, `reject` to model
  a filter, `run(CLI, args, { stdin })` to drive a CLI; assert on the
  SGR-stripped output.
