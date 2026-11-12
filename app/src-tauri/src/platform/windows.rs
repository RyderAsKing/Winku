//! Windows implementations.

use std::sync::mpsc;
use std::time::{Duration, Instant};

use windows_sys::Win32::Foundation::{CloseHandle, GlobalFree, HANDLE, HWND};
use windows_sys::Win32::System::DataExchange::{
    AddClipboardFormatListener, CloseClipboard, EmptyClipboard, EnumClipboardFormats,
    GetClipboardData, GetClipboardSequenceNumber, IsClipboardFormatAvailable, OpenClipboard,
    RegisterClipboardFormatW, SetClipboardData,
};
use windows_sys::Win32::System::Memory::{
    GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock, GMEM_MOVEABLE,
};
use windows_sys::Win32::System::Threading::{
    AttachThreadInput, GetCurrentProcessId, GetCurrentThreadId, OpenProcess,
    QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, GetKeyboardLayout, MapVirtualKeyW, SendInput, VkKeyScanExW, INPUT, INPUT_0,
    INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, MAPVK_VK_TO_VSC, VK_CONTROL, VK_LBUTTON, VK_LWIN,
    VK_MENU, VK_RWIN, VK_SHIFT,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    BringWindowToTop, CreateWindowExW, DestroyWindow, GetForegroundWindow, GetWindowRect,
    GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId, IsIconic, IsWindow,
    SetForegroundWindow, ShowWindow, HWND_MESSAGE, SW_RESTORE,
};

use super::{RawImage, RoundRect, WindowHandle};

/// Whether the primary mouse button is held: the right one when the buttons are swapped.
pub fn mouse_button_down() -> bool {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::VK_RBUTTON;
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_SWAPBUTTON};
    // SAFETY: plain Win32 call with no pointers.
    let swapped = unsafe { GetSystemMetrics(SM_SWAPBUTTON) } != 0;
    key_down(if swapped { VK_RBUTTON } else { VK_LBUTTON })
}

fn key_down(vk: u16) -> bool {
    // SAFETY: plain Win32 call with no pointers.
    unsafe { (GetAsyncKeyState(i32::from(vk)) as u16 & 0x8000) != 0 }
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

// ---------------------------------------------------------------------------------------------
// Windows and keys

pub fn foreground_window() -> WindowHandle {
    // SAFETY: plain Win32 call.
    WindowHandle(unsafe { GetForegroundWindow() } as isize)
}

/// Lower-case executable file name of the process that owns `window`, e.g. "outlook.exe".
pub fn process_name(window: WindowHandle) -> Option<String> {
    let hwnd = window.0 as HWND;
    // SAFETY: Win32 calls; the process handle is closed before returning.
    unsafe {
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, &mut pid);
        if pid == 0 {
            return None;
        }
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if process.is_null() {
            return None;
        }
        let mut buffer = [0u16; 1024];
        let mut len = buffer.len() as u32;
        let ok =
            QueryFullProcessImageNameW(process, PROCESS_NAME_WIN32, buffer.as_mut_ptr(), &mut len);
        CloseHandle(process);
        if ok == 0 {
            return None;
        }
        let path = String::from_utf16_lossy(&buffer[..len as usize]);
        path.rsplit(['\\', '/']).next().map(str::to_ascii_lowercase)
    }
}

/// Brings `window` to the front. True when it ended up in the foreground.
pub fn focus_window(window: WindowHandle) -> bool {
    let hwnd = window.0 as HWND;
    // SAFETY: Win32 calls on a window handle that may be stale; IsWindow checks it first.
    unsafe {
        if hwnd.is_null() || IsWindow(hwnd) == 0 {
            return false;
        }
        if GetForegroundWindow() == hwnd {
            return true;
        }
        if IsIconic(hwnd) != 0 {
            ShowWindow(hwnd, SW_RESTORE);
        }
        if SetForegroundWindow(hwnd) != 0 && GetForegroundWindow() == hwnd {
            return true;
        }
        // The foreground lock can refuse us; sharing input state with the current foreground
        // thread lets SetForegroundWindow through.
        let current = GetCurrentThreadId();
        let foreground = GetWindowThreadProcessId(GetForegroundWindow(), std::ptr::null_mut());
        let attached = foreground != 0
            && foreground != current
            && AttachThreadInput(current, foreground, 1) != 0;
        BringWindowToTop(hwnd);
        SetForegroundWindow(hwnd);
        if attached {
            AttachThreadInput(current, foreground, 0);
        }
        GetForegroundWindow() == hwnd
    }
}

/// Polls until Ctrl, Alt, Shift and Win are all up, or `timeout` passes.
pub fn wait_for_modifiers_released(timeout: Duration) {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if ![VK_CONTROL, VK_MENU, VK_SHIFT, VK_LWIN, VK_RWIN]
            .into_iter()
            .any(key_down)
        {
            return;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn key_input(vk: u16, up: bool) -> INPUT {
    // SAFETY: plain Win32 call.
    let scan = unsafe { MapVirtualKeyW(u32::from(vk), MAPVK_VK_TO_VSC) } as u16;
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: vk,
                wScan: scan,
                dwFlags: if up { KEYEVENTF_KEYUP } else { 0 },
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

/// Sends Ctrl+<key> (key is an uppercase ASCII letter, which is also its virtual-key code).
fn send_ctrl(key: u8) -> Result<(), String> {
    let vk = u16::from(key);
    let inputs = [
        key_input(VK_CONTROL, false),
        key_input(vk, false),
        key_input(vk, true),
        key_input(VK_CONTROL, true),
    ];
    // SAFETY: the pointer and count describe `inputs`.
    let sent = unsafe {
        SendInput(
            inputs.len() as u32,
            inputs.as_ptr(),
            std::mem::size_of::<INPUT>() as i32,
        )
    };
    if sent as usize == inputs.len() {
        Ok(())
    } else {
        Err("Windows blocked the simulated keystroke".into())
    }
}

// ---------------------------------------------------------------------------------------------
// UI Automation

const UIA_TIMEOUT: Duration = Duration::from_millis(300);

/// The focused element's selected text through UI Automation's TextPattern. None when the
/// element has no text pattern, nothing is selected, or UIA takes longer than 300 ms (the
/// worker thread is then left to finish on its own).
pub fn selection_via_uia() -> Option<String> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(uia_selection_on_this_thread());
    });
    rx.recv_timeout(UIA_TIMEOUT).ok().flatten()
}

