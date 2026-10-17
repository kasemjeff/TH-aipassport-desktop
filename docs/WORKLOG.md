# Worklog

Session handoffs, newest first. One entry per working session, five items:
**files touched · tests run + result · deferred items with reasons · open
risks · cleanup done**. This is news, not law: the rules live in `AGENTS.md`,
durable behavior changes in `CHANGELOG.md`, and the final word is always the
suite.

## 2026-10-17 — opencode — the context manager's newer two tiers: elision and memory

- **Files**: `harness/compact.mjs` (the elision pass in the summarisation
  transcript — `transcriptFor`, `elideStaleResults` off by default,
  `AIPASS_ELIDE`; the memory tier — the prompt's `MEMORY:` ask plus
  `splitSummary`/`memoryOf`/`mergeMemory`/`digest`, on by default,
  `AIPASS_MEMORY=off`; `seed` pins the merged facts, and a seed without them
  is byte-identical to before); `harness/loop.mjs` (the mid-run rotation
  digests the reply and records `memory` on the compaction entry);
  `harness/harness.mjs` (`compactNow` digests and returns `memory`;
  `rememberSummary(summary, memory)` rides the next run as
  `{summary, memory}`); `harness/rpc.mjs` (compact passes the facts on);
  `harness/session.mjs` (the compaction shape comment); tests:
  `compact.test.mjs` +10 (elision off/on and its exemptions, the env
  switches, the split/merge/cap rules, digest's off-switch, the factless
  seed staying byte-identical, facts through a mid-run rotation and through
  a manual one). Docs: `HARNESS_DESIGN.md` (the compressor section; the env
  list; the hook map row), `MATURITY.md` (elision row → experimental; the
  new memory row), `DATA_FORMATS.md` (§Memory + the entry table),
  `TEST_PLAN.md` (L3.6 arm line, new L3.7, the L4 rows),
  `experiments/queue.json` (`memory-tier-carry`) + its test's id list,
  `CHANGELOG.md`, `LOOP_DESIGN.md` (contract 11), `aipass-bridge/AGENTS.md`
  (env block), `README.md` (badge).
- **Tests**: `npm test` 568 pass / 0 fail / 2 skip (570); `npm run qa` 9 ok /
  0 warn / 0 fail; `npm run agents:lint` ok (556 titles); `npm run evals:lint`
  OK; `npm run experiments -- --check` OK (8 proposed).
- **Deferred**: both queue records stay `proposed` — no live credits spent;
  the elision default and the memory graduation are the records' to decide.
  The checker's `done-unverified` question stays open with them.
- **Risks**: the memory facts are model-authored — capped, deduped, marked
  "re-check" in the seed, and measured by `memory-tier-carry`; until that
  record ends, the tier is experimental by its own registry row. The tree is
  shared with other sessions — keep this wave's commit split apart.
- **Cleanup**: no temp files.

## 2026-10-17 — opencode — the memory audit, and the session store made owner-only

- **Files**: `harness/loop.mjs` (the seed is no longer gated on `first` —
  between-runs compaction fires on non-first runs by definition; rotate moved
  before the compaction append); `harness/harness.mjs`
  (`rememberSummary`/`#pendingSummary` — a manual rotation's seed is built at
  the next run, against that run's own task; `#stagedList()` shared by both
  seed paths; rotate-before-append); `harness/rpc.mjs` (`compact` records the
  summary and refuses while a run is in flight; staged upload copies without
  a path are 0o600 and copied files are tightened); `harness/compact.mjs` (the
  divisor samples the post-compaction window; dead `listing` param removed);
  `harness/session.mjs` (the store, its per-project dirs and every session
  file are created 0o700/0o600, an old file is tightened when opened);
  `harness/settings.mjs` (the upload staging dir is owner-only when created);
  `SECURITY.md` (the mode claim + the Windows ACL boundary);
  `compaction` entries now carry `lastSummarizedEntryId`;
  `docs/DATA_FORMATS.md` §Memory + §Retention updated; tests:
  `compact.test.mjs` +5 (between-runs seed, manual seed consumed once,
  rotate-fail ledger, mid-run rotate-fail, divisor window — fail-before
  verified for the guard and the divisor), `harness-qa.test.mjs` (the manual
  seed reaches the next run over RPC; compact refuses in flight),
  `data-integrity.test.mjs` +1 (POSIX-only mode assertions). 553 → 560
  tests.
