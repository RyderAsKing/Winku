//! macOS (docs/adr/0004-macos-unsigned-build.md). Windows are Quartz window ids from the window
//! list (`CGWindowListCopyWindowInfo`), which also names their process; keys are Quartz events;
//! the selection comes from the Accessibility API; the clipboard is the general NSPasteboard,
//! whose change count stands in for Windows' clipboard sequence number.
//!
//! Three privacy permissions decide what works. Accessibility: reading the selection and the
//! simulated Cmd+C and Cmd+V. Screen Recording: window titles from the window list and captures.
//! Input Monitoring: the hotkey hints (hint/eventtap.rs). Without one, that feature quietly does
//! less; nothing else stops.

use std::ffi::c_void;
use std::ptr::NonNull;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, Instant};

use objc2::rc::{autoreleasepool, Retained};
use objc2::runtime::ProtocolObject;
use objc2_app_kit::{
    NSApplicationActivationOptions, NSBitmapImageFileType, NSBitmapImageRep, NSPasteboard,
    NSPasteboardItem, NSPasteboardTypeFileURL, NSPasteboardTypePNG, NSPasteboardTypeString,
    NSPasteboardTypeTIFF, NSPasteboardWriting, NSRunningApplication, NSWorkspace,
};
use objc2_core_foundation::{
    CFArray, CFBoolean, CFDictionary, CFNumber, CFRetained, CFString, CFType, CGRect,
};
use objc2_core_graphics::{
    kCGWindowBounds, kCGWindowLayer, kCGWindowName, kCGWindowNumber, kCGWindowOwnerPID,
    CGDisplayBounds, CGEvent, CGEventFlags, CGEventSource, CGEventSourceStateID,
    CGEventTapLocation, CGGetActiveDisplayList, CGMouseButton,
    CGRectMakeWithDictionaryRepresentation, CGWindowListCopyWindowInfo, CGWindowListOption,
};
use objc2_foundation::{NSArray, NSData, NSDictionary, NSString};

use super::{RawImage, RoundRect, WindowHandle};

// ---------------------------------------------------------------------------------------------
// Accessibility (HIServices), which objc2 doesn't wrap.

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrusted() -> u8;
    fn AXIsProcessTrustedWithOptions(options: *const c_void) -> u8;
    fn AXUIElementCreateSystemWide() -> *mut c_void;
    fn AXUIElementCreateApplication(pid: i32) -> *mut c_void;
    fn AXUIElementCopyAttributeValue(
        element: *const c_void,
        attribute: *const c_void,
        value: *mut *const c_void,
    ) -> i32;
    fn AXUIElementSetMessagingTimeout(element: *const c_void, seconds: f32) -> i32;
    static kAXTrustedCheckOptionPrompt: &'static CFString;
}

fn cf_ptr<T: ?Sized>(value: &T) -> *const c_void {
    (value as *const T).cast()
}

/// Whether Winku may use the Accessibility API (and post keystrokes).
fn trusted() -> bool {
    // SAFETY: no arguments.
    unsafe { AXIsProcessTrusted() != 0 }
}

const NEEDS_ACCESSIBILITY: &str = "Winku needs the Accessibility permission for this: System \
     Settings > Privacy & Security > Accessibility, then turn on Winku.";

/// Asks macOS to show its Accessibility prompt when Winku doesn't have the permission yet. The
/// prompt only offers to open System Settings; the user turns Winku on there.
pub fn request_accessibility() {
    if trusted() {
        return;
    }
    // SAFETY: a static CFString owned by the framework.
    let key: &CFString = unsafe { kAXTrustedCheckOptionPrompt };
    let options = CFDictionary::<CFString, CFBoolean>::from_slices(&[key], &[CFBoolean::new(true)]);
    // SAFETY: a valid CFDictionary.
    unsafe { AXIsProcessTrustedWithOptions(cf_ptr(&*options)) };
}

/// An AXUIElement.
struct Ax(CFRetained<CFType>);

impl Ax {
    fn adopt(raw: *mut c_void) -> Option<Ax> {
        // SAFETY: a +1 reference from a Create or Copy function.
        NonNull::new(raw.cast::<CFType>()).map(|p| Ax(unsafe { CFRetained::from_raw(p) }))
    }

