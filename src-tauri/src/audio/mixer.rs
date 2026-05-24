use anyhow::Result;
use hound::{WavSpec, WavWriter};
use ringbuf::traits::Consumer;
use rubato::{FftFixedIn, Resampler};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;
use tokio::sync::mpsc;

use super::ringbuf::AudioConsumer;

const TARGET_SAMPLE_RATE: u32 = 16_000;
const CHUNK_SAMPLES: usize = 1600; // 100ms at 16kHz

/// Thread-safe reader for current audio levels .
/// Uses atomics for lock-free reads from the frontend event emitter.
#[derive(Clone)]
pub struct AudioLevelReader {
    /// RMS level stored as fixed-point: value * 10000
    rms: Arc<AtomicU32>,
    /// Peak level stored as fixed-point: value * 10000
    peak: Arc<AtomicU32>,
}

impl AudioLevelReader {
    fn new() -> (Self, AudioLevelWriter) {
        let rms = Arc::new(AtomicU32::new(0));
        let peak = Arc::new(AtomicU32::new(0));
        let reader = Self {
            rms: rms.clone(),
            peak: peak.clone(),
        };
        let writer = AudioLevelWriter { rms, peak };
        (reader, writer)
    }

    /// Load current (rms, peak) values as f32
    pub fn load(&self) -> (f32, f32) {
        let rms = self.rms.load(Ordering::Relaxed) as f32 / 10000.0;
        let peak = self.peak.load(Ordering::Relaxed) as f32 / 10000.0;
        (rms, peak)
    }
}

struct AudioLevelWriter {
    rms: Arc<AtomicU32>,
    peak: Arc<AtomicU32>,
}

impl AudioLevelWriter {
    fn store(&self, rms: f32, peak: f32) {
        self.rms.store((rms * 10000.0) as u32, Ordering::Relaxed);
        self.peak.store((peak * 10000.0) as u32, Ordering::Relaxed);
    }
}

pub struct AudioMixer {
    is_running: Arc<AtomicBool>,
    level_reader: AudioLevelReader,
    /// Thread handle for the mixer loop — join to ensure WAV is finalized
    pub join_handle: Option<std::thread::JoinHandle<()>>,
}

impl AudioMixer {
    /// Consume from mic (and optionally system audio), resample to 16kHz,
    /// write WAV file, and send PCM chunks to the transcription channel.
    ///
    /// Extended parameters:
    /// - `stereo`: write a stereo WAV (mic on left, system on right) 
    /// - `agc_enabled`: apply automatic gain control 
    /// - `noise_cancellation`: apply noise gate filtering 
    /// - `noise_gate_threshold`: configurable noise gate threshold 
    /// - `pause_flag`: when true, skip writing audio 
    ///
    /// Returns (Self, receiver of PCM chunks for transcription).
    #[allow(clippy::too_many_arguments)]
    pub fn start(
        mut mic_consumer: AudioConsumer,
        mic_sample_rate: u32,
        mut system_consumer: Option<AudioConsumer>,
        system_sample_rate: Option<u32>,
        wav_path: PathBuf,
        _stereo: bool,
        agc_enabled: bool,
        noise_cancellation: bool,
        noise_gate_threshold: f32,
        pause_flag: Arc<AtomicBool>,
    ) -> Result<(Self, mpsc::Receiver<Vec<f32>>)> {
        let is_running = Arc::new(AtomicBool::new(true));
        let running = is_running.clone();

        let (tx, rx) = mpsc::channel::<Vec<f32>>(100);
        let (level_reader, level_writer) = AudioLevelReader::new();

        let join_handle = std::thread::spawn(move || {
            let result = Self::run_loop(
                &mut mic_consumer,
                mic_sample_rate,
                &mut system_consumer,
                system_sample_rate,
                wav_path,
                tx,
                running,
                agc_enabled,
                noise_cancellation,
                noise_gate_threshold,
                pause_flag,
                level_writer,
            );
            if let Err(e) = result {
                eprintln!("audio mixer error: {}", e);
            }
        });

        Ok((Self { is_running, level_reader, join_handle: Some(join_handle) }, rx))
    }

