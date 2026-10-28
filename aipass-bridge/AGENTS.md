# AGENTS.md — aipass-bridge

> Local law for everything under `aipass-bridge/`. Read `../AGENTS.md` first.
> Verify: `npm test` from the repo root, or one file: `node --test aipass-bridge/test/<name>.test.mjs`.

This directory holds both layers, and the difference decides how you work:
`harness/` is this repository's own work (the agent core the window and `aipass
agent` both drive); `bridge/`, `extension/`, `bin/` and the terminal clients are
upstream ([niawjunior/aipass-bridge](https://github.com/niawjunior/aipass-bridge)),
continued under niawjunior's copyright. Extend them when the harness needs more
of them; do not fork them, and keep what the harness expects.

## Module map

| path | role |
|---|---|
| `bridge/server.mjs` | HTTP API on `127.0.0.1:8787`, the job hub, SSE `/ext/events` (jobs out) and `/ext/{chunk,done,error,loader}` (results in). Job kinds: `chat`, `loader`, `create`. The idle timeout resets on every delta; an extension disconnecting mid-job does **not** fail it — the upstream fetch lives in the page. Deltas buffer ~25 ms and merge adjacent text before flush, and the buffer flushes before done/fail/abort. `bridge/private-hosts.mjs` is the SSRF guard beside it: private ranges + a short-TTL DNS cache. |
| `extension/background.js`, `content.js` / `page.js` | MV3 worker holding the SSE connection (mixed-content/PNA reasons); ISOLATED ⇄ MAIN worlds. `page.js` does `fetch(credentials:'include')` as first-party page JS, refuses any loader path not matching `^/loaders/…`, and the tool set is exactly `{chat, loader, create}` — no arbitrary-URL forwarding. |
| `harness/loop.mjs`, `harness/harness.mjs` | the loop runs the model and dispatches tools as `await tools[call.kind](…)` (guards: steps, wall clock, `maxCredits`, R1 stagnation); the stages live in `harness/run/`: `context.mjs`, `options.mjs`, `send.mjs`, `gates.mjs`, `budgets.mjs`. The harness assembles a run and the DONE checker (see `../docs/SPEC_CHECKER.md`); the option sheet is `harness/settings.mjs` (`HarnessOptions`), shared by the harness and the loop. |
| `harness/rpc.mjs` | desktop backend: `/rpc`, `/events` SSE with a bounded replay buffer, fs list/read (async), permission answers. The `needs_tab` listener hangs off the shared event bus so autoOpenTab works in every project. The methods are one module per domain under `harness/rpc/`; they share one context. |
| `harness/overlay.mjs`, `harness/sandbox.mjs` | pending-writes map; `diskText`/`changeFor` memoized on mtime+size. `materializeTree`: async, gated parallel copies, heavy dirs junctioned, `.git` never projected (a boundary marker is written instead). The tool layer itself is `harness/tools.mjs` — the marker tools (NEED/SEARCH/EDIT/CREATE/RUN/ATTACH/…), async I/O only, staged `.mjs` writes syntax-checked via spawn, long results spilled to `.aipass/spill/`; a web search's sources are read in `harness/web-sources.mjs`. |
| `harness/session.mjs` | session JSONL: append-only, padded fixed-width header (2048 B) rewritten in place under a lock, `HEADER_EVERY = 25` batches the rewrite; the header's `root` says which project a session belongs to, and the file is walked, not loaded. |
| `harness/protocol.mjs`, `harness/authtoken.mjs` | marker grammar (the `RECALL` marker included); compiled regexes cached. `harness/compact.mjs` compacts context, `harness/memory-store.mjs` holds the facts a project carries and the word match over the sessions it already wrote. `harness/waf.mjs` is the substitution table. The token module mints and caches `~/.aipass/.token` (memo revalidated on mtime+size). |
| `harness/hooks.mjs` | the person's own commands, bound to a moment (`afterWrite`, `beforeCommit`, `done`): an argv array (never a shell string), the run's root as cwd, a timeout, the output screened for secrets. A hook is the person's command, so it never asks the model for permission, and it may not name a secret file. A failure is reported and the run continues - except a failing `beforeCommit`, which refuses the model's `GIT commit`. |
| `harness/goal.mjs` | the project's one durable objective (`~/.aipass/goal/<hash>.json`, 0700 dir / 0600 atomic file): the round counter a plain DONE spends, the `GOAL DONE` / `GOAL BLOCKED` actions and the `goal-rounds` ending at the cap. Every mutation re-reads the file, so `aipass goal pause\|clear` wins mid-run; helpers and the checker run with `goal: false`. The CLI is `aipass-bridge/goal.mjs` (`aipass goal show\|set\|pause\|resume\|done\|block\|clear\|path`, no bridge). |
| `harness/worktree.mjs` | a run's own checkout: `git worktree add` outside the project (`~/.aipass/run/worktrees/<name>`) on a branch of its own; the RPC is `worktree.list\|create\|remove\|status\|sweep`. The files a run writes in a worktree are not the files the person is editing, and the merge is the person's. |
| `harness/permissions.mjs`, `instructions.mjs`, `rules.mjs`, `plugins.mjs`, `skills.mjs`, `settings.mjs`, `events.mjs`, `log-file.mjs`, `log-line.mjs`, `argguard.mjs`, `gitignore.mjs`, `bridge.mjs`, `lang.mjs`, `open-command.mjs`, `browser.mjs` | supporting systems; the deep reference is `docs/DOCS.md` (below). The browser is one of them: Chrome first (the extension is a Chrome MV3 extension, so a tab in Edge answers nobody), and a private profile makes the browser an instance of its own. |
| `bin/aipass.mjs`, `chat.mjs`, `agent.mjs`, `list.mjs`, `stats.mjs`, `sessions.mjs`, `doctor.mjs`, `setup-assistant.mjs`, `assistant-prompt.mjs`, `difflib.mjs`, `providers.mjs` | the CLI dispatcher (`aipass dev\|agent\|models\|status\|stop\|…`) and the terminal clients; everything but `dev` auto-starts a detached bridge — and the BRIDGE writes `~/.aipass/bridge.pid` when it binds, which is the file `aipass stop` reads. Install via `install.sh` / `install.ps1`. `providers.mjs` is the registry from the terminal (`aipass providers list\|add\|remove\|use\|test`); `sessions.mjs` is the session store from the terminal (`aipass sessions list\|archived\|archive\|restore\|prune`). |

The internals reference is `aipass-bridge/docs/DOCS.md` — read it before non-trivial bridge changes, and keep it current with them.

## Invariants here

- **One-message constraint**: the upstream endpoint rejects assistant turns in
  `messages` and agent-style system prompts; `lastUserText()` forwards only the
  newest user message, multi-turn is server-side history, and `agent.mjs` sends
  its preamble once into a fresh conversation, then only tool results.
- **Conversation rotation** (`resolveConversation`, `startChat`): reuse the most
  recent (or just-created) conversation; on `404` (deleted) / `409` (generation
  still running) advance to the next-most-recent — but only when no deltas were
  delivered yet and `AIPASS_CONVERSATION_ID` isn't pinned. A nameless send never
  resolves into a *temporary* one: those belong to the session that minted them.
- **turbo-stream**: the app's `.data` loaders return react-router turbo-stream (a flat
  indexed pool); `decodeTurboStream()` in `server.mjs` reads it and
  `encodeTurboStream()` in `test/harness.mjs` builds fixtures the same way — keep
  the pair in sync. **Job lifecycle**: `delta` → flush → `done|fail|abort`; nothing
  reaches the consumer after settle.
- **SSE replay**: sequence numbers are monotonic; a reconnect with `since` must
  never receive a duplicate frame; the window is bounded by count and bytes.
  The buffer is bounded in BYTES (a Thai frame is three bytes a character), and
  a window that stops reading is caught up from the fan-out when its socket
  drains: the frames it missed wait in a bounded queue, and the ones that did
  not fit are counted and named to it.
  Verify: "a window that stops reading loses no frame"
  Verify: "the replay buffer counts bytes, not characters"
  Verify: "a frame the sink took while it was behind is not written twice"
- **Async discipline**: nothing under `bridge/` or `harness/` may block the event loop.
- **A background process ends itself.** The bridge is started DETACHED, so it
  outlives whatever started it — and one that outlives every way of reaching it
  is a leak, not a service. It records its pid when it binds and exits after
  `AIPASS_BRIDGE_IDLE_MS` (10 minutes) with nobody using it.
  Verify: "a bridge nobody is using goes away, and takes its pid file with it"
  Verify: "the bridge records its own pid, and the file names the process that is answering"
- **WAF symmetry** (root rule 4): `outbound()` rewrites trigger tokens before
  anything is sent (`localhost`→`LCLHST`, `<`→`TAG-LT`, `process.env`→`PROCESS-ENV`,
  `.env`→`DOT-ENV`, SSRF IPs, …) and `inbound()` restores everything read back — so
  bytes written to disk are exactly the file's.
- **`sayResilient()`**: on a 403 the chain is `redact()` → a **shorter** copy (the
  run's next step must happen) → the identical message waited out
  (`EDGE_WAITS_MS`) → the message halved and resent. A small message is never
  shortened, and neither is the run's first: it carries the protocol.
  Verify: "a refused big message is sent again, shorter, so the run continues"
  Verify: "a refusal is handed back at once to a client that rewrites the message"
- **A provider client owns the history.** de.aipass.net keeps the conversation
  and takes one user message per request; an API provider is given the whole
  list, so `provider-client.mjs` keeps one array per conversation id. A grant
  is not a permanent yes either: the path rules and the secret floor are checked
  BEFORE the remembered "always" grants, so a later `deny` rule wins. A provider
  keeps its OWN model — a model id means nothing across providers — and its
  catalog has a deadline, so one that never answers cannot hang a run.
  Verify: "a grant does not outlive the rule that came after it, and never reaches a secret file"
  Verify: "an added provider keeps its own model, not the one the backend was given"
  Verify: "a provider that never answers its catalog does not hang the run"
- **The token is written best effort.** It is minted inside a request handler,
  and a throw there ends the backend for every window that is open. A home that
  cannot be written keeps the token in memory, and the SAME one on every call.
  Verify: "a home that cannot be written does not take the backend down"
- **A session belongs to one project, and is written for more than one
  writer.** The file is `session-<id>.jsonl` and the id is the whole name; a
  PATH is a handle too. The per-project directory is named after the path and a
  slug is lossy (`a b` and `a-b` are one slug), so the header's own `root` is
  the authority — the picker, the handle and the relocation all ask the file.
  The header rewrite takes a lock and merges against the header ON DISK, and the
  archive is a place a session comes back out of.
  Verify: "a session of another project is not opened by its path either"
  Verify: "two writers on one session do not lose each other's header changes"
  Verify: "an archived session can be taken back"
  Verify: "a finished session is flushed to the disk"
  Verify: "the picker sees a renamed session, and a memoized header does not hide it"
- **The settings file is read again before it is written.** The window, the CLI
  and the backend share it, and two of them can write it: a save merged into a
  stale copy wrote every other key back, undoing the other's change. A save
  writes only the keys the file knows — a typo in a form is not a setting that
  lives for ever.
  Verify: "a save does not undo the change another surface made"
  Verify: "a settings save writes only the keys the file knows"
- **An attachment rides the message it was sent with.** The parts belong to the
  first message of the RUN, not the first run of the session: gated on the
  session, the picture was encoded and dropped, and the model never saw it.
  Verify: "an attachment rides the first message of every run, not only the first of the session"
- **A file that is not there is a 404, not a crash.** The window's files are
  served from disk while the backend runs, and the content update replaces that
  tree under it: a throw there ends the backend for every window that is open.
  Verify: "a UI file that is gone is a 404, and the backend lives through it"
- **A relative path is relative to the project**: `/file src/app.js` and the
  window's file panel mean "the file in the project I am looking at".
  Verify: "a relative attachment path is relative to the project, not to the backend"
- **The overlay FS**: edits land in an in-memory Map so the model can read back
  its own pending work; apply flushes to disk. `EDIT` refuses a non-unique `FIND`.
- **The agent's marker protocol**: actions are prose lines, one per line —
  `NEED dir <p>`, `NEED file <p> [a-b]`, `SEARCH <text>`, `EDIT <p>` /
  `FIND` / `NEW` / `END`, `CREATE <p>` / `END`, `RUN` / `END` (needs
  `--allow-run`), `ATTACH`, `DONE <summary>`. ATTACH rides the *next* message —
  a DONE in the same reply drops it; `--slim` / `--assistant <id>` drop the
  preamble and `--watch` keeps the conversation open.

## Environment variables (working reference)

Bridge: `AIPASS_PORT` (8787), `AIPASS_HOST` (127.0.0.1 — any other bind exits unless `AIPASS_ALLOW_REMOTE=1`), `AIPASS_MODEL`, `AIPASS_MODELS` (fallback list with no extension attached), `AIPASS_MODEL_FILTER` (`chat`|`all`), `AIPASS_TOOL_VISIBILITY` (`reasoning`|`text`|`off`), `AIPASS_CONVERSATION_ID` (pin one), `AIPASS_IDLE_TIMEOUT_MS` (180000), `AIPASS_BRIDGE_IDLE_MS` (600000 — how long a bridge may sit unused before it ends itself; 0 keeps it for ever), `AIPASS_ASSISTANT_ID` / `AIPASS_ASSISTANT_FIELD`, `AIPASS_CORS_ORIGIN` (off by default), `AIPASS_KEEPALIVE_MS` (15000). Loopback auth: `AIPASS_TOKEN` (explicit — containers, tests), `AIPASS_REQUIRE_AUTH=0` (escape hatch; warns at every boot). Harness and clients (with the desktop): `AIPASS_HOME` (state dir), `AIPASS_BRIDGE` (bridge URL), `AIPASS_SKILLS_DIR`, `AIPASS_FETCH_ALLOW_PRIVATE`, `AIPASS_FETCH_MAX_BYTES`, `AIPASS_SPILL_KEEP` (spill files kept per project, 200), `AIPASS_ELIDE` (elision tier on — off by default), `AIPASS_MEMORY` (`off` stops carrying facts across rotations), `AIPASS_INSTRUCTIONS` (`off` stops the project's AGENTS.md / CLAUDE.md / GEMINI.md from riding turn 1), `AIPASS_INSTRUCTIONS_MAX_BYTES` (8000), `AIPASS_MAX_SESSION_BYTES` (a session file bigger than this is refused, not loaded; 64 MB), `AIPASS_LOG_MAX_BYTES` (log rotation cap, 5 MB), `AIPASS_LOG_FORMAT=json`, `AIPASS_BROWSER_PROFILE` / `AIPASS_BROWSER_PIDFILE` (the suite's own browser — set by `scripts/test.mjs`, not by a person), `AIPASS_BRIDGE_PIDFILE` (where the bridge records its pid, so the bridge the suite started is reachable at the end). Desktop: `AIPASS_DESKTOP_PORT` (8790), `AIPASS_DESKTOP_NO_OPEN`.