/// Runs `f` with COM initialised (multithreaded) on this thread.
fn with_com<T>(f: impl FnOnce() -> Option<T>) -> Option<T> {
    use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED};

    struct Com;
    impl Drop for Com {
        fn drop(&mut self) {
            // SAFETY: paired with the successful CoInitializeEx below, on the same thread.
            unsafe { CoUninitialize() };
        }
    }
    // SAFETY: plain COM initialisation; `f` drops its interfaces before `_com`.
    unsafe { CoInitializeEx(None, COINIT_MULTITHREADED).ok().ok()? };
    let _com = Com;
    f()
}

fn automation() -> windows::core::Result<windows::Win32::UI::Accessibility::IUIAutomation> {
    use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_INPROC_SERVER};
    use windows::Win32::UI::Accessibility::CUIAutomation;
    // SAFETY: COM is initialised on this thread (with_com).
    unsafe { CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER) }
}

fn uia_selection_on_this_thread() -> Option<String> {
    use windows::core::Interface;
    use windows::Win32::UI::Accessibility::{
        IUIAutomationTextPattern, IUIAutomationTextPattern2, UIA_TextPattern2Id, UIA_TextPatternId,
    };

    with_com(|| {
        // SAFETY: COM calls on this thread.
        let text = (|| -> windows::core::Result<String> {
            unsafe {
                let element = automation()?.GetFocusedElement()?;
                let pattern: IUIAutomationTextPattern = match element
                    .GetCurrentPatternAs::<IUIAutomationTextPattern>(UIA_TextPatternId)
                {
                    Ok(pattern) => pattern,
                    Err(_) => element
                        .GetCurrentPatternAs::<IUIAutomationTextPattern2>(UIA_TextPattern2Id)?
                        .cast()?,
                };
                let ranges = pattern.GetSelection()?;
                let mut text = String::new();
                for i in 0..ranges.Length()? {
                    let range = ranges.GetElement(i)?;
                    let part = range.GetText(-1)?.to_string();
                    if !text.is_empty() && !part.is_empty() {
                        text.push('\n');
                    }
                    text.push_str(&part);
                }
                Ok(text)
            }
        })();
        text.ok().filter(|t| !t.is_empty())
    })
}

/// What the focused element has selected, for the hotkey guide: whether any text is selected and
/// whether it can be edited. Never reads the text. Unlike `selection_via_uia` it is asked of
/// every app, Chromium-based ones included (SPEC §7). None when the element exposes no text, or
/// UIA takes longer than 300 ms (the worker thread is then left to finish on its own).
pub fn selection_summary() -> Option<super::Selection> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(uia_selection_summary_on_this_thread());
    });
    rx.recv_timeout(UIA_TIMEOUT).ok().flatten()
}

fn uia_selection_summary_on_this_thread() -> Option<super::Selection> {
    use super::{SelectedText, Selection};
    use windows::core::Interface;
    use windows::Win32::System::Variant::{VariantClear, VT_BOOL};
    use windows::Win32::UI::Accessibility::{
        IUIAutomationTextPattern, IUIAutomationTextPattern2, IUIAutomationValuePattern,
        UIA_IsReadOnlyAttributeId, UIA_TextPattern2Id, UIA_TextPatternId, UIA_ValuePatternId,
    };

    with_com(|| {
        // SAFETY: COM calls on this thread.
        let summary = (|| -> windows::core::Result<Selection> {
            unsafe {
                let element = automation()?.GetFocusedElement()?;
                let pattern: IUIAutomationTextPattern = match element
                    .GetCurrentPatternAs::<IUIAutomationTextPattern>(UIA_TextPatternId)
                {
                    Ok(pattern) => pattern,
                    Err(_) => element
                        .GetCurrentPatternAs::<IUIAutomationTextPattern2>(UIA_TextPattern2Id)?
                        .cast()?,
                };
                let ranges = pattern.GetSelection()?;
                let mut first = None;
                for i in 0..ranges.Length()? {
                    let range = ranges.GetElement(i)?;
                    // One character is enough to know the range isn't an empty caret.
                    if !range.GetText(1)?.is_empty() {
                        first = Some(range);
                        break;
                    }
                }
                let Some(range) = first else {
                    return Ok(Selection::Nothing);
                };
                // The range's own attribute first. Mixed or unsupported values come back as an
                // object, not a bool; then the element's value pattern decides.
                let flag = range
                    .GetAttributeValue(UIA_IsReadOnlyAttributeId)
                    .ok()
                    .and_then(|mut attribute| {
                        let flag = (attribute.Anonymous.Anonymous.vt == VT_BOOL)
                            .then(|| attribute.Anonymous.Anonymous.Anonymous.boolVal.0 != 0);
                        let _ = VariantClear(&mut attribute);
                        flag
                    });
                // Neither answers: assume editable, as the guide did before it asked.
                let read_only = match flag {
                    Some(read_only) => read_only,
                    None => element
                        .GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)
                        .and_then(|p| p.CurrentIsReadOnly())
                        .map(|b| b.as_bool())
                        .unwrap_or(false),
                };
                Ok(Selection::Text(SelectedText {
                    editable: !read_only,
                }))
            }
        })();
        summary.ok()
    })
}

const WINDOW_TEXT_TIMEOUT: Duration = Duration::from_millis(500);
const WINDOW_TEXT_CAP: usize = 8000;
const WINDOW_TEXT_MAX_NODES: usize = 4000;

/// Readable text of `window` through UI Automation: a walk of the control view collecting
/// names, values and document text, skipping offscreen elements and repeats. Time-boxed to
/// about 500 ms (a slow app's worker thread is left to finish on its own) and capped.
pub fn window_text(window: WindowHandle) -> Option<String> {
    let (tx, rx) = mpsc::channel();
    let deadline = Instant::now() + WINDOW_TEXT_TIMEOUT;
    std::thread::spawn(move || {
        let _ = tx.send(with_com(|| uia_window_text(window, deadline)));
    });
    // The walk stops itself at the deadline; the extra margin lets it hand back what it has.
    rx.recv_timeout(WINDOW_TEXT_TIMEOUT + Duration::from_millis(150))
        .ok()
        .flatten()
}

