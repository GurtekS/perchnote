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

/// Whether the app can currently capture system audio (Screen Recording
/// permission granted). The UI uses this to show live status in Settings and
/// to decide whether starting a recording will silently miss system audio.
#[tauri::command]
pub fn check_system_audio_permission() -> bool {
    crate::audio::system::has_system_audio_permission()
}

/// Prompt for Screen Recording permission and return the resulting grant state.
/// A freshly granted permission only reaches the process tap after a restart,
/// so the UI should ask the user to relaunch before recording again.
#[tauri::command]
pub fn request_system_audio_permission() -> bool {
    crate::audio::system::request_system_audio_permission()
}

#[tauri::command]
pub async fn start_recording(
    app: AppHandle,
    state: State<'_, AppState>,
    db: State<'_, Database>,
    meeting_id: String,
    device_name: Option<String>,
    // Per-session override for system-audio capture. `None` falls back to the
    // persisted `capture_system_audio` setting; `Some(false)` lets the UI start
    // a deliberate mic-only session (e.g. after the user declines to grant the
    // Screen Recording permission) without changing their saved preference.
    system_audio: Option<bool>,
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
    let capture_system_audio = system_audio.unwrap_or_else(|| {
        db.get_setting("capture_system_audio")
            .ok().flatten().map(|v| v == "true").unwrap_or(true)
    });

    // A CoreAudio process tap created without Screen Recording permission
    // succeeds but emits only silence, so the recording would proceed while
    // silently dropping every participant's audio. Refuse to start instead,
    // with a machine-readable marker the frontend maps to a "grant permission
    // or record mic-only" dialog.
    if capture_system_audio && !crate::audio::system::has_system_audio_permission() {
        return Err("SYSTEM_AUDIO_PERMISSION_REQUIRED".to_string());
    }
    let stereo_recording = db.get_setting("stereo_recording")
        .ok().flatten().map(|v| v == "true").unwrap_or(false);
    // Echo cancellation (plan v9 #2) is experimental: default OFF until the
    // real-hardware QA matrix (speakers/AirPods/HFP) passes.
    let echo_cancellation = crate::audio::vpio::echo_cancellation_enabled(
        db.get_setting("echo_cancellation").ok().flatten(),
    );
    let noise_cancellation = db.get_setting("noise_cancellation")
        .ok().flatten().map(|v| v == "true").unwrap_or(true);
    let agc_enabled = db.get_setting("agc_enabled")
        .ok().flatten().map(|v| v == "true").unwrap_or(false);
    let noise_gate_threshold = db.get_setting("noise_gate_threshold")
        .ok().flatten().and_then(|v| v.parse::<f32>().ok()).unwrap_or(0.003);

    // Start mic capture (runs on its own thread). With echo cancellation on
    // (plan v9 #2) and no specific mic selected, the source is Apple's
    // voice-processing I/O unit (AEC against the system's speaker output);
    // a VPIO init failure degrades to plain cpal capture — AEC is never the
    // reason a recording fails to start. Same MicCaptureStart contract
    // either way, so the mixer/supervisor pipeline below is unchanged.
    let use_vpio =
        crate::audio::vpio::should_use_vpio(echo_cancellation, device_name.as_deref());
    if echo_cancellation && !use_vpio {
        log::info!(
            "echo_cancellation is on but a specific mic is selected ({:?}) — using standard capture",
            device_name
        );
    }
    log::info!(
        "starting mic capture (device: {:?}, stereo: {}, aec: {})",
        device_name, stereo_recording, use_vpio
    );
    let (mic, vpio_active) = crate::audio::vpio::choose_capture(
        use_vpio,
        crate::audio::vpio::start_vpio_capture,
        || start_mic_capture(device_name.as_deref()),
    )
    .map_err(|e| {
        log::error!("mic capture failed: {}", e);
        format!("Microphone error: {}. Check System Settings > Privacy > Microphone.", e)
    })?;
    if use_vpio && !vpio_active {
        let _ = app.emit(
            "recording-warning",
            "Echo cancellation couldn't start — recording with standard mic capture.",
        );
    }
    // Flag split (design §1c): the SESSION flag drives the mixer loop and
    // level monitor; the mic stream's own flag only controls that one cpal
    // stream — so a future supervisor can kill/rebuild streams without
    // ending the session.
    let stop_flag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true));
    let mic_stream_stop = mic.stop_flag;
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
    // Duration already on disk — the mixer APPENDS to an existing file
    // (mic switch, re-record), so this anchors the new session's
    // transcript offset to the audio's real end. Read before the mixer
    // opens the file: the header still holds the previous finalize.
    let existing_wav_ms = wav_duration_ms(&wav_path);

    // Disk-space guard — a 2h recording is ~350MB and hound write errors
    // mid-stream would otherwise surface as a corrupt file at stop time.
    if let Some(free) = free_disk_bytes(&recordings_dir) {
        const MIN_BYTES: u64 = 200 * 1024 * 1024;
        const WARN_BYTES: u64 = 1024 * 1024 * 1024;
        if free < MIN_BYTES {
            return Err(format!(
                "Not enough disk space to record ({} MB free). Free up space and try again.",
                free / (1024 * 1024)
            ));
        }
        if free < WARN_BYTES {
            let _ = app.emit(
                "recording-warning",
                format!(
                    "Low disk space: {} MB free. Long recordings may fail.",
                    free / (1024 * 1024)
                ),
            );
        }
    }

    // Create pause flag for pause/resume
    let pause_flag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));

    // Hot-swap mailboxes (the capture-supervisor design §1): the capture
    // supervisors post rebuilt sources here; the mixer applies them
    // mid-loop. Nothing posts yet — behavior-neutral plumbing for
    // robustness items 11-12.
    let mic_swap = crate::audio::swap::SourceSwap::new();
    let sys_swap = crate::audio::swap::SourceSwap::new();

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
        mic_swap.clone(),
        sys_swap.clone(),
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
    let mixer_alive = mixer.alive_flag();
    let system_audio_active = sys_rate.is_some();
    // Tray clock base: a mic-switch restart spawns a NEW monitor task, but
    // the meeting kept its original start — derive elapsed from it so the
    // menu bar doesn't reset to 0:00 mid-meeting (QA audit finding 9).
    let elapsed_base_secs: u64 = db
        .get_meeting(&meeting_id)
        .ok()
        .flatten()
        .and_then(|m| m.actual_start)
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(&s).ok())
        .map(|t| (chrono::Utc::now() - t.with_timezone(&chrono::Utc)).num_seconds().max(0) as u64)
        .unwrap_or(0);
    let supervisor_pause = pause_flag.clone();
    tokio::spawn(async move {
        use crate::audio::supervise::{MicHealth, MicObs, MicPolicy, SysHealth, SysObs, SysTapPolicy};

        let mut interval = tokio::time::interval(std::time::Duration::from_millis(100));
        let mut ticks: u64 = 0;
        let mut mixer_died = false;

        // Capture supervisors (robustness 11-12): the tested policy structs
        // decide; this loop only observes atomics and executes rebuilds.
        let mut mic_policy = MicPolicy::new();
        let mut sys_policy = SysTapPolicy::new();
        let mut last_health: Option<(MicHealth, SysHealth, bool)> = None;
        let mut permission_ok = true; // refreshed every ~30s below
        let mut call_app_active = false;
        // Rebuild tasks report back without blocking the 100ms cadence.
        enum RebuildDone {
            Mic { ok: bool, label: Option<String> },
            Sys { ok: bool },
        }
        let (rb_tx, mut rb_rx) = mpsc::unbounded_channel::<RebuildDone>();

        let emit_health = |mic: MicHealth, sys: SysHealth, mixer_dead: bool| {
            let _ = level_app.emit(
                "capture-health",
                serde_json::json!({
                    "mic": mic.as_str(),
                    "system": if system_audio_active { sys.as_str() } else { "ok" },
                    "mixer": if mixer_dead { "dead" } else { "ok" },
                }),
            );
        };

        let mut last_wall = std::time::SystemTime::now();
        loop {
            interval.tick().await;
            ticks += 1;
            let now_ms = ticks * 100;
            if !level_stop.load(Ordering::Relaxed) {
                break;
            }
            let paused = supervisor_pause.load(Ordering::Relaxed);

            // Sleep/wake detection (robustness 13): the tick interval stalls
            // while the Mac sleeps, so a wall-clock jump between ticks means
            // we just woke. Captures are commonly dead after wake (BT
            // re-enumeration; taps need rebuild) — the stall detectors and
            // budgets handle the rebuilds; this makes the gap visible.
            let now_wall = std::time::SystemTime::now();
            if let Ok(delta) = now_wall.duration_since(last_wall) {
                if delta.as_secs() >= 5 {
                    log::warn!(
                        "clock jump of {}s (sleep/wake) during recording — supervisors re-arming",
                        delta.as_secs()
                    );
                    let _ = level_app.emit(
                        "recording-warning",
                        format!(
                            "Your Mac slept for {} during the recording — capture is re-arming. \
                             The gap is silence in the timeline.",
                            format_gap(delta.as_secs()),
                        ),
                    );
                }
            }
            last_wall = now_wall;

            // Slow polls (~30s): TCC permission + is a call app on the mic.
            if ticks % 300 == 1 && system_audio_active {
                permission_ok = crate::audio::system::has_system_audio_permission();
                call_app_active = crate::audio::system::mic_active_bundle_ids()
                    .iter()
                    .filter(|b| !b.starts_with("com.perchnote"))
                    .any(|b| crate::audio::calldetect::call_app_name(b).is_some());
            }

            // Rebuild completions (non-blocking drain).
            while let Ok(done) = rb_rx.try_recv() {
                match done {
                    RebuildDone::Mic { ok, label } => {
                        mic_policy.rebuild_finished(ok);
                        if ok {
                            if let Some(l) = label {
                                let _ = level_app.emit(
                                    "recording-warning",
                                    format!("Mic went silent — switched to “{l}”."),
                                );
                            }
                        }
                    }
                    RebuildDone::Sys { ok } => {
                        sys_policy.rebuild_finished(ok);
                        if ok {
                            let _ = level_app
                                .emit("recording-warning", "System audio re-established.");
                        }
                    }
                }
            }

            // Watchdog: mixer thread died (error or panic) while the
            // recording is still supposedly active.
            if !mixer_alive.load(Ordering::Relaxed) {
                emit_health(MicHealth::Ok, SysHealth::Ok, true);
                let _ = level_app.emit(
                    "recording-warning",
                    "Audio capture stopped unexpectedly — stop and restart the recording. \
                     Audio up to this point is saved.",
                );
                mixer_died = true;
                break;
            }

            // ── Mic policy ──
            let mic_obs = MicObs {
                stall_ms: crate::audio::MIC_STALL_MS.load(Ordering::Relaxed),
                stream_error: crate::audio::MIC_STREAM_ERROR.load(Ordering::Relaxed),
                paused,
            };
            let (mic_health, launch_mic) = mic_policy.tick(now_ms, &mic_obs);
            if launch_mic {
                mic_policy.rebuild_started();
                let app2 = level_app.clone();
                let tx = rb_tx.clone();
                let swap = mic_swap.clone();
                tokio::spawn(async move {
                    // Kill the current stream; its owning thread drops it.
                    {
                        let st = app2.state::<crate::AppState>();
                        let flag = st
                            .recording
                            .lock()
                            .ok()
                            .and_then(|mut r| r.mic_stream_stop.take());
                        if let Some(f) = flag {
                            f.store(false, Ordering::Relaxed);
                        }
                    }
                    // Build on the CURRENT default (macOS moves the default
                    // off dead BT devices; the configured one just died).
                    // The rebuild honors the session's capture choice frozen
                    // at start (plan v9 #2): an echo-cancelled session
                    // retries VPIO first and falls back to plain cpal,
                    // exactly like session start.
                    let built = tokio::time::timeout(
                        std::time::Duration::from_secs(5),
                        tokio::task::spawn_blocking(move || {
                            crate::audio::vpio::choose_capture(
                                use_vpio,
                                crate::audio::vpio::start_vpio_capture,
                                || crate::audio::mic::start_mic_capture(None),
                            )
                            .map(|(m, _)| m)
                        }),
                    )
                    .await;
                    let started = match built {
                        Ok(Ok(Ok(m))) => Some(m),
                        _ => None,
                    };
                    let Some(m) = started else {
                        let _ = tx.send(RebuildDone::Mic { ok: false, label: None });
                        return;
                    };
                    crate::audio::MIC_STREAM_ERROR.store(false, Ordering::Relaxed);
                    let label = m.device_name.clone();
                    let st = app2.state::<crate::AppState>();
                    let installed = st
                        .recording
                        .lock()
                        .ok()
                        .map(|mut r| {
                            if r.is_recording {
                                r.mic_stream_stop = Some(m.stop_flag.clone());
                                true
                            } else {
                                // stop_recording won the race — kill the fresh stream
                                m.stop_flag.store(false, Ordering::Relaxed);
                                false
                            }
                        })
                        .unwrap_or(false);
                    if installed {
                        swap.post(crate::audio::swap::SwapPayload {
                            consumer: m.consumer,
                            sample_rate: m.sample_rate,
                            label: label.clone(),
                        });
                        let _ = app2.emit("audio-device-active", &label);
                        let _ = tx.send(RebuildDone::Mic { ok: true, label: Some(label) });
                    } else {
                        let _ = tx.send(RebuildDone::Mic { ok: false, label: None });
                    }
                });
            }

            // ── System-tap policy (only when system capture is on) ──
            let mut sys_health = SysHealth::Ok;
            if system_audio_active {
                let sys_obs = SysObs {
                    stall_ms: crate::audio::SYS_STALL_MS.load(Ordering::Relaxed),
                    zero_run_ms: crate::audio::SYS_ZERO_RUN_MS.load(Ordering::Relaxed),
                    voice_ago_ms: crate::audio::MIC_LAST_VOICE_AGO_MS.load(Ordering::Relaxed),
                    call_app_active,
                    permission: permission_ok,
                    paused,
                };
                let (h, launch_sys) = sys_policy.tick(now_ms, &sys_obs);
                sys_health = h;
                if launch_sys {
                    sys_policy.rebuild_started();
                    let app2 = level_app.clone();
                    let tx = rb_tx.clone();
                    let swap = sys_swap.clone();
                    tokio::spawn(async move {
                        let rebuilt = tokio::time::timeout(
                            std::time::Duration::from_secs(8),
                            tokio::task::spawn_blocking(move || {
                                let st = app2.state::<crate::AppState>();
                                let old = st
                                    .recording
                                    .lock()
                                    .ok()
                                    .and_then(|mut r| r.system_audio_capture.take())?;
                                let (cap, consumer, rate) =
                                    crate::audio::system::SystemAudioCapture::restart(old).ok()?;
                                let mut r = st.recording.lock().ok()?;
                                if !r.is_recording {
                                    return None; // stop raced — drop the fresh tap
                                }
                                r.system_audio_capture = Some(cap);
                                Some((consumer, rate))
                            }),
                        )
                        .await;
                        match rebuilt {
                            Ok(Ok(Some((consumer, rate)))) => {
                                swap.post(crate::audio::swap::SwapPayload {
                                    consumer,
                                    sample_rate: rate,
                                    label: "system tap".into(),
                                });
                                let _ = tx.send(RebuildDone::Sys { ok: true });
                            }
                            _ => {
                                let _ = tx.send(RebuildDone::Sys { ok: false });
                            }
                        }
                    });
                }
            }

            // Health transitions, both directions; warnings fire on degrade.
            let triple = (mic_health, sys_health, false);
            if last_health != Some(triple) {
                let prev = last_health;
                last_health = Some(triple);
                emit_health(mic_health, sys_health, false);
                let prev_mic = prev.map(|p| p.0);
                if mic_health == MicHealth::Stalled && prev_mic != Some(MicHealth::Stalled) {
                    let _ = level_app.emit(
                        "recording-warning",
                        "Your microphone went silent — check the input device. \
                         Other participants' audio is still being captured.",
                    );
                }
                let prev_sys = prev.map(|p| p.1);
                if sys_health == SysHealth::PermissionLost
                    && prev_sys != Some(SysHealth::PermissionLost)
                {
                    let _ = level_app.emit(
                        "recording-warning",
                        "Screen Recording permission was revoked — other participants' audio \
                         is no longer being captured.",
                    );
                }
                if sys_health == SysHealth::Silent && prev_sys != Some(SysHealth::Silent) {
                    let _ = level_app.emit(
                        "recording-warning",
                        "System audio has gone flat during an active call — attempting recovery.",
                    );
                }
            }

            // Live menu-bar presence: elapsed recording time in the tray
            // title (updated once a second), visible behind fullscreen apps.
            // A degraded capture shows ⚠ so the glance-state is honest.
            if ticks % 10 == 0 {
                if let Some(tray) = level_app.tray_by_id("main-tray") {
                    let secs = elapsed_base_secs + ticks / 10;
                    let unhealthy =
                        mic_health != MicHealth::Ok || sys_health != SysHealth::Ok;
                    let badge = if unhealthy { "\u{26A0} " } else { "" };
                    let _ = tray.set_title(Some(format!("{badge}\u{23FA} {}:{:02}", secs / 60, secs % 60)));
                }
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
        // Recording over: clear the menu-bar timer. A DEAD mixer is not
        // "over" — the app still shows an active recording, so the tray
        // says so instead of silently going blank (QA audit finding 9).
        if let Some(tray) = level_app.tray_by_id("main-tray") {
            if mixer_died {
                let _ = tray.set_title(Some("\u{26A0} stopped"));
            } else {
                let _ = tray.set_title(None::<&str>);
            }
        }
    });

    // Set up transcript segment channel
    let (segment_tx, mut segment_rx) = mpsc::channel::<TranscriptSegment>(100);

    // Reuse existing transcript if present (append), otherwise create a new one.
    // Time offset comes from the WAV's REAL duration — the mixer appends to
    // the existing file now, so transcript anchors and audio agree exactly.
    // (The old `last_end_ms + 1000` guess drifted from the audio by however
    // long the final silence ran.) Falls back to the guess if the file is
    // unreadable.
    let (transcript_id, time_offset) = match db.get_transcript_by_meeting(&meeting_id).ok().flatten() {
        Some(existing) => {
            let last_end_ms: u64 = serde_json::from_str::<Vec<serde_json::Value>>(&existing.segments)
                .ok()
                .and_then(|segs| segs.last().cloned())
                .and_then(|seg| seg.get("end_ms").and_then(|v| v.as_u64()))
                .unwrap_or(0);
            let offset = existing_wav_ms.unwrap_or_else(|| last_end_ms.saturating_add(1000));
            (existing.id, offset)
        }
        None => {
            let transcript = db
                .create_transcript(&meeting_id, "local_whisper")
                .map_err(|e| e.to_string())?;
            // Transcript gone but audio survives (e.g. it was cleared):
            // new segments must still land past the appended audio.
            (transcript.id, existing_wav_ms.unwrap_or(0))
        }
    };

    // Forward segments to frontend and save to DB
    let app_for_segments = app.clone();
    let meeting_id_for_segments = meeting_id.clone();
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
            // Live highlights (plan v3 rank 6): a ⌘D pressed before this
            // segment existed lands here when its moment arrives.
            let mut stored = stored;
            if let Ok(mut pending) = app_for_segments.state::<AppState>().pending_highlights.lock() {
                if pending.iter().any(|ms| *ms >= stored.start_ms && *ms <= stored.end_ms) {
                    stored.highlighted = true;
                    pending.retain(|ms| !(*ms >= stored.start_ms && *ms <= stored.end_ms));
                }
            }
            let segment_json = serde_json::to_string(&stored).unwrap_or_default();
            let _ = db_ref.append_transcript_segment(&transcript_id, &segment_json);
            let _ = app_for_segments.emit("transcript-segment", &stored);
        }
        // The sender chain (mixer → whisper worker) is dropped only after
        // the post-stop drain finishes, so reaching here means the final
        // transcript is persisted: the meeting is complete NOW — not at
        // the next launch's crash reconciler, which until this line was
        // the ONLY writer of "complete" (friction audit #1: instant recap
        // never fired in-session; insights/week-review/Ask AI all skipped
        // fresh meetings). Guard on "transcribing" so a stop+start mic
        // switch whose new session already set "recording" is left alone —
        // and SETTLE first (QA audit finding 2): the drain can end inside
        // the switch's stop→start gap, before the new session writes
        // "recording"; finalizing then would fire auto-enhance mid-meeting
        // and let the restart re-stamp actual_start.
        tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
        let still_transcribing = db_ref
            .get_meeting(&meeting_id_for_segments)
            .ok()
            .flatten()
            .map(|m| m.status == "transcribing")
            .unwrap_or(false);
        if still_transcribing {
            if let Err(e) = db_ref.update_meeting_status(&meeting_id_for_segments, "complete") {
                log::error!("post-drain completion failed: {e}");
            } else {
                let _ = app_for_segments.emit("meeting-completed", serde_json::json!({
                    "meeting_id": meeting_id_for_segments,
                }));
                crate::commands::meetings::run_completion_side_effects(
                    app_for_segments.clone(),
                    meeting_id_for_segments.clone(),
                );
                // Accuracy pass (plan v10 #3): live transcription is chunked
                // greedy decode; the permanent record deserves the whole-file
                // full-context pass imports already get. Runs AFTER the side
                // effects on purpose — instant recap stays instant on the
                // live text, the record upgrades underneath (the enhance-
                // receipts item will badge that staleness when it lands).
                spawn_accuracy_pass(&app_for_segments, meeting_id_for_segments.clone());
            }
        }
    });

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
        correction_rules: crate::transcription::corrections::parse_rules(
            db.get_setting("correction_rules").ok().flatten().as_deref(),
        ),
        noise_cancellation,
        noise_gate_threshold,
    };

    match model_path {
        Some(mp) => {
            let segment_tx_clone = segment_tx.clone();
            let app_for_status = app.clone();
            let gpu = whisper_config.gpu_enabled;
            let _ = app.emit("transcription-status", "starting");
            tokio::spawn(async move {
                // Model load is heavy (reads the full ggml file) — blocking
                // thread, once per recording. No sidecar binary involved
                // anymore: whisper runs in-process with embedded Metal.
                let mp_display = mp.display().to_string();
                let engine = tokio::task::spawn_blocking(move || {
                    crate::transcription::engine::WhisperEngine::load(&mp, gpu)
                })
                .await;
                let engine = match engine {
                    Ok(Ok(e)) => e,
                    Ok(Err(e)) => {
                        let msg = format!("Whisper failed to start: {}", e);
                        log::error!("{}", msg);
                        let _ = app_for_status.emit("transcription-status", &msg);
                        return;
                    }
                    Err(e) => {
                        log::error!("whisper engine load task failed: {}", e);
                        let _ = app_for_status.emit("transcription-status", "Whisper failed to start");
                        return;
                    }
                };
                log::info!("whisper engine loaded from {}", mp_display);
                match WhisperSidecar::start(engine, audio_rx, segment_tx_clone, whisper_config).await {
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
        }
        None => {
            let msg = "Whisper model not found. Download one in Settings → Audio → Whisper model.";
            log::warn!("{}", msg);
            let _ = app.emit("transcription-status", msg);
            drop(audio_rx);
        }
    }

    // Update meeting status and recording device info
    if let Ok(mut pending) = state.pending_highlights.lock() {
        pending.clear();
    }
    crate::audio::TALK_MIC_MS.store(0, Ordering::Relaxed);
    crate::audio::TALK_SYS_MS.store(0, Ordering::Relaxed);
    crate::audio::TALK_LONGEST_MONO_MS.store(0, Ordering::Relaxed);
    // Supervisor observations start each session clean (design §1b; also
    // QA finding 5 — a stale MIC_STALL_MS could outlive the prior session).
    crate::audio::MIC_STALL_MS.store(0, Ordering::Relaxed);
    crate::audio::SYS_STALL_MS.store(0, Ordering::Relaxed);
    crate::audio::SYS_ZERO_RUN_MS.store(0, Ordering::Relaxed);
    crate::audio::MIC_LAST_VOICE_AGO_MS.store(600_000, Ordering::Relaxed);
    crate::audio::MIC_STREAM_ERROR.store(false, Ordering::Relaxed);
    // A stop+start mic switch arrives while the previous session is still
    // draining ("transcribing") — or, if the drain won the race, just after
    // it completed (status "complete" with an actual_end seconds ago).
    // Either way: same meeting, same timeline — keep the original start so
    // the header clock and anchors stay one continuous meeting. Fresh
    // recordings and day-later re-records stamp a new start as before.
    let continuing_session = existing_wav_ms.is_some()
        && db
            .get_meeting(&meeting_id)
            .ok()
            .flatten()
            .map(|m| {
                m.status == "transcribing"
                    || (m.status == "complete"
                        && m.actual_end
                            .as_deref()
                            .and_then(|e| chrono::DateTime::parse_from_rfc3339(e).ok())
                            .map(|e| {
                                (chrono::Utc::now() - e.with_timezone(&chrono::Utc))
                                    .num_seconds()
                                    < 15
                            })
                            .unwrap_or(false))
            })
            .unwrap_or(false);
    let _ = db.update_meeting_status(&meeting_id, "recording");
    if !continuing_session {
        let _ = db.update_meeting_times(&meeting_id, Some(&chrono::Utc::now().to_rfc3339()), None);
    }
    let _ = db.update_meeting_device(&meeting_id, device_name.as_deref(), sys_rate.is_some());

    recording.is_recording = true;
    recording.meeting_id = Some(meeting_id);
    recording.stop_flag = Some(stop_flag);
    recording.mic_stream_stop = Some(mic_stream_stop);
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
    app: AppHandle,
    state: State<'_, AppState>,
    db: State<'_, Database>,
) -> Result<String, String> {
    let mut recording = state.recording.lock()
        .map_err(|_| "internal state error".to_string())?;

    if !recording.is_recording {
        return Err("not recording".to_string());
    }

    let meeting_id = recording
        .meeting_id
        .clone()
        .ok_or("no meeting id")?;

    // Status FIRST, before the segment channel drops (QA audit finding 1):
    // when whisper never started, the forwarding task wakes the instant the
    // last sender goes away — if it reads "recording" it skips completion
    // forever and the meeting stays stuck until the next launch's reconciler.
    let _ = db.update_meeting_status(&meeting_id, "transcribing");
    let _ = db.update_meeting_times(
        &meeting_id,
        None,
        Some(&chrono::Utc::now().to_rfc3339()),
    );

    if let Some(flag) = recording.stop_flag.take() {
        flag.store(false, Ordering::Relaxed);
    }
    // The mic stream has its own kill flag since the §1c split.
    if let Some(flag) = recording.mic_stream_stop.take() {
        flag.store(false, Ordering::Relaxed);
    }
    recording.segment_tx.take();
    recording.pause_flag.take();
    recording.system_audio_capture.take();
    recording.meeting_id.take();

    let wav_path = recording.wav_path.clone();
    let mixer_join = recording.mixer_join.take();

    recording.is_recording = false;
    recording.is_paused = false;

    // Wait for mixer thread to finish (ensures wav_writer.finalize() has been called),
    // then repair the WAV header if it was left with size=0 (can happen if the process
    // was interrupted before finalize completed).
    let app_for_stats = app.clone();
    let meeting_for_stats = meeting_id.clone();
    if let Some(join) = mixer_join {
        tokio::task::spawn_blocking(move || {
            let _ = join.join();
            // Snapshot the counters BEFORE any new session resets them —
            // a mic switch restarts within milliseconds of this join.
            let mic_ms = crate::audio::TALK_MIC_MS.load(Ordering::Relaxed);
            let sys_ms = crate::audio::TALK_SYS_MS.load(Ordering::Relaxed);
            let mono_ms = crate::audio::TALK_LONGEST_MONO_MS.load(Ordering::Relaxed);
            // A mic switch is stop+start: the new session may already own this
            // path (appending). Rewriting the header — or discarding the
            // meeting — from under an active writer would corrupt the
            // continuing recording, so both are skipped while it's owned.
            let owned_by_new_session = wav_path
                .as_ref()
                .map(|path| {
                    app_for_stats
                        .state::<AppState>()
                        .recording
                        .lock()
                        .map(|r| r.is_recording && r.wav_path.as_deref() == Some(path.as_path()))
                        .unwrap_or(false)
                })
                .unwrap_or(false);
            if let Some(path) = wav_path.as_ref() {
                if !owned_by_new_session {
                    repair_wav_header(path);
                }
            }
            // Talk balance (plan v3 rank 8): MERGE this session into any
            // previously persisted stats — a mic switch records one
            // meeting as two mixer sessions, and overwriting kept only
            // the final leg.
            if mic_ms + sys_ms > 0 {
                let db = app_for_stats.state::<Database>();
                if let Err(e) = db.merge_talk_stats(&meeting_for_stats, mic_ms, sys_ms, mono_ms) {
                    log::warn!("talk stats persist failed: {e}");
                }
            }
            // Don't leave an empty turd behind: a recording that captured no
            // audio and holds no transcript or notes is discarded (never
            // during a mic switch — the new session continues this meeting).
            // Runs after the WAV is finalized above so the duration read is
            // accurate; the post-drain completion task guards on the meeting
            // still existing, so deleting here simply makes it a no-op.
            if !owned_by_new_session {
                let db = app_for_stats.state::<Database>();
                crate::commands::meetings::discard_if_empty_recording(
                    &app_for_stats,
                    &db,
                    &meeting_for_stats,
                    wav_path.as_deref(),
                );
            }
        });
    }

    Ok(meeting_id)
}

/// Human duration for the sleep-gap banner ("2m 13s", "1h 4m").
fn format_gap(secs: u64) -> String {
    if secs >= 3600 {
        format!("{}h {}m", secs / 3600, (secs % 3600) / 60)
    } else if secs >= 60 {
        format!("{}m {}s", secs / 60, secs % 60)
    } else {
        format!("{secs}s")
    }
}

/// Milliseconds of audio already in the meeting's WAV, or None when the
/// file is missing/unreadable. Anchors a continuing session's transcript
/// offset to where the appended audio actually resumes.
pub(crate) fn wav_duration_ms(path: &std::path::Path) -> Option<u64> {
    let reader = hound::WavReader::open(path).ok()?;
    let spec = reader.spec();
    if spec.sample_rate == 0 {
        return None;
    }
    Some(reader.duration() as u64 * 1000 / spec.sample_rate as u64)
}

/// Patch RIFF/data chunk sizes in a WAV file whose header was left at 0.
/// hound writes audio data but needs to seek back to update sizes on finalize().
/// If finalize was skipped, we compute sizes from the actual file length.
/// Deterministic action-item cleanup (plan v5): models still slip vague
/// assignees, implausible deadlines, and re-discussed duplicates past the
/// prompt rules — these are free to fix in code.
fn sanitize_action_items(
    items: &mut Vec<ai::anthropic_api::ActionItem>,
    meeting_start: Option<&str>,
    known_names: &str,
) {
    let meeting_date = meeting_start
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|t| t.date_naive())
        .unwrap_or_else(|| chrono::Utc::now().date_naive());
    let known_lower = known_names.to_lowercase();

    for item in items.iter_mut() {
        // "Unassigned"/"unknown"/"team" placeholders are noise, not owners.
        if let Some(a) = item.assignee.as_deref() {
            let norm = a.trim().to_lowercase();
            if norm.is_empty() || ["unassigned", "unknown", "n/a", "tbd", "team", "everyone"].contains(&norm.as_str()) {
                item.assignee = None;
            }
        }
        // An owner must be someone the MEETING knows: their name appears in
        // the transcript, the speaker labels, or the attendee list. The
        // model's prompt also carries user context and notes — fertile
        // ground for a name from a different life entirely. First-name
        // check ("Dana Patel" → "dana") so a surname the transcript never
        // spoke doesn't disqualify a real owner. "Me"/"I" always pass —
        // they denote the user, who is in every meeting by definition.
        if let Some(a) = item.assignee.as_deref() {
            let norm = a.trim().to_lowercase();
            let first = norm.split_whitespace().next().unwrap_or("");
            let is_self = ["me", "i", "myself"].contains(&norm.as_str());
            if !is_self && (first.is_empty() || !contains_word(&known_lower, first)) {
                log::info!("dropping ungrounded assignee {:?} on \"{}\"", a, item.task);
                item.assignee = None;
            }
        }
        // Deadlines must parse AND be plausible: on/after the meeting date,
        // within a year. Anything else is a hallucinated or mangled date.
        if let Some(d) = item.deadline.as_deref() {
            let parsed = chrono::NaiveDate::parse_from_str(d.get(..10).unwrap_or(""), "%Y-%m-%d").ok();
            let plausible = parsed.map(|p| {
                p >= meeting_date && p <= meeting_date + chrono::Duration::days(366)
            });
            if plausible != Some(true) {
                log::info!("dropping implausible deadline {:?} on \"{}\"", d, item.task);
                item.deadline = None;
            }
        }
    }

    // Near-duplicate collapse: same commitment re-discussed later in the
    // meeting must not become two tasks. First occurrence wins (it carries
    // the earliest anchor).
    let mut seen: std::collections::HashSet<String> = Default::default();
    items.retain(|i| {
        let key: String = i
            .task
            .to_lowercase()
            .chars()
            .filter(|c| c.is_alphanumeric() || c.is_whitespace())
            .collect::<String>()
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        seen.insert(key)
    });
}

/// Word-boundary containment, ASCII-CI haystack already lowercased: "ed"
/// must match the spoken name "Ed", never the inside of "edit" (QA audit
/// P3 — substring matching made short names pass on unrelated words).
fn contains_word(haystack_lower: &str, needle_lower: &str) -> bool {
    if needle_lower.is_empty() {
        return false;
    }
    let mut start = 0;
    while let Some(pos) = haystack_lower[start..].find(needle_lower) {
        let abs = start + pos;
        let before_ok = haystack_lower[..abs]
            .chars()
            .next_back()
            .is_none_or(|c| !c.is_alphanumeric());
        let after_ok = haystack_lower[abs + needle_lower.len()..]
            .chars()
            .next()
            .is_none_or(|c| !c.is_alphanumeric());
        if before_ok && after_ok {
            return true;
        }
        start = abs + needle_lower.len().max(1);
    }
    false
}

/// Cheap grounding check for a cited claim: every-day words prove nothing,
/// but the claim's capitalized terms and numbers (names, dates, products)
/// should appear near the cited transcript text. All-lowercase claims pass
/// (nothing checkable); otherwise require ≥30% overlap and at least one hit.
fn claim_is_grounded(claim: &str, cited_text: &str) -> bool {
    let terms = checkable_terms(claim);
    if terms.is_empty() {
        return true;
    }
    let cited = term_set(cited_text);
    grounding_ratio(&terms, std::slice::from_ref(&cited)) >= GROUNDING_MIN_RATIO
}

const GROUNDING_MIN_RATIO: f64 = 0.3;

/// The claim's checkable terms — capitalized words and numbers, skipping the
/// leading word (action items start with a capitalized imperative like
/// "Send" that proves nothing), normalized to lowercase.
fn checkable_terms(claim: &str) -> Vec<String> {
    fn checkable(w: &str) -> bool {
        let t = w.trim_matches(|c: char| !c.is_alphanumeric());
        !t.is_empty()
            && (t.chars().next().map(|c| c.is_uppercase()).unwrap_or(false)
                || t.chars().all(|c| c.is_ascii_digit() || c == '%'))
    }
    claim
        .split_whitespace()
        .enumerate()
        .filter(|(i, w)| *i > 0 && checkable(w))
        .map(|(_, w)| norm_word(w))
        .collect()
}

fn norm_word(w: &str) -> String {
    w.trim_matches(|c: char| !c.is_alphanumeric()).to_lowercase()
}

fn term_set(text: &str) -> std::collections::HashSet<String> {
    text.split_whitespace().map(norm_word).collect()
}

/// Fraction of claim terms found in any of the given segment term-sets.
fn grounding_ratio(terms: &[String], sets: &[std::collections::HashSet<String>]) -> f64 {
    if terms.is_empty() {
        return 0.0;
    }
    let hits = terms
        .iter()
        .filter(|t| sets.iter().any(|s| s.contains(*t)))
        .count();
    hits as f64 / terms.len() as f64
}

/// Validate and repair action-item source refs against the transcript
/// (plan ranks 2+10+v2-9). A ref must land inside the recording and its
/// claim must be grounded in the cited ±1-segment window. Instead of just
/// stripping failures, broken or MISSING refs are re-anchored to the
/// best-grounded segment — which is what gives Apple Intelligence (whose
/// guided generation rarely emits offsets) chip parity with Anthropic.
/// Claims grounded nowhere lose their chip.
fn anchor_action_items(
    items: &mut [ai::anthropic_api::ActionItem],
    segments: &[TranscriptSegment],
) {
    let max_ms = segments.last().map(|s| s.end_ms).unwrap_or(0);
    if segments.is_empty() || max_ms == 0 {
        for item in items.iter_mut() {
            item.source_start_ms = None;
        }
        return;
    }
    let seg_sets: Vec<std::collections::HashSet<String>> =
        segments.iter().map(|s| term_set(&s.text)).collect();
    let window = |i: usize| {
        let lo = i.saturating_sub(1);
        let hi = (i + 1).min(segments.len() - 1);
        &seg_sets[lo..=hi]
    };

    for item in items.iter_mut() {
        let terms = checkable_terms(&item.task);
        if terms.is_empty() {
            // Nothing checkable: keep an in-range ref, drop an impossible one.
            if item.source_start_ms.map_or(false, |ms| ms > max_ms) {
                item.source_start_ms = None;
            }
            continue;
        }

        let current_ok = item.source_start_ms.is_some_and(|ms| {
            ms <= max_ms
                && segments
                    .iter()
                    .position(|s| s.start_ms <= ms && ms <= s.end_ms)
                    .map_or(false, |i| {
                        grounding_ratio(&terms, window(i)) >= GROUNDING_MIN_RATIO
                    })
        });
        if current_ok {
            continue;
        }

        // Re-anchor: best-grounded segment anywhere in the transcript. The
        // ±1 window decides candidacy (same bar as validation), but ranking
        // favors the segment whose OWN text grounds the claim — windows blur
        // three neighbors into identical scores. Earliest wins ties.
        let mut best: Option<(f64, f64, u64)> = None;
        for (i, s) in segments.iter().enumerate() {
            let win = grounding_ratio(&terms, window(i));
            if win < GROUNDING_MIN_RATIO {
                continue;
            }
            let own = grounding_ratio(&terms, std::slice::from_ref(&seg_sets[i]));
            if best.map_or(true, |(bo, bw, _)| own > bo || (own == bo && win > bw)) {
                best = Some((own, win, s.start_ms));
            }
        }
        match (item.source_start_ms, best) {
            (was, Some((_, _, ms))) => {
                if was != Some(ms) {
                    log::info!(
                        "re-anchored action-item ref {:?} -> {}ms: {}",
                        was,
                        ms,
                        item.task
                    );
                }
                item.source_start_ms = Some(ms);
            }
            (Some(was), None) => {
                log::info!(
                    "stripping ungrounded action-item ref at {}ms: {}",
                    was,
                    item.task
                );
                item.source_start_ms = None;
            }
            (None, None) => {}
        }
    }
}

/// Free bytes on the volume containing `path`, via `df -Pk`. No extra crate
/// needed, and this runs once per recording start so the subprocess cost is
/// irrelevant. Returns None if `df` output can't be parsed.
fn free_disk_bytes(path: &std::path::Path) -> Option<u64> {
    let out = std::process::Command::new("/bin/df")
        .arg("-Pk")
        .arg(path)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let line = text.lines().nth(1)?;
    let avail_kb: u64 = line.split_whitespace().nth(3)?.parse().ok()?;
    Some(avail_kb * 1024)
}

pub(crate) fn repair_wav_header(path: &std::path::Path) {
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
    // Plain text of what the user typed (the editor extracts it) — the db
    // raw_content is TipTap JSON and may lag the editor by the autosave
    // debounce, so the caller's copy wins when provided.
    user_notes: Option<String>,
    // Real template selection (plan v2 rank 1) — None keeps the default.
    template_id: Option<String>,
) -> Result<crate::ai::GeneratedNotes, String> {
    log::info!("generate_meeting_notes: starting for {}", meeting_id);

    let meeting = db.get_meeting(&meeting_id).map_err(|e| e.to_string())?
        .ok_or("meeting not found")?;

    // THIS meeting's labels only. The global list keyed by bare speaker_key
    // let any other meeting's "Speaker 1" clobber this one's in the map —
    // live-reported bug: an interview's notes attributed every line to a
    // person from a different meeting entirely. Labels are meeting-scoped
    // (migration 11) for exactly this reason.
    let speaker_labels = db
        .list_speaker_labels_for_meeting(&meeting_id)
        .map_err(|e| e.to_string())?;
    let speaker_map: std::collections::HashMap<String, String> = speaker_labels
        .iter()
        .map(|l| (l.speaker_key.clone(), l.display_name.clone()))
        .collect();

    let transcript = db.get_transcript_by_meeting(&meeting_id).map_err(|e| e.to_string())?;
    let transcript_text = transcript
        .map(|t| {
            let segments: Vec<TranscriptSegment> = serde_json::from_str(&t.segments).unwrap_or_default();
            segments.iter().map(|s| {
                let speaker = s.speaker.as_deref()
                    .map(|key| speaker_map.get(key).map(String::as_str).unwrap_or(key))
                    .unwrap_or("Unknown");
                // Timestamped lines give the model an anchor to cite in
                // action_items.source_start_ms (plan rank 2).
                let secs = s.start_ms / 1000;
                let star = if s.highlighted { "★ " } else { "" };
                format!("{}[{}:{:02}] {}: {}", star, secs / 60, secs % 60, speaker, s.text)
            }).collect::<Vec<_>>().join("\n")
        })
        .unwrap_or_default();
    log::info!("generate_meeting_notes: transcript length = {} chars", transcript_text.len());
    // Nothing in = fabrication out (whole-app review P2): with no
    // transcript and no typed notes, the model invents a plausible meeting.
    // catch_me_up has had exactly this guard from day one; enhance gets it
    // too. Imported meetings mid-transcription land here as well.
    if transcript_text.trim().is_empty()
        && user_notes.as_deref().map_or(true, |n| n.trim().is_empty())
    {
        return Err(
            "Nothing to enhance yet — there's no transcript and no typed notes. \
             If this meeting is still transcribing, give it a moment."
                .to_string(),
        );
    }

    // Prefer the caller's plain text; fall back to stored raw content for
    // non-UI callers. (The old code passed raw TipTap JSON to the prompt.)
    let note = db.get_note_by_meeting(&meeting_id).map_err(|e| e.to_string())?;
    let db_notes = note.as_ref().and_then(|n| n.raw_content.as_deref()).unwrap_or("");
    let user_notes: &str = user_notes.as_deref().unwrap_or(db_notes);

    // Template resolution (plan v3 rank 5): an explicit pick wins AND is
    // remembered for the recurring series; with no pick, the series'
    // remembered template beats the global default — so instant recap and
    // next week's instance enhance the way this series always does.
    let template = match template_id.as_deref() {
        Some(id) => {
            let t = db
                .get_template_by_id(id)
                .map_err(|e| e.to_string())?
                .ok_or("selected template not found")?;
            let _ = db.remember_series_template(&meeting.title, id);
            t
        }
        None => {
            let series = db
                .series_template_for(&meeting.title)
                .ok()
                .flatten()
                .and_then(|id| db.get_template_by_id(&id).ok().flatten());
            match series {
                Some(t) => t,
                None => db
                    .get_default_template()
                    .map_err(|e| e.to_string())?
                    .ok_or("no default template found")?,
            }
        }
    };
    log::info!("generate_meeting_notes: using template '{}'", template.name);

    let user_context = db.get_setting("user_context").ok().flatten();
    // Recorder-only tasks (user request): the digest of OTHER people's
    // commitments belongs in the summary; /tasks is the user's list.
    let own_tasks_only =
        db.get_setting("tasks_own_only").ok().flatten().as_deref() != Some("false");
    let prompt = prompts::build_note_generation_prompt(&template, &meeting, &transcript_text, user_notes, user_context.as_deref(), own_tasks_only);

    // Enhance receipt (plan v10 #2): capture what this generation reads and
    // who runs it, BEFORE the (15-40s) AI call — the accuracy pass can swap
    // segments mid-generation, and the receipt must hash the transcript the
    // prompt was actually built from. Same sha256-of-segments-JSON as the
    // accuracy pass (segments_snapshot).
    let transcript_sha = db
        .segments_snapshot(&meeting_id)
        .ok()
        .flatten()
        .map(|(_, hash)| hash);
    let (receipt_provider, receipt_model) = ai::provider_receipt(&db);

    log::info!("generate_meeting_notes: calling Anthropic API...");

    // Stream live summary words to the UI while the model writes (plan
    // rank 1) — the command's return contract is unchanged.
    let delta_app = app.clone();
    let delta_meeting = meeting_id.clone();
    let on_delta = move |text: &str| {
        let _ = delta_app.emit(
            "enhance-delta",
            serde_json::json!({ "meeting_id": delta_meeting, "text": text }),
        );
    };
    let mut generated = ai::generate_notes_streaming(&db, &prompt, &on_delta)
        .await
        .map_err(|e| {
            log::error!("generate_meeting_notes: AI failed: {}", e);
            e.to_string()
        })?;

    // Validate + repair source refs (plan ranks 2+10, v2 rank 9): broken or
    // missing citations are re-anchored to the best-grounded transcript
    // window; only claims grounded nowhere lose their chip.
    let ref_segments: Vec<TranscriptSegment> = db
        .get_transcript_by_meeting(&meeting_id)
        .ok()
        .flatten()
        .and_then(|t| serde_json::from_str(&t.segments).ok())
        .unwrap_or_default();
    anchor_action_items(&mut generated.action_items, &ref_segments);
    // Names the meeting can actually vouch for: transcript text, this
    // meeting's speaker labels, calendar attendees. An assignee outside
    // this set is hallucinated or leaked from elsewhere in the prompt
    // (e.g. a solo call's task assigned to "Dana", a name appearing
    // nowhere in the meeting) — better unowned than wrong.
    let known_names = {
        let mut hay = String::new();
        for s in &ref_segments {
            hay.push_str(&s.text);
            hay.push('\n');
        }
        for name in speaker_map.values() {
            hay.push_str(name);
            hay.push('\n');
        }
        let attendees: Vec<String> = serde_json::from_str(&meeting.attendees).unwrap_or_default();
        for a in &attendees {
            hay.push_str(a);
            hay.push('\n');
        }
        hay
    };
    sanitize_action_items(
        &mut generated.action_items,
        meeting.scheduled_start.as_deref(),
        &known_names,
    );
    if own_tasks_only {
        // Names that mean "the user": their speaker labels in THIS meeting.
        let me_names: Vec<String> = speaker_labels
            .iter()
            .filter(|l| l.participant_type == "me")
            .map(|l| l.display_name.to_lowercase())
            .collect();
        let is_mine = |assignee: Option<&str>| -> bool {
            let Some(a) = assignee else { return true }; // unowned = the user's by default
            let norm = a.trim().to_lowercase();
            if ["me", "i", "myself"].contains(&norm.as_str()) {
                return true;
            }
            let first = norm.split_whitespace().next().unwrap_or("");
            me_names
                .iter()
                .any(|m| m == &norm || m.split_whitespace().next() == Some(first))
        };
        let before = generated.action_items.len();
        generated.action_items.retain(|i| is_mine(i.assignee.as_deref()));
        if generated.action_items.len() < before {
            log::info!(
                "own-tasks-only: dropped {} item(s) owned by other participants",
                before - generated.action_items.len()
            );
        }
    }

    // Bullet provenance (plan v3 rank 7): same trust bar as action items —
    // an anchor must point inside the recording at a window that grounds the
    // bullet's claim, else it's dropped (a bullet without a replay mark is
    // fine; a wrong mark never is).
    let max_ms = ref_segments.last().map(|s| s.end_ms).unwrap_or(0);
    let sections = generated.sections.clone();
    generated.bullet_anchors.retain(|a| {
        let Some(bullet) = sections
            .get(a.section_index)
            .and_then(|sec| sec.bullets.get(a.bullet_index))
        else {
            return false;
        };
        if max_ms == 0 || a.source_start_ms > max_ms {
            return false;
        }
        let Some(i) = ref_segments
            .iter()
            .position(|s| s.start_ms <= a.source_start_ms && a.source_start_ms <= s.end_ms)
        else {
            return false;
        };
        let lo = i.saturating_sub(1);
        let hi = (i + 1).min(ref_segments.len() - 1);
        let window = ref_segments[lo..=hi]
            .iter()
            .map(|s| s.text.as_str())
            .collect::<Vec<_>>()
            .join(" ");
        claim_is_grounded(bullet, &window)
    });

    // Stamp the receipt for the frontend to hand back at persist time —
    // the model never produces this field.
    generated.receipt = Some(crate::ai::anthropic_api::GenerationReceipt {
        provider: receipt_provider,
        model: receipt_model,
        transcript_sha,
    });
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

/// True when the Apple Speech transcription engine (SpeechTranscriber) can
/// run on this machine — macOS 26+ with a locale asset installed. Gates the
/// Engine picker in Settings → Audio (plan v9 #12).
#[tauri::command]
pub fn speech_engine_available() -> bool {
    crate::transcription::apple::is_available()
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

/// Batch re-transcribe existing recordings with the selected transcription
/// engine (whisper by default; Apple Speech on macOS 26+ when chosen, plan
/// v9 #12). For each meeting ID, finds the WAV recording file, transcribes
/// it, then updates the transcript segments in the database.
#[tauri::command]
pub async fn batch_retranscribe(
    app: AppHandle,
    db: State<'_, Database>,
    meeting_ids: Vec<String>,
) -> Result<Vec<RetranscribeResult>, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let recordings_dir = app_data_dir.join("recordings");

    let engine_choice = crate::transcription::engine::resolve_engine(
        db.get_setting("transcription_engine").ok().flatten(),
        crate::transcription::apple::is_available(),
    );
    log::info!("batch_retranscribe: {} meetings via {:?}", meeting_ids.len(), engine_choice);

    let language = db.get_setting("whisper_language").ok().flatten();
    let correction_rules = crate::transcription::corrections::parse_rules(
        db.get_setting("correction_rules").ok().flatten().as_deref(),
    );

    // Whisper-only setup: resolve + load the model ONCE for the whole batch
    // (jobs then run strictly sequentially — one Metal state is the
    // supported concurrency model; retranscribe is a background task
    // anyway). The Apple engine needs no model file at all: locale assets
    // are OS-managed, which is the whole point of the option.
    let whisper_engine = match engine_choice {
        crate::transcription::engine::EngineChoice::Apple => None,
        crate::transcription::engine::EngineChoice::Whisper => {
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

            let gpu_enabled = db.get_setting("gpu_acceleration")
                .ok().flatten().map(|v| v == "true").unwrap_or(false);

            let engine = tokio::task::spawn_blocking({
                let mp = model_path.clone();
                move || crate::transcription::engine::WhisperEngine::load(&mp, gpu_enabled)
            })
            .await
            .map_err(|e| e.to_string())?
            .map_err(|e| e.to_string())?;
            Some(engine)
        }
    };

    let mut results = Vec::new();
    for meeting_id in &meeting_ids {
        let meeting_id = meeting_id.clone();
        let wav_path = recordings_dir.join(format!("{}.wav", meeting_id));
        if !wav_path.exists() {
            results.push(RetranscribeResult {
                meeting_id,
                success: false,
                error: Some("Recording file not found".to_string()),
            });
            continue;
        }

        let _ = app.emit("retranscribe-progress", serde_json::json!({
            "meeting_id": meeting_id,
            "status": "transcribing",
        }));

        let outcome = tokio::task::spawn_blocking({
            let whisper_engine = whisper_engine.clone();
            let language = language.clone();
            let meeting_id = meeting_id.clone();
            let rules = correction_rules.clone();
            move || -> Result<Vec<TranscriptSegment>, String> {
                let samples = crate::transcription::engine::wav_to_whisper_samples(&wav_path)
                    .map_err(|e| format!("Failed to read recording: {}", e))?;
                let segs = match &whisper_engine {
                    Some(engine) => {
                        let mut state = engine.create_state().map_err(|e| e.to_string())?;
                        crate::transcription::engine::transcribe_full(&mut state, &samples, language.as_deref())
                            .map_err(|e| e.to_string())?
                    }
                    None => {
                        // Apple Speech: hand over the SAME resampled audio
                        // whisper would see, as a temp 16k WAV (the Swift
                        // bridge's input contract).
                        let tmp = std::env::temp_dir()
                            .join(format!("perchnote-retranscribe-{}.wav", meeting_id));
                        let result = crate::transcription::apple::write_16k_wav(&samples, &tmp)
                            .and_then(|()| {
                                crate::transcription::apple::transcribe_wav_file(&tmp, language.as_deref())
                            });
                        let _ = std::fs::remove_file(&tmp);
                        result.map_err(|e| e.to_string())?
                    }
                };
                Ok(segs
                    .into_iter()
                    .map(|s| TranscriptSegment {
                        // Sticky correction rules (plan v10 #5): applied
                        // where ASR text is born, for both engines.
                        text: crate::transcription::corrections::apply_rules(&s.text, &rules),
                        start_ms: s.start_ms,
                        end_ms: s.end_ms,
                        speaker: None,
                        confidence: None,
                        words: (!s.words.is_empty()).then_some(s.words),
                        is_overlap: false,
                        speaker_confidence: 0.0,
                        highlighted: false,
                    })
                    .collect())
            }
        })
        .await
        .unwrap_or_else(|e| Err(format!("transcription task failed: {}", e)));

        let result = match outcome {
            Ok(segments) => {
                let segments_json =
                    serde_json::to_string(&segments).unwrap_or_else(|_| "[]".to_string());
                let db_ref = app.state::<Database>();
                let saved = match db_ref.get_transcript_by_meeting(&meeting_id) {
                    Ok(Some(transcript)) => db_ref
                        .update_transcript_segments(&transcript.id, &segments_json)
                        .map_err(|e| format!("Failed to update transcript: {}", e)),
                    _ => db_ref
                        .create_transcript(&meeting_id, "retranscribe")
                        .map_err(|e| format!("Failed to create transcript: {}", e))
                        .and_then(|transcript| {
                            db_ref
                                .update_transcript_segments(&transcript.id, &segments_json)
                                .map_err(|e| format!("Failed to save transcript: {}", e))
                        }),
                };
                match saved {
                    Ok(()) => {
                        let _ = app.emit("retranscribe-progress", serde_json::json!({
                            "meeting_id": meeting_id,
                            "status": "complete",
                        }));
                        RetranscribeResult { meeting_id: meeting_id.clone(), success: true, error: None }
                    }
                    Err(e) => RetranscribeResult {
                        meeting_id: meeting_id.clone(),
                        success: false,
                        error: Some(e),
                    },
                }
            }
            Err(e) => RetranscribeResult {
                meeting_id: meeting_id.clone(),
                success: false,
                error: Some(e),
            },
        };
        results.push(result);
    }

    Ok(results)
}


/// Talk-balance stats persisted at recording stop (plan v3 rank 8).
#[tauri::command]
pub fn get_talk_stats(
    db: State<'_, Database>,
    meeting_id: String,
) -> Result<Option<String>, String> {
    db.get_talk_stats(&meeting_id).map_err(|e| e.to_string())
}

/// Flag the transcript moment at `ms` (plan v3 rank 6). If its segment is
/// already stored, mark it now; otherwise keep it pending for the live
/// forwarding loop to apply when the segment arrives.
#[tauri::command]
pub fn highlight_moment(
    state: State<'_, AppState>,
    db: State<'_, Database>,
    meeting_id: String,
    ms: u64,
) -> Result<bool, String> {
    let applied = db.highlight_segment_at(&meeting_id, ms).unwrap_or(false);
    if !applied {
        if let Ok(mut pending) = state.pending_highlights.lock() {
            pending.push(ms);
        }
    }
    Ok(applied)
}

/// Flip a segment's highlight from the drawer; returns the new state.
#[tauri::command]
pub fn toggle_segment_highlight(
    db: State<'_, Database>,
    meeting_id: String,
    index: usize,
) -> Result<bool, String> {
    db.toggle_segment_highlight(&meeting_id, index)
        .map_err(|e| e.to_string())
}

/// Re-embed a meeting after a transcript edit so semantic recall doesn't
/// keep matching the old wording. Purge-first (QA audit P3-10): the
/// indexer only upserts segments over its length floor and under its
/// per-meeting cap, so an edit shrinking a segment below the floor — or
/// touching one past the cap — would otherwise keep a stale vector whose
/// embed-time text still surfaces verbatim in "Related:". Background +
/// best-effort: embeddings may be off, and an edit must never wait on
/// Ollama.
pub(crate) fn reindex_after_edit(app: &tauri::AppHandle, meeting_id: String) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let db = app.state::<Database>();
        if let Err(e) = db.purge_meeting_vectors(&meeting_id) {
            log::debug!("vector purge before re-embed skipped: {e}");
        }
        if let Err(e) = crate::ai::embeddings::index_meeting(&db, &meeting_id).await {
            log::debug!("re-embed after transcript edit skipped: {e}");
        }
    });
}

