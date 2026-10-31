# FEATURE_GAPS_WAVE3 — the boundary, the clock, and the review

> The 2026-10-28 comparison against **Claude Code 2.1.312**, **Codex CLI 0.165.0**
> (2026-10-27) and **DeepSeek Harness** (developer preview, master 2026-10-28).
> What the category now treats as table stakes and this harness does not have,
> ordered by what hurts a real user first — a leak outranks a cost, a cost
> outranks a surface. Every row names the test that proves it; a row without a
> test is a wish, not a row.
>
> This is the wave *after* `FEATURE_GAPS.md`. That file is the record of the
> batch that landed on 2026-10-21; it stays as it is.

**Why this wave exists.** The last batch compared against the category as it
stood in October 2026 and closed the cost and safety rows it found. Since then
all three reference harnesses moved in the same direction, and the direction is
not a feature list — it is a **trust boundary**: an OS-enforced box around the
commands the agent runs, a background clock so a long job is not a failed tool,
and a review surface that reads a change without touching it. The window and the
overlay are still this product's edge. The box is the part it does not have.

---

## The category, measured

| capability | Claude Code 2.1.312 | Codex CLI 0.165.0 | DeepSeek Harness | AiPASS today |
|---|---|---|---|---|
| shell boundary | OS-enforced (Seatbelt, bubblewrap; **not** native Windows) [S1] | OS-enforced (Seatbelt, bwrap, Windows sandbox) [S2] | `ctx.sandbox` backends, three modes [S3] | **none** — `shell: true`, a text screen, a 120 s clock [E1] |
| approvals | permission modes + allow/deny rules + classifier [S4] | sandbox modes + approval policies + `auto_review` [S2] | `tools/pre-execute` policy seam [S3] | `ask` / `auto` / `yolo` + path rules [E2] |
| background shell | background commands, shell output after timeout [S5] | background commands on app surfaces [S6] | `ctx.jobs`, `job_*`, terminals [S3] | **none** — RUN is awaited to completion [E1] |
| review | `/code-review`, `ultrareview`, GitHub Code Review [S5] | `/review` against a diff, commit or base [S7] | not established here | checker + `VERIFY` + a reviewer *subagent role* [E3] |
| hooks | 33 events (SessionStart … SessionEnd) [S8] | lifecycle hooks, managed-only policy [S9] | every `agent/*`, `tools/*`, `fs/*` event [S3] | 3 moments: `afterWrite`, `beforeCommit`, `done` [E4] |
| editor / SDK | Agent SDK, VS Code, JetBrains [S10] | app-server (experimental), IDE extension [S7] | ACP profile + TS/Python SDK [S3] | own `POST /rpc` + SSE, one bespoke VS Code panel [E5] |
| code intelligence | LSP tool + LSP servers [S12] | not established here | `packages/lsp` capability seam [S3] | regex index, 15+ languages, experimental [E6] |
| orchestration | agent teams, dynamic workflows (experimental) [S11] | subagents, worktrees [S7] | subagent providers, agent teams (experimental) [S3] | subagents (sync/async, no nesting), goal, worktree [E7] |

Two facts in that table matter more than the rest. **Every reference harness
now runs commands inside an OS boundary, and this one does not.** And every one
of them now treats a long-running command as a job with a clock, while a RUN
here is still a synchronous call with a two-minute ceiling.

---

## Wave 3 — the rows

**What landed in this batch.** Four rows are built and proven; one is blocked
on a real boundary this build does not have; two are deferred, not quietly
claimed:

