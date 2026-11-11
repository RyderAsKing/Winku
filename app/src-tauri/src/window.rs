//! The main window and its three modes (pill, bar, transcript), plus the on-demand Settings and
//! History windows. Everything grows out of the pill: the window is a fixed "stage" with the pill
//! in one corner, and the bar and the reply bubble extend from there toward the screen's middle.
//! On Windows the stage is clipped to the shapes the UI reports, so the transparent rest of it
//! neither paints nor takes clicks, and nothing is resized while a reply streams. Geometry is pure
//! (physical pixels, `Rect`, `MonitorInfo`) and unit-tested; the Tauri glue feeds it real monitors.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow,
};

use crate::settings::{self, Point};

pub const MAIN: &str = "main";

/// Logical px within which the pill snaps to a work-area edge.
pub const SNAP_DISTANCE: f64 = 24.0;
/// How long the pill must be still after a move before it snaps and is saved.
const SETTLE: Duration = Duration::from_millis(250);

/// The eyes' size preset (Settings > Appearance). Everything else scales from the pill.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EyeSize {
    Small,
    Medium,
    Large,
}

impl EyeSize {
    pub fn parse(value: &str) -> Self {
        match value {
            "medium" => Self::Medium,
            "large" => Self::Large,
            _ => Self::Small,
        }
    }

    /// The resting pill, logical px. Keep in step with `app/ui/src/main/stage.ts`.
    pub fn pill(self) -> (f64, f64) {
        match self {
            Self::Small => (92.0, 56.0),
            Self::Medium => (116.0, 70.0),
            Self::Large => (140.0, 84.0),
        }
    }
}

/// Which way things grow from the pill: toward the middle of its monitor.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Layout {
    /// The pill is on the right half: the bar and bubble extend to its left.
    pub align_right: bool,
    /// The pill is low on the screen: the bubble goes above it.
    pub above: bool,
}

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
pub fn default_pill_position(primary: &MonitorInfo, pill: (f64, f64)) -> (f64, f64) {
    let size = scaled(pill, primary.scale);
    let work = primary.work;
    clamp_into(
        (work.right() - size.0, work.y + work.h / 3.0 - size.1 / 2.0),
        size,
        work,
    )
}

/// Things grow toward the middle of the monitor: left when the pill is on the right half, and up
/// when it sits in the lower 40% of the work area.
pub fn layout_for(anchor: Rect, work: Rect) -> Layout {
    Layout {
        align_right: anchor.x + anchor.w / 2.0 > work.x + work.w / 2.0,
        above: anchor.y + anchor.h / 2.0 > work.y + work.h * 0.6,
    }
}

/// The stage (the whole window) of `size` with the pill `anchor` in the corner `layout` names.
pub fn stage_rect(anchor: Rect, size: (f64, f64), layout: Layout) -> Rect {
    let x = if layout.align_right {
        anchor.right() - size.0
    } else {
        anchor.x
    };
    let y = if layout.above {
        anchor.bottom() - size.1
    } else {
        anchor.y
    };
    Rect {
        x,
        y,
        w: size.0,
        h: size.1,
    }
}

/// Where the pill is inside a window at `window`: the inverse of `stage_rect`. A pill-sized
/// window is its own anchor.
pub fn anchor_in(window: Rect, pill: (f64, f64), layout: Layout) -> Rect {
    let x = if layout.align_right {
        window.right() - pill.0
    } else {
        window.x
    };
    let y = if layout.above {
        window.bottom() - pill.1
    } else {
        window.y
    };
    Rect {
        x,
        y,
        w: pill.0,
        h: pill.1,
    }
}

/// The pill after a size change: an edge it was flush against stays flush, otherwise its centre
/// stays put.
pub fn resize_anchor(anchor: Rect, pill: (f64, f64), work: Rect) -> Rect {
    let flush = |a: f64, b: f64| (a - b).abs() <= 2.0;
    let x = if flush(anchor.right(), work.right()) {
        work.right() - pill.0
    } else if flush(anchor.x, work.x) {
        anchor.x
    } else {
        anchor.x + (anchor.w - pill.0) / 2.0
    };
    let y = if flush(anchor.bottom(), work.bottom()) {
        work.bottom() - pill.1
    } else if flush(anchor.y, work.y) {
        anchor.y
    } else {
        anchor.y + (anchor.h - pill.1) / 2.0
    };
    let (x, y) = clamp_into((x, y), pill, work);
    Rect {
        x,
        y,
        w: pill.0,
        h: pill.1,
    }
}

/// Logical size to physical.
pub fn scaled(size: (f64, f64), scale: f64) -> (f64, f64) {
    ((size.0 * scale).round(), (size.1 * scale).round())
}

// ───────────────────────────── runtime ─────────────────────────────

