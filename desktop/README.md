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
harness modules, so the CLI and the window cannot drift apart. The CLI's own
tests (`aipass-bridge/test/agent.test.mjs`, 58 of them) pass unchanged, which
is the proof.

## The constraint that shaped everything

The upstream de.aipass.net API accepts **one user message per request** and
keeps the conversation history itself. There is no message array to manage, no
system prompt, no native tool calls — and nothing to trim when a conversation
gets long.

So the harness works *around* it rather than pretending otherwise:

| The constraint | How this works | Why |
|---|---|---|
| the upstream owns the conversation | keeps a local session log (JSONL) and replays one user message per turn | a `messages` array with an assistant turn is a 403 |
| the upstream cannot be trimmed | summarises, then **rotates**: a fresh temporary conversation seeded with the summary | the server's history cannot be trimmed |
| the bridge holds one conversation | saves the conversation, runs the helper on its own, restores | a second session would clobber the current one |
| there are no native tool calls | the protocol has a permission gate; writes never touch disk until approved | writes are CREATE/EDIT/DELETE/MOVE in prose |
| playbooks and extensions | the folders named in `skillsDirs`, then `<project>/.aipass/skills`, `~/.aipass/skills`, then the shipped library | plain markdown, no manifest — and the same order the terminal uses |

The session log borrows its JSONL-per-session, tree-of-entries shape from the pi
coding agent; everything else above is our own design. (Influence, not code.)

## The window

Left column: the work. **แชทใหม่** starts a conversation, the search field
filters the history under it, the history opens a session, and the project's
files sit below that. The foot of the column holds **ตั้งค่า** and **วิธีใช้** —
the two doors to the rest of the app, written out instead of left as a 15px
gear in the header. Everything that *configures* the app — the model, the rules,
the plugins, the MCP servers, what the app remembers about you — lives in the
settings sheet, one click from the foot of this column. The playbooks and the
panels the plugins draw went the same way: they were two folded headings in
this column, and a heading you have to click to find out what it holds is a
row that leads nowhere.

Centre: the conversation, read like a harness. Your messages come back as a
prompt block — `❯` and what you typed. The assistant's prose lands in a bubble
of its own per step: marker traffic never reaches it (the protocol is wire, and
the wire is what the tool rows are for). Every tool call is one `⏺ Verb arg`
line carrying the first line of its result, opening for the detail; reasoning
folds away, and plan/todo renders as a checklist — bounded and scrollable,
headed with a `done/total` count that turns green when everything is ticked;
a run that ends done with items still open names them and offers the one-click
carry-on. Pending changes appear at the bottom with per-file checkboxes and a
diff view. The transcript itself is bounded: the oldest rows are dropped after
300 and a line says how many went — the rows are the VIEW, and the record is
the session file on disk, which still holds everything. When a run ends with an
answer, its working trail folds into one `✻ ระหว่างทำงาน` line and the closing
bubble is labelled **ผลลัพธ์**; a run that stopped short (step limit, error,
stall) keeps the whole trail open, and a row with a button on it — carry on,
open the chat tab — is never folded away. The moon in the header flips
the theme, and the choice is written through.

The thin top row carries the project and the connection state; the controls
that govern the next message live where the message is written — the composer's
chip row holds the **mode** (โหมดการทำงาน: ask / auto / yolo / plan), the
provider, the model and the effort level, in that order. Temperature is not
there on purpose: it is a rarely-touched model parameter, and it lives in the
settings sheet (คุยกับโมเดล → temperature). One surface per control — the sheet
no longer carries its own copy of the mode, so the two cannot drift apart.

Keys: `Enter` sends, `Shift+Enter` is a newline, `Shift+Tab` cycles the mode (ask → auto → plan), `Esc` cancels a running turn
(or closes a dialog), `Ctrl+K` goes to the sidebar's search.

