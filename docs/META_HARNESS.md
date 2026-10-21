# META_HARNESS — the harness tuning itself

The question this document answers: **who decides what about the harness
changes?** Everything in this repository measures a lot — `npm run evals`
scores a run with a deterministic check, `npm run stats` watches the alerts,
`experiments/queue.json` records what to try next — but the last step was
always a person: read the numbers, decide what the numbers mean about the
harness, write the change, measure it again.

This is that step, as a command. It does not replace the judgment; it puts
the judgment in one place, with the evidence in front of it and the score
deciding the outcome.

## The shape

**The harness is cut into six components** (MemoHarness's dimensions, mapped
onto this codebase):

| dimension | what it decides | the code that decides it |
|---|---|---|
| `generation` | what the model is told before it starts | `harness/protocol.mjs` (the preamble), `harness/loop.mjs` (the reminder) |
| `tool` | which markers exist and what a call may touch | `harness/tools.mjs`, `harness/permissions.mjs` |
| `context` | what survives a long conversation | `harness/compact.mjs`, `harness/settings.mjs` |
| `memory` | which facts carry over | `harness/memory-store.mjs`, the memory tier in `compact.mjs` |
| `orchestration` | how the run is driven | `harness/loop.mjs`, `harness/sandbox.mjs` |
| `output` | what counts as done, and how a claim is checked | the DONE checker in `loop.mjs`, `docs/SPEC_CHECKER.md` |

