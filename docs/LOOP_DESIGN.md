# The loop — design & contracts

`aipass-bridge/harness/loop.mjs` drives one task from the first message to a
DONE: send, parse, execute, paste the results back. This is the detailed map of
that machine — the stages of a step, every guard with its trigger and stop
reason, and the event contract everything above the loop (the window, a
terminal, the tests) reads. The same loop drives all three because it emits
events instead of printing.

For the whole harness — the review, the findings, the open designs — see
[`HARNESS_DESIGN.md`](HARNESS_DESIGN.md). For the architecture around it,
[`TECH_STACK.md`](TECH_STACK.md) and
[`aipass-bridge/docs/DOCS.md`](../aipass-bridge/docs/DOCS.md). Written against
v0.2 (2026-10).

## The constraints that shaped it

Two facts decide the whole shape:

- The upstream endpoint takes **exactly one user message per request** — a
  `messages` array containing an assistant turn is a bare 403 from the edge,
  before the model sees it.
- **The server owns the history.** Nothing local "trims" it; a full context is
  answered by rotating conversations, never by editing the message array.

So the loop sends the preamble once (turn 1 of a fresh conversation), and every
later message is only the results of the previous reply, joined as one text and
closed with the `REMINDER`. "Context is full" is handled by `compact.mjs`
(summarise → rotate → re-seed), not by cutting messages.

## Shape of one run

```
runTask(task):
  overlay.clear()                    ← writes land here, never on disk
  say(preamble + task)               ← turn 1 only
  │
  ▼  repeat, at most maxSteps (default: no cap — until DONE, a guard, a budget)
  ┌──────────────────────────────────────────────────────────────┐
  │ say(results of the last reply)   ← ONE message, whatever the  │
  │                                    reply carried              │
  │ reply → prose() + parse()        ← the whole text is scanned  │
  │   no calls   → nudge ×2, then the stall path                  │
  │   calls      → execute in order, behind the permission gate   │
  │                 plan gate · diff_update · budgets             │
  │   DONE       → checker → plan checkpoint → language check →   │
  │                done_line → stop                               │
  │ guards: repeat · stagnation · verify-nudge · compaction       │
  └──────────────────────────────────────────────────────────────┘
  │
  ▼
run_stats + finished: summary, stopReason, changes, credits spent,
                       the final checklist (todo)
```

