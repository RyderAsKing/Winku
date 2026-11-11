//! Speech-to-text with the sherpa-onnx offline recogniser, plus the load-on-first-use,
//! unload-when-idle slot that STT and the reading voice share.

use std::path::Path;
use std::time::{Duration, Instant};

use sherpa_onnx::{
    OfflineMoonshineModelConfig, OfflineRecognizer, OfflineRecognizerConfig,
    OfflineTransducerModelConfig, OfflineWhisperModelConfig,
};

use super::audio::STT_RATE;
use super::models::{Model, Recipe};

/// A loaded model is dropped after this long without use (SPEC §11).
pub const IDLE_UNLOAD: Duration = Duration::from_secs(3 * 60);

/// One loaded model, by id, with when it was last used. Pure timing: callers pass the time.
pub struct Slot<T> {
    loaded: Option<(String, T)>,
    last_used: Option<Instant>,
}

impl<T> Default for Slot<T> {
    fn default() -> Self {
        Self {
            loaded: None,
            last_used: None,
        }
    }
}

impl<T> Slot<T> {
    /// The model `id`, loading it (and dropping any other) first if needed.
    pub fn get_or_load(
        &mut self,
        id: &str,
        now: Instant,
        load: impl FnOnce() -> Result<T, String>,
    ) -> Result<&T, String> {
        if self.loaded.as_ref().is_none_or(|(loaded, _)| loaded != id) {
            self.loaded = None; // free the old one before loading the new
            self.loaded = Some((id.to_string(), load()?));
        }
        self.last_used = Some(now);
        Ok(&self.loaded.as_ref().expect("just loaded").1)
    }

    /// Marks the model as used at `now` (call again when a long job finishes).
    pub fn touch(&mut self, now: Instant) {
        if self.loaded.is_some() {
            self.last_used = Some(now);
        }
    }

    pub fn is_loaded(&self) -> bool {
        self.loaded.is_some()
    }

    /// Drops the model if it has been idle for `IDLE_UNLOAD`. True if it was dropped.
    pub fn unload_if_idle(&mut self, now: Instant) -> bool {
        let idle = self
            .last_used
            .is_some_and(|used| now.saturating_duration_since(used) >= IDLE_UNLOAD);
        if self.loaded.is_some() && idle {
            self.loaded = None;
            self.last_used = None;
            return true;
        }
        false
    }

    /// Drops the model now (e.g. its files are being removed).
    pub fn unload(&mut self, id: &str) {
        if self.loaded.as_ref().is_some_and(|(loaded, _)| loaded == id) {
            self.loaded = None;
            self.last_used = None;
        }
    }
}

pub fn threads() -> i32 {
    std::thread::available_parallelism()
        .map(|n| n.get().clamp(1, 4) as i32)
        .unwrap_or(2)
}

fn path(dir: &Path, file: &str) -> Option<String> {
    Some(dir.join(file).to_string_lossy().into_owned())
}

/// Loads an STT model from its folder.
pub fn load(model: &Model, dir: &Path) -> Result<OfflineRecognizer, String> {
    let mut config = OfflineRecognizerConfig::default();
    config.feat_config.sample_rate = STT_RATE as i32;
    let mc = &mut config.model_config;
    match model.recipe {
        Recipe::Moonshine {
            encoder,
            merged_decoder,
            tokens,
        } => {
            mc.moonshine = OfflineMoonshineModelConfig {
                encoder: path(dir, encoder),
                merged_decoder: path(dir, merged_decoder),
                ..Default::default()
            };
            mc.tokens = path(dir, tokens);
        }
        Recipe::Whisper {
            encoder,
            decoder,
            tokens,
        } => {
            mc.whisper = OfflineWhisperModelConfig {
                encoder: path(dir, encoder),
                decoder: path(dir, decoder),
                language: Some("en".into()),
                task: Some("transcribe".into()),
                ..Default::default()
            };
            mc.tokens = path(dir, tokens);
        }
        Recipe::Transducer {
            encoder,
            decoder,
            joiner,
            tokens,
        } => {
            mc.transducer = OfflineTransducerModelConfig {
                encoder: path(dir, encoder),
                decoder: path(dir, decoder),
                joiner: path(dir, joiner),
            };
            mc.tokens = path(dir, tokens);
        }
        Recipe::Supertonic { .. } => {
            return Err(format!("{} is not a speech-to-text model", model.id))
        }
    }
    mc.num_threads = threads();
    mc.provider = Some("cpu".into());
    OfflineRecognizer::create(&config).ok_or_else(|| {
        format!(
            "{} couldn't be loaded; try removing and downloading it again",
            model.name
        )
    })
}

/// Transcribes 16 kHz mono audio.
pub fn transcribe(recognizer: &OfflineRecognizer, samples: &[f32]) -> String {
    let stream = recognizer.create_stream();
    stream.accept_waveform(STT_RATE as i32, samples);
    recognizer.decode(&stream);
    stream
        .get_result()
        .map(|r| r.text.trim().to_string())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loads_once_and_unloads_after_three_idle_minutes() {
        let t0 = Instant::now();
        let mut slot: Slot<u32> = Slot::default();
        let mut loads = 0;
        assert!(!slot.unload_if_idle(t0), "nothing loaded");
        let mut load = |v| {
            loads += 1;
            Ok(v)
        };
        assert_eq!(*slot.get_or_load("a", t0, || load(1)).unwrap(), 1);
        let t1 = t0 + Duration::from_secs(100);
        assert_eq!(*slot.get_or_load("a", t1, || load(2)).unwrap(), 1, "cached");
        assert_eq!(loads, 1);
        assert!(!slot.unload_if_idle(t1 + IDLE_UNLOAD - Duration::from_secs(1)));
        assert!(slot.is_loaded());
        assert!(slot.unload_if_idle(t1 + IDLE_UNLOAD));
        assert!(!slot.is_loaded());
        assert!(!slot.unload_if_idle(t1 + IDLE_UNLOAD * 2));
    }

    #[test]
    fn touch_extends_and_switching_models_reloads() {
        let t0 = Instant::now();
        let mut slot: Slot<&str> = Slot::default();
        slot.get_or_load("a", t0, || Ok("A")).unwrap();
        slot.touch(t0 + Duration::from_secs(170));
        assert!(
            !slot.unload_if_idle(t0 + IDLE_UNLOAD),
            "a long job kept it busy"
        );
        assert_eq!(*slot.get_or_load("b", t0, || Ok("B")).unwrap(), "B");
        slot.unload("a");
        assert!(slot.is_loaded(), "only unloads the named model");
        slot.unload("b");
        assert!(!slot.is_loaded());
        assert!(slot
            .get_or_load("c", t0, || Err("broken".to_string()))
            .is_err());
        assert!(!slot.is_loaded());
    }
}
