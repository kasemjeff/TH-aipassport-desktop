# The update system

What "update" means for this app, what has to be true before a build replaces
another one, and which of the two halves of the app may do it on its own.

The short version: **the build is two things, and they version separately.**
The *shell* is the Rust binary — a few MB (the release profile strips
symbols), changes rarely, replaced only by a person, through the installer,
exactly as today. The *content* is everything else the app runs — the
harness, the tools, the window's own JavaScript: **1.58 MiB raw, 0.48 MiB
gzipped**, against a **231 MiB** installer that is 97% Node sidecar and
WebView2 runtime. A signed feed says what is out there; the content updates
in place, atomically, with the previous copy kept so it can be put back; the
shell waits for a person. Nothing runs in the background that the window
cannot name.

This document is a design. **Phase 1, Phase 2 and Phase 3 are built** — the
signed feed, the content pack, the overlay, the atomic promotion, the
rollback, the banner, the `/update` command, and the handover. **The
handover's gate is closed**: it refuses to run an unsigned installer, and
the Windows installer is unsigned today, so the shell half cannot run until
the certificate arrives. It ended with the rules it changed; those were
signed off by the human before the work started (`AGENTS.md`: "loosening a
rule in this system needs the human").

What shipped, and where it lives:

| piece | where |
|---|---|
| the feed, the pack, the promotion, the rollback | `aipass-bridge/harness/update.mjs` |
| the one root rule | `aipass-bridge/harness/app-root.mjs` |
| the keyring | `aipass-bridge/harness/update-keys.mjs` |
| the loadability probe | `aipass-bridge/harness/health.mjs` |
| the release side | `scripts/build-content-pack.mjs`, `scripts/build-update-feed.mjs` |
| the shell half | `desktop/src-tauri/src/main.rs` (the overlay root, the restart code, the backstop) |
| the window half | `desktop/ui/app.js` (the banner, `/update`, the status line) |
| the tests | `aipass-bridge/test/update.test.mjs` |

---

## The problem

Today the answer to "is my aipass current?" is a download page and a
remembered URL. Everything else follows from that:

- **Nobody finds out.** There is no check, so a fix that matters (a WAF table
  change, a permission hole, a broken provider) reaches a user only when
  they happen to read a changelog.
- **The download is 231 MiB.** `dist/aipass-desktop-0.2.0-windows-x64-setup.exe`
  is 242,392,264 bytes, and 88.25 MB of that is the Node sidecar and most of
  the rest is the WebView2 offline installer. Neither changes between 0.2.0
  and 0.2.1. A user checking for a 40 KB bug fix downloads 231 MiB.
- **The rollback is a download too.** `docs/RELEASE.md` keeps the previous
  installers downloadable; that is the rollback, and it works, but it is a URL
  somebody has to keep.

The design has to fix the first problem without making the second one worse,
and without breaking the promise the current install system makes.

---

## The law this collides with

`docs/INSTALL.md` rule 6:

> **No self-update.** The app never replaces itself in the background, so
> "which build is running" is always a fact somebody chose.

`docs/RELEASE.md`: "There is no auto-updater, deliberately (Tauri's updater is
not wired)."

The law is not superstition. It protects three real things:

1. **A person can always say which build they are running** — and can get
   back to one they chose.
2. **An unsigned artifact never installs itself.** The Windows installer is
   unsigned today (`docs/INSTALL.md`: "Windows code signing yet" is future
   work). An app that downloads and runs an unsigned executable on its own
   turns a compromised release host into code execution on every machine.
3. **A broken build is a thing you can walk away from.** If 0.2.1 breaks, you
   reinstall 0.2.0 and you are running 0.2.0 — not staring at an app that
   keeps re-applying 0.2.1.

The design keeps all three. It changes the *unit*: instead of one build that
replaces itself, there are two halves, each with its own rule.

