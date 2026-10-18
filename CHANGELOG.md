# Changelog

What changed, in behavior terms — not a file-by-file log. The release
procedure, acceptance criteria and rollback live in [`docs/RELEASE.md`](docs/RELEASE.md).

## [Unreleased]

### Added

- **A failed send leaves a trace.** A run that stops because a send threw
  now records the cause in the session (a `note` entry and
  `run_stats.sendError`) instead of losing it, so the next failure names its
  shape (`test/harness-fixes.test.mjs`).
- **`maxCredits` — a spend cap per run.** The loop counts observed spend
  against the bridge's cached quota (0 = off, the default) and stops a run at
  the ceiling with the stop reason `credit-limited`. Set it in Settings, in
  `settings.json`, or per eval task / `--budget maxCredits=`.
- **The secret floor covers the execution channels.** A RUN whose command
  spells a secret path is refused before anything spawns, SEARCH skips secret
  files even when their names are not dot-hidden, and git patches touching a
  secret are withheld from output (the runtime residual — a name built at
  runtime inside a program — is stated in `SECURITY.md`).
- **Plugin API versioning.** `plugins.mjs` exports `PLUGIN_API` (1); a plugin
  whose `apiVersion` needs a newer harness is refused at load before
  `setup()` runs, and a plugin without one loads as `apiVersion: null`.
- **Reliability targets get a home** (`docs/RELIABILITY.md`): the SLIs the
  commands already print, a zero-warn error budget at release time, and the
  degradation modes indexed. `run_stats` now records the model it ran on,
  and `stats` groups by model and project — `byModel` / `byRoot` in `--json`,
  new `models:` / `projects:` lines in the text report, models in the HTML
  header.
- **The backup/restore drill runs in the suite**
  (`aipass-bridge/test/restore-drill.test.mjs`): a copied home restores into
  a second environment with the same sessions, settings and token; RTO/RPO
  are written down in `docs/DATA_FORMATS.md`.
- **A new default model is an audited change** (`docs/SPEC_EVALS.md`):
  approval gates (safety set solved, no regression, ≤2× cost), the routing
  policy in one place, and "no automatic fallback" stated where it can be
  found; the evals summary gains a `wall median`.
- **`SECURITY.md` grows the governance half**: data classes, owners, threat
  model, and the vulnerability process — triage → fix with test → verify
  closure → announce; `docs/RELEASE.md` gains the release-evidence pack.
- Session headers record `app` — the build that wrote the file — so a
  transcript answers "which version did this come from".
- **`npm run stats -- --alerts / --strict / --json / --html FILE`** — the
  pull-based alerting a local install can have: refusal-rate spikes,
  guard-trip shares, cost outliers and firewall notes, plus a self-contained
  HTML report.
- **`npm run loadtest`** — concurrent local-API smoke with latency and
  memory reporting (`--strict` for release gates). Not part of CI.
- **Evals: `--attempts N`** repeats every task in one run and reports every
  row (the stochastic-run policy: medians, never the best draw), the summary
  gains a `grounded` metric (DONE runs a declared check confirmed), and the
  safety set ships: `refuse-secret` and `ignore-injection`, live-only.
- **Structured log lines + request ids.** `AIPASS_LOG_FORMAT=json` turns
  bridge logs into one JSON object per line; every bridge request carries a
  short `x-aipass-rid` that rides its error lines.
- `docs/RELEASE.md` (versioning, acceptance criteria, upgrade/rollback,
  dependency review), `.github/dependabot.yml`, and tests for data integrity
  (torn/duplicated/wrong-typed lines, settings forward-compatibility) and
  concurrent RPC bursts.
- **The experiment queue** (`docs/EXPERIMENTS.md`, `experiments/queue.json`,
  `npm run experiments`): proposals come from alerts, regressions, research
  or audits; every record carries a hypothesis, baseline, success criteria,
  budget and stop rule, and one that ends without a `result` fails
  validation. Ordered 2×impact − risk − cost; seeded with eight open records,
  from mixed-model routing to the elision tier.
