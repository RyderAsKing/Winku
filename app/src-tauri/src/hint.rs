//! Hotkey hints: tells the UI when the hotkey prefix (`Ctrl+Alt`, or the leader key) has been
//! held on its own long enough that the user is probably looking for the next key.
//!
//! Events on the `ui` channel: `{ kind: "hotkey_hint", show: true, selection? }` after the prefix
//! has been held alone for `HOLD_DELAY`, `{ show: false }` as soon as the hold is interrupted or
//! ends.
//!
//! When a hold begins, and the "Guide follows the selection" setting is on, one query asks the
//! focused app what is selected (`platform::selection_summary`, on its own thread). An answer
//! that arrives before the guide shows picks its lists through `selection`; a later one is
//! dropped, so the guide never changes while it shows. This query runs in Chromium-based apps
//! too, unlike every other UI Automation read (SPEC §7).
//!
//! Windows reads key state through Raw Input (`rawinput.rs`): a hidden message-only window on
//! its own thread that sleeps in `GetMessageW`, plus one timer while a hold is pending. There is
//! no low-level keyboard hook (it adds latency to every keystroke system-wide) and no polling.
//! Raw input is not delivered while an elevated window has focus, so hints don't appear there;
//! the hotkeys themselves are unaffected. Other platforms never show hints.

#![cfg_attr(not(windows), allow(dead_code))]

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

pub use crate::platform::Selection;

#[cfg(windows)]
mod rawinput;

/// How long the prefix must be held alone before the hints appear.
pub const HOLD_DELAY: Duration = Duration::from_millis(450);
/// A timer message this much earlier than `HOLD_DELAY` is a stale one from an earlier hold.
const SLACK: Duration = Duration::from_millis(30);

/// A physical key as the state machine sees it. Modifiers keep their side so releasing one
/// `Ctrl` while the other is down doesn't end the hold. AltGr arrives as `LCtrl` + `RAlt`, so it
/// counts as `Ctrl+Alt`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Key {
    LCtrl,
    RCtrl,
    LAlt,
    RAlt,
    LShift,
    RShift,
    LWin,
    RWin,
    /// Any other key, by virtual-key code.
    Other(u16),
}

impl Key {
    fn bit(self) -> Option<u8> {
        Some(match self {
            Key::LCtrl => 1,
            Key::RCtrl => 2,
            Key::LAlt => 4,
            Key::RAlt => 8,
            Key::LShift => 16,
            Key::RShift => 32,
            Key::LWin => 64,
            Key::RWin => 128,
            Key::Other(_) => return None,
        })
    }
}

const CTRL: u8 = 1 | 2;
const ALT: u8 = 4 | 8;
const SHIFT: u8 = 16 | 32;
const WIN: u8 = 64 | 128;

/// The keys that must be down, and nothing else. Either side of a modifier counts.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Prefix {
    /// Union of `CTRL`, `ALT`, `SHIFT`, `WIN` groups that are required.
    mods: u8,
    /// An ordinary-key leader (`F13`), required as well.
    key: Option<u16>,
}

impl Prefix {
    pub const DEFAULT: Prefix = Prefix {
        mods: CTRL | ALT,
        key: None,
    };

    /// From the `leaderKey` setting (`None`/blank = `Ctrl+Alt`). `None` back when the leader
    /// can't be understood: no hints then.
    pub fn from_leader(leader: Option<&str>) -> Option<Prefix> {
        let Some(leader) = leader.map(str::trim).filter(|l| !l.is_empty()) else {
            return Some(Prefix::DEFAULT);
        };
        let mut prefix = Prefix { mods: 0, key: None };
        for token in leader.split('+').map(str::trim).filter(|t| !t.is_empty()) {
            match token.to_ascii_lowercase().as_str() {
                "ctrl" | "control" => prefix.mods |= CTRL,
                "alt" | "option" => prefix.mods |= ALT,
                "shift" => prefix.mods |= SHIFT,
                "super" | "win" | "meta" | "cmd" | "command" => prefix.mods |= WIN,
                _ if prefix.key.is_none() => prefix.key = Some(vk_for(token)?),
                _ => return None,
            }
        }
        (prefix.mods != 0 || prefix.key.is_some()).then_some(prefix)
    }
}

