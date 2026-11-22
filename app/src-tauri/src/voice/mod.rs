//! Voice (SPEC §11, ARCHITECTURE "Voice"): hold-to-talk recording and transcription, model
//! downloads, and text-to-speech. Nothing here runs or loads until it is first used: the
//! recogniser and the reading voice load on demand and unload after `stt::IDLE_UNLOAD` idle.
//!
//! Threads: each hold records on its own thread (cpal streams stay on the thread that made them)
//! and transcribes there afterwards, while a second thread transcribes the recording so far for
//! `talk_partial`; each download and each `speak` gets a thread too. The hotkey
//! handler and Tauri commands only start work and return.

pub mod audio;
pub mod devices;
pub mod download;
pub mod mic;
pub mod models;
pub mod partial;
pub mod speech_text;
pub mod stt;
pub mod tts;

use std::collections::VecDeque;
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
use partial::Gate;
use stt::Slot;

/// A recording stops by itself after this long.
pub const MAX_RECORDING: Duration = Duration::from_secs(60);
/// The microphone test stops by itself after this long.
pub const MAX_MIC_TEST: Duration = Duration::from_secs(30);
/// Events for the Settings window while the microphone test runs: `mic_test_level` (0-1, the
/// same scale as `talk_level`) and `mic_test_end` (null, or the message when it failed).
pub const MIC_TEST_LEVEL_EVENT: &str = "mic_test_level";
pub const MIC_TEST_END_EVENT: &str = "mic_test_end";
/// Event for model download progress, to every window.
pub const DOWNLOAD_EVENT: &str = "download_progress";
/// How often the idle check runs while a model is loaded.
const JANITOR_INTERVAL: Duration = Duration::from_secs(20);

struct Session {
    id: u64,
    stop: Sender<()>,
    /// Closed as soon as the hold ends, so no `talk_partial` follows.
    partials: Arc<Gate>,
}

/// Settings > Speech "test microphone": levels only, nothing is kept or transcribed.
struct MicTest {
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
    /// Texts appended while this one plays (`speak` with `append`), read in order.
    queue: VecDeque<String>,
}

