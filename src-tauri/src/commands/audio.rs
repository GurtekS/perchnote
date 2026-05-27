use std::sync::atomic::Ordering;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::mpsc;

use crate::audio::mic::start_mic_capture;
use crate::audio::mixer::AudioMixer;
use crate::audio::system::SystemAudioCapture;
use crate::db::Database;
use crate::state::AppState;
use crate::transcription::whisper::{TranscriptSegment, WhisperConfig, WhisperSidecar};
use crate::ai::{self, prompts};

/// Audio level event payload emitted to the frontend 
#[derive(Debug, Clone, Serialize)]
pub struct AudioLevelEvent {
    /// Current RMS level (0.0 to 1.0)
    pub rms: f32,
    /// Peak level (0.0 to 1.0)
    pub peak: f32,
    /// Quality assessment: "good", "fair", or "poor"
    pub quality: String,
}

#[tauri::command]
pub fn list_audio_devices() -> Vec<String> {
    crate::audio::mic::list_input_devices()
}

/// List available output devices — for Bluetooth/AirPods enumeration 
#[tauri::command]
pub fn list_output_devices() -> Vec<String> {
    crate::audio::mic::list_output_devices()
}

#[tauri::command]
pub async fn start_recording(
    app: AppHandle,
    state: State<'_, AppState>,
    db: State<'_, Database>,
    meeting_id: String,
    device_name: Option<String>,
) -> Result<(), String> {
    // Quick pre-check without holding the lock for long operations
    {
        let recording = state.recording.lock()
            .map_err(|_| "internal state error (mutex poisoned)".to_string())?;
        if recording.is_recording {
            return Err("already recording".to_string());
        }
    }

    // Read audio settings from DB 
    let capture_system_audio = db.get_setting("capture_system_audio")
        .ok().flatten().map(|v| v == "true").unwrap_or(true);
    let stereo_recording = db.get_setting("stereo_recording")
        .ok().flatten().map(|v| v == "true").unwrap_or(false);
    let noise_cancellation = db.get_setting("noise_cancellation")
        .ok().flatten().map(|v| v == "true").unwrap_or(true);
    let agc_enabled = db.get_setting("agc_enabled")
        .ok().flatten().map(|v| v == "true").unwrap_or(false);
    let noise_gate_threshold = db.get_setting("noise_gate_threshold")
        .ok().flatten().and_then(|v| v.parse::<f32>().ok()).unwrap_or(0.003);

    // Start mic capture (runs on its own thread)
    log::info!("starting mic capture (device: {:?}, stereo: {})", device_name, stereo_recording);
    let mic = start_mic_capture(device_name.as_deref()).map_err(|e| {
        log::error!("mic capture failed: {}", e);
        format!("Microphone error: {}. Check System Settings > Privacy > Microphone.", e)
    })?;
    let stop_flag = mic.stop_flag;
    let mic_consumer = mic.consumer;
    let mic_rate = mic.sample_rate;

    // Tell the frontend what device we're actually recording with — that's
    // the source of truth for the in-toolbar mic picker. Always emitted,
    // even when we used the requested device exactly.
    let _ = app.emit("audio-device-active", &mic.device_name);

    // If the saved mic name pointed at a device that's no longer present,
    // tell the user what we fell back to and clear the stale setting so
    // future recordings don't try to use the missing name again.
    if let Some(missing) = mic.fell_back_from {
        let msg = format!(
            "Microphone '{}' wasn't available. Recording with '{}' instead.",
            missing, mic.device_name
        );
        log::warn!("{}", msg);
        let _ = app.emit("recording-warning", &msg);
        let _ = db.set_setting("audio_device", "");
    }

    // Optionally start system audio capture (CoreAudio process tap — non-blocking, no picker).
    let sys_capture_result: Option<Result<(SystemAudioCapture, _, u32), String>> = if capture_system_audio {
        log::info!("starting system audio capture");
        match SystemAudioCapture::start() {
            Ok(triple) => Some(Ok(triple)),
            Err(e) => {
                log::warn!("system audio capture failed: {}, continuing with mic only", e);
                Some(Err(e.to_string()))
            }
        }
    } else {
        None
    };

    // Acquire the recording mutex for state setup
    let mut recording = state.recording.lock()
        .map_err(|_| "internal state error (mutex poisoned)".to_string())?;

    if recording.is_recording {
        return Err("already recording".to_string());
    }

    let (sys_consumer, sys_rate) = match sys_capture_result {
        Some(Ok((capture, consumer, rate))) => {
            recording.system_audio_capture = Some(capture);
            (Some(consumer), Some(rate))
        }
        Some(Err(ref e)) => {
            let msg = format!("System audio capture unavailable: {}. Check System Settings → Privacy → Screen Recording.", e);
            let _ = app.emit("recording-warning", &msg);
            (None, None)
        }
        None => (None, None),
    };

    // Set up WAV path
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let recordings_dir = app_data_dir.join("recordings");
    std::fs::create_dir_all(&recordings_dir).map_err(|e| e.to_string())?;
    let wav_path = recordings_dir.join(format!("{}.wav", meeting_id));

    // Create pause flag for pause/resume 
    let pause_flag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));

    // Start mixer with extended options 
    let (mut mixer, audio_rx) = AudioMixer::start(
        mic_consumer,
        mic_rate,
        sys_consumer,
        sys_rate,
        wav_path.clone(),
        stereo_recording,
        agc_enabled,
        noise_cancellation,
        noise_gate_threshold,
        pause_flag.clone(),
    )
    .map_err(|e| e.to_string())?;

    let mixer_stop_flag = stop_flag.clone();

    // Store WAV path for playback later 
    recording.wav_path = Some(wav_path);
    recording.mixer_join = mixer.join_handle.take();

    // Start audio level monitoring — emits events for the VU meter and quality indicator 
    let level_stop = stop_flag.clone();
    let level_app = app.clone();
    let level_reader = mixer.level_reader();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_millis(100));
        loop {
            interval.tick().await;
            if !level_stop.load(Ordering::Relaxed) {
                break;
            }
            let (rms, peak) = level_reader.load();
            let quality = if rms > 0.02 {
                "good"
            } else if rms > 0.005 {
                "fair"
            } else {
                "poor"
            };
            let _ = level_app.emit("audio-level", AudioLevelEvent {
                rms,
                peak,
                quality: quality.to_string(),
            });
        }
    });

    // Set up transcript segment channel
    let (segment_tx, mut segment_rx) = mpsc::channel::<TranscriptSegment>(100);

    // Reuse existing transcript if present (append), otherwise create a new one.
    // Calculate time_offset so new segments continue from where the old ones ended.
    let (transcript_id, time_offset) = match db.get_transcript_by_meeting(&meeting_id).ok().flatten() {
        Some(existing) => {
            let last_end_ms: u64 = serde_json::from_str::<Vec<serde_json::Value>>(&existing.segments)
                .ok()
                .and_then(|segs| segs.last().cloned())
                .and_then(|seg| seg.get("end_ms").and_then(|v| v.as_u64()))
                .unwrap_or(0);
            (existing.id, last_end_ms.saturating_add(1000))
        }
        None => {
            let transcript = db
                .create_transcript(&meeting_id, "local_whisper")
                .map_err(|e| e.to_string())?;
            (transcript.id, 0u64)
        }
    };

    // Forward segments to frontend and save to DB
    let app_for_segments = app.clone();
    tokio::spawn(async move {
        let db_ref = app_for_segments.state::<Database>();
        while let Some(segment) = segment_rx.recv().await {
            // Apply time offset so appended segments continue from where the last session ended
            let stored = if time_offset > 0 {
                crate::transcription::whisper::TranscriptSegment {
                    start_ms: segment.start_ms.saturating_add(time_offset),
                    end_ms: segment.end_ms.saturating_add(time_offset),
                    words: segment.words.as_ref().map(|ws| {
                        ws.iter().map(|w| crate::transcription::whisper::WordTimestamp {
                            start_ms: w.start_ms.saturating_add(time_offset),
                            end_ms: w.end_ms.saturating_add(time_offset),
                            word: w.word.clone(),
                        }).collect()
                    }),
                    ..segment.clone()
                }
            } else {
                segment
            };
            let segment_json = serde_json::to_string(&stored).unwrap_or_default();
            let _ = db_ref.append_transcript_segment(&transcript_id, &segment_json);
            let _ = app_for_segments.emit("transcript-segment", &stored);
        }
    });

    // Find whisper-cli binary: check bundled sidecar, then common paths, then PATH
    let bundled_path = app_data_dir.join("sidecars").join("whisper-cli");
    let whisper_path = if bundled_path.exists() {
        Some(bundled_path)
    } else {
        ["/opt/homebrew/bin/whisper-cli", "/usr/local/bin/whisper-cli"]
            .iter()
            .map(std::path::PathBuf::from)
            .find(|p| p.exists())
            .or_else(|| {
                which::which("whisper-cli").ok()
            })
    };

    // Check user's preferred model from settings
    let preferred_model = db.get_setting("whisper_model")
        .ok()
        .flatten()
        .unwrap_or_else(|| "medium.en".to_string());
    log::info!("preferred whisper model: {}", preferred_model);

    let model_filename = format!("ggml-{}.bin", preferred_model);
    let mut model_candidates: Vec<std::path::PathBuf> = vec![
        app_data_dir.join("models").join(&model_filename),
        std::path::PathBuf::from(format!("/opt/homebrew/share/whisper-cpp/models/{}", model_filename)),
        std::path::PathBuf::from(format!("/usr/local/share/whisper-cpp/models/{}", model_filename)),
    ];
    for fallback in &["ggml-medium.en.bin", "ggml-base.en.bin"] {
        for dir in &[
            app_data_dir.join("models"),
            std::path::PathBuf::from("/opt/homebrew/share/whisper-cpp/models"),
            std::path::PathBuf::from("/usr/local/share/whisper-cpp/models"),
        ] {
            let path = dir.join(fallback);
            if !model_candidates.contains(&path) {
                model_candidates.push(path);
            }
        }
    }
    let model_path = model_candidates.iter().find(|p| p.exists()).cloned();

    // Build WhisperConfig from settings 
    let whisper_config = WhisperConfig {
        language: db.get_setting("whisper_language").ok().flatten(),
        gpu_enabled: db.get_setting("gpu_acceleration").ok().flatten()
            .map(|v| v == "true").unwrap_or(false),
        custom_vocabulary: db.get_setting("custom_vocabulary").ok().flatten(),
        noise_cancellation,
        noise_gate_threshold,
    };

    match (whisper_path, model_path) {
        (Some(wp), Some(mp)) => {
            let segment_tx_clone = segment_tx.clone();
            let app_for_status = app.clone();
            let wp_display = wp.display().to_string();
            let _ = app.emit("transcription-status", "starting");
            tokio::spawn(async move {
                match WhisperSidecar::start(wp, mp, audio_rx, segment_tx_clone, whisper_config).await {
                    Ok(handle) => {
                        let _ = app_for_status.emit("transcription-status", "running");
                        // If the transcription task panics or exits unexpectedly, surface it
                        if let Err(e) = handle.await {
                            log::error!("whisper transcription task failed: {:?}", e);
                            let _ = app_for_status.emit(
                                "transcription-status",
                                "Transcription stopped unexpectedly — check logs",
                            );
                        }
                    }
                    Err(e) => {
                        let msg = format!("Whisper failed to start: {}", e);
                        log::error!("{}", msg);
                        let _ = app_for_status.emit("transcription-status", &msg);
                    }
                }
            });
            log::info!("whisper-cli started from {}", wp_display);
        }
        (None, _) => {
            let msg = "whisper-cli not found. Install it: brew install whisper-cpp";
            log::warn!("{}", msg);
            let _ = app.emit("transcription-status", msg);
            drop(audio_rx);
        }
        (_, None) => {
            let models_dir = app_data_dir.join("models");
            let msg = format!(
                "Whisper model not found. Download it:\nmkdir -p {} && curl -L -o {}/ggml-medium.en.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.en.bin",
                models_dir.display(), models_dir.display()
            );
            log::warn!("{}", msg);
            let _ = app.emit("transcription-status", &msg);
            drop(audio_rx);
        }
    }

    // Update meeting status and recording device info
    let _ = db.update_meeting_status(&meeting_id, "recording");
    let _ = db.update_meeting_times(&meeting_id, Some(&chrono::Utc::now().to_rfc3339()), None);
    let _ = db.update_meeting_device(&meeting_id, device_name.as_deref(), sys_rate.is_some());

    recording.is_recording = true;
    recording.meeting_id = Some(meeting_id);
    recording.stop_flag = Some(stop_flag);
    recording.pause_flag = Some(pause_flag);
    recording.segment_tx = Some(segment_tx);

    // Keep mixer reference alive in a background task
    tokio::spawn(async move {
        while mixer_stop_flag.load(Ordering::Relaxed) {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        mixer.stop();
    });

    Ok(())
}

