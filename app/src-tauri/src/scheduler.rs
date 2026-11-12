//! The scheduler (docs/ARCHITECTURE.md, "Scheduled tasks"): a 1 s tick on wall-clock time that
//! starts due jobs when Winku is idle, answers the engine's `task_*` Requests, runs watch
//! commands, sends notices, and tells the windows (`tasks_changed`). The rules are in
//! `tasks.rs`; this module is the glue to Tauri, the engine and the processes.
//!
//! `Activity` tracks whether Winku is idle. The engine owns it (`Engine::activity`) because it
//! sees every message going out and coming in.

use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::engine::Engine;
use crate::tasks::{self, Effects, Fire, Kind, ScheduleParams, TaskInfo, Tasks};

/// Event with `TaskInfo[]` for every window.
pub const TASKS_CHANGED: &str = "tasks_changed";
const TICK: Duration = Duration::from_secs(1);

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

// ───────────────────────────── idle tracking ─────────────────────────────

#[derive(Debug, Default)]
struct ActivityState {
    /// The engine sent `ready` since it last started.
    ready: bool,
    /// `prompt` and `run_action` ids sent without their `reply_end`/`action_end` yet.
    in_flight: HashSet<String>,
    /// Unanswered `permission` Requests: request id → the reply they belong to.
    permissions: HashMap<String, Option<String>>,
    talking: bool,
    draft: bool,
}

/// Whether Winku is busy: a due job waits while a prompt or action runs, a permission ask is
/// open, the talk key is held or the bar has a draft. Runs also wait for the engine's `ready`.
#[derive(Debug, Default)]
pub struct Activity(Mutex<ActivityState>);

impl Activity {
    /// A message the shell wrote to the engine.
    pub fn outgoing(&self, message: &Value) {
        let mut state = lock(&self.0);
        let id = message["id"].as_str();
        match message["type"].as_str() {
            Some("prompt" | "run_action") => {
                if let Some(id) = id {
                    state.in_flight.insert(id.to_string());
                }
            }
            Some("response") => {
                if let Some(id) = id {
                    state.permissions.remove(id);
                }
            }
            // The engine denies pending permission asks on abort.
            Some("abort") => state.permissions.clear(),
            _ => {}
        }
    }

    /// A record the engine wrote.
    pub fn incoming(&self, record: &Value) {
        let mut state = lock(&self.0);
        match record["type"].as_str() {
            Some("ready") => state.ready = true,
            Some("reply_end" | "action_end") => {
                if let Some(id) = record["id"].as_str() {
                    state.in_flight.remove(id);
                    state
                        .permissions
                        .retain(|_, reply| reply.as_deref() != Some(id));
                }
            }
            Some("request") if record["method"].as_str() == Some("permission") => {
                if let Some(id) = record["id"].as_str() {
                    let reply = record["params"]["replyId"].as_str().map(str::to_string);
                    state.permissions.insert(id.to_string(), reply);
                }
            }
            _ => {}
        }
    }

    /// A prompt or action the engine refused (an error Result): it never ends with an event.
    pub fn forget(&self, id: &str) {
        lock(&self.0).in_flight.remove(id);
    }

    /// The engine process ended: nothing it was doing will finish.
    pub fn engine_stopped(&self) {
        let mut state = lock(&self.0);
        state.ready = false;
        state.in_flight.clear();
        state.permissions.clear();
    }

    pub fn set_talking(&self, talking: bool) {
        lock(&self.0).talking = talking;
    }

    pub fn set_draft(&self, draft: bool) {
        lock(&self.0).draft = draft;
    }

    pub fn ready(&self) -> bool {
        lock(&self.0).ready
    }

    /// The engine is ready and nothing is going on.
    pub fn idle(&self) -> bool {
        let state = lock(&self.0);
        state.ready
            && state.in_flight.is_empty()
            && state.permissions.is_empty()
            && !state.talking
            && !state.draft
    }

