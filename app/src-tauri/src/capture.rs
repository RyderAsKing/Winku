//! Screen context for the agent (docs/ARCHITECTURE.md, "Agent tools"):
//!
//! - the **now line**: foreground app, window title, selection and a clipboard note, noted when the bar is
//!   summoned, and that window remembered as "the window before the bar";
//! - **window capture**: a window's image, downscaled to a 1568 px long edge, as a PNG
//!   `ImageAttachment` (screenshot command and hotkey, `screen_capture` Requests);
//! - **screen_capture**: app, title, UI Automation text and (optionally) the image;
//! - **screen_target**: the window the agent's desktop_* tools work in (computer use).
//!
//! The OS work is in `platform`; this module holds the state and the pure parts.

use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};

use base64::Engine as _;
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::platform::{self, RawImage, WindowHandle};
use crate::window::{Mode, WindowState};

/// Longest edge of an image sent to the model.
pub const MAX_EDGE: u32 = 1568;
/// Selection kept in the now line.
pub const SELECTION_CAP: usize = 2000;
/// UI Automation text kept in a screen capture.
pub const TEXT_CAP: usize = 8000;
/// How long `now_line` waits for a selection still being read.
const SELECTION_WAIT: Duration = Duration::from_millis(400);
/// A second summon of the same window within this reuses the snapshot (the hotkey notes it,
/// then the UI's `window_mode bar` would note it again).
const DEDUPE: Duration = Duration::from_millis(1500);
const MODIFIER_TIMEOUT: Duration = Duration::from_millis(600);

/// `NowLine` in engine/src/protocol.ts. Empty fields are left out.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NowLine {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub app: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub window_title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selection: Option<String>,
    /// Kind and size of what is on the clipboard (clipboard.rs `note`), never its contents.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub clipboard: Option<String>,
}

impl NowLine {
    pub fn new(app: Option<String>, title: Option<String>, selection: Option<String>) -> Self {
        Self {
            app: non_empty(app, usize::MAX),
            window_title: non_empty(title, 300),
            selection: non_empty(selection, SELECTION_CAP),
            clipboard: None,
        }
    }
}

/// `ImageAttachment` in engine/src/protocol.ts.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageAttachment {
    /// base64, no `data:` prefix.
    pub data: String,
    pub mime_type: &'static str,
}

/// `ScreenCapture` in engine/src/protocol.ts.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenCapture {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub app: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub window_title: Option<String>,
    /// agent-desktop's id for the window, `w-<HWND>`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub window_id: Option<String>,
    /// A Chromium window (see `platform::uia_is_safe`).
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub chromium: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image: Option<ImageAttachment>,
}

/// `ScreenTarget` in engine/src/protocol.ts.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenTarget {
    pub window_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub app: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub window_title: Option<String>,
    pub chromium: bool,
}

/// agent-desktop's window id: `w-` and the HWND as an unsigned number.
pub fn agent_desktop_window_id(window: WindowHandle) -> String {
    format!("w-{}", window.0 as usize)
}

/// Trims, drops empty strings, and caps at `cap` characters.
fn non_empty(value: Option<String>, cap: usize) -> Option<String> {
    let value = value?;
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(truncate_chars(trimmed, cap))
}

pub fn truncate_chars(text: &str, cap: usize) -> String {
    match text.char_indices().nth(cap) {
        Some((end, _)) => text[..end].to_string(),
        None => text.to_string(),
    }
}

// ───────────────────────────── image ─────────────────────────────

/// Size after scaling so the long edge is at most `max_edge` (never upscaled, never 0).
pub fn fit(width: u32, height: u32, max_edge: u32) -> (u32, u32) {
    let long = width.max(height);
    if long <= max_edge || long == 0 {
        return (width, height);
    }
    let scale = |v: u32| {
        ((u64::from(v) * u64::from(max_edge) + u64::from(long) / 2) / u64::from(long)).max(1) as u32
    };
    (scale(width), scale(height))
}

