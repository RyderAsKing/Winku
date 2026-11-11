//! The right-click menu on the eyes and the tray icon (shown only while the eyes are hidden).

use serde_json::json;
use tauri::menu::{CheckMenuItem, Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager};

use crate::commands::apply_settings;
use crate::settings;
use crate::window::{self, Page};

const TRAY_ID: &str = "winku";

/// Shows the native menu at the cursor, over the main window.
pub fn show_context_menu(app: &AppHandle) -> Result<(), String> {
    let s = app.state::<settings::Store>().get();
    let build = || -> tauri::Result<Menu<tauri::Wry>> {
        Menu::with_items(
            app,
            &[
                &MenuItem::with_id(app, "settings", "Settings", true, None::<&str>)?,
                &MenuItem::with_id(app, "history", "History", true, None::<&str>)?,
                &PredefinedMenuItem::separator(app)?,
                &CheckMenuItem::with_id(
                    app,
                    "ask_before_running",
                    "Ask before running",
                    true,
                    s.ask_before_running,
                    None::<&str>,
                )?,
                &MenuItem::with_id(app, "hide_eyes", "Hide eyes", true, None::<&str>)?,
                &CheckMenuItem::with_id(
                    app,
                    "pause_listening",
                    "Pause listening",
                    true,
                    s.voice.listening_paused,
                    None::<&str>,
                )?,
                &PredefinedMenuItem::separator(app)?,
                &MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?,
            ],
        )
    };
    let menu = build().map_err(|e| e.to_string())?;
    let window = app
        .get_webview_window(window::MAIN)
        .ok_or("main window is missing")?;
    window.popup_menu(&menu).map_err(|e| e.to_string())
}

/// App-wide menu event handler (context menu items).
pub fn on_menu_event(app: &AppHandle, event: MenuEvent) {
    let item = event.id().as_ref().to_string();
    let toggle =
        |change: fn(&mut settings::Settings)| match app.state::<settings::Store>().update(change) {
            Ok((old, new)) => apply_settings(app, &old, &new),
            Err(e) => eprintln!("winku: {e}"),
        };
    match item.as_str() {
        "settings" => {
            let _ = window::open_page(app, Page::Settings);
            return;
        }
        "history" => {
            let _ = window::open_page(app, Page::History);
            return;
        }
        "ask_before_running" => toggle(|s| s.ask_before_running = !s.ask_before_running),
        "hide_eyes" => toggle(|s| s.eyes.hidden = true),
        "pause_listening" => toggle(|s| s.voice.listening_paused = !s.voice.listening_paused),
        "quit" => {}
        _ => return,
    }
    let _ = app.emit_to(window::MAIN, "ui", &json!({ "kind": "menu", "item": item }));
    if item == "quit" {
        app.exit(0);
    }
}

/// Adds or removes the tray icon. Clicking it shows the eyes again.
pub fn set_tray_visible(app: &AppHandle, visible: bool) {
    if !visible {
        let _ = app.remove_tray_by_id(TRAY_ID);
        return;
    }
    if app.tray_by_id(TRAY_ID).is_some() {
        return;
    }
    let mut builder = TrayIconBuilder::with_id(TRAY_ID).tooltip("Winku: click to show the eyes");
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    let built = builder
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                match app
                    .state::<settings::Store>()
                    .update(|s| s.eyes.hidden = false)
                {
                    Ok((old, new)) => apply_settings(app, &old, &new),
                    Err(e) => eprintln!("winku: {e}"),
                }
            }
        })
        .build(app);
    if let Err(e) = built {
        eprintln!("winku: tray icon failed: {e}");
    }
}