    /// A permission ask for this reply is open.
    pub fn waiting_on(&self, reply_id: &str) -> bool {
        lock(&self.0)
            .permissions
            .values()
            .any(|reply| reply.as_deref() == Some(reply_id))
    }
}

// ───────────────────────────── the scheduler ─────────────────────────────

/// A running watch command.
struct Proc {
    pid: u32,
    generation: u64,
}

/// Managed state.
pub struct Scheduler {
    data_dir: PathBuf,
    tasks: Mutex<Tasks>,
    procs: Mutex<HashMap<String, Proc>>,
    generation: AtomicU64,
    /// Notices waiting for the engine's `ready`.
    notices: Mutex<Vec<String>>,
    last_info: Mutex<Option<Vec<TaskInfo>>>,
    last_saved: Mutex<String>,
}

impl Scheduler {
    /// Loads `tasks.json` and does the restart pass. Its effects (notices, watches to start)
    /// wait for `start`.
    pub fn open(data_dir: PathBuf) -> Self {
        let jobs = tasks::load(&data_dir);
        let saved = tasks::serialize(&jobs);
        let tasks = Tasks::restore(jobs, now_ms());
        Self {
            data_dir,
            tasks: Mutex::new(tasks),
            procs: Mutex::new(HashMap::new()),
            generation: AtomicU64::new(0),
            notices: Mutex::new(Vec::new()),
            last_info: Mutex::new(None),
            last_saved: Mutex::new(saved),
        }
    }

    /// How many jobs exist (the menu's `Scheduled (n)`).
    pub fn count(&self) -> usize {
        lock(&self.tasks).jobs().len()
    }
}

/// Starts the watches the restart pass kept, queues its notices, and starts the tick.
pub fn start(app: &AppHandle) {
    with_tasks(app, |_| ());
    let app = app.clone();
    let spawned = std::thread::Builder::new()
        .name("winku-scheduler".into())
        .spawn(move || loop {
            std::thread::sleep(TICK);
            tick(&app);
        });
    if let Err(e) = spawned {
        eprintln!("winku: scheduler thread failed: {e}");
    }
}

/// Runs `change` on the jobs, then does what it asked for and tells the windows.
fn with_tasks<R>(app: &AppHandle, change: impl FnOnce(&mut Tasks) -> R) -> R {
    let scheduler = app.state::<Scheduler>();
    let (result, effects) = {
        let mut tasks = lock(&scheduler.tasks);
        let result = change(&mut tasks);
        (result, tasks.take_effects())
    };
    apply(app, effects);
    refresh(app);
    result
}

fn apply(app: &AppHandle, effects: Effects) {
    for id in effects.stop_watches {
        stop_watch(app, &id);
    }
    for id in effects.start_watches {
        start_watch(app, &id);
    }
    if !effects.notices.is_empty() {
        lock(&app.state::<Scheduler>().notices).extend(effects.notices);
        flush_notices(app);
    }
}

/// Sends the queued notices once the engine is ready.
fn flush_notices(app: &AppHandle) {
    let engine = app.state::<Engine>();
    if !engine.activity.ready() {
        return;
    }
    let notices = std::mem::take(&mut *lock(&app.state::<Scheduler>().notices));
    for (n, text) in notices.iter().enumerate() {
        if engine
            .send(&json!({ "type": "notice", "text": text }))
            .is_err()
        {
            // Try again after the engine's next `ready`.
            lock(&app.state::<Scheduler>().notices).splice(0..0, notices[n..].iter().cloned());
            return;
        }
    }
}

/// Saves the file and sends `tasks_changed` when anything changed.
fn refresh(app: &AppHandle) {
    let scheduler = app.state::<Scheduler>();
    let (infos, text) = {
        let tasks = lock(&scheduler.tasks);
        let waiting = tasks
            .running()
            .is_some_and(|(_, prompt)| app.state::<Engine>().activity.waiting_on(prompt));
        (
            tasks.list(now_ms(), waiting),
            tasks::serialize(tasks.jobs()),
        )
    };
    {
        let mut saved = lock(&scheduler.last_saved);
        if *saved != text {
            match tasks::save(&scheduler.data_dir, &text) {
                Ok(()) => *saved = text,
                Err(e) => eprintln!("winku: could not save tasks: {e}"),
            }
        }
    }
    let mut last = lock(&scheduler.last_info);
    if last.as_ref() != Some(&infos) {
        let _ = app.emit(TASKS_CHANGED, &infos);
        *last = Some(infos);
    }
}

