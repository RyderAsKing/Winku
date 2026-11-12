//! The floating guide (SPEC §5): with text selected, the hotkey guide shows in its own window just
//! above the first selected line instead of beside the eyes.
//!
//! The window (label `guide`) is transparent, undecorated and always on top; it never takes focus
//! or clicks and stays out of the taskbar and Alt+Tab. It is created hidden the first time a guide
//! floats and then reused. A hold goes: `show` stores the selection and sends the page a `guide`
//! event; the page renders the guide and reports its size with `guide_size`; the shell places the
//! window with `guide_rect` and shows it without activating it. `hide` hides it at once. If the
//! size hasn't arrived within `SIZE_DEADLINE` (a slow first window build or page load), the guide
//! shows beside the eyes for that hold and a late size is ignored. Placement and the hold's
//! stages (`Holds`) are pure and unit-tested; the rest is glue.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

use serde::Serialize;
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl};

use crate::platform::{ScreenRect, SelectedText};
use crate::window::{clamp_into, scaled, MonitorInfo, Rect};

pub const LABEL: &str = "guide";

/// Logical px between the selection's first line and the guide.
pub const GAP: f64 = 8.0;

/// Where the guide's window goes for a selection whose first line is `line` (physical px), given
/// the guide's size in logical px. Centred above the line with a small gap, below it when there
/// isn't room above, and kept inside the work area of the monitor that holds the line, at that
/// monitor's scale. None when the line has no size or isn't on any monitor.
pub fn guide_rect(line: Rect, monitors: &[MonitorInfo], guide: (f64, f64)) -> Option<Rect> {
    if line.w <= 0.0 || line.h <= 0.0 {
        return None;
    }
    let monitor = monitors.iter().find(|m| {
        m.bounds
            .contains(line.x + line.w / 2.0, line.y + line.h / 2.0)
    })?;
    let (w, h) = scaled(guide, monitor.scale);
    let gap = GAP * monitor.scale;
    let above = line.y - gap - h;
    let y = if above >= monitor.work.y {
        above
    } else {
        line.y + line.h + gap
    };
    let (x, y) = clamp_into((line.x + line.w / 2.0 - w / 2.0, y), (w, h), monitor.work);
    Some(Rect { x, y, w, h })
}

// ───────────────────────────── holds ─────────────────────────────

/// How long a hold waits for the page to report the guide's size before the guide shows beside
/// the eyes instead (a slow first window build or page load).
pub const SIZE_DEADLINE: Duration = Duration::from_millis(500);

/// Where a hold's guide is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Stage {
    /// Waiting for the page's size.
    Waiting,
    /// Placed over the selection.
    Floating,
    /// Beside the eyes: the size came too late or the window couldn't be made.
    Beside,
}

/// The holds that float the guide, one at a time. Pure: the runtime below does the window work
/// for what these transitions return.
#[derive(Debug)]
struct Holds {
    current: Option<(Showing, Stage)>,
    count: u64,
}

impl Holds {
    const fn new() -> Self {
        Self {
            current: None,
            count: 0,
        }
    }

    /// A new hold starts waiting for the page's size.
    fn start(&mut self, editable: bool, line: ScreenRect) -> Showing {
        self.count += 1;
        let showing = Showing {
            id: self.count,
            editable,
            line,
        };
        self.current = Some((showing, Stage::Waiting));
        showing
    }

    /// The hold is over. True when one was going.
    fn end(&mut self) -> bool {
        self.current.take().is_some()
    }

    /// The page reported the size for hold `id`: the guide to place, unless that hold is over or
    /// has already fallen back beside the eyes.
    fn sized(&mut self, id: u64) -> Option<Showing> {
        self.advance(id, Stage::Floating)
    }

    /// Hold `id`'s guide shows beside the eyes instead: its size didn't arrive in time or the
    /// window couldn't be made. The guide to show there, unless that hold is over or already
    /// floats.
    fn fall_back(&mut self, id: u64) -> Option<Showing> {
        self.advance(id, Stage::Beside)
    }

    fn advance(&mut self, id: u64, to: Stage) -> Option<Showing> {
        match &mut self.current {
            Some((showing, stage)) if showing.id == id && *stage == Stage::Waiting => {
                *stage = to;
                Some(*showing)
            }
            _ => None,
        }
    }

