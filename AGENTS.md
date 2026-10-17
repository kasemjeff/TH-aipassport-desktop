# AGENTS.md

> Working guide for every AI in this repository — Claude Code, Codex, opencode,
> Cursor, Gemini CLI, Copilot agents, and whoever comes next. Claude Code reads
> `CLAUDE.md`, which imports this file.
>
> **Verify with `npm test` from the repo root.** The suite must end green before
> any handoff. Tests are the shared truth, this file is the shared law, session
> reports are the shared news. When they disagree, the tests win.
>
> Nested files add local law: `aipass-bridge/AGENTS.md`,
> `aipass-bridge/test/AGENTS.md`, `desktop/AGENTS.md`. Read the nearest file
> before touching the code it covers. Machine-local quirks live in
> `AGENTS.local.md` (git-ignored).

## What this repo is

- **`aipass-bridge/`** — the product: a zero-dependency Node bridge plus a
  Chrome MV3 extension that lets a terminal talk to `de.aipass.net`'s chat,
  with streaming, through an already-logged-in tab. `harness/` is the pi-style
  session agent the desktop window drives; `bin/aipass.mjs` is the CLI
  dispatcher.
- **`desktop/`** — wraps the same `.mjs` files in a Tauri window; `desktop/ui/`
  is a zero-build plain-JS chat UI.
- Not to be confused with `aipass.alkinum.io` — different product. Runtime
  truth lives in `~/.aipass` (sessions, logs, `bridge.pid`, `.token`).
- Everything imports `node:*` builtins only. `npm install` installs nothing
  and that is deliberate. The root `package.json` is a script runner.

## Run & verify

| command | what it does |
|---|---|
| `npm test` | full suite (`scripts/test.mjs`) — ~20–30 s. Must end `fail 0`; one skip when git is absent. |
| `node --check <file>` | syntax gate — run on every file you touched before the suite. |
| `node --test aipass-bridge/test/<name>.test.mjs` | one test file while iterating. |
| `npm run agents:lint` | checks this guide itself: Verify anchors resolve, shims point at the canon, size budgets hold. |
| `npm run qa` | heavier pass: static wiring + suite + window logic + live backend. |
| `npm run desktop` | bridge + harness backend + the window in a browser. |
| `npm run dev` | the bridge on `:8787` alone (leave running). |
| `npm run chat` / `agent -- "task" --root .` / `models` / `conversations` | terminal clients. `agent` is a dry run; add `--apply` to write, `--allow-run` for RUN. |

Upstream work needs the unpacked extension (`aipass-bridge/extension/`) loaded
in Chrome **and** an open `https://de.aipass.net/chat` tab. `GET /status` shows
`extensions: 0` when unattached — the CLIs exit early in that case.

## Hard rules

Format: rule — why — `Verify:` anchor naming the exact test that enforces it.

