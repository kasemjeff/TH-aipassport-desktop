# Worklog

Session handoffs, newest first. One entry per working session, five items:
**files touched · tests run + result · deferred items with reasons · open
risks · cleanup done**. This is news, not law: the rules live in `AGENTS.md`,
durable behavior changes in `CHANGELOG.md`, and the final word is always the
suite.

## 2026-10-18 — opencode — UX: design first, then the window and the popup

- **Files**: `docs/UX.md` (new — principles, surfaces, ranked pain points
  P0–P2, implementation order, open questions, §7 status of what shipped);
  `aipass-bridge/extension/popup.{html,js}` (Advanced gains "Paste from
  clipboard" — the token `aipass setup` copies — and "Test connection", which
  distinguishes OK / token-rejected / bridge-answered); `desktop/ui/index.html`
  (hardcoded "Kasem" user card removed; 🧠 memory details group with `memory`,
  `memory-head`, `memory-clear`); `desktop/ui/app.js` (`clickable()` makes
  sessions/skills/files rows Enter/Space operable; `setHint()` + pulsing dot
  while a run is in flight; `friendly()` maps the six common loop failures to
  Thai with the next action, used at the stream error, send catch, attachment
  and project-switch paths; `/memory`, `/mcp`, `/symbols` slash commands +
  `showMemory`/`showMcp`/`showSymbols`; `refreshMemory()` + forget-all wiring;
  `applyTheme` sets the theme-toggle glyph to the theme it will switch to);
  `desktop/ui/styles.css` (`#hint.busy` pulse); `harness/harness.mjs`
  (`crossSessionMemory()` / `clearCrossSessionMemory()` public accessors);
  `harness/rpc.mjs` (`memory.list`, `memory.clear`, `mcp.list` methods —
  disjoint hunks beside the sibling temperature WIP); `test/ui.test.mjs`
  (+2 behavioral specs: a session row opens with Enter, the memory panel
  lists facts and forget-all clears them — the latter caught that the panel
  was only wired to the project-switch path, never to boot; boot now calls
  `refreshMemory()`; also fixed a `toast()` call that had slipped in from the
  popup's vocabulary).
- **Tests**: `ui.test.mjs` 51 pass / 0 fail; `desktop-window.test.mjs` 17 pass
  / 0 fail (includes the "window only reaches for elements that exist"
  id-contract test against the edited html/js); `desktop.test.mjs` 21 pass /
  0 fail; `node --check` clean on `app.js`, `popup.js`. The full suite's red
  cells are unchanged and not this wave: the stale evals replay (needs a live
  run) and the sibling temperature WIP in `settings.mjs`.
- **Deferred**: a popup "Copy path" button is **not possible** — Chrome
  exposes no filesystem path to the extension (documented in UX.md §7); the
  error map is the first six failures only, to widen as the field reports more;
  P0.2 (no-tab recovery) and P1.3 (context tooltip) were already shipped and
  were left as found.
- **Risks**: `harness/rpc.mjs` and `harness/harness.mjs` edits sit in files the
  sibling temperature wave also touches — hunks are disjoint (new methods,
  accessors) but keep the commit split apart; `memory.list` answers from the
  live harness, so a run in flight shows the list as it stands.
- **Cleanup**: none.

## 2026-10-17 — opencode — the five capabilities from the gaps report

- **Files**: `harness/mcp.mjs` (new — stdio JSON-RPC client:
  initialize/tools-list/tools-call; config `~/.aipass/mcp.json` or
  `<project>/.aipass/mcp.json`; a server that fails to connect is skipped,
  never fatal; tools ride the plugin table as `MCP__<server>__<tool>`);
  `harness/symbols.mjs` (new — zero-dependency regex symbol index for 15+
  languages, cached under `~/.aipass/symbols`, refreshed on mtime change);
  `harness/memory-store.mjs` (new — facts per project in
  `~/.aipass/memory/<hash>.json`, case/space-insensitive dedupe, 200 chars per
  fact, cap 50); `harness/tools.mjs` (SYMBOLS / DEF / REFS tools);
  `harness/protocol.mjs` (the new markers + preamble lines);
  `harness/loop.mjs` (SUBAGENT `background: true` returns a job id at once,
  JOBS polls, finished results are injected at the next step start — no
  nesting); `harness/harness.mjs` (`scale(task, n)` — best-of-N by check
  verdict, max 5; cross-session facts loaded into a session's first turn; MCP
  tools merged); `bin/aipass.mjs` + new `mcp.mjs` / `memory.mjs` / `scale.mjs`
  CLIs (`aipass mcp [list|call]`, `aipass memory [list|clear|path]`,
  `aipass scale "task" [--n N] [--allow-run]`); docs: `MATURITY.md` (four new
  experimental rows; scaling row moved not-shipped → experimental),
  `CHANGELOG.md`, `README.md` (tool table + Extra capabilities).
- **Tests**: `agent.test.mjs` 50 pass / 0 fail; `ui.test.mjs` 49 / 0; all new
  and changed `.mjs` syntax-checked. Full suite red only on the evals replay
  (`stale` vs `solved` — the preamble gained markers, so the recorded digest no
  longer matches) and the sibling temperature WIP; both pre-date this wave or
  belong to it elsewhere.
- **Deferred**: the new experimental MATURITY rows have no
  `experiments/queue.json` records yet; the evals replay fixture stays stale
  until a live re-run is approved (credits).
- **Risks**: MCP servers are user-configured child processes — the config file
  is the trust boundary (stated in the module header); the preamble change
  invalidates recorded transcripts, so any other recorded fixtures should be
  re-recorded against a live run before claiming green.
- **Cleanup**: none.

## 2026-10-17 — opencode — install easier + docs as our own work

- **Files**: `aipass-bridge/setup.mjs` (new — one-command setup: Node check, state dir + token mint, PATH install, clipboard copy, bridge start, browser pages); `aipass-bridge/bin/aipass.mjs` (`setup` case + HELP); `package.json` (`setup` script); `aipass-bridge/install.sh` / `install.ps1` / `aipass-bridge/README.md` / `bin/aipass.mjs` (Node floor 18 → 20); `README.md` (Where this stands rewritten to lead with our work + compact niawjunior credit + influences note; Quick start + Development feature `aipass setup`); `aipass-bridge/README.md` (borrowed upstream screenshots removed; `aipass setup` in Setup); `desktop/README.md` (pi comparison table rewritten as constraint table + prior-art note); `desktop/ui/app.js` (temperature chip initialized on boot — one line, fixing a committed bug). Scope per user: root + component READMEs only; attribution: our voice with compact influences note; install: `aipass setup`.
- **Tests**: `npm run agents:lint` ok (15 anchors); `ui.test.mjs` 49 pass / 0 fail; `aipass setup --no-open` runs end to end (adopts existing bridge, 1 extension connected). `npm test` overall red only because of the sibling session's in-progress temperature WIP in `settings.mjs` (chat.test.mjs 2 fails); reverting that file restores 16/0 — not my change. `setup.mjs` syntax-checked.
- **Deferred**: broader docs/ pass (HARNESS_DESIGN, LOOP_DESIGN, …) not done — out of chosen scope; borrowed screenshots removed rather than replaced (user to capture own); chat.test.mjs failure left for the sibling session's temperature wave to reconcile.
- **Risks**: `aipass setup` opens browser pages by default (`--no-open` to skip); assumes a local clone (repo is private, no remote one-liner). `desktop/ui/app.js` edit is a one-line fix to committed code; if the sibling's temperature wave rewrites that area, re-check. No push, no commit.
- **Cleanup**: removed the temporary git worktree used for the clean-tree check; no temp files left.

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
  `data-integrity.test.mjs` +1 (POSIX-only mode assertions). Temperature wave:
  `harness/settings.mjs` (`temperature` default + sane() clamp 0..2),
  `bridge/server.mjs` (chatCompletions reads/clamps temperature + logs a
  warning for ignored OpenAI sampling fields; startChat/Job carry it into the
  extension dispatch frame), `harness/bridge.mjs` (#sendOnce sends it),
  `harness/loop.mjs` (options.temperature → clamped number), `harness/rpc.mjs`
  (harnessFor + live apply in settings.set), `agent.mjs` (--temperature flag +
  validation + header print), `chat.mjs` (--temperature flag, /temperature
  REPL command with picker, banner row), `desktop/ui/index.html` + `app.js`
  (temperature chip beside the effort chip), `docs/DOCS.md`,
  `desktop/README.md`, `CHANGELOG.md`. Tests: `settings-clamp.test.mjs` +5
  asserts (temperature clamp/fallback inside the existing test),
  `bridge.test.mjs` +2 (temperature ride/clamp/null-drop/warning +
  ignored-fields warning), `agent.test.mjs` +1, `chat.test.mjs` +1,
  `ui.test.mjs` +1 — the suite now stands at 575.
- **Tests**: `npm test` 573 pass / 0 fail / 2 skip (575 — the skip is the
  POSIX-only mode test on Windows, where it cannot mean anything; the CI
  Linux/macOS lanes run it); `npm run qa` 9 ok / 0 warn / 0 fail;
  `npm run agents:lint` ok (561 titles); `npm run evals:lint` OK. Nothing
  committed. First full run after the wave failed 20 (temperature edit had
  replaced `let thinkingLevel` in `chat.mjs` and `this.video = video` in the
  Job constructor); both restored, the rerun is green.
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

## 2026-10-18 — opencode — per-model context budgets and a tunable tool-result cap

- **Files**: `aipass-bridge/harness/compact.mjs` (exported `DEFAULT_MODEL_BUDGETS`),
  `aipass-bridge/harness/harness.mjs` (fallback to it when compaction names none),
  `aipass-bridge/harness/settings.mjs` (defaults + clamp for `maxResult` and
  `compaction.budgets`), `aipass-bridge/harness/rpc.mjs` (passes `maxResult`
  through), `desktop/ui/app.js` (a `maxResult` row + validation), `CHANGELOG.md`,
  `docs/WORKLOG.md`, `aipass-bridge/test/compact.test.mjs` (one new test).
- **Tests**: `npm test` green on this machine (one git-absent skip);
  `npm run agents:lint` and `npm run evals:lint` green. `node --check` on every
  touched file.
- **Deferred**: listing-delta, elision tier, test-time scaling (best-of-N via
  the checker), and a `maxResult`-aware run smoke once credits reset.
- **Risks**: the curated budget map is conservative (well under real windows)
  but still a guess — a model whose window is smaller than its entry would
  rotate late. `AIPASS_CONTEXT_TOKENS` and the settings sheet still override.
- **Cleanup**: none needed.

## 2026-10-17 — opencode — the playbook library is back in reach, and the run's two dead flags reach the tools

- **Files**: `aipass-bridge/harness/harness.mjs` (the run's `maxResult` /
  `readLines` now reach all three tool contexts — main, helper, checker),
  `aipass-bridge/test/harness-fixes.test.mjs` (H11: a run's options clip a
  6 KB read at 500 bytes behind the spill locator, and page a 10-line file at
  three — red at `be0e1c5`, proven in a throwaway worktree), `CHANGELOG.md`,
  `docs/WORKLOG.md`. Machine-local, outside the repo: `D:\skills` is now a
  junction to `D:\aipass2\skills` (the library HOW-TO.md documents, stranded
  when the repo moved beside `aipass2` instead of inside it) and
  `~/.aipass/settings.json` carries `skillsDirs: ["D:\\aipass2\\skills"]` for
  the desktop backend.
- **Tests**: `npm test` green on this machine (one git-absent skip; see
  `npm test` for the count — parallel sessions move it); `npm run agents:lint`
  and `npm run evals:lint` green.
- **Deferred**: the two remaining quick wins — bootstrap snapshot (git status
  + scripts on turn 1) and step-cap visibility — are new prompt surface, not
  plumbing; they want their own design pass with the eval gate behind them.
- **Risks**: the junction and `skillsDirs` are machine-local; a CLI run from a
  tree not on `D:\` (e.g. `C:\Users\ASUS\aipass-bridge`) still resolves an
  empty default — point `AIPASS_SKILLS_DIR` there, or link it the same way.
- **Cleanup**: the proof worktree removed; no other processes started.

## 2026-10-17 — opencode — five-fix round: project-scoped runs, helper base layer, per-run readSet, rotation keeps created id

- **Files**: `desktop/ui/app.js` (`state.root` from refreshProjects/projects.switch/restoreFromSnapshot; `onRun`/`onAny` wrappers around ~35 handlers dropping foreign-project events; run/cancel carry `root: state.root`; foreign permission/plan modals show with a project label and route answers by project), `aipass-bridge/harness/rpc.mjs` (`run(params)` switches the harness when `params.root` differs with remember:false; `cancel(params)` targets the named harness; `status()` exposes per-project `running`), `aipass-bridge/harness/overlay.mjs` (read-through `base` layer), `aipass-bridge/harness/harness.mjs` (helper uses `child = new Overlay(root, {base: overlay})` with a `before` snapshot; copy-back skips files staged since start and records them in `helper_end.skipped`; `#makeTools()` called in `run()` so `readSet` resets per run; `#rotate` uses `made.id`; sends carry `conversation`/`conversationTemporary`), `aipass-bridge/harness/loop.mjs` (rebinds `conversation` after rotation), `aipass-bridge/bridge/server.mjs` (`resolveConversation` skips a temporary `conversationCache` for nameless callers), `aipass-bridge/harness/compact.mjs` (`summarize` accepts `conversation`/`temporary`), `aipass-bridge/test/bridge.test.mjs`, `checker.test.mjs`, `ask.test.mjs` (conversation-id contract), `aipass-bridge/test/harness-fixes.test.mjs` (+6 tests), `CHANGELOG.md`, `docs/WORKLOG.md`.
- **Tests**: `npm test` green (535 tests, 534 pass, 1 skip, 0 fail); `node --check` clean on all touched files.
- **Deferred**: live UI multi-project smoke (needs a real window run); desktop.test.mjs multi-project run routing (covered at the harness/rpc layer by the new harness-fixes tests and existing desktop-window tests).
- **Risks**: the per-project running map and foreign-event filter rely on every handler going through `onRun`/`onAny`; a handler added later that bypasses them silently re-introduces cross-project painting.
- **Cleanup**: debug removed; edits confined to the `aipass-fix` worktree.

## 2026-10-17 — opencode — the closing message carries the answer; the picker marks a dropped model

- **Files**: `aipass-bridge/harness/protocol.mjs` (the standing instructions now
  put the answer itself above the DONE — findings must not live only inside
  pasted material, and "finished" alone is not an answer), `aipass-bridge/harness/loop.mjs`
  (the no-marker nudge: if the answer is already written, the DONE line is all
  that is missing), `aipass-bridge/test/protocol.test.mjs` +
  `aipass-bridge/test/harness-fixes.test.mjs` (one new assertion each),
  `desktop/ui/app.js` (`fillModels` marks a model the live catalog dropped,
  keeps it visible either way, and never judges a fallback list — the catalog
  check's verdict, moved before the run), `aipass-bridge/test/ui.test.mjs`,
  `evals/fixtures/math-fix-replay.json` (fingerprint re-stamped: preambleBytes
  5020, digest `c7baf38722feae54`), `CHANGELOG.md`.
- **Tests**: `npm test` green on this machine (528 tests, 527 pass, 0 fail,
  1 skip); `npm run agents:lint` clean. The pushed CI run is the judge.
- **Deferred**: a live re-test of the recorded shapes (a WEB-search summary;
  the mangled-marker stall) — needs a real window run, which is the user's to
  start; the nudge half reaches conversations already in flight, the preamble
  half reaches new ones only (it is sent once per conversation).
- **Risks**: the guidance is prompt-level — a model that ignores it still
  closes short; the nudge is the runtime half. `allowRun` was flipped to true
  in the user's `~/.aipass/settings.json` (outside the repo): with mode=auto
  ordinary shell auto-runs, hazardous commands still ask.
- **Cleanup**: none needed — no processes started, edits confined to the
  `aipass-fix` worktree; investigation timelines live under
  `AppData/Local/Temp/opencode/inv/` (reference only).

## 2026-10-17 — opencode — the `models:` line covers history, not just new runs

- **Files**: `aipass-bridge/stats.mjs` (`collectRuns()` attributes a run that
  carries no `model` of its own to the session's recorded model — the header
  names the one a fresh run started on; a run-level `model` still wins),
  `aipass-bridge/test/stats.test.mjs` (a new test for the fallback and its
  precedence; the `(unrecorded)` test now covers only sessions that recorded
  no model either), `docs/RELIABILITY.md`, `CHANGELOG.md`.
- **Tests**: `npm test` green on this machine (526 tests, 0 fail, 1 skip);
  the pushed CI run is the judge. Live proof on the real store: the `models:`
  line went from `(unrecorded) 63r` to the full breakdown
  (gemini-3.5-flash-lite 40r · DeepSeek-V3.2 16r · claude-sonnet-5@default 4r
  · grok-4.6 3r · gemini-3.1-flash-lite 2r · gemini-3.8-flash 2r).
- **Deferred**: none blocking. The desktop app already writes the per-run
  model again (first keyed runs 19:44 today); the fallback is what carries
  the 63 runs written before that.
- **Risks**: for a pre-field session that switched models mid-history, every
  run attributes to the session's starting model — the best record that
  exists; runs written from `adbb31d` on carry the exact model per run.
- **Cleanup**: none needed — no processes started, edits confined to the
  `aipass-fix` worktree.

## 2026-10-17 — opencode — the refused send pauses instead of ending the run

- **Files**: `aipass-bridge/harness/bridge.mjs` (`TRANSIENT_SEND` now covers a
  content script mid-reinjection; new `RECOVER_WAITS_MS` / `recoverWaits()` /
  `sendRecoverable()`; `AIPASS_SEND_RETRY_MS` shrinks the transport wait for
  tests), `aipass-bridge/harness/loop.mjs` (the send is a bounded retry loop:
  a recoverable failure pauses and the same message goes again; each recovery
  is a `firewall_note` and `run_stats.sendRecoveries` counts it),
  `aipass-bridge/test/harness.mjs` (`scripted(..., { gap })` models the
  connection-cycle shapes), `aipass-bridge/test/agent.test.mjs` (four tests:
  chain exhaustion → rescue, never-clears → bounded stop, loading tab →
  recovered, mid-reinjection → retried inside the send), plus `CHANGELOG.md`,
  `docs/LOOP_DESIGN.md`, `docs/RELIABILITY.md`.
- **Tests**: `npm test` green on this machine (520 tests, 0 fail, 1 skip);
  the pushed CI run is the judge.
- **Deferred**: the conversation churn ("created temporary conversation" every
  ~30s in the morning's failing runs) — diagnosed as a lead, not reproduced
  here; the other session's `aipass-loopbug` worktree owns that repro.
- **Risks**: a hard rate window now stalls longer before dying (bounded:
  ~8min in resilientSay + 90s of recovery); "bridge returned 5xx" counts as
  recoverable, so a sick bridge is retried twice before the old ending.
- **Cleanup**: none needed — no processes started, edits confined to the
  `aipass-fix` worktree.

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
