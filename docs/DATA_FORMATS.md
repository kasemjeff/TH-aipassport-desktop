# Data formats — what lands on disk

Everything the app writes is under `~/.aipass/` (or `$AIPASS_HOME` when set;
tests use it to stay hermetic). Nothing here is an account credential — the
session cookie never leaves Chrome, by design (see `SECURITY.md`).

```text
~/.aipass/
  settings.json     one file, shared by the window, the CLI and the agent
  .token            the loopback bearer token (0600; minted on first start)
  sessions/         one directory per project, one JSONL per session
  uploads/          staged attachments the window dropped (capped, throwaway)
  plugins/          one .mjs per plugin
  skills/           user playbooks
  logs/             capped logs: bridge.log, desktop-backend.log (5 MB cap)
  bridge.pid        the pid `aipass stop` looks for
  memory/           the durable facts a project carries across sessions
  run/              the throwaway copies a RUN sees, the checkpoints, the worktrees
  media/            generated images, clips and songs
  schedule.json     the scheduled tasks (0600)
  schedule.pid      the pids of the scheduled jobs that are running
```

That list is also the retention story — nothing under `~/.aipass/` expires on
its own except log files (rotation, below); the rest is yours to delete, and
deleting it is the whole uninstall (§Retention).

## settings.json

Written atomically (`Settings.set()` writes a temp file with a name no other
writer shares, fsyncs it and the directory, then renames — a crash mid-write
never loses settings, and two writers never meet) and validated by
`Settings.sane()` on every read and write: numbers are clamped to their
documented bounds, enums fall back to defaults, the keys that would let a
payload act on a prototype (`__proto__`, `constructor`, `prototype`) are
stripped at every depth, and a path rule that could never match (empty
pattern) is dropped rather than stored where it looks like protection. A
missing file is the normal first-run case and the defaults apply; a file that
is there and cannot be read is NOT the same thing — it is surfaced as a
warning and in `Settings.problems`, with the safe defaults still in force.

The full field list and its defaults live in `harness/settings.mjs`
(`DEFAULTS`) — that file is the schema. The shape, in short:

