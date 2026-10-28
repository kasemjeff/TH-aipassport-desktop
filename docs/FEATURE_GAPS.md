# FEATURE_GAPS — the gap list this batch of work closes

> What the research found, what is being built, and what "done" means for each
> item. Every row names the test that proves it — a row without a test is a
> wish, not a row.

**Why this file exists.** The repo already keeps a capability registry
(`docs/MATURITY.md`) and a session log (`docs/WORKLOG.md`). This file is the
*plan* for one batch: the gaps a comparison against the category (Claude Code,
Cursor, Codex desktop, OpenCode, Cline, Devin/Windsurf Cascade) and against
our own upstream (`niawjunior/aipass-bridge`) turned up, ordered by what hurts
a real user first.

**The order of the argument.** A gap that costs the user credits or leaks a
path outranks a gap that adds a surface. A gap the repo already declares
("not shipped", "won't build") is a policy, not a gap — those stay as they are
unless a named failure says the policy is wrong.

> **The next wave.** The 2026-10-28 comparison against Claude Code 2.1.312,
> Codex CLI 0.165.0 and DeepSeek Harness lives in
> [`FEATURE_GAPS_WAVE3.md`](./FEATURE_GAPS_WAVE3.md). This file stays as the
> record of the batch below.

**Where the batch stands (2026-10-21).** Wave 1 landed — every row below
carries its own status, and the evidence is the test title named in the
row. Wave 2 landed too: the window has the checkpoint list and the restore
button, the git buttons, the media page, the export action and the session
tree, the schedule page, and the honesty fixes it owed — except the plan
card, whose items still cannot be un-ticked. The three rows that closed it
— the person's own hooks, the model's recall, a run's own checkout — landed
with it. Two rows of wave 1 were already held by the harness before the
batch started, and say so rather than taking credit for them.

---

## Wave 1 — the cost and the safety

### 1.1 Bridge hardening (the upstream PR #45 batch, adapted)

The upstream bridge grew a hardening batch that never reached this fork. Each
item below has a live failure behind it.

| item | why it hurts | done when | status |
|---|---|---|---|
| a per-run token for `/ext/*` | any local process that learns a job id can post as the extension | a post without the token is refused; the extension learns it on connect | **landed** — `bridge/server.mjs` mints it per run and hands it over in the `ready` frame; `extension/background.js` carries it on every post (`test/bridge-hardening.test.mjs`) |
| a dispatch grace window | the MV3 worker drops its SSE stream every few minutes; a chat in that ~3 s window fails outright | a chat waits for the client to come back | **landed** — 5 s, `AIPASS_DISPATCH_GRACE_MS`; a loader read still fails at once, because nobody waits on it |
| a timeout tells the extension to stop | a video job that outlived its timeout keeps polling and keeps spending the account's quota | the timeout sends the same `abort` an abort sends | **landed** — and a reconnecting extension adopts the job its predecessor left behind |
| the SSRF guard resolves DNS | a name pointing at loopback sails through a literal check | every resolved address is checked | **landed** — one private answer among public ones is enough to refuse (`test/ssrf.test.mjs`) |
| `data:` URIs and a hostile `content-length` | the 20 MB attachment cap is bypassable | both are refused before a byte is buffered | **landed** — the cap is on the media, not on the envelope |
| symlinks cannot carry a path out of the root | a symlink inside the project writes outside it | the real path is compared with the resolved root | **already held** — `overlay.safe()` compares the real path with the real root, and root rule 2 says so; not new work in this batch |
| atomic overlay writes | a crash mid-write leaves half a file | the write is write-then-rename | **already held** — the overlay writes through the shared swap (`harness/atomic-write.mjs`); not new work in this batch |
| image models ride the media timeout | an image render is killed by the idle timeout: credits spent, no image | images get the media timeout | **landed** |
| a `null` body is a 400, an oversized body is a 413 | the client sees a 500 or an ECONNRESET instead of the truth | both answer with the right status | **landed** — the body over the limit is no longer a socket reset |

### 1.2 The harness that holds

