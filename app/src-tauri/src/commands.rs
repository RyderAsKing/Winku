//! `#[tauri::command]` functions: the shell side of the Shell ↔ UI contract in
//! docs/ARCHITECTURE.md (`app/ui/src/lib/shell.ts` is the TypeScript side).

use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::capture::{self, ImageAttachment, NowLine, NowState};

use crate::engine::{self, Engine};
use crate::hotkeys::{self, AltGrReport, HotkeyState, Status};
use crate::secrets::{self, Account};
use crate::settings::{self, Settings, Store};
use crate::window::{self, Mode, Page};

pub const SETTINGS_CHANGED: &str = "settings_changed";

/// Side effects of a settings change, wherever it came from (Settings window, menu, tray, drag).
pub fn apply_settings(app: &AppHandle, old: &Settings, new: &Settings) {
    if settings::hotkeys_changed(old, new) {
        hotkeys::register_all(app, new);
    }
    if settings::engine_relevant_changed(old, new) {
        engine::configure(app);
    }
    if old.launch_at_login != new.launch_at_login {
        apply_launch_at_login(app, new.launch_at_login);
    }
    if old.updates != new.updates {
        crate::update::on_policy_changed(app);
    }
    if old.eyes.hidden != new.eyes.hidden {
        window::apply_eyes_visibility(app);
    }
    if old.eyes.size != new.eyes.size {
        window::on_size_changed(app);
    }
    let _ = app.emit(SETTINGS_CHANGED, new);
}

/// Registers or removes Winku from launch at login. Release builds only: dev runs never
/// register themselves.
pub fn apply_launch_at_login(app: &AppHandle, enabled: bool) {
    #[cfg(not(debug_assertions))]
    {
        use tauri_plugin_autostart::ManagerExt;
        let autolaunch = app.autolaunch();
        let result = match (enabled, autolaunch.is_enabled().unwrap_or(false)) {
            (true, false) => autolaunch.enable(),
            (false, true) => autolaunch.disable(),
            _ => Ok(()),
        };
        if let Err(e) = result {
            eprintln!("winku: launch at login: {e}");
        }
    }
    #[cfg(debug_assertions)]
    let _ = (app, enabled);
}

#[tauri::command]
pub fn update_status(updates: State<'_, crate::update::Updates>) -> crate::update::UpdateStatus {
    updates.status()
}

#[tauri::command]
pub async fn update_check(app: AppHandle) -> crate::update::UpdateStatus {
    crate::update::check(&app).await
}

#[tauri::command]
pub async fn update_restart(app: AppHandle) -> Result<(), String> {
    crate::update::restart(&app).await
}

#[tauri::command]
pub fn engine_send(engine: State<'_, Engine>, message: Value) -> Result<(), String> {
    engine.send(&message)
}

#[tauri::command]
pub async fn engine_call(engine: State<'_, Engine>, message: Value) -> Result<Value, String> {
    engine.call(message).await
}

/// Answers a `permission` Request (step 6; the plumbing is trivial so it's here already).
#[tauri::command]
pub fn engine_respond(engine: State<'_, Engine>, mut response: Value) -> Result<(), String> {
    response["type"] = Value::String("response".into());
    engine.send(&response)
}

#[tauri::command]
pub fn settings_get(store: State<'_, Store>) -> Settings {
    store.get()
}

#[tauri::command]
pub fn settings_set(
    app: AppHandle,
    store: State<'_, Store>,
    settings: Settings,
) -> Result<Settings, String> {
    let (old, new) = store.replace(settings)?;
    apply_settings(&app, &old, &new);
    Ok(new)
}

#[tauri::command]
pub async fn secret_set(
    app: AppHandle,
    api_key: String,
    account: Option<String>,
) -> Result<(), String> {
    secrets::set(Account::parse(account.as_deref())?, api_key.trim())?;
    engine::configure(&app);
    Ok(())
}

#[tauri::command]
pub async fn secret_clear(app: AppHandle, account: Option<String>) -> Result<(), String> {
    secrets::clear(Account::parse(account.as_deref())?)?;
    engine::configure(&app);
    Ok(())
}

#[tauri::command]
pub async fn secret_present(account: Option<String>) -> Result<bool, String> {
    Ok(secrets::present(Account::parse(account.as_deref())?))
}

/// The now line noted when the bar was summoned (waits briefly for its selection).
#[tauri::command]
pub async fn now_line(app: AppHandle) -> NowLine {
    tauri::async_runtime::spawn_blocking(move || app.state::<NowState>().now_line())
        .await
        .unwrap_or_default()
}

