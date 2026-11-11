//! OS-specific bits behind small functions. `windows.rs` is the real thing; `fallback.rs` keeps
//! other platforms building (and tests running on Linux).

/// An opaque top-level window handle (an HWND on Windows), remembered so an action can paste
/// back into the window it was started from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WindowHandle(#[allow(dead_code)] pub(crate) isize);

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