| half | what it is | size | who replaces it | law |
|---|---|---|---|---|
| **shell** | the Rust binary + the Node sidecar + the bundle | 88.25 MB of sidecar + a few MB of binary | **a person**, through the installer | unchanged — rule 6 stands |
| **content** | `aipass-bridge/**`, `ui/**`, `package.json`, `main.mjs` | 1.58 MiB raw / 0.48 MiB gzipped | **the app**, when a person clicks | rule 6 is amended, not deleted |

---

## The idea: two axes, one version number per release

A release still has **one** version. `package.json`, `Cargo.toml` and
`tauri.conf.json` must still agree (`docs/INSTALL.md` rule 3), and the
installer is still named after it. What changes is what an *installation* is:

```
an installation = a shell (binary, version 0.2.0) + a content tree (version 0.2.1)
```

Both numbers are shown, always, in the window's status line. The rollback
story gets *better*, not worse: the previous content tree is kept on disk, so
rolling the content back is a pointer flip, and rolling the shell back is the
reinstall that already works.

`docs/INSTALL.md` rule 3 needs one sentence added — "a build has one version;
an installation has a shell version and a content version, and both are
shown" — because the rule as written ("an installer that names 0.2.0 and ships
0.2.1 cannot be rolled back") is about *installers*, and installers do not
change.

### Why the content can be swapped at all

The installed app is a thin shell over plain text files:

| path | what it is | read at runtime from |
|---|---|---|
| `aipass-bridge/harness/rpc.mjs` | the backend the window talks to | disk |
| `aipass-bridge/**` | the harness, the loop, the tools, the WAF | disk |
| `ui/**` | the window's HTML, CSS and JS | disk — `rpc.mjs` serves it |
| `package.json` | the version (`APP_VERSION`) | disk |
| the Rust binary | the window, the tray, the supervisor | the binary |
| the Node sidecar | the runtime | the bundle |

`harness/rpc.mjs` computes its own root from where it sits
(`APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')`)
and finds the window's files in `APP_ROOT/desktop/ui` or `APP_ROOT/ui`. That
is the whole trick: **a directory with the same shape is a valid app.** The
content tree is copied out of the bundle, changed, and pointed at.

---

## The parts

### 1. The release feed

A static file, served next to the artifacts, signed.

```
https://<release-host>/aipass/desktop/stable/updates.json
https://<release-host>/aipass/desktop/stable/updates.json.sig
```

The signature is **detached and over the exact bytes** — no canonical JSON, no
field order to agree on. `updates.json.sig` is one line:

```
ed25519:aipass-release-2026:<base64 of the 64 raw signature bytes>
```

```json
{
  "schema": 1,
  "product": "aipass desktop",
  "sequence": 7,
  "channel": "stable",
  "generatedAt": "2026-10-21T09:00:00Z",
  "releases": [
    {
      "version": "0.2.1",
      "releasedAt": "2026-10-21T09:00:00Z",
      "commit": "1a2b3c4",
      "notes": "the release notes, in prose — never a file path",
      "content": {
        "version": "0.2.1",
        "file": "aipass-content-0.2.1.json.gz",
        "bytes": 507784,
        "sha256": "…",
        "minShell": "0.2.0"
      },
      "artifacts": [
        {
          "file": "aipass-desktop-0.2.1-windows-x64-setup.exe",
          "platform": "windows",
          "arch": "x64",
          "kind": "nsis",
          "bytes": 242392264,
          "sha256": "…",
          "signature": "unsigned"
        }
      ]
    }
  ]
}
```

- `sequence` is monotonic and is the **rollback guard** (below).
- `minShell` is the oldest shell that can run this content. A content release
  that needs a new shell says so, and the app refuses it rather than running
  code it does not understand.
- `artifacts[]` is the shell update — the same file the build already
  produces, with the same sha256 as `dist/SHA256SUMS`.

