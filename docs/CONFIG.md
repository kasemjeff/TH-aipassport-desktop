# Configuration catalog

Every switch this product reads from the world outside its code, and the
default each one carries.

Three families, one file. **Environment variables** are set before a process
starts and are read once at boot (the pacing ladders re-read their
overrides per call); **settings keys** live in `~/.aipass/settings.json` and
are what the window's Settings sheet edits (`harness/settings.mjs#DEFAULTS`);
**harness options** are the sheet one run is built from
(`harness/settings.mjs#HARNESS_OPTION_DEFAULTS`) — the settings file seeds
them and a run's caller narrows or widens on top.

**This catalog is a contract, not a description.**
`aipass-bridge/test/config-catalog.test.mjs` scans the product sources
(`bin/`, `bridge/`, `harness/`, `deploy/`, `scripts/`) for every
`AIPASS_*` env read and holds the tables below equal to that scan in both
directions; the settings and harness-option tables are held equal to
`DEFAULTS` and `HARNESS_OPTION_DEFAULTS` the same way. A knob renamed or
added without this file fails the suite, and so does a row whose knob nobody
reads. A name that appears only in comments is not a knob — those are the
drift this file exists to catch.

## Environment variables — the backend and the harness

| variable | default | what it does | read in |
|---|---|---|---|
| `AIPASS_HOME` | `~/.aipass` | where runtime state lives (sessions, logs, token, plugins); tests and containers point it elsewhere | `settings.mjs`, `launcher.mjs` |
| `AIPASS_TOKEN` | — | explicit loopback bearer token; skips the token file (containers, tests) | `authtoken.mjs` |
| `AIPASS_REQUIRE_AUTH` | on | `0` turns loopback auth off — an escape hatch that warns at boot, for tests | `authtoken.mjs` |
| `AIPASS_ALLOW_REMOTE` | off | `1` lets the backend (and the bridge's admin routes) answer non-loopback callers, deliberately | `rpc.mjs` |
| `AIPASS_BRIDGE` | `http://127.0.0.1:8787` | where the harness finds the bridge | `bridge.mjs` |
| `AIPASS_BRIDGE_PIDFILE` | `~/.aipass/bridge.pid` | where the bridge records its pid | `bridge-pid.mjs` |
| `AIPASS_PORT` | `8787` | the bridge's port | `bin/aipass.mjs` |
| `AIPASS_HOST` | `127.0.0.1` | the bridge's bind host | `bin/aipass.mjs` |
| `AIPASS_DESKTOP_PORT` | `8790` | the desktop backend's port; the launcher refuses a non-port value | `desktop-rpc.mjs`, `launcher.mjs` |
| `AIPASS_DESKTOP_NO_OPEN` | off | set: the launcher does not open the window itself | `launcher.mjs` |
| `AIPASS_SHELL_VERSION` | — | the packaged shell's version, set by the desktop launcher and reported in `/status` | `rpc/core.mjs`, `update.mjs` |
| `AIPASS_CONTENT_SOURCE` | `bundle` | what the running content is: `bundle` or `repo` | `rpc/core.mjs` |
| `AIPASS_LOG_FORMAT` | text | `json` turns log lines structured, with the HTTP exchange named | `log-line.mjs` |
| `AIPASS_LOG_MAX_BYTES` | `5242880` | the log file's rotation cap | `log-file.mjs` |
| `AIPASS_MAX_SESSION_BYTES` | `67108864` | one session file's size ceiling | `session.mjs` |
| `AIPASS_CONTEXT_TOKENS` | per-model map | the compaction budget, in the estimator's tokens | `compact.mjs` |
| `AIPASS_KEEP_RECENT_BYTES` | `6000` | compaction: recent entries kept verbatim under the rotation | `compact.mjs` |
| `AIPASS_COMPACT_AT_PERCENT` | `40` | rotate at this share of the budget, instead of the setting | `compact.mjs` |
| `AIPASS_ELIDE` | off | the elision tier (stale bulky sends cut to stubs) | `compact.mjs` |
| `AIPASS_MEMORY` | on | `off` stops the memory-tier carry across rotations | `compact.mjs` |
| `AIPASS_MEMORY_BUDGET` | `2400` | the char budget for the facts a session's first message carries | `memory-store.mjs` |
| `AIPASS_RETRIEVAL_MAX_FILES` | `5000` | the retrieval index's file cap | `retrieval.mjs` |
| `AIPASS_RETRIEVAL_MAX_CHUNKS` | `20000` | the retrieval index's chunk cap | `retrieval.mjs` |
| `AIPASS_RETRIEVAL_BUDGET` | `6000` | the char budget for a RETRIEVE answer | `retrieval.mjs` |
| `AIPASS_INSTRUCTIONS` | on | `off` stops the project's own instruction file (AGENTS.md / CLAUDE.md / GEMINI.md) from riding a run's first message | `instructions.mjs` |
| `AIPASS_INSTRUCTIONS_MAX_BYTES` | `8000` | the byte cap on the project instruction file pasted into turn 1 | `instructions.mjs` |
| `AIPASS_SPILL_KEEP` | `200` | how many spill files are kept before pruning | `tools.mjs` |
| `AIPASS_SPILL_PRUNE_EVERY` | `25` | prune the spill dir every this-many appends | `tools.mjs` |
| `AIPASS_SANDBOX_MAX_FILE_MB` | `64` | the projection's per-file copy cap | `sandbox.mjs` |
| `AIPASS_FETCH_MAX_BYTES` | `2000000` | the largest body a model-chosen fetch may read | `tools.mjs` |
| `AIPASS_FETCH_ALLOW_PRIVATE` | off | `1` lifts the private-host deny for fetch and media (a check against a local server) | `tools.mjs`, `media.mjs` |
| `AIPASS_MEDIA_TIMEOUT_MS` | computed | the media generation's wait | `media.mjs` |
| `AIPASS_SEND_RETRY_MS` | `1000` | the send retry cadence the bridge client retries on | `bridge.mjs` |
| `AIPASS_EDGE_WAITS_MS` | `60000,180000` | the 403 content ladder's waits, comma-separated | `bridge.mjs` |
| `AIPASS_RATE_WAITS_MS` | `60000,180000` | the 429/503 ladder's waits, comma-separated | `bridge.mjs` |
| `AIPASS_RECOVER_WAITS_MS` | built-in ladder | the loop's own send-recovery waits, comma-separated | `bridge.mjs` |
| `AIPASS_RATE_BUCKET` | `4,45000` | the send token bucket `capacity,refillMs`, or `off` | `bridge.mjs` |
| `AIPASS_PROVIDER_MODELS_TIMEOUT_MS` | computed | the provider model-list fetch timeout | `provider-client.mjs` |
| `AIPASS_POLICY_DIR` | `~/.aipass/harness/policy` | where the meta policy documents live | `meta/policy.mjs` |
| `AIPASS_UPDATE_FEED` | shipped URL | the signed update feed | `update.mjs` |
| `AIPASS_BROWSER_PROFILE` | temp dir | the coverage gate's browser profile (scripts) | `scripts/coverage-gate.mjs` |
| `AIPASS_BROWSER_PIDFILE` | temp file | the coverage gate's browser pid file (scripts) | `scripts/coverage-gate.mjs` |
| `AIPASS_TEST_TIMEOUT_MS` | `1200000` on Windows | the suite's per-test timeout | `scripts/test.mjs` |

## Environment variables — the bridge

| variable | default | what it does | read in |
|---|---|---|---|
| `AIPASS_ADMIN` | off | `1` turns the admin routes on (they restart processes) | `bridge/server.mjs` |
| `AIPASS_ALLOWED_HOSTS` | — | extra hosts the bridge will serve besides the site itself | `bridge/server.mjs` |
| `AIPASS_ALLOW_INSECURE_DEFAULT_PORT` | off | `1` allows auth-off on the default port, which the bridge refuses by default | `bridge/server.mjs` |
| `AIPASS_CORS_ORIGIN` | — | one extra origin the bridge answers cross-origin | `bridge/server.mjs` |
| `AIPASS_IDLE_TIMEOUT_MS` | `180000` | a job's idle clock in the bridge | `bridge/server.mjs` |
| `AIPASS_BRIDGE_IDLE_MS` | `600000` | the bridge exits itself when nothing uses it; `0` never exits | `bridge/server.mjs` |
| `AIPASS_DISPATCH_GRACE_MS` | `5000` | the wait for a tab to appear before a dispatch refusal | `bridge/server.mjs` |
| `AIPASS_KEEPALIVE_MS` | `15000` | the SSE keepalive cadence | `bridge/server.mjs` |
| `AIPASS_MODEL` | `gemini-3.1-flash-lite` | the bridge's default model | `bridge/server.mjs` |
| `AIPASS_MODELS` | two-model stub | the fallback catalog when no tab can be reached | `bridge/server.mjs` |
| `AIPASS_MODEL_FILTER` | `all` | `chat` narrows `/v1/models` to text-drivable models | `bridge/server.mjs` |
| `AIPASS_MODEL_RETRY_MS` | `30000` | the catalog refresh retry cadence; `0` turns it off | `bridge/server.mjs` |
| `AIPASS_TOOL_VISIBILITY` | `reasoning` | where tool activity shows in the transcript echo | `bridge/server.mjs` |
| `AIPASS_CONVERSATION_ID` | — | a conversation pinned for the bridge's lifetime | `bridge/server.mjs` |
| `AIPASS_ASSISTANT_ID` | `''` | the assistant persona the page runs as | `bridge/server.mjs` |
| `AIPASS_ASSISTANT_FIELD` | `aiAssistantId` | where that persona id rides in the page's data | `bridge/server.mjs` |
| `AIPASS_ASPECT_RATIO` | `1:1` | the media generation's default ratio | `bridge/server.mjs` |

## Environment variables — build and release

| variable | default | what it does | read in |
|---|---|---|---|
| `AIPASS_DESKTOP_TARGET` | host's own | the desktop build target (`universal-apple-darwin`, …) | `scripts/build-desktop.mjs` |
| `AIPASS_TAURI_CLI` | found on PATH | names the tauri binary the build runs | `scripts/build-desktop.mjs` |
| `AIPASS_RELEASE_KEY` | — | the ed25519 private key that signs an update feed | `scripts/build-update-feed.mjs` |
| `AIPASS_RELEASE_KEY_ID` | — | the key id recorded beside the signature | `scripts/build-update-feed.mjs` |
| `AIPASS_RELEASE_NOTES` | — | the notes carried into a release pack | `scripts/build-update-feed.mjs` |
| `AIPASS_RELEASE_SEQUENCE` | last + 1 | the feed's monotonic sequence number | `scripts/build-update-feed.mjs` |

## Settings keys (`~/.aipass/settings.json`)

| key | default | what it does |
|---|---|---|
| `defaultModel` | `null` | the model a new run starts on |
| `defaultProvider` | `aipass` | which provider the runs talk to |
| `mode` | `ask` | who may write: `ask` / `auto` / `yolo` |
| `allowRun` | `false` | may the model reach the shell |
| `allowGitWrite` | `false` | may the model stage, commit, branch |
| `allowVerify` | `false` | may the model ask for a check (VERIFY) |
| `sandbox` | `off` | the sandbox a RUN runs in: `off` / `read-only` / `workspace-write` / `danger-full-access` |
| `allowFetch` | `false` | may the model send data out |
| `maxSteps` | `0` | the step cap; 0 = no cap |
| `maxToolCalls` | shipped | the per-run tool-call budget |
| `maxWallClockMs` | shipped | the per-run wall-clock budget |
| `maxCredits` | `0` | the optional credit cap; 0 = off |
| `plan` | `false` | plan mode |
| `requirePlanApproval` | `false` | wait for a human before the work starts |
| `subagent` | `true` | may the run call a helper |
| `parallelHelpers` | `true` | may helpers run beside each other |
| `parallelReads` | `true` | may consecutive reads run beside each other |
| `thinking` | `low` | how hard the model thinks: off/low/medium/high/max |
| `temperature` | `null` | 0..2, or null for the site's own |
| `replyLanguage` | `th` | the language the reply is in |
| `langCheck` | `true` | measure the closing message's Thai share |
| `minThaiRatio` | `0.4` | the share asked for |
| `repeatGuard` | `true` | refuse an identical call with nothing staged |
| `repeatGuardMax` | `4` | refusals one run may collect before it stalls |
| `attempts` | `1` | re-runs while the checker still reports fail |
| `verifyCommand` | `null` | the declared check, replacing `.aipass/check.txt` |
| `requireCheck` | `false` | the strict gate: refuse a DONE over a failing check |
| `maxResult` | `3000` | per-tool result cap in bytes; the rest spills to disk, and a spill read obeys the same cap (line-bounded) |
| `compaction` | shipped | the context budget object (tokens, reserve, keep, per-model) |
| `compactAtPercent` | `40` | rotate at this share of the budget |
| `skillsDirs` | `[]` | extra playbooks folders, first match wins |
| `projects` | `[]` | the projects the window offers |
| `root` | `null` | the root a new backend starts on |
| `plugins` | `[]` | which plugins load, by name |
| `rules` | `[]` | permission path rules, checked before the mode |
| `theme` | `dark` | the window's theme |
| `chatUrl` | shipped | where the chat tab lives |
| `autoOpenTab` | `true` | may a run open the tab it needs |
| `searchI` | `false` | the case-insensitive SEARCH in the preamble |
| `attach` | `false` | the ATTACH marker in the preamble |
| `webScratch` | `false` | web lookups in a throwaway conversation |
| `uploads` | `null` | where staged uploads wait |
| `hooks` | shipped | the person's own commands (nine moments, `sessionStart` … `stop`) |
| `recall` | `true` | may the model look into this project's past (RECALL) |
| `retrieve` | `true` | may the preamble teach RETRIEVE (ranked passages from the project index) |
| `diagnose` | `true` | may the preamble teach DIAGNOSE (language-server diagnostics) |
| `diagnose` | `true` | may the model ask a language server for diagnostics (DIAGNOSE) |
| `explore` | `true` | may the preamble teach TREE/STAT |
| `helperPresets` | `{}` | the machine's own SUBAGENT roles: name → { lead, run }, beside the built-ins |

## Harness options (one run's sheet)

| option | default | what it does |
|---|---|---|
| `model` | `null` | the model this run sends on |
| `maxSteps` | `0` | the step cap; 0 = no cap |
| `maxToolCalls` | shipped | the per-run tool-call budget |
| `maxWallClockMs` | shipped | the per-run wall-clock budget |
| `maxCredits` | `0` | the optional credit cap; 0 = off |
| `mode` | `ask` | the permission mode |
| `allowRun` | `false` | may this run reach the shell |
| `allowFetch` | `false` | may this run send data out |
| `allowGitWrite` | `false` | may this run stage, commit, branch |
| `allowVerify` | `false` | may this run ask for a check (VERIFY) |
| `sandbox` | `off` | the sandbox mode for this run: `off` / `read-only` / `workspace-write` / `danger-full-access` |
| `plan` | `false` | plan mode |
| `requirePlanApproval` | `false` | wait for a human before the work starts |
| `subagent` | `false` | may the run call a helper |
| `parallelHelpers` | `false` | may helpers run beside each other |
| `parallelReads` | `true` | may consecutive reads run beside each other |
| `searchI` | `false` | the case-insensitive SEARCH in the preamble |
| `attach` | `false` | the ATTACH marker in the preamble |
| `webScratch` | `false` | web lookups in a throwaway conversation |
| `recall` | `true` | may the model look into this project's past (RECALL) |
| `retrieve` | `true` | may the preamble teach RETRIEVE (ranked passages from the project index) |
| `diagnose` | `true` | may the preamble teach DIAGNOSE (language-server diagnostics) |
| `diagnose` | `true` | may the model ask a language server for diagnostics (DIAGNOSE) |
| `review` | `false` | a review run: read a change, stage nothing |
| `reviewBase` | `null` | the base ref a review run reads against |
| `explore` | `true` | may the preamble teach TREE/STAT |
| `pluginSections` | `[]` | what plugins contribute to the turn-1 message |
| `helperPresets` | `{}` | the machine's own helper roles beside the built-ins |
| `conversation` | `null` | the conversation this run sends into |
| `reuse` | `false` | reuse the bridge's own conversation pointer |
| `permanent` | `false` | keep the conversation afterwards |
| `assistant` | `null` | the assistant persona |
| `verifyCommand` | `null` | the declared check, replacing `.aipass/check.txt` |
| `requireCheck` | `false` | the strict gate: refuse a DONE over a failing check |
| `thinking` | `null` | how hard the model thinks: off/low/medium/high/max |
| `temperature` | `null` | 0..2, or null for the site's own |
| `replyLanguage` | `th` | the language the reply is in |
| `langCheck` | `false` | measure the closing message's Thai share |
| `minThaiRatio` | `0.4` | the share asked for |
| `repeatGuard` | `false` | refuse an identical call with nothing staged |
| `repeatGuardMax` | `4` | refusals one run may collect before it stalls |
| `slim` | `false` | the compact first message |
| `seedText` | `null` | a rotation's seed, replacing the composed first message |
| `pluginTools` | `[]` | the plugin markers this run may use |
| `signal` | `null` | the run's stop switch |
| `parts` | `null` | the attachments of the first send |