| key | type | default | what it is |
|---|---|---|---|
| `defaultModel` | string? | null | the model a fresh run starts on |
| `mode` | `ask` \| `auto` \| `yolo` | `ask` | who may write |
| `allowRun` | bool | false | shell commands allowed at all |
| `allowFetch` | bool | false | a fetch the model chose is allowed (the CLI's `--allow-fetch`; the window asks instead) |
| `maxSteps` / `maxToolCalls` / `maxWallClockMs` | number | 0 / 300 / 1800000 | per-run caps; `maxSteps` 0 means no cap (the run ends on DONE, a guard, or a budget), the other two fall back to the default on zero or nonsense |
| `maxCredits` | number | 0 | spend ceiling in credits — the one cap where 0 really means off; checked against the cached quota (at most ~30s stale) |
| `plan`, `requirePlanApproval` | bool | false | the plan gate |
| `thinking` | `off`…`max` | `low` | reasoning level per send |
| `replyLanguage`, `langCheck`, `minThaiRatio` | `th` \| `en`, bool, 0–1 | `th`, true, 0.4 | the language check |
| `repeatGuard`, `repeatGuardMax` | bool, number | true, 4 | the repeat guard |
| `compaction` | `{contextTokens, reserveTokens, keepRecentBytes}` | see code | the context budget |
| `compactAtPercent` | number | 40 | rotate at this share of the budget |
| `rules` | `{pattern, decision, kinds?}[]` | [] | path rules, first match wins |
| `projects` | `{name, path}[]` | [] | the project picker, most recent first |
| `root` | string? | null | the root a new backend starts on |
| `plugins` | string[] | [] | plugin names to load from `plugins/` |
| `skillsDirs` | string[] | [] | extra folders the playbook library is read from |
| `searchI`, `attach`, `webScratch` | bool | false | the extra tool forms the model is taught |
| `uploads` | string? | null | override for the staged-uploads directory |
| `chatUrl`, `autoOpenTab` | string, bool | `https://de.aipass.net/chat`, true | where a run finds its tab |
| `theme` | `dark` \| `light` \| `auto` | `dark` | the window's palette |
| `hooks` | `{afterWrite, beforeCommit, done}` | `{afterWrite: [], beforeCommit: [], done: []}` | the person's own commands, one command per line, at three moments — after a change is staged, before the model's `GIT commit`, when the run ends. A moment is a string or a list, and the list is the chain: each entry is one command, run on its own, in order. A line over 300 characters, a duplicate, anything that is not a string and the eleventh command are dropped, so a setting that could not run is not stored |
| `recall` | bool | true | may the model ask what this project said before (the `RECALL` marker). It is a read, so it is on by default; the option stops the preamble teaching the marker — the marker itself is a read, and a read answers |

Versioning: readers merge the stored file over `DEFAULTS`, so a file written
by an older build keeps working — missing keys take their default and unknown
keys are preserved untouched. A breaking change would bump the app's version
(`package.json`); there is no migration step to run, by design — nothing to
install, nothing to migrate. `reset()` deliberately keeps `root` and
`projects`, so resetting the form never teleports you out of your folder.

## sessions/*.jsonl

One JSONL file per session, one entry per line. Line 1 is the header; every
later line carries `id` + `parentId`, so a session is a chain — and a fork is
a copied chain (`Session.fork()`). Files live in a per-project directory whose
name is the project path slugified (`C:\Users\me\proj` → `C-Users-me-proj`) —
an absolute-path key, like the memory file's hash and the `rules.json` entry,
which is what `aipass relocate` rewrites after a project moves (Recovery).

Header (`type: "header"`) — the fields the window's picker reads without
parsing the rest:

```json
{"type":"header","id":"a1b2c3d4","parentId":null,"title":"…","root":"…",
 "model":…,"created":…,"updated":…,"entryCount":…,"forkedFrom":…,"app":…,"schema":1,
 "conversation":"…","conversationTemporary":true}
```

`schema: 1` is the format version of the file itself; `app` names the build
that created it — additive, absent in older files, carried through forks and
header rewrites by anything that does not know it. `conversation` (+
`conversationTemporary`) is the model-side conversation the session works in:
written when a conversation accepts the session's first message, adopted when
the session is reopened, and removed when that conversation turns out to be
gone upstream — absent in files written before bindings existed, where a
reopen is answered with a transcript digest instead (`Session#bindConversation`,
`Harness#resumeSeed`). A `fork()` strips both: a branch is a new writer.
Entry types:

| type | carries |
|---|---|
| `user` | the text the run sent (the only thing upstream ever sees per turn) |
| `assistant` | `text`, optional `reasoning` |
| `tool` | `kind`, `arg`, `out`, `ok` |
| `diff` | `file`, `added`, `removed`, `decision: pending \| applied \| rejected` |
| `todo` | `items: [{text, done}]` |
| `compaction` | `summary`, `lastSummarizedEntryId`, optional `memory` (durable facts carried across rotations) |
| `note` | free text (helpers, bookkeeping) |

The header is presentation state (`title`, `updated`, `entryCount`) plus one
functional field: the conversation binding. It is rewritten on the first
append and then once per 25 appends (`HEADER_EVERY` in `harness/session.mjs`);
`rename()` and `fork()` rewrite it unconditionally. Everything a run executes
from is in the appended lines, so a header that lags costs a picker line — or
one resume's warmth, the next seed covers it — not a session.

Because that rewrite is an in-place 2 KB overwrite, it has one crash window
the atomic swap does not: a torn first line. The rewrite writes the same
header to a sibling `session-<id>.jsonl.hdr` breadcrumb (atomically) before
touching the file, and deletes it once the write completed. Readers fall back
to the breadcrumb when the first line does not parse, and `load()` writes it
back so the next open reads the file the ordinary way. A crash therefore
leaves either the old header or the new one plus its breadcrumb — never a
session nobody can open. A leftover breadcrumb next to a healthy header is
ignored and cleaned up on the next load.

A header rewrite is a read-modify-write, and more than one writer can be
looking at the same session: the desktop backend and the CLI share one store,
and a window can be open on a project while a command line runs in it. So the
rewrite takes a lock (`session-<id>.jsonl.lock`, created O_EXCL, taken over
when it is older than 15 seconds) and merges: the header **on disk** plus the
fields this call changed, not this call's own copy of the header. A rename in
one writer therefore survives an append in the other, and so does the
conversation binding. A lock that cannot be taken within 5 seconds falls back
to the whole-file swap, which cannot tear the file.

Two things follow from the header carrying the project:

- **The directory is a bucket, not a boundary.** The directory name is the
  path slugified, and a slug is lossy: `C:\a b` and `C:\a-b` are the same
  slug, and a long path is cut at 60 characters. So the header's own `root`
  is the authority on which project a session belongs to, and `list()`,
  `resolveFile()` and `reassign()` all ask the header. A session of another
  project is not this project's to open, rename, delete or relocate — by id
  **or** by path.
- **A session id is a file name.** It is 48 bits from the crypto module
  (`crypto.randomBytes(6)`), because a collision is not a key that gets
  refused: the new session would replace the old one, and the whole
  conversation with it.

A session file is read by walking it, not by loading it: a session grows by
appends and nothing trims it, so the reader streams the lines and keeps what
it needs. Past `MAX_SESSION_BYTES` (64 MB, `AIPASS_MAX_SESSION_BYTES` to
change it) the session is refused with a reason rather than taking the window
down with it.

**What is on the disk, and when.** The header rewrite fsyncs the file: the
entries it counts and the header that counts them land on the disk together,
so what survives a power cut is what the header says. A run that has ENDED
flushes the session once more (`Session#flush`), so the tail of a finished
conversation is durable rather than sitting in the OS's hands. Between two
rewrites the header can lag by up to `HEADER_EVERY` entries — it never
overstates, and it never goes backwards when a second writer is on the same
file.

**The picker reads headers, not transcripts.** `list()` needs each session's
header and nothing else, so it reads the first line of each file — sized to
the header (2 KB), not to the file (64 KB was the cost of a store with
hundreds of sessions) — and memoizes what it read on the file's mtime+size,
the same pair the overlay memoizes its texts on. A file that has not changed
answers from the memo; a file that has is read again.

**The archive.** A session can be moved out of the picker's way into
`<project>/archive/` (`archiveIdle()`), and it can be taken back out of it
(`restore()`) — the archive is a place, not a one-way door. `pruneArchived()`
is the one thing in the store that deletes: only what has sat in the archive
past the threshold, and only as many as the limit says. The window does this
from the session rail, the CLI from `aipass sessions`.

Sessions are machine-local and sensitive: they contain your own text
verbatim. Delete a project's directory to be done with it — `SECURITY.md`
says the same, in the same words.

## The token file

`~/.aipass/.token` — a 256-bit hex token, minted once
(`harness/authtoken.mjs`), written `0600` under a `0700` home (best effort on
Windows). Every bridge and backend route except `/status`, `/health`, the
same-origin `/token` handoff the window boots from, and the backend's own
static UI files requires it as a bearer. `AIPASS_TOKEN` overrides the file
(containers, tests); `AIPASS_REQUIRE_AUTH=0` disables the requirement with a
boot warning — for transition only.

## logs/

`~/.aipass/logs/` keeps at most two generations per log: past the cap the
live file becomes `<name>.1` and a fresh one starts (`harness/log-file.mjs`;
`AIPASS_LOG_MAX_BYTES` overrides the 5 MB default). Two files land here:

| file | written by |
|---|---|
| `bridge.log` | a bridge the desktop backend started |
| `desktop-backend.log` | the desktop backend — its terminal in dev, or the packaged shell, which redirects the child's stdout/stderr and appends `[supervisor]` lines when it restarts a backend that exited |

Rotation happens when a log is opened, so a process that holds a writer keeps
appending to the renamed `.1` until it exits. One generation is enough history
to see what filled the file; older is noise.

## uploads/

Staged attachments from the window. A file that already lives inside the
project is referenced in place; anything else is copied into `uploads/`
(owned — dropping the staged reference deletes the copy, never the user's
original). Capped at 20 MB per file before anything is read. Machine-local;
safe to delete when no window is running.

## run/

Three things live under `~/.aipass/run/`, and none of them is inside a
project — a copy of the user's source inside the project could be committed
by accident (root rule 1).

**The projections.** A `RUN` sees the tree the run has staged, so the tree
is copied into `~/.aipass/run/<slug>-<hash>/run-*` — one folder per project
— and the command runs there. The heavy directories (`node_modules`, `.git`,
build outputs) are junctioned rather than copied, which is why a staged
write into one of them is kept out of the projection instead of landing in
the real project.
The copy is deleted when the command ends; a janitor collects the ones a
killed backend left behind.

**The checkpoints.** Before an apply writes to the disk, the files it is
about to change are snapshotted here — the bytes that were on the disk, and
the bytes about to be written:

```text
~/.aipass/run/checkpoints/<projectKey>/<id>/
  meta.json        what the checkpoint is: the id, the moment, the files
  before-0.bin     the bytes that were on the disk before the apply
  after-0.bin      the bytes the apply was about to write
```

`projectKey` is the first 16 hex digits of a SHA-256 over the **real** root
(a project reached through a junction has two names, and only the real one
is worth keying on — otherwise one project would have two histories). The
`id` is `<milliseconds>-<8 hex>`, so the names sort into the order they
were taken in, and that order is what the pruning reads.

The bytes are read from the disk at the moment of the apply, not from the
overlay's memory of them: a person may have edited a file between the stage
and the apply, and a restore has to put back what was really there. A
restore writes the old bytes back through the shared atomic swap and keeps
the file's mode (a restore that dropped a script's exec bit would break the
project); a file that did not exist before the apply is removed again.

