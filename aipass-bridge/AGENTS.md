# AGENTS.md — aipass-bridge

> Local law for everything under `aipass-bridge/`. Read `../AGENTS.md` first.
> Verify: `npm test` from the repo root; one file at a time:
> `node --test aipass-bridge/test/<name>.test.mjs`.

## Module map

| path | role |
|---|---|
| `bridge/server.mjs` | HTTP API on `127.0.0.1:8787`, the job hub, SSE `/ext/events` (jobs out) and `/ext/{chunk,done,error,loader}` (results in). Job kinds: `chat`, `loader`, `create`. The idle timeout resets on every delta; an extension disconnecting mid-job does **not** fail it — the upstream fetch lives in the page and survives MV3 worker eviction. Deltas buffer ~25 ms and merge adjacent text before flush; the buffer flushes before done/fail/abort. Cache-warm loaders run once per process on first extension connect. |
| `bridge/private-hosts.mjs` | SSRF guard: private ranges + a short-TTL DNS cache (errors are never cached). |
| `extension/background.js` | MV3 worker; holds the SSE connection (mixed-content/PNA reasons). |
| `extension/content.js` / `page.js` | ISOLATED ⇄ MAIN worlds. `page.js` does `fetch(credentials:'include')` as first-party page JS, refuses any loader path not matching `^/loaders/…`, and the tool set is exactly `{chat, loader, create}` — no arbitrary-URL forwarding even if the bridge is compromised. |
| `harness/loop.mjs` | runs the model loop; dispatches tools as `await tools[call.kind](…)` (the tools are async); guards: steps, wall clock, `maxCredits`, R1 stagnation. |
| `harness/harness.mjs` | assembles a run; the DONE checker (see `../docs/SPEC_CHECKER.md`). |
| `harness/rpc.mjs` | desktop backend: `/rpc`, `/events` SSE with a bounded replay buffer (count + bytes, frames precomputed), fs list/read (async), permission answers. The `needs_tab` listener hangs off the shared event bus so autoOpenTab works in every project. |
| `harness/tools.mjs` | the marker tools (NEED/SEARCH/EDIT/CREATE/RUN/ATTACH/…). Async I/O only; staged `.mjs` writes are syntax-checked via spawn; long results spill to `.aipass/spill/`. |
| `harness/overlay.mjs` | pending-writes map; `diskText`/`changeFor` memoized on mtime+size. |
| `harness/sandbox.mjs` | `materializeTree`: async, gated parallel copies, heavy dirs junctioned, `.git` never projected (a boundary marker is written instead). |
| `harness/session.mjs` | session JSONL: append-only, padded fixed-width header (2048 B) rewritten in place, `HEADER_EVERY = 25` batches the rewrite. |
| `harness/protocol.mjs` | marker grammar; compiled regexes cached. `harness/compact.mjs` compacts context. `harness/waf.mjs` is the substitution table. |
| `harness/authtoken.mjs` | mint/cache `~/.aipass/.token` (memo revalidated on mtime+size). |
| `harness/providers.mjs` | the provider registry: the specs (`~/.aipass/providers.json`) and the keys (`~/.aipass/credentials.json`, owner-only; an env var named by a spec wins). `harness/provider-client.mjs` is the other half — the OpenAI-compatible and Anthropic adapters that answer the same client contract as the bridge. A provider is a swap, not a second loop. |
| `harness/permissions.mjs`, `rules.mjs`, `plugins.mjs`, `skills.mjs`, `settings.mjs`, `events.mjs`, `log-file.mjs`, `log-line.mjs`, `argguard.mjs`, `gitignore.mjs`, `bridge.mjs`, `lang.mjs` | supporting systems; the deep reference is `docs/DOCS.md` (below). |
| `bin/aipass.mjs` | CLI dispatcher (`aipass dev\|agent\|models\|status\|stop\|…`); everything but `dev` auto-starts a detached bridge and writes `~/.aipass/bridge.pid` — that is the file `aipass stop` reads. Install via `install.sh` / `install.ps1`. |
| `chat.mjs`, `agent.mjs`, `list.mjs`, `stats.mjs`, `doctor.mjs`, `setup-assistant.mjs`, `assistant-prompt.mjs`, `difflib.mjs`, `providers.mjs` | terminal clients and helpers. `providers.mjs` is the registry from the terminal (`aipass providers list|add|remove|use|test`). |

The full internals reference is `aipass-bridge/docs/DOCS.md` — job hub,
extension contexts, TUI mechanics, WAF encoding, HTTP API, end-to-end trace.
Read it before non-trivial bridge changes and keep it current with them.

## Invariants here

- **One-message constraint**: the upstream endpoint rejects assistant turns in
  `messages` and agent-style system prompts; `lastUserText()` forwards only the
  newest user message; multi-turn is server-side history. `agent.mjs` sends
  its instruction preamble once into a fresh conversation and then only tool
  results.