**The Apply leaves an undo.** Before the Apply writes to the disk, the files
it is about to change are snapshotted — outside the project, under
`~/.aipass/run/checkpoints/`, so a copy of your source never sits in the
tree — and the answer to the apply carries the checkpoint's id. A restore
puts the old bytes back exactly and removes a file that did not exist
before, so an approved change can be taken back without git. What it is
not: a general undo — it undoes one apply, and only the files that apply
touched. The pending panel carries the list, and `/checkpoints` opens the
whole one with a **ย้อนกลับ** (restore) and a **ลบ** (forget) button per
checkpoint.

### `/` — every command, from the keyboard

Typing `/` in the composer opens the palette: arrows move, `Enter`/`Tab` picks,
`Esc` closes. Nothing in the app is only reachable by hunting for a button.

| command | what it does |
|---|---|
| `/help` | the guide, including everything in this table |
| `/model` `/model <id>` | pick a model, or set one by id |
| `/provider` `/provider <id>` | switch who answers the run — AiPASS or an added API provider |
| `/models` | list the models that can hold a conversation, with the current one marked |
| `/mode` `/mode ask\|auto\|yolo\|plan` | the work mode, with what each one means |
| `/status` | bridge, extensions, model, credits, pending count |
| `/paint` | the paint cache's hit/miss counters — how often a frame re-rendered instead of appending |
| `/conversations` | switch which bridge conversation the model is remembering |
| `/fresh` | start a fresh conversation on the bridge (its memory is reset) |
| `/compact` | rotate now: summarise what has been done and seed a fresh conversation with it |
| `/new` `/resume` `/fork` | window sessions: start, reopen, branch from here (rename and delete live in `/resume`) |
| `/plan` | plan mode on/off (the plan is approved before the work) |
| `/attach` | stage an image, document, or video for the next message |
| `/clip` | attach from the clipboard — or just press Ctrl+V anywhere in the window |
| `/file` `/image <path>` | attach a file by path, relative to the project or absolute |
| `/open` `/open <path>` | read a file in the project |
| `/skills` | the playbooks on disk |
| `/memory` | the facts the app carries between sessions (`/memory clear` forgets them) — the same list as the sheet's page |
| `/mcp` | the MCP servers and the tools they offer (they are managed in the sheet's 🔌 MCP page) |
| `/symbols <file>\|<name>` | the code-navigation index: what a file declares, or where a name is defined and used — the same index the `SYMBOLS`/`DEF`/`REFS` markers use, asked from the window |
| `/diff` `/apply` `/discard` | the pending-change buffer |
| `/checkpoints` | the undo of an apply: what was written, when, and the button that puts the old bytes back |
| `/tree` | the sessions of this project, grouped by the day they belong to |
| `/export` | keep the open session as markdown or as one self-contained HTML page |
| `/git` | the repository's state — staged, unstaged, untracked (the buttons are on the sheet's git page) |
| `/media` | the media models of the live catalog (the page that makes one is on the sheet) |
| `/schedule` | the tasks this machine runs at a time of day (the page that adds one is on the sheet) |
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

`/settings` (or the gear, or **ตั้งค่า** at the foot of the rail) opens a
grouped sheet: chat and model, context, what the app remembers between
sessions, the window, playbooks, the file rules, the health check, plugins and
MCP. Edits are **staged** and Save applies them, with validation that names
the problem instead of writing a bad number (a step limit of zero, a budget
under its reserve, a chat URL without a scheme). The context section carries a
live meter, and the theme is applied the moment it is picked. `คืนค่าเดิม`
resets everything except the project you are working in.

The **ความจำข้ามเซสชัน** page is where the facts the app carries between
sessions are listed, with the button that makes it forget them. It used to be a
row folded away in the rail, under a heading nobody could place — the one thing
you want to find when you ask "what does this app remember about me?" is where
you look when you ask what an app is doing.

Three pages of the sheet are not settings at all — they act on the machine,
and they live beside the page that says what the machine may do:

- **git** — the repository's state (staged, unstaged, untracked), a stage
  button per file and one for the files you ticked in the pending panel, a
  commit with a message, and a branch to create. These are the HUMAN's
  calls: they never consult the model's permission mode, because a person
  clicking a button is the consent. The commit asks once, because a commit
  lands in the repository's history and no button here undoes that.
- **สร้างสื่อ** — a picture, a clip or a song from the media models of the
  live catalog. Only the options the chosen model accepts are on screen
  (the backend drops the rest — an option a model does not declare is
  refused upstream, once the credits are gone), and the answer names the
  file it wrote and what was dropped. The file lands in `~/.aipass/media/`,
  outside the project.
- **ตารางเวลา** — the tasks this machine runs at a time of day: what to do,
  at what local time, every day or once. The backend ticks nothing by
  itself; the window asks it to run what is due (once a minute, on the
  header's own poll), and the page has the button for it too. A task needs
  the bridge and a logged-in tab — it is a run like any other.

### The providers

The picker next to the model one says **who answers the run**. AiPASS is the
built-in provider — the local bridge and the tab you are signed in to — and it
stays the default. The **ผู้ให้บริการ** page in the settings sheet adds
another: an OpenAI-compatible endpoint (OpenAI, OpenRouter, Groq, Together,
Ollama, vLLM — anything that speaks `/v1/chat/completions`) or Anthropic's own
Messages API.

```
id            a safe word: openai, my-gateway, ollama
label         what the window shows
kind          openai | anthropic
base url      https://api.openai.com/v1  ·  http://localhost:11434/v1
env var       OPENAI_API_KEY — the environment answers first, the file is the fallback
models        comma separated, or leave it empty and the provider is asked at run time
api key       written once, to ~/.aipass/credentials.json (owner-only)
deadline      modelsTimeoutMs — how long the provider gets to answer with its model
              list (default 10 s, or AIPASS_PROVIDER_MODELS_TIMEOUT_MS for the
              machine); a provider that never answers must not hang a run
```

A key is never put in `settings.json` — that file is shared by every surface
and holds no secret. The environment variable wins over the stored key, so a
shell that exports the key never has it written down at all.

The switch is machine-wide, not a per-window thing: it lands in the settings
file, so the terminal sees it too (`aipass providers use openai`, or
`agent.mjs --provider openai` for one run). Two things change with it — the
model list is rebuilt, because a model of one provider means nothing to
another, and the AiPASS firewall no longer applies: the text another provider
receives is exactly the text on your disk, not the encoded copy the site's
edge needs.

### The two kinds of "conversation"

They are different things on purpose, and mixing them up is the easiest way to
get lost:

- **bridge conversation** (`/conversations`, `/fresh`) — the model's memory,
  held by de.aipass.net. One per browser tab, and it cannot be trimmed, so
  switching is the only way to start clean.
- **window session** (`/new`, `/resume`, `/fork`) — the local transcript on
  disk, tied to the project folder. Each session owns the bridge conversation
  it worked in, recorded in its file: reopening it reattaches to that
  conversation when the site still holds it (a warm resume), and when it does
  not — an expired temporary, a fresh machine — the new conversation is
  seeded with a digest of the session's own transcript (its tasks, the
  model's last words, the open checklist, the facts carried between
  sessions), so the work continues instead of restarting blind. `/new` and
  `/resume` never continue in another session's conversation; `/fork` starts
  a branch with its own.

### The panels

The rail on the left is the work, and each of its lists scrolls in its own box
so one long list cannot push the others out of the column.

- **ประวัติการสนทนา** — newest first, each row showing when it was last
  touched, with the search field above it matching title or id (99 sessions on
  the machine this was written on: a list nobody can filter is a list nobody
  uses). The header counts them; when there are more than forty, a one-click
  **เก็บ 24+ บทสนทนาเก่า** moves the quiet ones to `archive/` (nothing is
  deleted). Rename and delete live in `/resume`.
- **ไฟล์ในโปรเจกต์** — walks into folders, names the directory it is in, and
  every file row carries a *แนบ* button so a file can be attached without a
  picker. Switching a project returns it to that project's root.
