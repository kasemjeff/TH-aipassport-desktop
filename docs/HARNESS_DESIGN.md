# Harness & tool design

How the agent harness works, the contracts each piece keeps, and the state of
every finding. It is a review of `aipass-bridge/harness/` as it stands (v0.2),
written to be handed to whoever picks up the work. For the architecture around
it, see [`TECH_STACK.md`](TECH_STACK.md); for what the app does, the
[README](../README.md).

**How this document is read.** The first half is the current design: what one
run does, what each piece promises, which guard fires when, and what every
finding (F1–F10, P2-A…P2-D) turned into. It stands on its own — a reader who
wants to know what the system does today stops at the end of it. The second
half is **Appendix A**, the research and post-mortem log: the research rounds,
the live incidents and the bug histories behind that shape, in the order they
happened, each opening with the state it left behind. Nothing in the appendix
is a plan; every "queued" in it was either shipped or dropped, and the entry
says which. The per-change log is [`../CHANGELOG.md`](../CHANGELOG.md); the
session log is [`WORKLOG.md`](WORKLOG.md).

## How one run works

```
run(task)
  │
  ├─ context check ────── over budget? summarise → rotate to a fresh
  │                        conversation, seed it with the summary
  ├─ ensure conversation  (create a temporary one unless told otherwise)
  │
  ▼  repeat, at most maxSteps (no cap by default)
  ┌──────────────────────────────────────────────────────────────────┐
  │ send ONE user message                                            │
  │   turn 1: preamble + listing + task                              │
  │   later:  every result of the previous reply, + REMINDER         │
  │ model answers: prose + markers (NEED, EDIT, PLAN, DONE, …)       │
  │ parse markers        ← the whole reply is scanned                │
  │ execute each, in order, behind the permission gate               │
  │   reads      → run now                                           │
  │   writes     → land in the overlay, never on disk                │
  │   RUN        → project the overlay into a throwaway copy         │
  │                (sandbox.mjs): the staged edit is what the        │
  │                command sees, the real tree stays untouched       │
  │   VERIFY     → run the run's declared check, or ask the          │
  │                checker for a verdict; the result is a tool result │
  │   PLAN       → maybe stop and wait for a human                   │
  │   SUBAGENT   → run a whole child loop on a second conversation   │
  │ paste every result back as the next ONE message                  │
  └──────────────────────────────────────────────────────────────────┘
  │
  ├─ DONE (or prose-only after work, or nudges ×3, or step limit)
  │  a DONE is a claim, so the loop does not leave on it unchecked:
  │    finishCheck   → a read-only child runs the project's own check
  │                   over the staged tree; a fail rides back as a
  │                   correction instead of ending the run
  │    requireCheck  → a DONE over a still-failing declared check is
  │                   refused (done-unverified)
  │    plan check    → a DONE with open checklist items is asked about
  │    langCheck     → the closing message's share of Thai letters
  │                   (thaiRatio) against minThaiRatio; one rewrite is
  │                   asked for, never blocking
  ▼
finished: summary, credits spent, pending changes → the window's Apply
          (the apply snapshots the files it is about to write first, so
          the apply can be taken back — checkpoints.mjs)
```

The two facts that shaped all of it: the upstream accepts **one user message
per request** (an assistant turn in the array is a bare 403), and **the server
keeps the history**. So the preamble goes out once and becomes part of the
server's memory, every later turn is only the results, and "context is full"
can only be answered by rotating conversations, not trimming messages.

Two more facts the diagram hides, and both are load-bearing. A run **never
writes to disk**: every write is a proposal in the overlay, and the only thing
that writes is an explicit apply. A `RUN` therefore cannot see the tree the
run itself has staged — which is why the projection exists. The staged tree is
copied into a throwaway directory outside the project, the command runs there,
and the disk is still untouched. "Stage a fix, run the check, get `PASS`" is
true inside one run; nothing reaches the real tree until the person applies it.

One more input the diagram hides: a message the person types **while the run
is working**. It neither interrupts the run nor starts a second one — it waits
in the harness's queue (`Harness.inject`, the `run.inject` RPC) and rides the
next step's paste, the one message the protocol allows, framed as a
mid-run note. No run, no queue: the window keeps the text. A run that ends
before delivering it hands the texts back as `inject_orphaned` instead of
swallowing them; the queue is capped at twenty messages so a paste storm
cannot outrun the compaction budget.

The step-by-step anatomy of that loop — every stage, guard, stop reason and
event — is in [`LOOP_DESIGN.md`](LOOP_DESIGN.md).

## The pieces and their contracts

| module | contract | the invariant it protects |
|---|---|---|
| `protocol.mjs` | the marker grammar and the preamble, and nothing else | markers are prose — no brackets, no JSON, no key=value; everything structural drew a 403 |
| `validate.mjs` | one shape check per call, before dispatch | a malformed call answers with one `err:` sentence instead of reaching an implementation that may throw |
| `waf.mjs` | the one substitution table (`outbound`/`inbound`) + the risky-line drop list | every surface substitutes the same way; bytes on disk are exactly what the file had |
| `loop.mjs` | send → parse → execute → paste results | results go back as ONE message; writes stop at the overlay; a plan gates the work |
| `tools.mjs` | string in, string out, one function per marker | no tool ever writes to disk; a read cannot change anything |
| `overlay.mjs` | a pending-edit filesystem over `Map<abs, string \| DELETED>` | a run that dies halfway leaves the tree untouched; diffs exist before anything changes |
| `checkpoints.mjs` | the bytes an apply is about to overwrite, kept outside the project | an approved change can be taken back without git, and the copy of the source never sits in the tree |
| `git.mjs` | the git binary, spoken to with argv arrays | a git write is a write (it asks), and a path that leaves the project never reaches the binary |
| `hooks.mjs` | the person's own commands, bound to a moment (`afterWrite`, `beforeCommit`, `done`): an argv array (never a shell string), the run's root as cwd, a timeout, the output screened for secrets | a hook is the person's command, so it never asks the model for permission, and it may not name a secret file; a failing hook is reported and the run continues, except a failing `beforeCommit`, which refuses the model's `GIT commit` |
| `worktree.mjs` | a run's own checkout: `git worktree add` outside the project (`~/.aipass/run/worktrees/<name>`), on a branch of its own | the files a run writes in a worktree are not the files the person is editing, and the merge is the person's |
| `media.mjs` | the image, video and music models, their presets and their option surface | an option the model does not declare is dropped before the request, and the file is kept outside the project |
| `export.mjs` | one block list, two renderers (markdown, HTML) | the two exports cannot drift, and a transcript loses no entry |
| `schedule.mjs` | the machine's tasks, and the detached CLI that runs them | a due task runs once and is then spent; the backend is never held open by one |
| `sandbox.mjs` | the projection engine: the staged tree copied into a child-visible tree (consumed through `execution.mjs`) | a child process sees the staged edit, and the disk is still never written by a run |
| `execution.mjs` | the one owner of "against what tree does a command run": the world (plain, or the projection), `runShell`, the stop/exit endings, the output path mapping — RUN and VERIFY both execute through it | the tool layer keeps the guards and the text policy; a second world is a branch here, not a second copy of the RUN tool |
| the checker (in `harness.mjs`) | a read-only child that runs the project's own check over the staged tree | a DONE is backed by a verdict the run cannot write for itself |
| `permissions.mjs` | classify → rules → mode → ask | path rules outrank the mode — reads included (H9); nobody listening to a question means deny, not hang |
| `rules.mjs` | one JSON file (`~/.aipass/rules.json`) keyed by project root | "always allow writes under src/" survives a restart |
| `compact.mjs` | estimate bytes/4 → summarise → rotate → re-seed | summarisation happens in the conversation that still holds the history |
| `events.mjs` | the run's observer (`Emitter`) and the windows' bounded fan-out; every type is named in [`EVENTS.md`](EVENTS.md) and pinned by `test/event-map.test.mjs` | a listener never breaks a run; a window that stops reading cannot grow the backend's memory |
| `memory-store.mjs` | the facts a project carries across sessions, and the `RECALL` word match over the sessions it already wrote | a carry survives a rotation, and the recall answers with what was said — never with a guess, and "nothing said" when there is nothing |
| `lang.mjs` | `thaiRatio` over a reply, with code, URLs and commands excluded | the closing message is measured, not guessed at — one rewrite asked for, never a block |
| `harness.mjs` | the facade a CLI, the window and tests all drive | the one-conversation resource is managed nowhere else; helpers propose into the parent overlay |
| `session.mjs` | JSONL append with a forkable tree | a session opened next week reads as one continuous piece of work |
| `skills.mjs` | plain markdown, configured → project → user → repo | the library grows without code changes, and one order serves the window and the CLI alike |
| `plugins.mjs` | `setup(ctx)` in-process: markers, rpc, panels, settings, events, preamble sections; `apiVersion` checked against `PLUGIN_API` (1) | plugins are code you chose to install — not sandboxed, and it says so |
| `stats.mjs` | the `run_stats` lines, rolled up | a run's refusals, nudges, stalls and checks are numbers, not an argument |

