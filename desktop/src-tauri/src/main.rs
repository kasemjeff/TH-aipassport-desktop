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

/// The exit code that means "restart me on purpose".
///
/// The backend promotes a new content tree and exits with this, because the
/// new tree needs a new process to run it. The supervisor reads it as a
/// deliberate restart and not as a crash to answer with backoff.
const RESTART_EXIT: i32 = 42;

/// The exit code that means "the port was taken".
///
/// A busy port is not a crash: it is a fact about the machine. The two facts
/// that can cause it need opposite answers — one of OUR backends answering
/// there means adopt it, something else holding it means restarting cannot
/// help — and the supervisor can only tell them apart if the backend says
/// which one it was.
const PORT_BUSY_EXIT: i32 = 43;

/// Who is answering on the backend's port.
#[derive(PartialEq, Eq, Debug)]
enum PortOwner {
    /// One of our backends, from this app or another one.
    Ours,
    /// Something that is not our backend holds the port.
    Stranger,
    /// Nothing is listening.
    Empty,
    /// The probe could not say — the content tree it needs is missing, say.
    Unknown,
}

/// What the supervisor does with a backend that could not bind its port.
#[derive(PartialEq, Eq, Debug)]
enum BusyOutcome {
    /// One of our backends is answering there: adopt it, and stop restarting.
    Adopt,
    /// Something else holds the port: name it once, and keep the backoff.
    Name,
    /// Nothing to say — the ordinary backoff is the answer.
    Backoff,
}

/// The decision, apart from the talking: what a busy port means.
///
/// Split out from the supervisor so the rule can be tested without a window,
/// a backend and a machine. The two answers are opposites: one of our
/// backends is already there (adopt it — the window is pointed at that port
/// and is already talking to the right one), or something else is holding it
/// (restarting cannot help, so say so and back off).
fn busy_outcome(owner: PortOwner) -> BusyOutcome {
    match owner {
        PortOwner::Ours => BusyOutcome::Adopt,
        PortOwner::Stranger => BusyOutcome::Name,
        PortOwner::Empty | PortOwner::Unknown => BusyOutcome::Backoff,
    }
}

/// Does this exit count towards "the content tree is broken"?
///
/// A busy port is not the tree's fault. The rollback exists for a promoted
/// tree that breaks the backend, and rolling back because the port was taken
/// threw away good content for nothing — the app put the previous tree back
/// while the port stayed busy, and the backend kept failing.
fn counts_against_the_content(code: Option<i32>) -> bool {
    code != Some(PORT_BUSY_EXIT)
}

/// The command the backend leaves for the shell.
///
/// The backend cannot replace the app's own binary — it is the child of it,
/// and the app is what has to be closed for the installer to do its work. So
/// the backend writes a command and the shell, which outlives it, reads it.
struct InstallCommand {
    version: String,
    /// A NAME, not a path. The shell builds the path itself, from its own
    /// downloads directory, so a command file cannot make the app run
    /// anything anywhere else.
    file: String,
    sha256: String,
}

/// The artifact's SHA-256, computed by the app's own Node.
///
/// The shell has no SHA-256 of its own and the repository carries no
/// dependencies — but the app SHIPS a Node, and `node:crypto` is a builtin.
/// So the hash is computed by the same runtime that runs the harness, and
/// the script is written beside the app's own state and taken away again.
fn hash_with_node(node: &str, artifact: &std::path::Path, home: &std::path::Path) -> Option<String> {
    let script = home.join("app").join("verify-sha256.mjs");
    let code = "import crypto from 'node:crypto';\nimport fs from 'node:fs';\nconst h = crypto.createHash('sha256');\nh.update(fs.readFileSync(process.argv[2]));\nprocess.stdout.write(h.digest('hex'));\n";
    std::fs::create_dir_all(home.join("app")).ok()?;
    std::fs::write(&script, code).ok()?;
    let out = Command::new(node).arg(&script).arg(artifact).output().ok();
    let _ = std::fs::remove_file(&script);
    let out = out?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if text.len() == 64 {
        Some(text)
    } else {
        None
    }
}

/// Read the handover command, if the backend left one.
///
/// A name that carries a path separator or a `..` is refused: the command
/// names a file, it does not choose one.
fn read_install_command(home: &std::path::Path) -> Option<InstallCommand> {
    let file = home.join("app").join("commands").join("install.json");
    let text = std::fs::read_to_string(&file).ok()?;
    let json: serde_json::Value = serde_json::from_str(&text).ok()?;
    let version = json.get("version")?.as_str()?.to_string();
    let name = json.get("file")?.as_str()?.to_string();
    if name.is_empty()
        || name.contains('/')
        || name.contains('\\')
        || name.contains("..")
        || name.contains(':')
    {
        return None;
    }
    let sha256 = json.get("sha256")?.as_str()?.to_string();
    Some(InstallCommand {
        version,
        file: name,
        sha256,
    })
}

/// Where the command lives, and where the artifact it names does.
fn command_paths(home: &std::path::Path) -> (std::path::PathBuf, std::path::PathBuf) {
    (
        home.join("app").join("commands").join("install.json"),
        home.join("app").join("downloads"),
    )
}

