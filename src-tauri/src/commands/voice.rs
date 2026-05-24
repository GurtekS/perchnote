use tauri::{AppHandle, Manager, State};
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
    pub longest_start_ms: u64,
    pub longest_end_ms: u64,
    pub total_seconds: u64,
    /// Best-match suggestion from existing voice profiles, if any.
    pub suggested_name: Option<String>,
    pub suggested_similarity: Option<f32>,
}

/// Voice-match threshold. Empirically tuned for our mel-feature extractor.
const VOICE_MATCH_THRESHOLD: f32 = 0.78;

/// Returns each speaker_key in the transcript that doesn't yet have a
/// speaker_labels row, paired with the longest segment range, total talk
/// time, and an optional voice-match suggestion.
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

    // Labeled speaker_keys for this meeting (skip them). Scoped per-meeting
    // since migration 11 — naming "Speaker 1" in another meeting no longer
    // pre-labels "Speaker 1" here.
    let labeled: std::collections::HashSet<String> = db
        .list_speaker_labels_for_meeting(&meeting_id)
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|l| l.speaker_key)
        .collect();

    // For each unlabeled speaker, accumulate total talk time + track longest segment.
    use std::collections::HashMap;
    let mut totals: HashMap<String, u64> = HashMap::new();
    let mut longest: HashMap<String, (u64, u64)> = HashMap::new();
    for s in &segments {
        let Some(key) = &s.speaker else { continue };
        if labeled.contains(key) { continue; }
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

    let mut out = Vec::with_capacity(keys.len());
    for key in keys {
        let &(start_ms, end_ms) = longest.get(&key).unwrap();
        let (suggested_name, suggested_similarity) = if wav_path.exists() {
            suggest_for_range(&db, &wav_path, start_ms, end_ms).unwrap_or((None, None))
        } else {
            (None, None)
        };
        out.push(UnknownSpeaker {
            speaker_key: key.clone(),
            longest_start_ms: start_ms,
            longest_end_ms: end_ms,
            total_seconds: totals.get(&key).copied().unwrap_or(0),
            suggested_name,
            suggested_similarity,
        });
    }
    Ok(out)
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
    let embedding = extract_mel_features(&pcm).ok_or("clip too short for embedding")?;

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
pub fn recluster_speakers(
    app: tauri::AppHandle,
    db: State<'_, Database>,
    meeting_id: String,
) -> Result<usize, String> {
    let transcript = db
        .get_transcript_by_meeting(&meeting_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "no transcript for this meeting".to_string())?;

    let mut segments: Vec<crate::transcription::whisper::TranscriptSegment> =
        serde_json::from_str(&transcript.segments)
            .map_err(|e| format!("failed to parse segments: {}", e))?;

    if segments.is_empty() {
        return Ok(0);
    }

    let wav_path = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("recordings")
        .join(format!("{}.wav", meeting_id));

    if !wav_path.exists() {
        return Err(format!("recording not found: {}", wav_path.display()));
    }

    let cluster_count = crate::audio::cluster::recluster_segments_by_embedding(
        &mut segments,
        &wav_path,
    )
    .map_err(|e| e.to_string())?;

    let segments_json = serde_json::to_string(&segments)
        .map_err(|e| format!("failed to serialize segments: {}", e))?;
    db.update_transcript_segments(&transcript.id, &segments_json)
        .map_err(|e| e.to_string())?;

    Ok(cluster_count)
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

fn suggest_for_range(
    db: &Database,
    wav_path: &std::path::Path,
    start_ms: u64,
    end_ms: u64,
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

    let Some(emb) = extract_mel_features(&pcm_16k) else {
        return Ok((None, None));
    };
    match db.match_voice_profile(&emb, VOICE_MATCH_THRESHOLD)? {
        Some((name, sim)) => Ok((Some(name), Some(sim))),
        None => Ok((None, None)),
    }
}
