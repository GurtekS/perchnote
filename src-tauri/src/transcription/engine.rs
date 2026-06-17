//! In-process whisper engine (plan v2 rank 8).
//!
//! Replaces the per-chunk `whisper-cli` sidecar: the model loads ONCE per
//! recording session (the spawn-per-chunk model reload was the dominant
//! latency cost), audio feeds in as the 16kHz mono f32 we already hold (no
//! temp WAV round-trip), and the Metal shader library is embedded in our
//! binary — no Homebrew install, no silent CPU fallback.

use anyhow::{anyhow, Result};
use std::sync::Arc;
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters, WhisperState};

/// Route whisper.cpp/ggml's stderr chatter into the `log` crate exactly once.
fn install_log_hooks_once() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(whisper_rs::install_logging_hooks);
}

/// A loaded whisper model. Cheap to clone (Arc); create one per recording
/// session or batch job, drop it to release ~hundreds of MB of weights.
#[derive(Clone)]
pub struct WhisperEngine {
    ctx: Arc<WhisperContext>,
    /// Silero VAD ggml model, when downloaded — gates chunks before whisper
    /// (plan v4: hallucination suppression; the FullParams enable_vad path is
    /// a silent no-op with state-based calls, so we run VAD standalone).
    vad_model_path: Option<std::path::PathBuf>,
    /// True for *.en models — language detection is meaningless there.
    english_only: bool,
}

impl WhisperEngine {
    /// Load the ggml model at `model_path`. Blocking and heavy (reads the
    /// whole model file) — call from a blocking context. GPU choice is fixed
    /// per engine; Metal shader JIT happens later, at state creation.
    pub fn load(model_path: &std::path::Path, gpu_enabled: bool) -> Result<Self> {
        install_log_hooks_once();
        let mut params = WhisperContextParameters::default();
        params.use_gpu(gpu_enabled);
        params.flash_attn(gpu_enabled);
        let path = model_path
            .to_str()
            .ok_or_else(|| anyhow!("non-UTF8 model path: {:?}", model_path))?;
        let ctx = WhisperContext::new_with_params(path, params)
            .map_err(|e| anyhow!("failed to load whisper model {:?}: {}", model_path, e))?;
        let vad_model_path = model_path
            .parent()
            .map(|d| d.join(VAD_MODEL_FILENAME))
            .filter(|p| p.exists());
        if vad_model_path.is_some() {
            log::info!("whisper engine: silero VAD gate active");
        }
        let english_only = model_path
            .file_name()
            .map(|n| n.to_string_lossy().contains(".en"))
            .unwrap_or(false);
        Ok(Self { ctx: Arc::new(ctx), vad_model_path, english_only })
    }

    /// Create the chunk-gating VAD context, if the model is on disk.
    pub fn create_vad(&self) -> Option<whisper_rs::WhisperVadContext> {
        let path = self.vad_model_path.as_ref()?;
        let params = whisper_rs::WhisperVadContextParams::new();
        match whisper_rs::WhisperVadContext::new(path.to_str()?, params) {
            Ok(ctx) => Some(ctx),
            Err(e) => {
                log::warn!("VAD context init failed ({e}); transcribing ungated");
                None
            }
        }
    }

    pub fn english_only(&self) -> bool {
        self.english_only
    }

    /// Create a transcription state. First creation per engine pays the
    /// one-time Metal shader compile — do it at recording start, not on the
    /// first chunk.
    pub fn create_state(&self) -> Result<WhisperState> {
        self.ctx
            .create_state()
            .map_err(|e| anyhow!("failed to create whisper state: {}", e))
    }
}

/// Filename of the Silero VAD model inside the models directory.
pub const VAD_MODEL_FILENAME: &str = "ggml-silero-v5.1.2.bin";

/// Does this chunk contain any detected speech? Errors count as "yes" —
/// the gate must only ever drop confidently-silent audio.
pub fn chunk_has_speech(vad: &mut whisper_rs::WhisperVadContext, samples: &[f32]) -> bool {
    let params = whisper_rs::WhisperVadParams::new();
    match vad.segments_from_samples(params, samples) {
        Ok(segs) => segs.num_segments() > 0,
        Err(e) => {
            log::warn!("VAD detect failed ({e}); passing chunk through");
            true
        }
    }
}

/// Whisper's signature non-speech hallucinations (the two top strings alone
/// are ~35% of all hallucinations in the literature). Exact normalized
/// match only — callers additionally gate on no_speech probability so a
/// genuine closing "thank you" is never dropped.
pub fn is_hallucination_text(text: &str) -> bool {
    const BAG: &[&str] = &[
        "thank you",
        "thanks for watching",
        "thank you for watching",
        "subtitles by the amara org community",
        "please subscribe",
        "subscribe to my channel",
    ];
    let normalized: String = text
        .to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() || c.is_whitespace() { c } else { ' ' })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    BAG.contains(&normalized.as_str())
}

