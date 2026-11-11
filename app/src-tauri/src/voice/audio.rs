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

/// Input taps on each side of the interpolation point (at a ratio of 1; more when downsampling).
const SINC_HALF: usize = 24;
/// Sub-sample positions the kernel is tabulated at; in between, two rows are blended.
const SINC_PHASES: usize = 512;

/// Windowed-sinc resampler for a stream of chunks (playback), keeping its position between
/// chunks. Linear interpolation was audibly dull and leaked images of the voice above the old
/// Nyquist; this is a Blackman-windowed sinc with the cutoff at the lower of the two Nyquists,
/// tabulated so each output sample costs `2 * half` multiply-adds.
#[derive(Debug)]
pub struct StreamResampler {
    step: f64,
    half: usize,
    /// `SINC_PHASES + 1` rows of `2 * half` taps; row `p` is the kernel at sub-sample `p / SINC_PHASES`.
    table: Vec<f32>,
    /// Input history; index `pos` is where the next output sample sits.
    buf: Vec<f32>,
    pos: f64,
    passthrough: bool,
    flushed: bool,
}

impl StreamResampler {
    pub fn new(from: u32, to: u32) -> Self {
        let step = from.max(1) as f64 / to.max(1) as f64;
        let scale = (1.0 / step).min(1.0);
        let half = (SINC_HALF as f64 / scale).ceil() as usize;
        let taps = 2 * half;
        let mut table = Vec::with_capacity((SINC_PHASES + 1) * taps);
        for phase in 0..=SINC_PHASES {
            let frac = phase as f64 / SINC_PHASES as f64;
            let row: Vec<f64> = (0..taps)
                .map(|j| {
                    let x = (j as f64 + 1.0 - half as f64) - frac;
                    sinc_kernel(x, scale, half as f64)
                })
                .collect();
            let sum: f64 = row.iter().sum();
            table.extend(row.iter().map(|t| (t / sum) as f32));
        }
        Self {
            step,
            half,
            table,
            buf: vec![0.0; half],
            pos: half as f64,
            passthrough: from == to,
            flushed: false,
        }
    }

    /// Resamples one chunk, appending to `out`.
    pub fn push(&mut self, chunk: &[f32], out: &mut Vec<f32>) {
        if self.passthrough {
            out.extend_from_slice(chunk);
            return;
        }
        self.buf.extend_from_slice(chunk);
        self.drain(out);
    }

    /// Plays out the last few input samples still held back; call once when no more is coming.
    pub fn finish(&mut self, out: &mut Vec<f32>) {
        if self.passthrough || std::mem::replace(&mut self.flushed, true) {
            return;
        }
        self.buf.resize(self.buf.len() + self.half, 0.0);
        self.drain(out);
    }

    fn drain(&mut self, out: &mut Vec<f32>) {
        let taps = 2 * self.half;
        while (self.pos as usize) + self.half < self.buf.len() {
            let i0 = self.pos.floor() as usize;
            let at = (self.pos - i0 as f64) * SINC_PHASES as f64;
            let row = (at as usize).min(SINC_PHASES - 1);
            let mix = (at - row as f64) as f32;
            let (a, b) = (
                &self.table[row * taps..(row + 1) * taps],
                &self.table[(row + 1) * taps..(row + 2) * taps],
            );
            let window = &self.buf[i0 + 1 - self.half..i0 + 1 + self.half];
            let mut sum = 0.0f32;
            for ((x, ka), kb) in window.iter().zip(a).zip(b) {
                sum += x * (ka + (kb - ka) * mix);
            }
            out.push(sum);
            self.pos += self.step;
        }
        // Keep only what the next output sample can still read.
        let keep_from = (self.pos as usize + 1).saturating_sub(self.half);
        if keep_from > 0 {
            self.buf.drain(..keep_from);
            self.pos -= keep_from as f64;
        }
    }
}

