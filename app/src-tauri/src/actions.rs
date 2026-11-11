//! Action hotkeys (`Ctrl+Alt+1…5`) and ask-about-the-selection (`Ctrl+Alt+Q`), following the
//! Actions flow in docs/ARCHITECTURE.md:
//!
//! 1. Remember the foreground window, wait for the hotkey's modifiers to be released, capture
//!    the selection (UI Automation, then a simulated copy).
//! 2. Nothing selected: `ui` `action_error`. Otherwise `ui` `action_started` and `run_action`.
//! 3. replace: on `action_end` (not aborted, non-empty) focus the window again and paste.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::platform::{self, WindowHandle};
use crate::{engine, settings};

/// How long to wait for the hotkey's modifiers to be released before capturing.
const MODIFIER_TIMEOUT: Duration = Duration::from_millis(600);
const NOTHING_SELECTED: &str = "Select some text first";

/// A replace or show action waiting for its `action_end`.
#[derive(Clone, Debug, PartialEq)]
pub struct PendingAction {
    pub slot: u8,
    pub name: String,
    pub output: String,
    pub window: WindowHandle,
}

#[derive(Default)]
pub struct Actions {
    /// A capture is running; further action hotkeys are ignored until it finishes.
    capturing: AtomicBool,
    next_id: AtomicU64,
    pending: Mutex<HashMap<String, PendingAction>>,
}

impl Actions {
    fn next_id(&self) -> String {
        format!(
            "action-{}",
            self.next_id.fetch_add(1, Ordering::Relaxed) + 1
        )
    }

    /// Remembers a started action. Agent actions reply with ordinary prompt events, so there is
    /// nothing to wait for and they aren't kept.
    fn remember(&self, id: &str, action: PendingAction) {
        if action.output == "agent" {
            return;
        }
        self.lock().insert(id.to_string(), action);
    }

    fn forget(&self, id: &str) {
        self.lock().remove(id);
    }

