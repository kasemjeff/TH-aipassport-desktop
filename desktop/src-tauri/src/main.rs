// Hide the console window in release builds — this only works as a crate-level
// (inner) attribute; on `fn main` it is silently ignored.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;
use std::process::Command;
use tauri::Manager;
use tauri::menu::{Menu, MenuItem};

const MARKER: &str = "aipass-bridge/bridge/server.mjs";

/// Where the app finds the files it runs.
///
/// Four layouts, tried in order:
///   1. the packaged resource dir            — an installed build
///   2. next to the binary                   — some installers relocate these
///   3. the repo, walking up                 — `tauri dev` from target/debug
///   4. the Tauri dir, two up                — `tauri dev` resource resolution
fn find_root(app: &tauri::App, exe_dir: &std::path::Path) -> PathBuf {
    let mut candidates: Vec<PathBuf> = Vec::new();

    if let Ok(res) = app.path().resolve(MARKER, tauri::path::BaseDirectory::Resource) {
        if let Some(root) = res.parent().and_then(|p| p.parent()) {
            candidates.push(root.to_path_buf());
        }
    }
    // The repo, from where this crate was compiled — what `tauri dev` needs.
    if let Some(tauri_dir) = PathBuf::from(env!("AIPASS_TAURI_DIR")).parent().and_then(|p| p.parent()) {
        candidates.push(tauri_dir.to_path_buf());
    }
    candidates.push(exe_dir.to_path_buf());
    let mut up = exe_dir.to_path_buf();
    for _ in 0..6 {
        if let Some(parent) = up.parent() {
            up = parent.to_path_buf();
            candidates.push(up.clone());
        }
    }

    for candidate in candidates {
        if candidate.join(MARKER).exists() {
            return candidate;
        }
    }
    exe_dir.to_path_buf()
}

/// Node runs everything: the packaged build ships it as a sidecar beside the
/// binary (Tauri's externalBin naming), a source checkout finds it on PATH.
/// The sidecar names are per-platform, because Tauri builds one target triple
/// per machine and names the external binary after it.
#[cfg(windows)]
const NODE_SIDECAR_NAMES: &[&str] = &["node-x86_64-pc-windows-msvc.exe", "node.exe"];
#[cfg(not(windows))]
const NODE_SIDECAR_NAMES: &[&str] = &[
    "node-aarch64-apple-darwin",
    "node-x86_64-apple-darwin",
    "node-aarch64-unknown-linux-gnu",
    "node-x86_64-unknown-linux-gnu",
    "node",
];

fn node_path(exe_dir: &std::path::Path) -> String {
    for name in NODE_SIDECAR_NAMES {
        let sidecar = exe_dir.join(name);
        if sidecar.exists() {
            return sidecar.to_string_lossy().to_string();
        }
    }
    "node".to_string()
}

/// `~/.aipass/settings.json` → { "root": "C:\\…" } — the same file the window
/// writes when a project is switched, so the packaged app opens where the last
/// session left off.
fn last_root() -> Option<PathBuf> {
    let dir = home_dir();
    for (name, key) in [("settings.json", "root"), ("desktop.json", "root")] {
        let path = dir.join(".aipass").join(name);
        if let Ok(text) = std::fs::read_to_string(&path) {
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) {
                if let Some(root) = json.get(key).and_then(|v| v.as_str()) {
                    let path = PathBuf::from(root);
                    if path.exists() {
                        return Some(path);
                    }
                }
            }
        }
    }
    None
}

/// The home directory, whichever machine this is: `$HOME` on unix,
/// `%USERPROFILE%` on Windows. Both are where `~/.aipass` lives.
fn home_dir() -> PathBuf {
    let var = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    std::env::var(var)
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."))
}

/// Take the backend down with the app.
///
/// The child runs in its own process group on unix (set when it is spawned),
/// so one signal reaches both the backend and the bridge it started; on
/// Windows `taskkill /T` does the same job by walking the tree.
#[cfg(windows)]
fn stop_backend(pid: u32) {
    let _ = Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .status();
}

#[cfg(not(windows))]
fn stop_backend(pid: u32) {
    let _ = Command::new("kill").args(["-TERM", &format!("-{pid}")]).status();
}

