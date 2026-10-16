# The checker — v1: a typed subagent the loop invokes before DONE

Spec for item (2) of the queue in [`HARNESS_DESIGN.md`](HARNESS_DESIGN.md) —
"a verification SUBAGENT, the natural first typed helper". Written against the
code as it stands (2026-10-15).

Why now: R4 asks the model to prove a staged change — but only when the DONE
arrives in a *later* reply. A reply that stages code and writes DONE in the
same step exits at `loop.mjs:286` before the nudge at `loop.mjs:335` is ever
reached, and `!work.length && effectiveDone` (`loop.mjs:197`) exits the same
way. The projection made a mechanical proof possible (`run-overlay.test.mjs`);
the checker is the piece that puts a verdict behind every DONE.

## 1. Contract

`ctx.check({ files }) -> Promise<{ verdict: 'pass' | 'fail' | 'none', text, ran }>`
— wired by the facade exactly where `subagent` is wired today
(`harness.mjs:290`), implemented as `#makeChecker()` beside `#makeHelper()`
(`harness.mjs:351`). No new marker: the preamble (`protocol.mjs:26`) does not
move, so CLI turn-1 bytes stay identical.

- **The verdict is computed, not read.** From the child session's tool entries
  (`loop.mjs:267` records every call with `ok`): any `run` with
  `ok === false` → `fail`; only `ok === true` runs → `pass`; no runs → `none`.
  The checker's prose is `text` (clipped at 4000 — the `previewOf` precedent,
  `loop.mjs:30`) and is never parsed.
- **What it reads.** A child `Overlay` seeded one-for-one from the parent's map
  (`child.map.set(abs, value)`), same root. `read`/`list`/`search` see staged
  content, and because the child overlay is non-empty, every checker `run`
  goes through the projection (`tools.mjs:285-309` → `materializeTree`,
  `sandbox.mjs:42`): staged files written in, staged deletes left out
  (`sandbox.mjs:52`), `HEAVY` dirs junctioned, output scrubbed back to the
  project root (`restorePaths`). The parent never mutates while it awaits the
  check, so the snapshot is exact.
- **What it may write.** Nothing. A new `readOnly` flag on `createTools` turns
  `write`/`replace`/`delete`/`move` into
  `err: the checker is read-only — report it in your summary instead.`
  Why: a checker edit is a proposal landing after the run claimed to be
  finished, invisible to the model that was finished with it; and
  check → fix → check has no bound. The report is the deliverable.
- **Where it runs.** Its own conversation
  (`createConversation({ temporary: true, adopt: false })`, the P2-B pattern,
  `harness.mjs:365`) and its own session file (`check: <files>`) — never the
  parent's conversation, which would spend the exact context the check
  protects. Its `runTask` writes its own `run_stats`.
- **What it is asked.** Composed by the facade, not the loop: "the pending
  edits below are already applied in this tree; run the project's own checks
  against it (test, build, typecheck, node --check); do not edit anything; if
  nothing is runnable, say so", followed by the posix path list (deletes
  marked).
- **Errors.** Tool failures keep the `err: …` shape (`tools.mjs:10`).
  Structural failure never crosses the boundary: `check` resolves
  `{ verdict: 'none', text: 'check could not run: <message>', ran: 0 }`.

## 2. Loop integration

**When.** At the two DONE sites — `!work.length && effectiveDone`
(`loop.mjs:197`) and `done && !stillLooking` (`loop.mjs:286`) — before
`done_line` or any break. Not on the R4 nudge (mid-run, the model can still
verify itself cheaply) and not on `ignore_done` (`loop.mjs:293`); only DONE is
a claim. Give both sites one shared finish path: a fail must not fall through
to the second site and break there.

**Gate**, mirroring R4's condition so the two stages disagree about nothing:
`overlay.size > 0 && codeTouched && !verifiedSinceChange && !checkRan` — plus
`options.subagent && options.allowRun`. A check is an execution; a child must
not escalate a privilege the run refused. `codeTouched` reuses `CODE_FILE`
(`loop.mjs:28`); docs-only runs skip, as they skip R4. The intended everyday
configuration is the desktop's defaults (`subagent: true`, `settings.mjs:33`)
with RUN enabled.

**Latch.** `checkRan` goes up before the first await — one check per run. A
fail verdict earns exactly one continuation; the next DONE is accepted, record
and all.

**On fail.** Do not finish. The report rides the next message the way the R4
nudge does, appended after `next = results…` (`loop.mjs:294`) so compaction and
the stagnation guard still see the step:

```
Before DONE, a check of the staged tree ran and did not pass:
<text ≤4000>

Fix the staged files, or explain why the failure is not yours to fix.
```

The continuation consumes one parent step; on the last step there is no room,
and the run ends `done` with the verdict recorded for the human.

**On pass / none.** Finish exactly as today, no extra send — the model does not
need to hear a check it cannot act on. The verdict rides a session note in R4's
shape, `check_start` / `check_end` events, `finished.check = { verdict, ran, text }`,
and a window listener (`desktop/ui/app.js:371` is the pattern).