1. **The overlay is the only write surface of a run.** Edits land in memory;
   only an explicit apply (`--apply`, or the window's apply button) writes real
   files. Sandbox projections junction heavy dirs and copy the rest — nothing
   real is ever written mid-run.
   Verify: "dry run shows a diff but writes nothing; --apply writes"
   Verify: "a heavy directory is linked, not copied, and staged files sit beside it"
2. **Every tool path is confined to the project root** (`safe()`/`trySafe()`);
   a path that escapes answers `err:` and touches nothing.
   Verify: "refuses to touch anything outside the project root"
3. **A tool failure starts with `err:`** — the loop keys on that one word.
   Never invent a new failure phrase a regex somewhere has to learn.
   Verify: "failures carry the err: prefix the loop keys on"
4. **WAF substitution is symmetric and single-sourced**
   (`harness/waf.mjs`): any edit to one direction needs the other; bytes must
   round-trip exactly, Thai included. Never fork the table into another file.
   Verify: "every substitution has a matching restore, and vice versa"
5. **The one-message constraint drives the bridge design.** The upstream
   endpoint rejects a `messages` array containing an assistant turn and
   rejects agent-style system prompts. `lastUserText()` forwards only the
   newest user message; multi-turn works solely because the server owns the
   conversation history. Design around it, never against it.
6. **Credentials never reach the bridge.** Authenticated fetches happen in
   `page.js` (MAIN world) with `credentials: 'include'`; the bridge and CLIs
   speak to localhost only. Don't add a path that carries cookies.
7. **Loopback auth is on by default.** Token at `~/.aipass/.token`;
   `AIPASS_REQUIRE_AUTH=0` is for tests/transition only (it warns at boot).
   The window fetches `/token` and sends it on both transports.
   Verify: "the window carries the loopback token on both transports"
8. **Session JSONL keeps the header honest.** `entryCount` may lag, never
   overstate; headers are padded to a fixed block and rewritten in place;
   `HEADER_EVERY = 25` batches the rewrite; bad lines are skipped on load and
   a duplicated entry id loads once.
   Verify: "append batches the header rewrite, and rename still fixes it at once"
9. **Nothing blocks the backend's event loop.** fs walks, child processes and
   tree copies in the backend process use async spawn/`fs.promises` — a
   `spawnSync`/`readdirSync` on a big tree freezes every window call. Spill
   output lives in `.aipass/spill/`: hidden from listings/search, still
   readable by its locator.
   Verify: "the spill directory is out of every listing, but still readable"
10. **Windows-clean or it doesn't ship**: no `/bin/sh` assumptions, no `diff`
    binary dependency, `windowsHide` on every spawn, junctions (not symlinks)
    for directories.
11. **Zero dependencies, zero toolchain.** Adding an npm package or a
    lint/format config needs human sign-off.
12. **UI prose policy**: markers are wire protocol, never rendered text; a
    DONE is said exactly once.
    Verify: "the bubble holds the prose, never the wire — calls live in their rows"
    Verify: "a DONE is said once — streamed prose and the harvested summary never double"

## Working with other sessions

The checkout is shared; sessions run in parallel. These rules are how AIs here
stay compatible:

1. **Dirty ≠ yours.** Run `git status --short` and `git diff` on a file before
   editing it. Uncommitted changes you did not make this session are
   read-only.
2. **The human owns git shape.** No `git add -A` / `git add .` /
   `git commit -a` / `git checkout --` / `git stash` / `git reset` /
   `git clean`, ever, unless the human explicitly asks. Standing policy for
   this repo: do not commit.
3. **Targeted edits only.** Never rewrite or reformat a file wholesale. If you
   must touch a file that carries foreign WIP, keep your hunks disjoint and
   name that file in your report.
4. **Untracked files are undelivered work.** Read them if useful; never edit
   or delete them.
5. **End-of-session report** — five items, no more: files touched · tests run
   + result · deliberately deferred items with reasons · open risks · cleanup
   done (processes, temp dirs). For handoffs that must outlive the chat,
   append the same five items to `docs/WORKLOG.md` (newest first).
6. **Escalate instead of guessing** on destructive git, deleting files, new
   dependencies, loosening any rule in this system. Tightening and
   fact-corrections are always welcome.

## Where truth lives

- `aipass-bridge/docs/DOCS.md` — full internals: job hub, extension contexts,
  TUI mechanics, WAF encoding, HTTP API, an end-to-end trace. Read before
  non-trivial bridge changes.
- `docs/HARNESS_DESIGN.md`, `docs/LOOP_DESIGN.md` — design of record for the
  harness and the loop. `docs/SPEC_EVALS.md`, `docs/SPEC_CHECKER.md` — evals
  and the DONE checker.
- `docs/DATA_FORMATS.md` — session/log formats. `docs/TROUBLESHOOTING.md` —
  failure playbook. `docs/RELIABILITY.md` — SLIs, the error budget, what
  degrades and how. `docs/TECH_STACK.md`, `docs/RELEASE.md` — stack and
  release procedure. `SECURITY.md` — auth model. `CHANGELOG.md` —
  behavior-level changes; update it in the same change that changes behavior.
- `docs/WORKLOG.md` — session handoff log (newest first): the same five items
  as the end-of-session report.
- Rule: a change that invalidates any file above (or a rule here) updates it
  in the same change. Doc drift is a bug.

## Style

- Comments explain **why**, with a reference when one exists (issue number,
  test title, paper). Match the surrounding density; never restate the code.
- Code, comments and docs in English. Reports to the human in Thai — short and
  factual.
- No lint, no format config, no build step. Keep it that way.

## Gotchas

- Don't put `node -e "…"` (or other code-execution shapes) in `package.json`
  scripts — the agent reads `package.json` early and such a field gets the
  whole read refused upstream; that is why `list.mjs` exists.
- `*.har`, `aipass*.md`, `apipass*.md` are git-ignored: API captures contain
  live session cookies. Never commit captures.
- The bridge refuses cross-origin browser callers unless `AIPASS_CORS_ORIGIN`
  names them; every route except `/status`/`/health` requires the bearer
  token.
- PowerShell: `node -e` quoting breaks — write a temp `.mjs` file instead.
  `git show > file` redirection yields UTF-16 — read via the editor, not a
  redirect.

## Rule format & freshness

- An enforced rule ends with `Verify: "exact test title"` — the literal string
  from the test file. `scripts/agents-lint.mjs` (`npm run agents:lint`) checks
  every anchor against the suite, the shim files and the size budgets;
  `test/agents-docs.test.mjs` runs the same check inside `npm test`. If you
  rename a test, grep the `AGENTS.md` files for the old title and update the
  anchors in the same change.
- Nothing transient here. Current WIP, temporary file lists and today's bugs
  are news: they go in the session report (durable ones in `docs/WORKLOG.md`),
  not this file.
- Agents may tighten or correct this file; loosening a rule needs the human.
- Bump `Last verified:` below when the full suite ran green.

Last verified: 2026-10-17 — full suite ran green from a clean run. The exact
count moves as tests land (other sessions work here in parallel); don't record
it in this file — `npm test` is the number.