    /// Get a clone of the audio level reader for the event emitter
    pub fn level_reader(&self) -> AudioLevelReader {
        self.level_reader.clone()
    }

    #[allow(clippy::too_many_arguments)]
    fn run_loop(
        mic_consumer: &mut AudioConsumer,
        mic_sample_rate: u32,
        system_consumer: &mut Option<AudioConsumer>,
        system_sample_rate: Option<u32>,
        wav_path: PathBuf,
        tx: mpsc::Sender<Vec<f32>>,
        running: Arc<AtomicBool>,
        agc_enabled: bool,
        noise_cancellation: bool,
        noise_gate_threshold: f32,
        pause_flag: Arc<AtomicBool>,
        level_writer: AudioLevelWriter,
    ) -> Result<()> {
        // Set up resamplers (for the 16kHz transcription pipeline)
        let mic_chunk_size = (mic_sample_rate as usize) / 10; // 100ms chunks
        let mut mic_resampler = if mic_sample_rate != TARGET_SAMPLE_RATE {
            Some(FftFixedIn::<f32>::new(
                mic_sample_rate as usize,
                TARGET_SAMPLE_RATE as usize,
                mic_chunk_size,
                1,
                1,
            )?)
        } else {
            None
        };

        let mut sys_resampler = match (system_consumer.as_ref(), system_sample_rate) {
            (Some(_), Some(rate)) if rate != TARGET_SAMPLE_RATE => {
                let sys_chunk_size = (rate as usize) / 10;
                Some(FftFixedIn::<f32>::new(
                    rate as usize,
                    TARGET_SAMPLE_RATE as usize,
                    sys_chunk_size,
                    1,
                    1,
                )?)
            }
            _ => None,
        };

        // WAV writer — mono at NATIVE mic sample rate for playback compatibility.
        // WKWebView cannot decode 16kHz WAV; writing at native rate (44100/48000Hz)
        // ensures the file plays in the in-app audio player and QuickTime.
        let spec = WavSpec {
            channels: 1,
            sample_rate: mic_sample_rate,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut wav_writer = WavWriter::create(wav_path, spec)?;

        let mut mic_accum = Vec::with_capacity(mic_chunk_size);
        let mut sys_accum: Vec<f32> = Vec::new();
        let mut read_buf = vec![0f32; mic_chunk_size];
        let mut output_buf = Vec::with_capacity(CHUNK_SAMPLES);

        // AGC state 
        let target_rms: f32 = 0.05;
        let mut agc_gain: f32 = 1.0;

        // Noise gate window 
        let noise_gate_window = 800; // 50ms at 16kHz

        while running.load(Ordering::Relaxed) {
            // If paused, skip processing but keep reading to avoid buffer overflow 
            if pause_flag.load(Ordering::Relaxed) {
                // Drain mic buffer to prevent buildup
                let drained = mic_consumer.pop_slice(&mut read_buf);
                if drained == 0 {
                    std::thread::sleep(std::time::Duration::from_millis(10));
                }
                // Also drain system audio if present, and clear accum so stale
                // audio doesn't bleed into the next active segment after resume.
                if let Some(sys_cons) = system_consumer.as_mut() {
                    let sys_chunk_size = system_sample_rate.unwrap_or(48000) as usize / 10;
                    let mut sys_drain = vec![0f32; sys_chunk_size];
                    let _ = sys_cons.pop_slice(&mut sys_drain);
                }
                sys_accum.clear();
                mic_accum.clear();
                continue;
            }

            // Read from mic ring buffer
            let mic_read = mic_consumer.pop_slice(&mut read_buf);
            if mic_read == 0 {
                std::thread::sleep(std::time::Duration::from_millis(5));
                continue;
            }

            mic_accum.extend_from_slice(&read_buf[..mic_read]);

            while mic_accum.len() >= mic_chunk_size {
                let mic_samples: Vec<f32> = mic_accum.drain(..mic_chunk_size).collect();

                let to_i16 = |s: f32| -> i16 {
                    (s * i16::MAX as f32).clamp(i16::MIN as f32, i16::MAX as f32) as i16
                };
                let sys_rate = system_sample_rate.unwrap_or(48000);
                let sys_chunk_size = sys_rate as usize / 10;

                // Read system audio ONCE — used for both WAV and transcription.
                let sys_raw: Option<Vec<f32>> = if let Some(sys_cons) = system_consumer.as_mut() {
                    let mut sys_buf = vec![0f32; sys_chunk_size];
                    let sys_read = sys_cons.pop_slice(&mut sys_buf);
                    if sys_read > 0 {
                        sys_buf.truncate(sys_read);
                        // Accumulate into sys_accum for the transcription path.
                        // This prevents silent drops when the ring buffer returns slightly
                        // fewer than sys_chunk_size samples due to SCStream/CPAL clock jitter.
                        sys_accum.extend_from_slice(&sys_buf);
                        Some(sys_buf)
                    } else {
                        None
                    }
                } else {
                    None
                };

                // WAV: write mic + system mixed at native rate.
                // When both sources are at the same rate (typical: both 48kHz on Mac),
                // mix them so the recording captures all participants (e.g. Zoom callers).
                // Falls back to mic-only when rates differ to avoid added resampler complexity.
                let wav_samples: Vec<f32> = if let Some(ref sys) = sys_raw {
                    if sys_rate == mic_sample_rate {
                        let len = mic_samples.len().min(sys.len());
                        let mut mixed = mic_samples.clone();
                        for i in 0..len {
                            mixed[i] = (mixed[i] + sys[i]).clamp(-1.0, 1.0);
                        }
                        mixed
                    } else {
                        mic_samples.clone()
                    }
                } else {
                    mic_samples.clone()
                };
                for &sample in &wav_samples {
                    wav_writer.write_sample(to_i16(sample))?;
                }

                // Resample mic to 16kHz for transcription
                let mic_16k = match &mut mic_resampler {
                    Some(resampler) => {
                        let input = vec![mic_samples];
                        match resampler.process(&input, None) {
                            Ok(output) => output.into_iter().next().unwrap_or_default(),
                            Err(e) => {
                                eprintln!("resample error: {}", e);
                                continue;
                            }
                        }
                    }
                    None => mic_samples,
                };

                // Resample system audio to 16kHz for transcription.
                // Drains from sys_accum (accumulated across ring-buffer reads) so that
                // timing jitter between SCStream and CPAL never silently drops a chunk.
                let sys_16k: Option<Vec<f32>> = if sys_accum.len() >= sys_chunk_size {
                    let sys_chunk: Vec<f32> = sys_accum.drain(..sys_chunk_size).collect();
                    match &mut sys_resampler {
                        Some(resampler) => {
                            let input = vec![sys_chunk];
                            match resampler.process(&input, None) {
                                Ok(output) => Some(output.into_iter().next().unwrap_or_default()),
                                Err(_) => None,
                            }
                        }
                        None => Some(sys_chunk),
                    }
                } else {
                    None
                };

                // Mix: sum mic + system, clamp to [-1,1]. Using sum (not average) means
                // the mic is not attenuated when system audio is silent, so VAD thresholds
                // are not affected when system audio has no content.
                let mixed_mono = match &sys_16k {
                    Some(sys) => {
                        let len = mic_16k.len().min(sys.len());
                        (0..len)
                            .map(|i| (mic_16k[i] + sys[i]).clamp(-1.0, 1.0))
                            .collect::<Vec<f32>>()
                    }
                    None => mic_16k.clone(),
                };

                // Apply noise gate if enabled 
                let processed = if noise_cancellation {
                    apply_noise_gate(&mixed_mono, noise_gate_threshold, noise_gate_window)
                } else {
                    mixed_mono.clone()
                };

                // Apply AGC if enabled 
                let final_mono = if agc_enabled {
                    apply_agc(&processed, &mut agc_gain, target_rms)
                } else {
                    processed
                };

                // Compute audio levels for the VU meter 
                let rms = calculate_rms(&final_mono);
                let peak = final_mono.iter().fold(0.0f32, |max, &s| max.max(s.abs()));
                level_writer.store(rms, peak);

                // Send mono PCM to transcription pipeline
                for &sample in &final_mono {
                    output_buf.push(sample);
                    if output_buf.len() >= CHUNK_SAMPLES {
                        let chunk = std::mem::replace(
                            &mut output_buf,
                            Vec::with_capacity(CHUNK_SAMPLES),
                        );
                        let _ = tx.try_send(chunk);
                    }
                }
            }
        }

        wav_writer.finalize()?;
        Ok(())
    }

    pub fn stop(&self) {
        self.is_running.store(false, Ordering::Relaxed);
    }
}

/// Calculate RMS energy of audio samples
fn calculate_rms(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    (samples.iter().map(|s| s * s).sum::<f32>() / samples.len() as f32).sqrt()
}

/// Configurable noise gate : attenuate windows below threshold
fn apply_noise_gate(samples: &[f32], threshold: f32, window_size: usize) -> Vec<f32> {
    let mut result = samples.to_vec();
    for window_start in (0..result.len()).step_by(window_size) {
        let window_end = (window_start + window_size).min(result.len());
        let window = &samples[window_start..window_end];
        let rms = calculate_rms(window);
        if rms < threshold {
            for sample in &mut result[window_start..window_end] {
                *sample *= 0.1;
            }
        }
    }
    result
}

/// Simple automatic gain control .
/// Adjusts gain toward a target RMS level with a slow attack/release.
fn apply_agc(samples: &[f32], gain: &mut f32, target_rms: f32) -> Vec<f32> {
    let rms = calculate_rms(samples);
    if rms > 0.001 {
        let desired_gain = target_rms / rms;
        // Clamp to reasonable range to avoid distortion
        let desired_gain = desired_gain.clamp(0.5, 4.0);
        // Smooth adjustment (90% old, 10% new)
        *gain = *gain * 0.9 + desired_gain * 0.1;
    }
    samples.iter().map(|&s| (s * *gain).clamp(-1.0, 1.0)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_audio_level_reader_initial_values_are_zero() {
        let (reader, _writer) = AudioLevelReader::new();
        let (rms, peak) = reader.load();
        assert_eq!(rms, 0.0);
        assert_eq!(peak, 0.0);
    }

    #[test]
    fn test_audio_level_writer_stores_values() {
        let (reader, writer) = AudioLevelReader::new();
        writer.store(0.5, 0.8);
        let (rms, peak) = reader.load();
        assert!((rms - 0.5).abs() < 0.0002, "RMS should be ~0.5, got {rms}");
        assert!((peak - 0.8).abs() < 0.0002, "Peak should be ~0.8, got {peak}");
    }

    #[test]
    fn test_audio_level_fixed_point_max_value() {
        let (reader, writer) = AudioLevelReader::new();
        writer.store(1.0, 1.0);
        let (rms, peak) = reader.load();
        assert!((rms - 1.0).abs() < 0.0002);
        assert!((peak - 1.0).abs() < 0.0002);
    }

    #[test]
    fn test_audio_level_zero_values() {
        let (reader, writer) = AudioLevelReader::new();
        writer.store(0.0, 0.0);
        let (rms, peak) = reader.load();
        assert_eq!(rms, 0.0);
        assert_eq!(peak, 0.0);
    }

    #[test]
    fn test_audio_level_reader_is_clone() {
        let (reader, writer) = AudioLevelReader::new();
        let reader2 = reader.clone();
        writer.store(0.3, 0.6);
        let (rms1, _) = reader.load();
        let (rms2, _) = reader2.load();
        assert!((rms1 - rms2).abs() < f32::EPSILON, "cloned reader must see same values");
    }

    #[test]
    fn test_audio_level_small_value_precision() {
        let (reader, writer) = AudioLevelReader::new();
        // Smallest representable value: 1/10000 = 0.0001
        writer.store(0.0001, 0.0001);
        let (rms, peak) = reader.load();
        assert!((rms - 0.0001).abs() < 0.0001);
        assert!((peak - 0.0001).abs() < 0.0001);
    }
}