**Budget and stats.** `nudges` stays the no-marker counter; `verifyPrompts`
stays R4's. `run_stats` gains `checks: 0 | 1` and
`checkVerdict: 'pass' | 'fail' | 'none'`; `stats.mjs` `collectRuns`/`summarize`
pass them through and the summary line prints them. The checker's steps and
timings live in its session; credits are global, so the parent's `spent`
(`loop.mjs:367`) already includes the check.

**Bounds.** Child `maxSteps = Math.min(parent.maxSteps, 6)` (run-and-report is
narrower than a helper's 8, `harness.mjs:384`); the child's own stagnation
guard and the 120 s RUN timeout come free through the same `runTask`/`tools.run`;
`signal: this.abort.signal` propagates cancel; `subagent: false` in the child
turns a nested `SUBAGENT` into `err: no helper is available in this run`
(`loop.mjs:415`) — v1 forbids nesting because one report and a bounded cost are
the whole point, and a checker that delegates is neither.

## 3. Edge cases and v1 boundaries

- **Snapshot, no merge-back.** The child overlay is dropped with the check
  (read-only anyway); only the report returns. Nothing the checker saw can
  conflict with later parent writes.
- **Staged DELETE** is absent from the projection (`sandbox.mjs:52`), so a
  checker run sees the tree Apply would leave — a delete that breaks an
  import is exactly the finding v1 exists for.
- **Binary and large trees.** `materializeTree` copies every non-`SKIP`/`HEAVY`
  file; each checker RUN pays one projection, the same bill any RUN pays. A
  write through a junction still reaches the real tree — RUN's existing
  semantics, not a new risk.
- **Projection failure falls back to disk** (`tools.mjs:290-293`). v1 keeps
  that fallback and accepts a verdict that may reflect the disk; the report
  names the command, so the human can tell.
- **Sandbox cleanup** is `tools.run`'s `finally` (`tools.mjs:307`); a killed
  process can leave `.aipass/run/run-*`, which `SKIP` already hides from every
  walk. No startup sweep in v1.
- **Missing tab / no helper conversation.** If `createConversation` fails, skip
  the check — never fall back to the parent's conversation. DONE is accepted,
  a note says why, `checks: 0`. `needs_tab` stays the parent's own path
  (`loop.mjs:175`).
- **Other exits** — stagnation, step limit, error, cancel, plan-rejected —
  never check: a half-finished run's overlay is a diff for the human, not a
  claim.

## 4. Test plan — `aipass-bridge/test/checker.test.mjs`

`node:test` + `assert/strict`; tmp trees via `tempDir` (`test/harness.mjs:363`);
a `StubBridge extends BridgeClient` with a reply queue **per conversation**
(the `harness-fixes.test.mjs:214` pattern) so parent and checker exchanges are
asserted separately; `Emitter` for events.

1. **A stage + DONE reply is checked, and a failing check reaches the model** —
   broken `math.mjs` + `check.mjs`; the parent's first reply stages the fix and
   DONE (the reply R4 misses); checker replies `RUN\nnode check.mjs\nEND`
   (exit 1). Assert the parent's conversation gained the failure text; a second
   DONE ends the run; `run_stats` has `checks: 1, checkVerdict: 'fail'`.
2. **A passing check costs the model nothing** — checker's run exits 0: assert
   no extra parent message after DONE (send count), `check_end` fired `pass`,
   `finished.check.verdict === 'pass'`.
3. **The checker sees the projection, the disk does not move** — its run prints
   PASS; `math.mjs` on disk is still broken; `.aipass/run` is empty afterwards.
4. **A staged DELETE is gone in the projection** — checker runs
   `existsSync('secret.txt')` → `false`.
5. **Writes are refused** — checker replies `CREATE helper.mjs …`: result
   matches `/^err: the checker is read-only/`, parent `pendingChanges()`
   unchanged.
6. **One check per run** — no `check_start` before DONE, and after fail +
   second DONE no second checker conversation (`createConversation` count /
   `check_start` count stays 1).
7. **No RUN, no check** — `allowRun: false` with staged code: no checker
   conversation, `checks: 0`, run ends `done`.
8. **Checker conversation unavailable** — `createConversation` answers null:
   DONE accepted, skip note in the session, `checks: 0`, no checker prompt in
   the parent conversation.

## 5. Open questions

1. **Model-invocable?** v1 is loop-only. Should a `VERIFY` marker let the model
   ask for exactly this mid-run? The generic SUBAGENT cannot be told "verify",
   which is the gap this design is built around.
2. **One continuation, or a hard gate?** The spine's stronger reading is "done
   means a runnable check passed". v1 accepts the second DONE and records the
   verdict; a `done-unverified` bucket in `byStop` is a decision for after
   `checks`/`checkVerdict` have data.
3. **Where does "the project's check" come from?** v1 has the checker infer it
   (package.json scripts, test files) — fine for a first pass, noisy for
   stats. A declared check command (settings, or `.aipass/check.txt`) would
   make verdicts comparable across runs.
