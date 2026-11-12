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

/// What the focused element has selected, as the hotkey guide needs it (SPEC §5). The text itself
/// is never read.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(not(windows), allow(dead_code))] // only Windows asks
pub enum Selection {
    /// The element exposes text and none of it is selected.
    Nothing,
    Text(SelectedText),
}

/// A non-empty text selection.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SelectedText {
    /// False when the selected text can't be changed (a web page, a read-only field).
    pub editable: bool,
    /// The first selected line on screen, physical px. None when the app gives no usable
    /// rectangle; the guide then stays beside the eyes.
    pub line: Option<ScreenRect>,
}

/// A rectangle on screen, physical px.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ScreenRect {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

/// The first line of a selection from UI Automation's bounding rectangles: a flat list of
/// left, top, width, height per line, in reading order. Lines with no area (an empty line, or one
/// scrolled out of view) are skipped.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn first_line(rects: &[f64]) -> Option<ScreenRect> {
    rects.as_chunks::<4>().0.iter().find_map(|r| {
        let [x, y, w, h] = r.map(f64::round);
        (r.iter().all(|v| v.is_finite()) && w > 0.0 && h > 0.0).then_some(ScreenRect {
            x: x as i32,
            y: y as i32,
            w: w as i32,
            h: h as i32,
        })
    })
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

#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub use self::windows::*;

#[cfg(not(windows))]
mod fallback;
#[cfg(not(windows))]
pub use self::fallback::*;

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
mod line_tests {
    use super::{first_line, ScreenRect};

    #[test]
    fn the_first_line_with_an_area_is_the_selections_first_line() {
        let rect = |x, y, w, h| ScreenRect { x, y, w, h };
        assert_eq!(
            first_line(&[100.0, 200.0, 300.5, 18.4, 100.0, 220.0, 80.0, 18.0]),
            Some(rect(100, 200, 301, 18))
        );
        assert_eq!(
            first_line(&[0.0, 0.0, 0.0, 0.0, 40.0, 60.0, 120.0, 20.0]),
            Some(rect(40, 60, 120, 20)),
            "an empty first line is skipped"
        );
        assert_eq!(first_line(&[]), None);
        assert_eq!(first_line(&[1.0, 2.0, 3.0]), None, "a partial entry");
        assert_eq!(first_line(&[f64::NAN, 0.0, 10.0, 10.0]), None);
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
