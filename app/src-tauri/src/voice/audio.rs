//! Pure audio helpers: channel mixing, resampling, the talk level, the "was anything said" check
//! and a small WAV reader (Windows OneCore voices synthesize to a WAV stream).

/// Sample rate the recognisers want.
pub const STT_RATE: u32 = 16_000;
/// Recordings shorter than this are treated as "nothing was said".
pub const MIN_SPEECH_SECS: f32 = 0.3;
/// A 30 ms window must reach this RMS somewhere in the recording to count as speech.
pub const SILENCE_RMS: f32 = 0.004;

/// Averages interleaved frames down to mono.
pub fn to_mono(interleaved: &[f32], channels: usize) -> Vec<f32> {
    if channels <= 1 {
        return interleaved.to_vec();
    }
    interleaved
        .chunks_exact(channels)
        .map(|frame| frame.iter().sum::<f32>() / channels as f32)
        .collect()
}

/// Resamples a whole mono recording with linear interpolation. When downsampling, the input is
/// low-passed first (a windowed sinc at the new Nyquist), evaluated only at the samples the
/// interpolation reads, so tones the new rate can't hold don't fold back as noise.
pub fn resample(input: &[f32], from: u32, to: u32) -> Vec<f32> {
    if input.is_empty() || from == 0 || to == 0 {
        return Vec::new();
    }
    if from == to {
        return input.to_vec();
    }
    let ratio = from as f64 / to as f64;
    let kernel = (ratio > 1.0).then(|| lowpass(0.5 / ratio, (8.0 * ratio).ceil() as usize));
    let last = input.len() - 1;
    let at = |i: usize| -> f32 {
        let Some(kernel) = &kernel else {
            return input[i];
        };
        let half = kernel.len() / 2;
        kernel
            .iter()
            .enumerate()
            .map(|(j, k)| k * input[(i + j).saturating_sub(half).min(last)])
            .sum()
    };
    let out_len = ((input.len() as f64) / ratio).floor().max(1.0) as usize;
    (0..out_len)
        .map(|i| {
            let pos = i as f64 * ratio;
            let left = (pos.floor() as usize).min(last);
            let frac = (pos - left as f64) as f32;
            let l = at(left);
            if frac == 0.0 || left == last {
                return l;
            }
            l + (at(left + 1) - l) * frac
        })
        .collect()
}

/// Blackman-windowed sinc low-pass with `2 * half + 1` taps, `cutoff` in cycles per sample,
/// normalised to unity gain.
fn lowpass(cutoff: f64, half: usize) -> Vec<f32> {
    use std::f64::consts::PI;
    let n = 2 * half + 1;
    let taps: Vec<f64> = (0..n)
        .map(|i| {
            let x = i as f64 - half as f64;
            let sinc = if x == 0.0 {
                2.0 * cutoff
            } else {
                (2.0 * PI * cutoff * x).sin() / (PI * x)
            };
            let w = 0.42 - 0.5 * (2.0 * PI * i as f64 / (n - 1) as f64).cos()
                + 0.08 * (4.0 * PI * i as f64 / (n - 1) as f64).cos();
            sinc * w
        })
        .collect();
    let sum: f64 = taps.iter().sum();
    taps.iter().map(|t| (t / sum) as f32).collect()
}

/// Root mean square of a block.
pub fn rms(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    (samples.iter().map(|s| s * s).sum::<f32>() / samples.len() as f32).sqrt()
}

/// Maps a block's RMS to the 0–1 `talk_level` the eyes pulse with. Logarithmic, so quiet speech
/// still moves the eyes: -60 dBFS (and below) is 0, -10 dBFS (and above) is 1.
pub fn level(rms: f32) -> f32 {
    if rms <= 0.0 {
        return 0.0;
    }
    let db = 20.0 * rms.log10();
    ((db + 60.0) / 50.0).clamp(0.0, 1.0)
}

/// What a finished 16 kHz recording is worth transcribing.
pub fn has_speech(samples: &[f32], rate: u32) -> bool {
    if (samples.len() as f32) < MIN_SPEECH_SECS * rate as f32 {
        return false;
    }
    let window = (rate as usize * 30 / 1000).max(1);
    samples
        .chunks(window)
        .any(|chunk| rms(chunk) >= SILENCE_RMS)
}

/// Linear resampler for a stream of chunks (playback), keeping its position between chunks.
#[derive(Debug)]
pub struct StreamResampler {
    step: f64,
    pos: f64,
    prev: Option<f32>,
}

