# Governance

This is a small, maintainer-led open-source project. The rules below are
deliberately short; they exist so contributors know who decides and how a
disagreement is resolved.

## Maintainer

The project currently has one maintainer: **@kasemjeff**. The roles and
current responsibilities are listed in [MAINTAINERS.md](./MAINTAINERS.md).

## How decisions are made

1. **Small changes** (a bug fix, a test, a documentation correction) are
   decided by the pull request: CI green, one maintainer review, and the
   change is merged.
2. **Behavior changes** (the agent loop, the protocol, the window's
   interaction model, a new default) need a short design note in the pull
   request and a `CHANGELOG.md` entry. A maintainer approves after the trade-off
   is written down.
3. **Security, licensing and release decisions** are made by the maintainer,
   with the security process in [SECURITY.md](./SECURITY.md) and the release
   process in [docs/RELEASE.md](./docs/RELEASE.md).
4. **Disagreements** are resolved by discussing the evidence in the issue or
   PR. If consensus is not reached, the maintainer decides and records the
   reason in the thread. A decision can be reopened when new evidence appears.

## Becoming a maintainer

There is no fixed number of contributions. The signals looked for are:

- a history of useful pull requests that follow the review and testing rules;
- reviews that catch real problems, not only style;
- good judgment about security, licensing and user data;
- willingness to say "not yet" and explain why.

An existing maintainer invites a new maintainer explicitly. The change is
recorded in [MAINTAINERS.md](./MAINTAINERS.md) and in the release notes.

## Continuity

The project is currently a single-maintainer project, which is a real bus
factor risk. If the maintainer is unavailable for more than 30 days, the
repository stays readable and the last release stays installable, but no new
release should be published by someone else without the signing keys and an
explicit handover. A future goal is to add a second maintainer with release
access; see [ROADMAP.md](./ROADMAP.md).

## Code of Conduct

Participation is governed by [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md).

## Licensing

Contributions are accepted under the MIT License and require a Developer
Certificate of Origin sign-off. See [CONTRIBUTING.md](./CONTRIBUTING.md).
