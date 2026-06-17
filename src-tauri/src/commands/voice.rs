use tauri::{AppHandle, Emitter, Manager, State};
use crate::db::Database;
use crate::db::queries::VoiceProfile;
use crate::audio::clip::{clip_wav, load_wav_as_mono_f32};
use crate::audio::mel::extract_mel_features;
use serde::{Serialize, Deserialize};
use std::path::PathBuf;

/// Save a voice profile with the given name and raw audio data.
/// The audio data is written to a WAV file in the app data directory.
#[tauri::command]
pub fn save_voice_profile(
    app: AppHandle,
    db: State<'_, Database>,
    name: String,
    audio_data: Vec<f32>,
) -> Result<VoiceProfile, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    let voices_dir = app_data_dir.join("voice_profiles");
    std::fs::create_dir_all(&voices_dir).map_err(|e| e.to_string())?;

    let id = uuid::Uuid::new_v4().to_string();
    let wav_path = voices_dir.join(format!("{}.wav", id));

    // Write 16kHz mono WAV
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: 16_000,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };

    let mut writer = hound::WavWriter::create(&wav_path, spec)
        .map_err(|e| format!("Failed to create WAV file: {}", e))?;
    for &sample in &audio_data {
        let s16 = (sample * i16::MAX as f32).clamp(i16::MIN as f32, i16::MAX as f32) as i16;
        writer.write_sample(s16).map_err(|e| format!("Failed to write sample: {}", e))?;
    }
    writer.finalize().map_err(|e| format!("Failed to finalize WAV: {}", e))?;

    let sample_path = wav_path.to_string_lossy().to_string();
    db.create_voice_profile(&name, &sample_path)
        .map_err(|e| e.to_string())
}

/// List all saved voice profiles.
#[tauri::command]
pub fn list_voice_profiles(db: State<'_, Database>) -> Result<Vec<VoiceProfile>, String> {
    db.list_voice_profiles().map_err(|e| e.to_string())
}

/// Delete a voice profile by ID, also removing the audio file from disk.
#[tauri::command]
pub fn delete_voice_profile(db: State<'_, Database>, id: String) -> Result<(), String> {
    let sample_path = db.delete_voice_profile(&id).map_err(|e| e.to_string())?;
    // Clean up the audio file if it exists
    if let Some(path) = sample_path {
        let _ = std::fs::remove_file(path);
    }
    Ok(())
}

// ── Speaker-recognition helpers ──────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
pub struct UnknownSpeaker {
    pub speaker_key: String,
    /// Current label for this speaker, if the user has named them.
    pub display_name: Option<String>,
    pub longest_start_ms: u64,
    pub longest_end_ms: u64,
    pub total_seconds: u64,
    /// Best-match suggestion from existing voice profiles, if any.
    pub suggested_name: Option<String>,
    pub suggested_similarity: Option<f32>,
}

/// Voice-match threshold, in z-normalized MEL embedding space (matching the
/// clustering MERGE_THRESHOLD's space — see audio/cluster.rs). Fallback path
/// only, used when the neural models aren't downloaded. Suggestions are
/// user-confirmed, so a borderline match surfacing as a hint is fine.
const VOICE_MATCH_THRESHOLD: f32 = 0.72;

/// Auto-apply threshold for NEURAL (wespeaker) profile matching, plain
/// cosine on L2-normalized embeddings. Auto-naming is unconfirmed — a wrong
/// name silently propagates into notes, exports, and AI summaries — so this
/// is tuned for false positives ~zero, not recall. Calibration (the
/// say-voice fixture, --ignored tests in audio/diarize.rs): same voice,
/// same channel, different words = 0.81; different voices = 0.28–0.37
/// direct, worst case 0.506 for a diarized centroid against an unrelated
/// TTS profile. wespeaker-voxceleb-resnet34's verification operating point
/// sits near 0.4–0.5 cosine; impostors above 0.6 are already rare. 0.70 is
/// therefore far above every measured wrong-voice score (≥0.19 margin)
/// while remaining reachable for a genuine re-encounter — enrollments are
/// clipped from real meeting audio, so the same person on the same mic
/// scores near the fixture's 0.81. (An initial 0.85 was measured to be
/// unreachable even for the ideal same-voice pair — zero recall.) Matches
/// in 0.5–0.7 still surface via the user-confirmed suggestion chip.
pub const NEURAL_AUTO_APPLY_THRESHOLD: f32 = 0.70;

