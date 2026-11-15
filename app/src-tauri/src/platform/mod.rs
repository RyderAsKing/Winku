//! OS-specific bits behind small functions. `windows.rs` is the real thing; `fallback.rs` keeps
//! other platforms building (and tests running on Linux).

/// An opaque top-level window handle (an HWND on Windows), remembered so an action can paste
/// back into the window it was started from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WindowHandle(#[allow(dead_code)] pub(crate) isize);

/// A rectangle with rounded corners, window px; right and bottom are exclusive.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RoundRect {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
    /// Corner radius; 0 for square corners.
    pub radius: i32,
}

/// Captured pixels, RGBA, rows top to bottom.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RawImage {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

/// Crop to a sub-rectangle; returns the image unchanged when the rectangle doesn't fit inside it.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn crop(image: RawImage, x: i32, y: i32, w: i32, h: i32) -> RawImage {
    let fits = x >= 0
        && y >= 0
        && w > 0
        && h > 0
        && (x + w) as u32 <= image.width
        && (y + h) as u32 <= image.height;
    if !fits || (w as u32, h as u32) == (image.width, image.height) {
        return image;
    }
    let stride = image.width as usize * 4;
    let mut rgba = Vec::with_capacity(w as usize * h as usize * 4);
    for row in y as usize..(y + h) as usize {
        let start = row * stride + x as usize * 4;
        rgba.extend_from_slice(&image.rgba[start..start + w as usize * 4]);
    }
    RawImage {
        width: w as u32,
        height: h as u32,
        rgba,
    }
}

/// Chromium (Chrome, Edge, Electron apps such as VS Code, Slack and T3 Code, WebView2 hosts)
/// builds its full accessibility tree the first time a UI Automation or MSAA client asks one
/// of its windows for anything, and keeps it until the app restarts. From then on every page
/// change also updates that tree, which makes busy pages and editors noticeably slower. True
/// when `classes` (a window and its focused child) include a Chromium frame
/// (`Chrome_WidgetWin_*`) or render widget (`Chrome_RenderWidgetHostHWND`).
pub fn uia_switches_on_accessibility(classes: &[String]) -> bool {
    classes.iter().any(|c| c.starts_with("Chrome_"))
}

/// Whether reading the selection of `window` through UI Automation is free of side effects on
/// the app (see `uia_switches_on_accessibility`).
pub fn uia_is_safe(window: WindowHandle) -> bool {
    !uia_switches_on_accessibility(&input_window_classes(window))
}

/// Whether a summon may simulate `Ctrl+C` in this window to read its selection. Not in
/// terminals, where `Ctrl+C` with nothing selected interrupts the running program, nor in
/// editors with a built-in terminal (VS Code and its forks, JetBrains IDEs), which could have
/// one focused. The action hotkeys still copy there: the user asked for the selection then.
/// `process` is the lowercase executable name; `classes` a window and its focused child.
pub fn summon_copy_allowed(process: Option<&str>, classes: &[String]) -> bool {
    const CONSOLE_CLASSES: [&str; 3] = [
        "ConsoleWindowClass",
        "CASCADIA_HOSTING_WINDOW_CLASS",
        "PseudoConsoleWindow",
    ];
    const TERMINALS: [&str; 18] = [
        "windowsterminal.exe",
        "wt.exe",
        "conhost.exe",
        "openconsole.exe",
        "cmd.exe",
        "powershell.exe",
        "pwsh.exe",
        "wezterm-gui.exe",
        "alacritty.exe",
        "mintty.exe",
        "putty.exe",
        "kitty.exe",
        "hyper.exe",
        "tabby.exe",
        "warp.exe",
        "code.exe",
        "code - insiders.exe",
        "cursor.exe",
    ];
    const IDE_PREFIXES: [&str; 12] = [
        "windsurf",
        "idea",
        "pycharm",
        "webstorm",
        "phpstorm",
        "rider",
        "clion",
        "goland",
        "rubymine",
        "datagrip",
        "rustrover",
        "studio",
    ];
    if classes
        .iter()
        .any(|c| CONSOLE_CLASSES.contains(&c.as_str()))
    {
        return false;
    }
    let Some(process) = process else {
        return true;
    };
    !(TERMINALS.contains(&process) || IDE_PREFIXES.iter().any(|p| process.starts_with(p)))
}

