# AGENTS.md — aipass-bridge/test

> Writing and changing tests. Root law: `../../AGENTS.md`. Backend law:
> `../AGENTS.md`. Verify: `npm test` from the repo root — the suite is the
> court of record.

## The harness drives real things

- `test/harness.mjs` spawns the **real** bridge as a subprocess plus a
  scriptable `FakeExtension` that connects to `/ext/events` and answers jobs —
  tests drive the actual HTTP surface and the real CLIs, not mocks. Don't
  mock the bridge.
- `scripted([...])` scripts the model's replies; pass `reject` to model an
  upstream filter.
- `run()` strips SGR color codes from captured CLI output before asserting.
  Cursor-movement escapes are not stripped, which is why `chat.mjs` gates all
  of them behind `stdout.isTTY` — keep that gate when touching TTY output.
- The suite runs with `AIPASS_REQUIRE_AUTH=0`; never weaken auth in production
  code to make a test pass. The gate is ON in `auth.test.mjs`, and that is
  where each client's own credential is pinned: a client that forgets the
  token looks fine everywhere else, and the refusal lands on the user.
  Verify: "the harness's bridge client presents the loopback token"
  Verify: "the token rides loopback and nothing else"

## UI tests are behavioral specs

- `ui.test.mjs` fakes the DOM, `fetch` and `EventSource`, then boots the real
  `desktop/ui/app.js`. Assertions describe what the user sees, never DOM
  snapshots.
- Paints are coalesced (one frame per burst): after `emit(…)` always
  `await tick()` (5 ms) before asserting prose/reasoning. A 0 ms `setTimeout`
  flush stands in for `requestAnimationFrame` — synchronous assertions right
  after `emit` are wrong.

## Conventions

- Tests are async where the tools are: `await tools.write/replace/search(…)`.
- Spies must key on the **caller in the stack** (e.g. the header-rewrite test
  counts both `writeFileSync` and `writeSync` calls made from inside
  `rewriteHeader`), because Node internals sometimes route through the same
  public fs functions — `appendFileSync` on Node 24 is implemented as a
  `writeFileSync`.
- Temp dirs come from the local helpers (`tempDir`, `mkTracked`); no test
  writes to `~/.aipass` or the real cwd.
- Test titles are contracts: `AGENTS.md` files cite them via `Verify:`
  anchors. Renaming one? Grep the title across the repo's `AGENTS.md` files
  and update the anchors in the same change.
- Untracked test files are another session's undelivered work — read them if
  useful, never edit or delete (root rule 4).
