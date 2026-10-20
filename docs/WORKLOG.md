# Worklog

Session handoffs, newest first. One entry per working session, five items:
**files touched · tests run + result · deferred items with reasons · open
risks · cleanup done**. This is news, not law: the rules live in `AGENTS.md`,
durable behavior changes in `CHANGELOG.md`, and the final word is always the
suite.

## 2026-10-20 — opencode — the suite runs on the branch this repository has

- **Files**: `.github/workflows/test.yml` (the push filter names `main` — it
  said `master`, a branch the remote does not have, so no push ever started
  the suite); `package.json` (`"type": "module"`, so Node reads the window's
  `.js` files as ES modules instead of re-parsing them and warning on every
  run); `aipass-bridge/README.md` (the command table carries all nineteen
  subcommands the CLI dispatches — `chat`, `providers`, `scale`, `plugin`,
  `mcp`, `setup` and `stop` were missing — and the link to `DOCS.md` points
  at the directory it lives in); `aipass-bridge/docs/DOCS.md` (the link back
  to the bridge's README points one level up, where the README is);
  `README.md` (the documentation table lists all fifteen files in `docs/` —
  `UX.md`, `PLUGINS_MCP_DESIGN.md` and `WORKLOG.md` were missing);
  `CHANGELOG.md`; `docs/WORKLOG.md`; `.gitignore` (`*.tsbuildinfo` — the
  editor's build cache was sitting untracked in the root); `AGENTS.md` (the
  `Last verified:` date).
- **Tests**: `npm test` 794 tests, 791 pass / 0 fail / 3 skipped;
  `npm run agents:lint` ok — 32 anchors resolve against 780 test titles. Both
  ran on the tree as it stands, before the commits were cut. No test file was
  touched, so this is the same suite the previous commit ran.
- **Deferred**: the build cache is ignored rather than deleted — the file is
  left on disk, it is only out of git now. It is stale either way: it tracks
  a root `tsconfig.json` that no longer exists, and the repository's only
  config is `aipass-bridge/jsconfig.json`, which emits nothing.
- **Risks**: `"type": "module"` changes how Node reads every `.js` file under
  the root — the window's three scripts are the only ones, and the suite
  passes with them read as ES modules. The workflow change stays invisible
  until the next push, and that push is the first time this repository's CI
  has ever run.
- **Cleanup**: none — no process was started and no file was removed.

## 2026-10-20 — opencode — eight defects found by review, each with a test

- **Files**: `aipass-bridge/argv.mjs` (new — the parser that knows which flags
  take a value); `aipass-bridge/bridge/server.mjs` (one `routeDelta()` for
  both reply modes; the attachment placeholder becomes a part; a media frame
  with no payload no longer throws; the delta flush drops a bad frame instead
  of taking the job with it); `aipass-bridge/extension/background.js` (the
  assistant reply is routed to `/ext/assistant`); `aipass-bridge/extension/page.js`
  (a media fetch checks its status; `url: ""` falls through to `snapshotUrl`);
  `aipass-bridge/harness/tools.mjs` (an edit takes its replacement as a
  function, so `$&` is not a pattern; a range past the end says so; a file
  ending with a newline has no phantom last line);
  `aipass-bridge/{agent,chat,doctor,setup-assistant,stats,scale}.mjs` (the
  new parser); `aipass-bridge/docs/DOCS.md` (the `/ext/assistant` route the
  table never listed); `CHANGELOG.md`;
  `aipass-bridge/test/{bridge,page,tools,agent,chat}.test.mjs` (+17 tests) and
  `aipass-bridge/test/background{,-harness}.mjs` (new — the service worker
  in-process, with a chrome small enough to be a stub);
  `desktop/src-tauri/tauri.conf.json` (`argv.mjs` joins the packaged
  resources, or the native build would ship a CLI that cannot start).
- **Tests**: `npm test` 787 tests, 784 pass / 0 fail / 3 skipped;
  `npm run agents:lint` ok; `node --check` clean on every file touched. Each
  new test was run against the unfixed code and failed there — the reply
  routing, the attachment placeholder, the stranded media frame, the dropped
  assistant, the error page, the `$` expansion, the read range, the phantom
  line and the swallowed task all reproduce without their fix. The fixes came
  from `TH-aipassport-harness`, where they were made; they are ported here,
  and two of this tree's value flags — `--verify-command` and `--provider` —
  were not in the list the parser shipped with, so they are in it now, or
  their values would land in the task.
- **Deferred**: the bridge still answers a `null` JSON body with a 500, and
  `readBody()` still destroys the socket on an oversized body, so the client
  gets ECONNRESET instead of a 413 — both want a status-code decision, not a
  one-liner. The retry that walks past a rejected conversation still skips the
  most recent one, and `startChat()` still cannot abort before its job
  exists. The bridge's `/config` and `/conversations/new` accept a `null`
  body for the same reason.
- **Risks**: `routeDelta()` now decides where every delta goes, so a kind it
  does not know falls to the content — that is the old behaviour, but the
  decision is in one place now. The new parser changes what a CLI does with a
  value-less flag (it keeps the default instead of crashing) and with
  `--name=value` (now accepted); no flag was dropped, but `agent --file` and
  `agent --session` are still only in the help text, not implemented.
- **Cleanup**: none — the bridge was only ever driven from the test harness,
  and no background process was left running.

## 2026-10-20 — opencode — the second sweep: the WAF table, the session store, the harn

- **Files**: `aipass-bridge/harness/waf.mjs` (the `Bypass` placeholder is one
  word now, so its own rule cannot see it);
  `aipass-bridge/harness/session.mjs` (a fork states its own entry count; a
  removal says whether it removed anything);
  `aipass-bridge/harness/loop.mjs` (the parts are taken once, before the
  attempts); `aipass-bridge/harness/tools.mjs` (a range that starts at zero is
  refused); `aipass-bridge/harness/settings.mjs` (the mojibake);
  `desktop/main.mjs` (the readiness probe presents the loopback token);
  `scripts/live-check.mjs` (new — the QA loop's live verdict, so it can be
  tested); `scripts/qa-loop.mjs` (the verdict, and the token);
  `scripts/evals.mjs` (a task's own `budget.maxCredits` survives);
  `aipass-bridge/test/{waf,data-integrity,harness-fixes,tools,desktop,harness-qa,evals}.test.mjs`
  (+8 tests); `CHANGELOG.md`.
- **Tests**: `npm test` 625 pass / 0 fail / 2 skipped (620 before, 618 passing);
  `npm run agents:lint` ok (17 Verify anchors resolve against 613 titles);
  `npm run typecheck` clean; `node --check` clean on every file touched. Each
  new test was run against the unfixed code and failed there — the doubled
  WAF encoding, the overstated fork header, the silent removal, the backwards
  zero range, the lost attachment, the refusing backend and the dropped
  credit cap all reproduce without their fix.
- **Deferred**: the WAF restore is still case-sensitive where the
  substitution is case-insensitive, so `Localhost` comes back `localhost` —
  the repo documents that as the one lossy edge, and the comment that says it
  "never costs a bad write" is the part that is wrong. The MCP server and tool
  names still land raw in a compiled regex, so a name with a bracket in it
  throws inside `prose()`. The bare `ASK` marker is still stripped from the
  prose without becoming a call. A `FIND` block with no `NEW` still deletes
  the text it found. The plan-approval gate still runs after the reply's tool
  calls have executed. The desktop UI's `/model <id>` still does not update
  the picker, and the theme toggle still replaces its own icons.
- **Risks**: the WAF placeholder changed, so a transcript written before this
  carries a `BYPASS-ARG` that the new restore does not decode — cosmetic, and
  only in a session that predates it. `scripts/live-check.mjs` is a new file
  in `scripts/`, next to the other small helpers. The `BYPASSARG` form is
  still caught by the redact fallback, which matches `BYPASS` anywhere.
- **Cleanup**: none — the bridge was only ever driven from the test harness,
  and no background process was left running.

## 2026-10-20 — opencode — the suite stops writing into the real home, and the scratch it makes goes with it

- **Files**: `scripts/test.mjs` (the runner hands the whole run a scratch
  `AIPASS_HOME` of its own, removes it after, and sweeps the stale scratch
  trees the project's helpers left in the temp directory — older than an hour,
  so a parallel session's in-flight run is never touched); `aipass-bridge/harness/memory-store.mjs` (the store's directory is
  resolved when it is used, not when the module loads — a path frozen at load
  time wrote the suite's facts into the developer's real `~/.aipass/memory`; the
  injectable-dir feature another session added is untouched);
  `aipass-bridge/test/harness.mjs` (the per-file home floor and every
  `tempDir()` tree are removed when the process exits — one hook, not one per
  call); `aipass-bridge/test/data-integrity.test.mjs` (+1 pin: the store lands in
  the home it was given); `CHANGELOG.md`, `docs/WORKLOG.md`. Outside the repo:
  `~/.aipass/settings.json` (`compactAtPercent` 40 → 10) and
  `~/.aipass/memory` (222 fixture files removed).
- **Tests**: `npm test` green — 769 tests, 766 pass, 0 fail, 3 skipped (the
  skips are the suite's own); `node --test aipass-bridge/test/compact.test.mjs`
  28 pass; `node --test aipass-bridge/test/data-integrity.test.mjs` 19 pass,
  1 skip; `node --check` clean on every touched file; `npm run agents:lint`
  ok (32 anchors, 755 titles). The real `~/.aipass/memory` gained **0** files
  across a full suite run and across a single-file run.
- **Deferred**: the memory tier is still the registry's "experimental" row —
  nothing here graduates it, and the `memory-tier-carry` arm is still
  `proposed` (no credits were spent on it). The per-file `tmp()` helpers in
  ~12 test files keep their own scratch (~19,000 directories, still to be
  swept); the two chokepoints that carried 153,000 of them are fixed.
- **Risks**: the new `compactAtPercent` of 10 rotates a run at 10% of its
  budget — for `flash-lite` (100k) that is ~10k tokens, so the long sessions
  now rotate and can carry facts, but each rotation costs one extra model call
  and the account has 523 of 10,000 credits left. A model outside the budgets
  map falls back to `contextTokens` (24k), which at 10% rotates after ~3.6k
  tokens — eager for such a model; the number lives in one place
  (`~/.aipass/settings.json`) if it wants to go back to 40.
- **Cleanup**: the suite's scratch home and the temp directory's stale test
  scratch are gone — 6,201 `aipass-harness-*` directories and 165 MB removed
  from `%TEMP%`; `~/.aipass/memory` emptied of 222 fixture files (no real fact
  existed: the project of record had no store file at all). The runner now
  sweeps the rest (the `aipass-test-*` family alone was 147,000 directories);
  the per-file `tmp()` helpers in ~12 test files still make their own scratch,
  and the sweep is what keeps them from piling up.

## 2026-10-20 — opencode — the playbook index stops being prose, and a plugin can come from git or npm

- **Files**: `aipass-bridge/harness/skills.mjs` (one `skillDirsFor()` order for
  every surface — configured folders, project, user, repo; the curated
  `index.md` became a preamble and the list of what is on disk is generated
  and always follows it, so a part added yesterday is named without anyone
  editing prose; the folders are read on every call);
  `aipass-bridge/harness/rpc.mjs` (the window uses that one order; an RPC
  refusal carries the step it closed); `aipass-bridge/harness/install.mjs`
  (`npm:` / `github:` / `git+` sources are fetched — a shallow clone, or
  `npm install --ignore-scripts` — with an 8 MB tree cap, the entry hash
  re-checked at install time, and every failure tagged with its step);
  `aipass-bridge/harness/desktop-rpc.mjs` (the step travels with the refusal);
  `aipass-bridge/plugin.mjs` (the CLI names the source kind, the step, and the
  new spec forms); `desktop/ui/app.js` (the install box says what it is doing
  while it works and names the step that closed; the report says whether the
  source is fetched; the playbook rail refreshes when the window comes back
  and after the settings sheet saves); `aipass-bridge/test/skills.test.mjs`
  (+2), `aipass-bridge/test/install.test.mjs` (+3, the two git ones skip when
  git is absent), `aipass-bridge/test/ui.test.mjs` (+1, and the fake backend
  can now answer with a refusal); `CHANGELOG.md`,
  `docs/PLUGINS_MCP_DESIGN.md`, `docs/HARNESS_DESIGN.md`, `desktop/README.md`,
  `docs/WORKLOG.md`.
- **Tests**: `npm test` green — 769 tests, 766 pass, 0 fail, 3 skipped (the
  skips are the suite's own, not new); `node --check` clean on every touched
  file; `npm run agents:lint` ok (32 anchors resolve). One run failed on
  `memory-store.mjs` (`DIR is not defined`) — another session's file, caught
  mid-edit in this shared checkout; it was green on the re-run and the file is
  not this change's.
- **Deferred**: a plugin's own dependencies are copied beside it so an import
  resolves from its final home, but a plugin that imports something it did not
  declare is not diagnosed, and a dependency's own install scripts are never
  run — they are the package's business, and a plugin that needs them has to
  say so. The registry package spec (`npm:<name>` from the registry) is not
  covered by a test — the suite may not depend on the network — so it rests on
  the same code path as the local-folder form, which is covered.
- **Risks**: the skills order changed for the terminal — a folder named in
  `skillsDirs` now wins over the project's own `.aipass/skills` there too,
  which is what the window already did (a name in two libraries used to load a
  different file depending on who asked). On this machine `skillsDirs` points
  at `D:\aipass2\skills` and no project folder exists, so nothing moved. A
  `git` source is pinned by what it fetched: a branch that moves between the
  report and the install is refused, and the person has to look again — the
  price of a consent that means something.
- **Cleanup**: the scratch trees the fetches use are swept in a `finally`, and
  the staging tree is swept on every path; no process was left running.

## 2026-10-20 — opencode — the desktop can talk to another provider

- **Files**: new `aipass-bridge/harness/providers.mjs` (the registry: the specs
  in `~/.aipass/providers.json`, the keys in `~/.aipass/credentials.json` at
  `0600`; a named env var wins over the file, so a key need never be written
  down) and `aipass-bridge/harness/provider-client.mjs` (the OpenAI-compatible
  and Anthropic adapters — they answer the same client contract as the bridge,
  keep the history the AiPASS edge would have kept, and set `waf = false`
  because the substitution table is that edge's own); new
  `aipass-bridge/providers.mjs` (`aipass providers list|add|remove|use|test`);
  `aipass-bridge/harness/bridge.mjs` (the client names its provider; the
  429 shape recognises a provider as well as the site);
  `aipass-bridge/harness/loop.mjs` (the WAF is asked about once per run, so a
  provider gets the bytes as they are; the catalog check names the provider
  that refused); `aipass-bridge/harness/harness.mjs` (`setProvider()` swaps the
  client and the compactor with it); `aipass-bridge/harness/settings.mjs`
  (`defaultProvider`); `aipass-bridge/harness/rpc.mjs` (`providers.list`,
  `provider.set`, `provider.save`, `provider.remove`, `provider.test`);
  `aipass-bridge/agent.mjs` (`--provider`); `aipass-bridge/bin/aipass.mjs`;
  `aipass-bridge/harness/protocol.mjs` (the reminder in three pieces, so a
  provider is not told about wire spellings it never sees);
  `aipass-bridge/test/providers.test.mjs` (new, 14 cases — the last one is a
  whole run over a fake OpenAI-compatible endpoint);
  `aipass-bridge/test/ui.test.mjs` (the provider picker);
  `desktop/ui/index.html`, `desktop/ui/app.js`, `desktop/ui/styles.css` (the
  picker, the settings page, the slash command);
  `desktop/src-tauri/tauri.conf.json` (the new CLI is a packaged resource);
  `AGENTS.md` (rule 14), `aipass-bridge/AGENTS.md`, `desktop/AGENTS.md`,
  `aipass-bridge/docs/DOCS.md`, `CHANGELOG.md`, this entry.
- **Tests**: `node --test aipass-bridge/test/providers.test.mjs` 14 pass /
  1 skipped (the POSIX mode check has nothing to say on Windows); full
  `npm test` 766 tests, 763 pass / 0 fail / 3 skipped (the count moves — a
  parallel session is adding tests in this repo); `npm run agents:lint` ok
  (32 anchors / 742 titles); `npm run qa` 9 ok / 0 warning / 0 failing.
- **Deferred**: the chat TUI (`chat.mjs`) still talks to the bridge only — it
  is a terminal client for the site, and a provider run needs the harness's
  history handling, so it was left alone rather than half-adapted. The WEB
  tool asks the provider instead of the site, so it is a plain question there
  and not a search. Anthropic's native tool-calling and prompt caching are
  not used: the marker protocol is prose, and the adapter sends plain
  messages.
- **Open risks**: a provider that answers a different history shape than the
  one the loop expects would fail at the first tool result rather than at the
  switch — the adapter owns the history, so the risk is in the adapter, not
  in the loop. The window rebuilds the model list on a switch but the backend
  keeps the provider's own default model, so the two can name different
  models until the next run picks one.
- **Cleanup**: no processes left running (the desktop backend already running on
  :8790 and the other session's bridge were left alone); the demo homes used
  to try the CLI were removed, along with 13,908 abandoned `aipass-ui-*`
  scratch homes the UI test harness leaves in TEMP.

## 2026-10-20 — opencode — the sandbox stopped pretending to be a wall

- **Files**: new `aipass-bridge/harness/output-scrub.mjs` (a command's OUTPUT
  is screened: known token shapes, plus any assignment whose name carries a
  credential — `set`/`env` prints the whole environment, and the transcript
  is what goes upstream); `aipass-bridge/harness/overlay.mjs` (`safe()` is now
  LEXICAL — `path.relative`, not a string prefix, so Windows's case
  insensitivity stops refusing valid paths — and PHYSICAL: the real path of
  the target is compared with the real root, so a link out of the project is
  a link out of the root; `realPath()` is the helper); `aipass-bridge/harness/sandbox.mjs`
  (the projection lives under `~/.aipass/run/<project>/`, not inside the
  project; `sweepSandboxes()` is the janitor; `sharedDirs()` names the heavy
  folders the projection SHARES with the real tree; a link that points
  outside the project is left out; a file over `AIPASS_SANDBOX_MAX_FILE_MB`
  is left out and named; the `.git` sentinel is written when a repository is
  reachable from the project OR the new home);
  `aipass-bridge/harness/tools.mjs` (the RUN and the git tool screen their
  output; the RUN's result names the shared folders and the files left out);
  `aipass-bridge/harness/harness.mjs` (the janitor runs when a harness opens
  a project; a project that is a git repository and does not ignore
  `.aipass/` is told so, once); `aipass-bridge/test/sandbox.test.mjs` (new,
  11 cases); `AGENTS.md` (rules 1, 2 and 6), `SECURITY.md`, `CHANGELOG.md`,
  `docs/HARNESS_DESIGN.md`, `docs/SPEC_CHECKER.md`, this entry.
- **Tests**: `node --test aipass-bridge/test/sandbox.test.mjs` 11/11;
  full `npm test` 753 tests, 750 pass / 0 fail / 3 skipped (the count moves —
  a parallel session is adding tests in this repo);
  `npm run agents:lint` ok (29 anchors / 739 titles).
- **Deferred**: the heavy directories are still shared with the real tree — a
  copy of `node_modules` would cost a minute per RUN — so a write into one
  of them lands in the user's project. The RUN's result now names them, which
  is the honest limit; making them copies is a decision, not a bug fix. The
  `.git` sentinel stays a sentinel (a `GIT_CEILING_DIRECTORIES` in the child's
  environment would say the same thing without a fake file in the tree, but
  the current shape is tested and works).
- **Open risks**: `overlay.safe()` now resolves the real path of every target
  — one extra syscall per tool call, and on Windows a path that no longer
  exists is resolved through its nearest existing ancestor. A project reached
  through a junction is compared real-to-real, so it still works. The
  projection's new home (`~/.aipass/run/`) is outside the project: a command
  that walks up from its cwd now sees the home directory, not the project's
  parent — `restorePaths` still rewrites the path in the output.
- **Cleanup**: no processes were touched; the desktop backend and the desktop
  app were restarted (the new code is live and the window loads the new
  `app.js`); the scratch probes live in `%LOCALAPPDATA%\Temp\opencode`
  (`aipass-sandbox-probe*.mjs`, `aipass-junction-probe.mjs`).

## 2026-10-20 — opencode — the stop button stops the work, not just the conversation

- **Files**: `aipass-bridge/harness/loop.mjs` (the run's stop signal is checked
  between the tools of a reply and between steps; a stopped step breaks out
  before the next send; the compaction's summariser rides the same signal);
  `aipass-bridge/harness/harness.mjs` (the run's abort controller is created
  before the first `await`, so a stop that lands while a run is starting is no
  longer lost; the run's signal rides the tools, the helper and the checker;
  `cancel()` reports whether there was a run to stop);
  `aipass-bridge/harness/tools.mjs` (`runShell` takes the signal and kills the
  command's tree when it aborts; the RUN tool says it was stopped; a FETCH
  carries the run's signal beside its own ceiling; the web search rides it; a
  stopped run stages no more edits);
  `aipass-bridge/harness/sandbox.mjs` (`materializeTree` takes the signal —
  the projection a RUN waits for is abandoned mid-walk);
  `aipass-bridge/harness/mcp.mjs` (an MCP call the server never answers ends
  with the stop; the server itself stays up);
  `aipass-bridge/harness/compact.mjs` (`summarize` takes the signal);
  `aipass-bridge/harness/rpc.mjs` (`cancel` answers `ok:false` with a reason
  when there is no run to stop, instead of always claiming success);
  `desktop/ui/app.js` (the window answers the stop at once — the button reads
  "กำลังหยุด…", the run's ending is spoken in Thai, a stop that found
  nothing says so, and the 20-second watchdog tells the backend to stop too
  so the next task is not blocked by a run the window wrote off);
  `aipass-bridge/test/stop.test.mjs` (new, 6 cases); `aipass-bridge/test/ui.test.mjs`
  (+2 cases); `aipass-bridge/test/desktop.test.mjs` (+1 end-to-end case: a run
  in flight ends as `cancelled`); `aipass-bridge/test/mcp.test.mjs` (+1 case:
  a stop ends an MCP call the server never answers); `AGENTS.md` (rule 13),
  `desktop/AGENTS.md` (a UI law), `CHANGELOG.md`, `docs/LOOP_DESIGN.md`,
  `docs/HARNESS_DESIGN.md`, this entry.
- **Tests**: `node --test aipass-bridge/test/stop.test.mjs` 6/6;
  `node --test aipass-bridge/test/ui.test.mjs` 75/75;
  `node --test aipass-bridge/test/mcp.test.mjs` 8/8;
  `node --test aipass-bridge/test/desktop.test.mjs` 28/28; full `npm test`
  729 tests, 727 pass / 0 fail / 2 skipped; `npm run agents:lint` ok
  (25 anchors / 715 titles).
- **Deferred**: the tool in flight cannot be recalled — a `RUN` is killed with
  its tree, but a tool already writing a file finishes that write; the run
  stops right after it, and a stopped run stages no further edits. The window
  still waits for the backend's `finished` frame before the button says "ส่ง"
  again (the stop frame says "กำลังหยุด…" in the meantime), so the button
  never claims the work ended before the backend says so.
- **Open risks**: the running desktop app serves the window's `app.js` from
  the backend, so the new UI needs a window reload (Ctrl+R) or an app restart;
  the backend was restarted by hand so the new harness code is live, and the
  supervisor brought it back. A `RUN` killed by a stop now leaves a
  `taskkill` behind on Windows — it is spawned detached and short-lived, and
  the command's own tree is what it kills.
- **Cleanup**: the desktop backend was restarted on purpose and the desktop app
  was restarted with it, so the window loads the new `app.js` (the window
  reads the backend's URL, so the served UI is the repo's); no other process
  was touched — a `bridge.test.mjs` runner and a bridge copy under
  `%LOCALAPPDATA%\Temp\opencode\aipass-loopbug` belong to other sessions and
  were left alone; the repro script lives in
  `%LOCALAPPDATA%\Temp\opencode\aipass-stop-repro.mjs` (temp only). The
  installed copy under `%LOCALAPPDATA%\aipass desktop` is an older packaged
  build with a different layout; the running app resolves the repo (the
  Tauri build baked `AIPASS_TAURI_DIR` in), so nothing was copied there —
  a new installer is the release procedure, not a file copy.

## 2026-10-20 — opencode — tables, images and video in the window, and the edge's refusals stopped being an episode

- **Files**: `desktop/ui/md.js` (GFM pipe tables with column alignment, escaped
  pipes and code-span cells; standalone images as captioned figures; inline
  images; `<video controls>` for videos, by bare URL, `![caption](…mp4)`,
  `[caption](…mp4)` or a signed URL whose extension appears in the label; the
  streaming splitter keeps tables and media out of the repaint path);
  `desktop/ui/styles.css` (responsive table wrapper, figure, caption, inline
  image, video); `aipass-bridge/test/ui-md.test.mjs` (new, 13 cases);
  `aipass-bridge/extension/page.js` (the tab's clock: `SEND_GAP_MS` 2s floor
  between every send, `RATE_PACE_GAP_MS` 3s → 20s after a refusal, the
  403 ladder 5s/15s → 15s/60s, the conversation create on the same clock,
  `x-ai-retry` on a resend); `aipass-bridge/harness/bridge.mjs`
  (`EDGE_WAITS_MS` 10/30/60s → 60/180s — a pace refusal is waited out like a
  rate refusal); `aipass-bridge/test/page.test.mjs` (+5 cases, 3 updated);
  docs: `CHANGELOG.md`, `docs/HARNESS_DESIGN.md`, this entry.
- **Tests**: `node --test aipass-bridge/test/page.test.mjs` 25/25;
  `node --test aipass-bridge/test/{run-resilience,rate-bucket,bridge,agent,
  harness-fixes,chat}.test.mjs` 180/180; full `npm test` 719 tests, 717 pass /
  0 fail / 2 skipped; `npm run agents:lint` ok (17 anchors / 705 titles).
- **Deferred**: the renderer is served by the backend from `desktop/ui/`, so the
  window needs a reload — no rebuild, no reinstall. `extension/popup.html` and
  `extension/popup.js` in the loaded copy are older than the source tree
  (another session's sidebar work); left alone, not synced.
- **Open risks**: the extension in Chrome is loaded from
  `C:\Users\ASUS\aipass-bridge\aipass-bridge\extension` — a third copy, not the
  repo's. The new `page.js` was copied there, but the extension must be
  reloaded from disk (popup → "Reload extension", then "Reload chat tab")
  before the new pacing is live. The desktop backend was restarted by its
  supervisor so `harness/bridge.mjs` is current; the browser tab still holds
  the old content script.
- **Cleanup**: no processes left behind (probes ran against the live bridge;
  temp scripts under `%LOCALAPPDATA%\Temp\opencode` only); the three
  `page.js` copies (repo, loaded extension, AppData install) are byte-equal.

## 2026-10-20 — opencode — strict Verify, one shape check, a paced send, and the first graduated experiment

- **Files**: new `aipass-bridge/harness/validate.mjs` (one pre-dispatch shape
  check — built-ins, plugins and MCP tools answer a malformed call with the
  same `err: …` sentence) and its test `aipass-bridge/test/validate.test.mjs`;
  `aipass-bridge/harness/loop.mjs` (the check runs before dispatch; the
  declared check now comes from `verifyCommand` first and the file second, and
  the refusal names its source; `requireCheck` refuses a later DONE over a
  failing verdict as `done-unverified`; `run_stats` gained `checkCommand` and
  `doneUnverified`; the turn-1 snapshot label no longer claims a CLI flag);
  `aipass-bridge/harness/harness.mjs` (`#makeChecker` reads the option, the
  verdict carries `declared`/`declaredSource`); `aipass-bridge/harness/bridge.mjs`
  (a token bucket in `BridgeClient`: one token per wire send, four at the
  start and one every 45 s, `AIPASS_RATE_BUCKET` overrides, abortable);
  `aipass-bridge/harness/rpc.mjs` (window harnesses ship the bootstrap
  snapshot on by default; the two new options travel from the sheet and the
  run call); `aipass-bridge/harness/settings.mjs` (the keys, clamped to one
  command line); `aipass-bridge/agent.mjs` (`--verify-command`, `--require-check`);
  `aipass-bridge/stats.mjs` (the two new fields aggregate);
  `desktop/ui/app.js` (the sheet's two fields and their validation);
  `scripts/test.mjs` and `aipass-bridge/test/harness.mjs` (the suite runs with
  pacing off); tests: new `aipass-bridge/test/rate-bucket.test.mjs`, plus
  `checker.test.mjs` (+3), `gates.test.mjs` (+1), `desktop.test.mjs` (+2),
  `settings-clamp.test.mjs`, `stats.test.mjs` (+1); docs: `CHANGELOG.md`,
  `docs/HARNESS_DESIGN.md`, `docs/SPEC_CHECKER.md`, `docs/LOOP_DESIGN.md`,
  `docs/SPEC_EVALS.md`, `docs/MATURITY.md`, `docs/EXPERIMENTS.md`,
  `desktop/README.md`, `experiments/queue.json` (one record `done`), this entry.
- **Tests**: targeted `validate`, `rate-bucket`, `checker`, `gates`, `desktop`,
  `settings-clamp`, `stats` — 81/81; full `npm test` 719 tests, 717 pass /
  0 fail / 2 skipped; `npm run agents:lint` ok (17 anchors / 703 titles);
  `node scripts/experiments.mjs --check` ok
  (8 records — 7 proposed · 1 done). The live arm: `node scripts/evals.mjs
  --task allow-clean-run --task ignore-injection --task refuse-run-leak
  --task refuse-secret --live --attempts 3 --budget maxCredits=4 --keep` —
  12/12 solved, 0 unsolved, 0 invalid, 0 stale, 0 FP and 0 FN, rows in
  `evals/results/2026-10-20T04-38-38-891-live.jsonl` with the attempt
  sessions kept beside it.
- **Deferred**: no `VERIFY` marker — the model still cannot ask for a check
  mid-run; the strict gate is opt-in and has no live evidence yet (only the
  stubbed and unit rows), so it ships off by default and the advisory path
  stays the shipped behavior. The bucket's numbers (4 / 45 s) are the measured
  envelope, not a tuned optimum: the next live matrix should say whether the
  pace cost wall time without buying refusals. `elision-tier`,
  `memory-tier-carry` and the SYMBOLS/DEF/REFS row still wait on measurement —
  no record was moved without a qualifying run.
- **Risks**: the shared checkout carried sibling WIP (`relocate.mjs`,
  `atomic-write.mjs`, `desktop/*.html`, and edits in `tools.mjs`,
  `sandbox.mjs`, `protocol.mjs`, `app.js`, …); those files were left alone and
  only the hunks above were touched. The token bucket is per `BridgeClient`,
  so two windows on one account each hold their own bucket — the account's
  limit is wider than one client. The safety-set evidence expires in 30 days
  (`docs/MATURITY.md`), and the next model-change gate must cite the rows,
  not this entry.
- **Cleanup**: nothing committed — the human owns the git shape; the queue
  record carries its result inline so a later session can see the evidence
  without the run. The live arm's temporary trees stayed under `%TEMP%`; only
  the JSONL and the attempt sessions were kept.

## 2026-10-18 — opencode — data flow: settings reach every project, and a moved project keeps its history

- **Files**: `aipass-bridge/harness/rpc.mjs` — the settings-owned values now
  reach every live harness: `settings.set` walks each parameter it was given
  across all of them (guards stay per-parameter, so a save that does not name
  the mode cannot stomp a run's own), `rules.set` swaps the array on every
  engine, `settings.reset` resets every harness through the new
  `applySettingsTo(h)` (the whole file onto one harness, explicit
  `compaction`/`model` pins respected like `harnessFor` does), and
  `switchProject` calls it for the harness being entered — a project first
  visited before the last save used to run that save's old temperature,
  budgets and path rules while every window said the new ones were in force;
  `config.set({model})` (the header dropdown's path) now lands on every
  harness too, not just the current one — it writes the same `defaultModel`
  the sheet does;
  `aipass-bridge/harness/session.mjs` (`SessionStore#reassign` — moves
  `sessions/<slug>` top level + `archive/`, breadcrumbs along, rewrites each
  header's `root`, repairs a torn header on the way, slug collisions re-key in
  place), `memory-store.mjs` (`moveMemory`, store dir injectable),
  `rules.mjs` (`RulesStore#moveRoot` — merge, never replace),
  `settings.mjs` (`Settings#moveProject` — list path + startup root, a
  renamed entry keeps its name), new `harness/relocate.mjs`
  (`relocateProject`, refuses a same path / a new path that is not a
  directory), new CLI `aipass-bridge/relocate.mjs` (refuses while the desktop
  backend answers on its port — it holds the old paths and open sessions in
  memory), `bin/aipass.mjs` (`relocate` case + help line),
  `desktop/src-tauri/tauri.conf.json` (the new CLI in the packaged
  resources — the guard in `desktop.test.mjs` caught it), `aipass-bridge/README.md`
  (command table); tests: new `aipass-bridge/test/data-flow.test.mjs` (11 —
  five settings-flow, five relocation, one real-spawn CLI run including the
  refusal), `aipass-bridge/test/restore-drill.test.mjs` (+1: the
  cross-machine drill, project unpacked at a new path, reconnected by
  `relocate`); docs: `CHANGELOG.md` (one Added, one Fixed), `docs/DATA_FORMATS.md`
  (the keys are absolute paths; Machine move + drill bullets in Recovery),
  this entry.
- **Tests**: targeted `data-flow` 11/11, `restore-drill` 3/3,
  `desktop` + `gates` 38/38, `rules` + `harness-qa` 21/21; full `npm test`
  682 tests, 680 pass / 0 fail / 2 skipped; `npm run qa` 8 ok / 1 warning
  (live backend not running — expected) / 0 failing; `npm run agents:lint` ok
  (17 anchors / 668 titles); `npm run evals:lint` OK. The first full run was
  red on two guards worth keeping: the compaction test pinned that a full
  re-apply must not stomp an explicit `compaction` option, and the packaged-
  resources guard demanded the new CLI be listed for the bundle.
- **Deferred**: no single-session import/export — the JSONL is addressable by
  id from any directory it sits in and the docs' "the files *are* the export"
  stands; `relocate` is the half a copy cannot do. No window-side button for
  relocation: the desktop backend holds harnesses keyed by the old path and
  open sessions, so a live version would have to move those too — the CLI
  refuses while it runs, which is the honest contract this round. Archived
  sessions are re-keyed but stay out of the picker, by design.
- **Risks**: shared repo — sibling WIP (`tools.mjs`, `sandbox.mjs`,
  `stability.test.mjs`, `server.mjs`, `protocol.mjs`, `app.js`, …) was left
  untouched. Entering a project now re-seeds its harness from the file: a
  per-run choice that was never saved (a transient mode/model) is back to the
  saved value on the next entry — intended, and the window always passes the
  sheet's values per run anyway. `relocate` refuses rather than warns when
  the backend is up, so a person who ignores it gets a clear error, not split
  data.
- **Cleanup**: probe scripts run inline; nothing left in `D:\aipass`.

## 2026-10-18 — opencode — data integrity: a torn header costs a picker line, never a session

- **Files**: `aipass-bridge/harness/atomic-write.mjs` (new — one
  temp-file-plus-rename swap plus the one `tighten`, shared by the stores
  below; `settings.json`/`mcp.json`/`.registry.json` keep their inline copies,
  untouched); `aipass-bridge/harness/session.mjs` (the in-place header
  rewrite writes the same header to `session-<id>.jsonl.hdr` first —
  atomically — and deletes it once the write completed; `readSessionHeader`
  falls back to the breadcrumb when the first line is torn, `load()` writes
  it back so the next open reads the file the ordinary way, and a breadcrumb
  next to a healthy header is ignored and cleaned; `list()` now requires
  `type: "header"` exactly like `load()` always did — an entry line (every
  entry carries a string `id`) used to list as a row that then refused to
  open; `remove()`/`archiveIdle()` take the breadcrumb along);
  `aipass-bridge/harness/rules.mjs` + `aipass-bridge/harness/memory-store.mjs`
  (whole-file saves became swaps — a failed save changes nothing, and a torn
  memory file no longer reads back as "a fresh project");
  `aipass-bridge/harness/overlay.mjs` (`applyToDisk` swaps each user file and
  pins the mode it replaces, so an exec bit survives; the overlay was the
  only "backup" an apply had); `aipass-bridge/test/data-integrity.test.mjs`
  (+5: entry-shaped first line, torn header recovered + repaired + breadcrumb
  gone, stale breadcrumb cleaned, failed memory save keeps old facts, applied
  edit keeps its mode); `aipass-bridge/test/rules.test.mjs` (+1: failed save
  keeps the previous rules); `aipass-bridge/test/harness-fixes.test.mjs`
  (H4's spy counts rewrite events, not raw writes — `writeFileSync` is a
  `writeSync` underneath on Node 24, so the breadcrumb write read as a second
  rewrite); docs: `CHANGELOG.md`, `docs/DATA_FORMATS.md` (the breadcrumb + the
  strict header test), this entry.
- **Tests**: targeted `data-integrity` + `rules` 30 tests, 29 pass / 0 fail /
  1 skipped (Windows modes); with `session-resume` + `compact` 62 tests,
  61 pass / 0 fail; `harness-fixes` 28/28; full `npm test` 669 tests,
  667 pass / 0 fail / 2 skipped; `npm run qa` 8 ok / 1 warning (live backend
  not running — expected) / 0 failing; `npm run agents:lint` ok (17 anchors /
  654 titles); `npm run evals:lint` OK.
- **Deferred**: `authtoken.mjs` writes the token in place — a torn write
  self-heals (every reader sees the same bytes; an empty file re-mints), so it
  was left alone. Orphaned `*.jsonl.tmp` / `*.hdr.tmp` files from a crash are
  ignored by every reader and overwritten by the next save of the same name —
  sweeping them would risk deleting a concurrent writer's live temp.
- **Risks**: shared repo — the sibling's `tools.mjs` / `sandbox.mjs` /
  `stability.test.mjs` WIP was left untouched; its new tree-kill test flaked
  twice on this machine (EPERM on temp cleanup — a Windows handle race, not
  this round) and passed on the final runs. The breadcrumb adds one small
  atomic write per header rewrite: a rewrite is now breadcrumb write + 2 KB
  in-place write + unlink, still O(1) and still batched by `HEADER_EVERY`.
- **Cleanup**: debug script in `C:\Users\ASUS\testlogs\` only; nothing left in
  `D:\aipass`.

## 2026-10-18 — opencode — long runs and the whole window: streams stay in their session, timeouts take the whole tree

- **Files**: `aipass-bridge/harness/rpc.mjs` — harness events now carry
  `session`: `runSessions` records the session a run started in, read once at
  the `run` boundary, so a `session.open` that moves `h.session` mid-run does
  not move the tag; `run` also captures its harness before the first await
  (another window's project switch used to be able to repoint the run's next
  attempt, its policy and its pending list), and `switchProject` closes the
  MCP clients of the idle harness it leaves behind (idle children used to
  collect one set per project the backend ever ran in). `desktop/ui/app.js` —
  `onRun` drops frames tagged for another session; the `session` announcement
  is exempt, since adopting the new id is how the window follows a run that
  opens a session. `aipass-bridge/harness/tools.mjs` — `runShell` + `killTree`
  replace `execP` for `RUN` and `GIT`: bounded capture, the same
  `code`/`signal`/`stdout`/`stderr` rejection shape, and a timeout that takes
  the whole process tree down (`taskkill /T` on Windows, a process-group
  signal elsewhere). The first version killed the shell first and *then* ran
  `taskkill` — by the time it ran there was no tree left to walk, and the
  grandchild outlived its timeout; the shipped order leaves the shell
  standing while `taskkill /T` walks. Tests: `desktop.test.mjs` (+3),
  `ui.test.mjs` (+1 — my first version read `textContent`, but prose paints
  as `innerHTML` segments, so the frame it asserted on was invisible to it),
  `stability.test.mjs` (+1; its header now names four failure modes).
  `CHANGELOG.md`, this entry.
- **Tests**: `desktop.test.mjs` 25/25; `ui.test.mjs` 71/71; `stability` +
  `tools` + `tools-aci` + `run-overlay` + `run-resilience` + `permissions`
  57/57; `desktop-window` + `session-resume` + `stability` + `plan` +
  `run-resilience` 52/52; loadtest (`npm run loadtest -- --strict`) — 400
  calls, p95 46 ms, 0 failures, RSS +21.9 MB (70→92) against the documented
  budget (`docs/RELIABILITY.md`). Full `npm test`: 670 tests, 668 pass, 0
  fail, 2 skipped.
- **Deferred**: the window still replays a very long session whole (snapshot +
  `session.open`) — the next scale problem; a cap needs a "show older"
  affordance so history is not silently hidden.
- **Open risks**: POSIX tree-kill is code-reviewed only; this machine
  exercises the Windows `taskkill` branch. `runShell` truncates at exec's
  10 MB `maxBuffer` instead of erroring on it — a >10 MB command now finishes
  with clipped output rather than failing.
- **Cleanup**: ad-hoc kill-test experiment scripts and temp dirs under
  `%TEMP%` removed; orphan processes from the first tree-kill attempt stopped.

## 2026-10-18 — opencode — session resume: a session owns its conversation

- **Files**: `aipass-bridge/harness/session.mjs` (`Session#bindConversation` —
  the conversation id + temporary flag persist on the header through the same
  atomic header rewrite; a `fork` starts unbound, since a branch is not a
  second writer); `aipass-bridge/harness/harness.mjs` (`startSession` adopts
  the opened session's binding and drops a conversation that belongs to
  another session — `/new` and `session.open` used to keep talking in
  whatever conversation the harness was last on; `#resumeDigest` /
  `#resumeSeed` build a bounded transcript digest for a session whose
  conversation is gone; `replaceDeadConversation` swaps a conversation the
  upstream 404s; `#settleConversation` binds + commits the resume boundary
  only after a send is accepted, and the run's finally drops a conversation
  that never took a message, so a failed first send re-seeds next run);
  `aipass-bridge/harness/loop.mjs` (`onConversationDead` failover on the
  run's first send — checked before the wait-and-retry ladder, since a dead
  named conversation never heals by waiting — plus the `onConversationSettled`
  hook after every accepted send; the between-runs rotation check now skips
  when a seed is already in hand); `aipass-bridge/test/session-resume.test.mjs`
  (new — bleed, warm resume, digest seed with a tiny budget proving the
  boundary stops a spurious rotation, dead-conversation failover);
  `aipass-bridge/test/data-integrity.test.mjs` (+1: binding round-trips a
  rewrite, fork unbound, clear removes both fields); docs: `CHANGELOG.md`,
  `desktop/README.md` (the two-kinds-of-conversation section), this entry.
- **Tests**: `session-resume.test.mjs` 4 pass / 0 fail; `compact.test.mjs`,
  `data-integrity.test.mjs`, `ask.test.mjs`, `harness-fixes.test.mjs`,
  `restore-drill.test.mjs`, `desktop*.test.mjs` 73 pass / 0 fail; full
  `npm test` 651 tests, 649 pass / 0 fail / 2 skipped; `npm run qa` 8 ok /
  1 warning (live backend not running — expected) / 0 failing;
  `npm run agents:lint` 17 anchors over 637 titles; `npm run evals:lint` OK.
- **Deferred**: the digest is a deterministic transcript slice (tasks + the
  model's last words + the checklist), not a model summary — a resume asks no
  extra question and costs no credits, but a very long tail of work between
  the last compaction and the close compresses to those three facts; a real
  transcript-to-summary path would need the entries pasted into the question
  and was not asked for. A conversation adopted while its upstream copy is
  alive is trusted as warm — the 404 fallback catches the dead case only when
  a send proves it.
- **Risks**: shared repo — the sibling's `PLUGINS_MCP_DESIGN.md` / window WIP
  left untouched; the earlier `agent.mjs` prepareConversation behavior
  (banner prints the conversation before any session exists) is pinned by
  keeping a harness-level pre-session conversation instead of clearing it;
  `startSession` now touches conversation state, which is exactly the
  sibling's WIP seam — a merge there must keep the binding-adoption rules.
- **Cleanup**: debug script in the temp dir only; nothing left in `D:\aipass`.

## 2026-10-18 — opencode — long runs: the DONE checkpoint, gates that always release, a checklist that rides

- **Files**: `aipass-bridge/harness/loop.mjs` (`openTodoMsg` — a DONE that
  arrives with the run's own checklist still open earns exactly one ask that
  names up to 8 items and teaches the tick that closes them; a second DONE
  always ends the run, so the checkpoint is a question, never a gate;
  `todoPrompts` is recorded in `run_stats`, and the mid-run rotation seed
  carries `todoState`); `aipass-bridge/harness/harness.mjs` (`#sessionTodo()`
  — the latest `todo` entry rides every seed, manual `/compact` and
  between-runs rotation included; `cancel()` aborts first, then
  `answerPlan(false)`, then `permissions.cancelPending()`; `pendingAsks()`);
  `aipass-bridge/harness/rpc.mjs` (`snapshot` carries `asks`, so a reloaded
  window can put the plan/permission modals back); `aipass-bridge/harness/
  compact.mjs` (`seed` renders the checklist); `aipass-bridge/harness/
  permissions.mjs` (`pendingList`); `desktop/ui/app.js` (`restoreAsks()`
  re-opens the modals a reload lost, `todo` entries replay); tests:
  `plan.test.mjs` (once-per-run checkpoint, second-DONE honors the ending),
  `desktop.test.mjs` / `desktop-window.test.mjs` (gate restore, cancel
  release), `lang-guard.test.mjs` (the scripted loop harness); docs:
  `CHANGELOG.md`, `docs/LOOP_DESIGN.md`, this entry.
- **Tests**: full `npm test` 573 tests, 573 pass / 0 fail / 2 skipped;
  `npm run qa` 9 ok / 0 warning / 0 failing; `npm run agents:lint` 561 titles
  OK; `npm run evals:lint` OK. Collateral drift fixed in the same pass:
  `ui.test.mjs`'s palette expectations now include `/memory` `/mcp`, and the
  replay fingerprint was re-baselined after the preamble change
  (`evals/fixtures/math-fix-replay.json`).
- **Deferred**: the checkpoint names at most 8 items with a "… and N more"
  tail — a longer list is summarized rather than enumerated (the cap keeps
  the ask bounded; the card carries the full list); no headless test pins the
  modal-restore pixels, only the RPC payload and the replay calls.
- **Risks**: reload mid-plan-gate used to hang the run forever and refuse
  later ones ("a run is already in flight"); the cancel order is
  load-bearing — abort must come first or the loop reads the ending as
  `plan-rejected` instead of `cancelled`. `todoPrompts` is a new `run_stats`
  field (additive).
- **Cleanup**: patch scripts removed from `D:\aipass`; logs under
  `C:\Users\ASUS\testlogs`.

## 2026-10-18 — opencode — stability pass: the plan card holds still, the session race loses

- **Files**: `desktop/ui/app.js` (`renderTodo` normalizes wire data, updates
  an unchanged row in place and preserves the list's scroll through a
  rebuild; new module-level `viewSeq` — the newest session choice owns the
  screen, so `openSession` / `startNewSession` can no longer interleave with
  a load still in flight); `aipass-bridge/harness/protocol.mjs` (`mergeTodo`
  folds repeated texts: one row per distinct item, and a duplicate an older
  build wrote collapses on the next merge; the comment now states done is
  sticky); `aipass-bridge/test/plan.test.mjs` (+2 merge specs);
  `aipass-bridge/test/ui.test.mjs` (+4 specs: an in-place tick keeps the row
  node, scroll survives a longer update, a malformed `todo` frame is
  dropped, the second session click wins over a slow first load); docs:
  `CHANGELOG.md`, `docs/LOOP_DESIGN.md` (step 7 + tests table), this entry.
- **Tests**: `plan.test.mjs` 6 pass / 0 fail; `ui.test.mjs` 68 pass / 0 fail;
  full `npm test` 646 tests, 619 pass / 25 fail / 2 skipped — every failure
  sits in `agent.test.mjs` / `compact.test.mjs` (conversation-creation
  counts), the sibling's live conversation-ownership refactor of
  `harness.mjs`; none in this work's files.
- **Deferred**: the in-place path keys on text order — a reordered list
  rebuilds (rows are cheap and the scroll survives it); the 26vh bound still
  has no headless test.
- **Risks**: shared repo — the sibling `harness.mjs` / `loop.mjs` /
  `session.mjs` / `PLUGINS_MCP_DESIGN.md` WIP left untouched; the full-run
  numbers carry their 25 failures, so a green full suite waits for their
  refactor to land.
- **Cleanup**: none.

## 2026-10-18 — opencode — the plan card: ticks that register, a bounded list, and what comes next

- **Files**: `aipass-bridge/harness/protocol.mjs` (`parseTodo` now strips the
  bullet before judging done — `- [x]` and `* [x]` tick like bare `[x]`; the
  reported bug was the checklist never ticking in the shape models actually
  write); `aipass-bridge/harness/loop.mjs` (`finished` and the run result
  carry the run's final `todo` state); `desktop/ui/app.js` (the plan card is
  one element per session: header `plan & todo · done/total`, `complete`
  class, `clearTodo()` on new session / session open / deleting the open
  session, `todo` entries replayed in `openSession`, and the `finished`
  handler re-tallies from `todo` — a `done` ending with items open names how
  many and offers the one-click carry-on, a clean one says the checklist
  closed); `desktop/ui/styles.css` (`.panel ul` bounded at 26vh and scrolling;
  `.panel.complete h4` green); `aipass-bridge/test/plan.test.mjs` (new — tick
  forms, the once-per-run DONE checkpoint, `finished.todo`); 
  `aipass-bridge/test/ui.test.mjs` (+6 card specs, and the compaction spec
  stays); docs: `CHANGELOG.md`, `docs/LOOP_DESIGN.md` (DONE pipeline, steps
  7/12, guards + tests tables), `desktop/README.md`.
- **Tests**: `plan.test.mjs` 4 pass / 0 fail; `ui.test.mjs` 60 pass / 0 fail;
  full `npm test` 630 pass / 0 fail / 2 skipped (both pre-existing); touched
  `.mjs`/`.js` syntax-checked.
- **Deferred**: un-ticking an item stays impossible (`mergeTodo` keeps `done`
  sticky by design — the card is a closing record, and reopening was not
  asked for); the 26vh bound is CSS with no headless test; the card's
  horizontal alignment against the transcript column was left as found.
- **Risks**: shared repo — the sibling `rpc.mjs` / `mcp.mjs` /
  `plugins.test.mjs` WIP left untouched; `finished.todo` is a new field (a
  consumer deep-equal'ing the whole payload would need it added — none does);
  a second run in one session that writes no plan leaves the previous card
  standing (the card is the session's checklist, not the run's).
- **Cleanup**: none.

## 2026-10-18 — opencode — UX: design first, then the window and the popup

- **Files**: `docs/UX.md` (new — principles, surfaces, ranked pain points
  P0–P2, implementation order, open questions, §7 status of what shipped);
  `aipass-bridge/extension/popup.{html,js}` (Advanced gains "Paste from
  clipboard" — the token `aipass setup` copies — and "Test connection", which
  distinguishes OK / token-rejected / bridge-answered); `desktop/ui/index.html`
  (hardcoded "Kasem" user card removed; 🧠 memory details group with `memory`,
  `memory-head`, `memory-clear`); `desktop/ui/app.js` (`clickable()` makes
  sessions/skills/files rows Enter/Space operable; `setHint()` + pulsing dot
  while a run is in flight; `friendly()` maps the six common loop failures to
  Thai with the next action, used at the stream error, send catch, attachment
  and project-switch paths; `/memory`, `/mcp`, `/symbols` slash commands +
  `showMemory`/`showMcp`/`showSymbols`; `refreshMemory()` + forget-all wiring;
  `applyTheme` sets the theme-toggle glyph to the theme it will switch to);
  `desktop/ui/styles.css` (`#hint.busy` pulse); `harness/harness.mjs`
  (`crossSessionMemory()` / `clearCrossSessionMemory()` public accessors);
  `harness/rpc.mjs` (`memory.list`, `memory.clear`, `mcp.list` methods —
  disjoint hunks beside the sibling temperature WIP); `test/ui.test.mjs`
  (+2 behavioral specs: a session row opens with Enter, the memory panel
  lists facts and forget-all clears them — the latter caught that the panel
  was only wired to the project-switch path, never to boot; boot now calls
  `refreshMemory()`; also fixed a `toast()` call that had slipped in from the
  popup's vocabulary).
- **Tests**: `ui.test.mjs` 51 pass / 0 fail; `desktop-window.test.mjs` 17 pass
  / 0 fail (includes the "window only reaches for elements that exist"
  id-contract test against the edited html/js); `desktop.test.mjs` 21 pass /
  0 fail; `node --check` clean on `app.js`, `popup.js`. The full suite's red
  cells are unchanged and not this wave: the stale evals replay (needs a live
  run) and the sibling temperature WIP in `settings.mjs`.
- **Deferred**: a popup "Copy path" button is **not possible** — Chrome
  exposes no filesystem path to the extension (documented in UX.md §7); the
  error map is the first six failures only, to widen as the field reports more;
  P0.2 (no-tab recovery) and P1.3 (context tooltip) were already shipped and
  were left as found.
- **Risks**: `harness/rpc.mjs` and `harness/harness.mjs` edits sit in files the
  sibling temperature wave also touches — hunks are disjoint (new methods,
  accessors) but keep the commit split apart; `memory.list` answers from the
  live harness, so a run in flight shows the list as it stands.
- **Cleanup**: none.

## 2026-10-17 — opencode — the five capabilities from the gaps report

- **Files**: `harness/mcp.mjs` (new — stdio JSON-RPC client:
  initialize/tools-list/tools-call; config `~/.aipass/mcp.json` or
  `<project>/.aipass/mcp.json`; a server that fails to connect is skipped,
  never fatal; tools ride the plugin table as `MCP__<server>__<tool>`);
  `harness/symbols.mjs` (new — zero-dependency regex symbol index for 15+
  languages, cached under `~/.aipass/symbols`, refreshed on mtime change);
  `harness/memory-store.mjs` (new — facts per project in
  `~/.aipass/memory/<hash>.json`, case/space-insensitive dedupe, 200 chars per
  fact, cap 50); `harness/tools.mjs` (SYMBOLS / DEF / REFS tools);
  `harness/protocol.mjs` (the new markers + preamble lines);
  `harness/loop.mjs` (SUBAGENT `background: true` returns a job id at once,
  JOBS polls, finished results are injected at the next step start — no
  nesting); `harness/harness.mjs` (`scale(task, n)` — best-of-N by check
  verdict, max 5; cross-session facts loaded into a session's first turn; MCP
  tools merged); `bin/aipass.mjs` + new `mcp.mjs` / `memory.mjs` / `scale.mjs`
  CLIs (`aipass mcp [list|call]`, `aipass memory [list|clear|path]`,
  `aipass scale "task" [--n N] [--allow-run]`); docs: `MATURITY.md` (four new
  experimental rows; scaling row moved not-shipped → experimental),
  `CHANGELOG.md`, `README.md` (tool table + Extra capabilities).
- **Tests**: `agent.test.mjs` 50 pass / 0 fail; `ui.test.mjs` 49 / 0; all new
  and changed `.mjs` syntax-checked. Full suite red only on the evals replay
  (`stale` vs `solved` — the preamble gained markers, so the recorded digest no
  longer matches) and the sibling temperature WIP; both pre-date this wave or
  belong to it elsewhere.
- **Deferred**: the new experimental MATURITY rows have no
  `experiments/queue.json` records yet; the evals replay fixture stays stale
  until a live re-run is approved (credits).
- **Risks**: MCP servers are user-configured child processes — the config file
  is the trust boundary (stated in the module header); the preamble change
  invalidates recorded transcripts, so any other recorded fixtures should be
  re-recorded against a live run before claiming green.
- **Cleanup**: none.

## 2026-10-17 — opencode — install easier + docs as our own work

- **Files**: `aipass-bridge/setup.mjs` (new — one-command setup: Node check, state dir + token mint, PATH install, clipboard copy, bridge start, browser pages); `aipass-bridge/bin/aipass.mjs` (`setup` case + HELP); `package.json` (`setup` script); `aipass-bridge/install.sh` / `install.ps1` / `aipass-bridge/README.md` / `bin/aipass.mjs` (Node floor 18 → 20); `README.md` (Where this stands rewritten to lead with our work + compact niawjunior credit + influences note; Quick start + Development feature `aipass setup`); `aipass-bridge/README.md` (borrowed upstream screenshots removed; `aipass setup` in Setup); `desktop/README.md` (pi comparison table rewritten as constraint table + prior-art note); `desktop/ui/app.js` (temperature chip initialized on boot — one line, fixing a committed bug). Scope per user: root + component READMEs only; attribution: our voice with compact influences note; install: `aipass setup`.
- **Tests**: `npm run agents:lint` ok (15 anchors); `ui.test.mjs` 49 pass / 0 fail; `aipass setup --no-open` runs end to end (adopts existing bridge, 1 extension connected). `npm test` overall red only because of the sibling session's in-progress temperature WIP in `settings.mjs` (chat.test.mjs 2 fails); reverting that file restores 16/0 — not my change. `setup.mjs` syntax-checked.
- **Deferred**: broader docs/ pass (HARNESS_DESIGN, LOOP_DESIGN, …) not done — out of chosen scope; borrowed screenshots removed rather than replaced (user to capture own); chat.test.mjs failure left for the sibling session's temperature wave to reconcile.
- **Risks**: `aipass setup` opens browser pages by default (`--no-open` to skip); assumes a local clone (repo is private, no remote one-liner). `desktop/ui/app.js` edit is a one-line fix to committed code; if the sibling's temperature wave rewrites that area, re-check. No push, no commit.
- **Cleanup**: removed the temporary git worktree used for the clean-tree check; no temp files left.

## 2026-10-17 — opencode — the context manager's newer two tiers: elision and memory

- **Files**: `harness/compact.mjs` (the elision pass in the summarisation
  transcript — `transcriptFor`, `elideStaleResults` off by default,
  `AIPASS_ELIDE`; the memory tier — the prompt's `MEMORY:` ask plus
  `splitSummary`/`memoryOf`/`mergeMemory`/`digest`, on by default,
  `AIPASS_MEMORY=off`; `seed` pins the merged facts, and a seed without them
  is byte-identical to before); `harness/loop.mjs` (the mid-run rotation
  digests the reply and records `memory` on the compaction entry);
  `harness/harness.mjs` (`compactNow` digests and returns `memory`;
  `rememberSummary(summary, memory)` rides the next run as
  `{summary, memory}`); `harness/rpc.mjs` (compact passes the facts on);
  `harness/session.mjs` (the compaction shape comment); tests:
  `compact.test.mjs` +10 (elision off/on and its exemptions, the env
  switches, the split/merge/cap rules, digest's off-switch, the factless
  seed staying byte-identical, facts through a mid-run rotation and through
  a manual one). Docs: `HARNESS_DESIGN.md` (the compressor section; the env
  list; the hook map row), `MATURITY.md` (elision row → experimental; the
  new memory row), `DATA_FORMATS.md` (§Memory + the entry table),
  `TEST_PLAN.md` (L3.6 arm line, new L3.7, the L4 rows),
  `experiments/queue.json` (`memory-tier-carry`) + its test's id list,
  `CHANGELOG.md`, `LOOP_DESIGN.md` (contract 11), `aipass-bridge/AGENTS.md`
  (env block), `README.md` (badge).
- **Tests**: `npm test` 568 pass / 0 fail / 2 skip (570); `npm run qa` 9 ok /
  0 warn / 0 fail; `npm run agents:lint` ok (556 titles); `npm run evals:lint`
  OK; `npm run experiments -- --check` OK (8 proposed).
- **Deferred**: both queue records stay `proposed` — no live credits spent;
  the elision default and the memory graduation are the records' to decide.
  The checker's `done-unverified` question stays open with them.
- **Risks**: the memory facts are model-authored — capped, deduped, marked
  "re-check" in the seed, and measured by `memory-tier-carry`; until that
  record ends, the tier is experimental by its own registry row. The tree is
  shared with other sessions — keep this wave's commit split apart.
- **Cleanup**: no temp files.

## 2026-10-17 — opencode — the memory audit, and the session store made owner-only

- **Files**: `harness/loop.mjs` (the seed is no longer gated on `first` —
  between-runs compaction fires on non-first runs by definition; rotate moved
  before the compaction append); `harness/harness.mjs`
  (`rememberSummary`/`#pendingSummary` — a manual rotation's seed is built at
  the next run, against that run's own task; `#stagedList()` shared by both
  seed paths; rotate-before-append); `harness/rpc.mjs` (`compact` records the
  summary and refuses while a run is in flight; staged upload copies without
  a path are 0o600 and copied files are tightened); `harness/compact.mjs` (the
  divisor samples the post-compaction window; dead `listing` param removed);
  `harness/session.mjs` (the store, its per-project dirs and every session
  file are created 0o700/0o600, an old file is tightened when opened);
  `harness/settings.mjs` (the upload staging dir is owner-only when created);
  `SECURITY.md` (the mode claim + the Windows ACL boundary);
  `compaction` entries now carry `lastSummarizedEntryId`;
  `docs/DATA_FORMATS.md` §Memory + §Retention updated; tests:
  `compact.test.mjs` +5 (between-runs seed, manual seed consumed once,
  rotate-fail ledger, mid-run rotate-fail, divisor window — fail-before
  verified for the guard and the divisor), `harness-qa.test.mjs` (the manual
  seed reaches the next run over RPC; compact refuses in flight),
  `data-integrity.test.mjs` +1 (POSIX-only mode assertions). Temperature wave:
  `harness/settings.mjs` (`temperature` default + sane() clamp 0..2),
  `bridge/server.mjs` (chatCompletions reads/clamps temperature + logs a
  warning for ignored OpenAI sampling fields; startChat/Job carry it into the
  extension dispatch frame), `harness/bridge.mjs` (#sendOnce sends it),
  `harness/loop.mjs` (options.temperature → clamped number), `harness/rpc.mjs`
  (harnessFor + live apply in settings.set), `agent.mjs` (--temperature flag +
  validation + header print), `chat.mjs` (--temperature flag, /temperature
  REPL command with picker, banner row), `desktop/ui/index.html` + `app.js`
  (temperature chip beside the effort chip), `docs/DOCS.md`,
  `desktop/README.md`, `CHANGELOG.md`. Tests: `settings-clamp.test.mjs` +5
  asserts (temperature clamp/fallback inside the existing test),
  `bridge.test.mjs` +2 (temperature ride/clamp/null-drop/warning +
  ignored-fields warning), `agent.test.mjs` +1, `chat.test.mjs` +1,
  `ui.test.mjs` +1 — the suite now stands at 575.
- **Tests**: `npm test` 573 pass / 0 fail / 2 skip (575 — the skip is the
  POSIX-only mode test on Windows, where it cannot mean anything; the CI
  Linux/macOS lanes run it); `npm run qa` 9 ok / 0 warn / 0 fail;
  `npm run agents:lint` ok (561 titles); `npm run evals:lint` OK. Nothing
  committed. First full run after the wave failed 20 (temperature edit had
  replaced `let thinkingLevel` in `chat.mjs` and `this.video = video` in the
  Job constructor); both restored, the rerun is green.
- **Deferred**: a small session reopened in a fresh process still hands the
  model only the new run's task (no compaction entry exists to seed from) —
  that is the `memory-cold-warm` probe's question, not a bug this round was
  allowed to answer.
- **Risks**: reused-session eval rows measured before this change saw less
  summary than the design intends; re-baseline before comparing rows across
  the change. The tree is shared with other sessions (loop guards, plugin
  risk) — commit splits must keep the waves apart.
- **Cleanup**: no temp files; the sidecar artifact is in place (gitignored).

## 2026-10-17 — opencode — the hook leftovers closed: latency, the commit gate, the snapshot

- **Files**: `harness/loop.mjs` (per-kind `ms` in `toolStats` — parallel
  SUBAGENTs timed at their fan-out; the red-test gate in `guarded()` ahead of
  the repeat guard; `turns` + `commitBlocks` in `run_stats`; the
  `--snapshot` builder appended to the turn-1 listing; plugin markers with a
  declared risk routed through the permission engine);
  `harness/permissions.mjs` (new `isGitCommit` export; `evaluate`/`request`
  take an explicit `risk` override); `harness/plugins.mjs` (`register`'s
  optional `risk`, validated at load, carried in `toolTable()`);
  `aipass-bridge/stats.mjs` (per-kind `ms` aggregate + `commit-gate` line);
  `agent.mjs` (`--snapshot` flag + help); tests: `gates.test.mjs` §5–6
  (commit gate: refuse → check → commit runs → re-arm; no-check control;
  plugin risk asked/denied/allowed/undeclared), `stats.test.mjs`,
  `lang-guard.test.mjs`, `agent.test.mjs` (snapshot on/off), `plugins.test.mjs`;
  docs: `HARNESS_DESIGN` (hook rows + worth-closing list — all closed),
  `LOOP_DESIGN` (execute order + guards table + the one hard bar),
  `SPEC_CHECKER` §As shipped 4, `SPEC_EVALS` metrics row, `desktop/README`
  (plugin risk), CHANGELOG, README badge (403 → 552 passing). 546 → 553 tests.
- **Tests**: `npm test` 552 pass / 0 fail / 1 skip (553); focused runs green
  (gates, stats, lang-guard, plugins, agent) before the full one; `npm run
  agents:lint` ok (539 titles); `npm run evals:lint` OK (111 fail-before, 50
  pairs); `npm run qa` 9 ok / 0 warn / 0 fail.
- **Deferred**: the checker's `done-unverified` decision (open question 2) and
  the elision tier stay deferred on purpose — both wait on their experiments'
  data (`MATURITY.md`, `EXPERIMENTS.md`); building them now would be the guess
  the data gate exists to stop. The seven live experiments remain `proposed`
  (no tab/account this session — qa's live line says 0 extensions).
- **Risks**: the commit gate changes behavior for every project carrying
  `.aipass/check.txt` — a `git commit` RUN now requires the declared check to
  have passed at the current tree state (loud refusal naming the command;
  delete/rename the file to opt out). `run_stats.tools` grew `ms` and
  `run_stats` grew `turns`/`commitBlocks` — readers pinning the old shape
  need field-aware checks (`stats.test.mjs` is the example).
- **Cleanup**: nothing outside the repo; suite temp dirs only. Went into the
  batch commit covering the sessions' pending work, once the whole tree went
  green (559 tests, `qa` 9 ok); personal untracked pages (desktop research
  notes, fortune/snake) left out on purpose; nothing pushed. If a history
  split is wanted later, the waves are separable at hunk level — `loop.mjs`'s
  regions and the doc bullets (see the memory audit's risk note).

## 2026-10-17 — opencode — macOS: the CI lane, and the branches made testable

- **Files**: `.github/workflows/test.yml` (`macos-latest` × Node 22/24);
  new `harness/open-command.mjs` + its callers (`harness/rpc.mjs`
  `openBrowser`, `desktop/main.mjs` `openWindow` — the duplicated platform
  branch is one rule now); `desktop/sidecar/fetch-node.mjs` (exports
  `targetTriple(platform, arch)`, runs its copy only when invoked);
  new `test/platform.test.mjs` (3 cases: argv shapes, allowlist-before-spawn,
  mac triples); `desktop/README.md` (the lane note). 543 → 546 tests.
- **Tests**: `npm test` 545 pass / 0 fail / 1 skip (546); `npm run qa` 9 ok /
  0 warn / 0 fail; `npm run agents:lint` ok (532 titles); `npm run evals:lint`
  OK. `npm run desktop:sidecar` ran end to end after the refactor (same
  output, 93 MB, node v24.18.0). Nothing committed.
- **Deferred**: the clipboard reader's darwin branch (`pngpaste`/`osascript`
  in `chat.mjs`) stays unpinned — it needs a real clipboard, which CI does
  not have; the packaged window/tray still needs a hand on a Mac.
- **Risks**: the macOS lane is unverified until the first push — CI has never
  run on darwin, so a red mac job is a finding, not a surprise.
- **Cleanup**: sidecar artifact refreshed in place (gitignored); no temp
  files left.

## 2026-10-17 — opencode — the test plan landed: L1 cases, the absence gate

- **Files**: the six suite files named in `docs/TEST_PLAN.md` L1 —
  `aipass-bridge/test/{evals,secret-screen,ssrf,data-integrity,experiments,evals-compare}.test.mjs`
  (11 new cases: digest stability + a moved fixture byte, the 429-storm
  `invalid` row, quiet summary slices, piped/composed secret spellings,
  literal private hosts, bare-compaction rendering, unknown entries through
  a rewrite, the queue's `--json` order, new/absent/wall/old-shape
  comparator cases); `scripts/evals-compare.mjs` (absence gate);
  `harness/session.mjs` (`(no summary)` placeholder); `docs/SPEC_EVALS.md`
  (the gate text says absence counts as 0); CHANGELOG. 532 → 543 tests.
- **Tests**: `npm test` 542 pass / 0 fail / 1 skip (543); `npm run qa` 9 ok /
  0 warn / 0 fail; `npm run agents:lint` ok (529 titles); `npm run evals:lint`
  OK; `npm run experiments -- --check` OK (7 records). Nothing committed.
- **Deferred**: the L1 cases that need code or a network the suite cannot
  touch — a public host resolving private (would need a DNS round trip; the
  literal-resolve path is pinned instead).
- **Risks**: the comparator now fails when a candidate run omitted a baseline
  task, so a `--task`-only candidate no longer compares green against a full
  baseline — intended, but the PR moving a default should say it.
- **Cleanup**: test temp dirs only; a debug script in `%TEMP%\opencode`.

## 2026-10-17 — opencode — audit round 5 closed: experiments, comparison, safety twins, maturity

- **Files**: the G16–G22 wave — `docs/EXPERIMENTS.md` + `experiments/queue.json`
  + `scripts/experiments.mjs` (the experiment system, seeded from the audit);
  `scripts/evals-compare.mjs` (candidate-vs-baseline gates as exit codes);
  `docs/MATURITY.md` (capability status + owner roles); `scripts/evals.mjs`
  (row `category`/`taskDigest`/`treeDigest`/`promptDigest`/`env`, `--keep`,
  `liveOnly` skipped in replay, `by category:`/`mixed outcomes:`/`pair drift:`
  summary lines); `harness/session.mjs` exports `APP_VERSION`; new eval tasks
  `sum-numbers(-twin)`, `count-lines(-twin)`, `refuse-run-leak`,
  `allow-clean-run`; `refuse-secret`'s check now demands the `denied` ending
  (it passed on an untouched tree — `evals:lint` was red on master);
  `SPEC_EVALS.md` (gates, routing, safety error rates + expiry),
  `DATA_FORMATS.md` (memory), `RELEASE.md` (safety freshness), README, AGENTS,
  CHANGELOG, `package.json` (`evals:compare`, `experiments`).
- **Tests**: `npm test` 531 pass / 0 fail / 1 skip; `npm run qa` 9 ok / 0
  warn / 0 fail; `npm run agents:lint` ok; `npm run evals:lint` green — 111
  checks fail-before (was failing on master over `refuse-secret`).
- **Deferred**: the queue's six records are all `proposed` — they need live
  runs to end. Heads of the queue: `safety-twin-controls`, `attempts-floor`.
- **Risks**: `SPEC_EVALS.md` grew several sections; audits that cite line
  numbers must anchor on section names. Safety rows from before this change
  are not comparable (live-only is now enforced; `refuse-secret` scores
  differently). Nothing was committed — the working tree carries the wave.
- **Cleanup**: temp dirs from lint/tests only; nothing left in the repo.

## 2026-10-18 — opencode — a follow-up task remembers the listing instead of re-pasting it

- **Files**: `aipass-bridge/harness/loop.mjs` (the delta: per-conversation
  `listingShown` lookup, the `listingToRecord` composition, the record on the
  first accepted send), `aipass-bridge/harness/harness.mjs` (`#listingShown`
  Map, handed to the run) `aipass-bridge/test/agent.test.mjs` (the `--watch`
  test updated to the new contract + a "tree moved" sibling that proves the
  full table comes back), `aipass-bridge/test/compact.test.mjs` (a rotation
  forgets the memory, so the next follow-up pastes the table again),
  `docs/HARNESS_DESIGN.md`, `CHANGELOG.md`, `docs/WORKLOG.md`.
- **Contract change**: `--watch`/same-conversation follow-ups used to re-paste
  the whole top level on every task (issue #32's ground-truth fix). The frame
  is still restated every time; a listing identical to the one the
  conversation was last shown becomes a one-line "unchanged" note, and any
  other case — tree moved, conversation created, rotated, or pinned fresh —
  still gets the full table. The memory is written only after the carrying
  message was accepted, so a failed send can never become a false "unchanged".
- **Tests**: `npm test` green on this machine (one git-absent skip);
  `npm run agents:lint` and `npm run evals:lint` green. `node --check` on
  every touched file.
- **Deferred**: the elision tier, test-time scaling (best-of-N via the
  checker), and the live skills smoke once credits allow.
- **Risks**: low — the only change is fewer bytes on follow-ups; a miss
  (unknown conversation) degrades to today's full paste, never to a wrong
  claim, because the note is only ever sent when the identical listing was
  accepted by that same conversation.
- **Cleanup**: none needed.

## 2026-10-18 — opencode — per-model context budgets and a tunable tool-result cap

- **Files**: `aipass-bridge/harness/compact.mjs` (exported `DEFAULT_MODEL_BUDGETS`),
  `aipass-bridge/harness/harness.mjs` (fallback to it when compaction names none),
  `aipass-bridge/harness/settings.mjs` (defaults + clamp for `maxResult` and
  `compaction.budgets`), `aipass-bridge/harness/rpc.mjs` (passes `maxResult`
  through), `desktop/ui/app.js` (a `maxResult` row + validation), `CHANGELOG.md`,
  `docs/WORKLOG.md`, `aipass-bridge/test/compact.test.mjs` (one new test).
- **Tests**: `npm test` green on this machine (one git-absent skip);
  `npm run agents:lint` and `npm run evals:lint` green. `node --check` on every
  touched file.
- **Deferred**: listing-delta, elision tier, test-time scaling (best-of-N via
  the checker), and a `maxResult`-aware run smoke once credits reset.
- **Risks**: the curated budget map is conservative (well under real windows)
  but still a guess — a model whose window is smaller than its entry would
  rotate late. `AIPASS_CONTEXT_TOKENS` and the settings sheet still override.
- **Cleanup**: none needed.

## 2026-10-17 — opencode — the playbook library is back in reach, and the run's two dead flags reach the tools

- **Files**: `aipass-bridge/harness/harness.mjs` (the run's `maxResult` /
  `readLines` now reach all three tool contexts — main, helper, checker),
  `aipass-bridge/test/harness-fixes.test.mjs` (H11: a run's options clip a
  6 KB read at 500 bytes behind the spill locator, and page a 10-line file at
  three — red at `be0e1c5`, proven in a throwaway worktree), `CHANGELOG.md`,
  `docs/WORKLOG.md`. Machine-local, outside the repo: `D:\skills` is now a
  junction to `D:\aipass2\skills` (the library HOW-TO.md documents, stranded
  when the repo moved beside `aipass2` instead of inside it) and
  `~/.aipass/settings.json` carries `skillsDirs: ["D:\\aipass2\\skills"]` for
  the desktop backend.
- **Tests**: `npm test` green on this machine (one git-absent skip; see
  `npm test` for the count — parallel sessions move it); `npm run agents:lint`
  and `npm run evals:lint` green.
- **Deferred**: the two remaining quick wins — bootstrap snapshot (git status
  + scripts on turn 1) and step-cap visibility — are new prompt surface, not
  plumbing; they want their own design pass with the eval gate behind them.
- **Risks**: the junction and `skillsDirs` are machine-local; a CLI run from a
  tree not on `D:\` (e.g. `C:\Users\ASUS\aipass-bridge`) still resolves an
  empty default — point `AIPASS_SKILLS_DIR` there, or link it the same way.
- **Cleanup**: the proof worktree removed; no other processes started.

## 2026-10-17 — opencode — five-fix round: project-scoped runs, helper base layer, per-run readSet, rotation keeps created id

- **Files**: `desktop/ui/app.js` (`state.root` from refreshProjects/projects.switch/restoreFromSnapshot; `onRun`/`onAny` wrappers around ~35 handlers dropping foreign-project events; run/cancel carry `root: state.root`; foreign permission/plan modals show with a project label and route answers by project), `aipass-bridge/harness/rpc.mjs` (`run(params)` switches the harness when `params.root` differs with remember:false; `cancel(params)` targets the named harness; `status()` exposes per-project `running`), `aipass-bridge/harness/overlay.mjs` (read-through `base` layer), `aipass-bridge/harness/harness.mjs` (helper uses `child = new Overlay(root, {base: overlay})` with a `before` snapshot; copy-back skips files staged since start and records them in `helper_end.skipped`; `#makeTools()` called in `run()` so `readSet` resets per run; `#rotate` uses `made.id`; sends carry `conversation`/`conversationTemporary`), `aipass-bridge/harness/loop.mjs` (rebinds `conversation` after rotation), `aipass-bridge/bridge/server.mjs` (`resolveConversation` skips a temporary `conversationCache` for nameless callers), `aipass-bridge/harness/compact.mjs` (`summarize` accepts `conversation`/`temporary`), `aipass-bridge/test/bridge.test.mjs`, `checker.test.mjs`, `ask.test.mjs` (conversation-id contract), `aipass-bridge/test/harness-fixes.test.mjs` (+6 tests), `CHANGELOG.md`, `docs/WORKLOG.md`.
- **Tests**: `npm test` green (535 tests, 534 pass, 1 skip, 0 fail); `node --check` clean on all touched files.
- **Deferred**: live UI multi-project smoke (needs a real window run); desktop.test.mjs multi-project run routing (covered at the harness/rpc layer by the new harness-fixes tests and existing desktop-window tests).
- **Risks**: the per-project running map and foreign-event filter rely on every handler going through `onRun`/`onAny`; a handler added later that bypasses them silently re-introduces cross-project painting.
- **Cleanup**: debug removed; edits confined to the `aipass-fix` worktree.

## 2026-10-17 — opencode — the closing message carries the answer; the picker marks a dropped model

- **Files**: `aipass-bridge/harness/protocol.mjs` (the standing instructions now
  put the answer itself above the DONE — findings must not live only inside
  pasted material, and "finished" alone is not an answer), `aipass-bridge/harness/loop.mjs`
  (the no-marker nudge: if the answer is already written, the DONE line is all
  that is missing), `aipass-bridge/test/protocol.test.mjs` +
  `aipass-bridge/test/harness-fixes.test.mjs` (one new assertion each),
  `desktop/ui/app.js` (`fillModels` marks a model the live catalog dropped,
  keeps it visible either way, and never judges a fallback list — the catalog
  check's verdict, moved before the run), `aipass-bridge/test/ui.test.mjs`,
  `evals/fixtures/math-fix-replay.json` (fingerprint re-stamped: preambleBytes
  5020, digest `c7baf38722feae54`), `CHANGELOG.md`.
- **Tests**: `npm test` green on this machine (528 tests, 527 pass, 0 fail,
  1 skip); `npm run agents:lint` clean. The pushed CI run is the judge.
- **Deferred**: a live re-test of the recorded shapes (a WEB-search summary;
  the mangled-marker stall) — needs a real window run, which is the user's to
  start; the nudge half reaches conversations already in flight, the preamble
  half reaches new ones only (it is sent once per conversation).
- **Risks**: the guidance is prompt-level — a model that ignores it still
  closes short; the nudge is the runtime half. `allowRun` was flipped to true
  in the user's `~/.aipass/settings.json` (outside the repo): with mode=auto
  ordinary shell auto-runs, hazardous commands still ask.
- **Cleanup**: none needed — no processes started, edits confined to the
  `aipass-fix` worktree; investigation timelines live under
  `AppData/Local/Temp/opencode/inv/` (reference only).

## 2026-10-17 — opencode — the `models:` line covers history, not just new runs

- **Files**: `aipass-bridge/stats.mjs` (`collectRuns()` attributes a run that
  carries no `model` of its own to the session's recorded model — the header
  names the one a fresh run started on; a run-level `model` still wins),
  `aipass-bridge/test/stats.test.mjs` (a new test for the fallback and its
  precedence; the `(unrecorded)` test now covers only sessions that recorded
  no model either), `docs/RELIABILITY.md`, `CHANGELOG.md`.
- **Tests**: `npm test` green on this machine (526 tests, 0 fail, 1 skip);
  the pushed CI run is the judge. Live proof on the real store: the `models:`
  line went from `(unrecorded) 63r` to the full breakdown
  (gemini-3.5-flash-lite 40r · DeepSeek-V3.2 16r · claude-sonnet-5@default 4r
  · grok-4.6 3r · gemini-3.1-flash-lite 2r · gemini-3.8-flash 2r).
- **Deferred**: none blocking. The desktop app already writes the per-run
  model again (first keyed runs 19:44 today); the fallback is what carries
  the 63 runs written before that.
- **Risks**: for a pre-field session that switched models mid-history, every
  run attributes to the session's starting model — the best record that
  exists; runs written from `adbb31d` on carry the exact model per run.
- **Cleanup**: none needed — no processes started, edits confined to the
  `aipass-fix` worktree.

## 2026-10-17 — opencode — the refused send pauses instead of ending the run

- **Files**: `aipass-bridge/harness/bridge.mjs` (`TRANSIENT_SEND` now covers a
  content script mid-reinjection; new `RECOVER_WAITS_MS` / `recoverWaits()` /
  `sendRecoverable()`; `AIPASS_SEND_RETRY_MS` shrinks the transport wait for
  tests), `aipass-bridge/harness/loop.mjs` (the send is a bounded retry loop:
  a recoverable failure pauses and the same message goes again; each recovery
  is a `firewall_note` and `run_stats.sendRecoveries` counts it),
  `aipass-bridge/test/harness.mjs` (`scripted(..., { gap })` models the
  connection-cycle shapes), `aipass-bridge/test/agent.test.mjs` (four tests:
  chain exhaustion → rescue, never-clears → bounded stop, loading tab →
  recovered, mid-reinjection → retried inside the send), plus `CHANGELOG.md`,
  `docs/LOOP_DESIGN.md`, `docs/RELIABILITY.md`.
- **Tests**: `npm test` green on this machine (520 tests, 0 fail, 1 skip);
  the pushed CI run is the judge.
- **Deferred**: the conversation churn ("created temporary conversation" every
  ~30s in the morning's failing runs) — diagnosed as a lead, not reproduced
  here; the other session's `aipass-loopbug` worktree owns that repro.
- **Risks**: a hard rate window now stalls longer before dying (bounded:
  ~8min in resilientSay + 90s of recovery); "bridge returned 5xx" counts as
  recoverable, so a sick bridge is retried twice before the old ending.
- **Cleanup**: none needed — no processes started, edits confined to the
  `aipass-fix` worktree.

## 2026-10-17 — opencode — CI revived: the runners' git phrasing, then the sessions' batch

- **Files**: `aipass-bridge/test/gates.test.mjs` + `aipass-bridge/harness/tools.mjs`
  + `aipass-bridge/harness/sandbox.mjs` — the projected-git probes accept the
  runners' git wording ("gitfile does not point to a valid repository") beside
  this machine's ("not a git repository"); the Windows lanes had failed on the
  last several pushes over exactly this match. The rest of this entry rode
  along: the sessions' pending batch, pushed in the same operation.
- **Tests**: `npm test` green on this machine; the pushed run on CI is the
  judge — `gh run list -R kasemjeff/aipass`.
- **Deferred**: the `D:\aipass-loopguards` worktree (chat.mjs / extension
  page.js / bridge.mjs) was mid-edit at handoff — left uncommitted by design.
  Personal files (fortune-telling, investment pages, research notes, the
  veterinary hub page) stay untracked until the human says otherwise.
- **Risks**: origin/master (13 commits) merged into master as the union of two
  editing streams; the suite, not the eye, validates the union.
- **Cleanup**: none needed.

## 2026-10-17 — opencode — extension updated and re-installed into the browser

- **Files**: `aipass-bridge/extension/{manifest.json, content.js, popup.html,
  popup.js}` (now v0.2.1: Advanced gains **Reload extension** / **Reload
  chat tab**; content.js stops its retry loops once a reload orphaned it),
  `aipass-bridge/docs/DOCS.md` (reconnect backoff, reload buttons). Synced to
  the copy Chrome actually loads — `C:\Users\ASUS\aipass-bridge\aipass-bridge\
  extension` (an old clone, not this checkout); the old files sit at
  `%TEMP%\opencode\ext-C-backup-20261017`.
- **Tests**: `npm test` green (0 fail, 1 git-absent skip).
- **Deferred**: re-pointing Chrome at `D:\aipass\aipass-bridge\extension`
  (Remove + Load unpacked wipes the stored bridge token, so it needs the human)
  — the C:-copy sync is the stop-gap. `/ext/reload` stayed admin-gated: the
  running bridge answers 404 without `AIPASS_ADMIN=1`.
- **Risks**: the C: clone now shows every extension file modified vs its
  September HEAD — expected; it is a delivery copy there, not a source. Its
  local content.js edit (a delete-form, behavior-equivalent) was superseded.
- **Cleanup**: none needed.

## 2026-10-17 — opencode — agent-guide system, P0+P1 (AGENTS.md)

- **Files**: new `AGENTS.md`, `aipass-bridge/AGENTS.md`,
  `aipass-bridge/test/AGENTS.md`, `desktop/AGENTS.md`, `GEMINI.md`,
  `.github/copilot-instructions.md`, `docs/WORKLOG.md`,
  `scripts/agents-lint.mjs`, `aipass-bridge/test/agents-docs.test.mjs`,
  `AGENTS.local.md` (git-ignored). `CLAUDE.md` replaced by an `@AGENTS.md`
  import; `.gitignore` and `package.json` (`agents:lint`) touched.
- **Tests**: `npm run agents:lint` and `npm test` green (0 fail, 1 git-absent
  skip; the count moves as parallel sessions land tests).
- **Deferred**: `.cursor/rules` and Aider `CONVENTIONS.md` shims only if those
  tools are actually used.
- **Risks**: renaming a test that an agent guide cites fails `npm test` by
  design — update the anchor in the same change.
- **Cleanup**: none needed.

## 2026-10-17 — opencode — perf/hardening wave 2

- **Files**: `harness/{authtoken,rpc,overlay,protocol,session,sandbox,tools}.mjs`,
  `bridge/{server,private-hosts}.mjs`, `desktop/ui/app.js`, `bin/aipass.mjs`,
  plus test updates (`tools.test`, `tools-aci.test`, `harness-research.test`,
  `harness-fixes.test`, `run-overlay.test`, `gates.test`, `ui.test`).
- **Tests**: `npm test` → 467 pass / 0 fail / 1 skip (git-absent), ~21 s.
- **Deferred**: DONE-checker child run (SPEC_CHECKER semantics — product
  decision), background-stream reconnect overlap (~300 ms gap every ~4 min,
  accepted), sandbox junctioning of untouched subtrees (rejected — would
  break "nothing real is ever written").
- **Risks**: replay buffer is now 5000 frames / 4 MB capped; no others known.
- **Cleanup**: isolated boot-check bridge (port 8799, `%TEMP%\aipass-bootcheck`)
  killed.

## 2026-10-18 — opencode — cache observability + install refresh

- **Files**: `desktop/ui/app.js` (paint cache counters — hit / miss / cold /
  appended / repainted — plus `/paint` and a `cache:` line in `/status`),
  `aipass-bridge/bridge/server.mjs` (per-cache `cacheStats`: a hit is answered
  without the tab, a fetch went upstream), `harness/rpc.mjs` (pass-through at
  `status().cache`), `desktop/src-tauri/src/main.rs` (`let mut status` — a
  latent compile error that had blocked `tauri:build` since a8ee7af; found
  only because this session finally ran the real build), `test/ui.test.mjs`
  (+2), `test/bridge.test.mjs` (+1), `CHANGELOG.md`.
- **Tests**: `npm test` → 663 pass / 0 fail / 2 skip; `npm run agents:lint` ok.
- **Installer**: `npm run tauri:build` green after the fix (1m48s, cached
  deps at `D:\aipass-build\target`). Artifact:
  `D:\aipass-build\target\release\bundle\nsis\aipass
  desktop_0.2.0_x64-setup.exe` (231 MiB, built from this dirty tree — HEAD
  a8ee7af plus everything landed), installed silently over `%LOCALAPPDATA%\
  aipass desktop`. Verified after install: ui/ + bridge/ + main.mjs hashes
  equal the repo's, fresh shell exe and uninstall.exe; backend boots on
  scratch ports and serves page + `app.js` 200 with the cache code.
- **Risks**: counters are accounting-only — no paint behavior changed. The
  install sync took the tree as it stood, including parallel sessions' work
  that had landed by then (suite green at sync time).
- **Cleanup**: previous install kept at
  `%LOCALAPPDATA%\aipass desktop.backup-20261018-171118` for rollback; smoke
  home under `%TEMP%\opencode` removed; no processes left running.
