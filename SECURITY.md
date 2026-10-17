# Security

This tool drives a browser that is logged into your AiPASS account. It never
reads or forwards a credential — the real request runs as ordinary page
JavaScript inside your own tab, and Chrome attaches the session cookie itself —
but anything that can reach the bridge can *spend* that account. Treat the
bridge port the way you would treat a password.

## Reporting

Open a [security advisory](https://github.com/niawjunior/aipass-bridge/security/advisories/new),
or email the maintainer if you would rather not file publicly. Please do not open
a normal issue for something exploitable.

The process, as small as the project:

1. **Triage asks the configuration question first.** Does the report need
   `AIPASS_ALLOW_REMOTE`, `AIPASS_ADMIN`, `AIPASS_CORS_ORIGIN` or
   `AIPASS_REQUIRE_AUTH=0` to matter? A default-configuration hole ships
   before a non-default one — both get fixed.
2. **A fix lands with its test.** Every closed hole carries a regression
   test in the same change — code, a `SECURITY.md` bullet, tests that pin
   the refusal; the hardening bullets below all follow that shape.
3. **Verify closure.** The regression test is the proof; the `CHANGELOG.md`
   `[Unreleased]` line names the behavior change (no exploit walkthrough
   before users can update); the advisory closes naming the fixed tag.
4. **Announce when copies are affected** — like the pre-2-Sep notice below,
   because a fix without a notice leaves old clones running the hole.

## If you cloned or forked before 2 Sep 2026

**Update.** Every copy taken before commit
[`8cad676`](https://github.com/niawjunior/aipass-bridge/commit/8cad676)
(2026-09-02, 21:55 +07) has a bridge that any website could drive.

The bridge answered every request with `access-control-allow-origin: *` and
`access-control-allow-private-network: true` — the second being exactly the
opt-in Chrome's Private Network Access check requires before a public page may
reach `127.0.0.1` — with no authentication and no `Host` validation. Any page you
had open in that browser could therefore:

- send messages on your AiPASS account and read the replies,
- list your conversation titles,
- read any `*.log` file the process could open, through a path traversal in `/logs`,
- kill the browser, restart the bridge, and reload the extension.

Binding to `127.0.0.1` did not help: the path in was the browser, not the network.

Fixed in [#5](https://github.com/niawjunior/aipass-bridge/pull/5):

- CORS is **off** by default. The CLIs ignore CORS and the extension reaches the
  bridge with host-permission privilege, so neither ever needed it. Set
  `AIPASS_CORS_ORIGIN` only if you deliberately want a browser page to call it.
- The `Host` header is validated against a loopback allowlist, which closes DNS
  rebinding.
- The process-control routes (`/logs`, `/restart`, `/browser/restart`,
  `/ext/reload`, `/tab/reload`) are off unless `AIPASS_ADMIN=1`, which the Docker
  deployment sets and a laptop does not.
- The `/logs` name is allowlisted rather than interpolated.

```bash
git pull                      # a clone
# a fork: merge upstream/main, or re-fork
```

Then restart the bridge and reload the extension.

## Running it safely

- **Keep the bridge on `127.0.0.1`.** Everything except the health probes now
  requires the loopback bearer token (below), so a leaked port alone is no
  longer enough — but port plus token still is.
- **Do not expose the noVNC desktop.** In the headless deployment it is a live
  view of a browser logged into your account. Reach it over an SSH tunnel; if you
  must expose it, set a strong `noVNC_PASSWORD` first.
- **Do not set `AIPASS_CORS_ORIGIN` to `*`.** That reopens exactly the hole above.
- **`AIPASS_ADMIN=1` grants process control** to anything that can reach the port.
  It exists for the container.
- **Secret files never reach the model** (hardened Oct 2026, `harness/settings.mjs`
  `SECRET_RULES` + `harness/permissions.mjs`): `.env*`, `*.pem`/`*.key`/`*.p12`,
  `id_rsa*`/`id_ed25519*`, `credentials.json`, `.aws/`, `.gnupg/`, `*.har` and
  `aipass*.md` captures are denied for reads AND writes in every mode, yolo
  included. An explicit user rule naming the same file still wins (operator
  override), and `kinds` narrowing keeps its documented meaning (H9). The
  WAF-encoded spelling (`DOT-ENV`) is decoded before the check, so
  obfuscation is not a bypass. The same floor now covers the execution
  channels (`harness/permissions.mjs` `secretHit` + `harness/tools.mjs`): a
  RUN whose command spells a secret path is refused before anything spawns,
  SEARCH skips secret files even when their names are not dot-hidden
  (`server.pem`, `id_rsa`), and git patches (`diff` / `show` / `log -p`) drop
  any chunk whose file is a secret and say how many were dropped. What no
  screen can catch is a command that builds the name at runtime (`node -e`
  tricks) — that is arbitrary code, `--allow-run` is the gate, and ask mode
  shows every command before it runs.
- **The bridge refuses to bind off-loopback** (`bridge/server.mjs`): setting
  `AIPASS_HOST` to anything but `127.0.0.1`/`localhost`/`::1` without
  `AIPASS_ALLOW_REMOTE=1` exits instead of listening with no auth.
- **Bridge logs are scrubbed** (`bridge/log-scrub.mjs` `scrubSecrets`): `sk-…`,
  `xox…`, `ghp/gho_…`, `AKIA…`, `AIza…` and `Bearer …` shapes are replaced
  with `[redacted]` before they reach stdout/`bridge.log`. Sessions on disk
  intentionally keep your own text verbatim — treat `~/.aipass/sessions` as
  sensitive and delete it when you decommission a machine.
- **The desktop window runs under a CSP** (`desktop/src-tauri/tauri.conf.json`):
  scripts/styles/images/fonts are local-only, `connect-src` is `self` + `ipc:`
  + the loopback backend, `object-src`/`form-action` are locked down. The
  Tauri capability set stays minimal (window + event only — no fs/shell/http),
  the installer no longer ships the developer test suite, and the Chrome
  extension's host access is the aipass origin plus the loopback bridge —
  verified by tests so it cannot quietly re-broaden.
- **Every route needs the loopback bearer token** (Oct 2026,
  `harness/authtoken.mjs`): a 256-bit token is minted once to `~/.aipass/.token`
  (owner-only intent) and required on the bridge (8787) and the desktop
  backend (8790) for everything except `/status`/`/health`. The extension popup
  stores it once; the CLI and the desktop backend read the file themselves; the
  window bootstraps it from a same-origin-only `/token` endpoint. `AIPASS_TOKEN`
  overrides, `AIPASS_REQUIRE_AUTH=0` disables (with a boot warning).
- **`browser.open` can no longer run a shell** (`harness/rpc.mjs`): the URL is
  allowlisted to `http(s)` and passed as argv through `execFile` — quotes,
  whitespace and shell punctuation are refused. The desktop shell's window
  opener follows the same argv rule.
- **The FETCH tool shares the attachment guard**
  (`harness/tools.mjs` + `bridge/private-hosts.mjs`): literal-IP and DNS-based
  private-address checks run on every redirect hop, in one classifier module so
  the two paths cannot drift.
- **Staged attachments are capped and owned** (`harness/rpc.mjs`): a path stage
  enforces the 20 MB cap before reading the file; dropping a staged reference
  deletes only backend-made copies, never the user's original file.
- **A dead socket drops its client, not the process**: every SSE write and
  keepalive (bridge and desktop backend) is guarded, and a job whose client
  socket died fails immediately instead of leaking until its idle timeout.
- **The WAF table has one owner** (`harness/waf.mjs`): the chat CLI's forked
  copy — already diverged — is gone, and a run pins its own conversation id
  (`harness/harness.mjs`), so surfaces cannot drift and runs cannot cross-talk.

## Data classes

Three classes, one rule each:

- **The repository (public):** code, docs and fixtures. Never secrets —
  `*.har` and `aipass*.md` captures are git-ignored for exactly this reason.
- **The machine store, `~/.aipass/` (sensitive):** sessions (your text
  verbatim), uploads, logs and eval rows. Copyable and deletable by category
  (`docs/DATA_FORMATS.md`); treat it like a drawer of documents, not a cache.
- **Secrets (never read by the model):** anything matching the
  `SECRET_RULES` floor above, plus `~/.aipass/.token`. The token is a
  credential: same-user processes can read it — the boundary is other users,
  sandboxed apps and browser pages.

## Owners

- **Data:** whoever runs the install — single-user by design, and nothing
  phones home, so there is no one else to ask.
- **System and changes:** the maintainer (`LICENSE`); a release requires the
  acceptance checklist and the tagged approver named in `docs/RELEASE.md`.
- **Security reports:** the maintainer, through the advisory channel above.
- **Legal:** the code is MIT. Using it spends *your* deAiPASS account through
  *your* browser session — the account's terms apply, and every message
  enters its chat history ("Known limits" below). Eval fixtures are
  synthetic; importing a public dataset waits on license review
  (`docs/SPEC_EVALS.md`).

## Threat model

The model is treated as an **untrusted author, not an attacker behind an OS
boundary**: the worst case taken seriously is writing files and running what
it was allowed to run (`docs/TECH_STACK.md` on rejected containerisation).
The boundary is the permission floor, the overlay and the loopback token —
not a sandbox. Reviewed each hardening round (the dated entries above): a
new finding gets a dated bullet here and a regression test in the same
change. The honest residuals are the "Known limits" below.

## Known limits, not bugs

- Every message appears in your account's chat history. This drives the real
  product.
- The agent's `--allow-run` executes shell commands in the project root. It is off
  by default for that reason.
- `RUN` runs on this machine's terms: a 120-second cap per command, 10 MB of
  captured output, no CPU or memory cage, and the sandbox (when edits are
  staged) is a projection for honest checks, not a jail. Network access is
  not filtered — FETCH's private-address guard does not apply to a shell
  command.
- Remote image URLs are fetched server-side behind a private-address guard. The
  guard understands IPv4 in every spelling the URL parser leaves (integer, hex,
  octal and IPv4-mapped IPv6 forms) and re-checks every redirect hop. Since
  Oct 2026 it also resolves bare domain names and refuses ones answering with
  a private/loopback/link-local address (fail-open only when DNS itself is
  unreachable) — still, do not point it at URLs you do not trust.
- The loopback token file (`~/.aipass/.token`) is readable by your OS user: any
  process already running as you can read it — and could read your sessions
  anyway. The token stops other users, sandboxed apps and browser pages, not
  same-user malware.