#[tauri::command]
pub async fn stop_recording(
    _app: AppHandle,
    state: State<'_, AppState>,
    db: State<'_, Database>,
) -> Result<String, String> {
    let mut recording = state.recording.lock()
        .map_err(|_| "internal state error".to_string())?;

    if !recording.is_recording {
        return Err("not recording".to_string());
    }

    if let Some(flag) = recording.stop_flag.take() {
        flag.store(false, Ordering::Relaxed);
    }
    recording.segment_tx.take();
    recording.pause_flag.take();
    recording.system_audio_capture.take();

    let meeting_id = recording
        .meeting_id
        .take()
        .ok_or("no meeting id")?;

    let wav_path = recording.wav_path.clone();
    let mixer_join = recording.mixer_join.take();

    recording.is_recording = false;
    recording.is_paused = false;

    let _ = db.update_meeting_status(&meeting_id, "transcribing");
    let _ = db.update_meeting_times(
        &meeting_id,
        None,
        Some(&chrono::Utc::now().to_rfc3339()),
    );

    // Wait for mixer thread to finish (ensures wav_writer.finalize() has been called),
    // then repair the WAV header if it was left with size=0 (can happen if the process
    // was interrupted before finalize completed).
    if let Some(join) = mixer_join {
        tokio::task::spawn_blocking(move || {
            let _ = join.join();
            if let Some(path) = wav_path {
                repair_wav_header(&path);
            }
        });
    }

    Ok(meeting_id)
}