/// Windows virtual-key code for a leader key name.
fn vk_for(token: &str) -> Option<u16> {
    let upper = token.to_ascii_uppercase();
    let mut chars = upper.chars();
    if let (Some(c), None) = (chars.next(), chars.next()) {
        if c.is_ascii_alphanumeric() {
            return Some(c as u16);
        }
    }
    if let Some(n) = upper.strip_prefix('F').and_then(|n| n.parse::<u16>().ok()) {
        if (1..=24).contains(&n) {
            return Some(0x6F + n);
        }
    }
    Some(match upper.as_str() {
        "SPACE" => 0x20,
        "TAB" => 0x09,
        "ENTER" | "RETURN" => 0x0D,
        "ESC" | "ESCAPE" => 0x1B,
        "BACKSPACE" => 0x08,
        "CAPSLOCK" => 0x14,
        "INSERT" => 0x2D,
        "DELETE" => 0x2E,
        "HOME" => 0x24,
        "END" => 0x23,
        "PAGEUP" => 0x21,
        "PAGEDOWN" => 0x22,
        _ => return None,
    })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Phase {
    /// Nothing pending.
    Idle,
    /// The prefix went down alone at this time; waiting for `HOLD_DELAY`.
    Armed(Instant),
    /// The hint is showing.
    Shown,
    /// Something interrupted this hold; wait until every modifier is up.
    Blocked,
}

/// What the caller must do with the timer after a key event.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Timer {
    Keep,
    Start,
    Cancel,
}

/// One hold's selection query, to hand back with its answer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Query(u64);

/// The result of one key event: the timer to adjust, a hide to emit, and a selection query to
/// start.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Outcome {
    pub timer: Timer,
    pub hide: bool,
    pub query: Option<Query>,
}

const NOTHING: Outcome = Outcome {
    timer: Timer::Keep,
    hide: false,
    query: None,
};

/// Where this hold's selection query is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Asked {
    /// No query this hold, or its answer came too late: the full guide.
    Unknown,
    Waiting(Query),
    Answered(Selection),
}

/// Decides show/hide from key events, and when to ask what is selected. Pure: callers pass the
/// time.
#[derive(Debug)]
pub struct Hint {
    prefix: Option<Prefix>,
    mods: u8,
    key_down: bool,
    phase: Phase,
    /// The "Guide follows the selection" setting.
    follow_selection: bool,
    /// Queries started so far; numbers each one.
    queries: u64,
    asked: Asked,
}

impl Hint {
    pub fn new(prefix: Option<Prefix>) -> Hint {
        Hint {
            prefix,
            mods: 0,
            key_down: false,
            phase: Phase::Idle,
            follow_selection: true,
            queries: 0,
            asked: Asked::Unknown,
        }
    }

    pub fn is_shown(&self) -> bool {
        self.phase == Phase::Shown
    }

    /// Switches to another prefix. Returns true when a hint was showing and must be hidden.
    pub fn set_prefix(&mut self, prefix: Option<Prefix>) -> bool {
        let was_shown = self.is_shown();
        *self = Hint {
            follow_selection: self.follow_selection,
            queries: self.queries,
            ..Hint::new(prefix)
        };
        was_shown
    }

    /// The "Guide follows the selection" setting. Off: holds never ask.
    pub fn set_follow_selection(&mut self, on: bool) {
        self.follow_selection = on;
    }

    /// The answer to `query`. Kept only while that hold is still waiting for the guide to show.
    pub fn answered(&mut self, query: Query, selection: Option<Selection>) {
        if matches!(self.phase, Phase::Armed(_)) && self.asked == Asked::Waiting(query) {
            self.asked = selection.map_or(Asked::Unknown, Asked::Answered);
        }
    }

    /// What the showing guide was told is selected. None: unknown, the full guide.
    pub fn guide_selection(&self) -> Option<Selection> {
        match (self.phase, self.asked) {
            (Phase::Shown, Asked::Answered(selection)) => Some(selection),
            _ => None,
        }
    }

