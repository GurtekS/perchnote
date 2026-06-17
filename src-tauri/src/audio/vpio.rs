//! Echo-cancelled mic capture via Apple's voice-processing I/O unit
//! (kAudioUnitSubType_VoiceProcessingIO; implemented in
//! swift/VoiceProcessedMic.swift). The unit cancels what the SYSTEM is
//! playing out of the speakers from the mic signal — the exact
//! remote-speech-re-capture problem of no-headphones meetings (plan v9 #2).
//!
//! Public shape mirrors `mic::start_mic_capture` (same `MicCaptureStart`:
//! ring consumer + reported rate + stop flag), so the mixer/supervisor
//! pipeline is unchanged. VPIO always binds the system-default input; a
//! custom mic selection keeps the standard cpal path (`should_use_vpio`),
//! and any VPIO init failure falls back to cpal (`choose_capture`) —
//! AEC must never be the reason a recording fails to start.

use anyhow::Result;
#[cfg(not(target_os = "macos"))]
use anyhow::anyhow;

use super::mic::MicCaptureStart;
#[cfg(target_os = "macos")]
use super::ringbuf::{create_audio_ring, AudioProducer};

// ─── Capture-choice policy (pure; unit-tested) ────────────────────────────────

/// Parse the persisted `echo_cancellation` setting. Absent/garbage = OFF —
/// the feature is experimental and strictly opt-in until the real-hardware
/// QA matrix (speakers / AirPods / HFP) passes.
pub fn echo_cancellation_enabled(setting: Option<String>) -> bool {
    setting.as_deref() == Some("true")
}

/// Whether this session should use the voice-processed (echo-cancelled)
/// capture path. VPIO binds the system-default input device, so a specific
/// mic selection wins over AEC: the user asked for THAT device.
pub fn should_use_vpio(echo_cancellation: bool, custom_device: Option<&str>) -> bool {
    echo_cancellation && custom_device.map_or(true, str::is_empty)
}

/// Start a mic source honoring the session's capture choice. When `use_vpio`
/// is set, try the voice-processed constructor first and FALL BACK to the
/// standard one on error — an AEC init failure must degrade, never fail the
/// recording. Returns `(capture, used_vpio)` so callers can surface the
/// fallback through the existing warning/banner machinery.
pub fn choose_capture<T, FV, FC>(use_vpio: bool, vpio: FV, standard: FC) -> Result<(T, bool)>
where
    FV: FnOnce() -> Result<T>,
    FC: FnOnce() -> Result<T>,
{
    if use_vpio {
        match vpio() {
            Ok(t) => return Ok((t, true)),
            Err(e) => log::warn!(
                "echo-cancelled capture failed to initialize: {e} — falling back to standard mic capture"
            ),
        }
    }
    standard().map(|t| (t, false))
}

// ─── FFI declarations (implemented in swift/VoiceProcessedMic.swift) ──────────

#[cfg(target_os = "macos")]
extern "C" {
    /// Create a capture object. Returns null if macOS < 14.2.
    fn mn_voice_mic_create() -> *mut std::ffi::c_void;

    /// Start capturing. `callback` runs on an AVAudioEngine render thread
    /// with echo-cancelled mono f32 samples. 0 on success, negative on failure.
    fn mn_voice_mic_start(
        handle: *mut std::ffi::c_void,
        callback: unsafe extern "C" fn(*const f32, i32, *mut std::ffi::c_void),
        user_data: *mut std::ffi::c_void,
    ) -> i32;

    /// Actual sample rate of the captured stream (valid after start).
    fn mn_voice_mic_sample_rate(handle: *mut std::ffi::c_void) -> f64;

    /// Stop + free the capture object. The Swift side stops the engine as
    /// part of its destroy path, so no separate stop binding is needed.
    fn mn_voice_mic_destroy(handle: *mut std::ffi::c_void);
}

// ─── Audio callback (called on AVAudioEngine render thread) ───────────────────

#[cfg(target_os = "macos")]
unsafe extern "C" fn on_vpio_audio(
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
        let written = prod.push_slice(slice);
        if written < slice.len() {
            super::MIC_DROPPED_SAMPLES.fetch_add(
                (slice.len() - written) as u64,
                std::sync::atomic::Ordering::Relaxed,
            );
        }
    } else {
        // Contended with the mixer — count the loss like the cpal path does.
        super::MIC_DROPPED_SAMPLES
            .fetch_add(count as u64, std::sync::atomic::Ordering::Relaxed);
    }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/// Start echo-cancelled mic capture on the system-default input device.
