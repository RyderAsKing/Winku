//! Global hotkeys: registration from settings, the leader key, tap vs hold on the summon key,
//! failure reporting and the AltGr check.
//!
//! Leader key: when `leaderKey` is set it replaces `Ctrl+Alt` in every binding. A leader made of
//! modifiers (`Ctrl+Shift`) is substituted directly. A leader that is an ordinary key (`F13`)
//! works as a held chord: the leader itself is registered, and the rest of each binding
//! (`Space`, `1`, `Q`, …) is registered only while the leader is held down.

use std::collections::HashMap;
use std::str::FromStr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutEvent, ShortcutState};

use crate::settings::{Hotkeys, Settings};
use crate::window::{Mode, WindowState};

/// Released within this = tap (toggle the bar); held longer = talk.
pub const TAP_MAX: Duration = Duration::from_millis(250);
/// Event with the current registration status, emitted to every window.
pub const STATUS_EVENT: &str = "hotkeys_status";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Binding {
    Summon,
    /// Slot 1–5.
    Action(u8),
    AskSelection,
    Screenshot,
    Clear,
    CycleThinking,
}

impl Binding {
    /// The settings field name, used in failure reports.
    pub fn name(self) -> String {
        match self {
            Binding::Summon => "summon".into(),
            Binding::Action(slot) => format!("action{slot}"),
            Binding::AskSelection => "askSelection".into(),
            Binding::Screenshot => "screenshot".into(),
            Binding::Clear => "clear".into(),
            Binding::CycleThinking => "cycleThinking".into(),
        }
    }
}

pub fn bindings(hotkeys: &Hotkeys) -> Vec<(Binding, String)> {
    let mut list = vec![(Binding::Summon, hotkeys.summon.clone())];
    for (i, key) in hotkeys.actions.iter().take(5).enumerate() {
        list.push((Binding::Action(i as u8 + 1), key.clone()));
    }
    list.push((Binding::AskSelection, hotkeys.ask_selection.clone()));
    list.push((Binding::Screenshot, hotkeys.screenshot.clone()));
    list.push((Binding::Clear, hotkeys.clear.clone()));
    list.push((Binding::CycleThinking, hotkeys.cycle_thinking.clone()));
    list.into_iter()
        .filter(|(_, key)| !key.trim().is_empty())
        .collect()
}

// ───────────────────────────── parsing ─────────────────────────────

fn tokens(binding: &str) -> Vec<String> {
    binding
        .split('+')
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
        .collect()
}

fn is_modifier(token: &str) -> bool {
    matches!(
        token.to_ascii_lowercase().as_str(),
        "ctrl"
            | "control"
            | "alt"
            | "option"
            | "shift"
            | "super"
            | "cmd"
            | "command"
            | "win"
            | "meta"
    )
}

fn is_ctrl(token: &str) -> bool {
    matches!(token.to_ascii_lowercase().as_str(), "ctrl" | "control")
}

fn is_alt(token: &str) -> bool {
    matches!(token.to_ascii_lowercase().as_str(), "alt" | "option")
}

/// "Win"/"Meta" are friendlier names for Super; the parser only knows "Super".
fn canonical(binding: &str) -> String {
    tokens(binding)
        .into_iter()
        .map(|t| match t.to_ascii_lowercase().as_str() {
            "win" | "meta" => "Super".to_string(),
            _ => t,
        })
        .collect::<Vec<_>>()
        .join("+")
}

/// What to register for one binding.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Resolved {
    /// An ordinary global shortcut.
    Direct(String),
    /// Hold `leader`, then press `key`.
    Chord { leader: String, key: String },
}

/// Applies the leader key to a binding.
pub fn resolve(binding: &str, leader: Option<&str>) -> Resolved {
    let parts = tokens(binding);
    let leader = leader.map(str::trim).filter(|l| !l.is_empty());
    let uses_ctrl_alt = parts.iter().any(|t| is_ctrl(t)) && parts.iter().any(|t| is_alt(t));
    let Some(leader) = leader.filter(|_| uses_ctrl_alt) else {
        return Resolved::Direct(canonical(binding));
    };
    let rest: Vec<String> = parts
        .into_iter()
        .filter(|t| !is_ctrl(t) && !is_alt(t))
        .collect();
    if tokens(leader).iter().all(|t| is_modifier(t)) {
        Resolved::Direct(canonical(&format!("{leader}+{}", rest.join("+"))))
    } else {
        Resolved::Chord {
            leader: canonical(leader),
            key: canonical(&rest.join("+")),
        }
    }
}