    fn satisfied(&self, prefix: Prefix) -> bool {
        let group = |g: u8| self.mods & g != 0;
        let wanted = |g: u8| prefix.mods & g != 0;
        [CTRL, ALT, SHIFT, WIN]
            .iter()
            .all(|&g| group(g) == wanted(g))
            && (prefix.key.is_none() || self.key_down)
    }

    /// A key event, with every hold allowed to ask what is selected.
    #[cfg(test)]
    pub fn on_key(&mut self, key: Key, down: bool, now: Instant) -> Outcome {
        self.on_key_where(key, down, now, || true)
    }

    /// A key event. `may_ask` is called only when a hold begins: false over a fullscreen app or
    /// while the summon key is held, and then that hold doesn't ask what is selected.
    pub fn on_key_where(
        &mut self,
        key: Key,
        down: bool,
        now: Instant,
        may_ask: impl FnOnce() -> bool,
    ) -> Outcome {
        let Some(prefix) = self.prefix else {
            return NOTHING;
        };
        let was_held = self.mods != 0 || self.key_down;
        let mut foreign = false;
        match key.bit() {
            Some(bit) => {
                if down {
                    self.mods |= bit;
                    // A modifier the prefix doesn't use is another key.
                    foreign = prefix.mods & (bit_group(bit)) == 0;
                } else {
                    self.mods &= !bit;
                }
            }
            None => {
                let Key::Other(vk) = key else { unreachable!() };
                if prefix.key == Some(vk) {
                    self.key_down = down;
                } else {
                    foreign = down;
                }
            }
        }
        let held = self.mods != 0 || self.key_down;

        if foreign {
            return self.interrupt(was_held);
        }
        match self.phase {
            Phase::Idle if down && self.satisfied(prefix) && prefix_key_event(key, prefix) => {
                self.phase = Phase::Armed(now);
                self.asked = Asked::Unknown;
                let mut query = None;
                if self.follow_selection && may_ask() {
                    self.queries += 1;
                    query = Some(Query(self.queries));
                    self.asked = Asked::Waiting(Query(self.queries));
                }
                Outcome {
                    timer: Timer::Start,
                    hide: false,
                    query,
                }
            }
            Phase::Armed(_) if !self.satisfied(prefix) => {
                self.phase = Phase::Idle;
                Outcome {
                    timer: Timer::Cancel,
                    ..NOTHING
                }
            }
            Phase::Shown if !self.satisfied(prefix) => {
                self.phase = Phase::Idle;
                Outcome {
                    hide: true,
                    ..NOTHING
                }
            }
            Phase::Blocked if !held => {
                self.phase = Phase::Idle;
                NOTHING
            }
            _ => NOTHING,
        }
    }

    /// Another key went down while the prefix may be held.
    fn interrupt(&mut self, was_held: bool) -> Outcome {
        match self.phase {
            Phase::Armed(_) => {
                self.phase = Phase::Blocked;
                Outcome {
                    timer: Timer::Cancel,
                    ..NOTHING
                }
            }
            Phase::Shown => {
                self.phase = Phase::Blocked;
                Outcome {
                    hide: true,
                    ..NOTHING
                }
            }
            // Ctrl held, then C: a normal shortcut. No hint until everything is released.
            Phase::Idle if was_held => {
                self.phase = Phase::Blocked;
                NOTHING
            }
            _ => NOTHING,
        }
    }

    /// The timer fired. `allowed`: no fullscreen app, no summon hold. Returns `Some(show)` when
    /// the hint must now be shown, `Err(remaining)` when the timer was a stale early one and
    /// must be restarted for the time left.
    pub fn timer_fired(&mut self, now: Instant, allowed: bool) -> Result<bool, Duration> {
        let Phase::Armed(at) = self.phase else {
            return Ok(false);
        };
        let elapsed = now.saturating_duration_since(at);
        if elapsed + SLACK < HOLD_DELAY {
            return Err(HOLD_DELAY - elapsed);
        }
        if allowed {
            self.phase = Phase::Shown;
            if matches!(self.asked, Asked::Waiting(_)) {
                self.asked = Asked::Unknown; // too late now
            }
            Ok(true)
        } else {
            self.phase = Phase::Blocked;
            Ok(false)
        }
    }
}

