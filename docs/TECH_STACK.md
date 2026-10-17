# Tech stack

Why aipass desktop is built the way it is — the layer, the choice, and the
alternatives that were rejected. For what the app does, see the
[README](../README.md); for how each piece works, see
[`desktop/README.md`](../desktop/README.md) and
[`aipass-bridge/README.md`](../aipass-bridge/README.md).

```
┌──────────────┐   localhost:8790    ┌──────────────┐   localhost:8787   ┌───────────────┐
│ the window   │ ──────────────────▶ │ the backend  │ ─────────────────▶ │ the bridge    │
│ (WebView2)   │ ◀──── SSE ───────── │ (Node)       │                    │ + your Chrome │
└──────────────┘                    └──────────────┘                    └───────────────┘
```

Four programs, none of which share a runtime:

| program | runtime | owns |
|---|---|---|
| the window | WebView2, in a Tauri 2 shell | pixels only |
| the backend | Node ≥ 20 sidecar (`desktop/main.mjs`) | `/rpc` + `/events`, sessions, the harness |
| the bridge | Node ≥ 20 (`aipass-bridge/bridge/server.mjs`) | an OpenAI-compatible API on 8787 |
| the relay | Chrome MV3 extension | the actual request, inside your logged-in tab |

## The four constraints that chose everything

1. **No credential may ever leave the browser.** The whole product exists
   because you are logged into de.aipass.net in Chrome. Any design where a
   server component holds a session cookie is a design that stores your
   account on disk. So the real request must run as page JavaScript inside
   your own tab, where Chrome attaches the cookie itself — which is why the
   "backend" is a Chrome extension, not a headless client.
2. **The window and the terminal must never drift apart.** `aipass agent`
   already worked. If the desktop app reimplemented the agent, every fix
   would have to land twice. So the harness lives in `aipass-bridge/harness/`
   as plain `.mjs` modules, and both front ends call the same code. The Rust
   side is deliberately thin for the same reason: it owns the window, the
   tray and the Node sidecar, and nothing else.
3. **Windows-first, but the logic stays portable.** The user runs Windows;
   the packaging (NSIS, WebView2 offline installer, sidecar fetch script) is
   Windows-specific. Everything under `aipass-bridge/` is plain Node that
   also runs on macOS and Linux, because the bridge predates the window and
   should outlive any one shell.
4. **Nothing to build, nothing to install.** The upstream API is a moving
   target — model ids rotate, the WAF reshapes requests, tool activity
   arrives as `reasoning_content`. A project that spends its first hour
   after each upstream change fixing a build pipeline loses to one where the
   fix is "edit the `.mjs`, restart". So: zero npm dependencies, no bundler,
   no TypeScript compile step, tests from Node's own runner.

## The stack, layer by layer