- **Tests**: `npm test` 558 pass / 0 fail / 2 skip (560 — the new skip is the
  POSIX-only mode test on Windows, where it cannot mean anything; the CI
  Linux/macOS lanes run it); `npm run qa` 9 ok / 0 warn / 0 fail;
  `npm run agents:lint` ok (546 titles); `npm run evals:lint` OK. Nothing
  committed.
- **Deferred**: a small session reopened in a fresh process still hands the
  model only the new run's task (no compaction entry exists to seed from) —
  that is the `memory-cold-warm` probe's question, not a bug this round was
  allowed to answer.
- **Risks**: reused-session eval rows measured before this change saw less
  summary than the design intends; re-baseline before comparing rows across
  the change. The tree is shared with other sessions (loop guards, plugin
  risk) — commit splits must keep the waves apart.
- **Cleanup**: no temp files; the sidecar artifact is in place (gitignored).

## 2026-10-17 — opencode — the hook leftovers closed: latency, the commit gate, the snapshot

- **Files**: `harness/loop.mjs` (per-kind `ms` in `toolStats` — parallel
  SUBAGENTs timed at their fan-out; the red-test gate in `guarded()` ahead of
  the repeat guard; `turns` + `commitBlocks` in `run_stats`; the
  `--snapshot` builder appended to the turn-1 listing; plugin markers with a
  declared risk routed through the permission engine);
  `harness/permissions.mjs` (new `isGitCommit` export; `evaluate`/`request`
  take an explicit `risk` override); `harness/plugins.mjs` (`register`'s
  optional `risk`, validated at load, carried in `toolTable()`);
  `aipass-bridge/stats.mjs` (per-kind `ms` aggregate + `commit-gate` line);
  `agent.mjs` (`--snapshot` flag + help); tests: `gates.test.mjs` §5–6
  (commit gate: refuse → check → commit runs → re-arm; no-check control;
  plugin risk asked/denied/allowed/undeclared), `stats.test.mjs`,
  `lang-guard.test.mjs`, `agent.test.mjs` (snapshot on/off), `plugins.test.mjs`;
  docs: `HARNESS_DESIGN` (hook rows + worth-closing list — all closed),
  `LOOP_DESIGN` (execute order + guards table + the one hard bar),
  `SPEC_CHECKER` §As shipped 4, `SPEC_EVALS` metrics row, `desktop/README`
  (plugin risk), CHANGELOG, README badge (403 → 552 passing). 546 → 553 tests.
- **Tests**: `npm test` 552 pass / 0 fail / 1 skip (553); focused runs green
  (gates, stats, lang-guard, plugins, agent) before the full one; `npm run
  agents:lint` ok (539 titles); `npm run evals:lint` OK (111 fail-before, 50
  pairs); `npm run qa` 9 ok / 0 warn / 0 fail.
