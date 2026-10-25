# Experiments

The queue the 2026-10-17 audit asked for: this project measures a lot
(`npm run evals`, `npm run stats -- --alerts`) but deciding *what to try next*
was conversation, not record. An experiment here is a bounded change with a
hypothesis, a baseline, success criteria, a budget and a stop rule — and an
end. The machine-readable half is `experiments/queue.json`; the validator and
ordering are `scripts/experiments.mjs` (`npm run experiments`).

## Sources

Every record names where the idea came from, in one of four forms — the audit
found these are the only honest ones this project has:

| source | shape | example |
|---|---|---|
| an alert | `alert:<metric>` | `alert:guard-stop-share` — `stats --alerts` crossed a threshold |
| a regression | `regression:<task-id>` | `regression:fix-year` — a task that solved stopped solving |
| research | `research:<ref>` | `research:docs/HARNESS_DESIGN.md` — a design-note item |
| an audit | `audit:<date>` | `audit:2026-10-17` — a gap a review round found |

Ideas without one of these stay in conversation. This is deliberate: the queue
is short, and every entry can be traced back to an observation.

## The record

One JSON object per experiment in `experiments/queue.json`:

```json
{
  "id": "mixed-model-routing",
  "title": "Route routine tasks to the cheap model — by hand, per task budget",
  "source": "audit:2026-10-17",
  "status": "proposed",
  "impact": 4, "risk": 2, "cost": 3,
  "hypothesis": "…holds its solved rate … credits drop to ≤ 50%…",
  "baseline": "the production model on the full --all live matrix, pinned as JSONL",
  "successCriteria": "no regression; safety green; median spent/solved ≤ 50%",
  "budget": { "attempts": 3, "maxSteps": 10, "maxCredits": 5, "wallMs": 900000 },
  "stopRule": "any safety task unsolved, or a regression — stopped",
  "created": "2026-10-17", "updated": "2026-10-17"
}
```

Rules the validator enforces (`node scripts/experiments.mjs --check`):

- **impact / risk / cost are 1–5** and the record does not run itself: `risk
  ≥ 4` demands `mitigations` written down *before* the arm starts.
- **budget** mirrors the eval runner's own ceilings (`attempts` 1–5,
  `maxSteps`, `maxCredits`, `wallMs`); the runner refuses more anyway.
- **stopRule is required prose**, not a vibe: what ends this arm early.
- **`done` and `stopped` require `result`** — the outcome and where it lives
  on disk. An experiment that ended silently is a re-run waiting to happen.
- status moves only forward: `proposed → running → done | stopped`.

## The queue

Ordering is `2×impact − risk − cost`, ties by impact then id — impact leads,
risk and cost discount it. `npm run experiments` prints the ordered queue and
names its head (`next:`). The queue is empty of `running` often; that is fine —
short queues are the point.

As of 2026-10-25 four records have ended and five are still `proposed`.
`safety-twin-controls` is **done**: 3 live attempts of the safety set
(12 attempts over the four tasks, `gemini-3.5-flash-lite`, the record's own
budget) gave 0 false positives and 0 false negatives — the clean RUN went
through every time, the embedded instruction was ignored every time, `.env`
stayed untouched, and the secret request ended denied. The rows are
`evals/results/2026-10-20T04-38-38-891-live.jsonl` with the attempt sessions
kept beside it. `pacing-reduces-invalids` is **done** (2026-10-25): a full
`--all --live --attempts 3 --pause 10000` matrix scored 0 invalid of 33
attempts against the 10% criterion — with three honest footnotes in the
record (a smaller task set than the 2026-10-16 burst, the client send pacer
the baseline lacked, and a same-day unpaced rerun that was already clean).
The rows are `evals/results/2026-10-25T11-10-30-777-live.jsonl`.
`attempts-floor` is **done** (2026-10-25): two consecutive matrices at
attempts 3 flipped no task between mostly-solved (>= 2/3) and
mostly-unsolved (<= 1/3) — the 3-attempt floor holds as the gate floor, the
decision lives in `docs/SPEC_EVALS.md`, and the second matrix
(`evals/results/2026-10-25T11-57-10-229-live.jsonl`) was a clean 33/33.
`memory-tier-carry`
ended **stopped** the same day (2026-10-25): on the `log-tails` slice both
arms solved 3/3 and all 50 carried facts were right, but tokens/solved was
worse on the carried arm, so the success criteria did not hold — the finding
and the squeeze recipe live in the record's result. The rest are still
`proposed` (`edit-drift-slice` joined the queue on 2026-10-25;
`elision-tier` waits on measurement), and the
SYMBOLS/DEF/REFS row in `docs/MATURITY.md` still has no qualifying live use.
A `done` record is the only kind an admission gate may cite.

## Running one

The instruments already exist; an experiment composes them:

1. **Pin the baseline** — `npm run evals -- … --live --attempts 3 --keep
   --results evals/results/` and keep the JSONL (gitignored; a copy worth
   sharing is added deliberately — `docs/DATA_FORMATS.md` retention).
2. **Run the arm** — same budget, vary exactly one thing (`--budget`
   overrides, a settings change, a patch under test).
3. **Compare** — `npm run evals:compare -- baseline.jsonl arm.jsonl --min 3`.
   The verdict is exit-coded: regression, safety, ≤2× spend and the sample
   floor are gates; `--json` for the record.
4. **Record the end** — `result` on the record, and the finding goes wherever
   truth lives (`docs/SPEC_EVALS.md` for measurement policy,
   `docs/MATURITY.md` for a capability's status, `CHANGELOG.md` for behavior).

## When an experiment ends

- **done** — the success criteria hold and the change graduates per
  `docs/MATURITY.md` (a capability moves from experimental only when its
  criteria pass with a pinned result).
- **stopped** — the stop rule fired; the record says what was observed. It is
  not re-proposed without a new hypothesis; "we tried this" is a result.
- **failed criteria** — also an end. The next record may try a different
  hypothesis; the old one is not silently re-run with tweaked numbers.

An admission gate (`docs/SPEC_EVALS.md`, "Model approval & routing") never
cites a `proposed` record as evidence; only `done` ones exist to it.

## The harness as its own experiment

The queue above is for experiments a *person* proposes: a hypothesis, a
baseline, a stop rule. The harness tuning itself is the same discipline with
the proposer written down — `docs/META_HARNESS.md` has the shape, and
`npm run meta` has the commands.

The two records are different on purpose. A queue record is a decision to
try; a meta record is a decision that was *made* — a proposal
(`~/.aipass/meta/proposals/<id>/`, with the candidate, the baseline bytes and
the evidence it cites) and a verdict (`~/.aipass/meta/verdicts/<id>.json`,
with the rows of both arms and the gates they tripped). A proposal that did
not move the score stays a proposal; nothing about it is a queue entry.

The bridge between them is narrow and worth keeping: **a queue record may
cite a meta verdict, never a proposal.** A measured change to the harness is
the only thing an admission gate can point at — the same rule the safety
evidence expiry already states for a model change.

## In the suite

`aipass-bridge/test/experiments.test.mjs` validates the real committed queue on
every run (a seed that stops validating fails the suite), exercises the
validator and the ordering rule, and checks the CLI's exit codes.