- **คู่มือ / ปลั๊กอิน** — not rows here any more: both are pages of the settings
  sheet (**ตั้งค่า → คู่มือ** and **ตั้งค่า → ปลั๊กอิน**). They used to be two
  folded headings in this column, and clicking one opened a box you had to
  guess at, in a column whose job is the work. The playbook list is read from
  disk on every ask, so a part dropped into a library folder is there the next
  time the sheet opens — no restart, and no prose to edit: a folder's
  `index.md` is a preamble about what each playbook is *for*, and the list of
  what is actually on disk is generated and always follows it. Clicking a
  playbook opens it under its own row; clicking it again puts it away. The
  panels a plugin draws are on the plugins page, under the plugin that draws
  them, and a finished run repaints them in place.
- **แผงงาน** — the panels a plugin draws, in the rail itself. They used to
  be shown only while the settings sheet was open — the sheet releases its
  panel area when it closes, so a window at work showed none of them at all.
  A panel is the plugin's own work surface (a scratchpad, a board), and it
  belongs in the window rather than behind a dialog.

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

The launcher asks "is a backend already on this port?" before it starts one,
and the answer has to survive the loopback token: the backend's `/rpc` answers
a token-less call with a 401, so a probe that only accepts a 200 never sees a
running backend — it starts a second one, and the window opens on "port 8790
is busy". The probe sends the token, and a 401 carrying the backend's own
refusal still counts as *ours* (the running backend minted a different token
than the file holds). A 401 that is not ours is somebody else's server, and
the "the port is busy" message still says so.

The numbers that govern a run are clamped where they are written. `maxSteps` is
the one with a deliberate zero: 0 means no cap — the run goes until DONE, a
guard stops it, or a per-run budget is spent — and it is stored as written. A
nonsense count (negative, unparsable) falls back to that default instead of
reaching the loop and stopping a run before its first step. The same clamping
covers the compaction budget, the reserve, the rotation share, and the chat
URL's scheme. A hand-edited `settings.json` is clamped as it is read.

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
`session.list|new|open|entries|fork|rename|delete|archive`, `session.export`,
`session.tree`, `run`, `cancel`,
`permission.answer`, `plan.answer`, `pending`, `diff`, `apply`, `discard`,
`compact`, `skills.list|index|load`, `fs.list`, `fs.read`,
`symbols.list|def|refs`,
`attachment.stage|list|remove`,
`checkpoints.list|restore|remove`,
`git.status|stage|commit|branch`,
`media.models|options|styles|generate`,
`schedule.list|add|remove|runDue`,
`plugins.list|reload|inspect|install|remove|enable|disable`,
`mcp.list|reload|add|remove|enable|disable|test`, `panel.render`,
`projects.list|add|remove|switch`, `providers.list`, `provider.set|save|remove|test`,
`memory.list|clear`, `settings.get|set|reset`, `rules.get|set`,
`browser.open`, `waf.table`, `snapshot`.

**The window says which project it is on.** Every call carries an
`x-aipass-project` header, and the backend answers for *that* project — its
sessions, its file tree, its pending changes, its context meter. Two windows
can be open on two projects at once, and without this the one that spoke last
decided what the other one read; worse, one window's **Apply** button wrote
the other window's staged edits. The scope is a header and not a parameter
because `root` in `settings.set` already means "switch the machine to this
project". A method that names its own project wins over the header: the
header says *who* is asking, the parameter says *what* the call is about.
The project is looked up, never switched to — the human's own switch still
moves the machine, through `projects.switch`.

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
`helper_end`, `applied`, `discarded`, `session`, `conversation`, `cancelled`,
`needs_tab`, `tab_opened`, `stagnation`, `verify_prompt`, `check_start`,
`check_end`, `budget`, `plugin_call`, `fell_behind`.

`fell_behind` is not a harness event: it is the notice the event fan-out
sends a subscriber that stopped reading. Its queue is bounded by frames and
by bytes; when it overflows the oldest frames go, the losses are counted,
and the notice says how many. The window does not read the notice yet — the
loss is still silent on screen — so a run that outran the window can leave a
gap in the transcript that only the session file on disk can fill.

