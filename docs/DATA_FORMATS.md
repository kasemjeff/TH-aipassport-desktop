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
```

That list is also the retention story — nothing under `~/.aipass/` expires on
its own except log files (rotation, below); the rest is yours to delete, and
deleting it is the whole uninstall (§Retention).

## settings.json

Written atomically (`Settings.set()` writes a temp file, then renames — a
crash mid-write never loses settings) and validated by `Settings.sane()` on
every read and write: numbers are clamped to their documented bounds, enums
fall back to defaults, and a path rule that could never match (empty pattern)
is dropped rather than stored where it looks like protection. A missing or
unreadable file is the normal first-run case; the defaults apply.

The full field list and its defaults live in `harness/settings.mjs`
(`DEFAULTS`) — that file is the schema. The shape, in short:

| key | type | default | what it is |
|---|---|---|---|
| `defaultModel` | string? | null | the model a fresh run starts on |
| `mode` | `ask` \| `auto` \| `yolo` | `ask` | who may write |
| `allowRun` | bool | false | shell commands allowed at all |
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
| `uploads` | string? | null | override for the staged-uploads directory |
| `chatUrl`, `autoOpenTab` | string, bool | `https://de.aipass.net/chat`, true | where a run finds its tab |
| `theme` | `dark` \| `light` \| `auto` | `dark` | the window's palette |

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
name is the project path slugified (`C:\Users\me\proj` → `C-Users-me-proj`).

Header (`type: "header"`) — the fields the window's picker reads without
parsing the rest:

```json
{"type":"header","id":"a1b2c3d4","parentId":null,"title":"…","root":"…",
 "model":…,"created":…,"updated":…,"entryCount":…,"forkedFrom":…,"app":…,"schema":1}
```

`schema: 1` is the format version of the file itself; `app` names the build
that created it — additive, absent in older files, carried through forks and
header rewrites by anything that does not know it. Entry types:

| type | carries |
|---|---|
| `user` | the text the run sent (the only thing upstream ever sees per turn) |
| `assistant` | `text`, optional `reasoning` |
| `tool` | `kind`, `arg`, `out`, `ok` |
| `diff` | `file`, `added`, `removed`, `decision: pending \| applied \| rejected` |
| `todo` | `items: [{text, done}]` |
| `compaction` | `summary`, `lastSummarizedEntryId`, optional `memory` (durable facts carried across rotations) |
| `note` | free text (helpers, bookkeeping) |

The header is presentation state (`title`, `updated`, `entryCount`). It is
rewritten on the first append and then once per 25 appends (`HEADER_EVERY` in
`harness/session.mjs`); `rename()` and `fork()` rewrite it unconditionally.
Everything a run needs is in the appended lines, so a header that lags (or a
torn one) costs a picker line, not a session.

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
  first line that does not parse to a header object makes `list()` skip the
  file and `load()` return null, so a half-written file cannot reach the
  picker as a row you can click.
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

The agent has no memory store. "Memory" is exactly this, and nothing else:

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
- **everything in the working tree** — uploads, spill files, whatever the
  user put where the agent can read it.

**Provenance and trust.** Everything the model can remember was written on
this machine, by this user's own runs: there is no ingestion path, no shared
or server-side memory, and the session file is the only copy (Retention
below). The memory is data, not instructions — a poisoned summary rephrases,
it cannot resurrect removed items — and torn or wrong-typed lines are skipped
on load (`aipass-bridge/test/data-integrity.test.mjs` pins all of it).

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
| everything | quit the app, delete `~/.aipass/` whole — settings, sessions, uploads, token and all. Next start mints a fresh token. |
| the eval history | `evals/results/` is gitignored and disposable (`rm -rf`); nothing reads it after the run it belongs to |

Logs rotate at 5 MB and keep one generation (above), so they cannot grow
without bound; that is the only automatic cleanup. There is no telemetry and
no server copy — the session JSONL is the only place a conversation exists,
and whatever you paste elsewhere is the only way it leaves the machine.

Export: there is no exporter, deliberately — the files *are* the export.
Sessions are JSONL (one conversation per file), `evals/results/` is JSONL,
settings one JSON object: copy them anywhere, `jq` them, track them. Nothing
is encrypted at rest — sessions and uploads are created owner-only
(0o700/0o600) where the OS has modes, but a copy inherits the permissions of
whatever copied it. Moving `~/.aipass` whole moves the install's memory, logs
and identity together — move that folder (including `.token`) only to a
machine you trust as much as this one.

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
- **A backup is a folder copy**, and the drill runs in the suite:
  `aipass-bridge/test/restore-drill.test.mjs` copies a live home into a
  second environment on every run and proves sessions, settings and the
  token read the same there.