fn bit_group(bit: u8) -> u8 {
    [CTRL, ALT, SHIFT, WIN]
        .into_iter()
        .find(|g| g & bit != 0)
        .unwrap_or(0)
}

/// Only a press of a key that belongs to the prefix can arm it (not, say, releasing a Shift
/// that was held first).
fn prefix_key_event(key: Key, prefix: Prefix) -> bool {
    match key.bit() {
        Some(bit) => prefix.mods & bit_group(bit) != 0,
        None => matches!(key, Key::Other(vk) if prefix.key == Some(vk)),
    }
}

// ───────────────────────────── runtime ─────────────────────────────

static APP: OnceLock<AppHandle> = OnceLock::new();
static STATE: Mutex<Option<Hint>> = Mutex::new(None);
static DEBUG: AtomicBool = AtomicBool::new(false);

fn with_state<R>(f: impl FnOnce(&mut Hint) -> R) -> R {
    let mut guard = STATE.lock().unwrap_or_else(|e| e.into_inner());
    f(guard.get_or_insert_with(|| Hint::new(Some(Prefix::DEFAULT))))
}

/// Applies the leader key from settings. Called whenever bindings are (re-)registered.
pub fn configure(leader: Option<&str>) {
    let hide = with_state(|h| h.set_prefix(Prefix::from_leader(leader)));
    if hide {
        emit(false, None);
    }
}

/// Applies the "Guide follows the selection" setting.
pub fn set_follow_selection(on: bool) {
    with_state(|h| h.set_follow_selection(on));
}

/// The `hotkey_hint` event. `selection` is left out when unknown and null when nothing is
/// selected.
fn event(show: bool, selection: Option<Selection>) -> Value {
    let mut event = json!({ "kind": "hotkey_hint", "show": show });
    match selection {
        Some(Selection::Nothing) => event["selection"] = Value::Null,
        Some(Selection::Text(text)) => event["selection"] = json!({ "editable": text.editable }),
        None => {}
    }
    event
}

fn emit(show: bool, selection: Option<Selection>) {
    let Some(app) = APP.get() else { return };
    if show {
        // With a usable selection rectangle the guide floats over the selection, and the main
        // window shows none.
        if let Some(Selection::Text(text)) = selection {
            if crate::guide::show(app, text) {
                return;
            }
        }
    } else {
        crate::guide::hide(app);
    }
    emit_beside(app, show, selection);
}

/// The `hotkey_hint` event to the main window, which shows the guide beside the eyes.
pub(crate) fn emit_beside(app: &AppHandle, show: bool, selection: Option<Selection>) {
    debug_log(&format!(
        "hotkey_hint {}",
        if show { "show" } else { "hide" }
    ));
    let _ = app.emit_to(crate::window::MAIN, "ui", &event(show, selection));
}

/// With `WINKU_DEBUG_HINT=1`, appends a line per guide event to `WINKU_DEBUG_HINT_LOG` (default
/// `winku-hint.log` in the temp dir): `hotkey_hint show`/`hide` for the main window, `guide show
/// <x>,<y> <w>x<h>`/`guide hide` for the floating guide. CI's screenshot script reads it.
pub(crate) fn debug_log(line: &str) {
    if !DEBUG.load(Ordering::Relaxed) {
        return;
    }
    let path = std::env::var_os("WINKU_DEBUG_HINT_LOG")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::env::temp_dir().join("winku-hint.log"));
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        use std::io::Write;
        let _ = writeln!(file, "{line}");
    }
}

#[cfg(windows)]
fn on_key(key: Key, down: bool) -> Timer {
    let may_ask =
        || !crate::fullscreen::active() && !APP.get().is_some_and(crate::hotkeys::summon_held);
    let outcome = with_state(|h| h.on_key_where(key, down, Instant::now(), may_ask));
    if outcome.hide {
        emit(false, None);
    }
    if let Some(query) = outcome.query {
        // Off the raw input thread: UI Automation can take up to its time box.
        std::thread::spawn(move || {
            let selection = crate::platform::selection_summary();
            with_state(|h| h.answered(query, selection));
        });
    }
    outcome.timer
}

