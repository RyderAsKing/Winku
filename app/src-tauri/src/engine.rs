//! Runs winku-engine as a child process and bridges its JSON-lines protocol
//! (engine/src/protocol.ts) to the webview.
//!
//! - Events and `permission` Requests go to the main window as the `engine` event.
//!   `action_end` for a replace action also pastes the result (actions.rs).
//! - Results are matched to `engine_call`s by id.
//! - `screen_capture` and `screen_target` Requests are answered by the shell (capture.rs) on a
//!   worker thread, and so are `clipboard_read` and `clipboard_write` (clipboard.rs).
//! - `task_*` Requests are answered by the scheduler (scheduler.rs), which also sees every
//!   Event; `activity` follows what goes out and comes in, so it knows when Winku is idle.
//! - If the engine exits unexpectedly it is restarted with backoff and configured again.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::oneshot;

use crate::{secrets, settings};

/// Webview event that carries engine Events and `permission` Requests.
pub const ENGINE_EVENT: &str = "engine";
/// How long `engine_call` waits for a Result. Generous because test_connection and
/// list_models go over the network.
pub const CALL_TIMEOUT: Duration = Duration::from_secs(60);

type Pending = HashMap<String, oneshot::Sender<Value>>;

struct Running {
    stdin: ChildStdin,
    child: Child,
}

pub struct Engine {
    running: Mutex<Option<Running>>,
    pending: Mutex<Pending>,
    next_id: AtomicU64,
    shutting_down: AtomicBool,
    smoke: Smoke,
    /// Whether a prompt, action or permission ask is open (scheduled runs wait for idle).
    pub activity: crate::scheduler::Activity,
}

#[derive(Clone, Copy)]
struct Smoke {
    /// WINKU_SMOKE: configure the scripted test model, send one prompt, print engine records.
    enabled: bool,
    /// WINKU_SMOKE_STAY: keep running after the reply (for memory measurement).
    stay: bool,
}

impl Smoke {
    fn from_env() -> Self {
        Self {
            enabled: std::env::var_os("WINKU_SMOKE").is_some(),
            stay: std::env::var_os("WINKU_SMOKE_STAY").is_some(),
        }
    }
}

impl Engine {
    pub fn new() -> Self {
        Self {
            running: Mutex::new(None),
            pending: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            shutting_down: AtomicBool::new(false),
            smoke: Smoke::from_env(),
            activity: crate::scheduler::Activity::default(),
        }
    }

    /// Spawns the engine and configures it. Call once the Engine is managed state.
    pub fn start(app: &AppHandle) -> Result<(), String> {
        let engine = app.state::<Engine>();
        let (stdin, child, stdout) = spawn_process()?;
        *engine.running.lock().unwrap_or_else(|e| e.into_inner()) = Some(Running { stdin, child });
        let started = Instant::now();
        let reader_app = app.clone();
        std::thread::spawn(move || read_loop(reader_app, stdout, started));
        if engine.smoke.enabled {
            engine.send(&smoke_configure(app))?;
            engine.send(
                &json!({ "type": "prompt", "id": "smoke", "text": "hello from the shell" }),
            )?;
        } else {
            configure(app);
        }
        Ok(())
    }

    pub fn send(&self, message: &Value) -> Result<(), String> {
        {
            let mut running = self.running.lock().map_err(|_| "engine lock poisoned")?;
            let running = running.as_mut().ok_or("the engine is not running")?;
            writeln!(running.stdin, "{message}")
                .and_then(|_| running.stdin.flush())
                .map_err(|e| format!("engine write failed: {e}"))?;
        }
        self.activity.outgoing(message);
        Ok(())
    }

    /// Sends a Command with a fresh id and waits for its Result. Resolves to `data`, or the
    /// error message when the Result is not ok.
    pub async fn call(&self, mut message: Value) -> Result<Value, String> {
        if !message.is_object() {
            return Err("engine_call: message must be an object".into());
        }
        let id = format!("shell-{}", self.next_id.fetch_add(1, Ordering::Relaxed));
        message["id"] = json!(id);
        let (tx, rx) = oneshot::channel();
        self.pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(id.clone(), tx);
        if let Err(e) = self.send(&message) {
            self.pending
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(&id);
            return Err(e);
        }
        let result = match tokio::time::timeout(CALL_TIMEOUT, rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => return Err("the engine stopped before answering".into()),
            Err(_) => {
                self.pending
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .remove(&id);
                return Err(format!(
                    "the engine did not answer within {}s",
                    CALL_TIMEOUT.as_secs()
                ));
            }
        };
        result_to_outcome(result)
    }

