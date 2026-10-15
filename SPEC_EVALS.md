# Evals harness — spec

Spec for item (3) of the queue in [`HARNESS_DESIGN.md`](HARNESS_DESIGN.md):
"the harness improved" stops being an argument from memory. Two principles
carry in — a task passes only when a check exits 0 (no model self-report, no
judge), and a change is judged against tasks it was not tuned on. Everything
below reuses what exists; the new code is the runner, the task format, and its
tests.

## 1. Layout and task format

```
evals/
  tasks/<id>/
    task.md      the text handed to the agent — the only thing it sees
    task.json    the check + budget (below)
    tree/        the fixture, copied whole for each attempt
  holdout/<id>/  same shape; same runner, never used to iterate
scripts/evals.mjs   the runner (npm run evals)
evals/results/      one JSONL per run (§2)
```

```json
{
  "check": "node check.mjs",
  "budget": { "model": "gemini-3.5-flash-lite", "thinking": "low", "maxSteps": 10 },
  "allowRun": true
}
```

- **Check = one command**, run in the applied copy; exit 0 is the only
  "solved". No file predicates, no LLM judge — a predicate is a command
  (`node -e …`), and one form means one scoring path. The smoke's `math.mjs` +
  `check.mjs` pair is the canonical fixture.
- **Budget lives here** because a run's cost knobs are `maxSteps`
  (loop-enforced), `model`, and `thinking` (both ride the request —
  `harness/bridge.mjs` sends `thinking_level`). There is no credit or wall cap
  in the loop (design's not-shipped list), so the runner adds a wall-clock kill
  and records spend rather than guaranteeing it.
- A baseline run may override the budget globally (`--budget
  maxSteps=10,model=…`) so one matrix row hits every task; per-task values stay
  the defaults.
- Held-out tasks live in `evals/holdout/`, reported separately; the discipline
  is procedural — a held-out result is never the reason a commit lands.
- `tree/` carries `check.mjs` too, so a task is self-contained; the model's
  listing comes from `tree/`, not from `evals/`.

## 2. Runner

`scripts/evals.mjs` — main-guarded with exported helpers, like `stats.mjs`, so
the suite can import it. It drives **the `Harness` facade in-process**, not
`agent.mjs` (terminal rendering, the apply prompt, flag re-derivation) and not
`runTask` directly (`runTask` is one layer down; tests use it, but sessions,
conversations and `apply()` live in the facade). The result object, events, and
session give the metrics without scraping stdout.

Per attempt — sequential, because the bridge holds one current conversation and
`harness.run()` refuses a second run in flight; parallel attempts would have to
be separate processes:

1. attempt dir = `mkdtemp(path.join(os.tmpdir(), 'aipass-eval-'))`, copy
   `tree/` into it;
2. `process.env.AIPASS_HOME = <attempt>/home` (`harness/settings.mjs`
   `aipassHome`) and pass an explicit `store: new SessionStore(<attempt>/home/sessions)`;
   restore the env after;
3. `new Harness({ root: <attempt>/tree, bridge, model, store, events, options: {
   maxSteps, thinking, mode: 'auto', allowRun } })` — `auto` is the CLI's own
   mode (`agent.mjs`): writes stage without asking, shell follows `allowRun`
   (`permissions.mjs` evaluate);
4. `await h.run(taskText)`, then `h.apply(null)` — apply-then-check, the end
   state the CLI's one question produces; a run that died still gets scored, as
   the live smoke's write-after-429 did;
5. run the check command in `<attempt>/tree` (spawn, timeout, capture exit +
   tail);
6. read `run_stats` back from the attempt's session JSONL and write one row.

Live attempts get their temporary conversation from the default path
(`#ensureConversation` mints `temporary: true`; nothing sets
`reuse`/`permanent`/`conversation`), so the user's own conversations are never
named; ids are recorded.

Writes:

- `evals/results/<runId>.jsonl` — one JSON row per attempt (§3), append-only,
  session JSONL's shape;
- a stdout summary table (task, outcome, stop, turns, calls, nudges, stag,
  verify, fw, credits, wall) plus totals;
- the attempt session path in every row — evidence, so "it improved" can always
  be re-read;
- exit 0 only when every scored check passed; `--advisory` for runs whose point
  is watching, not gating.

## 3. Metrics

Mapped onto what runs already record (`run_stats` in `harness/loop.mjs`; shaped
by `stats.mjs` `collectRuns`; the raw JSONL under
`<AIPASS_HOME>/sessions/<slug(root)>/session-*.jsonl` is the source of truth):

| metric | field | notes |
|---|---|---|
| outcome | check exit code | new; `stopReason: 'done'` is never success |
| stop | `run_stats.stopReason` | done / steps / stalled / stagnation / error / plan-rejected |
| calls | `run_stats.tools` (`{n, fail}` per kind); `run_stats.steps` = executed marker calls (`toolsRun`) | refusal rate = Σfail/Σn |
| turns | `run_stats.stepMs.length` | one entry per conversation turn; no separate turn field exists |
| nudges / stagnations / verify / firewall | `nudges`, `stagnations`, `verifyPrompts`, `firewallNotes` | direct |
| spend | `run_stats.spent` (credits delta; `null` when quota fails) | the observable denominator — tokens are not exposed |
| wall | new, around run + apply | Σ`stepMs` is model wait only |

New row fields: taskId, attempt, mode (live/replay), the exact budget used,
session file + conversation ids, compaction count (session `compaction`
entries), check `{command, exit, ms, tail}`, `wallMs`, and the replay
fingerprint (§5).

## 4. Baselines

Budget-matched means same model, thinking, maxSteps, allowRun — vary exactly
one thing — and compare outcomes first, spend/wall second (spend is observed,
not matched). Pairs grounded in flags that exist:

- **slim vs full preamble** (`options.slim`, `loop.mjs`; `--slim`). Caveat
  built in: slim drops the whole tool protocol, so it only compares when an
  assistant already carries it (`--assistant` implies slim, `agent.mjs`).
- **plan vs not** (`--plan`): feeds PLAN/TODO into the preamble; the CLI does
  not gate on it (`requirePlanApproval` is a desktop-only path), so this
  measures trajectory change, not the gate.
- **single-shot vs loop**: `maxSteps` 1 vs N (`--max`). Deliberately not
  budget-matched — the smaller budget is the treatment; label it.
- **thinking off/low/high** (`--thinking`, threaded to `thinking_level`).
- **cold vs warm**: `--reuse` continues the newest conversation. Live-only and
  dirty (whatever the server still remembers) — a probe, not a baseline.

Must be added before it can be measured: R4's verification nudge and the
stagnation guard are always-on (`loop.mjs`) — an off switch is a two-line
option if the ablation is wanted; wall-clock and credit caps need loop hooks
(not shipped today).

## 5. Two modes

**(a) live** — the real model, through the user's bridge on 8787 and the
logged-in tab. Probe discipline from the design's measured rounds: fresh
temporary conversation per attempt; keep under ten messages per four minutes (a
three-probe burst plus one run, ten messages, drew a 429); a session-level
block (~100 messages, lifted in ~20 min) stops the whole run; never bind or
probe 8787/8790 (`verify.mjs` protected ports); abort on `needs_tab`. A 429 or
timeout marks the attempt **invalid**, not unsolved — charging it as a failure
would lie about the model.

**(b) offline/replay** — no network, no tab, for CI. `class StubBridge extends
BridgeClient` answering in order from a recorded transcript (the
`harness-fixes.test.mjs` stub pattern), replies taken from a real session's
`assistant` entries — the session already records every reply, raw enough to
replay (the loop decodes what `chat` returns, and the recording is exactly
that). This drives the real loop, tools, overlay, sandbox, apply, and check;
only the bytes between chat and the model are gone.

How dirty the boundary is, plainly: replay tests harness mechanics and
non-regression of recorded trajectories — it cannot measure model capability,
cannot exercise the WAF/403 path (`firewallNotes` stays 0 by construction), and
goes stale the moment task text, preamble, or tool results change. So every
replay row carries a fingerprint (task bytes + preamble bytes + reply count); a
mismatch marks the replay stale instead of scoring it as a regression. Middle
option for a test that needs the HTTP seam: real `bridge/server.mjs` +
`FakeExtension` + `scripted()` from `test/harness.mjs` — localhost only, still
no Chrome.

## 6. Runner self-tests

`aipass-bridge/test/evals.test.mjs` — picked up automatically by
`scripts/test.mjs`, with `AIPASS_HOME` on a `mkdtemp` so nothing touches the
real `~/.aipass` (`harness-fixes.test.mjs` convention):

1. `loadTask` parses task.md + task.json; a missing check or bad JSON fails
   with a named error.
2. Scoring: exit 0 → solved; nonzero → unsolved with tail; the task's source
   `tree/` is byte-identical afterwards (writes went to the copy).
3. Results: two attempts append two JSONL rows; the summary names each outcome;
   rows carry stopReason, steps, stepMs, nudges, spent, wallMs.
4. Replay: a two-reply transcript takes the math fixture to `stopReason: done`;
   apply + `node check.mjs` → solved, through `StubBridge`, with no fetch
   anywhere.
5. Isolation: with AIPASS_HOME on a decoy, an attempt writes sessions only
   under its own attempt dir; the decoy is untouched.
6. Budget plumbing: `thinking`/`maxSteps`/`allowRun` from task.json reach the
   loop (the stub records the thinking level; a `maxSteps: 1` NEED-reply task
   ends `steps`, not `done`).

## 7. Open questions

1. **Results and baselines on disk**: commit `evals/results/` snapshots
   (diffable in PRs, but every live run churns them) or gitignore run output
   and keep one curated baseline file updated deliberately?
2. **Attempt policy for stochastic live runs**: one attempt per task, or n with
   a stated rule (report all; compare p@n or median spend)? This sets pacing,
   block risk, and what "budget-matched" means across seeds.
3. **Check contract**: timeout before the check is killed, network allowed or
   refused, env scrubbed (AIPASS_* stripped), and whether `node_modules` is
   junctioned into the attempt (the `sandbox.mjs` precedent) for tasks that
   need deps.

## As shipped (2026-10-15)

`scripts/evals.mjs` with fixtures under `evals/`; the six §6 self-tests live
in `aipass-bridge/test/evals.test.mjs` and are offline (replay + StubBridge
only — `globalThis.fetch` throws during the transcript test). Decisions the
text left open, as built:

- **Open question 1** resolved as: run output is machine-local
  (`/evals/results/*.jsonl` in `.gitignore`); a result worth keeping is added
  deliberately. The `.gitkeep` ships.
- **Live mode always needs `--live`** — a bare invocation refuses with exit 2
  rather than guessing. Exit is 0 only when every row is solved or stale;
  `--advisory` forces 0; unknown flags and a refused live run exit 2.
- **`wallMs`** may ride a task budget (runner-level wall kill, default
  10 minutes); a wall-killed attempt is invalid, not unsolved.
- **Shipped fixtures budget on `gemini-3.1-flash-lite`** — the bridge's
  free-credit default — so live runs do not burn credits; `--budget model=…`
  overrides for a production-model matrix.
- **Extra flags**: `--results DIR` (JSONL output location); `--budget`
  accepts maxSteps, model, thinking only.
- **Replay fingerprint**: sha256 over task bytes + preamble bytes + reply
  count (CRLF normalised, BOM tolerated); the digest rides the fixture's
  `fingerprint` block and every row, and a mismatch marks rows `stale` —
  never scored.
