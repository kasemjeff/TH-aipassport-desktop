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

`ctx.check({ files }) -> Promise<{ verdict: 'pass' | 'fail' | 'none', text, ran, declared, declaredSource }>`
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

**Gate**: `overlay.size > 0 && codeTouched` — plus `options.subagent &&
options.allowRun`. A check is an execution; a child must not escalate a
privilege the run refused. `codeTouched` reuses `CODE_FILE` (`loop.mjs:28`);
docs-only runs skip, as they skip R4. The gate deliberately drops R4's
`!verifiedSinceChange`: a self-run or a read-back is the model grading its own
paper, and the child exists to be a verdict the run cannot write for itself.
The intended everyday configuration is the desktop's defaults (`subagent:
true`, `settings.mjs:33`) with RUN enabled.

**Bound.** `CHECK_ROUNDS_MAX = 2` verdicts a run. The first DONE over staged
code gets the check; a fail earns exactly one continuation, and the re-check
runs only if the tree moved since the verdict (`mutations` vs
`mutationsAtLastCheck`) — a DONE over the tree the check already judged earns
no second conversation. A second fail is accepted with the verdict recorded.

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

**Bounds.** Child `maxSteps = 6` — or the parent's own cap when that is lower;
an uncapped parent (0) does not uncap the checker (run-and-report is
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
  process used to leave the whole copy behind, under `.aipass/run/run-*`,
  with nothing to collect it. Since 2026-10-20 the projection lives under
  `~/.aipass/run/` and a janitor (`sweepSandboxes`, called when a harness
  opens a project and before every run) collects what no run can still own.
  The janitor knows who owns a projection — a stamp beside it, carrying the
  pid — so a copy whose backend died is collected after minutes instead of
  after the six hours a live run's budget needs.
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
6. **An always-run exit check, bounded at two verdicts** — no `check_start`
   before DONE; a self-run in the reply does not stand it down; after fail +
   fix + DONE the re-check runs; a second fail is accepted with `checks: 2`
   (`createConversation` count follows the verdicts).
7. **No RUN, no check** — `allowRun: false` with staged code: no checker
   conversation, `checks: 0`, run ends `done`.
8. **Checker conversation unavailable** — `createConversation` answers null:
   DONE accepted, skip note in the session, `checks: 0`, no checker prompt in
   the parent conversation.
9. **A run-declared `verifyCommand` beats the project file** — the checker
   prompt says "This run declares…", the other command is absent, and the
   verdict carries `declared: 'node check.mjs'`, `declaredSource: 'run'` and
   the same `run_stats.checkCommand`.
10. **`requireCheck` refuses a later DONE** — a failing first verdict still
    earns its correction; the next DONE over the unchanged tree ends as
    `done-unverified` with `doneUnverified: 1` and no extra checker
    conversation. A passing check still ends as `done`.
11. **The commit gate reads the same declared command** — with
    `verifyCommand` and no `.aipass/check.txt`, a `git commit` is refused and
    the message names `--verify-command: node check.mjs`; after the command
    passes, the same commit reaches git (`test/gates.test.mjs`).

## 5. Open questions

1. **Model-invocable?** v1 is loop-only. Should a `VERIFY` marker let the model
   ask for exactly this mid-run? The generic SUBAGENT cannot be told "verify",
   which is the gap this design is built around.
2. **One continuation, or a hard gate?** Answered 2026-10-20 as an opt-in:
   `requireCheck` refuses a DONE over a declared check that is still failing and
   ends the run as `done-unverified`. The default stays advisory — a fail earns
   one continuation and a fix earns one re-check (two verdicts a run, max), so
   the existing behavior and its tests are unchanged unless a caller asks for
   the gate. The gate fires only when a declared check exists and the checker
   actually ran (`subagent` and `allowRun` on, a staged tree); with no verdict
   there is nothing to enforce.
3. **Where does "the project's check" come from?** Answered 2026-10-16 with the
   declared check below: `.aipass/check.txt` names the command when the project
   wants verdicts to be comparable. Since 2026-10-20 `verifyCommand` names the
   same command for a run (or every run, from the settings sheet) before the
   project commits the file; the option wins, and the verdict records
   `declaredSource: 'run' | 'project'`. Without either, the checker keeps
   inferring from the tree (package.json scripts, test files).

## As shipped (2026-10-16)

Two changes from the Thai pack round:

1. **The stalled exit gets the check's one attempt.** A run whose no-marker
   nudges are exhausted no longer stops straight to `stalled`: `finishCheck()`
   runs once — a fail rides a step the model can act on, and a pass ends the
   run as `done` with the summary "check passed after a stalled step". A
   staged, verified tree is a finished run even when the words never came.
   Pinned in `test/lang-guard.test.mjs`.
2. **The verdict names staged test files.** When the staged set includes
   files matching the test patterns (`test/`, `__tests__/`, `*.test.*`,
   `*.spec.*`), both the checker prompt and the verdict text list them
   (`testsTouched`), so a passing check that also edited its tests is not
   read as proof of the code. Pinned in `test/checker.test.mjs`.
3. **A declared check command.** The first non-comment line of
   `.aipass/check.txt`, read from disk (the run's overlay is deliberately
   ignored — a value staged in this run must not bend the command that judges
   it), replaces the inferred checks in the checker prompt: run exactly this,
   and let its output decide. The verdict machinery is unchanged — the
   command's own exit code lands in the child's `run` entries — and the
   declared value rides back in the result as `declared`. Absent the file,
   nothing changes. Pinned in `test/checker.test.mjs`.
4. **The declared check arms the red-test commit gate (2026-10-17).** A
   `git commit` RUN is refused while the declared command has not *passed* at
   the current tree state — the refusal names the exact command that un-bars
   it (`RUN` → `<declared>` → `END`), any later change re-arms the gate, and
   a project without `.aipass/check.txt` is untouched. The gate sits ahead of
   the permission ask on purpose: it is not a question to override, it is
   "run the check first". Refusals are counted in `run_stats.commitBlocks`
   and the gate itself is one exported function (`isGitCommit`) shared with
   the command-risk classifier, so the two cannot drift. Pinned in
   `test/gates.test.mjs`.

## As shipped (2026-10-20)

The two open questions above closed, with the default behavior left alone:

1. **`verifyCommand` — a declared check without a project file.** One command
   string on the run (CLI `--verify-command`, RPC `run`, settings sheet) wins
   over `.aipass/check.txt`; the checker prompt names whose command it is, and
   the verdict carries `declared` and `declaredSource`. The same option arms
   the commit gate, whose refusal names the source (`--verify-command` or
   `.aipass/check.txt`). `run_stats.checkCommand` records the command beside
   `checkVerdict`, so two runs are only compared when they ran the same thing.
   The settings sanitizer keeps one line and 300 characters; a pasted second
   line never reaches a shell. Pinned in `checker.test.mjs`,
   `gates.test.mjs`, `settings-clamp.test.mjs` and `desktop.test.mjs`.
2. **`requireCheck` — the hard gate is opt-in.** A first failing verdict still
   rides back as the correction; a later DONE over the same failing tree (or a
   DONE with no step left to carry the report) is terminal as
   `done-unverified`. The gate requires a declared check and a checker that
   actually ran; without a verdict there is nothing to enforce, so existing
   runs and their tests are unchanged. `run_stats.doneUnverified` counts the
   refusal. Pinned in `checker.test.mjs`.
3. **One shape check before dispatch.** Not checker-specific, but it changes
   what a bad checker reply sees: `validateCall()` (`harness/validate.mjs`)
   runs before every built-in, plugin and MCP call, so an empty `RUN` or a
   blank `SEARCH` is one `err: …` sentence no matter which surface would have
   handled it. Pinned in `test/validate.test.mjs`.
