//! The pure half of the selection query's fallback for standard Win32 edit controls (classic
//! Notepad's `Edit`, rich edit controls, WinForms text boxes), which offer no UI Automation text
//! pattern on some systems. `windows.rs` asks the control with window messages; this turns the
//! answers into the guide's selection. Unit-tested here because the messages can't run on Linux.

#![cfg_attr(not(windows), allow(dead_code))]

use super::ScreenRect;

/// Whether a window of class `class` is a standard edit or rich edit control, or a WinForms
/// wrapper of one, and so answers the `EM_*` messages the fallback sends.
pub(crate) fn is_edit_class(class: &str) -> bool {
    let class = class.to_ascii_lowercase();
    if class == "edit" || class.starts_with("richedit") {
        return true;
    }
    // WinForms: `WindowsForms10.EDIT.app.0.<n>` and `WindowsForms10.RichEdit20W.app.0.<n>`.
    class
        .strip_prefix("windowsforms10.")
        .is_some_and(|rest| rest.starts_with("edit.") || rest.starts_with("richedit"))
}

/// The selection from `EM_GETSEL`'s return value: start in the low word, end in the high word.
/// None for -1 (a rich edit control's answer when the range doesn't fit in 16 bits). The caller
/// checks the text is under 65536 characters, where the words are exact.
pub(crate) fn selection_range(answer: isize) -> Option<(u32, u32)> {
    if answer == -1 {
        return None;
    }
    let (start, end) = ((answer & 0xFFFF) as u32, ((answer >> 16) & 0xFFFF) as u32);
    Some((start.min(end), start.max(end)))
}

/// A point from `EM_POSFROMCHAR`'s return value: signed client x in the low word, y in the high
/// word. None for -1 (the index is past the last character).
pub(crate) fn packed_point(answer: isize) -> Option<(i32, i32)> {
    if answer == -1 {
        return None;
    }
    Some((
        (answer & 0xFFFF) as u16 as i16 as i32,
        ((answer >> 16) & 0xFFFF) as u16 as i16 as i32,
    ))
}

/// The height of the line at client y `top`, client px: from the next line's top, else from the
/// previous line's top, else the control's font height, else (a single-line control) the client
/// height below `top`.
pub(crate) fn line_height(
    top: i32,
    next_top: Option<i32>,
    previous_top: Option<i32>,
    font: Option<i32>,
    single_line_client: Option<i32>,
) -> Option<i32> {
    let positive = |h: i32| (h > 0).then_some(h);
    next_top
        .and_then(|n| positive(n - top))
        .or_else(|| previous_top.and_then(|p| positive(top - p)))
        .or_else(|| font.and_then(positive))
        .or_else(|| single_line_client.and_then(|c| positive(c - top.max(0))))
}

/// What the fallback learnt about where the selection is, in the control's client px.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct EditGeometry {
    /// Top-left of the first selected character.
    pub start: Option<(i32, i32)>,
    /// Where the first selected line's part of the selection ends: the position of the
    /// character after it. None when that is the end of the text.
    pub first_end: Option<(i32, i32)>,
    pub line_height: Option<i32>,
    /// Client width and height.
    pub client: (i32, i32),
    /// The client area's top-left on screen, physical px.
    pub origin: (i32, i32),
    /// Physical px per client px (the monitor's DPI over the window's).
    pub scale: f64,
}