| layer | choice | why | rejected |
|---|---|---|---|
| window shell | **Tauri 2** (Rust ≥ 1.77) | ~3 MB binary, uses the OS webview, tray + sidecar support built in; the Rust is ~a page of code | Electron (ships a whole Chromium for a page of HTML; ~10× the installer for zero benefit — the heavy part of this app is Node, which we ship anyway) |
| webview | **WebView2** (offline installer) | guaranteed present on Windows 10/11 via the installer; Evergreen updates come from the OS | CEF (another Chromium to ship), Firefox/Gecko (no Windows guarantee) |
| backend | **Node ≥ 20, zero npm deps** | the CLI is the same code; `node:http`, SSE, `node:crypto` and `fetch` cover every need; nothing to audit, nothing to break | Express/Fastify (a dependency for a router we don't need — the surface is two endpoints), Bun/Deno (the bridge predates them and the sidecar fetch story is Node's) |
| wire protocol | **POST `/rpc` + GET `/events` (SSE)** | one request/response channel for commands, one push channel for streams; SSE needs no client library and survives WebView2 | WebSockets (a second protocol to implement on both sides for no capability we use — the window never talks to the bridge directly), Tauri IPC commands (would weld the harness to the shell and break `npm run desktop` in a plain browser) |
| UI | **vanilla HTML/CSS/JS, no build step** | the served files are the source files; a fix is a reload; 743 lines of `app.js` so far, well under the weight where a framework pays rent | React/Vue/Svelte (a node_modules tree, a bundler, and a source/served split — all three violate constraint 4 for a single-window app) |
| agent core | **shared harness modules** (`loop`, `tools`, `permissions`, `session`, `compact`, `skills`, `protocol`, `waf`) | constraint 2; the CLI tests (37) passing unchanged is the proof of the split | reimplementing in the backend (drift), porting to Rust (rewrites the working agent for no user-visible gain) |
| agent–model protocol | **text markers in the message stream** (`protocol.mjs`) + a WAF-adaptation layer (`waf.mjs`) | the upstream offers no native tool calls and rejects system prompts and multi-message transcripts; markers ride the one channel that works, and `waf.mjs` is the single place that knows the filter's moods | native function-calling (does not exist upstream), a WebSocket to the page (the extension's SSE path already works and keeps credentials in the tab) |
| sessions | **JSONL files with a tree** (`session.mjs`) | append-only, human-readable, diffable, forkable by copying lines; no daemon to corrupt them | SQLite (a native dep and a format you can't read in an editor, for queries we never run), a database server (absurd at this scale) |
| compaction | **summarise, then rotate to a fresh conversation** | the upstream owns history and it cannot be trimmed — rotation is the only move the API allows | dropping old messages (there is no local array to drop; the server remembers everything anyway) |
| skills | **plain markdown, no manifest** (`skills.mjs`) | editable in any editor, loadable from `~/.aipass/skills` or `<project>/.aipass/skills`; the format *is* the file | JSON/YAML skill registries (a schema to maintain for prose), a package manager (constraint 4) |
| permissions | **ask / auto / yolo + path rules**, pending-edit overlay (`overlay.mjs`) | every write is a diff until approved; the overlay means "approved" is the only path to disk | containerisation/VM (orders of magnitude heavier; the threat model is a model writing files, not escaping a sandbox) |
| relay | **Chrome MV3 extension** (service worker + offscreen document + content scripts) | the only legitimate place the session cookie exists; `chrome.runtime` messaging to the bridge over SSE | Playwright/Puppeteer driving a browser (automating a logged-in account with a tool built for testing it is brittle, detects poorly, and still ends up handling the session), direct HTTP with a copied cookie (violates constraint 1 outright) |
| packaging | **NSIS + Node sidecar** (`externalBin`), WebView2 offline install | one installer; the Node runtime ships inside it so users don't install Node | MSI (no gain at this size), asking users to install Node (the product is "one command") |
| tests | **`node --test`** via a portable wrapper (`scripts/test.mjs`) | built in, zero deps, discovers `*.test.mjs` automatically; the wrapper exists because glob expansion differs across Node 20/21+/Windows shells | Jest/Vitest (a devDependency tree and a config file to run 50 tests that finish in seconds) |

## Known costs

Saying the quiet parts out loud, since a stack is a set of tradeoffs:

- **Vanilla JS has a ceiling.** 743 lines in `app.js` is fine; 3,000 would
  not be. The escape hatch (JSDoc types + `tsc --checkJs`, then esbuild if a
  bundler ever earns its keep) costs an afternoon and violates nothing.
- **The sidecar must match the platform.** `fetch-node.ps1` pins a Node
  build per release; a macOS/Linux port needs the same for each target.
- **The relay's reliability is Chrome's mood.** An extension page can be
  discarded, an update can reload the tab. The bridge surfaces this
  (`extension: 0 connected`) rather than hiding it, but it is the least
  owned link in the chain.
- **No auto-update yet.** NSIS installs; it does not update. Tauri's
  updater plugin is the planned path once there is a release channel.
- **Upstream coupling is total.** Model ids, the WAF and the marker
  protocol all exist at the pleasure of de.aipass.net. The mitigation is
  containment — `waf.mjs` and `protocol.mjs` are the only modules allowed
  to know — not abstraction; there is nothing else to abstract to.

## Single points of failure

Every graph has cut points; these are this one's, named with what happens
when they are cut:

- **The signed-in Chrome tab.** No tab, no upstream call: a run pauses with
  `needs_tab` and the bridge says `extension: 0 connected`. Nothing is lost —
  reconnect and the run continues. The extension popup and `npm run doctor`
  are the two places that say so.
- **The backend process.** One Node process owns the run loop. The desktop
  shell supervises it — a crash is logged as `[supervisor]` lines and
  restarted, and the window redials; an in-flight run is the one thing a
  restart costs, and the transcript reads as a pause, not a loss.
- **`~/.aipass` (the whole store).** Settings, sessions, uploads, token and
  logs live in one folder; a dead disk loses the lot. That is the honest
  trade for "your directory, no server" (`docs/DATA_FORMATS.md` says how to
  be done with it — and to back it up, copy the folder).
- **One run per project.** The harness refuses a second concurrent run
  ("a run is already in flight — cancel it first"); parallel work means a
  second window on another project, not a queue inside one.
- **One upstream account.** Credits, rate limits and terms are the account's
  and are shared by every window and CLI on the machine. There is no
  automatic fallback model: the model is chosen explicitly per surface, and
  `AIPASS_MODELS` only fills the listing when no tab is attached — a model
  swap is an audited change (`docs/SPEC_EVALS.md`).

The tightest coupling is deliberate: `protocol.mjs` (markers) and the event
stream (`docs/LOOP_DESIGN.md`) are the two contracts every surface shares,
so changing either is a cross-cutting change on purpose — `npm run qa` walks
the whole wire.

## What would change the stack

| trigger | change |
|---|---|
| `app.js` passes ~2,000 lines or two people edit the UI in parallel | JSDoc types + `tsc --checkJs` first; a bundler only if the type check is not enough |
| macOS/Linux users show up | cross-compile targets in `tauri.conf.json` + per-platform sidecar fetch; the harness needs nothing |
| a real release channel exists | `tauri-plugin-updater` with signed artifacts |
| the upstream ever offers native tool calls / system prompts | `protocol.mjs` and `waf.mjs` shrink or vanish; the harness gets simpler, not different |
| sessions grow past "a folder of JSONL" | the format was chosen to be importable; SQLite at that point, not before |
