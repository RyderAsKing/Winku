//! Text-to-speech: Windows OneCore voices (WinRT `SpeechSynthesizer`) or Kokoro through
//! sherpa-onnx, both played with cpal. Elsewhere the "os" voice is `spd-say` when present.

use std::collections::VecDeque;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, Sample, SampleFormat, SizedSample};
use serde::Serialize;
use sherpa_onnx::{GenerationConfig, OfflineTts, OfflineTtsConfig, OfflineTtsKokoroModelConfig};

use super::audio::StreamResampler;
use super::models::{Model, Recipe};

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct OsVoice {
    pub id: String,
    pub name: String,
    pub language: String,
}

/// Audio handed from a synthesiser to the player, at the synthesiser's rate.
pub struct Feed {
    pub rate: u32,
    queue: Mutex<VecDeque<f32>>,
    finished: AtomicBool,
}

impl Feed {
    pub fn new(rate: u32) -> Arc<Self> {
        Arc::new(Self {
            rate,
            queue: Mutex::new(VecDeque::new()),
            finished: AtomicBool::new(false),
        })
    }

    pub fn push(&self, samples: &[f32]) {
        self.queue
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .extend(samples.iter().copied());
    }

    /// No more audio is coming.
    pub fn finish(&self) {
        self.finished.store(true, Ordering::SeqCst);
    }

    /// Everything queued so far (tests).
    #[cfg(test)]
    pub fn take_all(&self) -> Vec<f32> {
        self.take()
    }

    fn take(&self) -> Vec<f32> {
        self.queue
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .drain(..)
            .collect()
    }
}

/// Plays `feed` on the default output device until it is finished and drained, or `stop` is set.
/// `on_start` runs when the first audio reaches the device. Blocks the calling thread.
pub fn play(feed: &Feed, stop: &AtomicBool, on_start: impl FnOnce()) -> Result<(), String> {
    let host = cpal::default_host();
    let device = host
        .default_output_device()
        .ok_or("No speakers or headphones found")?;
    let supported = device
        .default_output_config()
        .map_err(|e| format!("Couldn't use the speakers: {e}"))?;
    let config = supported.config();
    let channels = config.channels as usize;
    let device_rate = config.sample_rate;
    let out: Arc<Mutex<VecDeque<f32>>> = Arc::new(Mutex::new(VecDeque::new()));
    let stream = match supported.sample_format() {
        SampleFormat::F32 => build::<f32>(&device, config, channels, &out),
        SampleFormat::I16 => build::<i16>(&device, config, channels, &out),
        SampleFormat::U16 => build::<u16>(&device, config, channels, &out),
        SampleFormat::I32 => build::<i32>(&device, config, channels, &out),
        other => Err(format!("unsupported output format {other}")),
    }?;
    stream
        .play()
        .map_err(|e| format!("Couldn't use the speakers: {e}"))?;

    let mut resampler = StreamResampler::new(feed.rate, device_rate);
    let mut on_start = Some(on_start);
    let mut buf = Vec::new();
    loop {
        if stop.load(Ordering::SeqCst) {
            break;
        }
        // Read `finished` before draining, so nothing pushed after the drain is missed.
        let finished = feed.finished.load(Ordering::SeqCst);
        let chunk = feed.take();
        if !chunk.is_empty() {
            buf.clear();
            resampler.push(&chunk, &mut buf);
            out.lock()
                .unwrap_or_else(|e| e.into_inner())
                .extend(buf.iter().copied());
            if let Some(start) = on_start.take() {
                start();
            }
        }
        let empty = out.lock().unwrap_or_else(|e| e.into_inner()).is_empty();
        if finished && empty {
            // Let the device play out its own buffer.
            std::thread::sleep(Duration::from_millis(150));
            break;
        }
        std::thread::sleep(Duration::from_millis(15));
    }
    drop(stream);
    Ok(())
}

fn build<T>(
    device: &cpal::Device,
    config: cpal::StreamConfig,
    channels: usize,
    out: &Arc<Mutex<VecDeque<f32>>>,
) -> Result<cpal::Stream, String>
where
    T: SizedSample + FromSample<f32>,
{
    let out = Arc::clone(out);
    device
        .build_output_stream::<T, _, _>(
            config,
            move |data: &mut [T], _| {
                let mut queue = out.lock().unwrap_or_else(|e| e.into_inner());
                for frame in data.chunks_mut(channels.max(1)) {
                    let sample = queue.pop_front().unwrap_or(0.0).to_sample::<T>();
                    frame.fill(sample);
                }
            },
            |e| eprintln!("winku: speaker stream error: {e}"),
            None,
        )
        .map_err(|e| format!("Couldn't use the speakers: {e}"))
}

// ───────────────────────────── Kokoro ─────────────────────────────

pub fn load_kokoro(model: &Model, dir: &Path) -> Result<OfflineTts, String> {
    let Recipe::Kokoro {
        model: onnx,
        voices,
        tokens,
        lexicon,
    } = model.recipe
    else {
        return Err(format!("{} is not a text-to-speech model", model.id));
    };
    let path = |f: &str| Some(dir.join(f).to_string_lossy().into_owned());
    let mut config = OfflineTtsConfig::default();
    config.model.kokoro = OfflineTtsKokoroModelConfig {
        model: path(onnx),
        voices: path(voices),
        tokens: path(tokens),
        lexicon: path(lexicon),
        ..Default::default()
    };
    config.model.num_threads = super::stt::threads();
    config.model.provider = Some("cpu".into());
    config.max_num_sentences = 1;
    OfflineTts::create(&config).ok_or_else(|| {
        format!(
            "{} couldn't be loaded; try removing and downloading it again",
            model.name
        )
    })
}

