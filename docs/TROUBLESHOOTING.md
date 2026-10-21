# Troubleshooting

The first move is always the same:

```bash
npm run doctor             # walks the whole chain, names the one next action
npm run doctor -- --json   # the same, machine-readable (last line)
```

It checks, in order: bridge reachable → extension attached → signed in →
credits → a conversation to post into → one real round trip. It exits non-zero
on the first failure, and every failure prints the single next action — fix
the first one, the rest usually follow. `--no-chat` skips the round trip;
`--chat` runs it even when no free-credit model exists.

If you prefer checking by hand: `GET /status` is token-free on purpose, and
`extensions: 0` there means no tab is attached — the first failure most days.

## The chat doesn't answer

- **No tab attached.** The bridge is a relay: the actual request runs inside
  your logged-in `de.aipass.net` tab. Load `aipass-bridge/extension/` in
  `chrome://extensions` (Developer mode → Load unpacked) and keep an
  `https://de.aipass.net/chat` tab open. Recommended: Chrome → Performance →
  *Always keep these sites active* → add `de.aipass.net`, so a long run is
  never frozen mid-stream.
- **The tab opened in the wrong browser.** The backend opens the chat page in
  Chrome, because the extension is a Chrome extension and answers from inside
  that tab. A machine with no Chrome falls back to the platform default — and
  a tab there carries no extension, so the run stops with "no de.aipass.net
  tab is open". Install Chrome, or load the extension in the browser you
  prefer and open the chat there yourself.
- **Signed out.** The model list comes back empty or fallback-only; `doctor`
  reports this as the `login` check. Sign in, then reload the tab.
- **The popup says the bridge needs a token.** The bridge mints a loopback
  token to `~/.aipass/.token` and prints the path when it starts. Open the
  extension popup → **Advanced** → paste the file's contents into
  **Loopback token** → save. One time per browser. The bridge says the same
  thing in its own log — "the extension was refused: it has no loopback
  token" — because a tokenless extension retries every three seconds and
  `/status` only shows `extensions: 0`.
- **The window says the extension has no token.** The window knows: the
  bridge reports a refused extension in `/status` (`extensionToken:
  "missing"`), so the window does not send you to load an extension that is
  already loaded. Click **วาง token ให้** in the window — it puts the token
  on your clipboard — then open the extension popup → **Advanced** →
  **Paste from clipboard** → save. The window drops the notice as soon as
  the extension gets through.
- **The window says the bridge refused the token.** That is the window's own
  credential, not the extension's: the extension talks to the bridge, and
  pasting a token into its popup cannot change this. The window and the
  backend read the same file, so start the app again and they agree.
- **A run dies on 403.** The upstream edge blocks trigger-shaped content; the
  harness encodes those tokens on the way out and decodes them on the way back
  (`harness/waf.mjs`), and a rejected turn is split and resent in halves — a
  fragment that cannot pass at any size is dropped with a note. If a run still
  dies, the log names the refused message: `~/.aipass/logs/bridge.log` for a
  bridge the desktop started, or the terminal running `aipass dev`. A run that
  stands still at `[403] refused at the edge` is waiting for the edge: the
  refusal reaches the harness at once (the client says it rewrites the
  message), and the rewrite — a shorter copy, a halved one — goes out as the
  next request.
- **429s.** The client waits the rate window out and retries; only an error
  that survives the retries ends the run.

## The bridge won't start (or the wrong one answers)

- Port `8787` already busy is usually fine: the desktop backend and the CLIs
  adopt a running bridge instead of starting a second one. `aipass stop`
  stops the background bridge via `~/.aipass/bridge.pid`.
- The bridge refuses to bind anything but loopback unless
  `AIPASS_ALLOW_REMOTE=1`: beyond the token it has no auth of its own, so
  keep it on `127.0.0.1`.
- `AIPASS_REQUIRE_AUTH=0` silences the token requirement (with a boot
  warning); `AIPASS_TOKEN` pins an explicit token (containers, tests).

## The window

- Blank or stale → hard reload (`Ctrl+Shift+R`). The UI has no build step:
  the served files are the source files.
- The native build (`npm run tauri:build`) needs Rust + MSVC; the installer
  ships a Node sidecar (`npm run desktop:sidecar` copies your Node into
  `desktop/sidecar/`). When debugging, run `npm run desktop` in a plain
  browser first — same window, none of the shell.
- Backend not answering? It listens on `127.0.0.1:8790`; its health is
  `POST /rpc` with `{"method":"status"}` **and the loopback bearer token** —
  without it the answer is a 401, which is the backend working, not a broken
  one. The token is `~/.aipass/.token`; `AIPASS_REQUIRE_AUTH=0` turns the
  check off. The backend log is
  `~/.aipass/logs/desktop-backend.log` (`docs/DATA_FORMATS.md`); in dev the
  terminal that ran `npm run desktop` carries it too. The packaged shell
  restarts a backend that exits — backoff, `[supervisor]` lines in the log —
  so a crash reads as a short pause, not a dead window.
- "port 8790 is busy" on launch? Something else holds the port — a second
  backend, or a server that is not ours. The launcher adopts a backend that
  answers (a 401 carrying the backend's own refusal counts: it is ours, with
  a different token) and says so; a stranger's server is left to the busy-port
  message. The packaged shell asks the same question through the same probe:
  one of our backends is adopted, and a stranger is named in the log with the
  fix (`AIPASS_DESKTOP_PORT=<other>`).
