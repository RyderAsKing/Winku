//! Key down/up events through a listen-only Quartz event tap, for the hotkey hints on macOS.
//!
//! One thread owns the tap and runs its run loop; the tap sees every key whichever app has
//! focus and takes nothing away from anyone. A second thread runs the one timer while a hold is
//! pending (deadline.rs). The tap needs the Input Monitoring permission: without it macOS
//! refuses to make one, and there are no hints.

use std::cell::RefCell;
use std::ffi::c_void;
use std::ptr::NonNull;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use objc2_core_foundation::{kCFRunLoopCommonModes, CFMachPort, CFRetained, CFRunLoop};
use objc2_core_graphics::{
    CGEvent, CGEventField, CGEventTapLocation, CGEventTapOptions, CGEventTapPlacement,
    CGEventTapProxy, CGEventType,
};

use super::deadline::{set_deadline, timer};
use super::{Key, Timer};

static STARTED: OnceLock<()> = OnceLock::new();

/// What the tap's callback needs; it runs on the tap's thread.
struct Tap {
    on_key: fn(Key, bool) -> Timer,
    delay: Duration,
    port: Option<CFRetained<CFMachPort>>,
}

thread_local! {
    static TAP: RefCell<Option<Tap>> = const { RefCell::new(None) };
}

/// Starts the watcher thread. `on_key` runs on it for every key event; `on_timer` when the timer
/// fires (it may ask for another run). Safe to call once.
pub fn watch(on_key: fn(Key, bool) -> Timer, on_timer: fn() -> Option<u32>, delay_ms: u32) {
    if STARTED.set(()).is_err() {
        return;
    }
    let delay = Duration::from_millis(u64::from(delay_ms));
    std::thread::Builder::new()
        .name("winku-keys".into())
        .spawn(move || {
            if keys(on_key, delay).is_none() {
                eprintln!(
                    "winku: no key events (Input Monitoring isn't allowed for Winku), no hotkey hints"
                );
            }
        })
        .ok();
    std::thread::Builder::new()
        .name("winku-keys-timer".into())
        .spawn(move || timer(on_timer))
        .ok();
}

fn mask(kind: CGEventType) -> u64 {
    1 << kind.0
}

fn keys(on_key: fn(Key, bool) -> Timer, delay: Duration) -> Option<()> {
    let interest =
        mask(CGEventType::KeyDown) | mask(CGEventType::KeyUp) | mask(CGEventType::FlagsChanged);
    // SAFETY: `callback` matches CGEventTapCallBack and reads only this thread's TAP.
    let port = unsafe {
        CGEvent::tap_create(
            CGEventTapLocation::SessionEventTap,
            CGEventTapPlacement::HeadInsertEventTap,
            CGEventTapOptions::ListenOnly,
            interest,
            Some(callback),
            std::ptr::null_mut(),
        )
    }?;
    let source = CFMachPort::new_run_loop_source(None, Some(&port), 0)?;
    let run_loop = CFRunLoop::current()?;
    // SAFETY: a static owned by CoreFoundation.
    run_loop.add_source(Some(&source), unsafe { kCFRunLoopCommonModes });
    TAP.with(|t| {
        *t.borrow_mut() = Some(Tap {
            on_key,
            delay,
            port: Some(port),
        })
    });
    CFRunLoop::run();
    Some(())
}

unsafe extern "C-unwind" fn callback(
    _proxy: CGEventTapProxy,
    kind: CGEventType,
    event: NonNull<CGEvent>,
    _user_info: *mut c_void,
) -> *mut CGEvent {
    // SAFETY: the event is valid for the duration of the callback.
    let e = unsafe { event.as_ref() };
    TAP.with(|t| {
        let t = t.borrow();
        let Some(tap) = t.as_ref() else { return };
        if kind == CGEventType::TapDisabledByTimeout || kind == CGEventType::TapDisabledByUserInput
        {
            // macOS turns a slow tap off; turn it back on.
            if let Some(port) = &tap.port {
                CGEvent::tap_enable(port, true);
            }
            return;
        }
        let code = CGEvent::integer_value_field(Some(e), CGEventField::KeyboardEventKeycode) as u16;
        let events: &[(Key, bool)] = &if kind == CGEventType::FlagsChanged {
            match modifier(code, CGEvent::flags(Some(e)).0) {
                Some(change) => vec![change],
                // Caps Lock reports a change of state, not of the key: a press and a release.
                None if code == CAPS_LOCK => {
                    vec![(Key::Other(0x14), true), (Key::Other(0x14), false)]
                }
                None => Vec::new(),
            }
        } else {
            let down = kind == CGEventType::KeyDown;
            if down
                && CGEvent::integer_value_field(Some(e), CGEventField::KeyboardEventAutorepeat) != 0
            {
                return;
            }
            vec![(key_for_code(code), down)]
        };
        for &(key, down) in events {
            match (tap.on_key)(key, down) {
                Timer::Start => set_deadline(Some(Instant::now() + tap.delay)),
                Timer::Cancel => set_deadline(None),
                Timer::Keep => {}
            }
        }
    });
    event.as_ptr()
}

