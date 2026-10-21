# AGENTS.md

> Working guide for every AI in this repository — Claude Code, Codex, opencode,
> Cursor, Gemini CLI, Copilot agents, and whoever comes next (`CLAUDE.md`
> imports this file).
>
> **Verify with `npm test` from the repo root.** The suite must end green before
> any handoff. Tests are the shared truth, this file is the shared law, session
> reports are the shared news. When they disagree, the tests win.
>
> Nested files add local law: `aipass-bridge/AGENTS.md`, `aipass-bridge/test/AGENTS.md`,
> `desktop/AGENTS.md` — read the nearest one before touching the code it covers.
> Machine-local quirks live in `AGENTS.local.md` (git-ignored).

## What this repo is

- **`desktop/` + `aipass-bridge/harness/`** — the product, and this repository's own
  work: the window (a zero-build plain-JS chat UI in a Tauri shell) and the agent core.
- **`aipass-bridge/` (bridge, extension, CLI)** — upstream (niawjunior/aipass-bridge),
  continued under niawjunior's copyright (`LICENSE`): the zero-dependency bridge
  and the Chrome MV3 extension that reach `de.aipass.net`; `bin/aipass.mjs` is the CLI.
- Not to be confused with `aipass.alkinum.io` — a different product. Runtime
  truth lives in `~/.aipass` (sessions, logs, `bridge.pid`, `.token`).
- Runtime code imports `node:*` builtins only; `npm install` fetches just the
  devDependencies behind `npm run typecheck`. The root `package.json` is a script runner.

## Run & verify

| command | what it does |
|---|---|
| `npm test` | full suite (`scripts/test.mjs`) — ~20–30 s. Must end `fail 0`; one skip when git is absent. |
| `node --check <file>` | syntax gate — run on every file you touched before the suite. |
| `node --test aipass-bridge/test/<name>.test.mjs` | one test file while iterating. |
| `npm run agents:lint` | checks this guide itself: Verify anchors resolve, shims point at the canon, size budgets hold. |
| `npm run qa` | heavier pass: static wiring + suite + window logic + live backend. |
| `npm run coverage:gate` | the floor under the window's and the backend's coverage: a file that stops being watched fails. |
| `npm run desktop` / `npm run dev` | bridge + harness backend + the window in a browser; `dev` is the bridge on `:8787` alone (leave running). |
| `npm run chat` / `agent -- "task" --root .` / `models` / `conversations` | terminal clients. `agent` is a dry run; add `--apply` to write, `--allow-run` for RUN. |

Upstream work needs the unpacked extension (`aipass-bridge/extension/`) loaded in
Chrome **and** an open `de.aipass.net/chat` tab (`/status` shows `extensions: 0`).

## Hard rules

Format: rule — why — `Verify:` anchor naming the exact test that enforces it.

