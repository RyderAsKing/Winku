mod actions;
mod commands;
mod engine;
mod hotkeys;
mod menu;
mod platform;
mod secrets;
mod settings;
mod window;

use tauri::{Manager, RunEvent, WindowEvent};

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(hotkeys::handle)
                .build(),
        )
        .setup(|app| {
            let data_dir = app.path().data_dir()?.join("winku");
            app.manage(settings::Store::open(data_dir));
            app.manage(window::WindowState::default());
            app.manage(hotkeys::HotkeyState::default());
            app.manage(engine::Engine::new());
            app.manage(actions::Actions::default());

            let handle = app.handle();
            let current = app.state::<settings::Store>().get();
            hotkeys::register_all(handle, &current);
            window::set_mode(handle, window::Mode::Pill)?;
            engine::Engine::start(handle)?;
            Ok(())
        })
        .on_menu_event(menu::on_menu_event)
        .on_window_event(|window, event| {
            if window.label() == window::MAIN {
                if let WindowEvent::Moved(_) = event {
                    window::on_moved(window.app_handle());
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::engine_send,
            commands::engine_call,
            commands::engine_respond,
            commands::settings_get,
            commands::settings_set,
            commands::secret_set,
            commands::secret_clear,
            commands::secret_present,
            commands::window_mode,
            commands::window_bar_height,
            commands::open_window,
            commands::context_menu,
            commands::hotkeys_status,
            commands::hotkeys_altgr,
            commands::open_external,
        ])
        .build(tauri::generate_context!())
        .expect("failed to build Winku")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                if let Some(engine) = app.try_state::<engine::Engine>() {
                    engine.shutdown();
                }
            }
        });
}
