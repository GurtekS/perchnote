use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use tokio::sync::mpsc;

use crate::audio::system::SystemAudioCapture;
use crate::transcription::whisper::TranscriptSegment;

/// Lightweight recording state that is Send + Sync safe.
/// The actual cpal Stream is managed on its own thread and only
/// controlled via the `stop_flag`.
#[derive(Default)]
pub struct RecordingState {
    pub is_recording: bool,
    /// Whether the recording is paused
    pub is_paused: bool,
    pub meeting_id: Option<String>,
    /// SESSION flag: keeps the mixer loop + level monitor alive. Distinct
    /// from `mic_stream_stop` (design §1c) — killing one mic stream must
    /// not end the session once the supervisor can rebuild streams.
    pub stop_flag: Option<Arc<AtomicBool>>,
    /// The CURRENT cpal mic stream's own kill flag — its owning thread
    /// drops the !Send Stream when this goes false. Replaced by the mic
    /// supervisor on every rebuild.
    pub mic_stream_stop: Option<Arc<AtomicBool>>,
    /// Pause/resume flag — when true, the mixer skips writing audio
    pub pause_flag: Option<Arc<AtomicBool>>,
    pub segment_tx: Option<mpsc::Sender<TranscriptSegment>>,
    /// System audio capture handle — kept alive while recording 
    pub system_audio_capture: Option<SystemAudioCapture>,
    /// WAV file path for the current recording 
    pub wav_path: Option<PathBuf>,
    /// Mixer thread handle — joined in stop_recording to ensure WAV is finalized
    pub mixer_join: Option<JoinHandle<()>>,
}

pub struct AppState {
    pub recording: Mutex<RecordingState>,
    /// ⌘D timestamps whose transcript segment hasn't arrived yet — the
    /// forwarding loop applies them as segments land (plan v3 rank 6).
    pub pending_highlights: Mutex<Vec<u64>>,
    /// Meeting IDs for which a "starting soon" notification has already been sent this session.
    pub notified_meetings: Mutex<HashSet<String>>,
    /// Meeting ID to navigate to when the app window next gains focus (set on notification fire).
    pub pending_navigation: Mutex<Option<String>>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            recording: Mutex::new(RecordingState::default()),
            pending_highlights: Mutex::new(Vec::new()),
            notified_meetings: Mutex::new(HashSet::new()),
            pending_navigation: Mutex::new(None),
        }
    }
}
