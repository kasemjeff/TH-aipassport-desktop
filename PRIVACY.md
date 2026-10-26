# Privacy

This page describes what the app does with data. It is written for the
desktop app, the CLI and the Chrome extension in this repository.

## The short version

- **No telemetry, no analytics, no crash reporting, no "phone home".**
- Your projects, sessions, settings, plugins and logs live under `~/.aipass/`
  on your machine.
- Prompts and attachments you send go to **de.aipass.net** through your own
  logged-in browser tab, because that is the service the app talks to.
- The update check is one GET of a static, signed feed. It carries no user
  identifier.
- If you configure an external model provider, your prompts go to that
  provider under its own terms.

## What is stored locally

| data | where | why |
|---|---|---|
| settings | `~/.aipass/settings.json` | window and harness configuration |
| sessions | `~/.aipass/sessions/` (JSONL) | resume, fork, export |
| loopback token | `~/.aipass/.token` (`0600`) | authenticate the local bridge |
| provider keys, if added | `~/.aipass/credentials.json` (owner-only) or the environment | call the provider you chose |
| plugins and playbooks | `~/.aipass/` and the project's `.aipass/` | local extensions |
| logs | `~/.aipass/logs/` (rotating, capped) | diagnose failures |
| eval results | `evals/results/` (gitignored) | local benchmark runs |

Nothing outside `~/.aipass/` and the project you point the agent at is
written by the app. The agent's file tools write only inside the project,
subject to the permission rules.

## What leaves the machine

- **Prompts, tool results and attachments** — to `de.aipass.net` through the
  logged-in tab, or to a provider you configured. This is inherent in using
  the service.
- **Remote images** the agent is asked to fetch — the bridge fetches them
  behind the private-address guard described in `SECURITY.md`.
- **The update check** — a GET of the signed feed. No identifier, no
  telemetry, no account information.
- **Nothing else.** There is no background analytics endpoint.

The service operator's own privacy policy governs the data that reaches
`de.aipass.net`. This project does not control that service.

## Logs and secrets

Logs are scrubbed for known credential shapes before they are written, and the
suite has tests for the scrubber (`aipass-bridge/test/log-scrub.test.mjs`).
That is a safety net, not a guarantee: do not paste logs into a public issue
without reading them. The security model and its residual risks are in
[SECURITY.md](./SECURITY.md).

## Retention and deletion

- Rotating logs are capped and pruned by the app.
- Sessions stay until you archive or delete them, or remove `~/.aipass/`.
- `rm -rf ~/.aipass` removes all local app state. That is permanent.
- Uninstalling the app does not delete `~/.aipass`; remove it yourself if you
  want the data gone.

## Children

The app is a developer tool and is not directed at children. Do not use it
with an account you are not authorised to use.

## Changes

This page is part of the repository, so changes are visible in the commit
history. If a change adds a new outbound endpoint or a new local data store,
it must update this page in the same pull request.