### The links a search brings back

A web search is the one tool whose result *is* a set of addresses, so the
window shows them: the `tool` event for a search carries its `sources`, and
the row lists them under itself, each one a link the reader can open. The
click goes to `browser.open` — the backend checks the address and opens it in
Chrome — because the window is a webview on the app's own page: a link that
navigated it would take the app away.

Two things make those addresses real. The search edge answers with opaque
redirect links (a long token on a search host), so the harness follows each
one once, under the same private-host guard the `FETCH` tool uses, and the
model is given the article's own address. And the model writes what it reads
in the wire spelling (`HTTPS-URL…`), so the window puts the spellings back
before it shows anything — the rules for that come from the backend
(`waf.table`), which owns the one table, so the window never keeps a copy.

### Reloads and reconnects

Every event frame carries a monotonic `seq`, both as `id:` and inside the
JSON, and the backend keeps the last 5000 frames — bounded by count *and* by
bytes (4 MB), so a long run cannot grow the buffer without end. A window that
reconnects — or reloads — resumes from where it was: a browser `EventSource`
reconnect sends `Last-Event-ID`, and the backend replays exactly the frames
that listener missed, once, in order, before the live stream continues. The
session log on disk covers the rest, via `snapshot`: a window reloaded mid-run
comes back holding its conversation instead of a blank page over a run that is
still going.

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

When a backend already answers on the port, both paths adopt it instead of
starting a second one: `--detach` prints and exits, and the foreground
`npm run desktop` opens the window against what is already running. A busy
port that is *not* this backend names itself and exits — it used to die with
a raw `EADDRINUSE` stack, which read as "the app does not open".

## The Tauri shell

`desktop/src-tauri` wraps this exact `ui/` folder in a WebView2 window. The
Rust side owns three things and nothing else: the window, the tray icon, and
the Node sidecar that runs the backend. It adopts a backend that is already
running instead of starting a second one, so `aipass desktop` in a browser and
the packaged app can be open at the same time.

Closing the window hides it — the tray keeps the backend (and a run in
flight) alive, and the tray menu's **ออก** is what quits for real. A run
should not die because someone tidied their taskbar by reflex.

**The page is granted nothing it does not use.** The window's page never
calls Tauri: the Rust side owns the window, the tray and the sidecar, and the
page talks to one local backend. So `withGlobalTauri` is off — there is no
`window.__TAURI__` in the document at all — and the capability set is window
and event commands only. The blanket `core:default` (which carries the tray,
the menu, path resolution and the devtools toggle) is not granted, and a
test says so.

**The policy that binds is the one the backend serves.** The window is loaded
from `http://127.0.0.1:8790/`, so it is an ordinary document on an ordinary
URL: the `Content-Security-Policy` that governs it is the header the backend
sends, not the one `tauri.conf.json` declares (that one covers the asset
protocol, which this window does not use). The two are kept identical — a
test compares them key for key, so they cannot drift — and the policy is
`script-src 'self'`, no inline and no eval, `object-src`/`form-action` locked
down, and `frame-ancestors 'none'`. Remote images and videos are allowed,
because the markdown renderer draws the model's own pictures and clips; the
old declaration blocked them, so a picture worked in the browser and vanished
in the packaged app.

## Platforms

The bridge, the harness, and the desktop window are the same `.mjs` files on
every machine; what differs is the shell around them.

| | Windows | macOS | Linux |
|---|---|---|---|
| Backend + bridge | `node` on PATH, or the bundled sidecar | same | same |
| Packaged window | NSIS (`tauri.windows.conf.json`) | `.app` + `.dmg` (`tauri.macos.conf.json`) | `deb` + AppImage (`tauri.linux.conf.json`) |
| Sidecar fetch | `npm run desktop:sidecar` — one script, per-platform name | same | same |
| Quitting the app | `taskkill /T` the backend it started | `kill -TERM` the child's process group | same as macOS |