/// Carry speakers and ⌘D highlights from the live segments onto the
/// re-decoded ones by midpoint containment (plan v10 #3): boundaries
/// differ between chunked and whole-file decodes, but a moment's midpoint
/// lands in exactly one new segment.
fn remap_segment_metadata(
    old: &[serde_json::Value],
    new: &mut [crate::transcription::whisper::TranscriptSegment],
) {
    for o in old {
        let start = o.get("start_ms").and_then(|v| v.as_u64()).unwrap_or(0);
        let end = o.get("end_ms").and_then(|v| v.as_u64()).unwrap_or(start);
        let mid = start + (end.saturating_sub(start)) / 2;
        let Some(target) = new
            .iter_mut()
            .find(|n| n.start_ms <= mid && mid < n.end_ms.max(n.start_ms + 1))
        else {
            continue;
        };
        if target.speaker.is_none() {
            if let Some(sp) = o.get("speaker").and_then(|v| v.as_str()) {
                target.speaker = Some(sp.to_string());
            }
        }
        if o.get("highlighted").and_then(|v| v.as_bool()).unwrap_or(false) {
            target.highlighted = true;
        }
    }
}

/// Accuracy pass (plan v10 #3): re-decode the finished WAV with the
/// whole-file, full-context path imports already get, then swap the
/// segments in — ONLY if nothing changed them meanwhile (hash CAS; a
/// user edit always wins). Speakers and highlights carry over by time.
/// Background and best-effort; gated by the `accuracy_pass` setting
/// (default on).
fn spawn_accuracy_pass(app: &AppHandle, meeting_id: String) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        run_accuracy_pass(&app, &meeting_id).await;
        // Speakers that name themselves (plan v10 #1): diarization runs
        // strictly AFTER the accuracy pass resolves — swap, user-edit skip,
        // or disabled — so the speaker keys it writes land on the final
        // segment boundaries and never race the whole-file swap. Its own
        // write is hash-CAS-guarded too.
        crate::commands::voice::auto_diarize_and_name(&app, &meeting_id).await;
    });
}