/// Auto-apply additionally requires the best profile to beat the runner-up
/// (best score per distinct name) by this margin — an ambiguous "two
/// profiles both kind of fit" must stay a suggestion, never an auto-name.
pub const NEURAL_AUTO_APPLY_MARGIN: f32 = 0.05;

/// Suggestion threshold for neural matching — the Speakers panel hint,
/// always user-confirmed, so recall matters more than precision here.
pub const NEURAL_SUGGEST_THRESHOLD: f32 = 0.50;

/// `auto_diarize` setting gate (default ON, same pattern as
/// `auto_enhance_on_complete` / `accuracy_pass`).
pub fn auto_diarize_enabled(setting: Option<&str>) -> bool {
    setting != Some("false")
}

/// Plain-cosine best match among neural profiles of the same dimension.
/// Profiles are stored L2-normalized; mel rows (64-dim) can never collide
/// with the 256-dim wespeaker space, so a length check is the only
/// discriminator needed. Returns the best (name, similarity) with no
/// threshold applied — callers decide auto-apply vs suggest.
pub fn best_neural_match(
    query: &[f32],
    profiles: &[(String, Vec<f32>)],
) -> Option<(String, f32)> {
    profiles
        .iter()
        .filter(|(_, emb)| emb.len() == query.len() && !query.is_empty())
        .map(|(name, emb)| (name.clone(), crate::audio::mel::cosine_similarity(query, emb)))
        .max_by(|a, b| a.1.total_cmp(&b.1))
}

/// The auto-apply decision: strict threshold AND a clear winner.
/// Scores are first collapsed to the best per distinct display name (two
/// enrollments of the same person must not block each other via the margin
/// rule), then the top name must clear `NEURAL_AUTO_APPLY_THRESHOLD` and
/// beat the runner-up name by `NEURAL_AUTO_APPLY_MARGIN`.
pub fn auto_apply_match(
    query: &[f32],
    profiles: &[(String, Vec<f32>)],
) -> Option<(String, f32)> {
    let mut by_name: std::collections::HashMap<&str, f32> = std::collections::HashMap::new();
    for (name, emb) in profiles {
        if emb.len() != query.len() || query.is_empty() {
            continue;
        }
        let sim = crate::audio::mel::cosine_similarity(query, emb);
        let entry = by_name.entry(name.as_str()).or_insert(f32::MIN);
        if sim > *entry {
            *entry = sim;
        }
    }
    let mut ranked: Vec<(&str, f32)> = by_name.into_iter().collect();
    ranked.sort_by(|a, b| b.1.total_cmp(&a.1));
    let (best_name, best) = *ranked.first()?;
    if best < NEURAL_AUTO_APPLY_THRESHOLD {
        return None;
    }
    if let Some((_, second)) = ranked.get(1) {
        if best - second < NEURAL_AUTO_APPLY_MARGIN {
            return None;
        }
    }
    Some((best_name.to_string(), best))
}

/// Should this stored profile embedding be (re-)computed with the neural
/// model? True for: nothing cached, unparseable JSON, a legacy mel vector
/// (exactly MEL_BINS dims), or non-finite values.
pub fn needs_neural_reembed(stored: Option<&str>) -> bool {
    let Some(json) = stored else { return true };
    match serde_json::from_str::<Vec<f32>>(json) {
        Ok(v) => {
            v.is_empty()
                || v.len() == crate::audio::mel::MEL_BINS
                || v.iter().any(|x| !x.is_finite())
        }
        Err(_) => true,
    }
}

/// One auto-applied name, as sent to the frontend toast.
#[derive(Debug, Clone, Serialize)]
pub struct AutoNamedSpeaker {
    pub speaker_key: String,
    pub display_name: String,
    /// speaker_labels row id — Undo deletes exactly this row.
    pub label_id: String,
    pub similarity: f32,
}

/// Payload for the `speakers-auto-named` event.
pub fn auto_named_payload(meeting_id: &str, named: &[AutoNamedSpeaker]) -> serde_json::Value {
    serde_json::json!({ "meeting_id": meeting_id, "named": named })
}