    fn system() -> Option<Ax> {
        static TIMEOUT: std::sync::Once = std::sync::Once::new();
        // SAFETY: no arguments.
        let system = Ax::adopt(unsafe { AXUIElementCreateSystemWide() })?;
        // An app that doesn't answer shouldn't hold a summon up for the default six seconds.
        // SAFETY: a valid element.
        TIMEOUT.call_once(|| unsafe {
            AXUIElementSetMessagingTimeout(cf_ptr(&*system.0), 0.5);
        });
        Some(system)
    }

    fn app(pid: i32) -> Option<Ax> {
        // SAFETY: any pid; an unknown one gives an element whose queries fail.
        Ax::adopt(unsafe { AXUIElementCreateApplication(pid) })
    }

    fn attribute(&self, name: &str) -> Option<CFRetained<CFType>> {
        let name = CFString::from_str(name);
        let mut value: *const c_void = std::ptr::null();
        // SAFETY: valid element and attribute name; on success `value` is a +1 reference.
        let error =
            unsafe { AXUIElementCopyAttributeValue(cf_ptr(&*self.0), cf_ptr(&*name), &mut value) };
        if error != 0 {
            return None;
        }
        // SAFETY: as above.
        NonNull::new(value.cast_mut().cast::<CFType>()).map(|p| unsafe { CFRetained::from_raw(p) })
    }

    fn element(&self, name: &str) -> Option<Ax> {
        self.attribute(name).map(Ax)
    }

    fn string(&self, name: &str) -> Option<String> {
        let value = self.attribute(name)?.downcast::<CFString>().ok()?;
        Some(value.to_string())
    }
}

// ---------------------------------------------------------------------------------------------
// The window list

/// One window from the window list.
struct WindowInfo {
    id: u32,
    pid: i32,
    layer: i64,
    bounds: Option<CGRect>,
    /// Only with the Screen Recording permission.
    name: Option<String>,
}

fn window_list(option: CGWindowListOption, relative_to: u32) -> Vec<WindowInfo> {
    let Some(list) = CGWindowListCopyWindowInfo(option, relative_to) else {
        return Vec::new();
    };
    // SAFETY: the window list is an array of dictionaries with string keys.
    let list: CFRetained<CFArray<CFDictionary<CFString, CFType>>> =
        unsafe { CFRetained::cast_unchecked(list) };
    list.iter().filter_map(|d| window_info(&d)).collect()
}

fn window_info(d: &CFDictionary<CFString, CFType>) -> Option<WindowInfo> {
    // SAFETY: the keys are static CFStrings owned by the framework.
    let (number, layer, owner, bounds, name) = unsafe {
        (
            kCGWindowNumber,
            kCGWindowLayer,
            kCGWindowOwnerPID,
            kCGWindowBounds,
            kCGWindowName,
        )
    };
    let int = |key: &CFString| {
        d.get(key)
            .and_then(|v| v.downcast::<CFNumber>().ok())
            .and_then(|n| n.as_i64())
    };
    let bounds = d
        .get(bounds)
        .and_then(|v| v.downcast::<CFDictionary>().ok())
        .and_then(|b| {
            let mut rect = CGRect::default();
            // SAFETY: a bounds dictionary from the window list.
            unsafe { CGRectMakeWithDictionaryRepresentation(Some(&b), &mut rect) }.then_some(rect)
        });
    Some(WindowInfo {
        id: u32::try_from(int(number)?).ok()?,
        pid: i32::try_from(int(owner)?).ok()?,
        layer: int(layer).unwrap_or(0),
        bounds,
        name: d
            .get(name)
            .and_then(|v| v.downcast::<CFString>().ok())
            .map(|s| s.to_string())
            .filter(|s| !s.is_empty()),
    })
}

/// Windows on screen, front to back.
fn on_screen() -> Vec<WindowInfo> {
    window_list(
        CGWindowListOption::OptionOnScreenOnly | CGWindowListOption::ExcludeDesktopElements,
        0,
    )
}

fn window_id(handle: WindowHandle) -> Option<u32> {
    u32::try_from(handle.0).ok().filter(|&w| w != 0)
}