/// Area-average downscale of RGBA pixels to `(w, h)` (each target pixel averages the source
/// pixels it covers). Returns the input unchanged when the size already matches.
pub fn downscale(image: RawImage, w: u32, h: u32) -> RawImage {
    if (image.width, image.height) == (w, h) || w == 0 || h == 0 {
        return image;
    }
    let (sw, sh) = (image.width as usize, image.height as usize);
    let (w, h) = (w as usize, h as usize);
    let mut out = vec![0u8; w * h * 4];
    for ty in 0..h {
        let y0 = ty * sh / h;
        let y1 = ((ty + 1) * sh / h).max(y0 + 1);
        for tx in 0..w {
            let x0 = tx * sw / w;
            let x1 = ((tx + 1) * sw / w).max(x0 + 1);
            let mut sum = [0u64; 4];
            for y in y0..y1 {
                let row = &image.rgba[(y * sw + x0) * 4..(y * sw + x1) * 4];
                for px in row.as_chunks::<4>().0 {
                    for c in 0..4 {
                        sum[c] += u64::from(px[c]);
                    }
                }
            }
            let n = ((y1 - y0) * (x1 - x0)) as u64;
            let o = (ty * w + tx) * 4;
            for c in 0..4 {
                out[o + c] = ((sum[c] + n / 2) / n) as u8;
            }
        }
    }
    RawImage {
        width: w as u32,
        height: h as u32,
        rgba: out,
    }
}

pub fn encode_png(image: &RawImage) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    let mut encoder = png::Encoder::new(&mut bytes, image.width, image.height);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    let mut writer = encoder.write_header().map_err(|e| e.to_string())?;
    writer
        .write_image_data(&image.rgba)
        .map_err(|e| e.to_string())?;
    writer.finish().map_err(|e| e.to_string())?;
    Ok(bytes)
}

/// Downscales and encodes a captured image as an attachment.
pub fn to_attachment(image: RawImage) -> Result<ImageAttachment, String> {
    let (w, h) = fit(image.width, image.height, MAX_EDGE);
    let png = encode_png(&downscale(image, w, h))?;
    Ok(ImageAttachment {
        data: base64::engine::general_purpose::STANDARD.encode(png),
        mime_type: "image/png",
    })
}

pub fn capture_image(window: WindowHandle) -> Result<ImageAttachment, String> {
    to_attachment(platform::capture_window(window)?)
}

// ───────────────────────────── now line state ─────────────────────────────

#[derive(Default)]
struct Snapshot {
    window: Option<WindowHandle>,
    line: NowLine,
    /// The selection is still being read on a worker thread.
    reading: bool,
    generation: u64,
    at: Option<Instant>,
}

/// Managed state: the last now-line snapshot and the window before the bar.
#[derive(Default)]
pub struct NowState {
    snapshot: Mutex<Snapshot>,
    ready: Condvar,
}

impl NowState {
    fn lock(&self) -> std::sync::MutexGuard<'_, Snapshot> {
        self.snapshot.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The window that was in front before the bar was summoned.
    pub fn window_before_bar(&self) -> Option<WindowHandle> {
        self.lock().window
    }

    /// The snapshot, once its selection is read (or after a short wait).
    pub fn now_line(&self) -> NowLine {
        let guard = self.lock();
        let (guard, _) = self
            .ready
            .wait_timeout_while(guard, SELECTION_WAIT, |s| s.reading)
            .unwrap_or_else(|e| e.into_inner());
        guard.line.clone()
    }
}

/// Notes the foreground window as the bar is about to be shown. Winku's own windows are
/// ignored (the previous snapshot stays). App and title are read now; the selection (UI
/// Automation only, never a simulated copy) on a worker thread so the bar isn't delayed, and
/// not at all in Chromium windows (`platform::uia_is_safe`).
pub fn note_summon(app: &AppHandle) {
    let window = platform::foreground_window();
    if platform::is_own_window(window) || window == WindowHandle(0) {
        return;
    }
    let skip_selection = !platform::uia_is_safe(window);
    let state = app.state::<NowState>();
    let generation = {
        let mut snap = state.lock();
        if snap.window == Some(window) && snap.at.is_some_and(|at| at.elapsed() < DEDUPE) {
            return;
        }
        snap.generation += 1;
        snap.window = Some(window);
        snap.line = NowLine::new(
            platform::process_name(window),
            platform::window_title(window),
            None,
        );
        snap.line.clipboard = crate::clipboard::note(platform::clipboard_summary());
        snap.reading = !skip_selection;
        snap.at = Some(Instant::now());
        snap.generation
    };
    if skip_selection {
        state.ready.notify_all();
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let selection = platform::selection_via_uia();
        let state = app.state::<NowState>();
        let mut snap = state.lock();
        if snap.generation == generation {
            snap.line.selection = non_empty(selection, SELECTION_CAP);
            snap.reading = false;
            state.ready.notify_all();
        }
    });
}

