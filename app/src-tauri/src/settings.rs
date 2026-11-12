//! `settings.json`: schema, defaults, load and atomic save. The TypeScript mirror is
//! `app/ui/src/lib/settings.ts`; docs/ARCHITECTURE.md has the schema.
//!
//! Missing fields take defaults and unknown fields are kept (each struct carries an `extra`
//! map), so an older build never drops what a newer one wrote.

use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

pub const FILE_NAME: &str = "settings.json";

type Extra = Map<String, Value>;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub version: u32,
    /// `ProviderConfig` from protocol.ts, passed to the engine as is.
    pub provider: Option<Value>,
    pub main: Option<ModelChoice>,
    /// None = follow main with thinking "off".
    pub quick: Option<ModelChoice>,
    pub compaction_reserve_tokens: Option<u64>,
    pub ask_before_running: bool,
    pub always_allow: Vec<String>,
    pub assistant_style: String,
    pub voice_profiles: VoiceProfiles,
    pub actions: Vec<ActionSpec>,
    pub hotkeys: Hotkeys,
    pub leader_key: Option<String>,
    /// Ask the focused app what is selected when the hotkey prefix is held, and list only the
    /// keys that fit (beta, SPEC §5). Off: no query in any app, the full guide.
    pub guide_follows_selection: bool,
    pub eyes: Eyes,
    pub voice: Voice,
    pub updates: String,
    pub launch_at_login: bool,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelChoice {
    pub id: String,
    #[serde(default = "default_thinking")]
    pub thinking: String,
    #[serde(flatten)]
    pub extra: Extra,
}