/// Patch RIFF/data chunk sizes in a WAV file whose header was left at 0.
/// hound writes audio data but needs to seek back to update sizes on finalize().
/// If finalize was skipped, we compute sizes from the actual file length.
fn repair_wav_header(path: &std::path::Path) {
    use std::io::{Read, Seek, SeekFrom, Write};

    let Ok(mut f) = std::fs::OpenOptions::new().read(true).write(true).open(path) else {
        return;
    };
    let Ok(meta) = f.metadata() else { return };
    let file_len = meta.len() as u32;
    if file_len < 44 {
        return;
    }

    // Read current RIFF size field (bytes 4-7)
    let mut buf4 = [0u8; 4];
    if f.seek(SeekFrom::Start(4)).is_err() { return; }
    if f.read_exact(&mut buf4).is_err() { return; }
    let riff_size = u32::from_le_bytes(buf4);

    if riff_size > 0 {
        return; // already valid
    }

    // Repair: RIFF size = file_len - 8; data size = file_len - 44
    let new_riff_size = file_len.saturating_sub(8);
    let new_data_size = file_len.saturating_sub(44);

    if f.seek(SeekFrom::Start(4)).is_err() { return; }
    let _ = f.write_all(&new_riff_size.to_le_bytes());

    if f.seek(SeekFrom::Start(40)).is_err() { return; }
    let _ = f.write_all(&new_data_size.to_le_bytes());

    log::info!("repaired WAV header: riff={} data={}", new_riff_size, new_data_size);
}