| row | state | proof |
|---|---|---|
| 3.1 OS sandbox | **phase 1 landed** — `harness/boundary.mjs` (policy resolver, `backendFor`, `boundaryFor`), fail-closed refusal, `sandbox` option on the run sheet, `docs/CONFIG.md`; platform adapters (Seatbelt/bubblewrap) and the Windows helper are still pending | `test/boundary-policy.test.mjs`, `test/run-sandbox.test.mjs` |
| 3.2 background RUN + `JOBS` | landed | `test/background-run.test.mjs` |
| 3.3 `REVIEW` | landed | `test/review.test.mjs` |
| 3.4 hooks: three moments become nine | landed | `test/hooks-events.test.mjs` |
| 3.5 `aipass acp` | **phase 1 landed** — `aipass-bridge/acp.mjs` (initialize, session/new, session/prompt, session/cancel, permission request) over newline-delimited JSON-RPC; `aipass acp` CLI | `test/acp.test.mjs` |
| 3.6 `DIAGNOSE` via LSP | **landed** — `harness/lsp.mjs` (Content-Length framing, lazy spawn, publishDiagnostics, cache, shutdown), home-approved server config, `DIAGNOSE` marker + tool + preamble | `test/lsp.test.mjs` |
| 3.7 the schedule ticks itself | landed | `test/schedule-tick.test.mjs` |

The comparison table below is the measurement taken on 2026-10-28, before this
batch; it stays as the evidence of where the wave came from.

### 3.1 A RUN gets an OS boundary (`sandbox`)

**Why it hurts.** The overlay already closes the *write* hole: a RUN writes in
a throwaway projection, and a write through a linked heavy directory is refused
(`harness/sandbox.mjs`) [E1]. What stays open is **what a command reads and
where it sends it**. `RUN`
is a real shell with the person's rights, and the only floor is a text screen
on the command line [E2] — the code already says why that floor is thin: a
path built at runtime is not a path the screen can name, and a script can read
a file the command line never mentions. One hostile line in a README the model
was asked to read is enough. The category answered this with an OS box, not a
better regex: Claude Code enforces files and a proxy-checked domain list and
**refuses to start the sandbox rather than silently run unsandboxed** [S1];
Codex has three sandbox modes and a Windows backend [S2]; DSH makes the
boundary a capability seam with `read-only` / `workspace-write` /
`danger-full-access` [S3].

**Done when.**