pub fn parse(binding: &str) -> Result<Shortcut, String> {
    Shortcut::from_str(binding).map_err(|e| format!("can't read \"{binding}\": {e}"))
}

// ───────────────────────────── tap / hold ─────────────────────────────

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Release {
    Tap,
    /// The key was held; `started` = talk_start was already emitted.
    Hold {
        started: bool,
    },
}

/// Tap vs hold on the summon key. Pure: callers pass the time.
#[derive(Debug, Default)]
pub struct TapHold {
    pressed_at: Option<Instant>,
    generation: u64,
    held: bool,
}

impl TapHold {
    /// A key-down. Returns the press generation to check later with `hold_due`, or None for an
    /// auto-repeat while already down.
    pub fn press(&mut self, now: Instant) -> Option<u64> {
        if self.pressed_at.is_some() {
            return None;
        }
        self.pressed_at = Some(now);
        self.generation += 1;
        self.held = false;
        Some(self.generation)
    }

    /// Called TAP_MAX after a press. True (once) if that same press is still down: start talking.
    pub fn hold_due(&mut self, generation: u64, now: Instant) -> bool {
        match self.pressed_at {
            Some(at)
                if generation == self.generation
                    && !self.held
                    && now.duration_since(at) >= TAP_MAX =>
            {
                self.held = true;
                true
            }
            _ => false,
        }
    }

    pub fn is_down(&self) -> bool {
        self.pressed_at.is_some()
    }

    /// A key-up. None if the key wasn't down.
    pub fn release(&mut self, now: Instant) -> Option<Release> {
        let at = self.pressed_at.take()?;
        if self.held {
            self.held = false;
            Some(Release::Hold { started: true })
        } else if now.duration_since(at) < TAP_MAX {
            Some(Release::Tap)
        } else {
            Some(Release::Hold { started: false })
        }
    }
}

/// What releasing the summon key does.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SummonRelease {
    /// Open or hide the bar.
    Toggle,
    /// Stop recording; the transcription follows as `talk_end`.
    EndTalk,
    /// A hold too short to have started recording: `talk_start` then an empty `talk_end`.
    EmptyTalk,
}

/// `talking`: this hold started a recording. While listening is paused a hold acts like a tap.
pub fn summon_release(release: Release, talking: bool, paused: bool) -> SummonRelease {
    match release {
        Release::Tap => SummonRelease::Toggle,
        Release::Hold { .. } if talking => SummonRelease::EndTalk,
        Release::Hold { started: true } => SummonRelease::Toggle, // paused when the hold began
        Release::Hold { started: false } if paused => SummonRelease::Toggle,
        Release::Hold { started: false } => SummonRelease::EmptyTalk,
    }
}