**One component is edited at a time** (AHE's rule). The editable half of a
component is a *document*, one file per dimension, in
`~/.aipass/harness/policy/`:

```
~/.aipass/harness/policy/
  generation.md   tool.md   context.md   memory.md   orchestration.md   output.md
```

The runtime reads them (`harness/meta/policy.mjs`) and composes the enabled
ones into the **first message of a conversation** — this harness has no system
prompt, so the preamble *is* the system prompt (`harness/protocol.mjs`). The
overlay is **additive**: it can add a rule, never remove the built-in
protocol. With no document on disk the preamble is byte-identical to what it
was, which the replay fingerprint in `evals/fixtures/` depends on.

A document is prose and the model interprets it (natural-language harnesses):
nothing parses meaning out of it. What the runtime guarantees is narrower and
worth stating: the overlay is bounded (1200 bytes per document), it never
throws, and it never mangles what it carries (see *The checks* below).

**The code stays code.** A document may add a rule; it cannot change what
`loop.mjs` does. Prose steers, code decides.

## The loop

```
brief  →  propose  →  evaluate  →  apply | keep
```

- **`brief <dimension>`** writes the evidence pack: the contract, the source
  files the optimizer must read (with their digests and an outline), the
  current document, the **raw traces**, and the score as it stands.
- **`propose <dimension> --candidate FILE --hypothesis TEXT`** records a
  candidate. The baseline bytes are snapshotted here, so a rollback is exact.
- **`evaluate <id>`** runs the same matrix twice — once with the baseline
  document, once with the candidate — and compares the two with the gates
  `scripts/evals-compare.mjs` already owns: regression, safety, spend ≤ 2×,
  and the sample floor. The verdict is exit-coded.
- **`apply <id>`** puts the candidate in the live policy directory;
  **`rollback <id>`** puts the baseline bytes back.
- **`drive <dimension>`** is the self-driving arm: it builds the brief, lets
  the model write the candidate, measures it, and applies it only if the score
  moved.

The two arms are the discipline. A measurement runs the baseline policy
directory against the candidate policy directory, and **the two must differ in
exactly one file** — the command refuses otherwise, because a comparison over
two changes at once measures nothing.

## The evidence is raw

Meta-Harness's one hard lesson: the optimizer must read the **raw** trace, not
a summary of it. A summary drops the exact wording that made the difference,
and on a bad run the wording is the bug.

So `harness/meta/traces.mjs` never rewrites a trace. The index is a view for
scanning; the session JSONL on disk stays the source of truth; every excerpt
in a brief is the transcript line itself, trimmed for width, cited as
`file:line`, and the original is one read away. The same rule governs
compaction elsewhere in this harness: a summary that *replaces* the original
is a loss, not a compaction.

A brief therefore shows the model's own last words, the `err:` lines
(rule 3: a tool failure starts with `err:`), and the calls that repeated —
not a verdict about them.

## The checks

A candidate is checked **deterministically** before it is ever measured
(`harness/meta/verify.mjs`). The Verifier Tax is the reason: a cheap check
that always agrees beats an expensive one that sometimes does, and an LLM
verifier costs success rate on long tasks.

| check | what it refuses |
|---|---|
| `safety-floor` | a candidate that asks the model to ignore instructions, act without asking, skip a check, disable a guard, read a secret file, approve on its own, or loosen the DONE contract |
| `waf-token` | a candidate carrying a token the outbound table rewrites — the check is the table itself, so the model would read the text changed |
| `size` | a document over 1200 bytes |
| `empty` | an empty policy: that is a deletion, not an edit |

Passing the checks does **not** make a change good. It makes it *eligible to
be measured*. The score decides, and a change that does not move the score
stays a proposal.

## What it does not do

Stated plainly, because a loop that pretends to be more than it is will be
trusted more than it should be.

- **It does not tune the model.** Self-HPO's alternation between harness
  tuning and policy tuning needs an RL fine-tune; this repository ships no
  training. The policy here is prose in a file, and the model is what it is.
- **It does not adapt per case.** MemoHarness tunes a harness per case from
  stored experience. Here the document is per machine, and the score is per
  matrix.
- **It does not learn a context policy.** The compaction tier is untouched;
  `context` is a dimension an optimizer may propose a rule for, and the rule
  rides the preamble, not the compactor.
- **It does not judge with a model.** Every gate is a deterministic check or
  a counted number. An LLM verifier is a later step, and the research on the
  verifier tax says it lowers the success rate on long tasks.
- **It cannot measure a model offline.** `evaluate` runs the live matrix: it
  needs the bridge and a logged-in tab, exactly like `npm run evals -- --live`.
  Replay can prove the mechanics, never the score.

## Where things live

| what | where |
|---|---|
| policy documents | `~/.aipass/harness/policy/<dimension>.md` (`AIPASS_POLICY_DIR` overrides) |
| proposals | `~/.aipass/meta/proposals/<id>/` — `proposal.json`, `candidate/`, `baseline/` |
| verdicts | `~/.aipass/meta/verdicts/<id>.json` |
| briefs | `~/.aipass/meta/briefs/<dimension>-<id>.md` |
| arm runs | `~/.aipass/meta/runs/<id>/<arm>/` |

`AIPASS_POLICY_DIR` is what makes the two arms possible: the eval runner
gives every attempt a fresh `AIPASS_HOME`, so the policy directory is pointed
at the arm explicitly.

## Commands

```
node scripts/meta-optimize.mjs status
node scripts/meta-optimize.mjs brief <dimension> [--traces N]
node scripts/meta-optimize.mjs propose <dimension> --candidate FILE --hypothesis TEXT
node scripts/meta-optimize.mjs apply <id>
node scripts/meta-optimize.mjs rollback <id>
node scripts/meta-optimize.mjs evaluate <id> [--attempts N] [--min N] [--tasks A,B] [--thai]
node scripts/meta-optimize.mjs drive <dimension> [--hypothesis TEXT] [--evaluate]
node scripts/meta-optimize.mjs report
```

`npm run meta -- <command>` is the same thing.

The gates the verdict uses are the ones in `docs/SPEC_EVALS.md` ("Model
approval & routing"): a regression fails, an unsolved safety row fails, a
median spend above 2× fails, fewer than `--min` rows on either side is
insufficient sample and fails. Read medians, never the best draw.

## The files

| path | role |
|---|---|
| `aipass-bridge/harness/meta/policy.mjs` | the policy documents: load, compose, digest |
| `aipass-bridge/harness/meta/components.mjs` | the six components and the source files each one names |
| `aipass-bridge/harness/meta/traces.mjs` | the raw trace store |
| `aipass-bridge/harness/meta/verify.mjs` | the deterministic checks a candidate must pass |
| `aipass-bridge/harness/meta/proposals.mjs` | proposals, arms, apply, rollback, verdicts |
| `aipass-bridge/harness/meta/score.mjs` | the reading of a set of result rows |
| `scripts/meta-optimize.mjs` | the CLI |
| `aipass-bridge/test/meta-harness.test.mjs` | the self-tests (offline) |

## In the suite

`aipass-bridge/test/meta-harness.test.mjs` proves the parts that must not
drift: that the preamble is unchanged without a document, that a document
rides the first message additively, that the trace store quotes the raw line
and leaves the file alone, that a candidate weakening the floor is refused,
that the two arms differ in exactly one file, and that a rollback restores the
baseline bytes.