/// The accuracy-pass body — awaited by `spawn_accuracy_pass` so follow-up
/// stages (auto-diarize) sequence after it no matter which early-return
/// path it takes.
async fn run_accuracy_pass(app: &AppHandle, meeting_id: &str) {
        let db = app.state::<Database>();
        if db.get_setting("accuracy_pass").ok().flatten().as_deref() == Some("false") {
            return;
        }
        // One whisper engine at a time, app-wide (QA audit P2): an import or
        // another meeting's pass may already hold a ~2GB Metal context. Queue
        // behind it — and take the snapshot AFTER acquiring, so a long wait
        // can't hand the CAS a hash that's stale before we even decode.
        let _gate = crate::commands::import::IMPORT_GATE.lock().await;
        let Ok(Some((old_json, old_hash))) = db.segments_snapshot(meeting_id) else { return };
        let old: Vec<serde_json::Value> = serde_json::from_str(&old_json).unwrap_or_default();
        if old.is_empty() {
            return; // live produced nothing — nothing worth re-decoding
        }

        let app_data_dir = match app.path().app_data_dir() {
            Ok(d) => d,
            Err(_) => return,
        };
        let wav_path = app_data_dir.join("recordings").join(format!("{}.wav", meeting_id));
        if !wav_path.exists() {
            return;
        }

        let engine_choice = crate::transcription::engine::resolve_engine(
            db.get_setting("transcription_engine").ok().flatten(),
            crate::transcription::apple::is_available(),
        );
        let language = db.get_setting("whisper_language").ok().flatten();
        let rules = crate::transcription::corrections::parse_rules(
            db.get_setting("correction_rules").ok().flatten().as_deref(),
        );
        let whisper_model = match engine_choice {
            crate::transcription::engine::EngineChoice::Apple => None,
            crate::transcription::engine::EngineChoice::Whisper => {
                // Same candidate list the batch path uses (QA audit P2): a
                // model living in Homebrew's share dir records and
                // retranscribes fine — the pass must not silently skip it.
                let preferred = db
                    .get_setting("whisper_model")
                    .ok()
                    .flatten()
                    .unwrap_or_else(|| "medium.en".to_string());
                let name = format!("ggml-{preferred}.bin");
                let candidates = [
                    app_data_dir.join("models").join(&name),
                    std::path::PathBuf::from(format!(
                        "/opt/homebrew/share/whisper-cpp/models/{name}"
                    )),
                    std::path::PathBuf::from(format!(
                        "/usr/local/share/whisper-cpp/models/{name}"
                    )),
                ];
                match candidates.iter().find(|p| p.exists()).cloned() {
                    Some(p) => Some(p),
                    None => {
                        log::info!(
                            "accuracy pass skipped for {meeting_id}: model {name} not found"
                        );
                        return;
                    }
                }
            }
        };
        let gpu = db
            .get_setting("gpu_acceleration")
            .ok()
            .flatten()
            .map(|v| v == "true")
            .unwrap_or(false);

        log::info!("accuracy pass: re-decoding {meeting_id} via {engine_choice:?}");
        let decoded = tokio::task::spawn_blocking({
            let wav_path = wav_path.clone();
            let meeting_id = meeting_id.to_string();
            move || -> Result<Vec<crate::transcription::whisper::TranscriptSegment>, String> {
                let samples = crate::transcription::engine::wav_to_whisper_samples(&wav_path)
                    .map_err(|e| e.to_string())?;
                let segs = match whisper_model {
                    Some(mp) => {
                        let engine = crate::transcription::engine::WhisperEngine::load(&mp, gpu)
                            .map_err(|e| e.to_string())?;
                        let mut state = engine.create_state().map_err(|e| e.to_string())?;
                        crate::transcription::engine::transcribe_full(
                            &mut state,
                            &samples,
                            language.as_deref(),
                        )
                        .map_err(|e| e.to_string())?
                    }
                    None => {
                        let tmp = std::env::temp_dir()
                            .join(format!("perchnote-accuracy-{meeting_id}.wav"));
                        let result = crate::transcription::apple::write_16k_wav(&samples, &tmp)
                            .and_then(|()| {
                                crate::transcription::apple::transcribe_wav_file(
                                    &tmp,
                                    language.as_deref(),
                                )
                            });
                        let _ = std::fs::remove_file(&tmp);
                        result.map_err(|e| e.to_string())?
                    }
                };
                Ok(segs
                    .into_iter()
                    .map(|s| crate::transcription::whisper::TranscriptSegment {
                        text: s.text,
                        start_ms: s.start_ms,
                        end_ms: s.end_ms,
                        speaker: None,
                        confidence: None,
                        words: (!s.words.is_empty()).then_some(s.words),
                        is_overlap: false,
                        speaker_confidence: 0.0,
                        highlighted: false,
                    })
                    .collect())
            }
        })
        .await
        .unwrap_or_else(|e| Err(e.to_string()));

        let mut new_segments = match decoded {
            Ok(s) if !s.is_empty() => s,
            Ok(_) => {
                log::info!("accuracy pass: empty re-decode for {meeting_id}; keeping live transcript");
                return;
            }
            Err(e) => {
                log::info!("accuracy pass skipped for {meeting_id}: {e}");
                return;
            }
        };
        for seg in new_segments.iter_mut() {
            seg.text = crate::transcription::corrections::apply_rules(&seg.text, &rules);
        }
        remap_segment_metadata(&old, &mut new_segments);

        let new_json = match serde_json::to_string(&new_segments) {
            Ok(j) => j,
            Err(_) => return,
        };
        match db.swap_segments_if_unchanged(meeting_id, &old_hash, &new_json) {
            Ok(true) => {
                log::info!(
                    "accuracy pass: upgraded {meeting_id} ({} -> {} segments)",
                    old.len(),
                    new_segments.len()
                );
                reindex_after_edit(app, meeting_id.to_string());
                let _ = app.emit(
                    "transcript-upgraded",
                    serde_json::json!({ "meeting_id": meeting_id }),
                );
            }
            Ok(false) => {
                log::info!("accuracy pass: {meeting_id} changed during re-decode; user edit wins");
            }
            Err(e) => log::warn!("accuracy pass swap failed for {meeting_id}: {e}"),
        }
}

