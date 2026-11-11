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