/// Pause the current recording 
#[tauri::command]
pub fn pause_recording(
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut recording = state.recording.lock()
        .map_err(|_| "internal state error".to_string())?;

    if !recording.is_recording {
        return Err("not recording".to_string());
    }
    if recording.is_paused {
        return Err("already paused".to_string());
    }

    if let Some(flag) = &recording.pause_flag {
        flag.store(true, Ordering::Relaxed);
    }
    recording.is_paused = true;
    log::info!("recording paused");
    Ok(())
}

/// Resume the current recording 
#[tauri::command]
pub fn resume_recording(
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut recording = state.recording.lock()
        .map_err(|_| "internal state error".to_string())?;

    if !recording.is_recording {
        return Err("not recording".to_string());
    }
    if !recording.is_paused {
        return Err("not paused".to_string());
    }

    if let Some(flag) = &recording.pause_flag {
        flag.store(false, Ordering::Relaxed);
    }
    recording.is_paused = false;
    log::info!("recording resumed");
    Ok(())
}

/// Get the recording WAV file path for a meeting 
#[tauri::command]
pub fn get_recording_path(
    app: AppHandle,
    meeting_id: String,
) -> Result<Option<String>, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let wav_path = app_data_dir.join("recordings").join(format!("{}.wav", meeting_id));
    if wav_path.exists() {
        Ok(Some(wav_path.to_string_lossy().to_string()))
    } else {
        Ok(None)
    }
}