/// Same contract as `mic::start_mic_capture`: flip `stop_flag` to false to
/// tear the capture down (a dedicated thread owns the Swift object, exactly
/// like the cpal thread owns its stream).
///
/// Health note: VPIO has no cpal-style error callback, so `MIC_STREAM_ERROR`
/// stays false — a dead source is still caught by the supervisor's
/// `MIC_STALL_MS` consumer-side stall detector, which triggers the same
/// rebuild path.
#[cfg(target_os = "macos")]
pub fn start_vpio_capture() -> Result<MicCaptureStart> {
    // AVAudioEngine.inputNode raises an (uncatchable from Swift) ObjC
    // exception when no input device exists at all — preflight via cpal so
    // "no mic" surfaces as the same error the standard path would produce.
    use cpal::traits::HostTrait;
    let host = cpal::default_host();
    let device = host
        .default_input_device()
        .ok_or_else(|| anyhow::anyhow!("no input device found"))?;
    #[allow(deprecated)] // same audio_device-by-name world as mic.rs
    let device_name = {
        use cpal::traits::DeviceTrait;
        device.name().unwrap_or_else(|_| "<unknown>".to_string())
    };

    let handle = unsafe { mn_voice_mic_create() };
    if handle.is_null() {
        return Err(anyhow::anyhow!(
            "voice-processing capture requires macOS 14.2 or later"
        ));
    }

    // 10s of headroom at the worst-case rate, matching the cpal ring sizing.
    let (producer, consumer) = create_audio_ring(48_000 * 10);
    let producer_mutex = Box::new(std::sync::Mutex::new(producer));
    let producer_raw = Box::into_raw(producer_mutex);

    let status = unsafe {
        mn_voice_mic_start(handle, on_vpio_audio, producer_raw as *mut std::ffi::c_void)
    };
    if status != 0 {
        unsafe {
            mn_voice_mic_destroy(handle);
            drop(Box::from_raw(producer_raw));
        }
        return Err(anyhow::anyhow!(
            "voice-processing unit failed to start (status {status})"
        ));
    }

    let reported = unsafe { mn_voice_mic_sample_rate(handle) };
    let sample_rate = if reported > 0.0 {
        reported as u32
    } else {
        log::warn!(
            "voice-processing unit reported invalid sample rate {reported}; assuming 48000Hz"
        );
        48_000
    };

    // Same stop semantics as the cpal path: a dedicated thread owns the
    // capture and tears it down when the flag flips false. Raw pointers
    // aren't Send — move them as addresses; this thread is their sole owner
    // from here on.
    let stop_flag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true));
    let thread_flag = stop_flag.clone();
    let handle_addr = handle as usize;
    let producer_addr = producer_raw as usize;
    std::thread::spawn(move || {
        use std::sync::atomic::Ordering;
        while thread_flag.load(Ordering::Relaxed) {
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        unsafe {
            mn_voice_mic_destroy(handle_addr as *mut std::ffi::c_void);
            // Grace period: destroy stops the engine synchronously, but give
            // any in-flight tap block time to return before freeing the ring
            // producer it writes into.
            std::thread::sleep(std::time::Duration::from_millis(50));
            drop(Box::from_raw(
                producer_addr as *mut std::sync::Mutex<AudioProducer>,
            ));
        }
    });

    log::info!(
        "echo-cancelled mic capture (VoiceProcessingIO) running at {}Hz on '{}'",
        sample_rate,
        device_name
    );

    Ok(MicCaptureStart {
        stop_flag,
        consumer,
        sample_rate,
        device_name,
        fell_back_from: None,
    })
}

// ─── Non-macOS stub ───────────────────────────────────────────────────────────