    /// Looks at one engine record. On `action_end` for a known id, forgets it and returns what to
    /// paste (if anything).
    fn on_record(&self, record: &Value) -> Option<Paste> {
        if record["type"].as_str() != Some("action_end") {
            return None;
        }
        let id = record["id"].as_str()?;
        let pending = self.lock().remove(id)?;
        paste_decision(id, pending, record)
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, PendingAction>> {
        self.pending.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// Text to paste back into the window an action came from.
#[derive(Debug, PartialEq)]
struct Paste {
    id: String,
    action: PendingAction,
    text: String,
}

/// Paste only for replace actions that finished (not aborted) with some text.
fn paste_decision(id: &str, action: PendingAction, end: &Value) -> Option<Paste> {
    let text = end["text"].as_str().unwrap_or_default();
    if action.output != "replace" || end["aborted"].as_bool() == Some(true) || text.is_empty() {
        return None;
    }
    Some(Paste {
        id: id.to_string(),
        action,
        text: text.to_string(),
    })
}

/// What a hotkey wants once the selection is captured.
#[derive(Clone, Copy)]
enum Want {
    Action(u8),
    Ask,
}

/// Action hotkey for `slot` (1–5) pressed.
pub fn on_action_hotkey(app: &AppHandle, slot: u8) {
    start_capture(app, Want::Action(slot));
}

/// Ask-about-the-selection hotkey pressed.
pub fn on_ask_hotkey(app: &AppHandle) {
    start_capture(app, Want::Ask);
}

fn start_capture(app: &AppHandle, want: Want) {
    let actions = app.state::<Actions>();
    if actions
        .capturing
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return;
    }
    let window = platform::foreground_window();
    let app = app.clone();
    std::thread::spawn(move || {
        platform::wait_for_modifiers_released(MODIFIER_TIMEOUT);
        let selection = capture_selection();
        app.state::<Actions>()
            .capturing
            .store(false, Ordering::SeqCst);
        match want {
            Want::Ask => emit_ui(
                &app,
                json!({ "kind": "ask_selection", "text": selection.unwrap_or_default() }),
            ),
            Want::Action(slot) => run(&app, slot, window, selection),
        }
    });
}

/// UI Automation first, then a simulated copy. Whitespace-only counts as nothing.
fn capture_selection() -> Option<String> {
    platform::selection_via_uia()
        .filter(|s| !s.trim().is_empty())
        .or_else(platform::selection_via_copy)
        .filter(|s| !s.trim().is_empty())
}

fn run(app: &AppHandle, slot: u8, window: WindowHandle, selection: Option<String>) {
    let settings = app.state::<settings::Store>().get();
    let Some(action) = settings
        .actions
        .get(usize::from(slot).wrapping_sub(1))
        .cloned()
    else {
        return;
    };
    let Some(selection) = selection else {
        emit_ui(
            app,
            json!({ "kind": "action_error", "slot": slot, "name": action.name, "message": NOTHING_SELECTED }),
        );
        return;
    };
    let actions = app.state::<Actions>();
    let id = actions.next_id();
    actions.remember(
        &id,
        PendingAction {
            slot,
            name: action.name.clone(),
            output: action.output.clone(),
            window,
        },
    );
    // Started goes out before run_action so it reaches the UI before any action_delta.
    emit_ui(
        app,
        json!({ "kind": "action_started", "id": id, "slot": slot, "name": action.name, "output": action.output }),
    );
    let command =
        json!({ "type": "run_action", "id": id, "action": action, "selection": selection });
    if let Err(message) = app.state::<engine::Engine>().send(&command) {
        actions.forget(&id);
        emit_ui(
            app,
            json!({ "kind": "action_error", "id": id, "slot": slot, "name": action.name, "message": message }),
        );
    }
}

/// Called by the engine reader for every forwarded record. Pastes finished replace actions on
/// a separate thread so the reader keeps going.
pub fn on_engine_record(app: &AppHandle, record: &Value) {
    let Some(paste) = app.state::<Actions>().on_record(record) else {
        return;
    };
    let app = app.clone();
    std::thread::spawn(move || {
        platform::focus_window(paste.action.window);
        if let Err(message) = platform::paste_text(&paste.text) {
            emit_ui(
                &app,
                json!({
                    "kind": "action_error",
                    "id": paste.id,
                    "slot": paste.action.slot,
                    "name": paste.action.name,
                    "message": message,
                }),
            );
        }
    });
}

fn emit_ui(app: &AppHandle, payload: Value) {
    let _ = app.emit_to(crate::window::MAIN, "ui", &payload);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pending(output: &str) -> PendingAction {
        PendingAction {
            slot: 1,
            name: "Rewrite".into(),
            output: output.into(),
            window: WindowHandle(42),
        }
    }

    fn end(id: &str, text: &str, aborted: bool) -> Value {
        json!({ "type": "action_end", "id": id, "text": text, "output": "replace", "aborted": aborted })
    }

    #[test]
    fn ids_count_up() {
        let actions = Actions::default();
        assert_eq!(actions.next_id(), "action-1");
        assert_eq!(actions.next_id(), "action-2");
    }

    #[test]
    fn finished_replace_is_pasted_once() {
        let actions = Actions::default();
        actions.remember("action-1", pending("replace"));
        let paste = actions
            .on_record(&end("action-1", "better", false))
            .unwrap();
        assert_eq!(paste.text, "better");
        assert_eq!(paste.action.window, WindowHandle(42));
        assert_eq!(actions.on_record(&end("action-1", "better", false)), None);
    }

    #[test]
    fn aborted_empty_and_show_are_not_pasted_but_forgotten() {
        let actions = Actions::default();
        actions.remember("a", pending("replace"));
        actions.remember("b", pending("replace"));
        actions.remember("c", pending("show"));
        assert_eq!(actions.on_record(&end("a", "x", true)), None);
        assert_eq!(actions.on_record(&end("b", "", false)), None);
        assert_eq!(actions.on_record(&end("c", "x", false)), None);
        assert!(actions.lock().is_empty());
    }

    #[test]
    fn agent_actions_are_not_kept_and_other_records_are_ignored() {
        let actions = Actions::default();
        actions.remember("a", pending("agent"));
        assert!(actions.lock().is_empty());
        actions.remember("b", pending("replace"));
        assert_eq!(
            actions.on_record(&json!({ "type": "action_delta", "id": "b", "delta": "x" })),
            None
        );
        assert_eq!(actions.on_record(&end("unknown", "x", false)), None);
        assert_eq!(actions.lock().len(), 1);
    }
}