Twenty checkpoints are kept per project and the oldest are pruned. The
blobs are written with the default file mode — the store is not owner-only
the way the sessions are — so the home's own permissions are what protects
them. Deleting the folder deletes the undo; there is no other copy.

**The worktrees.** A run can work in its own checkout — a second working
tree of the same repository, on a branch of its own:

```text
~/.aipass/run/worktrees/<name>/    the checkout itself
```

The folder takes the person's own word, cleaned of what a Windows path
cannot hold; Thai is kept, because a person who names a worktree in Thai
should get a folder they can recognise. The branch cannot hold a space, so
it is spelled in ASCII (`aipass/<name>`) and the window shows the branch and
the path together. The folder is outside the project for the reason the
projections are: a checkout of the user's source inside their own project
is a copy a `git add -A` walks into.

Nothing of the person's own work is stored here — a worktree is a git
checkout, not a copy the house keeps — so the folder is the person's to
delete. The window names the worktree, its branch and its path, shows what
changed inside each one, can take one away, and sweeps the ones nobody
wants: only the ones this house made, only the ones with nothing
uncommitted in them, and only the ones that have sat there for a fortnight.
The branch keeps the commits, so taking a checkout away never loses a
commit — but an uncommitted file lives in that folder and nowhere else.
The merge is the person's.

