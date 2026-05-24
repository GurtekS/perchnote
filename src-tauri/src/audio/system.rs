//! System audio capture using CoreAudio CATapDescription (macOS 14.2+).
//!
//! Captures the stereo mixdown of all system audio processes and converts
//! to mono f32. Requires Screen Recording TCC permission. No picker UI.
//!
//! On non-macOS or macOS < 14.2 this module returns an error.

use anyhow::Result;
#[cfg(not(target_os = "macos"))]
use anyhow::anyhow;

use super::ringbuf::{create_audio_ring, AudioConsumer, AudioProducer};

// ─── FFI declarations (implemented in swift/ProcessAudioTap.swift) ────────────

#[cfg(target_os = "macos")]
extern "C" {
    /// Create a capture object. Returns null if macOS < 14.2.
    fn mn_process_audio_tap_create() -> *mut std::ffi::c_void;

    /// Start capturing. `callback` is called on a CoreAudio thread with mono f32 samples.
    /// Returns 0 on success, CoreAudio OSStatus (negative) on failure.
    fn mn_process_audio_tap_start(
        handle: *mut std::ffi::c_void,
        callback: unsafe extern "C" fn(*const f32, i32, *mut std::ffi::c_void),
        user_data: *mut std::ffi::c_void,
    ) -> i32;

    /// Returns the actual sample rate of the captured audio stream.
    fn mn_process_audio_tap_sample_rate(handle: *mut std::ffi::c_void) -> f64;

    /// Stop + free the capture object. The Swift side stops the tap as
    /// part of its destroy path, so no separate stop binding is needed.
    fn mn_process_audio_tap_destroy(handle: *mut std::ffi::c_void);
}

// ─── Audio callback (called on CoreAudio realtime thread) ─────────────────────

#[cfg(target_os = "macos")]
unsafe extern "C" fn on_audio(
    samples: *const f32,
    count: i32,
    user_data: *mut std::ffi::c_void,
) {
    if samples.is_null() || count <= 0 || user_data.is_null() {
        return;
    }
    // user_data is *mut std::sync::Mutex<AudioProducer>
    let mutex = &*(user_data as *const std::sync::Mutex<AudioProducer>);
    if let Ok(mut prod) = mutex.try_lock() {
        use ringbuf::traits::Producer;
        let slice = std::slice::from_raw_parts(samples, count as usize);
        let _ = prod.push_slice(slice);
    }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/// System-wide audio capture via CoreAudio process tap.
pub struct SystemAudioCapture {
    #[cfg(target_os = "macos")]
    handle: *mut std::ffi::c_void,
    /// Raw pointer to the boxed Mutex<AudioProducer> — freed on drop.
    #[cfg(target_os = "macos")]
    producer_raw: *mut std::sync::Mutex<AudioProducer>,
}

// The handle and producer_raw are owned exclusively by this struct.
#[cfg(target_os = "macos")]
unsafe impl Send for SystemAudioCapture {}
#[cfg(target_os = "macos")]
unsafe impl Sync for SystemAudioCapture {}

#[cfg(target_os = "macos")]
impl SystemAudioCapture {
    /// Start capturing all system audio. Returns `(Self, consumer, sample_rate)`.
    ///
    /// Requires macOS 14.2+ and Screen Recording TCC permission.
    /// Non-blocking — no picker UI is shown.
    pub fn start() -> Result<(Self, AudioConsumer, u32)> {
        let handle = unsafe { mn_process_audio_tap_create() };
        if handle.is_null() {
            return Err(anyhow::anyhow!(
                "system audio capture requires macOS 14.2 or later"
            ));
        }

        let (producer, consumer) = create_audio_ring(48000 * 8);

        // Box the producer inside a Mutex and leak it so the CoreAudio
        // callback thread can write to it safely without requiring Send.
        let producer_mutex = Box::new(std::sync::Mutex::new(producer));
        let producer_raw = Box::into_raw(producer_mutex);

        let status = unsafe {
            mn_process_audio_tap_start(handle, on_audio, producer_raw as *mut std::ffi::c_void)
        };

        if status != 0 {
            unsafe {
                drop(Box::from_raw(producer_raw));
                mn_process_audio_tap_destroy(handle);
            }
            return Err(anyhow::anyhow!(
                "process audio tap start failed (OSStatus {}). \
                 Check System Settings > Privacy > Screen Recording.",
                status
            ));
        }

        let actual_rate = unsafe { mn_process_audio_tap_sample_rate(handle) };
        let actual_rate = if actual_rate > 0.0 { actual_rate as u32 } else { 48000 };

        log::info!(
            "system audio capture: CoreAudio process tap started at {}Hz mono (no picker needed)",
            actual_rate
        );

        Ok((Self { handle, producer_raw }, consumer, actual_rate))
    }
}

#[cfg(target_os = "macos")]
impl Drop for SystemAudioCapture {
    fn drop(&mut self) {
        unsafe {
            mn_process_audio_tap_destroy(self.handle);
            self.handle = std::ptr::null_mut();
            if !self.producer_raw.is_null() {
                drop(Box::from_raw(self.producer_raw));
                self.producer_raw = std::ptr::null_mut();
            }
        }
    }
}

// ─── Non-macOS stub ───────────────────────────────────────────────────────────

#[cfg(not(target_os = "macos"))]
impl SystemAudioCapture {
    pub fn start() -> Result<(Self, AudioConsumer, u32)> {
        Err(anyhow!("system audio capture requires macOS"))
    }
}

#[cfg(not(target_os = "macos"))]
impl Drop for SystemAudioCapture {
    fn drop(&mut self) {}
}