/// Load every voice profile as (name, neural embedding), re-embedding from
/// the sample WAV — and caching on the row — wherever the stored embedding
/// is missing or still mel. Profiles whose samples can't be embedded are
/// skipped (they keep working on the mel fallback path). Blocking work.
fn neural_profiles(
    db: &Database,
    embedder: &mut crate::audio::diarize::SpeakerEmbedder,
) -> Vec<(String, Vec<f32>)> {
    let rows = match db.list_voice_profiles_with_embeddings() {
        Ok(r) => r,
        Err(e) => {
            log::warn!("neural profiles: list failed: {e}");
            return Vec::new();
        }
    };
    let mut out = Vec::with_capacity(rows.len());
    for (id, name, sample_path, emb_json) in rows {
        if !needs_neural_reembed(emb_json.as_deref()) {
            if let Some(json) = &emb_json {
                if let Ok(mut v) = serde_json::from_str::<Vec<f32>>(json) {
                    crate::audio::diarize::l2_normalize(&mut v);
                    out.push((name, v));
                    continue;
                }
            }
        }
        // Re-embed from the enrollment sample (once — the row caches it).
        let embedded = load_wav_as_mono_f32(std::path::Path::new(&sample_path))
            .map_err(|e| e.to_string())
            .and_then(|(pcm, sr)| {
                let pcm_16k = if sr == 16_000 {
                    pcm
                } else {
                    crate::audio::clip::resample_linear_public(&pcm, sr, 16_000)
                };
                embedder.embed(&pcm_16k).map_err(|e| e.to_string())
            });
        match embedded {
            Ok(v) => {
                if let Err(e) = db.update_voice_profile_embedding(&id, &v) {
                    log::warn!("neural profiles: caching embedding for {name} failed: {e}");
                }
                out.push((name, v));
            }
            Err(e) => log::info!("neural profiles: skipping {name} (sample unembeddable: {e})"),
        }
    }
    out
}

/// Returns every speaker_key in the transcript — named and unnamed — with
/// its current label (if any), longest segment range, total talk time, and
/// a voice-match suggestion for the unnamed ones. One holistic list powers
/// the Speakers panel: naming, renaming, and merging duplicates.
#[tauri::command]
pub fn unknown_speakers_for_meeting(
    app: tauri::AppHandle,
    db: State<'_, Database>,
    meeting_id: String,
) -> Result<Vec<UnknownSpeaker>, String> {
    let transcript = db
        .get_transcript_by_meeting(&meeting_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "no transcript for this meeting".to_string())?;

    let segments: Vec<crate::transcription::whisper::TranscriptSegment> =
        serde_json::from_str(&transcript.segments).map_err(|e| e.to_string())?;

    // Current labels for this meeting (key → name). Scoped per-meeting
    // since migration 11 — naming "Speaker 1" in another meeting no longer
    // pre-labels "Speaker 1" here.
    let labeled: std::collections::HashMap<String, String> = db
        .list_speaker_labels_for_meeting(&meeting_id)
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|l| (l.speaker_key, l.display_name))
        .collect();

    // For each speaker, accumulate total talk time + track longest segment.
    use std::collections::HashMap;
    let mut totals: HashMap<String, u64> = HashMap::new();
    let mut longest: HashMap<String, (u64, u64)> = HashMap::new();
    for s in &segments {
        let Some(key) = &s.speaker else { continue };
        let dur = s.end_ms.saturating_sub(s.start_ms);
        *totals.entry(key.clone()).or_default() += dur / 1000;
        match longest.get(key) {
            Some(&(prev_start, prev_end)) if (prev_end - prev_start) >= dur => {}
            _ => { longest.insert(key.clone(), (s.start_ms, s.end_ms)); }
        }
    }

    // Sort by total time descending.
    let mut keys: Vec<String> = longest.keys().cloned().collect();
    keys.sort_by_key(|k| std::cmp::Reverse(totals.get(k).copied().unwrap_or(0)));

    let wav_path = match app.path().app_data_dir() {
        Ok(p) => p.join("recordings").join(format!("{}.wav", meeting_id)),
        Err(e) => return Err(e.to_string()),
    };

    // Neural matcher (plan v10 #1): one embedder + one profile load for the
    // whole panel, but only when some speaker actually needs a suggestion.
    // None → the mel fallback inside suggest_for_range takes over.
    let wants_suggestions =
        wav_path.exists() && keys.iter().any(|k| !labeled.contains_key(k));
    let mut embedder = if wants_suggestions {
        crate::audio::diarize::SpeakerEmbedder::try_new()
    } else {
        None
    };
    let profiles = match embedder.as_mut() {
        Some(e) => neural_profiles(&db, e),
        None => Vec::new(),
    };

    let mut out = Vec::with_capacity(keys.len());
    for key in keys {
        let &(start_ms, end_ms) = longest.get(&key).unwrap();
        let display_name = labeled.get(&key).cloned();
        // Voice-profile suggestions only matter for speakers not yet named.
        let (suggested_name, suggested_similarity) =
            if display_name.is_none() && wav_path.exists() {
                suggest_for_range(&db, &wav_path, start_ms, end_ms, &mut embedder, &profiles)
                    .unwrap_or((None, None))
            } else {
                (None, None)
            };
        out.push(UnknownSpeaker {
            speaker_key: key.clone(),
            display_name,
            longest_start_ms: start_ms,
            longest_end_ms: end_ms,
            total_seconds: totals.get(&key).copied().unwrap_or(0),
            suggested_name,
            suggested_similarity,
        });
    }
    Ok(out)
}

