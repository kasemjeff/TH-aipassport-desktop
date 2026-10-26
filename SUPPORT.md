# Support

This is a volunteer open-source project. There is no paid support and no
response-time contract; the target is a first response within seven days when
possible.

## Start here

- **Install and setup** — [docs/INSTALL.md](./docs/INSTALL.md)
- **Something is broken** — run `npm run doctor` (or `aipass doctor`) and read
  [docs/TROUBLESHOOTING.md](./docs/TROUBLESHOOTING.md)
- **Configuration** — [docs/CONFIG.md](./docs/CONFIG.md)
- **The window and the harness** — [README.md](./README.md) and
  [docs/](./docs/README.md)
- **Common questions** — [docs/FAQ.md](./docs/FAQ.md)

## Ask a question

Use [GitHub Discussions](https://github.com/kasemjeff/TH-aipassport-desktop/discussions)
for setup questions, ideas and show-and-tell. Use the
[bug report](https://github.com/kasemjeff/TH-aipassport-desktop/issues/new?template=bug_report.md)
when something is actually broken; include the full `doctor` output.

## Report a security problem

Do **not** open a public issue. Use
[private vulnerability reporting](https://github.com/kasemjeff/TH-aipassport-desktop/security/advisories/new)
and follow [SECURITY.md](./SECURITY.md).

## Report a conduct problem

Follow [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md#enforcement).

## What is not supported

- Running the bridge on a public interface without the documented auth and
  CSRF settings. See the security limits in [SECURITY.md](./SECURITY.md).
- Using the app with an account or service it was not designed for.
- Recovery of data deleted from `~/.aipass` outside the app's own archive
  flow.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). A useful bug report is already a
contribution.