/// The now line for a scheduled run, read when it fires: app, window title and the clipboard
/// note, never the selection. Winku's own windows give no app or title.
pub fn scheduled_now_line() -> NowLine {
    let window = platform::foreground_window();
    let mut line = if window == WindowHandle(0) || platform::is_own_window(window) {
        NowLine::default()
    } else {
        NowLine::new(
            platform::process_name(window),
            platform::window_title(window),
            None,
        )
    };
    line.clipboard = crate::clipboard::note(platform::clipboard_summary());
    line
}

/// The window a capture is about: the window before the bar while the bar is showing (or when
/// Winku itself is in front), else the foreground window.
fn target_window(app: &AppHandle, prefer_before_bar: bool) -> WindowHandle {
    let foreground = platform::foreground_window();
    let before = app.state::<NowState>().window_before_bar();
    match before {
        Some(before) if prefer_before_bar || platform::is_own_window(foreground) => before,
        _ => foreground,
    }
}

/// The `screenshot` command: the window before the bar, else the foreground window.
pub fn screenshot(app: &AppHandle) -> Result<ImageAttachment, String> {
    capture_image(target_window(app, true))
}

/// The screenshot hotkey: capture the foreground window once the hotkey's modifiers are up,
/// then `ui` `attach_screenshot` (or `action_error` on failure).
pub fn on_screenshot_hotkey(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        platform::wait_for_modifiers_released(MODIFIER_TIMEOUT);
        let payload = match capture_image(target_window(&app, false)) {
            Ok(image) => json!({ "kind": "attach_screenshot", "image": image }),
            Err(message) => json!({
                "kind": "action_error", "slot": 0, "name": "Screenshot", "message": message,
            }),
        };
        let _ = app.emit_to(crate::window::MAIN, "ui", &payload);
    });
}

/// The window an engine Request is about: the window before the bar while the bar or
/// transcript shows, else the foreground window. Never one of Winku's own.
fn request_window(app: &AppHandle) -> Result<WindowHandle, String> {
    let showing = app.state::<WindowState>().mode() != Mode::Pill;
    let window = target_window(app, showing);
    if window == WindowHandle(0) || platform::is_own_window(window) {
        return Err("no window to look at".into());
    }
    Ok(window)
}

/// Answers an engine `screen_capture` Request (call off the reader thread). In a Chromium
/// window the UI Automation text is skipped when there is a screenshot: reading it switches on
/// the app's accessibility tree, which slows it until it restarts (`platform::uia_is_safe`).
/// Without a screenshot the model would see nothing, so the text is read anyway.
pub fn screen_capture(app: &AppHandle, include_image: bool) -> Result<ScreenCapture, String> {
    let window = request_window(app)?;
    let chromium = !platform::uia_is_safe(window);
    let image = if include_image {
        Some(capture_image(window)?)
    } else {
        None
    };
    let text = if read_text(chromium, image.is_some()) {
        non_empty(platform::window_text(window), TEXT_CAP)
    } else {
        None
    };
    Ok(ScreenCapture {
        app: non_empty(platform::process_name(window), usize::MAX),
        window_title: non_empty(platform::window_title(window), 300),
        window_id: Some(agent_desktop_window_id(window)),
        chromium,
        text,
        image,
    })
}

/// Whether `screen_capture` reads UI Automation text: not in a Chromium window that has a screenshot.
fn read_text(chromium: bool, has_image: bool) -> bool {
    !(chromium && has_image)
}

/// Answers an engine `screen_target` Request: the window computer use works in. Win32 calls
/// only (no UI Automation), so it is free in any app.
pub fn screen_target(app: &AppHandle) -> Result<ScreenTarget, String> {
    let window = request_window(app)?;
    Ok(ScreenTarget {
        window_id: agent_desktop_window_id(window),
        app: non_empty(platform::process_name(window), usize::MAX),
        window_title: non_empty(platform::window_title(window), 300),
        chromium: !platform::uia_is_safe(window),
    })
}