#[tauri::command]
pub async fn generate_meeting_notes(
    app: AppHandle,
    db: State<'_, Database>,
    meeting_id: String,
) -> Result<crate::ai::GeneratedNotes, String> {
    log::info!("generate_meeting_notes: starting for {}", meeting_id);

    let meeting = db.get_meeting(&meeting_id).map_err(|e| e.to_string())?
        .ok_or("meeting not found")?;

    let speaker_labels = db.list_speaker_labels().map_err(|e| e.to_string())?;
    let speaker_map: std::collections::HashMap<String, String> = speaker_labels
        .into_iter()
        .map(|l| (l.speaker_key, l.display_name))
        .collect();

    let transcript = db.get_transcript_by_meeting(&meeting_id).map_err(|e| e.to_string())?;
    let transcript_text = transcript
        .map(|t| {
            let segments: Vec<TranscriptSegment> = serde_json::from_str(&t.segments).unwrap_or_default();
            segments.iter().map(|s| {
                let speaker = s.speaker.as_deref()
                    .map(|key| speaker_map.get(key).map(String::as_str).unwrap_or(key))
                    .unwrap_or("Unknown");
                format!("{}: {}", speaker, s.text)
            }).collect::<Vec<_>>().join("\n")
        })
        .unwrap_or_default();
    log::info!("generate_meeting_notes: transcript length = {} chars", transcript_text.len());

    let note = db.get_note_by_meeting(&meeting_id).map_err(|e| e.to_string())?;
    let user_notes = note.as_ref().and_then(|n| n.raw_content.as_deref()).unwrap_or("");

    let template = db.get_default_template().map_err(|e| e.to_string())?
        .ok_or("no default template found")?;
    log::info!("generate_meeting_notes: using template '{}'", template.name);

    let user_context = db.get_setting("user_context").ok().flatten();
    let prompt = prompts::build_note_generation_prompt(&template, &meeting, &transcript_text, user_notes, user_context.as_deref());

    log::info!("generate_meeting_notes: calling Anthropic API...");

    let generated = ai::generate_notes(&db, &prompt).await.map_err(|e| {
        log::error!("generate_meeting_notes: AI failed: {}", e);
        e.to_string()
    })?;
    log::info!("generate_meeting_notes: AI returned successfully");

    let _ = app.emit("notes-generated", &meeting_id);

    Ok(generated)
}

