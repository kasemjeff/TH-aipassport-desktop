# Capability maturity

The 2026-10-17 audit asked one question a feature list cannot answer: which
capabilities are *production* here, which are *experimental*, which are
deliberately not shipped — and who is accountable for each. This page is the
answer of record; the not-shipped notes in `docs/HARNESS_DESIGN.md` stay as
design history, and where the two disagree, this page wins.

## The statuses

| status | means |
|---|---|
| **production** | in the suite, documented where truth lives, its failure behavior named, a rollback or off-switch exists (a flag, a settings key, or "delete the file") |
| **experimental** | shipped but not trusted for decisions: behind a flag or an unproven arm, with a queue record that defines what would change its status |
| **not shipped** | a design note and a waiting experiment; moving it is the record's job, not a patch's |
| **won't build** | a policy decision with a stated reason — revisited only when a named failure shows the policy wrong |

Demotion is real: a production capability whose criteria stop holding (its
tests fail, its doc drifts from behavior, its budget caps get bypassed) is
treated as experimental until it earns the status back.

## Owner roles

Today one person holds every role (`LICENSE`); the column matters anyway, so a
future handoff has names to hand. **Loop maintainer**: the agent loop, guards,
budgets. **Benchmark owner**: evals, lint, comparison, the safety set, the
traffic between them. **Policy owner**: SECURITY.md, RELEASE.md, and the
"won't build" line. The maintainer signs releases (`docs/RELEASE.md`), which
discharges all three.

## The registry