| item | why it hurts | done when | status |
|---|---|---|---|
| closing an MCP manager clears its tool table | every project switch duplicates the MCP markers | the markers do not duplicate | **landed** — `McpManager.close()` drops the table with the clients (`test/mcp.test.mjs`) |
| the event fan-out has backpressure | a window that stops reading grows the backend without bound | the queue is bounded and the subscriber is told it fell behind | **landed** — a bound by frames and by bytes, the oldest go, the losses are counted, and the subscriber gets a `fell_behind` notice (`test/events.test.mjs`) |
| a provider's model list has a timeout | a provider that never answers hangs a run | the run is not held forever | **landed** — a deadline the process holds, cleared when the fetch answers, and given more room per provider or once for the machine (`AIPASS_PROVIDER_MODELS_TIMEOUT_MS`) (`test/provider-timeout.test.mjs`) |
| a linked heavy directory refuses writes | a write inside `node_modules` lands in the REAL tree today | the write is refused with `err:` | **landed** — every segment of the path is checked, a staged path inside a shared directory is left out of the projection and the real file keeps its bytes, and the house `err:` refusal that names the directory is exported (`sharedWriteRefusal`; `test/sandbox.test.mjs`). Not yet: the RUN's result does not carry that sentence — it carries the note that names the shared folders |

### 1.3 The capabilities the category expects

| item | why it hurts | done when | status |
|---|---|---|---|
| **checkpoints / restore** | an approved change cannot be taken back — the only way back is `git restore` by hand | an applied change can be restored, byte for byte | **landed** — the snapshot is taken before the write, the store is outside the project, the restore puts the bytes back exactly and removes a file that did not exist before; 20 per project (`test/checkpoints.test.mjs`). The window lists them (the pending panel and `/checkpoints`) and has the restore button |
| **git: stage, commit, branch** | `GIT` is read-only, so a run never finishes the job | a git write asks before it runs; a commit records the staged changes | **landed** — off unless the run was given `allowGitWrite`, classified as a WRITE so `ask` asks, argv arrays and no shell, a path outside the project refused (`test/git.test.mjs`). The window's `git.status\|stage\|commit\|branch` are the human's buttons and do not consult the mode |
| **VERIFY marker** | the model cannot ask for a check — the checker only runs on DONE | the model can ask, and a VERIFY without a declared check says so | **landed** — the declared check first, the checker as the fallback, the answer a tool result; off by default (`allowVerify`), and the preamble that teaches it is behind the same switch (`test/verify-marker.test.mjs`) |
| **media (image / video / music) in the harness** | the account can do far more than chat; the window can sell only chat | a generated image is saved where it was asked to go | **landed** — the models with the options each one accepts, the presets resolved by name, the generation kept under `~/.aipass/media/`, and an undeclared option dropped before the request (`test/media.test.mjs`). The window's sheet has the page that makes one |
| **session export + tree** | a person who watched an agent work has no way to keep the transcript | an exported session keeps every entry | **landed** — markdown or one self-contained HTML page, everything escaped; the tree grouped by day (`session.export`, `session.tree`; `test/export.test.mjs`). The window has `/export` and `/tree` |
| **scheduled tasks** | the category runs work on a schedule; we cannot | a due entry runs once and is then spent | **landed** — `~/.aipass/schedule.json` (owner-only), the work runs through the CLI, a due entry runs once and is spent, a disabled one never runs (`test/schedule.test.mjs`). The backend ticks nothing by itself — the window asks it to run what is due — and the window has the page that adds a task |
| **an editor surface** | the only way to use the agent as an agent is our window | an editor client drives the same backend contract | **landed** — `ide-extension/`, a VS Code panel on the same `POST /rpc` + `GET /events` contract; it cannot use the bridge's OpenAI endpoint, because that endpoint refuses an agent-style system prompt and owns the history. It carries its own self-test (`node ide-extension/selftest.mjs`) and is not in the repository suite |

---

## Wave 2 — the window

The window is the product. It gets, in this order:

1. the checkpoint list and the restore button (on the pending-changes
   panel) — **landed**: the pending panel carries the list, and `/checkpoints`
   opens the whole one with a restore and a forget button per checkpoint;
