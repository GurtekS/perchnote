//! Apple Intelligence (FoundationModels) backend.
//!
//! Calls the Swift bridge in `swift/AppleAI.swift`. All entry points are
//! synchronous from Swift's perspective (they internally block on a Task),
//! so we wrap them in `tokio::task::spawn_blocking` to keep the runtime
//! happy.
//!
//! On macOS < 26, FoundationModels isn't present and `mn_apple_ai_available`
//! returns false — all generation calls then return an error pointing the
//! user back to Settings.

use anyhow::{anyhow, Result};
use serde::Deserialize;
use std::collections::HashMap;
use std::ffi::{CStr, CString};
use std::os::raw::c_char;

use super::anthropic_api::GeneratedNotes;
use super::prompts::build_diarization_prompt;

#[cfg(target_os = "macos")]
extern "C" {
    fn mn_apple_ai_available() -> bool;
    fn mn_apple_ai_generate_notes(prompt: *const c_char) -> *mut c_char;
    fn mn_apple_ai_rediarize(prompt: *const c_char) -> *mut c_char;
    fn mn_apple_ai_chat(prompt: *const c_char) -> *mut c_char;
    fn mn_apple_ai_free(p: *mut c_char);
}

#[cfg(not(target_os = "macos"))]
unsafe fn mn_apple_ai_available() -> bool { false }
#[cfg(not(target_os = "macos"))]
unsafe fn mn_apple_ai_generate_notes(_: *const c_char) -> *mut c_char { std::ptr::null_mut() }
#[cfg(not(target_os = "macos"))]
unsafe fn mn_apple_ai_rediarize(_: *const c_char) -> *mut c_char { std::ptr::null_mut() }
#[cfg(not(target_os = "macos"))]
unsafe fn mn_apple_ai_chat(_: *const c_char) -> *mut c_char { std::ptr::null_mut() }
#[cfg(not(target_os = "macos"))]
unsafe fn mn_apple_ai_free(_: *mut c_char) {}

pub fn is_available() -> bool {
    unsafe { mn_apple_ai_available() }
}

/// Common pattern: hand a String to the Swift bridge, get a String back, or
/// an error if FoundationModels is unavailable or the Swift side errored.
async fn call_swift<F>(prompt: String, swift_fn: F) -> Result<String>
where
    F: FnOnce(*const c_char) -> *mut c_char + Send + 'static,
{
    if !is_available() {
        return Err(anyhow!(
            "Apple Intelligence is unavailable. Enable it in System Settings → Apple Intelligence, or pick a different provider in Settings → AI."
        ));
    }

    tokio::task::spawn_blocking(move || {
        let c_prompt = CString::new(prompt).map_err(|e| anyhow!("prompt contains NUL: {}", e))?;
        let raw = swift_fn(c_prompt.as_ptr());
        if raw.is_null() {
            return Err(anyhow!("Apple Intelligence returned no response"));
        }
        // SAFETY: the Swift bridge returned a NUL-terminated UTF-8 buffer
        // allocated with `allocate(capacity:)`. We copy it out and then free
        // it via `mn_apple_ai_free`.
        let response = unsafe {
            let s = CStr::from_ptr(raw).to_string_lossy().into_owned();
            mn_apple_ai_free(raw);
            s
        };
        // The Swift side encodes errors as a sentinel prefix / JSON object.
        if response.starts_with("__error:") {
            return Err(anyhow!("Apple Intelligence error: {}", &response[8..]));
        }
        if let Ok(err) = serde_json::from_str::<ErrorEnvelope>(&response) {
            return Err(anyhow!("Apple Intelligence error: {}", err.__error));
        }
        Ok(response)
    })
    .await
    .map_err(|e| anyhow!("apple_ai task join error: {}", e))?
}

#[derive(Deserialize)]
struct ErrorEnvelope {
    __error: String,
}

pub async fn generate_notes(prompt: &str) -> Result<GeneratedNotes> {
    let body = call_swift(prompt.to_string(), |p| unsafe { mn_apple_ai_generate_notes(p) }).await?;
    serde_json::from_str::<GeneratedNotes>(&body)
        .map_err(|e| anyhow!("Apple Intelligence returned non-conforming notes JSON: {} (raw: {})", e, body))
}

pub async fn rediarize(segments: &[(usize, &str)]) -> Result<HashMap<usize, String>> {
    if segments.is_empty() {
        return Ok(HashMap::new());
    }
    let prompt = build_diarization_prompt(segments);
    let body = call_swift(prompt, |p| unsafe { mn_apple_ai_rediarize(p) }).await?;

    #[derive(Deserialize)]
    struct Assignment { index: usize, speaker: String }
    #[derive(Deserialize)]
    struct DiarizationOutput { assignments: Vec<Assignment> }

    let parsed: DiarizationOutput = serde_json::from_str(&body)
        .map_err(|e| anyhow!("Apple Intelligence returned non-conforming diarization JSON: {} (raw: {})", e, body))?;
    Ok(parsed.assignments.into_iter().map(|a| (a.index, a.speaker)).collect())
}

pub async fn chat(prompt: &str) -> Result<String> {
    call_swift(prompt.to_string(), |p| unsafe { mn_apple_ai_chat(p) }).await
}