- **Conversation rotation** (`resolveConversation`, `startChat`): reuse the
  most recent (or just-created) conversation; on `404` (deleted) / `409`
  (generation still running) advance to the next-most-recent — but only when
  no deltas were delivered yet and `AIPASS_CONVERSATION_ID` isn't pinned. A
  nameless send never resolves into a *temporary* conversation: those are the
  private space of the session that minted them, which names them per send.
- **turbo-stream**: the app's `.data` loaders return react-router turbo-stream
  (a flat indexed pool). `decodeTurboStream()` in `server.mjs` reads it;
  `encodeTurboStream()` in `test/harness.mjs` builds fixtures the same way.
  Keep the pair in sync.
- **Job lifecycle**: `delta` → flush → `done|fail|abort`; nothing reaches the
  consumer after settle, and the delta buffer always flushes before settling
  (retry semantics depend on which parts were delivered).
- **SSE replay**: sequence numbers are monotonic; a reconnect with `since`
  must never receive a duplicate frame; the window is bounded by count and
  bytes.
- **Async discipline**: nothing under `bridge/` or `harness/` may block the
  event loop on IO-bound work — the backend process serves every window call.
- **WAF symmetry** (root rule 4): `outbound()` rewrites trigger tokens before
  anything is sent (`localhost`→`LCLHST`, tag-opening `<`→`TAG-LT`,
  `process.env`→`PROCESS-ENV`, `.env`→`DOT-ENV`, SSRF IPs, …) and `inbound()`
  restores everything read back — including the model's own actions — so bytes
  written to disk are exactly the file's.
- **`sayResilient()`**: on a 403, halve the message and resend the halves in
  order (recursively, down to ~300 bytes); last resort `redact()` blanks lines
  matching `RISKY_LINE`. Tool results are capped at `--max-result` bytes.
  Both the WAF encoding and that rewrite chain are the AiPASS edge's own: a
  provider client sets `waf = false`, so its bytes go out as they are and its
  403 is a permission error, not a payload to split.
- **A provider client owns the history.** de.aipass.net keeps the conversation
  and takes one user message per request; an API provider is given the whole
  list, so `harness/provider-client.mjs` keeps one array per conversation id —
  the same id the harness already passes around.
- **Overlay FS**: edits land in an in-memory Map so the model can read back its
  own pending work; apply flushes to disk. `EDIT` refuses a `FIND` block that
  isn't unique.
- **The agent's marker protocol**: actions are prose lines, one per line —
  `NEED dir <p>`, `NEED file <p> [a-b]`, `SEARCH <text>`, `EDIT <p>` /
  `FIND` / `NEW` / `END`, `CREATE <p>` / `END`, `RUN` / `END` (needs
  `--allow-run`), `ATTACH`, `DONE <summary>`. ATTACH rides the *next* message —
  a DONE in the same reply drops it. `--slim` / `--assistant <id>` drop the
  preamble for a custom assistant; `--watch` keeps the conversation open.

## Environment variables (working reference)

Bridge: `AIPASS_PORT` (8787), `AIPASS_HOST` (127.0.0.1 — any other bind exits
unless `AIPASS_ALLOW_REMOTE=1`), `AIPASS_MODEL`, `AIPASS_MODELS` (fallback list
with no extension attached), `AIPASS_MODEL_FILTER` (`chat`|`all`),
`AIPASS_TOOL_VISIBILITY` (`reasoning`|`text`|`off`), `AIPASS_CONVERSATION_ID`
(pin one), `AIPASS_IDLE_TIMEOUT_MS` (180000), `AIPASS_ASSISTANT_ID` /
`AIPASS_ASSISTANT_FIELD`, `AIPASS_CORS_ORIGIN` (off by default),
`AIPASS_KEEPALIVE_MS` (15000).

Loopback auth: `AIPASS_TOKEN` (explicit — containers, tests),
`AIPASS_REQUIRE_AUTH=0` (escape hatch; warns at every boot).

Harness and clients: `AIPASS_HOME` (state dir), `AIPASS_BRIDGE` (bridge URL),
`AIPASS_SKILLS_DIR`, `AIPASS_FETCH_ALLOW_PRIVATE`, `AIPASS_FETCH_MAX_BYTES`,
`AIPASS_SPILL_KEEP` (spill files kept per project, 200),
`AIPASS_ELIDE` (elision tier on — off by default),
`AIPASS_MEMORY` (`off` stops carrying facts across rotations),
`AIPASS_LOG_MAX_BYTES` (log rotation cap, 5 MB), `AIPASS_LOG_FORMAT=json`.

Desktop: `AIPASS_DESKTOP_PORT` (8790), `AIPASS_DESKTOP_NO_OPEN`.