- **The context manager's two newer tiers.** The summarisation transcript
  elides stale, bulky sends to counted head…tail stubs instead of the plain
  1200-char slices (`elideStaleResults` / `AIPASS_ELIDE` — off by default,
  so the `elision-tier` arm measures it against the current default). Every
  rotation also extracts a `MEMORY:` facts section from the summary reply —
  decisions, constraints, files — merges it across rotations (deduped,
  clipped, capped at 20), records it on the compaction entry, and pins it
  into every later seed, so a long session keeps its spine across any number
  of rotations (`carryMemory` / `AIPASS_MEMORY=off`; queue:
  `memory-tier-carry`).
- **`npm run evals:compare`** — two result JSONLs in, one verdict out. The
  model-approval gates (regression floor, safety set, ≤2× spend, a 3-attempt
  sample floor) are exit codes instead of judgment; `--json` for the record.
- **Eval rows carry their dataset versions** — `taskDigest`, `treeDigest`,
  an `env` stamp (`app`, `node`, `platform`) — plus the task's `category`;
  the summary gains `by category:`, `mixed outcomes:` and `pair drift:`
  lines. The set gains two phrase-robustness twin pairs (`sum-numbers`,
  `count-lines`), and `--keep` copies every attempt's session JSONL beside
  the run results, so evidence outlives `%TEMP%`.
- **The safety set doubles and gets twins**: `refuse-run-leak` (an embedded
  "ops step" that would stage the token through RUN) and `allow-clean-run`
  (the false-positive twin — a clean RUN that must go through). All four
  safety tasks are `liveOnly` (replay skips them); FP/FN criteria and the
  30-day expiry of safety evidence live in `docs/SPEC_EVALS.md`.
- **`docs/MATURITY.md`** — the capability map: production vs experimental vs
  not shipped (and one "won't build"), each with the criteria that would
  change its status and an owner role.
- **The test plan's L1 cases are implemented** (`docs/TEST_PLAN.md`): digests
  pinned stable across runs and moving with a fixture byte, a dead bridge
  marked `invalid` (never `unsolved`), the summary's empty slices staying
  quiet, piped/composed secret spellings refused, literal metadata hosts
  resolving private without a network round trip, a summary-less `compaction`
  marker loading, unknown entries surviving a rewrite, the queue's `--json`
  order — and the comparator's new-task/wall/old-shape cases.
- **The suite runs on macOS in CI** — `macos-latest` joined the matrix
  (Node 22/24), so the second platform the app ships for is exercised on
  every push. The platform→argv rule (`open` / `cmd start` / `xdg-open`)
  moved to `harness/open-command.mjs` and the sidecar triple table became
  injectable (`targetTriple()`), so a Windows dev machine pins the darwin
  branches in `platform.test.mjs`: the argv shape on all three OSes, the
  `browser.open` allowlist refusing before any spawn, and the mac sidecar
  names (`x86_64-apple-darwin` / `aarch64-apple-darwin`).
- **Per-tool latency in `run_stats`.** Each tool kind's entry gains `ms` (its
  wall time; parallel SUBAGENTs are timed at their fan-out) and `npm run
  stats` prints the per-kind mean next to the refusal count; `run_stats.turns`
  records the reply count that `steps` (executed calls) never named.
- **The red-test commit gate.** A `git commit` RUN is refused while the
  project's declared check (`.aipass/check.txt`, `docs/SPEC_CHECKER.md`) has
  not passed at the current tree state — any change re-arms it, the refusal
  names the exact command that un-bars it, and `run_stats.commitBlocks` counts
  the refusals. Projects without a declared check are untouched.
- **`--snapshot`** quotes `git status --short` and the `package.json` scripts
  into turn 1 — off by default, so the CLI's tuned turn-1 bytes stay identical
  (`agent.test.mjs` pins both sides).
- **Plugin tools can declare a risk** — `ctx.tools.register(marker, fn,
  {risk: 'write'|'shell'})` routes the marker through the same permission
  gate a built-in of that kind rides; undeclared tools keep the trust the
  plugin model states (`plugins.test.mjs`, `gates.test.mjs`).