const CAPS_LOCK: u16 = 57;

/// A modifier key's change from a flags-changed event: which key (by its code) and whether it is
/// now down (its device-dependent flag bit). Cmd counts as the Windows key: Winku's `Super`
/// hotkeys are Cmd on macOS.
fn modifier(code: u16, flags: u64) -> Option<(Key, bool)> {
    let (key, bit) = match code {
        59 => (Key::LCtrl, 0x0001),
        62 => (Key::RCtrl, 0x2000),
        56 => (Key::LShift, 0x0002),
        60 => (Key::RShift, 0x0004),
        55 => (Key::LWin, 0x0008),
        54 => (Key::RWin, 0x0010),
        58 => (Key::LAlt, 0x0020),
        61 => (Key::RAlt, 0x0040),
        _ => return None,
    };
    Some((key, flags & bit != 0))
}

/// A virtual-key code no leader key uses, for keys the hints only need to see as "another key".
const OTHER: u16 = 0x07;

/// Maps a Mac virtual key code (a key's position, as Winku's hotkeys use it) to the hint state
/// machine's key: the keys a leader can be, as the Windows virtual-key codes `vk_for` uses, and
/// anything else as some other key.
pub(super) fn key_for_code(code: u16) -> Key {
    const LETTERS: [(u16, u8); 26] = [
        (0, b'A'),
        (11, b'B'),
        (8, b'C'),
        (2, b'D'),
        (14, b'E'),
        (3, b'F'),
        (5, b'G'),
        (4, b'H'),
        (34, b'I'),
        (38, b'J'),
        (40, b'K'),
        (37, b'L'),
        (46, b'M'),
        (45, b'N'),
        (31, b'O'),
        (35, b'P'),
        (12, b'Q'),
        (15, b'R'),
        (1, b'S'),
        (17, b'T'),
        (32, b'U'),
        (9, b'V'),
        (13, b'W'),
        (7, b'X'),
        (16, b'Y'),
        (6, b'Z'),
    ];
    const DIGITS: [(u16, u8); 10] = [
        (29, b'0'),
        (18, b'1'),
        (19, b'2'),
        (20, b'3'),
        (21, b'4'),
        (23, b'5'),
        (22, b'6'),
        (26, b'7'),
        (28, b'8'),
        (25, b'9'),
    ];
    // F1 to F20 in order.
    const FUNCTION: [u16; 20] = [
        122, 120, 99, 118, 96, 97, 98, 100, 101, 109, 103, 111, 105, 107, 113, 106, 64, 79, 80, 90,
    ];
    if let Some(&(_, c)) = LETTERS
        .iter()
        .chain(DIGITS.iter())
        .find(|(k, _)| *k == code)
    {
        return Key::Other(u16::from(c));
    }
    if let Some(i) = FUNCTION.iter().position(|&k| k == code) {
        return Key::Other(0x70 + i as u16);
    }
    Key::Other(match code {
        49 => 0x20,      // Space
        48 => 0x09,      // Tab
        36 | 76 => 0x0d, // Return, keypad Enter
        53 => 0x1b,      // Escape
        51 => 0x08,      // Delete (backspace)
        117 => 0x2e,     // Forward delete
        114 => 0x2d,     // Help, where Insert is on PC keyboards
        115 => 0x24,     // Home
        119 => 0x23,     // End
        116 => 0x21,     // Page Up
        121 => 0x22,     // Page Down
        CAPS_LOCK => 0x14,
        _ => OTHER,
    })
}

#[cfg(test)]
mod tests {
    use super::super::vk_for;
    use super::*;

    #[test]
    fn modifiers_keep_their_side() {
        assert_eq!(modifier(59, 0x0001), Some((Key::LCtrl, true)));
        assert_eq!(modifier(59, 0), Some((Key::LCtrl, false)));
        assert_eq!(modifier(61, 0x0040), Some((Key::RAlt, true)));
        assert_eq!(modifier(54, 0x0010), Some((Key::RWin, true)));
        assert_eq!(modifier(55, 0x0010), Some((Key::LWin, false)));
        assert_eq!(modifier(CAPS_LOCK, 0), None);
    }

    #[test]
    fn leader_keys_match_their_names() {
        for (code, name) in [
            (12, "q"),
            (0, "A"),
            (26, "7"),
            (29, "0"),
            (122, "F1"),
            (105, "F13"),
            (90, "F20"),
            (49, "Space"),
            (36, "Enter"),
            (53, "Esc"),
            (116, "PageUp"),
            (117, "Delete"),
            (CAPS_LOCK, "CapsLock"),
        ] {
            assert_eq!(
                key_for_code(code),
                Key::Other(vk_for(name).unwrap()),
                "{name}"
            );
        }
    }

    #[test]
    fn unknown_keys_are_just_another_key() {
        assert_eq!(key_for_code(63), Key::Other(OTHER));
        assert_eq!(key_for_code(200), Key::Other(OTHER));
    }
}
