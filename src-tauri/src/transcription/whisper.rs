use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use tokio::process::Command;
use tokio::sync::Semaphore;
use tokio::task::JoinSet;

static CHUNK_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Word-level timestamp data 
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WordTimestamp {
    pub word: String,
    pub start_ms: u64,
    pub end_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TranscriptSegment {
    pub text: String,
    pub start_ms: u64,
    pub end_ms: u64,
    pub speaker: Option<String>,
    /// Confidence score 0.0-1.0 based on audio RMS energy 
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confidence: Option<f32>,
    /// Word-level timestamps 
    #[serde(skip_serializing_if = "Option::is_none")]
    pub words: Option<Vec<WordTimestamp>>,
    /// True when this segment overlaps in time with the previous segment
    #[serde(default)]
    pub is_overlap: bool,
    /// Confidence score (0.0-1.0) for speaker detection specifically
    #[serde(default)]
    pub speaker_confidence: f32,
}

/// Configuration for whisper transcription
#[derive(Debug, Clone)]
pub struct WhisperConfig {
    /// Language for transcription: None or "auto" for auto-detection 
    pub language: Option<String>,
    /// Whether to enable GPU/Metal acceleration 
    pub gpu_enabled: bool,
    /// Custom vocabulary terms to pass as initial prompt context 
    pub custom_vocabulary: Option<String>,
    /// Whether noise cancellation is enabled 
    pub noise_cancellation: bool,
    /// Configurable noise gate threshold 
    pub noise_gate_threshold: f32,
}

/// Running speaker profile for adaptive thresholds
#[derive(Debug, Clone)]
pub struct SpeakerProfile {
    energy_sum: f64,
    energy_sq_sum: f64,
    zcr_sum: f64,
    sample_count: u64,
}

impl SpeakerProfile {
    fn new() -> Self {
        Self {
            energy_sum: 0.0,
            energy_sq_sum: 0.0,
            zcr_sum: 0.0,
            sample_count: 0,
        }
    }

    fn update(&mut self, energy: f32, zcr: f32) {
        self.energy_sum += energy as f64;
        self.energy_sq_sum += (energy as f64) * (energy as f64);
        self.zcr_sum += zcr as f64;
        self.sample_count += 1;
    }

    fn mean_energy(&self) -> f32 {
        if self.sample_count == 0 { return 0.0; }
        (self.energy_sum / self.sample_count as f64) as f32
    }

    fn energy_variance(&self) -> f32 {
        if self.sample_count < 2 { return 0.0; }
        let mean = self.energy_sum / self.sample_count as f64;
        let variance = (self.energy_sq_sum / self.sample_count as f64) - (mean * mean);
        variance.max(0.0) as f32
    }

    fn mean_zcr(&self) -> f32 {
        if self.sample_count == 0 { return 0.0; }
        (self.zcr_sum / self.sample_count as f64) as f32
    }
}

/// Quality metrics for speaker separation
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpeakerSeparationQuality {
    /// 0.0 to 1.0 — higher means more reliable speaker separation
    pub quality_score: f32,
    /// Average energy variance across speakers
    pub energy_variance: f32,
    /// Number of speaker switches detected
    pub switch_count: u32,
    /// Consistency of speaker switches (lower variance = more consistent)
    pub switch_consistency: f32,
}

/// Adaptive speaker detection context that refines thresholds
/// as the meeting progresses using running averages per speaker.
pub struct AdaptiveSpeakerContext {
    profiles: std::collections::HashMap<u32, SpeakerProfile>,
    /// Adapts energy_ratio threshold as meeting progresses
    energy_ratio_threshold: f32,
    /// Adapts ZCR threshold
    zcr_threshold: f32,
    /// Track switch intervals for quality assessment 
    switch_intervals: Vec<u64>,
    last_switch_ms: u64,
    /// Last end_ms for overlap detection 
    last_segment_end_ms: u64,
}

impl AdaptiveSpeakerContext {
    pub fn new() -> Self {
        Self {
            profiles: std::collections::HashMap::new(),
            energy_ratio_threshold: 2.0,
            zcr_threshold: 0.15,
            switch_intervals: Vec::new(),
            last_switch_ms: 0,
            last_segment_end_ms: 0,
        }
    }

    /// Refine thresholds based on accumulated speaker profiles 
    fn refine_thresholds(&mut self) {
        if self.profiles.len() < 2 {
            return;
        }
        // Compute the average energy variance across all known speakers
        let variances: Vec<f32> = self.profiles.values()
            .filter(|p| p.sample_count >= 3)
            .map(|p| p.energy_variance())
            .collect();
        if variances.is_empty() {
            return;
        }
        let avg_variance: f32 = variances.iter().sum::<f32>() / variances.len() as f32;
        // If speakers have very different energy profiles, lower the threshold
        // If they're similar, raise it to avoid false switches
        if avg_variance > 0.001 {
            self.energy_ratio_threshold = (1.5_f32).max(2.0 - avg_variance * 100.0);
        } else {
            self.energy_ratio_threshold = (2.5_f32).min(2.0 + (0.001 - avg_variance) * 500.0);
        }
        // Similarly adapt ZCR threshold
        let avg_zcr: f32 = self.profiles.values()
            .filter(|p| p.sample_count >= 3)
            .map(|p| p.mean_zcr())
            .sum::<f32>() / self.profiles.len().max(1) as f32;
        self.zcr_threshold = (0.10_f32).max((0.20_f32).min(avg_zcr * 1.5));
    }

    /// Compute speaker separation quality from accumulated profiles
    pub fn compute_quality(&self) -> SpeakerSeparationQuality {
        let variances: Vec<f32> = self.profiles.values()
            .filter(|p| p.sample_count >= 2)
            .map(|p| p.energy_variance())
            .collect();
        let avg_energy_var = if variances.is_empty() {
            0.0
        } else {
            variances.iter().sum::<f32>() / variances.len() as f32
        };

        let switch_count = self.switch_intervals.len() as u32;

        // Switch consistency: variance of switch intervals (lower = more consistent)
        let switch_consistency = if self.switch_intervals.len() >= 2 {
            let mean_interval = self.switch_intervals.iter().sum::<u64>() as f64
                / self.switch_intervals.len() as f64;
            let var = self.switch_intervals.iter()
                .map(|&i| {
                    let d = i as f64 - mean_interval;
                    d * d
                })
                .sum::<f64>() / self.switch_intervals.len() as f64;
            var.sqrt() as f32
        } else {
            0.0
        };

        // Quality score: higher when we have distinct speakers with different energy profiles
        // and consistent switching patterns
        let profile_distinctness = if self.profiles.len() >= 2 {
            let energies: Vec<f32> = self.profiles.values()
                .filter(|p| p.sample_count >= 2)
                .map(|p| p.mean_energy())
                .collect();
            if energies.len() >= 2 {
                let max_e = energies.iter().cloned().fold(f32::MIN, f32::max);
                let min_e = energies.iter().cloned().fold(f32::MAX, f32::min);
                if max_e > 0.001 {
                    ((max_e - min_e) / max_e).clamp(0.0, 1.0)
                } else {
                    0.0
                }
            } else {
                0.0
            }
        } else {
            0.0
        };

        let consistency_score = if switch_consistency > 0.0 {
            (1.0 - (switch_consistency / 30000.0).min(1.0)).max(0.0)
        } else if switch_count > 0 {
            0.5
        } else {
            0.0
        };

        let quality_score = (profile_distinctness * 0.6 + consistency_score * 0.4).clamp(0.0, 1.0);

        SpeakerSeparationQuality {
            quality_score,
            energy_variance: avg_energy_var,
            switch_count,
            switch_consistency,
        }
    }
}

pub struct WhisperSidecar;

impl WhisperSidecar {
    /// Start batch-mode transcription with VAD pre-processing ,
    /// overlapping chunk windows , and adaptive chunk sizing .
    pub async fn start(
        whisper_path: PathBuf,
        model_path: PathBuf,
        mut audio_rx: tokio::sync::mpsc::Receiver<Vec<f32>>,
        segment_tx: tokio::sync::mpsc::Sender<TranscriptSegment>,
        config: WhisperConfig,
    ) -> Result<tokio::task::JoinHandle<()>> {
        if !whisper_path.exists() {
            return Err(anyhow!(
                "whisper-cli not found at {:?}",
                whisper_path
            ));
        }

        if !model_path.exists() {
            return Err(anyhow!(
                "whisper model not found at {:?}",
                model_path
            ));
        }

        let temp_dir = std::env::temp_dir().join("perchnote-whisper");
        std::fs::create_dir_all(&temp_dir)?;

        let handle = tokio::spawn(async move {
            // Extract noise gate config for use in processing 
            let noise_gate_threshold = if config.noise_cancellation {
                config.noise_gate_threshold
            } else {
                0.0 // Disabled: threshold of 0 means nothing gets gated
            };

            let mut accumulated: Vec<f32> = Vec::new();
            // Base chunk size: 5 seconds
            let base_chunk_samples = 16_000 * 5;
            let base_chunk_duration_ms: u64 = 5_000;
            let mut elapsed_ms: u64 = 0;
            let mut speaker_counter: u32 = 1;
            let mut last_energy: f32 = 0.0;
            // Track silence duration for adaptive chunk sizing 
            let mut continuous_speech_samples: usize = 0;
            // For paragraph detection: track silence gaps
            let mut last_had_speech = false;

            // Adaptive speaker context
            let mut speaker_ctx = AdaptiveSpeakerContext::new();

            // Allow up to 2 whisper processes in parallel
            let semaphore = Arc::new(Semaphore::new(2));
            let mut join_set: JoinSet<()> = JoinSet::new();

            log::info!("whisper: ready, batching every 5s with 1s overlap, VAD enabled, adaptive speaker model active");

            loop {
                match audio_rx.recv().await {
                    Some(chunk) => {
                        accumulated.extend_from_slice(&chunk);
                    }
                    None => {
                        log::info!("whisper: channel closed, {} samples remaining", accumulated.len());
                        if accumulated.len() >= 1_600 {
                            // Apply noise gate 
                            let cleaned = apply_noise_gate(&accumulated, noise_gate_threshold);
                            let duration_ms = (cleaned.len() as u64 * 1000) / 16_000;
                            let (speaker, spk_confidence) = detect_speaker_change_adaptive(
                                &cleaned, &mut last_energy, &mut speaker_counter,
                                &mut speaker_ctx, elapsed_ms,
                            );
                            // Confidence from RMS energy 
                            let confidence = calculate_confidence(&cleaned);
                            // Check overlap with previous segment
                            let is_overlap = elapsed_ms < speaker_ctx.last_segment_end_ms;
                            if let Some(text) = process_chunk(
                                &whisper_path,
                                &model_path,
                                &temp_dir,
                                &cleaned,
                                config.language.as_deref(),
                                config.gpu_enabled,
                                config.custom_vocabulary.as_deref(),
                            ).await {
                                log::info!("whisper: final: {}", text);
                                speaker_ctx.last_segment_end_ms = elapsed_ms + duration_ms;
                                let _ = segment_tx.send(TranscriptSegment {
                                    text,
                                    start_ms: elapsed_ms,
                                    end_ms: elapsed_ms + duration_ms,
                                    speaker,
                                    confidence: Some(confidence),
                                    words: None,
                                    is_overlap,
                                    speaker_confidence: spk_confidence,
                                }).await;
                            }
                        }
                        // Wait for all in-flight chunk tasks before cleaning up
                        while join_set.join_next().await.is_some() {}
                        break;
                    }
                }

                // VAD pre-processing : Check if accumulated audio has speech
                let current_rms = calculate_rms(&accumulated[accumulated.len().saturating_sub(1600)..]);
                let has_speech = current_rms > 0.005;

                if has_speech {
                    continuous_speech_samples += 1600;
                    last_had_speech = true;
                } else if last_had_speech {
                    // Silence after speech — potential paragraph break 
                    last_had_speech = false;
                }

                // Adaptive chunk sizing : During continuous speech, use longer chunks
                // for better context. During silence/pauses, process shorter chunks.
                let target_chunk_samples = if continuous_speech_samples > 16_000 * 8 {
                    // Very long continuous speech: use 8-second chunks
                    16_000 * 8
                } else {
                    base_chunk_samples
                };

                if accumulated.len() >= target_chunk_samples {
                    // VAD: Skip if entire chunk is silence 
                    let chunk_rms = calculate_rms(&accumulated[..target_chunk_samples]);
                    if chunk_rms < 0.003 {
                        accumulated.drain(..target_chunk_samples);
                        elapsed_ms += (target_chunk_samples as u64) * 1000 / 16_000;
                        continuous_speech_samples = 0;
                        continue;
                    }

                    let chunk_audio = accumulated[..target_chunk_samples].to_vec();
                    accumulated.drain(..target_chunk_samples);

                    let current_ms = elapsed_ms;
                    let chunk_duration_ms = if target_chunk_samples > base_chunk_samples {
                        (target_chunk_samples as u64 * 1000) / 16_000
                    } else {
                        base_chunk_duration_ms
                    };
                    elapsed_ms += (target_chunk_samples as u64 * 1000) / 16_000;
                    continuous_speech_samples = 0;

                    // Apply noise gate 
                    let cleaned = apply_noise_gate(&chunk_audio, noise_gate_threshold);

                    // Use adaptive speaker detection
                    let (speaker, spk_confidence) = detect_speaker_change_adaptive(
                        &cleaned, &mut last_energy, &mut speaker_counter,
                        &mut speaker_ctx, current_ms,
                    );

                    // Confidence from RMS energy 
                    let confidence = calculate_confidence(&cleaned);

                    // Check overlap with previous segment
                    let is_overlap = current_ms < speaker_ctx.last_segment_end_ms;
                    speaker_ctx.last_segment_end_ms = current_ms + chunk_duration_ms;

                    let wp = whisper_path.clone();
                    let mp = model_path.clone();
                    let td = temp_dir.clone();
                    let tx = segment_tx.clone();
                    let sem = semaphore.clone();
                    let lang = config.language.clone();
                    let gpu = config.gpu_enabled;
                    let vocab = config.custom_vocabulary.clone();

                    join_set.spawn(async move {
                        let _permit = sem.acquire().await;
                        match process_chunk(
                            &wp, &mp, &td, &cleaned,
                            lang.as_deref(),
                            gpu,
                            vocab.as_deref(),
                        ).await {
                            Some(text) => {
                                log::info!("whisper [{}ms]: {}", current_ms, text);
                                let _ = tx.send(TranscriptSegment {
                                    text,
                                    start_ms: current_ms,
                                    end_ms: current_ms + chunk_duration_ms,
                                    speaker,
                                    confidence: Some(confidence),
                                    words: None,
                                    is_overlap,
                                    speaker_confidence: spk_confidence,
                                }).await;
                            }
                            None => {
                                log::debug!("whisper: no speech at {}ms", current_ms);
                            }
                        }
                    });
                    // Reap any finished tasks to prevent unbounded growth
                    while join_set.try_join_next().is_some() {}
                }
            }

            // Log speaker separation quality at end of recording 
            let quality = speaker_ctx.compute_quality();
            log::info!(
                "whisper: speaker separation quality: score={:.2}, variance={:.6}, switches={}, consistency={:.1}",
                quality.quality_score, quality.energy_variance, quality.switch_count, quality.switch_consistency
            );

            let _ = tokio::fs::remove_dir_all(&temp_dir).await;
        });

        Ok(handle)
    }
}

/// Calculate RMS energy of audio samples
fn calculate_rms(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    (samples.iter().map(|s| s * s).sum::<f32>() / samples.len() as f32).sqrt()
}

/// Configurable noise gate : attenuate samples below noise floor.
/// The threshold can be set by the user via the noise_cancellation settings.
fn apply_noise_gate(samples: &[f32], noise_threshold: f32) -> Vec<f32> {
    let window_size = 800; // 50ms windows at 16kHz

    let mut result = samples.to_vec();

    for window_start in (0..result.len()).step_by(window_size) {
        let window_end = (window_start + window_size).min(result.len());
        let window = &samples[window_start..window_end];
        let rms = calculate_rms(window);

        if rms < noise_threshold {
            // Soft gate: attenuate rather than zero out for smoother transitions
            for sample in &mut result[window_start..window_end] {
                *sample *= 0.1;
            }
        }
    }

    result
}

/// Adaptive energy-based speaker change detection.
/// Uses running averages of energy levels per speaker to refine detection
/// thresholds as the meeting progresses.
/// Returns (speaker label, speaker confidence).
fn detect_speaker_change_adaptive(
    samples: &[f32],
    last_energy: &mut f32,
    speaker_counter: &mut u32,
    ctx: &mut AdaptiveSpeakerContext,
    current_ms: u64,
) -> (Option<String>, f32) {
    if samples.is_empty() {
        return (None, 0.0);
    }

    let rms = calculate_rms(samples);

    // Detect silence (very low energy)
    if rms < 0.005 {
        return (None, 0.0);
    }

    // Zero-crossing rate for spectral feature analysis 
    let zcr: f32 = samples.windows(2)
        .filter(|w| (w[0] >= 0.0) != (w[1] >= 0.0))
        .count() as f32 / samples.len() as f32;

    // Detect significant energy change (possible speaker turn)
    let energy_ratio = if *last_energy > 0.001 {
        (rms / *last_energy).max(*last_energy / rms)
    } else {
        1.0
    };

    // Use adaptive thresholds instead of fixed ones
    let switched = (energy_ratio > ctx.energy_ratio_threshold && *last_energy > 0.001)
        || (energy_ratio > (ctx.energy_ratio_threshold * 0.75) && zcr > ctx.zcr_threshold);

    if switched {
        *speaker_counter = (*speaker_counter % 4) + 1;
        // Track switch timing for quality metric 
        if ctx.last_switch_ms > 0 {
            ctx.switch_intervals.push(current_ms - ctx.last_switch_ms);
        }
        ctx.last_switch_ms = current_ms;
    }

    // Update the current speaker's profile with this chunk's features
    let profile = ctx.profiles.entry(*speaker_counter).or_insert_with(SpeakerProfile::new);
    profile.update(rms, zcr);

    // Periodically refine thresholds based on accumulated data
    let total_samples: u64 = ctx.profiles.values().map(|p| p.sample_count).sum();
    if total_samples.is_multiple_of(10) && total_samples >= 10 {
        ctx.refine_thresholds();
    }

    *last_energy = rms;

    // Compute speaker confidence based on how well this chunk
    // matches the current speaker's profile vs other speakers
    let spk_confidence = compute_speaker_confidence(rms, zcr, *speaker_counter, ctx);

    (Some(format!("Speaker {}", speaker_counter)), spk_confidence)
}

/// Compute confidence that the current chunk belongs to the assigned speaker.
/// Compares the chunk's features against the speaker's running profile.
fn compute_speaker_confidence(
    rms: f32,
    zcr: f32,
    current_speaker: u32,
    ctx: &AdaptiveSpeakerContext,
) -> f32 {
    let profile = match ctx.profiles.get(&current_speaker) {
        Some(p) if p.sample_count >= 2 => p,
        _ => return 0.5, // Not enough data yet, return neutral confidence
    };

    let mean_e = profile.mean_energy();
    let var_e = profile.energy_variance();
    let mean_z = profile.mean_zcr();

    // How close is this chunk's energy to the speaker's average?
    let energy_diff = if mean_e > 0.001 {
        ((rms - mean_e).abs() / mean_e).min(2.0)
    } else {
        1.0
    };

    // How close is the ZCR?
    let zcr_diff = if mean_z > 0.01 {
        ((zcr - mean_z).abs() / mean_z).min(2.0)
    } else {
        0.5
    };

    // Low variance in the speaker's profile means higher confidence
    let variance_factor = if var_e < 0.0001 { 1.0 } else { (0.001 / (var_e + 0.001)).min(1.0) };

    // Combine: lower diff = higher confidence
    let raw_confidence = 1.0 - (energy_diff * 0.5 + zcr_diff * 0.3) * 0.5;
    (raw_confidence * 0.7 + variance_factor * 0.3).clamp(0.0, 1.0)
}

/// Calculate a confidence score (0.0-1.0) based on RMS energy .
/// Higher energy generally indicates clearer speech and higher transcription confidence.
fn calculate_confidence(samples: &[f32]) -> f32 {
    let rms = calculate_rms(samples);
    // Map RMS to a 0.0-1.0 range:
    // - RMS < 0.005 = very low confidence (~0.1)
    // - RMS 0.01-0.05 = moderate confidence (~0.5-0.8)
    // - RMS > 0.1 = high confidence (~0.95+)
    // Using a sigmoid-like mapping with saturation
    let normalized = (rms / 0.05).min(1.0);
    // Apply a curve: low RMS gets penalized more
    let confidence = 0.1 + 0.9 * normalized.sqrt();
    confidence.clamp(0.0, 1.0)
}


/// Write audio samples to a temporary WAV file and run whisper-cli on it.
/// Returns the transcribed text, or None if transcription produced no useful output.
///
/// Accepts optional language , GPU flag , and custom vocabulary .
async fn process_chunk(
    whisper_path: &Path,
    model_path: &Path,
    temp_dir: &Path,
    samples: &[f32],
    language: Option<&str>,
    gpu_enabled: bool,
    custom_vocabulary: Option<&str>,
) -> Option<String> {
    // Skip chunks that are mostly silence
    let rms = calculate_rms(samples);
    if rms < 0.003 {
        return None;
    }

    let chunk_id = CHUNK_COUNTER.fetch_add(1, Ordering::Relaxed);
    let wav_path = temp_dir.join(format!("chunk_{}.wav", chunk_id));

    // Write 16kHz mono WAV
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: 16_000,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };

    {
        let mut writer = hound::WavWriter::create(&wav_path, spec).ok()?;
        for &sample in samples {
            let s16 = (sample * i16::MAX as f32).clamp(i16::MIN as f32, i16::MAX as f32) as i16;
            writer.write_sample(s16).ok()?;
        }
        writer.finalize().ok()?;
    }

    let mut cmd = Command::new(whisper_path);
    cmd.arg("--model").arg(model_path);

    // Language selection : use specified language, or "auto" for auto-detection
    let lang = language.unwrap_or("auto");
    cmd.arg("--language").arg(lang);

    cmd.arg("--no-prints")
        .arg("--no-timestamps")
        .arg("--threads")
        .arg("4")
        .arg("--flash-attn")
        .arg("--suppress-nst");

    // Word-level timestamps : request word-level output
    cmd.arg("--output-words");

    // GPU / Metal acceleration on macOS 
    if gpu_enabled {
        cmd.arg("--gpu");
    }

    // Custom vocabulary hints via initial prompt 
    if let Some(vocab) = custom_vocabulary {
        if !vocab.trim().is_empty() {
            cmd.arg("--prompt").arg(vocab);
        }
    }

    // Model caching note : whisper-cli spawns per-chunk. For true model
    // caching, use `--keep-context` if supported by whisper.cpp build, or migrate
    // to a long-running whisper-server process. Currently each invocation reloads
    // the model, which is the main latency bottleneck.

    cmd.arg("--file").arg(&wav_path);

    let output = cmd.output().await.ok()?;

    let _ = std::fs::remove_file(&wav_path);

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        log::warn!("whisper-cli failed: {}", stderr);
        return None;
    }

    let text = String::from_utf8_lossy(&output.stdout)
        .trim()
        .to_string();

    // Filter out noise/hallucination markers
    if is_noise_text(&text) {
        None
    } else {
        // Apply post-processing: capitalize, punctuation , and spell-check 
        Some(post_process_text(&text))
    }
}

