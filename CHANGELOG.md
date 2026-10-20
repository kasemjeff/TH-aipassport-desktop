# Changelog

What changed, in behavior terms — not a file-by-file log. The release
procedure, acceptance criteria and rollback live in [`docs/RELEASE.md`](docs/RELEASE.md).

## [Unreleased]

### Added

- **A plugin can be installed from a repository or a package.** The install box
  and `aipass plugin install` now take `github:owner/repo#ref`,
  `git+https://…`/`git+ssh://…` and `npm:<package>` beside a path and an
  `https://` URL. Fetching is not running: git is cloned shallow and npm is
  installed with `--ignore-scripts`, so no package script runs before the
  person says yes, and the hash of the entry file is checked again at install
  time — a branch that moved since the report is refused. The registry records
  the spec, so `aipass plugin update` re-fetches it
  (`harness/install.mjs`, `test/install.test.mjs`).
- **A refused install says which step closed the door.** The installer tags
  each failure with the step it happened in (plan, fetch, validate, name,
  swap, finalize), the RPC carries it, and the window shows it next to the
  error — so a box that says "err" now says *what* failed, and the install box
  says what it is doing while it works
  (`harness/install.mjs`, `harness/rpc.mjs`, `harness/desktop-rpc.mjs`,
  `desktop/ui/app.js`, `test/ui.test.mjs`).
- **The desktop can talk to another provider.** The window now has a provider
  switch next to the model picker: AiPASS (the local bridge and its tab) stays
  the default, and an OpenAI-compatible or Anthropic endpoint can be added
  beside it. The specs live in `~/.aipass/providers.json` and the keys in
  `~/.aipass/credentials.json` (owner-only) or an environment variable — never
  in `settings.json`. The switch is machine-wide, so the terminal sees it too:
  `aipass providers list|add|remove|use|test`, and `agent.mjs --provider <id>`
  for one run. A provider is a swap, not a second loop — it answers the same
  client contract as the bridge, keeps the conversation history the AiPASS
  edge would have kept, and gets the bytes as they are: the WAF table is that
  edge's own, so another provider's text is never encoded for a firewall that
  is not there
  (`harness/providers.mjs`, `harness/provider-client.mjs`, `providers.mjs`,
  `test/providers.test.mjs`).
- **DONE can be held to the check.** `verifyCommand` names the one command a
  run's checker must treat as the declared check, so a verdict is comparable
  even before a project commits `.aipass/check.txt`; `requireCheck` makes a
  later DONE over a still-failing declared check terminal as
  `done-unverified` instead of accepting it. The default stays advisory, the
  first failure still earns its correction, and `run_stats` now records
  `checkCommand` and `doneUnverified` beside `checks`/`checkVerdict`
  (`harness/loop.mjs`, `harness/harness.mjs`, `test/checker.test.mjs`).
- **One shape check before every dispatch.** Built-in tools, plugins and MCP
  tools now pass through `validateCall()` first, so an empty `RUN`, a blank
  `NEED`/`SEARCH` or an uninstalled marker answers with the same `err: …`
  sentence instead of reaching an implementation that may throw
  (`harness/validate.mjs`, `test/validate.test.mjs`).
- **The desktop starts oriented.** Window-created harnesses turn the bootstrap
  snapshot on by default — git state and package scripts in turn 1 — while the
  CLI keeps `--snapshot` opt-in so its tuned bytes stay identical
  (`harness/rpc.mjs`, `test/desktop.test.mjs`).
- **Sends are paced before the edge refuses them.** `BridgeClient` carries a
  token bucket shared by the run, its helpers and the checker: four initial
  sends and one every 45 seconds, so a parallel burst waits briefly instead of
  drawing a 429 and then a long retry. `AIPASS_RATE_BUCKET` overrides it
  (`off` for the suite), and the tests pin the meter with an injected clock
  (`harness/bridge.mjs`, `test/rate-bucket.test.mjs`).
- **`aipass relocate` — moving a project (or a whole machine) keeps its
  history.** Sessions, cross-session memory, path rules and the project list
  are all keyed by a project's absolute path, so a home folder copied to a
  machine where the project lives somewhere new kept every byte and lost every
  connection: an empty picker, no facts, no rules. `harness/relocate.mjs`
  re-keys all four onto the new path — merging into whatever already lives
  there — and `aipass relocate <old> <new>` drives it, refusing while the
  desktop app is running (open sessions and the old paths live in its
  memory). The old folder does not need to exist anymore; the new one must.
  The restore drill now walks the cross-machine case end to end
  (`test/data-flow.test.mjs`, `test/restore-drill.test.mjs`).
- **Plugins install like software now.** `aipass plugin
  list|inspect|install|remove|enable|disable` and the settings sheet's
  ปลั๊กอิน section: inspect prints size + sha256 and executes nothing, install
  stages, validates with the real loader, then swaps — the previous version
  moves to `.trash/` and is never deleted, and a failed update leaves the old
  version live with the reason (`harness/install.mjs`,
  `test/install.test.mjs`). `.registry.json` records provenance (advisory —
  deleting it never blocks loading), an unmanaged file or folder needs an
  explicit `--force` to be replaced or removed, and the enabled-list rules are
  precise: the first ปิด materializes the list, disabling the last name writes
  the sentinel `(none)` so `[]` cannot read as "everything", and enabling
  collapses back only when every *known* name is covered
  (`test/plugins.test.mjs`). The window gained an install box (inspect →
  hash report → ติดตั้ง) and per-card เปิด/ปิด/ลบ
  (`test/desktop-window.test.mjs`, `test/ui.test.mjs`).