fn tick(app: &AppHandle) {
    let idle = app.state::<Engine>().activity.idle();
    if let Some(fire) = with_tasks(app, |tasks| tasks.poll(now_ms(), idle)) {
        launch(app, fire);
    }
}

/// Sends a run's prompt and tells the main window.
fn launch(app: &AppHandle, fire: Fire) {
    let settings = app.state::<crate::settings::Store>().get();
    let speak = match settings.voice.reply.as_str() {
        "always_voice" => Some(settings.voice.say.clone()),
        "mirror" if fire.spoken => Some(settings.voice.say.clone()),
        _ => None,
    };
    let now = crate::capture::scheduled_now_line();
    let voice_profile = settings.voice_profiles.for_app(now.app.as_deref());
    let mut message = json!({
        "type": "prompt",
        "id": fire.prompt_id,
        "text": fire.text,
        "now": now,
        "spoken": false,
        "voiceProfile": voice_profile,
        "scheduled": fire.run,
    });
    if let Some(speak) = &speak {
        message["speak"] = json!(speak);
    }
    if let Err(e) = app.state::<Engine>().send(&message) {
        eprintln!("winku: scheduled run: {e}");
        with_tasks(app, |tasks| {
            tasks.run_failed(&fire.prompt_id, "engine", now_ms())
        });
        return;
    }
    let mut started = json!({
        "kind": "scheduled_started",
        "id": fire.prompt_id,
        "name": fire.run.name,
        "taskKind": fire.run.kind,
    });
    if let Some(speak) = speak {
        started["speak"] = json!(speak);
    }
    let _ = app.emit_to(crate::window::MAIN, "ui", &started);
}

// ───────────────────────────── engine hooks ─────────────────────────────

/// Every Event the engine sends (after `Activity::incoming`).
pub fn on_engine_record(app: &AppHandle, record: &Value) {
    match record["type"].as_str() {
        Some("ready") => flush_notices(app),
        Some("reply_end") => {
            if let Some(id) = record["id"].as_str() {
                with_tasks(app, |tasks| tasks.run_ended(id, now_ms()));
            }
        }
        Some("error") => {
            if let Some(id) = record["id"].as_str() {
                let kind = record["errorKind"].as_str().unwrap_or("engine");
                with_tasks(app, |tasks| tasks.run_error(id, kind));
            }
        }
        // A permission ask changes the run's status to waiting.
        Some("request") => refresh(app),
        _ => {}
    }
}

/// An error Result for a prompt the shell sent.
pub fn on_prompt_refused(app: &AppHandle, id: &str) {
    with_tasks(app, |tasks| tasks.run_failed(id, "engine", now_ms()));
}

/// The engine process ended: the run (if any) failed.
pub fn on_engine_stopped(app: &AppHandle) {
    with_tasks(app, |tasks| {
        if let Some((_, prompt)) = tasks.running() {
            let prompt = prompt.to_string();
            tasks.run_failed(&prompt, "engine", now_ms());
        }
    });
}

