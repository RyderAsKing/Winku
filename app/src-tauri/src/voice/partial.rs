//! Live transcription while the summon key is held: when a partial pass is due, whether its
//! text is worth sending, and the gate that keeps `talk_partial` before `talk_end`.

use std::sync::Mutex;
use std::time::Duration;

/// No partial pass until the recording is at least this long.
pub const MIN_AUDIO: Duration = Duration::from_millis(500);
/// Gap between the end of one partial pass and the start of the next.
pub const MIN_GAP: Duration = Duration::from_millis(250);
/// How often the worker looks at the recording.
pub const TICK: Duration = Duration::from_millis(50);

/// Whether a pass should start now, given how much audio there is and how long ago the last
/// pass finished (`None` before the first).
pub fn due(audio: Duration, since_last: Option<Duration>) -> bool {
    audio >= MIN_AUDIO && since_last.is_none_or(|gap| gap >= MIN_GAP)
}

/// Whether `text` should go out as `talk_partial`, after `last_sent` (`""` before the first).
pub fn should_emit(text: &str, last_sent: &str) -> bool {
    text != last_sent
}

/// Open while one recording may still send partials. Closed when the key is released, when the
/// recording ends by itself, or when another recording replaces it; never reopened.
#[derive(Default)]
pub struct Gate {
    closed: Mutex<bool>,
}

impl Gate {
    fn lock(&self) -> std::sync::MutexGuard<'_, bool> {
        self.closed.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Waits for a `send_if_open` in progress, so nothing is sent after this returns.
    pub fn close(&self) {
        *self.lock() = true;
    }

    pub fn is_open(&self) -> bool {
        !*self.lock()
    }

    /// Runs `send` unless the gate is closed, holding the gate so `close` waits for it.
    pub fn send_if_open(&self, send: impl FnOnce()) -> bool {
        let closed = self.lock();
        if *closed {
            return false;
        }
        send();
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ms(n: u64) -> Duration {
        Duration::from_millis(n)
    }

    #[test]
    fn waits_for_half_a_second_then_paces_passes() {
        assert!(!due(ms(499), None));
        assert!(due(ms(500), None));
        assert!(
            !due(ms(2000), Some(ms(249))),
            "too soon after the last pass"
        );
        assert!(due(ms(2000), Some(ms(250))));
    }

    #[test]
    fn sends_only_changed_text() {
        assert!(!should_emit("", ""), "nothing heard yet");
        assert!(should_emit("hello", ""));
        assert!(!should_emit("hello", "hello"));
        assert!(should_emit("hello there", "hello"));
        assert!(should_emit("", "hello"), "the recogniser changed its mind");
    }

    #[test]
    fn closed_gate_sends_nothing() {
        let gate = Gate::default();
        let mut sent = 0;
        assert!(gate.is_open());
        assert!(gate.send_if_open(|| sent += 1));
        gate.close();
        assert!(!gate.is_open());
        assert!(!gate.send_if_open(|| sent += 1));
        gate.close();
        assert_eq!(sent, 1);
    }
}