#[tauri::command]
pub fn is_recording(state: State<'_, AppState>) -> bool {
    state.recording.lock().map(|r| r.is_recording).unwrap_or(false)
}

/// Check if recording is paused 
#[tauri::command]
pub fn is_paused(state: State<'_, AppState>) -> bool {
    state.recording.lock().map(|r| r.is_paused).unwrap_or(false)
}

/// Delete a single segment from a transcript by index.
#[tauri::command]
pub fn delete_transcript_segment(
    db: State<'_, Database>,
    meeting_id: String,
    segment_index: usize,
) -> Result<(), String> {
    let transcript = db.get_transcript_by_meeting(&meeting_id)
        .map_err(|e| e.to_string())?
        .ok_or("transcript not found")?;

    let mut segments: Vec<serde_json::Value> = serde_json::from_str(&transcript.segments)
        .map_err(|e| e.to_string())?;

    if segment_index >= segments.len() {
        return Err("segment index out of bounds".to_string());
    }

    segments.remove(segment_index);
    let segments_json = serde_json::to_string(&segments).map_err(|e| e.to_string())?;
    db.update_transcript_segments(&transcript.id, &segments_json)
        .map_err(|e| e.to_string())
}

/// Return the meeting ID currently being recorded, if any.
#[tauri::command]
pub fn get_recording_meeting_id(state: State<'_, AppState>) -> Option<String> {
    state.recording.lock().map(|r| r.meeting_id.clone()).unwrap_or(None)
}

/// True when the currently-selected AI provider is ready to use. The frontend
/// uses this to decide whether to enable Enhance/Chat affordances.
#[tauri::command]
pub fn check_ai_configured(db: State<'_, Database>) -> bool {
    ai::is_configured(&db)
}

/// True when the local Ollama server is reachable at localhost:11434.
/// Used by the Settings → AI panel to show a live status badge.
#[tauri::command]
pub async fn is_ollama_running() -> bool {
    tokio::task::spawn_blocking(ai::ollama::is_running_blocking).await.unwrap_or(false)
}

/// List installed Ollama models. Errors out (and surfaces in the UI) if
/// Ollama isn't running.
#[tauri::command]
pub async fn list_ollama_models() -> Result<Vec<String>, String> {
    ai::ollama::list_models().await.map_err(|e| e.to_string())
}

/// True when Apple Intelligence (FoundationModels) is available on the
/// current machine — i.e., macOS 26+ with Apple Intelligence enabled.
#[tauri::command]
pub fn is_apple_ai_available() -> bool {
    ai::apple_ai::is_available()
}

/// List models the user's Anthropic key has access to. Hit `GET /v1/models`
/// so we never have to maintain a hardcoded model list — when Anthropic
/// ships a new Claude, it appears here automatically.
#[tauri::command]
pub async fn list_anthropic_models() -> Result<Vec<ai::anthropic_api::ModelListing>, String> {
    let key = crate::secrets::get(crate::secrets::SecretKey::AnthropicApiKey)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "No Anthropic API key configured".to_string())?;
    ai::anthropic_api::list_models(&key).await.map_err(|e| e.to_string())
}

/// Top-N matching attendee names from across all meetings, ordered by
/// frequency then recency. Used by the @-mention autocomplete in the editor.
#[tauri::command]
pub fn list_mention_candidates(
    db: State<'_, Database>,
    prefix: String,
    limit: usize,
) -> Result<Vec<String>, String> {
    db.list_mention_candidates(&prefix, limit).map_err(|e| e.to_string())
}

/// Result for a single meeting re-transcription attempt.
#[derive(Debug, Clone, Serialize)]
pub struct RetranscribeResult {
    pub meeting_id: String,
    pub success: bool,
    pub error: Option<String>,
}

