# Contributing

Thanks for taking the time. This project is a continuation of
[niawjunior/aipass-bridge](https://github.com/niawjunior/aipass-bridge); the
bridge, the Chrome extension and the CLI are upstream code continued here, and
the desktop window and the harness are this repository's work.

This guide is short, and every item is here because something actually went
wrong without it.

## First, the rules that are not negotiable

- **Be decent.** Participation is governed by
  [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md).
- **Security problems go private.** Do not open a public issue; follow
  [SECURITY.md](./SECURITY.md).
- **Contributions are MIT, with a DCO sign-off.** See below.
- **The core stays dependency-free.** `bridge/`, the CLIs and the extension
  have no runtime dependencies and should stay that way. The tests spawn the
  real bridge and a scriptable stand-in for the extension rather than mocking
  either.

## Developer Certificate of Origin (DCO)

Every commit must carry a `Signed-off-by` trailer that matches the commit
author. This is a lightweight statement that you wrote the change, or have the
right to submit it, under the project's MIT license. It is not a copyright
assignment.

```bash
git commit -s -m "fix: the thing that was broken"
```

The trailer looks like:

```text
Signed-off-by: Your Name <you@example.com>
```

Use the name and email you want in the public history. If you forgot, amend the
commit before opening the pull request:

```bash
git commit --amend -s --no-edit
```

CI runs `npm run dco` on pull requests. Dependabot commits are exempt. A pull
request with an unsigned commit is not merged.

By contributing, you agree that your contribution is licensed under the
[MIT License](./LICENSE) and that you have the right to submit it.

## Before you open a pull request

**Check the email your commits carry.**

```bash
git config user.email
```

GitHub's contributor graph matches commits by **email**, not by the name on
them. A commit authored under an address that is not verified on your GitHub
account is credited to whoever does own that address — or to nobody. Use an
address listed under
[GitHub → Settings → Emails](https://github.com/settings/emails), or GitHub's
`@users.noreply.github.com` address. Set it per repository if you keep more
than one identity:

```bash
git config user.email "you@example.com"
```

**Run the suite.** From a clean checkout:

```bash
npm ci
npm test
npm run typecheck
npm run agents:lint
npm run docs:check
```

`npm test` is the whole bridge/harness/window suite and needs no runtime
dependencies. `npm run check` is the fuller pre-push set (lint, suite, QA loop,
coverage floors and the docs link check); some of its QA steps expect a running
backend, so read the output rather than assuming every failure is yours.

**Node versions.** CI covers Node 20, 22 and 24. Node 22 or 24 is recommended
for development; Node 20 is end-of-life upstream and is kept only for
compatibility. The packaged app ships its own Node sidecar.

**Windows counts.** CI runs Ubuntu, macOS and Windows. Every path bug this
project has hit was Windows-only, which is why Windows is in the matrix. If you
change a path, a permission or a process rule, say what you ran on Windows.

**The native window needs more than Node.** `npm run desktop` runs the window
without Rust. `npm run tauri:build` needs the Rust toolchain, the Tauri CLI and
the platform packages listed in [docs/INSTALL.md](./docs/INSTALL.md). If you
cannot build the native shell, say so in the PR; do not claim you did.

## What to put in the pull request

- **What changes and why.** Link the issue or the design discussion.
- **Every file you changed**, including incidental ones. A timing constant or
  a README line moved in passing is the kind of thing that gets merged
  unnoticed, and finding it during review costs more trust than mentioning it
  would have.
- **What you actually verified.** `npm test` passing is worth stating — but
  note that **no test reaches the real extension**. `background.js`,
  `content.js`, `page.js` and `offscreen.js` are replaced by the harness, so a
  green suite says nothing about a change to any of them. If you changed
  extension code, the useful sentence is what you observed in a browser and
  for how long.
- **The changelog line** for a behavior change. `CHANGELOG.md` is written in
  behavior terms, not file-by-file.
- **A DCO checkbox** in the PR template. The CI job is the enforcement; the
  checkbox is the reminder.

## How PRs are merged

With a **merge commit**, never a squash. A squash collapses your commits into
one authored by whoever pressed the button, which erases your name from the
history. Merging keeps your commits, your authorship and your messages intact.

A maintainer may merge a good idea and then tighten it in a follow-up rather
than sending it back. When that happens, the reasoning is posted on the PR
before the merge and the follow-up says what changed and why.

## Commit messages

Use a short prefix that says what kind of change it is:

```text
feat: a new capability
fix: a behavior that was wrong
docs: documentation only
test: tests only
chore: maintenance that changes no behavior
refactor: a change that preserves behavior
```

One logical change per commit is preferred. A commit that mixes a behavior
change with a large formatting pass is hard to review and hard to revert.

## AI-assisted contributions

AI-assisted work is welcome. You are responsible for it: read the diff, run the
tests, check the license and do not paste secrets or private data into a tool.
Say in the PR if a substantial part was generated, so a reviewer knows what to
look at more closely. The repository's `AGENTS.md`, `CLAUDE.md` and `GEMINI.md`
are guides for coding agents, not a substitute for the contributor rules here.

## Where things are

| | |
|---|---|
| `desktop/` | the window, the Tauri shell and the UI |
| `aipass-bridge/harness/` | the agent core: loop, tools, protocol, sessions, permissions |
| `aipass-bridge/bridge/` | the HTTP surface, job hub, conversations, models, credits |
| `aipass-bridge/extension/` | MV3 extension — the only code that touches a credential |
| `aipass-bridge/*.mjs` | the CLIs: chat, agent, doctor, list |
| `aipass-bridge/test/` | the suite, plus `harness.mjs` which stands in for the extension |
| `aipass-bridge/deploy/` | optional headless Docker deployment |
| `docs/` | design and operations docs; start at `docs/README.md` |
| `evals/`, `experiments/` | benchmark tasks and the experiment queue |

[Full documentation](aipass-bridge/README.md) covers the architecture and why
the odd-looking parts are shaped the way they are — several of them are
load-bearing and look like mistakes.

## Reporting a bug or asking for a feature

- Bug: use the bug report template and paste the full `npm run doctor` output.
- Feature: use the feature request template and describe the problem before
  the proposed implementation.
- Question: use GitHub Discussions.
- Security: private advisory only.

See [SUPPORT.md](./SUPPORT.md) for the full list.
