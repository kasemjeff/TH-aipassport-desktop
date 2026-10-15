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

Centre: the conversation, read like a harness. Your messages come back as a
prompt block — `❯` and what you typed. The assistant's prose lands in a bubble
of its own per step: marker traffic never reaches it (the protocol is wire, and
the wire is what the tool rows are for). Every tool call is one `⏺ Verb arg`
line carrying the first line of its result, opening for the detail; reasoning
folds away, plan/todo renders as a checklist, and pending changes appear at the
bottom with per-file checkboxes and a diff view. The moon in the header flips
the theme, and the choice is written through.

Header: project, model, permission mode — three controls, one thin row.

Keys: `Enter` sends, `Shift+Enter` is a newline, `Shift+Tab` cycles the mode (ask → auto → plan), `Esc` cancels a running turn
(or closes a dialog).

### `/` — every command, from the keyboard

Typing `/` in the composer opens the palette: arrows move, `Enter`/`Tab` picks,
`Esc` closes. Nothing in the app is only reachable by hunting for a button.

| command | what it does |
|---|---|
| `/help` | the guide, including everything in this table |
| `/model` `/model <id>` | pick a model, or set one by id |
| `/models` | list the models that can hold a conversation, with the current one marked |
| `/mode` `/mode ask\|auto\|yolo` | permission level, with what each one means |
| `/status` | bridge, extensions, model, credits, pending count |
| `/conversations` | switch which bridge conversation the model is remembering |
| `/fresh` | start a fresh conversation on the bridge (its memory is reset) |
| `/new` `/resume` `/fork` | window sessions: start, reopen, branch from here (rename and delete live in `/resume`) |
| `/plan` | plan mode on/off (the plan is approved before the work) |
| `/attach` | stage an image, document, or video for the next message |
| `/clip` | attach from the clipboard — or just press Ctrl+V anywhere in the window |
| `/file` `/image <path>` | attach a file by path, relative to the project or absolute |
| `/open` `/open <path>` | read a file in the project |
| `/skills` | the playbooks on disk |
| `/diff` `/apply` `/discard` | the pending-change buffer |
| `/project` | switch or remove a project folder (removing never deletes the folder) |
| `/settings` | the settings sheet |
| `/stop` | cancel the running turn — works while a run is in flight |

A command that takes an argument leaves `/cmd ` in the box instead of guessing
one.

### Context, and the rotation at 40%

de.aipass.net keeps its own conversation history and offers no way to trim it, so
"context is full" is a different problem than it is in a chat app: the only lever
is to **rotate** — ask the model to summarise what has been done, start a fresh
conversation, and re-seed it with that summary.

The header shows the budget as a percentage, and the window rotates when it
reaches **40%** (`compactAtPercent`, settable in `/settings`). Why 40 and not
"when it is nearly full": the last stretch of a long run is spent re-sending a
context that no longer fits, so rotating early buys more working room than
waiting does. A second ceiling — the budget minus the reserve — stays as the
safety net that stops a reply from being cut off.

At the rotation the summary is written into the session log and shown in the
conversation, so "it forgot everything" becomes "it carried this forward, and
here is what it chose to carry". `/compact` runs the same path on demand.

### The settings sheet

`/settings` (or the gear) opens a grouped sheet: chat and model, context, the
window, playbooks, and plugins. Edits are **staged** and Save applies them, with
validation that names the problem instead of writing a bad number (a step limit
of zero, a budget under its reserve, a chat URL without a scheme). The context
section carries a live meter, and the theme is applied the moment it is picked.
`คืนค่าเดิม` resets everything except the project you are working in.

### The two kinds of "conversation"

They are different things on purpose, and mixing them up is the easiest way to
get lost:

- **bridge conversation** (`/conversations`, `/fresh`) — the model's memory,
  held by de.aipass.net. One per browser tab, and it cannot be trimmed, so
  switching is the only way to start clean.
- **window session** (`/new`, `/resume`, `/fork`) — the local transcript on
  disk, tied to the project folder. Opening an old session re-reads what was
  said; the bridge conversation it used is whatever the bridge is on now.

### The panels

- **บทสนทนา** — newest first, each row showing when it was last touched, with a
  filter box that matches title or id (99 sessions on the machine this was
  written on: a list nobody can filter is a list nobody uses). Rename and delete
  live in `/resume`.
- **ไฟล์ในโปรเจกต์** — walks into folders, names the directory it is in, and
  every file row carries a *แนบ* button so a file can be attached without a
  picker. Switching a project returns it to that project's root.
- **คู่มือ / ปลั๊กอิน** — playbooks from disk, and the panels plugins render.

