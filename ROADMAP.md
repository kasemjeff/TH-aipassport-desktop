# Roadmap

This is a public, honest list. It is not a promise of dates. Items move when
they are actually done; the detailed capability status is in
[docs/MATURITY.md](./docs/MATURITY.md).

## Now — release readiness

- [ ] Green CI on `main` (the coverage floors currently fail; see
      [the audit](https://github.com/kasemjeff/TH-aipassport-desktop/issues)).
- [ ] Tag and publish `v0.2.0` with installers, `SHA256SUMS`, release notes and
      the signed update feed.
- [ ] Wire Apple signing/notarization secrets into the release workflow.
- [ ] Regenerate `THIRD_PARTY_NOTICES.md` before the first installer is
      published.
- [ ] Keep the six open Dependabot pull requests merged or closed.

## Next — contributor readiness

- [ ] Add real tests for the Chrome extension (the suite currently uses a
      stand-in; see `CONTRIBUTING.md`).
- [ ] Run the Rust shell tests on macOS in CI (today the matrix covers Ubuntu
      and Windows).
- [ ] Add a clean-machine installer smoke test for NSIS, DMG and deb/AppImage.
- [ ] Decide the Node floor: Node 20 is EOL, so either move to 22/24 or write
      down why 20 stays supported.
- [ ] Add a second maintainer with release access, or document a tested
      handover procedure.
- [ ] Pin GitHub Actions to commit SHAs and add an SBOM/provenance step.

## Later — product and community

- [ ] Publish a short demo video and two or three more screenshots.
- [ ] Thai translations for the contributing guide and the core docs (the
      README has a Thai edition now).
- [ ] A docs site generated from `docs/`, if the Markdown starts to outgrow
      GitHub's rendering.
- [ ] A stable `good first issue` backlog.
- [ ] A Chrome Web Store listing for the extension, so users do not have to
      load an unpacked build.

## Not planned

- Telemetry or analytics. The product is designed to have none; see
  [PRIVACY.md](./PRIVACY.md).
- A closed-source build or a paid tier.
- Replacing the user's browser session with a stored credential. The design
  deliberately uses the logged-in tab.

## How to influence it

Open a feature request with the template, or comment on an existing issue. See
[CONTRIBUTING.md](./CONTRIBUTING.md).