fn uia_window_text(window: WindowHandle, deadline: Instant) -> Option<String> {
    use windows::Win32::Foundation::HWND as WinHwnd;
    use windows::Win32::UI::Accessibility::{
        IUIAutomationElement, IUIAutomationTextPattern, IUIAutomationValuePattern,
        UIA_TextPatternId, UIA_ValuePatternId,
    };

    let mut seen = std::collections::HashSet::new();
    let mut out = String::new();
    let mut add = |text: String, out: &mut String| {
        for line in text.lines().map(str::trim).filter(|l| !l.is_empty()) {
            if out.len() >= WINDOW_TEXT_CAP * 4 || !seen.insert(line.to_string()) {
                continue;
            }
            out.push_str(line);
            out.push('\n');
        }
    };
    // SAFETY: COM calls on this thread (with_com); the HWND may be stale, which UIA reports
    // as an error.
    unsafe {
        let automation = automation().ok()?;
        let root = automation
            .ElementFromHandle(WinHwnd(window.0 as *mut _))
            .ok()?;
        let walker = automation.ControlViewWalker().ok()?;
        let mut stack: Vec<IUIAutomationElement> = vec![root];
        let mut nodes = 0;
        while let Some(element) = stack.pop() {
            nodes += 1;
            if Instant::now() >= deadline
                || nodes > WINDOW_TEXT_MAX_NODES
                || out.chars().count() >= WINDOW_TEXT_CAP
            {
                break;
            }
            if element.CurrentIsOffscreen().is_ok_and(|b| b.as_bool()) {
                continue;
            }
            // Documents: their text covers their children.
            if let Ok(pattern) =
                element.GetCurrentPatternAs::<IUIAutomationTextPattern>(UIA_TextPatternId)
            {
                if let Ok(text) = pattern
                    .DocumentRange()
                    .and_then(|r| r.GetText(WINDOW_TEXT_CAP as i32))
                {
                    add(text.to_string(), &mut out);
                    continue;
                }
            }
            if let Ok(name) = element.CurrentName() {
                add(name.to_string(), &mut out);
            }
            if let Ok(value) = element
                .GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)
                .and_then(|p| p.CurrentValue())
            {
                add(value.to_string(), &mut out);
            }
            // Push children in reverse so they're visited in order.
            let mut children = Vec::new();
            let mut child = walker.GetFirstChildElement(&element).ok();
            while let Some(c) = child {
                child = walker.GetNextSiblingElement(&c).ok();
                children.push(c);
            }
            stack.extend(children.into_iter().rev());
        }
    }
    let text = out.trim_end();
    (!text.is_empty()).then(|| text.chars().take(WINDOW_TEXT_CAP).collect())
}

// ---------------------------------------------------------------------------------------------
// Window info and capture

/// True for windows that belong to Winku itself.
pub fn is_own_window(window: WindowHandle) -> bool {
    let mut pid = 0u32;
    // SAFETY: plain Win32 calls.
    unsafe {
        GetWindowThreadProcessId(window.0 as HWND, &mut pid);
        pid != 0 && pid == GetCurrentProcessId()
    }
}

/// Class names of `window` and of the window with keyboard focus in its thread (a browser's
/// render widget, or a WebView2 inside another app's frame).
pub fn input_window_classes(window: WindowHandle) -> Vec<String> {
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetGUIThreadInfo, GUITHREADINFO};

    let class_of = |hwnd: HWND| {
        let mut class = [0u16; 128];
        // SAFETY: the buffer length is passed with the pointer; a stale HWND returns 0.
        let len = unsafe { GetClassNameW(hwnd, class.as_mut_ptr(), class.len() as i32) };
        (len > 0).then(|| String::from_utf16_lossy(&class[..len as usize]))
    };
    let hwnd = window.0 as HWND;
    let mut classes: Vec<String> = class_of(hwnd).into_iter().collect();
    // SAFETY: GUITHREADINFO is plain data sized by cbSize; the thread id may be stale.
    unsafe {
        let thread = GetWindowThreadProcessId(hwnd, std::ptr::null_mut());
        let mut info: GUITHREADINFO = std::mem::zeroed();
        info.cbSize = std::mem::size_of::<GUITHREADINFO>() as u32;
        if thread != 0
            && GetGUIThreadInfo(thread, &mut info) != 0
            && !info.hwndFocus.is_null()
            && info.hwndFocus != hwnd
        {
            classes.extend(class_of(info.hwndFocus));
        }
    }
    classes
}

pub fn window_title(window: WindowHandle) -> Option<String> {
    let hwnd = window.0 as HWND;
    // SAFETY: the buffer length is passed with the pointer.
    unsafe {
        let len = GetWindowTextLengthW(hwnd);
        if len <= 0 {
            return None;
        }
        let mut buffer = vec![0u16; len as usize + 1];
        let copied = GetWindowTextW(hwnd, buffer.as_mut_ptr(), buffer.len() as i32);
        (copied > 0).then(|| String::from_utf16_lossy(&buffer[..copied as usize]))
    }
}