The loop returns `{ summary, stopReason, steps, changes, credits, spent,
check, todo }`, records a `run_stats` line into the session, and emits
`finished` (whose `todo` carries the run's final checklist state — `[]` when
no plan was written — so the window can re-tally the plan card without
replaying the run's todo events).
`npm run stats` aggregates those lines: refusal rates, nudges, stagnation
corrections, err-loop corrections, chain skips, verification nudges, firewall
notes, the closing context estimate (`estTokens`), step timings, credits.

## Who wires what

`runTask` is never called by a UI or a CLI directly — `harness.mjs` owns the
call, because the facade is where the one-conversation resource and the helper
factories live. The context that matters:

| ctx | wired when | what it does |
|---|---|---|
| `subagent` | `options.subagent` | a child loop on its own conversation; role-less helpers propose edits into the parent overlay |
| `check` | always wired by the facade | a read-only verifier child — runs when the run can (`subagent` + `allowRun`) and code is staged; always at DONE (a self-run does not stand it down), at most two verdicts a run; returns `{verdict: pass/fail/none, text, ran}` |
| `approvePlan` | `options.requirePlanApproval` | emits `plan_request`; the window's modal answers through `plan.answer` |
| `compactor` / `rotate` | always | checked against the message about to go out |
| `onConversationDead` | always wired by the facade | (session resume) the conversation a reopened session adopted turned out to be gone upstream — only asked on the run's first send, before the wait-and-retry ladder, and answered with a fresh conversation plus a transcript digest to send instead |
| `onConversationSettled` | always wired by the facade | (session resume) called after every accepted send — idempotent; the facade settles the session's conversation binding and commits a resume seed's boundary on the first one |
| `permissions` | always | `ask` / `auto` / `yolo`, persisted rules and "always" grants; nobody listening means deny |

Defaults come from `settings.mjs`: `maxSteps: 0` (no cap — a cap is 1–200 and
the last step says so),
`maxToolCalls: 300`, `maxWallClockMs: 30 min`, `repeatGuardMax: 4`,
`minThaiRatio: 0.4` (the recorded closings split at a wide gap: English at 0,
Thai at 0.57+). `requirePlanApproval` is a saved setting — a run call
may override it, but the saved value is what the window flips and relies on.

## Anatomy of one step

The `for` body, in order. "Stops" names the stop reason if the stage ends the
run.

**1. Budget before the send.** The wall clock is checked before every reply —
waiting on a slow model is as real a spend as running a command. Stops:
`time-limited` (via `spendBudget`).

**2. The send.** `saySafe` → `resilientSay`: a message the edge rejects is
retried once in a halved/rewritten form (`firewall_note` goes out). A 429 is
not rewritten — it is waited out, first in the page (10s/45s/120s, on a clock
the whole tab shares) and then by the client and the message layer
(`RATE_WAITS_MS` — 60s/180s — twice over), so a busy edge pauses a run
instead of ending it; the rewrite chain never sees a rate refusal, and a
refusal that arrives after deltas streamed is never resent at all. Above the
chain the loop keeps one bounded recovery of its own (`RECOVER_WAITS_MS` —
30s then 60s): a send that delivered nothing and heals by waiting — the
connection-cycle shapes, a tab still loading, a rate window, a 403 the chain
could not clear — is paused and given the same message again
(`sendRecoverable` names the shapes; `run_stats.sendRecoveries` counts it),
so `error` is what stays once even those waits run out. The user pressing
stop surfaces as `AbortError` — an ending, not a failure — and the transcript
must not read "error" for it: `cancelled`. The stop reaches every wait, not
only the send: the loop checks the signal between the tools of a reply and
between steps, a command in flight is killed with its tree, the projection a
RUN waits for is abandoned, the web search and an MCP call ride the same
signal, a stopped run stages no more edits, and the summariser rides it too —
so "stopped" means the work stopped. An
error naming a missing chat tab emits `needs_tab` so the window can offer the
fix in one click.
Stops: `cancelled`, `error`.

**3. Parse.** `prose()` + `parse()` scan the whole reply. Markers only count
when they start their own line, and fenced code is skipped. `done` and `ask`
are pulled out; everything else is `work`. The first real prose line becomes
`thinking` — the window's "what is it doing" line.

**4. Nothing actionable?** Three branches:

- an ASK (and no reads in flight): the question is the closing message — the
  language check applies, nothing is checked — and the run pauses for the
  answer. Emits `done_line` + `ask`. Stops: `ask`;
- an effective DONE (an explicit `DONE`, or prose-only after tools have run):
  the finish pipeline — `finishCheck` when code is staged (always: a self-run
  does not stand it down; at most two verdicts a run), then the plan
  checkpoint (once a run that wrote a PLAN/TODO: a DONE with items still open
  names them and asks for a ticked TODO — the next DONE ends the run either
  way), then the language check, then `done_line`. Stops: `done`;
- otherwise the nudge pipeline: streaks 1–2 emit `nudge` and send a
  marker-shaped reminder; the third consecutive blank reply is the stall path
  — one last checker attempt if it can help, then `give_up`. Stops: `stalled`.

**5. Helpers fan out** (when `parallelHelpers` and the reply carries
`SUBAGENT`). Capacity is checked *before* the fan-out — a reply with a hundred
helpers must trip the tool budget before it starts a hundred child loops —
then `Promise.all`; results re-assemble in marker order.

**6. Execute, in order.** Every call goes through `guarded()`:

- **shape check** — `validateCall()` runs before anything is dispatched: a
  built-in, a plugin marker and an MCP tool all answer a malformed call with
  the same `err: …` sentence, so no implementation has to own the parser's
  contract and no malformed call reaches a tool that might throw;
- **red-test gate** — a `git commit` RUN while the run's declared check
  (`.aipass/check.txt`, or the `verifyCommand` option) has not passed at the
  current tree state is refused with the exact command that un-bars it and the
  source it came from (`commitBlocks`); a declared check that passes records
  the state, and any later change re-arms the gate. No declared check, no
  gate — naming one is the project's own opt-in;
- **repeat guard** — the identical call (kind + arg + body) for the third
  time, with no staged change in between, is refused as a loop, not a step
  (`repeat_block`); control markers (`plan`, `todo`, `subagent`) are exempt.
  More than `repeatGuardMax` refusals in one run stop it (see the table);
- **permission gate** — `permissions.request()`: `deny` answers the model with
  `err: the person watching declined …`; `always` records a grant for the
  project;
- **arg guard** — a path call refused for a missing file is retried once with
  invisible characters stripped and non-ASCII digits normalised, and the
  result says so;
- **chain guard** — once a change has failed in this reply, every later change
  or RUN in the same reply is skipped before it starts: the skip is stated in
  the results as `err: skipped …`, flagged on `tool`, and spends no budget;
  reads, git, web and control markers still run;
- **err loop** — a failure is keyed by kind + first error line with the call's
  own argument masked; the third same-key failure in a row earns a correction
  on its result (`errLoops`), and a streak past `repeatGuardMax` stops the run;
- **budgets** — both are checked before each call; a budget spent mid-reply
  stops the run where it is (later calls do not execute).

Every executed call emits `tool` (kind, label, ok, first line — a RUN's label
is its command) and is recorded into the session with the `err:` flag.

**7. Plan gate, and the todo card.** If the reply carried `PLAN` and the run
is not approved yet, `approvePlan()` runs: the facade emits `plan_request` and
the run waits — however long the human takes. A decline stops the run **before
anything is applied** (`plan-rejected`); an approve is remembered for the rest
of the run. `PLAN`/`TODO` bodies update the todo card live (`todo`, merged per
item — one row per distinct text, a tick sticking); items tick in the ordinary
markdown shapes (`- [x] text`, `* [x] text`,
bare `[x] text`) — the bullet comes off before the checkbox is judged, or a
ticked line parses as open forever. Control markers never pass the permission
gate.

**8. After the calls.** A changed overlay emits `diff_update`. A budget spent
mid-step stops here — before the DONE handling, so a `DONE` riding the same
reply cannot mask why the run stopped; whatever was staged is still staged. A
DONE with reads still in flight is deferred (`ignore_done`) so the reads
execute and their results go out first. An ASK with reads in flight waits the
same way — the read's result goes out, and the question lands a step later.

**9. Stagnation guard.** A step signature (kind + arg + first 2000 chars of
each result) is kept for the last six steps:

- the same step the third time → `stagnation`, stop;
- two steps trading places (A, B, A, B, …) → the second occurrence →
  `stagnation`, stop;
- one strike short of either → a `stagnation` warning rides the next message
  ("do something different — or say DONE and tell me what is still open").

**10. Verify nudge (R4).** Once a run has staged code and nothing checked it
since the last change, the next message asks for proof — once. Running a check
or reading a staged file back in the same step counts as the proof;
`finishCheck` pre-empts the nudge when the checker can run. R4's "verified"
only silences the reminder — the exit check runs regardless.

**11. Compaction.** Checked against the assembled message the way the server
will receive it (after `outbound()` rewrites). Over budget: summarise in the
conversation that still holds the history → rotate → `compacted`; the seed
the loop sends next pins the staged files, the last failing check, and the
merged memory facts. If the compaction itself fails, the results still go
out (`error` emitted) — losing a step to a summariser fault would be worse.

**12. Loop end.** `step_limit` when a set cap's last step runs; a spent budget becomes
the stop reason; credits are diffed (`quota(true)`); `run_stats` and
`finished` go out — `finished.todo` carrying the run's final checklist state
(empty when no plan was written), so the window can re-tally the plan card and
say what a completed run left open; the loop returns.

## Guards at a glance

| guard | watches | first response | stop |
|---|---|---|---|
| nudge | a reply with no actionable marker | `nudge` + reminder (×2) | 3rd: checker's last chance, then `give_up` → `stalled` |
| repeat guard | identical call, 3rd time, nothing staged in between | refusal text as the result, `repeat_block` | > `repeatGuardMax` (4) refusals → `stalled` |
| err loop | the same failure (kind + masked error line) on calls in a row | correction on the third result, `errLoops` | streak > `repeatGuardMax` → `stalled` |
| chain guard | a failed change, mid-reply | the reply's later changes/RUNs skipped and stated, `chainSkips`; reads still run | — |
| red-test gate | a `git commit` RUN while the declared check (`.aipass/check.txt`, or `verifyCommand` when set) has not passed at the current state | refusal naming the exact command and its source, `commitBlocks`; any later change re-arms | — (run the check first; a commit is never the way around it) |
| stagnation | same step ×3, or two trading places ×2 | `stagnation` warn + "do something different" | `stagnation` |
| budgets | tool count (300) and wall clock (30 min) — the only bound when no step cap is set; plus credits, only when set (`maxCredits`, 0 = off, checked against the cached quota) | `budget` event | `tools-limited` / `time-limited` / `credit-limited` |
| plan gate | `PLAN` and no approval yet | `plan_request`, wait however long | decline → `plan-rejected` |
| plan checkpoint | DONE with plan/TODO items still open | one nudge naming them and asking for a ticked TODO (`todoPrompts`); the finish pipeline reads: checker → checkpoint → language | — (the next DONE is honored either way) |
| checker | DONE (or a stalled step) with staged code | read-only verifier runs it; a self-run does not stand it down; a re-check only when the tree moved; `verifyCommand` names the check | fail → a correcting step; pass → `done`; with `requireCheck`, a later DONE over the failing tree → `done-unverified`; two verdicts a run, the last recorded |
| verify nudge | staged code, nothing verified since the change | `verify_prompt` (once per run) | — |
| language check | closing message under `minThaiRatio` (0.4) Thai — a reply with calls is judged on its closing line alone | `lang_prompt`, one rewrite | — |
| compaction | assembled message over the context budget | summarise + rotate | — |

The mechanical guards (repeat, err loop, stagnation, budgets) stop a run that
cannot move; the chain guard narrows one step after a failed change; the
verify nudge and language check ask once and let the model finish. All of them
correct *evidence*, never intent: a call runs as written first — with two
deliberate exceptions, the red-test gate and the opt-in `requireCheck` gate,
which are hard bars and only exist where the run declared its check.

## Stop reasons

| stopReason | meaning |
|---|---|
| `done` | DONE accepted (possibly after the checker or a language rewrite) |
| `done-unverified` | `requireCheck` was on and a DONE arrived over a declared check that was still failing |
| `ask` | the model paused on a question (ASK) — the next message answers it |
| `steps` | a set step cap ran out (no cap is the default) |
| `stalled` | hollow replies ×3, repeat refusals past the cap, or a same-failure streak past it |
| `stagnation` | the same step, or two trading places, with identical results |
| `cancelled` | the user pressed stop |
| `error` | transport/model failure, a saved model that left the catalog (the pre-flight's sentence), or a missing tab (with `needs_tab`) |
| `plan-rejected` | the human declined the plan |
| `tools-limited` | the tool-call budget was spent |
| `time-limited` | the wall-clock budget was spent |
| `credit-limited` | the optional credit cap (`maxCredits`) was reached — observed spend against the cached quota |

## The contracts the loop holds

1. **One user message per request.** Every call's result is joined with blank
   lines and closed with `REMINDER`. Attachments ride the first send only
   (`first`), except `ATTACH`'s queued parts, which drain into the next
   message — re-sending an image every step would re-upload and re-bill it.
2. **`err:` is the only failure word.** The loop reads that one prefix instead
   of guessing failure phrases; every tool writes it or says nothing about
   failing.
3. **Writes stop at the overlay.** Tools never touch the disk;
   `applyOverlay(overlay, accepted)` is the only writer — driven by the
   window's Apply — and emits `applied`.
4. **WAF once, at assembly.** Tools return real text; `outbound()` is applied
   when the loop assembles the results, so bytes on disk are exactly the
   file's.
5. **The session records accepted sends.** Both sides of a message are
   appended only after the server accepted it; a retry never double-records.
6. **A stop is an ending.** An aborted send reports `cancelled`; the
   transcript shows what the person did, not a failure. And it ends the
   *work*: the tools still queued in the reply do not run, a command in
   flight is killed with its tree, and a run that had only just started
   carries the stop (its abort controller exists before the first `await`).
   The window says what the stop found — a stop that stopped nothing says
   so.
7. **Helpers are safe by construction.** A role-less helper's edits are
   proposals that wait for the parent's approval; a named role
   (`SUBAGENT_ROLES`: `verifier`, `reviewer`, `summariser`) is read-only, and
   only the verifier may RUN — its report is the deliverable.
8. **Helpers report; the parent decides.** Results come back in the order
   their markers ran, as ordinary tool results — no vote, no merge, no
   last-writer-wins. A role's verdict (`pass` / `fail` / `not-checkable`) is
   evidence the parent must read like any other result. When the run declares
   a check, that check's verdict is the one automatic verdict in play — and
   even it only reports; nothing is applied without the same human approval
   as any other edit. Two helpers that disagree leave both claims on the
   table, and the disagreement surfaces as prose to the model and as the
   diff list to the person — never as a tie broken by arrival order or size.
9. **Uncertainty escalates to a person, never sideways.** A model that is
   unsure asks (`ASK`) or says so in prose — the loop surfaces it and waits.
   Conflicting evidence (two helpers, a failed check, a staged change nobody
   approved) is *presented*, never resolved by the loop: the diff list, the
   check verdict and the notes are the escalation, and the only paths to a
   real write are human (Apply, `--apply`, a granted rule). A run that
   cannot say what it is unsure about stops through a guard (`stalled` /
   `stagnation` / `steps`) with the reason recorded.

## The event stream

Everything above the loop consumes events; nothing prints. Grouped by
consumer:

| group | events |
|---|---|
| lifecycle | `task_start`, `step`, `thinking`, `done_line`, `ask`, `ignore_done`, `give_up`, `step_limit`, `finished`, `run_stats` |
| model tokens | `assistant_delta`, `reasoning_delta` |
| tools | `tool`, `repeat_block`, `plugin_call`, `diff_update`, `applied` |
| gates & prompts | `plan_request` (facade), `permission_request` (permission engine), `nudge`, `stagnation`, `verify_prompt`, `lang_prompt`, `check_start`, `check_end` |
| context & transport | `compacted`, `note`, `budget`, `firewall_note`, `needs_tab`, `error` |
| helpers & panel | `subagent_start`, `subagent_end`, `todo` |

A `role:` line in a `SUBAGENT` body picks a named helper shape; without one
the helper keeps its original behaviour.

## Tests that pin this

| file | what it locks |
|---|---|
| `test/run-resilience.test.mjs` | a gap in the extension: retried where safe, not retried mid-stream |
| `test/run-overlay.test.mjs` | the staged tree projected into RUN; the disk untouched until Apply |
| `test/gates.test.mjs` · `test/permissions.test.mjs` | the decisions the gate consumes — yolo still asks about destructive RUNs |
| `test/checker.test.mjs` | verdicts pass/fail/none, the read-only child, the declared check, an always-run exit check bounded at two verdicts |
| `test/ask.test.mjs` | the ASK pause: closing line, no check, deferral beside a NEED |
| `test/lang-guard.test.mjs` | path variants (invisibles, Thai digits), the Thai reply policy, the repeat / err-loop / chain guards up to `stalled` |
| `test/harness-fixes.test.mjs` · `test/harness-research.test.mjs` | the stagnation guard's warn-then-stop |
| `test/compact.test.mjs` | rotation mid-run; the estimate's script-aware divisor |
| `test/protocol.test.mjs` | markers, fences, the preamble |
| `test/plan.test.mjs` | tick forms (`- [x]`, `* [x]`, bare `[x]`), the once-per-run DONE checkpoint, `mergeTodo`'s one-row-per-text dedupe, and `finished.todo` |
| `test/stats.test.mjs` | `run_stats` and its aggregation |
| `test/secret-screen.test.mjs` | the secret screen past the file tools — RUN bodies, GIT args, SEARCH walks |
| `test/desktop-window.test.mjs` · `test/ui.test.mjs` | the whole run through the backend — plan gate, permissions, todos — and the window's handlers |