One `tauri.conf.json` cannot name the bundles of three platforms, so the
bundle set lives in a per-platform file next to it — the CLI merges the one
that matches the platform it is building on. The whole install system (what
an artifact is called, what a release ships, what macOS needs) is
[`docs/INSTALL.md`](../docs/INSTALL.md).

macOS and Linux builds are wired and compile per-branch, but the verified end
to end on this machine is the Windows one: the packaged app has been run and
quit there, and the tray behaviour was exercised by hand. Treat the other two
as ready-to-try, not as ready-to-ship, until somebody runs them and says so.
The Node-side suite now takes a macOS lane in `.github/workflows/test.yml`, so
a darwin branch bug shows up on push; the packaged window and tray are still
the hand-run part.

Toolchain on this machine: Rust 1.99 (`D:\rust`), MSVC Build Tools (`D:\VS`),
cargo target `D:\aipass-build`. The Node sidecar is a copy of the local
`node` binary in `desktop/sidecar/` — refresh it with
`npm run desktop:sidecar` after a Node upgrade; it is gitignored on purpose.

```powershell
npm run desktop:build     # the release artifact, its checksum and its manifest → dist/
npm run tauri:dev         # the app, with hot reload on the Rust side
```

`desktop:build` is the one command that ships: it checks that the three
version numbers agree, puts the sidecar in place, asks for the platform's
bundles and writes `dist/` with `SHA256SUMS` and `manifest.json` beside the
artifact. The raw bundler is still there (`npm run tauri:build`) for the
loop that wants it.

The install ladder is the same procedure, scripted:
`npm run desktop:install-ladder -- --new <installer> [--old <the previous
release's installer>]` installs the artifact, checks that the installed build
is the one that shipped and that it actually runs, installs the new build over
the old one, installs the old build back, uninstalls — and checks that the
user's data survived. It asks before it installs anything, and it never
touches the real `~/.aipass`: the app runs with `AIPASS_HOME` pointing at a
scratch directory.

The tray menu has one more item than it used to: **ติดตั้ง CLI (aipass)**
writes a shim into a per-user bin directory that runs the app's own Node
against the app's own CLI, so `aipass` works in a terminal on a machine
that has no Node installed. It puts that directory on the **user** PATH
(`HKCU\Environment`, never the machine one) as well: a shim in a directory
that is not on PATH is a file nobody can run, and editing PATH by hand is
the step that never happens. A terminal opened before the click keeps the
old PATH — open a new one.

## Settings

`~/.aipass/settings.json` is the one file the window, the backend and any future
surface read. The gear in the header opens it as a form; `settings.get` and
`settings.set` over `/rpc` do the same thing from a script.

