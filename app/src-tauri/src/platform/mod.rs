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

#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub use self::windows::*;

#[cfg(not(windows))]
mod fallback;
#[cfg(not(windows))]
pub use self::fallback::*;
