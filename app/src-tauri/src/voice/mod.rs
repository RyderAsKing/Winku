//! Voice (SPEC §11, ARCHITECTURE "Voice"): hold-to-talk recording and transcription, model
//! downloads, and text-to-speech. Nothing here runs or loads until it is first used: the
//! recogniser and Kokoro load on demand and unload after `stt::IDLE_UNLOAD` idle.
//!
//! Threads: each hold records on its own thread (cpal streams stay on the thread that made them)
//! and transcribes there afterwards; each download and each `speak` gets a thread too. The hotkey
//! handler and Tauri commands only start work and return.

pub mod audio;
pub mod download;
pub mod mic;
pub mod models;
pub mod stt;
pub mod tts;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::json;
use sherpa_onnx::{OfflineRecognizer, OfflineTts};
use tauri::{AppHandle, Emitter, Manager};

use crate::settings::Store;
use download::Downloads;
use models::{Kind, Model};
use stt::Slot;

/// A recording stops by itself after this long.
pub const MAX_RECORDING: Duration = Duration::from_secs(60);
/// Event for model download progress, to every window.
pub const DOWNLOAD_EVENT: &str = "download_progress";
/// How often the idle check runs while a model is loaded.
const JANITOR_INTERVAL: Duration = Duration::from_secs(20);

struct Session {
    id: u64,
    stop: Sender<()>,
}

/// A recording waiting for its model to finish downloading.
struct Pending {
    model: &'static str,
    samples: Vec<f32>,
}

struct Speaking {
    id: u64,
    stop: Arc<AtomicBool>,
}

#[derive(Default)]
pub struct Voice {
    next_id: AtomicU64,
    session: Mutex<Option<Session>>,
    pending: Mutex<Option<Pending>>,
    stt: Mutex<Slot<OfflineRecognizer>>,
    kokoro: Mutex<Slot<OfflineTts>>,
    downloads: Downloads,
    speaking: Mutex<Option<Speaking>>,
    janitor: AtomicBool,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn emit_ui(app: &AppHandle, payload: serde_json::Value) {
    let _ = app.emit_to(crate::window::MAIN, "ui", &payload);
}

fn voice_error(app: &AppHandle, message: &str) {
    eprintln!("winku: voice: {message}");
    emit_ui(app, json!({ "kind": "voice_error", "message": message }));
}

fn talk_end(app: &AppHandle, text: &str) {
    emit_ui(app, json!({ "kind": "talk_end", "text": text }));
}

fn models_dir(app: &AppHandle) -> PathBuf {
    models::models_dir(&app.state::<Store>().data_dir)
}

/// The STT model chosen in settings (the default if the setting names something else).
fn chosen_stt(app: &AppHandle) -> &'static Model {
    let id = app.state::<Store>().get().voice.stt;
    models::find(&id)
        .filter(|m| models::is_stt(m.id))
        .or_else(|| models::find(&crate::settings::Voice::default().stt))
        .expect("the default STT model is in the table")
}

// ───────────────────────────── hold to talk ─────────────────────────────

/// The summon key has been held past the tap limit (and listening isn't paused): stop any
/// speech, send `talk_start` and start recording.
pub fn hold_start(app: &AppHandle) {
    stop_speaking(app);
    let voice = app.state::<Voice>();
    let model = chosen_stt(app);
    emit_ui(app, json!({ "kind": "talk_start" }));
    ensure_download(app, model);

    let (tx, rx) = mpsc::channel();
    let id = voice.next_id.fetch_add(1, Ordering::Relaxed);
    if let Some(old) = lock(&voice.session).replace(Session { id, stop: tx }) {
        let _ = old.stop.send(());
    }
    let thread_app = app.clone();
    let spawned = std::thread::Builder::new()
        .name("winku-mic".into())
        .spawn(move || {
            let app = thread_app;
            let level_app = app.clone();
            let result = mic::record(
                &rx,
                MAX_RECORDING,
                || {},
                |level| {
                    emit_ui(&level_app, json!({ "kind": "talk_level", "level": level }));
                },
            );
            let voice = app.state::<Voice>();
            {
                let mut session = lock(&voice.session);
                if session.as_ref().is_some_and(|s| s.id == id) {
                    *session = None;
                }
            }
            match result {
                Ok(recording) => finish_recording(&app, model, recording),
                Err(e) => {
                    voice_error(&app, &e.message());
                    talk_end(&app, "");
                }
            }
        });
    if let Err(e) = spawned {
        lock(&voice.session).take();
        voice_error(app, &format!("Couldn't start recording: {e}"));
        talk_end(app, "");
    }
}