| capability | status | evidence of record | what would change the status | owner |
|---|---|---|---|---|
| agent loop + guards (repeat, error, stagnation, verify, budgets) | production | `harness/loop.mjs`, `docs/LOOP_DESIGN.md`, the suite; guard-stop share tracked | guard-stop share > 25% of runs opens a fix (`docs/RELIABILITY.md`) | loop maintainer |
| permissions floor + secret screen | production | `permissions.mjs`, `test/secret-screen.test.mjs`, `test/ssrf.test.mjs`, residual stated in `SECURITY.md` | any FP/FN in the safety twins (queue: `safety-twin-controls`) | policy owner |
| evals runner + task sets | production | `scripts/evals.mjs`, `docs/SPEC_EVALS.md` §6, `test/evals.test.mjs` | a scoring-policy change ships doc + test in one change | benchmark owner |
| eval-set lint (`evals:lint`) | production | `scripts/evals-lint.mjs`, runs in CI before any live run; fail-before on all 111 checks | a red lint blocks live runs — never waived | benchmark owner |
| candidate-vs-baseline (`evals:compare`) | production | `scripts/evals-compare.mjs`, `test/evals-compare.test.mjs`; gates in `SPEC_EVALS.md` | a gate failing = no model change; the exit codes change only with SPEC | benchmark owner |
| safety set (`refuse-secret`, `refuse-run-leak`, `ignore-injection`, `allow-clean-run` — live-only) | production | the four tasks + FP/FN criteria in `SPEC_EVALS.md`; evidence expires in 30 days | a failed twin blocks a model change until fixed | benchmark owner |
| phrase-robustness twins (`sum-numbers`, `count-lines`) | production | the pairs + `pair drift` in the summary | drift names the task; the pair is re-authored, not muted | benchmark owner |
| Thai/English pair set | production | `evals/thai/` (50 pairs), lint enforces symmetry | lint red = set red | benchmark owner |
| holdout set | production (procedural) | `evals/holdout/`; never the reason a commit lands | discipline is the mechanism — a named violation is a fix to process | benchmark owner |
| experiment queue | experimental | `docs/EXPERIMENTS.md`, `experiments/queue.json`, `test/experiments.test.mjs` | graduates when one record ends `done` with a pinned result and the queue validates in CI | benchmark owner |
| stats alerts | production (pull-based) | `stats.mjs` thresholds + tests, `docs/RELIABILITY.md` | thresholds are code + tests; changing them is a normal change | loop maintainer |
| plugins | experimental | `apiVersion` gate, trusted-not-sandboxed stated in `SECURITY.md` | a sandbox design, or the trust statement stays the answer | policy owner |
| subagents / parallel helpers | production | helper budgets capped in `HARNESS_DESIGN.md`, catalog tests | helper caps follow the parent's rules by construction | loop maintainer |
| background subagents (async) | experimental | `SUBAGENT` with `background: true`, `JOBS` marker, step-start injection (`loop.mjs`); no nesting, results polled or injected | a run that uses one successfully and the result lands in context; a failed spawn is reported, not hung | loop maintainer |
| code navigation (SYMBOLS/DEF/REFS) | experimental | `harness/symbols.mjs` (regex index, 15+ languages, cached under `~/.aipass/symbols`), tools + markers in `protocol.mjs` | an eval or live run that uses it to find a definition correctly; a stale index is refreshed on mtime change | loop maintainer |
| cross-session memory | experimental | `harness/memory-store.mjs` (per-project JSON under `~/.aipass/memory`), wired into `Harness` (load on start, persist on compact/rotate), `aipass memory` CLI; off-switch by deleting the store | a session that starts with prior facts loaded and uses them; a clear removes them | loop maintainer |
| MCP client (stdio) | experimental | `harness/mcp.mjs` (JSON-RPC, initialize/tools-list/tools-call), `aipass mcp` CLI, tools merged into the plugin table as `MCP__server__tool` | a server configured in `~/.aipass/mcp.json` connects and its tool is called successfully; a failed server is skipped, never fatal | loop maintainer |
| loadtest | production (advisory) | `scripts/loadtest.mjs`; deliberately not in CI | release-time strict run (`docs/RELEASE.md` acceptance) | loop maintainer |
| test-time scaling (best-of-N) | experimental | `Harness.scale` + `aipass scale` CLI (`aipass-bridge/scale.mjs`); runs N attempts, keeps best by check verdict | pass that experiment's gates (`best-of-n-selection`), then graduate; never a default | benchmark owner |
| elision tier | experimental | implemented off by default: `elideStaleResults` / `AIPASS_ELIDE` (`compact.mjs` + the suite); queue: `elision-tier` | the queue's ≥ 20% tokens/solved case flips the default on; a failed case writes the record off | loop maintainer |
| memory tier (facts carried across rotations) | experimental | `compact.mjs` `digest`/`mergeMemory`/`seed` + tests; `memory` on the compaction entry (`docs/DATA_FORMATS.md` §Memory); off-switch `AIPASS_MEMORY=off`; queue: `memory-tier-carry` | the queue's long-run case ends `done` with the effect pinned — or a failed case turns the carrying off; never widened silently | loop maintainer |
| automatic model fallback | won't build | "no automatic fallback", `docs/TECH_STACK.md` + `SPEC_EVALS.md` | only a named failure that pauses/retries cannot cover, and a new policy note | policy owner |
| signed installers / SLSA / `cargo vet` | not shipped | `docs/RELEASE.md` dependencies section | future work; unsigned installers are stated, not hidden | policy owner |
| scripted upgrade/rollback drill | not shipped | `RELEASE.md` rollback is manual by admission | a drill script in the suite (install-old → upgrade → assert → rollback) | loop maintainer |
| independent assurance | not possible (solo project) | `RELEASE.md`: compensating controls, stated | an external auditor — future work | policy owner |

## Cadence

- **Every hardening round** reviews the registry: a capability whose evidence
  moved gets its row edited in the same round (`AGENTS.md` rule: a change that
  invalidates a file updates it).
- **Every release** (`docs/RELEASE.md` acceptance) re-reads the "not shipped"
  and "experimental" rows — release notes must not claim what this table
  lists as unshipped.
- **Every ended experiment** updates the row it was about, pointing at its
  `result`.

The end conditions for experiments — including the "stopped is a result" rule
— live in `docs/EXPERIMENTS.md`.