/// Batch re-transcribe existing recordings with the currently selected
/// whisper model. For each meeting ID, finds the WAV recording file and runs
/// whisper transcription, then updates the transcript segments in the database.
#[tauri::command]
pub async fn batch_retranscribe(
    app: AppHandle,
    db: State<'_, Database>,
    meeting_ids: Vec<String>,
) -> Result<Vec<RetranscribeResult>, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let recordings_dir = app_data_dir.join("recordings");

    // Resolve whisper binary
    let bundled_path = app_data_dir.join("sidecars").join("whisper-cli");
    let whisper_path = if bundled_path.exists() {
        Some(bundled_path)
    } else {
        ["/opt/homebrew/bin/whisper-cli", "/usr/local/bin/whisper-cli"]
            .iter()
            .map(std::path::PathBuf::from)
            .find(|p| p.exists())
            .or_else(|| which::which("whisper-cli").ok())
    };

    let whisper_path = whisper_path.ok_or(
        "whisper-cli not found. Install it: brew install whisper-cpp"
    )?;

    // Resolve model
    let preferred_model = db.get_setting("whisper_model")
        .ok()
        .flatten()
        .unwrap_or_else(|| "medium.en".to_string());
    let model_filename = format!("ggml-{}.bin", preferred_model);
    let model_candidates: Vec<std::path::PathBuf> = vec![
        app_data_dir.join("models").join(&model_filename),
        std::path::PathBuf::from(format!("/opt/homebrew/share/whisper-cpp/models/{}", model_filename)),
        std::path::PathBuf::from(format!("/usr/local/share/whisper-cpp/models/{}", model_filename)),
    ];
    let model_path = model_candidates.iter().find(|p| p.exists()).cloned()
        .ok_or("Whisper model not found. Download a model from Storage settings.")?;

    let language = db.get_setting("whisper_language").ok().flatten();
    let gpu_enabled = db.get_setting("gpu_acceleration")
        .ok().flatten().map(|v| v == "true").unwrap_or(false);

    let mut results = Vec::new();
    let mut join_set: tokio::task::JoinSet<RetranscribeResult> = tokio::task::JoinSet::new();

    for meeting_id in &meeting_ids {
        let meeting_id = meeting_id.clone();
        let wav_path = recordings_dir.join(format!("{}.wav", meeting_id));
        let whisper_path = whisper_path.clone();
        let model_path = model_path.clone();
        let language = language.clone();
        let app = app.clone();

        if !wav_path.exists() {
            results.push(RetranscribeResult {
                meeting_id: meeting_id.clone(),
                success: false,
                error: Some("Recording file not found".to_string()),
            });
            continue;
        }

        let gpu_enabled_clone = gpu_enabled;
        join_set.spawn(async move {
            let _ = app.emit("retranscribe-progress", serde_json::json!({
                "meeting_id": meeting_id,
                "status": "transcribing",
            }));

            let mut cmd = tokio::process::Command::new(&whisper_path);
            cmd.arg("--model").arg(&model_path);
            let lang = language.as_deref().unwrap_or("auto");
            cmd.arg("--language").arg(lang);
            cmd.arg("--no-prints")
                .arg("--output-json")
                .arg("--threads").arg("4")
                .arg("--flash-attn");
            if gpu_enabled_clone {
                cmd.arg("--gpu");
            }
            cmd.arg("--file").arg(&wav_path);

            match cmd.output().await {
                Ok(output) if output.status.success() => {
                    let stdout = String::from_utf8_lossy(&output.stdout);
                    let segments = parse_whisper_json_output(&stdout);
                    let segments_json = serde_json::to_string(&segments).unwrap_or_else(|_| "[]".to_string());
                    let db_ref = app.state::<Database>();
                    match db_ref.get_transcript_by_meeting(&meeting_id) {
                        Ok(Some(transcript)) => {
                            if let Err(e) = db_ref.update_transcript_segments(&transcript.id, &segments_json) {
                                return RetranscribeResult {
                                    meeting_id,
                                    success: false,
                                    error: Some(format!("Failed to update transcript: {}", e)),
                                };
                            }
                        }
                        _ => {
                            match db_ref.create_transcript(&meeting_id, "retranscribe") {
                                Ok(transcript) => {
                                    if let Err(e) = db_ref.update_transcript_segments(&transcript.id, &segments_json) {
                                        return RetranscribeResult {
                                            meeting_id,
                                            success: false,
                                            error: Some(format!("Failed to save transcript: {}", e)),
                                        };
                                    }
                                }
                                Err(e) => {
                                    return RetranscribeResult {
                                        meeting_id,
                                        success: false,
                                        error: Some(format!("Failed to create transcript: {}", e)),
                                    };
                                }
                            }
                        }
                    }
                    let _ = app.emit("retranscribe-progress", serde_json::json!({
                        "meeting_id": meeting_id,
                        "status": "complete",
                    }));
                    RetranscribeResult { meeting_id, success: true, error: None }
                }
                Ok(output) => {
                    let stderr = String::from_utf8_lossy(&output.stderr);
                    RetranscribeResult {
                        meeting_id,
                        success: false,
                        error: Some(format!("Whisper failed: {}", stderr)),
                    }
                }
                Err(e) => RetranscribeResult {
                    meeting_id,
                    success: false,
                    error: Some(format!("Failed to run whisper: {}", e)),
                },
            }
        });
    }

    // Collect results from parallel tasks
    while let Some(res) = join_set.join_next().await {
        if let Ok(r) = res {
            results.push(r);
        }
    }

    Ok(results)
}

