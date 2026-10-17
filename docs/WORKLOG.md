# Worklog

Session handoffs, newest first. One entry per working session, five items:
**files touched · tests run + result · deferred items with reasons · open
risks · cleanup done**. This is news, not law: the rules live in `AGENTS.md`,
durable behavior changes in `CHANGELOG.md`, and the final word is always the
suite.

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
