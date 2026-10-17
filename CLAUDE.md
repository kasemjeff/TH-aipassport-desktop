# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

**`aipass-bridge/`** is the project: a zero-dependency Node bridge plus a
Chrome MV3 extension that let a terminal talk to `de.aipass.net`'s chat, with
streaming, through an already-logged-in browser tab. `desktop/` wraps the same
`.mjs` files in a Tauri window (plus a zero-build plain-JS UI in
`desktop/ui/`).

Everything imports only `node:*` builtins — no `npm install` is needed to run
the bridge, the CLIs, the tests, or the desktop backend. The root `package.json`
is a script runner; the Next.js scaffold that used to ship with this repo was
removed, so `npm ci`/`npm install` install nothing and that is deliberate.

## Commands

| | |
|---|---|
| `npm run dev` | start the bridge on `:8787` (leave running) |
| `npm test` | full suite — `node --test aipass-bridge/test/*.test.mjs` |
| `node --test aipass-bridge/test/chat.test.mjs` | one test file |
| `node --test --test-name-pattern="one-shot" aipass-bridge/test/*.test.mjs` | one test by name |
| `npm run chat` / `npm run chat -- "msg"` | terminal client (interactive / one-shot) |
| `npm run agent -- "task" --root .` | local file-editing agent (dry run; add `--apply` to write) |
| `npm run models` / `npm run conversations` | `list.mjs` printers |
| `npm run desktop` | bridge + harness backend + the window in a browser |
| `npm run tauri:dev` / `tauri:build` | the packaged window (Windows NSIS by default) |
| `npm run desktop:sidecar` | copy the local Node into the Tauri sidecar slot |
| `npm run qa` | one QA pass: static wiring, suite, window logic, live backend |

`aipass-bridge/bin/aipass.mjs` is a `bin`-linked dispatcher (install:
`aipass-bridge/install.sh` on POSIX, `install.ps1` on Windows): `aipass` /
`aipass dev` / `aipass agent "task"` / `aipass models|conversations|status|stop`.
Everything but `dev` auto-starts a detached bridge (`~/.aipass/bridge.{log,pid}`).
It's a thin `spawn` wrapper over the same `*.mjs` files — the `npm run *` scripts
stay the canonical way to run things. The whole `aipass-bridge/` tree is
Windows-clean: no `/bin/sh`, no `diff` binary, `windowsHide` on the spawn.

There is no lint or format config anywhere in the repo: nothing here needs a
build step, and the removed Next.js scaffold used to bring its own eslint. Keep
it that way — a toolchain for plain `.mjs` files would be a second thing to
install before anybody can run a test.

Runtime prerequisite for anything that actually hits upstream: the unpacked
extension (`aipass-bridge/extension/`) loaded in Chrome **and** an open
`https://de.aipass.net/chat` tab. `GET /status` reports `extensions: 0` when the
extension isn't connected; the CLIs exit early in that case.

## Architecture

`aipass-bridge/DOCS.md` is the full internals reference (job hub, extension
contexts, TUI mechanics, WAF encoding, HTTP API, an end-to-end trace) — read it
before non-trivial changes. The summary below is enough for orientation.

```
CLI (chat.mjs / agent.mjs / list.mjs)
  │  HTTP, OpenAI-compatible, to 127.0.0.1:8787
  ▼
bridge/server.mjs ── SSE /ext/events: jobs out ──▶ extension/background.js (service worker)
  ▲                                                   │  chrome.runtime messaging
  └── POST /ext/{chunk,done,error,loader}: results ◀──┤
                                                      ▼
                                      content.js (ISOLATED) ⇄ page.js (MAIN world)
                                                      │  fetch() as first-party page JS
                                                      ▼
                                  de.aipass.net  /actions/send-message/<id>, /chat.data, /loaders/*.data
```

**Credentials never reach the bridge.** Every authenticated request is made in
`page.js` (MAIN world of the de.aipass.net tab) with `credentials: 'include'`, so
Chrome attaches the session cookie. The bridge and CLIs only ever speak to
localhost. `background.js` holds the connection (not the content script) because
an `https://` page POSTing to `http://127.0.0.1` hits mixed-content / PNA checks;
an extension request with `host_permissions` does not.

**Job hub** (`server.mjs`): a `Job` (`jobs` Map) is dispatched over SSE to a
round-robin `extClients` member; the extension POSTs deltas/results back to
`/ext/*`, which resolve the job's promise. Kinds: `chat`,
`loader` (read-only GET of an app `.data` route), `create` (form-POST a new
conversation). The idle timeout resets on every delta, and an extension
disconnecting mid-job does **not** fail the job — the upstream fetch lives in the
page and survives MV3 worker eviction.

**The one-message constraint drives the whole design.** The endpoint rejects a
`messages` array containing an assistant turn (bare `403` from Google Frontend),
and rejects agent-style system prompts. So `lastUserText()` forwards only the
newest user message; multi-turn works solely because the server owns
conversation history. `agent.mjs` sends its `PREAMBLE` once as the first message
of a fresh conversation and then sends only tool results.

