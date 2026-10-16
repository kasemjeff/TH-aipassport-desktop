# Harness & tool design

How the agent harness works, the contracts each piece keeps, and what I would
change next — findings first, then designs. It is a review of
`aipass-bridge/harness/` as it stands (v0.2), written to be handed to
whoever picks up the work. For the architecture around it, see
[`TECH_STACK.md`](TECH_STACK.md); for what the app does, the
[README](README.md).

## How one run works

```
run(task)
  │
  ├─ context check ────── over budget? summarise → rotate to a fresh
  │                        conversation, seed it with the summary
  ├─ ensure conversation  (create a temporary one unless told otherwise)
  │
  ▼  repeat, at most maxSteps times
  ┌──────────────────────────────────────────────────────────────────┐
  │ send ONE user message                                            │
  │   turn 1: preamble + listing + task                              │
  │   later:  every result of the previous reply, + REMINDER          │
  │ model answers: prose + markers (NEED, EDIT, PLAN, DONE, …)       │
  │ parse markers        ← the whole reply is scanned                │
  │ execute each, in order, behind the permission gate               │
  │   reads      → run now                                           │
  │   writes     → land in the overlay, never on disk                │
  │   PLAN       → maybe stop and wait for a human                   │
  │   SUBAGENT   → run a whole child loop on a second conversation   │
  │ paste every result back as the next ONE message                  │
  └──────────────────────────────────────────────────────────────────┘
  │
  ├─ DONE (or prose-only after work, or nudges ×3, or step limit)
  ▼
finished: summary, credits spent, pending changes → the window's Apply
```

The two facts that shaped all of it: the upstream accepts **one user message
per request** (an assistant turn in the array is a bare 403), and **the server
keeps the history**. So the preamble goes out once and becomes part of the
server's memory, every later turn is only the results, and "context is full"
can only be answered by rotating conversations, not trimming messages.

The step-by-step anatomy of that loop — every stage, guard, stop reason and
event — is in [`LOOP_DESIGN.md`](LOOP_DESIGN.md).

## The pieces and their contracts

| module | contract | the invariant it protects |
|---|---|---|
| `protocol.mjs` | the marker grammar and the preamble, and nothing else | markers are prose — no brackets, no JSON, no key=value; everything structural drew a 403 |
| `waf.mjs` | the one substitution table (`outbound`/`inbound`) + the risky-line drop list | every surface substitutes the same way; bytes on disk are exactly what the file had |
| `loop.mjs` | send → parse → execute → paste results | results go back as ONE message; writes stop at the overlay; a plan gates the work |
| `tools.mjs` | string in, string out, one function per marker | no tool ever writes to disk; a read cannot change anything |
| `overlay.mjs` | a pending-edit filesystem over `Map<abs, string \| DELETED>` | a run that dies halfway leaves the tree untouched; diffs exist before anything changes |
| `sandbox.mjs` | the overlay projected into a child-visible tree for one `RUN` | a child process sees the staged edit, and the disk is still never written by a run |
| `permissions.mjs` | classify → rules → mode → ask | path rules outrank the mode — reads included (H9); nobody listening to a question means deny, not hang |
| `compact.mjs` | estimate bytes/4 → summarise → rotate → re-seed | summarisation happens in the conversation that still holds the history |
| `harness.mjs` | the facade a CLI, the window and tests all drive | the one-conversation resource is managed nowhere else; helpers propose into the parent overlay |
| `session.mjs` | JSONL append with a forkable tree | a session opened next week reads as one continuous piece of work |
| `skills.mjs` | plain markdown, project → user → repo | the library grows without code changes |
| `plugins.mjs` | `setup(ctx)` in-process: markers, rpc, panels, settings | plugins are code you chose to install — not sandboxed, and it says so |

