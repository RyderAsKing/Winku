//! Hides the resting pill while a fullscreen app has focus (docs/ARCHITECTURE.md "Shipping").
//! Windows checks the foreground window on every foreground change (a WinEvent hook) and when
//! Explorer reports a fullscreen app opening or closing (an appbar notification); no polling.
//! Other platforms never report fullscreen.

#![cfg_attr(not(windows), allow(dead_code))]

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::AppHandle;

static ACTIVE: AtomicBool = AtomicBool::new(false);

/// Whether a fullscreen app has focus right now.
pub fn active() -> bool {
    ACTIVE.load(Ordering::SeqCst)
}

/// Screen rectangle as left, top, right, bottom (physical px).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Bounds {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

/// Desktop and shell windows: these cover the monitor but aren't a fullscreen app.
pub fn is_shell_class(class: &str) -> bool {
    matches!(
        class,
        "Progman" | "WorkerW" | "Shell_TrayWnd" | "Shell_SecondaryTrayWnd"
    )
}

/// True when the foreground window covers its whole monitor and isn't the shell or Winku.
pub fn is_fullscreen(class: &str, own: bool, window: Bounds, monitor: Bounds) -> bool {
    !own && !is_shell_class(class)
        && monitor.right > monitor.left
        && monitor.bottom > monitor.top
        && window.left <= monitor.left
        && window.top <= monitor.top
        && window.right >= monitor.right
        && window.bottom >= monitor.bottom
}

/// Records a change and re-applies the pill's visibility on the main thread.
fn changed(app: &AppHandle, fullscreen: bool) {
    if ACTIVE.swap(fullscreen, Ordering::SeqCst) == fullscreen {
        return;
    }
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || crate::window::apply_eyes_visibility(&handle));
}

#[cfg(windows)]
pub fn start(app: &AppHandle) {
    let app = app.clone();
    crate::platform::watch_foreground(Box::new(move |class, own, window, monitor| {
        changed(&app, is_fullscreen(class, own, window, monitor));
    }));
}

#[cfg(not(windows))]
pub fn start(_app: &AppHandle) {}

#[cfg(test)]
mod tests {
    use super::*;

    const MONITOR: Bounds = Bounds {
        left: 0,
        top: 0,
        right: 1920,
        bottom: 1080,
    };

    #[test]
    fn covering_the_monitor_is_fullscreen() {
        assert!(is_fullscreen("UnityWndClass", false, MONITOR, MONITOR));
        let bigger = Bounds {
            left: -8,
            top: -8,
            right: 1928,
            bottom: 1088,
        };
        assert!(is_fullscreen("Chrome_WidgetWin_1", false, bigger, MONITOR));
    }

    #[test]
    fn maximized_or_smaller_is_not() {
        let maximized = Bounds {
            bottom: 1040,
            ..MONITOR
        };
        assert!(!is_fullscreen("Notepad", false, maximized, MONITOR));
        let second = Bounds {
            left: 1920,
            right: 3840,
            ..MONITOR
        };
        assert!(!is_fullscreen("Notepad", false, second, MONITOR));
    }

    #[test]
    fn shell_and_own_windows_are_excluded() {
        for class in ["Progman", "WorkerW", "Shell_TrayWnd"] {
            assert!(!is_fullscreen(class, false, MONITOR, MONITOR));
        }
        assert!(!is_fullscreen("Tauri Window", true, MONITOR, MONITOR));
        let empty = Bounds {
            left: 0,
            top: 0,
            right: 0,
            bottom: 0,
        };
        assert!(!is_fullscreen("X", false, empty, empty));
    }
}