/// Merge one detected speaker into another — the user-facing fix for
/// over-split clusters. See `Database::merge_speaker_keys` for semantics.
#[tauri::command]
pub fn merge_speakers(
    db: State<'_, Database>,
    meeting_id: String,
    from_key: String,
    into_key: String,
) -> Result<usize, String> {
    db.merge_speaker_keys(&meeting_id, &from_key, &into_key)
        .map_err(|e| e.to_string())
}

/// Clips `[start_ms, end_ms)` from the meeting recording, extracts a mel
/// embedding, saves a voice_profiles row, and writes a speaker_labels row
/// mapping `speaker_key` → `name`.
#[tauri::command]
pub fn identify_speaker(
    app: tauri::AppHandle,
    db: State<'_, Database>,
    meeting_id: String,
    speaker_key: String,
    name: String,
    start_ms: u64,
    end_ms: u64,
) -> Result<(), String> {
    let name = name.trim();
    if name.is_empty() { return Err("name is required".to_string()); }

    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let voice_dir = data_dir.join("voice_profiles");
    std::fs::create_dir_all(&voice_dir).map_err(|e| e.to_string())?;
    let sample_id = uuid::Uuid::new_v4().to_string();
    let sample_path: PathBuf = voice_dir.join(format!("{}.wav", sample_id));
    let src_wav = data_dir.join("recordings").join(format!("{}.wav", meeting_id));
    if !src_wav.exists() {
        return Err(format!("source recording not found: {}", src_wav.display()));
    }

    clip_wav(&src_wav, &sample_path, start_ms, end_ms).map_err(|e| e.to_string())?;

    let (pcm, _sr) = load_wav_as_mono_f32(&sample_path).map_err(|e| e.to_string())?;
    // Neural embedding when the speakrs models are on disk (plan v10 #1);
    // mel fallback keeps enrollment working without them. Either way the
    // vector is cached on the profile row — the matchers self-select by
    // dimension (mel 64 vs wespeaker 256).
    let embedding: Vec<f32> = match crate::audio::diarize::SpeakerEmbedder::try_new()
        .and_then(|mut e| e.embed(&pcm).ok())
    {
        Some(neural) => neural,
        None => extract_mel_features(&pcm)
            .ok_or("clip too short for embedding")?
            .to_vec(),
    };

    db.save_voice_profile_with_embedding(name, &sample_path.to_string_lossy(), &embedding)
        .map_err(|e| e.to_string())?;

    db.upsert_speaker_label(&meeting_id, &speaker_key, name, None, Some("in-room"))
        .map_err(|e| e.to_string())?;

    Ok(())
}

