## What this changes

<!-- The problem and the behavior change. Link the issue or design discussion. -->

## Files touched

<!-- All of them, including incidental changes — a timing constant, a README line. -->

## How it was verified

<!-- `npm test` passing is worth stating. But no test reaches the real extension:
     background.js, content.js, page.js and offscreen.js are replaced by the
     harness, so a green suite says nothing about a change to those. If you
     touched extension code, say what you observed in a browser and for how long.
     If you touched a native build or a release workflow, say what you built and
     on which platform. -->

---

- [ ] `git config user.email` is an address verified on my GitHub account
      (otherwise the commits are credited to someone else — see CONTRIBUTING.md)
- [ ] Every commit carries a `Signed-off-by` trailer (`git commit -s`)
- [ ] `npm test` passes
- [ ] `npm run typecheck` and `npm run agents:lint` pass
- [ ] `npm run docs:check` passes if I touched Markdown
- [ ] The description lists every file I changed
- [ ] A behavior change has a `CHANGELOG.md` line under `[Unreleased]`
- [ ] I have read [CONTRIBUTING.md](../CONTRIBUTING.md) and the
      [Code of Conduct](../CODE_OF_CONDUCT.md)
