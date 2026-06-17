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

/// Resampler from one rate to another, or None when they already match.
/// Input chunk size is always 100ms of the source rate — every drain site
/// in the loop derives from the same convention. `channels` > 1 only for
/// the stereo WAV output path (L/R processed as parallel planes).
fn build_opt_resampler_ch(from: u32, to: u32, channels: usize) -> Result<Option<FftFixedIn<f32>>> {
    if from == to {
        return Ok(None);
    }
    Ok(Some(FftFixedIn::<f32>::new(
        from as usize,
        to as usize,
        from as usize / 10,
        1,
        channels,
    )?))
}

fn build_opt_resampler(from: u32, to: u32) -> Result<Option<FftFixedIn<f32>>> {
    build_opt_resampler_ch(from, to, 1)
}

/// Open the meeting's WAV for this mixer session: APPEND to a valid
/// existing file, else create fresh. Returns the writer and the rate the
/// file is actually at — the existing file's spec wins, and a session
/// whose mic runs at a different rate resamples into it.
///
/// This is the fix for the mic-switch data-loss bug: a switch is
/// stop+start on the same path, and `WavWriter::create` TRUNCATED
/// everything recorded so far while the transcript (which appends) kept
/// citing moments that no longer existed in the audio.
fn open_or_append_wav(
    path: &std::path::Path,
    desired: WavSpec,
) -> Result<(WavWriter<std::io::BufWriter<std::fs::File>>, WavSpec)> {
    if path.exists() {
        match WavWriter::append(path) {
            Ok(writer) => {
                let spec = writer.spec();
                log::info!(
                    "WAV: appending to existing recording ({}Hz, {}ch)",
                    spec.sample_rate,
                    spec.channels
                );
                return Ok((writer, spec));
            }
            Err(e) => {
                // Unreadable header (e.g. zero-byte crash leftover):
                // preserve it for the repair tooling rather than overwrite.
                log::warn!("WAV append failed ({e}); moving the old file aside");
                let aside = path.with_extension("wav.prev");
                let _ = std::fs::rename(path, aside);
            }
        }
    }
    Ok((WavWriter::create(path, desired)?, desired))
}

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
    /// False once the mixer thread has exited — by completing, erroring, or
    /// panicking. While a recording is supposedly active, `false` here means
    /// audio is silently no longer being captured; the level-monitor task
    /// watches this and warns the user.
    alive: Arc<AtomicBool>,
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
    #[allow(clippy::too_many_arguments)]
    pub fn start(
        mut mic_consumer: AudioConsumer,
        mic_sample_rate: u32,
        mut system_consumer: Option<AudioConsumer>,
        system_sample_rate: Option<u32>,
        wav_path: PathBuf,
        stereo: bool,
        agc_enabled: bool,
        noise_cancellation: bool,
        noise_gate_threshold: f32,
        pause_flag: Arc<AtomicBool>,
        mic_swap: Arc<super::swap::SourceSwap>,
        sys_swap: Arc<super::swap::SourceSwap>,
    ) -> Result<(Self, mpsc::Receiver<Vec<f32>>)> {
        let is_running = Arc::new(AtomicBool::new(true));
        let running = is_running.clone();

        let (tx, rx) = mpsc::channel::<Vec<f32>>(100);
        let (level_reader, level_writer) = AudioLevelReader::new();

        let alive = Arc::new(AtomicBool::new(true));
        let thread_alive = alive.clone();

        let join_handle = std::thread::spawn(move || {
            // catch_unwind: a panic in the loop must not die silently — the
            // recording would keep "running" in the UI while capturing
            // nothing. The alive flag below is how the rest of the app
            // learns the thread is gone (hound's WavWriter finalizes its
            // header on drop during unwind, so the WAV stays playable).
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                Self::run_loop(
                    &mut mic_consumer,
                    mic_sample_rate,
                    &mut system_consumer,
                    system_sample_rate,
                    wav_path,
                    stereo,
                    tx,
                    running,
                    agc_enabled,
                    noise_cancellation,
                    noise_gate_threshold,
                    pause_flag,
                    level_writer,
                    &mic_swap,
                    &sys_swap,
                )
            }));
            match result {
                Ok(Err(e)) => log::error!("audio mixer error: {}", e),
                Err(_) => log::error!("audio mixer thread panicked — capture stopped"),
                Ok(Ok(())) => {}
            }
            thread_alive.store(false, Ordering::Relaxed);
        });

        Ok((Self { is_running, alive, level_reader, join_handle: Some(join_handle) }, rx))
    }

    /// Get a clone of the audio level reader for the event emitter
    pub fn level_reader(&self) -> AudioLevelReader {
        self.level_reader.clone()
    }

    /// Liveness flag for the mixer thread — see the `alive` field.
    pub fn alive_flag(&self) -> Arc<AtomicBool> {
        self.alive.clone()
    }

    #[allow(clippy::too_many_arguments)]
    fn run_loop(
        mic_consumer: &mut AudioConsumer,
        mut mic_sample_rate: u32,
        system_consumer: &mut Option<AudioConsumer>,
        mut system_sample_rate: Option<u32>,
        wav_path: PathBuf,
        stereo_requested: bool,
        tx: mpsc::Sender<Vec<f32>>,
        running: Arc<AtomicBool>,
        agc_enabled: bool,
        noise_cancellation: bool,
        noise_gate_threshold: f32,
        pause_flag: Arc<AtomicBool>,
        level_writer: AudioLevelWriter,
        mic_swap: &super::swap::SourceSwap,
        sys_swap: &super::swap::SourceSwap,
    ) -> Result<()> {
        // Set up resamplers (for the 16kHz transcription pipeline)
        let mut mic_chunk_size = (mic_sample_rate as usize) / 10; // 100ms chunks
        let mut mic_resampler = build_opt_resampler(mic_sample_rate, TARGET_SAMPLE_RATE)?;

        let mut sys_resampler = match (system_consumer.as_ref(), system_sample_rate) {
            (Some(_), Some(rate)) => build_opt_resampler(rate, TARGET_SAMPLE_RATE)?,
            _ => None,
        };

        // System→mic-rate resampler for the WAV path (plan v2 rank 2).
        // Without it, saved recordings silently dropped remote participants
        // whenever the mic rate (Bluetooth: 16k/24k) differed from the
        // 48kHz system tap — playback and chip verification lost them.
        let mut wav_sys_resampler = match (system_consumer.as_ref(), system_sample_rate) {
            (Some(_), Some(rate)) => build_opt_resampler(rate, mic_sample_rate)?,
            _ => None,
        };
        let mut wav_sys_in: Vec<f32> = Vec::new(); // raw sys awaiting resample
        let mut wav_sys_out: Vec<f32> = Vec::new(); // resampled to mic rate
        let mut wav_resample_logged = false;

        // WAV writer — floored at 44.1kHz (robustness 14): WKWebView
        // cannot decode 16kHz WAV, and a Bluetooth-HFP mic (AirPods as
        // input: 16/24k) would otherwise produce an unplayable recording.
        // The mic→file resampler below upsamples low-rate sessions into the
        // file. Stereo (plan v9 #9): mic on L, system on R — playback you
        // can lateralize, and a clean local/remote signal for later passes.
        // (Known limit: with system audio on, the mix still happens at the
        // mic rate before this — the mix-rate decoupling is a v2.)
        let spec = WavSpec {
            channels: if stereo_requested { 2 } else { 1 },
            sample_rate: mic_sample_rate.max(44_100),
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let (mut wav_writer, wav_spec) = open_or_append_wav(&wav_path, spec)?;
        let wav_rate = wav_spec.sample_rate;
        // The EXISTING file's layout wins on append — a mono recording
        // continued after toggling the stereo setting stays mono (and vice
        // versa); mixing layouts mid-file would corrupt every later frame.
        let stereo = wav_spec.channels == 2;
        if stereo != stereo_requested {
            log::info!(
                "WAV: continuing existing {}-channel file; stereo setting applies from the next meeting",
                wav_spec.channels
            );
        }

        // Continuing a file recorded at a different rate (mic switched to
        // AirPods at 16/24k, or vice versa): the mixed output resamples
        // into the file's original timeline instead of corrupting pitch.
        if wav_rate != mic_sample_rate {
            log::info!("WAV path: resampling session {}Hz → file {}Hz", mic_sample_rate, wav_rate);
        }
        let wav_channels = if stereo { 2 } else { 1 };
        let mut wav_out_resampler = build_opt_resampler_ch(mic_sample_rate, wav_rate, wav_channels)?;
        let mut wav_out_in: Vec<f32> = Vec::new();
        let mut wav_out_in_r: Vec<f32> = Vec::new();

        let mut talk = crate::audio::talkstats::TalkTracker::new();
        let mut mic_accum = Vec::with_capacity(mic_chunk_size);
        let mut sys_accum: Vec<f32> = Vec::new();
        let mut read_buf = vec![0f32; mic_chunk_size];
        let mut output_buf = Vec::with_capacity(CHUNK_SAMPLES);

        // AGC state 
        let target_rms: f32 = 0.05;
        let mut agc_gain: f32 = 1.0;

        // Noise gate window
        let noise_gate_window = 800; // 50ms at 16kHz

        // Drop accounting — capture callbacks count what they couldn't push;
        // we drain and report here so overload is loud instead of silent.
        let mut tx_dropped_samples: u64 = 0;
        let mut last_drop_report = std::time::Instant::now();
        // Mic-stall pacing (plan v2 rank 7): when the mic dies mid-recording
        // we keep the timeline moving with mic-side silence so system audio
        // keeps being written and later m:ss anchors stay aligned.
        let mut last_mic_data = std::time::Instant::now();
        let mut last_sys_data = std::time::Instant::now();
        // Hot-swap cursors (the capture-supervisor design §1d).
        let (mut mic_seq, mut sys_seq) = (0u64, 0u64);

        while running.load(Ordering::Relaxed) {
            // ── Hot-swap check: one relaxed load each in steady state.
            // Sits ABOVE the pause branch so a queued swap applies even
            // while paused. The WAV file's rate never changes — a swapped
            // source at a new rate rides the same resample-into-the-file
            // machinery the append-session path built.
            if let Some(p) = mic_swap.take_if_new(&mut mic_seq) {
                *mic_consumer = p.consumer;
                if p.sample_rate != mic_sample_rate {
                    mic_sample_rate = p.sample_rate;
                    mic_chunk_size = mic_sample_rate as usize / 10;
                    read_buf = vec![0f32; mic_chunk_size];
                    mic_accum.clear();
                    mic_resampler = build_opt_resampler(mic_sample_rate, TARGET_SAMPLE_RATE)?;
                    wav_sys_resampler = match (system_consumer.as_ref(), system_sample_rate) {
                        (Some(_), Some(rate)) => build_opt_resampler(rate, mic_sample_rate)?,
                        _ => None,
                    };
                    wav_sys_in.clear();
                    wav_sys_out.clear(); // old-rate FIFO would pitch-shift
                    wav_out_resampler =
                        build_opt_resampler_ch(mic_sample_rate, wav_rate, wav_channels)?;
                    wav_out_in.clear();
                    wav_out_in_r.clear();
                }
                last_mic_data = std::time::Instant::now();
                super::MIC_STALL_MS.store(0, Ordering::Relaxed);
                log::info!("mixer: mic source swapped to '{}' @ {}Hz", p.label, mic_sample_rate);
            }
            if let Some(p) = sys_swap.take_if_new(&mut sys_seq) {
                *system_consumer = Some(p.consumer);
                if system_sample_rate != Some(p.sample_rate) {
                    system_sample_rate = Some(p.sample_rate);
                    sys_resampler = build_opt_resampler(p.sample_rate, TARGET_SAMPLE_RATE)?;
                    wav_sys_resampler = build_opt_resampler(p.sample_rate, mic_sample_rate)?;
                }
                sys_accum.clear();
                wav_sys_in.clear(); // raw samples at the old rate
                // Reset the wall clock too (the mic-swap block does): an
                // empty first tick from the fresh tap would otherwise store
                // last_sys_data.elapsed() — the PRE-swap stall, ≥12s — and
                // the supervisor's instantaneous stall threshold would fire
                // a spurious rebuild right after the successful one.
                last_sys_data = std::time::Instant::now();
                super::SYS_STALL_MS.store(0, Ordering::Relaxed);
                super::SYS_ZERO_RUN_MS.store(0, Ordering::Relaxed);
                log::info!("mixer: system source swapped ({}) @ {}Hz", p.label, p.sample_rate);
            }
            if last_drop_report.elapsed().as_secs() >= 10 {
                let mic_d = super::MIC_DROPPED_SAMPLES.swap(0, Ordering::Relaxed);
                let sys_d = super::SYS_DROPPED_SAMPLES.swap(0, Ordering::Relaxed);
                if mic_d > 0 || sys_d > 0 || tx_dropped_samples > 0 {
                    log::warn!(
                        "audio drops in last 10s — mic: {} samples, system: {} samples, \
                         transcription queue: {} samples (transcription may be slower than realtime)",
                        mic_d, sys_d, tx_dropped_samples
                    );
                }
                tx_dropped_samples = 0;
                last_drop_report = std::time::Instant::now();
            }
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
                // A pause is not a stall (QA audit finding 5): without these
                // resets, the first empty read after a >5s pause reported the
                // whole pause as MIC_STALL_MS and fired a false "mic silent"
                // alarm on resume. Same for the supervisor observations.
                last_mic_data = std::time::Instant::now();
                last_sys_data = std::time::Instant::now();
                super::MIC_STALL_MS.store(0, Ordering::Relaxed);
                super::SYS_STALL_MS.store(0, Ordering::Relaxed);
                super::SYS_ZERO_RUN_MS.store(0, Ordering::Relaxed);
                continue;
            }

            // Read from mic ring buffer
            let mic_read = mic_consumer.pop_slice(&mut read_buf);
            if mic_read == 0 {
                let stalled = last_mic_data.elapsed();
                super::MIC_STALL_MS.store(stalled.as_millis() as u64, Ordering::Relaxed);
                if stalled.as_millis() > 250 {
                    // Mic is stalled but the meeting continues: advance with
                    // silence at roughly realtime pace (one 100ms chunk per
                    // 100ms). With system audio present this keeps it flowing
                    // into the WAV; mic-only, it keeps the timeline honest —
                    // a frozen WAV would corrupt every transcript anchor and
                    // elapsed-time display from the stall onward.
                    mic_accum.extend(std::iter::repeat(0.0f32).take(mic_chunk_size));
                    std::thread::sleep(std::time::Duration::from_millis(100));
                } else {
                    std::thread::sleep(std::time::Duration::from_millis(5));
                    continue;
                }
            } else {
                last_mic_data = std::time::Instant::now();
                super::MIC_STALL_MS.store(0, Ordering::Relaxed);
                mic_accum.extend_from_slice(&read_buf[..mic_read]);
            }

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
                    // Supervisor observation (design §2): a started IOProc
                    // fires at the device clock regardless of content, so an
                    // empty ring here is breakage, not silence.
                    if sys_read > 0 {
                        last_sys_data = std::time::Instant::now();
                        super::SYS_STALL_MS.store(0, Ordering::Relaxed);
                    } else {
                        super::SYS_STALL_MS
                            .store(last_sys_data.elapsed().as_millis() as u64, Ordering::Relaxed);
                    }
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

                // Talk balance (plan v3 rank 8): per-tick VAD on each side
                // BEFORE mixdown — the only moment "you" and "them" exist
                // separately. Snapshot to atomics for stop-time persistence.
                {
                    use std::sync::atomic::Ordering;
                    let mic_rms = crate::audio::talkstats::window_rms(&mic_samples);
                    let sys_rms = sys_raw
                        .as_deref()
                        .map(crate::audio::talkstats::window_rms)
                        .unwrap_or(0.0);
                    talk.feed(mic_rms, sys_rms, 100);
                    crate::audio::TALK_MIC_MS.store(talk.mic_ms, Ordering::Relaxed);
                    crate::audio::TALK_SYS_MS.store(talk.sys_ms, Ordering::Relaxed);
                    crate::audio::TALK_LONGEST_MONO_MS.store(talk.longest_mono_ms, Ordering::Relaxed);

                    // Supervisor observations (design §2): bit-exact zeros
                    // from a delivering tap = the broken-tap signature
                    // (real playback at any volume breaks the run); mic
                    // voice recency is the conversation-evidence gate.
                    if sys_raw.is_some() {
                        if sys_rms == 0.0 {
                            super::SYS_ZERO_RUN_MS.fetch_add(100, Ordering::Relaxed);
                        } else {
                            super::SYS_ZERO_RUN_MS.store(0, Ordering::Relaxed);
                        }
                    }
                    if mic_rms > crate::audio::talkstats::ACTIVE_RMS {
                        super::MIC_LAST_VOICE_AGO_MS.store(0, Ordering::Relaxed);
                    } else {
                        super::MIC_LAST_VOICE_AGO_MS.fetch_add(100, Ordering::Relaxed);
                    }
                }

                // WAV: write mic + system mixed at native rate. Same-rate
                // sources mix directly; differing rates go through the
                // dedicated resampler so remote participants are never
                // dropped from the saved recording (plan v2 rank 2).
                if let Some(rs) = wav_sys_resampler.as_mut() {
                    if let Some(ref sys) = sys_raw {
                        if !wav_resample_logged {
                            wav_resample_logged = true;
                            log::info!(
                                "WAV path: resampling system audio {}Hz → {}Hz",
                                sys_rate, mic_sample_rate
                            );
                        }
                        wav_sys_in.extend_from_slice(sys);
                        while wav_sys_in.len() >= sys_chunk_size {
                            let chunk: Vec<f32> = wav_sys_in.drain(..sys_chunk_size).collect();
                            if let Ok(out) = rs.process(&[chunk], None) {
                                if let Some(o) = out.into_iter().next() {
                                    wav_sys_out.extend(o);
                                }
                            }
                        }
                    }
                }
                // System audio at the mic rate for this iteration: the
                // same-rate fast path reads sys_raw directly; rate-mismatch
                // drains the resampled FIFO. In mono it sums into the mic;
                // in stereo it IS the right channel.
                let mut sys_at_mic_rate: Vec<f32> = vec![0.0; mic_samples.len()];
                if let Some(ref sys) = sys_raw {
                    if sys_rate == mic_sample_rate {
                        let len = sys_at_mic_rate.len().min(sys.len());
                        sys_at_mic_rate[..len].copy_from_slice(&sys[..len]);
                    }
                }
                if !wav_sys_out.is_empty() {
                    let take = sys_at_mic_rate.len().min(wav_sys_out.len());
                    for (slot, s) in sys_at_mic_rate.iter_mut().zip(wav_sys_out.drain(..take)) {
                        *slot = (*slot + s).clamp(-1.0, 1.0);
                    }
                    // Bound FIFO growth under clock drift (~1s cap).
                    if wav_sys_out.len() > mic_sample_rate as usize {
                        let keep = mic_sample_rate as usize / 2;
                        let cut = wav_sys_out.len() - keep;
                        wav_sys_out.drain(..cut);
                    }
                }

                if stereo {
                    // L = mic, R = system. Resampling (append-session rate
                    // mismatch) processes the planes together so they can't
                    // drift; interleave at write time.
                    if let Some(rs) = wav_out_resampler.as_mut() {
                        wav_out_in.extend_from_slice(&mic_samples);
                        wav_out_in_r.extend_from_slice(&sys_at_mic_rate);
                        while wav_out_in.len() >= mic_chunk_size
                            && wav_out_in_r.len() >= mic_chunk_size
                        {
                            let l: Vec<f32> = wav_out_in.drain(..mic_chunk_size).collect();
                            let r: Vec<f32> = wav_out_in_r.drain(..mic_chunk_size).collect();
                            if let Ok(out) = rs.process(&[l, r], None) {
                                let mut planes = out.into_iter();
                                let (lo, ro) = (
                                    planes.next().unwrap_or_default(),
                                    planes.next().unwrap_or_default(),
                                );
                                for i in 0..lo.len().min(ro.len()) {
                                    wav_writer.write_sample(to_i16(lo[i]))?;
                                    wav_writer.write_sample(to_i16(ro[i]))?;
                                }
                            }
                        }
                    } else {
                        for i in 0..mic_samples.len() {
                            wav_writer.write_sample(to_i16(mic_samples[i]))?;
                            wav_writer.write_sample(to_i16(sys_at_mic_rate[i]))?;
                        }
                    }
                } else {
                    let wav_samples: Vec<f32> = mic_samples
                        .iter()
                        .zip(sys_at_mic_rate.iter())
                        .map(|(m, s)| (m + s).clamp(-1.0, 1.0))
                        .collect();
                    if let Some(rs) = wav_out_resampler.as_mut() {
                        wav_out_in.extend_from_slice(&wav_samples);
                        while wav_out_in.len() >= mic_chunk_size {
                            let chunk: Vec<f32> = wav_out_in.drain(..mic_chunk_size).collect();
                            if let Ok(out) = rs.process(&[chunk], None) {
                                if let Some(o) = out.into_iter().next() {
                                    for &sample in &o {
                                        wav_writer.write_sample(to_i16(sample))?;
                                    }
                                }
                            }
                        }
                    } else {
                        for &sample in &wav_samples {
                            wav_writer.write_sample(to_i16(sample))?;
                        }
                    }
                }

                // Resample mic to 16kHz for transcription
                let mic_16k = match &mut mic_resampler {
                    Some(resampler) => {
                        let input = vec![mic_samples];
                        match resampler.process(&input, None) {
                            Ok(output) => output.into_iter().next().unwrap_or_default(),
                            Err(e) => {
                                log::error!("mic resample error (100ms chunk lost to transcription): {}", e);
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
                        if tx.try_send(chunk).is_err() {
                            tx_dropped_samples += CHUNK_SAMPLES as u64;
                        }
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

    fn test_spec(rate: u32) -> WavSpec {
        WavSpec {
            channels: 1,
            sample_rate: rate,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        }
    }

    #[test]
    fn second_session_appends_instead_of_truncating() {
        let dir = std::env::temp_dir().join(format!("perch-wav-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("append.wav");

        // Session 1: 1000 samples.
        let (mut w, spec) = open_or_append_wav(&path, test_spec(48_000)).unwrap();
        assert_eq!(spec.sample_rate, 48_000);
        for i in 0..1000 {
            w.write_sample((i % 100) as i16).unwrap();
        }
        w.finalize().unwrap();

        // Session 2 (mic switch): must APPEND — and report the file's rate
        // even when the new session asks for a different one.
        let (mut w, spec) = open_or_append_wav(&path, test_spec(44_100)).unwrap();
        assert_eq!(spec.sample_rate, 48_000, "existing file's rate must win");
        for _ in 0..500 {
            w.write_sample(7i16).unwrap();
        }
        w.finalize().unwrap();

        let reader = hound::WavReader::open(&path).unwrap();
        assert_eq!(reader.duration(), 1500, "both sessions' audio must survive");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn corrupt_existing_file_is_moved_aside_not_overwritten() {
        let dir = std::env::temp_dir().join(format!("perch-wav-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("corrupt.wav");
        std::fs::write(&path, b"not a wav at all").unwrap();

        let (w, spec) = open_or_append_wav(&path, test_spec(48_000)).unwrap();
        assert_eq!(spec.sample_rate, 48_000);
        drop(w);

        let aside = path.with_extension("wav.prev");
        assert!(aside.exists(), "unreadable original must be preserved aside");
        assert_eq!(std::fs::read(&aside).unwrap(), b"not a wav at all");
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(&aside);
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

    // ── Scripted-consumer integration tests ─────────────────────────────
    // the capture-supervisor design "Test strategy" item 3: drive
    // AudioMixer::start end-to-end with ring producers fed from threads
    // and a tempfile WAV, then assert on the supervisor observations and
    // the finalized file.
    //
    // The observations (SYS_ZERO_RUN_MS, SYS_STALL_MS, MIC_STALL_MS,
    // MIC_LAST_VOICE_AGO_MS) are GLOBAL atomics, so two mixers running in
    // parallel would interleave writes — every test below is #[serial].
    // The rest of this module (and the supervise/swap/talkstats tests)
    // touch only instance-local state and stay parallel.

    use crate::audio::ringbuf::{create_audio_ring, AudioProducer};
    use crate::audio::swap::{SourceSwap, SwapPayload};
    use ringbuf::traits::Producer;
    use serial_test::serial;

    fn sleep_ms(ms: u64) {
        std::thread::sleep(std::time::Duration::from_millis(ms));
    }

    /// Known baseline for the global observations — tests inherit whatever
    /// the previous mixer run left behind otherwise.
    fn reset_observation_atomics() {
        crate::audio::MIC_STALL_MS.store(0, Ordering::Relaxed);
        crate::audio::SYS_STALL_MS.store(0, Ordering::Relaxed);
        crate::audio::SYS_ZERO_RUN_MS.store(0, Ordering::Relaxed);
        crate::audio::MIC_LAST_VOICE_AGO_MS.store(600_000, Ordering::Relaxed);
    }

    /// Feed `rate`-Hz audio into `prod` in 20ms bites at roughly realtime
    /// pace until `run` goes false. `amplitude == 0.0` produces bit-exact
    /// digital zeros (the broken-tap signature the zero-run detector keys
    /// on); otherwise a 440Hz sine whose RMS (amplitude/√2) sits far above
    /// talkstats::ACTIVE_RMS (0.01). Returns samples actually pushed
    /// (ring-full shortfalls excluded).
    fn spawn_feeder(
        mut prod: AudioProducer,
        rate: u32,
        amplitude: f32,
        run: Arc<AtomicBool>,
    ) -> std::thread::JoinHandle<u64> {
        std::thread::spawn(move || {
            let bite = rate as usize / 50; // 20ms of samples
            let mut buf = vec![0f32; bite];
            let step = 2.0 * std::f32::consts::PI * 440.0 / rate as f32;
            let mut phase = 0f32;
            let mut pushed = 0u64;
            while run.load(Ordering::Relaxed) {
                if amplitude > 0.0 {
                    for s in buf.iter_mut() {
                        *s = amplitude * phase.sin();
                        phase += step;
                        if phase > 2.0 * std::f32::consts::PI {
                            phase -= 2.0 * std::f32::consts::PI;
                        }
                    }
                }
                pushed += prod.push_slice(&buf) as u64;
                sleep_ms(20);
            }
            pushed
        })
    }

    /// Start a mixer with the processing toggles off (no AGC, no gate) and
    /// a thread draining the transcription channel so sends never back up.
    fn start_test_mixer(
        mic: AudioConsumer,
        mic_rate: u32,
        sys: Option<AudioConsumer>,
        sys_rate: Option<u32>,
        wav: PathBuf,
        mic_swap: Arc<SourceSwap>,
        sys_swap: Arc<SourceSwap>,
    ) -> (AudioMixer, std::thread::JoinHandle<()>) {
        let pause = Arc::new(AtomicBool::new(false));
        let (mixer, mut rx) = AudioMixer::start(
            mic, mic_rate, sys, sys_rate, wav, false, false, false, 0.01, pause, mic_swap,
            sys_swap,
        )
        .expect("mixer start");
        let drain = std::thread::spawn(move || while rx.blocking_recv().is_some() {});
        (mixer, drain)
    }

    /// Flip the running flag, join the mixer thread (which finalizes the
    /// WAV), then join the channel drainer (tx drops with the thread).
    fn stop_and_join(mut mixer: AudioMixer, drain: std::thread::JoinHandle<()>) {
        mixer.stop();
        mixer
            .join_handle
            .take()
            .expect("join handle")
            .join()
            .expect("mixer thread");
        drain.join().expect("drain thread");
    }

    /// Item 3 case 1: live mic (sine ≫ ACTIVE_RMS) plus a tap delivering
    /// bit-exact zeros — the broken-tap signature. SYS_ZERO_RUN_MS must
    /// accumulate while MIC_LAST_VOICE_AGO_MS pins at zero (the
    /// conversation-evidence gate the supervisor needs before acting).
    #[test]
    #[serial]
    fn zero_run_and_voice_tracking() {
        reset_observation_atomics();
        let dir = tempfile::tempdir().unwrap();
        let wav = dir.path().join("zero_run.wav");

        let (mic_prod, mic_cons) = create_audio_ring(48_000);
        let (sys_prod, sys_cons) = create_audio_ring(48_000);
        let feeding = Arc::new(AtomicBool::new(true));
        let mic_feed = spawn_feeder(mic_prod, 48_000, 0.5, feeding.clone());
        let sys_feed = spawn_feeder(sys_prod, 48_000, 0.0, feeding.clone());

        let (mixer, drain) = start_test_mixer(
            mic_cons,
            48_000,
            Some(sys_cons),
            Some(48_000),
            wav,
            SourceSwap::new(),
            SourceSwap::new(),
        );

        sleep_ms(1_300);
        let zero_run = crate::audio::SYS_ZERO_RUN_MS.load(Ordering::Relaxed);
        let voice_ago = crate::audio::MIC_LAST_VOICE_AGO_MS.load(Ordering::Relaxed);

        // Stop the mixer while the feeders still run so the mic-stall
        // silence path never injects zero chunks that would bump voice_ago.
        stop_and_join(mixer, drain);
        feeding.store(false, Ordering::Relaxed);
        mic_feed.join().unwrap();
        sys_feed.join().unwrap();

        assert!(
            zero_run > 500,
            "~1.3s of bit-exact zero chunks must grow SYS_ZERO_RUN_MS past 500, got {zero_run}"
        );
        assert!(zero_run < 10_000, "zero run implausibly large: {zero_run}");
        assert!(
            voice_ago <= 200,
            "sine mic (RMS ~0.35 > ACTIVE_RMS) must pin MIC_LAST_VOICE_AGO_MS near 0, got {voice_ago}"
        );
    }

    /// Item 3 case 2: the system ring goes quiet mid-meeting (tap died — a
    /// started IOProc otherwise fires at the device clock regardless of
    /// content, so an empty ring is breakage, never "nothing playing").
    /// SYS_STALL_MS must register and keep growing.
    #[test]
    #[serial]
    fn sys_stall_tracking() {
        reset_observation_atomics();
        let dir = tempfile::tempdir().unwrap();
        let wav = dir.path().join("sys_stall.wav");

        let (mic_prod, mic_cons) = create_audio_ring(48_000);
        let (sys_prod, sys_cons) = create_audio_ring(48_000);
        let mic_run = Arc::new(AtomicBool::new(true));
        let sys_run = Arc::new(AtomicBool::new(true));
        let mic_feed = spawn_feeder(mic_prod, 48_000, 0.5, mic_run.clone());
        let sys_feed = spawn_feeder(sys_prod, 48_000, 0.5, sys_run.clone());

        let (mixer, drain) = start_test_mixer(
            mic_cons,
            48_000,
            Some(sys_cons),
            Some(48_000),
            wav,
            SourceSwap::new(),
            SourceSwap::new(),
        );

        sleep_ms(300);
        sys_run.store(false, Ordering::Relaxed); // tap dies; mic keeps talking
        sys_feed.join().unwrap();

        sleep_ms(400);
        let stall_1 = crate::audio::SYS_STALL_MS.load(Ordering::Relaxed);
        sleep_ms(300);
        let stall_2 = crate::audio::SYS_STALL_MS.load(Ordering::Relaxed);

        stop_and_join(mixer, drain);
        mic_run.store(false, Ordering::Relaxed);
        mic_feed.join().unwrap();

        assert!(
            stall_1 >= 100,
            "stall should register after the tap dies, got {stall_1}"
        );
        assert!(
            stall_2 > stall_1,
            "stall must keep growing while the ring stays empty: {stall_1} → {stall_2}"
        );
        assert!(stall_2 >= 300, "stall implausibly small at ~700ms dead: {stall_2}");
    }

    /// Item 3 case 3: mid-run system-source hot-swap at 44.1k. The swap
    /// must reset the stall/zero-run counters (stale pre-rebuild evidence
    /// would re-trigger the supervisor) and must NOT change the WAV header
    /// rate — the 44.1k source rides the resample-into-the-file machinery.
    #[test]
    #[serial]
    fn sys_swap_resets_and_wav_rate_stable() {
        reset_observation_atomics();
        let dir = tempfile::tempdir().unwrap();
        let wav = dir.path().join("sys_swap.wav");

        let (mic_prod, mic_cons) = create_audio_ring(48_000);
        let (sys1_prod, sys1_cons) = create_audio_ring(48_000);
        let mic_run = Arc::new(AtomicBool::new(true));
        let sys1_run = Arc::new(AtomicBool::new(true));
        let mic_feed = spawn_feeder(mic_prod, 48_000, 0.5, mic_run.clone());
        let sys1_feed = spawn_feeder(sys1_prod, 48_000, 0.0, sys1_run.clone()); // exact zeros

        let mic_swap = SourceSwap::new();
        let sys_swap = SourceSwap::new();
        let (mixer, drain) = start_test_mixer(
            mic_cons,
            48_000,
            Some(sys1_cons),
            Some(48_000),
            wav.clone(),
            mic_swap,
            sys_swap.clone(),
        );

        // Grow zero-run (tap delivering zeros), then stall (ring empty).
        sleep_ms(500);
        sys1_run.store(false, Ordering::Relaxed);
        sys1_feed.join().unwrap();
        sleep_ms(350);
        let pre_zero = crate::audio::SYS_ZERO_RUN_MS.load(Ordering::Relaxed);
        let pre_stall = crate::audio::SYS_STALL_MS.load(Ordering::Relaxed);
        assert!(pre_zero >= 200, "zero-run should have accumulated, got {pre_zero}");
        assert!(pre_stall >= 100, "stall should have accumulated, got {pre_stall}");

        // Rebuilt tap comes back at 44.1k with real signal.
        let (sys2_prod, sys2_cons) = create_audio_ring(44_100);
        let sys2_run = Arc::new(AtomicBool::new(true));
        let sys2_feed = spawn_feeder(sys2_prod, 44_100, 0.5, sys2_run.clone());
        sys_swap.post(SwapPayload {
            consumer: sys2_cons,
            sample_rate: 44_100,
            label: "test-tap-44k1".into(),
        });

        sleep_ms(400);
        let post_zero = crate::audio::SYS_ZERO_RUN_MS.load(Ordering::Relaxed);
        let post_stall = crate::audio::SYS_STALL_MS.load(Ordering::Relaxed);

        stop_and_join(mixer, drain);
        mic_run.store(false, Ordering::Relaxed);
        sys2_run.store(false, Ordering::Relaxed);
        mic_feed.join().unwrap();
        sys2_feed.join().unwrap();

        assert!(
            post_zero <= 150,
            "swap must reset SYS_ZERO_RUN_MS ({pre_zero} → {post_zero})"
        );
        assert!(
            post_stall <= 150,
            "swap must reset SYS_STALL_MS ({pre_stall} → {post_stall})"
        );
        assert!(post_zero < pre_zero && post_stall < pre_stall);

        let reader = hound::WavReader::open(&wav).expect("finalized wav");
        assert_eq!(
            reader.spec().sample_rate,
            48_000,
            "WAV header rate must stay at the ORIGINAL mic rate across a sys swap"
        );
        assert!(reader.duration() > 0, "wav should contain audio");
    }

    /// Item 3 case 4: mid-run mic hot-swap 48k → 24k (Bluetooth fallback).
    /// The WAV keeps its original 48k header rate and its duration keeps
    /// the whole pre-swap timeline — the swap appends (resampling into the
    /// file's rate), never truncates.
    #[test]
    #[serial]
    fn mic_swap_keeps_timeline() {
        reset_observation_atomics();
        let dir = tempfile::tempdir().unwrap();
        let wav = dir.path().join("mic_swap.wav");

        let (mic1_prod, mic1_cons) = create_audio_ring(48_000);
        let mic1_run = Arc::new(AtomicBool::new(true));
        let mic1_feed = spawn_feeder(mic1_prod, 48_000, 0.5, mic1_run.clone());

        let mic_swap = SourceSwap::new();
        let (mixer, drain) = start_test_mixer(
            mic1_cons,
            48_000,
            None,
            None,
            wav.clone(),
            mic_swap.clone(),
            SourceSwap::new(),
        );

        sleep_ms(800);
        // Stop the old feeder and give the mixer a beat to drain the old
        // ring fully (well under the 250ms stall threshold, so no silence
        // injection muddies the duration math), then swap to a 24k mic.
        mic1_run.store(false, Ordering::Relaxed);
        let pushed_pre_swap = mic1_feed.join().unwrap();
        sleep_ms(80);

        let (mic2_prod, mic2_cons) = create_audio_ring(24_000);
        let mic2_run = Arc::new(AtomicBool::new(true));
        let mic2_feed = spawn_feeder(mic2_prod, 24_000, 0.5, mic2_run.clone());
        mic_swap.post(SwapPayload {
            consumer: mic2_cons,
            sample_rate: 24_000,
            label: "test-mic-24k".into(),
        });

        sleep_ms(600); // ~500ms+ on the new source
        stop_and_join(mixer, drain); // stop via the running flag
        mic2_run.store(false, Ordering::Relaxed);
        let pushed_post_swap = mic2_feed.join().unwrap();

        let reader = hound::WavReader::open(&wav).expect("finalized wav");
        assert_eq!(
            reader.spec().sample_rate,
            48_000,
            "mic swap must not change the WAV header rate"
        );
        // Monotonic timeline: everything the pre-swap mic delivered is in
        // the file (the post-swap segment more than covers chunk-granularity
        // losses around the swap, so >= pushed_pre_swap holds robustly; a
        // truncate-on-swap regression would leave only the ~0.6s post-swap
        // segment and fail this).
        let duration = reader.duration() as u64;
        assert!(
            duration >= pushed_pre_swap,
            "WAV lost pre-swap audio: duration {duration} < pre-swap {pushed_pre_swap} \
             (post-swap fed {pushed_post_swap} samples at 24k)"
        );
        assert!(
            duration <= 48 * 5_000,
            "implausibly long file for a ~1.5s session: {duration} samples"
        );
    }

    /// Stereo mode (plan v9 #9): mic lands on L, system on R, with clearly
    /// different amplitudes so a channel swap or accidental mono mix would
    /// fail the peak assertions.
    #[test]
    #[serial]
    fn stereo_wav_puts_mic_left_and_system_right() {
        reset_observation_atomics();
        let dir = tempfile::tempdir().unwrap();
        let wav = dir.path().join("stereo.wav");

        let (mic_prod, mic_cons) = create_audio_ring(48_000);
        let (sys_prod, sys_cons) = create_audio_ring(48_000);
        let run = Arc::new(AtomicBool::new(true));
        let mic_feeder = spawn_feeder(mic_prod, 48_000, 0.5, run.clone());
        let sys_feeder = spawn_feeder(sys_prod, 48_000, 0.2, run.clone());

        let pause = Arc::new(AtomicBool::new(false));
        let (mixer, mut rx) = AudioMixer::start(
            mic_cons, 48_000, Some(sys_cons), Some(48_000),
            wav.clone(), true, false, false, 0.01, pause,
            SourceSwap::new(), SourceSwap::new(),
        )
        .expect("mixer start");
        let drain = std::thread::spawn(move || while rx.blocking_recv().is_some() {});

        sleep_ms(1_200);
        stop_and_join(mixer, drain);
        run.store(false, Ordering::Relaxed);
        let _ = mic_feeder.join();
        let _ = sys_feeder.join();

        let mut reader = hound::WavReader::open(&wav).unwrap();
        let spec = reader.spec();
        assert_eq!(spec.channels, 2, "stereo session must write a 2-channel file");
        assert_eq!(spec.sample_rate, 48_000);
        let samples: Vec<i16> = reader.samples::<i16>().map(|s| s.unwrap()).collect();
        assert!(samples.len() > 48_000, "expected ~1s+ of frames, got {}", samples.len() / 2);
        let peak = |it: &mut dyn Iterator<Item = &i16>| {
            it.map(|s| (*s as f32 / i16::MAX as f32).abs()).fold(0f32, f32::max)
        };
        let l_peak = peak(&mut samples.iter().step_by(2));
        let r_peak = peak(&mut samples.iter().skip(1).step_by(2));
        assert!((0.35..=0.6).contains(&l_peak), "mic (L) peak ~0.5, got {l_peak}");
        assert!((0.12..=0.3).contains(&r_peak), "system (R) peak ~0.2, got {r_peak}");
    }

    /// Toggling stereo between sessions must not corrupt an existing mono
    /// file — the file's own layout wins on append.
    #[test]
    #[serial]
    fn stereo_setting_cannot_corrupt_an_existing_mono_file() {
        reset_observation_atomics();
        let dir = tempfile::tempdir().unwrap();
        let wav = dir.path().join("mono_then_stereo.wav");

        // Session 1: mono.
        let (mic_prod, mic_cons) = create_audio_ring(48_000);
        let run = Arc::new(AtomicBool::new(true));
        let feeder = spawn_feeder(mic_prod, 48_000, 0.4, run.clone());
        let (mixer, drain) = start_test_mixer(
            mic_cons, 48_000, None, None, wav.clone(),
            SourceSwap::new(), SourceSwap::new(),
        );
        sleep_ms(600);
        stop_and_join(mixer, drain);
        run.store(false, Ordering::Relaxed);
        let _ = feeder.join();
        let frames_before = hound::WavReader::open(&wav).unwrap().duration();

        // Session 2: stereo REQUESTED on the same path.
        let (mic_prod, mic_cons) = create_audio_ring(48_000);
        let run = Arc::new(AtomicBool::new(true));
        let feeder = spawn_feeder(mic_prod, 48_000, 0.4, run.clone());
        let pause = Arc::new(AtomicBool::new(false));
        let (mixer, mut rx) = AudioMixer::start(
            mic_cons, 48_000, None, None, wav.clone(), true, false, false, 0.01,
            pause, SourceSwap::new(), SourceSwap::new(),
        )
        .expect("mixer start");
        let drain = std::thread::spawn(move || while rx.blocking_recv().is_some() {});
        sleep_ms(600);
        stop_and_join(mixer, drain);
        run.store(false, Ordering::Relaxed);
        let _ = feeder.join();

        let reader = hound::WavReader::open(&wav).unwrap();
        assert_eq!(reader.spec().channels, 1, "existing mono layout must win on append");
        assert!(
            reader.duration() > frames_before,
            "second session must have appended ({} -> {})",
            frames_before,
            reader.duration()
        );
    }
}