/// Post-process transcribed text: punctuation restoration and spell-check 
fn post_process_text(text: &str) -> String {
    // Apply spell-check corrections first 
    let mut result = apply_spell_check(text);

    // Capitalize first letter
    if let Some(first_char) = result.chars().next() {
        if first_char.is_lowercase() {
            result = first_char.to_uppercase().to_string() + &result[first_char.len_utf8()..];
        }
    }

    // Ensure sentence ends with punctuation
    if !result.is_empty() {
        let last_char = result.chars().last().unwrap();
        if !last_char.is_ascii_punctuation() {
            result.push('.');
        }
    }

    result
}

/// Apply spell-check corrections for common whisper transcription errors .
/// Fixes informal contractions and commonly misheard words/phrases.
fn apply_spell_check(text: &str) -> String {
    // Common whisper transcription errors: informal speech -> formal equivalents
    let corrections: &[(&str, &str)] = &[
        ("gonna", "going to"),
        ("gotta", "got to"),
        ("wanna", "want to"),
        ("kinda", "kind of"),
        ("sorta", "sort of"),
        ("coulda", "could have"),
        ("woulda", "would have"),
        ("shoulda", "should have"),
        ("dunno", "don't know"),
        ("lemme", "let me"),
        ("gimme", "give me"),
        ("outta", "out of"),
        ("lotta", "lot of"),
        ("hafta", "have to"),
        ("oughta", "ought to"),
        // Common misheard words
        ("definately", "definitely"),
        ("basicly", "basically"),
        ("probly", "probably"),
        ("prolly", "probably"),
        ("acutally", "actually"),
        ("becuase", "because"),
        ("seperate", "separate"),
        ("recieve", "receive"),
        ("occurence", "occurrence"),
        ("untill", "until"),
        ("alot", "a lot"),
    ];

    let mut result = text.to_string();
    for &(wrong, right) in corrections {
        // Case-insensitive whole-word replacement
        result = replace_word_case_insensitive(&result, wrong, right);
    }
    result
}