impl StreamResampler {
    pub fn new(from: u32, to: u32) -> Self {
        Self {
            step: from as f64 / to.max(1) as f64,
            pos: 0.0,
            prev: None,
        }
    }

    /// Resamples one chunk, appending to `out`.
    pub fn push(&mut self, chunk: &[f32], out: &mut Vec<f32>) {
        if chunk.is_empty() {
            return;
        }
        // Index 0 is the previous chunk's last sample, so interpolation continues across chunks.
        let seq: Vec<f32> = self.prev.into_iter().chain(chunk.iter().copied()).collect();
        let last = (seq.len() - 1) as f64;
        while self.pos <= last {
            let left = self.pos.floor() as usize;
            let frac = (self.pos - left as f64) as f32;
            let right = if frac > 0.0 { seq[left + 1] } else { seq[left] };
            out.push(seq[left] + (right - seq[left]) * frac);
            self.pos += self.step;
        }
        self.pos -= last;
        self.prev = chunk.last().copied();
    }
}

/// PCM decoded from a WAV file.
#[cfg_attr(not(windows), allow(dead_code))]
#[derive(Debug, PartialEq)]
pub struct Wav {
    pub rate: u32,
    pub samples: Vec<f32>,
}

#[cfg_attr(not(windows), allow(dead_code))]
/// Reads a RIFF/WAVE file with 16-bit integer, 32-bit float or 8-bit PCM, mixed to mono.
pub fn parse_wav(bytes: &[u8]) -> Result<Wav, String> {
    let bad = |what: &str| format!("not a WAV the player understands ({what})");
    if bytes.len() < 12 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err(bad("no RIFF header"));
    }
    let u16_at = |i: usize| u16::from_le_bytes([bytes[i], bytes[i + 1]]);
    let u32_at =
        |i: usize| u32::from_le_bytes([bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]]);
    let mut i = 12;
    let mut format = None;
    while i + 8 <= bytes.len() {
        let id = &bytes[i..i + 4];
        let len = u32_at(i + 4) as usize;
        let body = i + 8;
        if id == b"fmt " && body + 16 <= bytes.len() {
            let tag = u16_at(body);
            let channels = u16_at(body + 2).max(1) as usize;
            let rate = u32_at(body + 4);
            let bits = u16_at(body + 14);
            // WAVE_FORMAT_EXTENSIBLE carries the real tag in its sub-format GUID.
            let tag = if tag == 0xFFFE && body + 26 <= bytes.len() {
                u16_at(body + 24)
            } else {
                tag
            };
            format = Some((tag, channels, rate, bits));
        } else if id == b"data" {
            let (tag, channels, rate, bits) = format.ok_or_else(|| bad("data before fmt"))?;
            let end = body.saturating_add(len).min(bytes.len());
            let data = &bytes[body..end];
            let interleaved: Vec<f32> = match (tag, bits) {
                (1, 16) => data
                    .as_chunks::<2>()
                    .0
                    .iter()
                    .map(|b| i16::from_le_bytes(*b) as f32 / 32768.0)
                    .collect(),
                (1, 8) => data.iter().map(|&b| (b as f32 - 128.0) / 128.0).collect(),
                (3, 32) => data
                    .as_chunks::<4>()
                    .0
                    .iter()
                    .map(|b| f32::from_le_bytes(*b))
                    .collect(),
                _ => return Err(bad(&format!("format {tag}, {bits} bits"))),
            };
            return Ok(Wav {
                rate,
                samples: to_mono(&interleaved, channels),
            });
        }
        i = body.saturating_add(len + (len & 1));
    }
    Err(bad("no data chunk"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(freq: f32, rate: u32, secs: f32, amp: f32) -> Vec<f32> {
        (0..(rate as f32 * secs) as usize)
            .map(|i| amp * (2.0 * std::f32::consts::PI * freq * i as f32 / rate as f32).sin())
            .collect()
    }

    #[test]
    fn mono_mix_averages_channels() {
        assert_eq!(to_mono(&[1.0, 0.0, 0.5, 0.5], 2), vec![0.5, 0.5]);
        assert_eq!(to_mono(&[0.1, 0.2], 1), vec![0.1, 0.2]);
    }

    #[test]
    fn resample_keeps_duration_and_tone() {
        let input = sine(440.0, 48_000, 1.0, 0.5);
        let out = resample(&input, 48_000, STT_RATE);
        assert_eq!(out.len(), 16_000);
        // The tone survives with about the same energy.
        assert!((rms(&out) - rms(&input)).abs() < 0.02, "{}", rms(&out));
        let cd = resample(&sine(1000.0, 44_100, 1.0, 0.5), 44_100, STT_RATE);
        assert_eq!(cd.len(), 16_000);
        assert!((rms(&cd) - 0.3535).abs() < 0.02, "{}", rms(&cd));
        let up = resample(&sine(440.0, 8_000, 0.5, 0.5), 8_000, STT_RATE);
        assert_eq!(up.len(), 8_000);
        assert_eq!(resample(&input, 16_000, 16_000).len(), input.len());
        assert!(resample(&[], 48_000, 16_000).is_empty());
    }

    #[test]
    fn downsampling_suppresses_tones_above_the_new_nyquist() {
        // 12 kHz is above 8 kHz (the 16 kHz Nyquist): the low-pass must take it out.
        let input = sine(12_000.0, 48_000, 0.5, 0.5);
        let out = resample(&input, 48_000, STT_RATE);
        assert!(rms(&out) < 0.01 * rms(&input), "{}", rms(&out));
    }

    #[test]
    fn level_is_logarithmic_and_clamped() {
        assert_eq!(level(0.0), 0.0);
        assert_eq!(level(0.0001), 0.0);
        assert_eq!(level(1.0), 1.0);
        let quiet = level(0.01); // -40 dBFS
        assert!((quiet - 0.4).abs() < 0.01, "{quiet}");
        assert!(level(0.1) > quiet);
    }

    #[test]
    fn short_or_silent_recordings_have_no_speech() {
        assert!(!has_speech(&[], STT_RATE));
        assert!(
            !has_speech(&sine(200.0, STT_RATE, 0.2, 0.5), STT_RATE),
            "too short"
        );
        assert!(!has_speech(&vec![0.0005; 32_000], STT_RATE), "silence");
        assert!(has_speech(&sine(200.0, STT_RATE, 1.0, 0.1), STT_RATE));
    }

    #[test]
    fn stream_resampler_matches_whole_buffer_resampling() {
        let input = sine(300.0, 24_000, 0.2, 0.5);
        let mut stream = StreamResampler::new(24_000, 48_000);
        let mut out = Vec::new();
        for chunk in input.chunks(377) {
            stream.push(chunk, &mut out);
        }
        let whole = resample(&input, 24_000, 48_000);
        assert!((out.len() as isize - whole.len() as isize).abs() <= 2);
        for (a, b) in out.iter().zip(&whole) {
            assert!((a - b).abs() < 1e-4);
        }
        let mut same = StreamResampler::new(22_050, 22_050);
        let mut copy = Vec::new();
        same.push(&[0.1, 0.2], &mut copy);
        same.push(&[0.3], &mut copy);
        assert_eq!(copy, vec![0.1, 0.2, 0.3]);
    }

    fn wav_bytes(tag: u16, channels: u16, rate: u32, bits: u16, data: &[u8]) -> Vec<u8> {
        let mut v = b"RIFF".to_vec();
        v.extend(((36 + data.len()) as u32).to_le_bytes());
        v.extend(b"WAVEfmt ");
        v.extend(16u32.to_le_bytes());
        v.extend(tag.to_le_bytes());
        v.extend(channels.to_le_bytes());
        v.extend(rate.to_le_bytes());
        v.extend((rate * channels as u32 * bits as u32 / 8).to_le_bytes());
        v.extend((channels * bits / 8).to_le_bytes());
        v.extend(bits.to_le_bytes());
        v.extend(b"LIST");
        v.extend(3u32.to_le_bytes());
        v.extend([1, 2, 3, 0]); // odd chunk + pad byte
        v.extend(b"data");
        v.extend((data.len() as u32).to_le_bytes());
        v.extend(data);
        v
    }

    #[test]
    fn wav_reader_handles_pcm16_stereo_and_float() {
        let pcm: Vec<u8> = [16384i16, -16384, 0, 32767]
            .iter()
            .flat_map(|s| s.to_le_bytes())
            .collect();
        let wav = parse_wav(&wav_bytes(1, 2, 22_050, 16, &pcm)).unwrap();
        assert_eq!(wav.rate, 22_050);
        assert_eq!(wav.samples.len(), 2);
        assert!(wav.samples[0].abs() < 1e-6);
        let float: Vec<u8> = [0.25f32, -0.5]
            .iter()
            .flat_map(|s| s.to_le_bytes())
            .collect();
        let wav = parse_wav(&wav_bytes(3, 1, 16_000, 32, &float)).unwrap();
        assert_eq!(wav.samples, vec![0.25, -0.5]);
        assert!(parse_wav(b"nope").is_err());
        assert!(parse_wav(&wav_bytes(2, 1, 16_000, 4, &[0, 0])).is_err());
    }
}