    /// Whether hold `id` still floats: checked after placing the window, which happens without
    /// the lock, so a hide in between is caught.
    fn floating(&self, id: u64) -> bool {
        matches!(self.current, Some((s, Stage::Floating)) if s.id == id)
    }

    /// The hold the page should draw: its guide's guide unless it shows beside the eyes.
    fn current(&self) -> Option<Showing> {
        self.current
            .filter(|(_, stage)| *stage != Stage::Beside)
            .map(|(showing, _)| showing)
    }
}

// ───────────────────────────── runtime ─────────────────────────────

/// The guide the page should show: which hold it is for, and whether the selection is editable.
#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Showing {
    pub id: u64,
    pub editable: bool,
    #[serde(skip)]
    line: ScreenRect,
}

static HOLDS: Mutex<Holds> = Mutex::new(Holds::new());
/// The window is being created.
static CREATING: AtomicBool = AtomicBool::new(false);
/// Serialises placements. `sized` holds it across the window call, which `HOLDS` is never held
/// across, so a hide from the key thread doesn't wait behind another thread's window.
static PLACING: Mutex<()> = Mutex::new(());

fn holds() -> MutexGuard<'static, Holds> {
    HOLDS.lock().unwrap_or_else(|e| e.into_inner())
}

/// Starts floating the guide over `text`. Err with why when it can't float (no usable
/// rectangle, or not on Windows): the caller shows the guide beside the eyes instead. If the page
/// hasn't reported the guide's size within `SIZE_DEADLINE`, the guide shows beside the eyes for
/// this hold.
pub fn show(app: &AppHandle, text: SelectedText) -> Result<(), &'static str> {
    if !cfg!(windows) {
        return Err("the guide floats only on Windows");
    }
    let Some(line) = text.line else {
        return Err("no rectangle for the selection");
    };
    // Only a line on a monitor can be placed; the guide's size doesn't matter for that.
    if guide_rect(to_rect(line), &crate::window::all_monitors(app), (1.0, 1.0)).is_none() {
        return Err("the selection's rectangle is on no monitor");
    }
    let showing = holds().start(text.editable, line);
    if app.get_webview_window(LABEL).is_some() {
        let _ = app.emit_to(
            LABEL,
            "guide",
            json!({ "show": true, "id": showing.id, "editable": showing.editable }),
        );
    } else {
        create(app);
    }
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(SIZE_DEADLINE);
        fall_back(&app, showing.id, "no size from the page in time");
    });
    Ok(())
}

/// Shows hold `id`'s guide beside the eyes, if it is still waiting for its size. The lock is
/// held while the event is sent (an event, not a window call), so a hide can't send its own
/// hide first and leave this guide showing.
fn fall_back(app: &AppHandle, id: u64, why: &str) {
    let mut holds = holds();
    let Some(showing) = holds.fall_back(id) else {
        return;
    };
    crate::hint::debug_log(&format!("guide: {why}, beside Winku instead"));
    crate::hint::emit_beside(
        app,
        true,
        Some(crate::platform::Selection::Text(SelectedText {
            editable: showing.editable,
            line: None,
        })),
    );
}

/// Hides the floating guide, if it shows or is about to.
pub fn hide(app: &AppHandle) {
    if !holds().end() {
        return;
    }
    crate::hint::debug_log("guide hide");
    if let Some(window) = app.get_webview_window(LABEL) {
        if let Some(hwnd) = crate::window::handle_of(&window) {
            crate::platform::hide_window(hwnd);
        }
        let _ = app.emit_to(LABEL, "guide", json!({ "show": false }));
    }
}

/// What the page should show now. It asks once it has loaded, since the event that created the
/// window was sent before it could listen.
pub fn current() -> Option<Showing> {
    holds().current()
}