1. **The overlay is the only write surface of a run.** Edits land in memory;
   only an explicit apply (`--apply`, or the window's apply button) writes real
   files. Sandbox projections junction heavy dirs and copy the rest, and the
   projection lives OUTSIDE the project (`~/.aipass/run/`), so a copy of the
   user's source can never be committed by accident. The RUN says what it did.
   Verify: "dry run shows a diff but writes nothing; --apply writes"
   Verify: "a heavy directory is linked, not copied, and staged files sit beside it"
   Verify: "the projection lives outside the project"
2. **Every tool path is confined to the project root** (`safe()`/`trySafe()`); a
   path that escapes answers `err:` and touches nothing — LEXICALLY and PHYSICALLY.
   Verify: "refuses to touch anything outside the project root"
   Verify: "a path that differs only in case is inside the project"
   Verify: "a link out of the project is a link out of the root"
3. **A tool failure starts with `err:`** — the loop keys on that one word; never
   invent a new failure phrase a regex has to learn.
   Verify: "failures carry the err: prefix the loop keys on"
4. **WAF substitution is symmetric and single-sourced** (`harness/waf.mjs`): an
   edit to one direction needs the other; bytes round-trip exactly, Thai included.
   Verify: "every substitution has a matching restore, and vice versa"
5. **The one-message constraint drives the bridge design.** The upstream endpoint
   rejects a `messages` array with an assistant turn and agent-style prompts;
   only the newest message is forwarded, and multi-turn works server-side.
6. **Credentials never reach the bridge.** Authenticated fetches happen in
   `page.js` (MAIN world) with `credentials: 'include'`; the bridge and CLIs
   speak to localhost only. A command's OUTPUT is screened (output-scrub.mjs).
   Verify: "a command output is screened for secrets"
7. **Loopback auth is on by default.** Token at `~/.aipass/.token`;
   `AIPASS_REQUIRE_AUTH=0` is for tests only (it warns at boot). The window
   sends it on both transports; a bridge client presents it to loopback only.
   Verify: "the window carries the loopback token on both transports"
8. **Session JSONL keeps the header honest.** `entryCount` may lag, never
   overstate; headers are padded to a fixed block and rewritten in place
   (`HEADER_EVERY = 25` batches it); bad lines are skipped, duplicates load once.
   Verify: "append batches the header rewrite, and rename still fixes it at once"
9. **Nothing blocks the backend's event loop.** fs walks, child processes and
   tree copies use async spawn/`fs.promises` — a `spawnSync`/`readdirSync` on a
   big tree freezes every window call. Spill output lives in `.aipass/spill/`,
   hidden from listings but still readable by its locator.
   Verify: "the spill directory is out of every listing, but still readable"
10. **Windows-clean or it doesn't ship**: no `/bin/sh` assumptions, no `diff`
    dependency, `windowsHide` on every spawn, junctions for directories.
11. **Zero dependencies, zero toolchain.** An npm package or a lint config needs human sign-off.
12. **UI prose policy**: markers are wire protocol, never rendered text; a DONE
    is said exactly once, and so is the step's headline (`desktop/AGENTS.md`).
    Verify: "the bubble holds the prose, never the wire — calls live in their rows"
    Verify: "a DONE is said once — streamed prose and the harvested summary never double"
    Verify: "the step headline is not said twice — the bubble already holds the prose"
13. **A stop ends the work, not just the conversation.** The stop signal
    reaches every wait: the tools of the running reply (a stopped run stages
    no more edits), the command in flight, the projection a RUN waits for, the
    web search, the MCP call, and a run that just started (its abort controller
    is created before the first `await`, so a stop can never be lost).
    Verify: "a stop ends the tools that were still queued in the reply"
    Verify: "a RUN in flight is killed when the run is stopped"
    Verify: "a stop that lands right after the run started is not lost"
    Verify: "a stopped run stages no more edits"
    Verify: "a stop ends the projection a RUN waits for"
    Verify: "a stop ends an mcp call the server never answers"
    Verify: "a stop is answered on screen — the window says the run is stopping"
14. **A provider is a client, not a second loop.** The harness talks to one
    contract (`harness/bridge.mjs`): chat, models, quota, config,
    createConversation. AiPASS answers it through the local bridge; any other
    provider answers it through `harness/provider-client.mjs`, and the WAF
    table belongs to that edge alone. A key lives in the credentials file.
    Verify: "a provider is not encoded for a firewall that is not there"
    Verify: "the key comes from the environment first and the credentials file second"
15. **An update is a verified thing, never a downloaded one.** The release feed
    is signed with an ed25519 key whose public half is in the source
    (`harness/update-keys.mjs`); a feed that does not verify — or one older
    than the feed already seen — is refused. The content is replaced only by
    a person, only from a signed pack, and only when no run is in flight.
    Verify: "a feed whose signature does not verify is refused"
    Verify: "a feed with an older sequence number is refused"
    Verify: "a content pack is promoted atomically — a failed promotion leaves the old content in place"
    Verify: "an update is never applied while a run is in flight"
16. **The desktop's code stays watched, and its rules stay testable.** The
    launcher's rules live in `harness/launcher.mjs`, not in the entry script:
    an entry script runs its top level on import, so the file that decides
    which backend the window talks to was the one no test could touch. The
    window and the backend carry a coverage floor, and the window answers
    only to methods the backend has.
    Verify: "the desktop port is a port, on both sides"
    Verify: "the launcher names the port that is busy, not a stack trace"
    Verify: "every method the window calls exists on the backend"
17. **A background process ends itself, and a busy port is named.** A detached
    process outlives whatever started it, so it records its own pid and exits
    when nobody uses it — otherwise it is a leak nothing can reach. A taken
    port is a fact about the machine, not a crash: the shell names who holds it.
    Verify: "a bridge nobody is using goes away, and takes its pid file with it"
    Verify: "a busy port is a named condition, not a crash"
18. **The model list heals itself, and says what it is.** The catalog is
    fetched by the extension, in the page, from the site — so a window that
    cannot reach a tab sees a two-model stub. The bridge publishes what the
    list IS (`/status` → `catalog`); the window follows that stamp and never
    loses it to a failed refresh.
    Verify: "the window rebuilds the model list when the bridge says the catalog changed"
    Verify: "a fallback list says why it is a fallback"
    Verify: "a failed model refresh keeps the list it already had"
    Verify: "a fallback catalog is retried while an extension is attached"

## Working with other sessions

The checkout is shared; sessions run in parallel — these rules keep them
compatible:

1. **Dirty ≠ yours.** Run `git status --short` and `git diff` on a file before
   editing it. Uncommitted changes you did not make this session are read-only.
2. **The human owns git shape.** No `git add -A` / `git add .` / `git commit -a`
   / `git checkout --` / `git stash` / `git reset` / `git clean`, ever, unless
   the human asks. Standing policy here: do not commit.
3. **Targeted edits only.** Never rewrite a file wholesale. If you must touch
   one that carries foreign WIP, keep your hunks disjoint and name it in the report.
4. **Untracked files are undelivered work.** Read them if useful; never edit
   or delete them.
5. **End-of-session report** — five items, no more: files touched · tests run
   + result · deferred items with reasons · open risks · cleanup done. Handoffs
   that must outlive the chat append the same five to `docs/WORKLOG.md`.
6. **Escalate instead of guessing** on destructive git, deleting files, new
   dependencies, loosening any rule. Tightening is always welcome.

## Where truth lives

- `aipass-bridge/docs/DOCS.md` — full internals: job hub, extension contexts,
  TUI mechanics, WAF encoding, HTTP API, an end-to-end trace. Read it first.
- `docs/HARNESS_DESIGN.md`, `docs/LOOP_DESIGN.md` — design of record for the
  harness and the loop; `docs/SPEC_EVALS.md`, `docs/SPEC_CHECKER.md` — evals
  and the DONE checker; `docs/REFRESH_DESIGN.md` — the model catalog's refresh.
- `docs/DATA_FORMATS.md`, `docs/TROUBLESHOOTING.md`, `docs/RELIABILITY.md`,
  `docs/EXPERIMENTS.md`, `docs/MATURITY.md`, `docs/TEST_PLAN.md`,
  `docs/TECH_STACK.md`, `docs/RELEASE.md` — formats, the failure playbook,
  the SLIs, the experiment queue, capability status, the test design, the
  stack, the release procedure.
- `SECURITY.md` — auth model. `CHANGELOG.md` — behavior-level changes; update
  it in the same change that changes behavior. `docs/WORKLOG.md` — session
  handoff log (newest first), the same five items as the session report. A
  change that invalidates any file above (or a rule here) updates it in the
  same change: doc drift is a bug.

## Style

- Comments explain **why**, with a reference when one exists (issue, test, paper).
  Match the surrounding density; never restate the code.
- Code, comments and docs in English. Reports to the human in Thai — short and
  factual. No lint, no format config, no build step. Keep it that way.

## Gotchas

- Don't put `node -e "…"` (or other code-execution shapes) in `package.json`
  scripts — the agent reads `package.json` early and such a field gets the read
  refused upstream; that is why `list.mjs` exists.
- `*.har`, `aipass*.md`, `apipass*.md` are git-ignored: captures hold live cookies.
- The bridge refuses cross-origin browser callers unless `AIPASS_CORS_ORIGIN`
  names them; every route except `/status`/`/health` requires the bearer token.
- PowerShell: `node -e` quoting breaks — write a temp `.mjs` file instead.
  `git show > file` redirection yields UTF-16 — read via the editor.

## Rule format & freshness

- An enforced rule ends with `Verify: "exact test title"` — the literal string
  from the test file. `scripts/agents-lint.mjs` (`npm run agents:lint`) checks
  every anchor against the suite, the shim files and the size budgets, and
  `test/agents-docs.test.mjs` runs the same check inside `npm test`. Rename a
  test and the anchors go with it, in the same change.
- Nothing transient here. Current WIP, temporary file lists and today's bugs
  are news: they go in the session report (durable ones in `docs/WORKLOG.md`).
- Agents may tighten or correct this file; loosening a rule needs the human.
  Bump `Last verified:` below when the full suite ran green.

Last verified: 2026-10-21 — full suite ran green from a clean run. The exact
count moves as tests land; don't record it here — `npm test` is the number.
