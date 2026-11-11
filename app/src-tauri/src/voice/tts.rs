//! Text-to-speech: Supertonic through sherpa-onnx (the default) or Windows OneCore voices (WinRT
//! `SpeechSynthesizer`, the fallback), both played with cpal. Elsewhere the "os" voice is `spd-say` when present.

use std::collections::VecDeque;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, Sample, SampleFormat, SizedSample};
use serde::Serialize;
use sherpa_onnx::{
    GenerationConfig, OfflineTts, OfflineTtsConfig, OfflineTtsSupertonicModelConfig,
};

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
        if !chunk.is_empty() || finished {
            buf.clear();
            resampler.push(&chunk, &mut buf);
            if finished {
                resampler.finish(&mut buf); // the last few samples the filter held back
            }
            out.lock()
                .unwrap_or_else(|e| e.into_inner())
                .extend(buf.iter().copied());
            if !buf.is_empty() {
                if let Some(start) = on_start.take() {
                    start();
                }
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

// ───────────────────────────── Supertonic ─────────────────────────────

/// Supertonic ships ten voices: 0-4 are male, 5-9 female.
pub const VOICES: u8 = 10;
pub const DEFAULT_VOICE: u8 = 5;

pub fn load_supertonic(model: &Model, dir: &Path) -> Result<OfflineTts, String> {
    let Recipe::Supertonic {
        duration_predictor,
        text_encoder,
        vector_estimator,
        vocoder,
        tts_json,
        unicode_indexer,
        voice_style,
    } = model.recipe
    else {
        return Err(format!("{} is not a text-to-speech model", model.id));
    };
    let path = |f: &str| Some(dir.join(f).to_string_lossy().into_owned());
    let mut config = OfflineTtsConfig::default();
    config.model.supertonic = OfflineTtsSupertonicModelConfig {
        duration_predictor: path(duration_predictor),
        text_encoder: path(text_encoder),
        vector_estimator: path(vector_estimator),
        vocoder: path(vocoder),
        tts_json: path(tts_json),
        unicode_indexer: path(unicode_indexer),
        voice_style: path(voice_style),
    };
    config.model.num_threads = super::stt::threads();
    config.model.provider = Some("cpu".into());
    OfflineTts::create(&config).ok_or_else(|| {
        format!(
            "{} couldn't be loaded; try removing and downloading it again",
            model.name
        )
    })
}

/// Synthesises `text` into `feed` one sentence at a time (so the first one starts playing while
/// the rest are still being made), stopping early when `stop` is set.
pub fn supertonic_speak(
    tts: &OfflineTts,
    text: &str,
    voice: u8,
    feed: &Arc<Feed>,
    stop: &AtomicBool,
) {
    let config = GenerationConfig {
        sid: i32::from(voice.min(VOICES - 1)),
        speed: 1.0,
        ..Default::default()
    };
    for piece in split_sentences(text) {
        if stop.load(Ordering::SeqCst) {
            return;
        }
        if let Some(audio) =
            tts.generate_with_config(&piece, &config, None::<fn(&[f32], f32) -> bool>)
        {
            if !stop.load(Ordering::SeqCst) {
                let mut samples = audio.samples().to_vec();
                make_up_gain(&mut samples);
                feed.push(&samples);
            }
        }
    }
}

/// Supertonic's output is quiet (about -28 dBFS RMS, peaks near 0.4), so people turn the volume
/// up and then get blasted by the next notification. Lifts a sentence towards -22 dBFS RMS, by at
/// most 3x and never past a 0.95 peak.
fn make_up_gain(samples: &mut [f32]) {
    const TARGET_RMS: f32 = 0.08;
    let rms = super::audio::rms(samples);
    let peak = samples.iter().fold(0.0f32, |m, s| m.max(s.abs()));
    if rms < 1e-4 || peak <= 0.0 {
        return;
    }
    let gain = (TARGET_RMS / rms).clamp(1.0, 3.0).min(0.95 / peak).max(0.0);
    if gain > 1.0 {
        samples.iter_mut().for_each(|s| *s *= gain);
    }
}

/// The synthesiser's output rate, for the feed.
pub fn engine_rate(tts: &OfflineTts) -> u32 {
    tts.sample_rate().max(1) as u32
}

/// Words that end in a period without ending the sentence.
const ABBREVIATIONS: &[&str] = &[
    "mr", "mrs", "ms", "dr", "prof", "sr", "jr", "st", "vs", "etc", "e.g", "i.e", "approx", "no",
    "fig", "inc", "ltd", "co",
];
/// A piece shorter than this is joined to the next, so "Yes." isn't synthesised on its own.
const MIN_PIECE: usize = 24;
/// A piece longer than this is cut at a comma or semicolon.
const MAX_PIECE: usize = 280;

/// Cuts `text` into sentence-sized pieces for synthesis: at newlines and after `.`, `!` or `?`
/// followed by a space (not after "3.5", "e.g." or "Dr."), with short pieces merged forward and
/// very long ones cut at clause breaks.
pub fn split_sentences(text: &str) -> Vec<String> {
    let mut sentences: Vec<String> = Vec::new();
    for line in text.lines() {
        let chars: Vec<char> = line.trim().chars().collect();
        let mut start = 0;
        for (i, &c) in chars.iter().enumerate() {
            let boundary = matches!(c, '.' | '!' | '?')
                && chars.get(i + 1).is_none_or(|n| n.is_whitespace())
                && !(c == '.' && {
                    let word: String = chars[start..i]
                        .iter()
                        .rev()
                        .take_while(|ch| !ch.is_whitespace())
                        .collect::<Vec<_>>()
                        .into_iter()
                        .rev()
                        .collect();
                    ABBREVIATIONS.contains(&word.to_lowercase().as_str())
                });
            if boundary {
                sentences.push(chars[start..=i].iter().collect());
                start = i + 1;
            }
        }
        if start < chars.len() {
            sentences.push(chars[start..].iter().collect());
        }
    }
    let mut pieces: Vec<String> = Vec::new();
    let mut carry = String::new();
    for sentence in sentences.iter().flat_map(|s| cut_long(s.trim())) {
        if sentence.is_empty() {
            continue;
        }
        if !carry.is_empty() {
            carry.push(' ');
        }
        carry.push_str(&sentence);
        if carry.chars().count() >= MIN_PIECE {
            pieces.push(std::mem::take(&mut carry));
        }
    }
    if !carry.is_empty() {
        match pieces.last_mut() {
            Some(last) if carry.chars().count() < MIN_PIECE / 2 => {
                last.push(' ');
                last.push_str(&carry);
            }
            _ => pieces.push(carry),
        }
    }
    pieces
}

fn cut_long(sentence: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = sentence.trim();
    while rest.chars().count() > MAX_PIECE {
        let limit = rest
            .char_indices()
            .nth(MAX_PIECE)
            .map_or(rest.len(), |(i, _)| i);
        let cut = rest[..limit]
            .rfind([',', ';', ':'])
            .map(|i| i + 1)
            .or_else(|| rest[..limit].rfind(' '))
            .unwrap_or(limit);
        out.push(rest[..cut].trim().to_string());
        rest = rest[cut..].trim();
    }
    out.push(rest.to_string());
    out
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
    fn quiet_sentences_are_lifted_but_never_clipped() {
        let tone =
            |amp: f32| -> Vec<f32> { (0..4_800).map(|i| amp * (i as f32 * 0.05).sin()).collect() };
        let mut quiet = tone(0.05);
        make_up_gain(&mut quiet);
        assert!((super::super::audio::rms(&quiet) - 0.08).abs() < 0.005);
        let mut barely = tone(0.01);
        make_up_gain(&mut barely);
        let peak = barely.iter().fold(0.0f32, |m, s| m.max(s.abs()));
        assert!((peak - 0.03).abs() < 0.002, "at most 3x: {peak}");
        let mut peaky = tone(0.5);
        peaky[100] = 0.9;
        make_up_gain(&mut peaky);
        assert!(peaky.iter().all(|s| s.abs() <= 0.951));
        let mut loud = tone(0.9);
        let before = loud.clone();
        make_up_gain(&mut loud);
        assert_eq!(loud, before, "loud audio is left alone");
        let mut silence = vec![0.0; 100];
        make_up_gain(&mut silence);
        assert!(silence.iter().all(|s| *s == 0.0));
    }

    #[test]
    fn sentences_split_without_breaking_numbers_or_abbreviations() {
        let t =
            "Dr. Lee paid $4.50 for 12 apples, e.g. green ones. Then she left! Was that fine? Yes.";
        assert_eq!(
            split_sentences(t),
            [
                "Dr. Lee paid $4.50 for 12 apples, e.g. green ones.",
                "Then she left! Was that fine? Yes."
            ]
        );
        assert_eq!(split_sentences("Hi."), ["Hi."]);
        assert_eq!(split_sentences("  \n "), Vec::<String>::new());
        // Lines are boundaries, so list items are read one at a time.
        assert_eq!(
            split_sentences("Three things\nfirst, the apples are ripe\nsecond, the pears are not"),
            [
                "Three things first, the apples are ripe",
                "second, the pears are not"
            ]
        );
        let long = "word, ".repeat(100);
        let pieces = split_sentences(&long);
        assert!(pieces.len() > 1);
        assert!(
            pieces.iter().all(|p| p.chars().count() <= MAX_PIECE + 8),
            "{pieces:?}"
        );
        let joined = pieces.join(" ");
        assert_eq!(joined.split_whitespace().count(), 100);
    }

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
