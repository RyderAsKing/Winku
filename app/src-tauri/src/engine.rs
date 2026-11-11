//! Runs winku-engine as a child process and bridges its JSON-lines protocol to the webview.

use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

/// Webview event that carries every record the engine writes to stdout.
pub const ENGINE_EVENT: &str = "engine";

pub struct Engine {
    stdin: Mutex<ChildStdin>,
    child: Mutex<Child>,
}

impl Engine {
    pub fn spawn(app: &AppHandle) -> Result<Self, Box<dyn std::error::Error>> {
        let path = engine_path()?;
        let mut command = Command::new(&path);
        command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::inherit());
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

        let smoke = Smoke::from_env();
        let reader_app = app.clone();
        std::thread::spawn(move || {
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
                let _ = reader_app.emit(ENGINE_EVENT, &record);
                if smoke.enabled && !smoke.stay {
                    match record["type"].as_str() {
                        Some("reply_end") => reader_app.exit(0),
                        Some("error") => reader_app.exit(1),
                        _ => {}
                    }
                }
            }
        });

        let engine = Self { stdin: Mutex::new(stdin), child: Mutex::new(child) };
        engine.send(&configure_message(app)?)?;
        if smoke.enabled {
            engine.send(&json!({ "type": "prompt", "id": "smoke", "text": "hello from the shell" }))?;
        }
        Ok(engine)
    }

    pub fn send(&self, message: &Value) -> Result<(), String> {
        let mut stdin = self.stdin.lock().map_err(|_| "engine stdin lock poisoned")?;
        writeln!(stdin, "{message}").and_then(|_| stdin.flush()).map_err(|e| format!("engine write failed: {e}"))
    }

    /// Asks the engine to exit, then kills it if it hasn't within two seconds.
    pub fn shutdown(&self) {
        let _ = self.send(&json!({ "type": "shutdown" }));
        let Ok(mut child) = self.child.lock() else { return };
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            if let Ok(Some(_)) = child.try_wait() {
                return;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        let _ = child.kill();
        let _ = child.wait();
    }
}

struct Smoke {
    /// WINKU_SMOKE: send one prompt at startup and print engine records to stdout.
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

/// The sidecar sits next to the app executable, both in `tauri dev` and in installed builds.
fn engine_path() -> Result<PathBuf, Box<dyn std::error::Error>> {
    if let Some(path) = std::env::var_os("WINKU_ENGINE_BIN") {
        return Ok(PathBuf::from(path));
    }
    let exe = std::env::current_exe()?;
    let dir = exe.parent().ok_or("app executable has no parent directory")?;
    Ok(dir.join(format!("winku-engine{}", std::env::consts::EXE_SUFFIX)))
}

/// Spike only: the scripted test model by default, or a real provider from WINKU_PROVIDER,
/// WINKU_MODEL and WINKU_API_KEY. Step 2 replaces this with settings and Credential Manager.
fn configure_message(app: &AppHandle) -> Result<Value, Box<dyn std::error::Error>> {
    let data_dir = app.path().data_dir()?.join("winku");
    let provider = std::env::var("WINKU_PROVIDER").unwrap_or_else(|_| "winku-faux".into());
    let model = std::env::var("WINKU_MODEL").unwrap_or_else(|_| "faux-1".into());
    let mut message = json!({
        "type": "configure",
        "dataDir": data_dir,
        "provider": provider,
        "model": model,
    });
    if let Ok(key) = std::env::var("WINKU_API_KEY") {
        message["apiKey"] = Value::String(key);
    }
    Ok(message)
}