fn default_thinking() -> String {
    "medium".into()
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct VoiceProfiles {
    pub default: String,
    pub by_app: BTreeMap<String, String>,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionSpec {
    pub name: String,
    pub prompt: String,
    /// "replace" | "show" | "agent"
    pub output: String,
    #[serde(default)]
    pub use_thread_context: bool,
    #[serde(default)]
    pub use_voice: bool,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Hotkeys {
    pub summon: String,
    /// Slots 1–5.
    pub actions: Vec<String>,
    pub ask_selection: String,
    pub screenshot: String,
    pub clear: String,
    pub cycle_thinking: String,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Eyes {
    pub hidden: bool,
    /// "small" | "medium" | "large"; anything else reads as small.
    pub size: String,
    /// Pill positions (physical px, top-left) keyed by monitor-layout signature.
    pub positions: BTreeMap<String, Point>,
    #[serde(flatten)]
    pub extra: Extra,
}

impl Default for Eyes {
    fn default() -> Self {
        Self {
            hidden: false,
            size: "small".into(),
            positions: BTreeMap::new(),
            extra: Extra::new(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Voice {
    pub stt: String,
    /// `"supertonic"` (downloaded neural voice, the default) or `"os"` (the system voice).
    pub tts: String,
    /// Supertonic voice, 0-4 female and 5-9 male. Absent in files written before the neural
    /// voice became the default; `normalize` uses that to move them off the OS voice once.
    #[serde(default)]
    pub tts_voice: Option<u8>,
    pub os_voice: Option<String>,
    /// `"mirror"`, `"always_voice"` or `"always_text"` (SPEC §11).
    pub reply: String,
    /// How much of a spoken reply is said: `"brief"`, `"enough"` or `"full"`.
    pub say: String,
    pub listening_paused: bool,
    #[serde(flatten)]
    pub extra: Extra,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            version: 1,
            provider: None,
            main: None,
            quick: None,
            compaction_reserve_tokens: None,
            ask_before_running: false,
            always_allow: Vec::new(),
            assistant_style: String::new(),
            voice_profiles: VoiceProfiles::default(),
            actions: default_actions(),
            hotkeys: Hotkeys::default(),
            leader_key: None,
            guide_follows_selection: true,
            eyes: Eyes::default(),
            voice: Voice::default(),
            updates: "auto".into(),
            launch_at_login: true,
            extra: Extra::new(),
        }
    }
}

impl Default for VoiceProfiles {
    fn default() -> Self {
        Self {
            default: "casual".into(),
            by_app: BTreeMap::new(),
            extra: Extra::new(),
        }
    }
}

impl Default for Hotkeys {
    fn default() -> Self {
        Self {
            summon: "Ctrl+Alt+Space".into(),
            actions: (1..=5).map(|n| format!("Ctrl+Alt+{n}")).collect(),
            ask_selection: "Ctrl+Alt+Q".into(),
            screenshot: "Ctrl+Alt+S".into(),
            clear: "Ctrl+Alt+X".into(),
            cycle_thinking: "Ctrl+Alt+T".into(),
            extra: Extra::new(),
        }
    }
}

impl Default for Voice {
    fn default() -> Self {
        Self {
            stt: "moonshine-base".into(),
            tts: "supertonic".into(),
            tts_voice: Some(crate::voice::tts::DEFAULT_VOICE),
            os_voice: None,
            reply: "mirror".into(),
            say: "enough".into(),
            listening_paused: false,
            extra: Extra::new(),
        }
    }
}

impl Voice {
    pub fn tts_voice(&self) -> u8 {
        self.tts_voice.unwrap_or(crate::voice::tts::DEFAULT_VOICE)
    }

    /// Unknown voice choices fall back to the defaults.
    pub fn normalize(&mut self) {
        let defaults = Voice::default();
        if !crate::voice::models::is_stt(&self.stt) {
            self.stt = defaults.stt;
        }
        if self.tts_voice.is_none() && self.tts == "os" {
            // v0.1.0 saved "os" without the user choosing it; the neural voice is the default now.
            self.tts = defaults.tts.clone();
        }
        if !matches!(self.tts.as_str(), "os" | "supertonic") {
            self.tts = defaults.tts; // includes the old "kokoro" option
        }
        if self
            .tts_voice
            .is_none_or(|v| v >= crate::voice::tts::VOICES)
        {
            self.tts_voice = defaults.tts_voice;
        }
        // Before v0.1.3 the shell only knew "always" and "never", and reset the UI's own
        // values to "mirror".
        match self.reply.as_str() {
            "always" => self.reply = "always_voice".into(),
            "never" => self.reply = "always_text".into(),
            "mirror" | "always_voice" | "always_text" => {}
            _ => self.reply = defaults.reply,
        }
        if !matches!(self.say.as_str(), "brief" | "enough" | "full") {
            self.say = defaults.say;
        }
        if self
            .os_voice
            .as_deref()
            .is_some_and(|v| v.trim().is_empty())
        {
            self.os_voice = None;
        }
    }
}

pub fn default_actions() -> Vec<ActionSpec> {
    let action = |name: &str, prompt: &str, output: &str, thread: bool, voice: bool| ActionSpec {
        name: name.into(),
        prompt: prompt.into(),
        output: output.into(),
        use_thread_context: thread,
        use_voice: voice,
        extra: Extra::new(),
    };
    vec![
        action(
            "Rewrite",
            "Rewrite the selected text so it reads clearly and naturally. Keep the meaning, language and \
             roughly the same length. Reply with the rewritten text only.",
            "replace",
            false,
            true,
        ),
        action(
            "Fix grammar",
            "Fix spelling, grammar and punctuation in the selected text. Change nothing else. Reply with \
             the corrected text only.",
            "replace",
            false,
            false,
        ),
        action(
            "Shorter",
            "Make the selected text noticeably shorter without losing anything important. Keep the tone. \
             Reply with the shortened text only.",
            "replace",
            false,
            true,
        ),
        action(
            "Explain",
            "Explain the selected text in plain words. Be brief; use a short list only if it helps.",
            "show",
            false,
            false,
        ),
        action(
            "Do it",
            "The selected text is a task or instruction. Carry it out with your tools, then say briefly \
             what you did.",
            "agent",
            true,
            false,
        ),
    ]
}

impl Settings {
    /// Fills in what a hand-edited or older file may lack: exactly five action slots and five
    /// action hotkeys, and voice choices the app knows.
    pub fn normalize(&mut self) {
        self.voice.normalize();
        let defaults = default_actions();
        self.actions.truncate(5);
        let have = self.actions.len();
        self.actions.extend(defaults.into_iter().skip(have));
        self.hotkeys.actions.truncate(5);
        let have = self.hotkeys.actions.len();
        self.hotkeys
            .actions
            .extend(Hotkeys::default().actions.into_iter().skip(have));
        self.version = 1;
    }

    /// The `configure` command for the engine, or None while there is no provider or main model
    /// (the UI shows its Connect form).
    pub fn configure_command(
        &self,
        data_dir: &Path,
        api_key: Option<&str>,
        search_api_key: Option<&str>,
    ) -> Option<Value> {
        let provider = self.provider.as_ref().filter(|p| !p.is_null())?;
        let main = self.main.as_ref()?;
        let mut message = json!({
            "type": "configure",
            "dataDir": data_dir,
            "provider": provider,
            "main": { "id": main.id, "thinking": main.thinking },
            "askBeforeRunning": self.ask_before_running,
            "alwaysAllow": self.always_allow,
            "assistantStyle": self.assistant_style,
            "defaultVoiceProfile": self.voice_profiles.default,
        });
        if let Some(key) = api_key {
            message["apiKey"] = json!(key);
        }
        if let Some(key) = search_api_key {
            message["searchApiKey"] = json!(key);
        }
        if let Some(quick) = &self.quick {
            message["quick"] = json!({ "id": quick.id, "thinking": quick.thinking });
        }
        if let Some(reserve) = self.compaction_reserve_tokens {
            message["compactionReserveTokens"] = json!(reserve);
        }
        Some(message)
    }
}

impl VoiceProfiles {
    /// The profile for an app (process name like "outlook.exe", any case), else the default.
    pub fn for_app(&self, app: Option<&str>) -> String {
        app.and_then(|app| {
            self.by_app
                .iter()
                .find(|(name, _)| name.eq_ignore_ascii_case(app))
                .map(|(_, profile)| profile.clone())
        })
        .filter(|profile| !profile.trim().is_empty())
        .unwrap_or_else(|| self.default.clone())
    }
}

pub fn path(data_dir: &Path) -> PathBuf {
    data_dir.join(FILE_NAME)
}

/// Loads settings. A missing file gives defaults. A file that isn't valid JSON is moved aside
/// to `settings.json.bad` so the user's edits aren't silently overwritten, then defaults are used.
pub fn load(data_dir: &Path) -> Settings {
    let file = path(data_dir);
    let text = match fs::read_to_string(&file) {
        Ok(text) => text,
        Err(_) => return Settings::default(),
    };
    match serde_json::from_str::<Settings>(&text) {
        Ok(mut settings) => {
            settings.normalize();
            settings
        }
        Err(e) => {
            eprintln!("winku: {} is invalid ({e}); using defaults", file.display());
            let _ = fs::rename(&file, data_dir.join(format!("{FILE_NAME}.bad")));
            Settings::default()
        }
    }
}

/// Writes to a temporary file in the same folder and renames it over the old one, so a crash
/// mid-write never leaves a truncated settings file.
pub fn save(data_dir: &Path, settings: &Settings) -> std::io::Result<()> {
    fs::create_dir_all(data_dir)?;
    let tmp = data_dir.join(format!("{FILE_NAME}.tmp"));
    {
        let mut file = fs::File::create(&tmp)?;
        let text = serde_json::to_string_pretty(settings).map_err(std::io::Error::other)?;
        file.write_all(text.as_bytes())?;
        file.write_all(b"\n")?;
        file.sync_all()?;
    }
    fs::rename(&tmp, path(data_dir))
}

/// True when a change between `old` and `new` affects what the engine was configured with.
pub fn engine_relevant_changed(old: &Settings, new: &Settings) -> bool {
    let key = |s: &Settings| s.configure_command(Path::new(""), None, None);
    key(old) != key(new)
}

/// True when a change affects hotkey registration.
pub fn hotkeys_changed(old: &Settings, new: &Settings) -> bool {
    old.hotkeys != new.hotkeys || old.leader_key != new.leader_key
}

/// The loaded settings and where they live. Managed Tauri state.
pub struct Store {
    pub data_dir: PathBuf,
    current: std::sync::Mutex<Settings>,
}

impl Store {
    pub fn open(data_dir: PathBuf) -> Self {
        let current = load(&data_dir);
        Self {
            data_dir,
            current: std::sync::Mutex::new(current),
        }
    }

    pub fn get(&self) -> Settings {
        self.current
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// Normalizes, saves and swaps in `new`. Returns (old, new).
    pub fn replace(&self, mut new: Settings) -> Result<(Settings, Settings), String> {
        new.normalize();
        let mut current = self.current.lock().unwrap_or_else(|e| e.into_inner());
        save(&self.data_dir, &new).map_err(|e| format!("could not save settings: {e}"))?;
        let old = std::mem::replace(&mut *current, new.clone());
        Ok((old, new))
    }

    /// Applies `change` to a copy of the current settings and saves it.
    pub fn update(
        &self,
        change: impl FnOnce(&mut Settings),
    ) -> Result<(Settings, Settings), String> {
        let mut next = self.get();
        change(&mut next);
        self.replace(next)
    }
}

#[cfg(test)]
#[allow(clippy::field_reassign_with_default)]
mod tests {

    /// Settings > Actions offers "Reset to default" using the UI's copy of the defaults
    /// (`app/ui/src/lib/defaults.ts`). Keep the two in step.
    #[test]
    fn unknown_voice_choices_fall_back_to_defaults() {
        let mut settings = Settings::default();
        settings.voice.stt = "whisper-base-en".into();
        settings.voice.tts = "os".into();
        settings.voice.tts_voice = Some(7);
        settings.voice.reply = "always_voice".into();
        settings.voice.say = "brief".into();
        settings.normalize();
        assert_eq!(settings.voice.stt, "whisper-base-en");
        assert_eq!(settings.voice.tts, "os");
        assert_eq!(settings.voice.tts_voice, Some(7));
        assert_eq!(settings.voice.reply, "always_voice");
        assert_eq!(settings.voice.say, "brief");
        settings.voice.reply = "always_text".into();
        settings.normalize();
        assert_eq!(settings.voice.reply, "always_text");
        settings.voice.stt = "supertonic".into(); // a TTS model
        settings.voice.tts = "piper".into();
        settings.voice.tts_voice = Some(40);
        settings.voice.reply = "sometimes".into();
        settings.voice.say = "everything".into();
        settings.voice.os_voice = Some(" ".into());
        settings.normalize();
        assert_eq!(settings.voice, Voice::default());
    }

    #[test]
    fn old_settings_move_off_the_os_voice_once() {
        // A v0.1.0 file: "os" was the default, and there was no voice number.
        let mut old: Settings =
            serde_json::from_str(r#"{"voice":{"tts":"os","reply":"always"}}"#).unwrap();
        old.normalize();
        assert_eq!(old.voice.tts, "supertonic");
        assert_eq!(old.voice.tts_voice, Some(crate::voice::tts::DEFAULT_VOICE));
        assert_eq!(old.voice.reply, "always_voice");
        // After that, choosing the OS voice sticks.
        old.voice.tts = "os".into();
        old.normalize();
        assert_eq!(old.voice.tts, "os");
        // The removed Kokoro option becomes the new default.
        let mut kokoro: Settings = serde_json::from_str(r#"{"voice":{"tts":"kokoro"}}"#).unwrap();
        kokoro.normalize();
        assert_eq!(kokoro.voice.tts, "supertonic");
    }

    #[test]
    fn voice_profile_follows_the_app() {
        let mut profiles = VoiceProfiles::default();
        profiles.default = "casual".into();
        profiles.by_app.insert("OUTLOOK.EXE".into(), "work".into());
        profiles.by_app.insert("slack.exe".into(), "".into());
        assert_eq!(profiles.for_app(Some("outlook.exe")), "work");
        assert_eq!(profiles.for_app(Some("slack.exe")), "casual");
        assert_eq!(profiles.for_app(Some("notepad.exe")), "casual");
        assert_eq!(profiles.for_app(None), "casual");
    }

    #[test]
    fn ui_default_actions_match() {
        let ui = include_str!("../../ui/src/lib/defaults.ts");
        for action in default_actions() {
            for text in [&action.name, &action.prompt, &action.output] {
                assert!(
                    ui.contains(&format!("\"{text}\"")),
                    "defaults.ts is missing {text:?}"
                );
            }
        }
    }

    use super::*;

    #[test]
    fn defaults_match_the_schema() {
        let value = serde_json::to_value(Settings::default()).unwrap();
        assert_eq!(value["version"], 1);
        assert_eq!(value["provider"], Value::Null);
        assert_eq!(value["compactionReserveTokens"], Value::Null);
        assert_eq!(value["askBeforeRunning"], false);
        assert_eq!(value["voiceProfiles"]["default"], "casual");
        assert_eq!(value["hotkeys"]["summon"], "Ctrl+Alt+Space");
        assert_eq!(value["hotkeys"]["cycleThinking"], "Ctrl+Alt+T");
        assert_eq!(value["hotkeys"]["actions"][4], "Ctrl+Alt+5");
        assert_eq!(
            value["eyes"],
            json!({ "hidden": false, "size": "small", "positions": {} })
        );
        assert_eq!(value["voice"]["osVoice"], Value::Null);
        assert_eq!(value["voice"]["listeningPaused"], false);
        assert_eq!(value["updates"], "auto");
        assert_eq!(value["launchAtLogin"], true);
        assert_eq!(value["guideFollowsSelection"], true);
        let names: Vec<_> = value["actions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|a| a["name"].clone())
            .collect();
        assert_eq!(
            names,
            ["Rewrite", "Fix grammar", "Shorter", "Explain", "Do it"]
        );
        assert_eq!(value["actions"][4]["output"], "agent");
        assert_eq!(value["actions"][4]["useThreadContext"], true);
        assert_eq!(value["actions"][0]["useVoice"], true);
    }

    #[test]
    fn missing_fields_take_defaults() {
        let mut settings: Settings = serde_json::from_str(r#"{"askBeforeRunning": true}"#).unwrap();
        settings.normalize();
        assert!(settings.ask_before_running);
        assert_eq!(settings.actions.len(), 5);
        assert_eq!(settings.hotkeys, Hotkeys::default());
    }

    #[test]
    fn unknown_fields_are_preserved() {
        let input = json!({
            "futureFlag": { "a": 1 },
            "hotkeys": { "summon": "F13", "futureKey": "Ctrl+Alt+P" },
            "eyes": { "hidden": true, "positions": { "sig": { "x": 1.0, "y": 2.0 } }, "size": "big" },
        });
        let settings: Settings = serde_json::from_value(input).unwrap();
        assert_eq!(settings.hotkeys.summon, "F13");
        let back = serde_json::to_value(&settings).unwrap();
        assert_eq!(back["futureFlag"], json!({ "a": 1 }));
        assert_eq!(back["hotkeys"]["futureKey"], "Ctrl+Alt+P");
        assert_eq!(back["eyes"]["size"], "big");
        assert_eq!(
            back["eyes"]["positions"]["sig"],
            json!({ "x": 1.0, "y": 2.0 })
        );
    }

    #[test]
    fn normalize_pads_actions() {
        let mut settings = Settings::default();
        settings.actions.truncate(2);
        settings.hotkeys.actions = vec!["F1".into()];
        settings.normalize();
        assert_eq!(settings.actions.len(), 5);
        assert_eq!(settings.actions[4].name, "Do it");
        assert_eq!(
            settings.hotkeys.actions,
            ["F1", "Ctrl+Alt+2", "Ctrl+Alt+3", "Ctrl+Alt+4", "Ctrl+Alt+5"]
        );
    }

    #[test]
    fn save_then_load_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let mut settings = Settings::default();
        settings.provider = Some(json!({ "kind": "catalog", "id": "anthropic" }));
        settings.main = Some(ModelChoice {
            id: "m".into(),
            thinking: "high".into(),
            extra: Extra::new(),
        });
        settings.extra.insert("other".into(), json!(true));
        save(dir.path(), &settings).unwrap();
        assert!(!dir.path().join("settings.json.tmp").exists());
        assert_eq!(load(dir.path()), settings);
    }

    #[test]
    fn missing_file_gives_defaults_and_bad_file_is_moved_aside() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(load(dir.path()), Settings::default());
        fs::write(path(dir.path()), "{ not json").unwrap();
        assert_eq!(load(dir.path()), Settings::default());
        assert!(dir.path().join("settings.json.bad").exists());
    }

    #[test]
    fn configure_needs_provider_and_main() {
        let mut settings = Settings::default();
        assert!(settings
            .configure_command(Path::new("/d"), Some("k"), None)
            .is_none());
        settings.provider = Some(json!({ "kind": "catalog", "id": "openai" }));
        assert!(settings
            .configure_command(Path::new("/d"), Some("k"), None)
            .is_none());
        settings.main = Some(ModelChoice {
            id: "gpt".into(),
            thinking: "medium".into(),
            extra: Extra::new(),
        });
        settings.compaction_reserve_tokens = Some(20000);
        let message = settings
            .configure_command(Path::new("/d"), Some("k"), Some("s"))
            .unwrap();
        assert_eq!(message["searchApiKey"], "s");
        assert!(settings
            .configure_command(Path::new("/d"), Some("k"), None)
            .unwrap()
            .get("searchApiKey")
            .is_none());
        assert_eq!(message["type"], "configure");
        assert_eq!(message["provider"]["id"], "openai");
        assert_eq!(
            message["main"],
            json!({ "id": "gpt", "thinking": "medium" })
        );
        assert_eq!(message["apiKey"], "k");
        assert_eq!(message["compactionReserveTokens"], 20000);
        assert!(message.get("quick").is_none());
        assert_eq!(message["defaultVoiceProfile"], "casual");
    }

    #[test]
    fn relevance_checks() {
        let old = Settings::default();
        let mut new = old.clone();
        new.eyes.hidden = true;
        new.provider = Some(json!({ "kind": "catalog", "id": "x" }));
        assert!(
            !engine_relevant_changed(&old, &new),
            "no main model yet: nothing to configure either way"
        );
        new.main = Some(ModelChoice {
            id: "m".into(),
            thinking: "low".into(),
            extra: Extra::new(),
        });
        assert!(engine_relevant_changed(&old, &new));
        assert!(!hotkeys_changed(&old, &new));
        new.leader_key = Some("F13".into());
        assert!(hotkeys_changed(&old, &new));
    }
}