### When a run ends badly

Three dead ends used to be silent: the step limit, a backend that disappears
mid-run, and a tab that was never opened. All three now name what happened and
offer the next move — *ให้ทำต่อ* after a step limit, a notice after 20 seconds of
silence from a run in flight, and a banner with *เปิดให้* when no logged-in tab
is open. The conversation follows you only while you are already at the bottom,
so scrolling up to read something is safe, and a half-typed message survives a
reload.

A reload survives the run too: the stream resumes from the last frame the
window saw and the session is read back from disk, so the window comes back
holding the conversation instead of a blank page over a run that never
stopped. (The wiring is under "Reloads and reconnects" in the API section.)

## Checking it still works

```bash
npm test          # the suite: 200+ tests, no browser needed
npm run qa        # one QA pass: static wiring, suite, window logic, live backend
```

`npm run qa` is the loop that produced most of the fixes here. It checks that
every RPC method the window calls exists on the backend, that the user-facing
files are intact UTF-8 (a mangled Thai label is a bug, not a cosmetic one), that
the suite passes, that the window's palette, commands, paste and settings still
fire when driven in a fake DOM, and what the running backend reports. It exits
non-zero on the first failure, so it can be wired into anything that watches an
exit code.

## Who starts what

The window's shell starts the backend (`rpc.mjs`). The backend starts the bridge
if nothing is listening on 8787 — because the packaged shell spawns the backend
directly, `main.mjs` never runs there, and a window with no bridge accepts every
message and answers nothing. Both entry points now find each other by looking for
`aipass-bridge/` next to themselves (installed layout) or one level up (repo
layout), rather than assuming either.

The numbers that govern a run are clamped where they are written:
`maxSteps: 0` makes the loop exit before its first step, which reads as "it
ignores me" with no error anywhere, so it is clamped to 1 rather than stored. The
same goes for the compaction budget, the reserve, the rotation share, and the
chat URL's scheme. A hand-edited `settings.json` is clamped as it is read.

## API

Everything the window does goes through one port, bound to `127.0.0.1` only —
the bridge holds a logged-in browser session, so this port is as sensitive as
the account.

```
POST /rpc     {"method":"run","params":{…}}   → {"ok":true,"result":…}
GET  /events  Server-Sent Events; every harness event arrives as `event: <name>`
```

**Local means local.** Any page in a browser can `fetch()` localhost, and the
methods here drive an agent that writes files, so every request — including
the static UI files — has to prove it came from this machine rather than from
the open web: a loopback `Host` (the one header a DNS-rebinding attack cannot
fake), plus a same-origin `Sec-Fetch-Site` / `Origin` when the request comes
from a browser. Plain tools send neither and pass untouched.
`AIPASS_ALLOW_REMOTE=1` opts out for someone deliberately proxying the port.

Methods: `status`, `models`, `credits`, `conversations`, `config.set`,
`conversations.list`, `conversation.new`, `conversation.pin`,
`session.list|new|open|entries|fork|rename|delete`, `run`, `cancel`,
`permission.answer`, `plan.answer`, `pending`, `diff`, `apply`, `discard`,
`skills.list|index|load`, `fs.list`, `fs.read`,
`attachment.stage|list|remove`, `plugins.list|reload`, `panel.render`,
`projects.list|add|remove|switch`, `settings.get|set`, `rules.get|set`,
`browser.open`, `snapshot`.

`snapshot` is the one call that rebuilds a window's view — status, the open
session and its entries, what is pending, the context meter — which is what a
window that reloaded mid-run reads before it looks alive again.

`rules.get` / `rules.set` are the path rules the permission engine has always
honoured, finally reachable without editing code: `docs/** → allow` stops a run
asking about its own docs, `.env* → deny` keeps secrets out of every mode
including yolo. First match wins, rules outrank the mode, and the same list is
read by `aipass agent` from the same settings file — the window is not a second
policy engine, it is a second door onto one.

Only one `run` per project at a time: a second is refused with *a run is
already in flight* rather than overwriting the first's stop button. A run that
fails on the way in (no bridge, a session that will not open) unlocks the
project again instead of leaving it stuck.

`fs.read` and `fs.list` are confined to the project root. `attachment.stage`
deliberately is not: `/file ~/Downloads/report.pdf` has to be able to reach
outside the project the same way the CLI's `/file` does, so the port can read
any file the signed-in user can. That is the same trust boundary as the rest of
the CLI — it is also why the port is bound to `127.0.0.1` only.