What it holds: default model (+ the **thinking level** the model reasons at
before each step — edited from the composer's effort chip in the window, or
`/thinking` in the terminal; it streams into a fold labeled `✻ reasoning…` and
closes when the turn ends, and only models that advertise thinking levels
honour it), the **sampling temperature** (`temperature`, 0..2 — edited in the
sheet's คุยกับโมเดล page; `null` leaves it to the server's per-model default,
and a value outside the range is clamped), the **work mode** (`ask` / `auto` /
`yolo` — edited from the mode chip beside the composer, and `plan` rides
`plan` + `requirePlanApproval` as the chip's plan view), `allowRun`, `maxSteps`
(0 = no cap, the shipped default), the per-run caps `maxToolCalls` /
`maxWallClockMs` (the sheet asks for the wall clock in minutes), helpers on/off,
the compaction budget (**budget**, **reserve**, and the share at which it
rotates — `compactAtPercent`, 40 by default), playbook folders, the project
list, the current root, enabled plugins, theme, the chat tab URL and whether a
run that needs one opens it — and the **declared check**: `verifyCommand` (the
one command the checker must treat as the project's check, replacing
`.aipass/check.txt` when set) and `requireCheck` (refuse a DONE while that
check is still failing; the run ends as `done-unverified` instead of accepting
it). Both are off by default, so the checker stays advisory until a project
or a person asks for the gate.

Two more keys sit on the sheet's permissions page, both off by default:
`allowGitWrite` (may the model run git's write side — `stage`, `commit`,
`branch`; a git write still asks like any other write) and `allowVerify`
(may the model ask for a check with the `VERIFY` marker; the preamble that
teaches the marker is behind the same switch).

The sheet validates before it writes, and `settings.reset` returns everything to
the shipped defaults while keeping the project you are in.

The **กฎไฟล์** page is the permission engine's path rules, editable: a pattern,
a verdict, and which kind of action it covers. Type a path into the tester and
it tells you which rule catches it, with the same glob the gate uses — a rule
you cannot test is a rule you guess at. An empty pattern or a duplicate is
refused at Save rather than stored where it would look like protection.

Every setting applies the moment it is written — not just the file, the
running process: the ones that govern a run (`maxSteps`, the per-run caps,
plan,
`requirePlanApproval`, helpers, thinking, temperature, model, mode, the compaction knobs) move
the live harness — the composer's effort chip writes the same way the moment it
changes — `skillsDirs` rebuilds the playbook library, the plugin list
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
  ctx.tools.register('SEND', handler, { risk: 'shell' });      // …routed through the permission gate
  ctx.panel({ id: 'notes', title: 'scratchpad', render });     // a sidebar section
  ctx.rpc.method('plugin.notes.clear', handler);               // a /rpc method
  ctx.settings.define({ key: 'notes.file', label: '…' });      // a setting
  ctx.events.on('finished', handler);                          // watch runs
}
```

The built-in markers the model reaches for most often are `NEED file|dir`,
`SEARCH`, `TREE`, `STAT`, `LIST -l`, `GLOB`, `SYMBOLS`, `DEF`, `REFS`,
`RECALL`, `EDIT`, `CREATE`, `RUN`, `VERIFY` and `GIT`. `TREE` shows a folder's
shape, `STAT` one path's metadata, `LIST -l` adds size and modified time to a
listing, and `SEARCH` takes `-i` plus `-A`/`-B`/`-C` context flags.

Tools the model can call arrive as `MARKER rest-of-line` - or as a block ending
in `END` when `takesBody` is true — and their result comes back exactly like a
NEED or SEARCH result. The preamble grows one paragraph listing them while a
run is in flight. Every tool rides the same permission gate a built-in of that
kind does (asked in `ask` mode, per the path rules and the secret floor). The
`risk` you register says which kind it is: `'read'` stays a read, `'write'`
and `'shell'` are asked about like a built-in write or run. A tool that
declares nothing is classified like a **write** — a plugin's code runs in the
backend process with the app's rights, so silence is not a declaration of
trust. The choice stays the plugin author's, made where the tool is registered:
`risk: 'read'` is a promise you can keep, and only you can make it.

Panels are rendered across the process boundary, so a plugin returns markup
(`render: async () => ({ html })`) rather than DOM nodes. The window draws the
panel's title (the `title` you register) on the settings sheet's **ปลั๊กอิน**
page, so the markup you return is the body — return the title again and it is
printed twice. Plugins run in the backend with the same access the harness has,
including the filesystem — they are code you chose to install, not sandboxed.
Load only what you have read.

### Installing, enabling, removing

Installing is the consent moment: the code is about to run with the app's
rights, so the surfaces show first and ask second. Settings → ปลั๊กอิน has an
install box (a path, an `https://` URL, a git spec such as
`github:owner/repo#main`, or an npm package such as `npm:<package>`);
`[ตรวจสอบ]` prints kind, size and sha256 **without executing anything**, and
only `[ติดตั้ง]` proceeds: the source is staged under `.staging/`, validated by
loading it with the real loader, then swapped in — the previous version moves
to `.trash/`, which keeps one copy per name, and is never deleted (pruning
only ever removes earlier generations of the same name). A git or npm source
is *fetched* to answer the report (a shallow clone, or an `npm install` with
`--ignore-scripts`, so no package script runs), and the hash of the entry file
is checked again at install time — a branch that moved since the report is
refused. The box says what it is doing while it does it, and a refusal names
the step that closed the door (`ขั้นตอน: ดึงไฟล์ / ตรวจโค้ด / ชื่อปลั๊กอิน /
สลับไฟล์`). `aipass plugin update <name>` re-fetches the recorded source
and runs the same chain; it leaves the enable state as the person set it.
The same lifecycle is on the CLI: `aipass plugin list|inspect|install|update
<name>|remove|enable|disable` (it asks a running window to do the work, so the
open sheet updates live), and every mutation emits the `plugins` event.

