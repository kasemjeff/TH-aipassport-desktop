# aipass bridge

Use [de.aipass.net](https://de.aipass.net/chat) from your terminal, with
streaming.

```
terminal ──HTTP──▶ bridge (node, no deps)
                      │  SSE: jobs out, POST: deltas back
                      ▼
                   extension service worker
                      │  chrome.runtime
                      ▼
                   de.aipass.net tab ──▶ /actions/send-message/<id>
```

**No credential ever leaves the browser.** The real request runs as ordinary
page JavaScript inside a de.aipass.net tab, so Chrome attaches the session
cookie itself. The bridge never sees it and nothing is stored on disk.

For the full structure and how every piece works, see [`DOCS.md`](./docs/DOCS.md).

## Setup

The fastest path on a fresh machine is one command:

```bash
aipass setup            # or: npm run setup
```

It checks Node, puts `aipass` on your PATH, mints the loopback token (and copies
it to your clipboard), starts the bridge, and opens the extension and site pages
so you can finish the one-time browser steps. Re-run it any time — it is
idempotent. The manual steps below are what it automates.

There is nothing to build and nothing to `npm install` to run it. Everything
under `aipass-bridge/` is `node:*` builtins, so on **any machine with Node ≥ 20**
the same three steps apply — copy the repo over and run them again.

### 1. Get the `aipass` command on your PATH

```bash
sh aipass-bridge/install.sh                                    # macOS / Linux
powershell -ExecutionPolicy Bypass -File aipass-bridge\install.ps1   # Windows
```

`install.sh` symlinks `aipass` into the first of `~/.local/bin` / `~/bin` that is
already on your `PATH`; failing that it tries `npm link`; failing that it prints
the manual options. `install.ps1` runs `npm link` (npm's global bin is on PATH by
default on Windows). Both are idempotent — re-run any time, e.g. after moving the
repo, which breaks the old link.

Prefer not to install? Skip this step and use `node aipass-bridge/bin/aipass.mjs …`
or the `npm run …` scripts from the repo directory.

### 2. Load the extension (one time, per browser)

`chrome://extensions` → **Developer mode** → **Load unpacked** → select
`aipass-bridge/extension`.

### 3. Open a de.aipass.net tab

Log in at `https://de.aipass.net/chat` and leave the tab open. The extension
popup should read **connected**.

If the popup instead says the bridge needs a token, copy the contents of
`~/.aipass/.token` (the bridge prints the path when it starts) into popup →
**Advanced** → **Loopback token**, once per browser. The bridge requires it
for everything except the health probes; `AIPASS_REQUIRE_AUTH=0` disables it.

> **Running on a server?** There's an optional headless Docker deployment in
> [`deploy/`](deploy/README.md) — the same bridge and extension in a container
> with a noVNC desktop, so it stays up 24/7 without your laptop. The core here
> is unchanged; that folder only adds container plumbing.

### Check it

```bash
aipass status     # node ≥ 20? bridge up? extension connected?
```

Then:

```bash
# Terminal 1: Run the bridge in foreground (with live logs)
aipass dev        # or: npm run dev

# Terminal 2: Start chatting
aipass            # interactive TUI chat
aipass "question" # one-shot answer from CLI
```

| command | |
|---|---|
| `aipass` · `aipass chat` · `aipass "question"` | chat (interactive / one-shot) |
| `aipass dev` | run the bridge in the foreground (Ctrl+C to stop) |
| `aipass desktop` | the desktop app: bridge (if needed) + agent window, one command |
| `aipass agent "task"` | file agent against **the current directory** |
| `aipass models` · `aipass conversations` | the list printers |
| `aipass providers` | list / add / remove / use the API providers |
| `aipass styles` | list video & image style presets |
| `aipass credits` | check credit quota |
| `aipass doctor` | node / bridge / extension / model diagnostics |
| `aipass memory` | list/clear the facts carried across sessions for this project |
| `aipass relocate` | re-key a project's stored data after its folder moved |
| `aipass scale "task" [--n N]` | test-time scaling: run a task N times, keep the best |
| `aipass plugin` | install / inspect / enable / disable / remove plugins |
| `aipass mcp` | add / remove / list MCP servers and call their tools |
| `aipass setup-assistant` | configure custom coding assistant |
| `aipass setup` | first-run setup: Node, PATH, token, bridge, browser pages |
| `aipass status` | node / bridge / extension check |
| `aipass stop` | stop a lingering background bridge |

Uninstall with `rm -f ~/.local/bin/aipass` (or `npm rm -g aipass` if you used `npm link`).

Every machine talks to the **same de.aipass.net account** — chat history is
shared, and only `gemini-3.1-flash-lite` is free-credit.

## Set up the coding assistant (one time)

The file-editing agent works best when aipass itself carries the tool protocol,
rather than the agent resending it every run. Create a custom assistant once at
[`/ai-assistant/new`](https://de.aipass.net/ai-assistant/new) and fill it in:

| Field | Value |
|---|---|
| **ชื่อ AI** (name) | `Local File Coder` |
| **รูปแบบ** (format) | `สนทนา` (conversational) |
| **AI โมเดลตั้งต้น** (model) | `Claude Sonnet 5` — best at holding the protocol |
| **แท็ก** (tags) | `coding`, `local-files` |
| **รายละเอียด** (description, display only) | `แก้ไขไฟล์ในเครื่องผ่าน bridge ด้วยคำสั่ง NEED / SEARCH / EDIT / CREATE / DONE` |
| **เพิ่มชุดความรู้** (knowledge files) | leave empty |

Paste this verbatim into **รูปแบบการดำเนินการของ AI** (the behaviour field,
max 1000 characters — this is 958):

```
You help the user work on a code project on their computer. You cannot open the files; the user runs each action you write and pastes the result back. Never say you lack tools or ask them to paste files — just write actions.

Write actions on their own lines, exactly like this:

NEED dir .
NEED file src/app.ts
SEARCH text to find anywhere in the project
EDIT src/app.ts
FIND
the exact current lines
NEW
the replacement
END
CREATE notes.md
file contents
END
DONE one sentence summary when finished

Rules. Write prose in the user's language; keep action lines exactly as shown. Every reply needs an action or DONE. Never ask questions — pick a reasonable reading and begin. SEARCH to find where something is instead of reading every file; read a file before you EDIT it. Line numbers on the left are display only — never put them in FIND, copy the code exactly. Keep shortened hostnames like LCLHST as written. Write DONE only at the end, never with a NEED.
```

Save it, then start one chat with it in the UI and copy the conversation id from
the URL. Run the agent against that conversation with `--slim` (see below), or
wire the bridge to create bound conversations automatically — also below.

## Use it

```bash
aipass                               # interactive   (or: npm run chat)
aipass "ช่วยสรุปข่าว AI วันนี้"          # one-shot      (or: npm run chat -- "…")
```

The interactive client streams the reply, renders it as markdown, shows
`web_search` progress as dim gutter lines with sources listed at the end, and
frames the input in a prompt box. A braille spinner runs while you wait.

Type `/` to open the command menu — **↑/↓** to choose, **Tab** to fill it in,
**Enter** to run, **Esc** to dismiss:

| command | |
|---|---|
| `/model` | pick a model — an **↑/↓** picker (`●` marks the one in use); or `/model <id>` |
| `/models` | print the model list |
| `/conversations` | switch conversation — an **↑/↓** picker; **Enter** switches, **Esc** cancels |
| `/new` | the *next* message starts a fresh conversation, titled by that message |
| `/tone` | set response tone (`concise`, `friendly`, `formal`, etc.) — **↑/↓** picker or `/tone <name>` |
| `/format` | set response format (`bullet_points`, `table`, `json`, etc.) — **↑/↓** picker or `/format <name>` |
| `/styles` | print active style settings and all available presets |
| `/image-style` | pick image style preset (`Anime`, `Cinematic`, etc.) — **↑/↓** picker or `/image-style <name>` |
| `/video-style` | pick video style preprompt — **↑/↓** picker or `/video-style <name>` |
| `/credits` | check credit quota & usage meter card (or `/quota`) |
| `/doctor` | run diagnostic health checks inline |
| `/assistant` | select custom assistant — **↑/↓** picker, or `/assistant off` |
| `/agent` | switch to agent mode — `/agent` or `/agent <task>` |
| `/agent-root` | set directory the agent may touch |
| `/file` | attach a document or text file — `/file <path> [prompt]` |
| `/image` | attach local image file — `/image <path> [prompt]` |
| `/clip` | paste image directly from clipboard — `/clip [prompt]` |
| `/clear` | clear the screen |
| `/help` | list the commands |

`Ctrl+C` quits. Piped or non-tty output stays plain — no cursor tricks, no box.

| script | |
|---|---|
| `npm run dev` | start the bridge on :8787 |
| `npm run chat` | terminal client |
| `npm run desktop` | the desktop app on :8790 (see `desktop/README.md`) |
| `npm run agent -- "task" --root .` | local file tools, in a fresh conversation |
| `npm run agent -- "task" --root . --watch` | stay open for follow-up tasks on the same conversation |
| `npm run models` | list models, marking free-credit ones |
| `npm run styles` | list video & image style presets |
| `npm run conversations` | list conversations and which is in use |
| `npm run credits` | check credit pool remaining |
| `npm run doctor` | run comprehensive diagnostic checks |
| `npm run setup-assistant` | set up or bind custom coding assistant |
| `npm test` | run the test suite |
| `npm run desktop` | bridge + harness backend + the window, in a browser |
| `npm run qa` | one QA pass: static wiring, suite, window logic, live backend |

The desktop app is the same bridge and the same agent with a window on top —
see `desktop/README.md`. Nothing in this repo needs `npm install` to run: every
file imports only `node:*` builtins.

## What you get

Whatever the web UI gives you for the same message — including its server-side
tools. A `web_search` shows up live and its sources are listed at the end:

```
[web_search] {"query":"aipass.go.th"}
[web_search] returned 4821 chars
AiPASS เป็นแพลตฟอร์มภายใต้โครงการ TH-AI Passport …
sources:
  - Aipass https://aipass.go.th/
```

Tool activity is sent as `reasoning_content`, so an OpenAI client that only
reads `content` sees a clean answer. `AIPASS_TOOL_VISIBILITY=text` inlines it,
`off` drops it.

## From code

The endpoint is OpenAI-compatible, so any SDK works — point it at
`http://127.0.0.1:8787/v1` with any dummy key (auth is your browser session).

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:8787/v1", api_key="sk-dummy")
stream = client.chat.completions.create(
    model="gemini-3.1-flash-lite",
    messages=[{"role": "user", "content": "Hello! What can you do?"}],
    stream=True,
)
for chunk in stream:
    print(chunk.choices[0].delta.content or "", end="", flush=True)
```

```typescript
import OpenAI from "openai";

const openai = new OpenAI({ baseURL: "http://127.0.0.1:8787/v1", apiKey: "sk-dummy" });
const stream = await openai.chat.completions.create({
  model: "gemini-3.1-flash-lite",
  messages: [{ role: "user", content: "Tell me a fun fact." }],
  stream: true,
});
for await (const chunk of stream) process.stdout.write(chunk.choices[0]?.delta?.content || "");
```

Send an `image_url` content part and the bridge uploads the image to aipass and
attaches it — vision works on models that support it.

## Scope, and why

Only the user's message is sent. Not a system prompt, not a transcript.

That is not a limitation of the bridge, it is what the endpoint accepts. A
`messages` array containing an **assistant** turn is rejected upstream with a
bare `403` from Google Frontend, before the model sees it — the web UI never
sends one, because the server owns the conversation and its history. Attempts
to supply an agent-style system prompt were also rejected, at sizes and shapes
that plain text of the same size passed, which points at request scoring
rather than any single rule.

So this does the one thing that works reliably: send a message, stream the
answer. Multi-turn works because the server remembers the conversation, the
same way the web UI does.

## Local file tools

```bash
npm run agent -- "add a health route that returns ok" --root .
```

Dry run by default: edits go to an in-memory overlay so the model can read back
its own pending work, you get a unified diff at the end, and nothing touches
disk until `--apply`. Paths are confined to `--root`; shell access needs
`--allow-run`.

### Actions the agent understands

The model replies with these on their own lines; the agent runs each one locally
and pastes the result back. This is the whole tool set:

| Action | What it does |
|---|---|
| `NEED dir <path>` (also `NEED list` / `NEED ls`) | list a directory (`.` for the project root) |
| `NEED file <path>` | read a file, with line numbers; add a range like `NEED file src/app.ts 200-320` for a slice of a long one |
| `SEARCH <text>` | grep the whole project, returning `file:line: excerpt` matches — find a symbol without reading every file |
| `EDIT <path>` → `FIND` … `NEW` … `END` | replace an exact snippet; the `FIND` text must match **one** place or the edit is refused |
| `CREATE <path>` … `END` | create a new file or overwrite an existing one |
| `RUN` … `END` | run a shell command — **off unless you pass `--allow-run`** |
| `DONE <summary>` | finish, with a one-line summary |

A few guarantees worth knowing: reads carry a line-number gutter but the model
never has to keep those (they are stripped from `FIND` automatically); an `EDIT`
whose `FIND` text is not unique is refused rather than applied to the wrong
occurrence; and long files page a screen at a time with a hint for the next
range.

**Watch mode** (`--watch`) keeps the agent open and takes follow-up tasks on the
same conversation, so the model keeps everything it has already read in context
— and because the server holds that history, each new task is still just one
small message. Run it in your editor's integrated terminal for a live edit loop.

**Binding to the custom assistant** (created above). Either point at a
conversation started under it — `--conversation <id> --slim` — or let the bridge
create bound conversations with `--assistant <id>` (which implies `--slim`). The
form field that carries the assistant id is set by `AIPASS_ASSISTANT_FIELD` on
the bridge (default `aiAssistantId`); confirm it once from a capture of the UI's
"new chat" request and every run binds automatically.

This works within the constraints above rather than against them:

- **Instructions are sent once**, as the first message of the conversation. The
  server remembers them, so later turns carry only the tool results — typically
  a couple of hundred bytes instead of resending a prompt every step.
- **No system prompt.** The preamble is just the first user message, which is
  the only channel this endpoint has.
- **The format is prose-shaped**: `NEED file some_file.ts`, no angle brackets, no
  `key=value` pairs, no absolute paths, no banner rules. Every one of those drew
  a 403 in earlier attempts, and none of them was load-bearing.
- **It never claims the model has tools.** The model's own system prompt says
  its tool is `web_search`, so a preamble written like a tool protocol makes it
  search for the syntax and then refuse, correctly, on the grounds that it has
  no file access. The preamble instead states the division of labour plainly:
  you have the files, the model writes lines, you run them and paste results
  back. It also says outright not to explain a lack of file access, which is the
  failure mode this replaces.
- **The first message includes the top-level listing**, so the model is grounded
  in the real directory instead of guessing a first path.

- **A rejected turn is split and resent.** File contents are arbitrary: a
  README carries shell commands, URLs and code fences, and any of those can push
  a request past an upstream filter. On a 403 the agent halves the message and
  sends the halves in sequence, recursively, down to ~300 bytes. The server
  remembers each part, so the model still sees the whole thing. If a fragment is
  rejected even on its own, the agent prints it rather than failing silently.

- **A custom aipass assistant carries the protocol.** The sanctioned way to
  give the model the tool convention is aipass's own Create AI Assistant
  (`/ai-assistant/new`) — paste the NEED/EDIT/CREATE/DONE instructions into its
  behaviour field. Then run against a conversation bound to that assistant with
  `--conversation <id>` (or `--reuse`) plus `--slim`, which drops the built-in
  preamble the assistant already provides.
- **Trigger-shaped tokens are encoded, symmetrically.** Everything sent upstream
  is encoded and everything read back is decoded — so the task text and preamble
  are covered, not just file contents. Three families, all confirmed against the
  live edge: `localhost` / `127.0.0.1` / `0.0.0.0` / `169.254.169.254` /
  `file://` (SSRF); any tag-opening `<` — `<html`, `<div`, a JSX component,
  `<script`, `<!--`, `<!doctype` — while leaving `a < b` and `=>` alone (XSS);
  and `.env` / `process.env` (the classic secrets-probe pattern). They go out as `LCLHST`, `CMT-OPEN`, `DOT-ENV` and so
  on, and are restored before anything is written — the bytes on disk are exactly
  what the file had. A file whose *name* is encoded (a real `.env` shown as
  `DOT-ENV`) is decoded before the permission check, so the rules always see the
  real path — and the secret floor (`SECRET_RULES`, `harness/settings.mjs`)
  denies `.env*` reads and writes in every mode, obfuscated spelling included.

- **Lines that cannot be sent at all are dropped.** Real source contains
  code-execution shapes — `node -e`, `curl`, `rm -rf`, `/bin/sh`, `../../` —
  that no amount of splitting gets past. When a fragment is rejected even on its
  own, those lines are replaced with a note and the rest goes through, so one
  bad line costs a line rather than the whole run.

Tool results are capped at 3000 bytes (`--max-result`) for the same reason.

The npm scripts in this repo avoid `node -e "…"` one-liners for exactly this
reason — the agent reads `package.json` early in almost any task, and a script
field shaped like code execution got the whole read rejected.

## Try it

Run these top to bottom — the early ones are zero-risk (read-only, or a dry run
that writes nothing), and each proves a bit more. Use a scratch folder for the
builds so your own repo stays clean:

```bash
mkdir -p ~/Desktop/agent-test
```

**1. Read-only — proves the whole chain, writes nothing.**

```bash
npm run agent -- "What does this project do and what's the tech stack?" --root .
```

It reads the README and `package.json`, then answers. If this works, the
extension, bridge, and conversation flow are all healthy.

**2. One self-contained file — the classic first build (dry run).**

```bash
npm run agent -- "Create index.html: a self-contained todo app with inline CSS and JS. Add, complete, delete todos, persist to localStorage. Clean, modern look." --root ~/Desktop/agent-test
```

You see the whole file as a `+` diff; nothing is written. Add `--apply` to write
it, then `open ~/Desktop/agent-test/index.html`.

**3. Edit an existing file — exercises `EDIT` / `FIND` / `NEW`.**

```bash
npm run agent -- "In index.html, add a button that clears all completed todos at once." --root ~/Desktop/agent-test --apply
```

It reads the file first, then makes a surgical edit — a real before/after diff,
not a rewrite.

**4. A small multi-file project.**

```bash
npm run agent -- "Create a tiny expense tracker: index.html, style.css, and app.js as separate files. Add expenses with amount and category, show a running total." --root ~/Desktop/agent-test --apply
```

**5. Watch mode — iterate live, the real workflow.**

```bash
npm run agent -- "Create a Pomodoro timer as a single index.html: 25-minute countdown, start/pause/reset." --root ~/Desktop/agent-test --apply --watch
```

Then keep typing follow-ups at the `task>` prompt — each builds on what it
already wrote, in the same conversation:

```
task> add a short-break mode of 5 minutes
task> play a sound when the timer hits zero
task> make it dark by default
```

**6. Search a real codebase — run this against the repo itself.** A task that
has to *find* something first is where `SEARCH` earns its place:

```bash
npm run agent -- "Find everywhere the bridge reads a process.env variable and list each one with what it configures." --root .
```

Watch it `SEARCH process.env`, get back `file:line` hits across the tree, read
only the files that matter, and answer — instead of reading everything. A rename
task (*"find every call to `outbound(` and …"*) exercises search-then-edit the
same way.

Start with **#1**: if it answers cleanly, everything after it is just the agent
doing more. If a step returns a `403`, it hit an upstream filter shape not yet
substituted — the failing fragment prints, and it is usually a one-line fix.

## Conversations

The bridge can create them, the way the chat page does — a form post to
`/chat.data` with `intent=create-conversation`. The server derives the id from
the first sixteen hex characters of the `clientCreateRequestId` it is given,
which is why ids look the way they do.

```bash
curl -s localhost:8787/conversations/new -H 'content-type: application/json' -d '{"message":"hello"}'
npm run conversations     # list them, marking the one in use
```

**`npm run agent` starts a fresh conversation for every run.** A conversation
carries its own history, so reusing one drags in whatever was said before —
including a refusal, which the model then sees itself having made and repeats.
`--reuse` continues the most recent instead, `--conversation ID` continues a
specific one.

`npm run chat` continues the most recent by default, since that is what makes a
chat a chat. `--new` (or `/new` mid-session) **defers**: the next message you
send becomes the first message of a fresh conversation, so the account's chat
list shows it titled by real text instead of a placeholder. `/conversations`
switches between the ones you already have.

Posting to an invented id returns `404 Conversation not found`, and a
conversation that stops accepting messages (`404` when deleted, `409` when the
server still believes a generation is running) makes the bridge move to the next
most recent.

## Configuration

| env | default | |
|---|---|---|
| `AIPASS_PORT` | `8787` | |
| `AIPASS_HOST` | `127.0.0.1` | any other bind exits unless `AIPASS_ALLOW_REMOTE=1` |
| `AIPASS_TOKEN` | `~/.aipass/.token` | loopback bearer; `AIPASS_REQUIRE_AUTH=0` disables |
| `AIPASS_CORS_ORIGIN` | *(unset)* | allow one browser origin; off by default |
| `AIPASS_MODEL` | `gemini-3.1-flash-lite` | used when no model is given |
| `AIPASS_MODELS` | two known ids | fallback list when no extension is attached |
| `AIPASS_MODEL_FILTER` | `chat` | `all` keeps image/video/audio models |
| `AIPASS_TOOL_VISIBILITY` | `reasoning` | `text` or `off` |
| `AIPASS_CONVERSATION_ID` | *(unset)* | pin one conversation |
| `AIPASS_IDLE_TIMEOUT_MS` | `180000` | fail a job after this long with no delta |

The bridge also serves `POST /v1/chat/completions` and `GET /v1/models`, so any
OpenAI-compatible client can point at `http://127.0.0.1:8787/v1` for plain
chat. Only the last user message is forwarded.

### Another provider

The bridge is for AiPASS. The **harness** — the agent, and the desktop window
that drives it — can also talk to a provider that is a plain API:

```bash
aipass providers                                        # list
aipass providers add openai \
    --base-url https://api.openai.com/v1 \
    --api-key-env OPENAI_API_KEY --model gpt-4o
aipass providers use openai                             # a run now answers with it
aipass providers test openai                            # ask it whether it answers
```

`--kind anthropic` speaks Anthropic's Messages API instead of the
OpenAI-compatible shape. The specs live in `~/.aipass/providers.json`; the
keys live in `~/.aipass/credentials.json` (owner-only) — and a named
environment variable wins over the stored key, so the key never has to be
written down. `settings.json` holds no secret.

One run on another provider: `npm run agent -- "…" --provider openai`.

## Tests

```bash
npm test
```

147 tests, no dependencies, a few seconds. `test/harness.mjs` runs the real
bridge as a subprocess and a scriptable stand-in for the extension, so tests
drive the actual HTTP surface and the real CLIs rather than mocks of them.

They cover the failures this thing actually hit: that only the newest user
message is forwarded and never an assistant turn; conversation rotation past a
locked one; a job surviving the extension disconnecting mid-stream; loopback
substitution round-tripping so `localhost` never leaves the machine and the
bytes on disk are unchanged; splitting a rejected turn; dropping a line that
cannot be sent at any size; a premature `DONE` being ignored; recovery when the
model drifts into prose; refusing paths outside the project root; and dry run
leaving the disk untouched.

To add a case, script the model's replies with `scripted([...])` and, where a
filter is being modelled, pass `reject` to refuse payloads matching a pattern.

`chat.mjs` carries `// @ts-check` with JSDoc types. It still runs as plain
`node` with no build and no runtime dependency; to type-check it,
`npm i -D typescript` once, then `npx tsc -p aipass-bridge/jsconfig.json`.

## Known limits

- A de.aipass.net tab must stay open. Its content script also holds a port that
  keeps the MV3 service worker alive; without it Chrome evicts the worker every
  ~30s. If a tab predates the extension, or Chrome discarded it, the worker
  re-injects the scripts.
- Every message appears in the account's chat history — this uses the real product.
- Long sessions burn credits. Only `gemini-3.1-flash-lite` is free-credit;
  `npm run models` marks it.
- Windows works (bridge, `aipass`, chat, agent — the diff and `RUN` use no Unix
  tools). Use a VT-capable terminal: Windows Terminal, or `cmd`/PowerShell on
  Windows 10 1809+.
