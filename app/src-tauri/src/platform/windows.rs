//! Windows implementations.

use std::sync::mpsc;
use std::time::{Duration, Instant};

use windows_sys::Win32::Foundation::{CloseHandle, GlobalFree, HANDLE, HWND};
use windows_sys::Win32::System::DataExchange::{
    CloseClipboard, EmptyClipboard, EnumClipboardFormats, GetClipboardData,
    GetClipboardSequenceNumber, OpenClipboard, RegisterClipboardFormatW, SetClipboardData,
};
use windows_sys::Win32::System::Memory::{
    GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock, GMEM_MOVEABLE,
};
use windows_sys::Win32::System::Threading::{
    AttachThreadInput, GetCurrentThreadId, OpenProcess, QueryFullProcessImageNameW,
    PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, GetKeyboardLayout, MapVirtualKeyW, SendInput, VkKeyScanExW, INPUT, INPUT_0,
    INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, MAPVK_VK_TO_VSC, VK_CONTROL, VK_LBUTTON, VK_LWIN,
    VK_MENU, VK_RWIN, VK_SHIFT,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    BringWindowToTop, CreateWindowExW, DestroyWindow, GetForegroundWindow,
    GetWindowThreadProcessId, IsIconic, IsWindow, SetForegroundWindow, ShowWindow, HWND_MESSAGE,
    SW_RESTORE,
};

use super::WindowHandle;

pub fn mouse_button_down() -> bool {
    key_down(VK_LBUTTON)
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

fn uia_selection_on_this_thread() -> Option<String> {
    use windows::core::Interface;
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
        COINIT_MULTITHREADED,
    };
    use windows::Win32::UI::Accessibility::{
        CUIAutomation, IUIAutomation, IUIAutomationTextPattern, IUIAutomationTextPattern2,
        UIA_TextPattern2Id, UIA_TextPatternId,
    };

    struct Com;
    impl Drop for Com {
        fn drop(&mut self) {
            // SAFETY: paired with the successful CoInitializeEx below, on the same thread.
            unsafe { CoUninitialize() };
        }
    }

    // SAFETY: COM calls on this thread; every interface is dropped before `_com`.
    unsafe {
        CoInitializeEx(None, COINIT_MULTITHREADED).ok().ok()?;
        let _com = Com;
        let text = (|| -> windows::core::Result<String> {
            let automation: IUIAutomation =
                CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER)?;
            let element = automation.GetFocusedElement()?;
            let pattern: IUIAutomationTextPattern =
                match element.GetCurrentPatternAs::<IUIAutomationTextPattern>(UIA_TextPatternId) {
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
        })();
        text.ok().filter(|t| !t.is_empty())
    }
}

// ---------------------------------------------------------------------------------------------
// Clipboard

const CF_BITMAP: u32 = 2;
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
        // SAFETY: the clipboard is open; the HGLOBAL stays owned by the clipboard and is only
        // read between GlobalLock and GlobalUnlock.
        unsafe {
            let handle = GetClipboardData(format);
            if handle.is_null() {
                return None;
            }
            let size = GlobalSize(handle);
            let ptr = GlobalLock(handle) as *const u8;
            if ptr.is_null() {
                return None;
            }
            let data = std::slice::from_raw_parts(ptr, size).to_vec();
            GlobalUnlock(handle);
            Some(data)
        }
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

/// Selected text by simulating `Ctrl+C`, saving the clipboard first and restoring it after.
/// None when the copy didn't change the clipboard within 400 ms (nothing selected).
pub fn selection_via_copy() -> Option<String> {
    let owner = Owner::new().ok()?;
    let saved = Open::new(&owner).ok()?.save();
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
    let saved = {
        let open = Open::new(&owner)?;
        let saved = open.save();
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
    drop(owner);
    let sent = send_ctrl(b'V');
    std::thread::spawn(move || {
        std::thread::sleep(PASTE_RESTORE_DELAY);
        if sequence() != ours {
            return;
        }
        if let Ok(owner) = Owner::new() {
            let _ = saved.restore(&owner);
        }
    });
    sent
}