/// Answers a `task_schedule`, `task_wakeup`, `task_list` or `task_cancel` Request.
pub fn request(app: &AppHandle, method: &str, params: &Value) -> Result<Value, String> {
    let now = now_ms();
    let to_value = |info: TaskInfo| serde_json::to_value(info).map_err(|e| e.to_string());
    match method {
        "task_schedule" => {
            let params: ScheduleParams =
                serde_json::from_value(params.clone()).map_err(|e| format!("Bad task: {e}"))?;
            with_tasks(app, |tasks| tasks.schedule(params, now)).and_then(to_value)
        }
        "task_wakeup" => {
            let from = params["from"].as_str().ok_or(tasks::NOT_SELF_PACED)?;
            let delay = params["delayMs"].as_u64();
            let stop = params["stop"].as_bool() == Some(true);
            match with_tasks(app, |tasks| tasks.wakeup(from, delay, stop, now))? {
                Some(info) => Ok(json!({ "task": info })),
                None => Ok(json!({})),
            }
        }
        "task_list" => Ok(json!({ "tasks": list(app) })),
        "task_cancel" => {
            let id = params["id"].as_str().unwrap_or_default();
            let from = params["from"].as_str();
            with_tasks(app, |tasks| tasks.cancel(id, from, now)).and_then(to_value)
        }
        other => Err(format!("unknown request method {other:?}")),
    }
}

// ───────────────────────────── UI commands ─────────────────────────────

/// Every job, soonest first.
pub fn list(app: &AppHandle) -> Vec<TaskInfo> {
    let scheduler = app.state::<Scheduler>();
    let tasks = lock(&scheduler.tasks);
    let waiting = tasks
        .running()
        .is_some_and(|(_, prompt)| app.state::<Engine>().activity.waiting_on(prompt));
    tasks.list(now_ms(), waiting)
}

/// Settings > Schedules: Cancel.
pub fn cancel(app: &AppHandle, id: &str) -> Result<(), String> {
    with_tasks(app, |tasks| tasks.cancel(id, None, now_ms())).map(|_| ())
}

/// Quitting: kill every watch command.
pub fn shutdown(app: &AppHandle) {
    let Some(scheduler) = app.try_state::<Scheduler>() else {
        return;
    };
    let procs: Vec<Proc> = lock(&scheduler.procs).drain().map(|(_, p)| p).collect();
    for proc in procs {
        kill_tree(proc.pid);
    }
}

// ───────────────────────────── watch commands ─────────────────────────────

/// The program and arguments for a watch command: PowerShell, or bash where that is the choice.
fn watch_command(job: &tasks::Job) -> Command {
    let script = job.command.clone().unwrap_or_default();
    let bash = match &job.shell {
        Some(shell) if shell.kind == "bash" => {
            Some(shell.path.clone().unwrap_or_else(|| "bash".into()))
        }
        Some(_) => None,
        None if cfg!(windows) => None,
        None => Some("bash".into()),
    };
    match bash {
        Some(bash) => {
            let mut command = Command::new(bash);
            command.arg("-c").arg(script);
            command
        }
        None => {
            let mut command = Command::new("powershell.exe");
            command.args(["-NoProfile", "-NonInteractive", "-Command"]);
            command.arg(script);
            command
        }
    }
}

