//! Key down/up events through Raw Input, for the hotkey hints.
//!
//! One thread owns a hidden message-only window and sleeps in `GetMessageW`. The window is
//! registered for keyboard input with `RIDEV_INPUTSINK`, so it gets `WM_INPUT` for every key
//! whichever window has focus. A single `SetTimer` runs only while a hold is pending.
//! Not a `WH_KEYBOARD_LL` hook: that sits in the path of every keystroke on the system.
//! Elevated foreground windows don't deliver raw input to a non-elevated process.

use std::sync::OnceLock;

use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows_sys::Win32::UI::Input::{
    GetRawInputData, RegisterRawInputDevices, HRAWINPUT, RAWINPUT, RAWINPUTDEVICE, RAWINPUTHEADER,
    RIDEV_INPUTSINK, RID_INPUT, RIM_TYPEKEYBOARD,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, KillTimer, RegisterClassW,
    SetTimer, HWND_MESSAGE, MSG, WM_INPUT, WM_TIMER, WNDCLASSW,
};

use super::{Key, Timer};

const RI_KEY_BREAK: u16 = 1;
const RI_KEY_E0: u16 = 2;
const RI_KEY_E1: u16 = 4;
const TIMER_ID: usize = 1;

struct Callbacks {
    on_key: fn(Key, bool) -> Timer,
    on_timer: fn() -> Option<u32>,
    delay_ms: u32,
}

static CALLBACKS: OnceLock<Callbacks> = OnceLock::new();

/// Starts the watcher thread. `on_key` runs on it for every key event; `on_timer` when the timer
/// fires (it may ask for another run). Safe to call once.
pub fn watch(on_key: fn(Key, bool) -> Timer, on_timer: fn() -> Option<u32>, delay_ms: u32) {
    if CALLBACKS
        .set(Callbacks {
            on_key,
            on_timer,
            delay_ms,
        })
        .is_err()
    {
        return;
    }
    std::thread::spawn(|| {
        // SAFETY: the window belongs to this thread and is serviced by its message loop.
        unsafe {
            let class: Vec<u16> = "WinkuKeyWatch\0".encode_utf16().collect();
            let wc = WNDCLASSW {
                lpfnWndProc: Some(proc),
                lpszClassName: class.as_ptr(),
                ..std::mem::zeroed()
            };
            RegisterClassW(&wc);
            let hwnd = CreateWindowExW(
                0,
                class.as_ptr(),
                std::ptr::null(),
                0,
                0,
                0,
                0,
                0,
                HWND_MESSAGE,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null(),
            );
            if hwnd.is_null() {
                return;
            }
            let device = RAWINPUTDEVICE {
                usUsagePage: 0x01, // generic desktop
                usUsage: 0x06,     // keyboard
                dwFlags: RIDEV_INPUTSINK,
                hwndTarget: hwnd,
            };
            if RegisterRawInputDevices(&device, 1, std::mem::size_of::<RAWINPUTDEVICE>() as u32)
                == 0
            {
                eprintln!("winku: raw input registration failed, no hotkey hints");
                return;
            }
            let mut msg: MSG = std::mem::zeroed();
            while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {
                DispatchMessageW(&msg);
            }
        }
    });
}

unsafe extern "system" fn proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    let Some(callbacks) = CALLBACKS.get() else {
        return DefWindowProcW(hwnd, msg, wparam, lparam);
    };
    match msg {
        WM_INPUT => {
            if let Some((key, down)) = read_key(lparam as HRAWINPUT) {
                match (callbacks.on_key)(key, down) {
                    Timer::Start => {
                        SetTimer(hwnd, TIMER_ID, callbacks.delay_ms, None);
                    }
                    Timer::Cancel => {
                        KillTimer(hwnd, TIMER_ID);
                    }
                    Timer::Keep => {}
                }
            }
            // The system cleans up after WM_INPUT in DefWindowProc.
            DefWindowProcW(hwnd, msg, wparam, lparam)
        }
        WM_TIMER if wparam == TIMER_ID => {
            KillTimer(hwnd, TIMER_ID);
            if let Some(again) = (callbacks.on_timer)() {
                SetTimer(hwnd, TIMER_ID, again, None);
            }
            0
        }
        _ => DefWindowProcW(hwnd, msg, wparam, lparam),
    }
}

unsafe fn read_key(handle: HRAWINPUT) -> Option<(Key, bool)> {
    let mut input: RAWINPUT = std::mem::zeroed();
    let mut size = std::mem::size_of::<RAWINPUT>() as u32;
    let read = GetRawInputData(
        handle,
        RID_INPUT,
        &mut input as *mut RAWINPUT as *mut _,
        &mut size,
        std::mem::size_of::<RAWINPUTHEADER>() as u32,
    );
    if read == u32::MAX || input.header.dwType != RIM_TYPEKEYBOARD {
        return None;
    }
    let kb = input.data.keyboard;
    key_from(kb.VKey, kb.MakeCode, kb.Flags).map(|key| (key, kb.Flags & RI_KEY_BREAK == 0))
}

/// Maps a RAWKEYBOARD record to a key. Raw input reports `Ctrl`, `Alt` and `Shift` generically
/// (VK_CONTROL, VK_MENU, VK_SHIFT): the side comes from the E0 flag, or the scan code for Shift.
/// None for fake keys (VK 0xFF, the E0-prefixed Shift Windows injects around arrows, the
/// E1-prefixed Pause).
fn key_from(vk: u16, make: u16, flags: u16) -> Option<Key> {
    if vk == 0xFF || flags & RI_KEY_E1 != 0 {
        return None;
    }
    let e0 = flags & RI_KEY_E0 != 0;
    Some(match vk {
        0x11 if e0 => Key::RCtrl,
        0x11 => Key::LCtrl,
        0x12 if e0 => Key::RAlt,
        0x12 => Key::LAlt,
        0x10 if e0 => return None,
        0x10 if make == 0x36 => Key::RShift,
        0x10 => Key::LShift,
        0x5B => Key::LWin,
        0x5C => Key::RWin,
        0xA0 => Key::LShift,
        0xA1 => Key::RShift,
        0xA2 => Key::LCtrl,
        0xA3 => Key::RCtrl,
        0xA4 => Key::LAlt,
        0xA5 => Key::RAlt,
        other => Key::Other(other),
    })
}