/// Edit one transcript segment's text (drawer inline edit, plan v9 #8).
/// FTS re-syncs via the migration-17 triggers on write.
#[tauri::command]
pub async fn update_segment_text(
    app: tauri::AppHandle,
    db: State<'_, Database>,
    meeting_id: String,
    index: usize,
    text: String,
) -> Result<bool, String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err("Segment text cannot be empty".into());
    }
    let ok = db
        .update_segment_text(&meeting_id, index, trimmed)
        .map_err(|e| e.to_string())?;
    if ok {
        reindex_after_edit(&app, meeting_id);
    }
    Ok(ok)
}

/// Find→replace across a meeting's transcript — fixes a misheard name
/// everywhere at once (plan v9 #8). Returns segments touched.
#[tauri::command]
pub async fn replace_in_transcript(
    app: tauri::AppHandle,
    db: State<'_, Database>,
    meeting_id: String,
    find: String,
    replace: String,
) -> Result<usize, String> {
    let n = db
        .replace_in_transcript(&meeting_id, &find, &replace)
        .map_err(|e| e.to_string())?;
    if n > 0 {
        reindex_after_edit(&app, meeting_id);
    }
    Ok(n)
}

#[cfg(test)]
mod accuracy_pass_tests {
    use super::remap_segment_metadata;
    use crate::transcription::whisper::TranscriptSegment;