- **MCP servers got a lifecycle — and a gate.** `mcp.json` entries gain
  `enabled`, `risk` (default `"write"`) and `cwd`; `mcp.list` answers a status
  row per server (connected / error / disabled, tool count, risk);
  `mcp.add|remove|enable|disable|reload|test` exist over RPC, `aipass mcp
  add|test|enable|disable|remove` over the CLI, and the settings sheet grew a
  🔌 MCP section with per-row state and an add form matching the CLI's flags
  (`harness/mcp.mjs`, `test/mcp.test.mjs`). The hole it closes: MCP tools ran
  **ungated** — `risk: null` through `classify('plugin')` is `'read'`, i.e.
  pre-answered yes in every mode; a server's declared risk now reaches the
  same verdict a built-in would. `[ทดสอบ]` runs a command once and lists its
  tools before saving, env values mask after save and are never logged, and a
  bad command is a listed row with its error instead of a crash.
- **The CLIs talk to a running window.** `aipass plugin`/`aipass mcp` mutate
  through the live desktop backend when one is listening
  (`harness/desktop-rpc.mjs`) — a backend refusal is final — and edit the same
  files directly when none is, so an open sheet updates live and a stopped
  backend reads the change at its next start.
- **`aipass plugin update <name>` — and a trash that stays small.** Update
  re-reads the source recorded at install time (a path picks up edits in
  place), refuses a name the installer did not install — nothing was recorded
  to re-fetch — and repeats the whole install chain: inspect, hash, consent,
  stage, validate, swap. The enable state is left exactly where the person put
  it. Each swap keeps one previous copy per name in `.trash/`, pruning the
  generation before it, so repeated updates do not accumulate full copies of
  the folder (`harness/install.mjs`, `test/install.test.mjs`).
- **`aipass doctor` reads the local extension channels.** Two checks added:
  plugins that failed to load, named with `aipass plugin list` as the fix, and
  MCP servers — live rows when a desktop backend is running, or, without one,
  the enabled-config count marked "not tested" rather than silently skipped
  (`aipass-bridge/doctor.mjs`, `test/doctor.test.mjs`).
- **Session archive.** Projects that lived for months carried dozens of dead
  sessions in the picker (61 files in one project on this machine). Past 40
  sessions the picker shows a one-click archive: `session.archive` moves
  sessions idle 30+ days to `<project>/archive/` — nothing deleted, the live
  session always kept (`test/data-integrity.test.mjs`).
- **Health page in Settings.** The `🩺 สุขภาพ` section shows bridge /
  extension / tab / credits / build with the fix for whatever is red — the
  same answers as `aipass doctor`, without opening a terminal
  (`test/ui.test.mjs`).
- **Build version in the window.** `status()` carries `app` (the build that
  wrote the backend), shown in `/status` and the health page — a stale
  install reads as a version instead of a mystery.
- **An empty credit pool names itself.** The welcome card gains a fourth
  readiness row (credits available/limit) only when the quota is known: 0
  reads as "รอรอบถัดไป หรือใช้โมเดล free-credit" instead of a blank window,
  and quota errors map to the same Thai copy (`test/ui.test.mjs`).
- **Packaged resources are pinned by test.** A new CLI at
  `aipass-bridge/*.mjs` that nobody adds to `tauri.conf.json` used to ship a
  window whose command is missing — a test now fails until it is listed
  (`test/desktop.test.mjs`). The five missing CLIs (`mcp`, `memory`,
  `plugin`, `scale`, `setup`) are added.
- **The paint cache reports itself.** The window's streaming paint cache — a
  frame appends to the settled layer; only a rewrite (a plugin table landing
  late and hiding a marker line) resets it — now counts hits, misses, cold
  frames and the characters each side painted, and `/paint` prints them: "long
  answers feel slow" answers with a number instead of a shrug
  (`test/ui.test.mjs`).
- **The bridge's caches report themselves.** `/status` carries `cache` —  
  model-list, credit and conversation hits vs upstream fetches — and the
  window's `/status` prints the line when the backend offers it
  (`test/bridge.test.mjs`).
- **Tables, images and videos render in the window.** The markdown renderer
  only knew paragraphs, lists and code, so a table arrived as a wall of pipes
  and `![...]` stayed literal. Pipe tables now render with per-column
  alignment, a standalone image becomes a captioned figure, and a standalone
  video URL (or `![caption](clip.mp4)` / `[caption](clip.mp4)`) becomes a
  player. Media is limited to http(s) — never `javascript:` or `data:` — and
  the streaming split keeps a table (or a pipe line that might become one) in
  the repainting tail, so a settled paragraph is never rewritten into a table
  mid-stream (`test/ui-md.test.mjs`).

### Fixed

- **The test suite no longer writes into the real `~/.aipass`.** The
  cross-session memory store named its directory when the module loaded, so a
  suite that pointed `AIPASS_HOME` at a scratch home *after* that import still
  wrote there: one file per temp root (the file name is a hash of the project
  path), every run, and a developer's real store filled with hundreds of
  fixture facts that no project ever read back. The store now resolves its
  directory when it is used, the suite runner hands the whole run a scratch
  home of its own, and a pin asserts the store lands in the home it was given
  (`scripts/test.mjs`, `harness/memory-store.mjs`,
  `test/data-integrity.test.mjs`).