/// The window's pixels: PrintWindow with PW_RENDERFULLCONTENT (works for covered windows and
/// most GPU-drawn ones), falling back to copying its rect from the screen when that fails or
/// comes back all black.
pub fn capture_window(window: WindowHandle) -> Result<RawImage, String> {
    use windows_sys::Win32::Foundation::RECT;
    use windows_sys::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_EXTENDED_FRAME_BOUNDS};
    use windows_sys::Win32::Graphics::Gdi::{
        BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC,
        GetDIBits, ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, CAPTUREBLT,
        DIB_RGB_COLORS, SRCCOPY,
    };
    use windows_sys::Win32::Storage::Xps::PrintWindow;
    const PW_RENDERFULLCONTENT: u32 = 2;

    let hwnd = window.0 as HWND;
    // SAFETY: GDI objects are created, selected and released on this thread, in reverse order;
    // the DIB buffer is sized from the header passed to GetDIBits.
    unsafe {
        if hwnd.is_null() || IsWindow(hwnd) == 0 {
            return Err("there is no window to capture".into());
        }
        if IsIconic(hwnd) != 0 {
            return Err("the window is minimized".into());
        }
        let mut rect: RECT = std::mem::zeroed();
        if GetWindowRect(hwnd, &mut rect) == 0 {
            return Err("could not read the window's position".into());
        }
        let (w, h) = (rect.right - rect.left, rect.bottom - rect.top);
        if w <= 0 || h <= 0 || w > 16384 || h > 16384 {
            return Err("the window has no usable size".into());
        }
        let screen = GetDC(std::ptr::null_mut());
        if screen.is_null() {
            return Err("could not get the screen".into());
        }
        let memory = CreateCompatibleDC(screen);
        let bitmap = CreateCompatibleBitmap(screen, w, h);
        if memory.is_null() || bitmap.is_null() {
            if !bitmap.is_null() {
                DeleteObject(bitmap);
            }
            if !memory.is_null() {
                DeleteDC(memory);
            }
            ReleaseDC(std::ptr::null_mut(), screen);
            return Err("could not allocate the capture".into());
        }
        let old = SelectObject(memory, bitmap);

        let mut info: BITMAPINFO = std::mem::zeroed();
        info.bmiHeader = BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: w,
            biHeight: -h, // top-down
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB,
            ..std::mem::zeroed()
        };
        let mut pixels = vec![0u8; w as usize * h as usize * 4];
        let read = |pixels: &mut Vec<u8>, info: &mut BITMAPINFO| {
            // Deselect while reading, as GetDIBits requires.
            SelectObject(memory, old);
            let lines = GetDIBits(
                memory,
                bitmap,
                0,
                h as u32,
                pixels.as_mut_ptr().cast(),
                info,
                DIB_RGB_COLORS,
            );
            SelectObject(memory, bitmap);
            lines == h
        };

        let mut ok = PrintWindow(hwnd, memory, PW_RENDERFULLCONTENT) != 0
            && read(&mut pixels, &mut info)
            && pixels
                .as_chunks::<4>()
                .0
                .iter()
                .any(|p| p[0] | p[1] | p[2] != 0);
        if !ok {
            ok = BitBlt(
                memory,
                0,
                0,
                w,
                h,
                screen,
                rect.left,
                rect.top,
                SRCCOPY | CAPTUREBLT,
            ) != 0
                && read(&mut pixels, &mut info);
        }

        SelectObject(memory, old);
        DeleteObject(bitmap);
        DeleteDC(memory);
        ReleaseDC(std::ptr::null_mut(), screen);
        if !ok {
            return Err("could not capture the window".into());
        }
        // BGRA → RGBA, opaque.
        for px in pixels.as_chunks_mut::<4>().0 {
            px.swap(0, 2);
            px[3] = 255;
        }
        let full = RawImage {
            width: w as u32,
            height: h as u32,
            rgba: pixels,
        };
        // On Windows 10/11 GetWindowRect includes the invisible resize border; DWM knows the
        // visible frame. Crop to it so the image has no empty strip around the edges.
        let mut frame: RECT = std::mem::zeroed();
        let visible = DwmGetWindowAttribute(
            hwnd,
            DWMWA_EXTENDED_FRAME_BOUNDS as u32,
            (&mut frame as *mut RECT).cast(),
            std::mem::size_of::<RECT>() as u32,
        ) == 0;
        Ok(if visible {
            super::crop(
                full,
                frame.left - rect.left,
                frame.top - rect.top,
                frame.right - frame.left,
                frame.bottom - frame.top,
            )
        } else {
            full
        })
    }
}

// ---------------------------------------------------------------------------------------------
// Clipboard

const CF_BITMAP: u32 = 2;
const CF_DIB: u32 = 8;
const CF_HDROP: u32 = 15;
const CF_METAFILEPICT: u32 = 3;
const CF_PALETTE: u32 = 9;
const CF_UNICODETEXT: u32 = 13;
const CF_ENHMETAFILE: u32 = 14;
const CF_OWNERDISPLAY: u32 = 0x80;
const CF_DSPBITMAP: u32 = 0x82;
const CF_DSPMETAFILEPICT: u32 = 0x83;
const CF_DSPENHMETAFILE: u32 = 0x8E;

const COPY_TIMEOUT: Duration = Duration::from_millis(400);
const PASTE_RESTORE_DELAY: Duration = Duration::from_millis(500);

/// Formats whose data is not an HGLOBAL (GDI handles, owner display, private handles) or holds
/// handles inside one (metafile pictures). Their HGLOBAL equivalents (CF_DIB, …) are saved.
fn skip_format(format: u32) -> bool {
    matches!(
        format,
        CF_BITMAP
            | CF_METAFILEPICT
            | CF_PALETTE
            | CF_ENHMETAFILE
            | CF_OWNERDISPLAY
            | CF_DSPBITMAP
            | CF_DSPMETAFILEPICT
            | CF_DSPENHMETAFILE
    ) || (0x200..=0x3FF).contains(&format) // CF_PRIVATEFIRST..CF_GDIOBJLAST
}

/// A hidden message-only window that owns the clipboard while we write to it (OpenClipboard
/// with no window makes SetClipboardData unreliable). Destroyed on drop, on the same thread.
struct Owner(HWND);

impl Owner {
    fn new() -> Result<Self, String> {
        let class: Vec<u16> = "STATIC\0".encode_utf16().collect();
        // SAFETY: a message-only window of a system class; no create params.
        let hwnd = unsafe {
            CreateWindowExW(
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
            )
        };
        if hwnd.is_null() {
            Err("could not create a clipboard window".into())
        } else {
            Ok(Self(hwnd))
        }
    }
}

impl Drop for Owner {
    fn drop(&mut self) {
        // SAFETY: created by this thread in `new`.
        unsafe { DestroyWindow(self.0) };
    }
}

/// The clipboard, open. Closed on drop.
struct Open;

