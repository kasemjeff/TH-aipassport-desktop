// Hide the console window in release builds — this only works as a crate-level
// (inner) attribute; on `fn main` it is silently ignored.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::Write;
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
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

/// The backend's log file, rotated past 5 MB the same way the JS side does
/// (harness/log-file.mjs keeps the same number).
///
/// A release build is a GUI app with no console: an inherited stdout/stderr
/// has nowhere to land, so a packaged crash used to leave nothing readable
/// behind. The supervisor redirects the child's output here instead.
fn backend_log_file() -> Option<std::fs::File> {
    let dir = home_dir().join(".aipass").join("logs");
    std::fs::create_dir_all(&dir).ok()?;
    let path = dir.join("desktop-backend.log");
    if let Ok(meta) = std::fs::metadata(&path) {
        if meta.len() > 5 * 1024 * 1024 {
            let _ = std::fs::remove_file(dir.join("desktop-backend.log.1"));
            let _ = std::fs::rename(&path, dir.join("desktop-backend.log.1"));
        }
    }
    std::fs::OpenOptions::new().create(true).append(true).open(&path).ok()
}

/// One supervisor line, in the same log the child writes to: who restarted
/// what, and when — the question a packaged crash otherwise leaves open.
fn note(msg: &str) {
    if let Some(mut file) = backend_log_file() {
        let _ = writeln!(file, "[supervisor] {msg}");
    }
}

/// The backend child, kept restartable.
///
/// The window outlives a backend crash — the page's EventSource redials and
/// restores from the session snapshot — so the shell that spawned the backend
/// should outlive it too. This holds the spawn recipe, watches the child, and
/// replaces it with backoff. `quitting` flips on Destroyed, so a deliberate
/// exit is not "a crash" the supervisor answers with a fresh child.
struct Backend {
    child: Mutex<Option<std::process::Child>>,
    quitting: AtomicBool,
    fails: Mutex<u32>,
    next_try: Mutex<Instant>,
    node: String,
    entry: PathBuf,
    port: u16,
    cwd: PathBuf,
}

impl Backend {
    fn spawn(&self) -> std::io::Result<std::process::Child> {
        let mut command = Command::new(&self.node);
        command
            .arg(&self.entry)
            .args(["--port", &self.port.to_string()])
            .args(["--root", self.cwd.to_str().unwrap_or(".")])
            .current_dir(&self.cwd);
        if let Some(log) = backend_log_file() {
            if let Ok(dup) = log.try_clone() {
                command.stdout(log).stderr(dup);
            }
        }
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            // Its own process group, so one signal on quit reaches the
            // backend *and* the bridge it started — no orphans.
            command.process_group(0);
        }
        command.spawn()
    }

    /// One watch tick: a dead child is replaced, a live one resets the backoff.
    fn tick(&self) {
        if self.quitting.load(Ordering::SeqCst) {
            return;
        }
        let mut guard = self.child.lock().unwrap();
        let exited = match guard.as_mut() {
            Some(kid) => matches!(kid.try_wait(), Ok(Some(_))),
            None => false,
        };
        if !exited {
            // A live child clears the episode: the next crash starts from the
            // first backoff step, not from wherever the last one left off.
            *self.fails.lock().unwrap() = 0;
            *self.next_try.lock().unwrap() = Instant::now();
            return;
        }
        let mut fails = self.fails.lock().unwrap();
        let mut next = self.next_try.lock().unwrap();
        if Instant::now() < *next {
            return;
        }
        *fails += 1;
        // 2s, doubling to half a minute: a backend that dies on start — a port
        // grabbed by hand, a broken config — retries politely, and a crash
        // loop cannot spin the CPU or flood the log.
        let delay = Duration::from_secs((2u64 << (*fails - 1).min(4)).min(30));
        *next = Instant::now() + delay;
        note(&format!("backend exited — restart attempt {fails}"));
        match self.spawn() {
            Ok(kid) => *guard = Some(kid),
            Err(err) => note(&format!("backend restart failed: {err}")),
        }
    }

    /// The app is quitting: no more restarts, and the child goes down with us.
    /// No window reload on restart, deliberately: the page redials on its own
    /// and a forced reload would throw away whatever the composer holds.
    fn shutdown(&self) {
        self.quitting.store(true, Ordering::SeqCst);
        if let Some(kid) = self.child.lock().unwrap().take() {
            stop_backend(kid.id());
        }
    }
}

/// The backend port, shared with the JS side: `AIPASS_DESKTOP_PORT` wins, the
/// loopback default is 8790. A value that is not a port is refused rather than
/// guessed — the window must look at the same port the backend is on.
fn backend_port() -> Result<u16, Box<dyn std::error::Error>> {
    match std::env::var("AIPASS_DESKTOP_PORT") {
        Ok(raw) if !raw.trim().is_empty() => raw
            .trim()
            .parse::<u16>()
            .map_err(|_| format!("AIPASS_DESKTOP_PORT is not a port: {raw}").into()),
        _ => Ok(8790),
    }
}

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
            let backend = Arc::new(Backend {
                child: Mutex::new(None),
                quitting: AtomicBool::new(false),
                fails: Mutex::new(0),
                next_try: Mutex::new(Instant::now()),
                node: node_path(&exe_dir),
                entry,
                port: backend_port,
                cwd: project_root.clone(),
            });
            // Adopt a backend that is already answering (a browser `aipass
            // desktop`, say); otherwise start one. An adopted backend is not
            // ours to respawn — the supervisor's child stays None.
            if std::net::TcpStream::connect(("127.0.0.1", backend_port)).is_err() {
                let kid = backend
                    .spawn()
                    .expect("could not start the aipass backend — is Node installed?");
                *backend.child.lock().unwrap() = Some(kid);
            }

            // Watch the child for as long as the app lives. The window's
            // EventSource redials after a crash and restores from the session
            // snapshot, so a restart reads as a pause, not as a lost run.
            {
                let watched = backend.clone();
                std::thread::spawn(move || loop {
                    std::thread::sleep(Duration::from_secs(2));
                    if watched.quitting.load(Ordering::SeqCst) {
                        break;
                    }
                    watched.tick();
                });
            }

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

            // The backend is part of the app, not a service, so quitting takes
            // it down with it — and stops the supervisor, so the exit reads as
            // deliberate rather than as a crash to answer.
            let window_handle = window.clone();
            let backend_handle = backend.clone();
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
                    tauri::WindowEvent::Destroyed => backend_handle.shutdown(),
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
            // than showing a blank window forever. Its output — stderr
            // included, now that spawn() redirects both — is in the log.
            {
                let mut guard = backend.child.lock().unwrap();
                if let Some(ref mut kid) = *guard {
                    if let Ok(Some(status)) = kid.try_wait() {
                        return Err(format!(
                            "the aipass backend exited at once ({status}) — see ~/.aipass/logs/desktop-backend.log"
                        )
                        .into());
                    }
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