    /// Asks the engine to exit, then kills it if it hasn't within two seconds.
    pub fn shutdown(&self) {
        self.shutting_down.store(true, Ordering::SeqCst);
        let _ = self.send(&json!({ "type": "shutdown" }));
        let Some(mut running) = self
            .running
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take()
        else {
            return;
        };
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            if let Ok(Some(_)) = running.child.try_wait() {
                return;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        let _ = running.child.kill();
        let _ = running.child.wait();
    }

    fn take_pending(&self, id: &str) -> Option<oneshot::Sender<Value>> {
        self.pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(id)
    }

    /// Drops every waiting call (their receivers see "stopped before answering").
    fn fail_pending(&self) {
        self.pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clear();
    }
}

impl Default for Engine {
    fn default() -> Self {
        Self::new()
    }
}

/// Sends `configure` built from settings and the stored key. Does nothing (and returns false)
/// while there is no provider or main model yet: the UI shows its Connect form.
pub fn configure(app: &AppHandle) -> bool {
    let engine = app.state::<Engine>();
    if engine.smoke.enabled {
        return engine.send(&smoke_configure(app)).is_ok();
    }
    let store = app.state::<settings::Store>();
    let key = secrets::get(secrets::Account::ApiKey);
    let search_key = secrets::get(secrets::Account::SearchApiKey);
    let Some(message) =
        store
            .get()
            .configure_command(&store.data_dir, key.as_deref(), search_key.as_deref())
    else {
        return false;
    };
    if let Err(e) = engine.send(&message) {
        eprintln!("winku: configure failed: {e}");
        return false;
    }
    true
}

fn smoke_configure(app: &AppHandle) -> Value {
    json!({
        "type": "configure",
        "dataDir": app.state::<settings::Store>().data_dir,
        "provider": { "kind": "catalog", "id": "winku-faux" },
        "main": { "id": "faux-1", "thinking": "off" },
        "askBeforeRunning": false,
        "alwaysAllow": [],
        "assistantStyle": "",
    })
}

fn spawn_process() -> Result<(ChildStdin, Child, std::process::ChildStdout), String> {
    let path = engine_path()?;
    let mut command = Command::new(&path);
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = command
        .spawn()
        .map_err(|e| format!("failed to start {}: {e}", path.display()))?;
    let stdin = child.stdin.take().ok_or("engine stdin unavailable")?;
    let stdout = child.stdout.take().ok_or("engine stdout unavailable")?;
    Ok((stdin, child, stdout))
}

/// What to do with one line the engine wrote.
#[derive(Debug, PartialEq)]
enum Route {
    /// A Result for a waiting `engine_call`.
    Result(String),
    /// Answer a `screen_capture` Request ourselves.
    ScreenCapture { id: String, include_image: bool },
    /// Answer a `screen_target` Request ourselves (computer use).
    ScreenTarget { id: String },
    /// Answer a `clipboard_read` Request ourselves.
    ClipboardRead { id: String, params: Value },
    /// Answer a `clipboard_write` Request ourselves.
    ClipboardWrite { id: String, params: Value },
    /// A scheduled-task Request (`task_schedule`, `task_wakeup`, `task_list`, `task_cancel`),
    /// answered by the scheduler.
    Task {
        id: String,
        method: String,
        params: Value,
    },
    /// Answer this Request ourselves with an error Response.
    Refuse { id: String, error: String },
    /// Forward to the main window.
    Forward,
}

fn route(record: &Value) -> Route {
    match record["type"].as_str() {
        Some("result") => Route::Result(record["id"].as_str().unwrap_or_default().to_string()),
        Some("request") => {
            let id = record["id"].as_str().unwrap_or_default().to_string();
            match record["method"].as_str() {
                Some("permission") => Route::Forward,
                Some("screen_capture") => Route::ScreenCapture {
                    id,
                    include_image: record["params"]["includeImage"].as_bool() == Some(true),
                },
                Some("screen_target") => Route::ScreenTarget { id },
                Some("clipboard_read") => Route::ClipboardRead {
                    id,
                    params: record["params"].clone(),
                },
                Some("clipboard_write") => Route::ClipboardWrite {
                    id,
                    params: record["params"].clone(),
                },
                Some(method @ ("task_schedule" | "task_wakeup" | "task_list" | "task_cancel")) => {
                    Route::Task {
                        id,
                        method: method.to_string(),
                        params: record["params"].clone(),
                    }
                }
                other => Route::Refuse {
                    id,
                    error: format!("unknown request method {other:?}"),
                },
            }
        }
        _ => Route::Forward,
    }
}

fn result_to_outcome(result: Value) -> Result<Value, String> {
    if result["ok"].as_bool() == Some(true) {
        Ok(result.get("data").cloned().unwrap_or(Value::Null))
    } else {
        Err(result["error"]
            .as_str()
            .unwrap_or("the engine reported an error")
            .to_string())
    }
}

fn read_loop(app: AppHandle, stdout: std::process::ChildStdout, started: Instant) {
    let engine = app.state::<Engine>();
    let smoke = engine.smoke;
    for line in BufReader::new(stdout).lines() {
        let Ok(line) = line else { break };
        let record: Value = match serde_json::from_str(&line) {
            Ok(record) => record,
            Err(_) => {
                eprintln!("winku: ignoring non-JSON engine output: {line}");
                continue;
            }
        };
        if smoke.enabled {
            println!("{line}");
        }
        engine.activity.incoming(&record);
        match route(&record) {
            Route::Result(id) => {
                if record["ok"].as_bool() != Some(true) {
                    // A refused prompt or action never sends reply_end.
                    engine.activity.forget(&id);
                    crate::scheduler::on_prompt_refused(&app, &id);
                }
                if let Some(tx) = engine.take_pending(&id) {
                    let _ = tx.send(record);
                }
            }
            Route::ScreenCapture { id, include_image } => {
                // Capturing can take a while; keep reading.
                let app = app.clone();
                std::thread::spawn(move || {
                    let outcome = crate::capture::screen_capture(&app, include_image);
                    let _ = app
                        .state::<Engine>()
                        .send(&crate::capture::response(&id, outcome));
                });
            }
            Route::ScreenTarget { id } => {
                let app = app.clone();
                std::thread::spawn(move || {
                    let outcome = crate::capture::screen_target(&app);
                    let _ = app
                        .state::<Engine>()
                        .send(&crate::capture::response_with(&id, outcome));
                });
            }
            Route::ClipboardRead { id, params } => {
                let app = app.clone();
                std::thread::spawn(move || {
                    let outcome = crate::clipboard::read(&params);
                    let _ = app
                        .state::<Engine>()
                        .send(&crate::capture::response_with(&id, outcome));
                });
            }
            Route::ClipboardWrite { id, params } => {
                let app = app.clone();
                std::thread::spawn(move || {
                    let outcome = crate::clipboard::write(&params);
                    let _ = app
                        .state::<Engine>()
                        .send(&crate::capture::response_with(&id, outcome));
                });
            }
            Route::Task { id, method, params } => {
                let outcome = crate::scheduler::request(&app, &method, &params);
                let _ = engine.send(&crate::capture::response_with(&id, outcome));
            }
            Route::Refuse { id, error } => {
                let _ = engine
                    .send(&json!({ "type": "response", "id": id, "ok": false, "error": error }));
            }
            Route::Forward => {
                crate::actions::on_engine_record(&app, &record);
                crate::scheduler::on_engine_record(&app, &record);
                let _ = app.emit_to("main", ENGINE_EVENT, &record);
                if smoke.enabled && !smoke.stay {
                    match record["type"].as_str() {
                        Some("reply_end") => app.exit(0),
                        Some("error") => app.exit(1),
                        _ => {}
                    }
                }
            }
        }
    }
    on_exit(&app, started);
}

/// The engine's stdout closed: reap it and restart unless we're shutting down.
fn on_exit(app: &AppHandle, started: Instant) {
    let engine = app.state::<Engine>();
    if let Some(mut running) = engine
        .running
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .take()
    {
        let _ = running.child.wait();
    }
    engine.fail_pending();
    engine.activity.engine_stopped();
    crate::scheduler::on_engine_stopped(app);
    if engine.shutting_down.load(Ordering::SeqCst) {
        return;
    }
    if engine.smoke.enabled {
        eprintln!("winku: engine exited during the smoke test");
        app.exit(1);
        return;
    }
    let _ = app.emit_to(
        "main",
        ENGINE_EVENT,
        &json!({ "type": "error", "errorKind": "engine", "message": "The engine stopped; restarting it." }),
    );
    let app = app.clone();
    std::thread::spawn(move || {
        let mut attempt = restart_attempt(started.elapsed());
        loop {
            std::thread::sleep(backoff(attempt));
            if app.state::<Engine>().shutting_down.load(Ordering::SeqCst) {
                return;
            }
            match Engine::start(&app) {
                Ok(()) => return,
                Err(e) => {
                    eprintln!("winku: engine restart failed: {e}");
                    attempt += 1;
                }
            }
        }
    });
}

/// Restart attempts so far: a crash soon after starting counts as another attempt in a row;
/// a crash after a minute of running starts over.
fn restart_attempt(uptime: Duration) -> u32 {
    static STREAK: AtomicU64 = AtomicU64::new(0);
    if uptime >= Duration::from_secs(60) {
        STREAK.store(0, Ordering::Relaxed);
    }
    STREAK.fetch_add(1, Ordering::Relaxed) as u32
}

/// 0.5 s, 1 s, 2 s, … capped at 30 s.
fn backoff(attempt: u32) -> Duration {
    let ms = 500u64.saturating_mul(1u64 << attempt.min(16));
    Duration::from_millis(ms.min(30_000))
}

/// The sidecar sits next to the app executable, both in `tauri dev` and in installed builds.
fn engine_path() -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os("WINKU_ENGINE_BIN") {
        return Ok(PathBuf::from(path));
    }
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let dir = exe
        .parent()
        .ok_or("app executable has no parent directory")?;
    Ok(dir.join(format!("winku-engine{}", std::env::consts::EXE_SUFFIX)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn routes_records() {
        assert_eq!(
            route(&json!({ "type": "result", "id": "shell-1", "ok": true })),
            Route::Result("shell-1".into())
        );
        assert_eq!(
            route(&json!({ "type": "text_delta", "id": "p", "delta": "hi" })),
            Route::Forward
        );
        assert_eq!(
            route(&json!({ "type": "request", "id": "r1", "method": "permission", "params": {} })),
            Route::Forward
        );
        assert_eq!(
            route(
                &json!({ "type": "request", "id": "r2", "method": "screen_capture", "params": { "includeImage": true } })
            ),
            Route::ScreenCapture {
                id: "r2".into(),
                include_image: true
            }
        );
        assert_eq!(
            route(
                &json!({ "type": "request", "id": "r3", "method": "screen_capture", "params": {} })
            ),
            Route::ScreenCapture {
                id: "r3".into(),
                include_image: false
            }
        );
        assert_eq!(
            route(
                &json!({ "type": "request", "id": "r5", "method": "screen_target", "params": {} })
            ),
            Route::ScreenTarget { id: "r5".into() }
        );
        assert_eq!(
            route(
                &json!({ "type": "request", "id": "r6", "method": "clipboard_read", "params": { "includeImage": true } })
            ),
            Route::ClipboardRead {
                id: "r6".into(),
                params: json!({ "includeImage": true })
            }
        );
        assert_eq!(
            route(
                &json!({ "type": "request", "id": "r7", "method": "clipboard_write", "params": { "text": "hi" } })
            ),
            Route::ClipboardWrite {
                id: "r7".into(),
                params: json!({ "text": "hi" })
            }
        );
        for method in ["task_schedule", "task_wakeup", "task_list", "task_cancel"] {
            assert_eq!(
                route(
                    &json!({ "type": "request", "id": "r8", "method": method, "params": { "id": "3f9a2c1d" } })
                ),
                Route::Task {
                    id: "r8".into(),
                    method: method.into(),
                    params: json!({ "id": "3f9a2c1d" })
                }
            );
        }
        assert!(matches!(
            route(&json!({ "type": "request", "id": "r4", "method": "nope" })),
            Route::Refuse { id, .. } if id == "r4"
        ));
    }

    #[test]
    fn results_become_outcomes() {
        assert_eq!(
            result_to_outcome(json!({ "ok": true, "data": [1] })),
            Ok(json!([1]))
        );
        assert_eq!(result_to_outcome(json!({ "ok": true })), Ok(Value::Null));
        assert_eq!(
            result_to_outcome(json!({ "ok": false, "error": "nope" })),
            Err("nope".into())
        );
    }

    #[test]
    fn backoff_grows_and_caps() {
        assert_eq!(backoff(0), Duration::from_millis(500));
        assert_eq!(backoff(1), Duration::from_secs(1));
        assert_eq!(backoff(3), Duration::from_secs(4));
        assert_eq!(backoff(10), Duration::from_secs(30));
        assert_eq!(backoff(99), Duration::from_secs(30));
    }
}