/// Parse whisper-cli JSON output into TranscriptSegments.
/// Falls back to treating the entire output as a single text segment.
fn parse_whisper_json_output(output: &str) -> Vec<TranscriptSegment> {
    // Try to parse as JSON array of segments
    if let Ok(json) = serde_json::from_str::<serde_json::Value>(output) {
        // whisper-cli --output-json produces { "transcription": [ { "timestamps": {...}, "text": "..." } ] }
        if let Some(transcription) = json.get("transcription").and_then(|v| v.as_array()) {
            return transcription.iter().filter_map(|seg| {
                let text = seg.get("text")?.as_str()?.trim().to_string();
                if text.is_empty() {
                    return None;
                }
                let timestamps = seg.get("timestamps")?;
                let from_str = timestamps.get("from")?.as_str().unwrap_or("00:00:00");
                let to_str = timestamps.get("to")?.as_str().unwrap_or("00:00:00");
                let start_ms = parse_timestamp_ms(from_str);
                let end_ms = parse_timestamp_ms(to_str);
                Some(TranscriptSegment {
                    text,
                    start_ms,
                    end_ms,
                    speaker: None,
                    confidence: None,
                    words: None,
                    is_overlap: false,
                    speaker_confidence: 0.0,
                })
            }).collect();
        }
    }

    // Fallback: treat as plain text
    let text = output.trim().to_string();
    if text.is_empty() {
        return Vec::new();
    }
    vec![TranscriptSegment {
        text,
        start_ms: 0,
        end_ms: 0,
        speaker: None,
        confidence: None,
        words: None,
        is_overlap: false,
        speaker_confidence: 0.0,
    }]
}

/// Parse a timestamp string like "00:01:23.456" into milliseconds.
fn parse_timestamp_ms(ts: &str) -> u64 {
    let parts: Vec<&str> = ts.split(':').collect();
    if parts.len() == 3 {
        let hours: u64 = parts[0].parse().unwrap_or(0);
        let minutes: u64 = parts[1].parse().unwrap_or(0);
        let sec_parts: Vec<&str> = parts[2].split('.').collect();
        let seconds: u64 = sec_parts[0].parse().unwrap_or(0);
        let millis: u64 = if sec_parts.len() > 1 {
            let ms_str = sec_parts[1];
            // Pad or truncate to 3 digits
            let padded = format!("{:0<3}", &ms_str[..ms_str.len().min(3)]);
            padded.parse().unwrap_or(0)
        } else {
            0
        };
        hours * 3_600_000 + minutes * 60_000 + seconds * 1000 + millis
    } else {
        0
    }
}