`~/.aipass/plugins/.registry.json` records where each managed plugin came from
(source, sha256, installedAt, surface). It is advisory — deleting it loses the
"where did this come from" answer, never the plugin. A file the installer did
not put there is *unmanaged*: it still loads, and replacing or removing it
needs an explicit `--force` (a second confirm in the window), because unmanaged
work is the user's.

Which plugins run is `settings.plugins`: empty = master on (everything found
now and later); the first ปิด materializes the list as every known name minus
that one; disabling the last one writes the sentinel `(none)`, so `[]` cannot
read as "everything" and turn it back on; and enabling collapses back to `[]`
only when the list covers every **known** name — counting only loaded ones
would silently re-enable an installed, disabled plugin the moment a different
one is enabled. `plugins.list` also reports each loaded plugin's content hash
and whether it changed since install, so "did that plugin change since it last
behaved?" has an answer on its card.

## MCP

MCP servers are external tool processes spoken to over stdio; their tools
appear to the model as `MCP__server__tool`. Config is `~/.aipass/mcp.json` (all
projects) plus `<project>/.aipass/mcp.json` (that project — a same-named server
there wins whole-entry over the home one). Hand-editing stays legal; the
settings sheet's 🔌 MCP section and the CLI do the same job with live state:

```
aipass mcp                        list servers: connected / error / disabled
aipass mcp add <name> [--scope home|project] [--risk write|read]
             [--env K=V]... [--cwd dir] -- <command> [args...]
aipass mcp test <name>            connect once, list its tools, exit
aipass mcp enable|disable <name>  the entry stays; enabled:false stops the spawn
aipass mcp remove <name>          config and its env values go together
```

Per-server fields: `enabled` (default true), `risk` — the declared risk its
tools ride through the permission gate, defaulting to `"write"` so an MCP
filesystem server *is* asked about in ask mode; `"read"` is your explicit
"never ask for this server", a trust statement rather than a verification —
and `cwd` for servers that read relative paths. `env` values are secrets:
rendered as `KEY = •••••` after save, never logged, gone when the server is
removed. `[ทดสอบ]` in the add form runs the command once and lists the tools it
offers before saving. A server that fails to connect stays listed with its
error and never blocks a run.


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
2. Session tree view (`/tree`) and export to markdown/HTML. Renaming from the
   window is shipped (`/resume` → rename, and `session.rename` on the RPC).
   **Shipped** — `session.export` (markdown, or one self-contained HTML page
   with everything escaped) and `session.tree` (the sessions of the project
   grouped by the day they belong to) are on the RPC and in the suite
   (`test/export.test.mjs`), and the window has both: `/tree` opens the
   sessions by day, and `/export` writes the open session as markdown or
   HTML — the dialog asks for the format and the path, and a relative path
   lands in the project.
3. ~~Permission path rules from the window instead of code~~ **done** — the
   rules page in the settings sheet, `rules.get|set` on the RPC, and the same
   list honoured by `aipass agent` from the same settings file.
4. ~~Multiple roots / a project picker~~ **done** — the picker in the header,
   `projects.list|add|remove|switch` on the RPC, and the current root in
   `settings.json` so the app opens where the last session left off. Two
   windows can be on two projects at once now, too: the window names its
   project on every call (see *API* above).
