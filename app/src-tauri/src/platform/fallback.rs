//! Non-Windows stand-ins.

/// Whether the left mouse button is held (used to wait for a pill drag to finish).
pub fn mouse_button_down() -> bool {
    false
}

/// Keys (uppercase ASCII letters and digits) that type a character with `Ctrl+Alt` held in the
/// current keyboard layout, i.e. the layout treats `Ctrl+Alt` as AltGr. None when unknown.
pub fn altgr_keys() -> Option<Vec<char>> {
    None
}

use super::WindowHandle;
use std::time::Duration;

pub fn foreground_window() -> WindowHandle {
    WindowHandle(0)
}

pub fn focus_window(_window: WindowHandle) -> bool {
    false
}

pub fn wait_for_modifiers_released(_timeout: Duration) {}

pub fn selection_via_uia() -> Option<String> {
    None
}

pub fn selection_via_copy() -> Option<String> {
    None
}

pub fn paste_text(_text: &str) -> Result<(), String> {
    Err("pasting is only supported on Windows".into())
}
