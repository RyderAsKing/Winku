//! The main window and its three modes (pill, bar, transcript), plus the on-demand Settings and
//! History windows. Geometry is pure (physical pixels, `Rect`, `MonitorInfo`) and unit-tested;
//! the Tauri glue at the bottom feeds it real monitors.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::Deserialize;
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow,
};

use crate::settings::{self, Point};

pub const MAIN: &str = "main";

pub const PILL: (f64, f64) = (140.0, 84.0);
pub const BAR_WIDTH: f64 = 560.0;
pub const BAR_MIN_HEIGHT: f64 = 72.0;
pub const BAR_MAX_REPLY: f64 = 360.0;
pub const TRANSCRIPT: (f64, f64) = (420.0, 560.0);
pub const TRANSCRIPT_WIDE: f64 = 480.0;
/// Monitors at least this wide (logical px) get the wide transcript.
pub const WIDE_MONITOR: f64 = 2560.0;
/// The bar's top edge sits this far down the monitor.
pub const BAR_TOP_FRACTION: f64 = 0.12;
/// Logical px within which the pill snaps to a work-area edge.
pub const SNAP_DISTANCE: f64 = 24.0;
/// How long the pill must be still after a move before it snaps and is saved.
const SETTLE: Duration = Duration::from_millis(250);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Pill,
    Bar,
    Transcript,
}