2. the git buttons (stage / commit / branch) — **landed**: the sheet's
   **git** page, with the buttons the human presses. They do not consult
   the model's permission mode, and the commit asks once;
3. the media surface (a "create media" panel: model, options the model
   actually accepts, the saved file) — **landed**: the sheet's **สร้างสื่อ**
   page, and `/media` lists the models;
4. the export action (markdown / HTML) and the session tree — **landed**:
   `/export` and `/tree`;
5. the schedule panel — **landed**: the sheet's **ตารางเวลา** page, and
   `/schedule` lists the tasks;
6. the small honesty fixes the log already names: `/help` omits four
   commands, the transcript grows without bound, a plugin panel only renders
   while the settings sheet is open, an item in the plan card cannot be
   un-ticked — **three landed**: `/help` now reads the palette, so the help
   cannot lie about what the window can do; the transcript drops its oldest
   rows after 300 and says how many went (the session file still holds
   everything); and the plugin panels live in the rail, not only while the
   sheet is open. The plan card is **still open** — an item in it cannot be
   un-ticked.

The window's half of this batch is ordinary wiring on top of a surface that
already exists: the backend methods are the contract, and the buttons that
call them are a page, a panel and six palette commands.

### The three that closed it

| item | why it hurts | done when | status |
|---|---|---|---|
| **the person's own hooks** | the harness has rules, skills and plugins, but no place for "run the linter after every edit" — it is a habit the person keeps forgetting | a command line the person wrote runs at a named moment, and its verdict comes back | **landed** — `harness/hooks.mjs`: `afterWrite` (after a change is staged), `beforeCommit` (before the model's `GIT commit`) and `done` (when the run ends). An argv array (never a shell string), the run's root as cwd, a timeout, the output screened for secrets. A failing hook is reported and the run continues, except a failing `beforeCommit`, which refuses the commit. A hook is the person's own command, so it is not put to the model for permission — but it may not read a secret file (`test/hooks.test.mjs`). The window's sheet has the page that holds them |
| **the model's own recall** | a person who worked with the agent yesterday cannot ask what was said then, and the agent has to be told again | the model can ask the project what it said before, and the answer says what it looked at | **landed** — the `RECALL` marker (`harness/protocol.mjs`, `harness/memory-store.mjs`): a plain word match over this project's newest sessions, newest first, a short excerpt per hit, and the number of sessions it searched. No embedding, no network. It is a read, so it rides the secret floor, and the preamble that teaches it is behind the `recall` option, because the preamble's bytes are pinned by the recorded replay (`test/recall.test.mjs`) |
| **a run's own checkout** | two runs — or a run and the person — editing one repository fight over the same files | the run works in a checkout of its own, and the files it writes are not the files the person is editing | **landed** — `harness/worktree.mjs`: `git worktree add` outside the project (`~/.aipass/run/worktrees/<name>`) on a branch of its own, so the harness, the overlay and the apply are all confined to it. The window names the worktree and its path, shows what changed inside each one, can take one away, and sweeps the ones nobody wants (clean, older than a fortnight). The merge is the person's (`worktree.list\|create\|remove\|status\|sweep`; `test/worktree.test.mjs`) |

---

## What is deliberately NOT in this batch

| item | why not |
|---|---|
| cloud agents / a server side | it breaks the promise that the credential never leaves the user's machine |
| telemetry / crash reporting | a policy decision that is stated, not an oversight (`docs/UPDATE_DESIGN.md`) |
| automatic model fallback | "won't build" (`docs/MATURITY.md`) — only a named failure may reopen it |
| an app sandbox | "the App Sandbox would be a different product" (`docs/INSTALL.md`) |
| a signed Windows installer | it needs a certificate, not code |
| an IDE extension pointed at the bridge's OpenAI endpoint | the edge refuses a system prompt and owns the history — the extension must drive the harness instead |

---

## The rule this batch follows

Every row above is a behaviour, and every behaviour is a test with a title that
is a contract. The suite is the court of record: `npm test` from the repo root.
When a row lands, its test lands with it, and `docs/MATURITY.md` and
`CHANGELOG.md` are updated in the same change — doc drift is a bug.