The feed is produced by a release lane in CI, signed with the private key from
a secret. The **public** key is in the source (`harness/update-keys.mjs`) —
the feed never carries its own keys, because a feed that can introduce a key
is a feed that can be replaced wholesale.

### 2. The content pack

The content tree as one signed-by-hash file: JSON, gzipped, no format parser
needed.

```json
{
  "schema": 1,
  "product": "aipass desktop",
  "version": "0.2.1",
  "commit": "1a2b3c4",
  "files": [
    { "path": "package.json", "sha256": "…", "encoding": "utf8", "content": "…" },
    { "path": "aipass-bridge/harness/rpc.mjs", "sha256": "…", "encoding": "utf8", "content": "…" },
    { "path": "ui/app.js", "sha256": "…", "encoding": "utf8", "content": "…" }
  ]
}
```

JSON rather than tar because the tree is all text (102 files today, no
binaries), because a person can read what a release contains, and because
`node:zlib` is the only thing needed to make and read it — the repository's
"no dependencies" rule holds with nothing to argue about.

`encoding` is `utf8` or `base64`, so a binary asset later is a one-word
change and not a format change.

The pack's own sha256 is in the signed feed. **That one line is the whole
integrity story**: a pack whose bytes do not match the feed is refused, and
the feed's signature is what makes the hash worth trusting.

### 3. The active content root

```
~/.aipass/app/
  active.json        { schema, current: {version, root}, previous: {version, root}, updatedAt }
  feed-state.json    { sequence, version, checkedAt, etag }
  feed-cache.json    the raw bytes of the last verified feed
  content/<version>/ a promoted content tree (the overlay root)
  staging/<version>/ where a pack is extracted before it is promoted
  downloads/         the shell artifacts
  commands/          the file channel to the shell
```

`active.json` is written with `harness/atomic-write.mjs` — the same
crash-safe swap the session file, the overlay and the settings use. A crash
during a promotion leaves the old pointer, so the app keeps running the
content it had.

The overlay root has the **packaged shape**, so almost nothing has to change:

```
content/0.2.1/
  package.json          → APP_VERSION reads it
  main.mjs              → the launcher
  aipass-bridge/**      → the backend, the harness
  ui/**                 → the window
```

`rpc.mjs`'s own `APP_ROOT` walks up from `aipass-bridge/harness/rpc.mjs` and
lands on the overlay root; `UI_DIRS` finds `ui/` there. Nothing in `rpc.mjs`
has to learn what an overlay is.

**The one thing that must change is the root resolution**, and it must be
single-sourced. Today the shell computes it (`main.rs: find_root`) and the
Node side computes it again (`main.mjs: REPO`). With an overlay there are
three candidates — overlay, bundle, repository — and the order matters:

1. the **overlay** (`~/.aipass/app/content/<version>`), if `active.json` names
   one and its marker file is there;
2. the **bundle** (the resource dir), if the marker is there;
3. the **repository**, walking up from the executable.

