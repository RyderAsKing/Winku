//! Linux implementations, on X11 (docs/adr/0003-linux-runs-on-x11.md). On a Wayland desktop
//! Winku runs through XWayland (`force_x11_backend`), so everything here talks to an X server:
//! the session's own, or XWayland's. Apps that run natively on Wayland aren't visible to X11
//! clients, so there the foreground app, its selection, paste-back and capture are unavailable.
//!
//! Pure Rust (x11rb) with no extra system libraries. Each part that waits for events has its own
//! connection and thread: the clipboard (`Clip`), the fullscreen watch and the hotkey hints
//! (hint/xinput.rs). Plain queries share one connection (`x()`).

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use x11rb::connection::{Connection, RequestConnection};
use x11rb::protocol::res::{self, ConnectionExt as _};
use x11rb::protocol::shape::{self, ConnectionExt as _};
use x11rb::protocol::xfixes::{self, ConnectionExt as _};
use x11rb::protocol::xproto::{
    Atom, AtomEnum, ChangeWindowAttributesAux, ClientMessageEvent, ClipOrdering,
    ConfigureWindowAux, ConnectionExt as _, CreateWindowAux, EventMask, ImageFormat, ImageOrder,
    KeyButMask, Keycode, PropMode, Property, Rectangle, SelectionNotifyEvent,
    SelectionRequestEvent, Window, WindowClass, KEY_PRESS_EVENT, KEY_RELEASE_EVENT,
    SELECTION_NOTIFY_EVENT,
};
use x11rb::protocol::xtest::ConnectionExt as _;
use x11rb::protocol::Event;
use x11rb::rust_connection::RustConnection;
use x11rb::wrapper::ConnectionExt as _;
use x11rb::{CURRENT_TIME, NONE};

use super::{RawImage, RoundRect, WindowHandle};

x11rb::atom_manager! {
    pub Atoms: AtomsCookie {
        CLIPBOARD,
        UTF8_STRING,
        TARGETS,
        INCR,
        MULTIPLE,
        TIMESTAMP,
        TEXT,
        SAVE_TARGETS,
        DELETE,
        _NET_ACTIVE_WINDOW,
        _NET_WM_PID,
        _NET_WM_NAME,
        _NET_WM_STATE,
        _NET_WM_STATE_FULLSCREEN,
        _NET_WM_STATE_HIDDEN,
        _NET_WM_WINDOW_TYPE,
        _NET_WM_WINDOW_TYPE_DESKTOP,
        _NET_WM_WINDOW_TYPE_DOCK,
        _NET_FRAME_EXTENTS,
        _GTK_FRAME_EXTENTS,
        WINKU_SELECTION,
        PNG: b"image/png",
        URI_LIST: b"text/uri-list",
        GNOME_FILES: b"x-special/gnome-copied-files",
        PASSWORD_HINT: b"x-kde-passwordManagerHint",
        TEXT_PLAIN_UTF8: b"text/plain;charset=utf-8",
        TEXT_PLAIN: b"text/plain",
        COMPOUND_TEXT,
    }
}

/// Makes GTK use X11 even in a Wayland session (XWayland). Wayland doesn't let an app place its
/// own window, keep it above others, read other apps' windows or send keys, and the global
/// hotkeys are X11 key grabs. Call before Tauri starts. Only GTK in this process is affected:
/// child processes (the engine, apps it opens) keep the session's own backend.
pub fn force_x11_backend() {
    gtk::gdk::set_allowed_backends("x11");
}

// ---------------------------------------------------------------------------------------------
// The shared connection

struct X {
    conn: RustConnection,
    root: Window,
    atoms: Atoms,
}

/// The query connection, opened on first use. None without an X server (a pure Wayland session
/// with no XWayland, or no display at all): everything then reports "unknown".
fn x() -> Option<&'static X> {
    static X11: OnceLock<Option<X>> = OnceLock::new();
    X11.get_or_init(|| {
        let (conn, screen) = x11rb::connect(None).ok()?;
        let root = conn.setup().roots.get(screen)?.root;
        let atoms = Atoms::new(&conn).ok()?.reply().ok()?;
        // Extensions used on this connection; their versions must be asked for once.
        if let Ok(c) = conn.xfixes_query_version(5, 0) {
            let _ = c.reply();
        }
        if let Ok(c) = conn.res_query_version(1, 2) {
            let _ = c.reply();
        }
        Some(X { conn, root, atoms })
    })
    .as_ref()
}

impl X {
    fn property(&self, window: Window, property: Atom, kind: impl Into<Atom>) -> Option<Vec<u8>> {
        let reply = self
            .conn
            .get_property(false, window, property, kind, 0, u32::MAX / 4)
            .ok()?
            .reply()
            .ok()?;
        (reply.type_ != NONE).then_some(reply.value)
    }

    fn property32(&self, window: Window, property: Atom, kind: impl Into<Atom>) -> Vec<u32> {
        self.conn
            .get_property(false, window, property, kind, 0, u32::MAX / 4)
            .ok()
            .and_then(|c| c.reply().ok())
            .and_then(|r| r.value32().map(|v| v.collect()))
            .unwrap_or_default()
    }

    fn pointer(&self) -> Option<x11rb::protocol::xproto::QueryPointerReply> {
        self.conn.query_pointer(self.root).ok()?.reply().ok()
    }

    /// The process behind `window`: `_NET_WM_PID`, else the X server's own record of the client
    /// (XRes), which also covers windows that set no pid, such as selection owners.
    fn pid(&self, window: Window) -> Option<u32> {
        if let Some(&pid) = self
            .property32(window, self.atoms._NET_WM_PID, AtomEnum::CARDINAL)
            .first()
        {
            return Some(pid).filter(|&p| p != 0);
        }
        let spec = res::ClientIdSpec {
            client: window,
            mask: res::ClientIdMask::LOCAL_CLIENT_PID,
        };
        let reply = self.conn.res_query_client_ids(&[spec]).ok()?.reply().ok()?;
        reply
            .ids
            .iter()
            .find(|id| {
                u32::from(id.spec.mask) & u32::from(res::ClientIdMask::LOCAL_CLIENT_PID) != 0
            })
            .and_then(|id| id.value.first().copied())
            .filter(|&p| p != 0)
    }

    /// Position on screen and size of a window, without its frame.
    fn rect(&self, window: Window) -> Option<(i32, i32, i32, i32)> {
        let geometry = self.conn.get_geometry(window).ok()?.reply().ok()?;
        let at = self
            .conn
            .translate_coordinates(window, self.root, 0, 0)
            .ok()?
            .reply()
            .ok()?;
        Some((
            i32::from(at.dst_x),
            i32::from(at.dst_y),
            i32::from(geometry.width),
            i32::from(geometry.height),
        ))
    }

    /// The pixels of a rectangle of `drawable`, or `None` if the server has none to give (a
    /// rootless XWayland's root window, or an unmapped window).
    fn image(
        &self,
        drawable: Window,
        x: i32,
        y: i32,
        width: u16,
        height: u16,
    ) -> Option<x11rb::protocol::xproto::GetImageReply> {
        self.conn
            .get_image(
                ImageFormat::Z_PIXMAP,
                drawable,
                x as i16,
                y as i16,
                width,
                height,
                u32::MAX,
            )
            .ok()?
            .reply()
            .ok()
    }

