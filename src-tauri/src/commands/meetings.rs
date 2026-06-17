use tauri::{AppHandle, Emitter, Manager, State};
use crate::db::Database;
use crate::db::queries::{Meeting, SpeakerLabel, MeetingLink, StorageStats};
use super::settings::validate_uuid;

#[tauri::command]
pub fn create_meeting(db: State<'_, Database>, title: String) -> Result<Meeting, String> {
    db.create_meeting(&title).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_meeting(db: State<'_, Database>, id: String) -> Result<Option<Meeting>, String> {
    db.get_meeting(&id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_meetings(db: State<'_, Database>) -> Result<Vec<Meeting>, String> {
    db.list_meetings().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_meeting_title(
    db: State<'_, Database>,
    id: String,
    title: String,
) -> Result<(), String> {
    db.update_meeting_title(&id, &title).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_meeting_metadata(
    db: State<'_, Database>,
    id: String,
    scheduled_start: Option<String>,
    scheduled_end: Option<String>,
    location: Option<String>,
    attendees: Option<String>,
) -> Result<(), String> {
    db.update_meeting_metadata(
        &id,
        scheduled_start.as_deref(),
        scheduled_end.as_deref(),
        location.as_deref(),
        attendees.as_deref(),
    ).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_meeting_status(
    app: AppHandle,
    db: State<'_, Database>,
    id: String,
    status: String,
) -> Result<(), String> {
    db.update_meeting_status(&id, &status).map_err(|e| e.to_string())?;
    // A meeting reaching "complete" has its final transcript.
    if status == "complete" {
        run_completion_side_effects(app, id);
    }
    Ok(())
}

/// Everything that should happen once a meeting's transcript is final:
/// instant-recap eligibility (the frontend runs the actual enhance flow)
/// and semantic indexing. Called by the transcription-drain path in
/// stop_recording's pipeline — the status command above has no frontend
/// callers, which is how instant recap shipped dead (friction audit #1).
pub fn run_completion_side_effects(app: AppHandle, id: String) {
    tauri::async_runtime::spawn(async move {
        // Self-titling: a meeting created without a real title names itself
        // from the transcript. Awaited BEFORE instant recap so the enhance
        // auto-mirror is born under the final filename instead of being
        // renamed one save later. Placeholder-scoped + CAS — a user-typed
        // title is never touched.
        super::autotitle::autotitle_on_complete(&app, &id).await;

        let db = app.state::<Database>();

        // Instant recap (plan v3 rank 2, Fathom's most-loved trait):
        // enhance automatically so the notes are waiting without a
        // click. The frontend runs the actual flow (it owns the TipTap
        // conversion); this just decides eligibility.
        let auto_on = db
            .get_setting("auto_enhance_on_complete")
            .ok()
            .flatten()
            .as_deref()
            != Some("false");
        let has_transcript = db
            .get_transcript_by_meeting(&id)
            .ok()
            .flatten()
            .map(|t| t.segments.trim().len() > 2) // "[]" = empty
            .unwrap_or(false);
        let already_enhanced = db
            .get_note_by_meeting(&id)
            .ok()
            .flatten()
            .and_then(|n| n.generated_content)
            .map(|g| !g.trim().is_empty())
            .unwrap_or(false);
        if auto_on && has_transcript && !already_enhanced && crate::ai::is_configured(&db) {
            let _ = app.emit("auto-enhance", serde_json::json!({ "meeting_id": id }));
            log::info!("instant recap: auto-enhance requested for {id}");
        }

        match crate::ai::embeddings::index_meeting(&db, &id).await {
            Ok(n) if n > 0 => log::info!("semantic recall: indexed {n} segments for {id}"),
            Ok(_) => {}
            Err(e) => log::warn!("semantic recall: indexing {id} failed: {e}"),
        }
    });
}

/// Hard-delete a meeting and its on-disk artifacts. The recording WAV and
/// attachment files hold the most sensitive data — leaving them behind after
/// the row is gone means "deleted" audio silently persists forever. Shared
/// by the per-meeting command, Empty Trash, and the trash-retention sweep.
fn hard_delete(app: &AppHandle, db: &Database, id: &str) -> Result<(), String> {
    db.delete_meeting(id).map_err(|e| e.to_string())?;

    if let Ok(app_data) = app.path().app_data_dir() {
        let wav = app_data.join("recordings").join(format!("{}.wav", id));
        if wav.exists() {
            if let Err(e) = std::fs::remove_file(&wav) {
                log::warn!("could not delete recording for {}: {}", id, e);
            }
        }
        let attachments = app_data.join("attachments").join(id);
        if attachments.exists() {
            if let Err(e) = std::fs::remove_dir_all(&attachments) {
                log::warn!("could not delete attachments for {}: {}", id, e);
            }
        }
    }
    // Mirror lifecycle (plan v8 B2): hard delete takes the vault .md too —
    // soft delete (trash) deliberately leaves it in place.
    super::settings::remove_mirror_on_hard_delete(app, db, id);
    // Per-meeting settings crumbs (whole-app review P3): keep_audio:{id}
    // rows accumulated forever.
    let _ = db.delete_setting(&format!("keep_audio:{id}"));
    Ok(())
}

/// A recording shorter than this captured no real audio — a mis-click
/// (record → immediately stop) or a capture that never produced samples.
/// The mixer fills silence to keep the timeline, so an intentionally quiet
/// meeting still has full duration and is never caught here; this is strictly
/// the "nothing came through" floor.
const MIN_RECORDING_AUDIO_MS: u64 = 1_000;

/// Discard a just-stopped recording that captured no audio AND holds nothing
/// the user would miss — no transcript, no typed notes, no generated notes.
///
/// A meeting row is created at record start, so a mis-click or a failed
/// capture would otherwise leave an empty turd in the list. Deliberately
/// created notes-only meetings never reach this path (they are never
/// recorded, so stop_recording never runs for them). Returns true if the
/// meeting was discarded.
///
/// The audio-duration gate is the primary guard: if anything was captured we
/// keep the meeting even when transcription was off (no segments) — there's a
/// real recording to re-transcribe. The transcript/notes checks are belt-and-
/// suspenders against a near-empty WAV that somehow carries content.
pub fn discard_if_empty_recording(
    app: &AppHandle,
    db: &Database,
    meeting_id: &str,
    wav_path: Option<&std::path::Path>,
) -> bool {
    let audio_ms = wav_path
        .and_then(super::audio::wav_duration_ms)
        .unwrap_or(0);
    // Cheap audio gate first — only read the DB when there's plausibly
    // nothing to keep.
    if audio_ms >= MIN_RECORDING_AUDIO_MS {
        return false;
    }
    let segments = db
        .get_transcript_by_meeting(meeting_id)
        .ok()
        .flatten()
        .map(|t| t.segments);
    let note = db.get_note_by_meeting(meeting_id).ok().flatten();
    let raw = note.as_ref().and_then(|n| n.raw_content.as_deref());
    let generated = note.as_ref().and_then(|n| n.generated_content.as_deref());

    if !recording_is_empty(audio_ms, segments.as_deref(), raw, generated) {
        return false;
    }

    if let Err(e) = hard_delete(app, db, meeting_id) {
        log::warn!("discard empty recording {meeting_id} failed: {e}");
        return false;
    }
    log::info!("discarded empty recording {meeting_id} ({audio_ms}ms audio, no transcript/notes)");
    let _ = app.emit(
        "meeting-discarded",
        serde_json::json!({ "meeting_id": meeting_id }),
    );
    true
}

/// Pure emptiness decision (separated for testing without an AppHandle): a
/// recording is empty when it captured under the audio floor AND has no
/// transcribed speech AND no typed-or-generated notes. The audio gate is the
/// real guard — any captured audio keeps the meeting even with transcription
/// off; the content checks defend against a near-empty WAV that somehow holds
/// notes the user typed.
fn recording_is_empty(
    audio_ms: u64,
    segments_json: Option<&str>,
    raw_content: Option<&str>,
    generated_content: Option<&str>,
) -> bool {
    if audio_ms >= MIN_RECORDING_AUDIO_MS {
        return false;
    }
    let has_segments = segments_json
        .and_then(|s| {
            serde_json::from_str::<Vec<crate::transcription::whisper::TranscriptSegment>>(s).ok()
        })
        .map(|segs| segs.iter().any(|s| !s.text.trim().is_empty()))
        .unwrap_or(false);
    if has_segments {
        return false;
    }
    let has_notes = raw_content
        .map(|r| !crate::db::queries::plain_text_of_tiptap(r).trim().is_empty())
        .unwrap_or(false)
        || generated_content
            .map(|g| !g.trim().is_empty())
            .unwrap_or(false);
    !has_notes
}

/// Refuse destructive ops against the meeting that is recording RIGHT NOW
/// (whole-app review P2): the sidebar delete had no guard, and an
/// empty-trash afterwards unlinked the WAV the mixer was writing into —
/// the whole recording vanished at stop with "Recording saved" still shown.
fn guard_not_recording(app: &AppHandle, id: &str) -> Result<(), String> {
    let state = app.state::<crate::AppState>();
    let active = state
        .recording
        .lock()
        .ok()
        .filter(|r| r.is_recording)
        .and_then(|r| r.meeting_id.clone());
    if active.as_deref() == Some(id) {
        return Err("This meeting is recording. Stop the recording first.".to_string());
    }
    Ok(())
}

#[tauri::command]
pub fn delete_meeting(app: AppHandle, db: State<'_, Database>, id: String) -> Result<(), String> {
    validate_uuid(&id)?;
    guard_not_recording(&app, &id)?;
    hard_delete(&app, &db, &id)
}

/// One command for the whole trash (the old frontend looped per meeting).
/// Compacts afterwards when the purge left the file noticeably fragmented.
/// Async + spawn_blocking: VACUUM holds the connection mutex for its whole
/// run, and a sync command would also pin the IPC dispatch thread
/// (QA audit finding 8). Compaction is skipped while recording — segment
/// appends must never stall behind it.
#[tauri::command]
pub async fn empty_trash(app: AppHandle) -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let db = app.state::<Database>();
        let deleted = db.list_deleted_meetings().map_err(|e| e.to_string())?;
        let mut n = 0;
        let mut failed = 0;
        for m in &deleted {
            if hard_delete(&app, &db, &m.id).is_ok() {
                n += 1;
            } else {
                failed += 1;
            }
        }
        if failed > 0 {
            log::warn!("empty trash: {failed} meeting(s) could not be removed");
        }
        let recording = app
            .state::<crate::AppState>()
            .recording
            .lock()
            .map(|r| r.is_recording)
            .unwrap_or(false);
        if n > 0 && !recording {
            if let Ok(true) = db.vacuum_if_fragmented() {
                log::info!("compacted database after emptying trash");
            }
        }
        Ok(n)
    })
    .await
    .map_err(|e| format!("empty trash task failed: {e}"))?
}

/// Opt-in trash auto-empty (plan v7 #20, default Never): hard-deletes
/// meetings the USER already trashed once they've sat in the trash longer
/// than `trash_retention_days`. Notes/transcripts go too — the dialog and
/// settings copy say so explicitly; that's what trashing means here.
pub fn run_trash_retention(app: &AppHandle) -> usize {
    let db = app.state::<Database>();
    let days: i64 = match db
        .get_setting("trash_retention_days")
        .ok()
        .flatten()
        .and_then(|s| s.parse().ok())
    {
        Some(d) if d > 0 => d,
        _ => return 0,
    };
    let cutoff = (chrono::Utc::now() - chrono::Duration::days(days)).to_rfc3339();
    let Ok(deleted) = db.list_deleted_meetings() else { return 0 };
    let mut n = 0;
    for m in &deleted {
        let old_enough = m.deleted_at.as_deref().is_some_and(|d| d < cutoff.as_str());
        if old_enough && hard_delete(app, &db, &m.id).is_ok() {
            n += 1;
        }
    }
    if n > 0 {
        log::info!("trash retention: permanently removed {n} meeting(s) trashed >{days}d ago");
        let _ = db.vacuum_if_fragmented();
    }
    n
}

#[tauri::command]
pub fn soft_delete_meeting(
    app: AppHandle,
    db: State<'_, Database>,
    id: String,
) -> Result<(), String> {
    guard_not_recording(&app, &id)?;
    db.soft_delete_meeting(&id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn restore_meeting(db: State<'_, Database>, id: String) -> Result<(), String> {
    db.restore_meeting(&id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn toggle_pin_meeting(db: State<'_, Database>, id: String) -> Result<bool, String> {
    db.toggle_pin_meeting(&id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn archive_meeting(db: State<'_, Database>, id: String) -> Result<(), String> {
    db.archive_meeting(&id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn unarchive_meeting(db: State<'_, Database>, id: String) -> Result<(), String> {
    db.unarchive_meeting(&id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_archived_meetings(db: State<'_, Database>) -> Result<Vec<Meeting>, String> {
    db.list_archived_meetings().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_deleted_meetings(db: State<'_, Database>) -> Result<Vec<Meeting>, String> {
    db.list_deleted_meetings().map_err(|e| e.to_string())
}

// --- Speaker Labels ---

#[tauri::command]
pub fn upsert_speaker_label(
    db: State<'_, Database>,
    meeting_id: String,
    speaker_key: String,
    display_name: String,
    color: Option<String>,
    participant_type: Option<String>,
) -> Result<SpeakerLabel, String> {
    db.upsert_speaker_label(&meeting_id, &speaker_key, &display_name, color.as_deref(), participant_type.as_deref())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_speaker_labels(db: State<'_, Database>) -> Result<Vec<SpeakerLabel>, String> {
    db.list_speaker_labels().map_err(|e| e.to_string())
}

/// Speaker labels for one meeting. Excludes legacy NULL-meeting rows.
#[tauri::command]
pub fn list_speaker_labels_for_meeting(
    db: State<'_, Database>,
    meeting_id: String,
) -> Result<Vec<SpeakerLabel>, String> {
    db.list_speaker_labels_for_meeting(&meeting_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_speaker_label(db: State<'_, Database>, id: String) -> Result<(), String> {
    db.delete_speaker_label(&id).map_err(|e| e.to_string())
}

// --- Meeting Links ---

#[tauri::command]
pub fn link_meetings(
    db: State<'_, Database>,
    source_id: String,
    target_id: String,
    link_type: Option<String>,
) -> Result<MeetingLink, String> {
    db.link_meetings(&source_id, &target_id, &link_type.unwrap_or_else(|| "related".to_string())).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn unlink_meetings(
    db: State<'_, Database>,
    source_id: String,
    target_id: String,
) -> Result<(), String> {
    db.unlink_meetings(&source_id, &target_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_linked_meetings(db: State<'_, Database>, meeting_id: String) -> Result<Vec<MeetingLink>, String> {
    db.get_linked_meetings(&meeting_id).map_err(|e| e.to_string())
}

// --- Storage / Backup ---

#[tauri::command]
pub fn get_storage_stats(db: State<'_, Database>) -> Result<StorageStats, String> {
    db.get_storage_stats().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_note_previews(
    db: State<'_, Database>,
) -> Result<Vec<crate::db::queries::NotePreview>, String> {
    db.list_note_previews().map_err(|e| e.to_string())
}

// --- Storage truth + audio retention (plan v7 lifetime 15-16) ---
//
// The database is a rounding error next to the WAVs (~175MB per
// meeting-hour); the old "Total storage" tile counted only SQLite while
// recordings, attachments, and daily backups stayed invisible.

#[derive(serde::Serialize)]
pub struct LargeRecording {
    pub meeting_id: String,
    pub title: String,
    pub bytes: u64,
    pub date: Option<String>,
    /// Exempt from the retention sweep ("keep_audio:<id>" setting row).
    pub keep: bool,
}

#[derive(serde::Serialize)]
pub struct StorageBreakdown {
    pub db_bytes: u64,
    pub recordings_bytes: u64,
    pub attachments_bytes: u64,
    pub backups_bytes: u64,
    /// Largest recordings first, top 10.
    pub largest: Vec<LargeRecording>,
}

fn dir_size_recursive(dir: &std::path::Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(dir) else { return 0 };
    entries
        .flatten()
        .map(|e| {
            let p = e.path();
            if p.is_dir() {
                dir_size_recursive(&p)
            } else {
                e.metadata().map(|m| m.len()).unwrap_or(0)
            }
        })
        .sum()
}

#[tauri::command]
pub fn get_storage_breakdown(
    app: AppHandle,
    db: State<'_, Database>,
) -> Result<StorageBreakdown, String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let recordings_dir = data_dir.join("recordings");

    let meta = db.meeting_audio_index().map_err(|e| e.to_string())?;
    let by_id: std::collections::HashMap<&str, (&str, &Option<String>)> = meta
        .iter()
        .map(|(id, title, date, _status)| (id.as_str(), (title.as_str(), date)))
        .collect();

    let mut recordings_bytes = 0u64;
    let mut largest: Vec<LargeRecording> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&recordings_dir) {
        for e in entries.flatten() {
            let path = e.path();
            if path.extension().and_then(|x| x.to_str()) != Some("wav") {
                continue;
            }
            let bytes = e.metadata().map(|m| m.len()).unwrap_or(0);
            recordings_bytes += bytes;
            let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
            let (title, date) = by_id
                .get(stem)
                .map(|(t, d)| (t.to_string(), (*d).clone()))
                .unwrap_or_else(|| ("(deleted meeting)".to_string(), None));
            let keep = db
                .get_setting(&format!("keep_audio:{stem}"))
                .ok()
                .flatten()
                .as_deref()
                == Some("true");
            largest.push(LargeRecording { meeting_id: stem.to_string(), title, bytes, date, keep });
        }
    }
    largest.sort_by(|a, b| b.bytes.cmp(&a.bytes));
    largest.truncate(10);

    Ok(StorageBreakdown {
        db_bytes: db.get_storage_stats().map(|s| s.db_size_bytes).unwrap_or(0),
        recordings_bytes,
        attachments_bytes: dir_size_recursive(&data_dir.join("attachments")),
        backups_bytes: dir_size_recursive(&data_dir.join("backups")),
        largest,
    })
}

/// WAVs the retention policy would reclaim right now: complete meetings
/// older than `days`, minus per-meeting keeps. Shared by the preview
/// command and the real sweep so they can never disagree.
fn retention_candidates(
    app: &AppHandle,
    days: i64,
) -> Vec<(std::path::PathBuf, u64)> {
    let db = app.state::<Database>();
    let Ok(data_dir) = app.path().app_data_dir() else { return Vec::new() };
    let recordings_dir = data_dir.join("recordings");
    let cutoff = chrono::Utc::now() - chrono::Duration::days(days);
    let cutoff = cutoff.to_rfc3339();

    let Ok(meta) = db.meeting_audio_index() else { return Vec::new() };
    let mut out = Vec::new();
    for (id, _title, date, status) in &meta {
        if status != "complete" {
            continue; // never touch in-flight meetings
        }
        let Some(d) = date else { continue };
        if d.as_str() >= cutoff.as_str() {
            continue;
        }
        let kept = db
            .get_setting(&format!("keep_audio:{id}"))
            .ok()
            .flatten()
            .as_deref()
            == Some("true");
        if kept {
            continue;
        }
        let path = recordings_dir.join(format!("{id}.wav"));
        if let Ok(m) = std::fs::metadata(&path) {
            out.push((path, m.len()));
        }
    }
    out
}

#[derive(serde::Serialize)]
pub struct RetentionPreview {
    pub files: usize,
    pub bytes: u64,
}

/// "Enabling 90 days would free ~X GB" — computed before the user commits.
#[tauri::command]
pub fn preview_audio_retention(app: AppHandle, days: i64) -> RetentionPreview {
    let candidates = retention_candidates(&app, days);
    RetentionPreview {
        files: candidates.len(),
        bytes: candidates.iter().map(|(_, b)| b).sum(),
    }
}

/// The sweep: deletes ONLY audio files — never rows, notes, or
/// transcripts — and only for complete meetings past the opt-in window.
/// Runs at startup and daily (lib.rs). Returns (files, bytes) freed.
pub fn run_audio_retention(app: &AppHandle) -> (usize, u64) {
    let db = app.state::<Database>();
    let days: i64 = match db
        .get_setting("audio_retention_days")
        .ok()
        .flatten()
        .and_then(|s| s.parse().ok())
    {
        Some(d) if d > 0 => d,
        _ => return (0, 0), // off (default)
    };
    let mut files = 0usize;
    let mut bytes = 0u64;
    for (path, len) in retention_candidates(app, days) {
        if std::fs::remove_file(&path).is_ok() {
            files += 1;
            bytes += len;
        }
    }
    if files > 0 {
        log::info!(
            "audio retention: removed {files} recording(s) older than {days}d, freed {} MB (transcripts and notes untouched)",
            bytes / (1024 * 1024)
        );
    }
    (files, bytes)
}

/// Per-meeting exemption pin for the retention sweep.
#[tauri::command]
pub fn set_audio_keep(db: State<'_, Database>, id: String, keep: bool) -> Result<(), String> {
    validate_uuid(&id)?;
    db.set_setting(&format!("keep_audio:{id}"), if keep { "true" } else { "" })
        .map_err(|e| e.to_string())
}

/// "Delete audio only" — reclaims the WAV while the meeting, notes, and
/// transcript stay. Refused while that meeting is actively recording.
#[tauri::command]
pub fn delete_meeting_audio(
    app: AppHandle,
    state: State<'_, crate::AppState>,
    id: String,
) -> Result<u64, String> {
    validate_uuid(&id)?;
    if let Ok(rec) = state.recording.lock() {
        if rec.is_recording && rec.meeting_id.as_deref() == Some(id.as_str()) {
            return Err("This meeting is recording right now.".into());
        }
    }
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let path = data_dir.join("recordings").join(format!("{id}.wav"));
    let bytes = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    std::fs::remove_file(&path).map_err(|e| format!("Couldn't delete the audio file: {e}"))?;
    Ok(bytes)
}

#[tauri::command]
pub fn export_all_data(db: State<'_, Database>) -> Result<String, String> {
    db.export_all_data().map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::recording_is_empty;

    // A tiptap doc whose paragraphs hold the given texts.
    fn doc(texts: &[&str]) -> String {
        let content: Vec<_> = texts
            .iter()
            .map(|t| {
                serde_json::json!({
                    "type": "paragraph",
                    "content": [{ "type": "text", "text": t }],
                })
            })
            .collect();
        serde_json::json!({ "type": "doc", "content": content }).to_string()
    }

    fn segs(texts: &[&str]) -> String {
        let v: Vec<_> = texts
            .iter()
            .enumerate()
            .map(|(i, t)| {
                serde_json::json!({
                    "text": t,
                    "start_ms": i as u64 * 1000,
                    "end_ms": i as u64 * 1000 + 900,
                })
            })
            .collect();
        serde_json::to_string(&v).unwrap()
    }

    #[test]
    fn empty_recording_is_discarded() {
        // No audio, empty transcript "[]", empty notes doc.
        assert!(recording_is_empty(0, Some("[]"), Some(&doc(&[])), None));
        // No audio, no transcript row, no note row at all.
        assert!(recording_is_empty(0, None, None, None));
        // Just under the audio floor with whitespace-only notes.
        assert!(recording_is_empty(999, Some("[]"), Some(&doc(&["   "])), Some("")));
    }

    #[test]
    fn captured_audio_is_always_kept() {
        // At/over the floor → kept regardless of empty transcript/notes
        // (transcription may simply have been off — there's a real recording).
        assert!(!recording_is_empty(1000, Some("[]"), None, None));
        assert!(!recording_is_empty(600_000, None, None, None));
    }

    #[test]
    fn transcribed_speech_is_kept_even_with_no_audio_read() {
        // Defensive: a WAV that read short but the transcript has real text.
        assert!(!recording_is_empty(0, Some(&segs(&["Okay let's begin"])), None, None));
        // Blank-only segments don't count as content.
        assert!(recording_is_empty(0, Some(&segs(&["  ", ""])), None, None));
    }

    #[test]
    fn typed_or_generated_notes_are_kept() {
        // The mic blipped (no audio) but the user had typed a note.
        assert!(!recording_is_empty(0, Some("[]"), Some(&doc(&["call Acme back"])), None));
        // Generated notes present (e.g. enhanced before stop somehow).
        assert!(!recording_is_empty(0, Some("[]"), None, Some(&doc(&["Summary"]))));
    }
}