impl Open {
    /// Retries for about 200 ms: another app may be holding the clipboard.
    fn new(owner: &Owner) -> Result<Self, String> {
        for _ in 0..10 {
            // SAFETY: plain Win32 call with a window this thread owns.
            if unsafe { OpenClipboard(owner.0) } != 0 {
                return Ok(Self);
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        Err("the clipboard is busy".into())
    }

    /// Copies every HGLOBAL-based format.
    fn save(&self) -> Saved {
        let mut formats = Vec::new();
        let mut format = 0;
        loop {
            // SAFETY: the clipboard is open.
            format = unsafe { EnumClipboardFormats(format) };
            if format == 0 {
                break;
            }
            if skip_format(format) {
                continue;
            }
            if let Some(data) = self.read(format) {
                formats.push((format, data));
            }
        }
        Saved(formats)
    }

    fn read(&self, format: u32) -> Option<Vec<u8>> {
        self.read_head(format, usize::MAX)
    }

    /// At most the first `limit` bytes of a format's data.
    fn read_head(&self, format: u32, limit: usize) -> Option<Vec<u8>> {
        // SAFETY: the clipboard is open; the HGLOBAL stays owned by the clipboard and is only
        // read between GlobalLock and GlobalUnlock.
        unsafe {
            let handle = GetClipboardData(format);
            if handle.is_null() {
                return None;
            }
            let size = GlobalSize(handle).min(limit);
            let ptr = GlobalLock(handle) as *const u8;
            if ptr.is_null() {
                return None;
            }
            let data = std::slice::from_raw_parts(ptr, size).to_vec();
            GlobalUnlock(handle);
            Some(data)
        }
    }

    /// Bytes in a format's data, without reading it.
    fn size(&self, format: u32) -> Option<usize> {
        // SAFETY: the clipboard is open; the handle is only measured.
        unsafe {
            let handle = GetClipboardData(format);
            (!handle.is_null()).then(|| GlobalSize(handle))
        }
    }

    /// Content a password manager marked to be kept out of clipboard history.
    fn is_private(&self) -> bool {
        let available = |name: &str| {
            // SAFETY: plain Win32 call.
            unsafe { IsClipboardFormatAvailable(registered(name)) != 0 }
        };
        available("ExcludeClipboardContentFromMonitorProcessing")
            || available("Clipboard Viewer Ignore")
            || ["CanIncludeInClipboardHistory", "CanUploadToCloudClipboard"]
                .iter()
                .any(|name| {
                    available(name)
                        && self
                            .read(registered(name))
                            .is_some_and(|d| d.iter().all(|&b| b == 0))
                })
    }

    fn unicode_text(&self) -> Option<String> {
        let data = self.read(CF_UNICODETEXT)?;
        let units: Vec<u16> = data
            .as_chunks::<2>()
            .0
            .iter()
            .map(|&c| u16::from_le_bytes(c))
            .take_while(|&u| u != 0)
            .collect();
        Some(String::from_utf16_lossy(&units))
    }

    fn empty(&self) {
        // SAFETY: the clipboard is open with our owner window.
        unsafe { EmptyClipboard() };
    }

    /// Puts a copy of `data` on the clipboard as `format`.
    fn set(&self, format: u32, data: &[u8]) -> bool {
        // SAFETY: a fresh moveable HGLOBAL, filled while locked; the clipboard takes ownership
        // on success and we free it on failure.
        unsafe {
            let handle = GlobalAlloc(GMEM_MOVEABLE, data.len().max(1));
            if handle.is_null() {
                return false;
            }
            let ptr = GlobalLock(handle) as *mut u8;
            if ptr.is_null() {
                GlobalFree(handle);
                return false;
            }
            std::ptr::copy_nonoverlapping(data.as_ptr(), ptr, data.len());
            GlobalUnlock(handle);
            if SetClipboardData(format, handle as HANDLE).is_null() {
                GlobalFree(handle);
                return false;
            }
            true
        }
    }

    /// Marks the contents so clipboard history and cloud clipboard skip them.
    fn exclude_from_history(&self) {
        let zero = 0u32.to_le_bytes();
        self.set(
            registered("ExcludeClipboardContentFromMonitorProcessing"),
            &zero,
        );
        self.set(registered("CanIncludeInClipboardHistory"), &zero);
        self.set(registered("CanUploadToCloudClipboard"), &zero);
    }
}

impl Drop for Open {
    fn drop(&mut self) {
        // SAFETY: opened in `new`.
        unsafe { CloseClipboard() };
    }
}

fn registered(name: &str) -> u32 {
    let wide: Vec<u16> = name.encode_utf16().chain(Some(0)).collect();
    // SAFETY: NUL-terminated UTF-16 string.
    unsafe { RegisterClipboardFormatW(wide.as_ptr()) }
}

fn sequence() -> u32 {
    // SAFETY: plain Win32 call.
    unsafe { GetClipboardSequenceNumber() }
}

/// Clipboard contents saved for restoring.
struct Saved(Vec<(u32, Vec<u8>)>);

impl Saved {
    /// Replaces the clipboard with the saved formats. Restoring re-adds them to clipboard
    /// history, so they are marked to be skipped there (they're already in it).
    fn restore(&self, owner: &Owner) -> Result<(), String> {
        let open = Open::new(owner)?;
        open.empty();
        for (format, data) in &self.0 {
            open.set(*format, data);
        }
        if !self.0.is_empty() {
            open.exclude_from_history();
        }
        Ok(())
    }
}

/// Private, unless the mark is Winku's own: its paste-back text and the clipboard it restores
/// carry the "exclude from history" formats, but content that wasn't private before stays
/// readable (clipboard_history.rs, `own`).
fn private_now(open: &Open) -> bool {
    open.is_private() && crate::clipboard_history::with(|h| h.own(sequence())) != Some(false)
}

/// Marks Winku's own clipboard changes until dropped, so the history skips them.
struct OwnChanges {
    id: u64,
    /// What Winku leaves on the clipboard was private before.
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
    let owner = Owner::new()?;
    let open = Open::new(&owner)?;
    if private_now(&open) {
        return Ok(Raw::Private);
    }
    if let Some(data) = open.read(CF_HDROP) {
        return Ok(Raw::Files(crate::clipboard::decode_hdrop(&data)));
    }
    if let Some(data) = open.read(CF_DIB) {
        return Ok(Raw::Dib(data));
    }
    Ok(match open.unicode_text() {
        Some(text) if !text.is_empty() => Raw::Text(text),
        _ => Raw::Empty,
    })
}

/// Replaces the clipboard with text (the clipboard_write tool). Unlike Winku's own paste-back
/// it isn't marked: it is the user's clipboard now, history included.
pub fn clipboard_write(text: &str) -> Result<(), String> {
    let owner = Owner::new()?;
    let open = Open::new(&owner)?;
    open.empty();
    let data: Vec<u8> = text
        .encode_utf16()
        .chain(Some(0))
        .flat_map(u16::to_le_bytes)
        .collect();
    if open.set(CF_UNICODETEXT, &data) {
        Ok(())
    } else {
        Err("could not put the text on the clipboard".into())
    }
}

/// Kind and size of what is on the clipboard, for the now line: formats and data sizes only
/// (and a DIB's header), never the text.
pub fn clipboard_summary() -> Option<crate::clipboard::Summary> {
    use crate::clipboard::Summary;
    let owner = Owner::new().ok()?;
    let open = Open::new(&owner).ok()?;
    if private_now(&open) {
        return Some(Summary::Private);
    }
    if let Some(data) = open.read(CF_HDROP) {
        return Some(Summary::Files(crate::clipboard::decode_hdrop(&data).len()));
    }
    if let Some(header) = open.read_head(CF_DIB, 16) {
        let (w, h) = crate::clipboard::dib_size(&header)?;
        return Some(Summary::Image(w, h));
    }
    let chars = (open.size(CF_UNICODETEXT)? / 2).saturating_sub(1);
    (chars > 0).then_some(Summary::Text(chars))
}

/// Selected text by simulating `Ctrl+C`, saving the clipboard first and restoring it after.
/// None when the copy didn't change the clipboard within 400 ms (nothing selected).
pub fn selection_via_copy() -> Option<String> {
    let owner = Owner::new().ok()?;
    let mut own = OwnChanges::begin();
    let saved = {
        let open = Open::new(&owner).ok()?;
        own.private = open.is_private();
        open.save()
    };
    let before = sequence();
    send_ctrl(b'C').ok()?;
    let deadline = Instant::now() + COPY_TIMEOUT;
    while sequence() == before {
        if Instant::now() >= deadline {
            return None;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    // Some apps write several formats one after another; give them a moment to finish.
    std::thread::sleep(Duration::from_millis(30));
    let text = Open::new(&owner).ok().and_then(|open| open.unicode_text());
    let _ = saved.restore(&owner);
    text
}

/// Pastes `text` with `Ctrl+V` into the foreground window, then restores the previous
/// clipboard about 500 ms later (unless something else has written to it since).
pub fn paste_text(text: &str) -> Result<(), String> {
    let owner = Owner::new()?;
    let own = OwnChanges::begin();
    let (saved, was_private) = {
        let open = Open::new(&owner)?;
        let saved = (open.save(), open.is_private());
        open.empty();
        let data: Vec<u8> = text
            .encode_utf16()
            .chain(Some(0))
            .flat_map(u16::to_le_bytes)
            .collect();
        if !open.set(CF_UNICODETEXT, &data) {
            return Err("could not put the result on the clipboard".into());
        }
        open.exclude_from_history();
        saved
    };
    let ours = sequence();
    drop(own);
    drop(owner);
    let sent = send_ctrl(b'V');
    std::thread::spawn(move || {
        std::thread::sleep(PASTE_RESTORE_DELAY);
        if sequence() != ours {
            return;
        }
        let mut own = OwnChanges::begin();
        own.private = was_private;
        if let Ok(owner) = Owner::new() {
            let _ = saved.restore(&owner);
        }
    });
    sent
}

/// Starts the clipboard history listener: a thread with a hidden message-only window registered
/// with `AddClipboardFormatListener`, so it gets `WM_CLIPBOARDUPDATE` after every change. It
/// reads the change and hands it to the history (clipboard_history.rs), which decides what to
/// keep. Safe to call once.
pub fn watch_clipboard() {
    use windows_sys::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        DefWindowProcW, DispatchMessageW, GetMessageW, RegisterClassW, MSG, WM_CLIPBOARDUPDATE,
        WNDCLASSW,
    };

    unsafe extern "system" fn proc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        if msg == WM_CLIPBOARDUPDATE {
            on_clipboard_change();
            return 0;
        }
        DefWindowProcW(hwnd, msg, wparam, lparam)
    }

    static STARTED: std::sync::Once = std::sync::Once::new();
    STARTED.call_once(|| {
        std::thread::spawn(|| {
            // SAFETY: the window belongs to this thread and is serviced by its message loop.
            unsafe {
                let class: Vec<u16> = "WinkuClipboardWatch\0".encode_utf16().collect();
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
                if hwnd.is_null() || AddClipboardFormatListener(hwnd) == 0 {
                    eprintln!("winku: clipboard listener failed, no clipboard history");
                    return;
                }
                let mut msg: MSG = std::mem::zeroed();
                while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {
                    DispatchMessageW(&msg);
                }
            }
        });
    });
}

/// Reads what a clipboard change left: private, text, or something else (only its formats
/// unless it is text). The sequence number is read with the clipboard open, so it matches.
fn on_clipboard_change() {
    use crate::clipboard_history::Change;
    let Ok(owner) = Owner::new() else { return };
    let Ok(open) = Open::new(&owner) else { return };
    let seq = sequence();
    let available = |format| {
        // SAFETY: plain Win32 call; the clipboard is open.
        unsafe { IsClipboardFormatAvailable(format) != 0 }
    };
    let change = if open.is_private() {
        Change::Private
    } else if available(CF_HDROP) || available(CF_DIB) {
        Change::Other
    } else {
        open.unicode_text().map_or(Change::Other, Change::Text)
    };
    drop(open);
    crate::clipboard_history::with(|h| h.observe(seq, change, Instant::now()));
}

// ---------------------------------------------------------------------------------------------
// Main window frame

/// Tells DWM to draw nothing around the transparent, undecorated main window: no non-client
/// frame or shadow, no rounded-corner clip, no show/hide transition. The eyes draw everything
/// themselves, so whatever DWM adds is extra composition work and the visible shadow users saw
/// behind the pill. Call once, after the window exists.
pub fn plain_frame(window: WindowHandle) {
    use windows_sys::Win32::Graphics::Dwm::{
        DwmSetWindowAttribute, DWMNCRP_DISABLED, DWMWA_NCRENDERING_POLICY,
        DWMWA_TRANSITIONS_FORCEDISABLED, DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_DONOTROUND,
    };
    let hwnd = window.0 as HWND;
    let set = |attribute: i32, value: i32| {
        // SAFETY: a 4-byte value for a 4-byte attribute; DWM rejects a stale HWND with an
        // error code. Corner preference fails before Windows 11, which is fine.
        unsafe {
            DwmSetWindowAttribute(
                hwnd,
                attribute as u32,
                (&value as *const i32).cast(),
                std::mem::size_of::<i32>() as u32,
            )
        };
    };
    set(DWMWA_NCRENDERING_POLICY, DWMNCRP_DISABLED);
    set(DWMWA_TRANSITIONS_FORCEDISABLED, 1);
    set(DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_DONOTROUND);
    // SAFETY: called on the thread that owns the window; the callback is a plain function that
    // lives as long as the process.
    unsafe {
        windows_sys::Win32::UI::Shell::SetWindowSubclass(hwnd, Some(frameless_proc), 1, 0);
    }
}

/// Keeps Windows from drawing a title bar on the main window. The window is undecorated, but it
/// still has the caption style (the windowing library hides the caption by claiming the whole
/// window as client area). With DWM's frame off, Windows itself paints the caption whenever the
/// window is activated or its frame is redrawn, straight over the eyes: an old-style title bar
/// with minimise, maximise and close buttons. So those paints never reach it, and neither do the
/// title bar's commands (minimise, maximise, size, the system menu).
unsafe extern "system" fn frameless_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _id: usize,
    _data: usize,
) -> LRESULT {
    use windows_sys::Win32::UI::Shell::DefSubclassProc;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        SC_KEYMENU, SC_MAXIMIZE, SC_MINIMIZE, SC_MOUSEMENU, SC_SIZE, WM_NCACTIVATE, WM_NCPAINT,
        WM_SYSCOMMAND,
    };
    /// Undocumented: the themed caption and frame paints.
    const WM_NCUAHDRAWCAPTION: u32 = 0x00AE;
    const WM_NCUAHDRAWFRAME: u32 = 0x00AF;
    match msg {
        // -1 for the update region: the active state changes, nothing is repainted.
        WM_NCACTIVATE => DefSubclassProc(hwnd, msg, wparam, -1),
        WM_NCPAINT | WM_NCUAHDRAWCAPTION | WM_NCUAHDRAWFRAME => 0,
        WM_SYSCOMMAND
            if matches!(
                wparam as u32 & 0xFFF0,
                SC_MINIMIZE | SC_MAXIMIZE | SC_SIZE | SC_KEYMENU | SC_MOUSEMENU
            ) =>
        {
            0
        }
        _ => DefSubclassProc(hwnd, msg, wparam, lparam),
    }
}