/// Re-cluster the speaker labels on a meeting's transcript using mel
/// embeddings extracted from the full meeting WAV. Overwrites the existing
/// `speaker` field on each segment with stable per-meeting "Speaker N"
/// labels that reflect actual voice similarity rather than the
/// energy-change heuristic baked into streaming transcription.
///
/// Returns the number of distinct speakers detected. Intended to run after
/// recording completes and before the user names speakers in the
/// post-recording UI.
#[tauri::command]
pub async fn recluster_speakers(
    app: tauri::AppHandle,
    db: State<'_, Database>,
    meeting_id: String,
) -> Result<usize, String> {
    let wav_path = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("recordings")
        .join(format!("{}.wav", meeting_id));

    if !wav_path.exists() {
        return Err(format!("recording not found: {}", wav_path.display()));
    }

    // Neural diarization first (plan v3 rank 12): the speakrs pyannote
    // pipeline on CoreML. Any failure — models not yet downloaded, odd
    // audio — falls back to the mel clusterer, so re-detect never breaks.
    // Spans depend only on the audio, so the slow part runs ONCE; the
    // cheap segment assignment re-runs per CAS attempt below.
    let spans = tokio::task::spawn_blocking({
        let wav_path = wav_path.clone();
        move || -> Result<Vec<crate::audio::diarize::DiarSpan>, String> {
            let samples = crate::transcription::engine::wav_to_whisper_samples(&wav_path)
                .map_err(|e| e.to_string())?;
            crate::audio::diarize::diarize(&samples).map_err(|e| e.to_string())
        }
    })
    .await
    .map_err(|e| e.to_string())?;
    if let Err(e) = &spans {
        log::warn!("recluster: speakrs unavailable ({e}); using mel clustering");
    }

    // Diarization runs for minutes right when the accuracy pass and fresh
    // user edits are also writing segments (QA audit P2). An unconditional
    // write-back here could resurrect a superseded transcript — old text
    // with new speakers. Hash CAS, same as the pass: snapshot, assign,
    // swap only if untouched; one retry re-assigns onto fresh segments.
    for attempt in 0..2 {
        let (old_json, old_hash) = db
            .segments_snapshot(&meeting_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "no transcript for this meeting".to_string())?;
        let base: Vec<crate::transcription::whisper::TranscriptSegment> =
            serde_json::from_str(&old_json)
                .map_err(|e| format!("failed to parse segments: {}", e))?;
        if base.is_empty() {
            return Ok(0);
        }

        let (segments, cluster_count) = match &spans {
            Ok(spans) if !spans.is_empty() => {
                let (segments, n) =
                    crate::audio::diarize::assign_speakers_splitting(base, spans);
                if attempt == 0 {
                    log::info!(
                        "recluster: speakrs assigned {n} speakers over {} spans",
                        spans.len()
                    );
                }
                (segments, n)
            }
            _ => {
                let wav_path = wav_path.clone();
                tokio::task::spawn_blocking(move || -> Result<(Vec<crate::transcription::whisper::TranscriptSegment>, usize), String> {
                    let mut segments = base;
                    let n = crate::audio::cluster::recluster_segments_by_embedding(
                        &mut segments,
                        &wav_path,
                    )
                    .map_err(|e| e.to_string())?;
                    Ok((segments, n))
                })
                .await
                .map_err(|e| e.to_string())??
            }
        };

        let segments_json = serde_json::to_string(&segments)
            .map_err(|e| format!("failed to serialize segments: {}", e))?;
        let swapped = db
            .swap_segments_if_unchanged(&meeting_id, &old_hash, &segments_json)
            .map_err(|e| e.to_string())?;
        if !swapped {
            log::info!("recluster: transcript changed mid-detect for {meeting_id}; retrying");
            continue;
        }

        // The new "Speaker N" keys describe different groupings than the old
        // ones — labels tied to old keys would silently show the wrong names.
        if let Ok(n) = db.delete_speaker_labels_for_meeting(&meeting_id) {
            if n > 0 {
                log::info!("recluster: cleared {} stale speaker label(s)", n);
            }
        }
        return Ok(cluster_count);
    }
    Err("the transcript changed while re-detecting speakers — try again".to_string())
}