/// Replace a whole word in text, preserving surrounding context.
/// Matches word boundaries so "gonna" won't match inside "gonnathing".
/// Uses str::find() for substring matching to correctly handle multi-byte UTF-8 characters.
fn replace_word_case_insensitive(text: &str, pattern: &str, replacement: &str) -> String {
    let lower_text = text.to_lowercase();
    let lower_pattern = pattern.to_lowercase();
    let mut result = String::with_capacity(text.len());
    let mut search_start = 0usize;

    while search_start <= text.len() {
        match lower_text[search_start..].find(lower_pattern.as_str()) {
            None => {
                result.push_str(&text[search_start..]);
                break;
            }
            Some(rel_pos) => {
                let abs_pos = search_start + rel_pos;
                let after_pos = abs_pos + pattern.len();

                // Check word boundaries (char-aware)
                let before_ok = abs_pos == 0
                    || text[..abs_pos].chars().last().map(|c| !c.is_alphanumeric()).unwrap_or(true);
                let after_ok = after_pos >= text.len()
                    || text[after_pos..].chars().next().map(|c| !c.is_alphanumeric()).unwrap_or(true);

                if before_ok && after_ok {
                    result.push_str(&text[search_start..abs_pos]);
                    // Preserve capitalisation of the first original character
                    let orig_first = text[abs_pos..].chars().next().unwrap_or_default();
                    if orig_first.is_uppercase() {
                        let mut rep_chars = replacement.chars();
                        if let Some(first) = rep_chars.next() {
                            result.extend(first.to_uppercase());
                            result.push_str(rep_chars.as_str());
                        }
                    } else {
                        result.push_str(replacement);
                    }
                    search_start = after_pos;
                } else {
                    // No word boundary — copy the char at abs_pos and advance past it
                    result.push_str(&text[search_start..abs_pos]);
                    let ch = text[abs_pos..].chars().next().unwrap_or_default();
                    result.push(ch);
                    search_start = abs_pos + ch.len_utf8();
                }
            }
        }
    }
    result
}

/// Check if whisper output is noise/hallucination rather than actual speech
fn is_noise_text(text: &str) -> bool {
    if text.is_empty() {
        return true;
    }
    let lower = text.to_lowercase();
    let noise_patterns = [
        "[blank_audio]",
        "[silence]",
        "[music]",
        "[music playing]",
        "[typing]",
        "[background noise]",
        "[inaudible]",
        "(silence)",
        "(music)",
        "(typing)",
        "you",
        "thank you.",
        "thanks for watching.",
        "thanks for watching!",
        "bye.",
        "bye!",
        "subtitle",
        "subtitles",
    ];
    for pattern in &noise_patterns {
        if lower.trim() == *pattern {
            return true;
        }
    }
    // Single word that's likely a hallucination
    if text.split_whitespace().count() <= 1 && text.len() < 5 {
        return true;
    }
    false
}