// ---------------------------------------------------------------------------------------------
// Foreground watching (fullscreen apps hide the pill)

use crate::fullscreen::Bounds;
use windows_sys::Win32::Foundation::{LPARAM, LRESULT, RECT, WPARAM};
use windows_sys::Win32::Graphics::Gdi::{
    GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
};
use windows_sys::Win32::UI::Accessibility::{SetWinEventHook, HWINEVENTHOOK};
use windows_sys::Win32::UI::Shell::{SHAppBarMessage, ABM_NEW, ABN_FULLSCREENAPP, APPBARDATA};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    DefWindowProcW, DispatchMessageW, GetClassNameW, GetMessageW, RegisterClassW,
    EVENT_SYSTEM_FOREGROUND, MSG, WINEVENT_OUTOFCONTEXT, WINEVENT_SKIPOWNPROCESS, WM_APP,
    WNDCLASSW, WS_EX_TOOLWINDOW, WS_POPUP,
};

pub type ForegroundCallback = Box<dyn Fn(&str, bool, Bounds, Bounds) + Send + Sync>;

static FOREGROUND_CALLBACK: std::sync::OnceLock<ForegroundCallback> = std::sync::OnceLock::new();

/// The message Explorer sends the appbar window with its notifications.
const APPBAR_CALLBACK: u32 = WM_APP + 1;