/// Managed state for the main window.
pub struct WindowState {
    mode: Mutex<Mode>,
    view: Mutex<View>,
    move_generation: AtomicU64,
}

#[derive(Clone, Debug, Default)]
struct View {
    /// The pill on screen, physical px. None until first placed.
    anchor: Option<Rect>,
    layout: Option<Layout>,
    /// The stage size the UI asked for, logical px.
    stage: Option<(f64, f64)>,
    /// The window spans the stage (rather than just the pill).
    staged: bool,
}

impl Default for WindowState {
    fn default() -> Self {
        Self {
            mode: Mutex::new(Mode::Pill),
            view: Mutex::new(View::default()),
            move_generation: AtomicU64::new(0),
        }
    }
}

impl WindowState {
    pub fn mode(&self) -> Mode {
        *self.mode.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn view(&self) -> std::sync::MutexGuard<'_, View> {
        self.view.lock().unwrap_or_else(|e| e.into_inner())
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

fn handle(window: &WebviewWindow) -> Option<crate::platform::WindowHandle> {
    #[cfg(windows)]
    {
        window
            .hwnd()
            .ok()
            .map(|h| crate::platform::WindowHandle(h.0 as isize))
    }
    #[cfg(not(windows))]
    {
        let _ = window;
        None
    }
}

fn current_rect(window: &WebviewWindow) -> Option<Rect> {
    let (pos, size) = (window.outer_position().ok()?, window.outer_size().ok()?);
    Some(Rect {
        x: pos.x as f64,
        y: pos.y as f64,
        w: size.width as f64,
        h: size.height as f64,
    })
}

/// Moves and resizes in one step where the OS allows it, so no frame shows the old size at the
/// new position. Does nothing when the window is already there.
fn place(window: &WebviewWindow, rect: Rect) -> Result<(), String> {
    let (x, y, w, h) = (
        rect.x.round() as i32,
        rect.y.round() as i32,
        rect.w.round().max(1.0) as u32,
        rect.h.round().max(1.0) as u32,
    );
    if let Some(now) = current_rect(window) {
        if (now.x as i32, now.y as i32, now.w as u32, now.h as u32) == (x, y, w, h) {
            return Ok(());
        }
    }
    if let Some(hwnd) = handle(window) {
        if crate::platform::set_window_rect(hwnd, x, y, w as i32, h as i32) {
            return Ok(());
        }
    }
    window
        .set_position(PhysicalPosition::new(x, y))
        .and_then(|_| window.set_size(PhysicalSize::new(w, h)))
        .map_err(|e| e.to_string())
}

fn eye_size(app: &AppHandle) -> EyeSize {
    EyeSize::parse(&app.state::<settings::Store>().get().eyes.size)
}

/// The pill for the current monitor setup: the saved position, else the default.
fn saved_pill(app: &AppHandle, window: &WebviewWindow) -> Option<(Rect, MonitorInfo)> {
    let all = monitors(window);
    let primary = window
        .primary_monitor()
        .ok()
        .flatten()
        .map(|m| to_info(&m))
        .or_else(|| all.first().copied())?;
    let pill = eye_size(app).pill();
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
            clamp_into((x, y), scaled(pill, monitor.scale), monitor.work)
        }
        None => default_pill_position(&primary, pill),
    };
    let monitor = monitor_at(&all, x, y).unwrap_or(primary);
    let (w, h) = scaled(pill, monitor.scale);
    Some((Rect { x, y, w, h }, monitor))
}

/// Puts the window where the view says: the stage around the anchor once the UI has asked for
/// one (always on Windows, where the region hides the rest), otherwise just the pill.
fn apply_view(window: &WebviewWindow, view: &View, monitor: &MonitorInfo) -> Result<(), String> {
    let (Some(anchor), Some(layout)) = (view.anchor, view.layout) else {
        return Ok(());
    };
    match view.stage {
        Some(stage) if view.staged => place(
            window,
            stage_rect(anchor, scaled(stage, monitor.scale), layout),
        ),
        _ => place(window, anchor),
    }
}

/// Places the pill from settings: at startup, when the eyes' size changes, and when the bar
/// closes (monitors may have changed meanwhile).
pub fn place_pill(app: &AppHandle) -> Result<(), String> {
    let window = main_window(app)?;
    let Some((anchor, monitor)) = saved_pill(app, &window) else {
        return Ok(());
    };
    let state = app.state::<WindowState>();
    let mut view = state.view();
    let layout = layout_for(anchor, monitor.work);
    let changed = view.layout != Some(layout);
    view.anchor = Some(anchor);
    view.layout = Some(layout);
    apply_view(&window, &view, &monitor)?;
    drop(view);
    if changed {
        emit_layout(app, layout);
    }
    Ok(())
}