#[cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
fn main() -> Result<(), Box<dyn std::error::Error>> {
    tauri::Builder::default()
        // A second double-click must focus the window that is already there,
        // not open a twin: two windows pointing at one backend is a confusing
        // thing to explain to somebody who just wanted to open the app.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .setup(|app| {
            let exe = std::env::current_exe()?;
            let exe_dir = exe.parent().ok_or("no executable directory")?.to_path_buf();
            let root = find_root(app, &exe_dir);
            let entry = root.join("aipass-bridge").join("harness").join("rpc.mjs");
            let project_root = last_root().unwrap_or_else(home_dir);

            // The whole backend is this one child process: it starts the bridge
            // if it is not up, serves the window, and owns every agent run.
            // If something is already answering on that port - `aipass desktop`
            // in a browser, say - the window adopts it instead of fighting it.
            // The port itself honours AIPASS_DESKTOP_PORT, so a window started
            // beside a custom-port backend adopts it rather than spawning a
            // second one on a port nothing else is using.
            let backend_port = backend_port()?;
            let mut child = if std::net::TcpStream::connect(("127.0.0.1", backend_port)).is_ok() {
                None
            } else {
                let mut command = Command::new(node_path(&exe_dir));
                command
                    .arg(&entry)
                    .args(["--port", &backend_port.to_string()])
                    .args(["--root", project_root.to_str().unwrap_or(".")])
                    .current_dir(&project_root);
                #[cfg(unix)]
                {
                    use std::os::unix::process::CommandExt;
                    // Its own process group, so one signal on quit reaches the
                    // backend *and* the bridge it started — no orphans.
                    command.process_group(0);
                }
                Some(
                    command
                        .spawn()
                        .expect("could not start the aipass backend — is Node installed?"),
                )
            };

            // The window opens only once the backend answers, so a cold start
            // never lands on a blank page.
            let url = format!("http://127.0.0.1:{backend_port}/");
            let port_open = || std::net::TcpStream::connect(("127.0.0.1", backend_port)).is_ok();
            for _ in 0..80 {
                if port_open() {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(250));
            }
            std::thread::sleep(std::time::Duration::from_millis(150));

            let window = tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::External(url.parse().unwrap()),
            )
            .title("aipass desktop")
            .inner_size(1280.0, 860.0)
            .min_inner_size(900.0, 600.0)
            .build()?;

            // The backend is part of the app, not a service, so quitting
            // takes it down with it — but only if this window started it.
            let spawned_pid = child.as_mut().map(|kid| kid.id());
            let window_handle = window.clone();
            window.on_window_event(move |event| {
                match event {
                    // Closing the window hides it instead of killing the app:
                    // the backend and whatever run is in flight keep going in
                    // the tray, and "ออก" in the tray menu is what quits for
                    // real. A run should not die because someone tidied their
                    // taskbar by reflex.
                    tauri::WindowEvent::CloseRequested { api, .. } => {
                        api.prevent_close();
                        let _ = window_handle.hide();
                    }
                    tauri::WindowEvent::Destroyed => {
                        if let Some(pid) = spawned_pid {
                            stop_backend(pid);
                        }
                    }
                    _ => {}
                }
            });

            let show_item = MenuItem::with_id(app, "show", "แสดงหน้าต่าง", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "ออก", true, None::<&str>)?;
            let tray_menu = Menu::with_items(app, &[&show_item, &quit_item])?;

            let tray = tauri::tray::TrayIconBuilder::new()
                .icon(app.default_window_icon().cloned().unwrap())
                .tooltip("aipass desktop")
                .menu(&tray_menu)
                .on_menu_event(|app, event| {
                    match event.id().as_ref() {
                        "show" => {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                        // Exit runs the same path as the window closing:
                        // Destroyed still fires, so a backend this window
                        // started is still taken down here, not left orphaned.
                        "quit" => app.exit(0),
                        _ => {}
                    }
                })
                .build(app)?;
            tray.on_tray_icon_event(|tray, event| {
                if matches!(event, tauri::tray::TrayIconEvent::DoubleClick { .. }) {
                    if let Some(window) = tray.app_handle().get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
            });

            // A backend that died immediately is worth saying out loud rather
            // than showing a blank window forever.
            if let Some(ref mut kid) = child {
                if let Ok(Some(status)) = kid.try_wait() {
                    return Err(format!("the aipass backend exited at once ({status}) — run it by hand to see why").into());
                }
            }
            Ok(())
        })
        .build(tauri::generate_context!())?
        .run(|_handle, event| {
            if let tauri::RunEvent::ExitRequested { .. } = event {
                // The window event above already stopped the sidecar.
            }
        });
    Ok(())
}