## media/

Generated images, clips and songs — one file per generation, named
`aipass-<kind>-<milliseconds>-<counter>.<ext>`. The folder is the default
destination because a render must not land in a repository by accident; a
caller that names a path gets that path (a relative one is relative to the
project, the house's rule for every path the window hands over).

A signed storage link is short-lived and public: the answer points at it,
but the file the person wants is here. The bytes are fetched once and kept
locally. A text render (an SVG, a JSON, a caption) is screened for secrets
before it is written, like any other output; a binary picture is not, because
the shapes the screen looks for are text shapes.

## schedule.json

The scheduled tasks of this machine — owner-only (`0600`), written through
the shared atomic swap, so a crash mid-write leaves the previous schedule
whole:

```json
{"version":1,"entries":[{"id":"…","task":"…","root":"…","at":"09:00",
  "kind":"daily","enabled":true,"lastRunAt":null,"createdAt":0}]}
```

`at` is a local time of day (`HH:MM`), `kind` is `daily` or `once`, and
`lastRunAt` is the moment the entry last ran — the day is the reader's, so
a run at 00:30 belongs to the day it happened on. A `once` entry is spent
when it runs (it is disabled afterwards); a daily entry keeps its place and
waits for tomorrow. A line that is not an entry is skipped rather than
loaded: the file is the user's own, and a hand-edit must not be able to
crash the store.

`schedule.pid` names the scheduled jobs that are still running, one pid per
line — the same idea as `bridge.pid`. A pid of a job that ended days ago is
litter, so only the live ones are written.

The backend ticks nothing by itself: the window calls `schedule.runDue`,
and the work is started detached through the CLI, so the desktop backend is
never held open by a scheduled run.

## evals/results/*.jsonl

One line per attempt (`docs/SPEC_EVALS.md`): task id, `outcome`, `stopReason`,
`steps`, `turns`, `stepMs[]`, `wallMs`, `tokensEst`, `spent`, tool call counts
and refusals, and the checker's `{command, exit, ms, tail}`. Gitignored —
machine-local like sessions; `git add -f` one deliberately to keep it.

## Missing, duplicated and wrong-typed data

The formats are JSONL and JSON, and the readers are written for the day a
write was interrupted — the promises below are pinned by
`aipass-bridge/test/data-integrity.test.mjs`:

- **A torn line is skipped, the session survives.** A crash mid-append costs
  the unfinished line, never the file. The same rule covers the header: a
  first line that does not parse falls back to the `.hdr` breadcrumb an
  interrupted header rewrite left behind (previous section); with no
  breadcrumb either, `list()` skips the file and `load()` returns null, so a
  half-written file cannot reach the picker as a row you can click. A first
  line only counts as a header when it says `type: "header"` — an entry line
  carries a string `id` too, and used to list as a session that then refused
  to open.
- **A duplicated entry loads once.** Appends are id-keyed; if the same entry
  id appears twice (a retried write), the second copy is dropped on load and
  every `parentId` chain still resolves.
- **A line that parses but does not belong** (an array, an entry with no
  `id`) is skipped the same way. An entry type this build does not know —
  one written by a newer version — is preserved in `entries` untouched;
  nothing in the chain is rewritten to "fix" it.
- **Settings merge over `DEFAULTS`** (above): an old file keeps working, a
  new key takes its default, an unknown key survives a save. The test for
  "no migration step" writes a two-key settings file and reads it back.
- **Conflict detection is at the file, not the write.** One harness run at a
  time is enforced by the run lock (`hardening.test.mjs`), which is why
  sessions never race: last-writer-wins between processes is not a scenario
  the format pretends to solve. Inside a file, an `EDIT` whose match is
  ambiguous is refused rather than guessed — the refusal is the conflict
  answer.

## Memory — what the model carries

"Memory" is exactly this, and nothing else:

- **the session transcript** — every user turn, assistant reply and tool
  exchange in the file above, appended as the run goes (`LOOP_DESIGN.md`
  contract 5); a fresh conversation starts from nothing but its preamble and
  the task;
- **compaction summaries** — when a conversation outgrows its window, the
  compactor replaces the oldest stretch with one `compaction` entry
  (`loop.mjs`); the summary is a rephrasing — a claim about the past, never
  state the harness trusts;
- **carried facts** — the `memory` list on that same entry: the durable
  facts a rotation extracted (decisions, constraints, files), merged across
  rotations and pinned into every later seed (`compact.mjs` `digest`/`seed`).
  Still claims about the past — clipped at 200 characters a fact and capped
  at 20, and the seed tells the model to re-check anything stale;
  `AIPASS_MEMORY=off` stops the carrying without deleting anything;
- **the project's own facts** — `~/.aipass/memory/<hash>.json`
  (`harness/memory-store.mjs`): the facts that crossed a session boundary.
  A new session loads them into its first run, and a rotation writes the new
  ones back. The file is named after a hash of the project's absolute path,
  so a project that moved reads "no facts" until `aipass relocate` re-keys
  it. Deleting the file is the off-switch;
- **everything in the working tree** — uploads, spill files, whatever the
  user put where the agent can read it.

**The recall.** The facts above are what the machine carried; the recall is
the other half — the model asking what was said before, so the person can
ask "what did we decide last week?". `RECALL <question>` searches this
project's own sessions (a plain word match over the newest ones, newest
first, with a short excerpt per hit) and says how many sessions it searched.
It reads the sessions, not the facts file, and it brings back nothing that
was not said in this project.

