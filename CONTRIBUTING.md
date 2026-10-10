# Contributing

Outside patches are welcome — four have landed already. This is short, and every
item is here because something actually went wrong without it.

## Before you open a PR

**Check the email your commits carry.**

```bash
git config user.email
```

GitHub's contributor graph matches commits by **email**, not by the name on them.
A commit authored under an address that is not verified on your GitHub account is
credited to whoever does own that address — or to nobody. This has already
happened here: three merged commits show `astrathezero` as the author and are
attributed to the maintainer, because the git config on that machine carried the
maintainer's address. The work is theirs; the graph does not say so, and fixing it
after the fact would mean rewriting published history.

Use an address listed under [GitHub → Settings → Emails](https://github.com/settings/emails),
or GitHub's `@users.noreply.github.com` one. Set it per-repo if you keep more than
one identity:

```bash
git config user.email "you@example.com"
```

**Run the suite.** No dependencies, a few seconds:

```bash
npm test
```

**Keep the core dependency-free.** `bridge/`, the CLIs and the extension have no
runtime dependencies and should stay that way. The tests spawn the real bridge
and a scriptable stand-in for the extension rather than mocking either.

**Windows counts.** CI runs ubuntu and windows on node 20 and 22. Every path bug
this project has hit was Windows-only, which is why it is in the matrix.

## What to put in the description

**List every file you changed**, including the incidental ones. A timing constant
or a README line moved in passing is the kind of thing that gets merged unnoticed,
and finding it during review costs more trust than mentioning it would have.

**Say what you actually verified.** `npm test` passing is worth stating — but note
that **no test reaches the extension**. `background.js`, `content.js`, `page.js`
and `offscreen.js` are replaced by the harness, so a green suite says nothing
about a change to any of them. If you changed extension code, the useful sentence
is what you observed in a browser and for how long.

## How PRs are merged

With a **merge commit**, never a squash. A squash collapses your commits into one
authored by whoever pressed the button, which erases your name from the history.
Merging keeps your commits, your authorship and your messages intact.

Sometimes a PR is merged and then tightened in a follow-up rather than sent back —
this happened with #2 and #16. The reasoning is posted on the PR before the merge,
never after, and the follow-up says what changed and why. The goal is that a good
idea lands the same day without the cleanup arriving under your name.

## Where things are

| | |
|---|---|
| `aipass-bridge/bridge/` | the HTTP surface, job hub, conversations, models, credits |
| `aipass-bridge/extension/` | MV3 extension — the only code that touches a credential |
| `aipass-bridge/*.mjs` | the CLIs: chat, agent, doctor, list |
| `aipass-bridge/test/` | the suite, plus `harness.mjs` which stands in for the extension |
| `aipass-bridge/deploy/` | optional headless Docker deployment |

[Full documentation](aipass-bridge/README.md) covers the architecture and why the
odd-looking parts are shaped the way they are — several of them are load-bearing
and look like mistakes.
