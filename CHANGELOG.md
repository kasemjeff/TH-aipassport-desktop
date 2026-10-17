# Changelog

What changed, in behavior terms — not a file-by-file log. The release
procedure, acceptance criteria and rollback live in [`docs/RELEASE.md`](docs/RELEASE.md).

## [Unreleased]

### Added

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
- `RUN type .env`, `SEARCH` over `server.pem`, and `git show HEAD:.env` were
  three ways around the secret floor; all three are refused now
  (`test/secret-screen.test.mjs`).

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
