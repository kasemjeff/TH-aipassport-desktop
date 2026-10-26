# Release & rollback

What a release is here, what has to be true before one is tagged, and how to
undo one. The short version: the tag is the release, the previous installer is
the rollback, and there is nothing to migrate because the readers merge.

## Versioning

- `package.json` `version` is the unit that ships; tags are `vX.Y.Z` on the
  exact commit the installers were built from. No tag, no release.
- Minor for features and behavior changes, patch for fixes. A change that
  would make an *older* build misread data it wrote is not allowed to ship as
  a quiet patch — it ships a reader first (see "Data compatibility").
- **Session `schema: 1`, settings merge-over-DEFAULTS, eval fingerprints.**
  There is no migration step to run, by design (`docs/DATA_FORMATS.md`). The
  fields that make old artifacts legible ship *before* the fields that make
  new ones interesting.
- **Reproducibility of claims**: eval rows record the model id, the budget
  used and the replay fingerprint; the summary reports every attempt
  (`--attempts`). A performance claim in release notes without a pinned
  `evals/results/*.jsonl` is an anecdote, and should read like one.

## Acceptance criteria

Before `git tag vX.Y.Z`, all of these are true:

1. **`npm run check`** green on the release commit — the full suite plus the
   QA loop, including the live backend checks.
2. **CI matrix** green on Ubuntu, macOS and Windows × Node 20/22/24
   (`.github/workflows/test.yml`), plus the docs, parse/shellcheck, CodeQL and
   Rust jobs. The release workflow's own `gate` job runs the suite, type check,
   eval lint, coverage floors and docs check again on the tagged commit; a
   failed gate stops the release before any artifact is published.
3. **`npm run doctor`** against a real signed-in tab, on at least one machine
   (the one the release notes were written on).
4. **`npm run stats -- --strict`** — no warning fired on this machine's recent
   runs; if one did, it's named in the release notes. The rule behind that
   sentence — zero warned runs over the last 50 is the error budget — is
   `docs/RELIABILITY.md`.
5. Advisory, not gating: `npm run evals -- --all --live --advisory --keep
   --pause 10000` (includes the safety set) and `npm run loadtest -- --strict`.
   Paste the `metrics:` line into the release notes when the run happened; say
   so when it didn't. If this release moves the default model, its gate
   evidence rides along — safety rows within 30 days and an `evals:compare`
   verdict (`docs/SPEC_EVALS.md`); stale safety rows are not evidence.
6. **`CHANGELOG.md` updated** — `[Unreleased]` becomes the version; "Known
   limits, not bugs" (`SECURITY.md`) and the not-shipped list
   (`docs/HARNESS_DESIGN.md`) still tell the truth.