What is already right and should not be "improved" away: unique-match REPLACE
(refuses when FIND matches twice), binary detection by magic signature before
a run is wasted on mojibake, the listing that merges pending writes (issue
#32), `resilientSay` halving rejected messages, permissions defaulting to
deny when no one is listening, and helpers whose "yolo" is safe because every
write is only ever a proposal.

## Findings

Status after the third pass: **F1–F10 and the P2 designs are all implemented.**
On the way, three more latent bugs surfaced and were fixed with the findings
that exposed them:

- The permission timeout path called `resolveOnce`, a function that never
  existed — the "deny after 120s" behaviour had never actually worked (it
  crashed the timer instead). (F7)
- `GIT` validated only the *start* of its subcommand, so `GIT status; anything`
  rode through the allowlist as a second shell command. (F2)
- Attachments passed to a run were re-sent — re-uploaded, re-billed against
  the context — on *every* step, not only the first message they belonged to.
  (F6, which touches the send path)

What each pass changed, briefly:

- **Pass 1 (F1–F4):** fenced markers no longer execute; `git`/`run` async with
  shell punctuation refused; GLOB segment-wise; FETCH private-host guard and
  2 MB cap via the shared `bridge/private-hosts.mjs`.
- **Pass 2 (F5–F9):** every tool failure returns `err: …` and the loop reads
  that one word (F5); the compaction budget is re-checked against the message
  about to be sent and a long task rotates mid-run (F6); the estimate measures
  the *current* conversation, counts assistant replies, and drops its divisor
  to 3 or 2 as the text becomes Thai or another wide script, with a per-model
  budget map (F8); SEARCH/GLOB honour the root `.gitignore`, skip files over
  1 MB, and SEARCH takes `-i` (F9). `AIPASS_CONTEXT_TOKENS` /
  `AIPASS_KEEP_RECENT_BYTES` tune a terminal run without a settings object.
- **Pass 3 (P2):** `ATTACH` queues an image or document onto the next message,
  behind the `--attach` preamble flag (A); permission rules and "always"
  grants persist per project in `~/.aipass/rules.json` and survive a restart,
  with repeatable `--rule "pattern=decision"` on top (C); every run appends a
  `run_stats` line and `npm run stats` aggregates refusal rates, nudges,
  firewall notes, step timings and credits (D); the bridge accepts a
  `conversation` per request and `createConversation` can mint one without
  adopting it, so helpers keep their own conversation — no save/restore dance
  — and `--web-scratch` runs WEB lookups in a throwaway conversation (B).
  Helpers of one reply can run beside each other behind `--parallel-helpers`
  (the CLI flag) / `parallelHelpers` (the window, on by default since the live
  proof below: two helpers fanned out 3 ms apart into two temporary
  conversations, both generations accepted and answered concurrently).

### P0 — wrong behaviour today

**F1. Markers inside fenced code are executed.** `parse()` scans every line
with no awareness of ``` fences, so a reply that *quotes* the protocol —
documentation, an example, this repo's own README being read — has its
`NEED`/`CREATE`/`EDIT` lines run for real. A fenced `DONE` ends the run.
Fix is two lines in both `parse()` and `prose()`: toggle on a fence-open
line, skip until it closes. Fenced content stays visible as prose.

**F2. `GIT` (and `RUN`) block the whole backend.** Both use `execSync`, which
freezes the Node event loop — in the desktop backend that is the same process
serving `/rpc` and `/events`, so every `git status` on a slow repo stops the
UI's heart for up to 15s (120s for RUN in yolo). `GIT` is classified read and
allowed by default, so this happens in the default mode. The loop already awaits
tools (`fetch` and `web` are async), so the fix is mechanical: promisified
`exec` with the same timeouts.

**F3. `GLOB` ignores everything before `**`.** When the pattern contains
`**`, only the *last* segment is matched against the file name —
`src/**/*.ts` returns every `.ts` in the project, not under `src/`. The model
trusts it and edits the wrong tree. Replace the two branches with one
segment-wise matcher where `**` consumes one or more directories.

**F4. `FETCH` will go anywhere and read everything.** The URL is `inbound()`-ed
(restoring `LOOPBACK-IP` and friends) and fetched with no host check — so
`FETCH HTTP-URL127.0.0.1:8787/...` can talk to the bridge itself, and any
loopback or LAN service besides. `res.text()` is also unbounded. Guard: deny
loopback/private/metadata hosts unless a rule or env says otherwise, and cap
the body at ~2 MB by reading the stream incrementally.

### P1 — protocol and context

**F5. Refusal detection is regex folklore.** The loop decides a tool call
failed by matching `/^(no such|error|the text|that text)/` and
`"is a …, not text."` against the result. Every tool that learns a new failure
phrase quietly misses. Give every tool result a one-word status prefix —
`err: …` / plain text otherwise. It is harness-generated text, so the model's
side of the protocol does not move and the preamble stays byte-identical.

**F6. Compaction is only checked between runs.** A long task inside one
conversation grows past the budget mid-run; the check happens before the
first message only. Re-check when assembling the results message, and rotate
there (summarise → rotate → send summary + current results) if over.

**F7. The desktop inherits the CLI's 120s permission timeout.** Unanswered
permission questions resolve to `deny`. Right for a terminal you are watching;
wrong for a window whose human is reading a diff. `PermissionEngine` already
takes `timeoutMs` — the desktop should pass `0` (wait), the CLI keeps 120s.

**F8. The context budget is one number for every model and every language.**
`contextTokens: 24_000` regardless of model, `bytes/4` regardless of script —
Thai runs ~2× the tokens per byte of English, so compaction fires late
exactly for the users this project is for. Make the budget a per-model map
(the bridge knows the model) with conservative defaults, and either use
`bytes/3` when the session text is mostly non-Latin or just lower the
default. Note `WEB` results are pasted into the server conversation but never
counted by `estimate()` — count them too.

**F9. `SEARCH`/`GLOB` walk everything not in a five-entry hardcode.** No
`.gitignore`, no file-size cap (`target/`, `vendor/`, `coverage/`, 500 MB
logs — all read line by line, synchronously). Read `.gitignore` when present,
extend `SKIP` with the usual suspects, skip files over ~1 MB, and offer
`SEARCH -i`. While there: `WRITE_KINDS`/`WRITERS` are two parallel
vocabularies for the same idea — keep one.

**F10. The preamble promises parallel helpers that do not exist.**
"keep going yourself while it runs" — but `SUBAGENT` awaits the child loop;
the parent waits. The model plans around a fiction. Either fix the sentence
(the honest version: "it runs to completion and reports back one summary") or
build the real thing (P2-B).

### P2 — designs worth having

**A. `ATTACH` — hand the model an image or a document.** The chat already
supports attachments (`parts` on the bridge; the window does it today), but
the agent cannot. Marker, mirroring the existing opt-in pattern:

```
ATTACH desktop/shot.png          ← queued, no body
```

Tool queues a part (exists-check, size cap, not under `SKIP`), the loop
attaches queued parts to the next message it sends and clears the queue.
Classify as read — note this changes nothing about the privacy story: every
`NEED file` already pastes file contents upstream; `ATTACH` only closes the
gap for binary files, which `read` refuses. Gate the preamble line behind an
option so the CLI's turn-1 bytes stay identical.

**B. A conversation pool — helpers that actually run beside the parent.**
The bridge routes every chat to its one current conversation, so nothing can
overlap. Sketch: `/v1/chat/completions` accepts a `conversation` field; the
extension maps conversation → tab and spawns tabs up to a small N (same
Chrome profile, so login state is shared); each tab serialises its own
generations; the harness gives each helper a conversation id and drops the
save/restore dance. Payoff beyond helpers: `WEB` runs on a scratch
conversation instead of spending the working one's context. Cost: extension
rework and tab lifecycle management. Do it only when helpers or `WEB` show up
as the bottleneck in real runs.

**C. Persist "always" grants and project rules.** Grants live in a Map that
dies with the process; rules come from flags only. Persist both per project
(`~/.aipass/rules.json`, same shape the UI already edits) so "always allow
writes under src/" survives a restart. The engine does not change — only
where `rules` and `grants` are seeded from.

**D. Run metrics, already half-collected.** The session records every tool
call with an `ok` flag, and runs record credits spent. Aggregate per run —
refusal rate, nudges, 403 splits, per-tool latency — into one `run_stats`
line and a `npm run stats` reader. This is how F10-style protocol drift gets
caught instead of guessed at.

## The tool layer, going forward

The contract every tool keeps — new tools included:

1. **String in, string out.** No JSON, no objects; the model writes prose and
   reads prose.
2. **Status prefix.** `err: …` on failure, bare text on success (F5). The
   loop never regex-guesses again.
3. **Clip at `maxResult`.** Long output ends with `… truncated` and a hint
   for paging (`read` already does this perfectly with its range hint).
4. **WAF at the edge, once.** Tools return real text; `outbound` is applied
   by the loop when results are assembled — never inside a tool.
5. **Writes stop at the overlay.** A tool that changes the tree calls
   `overlay.set`/`markDeleted`, never `fs.write*`.
6. **Classify honestly.** `write`/`shell` risk means the permission gate can
   hold it; `read` means it cannot change anything — which is why `FETCH`
   must actually be true to that claim (F4).

| tool | class | notes |
|---|---|---|
| `list`, `read`, `search`, `glob`, `git`, `skill` | read | local; async where it shells out, gitignore- and size-aware where it walks |
| `fetch`, `web` | read, network | fetch guards private hosts and caps the body; `web` spends the conversation's context and appears in the account's chat history |
| `write`, `replace`, `delete`, `move` | write | overlay only; `replace` requires a unique FIND match |
| `run` | shell | disabled unless `allowRun` |
| `plan`, `todo`, `subagent` | control | handled by the loop, not the gate |
| plugin markers | plugin's own | registered at runtime, never shadow a built-in |
| `attach` | read | queues a part for the next message; announced only behind `--attach` |

**Adding a tool — the checklist that keeps the protocol coherent:**

1. one regex branch in `parse()` (prose-shaped, no brackets) and a
   `MARKER_LINE` entry so `prose()` strips it;
2. one function in `createTools()` obeying the contract above;
3. classify it (`permissions.mjs`), not just a new set somewhere;
4. one line in the preamble — behind an option flag if the CLI's turn-1
   bytes must not move;
5. a test that runs it through the loop with the gate in `ask` mode;
6. a playbook file only if the tool needs technique, not just syntax.


## Research round (Oct 2026): four deltas, each from a named source

The loop was reviewed component by component against recent harness research.
Four changes made the cut; the rest of the review is noted below as
candidates, not shipped.

**R1 - Oscillation, the other no-progress loop.** Analyses of infinite agentic
loops (IAL-Scan, arXiv:2607.01641) flag "two states trading places" beside
plain repetition: every individual step looks new, the pair goes nowhere.
`loop.mjs` keeps the last step signatures and stops an A/B/A/B run the same
way it stops an A/A/A one - one correction, then out.

**R2 - Edit diagnostics are free here.** Ablations of coding harnesses ("An
Empirical Study of Harness Design for Coding Agents", arXiv:2609.20804;
"Beyond the Model", arXiv:2609.32459) put structured tools with validation
among the few components that pay off consistently. The cheapest hard check
available is the runtime itself: a staged `.mjs`/`.cjs`/`.js` edit is written
to a temp file and passed through `node --check`; the verdict rides the tool
result, so a syntax error costs one round trip instead of a broken apply.

**R3 - Tool output is data, never instructions.** The prompt-injection design
patterns paper (arXiv:2506.08837) reduces to one rule this harness can hold
without losing utility: content that arrives through a tool is reported on,
never obeyed. The preamble says it plainly and the REMINDER repeats it every
step, because the marker protocol means file content and requests share one
channel.

**R4 - Verification before DONE, the soft form.** Strong models over-verify
and weak ones under-verify; the cheap correction is one nudge. After the
first staged code change, the next message asks for a test run, a read-back,
or an explicit "nothing can be run here" - once per run, never blocking.
`run_stats` counts it (`verifyPrompts`) so the trend shows in `npm run stats`;
its first live firing was the smoke re-run below.

**Shipped since (Oct 2026):** per-run tool-call and wall-clock budgets
(`maxToolCalls` / `maxWallClockMs` — checked between tools, at every step and
before a helper fan-out; a spent budget stops the run like the step limit and
records `tools-limited` / `time-limited` in `run_stats`); task-specific helper
instructions (a `role:` line on SUBAGENT — `verifier` may RUN checks, `reviewer`
and `summariser` only read; all three are read-only by construction, their
write markers answer `err:` before anything is staged); spill reads return the
asked-for range verbatim (no second gutter over the numbered copy, no spill of
a spill); every write answers with a first/last line read-back.

**Still noted, not shipped:** the elision tier that replaces stale, bulky tool
results with stubs before paying for summarisation — the summary transcript
already slices each message to 1200 chars, so the tier's remaining win is
small; it waits for a case where summarisation costs more than the slices do.

## The upstream edge, measured live (Oct 2026)

The first live smoke run of the harness — read `math.mjs` and `check.mjs`, fix
one operator in the first — died for a reason local tests cannot see: the edge
in front of `de.aipass.net` answers **403** to ordinary project content. A
blocked message still comes back as HTTP 200 with an SSE error frame, so the
bridge's retry chain (redact → split in half → omit the offending section)
quietly degraded until the model had never seen `check.mjs` and finished the
run asking for its contents. Measured back to back, each probe its own
temporary conversation:

- **Logging calls are refused whole.** `console.log(` and its five siblings —
  `warn`, `error`, `info`, `debug`, `trace` — plus `stdout.write(` /
  `stderr.write(` on any receiver (Python's `sys.stdout.write` too).
  `console.log('PASS');` alone — twenty bytes — draws the same 403 through any
  number of splits, while `console.bar(`, `console.assert/dir/table/…`,
  `isolate.log(` and `process.exit(` pass untouched: it is the call, not the
  shape of the line.
- **Equality comparisons are refused inside an `if`.** `if (x == 5)`,
  `if (x === 5)` and `if (x !== 5)` all draw a 403; `!=`, `<`, `>`, `<=`, `>=`
  pass, and the same comparisons outside an `if` (`while (…)`,
  `const ok = a == b;`) pass. The match is literal enough that a placeholder
  which itself spelled `NEQ` was refused inside the parens — hence the table's
  `OP-EQ`, `OP-STRICT-EQ`, `OP-NOT-EQ`, which avoid both `==` and `NEQ`.

Both families now sit in `waf.mjs` beside the URL and shell patterns, with a
round-trip test and a scripted integration test showing that a message
carrying `console.log` and `if … !== …` is sent encoded and lands on disk
byte-exact. The retry chain stays as the safety net for what the table does
not know yet.

Two operational notes from the same session, both now closed. Probes are not
side-effect free: after a burst of roughly a hundred automated messages the
edge escalated to a session-level block that refused everything, `hello there`
included — a rate/bot score, not a content rule; the tell is that even a plain
greeting is refused. The block is time-boxed rather than sticky: the last
blocked probe drew a 403 at 20:26, and the same probe passed in full about
twenty minutes later. Its smaller sibling is quicker to draw: a three-probe
check followed immediately by one live run — ten messages in four minutes —
collected a **429 Too Many Requests** mid-run. The suspected third rule is
closed too: a bare relative path (`./math.mjs`) was never a rule, it only
403'd while the block was up. With the edge quiet, `h1` carrying
`import … from './math.mjs';` was accepted, and every read result in the
re-run below carried `./` unencoded with zero rejects, so it stays as it is.

## The re-run that passed, and the gap it stepped on (Oct 2026)

The smoke task ran once more after the block lifted — same task, same project,
the whole loop live — and the fix proved out end to end. Both reads were
accepted with no retry chain and no omitted fragment; the operator landed as a
one-line diff and was written at the end; the applied tree makes
`node check.mjs` exit 0 printing `PASS`. The session counters say it in
numbers: `firewallNotes 0` (the first run's four rejects are gone — encoded
content sails through), `verifyPrompts 1` — the R4 nudge fired for real, note
entry "verify nudge: math.mjs staged and nothing has checked it yet" — and
`stagnations 0`. What ended the run was volume, not content: the 429 above
arrived mid-run, so `stopReason: error`, and the CLI still wrote the staged
diff — which is the behaviour it was built to have.

**The gap it stepped on: a run cannot see its own staged edits.** `RUN`
executes against the tree on disk, and the overlay is invisible to a child
process by design — so when the model staged its one-line fix and ran
`node check.mjs` to verify it, it read the *old* file's `FAIL`, concluded the
save had failed, and spent the rest of the run re-reading and re-editing until
the 429 closed the door. The smoke's own task — "fix it, then run the check" —
cannot complete mid-run under these semantics, and a model that trusts its
tools over its doubts will keep tripping on it. The options, none free:
materialize staged files for the length of a `RUN` (a child-visible temp
copy); say it in the protocol (a run sees disk until the end); or write
straight to disk in `auto`/`yolo`, where the person already said yes.
Deciding this is queued, not guessed.

**Decided and shipped (2026-10-15): the projection.** The first option was the
only one that keeps every invariant — the protocol cannot say "a run sees
disk" without making the Verify stage structurally impossible, and writing
straight to disk in `auto`/`yolo` would trade away diff-before-apply, the
crash-safety of a dead run, and helpers' proposals. `sandbox.mjs` now projects
the tree into `.aipass/run/run-*` with the staged edits written in: source
files copied (a copy means an in-place write cannot touch the real file),
heavy directories — `node_modules`, `.git`, build outputs — junctioned so a
check does not pay to copy them, staged deletes left out. The command runs
there, its stdout/stderr have the sandbox path swapped back to the project
root (which also keeps identical commands byte-identical across steps, so the
stagnation guard still recognizes a repeat), and the copy is deleted in a
`finally`. A run with nothing staged skips the projection entirely and
behaves exactly as before. What the model sees is now the truth it always
assumed: stage a fix, run `node check.mjs`, get `PASS`.

Proven live the same day, on a broken `total.mjs` with `check.mjs` printing
FAIL: the model staged the one-word fix and ran the check in the same step —
`run {n:1, fail:0}`, output `PASS`, and since the run counted as the in-step
check, `verifyPrompts 0`. Three sends, `stagnations 0`, and the applied tree
passes on the real disk. The shape of the original smoke now completes in one
step.

## Research round 2 (Oct 2026): the five-stage spine

A second research digest — Self-Harness, Meta-Harness, HarnessBridge,
Harness-Bench, the Claw-SWE-Bench adapter ablation and the AI2/UW
test-time-scaling result — arrived as a proposed spine, and it is adopted:

```
[Bootstrap] → [Loop: observe → decide → act] → [Verify] → [Stop/Recover]
                     ↑ obs compressor   ↓ action validator
          [Budget + Trace]       [Test-time scaling when a verifier exists]
          [Offline tuning (outer loop) with a regression gate]
```

Block by block, against the code as it stands:

- **Bootstrap — done.** Turn 1 carries the preamble, the tool protocol and the
  listing; every later turn opens with "the project is still open in front of
  me" plus the listing again (`loop.mjs`, the `again` message). The digest's
  "2–4 turns spent rediscovering the tree" is what these two messages buy back.
- **Loop — done.** One user message per turn; the whole reply is parsed; every
  marker runs in order and all results return as ONE message.
- **Observation compressor — done, two tiers.** A single tool result is clipped
  at `maxResult` with a paging hint (`read` paginates properly); the
  conversation itself is summarised and rotated at the budget line
  (`compact.mjs`). The elision tier stays on the noted-not-shipped list.
- **Action validator — done.** Fenced protocol text never executes (F1); a
  malformed marker comes back as `err: …` pointing at the fix (F5); a staged
  `.mjs`/`.cjs`/`.js` edit passes `node --check` (R2); REPLACE refuses an
  ambiguous FIND; every write passes the permission engine and everything
  outbound passes the WAF table. Harness-Bench's "format violations are the
  most common failure class" is the failure this layer turns into a
  one-round-trip correction.
- **Verify — done, soft form (R4).** One nudge after the first staged code
  change. The digest's stronger reading — *done means a runnable check passed*
  — was blocked by the RUN-vs-overlay gap; that gap is closed by the
  projection (above), so a verification run now reads the staged tree and
  this stage can be hardened next. `verifyPrompts` already tracks how often
  the nudge fires.
- **Stop/Recover — done, five exits.** Stagnation (repeat ×3 or oscillation ×2,
  after one correction), no-marker nudge ×3 → give up, `ignore_done`, the step
  limit, and `resilientSay`'s redact → split → omit chain.
- **Budget + Trace — done.** Every run appends one `run_stats` line (stop
  reason, per-tool counts, nudges, stagnations, verify prompts, firewall notes,
  step timings, credits spent) and the session keeps every tool call. "Tokens
  per solved task" cannot be reported literally — the upstream exposes no token
  counts — so credits spent is the observable denominator.
- **Test-time scaling — not shipped.** The pieces exist (`SUBAGENT`; the
  conversation pool behind `--parallel-helpers`, live-proven 2026-10-16 — two
  helpers fanned out 3 ms apart, two borrowed temporary conversations both
  answered concurrently — and on by default in the window), but nothing runs a
  task N ways and keeps the attempt that passes. It shares Verify's
  prerequisite.
- **Offline tuning — manual.** The outer loop already is the working style:
  run_stats and session logs → findings with a reproduction → patch → the suite
  as the regression gate → a live smoke against the real edge (the suite fakes
  the extension; the smoke cannot be faked). Meta-Harness's own held-out caveat
  is why an automated evals harness is queued, not assumed.

## The hook points, mapped onto the spine (Oct 2026)

A review brought the Claude-Code-style hook vocabulary to this design: six
places a harness can intervene, each checked against the code as it stands.
Four are already the behaviour of a named module, one is deliberately soft, and
one is the safety set the engine supports but does not yet ship as defaults.
The map, then what each gap is worth:

| hook | spine stage | mechanism today | status |
|---|---|---|---|
| SessionStart — inject a snapshot | Bootstrap | preamble + top-level listing on turn 1, the same listing after every rotation (`loop.mjs` the `again` message, `compact.mjs` re-seed) | partial — the listing is the only snapshot; everything else costs a NEED |
| PreToolUse — validate the shape, deny with a reason | Action validator | per-tool checks returning `err: …` and the fix (F5); fenced protocol text never executes (F1); `node --check` on staged JS (R2); permission denials carry the rule name | done per tool — no single pre-dispatch layer, and plugin markers skip the gate entirely |
| PostToolUse — compact an oversized result | Observation compressor | clip at `maxResult` + spill file with a `NEED` locator (`tools.mjs`) — reads keep the head, `RUN` keeps head+tail (ACI round); conversation summarise→rotate at the budget (`compact.mjs`) | done, three tiers; the elided middle of a command sits on disk, not lost |
| Stop — tests fail, keep working | Verify | R4's one soft nudge (`verifyPrompts`); the checker at DONE — a read-only child runs the project's own check, the verdict computed from what it ran, one continuation on fail (`loop.mjs`, `harness.mjs#makeChecker`) | done v1 — the verdict is advisory: a second DONE is accepted with `checks`/`checkVerdict` recorded |
| PreToolUse — count calls, log every event | Budget + trace | one `run_stats` line per run + one session JSONL entry per tool call, 20 000-char result and all | done; per-tool latency and a hard per-run cap are still not recorded |
| PreToolUse — destructive commands, config files, red-test commits | Safety gates | modes + the H9 rule engine: path rules outrank the mode, reads included; no listener means deny; `classifyRun` asks about hazardous `RUN` bodies in every mode, ahead of grants; `SAFETY_RULES` ask about config/lockfile mutations (`permissions.mjs`, `settings.mjs`) | done v1 — a red-test commit gate still needs a declared check command (`verifyCommand`) |

Worth closing, in roughly the order the table reads:

1. **A verdict behind DONE — shipped 2026-10-15** as the checker
   ([`SPEC_CHECKER.md`](SPEC_CHECKER.md), tests `checker.test.mjs`). The
   remaining edge of it: a declared check command (`verifyCommand`) would make
   verdicts comparable across runs, and it is also what a red-test commit gate
   needs.
2. **The safety set — shipped 2026-10-15** (`gates.test.mjs`). The floor is
   `SAFETY_RULES` in `settings.mjs`: mutating `package.json`, `tsconfig*.json`,
   `.*rc*` or a lockfile asks even in yolo, while reads stay ordinary; it is
   deliberately not merged into the user's editable `rules` list (a save would
   duplicate it into the file), and an explicit user rule still wins. The
   command-risk classifier (`permissions.mjs#classifyRun`) escalates
   destructive bodies — `rm -rf`, `sudo`, `del /s`, `curl | sh`, git-writes —
   to a question in every mode, ahead of grants, because `RUN` carries
   `arg: ''` and one "always" would otherwise blanket every future command.
   (The rows a reader sees label a run by its command: `loop.mjs` builds that
   label for display only — the engine still sees `arg: ''`, so grants and the
   classifier behave the same before and after the label existed.)
   The list is deliberately shallow (first word plus a substring net): a false
   positive costs one question, a false negative costs the repository. A
   checker child has no one to ask, so a shell-risk command there resolves to
   an immediate deny, never a hang.
3. **Two bugs the review turned up — fixed 2026-10-15** (`gates.test.mjs`).
   Plugin subscriptions: `PluginManager` now gets a real `Emitter` bus in
   `rpc.mjs`, harness events route onto it tagged with their project, and a
   plugin's own `emit` still reaches the window. The `.git` junction: the
   review's framing was wrong — dropping the junction is *not* enough, because
   git discovers repositories by walking up and the sandbox lives under the
   project root (verified: with no `.git` in the projection, git climbs to the
   real one). The shipped fix is exclusion plus a boundary sentinel: when a
   repository is reachable above the run, `sandbox.mjs` writes a `.git` file
   with an unresolvable `gitdir:` — the one shape that halts the climb, since
   an empty `.git` directory does not. A repo-less project keeps today's
   sandbox, `git init` included.
4. **Bootstrap snapshot** — git presence, `git status --short` and the package
   scripts quoted into turn 1, behind a `--snapshot` flag so the CLI's tuned
   bytes stay identical. Nice to have; the listing plus NEED covers the basics.
5. **Per-tool latency** — the loop already walks per call; one `ms` field in
   `toolStats` and its line in `stats.mjs`.

On the architecture question the vocabulary invites: keep the gate-class checks
core. Their invariant — "a run cannot be unsafe because a plugin is absent" —
is why they sit in the loop and the permission engine; a hook system that can
fail open would move the wrong thing. The observable event surface, though, is
already rich (every harness event reaches the window over SSE), so the cheap
win is making that surface subscribable in-process for plugins too — after
which "hooks" are just events with better names.

The queue, in dependency order:

1. **RUN-vs-overlay — done 2026-10-15** as the projection (`sandbox.mjs`,
   tests in `run-overlay.test.mjs`).
2. **A verification `SUBAGENT` — done 2026-10-15** as the checker: a child
   that reads the staged tree (projection included), may not write, and
   reports a computed `pass`/`fail`/`none`; one continuation on fail. Spec:
   [`SPEC_CHECKER.md`](SPEC_CHECKER.md); tests in `checker.test.mjs`.
3. **An evals harness** with held-out tasks and budget-matched baselines, so
   "the harness improved" stops being an argument from memory. Spec:
   [`SPEC_EVALS.md`](SPEC_EVALS.md) — check-command scoring, live + replay
   modes, runner self-tests. **Done 2026-10-15**: runner `scripts/evals.mjs`
   (`npm run evals`), fixtures under `evals/` (two smoke tasks, one holdout,
   one recorded replay), six self-tests in `evals.test.mjs`; a live run needs
   an explicit `--live` and budgets on the free-credit `gemini-3.1-flash-lite`
   unless `--budget model=…` says otherwise.
4. **The hook-review leftovers — the safety set and both bugs done
   2026-10-15** (`gates.test.mjs`). What remains is the red-test commit gate,
   which falls out of (2): it needs the declared check command
   (`verifyCommand`) the checker section names.

## The tool ACI round (Oct 2026): the contracts, tightened

The tool layer — not the loop — audited against the tool-writing literature:

- **Anthropic, "Writing effective tools for agents" (Sep 2025)**: results
  should be token-efficient and steer the model; a search should answer with
  the relevant lines *and their surroundings*; errors should point at the fix.
- **"Lost in the middle" (Liu et al., TACL 2024)**: attention favors the
  beginning and the end; a head-only truncation throws away the half models
  actually read.
- **The verified-tool-calls line (2025)**: validate at the boundary, and make
  a failed precondition loud rather than half-applying the operation.

Five changes, each with a test in `tools-aci.test.mjs`:

1. **`RUN` keeps head and tail.** `clipRun` splits the inline budget (about a
   third head, two thirds tail) and the locator names the elided middle by
   line range. A failing command's diagnosis lives in its last lines; the old
   head-only clip spilled exactly the part a model needs most.
2. **`SEARCH` returns context.** One line each side of a hit — match lines
   keep `path:N: text`, context lines trade the colon for a dash,
   ripgrep-style. Adjacent hits share a window instead of repeating it, and a
   line first shown as context upgrades to a match when it is one.
3. **`GLOB` goes through the cap.** The path list was the one result that
   skipped `clip`; a deep tree could ride the message whole.
4. **An empty `RUN` is refused with the shape to copy**, instead of running
   nothing and letting an empty success read as done.
5. **`MOVE` refuses a taken target** (`DELETE` it first, or rename) — landing
   on an existing file was the one write that could destroy bytes while
   reporting success.

Not taken, and why: task-shaped tool mergers (the tool count here is small and
each name is a distinct verb), and per-tool pagination defaults (the spill
locator already pages). Both stay candidates if the evals ever show tool
friction.

## The live stall of Oct 2026: a bare `NEED`, and a model that moved

A live desktop run died at step zero, twice, and the session log told the
whole story: the catalog's `claude-sonnet-5@default` no longer exists upstream
(the list now carries `claude-sonnet-5@azure`), so the site switched the
conversation mid-reply to `gemini-3.5-flash-lite` with a `data-model_switched`
frame, and the substitute model wrote `NEED desktop/`, `NEED CLAUDE.md` — the
marker without the keyword — three times. `parse()` recognized none of them,
the no-marker nudge fired three times, `stopReason: stalled`, `steps: 0`. Two
fixes shipped:

1. **A bare `NEED <path>` is the file form.** The parser takes it (single
   token plus an optional page range, so English prose that starts with
   "NEED" stays prose), `read` answers a directory with its listing instead of
   an EISDIR error, and the no-marker nudge spells the shapes out with
   bracket-free examples — `NEED file notes.md` reads that file, `NEED dir
   src` lists that folder, `SEARCH someText` finds it — instead of the old
   ambiguous `(NEED file path, …)`. (Angle brackets would themselves be WAF
   wire spellings in transit; the examples avoid them, as the preamble
   always has.) The window's `markers.js` mirrors the new branch, parity
   corpus included. The preamble still teaches the canonical forms; the
   parser merely stops punishing the shape a weak model reaches for.
2. **The desktop launcher adopts, never fights.** `main.mjs` probes the port
   before starting: a backend that already answers is adopted (open the
   window and step aside; `--detach` prints and exits), and a busy port that
   is *not* a backend now names itself instead of dying with a raw EADDRINUSE
   stack — that crash was the "the app does not open" report. Static UI files
   carry `cache-control: no-cache` now, so a reload always shows the current
   edit.

3. **The session sidebar is scoped to its project.** `session.list` (and
   `projects.switch`) pass the current root through to the store — unscoped,
   the picker mixed every project the store had ever seen, and on this
   machine that was 6,900-odd leftover directories from tests that ran
   against the real `~/.aipass`. The test harness now defaults `AIPASS_HOME`
   to a temp directory whenever a test did not name one, so a spawned CLI
   stops writing its sessions into the developer's real home. The leftovers
   were removed the same day; the sidebar went from a stalled 7,270-entry
   read to one project's five conversations.

**Queued, not guessed:** the extension reports `data-model_switched` as an
unhandled-frame note that dies in the assistant's reasoning; it should
surface as a visible transcript line, and `settings.defaultModel` that has
vanished from the catalog should fail the run with that sentence instead of
swapping models silently. (The user's own setting was reset to `auto` the
same day — the site's own default, free, and always in the catalog.)

## The four-minute blip (Oct 2026): a run must not die of a reconnect

The extension holds its SSE connection to the bridge for four minutes at a
time, then cycles it — deliberately, because Chrome does not promise a longer
one (`extension/background.js`, `CYCLE_MS`). The reconnect takes about three
seconds, and in those three seconds the bridge has no tab to dispatch to, so a
send that lands in the gap is refused instantly with `no extension connected`.
Recorded on this machine: the user's runs of Oct 16, 10:57 local, died with
`stopReason: "error"` mid-task, and the backend log shows the fatal dispatch
sitting between `extension disconnected` and `extension connected` — a run
lost to a three-second blip. Fixes:

1. **`BridgeClient` retries the refusal.** `chat()` and `createConversation()`
   make six attempts a second apart while the failure is exactly the dispatch
   refusal and nothing has streamed back yet — after the first delta a resend
   would deliver the text twice, so that case still surfaces. The CLI one-shot
   already waited this gap out (chat.mjs's own grace period); this gives every
   caller, the desktop included, the same endurance. `fetch failed` is
   deliberately not retried: the bridge process itself being down is not a
   gap, and a run must fail on the way in, not spend five seconds pretending
   it might start.
2. **The gap refusal feeds the same `needs_tab` flow.** The loop recognized
   only the tab's own wording ("no de.aipass.net tab is open"); the dispatch
   refusal ("no extension connected — open a de.aipass.net tab") now matches
   too, so a tab that does not come back within the retry window gets the
   one-click offer instead of a bare error.
3. **A stop is not an error.** The window's stop button aborts the send, and
   the loop used to label that run `error` — a system failure for something
   the user did on purpose. It now ends as `cancelled`.

Pinned by `test/run-resilience.test.mjs` (the gap is retried; a mid-stream
refusal is not; a create survives the same gap).

**Plugins, same day:** a plugin filtered out by `settings.plugins` had still
run its `setup()`, so its tools, RPC methods and panels stayed live while
every listing said it was off. The filter is now read before setup runs, and
`test/plugins.test.mjs` pins both directions — only the named plugins load,
and a reload honours a changed list.

## The Thai pack (Oct 2026): language policy, guards, and the stop hook

The round that made Thai a first-class working language without letting it
leak into anything a machine parses. The pure helpers live in `lang.mjs` and
are pinned by `test/lang.test.mjs`; the loop wiring is pinned by
`test/lang-guard.test.mjs`; the checker additions by `test/checker.test.mjs`.

1. **Language policy, spelled out in the preamble.** `replyLanguage` (default
   `th`) selects the sentence the preamble ships: talk to me in Thai (or
   English), while code, commands, file paths and marker arguments stay
   English. The same paragraph carries the no-pivot rule — Thai content is
   read and worked on as written, never translated first. The CLI's chat
   preamble (`chat.mjs`) carries the same sentence, fixed to Thai.
2. **The reply-language stop hook.** `langCheck` (default on) measures the
   closing message's share of Thai letters — code fences, URLs and commands
   excluded (`thaiRatio`) — and asks for one Thai rewrite when the share
   misses `minThaiRatio` (default 0.25; closings under 12 letters are never
   measured). One rewrite per run; `run_stats.langPrompts` and the
   `lang_prompt` event record it.
3. **The repeat guard.** An identical call (kind + argument + body) made a
   third time with nothing staged in between is refused with an `err:` that
   says why and what to change first; `run_stats.repeatBlocks` counts it.
   More refusals than `repeatGuardMax` (default 4) and the run stops as
   `stalled`. `plan`/`todo`/`subagent`/`done` are exempt — repeating a plan
   question is not a loop.
4. **The argument guard** (`argguard.mjs`). A path call refused for a missing
   file gets one retry with invisible characters stripped and Thai digits
   swapped for Arabics; the retry's result says the normalization happened,
   because the fix belongs in the model's copy step. A `run`/`git` value
   carrying a 24xx–25xx year gets an advisory CE note; file content is never
   rewritten, and a file legitimately named with Thai digits resolves on the
   first try. `tools.replace` retries a FIND block with invisibles stripped
   the same way, only when the exact block matched nothing.
5. **The checker at the stalled exit, and the test-file note.** A run that
   exhausts its no-marker nudges gets `finishCheck()` once before `stalled`:
   a fail becomes the step it deserved, a pass ends the run as `done`
   ("check passed after a stalled step"). The checker's prompt and verdict
   now name staged test files (`testsTouched`), so a passing check that also
   edited its tests is not read as proof of the code.
6. **Attempts.** `settings.attempts` (1..5) lets `rpc.run` re-run a task while
   the checker verdict stays `fail`; the response carries `attempts` and
   `check`. Each attempt starts from a cleared overlay, in the same
   conversation, so the model sees its own failure.
7. **Counters, the summary, and compaction.** `run_stats` gained
   `repeatBlocks`, `langPrompts`, `novelResults` and `repeatedResults` (a
   result already seen this run is what a loop smells like); `stats.mjs`
   rolls them up, and the compaction prompt now demands that proper nouns,
   names, numbers, dates, filenames and quoted strings stay byte-identical —
   Thai stays Thai.
