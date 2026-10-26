# Migrating and upstream sync

This repository is a continuation of
[niawjunior/aipass-bridge](https://github.com/niawjunior/aipass-bridge), not a
GitHub fork. The history was imported, so the upstream commit graph is not part
of this repository. [NOTICE](../NOTICE), [AUTHORS.md](../AUTHORS.md) and
[CREDITS.md](../CREDITS.md) record the provenance.

## From `niawjunior/aipass-bridge`

1. **Back up `~/.aipass/`** before switching. The state format is intended to be
   compatible, but a backup is the only rollback that costs nothing.
2. Clone this repository and run `npm run setup`.
3. Run `npm run doctor` and fix anything it names.
4. Open the extension popup, confirm the loopback token matches
   `~/.aipass/.token`, and keep a logged-in `de.aipass.net` tab open.
5. If you used the upstream bridge on a different port, check
   `~/.aipass/settings.json` and [CONFIG.md](./CONFIG.md). The default port is
   the same; a stale process holding it is the most common failure.

The bridge, extension and CLI are upstream code continued here. The desktop
window and the harness are this repository's work. A bug that exists in the
upstream transport should be reported here with the version and the
`doctor` output; do not assume the upstream project is still maintained.

## From the retired `TH-aipassport-harness` checkout

Clone this repository instead of the retired harness repo. The desktop shell and
the harness live here, and the README's install command points at this
repository. If you have old scripts that clone the harness repo, update the URL.

## How upstream changes are handled

- There is no automatic upstream remote. Changes are reviewed and imported
  deliberately, with the upstream commit named in the commit message.
- The rule is compatibility first: the bridge's transport contract stays
  compatible with the upstream shape, while the harness may extend it.
- If an upstream change conflicts with a local design decision, the local
  decision is documented in the pull request and the commit message; it is not
  silently dropped.
- A security fix from upstream is imported with a regression test and a
  `SECURITY.md` entry, the same shape as a local fix.

## Reporting a migration problem

Open a bug report with:

- the version you came from and the version you are on;
- the output of `npm run doctor`;
- whether `~/.aipass/` was restored from a backup;
- the operating system and Node version.

Do not paste session contents or tokens. See [SUPPORT.md](../SUPPORT.md).
