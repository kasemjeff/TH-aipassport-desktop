# The install system

What installing **aipass desktop** means, what an install has to guarantee,
how each platform does it, and how a release is built, checked and rolled
back.

The short version: **one artifact per platform, named after its version, with
a checksum beside it; the user's data never leaves `~/.aipass`; the install is
proven by one command; and no build ever replaces itself in the background.**

The procedure around a tag lives in [`RELEASE.md`](RELEASE.md); this document
is the shape of the thing a tag ships.

---

## The three surfaces

An install touches three things, and keeping them apart is most of the design:

| Surface | What it is | Where it lands | Who owns it |
|---|---|---|---|
| **The window** | the Tauri app — chat, file agent, tray | the platform bundle (`%LOCALAPPDATA%\Programs\…`, `/Applications/…`, `/usr/bin/…`) | the installer |
| **The CLI** | `aipass` on `PATH` — the same bridge, in a terminal | a per-user shim, or a source checkout | the installer (today: `aipass-bridge/install.ps1` / `install.sh`) |
| **The data** | settings, sessions, the loopback token, logs, plugins | `~/.aipass` | **the user** — never the installer |

The rule that follows: **an installer writes to its own install directory and
to nothing else.** `~/.aipass` is read and written by the app and the CLI,
never by the installer, so an install, an upgrade, a rollback and an uninstall
all leave the user's work exactly where it was.

The window and the CLI are the *same* program in two shapes: both run the
`.mjs` files under `aipass-bridge/`, both read the same settings file, and
both talk to the same loopback backend. That is why the packaged app ships
the whole `aipass-bridge/` tree as resources — the CLI is already in the
bundle, one shim away.

---

## The contract

Seven rules. Each one is a thing that can go wrong, and each one is checked
somewhere:

1. **The bundle is self-contained.** The app ships its own Node (the
   sidecar), so a machine without Node is a supported machine. The bundler
   finds the sidecar by the target triple
   (`desktop/sidecar/fetch-node.mjs` writes that name).
2. **The data survives everything.** Install, upgrade, rollback and uninstall
   never touch `~/.aipass`.
3. **One version number.** `package.json`, `Cargo.toml` and `tauri.conf.json`
   must say the same string; `scripts/build-desktop.mjs` refuses to build when
   they do not. An installer that names 0.2.0 and ships 0.2.1 cannot be
   rolled back. A *release* still has one version; an *installation* has a
   shell version and a content version, and both are shown (rule 6).
4. **One artifact per platform and architecture**, named
   `aipass-desktop-<version>-<platform>-<arch>.<ext>`, with a
   `SHA256SUMS` file and a `manifest.json` beside it. The manifest says what
   was built (commit, dirty flag, timestamp) and whether it was signed.
5. **The install is verified by one command.** `npm run doctor` — the same
   check the source checkout runs, and the same one the installed CLI would
   run (`aipass doctor`) — proves the chain end to end: Node, the bridge, the
   extension, the model list.
6. **No shell self-update.** The app never replaces its own binary in the
   background. The *content* — the harness, the bridge and the window's own
   files — is replaced only when a person asks for it, only from a pack whose
   hash is in a **signed** feed, and only when no run is in flight; the
   previous content tree is kept, so it can be put back. Both versions are
   always on screen, so "which build is running" is still a fact somebody
   can read. The design is in [`UPDATE_DESIGN.md`](UPDATE_DESIGN.md).
7. **An unsigned artifact says so.** The manifest records it; the download
   page must too.

---

## The layers

```
source ──▶ build (scripts/build-desktop.mjs) ──▶ artifact + checksum + manifest
                                                      │
                                                      ▼
                                                install (per platform)
                                                      │
                                                      ▼
                                          window + CLI  ──  data in ~/.aipass
                                                      │
                                                      ▼
                                        verify (aipass doctor) ──▶ upgrade ──▶ rollback
```

Each layer has one owner and one way in, so a failure names itself.

---

## The build

`npm run desktop:build` is the only entry point. It:

1. **checks the three versions agree** — a mismatch stops the build;
2. **puts the Node sidecar in place** for the triple being built (a missing
   one is copied from the local node; a *cross* build cannot do that, so the
   file for the other architecture is a human's job);
3. **asks for the platform's bundles** — NSIS on Windows, `.app` + `.dmg` on
   macOS, `deb` + `AppImage` on Linux;
4. **runs the bundler** with the base config plus the platform overlay;
5. **collects the artifacts** into `dist/`, renames them to the canonical
   name, and writes `dist/SHA256SUMS` and `dist/manifest.json`.

The bundler is the Tauri CLI, and it comes in two spellings: the npm shim
(`tauri`, from `@tauri-apps/cli`) and the cargo one (`cargo tauri` — the
`tauri-cli` crate installs `cargo-tauri`, *not* `tauri`). This repository
installs no npm packages, so the CLI comes from cargo:

```
cargo install tauri-cli --version "^2"
```

The build script takes whichever the machine has — the shim first, the cargo
spelling otherwise — and `AIPASS_TAURI_CLI` names the binary to run when
neither is on PATH.

### The platform overlays

One `tauri.conf.json` cannot say "NSIS on Windows, a DMG on macOS", so the
bundle set lives in a per-platform file next to it:

| File | Bundle targets | Also |
|---|---|---|
| `desktop/src-tauri/tauri.windows.conf.json` | `nsis` | — |
| `desktop/src-tauri/tauri.macos.conf.json` | `app`, `dmg` | `minimumSystemVersion` 10.15, hardened runtime on |
| `desktop/src-tauri/tauri.linux.conf.json` | `deb`, `appimage` | — |

The Tauri CLI merges the file whose name matches the platform it is building
on, and the merge *replaces* the bundle list — so the base config keeps
`nsis` as the default and each platform file overrides it. `tauri build` on a
Mac therefore picks the macOS one with no flag and no script. The build
script passes the file explicitly anyway, so the plan does not depend on
where the CLI was started from.

### What the artifacts are called

| Platform | Artifact | Installs as |
|---|---|---|
| Windows x64 | `aipass-desktop-<v>-windows-x64-setup.exe` | per-user, no admin, uninstallable from *Apps* |
| macOS arm64 / x64 | `aipass-desktop-<v>-macos-<arch>.dmg` | drag to `/Applications`; the `.app` inside is the app |
| macOS universal | `aipass-desktop-<v>-macos-universal.dmg` | one DMG for both architectures (opt-in, see below) |
| Linux x86_64 | `…-linux-x86_64.deb`, `…-linux-x86_64.AppImage` | system package, or a file you run |

Windows ships **NSIS only**. MSI would add a second installer and an admin
prompt for a single-user tool that has no need for either.

---

## The platforms

### Windows

- **NSIS, per-user.** The install directory is under `%LOCALAPPDATA%`, so no
  administrator is involved; the uninstaller is in *Apps* and removes only
  the install directory.
- **The WebView2 runtime** ships inside the installer
  (`webviewInstallMode: offlineInstaller`), so the install works on a
  machine that never saw Edge. Together with the Node sidecar it is the
  reason the installer is a couple of hundred megabytes, and the reason it
  works with no network at all.
- **Unsigned.** Windows shows a SmartScreen warning on an unsigned
  installer. The manifest says `unsigned`, and `RELEASE.md` says it out loud
  rather than pretending otherwise.

### macOS

macOS is the platform with the most ceremony, and every piece of it has a
reason:

- **A `.dmg` around the `.app`.** The `.app` bundle is a directory, so the
  artifact that travels is the disk image; the `.icns` is generated by the
  bundler from the PNGs in `desktop/src-tauri/icons/`, so there is no second
  icon file to keep in step.
- **The window is a local HTTP document.** It is loaded from the backend on
  `http://127.0.0.1:8790`, and WKWebView applies App Transport Security to
  that. `desktop/src-tauri/Info.plist` (merged into the bundle by the
  bundler) sets `NSAllowsLocalNetworking` — the narrow exemption that covers
  a local origin, and nothing else is loosened. It is there so the packaged
  window is never blank because of a transport policy.
- **Signing.** Apple Silicon refuses to run an unsigned app, and Gatekeeper
  refuses an unnotarized one that came from a browser. A **Developer ID
  Application** certificate in the keychain signs the bundle
  (`APPLE_SIGNING_IDENTITY`); the hardened runtime is on, which notarization
  requires. An **ad-hoc** signature (`signingIdentity: "-"`) is enough to
  run the build on the machine that made it, and nothing more.
- **Notarization.** `APPLE_API_ISSUER` + `APPLE_API_KEY` +
  `APPLE_API_KEY_PATH` (an App Store Connect key) or the Apple ID method
  (`APPLE_ID` + `APPLE_PASSWORD` + `APPLE_TEAM_ID`). The notary staples the
  ticket, so the first launch does not need the network.
- **The uninstaller is a trash can.** There is no NSIS on macOS: the app is
  dragged to `/Applications`, and removing it means dragging it out. That is
  why the data rule matters more here than anywhere else — `~/.aipass` is
  the only thing that survives.

### Linux

`deb` for a system install and `AppImage` for a file you run. The AppImage
carries the whole app — Node included — so it works on a distribution the
project has never seen.

### Where the builds run

| Platform | Where | What that host needs |
|---|---|---|
| Windows x64 | a Windows runner or a dev machine | Rust, the MSVC build tools |
| macOS arm64 / x64 | a macOS runner (`macos-latest`) or a Mac | Rust, the Xcode command line tools, and — for a published artifact — the signing material |
| Linux x86_64 | a Linux runner | Rust and the webkit2gtk development packages |

The repository's CI has a macOS lane for the Node suite and a **build lane**
(`.github/workflows/build.yml`) that produces the artifact, the checksum and
the manifest on all three platforms — the macOS one is the reason a Mac is
needed in CI at all. A lane that *installs* the artifact is the next step,
and it needs a display (xvfb on Linux) and a decision about which machines
may install software.

---

## Can macOS do it?

**Yes — but not from this Windows machine, and not without a Mac.**

What the repository already has:

| Piece | State |
|---|---|
| The Rust shell compiles for macOS | `cargo check --target aarch64-apple-darwin` and `--target x86_64-apple-darwin` both pass from a Windows machine — the crate has no Windows-only assumption in it — and the `#[cfg(not(windows))]` branches (the process-group kill, the sidecar names for both Darwin triples) are in the tree |
| The sidecar naming | `fetch-node.mjs` knows `x86_64-apple-darwin` and `aarch64-apple-darwin` |
| The bundle set | `tauri.macos.conf.json` asks for `.app` + `.dmg` |
| The icon | the bundler writes the `.icns` from the PNGs |
| The window's policy | `Info.plist` carries the ATS exemption for the loopback origin |

What a Mac is needed for, and why it cannot be done elsewhere:

1. **The bundler is macOS-only.** `.app` and `.dmg` need `hdiutil`,
   `codesign`, `xcrun` and the macOS SDK. The Rust *crate* does cross-compile
   — it type-checks for both Darwin targets from a Windows machine — but the
   *bundle* cannot be made off a Mac.
2. **Signing needs a keychain.** The Developer ID certificate lives in a
   macOS keychain, and `codesign` is what signs the bundle and the nested
   sidecar.
3. **Notarization needs Apple's notary service**, which needs the signed
   bundle and an Apple credential.
4. **The architecture is the machine.** An Apple Silicon build needs an
   arm64 Node sidecar — the local `node` of an Intel Mac cannot be copied
   into that slot, and vice versa. The build script refuses a cross build
   whose sidecar is missing, rather than shipping an app that cannot start;
   the bundler refuses it too, in its own words:
   ``resource path `..\sidecar\node-aarch64-apple-darwin` doesn't exist``.

So the macOS pipeline is: **a macOS runner** (`macos-latest` in CI, or a
Mac), the sidecar for its own triple, and the signing material. The Windows
pipeline is the same script with a different table row.

### The macOS gaps that are left, in order of how much they matter

1. **Nobody has run the packaged app on a Mac.** The window, the tray and
   the quit path are hand-verified on Windows only; the macOS build is
   *wired*, not *proven*. The first thing to do on a Mac is: build, install
   the DMG, open the window, close it to the tray, quit from the tray, and
   watch `~/.aipass/logs/desktop-backend.log`.
2. **The universal DMG needs a universal Node.** The build is wired
   (`AIPASS_DESKTOP_TARGET=universal-apple-darwin`), and the sidecar it
   needs is one script away: `npm run desktop:sidecar:universal` merges the
   two official Node builds with `lipo` — a macOS job, because `lipo` is one.
   A merged binary carries no signature, so the script signs it when an
   `APPLE_SIGNING_IDENTITY` is configured, and the bundler signs it with the
   app's identity otherwise.
3. **The CLI shim lands in a directory that may not be on PATH.** The tray
   item writes it and the window says where it went; adding the directory to
   PATH is the person's call.

---

## The one manual step

The bridge talks to `de.aipass.net` through a **logged-in Chrome tab** and a
Chrome extension that is loaded by hand (developer mode → *Load unpacked* →
`aipass-bridge/extension`). No installer can do that: a browser extension
needs a human who says yes.

So the install is not the end of the story, and the app does not pretend
otherwise — the window says what is missing and offers the fix it has (open
the tab, load the extension) instead of failing quietly. `npm run doctor`
answers the same question from a terminal.

---

## The CLI from the installed app

The bundle already carries the whole CLI (`aipass-bridge/bin/aipass.mjs`), so
the window can put it on `PATH` — one click, one file:

- **the tray menu → "ติดตั้ง CLI (aipass)"** writes a shim into a per-user
  bin directory (`~/.local/bin/aipass` on unix,
  `%LOCALAPPDATA%\aipass\bin\aipass.cmd` on Windows);
- the shim runs **the app's own Node** against **the app's own CLI**, so a
  machine without Node still gets a working `aipass`;
- nothing is written until somebody clicks — installing is the consent
  moment, and the window says where the shim went.

The directory may not be on `PATH` yet; adding it is the person's call, and
the window says which directory that is.

---

## Verify, upgrade, rollback

```powershell
npm run desktop:build     # the artifact, its checksum and its manifest
npm run doctor            # the chain, end to end, on the machine it runs on
npm run desktop:install-ladder -- --new dist/aipass-desktop-0.2.0-windows-x64-setup.exe
```

- **Upgrade** is an install over the old one. The data is untouched; the new
  build reads it with the same merge rules the old one did.
- **Rollback** is the previous artifact, installed the same way. The
  previous artifacts stay downloadable — that *is* the rollback target.
- **The content updates on its own, the shell does not.** The app checks a
  signed feed, and when the feed names a newer content tree it offers it as a
  banner with one button. The click is the consent; the pack is verified
  against the hash in that signed feed before a single file is written, and
  the previous content tree is kept so it can be put back (`/update` in the
  window shows the state, and `update.rollback` in the backend does the
  putting back). The shell still waits for a person and the installer.
- **The ladder** (`scripts/install-ladder.mjs`) is that procedure, scripted:
  it installs the artifact, checks the installed build is the one that was
  shipped (its version) and that it actually runs (its backend answers),
  installs the new build over the old one and checks it again, installs the
  old build back and checks it again, uninstalls — and then checks that the
  user's data is still there. Give it both artifacts to walk the whole
  ladder:

  ```powershell
  npm run desktop:install-ladder -- --new <new installer> --old <the previous release's installer>
  ```

  It installs software on the machine it runs on, so it asks first
  (`--yes` answers for a release machine), and it never touches the real
  `~/.aipass`: the app runs with `AIPASS_HOME` pointing at a scratch
  directory, which the shell reads the same way the Node side reads it.

---

## What this deliberately does not do

- **No shell self-update.** The app never replaces its own binary in the
  background — the installer still does that, and a person still chooses it.
  (The *content* does update in place, under rule 6: the design is in
  [`UPDATE_DESIGN.md`](UPDATE_DESIGN.md).)
- **No self-replacing installer, ever, until the installer is signed.** The
  handover — the app exits, the installer runs, the app comes back — is
  wired (Phase 3 of `UPDATE_DESIGN.md`), and its **gate is closed**: it
  refuses to run an unsigned installer, and the Windows installer is
  unsigned. The gate is the signed feed's own word about the artifact, so
  only the release key can open it. An app that downloads and runs an
  unsigned installer on its own is the worm shape.
- **No Windows code signing yet.** The manifest says `unsigned`, and the
  release notes say so. A signed installer needs a certificate and a
  reputation; pretending otherwise is worse than saying it.
- **No sandboxing.** The app edits the files a person points it at; that is
  the product. The App Sandbox would be a different product.