/// `scale * sinc(scale * x)` under a Blackman window `half` samples wide.
fn sinc_kernel(x: f64, scale: f64, half: f64) -> f64 {
    use std::f64::consts::PI;
    let t = PI * scale * x;
    let sinc = if x == 0.0 { 1.0 } else { t.sin() / t };
    let w = (PI * x / half).cos().mul_add(0.5, 0.0);
    let blackman = 0.42 + w + 0.08 * (2.0 * PI * x / half).cos();
    scale * sinc * blackman.max(0.0)
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

    /// What `StreamResampler` should produce for a sine, sampled at the output instants.
    fn ideal(freq: f32, to: u32, n: usize, amp: f32) -> Vec<f32> {
        (0..n)
            .map(|i| {
                let t = i as f64 / to as f64;
                amp * (2.0 * std::f64::consts::PI * freq as f64 * t).sin() as f32
            })
            .collect()
    }

    fn stream(input: &[f32], from: u32, to: u32, chunk: usize) -> Vec<f32> {
        let mut resampler = StreamResampler::new(from, to);
        let mut out = Vec::new();
        for c in input.chunks(chunk) {
            resampler.push(c, &mut out);
        }
        resampler.finish(&mut out);
        out
    }

    /// Largest difference from the ideal tone, skipping the filter's warm-up and tail.
    fn worst_error(out: &[f32], want: &[f32]) -> f32 {
        let edge = 80;
        out.iter()
            .zip(want)
            .skip(edge)
            .take(out.len().saturating_sub(2 * edge))
            .fold(0.0f32, |m, (a, b)| m.max((a - b).abs()))
    }

    #[test]
    fn stream_resampler_reproduces_tones_at_playback_rates() {
        // Kokoro/Supertonic/OneCore rates to the usual device rates, through uneven chunks.
        for (from, to) in [
            (44_100, 48_000),
            (24_000, 48_000),
            (22_050, 48_000),
            (24_000, 44_100),
        ] {
            // Well below the source Nyquist, where the filter has not started to roll off.
            for freq in [200.0, 1_000.0, 6_000.0, 10_000.0]
                .into_iter()
                .filter(|f| *f < from as f32 * 0.4)
            {
                let input = sine(freq, from, 0.3, 0.5);
                let out = stream(&input, from, to, 997);
                let want = ideal(freq, to, out.len(), 0.5);
                let err = worst_error(&out, &want);
                assert!(err < 4e-3, "{from}->{to} {freq} Hz: worst error {err}");
            }
        }
    }

    #[test]
    fn stream_resampler_ignores_how_the_input_is_chunked() {
        let input = sine(440.0, 44_100, 0.2, 0.5);
        let whole = stream(&input, 44_100, 48_000, input.len());
        for chunk in [1, 7, 333, 4_096] {
            let out = stream(&input, 44_100, 48_000, chunk);
            assert_eq!(out.len(), whole.len(), "chunk {chunk}");
            for (a, b) in out.iter().zip(&whole) {
                assert!((a - b).abs() < 1e-5, "chunk {chunk}");
            }
        }
        // Length follows the ratio, and nothing is lost at the end.
        let expect = (input.len() as f64 * 48_000.0 / 44_100.0) as isize;
        assert!(
            (whole.len() as isize - expect).abs() <= 2,
            "{} vs {expect}",
            whole.len()
        );
    }

    #[test]
    fn stream_resampler_has_no_clicks_at_chunk_joins() {
        let input = sine(300.0, 24_000, 0.5, 0.8);
        let mut resampler = StreamResampler::new(24_000, 48_000);
        let mut out = Vec::new();
        let mut joins = Vec::new();
        for c in input.chunks(2_400) {
            resampler.push(c, &mut out);
            joins.push(out.len());
        }
        // A 300 Hz tone at 48 kHz changes by at most about 0.8 * 2 pi * 300 / 48000 per sample.
        let max_step = 0.8 * 2.0 * std::f32::consts::PI * 300.0 / 48_000.0 * 1.05;
        for &j in &joins[..joins.len() - 1] {
            let step = (out[j] - out[j - 1]).abs();
            assert!(step <= max_step, "step {step} at {j}");
        }
    }

    #[test]
    fn stream_resampler_does_not_leak_images_or_clip() {
        // A 9 kHz tone at 24 kHz, taken to 48 kHz, must not grow a mirror image at 15 kHz
        // (linear interpolation leaves one only about 9 dB down).
        let input = sine(9_000.0, 24_000, 0.5, 0.9);
        let out = stream(&input, 24_000, 48_000, 1_024);
        let tone = rms(&out[200..out.len() - 200]);
        assert!((tone - 0.9 / 2f32.sqrt()).abs() < 0.01, "{tone}");
        let fundamental = ideal(9_000.0, 48_000, out.len(), 0.9);
        let residue: Vec<f32> = out
            .iter()
            .zip(&fundamental)
            .skip(200)
            .map(|(a, b)| a - b)
            .collect();
        let residue = &residue[..residue.len() - 400];
        assert!(rms(residue) < 0.003, "residue {}", rms(residue));
        assert!(out.iter().all(|s| s.abs() <= 1.0));
        let mut same = StreamResampler::new(22_050, 22_050);
        let mut copy = Vec::new();
        same.push(&[0.1, 0.2], &mut copy);
        same.push(&[0.3], &mut copy);
        same.finish(&mut copy);
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
