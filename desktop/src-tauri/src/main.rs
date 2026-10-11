// Hide the console window in release builds — this only works as a crate-level
// (inner) attribute; on `fn main` it is silently ignored.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;
use std::process::Command;
use tauri::Manager;

const MARKER: &str = "aipass-bridge/bridge/server.mjs";

/// The port the Node backend answers on: AIPASS_DESKTOP_PORT when the
/// environment names one, 8790 otherwise — the same override `desktop/main.mjs`
/// honours, so a window started beside a custom-port backend adopts it instead
/// of spawning a second one on a port nothing else is using.
fn backend_port() -> Result<u16, String> {
    match std::env::var("AIPASS_DESKTOP_PORT") {
        Ok(v) if !v.trim().is_empty() => {
            v.trim().parse::<u16>().map_err(|_| format!("AIPASS_DESKTOP_PORT is not a port: {v:?}"))
        }
        _ => Ok(8790),
    }
}

/// Where the app finds the files it runs.
///
/// Four layouts, tried in order:
///   1. the packaged resource dir            — an installed build (on Windows
///                                             this is the exe's own dir)
///   2. the Tauri dir, two up                — the repo, as `tauri dev` needs
///   3. next to the binary                   — some installers relocate these
///   4. walking up from the binary           — a last resort
fn find_root(app: &tauri::App, exe_dir: &std::path::Path) -> PathBuf {
    let mut candidates: Vec<PathBuf> = Vec::new();

    if let Ok(res) = app.path().resolve(MARKER, tauri::path::BaseDirectory::Resource) {
        // res is <resource dir>/aipass-bridge/bridge/server.mjs, so the
        // resource dir itself is three parents up — the candidate whose
        // join(MARKER) is what the loop below checks. Two parents stopped one
        // short, inside aipass-bridge/, and never matched any layout.
        if let Some(root) = res.parent().and_then(|p| p.parent()).and_then(|p| p.parent()) {
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
fn node_path(exe_dir: &std::path::Path) -> String {
    for name in ["node-x86_64-pc-windows-msvc.exe", "node.exe"] {
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
    let home = std::env::var("USERPROFILE").ok()?;
    let dir = PathBuf::from(home);
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

fn home_dir() -> PathBuf {
    std::env::var("USERPROFILE")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."))
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    tauri::Builder::default()
        .setup(|app| {
            let backend_port = backend_port()?;
            let exe = std::env::current_exe()?;
            let exe_dir = exe.parent().ok_or("no executable directory")?.to_path_buf();
            let root = find_root(app, &exe_dir);
            let entry = root.join("aipass-bridge").join("harness").join("rpc.mjs");
            let project_root = last_root().unwrap_or_else(home_dir);

            // The whole backend is this one child process: it starts the bridge
            // if it is not up, serves the window, and owns every agent run.
            // If something is already answering on that port — `aipass desktop`
            // in a browser, say — the window adopts it instead of fighting it.
            let mut child = if std::net::TcpStream::connect(("127.0.0.1", backend_port)).is_ok() {
                None
            } else {
                Some(
                    Command::new(node_path(&exe_dir))
                        .arg(&entry)
                        .args(["--port", &backend_port.to_string()])
                        .args(["--root", project_root.to_str().unwrap_or(".")])
                        .current_dir(&project_root)
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
            // The UI draws its own title bar (drag region + window controls);
            // the OS chrome would duplicate it.
            .decorations(false)
            .inner_size(1280.0, 860.0)
            .min_inner_size(900.0, 600.0)
            .build()?;

            // The backend is part of the app, not a service, so closing the
            // window takes it down with it — but only if this window started it.
            let spawned_pid = child.as_mut().map(|kid| kid.id());
            if let Some(pid) = spawned_pid {
                window.on_window_event(move |event| {
                    if matches!(event, tauri::WindowEvent::Destroyed) {
                        let _ = Command::new("taskkill").args(["/PID", &pid.to_string(), "/T", "/F"]).status();
                    }
                });
            }

            let tray = tauri::tray::TrayIconBuilder::new()
                .icon(app.default_window_icon().cloned().unwrap())
                .tooltip("aipass desktop")
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