The overlay comes first for the reason `find_root`'s comment already gives
("an app that runs the *repository's* files when a checkout happens to sit on
the same machine is not the build that was installed") — the overlay is not a
checkout, it is a *verified release* of the content, and it is the newest
thing that was deliberately put there. The comment needs one more sentence:
the overlay is only ever populated from a pack whose hash is in a signed feed.

Two implementations of this rule (Rust and Node) can drift, so they need the
same treatment the window's policy has: **a test that says the two agree** on
the same fixtures. `desktop/AGENTS.md` already has the precedent ("the window
is served under a policy, not without one").

**The CLI has to move too.** `install_cli_shim` resolves
`aipass-bridge/bin/aipass.mjs` from the *resource* dir, so after a content
update the shim would run the **old** content while the window runs the new
one. The shim must name the active root. This is the bug that would have made
the whole thing quietly wrong, and it is why the root rule is single-sourced
rather than patched in three places.

### 4. The update service

New module `aipass-bridge/harness/update.mjs`. It lives in Node because Node
has `node:crypto` (ed25519 with no dependency) and because the backend is
already the thing that owns the window's state.

```js
export const FEED_URL = '…/aipass/desktop/stable/updates.json';
export function verifyFeed(bytes, sig, keyring);       // → { ok, reason, feed }
export function pickRelease(feed, { platform, arch, shellVersion });
export function compareVersions(a, b);                   // "0.2.10" > "0.2.9"
export async function check({ home, fetchImpl, now });
export async function downloadPack(release, { home, fetchImpl });
export function promote(pack, { home, nodePath });        // atomic
export function rollback({ home });
```

`AIPASS_UPDATE_FEED` overrides the feed URL — the same pattern as
`AIPASS_BRIDGE` and `AIPASS_HOME`, and the only way to point the app at a
local feed for a test.

**The check is not on the page.** The window's CSP has `connect-src 'self'`
and `withGlobalTauri` is off, so the page cannot reach the feed and does not
need to: the backend fetches it and answers over the existing `/rpc`. The page
gains no new privilege (`desktop/AGENTS.md`: "the page is granted nothing it
does not use").

**The cadence.** Once at startup (after the window is up, never before it),
then every 6 hours, then on demand. The result is cached with the feed, so a
machine that is offline for a week does not re-check on every launch. The
check never blocks startup and never competes with a run.

### 5. The surfaces

New RPC methods, all on the existing `/rpc`:

| method | what it does |
|---|---|
| `update.check` | fetch + verify the feed, answer what is out there |
| `update.download` | fetch the pack or the artifact, verify it, put it on disk |
| `update.apply` | promote a verified content pack (Phase 2) |
| `update.rollback` | point `active.json` back at the previous content (Phase 2) |
| `update.install` | ask the shell to hand over to an installer (Phase 3) |
| `update.dismiss` | remember that this version was declined, for this version |

`status` gains two fields so the window can always answer "which build is
this?":

```js
app:   APP_VERSION,          // the content's version (today's `build:` line)
shell: process.env.AIPASS_SHELL_VERSION,   // the binary's version
source: 'overlay' | 'bundle' | 'repo',
```

The Rust shell passes `AIPASS_SHELL_VERSION`, `AIPASS_CONTENT_SOURCE` and
`AIPASS_NODE_PATH` to the backend it spawns. The status line reads:

```
build 0.2.1 · shell 0.2.0 · content from the overlay
```

**The banner.** The window already has a banner with a one-click fix
("a run with no chat tab gets a banner with a one-click fix"), and the update
notice is the same shape: one line, one button, no modal, no interruption.

- *new version available* → "มีเวอร์ชันใหม่ 0.2.1 — ดูรายละเอียด" / "อัปเดตเดี๋ยวนี้"
- *downloading* → a progress line
- *verifying* → the hash is being checked
- *applied* → "อัปเดตแล้ว — เปิดใหม่เพื่อใช้" (Phase 2) or "พร้อมแล้ว" (Phase 1)
- *refused* → the reason, in the app's own words: "ฟีดอัปเดตไม่ผ่านการตรวจสอบ —
  ไม่ได้ติดตั้ง"

A palette command `/update` opens the same panel, so the whole thing is
reachable from the keyboard (`desktop/AGENTS.md`: "every palette command must
map to a real handler").

### 6. The shell handover (Phase 3) — built, and gated

```
the window says "ติดตั้งเวอร์ชันนี้ (แอปจะปิดแล้วเปิดใหม่)"
  → the backend checks the feed, refuses an UNSIGNED installer
  → it fetches the artifact, verifies it against the signed feed, and
    writes ~/.aipass/app/commands/install.json
  → the shell's 2-second tick sees the command
  → the shell hashes the file again with the app's own Node, and refuses
    anything whose hash is not the one it was handed
  → the shell spawns a DETACHED helper — the app's own executable with
    `--install-and-relaunch` — and closes
  → the helper runs the installer and brings the app back
```

The command file names a **file**, not a path. The shell builds the path
itself, inside `~/.aipass/app/downloads/`. A command file cannot make the
shell run an arbitrary path.

The helper is the app's own executable with an argument, so nothing is
quoted into a shell and nothing depends on a shell being there — the
Windows-clean rule holds. It runs before the app is built: it is not an
app.

**The gate.** The handover refuses to run an **unsigned** installer, and
the Windows installer is unsigned today (`docs/INSTALL.md`). The gate is
the signed feed's own `signature` field for the artifact, so only the
release key can open it — not a settings key, not an env var. The
mechanism is written and provably inert; it opens when the certificate
does and the release says `signed`.

The channel's trust level is the plugin directory's
(`~/.aipass/plugins/` holds code the harness loads and runs), and the design
does not raise the ceiling: a local process that can write into `~/.aipass`
can already get code execution through the app today. That is a fact to state
in `SECURITY.md`, not a fact to hide. The handover is Windows-only; on
macOS and Linux the installer is the system's own, and the app says so.

---

## The trust model

| threat | what stops it |
|---|---|
| the release host is compromised | the feed's ed25519 signature — the key is in the source, not in the feed |
| an old signed feed is replayed | `sequence` must not go backwards; the last one is remembered in `feed-state.json` |
| the pack is tampered with in transit | its sha256 is inside the signed feed |
| a file is wrong inside the pack | every file carries its own sha256, checked after extraction |
| a key is retired | the keyring in the source drops it; a feed signed by a retired key is refused |
| the machine is offline | the cached feed is used; a stale one says it is stale; **nothing is nagged** |
| the feed says something absurd | `minShell` refuses content the shell cannot run; the artifact list is filtered by platform and arch |

**Nothing about the machine is sent.** The check is one GET of a static file
from a pinned URL. No identifier, no telemetry, no "phone home" — the feed is
a file, not a call.

**The keyring** (`harness/update-keys.mjs`) holds the current public key and
the next one, so a rotation does not need the old key to still be trusted.
Retiring a key is a release, like any other change to the trust material.

**Zero dependencies.** ed25519 verification is `node:crypto`:

```js
crypto.verify(null, bytes, keyObject, signature);
```

`node:crypto` is a builtin, so the repository's "no npm package" rule holds
with nothing to argue about. This is the one reason the verification lives in
Node and not in the Rust shell — a Rust ed25519 crate would be a new
dependency (`AGENTS.md` rule 11).

---

## Atomicity, rollback, and the failure modes

**The promotion** (`promote()`), in order, with nothing half-done at any step:

1. extract the pack into `staging/<version>/`;
2. check every file's sha256 against the pack;
3. **smoke-test the staged content** — run the bundle's own Node against the
   staged tree's `harness/health.mjs`, which is a side-effect-free module
   that answers "am I loadable?". A staged tree that cannot be imported is
   never promoted;
4. rename `staging/<version>` → `content/<version>` (a directory rename is
   atomic on POSIX; on Windows the target does not exist yet, so it is a
   move);
5. write `active.json` with `writeFileAtomic`, carrying the old entry as
   `previous`.

A crash at any point leaves `active.json` pointing at content that is still
there and still working. There is no state where half a content tree is live.

**The rollback** is step 5 in reverse: point `active.json` back at
`previous`. The previous tree is kept — the last two versions, pruned
afterwards. The content rollback is a pointer flip; the shell rollback is the
reinstall that already works (`docs/INSTALL.md`: "Rollback is the previous
artifact, installed the same way").

**The backstop.** The smoke test catches a content tree that cannot load. It
does not catch one that loads and then misbehaves. For that, the shell's
supervisor — which already watches the backend child and restarts it with
backoff — gets one more rule: if the child dies three times in a row shortly
after a promotion, and `active.json` has a `previous`, the shell puts the
previous content back and lets the supervisor try again. Without it, a broken
content release leaves the app unable to start until a person intervenes;
with it, the app heals itself.

**What else must not happen.**

- **An update is never applied while a run is in flight.** A run holds the
  harness in memory; swapping the files under it is how a half-applied state
  becomes a mystery. `update.apply` is refused while `running` is true, and
  the window says "จะอัปเดตหลังจบรอบนี้" rather than pretending it can.
- **A stop still ends the work** (`AGENTS.md` rule 13). An update is not a
  reason to keep a run alive, and a run is not a reason to refuse an update
  forever — it is a reason to defer it to the next quiet moment.
- **The data is never touched.** `~/.aipass/settings.json`, the sessions, the
  token and the logs belong to the user; the content tree lives beside them
  in `~/.aipass/app/` and the installer still does not write there. An
  uninstall removes the shell and leaves `~/.aipass` alone, content included
  (it is the user's, and it is how the content rolls back).

---

## The phases

Each phase is shippable on its own, and each says what it costs.

### Phase 1 — "the app knows" (no rule changes) — **built**

- The signed feed, the check, the banner, the release notes, the download
  button.
- The artifact is downloaded and **verified** (its sha256 against the signed
  feed) before it is put on disk, so the person who runs it runs a file that
  was checked.
- The person installs it themselves. Rule 6 is untouched.
- The cost: a signed feed and a release lane. The gain: nobody is left on a
  build with a known hole, and the "is 0.2.1 out?" question has an answer.

### Phase 2 — "the content updates itself" (one rule amended) — **built**

- The content pack, the overlay, the atomic promotion, the rollback, the
  smoke test, the backstop.
- `docs/INSTALL.md` rule 6 became: **the app never replaces the shell in the
  background; the content is replaced only when a person asks for it, and
  both versions are always shown.**
- The gain: a bug fix in the harness reaches a user in 0.5 MB and one click,
  and the shell — which changes rarely — still waits for a reinstall.
- The cost: the overlay, the root resolver, the CLI shim fix, and the
  backstop in Rust. This is the expensive phase; Phase 1 is not.

### Phase 3 — "the shell updates itself" (wired, gated on signing) — **built, closed**

- The handover: the backend verifies the artifact against the signed feed
  and leaves a command; the shell reads it, checks the artifact's hash
  again with the app's own Node, starts a detached helper — the app's own
  executable with an argument — and closes; the helper runs the installer
  and brings the app back.
- **The gate is closed, and it stays closed until the Windows installer is
  signed.** The feed records each artifact's signature state, and the app
  refuses to hand over to an `unsigned` one. The Windows installer is
  unsigned today (`docs/INSTALL.md`), so the path cannot run. The gate is
  the signed feed's own word, so only the release key can open it — and the
  key is the maintainer's.
- Why it is built anyway: the mechanism is the part that is hard to get
  right (a running binary is locked, the helper has to outlive the app,
  nothing may be quoted into a shell), and it is better to have it written
  and provably inert than to write it under pressure when the certificate
  arrives.
- The handover is Windows-only. On macOS and Linux the installer is the
  system's own, and the app says so rather than pretending.

---

## The rules this would change

These need the human. Each is a loosening or an amendment, and `AGENTS.md`
says a loosening needs the human.

**`docs/INSTALL.md` rule 6** — today:

> **No self-update.** The app never replaces itself in the background, so
> "which build is running" is always a fact somebody chose.

becomes (Phase 2):

> **No shell self-update.** The app never replaces its own binary in the
> background. The content tree — the harness and the window — is replaced
> only when a person asks for it, from a pack whose hash is in a signed feed,
> and both the shell version and the content version are always shown.

**`docs/INSTALL.md` rule 3** — one sentence added: a build has one version; an
installation has a shell version and a content version, and both are shown.

**`docs/RELEASE.md`** — "There is no auto-updater, deliberately (Tauri's
updater is not wired)" becomes the phase table above, and the release lane
grows a signing step.

**`AGENTS.md`** — a new hard rule, with the `Verify:` anchors below.

**`desktop/AGENTS.md`** — a UI law: the update notice is a banner with one
button; it never blocks a run; it never applies while a run is in flight.

**`SECURITY.md`** — the feed's trust model, the command channel's trust level,
and the fact that the check sends nothing about the machine.

---

## The files

**New**

| file | what it is |
|---|---|
| `aipass-bridge/harness/update.mjs` | the service: verify, check, download, promote, roll back |
| `aipass-bridge/harness/update-keys.mjs` | the baked public keyring |
| `aipass-bridge/harness/app-root.mjs` | the single root resolver (overlay → bundle → repo) |
| `aipass-bridge/harness/health.mjs` | the side-effect-free "am I loadable?" module |
| `aipass-bridge/test/update.test.mjs` | the tests |
| `scripts/build-content-pack.mjs` | builds the content pack (`npm run desktop:content-pack`) |
| `docs/UPDATE_DESIGN.md` | this document |

**Changed**

| file | what changes |
|---|---|
| `aipass-bridge/harness/rpc.mjs` | the update methods; `status` carries the shell version and the content source |
| `desktop/ui/app.js` | the banner, the status line, the `/update` command |
| `desktop/src-tauri/src/main.rs` | the overlay candidate in `find_root`; the shell version in the child env; the CLI shim points at the active root; the command channel; the backstop |
| `package.json` | the `desktop:content-pack` script |
| `docs/INSTALL.md`, `docs/RELEASE.md`, `docs/MATURITY.md`, `docs/RELIABILITY.md` | the rules, the release lane, the registry row, the SLIs |
| `AGENTS.md`, `desktop/AGENTS.md`, `SECURITY.md`, `CHANGELOG.md` | the rules and the behavior change |

---

## The tests

The repository's truth is the suite, and a rule ends with the test that
enforces it. These are the titles the new rule would anchor to — they do not
exist yet, and each is written with its change.

| title | what it pins |
|---|---|
| "a feed whose signature does not verify is refused" | the signature is the trust, and a broken one is a refusal |
| "a feed signed by an unknown key is refused" | the keyring is the source of truth, not the feed |
| "a feed with an older sequence number is refused" | an old signed feed cannot be replayed |
| "a content pack whose hash does not match the feed is refused" | integrity comes from the signed feed |
| "a content pack is promoted atomically — a failed promotion leaves the old content in place" | a crash mid-promotion is not a broken app |
| "a content release is refused when the shell is too old for it" | `minShell` is enforced, not decorative |
| "the window and the CLI run the same content" | the shim points at the active root |
| "the shell resolves the same root as the Node side" | the two implementations of the rule agree |
| "an update is never applied while a run is in flight" | a run is not interrupted by an update |
| "the update check does not run when the network is down" | the cache answers, and nothing is nagged |
| "the content rollback puts the previous content back" | the rollback is a pointer flip, and it works |

---

## What this deliberately does not do

- **No delta updates.** The pack is 0.48 MiB; a delta would be a second
  format, a second verifier and a second thing to get wrong.
- **No update of the Chrome extension.** It is loaded by hand, and that is
  the one manual step in the install (`docs/INSTALL.md`).
- **No update of the bridge's server side.** That is `de.aipass.net`'s.
- **No update of the Node sidecar.** It ships with the shell; a release that
  needs a new Node says so in the artifact, and the installer carries it.
- **No telemetry, no phone home.** The check is one GET of a static file.
- **No update of `~/.aipass`'s data.** Settings, sessions and logs are the
  user's, and no install, upgrade, rollback or uninstall touches them.
- **No signed Windows installer yet.** The handover is wired and its gate is
  closed: it refuses an `unsigned` installer, so it cannot run until the
  certificate arrives. The manifest keeps saying `unsigned` out loud, and
  so does the feed.
