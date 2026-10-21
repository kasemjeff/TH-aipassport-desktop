# AGENTS.md — aipass-bridge

> Local law for everything under `aipass-bridge/`. Read `../AGENTS.md` first.
> Verify: `npm test` from the repo root, or one file: `node --test aipass-bridge/test/<name>.test.mjs`.

## Ours and upstream

This directory holds both layers, and the difference decides how you work:

- **`harness/`** — this repository's own work, and the product: the agent core the window and `aipass agent` both drive.
- **`bridge/`, `extension/`, `bin/`, the terminal clients** — upstream
  ([niawjunior/aipass-bridge](https://github.com/niawjunior/aipass-bridge)),
  continued here under niawjunior's copyright. Extend them when the harness
  needs more of them; do not fork them, and keep what the harness expects.

## Module map

| path | role |
|---|---|
| `bridge/server.mjs` | HTTP API on `127.0.0.1:8787`, the job hub, SSE `/ext/events` (jobs out) and `/ext/{chunk,done,error,loader}` (results in). Job kinds: `chat`, `loader`, `create`. The idle timeout resets on every delta; an extension disconnecting mid-job does **not** fail it — the upstream fetch lives in the page. Deltas buffer ~25 ms and merge adjacent text before flush, and the buffer flushes before done/fail/abort. |
| `bridge/private-hosts.mjs` | SSRF guard: private ranges + a short-TTL DNS cache (errors are never cached). |
| `extension/background.js` | MV3 worker; holds the SSE connection (mixed-content/PNA reasons). |
| `extension/content.js` / `page.js` | ISOLATED ⇄ MAIN worlds. `page.js` does `fetch(credentials:'include')` as first-party page JS, refuses any loader path not matching `^/loaders/…`, and the tool set is exactly `{chat, loader, create}` — no arbitrary-URL forwarding. |
| `harness/loop.mjs` | runs the model loop; dispatches tools as `await tools[call.kind](…)`; guards: steps, wall clock, `maxCredits`, R1 stagnation. The stages live in `harness/run/`: `context.mjs`, `options.mjs`, `send.mjs`, `gates.mjs`, `budgets.mjs`. |
| `harness/harness.mjs` | assembles a run; the DONE checker (see `../docs/SPEC_CHECKER.md`). The option sheet is `harness/settings.mjs` (`HarnessOptions`), shared by the harness and the loop. |
| `harness/rpc.mjs` | desktop backend: `/rpc`, `/events` SSE with a bounded replay buffer, fs list/read (async), permission answers. The `needs_tab` listener hangs off the shared event bus so autoOpenTab works in every project. The methods are one module per domain under `harness/rpc/`; they share one context. |
| `harness/tools.mjs` | the marker tools (NEED/SEARCH/EDIT/CREATE/RUN/ATTACH/…). Async I/O only; staged `.mjs` writes are syntax-checked via spawn; long results spill to `.aipass/spill/`. A web search's sources are read in `harness/web-sources.mjs`. |
| `harness/overlay.mjs` | pending-writes map; `diskText`/`changeFor` memoized on mtime+size. |
| `harness/sandbox.mjs` | `materializeTree`: async, gated parallel copies, heavy dirs junctioned, `.git` never projected (a boundary marker is written instead). |
| `harness/session.mjs` | session JSONL: append-only, padded fixed-width header (2048 B) rewritten in place, `HEADER_EVERY = 25` batches the rewrite. |
| `harness/protocol.mjs` | marker grammar; compiled regexes cached. `harness/compact.mjs` compacts context. `harness/waf.mjs` is the substitution table. |
| `harness/authtoken.mjs` | mint/cache `~/.aipass/.token` (memo revalidated on mtime+size). |
| `harness/providers.mjs` | the provider registry: the specs (`~/.aipass/providers.json`) and the keys (`~/.aipass/credentials.json`, owner-only; an env var named by a spec wins). `harness/provider-client.mjs` is the other half — the OpenAI-compatible and Anthropic adapters. A provider is a swap, not a second loop. |
| `harness/permissions.mjs`, `rules.mjs`, `plugins.mjs`, `skills.mjs`, `settings.mjs`, `events.mjs`, `log-file.mjs`, `log-line.mjs`, `argguard.mjs`, `gitignore.mjs`, `bridge.mjs`, `lang.mjs`, `open-command.mjs`, `browser.mjs` | supporting systems; the deep reference is `docs/DOCS.md` (below). The browser is one of them: Chrome first (the extension is a Chrome MV3 extension, so a tab in Edge answers nobody), and a private profile makes the browser an instance of its own. |
| `bin/aipass.mjs` | CLI dispatcher (`aipass dev\|agent\|models\|status\|stop\|…`); everything but `dev` auto-starts a detached bridge — and the BRIDGE writes `~/.aipass/bridge.pid` when it binds, which is the file `aipass stop` reads. Install via `install.sh` / `install.ps1`. |
| `chat.mjs`, `agent.mjs`, `list.mjs`, `stats.mjs`, `doctor.mjs`, `setup-assistant.mjs`, `assistant-prompt.mjs`, `difflib.mjs`, `providers.mjs` | terminal clients and helpers. `providers.mjs` is the registry from the terminal (`aipass providers list|add|remove|use|test`). |

The full internals reference is `aipass-bridge/docs/DOCS.md` — job hub,
extension contexts, TUI mechanics, WAF encoding, HTTP API, end-to-end trace.
Read it before non-trivial bridge changes, and keep it current with them.

## Invariants here

- **One-message constraint**: the upstream endpoint rejects assistant turns in
  `messages` and agent-style system prompts; `lastUserText()` forwards only the
  newest user message; multi-turn is server-side history. `agent.mjs` sends its
  preamble once into a fresh conversation, then only tool results.
- **Conversation rotation** (`resolveConversation`, `startChat`): reuse the
  most recent (or just-created) conversation; on `404` (deleted) / `409`
  (generation still running) advance to the next-most-recent — but only when no
  deltas were delivered yet and `AIPASS_CONVERSATION_ID` isn't pinned. A
  nameless send never resolves into a *temporary* conversation: those belong
  to the session that minted them, which names them per send.
- **turbo-stream**: the app's `.data` loaders return react-router turbo-stream (a flat
  indexed pool). `decodeTurboStream()` in `server.mjs` reads it; `encodeTurboStream()`
  in `test/harness.mjs` builds fixtures the same way. Keep the pair in sync.
- **Job lifecycle**: `delta` → flush → `done|fail|abort`; nothing reaches the consumer after settle.
- **SSE replay**: sequence numbers are monotonic; a reconnect with `since` must
  never receive a duplicate frame; the window is bounded by count and bytes.
- **Async discipline**: nothing under `bridge/` or `harness/` may block the event loop — the backend serves every window call.
- **A background process ends itself.** The bridge is started DETACHED, so it
  outlives whatever started it — and one that outlives every way of reaching
  it is a leak, not a service. It records its own pid when it binds, and exits
  once nobody has used it for `AIPASS_BRIDGE_IDLE_MS` (10 minutes; a bridge in
  use is never idle).
  Verify: "a bridge nobody is using goes away, and takes its pid file with it"
  Verify: "the bridge records its own pid, and the file names the process that is answering"
- **WAF symmetry** (root rule 4): `outbound()` rewrites trigger tokens before
  anything is sent (`localhost`→`LCLHST`, tag-opening `<`→`TAG-LT`,
  `process.env`→`PROCESS-ENV`, `.env`→`DOT-ENV`, SSRF IPs, …) and `inbound()`
  restores everything read back, so bytes written to disk are exactly the file's.
- **`sayResilient()`**: on a 403 the chain is `redact()` → a **shorter** copy
  of a big message (the run's next step must happen) → the identical message
  waited out (`EDGE_WAITS_MS`, a pace refusal) → the message halved and resent
  (down to ~300 bytes). A small message is never shortened (that is the pace
  case), and neither is the run's first message — it carries the protocol. The
  client says on every send that it rewrites a refusal, so the extension hands
  the refusal back at once instead of probing the same bytes for 75 seconds
  first. A provider client sets `waf = false`, so its 403 is a permission error.
  Verify: "a refused big message is sent again, shorter, so the run continues"
  Verify: "a refusal is handed back at once to a client that rewrites the message"
- **A provider client owns the history.** de.aipass.net keeps the conversation
  and takes one user message per request; an API provider is given the whole
  list, so `provider-client.mjs` keeps one array per conversation id.
- **A grant is not a permanent yes.** The user's own path rules and the secret
  floor are checked BEFORE the remembered "always" grants: a `deny` rule
  written later wins, and a secret file stays denied in every mode.
  Verify: "a grant does not outlive the rule that came after it, and never reaches a secret file"
- **A session id is matched whole, and belongs to one project.** The file is
  `session-<id>.jsonl` and the id is the whole name — a substring match made
  `session.delete {id:"a"}` land on whichever session came first. The lookup is
  scoped to the caller's project: a live one keeps its own sessions, and one
  whose folder moved still opens by id.
  Verify: "a short session id does not delete a session"
  Verify: "a session of another project is not opened, renamed or deleted"
  Verify: "a session whose project moved still opens by id, and a live one does not"
- **The settings file is read again before it is written.** It is shared by the
  window, the CLI and the backend, and two of them can write it: a save that
  merged into a stale copy wrote every other key back, undoing the other's change.
  Verify: "a save does not undo the change another surface made"
- **An attachment rides the message it was sent with.** The parts belong to the
  first message of the RUN, not to the first run of the session: gated on the
  session, the picture was encoded and dropped, and the model never saw it.
  Verify: "an attachment rides the first message of every run, not only the first of the session"
- **A file that is not there is a 404, not a crash.** The window's files are
  served from disk while the backend runs, and the content update replaces that
  tree under it: a throw there is an unhandled rejection that ends the backend.
  Verify: "a UI file that is gone is a 404, and the backend lives through it"
- **A relative path is relative to the project.** `/file src/app.js` and the
  window's file panel mean "the file in the project I am looking at".
  Verify: "a relative attachment path is relative to the project, not to the backend"
- **The overlay FS**: edits land in an in-memory Map so the model can read back its
  own pending work; apply flushes to disk. `EDIT` refuses a non-unique `FIND`.
- **The agent's marker protocol**: actions are prose lines, one per line —
  `NEED dir <p>`, `NEED file <p> [a-b]`, `SEARCH <text>`, `EDIT <p>` /
  `FIND` / `NEW` / `END`, `CREATE <p>` / `END`, `RUN` / `END` (needs
  `--allow-run`), `ATTACH`, `DONE <summary>`. ATTACH rides the *next* message —
  a DONE in the same reply drops it. `--slim` / `--assistant <id>` drop the
  preamble; `--watch` keeps the conversation open.

## Environment variables (working reference)

Bridge: `AIPASS_PORT` (8787), `AIPASS_HOST` (127.0.0.1 — any other bind exits unless `AIPASS_ALLOW_REMOTE=1`), `AIPASS_MODEL`, `AIPASS_MODELS` (fallback list with no extension attached), `AIPASS_MODEL_FILTER` (`chat`|`all`), `AIPASS_TOOL_VISIBILITY` (`reasoning`|`text`|`off`), `AIPASS_CONVERSATION_ID` (pin one), `AIPASS_IDLE_TIMEOUT_MS` (180000), `AIPASS_BRIDGE_IDLE_MS` (600000 — how long a bridge may sit unused before it ends itself; 0 keeps it for ever), `AIPASS_ASSISTANT_ID` / `AIPASS_ASSISTANT_FIELD`, `AIPASS_CORS_ORIGIN` (off by default), `AIPASS_KEEPALIVE_MS` (15000).

Loopback auth: `AIPASS_TOKEN` (explicit — containers, tests), `AIPASS_REQUIRE_AUTH=0` (escape hatch; warns at every boot).

Harness and clients: `AIPASS_HOME` (state dir), `AIPASS_BRIDGE` (bridge URL), `AIPASS_SKILLS_DIR`, `AIPASS_FETCH_ALLOW_PRIVATE`, `AIPASS_FETCH_MAX_BYTES`, `AIPASS_SPILL_KEEP` (spill files kept per project, 200), `AIPASS_ELIDE` (elision tier on — off by default), `AIPASS_MEMORY` (`off` stops carrying facts across rotations), `AIPASS_LOG_MAX_BYTES` (log rotation cap, 5 MB), `AIPASS_LOG_FORMAT=json`, `AIPASS_BROWSER_PROFILE` / `AIPASS_BROWSER_PIDFILE` (the suite's own browser — set by `scripts/test.mjs`, not by a person), `AIPASS_BRIDGE_PIDFILE` (where the bridge records its pid, so the bridge the suite started is reachable at the end).

Desktop: `AIPASS_DESKTOP_PORT` (8790), `AIPASS_DESKTOP_NO_OPEN`.
