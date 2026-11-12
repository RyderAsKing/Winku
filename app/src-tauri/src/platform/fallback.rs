//! Non-Windows stand-ins.

/// Whether the primary mouse button is held (used to wait for a pill drag to finish).
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

/// Moves a window without resizing it. Not supported here.
pub fn move_window(_window: WindowHandle, _x: i32, _y: i32) -> bool {
    false
}

/// A window's rectangle on screen (x, y, width, height). Unknown here.
pub fn window_rect(_window: WindowHandle) -> Option<(i32, i32, i32, i32)> {
    None
}

/// The pointer on screen. Unknown here.
pub fn cursor_position() -> Option<(i32, i32)> {
    None
}

/// Waits about one frame.
pub fn wait_frame() {
    std::thread::sleep(Duration::from_millis(8));
}

pub fn animations_enabled() -> bool {
    true
}

/// Clips a window to the union of rects (left, top, right, bottom; window px). No-op here.
pub fn set_window_region(_window: WindowHandle, _rects: &[RoundRect]) {}

const NO_CLIPBOARD: &str = "The clipboard isn't available on this system.";

/// What is on the clipboard (the clipboard_read tool). Windows only.
pub fn clipboard_read() -> Result<crate::clipboard::Raw, String> {
    Err(NO_CLIPBOARD.into())
}

/// Replaces the clipboard with text (the clipboard_write tool). Windows only.
pub fn clipboard_write(_text: &str) -> Result<(), String> {
    Err(NO_CLIPBOARD.into())
}

/// Starts the clipboard history listener. Windows only.
pub fn watch_clipboard() {}

/// Kind and size of what is on the clipboard, for the now line. Unknown here.
pub fn clipboard_summary() -> Option<crate::clipboard::Summary> {
    None
}