- **Temperature is a knob now.** `temperature` (0..2, null = the server's
  per-model default) lives in `settings.json`, rides every send as
  `temperature`, and is edited from the composer's temperature chip beside the
  effort chip (`agent.test.mjs`, `chat.test.mjs`, `bridge.test.mjs`,
  `ui.test.mjs`). The bridge clamps out-of-range values and drops a value
  that is not a number, with a warning. The sampling fields the bridge cannot
  forward (`top_p`, `max_tokens`, `presence_penalty`, `frequency_penalty`,
  `seed`, `stop`, `logit_bias`, `logprobs`, `response_format`,
  `reasoning_effort`, `top_k`, `n`) are no longer ignored silently: one
  `warning:` line names them per request (`bridge.test.mjs`). The outer API
  (`/v1/chat/completions`) still ignores everything else, now documented as
  such (`docs/DOCS.md`).

- **MCP client (stdio).** `harness/mcp.mjs` speaks JSON-RPC over stdio:
  initialize, tools/list, tools/call. Servers are configured in
  `~/.aipass/mcp.json` or `<project>/.aipass/mcp.json`; each tool is
  exposed to the model as `MCP__<server>__<tool>` and merged into the
  plugin table. A server that fails to connect is skipped, never fatal.
  `aipass mcp [list|call]` inspects and calls them.
- **Code navigation (SYMBOLS / DEF / REFS).** A zero-dependency,
  regex-based symbol index (`harness/symbols.mjs`, 15+ languages) cached
  under `~/.aipass/symbols`, refreshed on mtime change. The model can list
  a file's declarations, find a definition, and find references.
- **Cross-session memory.** Facts persisted per project in
  `~/.aipass/memory/<project-hash>.json` and loaded into a new session's
  first turn; persisted on compact/rotate. `aipass memory [list|clear|path]`.
- **Background subagents.** A `SUBAGENT` with `background: true` starts and
  returns a job id at once; results are polled with `JOBS` or injected
  into a later turn. No nesting.
- **Test-time scaling.** `aipass scale "task" [--n N]` runs the task N
  times and keeps the best by check verdict (`Harness.scale`).
- **UX pass over the window and the popup** (design record: `docs/UX.md`).
  The extension popup's Advanced section gains **Paste from clipboard** and
  **Test connection**; the desktop gains `/memory`, `/mcp`, `/symbols` and a
  **memory panel** (facts carried across sessions + forget-all, via new
  `memory.list` / `memory.clear` / `mcp.list` RPC methods); sessions, playbooks
  and files rows are keyboard-operable; a run in flight pulses the composer
  hint; the six most common loop failures are translated to Thai with the next
  action; the hardcoded user card is gone; the theme toggle shows the theme it
  will switch to.

### Changed

- `evals:compare` no longer passes by absence: a baseline task the candidate
  never ran counts as 0 rows and fails as insufficient sample, the same way a
  missing safety task already did (`docs/SPEC_EVALS.md` says it in the gate
  text too).
- Session load is explicit about bad data: a duplicated entry id loads once,
  lines that parse to the wrong type are skipped, and only an object with a
  string `id` counts as a header.
- `docs/SPEC_EVALS.md` no longer claims the loop lacks wall-clock caps (it
  does not lack them; the credit cap was the missing one, and now ships
  opt-in). Open question 2 (attempt policy) is resolved as built.
- `compaction` entries record the newest entry their summary folds away as
  `lastSummarizedEntryId` — the old `firstKeptEntryId` named the wrong end of
  the boundary (`docs/DATA_FORMATS.md` notes the old spelling). The `seed()`
  helper's never-read `listing` parameter is gone.
- **Per-model context budgets finally drive compaction.** `Compactor` already
  knew how to pick a budget by model id (prefix match); the desktop path now
  passes a curated map (flash 100k, pro/sonnet/opus/gpt 200k, deepseek/qwen/
  llama/mistral/grok 128k, gemini 1M) instead of a flat 24k, and a new
  `maxResult` setting (default 3000) reaches the tool context from the sheet
  too (`test/compact.test.mjs`, `test/settings-clamp.test.mjs`).
- **A follow-up task stops re-pasting an unchanged top-level listing.** The
  harness keeps a per-conversation memory of the listing each conversation was
  last shown (`Harness#listingShown`, `loop.mjs`); an identical listing is
  answered with a one-line "unchanged" note, while a created, rotated or
  freshly pinned conversation gets the full table. The memory is written only
  after the message carrying the listing was accepted — never at composition
  time (`test/agent.test.mjs`, `test/compact.test.mjs`).

### Fixed