    fn seg(start: u64, end: u64) -> TranscriptSegment {
        TranscriptSegment {
            text: String::new(),
            start_ms: start,
            end_ms: end,
            speaker: None,
            confidence: None,
            words: None,
            is_overlap: false,
            speaker_confidence: 0.0,
            highlighted: false,
        }
    }

    #[test]
    fn speakers_and_highlights_carry_by_midpoint() {
        // Old: two live chunks; second is flagged and labeled. New decode
        // split things differently — the midpoints decide.
        let old = vec![
            serde_json::json!({"text":"a","start_ms":0,"end_ms":4000,"speaker":"Speaker 1"}),
            serde_json::json!({"text":"b","start_ms":4000,"end_ms":10000,"speaker":"Speaker 2","highlighted":true}),
        ];
        let mut new = vec![seg(0, 3000), seg(3000, 8000), seg(8000, 12000)];
        remap_segment_metadata(&old, &mut new);

        assert_eq!(new[0].speaker.as_deref(), Some("Speaker 1")); // mid 2000
        assert_eq!(new[1].speaker.as_deref(), Some("Speaker 2")); // mid 7000
        assert!(new[1].highlighted);
        assert!(!new[0].highlighted && !new[2].highlighted);
        assert!(new[2].speaker.is_none(), "nothing old maps past 10s");
    }