Events: `task_start`, `assistant_delta`, `reasoning_delta`, `step`, `thinking`,
`tool`, `note`, `firewall_note`, `nudge`, `give_up`, `ignore_done`,
`step_limit`, `error`, `done_line`, `finished`, `todo`, `diff_update`,
`permission_request`, `plan_request`, `compacted`, `helper_start`,
`helper_end`, `applied`, `discarded`, `session`, `conversation`.

### Reloads and reconnects

Every event frame carries a monotonic `seq`, both as `id:` and inside the
JSON, and the backend keeps the last 500. A window that reconnects — or
reloads — resumes from where it was: a browser `EventSource` reconnect sends
`Last-Event-ID`, and the backend replays exactly the frames that listener
missed, once, in order, before the live stream continues. The session log on
disk covers the rest, via `snapshot`: a window reloaded mid-run comes back
holding its conversation instead of a blank page over a run that is still
going.

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

Closing the window hides it — the tray keeps the backend (and a run in
flight) alive, and the tray menu's **ออก** is what quits for real. A run
should not die because someone tidied their taskbar by reflex.

## Platforms

The bridge, the harness, and the desktop window are the same `.mjs` files on
every machine; what differs is the shell around them.

| | Windows | macOS | Linux |
|---|---|---|---|
| Backend + bridge | `node` on PATH, or the bundled sidecar | same | same |
| Packaged window | NSIS (default `tauri:build`) | `npm run tauri:build:mac` (app + dmg) | `npm run tauri:build:linux` (deb + appimage) |
| Sidecar fetch | `npm run desktop:sidecar` — one script, per-platform name | same | same |
| Quitting the app | `taskkill /T` the backend it started | `kill -TERM` the child's process group | same as macOS |

macOS and Linux builds are wired and compile per-branch, but the verified end
to end on this machine is the Windows one: the packaged app has been run and
quit there, and the tray behaviour was exercised by hand. Treat the other two
as ready-to-try, not as ready-to-ship, until somebody runs them and says so.

Toolchain on this machine: Rust 1.99 (`D:\rust`), MSVC Build Tools (`D:\VS`),
cargo target `D:\aipass-build`. The Node sidecar is a copy of the local
`node` binary in `desktop/sidecar/` — refresh it with
`npm run desktop:sidecar` after a Node upgrade; it is gitignored on purpose.

```powershell
npm run tauri:build      # release bundle → D:\aipass-build\target\release\bundle\nsis
npm run tauri:dev        # the app, with hot reload on the Rust side
```

## Settings

`~/.aipass/settings.json` is the one file the window, the backend and any future
surface read. The gear in the header opens it as a form; `settings.get` and
`settings.set` over `/rpc` do the same thing from a script.

What it holds: default model (+ the **thinking level** the model reasons at
before each step — it streams into a fold labeled `✻ reasoning…` and closes when
the turn ends, and only models that advertise thinking levels honour it), write
permission (`ask` / `auto` / `yolo`), `allowRun`, `maxSteps`, plan mode (+
whether a plan waits for approval), helpers on/off, the compaction budget
(**budget**, **reserve**, and the share at which it rotates —
`compactAtPercent`, 40 by default), playbook folders, the project list, the
current root, enabled plugins, theme, the chat tab URL and whether a run that
needs one opens it.

The sheet validates before it writes, and `settings.reset` returns everything to
the shipped defaults while keeping the project you are in.

The **กฎไฟล์** page is the permission engine's path rules, editable: a pattern,
a verdict, and which kind of action it covers. Type a path into the tester and
it tells you which rule catches it, with the same glob the gate uses — a rule
you cannot test is a rule you guess at. An empty pattern or a duplicate is
refused at Save rather than stored where it would look like protection.

Every setting applies the moment Save is pressed — not just the file, the
running process: the ones that govern a run (`maxSteps`, plan,
`requirePlanApproval`, helpers, thinking, model, mode, the compaction knobs) move the
live harness, `skillsDirs` rebuilds the playbook library, the plugin list
reloads the plugins by name, and a new root switches project outright. The
sheet has one contract instead of a footnote saying "restart for these two".

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

What was actually loaded is recorded, not assumed: `plugins.list` reports each
plugin with its content hash, size and mtime, so "did that plugin change
since it last behaved?" is an answerable question instead of a re-read of
every file by hand.


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
3. ~~Permission path rules from the window instead of code~~ **done** — the
   rules page in the settings sheet, `rules.get|set` on the RPC, and the same
   list honoured by `aipass agent` from the same settings file.
4. Multiple roots / a project picker: `~/.aipass/desktop.json` already carries
   the last-used root, so the picker only has to write that file.