/// The Response for a Request answered with `data` (or an error).
pub fn response_with<T: Serialize>(id: &str, outcome: Result<T, String>) -> Value {
    match outcome {
        Ok(data) => json!({ "type": "response", "id": id, "ok": true, "data": data }),
        Err(error) => json!({ "type": "response", "id": id, "ok": false, "error": error }),
    }
}

/// The Response for a `screen_capture` Request.
pub fn response(id: &str, outcome: Result<ScreenCapture, String>) -> Value {
    response_with(id, outcome)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn now_line_omits_empty_fields() {
        let line = NowLine::new(Some("code.exe".into()), Some("  ".into()), None);
        assert_eq!(
            serde_json::to_value(&line).unwrap(),
            json!({ "app": "code.exe" })
        );
        let line = NowLine::new(None, Some(" main.rs ".into()), Some("x".repeat(3000)));
        let value = serde_json::to_value(&line).unwrap();
        assert_eq!(value["windowTitle"], "main.rs");
        assert_eq!(value["selection"].as_str().unwrap().len(), SELECTION_CAP);
        assert_eq!(serde_json::to_value(NowLine::default()).unwrap(), json!({}));
    }

    #[test]
    fn truncates_on_char_boundaries() {
        assert_eq!(truncate_chars("héllo", 2), "hé");
        assert_eq!(truncate_chars("hi", 5), "hi");
    }

    #[test]
    fn fit_caps_the_long_edge() {
        assert_eq!(fit(1000, 800, MAX_EDGE), (1000, 800));
        assert_eq!(fit(3136, 1000, MAX_EDGE), (1568, 500));
        assert_eq!(fit(1000, 3136, MAX_EDGE), (500, 1568));
        assert_eq!(fit(10000, 1, MAX_EDGE), (1568, 1));
        assert_eq!(fit(0, 0, MAX_EDGE), (0, 0));
    }

    #[test]
    fn downscale_averages() {
        // 2×2 → 1×1: average of black and white pixels.
        let image = RawImage {
            width: 2,
            height: 2,
            rgba: vec![
                0, 0, 0, 255, 255, 255, 255, 255, 0, 0, 0, 255, 255, 255, 255, 255,
            ],
        };
        let small = downscale(image, 1, 1);
        assert_eq!(small.rgba, vec![128, 128, 128, 255]);
    }

    #[test]
    fn attachment_is_base64_png() {
        let image = RawImage {
            width: 2000,
            height: 10,
            rgba: vec![200; 2000 * 10 * 4],
        };
        let att = to_attachment(image).unwrap();
        assert_eq!(att.mime_type, "image/png");
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(&att.data)
            .unwrap();
        assert_eq!(&bytes[..8], b"\x89PNG\r\n\x1a\n");
        let decoder = png::Decoder::new(std::io::Cursor::new(bytes));
        let reader = decoder.read_info().unwrap();
        assert_eq!((reader.info().width, reader.info().height), (1568, 8));
    }

    #[test]
    fn chromium_text_only_without_a_screenshot() {
        assert!(read_text(false, true));
        assert!(read_text(false, false));
        assert!(read_text(true, false));
        assert!(!read_text(true, true));
    }

    #[test]
    fn targets_serialize_for_the_engine() {
        assert_eq!(agent_desktop_window_id(WindowHandle(131_844)), "w-131844");
        let target = ScreenTarget {
            window_id: "w-1".into(),
            app: Some("notepad.exe".into()),
            window_title: None,
            chromium: false,
        };
        assert_eq!(
            response_with("r9", Ok(target)),
            json!({ "type": "response", "id": "r9", "ok": true,
                    "data": { "windowId": "w-1", "app": "notepad.exe", "chromium": false } })
        );
        let capture = ScreenCapture {
            window_id: Some("w-2".into()),
            chromium: true,
            ..Default::default()
        };
        assert_eq!(
            serde_json::to_value(capture).unwrap(),
            json!({ "windowId": "w-2", "chromium": true })
        );
    }

    #[test]
    fn responses() {
        let ok = response(
            "r1",
            Ok(ScreenCapture {
                app: Some("a.exe".into()),
                ..Default::default()
            }),
        );
        assert_eq!(
            ok,
            json!({ "type": "response", "id": "r1", "ok": true, "data": { "app": "a.exe" } })
        );
        let err = response("r2", Err("nope".into()));
        assert_eq!(err["ok"], false);
        assert_eq!(err["error"], "nope");
    }
}