- The window opens and then keeps losing the backend? Read
  `~/.aipass/logs/desktop-backend.log`. A line that says
  "port … is held by something that is not an aipass backend" is the whole
  story: something else has 8790, and the shell is waiting for it to go.
  A line that says "another aipass backend is answering on the port — it is
  adopted" means a second copy is serving, and the window is talking to it.
- The machine feels slow and there are dozens of `node.exe` processes? Those
  are bridges. A bridge that nobody is using ends itself after ten minutes
  (`AIPASS_BRIDGE_IDLE_MS`); the one that is answering is in
  `~/.aipass/bridge.pid`, and `aipass stop` ends it. Anything older than
  that is a leftover from before — end it and it does not come back.

## A run stops early, or refuses a write

These are the guards doing their job — `docs/LOOP_DESIGN.md` lists every stop
reason and guard.

- **Stalled or capped.** Per-run caps `maxSteps`, `maxToolCalls`,
  `maxWallClockMs`; the repeat guard refuses an identical call with nothing
  staged in between, then stops the run after `repeatGuardMax` refusals.
  Raise the caps in Settings if the work is genuinely long.
- **Out of credits mid-run.** With `maxCredits` set, the run stops once its
  observed spend reaches the ceiling — checked against the cached quota, so
  up to ~30s of spend can slip past it. The session note names the ceiling and
  the stop reason reads `credit-limited`. 0 (the default) means no cap.
- **"the person watching declined …"** — a change in `ask` mode was not
  approved, or a path rule or the plan gate said no. Approve the diff, switch
  mode (`Shift+Tab` cycles ask → auto → plan), or amend the rule.
- **"… denies reading …; the file stays on this machine"** — the secret floor
  (`SECRET_RULES` in `harness/settings.mjs`): `.env*`, keys, cloud credentials
  and captures are denied for reads AND writes in every mode, yolo included.
  An explicit user rule naming the file overrides it. This is not a bug.
- **Context rotated.** At `compactAtPercent` (default 40%) the run summarises
  and rotates to a fresh upstream conversation. The local transcript keeps
  everything; the model just carries the summary forward — see
  `docs/DATA_FORMATS.md`.

## Windows notes

- No `diff` binary? The diff rendering falls back to the built-in shape —
  nothing to install.
- The `GIT` tool needs `git` on `PATH`.
- The token file's mode is best-effort on Windows; `SECURITY.md` documents
  the limit plainly (same-user processes are outside the boundary).

## Watching cost and errors

There is no push alerting and there cannot be — a single-user desktop has no
daemon to page you. The pull-based version ships:

```bash
npm run stats -- --alerts             # refusal spike, guard-trip share, cost outliers, firewall notes
npm run stats -- --strict             # exit 1 when a warning fired (the scheduled-task shape)
npm run stats -- --json               # {lifetime, alerts, rows} for anything that wants to graph
npm run stats -- --html report.html   # a self-contained page, openable offline
npm run loadtest -- --strict          # concurrent-call latency + memory movement, before a release
```

Thresholds are deliberately coarse — 10+ runs before a rate warns, 4× the
median before a run is "an outlier" — because they answer "is this install
drifting", not "what is this one run doing". For the latter: the plain
`npm run stats` table and the session JSONL.

## When something went wrong (incident response)

A local install, so the response is proportional — but the order is fixed:

1. **Contain.** `aipass stop` ends the background bridge (pid in
   `~/.aipass/bridge.pid`); quitting the window stops the backend with it. If
   a run is doing damage inside your project, press the window's stop (or
   `aipass stop`) before anything else. Staged changes live in the overlay and
   vanish on stop; applied changes are yours to revert with `git restore` /
   `git revert` like any edit.
2. **Preserve the evidence.** The session JSONL (path shown in the window and
   in every eval row) holds the whole conversation, every tool call and the
   `run_stats` line; `~/.aipass/logs/` holds the process logs (one rotated
   generation). Copy them before re-running anything.
3. **Explain it.** `npm run doctor` first (the chain), then
   `npm run stats -- --alerts` (the pattern). One oversized run misreading a
   task is one run; the same stop reason across runs is a settings or prompt
   change.
4. **Roll back if needed.** `docs/RELEASE.md` — for code, check out the
   previous tag; for the installed app, reinstall the previous installer over
   the current one. Settings and sessions are forward-compatible
   (`DATA_FORMATS.md`), so a rollback keeps them. A machine that is beyond
   rollback restores from the backup folder — `docs/DATA_FORMATS.md`
   "Recovery".
5. **Then file it** with the evidence from step 2 — see below.

## Feedback, and why it never edits policy by itself

The channel is an issue — or a line in `docs/WORKLOG.md` for the next
session — with context: what you asked, what happened, the session file path
(shown in the window) or a `stats --json` slice, and the `app` version from
the session header. Feedback is read by a person; nothing parses it into
settings, prompts or routing automatically. Ground truth stays the
check-based evals (`docs/SPEC_EVALS.md`) — a task is solved by a passing
check, never by an opinion — and a change that comes out of feedback lands
like any other: with a test, and with an evals review when model-visible
behavior moves.

## When filing a bug

Include: the `npm run doctor --json` output, `node -v` and your OS, the tail
of the bridge log, and — for window issues — the browser console. The issue
template lives in `.github/ISSUE_TEMPLATE/bug_report.md`.
