mod engine;

use engine::Engine;
use serde_json::Value;
use tauri::{Manager, RunEvent, State};

#[tauri::command]
fn engine_send(engine: State<'_, Engine>, message: Value) -> Result<(), String> {
    engine.send(&message)
}

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let engine = Engine::spawn(app.handle())?;
            app.manage(engine);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![engine_send])
        .build(tauri::generate_context!())
        .expect("failed to build Winku")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                if let Some(engine) = app.try_state::<Engine>() {
                    engine.shutdown();
                }
            }
        });
}
