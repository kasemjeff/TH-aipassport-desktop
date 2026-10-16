fn main() {
    // Where this crate lives, baked in at build time. The Rust side needs the
    // repo root to find the .mjs files it runs, and in `tauri dev` the binary
    // sits in the cargo target dir with no path back to the source tree — so
    // the build script hands it the one fact that stays true in both modes.
    let manifest = std::env::var("CARGO_MANIFEST_DIR").unwrap_or_default();
    println!("cargo:rustc-env=AIPASS_TAURI_DIR={manifest}");
    println!("cargo:rerun-if-changed=build.rs");
    tauri_build::build()
}