// ───────────────────────────── pure geometry ─────────────────────────────

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl Rect {
    pub fn contains(&self, x: f64, y: f64) -> bool {
        x >= self.x && x < self.x + self.w && y >= self.y && y < self.y + self.h
    }
    fn right(&self) -> f64 {
        self.x + self.w
    }
    fn bottom(&self) -> f64 {
        self.y + self.h
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct MonitorInfo {
    /// Whole monitor, physical px.
    pub bounds: Rect,
    /// Monitor minus the taskbar, physical px.
    pub work: Rect,
    pub scale: f64,
}

impl MonitorInfo {
    pub fn logical_width(&self) -> f64 {
        self.bounds.w / self.scale
    }
}

/// Identifies a monitor setup, so the pill remembers one position per setup (laptop alone,
/// laptop + dock, …). Order-independent.
pub fn layout_signature(monitors: &[MonitorInfo]) -> String {
    let mut parts: Vec<String> = monitors
        .iter()
        .map(|m| {
            format!(
                "{}x{}@{},{}x{}",
                m.bounds.w,
                m.bounds.h,
                m.bounds.x,
                m.bounds.y,
                (m.scale * 100.0).round()
            )
        })
        .collect();
    parts.sort();
    parts.join("|")
}

/// The monitor containing the point, else the one whose centre is nearest.
pub fn monitor_at(monitors: &[MonitorInfo], x: f64, y: f64) -> Option<MonitorInfo> {
    monitors
        .iter()
        .find(|m| m.bounds.contains(x, y))
        .copied()
        .or_else(|| {
            monitors
                .iter()
                .min_by(|a, b| distance_sq(a.bounds, x, y).total_cmp(&distance_sq(b.bounds, x, y)))
                .copied()
        })
}

fn distance_sq(r: Rect, x: f64, y: f64) -> f64 {
    let (cx, cy) = (r.x + r.w / 2.0, r.y + r.h / 2.0);
    (cx - x).powi(2) + (cy - y).powi(2)
}

/// Moves `pos` so a window of `size` lies inside `area` (top-left wins if it can't fit).
pub fn clamp_into(pos: (f64, f64), size: (f64, f64), area: Rect) -> (f64, f64) {
    let x = pos.0.min(area.right() - size.0).max(area.x);
    let y = pos.1.min(area.bottom() - size.1).max(area.y);
    (x, y)
}

/// Keeps the window inside `area` and pulls each axis onto the nearest edge when it is within
/// `threshold` px of it.
pub fn snap(pos: (f64, f64), size: (f64, f64), area: Rect, threshold: f64) -> (f64, f64) {
    let (mut x, mut y) = clamp_into(pos, size, area);
    let (left, right) = (x - area.x, area.right() - (x + size.0));
    if left.min(right) <= threshold {
        x = if left <= right {
            area.x
        } else {
            area.right() - size.0
        };
    }
    let (top, bottom) = (y - area.y, area.bottom() - (y + size.1));
    if top.min(bottom) <= threshold {
        y = if top <= bottom {
            area.y
        } else {
            area.bottom() - size.1
        };
    }
    (x, y)
}

/// Where the pill goes when nothing is saved: right edge, a third of the way down.
pub fn default_pill_position(primary: &MonitorInfo) -> (f64, f64) {
    let size = scaled(PILL, primary.scale);
    let work = primary.work;
    clamp_into(
        (work.right() - size.0, work.y + work.h / 3.0 - size.1 / 2.0),
        size,
        work,
    )
}

/// Clamps a requested bar height (logical px, input row plus reply) to 72…72+360.
pub fn clamp_bar_height(height: f64) -> f64 {
    if height.is_nan() {
        return BAR_MIN_HEIGHT;
    }
    height.clamp(BAR_MIN_HEIGHT, BAR_MIN_HEIGHT + BAR_MAX_REPLY)
}

/// The bar: top centre of the monitor, 12% down.
pub fn bar_rect(monitor: &MonitorInfo, height: f64) -> Rect {
    let (w, h) = scaled((BAR_WIDTH, clamp_bar_height(height)), monitor.scale);
    let b = monitor.bounds;
    let x = b.x + (b.w - w) / 2.0;
    let y = b.y + b.h * BAR_TOP_FRACTION;
    let (x, y) = clamp_into((x, y), (w, h), monitor.work);
    Rect { x, y, w, h }
}

/// The transcript keeps the bar's horizontal centre and top edge.
pub fn transcript_rect(monitor: &MonitorInfo, bar: Rect) -> Rect {
    let width = if monitor.logical_width() >= WIDE_MONITOR {
        TRANSCRIPT_WIDE
    } else {
        TRANSCRIPT.0
    };
    let (w, h) = scaled((width, TRANSCRIPT.1), monitor.scale);
    // Short screens: shrink to fit rather than run under the taskbar.
    let h = h.min(monitor.work.h);
    let (x, y) = clamp_into((bar.x + bar.w / 2.0 - w / 2.0, bar.y), (w, h), monitor.work);
    Rect { x, y, w, h }
}

/// Logical size to physical.
pub fn scaled(size: (f64, f64), scale: f64) -> (f64, f64) {
    ((size.0 * scale).round(), (size.1 * scale).round())
}

// ───────────────────────────── runtime ─────────────────────────────

/// Managed state for the main window.
pub struct WindowState {
    mode: Mutex<Mode>,
    /// The bar's current rect (physical) and monitor, so height changes and the transcript
    /// stay anchored.
    bar: Mutex<Option<(Rect, MonitorInfo)>>,
    bar_height: Mutex<f64>,
    move_generation: AtomicU64,
}

impl Default for WindowState {
    fn default() -> Self {
        Self {
            mode: Mutex::new(Mode::Pill),
            bar: Mutex::new(None),
            bar_height: Mutex::new(BAR_MIN_HEIGHT),
            move_generation: AtomicU64::new(0),
        }
    }
}

impl WindowState {
    pub fn mode(&self) -> Mode {
        *self.mode.lock().unwrap_or_else(|e| e.into_inner())
    }
}

fn main_window(app: &AppHandle) -> Result<WebviewWindow, String> {
    app.get_webview_window(MAIN)
        .ok_or_else(|| "main window is missing".to_string())
}

fn monitors(window: &WebviewWindow) -> Vec<MonitorInfo> {
    window
        .available_monitors()
        .unwrap_or_default()
        .iter()
        .map(to_info)
        .collect()
}

fn to_info(m: &tauri::Monitor) -> MonitorInfo {
    let (p, s, w) = (m.position(), m.size(), m.work_area());
    MonitorInfo {
        bounds: Rect {
            x: p.x as f64,
            y: p.y as f64,
            w: s.width as f64,
            h: s.height as f64,
        },
        work: Rect {
            x: w.position.x as f64,
            y: w.position.y as f64,
            w: w.size.width as f64,
            h: w.size.height as f64,
        },
        scale: m.scale_factor(),
    }
}

fn place(window: &WebviewWindow, rect: Rect) -> Result<(), String> {
    window
        .set_position(PhysicalPosition::new(
            rect.x.round() as i32,
            rect.y.round() as i32,
        ))
        .and_then(|_| {
            window.set_size(PhysicalSize::new(
                rect.w.round() as u32,
                rect.h.round() as u32,
            ))
        })
        .map_err(|e| e.to_string())
}

/// The pill's rect for the current monitor setup: the saved position, else the default.
fn pill_rect(app: &AppHandle, window: &WebviewWindow) -> Option<Rect> {
    let all = monitors(window);
    let primary = window
        .primary_monitor()
        .ok()
        .flatten()
        .map(|m| to_info(&m))
        .or_else(|| all.first().copied())?;
    let saved = app
        .state::<settings::Store>()
        .get()
        .eyes
        .positions
        .get(&layout_signature(&all))
        .copied();
    let (x, y) = match saved {
        Some(Point { x, y }) => {
            let monitor = monitor_at(&all, x, y).unwrap_or(primary);
            clamp_into((x, y), scaled(PILL, monitor.scale), monitor.work)
        }
        None => default_pill_position(&primary),
    };
    let monitor = monitor_at(&all, x, y).unwrap_or(primary);
    let (w, h) = scaled(PILL, monitor.scale);
    Some(Rect { x, y, w, h })
}

/// Switches the main window's mode. `pill` doesn't take focus; `bar` and `transcript` do.
pub fn set_mode(app: &AppHandle, mode: Mode) -> Result<(), String> {
    let window = main_window(app)?;
    let state = app.state::<WindowState>();
    let previous = state.mode();
    *state.mode.lock().unwrap_or_else(|e| e.into_inner()) = mode;
    match mode {
        Mode::Pill => {
            *state.bar.lock().unwrap_or_else(|e| e.into_inner()) = None;
            *state.bar_height.lock().unwrap_or_else(|e| e.into_inner()) = BAR_MIN_HEIGHT;
            let _ = window.set_focusable(false);
            if let Some(rect) = pill_rect(app, &window) {
                place(&window, rect)?;
            }
            apply_eyes_visibility(app);
        }
        Mode::Bar | Mode::Transcript => {
            if previous == Mode::Pill {
                // Pill click, or any other path to the bar: note what was in front first.
                crate::capture::note_summon(app);
            }
            let anchored = *state.bar.lock().unwrap_or_else(|e| e.into_inner());
            let (bar, monitor) = match anchored {
                Some(anchor) if previous != Mode::Pill => anchor,
                _ => {
                    let all = monitors(&window);
                    let cursor = app.cursor_position().map_err(|e| e.to_string())?;
                    let monitor = monitor_at(&all, cursor.x, cursor.y).ok_or("no monitors")?;
                    let height = *state.bar_height.lock().unwrap_or_else(|e| e.into_inner());
                    (bar_rect(&monitor, height), monitor)
                }
            };
            *state.bar.lock().unwrap_or_else(|e| e.into_inner()) = Some((bar, monitor));
            let rect = if mode == Mode::Bar {
                bar
            } else {
                transcript_rect(&monitor, bar)
            };
            let _ = window.set_focusable(true);
            place(&window, rect)?;
            window.show().map_err(|e| e.to_string())?;
            let _ = window.set_focus();
        }
    }
    Ok(())
}

/// Resizes the bar as a reply streams in. `height` is the whole bar in logical px.
pub fn set_bar_height(app: &AppHandle, height: f64) -> Result<(), String> {
    let state = app.state::<WindowState>();
    let height = clamp_bar_height(height);
    *state.bar_height.lock().unwrap_or_else(|e| e.into_inner()) = height;
    if state.mode() != Mode::Bar {
        return Ok(());
    }
    let mut anchor = state.bar.lock().unwrap_or_else(|e| e.into_inner());
    let Some((bar, monitor)) = *anchor else {
        return Ok(());
    };
    let rect = Rect {
        h: (height * monitor.scale).round(),
        ..bar
    };
    *anchor = Some((rect, monitor));
    place(&main_window(app)?, rect)
}

/// Shows or hides the pill per `eyes.hidden` and keeps the tray icon in step. The bar always
/// shows; hidden eyes only hide the pill.
pub fn apply_eyes_visibility(app: &AppHandle) {
    let hidden = app.state::<settings::Store>().get().eyes.hidden;
    crate::menu::set_tray_visible(app, hidden);
    let Ok(window) = main_window(app) else { return };
    if app.state::<WindowState>().mode() == Mode::Pill {
        let _ = if hidden { window.hide() } else { window.show() };
    }
}

/// Called on every `Moved` of the main window. Once the pill has been still for a moment (and
/// the mouse button is up), snap it to a nearby edge and save the position for this setup.
pub fn on_moved(app: &AppHandle) {
    let state = app.state::<WindowState>();
    if state.mode() != Mode::Pill {
        return;
    }
    let generation = state.move_generation.fetch_add(1, Ordering::SeqCst) + 1;
    let app = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(SETTLE);
        let state = app.state::<WindowState>();
        if state.move_generation.load(Ordering::SeqCst) != generation || state.mode() != Mode::Pill
        {
            return;
        }
        if crate::platform::mouse_button_down() {
            continue;
        }
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || settle_pill(&handle));
        return;
    });
}