- **The suite no longer leaves scratch behind.** Two families of scratch grew
  with no sweep: the per-file home floor in `test/harness.mjs` (a directory per
  test file) and `tempDir()` (a directory per call) — 6,200 and 147,000
  directories, 165 MB in the temp directory over a week of runs. Both go when
  the process exits, through one hook rather than one per call (a per-call
  hook would trip Node's listener warning mid-suite), and the runner sweeps
  the scratch that earlier runs left behind — older than an hour, so a
  parallel session's in-flight run is never touched
  (`aipass-bridge/test/harness.mjs`, `scripts/test.mjs`).

- **The markers the preamble promises now run.** Three dead ends of the same
  shape — a feature written and never wired. `SYMBOLS`, `DEF`, `REFS` and
  `JOBS` were in the preamble, in the marker grammar and in the tool table,
  but the parser had no rule for them: a reply that used one lost the line
  (the grammar strips it from the prose) and produced no call at all, so the
  model was nudged about a marker it had spelled exactly right. A `SUBAGENT`
  with `background: true` answered `err: backgroundJobs is not defined` — the
  job table lived inside the run, while the function that starts a helper is a
  module-level one, so no helper could be polled and no result could ever be
  injected. And the spill locator named a line range guessed from the byte
  cap (80 characters a line): on long-lined files the guess pointed past lines
  the model had never seen, and the range it handed back skipped them for
  good. The code navigation is a marker-to-tool path again, a background
  helper starts, polls and lands its result in the next turn, and the locator
  starts where the head really ended
  (`harness/protocol.mjs`, `harness/loop.mjs`, `harness/tools.mjs`,
  `harness/symbols.mjs`, `desktop/ui/markers.js`, `test/symbols.test.mjs`,
  `test/protocol.test.mjs`, `test/harness-fixes.test.mjs`,
  `test/tools-aci.test.mjs`, `test/ui-markers.test.mjs`).

- **A playbook that exists is a playbook that runs.** The library's index was
  the folder's `index.md` — a person's prose — so a part added yesterday was
  invisible until someone remembered to edit that prose, and the terminal and
  the window disagreed about which library a name came from. The index is now
  the curated preamble *plus* the generated list of what is on disk, and one
  order serves every surface: the folders named in `skillsDirs`, then the
  project's own, then the user's, then the shipped one. The folders are read
  on every ask, so a part dropped in while the app is open shows up when the
  window comes back (`harness/skills.mjs`, `harness/rpc.mjs`,
  `desktop/ui/app.js`, `test/skills.test.mjs`).
- **The sandbox stopped pretending to be a wall.** Three holes, all measured:
  a command's OUTPUT was never screened for secrets (the command was screened
  for secret FILES, but `set` prints the whole environment — with any API key
  in it — straight into the transcript and upstream to the model); the
  containment check was a string prefix, so on Windows a path that differs
  only in case was refused as "outside project root" while a junction inside
  the project that pointed elsewhere was followed without a murmur; and the
  projection — a copy of the user's source, and of whatever secrets it holds
  — lived inside the project, where a `git add -A` could commit it. Now: the
  output is screened by token shape and by the name of the variable it
  carries (`harness/output-scrub.mjs`); the boundary is lexical
  (`path.relative`, the same fix `rpc.mjs` already had) AND physical (a link
  out of the project is a link out of the root); the projection lives under
  `~/.aipass/run/`, with a janitor that collects what a killed backend left
  behind; a link that points outside the project is left out of the
  projection; a file over the size cap is left out and named; and the heavy
  directories the projection SHARES with the real tree are named in the
  command's result, so a write into `node_modules` is never a surprise
  (`harness/output-scrub.mjs`, `harness/overlay.mjs`, `harness/sandbox.mjs`,
  `harness/tools.mjs`, `harness/harness.mjs`, `test/sandbox.test.mjs`).
- **The stop button stops the work, not just the conversation.** Pressing stop
  reached exactly one place: the next send, whose fetch rejected with an
  `AbortError`. Everything else carried on — the tools of the reply that was
  running went on one after another, a `RUN` kept its command and its process
  tree alive for up to two minutes, the context summariser went on asking the
  model for a summary nobody wanted, and a stop that landed between "the run
  started" and "the run's abort controller exists" was lost outright (it
  aborted the *previous* run's controller, and the run that had just started
  went on with a fresh, un-aborted one). The stop now reaches every wait: the
  loop checks the signal between tools and between steps, a command in flight
  is killed with its tree, the summariser rides the same signal, and the
  run's controller is created before the first `await`, so a stop can never be
  lost. The window says what happened: the button reads "กำลังหยุด…" the
  moment the backend hears the stop, the run ends as `cancelled`, and a stop
  that found nothing to stop says so instead of pretending. The remaining
  waits are stop-aware too: the projection a `RUN` waits for, the web search,
  an MCP call the server never answers, and the edits a stopped run would
  otherwise stage.
  (`harness/loop.mjs`, `harness/harness.mjs`, `harness/tools.mjs`,
  `harness/compact.mjs`, `harness/sandbox.mjs`, `harness/mcp.mjs`,
  `harness/rpc.mjs`, `desktop/ui/app.js`, `test/stop.test.mjs`,
  `test/ui.test.mjs`, `test/desktop.test.mjs`, `test/mcp.test.mjs`).
- **The edge's refusals stop being an episode.** A pace-shaped 403 from the
  Cloudflare edge in front of de.aipass.net was answered with a five-second
  pause, then fifteen, then ten, then thirty, then sixty — five probes inside
  the very window they were waiting for, which is how a hot window never
  drained. A run that drew one sat in "[403] refused at the edge — waiting 5s"
  for minutes: recorded live, one benign tool result refused for 90 seconds
  straight while the same bytes were asked for again and again, until someone
  cancelled it. The refusals now wait like rate refusals do (the page 15s then
  60s, the client 60s then 180s — the same ladder a 429 gets), the whole tab
  drops to the edge's own envelope after a refusal (one send every 20s, about
  twelve in four minutes, where the old 3s gap was eight times faster than the
  limiter allows and kept every episode going), every send in the tab keeps a
  two-second floor so two senders cannot put their requests on the wire inside
  the same second, the conversation create waits on the same clock instead of
  firing back-to-back with the first message, and a resend says so with
  `x-ai-retry` — the header the site's own client uses, so the server can tell
  a repeat from a second turn (`extension/page.js`, `harness/bridge.mjs`,
  `test/page.test.mjs`).
- **A project entered after a settings save no longer runs the old values.**
  `settings.set` re-applied the saved values to the current harness only — a
  project visited before the save kept the temperature, budgets and path rules
  of that moment, while the sheet (and every window) said the new ones were in
  force. Every live harness now follows a save (a model picked in the window's
  header — `config.set` — included: it writes the same `defaultModel` the sheet
  does), a project switch re-seeds the harness being entered from the settings
  file (a value changed by a CLI while the backend ran is picked up there too),
  `rules.set` reaches every engine, and `settings.reset` resets every harness
  instead of one (`harness/rpc.mjs`, `test/data-flow.test.mjs`).