#[derive(Default)]
pub struct Voice {
    next_id: AtomicU64,
    session: Mutex<Option<Session>>,
    mic_test: Mutex<Option<MicTest>>,
    pending: Mutex<Option<Pending>>,
    stt: Mutex<Slot<OfflineRecognizer>>,
    tts: Mutex<Slot<OfflineTts>>,
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
    app.state::<crate::engine::Engine>()
        .activity
        .set_talking(false);
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
/// speech, send `talk_start` and start recording, with `talk_partial` while it records.
pub fn hold_start(app: &AppHandle) {
    stop_speaking(app);
    // Talking wins: the test gives up the microphone.
    mic_test_stop(app);
    let voice = app.state::<Voice>();
    let model = chosen_stt(app);

    let (tx, rx) = mpsc::channel();
    let id = voice.next_id.fetch_add(1, Ordering::Relaxed);
    let partials = Arc::new(Gate::default());
    if let Some(old) = lock(&voice.session).replace(Session {
        id,
        stop: tx,
        partials: Arc::clone(&partials),
    }) {
        // Before `talk_start`, so the old recording's words don't land in this one.
        old.partials.close();
        let _ = old.stop.send(());
    }
    // Scheduled runs wait until the recording is transcribed (`talk_end`).
    app.state::<crate::engine::Engine>()
        .activity
        .set_talking(true);
    emit_ui(app, json!({ "kind": "talk_start" }));
    ensure_download(app, model);
    let thread_app = app.clone();
    let input = app.state::<Store>().get().voice.input_device;
    let spawned = std::thread::Builder::new()
        .name("winku-mic".into())
        .spawn(move || {
            let app = thread_app;
            let level_app = app.clone();
            let worker_app = app.clone();
            let worker_gate = Arc::clone(&partials);
            let result = mic::record(
                input.as_deref(),
                &rx,
                MAX_RECORDING,
                |tap| start_partials(worker_app, model, tap, worker_gate),
                |level| {
                    emit_ui(&level_app, json!({ "kind": "talk_level", "level": level }));
                },
            );
            partials.close();
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
        session.partials.close();
        let _ = session.stop.send(());
    }
}

// ───────────────────────────── microphone test ─────────────────────────────

/// Opens the chosen microphone and sends `mic_test_level` to the Settings window until
/// `mic_test_stop`, the window closing, or `MAX_MIC_TEST`. Refused while the talk key is held.
pub fn mic_test_start(app: &AppHandle) -> Result<(), String> {
    let voice = app.state::<Voice>();
    if lock(&voice.session).is_some() {
        return Err("The microphone is in use for talking.".into());
    }
    let (tx, rx) = mpsc::channel();
    let id = voice.next_id.fetch_add(1, Ordering::Relaxed);
    if let Some(old) = lock(&voice.mic_test).replace(MicTest { id, stop: tx }) {
        let _ = old.stop.send(());
    }
    let input = app.state::<Store>().get().voice.input_device;
    let thread_app = app.clone();
    let spawned = std::thread::Builder::new()
        .name("winku-mic-test".into())
        .spawn(move || {
            let app = thread_app;
            let result = mic::record(
                input.as_deref(),
                &rx,
                MAX_MIC_TEST,
                |_| {},
                |level| {
                    let _ = app.emit_to(crate::window::SETTINGS, MIC_TEST_LEVEL_EVENT, level);
                },
            );
            {
                let voice = app.state::<Voice>();
                let mut test = lock(&voice.mic_test);
                if test.as_ref().is_some_and(|t| t.id == id) {
                    *test = None;
                }
            }
            let error = result.err().map(|e| e.message());
            let _ = app.emit_to(crate::window::SETTINGS, MIC_TEST_END_EVENT, error);
        });
    if let Err(e) = spawned {
        lock(&voice.mic_test).take();
        return Err(format!("Couldn't start the microphone test: {e}"));
    }
    Ok(())
}

/// Stops the microphone test if one runs.
pub fn mic_test_stop(app: &AppHandle) {
    if let Some(test) = lock(&app.state::<Voice>().mic_test).take() {
        let _ = test.stop.send(());
    }
}

/// Starts the thread that sends `talk_partial` while the recording behind `tap` grows. Without
/// the model on disk there are no partials.
fn start_partials(app: AppHandle, model: &'static Model, tap: mic::Tap, gate: Arc<Gate>) {
    if !model.installed(&models_dir(&app)) {
        return;
    }
    let spawned = std::thread::Builder::new()
        .name("winku-partials".into())
        .spawn(move || send_partials(&app, model, &tap, &gate));
    if let Err(e) = spawned {
        eprintln!("winku: couldn't start live transcription: {e}");
    }
}

/// Transcribes the recording so far, again and again, until `gate` closes. A pass starts only
/// with the gate open while holding the recogniser's slot, so after the gate closes the final
/// transcription waits for at most the pass already running. Loads the model if needed; if that
/// fails it gives up quietly and the final transcription reports the error.
fn send_partials(app: &AppHandle, model: &'static Model, tap: &mic::Tap, gate: &Gate) {
    let voice = app.state::<Voice>();
    let dir = model.dir(&models_dir(app));
    let mut resampler = audio::StreamResampler::new(tap.rate, audio::STT_RATE);
    let mut read = 0;
    let mut speech = Vec::new();
    let mut last_pass: Option<Instant> = None;
    let mut last_sent = String::new();
    // Load now, so the first pass doesn't wait for it.
    {
        let mut slot = lock(&voice.stt);
        if !gate.is_open() {
            return;
        }
        let loaded = slot
            .get_or_load(model.id, Instant::now(), || stt::load(model, &dir))
            .is_ok();
        slot.touch(Instant::now());
        if !loaded {
            return;
        }
    }
    ensure_janitor(app);
    while gate.is_open() {
        std::thread::sleep(partial::TICK);
        let new = tap.copy_from(read);
        read += new.len();
        resampler.push(&new, &mut speech);
        let audio = Duration::from_secs_f64(speech.len() as f64 / audio::STT_RATE as f64);
        if !partial::due(audio, last_pass.map(|t| t.elapsed()))
            || !audio::has_speech(&speech, audio::STT_RATE)
        {
            continue;
        }
        let text = {
            let mut slot = lock(&voice.stt);
            if !gate.is_open() {
                return;
            }
            let result = slot
                .get_or_load(model.id, Instant::now(), || stt::load(model, &dir))
                .map(|recognizer| stt::transcribe(recognizer, &speech));
            slot.touch(Instant::now());
            result
        };
        ensure_janitor(app);
        last_pass = Some(Instant::now());
        let Ok(text) = text else { return };
        if partial::should_emit(&text, &last_sent) {
            gate.send_if_open(|| {
                emit_ui(app, json!({ "kind": "talk_partial", "text": text }));
            });
            last_sent = text;
        }
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
            lock(&voice.tts).unload(id);
        }
        // Not in the voice table (see `recall`).
        Kind::Embed => {}
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

/// `speak`: replaces anything playing with `text`, in the voice from settings. With `append`,
/// `text` is read after whatever is playing or queued instead (the <say> blocks of one reply),
/// or straight away if nothing is.
pub fn speak(app: &AppHandle, text: String, append: bool) {
    // Every text goes through here, <say> blocks and stripped replies alike, for either voice.
    let text = speech_text::to_speech(text.trim());
    let voice = app.state::<Voice>();
    if append {
        if text.is_empty() {
            return;
        }
        if let Some(current) = lock(&voice.speaking).as_mut() {
            current.queue.push_back(text);
            return;
        }
    }
    if text.is_empty() {
        stop_speaking(app);
        return;
    }
    let stop = Arc::new(AtomicBool::new(false));
    let id = voice.next_id.fetch_add(1, Ordering::Relaxed);
    if let Some(old) = lock(&voice.speaking).replace(Speaking {
        id,
        stop: Arc::clone(&stop),
        queue: VecDeque::new(),
    }) {
        old.stop.store(true, Ordering::SeqCst);
    }
    let settings = app.state::<Store>().get().voice;
    let app = app.clone();
    let spawned = std::thread::Builder::new()
        .name("winku-speech".into())
        .spawn(move || {
            let mut text = text;
            let mut first = true;
            loop {
                let started = first;
                first = false;
                let on_start = || {
                    if started && !stop.load(Ordering::SeqCst) {
                        emit_ui(&app, json!({ "kind": "speech", "playing": true }));
                    }
                };
                let next = || next_queued(&app, id);
                let neural = models::find("supertonic").expect("supertonic is in the table");
                let result = if settings.tts == "supertonic" && neural.installed(&models_dir(&app))
                {
                    speak_neural(&app, neural, &settings, &text, next, &stop, on_start)
                } else {
                    if settings.tts == "supertonic" {
                        // Not downloaded yet: fetch it for next time, and use the OS voice now.
                        ensure_download(&app, neural);
                    }
                    speak_os(
                        &text,
                        settings.os_voice.as_deref(),
                        settings.output_device.as_deref(),
                        next,
                        &stop,
                        on_start,
                    )
                };
                if let Err(e) = result {
                    if !stop.load(Ordering::SeqCst) {
                        voice_error(&app, &e);
                    }
                }
                // Something may have been appended while the last audio played out.
                let voice = app.state::<Voice>();
                let mut speaking = lock(&voice.speaking);
                match speaking.as_mut() {
                    Some(current) if current.id == id => match current.queue.pop_front() {
                        Some(more) if !stop.load(Ordering::SeqCst) => text = more,
                        _ => {
                            *speaking = None;
                            emit_ui(&app, json!({ "kind": "speech", "playing": false }));
                            break;
                        }
                    },
                    _ => break,
                }
            }
        });
    if let Err(e) = spawned {
        eprintln!("winku: couldn't start speech: {e}");
    }
}

/// The next appended text for speech `id`, if it is still the one playing.
fn next_queued(app: &AppHandle, id: u64) -> Option<String> {
    let voice = app.state::<Voice>();
    let mut speaking = lock(&voice.speaking);
    speaking
        .as_mut()
        .filter(|current| current.id == id)
        .and_then(|current| current.queue.pop_front())
}

/// Reads `text`, then whatever `next` hands out, through one audio stream so there is no gap.
fn speak_neural(
    app: &AppHandle,
    model: &'static Model,
    settings: &crate::settings::Voice,
    text: &str,
    mut next: impl FnMut() -> Option<String>,
    stop: &Arc<AtomicBool>,
    on_start: impl FnOnce() + Send,
) -> Result<(), String> {
    let voice = app.state::<Voice>();
    let (reading, output) = (settings.reading(), settings.output_device.as_deref());
    let dir = model.dir(&models_dir(app));
    let mut slot = lock(&voice.tts);
    let result = slot
        .get_or_load(model.id, Instant::now(), || {
            tts::load_supertonic(model, &dir)
        })
        .and_then(|engine| {
            let feed = tts::Feed::new(tts::engine_rate(engine));
            std::thread::scope(|s| {
                let player = s.spawn(|| tts::play(output, &feed, stop, on_start));
                let mut utterance = tts::Utterance::default();
                tts::supertonic_speak(engine, text, reading, &mut utterance, &feed, stop);
                while !stop.load(Ordering::SeqCst) {
                    let Some(more) = next() else { break };
                    tts::supertonic_speak(engine, &more, reading, &mut utterance, &feed, stop);
                }
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

/// The OS voice, one text at a time.
fn speak_os(
    text: &str,
    os_voice: Option<&str>,
    output: Option<&str>,
    mut next: impl FnMut() -> Option<String>,
    stop: &AtomicBool,
    on_start: impl FnOnce(),
) -> Result<(), String> {
    tts::os_speak(text, os_voice, output, stop, on_start)?;
    while !stop.load(Ordering::SeqCst) {
        let Some(more) = next() else { break };
        tts::os_speak(&more, os_voice, output, stop, || {})?;
    }
    Ok(())
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
        match self.tts.try_lock() {
            Ok(mut slot) => {
                if slot.unload_if_idle(now) {
                    eprintln!("winku: reading voice unloaded after idling");
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
    /// moonshine-base and Supertonic into that folder (through `download::install`), has
    /// Supertonic read sentences with numbers, pushes them through the playback resampler (the
    /// path `tts::play` uses, at 48 kHz in awkward chunks), writes WAVs next to the models and
    /// transcribes them with Moonshine, whole and in the growing passes live transcription makes.
    #[test]
    #[ignore]
    fn supertonic_speech_round_trips_through_moonshine() {
        let Some(dir) = std::env::var_os("WINKU_VOICE_E2E").map(PathBuf::from) else {
            eprintln!("WINKU_VOICE_E2E not set; skipping");
            return;
        };
        std::fs::create_dir_all(&dir).unwrap();
        for id in ["moonshine-base", "supertonic"] {
            let model = models::find(id).unwrap();
            if !model.installed(&dir) {
                let started = Instant::now();
                download::install(model, &dir, &download::Https, &mut |_| {}).unwrap();
                eprintln!("installed {id} in {:.1}s", started.elapsed().as_secs_f32());
            }
        }
        let neural = models::find("supertonic").unwrap();
        let engine = tts::load_supertonic(neural, &neural.dir(&dir)).unwrap();
        let moonshine = models::find("moonshine-base").unwrap();
        let recognizer = stt::load(moonshine, &moonshine.dir(&dir)).unwrap();
        let stop = AtomicBool::new(false);
        let sentence = "Here are three things: first, 12 apples at $4.50 each. Second, a 15% discount. Third, delivery by 9:30 on March 3rd.";
        let feed = tts::Feed::new(tts::engine_rate(&engine));
        let started = Instant::now();
        let mut utterance = tts::Utterance::default();
        tts::supertonic_speak(
            &engine,
            sentence,
            tts::Reading::default(),
            &mut utterance,
            &feed,
            &stop,
        );
        let spoken = feed.take_all();
        let secs = spoken.len() as f32 / feed.rate as f32;
        eprintln!(
            "supertonic: {secs:.1}s of audio at {} Hz in {:.1}s",
            feed.rate,
            started.elapsed().as_secs_f32()
        );
        // The playback path: stream-resample to the device rate in uneven chunks.
        let mut resampler = audio::StreamResampler::new(feed.rate, 48_000);
        let mut played = Vec::new();
        for chunk in spoken.chunks(1021) {
            resampler.push(chunk, &mut played);
        }
        let peak = played.iter().fold(0f32, |m, s| m.max(s.abs()));
        let jump = played
            .windows(2)
            .fold(0f32, |m, w| m.max((w[1] - w[0]).abs()));
        eprintln!(
            "played: {} samples at 48000 Hz, peak {peak:.2}, largest step {jump:.3}",
            played.len()
        );
        assert!(peak > 0.05 && peak <= 1.0);
        let out = dir.join("playback-48k.wav");
        write_wav(&out, &played, 48_000);
        eprintln!("wrote {}", out.display());

        let samples = audio::resample(&played, 48_000, audio::STT_RATE);
        let text = stt::transcribe(&recognizer, &samples);
        eprintln!("transcript: {text:?}");
        let lower = text.to_lowercase();
        assert!(lower.contains("12 apples"), "{text}");
        assert!(lower.contains("15%"), "{text}");
        assert!(lower.contains("march"), "{text}");

        // Live transcription: passes over the growing recording, as `send_partials` makes them.
        let step = audio::STT_RATE as usize / 2;
        let mut last_sent = String::new();
        let mut sent = Vec::new();
        for end in (step..=samples.len()).step_by(step) {
            let prefix = &samples[..end];
            let audio = Duration::from_secs_f64(end as f64 / audio::STT_RATE as f64);
            if !partial::due(audio, None) || !audio::has_speech(prefix, audio::STT_RATE) {
                continue;
            }
            let started = Instant::now();
            let partial = stt::transcribe(&recognizer, prefix);
            eprintln!(
                "partial at {:.1}s ({:.2}s): {partial:?}",
                audio.as_secs_f32(),
                started.elapsed().as_secs_f32()
            );
            if partial::should_emit(&partial, &last_sent) {
                sent.push(partial.clone());
                last_sent = partial;
            }
        }
        assert!(sent.len() >= 3, "{sent:?}");
        assert!(sent[0].to_lowercase().contains("here"), "{sent:?}");
    }

    /// A 16-bit mono WAV of `samples`.
    fn write_wav(path: &std::path::Path, samples: &[f32], rate: u32) {
        let pcm: Vec<u8> = samples
            .iter()
            .flat_map(|s| ((s.clamp(-1.0, 1.0) * 32767.0) as i16).to_le_bytes())
            .collect();
        let mut wav = b"RIFF".to_vec();
        wav.extend((36 + pcm.len() as u32).to_le_bytes());
        wav.extend(b"WAVEfmt ");
        wav.extend([16, 0, 0, 0, 1, 0, 1, 0]);
        wav.extend(rate.to_le_bytes());
        wav.extend((rate * 2).to_le_bytes());
        wav.extend([2, 0, 16, 0]);
        wav.extend(b"data");
        wav.extend((pcm.len() as u32).to_le_bytes());
        wav.extend(pcm);
        std::fs::write(path, wav).unwrap();
    }

    /// Lowercase words, for a rough "how much of it was said" score.
    fn words(text: &str) -> Vec<String> {
        text.to_lowercase()
            .split(|c: char| !c.is_alphanumeric() && c != '\'')
            .filter(|w| !w.is_empty())
            .map(str::to_string)
            .collect()
    }

    /// The share of `expected` words that `heard` contains (each heard word counts once).
    fn recall(expected: &str, heard: &str) -> f32 {
        let expected = words(expected);
        let mut heard = words(heard);
        let found = expected
            .iter()
            .filter(|w| {
                heard
                    .iter()
                    .position(|h| h == *w)
                    .map(|i| heard.remove(i))
                    .is_some()
            })
            .count();
        found as f32 / expected.len().max(1) as f32
    }

    /// Tricky sentences for listening, not asserted on. Run with
    /// `WINKU_VOICE_E2E=/some/dir cargo test --release tricky -- --ignored --nocapture`:
    /// downloads both Supertonic models and Whisper base.en into that folder, reads each sentence
    /// through the same path `speak` uses (`to_speech`, then Supertonic with the default
    /// settings), writes `tricky/<model>/NN.wav`, transcribes each with Whisper and writes
    /// `tricky/report.txt` with what was meant, what Whisper heard and a rough word recall.
    #[test]
    #[ignore]
    fn tricky_sentences_for_listening() {
        const SENTENCES: &[&str] = &[
            "Yes.",
            "I can do that.",
            "Sure. The guide is at https://tauri.app/start/prerequisites/ if you want it.",
            r"I saved it to C:\Users\me\Documents\report-final.pdf.",
            "Winku 0.1.7 fixes it; you had v0.1.6 before.",
            "The meeting moved from 2026-03-02 to 11/15/2026.",
            "If x = 5 and y = x + 2, then y is 7.",
            "Sales rose 15% -> 20% & costs fell.",
            "Done! I renamed **three** files in `~/projects/winku/src` 🎉",
            "Here are three things: first, 12 apples at $4.50 each. Second, a 15% discount. Third, delivery by 9:30 on March 3rd. That should cover the whole order, and I can add more later if you need it.",
        ];
        let Some(dir) = std::env::var_os("WINKU_VOICE_E2E").map(PathBuf::from) else {
            eprintln!("WINKU_VOICE_E2E not set; skipping");
            return;
        };
        std::fs::create_dir_all(&dir).unwrap();
        for id in ["whisper-base-en", "supertonic", "supertonic-3"] {
            let model = models::find(id).unwrap();
            if !model.installed(&dir) {
                download::install(model, &dir, &download::Https, &mut |_| {}).unwrap();
            }
        }
        let whisper = models::find("whisper-base-en").unwrap();
        let recognizer = stt::load(whisper, &whisper.dir(&dir)).unwrap();
        let mut report = String::new();
        for id in ["supertonic", "supertonic-3"] {
            let model = models::find(id).unwrap();
            let engine = tts::load_supertonic(model, &model.dir(&dir)).unwrap();
            let out = dir.join("tricky").join(id);
            std::fs::create_dir_all(&out).unwrap();
            let (mut total, mut audio_secs, mut synth_secs) = (0.0, 0.0, 0.0);
            report += &format!("== {} ==\n", model.name);
            for (n, sentence) in SENTENCES.iter().enumerate() {
                let said = speech_text::to_speech(sentence);
                let feed = tts::Feed::new(tts::engine_rate(&engine));
                let started = Instant::now();
                let mut utterance = tts::Utterance::default();
                let stop = AtomicBool::new(false);
                tts::supertonic_speak(
                    &engine,
                    &said,
                    tts::Reading::default(),
                    &mut utterance,
                    &feed,
                    &stop,
                );
                synth_secs += started.elapsed().as_secs_f32();
                let samples = feed.take_all();
                audio_secs += samples.len() as f32 / feed.rate as f32;
                write_wav(&out.join(format!("{n:02}.wav")), &samples, feed.rate);
                let heard = stt::transcribe(
                    &recognizer,
                    &audio::resample(&samples, feed.rate, audio::STT_RATE),
                );
                let score = recall(&said, &heard);
                total += score;
                report += &format!(
                    "{n:02} {:>3.0}%  in:    {sentence}\n      said:  {said}\n      heard: {}\n",
                    score * 100.0,
                    heard.trim()
                );
            }
            report += &format!(
                "average recall {:.0}%, real-time factor {:.3}\n\n",
                total / SENTENCES.len() as f32 * 100.0,
                synth_secs / audio_secs.max(0.001)
            );
        }
        std::fs::write(dir.join("tricky").join("report.txt"), &report).unwrap();
        eprintln!("{report}");
    }
}
