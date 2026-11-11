//! Windows implementations.

use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, GetKeyboardLayout, VkKeyScanExW, VK_LBUTTON,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId};

pub fn mouse_button_down() -> bool {
    // SAFETY: plain Win32 call with no pointers.
    unsafe { (GetAsyncKeyState(VK_LBUTTON as i32) as u16 & 0x8000) != 0 }
}

/// Keys (uppercase ASCII letters and digits) that type a character with `Ctrl+Alt` held in the
/// keyboard layout of the foreground window: the layout treats `Ctrl+Alt` as AltGr.
pub fn altgr_keys() -> Option<Vec<char>> {
    // SAFETY: Win32 calls; the pid out-pointer may be null.
    let layout = unsafe {
        let thread = GetWindowThreadProcessId(GetForegroundWindow(), std::ptr::null_mut());
        GetKeyboardLayout(thread)
    };
    let mut keys = Vec::new();
    // Every BMP character that a layout might put on an AltGr layer, checked for which key and
    // modifiers produce it. High byte of the result: 1 = Shift, 2 = Ctrl, 4 = Alt.
    for ch in (0x21u16..0x250).chain(0x20AC..0x20AD) {
        // SAFETY: plain Win32 call.
        let scan = unsafe { VkKeyScanExW(ch, layout) };
        if scan == -1 {
            continue;
        }
        let vk = (scan & 0xFF) as u8;
        let mods = ((scan >> 8) & 0xFF) as u8;
        if mods & 0b110 == 0b110 && vk.is_ascii_alphanumeric() {
            let key = vk as char;
            if !keys.contains(&key) {
                keys.push(key);
            }
        }
    }
    keys.sort_unstable();
    Some(keys)
}