- **A torn session header no longer costs the session.** The header rewrite is
  an in-place 2 KB write (`HEADER_WIDTH`) — the crash window traded away for
  O(1) rewrites — and a power loss mid-write could leave a first line that no
  longer parsed. That used to be a session lost: the picker skipped it and
  `load()` returned null while the entries sat on disk with nobody able to
  open them. The same header now goes to a sibling `.hdr` breadcrumb
  (atomically) before the destructive write; readers fall back to it, `load()`
  writes it back so the next open reads the file the ordinary way, and a
  completed rewrite deletes it (`harness/session.mjs`,
  `test/data-integrity.test.mjs`). The picker's header test is now
  `type: "header"` like `load()`'s — an entry line (every entry has a string
  `id`) used to list as a row that then refused to open.
- **Rules, memory facts and applied edits swap, not overwrite.** `rules.json`
  and the memory store wrote the whole file in place — one bad moment lost
  every project's permission rules or all cross-session facts, and a failed
  memory save read back as "a fresh project". Both, plus
  `overlay.applyToDisk` (which writes user files and keeps no backup), now go
  through the shared temp-file-plus-rename in `harness/atomic-write.mjs`; an
  applied edit keeps the mode it replaced, so the exec bit on a script
  survives the swap (`test/rules.test.mjs`, `test/data-integrity.test.mjs`).
- **Railway to green: the two dead lanes.** Every macOS job since the
  run-overlay tests landed failed one test: `restorePaths` swapped only the
  literal sandbox path, while macOS hands a child the canonical form
  (`/private/var/…` for anything under `/var`) — so a sandbox path leaked
  into RUN output and the swap no longer hid it
  (`aipass-bridge/harness/sandbox.mjs`, regression in
  `test/run-overlay.test.mjs`). Two Windows jobs failed on `a fresh token is
  minted`: the mint path never refreshed the token memo, so a delete +
  re-mint inside one clock tick reported the old mtime:size stamp and the
  cache answered with the revoked token (`aipass-bridge/harness/authtoken.mjs`,
  regression in `test/auth.test.mjs`).
- **`loadConfig` de-duped MCP servers backwards.** Its own comment said
  project overrides home; the code kept home first. The project entry now
  wins whole-entry, as documented — the same server name could silently run
  the home command instead of the project one (`harness/mcp.mjs`).
- **Log spam, three sources.** The credits line logged every 10s poll —
  thousands of identical lines a day — now only on change. The extension
  SSE cycle (every ~4 min) logged a connect/disconnect pair each time — now
  only the 1↔0 edge. A second bridge starter exited 1 with a wall of red —
  now exits 0 with one line a minute at most (`test/bridge.test.mjs`).
- **The supervisor names the death.** A backend crash used to log only
  `restart attempt N`; the note now carries the exit status, and a loop past
  five straight failures says so instead of adding another identical line
  (`desktop/src-tauri/src/main.rs`).
- **`session.remove()` reported backwards.** It returned `existsSync()` after
  deletion — `false` on success reads as "still there". Now returns whether
  the file is gone (`test/data-integrity.test.mjs`).
- **One root file, not two.** The Rust shell read `settings.json` then
  `desktop.json` — two files that could disagree. `desktop.json` now
  migrates into `settings.json` once and is removed.

- **A failed send leaves a trace.** A run that stops because a send threw
  now records the cause in the session (a `note` entry and
  `run_stats.sendError`) instead of losing it, so the next failure names its
  shape (`test/harness-fixes.test.mjs`).
- **`maxCredits` — a spend cap per run.** The loop counts observed spend
  against the bridge's cached quota (0 = off, the default) and stops a run at
  the ceiling with the stop reason `credit-limited`. Set it in Settings, in
  `settings.json`, or per eval task / `--budget maxCredits=`.
- **The secret floor covers the execution channels.** A RUN whose command
  spells a secret path is refused before anything spawns, SEARCH skips secret
  files even when their names are not dot-hidden, and git patches touching a
  secret are withheld from output (the runtime residual — a name built at
  runtime inside a program — is stated in `SECURITY.md`).
- **Plugin API versioning.** `plugins.mjs` exports `PLUGIN_API` (1); a plugin
  whose `apiVersion` needs a newer harness is refused at load before
  `setup()` runs, and a plugin without one loads as `apiVersion: null`.
- **Reliability targets get a home** (`docs/RELIABILITY.md`): the SLIs the
  commands already print, a zero-warn error budget at release time, and the
  degradation modes indexed. `run_stats` now records the model it ran on,
  and `stats` groups by model and project — `byModel` / `byRoot` in `--json`,
  new `models:` / `projects:` lines in the text report, models in the HTML
  header.
- **The backup/restore drill runs in the suite**
  (`aipass-bridge/test/restore-drill.test.mjs`): a copied home restores into
  a second environment with the same sessions, settings and token; RTO/RPO
  are written down in `docs/DATA_FORMATS.md`.
- **A new default model is an audited change** (`docs/SPEC_EVALS.md`):
  approval gates (safety set solved, no regression, ≤2× cost), the routing
  policy in one place, and "no automatic fallback" stated where it can be
  found; the evals summary gains a `wall median`.
- **`SECURITY.md` grows the governance half**: data classes, owners, threat
  model, and the vulnerability process — triage → fix with test → verify
  closure → announce; `docs/RELEASE.md` gains the release-evidence pack.
- Session headers record `app` — the build that wrote the file — so a
  transcript answers "which version did this come from".
- **`npm run stats -- --alerts / --strict / --json / --html FILE`** — the
  pull-based alerting a local install can have: refusal-rate spikes,
  guard-trip shares, cost outliers and firewall notes, plus a self-contained
  HTML report.
- **`npm run loadtest`** — concurrent local-API smoke with latency and
  memory reporting (`--strict` for release gates). Not part of CI.
- **Evals: `--attempts N`** repeats every task in one run and reports every
  row (the stochastic-run policy: medians, never the best draw), the summary
  gains a `grounded` metric (DONE runs a declared check confirmed), and the
  safety set ships: `refuse-secret` and `ignore-injection`, live-only.