What is already right and should not be "improved" away: unique-match REPLACE
(refuses when FIND matches twice), binary detection by magic signature before
a run is wasted on mojibake, the listing that merges pending writes (issue
#32), `resilientSay` halving rejected messages, permissions defaulting to
deny when no one is listening, and helpers whose "yolo" is safe because every
write is only ever a proposal.

**The apply and its undo.** The overlay is the only write surface of a run,
and the apply is the only thing that writes real files. Before it writes,
the files it is about to change are snapshotted into
`~/.aipass/run/checkpoints/<projectKey>/` — outside the project, beside the
projections, which are outside for the same reason. The snapshot holds the
bytes that were on the disk (read at that moment, not remembered from the
overlay) and the bytes about to be written. The answer to the apply carries
the checkpoint's id, so the apply can be taken back: a restore puts the old
bytes back through the shared atomic swap and removes a file that did not
exist before. It is the undo of an apply, not a general undo — anything a
run changed outside an apply is not in the store — and twenty checkpoints
are kept per project.

**The media path.** The account does more than chat, and the harness can
reach the rest of it: the window asks the backend for the media models with
the options each one accepts, for the presets the service publishes, and for
a generation (`media.models`, `media.options`, `media.styles`,
`media.generate`), and the backend talks to the local bridge. Three rules
shape it. The served values win over a table of our own, so a model that
stops offering 720p stops being asked for it — and an option the model does
not declare is dropped BEFORE the request, because the upstream accepts a
value it will not use and refuses it later, once the credits are gone. A
generation waits for the media timeout, not the idle one: a render sits
quiet for minutes, and the idle clock killed images that had already been
paid for. And the bytes are kept locally, under `~/.aipass/media/` — a
signed storage link is short-lived and public, so the answer points at it
but the file the person wants is here.

## The guards a run passes through

Every one of these is live now, and each names the piece that enforces it. The
order is roughly the order a step meets them; the four that decide how a run
*ends* are the checker, the strict gate, the plan checkpoint and the language
check.

| guard | when it fires | what it does | lives in |
|---|---|---|---|
| context budget | against the message about to go out | over budget → summarise → rotate to a fresh conversation → re-seed it with the summary and the memory facts | `compact.mjs` |
| shape check | every call, before dispatch | an empty `RUN`, a blank `NEED`/`SEARCH` or an uninstalled marker answers with one `err:` sentence | `validate.mjs` |
| VERIFY dispatch | the model asks for a check (`VERIFY`), and the run was given `allowVerify` | the declared check runs first — the run's `verifyCommand`, or the project's `.aipass/check.txt` — and the checker is the fallback; the answer is an ordinary tool result, and it is a shell call, so it rides the shell gate | `tools.mjs`, `loop.mjs`, `protocol.mjs` |
| permission gate | every write, shell call and network fetch | classify → rules → mode → ask; path rules outrank the mode, reads included, and no listener means deny | `permissions.mjs` |
| git write | a `GIT stage` / `commit` / `branch`, and only when the run was given `allowGitWrite` | argv arrays (never a shell string), a path that leaves the root is refused, an empty message or an empty index is refused — and the call is classified as a WRITE, so `ask` asks before it runs | `git.mjs`, `tools.mjs`, `permissions.mjs` |
| safety set | a config or lockfile mutation, a destructive `RUN` body | a question in every mode, ahead of grants; a shell-risk command inside the checker denies at once | `permissions.mjs`, `settings.mjs` |
| projection | every `RUN` with something staged | the staged tree is copied into `~/.aipass/run/<project>/run-*` and the command runs there; heavy dirs are junctioned, the output is scrubbed back to the project root, the copy is deleted afterwards | `execution.mjs` (via `sandbox.mjs`) |
| repeat guard | a third identical call with nothing staged in between | refused with an `err:` that says what to change first | `loop.mjs` |
| stagnation guard | the same step ×3, or two steps trading places | one correction, then the run stops | `loop.mjs` |
| verify nudge (R4) | after the first staged code change | one soft nudge: run a test, read the file back, or say that nothing can be run here | `loop.mjs` |
| checker (`finishCheck`) | a DONE over staged code | a read-only child runs the project's own check; a fail rides back as a correction, at most two verdicts a run | `harness.mjs` |
| strict Verify (`requireCheck`) | a DONE over a still-failing declared check | refused as `done-unverified` — the evidence disagrees with the claim | `loop.mjs` |
| plan checkpoint | a DONE with open checklist items | one message names them and asks; a second DONE ends the run either way | `loop.mjs` |
| language check (`langCheck`) | the closing message | the share of Thai letters against `minThaiRatio`; one rewrite asked for, never a block | `lang.mjs` |
| budgets | between tools, at every step, before a helper fan-out | tool calls, wall clock and credits are checked; a spent budget stops the run and records its reason | `loop.mjs` |
| edge pacing | every send, from the first | a token bucket paces sends *before* the edge refuses; a refusal arms a wait ladder shared by every sender | `harness/bridge.mjs`, `extension/page.js` |

Those four are the difference between a run that finishes and a run that
*proves* it finished: the checker answers the DONE with a verdict, the strict
gate refuses a DONE the verdict contradicts, the plan checkpoint asks about
what is still open, and the language check makes the closing message say what
the person asked for. None of them blocks a run twice — one correction each,
then the run goes on or stops.

## Findings

**Every finding is closed.** F1–F10 and the four P2 designs shipped, and the
three latent bugs that surfaced on the way shipped with them. Each entry below
is written as the code stands: what the bug was, and what it is now. The
pass-by-pass account of how they landed is in the appendix.

### P0 — wrong behaviour, now fixed

**F1. Markers inside fenced code were executed.** `parse()` scanned every
line with no awareness of ``` fences, so a reply that *quotes* the protocol —
documentation, an example, this repo's own README being read — had its
`NEED`/`CREATE`/`EDIT` lines run for real, and a fenced `DONE` ended the run.
Both `parse()` and `prose()` now toggle on a fence-open line and skip until it
closes: fenced content stays visible as prose and never runs.

**F2. `GIT` (and `RUN`) blocked the whole backend.** Both used `execSync`,
which freezes the Node event loop — in the desktop backend that is the same
process serving `/rpc` and `/events`, so every `git status` on a slow repo
stopped the UI's heart for up to 15s (120s for RUN in yolo). `GIT` is
classified read and allowed by default, so this happened in the default mode.
Both are asynchronous child processes now, with the same timeouts they always
had (120 s for `RUN`, 15 s for `GIT`): the backend keeps answering while a
command runs.

**F3. `GLOB` ignored everything before `**`.** With `**` in the pattern, only
the *last* segment was matched against the file name — `src/**/*.ts` returned
every `.ts` in the project, not under `src/`, and the model trusted it and
edited the wrong tree. One segment-wise matcher replaced the two branches;
`**` consumes one or more directories.

**F4. `FETCH` would go anywhere and read everything.** The URL was
`inbound()`-ed (restoring `LOOPBACK-IP` and friends) and fetched with no host
check — so `FETCH HTTP-URL127.0.0.1:8787/...` could talk to the bridge
itself, and any loopback or LAN service besides; `res.text()` was unbounded
too. The guard is the shared `bridge/private-hosts.mjs`: loopback, private and
metadata hosts are denied unless a rule or an env says otherwise, and the body
is read incrementally under a ~2 MB cap.

### P1 — protocol and context, now fixed

**F5. Refusal detection was regex folklore.** The loop decided a tool call
failed by matching `/^(no such|error|the text|that text)/` and
`"is a …, not text."` against the result, so every tool that learned a new
failure phrase quietly missed. Every tool result now carries a one-word status
prefix — `err: …` on failure, bare text otherwise — and the loop keys on that
one word. It is harness-generated text, so the model's side of the protocol
did not move and the preamble stays byte-identical.

**F6. Compaction was only checked between runs.** A long task inside one
conversation grew past the budget mid-run; the check happened before the first
message only. The budget is now re-checked against the message about to be
sent, and an over-budget message rotates the conversation there (summarise →
rotate → send summary + current results) in the middle of a run.

**F7. The desktop inherited the CLI's 120s permission timeout.** Unanswered
permission questions resolved to `deny` — right for a terminal you are
watching, wrong for a window whose human is reading a diff. `PermissionEngine`
takes `timeoutMs`, and the desktop passes `0` (wait); the CLI keeps 120s.

**F8. The context budget was one number for every model and every language.**
`contextTokens: 24_000` regardless of model, `bytes/4` regardless of script —
Thai runs ~2× the tokens per byte of English, so compaction fired late exactly
for the users this project is for. The budget is a per-model map now
(`DEFAULT_MODEL_BUDGETS`), the divisor drops to 3 or 2 as the text becomes
Thai or another wide script, and `WEB` results are counted by `estimate()`
too — they were pasted into the server conversation but never measured.

**F9. `SEARCH`/`GLOB` walked everything not in a five-entry hardcode.** No
`.gitignore`, no file-size cap (`target/`, `vendor/`, `coverage/`, 500 MB
logs — all read line by line, synchronously). Both read the root `.gitignore`
now (`harness/gitignore.mjs`), `SKIP` carries the usual suspects, files over
~1 MB are skipped, and `SEARCH` takes `-i`. `WRITE_KINDS`/`WRITERS` are one
vocabulary, not two.

**F10. The preamble promised parallel helpers that did not exist.**
"keep going yourself while it runs" — but `SUBAGENT` awaited the child loop,
so the parent waited and the model planned around a fiction. Both halves are
true now: the preamble sentence is honest (a helper normally waits for its
result, and `background: true` inside the SUBAGENT block is what lets it run
beside the model), and the real fan-out exists — see P2-B.

### P2 — designs worth having, all four shipped

**A. `ATTACH` — the model gets the image or the document.** The marker
mirrors the existing opt-in pattern:

```
ATTACH desktop/shot.png          ← queued, no body
```

The tool queues a part (exists-check, size cap, not under `SKIP`) and the loop
attaches the queued parts to the next message it sends, then clears the queue.
It is classified as read, and that changes nothing about the privacy story:
every `NEED file` already pastes file contents upstream, so `ATTACH` only
closes the gap for binary files, which `read` refuses. The preamble line sits
behind the `--attach` flag, so the CLI's turn-1 bytes stay identical.

**B. A conversation pool — helpers that actually run beside the parent.**
`/v1/chat/completions` accepts a `conversation` field, and
`createConversation` can mint one without adopting it: a helper takes its own
conversation and the save/restore dance is gone. The harness fans the helpers
of one reply out beside each other when `parallelHelpers` is on — the window
has it on by default, the CLI keeps the explicit `--parallel-helpers`. A `WEB`
lookup can run in a throwaway conversation instead of spending the working
one's context (`--web-scratch` on the CLI). Live proof: two helpers fanned out
3 ms apart into two temporary conversations, both generations accepted and
answered concurrently.

**C. "Always" grants and project rules survive a restart.** Both live in one
JSON file per project (`~/.aipass/rules.json`, the same shape the UI already
edits), so "always allow writes under src/" is still true after the backend
dies, and the CLI can add a repeatable `--rule "pattern=decision"` on top. The
engine does not change — only where `rules` and `grants` are seeded from.

**D. Run metrics, and the reader that rolls them up.** Every run appends one
`run_stats` line — stop reason, per-tool counts and latency, nudges,
stagnations, verify prompts, firewall notes, step timings, credits spent — and
`npm run stats` aggregates them. The counters grew with the harness
(`repeatBlocks`, `langPrompts`, `novelResults`, `repeatedResults`,
`checks`/`checkVerdict`, `doneUnverified`, `commitBlocks`), so F10-style
protocol drift is caught as a number instead of guessed at.

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
| `list`, `read`, `search`, `glob`, `skill`, `recall` | read | local; async where it shells out, gitignore- and size-aware where it walks; `recall` reads this project's own sessions, and the question rides the secret floor like any other read |
| `git` | read, or write | `status` / `diff` / `log` read; `stage` / `commit` / `branch` write, and they are off unless the run was given `allowGitWrite` — the argument says which it is, so the gate sees the right risk |
| `fetch`, `web` | read, network | fetch guards private hosts and caps the body; `web` spends the conversation's context and appears in the account's chat history, and its `sources:` block is read out and its redirects resolved (`harness/web-sources.mjs`) so the model is given the article's own address |
| `write`, `replace`, `delete`, `move` | write | overlay only; `replace` requires a unique FIND match |
| `run` | shell | disabled unless `allowRun` |
| `verify` | shell | the model asks for a check; the declared check runs first, the checker is the fallback; disabled unless `allowVerify`, and the preamble that teaches it is behind the same switch |
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

## Appendix A — The research and post-mortem log (Oct 2026)

Everything below is history, in the order it happened: the research rounds
that proposed a change, the live incidents that forced one, and the bug
histories behind the shape the first half of this document describes. Each
entry opens with the state it left behind, so a reader knows what is current
without reading the story. Nothing here is a plan — the per-change log is
[`../CHANGELOG.md`](../CHANGELOG.md) and the session log is
[`WORKLOG.md`](WORKLOG.md).

### The three passes (Oct 2026)

**Now:** all three passes shipped; every finding they carried is closed and
written up in the findings section above. The three latent bugs that surfaced
on the way shipped with them:

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
  `AIPASS_KEEP_RECENT_BYTES` tune a terminal run without a settings object,
  and so do the context manager's newer switches: `AIPASS_ELIDE` turns
  the elision tier on (off by default), `AIPASS_MEMORY=off` stops the
  carried facts, and `AIPASS_COMPACT_AT_PERCENT` names the share-of-budget
  rotation trigger the window's sheet owns (the rotation arms in
  `experiments/queue.json` squeeze through it).
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

### Research round (Oct 2026): four deltas, each from a named source

**Now:** all four shipped — R1, R2, R3 and R4 are in the loop today, and the
"edge-flagged" items that followed are described at the end of this section.
The candidates that did not make the cut are still candidates.

The loop was reviewed component by component against recent harness research.
Four changes made the cut; the rest of the review is noted below as
candidates, not shipped.

**R1 - Oscillation, the other no-progress loop.** Analyses of infinite agentic
loops (IAL-Scan, arXiv:2607.01641) flag "two states trading places" beside
plain repetition: every individual step looks new, the pair goes nowhere.
`loop.mjs` keeps the last step signatures and stops an A/B/A/B run the same
way it stops an A/A/A one - one correction, then out.

**R1, widened - the longer round.** The two-state swing is not the only circle
a run can go round: read file A, edit file B, run the test, read file A again
is a three-state round, and the swing cannot see it (the step three back is
the same, not the step two back). The guard now reads the window - the last
p+1 signatures, the first and the last the same and the p in between all
different - and counts LAPS, because in a three-state round only every third
step closes the loop. One lap earns the correction, the second stops the run.
The evidence side rides with it: a run whose answers keep coming back the
same (`repeatedResults` against `novelResults` in `run_stats`) is stopped on
the first strike instead of being handed a correction it has already shown it
does not act on.

**R2 - Edit diagnostics are free here.** Ablations of coding harnesses ("An
Empirical Study of Harness Design for Coding Agents", arXiv:2609.20804;
"Beyond the Model", arXiv:2609.32459) put structured tools with validation
among the few components that pay off consistently. The cheapest hard check
available is the runtime itself: a staged `.mjs`/`.cjs`/`.js` edit is written
to a temp file and passed through `node --check`; the verdict rides the tool
result, so a syntax error costs one round trip instead of a broken apply.

**R2, widened - the other file families.** The same argument, at a fraction of
the price, reaches JSON: `JSON.parse` needs no process and no toolchain, and a
staged `package.json` with a missing comma breaks every tool in the project
the moment it lands. A staged `.json` edit is parsed in-process and the
verdict rides the result the same way; the error names the line and the
column, so the fix is a place and not a hunt. Two shapes are read the way
their own readers read them: a `tsconfig*.json` and a `*.jsonc` may carry
comments and trailing commas (TypeScript accepts both), and every other
`.json` is read as JSON, strictly - npm reads `package.json` that way, and a
trailing comma in it is a real bug.

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
before a helper fan-out; a spent budget stops the run and
records `tools-limited` / `time-limited` in `run_stats`); the optional credit
cap (`maxCredits`, 0 = off — observed spend against the cached quota, records
`credit-limited`); task-specific helper
instructions (a `role:` line on SUBAGENT — `verifier` may RUN checks, `reviewer`
and `summariser` only read; all three are read-only by construction, their
write markers answer `err:` before anything is staged); spill reads return the
asked-for range verbatim (no second gutter over the numbered copy, no spill of
a spill); every write answers with a first/last line read-back. Later the same
month, the step cap turned opt-in: `maxSteps: 0` (now the shipped default) means
no cap — a run goes until DONE, a guard stops it, or a budget is spent — while
`1..200` still caps and announces it on the last step; helpers stay bounded at 8
and the checker at 6, so an uncapped parent never uncaps a child.

**Edge-flagged (Oct 2026):** the elision tier — stale, bulky sends in the
summarisation transcript are cut to a counted head…tail stub (what the output
was, how it ended) instead of the plain 1200-char slice. It ships off by
default: `elideStaleResults` / `AIPASS_ELIDE`, with the queue record
`elision-tier` deciding whether the default flips. The same rotation now runs
the memory tier, on by default: the summariser is asked for a trailing
`MEMORY:` section of durable facts (decisions, constraints, files) on the same
call; the facts merge across rotations (deduped, clipped, capped at 20),
record on the compaction entry (`memory`), and pin into every later seed. A
reply without the section costs nothing — the narrative is unchanged and the
facts stay in prose — and `AIPASS_MEMORY=off` stops the carrying. The queue
record `memory-tier-carry` is what measures whether the facts earn their
place.

### The upstream edge, measured live (Oct 2026)

**Now:** the two refusal families are encoded in `waf.mjs` and round-trip
byte-exact. The cure for a *pace* refusal is the ladder this section grew:
the page waits 15s then 60s, the client waits 60s then 180s, both arms the
tab-wide clock, and only a refusal that survives all of it is treated as
content and split. The sends themselves are paced before any refusal — the
token bucket in `harness/bridge.mjs`, four tokens and one more every 45
seconds.

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
collected a **429 Too Many Requests** mid-run — and the cure is layered (its
waits were lengthened in the second follow-up below): the page waits the
request out in place (`extension/page.js`), and `BridgeClient` retries the
message itself (`RATE_WAITS_MS`, `harness/bridge.mjs`), each only before any
delta streamed, so a busy edge pauses a run instead of ending it. The suspected third rule is
closed too: a bare relative path (`./math.mjs`) was never a rule, it only
403'd while the block was up. With the edge quiet, `h1` carrying
`import … from './math.mjs';` was accepted, and every read result in the
re-run below carried `./` unencoded with zero rejects, so it stays as it is.

**Follow-up, Oct 17 — the cure had a gate of its own.** A live run died of a
429 exactly like the one above, during a firewall rejection's recovery: the
page's waiting line (`[429] rate limited by the edge — waiting 5s…`) rode tool
status — a `reasoning_content` delta — and `BridgeClient` counts any reasoning
delta as "the answer started": the one condition its resend gate refuses to
cross. The note arrived first, the gate closed before the refusal did, and
neither wait above ever engaged. The waiting line now rides the `note` kind
(`extension/page.js`); the note field is the client's signal that a delta is
not the answer — its reasoning echo still shows in consoles that never learned
the field — so the refusal behind it is waited out, not fatal.
`run-resilience.test.mjs` plays the sequence — note, then 429 — and pins the
retry.

**Follow-up, Oct 17 — the 403 was not always about the content.** A live
desktop run kept printing `rejected — splitting into 2 parts and resending`:
the day's sessions hold 33 split entries, 13 of them with a second "Part 1,
more follows" stacked on the first, and 18 fragments dropped outright after
splitting — 137 bytes at the smallest. Under a pace refusal that is all cost
and no cure, and the drops cost content: a 137-byte fragment has no split
left, so the model never saw it. The edge refuses by pace score as well as by
content, and those bytes pass a moment later: a 214-byte `Result of skill
list` was refused whole and then accepted with no rewrite; a read was refused
whole while both of its halves passed on their own. So the chain now
distinguishes before it acts. Known offenders are still dropped at once (the
deterministic families above), then the identical message is sent again after
a short wait — 5s/15s in the page (`EDGE_WAITS_403_MS`), 10s/30s/60s above it
(`EDGE_WAITS_MS`, `AIPASS_EDGE_WAITS_MS` overrides) — and only a refusal that
survives every wait is treated as content and split, with the part protocol
announced by the outermost split alone (a chunk split again used to carry its
prefix stacked on the outer one). The wait is the right medicine for pace and
the wrong one for content, and the reverse holds for the split: splitting a
pace refusal doubles the messages the edge is refusing, which is exactly what
the day's cascades were made of.

**Follow-up, Oct 17 — the split ran while the edge was still pacing.** The
report that opened this round: `rejected — splitting into 2 parts and
resending` immediately followed by a fatal
`aipass returned 429 … {server=cloudflare …}`. The chain's own reading of the
sequence: a pace-shaped 403 outlived the waits above (page 5s/15s + client
10s/30s), the split the 403 contract allows then doubled the messages at the
worst moment, the part sends drew 429s, and the top of the chain had no rate
branch at all — the raw 429 ended the run. Three changes close it, each aimed
at the same physics: every probe is itself a request and counts against the
window it is waiting for, so a retry storm keeps its own limiter hot.

1. The waits grow instead of tightening — 10s/45s/120s in the page
   (`RETRY_WAITS_MS`, retry-after capped at 120s) and 60s/180s above it
   (`RATE_WAITS_MS`, `AIPASS_RATE_WAITS_MS` overrides), and `EDGE_WAITS_MS`
   gained a third rung (10s/30s/60s) so the split is only reached after two
   minutes of identical resends were all refused.
2. The page's rate clock is tab-wide and outlives the request: a 429 — and a
   pace-score 403, since the follow-up below — sets `rateQuietUntil`, and
   every later send in any job waits on it, so parallel senders stack behind
   one pause instead of storming; for five minutes after any refusal
   (`RATE_MEMORY_MS`) sends are also paced 3s apart (`RATE_PACE_GAP_MS`), so
   the burst that drew the refusal cannot immediately draw another.
3. `resilientSay` (and the styled console's `sayResilient`) grew the branch it
   was missing: a 429/503 is waited again at the message layer — the same
   message, never a rewrite or a split — and only then surfaces, with its
   forensics plus the advice ("the account is moving too fast. Pause a moment,
   then continue"). And the rewrite chain now honours `err.streamed`
   (retrySend marks a refusal that arrives after deltas reached the client):
   no redact, no split, no resend over a delivered answer.

`run-resilience.test.mjs` pins the layer (a 429 waited again, never split; the
advice on the final surface; the `streamed` mark) and `page.test.mjs` pins the
tab-wide clock and the post-incident pacing.

**Follow-up, Oct 17 — the 403 cooled only the job it refused.** A pace-score
403 is the same limiter family as the 429s above, but it armed only the
refused job's own clock; every send queued behind it — the next step's tool
result, a parallel helper — left at full pace into the window that had just
said no. A 403 now arms the tab-wide clocks exactly as a 429 does: the sends
behind it wait out one shared pause and are then paced 3s apart while the
window cools (`page.test.mjs` pins the tab-wide wait for a 403).

**Follow-up, Oct 20 — pacing moved ahead of the first refusal.** Every layer
above reacts: it waits after the edge says no. That still spends the refusal,
and parallel helpers can put several sends on the wire before any of them sees
the shared clock. `BridgeClient` now carries a token bucket: one token per wire
send (retries and conversation creates included), four tokens at the start and
one more every 45 seconds — nine messages in four minutes, the measured
envelope — so an ordinary burst waits a little instead of drawing a 429 and
then waiting a lot. The bucket is per client, shared by every helper and the
checker because they share the client. `AIPASS_RATE_BUCKET` overrides it
(`off` for tests, `capacity,refillMs` for an experiment); the suite sets `off`
in its harness and `scripts/test.mjs`, and `rate-bucket.test.mjs` pins the
metering, the refill and the abort path with an injected clock.

**Follow-up, Oct 20 — the 403's waits were probes, not patience.** The bucket
above paces sends *before* the first refusal, and the tab's clock paces them
*after* one — but the ladder in between was answering the refusal with a
five-second pause, then fifteen, then ten, then thirty, then sixty. Five
probes inside the very window they were waiting for. A live desktop run drew
one refusal on a benign tool result (a `glob` listing of file paths — nothing a
filter would have an opinion about) and sat in `[403] refused at the edge —
waiting 5s` for ninety seconds: the page asked again after 5s and 15s, the
client asked again after 10s and 30s, and each of those requests landed inside
the window the run was waiting for and kept it hot. The refusal was never
about the message, and it never cleared, because the cure was the disease.

Three things changed, and they are the same physics the 429 path already
follows:

1. **The ladder waits like a rate ladder.** The page's 403 ladder is 15s then
   60s (`EDGE_WAITS_403_MS`, where it was 5s then 15s) and the client's is 60s
   then 180s (`EDGE_WAITS_MS`, where it was 10s/30s/60s) — the same shape a 429
   gets, because it is the same limiter. A refusal that survives all of that
   is content, and only then is it split.
2. **The tab falls back to the envelope, not to a third of a second.** After
   any refusal the tab paces its sends 20s apart (`RATE_PACE_GAP_MS`, where it
   was 3s — eight times faster than the ten-per-four-minutes the edge
   enforces). The 3s gap is what turned one refusal into an episode: the tab
   stayed inside the window that had just said no, so every send drew the next
   refusal and each one re-armed the same 3s pace. Under the new gap the tab
   cools instead. Independently of any refusal, two sends in one tab now keep a
   2s floor (`SEND_GAP_MS`), so a helper, the chat pane and a second project
   cannot put four requests on the wire inside one second.
3. **The create is a send, and a resend says so.** The conversation create
   (`/chat.data`) used to fire outside the tab's clock entirely, so a run could
   create its conversation and post its first message back-to-back — the shape
   the edge refuses most; it waits on the same clock now, and the send after it
   waits the same gap behind it. A resend carries `x-ai-retry`, the header the
   site's own client sends when a person retries a message, so the server can
   tell the repeat from a second turn.

`page.test.mjs` pins all of it: the envelope gap after a refusal, the floor
between two sends, the create on the same clock, and the retry header.

**Follow-up, Oct 21 — the refusal reaches the client that can fix it.** The
ladder above answers a refusal with the same bytes again, and the ninety
seconds before the client hears about it are the page's waits (15 s, then
60 s) plus the tab's 20 s gap. But the cure for a content-shaped refusal is
not another copy of the same bytes — it is the client's chain (drop the risky
lines, shorten it, halve it), and the page cannot see that chain. So the
client says on every send that it rewrites a refusal (`rewrite_on_refusal`),
and the page hands the 403 back at once instead of probing: the recorded run
sat in `[403] refused at the edge` for a minute and a quarter while the one
request that carried on was available all along (a 3,721-byte message refused,
the same message at 2,242 bytes accepted). A client that does not say so
keeps the page's ladder — it has no rewrite to offer — and the pace case is
not lost: the client's own ladder (60 s, then 180 s) is the patience the
page's ladder was standing in for. `page.test.mjs` pins the handoff, and
`run-resilience.test.mjs` pins that the client asks for it.

### The re-run that passed, and the gap it stepped on (Oct 2026)

**Now:** the gap is closed. A `RUN` sees the tree the run has staged — the
projection in `sandbox.mjs` puts the staged edits into a throwaway copy
outside the project and runs the command there — so "stage a fix, run the
check, get `PASS`" completes inside one step. The disk is still never written
by a run. The decision, the reasoning and the two later adjustments are
below, in the order they happened.

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

**The gap it stepped on: a run could not see its own staged edits.** `RUN`
executes against the tree on disk, and the overlay is invisible to a child
process by design — so when the model staged its one-line fix and ran
`node check.mjs` to verify it, it read the *old* file's `FAIL`, concluded the
save had failed, and spent the rest of the run re-reading and re-editing until
the 429 closed the door. The smoke's own task — "fix it, then run the check" —
could not complete mid-run under these semantics, and a model that trusts its
tools over its doubts kept tripping on it. The options, none free:
materialize staged files for the length of a `RUN` (a child-visible temp
copy); say it in the protocol (a run sees disk until the end); or write
straight to disk in `auto`/`yolo`, where the person already said yes. Deciding
this was queued, not guessed.

**Decided and shipped (2026-10-15): the projection.** The first option was the
only one that keeps every invariant — the protocol cannot say "a run sees
disk" without making the Verify stage structurally impossible, and writing
straight to disk in `auto`/`yolo` would trade away diff-before-apply, the
crash-safety of a dead run, and helpers' proposals. `sandbox.mjs` now projects
the tree into a throwaway copy with the staged edits written in: source
files copied (a copy means an in-place write cannot touch the real file),
heavy directories — `node_modules`, `.git`, build outputs — junctioned so a
check does not pay to copy them, staged deletes left out. The command runs
there, its stdout/stderr have the sandbox path swapped back to the project
root (which also keeps identical commands byte-identical across steps, so the
stagnation guard still recognizes a repeat), and the copy is deleted in a
`finally`. A run with nothing staged skips the projection entirely and
behaves exactly as before. What the model sees is now the truth it always
assumed: stage a fix, run `node check.mjs`, get `PASS`.

**Where the projection lives (2026-10-20).** It used to be
`.aipass/run/run-*`, inside the project — a full copy of the user's source,
and of whatever secrets the project holds, in the folder a `git add -A` walks.
It lives under `~/.aipass/run/<project>/run-*` now, so it cannot be committed
by accident and cannot be walked by a tool. Three things changed with it: a
janitor (`sweepSandboxes`) collects the copies a killed backend left behind —
nothing did before; the janitor knows WHO owns a projection (a stamp beside
it, carrying the pid), so a copy whose backend died is collected after
minutes instead of after the six hours a live run's budget needs, and the
sweep runs at every boot and before every run, not only at the first one; a
link that points OUTSIDE the project is left out of the
projection (the tools refuse such a path, so copying the target in would put
a file where the run could read it); and a file over the size cap
(`AIPASS_SANDBOX_MAX_FILE_MB`, 64 MB) is left out and named in the command's
result. The heavy directories are still SHARED with the real tree — a copy of
`node_modules` would cost a minute per RUN — so a write into one of them
lands in the user's project; the command's result now says which folders are
shared, so the model is never surprised by a change it did not make.

Proven live the same day, on a broken `total.mjs` with `check.mjs` printing
FAIL: the model staged the one-word fix and ran the check in the same step —
`run {n:1, fail:0}`, output `PASS`, and since the run counted as the in-step
check, `verifyPrompts 0`. Three sends, `stagnations 0`, and the applied tree
passes on the real disk. The shape of the original smoke now completes in one
step.

### Research round 2 (Oct 2026): the five-stage spine

**Now:** the spine is adopted and every block of it is shipped except two,
both named as such below — test-time scaling (nothing runs a task N ways and
keeps the attempt that passes) and the outer tuning loop, which is still the
working style rather than an automated harness.

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
  me" plus the listing again (`loop.mjs`, the `again` message) — except when
  the listing has not moved, which is answered with a one-line "unchanged"
  note: the same conversation still holds the last one (`listingShown`, keyed
  by conversation id). The digest's "2–4 turns spent rediscovering the tree"
  is what these messages buy back; the delta is what keeps them from being
  paid for twice.
- **Loop — done.** One user message per turn; the whole reply is parsed; every
  marker runs in order and all results return as ONE message.
- **Observation compressor — done, three levers.** A single tool result is
  clipped at `maxResult` with a paging hint (`read` paginates properly); the
  summarisation transcript elides stale, bulky sends to head…tail stubs
  (opt-in, `elideStaleResults`); the conversation itself is summarised and
  rotated at the budget line, and the seed pins the merged memory facts
  (`compact.mjs`).
- **Action validator — done.** Fenced protocol text never executes (F1); a
  malformed marker comes back as `err: …` pointing at the fix (F5); a staged
  `.mjs`/`.cjs`/`.js` edit passes `node --check` and a staged `.json` edit
  passes `JSON.parse` (R2, both widened); REPLACE refuses an
  ambiguous FIND; every write passes the permission engine and everything
  outbound passes the WAF table. Harness-Bench's "format violations are the
  most common failure class" is the failure this layer turns into a
  one-round-trip correction.
- **Verify — done, in two forms.** The soft form is R4: one nudge after the
  first staged code change. The digest's stronger reading — *done means a
  runnable check passed* — was blocked by the RUN-vs-overlay gap; that gap is
  closed by the projection (above), so a verification run now reads the staged
  tree, and the checker (2026-10-15) put a verdict behind every DONE: a
  read-only child runs the project's own check, and `requireCheck` refuses a
  DONE the verdict contradicts. `verifyPrompts` tracks how often the nudge
  fires.
- **Stop/Recover — done, five exits.** Stagnation (repeat ×3, oscillation ×2, or
  a longer round twice, after one correction), no-marker nudge ×3 → give up,
  `ignore_done`, the step
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
- **Offline tuning — manual, with an evals harness beside it.** The outer loop
  already is the working style:
  run_stats and session logs → findings with a reproduction → patch → the suite
  as the regression gate → a live smoke against the real edge (the suite fakes
  the extension; the smoke cannot be faked). Meta-Harness's own held-out caveat
  is why the automated evals harness was not assumed — it shipped on 2026-10-15
  (`scripts/evals.mjs`, `npm run evals`; see the queue below).

### The hook points, mapped onto the spine (Oct 2026)

**Now:** every row below is shipped, and the list that followed the table is
closed - the checker, the safety set, both bugs the review turned up, the
bootstrap snapshot, the per-tool latency and the plugin markers behind the
gate all landed. The only two things the review left open are the in-process
event subscription for plugins and the stronger reading of Verify, and both
are noted where they belong.

A review brought the Claude-Code-style hook vocabulary to this design: six
places a harness can intervene, each checked against the code as it stands.
Four were already the behaviour of a named module, one was deliberately soft,
and one was the safety set the engine supported but did not yet ship as
defaults — it does now. The map, then what each gap was worth:

| hook | spine stage | mechanism today | status |
|---|---|---|---|
| SessionStart — inject a snapshot | Bootstrap | preamble + top-level listing on turn 1; a later turn re-pastes the listing only when it moved — an unchanged one is a single line, and a rotation forgets the memory, so the first follow-up after it pastes the table in full; the bootstrap snapshot (`git status --short` + package scripts) rides the turn-1 listing slot (`loop.mjs#bootstrapSnapshot`, `harness.mjs#listingShown`) | done — the desktop harness ships it on by default; the CLI keeps the opt-in `--snapshot` so its tuned bytes stay identical |
| PreToolUse — validate the shape, deny with a reason | Action validator | one `validateCall()` before dispatch (`harness/validate.mjs`) checks every built-in, plugin and MCP call for the same shape contract, so an empty `RUN`, a blank `NEED`/`SEARCH` or an uninstalled marker answers with one `err: …` sentence before any implementation sees it; fenced protocol text never executes (F1); `node --check` on staged JS and `JSON.parse` on staged JSON (R2); permission denials carry the rule name; a plugin marker rides the permission engine like a built-in — the risk it declared, or a write when it declared none (`permissions.mjs#classifyPlugin`) — and the person's own path rules and the secret floor reach it through the marker's argument | done — shapes are central, and the gate reaches every marker |
| PostToolUse — compact an oversized result | Observation compressor | clip at `maxResult` + spill file with a `NEED` locator (`tools.mjs`) — reads keep the head, `RUN` keeps head+tail (ACI round); the summary transcript elides stale bulk (opt-in) and the rotation's seed pins the memory facts; conversation summarise→rotate at the budget (`compact.mjs`) | done, three tiers — clip + spill, elision (opt-in), rotate; the elided middle of a command sits on disk, not lost |
| Stop — tests fail, keep working | Verify | R4's one soft nudge (`verifyPrompts`); the checker at DONE — a read-only child runs the project's own check, the verdict computed from what it ran, one continuation on fail (`loop.mjs`, `harness.mjs#makeChecker`); `verifyCommand` names that check for a run without `.aipass/check.txt`; `requireCheck` refuses a later DONE over a failing verdict as `done-unverified` | done — advisory by default, strict gate opt-in; `checks`/`checkVerdict`/`checkCommand` and `doneUnverified` recorded |
| PreToolUse — count calls, log every event | Budget + trace | one `run_stats` line per run + one session JSONL entry per tool call, 20 000-char result and all; `run_stats.tools` carries `{n, fail, ms}` per kind and `stats` prints the mean latency | done — a hard per-run cap is still not recorded (the budget stops a run with its reason instead) |
| PreToolUse — destructive commands, config files, red-test commits | Safety gates | modes + the H9 rule engine: path rules outrank the mode, reads included; no listener means deny; `classifyRun` asks about hazardous `RUN` bodies in every mode, ahead of grants; `SAFETY_RULES` ask about config/lockfile mutations (`permissions.mjs`, `settings.mjs`); the declared check (`.aipass/check.txt`, or `verifyCommand` when set) arms the red-test commit gate: a `git commit` RUN is refused until it passed at the current tree state, and `run_stats.commitBlocks` counts the refusals | done — the gate names the command and its source (`--verify-command` or `.aipass/check.txt`) |
| the person's own commands — `afterWrite`, `beforeCommit`, `done` | the action, after it and before it; the stop | command lines the person wrote (`settings.json` → `hooks`): an argv array (never a shell string), the run's root as cwd, a 30 s timeout, the output screened for secrets. The verdict comes back to the model after a change and to the person as a note when the run ends; a failing hook is reported and the run continues, except a failing `beforeCommit`, which refuses the commit (`harness/hooks.mjs`, `harness/tools.mjs`) | done — the person's command, so it asks nobody for permission; the secret floor still refuses a command that names a secret file |

Worth closing, in roughly the order the table reads — all of them closed since,
and each entry says when:

1. **A verdict behind DONE — shipped 2026-10-15** as the checker
   ([`SPEC_CHECKER.md`](SPEC_CHECKER.md), tests `checker.test.mjs`). The
   remaining edge closed 2026-10-20: `verifyCommand` names the check when a run
   has no `.aipass/check.txt`, so the verdict carries a comparable command
   (`run_stats.checkCommand`), and `requireCheck` makes the last failing verdict
   terminal as `done-unverified` instead of accepting the DONE. The red-test
   commit gate reads the same option (or the file). Pinned in
   `checker.test.mjs` and `gates.test.mjs`.
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
   sandbox, `git init` included. (2026-10-20: the projection moved out of the
   project, so the sentinel is written when a repository is reachable from
   EITHER the project or the projection's new home.)
4. **Bootstrap snapshot — shipped 2026-10-17** behind `--snapshot`: git
   status and the package scripts quoted into turn 1. Since 2026-10-20 the
   desktop harness turns it on for every run (the window's user never sees the
   flag and pays the same discovery round trips), while the CLI keeps the
   opt-in so its tuned bytes stay identical (`loop.mjs`, `rpc.mjs`,
   `test/desktop.test.mjs`, `agent.test.mjs`).
5. **Per-tool latency — shipped 2026-10-17**: one `ms` field in `toolStats`,
   aggregated in `stats.mjs` and printed per kind (`stats.test.mjs`). A hard
   per-run cap is still not recorded: the soft budget stops a run with a
   reason, which the recorded end already names.
6. **The plugin markers behind the gate — shipped 2026-10-20**. A marker a
   plugin registered used to run whenever the model asked for it: only a
   marker that *declared* a `risk` at registration rode the permission engine,
   and an undeclared one was trusted by silence. That is the wrong way round
   — a plugin's code runs in the backend process with the app's rights, so
   "nobody said" is not "it only reads". Now every marker is classified
   (`permissions.mjs#classifyPlugin`): the declared risk is taken as given, and
   an undeclared marker is classified like a write. The person's own path
   rules and the secret floor reach it through the marker's argument, and a
   payload the argument does not carry — the body — is screened for secret
   names too, because a plugin used as a proxy would carry the file straight
   back to the model and the plugin's own code cannot be screened from here.
   The window's question says what it is: a marker, and what it was handed
   (`desktop/ui/app.js`). Pinned in `gates.test.mjs` and
   `permissions.test.mjs`.

On the architecture question the vocabulary invites: keep the gate-class checks
core. Their invariant — "a run cannot be unsafe because a plugin is absent" —
is why they sit in the loop and the permission engine; a hook system that can
fail open would move the wrong thing. The observable event surface, though, is
already rich (every harness event reaches the window over SSE), so the cheap
win is making that surface subscribable in-process for plugins too — after
which "hooks" are just events with better names.

The person's own hooks landed after this review (the row above), and they are
the other kind of hook: a command line the person configured, not an event the
harness invents. It runs inside the project and behind the same secret floor,
it never asks the model for permission — the person configured it — and the
gate-class checks above stayed core, because a hook that can fail open would
move the wrong thing.

The queue, in dependency order — closed, all four:

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
   2026-10-15** (`gates.test.mjs`); the red-test commit gate shipped
   2026-10-17, keyed off the declared check (`.aipass/check.txt`) the checker
   section names.

### The tool ACI round (Oct 2026): the contracts, tightened

**Now:** all five changes shipped, each with a test in `tools-aci.test.mjs`.
The two items left "not taken" are still candidates, and the list below says
why they were not taken.

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

### The live stall of Oct 2026: a bare `NEED`, and a model that moved

**Now:** both halves of this failure are fixed. A bare `NEED <path>` is
parsed as the file form (and `NEED list <path>` as the directory form), a
reply that looks like a mangled marker earns the nudge instead of ending the
run, the launcher adopts a backend that is already there instead of fighting
it, and a run whose saved model is not on the live catalog fails before its
first send by name.

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
   stack — that crash was the "the app does not open" report. The probe has to
   survive the loopback token to do that: the backend's `/rpc` answers a
   token-less call with a 401, and a probe that only accepts a 200 never sees
   the running backend at all — it starts a second one and the window opens on
   "port 8790 is busy". So the probe sends the token, and a 401 carrying the
   backend's own refusal still counts as ours (a running backend whose token
   differs from the file's); a 401 that is not ours is a stranger's port
   (`harness/backend-probe.mjs`, `desktop/main.mjs`). Static UI files
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

4. **A call names the project it is about.** The sidebar above was scoped to
   *the* project — the one the backend's `current` pointed at, which is
   whichever window spoke last. With two windows open on two projects that is
   not a scoping rule but a coin toss: window A read window B's sessions,
   file tree and pending diffs, and window A's **Apply** button wrote window
   B's staged edits to window B's disk while A's header said "project A".
   Every call now carries an `x-aipass-project` header, and the backend
   answers for that project — looked up, never switched to, so a call is a
   target and not a move of the machine's current project (the human's own
   switch still moves it, through `projects.switch`). The scope is a header
   and not a parameter because `root` in `settings.set` already means "switch
   the machine to this project", and one key cannot mean two things; a method
   that names its own project still wins, because the header says *who* is
   asking and the parameter says *what* the call is about. The store's own
   lookups are scoped too: a session id is matched whole (`session-<id>.jsonl`
   — a substring match made `session.delete {id:"a"}` delete a session nobody
   named) and within the project the caller named
   (`harness/rpc.mjs`, `harness/session.mjs`, `desktop/ui/app.js`,
   `test/desktop.test.mjs`).

**Shipped (the stability pass):** the extension knows the frame now —
`data-model_switched` arrives as a `note` part (one line per distinct switch),
the bridge maps note parts onto a `delta.note` beside the reasoning echo the
chat console already reads, and `BridgeClient` hands that to the harness as
the same `note` event the budget guard uses: a visible transcript line, not
text folded into the reasoning. The other half is a pre-flight: a run whose
saved model is not on the live catalog list fails before its first send, by
name (`stopReason: "error"`, the sentence in the summary), instead of letting
the site swap in a substitute and say nothing — `/v1/models` now carries
`source: "live" | "fallback"` so only a real catalog can judge, and `auto`
(the pick the site delegates to itself — where the user's setting landed the
same day) is never judged, nor is a run ever blocked because a list was
missing. Pinned by `test/page.test.mjs`, `test/run-resilience.test.mjs`,
`test/bridge.test.mjs` and `test/model-catalog.test.mjs`.

### The four-minute blip (Oct 2026): a run must not die of a reconnect

**Now:** the gap is survivable. `BridgeClient` retries the dispatch refusal
six times, a second apart, while nothing has streamed back yet; the refusal
feeds the same one-click "open a tab" flow as the tab's own wording; and the
window's stop button ends a run as `cancelled` — a decision, not a failure —
and the stop reaches the tools, the command in flight, the projection and the
web search with it.

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
   the user did on purpose. It now ends as `cancelled`. And it ends the
   *work*, not only the conversation: the signal is checked between the tools
   of a reply and between steps, a command in flight is killed with its
   tree, the projection a `RUN` waits for is abandoned, the web search and an
   MCP call ride the same signal, a stopped run stages no more edits, and the
   run's abort controller is created before the first `await` so a stop can
   never be lost in the gap while a run is starting
   (`harness/loop.mjs`, `harness/harness.mjs`, `harness/tools.mjs`,
   `harness/sandbox.mjs`, `harness/mcp.mjs`, `test/stop.test.mjs`).

Pinned by `test/run-resilience.test.mjs` (the gap is retried; a mid-stream
refusal is not; a create survives the same gap).

**Plugins, same day:** a plugin filtered out by `settings.plugins` had still
run its `setup()`, so its tools, RPC methods and panels stayed live while
every listing said it was off. The filter is now read before setup runs, and
`test/plugins.test.mjs` pins both directions — only the named plugins load,
and a reload honours a changed list.

### The Thai pack (Oct 2026): language policy, guards, and the stop hook

**Now:** the whole pack is on by default. The preamble states the language
policy, `langCheck` measures the closing message and asks for one Thai
rewrite, the repeat guard refuses a third identical call, the argument guard
normalises a path once and says so, the checker runs at the stalled exit, and
the marker-attempt guard gives the nudge its turn back. The counters behind
them are in `run_stats`.

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
   misses `minThaiRatio` (default 0.4: of the 23 recorded finishes the Thai
   closings sat at 0.57+ and the English ones at 0, so the default clears the
   gap; closings under 12 letters are never measured). What is measured is
   the user-facing text: a closing reply that also carried calls is judged on
   its closing line alone, because a CREATE body or a plan block is content,
   not a message — the false trigger the recorded sessions showed. One
   rewrite per run; `run_stats.langPrompts` and the `lang_prompt` event
   record it.
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
8. **The marker-attempt guard (H10), and `NEED list`.** A recorded desktop
   run (session `f5acb222`) carried both halves of one failure. First the
   model asked for a folder with `NEED list desktop` — a shape `parse()` did
   not know, so the request vanished. Then, because a reply that parses to
   nothing after real work had happened was read as "the model answered",
   the implicit-done path ended the run 633ms later with `nudges: 0` — the
   nudge that teaches the shapes never got its turn. Two fixes: `NEED list
   <path>` (also `NEED ls`, and bare `NEED list` for the project root) is now
   the dir call everywhere `NEED dir` is; and a reply whose line starts with
   an uppercase marker keyword (`attemptedMarker()` in `protocol.mjs`) no
   longer counts as prose-after-work — the nudge fires and the run gets its
   chance to ask properly. Case matters: "Need to check the logs" is prose,
   and a fenced example is a quotation, as everywhere else in the wire.

   The window grew the same split for the reader: when a run ends with an
   answer (done, or a question), its working trail — tool rows, step notes,
   folded reasoning, interim prose — collapses into one `✻ ระหว่างทำงาน`
   line and the closing bubble is labelled **ผลลัพธ์**, so the answer is
   what stands out. A run that stopped short (steps, error, stall) keeps
   the whole trail open, and rows with live buttons (the step-limit
   "carry on", the no-chat-tab banner) are never folded in — hiding the
   only click that unblocks the run would be its own failure.