/// One transcribed segment with absolute-ish timestamps (relative to the
/// start of `samples`), in milliseconds.
#[derive(Debug)]
pub struct EngineSegment {
    pub text: String,
    pub start_ms: u64,
    pub end_ms: u64,
    /// Per-word timestamps when the engine produced them (full-file whisper
    /// path). Empty for the live chunk path and Apple Speech. Lets the
    /// diarizer split a segment that straddles a speaker change at the word
    /// boundary instead of collapsing it onto one speaker.
    pub words: Vec<crate::transcription::whisper::WordTimestamp>,
}

/// Which engine handles FULL-file transcription jobs (re-transcribe + audio
/// import). The live chunked path stays whisper-only in v1.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EngineChoice {
    Whisper,
    Apple,
}

/// Resolve the persisted `transcription_engine` setting against runtime
/// availability. Whisper is the default; "apple" only wins when the
/// SpeechTranscriber stack is actually usable (macOS 26+ with a locale
/// asset installed), so a stale setting — say, after a Time Machine restore
/// onto an older Mac — can never strand transcription.
pub fn resolve_engine(setting: Option<String>, apple_available: bool) -> EngineChoice {
    match setting.as_deref() {
        Some("apple") if apple_available => EngineChoice::Apple,
        _ => EngineChoice::Whisper,
    }
}

fn base_params<'a>(language: Option<&'a str>, initial_prompt: Option<&'a str>) -> FullParams<'a, 'a> {
    // Beam search 5: ~1.5pp WER better than greedy in the literature; Metal
    // has ample headroom at our 5-12s chunk sizes (plan v4).
    let mut params = FullParams::new(SamplingStrategy::BeamSearch {
        beam_size: 5,
        patience: -1.0,
    });
    params.set_n_threads(4);
    params.set_translate(false);
    params.set_language(Some(language.unwrap_or("auto")));
    params.set_no_context(true);
    params.set_suppress_blank(true);
    params.set_suppress_nst(true);
    params.set_print_special(false);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);
    if let Some(p) = initial_prompt {
        if !p.trim().is_empty() {
            params.set_initial_prompt(p);
        }
    }
    params
}

/// Transcribe one live chunk to plain text. `initial_prompt` carries custom
/// vocabulary plus the tail of prior output for cross-chunk context. Returns
/// None for empty output. Blocking — run on the dedicated worker thread.
pub struct ChunkText {
    pub text: String,
    /// Mean per-segment no-speech probability — high values mean whisper
    /// itself doubts there was speech (hallucination signal).
    pub no_speech_prob: f32,
}

pub fn transcribe_chunk(
    state: &mut WhisperState,
    samples: &[f32],
    language: Option<&str>,
    initial_prompt: Option<&str>,
) -> Result<Option<ChunkText>> {
    let params = base_params(language, initial_prompt);
    state
        .full(params, samples)
        .map_err(|e| anyhow!("whisper full() failed: {}", e))?;
    let mut text = String::new();
    let mut no_speech_sum = 0.0f32;
    let mut n = 0u32;
    for seg in state.as_iter() {
        if let Ok(s) = seg.to_str_lossy() {
            text.push_str(&s);
        }
        no_speech_sum += seg.no_speech_probability();
        n += 1;
    }
    let text = text.trim().to_string();
    Ok(if text.is_empty() {
        None
    } else {
        Some(ChunkText {
            text,
            no_speech_prob: if n > 0 { no_speech_sum / n as f32 } else { 0.0 },
        })
    })
}