    fn has_state(&self, window: Window, state: Atom) -> bool {
        self.property32(window, self.atoms._NET_WM_STATE, AtomEnum::ATOM)
            .contains(&state)
    }

    /// Keycodes of each modifier: Shift, Lock, Control, Mod1 (Alt), Mod2 (Num Lock), Mod3, Mod4
    /// (Super), Mod5 (AltGr).
    fn modifier_keycodes(&self) -> Vec<Vec<Keycode>> {
        let Some(reply) = self
            .conn
            .get_modifier_mapping()
            .ok()
            .and_then(|c| c.reply().ok())
        else {
            return Vec::new();
        };
        let per = usize::from(reply.keycodes_per_modifier());
        if per == 0 {
            return Vec::new();
        }
        reply
            .keycodes
            .chunks(per)
            .map(|c| c.iter().copied().filter(|&k| k != 0).collect())
            .collect()
    }

    /// The keycode that types `keysym` without a modifier (or with Shift), if any.
    fn keycode(&self, keysym: u32) -> Option<Keycode> {
        let setup = self.conn.setup();
        let (min, max) = (setup.min_keycode, setup.max_keycode);
        let reply = self
            .conn
            .get_keyboard_mapping(min, max - min + 1)
            .ok()?
            .reply()
            .ok()?;
        let per = usize::from(reply.keysyms_per_keycode).max(1);
        reply
            .keysyms
            .chunks(per)
            .position(|syms| syms.iter().take(2).any(|&s| s == keysym))
            .map(|i| min + i as u8)
    }

    fn send_keys(&self, keys: &[(Keycode, bool)]) -> Result<(), String> {
        for &(code, down) in keys {
            let kind = if down {
                KEY_PRESS_EVENT
            } else {
                KEY_RELEASE_EVENT
            };
            self.conn
                .xtest_fake_input(kind, code, CURRENT_TIME, self.root, 0, 0, 0)
                .map_err(|e| e.to_string())?
                .check()
                .map_err(|_| "the X server refused the simulated keystroke".to_string())?;
        }
        self.conn.flush().map_err(|e| e.to_string())
    }
}

fn mask_has(mask: KeyButMask, flags: KeyButMask) -> bool {
    u16::from(mask) & u16::from(flags) != 0
}

/// Shift, Ctrl, Alt, Super and AltGr; not Caps Lock or Num Lock.
const MODIFIERS: [KeyButMask; 5] = [
    KeyButMask::SHIFT,
    KeyButMask::CONTROL,
    KeyButMask::MOD1,
    KeyButMask::MOD4,
    KeyButMask::MOD5,
];

/// Whether the primary mouse button is held. X applies the button mapping, so Button 1 is the
/// primary button even when the buttons are swapped.
pub fn mouse_button_down() -> bool {
    x().and_then(X::pointer)
        .is_some_and(|p| mask_has(p.mask, KeyButMask::BUTTON1))
}

/// On X11, AltGr is a key of its own (ISO_Level3_Shift), so `Ctrl+Alt` never types characters.
pub fn altgr_keys() -> Option<Vec<char>> {
    x().map(|_| Vec::new())
}

// ---------------------------------------------------------------------------------------------
// Windows and keys

pub fn foreground_window() -> WindowHandle {
    let Some(x) = x() else {
        return WindowHandle(0);
    };
    let active = x
        .property32(x.root, x.atoms._NET_ACTIVE_WINDOW, AtomEnum::WINDOW)
        .first()
        .copied()
        .unwrap_or(0);
    WindowHandle(active as isize)
}

fn window(handle: WindowHandle) -> Option<Window> {
    u32::try_from(handle.0).ok().filter(|&w| w != 0)
}

/// The process that owns `window`.
pub fn window_pid(handle: WindowHandle) -> Option<u32> {
    x()?.pid(window(handle)?)
}

/// Lower-case executable name of the process that owns `window`, e.g. "firefox".
pub fn process_name(handle: WindowHandle) -> Option<String> {
    let x = x()?;
    let pid = x.pid(window(handle)?)?;
    process_name_of(pid)
}

/// The executable's file name, or the process's own name when it can't be read (another user's
/// process) or is an interpreter running a script.
fn process_name_of(pid: u32) -> Option<String> {
    let comm = std::fs::read_to_string(format!("/proc/{pid}/comm"))
        .ok()
        .map(|c| c.trim().to_string())
        .filter(|c| !c.is_empty());
    let exe = std::fs::read_link(format!("/proc/{pid}/exe"))
        .ok()
        .and_then(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()))
        .map(|n| n.trim_end_matches(" (deleted)").to_string());
    // "python3.12" counts as "python".
    let interpreter = |name: &str| {
        let base = name.trim_end_matches(|c: char| c.is_ascii_digit() || c == '.');
        [
            "python", "perl", "ruby", "node", "java", "bash", "sh", "gjs", "bwrap",
        ]
        .contains(&base)
    };
    match (exe, comm) {
        (Some(exe), Some(comm)) if interpreter(&exe) => Some(comm),
        (Some(exe), _) => Some(exe),
        (None, comm) => comm,
    }
    .map(|n| n.to_lowercase())
}

