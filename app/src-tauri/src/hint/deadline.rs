//! The hold timer for the key watchers that see raw key events on a thread of their own
//! (xinput.rs on X11, eventtap.rs on macOS): a second thread sleeps until the deadline the key
//! thread sets, then runs the hint state machine's timer.

use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};

/// When the timer is due; None while no hold is pending.
static DEADLINE: Mutex<Option<Instant>> = Mutex::new(None);
static WAKE: Condvar = Condvar::new();

/// Starts (Some) or cancels (None) the timer.
pub fn set_deadline(at: Option<Instant>) {
    *DEADLINE.lock().unwrap_or_else(|e| e.into_inner()) = at;
    WAKE.notify_all();
}

/// The timer thread's body: runs `on_timer` at each deadline, again after the time it asks for.
pub fn timer(on_timer: fn() -> Option<u32>) {
    let mut deadline = DEADLINE.lock().unwrap_or_else(|e| e.into_inner());
    loop {
        match *deadline {
            None => {
                deadline = WAKE.wait(deadline).unwrap_or_else(|e| e.into_inner());
            }
            Some(at) if Instant::now() < at => {
                let left = at.saturating_duration_since(Instant::now());
                deadline = WAKE
                    .wait_timeout(deadline, left)
                    .unwrap_or_else(|e| e.into_inner())
                    .0;
            }
            Some(_) => {
                *deadline = None;
                drop(deadline);
                let again = on_timer();
                deadline = DEADLINE.lock().unwrap_or_else(|e| e.into_inner());
                if let Some(ms) = again {
                    deadline.get_or_insert(Instant::now() + Duration::from_millis(u64::from(ms)));
                }
            }
        }
    }
}