**Provenance and trust.** Everything the model can remember was written on
this machine, by this user's own runs: there is no ingestion path, no shared
or server-side memory, and the session file and the project's memory file
are the only copies (Retention below). The memory is data, not instructions
— a poisoned summary rephrases, it cannot resurrect removed items — and torn
or wrong-typed lines are skipped on load
(`aipass-bridge/test/data-integrity.test.mjs` pins all of it).

**Staleness and versioning.** A replay fingerprint that no longer matches
marks the row stale instead of scoring it (`SPEC_EVALS.md` §5); a compaction
entry records the newest entry its summary folds away
(`lastSummarizedEntryId`; files written before the rename spell it
`firstKeptEntryId`), so the boundary between what was summarised and what
stayed live is a fact on disk; the session header's `app` stamp says which
build wrote the file, and an old file under a newer build reads with the same
merge rules.

**Measuring value, cold vs warm.** The only honest instrument is the eval
probe (`SPEC_EVALS.md` §4: `--reuse` vs fresh conversations, attempts ≥ 3) —
run it as the `memory-cold-warm` experiment record (`docs/EXPERIMENTS.md`),
never as a vibe. If the warm arm turns out worthless, the record says so and
the probe stops being rerun.

## Retention

Nothing under `~/.aipass/` expires on its own except the logs, and that is a
deliberate non-feature: it is your directory. What "delete my data" means,
exactly:

| what | how to be done with it |
|---|---|
| one conversation | delete the session from the window, or remove the file under `sessions/<project>/` |
| one project | delete its directory under `sessions/` |
| the undo of an apply | delete that project's folder under `run/checkpoints/` (its name is a hash of the project path) — twenty checkpoints per project, and the oldest go on their own |
| a run's own checkout | take it away from the window (`/worktree`) — the branch keeps the commits, but an uncommitted file in that folder exists nowhere else |
| the facts a project carries | delete `memory/<hash>.json` — the next session starts with none |
| a generated picture, clip or song | delete the file under `media/` |
| a scheduled task | remove it from the window, or delete the entry in `schedule.json` |
| everything | quit the app, delete `~/.aipass/` whole — settings, sessions, uploads, token and all. Next start mints a fresh token. |
| the eval history | `evals/results/` is gitignored and disposable (`rm -rf`); nothing reads it after the run it belongs to |

Logs rotate at 5 MB and keep one generation (above), so they cannot grow
without bound; that is the only automatic cleanup. There is no telemetry and
no server copy — the session JSONL is the only place a conversation exists,
and whatever you paste elsewhere is the only way it leaves the machine.

Export: the files are still the export — sessions are JSONL (one
conversation per file), `evals/results/` is JSONL, settings one JSON
object: copy them anywhere, `jq` them, track them. But there is an exporter
now too, for the thing people actually want to keep: a session exports as
markdown, or as one self-contained HTML page (no script, no external asset,
everything escaped), through `session.export`. It reads the session file
from the disk, so a session that is still being written exports what is
already there. Nothing is encrypted at rest — sessions and uploads are
created owner-only (0o700/0o600) where the OS has modes, but a copy
inherits the permissions of whatever copied it. Moving `~/.aipass` whole
moves the install's memory, logs and identity together — move that folder
(including `.token`) only to a machine you trust as much as this one. The
per-project keys are absolute paths, though, so when the projects
themselves live somewhere new on the receiving machine, `aipass relocate`
reconnects them (Recovery, below).

## Recovery (RTO/RPO)

- **RPO — what a crash costs.** Appends land as each turn completes (an
  accepted send, a tool result — `LOOP_DESIGN.md` contract 5), so a hard kill
  loses the in-flight step, not the conversation; an interrupted append costs
  one torn line, skipped on load (above). A copied folder therefore holds
  every completed turn.
- **RTO — getting back.** Restore is copying the backup folder back to
  `~/.aipass` and starting the app: readers merge, nothing migrates —
  minutes, no server. The app itself comes back from the previous installer
  or the previous tag (`docs/RELEASE.md` rollback).
- **A machine move re-keys the paths.** Sessions, cross-session memory, path
  rules and the project list are keyed by the project's *absolute* path, so a
  home restored onto a machine whose project paths differ shows empty pickers,
  no facts and no rules until the keys are rewritten. `aipass relocate <old>
  <new>` (`harness/relocate.mjs`, once per moved project) rewrites all four
  onto the new path, merging with anything already stored there; run it with
  the desktop app closed — a running backend holds the old paths and its open
  sessions in memory. The old folder does not need to exist anymore; the new
  one must, and a session torn before the move is repaired by it (the
  breadcrumb rule above still applies).
- **A backup is a folder copy**, and the drill runs in the suite:
  `aipass-bridge/test/restore-drill.test.mjs` copies a live home into a
  second environment on every run and proves sessions, settings and the
  token read the same there — including the cross-machine case, where the
  project lives at a new path and `relocate` reconnects it.
