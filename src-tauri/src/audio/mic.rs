// cpal 0.17 deprecates Device::name() in favor of description()/id().
// The saved "audio_device" setting stores names, so the migration to
// stable ids is a deliberate follow-up, not a drive-by.
#![allow(deprecated)]

use anyhow::{anyhow, Result};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::SampleFormat;
use ringbuf::traits::Producer;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use super::ringbuf::{create_audio_ring, AudioConsumer};

/// List available input device names (microphones, Bluetooth, AirPods, etc.).
/// This includes all cpal-visible input devices, which covers
/// Bluetooth and AirPods on macOS when they are connected and set up.
pub fn list_input_devices() -> Vec<String> {
    let host = cpal::default_host();
    host.input_devices()
        .map(|devices| {
            devices
                .filter_map(|d| d.name().ok())
                .collect()
        })
        .unwrap_or_default()
}

/// List available output device names .
/// Useful for system audio loopback or for UI display of Bluetooth/AirPods devices.
pub fn list_output_devices() -> Vec<String> {
    let host = cpal::default_host();
    host.output_devices()
        .map(|devices| {
            devices
                .filter_map(|d| d.name().ok())
                .collect()
        })
        .unwrap_or_default()
}

/// Capture started successfully — returned alongside the runtime handles
/// so the caller knows whether the requested device was actually used.
pub struct MicCaptureStart {
    pub stop_flag: Arc<AtomicBool>,
    pub consumer: AudioConsumer,
    pub sample_rate: u32,
    /// Name of the device we actually opened. Different from the requested
    /// name when the requested device couldn't be found and we fell back
    /// to the system default.
    pub device_name: String,
    /// `Some(name)` when the caller asked for a specific device by name
    /// and we had to fall back because it wasn't present. The caller can
    /// surface this to the user and clear any stale saved-device setting.
    pub fell_back_from: Option<String>,
}

/// Start mic capture on a dedicated thread. When `device_name` is set
/// but the device isn't found on the host, fall back to the system
/// default rather than failing — devices come and go (USB unplug,
/// Bluetooth disconnect, renamed inputs) and a recording attempt
/// shouldn't hard-fail just because the saved name is stale.
pub fn start_mic_capture(device_name: Option<&str>) -> Result<MicCaptureStart> {
    let host = cpal::default_host();
    let mut fell_back_from: Option<String> = None;
    let device = if let Some(name) = device_name {
        let found = host
            .input_devices()
            .map_err(|e| anyhow!("failed to enumerate devices: {}", e))?
            .find(|d| d.name().ok().as_deref() == Some(name));
        match found {
            Some(d) => d,
            None => {
                log::warn!(
                    "input device '{}' not found — falling back to system default",
                    name
                );
                fell_back_from = Some(name.to_string());
                host.default_input_device()
                    .ok_or_else(|| anyhow!("no input device found (default also unavailable)"))?
            }
        }
    } else {
        host.default_input_device()
            .ok_or_else(|| anyhow!("no input device found"))?
    };
    let actual_device_name = device.name().unwrap_or_else(|_| "<unknown>".to_string());

    let config = device.default_input_config()?;
    let sample_rate = config.sample_rate();
    let channels = config.channels() as usize;

    let (mut producer, consumer) = create_audio_ring(sample_rate as usize * 10);

    let is_running = Arc::new(AtomicBool::new(true));
    let running_flag = is_running.clone();
    let running_for_thread = is_running.clone();

    let sample_format = config.sample_format();
    let stream_config: cpal::StreamConfig = config.into();

    // Spawn a dedicated thread to own the cpal Stream (which is !Send)
    std::thread::spawn(move || {
        let stream = match sample_format {
            SampleFormat::F32 => device.build_input_stream(
                &stream_config,
                move |data: &[f32], _: &cpal::InputCallbackInfo| {
                    if !running_flag.load(Ordering::Relaxed) {
                        return;
                    }
                    if channels == 1 {
                        let written = producer.push_slice(data);
                        if written < data.len() {
                            super::MIC_DROPPED_SAMPLES.fetch_add(
                                (data.len() - written) as u64,
                                Ordering::Relaxed,
                            );
                        }
                    } else {
                        for chunk in data.chunks(channels) {
                            let mono = chunk.iter().sum::<f32>() / channels as f32;
                            if producer.try_push(mono).is_err() {
                                super::MIC_DROPPED_SAMPLES.fetch_add(1, Ordering::Relaxed);
                            }
                        }
                    }
                },
                |err| {
                    // Surfaces DeviceNotAvailable etc. to the mic supervisor
                    // so it can skip the stall wait (design §1b).
                    super::MIC_STREAM_ERROR.store(true, Ordering::Relaxed);
                    log::error!("mic stream error: {}", err);
                },
                None,
            ),
            SampleFormat::I16 => device.build_input_stream(
                &stream_config,
                move |data: &[i16], _: &cpal::InputCallbackInfo| {
                    if !running_flag.load(Ordering::Relaxed) {
                        return;
                    }
                    for chunk in data.chunks(channels) {
                        let mono: f32 = chunk.iter().map(|&s| s as f32 / i16::MAX as f32).sum::<f32>()
                            / channels as f32;
                        if producer.try_push(mono).is_err() {
                            super::MIC_DROPPED_SAMPLES.fetch_add(1, Ordering::Relaxed);
                        }
                    }
                },
                |err| {
                    // Surfaces DeviceNotAvailable etc. to the mic supervisor
                    // so it can skip the stall wait (design §1b).
                    super::MIC_STREAM_ERROR.store(true, Ordering::Relaxed);
                    log::error!("mic stream error: {}", err);
                },
                None,
            ),
            _ => {
                log::error!("unsupported sample format: {:?}", sample_format);
                return;
            }
        };

        match stream {
            Ok(stream) => {
                if let Err(e) = stream.play() {
                    log::error!("failed to play mic stream: {}", e);
                    return;
                }
                // Keep stream alive until stop_flag is set to false
                while running_for_thread.load(Ordering::Relaxed) {
                    std::thread::sleep(std::time::Duration::from_millis(100));
                }
                drop(stream);
            }
            Err(e) => {
                log::error!("failed to build mic stream: {}", e);
            }
        }
    });

    Ok(MicCaptureStart {
        stop_flag: is_running,
        consumer,
        sample_rate,
        device_name: actual_device_name,
        fell_back_from,
    })
}