fn start_watch(app: &AppHandle, id: &str) {
    let scheduler = app.state::<Scheduler>();
    let Some(job) = lock(&scheduler.tasks).job(id).cloned() else {
        return;
    };
    if job.kind != Kind::Watch {
        return;
    }
    stop_watch(app, id);
    let mut command = watch_command(&job);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Ok(home) = app.path().home_dir() {
        command.current_dir(home);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // Its own process group, so the whole tree can be killed.
        command.process_group(0);
    }
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(e) => {
            let error = e.to_string();
            with_tasks(app, |tasks| tasks.watch_start_failed(id, &error));
            return;
        }
    };
    let generation = scheduler.generation.fetch_add(1, Ordering::Relaxed) + 1;
    lock(&scheduler.procs).insert(
        id.to_string(),
        Proc {
            pid: child.id(),
            generation,
        },
    );
    with_tasks(app, |tasks| tasks.watch_started(id, now_ms()));

    let stderr_last = Arc::new(Mutex::new(None::<String>));
    let stderr_reader = child.stderr.take().map(|stderr| {
        let last = Arc::clone(&stderr_last);
        std::thread::spawn(move || {
            for line in read_lines(stderr) {
                if !line.trim().is_empty() {
                    *lock(&last) = Some(line);
                }
            }
        })
    });
    let stdout = child.stdout.take();
    let app = app.clone();
    let id = id.to_string();
    let spawned = std::thread::Builder::new()
        .name("winku-watch".into())
        .spawn(move || {
            if let Some(stdout) = stdout {
                for line in read_lines(stdout) {
                    let scheduler = app.state::<Scheduler>();
                    lock(&scheduler.tasks).watch_line(&id, &line, now_ms());
                }
            }
            let code = child.wait().ok().and_then(|s| s.code()).unwrap_or(-1);
            if let Some(reader) = stderr_reader {
                let _ = reader.join();
            }
            let scheduler = app.state::<Scheduler>();
            let ours = {
                let mut procs = lock(&scheduler.procs);
                let ours = procs.get(&id).is_some_and(|p| p.generation == generation);
                if ours {
                    procs.remove(&id);
                }
                ours
            };
            // Killed by the scheduler (cancel, expiry, restart): nothing to report.
            if ours {
                let last = lock(&stderr_last).clone();
                with_tasks(&app, |tasks| {
                    tasks.watch_exited(&id, code, last.as_deref(), now_ms())
                });
            }
        });
    if let Err(e) = spawned {
        eprintln!("winku: watch thread failed: {e}");
    }
}

/// Lines of a pipe, decoded leniently (console output isn't always UTF-8).
fn read_lines(pipe: impl std::io::Read) -> impl Iterator<Item = String> {
    let mut reader = BufReader::new(pipe);
    std::iter::from_fn(move || {
        let mut bytes = Vec::new();
        match reader.read_until(b'\n', &mut bytes) {
            Ok(0) | Err(_) => None,
            Ok(_) => Some(String::from_utf8_lossy(&bytes).trim_end().to_string()),
        }
    })
}

fn stop_watch(app: &AppHandle, id: &str) {
    let proc = lock(&app.state::<Scheduler>().procs).remove(id);
    if let Some(proc) = proc {
        kill_tree(proc.pid);
    }
}