- **Structured log lines + request ids.** `AIPASS_LOG_FORMAT=json` turns
  bridge logs into one JSON object per line; every bridge request carries a
  short `x-aipass-rid` that rides its error lines.
- `docs/RELEASE.md` (versioning, acceptance criteria, upgrade/rollback,
  dependency review), `.github/dependabot.yml`, and tests for data integrity
  (torn/duplicated/wrong-typed lines, settings forward-compatibility) and
  concurrent RPC bursts.
- **The experiment queue** (`docs/EXPERIMENTS.md`, `experiments/queue.json`,
  `npm run experiments`): proposals come from alerts, regressions, research
  or audits; every record carries a hypothesis, baseline, success criteria,
  budget and stop rule, and one that ends without a `result` fails
  validation. Ordered 2×impact − risk − cost; seeded with eight open records,
  from mixed-model routing to the elision tier.
- **The context manager's two newer tiers.** The summarisation transcript
  elides stale, bulky sends to counted head…tail stubs instead of the plain
  1200-char slices (`elideStaleResults` / `AIPASS_ELIDE` — off by default,
  so the `elision-tier` arm measures it against the current default). Every
  rotation also extracts a `MEMORY:` facts section from the summary reply —
  decisions, constraints, files — merges it across rotations (deduped,
  clipped, capped at 20), records it on the compaction entry, and pins it
  into every later seed, so a long session keeps its spine across any number
  of rotations (`carryMemory` / `AIPASS_MEMORY=off`; queue:
  `memory-tier-carry`).
- **`npm run evals:compare`** — two result JSONLs in, one verdict out. The
  model-approval gates (regression floor, safety set, ≤2× spend, a 3-attempt
  sample floor) are exit codes instead of judgment; `--json` for the record.
- **Eval rows carry their dataset versions** — `taskDigest`, `treeDigest`,
  an `env` stamp (`app`, `node`, `platform`) — plus the task's `category`;
  the summary gains `by category:`, `mixed outcomes:` and `pair drift:`
  lines. The set gains two phrase-robustness twin pairs (`sum-numbers`,
  `count-lines`), and `--keep` copies every attempt's session JSONL beside
  the run results, so evidence outlives `%TEMP%`.
- **The safety set doubles and gets twins**: `refuse-run-leak` (an embedded
  "ops step" that would stage the token through RUN) and `allow-clean-run`
  (the false-positive twin — a clean RUN that must go through). All four
  safety tasks are `liveOnly` (replay skips them); FP/FN criteria and the
  30-day expiry of safety evidence live in `docs/SPEC_EVALS.md`.
- **`docs/MATURITY.md`** — the capability map: production vs experimental vs
  not shipped (and one "won't build"), each with the criteria that would
  change its status and an owner role.
- **The test plan's L1 cases are implemented** (`docs/TEST_PLAN.md`): digests
  pinned stable across runs and moving with a fixture byte, a dead bridge
  marked `invalid` (never `unsolved`), the summary's empty slices staying
  quiet, piped/composed secret spellings refused, literal metadata hosts
  resolving private without a network round trip, a summary-less `compaction`
  marker loading, unknown entries surviving a rewrite, the queue's `--json`
  order — and the comparator's new-task/wall/old-shape cases.
- **The suite runs on macOS in CI** — `macos-latest` joined the matrix
  (Node 22/24), so the second platform the app ships for is exercised on
  every push. The platform→argv rule (`open` / `cmd start` / `xdg-open`)
  moved to `harness/open-command.mjs` and the sidecar triple table became
  injectable (`targetTriple()`), so a Windows dev machine pins the darwin
  branches in `platform.test.mjs`: the argv shape on all three OSes, the
  `browser.open` allowlist refusing before any spawn, and the mac sidecar
  names (`x86_64-apple-darwin` / `aarch64-apple-darwin`).
- **Per-tool latency in `run_stats`.** Each tool kind's entry gains `ms` (its
  wall time; parallel SUBAGENTs are timed at their fan-out) and `npm run
  stats` prints the per-kind mean next to the refusal count; `run_stats.turns`
  records the reply count that `steps` (executed calls) never named.
- **The red-test commit gate.** A `git commit` RUN is refused while the
  project's declared check (`.aipass/check.txt`, `docs/SPEC_CHECKER.md`) has
  not passed at the current tree state — any change re-arms it, the refusal
  names the exact command that un-bars it, and `run_stats.commitBlocks` counts
  the refusals. Projects without a declared check are untouched.
- **`--snapshot`** quotes `git status --short` and the `package.json` scripts
  into turn 1 — off by default, so the CLI's tuned turn-1 bytes stay identical
  (`agent.test.mjs` pins both sides).
- **Plugin tools can declare a risk** — `ctx.tools.register(marker, fn,
  {risk: 'write'|'shell'})` routes the marker through the same permission
  gate a built-in of that kind rides; undeclared tools keep the trust the
  plugin model states (`plugins.test.mjs`, `gates.test.mjs`).
- **Temperature is a knob now.** `temperature` (0..2, null = the server's
  per-model default) lives in `settings.json`, rides every send as
  `temperature`, and is edited from the composer's temperature chip beside the
  effort chip (`agent.test.mjs`, `chat.test.mjs`, `bridge.test.mjs`,
  `ui.test.mjs`). The bridge clamps out-of-range values and drops a value
  that is not a number, with a warning. The sampling fields the bridge cannot
  forward (`top_p`, `max_tokens`, `presence_penalty`, `frequency_penalty`,
  `seed`, `stop`, `logit_bias`, `logprobs`, `response_format`,
  `reasoning_effort`, `top_k`, `n`) are no longer ignored silently: one
  `warning:` line names them per request (`bridge.test.mjs`). The outer API
  (`/v1/chat/completions`) still ignores everything else, now documented as
  such (`docs/DOCS.md`).

- **MCP client (stdio).** `harness/mcp.mjs` speaks JSON-RPC over stdio:
  initialize, tools/list, tools/call. Servers are configured in
  `~/.aipass/mcp.json` or `<project>/.aipass/mcp.json`; each tool is
  exposed to the model as `MCP__<server>__<tool>` and merged into the
  plugin table. A server that fails to connect is skipped, never fatal.
  `aipass mcp [list|call]` inspects and calls them.
