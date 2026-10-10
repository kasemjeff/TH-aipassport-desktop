# aipass desktop

The same AiPASS bridge and the same file agent, in a window instead of two
terminals — with the harness the terminal never had: sessions you can resume
and fork, diffs you approve per file, plan/todo tracking, helpers, and
compaction.

```
aipass desktop          # or: npm run desktop
```

That one command starts the bridge if it is not already running, starts the
backend on `http://127.0.0.1:8790`, and opens the window.

---

## The shape of it

```
desktop/main.mjs            entry: bridge + backend + window
desktop/ui/                 the window (plain HTML/CSS/JS, no build step)
aipass-bridge/harness/      the agent core, shared with `aipass agent`
  rpc.mjs                   HTTP + SSE the window talks to
  harness.mjs               the facade a CLI or the backend both drive
  loop.mjs                  the run loop
  tools.mjs overlay.mjs     the file tools and the pending-edit filesystem
  protocol.mjs waf.mjs      the marker protocol and the upstream filter dance
  permissions.mjs           ask / auto / yolo, plus path rules
  session.mjs               JSONL sessions with a tree
  compact.mjs               summarise-and-rotate when context fills
  skills.mjs                the playbook library
```

Nothing in `aipass-bridge/agent.mjs` was rewritten: it now calls the same
harness modules, so the CLI and the window cannot drift apart. The 37 CLI tests
pass unchanged, which is the proof.

## The constraint that shaped everything

The upstream de.aipass.net API accepts **one user message per request** and
keeps the conversation history itself. There is no message array to manage, no
system prompt, no native tool calls — and nothing to trim when a conversation
gets long.

So the harness works *around* it rather than pretending otherwise:

| What pi does | What this does | Why |
|---|---|---|
| manages a message array | keeps a local session log (JSONL) and replays one user message per turn | the array would be a 403 |
| compacts by dropping messages | summarises, then **rotates**: a fresh temporary conversation seeded with the summary | the server's history cannot be trimmed |
| calls a subagent on a second session | saves the conversation, runs the helper on its own, restores | the bridge holds exactly one current conversation |
| asks per tool natively | the protocol has a permission gate; writes never touch disk until approved | writes are CREATE/EDIT/DELETE/MOVE in prose |
| skills/extensions from a registry | `~/.aipass/skills`, `<project>/.aipass/skills`, then the shipped library | plain markdown, no manifest |

## The window

Left column: sessions (click to open, fork from the session menu), playbooks
(click to read), and the project's files.

Centre: the conversation. Tool calls appear as they run, reasoning collapses
into a fold, plan/todo renders as a checklist, and pending changes appear at
the bottom with per-file checkboxes and a diff view.

Header: model, permission mode, credit pool, bridge and extension status.

Keys: `Enter` sends, `Shift+Enter` is a newline, `Esc` cancels a running turn
(or closes a dialog).

## API

Everything the window does goes through one port, bound to `127.0.0.1` only —
the bridge holds a logged-in browser session, so this port is as sensitive as
the account.

```
POST /rpc     {"method":"run","params":{…}}   → {"ok":true,"result":…}
GET  /events  Server-Sent Events; every harness event arrives as `event: <name>`
```

Methods: `status`, `models`, `credits`, `conversations`, `config.set`,
`session.list|new|open|entries|fork|rename|delete`, `run`, `cancel`,
`permission.answer`, `plan.answer`, `pending`, `diff`, `apply`, `discard`,
`skills.list|index|load`, `fs.list`, `fs.read`.

Events: `task_start`, `assistant_delta`, `reasoning_delta`, `step`, `thinking`,
`tool`, `note`, `firewall_note`, `nudge`, `give_up`, `ignore_done`,
`step_limit`, `error`, `done_line`, `finished`, `todo`, `diff_update`,
`permission_request`, `plan_request`, `compacted`, `helper_start`,
`helper_end`, `applied`, `discarded`, `session`, `conversation`.

## Run it by hand

```bash
aipass desktop                                   # or: npm run desktop
node desktop/main.mjs --root /path/to/project
AIPASS_DESKTOP_PORT=8790 node desktop/main.mjs   # another port
AIPASS_DESKTOP_NO_OPEN=1 node desktop/main.mjs   # backend only, no browser
node desktop/main.mjs --detach                   # start the backend, then exit
```