/// The 450 ms timer. `Some(ms)`: start it again for that long.
#[cfg(windows)]
fn on_timer() -> Option<u32> {
    let allowed = !crate::fullscreen::active();
    match with_state(|h| {
        h.timer_fired(Instant::now(), allowed)
            .map(|shown| shown.then(|| h.guide_selection()))
    }) {
        Ok(Some(selection)) => {
            emit(true, selection);
            None
        }
        Ok(None) => None,
        Err(left) => Some(left.as_millis().max(1) as u32),
    }
}

#[cfg(windows)]
pub fn start(app: &AppHandle) {
    if APP.set(app.clone()).is_err() {
        return;
    }
    DEBUG.store(
        std::env::var("WINKU_DEBUG_HINT").is_ok_and(|v| v == "1"),
        Ordering::Relaxed,
    );
    rawinput::watch(on_key, on_timer, HOLD_DELAY.as_millis() as u32);
}

#[cfg(not(windows))]
pub fn start(_app: &AppHandle) {}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::platform::SelectedText;

    const T0: fn() -> Instant = Instant::now;

    fn ms(base: Instant, n: u64) -> Instant {
        base + Duration::from_millis(n)
    }

    fn ctrl_alt() -> Hint {
        Hint::new(Some(Prefix::DEFAULT))
    }

    fn timer(o: Outcome) -> Timer {
        o.timer
    }

    #[test]
    fn holding_ctrl_alt_shows_after_the_delay_then_hides_on_release() {
        let t = T0();
        let mut h = ctrl_alt();
        assert_eq!(timer(h.on_key(Key::LCtrl, true, t)), Timer::Keep);
        assert_eq!(timer(h.on_key(Key::LAlt, true, ms(t, 20))), Timer::Start);
        assert_eq!(h.timer_fired(ms(t, 470), true), Ok(true));
        assert!(h.is_shown());
        let out = h.on_key(Key::LAlt, false, ms(t, 1500));
        assert!(out.hide);
        assert!(!h.is_shown());
    }

    #[test]
    fn either_side_and_either_order_work() {
        let t = T0();
        let mut h = ctrl_alt();
        h.on_key(Key::RAlt, true, t);
        assert_eq!(timer(h.on_key(Key::RCtrl, true, t)), Timer::Start);
        // AltGr (LCtrl + RAlt) counts as Ctrl+Alt too.
        let mut g = ctrl_alt();
        g.on_key(Key::LCtrl, true, t);
        assert_eq!(timer(g.on_key(Key::RAlt, true, t)), Timer::Start);
    }

    #[test]
    fn releasing_before_the_delay_cancels_without_a_hide() {
        let t = T0();
        let mut h = ctrl_alt();
        h.on_key(Key::LCtrl, true, t);
        h.on_key(Key::LAlt, true, t);
        let out = h.on_key(Key::LCtrl, false, ms(t, 200));
        assert_eq!(
            out,
            Outcome {
                timer: Timer::Cancel,
                hide: false,
                query: None
            }
        );
        assert_eq!(
            h.timer_fired(ms(t, 450), true),
            Ok(false),
            "late timer is a no-op"
        );
        assert!(!h.is_shown());
    }

    #[test]
    fn another_key_before_the_delay_cancels() {
        let t = T0();
        let mut h = ctrl_alt();
        h.on_key(Key::LCtrl, true, t);
        h.on_key(Key::LAlt, true, t);
        let out = h.on_key(Key::Other(b'1' as u16), true, ms(t, 100));
        assert_eq!(
            out,
            Outcome {
                timer: Timer::Cancel,
                hide: false,
                query: None
            }
        );
        assert_eq!(h.timer_fired(ms(t, 450), true), Ok(false));
        // Releasing the digit and holding on does not bring the hint back.
        h.on_key(Key::Other(b'1' as u16), false, ms(t, 200));
        assert_eq!(h.timer_fired(ms(t, 600), true), Ok(false));
    }

    #[test]
    fn another_key_while_shown_hides_once() {
        let t = T0();
        let mut h = ctrl_alt();
        h.on_key(Key::LCtrl, true, t);
        h.on_key(Key::LAlt, true, t);
        assert_eq!(h.timer_fired(ms(t, 450), true), Ok(true));
        let out = h.on_key(Key::Other(0x20), true, ms(t, 900));
        assert_eq!(
            out,
            Outcome {
                timer: Timer::Keep,
                hide: true,
                query: None
            }
        );
        // Auto-repeat, the release and the modifiers going up send nothing more.
        assert!(!h.on_key(Key::Other(0x20), true, ms(t, 950)).hide);
        assert!(!h.on_key(Key::Other(0x20), false, ms(t, 1000)).hide);
        assert!(!h.on_key(Key::LAlt, false, ms(t, 1100)).hide);
        assert!(!h.on_key(Key::LCtrl, false, ms(t, 1100)).hide);
    }

    #[test]
    fn an_extra_modifier_is_another_key() {
        let t = T0();
        let mut h = ctrl_alt();
        h.on_key(Key::LCtrl, true, t);
        h.on_key(Key::LAlt, true, t);
        assert_eq!(h.timer_fired(ms(t, 450), true), Ok(true));
        assert!(
            h.on_key(Key::LShift, true, ms(t, 600)).hide,
            "Ctrl+Alt+Shift+5 chord"
        );
        // Shift first, then Ctrl+Alt: not the prefix on its own.
        let mut g = ctrl_alt();
        g.on_key(Key::LShift, true, t);
        g.on_key(Key::LCtrl, true, t);
        assert_eq!(timer(g.on_key(Key::LAlt, true, t)), Timer::Keep);
    }

    #[test]
    fn a_normal_shortcut_with_ctrl_never_arms() {
        let t = T0();
        let mut h = ctrl_alt();
        h.on_key(Key::LCtrl, true, t);
        h.on_key(Key::Other(b'C' as u16), true, ms(t, 50));
        assert_eq!(timer(h.on_key(Key::LAlt, true, ms(t, 80))), Timer::Keep);
        h.on_key(Key::LAlt, false, ms(t, 90));
        h.on_key(Key::LCtrl, false, ms(t, 95));
        // Everything released: arms again for the next hold.
        h.on_key(Key::LCtrl, true, ms(t, 500));
        assert_eq!(timer(h.on_key(Key::LAlt, true, ms(t, 500))), Timer::Start);
    }

    #[test]
    fn typing_unrelated_keys_does_nothing() {
        let t = T0();
        let mut h = ctrl_alt();
        for i in 0..5 {
            assert_eq!(h.on_key(Key::Other(b'A' as u16), true, ms(t, i)), NOTHING);
            assert_eq!(h.on_key(Key::Other(b'A' as u16), false, ms(t, i)), NOTHING);
        }
    }

    #[test]
    fn blocked_when_not_allowed_then_recovers_after_release() {
        let t = T0();
        let mut h = ctrl_alt();
        h.on_key(Key::LCtrl, true, t);
        h.on_key(Key::LAlt, true, t);
        assert_eq!(h.timer_fired(ms(t, 450), false), Ok(false), "fullscreen");
        assert!(!h.is_shown());
        assert!(!h.on_key(Key::LAlt, false, ms(t, 800)).hide);
        h.on_key(Key::LCtrl, false, ms(t, 800));
        h.on_key(Key::LCtrl, true, ms(t, 1000));
        assert_eq!(timer(h.on_key(Key::LAlt, true, ms(t, 1000))), Timer::Start);
    }

    #[test]
    fn a_stale_early_timer_asks_to_restart() {
        let t = T0();
        let mut h = ctrl_alt();
        h.on_key(Key::LCtrl, true, t);
        h.on_key(Key::LAlt, true, t);
        h.on_key(Key::LAlt, false, ms(t, 100));
        h.on_key(Key::LAlt, true, ms(t, 300)); // a second hold; a timer from the first fires
        assert_eq!(
            h.timer_fired(ms(t, 450), true),
            Err(Duration::from_millis(300))
        );
        assert_eq!(h.timer_fired(ms(t, 750), true), Ok(true));
    }

    #[test]
    fn no_duplicate_show() {
        let t = T0();
        let mut h = ctrl_alt();
        h.on_key(Key::LCtrl, true, t);
        h.on_key(Key::LAlt, true, t);
        assert_eq!(h.timer_fired(ms(t, 450), true), Ok(true));
        assert_eq!(h.timer_fired(ms(t, 460), true), Ok(false));
        // Auto-repeat of the modifiers while held changes nothing.
        assert_eq!(h.on_key(Key::LCtrl, true, ms(t, 500)), NOTHING);
        assert_eq!(h.on_key(Key::LAlt, true, ms(t, 500)), NOTHING);
    }

    #[test]
    fn modifier_leader_replaces_ctrl_alt() {
        let prefix = Prefix::from_leader(Some("Ctrl+Shift"));
        let t = T0();
        let mut h = Hint::new(prefix);
        h.on_key(Key::LCtrl, true, t);
        assert_eq!(timer(h.on_key(Key::RShift, true, t)), Timer::Start);
        // Alt is now foreign.
        assert_eq!(timer(h.on_key(Key::LAlt, true, ms(t, 10))), Timer::Cancel);
    }

    #[test]
    fn key_leader_works_as_a_held_chord() {
        let prefix = Prefix::from_leader(Some("F13"));
        assert_eq!(
            prefix,
            Some(Prefix {
                mods: 0,
                key: Some(0x7C)
            })
        );
        let t = T0();
        let mut h = Hint::new(prefix);
        assert_eq!(timer(h.on_key(Key::Other(0x7C), true, t)), Timer::Start);
        assert_eq!(
            timer(h.on_key(Key::Other(0x7C), true, ms(t, 30))),
            Timer::Keep,
            "repeat"
        );
        assert_eq!(h.timer_fired(ms(t, 450), true), Ok(true));
        assert!(h.on_key(Key::Other(b'Q' as u16), true, ms(t, 700)).hide);
        h.on_key(Key::Other(b'Q' as u16), false, ms(t, 800));
        h.on_key(Key::Other(0x7C), false, ms(t, 900));
        // Releasing the leader while shown hides it.
        let mut g = Hint::new(prefix);
        g.on_key(Key::Other(0x7C), true, t);
        assert_eq!(g.timer_fired(ms(t, 450), true), Ok(true));
        assert!(g.on_key(Key::Other(0x7C), false, ms(t, 800)).hide);
    }

    #[test]
    fn leader_parsing() {
        assert_eq!(Prefix::from_leader(None), Some(Prefix::DEFAULT));
        assert_eq!(Prefix::from_leader(Some("  ")), Some(Prefix::DEFAULT));
        assert_eq!(
            Prefix::from_leader(Some("Super+Alt")),
            Some(Prefix {
                mods: WIN | ALT,
                key: None
            })
        );
        assert_eq!(
            Prefix::from_leader(Some("Ctrl+F13")),
            Some(Prefix {
                mods: CTRL,
                key: Some(0x7C)
            })
        );
        assert_eq!(Prefix::from_leader(Some("Nonsense")), None);
        assert_eq!(Prefix::from_leader(Some("F13+F14")), None);
    }

    fn hold(h: &mut Hint, t: Instant) -> Option<Query> {
        h.on_key(Key::LCtrl, true, t);
        h.on_key(Key::LAlt, true, t).query
    }

    fn editable() -> Selection {
        Selection::Text(SelectedText {
            editable: true,
            line: None,
        })
    }

    #[test]
    fn one_query_per_hold_started_when_the_hold_begins() {
        let t = T0();
        let mut h = ctrl_alt();
        assert_eq!(h.on_key(Key::LCtrl, true, t).query, None, "Ctrl alone");
        let first = h.on_key(Key::LAlt, true, t).query;
        assert!(first.is_some());
        // Auto-repeat, the timer and the release ask nothing more.
        assert_eq!(h.on_key(Key::LAlt, true, ms(t, 30)).query, None);
        assert_eq!(h.timer_fired(ms(t, 450), true), Ok(true));
        assert_eq!(h.on_key(Key::LAlt, false, ms(t, 900)).query, None);
        h.on_key(Key::LCtrl, false, ms(t, 900));
        // The next hold asks again, with a new query.
        let second = hold(&mut h, ms(t, 1000));
        assert!(second.is_some());
        assert_ne!(first, second);
    }

    #[test]
    fn the_guide_shows_what_the_app_answered() {
        let t = T0();
        let mut h = ctrl_alt();
        let q = hold(&mut h, t).unwrap();
        h.answered(q, Some(editable()));
        assert_eq!(h.timer_fired(ms(t, 450), true), Ok(true));
        assert_eq!(h.guide_selection(), Some(editable()));

        let mut g = ctrl_alt();
        let q = hold(&mut g, t).unwrap();
        g.answered(q, Some(Selection::Nothing));
        assert_eq!(g.timer_fired(ms(t, 450), true), Ok(true));
        assert_eq!(g.guide_selection(), Some(Selection::Nothing));
    }

    #[test]
    fn no_answer_in_time_shows_the_full_guide_and_a_late_one_changes_nothing() {
        let t = T0();
        let mut h = ctrl_alt();
        let q = hold(&mut h, t).unwrap();
        assert_eq!(h.timer_fired(ms(t, 450), true), Ok(true));
        assert_eq!(h.guide_selection(), None, "unknown");
        h.answered(q, Some(editable()));
        assert_eq!(h.guide_selection(), None, "late answer ignored");
    }

    #[test]
    fn an_answer_from_an_earlier_hold_is_ignored() {
        let t = T0();
        let mut h = ctrl_alt();
        let old = hold(&mut h, t).unwrap();
        h.on_key(Key::LAlt, false, ms(t, 100));
        h.on_key(Key::LCtrl, false, ms(t, 100));
        let _new = hold(&mut h, ms(t, 200)).unwrap();
        h.answered(old, Some(editable()));
        assert_eq!(h.timer_fired(ms(t, 650), true), Ok(true));
        assert_eq!(h.guide_selection(), None);
    }

    #[test]
    fn no_query_with_the_setting_off() {
        let t = T0();
        let mut h = ctrl_alt();
        h.set_follow_selection(false);
        assert_eq!(hold(&mut h, t), None);
        assert_eq!(
            h.timer_fired(ms(t, 450), true),
            Ok(true),
            "the guide still shows"
        );
        assert_eq!(h.guide_selection(), None, "the full guide");
    }

    #[test]
    fn no_query_over_a_fullscreen_app_or_during_a_summon_hold() {
        let t = T0();
        let mut h = ctrl_alt();
        h.on_key_where(Key::LCtrl, true, t, || false);
        let out = h.on_key_where(Key::LAlt, true, t, || false);
        assert_eq!(out.timer, Timer::Start, "the hold still arms");
        assert_eq!(out.query, None);
    }

    #[test]
    fn the_event_carries_the_selection_only_when_known() {
        assert_eq!(
            event(true, None),
            json!({ "kind": "hotkey_hint", "show": true })
        );
        assert_eq!(
            event(true, Some(Selection::Nothing)),
            json!({ "kind": "hotkey_hint", "show": true, "selection": null })
        );
        assert_eq!(
            event(
                true,
                Some(Selection::Text(SelectedText {
                    editable: false,
                    line: None
                }))
            ),
            json!({ "kind": "hotkey_hint", "show": true, "selection": { "editable": false } })
        );
        assert_eq!(
            event(false, None),
            json!({ "kind": "hotkey_hint", "show": false })
        );
    }

    #[test]
    fn changing_the_prefix_hides_a_showing_hint() {
        let t = T0();
        let mut h = ctrl_alt();
        h.on_key(Key::LCtrl, true, t);
        h.on_key(Key::LAlt, true, t);
        assert_eq!(h.timer_fired(ms(t, 450), true), Ok(true));
        assert!(h.set_prefix(Prefix::from_leader(Some("F13"))));
        assert!(!h.set_prefix(None));
        assert_eq!(
            h.on_key(Key::LCtrl, true, t),
            NOTHING,
            "no prefix, no hints"
        );
    }
}
