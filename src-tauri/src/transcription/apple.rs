//! Apple SpeechAnalyzer/SpeechTranscriber engine (plan v9 #12).
//!
//! Calls the Swift bridge in `swift/SpeechEngine.swift` — Apple's on-device
//! transcription stack on macOS 26+. Zero model download (locale assets are
//! OS-managed), roughly an order of magnitude faster than whisper on the
//! full-file path, with strong FR/ES/DE/IT support.
//!
//! v1 scope: the FULL-file path only (re-transcription + audio import via
//! `batch_retranscribe`). The live chunked path stays whisper — Apple's API
//! wants whole inputs/streams with its own session lifecycle, and the live
//! worker's VAD gate + hallucination filters are whisper-tuned.
//!
//! The Swift side calls back exactly once per job with a JSON payload:
//! segments array on success, `{"__error": …}` on failure — parsed by
//! [`parse_segments_json`] (pure; unit-tested).

use anyhow::{anyhow, Result};

use super::engine::EngineSegment;

#[cfg(target_os = "macos")]
use std::ffi::{c_char, c_void, CStr, CString};

// ─── FFI declarations (implemented in swift/SpeechEngine.swift) ───────────────

#[cfg(target_os = "macos")]
extern "C" {
    /// True on macOS 26+ when the SpeechTranscriber stack is supported and
    /// at least one transcription locale asset is installed.
    fn mn_speech_available() -> bool;

    /// Transcribe a 16kHz mono WAV file. `locale` carries the app's
    /// transcription-language setting ("auto"/"" = system locale). The
    /// callback fires exactly once — segments JSON on success (returns 0),
    /// `{"__error": …}` on failure (returns negative). The callback buffer
    /// is only valid during the call.
    fn mn_speech_transcribe_file(
        path: *const c_char,
        locale: *const c_char,
        callback: unsafe extern "C" fn(*const c_char, *mut c_void),
        user_data: *mut c_void,
    ) -> i32;
}

/// Whether the Apple Speech engine can transcribe on this machine.
pub fn is_available() -> bool {
    #[cfg(target_os = "macos")]
    {
        unsafe { mn_speech_available() }
    }
    #[cfg(not(target_os = "macos"))]
    {
        false
    }
}

// ─── Callback plumbing ────────────────────────────────────────────────────────

/// `user_data` is `*mut Option<String>`; copy the payload out before the
/// Swift buffer dies at callback return.
#[cfg(target_os = "macos")]
unsafe extern "C" fn on_payload(json: *const c_char, user_data: *mut c_void) {
    if json.is_null() || user_data.is_null() {
        return;
    }
    let slot = &mut *(user_data as *mut Option<String>);
    *slot = Some(CStr::from_ptr(json).to_string_lossy().into_owned());
}

// ─── Payload parsing (pure) ───────────────────────────────────────────────────

/// Parse the Swift callback payload: a JSON array of
/// `{"text","start_ms","end_ms"}` segments, or an `{"__error": …}` envelope.
/// Empty-text segments are dropped; inverted ranges are clamped.
pub fn parse_segments_json(payload: &str) -> Result<Vec<EngineSegment>> {
    #[derive(serde::Deserialize)]
    struct ErrorEnvelope {
        __error: String,
    }
    #[derive(serde::Deserialize)]
    struct Seg {
        text: String,
        start_ms: u64,
        end_ms: u64,
    }

    if let Ok(err) = serde_json::from_str::<ErrorEnvelope>(payload) {
        return Err(anyhow!("Apple Speech error: {}", err.__error));
    }
    let segs: Vec<Seg> = serde_json::from_str(payload).map_err(|e| {
        let preview: String = payload.chars().take(200).collect();
        anyhow!("Apple Speech returned malformed JSON: {} (raw: {})", e, preview)
    })?;
    Ok(segs
        .into_iter()
        .filter(|s| !s.text.trim().is_empty())
        .map(|s| EngineSegment {
            text: s.text.trim().to_string(),
            start_ms: s.start_ms,
            end_ms: s.end_ms.max(s.start_ms),
            // Apple Speech doesn't expose per-word times here — no split data.
            words: Vec::new(),
        })
        .collect())
}

// ─── Public API ───────────────────────────────────────────────────────────────

/// Transcribe a 16kHz mono WAV file with Apple Speech. Blocking (runs the
/// whole analysis) — call from `spawn_blocking`. `language` is the app's
/// `whisper_language` setting; `None`/"auto" means the system locale.
#[cfg(target_os = "macos")]
pub fn transcribe_wav_file(path: &std::path::Path, language: Option<&str>) -> Result<Vec<EngineSegment>> {
    let c_path = CString::new(
        path.to_str()
            .ok_or_else(|| anyhow!("non-UTF8 WAV path: {:?}", path))?,
    )
    .map_err(|e| anyhow!("WAV path contains NUL: {}", e))?;
    let c_locale = CString::new(language.unwrap_or("auto"))
        .map_err(|e| anyhow!("language contains NUL: {}", e))?;

    let mut payload: Option<String> = None;
    let status = unsafe {
        mn_speech_transcribe_file(
            c_path.as_ptr(),
            c_locale.as_ptr(),
            on_payload,
            &mut payload as *mut Option<String> as *mut c_void,
        )
    };
    let payload =
        payload.ok_or_else(|| anyhow!("Apple Speech returned no payload (status {status})"))?;
    // parse_segments_json surfaces the __error envelope with its detail; the
    // status check behind it catches a malformed success contract.
    let segments = parse_segments_json(&payload)?;
    if status != 0 {
        return Err(anyhow!("Apple Speech failed with status {status}"));
    }
    Ok(segments)
}

