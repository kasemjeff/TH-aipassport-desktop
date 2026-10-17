# Reliability

What "this install is healthy" means, in numbers the commands already print.
There is no server and no fleet — these targets are for one local install, and
the only honest availability is the chain: account → tab → bridge → backend.

## The SLIs, and where each is measured

| signal | what it is | measured by | target |
|---|---|---|---|
| run success | share of runs that end `done` with no guard stop | `npm run stats -- --last 50` (`byStop`, the guard-trip alert) | guard-stop share < 25% · tool refusal rate < 30% |
| local API | p95 latency, failed requests, RSS growth of the backend | `npm run loadtest -- --strict` (400 calls at 25 in flight) | p95 ≤ 250 ms · no failures · RSS +≤ 150 MB |
| chain availability | bridge up, extension attached, signed in, one round trip | `npm run doctor` (exit 0) · the bridge status line (`extension: 0 connected` means the tab is gone) | doctor green on the release machine |
| upstream step | seconds per model turn | `stats` `avg step` (from each run's `stepMs`) | reported, not targeted — upstream-controlled |
| drift | refusal / guard / cost / firewall signals | `npm run stats -- --alerts --strict` | no warnings |
| model quality | check-scored task outcomes, safety set included | `npm run evals -- --all --live --attempts 3` | read medians; gate list in `docs/SPEC_EVALS.md` |

`stats --json` carries the per-run rows — model, project root, stop reason,
refusals, spend, `stepMs` — and the `byModel` / `byRoot` groupings, so the
same report answers "which model drifts" and "which project drifts" instead
of blending them. `--html FILE` renders the same page.

## Error budget

The budget is **zero warned runs at release time**, over the last 50 runs:

- `npm run stats -- --strict` exits non-zero on any warn — refusal spike,
  guard-trip share, cost outlier. A warn spends the budget: the release is
  blocked unless the warning is *named* in the release notes with the plan
  (`docs/RELEASE.md` acceptance item 4 — this is the rule behind that
  sentence).
- `npm run loadtest -- --strict` breaching p95, RSS growth or a failure is
  over budget: fix first, ship after.
- `npm run check` or the CI matrix red is over budget: full stop.
- Info lines (firewall notes) never spend the budget — they are context.

Thresholds are deliberately coarse and live in two places:
`aipass-bridge/stats.mjs` (`alerts()`) and `scripts/loadtest.mjs`
(`--p95` / `--rss`). They answer "is this install drifting", not "what did
one run do".

## Degradation modes

When a dependency is missing, the harness degrades in a named way — never by
hanging or guessing. The full playbook is `docs/TROUBLESHOOTING.md`; the
shapes:

- **No tab / signed out** → the run pauses (`needs_tab`), `doctor` names the
  fix, nothing is lost, reconnecting continues the run.
- **Rate window (429)** → the client waits it out and retries; a 429 that
  survives the waits gets one more pause from the loop's recovery
  (`sendRecoveries`), and only then ends the run, surfaced — never silent.
- **Edge firewall (403)** → trigger-shaped content is encoded on the way
  out; a rejected turn is split and resent, and a fragment that cannot pass
  is dropped with a `firewallNotes` count. A refusal that outlasts the whole
  rewrite chain is paused and the same message goes again before it can end
  the run.
- **A guard trips** → the run stops with the reason recorded (`stalled`,
  `stagnation`, `steps`, `tool-calls`, …) and the session keeps everything.
- **Backend crash** → the desktop shell restarts it (`[supervisor]` lines);
  an in-flight run reads as a pause, and `~/.aipass/` is untouched.

## What is deliberately not here

No uptime percentage (there is no server to be up), no push paging (no
daemon — alerts are pull-based on purpose), no latency target on model steps
(the upstream is not ours to promise). Backup, restore and the RTO/RPO
numbers live in `docs/DATA_FORMATS.md` ("Recovery"); the drill that proves
them runs in `aipass-bridge/test/restore-drill.test.mjs`.