/// The summon key was released after a hold: stop recording (it is then transcribed).
pub fn hold_end(app: &AppHandle) {
    if let Some(session) = lock(&app.state::<Voice>().session).take() {
        let _ = session.stop.send(());
    }
}

fn finish_recording(app: &AppHandle, model: &'static Model, recording: mic::Recording) {
    let samples = audio::resample(&recording.samples, recording.rate, audio::STT_RATE);
    drop(recording);
    if !audio::has_speech(&samples, audio::STT_RATE) {
        talk_end(app, "");
        return;
    }
    let voice = app.state::<Voice>();
    {
        let mut pending = lock(&voice.pending);
        if !model.installed(&models_dir(app)) {
            if voice.downloads.is_active(model.id) {
                // Transcribed when the download finishes (see `ensure_download`). Only the
                // latest recording is kept.
                *pending = Some(Pending {
                    model: model.id,
                    samples,
                });
            } else {
                // The download failed during the hold; its error is already showing.
                talk_end(app, "");
            }
            return;
        }
    }
    transcribe_and_send(app, model, &samples);
}

fn transcribe_and_send(app: &AppHandle, model: &'static Model, samples: &[f32]) {
    let voice = app.state::<Voice>();
    let dir = model.dir(&models_dir(app));
    let text = {
        let mut slot = lock(&voice.stt);
        let result = slot
            .get_or_load(model.id, Instant::now(), || stt::load(model, &dir))
            .map(|recognizer| stt::transcribe(recognizer, samples));
        slot.touch(Instant::now());
        result
    };
    ensure_janitor(app);
    match text {
        Ok(text) => talk_end(app, &text),
        Err(e) => {
            voice_error(app, &e);
            talk_end(app, "");
        }
    }
}

// ───────────────────────────── models ─────────────────────────────

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub id: &'static str,
    pub kind: Kind,
    pub name: &'static str,
    pub size_mb: u64,
    pub installed: bool,
    pub downloading: bool,
}

pub fn model_list(app: &AppHandle) -> Vec<ModelInfo> {
    let voice = app.state::<Voice>();
    let dir = models_dir(app);
    models::MODELS
        .iter()
        .map(|m| ModelInfo {
            id: m.id,
            kind: m.kind,
            name: m.name,
            size_mb: m.size_mb(),
            installed: m.installed(&dir),
            downloading: voice.downloads.is_active(m.id),
        })
        .collect()
}

fn find_model(id: &str) -> Result<&'static Model, String> {
    models::find(id).ok_or_else(|| format!("unknown voice model {id:?}"))
}

/// `voice_model_download`: starts the download if the model isn't installed or downloading.
pub fn download_model(app: &AppHandle, id: &str) -> Result<(), String> {
    ensure_download(app, find_model(id)?);
    Ok(())
}

/// `voice_model_remove`: unloads the model and deletes its folder.
pub fn remove_model(app: &AppHandle, id: &str) -> Result<(), String> {
    let model = find_model(id)?;
    let voice = app.state::<Voice>();
    if voice.downloads.is_active(id) {
        return Err(format!("{} is still downloading", model.name));
    }
    match model.kind {
        Kind::Stt => lock(&voice.stt).unload(id),
        Kind::Tts => {
            stop_speaking(app);
            lock(&voice.kokoro).unload(id);
        }
    }
    let dir = model.dir(&models_dir(app));
    if dir.exists() {
        std::fs::remove_dir_all(&dir)
            .map_err(|e| format!("Couldn't remove {}: {e}", model.name))?;
    }
    Ok(())
}

fn progress(app: &AppHandle, model: &Model, fraction: f32) {
    let _ = app.emit(
        DOWNLOAD_EVENT,
        json!({ "what": model.kind.as_str(), "model": model.id, "fraction": fraction }),
    );
}

