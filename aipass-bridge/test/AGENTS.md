# AGENTS.md — aipass-bridge/test

> Writing and changing tests. Root law: `../../AGENTS.md`. Backend law:
> `../AGENTS.md`. Verify: `npm test` from the repo root — the court of record.

## The harness drives real things

- `test/harness.mjs` spawns the **real** bridge as a subprocess plus a
  scriptable `FakeExtension` that connects to `/ext/events` and answers jobs —
  tests drive the actual HTTP surface and the real CLIs, not mocks.
- `scripted([...])` scripts the model's replies; pass `reject` to model an
  upstream filter.
- `run()` strips SGR color codes from captured CLI output before asserting.
  Cursor-movement escapes are not stripped — `chat.mjs` gates them behind
  `stdout.isTTY`, and that gate must stay.
- The suite runs with `AIPASS_REQUIRE_AUTH=0`; never weaken auth in
  production code to make a test pass. The gate is ON in `auth.test.mjs`.
  Verify: "the harness's bridge client presents the loopback token"
  Verify: "the token rides loopback and nothing else"

## UI tests are behavioral specs

- `ui.test.mjs` fakes the DOM, `fetch` and `EventSource`, then boots the real
  `desktop/ui/app.js`. Assertions describe what the user sees.
- Paints coalesce (one frame per burst): after `emit(…)` always `await tick()`
  (5 ms) before asserting prose/reasoning.

## Conventions

- Tests are async where the tools are: `await tools.write/replace/search(…)`.
- Spies must key on the **caller in the stack**: Node internals sometimes route
  through the same public fs functions (`appendFileSync` is a `writeFileSync`).
- Temp dirs come from the local helpers (`tempDir`, `mkTracked`); no test
  writes to `~/.aipass` or the real cwd.
- Test titles are contracts: `AGENTS.md` files cite them via `Verify:` anchors.
  Renaming one? Grep the title across the repo's `AGENTS.md` files and update
  the anchors in the same change.
- Untracked test files are another session's undelivered work: read them,
  never edit or delete (root rule 4).

## The contracts this suite pins

The index of the behaviours the suite holds lives in
[`CONTRACTS.md`](./CONTRACTS.md) — every title there is cited by a `Verify:`
anchor somewhere, so renaming a test without saying what it now pins breaks
the lint. Add a line there when a behaviour earns one; the guides stay law.