/// The page has drawn the guide for hold `id` at `size` (logical px): place the window over the
/// selection and show it, unless that hold is over or its guide already shows beside the eyes.
pub fn sized(app: &AppHandle, id: u64, size: (f64, f64)) -> Result<(), String> {
    let _placing = PLACING.lock().unwrap_or_else(|e| e.into_inner());
    let Some(showing) = holds().current().filter(|s| s.id == id) else {
        return Ok(());
    };
    // On failure the hold keeps waiting and the deadline shows the guide beside the eyes.
    let window = app
        .get_webview_window(LABEL)
        .ok_or("the guide window is missing")?;
    let hwnd = crate::window::handle_of(&window).ok_or("the guide window has no handle")?;
    let monitors = crate::window::all_monitors(app);
    let rect = guide_rect(to_rect(showing.line), &monitors, size)
        .ok_or("the selection is not on a monitor")?;
    let scale = crate::window::monitor_at(&monitors, rect.x, rect.y).map_or(1.0, |m| m.scale);
    let (x, y, w, h) = (
        rect.x.round() as i32,
        rect.y.round() as i32,
        rect.w.round() as i32,
        rect.h.round() as i32,
    );
    if holds().sized(id).is_none() {
        return Ok(());
    }
    crate::platform::show_floating(
        hwnd,
        (x, y, w, h),
        (crate::window::BUBBLE_RADIUS * scale).round() as i32,
    );
    // A hide that came while the window was being placed may have run before it showed.
    if !holds().floating(id) {
        crate::platform::hide_window(hwnd);
        return Ok(());
    }
    crate::hint::debug_log(&format!("guide show {x},{y} {w}x{h}"));
    Ok(())
}

fn to_rect(line: ScreenRect) -> Rect {
    Rect {
        x: line.x as f64,
        y: line.y as f64,
        w: line.w as f64,
        h: line.h as f64,
    }
}