/// The first selected line on screen, physical px, or why there is none.
pub(crate) fn first_line_on_screen(g: &EditGeometry) -> Result<ScreenRect, &'static str> {
    let (x, y) = g.start.ok_or("no position for the selection's start")?;
    let h = g.line_height.ok_or("no line height")?;
    let (client_w, client_h) = g.client;
    if x < 0 || x >= client_w || y + h <= 0 || y >= client_h {
        return Err("the selection's first line is scrolled out of view");
    }
    // The part of the first line that is selected ends where the next character starts. When
    // that is on another row (a wrapped line) or past the end of the text, the line runs to the
    // control's edge.
    let right = match g.first_end {
        Some((end_x, end_y)) if end_y == y => {
            if end_x <= x {
                return Err("the first selected line has no width");
            }
            end_x.min(client_w)
        }
        _ => client_w,
    };
    let s = |v: i32| (v as f64 * g.scale).round() as i32;
    Ok(ScreenRect {
        x: g.origin.0 + s(x),
        y: g.origin.1 + s(y),
        w: s(right - x),
        h: s(h),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn standard_edit_and_rich_edit_classes_match() {
        for class in [
            "Edit",
            "EDIT",
            "RichEdit",
            "RichEdit20W",
            "RichEdit20A",
            "RICHEDIT50W",
            "RICHEDIT60W",
            "RichEditD2DPT",
            "WindowsForms10.EDIT.app.0.141b42a_r6_ad1",
            "WindowsForms10.RichEdit20W.app.0.141b42a_r6_ad1",
        ] {
            assert!(is_edit_class(class), "{class}");
        }
        for class in [
            "Notepad",
            "Editor",
            "Chrome_RenderWidgetHostHWND",
            "Scintilla",
            "WindowsForms10.BUTTON.app.0.1",
            "_WwG",
            "",
        ] {
            assert!(!is_edit_class(class), "{class}");
        }
    }

    #[test]
    fn the_range_comes_from_the_low_and_high_words() {
        assert_eq!(selection_range(0), Some((0, 0)), "a caret at the start");
        assert_eq!(selection_range(26 << 16), Some((0, 26)));
        assert_eq!(selection_range((40 << 16) | 12), Some((12, 40)));
        assert_eq!(
            selection_range((0xFFFF << 16) | 0xFFFE),
            Some((65534, 65535))
        );
        assert_eq!(selection_range(-1), None);
    }

    #[test]
    fn positions_are_signed_words() {
        assert_eq!(packed_point((20 << 16) | 5), Some((5, 20)));
        // x = -3, y = 18: a character scrolled off the left.
        assert_eq!(packed_point((18 << 16) | 0xFFFD), Some((-3, 18)));
        assert_eq!(packed_point(0xFFF0_0004), Some((4, -16)));
        assert_eq!(packed_point(-1), None, "past the last character");
    }

    #[test]
    fn the_line_height_comes_from_a_neighbouring_line_then_the_font() {
        assert_eq!(
            line_height(2, Some(20), Some(-16), Some(15), None),
            Some(18)
        );
        assert_eq!(
            line_height(20, None, Some(2), Some(15), None),
            Some(18),
            "last line"
        );
        assert_eq!(
            line_height(2, None, None, Some(15), None),
            Some(15),
            "one line"
        );
        assert_eq!(
            line_height(3, None, None, None, Some(21)),
            Some(18),
            "single-line box"
        );
        assert_eq!(
            line_height(2, Some(2), None, Some(15), None),
            Some(15),
            "a next line at the same height (a bad answer) is skipped"
        );
        assert_eq!(line_height(2, None, None, None, None), None);
    }

    fn geometry() -> EditGeometry {
        EditGeometry {
            start: Some((4, 2)),
            first_end: Some((184, 2)),
            line_height: Some(18),
            client: (880, 340),
            origin: (208, 470),
            scale: 1.0,
        }
    }

    fn rect(x: i32, y: i32, w: i32, h: i32) -> ScreenRect {
        ScreenRect { x, y, w, h }
    }

    #[test]
    fn a_selection_on_one_line_spans_its_characters() {
        assert_eq!(
            first_line_on_screen(&geometry()),
            Ok(rect(212, 472, 180, 18))
        );
    }

    #[test]
    fn a_selection_over_lines_is_clamped_to_its_first_line() {
        // `first_end` is the first line's end, so a multi-line selection is the same rectangle.
        let g = EditGeometry {
            first_end: Some((300, 2)),
            ..geometry()
        };
        assert_eq!(first_line_on_screen(&g), Ok(rect(212, 472, 296, 18)));
        // A wrapped line: the next character is on the next row, so the line runs to the edge.
        let g = EditGeometry {
            first_end: Some((0, 20)),
            ..geometry()
        };
        assert_eq!(first_line_on_screen(&g), Ok(rect(212, 472, 876, 18)));
        // A selection to the end of the text has no position after it.
        let g = EditGeometry {
            first_end: None,
            ..geometry()
        };
        assert_eq!(first_line_on_screen(&g), Ok(rect(212, 472, 876, 18)));
    }

    #[test]
    fn client_px_are_scaled_to_physical_px() {
        let g = EditGeometry {
            scale: 1.5,
            ..geometry()
        };
        assert_eq!(first_line_on_screen(&g), Ok(rect(214, 473, 270, 27)));
    }

    #[test]
    fn no_rectangle_when_the_line_is_unknown_or_out_of_view() {
        let no_start = EditGeometry {
            start: None,
            ..geometry()
        };
        assert!(first_line_on_screen(&no_start).is_err());
        let no_height = EditGeometry {
            line_height: None,
            ..geometry()
        };
        assert!(first_line_on_screen(&no_height).is_err());
        for start in [(4, -40), (4, 340), (-10, 2), (900, 2)] {
            let g = EditGeometry {
                start: Some(start),
                ..geometry()
            };
            assert!(first_line_on_screen(&g).is_err(), "{start:?}");
        }
        // Starting at a line break: nothing of the first line is selected.
        let g = EditGeometry {
            first_end: Some((4, 2)),
            ..geometry()
        };
        assert!(first_line_on_screen(&g).is_err());
    }
}