/// Calls `callback` with the foreground window's class, whether it is Winku's, its rect and its
/// monitor's rect whenever the foreground changes, and again whenever Explorer says a
/// fullscreen app opened or closed (F11 or a video going fullscreen in the window that already
/// has focus). Runs a dedicated thread that sleeps in GetMessageW between events: no polling.
///
/// Explorer's notice comes through an appbar: a hidden window registered with ABM_NEW that never
/// claims any screen space. It replaces a location-change WinEvent hook on the foreground
/// window's thread, which fired for every caret move, every child window move and every pixel
/// of a window drag.
pub fn watch_foreground(callback: ForegroundCallback) {
    if FOREGROUND_CALLBACK.set(callback).is_err() {
        return;
    }
    std::thread::spawn(|| {
        // SAFETY: the hook and the appbar window belong to this thread and are serviced by its
        // message loop.
        unsafe {
            SetWinEventHook(
                EVENT_SYSTEM_FOREGROUND,
                EVENT_SYSTEM_FOREGROUND,
                std::ptr::null_mut(),
                Some(on_win_event),
                0,
                0,
                WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS,
            );
            register_appbar();
            report(GetForegroundWindow());
            let mut msg: MSG = std::mem::zeroed();
            while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {
                DispatchMessageW(&msg);
            }
        }
    });
}

/// A hidden tool window registered as an appbar, so Explorer tells it about fullscreen apps.
/// It is never shown and never asks for space (no ABM_SETPOS). Explorer drops it when the
/// process exits.
unsafe fn register_appbar() {
    let class: Vec<u16> = "WinkuFullscreenWatch\0".encode_utf16().collect();
    let wc = WNDCLASSW {
        lpfnWndProc: Some(appbar_proc),
        lpszClassName: class.as_ptr(),
        ..std::mem::zeroed()
    };
    RegisterClassW(&wc);
    let hwnd = CreateWindowExW(
        WS_EX_TOOLWINDOW,
        class.as_ptr(),
        std::ptr::null(),
        WS_POPUP,
        0,
        0,
        0,
        0,
        std::ptr::null_mut(),
        std::ptr::null_mut(),
        std::ptr::null_mut(),
        std::ptr::null(),
    );
    if hwnd.is_null() {
        return;
    }
    let mut data: APPBARDATA = std::mem::zeroed();
    data.cbSize = std::mem::size_of::<APPBARDATA>() as u32;
    data.hWnd = hwnd;
    data.uCallbackMessage = APPBAR_CALLBACK;
    SHAppBarMessage(ABM_NEW, &mut data);
}

unsafe extern "system" fn appbar_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if msg == APPBAR_CALLBACK {
        if wparam as u32 == ABN_FULLSCREENAPP {
            report(GetForegroundWindow());
        }
        return 0;
    }
    DefWindowProcW(hwnd, msg, wparam, lparam)
}

unsafe extern "system" fn on_win_event(
    _hook: HWINEVENTHOOK,
    event: u32,
    hwnd: HWND,
    _id_object: i32,
    _id_child: i32,
    _thread: u32,
    _time: u32,
) {
    if event == EVENT_SYSTEM_FOREGROUND {
        report(hwnd);
    }
}

