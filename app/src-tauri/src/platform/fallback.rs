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

use super::{RawImage, RoundRect, WindowHandle};
use std::time::Duration;

pub fn foreground_window() -> WindowHandle {
    WindowHandle(0)
}

pub fn process_name(_window: WindowHandle) -> Option<String> {
    None
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

/// True for windows that belong to Winku itself.
pub fn is_own_window(_window: WindowHandle) -> bool {
    false
}

/// Class names of a window and of its focused child.
pub fn input_window_classes(_window: WindowHandle) -> Vec<String> {
    Vec::new()
}

pub fn window_title(_window: WindowHandle) -> Option<String> {
    None
}

/// Readable text of a window through UI Automation.
pub fn window_text(_window: WindowHandle) -> Option<String> {
    None
}

pub fn capture_window(_window: WindowHandle) -> Result<RawImage, String> {
    Err("screen capture is not supported on this platform".into())
}

/// Moves and resizes a window in one step. False: not supported here, use Tauri's calls.
pub fn set_window_rect(_window: WindowHandle, _x: i32, _y: i32, _w: i32, _h: i32) -> bool {
    false
}

/// Clips a window to the union of rects (left, top, right, bottom; window px). No-op here.
pub fn set_window_region(_window: WindowHandle, _rects: &[RoundRect]) {}
