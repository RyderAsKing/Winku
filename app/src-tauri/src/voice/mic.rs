//! Microphone capture with cpal (WASAPI on Windows). Records the default input device on the
//! calling thread until told to stop, reporting a level for the eyes.

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, SampleFormat, SizedSample};

use super::audio;

/// `talk_level` at most 15 times a second.
pub const LEVEL_INTERVAL: Duration = Duration::from_millis(67);

#[derive(Debug, PartialEq)]
pub enum MicError {
    NoDevice,
    Denied,
    Other(String),
}

impl MicError {
    pub fn message(&self) -> String {
        match self {
            MicError::NoDevice => {
                "No microphone found. Plug one in, or pick a default input device in Sound settings."
                    .into()
            }
            MicError::Denied => if cfg!(windows) {
                "Windows is blocking the microphone. Turn on Settings > Privacy & security > Microphone > \"Let desktop apps access your microphone\", then hold the key again."
            } else {
                "The system denied access to the microphone. Allow it in your privacy settings and try again."
            }
            .into(),
            MicError::Other(e) => format!("Couldn't use the microphone: {e}"),
        }
    }
}

/// Sorts a cpal error into what the user can do about it.
pub fn classify(kind: cpal::ErrorKind, text: &str) -> MicError {
    let lower = text.to_ascii_lowercase();
    // WASAPI reports E_ACCESSDENIED (privacy setting off) as a backend error.
    let denied = kind == cpal::ErrorKind::PermissionDenied
        || lower.contains("access is denied")
        || lower.contains("0x80070005")
        || lower.contains("-2147024891");
    if denied {
        MicError::Denied
    } else if kind == cpal::ErrorKind::DeviceNotAvailable {
        MicError::NoDevice
    } else {
        MicError::Other(text.to_string())
    }
}

fn from_cpal(e: cpal::Error) -> MicError {
    classify(e.kind(), &e.to_string())
}

/// Mono samples at the device's rate.
pub struct Recording {
    pub samples: Vec<f32>,
    pub rate: u32,
}

struct Shared {
    samples: Mutex<Vec<f32>>,
    /// Loudest block RMS since the last level report, as f32 bits.
    peak: AtomicU32,
    failed: AtomicBool,
}

/// Records until `stop` receives (or its sender is dropped) or `max` has passed. `on_open` runs
/// once the microphone is capturing; `on_level` gets 0–1 at most every `LEVEL_INTERVAL`.
pub fn record(
    stop: &Receiver<()>,
    max: Duration,
    on_open: impl FnOnce(),
    mut on_level: impl FnMut(f32),
) -> Result<Recording, MicError> {
    let host = cpal::default_host();
    let device = host.default_input_device().ok_or(MicError::NoDevice)?;
    let supported = device.default_input_config().map_err(from_cpal)?;
    let config = supported.config();
    let rate = config.sample_rate;
    let channels = config.channels as usize;
    let shared = Arc::new(Shared {
        samples: Mutex::new(Vec::with_capacity(rate as usize * 10)),
        peak: AtomicU32::new(0),
        failed: AtomicBool::new(false),
    });
    let stream = match supported.sample_format() {
        SampleFormat::F32 => build::<f32>(&device, config, channels, &shared),
        SampleFormat::I16 => build::<i16>(&device, config, channels, &shared),
        SampleFormat::U16 => build::<u16>(&device, config, channels, &shared),
        SampleFormat::I32 => build::<i32>(&device, config, channels, &shared),
        SampleFormat::U8 => build::<u8>(&device, config, channels, &shared),
        SampleFormat::F64 => build::<f64>(&device, config, channels, &shared),
        other => Err(MicError::Other(format!(
            "unsupported sample format {other}"
        ))),
    }?;
    stream.play().map_err(from_cpal)?;
    on_open();

    let started = Instant::now();
    loop {
        match stop.recv_timeout(LEVEL_INTERVAL) {
            Ok(()) | Err(RecvTimeoutError::Disconnected) => break,
            Err(RecvTimeoutError::Timeout) => {}
        }
        let peak = f32::from_bits(shared.peak.swap(0, Ordering::Relaxed));
        on_level(audio::level(peak));
        if started.elapsed() >= max || shared.failed.load(Ordering::Relaxed) {
            break;
        }
    }
    drop(stream);
    let samples = std::mem::take(&mut *shared.samples.lock().unwrap_or_else(|e| e.into_inner()));
    Ok(Recording { samples, rate })
}

fn build<T>(
    device: &cpal::Device,
    config: cpal::StreamConfig,
    channels: usize,
    shared: &Arc<Shared>,
) -> Result<cpal::Stream, MicError>
where
    T: SizedSample,
    f32: FromSample<T>,
{
    let data = Arc::clone(shared);
    let errors = Arc::clone(shared);
    device
        .build_input_stream::<T, _, _>(
            config,
            move |input: &[T], _| {
                let floats: Vec<f32> = input.iter().map(|s| s.to_sample::<f32>()).collect();
                let mono = audio::to_mono(&floats, channels);
                let rms = audio::rms(&mono);
                // RMS is never negative, and non-negative floats order like their bits.
                data.peak.fetch_max(rms.to_bits(), Ordering::Relaxed);
                data.samples
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .extend_from_slice(&mono);
            },
            move |e| {
                eprintln!("winku: microphone stream error: {e}");
                if !matches!(
                    e.kind(),
                    cpal::ErrorKind::Xrun | cpal::ErrorKind::DeviceChanged
                ) {
                    errors.failed.store(true, Ordering::Relaxed);
                }
            },
            None,
        )
        .map_err(from_cpal)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn errors_get_plain_advice() {
        assert_eq!(
            classify(
                cpal::ErrorKind::BackendError,
                "Access is denied. (os error -2147024891)"
            ),
            MicError::Denied
        );
        assert_eq!(
            classify(cpal::ErrorKind::PermissionDenied, "x"),
            MicError::Denied
        );
        assert_eq!(
            classify(cpal::ErrorKind::DeviceNotAvailable, "gone"),
            MicError::NoDevice
        );
        assert!(matches!(
            classify(cpal::ErrorKind::DeviceBusy, "busy"),
            MicError::Other(_)
        ));
        assert!(MicError::NoDevice.message().contains("No microphone"));
        assert!(MicError::Denied.message().contains("microphone"));
    }
}