/// The plain form of a path.
///
/// Windows hands back the long-path form (`\\?\C:\…`) for anything the
/// resource resolver produces, and Node cannot run one: it reads the prefix
/// as a directory and the backend dies with `lstat 'C:'`. The prefix is
/// Windows' way of saying "this path may be longer than 260 characters", and
/// the plain form says the same thing to everything else.
fn plain(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy().to_string();
    match text.strip_prefix(r"\\?\") {
        // A UNC path keeps its two leading slashes: `\\?\UNC\server\share`
        // is `\\server\share`.
        Some(rest) if rest.starts_with(r"UNC\") => PathBuf::from(format!(r"\\{}", &rest[4..])),
        Some(rest) => PathBuf::from(rest),
        None => path,
    }
}

/// Where the app finds the files it runs.
///
/// The candidates, in the order they are tried:
///
///   1. the CONTENT OVERLAY — a promoted content tree under
///      `~/.aipass/app/`, put there by the update system from a pack whose
///      hash is in a signed feed. It is not a checkout: it is the newest
///      thing a person deliberately chose, and the only candidate here that
///      was checked against a signature.
///   2. the packaged resource dir — an installed build.
///   3. the binary's own directory — some installers relocate these.
///   4. the repository, walking up — `tauri dev` from target/debug.
///
/// The installed build comes before the repository for the reason the old
/// comment gave: an app that runs the *repository's* files when a checkout
/// happens to sit on the same machine is not the build that was installed,
/// and the difference shows up as a bug that only the person who made the
/// build can see.
///
/// The Node side implements the same rule (`harness/app-root.mjs`), because
/// the two cannot import each other. A test says they agree.
fn root_candidates(app: &tauri::App, exe_dir: &std::path::Path) -> Vec<(PathBuf, &'static str)> {
    let mut candidates: Vec<(PathBuf, &'static str)> = Vec::new();

    // The overlay comes first: it is a verified release of the content.
    if let Some(root) = overlay_root_in(&aipass_home()) {
        candidates.push((root, "overlay"));
    }
    // The resource dir is the install dir on Windows and `Contents/Resources`
    // on macOS; the marker sits three levels under it (aipass-bridge/bridge/
    // server.mjs), so the root is three parents up.
    if let Ok(res) = app.path().resolve(MARKER, tauri::path::BaseDirectory::Resource) {
        if let Some(root) = plain(res)
            .parent()
            .and_then(|p| p.parent())
            .and_then(|p| p.parent())
        {
            candidates.push((root.to_path_buf(), "bundle"));
        }
    }
    // Next to the binary: where the bundler puts a sidecar and, on some
    // layouts, the resources too.
    candidates.push((exe_dir.to_path_buf(), "bundle"));
    // The repo, from where this crate was compiled — what `tauri dev` needs.
    if let Some(tauri_dir) = PathBuf::from(env!("AIPASS_TAURI_DIR")).parent().and_then(|p| p.parent()) {
        candidates.push((tauri_dir.to_path_buf(), "repo"));
    }
    let mut up = exe_dir.to_path_buf();
    for _ in 0..6 {
        if let Some(parent) = up.parent() {
            up = parent.to_path_buf();
            candidates.push((up.clone(), "repo"));
        }
    }
    candidates
}

/// The first candidate that is really an app root.
///
/// The root is resolved on every spawn, not once at startup: a content
/// update promotes a new tree, and the backend that runs it has to be
/// started from there.
fn pick_root(candidates: &[(PathBuf, &'static str)]) -> (PathBuf, &'static str) {
    for (root, source) in candidates {
        if root.join(MARKER).exists() {
            return (root.clone(), *source);
        }
    }
    (
        candidates.first().map(|c| c.0.clone()).unwrap_or_default(),
        "none",
    )
}

/// The content overlay: the promoted content tree, if one is active.
///
/// `~/.aipass/app/active.json` names it. A pointer that names a directory
/// without the marker in it is ignored — a half-written pointer must not
/// send the app looking for files that are not there.
///
/// The lookup is split so a test can name a home without touching the real
/// one.
fn overlay_root_in(home: &std::path::Path) -> Option<PathBuf> {
    let active = home.join("app").join("active.json");
    let text = std::fs::read_to_string(&active).ok()?;
    let json: serde_json::Value = serde_json::from_str(&text).ok()?;
    let root = json.get("current")?.get("root")?.as_str()?;
    let root = PathBuf::from(root);
    if root.join(MARKER).exists() {
        Some(root)
    } else {
        None
    }
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

fn node_path(exe_dir: &std::path::Path, resource_dir: Option<&std::path::Path>) -> String {
    find_node(exe_dir, resource_dir)
        .map(|path| path.to_string_lossy().to_string())
        .unwrap_or_else(|| "node".to_string())
}

/// The app's own Node, if the bundle carries it.
///
/// Two places to look: next to the binary (where the bundler puts a sidecar
/// on Windows and macOS) and in the resource directory (where some layouts
/// put it). A source checkout has neither and finds Node on PATH.
fn find_node(exe_dir: &std::path::Path, resource_dir: Option<&std::path::Path>) -> Option<PathBuf> {
    for dir in [Some(exe_dir), resource_dir].into_iter().flatten() {
        for name in NODE_SIDECAR_NAMES {
            let sidecar = dir.join(name);
            if sidecar.exists() {
                return Some(sidecar);
            }
        }
    }
    None
}

/// The `.aipass` directory: the override, or `<home>/.aipass`.
///
/// The Node side reads `AIPASS_HOME` as the `.aipass` directory itself
/// (`harness/settings.mjs`), so the shell reads it the same way — one
/// override, one meaning, on every platform. A run that points it at a
/// scratch directory (the install ladder does) then keeps the real home
/// untouched, log included.
fn aipass_home() -> PathBuf {
    match std::env::var("AIPASS_HOME") {
        Ok(dir) if !dir.trim().is_empty() => PathBuf::from(dir),
        _ => home_dir().join(".aipass"),
    }
}

/// `~/.aipass/settings.json` → { "root": "C:\\…" } — the same file the window
/// writes when a project is switched, so the packaged app opens where the last
/// session left off. `desktop.json` is the pre-unification leftover: when it
/// is the only file that names a root, its value is migrated into
/// settings.json once, so the two files can never disagree again.
fn last_root() -> Option<PathBuf> {
    match std::env::var("AIPASS_HOME") {
        Ok(dir) if !dir.trim().is_empty() => last_root_in_aipass(&PathBuf::from(dir)),
        _ => last_root_in(&home_dir()),
    }
}

/// The same lookup, against a named home — so the migration can be tested
/// without touching the real one.
fn last_root_in(dir: &std::path::Path) -> Option<PathBuf> {
    last_root_in_aipass(&dir.join(".aipass"))
}

/// The same lookup, against the `.aipass` directory itself — the shape the
/// `AIPASS_HOME` override names.
fn last_root_in_aipass(dir: &std::path::Path) -> Option<PathBuf> {
    let settings_path = dir.join("settings.json");
    if let Ok(text) = std::fs::read_to_string(&settings_path) {
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) {
            if let Some(root) = json.get("root").and_then(|v| v.as_str()) {
                let path = PathBuf::from(root);
                if path.exists() {
                    return Some(path);
                }
            }
        }
    }
    // One-way migration from the legacy file. A root that no longer exists
    // migrates nowhere — settings.json keeps no dead path.
    let legacy = dir.join("desktop.json");
    if let Ok(text) = std::fs::read_to_string(&legacy) {
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) {
            if let Some(root) = json.get("root").and_then(|v| v.as_str()) {
                let path = PathBuf::from(root);
                if path.exists() {
                    // The settings file is MERGED, never replaced. It holds the
                    // mode, the model, the compaction budget, the path rules and
                    // the project list; a migration that wrote {"root":…} over
                    // it took all of that with it. Only the root changes here.
                    let mut merged = std::fs::read_to_string(&settings_path)
                        .ok()
                        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
                        .filter(|v| v.is_object())
                        .unwrap_or_else(|| serde_json::json!({}));
                    merged["root"] = serde_json::Value::String(root.to_string());
                    let written =
                        std::fs::write(&settings_path, serde_json::to_string_pretty(&merged).unwrap_or_default());
                    // The legacy file goes only after the write landed: a
                    // failed write must not take the only copy of the root
                    // with it.
                    if written.is_ok() {
                        let _ = std::fs::remove_file(&legacy);
                    }
                    return Some(path);
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

/// Write a file by the atomic route: a temp name beside it, then a rename.
///
/// The rename replaces the destination on both platforms, so a crash leaves
/// either the old bytes or the new ones — never half of each. The Node side
/// has the same rule in `harness/atomic-write.mjs`.
fn write_atomic(file: &std::path::Path, text: &str) -> std::io::Result<()> {
    let tmp = file.with_extension("json.tmp");
    std::fs::write(&tmp, text)?;
    std::fs::rename(&tmp, file)
}

/// Put the previous content tree back, when a promotion is what broke the app.
///
/// The shape that calls for it: the backend died three times in a row, and
/// the content was promoted recently. The previous tree is still on disk, so
/// the app heals itself instead of sitting there unable to start — which is
/// the difference between a bad release costing one restart and costing the
/// person their app.
///
/// A tree promoted long ago is not what broke just now, so the promotion has
/// to be recent for this to fire.
fn roll_content_back() -> bool {
    roll_content_back_in(&aipass_home())
}

/// The same, against a named home — so a test can drive it.
fn roll_content_back_in(home: &std::path::Path) -> bool {
    let active = home.join("app").join("active.json");
    let Ok(text) = std::fs::read_to_string(&active) else {
        return false;
    };
    let Ok(mut json) = serde_json::from_str::<serde_json::Value>(&text) else {
        return false;
    };
    let Some(previous) = json.get("previous").cloned() else {
        return false;
    };
    if previous.is_null() {
        return false;
    }
    let Some(root) = previous.get("root").and_then(|v| v.as_str()) else {
        return false;
    };
    let root = PathBuf::from(root);
    if !root.join(MARKER).exists() {
        return false;
    }
    let updated = json.get("updatedAt").and_then(|v| v.as_u64()).unwrap_or(0);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    if now.saturating_sub(updated) > 10 * 60 * 1000 {
        return false;
    }
    let broken = json.get("current").cloned();
    json["current"] = previous;
    json["previous"] = broken.unwrap_or(serde_json::Value::Null);
    json["updatedAt"] = serde_json::Value::from(now);
    let Ok(written) = serde_json::to_string_pretty(&json) else {
        return false;
    };
    if write_atomic(&active, &written).is_err() {
        return false;
    }
    note("the content tree broke the backend three times in a row — the previous one is back");
    true
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
    let dir = aipass_home().join("logs");
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
    /// The failures that are not the port's fault. The content rollback is
    /// about a broken tree, and a busy port is not a broken tree: rolling
    /// back because the port was taken threw away good content for nothing.
    content_fails: Mutex<u32>,
    next_try: Mutex<Instant>,
    /// Set once the port has been found to be held by something that is not
    /// our backend, so the situation is named once instead of on every retry.
    port_busy: AtomicBool,
    node: String,
    /// Where the app's files may be, in the order they are tried. The root
    /// is picked on every spawn, so a promoted content tree is picked up
    /// without reinstalling anything.
    candidates: Vec<(PathBuf, &'static str)>,
    port: u16,
    cwd: PathBuf,
    /// The app itself, for the handover: the shell is what has to close for
    /// the installer to do its work.
    handle: tauri::AppHandle,
}

impl Backend {
    fn spawn(&self) -> std::io::Result<std::process::Child> {
        // The root is resolved HERE, not once at startup: a content update
        // promotes a new tree, and the backend that runs it has to be
        // started from there.
        let (root, source) = pick_root(&self.candidates);
        let entry = root.join("aipass-bridge").join("harness").join("rpc.mjs");
        let mut command = Command::new(&self.node);
        command
            .arg(&entry)
            .args(["--port", &self.port.to_string()])
            .args(["--root", self.cwd.to_str().unwrap_or(".")])
            .current_dir(&self.cwd)
            // The two halves of a build, named for the backend so the window
            // can answer "which build is this?" without asking the machine.
            .env("AIPASS_SHELL_VERSION", env!("CARGO_PKG_VERSION"))
            .env("AIPASS_CONTENT_SOURCE", source)
            .env("AIPASS_NODE_PATH", &self.node);
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

    /// Who is answering on our port.
    ///
    /// A bare TCP connect is not the question: something that is NOT our
    /// backend can hold the port, and adopting it would point the window at a
    /// stranger's server. The launcher asks the real question — is this our
    /// backend? — through `harness/backend-probe.mjs`, and the shell asks the
    /// SAME module, through the app's own Node: one implementation of the
    /// question, so the window and the launcher cannot drift apart.
    ///
    /// The probe is asked, not guessed. A content tree that is broken enough
    /// to take the probe with it answers `Unknown`, and the caller decides
    /// what to do about not knowing — it does not decide it means "not ours".
    fn port_owner(&self) -> PortOwner {
        let (root, _) = pick_root(&self.candidates);
        let probe = root
            .join("aipass-bridge")
            .join("harness")
            .join("backend-probe.mjs");
        match Command::new(&self.node)
            .arg(&probe)
            .arg(self.port.to_string())
            .output()
        {
            Ok(out) if out.status.success() => {
                let text = String::from_utf8_lossy(&out.stdout);
                if text.trim() == "ours" {
                    return PortOwner::Ours;
                }
            }
            Ok(_) => {
                // The probe ran and could not answer — a non-zero exit is "I
                // could not say", not "nothing is there". The probe's own
                // contract says so, and the enum has a word for it: the
                // content tree it needs is missing, so the caller is told it
                // does not know rather than handed a guess.
                return PortOwner::Unknown;
            }
            Err(_) => return PortOwner::Unknown,
        }
        // It answered "other": something is there, and it is not ours.
        if std::net::TcpStream::connect(("127.0.0.1", self.port)).is_ok() {
            PortOwner::Stranger
        } else {
            PortOwner::Empty
        }
    }

    /// One watch tick: a dead child is replaced, a live one resets the backoff.
    fn tick(&self) {
        if self.quitting.load(Ordering::SeqCst) {
            return;
        }
        // A command from the backend: the shell is the one that has to close
        // for the installer to do its work, so the handover starts here.
        if let Some(command) = read_install_command(&aipass_home()) {
            self.handover(command);
            return;
        }
        let mut guard = self.child.lock().unwrap();
        // try_wait consumes the exit status, so read it here: the note names
        // the code (or the signal) instead of just "exited", which is what
        // turns "restart attempt 1 × 40" from a mystery into a diagnosis.
        let mut status: Option<std::process::ExitStatus> = None;
        let exited = match guard.as_mut() {
            Some(kid) => match kid.try_wait() {
                Ok(s) => {
                    status = s;
                    s.is_some()
                }
                _ => false,
            },
            None => false,
        };
        if !exited {
            // A live child clears the episode: the next crash starts from the
            // first backoff step, not from wherever the last one left off.
            *self.fails.lock().unwrap() = 0;
            *self.content_fails.lock().unwrap() = 0;
            *self.next_try.lock().unwrap() = Instant::now();
            self.port_busy.store(false, Ordering::SeqCst);
            return;
        }
        // A backend that asked to be restarted is not a crash: it promoted a
        // new content tree and needs a new process to run it. The backoff
        // does not apply, and the note says why — a log line that reads
        // "restart attempt 1 of a crash" is a lie about what happened.
        if status.map(|s| s.code() == Some(RESTART_EXIT)).unwrap_or(false) {
            *self.fails.lock().unwrap() = 0;
            *self.next_try.lock().unwrap() = Instant::now();
            note("backend asked for a restart (a new content version) — starting it again");
            match self.spawn() {
                Ok(kid) => *guard = Some(kid),
                Err(err) => note(&format!("backend restart failed: {err}")),
            }
            return;
        }
        // A busy port is not a crash either, and the two facts it can mean
        // need opposite answers.
        if status.map(|s| s.code() == Some(PORT_BUSY_EXIT)).unwrap_or(false) {
            match busy_outcome(self.port_owner()) {
                BusyOutcome::Adopt => {
                    // One of our backends is already answering there — a second
                    // window, a browser `aipass desktop`, an instance this app
                    // started and lost track of. The window is pointed at that
                    // port, so it is already talking to the right backend:
                    // adopt it, and stop starting another one that could only
                    // die on the same port.
                    *self.fails.lock().unwrap() = 0;
                    *self.content_fails.lock().unwrap() = 0;
                    *self.next_try.lock().unwrap() = Instant::now();
                    *guard = None;
                    self.port_busy.store(false, Ordering::SeqCst);
                    note("another aipass backend is answering on the port — it is adopted, and no second one is started");
                    return;
                }
                BusyOutcome::Name => {
                    // Something that is not ours holds the port. Restarting
                    // cannot fix that, and a loop that cannot win is what made
                    // the app look broken: name it once, with the fix, and
                    // keep the polite backoff so the port is picked up again
                    // if it is freed.
                    if !self.port_busy.swap(true, Ordering::SeqCst) {
                        note(&format!(
                            "port {} is held by something that is not an aipass backend — close it, or start the app with AIPASS_DESKTOP_PORT=<other>",
                            self.port
                        ));
                    }
                }
                BusyOutcome::Backoff => {
                    // Nothing is there, or the probe could not say. Either
                    // way the ordinary backoff below is the right answer.
                    self.port_busy.store(false, Ordering::SeqCst);
                }
            }
        }
        let mut fails = self.fails.lock().unwrap();
        let mut next = self.next_try.lock().unwrap();
        if Instant::now() < *next {
            return;
        }
        *fails += 1;
        // A busy port is not the content's fault, so it does not count towards
        // the rollback below: a tree that is fine was thrown away once because
        // the port was taken.
        if counts_against_the_content(status.and_then(|s| s.code())) {
            *self.content_fails.lock().unwrap() += 1;
        }
        // Three deaths in a row, right after a content promotion, is the
        // shape of a broken content tree. The previous one is still on disk,
        // so the app puts it back instead of sitting there unable to start.
        if *self.content_fails.lock().unwrap() == 3 && roll_content_back() {
            *fails = 0;
            *self.content_fails.lock().unwrap() = 0;
            *next = Instant::now();
            return;
        }
        // 2s, doubling to half a minute: a backend that dies on start — a port
        // grabbed by hand, a broken config — retries politely, and a crash
        // loop cannot spin the CPU or flood the log.
        let delay = Duration::from_secs((2u64 << (*fails - 1).min(4)).min(30));
        *next = Instant::now() + delay;
        // A crash loop that always lands on the same code is one bug, not N:
        // after five straight failures the note says so instead of adding
        // another identical line.
        if *fails >= 5 {
            note(&format!(
                "backend exited ({}) — {} straight failures, same note suppressed until it recovers or the code changes",
                status.map(|s| format!("{s}")).unwrap_or_else(|| "unknown".into()),
                *fails,
            ));
        } else {
            note(&format!(
                "backend exited ({}) — restart attempt {fails}",
                status.map(|s| format!("{s}")).unwrap_or_else(|| "unknown".into()),
            ));
        }
        match self.spawn() {
            Ok(kid) => *guard = Some(kid),
            Err(err) => note(&format!("backend restart failed: {err}")),
        }
    }

    /// Hand the app over to the installer.
    ///
    /// The installer replaces the binary, and a running binary is locked on
    /// Windows — so the app closes, the installer runs, and the app comes
    /// back. The helper is this same executable with an argument, so
    /// nothing has to be quoted into a shell and nothing depends on a shell
    /// being there at all.
    ///
    /// The backend verified the artifact against the signed feed before it
    /// wrote the command. The shell checks it AGAIN, with the app's own Node:
    /// the file on disk is the thing that runs, and the hash is the only
    /// thing that says it is the file the release key signed.
    fn handover(&self, command: InstallCommand) {
        let home = aipass_home();
        let (command_file, downloads) = command_paths(&home);
        let artifact = downloads.join(&command.file);
        if !artifact.is_file() {
            note(&format!(
                "the installer for {} is not where it should be — nothing was started",
                command.version
            ));
            let _ = std::fs::remove_file(&command_file);
            return;
        }
        match hash_with_node(&self.node, &artifact, &home) {
            Some(digest) if digest.eq_ignore_ascii_case(&command.sha256) => {}
            Some(digest) => {
                note(&format!(
                    "the installer for {} does not match the hash it was handed ({} != {}) — nothing was started",
                    command.version, digest, command.sha256
                ));
                let _ = std::fs::remove_file(&command_file);
                return;
            }
            None => {
                note(&format!(
                    "the installer for {} could not be hashed — nothing was started",
                    command.version
                ));
                let _ = std::fs::remove_file(&command_file);
                return;
            }
        }
        let Ok(exe) = std::env::current_exe() else {
            note("the app does not know where its own executable is — nothing was started");
            return;
        };
        let mut helper = Command::new(&exe);
        helper
            .arg("--install-and-relaunch")
            .arg(&artifact)
            .arg(&exe);
        // Detached: the helper has to outlive this process, which is about to
        // exit.
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            // DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
            helper.creation_flags(0x0000_0008 | 0x0000_0200);
        }
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            helper.process_group(0);
        }
        match helper.spawn() {
            Ok(_) => {
                note(&format!(
                    "handing over to the installer for {} — the app will come back",
                    command.version
                ));
                let _ = std::fs::remove_file(&command_file);
                self.handle.exit(0);
            }
            Err(err) => note(&format!("the handover did not start: {err}")),
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
        Ok(raw) if !raw.trim().is_empty() => {
            let port: u16 = raw
                .trim()
                .parse()
                .map_err(|_| format!("AIPASS_DESKTOP_PORT is not a port: {raw}"))?;
            // Port 0 is a port NUMBER, not a port: the child reads it as "any
            // free port" and binds one the OS picked, while the window has to
            // open a URL for it and the readiness probe has to connect to it.
            // Neither can name a port nobody was told. Refuse it here, and the
            // Node side refuses it too (desktop/main.mjs) so the two agree.
            if port == 0 {
                return Err(format!("AIPASS_DESKTOP_PORT is not a port: {raw}").into());
            }
            Ok(port)
        }
        _ => Ok(8790),
    }
}

/// The handover helper: install, then bring the app back.
///
/// It runs BEFORE the app is built: it is not an app, it is the app's own
/// executable with an argument, and it is what lets the installer run while
/// the app is closed. Nothing is quoted into a shell, so nothing depends on
/// a shell being there — the Windows-clean rule holds.
///
/// It answers with the exit code of the installer, and it always brings the
/// app back: a person who asked for an update and got a closed window and no
/// app is worse off than before.
fn handover_helper() -> Option<Result<(), Box<dyn std::error::Error>>> {
    let args: Vec<String> = std::env::args().collect();
    let at = args.iter().position(|a| a == "--install-and-relaunch")?;
    let installer = args.get(at + 1)?.clone();
    let app = args.get(at + 2)?.clone();
    note(&format!("the handover helper is running {installer}"));
    // The installer is silent on Windows and does its work; the exit code
    // says whether it did.
    let status = Command::new(&installer).arg("/S").status();
    match status {
        Ok(s) if s.success() => note("the installer finished"),
        Ok(s) => note(&format!("the installer exited {s}")),
        Err(err) => note(&format!("the installer could not be run: {err}")),
    }
    // And the app comes back.
    match Command::new(&app).spawn() {
        Ok(_) => note("the app is back"),
        Err(err) => note(&format!("the app could not be started again: {err}")),
    }
    Some(Ok(()))
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    // The handover helper runs first: it is the app's own executable with an
    // argument, and it is not an app.
    if let Some(result) = handover_helper() {
        return result;
    }
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
            let resource_dir = app.path().resource_dir().ok();
            let candidates = root_candidates(app, &exe_dir);
            let (root, source) = pick_root(&candidates);
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
            // What the backend is actually run with — the one line that says
            // which files the installed build is running, when somebody asks
            // why the app and the checkout disagree.
            note(&format!(
                "backend: node={} entry={} root={} source={}",
                node_path(&exe_dir, resource_dir.as_deref()),
                entry.display(),
                project_root.display(),
                source
            ));
            let backend = Arc::new(Backend {
                child: Mutex::new(None),
                quitting: AtomicBool::new(false),
                fails: Mutex::new(0),
                content_fails: Mutex::new(0),
                next_try: Mutex::new(Instant::now()),
                port_busy: AtomicBool::new(false),
                node: node_path(&exe_dir, resource_dir.as_deref()),
                candidates,
                port: backend_port,
                cwd: project_root.clone(),
                handle: app.handle().clone(),
            });
            // Adopt a backend that is already answering (a browser `aipass
            // desktop`, say); otherwise start one. An adopted backend is not
            // ours to respawn — the supervisor's child stays None.
            //
            // "Answering" means OUR backend, not just something on the port:
            // a bare TCP connect would adopt a stranger's server and point
            // the window at it, and the window would then talk to a program
            // that has never heard of aipass. The probe asks the question the
            // launcher asks, through the app's own Node.
            if backend.port_owner() != PortOwner::Ours {
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
            .theme(desktop_theme())
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
            let cli_item = MenuItem::with_id(app, "install-cli", "ติดตั้ง CLI (aipass)", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "ออก", true, None::<&str>)?;
            let tray_menu = Menu::with_items(app, &[&show_item, &cli_item, &quit_item])?;

            let tray = tauri::tray::TrayIconBuilder::new()
                .icon(tray_icon(app.handle()))
                // The menu bar draws a template image as a mask, so macOS
                // needs the silhouette; the flag is a no-op elsewhere.
                .icon_as_template(cfg!(target_os = "macos"))
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
                        // The CLI is the same program in a terminal, and the
                        // bundle already carries it. Writing the shim is a
                        // change to the machine, so the menu item is the
                        // consent: nothing is written until somebody asks.
                        "install-cli" => {
                            let message = match install_cli_shim(app) {
                                Ok(path) => {
                                    // The shim is only a command when its
                                    // directory is on PATH; the item is the
                                    // consent to put it there.
                                    let on_path = path
                                        .parent()
                                        .map(|dir| add_to_user_path(dir))
                                        .unwrap_or_else(|| Err("no directory".to_string()));
                                    match on_path {
                                        Ok(()) => format!(
                                            "ติดตั้งแล้ว — {} (อยู่ใน PATH แล้ว — เปิดเทอร์มินใหม่เพื่อใช้)",
                                            path.display()
                                        ),
                                        Err(err) => format!(
                                            "ติดตั้งแล้ว — {} (เพิ่มใน PATH ไม่สำเร็จ: {err})",
                                            path.display()
                                        ),
                                    }
                                }
                                Err(err) => format!("ติดตั้งไม่สำเร็จ: {err}"),
                            };
                            note(&message);
                            // The window may be in the tray, so the tray says
                            // it too — and the log keeps it for later.
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.set_title(&format!("aipass desktop — {message}"));
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

/// The titlebar is the one surface the app cannot paint itself, so Windows
/// draws a light frame over the warm window unless the theme is set before the
/// window opens. The settings file is the only thing that knows this early —
/// the backend that serves settings is not up yet — so read it directly;
/// "auto" hands the frame back to the system, which is what auto means.
fn desktop_theme() -> Option<tauri::Theme> {
    let path = aipass_home().join("settings.json");
    let choice = std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .and_then(|json| json.get("theme")?.as_str().map(str::to_owned));
    match choice.as_deref() {
        Some("light") => Some(tauri::Theme::Light),
        Some("auto") => None,
        _ => Some(tauri::Theme::Dark),
    }
}

/// The tray icon: the silhouette on macOS, the app's mark everywhere else.
///
/// The menu bar draws a template image as a mask — only the alpha channel
/// matters — so the app's mark (a filled rounded square) would be a solid
/// blob there, with the star invisible inside it. The template is the
/// star by itself, written by `icons/make-icons.mjs` next to the PNGs and
/// embedded raw, so the shell needs no image decoder to use it.
fn tray_icon<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> tauri::image::Image<'static> {
    #[cfg(target_os = "macos")]
    {
        return tauri::image::Image::new_owned(
            TEMPLATE_RGBA.to_vec(),
            TEMPLATE_EDGE,
            TEMPLATE_EDGE,
        );
    }
    #[cfg(not(target_os = "macos"))]
    {
        app.default_window_icon()
            .cloned()
            .map(|icon| icon.to_owned())
            .unwrap_or_else(|| {
                // A build with no icon at all must not take the app down
                // before the window exists; the tray still works, it is only
                // blank.
                tauri::image::Image::new_owned(vec![0u8; 4], 1, 1)
            })
    }
}

/// The template's edge, in pixels — 44 is 22pt at the retina scale the menu
/// bar uses.
#[allow(dead_code)]
const TEMPLATE_EDGE: u32 = 44;

/// The template's raw RGBA, written by `icons/make-icons.mjs` beside the
/// PNGs. Embedded raw so the shell needs no image decoder to use it.
#[allow(dead_code)]
const TEMPLATE_RGBA: &[u8] = include_bytes!("../icons/template.rgba");

/// Where the CLI shim goes: a per-user bin directory, never a system one.
///
/// A shim in a directory that is not on PATH is still worth having — the
/// window says where it is — but the caller is told, so the person can add
/// the directory or move the file.
fn cli_shim_path() -> PathBuf {
    #[cfg(windows)]
    {
        let base = std::env::var("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|_| home_dir().join("AppData").join("Local"));
        base.join("aipass").join("bin").join("aipass.cmd")
    }
    #[cfg(not(windows))]
    {
        home_dir().join(".local").join("bin").join("aipass")
    }
}

/// The stable link the CLI shim names.
///
/// It points at the live content root, so a content update moves the tree
/// without the shim going stale: the CLI and the window run the same code.
fn cli_link() -> PathBuf {
    aipass_home().join("app").join("current")
}

/// The shim's text: the app's own Node, running the app's own CLI.
///
/// The shim does not need Node on PATH — the app ships one — so a machine
/// without Node still gets a working `aipass`.
fn cli_shim_script(node: &std::path::Path, cli: &std::path::Path) -> String {
    #[cfg(windows)]
    {
        format!(
            "@echo off\r\nrem aipass - the CLI of the installed aipass desktop.\r\n\"{}\" \"{}\" %*\r\n",
            node.display(),
            cli.display()
        )
    }
    #[cfg(not(windows))]
    {
        format!(
            "#!/bin/sh\n# aipass - the CLI of the installed aipass desktop.\nexec \"{}\" \"{}\" \"$@\"\n",
            node.display(),
            cli.display()
        )
    }
}

/// Put the shim's directory on the user's PATH.
///
/// A shim in a directory that is not on PATH is a file nobody can run: the
/// window can say where it is, but the person still has to edit PATH by hand
/// — the step that never happens, so the CLI the app installed never gets
/// used. The tray item is already the consent to write to the machine, so the
/// directory goes on PATH with it.
///
/// The user PATH only (`HKCU\Environment`): the machine PATH needs an
/// administrator and is never touched. `reg.exe` is the registry without a
/// crate, and it is the one tool that writes a PATH of any length (setx
/// truncates at 1024 characters).
fn add_to_user_path(dir: &std::path::Path) -> Result<(), String> {
    #[cfg(windows)]
    {
        let dir = dir.to_string_lossy().to_string();
        // "Path    REG_EXPAND_SZ    C:\one;C:\two" — the value is everything
        // after the type, and it may contain spaces.
        let query = Command::new("reg")
            .args(["query", r"HKCU\Environment", "/v", "Path"])
            .output()
            .map_err(|err| format!("reg query failed: {err}"))?;
        let stdout = String::from_utf8_lossy(&query.stdout);
        let (kind, value) = match reg_path_value(&stdout) {
            Some(pair) => pair,
            // No PATH for this user yet: create one, same type as Windows
            // writes by default.
            None => ("REG_EXPAND_SZ".to_string(), String::new()),
        };
        let Some(with_dir) = path_with_dir(&value, &dir) else {
            return Ok(()); // already there
        };
        let status = Command::new("reg")
            .args(["add", r"HKCU\Environment", "/v", "Path", "/t", &kind, "/d", &with_dir, "/f"])
            .status()
            .map_err(|err| format!("reg add failed: {err}"))?;
        if status.success() {
            Ok(())
        } else {
            Err(format!("reg add exited with {status}"))
        }
    }
    #[cfg(not(windows))]
    {
        // The shell profile is the user's own file and the way a Unix PATH
        // grows; the app only says where the shim is, and leaves the profile
        // alone unless it is already there.
        let _ = dir;
        Ok(())
    }
}

/// The PATH value and its registry type, read out of `reg query` output.
///
/// The value is everything after the type column, so a PATH with spaces in
/// it survives: `Path    REG_EXPAND_SZ    C:\Program Files\thing` keeps
/// `C:\Program Files\thing`.
#[cfg(windows)]
fn reg_path_value(stdout: &str) -> Option<(String, String)> {
    let line = stdout
        .lines()
        .find(|line| line.trim_start().starts_with("Path"))?;
    for kind in ["REG_EXPAND_SZ", "REG_SZ"] {
        if let Some(at) = line.find(kind) {
            let value = line[at + kind.len()..].trim().to_string();
            return Some((kind.to_string(), value));
        }
    }
    None
}

/// The PATH with `dir` in it — `None` when the directory is already there.
///
/// The comparison is the same one Windows makes when it reads PATH: the
/// entries are separated by `;`, a trailing backslash is not a difference,
/// and the case is not a difference either.
#[cfg(windows)]
fn path_with_dir(value: &str, dir: &str) -> Option<String> {
    let needle = dir.trim().trim_end_matches('\\').to_lowercase();
    let already = value
        .split(';')
        .any(|part| part.trim().trim_end_matches('\\').to_lowercase() == needle);
    if already {
        return None;
    }
    let trimmed = value.trim().trim_end_matches(';');
    if trimmed.is_empty() {
        return Some(dir.to_string());
    }
    Some(format!("{trimmed};{dir}"))
}

/// Write the CLI shim. The tray item is the consent: nothing is written
/// until somebody asks for it.
fn install_cli_shim<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|err| err.to_string())?;
    let exe_dir = exe
        .parent()
        .ok_or_else(|| "no executable directory".to_string())?
        .to_path_buf();
    let resource_dir = app.path().resource_dir().ok();
    let node = find_node(&exe_dir, resource_dir.as_deref())
        .ok_or_else(|| "the app's own Node is not beside it".to_string())?;
    let cli = {
        // The CLI is named through the STABLE link, not through a versioned
        // directory: a content update promotes a new tree, and a shim that
        // named the old path would keep running yesterday's code while the
        // window runs today's. The link is made by the Node side
        // (`harness/app-root.mjs`), which can make a junction on Windows
        // without an administrator; the bundle is the fallback for a
        // machine whose backend never came up.
        let linked = cli_link().join("aipass-bridge").join("bin").join("aipass.mjs");
        if linked.exists() {
            linked
        } else {
            app.path()
                .resolve("aipass-bridge/bin/aipass.mjs", tauri::path::BaseDirectory::Resource)
                .map(plain)
                .map_err(|err| format!("the CLI is not in the bundle: {err}"))?
        }
    };
    let shim = cli_shim_path();
    if let Some(parent) = shim.parent() {
        std::fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    std::fs::write(&shim, cli_shim_script(&node, &cli)).map_err(|err| err.to_string())?;
    #[cfg(not(windows))]
    make_executable(&shim)?;
    Ok(shim)
}

/// A shim nobody can run is not a shim.
#[cfg(not(windows))]
fn make_executable(path: &std::path::Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let mut permissions = std::fs::metadata(path)
        .map_err(|err| err.to_string())?
        .permissions();
    permissions.set_mode(0o755);
    std::fs::set_permissions(path, permissions).map_err(|err| err.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    static COUNTER: AtomicU32 = AtomicU32::new(0);

    /// A throwaway home: `<temp>/aipass-tauri-<pid>-<n>`, with the `.aipass`
    /// folder the settings live in.
    fn scratch_home() -> PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("aipass-tauri-{}-{}", std::process::id(), n));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join(".aipass")).expect("scratch home");
        dir
    }

    /// A project folder the migration can point at — it has to exist, or the
    /// root migrates nowhere.
    fn scratch_project(home: &std::path::Path) -> PathBuf {
        let project = home.join("project");
        std::fs::create_dir_all(&project).expect("scratch project");
        project
    }

    #[test]
    fn the_legacy_migration_keeps_the_settings_it_finds() {
        // The settings file holds the mode, the model, the compaction budget
        // and the path rules. The migration writes one key, so it has to merge
        // — a migration that replaced the file took all of that with it.
        let home = scratch_home();
        let project = scratch_project(&home);
        let settings = home.join(".aipass").join("settings.json");
        std::fs::write(
            &settings,
            r#"{"mode":"ask","defaultModel":"some-model","compaction":{"contextTokens":24000}}"#,
        )
        .expect("settings");
        let legacy = home.join(".aipass").join("desktop.json");
        std::fs::write(
            &legacy,
            serde_json::to_string(&serde_json::json!({ "root": project.to_string_lossy() })).expect("json"),
        )
        .expect("legacy");

        let found = last_root_in(&home);
        assert_eq!(found.as_deref(), Some(project.as_path()), "the root migrated");

        let after: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&settings).expect("settings")).expect("json");
        assert_eq!(after["root"].as_str(), Some(project.to_string_lossy().as_ref()));
        assert_eq!(after["mode"].as_str(), Some("ask"), "the mode survived");
        assert_eq!(after["defaultModel"].as_str(), Some("some-model"), "the model survived");
        assert_eq!(
            after["compaction"]["contextTokens"].as_u64(),
            Some(24000),
            "the compaction budget survived"
        );
        assert!(!legacy.exists(), "the legacy file is gone once the root is written");
    }

    #[test]
    fn the_legacy_migration_creates_a_settings_file_when_there_is_none() {
        let home = scratch_home();
        let project = scratch_project(&home);
        let legacy = home.join(".aipass").join("desktop.json");
        std::fs::write(
            &legacy,
            serde_json::to_string(&serde_json::json!({ "root": project.to_string_lossy() })).expect("json"),
        )
        .expect("legacy");

        let found = last_root_in(&home);
        assert_eq!(found.as_deref(), Some(project.as_path()));
        let settings = home.join(".aipass").join("settings.json");
        assert!(settings.exists(), "the settings file was written");
        let after: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&settings).expect("settings")).expect("json");
        assert_eq!(after["root"].as_str(), Some(project.to_string_lossy().as_ref()));
    }

    #[test]
    fn a_settings_file_that_already_names_a_root_is_left_alone() {
        // The legacy file is only a fallback: a settings file that already
        // names a live root is the truth, and the migration does not run.
        let home = scratch_home();
        let project = scratch_project(&home);
        let settings = home.join(".aipass").join("settings.json");
        std::fs::write(
            &settings,
            serde_json::to_string(&serde_json::json!({ "root": project.to_string_lossy(), "mode": "ask" })).expect("json"),
        )
        .expect("settings");
        let legacy = home.join(".aipass").join("desktop.json");
        std::fs::write(
            &legacy,
            serde_json::to_string(&serde_json::json!({ "root": home.join("gone").to_string_lossy() })).expect("json"),
        )
        .expect("legacy");

        let found = last_root_in(&home);
        assert_eq!(found.as_deref(), Some(project.as_path()));
        let after: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&settings).expect("settings")).expect("json");
        assert_eq!(after["mode"].as_str(), Some("ask"), "the settings were not rewritten");
        assert!(legacy.exists(), "the legacy file stays: the settings file was never migrated");
    }

    #[test]
    fn the_aipass_home_override_names_the_aipass_directory_itself() {
        // The Node side reads AIPASS_HOME as the `.aipass` directory, so the
        // shell reads it the same way: one override, one meaning. The lookup
        // is split so a test can name a directory without touching the
        // environment.
        let home = scratch_home();
        let project = scratch_project(&home);
        let aipass = home.join(".aipass");
        std::fs::write(
            &aipass.join("settings.json"),
            serde_json::to_string(&serde_json::json!({ "root": project.to_string_lossy() })).unwrap_or_default(),
        )
        .expect("settings");
        let found = last_root_in_aipass(&aipass);
        assert_eq!(found.as_deref(), Some(project.as_path()));
    }

    #[test]
    fn the_windows_long_path_prefix_is_stripped() {
        // Node cannot run a `\\?\` path: it reads the prefix as a directory
        // and the backend dies with `lstat 'C:'`. The installed app hit
        // exactly that, and the install ladder is what found it.
        assert_eq!(
            plain(PathBuf::from(r"\\?\C:\apps\aipass desktop\node.exe")),
            PathBuf::from(r"C:\apps\aipass desktop\node.exe")
        );
        assert_eq!(
            plain(PathBuf::from(r"\\?\UNC\server\share\aipass")),
            PathBuf::from(r"\\server\share\aipass")
        );
        // A path that is already plain stays exactly as it was.
        assert_eq!(
            plain(PathBuf::from(r"C:\apps\aipass")),
            PathBuf::from(r"C:\apps\aipass")
        );
    }

    #[test]
    fn the_cli_shim_runs_the_apps_own_node() {
        // The shim must not need Node on PATH — the app ships one — so it
        // names the node beside the app and the CLI inside the bundle.
        let script = cli_shim_script(
            std::path::Path::new("/apps/node"),
            std::path::Path::new("/apps/aipass-bridge/bin/aipass.mjs"),
        );
        assert!(script.contains("/apps/node"), "the node is named: {script}");
        assert!(
            script.contains("/apps/aipass-bridge/bin/aipass.mjs"),
            "the CLI is named: {script}"
        );
        #[cfg(windows)]
        assert!(script.contains("%*"), "the arguments are passed on: {script}");
        #[cfg(not(windows))]
        assert!(script.contains("\"$@\""), "the arguments are passed on: {script}");
    }

    #[cfg(windows)]
    #[test]
    fn the_reg_path_value_keeps_a_path_with_spaces_in_it() {
        // `reg query` prints the value after the type column, so a PATH with
        // spaces in it survives the round trip.
        let out = "\r\nHKEY_CURRENT_USER\\Environment\r\n    Path    REG_EXPAND_SZ    C:\\Program Files\\thing;C:\\other\r\n\r\n";
        let (kind, value) = reg_path_value(out).expect("the value is there");
        assert_eq!(kind, "REG_EXPAND_SZ");
        assert_eq!(value, r"C:\Program Files\thing;C:\other");
        // A PATH that is not there is not invented.
        assert!(reg_path_value("HKEY_CURRENT_USER\\Environment\r\n    Temp    REG_SZ    C:\\Temp\r\n").is_none());
    }

    #[cfg(windows)]
    #[test]
    fn the_path_gains_the_directory_once() {
        let dir = r"C:\Users\me\AppData\Local\aipass\bin";
        // Already there: nothing to write.
        assert_eq!(path_with_dir(&format!("C:\\other;{dir}"), dir), None);
        // A trailing backslash is not a difference, and neither is the case.
        assert_eq!(path_with_dir(&format!(r"C:\other;{dir}\"), dir), None);
        assert_eq!(path_with_dir(&format!(r"C:\other;{}\", dir.to_lowercase()), dir), None);
        // Not there: the directory is appended, and the old value is kept.
        assert_eq!(
            path_with_dir(r"C:\other", dir),
            Some(format!(r"C:\other;{dir}"))
        );
        // An empty PATH becomes just the directory.
        assert_eq!(path_with_dir("", dir), Some(dir.to_string()));
    }

    #[test]
    fn the_cli_shim_lands_in_a_per_user_directory() {
        // A shim in a system directory would need an administrator; a shim in
        // the user's own directory needs nobody.
        let path = cli_shim_path();
        #[cfg(windows)]
        assert!(path.ends_with("aipass.cmd"), "the shim is a batch file: {path:?}");
        #[cfg(not(windows))]
        assert!(path.ends_with("aipass"), "the shim is a shell script: {path:?}");
        let text = path.to_string_lossy().to_lowercase();
        // The per-user bin is often `~/.local/bin`, whose name contains
        // `/bin/` without being the system directory. The check is the
        // prefix of a system root, not a substring anywhere in the path.
        #[cfg(unix)]
        for system in ["/usr/", "/bin/", "/sbin/", "/opt/"] {
            assert!(!text.starts_with(system), "the shim is not in {system}: {path:?}");
        }
        #[cfg(windows)]
        for system in ["c:\\windows", "c:\\program files", "c:\\program files (x86)"] {
            assert!(!text.starts_with(system), "the shim is not in {system}: {path:?}");
        }
    }

    /// A content tree with the marker in it — what an overlay root looks like.
    fn scratch_content(home: &std::path::Path, version: &str) -> PathBuf {
        let root = home.join("app").join("content").join(version);
        let marker = root.join(MARKER);
        std::fs::create_dir_all(marker.parent().expect("marker dir")).expect("content tree");
        std::fs::write(&marker, "//\n").expect("marker");
        root
    }

    /// The pointer the Node side writes.
    fn write_active(
        home: &std::path::Path,
        current: Option<(&str, &std::path::Path)>,
        previous: Option<(&str, &std::path::Path)>,
        updated_at: u64,
    ) {
        let dir = home.join("app");
        std::fs::create_dir_all(&dir).expect("app dir");
        let entry = |pair: Option<(&str, &std::path::Path)>| match pair {
            Some((version, root)) => serde_json::json!({
                "version": version,
                "root": root.to_string_lossy(),
            }),
            None => serde_json::Value::Null,
        };
        let json = serde_json::json!({
            "schema": 1,
            "current": entry(current),
            "previous": entry(previous),
            "updatedAt": updated_at,
        });
        std::fs::write(
            dir.join("active.json"),
            serde_json::to_string_pretty(&json).expect("json"),
        )
        .expect("active");
    }

    #[test]
    fn the_overlay_wins_over_the_bundle() {
        // The overlay is a verified release of the content, so it is the
        // first candidate — the same order the Node side uses.
        let home = scratch_home();
        let overlay = scratch_content(&home, "0.3.0");
        let bundle = home.join("bundle");
        std::fs::create_dir_all(bundle.join("aipass-bridge").join("bridge")).expect("bundle");
        std::fs::write(bundle.join(MARKER), "//\n").expect("marker");

        write_active(&home, Some(("0.3.0", &overlay)), None, 1);
        assert_eq!(overlay_root_in(&home), Some(overlay.clone()));

        let candidates = vec![
            (overlay.clone(), "overlay"),
            (bundle.clone(), "bundle"),
        ];
        let (root, source) = pick_root(&candidates);
        assert_eq!(root, overlay, "the overlay is the root");
        assert_eq!(source, "overlay");
    }

    #[test]
    fn a_pointer_that_names_nothing_is_ignored() {
        // A half-written pointer must not send the app looking for files
        // that are not there: the bundle is the root instead.
        let home = scratch_home();
        let missing = home.join("app").join("content").join("gone");
        write_active(&home, Some(("0.3.0", &missing)), None, 1);
        assert_eq!(overlay_root_in(&home), None);
    }

    #[test]
    fn one_of_our_backends_on_the_port_is_adopted() {
        // The window is pointed at that port, and it is already talking to
        // the backend that is answering there. Starting another one could
        // only die on the same port, so the supervisor stops starting one.
        assert_eq!(busy_outcome(PortOwner::Ours), BusyOutcome::Adopt);
    }

    #[test]
    fn a_stranger_on_the_port_is_named_and_not_retried_harder() {
        // Restarting cannot fix a stranger on the port. The situation is
        // named once, with the fix, and the polite backoff continues — so
        // the port is picked up again if it is freed.
        assert_eq!(busy_outcome(PortOwner::Stranger), BusyOutcome::Name);
    }

    #[test]
    fn a_port_nobody_holds_is_just_a_backoff() {
        // Nothing there, or the probe could not say: the ordinary backoff is
        // the answer either way.
        assert_eq!(busy_outcome(PortOwner::Empty), BusyOutcome::Backoff);
        assert_eq!(busy_outcome(PortOwner::Unknown), BusyOutcome::Backoff);
    }

    #[test]
    fn the_busy_exit_code_is_not_the_restart_one() {
        // The supervisor reads the two apart: one means "a new content tree
        // needs a new process", the other means "the port was taken". A
        // collision would make a busy port look like a deliberate restart.
        assert_ne!(PORT_BUSY_EXIT, RESTART_EXIT);
        assert_eq!(PORT_BUSY_EXIT, 43);
    }

    #[test]
    fn a_busy_port_is_not_a_broken_content_tree() {
        // The content rollback is about a tree that breaks the backend. A
        // port that is taken is not the tree's fault, and rolling back
        // because of it threw away good content for nothing — the app put
        // the previous tree back while the port stayed busy, and the backend
        // kept failing on the same port.
        assert_eq!(counts_against_the_content(Some(PORT_BUSY_EXIT)), false);
        assert_eq!(counts_against_the_content(Some(RESTART_EXIT)), true);
        assert_eq!(counts_against_the_content(Some(1)), true);
        assert_eq!(counts_against_the_content(None), true);
    }

    #[test]
    fn the_content_rolls_back_when_the_promotion_was_recent() {
        // Three deaths in a row right after a promotion is the shape of a
        // broken content tree. The previous one is still on disk, so the app
        // heals itself.
        let home = scratch_home();
        let current = scratch_content(&home, "0.3.0");
        let previous = scratch_content(&home, "0.2.9");
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        write_active(
            &home,
            Some(("0.3.0", &current)),
            Some(("0.2.9", &previous)),
            now,
        );
        assert!(roll_content_back_in(&home), "the rollback happened");
        let after: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(home.join("app").join("active.json")).expect("active"),
        )
        .expect("json");
        assert_eq!(
            after["current"]["root"].as_str(),
            Some(previous.to_string_lossy().as_ref()),
            "the previous content is live again"
        );
        assert_eq!(
            after["previous"]["root"].as_str(),
            Some(current.to_string_lossy().as_ref()),
            "and the broken one is kept, so a second rollback is possible"
        );
    }

    #[test]
    fn the_content_does_not_roll_back_after_a_stale_promotion() {
        // A tree promoted an hour ago has been fine since; it is not what
        // broke just now, so nothing is rolled back.
        let home = scratch_home();
        let current = scratch_content(&home, "0.3.0");
        let previous = scratch_content(&home, "0.2.9");
        let hour_ago = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0)
            - 60 * 60 * 1000;
        write_active(
            &home,
            Some(("0.3.0", &current)),
            Some(("0.2.9", &previous)),
            hour_ago,
        );
        assert!(!roll_content_back_in(&home), "nothing was rolled back");
    }

    #[test]
    fn the_handover_command_names_a_file_and_not_a_path() {
        // The command names a file in the app's own downloads directory. A
        // name that carries a path would let a command file make the app run
        // anything anywhere else, so it is refused.
        let home = scratch_home();
        let commands = home.join("app").join("commands");
        std::fs::create_dir_all(&commands).expect("commands");

        let write = |_label: &str, file: &str| {
            std::fs::write(
                commands.join("install.json"),
                format!(
                    "{{\"version\":\"0.3.0\",\"file\":\"{}\",\"sha256\":\"{}\"}}",
                    file,
                    "a".repeat(64)
                ),
            )
            .expect("command");
            read_install_command(&home).map(|c| c.file)
        };

        assert_eq!(
            write("good", "aipass-desktop-0.3.0-windows-x64-setup.exe").as_deref(),
            Some("aipass-desktop-0.3.0-windows-x64-setup.exe"),
            "a plain name is read"
        );
        assert_eq!(write("slash", "../evil.exe"), None, "a path is refused");
        assert_eq!(write("windows", "C:\\evil.exe"), None, "a drive is refused");
        assert_eq!(write("up", "..\\evil.exe"), None, "a way up is refused");
        assert_eq!(write("empty", ""), None, "an empty name is refused");
    }

    #[test]
    fn there_is_no_handover_without_a_command() {
        // The shell does not go looking for an installer on its own: it acts
        // on a command the backend wrote, and there is no command.
        let home = scratch_home();
        assert!(read_install_command(&home).is_none());
    }

    #[test]
    fn the_tray_template_is_the_mark_and_not_a_block() {        // The menu bar draws a template image as a mask, so only the alpha
        // channel matters: the mark is opaque and the rest is transparent.
        // A filled square would be a solid blob in the menu bar.
        let total = (TEMPLATE_EDGE * TEMPLATE_EDGE) as usize;
        assert_eq!(TEMPLATE_RGBA.len(), total * 4, "the template is RGBA");
        let opaque = TEMPLATE_RGBA
            .iter()
            .skip(3)
            .step_by(4)
            .filter(|alpha| **alpha > 0)
            .count();
        assert!(opaque > total / 10, "the mark is there: {opaque} of {total}");
        assert!(opaque < total * 4 / 5, "it is the mark, not a filled block: {opaque}");
        assert_eq!(TEMPLATE_RGBA[3], 0, "the corner is transparent");
    }
}