/// Starts downloading `model` on its own thread unless it is installed or already downloading.
/// A recording that was waiting for it is transcribed when it finishes.
fn ensure_download(app: &AppHandle, model: &'static Model) {
    let voice = app.state::<Voice>();
    let dir = models_dir(app);
    if model.installed(&dir) || !voice.downloads.begin(model.id) {
        return;
    }
    let thread_app = app.clone();
    let spawned = std::thread::Builder::new()
        .name("winku-download".into())
        .spawn({
            let app = thread_app;
            move || {
                if let Err(e) = std::fs::create_dir_all(&dir) {
                    eprintln!("winku: creating {}: {e}", dir.display());
                }
                progress(&app, model, 0.0);
                let result = download::install(model, &dir, &download::Https, &mut |f| {
                    progress(&app, model, f)
                });
                match &result {
                    Ok(()) => progress(&app, model, 1.0),
                    Err(e) => {
                        voice_error(&app, &e.message(model));
                        progress(&app, model, -1.0);
                    }
                }
                let voice = app.state::<Voice>();
                let waiting = {
                    let mut pending = lock(&voice.pending);
                    voice.downloads.finish(model.id);
                    pending.take_if(|p| p.model == model.id).map(|p| p.samples)
                };
                if let Some(samples) = waiting {
                    if result.is_ok() {
                        transcribe_and_send(&app, model, &samples);
                    } else {
                        talk_end(&app, "");
                    }
                }
            }
        });
    if let Err(e) = spawned {
        voice.downloads.finish(model.id);
        voice_error(app, &format!("Couldn't start the download: {e}"));
    }
}

// ───────────────────────────── speech ─────────────────────────────

/// `speak`: replaces anything playing with `text`, in the voice from settings.
pub fn speak(app: &AppHandle, text: String) {
    let text = text.trim().to_string();
    if text.is_empty() {
        stop_speaking(app);
        return;
    }
    let voice = app.state::<Voice>();
    let stop = Arc::new(AtomicBool::new(false));
    let id = voice.next_id.fetch_add(1, Ordering::Relaxed);
    if let Some(old) = lock(&voice.speaking).replace(Speaking {
        id,
        stop: Arc::clone(&stop),
    }) {
        old.stop.store(true, Ordering::SeqCst);
    }
    let settings = app.state::<Store>().get().voice;
    let app = app.clone();
    let spawned = std::thread::Builder::new()
        .name("winku-speech".into())
        .spawn(move || {
            let on_start = || {
                if !stop.load(Ordering::SeqCst) {
                    emit_ui(&app, json!({ "kind": "speech", "playing": true }));
                }
            };
            let kokoro = models::find("kokoro").expect("kokoro is in the table");
            let result = if settings.tts == "kokoro" && kokoro.installed(&models_dir(&app)) {
                speak_kokoro(&app, kokoro, &text, &stop, on_start)
            } else {
                if settings.tts == "kokoro" {
                    // Not downloaded yet: fetch it for next time, and use the OS voice now.
                    ensure_download(&app, kokoro);
                }
                tts::os_speak(&text, settings.os_voice.as_deref(), &stop, on_start)
            };
            if let Err(e) = result {
                if !stop.load(Ordering::SeqCst) {
                    voice_error(&app, &e);
                }
            }
            let voice = app.state::<Voice>();
            let mut speaking = lock(&voice.speaking);
            if speaking.as_ref().is_some_and(|s| s.id == id) {
                *speaking = None;
                emit_ui(&app, json!({ "kind": "speech", "playing": false }));
            }
        });
    if let Err(e) = spawned {
        eprintln!("winku: couldn't start speech: {e}");
    }
}

fn speak_kokoro(
    app: &AppHandle,
    model: &'static Model,
    text: &str,
    stop: &Arc<AtomicBool>,
    on_start: impl FnOnce() + Send,
) -> Result<(), String> {
    let voice = app.state::<Voice>();
    let dir = model.dir(&models_dir(app));
    let mut slot = lock(&voice.kokoro);
    let result = slot
        .get_or_load(model.id, Instant::now(), || tts::load_kokoro(model, &dir))
        .and_then(|engine| {
            let feed = tts::Feed::new(tts::kokoro_rate(engine));
            std::thread::scope(|s| {
                let player = s.spawn(|| tts::play(&feed, stop, on_start));
                tts::kokoro_speak(engine, text, &feed, stop);
                feed.finish();
                player
                    .join()
                    .unwrap_or_else(|_| Err("the player crashed".into()))
            })
        });
    slot.touch(Instant::now());
    drop(slot);
    ensure_janitor(app);
    result
}