/// Synthesises `text` into `feed` sentence by sentence, stopping early when `stop` is set.
pub fn kokoro_speak(tts: &OfflineTts, text: &str, feed: &Arc<Feed>, stop: &Arc<AtomicBool>) {
    let config = GenerationConfig {
        sid: 0,
        speed: 1.0,
        ..Default::default()
    };
    let streamed = Arc::new(AtomicBool::new(false));
    let (cb_feed, cb_stop, cb_streamed) =
        (Arc::clone(feed), Arc::clone(stop), Arc::clone(&streamed));
    let audio = tts.generate_with_config(
        text,
        &config,
        Some(move |samples: &[f32], _progress: f32| {
            if !samples.is_empty() {
                cb_feed.push(samples);
                cb_streamed.store(true, Ordering::SeqCst);
            }
            !cb_stop.load(Ordering::SeqCst)
        }),
    );
    if !streamed.load(Ordering::SeqCst) && !stop.load(Ordering::SeqCst) {
        if let Some(audio) = audio {
            feed.push(audio.samples());
        }
    }
}

/// Kokoro's output rate, for the feed.
pub fn kokoro_rate(tts: &OfflineTts) -> u32 {
    tts.sample_rate().max(1) as u32
}

// ───────────────────────────── OS voices ─────────────────────────────

#[cfg(windows)]
mod os {
    use super::OsVoice;
    use windows::core::HSTRING;
    use windows::Media::SpeechSynthesis::{SpeechSynthesizer, VoiceInformation};
    use windows::Storage::Streams::DataReader;

    fn all() -> windows::core::Result<Vec<VoiceInformation>> {
        let voices = SpeechSynthesizer::AllVoices()?;
        (0..voices.Size()?).map(|i| voices.GetAt(i)).collect()
    }

    pub fn voices() -> Result<Vec<OsVoice>, String> {
        let list = all().map_err(|e| e.message().to_string())?;
        Ok(list
            .iter()
            .filter_map(|v| {
                Some(OsVoice {
                    id: v.Id().ok()?.to_string(),
                    name: v.DisplayName().ok()?.to_string(),
                    language: v.Language().ok()?.to_string(),
                })
            })
            .collect())
    }

    /// A WAV file of `text` in the chosen voice (or the system default).
    pub fn synthesize(text: &str, voice: Option<&str>) -> Result<Vec<u8>, String> {
        let run = || -> windows::core::Result<Vec<u8>> {
            let synth = SpeechSynthesizer::new()?;
            if let Some(id) = voice {
                if let Some(v) = all()?
                    .into_iter()
                    .find(|v| v.Id().is_ok_and(|vid| vid == id))
                {
                    synth.SetVoice(&v)?;
                }
            }
            let stream = synth
                .SynthesizeTextToStreamAsync(&HSTRING::from(text))?
                .join()?;
            let size = u32::try_from(stream.Size()?).unwrap_or(u32::MAX);
            let reader = DataReader::CreateDataReader(&stream.GetInputStreamAt(0)?)?;
            let loaded = reader.LoadAsync(size)?.join()?;
            let mut bytes = vec![0u8; loaded as usize];
            reader.ReadBytes(&mut bytes)?;
            Ok(bytes)
        };
        run().map_err(|e| format!("The Windows voice failed: {}", e.message()))
    }
}

#[cfg(not(windows))]
mod os {
    use super::OsVoice;

    pub fn voices() -> Result<Vec<OsVoice>, String> {
        Ok(Vec::new())
    }
}

pub fn os_voices() -> Vec<OsVoice> {
    os::voices().unwrap_or_else(|e| {
        eprintln!("winku: listing OS voices failed: {e}");
        Vec::new()
    })
}

/// Speaks `text` with the OS voice, blocking until it ends or `stop` is set.
#[cfg(windows)]
pub fn os_speak(
    text: &str,
    voice: Option<&str>,
    stop: &AtomicBool,
    on_start: impl FnOnce(),
) -> Result<(), String> {
    let wav = super::audio::parse_wav(&os::synthesize(text, voice)?)?;
    if stop.load(Ordering::SeqCst) {
        return Ok(());
    }
    let feed = Feed::new(wav.rate);
    feed.push(&wav.samples);
    feed.finish();
    play(&feed, stop, on_start)
}

/// Speaks `text` with `spd-say` (speech-dispatcher), blocking until it ends or `stop` is set.
#[cfg(not(windows))]
pub fn os_speak(
    text: &str,
    _voice: Option<&str>,
    stop: &AtomicBool,
    on_start: impl FnOnce(),
) -> Result<(), String> {
    use std::process::{Command, Stdio};
    const UNAVAILABLE: &str = "Speech isn't available on this platform yet";
    // A leading dash would be read as an option.
    let text = format!(" {}", text.trim());
    let mut child = Command::new("spd-say")
        .arg("--wait")
        .arg(&text)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| UNAVAILABLE.to_string())?;
    on_start();
    loop {
        if stop.load(Ordering::SeqCst) {
            let _ = child.kill();
            let _ = Command::new("spd-say")
                .arg("--cancel")
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
            let _ = child.wait();
            return Ok(());
        }
        match child.try_wait() {
            Ok(Some(_)) => return Ok(()),
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(e) => return Err(format!("spd-say failed: {e}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn feed_hands_over_everything_once() {
        let feed = Feed::new(24_000);
        feed.push(&[0.1, 0.2]);
        feed.push(&[0.3]);
        assert_eq!(feed.take(), vec![0.1, 0.2, 0.3]);
        assert!(feed.take().is_empty());
        assert!(!feed.finished.load(Ordering::SeqCst));
        feed.finish();
        assert!(feed.finished.load(Ordering::SeqCst));
    }
}