/// Speakers that name themselves (plan v10 #1) — the completion hook.
///
/// Runs strictly AFTER the accuracy pass resolves (swap, skip, or
/// disabled): `spawn_accuracy_pass` awaits its body and then this, so the
/// speaker keys written here land on the final segment boundaries and can
/// never fight the re-decode swap. Our own write uses the same hash-CAS
/// contract (`segments_snapshot` / `swap_segments_if_unchanged`) — a user
/// edit during diarization always wins, and then we also skip naming since
/// the keys would describe a segmentation that never landed.
///
/// Strictly local: skips silently when the speakrs models aren't in the
/// HF cache (never downloads — the explicit Re-detect button owns that),
/// matches only against user-created voice profiles (no auto-enrollment of
/// strangers), and everything stays on-device.
pub async fn auto_diarize_and_name(app: &AppHandle, meeting_id: &str) {
    let db = app.state::<Database>();
    if !auto_diarize_enabled(db.get_setting("auto_diarize").ok().flatten().as_deref()) {
        return;
    }
    if !crate::audio::diarize::models_present() {
        log::debug!("auto-diarize: speakrs models not downloaded; skipping {meeting_id}");
        return;
    }
    // The user can name speakers the moment recording stops — minutes
    // before this hook runs. Labels live in speaker_labels, NOT in the
    // segments JSON, so the hash-CAS below cannot protect them, and the
    // delete-after-rekey step would silently destroy every name just
    // assigned (QA audit P1). Names the user wrote always outrank names
    // we might infer: any existing label means hands off — the explicit
    // Re-detect button stays the path that re-keys a labeled meeting.
    if let Ok(labels) = db.list_speaker_labels_for_meeting(meeting_id) {
        if !labels.is_empty() {
            log::info!(
                "auto-diarize: {meeting_id} already has {} speaker label(s); skipping",
                labels.len()
            );
            return;
        }
    }
    // One heavy background job at a time (QA audit P3): the pass released
    // IMPORT_GATE when it returned, and another meeting's whisper decode
    // may now hold it — diarization (CoreML + full-WAV f32) queues behind
    // it rather than piling on.
    let _gate = crate::commands::import::IMPORT_GATE.lock().await;
    let Ok(Some((old_json, old_hash))) = db.segments_snapshot(meeting_id) else { return };
    let segments: Vec<crate::transcription::whisper::TranscriptSegment> =
        serde_json::from_str(&old_json).unwrap_or_default();
    if segments.is_empty() {
        return;
    }
    let wav_path = match app.path().app_data_dir() {
        Ok(d) => d.join("recordings").join(format!("{}.wav", meeting_id)),
        Err(_) => return,
    };
    if !wav_path.exists() {
        return;
    }

    let app2 = app.clone();
    let meeting_id2 = meeting_id.to_string();
    let result = tokio::task::spawn_blocking(move || -> Result<(), String> {
        let db = app2.state::<Database>();
        let samples = crate::transcription::engine::wav_to_whisper_samples(&wav_path)
            .map_err(|e| e.to_string())?;
        let (spans, centroids) =
            crate::audio::diarize::diarize_local(&samples).map_err(|e| e.to_string())?;
        if spans.is_empty() {
            return Err("no speech spans".into());
        }
        let (segments, n) = crate::audio::diarize::assign_speakers_splitting(segments, &spans);
        log::info!("auto-diarize: {n} speakers over {} spans for {meeting_id2}", spans.len());

        let new_json = serde_json::to_string(&segments).map_err(|e| e.to_string())?;
        match db.swap_segments_if_unchanged(&meeting_id2, &old_hash, &new_json) {
            Ok(true) => {}
            Ok(false) => return Err("segments changed during diarization; user edit wins".into()),
            Err(e) => return Err(e.to_string()),
        }
        // New "Speaker N" keys describe new groupings — old labels would
        // silently show wrong names (same contract as recluster_speakers).
        let _ = db.delete_speaker_labels_for_meeting(&meeting_id2);
        let _ = app2.emit(
            "transcript-upgraded",
            serde_json::json!({ "meeting_id": meeting_id2 }),
        );

        // Profile matching: auto-apply only above the strict threshold.
        // Between suggest and strict it stays a user-confirmed hint in the
        // Speakers panel (suggest_for_range computes those on demand).
        let mut embedder = match crate::audio::diarize::SpeakerEmbedder::try_new() {
            Some(e) => e,
            None => return Ok(()),
        };
        let profiles = neural_profiles(&db, &mut embedder);
        if profiles.is_empty() {
            return Ok(());
        }
        // Only name speakers that actually landed on a segment — a cluster
        // that never won max-overlap would otherwise get a phantom label.
        let used_keys: std::collections::HashSet<&str> =
            segments.iter().filter_map(|s| s.speaker.as_deref()).collect();
        let mut named: Vec<AutoNamedSpeaker> = Vec::new();
        for (speaker_key, centroid) in &centroids {
            if !used_keys.contains(speaker_key.as_str()) {
                continue;
            }
            let Some((name, sim)) = auto_apply_match(centroid, &profiles) else { continue };
            match db.upsert_speaker_label(&meeting_id2, speaker_key, &name, None, Some("in-room")) {
                Ok(label) => {
                    log::info!(
                        "auto-diarize: named {speaker_key} \"{name}\" (cosine {sim:.3})"
                    );
                    named.push(AutoNamedSpeaker {
                        speaker_key: speaker_key.clone(),
                        display_name: name,
                        label_id: label.id,
                        similarity: sim,
                    });
                }
                Err(e) => log::warn!("auto-diarize: labeling {speaker_key} failed: {e}"),
            }
        }
        if !named.is_empty() {
            let _ = app2.emit("speakers-auto-named", auto_named_payload(&meeting_id2, &named));
        }
        Ok(())
    })
    .await;

    match result {
        Ok(Ok(())) => {}
        Ok(Err(e)) => log::info!("auto-diarize skipped for {meeting_id}: {e}"),
        Err(e) => log::warn!("auto-diarize task panicked for {meeting_id}: {e}"),
    }
}