    #[test]
    fn first_mapped_speaker_wins_and_zero_length_segments_tolerated() {
        let old = vec![
            serde_json::json!({"text":"a","start_ms":0,"end_ms":1000,"speaker":"A"}),
            serde_json::json!({"text":"b","start_ms":1000,"end_ms":2000,"speaker":"B"}),
            serde_json::json!({"text":"z","start_ms":5000,"end_ms":5000,"highlighted":true}),
        ];
        // One big new segment swallows both old ones; A maps first and holds.
        let mut new = vec![seg(0, 2000), seg(5000, 5000)];
        remap_segment_metadata(&old, &mut new);
        assert_eq!(new[0].speaker.as_deref(), Some("A"));
        assert!(new[1].highlighted, "zero-length midpoint still lands");
    }
}

#[cfg(test)]
mod grounding_tests {
    use super::claim_is_grounded;

    #[test]
    fn grounded_when_names_and_numbers_match() {
        assert!(claim_is_grounded(
            "Send Q4 deck to Alice",
            "yeah Alice said she needs the Q4 deck by friday"
        ));
    }

    #[test]
    fn ungrounded_when_terms_absent() {
        assert!(!claim_is_grounded(
            "Schedule onsite with Bob in Berlin",
            "let's circle back on the roadmap next week"
        ));
    }

