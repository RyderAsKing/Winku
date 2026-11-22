//! Text-to-speech: Supertonic through sherpa-onnx (the default) or the system's voices (the
//! fallback): Windows OneCore voices (WinRT `SpeechSynthesizer`) and macOS's `say`, played with
//! cpal like Supertonic. On Linux the "os" voice is `spd-say` when present.

use std::collections::VecDeque;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use cpal::traits::{DeviceTrait, StreamTrait};
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

/// Plays `feed` on the `output` device (the default when `None` or unplugged) until it is finished and drained, or `stop` is set.
/// `on_start` runs when the first audio reaches the device. Blocks the calling thread.
pub fn play(
    output: Option<&str>,
    feed: &Feed,
    stop: &AtomicBool,
    on_start: impl FnOnce(),
) -> Result<(), String> {
    let host = cpal::default_host();
    let device = super::devices::output(&host, output).ok_or("No speakers or headphones found")?;
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

/// Supertonic ships ten voices: 0-4 are female, 5-9 male (checked by pitch: 160-230 Hz vs
/// 90-130 Hz).
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

/// How Supertonic reads, from Settings > Speech.
#[derive(Clone, Copy, Debug)]
pub struct Reading {
    /// 0-4 female, 5-9 male.
    pub voice: u8,
    /// Denoising steps: more is cleaner and slower. Supertonic's own example uses 8.
    pub steps: u8,
    /// 1.0 is the model's own pace; Supertonic's example uses 1.05.
    pub speed: f32,
}

impl Default for Reading {
    fn default() -> Self {
        Self {
            voice: DEFAULT_VOICE,
            steps: DEFAULT_STEPS,
            speed: DEFAULT_SPEED,
        }
    }
}

pub const DEFAULT_STEPS: u8 = 8;
pub const DEFAULT_SPEED: f32 = 1.05;

/// What the pieces of one spoken reply share, so they sound like one voice at one volume: the
/// gain set by the first piece, and whether a piece has been played (the next one gets a gap).
#[derive(Default)]
pub struct Utterance {
    gain: Option<f32>,
    started: bool,
}

/// Synthesises `text` into `feed` a few sentences at a time (so the first piece starts playing
/// while the rest are still being made), stopping early when `stop` is set.
pub fn supertonic_speak(
    tts: &OfflineTts,
    text: &str,
    reading: Reading,
    utterance: &mut Utterance,
    feed: &Arc<Feed>,
    stop: &AtomicBool,
) {
    let mut extra = std::collections::HashMap::new();
    extra.insert("lang".to_string(), serde_json::Value::from("en"));
    let config = GenerationConfig {
        sid: i32::from(reading.voice.min(VOICES - 1)),
        num_steps: i32::from(reading.steps.max(1)),
        speed: reading.speed,
        extra: Some(extra),
        ..Default::default()
    };
    let rate = engine_rate(tts);
    for piece in split_sentences(text) {
        if stop.load(Ordering::SeqCst) {
            return;
        }
        let Some(mut samples) = synthesise(tts, &piece, &config, rate) else {
            continue;
        };
        if stop.load(Ordering::SeqCst) {
            return;
        }
        let samples = trim_silence(&mut samples, rate);
        if samples.is_empty() {
            continue;
        }
        make_up_gain(samples, &mut utterance.gain);
        if utterance.started {
            feed.push(&vec![0.0; rate as usize * GAP_MS / 1000]);
        }
        utterance.started = true;
        feed.push(samples);
    }
}

/// Silence between pieces, the same every time (the model's own varies from 50 to 200 ms).
const GAP_MS: usize = 200;

/// One piece's audio. The model sometimes returns nothing or skips part of the text (sherpa drops
/// a chunk that fails), so either is logged and tried once more, keeping the longer result.
fn synthesise(
    tts: &OfflineTts,
    piece: &str,
    config: &GenerationConfig,
    rate: u32,
) -> Option<Vec<f32>> {
    let generate = || {
        tts.generate_with_config(piece, config, None::<fn(&[f32], f32) -> bool>)
            .map(|audio| audio.samples().to_vec())
    };
    let first = generate();
    let suspect = match &first {
        None => {
            eprintln!("winku: Supertonic returned no audio for {piece:?}; trying again");
            true
        }
        Some(samples) if cut_short(piece, samples.len(), rate) => {
            eprintln!(
                "winku: Supertonic made {:.2}s for {} characters, so it probably skipped some of {piece:?}; trying again",
                samples.len() as f32 / rate as f32,
                piece.chars().count()
            );
            true
        }
        Some(_) => false,
    };
    if !suspect {
        return first;
    }
    let second = generate();
    match (&second, &first) {
        (None, None) => eprintln!("winku: Supertonic returned no audio again; skipping {piece:?}"),
        (Some(again), _) if cut_short(piece, again.len(), rate) => {
            eprintln!("winku: Supertonic cut {piece:?} short again")
        }
        _ => {}
    }
    [first, second].into_iter().flatten().max_by_key(Vec::len)
}

/// The piece without its leading and trailing silence, which the model makes anywhere from 50 to
/// 200 ms long, keeping a few milliseconds so words don't start or end abruptly.
fn trim_silence(samples: &mut [f32], rate: u32) -> &mut [f32] {
    const KEEP_MS: usize = 20;
    let peak = samples.iter().fold(0.0f32, |m, s| m.max(s.abs()));
    let threshold = (peak * 0.02).max(1e-3);
    let Some(first) = samples.iter().position(|s| s.abs() > threshold) else {
        return &mut samples[..0];
    };
    let last = samples
        .iter()
        .rposition(|s| s.abs() > threshold)
        .unwrap_or(first);
    let keep = rate as usize * KEEP_MS / 1000;
    let start = first.saturating_sub(keep);
    let end = (last + 1 + keep).min(samples.len());
    &mut samples[start..end]
}

/// Supertonic's output is quiet (about -28 dBFS RMS, peaks near 0.4), so people turn the volume
/// up and then get blasted by the next notification. The first piece of a reply sets a gain
/// towards -22 dBFS RMS, at most 3x, kept in `gain`; every later piece reuses it so the volume
/// doesn't jump between sentences. No piece goes past a 0.95 peak.
fn make_up_gain(samples: &mut [f32], gain: &mut Option<f32>) {
    const TARGET_RMS: f32 = 0.08;
    let rms = super::audio::rms(samples);
    let peak = samples.iter().fold(0.0f32, |m, s| m.max(s.abs()));
    if rms < 1e-4 || peak <= 0.0 {
        return;
    }
    let shared = *gain.get_or_insert_with(|| (TARGET_RMS / rms).clamp(1.0, 3.0));
    let applied = shared.min(0.95 / peak).max(0.0);
    if applied > 1.0 {
        samples.iter_mut().for_each(|s| *s *= applied);
    }
}

/// Whether `samples` of audio at `rate` is too short to have said all of `text`, which is how a
/// chunk the model skipped shows. Speech runs at about 70 ms a character; under 40 is a rough sign something was skipped.
fn cut_short(text: &str, samples: usize, rate: u32) -> bool {
    const MIN_MS_PER_CHAR: u64 = 40;
    const TOO_FEW_TO_JUDGE: usize = 12;
    let chars = text.chars().count();
    let ms = samples as u64 * 1000 / u64::from(rate.max(1));
    chars >= TOO_FEW_TO_JUDGE && ms < MIN_MS_PER_CHAR * chars as u64
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
/// A piece shorter than this is never synthesised alone: the int8 model turns "I can do that."
/// on its own into a buzz or "Do that.", so it is joined to a neighbour.
const MIN_PIECE: usize = 45;
/// Sentences are packed into pieces of about this many characters (two or three sentences),
/// which the model reads more steadily than one at a time.
const TARGET_PIECE: usize = 80;
/// A sentence isn't added to a piece that would then be longer than this.
const FULL_PIECE: usize = 200;
/// A piece longer than this is cut at a comma or semicolon.
const MAX_PIECE: usize = 280;

/// Cuts `text` into pieces for synthesis: sentences end at newlines and after `.`, `!` or `?`
/// followed by a space (not after "3.5", "e.g." or "Dr."), very long ones are cut at clause
/// breaks, and they are packed two or three to a piece, with a short last one joining the piece
/// before it.
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
        let len = carry.chars().count();
        if len >= MIN_PIECE && len + 1 + sentence.chars().count() > FULL_PIECE {
            pieces.push(std::mem::take(&mut carry));
        }
        if !carry.is_empty() {
            carry.push(' ');
        }
        carry.push_str(&sentence);
        if carry.chars().count() >= TARGET_PIECE {
            pieces.push(std::mem::take(&mut carry));
        }
    }
    if !carry.is_empty() {
        match pieces.last_mut() {
            Some(last) if carry.chars().count() < MIN_PIECE => {
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

#[cfg(target_os = "macos")]
mod os {
    use super::OsVoice;
    use std::process::{Command, Stdio};

    const SAY: &str = "/usr/bin/say";

    pub fn voices() -> Result<Vec<OsVoice>, String> {
        let out = Command::new(SAY)
            .args(["-v", "?"])
            .stdin(Stdio::null())
            .output()
            .map_err(|e| format!("say failed: {e}"))?;
        Ok(parse_voices(&String::from_utf8_lossy(&out.stdout)))
    }

    /// `say -v ?` lists one voice a line: its name (which may have spaces, as in
    /// "Eddy (English (US))"), its locale, then `#` and a sample sentence.
    pub fn parse_voices(list: &str) -> Vec<OsVoice> {
        list.lines()
            .filter_map(|line| {
                let head = line.split('#').next()?.trim_end();
                let (name, locale) = head.rsplit_once(char::is_whitespace)?;
                let name = name.trim();
                (!name.is_empty() && locale.contains('_')).then(|| OsVoice {
                    id: name.to_string(),
                    name: name.to_string(),
                    language: locale.replace('_', "-"),
                })
            })
            .collect()
    }

    /// A WAV file of `text` in the chosen voice (or the system default). A voice this Mac
    /// doesn't have (one picked on another computer) falls back to the default.
    pub fn synthesize(text: &str, voice: Option<&str>) -> Result<Vec<u8>, String> {
        use std::io::Write;
        use std::sync::atomic::{AtomicU32, Ordering};
        static COUNT: AtomicU32 = AtomicU32::new(0);
        let path = std::env::temp_dir().join(format!(
            "winku-say-{}-{}.wav",
            std::process::id(),
            COUNT.fetch_add(1, Ordering::Relaxed)
        ));
        let mut command = Command::new(SAY);
        if let Some(voice) =
            voice.filter(|v| voices().is_ok_and(|all| all.iter().any(|a| a.id == *v)))
        {
            command.args(["-v", voice]);
        }
        let mut child = command
            .args(["--file-format=WAVE", "--data-format=LEI16@22050", "-o"])
            .arg(&path)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("say failed: {e}"))?;
        // The text goes in on stdin: as an argument, a leading dash would read as an option.
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(text.as_bytes());
        }
        let status = child.wait().map_err(|e| format!("say failed: {e}"));
        let wav = std::fs::read(&path);
        let _ = std::fs::remove_file(&path);
        match (status?, wav) {
            (status, Ok(wav)) if status.success() => Ok(wav),
            _ => Err("The macOS voice failed".into()),
        }
    }

    #[cfg(test)]
    mod tests {
        use super::parse_voices;

        #[test]
        fn voices_with_spaces_in_their_names() {
            let list = "Albert              en_US    # Hello! My name is Albert.
                        Eddy (English (US)) en_US    # Hello! My name is Eddy.
                        Amélie              fr_CA    # Bonjour, je m’appelle Amélie.
";
            let voices = parse_voices(list);
            assert_eq!(voices.len(), 3);
            assert_eq!(voices[1].id, "Eddy (English (US))");
            assert_eq!(voices[1].language, "en-US");
            assert_eq!(voices[2].name, "Amélie");
        }
    }
}

#[cfg(not(any(windows, target_os = "macos")))]
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
#[cfg(any(windows, target_os = "macos"))]
pub fn os_speak(
    text: &str,
    voice: Option<&str>,
    output: Option<&str>,
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
    play(output, &feed, stop, on_start)
}

/// Speaks `text` with `spd-say` (speech-dispatcher), blocking until it ends or `stop` is set.
#[cfg(not(any(windows, target_os = "macos")))]
pub fn os_speak(
    text: &str,
    _voice: Option<&str>,
    _output: Option<&str>,
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
        make_up_gain(&mut quiet, &mut None);
        assert!((super::super::audio::rms(&quiet) - 0.08).abs() < 0.005);
        let mut barely = tone(0.01);
        make_up_gain(&mut barely, &mut None);
        let peak = barely.iter().fold(0.0f32, |m, s| m.max(s.abs()));
        assert!((peak - 0.03).abs() < 0.002, "at most 3x: {peak}");
        let mut peaky = tone(0.5);
        peaky[100] = 0.9;
        make_up_gain(&mut peaky, &mut None);
        assert!(peaky.iter().all(|s| s.abs() <= 0.951));
        let mut loud = tone(0.9);
        let before = loud.clone();
        make_up_gain(&mut loud, &mut None);
        assert_eq!(loud, before, "loud audio is left alone");
        let mut silence = vec![0.0; 100];
        make_up_gain(&mut silence, &mut None);
        assert!(silence.iter().all(|s| *s == 0.0));
    }

    #[test]
    fn sentences_split_without_breaking_numbers_or_abbreviations() {
        // Each sentence is long enough to be a piece of its own, so the cuts show.
        let t = "Dr. Lee paid $4.50 for twelve apples at the market, e.g. the green ones from the farm stall. \
                 Then she walked all the way home along the river and put them in the big bowl on the table! \
                 Was that a sensible thing to do with so many apples in the middle of a very warm summer?";
        assert_eq!(
            split_sentences(t),
            [
                "Dr. Lee paid $4.50 for twelve apples at the market, e.g. the green ones from the farm stall.",
                "Then she walked all the way home along the river and put them in the big bowl on the table!",
                "Was that a sensible thing to do with so many apples in the middle of a very warm summer?",
            ]
        );
        assert_eq!(split_sentences("Hi."), ["Hi."]);
        assert_eq!(split_sentences("  \n "), Vec::<String>::new());
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
    fn short_sentences_are_never_synthesised_alone() {
        // Short replies stay whole instead of becoming a buzz and "Do that."
        assert_eq!(
            split_sentences("Yes. I can do that."),
            ["Yes. I can do that."]
        );
        // A short last sentence joins the piece before it.
        let t = "The build finished and every one of the tests passed on the first try this time. I can do that.";
        assert_eq!(split_sentences(t), [t]);
        // A short first sentence joins the one after it.
        assert_eq!(
            split_sentences("Sure.\nThe meeting moved to Thursday afternoon, right after lunch with the design team."),
            ["Sure. The meeting moved to Thursday afternoon, right after lunch with the design team."]
        );
    }

    #[test]
    fn sentences_are_packed_two_or_three_to_a_piece() {
        let sentence = "Each sentence here is forty characters.";
        let text = [sentence; 7].join(" ");
        let pieces = split_sentences(&text);
        for piece in &pieces {
            let len = piece.chars().count();
            assert!((80..=200).contains(&len), "{len}: {piece:?}");
        }
        assert_eq!(pieces.join(" "), text, "nothing is lost or reordered");
    }

    #[test]
    fn audio_too_short_for_its_text_is_caught() {
        // 80 characters.
        let text =
            "The meeting moved to Thursday afternoon, right after lunch with the design team.";
        let rate = 44_100;
        let secs = |s: f32| (s * rate as f32) as usize;
        // About 70 ms a character is ordinary speech.
        assert!(!cut_short(text, secs(5.5), rate));
        // A skipped chunk leaves well under 40 ms a character.
        assert!(cut_short(text, secs(1.5), rate));
        assert!(cut_short(text, 0, rate));
        // A word or two can't be judged that finely.
        assert!(!cut_short("Yes.", secs(0.1), rate));
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
