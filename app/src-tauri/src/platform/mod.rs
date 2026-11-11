//! OS-specific bits behind small functions. `windows.rs` is the real thing; `fallback.rs` keeps
//! other platforms building (and tests running on Linux).

#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub use self::windows::*;

#[cfg(not(windows))]
mod fallback;
#[cfg(not(windows))]
pub use self::fallback::*;
