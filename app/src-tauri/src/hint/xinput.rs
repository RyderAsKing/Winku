//! Key down/up events through XInput 2 raw events, for the hotkey hints on X11.
//!
//! One thread holds its own X connection and sleeps waiting for events. Raw key events selected
//! on the root window arrive for every key, whichever window has focus, and don't take the key
//! away from anyone. A second thread runs the one timer while a hold is pending. Under XWayland,
//! keys typed into native Wayland apps aren't sent to X11 clients, so hints only appear while an
//! X11 window has focus there.

use std::sync::{Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

use x11rb::connection::Connection;
use x11rb::protocol::xinput::{self, ConnectionExt as _};
use x11rb::protocol::xproto::ConnectionExt as _;
use x11rb::protocol::Event;

use super::{Key, Timer};

/// When the timer is due; None while no hold is pending.
static DEADLINE: Mutex<Option<Instant>> = Mutex::new(None);
static WAKE: Condvar = Condvar::new();
static STARTED: OnceLock<()> = OnceLock::new();

fn set_deadline(at: Option<Instant>) {
    *DEADLINE.lock().unwrap_or_else(|e| e.into_inner()) = at;
    WAKE.notify_all();
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
                eprintln!("winku: no XInput 2 on this display, no hotkey hints");
            }
        })
        .ok();
    std::thread::Builder::new()
        .name("winku-keys-timer".into())
        .spawn(move || timer(on_timer))
        .ok();
}

fn keys(on_key: fn(Key, bool) -> Timer, delay: Duration) -> Option<()> {
    let (conn, screen) = x11rb::connect(None).ok()?;
    let root = conn.setup().roots.get(screen)?.root;
    let version = conn.xinput_xi_query_version(2, 2).ok()?.reply().ok()?;
    if version.major_version < 2 {
        return None;
    }
    let mask = xinput::EventMask {
        deviceid: 1, // all master devices: each key once, from the keyboard the user typed on
        mask: vec![xinput::XIEventMask::RAW_KEY_PRESS | xinput::XIEventMask::RAW_KEY_RELEASE],
    };
    conn.xinput_xi_select_events(root, &[mask])
        .ok()?
        .check()
        .ok()?;
    let mut keymap = Keymap::read(&conn)?;
    let repeat = u32::from(xinput::KeyEventFlags::KEY_REPEAT);
    loop {
        let (event, down) = match conn.wait_for_event().ok()? {
            Event::XinputRawKeyPress(e) => (e, true),
            Event::XinputRawKeyRelease(e) => (e, false),
            Event::MappingNotify(_) => {
                if let Some(fresh) = Keymap::read(&conn) {
                    keymap = fresh;
                }
                continue;
            }
            _ => continue,
        };
        if down && u32::from(event.flags) & repeat != 0 {
            continue;
        }
        let key = key_for_keysym(keymap.keysym(event.detail));
        match on_key(key, down) {
            Timer::Start => set_deadline(Some(Instant::now() + delay)),
            Timer::Cancel => set_deadline(None),
            Timer::Keep => {}
        }
    }
}

fn timer(on_timer: fn() -> Option<u32>) {
    let mut deadline = DEADLINE.lock().unwrap_or_else(|e| e.into_inner());
    loop {
        match *deadline {
            None => {
                deadline = WAKE.wait(deadline).unwrap_or_else(|e| e.into_inner());
            }
            Some(at) if Instant::now() < at => {
                let left = at.saturating_duration_since(Instant::now());
                deadline = WAKE
                    .wait_timeout(deadline, left)
                    .unwrap_or_else(|e| e.into_inner())
                    .0;
            }
            Some(_) => {
                *deadline = None;
                drop(deadline);
                let again = on_timer();
                deadline = DEADLINE.lock().unwrap_or_else(|e| e.into_inner());
                if let Some(ms) = again {
                    deadline.get_or_insert(Instant::now() + Duration::from_millis(u64::from(ms)));
                }
            }
        }
    }
}

