# Documentation

This directory holds the design and operations docs. They are written in
English; the Thai README is at [`../README.th.md`](../README.th.md).

## Start here

| doc | what it answers |
|---|---|
| [`INSTALL.md`](./INSTALL.md) | how to install, what each platform ships, what macOS needs |
| [`TROUBLESHOOTING.md`](./TROUBLESHOOTING.md) | something is broken; run `doctor` and read this |
| [`CONFIG.md`](./CONFIG.md) | every switch: environment variables, settings keys, harness options |
| [`FAQ.md`](./FAQ.md) | short answers to the questions that come up first |
| [`MATURITY.md`](./MATURITY.md) | what is production, experimental, or deliberately not shipped |
| [`RELEASE.md`](./RELEASE.md) | release checklist, signing, rollback |

## Design

| doc | what it holds |
|---|---|
| [`HARNESS_DESIGN.md`](./HARNESS_DESIGN.md) | the harness end to end: loop, tools, protocol, permissions, WAF |
| [`LOOP_DESIGN.md`](./LOOP_DESIGN.md) | the agent loop: stage map, guards, stop reasons, events |
| [`SPEC_CHECKER.md`](./SPEC_CHECKER.md) | the checker: the read-only pass a `DONE` earns |
| [`SPEC_EVALS.md`](./SPEC_EVALS.md) | the eval runner: fixtures, replay, scoring |
| [`EXPERIMENTS.md`](./EXPERIMENTS.md) | the experiment queue and its records |
| [`TECH_STACK.md`](./TECH_STACK.md) | what runs where, and why |
| [`DATA_FORMATS.md`](./DATA_FORMATS.md) | what lands on disk |
| [`EVENTS.md`](./EVENTS.md) | every event the harness emits |
| [`UX.md`](./UX.md) | the CLI, window, extension and first-run design |
| [`PLUGINS_MCP_DESIGN.md`](./PLUGINS_MCP_DESIGN.md) | plugins and MCP servers |
| [`META_HARNESS.md`](./META_HARNESS.md) | the harness tuning itself |
| [`RELIABILITY.md`](./RELIABILITY.md) | SLIs, error budget, degradation modes |
| [`TEST_PLAN.md`](./TEST_PLAN.md) | test layers L1–L5 and what each cannot prove |
| [`UPDATE_DESIGN.md`](./UPDATE_DESIGN.md) | the update feed and the two versioned halves |
| [`REFRESH_DESIGN.md`](./REFRESH_DESIGN.md) | the refresh path |
| [`FEATURE_GAPS.md`](./FEATURE_GAPS.md) | the gap list a batch of work closes |
| [`WORKLOG.md`](./WORKLOG.md) | the work log, kept for provenance |

## Contributing to the docs

- Keep behavior claims tied to code and tests. If a doc says "the suite
  checks this", name the test.
- Do not add a new outbound endpoint or local data store without updating
  [`PRIVACY.md`](../PRIVACY.md) in the same change.
- `npm run docs:check` verifies that relative Markdown links resolve. Run it
  before opening a PR.
