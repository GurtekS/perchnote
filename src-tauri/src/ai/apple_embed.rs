//! Apple on-device embedding backend (plan v10 #4).
//!
//! Calls the Swift bridge in `swift/EmbeddingEngine.swift` —
//! NLContextualEmbedding from the NaturalLanguage framework, present since
//! macOS 14 (the app's floor is 14.2, so it is always linkable on macOS).
//! This gives every user semantic recall with zero setup; Ollama remains an
//! explicit override and FTS-only the silent fallback.
//!
//! All Swift entry points are synchronous; embedding runs via
//! `spawn_blocking`. Payloads cross the FFI as JSON in C strings, freed with
//! `mn_embed_free` (same lifecycle as `apple_ai.rs`).

use anyhow::{anyhow, Result};
use std::ffi::c_char;
#[cfg(target_os = "macos")]
use std::ffi::{CStr, CString};

/// Persisted model identity for this backend. Feeds `ensure_vec_index`, so
/// switching Apple ↔ Ollama trips the same model-change drop+rebuild path
/// as changing Ollama models (vectors from different models never mix).
pub const MODEL_ID: &str = "apple-nlcontextual";

// ─── FFI declarations (implemented in swift/EmbeddingEngine.swift) ───────────

#[cfg(target_os = "macos")]
extern "C" {
    /// JSON `{"available":bool,"dims":n,"assetsInstalled":bool}`.
    fn mn_embed_availability() -> *mut c_char;
    /// 0 = assets installed (already, or after a download); negative on
    /// failure or the 300s download watchdog.
    fn mn_embed_request_assets() -> i32;
    /// JSON array of strings in → JSON array of f32 arrays out (order
    /// preserved), or an `{"__error": …}` envelope.
    fn mn_embed_batch(json: *const c_char) -> *mut c_char;
    fn mn_embed_free(p: *mut c_char);
}

/// Copy a Swift-allocated C string out and free it. None for null.
#[cfg(target_os = "macos")]
fn take_cstring(raw: *mut c_char) -> Option<String> {
    if raw.is_null() {
        return None;
    }
    // SAFETY: the Swift bridge returns a NUL-terminated UTF-8 buffer
    // allocated with `allocate(capacity:)`; we copy then free exactly once.
    unsafe {
        let s = CStr::from_ptr(raw).to_string_lossy().into_owned();
        mn_embed_free(raw);
        Some(s)
    }
}

// ─── Availability ─────────────────────────────────────────────────────────────

/// What the OS reports about the English contextual-embedding model.
/// `dims` comes from the model's `dimension` property (512 as measured on
/// macOS 26) — read at runtime, never assumed.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Deserialize)]
pub struct Availability {
    pub available: bool,
    pub dims: usize,
    #[serde(rename = "assetsInstalled")]
    pub assets_installed: bool,
}

/// Probe the model's existence and asset state. Cheap (metadata only — no
/// model load) and infallible: any FFI hiccup reads as "not available",
/// which degrades to FTS-only exactly like embeddings-off today.
pub fn availability() -> Availability {
    #[cfg(target_os = "macos")]
    {
        let Some(json) = take_cstring(unsafe { mn_embed_availability() }) else {
            return Availability::default();
        };
        serde_json::from_str(&json).unwrap_or_default()
    }
    #[cfg(not(target_os = "macos"))]
    {
        Availability::default()
    }
}

// ─── Asset download ───────────────────────────────────────────────────────────