fn emit_layout(app: &AppHandle, layout: Layout) {
    let _ = app.emit_to(
        MAIN,
        "ui",
        serde_json::json!({ "kind": "layout", "alignRight": layout.align_right, "above": layout.above }),
    );
}

/// One shape the UI draws, logical px relative to the stage's top-left.
#[derive(Clone, Copy, Debug, Deserialize)]
pub struct Shape {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// The UI reports its stage size and the shapes it is drawing (pill or bar, bubble). The window
/// becomes the stage around the pill, clipped to the shapes on Windows. Elsewhere there is no
/// clipping, so a bare pill keeps a pill-sized window. Returns which way things grow.
pub fn set_shape(app: &AppHandle, stage: (f64, f64), shapes: &[Shape]) -> Result<Layout, String> {
    let window = main_window(app)?;
    let state = app.state::<WindowState>();
    let mut view = state.view();
    if view.anchor.is_none() {
        drop(view);
        place_pill(app)?;
        view = state.view();
    }
    let (Some(anchor), Some(layout)) = (view.anchor, view.layout) else {
        return Err("no monitors".into());
    };
    let all = monitors(&window);
    let monitor = monitor_at(&all, anchor.x + anchor.w / 2.0, anchor.y + anchor.h / 2.0)
        .ok_or("no monitors")?;
    let pill = eye_size(app).pill();
    let bare_pill = shapes.len() == 1 && shapes[0].w <= pill.0 + 0.5 && shapes[0].h <= pill.1 + 0.5;
    view.stage = Some(stage);
    view.staged = cfg!(windows) || !bare_pill;
    apply_view(&window, &view, &monitor)?;
    if let Some(hwnd) = handle(&window) {
        let s = monitor.scale;
        let rects: Vec<(i32, i32, i32, i32)> = shapes
            .iter()
            .map(|r| {
                (
                    (r.x * s).floor() as i32,
                    (r.y * s).floor() as i32,
                    ((r.x + r.w) * s).ceil() as i32,
                    ((r.y + r.h) * s).ceil() as i32,
                )
            })
            .collect();
        crate::platform::set_window_region(hwnd, &rects);
    }
    Ok(layout)
}

/// Which way things grow right now.
pub fn layout(app: &AppHandle) -> Option<Layout> {
    app.state::<WindowState>().view().layout
}

/// Switches the main window's mode: focus and visibility only; the UI sizes things with
/// `set_shape`. `pill` doesn't take focus; `bar` and `transcript` do.
pub fn set_mode(app: &AppHandle, mode: Mode) -> Result<(), String> {
    let window = main_window(app)?;
    let state = app.state::<WindowState>();
    let previous = state.mode();
    *state.mode.lock().unwrap_or_else(|e| e.into_inner()) = mode;
    match mode {
        Mode::Pill => {
            let _ = window.set_focusable(false);
            if previous != Mode::Pill {
                place_pill(app)?;
            }
            apply_eyes_visibility(app);
        }
        Mode::Bar | Mode::Transcript => {
            if previous == Mode::Pill {
                // Pill click, or any other path to the bar: note what was in front first.
                crate::capture::note_summon(app);
            }
            let _ = window.set_focusable(true);
            window.show().map_err(|e| e.to_string())?;
            let _ = window.set_focus();
        }
    }
    Ok(())
}

/// The eyes' size changed: keep the pill's edge (or centre) and save the new position.
pub fn on_size_changed(app: &AppHandle) {
    let Ok(window) = main_window(app) else { return };
    let state = app.state::<WindowState>();
    let Some(anchor) = state.view().anchor else {
        return;
    };
    let all = monitors(&window);
    let Some(monitor) = monitor_at(&all, anchor.x + anchor.w / 2.0, anchor.y + anchor.h / 2.0)
    else {
        return;
    };
    let pill = scaled(eye_size(app).pill(), monitor.scale);
    let next = resize_anchor(anchor, pill, monitor.work);
    save_position(app, &all, next);
    let _ = place_pill(app);
}

fn save_position(app: &AppHandle, all: &[MonitorInfo], anchor: Rect) {
    let signature = layout_signature(all);
    let point = Point {
        x: anchor.x,
        y: anchor.y,
    };
    let store = app.state::<settings::Store>();
    if store.get().eyes.positions.get(&signature) == Some(&point) {
        return;
    }
    if let Ok((_, new)) = store.update(|s| {
        s.eyes.positions.insert(signature, point);
    }) {
        let _ = app.emit(crate::commands::SETTINGS_CHANGED, &new);
    }
}

/// Shows or hides the pill per `eyes.hidden` and keeps the tray icon in step. The bar always
/// shows; hidden eyes only hide the pill. A focused fullscreen app also hides the pill.
pub fn apply_eyes_visibility(app: &AppHandle) {
    let hidden = app.state::<settings::Store>().get().eyes.hidden;
    crate::menu::set_tray_visible(app, hidden);
    let Ok(window) = main_window(app) else { return };
    if app.state::<WindowState>().mode() == Mode::Pill {
        let hide = hidden || crate::fullscreen::active();
        let _ = if hide { window.hide() } else { window.show() };
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
    let Some(rect) = current_rect(&window) else {
        return;
    };
    let state = app.state::<WindowState>();
    let mut view = state.view();
    let Some(layout) = view.layout else { return };
    let all = monitors(&window);
    let probe = Rect {
        w: 1.0,
        h: 1.0,
        ..rect
    };
    let Some(first) = monitor_at(&all, probe.x, probe.y) else {
        return;
    };
    let pill = scaled(eye_size(app).pill(), first.scale);
    let dropped = anchor_in(rect, pill, layout);
    let Some(monitor) = monitor_at(
        &all,
        dropped.x + dropped.w / 2.0,
        dropped.y + dropped.h / 2.0,
    ) else {
        return;
    };
    let (x, y) = snap(
        (dropped.x, dropped.y),
        pill,
        monitor.work,
        SNAP_DISTANCE * monitor.scale,
    );
    let anchor = Rect { x, y, ..dropped };
    if view.anchor == Some(anchor) {
        return;
    }
    let next = layout_for(anchor, monitor.work);
    view.anchor = Some(anchor);
    view.layout = Some(next);
    let _ = apply_view(&window, &view, &monitor);
    drop(view);
    if next != layout {
        emit_layout(app, next);
    }
    save_position(app, &all, anchor);
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
            (860.0, 600.0),
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
        .min_inner_size(520.0, 400.0)
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
        let large = EyeSize::Large.pill();
        assert_eq!(
            default_pill_position(&m, large),
            (1780.0, 1032.0 / 3.0 - 42.0)
        );
        let hi = monitor(0.0, 0.0, 3840.0, 2160.0, 2.0);
        assert_eq!(default_pill_position(&hi, large).0, 3840.0 - 280.0);
        assert_eq!(
            default_pill_position(&m, EyeSize::Small.pill()).0,
            1920.0 - 92.0
        );
    }

    #[test]
    fn sizes_parse_with_small_as_the_fallback() {
        assert_eq!(EyeSize::parse("large"), EyeSize::Large);
        assert_eq!(EyeSize::parse("medium"), EyeSize::Medium);
        assert_eq!(EyeSize::parse("small"), EyeSize::Small);
        assert_eq!(EyeSize::parse("huge"), EyeSize::Small);
    }

    const WORK: Rect = Rect {
        x: 0.0,
        y: 0.0,
        w: 1920.0,
        h: 1032.0,
    };

    fn pill_at(x: f64, y: f64) -> Rect {
        Rect {
            x,
            y,
            w: 92.0,
            h: 56.0,
        }
    }

    #[test]
    fn things_grow_toward_the_middle() {
        let right_top = layout_for(pill_at(1828.0, 300.0), WORK);
        assert_eq!(
            right_top,
            Layout {
                align_right: true,
                above: false
            }
        );
        let left_low = layout_for(pill_at(0.0, 900.0), WORK);
        assert_eq!(
            left_low,
            Layout {
                align_right: false,
                above: true
            }
        );
    }

    #[test]
    fn the_stage_keeps_the_pill_in_its_corner() {
        let anchor = pill_at(1828.0, 300.0);
        let layouts = [(false, false), (true, false), (false, true), (true, true)];
        for (align_right, above) in layouts {
            let layout = Layout { align_right, above };
            let stage = stage_rect(anchor, (400.0, 424.0), layout);
            assert_eq!(anchor_in(stage, (92.0, 56.0), layout), anchor, "{layout:?}");
        }
        let right_below = stage_rect(
            anchor,
            (400.0, 424.0),
            Layout {
                align_right: true,
                above: false,
            },
        );
        assert_eq!((right_below.x, right_below.y), (1520.0, 300.0));
        assert_eq!(
            anchor_in(
                anchor,
                (92.0, 56.0),
                Layout {
                    align_right: true,
                    above: true
                }
            ),
            anchor,
            "a pill-sized window is its own anchor"
        );
    }

    #[test]
    fn resizing_keeps_a_flush_edge_or_the_centre() {
        let large_on_right = Rect {
            x: 1780.0,
            y: 300.0,
            w: 140.0,
            h: 84.0,
        };
        let small = resize_anchor(large_on_right, (92.0, 56.0), WORK);
        assert_eq!((small.x, small.y), (1828.0, 314.0));
        let floating = Rect {
            x: 600.0,
            y: 0.0,
            w: 140.0,
            h: 84.0,
        };
        let small = resize_anchor(floating, (92.0, 56.0), WORK);
        assert_eq!((small.x, small.y), (624.0, 0.0));
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