/// Kills a watch command and everything it started.
fn kill_tree(pid: u32) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let _ = Command::new("taskkill")
            .args(["/T", "/F", "/PID", &pid.to_string()])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .status();
    }
    #[cfg(unix)]
    {
        // The command leads its own process group (see `start_watch`).
        let _ = Command::new("kill")
            .args(["-KILL", "--", &format!("-{pid}")])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ready() -> Activity {
        let activity = Activity::default();
        activity.incoming(&json!({ "type": "ready" }));
        activity
    }

    #[test]
    fn idle_needs_the_engine_ready() {
        let activity = Activity::default();
        assert!(!activity.idle());
        activity.incoming(&json!({ "type": "ready", "provider": "x" }));
        assert!(activity.idle());
        activity.engine_stopped();
        assert!(!activity.idle());
    }

    #[test]
    fn prompts_and_actions_are_busy_until_they_end() {
        let activity = ready();
        activity.outgoing(&json!({ "type": "prompt", "id": "p1", "text": "hi" }));
        activity.outgoing(&json!({ "type": "run_action", "id": "action-1" }));
        assert!(!activity.idle());
        activity
            .incoming(&json!({ "type": "reply_end", "id": "p1", "text": "", "aborted": false }));
        assert!(!activity.idle());
        activity.incoming(&json!({ "type": "action_end", "id": "action-1" }));
        assert!(activity.idle());
        activity.outgoing(&json!({ "type": "prompt", "id": "p2", "text": "hi" }));
        activity.forget("p2");
        assert!(activity.idle());
        activity.outgoing(&json!({ "type": "set_thinking", "id": "shell-1" }));
        assert!(activity.idle());
    }

    #[test]
    fn permission_asks_are_busy_until_answered() {
        let activity = ready();
        let ask = |id: &str| json!({ "type": "request", "id": id, "method": "permission", "params": { "replyId": "task-1", "tool": "bash" } });
        activity.incoming(&ask("r1"));
        assert!(!activity.idle());
        assert!(activity.waiting_on("task-1"));
        assert!(!activity.waiting_on("p1"));
        activity.outgoing(&json!({ "type": "response", "id": "r1", "ok": true }));
        assert!(activity.idle());
        // The reply ending (abort denies the ask) clears it too.
        activity.incoming(&ask("r2"));
        activity.incoming(&json!({ "type": "reply_end", "id": "task-1" }));
        assert!(activity.idle());
        activity.incoming(&ask("r3"));
        activity.outgoing(&json!({ "type": "abort" }));
        assert!(activity.idle());
        // Other Requests don't count.
        activity.incoming(&json!({ "type": "request", "id": "r4", "method": "screen_capture" }));
        assert!(activity.idle());
    }

    #[test]
    fn talking_and_drafts_are_busy() {
        let activity = ready();
        activity.set_talking(true);
        assert!(!activity.idle());
        activity.set_talking(false);
        activity.set_draft(true);
        assert!(!activity.idle());
        activity.set_draft(false);
        assert!(activity.idle());
    }

    #[test]
    fn watch_commands_use_the_chosen_shell() {
        let mut job = tasks::Job {
            id: "00000001".into(),
            name: "w".into(),
            kind: Kind::Watch,
            prompt: "p".into(),
            self_paced: false,
            every_ms: None,
            command: Some("echo hi".into()),
            description: None,
            shell: Some(tasks::WatchShell {
                kind: "bash".into(),
                path: Some("/usr/bin/bash".into()),
            }),
            created_at: 0,
            expires_at: None,
            next_run_at: None,
            runs: 0,
            failures: 0,
            spoken: false,
            fallback_used: false,
        };
        let command = watch_command(&job);
        assert_eq!(command.get_program(), "/usr/bin/bash");
        let args: Vec<_> = command.get_args().collect();
        assert_eq!(args, ["-c", "echo hi"]);
        job.shell = Some(tasks::WatchShell {
            kind: "powershell".into(),
            path: None,
        });
        let command = watch_command(&job);
        assert_eq!(command.get_program(), "powershell.exe");
        let args: Vec<_> = command.get_args().collect();
        assert_eq!(
            args,
            ["-NoProfile", "-NonInteractive", "-Command", "echo hi"]
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_fake_watch_command_prints_lines_and_its_tree_is_killed() {
        use std::os::unix::process::CommandExt;
        let job = |script: &str| tasks::Job {
            command: Some(script.into()),
            shell: Some(tasks::WatchShell {
                kind: "bash".into(),
                path: None,
            }),
            ..tasks::Job {
                id: "00000001".into(),
                name: "w".into(),
                kind: Kind::Watch,
                prompt: "p".into(),
                self_paced: false,
                every_ms: None,
                command: None,
                description: None,
                shell: None,
                created_at: 0,
                expires_at: None,
                next_run_at: None,
                runs: 0,
                failures: 0,
                spoken: false,
                fallback_used: false,
            }
        };
        let mut child = watch_command(&job("echo one; echo; echo two"))
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let lines: Vec<_> = read_lines(child.stdout.take().unwrap()).collect();
        assert_eq!(lines, ["one", "", "two"]);
        assert_eq!(child.wait().unwrap().code(), Some(0));

        // A shell with a child of its own: killing the group ends both.
        let mut child = watch_command(&job("sleep 30 & wait"))
            .stdout(Stdio::piped())
            .process_group(0)
            .spawn()
            .unwrap();
        let stdout = child.stdout.take().unwrap();
        kill_tree(child.id());
        assert_eq!(
            read_lines(stdout).count(),
            0,
            "the sleep held the pipe open"
        );
        assert!(child.wait().unwrap().code().is_none());
    }

    #[test]
    fn pipes_are_read_as_lines() {
        let lines: Vec<_> = read_lines(&b"one\r\ntwo\n\xffthree"[..]).collect();
        assert_eq!(lines, ["one", "two", "\u{fffd}three"]);
    }
}
