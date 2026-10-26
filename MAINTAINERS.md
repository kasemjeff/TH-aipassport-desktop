# Maintainers

| person | role | areas |
|---|---|---|
| **@kasemjeff** | maintainer | desktop window, harness, bridge, release engineering, security policy, documentation |

## Roles named in the design docs

`docs/MATURITY.md` names three responsibilities. They are all held by the
maintainer today; the names are kept so a future handover has a target.

| role | responsibility | current holder |
|---|---|---|
| Loop maintainer | the agent loop, guards, budgets, the desktop shell | @kasemjeff |
| Benchmark owner | evals, lint, comparison, the safety set | @kasemjeff |
| Policy owner | `SECURITY.md`, `docs/RELEASE.md`, the "won't build" line | @kasemjeff |

## Response expectations

This is a volunteer project, not a support contract. The targets are:

- security reports: acknowledge within 3 business days, triage within 7 days;
- pull requests and issues: a first response within 7 days when possible;
- releases: no fixed cadence; a release happens when the checklist in
  `docs/RELEASE.md` is green.

If a report is security-sensitive, use the private channel in
[SECURITY.md](./SECURITY.md), not a public issue.

## Adding a maintainer

See [GOVERNANCE.md](./GOVERNANCE.md#becoming-a-maintainer).