fn info(handle: WindowHandle) -> Option<WindowInfo> {
    let id = window_id(handle)?;
    window_list(CGWindowListOption::OptionIncludingWindow, id)
        .into_iter()
        .find(|w| w.id == id)
}

/// The process of the app in front.
fn front_pid() -> Option<i32> {
    autoreleasepool(|_| {
        NSWorkspace::sharedWorkspace()
            .frontmostApplication()
            .map(|app| app.processIdentifier())
    })
}

fn running_app(pid: i32) -> Option<Retained<NSRunningApplication>> {
    NSRunningApplication::runningApplicationWithProcessIdentifier(pid)
}

// ---------------------------------------------------------------------------------------------
// Windows and keys

/// Whether the primary mouse button is held.
pub fn mouse_button_down() -> bool {
    CGEventSource::button_state(
        CGEventSourceStateID::CombinedSessionState,
        CGMouseButton::Left,
    )
}

/// `Ctrl+Option` doesn't type characters on macOS (Option alone does).
pub fn altgr_keys() -> Option<Vec<char>> {
    Some(Vec::new())
}

/// The front app's frontmost ordinary window (layer 0), or its frontmost window of any kind
/// (Winku's own float above the others). 0 when the front app shows no window.
pub fn foreground_window() -> WindowHandle {
    let Some(pid) = front_pid() else {
        return WindowHandle(0);
    };
    let windows = on_screen();
    let mut own = windows.iter().filter(|w| w.pid == pid);
    let front = own
        .clone()
        .find(|w| w.layer == 0)
        .or_else(|| own.next())
        .map_or(0, |w| w.id);
    WindowHandle(front as isize)
}

/// The process that owns `window`.
pub fn window_pid(handle: WindowHandle) -> Option<u32> {
    info(handle).and_then(|w| u32::try_from(w.pid).ok())
}

/// The app's name, lowercase, e.g. "safari" or "google chrome".
pub fn process_name(handle: WindowHandle) -> Option<String> {
    let pid = info(handle)?.pid;
    autoreleasepool(|_| {
        let app = running_app(pid)?;
        let name = app.localizedName().map(|n| n.to_string()).or_else(|| {
            app.executableURL()
                .and_then(|u| u.lastPathComponent())
                .map(|n| n.to_string())
        })?;
        Some(name.to_lowercase())
    })
}