/// Creates the hidden guide window, off the calling thread (the raw input thread must not wait
/// for a web view). If it can't be made, the guide shows beside the eyes for this hold.
fn create(app: &AppHandle) {
    if CREATING.swap(true, Ordering::AcqRel) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let built =
            tauri::WebviewWindowBuilder::new(&app, LABEL, WebviewUrl::App("guide.html".into()))
                .title("Winku guide")
                .inner_size(320.0, 160.0)
                .position(-32000.0, -32000.0)
                .resizable(false)
                .decorations(false)
                .transparent(true)
                .always_on_top(true)
                .skip_taskbar(true)
                .shadow(false)
                .focused(false)
                .focusable(false)
                .visible(false)
                .build();
        CREATING.store(false, Ordering::Release);
        match built {
            Ok(window) => {
                // On the window's own thread: the frame's subclass can't be set from another.
                if let Some(hwnd) = crate::window::handle_of(&window) {
                    let _ = app.run_on_main_thread(move || crate::platform::floating_frame(hwnd));
                }
            }
            Err(e) => {
                eprintln!("winku: could not create the guide window: {e}");
                let id = holds().current().map(|s| s.id);
                if let Some(id) = id {
                    fall_back(&app, id, "the window could not be made");
                }
            }
        }
    });
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

    fn line(x: f64, y: f64, w: f64, h: f64) -> Rect {
        Rect { x, y, w, h }
    }

    const LINE: ScreenRect = ScreenRect {
        x: 700,
        y: 500,
        w: 200,
        h: 20,
    };

    #[test]
    fn a_size_in_time_floats_the_guide() {
        let mut holds = Holds::new();
        let hold = holds.start(true, LINE);
        assert_eq!(holds.sized(hold.id).map(|s| s.id), Some(hold.id));
        assert!(holds.floating(hold.id));
        assert!(
            holds.fall_back(hold.id).is_none(),
            "the deadline changes nothing"
        );
        assert!(holds.floating(hold.id));
    }

    #[test]
    fn no_size_in_time_shows_the_guide_beside_and_ignores_a_late_size() {
        let mut holds = Holds::new();
        let hold = holds.start(false, LINE);
        let beside = holds.fall_back(hold.id).unwrap();
        assert!(!beside.editable);
        assert!(holds.sized(hold.id).is_none(), "late size ignored");
        assert!(!holds.floating(hold.id));
        assert!(holds.current().is_none(), "the page draws nothing");
        assert!(holds.end(), "the hold still ends");
    }

    #[test]
    fn events_for_an_ended_hold_change_nothing() {
        let mut holds = Holds::new();
        let old = holds.start(true, LINE);
        assert!(holds.sized(old.id).is_some());
        assert!(holds.end());
        assert!(
            !holds.floating(old.id),
            "a placement that raced a hide is undone"
        );
        let new = holds.start(true, LINE);
        assert!(holds.sized(old.id).is_none());
        assert!(holds.fall_back(old.id).is_none());
        assert!(!holds.floating(old.id));
        assert_eq!(holds.current().map(|s| s.id), Some(new.id));
        assert!(holds.end());
        assert!(!holds.end());
    }

    #[test]
    fn the_guide_sits_centred_just_above_the_first_line() {
        let m = monitor(0.0, 0.0, 1920.0, 1080.0, 1.0);
        let at = guide_rect(line(700.0, 500.0, 200.0, 20.0), &[m], (300.0, 120.0)).unwrap();
        assert_eq!(
            at,
            Rect {
                x: 650.0,
                y: 372.0,
                w: 300.0,
                h: 120.0
            }
        );
    }

    #[test]
    fn near_the_top_edge_the_guide_goes_below_the_line() {
        let m = monitor(0.0, 0.0, 1920.0, 1080.0, 1.0);
        // 100 px above the line: not enough for 120 px of guide and the gap.
        let at = guide_rect(line(700.0, 100.0, 200.0, 20.0), &[m], (300.0, 120.0)).unwrap();
        assert_eq!(
            at,
            Rect {
                x: 650.0,
                y: 128.0,
                w: 300.0,
                h: 120.0
            }
        );
        // Exactly enough room: still above.
        let at = guide_rect(line(700.0, 128.0, 200.0, 20.0), &[m], (300.0, 120.0)).unwrap();
        assert_eq!(at.y, 0.0);
    }

    #[test]
    fn the_guide_stays_inside_the_work_area_at_the_sides() {
        let m = monitor(0.0, 0.0, 1920.0, 1080.0, 1.0);
        let left = guide_rect(line(10.0, 500.0, 40.0, 20.0), &[m], (300.0, 120.0)).unwrap();
        assert_eq!((left.x, left.y), (0.0, 372.0));
        let right = guide_rect(line(1880.0, 500.0, 30.0, 20.0), &[m], (300.0, 120.0)).unwrap();
        assert_eq!((right.x, right.y), (1620.0, 372.0));
    }

    #[test]
    fn a_short_screen_keeps_the_guide_above_the_taskbar() {
        // Neither above nor below has room: the guide is kept on the work area, over the line.
        let m = monitor(0.0, 0.0, 800.0, 300.0, 1.0);
        let at = guide_rect(line(300.0, 120.0, 200.0, 20.0), &[m], (300.0, 200.0)).unwrap();
        assert_eq!((at.x, at.y), (250.0, 52.0));
    }

    #[test]
    fn on_mixed_scales_the_guide_uses_the_selection_monitors_scale_and_edges() {
        // A 100% laptop on the left, a 150% monitor on the right.
        let a = monitor(0.0, 0.0, 1920.0, 1080.0, 1.0);
        let b = monitor(1920.0, 0.0, 3840.0, 2160.0, 1.5);
        let at = guide_rect(line(3000.0, 1000.0, 200.0, 30.0), &[a, b], (300.0, 120.0)).unwrap();
        // 450 x 180 physical, 12 px of gap.
        assert_eq!(
            at,
            Rect {
                x: 2875.0,
                y: 808.0,
                w: 450.0,
                h: 180.0
            }
        );
        // A line at the left edge of the right monitor is clamped to that monitor, not spread
        // across the boundary.
        let at = guide_rect(line(1930.0, 1000.0, 40.0, 30.0), &[a, b], (300.0, 120.0)).unwrap();
        assert_eq!(at.x, 1920.0);
        assert_eq!(at.w, 450.0);
        // The same line on the 100% monitor gets the 100% size.
        let at = guide_rect(line(900.0, 500.0, 200.0, 20.0), &[a, b], (300.0, 120.0)).unwrap();
        assert_eq!((at.w, at.h), (300.0, 120.0));
    }

    #[test]
    fn a_line_on_no_monitor_or_with_no_size_is_not_usable() {
        let m = monitor(0.0, 0.0, 1920.0, 1080.0, 1.0);
        assert_eq!(
            guide_rect(line(-900.0, 500.0, 200.0, 20.0), &[m], (300.0, 120.0)),
            None
        );
        assert_eq!(
            guide_rect(line(700.0, 500.0, 0.0, 0.0), &[m], (300.0, 120.0)),
            None
        );
        assert_eq!(
            guide_rect(line(700.0, 500.0, 200.0, 20.0), &[], (300.0, 120.0)),
            None
        );
    }
}