    #[test]
    fn lowercase_claims_always_pass() {
        assert!(claim_is_grounded("follow up on the budget", "totally unrelated text"));
    }

    #[test]
    fn partial_overlap_meets_threshold() {
        // 1 of 3 checkable terms (33%) — passes the 30% bar with >=1 hit.
        assert!(claim_is_grounded(
            "Email Sarah about Atlas pricing 2026",
            "Sarah will take pricing offline"
        ));
    }

    use super::anchor_action_items;
    use crate::ai::anthropic_api::ActionItem;
    use crate::transcription::whisper::TranscriptSegment;

    fn seg(text: &str, start_ms: u64, end_ms: u64) -> TranscriptSegment {
        TranscriptSegment {
            text: text.into(),
            start_ms,
            end_ms,
            speaker: None,
            confidence: None,
            words: None,
            is_overlap: false,
            speaker_confidence: 0.0,
            highlighted: false,
        }
    }

    fn item(task: &str, ms: Option<u64>) -> ActionItem {
        ActionItem {
            task: task.into(),
            assignee: None,
            deadline: None,
            source_start_ms: ms,
        }
    }

    fn fixture() -> Vec<TranscriptSegment> {
        vec![
            seg("good morning everyone let's get started", 0, 5_000),
            seg("Alice wants the Q4 deck before the board call", 5_000, 10_000),
            seg("we should also look at hiring", 10_000, 15_000),
            seg("Bob will book the Berlin onsite for March", 15_000, 20_000),
        ]
    }

