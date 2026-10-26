# FAQ

## Is this the official AiPASS client?

No. This is an independent community project. It talks to `de.aipass.net`
through your own logged-in browser tab. It is not affiliated with or endorsed
by the service operator. See [TRADEMARK.md](../TRADEMARK.md).

## Do I need an API key?

No, for the default setup. You need a `de.aipass.net` account and a Chrome or
Chromium tab logged in to it. The bridge uses that tab's session. You can
configure an external provider if you want one; that provider may require a
key. See [CONFIG.md](./CONFIG.md).

## Why Chrome? Why an extension?

The service accepts one user message per request and authenticates with the
browser session cookie. The extension is the only component that touches that
session; it runs the request as ordinary page JavaScript inside your own tab.
No credential is copied out of the browser.

## Where does my data go?

Prompts and attachments go to `de.aipass.net` through your tab (or to a
provider you configured). Local state lives in `~/.aipass/`. There is no
telemetry. See [PRIVACY.md](../PRIVACY.md).

## Does it work offline?

The window and the local backend start offline, but a run needs the service
(or a configured provider). The update check is optional and does not block
the window.

## Do I need Node?

For the source install, yes: Node 22 or 24 is recommended. Node 20 is still in
the CI matrix for compatibility, but it is end-of-life upstream. The packaged
desktop app carries its own Node sidecar.

## Do I need Rust?

Only to build the native window. `npm run desktop` runs the window in a browser
without Rust. The Tauri build needs the Rust toolchain and the Tauri CLI; see
[INSTALL.md](./INSTALL.md).

## Where are my sessions?

`~/.aipass/sessions/`, one JSONL file per session. `aipass list conversations`
shows them; the window shows the same store.

## How do I uninstall?

Remove the `aipass` command from your PATH and, if you want the data gone,
`rm -rf ~/.aipass`. See the uninstall section of [INSTALL.md](./INSTALL.md).

## Why is the Windows installer unsigned?

Code signing needs a certificate the project does not have yet. The manifest
records the artifact as unsigned, and Windows will show SmartScreen. macOS is
signed and notarized when the release machine has the Apple credentials; see
[RELEASE.md](./RELEASE.md) and [INSTALL.md](./INSTALL.md).

## How can I help?

Read [CONTRIBUTING.md](../CONTRIBUTING.md). Bug reports with a full
`npm run doctor` output are useful. The [ROADMAP.md](../ROADMAP.md) lists the
current gaps.