/// `summon_copy_allowed` for a live window.
pub fn summon_copy_is_safe(window: WindowHandle) -> bool {
    summon_copy_allowed(
        process_name(window).as_deref(),
        &input_window_classes(window),
    )
}

#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub use self::windows::*;

#[cfg(not(windows))]
mod fallback;
#[cfg(not(windows))]
pub use self::fallback::*;

#[cfg(test)]
mod summon_copy_tests {
    use super::summon_copy_allowed;

    fn classes(list: &[&str]) -> Vec<String> {
        list.iter().map(|c| c.to_string()).collect()
    }

    #[test]
    fn browsers_and_ordinary_apps_copy() {
        let chrome = classes(&["Chrome_WidgetWin_1", "Chrome_RenderWidgetHostHWND"]);
        assert!(summon_copy_allowed(Some("chrome.exe"), &chrome));
        assert!(summon_copy_allowed(Some("msedge.exe"), &chrome));
        assert!(summon_copy_allowed(Some("slack.exe"), &chrome));
        assert!(summon_copy_allowed(
            Some("winword.exe"),
            &classes(&["OpusApp"])
        ));
        assert!(summon_copy_allowed(None, &[]));
    }

    #[test]
    fn terminals_never_copy() {
        assert!(!summon_copy_allowed(Some("windowsterminal.exe"), &[]));
        assert!(!summon_copy_allowed(Some("pwsh.exe"), &[]));
        assert!(!summon_copy_allowed(
            None,
            &classes(&["ConsoleWindowClass"])
        ));
        assert!(!summon_copy_allowed(
            Some("anything.exe"),
            &classes(&["CASCADIA_HOSTING_WINDOW_CLASS"])
        ));
    }

    #[test]
    fn editors_with_a_terminal_never_copy() {
        assert!(!summon_copy_allowed(Some("code.exe"), &[]));
        assert!(!summon_copy_allowed(Some("cursor.exe"), &[]));
        assert!(!summon_copy_allowed(Some("idea64.exe"), &[]));
        assert!(!summon_copy_allowed(Some("rustrover64.exe"), &[]));
    }
}

#[cfg(test)]
mod crop_tests {
    use super::{crop, RawImage};

    fn image(width: u32, height: u32) -> RawImage {
        let rgba = (0..width * height)
            .flat_map(|i| [i as u8, 0, 0, 255])
            .collect();
        RawImage {
            width,
            height,
            rgba,
        }
    }

    #[test]
    fn crops_to_the_visible_frame() {
        let out = crop(image(4, 3), 1, 1, 2, 2);
        assert_eq!((out.width, out.height), (2, 2));
        let reds: Vec<u8> = out.rgba.chunks(4).map(|p| p[0]).collect();
        assert_eq!(reds, [5, 6, 9, 10]);
    }

    #[test]
    fn keeps_the_image_when_the_frame_does_not_fit() {
        assert_eq!(crop(image(4, 3), 3, 0, 2, 2).width, 4);
        assert_eq!(crop(image(4, 3), -1, 0, 2, 2).width, 4);
        assert_eq!(crop(image(4, 3), 0, 0, 0, 2).width, 4);
    }
}

#[cfg(test)]
mod uia_tests {
    use super::uia_switches_on_accessibility;

    #[test]
    fn no_uia_selection_in_chromium_windows() {
        let classes = |names: &[&str]| names.iter().map(|n| n.to_string()).collect::<Vec<_>>();
        assert!(uia_switches_on_accessibility(&classes(&[
            "Chrome_WidgetWin_1"
        ])));
        assert!(uia_switches_on_accessibility(&classes(&[
            "Olk Host",
            "Chrome_RenderWidgetHostHWND"
        ])));
        assert!(!uia_switches_on_accessibility(&classes(&[
            "Notepad",
            "RichEditD2DPT"
        ])));
        assert!(!uia_switches_on_accessibility(&classes(&[
            "OpusApp", "_WwG"
        ])));
        assert!(!uia_switches_on_accessibility(&[]));
    }
}