- `read-only` cannot write anywhere; `workspace-write` writes only in the run's
  world and its temp dir; neither can read the credential paths the floor
  already names (`~/.ssh`, `~/.aws`, `~/.aipass/.token`, the project's `.env`),
  and reads outside the root are the toolchain allowlist (`~/.npm`,
  `~/.cargo`, `~/.cache`) or nothing;
- no host is reachable unless it is in the run's allowlist, and the allowlist
  starts empty — a blocked connection names the host, the way Claude Code names
  a denied domain in the result [S1];
- a blocked command answers with `err:` and names the boundary, so the model
  reads what happened instead of retrying blind;
- `danger-full-access` is a per-run, visible opt-in — never a default and never
  a remembered grant;
- a platform whose backend is missing **refuses the command** with a named
  reason instead of running it unsandboxed. Claude Code's `failIfUnavailable`
  is the precedent [S1]; a silent fallback is the failure this row exists to
  end;
- macOS (Seatbelt) and Linux (bubblewrap) are the first backends. Native
  Windows is the open question: Claude Code does not sandbox it [S1], Codex
  does [S2], and DSH has a Windows write-restriction rung [S3]. Pick the rung
  or state the refusal in `SECURITY.md` — but do not ship a mode that only
  *says* it is on.

**Test.** `test/run-sandbox.test.mjs` — "a RUN cannot read a credential path
outside the root, and a backend that is missing refuses instead of running".

**Notes.** This is not the App Sandbox that `docs/INSTALL.md` declines. That
decision is about sandboxing the *app*; this is confinement of a *child the app
started*, which is what the overlay already does for writes. The policy line in
`docs/TECH_STACK.md` ("the threat model is a model writing files, not escaping
a sandbox") was written before `allowRun`, `FETCH` and MCP existed; the threat
it describes is now only half the surface [E8].

### 3.2 Background RUN and `JOBS`

**Why it hurts.** A test suite, a build, a dev server — the things a coding
agent runs most — outlive two minutes. Today the tool kills the tree at the
timeout [E1], so the model sees a failure that is really a clock, and the turn
has no way to keep working while a command finishes. Claude Code leaves a
timed-out command running in the background and names its output file [S5];
Codex shows and stops background commands from the app [S6]; DSH makes jobs a
capability with `job_*` tools [S3]. The harness already has the shape for this:
`SUBAGENT` with `background: true` and the `JOBS` marker [E7].

**Done when.**

- `RUN` accepts `background: true`, returns a job id at once, and writes the
  command's full output where `read` can reach it (the spill directory already
  exists);
- `JOBS` lists running and finished jobs with exit status, and
  `JOBS stop <id>` kills the whole tree, not the shell alone (the existing
  `taskkill /T` path is the owner);
- a run cannot report `DONE` while a background job it started is still alive
  unless the result says so — the `done` gate learns the word `jobs-running`;
- the `done` hook still fires once, after the jobs the run owns are settled.

**Test.** `test/background-run.test.mjs` — "a background RUN outlives the turn,
its output is readable, and stop takes the tree down".

### 3.3 `REVIEW` — a run that reads and never stages

**Why it hurts.** A person who wants "look at this diff and tell me what is
wrong" has two options here: a reviewer *subagent* that reports into the run,
or the checker at DONE [E3]. Neither gives the category's shape — a dedicated
review of a diff, a commit or a base branch, with prioritized findings and no
working-tree change. Codex `/review` is explicit about not modifying the tree
[S7]; Claude Code ships `/code-review`, `ultrareview`, and a GitHub review
surface [S5]. This is also the cheapest safe surface to add: the overlay
already knows how to show a diff without writing.

**Done when.**

- `/review` in the window and `REVIEW <staged|ref>` in the CLI start a run in
  review mode: the overlay is read-only, the preamble teaches findings instead
  of edits, and `CREATE`/`EDIT`/`DELETE`/`MOVE` answer `err:` by construction;
- the result is one findings block — severity, `file:line`, what is wrong, the
  smallest fix — and "no findings" is a valid answer that says what was read;
- the mode is a floor under the permission mode, not a peer: `yolo` cannot
  widen it, and a review run that tries to stage anything is a failed review,
  not a write;
- the window shows the findings as rows beside the diff it reviewed.

**Test.** `test/review.test.mjs` — "a review run stages nothing and names each
finding with a file and a line".

### 3.4 Hook moments: three become nine

**Why it hurts.** The three moments cover a change and a commit [E4]. They
cannot express the two things people ask for first: *stop this command before
it runs* and *put the issue in front of the model at session start*. Claude
Code exposes 33 events, including `PreToolUse`, `PermissionRequest`,
`SessionStart`, `UserPromptSubmit`, `PreCompact` and `Stop` [S8]; Codex has
lifecycle hooks and a managed-only switch [S9]; DSH's hooks are just plugins
listening to `tools/*` and `agent/*` [S3]. The harness already emits the events
this needs; the hook layer is the missing listener.

**Done when.**

- `beforeTool` can deny one call with a reason the model reads, and a deny is
  final under every mode;
- `afterTool`, `sessionStart`, `promptSubmit`, `preCompact` and `stop` fire at
  the moments their names say, with the same argv-only rule, timeout, secret
  screen and "a failing hook is reported, not fatal" contract the current
  moments hold [E4];
- `sessionStart` output is framed as the person's context, never as an
  instruction that lifts a rule;
- the window's hooks page lists the new moments and refuses an unknown one.

**Test.** `test/hooks-events.test.mjs` — "beforeTool denies one call, and the
other five moments fire in order".

### 3.5 `aipass acp` — one protocol, any editor

**Why it hurts.** The harness has three surfaces (window, CLI, VS Code panel),
and the editor one is a bespoke client of `POST /rpc` + SSE [E5]. Every other
client — Zed, Neovim, a CI runner — has to write that client again. The
category standardised the edge: DSH ships a full `acp` profile and TS/Python
SDKs [S3]; Claude Code ships an Agent SDK [S10]; Codex replaced its MCP server
with an app-server for integrations [S7]. ACP over stdio is the smallest
version of that edge for this harness, and it does not add a dependency.

**Done when.**

- `aipass acp` speaks newline-delimited JSON-RPC over stdio: `initialize`,
  `session/new`, `session/prompt`, `session/cancel`, and the permission
  request the client answers;
- a read-only turn completes without the window, and a cancel mid-turn ends
  the child and leaves no staged writes;
- the same harness, settings and permission floor apply — the protocol is a
  transport, not a second brain;
- the VS Code panel can keep its own transport; the two are not required to
  merge in this wave.

**Test.** `test/acp.test.mjs` — "a fake ACP client runs one read-only turn and
cancels one".

### 3.6 `DIAGNOSE` — the language server the machine already has

**Why it hurts.** `SYMBOLS`/`DEF`/`REFS` are a regex index (15+ languages,
cached, experimental) [E6]. A regex cannot answer "does this file type-check",
and a wrong definition sends the model to the wrong file with confidence.
Claude Code has an LSP tool that jumps to definitions, finds references and
reports type errors and warnings [S12]; DSH makes LSP a capability seam [S3].
The machine already has the servers (tsserver, pyright, gopls,
rust-analyzer) — the harness does not ask them.

**Done when.**

- `DIAGNOSE <path>` returns the server's errors and warnings for the changed
  files, each with `file:line:col`, severity and source;
- no server for the file type is a plain "no server for this file" answer, and
  the regex answer is what `DEF`/`REFS` keep using — one does not silently
  stand in for the other;
- a project-declared server command is a repository-started program, so the
  MCP rule applies: only a home-approved server runs [E9];
- a server that dies mid-run is reported once and the run continues.

**Test.** `test/lsp.test.mjs` — "diagnostics come from the server, and a
missing server says so instead of guessing".

### 3.7 The schedule ticks itself

**Why it hurts.** The schedule page is shipped but the backend "ticks nothing
by itself — the window asks it to run what is due" [E10]. A person who closes
the window has a scheduler that never runs. Claude Code runs desktop scheduled
tasks on the machine and cloud routines without it [S10]; Codex has scheduled
tasks with event triggers [S7]. The local, no-cloud version is a timer in the
backend and a lock so two windows do not run one task twice.

**Done when.**

- the backend runs due entries on start and on an interval, not only when the
  window asks;
- a lock in the schedule store makes two backends (or two windows) run a due
  entry once, not twice;
- a missed entry runs once on the next tick, which is what the store's due rule
  already promises;
- `schedule.runDue` stays callable by the window and is idempotent with the
  ticker.

**Test.** `test/schedule-tick.test.mjs` — "a due task runs once with the window
closed, and two backends do not both run it".

---

## What is deliberately not in this wave

| item | why not |
|---|---|
| agent teams / dynamic workflows | Claude Code and DSH both ship these as **experimental** [S3][S11]; our subagent caps are a deliberate cost bound, and no live run has named the need. Revisit when one does. |
| programmatic tool calling (DSH's `ptc-runtime`) | it hides tool calls inside generated code. "Every tool call is a row you can open" is the product; a runtime that erases the row trades the review surface for tokens. Revisit with a measured token bill, not a hunch. |
| a plugin marketplace / directory | it needs signing and provenance this project does not have; the unsigned-installer policy is already stated (`docs/RELEASE.md`). |
| cloud agents, mobile, Remote Control | the promise is that the credential never leaves the machine; the two commercial harnesses sell the opposite, and DSH keeps the runtime local for the same reason. |
| OS keychain for `~/.aipass/.token` | it is a real improvement, but it is a portability change across three platforms and buys less than 3.1. |
| per-run model effort control | not established in the bridge's upstream contract; do not promise a dial the server may not honour. |

---

## Evidence

### This repository

- **E1** — `aipass-bridge/harness/execution.mjs:46` `runShell` (`shell: true` at
  :50), `:193` `runInProjectWorld` default `timeoutMs = 120_000`.
- **E2** — `aipass-bridge/harness/tools.mjs:1229` the RUN secret screen;
  `:1226-1230` says the screen covers command words, not runtime-built names.
- **E3** — `aipass-bridge/harness/protocol.mjs:117-130` the subagent roles;
  no `REVIEW` in `MARKER_LINE` (`:289`).
- **E4** — `aipass-bridge/harness/settings.mjs:40` `HOOK_MOMENTS`;
  `harness/hooks.mjs` the contract.
- **E5** — `harness/rpc/*.mjs` + `ide-extension/`; no `acp` or SDK entry in
  `aipass --help` (2026-10-28).
- **E6** — `harness/symbols.mjs`; `docs/MATURITY.md` row "code navigation …
  experimental".
- **E7** — `docs/MATURITY.md` "subagents / parallel helpers — production" and
  "background subagents (async) — experimental"; `harness/worktree.mjs`.
- **E8** — `docs/TECH_STACK.md:65` the threat-model sentence; `SECURITY.md:245`
  "plugins and MCP servers are trusted, not sandboxed".
- **E9** — `SECURITY.md:175-183` the project-scoped MCP rule (home-approved,
  declared risk ignored, env only by name).
- **E10** — `docs/MATURITY.md:74` "the backend ticks nothing by itself — the
  window asks it to run what is due".

### The three

- **S1** — Claude Code, *Configure the sandboxed Bash tool*
  (code.claude.com/docs/en/sandboxing): OS enforcement, network proxy and
  domain list, credential deny/mask, `failIfUnavailable`, no native Windows.
- **S2** — Codex, *Sandbox* (developers.openai.com/codex/sandboxing):
  Seatbelt / bubblewrap / Windows sandbox; `read-only`, `workspace-write`,
  `danger-full-access`; `on-request` / `never`; `auto_review`.
- **S3** — DeepSeek Harness, `docs/architecture.md` and `packages/sandbox`
  (master, 2026-10-28): Cordis plugins, profiles/bundles, capability seams,
  session log as model history, ACP/SDK profiles, `ctx.jobs`, LSP package,
  sandbox modes `read-only` / `workspace-write` / `danger-full-access`.
- **S4** — Claude Code, *Choose a permission mode*
  (code.claude.com/docs/en/permission-modes): `acceptEdits`, `plan`, `auto`,
  `dontAsk`, `bypassPermissions`, plus protected and critical paths.
- **S5** — Claude Code changelog 2.1.312 and 2.1.311: `/code-review`,
  `ultrareview`, GitHub Code Review; a timed-out shell command keeps running
  and names its output file.
- **S6** — Codex changelog 2026-10-22 (iOS 1.2026.286): view and stop
  background commands; 2026-10-27 CLI 0.165.0 is the version compared.
- **S7** — Codex CLI features page and changelog: `/review`, `codex cloud`,
  subagents, MCP, app-server replacing `mcp-server` (2026-09-05), scheduled
  tasks with event triggers, import from Claude Code/Cursor (2026-08-11).
- **S8** — Claude Code, *Hooks reference* (code.claude.com/docs/en/hooks):
  33 events from `SessionStart` to `SessionEnd`.
- **S9** — Codex, `docs/config.md` (openai/codex): lifecycle hooks and
  `allow_managed_hooks_only` in `requirements.toml`.
- **S10** — Claude Code docs overview: Agent SDK, Desktop scheduled tasks,
  Remote Control, cloud sessions.
- **S11** — Claude Code, *Agent teams* and *Dynamic workflows*
  (code.claude.com/docs/en/agent-teams, /workflows): both experimental.
- **S12** — Claude Code, *Tools reference* (code.claude.com/docs/en/tools-reference):
  the `LSP` tool — definitions, references, type errors and warnings — and the
  `Monitor` tool for background output.

Where a cell says "not established here", the docs read for this wave did not
show it. That is a gap in the reading, not proof the capability is absent.

---

## The rule this wave follows

Every row is a behaviour, and every behaviour is a test whose title is a
contract. When a row lands, its test lands with it, and `docs/MATURITY.md`,
`CHANGELOG.md` and `SECURITY.md` (3.1 changes the threat model) are updated in
the same change. A row that cannot name its test is not ready to be built.
