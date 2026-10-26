# Third-party notices

This file records the third-party software that release artifacts bundle. It
is not a complete license text collection by itself: before publishing an
installer, run `npm run notices:rust` on a machine with Cargo and include the
generated list, then check the direct components below.

## Runtime components bundled in the app

| component | version | license | where it comes from |
|---|---|---|---|
| Node.js | 24.x (pinned by `desktop/sidecar/fetch-node.mjs`) | MIT | the Node.js project; the sidecar copies the build machine's Node |
| Tauri | 2.x | MIT OR Apache-2.0 | <https://tauri.app/> |
| tauri-plugin-single-instance | 2.x | MIT OR Apache-2.0 | Tauri plugins |
| serde | 1.x | MIT OR Apache-2.0 | <https://serde.rs/> |
| serde_json | 1.x | MIT OR Apache-2.0 | <https://serde.rs/> |
| Rust standard library and crates | see `desktop/src-tauri/Cargo.lock` | mostly MIT OR Apache-2.0; some MIT, BSD, ISC, Unicode and Zlib | crates.io |

There are **no runtime npm dependencies**. The root `package.json` has only
dev dependencies (`typescript`, `@types/node`), and they are not part of the
shipped app.

The Chrome extension and the bridge have no third-party runtime
dependencies. They use Chrome APIs and Node built-ins only.

## Generated Rust list

Run:

```bash
npm run notices:rust
```

This asks `cargo metadata` for every package in
`desktop/src-tauri/Cargo.toml` and writes the name, version, license and
repository of each into the block below. Run it before every release; the
release checklist in `docs/RELEASE.md` makes this a gate.

<!-- BEGIN GENERATED RUST -->
_Not generated in this checkout. Run `npm run notices:rust` on a machine with
Cargo before publishing an installer._
<!-- END GENERATED RUST -->

## What the installer must contain

The Tauri bundle lists `LICENSE`, `NOTICE`, `AUTHORS.md` and this file as
resources (`desktop/src-tauri/tauri.conf.json`). If you add a new runtime
component, add it to this file and to the resources list in the same change.

## License texts

The full text of the MIT license is in [LICENSE](./LICENSE). For the other
licenses, keep the license file that ships with the component; the generated
Rust list names the SPDX expression and the repository for each crate. A
release engineer must make the corresponding license texts available to the
person installing the app. Do not replace this file with a list that omits
them.