// ───────────────────────────── runtime ─────────────────────────────

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct Failure {
    /// Settings field: "summon", "action1"…"action5", "askSelection", "screenshot", "clear",
    /// "cycleThinking", or "leaderKey".
    pub name: String,
    pub binding: String,
    pub error: String,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct Status {
    pub failed: Vec<Failure>,
}

#[derive(Default)]
pub struct HotkeyState {
    direct: Mutex<HashMap<u32, Binding>>,
    leader: Mutex<Option<Shortcut>>,
    chord: Mutex<Vec<(Shortcut, Binding)>>,
    leader_down: AtomicBool,
    status: Mutex<Status>,
    summon: Mutex<TapHold>,
    /// The current summon hold started a recording.
    talking: AtomicBool,
}

impl HotkeyState {
    pub fn status(&self) -> Status {
        self.status
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }
}

/// (Re-)registers every binding from settings and reports failures to all windows.
pub fn register_all(app: &AppHandle, settings: &Settings) {
    let gs = app.global_shortcut();
    let state = app.state::<HotkeyState>();
    let _ = gs.unregister_all();
    let mut direct = HashMap::new();
    let mut chord = Vec::new();
    let mut leader_shortcut = None;
    let mut failed = Vec::new();
    let leader = settings.leader_key.as_deref();

    for (binding, raw) in bindings(&settings.hotkeys) {
        let fail = |error: String| Failure {
            name: binding.name(),
            binding: raw.clone(),
            error,
        };
        match resolve(&raw, leader) {
            Resolved::Direct(text) => match parse(&text) {
                Ok(sc) if direct.contains_key(&sc.id()) => {
                    failed.push(fail(format!("\"{text}\" is used twice")));
                }
                Ok(sc) => match gs.register(sc) {
                    Ok(()) => {
                        direct.insert(sc.id(), binding);
                    }
                    Err(e) => {
                        failed.push(fail(format!("\"{text}\" is taken by another app ({e})")))
                    }
                },
                Err(e) => failed.push(fail(e)),
            },
            Resolved::Chord { leader, key } => {
                if leader_shortcut.is_none() {
                    match parse(&leader) {
                        Ok(sc) => match gs.register(sc) {
                            Ok(()) => leader_shortcut = Some(sc),
                            Err(e) => failed.push(Failure {
                                name: "leaderKey".into(),
                                binding: leader.clone(),
                                error: format!("\"{leader}\" is taken by another app ({e})"),
                            }),
                        },
                        Err(e) => failed.push(Failure {
                            name: "leaderKey".into(),
                            binding: leader.clone(),
                            error: e,
                        }),
                    }
                }
                match parse(&key) {
                    Ok(sc) => chord.push((sc, binding)),
                    Err(e) => failed.push(fail(e)),
                }
            }
        }
    }
    failed.dedup();

    *state.direct.lock().unwrap_or_else(|e| e.into_inner()) = direct;
    *state.chord.lock().unwrap_or_else(|e| e.into_inner()) = chord;
    *state.leader.lock().unwrap_or_else(|e| e.into_inner()) = leader_shortcut;
    state.leader_down.store(false, Ordering::SeqCst);
    crate::hint::configure(settings.leader_key.as_deref());
    let status = Status { failed };
    for failure in &status.failed {
        eprintln!(
            "winku: hotkey {} ({}) not registered: {}",
            failure.name, failure.binding, failure.error
        );
    }
    *state.status.lock().unwrap_or_else(|e| e.into_inner()) = status.clone();
    let _ = app.emit(STATUS_EVENT, &status);
}

/// The plugin's handler for every registered shortcut.
pub fn handle(app: &AppHandle, shortcut: &Shortcut, event: ShortcutEvent) {
    let state = app.state::<HotkeyState>();
    let pressed = event.state() == ShortcutState::Pressed;

    let is_leader = state
        .leader
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .map(|l| l.id())
        == Some(shortcut.id());
    if is_leader {
        on_leader(app, pressed);
        return;
    }
    let mut binding = state
        .direct
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&shortcut.id())
        .copied();
    if binding.is_none() && state.leader_down.load(Ordering::SeqCst) {
        binding = state
            .chord
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .find(|(sc, _)| sc.id() == shortcut.id())
            .map(|(_, b)| *b);
    }
    if let Some(binding) = binding {
        dispatch(app, binding, pressed);
    }
}

fn on_leader(app: &AppHandle, pressed: bool) {
    let state = app.state::<HotkeyState>();
    if state.leader_down.swap(pressed, Ordering::SeqCst) == pressed {
        return; // auto-repeat
    }
    let chord: Vec<Shortcut> = state
        .chord
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .iter()
        .map(|(sc, _)| *sc)
        .collect();
    if !pressed
        && state
            .summon
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_down()
    {
        // The tail key's release won't arrive once it is unregistered.
        dispatch(app, Binding::Summon, false);
    }
    // Register outside the handler's call stack.
    let app = app.clone();
    std::thread::spawn(move || {
        let gs = app.global_shortcut();
        for sc in chord {
            let _ = if pressed {
                gs.register(sc)
            } else {
                gs.unregister(sc)
            };
        }
    });
}

fn emit_ui(app: &AppHandle, payload: serde_json::Value) {
    let _ = app.emit_to(crate::window::MAIN, "ui", &payload);
}

fn dispatch(app: &AppHandle, binding: Binding, pressed: bool) {
    match binding {
        Binding::Summon => summon(app, pressed),
        Binding::Clear if pressed => emit_ui(app, json!({ "kind": "clear" })),
        Binding::CycleThinking if pressed => emit_ui(app, json!({ "kind": "cycle_thinking" })),
        Binding::Action(slot) if pressed => crate::actions::on_action_hotkey(app, slot),
        Binding::AskSelection if pressed => crate::actions::on_ask_hotkey(app),
        Binding::Screenshot if pressed => crate::capture::on_screenshot_hotkey(app),
        _ => {}
    }
}