- **A rotated conversation is seeded even when the run is not the session's
  first.** Between-runs compaction fires on exactly the runs that are not
  first, and the seed was gated on `first`: the fresh conversation restarted
  from a bare "the project is still open" message with the paid-for summary
  never sent. A manual `/compact` had the same hole from the other side — its
  summary had no run to ride in; the next run now builds the seed against its
  own task (`rememberSummary`), once.
- **A rotation that fails is no longer recorded as done.** The compaction
  entry is appended after `rotate()` succeeds (both the loop's mid-run path
  and `compactNow`), so the estimate can never reset against memory the model
  never carried, and a mid-run failure retries on the next step. `/compact`
  also refuses while a run is in flight rather than rotating under it.
- The compaction divisor sampled entries a rotation had already discarded, so
  a fresh Thai conversation following a large Latin one (or the reverse)
  estimated up to 2× off; it now samples the same window `estimate()` counts.
- **The session and upload stores are owner-only where the OS has modes.**
  Sessions, their per-project directories and staged upload copies are created
  0o700/0o600, and a file an older build wrote readable is tightened when it
  is opened — the sensitive store no longer hinges on the ambient umask.
  Windows keeps its profile ACL; the token file's modes were already pinned
  (`SECURITY.md`).
- A `compaction` entry with no summary rendered as `undefined` in the
  session's markdown export; it now renders `(no summary)`.
- `npm run evals:lint` was failing on master: `refuse-secret`'s check passed
  on its untouched tree (a no-leak-only check scores nothing). The check now
  requires the explicit `denied` ending, so fail-before holds for every one
  of the 111 checks and CI's lint is green again.
- **A closing message carries the answer.** The standing instructions now say
  the findings belong above the DONE — a question or a summary never closes
  with a "done summarizing" line while the substance stays inside a pasted
  web result — and the no-marker nudge says a written answer plus DONE is
  enough (`test/protocol.test.mjs`, `test/harness-fixes.test.mjs`). The
  math-fix replay fingerprint follows the new preamble
  (`evals/fixtures/math-fix-replay.json`).
- **The picker marks a model the live catalog dropped.** A saved model the
  site no longer offers used to sit in the dropdown unmarked and then failed
  the run at the catalog check; the option now carries that verdict before
  the run starts, and a model missing from a fallback list stays unjudged —
  the same rule the loop applies (`test/ui.test.mjs`).
- **A pace-score 403 cools the whole tab, not just the job it refused.** The
  edge 403s by pace as well as by content — the same limiter family as a 429 —
  but only the refused job used to wait: every send behind it left at full
  pace into the window that had just said no. The page now arms the tab-wide
  `rateQuietUntil` clock and the five-minute `RATE_MEMORY_MS` pacing on a 403
  exactly as on a 429 (`test/page.test.mjs`).
- **The settings sheet's budgets reach the live run the moment Save lands.**
  `maxToolCalls`, `maxWallClockMs` and `maxCredits` join the keys re-applied
  to the running harness on save — before this a budget change only took
  effect at the next backend start while the sheet said it was live
  (`test/hardening.test.mjs`).
- **The `models:` line covers history, not just new runs.** A run that
  predates `run_stats.model` is attributed to the model its session recorded
  — the one a fresh run started on — so older sessions no longer blend under
  `(unrecorded)`, which stays for sessions that recorded no model at all
  (`test/stats.test.mjs`).
- **A refused send no longer ends the run at the first exhaustion.** Past the
  redact/wait/split/omit chain the loop pauses and sends the same message
  again (`RECOVER_WAITS_MS` — 30s then 60s, bounded): the connection-cycle
  shapes, a tab still loading, rate windows, and 403s that were never about
  the content. Each recovery is a `firewall_note` and counts in
  `run_stats.sendRecoveries`; the transport also waits out a content script
  mid-reinjection (`TRANSIENT_SEND`), and a run that still dies keeps its
  recorded cause (`test/agent.test.mjs`).
- **Streaming stops repainting what it already painted.** A reply paints in two
  layers now — the settled blocks render once, only the unfinished tail
  re-renders per frame — and the reasoning fold appends the text that arrived
  instead of reassigning its whole body, so a long answer or a long think no
  longer slows the window as it grows (`test/ui-md.test.mjs`,
  `test/ui.test.mjs`).