7. Installers built (`npm run desktop:build` — it puts the sidecar in place,
   asks the bundler for the platform's bundles and writes `dist/` with the
   checksums and the manifest); the artifacts are attached to the tag's
   release, and **the previous release's installers stay downloadable** —
   that is the rollback. A macOS artifact needs a Mac to build and to sign:
   see [`INSTALL.md`](INSTALL.md#can-macos-do-it). The release workflow reads
   the Apple credentials from the `release` environment's secrets
   (`APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`,
   `APPLE_ID`/`APPLE_PASSWORD`/`APPLE_TEAM_ID` or
   `APPLE_API_ISSUER`/`APPLE_API_KEY`/`APPLE_API_KEY_PATH`); with no secrets it
   builds unsigned and the manifest says so.
8. **The content pack and the signed feed** (`npm run desktop:content-pack`
   and `npm run desktop:feed`). The pack is the content tree — the harness,
   the bridge, the window's own files — as one gzipped JSON file; the feed is
   the signed index that names it and the installers. The feed is signed
   with `AIPASS_RELEASE_KEY`, whose private half is a release secret and
   never in git; the public half is in `aipass-bridge/harness/update-keys.mjs`
   and lands in the app's next build. **A release without a signed feed is
   not a release the app can update from**, and the key must be in the
   keyring before the feed that names it is published — the app refuses a
   feed signed by a key it does not know, and that is the point.

## Canary & soak

A single-user desktop has no fleet to canary across, so the canary is staged
time: tag `vX.Y.Z-rc.1`, install that build on the release machine (the one
`doctor` ran on) and use it for a day before tagging `vX.Y.Z`. The rc gets no
installers attached; the final tag gets them. The previous release's
installers stay downloadable — that is the rollback target below.

## Release evidence

What to attach to the tag (or paste into the release issue) so a reviewer who
was not present can re-read every claim:

1. the CI run URL for the release commit, plus the tail of `npm run check`;
2. `npm run doctor -- --json` from the release machine;
3. the canary day's `npm run stats -- --json` (or the `--html` file);
4. eval artifacts when they were produced: the `metrics:` line and the
   `evals/results/*.jsonl` file(s); with `--keep`, the attempt sessions ride
   along and `session.kept` in each row names them;
5. the `CHANGELOG.md` `[Unreleased]` section that becomes the release notes.

**Independent assurance:** there is none, and it is not pretended — this is
a single-maintainer project (`LICENSE`). The evidence above plus the public
security process (`SECURITY.md`) are the compensating controls; an external
audit remains future work.

## Upgrade

Install the new build over the old one. `~/.aipass/` is not touched by an
install or uninstall: settings, sessions, the token and the logs stay exactly
where they are, and the new build reads them with the same merge rules the
old one did. After upgrading, run `npm run doctor` once — it is the one
command that proves the chain end to end.

There is no shell self-updater, deliberately (Tauri's updater is not wired):
the app never replaces its own binary in the background, so "which build is
running" is always a fact you chose.

The **content** does update in place, under the person's hand: the app checks
a signed feed, and when it names a newer content tree it offers it as a
banner with one button. The click is the consent, the pack is verified
against the hash in that signed feed before a file is written, the previous
content tree is kept so it can be put back, and both versions stay on screen.
The design is [`UPDATE_DESIGN.md`](UPDATE_DESIGN.md).

The **shell** can be handed over to the installer — the app closes, the
installer runs, the app comes back — but the gate is closed: the handover
refuses to run an **unsigned** installer, and the Windows installer is
unsigned. The gate is the feed's own `signature` field, and the feed is
signed, so only the release key can open it: when the Windows installer is
signed and the manifest says so, the same release that says `signed` opens
the path. Nothing else changes.

## Rollback

- **Installed app**: reinstall the previous installer over the current one.
  On Windows/NSIS and the macOS `.app`/dmg the install is a replacement, not
  a merge; if a bundle refuses to go backwards, uninstall first — `~/.aipass/`
  survives that, so nothing is lost.
- **From source**: `git checkout vPREV && npm install && npm run desktop`
  (`npm install` matters when `package.json` changed between the two tags).
- **Data compatibility is why this is safe**: unknown settings keys are
  preserved on save, unknown session entry types are preserved on load, torn
  or duplicated lines are skipped (`aipass-bridge/test/data-integrity.test.mjs`
  pins all four), and a header field from a newer build (the `app` stamp,
  for one) rides a rewrite untouched. A rolled-back build keeps working on
  data a newer build wrote. What it cannot do is understand *newer features* — a `credit-limited`
  stop reason, for example, reads as an unknown stop name in an old window.
- **The upgrade/rollback ladder is scripted.**
  `npm run desktop:install-ladder` installs the artifact, checks that the
  installed build is the one that shipped (its version) and that it actually
  runs (its backend answers), installs the new build over the old one and
  checks it again, installs the old build back and checks it again,
  uninstalls — and then checks that the user's data is still there. Give it
  both artifacts to walk the whole ladder:

  ```powershell
  npm run desktop:install-ladder -- --new <new installer> --old <the previous release's installer>
  ```

  It installs software on the machine it runs on, so it asks first (`--yes`
  answers for a release machine), and it never touches the real `~/.aipass`:
  the app runs with `AIPASS_HOME` pointing at a scratch directory. Doing it
  once per release by hand is still the human's job — the script makes that
  job repeatable, not automatic.

**When and who.** The canary day is the trigger window: `doctor` red on a
clean install of the tag, `stats --alerts` warning on the new build's first
day, a data regression on a real `~/.aipass` (the data-integrity suite), a
safety eval failing on the new build's model, or a supervisor restart loop in
the log — any one of these starts the rollback, debugging comes after. The
approver is the maintainer who tagged: one person, stated plainly, with the
decision recorded in the tag message or the revert commit.

## Release notes

`CHANGELOG.md` is the source; the tag message is its `[Unreleased]` section,
one paragraph. Release notes name behavior ("a run can now be capped by
credits: `maxCredits`"), never file paths — the changelog files are for
people deciding whether to upgrade, not for `git log` readers.

## Dependencies

The core has **zero runtime dependencies** by policy: Node built-ins, the
user's Chrome (extension), and the Rust/Tauri shell. Nothing in `dependencies`
means a compromised npm package cannot execute inside the harness.

- `.github/dependabot.yml` watches the three ecosystems that do exist —
  `github-actions` (workflow pins), `cargo` (`desktop/src-tauri`), and `npm`
  (dev-only, if anything ever lands there). A dependency PR is reviewed like
  code: read the diff, run `npm run check`.
- A full supply-chain audit (signed releases, SLSA, `cargo vet`) is future
  work and is not pretended here. The Windows installer is unsigned today;
  your OS will say so, and that warning is honest. The macOS artifact is
  the exception: Gatekeeper refuses an unnotarized bundle and Apple Silicon
  refuses to run an unsigned one, so it is signed and notarized before it is
  published — and the manifest records which of the two it is.
