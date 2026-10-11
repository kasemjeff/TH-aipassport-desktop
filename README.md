# aipass desktop

**AiPASS in a window — the bridge, the chat, and a file agent with a harness.**

[aipass](https://aipass.go.th/) is Thailand's free gateway to 30+ pro AI
models, and it only speaks one language: a chat box in a browser. This puts it
in a desktop app and lets it read and write your project — with the machinery a
coding agent needs and the browser cannot give you: sessions, per-file
approval, plan mode, helpers, compaction, plugins, projects and attachments.

```
┌──────────────┐   localhost:8790    ┌──────────────┐   localhost:8787   ┌───────────────┐
│ the window   │ ──────────────────▶ │ the backend  │ ─────────────────▶ │ the bridge    │
│ (WebView2)   │ ◀──── SSE ───────── │ (Node)       │                    │ + your Chrome │
└──────────────┘                    └──────────────┘                    └───────────────┘
```

No credential ever leaves the browser. The real request runs as ordinary page
JavaScript inside your own logged-in tab, so Chrome attaches the session cookie
itself — the bridge never sees it and nothing is written to disk.

---

## Quick start

```powershell
npm run desktop          # starts the bridge if needed, then opens the window
```

One command, one window. If the bridge is already running (`npm run dev`), it is
adopted instead of started again.

```powershell
npm run tauri:build      # the packaged installer (needs Rust + MSVC — see below)
npm test                 # the full suite (parallel, under a minute)
npm run verify           # the suite + a sandboxed live smoke — see below
```

## Development & verification

```powershell
npm test          # the full test suite — parallel, reliable; extra args pass
                  # through: npm test -- --test-name-pattern="compaction"
npm run verify    # the standing "is everything still working" check
```

`npm run verify` runs up to three stages and exits nonzero if any fails:

- **tests** — the full suite, exactly `npm test`.
- **smoke** — starts the real bridge and the real backend from this source
  tree on free ports (8792+) with a throwaway `HOME`/`USERPROFILE`, then
  checks `/health`, `/status`, `/v1/models`, the backend RPC handshake and
  the served window HTML + an asset, and shuts everything down again. It
  never touches a live aipass stack: ports 8787 and 8790 are refused, and
  inherited `AIPASS_*` environment is stripped. Nothing is written outside a
  temp dir. `--bridge-port N` / `--backend-port N` pin the sandbox ports
  (used as given, so a pinned-but-occupied port fails loudly).
- **chat** — only with `--chat`: one tiny real chat through the sandbox
  bridge, but only when a Chrome extension is connected to *it*. Normally
  none is — your extension talks to the live bridge on 8787 — so verify
  prints **PENDING-LOGIN** and skips the stage; that is not a failure. To
  exercise the chat path, point the extension at the sandbox bridge
  (`AIPASS_BRIDGE=http://127.0.0.1:<port>`) and log in to a de.aipass.net tab.

Node ≥ 20 works everywhere; development happens on Node 24
(`scripts/test.mjs` exists because the three supported versions disagree on
glob and directory handling for `node --test`).

## What you get

| | |
|---|---|
| **chat** | streaming, model picker, credit meter, conversation switching |
| **file agent** | reads, searches, globs, git, fetches URLs, searches the web — then edits |
| **approval** | every write is a diff you can tick file by file before it touches disk |
| **plan mode** | the model writes a PLAN/TODO first; optionally waits for your go-ahead |
| **helpers** | it can hand a self-contained piece to a helper working beside it |
| **compaction** | when context fills, it summarises and rotates to a fresh conversation |
| **playbooks** | a skill library it loads on demand, per project |
| **attachments** | drop an image, a document or a video onto the window |
| **projects** | switch the root it works on; each has its own sessions and playbooks |
| **plugins** | ~/.aipass/plugins — tools the model can call, panels, settings, RPC methods |
| **sessions** | JSONL on disk: resume, fork, export — and the CLI reads the same file |

## The constraint that shaped the design

The upstream API accepts **one user message per request** and keeps the
conversation history itself. No message array, no system prompt, no native tool
calls, and nothing to trim when a conversation grows long. Everything here
works with that rather than pretending otherwise:

| what a native harness does | what this does |
|---|---|
| manages a message array | replays one user message per turn, and logs the shape locally |
| compacts by dropping messages | summarises, then **rotates** to a fresh temporary conversation |
| runs a subagent on a second session | saves the conversation, runs the helper, restores it |
| declares tools in JSON | prose markers (`NEED`, `SEARCH`, `EDIT`, …) that survive the upstream filter |

The marker protocol, the filter dance and the pending-edit filesystem are all in
[`aipass-bridge/harness`](aipass-bridge/harness) — the same code the CLI runs, so
the window and the terminal can never drift apart.

## Layout

```
desktop/
  main.mjs              entry: bridge + backend + window
  ui/                   the window — plain HTML/CSS/JS, no build step
  src-tauri/            the Rust shell: window, tray, Node sidecar
  plugins-example/      one plugin that shows the whole API
aipass-bridge/
  bridge/server.mjs     the local OpenAI-compatible bridge (:8787)
  harness/              the agent core, shared with the CLI
  test/                 the suite: CLI behaviour, the bridge, the desktop backend
```

## Toolchain

- Node ≥ 20 (the backend is zero-dependency .mjs)
- Chrome with the extension loaded and a tab on the chat page, for live calls
- Rust + MSVC, only for the packaged window: `npm run desktop:sidecar` copies
  Node into `desktop/sidecar/` so the app ships its own runtime

## Docs

- [`desktop/README.md`](desktop/README.md) — the window, the API, the settings,
  projects, attachments and plugins
- [`aipass-bridge/README.md`](aipass-bridge/README.md) — the bridge and the CLIs
- [`aipass-bridge/docs/DOCS.md`](aipass-bridge/docs) — how the bridge works
  internally

## Licence

MIT.