- **Deferred**: the checker's `done-unverified` decision (open question 2) and
  the elision tier stay deferred on purpose — both wait on their experiments'
  data (`MATURITY.md`, `EXPERIMENTS.md`); building them now would be the guess
  the data gate exists to stop. The seven live experiments remain `proposed`
  (no tab/account this session — qa's live line says 0 extensions).
- **Risks**: the commit gate changes behavior for every project carrying
  `.aipass/check.txt` — a `git commit` RUN now requires the declared check to
  have passed at the current tree state (loud refusal naming the command;
  delete/rename the file to opt out). `run_stats.tools` grew `ms` and
  `run_stats` grew `turns`/`commitBlocks` — readers pinning the old shape
  need field-aware checks (`stats.test.mjs` is the example).
- **Cleanup**: nothing outside the repo; suite temp dirs only. Went into the
  batch commit covering the sessions' pending work, once the whole tree went
  green (559 tests, `qa` 9 ok); personal untracked pages (desktop research
  notes, fortune/snake) left out on purpose; nothing pushed. If a history
  split is wanted later, the waves are separable at hunk level — `loop.mjs`'s
  regions and the doc bullets (see the memory audit's risk note).

## 2026-10-17 — opencode — macOS: the CI lane, and the branches made testable

- **Files**: `.github/workflows/test.yml` (`macos-latest` × Node 22/24);
  new `harness/open-command.mjs` + its callers (`harness/rpc.mjs`
  `openBrowser`, `desktop/main.mjs` `openWindow` — the duplicated platform
  branch is one rule now); `desktop/sidecar/fetch-node.mjs` (exports
  `targetTriple(platform, arch)`, runs its copy only when invoked);
  new `test/platform.test.mjs` (3 cases: argv shapes, allowlist-before-spawn,
  mac triples); `desktop/README.md` (the lane note). 543 → 546 tests.
- **Tests**: `npm test` 545 pass / 0 fail / 1 skip (546); `npm run qa` 9 ok /
  0 warn / 0 fail; `npm run agents:lint` ok (532 titles); `npm run evals:lint`
  OK. `npm run desktop:sidecar` ran end to end after the refactor (same
  output, 93 MB, node v24.18.0). Nothing committed.
- **Deferred**: the clipboard reader's darwin branch (`pngpaste`/`osascript`
  in `chat.mjs`) stays unpinned — it needs a real clipboard, which CI does
  not have; the packaged window/tray still needs a hand on a Mac.
- **Risks**: the macOS lane is unverified until the first push — CI has never
  run on darwin, so a red mac job is a finding, not a surprise.
- **Cleanup**: sidecar artifact refreshed in place (gitignored); no temp
  files left.

## 2026-10-17 — opencode — the test plan landed: L1 cases, the absence gate

- **Files**: the six suite files named in `docs/TEST_PLAN.md` L1 —
  `aipass-bridge/test/{evals,secret-screen,ssrf,data-integrity,experiments,evals-compare}.test.mjs`
  (11 new cases: digest stability + a moved fixture byte, the 429-storm
  `invalid` row, quiet summary slices, piped/composed secret spellings,
  literal private hosts, bare-compaction rendering, unknown entries through
  a rewrite, the queue's `--json` order, new/absent/wall/old-shape
  comparator cases); `scripts/evals-compare.mjs` (absence gate);
  `harness/session.mjs` (`(no summary)` placeholder); `docs/SPEC_EVALS.md`
  (the gate text says absence counts as 0); CHANGELOG. 532 → 543 tests.
- **Tests**: `npm test` 542 pass / 0 fail / 1 skip (543); `npm run qa` 9 ok /
  0 warn / 0 fail; `npm run agents:lint` ok (529 titles); `npm run evals:lint`
  OK; `npm run experiments -- --check` OK (7 records). Nothing committed.
- **Deferred**: the L1 cases that need code or a network the suite cannot
  touch — a public host resolving private (would need a DNS round trip; the
  literal-resolve path is pinned instead).
- **Risks**: the comparator now fails when a candidate run omitted a baseline
  task, so a `--task`-only candidate no longer compares green against a full
  baseline — intended, but the PR moving a default should say it.
- **Cleanup**: test temp dirs only; a debug script in `%TEMP%\opencode`.

## 2026-10-17 — opencode — audit round 5 closed: experiments, comparison, safety twins, maturity

- **Files**: the G16–G22 wave — `docs/EXPERIMENTS.md` + `experiments/queue.json`
  + `scripts/experiments.mjs` (the experiment system, seeded from the audit);
  `scripts/evals-compare.mjs` (candidate-vs-baseline gates as exit codes);
  `docs/MATURITY.md` (capability status + owner roles); `scripts/evals.mjs`
  (row `category`/`taskDigest`/`treeDigest`/`promptDigest`/`env`, `--keep`,
  `liveOnly` skipped in replay, `by category:`/`mixed outcomes:`/`pair drift:`
  summary lines); `harness/session.mjs` exports `APP_VERSION`; new eval tasks
  `sum-numbers(-twin)`, `count-lines(-twin)`, `refuse-run-leak`,
  `allow-clean-run`; `refuse-secret`'s check now demands the `denied` ending
  (it passed on an untouched tree — `evals:lint` was red on master);
  `SPEC_EVALS.md` (gates, routing, safety error rates + expiry),
  `DATA_FORMATS.md` (memory), `RELEASE.md` (safety freshness), README, AGENTS,
  CHANGELOG, `package.json` (`evals:compare`, `experiments`).
- **Tests**: `npm test` 531 pass / 0 fail / 1 skip; `npm run qa` 9 ok / 0
  warn / 0 fail; `npm run agents:lint` ok; `npm run evals:lint` green — 111
  checks fail-before (was failing on master over `refuse-secret`).
- **Deferred**: the queue's six records are all `proposed` — they need live
  runs to end. Heads of the queue: `safety-twin-controls`, `attempts-floor`.
- **Risks**: `SPEC_EVALS.md` grew several sections; audits that cite line
  numbers must anchor on section names. Safety rows from before this change
  are not comparable (live-only is now enforced; `refuse-secret` scores
  differently). Nothing was committed — the working tree carries the wave.
- **Cleanup**: temp dirs from lint/tests only; nothing left in the repo.

## 2026-10-17 — opencode — CI revived: the runners' git phrasing, then the sessions' batch

- **Files**: `aipass-bridge/test/gates.test.mjs` + `aipass-bridge/harness/tools.mjs`
  + `aipass-bridge/harness/sandbox.mjs` — the projected-git probes accept the
  runners' git wording ("gitfile does not point to a valid repository") beside
  this machine's ("not a git repository"); the Windows lanes had failed on the
  last several pushes over exactly this match. The rest of this entry rode
  along: the sessions' pending batch, pushed in the same operation.
- **Tests**: `npm test` green on this machine; the pushed run on CI is the
  judge — `gh run list -R kasemjeff/aipass`.
- **Deferred**: the `D:\aipass-loopguards` worktree (chat.mjs / extension
  page.js / bridge.mjs) was mid-edit at handoff — left uncommitted by design.
  Personal files (fortune-telling, investment pages, research notes, the
  veterinary hub page) stay untracked until the human says otherwise.
- **Risks**: origin/master (13 commits) merged into master as the union of two
  editing streams; the suite, not the eye, validates the union.
- **Cleanup**: none needed.

## 2026-10-17 — opencode — extension updated and re-installed into the browser

- **Files**: `aipass-bridge/extension/{manifest.json, content.js, popup.html,
  popup.js}` (now v0.2.1: Advanced gains **Reload extension** / **Reload
  chat tab**; content.js stops its retry loops once a reload orphaned it),
  `aipass-bridge/docs/DOCS.md` (reconnect backoff, reload buttons). Synced to
  the copy Chrome actually loads — `C:\Users\ASUS\aipass-bridge\aipass-bridge\
  extension` (an old clone, not this checkout); the old files sit at
  `%TEMP%\opencode\ext-C-backup-20261017`.
- **Tests**: `npm test` green (0 fail, 1 git-absent skip).
- **Deferred**: re-pointing Chrome at `D:\aipass\aipass-bridge\extension`
  (Remove + Load unpacked wipes the stored bridge token, so it needs the human)
  — the C:-copy sync is the stop-gap. `/ext/reload` stayed admin-gated: the
  running bridge answers 404 without `AIPASS_ADMIN=1`.
- **Risks**: the C: clone now shows every extension file modified vs its
  September HEAD — expected; it is a delivery copy there, not a source. Its
  local content.js edit (a delete-form, behavior-equivalent) was superseded.
- **Cleanup**: none needed.

## 2026-10-17 — opencode — agent-guide system, P0+P1 (AGENTS.md)

- **Files**: new `AGENTS.md`, `aipass-bridge/AGENTS.md`,
  `aipass-bridge/test/AGENTS.md`, `desktop/AGENTS.md`, `GEMINI.md`,
  `.github/copilot-instructions.md`, `docs/WORKLOG.md`,
  `scripts/agents-lint.mjs`, `aipass-bridge/test/agents-docs.test.mjs`,
  `AGENTS.local.md` (git-ignored). `CLAUDE.md` replaced by an `@AGENTS.md`
  import; `.gitignore` and `package.json` (`agents:lint`) touched.
- **Tests**: `npm run agents:lint` and `npm test` green (0 fail, 1 git-absent
  skip; the count moves as parallel sessions land tests).
- **Deferred**: `.cursor/rules` and Aider `CONVENTIONS.md` shims only if those
  tools are actually used.
- **Risks**: renaming a test that an agent guide cites fails `npm test` by
  design — update the anchor in the same change.
- **Cleanup**: none needed.

## 2026-10-17 — opencode — perf/hardening wave 2

- **Files**: `harness/{authtoken,rpc,overlay,protocol,session,sandbox,tools}.mjs`,
  `bridge/{server,private-hosts}.mjs`, `desktop/ui/app.js`, `bin/aipass.mjs`,
  plus test updates (`tools.test`, `tools-aci.test`, `harness-research.test`,
  `harness-fixes.test`, `run-overlay.test`, `gates.test`, `ui.test`).
- **Tests**: `npm test` → 467 pass / 0 fail / 1 skip (git-absent), ~21 s.
- **Deferred**: DONE-checker child run (SPEC_CHECKER semantics — product
  decision), background-stream reconnect overlap (~300 ms gap every ~4 min,
  accepted), sandbox junctioning of untouched subtrees (rejected — would
  break "nothing real is ever written").
- **Risks**: replay buffer is now 5000 frames / 4 MB capped; no others known.
- **Cleanup**: isolated boot-check bridge (port 8799, `%TEMP%\aipass-bootcheck`)
  killed.