/// Transcribe a whole recording into timestamped segments (retranscribe
/// path). Timestamps come from whisper itself, in centiseconds → ms.
/// `token_timestamps` is on so each segment carries per-word times, which the
/// diarizer uses to split a segment at a speaker change.
pub fn transcribe_full(
    state: &mut WhisperState,
    samples: &[f32],
    language: Option<&str>,
) -> Result<Vec<EngineSegment>> {
    let mut params = base_params(language, None);
    params.set_token_timestamps(true);
    state
        .full(params, samples)
        .map_err(|e| anyhow!("whisper full() failed: {}", e))?;
    let mut out = Vec::new();
    for seg in state.as_iter() {
        let Ok(raw) = seg.to_str_lossy() else { continue };
        let text = raw.trim().to_string();
        if text.is_empty() {
            continue;
        }
        // Collect each token's text + absolute time (centiseconds → ms),
        // skipping whisper's special markers ("[_BEG_]", "[_TT_..]").
        let mut tokens: Vec<(String, u64, u64)> = Vec::new();
        for t in 0..seg.n_tokens() {
            let Some(tok) = seg.get_token(t) else { continue };
            let Ok(txt) = tok.to_str_lossy() else { continue };
            if txt.starts_with("[_") {
                continue;
            }
            let d = tok.token_data();
            tokens.push((
                txt.into_owned(),
                (d.t0.max(0) as u64) * 10,
                (d.t1.max(0) as u64) * 10,
            ));
        }
        out.push(EngineSegment {
            text,
            start_ms: (seg.start_timestamp().max(0) as u64) * 10,
            end_ms: (seg.end_timestamp().max(0) as u64) * 10,
            words: group_tokens_into_words(&tokens),
        });
    }
    Ok(out)
}

/// Group whisper sub-word tokens into words. A token whose text begins with a
/// space starts a new word; the rest attach to the current one (so trailing
/// punctuation stays put). A word's span runs from its first token's start to
/// its last token's end. Pure for testing.
pub(crate) fn group_tokens_into_words(
    tokens: &[(String, u64, u64)],
) -> Vec<crate::transcription::whisper::WordTimestamp> {
    use crate::transcription::whisper::WordTimestamp;
    let mut words: Vec<WordTimestamp> = Vec::new();
    for (text, t0, t1) in tokens {
        if text.is_empty() {
            continue;
        }
        let end = (*t1).max(*t0);
        if text.starts_with(' ') || words.is_empty() {
            words.push(WordTimestamp { word: text.trim_start().to_string(), start_ms: *t0, end_ms: end });
        } else if let Some(last) = words.last_mut() {
            last.word.push_str(text);
            last.end_ms = last.end_ms.max(end);
        }
    }
    words.retain_mut(|w| {
        w.word = w.word.trim().to_string();
        !w.word.is_empty()
    });
    words
}

