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
    pub stop_flag: Option<Arc<AtomicBool>>,
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
    /// Meeting IDs for which a "starting soon" notification has already been sent this session.
    pub notified_meetings: Mutex<HashSet<String>>,
    /// Meeting ID to navigate to when the app window next gains focus (set on notification fire).
    pub pending_navigation: Mutex<Option<String>>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            recording: Mutex::new(RecordingState::default()),
            notified_meetings: Mutex::new(HashSet::new()),
            pending_navigation: Mutex::new(None),
        }
    }
}