fn settle_pill(app: &AppHandle) {
    let Ok(window) = main_window(app) else { return };
    let (Ok(pos), Ok(size)) = (window.outer_position(), window.outer_size()) else {
        return;
    };
    let all = monitors(&window);
    let (w, h) = (size.width as f64, size.height as f64);
    let Some(monitor) = monitor_at(&all, pos.x as f64 + w / 2.0, pos.y as f64 + h / 2.0) else {
        return;
    };
    let (x, y) = snap(
        (pos.x as f64, pos.y as f64),
        (w, h),
        monitor.work,
        SNAP_DISTANCE * monitor.scale,
    );
    if (x, y) != (pos.x as f64, pos.y as f64) {
        let _ = window.set_position(PhysicalPosition::new(x as i32, y as i32));
    }
    let signature = layout_signature(&all);
    let store = app.state::<settings::Store>();
    if store.get().eyes.positions.get(&signature) == Some(&Point { x, y }) {
        return;
    }
    if let Ok((_, new)) = store.update(|s| {
        s.eyes.positions.insert(signature, Point { x, y });
    }) {
        let _ = app.emit(crate::commands::SETTINGS_CHANGED, &new);
    }
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Page {
    Settings,
    History,
}

/// Shows the Settings or History window, creating it if needed. It is destroyed on close.
pub fn open_page(app: &AppHandle, page: Page) -> Result<(), String> {
    let (label, url, title, size) = match page {
        Page::Settings => (
            "settings",
            "settings.html",
            "Winku Settings",
            (680.0, 520.0),
        ),
        Page::History => ("history", "history.html", "Winku History", (720.0, 560.0)),
    };
    if let Some(window) = app.get_webview_window(label) {
        let _ = window.unminimize();
        let _ = window.show();
        return window.set_focus().map_err(|e| e.to_string());
    }
    tauri::WebviewWindowBuilder::new(app, label, WebviewUrl::App(url.into()))
        .title(title)
        .inner_size(size.0, size.1)
        .min_inner_size(480.0, 360.0)
        .center()
        .focused(true)
        .build()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn monitor(x: f64, y: f64, w: f64, h: f64, scale: f64) -> MonitorInfo {
        let bounds = Rect { x, y, w, h };
        MonitorInfo {
            bounds,
            work: Rect {
                h: h - 48.0 * scale,
                ..bounds
            },
            scale,
        }
    }

    #[test]
    fn snaps_to_nearest_edge_within_threshold() {
        let area = Rect {
            x: 0.0,
            y: 0.0,
            w: 1920.0,
            h: 1032.0,
        };
        let size = (140.0, 84.0);
        assert_eq!(snap((20.0, 500.0), size, area, 24.0), (0.0, 500.0));
        assert_eq!(
            snap((1920.0 - 140.0 - 24.0, 500.0), size, area, 24.0),
            (1780.0, 500.0)
        );
        assert_eq!(
            snap((300.0, 1032.0 - 84.0 - 10.0), size, area, 24.0),
            (300.0, 948.0)
        );
        assert_eq!(
            snap((10.0, 5.0), size, area, 24.0),
            (0.0, 0.0),
            "corner snaps both axes"
        );
        assert_eq!(
            snap((25.0, 500.0), size, area, 24.0),
            (25.0, 500.0),
            "just outside stays put"
        );
        assert_eq!(
            snap((-50.0, 2000.0), size, area, 24.0),
            (0.0, 948.0),
            "off-screen is pulled back"
        );
    }

    #[test]
    fn snap_respects_offset_monitors() {
        let area = Rect {
            x: -1280.0,
            y: 200.0,
            w: 1280.0,
            h: 1024.0,
        };
        assert_eq!(
            snap((-1270.0, 600.0), (140.0, 84.0), area, 24.0),
            (-1280.0, 600.0)
        );
        assert_eq!(
            snap((-150.0, 210.0), (140.0, 84.0), area, 24.0),
            (-140.0, 200.0)
        );
    }

    #[test]
    fn clamps_into_area() {
        let area = Rect {
            x: 0.0,
            y: 0.0,
            w: 100.0,
            h: 100.0,
        };
        assert_eq!(clamp_into((90.0, -5.0), (20.0, 20.0), area), (80.0, 0.0));
        assert_eq!(clamp_into((10.0, 10.0), (200.0, 20.0), area), (0.0, 10.0));
    }

    #[test]
    fn default_pill_is_right_edge_third_down() {
        let m = monitor(0.0, 0.0, 1920.0, 1080.0, 1.0);
        assert_eq!(default_pill_position(&m), (1780.0, 1032.0 / 3.0 - 42.0));
        let hi = monitor(0.0, 0.0, 3840.0, 2160.0, 2.0);
        assert_eq!(default_pill_position(&hi).0, 3840.0 - 280.0);
    }

    #[test]
    fn bar_is_top_centre_twelve_percent_down() {
        let m = monitor(1920.0, 0.0, 1920.0, 1080.0, 1.0);
        assert_eq!(
            bar_rect(&m, 72.0),
            Rect {
                x: 1920.0 + 680.0,
                y: 129.6,
                w: 560.0,
                h: 72.0
            }
        );
        let hi = monitor(0.0, 0.0, 2880.0, 1800.0, 2.0);
        let r = bar_rect(&hi, 100.0);
        assert_eq!((r.w, r.h, r.x), (1120.0, 200.0, 880.0));
    }

    #[test]
    fn bar_height_is_clamped() {
        assert_eq!(clamp_bar_height(10.0), 72.0);
        assert_eq!(clamp_bar_height(200.0), 200.0);
        assert_eq!(clamp_bar_height(9000.0), 432.0);
        assert_eq!(clamp_bar_height(f64::NAN), 72.0);
    }

    #[test]
    fn transcript_keeps_bar_centre_and_widens_on_large_monitors() {
        let m = monitor(0.0, 0.0, 1920.0, 1080.0, 1.0);
        let bar = bar_rect(&m, 72.0);
        let t = transcript_rect(&m, bar);
        assert_eq!((t.w, t.h), (420.0, 560.0));
        assert_eq!(t.x + t.w / 2.0, bar.x + bar.w / 2.0);
        assert_eq!(t.y, bar.y);
        let wide = monitor(0.0, 0.0, 2560.0, 1440.0, 1.0);
        assert_eq!(transcript_rect(&wide, bar_rect(&wide, 72.0)).w, 480.0);
        let scaled_4k = monitor(0.0, 0.0, 3840.0, 2160.0, 1.5);
        assert_eq!(
            transcript_rect(&scaled_4k, bar_rect(&scaled_4k, 72.0)).w,
            720.0,
            "2560 logical"
        );
        let small = monitor(0.0, 0.0, 1366.0, 600.0, 1.0);
        let t = transcript_rect(&small, bar_rect(&small, 72.0));
        assert!(t.y + t.h <= small.work.y + small.work.h);
    }

    #[test]
    fn signature_is_order_independent() {
        let a = monitor(0.0, 0.0, 1920.0, 1080.0, 1.0);
        let b = monitor(1920.0, 0.0, 2560.0, 1440.0, 1.25);
        assert_eq!(layout_signature(&[a, b]), layout_signature(&[b, a]));
        assert_ne!(layout_signature(&[a]), layout_signature(&[a, b]));
    }

    #[test]
    fn finds_monitor_under_point() {
        let a = monitor(0.0, 0.0, 1920.0, 1080.0, 1.0);
        let b = monitor(1920.0, 0.0, 1920.0, 1080.0, 1.0);
        assert_eq!(monitor_at(&[a, b], 2000.0, 10.0), Some(b));
        assert_eq!(
            monitor_at(&[a, b], -500.0, 10.0),
            Some(a),
            "outside: nearest"
        );
        assert_eq!(monitor_at(&[], 0.0, 0.0), None);
    }
}
