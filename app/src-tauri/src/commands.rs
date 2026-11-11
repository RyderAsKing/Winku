//! `#[tauri::command]` functions: the shell side of the Shell ↔ UI contract in
//! docs/ARCHITECTURE.md (`app/ui/src/lib/shell.ts` is the TypeScript side).

use serde_json::Value;
use tauri::{AppHandle, Emitter, State};

use crate::engine::{self, Engine};
use crate::hotkeys::{self, AltGrReport, HotkeyState, Status};
use crate::secrets;
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
    if old.eyes.hidden != new.eyes.hidden {
        window::apply_eyes_visibility(app);
    }
    let _ = app.emit(SETTINGS_CHANGED, new);
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
pub async fn secret_set(app: AppHandle, api_key: String) -> Result<(), String> {
    secrets::set(api_key.trim())?;
    engine::configure(&app);
    Ok(())
}

#[tauri::command]
pub async fn secret_clear(app: AppHandle) -> Result<(), String> {
    secrets::clear()?;
    engine::configure(&app);
    Ok(())
}

#[tauri::command]
pub async fn secret_present() -> bool {
    secrets::present()
}

#[tauri::command]
pub fn window_mode(app: AppHandle, mode: Mode) -> Result<(), String> {
    window::set_mode(&app, mode)
}

#[tauri::command]
pub fn window_bar_height(app: AppHandle, height: f64) -> Result<(), String> {
    window::set_bar_height(&app, height)
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