fn summon(app: &AppHandle, pressed: bool) {
    let state = app.state::<HotkeyState>();
    let now = Instant::now();
    if pressed {
        let Some(generation) = state
            .summon
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .press(now)
        else {
            return;
        };
        let app = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(TAP_MAX);
            let due = app
                .state::<HotkeyState>()
                .summon
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .hold_due(generation, Instant::now());
            if due && !listening_paused(&app) {
                app.state::<HotkeyState>()
                    .talking
                    .store(true, Ordering::SeqCst);
                crate::voice::hold_start(&app);
            }
        });
        return;
    }
    let released = state
        .summon
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .release(now);
    let Some(released) = released else {
        return;
    };
    let talking = state.talking.swap(false, Ordering::SeqCst);
    match summon_release(released, talking, listening_paused(app)) {
        SummonRelease::Toggle => {
            let showing = app.state::<WindowState>().mode() != Mode::Pill;
            if !showing {
                // Before the bar takes focus.
                crate::capture::note_summon(app);
            }
            emit_ui(
                app,
                json!({ "kind": if showing { "hide" } else { "summon" } }),
            );
        }
        SummonRelease::EndTalk => crate::voice::hold_end(app),
        SummonRelease::EmptyTalk => {
            emit_ui(app, json!({ "kind": "talk_start" }));
            emit_ui(app, json!({ "kind": "talk_end", "text": "" }));
        }
    }
}