/// Asks the window manager to activate `window` (as a pager would). True once it is active.
pub fn focus_window(handle: WindowHandle) -> bool {
    let (Some(x), Some(target)) = (x(), window(handle)) else {
        return false;
    };
    if foreground_window() == handle {
        return true;
    }
    let message = ClientMessageEvent::new(
        32,
        target,
        x.atoms._NET_ACTIVE_WINDOW,
        [2, CURRENT_TIME, 0, 0, 0],
    );
    let mask = EventMask::SUBSTRUCTURE_REDIRECT | EventMask::SUBSTRUCTURE_NOTIFY;
    if x.conn
        .send_event(false, x.root, mask, message)
        .map(|c| c.ignore_error())
        .is_err()
        || x.conn.flush().is_err()
    {
        return false;
    }
    let started = Instant::now();
    while started.elapsed() < Duration::from_millis(400) {
        if foreground_window() == handle {
            // Let the window manager hand over keyboard focus before keys are sent.
            std::thread::sleep(Duration::from_millis(30));
            return true;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    false
}

fn modifiers_held(x: &X) -> bool {
    x.pointer()
        .is_some_and(|p| MODIFIERS.iter().any(|&m| mask_has(p.mask, m)))
}

/// Polls until Ctrl, Alt, Shift, Super and AltGr are all up, or `timeout` passes.
pub fn wait_for_modifiers_released(timeout: Duration) {
    let Some(x) = x() else { return };
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline && modifiers_held(x) {
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn key_is_down(keys: &[u8; 32], code: Keycode) -> bool {
    keys[usize::from(code / 8)] & (1 << (code % 8)) != 0
}

/// Gets the hotkey's keys out of the way before a simulated keystroke, like the Windows version:
/// returns at once when no modifier is held; otherwise waits for the hotkey's own key to come
/// up, then releases the modifiers still held (through XTest) instead of waiting for the user.
pub fn clear_keys_for_input(timeout: Duration) {
    let Some(x) = x() else { return };
    let deadline = Instant::now() + timeout;
    let modifiers = x.modifier_keycodes();
    // Shift, Control, Mod1, Mod4, Mod5; not Lock, Num Lock or Mod3.
    let watched: Vec<Keycode> = [0, 2, 3, 6, 7]
        .iter()
        .filter_map(|&i| modifiers.get(i))
        .flatten()
        .copied()
        .collect();
    let all_modifiers: Vec<Keycode> = modifiers.iter().flatten().copied().collect();
    loop {
        let Some(keys) = x
            .conn
            .query_keymap()
            .ok()
            .and_then(|c| c.reply().ok())
            .map(|r| r.keys)
        else {
            return;
        };
        let held: Vec<Keycode> = watched
            .iter()
            .copied()
            .filter(|&k| key_is_down(&keys, k))
            .collect();
        if held.is_empty() {
            return;
        }
        let other = (8..=255u8).any(|k| !all_modifiers.contains(&k) && key_is_down(&keys, k));
        if !other {
            let ups: Vec<(Keycode, bool)> = held.iter().map(|&k| (k, false)).collect();
            let _ = x.send_keys(&ups);
            std::thread::sleep(Duration::from_millis(15));
            return;
        }
        if Instant::now() >= deadline {
            return;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

const XK_CONTROL_L: u32 = 0xffe3;
const XK_SHIFT_L: u32 = 0xffe1;

/// Sends Ctrl+<letter>, or Ctrl+Shift+<letter> in a terminal, where Ctrl+C interrupts the running
/// program and Ctrl+V types a control character. `letter` is lowercase ASCII.
fn send_ctrl(letter: u8, terminal: bool) -> Result<(), String> {
    let x = x().ok_or("there is no X display")?;
    // Fallbacks are the usual evdev keycodes, for layouts with no Latin letters.
    let fallback = |sym: u32| match sym {
        XK_CONTROL_L => 37,
        XK_SHIFT_L => 50,
        0x63 => 54, // c
        0x76 => 55, // v
        _ => 0,
    };
    let code = |sym: u32| x.keycode(sym).unwrap_or_else(|| fallback(sym));
    let (ctrl, shift, key) = (
        code(XK_CONTROL_L),
        code(XK_SHIFT_L),
        code(u32::from(letter)),
    );
    if key == 0 || ctrl == 0 {
        return Err("no key for the shortcut in this keyboard layout".into());
    }
    let mut keys = vec![(ctrl, true)];
    if terminal {
        keys.push((shift, true));
    }
    keys.extend([(key, true), (key, false)]);
    if terminal {
        keys.push((shift, false));
    }
    keys.push((ctrl, false));
    x.send_keys(&keys)
}

/// Whether the foreground window is a terminal, which copies and pastes with Shift added.
fn foreground_is_terminal() -> bool {
    process_name(foreground_window()).is_some_and(|p| super::is_linux_terminal(&p))
}

/// The selected text, read without touching the clipboard: X11's PRIMARY selection, which is
/// what the user has selected right now. Only taken when the app that owns it is the one in front,
/// since some apps keep PRIMARY after the selection is gone and another app's would be stale.
pub fn selection_via_uia() -> Option<String> {
    let x = x()?;
    let owner = x
        .conn
        .get_selection_owner(AtomEnum::PRIMARY.into())
        .ok()?
        .reply()
        .ok()?
        .owner;
    if owner == NONE {
        return None;
    }
    let front = x.pid(window(foreground_window())?)?;
    if x.pid(owner)? != front {
        return None;
    }
    clip()?.text(AtomEnum::PRIMARY.into())
}

/// Readable text of a window. Not available on Linux: the engine reads the window through
/// agent-desktop (AT-SPI) instead.
pub fn window_text(_window: WindowHandle) -> Option<String> {
    None
}

// ---------------------------------------------------------------------------------------------
// Window info and capture

/// True for windows that belong to Winku itself.
pub fn is_own_window(handle: WindowHandle) -> bool {
    let (Some(x), Some(w)) = (x(), window(handle)) else {
        return false;
    };
    x.pid(w) == Some(std::process::id())
}

/// `WM_CLASS` of `window`: its instance and class names, such as "gnome-terminal-server" and
/// "Gnome-terminal".
pub fn input_window_classes(handle: WindowHandle) -> Vec<String> {
    let (Some(x), Some(w)) = (x(), window(handle)) else {
        return Vec::new();
    };
    x.property(w, AtomEnum::WM_CLASS.into(), AtomEnum::STRING)
        .map(|v| {
            String::from_utf8_lossy(&v)
                .split('\0')
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

pub fn window_title(handle: WindowHandle) -> Option<String> {
    let (x, w) = (x()?, window(handle)?);
    x.property(w, x.atoms._NET_WM_NAME, x.atoms.UTF8_STRING)
        .or_else(|| x.property(w, AtomEnum::WM_NAME.into(), AtomEnum::ANY))
        .map(|v| String::from_utf8_lossy(&v).into_owned())
        .filter(|t| !t.is_empty())
}

/// What the user sees of the window: its rectangle copied from the screen, with the window
/// manager's title bar (`_NET_FRAME_EXTENTS`) and without a GTK window's shadow
/// (`_GTK_FRAME_EXTENTS`), clipped to the screen. XWayland on a Wayland desktop has no screen
/// to copy from (its root window is empty), so there the window's own contents are read, without
/// the title bar, which the Wayland compositor draws.
pub fn capture_window(handle: WindowHandle) -> Result<RawImage, String> {
    let x = x().ok_or("there is no X display")?;
    let w = window(handle).ok_or("there is no window to capture")?;
    if x.has_state(w, x.atoms._NET_WM_STATE_HIDDEN) {
        return Err("the window is minimized".into());
    }
    let (mut left, mut top, mut width, mut height) =
        x.rect(w).ok_or("could not read the window's position")?;
    let (own_width, own_height) = (width, height);
    let frame = x.property32(w, x.atoms._NET_FRAME_EXTENTS, AtomEnum::CARDINAL);
    if let [l, r, t, b] = frame[..] {
        left -= l as i32;
        top -= t as i32;
        width += (l + r) as i32;
        height += (t + b) as i32;
    }
    let shadow = x.property32(w, x.atoms._GTK_FRAME_EXTENTS, AtomEnum::CARDINAL);
    let inset = match shadow[..] {
        [l, r, t, b] => (l as i32, r as i32, t as i32, b as i32),
        _ => (0, 0, 0, 0),
    };
    if let [l, r, t, b] = shadow[..] {
        left += l as i32;
        top += t as i32;
        width -= (l + r) as i32;
        height -= (t + b) as i32;
    }
    let screen = &x.conn.setup().roots[0];
    let (sw, sh) = (
        i32::from(screen.width_in_pixels),
        i32::from(screen.height_in_pixels),
    );
    let (x0, y0) = (left.max(0), top.max(0));
    let (x1, y1) = ((left + width).min(sw), (top + height).min(sh));
    if x1 <= x0 || y1 <= y0 {
        return Err("the window is off screen".into());
    }
    let (cw, ch) = ((x1 - x0) as u16, (y1 - y0) as u16);
    if let Some(image) = x.image(x.root, x0, y0, cw, ch) {
        return to_rgba(x, &image, u32::from(cw), u32::from(ch));
    }
    let (l, r, t, b) = inset;
    let (ww, wh) = (own_width - l - r, own_height - t - b);
    if ww <= 0 || wh <= 0 {
        return Err("could not capture the window".into());
    }
    let (ww, wh) = (ww as u16, wh as u16);
    let image = x
        .image(w, l, t, ww, wh)
        .ok_or("could not capture the window")?;
    to_rgba(x, &image, u32::from(ww), u32::from(wh))
}

/// Z-pixmap data at 32 bits per pixel (depth 24 or 32, the only kind modern servers use) as RGBA.
fn to_rgba(
    x: &X,
    image: &x11rb::protocol::xproto::GetImageReply,
    width: u32,
    height: u32,
) -> Result<RawImage, String> {
    let setup = x.conn.setup();
    let bpp = setup
        .pixmap_formats
        .iter()
        .find(|f| f.depth == image.depth)
        .map_or(0, |f| f.bits_per_pixel);
    if bpp != 32 {
        return Err(format!("unsupported screen format ({bpp} bits per pixel)"));
    }
    let visual = setup
        .roots
        .iter()
        .flat_map(|s| &s.allowed_depths)
        .flat_map(|d| &d.visuals)
        .find(|v| v.visual_id == image.visual);
    let (red, green, blue) = visual.map_or((0xff_0000, 0xff00, 0xff), |v| {
        (v.red_mask, v.green_mask, v.blue_mask)
    });
    let channel = |px: u32, mask: u32| {
        if mask == 0 {
            return 0;
        }
        let value = (px & mask) >> mask.trailing_zeros();
        let bits = mask.count_ones();
        if bits >= 8 {
            (value >> (bits - 8)) as u8
        } else {
            (value << (8 - bits)) as u8
        }
    };
    let little = setup.image_byte_order == ImageOrder::LSB_FIRST;
    let needed = width as usize * height as usize * 4;
    if image.data.len() < needed {
        return Err("the capture came back short".into());
    }
    let rgba = image.data[..needed]
        .as_chunks::<4>()
        .0
        .iter()
        .flat_map(|&bytes| {
            let px = if little {
                u32::from_le_bytes(bytes)
            } else {
                u32::from_be_bytes(bytes)
            };
            [channel(px, red), channel(px, green), channel(px, blue), 255]
        })
        .collect();
    Ok(RawImage {
        width,
        height,
        rgba,
    })
}

/// Moving and resizing at once goes through GTK (Tauri's calls): the main window isn't
/// resizable, so its size hints would make the window manager refuse a resize sent directly.
pub fn set_window_rect(handle: WindowHandle, x: i32, y: i32, w: i32, h: i32) -> bool {
    window_rect(handle).is_some_and(|(_, _, cw, ch)| (cw, ch) == (w, h))
        && move_window(handle, x, y)
}

/// Moves a window without resizing it.
pub fn move_window(handle: WindowHandle, x_pos: i32, y_pos: i32) -> bool {
    let (Some(x), Some(w)) = (x(), window(handle)) else {
        return false;
    };
    let aux = ConfigureWindowAux::new().x(x_pos).y(y_pos);
    x.conn
        .configure_window(w, &aux)
        .map(|c| c.ignore_error())
        .is_ok()
        && x.conn.flush().is_ok()
}

/// A window's rectangle on screen (x, y, width, height).
pub fn window_rect(handle: WindowHandle) -> Option<(i32, i32, i32, i32)> {
    x()?.rect(window(handle)?)
}

/// The pointer on screen.
pub fn cursor_position() -> Option<(i32, i32)> {
    x()?.pointer()
        .map(|p| (i32::from(p.root_x), i32::from(p.root_y)))
}

/// Waits about one frame (60 Hz). X11 has no portable way to wait for the compositor.
pub fn wait_frame() {
    std::thread::sleep(Duration::from_millis(16));
}

/// GNOME's "Reduce animations" / GTK's `gtk-enable-animations`, read from GSettings once;
/// animations stay on when it can't be read.
pub fn animations_enabled() -> bool {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| {
        std::process::Command::new("gsettings")
            .args(["get", "org.gnome.desktop.interface", "enable-animations"])
            .stderr(std::process::Stdio::null())
            .output()
            .ok()
            .filter(|o| o.status.success())
            .is_none_or(|o| String::from_utf8_lossy(&o.stdout).trim() != "false")
    })
}

/// Limits where `window` takes clicks to the union of `rects` (window px), through the X Shape
/// extension's input region: clicks outside reach the windows underneath. The transparent rest
/// already shows nothing, so painting isn't clipped. Empty `rects` removes the limit.
pub fn set_window_region(handle: WindowHandle, rects: &[RoundRect]) {
    let (Some(x), Some(w)) = (x(), window(handle)) else {
        return;
    };
    let result = if rects.is_empty() {
        x.conn
            .shape_mask(shape::SO::SET, shape::SK::INPUT, w, 0, 0, NONE)
            .map(|c| c.ignore_error())
    } else {
        let strips: Vec<Rectangle> = region_strips(rects)
            .into_iter()
            .map(|(left, top, width, height)| Rectangle {
                x: left as i16,
                y: top as i16,
                width: width as u16,
                height: height as u16,
            })
            .collect();
        x.conn
            .shape_rectangles(
                shape::SO::SET,
                shape::SK::INPUT,
                ClipOrdering::UNSORTED,
                w,
                0,
                0,
                &strips,
            )
            .map(|c| c.ignore_error())
    };
    if result.is_ok() {
        let _ = x.conn.flush();
    }
}

/// Rounded rects as plain rects (x, y, width, height): a full-width middle, and one row per pixel
/// of each corner, inset to the curve and one pixel outside it like the Windows region.
pub(crate) fn region_strips(rects: &[RoundRect]) -> Vec<(i32, i32, i32, i32)> {
    let mut out = Vec::new();
    for r in rects {
        let (w, h) = (r.right - r.left, r.bottom - r.top);
        if w <= 0 || h <= 0 {
            continue;
        }
        let radius = r.radius.clamp(0, w.min(h) / 2);
        if radius <= 1 {
            out.push((r.left, r.top, w, h));
            continue;
        }
        out.push((r.left, r.top + radius, w, h - 2 * radius));
        let rad = f64::from(radius);
        for row in 0..radius {
            let dy = rad - f64::from(row) - 0.5;
            let inset = ((rad - (rad * rad - dy * dy).max(0.0).sqrt()).floor() as i32 - 1).max(0);
            let width = w - 2 * inset;
            out.push((r.left + inset, r.top + row, width, 1));
            out.push((r.left + inset, r.bottom - 1 - row, width, 1));
        }
    }
    out
}

// ---------------------------------------------------------------------------------------------
// Clipboard
//
// X11 has no clipboard store: the app that copied keeps the data and hands it to whoever asks.
// `Clip` is Winku's side of that: a hidden window that asks for selections (`read`) and serves
// what Winku put on the clipboard (`own`), with a thread that handles the events for both and
// counts clipboard changes (XFixes), the Linux stand-in for Windows' clipboard sequence number.
// What Winku owns is served until another app copies or Winku quits.

const COPY_TIMEOUT: Duration = Duration::from_millis(700);
const PASTE_RESTORE_DELAY: Duration = Duration::from_millis(500);
/// How long a single read may wait for the owner to answer.
const READ_TIMEOUT: Duration = Duration::from_millis(500);
/// Limits for saving the clipboard before a simulated copy or paste.
const SAVE_TARGETS_MAX: usize = 40;
const SAVE_BYTES_MAX: usize = 64 << 20;
/// Saving stops reading more targets after this long; what was read is restored.
const SAVE_TIME_MAX: Duration = Duration::from_millis(1500);

/// One target of a selection, as received or as served.
#[derive(Clone, Debug)]
struct Item {
    target: Atom,
    kind: Atom,
    format: u8,
    data: Vec<u8>,
}

struct Clip {
    conn: RustConnection,
    window: Window,
    atoms: Atoms,
    /// What Winku serves while it owns CLIPBOARD.
    served: Mutex<Option<Vec<Item>>>,
    /// One read at a time; reads wait on `replies`.
    reading: Mutex<mpsc::Receiver<Event>>,
}

/// Bumped on every clipboard change, Winku's own included.
static SEQUENCE: AtomicU32 = AtomicU32::new(1);

fn sequence() -> u32 {
    SEQUENCE.load(Ordering::SeqCst)
}

/// Changes another app made, for the history watcher.
static CHANGES: OnceLock<Mutex<mpsc::Sender<()>>> = OnceLock::new();

fn clip() -> Option<&'static Arc<Clip>> {
    static CLIP: OnceLock<Option<Arc<Clip>>> = OnceLock::new();
    CLIP.get_or_init(|| {
        let (conn, screen) = x11rb::connect(None).ok()?;
        let root = conn.setup().roots.get(screen)?.root;
        let atoms = Atoms::new(&conn).ok()?.reply().ok()?;
        let window = conn.generate_id().ok()?;
        conn.create_window(
            x11rb::COPY_DEPTH_FROM_PARENT,
            window,
            root,
            0,
            0,
            1,
            1,
            0,
            WindowClass::INPUT_OUTPUT,
            x11rb::COPY_FROM_PARENT,
            &CreateWindowAux::new().event_mask(EventMask::PROPERTY_CHANGE),
        )
        .ok()?
        .check()
        .ok()?;
        conn.xfixes_query_version(5, 0).ok()?.reply().ok()?;
        conn.xfixes_select_selection_input(
            window,
            atoms.CLIPBOARD,
            xfixes::SelectionEventMask::SET_SELECTION_OWNER
                | xfixes::SelectionEventMask::SELECTION_WINDOW_DESTROY
                | xfixes::SelectionEventMask::SELECTION_CLIENT_CLOSE,
        )
        .ok()?
        .check()
        .ok()?;
        conn.flush().ok()?;
        let (tx, rx) = mpsc::channel();
        let clip = Arc::new(Clip {
            conn,
            window,
            atoms,
            served: Mutex::new(None),
            reading: Mutex::new(rx),
        });
        let events = clip.clone();
        std::thread::Builder::new()
            .name("winku-clipboard".into())
            .spawn(move || events.run(tx))
            .ok()?;
        Some(clip)
    })
    .as_ref()
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

impl Clip {
    /// The event loop: serves requests for what Winku owns, passes replies to the waiting read,
    /// and counts clipboard changes.
    fn run(&self, replies: mpsc::Sender<Event>) {
        while let Ok(event) = self.conn.wait_for_event() {
            match event {
                Event::SelectionRequest(request) => self.serve(&request),
                Event::SelectionClear(clear) if clear.selection == self.atoms.CLIPBOARD => {
                    *lock(&self.served) = None;
                }
                Event::XfixesSelectionNotify(change)
                    if change.selection == self.atoms.CLIPBOARD =>
                {
                    // Winku's own takes are counted when they're made (`own`).
                    if change.owner != self.window {
                        SEQUENCE.fetch_add(1, Ordering::SeqCst);
                        if let Some(changes) = CHANGES.get() {
                            let _ = lock(changes).send(());
                        }
                    }
                }
                Event::SelectionNotify(_) | Event::PropertyNotify(_) => {
                    let _ = replies.send(event);
                }
                _ => {}
            }
        }
    }

    fn serve(&self, request: &SelectionRequestEvent) {
        let property = if request.property == NONE {
            request.target
        } else {
            request.property
        };
        let served = lock(&self.served);
        let items = served
            .as_deref()
            .filter(|_| request.selection == self.atoms.CLIPBOARD);
        let limit = self.conn.maximum_request_bytes().saturating_sub(64);
        let answered = match items {
            Some(items) if request.target == self.atoms.TARGETS => {
                let mut targets = vec![self.atoms.TARGETS, self.atoms.TIMESTAMP];
                targets.extend(items.iter().map(|i| i.target));
                self.conn
                    .change_property32(
                        PropMode::REPLACE,
                        request.requestor,
                        property,
                        AtomEnum::ATOM,
                        &targets,
                    )
                    .is_ok_and(|c| {
                        c.ignore_error();
                        true
                    })
            }
            Some(items) => match items.iter().find(|i| i.target == request.target) {
                Some(item) if item.data.len() <= limit => {
                    let unit = usize::from(item.format / 8).max(1);
                    self.conn
                        .change_property(
                            PropMode::REPLACE,
                            request.requestor,
                            property,
                            item.kind,
                            item.format,
                            (item.data.len() / unit) as u32,
                            &item.data,
                        )
                        .is_ok_and(|c| {
                            c.ignore_error();
                            true
                        })
                }
                _ => false,
            },
            None => false,
        };
        drop(served);
        let notify = SelectionNotifyEvent {
            response_type: SELECTION_NOTIFY_EVENT,
            sequence: 0,
            time: request.time,
            requestor: request.requestor,
            selection: request.selection,
            target: request.target,
            property: if answered { property } else { NONE },
        };
        if let Ok(c) = self
            .conn
            .send_event(false, request.requestor, EventMask::NO_EVENT, notify)
        {
            c.ignore_error();
        }
        let _ = self.conn.flush();
    }

    /// One target of a selection: (type, format, data). Large data comes in pieces (INCR).
    fn read(&self, selection: Atom, target: Atom) -> Option<(Atom, u8, Vec<u8>)> {
        let replies = lock(&self.reading);
        while replies.try_recv().is_ok() {}
        let property = self.atoms.WINKU_SELECTION;
        self.conn
            .delete_property(self.window, property)
            .ok()?
            .ignore_error();
        self.conn
            .convert_selection(self.window, selection, target, property, CURRENT_TIME)
            .ok()?
            .ignore_error();
        self.conn.flush().ok()?;
        let deadline = Instant::now() + READ_TIMEOUT;
        let wait = |deadline: Instant| {
            replies.recv_timeout(deadline.saturating_duration_since(Instant::now()))
        };
        loop {
            match wait(deadline).ok()? {
                Event::SelectionNotify(n) if n.selection == selection && n.target == target => {
                    if n.property == NONE {
                        return None;
                    }
                    break;
                }
                _ => continue,
            }
        }
        let get = || {
            self.conn
                .get_property(true, self.window, property, AtomEnum::ANY, 0, u32::MAX / 4)
                .ok()?
                .reply()
                .ok()
        };
        let first = get()?;
        if first.type_ != self.atoms.INCR {
            return Some((first.type_, first.format, first.value));
        }
        // INCR: deleting the property (just done) asks for the next piece; an empty piece ends it.
        let (mut kind, mut format, mut data) = (NONE, 8, Vec::new());
        loop {
            let deadline = Instant::now() + READ_TIMEOUT;
            match wait(deadline).ok()? {
                Event::PropertyNotify(p)
                    if p.window == self.window
                        && p.atom == property
                        && p.state == Property::NEW_VALUE =>
                {
                    let piece = get()?;
                    if piece.value.is_empty() {
                        return Some((kind, format, data));
                    }
                    (kind, format) = (piece.type_, piece.format);
                    data.extend_from_slice(&piece.value);
                    if data.len() > SAVE_BYTES_MAX {
                        return None;
                    }
                }
                _ => continue,
            }
        }
    }

    fn targets(&self, selection: Atom) -> Vec<Atom> {
        self.read(selection, self.atoms.TARGETS)
            .filter(|(_, format, _)| *format == 32)
            .map(|(_, _, data)| {
                data.as_chunks::<4>()
                    .0
                    .iter()
                    .map(|&c| u32::from_ne_bytes(c))
                    .collect()
            })
            .unwrap_or_default()
    }

    fn owner(&self, selection: Atom) -> Window {
        self.conn
            .get_selection_owner(selection)
            .ok()
            .and_then(|c| c.reply().ok())
            .map_or(NONE, |r| r.owner)
    }

    fn text(&self, selection: Atom) -> Option<String> {
        let a = &self.atoms;
        let targets = self.targets(selection);
        let wanted = [
            a.UTF8_STRING,
            a.TEXT_PLAIN_UTF8,
            AtomEnum::STRING.into(),
            a.TEXT,
        ];
        let order: Vec<Atom> = if targets.is_empty() {
            // Some owners answer conversions but not TARGETS.
            wanted.to_vec()
        } else {
            wanted.into_iter().filter(|t| targets.contains(t)).collect()
        };
        order.into_iter().find_map(|target| {
            let (_, _, data) = self.read(selection, target)?;
            let text = if target == Atom::from(AtomEnum::STRING) {
                data.iter().map(|&b| char::from(b)).collect()
            } else {
                String::from_utf8_lossy(&data).into_owned()
            };
            Some(text.trim_end_matches('\0').to_string())
        })
    }

    /// Takes the clipboard with `items` (none: empties it). Counted as one change.
    fn own(&self, items: Vec<Item>) -> bool {
        let empty = items.is_empty();
        *lock(&self.served) = (!empty).then_some(items);
        let owner = if empty { NONE } else { self.window };
        let set = self
            .conn
            .set_selection_owner(owner, self.atoms.CLIPBOARD, CURRENT_TIME)
            .map(|c| c.ignore_error())
            .is_ok()
            && self.conn.flush().is_ok();
        SEQUENCE.fetch_add(1, Ordering::SeqCst);
        set && (empty || self.owner(self.atoms.CLIPBOARD) == self.window)
    }

    /// Copies what the owner offers, for restoring. Text that is also offered as UTF-8 is read
    /// once and served again under its other names; other images are skipped when there is a
    /// PNG. Within limits (`SAVE_*`). When Winku owns the clipboard, its own items are copied.
    fn save(&self) -> Saved {
        let a = &self.atoms;
        let owner = self.owner(a.CLIPBOARD);
        if owner == NONE {
            return Saved::Empty;
        }
        if owner == self.window {
            return lock(&self.served)
                .clone()
                .map_or(Saved::Unreadable, Saved::Items);
        }
        let targets = self.targets(a.CLIPBOARD);
        let skip = [
            a.TARGETS,
            a.MULTIPLE,
            a.TIMESTAMP,
            a.SAVE_TARGETS,
            a.DELETE,
            a.INCR,
            a.PASSWORD_HINT,
            a.COMPOUND_TEXT,
        ];
        let text_aliases = [
            a.TEXT_PLAIN_UTF8,
            a.TEXT_PLAIN,
            AtomEnum::STRING.into(),
            a.TEXT,
        ];
        let has_utf8 = targets.contains(&a.UTF8_STRING);
        let has_png = targets.contains(&a.PNG);
        let started = Instant::now();
        let (mut total, mut items, mut aliases) = (0, Vec::new(), Vec::new());
        for &target in &targets {
            if skip.contains(&target) || items.len() >= SAVE_TARGETS_MAX {
                continue;
            }
            if has_utf8 && text_aliases.contains(&target) {
                aliases.push(target);
                continue;
            }
            if has_png && target != a.PNG && self.is_image(target) {
                continue;
            }
            if started.elapsed() > SAVE_TIME_MAX {
                break;
            }
            if let Some((kind, format, data)) = self.read(a.CLIPBOARD, target) {
                total += data.len();
                if total > SAVE_BYTES_MAX {
                    break;
                }
                items.push(Item {
                    target,
                    kind,
                    format,
                    data,
                });
            }
        }
        let utf8 = items
            .iter()
            .find(|i| i.target == a.UTF8_STRING)
            .map(|i| i.data.clone());
        if let Some(utf8) = utf8 {
            for target in aliases {
                items.push(self.text_alias(target, &utf8));
            }
        }
        if items.is_empty() {
            // An owner that didn't answer: putting back nothing would empty the clipboard.
            Saved::Unreadable
        } else {
            Saved::Items(items)
        }
    }

    fn is_image(&self, target: Atom) -> bool {
        self.conn
            .get_atom_name(target)
            .ok()
            .and_then(|c| c.reply().ok())
            .is_some_and(|r| r.name.starts_with(b"image/"))
    }

    /// UTF-8 text served under another text target's name.
    fn text_alias(&self, target: Atom, utf8: &[u8]) -> Item {
        let a = &self.atoms;
        if target == Atom::from(AtomEnum::STRING) {
            // STRING is Latin-1.
            let latin1 = String::from_utf8_lossy(utf8)
                .chars()
                .map(|c| u8::try_from(u32::from(c)).unwrap_or(b'?'))
                .collect();
            return Item {
                target,
                kind: target,
                format: 8,
                data: latin1,
            };
        }
        Item {
            target,
            kind: if target == a.TEXT {
                a.UTF8_STRING
            } else {
                target
            },
            format: 8,
            data: utf8.to_vec(),
        }
    }

    fn text_items(&self, text: &str) -> Vec<Item> {
        let a = &self.atoms;
        [a.UTF8_STRING, a.TEXT_PLAIN_UTF8, a.TEXT]
            .into_iter()
            .map(|target| Item {
                target,
                kind: a.UTF8_STRING,
                format: 8,
                data: text.as_bytes().to_vec(),
            })
            .collect()
    }

    /// The mark KDE's clipboard manager (and others) read to keep a copy out of their history:
    /// Winku's paste-back text and the clipboard it puts back, like the Windows formats.
    fn private_mark(&self) -> Item {
        Item {
            target: self.atoms.PASSWORD_HINT,
            kind: self.atoms.PASSWORD_HINT,
            format: 8,
            data: b"secret".to_vec(),
        }
    }

    fn marked_private(&self, targets: &[Atom]) -> bool {
        targets.contains(&self.atoms.PASSWORD_HINT)
            && self
                .read(self.atoms.CLIPBOARD, self.atoms.PASSWORD_HINT)
                .is_some_and(|(_, _, d)| d.trim_ascii() == b"secret")
    }

    fn kind(&self) -> (Kind, Vec<Atom>) {
        let a = &self.atoms;
        if self.owner(a.CLIPBOARD) == NONE {
            return (Kind::Empty, Vec::new());
        }
        let targets = self.targets(a.CLIPBOARD);
        let marked = self.marked_private(&targets);
        let kind = if crate::clipboard_history::with(|h| h.private(sequence(), marked)) {
            Kind::Private
        } else if targets.contains(&a.URI_LIST) || targets.contains(&a.GNOME_FILES) {
            Kind::Files
        } else if targets.contains(&a.PNG) {
            Kind::Image
        } else if targets.is_empty()
            || [
                a.UTF8_STRING,
                a.TEXT_PLAIN_UTF8,
                AtomEnum::STRING.into(),
                a.TEXT,
            ]
            .iter()
            .any(|t| targets.contains(t))
        {
            Kind::Text
        } else {
            Kind::Empty
        };
        (kind, targets)
    }

    fn files(&self, targets: &[Atom]) -> Vec<String> {
        let a = &self.atoms;
        let target = if targets.contains(&a.URI_LIST) {
            a.URI_LIST
        } else {
            a.GNOME_FILES
        };
        self.read(a.CLIPBOARD, target)
            .map(|(_, _, d)| crate::clipboard::decode_uri_list(&String::from_utf8_lossy(&d)))
            .unwrap_or_default()
    }

    fn png(&self) -> Option<Vec<u8>> {
        self.read(self.atoms.CLIPBOARD, self.atoms.PNG)
            .map(|(_, _, d)| d)
    }
}

enum Kind {
    Private,
    Files,
    Image,
    Text,
    Empty,
}

/// Clipboard contents saved for restoring.
enum Saved {
    /// Nobody owned the clipboard.
    Empty,
    Items(Vec<Item>),
    /// The owner didn't answer: the clipboard is left as the copy or paste leaves it.
    Unreadable,
}

impl Saved {
    /// Puts the saved targets back, marked so clipboard managers don't add them again.
    fn restore(self, clip: &Clip) {
        match self {
            Saved::Empty => {
                clip.own(Vec::new());
            }
            Saved::Items(mut items) => {
                if !items.iter().any(|i| i.target == clip.atoms.PASSWORD_HINT) {
                    items.push(clip.private_mark());
                }
                clip.own(items);
            }
            Saved::Unreadable => {}
        }
    }
}

/// Marks Winku's own clipboard changes until dropped, so the history skips them.
struct OwnChanges {
    id: u64,
    private: bool,
}

impl OwnChanges {
    fn begin() -> Self {
        Self {
            id: crate::clipboard_history::with(|h| h.begin_own(sequence())),
            private: false,
        }
    }
}

impl Drop for OwnChanges {
    fn drop(&mut self) {
        let (id, private) = (self.id, self.private);
        crate::clipboard_history::with(|h| h.end_own(id, sequence(), private));
    }
}

const NO_CLIPBOARD: &str = "The clipboard isn't available: Winku needs an X11 display.";

/// What is on the clipboard now (the clipboard_read tool). Private content is never read.
pub fn clipboard_read() -> Result<crate::clipboard::Raw, String> {
    use crate::clipboard::Raw;
    let clip = clip().ok_or(NO_CLIPBOARD)?;
    let (kind, targets) = clip.kind();
    Ok(match kind {
        Kind::Private => Raw::Private,
        Kind::Files => Raw::Files(clip.files(&targets)),
        Kind::Image => clip.png().map_or(Raw::Empty, Raw::Png),
        Kind::Text => match clip.text(clip.atoms.CLIPBOARD) {
            Some(text) if !text.is_empty() => Raw::Text(text),
            _ => Raw::Empty,
        },
        Kind::Empty => Raw::Empty,
    })
}

/// Replaces the clipboard with text (the clipboard_write tool). Unmarked: it is the user's
/// clipboard now, history included. Winku serves it until another app copies or Winku quits.
pub fn clipboard_write(text: &str) -> Result<(), String> {
    let clip = clip().ok_or(NO_CLIPBOARD)?;
    if clip.own(clip.text_items(text)) {
        Ok(())
    } else {
        Err("could not put the text on the clipboard".into())
    }
}

/// Kind and size of what is on the clipboard, for the now line. Text is read to count its
/// characters and dropped; an image's size comes from its PNG header.
pub fn clipboard_summary() -> Option<crate::clipboard::Summary> {
    use crate::clipboard::Summary;
    let clip = clip()?;
    let (kind, targets) = clip.kind();
    match kind {
        Kind::Private => Some(Summary::Private),
        Kind::Files => Some(Summary::Files(clip.files(&targets).len())),
        Kind::Image => {
            let (w, h) = crate::clipboard::png_size(&clip.png()?)?;
            Some(Summary::Image(w, h))
        }
        Kind::Text => {
            let chars = clip.text(clip.atoms.CLIPBOARD)?.chars().count();
            (chars > 0).then_some(Summary::Text(chars))
        }
        Kind::Empty => None,
    }
}

/// Selected text by simulating a copy, saving the clipboard first and restoring it after. None
/// when the copy didn't change the clipboard within 700 ms (nothing selected).
pub fn selection_via_copy() -> Option<String> {
    selection_via_copy_within(COPY_TIMEOUT)
}

/// `selection_via_copy`, waiting only `wait` for the app; a late copy (within 700 ms) is still
/// undone on a background thread.
pub fn selection_via_copy_within(wait: Duration) -> Option<String> {
    let clip = clip()?;
    let mut own = OwnChanges::begin();
    let (kind, _) = clip.kind();
    own.private = matches!(kind, Kind::Private);
    let saved = clip.save();
    let before = sequence();
    send_ctrl(b'c', foreground_is_terminal()).ok()?;
    let started = Instant::now();
    while sequence() == before {
        if started.elapsed() >= wait.min(COPY_TIMEOUT) {
            if wait < COPY_TIMEOUT {
                std::thread::spawn(move || restore_late_copy(own, saved, before, started));
            }
            return None;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    std::thread::sleep(Duration::from_millis(30));
    let text = clip.text(clip.atoms.CLIPBOARD);
    saved.restore(clip);
    text
}

fn restore_late_copy(own: OwnChanges, saved: Saved, before: u32, started: Instant) {
    while sequence() == before {
        if started.elapsed() >= COPY_TIMEOUT {
            return;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    std::thread::sleep(Duration::from_millis(30));
    if let Some(clip) = clip() {
        saved.restore(clip);
    }
    drop(own);
}

/// Pastes `text` into the foreground window (Ctrl+V, Ctrl+Shift+V in a terminal), then restores
/// the previous clipboard about 500 ms later unless something else has written to it since.
pub fn paste_text(text: &str) -> Result<(), String> {
    let clip = clip().ok_or(NO_CLIPBOARD)?;
    let own = OwnChanges::begin();
    let (kind, _) = clip.kind();
    let was_private = matches!(kind, Kind::Private);
    let saved = clip.save();
    let mut items = clip.text_items(text);
    items.push(clip.private_mark());
    if !clip.own(items) {
        return Err("could not put the result on the clipboard".into());
    }
    let ours = sequence();
    drop(own);
    let sent = send_ctrl(b'v', foreground_is_terminal());
    std::thread::spawn(move || {
        std::thread::sleep(PASTE_RESTORE_DELAY);
        if sequence() != ours {
            return;
        }
        let mut own = OwnChanges::begin();
        own.private = was_private;
        if let Some(clip) = self::clip() {
            saved.restore(clip);
        }
    });
    sent
}

/// Starts the clipboard history listener: each change another app makes is read on a thread of
/// its own and handed to the history (clipboard_history.rs). Safe to call once.
pub fn watch_clipboard() {
    let (tx, rx) = mpsc::channel();
    if CHANGES.set(Mutex::new(tx)).is_err() {
        return;
    }
    if clip().is_none() {
        eprintln!("winku: no X11 display, no clipboard history");
        return;
    }
    std::thread::spawn(move || {
        while rx.recv().is_ok() {
            // A burst of changes needs only one read: the newest content.
            std::thread::sleep(Duration::from_millis(20));
            while rx.try_recv().is_ok() {}
            on_clipboard_change();
        }
    });
}

fn on_clipboard_change() {
    use crate::clipboard_history::Change;
    let Some(clip) = clip() else { return };
    let seq = sequence();
    let (kind, _) = clip.kind();
    let change = match kind {
        Kind::Private => Change::Private,
        Kind::Text => clip
            .text(clip.atoms.CLIPBOARD)
            .map_or(Change::Other, Change::Text),
        Kind::Files | Kind::Image | Kind::Empty => Change::Other,
    };
    crate::clipboard_history::with(|h| h.observe(seq, change, Instant::now()));
}

// ---------------------------------------------------------------------------------------------
// Fullscreen watching

/// Calls `callback` with whether the active window is fullscreen (`_NET_WM_STATE_FULLSCREEN`,
/// not Winku's own, not the desktop) whenever the active window changes or changes state. A
/// thread sleeps on X events between changes: no polling.
pub fn watch_fullscreen(callback: Box<dyn Fn(bool) + Send>) {
    std::thread::Builder::new()
        .name("winku-fullscreen".into())
        .spawn(move || {
            let Some(()) = fullscreen_loop(&*callback) else {
                eprintln!("winku: no X11 display, fullscreen apps won't hide the eyes");
                return;
            };
        })
        .ok();
}

fn fullscreen_loop(callback: &dyn Fn(bool)) -> Option<()> {
    let (conn, screen) = x11rb::connect(None).ok()?;
    let root = conn.setup().roots.get(screen)?.root;
    let atoms = Atoms::new(&conn).ok()?.reply().ok()?;
    let watch = ChangeWindowAttributesAux::new().event_mask(EventMask::PROPERTY_CHANGE);
    conn.change_window_attributes(root, &watch)
        .ok()?
        .check()
        .ok()?;
    let prop32 = |window: Window, property: Atom, kind: AtomEnum| -> Vec<u32> {
        conn.get_property(false, window, property, kind, 0, 1024)
            .ok()
            .and_then(|c| c.reply().ok())
            .and_then(|r| r.value32().map(|v| v.collect()))
            .unwrap_or_default()
    };
    let mut active = NONE;
    let mut last = None;
    loop {
        let now = prop32(root, atoms._NET_ACTIVE_WINDOW, AtomEnum::WINDOW)
            .first()
            .copied()
            .unwrap_or(NONE);
        if now != active {
            if active != NONE {
                let quiet = ChangeWindowAttributesAux::new().event_mask(EventMask::NO_EVENT);
                if let Ok(c) = conn.change_window_attributes(active, &quiet) {
                    c.ignore_error();
                }
            }
            if now != NONE {
                if let Ok(c) = conn.change_window_attributes(now, &watch) {
                    c.ignore_error();
                }
            }
            active = now;
        }
        let fullscreen = active != NONE
            && prop32(active, atoms._NET_WM_STATE, AtomEnum::ATOM)
                .contains(&atoms._NET_WM_STATE_FULLSCREEN)
            && !prop32(active, atoms._NET_WM_WINDOW_TYPE, AtomEnum::ATOM)
                .contains(&atoms._NET_WM_WINDOW_TYPE_DESKTOP)
            && prop32(active, atoms._NET_WM_PID, AtomEnum::CARDINAL).first()
                != Some(&std::process::id());
        if last != Some(fullscreen) {
            last = Some(fullscreen);
            callback(fullscreen);
        }
        conn.flush().ok()?;
        // Wait for the active window to change, or the active window's state.
        loop {
            match conn.wait_for_event().ok()? {
                Event::PropertyNotify(p)
                    if (p.window == root && p.atom == atoms._NET_ACTIVE_WINDOW)
                        || (p.window == active && p.atom == atoms._NET_WM_STATE) =>
                {
                    break
                }
                _ => continue,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn square_rects_stay_whole() {
        let r = RoundRect {
            left: 10,
            top: 20,
            right: 110,
            bottom: 60,
            radius: 0,
        };
        assert_eq!(region_strips(&[r]), vec![(10, 20, 100, 40)]);
    }

    #[test]
    fn rounded_corners_are_inset_rows() {
        let r = RoundRect {
            left: 0,
            top: 0,
            right: 40,
            bottom: 20,
            radius: 10,
        };
        let strips = region_strips(&[r]);
        // The middle, then two rows per corner row.
        assert_eq!(strips[0], (0, 10, 40, 0));
        assert_eq!(strips.len(), 1 + 2 * 10);
        // The first row is inset the most; the last corner row hardly at all.
        let (first, last) = (strips[1], strips[strips.len() - 2]);
        assert!(first.0 > last.0);
        assert_eq!(first.1, 0);
        assert_eq!(strips[2].1, 19);
        // Every row stays within the rect.
        assert!(strips.iter().all(|s| s.0 >= 0 && s.0 + s.2 <= 40));
    }

    #[test]
    fn empty_rects_are_dropped() {
        let r = RoundRect {
            left: 5,
            top: 5,
            right: 5,
            bottom: 9,
            radius: 3,
        };
        assert!(region_strips(&[r]).is_empty());
    }
}