/// The first keysym of each keycode, as the layout maps it.
struct Keymap {
    min: u32,
    per: usize,
    syms: Vec<u32>,
}

impl Keymap {
    fn read(conn: &impl Connection) -> Option<Keymap> {
        let setup = conn.setup();
        let (min, max) = (setup.min_keycode, setup.max_keycode);
        let reply = conn
            .get_keyboard_mapping(min, max - min + 1)
            .ok()?
            .reply()
            .ok()?;
        Some(Keymap {
            min: u32::from(min),
            per: usize::from(reply.keysyms_per_keycode).max(1),
            syms: reply.keysyms,
        })
    }

    fn keysym(&self, keycode: u32) -> u32 {
        keycode
            .checked_sub(self.min)
            .and_then(|i| self.syms.get(i as usize * self.per))
            .copied()
            .unwrap_or(0)
    }
}

/// A virtual-key code no leader key uses, for keys the hints only need to see as "another key".
const OTHER: u16 = 0x07;

/// Maps an X keysym to the hint state machine's key: modifiers by side, the keys a leader can be
/// (as the Windows virtual-key codes `vk_for` uses), and anything else as some other key.
/// AltGr (`ISO_Level3_Shift`) is a key of its own on X11, not `Ctrl+Alt`.
pub(super) fn key_for_keysym(sym: u32) -> Key {
    let vk = match sym {
        0xffe3 => return Key::LCtrl,
        0xffe4 => return Key::RCtrl,
        0xffe9 | 0xffe7 => return Key::LAlt,
        0xffea | 0xffe8 => return Key::RAlt,
        0xffe1 => return Key::LShift,
        0xffe2 => return Key::RShift,
        0xffeb => return Key::LWin,
        0xffec => return Key::RWin,
        0x61..=0x7a => sym - 0x20, // a-z as A-Z
        0x30..=0x39 | 0x41..=0x5a | 0x20 => sym,
        0xffbe..=0xffd5 => 0x70 + (sym - 0xffbe), // F1-F24
        0xff09 => 0x09,
        0xff0d | 0xff8d => 0x0d,
        0xff1b => 0x1b,
        0xff08 => 0x08,
        0xffe5 => 0x14,
        0xff63 => 0x2d,
        0xffff => 0x2e,
        0xff50 => 0x24,
        0xff57 => 0x23,
        0xff55 => 0x21,
        0xff56 => 0x22,
        _ => u32::from(OTHER),
    };
    Key::Other(vk as u16)
}

#[cfg(test)]
mod tests {
    use super::super::vk_for;
    use super::*;

    #[test]
    fn modifiers_keep_their_side() {
        assert_eq!(key_for_keysym(0xffe3), Key::LCtrl);
        assert_eq!(key_for_keysym(0xffea), Key::RAlt);
        assert_eq!(key_for_keysym(0xffec), Key::RWin);
        assert_eq!(key_for_keysym(0xffe2), Key::RShift);
    }

    #[test]
    fn leader_keys_match_their_names() {
        for (sym, name) in [
            (0x71, "q"),
            (0x51, "Q"),
            (0x37, "7"),
            (0xffbe, "F1"),
            (0xffca, "F13"),
            (0xffd5, "F24"),
            (0x20, "Space"),
            (0xff0d, "Enter"),
            (0xff1b, "Esc"),
            (0xff55, "PageUp"),
            (0xffff, "Delete"),
            (0xffe5, "CapsLock"),
        ] {
            assert_eq!(
                key_for_keysym(sym),
                Key::Other(vk_for(name).unwrap()),
                "{name}"
            );
        }
    }

    #[test]
    fn altgr_is_just_another_key() {
        assert_eq!(key_for_keysym(0xfe03), Key::Other(OTHER));
        assert_eq!(key_for_keysym(0x1000041), Key::Other(OTHER));
    }
}