- **The backend's big reads and walks no longer block the window.** GLOB's tree
  walk, SEARCH's per-entry size check, and attachment staging/sending used sync
  fs calls that froze every window request for their duration; they go through
  `fs.promises` now — the walk stays sequential, so the cap still returns the
  same files (`test/tools.test.mjs`, `test/tools-aci.test.mjs`).
- `docs/DATA_FORMATS.md` matches the code again: `maxSteps` defaults to 0 (no
  cap), `minThaiRatio` to 0.4, and the auth exemption list names the same
  routes the backend skips (`/token`, the static UI files).
- **GLOB speaks shell globs again.** Brace alternation (`*.{js,css,html}`)
  and `?` are expanded and matched the way the shells do; the braces were
  escaped before, so a tree full of matching files answered "no files matched"
  (`test/tools.test.mjs`).
- **The nudge names a broken marker.** When a reply contained marker-shaped
  text that did not parse, the correction now says so and lists the shape
  rules (start of its own line, no indentation, bold or code fence, exact
  keyword) instead of the generic "no marker" line.
- `RUN type .env`, `SEARCH` over `server.pem`, and `git show HEAD:.env` were
  three ways around the secret floor; all three are refused now
  (`test/secret-screen.test.mjs`).
- **A backend crash no longer masks itself as a `ReferenceError`.** The desktop
  backend's `fatal()` handler called `formatLogLine` without importing it, so
  every uncaught error exited as `ReferenceError: formatLogLine is not defined`
  and the real cause was lost — and the supervisor restarted the backend, making
  the crash look like a restart. The import is restored, so a crash now prints
  the error that caused it (`test/hardening.test.mjs`).
- **A project is a first-class scope in the window.** `state.root` is set from
  the project list/switch/snapshot, every run and cancel carries `root`, and
  events from other projects are dropped so a run in one project cannot paint
  another; a foreign permission/plan modal still shows, tagged with the other
  project's name, and its answer is routed back by project
  (`test/ui.test.mjs`).
- **A run is bound to its root.** `run(params)` switches the harness when
  `params.root` differs (remember:false), `cancel(params)` targets the named
  harness, and `status()` reports per-project `running`; the window sends
  `root: state.root` on run/cancel (`test/desktop.test.mjs`).
- **Helpers read the parent's staged tree.** `Overlay` gains a read-through
  `base` layer; a helper is built with `base: overlay` and its own `before`
  snapshot, and copy-back skips files staged since it started, naming them in
  `helper_end.skipped` (`test/harness-fixes.test.mjs`).
- **`readSet` is per run.** `#makeTools()` is called in `run()`, not shared,
  so a read in one run no longer licenses a blind CREATE in the next
  (`test/harness-fixes.test.mjs`).
- **Rotation keeps the conversation its `create` returned.** `#rotate` uses
  `made.id` instead of re-reading the bridge's shared pointer; the server's
  `resolveConversation` skips a temporary `conversationCache` for nameless
  callers; sends now carry `conversation`/`conversationTemporary` per send
  (including summarize), and the loop rebinds `conversation` after rotation
  (`test/harness-fixes.test.mjs`, `test/bridge.test.mjs`).

## [0.2.0]

The release this repository is at. The ground-up continuation, in buckets:

- **The window** (`desktop/`): Tauri shell, chat UI, settings sheet, diffs
  with apply/reject, session picker, plan mode, project switching.
- **The bridge** (`aipass-bridge/bridge/`): WAF-safe relay between the local
  harness and the logged-in chat tab, quota/models routes, admin routes
  behind `AIPASS_ADMIN=1`, loopback-only with a bearer token.
- **The harness**: the pi-style session JSONL, the marker tool protocol,
  permissions with the secret floor, the loop with its guards (stagnation,
  repeat, chain, verify), compaction, overlay/apply, and the apply-then-check
  discipline.
- **The Thai pack**: `replyLanguage`/language check, the Thai/English eval
  pair set, and Thai-first UI copy.
- **Hardening**: loopback token on every route, openers take argv only, one
  WAF table, one-run-per-harness lock.
- **Stability**: capped rotating logs, atomic session writes, spill pruning,
  crash handlers that name the death instead of vanishing.
- **Evals** (`npm run evals`): check-decides-outcome task fixtures, live and
  replay modes, fingerprints that mark stale replays instead of scoring them.