fn listening_paused(app: &AppHandle) -> bool {
    app.state::<crate::settings::Store>()
        .get()
        .voice
        .listening_paused
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AltGrReport {
    /// null when the platform can't tell.
    pub alt_gr: Option<bool>,
    /// Keys that type a character with Ctrl+Alt in the current layout.
    pub keys: Vec<String>,
    /// Configured bindings (settings field names) that use Ctrl+Alt with one of those keys.
    pub conflicts: Vec<String>,
    /// What Settings should offer instead.
    pub suggestion: &'static str,
}

/// Whether the keyboard layout uses `Ctrl+Alt` as AltGr, and which bindings that breaks.
pub fn altgr_report(settings: &Settings) -> AltGrReport {
    let Some(keys) = crate::platform::altgr_keys() else {
        return AltGrReport {
            alt_gr: None,
            keys: vec![],
            conflicts: vec![],
            suggestion: "Ctrl+Shift",
        };
    };
    let conflicts = altgr_conflicts(&settings.hotkeys, settings.leader_key.as_deref(), &keys);
    AltGrReport {
        alt_gr: Some(!keys.is_empty()),
        keys: keys.iter().map(|k| k.to_string()).collect(),
        conflicts,
        suggestion: "Ctrl+Shift",
    }
}

pub fn altgr_conflicts(hotkeys: &Hotkeys, leader: Option<&str>, keys: &[char]) -> Vec<String> {
    bindings(hotkeys)
        .into_iter()
        .filter_map(|(binding, raw)| {
            let Resolved::Direct(text) = resolve(&raw, leader) else {
                return None;
            };
            let parts = tokens(&text);
            let ctrl_alt = parts.iter().any(|t| is_ctrl(t)) && parts.iter().any(|t| is_alt(t));
            let key = parts.last()?.to_ascii_uppercase();
            let mut chars = key.chars();
            let single = chars.next().filter(|_| chars.next().is_none())?;
            (ctrl_alt && keys.contains(&single)).then(|| binding.name())
        })
        .collect()
}

#[cfg(test)]
#[allow(clippy::field_reassign_with_default)]
mod tests {
    use super::*;

    #[test]
    fn default_bindings_parse() {
        for (binding, raw) in bindings(&Hotkeys::default()) {
            let Resolved::Direct(text) = resolve(&raw, None) else {
                panic!()
            };
            assert!(parse(&text).is_ok(), "{binding:?} {text}");
        }
        assert_eq!(bindings(&Hotkeys::default()).len(), 10);
    }

    #[test]
    fn friendly_names_and_errors() {
        assert!(parse(&canonical("Win+Shift+K")).is_ok());
        assert!(parse("Ctrl+Alt+Nope").is_err());
        assert!(parse("Ctrl+Alt").is_err());
        let mut hotkeys = Hotkeys::default();
        hotkeys.clear = "  ".into();
        assert!(
            !bindings(&hotkeys).iter().any(|(b, _)| *b == Binding::Clear),
            "blank = unbound"
        );
    }

    #[test]
    fn leader_modifiers_replace_ctrl_alt() {
        assert_eq!(
            resolve("Ctrl+Alt+Space", Some("Ctrl+Shift")),
            Resolved::Direct("Ctrl+Shift+Space".into())
        );
        assert_eq!(
            resolve("Alt+Ctrl+Shift+1", Some("Super+Alt")),
            Resolved::Direct("Super+Alt+Shift+1".into())
        );
        assert_eq!(
            resolve("Ctrl+Shift+K", Some("F13")),
            Resolved::Direct("Ctrl+Shift+K".into()),
            "no Ctrl+Alt: unchanged"
        );
        assert_eq!(
            resolve("Ctrl+Alt+Q", None),
            Resolved::Direct("Ctrl+Alt+Q".into())
        );
        assert_eq!(
            resolve("Ctrl+Alt+Q", Some("")),
            Resolved::Direct("Ctrl+Alt+Q".into())
        );
    }

    #[test]
    fn leader_key_makes_a_chord() {
        assert_eq!(
            resolve("Ctrl+Alt+Space", Some("F13")),
            Resolved::Chord {
                leader: "F13".into(),
                key: "Space".into()
            }
        );
        let Resolved::Chord { leader, key } = resolve("Ctrl+Alt+Shift+5", Some("F13")) else {
            panic!()
        };
        assert!(parse(&leader).is_ok());
        assert_eq!(key, "Shift+5");
        assert!(parse(&key).is_ok());
    }

    #[test]
    fn quick_release_is_a_tap() {
        let t0 = Instant::now();
        let mut th = TapHold::default();
        let generation = th.press(t0).unwrap();
        assert_eq!(
            th.press(t0 + Duration::from_millis(30)),
            None,
            "auto-repeat ignored"
        );
        assert_eq!(
            th.release(t0 + Duration::from_millis(120)),
            Some(Release::Tap)
        );
        assert!(
            !th.hold_due(generation, t0 + TAP_MAX),
            "released before the timer"
        );
        assert_eq!(th.release(t0 + TAP_MAX), None);
    }

    #[test]
    fn long_press_is_a_hold() {
        let t0 = Instant::now();
        let mut th = TapHold::default();
        let generation = th.press(t0).unwrap();
        assert!(
            !th.hold_due(generation, t0 + Duration::from_millis(100)),
            "too early"
        );
        assert!(th.hold_due(generation, t0 + TAP_MAX));
        assert!(!th.hold_due(generation, t0 + TAP_MAX), "only once");
        assert_eq!(
            th.release(t0 + Duration::from_secs(2)),
            Some(Release::Hold { started: true })
        );
    }

    #[test]
    fn late_timer_still_counts_as_hold_and_stale_timers_are_ignored() {
        let t0 = Instant::now();
        let mut th = TapHold::default();
        let first = th.press(t0).unwrap();
        assert_eq!(
            th.release(t0 + Duration::from_millis(400)),
            Some(Release::Hold { started: false })
        );
        let second = th.press(t0 + Duration::from_millis(500)).unwrap();
        assert!(
            !th.hold_due(first, t0 + Duration::from_millis(800)),
            "timer from the previous press"
        );
        assert!(th.hold_due(second, t0 + Duration::from_millis(800)));
    }

    #[test]
    fn hold_while_paused_acts_like_a_tap() {
        use SummonRelease::*;
        let held = Release::Hold { started: true };
        let late = Release::Hold { started: false };
        assert_eq!(summon_release(Release::Tap, false, false), Toggle);
        assert_eq!(summon_release(Release::Tap, false, true), Toggle);
        assert_eq!(summon_release(held, true, false), EndTalk);
        assert_eq!(
            summon_release(held, true, true),
            EndTalk,
            "paused mid-hold: the recording still ends normally"
        );
        assert_eq!(
            summon_release(held, false, true),
            Toggle,
            "paused hold = tap"
        );
        assert_eq!(summon_release(late, false, true), Toggle);
        assert_eq!(summon_release(late, false, false), EmptyTalk);
    }

    #[test]
    fn altgr_conflicts_list_ctrl_alt_bindings_on_affected_keys() {
        let hotkeys = Hotkeys::default();
        // German layout: Ctrl+Alt+Q = @, Ctrl+Alt+2 = ², Ctrl+Alt+E = €.
        let keys = ['2', '3', '7', 'E', 'Q'];
        assert_eq!(
            altgr_conflicts(&hotkeys, None, &keys),
            ["action2", "action3", "askSelection"]
        );
        assert!(altgr_conflicts(&hotkeys, Some("Ctrl+Shift"), &keys).is_empty());
        assert!(altgr_conflicts(&hotkeys, Some("F13"), &keys).is_empty());
    }
}
