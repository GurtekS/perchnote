//! Audio-file import (plan v9 #1): any recording macOS can decode becomes
//! a normal Perchnote meeting — Voice Memos, Apple Notes call recordings,
//! in-person captures from a phone. Decoding goes through
//! `/usr/bin/afconvert` (CoreAudio's own converter, ships with every
//! macOS — zero new dependencies, fully local); transcription, speaker
//! detection, and completion side-effects ride the existing pipeline.

use tauri::{AppHandle, Emitter, Manager, State};

use crate::db::Database;

/// Formats afconvert reliably decodes. Video containers are deliberately
/// out — this is an audio importer, not a media library.
const IMPORT_EXTENSIONS: &[&str] = &["wav", "mp3", "m4a", "aac", "aiff", "aif", "caf", "flac"];

pub fn is_importable_audio(path: &std::path::Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| IMPORT_EXTENSIONS.contains(&e.to_lowercase().as_str()))
        .unwrap_or(false)
}

/// One heavy background transcription at a time, app-wide: each runs a
/// full whisper engine (~1.5GB model + a Metal context); concurrent drops
/// would stack engines (QA audit P2-4). The accuracy pass shares this gate
/// for the same reason — stop A then import (or stop B) must queue rather
/// than stack Metal contexts. Async mutex so queued work just waits.
pub(crate) static IMPORT_GATE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Import one audio file: convert into the recordings dir, create a
/// meeting (titled after the file, dated by its mtime), transcribe with
/// the existing engine, then run speaker detection and the normal
/// completion hooks. Returns the new meeting id.
#[tauri::command]
pub async fn import_audio_file(
    app: AppHandle,
    db: State<'_, Database>,
    path: String,
) -> Result<String, String> {
    let src = std::path::PathBuf::from(&path);
    let src = src
        .canonicalize()
        .map_err(|_| "File not found or unreadable".to_string())?;
    if !is_importable_audio(&src) {
        return Err(format!(
            "Unsupported file type — import accepts {}",
            IMPORT_EXTENSIONS.join(", ")
        ));
    }

    // Serialize whole imports — a second drop waits here, not in a
    // second whisper engine.
    let _gate = IMPORT_GATE.lock().await;

    let title = src
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("Imported recording")
        .trim()
        .chars()
        .take(120)
        .collect::<String>();
    let meeting = db.create_meeting(&title).map_err(|e| e.to_string())?;
    let meeting_id = meeting.id.clone();

    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let recordings_dir = app_data_dir.join("recordings");
    std::fs::create_dir_all(&recordings_dir).map_err(|e| e.to_string())?;
    let dest = recordings_dir.join(format!("{}.wav", meeting_id));

    let _ = app.emit(
        "import-progress",
        serde_json::json!({ "meeting_id": meeting_id, "status": "converting", "title": title }),
    );

    // 44.1k mono 16-bit: the app's WAV floor (lower rates are
    // WKWebView-unplayable) and the shape the rest of the pipeline expects.
    // `--mix` is load-bearing (QA audit P1): `-c 1` alone TRUNCATES to the
    // left channel — a stereo source with the remote side on the right
    // (exactly what our own stereo recordings produce) would import with
    // every other participant silently deleted. --mix downmixes properly.
    let convert = tokio::task::spawn_blocking({
        let src = src.clone();
        let dest = dest.clone();
        move || {
            std::process::Command::new("/usr/bin/afconvert")
                .arg("-f")
                .arg("WAVE")
                .arg("-d")
                .arg("LEI16@44100")
                .arg("-c")
                .arg("1")
                .arg("--mix")
                .arg(&src)
                .arg(&dest)
                .output()
        }
    })
    .await
    .map_err(|e| {
        // The meeting row was already created — don't strand it when the
        // converter task itself fails (QA audit P3-8a). The partial WAV
        // goes too (whole-app review P3 — it used to wait for the next
        // launch's orphan sweep).
        let _ = db.delete_meeting(&meeting_id);
        let _ = std::fs::remove_file(&dest);
        e.to_string()
    })?
    .map_err(|e| {
        let _ = db.delete_meeting(&meeting_id);
        let _ = std::fs::remove_file(&dest);
        format!("Couldn't run the audio converter: {e}")
    })?;
    if !convert.status.success() || !dest.exists() {
        let _ = db.delete_meeting(&meeting_id);
        let _ = std::fs::remove_file(&dest);
        let detail = String::from_utf8_lossy(&convert.stderr);
        return Err(format!(
            "Couldn't decode this file{}",
            detail
                .lines()
                .last()
                .map(|l| format!(" — {}", l.trim()))
                .unwrap_or_default()
        ));
    }

    // Date the meeting honestly: the file's mtime is when the recording
    // ended (Voice Memos stamp on stop), so the span ends there. The
    // status flip must NOT depend on the mtime read succeeding (QA audit
    // P3-8b) — an undated meeting is fine, a mis-stated one isn't.
    {
        let conn = db.conn.lock().map_err(|_| "lock error".to_string())?;
        conn.execute(
            "UPDATE meetings SET status = 'transcribing', device_name = 'Imported audio'
             WHERE id = ?1",
            rusqlite::params![meeting_id],
        )
        .map_err(|e| e.to_string())?;
        if let (Some(dur_ms), Ok(meta)) =
            (crate::commands::audio::wav_duration_ms(&dest), src.metadata())
        {
            if let Ok(modified) = meta.modified() {
                let end: chrono::DateTime<chrono::Utc> = modified.into();
                let start = end - chrono::Duration::milliseconds(dur_ms as i64);
                conn.execute(
                    "UPDATE meetings SET actual_start = ?1, actual_end = ?2 WHERE id = ?3",
                    rusqlite::params![start.to_rfc3339(), end.to_rfc3339(), meeting_id],
                )
                .map_err(|e| e.to_string())?;
            }
        }
    }

    let _ = app.emit(
        "import-progress",
        serde_json::json!({ "meeting_id": meeting_id, "status": "transcribing", "title": title }),
    );

    // The retranscribe path is exactly this job: engine load, full-file
    // transcription, transcript upsert.
    let results = match crate::commands::audio::batch_retranscribe(
        app.clone(),
        db.clone(),
        vec![meeting_id.clone()],
    )
    .await
    {
        Ok(r) => r,
        Err(e) => {
            // Engine-level failure (model missing, load error) used to
            // propagate with `?` and leave the meeting stuck at
            // "transcribing" forever (whole-app review P3) — same recovery
            // as a per-file failure: keep audio, mark re-transcribable.
            let _ = db.update_meeting_status(&meeting_id, "recorded");
            return Err(format!("Imported, but transcription failed: {e}"));
        }
    };
    match results.first() {
        Some(r) if r.success => {}
        Some(r) => {
            // Keep the meeting + audio: the user can fix the model situation
            // and Re-transcribe from the UI without re-importing.
            let msg = r.error.clone().unwrap_or_else(|| "transcription failed".into());
            let _ = db.update_meeting_status(&meeting_id, "recorded");
            return Err(format!("Imported, but transcription failed: {msg}"));
        }
        None => return Err("transcription produced no result".into()),
    }

    // Speaker detection is best-effort — a mono phone memo may legitimately
    // have one voice or defeat diarization; the transcript stands either way.
    if let Err(e) =
        crate::commands::voice::recluster_speakers(app.clone(), db.clone(), meeting_id.clone()).await
    {
        log::info!("import: speaker detection skipped: {e}");
    }

    db.update_meeting_status(&meeting_id, "complete")
        .map_err(|e| e.to_string())?;
    crate::commands::meetings::run_completion_side_effects(app.clone(), meeting_id.clone());
    let _ = app.emit(
        "import-progress",
        serde_json::json!({ "meeting_id": meeting_id, "status": "complete", "title": title }),
    );
    Ok(meeting_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extension_allowlist_is_case_insensitive_and_strict() {
        for ok in ["a.m4a", "b.WAV", "c.Mp3", "d.aiff", "e.flac", "f.caf", "g.aac", "h.aif"] {
            assert!(is_importable_audio(std::path::Path::new(ok)), "{ok}");
        }
        for bad in ["evil.sh", "movie.mp4", "clip.mov", "noext", "x.wav.app", "y.txt"] {
            assert!(!is_importable_audio(std::path::Path::new(bad)), "{bad}");
        }
    }
}