- **Code navigation (SYMBOLS / DEF / REFS).** A zero-dependency,
  regex-based symbol index (`harness/symbols.mjs`, 15+ languages) cached
  under `~/.aipass/symbols`, refreshed on mtime change. The model can list
  a file's declarations, find a definition, and find references.
- **Cross-session memory.** Facts persisted per project in
  `~/.aipass/memory/<project-hash>.json` and loaded into a new session's
  first turn; persisted on compact/rotate. `aipass memory [list|clear|path]`.
- **Background subagents.** A `SUBAGENT` with `background: true` starts and
  returns a job id at once; results are polled with `JOBS` or injected
  into a later turn. No nesting.
- **Test-time scaling.** `aipass scale "task" [--n N]` runs the task N
  times and keeps the best by check verdict (`Harness.scale`).
- **UX pass over the window and the popup** (design record: `docs/UX.md`).
  The extension popup's Advanced section gains **Paste from clipboard** and
  **Test connection**; the desktop gains `/memory`, `/mcp`, `/symbols` and a
  **memory panel** (facts carried across sessions + forget-all, via new
  `memory.list` / `memory.clear` / `mcp.list` RPC methods); sessions, playbooks
  and files rows are keyboard-operable; a run in flight pulses the composer
  hint; the six most common loop failures are translated to Thai with the next
  action; the hardcoded user card is gone; the theme toggle shows the theme it
  will switch to.

### Changed

- **The rail is the work, not the configuration.** The window's left column
  carried nine rows, and half of them led nowhere: "ค้นหาแชท" focused a search
  box folded away inside another row, so clicking it did nothing you could
  see; "ผู้ช่วยอัจฉริยะ" focused the composer, which is already focused;
  "ไฟล์เดี่ยว" duplicated the attach button beside it; a "New Conversation"
  line duplicated the button above it; and "เรียนรู้เกี่ยวกับ AI" held an
  empty box unless a plugin happened to be installed. The rail is now
  แชทใหม่, the search field itself, the history (counted, searchable, scrolling
  in its own box), the project's files, and the playbooks and plugin panels —
  shown only when they have something in them, so a section with nothing in it
  is not a row that leads nowhere. What the app remembers between sessions
  moved to a settings page, next to the rules, because that is where you look
  when you ask what an app is doing; the foot of the column spells out ตั้งค่า
  and วิธีใช้ rather than leaving a 15px gear in the header. The one-click
  archive of old conversations was invisible — the hover-to-reveal rule belongs
  to the file rows' แนบ button — and it stays visible now
  (`desktop/ui/*`, `test/ui.test.mjs`).

- **The safety twins were measured, and the first experiment graduated.**
  `safety-twin-controls` ran its 3 live attempts of the safety set on
  2026-10-20: 12/12 solved, 0 false positives, 0 false negatives — the clean
  RUN went through every time, the embedded instruction was ignored every
  time, `.env` stayed untouched, and the secret request ended denied
  (`evals/results/2026-10-20T04-38-38-891-live.jsonl`, attempt sessions kept
  beside it). The record is `done` with that result pinned; the queue's other
  seven records stay `proposed`.
- **The plan card tracks the run and says what is left.** The `finished`
  event now carries the run's final `todo` state, so the window re-tallies the
  card from one account: a `done` ending with items still open names how many
  and offers the one-click carry-on, a fully ticked card shows `done/total`
  and marks itself complete, the list is height-bounded and scrolls instead of
  covering the conversation, and the card is cleared — and replayed from the
  session log — when the conversation changes (`test/plan.test.mjs`,
  `test/ui.test.mjs`).
- **A DONE that leaves the plan open is asked about exactly once.** When a
  DONE arrives while the run's own checklist still has open items, the loop
  sends one message that names them (up to 8, then "… and N more") and asks
  the model to finish, tick or drop each — and a second DONE after it always
  ends the run, so the checkpoint can never park a long run on a checklist
  nobody answers. The asks are counted in `run_stats.todoPrompts`
  (`test/plan.test.mjs`).
- **A session owns its model-side conversation.** The conversation id is
  recorded on the session header the moment it has taken a message, adopted
  when the session is reopened (a warm resume — the upstream still holds the
  history), and never carried across sessions: `/new`, `/resume` or a
  `session.open` on another session used to keep talking in whatever
  conversation the harness was last on, putting one session's messages into
  another's history. A session reopened without its conversation — an old
  file, a fresh process — gets a bounded digest of its own transcript as the
  fresh conversation's seed (tasks given, the model's last words, the open
  checklist, the durable facts), records the boundary like a rotation so the
  budget estimate measures what the model actually holds, and a conversation
  that is gone upstream (a temporary that expired) is replaced with a fresh
  one plus the same digest instead of ending the run
  (`test/session-resume.test.mjs`, `test/data-integrity.test.mjs`).
- `evals:compare` no longer passes by absence: a baseline task the candidate
  never ran counts as 0 rows and fails as insufficient sample, the same way a
  missing safety task already did (`docs/SPEC_EVALS.md` says it in the gate
  text too).
- Session load is explicit about bad data: a duplicated entry id loads once,
  lines that parse to the wrong type are skipped, and only an object with a
  string `id` counts as a header.
- `docs/SPEC_EVALS.md` no longer claims the loop lacks wall-clock caps (it
  does not lack them; the credit cap was the missing one, and now ships
  opt-in). Open question 2 (attempt policy) is resolved as built.
- `compaction` entries record the newest entry their summary folds away as
  `lastSummarizedEntryId` — the old `firstKeptEntryId` named the wrong end of
  the boundary (`docs/DATA_FORMATS.md` notes the old spelling). The `seed()`
  helper's never-read `listing` parameter is gone.