/// Brings `window`'s app to the front. True once it is.
pub fn focus_window(handle: WindowHandle) -> bool {
    let Some(pid) = info(handle).map(|w| w.pid) else {
        return false;
    };
    if front_pid() == Some(pid) {
        return true;
    }
    let activated = autoreleasepool(|_| {
        running_app(pid).is_some_and(|app| {
            app.activateWithOptions(NSApplicationActivationOptions::ActivateAllWindows)
        })
    });
    if !activated {
        return false;
    }
    let started = Instant::now();
    while started.elapsed() < Duration::from_millis(500) {
        if front_pid() == Some(pid) {
            // Let the app make its window key before keys are sent.
            std::thread::sleep(Duration::from_millis(50));
            return true;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    false
}

const MODIFIERS: [CGEventFlags; 4] = [
    CGEventFlags::MaskCommand,
    CGEventFlags::MaskControl,
    CGEventFlags::MaskAlternate,
    CGEventFlags::MaskShift,
];

fn modifiers_held() -> bool {
    let flags = CGEventSource::flags_state(CGEventSourceStateID::CombinedSessionState);
    MODIFIERS.iter().any(|&m| flags.contains(m))
}

/// Polls until Cmd, Ctrl, Option and Shift are all up, or `timeout` passes.
pub fn wait_for_modifiers_released(timeout: Duration) {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline && modifiers_held() {
        std::thread::sleep(Duration::from_millis(10));
    }
}

/// Virtual key codes of the modifier keys (Cmd, Shift, Caps Lock, Option, Ctrl, Fn, on both
/// sides).
const MODIFIER_KEYS: [u16; 10] = [54, 55, 56, 57, 58, 59, 60, 61, 62, 63];

/// Gets the hotkey's keys out of the way before a simulated keystroke: waits for its ordinary key
/// to come up. Modifiers still held don't matter: the simulated keys come from a private event
/// source and carry exactly the modifiers they set.
pub fn clear_keys_for_input(timeout: Duration) {
    let deadline = Instant::now() + timeout;
    let other_key_down = || {
        (0u16..128).any(|k| {
            !MODIFIER_KEYS.contains(&k)
                && CGEventSource::key_state(CGEventSourceStateID::CombinedSessionState, k)
        })
    };
    while Instant::now() < deadline && other_key_down() {
        std::thread::sleep(Duration::from_millis(10));
    }
}

/// ANSI key positions of C and V. Cmd shortcuts follow these on most layouts.
const KEY_C: u16 = 8;
const KEY_V: u16 = 9;

/// Sends Cmd+<key>. Needs the Accessibility permission; without it macOS drops the keys.
fn send_command(key: u16) -> Result<(), String> {
    if !trusted() {
        return Err(NEEDS_ACCESSIBILITY.into());
    }
    let source = CGEventSource::new(CGEventSourceStateID::Private);
    for down in [true, false] {
        let event = CGEvent::new_keyboard_event(source.as_deref(), key, down)
            .ok_or("could not make a key event")?;
        CGEvent::set_flags(Some(&event), CGEventFlags::MaskCommand);
        CGEvent::post(CGEventTapLocation::HIDEventTap, Some(&event));
        std::thread::sleep(Duration::from_millis(8));
    }
    Ok(())
}

/// The selected text of the focused control, through the Accessibility API. Nothing is copied.
pub fn selection_via_uia() -> Option<String> {
    if !trusted() {
        return None;
    }
    autoreleasepool(|_| {
        let focused = Ax::system()?.element("AXFocusedUIElement")?;
        focused.string("AXSelectedText").filter(|t| !t.is_empty())
    })
}

/// Readable text of a window. Not here: the engine reads windows through agent-desktop.
pub fn window_text(_window: WindowHandle) -> Option<String> {
    None
}

// ---------------------------------------------------------------------------------------------
// Window info and capture

/// True for windows that belong to Winku itself.
pub fn is_own_window(handle: WindowHandle) -> bool {
    window_pid(handle) == Some(std::process::id())
}

/// What stands in for a window's class names: the app's bundle id, and `Chrome_Framework` when
/// the app is built on Chromium (Chrome, Edge, Electron apps such as VS Code and Slack), which
/// turns on its full accessibility tree once an accessibility client reads it (see
/// `uia_switches_on_accessibility`).
pub fn input_window_classes(handle: WindowHandle) -> Vec<String> {
    let Some(pid) = info(handle).map(|w| w.pid) else {
        return Vec::new();
    };
    autoreleasepool(|_| {
        let Some(app) = running_app(pid) else {
            return Vec::new();
        };
        let mut classes: Vec<String> = app
            .bundleIdentifier()
            .map(|b| b.to_string())
            .into_iter()
            .collect();
        let bundle = app
            .bundleURL()
            .and_then(|u| u.path())
            .map(|p| std::path::PathBuf::from(p.to_string()));
        if bundle.is_some_and(|b| is_chromium_bundle(&b)) {
            classes.push("Chrome_Framework".into());
        }
        classes
    })
}

/// Chromium-based apps ship their engine as `<Name> Framework.framework` ("Google Chrome
/// Framework", "Electron Framework", "Chromium Embedded Framework").
fn is_chromium_bundle(bundle: &std::path::Path) -> bool {
    std::fs::read_dir(bundle.join("Contents/Frameworks")).is_ok_and(|entries| {
        entries.flatten().any(|e| {
            e.file_name()
                .to_string_lossy()
                .ends_with(" Framework.framework")
        })
    })
}

/// The window's title: from the window list (with the Screen Recording permission), else the
/// app's focused window through the Accessibility API.
pub fn window_title(handle: WindowHandle) -> Option<String> {
    let info = info(handle)?;
    if info.name.is_some() {
        return info.name;
    }
    if !trusted() {
        return None;
    }
    autoreleasepool(|_| {
        Ax::app(info.pid)?
            .element("AXFocusedWindow")?
            .string("AXTitle")
            .filter(|t| !t.is_empty())
    })
}

/// The window's pixels, through the `screencapture` tool (Quartz's own window capture is gone
/// from current SDKs). Needs the Screen Recording permission; without it the picture shows only
/// the desktop.
pub fn capture_window(handle: WindowHandle) -> Result<RawImage, String> {
    static COUNT: AtomicU32 = AtomicU32::new(0);
    let id = window_id(handle).ok_or("there is no window to capture")?;
    let path = std::env::temp_dir().join(format!(
        "winku-capture-{}-{}.png",
        std::process::id(),
        COUNT.fetch_add(1, Ordering::Relaxed)
    ));
    let status = std::process::Command::new("/usr/sbin/screencapture")
        .args(["-x", "-o", "-t", "png", &format!("-l{id}")])
        .arg(&path)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
    let bytes = std::fs::read(&path);
    let _ = std::fs::remove_file(&path);
    match (status, bytes) {
        (Ok(status), Ok(bytes)) if status.success() && !bytes.is_empty() => {
            crate::clipboard::decode_png(&bytes).ok_or_else(|| "could not read the capture".into())
        }
        _ => Err(
            "Capturing the window failed. Winku needs the Screen Recording permission: System \
             Settings > Privacy & Security > Screen Recording."
                .into(),
        ),
    }
}

/// Not here: Winku's own windows are placed through Tauri on macOS.
pub fn set_window_rect(_window: WindowHandle, _x: i32, _y: i32, _w: i32, _h: i32) -> bool {
    false
}

/// Not here, as `set_window_rect`.
pub fn move_window(_window: WindowHandle, _x: i32, _y: i32) -> bool {
    false
}

/// A window's rectangle on screen (x, y, width, height), in points from the top left of the main
/// display.
pub fn window_rect(handle: WindowHandle) -> Option<(i32, i32, i32, i32)> {
    let b = info(handle)?.bounds?;
    Some((
        b.origin.x.round() as i32,
        b.origin.y.round() as i32,
        b.size.width.round() as i32,
        b.size.height.round() as i32,
    ))
}

/// The pointer, in points from the top left of the main display.
pub fn cursor_position() -> Option<(i32, i32)> {
    let event = CGEvent::new(None)?;
    let at = CGEvent::location(Some(&event));
    Some((at.x.round() as i32, at.y.round() as i32))
}

/// Waits about one frame.
pub fn wait_frame() {
    std::thread::sleep(Duration::from_millis(8));
}

/// Off when the user asked for reduced motion.
pub fn animations_enabled() -> bool {
    autoreleasepool(|_| !NSWorkspace::sharedWorkspace().accessibilityDisplayShouldReduceMotion())
}

/// No-op: the window is transparent where nothing is drawn.
pub fn set_window_region(_window: WindowHandle, _rects: &[RoundRect]) {}

// ---------------------------------------------------------------------------------------------
// Clipboard
//
// The general pasteboard. Winku's own changes are marked with the nspasteboard.org transient
// type, which clipboard managers skip; password managers mark theirs concealed. macOS has no
// change notification, so the history polls the change count.

const COPY_TIMEOUT: Duration = Duration::from_millis(700);
const PASTE_RESTORE_DELAY: Duration = Duration::from_millis(500);
/// Limits for saving the clipboard before a simulated copy or paste.
const SAVE_BYTES_MAX: usize = 64 << 20;
const SAVE_TIME_MAX: Duration = Duration::from_millis(1500);
const POLL: Duration = Duration::from_millis(300);

const CONCEALED: &str = "org.nspasteboard.ConcealedType";
const TRANSIENT: &str = "org.nspasteboard.TransientType";

fn pasteboard() -> Retained<NSPasteboard> {
    NSPasteboard::generalPasteboard()
}

fn sequence() -> u32 {
    autoreleasepool(|_| pasteboard().changeCount() as u32)
}

enum Kind {
    Private,
    Files,
    Image,
    Text,
    Empty,
}

fn kind(pb: &NSPasteboard) -> Kind {
    let seq = pb.changeCount() as u32;
    let types: Vec<String> = pb
        .types()
        .map(|t| t.iter().map(|t| t.to_string()).collect())
        .unwrap_or_default();
    if types.is_empty() {
        return Kind::Empty;
    }
    let has = |t: &NSString| {
        let t = t.to_string();
        types.contains(&t)
    };
    let marked = types.iter().any(|t| t == CONCEALED || t == TRANSIENT);
    // SAFETY: static NSStrings owned by AppKit.
    let (file, string, png, tiff) = unsafe {
        (
            NSPasteboardTypeFileURL,
            NSPasteboardTypeString,
            NSPasteboardTypePNG,
            NSPasteboardTypeTIFF,
        )
    };
    if crate::clipboard_history::with(|h| h.private(seq, marked)) {
        Kind::Private
    } else if has(file) {
        Kind::Files
    } else if has(string) {
        // Before images: text copied from documents often comes with a picture of itself.
        Kind::Text
    } else if has(png) || has(tiff) {
        Kind::Image
    } else {
        Kind::Empty
    }
}

fn text(pb: &NSPasteboard) -> Option<String> {
    // SAFETY: a static NSString owned by AppKit.
    pb.stringForType(unsafe { NSPasteboardTypeString })
        .map(|s| s.to_string())
}

fn files(pb: &NSPasteboard) -> Vec<String> {
    // SAFETY: a static NSString owned by AppKit.
    let file = unsafe { NSPasteboardTypeFileURL };
    let urls: Vec<String> = pb
        .pasteboardItems()
        .map(|items| {
            items
                .iter()
                .filter_map(|i| i.stringForType(file).map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();
    crate::clipboard::decode_uri_list(&urls.join("\n"))
}

/// The clipboard's image as a PNG (TIFF, what most Mac apps copy, converted).
fn png(pb: &NSPasteboard) -> Option<Vec<u8>> {
    // SAFETY: static NSStrings owned by AppKit.
    let (png, tiff) = unsafe { (NSPasteboardTypePNG, NSPasteboardTypeTIFF) };
    if let Some(data) = pb.dataForType(png) {
        return Some(data.to_vec());
    }
    let tiff = pb.dataForType(tiff)?;
    let rep = NSBitmapImageRep::imageRepWithData(&tiff)?;
    // SAFETY: an empty properties dictionary.
    let data = unsafe {
        rep.representationUsingType_properties(NSBitmapImageFileType::PNG, &NSDictionary::new())
    }?;
    Some(data.to_vec())
}

fn image_size(pb: &NSPasteboard) -> Option<(u32, u32)> {
    // SAFETY: static NSStrings owned by AppKit.
    let (png, tiff) = unsafe { (NSPasteboardTypePNG, NSPasteboardTypeTIFF) };
    if let Some(data) = pb.dataForType(png) {
        return crate::clipboard::png_size(&data.to_vec());
    }
    let rep = NSBitmapImageRep::imageRepWithData(&*pb.dataForType(tiff)?)?;
    Some((
        u32::try_from(rep.pixelsWide()).ok()?,
        u32::try_from(rep.pixelsHigh()).ok()?,
    ))
}

/// Replaces the clipboard with text; `mark` adds the transient type so clipboard managers skip it.
fn write_text(pb: &NSPasteboard, text: &str, mark: bool) -> bool {
    pb.clearContents();
    // SAFETY: a static NSString owned by AppKit.
    let ok = pb.setString_forType(&NSString::from_str(text), unsafe { NSPasteboardTypeString });
    if ok && mark {
        pb.setData_forType(Some(&NSData::new()), &NSString::from_str(TRANSIENT));
    }
    ok
}

/// Clipboard contents saved for restoring: each item's types and their data.
enum Saved {
    Empty,
    Items(Vec<Vec<(String, Vec<u8>)>>),
    /// Nothing could be read: the clipboard is left as the copy or paste leaves it.
    Unreadable,
}

fn save(pb: &NSPasteboard) -> Saved {
    let Some(items) = pb.pasteboardItems() else {
        return Saved::Unreadable;
    };
    if items.is_empty() {
        return Saved::Empty;
    }
    let started = Instant::now();
    let mut bytes = 0usize;
    let mut saved = Vec::new();
    'items: for item in items.iter() {
        let mut types = Vec::new();
        for kind in item.types().iter() {
            if started.elapsed() > SAVE_TIME_MAX || bytes > SAVE_BYTES_MAX {
                if !types.is_empty() {
                    saved.push(types);
                }
                break 'items;
            }
            if let Some(data) = item.dataForType(&kind) {
                bytes += data.length();
                types.push((kind.to_string(), data.to_vec()));
            }
        }
        if !types.is_empty() {
            saved.push(types);
        }
    }
    if saved.is_empty() {
        Saved::Unreadable
    } else {
        Saved::Items(saved)
    }
}

impl Saved {
    /// Puts the saved items back, marked so clipboard managers don't add them again.
    fn restore(self, pb: &NSPasteboard) {
        match self {
            Saved::Empty => {
                pb.clearContents();
            }
            Saved::Items(items) => {
                let transient = NSString::from_str(TRANSIENT);
                let objects: Vec<Retained<ProtocolObject<dyn NSPasteboardWriting>>> = items
                    .iter()
                    .enumerate()
                    .map(|(i, types)| {
                        let item = NSPasteboardItem::new();
                        for (kind, data) in types {
                            item.setData_forType(
                                &NSData::with_bytes(data),
                                &NSString::from_str(kind),
                            );
                        }
                        if i == 0 && !types.iter().any(|(k, _)| k == CONCEALED) {
                            item.setData_forType(&NSData::new(), &transient);
                        }
                        ProtocolObject::from_retained(item)
                    })
                    .collect();
                pb.clearContents();
                pb.writeObjects(&NSArray::from_retained_slice(&objects));
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

/// What is on the clipboard now (the clipboard_read tool). Private content is never read.
pub fn clipboard_read() -> Result<crate::clipboard::Raw, String> {
    use crate::clipboard::Raw;
    Ok(autoreleasepool(|_| {
        let pb = pasteboard();
        match kind(&pb) {
            Kind::Private => Raw::Private,
            Kind::Files => Raw::Files(files(&pb)),
            Kind::Image => png(&pb).map_or(Raw::Empty, Raw::Png),
            Kind::Text => match text(&pb) {
                Some(text) if !text.is_empty() => Raw::Text(text),
                _ => Raw::Empty,
            },
            Kind::Empty => Raw::Empty,
        }
    }))
}

/// Replaces the clipboard with text (the clipboard_write tool). Unmarked: it is the user's
/// clipboard now, history included.
pub fn clipboard_write(text: &str) -> Result<(), String> {
    if autoreleasepool(|_| write_text(&pasteboard(), text, false)) {
        Ok(())
    } else {
        Err("could not put the text on the clipboard".into())
    }
}

/// Kind and size of what is on the clipboard, for the now line.
pub fn clipboard_summary() -> Option<crate::clipboard::Summary> {
    use crate::clipboard::Summary;
    autoreleasepool(|_| {
        let pb = pasteboard();
        match kind(&pb) {
            Kind::Private => Some(Summary::Private),
            Kind::Files => Some(Summary::Files(files(&pb).len())),
            Kind::Image => image_size(&pb).map(|(w, h)| Summary::Image(w, h)),
            Kind::Text => {
                let chars = text(&pb)?.chars().count();
                (chars > 0).then_some(Summary::Text(chars))
            }
            Kind::Empty => None,
        }
    })
}

/// Selected text by simulating Cmd+C, saving the clipboard first and restoring it after. None
/// when the copy didn't change the clipboard within 700 ms (nothing selected). Cmd+C is safe in
/// terminals on macOS: it never interrupts the running program.
pub fn selection_via_copy() -> Option<String> {
    selection_via_copy_within(COPY_TIMEOUT)
}

/// `selection_via_copy`, waiting only `wait` for the app; a late copy (within 700 ms) is still
/// undone on a background thread.
pub fn selection_via_copy_within(wait: Duration) -> Option<String> {
    if !trusted() {
        return None;
    }
    let mut own = OwnChanges::begin();
    let saved = autoreleasepool(|_| {
        let pb = pasteboard();
        own.private = matches!(kind(&pb), Kind::Private);
        save(&pb)
    });
    let before = sequence();
    send_command(KEY_C).ok()?;
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
    autoreleasepool(|_| {
        let pb = pasteboard();
        let text = text(&pb);
        saved.restore(&pb);
        text
    })
}

fn restore_late_copy(own: OwnChanges, saved: Saved, before: u32, started: Instant) {
    while sequence() == before {
        if started.elapsed() >= COPY_TIMEOUT {
            return;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    autoreleasepool(|_| saved.restore(&pasteboard()));
    drop(own);
}

/// Pastes `text` into the app in front (Cmd+V), then restores the previous clipboard about
/// 500 ms later unless something else has written to it since.
pub fn paste_text(text: &str) -> Result<(), String> {
    if !trusted() {
        return Err(NEEDS_ACCESSIBILITY.into());
    }
    let own = OwnChanges::begin();
    let (was_private, saved, written) = autoreleasepool(|_| {
        let pb = pasteboard();
        let was_private = matches!(kind(&pb), Kind::Private);
        let saved = save(&pb);
        (was_private, saved, write_text(&pb, text, true))
    });
    if !written {
        return Err("could not put the result on the clipboard".into());
    }
    let ours = sequence();
    drop(own);
    let sent = send_command(KEY_V);
    std::thread::spawn(move || {
        std::thread::sleep(PASTE_RESTORE_DELAY);
        if sequence() != ours {
            return;
        }
        let mut own = OwnChanges::begin();
        own.private = was_private;
        autoreleasepool(|_| saved.restore(&pasteboard()));
    });
    sent
}

/// Starts the clipboard history listener: a thread checks the change count every 300 ms and
/// hands each change another app made to the history (clipboard_history.rs). Safe to call once.
pub fn watch_clipboard() {
    static STARTED: std::sync::OnceLock<()> = std::sync::OnceLock::new();
    if STARTED.set(()).is_err() {
        return;
    }
    std::thread::Builder::new()
        .name("winku-clipboard".into())
        .spawn(|| {
            let mut last = sequence();
            loop {
                std::thread::sleep(POLL);
                let now = sequence();
                if now != last {
                    last = now;
                    on_clipboard_change();
                }
            }
        })
        .ok();
}

fn on_clipboard_change() {
    use crate::clipboard_history::Change;
    let (seq, change) = autoreleasepool(|_| {
        let pb = pasteboard();
        let seq = pb.changeCount() as u32;
        let change = match kind(&pb) {
            Kind::Private => Change::Private,
            Kind::Text => text(&pb).map_or(Change::Other, Change::Text),
            Kind::Files | Kind::Image | Kind::Empty => Change::Other,
        };
        (seq, change)
    });
    crate::clipboard_history::with(|h| h.observe(seq, change, Instant::now()));
}

// ---------------------------------------------------------------------------------------------
// Fullscreen watching

/// Calls `callback` with whether the app in front fills a whole display (a fullscreen app or
/// game, not Winku) whenever that changes. macOS has no event for it, so a thread looks once a
/// second; the window list is cheap to read.
pub fn watch_fullscreen(callback: Box<dyn Fn(bool) + Send>) {
    std::thread::Builder::new()
        .name("winku-fullscreen".into())
        .spawn(move || {
            let mut last = None;
            loop {
                let now = front_is_fullscreen();
                if last != Some(now) {
                    last = Some(now);
                    callback(now);
                }
                std::thread::sleep(Duration::from_secs(1));
            }
        })
        .ok();
}

fn front_is_fullscreen() -> bool {
    let Some(pid) = front_pid() else {
        return false;
    };
    if u32::try_from(pid).ok() == Some(std::process::id()) {
        return false;
    }
    let Some(bounds) = on_screen()
        .into_iter()
        .find(|w| w.pid == pid && w.layer == 0)
        .and_then(|w| w.bounds)
    else {
        return false;
    };
    displays().iter().any(|d| {
        let same = |a: f64, b: f64| (a - b).abs() < 1.0;
        same(d.origin.x, bounds.origin.x)
            && same(d.origin.y, bounds.origin.y)
            && same(d.size.width, bounds.size.width)
            && same(d.size.height, bounds.size.height)
    })
}

fn displays() -> Vec<CGRect> {
    let mut ids = [0u32; 16];
    let mut count = 0u32;
    // SAFETY: the buffer holds 16 ids and the count is written back.
    let error = unsafe { CGGetActiveDisplayList(16, ids.as_mut_ptr(), &mut count) };
    if error.0 != 0 {
        return Vec::new();
    }
    ids[..count.min(16) as usize]
        .iter()
        .map(|&id| CGDisplayBounds(id))
        .collect()
}
