# ✳ aipass

**English** · [ไทย](./README.th.md)

> **The desktop window and the agent harness for [de.aipass.net](https://de.aipass.net/chat)** —
> a file-editing agent you can watch, approve and resume — running on top of the
> community bridge that reaches the site through your own logged-in browser tab.
>
> **Independent community project.** Not affiliated with, endorsed by, or
> sponsored by the operator of de.aipass.net. See [TRADEMARK.md](./TRADEMARK.md).

<p align="left">
  <img src="https://github.com/kasemjeff/TH-aipassport-desktop/actions/workflows/test.yml/badge.svg" alt="Tests" />
  <img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="MIT License" />
  <img src="https://img.shields.io/badge/node-%E2%89%A520-blue?logo=node.js&style=flat-square" alt="Node >= 20" />
  <img src="https://img.shields.io/badge/dependencies-zero-success?style=flat-square" alt="Zero Dependencies" />
  <img src="https://img.shields.io/badge/status-pre--1.0-orange?style=flat-square" alt="Status: pre-1.0" />
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-lightgray?style=flat-square" alt="Platforms" />
</p>

![the aipass desktop window](./public/image.png)

<p align="center">
  <em>The window: sessions on the left, the project tree under them, the
  conversation in the middle — every tool call a row you can open, every
  pending edit a file you tick.</em>
</p>

---

## Contents

- [Project status](#project-status)
- [What this repo is](#what-this-repo-is)
- [What this repo does well](#what-this-repo-does-well)
- [Architecture](#architecture)
- [Installing](#installing)
- [Quick start](#quick-start)
- [The desktop window](#the-desktop-window)
- [The harness](#the-harness)
- [The bridge and the CLI](#the-bridge-and-the-cli)
- [Configuration](#configuration)
- [Documentation](#documentation)
- [Repo layout](#repo-layout)
- [Development](#development)
- [Community and support](#community-and-support)
- [Contributing](#contributing)
- [Security](#security)
- [Credits & license](#credits--license)

## Project status

**Pre-1.0, source install.** There is no published installer or GitHub release
yet; the install command in this README builds/runs from a checkout. The
release workflow is in place but has not been used — see
[ROADMAP.md](./ROADMAP.md) for what is still missing before `v0.2.0` ships.

What is green today:

- the Node suite (bridge, extension stand-in, harness, window logic) on
  Ubuntu, macOS and Windows across Node 20, 22 and 24;
- the Rust shell's unit tests on Ubuntu and Windows;
- the coverage floors, the docs link check, the eval-set lint and CodeQL.

Known limits are stated rather than hidden: the extension has no automated
test that reaches the real browser, the Windows installer is unsigned, and
macOS signing/notarization depends on secrets the maintainer must provide.
See [SECURITY.md](./SECURITY.md#known-limits-not-bugs) and
[docs/MATURITY.md](./docs/MATURITY.md).

**Node 20 is end-of-life upstream.** It remains in the CI matrix for
compatibility with the declared `>=20` floor; Node 22 or 24 is recommended for
development. Moving the floor is tracked in [ROADMAP.md](./ROADMAP.md).

## What this repo is

aipass is two layers, and it matters which is which.

**Our work — the desktop window and the harness.** This is the product.

- **`desktop/`** — the window: projects, a chat list, transcripts that resume
  and fork, per-file diff approval, plan cards, permission modes, a file panel,
  playbooks, plugins. Thai-first, dark and light.
- **`aipass-bridge/harness/`** — the agent core: the run loop, the file tools,
  the marker protocol, sessions on disk, the compaction budget, permissions and
  path rules, the WAF, providers, plugins, MCP. The window drives the harness;
  `aipass agent` drives the same one; the VS Code panel in
  [`ide-extension/`](./ide-extension/README.md) drives the same backend — the
  surfaces cannot drift apart.

**The bridge, the Chrome extension and the CLI are upstream, and we extend
them.** They started life as
**[niawjunior/aipass-bridge](https://github.com/niawjunior/aipass-bridge)** by
[niawjunior](https://github.com/niawjunior) — an MIT-licensed project this
repository continues. That code stays under niawjunior's copyright, credited in
[LICENSE](./LICENSE). Here we keep it running, extend it where the harness
needs more of it (loopback auth, the WAF table, the provider contract, the
doctor), and stay compatible with it. The bridge is the transport; the harness
is the product.

One settings file — `~/.aipass/settings.json` — is shared by the window, the
CLI and the agent, so a change is true everywhere immediately.

Influences beyond that: the session storage borrows its JSONL-per-session shape
from the pi coding agent, and the permission/hook vocabulary and the
tool-writing guidance (token-efficient results, head+tail clipping) follow the
published agent-tool literature. Those are influences on the design, not code
taken from anywhere.

## What this repo does well

These are the parts worth having. Each one is a decision the repository holds
itself to — most of them have a test that would notice if they broke.

**The agent is reviewable, not a black box.** Every tool call is a row you can
open; every pending edit is a file with a checkbox and a real diff; the plan
card shows what is done and what is not. The stop button ends the *work* — the
tool of the reply that was running, the command in flight (with its tree), the
web search, the MCP call, the run that had just started — and the window says
what the stop found, instead of going quiet.

**Nothing lands on disk without you.** The overlay is the only write surface of
a run: a dry run shows the diff and writes nothing, and an edit lands only when
you tick it. The sandbox projection lives *outside* your project, so a copy of
your source can never be committed by accident.

**It is honest about what the upstream can do.** The endpoint takes one user
message and owns the conversation history, so the harness keeps its own
session log, summarises and rotates when the context fills, and never pretends
there is a message array to manage. It works around the edge instead of
against it.

**The window and the terminal cannot drift.** One harness, one settings file
(`~/.aipass/settings.json`), one run. The window drives the harness; `aipass
agent` drives the same one; a change in the settings file is true everywhere
immediately. The tests drive both surfaces, not a mock of either.

**The credential never leaves your browser.** The request runs as ordinary page
JavaScript inside your own logged-in tab, so the site's cookie rides along by
itself — the bridge never sees it and stores nothing. The loopback token is
`0600` in your home directory, the settings file holds no secret, and even a
command's *output* is screened before it goes upstream.

**It is honest about its own quality.** `docs/MATURITY.md` names every
capability — production, experimental, not shipped, won't build — with the
evidence and the owner. The eval set carries a holdout, a safety set and
Thai/English pairs; the experiment queue records what was tried, what it cost
and what would change a decision. A capability that stops holding its criteria
is demoted, not quietly kept.

**It runs wherever a Node does.** Zero dependencies, no build step for the
window, nothing to install to run it. The suite is plain `node --test` and it
drives the real bridge as a subprocess with a scriptable stand-in for the
extension, so a green run means the HTTP surface works, not that a mock was
happy. CI runs Windows, macOS and Linux on Node 20, 22 and 24.

**Thai-first, and it says so.** The reply-language policy, the Thai/English
eval pairs and a window written in Thai first — not translated into it.

## Architecture

```text
      ┌───────────────────── ours ─────────────────────┐
      │  desktop window  ──┐                            │
      │  vs code panel   ──┼──▶ harness                  │
      │  aipass agent (CLI)┘    loop · tools · protocol │
      │                           sessions · permissions │
      │                           WAF · providers        │
      └────────────────────┬────────────────────────────┘
                           │ HTTP + SSE, loopback token
      ┌──────── upstream, continued ─────────┐
      │  bridge  127.0.0.1:8787               │
      │  Chrome MV3 extension + keepalive     │
      └────────────────────┬───────────────────┘
                           ▼
             de.aipass.net tab ──▶ /actions/send-message/<id>
```

No credential is stored anywhere: every request runs as ordinary page
JavaScript inside your own logged-in tab, so the site's session cookie rides
along by itself. The bridge has a loopback token of its own — see *The bridge
and the CLI*, below.

## Installing

### What you need

| you need | why |
|---|---|
| **Node ≥ 20** | the only requirement to run it — the app imports `node:*` builtins and nothing else |
| **Chrome** (or Chromium) | the extension is the only thing that ever touches your session |
| **A de.aipass.net account** | the site the window talks to; your logged-in browser tab *is* the credential |
| **Nothing else** | no `npm install` to run it, no build step, no database, no API key |

### One command

From a fresh clone, this is the whole machine setup:

```bash
git clone https://github.com/kasemjeff/TH-aipassport-desktop.git
cd TH-aipassport-desktop
npm run setup
```

(`aipass setup` is the same command, once `aipass` is on your PATH.)

`setup` is idempotent — re-run it any time, and re-running it after moving the
repo repairs the PATH link. It does six things, in this order:

1. **Node** — checks the version and stops if it is too old.
2. **State directory** — creates `~/.aipass/` (`0700`) and mints the loopback
   token at `~/.aipass/.token` (`0600`).
3. **PATH** — puts `aipass` on your PATH: `npm link` on Windows, a symlink
   into `~/.local/bin` or `~/bin` elsewhere (falling back to `npm link`),
   with the manual commands printed if none of that works.
4. **Clipboard** — copies the token, so pasting it into the extension popup
   is one keystroke.
5. **Bridge** — starts it, or adopts the one already running, and waits for
   `/status` to answer.
6. **Browser** — opens `de.aipass.net/chat` and `chrome://extensions`, so the
   two one-time browser steps are in front of you.

### The two browser steps (once per browser)

1. **Load the extension** — `chrome://extensions` → **Developer mode** →
   **Load unpacked** → pick `aipass-bridge/extension`.
2. **Give it the token** — the extension popup → **Advanced** → **Loopback
   token** → paste the contents of `~/.aipass/.token` → save. Then open
   <https://de.aipass.net/chat>, log in, and leave the tab open: that tab is
   what does the talking.

`aipass status` says where you are; `aipass doctor` explains what is missing
and what to do about it.

### The native app

The window runs in any browser today — `npm run desktop` serves it on
`127.0.0.1:8790`. For the real window (tray, native menu, an installer):

```bash
npm run tauri:build     # NSIS on Windows, .app/.dmg on macOS, deb/appimage on Linux
```

The packaged build carries the Node runtime inside it, so the machine that
installs it needs no Node of its own. *Building* it is the part that needs
more: the Rust toolchain and the Tauri CLI (`cargo install tauri-cli --version
"^2"`). The whole procedure — sidecars, signing, what each platform ships —
is [`docs/INSTALL.md`](./docs/INSTALL.md).

There is no published installer yet. Until the first release is tagged, build
from source as above; the release checklist is
[`docs/RELEASE.md`](./docs/RELEASE.md).

### Where the state lives

`~/.aipass/` — settings, sessions, plugins, uploads, logs, the token. Nothing
outside your project is touched, and the token is the only secret: the key of
an added API provider lives in `~/.aipass/credentials.json` (owner-only) or in
the environment, never in `settings.json`.

### Uninstalling

```bash
rm -f ~/.local/bin/aipass      # or: npm rm -g aipass, if you used npm link
rm -rf ~/.aipass               # only if you want the sessions and settings gone too
```

Remove the extension from `chrome://extensions`, and the app from your
desktop.

## Quick start

With the machine set up — see [Installing](#installing) — the window is one
command:

```bash
npm run desktop     # the desktop window (starts the bridge itself if needed)
# or
aipass desktop
```

It starts the bridge if it is not already up, starts the backend on
`127.0.0.1:8790`, and opens the window. See *The desktop window*.

The terminal, if you want it:

```bash
aipass dev          # the bridge alone, logs in this terminal (Ctrl+C to stop)
aipass              # the chat TUI, in a second terminal
aipass agent "task" # the file agent from the command line
```

An editor person? [`ide-extension/`](./ide-extension/README.md) installs a
**VS Code panel** that drives the same agent from the editor — send a task,
watch the run, approve the staged changes, without leaving the window.

`aipass` lives at `aipass-bridge/bin/aipass.mjs`; without putting it on your
PATH, `node aipass-bridge/bin/aipass.mjs` is the same thing.

One tip for long runs: Chrome **Settings → Performance → Always keep these
sites active → add `de.aipass.net`**, so a run is never frozen mid-stream.

## The desktop window

`npm run desktop` (or `aipass desktop`) starts a small local backend on
`127.0.0.1:8790` and opens the window. `desktop/ui/` is plain HTML/CSS/JS —
no build step, open it in a browser to poke at a change. To produce the native
app instead: `npm run tauri:dev` / `npm run tauri:build` (see
[`desktop/README.md`](./desktop/README.md)).

What it holds:

- **Sessions** — resume, rename, fork; transcripts replay from disk, per
  project.
- **Diffs per file** — the agent stages edits in an overlay; you see real diffs
  and write only the files you tick.
- **Plan cards** and permission modes — `ask` / `auto` / `yolo`, with plan mode
  on top (`Shift+Tab` cycles ask → auto → plan).
- **The effort chip** — the thinking level (`off` … `max`) sits in the composer
  next to the model select, because how hard a model thinks is a per-message
  decision, not a buried setting.
- **Files and attachments** — walk the project tree, attach files, paste or
  drop images.
- **Plugins** — one `.mjs` per plugin in `~/.aipass/plugins`; a working
  scratchpad example ships in
  [`desktop/plugins-example/notes.mjs`](./desktop/plugins-example/notes.mjs).
- **Thai-first, dark/light**, with credit and context meters in the header.

Settings live in `~/.aipass/settings.json`; the gear in the header edits them as
a form, and `settings.get` / `settings.set` do the same thing from a script.

The window is where the harness becomes usable: every capability below is
reachable from it, and the window is what the harness was built to serve.

## The harness

The harness is the agent core — the part that turns a model into an agent that
can work in your project. The window drives it; `aipass agent` drives the same
one.

`aipass agent "task"` — or a run in the window — turns the model into a file
agent working in the current project. The model asks, the harness acts:

| Request | What happens |
|---|---|
| `NEED dir <path>` · `NEED file <path> [start-end]` | list a directory / read a file, a screen at a time |
| `SEARCH <text>` | grep-style search, `.gitignore` aware, big files skipped |
| `GLOB <pattern>` | find files by pattern |
| `SYMBOLS <file>` · `DEF <name>` · `REFS <name>` | code navigation: list a file's declarations, find a definition, find references (zero-dependency regex index) |
| `GIT <subcommand>` | read-only git inspection |
| `FETCH <url>` | read a URL — private and internal hosts refused |
| `WEB <query>` | live web search with citations |
| `CREATE` · `EDIT` · `DELETE` · `MOVE` | staged file changes — only applied per your approval |
| `RUN … END` | a shell command — only when shell is allowed |
| `ATTACH <file>` | send a file along with the message |
| `SUBAGENT ... END` | hand a self-contained piece to a helper (`role: verifier/reviewer/summariser`); add `background: true` to run it beside you, then poll with `JOBS` |
| `MCP__<server>__<tool>` | a tool from a configured MCP server (stdio) — see `~/.aipass/mcp.json` |

What the harness itself owns:

- **The run loop** — with guards for repeats, errors, stagnation and unfinished
  work, and budgets on steps, tool calls and wall-clock.
- **The file tools and the overlay** — every edit is staged in memory first;
  nothing lands on disk without an explicit apply.
- **Sessions on disk** — JSONL, one file per session, replayable, resumable,
  forkable; headers are honest about what they hold.
- **Compaction** — a per-model context budget you can see, summarise-and-rotate
  when it fills, and a tier of facts carried across rotations.
- **Permissions** — `ask` / `auto` / `yolo`, path rules that can veto reads and
  writes by glob (the **กฎไฟล์** page in the window), and a secret floor that
  holds in every mode.
- **Providers** — AiPASS through the local bridge, or any other API provider
  (`~/.aipass/providers.json`; keys in `~/.aipass/credentials.json`, owner-only,
  or in the environment).
- **The WAF** — risky spellings are shortened on the way out and restored on
  the way in, so an upstream block doesn't silently kill a run.

Guardrails that keep long tasks honest: nothing lands on disk before you
approve it, `RUN` needs the permission mode and `allowRun`, and every run
carries caps on steps, tool calls and wall-clock.

Extra capabilities available to the agent: **code navigation**
(`SYMBOLS`/`DEF`/`REFS` over a zero-dependency regex index), **MCP tools**
(`MCP__<server>__<tool>` from servers in `~/.aipass/mcp.json`), **background
helpers** (`SUBAGENT` with `background: true`, polled via `JOBS`), **cross-session
memory** (facts persisted per project, loaded into the next session's first
turn), and **test-time scaling** (`aipass scale "task" --n N`). Each has an
off-switch or is opt-in; see `docs/MATURITY.md`.

The design of record is [`docs/HARNESS_DESIGN.md`](./docs/HARNESS_DESIGN.md)
(the system end to end) and [`docs/LOOP_DESIGN.md`](./docs/LOOP_DESIGN.md) (the
loop itself: stage map, guards, stop reasons, the event stream).

## The bridge and the CLI

This layer is upstream — **[niawjunior/aipass-bridge](https://github.com/niawjunior/aipass-bridge)**
— and this repository continues it. The harness talks to it through one
contract; the window and the CLI sit on the same contract.

The bridge is OpenAI-compatible, so anything that speaks the API can use your
AIPASS account through your browser session:

- `POST /v1/chat/completions` — streaming and not
- `GET /v1/models` — what the account can talk to

It binds `127.0.0.1:8787` by default. Every route except the health probes
(`/status`, `/health`) requires the loopback token minted once at
`~/.aipass/.token` — the bridge prints the path at boot, and the extension
popup (**Advanced**) takes the token once. The CLI and the desktop backend
read the file themselves. `AIPASS_TOKEN` sets an explicit value;
`AIPASS_REQUIRE_AUTH=0` goes back to tokenless, loopback-only operation.

### The terminal

`aipass` opens the chat TUI. Streaming markdown, reasoning folds, prompt
queueing while a run is going, `Esc` to stop, attachments, and a slash palette
that opens the moment you type `/`.

| Slash command | Does |
|---|---|
| `/model`, `/models` | switch model / list what the account can talk to |
| `/thinking` | reasoning level: `off` · `low` · `medium` · `high` · `max` |
| `/temperature` | sampling temperature `0..2`, or `default` |
| `/conversations`, `/new` | switch conversation / start a fresh one |
| `/tone`, `/format` | response tone / response format |
| `/styles`, `/image-style`, `/video-style` | generation style presets |
| `/credits` | credit quota of the account |
| `/doctor` | diagnostics for the bridge, the extension and the models |
| `/assistant` | select a custom assistant |
| `/agent`, `/agent-root` | hand the turn to the file agent / set its root |
| `/file`, `/image`, `/clip` | attach media to the next message |
| `/clear`, `/help` | clear the screen / palette help |

The CLI is also the way into the harness: `aipass agent "task"`, `aipass scale`,
`aipass providers`, `aipass memory`, `aipass mcp`, `aipass plugin`. The full
command list, the conversation rules and the known limits live in
[`aipass-bridge/README.md`](./aipass-bridge/README.md).

## Configuration

`aipass-bridge/.env.example` has the full list. The usual ones:

| Variable | Default | Purpose |
|---|---|---|
| `AIPASS_PORT` / `AIPASS_HOST` | `8787` / `127.0.0.1` | where the bridge listens |
| `AIPASS_MODEL` | `gemini-3.1-flash-lite` | model when a request names none |
| `AIPASS_MODEL_FILTER` | `all` | `chat` narrows the model list to text-drivable models |
| `AIPASS_CONVERSATION_ID` | — | pin one conversation instead of "most recent" |
| `AIPASS_ASSISTANT_ID` | — | bind new conversations to a custom assistant |
| `AIPASS_TOOL_VISIBILITY` | `reasoning` | `reasoning` · `text` · `off` |
| `AIPASS_IDLE_TIMEOUT_MS` | `180000` | when a quiet run counts as idle |
| `AIPASS_BRIDGE_IDLE_MS` | `600000` | the bridge exits itself when nothing uses it; `0` never exits |
| `AIPASS_MEDIA_TIMEOUT_MS` | `900000` | how long a generation may take |
| `AIPASS_TOKEN` / `AIPASS_REQUIRE_AUTH` | `~/.aipass/.token` / on | loopback bearer token (see *The bridge and the CLI*) |
| `AIPASS_CORS_ORIGIN` | — | allow one browser origin (off by default) |

The window and the CLI keep their state in `~/.aipass/` (settings, sessions,
plugins, uploads, logs).

## Documentation

The design and operations docs live in [`docs/`](./docs/):

| Doc | What it holds |
|---|---|
| [`docs/HARNESS_DESIGN.md`](./docs/HARNESS_DESIGN.md) | the harness end to end: loop, tools, protocol, permissions, WAF — and how it sits on the bridge and the window; the research rounds and the incident log behind that shape are its Appendix A |
| [`docs/LOOP_DESIGN.md`](./docs/LOOP_DESIGN.md) | the agent loop itself: stage map, guards, stop reasons, the event stream |
| [`docs/SPEC_CHECKER.md`](./docs/SPEC_CHECKER.md) | the checker: the read-only pass a `DONE` earns, verdicts, the declared check |
| [`docs/SPEC_EVALS.md`](./docs/SPEC_EVALS.md) | the eval runner: task fixtures, live and replay modes, scoring |
| [`docs/EXPERIMENTS.md`](./docs/EXPERIMENTS.md) | the experiment queue: sources, records, budgets, when an experiment ends |
| [`docs/TECH_STACK.md`](./docs/TECH_STACK.md) | what runs where, and the reasons each piece is what it is |
| [`docs/DATA_FORMATS.md`](./docs/DATA_FORMATS.md) | what lands on disk: settings, session JSONL, the token, uploads, eval results |
| [`docs/TROUBLESHOOTING.md`](./docs/TROUBLESHOOTING.md) | when something is broken: doctor, the common failures, where the logs are |
| [`docs/RELIABILITY.md`](./docs/RELIABILITY.md) | what healthy means: the SLIs and their targets, the error budget, degradation modes |
| [`docs/RELEASE.md`](./docs/RELEASE.md) | versioning, the release checklist, upgrade and rollback, dependency review |
| [`docs/INSTALL.md`](./docs/INSTALL.md) | the install system: what an install guarantees, what each platform ships, what macOS needs |
| [`docs/UPDATE_DESIGN.md`](./docs/UPDATE_DESIGN.md) | the update system: the shell and the content as two versioned halves, the signed feed, the phases |
| [`docs/MATURITY.md`](./docs/MATURITY.md) | capability status — production vs experimental, owners, what changes a status |
| [`docs/TEST_PLAN.md`](./docs/TEST_PLAN.md) | the test design: layers L1–L5, cases, pass criteria, what each layer cannot prove |
| [`docs/CONFIG.md`](./docs/CONFIG.md) | every switch the product reads — env vars, settings keys, harness options — held equal to the code by a test |
| [`docs/EVENTS.md`](./docs/EVENTS.md) | every event the harness emits, who fires it and who reads it — held equal to the code by a test |
| [`docs/UX.md`](./docs/UX.md) | the UX design for the CLI, the window, the extension popup and first-run setup, with what has shipped |
| [`docs/PLUGINS_MCP_DESIGN.md`](./docs/PLUGINS_MCP_DESIGN.md) | how plugins and MCP servers are installed, enabled, updated and removed |
| [`docs/META_HARNESS.md`](./docs/META_HARNESS.md) | the harness tuning itself: the meta loop that turns eval evidence into harness changes |
| [`docs/FEATURE_GAPS.md`](./docs/FEATURE_GAPS.md) | the gap list a batch of work closes — every row names the test that proves it |

The behavior-level change history is [`CHANGELOG.md`](./CHANGELOG.md); it is
what release notes are cut from.

Component-level docs sit next to their code:
[`aipass-bridge/README.md`](./aipass-bridge/README.md) (the upstream bridge and
CLI), [`aipass-bridge/docs/DOCS.md`](./aipass-bridge/docs/DOCS.md),
[`desktop/README.md`](./desktop/README.md) (the window and native builds), and
[`ide-extension/README.md`](./ide-extension/README.md) (the VS Code panel). For
contributing see [`CONTRIBUTING.md`](./CONTRIBUTING.md); for reporting a
vulnerability, [`SECURITY.md`](./SECURITY.md).

## Repo layout

```text
aipass/
├─ desktop/                 the window — ours
│  ├─ main.mjs              bridge (if needed) + backend on :8790 + window
│  ├─ ui/                   plain HTML/CSS/JS — no build step
│  ├─ src-tauri/            native shell: tray, sidecar node, bundles
│  └─ plugins-example/      a plugin worth copying
├─ aipass-bridge/           the upstream layer, continued
│  ├─ harness/              the agent core — ours
│  │                        loop · tools · overlay · protocol · waf
│  │                        sessions · compaction · permissions · providers
│  ├─ bridge/               local HTTP + SSE server (upstream)
│  ├─ extension/            Chrome MV3 worker + content script + keepalive
│  ├─ bin/aipass.mjs        the `aipass` command (upstream)
│  ├─ chat.mjs              the terminal chat client (upstream)
│  └─ agent.mjs             the file agent — a thin front for the harness
├─ docs/                    design and operations docs — see Documentation above
├─ evals/                   task fixtures — smoke set, holdout, Thai/English pairs
├─ experiments/             the experiment queue: what was tried, what it cost
├─ ide-extension/           the VS Code panel — one more surface on the same backend
├─ scripts/                 test runner, QA loop, verify, evals, the build lanes
├─ public/                  static pages and the README image
└─ package.json             npm run shortcuts — nothing to install
```

## Development

```bash
npm run setup       # first-run machine setup: Node, PATH, token, bridge, browser pages
npm test            # the whole suite (bridge, extension, harness, window logic)
npm run typecheck   # the files that opt in with // @ts-check
npm run agents:lint # this guide: anchors, shims, size budgets
npm run docs:check  # every relative Markdown link resolves
npm run coverage:gate # the per-file coverage floors
npm run check       # agents:lint + suite + qa + coverage + docs — the pre-push set
npm run dco         # every commit in the branch carries Signed-off-by
npm run qa          # static checks + suite + fake-DOM window + live status
npm run verify      # suite + a sandboxed live smoke of the bridge and backend
npm run evals       # score agent runs against task checks
```

The tests are plain `node --test` — no framework, no dependencies. Every
human commit needs a DCO sign-off (`git commit -s`); see
[CONTRIBUTING.md](./CONTRIBUTING.md).

## Community and support

- **Questions, setup help, ideas** — [GitHub Discussions](https://github.com/kasemjeff/TH-aipassport-desktop/discussions).
- **Bugs and feature requests** — use the issue templates. Include the full
  `npm run doctor` output for a bug.
- **Support expectations and the not-supported list** — [SUPPORT.md](./SUPPORT.md).
- **Code of Conduct** — [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md).
- **Who decides what** — [GOVERNANCE.md](./GOVERNANCE.md) and
  [MAINTAINERS.md](./MAINTAINERS.md).
- **Privacy: no telemetry** — [PRIVACY.md](./PRIVACY.md).
- **Trademarks and non-affiliation** — [TRADEMARK.md](./TRADEMARK.md).
- **Migrating from the upstream project** — [docs/MIGRATION.md](./docs/MIGRATION.md).

## Contributing

Pull requests are welcome. The short version:

1. Read [CONTRIBUTING.md](./CONTRIBUTING.md) and the
   [Code of Conduct](./CODE_OF_CONDUCT.md).
2. Sign off every commit: `git commit -s` (Developer Certificate of Origin).
3. Run `npm test`, `npm run typecheck`, `npm run agents:lint` and
   `npm run docs:check` before opening the PR.
4. Keep the core dependency-free and add a test with every behavior change.

The CI must be green; a maintainer reviews and merges with a merge commit
(never a squash), so authorship stays intact.

## Security

Do **not** open a public issue for something exploitable. Use
[private vulnerability reporting](https://github.com/kasemjeff/TH-aipassport-desktop/security/advisories/new)
and follow [SECURITY.md](./SECURITY.md). The security model, supported
versions and the inherited upstream incident record are in that file.

## Credits & license

**This repository** — the desktop window (`desktop/`), the harness
(`aipass-bridge/harness/`), the sessions, the agent protocol, the eval and
experiment tooling, and the docs. **kasemjeff** is the sole contributor; see
[AUTHORS.md](./AUTHORS.md).

**Upstream, continued** — the bridge, the Chrome extension and the CLI, from
**[niawjunior/aipass-bridge](https://github.com/niawjunior/aipass-bridge)**.
The upstream copyright holders are **niawjunior**, **Pheem49** and the other
`aipass-bridge` authors. Their notices are preserved in [LICENSE](./LICENSE)
and [NOTICE](./NOTICE), with provenance in [CREDITS.md](./CREDITS.md).
They are credited for the upstream code, not listed as contributors to this
repository.

This continuation is released under the [MIT License](./LICENSE). Release
artifacts bundle Node.js, Tauri, Rust crates and platform libraries; see
[THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).