/// A screenshot of the window that was in front before the bar.
#[tauri::command]
pub async fn screenshot(app: AppHandle) -> Result<ImageAttachment, String> {
    tauri::async_runtime::spawn_blocking(move || capture::screenshot(&app))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn window_mode(app: AppHandle, mode: Mode) -> Result<(), String> {
    window::set_mode(&app, mode)
}

/// The UI's stage size and the shapes it draws, logical px; returns which way things grow.
#[tauri::command]
pub fn window_shape(
    app: AppHandle,
    width: f64,
    height: f64,
    shapes: Vec<window::Shape>,
) -> Result<window::Layout, String> {
    window::set_shape(&app, (width, height), &shapes)
}

#[tauri::command]
pub fn window_layout(app: AppHandle) -> Option<window::Layout> {
    window::layout(&app)
}

/// Async: creating a window from a synchronous command deadlocks on Windows.
#[tauri::command]
pub async fn open_window(app: AppHandle, name: Page) -> Result<(), String> {
    window::open_page(&app, name)
}

#[tauri::command]
pub fn context_menu(app: AppHandle) -> Result<(), String> {
    crate::menu::show_context_menu(&app)
}

/// Bindings that failed to register (taken by another app, unreadable, duplicated).
#[tauri::command]
pub fn hotkeys_status(state: State<'_, HotkeyState>) -> Status {
    state.status()
}

/// Whether the keyboard layout treats Ctrl+Alt as AltGr, and which bindings that breaks.
#[tauri::command]
pub fn hotkeys_altgr(store: State<'_, Store>) -> AltGrReport {
    hotkeys::altgr_report(&store.get())
}

/// Opens About me in the default editor, or the memory or voice folder (SPEC §9: plain
/// markdown, editable anywhere). Creates the file or folder first if it doesn't exist yet.
#[tauri::command]
pub fn open_data_path(app: AppHandle, store: State<'_, Store>, what: String) -> Result<(), String> {
    let path = match what.as_str() {
        "about_me" => {
            let file = store.data_dir.join("about-me.md");
            if !file.exists() {
                std::fs::create_dir_all(&store.data_dir).map_err(|e| e.to_string())?;
                std::fs::write(&file, "").map_err(|e| e.to_string())?;
            }
            file
        }
        "memory" | "voice" => {
            let dir = store.data_dir.join(&what);
            std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            dir
        }
        other => return Err(format!("unknown data path {other:?}")),
    };
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_path(path.to_string_lossy(), None::<&str>)
        .map_err(|e| e.to_string())
}

/// Speaks `text` (plain sentences: a reply's <say> block, or its markdown stripped by the UI),
/// replacing anything already playing, or after it with `append`.
#[tauri::command]
pub fn speak(app: AppHandle, text: String, append: Option<bool>) {
    crate::voice::speak(&app, text, append.unwrap_or(false));
}

#[tauri::command]
pub fn stop_speaking(app: AppHandle) {
    crate::voice::stop_speaking(&app);
}

/// The OS voices (Windows OneCore); empty elsewhere. Async: WinRT enumeration can take a moment.
#[tauri::command]
pub async fn voice_os_voices() -> Vec<crate::voice::tts::OsVoice> {
    tauri::async_runtime::spawn_blocking(crate::voice::os_voices)
        .await
        .unwrap_or_default()
}

#[tauri::command]
pub fn voice_models(app: AppHandle) -> Vec<crate::voice::ModelInfo> {
    crate::voice::model_list(&app)
}

/// Starts a download and returns at once; progress arrives as `download_progress`.
#[tauri::command]
pub fn voice_model_download(app: AppHandle, id: String) -> Result<(), String> {
    crate::voice::download_model(&app, &id)
}

/// Async and off the runtime threads: it may wait for a transcription or speech to finish.
#[tauri::command]
pub async fn voice_model_remove(app: AppHandle, id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || crate::voice::remove_model(&app, &id))
        .await
        .map_err(|e| e.to_string())?
}

/// Opens a link from a reply in the default browser. Only http(s): a model-written link must not
/// launch a local file or another URL scheme handler.
#[tauri::command]
pub fn open_external(app: AppHandle, url: String) -> Result<(), String> {
    if !is_web_url(&url) {
        return Err("only http and https links can be opened".into());
    }
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| e.to_string())
}

fn is_web_url(url: &str) -> bool {
    let lower = url.trim_start().to_ascii_lowercase();
    (lower.starts_with("https://") || lower.starts_with("http://"))
        && !url.chars().any(char::is_control)
}

#[cfg(test)]
mod tests {
    use super::is_web_url;

    #[test]
    fn only_web_urls_open() {
        assert!(is_web_url("https://example.com/a?b=c"));
        assert!(is_web_url("HTTP://example.com"));
        assert!(!is_web_url("file:///C:/Windows/System32/calc.exe"));
        assert!(!is_web_url("ms-settings:privacy"));
        assert!(!is_web_url("javascript:alert(1)"));
        assert!(!is_web_url("https://example.com/\nfoo"));
        assert!(!is_web_url("https://example.com/\u{0}"));
    }
}
