pub mod calldetect;
pub mod clip;
pub mod cluster;
pub mod diarize;
pub mod mel;
pub mod mic;
pub mod mixer;
pub mod ringbuf;
pub mod supervise;
pub mod swap;
pub mod system;
pub mod talkstats;
pub mod vpio;

use std::sync::atomic::{AtomicBool, AtomicU64};

/// Samples dropped because a capture ring buffer was full (or, for system
/// audio, because the producer lock was contended). Incremented from the
/// realtime callbacks — cheap atomics only — and drained/logged periodically
/// by the mixer loop so overload is visible instead of silent.
pub static MIC_DROPPED_SAMPLES: AtomicU64 = AtomicU64::new(0);
pub static SYS_DROPPED_SAMPLES: AtomicU64 = AtomicU64::new(0);

/// Milliseconds the mic has been continuously silent while a recording is
/// active (0 when flowing). The mixer maintains it; the level-monitor task
/// warns the user past 5s — a dead AirPods battery used to freeze the whole
/// timeline silently.
pub static MIC_STALL_MS: AtomicU64 = AtomicU64::new(0);

// ── Capture-supervisor observations (the capture-supervisor design §1b) ──

/// Ms since the system tap last delivered ANY samples to the mixer
/// (0 while flowing). Only meaningful while system capture is configured.
/// A started aggregate-device IOProc fires continuously at the device
/// clock even when nothing plays — so a stall is unambiguous breakage,
/// never "genuine silence".
pub static SYS_STALL_MS: AtomicU64 = AtomicU64::new(0);

/// Consecutive ms the tap delivered chunks whose RMS is EXACTLY 0.0
/// (digital silence — a broken tap has no signal path, so its zeros are
/// bit-exact). Ambiguous alone: "nothing playing" is also exact zeros,
/// so the supervisor gates on conversation evidence before acting.
pub static SYS_ZERO_RUN_MS: AtomicU64 = AtomicU64::new(0);

/// Ms since the mic last carried voice (RMS > talkstats::ACTIVE_RMS) —
/// the supervisor's "is a conversation actually happening" gate.
pub static MIC_LAST_VOICE_AGO_MS: AtomicU64 = AtomicU64::new(600_000);

/// Set by the cpal error callback (e.g. DeviceNotAvailable on a clean
/// unplug) so the mic supervisor can skip the stall wait. Cleared at
/// session start and after each rebuild.
pub static MIC_STREAM_ERROR: AtomicBool = AtomicBool::new(false);

/// Live talk-balance snapshot (plan v3 rank 8), written by the mixer each
/// 100ms tick and persisted by stop_recording. Reset when recording starts.
pub static TALK_MIC_MS: AtomicU64 = AtomicU64::new(0);
pub static TALK_SYS_MS: AtomicU64 = AtomicU64::new(0);
pub static TALK_LONGEST_MONO_MS: AtomicU64 = AtomicU64::new(0);