/// `stop_speaking` (also Esc and a new hold).
pub fn stop_speaking(app: &AppHandle) {
    if let Some(current) = lock(&app.state::<Voice>().speaking).take() {
        current.stop.store(true, Ordering::SeqCst);
        emit_ui(app, json!({ "kind": "speech", "playing": false }));
    }
}

pub fn os_voices() -> Vec<tts::OsVoice> {
    tts::os_voices()
}

// ───────────────────────────── idle unload ─────────────────────────────

/// While a model is loaded, a thread checks every `JANITOR_INTERVAL` and drops models idle for
/// `stt::IDLE_UNLOAD`; it exits once nothing is loaded.
fn ensure_janitor(app: &AppHandle) {
    let voice = app.state::<Voice>();
    if voice.janitor.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    let spawned = std::thread::Builder::new()
        .name("winku-voice-idle".into())
        .spawn(move || {
            let voice = app.state::<Voice>();
            loop {
                std::thread::sleep(JANITOR_INTERVAL);
                if voice.sweep(Instant::now()) {
                    continue;
                }
                voice.janitor.store(false, Ordering::SeqCst);
                // A model loaded between the sweep and the store must still get a janitor.
                if voice.sweep(Instant::now()) && !voice.janitor.swap(true, Ordering::SeqCst) {
                    continue;
                }
                break;
            }
        });
    if spawned.is_err() {
        voice.janitor.store(false, Ordering::SeqCst);
    }
}

impl Voice {
    /// Unloads idle models. True while anything is still loaded (or busy).
    fn sweep(&self, now: Instant) -> bool {
        let mut loaded = false;
        match self.stt.try_lock() {
            Ok(mut slot) => {
                if slot.unload_if_idle(now) {
                    eprintln!("winku: speech-to-text model unloaded after idling");
                }
                loaded |= slot.is_loaded();
            }
            Err(_) => loaded = true,
        }
        match self.kokoro.try_lock() {
            Ok(mut slot) => {
                if slot.unload_if_idle(now) {
                    eprintln!("winku: Kokoro unloaded after idling");
                }
                loaded |= slot.is_loaded();
            }
            Err(_) => loaded = true,
        }
        loaded
    }
}

#[cfg(test)]
mod e2e {
    use super::*;

    /// Real models over the network, so not part of `cargo test`. Run with
    /// `WINKU_VOICE_E2E=/some/dir cargo test --release e2e -- --ignored --nocapture`: downloads
    /// moonshine-base and Kokoro into that folder (through `download::install`), has Kokoro say a
    /// sentence, resamples it to 16 kHz and transcribes it with Moonshine.
    #[test]
    #[ignore]
    fn kokoro_speech_round_trips_through_moonshine() {
        let Some(dir) = std::env::var_os("WINKU_VOICE_E2E").map(PathBuf::from) else {
            eprintln!("WINKU_VOICE_E2E not set; skipping");
            return;
        };
        std::fs::create_dir_all(&dir).unwrap();
        for id in ["moonshine-base", "kokoro"] {
            let model = models::find(id).unwrap();
            if !model.installed(&dir) {
                let started = Instant::now();
                download::install(model, &dir, &download::Https, &mut |_| {}).unwrap();
                eprintln!("installed {id} in {:.1}s", started.elapsed().as_secs_f32());
            }
        }
        let kokoro = models::find("kokoro").unwrap();
        let engine = tts::load_kokoro(kokoro, &kokoro.dir(&dir)).unwrap();
        let feed = tts::Feed::new(tts::kokoro_rate(&engine));
        let stop = Arc::new(AtomicBool::new(false));
        let sentence = "The quick brown fox jumps over the lazy dog. Winku can hear you now.";
        tts::kokoro_speak(&engine, sentence, &feed, &stop);
        let spoken = feed.take_all();
        eprintln!(
            "kokoro: {} samples at {} Hz",
            spoken.len(),
            tts::kokoro_rate(&engine)
        );
        let samples = audio::resample(&spoken, feed.rate, audio::STT_RATE);
        assert!(audio::has_speech(&samples, audio::STT_RATE));

        let moonshine = models::find("moonshine-base").unwrap();
        let recognizer = stt::load(moonshine, &moonshine.dir(&dir)).unwrap();
        let text = stt::transcribe(&recognizer, &samples);
        eprintln!("transcript: {text:?}");
        let lower = text.to_lowercase();
        assert!(lower.contains("quick brown fox"), "{text}");
        assert!(lower.contains("lazy dog"), "{text}");
    }
}