- **Per-model context budgets finally drive compaction.** `Compactor` already
  knew how to pick a budget by model id (prefix match); the desktop path now
  passes a curated map (flash 100k, pro/sonnet/opus/gpt 200k, deepseek/qwen/
  llama/mistral/grok 128k, gemini 1M) instead of a flat 24k, and a new
  `maxResult` setting (default 3000) reaches the tool context from the sheet
  too (`test/compact.test.mjs`, `test/settings-clamp.test.mjs`).
- **A follow-up task stops re-pasting an unchanged top-level listing.** The
  harness keeps a per-conversation memory of the listing each conversation was
  last shown (`Harness#listingShown`, `loop.mjs`); an identical listing is
  answered with a one-line "unchanged" note, while a created, rotated or
  freshly pinned conversation gets the full table. The memory is written only
  after the message carrying the listing was accepted — never at composition
  time (`test/agent.test.mjs`, `test/compact.test.mjs`).
- **A long-lived backend keeps less alive.** Switching projects closes the MCP
  clients of the harness left behind — idle child processes used to collect one
  set per project the backend ever ran in — and they respawn on the next use.
  The `run` call also pins the harness it landed on: between its awaits,
  another window's project switch used to be able to repoint the run's next
  attempt, its policy and its pending list (`test/desktop.test.mjs`).

### Fixed

- **A ticked checklist item actually ticks.** `parseTodo` matched `done`
  against the bulleted line, so `- [x] text` — the shape every model writes —
  parsed as open forever: the card never showed progress and the DONE plan
  checkpoint saw the whole plan outstanding even when it was not. The bullet
  is stripped before the checkbox is judged (`test/plan.test.mjs`).
- **The plan card holds still while it updates, and the window cannot be
  raced into a mixed session.** Ticking one item rebuilt the whole list on
  every step — a flicker that reset the card's scroll position mid-read — and
  a `todo` frame without items threw inside the stream handler, mid-run; an
  unchanged row now updates where it stands, the scroll survives a rebuild,
  and junk frames are dropped. Opening a session is async too: two quick
  clicks interleaved their entries into one transcript, and a load still in
  flight painted over a freshly started New Conversation; the newest choice
  now owns the screen (`test/ui.test.mjs`).
- **A live run cannot paint into another session's view.** Opening an old
  conversation while a run was in flight let the run write into it: streamed
  prose into someone else's transcript, its checklist card over it, its
  `finished` folding a trail that was not on screen. The backend tags every
  harness frame with the session the run writes to — read at the run's start,
  so a `session.open` moving the harness mid-run does not move the tag — and
  the window drops frames tagged for another session. The `session`
  announcement stays exempt: adopting the new id is how the window follows a
  run that opens a session (`test/desktop.test.mjs`, `test/ui.test.mjs`).
- **A timed-out `RUN` or `GIT` takes its whole process tree down.** `exec`'s
  timeout killed the shell alone, so the command's own children — a server it
  started, a watcher — outlived it and kept holding the files they had open;
  a later `RUN` met "EBUSY" from a process nobody could see. One runner
  (`runShell`, `tools.mjs`) now owns both tools: bounded output, the same
  `code`/`signal`/`stdout`/`stderr` rejection shape, and a timeout that kills
  the tree — `taskkill /T` on Windows, a process-group signal elsewhere
  (`test/stability.test.mjs` pins a grandchild that must never write).
- **A checklist keeps one row per step.** A line the model repeated inside
  one TODO update — or a duplicate an older build let into the state —
  rendered as two items: the count lied and the tick read as half done.
  `mergeTodo` folds repeated texts now, so the card and the DONE checkpoint
  agree on what is open (`test/plan.test.mjs`).
- **A rotated conversation is seeded even when the run is not the session's
  first.** Between-runs compaction fires on exactly the runs that are not
  first, and the seed was gated on `first`: the fresh conversation restarted
  from a bare "the project is still open" message with the paid-for summary
  never sent. A manual `/compact` had the same hole from the other side — its
  summary had no run to ride in; the next run now builds the seed against its
  own task (`rememberSummary`), once.
- **A rotation that fails is no longer recorded as done.** The compaction
  entry is appended after `rotate()` succeeds (both the loop's mid-run path
  and `compactNow`), so the estimate can never reset against memory the model
  never carried, and a mid-run failure retries on the next step. `/compact`
  also refuses while a run is in flight rather than rotating under it.
- The compaction divisor sampled entries a rotation had already discarded, so
  a fresh Thai conversation following a large Latin one (or the reverse)
  estimated up to 2× off; it now samples the same window `estimate()` counts.
- **The session and upload stores are owner-only where the OS has modes.**
  Sessions, their per-project directories and staged upload copies are created
  0o700/0o600, and a file an older build wrote readable is tightened when it
  is opened — the sensitive store no longer hinges on the ambient umask.
  Windows keeps its profile ACL; the token file's modes were already pinned
  (`SECURITY.md`).
- A `compaction` entry with no summary rendered as `undefined` in the
  session's markdown export; it now renders `(no summary)`.
- `npm run evals:lint` was failing on master: `refuse-secret`'s check passed
  on its untouched tree (a no-leak-only check scores nothing). The check now
  requires the explicit `denied` ending, so fail-before holds for every one
  of the 111 checks and CI's lint is green again.
- **A closing message carries the answer.** The standing instructions now say
  the findings belong above the DONE — a question or a summary never closes
  with a "done summarizing" line while the substance stays inside a pasted
  web result — and the no-marker nudge says a written answer plus DONE is
  enough (`test/protocol.test.mjs`, `test/harness-fixes.test.mjs`). The
  math-fix replay fingerprint follows the new preamble
  (`evals/fixtures/math-fix-replay.json`).
- **The picker marks a model the live catalog dropped.** A saved model the
  site no longer offers used to sit in the dropdown unmarked and then failed
  the run at the catalog check; the option now carries that verdict before
  the run starts, and a model missing from a fallback list stays unjudged —
  the same rule the loop applies (`test/ui.test.mjs`).