/// Return the absolute filesystem path for a meeting's recording WAV.
/// The JS side converts this to an asset-protocol URL via convertFileSrc.
#[tauri::command]
pub fn get_recording_url(
    app: tauri::AppHandle,
    meeting_id: String,
) -> Result<String, String> {
    let path = app.path().app_data_dir().map_err(|e| e.to_string())?
        .join("recordings")
        .join(format!("{}.wav", meeting_id));
    if !path.exists() {
        return Err("recording not found".to_string());
    }
    Ok(path.to_string_lossy().to_string())
}

// ── Private helpers ───────────────────────────────────────────────────────────

/// Suggest a profile name for `[start_ms, end_ms)` of the recording.
/// Neural path (wespeaker embedding + plain cosine) when the embedder is
/// available; mel z-norm matching otherwise — the research-documented
/// weakness this replaces: diarization was neural but matching was mel.
fn suggest_for_range(
    db: &Database,
    wav_path: &std::path::Path,
    start_ms: u64,
    end_ms: u64,
    embedder: &mut Option<crate::audio::diarize::SpeakerEmbedder>,
    neural_profiles: &[(String, Vec<f32>)],
) -> anyhow::Result<(Option<String>, Option<f32>)> {
    let (mono, sr) = load_wav_as_mono_f32(wav_path)?;
    let from = ((start_ms as f64 / 1000.0) * sr as f64) as usize;
    let to = ((end_ms as f64 / 1000.0) * sr as f64).min(mono.len() as f64) as usize;
    if from >= to { return Ok((None, None)); }
    let slice = &mono[from..to];

    let pcm_16k: Vec<f32> = if sr == 16_000 {
        slice.to_vec()
    } else {
        crate::audio::clip::resample_linear_public(slice, sr, 16_000)
    };

    if let Some(e) = embedder.as_mut() {
        if let Ok(query) = e.embed(&pcm_16k) {
            return Ok(match best_neural_match(&query, neural_profiles) {
                Some((name, sim)) if sim >= NEURAL_SUGGEST_THRESHOLD => (Some(name), Some(sim)),
                _ => (None, None),
            });
        }
        // Clip too short / inference hiccup — fall through to mel.
    }

    let Some(emb) = extract_mel_features(&pcm_16k) else {
        return Ok((None, None));
    };
    match db.match_voice_profile(&emb, VOICE_MATCH_THRESHOLD)? {
        Some((name, sim)) => Ok((Some(name), Some(sim))),
        None => Ok((None, None)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn prof(name: &str, emb: &[f32]) -> (String, Vec<f32>) {
        (name.to_string(), emb.to_vec())
    }

    #[test]
    fn auto_diarize_defaults_on_and_only_false_disables() {
        assert!(auto_diarize_enabled(None));
        assert!(auto_diarize_enabled(Some("true")));
        assert!(auto_diarize_enabled(Some("")));
        assert!(!auto_diarize_enabled(Some("false")));
    }

    #[test]
    fn best_neural_match_picks_highest_cosine() {
        let profiles = vec![
            prof("Amy", &[1.0, 0.0]),
            prof("Bob", &[0.0, 1.0]),
            prof("Cat", &[0.7071, 0.7071]),
        ];
        let (name, sim) = best_neural_match(&[0.9, 0.1], &profiles).unwrap();
        assert_eq!(name, "Amy");
        assert!(sim > 0.97, "near-aligned vectors, got {sim}");
    }

    #[test]
    fn best_neural_match_skips_mismatched_dims_and_empty() {
        // A 64-dim mel row in the table must never match a 2-dim query.
        let profiles = vec![prof("MelLegacy", &vec![1.0; 64]), prof("Amy", &[1.0, 0.0])];
        let (name, _) = best_neural_match(&[1.0, 0.0], &profiles).unwrap();
        assert_eq!(name, "Amy");

        assert!(best_neural_match(&[], &profiles).is_none(), "empty query");
        assert!(best_neural_match(&[1.0, 0.0], &[]).is_none(), "no profiles");
    }

    #[test]
    fn strict_threshold_blocks_dissimilar_voices() {
        // The hook's two-tier decision: a match in the suggest band must
        // never auto-apply, but stays available as a hint. 60° → cos 0.5.
        let profiles = vec![prof("Amy", &[1.0, 0.0])];
        let (_, sim) = best_neural_match(&[0.5, 0.866], &profiles).unwrap();
        assert!(sim < NEURAL_AUTO_APPLY_THRESHOLD, "suggest-band match must not auto-apply");
        assert!(sim >= NEURAL_SUGGEST_THRESHOLD - 1e-4, "but it may still be suggested");
        assert!(auto_apply_match(&[0.5, 0.866], &profiles).is_none());
    }

    #[test]
    fn auto_apply_requires_strict_threshold() {
        let profiles = vec![prof("Amy", &[1.0, 0.0])];
        // 45° apart: cosine ≈ 0.707 — just above 0.70, auto-applies alone.
        let hit = auto_apply_match(&[0.7071, 0.7071], &profiles);
        assert_eq!(hit.unwrap().0, "Amy");
        // 60° apart: cosine 0.5 — suggestion territory, never auto.
        assert!(auto_apply_match(&[0.5, 0.8660], &profiles).is_none());
        assert!(auto_apply_match(&[], &profiles).is_none());
        assert!(auto_apply_match(&[1.0, 0.0], &[]).is_none());
    }

    #[test]
    fn auto_apply_blocks_ambiguous_runner_up() {
        // Both profiles clear the threshold but within the margin of each
        // other — ambiguity must stay a suggestion.
        let profiles = vec![
            prof("Amy", &[1.0, 0.0]),
            prof("Bob", &[0.9994, 0.0349]), // ~2° away from Amy
        ];
        assert!(
            auto_apply_match(&[1.0, 0.0], &profiles).is_none(),
            "near-tie between different names must not auto-apply"
        );

        // Same-name duplicates must NOT trigger the margin rule.
        let dupes = vec![
            prof("Amy", &[1.0, 0.0]),
            prof("Amy", &[0.9994, 0.0349]),
        ];
        let (name, sim) = auto_apply_match(&[1.0, 0.0], &dupes).unwrap();
        assert_eq!(name, "Amy");
        assert!(sim > 0.99);
    }

    #[test]
    fn needs_neural_reembed_decisions() {
        assert!(needs_neural_reembed(None), "no cache → embed");
        assert!(needs_neural_reembed(Some("not json")), "garbage → embed");
        assert!(needs_neural_reembed(Some("[]")), "empty → embed");
        let mel = serde_json::to_string(&vec![0.5_f32; crate::audio::mel::MEL_BINS]).unwrap();
        assert!(needs_neural_reembed(Some(&mel)), "legacy 64-dim mel → re-embed");
        assert!(
            needs_neural_reembed(Some("[1.0, null]")),
            "non-numeric → embed"
        );
        let neural = serde_json::to_string(&vec![0.1_f32; 256]).unwrap();
        assert!(!needs_neural_reembed(Some(&neural)), "cached neural → reuse");
    }

    #[test]
    fn auto_named_payload_shape_matches_frontend_listener() {
        let named = vec![AutoNamedSpeaker {
            speaker_key: "Speaker 1".into(),
            display_name: "Amy".into(),
            label_id: "lbl-123".into(),
            similarity: 0.91,
        }];
        let p = auto_named_payload("meeting-9", &named);
        assert_eq!(p["meeting_id"], "meeting-9");
        let n = &p["named"][0];
        assert_eq!(n["speaker_key"], "Speaker 1");
        assert_eq!(n["display_name"], "Amy");
        assert_eq!(n["label_id"], "lbl-123");
        assert!((n["similarity"].as_f64().unwrap() - 0.91).abs() < 1e-6);
        assert_eq!(p["named"].as_array().unwrap().len(), 1);
    }

    /// Caching contract: a profile re-embedded once is served from the row
    /// afterwards (needs_neural_reembed flips false on the stored JSON).
    #[test]
    fn reembed_cache_round_trip_via_db() {
        let db = Database::new_in_memory().unwrap();
        let p = db.create_voice_profile("Amy", "/nonexistent.wav").unwrap();
        let rows = db.list_voice_profiles_with_embeddings().unwrap();
        assert!(needs_neural_reembed(rows[0].3.as_deref()));

        let fake_neural = vec![0.05_f32; 256];
        db.update_voice_profile_embedding(&p.id, &fake_neural).unwrap();
        let rows = db.list_voice_profiles_with_embeddings().unwrap();
        assert!(!needs_neural_reembed(rows[0].3.as_deref()), "cached → no re-embed");
    }
}
