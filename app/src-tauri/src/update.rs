//! Self-update (docs/ARCHITECTURE.md "Shipping"): `settings.updates` auto / notify / off, checked
//! 30 s after start and every 6 hours. `auto` downloads in the background and installs when
//! Winku quits from its menu or on "Restart to update"; `notify` only reports. Network errors stay
//! quiet: state `error` with a short message, never a dialog.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::settings;
use crate::window;

pub const FIRST_CHECK: Duration = Duration::from_secs(30);
pub const CHECK_EVERY: Duration = Duration::from_secs(6 * 60 * 60);
const STATUS_EVENT: &str = "update_status";

#[derive(Serialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum State {
    #[default]
    Idle,
    Checking,
    Available,
    Downloading,
    Ready,
    Error,
}

#[derive(Serialize, Clone, Debug, Default, PartialEq, Eq)]
pub struct UpdateStatus {
    pub state: State,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Policy {
    Auto,
    Notify,
    Off,
}

impl Policy {
    pub fn parse(value: &str) -> Self {
        match value {
            "notify" => Policy::Notify,
            "off" => Policy::Off,
            _ => Policy::Auto,
        }
    }
}

/// Whether the background schedule may check at all. Debug builds never check on their own.
pub fn scheduled_checks(policy: Policy, debug_build: bool) -> bool {
    !debug_build && policy != Policy::Off
}

/// How long the scheduler sleeps before its next check: 30 s after start, then every 6 hours.
pub fn next_check_in(started: Instant, last_check: Option<Instant>, now: Instant) -> Duration {
    let due = match last_check {
        None => started + FIRST_CHECK,
        Some(last) => last + CHECK_EVERY,
    };
    due.saturating_duration_since(now)
}

/// What to do after a check found `version` (or nothing).
#[derive(Debug, PartialEq, Eq)]
pub enum Next {
    Nothing,
    /// `auto`, or a manual check in `auto` mode: download in the background.
    Download,
    /// `notify`/`off`: report it (the dot and the menu item) without downloading.
    Announce,
}

pub fn after_check(
    found: Option<(String, Option<String>)>,
    policy: Policy,
) -> (UpdateStatus, Next) {
    match found {
        None => (UpdateStatus::default(), Next::Nothing),
        Some((version, notes)) => (
            UpdateStatus {
                state: State::Available,
                version: Some(version),
                notes,
                error: None,
            },
            if policy == Policy::Auto {
                Next::Download
            } else {
                Next::Announce
            },
        ),
    }
}

pub fn with_state(status: &UpdateStatus, state: State) -> UpdateStatus {
    UpdateStatus {
        state,
        error: None,
        ..status.clone()
    }
}

pub fn failed(status: &UpdateStatus, message: &str) -> UpdateStatus {
    let mut short: String = message
        .lines()
        .next()
        .unwrap_or("")
        .chars()
        .take(120)
        .collect();
    if short.is_empty() {
        short = "update failed".into();
    }
    UpdateStatus {
        state: State::Error,
        error: Some(short),
        ..status.clone()
    }
}

/// The right-click menu item, shown while an update is downloaded or available.
pub fn menu_label(status: &UpdateStatus) -> Option<String> {
    match (status.state, &status.version) {
        (State::Ready | State::Available, Some(v)) => Some(format!(
            "Restart to update to v{}",
            v.trim_start_matches('v')
        )),
        _ => None,
    }
}

#[derive(Default)]
pub struct Updates {
    status: Mutex<UpdateStatus>,
    update: Mutex<Option<Update>>,
    bytes: Mutex<Option<Vec<u8>>>,
    /// One check or download at a time.
    busy: tokio::sync::Mutex<()>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

impl Updates {
    pub fn status(&self) -> UpdateStatus {
        lock(&self.status).clone()
    }
}

fn set_status(app: &AppHandle, status: UpdateStatus) {
    let updates = app.state::<Updates>();
    {
        let mut current = lock(&updates.status);
        if *current == status {
            return;
        }
        *current = status.clone();
    }
    let _ = app.emit(STATUS_EVENT, &status);
    let announce = status.state == State::Ready
        || (status.state == State::Available && policy(app) != Policy::Auto);
    if announce {
        if let Some(version) = &status.version {
            let _ = app.emit_to(
                window::MAIN,
                "ui",
                &json!({ "kind": "update_ready", "version": version }),
            );
        }
    }
}

fn policy(app: &AppHandle) -> Policy {
    Policy::parse(&app.state::<settings::Store>().get().updates)
}

fn updater(app: &AppHandle) -> Result<tauri_plugin_updater::Updater, String> {
    let handle = app.clone();
    app.updater_builder()
        .on_before_exit(move || {
            if let Some(engine) = handle.try_state::<crate::engine::Engine>() {
                engine.shutdown();
            }
        })
        .build()
        .map_err(|e| e.to_string())
}

/// Checks now; in `auto` mode a found update starts downloading.
pub async fn check(app: &AppHandle) -> UpdateStatus {
    {
        let updates = app.state::<Updates>();
        let _busy = updates.busy.lock().await;
        let current = app.state::<Updates>().status();
        if current.state == State::Ready {
            return current;
        }
        set_status(app, with_state(&current, State::Checking));
        let result = match updater(app) {
            Ok(u) => u.check().await.map_err(|e| e.to_string()),
            Err(e) => Err(e),
        };
        match result {
            Err(e) => set_status(app, failed(&current, &e)),
            Ok(found) => {
                let summary = found.as_ref().map(|u| (u.version.clone(), u.body.clone()));
                *lock(&app.state::<Updates>().update) = found;
                let (status, _) = after_check(summary, policy(app));
                set_status(app, status);
            }
        }
    }
    if policy(app) == Policy::Auto {
        download(app).await;
    }
    app.state::<Updates>().status()
}

/// Downloads the known update (if any and not yet downloaded). Verification happens on install.
async fn download(app: &AppHandle) {
    let updates = app.state::<Updates>();
    let _busy = updates.busy.lock().await;
    if lock(&updates.bytes).is_some() {
        return;
    }
    let Some(update) = lock(&updates.update).clone() else {
        return;
    };
    let current = updates.status();
    set_status(app, with_state(&current, State::Downloading));
    match update.download(|_, _| {}, || {}).await {
        Ok(bytes) => {
            *lock(&updates.bytes) = Some(bytes);
            set_status(app, with_state(&current, State::Ready));
        }
        Err(e) => set_status(app, failed(&current, &e.to_string())),
    }
}

/// `update_restart`: download if needed, install and relaunch.
pub async fn restart(app: &AppHandle) -> Result<(), String> {
    if lock(&app.state::<Updates>().update).is_none() {
        let _ = check(app).await;
    }
    download(app).await;
    install(app)?;
    app.restart();
}

/// Installs a downloaded update, if any. On Windows this runs the installer and exits.
fn install(app: &AppHandle) -> Result<(), String> {
    let updates = app.state::<Updates>();
    let Some(update) = lock(&updates.update).clone() else {
        return Ok(());
    };
    let Some(bytes) = lock(&updates.bytes).take() else {
        return Ok(());
    };
    if let Some(engine) = app.try_state::<crate::engine::Engine>() {
        engine.shutdown();
    }
    update.install(bytes).map_err(|e| {
        let message = e.to_string();
        set_status(app, failed(&updates.status(), &message));
        message
    })
}

/// Quit from the menu: install a downloaded update (auto mode) on the way out.
pub fn install_on_quit(app: &AppHandle) {
    if app.state::<Updates>().status().state == State::Ready {
        if let Err(e) = install(app) {
            eprintln!("winku: update install failed: {e}");
        }
    }
}

/// Settings changed to `auto` while an update was only announced: start downloading it.
pub fn on_policy_changed(app: &AppHandle) {
    if policy(app) == Policy::Auto && app.state::<Updates>().status().state == State::Available {
        let app = app.clone();
        tauri::async_runtime::spawn(async move { download(&app).await });
    }
}

/// The background schedule. It sleeps between checks; nothing runs in between.
pub fn start(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let started = Instant::now();
        let mut last = None;
        loop {
            tokio::time::sleep(next_check_in(started, last, Instant::now())).await;
            last = Some(Instant::now());
            if scheduled_checks(policy(&app), cfg!(debug_assertions)) {
                check(&app).await;
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schedule_is_30s_then_6h() {
        let t0 = Instant::now();
        assert_eq!(next_check_in(t0, None, t0), FIRST_CHECK);
        assert_eq!(
            next_check_in(t0, None, t0 + Duration::from_secs(10)),
            Duration::from_secs(20)
        );
        assert_eq!(
            next_check_in(t0, None, t0 + Duration::from_secs(99)),
            Duration::ZERO
        );
        let last = t0 + FIRST_CHECK;
        assert_eq!(next_check_in(t0, Some(last), last), CHECK_EVERY);
        assert_eq!(
            next_check_in(t0, Some(last), last + Duration::from_secs(3600)),
            CHECK_EVERY - Duration::from_secs(3600)
        );
    }

    #[test]
    fn policies() {
        assert_eq!(Policy::parse("auto"), Policy::Auto);
        assert_eq!(Policy::parse("notify"), Policy::Notify);
        assert_eq!(Policy::parse("off"), Policy::Off);
        assert_eq!(Policy::parse("weird"), Policy::Auto);
        assert!(scheduled_checks(Policy::Auto, false));
        assert!(scheduled_checks(Policy::Notify, false));
        assert!(!scheduled_checks(Policy::Off, false));
        assert!(!scheduled_checks(Policy::Auto, true));
    }

    #[test]
    fn check_outcomes() {
        let found = || Some(("0.2.0".to_string(), Some("notes".to_string())));
        let (s, next) = after_check(found(), Policy::Auto);
        assert_eq!(s.state, State::Available);
        assert_eq!(s.version.as_deref(), Some("0.2.0"));
        assert_eq!(next, Next::Download);
        assert_eq!(after_check(found(), Policy::Notify).1, Next::Announce);
        assert_eq!(after_check(found(), Policy::Off).1, Next::Announce);
        assert_eq!(
            after_check(None, Policy::Auto),
            (UpdateStatus::default(), Next::Nothing)
        );
    }

    #[test]
    fn transitions_keep_version_and_shorten_errors() {
        let (available, _) = after_check(Some(("1.0.0".into(), None)), Policy::Auto);
        let downloading = with_state(&available, State::Downloading);
        assert_eq!(downloading.version.as_deref(), Some("1.0.0"));
        let err = failed(&downloading, &format!("{}\nsecond line", "x".repeat(300)));
        assert_eq!(err.state, State::Error);
        assert_eq!(err.error.as_ref().unwrap().len(), 120);
        assert_eq!(with_state(&err, State::Checking).error, None);
        assert_eq!(
            failed(&UpdateStatus::default(), "").error.as_deref(),
            Some("update failed")
        );
    }

    #[test]
    fn status_json() {
        let s = UpdateStatus {
            state: State::Ready,
            version: Some("1.2.3".into()),
            ..Default::default()
        };
        assert_eq!(
            serde_json::to_value(&s).unwrap(),
            json!({ "state": "ready", "version": "1.2.3" })
        );
    }

    #[test]
    fn menu_labels() {
        let mut s = UpdateStatus {
            state: State::Ready,
            version: Some("0.3.0".into()),
            ..Default::default()
        };
        assert_eq!(
            menu_label(&s).as_deref(),
            Some("Restart to update to v0.3.0")
        );
        s.state = State::Available;
        s.version = Some("v0.3.0".into());
        assert_eq!(
            menu_label(&s).as_deref(),
            Some("Restart to update to v0.3.0")
        );
        for state in [
            State::Idle,
            State::Checking,
            State::Downloading,
            State::Error,
        ] {
            s.state = state;
            assert_eq!(menu_label(&s), None);
        }
    }
}