- **A pace-score 403 cools the whole tab, not just the job it refused.** The
  edge 403s by pace as well as by content — the same limiter family as a 429 —
  but only the refused job used to wait: every send behind it left at full
  pace into the window that had just said no. The page now arms the tab-wide
  `rateQuietUntil` clock and the five-minute `RATE_MEMORY_MS` pacing on a 403
  exactly as on a 429 (`test/page.test.mjs`).
- **The settings sheet's budgets reach the live run the moment Save lands.**
  `maxToolCalls`, `maxWallClockMs` and `maxCredits` join the keys re-applied
  to the running harness on save — before this a budget change only took
  effect at the next backend start while the sheet said it was live
  (`test/hardening.test.mjs`).
- **The `models:` line covers history, not just new runs.** A run that
  predates `run_stats.model` is attributed to the model its session recorded
  — the one a fresh run started on — so older sessions no longer blend under
  `(unrecorded)`, which stays for sessions that recorded no model at all
  (`test/stats.test.mjs`).
- **A refused send no longer ends the run at the first exhaustion.** Past the
  redact/wait/split/omit chain the loop pauses and sends the same message
  again (`RECOVER_WAITS_MS` — 30s then 60s, bounded): the connection-cycle
  shapes, a tab still loading, rate windows, and 403s that were never about
  the content. Each recovery is a `firewall_note` and counts in
  `run_stats.sendRecoveries`; the transport also waits out a content script
  mid-reinjection (`TRANSIENT_SEND`), and a run that still dies keeps its
  recorded cause (`test/agent.test.mjs`).
- **Streaming stops repainting what it already painted.** A reply paints in two
  layers now — the settled blocks render once, only the unfinished tail
  re-renders per frame — and the reasoning fold appends the text that arrived
  instead of reassigning its whole body, so a long answer or a long think no
  longer slows the window as it grows (`test/ui-md.test.mjs`,
  `test/ui.test.mjs`).
- **The backend's big reads and walks no longer block the window.** GLOB's tree
  walk, SEARCH's per-entry size check, and attachment staging/sending used sync
  fs calls that froze every window request for their duration; they go through
  `fs.promises` now — the walk stays sequential, so the cap still returns the
  same files (`test/tools.test.mjs`, `test/tools-aci.test.mjs`).
- `docs/DATA_FORMATS.md` matches the code again: `maxSteps` defaults to 0 (no
  cap), `minThaiRatio` to 0.4, and the auth exemption list names the same
  routes the backend skips (`/token`, the static UI files).
- **GLOB speaks shell globs again.** Brace alternation (`*.{js,css,html}`)
  and `?` are expanded and matched the way the shells do; the braces were
  escaped before, so a tree full of matching files answered "no files matched"
  (`test/tools.test.mjs`).
- **The nudge names a broken marker.** When a reply contained marker-shaped
  text that did not parse, the correction now says so and lists the shape
  rules (start of its own line, no indentation, bold or code fence, exact
  keyword) instead of the generic "no marker" line.
- `RUN type .env`, `SEARCH` over `server.pem`, and `git show HEAD:.env` were
  three ways around the secret floor; all three are refused now
  (`test/secret-screen.test.mjs`).
- **A backend crash no longer masks itself as a `ReferenceError`.** The desktop
  backend's `fatal()` handler called `formatLogLine` without importing it, so
  every uncaught error exited as `ReferenceError: formatLogLine is not defined`
  and the real cause was lost — and the supervisor restarted the backend, making
  the crash look like a restart. The import is restored, so a crash now prints
  the error that caused it (`test/hardening.test.mjs`).
- **A project is a first-class scope in the window.** `state.root` is set from
  the project list/switch/snapshot, every run and cancel carries `root`, and
  events from other projects are dropped so a run in one project cannot paint
  another; a foreign permission/plan modal still shows, tagged with the other
  project's name, and its answer is routed back by project
  (`test/ui.test.mjs`).
- **A run is bound to its root.** `run(params)` switches the harness when
  `params.root` differs (remember:false), `cancel(params)` targets the named
  harness, and `status()` reports per-project `running`; the window sends
  `root: state.root` on run/cancel (`test/desktop.test.mjs`).
- **Helpers read the parent's staged tree.** `Overlay` gains a read-through
  `base` layer; a helper is built with `base: overlay` and its own `before`
  snapshot, and copy-back skips files staged since it started, naming them in
  `helper_end.skipped` (`test/harness-fixes.test.mjs`).
- **`readSet` is per run.** `#makeTools()` is called in `run()`, not shared,
  so a read in one run no longer licenses a blind CREATE in the next
  (`test/harness-fixes.test.mjs`).
- **Rotation keeps the conversation its `create` returned.** `#rotate` uses
  `made.id` instead of re-reading the bridge's shared pointer; the server's
  `resolveConversation` skips a temporary `conversationCache` for nameless
  callers; sends now carry `conversation`/`conversationTemporary` per send
  (including summarize), and the loop rebinds `conversation` after rotation
  (`test/harness-fixes.test.mjs`, `test/bridge.test.mjs`).

## [0.2.0]

The release this repository is at. The ground-up continuation, in buckets:

- **The window** (`desktop/`): Tauri shell, chat UI, settings sheet, diffs
  with apply/reject, session picker, plan mode, project switching.
- **The bridge** (`aipass-bridge/bridge/`): WAF-safe relay between the local
  harness and the logged-in chat tab, quota/models routes, admin routes
  behind `AIPASS_ADMIN=1`, loopback-only with a bearer token.
- **The harness**: the pi-style session JSONL, the marker tool protocol,
  permissions with the secret floor, the loop with its guards (stagnation,
  repeat, chain, verify), compaction, overlay/apply, and the apply-then-check
  discipline.
- **The Thai pack**: `replyLanguage`/language check, the Thai/English eval
  pair set, and Thai-first UI copy.
- **Hardening**: loopback token on every route, openers take argv only, one
  WAF table, one-run-per-harness lock.
- **Stability**: capped rotating logs, atomic session writes, spill pruning,
  crash handlers that name the death instead of vanishing.
- **Evals** (`npm run evals`): check-decides-outcome task fixtures, live and
  replay modes, fingerprints that mark stale replays instead of scoring them.