/// Read a 16-bit WAV at any sample rate into 16kHz mono f32 — the format
/// whisper wants. Recordings are written at the mic's native rate (44.1/48k)
/// for playback compatibility, so offline jobs resample here (rubato FFT,
/// same family the live mixer uses). Multi-channel files downmix by
/// averaging frames (QA audit P1-3): refusing stereo broke re-transcribe
/// and neural re-diarization for every v9 stereo recording — whose RIGHT
/// channel is the entire remote side of the call.
pub fn wav_to_whisper_samples(path: &std::path::Path) -> Result<Vec<f32>> {
    use rubato::Resampler;
    let mut reader = hound::WavReader::open(path)?;
    let spec = reader.spec();
    if spec.channels == 0 {
        return Err(anyhow!("WAV reports zero channels"));
    }
    let interleaved: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Int => reader
            .samples::<i16>()
            .filter_map(|s| s.ok())
            .map(|s| s as f32 / 32768.0)
            .collect(),
        hound::SampleFormat::Float => reader.samples::<f32>().filter_map(|s| s.ok()).collect(),
    };
    let raw: Vec<f32> = if spec.channels == 1 {
        interleaved
    } else {
        let ch = spec.channels as usize;
        interleaved
            .chunks_exact(ch)
            .map(|frame| frame.iter().sum::<f32>() / ch as f32)
            .collect()
    };
    if spec.sample_rate == 16_000 {
        return Ok(raw);
    }
    let chunk = 4096usize;
    let mut resampler = rubato::FftFixedIn::<f32>::new(spec.sample_rate as usize, 16_000, chunk, 2, 1)
        .map_err(|e| anyhow!("resampler init failed: {}", e))?;
    let mut out: Vec<f32> = Vec::with_capacity(raw.len() / 3 + 16);
    let mut pos = 0usize;
    while pos < raw.len() {
        let end = (pos + chunk).min(raw.len());
        let mut block = raw[pos..end].to_vec();
        block.resize(chunk, 0.0); // zero-pad the tail block
        let processed = resampler
            .process(&[block], None)
            .map_err(|e| anyhow!("resample failed: {}", e))?;
        out.extend_from_slice(&processed[0]);
        pos = end;
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_group_into_words_on_leading_space() {
        // Sub-word tokens: " Hello" "," " world" — punctuation attaches to
        // the word it follows; spans run first-token-start..last-token-end.
        let toks = vec![
            (" Hello".to_string(), 0u64, 400u64),
            (",".to_string(), 400, 420),
            (" world".to_string(), 500, 900),
        ];
        let words = group_tokens_into_words(&toks);
        assert_eq!(words.len(), 2);
        assert_eq!(words[0].word, "Hello,");
        assert_eq!(words[0].start_ms, 0);
        assert_eq!(words[0].end_ms, 420);
        assert_eq!(words[1].word, "world");
        assert_eq!(words[1].start_ms, 500);
        assert_eq!(words[1].end_ms, 900);
    }

    #[test]
    fn token_grouping_skips_empty_and_handles_no_leading_space_first() {
        let toks = vec![
            ("Yes".to_string(), 0u64, 300u64), // first token, no leading space
            ("".to_string(), 300, 300),
            (" please".to_string(), 350, 700),
        ];
        let words = group_tokens_into_words(&toks);
        assert_eq!(words.iter().map(|w| w.word.as_str()).collect::<Vec<_>>(), ["Yes", "please"]);
    }

    #[test]
    fn stereo_wav_downmixes_by_frame_average() {
        // L=0.4, R=0.2 → mono 0.3 (QA audit P1-3: refusing stereo broke
        // re-transcribe for every stereo recording). 16k input skips the
        // resampler so the assertion is exact-ish.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("stereo16k.wav");
        let spec = hound::WavSpec {
            channels: 2,
            sample_rate: 16_000,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut w = hound::WavWriter::create(&path, spec).unwrap();
        for _ in 0..1600 {
            w.write_sample((0.4f32 * 32767.0) as i16).unwrap();
            w.write_sample((0.2f32 * 32767.0) as i16).unwrap();
        }
        w.finalize().unwrap();

        let samples = wav_to_whisper_samples(&path).unwrap();
        assert_eq!(samples.len(), 1600, "one mono sample per frame");
        let mean = samples.iter().sum::<f32>() / samples.len() as f32;
        assert!((mean - 0.3).abs() < 0.01, "downmix mean ≈ 0.3, got {mean}");
    }

    #[test]
    fn hallucination_bag_matches_exact_normalized_only() {
        assert!(is_hallucination_text("Thank you."));
        assert!(is_hallucination_text(" thanks for watching! "));
        assert!(is_hallucination_text("Subtitles by the Amara.org community"));
        // Real sentences containing the phrases must NOT match.
        assert!(!is_hallucination_text("Thank you for the update on pricing"));
        assert!(!is_hallucination_text("I'll send thanks for watching the demo go well"));
        assert!(!is_hallucination_text("Let's subscribe to the metrics feed"));
    }

    // ── engine choice: whisper default, apple strictly opt-in + available ──

    #[test]
    fn engine_defaults_to_whisper_when_unset_or_garbage() {
        assert_eq!(resolve_engine(None, true), EngineChoice::Whisper);
        assert_eq!(resolve_engine(Some(String::new()), true), EngineChoice::Whisper);
        assert_eq!(resolve_engine(Some("whisper".into()), true), EngineChoice::Whisper);
        assert_eq!(resolve_engine(Some("APPLE".into()), true), EngineChoice::Whisper);
        assert_eq!(resolve_engine(Some("siri".into()), true), EngineChoice::Whisper);
    }

    #[test]
    fn engine_apple_only_when_selected_and_available() {
        assert_eq!(resolve_engine(Some("apple".into()), true), EngineChoice::Apple);
        // Stale "apple" setting on a host without the stack falls back.
        assert_eq!(resolve_engine(Some("apple".into()), false), EngineChoice::Whisper);
        assert_eq!(resolve_engine(None, false), EngineChoice::Whisper);
    }

    /// Setting plumb test against the real DB layer: the exact read
    /// `batch_retranscribe` performs, with and without the row persisted.
    #[test]
    fn engine_setting_plumbs_through_db() {
        let db = crate::db::Database::new_in_memory().unwrap();
        // Fresh install: no row ⇒ whisper.
        assert_eq!(
            resolve_engine(db.get_setting("transcription_engine").ok().flatten(), true),
            EngineChoice::Whisper
        );
        db.set_setting("transcription_engine", "apple").unwrap();
        assert_eq!(
            resolve_engine(db.get_setting("transcription_engine").ok().flatten(), true),
            EngineChoice::Apple
        );
        assert_eq!(
            resolve_engine(db.get_setting("transcription_engine").ok().flatten(), false),
            EngineChoice::Whisper
        );
        db.set_setting("transcription_engine", "whisper").unwrap();
        assert_eq!(
            resolve_engine(db.get_setting("transcription_engine").ok().flatten(), true),
            EngineChoice::Whisper
        );
    }

    /// Live-fire check against a real model and recording. Run with:
    ///   PERCH_MODEL=~/Library/.../models/ggml-base.en.bin \
    ///   PERCH_WAV=~/Library/.../recordings/<id>.wav \
    ///   cargo test real_engine_transcribe -- --ignored --nocapture
    #[test]
    #[ignore]
    fn real_engine_transcribe() {
        let model = std::env::var("PERCH_MODEL").expect("set PERCH_MODEL");
        let wav = std::env::var("PERCH_WAV").expect("set PERCH_WAV");
        let samples = wav_to_whisper_samples(std::path::Path::new(&wav)).unwrap();
        eprintln!("loaded {} samples ({}s at 16k)", samples.len(), samples.len() / 16_000);
        let rms60 = {
            let n = samples.len().min(16_000 * 60);
            (samples[..n].iter().map(|s| s * s).sum::<f32>() / n as f32).sqrt()
        };
        eprintln!("resampled first-60s RMS: {rms60:.5}");
        if std::env::var("PERCH_DECIMATE").is_ok() {
            // Control path: naive 48k->16k decimation, bypassing rubato.
            let mut reader = hound::WavReader::open(&wav).unwrap();
            let dec: Vec<f32> = reader
                .samples::<i16>()
                .filter_map(|s| s.ok())
                .step_by(3)
                .map(|s| s as f32 / 32768.0)
                .collect();
            eprintln!("DECIMATION CONTROL: {} samples", dec.len());
            let engine = WhisperEngine::load(std::path::Path::new(&model), true).unwrap();
            let mut state = engine.create_state().unwrap();
            let n = dec.len().min(16_000 * 60);
            let segs = transcribe_full(&mut state, &dec[..n], None).unwrap();
            eprintln!("decimation control -> {} segments", segs.len());
            for s in segs.iter().take(5) {
                eprintln!("  [{} - {}ms] {}", s.start_ms, s.end_ms, s.text);
            }
            return;
        }

        let t0 = std::time::Instant::now();
        let engine = WhisperEngine::load(std::path::Path::new(&model), true).unwrap();
        eprintln!("model loaded in {:?}", t0.elapsed());

        let t1 = std::time::Instant::now();
        let mut state = engine.create_state().unwrap();
        eprintln!("state created (Metal JIT) in {:?}", t1.elapsed());

        // A speech-dense 60s window (PERCH_OFFSET_SECS to position it —
        // recordings often open with silence while people join).
        let offset: usize = std::env::var("PERCH_OFFSET_SECS")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(0);
        let from = (offset * 16_000).min(samples.len());
        let to = (from + 16_000 * 60).min(samples.len());
        let t2 = std::time::Instant::now();
        let segs = transcribe_full(&mut state, &samples[from..to], None).unwrap();
        eprintln!("transcribed 60s in {:?} -> {} segments", t2.elapsed(), segs.len());
        for s in segs.iter().take(8) {
            eprintln!("  [{} - {}ms] {}", s.start_ms, s.end_ms, s.text);
        }
        assert!(!segs.is_empty(), "no segments from a real recording");
        let total: usize = segs.iter().map(|s| s.text.len()).sum();
        assert!(total > 200, "implausibly little text: {total} chars");
    }
}

#[cfg(test)]
mod vad_live_tests {
    use super::*;

    /// Live-fire the Silero gate. Run:
    ///   PERCH_VAD=~/Library/.../models/ggml-silero-v5.1.2.bin \
    ///   PERCH_WAV=~/Library/.../recordings/<id>.wav \
    ///   cargo test real_vad_gate -- --ignored --nocapture
    #[test]
    #[ignore]
    fn real_vad_gate() {
        let vad_path = std::env::var("PERCH_VAD").expect("set PERCH_VAD");
        let wav = std::env::var("PERCH_WAV").expect("set PERCH_WAV");
        let params = whisper_rs::WhisperVadContextParams::new();
        let mut vad = whisper_rs::WhisperVadContext::new(&vad_path, params).unwrap();

        let silence = vec![0.0f32; 16_000 * 8];
        assert!(!chunk_has_speech(&mut vad, &silence), "pure silence must gate");

        let samples = wav_to_whisper_samples(std::path::Path::new(&wav)).unwrap();
        // The recording's first ~50s is waiting-room quiet; 60-70s is speech.
        let early = &samples[16_000 * 10..16_000 * 20];
        let talking = &samples[16_000 * 60..16_000 * 70];
        let early_speech = chunk_has_speech(&mut vad, early);
        let talk_speech = chunk_has_speech(&mut vad, talking);
        eprintln!("early(10-20s) speech={early_speech}  talking(60-70s) speech={talk_speech}");
        assert!(talk_speech, "known speech window must pass the gate");
    }
}