`--detach` is what `npm run tauri:dev` uses: Tauri waits for its dev URL to
answer before it opens the window, so the backend has to already be running by
then. It writes to `~/.aipass/logs/desktop-backend.log`.

## The Tauri shell

`desktop/src-tauri` wraps this exact `ui/` folder in a WebView2 window. The
Rust side owns three things and nothing else: the window, the tray icon, and
the Node sidecar that runs the backend. It adopts a backend that is already
running instead of starting a second one, so `aipass desktop` in a browser and
the packaged app can be open at the same time.

Toolchain on this machine: Rust 1.99 (`D:\rust`), MSVC Build Tools (`D:\VS`),
cargo target `D:\aipass-build`. The Node sidecar is a copy of the local
`node.exe` in `desktop/sidecar/` — refresh it with `npm run desktop:sidecar`
after a Node upgrade; it is gitignored on purpose.

```powershell
npm run tauri:build      # release bundle → D:\aipass-build\target\release\bundle\nsis
npm run tauri:dev        # the app, with hot reload on the Rust side
```

## Settings

`~/.aipass/settings.json` is the one file the window, the backend and any future
surface read. The gear in the header opens it as a form; `settings.get` and
`settings.set` over `/rpc` do the same thing from a script.

What it holds: default model, write permission (`ask` / `auto` / `yolo`),
`allowRun`, `maxSteps`, plan mode (+ whether a plan waits for approval),
helpers on/off, compaction budget, playbook folders, the project list, the
current root, enabled plugins, theme.

A change made in the window is true in the terminal immediately — `aipass agent`
reads the same file — so there is no sync step and no second source of truth.

## Projects

The project selector in the header switches the root the agent works on. Each
project has its own file panel, its own sessions (sessions are stored per
directory) and its own `.aipass/skills` playbooks. `+ folder` opens another one.

`projects.switch` re-points everything in one call; the current root is
remembered in settings.json, so the packaged app opens where the last session
left off.

## Attachments

Drop an image or a file anywhere on the window, or press **attach**, and it is
staged before it is sent — the composer shows a chip per file, with the size,
and each chip can be removed. Staged files land in `~/.aipass/uploads` and
travel with the next message as a multimodal part: images go to vision models
(`image_url`), documents and video go through the bridge's file path
(`file`), capped at 20 MB like every other attachment.

They are one-shot: once a run finishes, the chips clear.

## Plugins

A plugin is one `.mjs` file in `~/.aipass/plugins` (or a folder with a
`plugin.mjs`) that default-exports `{ name, version, setup(ctx) }`. See
`desktop/plugins-example/notes.mjs` — it is the whole API in one file.

```js
setup(ctx) {
  ctx.tools.register('NOTE', handler, { description: '…' });  // a marker the model can call
  ctx.panel({ id: 'notes', title: 'scratchpad', render });     // a sidebar section
  ctx.rpc.method('plugin.notes.clear', handler);               // a /rpc method
  ctx.settings.define({ key: 'notes.file', label: '…' });      // a setting
  ctx.events.on('finished', handler);                          // watch runs
}
```

Tools the model can call arrive as `MARKER rest-of-line` — or as a block ending
in `END` when `takesBody` is true — and their result comes back exactly like a
NEED or SEARCH result. The preamble grows one paragraph listing them while a
run is in flight.

Panels are rendered across the process boundary, so a plugin returns markup
(`render: async () => ({ html })`) rather than DOM nodes. Plugins run in the
backend with the same access the harness has, including the filesystem — they
are code you chose to install, not sandboxed. Load only what you have read.


1. ~~Tauri shell~~ **done** — `desktop/src-tauri` wraps the same `ui/` folder
   in a WebView2 window with a tray icon. The Rust side owns three things and
   nothing else: the window, the tray, and the Node sidecar that runs the
   backend. Toolchain on this machine: Rust 1.99 (`D:\rust`), MSVC Build Tools
   (`D:\VS`), cargo target on `D:\aipass-build`. Build with:
   ```powershell
   cd desktop/src-tauri
   tauri build            # release; --debug for the fast loop
   ```
   The installer lands at `D:\aipass-build\target\{debug,release}\bundle\nsis\`.
2. Session tree view (`/tree`), renaming from the window, export to
   markdown/HTML.
3. Permission path rules from the window instead of code.
4. Multiple roots / a project picker: `~/.aipass/desktop.json` already carries
   the last-used root, so the picker only has to write that file.