    #[test]
    fn sanitizer_fixes_placeholders_dates_and_dupes() {
        use super::sanitize_action_items;
        let mut items = vec![
            item("Send the deck", Some(5_000)),
            item("Send the deck!", None), // re-discussed duplicate
            item("Book flights", None),
        ];
        items[0].assignee = Some("Unassigned".into());
        items[0].deadline = Some("2026-06-15".into());
        items[2].assignee = Some("Amy".into());
        items[2].deadline = Some("2031-01-01".into()); // > 1 year out

        sanitize_action_items(&mut items, Some("2026-06-10T15:00:00Z"), "Amy said hi");

        assert_eq!(items.len(), 2, "duplicate collapsed");
        assert_eq!(items[0].assignee, None, "placeholder owner dropped");
        assert_eq!(items[0].deadline.as_deref(), Some("2026-06-15"), "plausible date kept");
        assert_eq!(items[1].assignee.as_deref(), Some("Amy"));
        assert_eq!(items[1].deadline, None, "implausible date dropped");
    }

    #[test]
    fn ungrounded_assignee_is_dropped_grounded_and_self_kept() {
        use super::sanitize_action_items;
        let mk = |assignee: &str| ActionItem {
            task: format!("task for {assignee}"),
            assignee: Some(assignee.to_string()),
            deadline: None,
            source_start_ms: None,
        };
        let mut items = vec![mk("Dana"), mk("Amy Chen"), mk("me"), mk("Sam")];
        // Solo call: transcript mentions Amy; "Sam" only via speaker label
        // haystack the caller assembled.
        sanitize_action_items(
            &mut items,
            Some("2026-06-10T15:00:00Z"),
            "I'll send Amy the deck tomorrow.\nSam\n",
        );
        assert_eq!(items[0].assignee, None, "name from another life is dropped");
        assert_eq!(items[1].assignee.as_deref(), Some("Amy Chen"), "first-name grounding suffices");
        assert_eq!(items[2].assignee.as_deref(), Some("me"), "self always passes");
        assert_eq!(items[3].assignee.as_deref(), Some("Sam"), "speaker label grounds the owner");
    }

    #[test]
    fn keeps_a_valid_grounded_ref_untouched() {
        let segs = fixture();
        let mut items = vec![item("Send Q4 deck to Alice", Some(6_000))];
        anchor_action_items(&mut items, &segs);
        assert_eq!(items[0].source_start_ms, Some(6_000));
    }

    #[test]
    fn re_anchors_a_mispointed_ref_to_the_grounding_segment() {
        let segs = fixture();
        // Cited 0ms (the greeting) but the claim lives at 15s.
        let mut items = vec![item("Book Berlin onsite with Bob", Some(0))];
        anchor_action_items(&mut items, &segs);
        assert_eq!(items[0].source_start_ms, Some(15_000));
    }

    #[test]
    fn fills_a_missing_ref_for_apple_parity() {
        let segs = fixture();
        let mut items = vec![item("Send Q4 deck to Alice", None)];
        anchor_action_items(&mut items, &segs);
        assert_eq!(items[0].source_start_ms, Some(5_000));
    }

    #[test]
    fn strips_refs_grounded_nowhere_and_leaves_unanchorable_missing_refs() {
        let segs = fixture();
        let mut items = vec![
            item("Ping Zelda about the Mars launch", Some(6_000)),
            item("Ping Zelda about the Mars launch", None),
        ];
        anchor_action_items(&mut items, &segs);
        assert_eq!(items[0].source_start_ms, None);
        assert_eq!(items[1].source_start_ms, None);
    }

    #[test]
    fn unchekable_claims_keep_in_range_refs_but_lose_impossible_ones() {
        let segs = fixture();
        let mut items = vec![
            item("follow up on the budget", Some(6_000)),
            item("follow up on the budget", Some(99_000)),
        ];
        anchor_action_items(&mut items, &segs);
        assert_eq!(items[0].source_start_ms, Some(6_000));
        assert_eq!(items[1].source_start_ms, None);
    }

    #[test]
    fn empty_transcript_strips_everything() {
        let mut items = vec![item("Send Q4 deck to Alice", Some(6_000))];
        anchor_action_items(&mut items, &[]);
        assert_eq!(items[0].source_start_ms, None);
    }
}