/// Ask the OS to install the English embedding assets. Blocking (up to the
/// Swift side's 300s watchdog) — call from `spawn_blocking`. A no-op
/// success when the assets are already on disk (the Swift side never issues
/// a request for installed assets; Apple's asset APIs can stall at 0%
/// forever on those).
pub fn request_assets_blocking() -> Result<()> {
    #[cfg(target_os = "macos")]
    {
        match unsafe { mn_embed_request_assets() } {
            0 => Ok(()),
            -2 => Err(anyhow!("timed out downloading Apple embedding assets")),
            code => Err(anyhow!("Apple embedding asset request failed (code {code})")),
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err(anyhow!("Apple embeddings require macOS"))
    }
}

// ─── Embedding ────────────────────────────────────────────────────────────────

/// Embed a batch of texts on-device. Order preserved; one L2-normalized
/// vector per input. Errors when the model/assets are missing or the Swift
/// side fails — callers degrade to FTS-only.
pub async fn embed(texts: &[String]) -> Result<Vec<Vec<f32>>> {
    if texts.is_empty() {
        return Ok(Vec::new());
    }
    #[cfg(target_os = "macos")]
    {
        let payload = serde_json::to_string(texts)?;
        let expected = texts.len();
        let body = tokio::task::spawn_blocking(move || -> Result<String> {
            let c_json =
                CString::new(payload).map_err(|e| anyhow!("embed input contains NUL: {e}"))?;
            take_cstring(unsafe { mn_embed_batch(c_json.as_ptr()) })
                .ok_or_else(|| anyhow!("Apple embedding returned no payload"))
        })
        .await
        .map_err(|e| anyhow!("apple_embed task join error: {e}"))??;
        parse_embed_json(&body, expected)
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err(anyhow!("Apple embeddings require macOS"))
    }
}

/// Parse the Swift payload: a JSON array of f32 arrays, or an
/// `{"__error": …}` envelope. Pure; unit-tested.
pub(crate) fn parse_embed_json(payload: &str, expected: usize) -> Result<Vec<Vec<f32>>> {
    #[derive(serde::Deserialize)]
    struct ErrorEnvelope {
        __error: String,
    }
    if let Ok(err) = serde_json::from_str::<ErrorEnvelope>(payload) {
        return Err(anyhow!("Apple embedding error: {}", err.__error));
    }
    let vectors: Vec<Vec<f32>> = serde_json::from_str(payload).map_err(|e| {
        let preview: String = payload.chars().take(200).collect();
        anyhow!("Apple embedding returned malformed JSON: {e} (raw: {preview})")
    })?;
    if vectors.len() != expected {
        return Err(anyhow!(
            "Apple embedding returned {} vectors for {} inputs",
            vectors.len(),
            expected
        ));
    }
    Ok(vectors)
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_vector_arrays() {
        let v = parse_embed_json("[[0.1, -0.2], [0.0, 1.0]]", 2).unwrap();
        assert_eq!(v.len(), 2);
        assert_eq!(v[0], vec![0.1, -0.2]);
    }

    #[test]
    fn surfaces_error_envelope() {
        let err = parse_embed_json(r#"{"__error":"embedding model assets are not installed"}"#, 1)
            .unwrap_err();
        assert!(err.to_string().contains("assets are not installed"), "{err}");
    }

    #[test]
    fn rejects_count_mismatch_and_garbage() {
        assert!(parse_embed_json("[[0.1]]", 2).is_err(), "count mismatch must fail");
        for bad in ["", "not json", "{\"x\":1}", "42"] {
            assert!(parse_embed_json(bad, 1).is_err(), "should reject: {bad:?}");
        }
    }

    #[test]
    fn availability_json_decodes() {
        let a: Availability =
            serde_json::from_str(r#"{"available":true,"dims":512,"assetsInstalled":true}"#)
                .unwrap();
        assert!(a.available && a.assets_installed);
        assert_eq!(a.dims, 512);
    }

    /// Live-fire the FFI + NLContextualEmbedding path. Requires macOS with
    /// the English embedding assets installed; skips (with a note) anywhere
    /// else. Run: cargo test real_apple_embed -- --ignored --nocapture
    #[test]
    #[ignore]
    fn real_apple_embed() {
        let avail = availability();
        eprintln!("apple embed availability: {avail:?}");
        if !avail.available || !avail.assets_installed {
            eprintln!("skipping: Apple embedding assets unavailable on this host");
            return;
        }
        let rt = tokio::runtime::Runtime::new().unwrap();
        let texts = vec![
            "who is responsible for hiring".to_string(),
            "Amy will own recruiting for the platform team this quarter".to_string(),
            "the parking garage closes at midnight on weekends".to_string(),
        ];
        let t0 = std::time::Instant::now();
        let vecs = rt.block_on(embed(&texts)).unwrap();
        eprintln!("embedded {} texts in {:?}", vecs.len(), t0.elapsed());
        assert_eq!(vecs.len(), 3);
        assert!(vecs.iter().all(|v| v.len() == avail.dims));
        // Vectors come back L2-normalized, so dot product = cosine sim: the
        // query must sit closer to its zero-keyword-overlap paraphrase than
        // to the unrelated sentence.
        let dot = |a: &[f32], b: &[f32]| a.iter().zip(b).map(|(x, y)| x * y).sum::<f32>();
        let sim_rel = dot(&vecs[0], &vecs[1]);
        let sim_irr = dot(&vecs[0], &vecs[2]);
        eprintln!("dims={} sim(recruiting)={sim_rel:.4} sim(parking)={sim_irr:.4}", avail.dims);
        assert!(sim_rel > sim_irr, "semantic neighbor ordering wrong");
    }
}

/// Compile/link-time C-ABI surface test (same pattern as apple.rs): taking
/// the extern fns' addresses forces the linker to resolve the Swift symbols,
/// so a rename or signature drift in EmbeddingEngine.swift fails
/// `cargo test` at link time instead of at first use.
#[cfg(all(test, target_os = "macos"))]
mod link_tests {
    #[test]
    fn embed_c_abi_symbols_link() {
        let availability: unsafe extern "C" fn() -> *mut super::c_char =
            super::mn_embed_availability;
        let request: unsafe extern "C" fn() -> i32 = super::mn_embed_request_assets;
        let batch: unsafe extern "C" fn(*const super::c_char) -> *mut super::c_char =
            super::mn_embed_batch;
        let free: unsafe extern "C" fn(*mut super::c_char) = super::mn_embed_free;
        assert!(availability as usize != 0);
        assert!(request as usize != 0);
        assert!(batch as usize != 0);
        assert!(free as usize != 0);
    }
}