**Conversation rotation** (`resolveConversation`, `startChat`): reuse the
most-recent (or a just-created) conversation; on `404` (deleted) / `409`
(generation still running) advance to the next-most-recent — but only when no
deltas were delivered yet and `AIPASS_CONVERSATION_ID` isn't pinned.

**turbo-stream**: the app's `.data` loaders return react-router turbo-stream (a
flat indexed pool). `decodeTurboStream()` in `server.mjs` reads it;
`encodeTurboStream()` in `test/harness.mjs` builds fixtures the same way.

**`page.js` limits its own blast radius**: `runLoader` refuses any path not
matching `^/loaders/…`, and the tool set is exactly `{chat, loader, create}` —
no arbitrary-URL forwarding even if the bridge is compromised.

### agent.mjs specifics

- Actions the model emits, one per line: `NEED dir <p>`, `NEED file <p> [a-b]`,
  `SEARCH <text>`, `EDIT <p>`/`FIND`/`NEW`/`END`, `CREATE <p>`/`END`,
  `RUN`/`END` (needs `--allow-run`), `DONE <summary>`.
- **Overlay FS**: edits land in an in-memory `overlay` Map so the model can read
  back its own pending work; `--apply` flushes to disk. `safe()` confines every
  path to `--root`. `EDIT` refuses a `FIND` block that isn't unique.
- **Symmetric WAF encoding is load-bearing**: `outbound()` rewrites trigger
  tokens before anything is sent (`localhost`→`LCLHST`, tag-opening `<`→`TAG-LT`,
  `process.env`→`PROCESS-ENV`, `.env`→`DOT-ENV`, SSRF IPs, …) and `inbound()`
  restores them on everything read back — including the model's own actions — so
  bytes written to disk are exactly the file's. Keep the two lists in sync.
- **`sayResilient()`**: on a 403, halve the message and resend the halves in
  order (recursively, down to ~300 bytes); as a last resort `redact()` blanks
  individual lines matching `RISKY_LINE`. Tool results are capped at
  `--max-result` bytes for the same reason.
- `--slim` / `--assistant <id>` drop the preamble when a custom aipass assistant
  already carries the protocol; `--watch` keeps the conversation open for
  follow-up tasks.

### Tests

`test/harness.mjs` spawns the **real** bridge as a subprocess and a scriptable
`FakeExtension` that connects to `/ext/events` and answers jobs, so tests drive
the actual HTTP surface and real CLIs, not mocks. `scripted([...])` scripts the
model's replies; pass `reject` to model an upstream filter. `run()` strips SGR
color codes from captured CLI output before asserting — cursor-movement escapes
are not stripped, which is why `chat.mjs` gates all of them behind
`stdout.isTTY`.

## Gotchas

- **Don't put `node -e "…"` (or other code-execution shapes) in `package.json`
  scripts.** The agent reads `package.json` early in most tasks and such a field
  gets the whole read 403'd upstream — this is why `list.mjs` exists instead of
  inline one-liners.
- `*.har`, `aipass*.md`, `apipass*.md` are git-ignored because API captures
  contain live session cookies. Don't commit captures.
- The bridge refuses cross-origin browser callers unless `AIPASS_CORS_ORIGIN`
  names the site, and every route except `/status`/`/health` requires the
  loopback bearer token minted at `~/.aipass/.token` (printed at boot; see
  SECURITY.md). `AIPASS_REQUIRE_AUTH=0` drops that requirement — transition
  only, it logs a warning at every boot.

## Environment variables

Bridge (`bridge/server.mjs`): `AIPASS_PORT` (8787), `AIPASS_HOST` (127.0.0.1 —
any other bind exits unless `AIPASS_ALLOW_REMOTE=1`), `AIPASS_MODEL`,
`AIPASS_MODELS` (fallback list when no extension is attached),
`AIPASS_MODEL_FILTER` (`chat` | `all`), `AIPASS_TOOL_VISIBILITY` (`reasoning` |
`text` | `off`), `AIPASS_CONVERSATION_ID` (pin one), `AIPASS_IDLE_TIMEOUT_MS`
(180000), `AIPASS_ASSISTANT_ID` / `AIPASS_ASSISTANT_FIELD` (bind new
conversations to a custom assistant), `AIPASS_CORS_ORIGIN` (off by default),
`AIPASS_KEEPALIVE_MS` (15000).

Loopback auth (`harness/authtoken.mjs`): `AIPASS_TOKEN` (explicit token —
containers, tests), `AIPASS_REQUIRE_AUTH=0` (escape hatch: loopback-only, no
token; warns at every boot).

Harness and clients: `AIPASS_HOME` (state dir), `AIPASS_BRIDGE` (bridge URL),
`AIPASS_SKILLS_DIR`, `AIPASS_FETCH_ALLOW_PRIVATE` (FETCH may reach private
hosts) and `AIPASS_FETCH_MAX_BYTES`. Desktop: `AIPASS_DESKTOP_PORT` (8790),
`AIPASS_DESKTOP_NO_OPEN`.