unsafe fn report(hwnd: HWND) {
    let Some(callback) = FOREGROUND_CALLBACK.get() else {
        return;
    };
    let empty = Bounds {
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
    };
    if hwnd.is_null() {
        callback("", false, empty, empty);
        return;
    }
    let mut class = [0u16; 64];
    let len = GetClassNameW(hwnd, class.as_mut_ptr(), class.len() as i32);
    let class = String::from_utf16_lossy(&class[..len.max(0) as usize]);
    let own = is_own_window(WindowHandle(hwnd as isize));
    let mut rect: RECT = std::mem::zeroed();
    if GetWindowRect(hwnd, &mut rect) == 0 {
        callback(&class, own, empty, empty);
        return;
    }
    let mut info: MONITORINFO = std::mem::zeroed();
    info.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
    let monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
    if GetMonitorInfoW(monitor, &mut info) == 0 {
        callback(&class, own, empty, empty);
        return;
    }
    let bounds = |r: RECT| Bounds {
        left: r.left,
        top: r.top,
        right: r.right,
        bottom: r.bottom,
    };
    callback(&class, own, bounds(rect), bounds(info.rcMonitor));
}

// ---------------------------------------------------------------------------------------------
// Main window shape (window.rs: the stage around the pill)

/// Moves and resizes `window` in one SetWindowPos, without activating it or changing its z-order,
/// so no frame shows the old size at the new position.
pub fn set_window_rect(window: WindowHandle, x: i32, y: i32, w: i32, h: i32) -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        SetWindowPos, SWP_NOACTIVATE, SWP_NOOWNERZORDER, SWP_NOZORDER,
    };
    // SAFETY: plain Win32 call on our own window.
    unsafe {
        SetWindowPos(
            window.0 as HWND,
            std::ptr::null_mut(),
            x,
            y,
            w,
            h,
            SWP_NOACTIVATE | SWP_NOZORDER | SWP_NOOWNERZORDER,
        ) != 0
    }
}

/// Moves `window` without resizing or activating it. Safe from any thread.
pub fn move_window(window: WindowHandle, x: i32, y: i32) -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        SetWindowPos, SWP_NOACTIVATE, SWP_NOOWNERZORDER, SWP_NOSIZE, SWP_NOZORDER,
    };
    // SAFETY: plain Win32 call on our own window.
    unsafe {
        SetWindowPos(
            window.0 as HWND,
            std::ptr::null_mut(),
            x,
            y,
            0,
            0,
            SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOZORDER | SWP_NOOWNERZORDER,
        ) != 0
    }
}

/// `window`'s rectangle on screen (x, y, width, height), physical px.
pub fn window_rect(window: WindowHandle) -> Option<(i32, i32, i32, i32)> {
    // SAFETY: the out-pointer is a live RECT; a stale HWND makes the call fail.
    unsafe {
        let mut rect: RECT = std::mem::zeroed();
        if GetWindowRect(window.0 as HWND, &mut rect) == 0 {
            return None;
        }
        Some((
            rect.left,
            rect.top,
            rect.right - rect.left,
            rect.bottom - rect.top,
        ))
    }
}

/// The pointer on screen, physical px.
pub fn cursor_position() -> Option<(i32, i32)> {
    use windows_sys::Win32::Foundation::POINT;
    use windows_sys::Win32::UI::WindowsAndMessaging::GetCursorPos;
    let mut point = POINT { x: 0, y: 0 };
    // SAFETY: the out-pointer is a live POINT.
    (unsafe { GetCursorPos(&mut point) } != 0).then_some((point.x, point.y))
}

/// Blocks until the compositor has shown the next frame, so a loop that moves a window runs once
/// per frame on any display. Never returns sooner than a couple of milliseconds, so a compositor
/// that isn't pacing (a remote session, a display that is off) can't turn the loop into a spin.
pub fn wait_frame() {
    use windows_sys::Win32::Graphics::Dwm::DwmFlush;
    let started = Instant::now();
    // SAFETY: plain Win32 call with no arguments.
    let paced = unsafe { DwmFlush() } >= 0;
    let floor = Duration::from_millis(if paced { 2 } else { 8 });
    if let Some(rest) = floor.checked_sub(started.elapsed()) {
        std::thread::sleep(rest);
    }
}

/// Whether Windows has animations on (Settings > Accessibility > Visual effects > Animation
/// effects): the setting the UI reads as "reduce motion".
pub fn animations_enabled() -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        SystemParametersInfoW, SPI_GETCLIENTAREAANIMATION,
    };
    let mut enabled: i32 = 1;
    // SAFETY: the out-pointer is a live BOOL.
    let ok = unsafe {
        SystemParametersInfoW(
            SPI_GETCLIENTAREAANIMATION,
            0,
            (&mut enabled as *mut i32).cast(),
            0,
        )
    };
    ok == 0 || enabled != 0
}

/// Clips `window` to the union of `rects` (window px). Outside the region nothing paints and clicks
/// reach the windows underneath. Empty `rects` removes the clip.
///
/// Rounded rects are clipped one pixel outside their curve: a region has no anti-aliasing, so an
/// exact one would cut into the shape's soft edge. Square corners let WebView2 show stray pixels
/// in the transparent space between the curve and the box.
pub fn set_window_region(window: WindowHandle, rects: &[RoundRect]) {
    use windows_sys::Win32::Graphics::Gdi::{
        CombineRgn, CreateRectRgn, CreateRoundRectRgn, DeleteObject, SetWindowRgn, RGN_OR,
    };
    // SAFETY: regions are created here; SetWindowRgn takes ownership of the one it is given, the
    // rest are deleted.
    unsafe {
        if rects.is_empty() {
            SetWindowRgn(window.0 as HWND, std::ptr::null_mut(), 1);
            return;
        }
        let region = CreateRectRgn(0, 0, 0, 0);
        for rect in rects {
            let part = if rect.radius > 0 {
                // One pixel out on every side. The ellipse is a diameter, and the region leaves
                // out its right and bottom edge, hence the extra pixel there.
                let d = 2 * (rect.radius + 1);
                CreateRoundRectRgn(
                    rect.left - 1,
                    rect.top - 1,
                    rect.right + 2,
                    rect.bottom + 2,
                    d,
                    d,
                )
            } else {
                CreateRectRgn(rect.left, rect.top, rect.right, rect.bottom)
            };
            CombineRgn(region, region, part, RGN_OR);
            DeleteObject(part);
        }
        if SetWindowRgn(window.0 as HWND, region, 1) == 0 {
            DeleteObject(region);
        }
    }
}