#[cfg(not(target_os = "macos"))]
pub fn start_vpio_capture() -> Result<MicCaptureStart> {
    Err(anyhow!("voice-processing capture requires macOS"))
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    // ── setting parse: experimental ⇒ default OFF ──

    #[test]
    fn echo_cancellation_defaults_off_when_unset() {
        assert!(!echo_cancellation_enabled(None));
    }

    #[test]
    fn echo_cancellation_only_exact_true_enables() {
        assert!(echo_cancellation_enabled(Some("true".into())));
        assert!(!echo_cancellation_enabled(Some("false".into())));
        assert!(!echo_cancellation_enabled(Some("TRUE".into())));
        assert!(!echo_cancellation_enabled(Some("1".into())));
        assert!(!echo_cancellation_enabled(Some(String::new())));
    }

    /// Setting plumb test against the real DB layer: the exact reads
    /// `start_recording` performs, with and without the setting persisted.
    #[test]
    fn echo_cancellation_setting_plumbs_through_db() {
        let db = crate::db::Database::new_in_memory().unwrap();
        // Fresh install: no row ⇒ OFF.
        assert!(!echo_cancellation_enabled(
            db.get_setting("echo_cancellation").ok().flatten()
        ));
        db.set_setting("echo_cancellation", "true").unwrap();
        assert!(echo_cancellation_enabled(
            db.get_setting("echo_cancellation").ok().flatten()
        ));
        db.set_setting("echo_cancellation", "false").unwrap();
        assert!(!echo_cancellation_enabled(
            db.get_setting("echo_cancellation").ok().flatten()
        ));
    }

    // ── should_use_vpio: custom mic selection wins over AEC ──

    #[test]
    fn vpio_used_when_enabled_and_no_custom_device() {
        assert!(should_use_vpio(true, None));
        assert!(should_use_vpio(true, Some(""))); // "System Default" stores ""
    }

    #[test]
    fn vpio_skipped_for_custom_device_or_disabled_setting() {
        assert!(!should_use_vpio(true, Some("MacBook Pro Microphone")));
        assert!(!should_use_vpio(false, None));
        assert!(!should_use_vpio(false, Some("MacBook Pro Microphone")));
    }

    // ── choose_capture: fallback-on-error, never-fail-for-AEC ──

    #[test]
    fn choose_capture_uses_vpio_when_it_initializes() {
        let standard_called = Cell::new(false);
        let (got, used_vpio) = choose_capture(
            true,
            || Ok("vpio"),
            || {
                standard_called.set(true);
                Ok("cpal")
            },
        )
        .unwrap();
        assert_eq!(got, "vpio");
        assert!(used_vpio);
        assert!(!standard_called.get(), "standard ctor must not run when VPIO succeeds");
    }

    #[test]
    fn choose_capture_falls_back_when_vpio_ctor_fails() {
        let (got, used_vpio) = choose_capture(
            true,
            || Err::<&str, _>(anyhow::anyhow!("AUAudioUnit init failed")),
            || Ok("cpal"),
        )
        .unwrap();
        assert_eq!(got, "cpal", "VPIO init failure must degrade to plain capture");
        assert!(!used_vpio, "caller needs the fallback signal for the warning banner");
    }

    #[test]
    fn choose_capture_skips_vpio_ctor_entirely_when_off() {
        let vpio_called = Cell::new(false);
        let (got, used_vpio) = choose_capture(
            false,
            || {
                vpio_called.set(true);
                Ok("vpio")
            },
            || Ok("cpal"),
        )
        .unwrap();
        assert_eq!(got, "cpal");
        assert!(!used_vpio);
        assert!(!vpio_called.get(), "AEC off must never touch the VPIO ctor");
    }

    #[test]
    fn choose_capture_surfaces_standard_error_when_both_fail() {
        let err = choose_capture::<&str, _, _>(
            true,
            || Err(anyhow::anyhow!("vpio down")),
            || Err(anyhow::anyhow!("no input device found")),
        )
        .unwrap_err();
        assert!(err.to_string().contains("no input device"));
    }
}

/// Compile/link-time C-ABI surface test: taking the extern fns' addresses
/// forces the linker to resolve the Swift symbols, so a rename or signature
/// drift in VoiceProcessedMic.swift fails `cargo test` at link time instead
/// of at first recording.
#[cfg(all(test, target_os = "macos"))]
mod link_tests {
    #[test]
    fn vpio_c_abi_symbols_link() {
        let create: unsafe extern "C" fn() -> *mut std::ffi::c_void = super::mn_voice_mic_create;
        let start: unsafe extern "C" fn(
            *mut std::ffi::c_void,
            unsafe extern "C" fn(*const f32, i32, *mut std::ffi::c_void),
            *mut std::ffi::c_void,
        ) -> i32 = super::mn_voice_mic_start;
        let rate: unsafe extern "C" fn(*mut std::ffi::c_void) -> f64 =
            super::mn_voice_mic_sample_rate;
        let destroy: unsafe extern "C" fn(*mut std::ffi::c_void) = super::mn_voice_mic_destroy;
        assert!(create as usize != 0);
        assert!(start as usize != 0);
        assert!(rate as usize != 0);
        assert!(destroy as usize != 0);
    }
}