#[cfg(not(target_os = "macos"))]
pub fn transcribe_wav_file(_path: &std::path::Path, _language: Option<&str>) -> Result<Vec<EngineSegment>> {
    Err(anyhow!("Apple Speech transcription requires macOS"))
}

/// Write 16kHz mono f32 samples as a 16-bit PCM WAV — the input contract of
/// `mn_speech_transcribe_file`. Both engines are thereby fed the exact same
/// resampled audio, which keeps quality comparisons honest.
pub fn write_16k_wav(samples: &[f32], path: &std::path::Path) -> Result<()> {
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: 16_000,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut writer = hound::WavWriter::create(path, spec)
        .map_err(|e| anyhow!("failed to create temp WAV {:?}: {}", path, e))?;
    for &s in samples {
        writer
            .write_sample((s.clamp(-1.0, 1.0) * 32767.0) as i16)
            .map_err(|e| anyhow!("failed to write temp WAV: {}", e))?;
    }
    writer.finalize().map_err(|e| anyhow!("failed to finalize temp WAV: {}", e))?;
    Ok(())
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_segments_array() {
        let payload = r#"[
            {"text":"Hello, Amy.","start_ms":0,"end_ms":1020},
            {"text":" Feature X ships in April. ","start_ms":1020,"end_ms":7740}
        ]"#;
        let segs = parse_segments_json(payload).unwrap();
        assert_eq!(segs.len(), 2);
        assert_eq!(segs[0].text, "Hello, Amy.");
        assert_eq!(segs[0].start_ms, 0);
        assert_eq!(segs[0].end_ms, 1020);
        // Whitespace trimmed, range intact.
        assert_eq!(segs[1].text, "Feature X ships in April.");
        assert_eq!(segs[1].start_ms, 1020);
    }

    #[test]
    fn parses_empty_array() {
        assert!(parse_segments_json("[]").unwrap().is_empty());
    }

    #[test]
    fn drops_empty_text_and_clamps_inverted_ranges() {
        let payload = r#"[
            {"text":"   ","start_ms":0,"end_ms":100},
            {"text":"kept","start_ms":900,"end_ms":300}
        ]"#;
        let segs = parse_segments_json(payload).unwrap();
        assert_eq!(segs.len(), 1);
        assert_eq!(segs[0].text, "kept");
        assert_eq!(segs[0].end_ms, 900, "inverted range clamps to start");
    }

    #[test]
    fn surfaces_error_envelope() {
        let err = parse_segments_json(r#"{"__error":"Apple Speech does not support the language 'zz'"}"#)
            .unwrap_err();
        assert!(err.to_string().contains("does not support the language 'zz'"), "{err}");
    }

    #[test]
    fn rejects_garbage_payloads() {
        for bad in ["", "not json", "{\"text\":\"obj not array\"}", "42"] {
            assert!(parse_segments_json(bad).is_err(), "should reject: {bad:?}");
        }
    }

    #[test]
    fn write_16k_wav_round_trips_through_engine_reader() {
        let dir = std::env::temp_dir();
        let path = dir.join(format!("perchnote-test-{}.wav", std::process::id()));
        // 100ms of a 440Hz tone.
        let samples: Vec<f32> = (0..1600)
            .map(|i| (i as f32 * 440.0 * 2.0 * std::f32::consts::PI / 16_000.0).sin() * 0.5)
            .collect();
        write_16k_wav(&samples, &path).unwrap();
        let back = crate::transcription::engine::wav_to_whisper_samples(&path).unwrap();
        std::fs::remove_file(&path).ok();
        assert_eq!(back.len(), samples.len());
        // i16 quantization error stays tiny.
        let max_err = samples
            .iter()
            .zip(&back)
            .map(|(a, b)| (a - b).abs())
            .fold(0.0f32, f32::max);
        assert!(max_err < 0.001, "quantization error too large: {max_err}");
    }

    /// Live-fire the whole FFI + SpeechAnalyzer path on a real fixture.
    /// Requires macOS 26+ with an installed locale asset. Run:
    ///   PERCH_WAV=/tmp/speech_ab/fixture16k.wav \
    ///   cargo test real_apple_transcribe -- --ignored --nocapture
    #[test]
    #[ignore]
    fn real_apple_transcribe() {
        let wav = std::env::var("PERCH_WAV").expect("set PERCH_WAV");
        eprintln!("apple speech available: {}", is_available());
        assert!(is_available(), "Apple Speech unavailable on this host");
        let t0 = std::time::Instant::now();
        let segs = transcribe_wav_file(std::path::Path::new(&wav), Some("en")).unwrap();
        eprintln!("transcribed in {:?} -> {} segments", t0.elapsed(), segs.len());
        for s in &segs {
            eprintln!("  [{} - {}ms] {}", s.start_ms, s.end_ms, s.text);
        }
        assert!(!segs.is_empty(), "no segments from fixture");
    }
}

/// Compile/link-time C-ABI surface test (same pattern as vpio.rs): taking
/// the extern fns' addresses forces the linker to resolve the Swift symbols,
/// so a rename or signature drift in SpeechEngine.swift fails `cargo test`
/// at link time instead of at first use.
#[cfg(all(test, target_os = "macos"))]
mod link_tests {
    #[test]
    fn speech_c_abi_symbols_link() {
        let available: unsafe extern "C" fn() -> bool = super::mn_speech_available;
        let transcribe: unsafe extern "C" fn(
            *const super::c_char,
            *const super::c_char,
            unsafe extern "C" fn(*const super::c_char, *mut super::c_void),
            *mut super::c_void,
        ) -> i32 = super::mn_speech_transcribe_file;
        assert!(available as usize != 0);
        assert!(transcribe as usize != 0);
    }
}
