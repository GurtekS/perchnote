use tauri::State;
use crate::ai;
use crate::db::Database;
use crate::db::queries::{Note, Transcript};
use crate::transcription::whisper::TranscriptSegment;

#[tauri::command]
pub fn create_note(
    db: State<'_, Database>,
    meeting_id: String,
    template_id: Option<String>,
) -> Result<Note, String> {
    db.create_note(&meeting_id, template_id.as_deref())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_note_by_meeting(
    db: State<'_, Database>,
    meeting_id: String,
) -> Result<Option<Note>, String> {
    db.get_note_by_meeting(&meeting_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_note_raw_content(
    db: State<'_, Database>,
    id: String,
    raw_content: String,
) -> Result<(), String> {
    db.update_note_raw_content(&id, &raw_content).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_note_generated_content(
    db: State<'_, Database>,
    id: String,
    generated_content: String,
) -> Result<(), String> {
    db.update_note_generated_content(&id, &generated_content)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_transcript_by_meeting(
    db: State<'_, Database>,
    meeting_id: String,
) -> Result<Option<Transcript>, String> {
    db.get_transcript_by_meeting(&meeting_id).map_err(|e| e.to_string())
}

/// Re-diarize all transcript segments for a meeting using Claude AI.
/// Sends the transcript text to Claude which identifies speaker turns from
/// conversational patterns. Falls back to returning segments unchanged if
/// Claude is unavailable (signal-based energy diarization was not reliable).
#[tauri::command]
pub async fn rediarize_transcript(
    db: State<'_, Database>,
    meeting_id: String,
) -> Result<String, String> {
    let transcript = db.get_transcript_by_meeting(&meeting_id)
        .map_err(|e| e.to_string())?
        .ok_or("No transcript found for this meeting")?;

    let mut segments: Vec<TranscriptSegment> = serde_json::from_str(&transcript.segments)
        .map_err(|e| format!("Failed to parse segments: {}", e))?;

    // Build (index, text) pairs for Claude
    let pairs: Vec<(usize, &str)> = segments.iter()
        .enumerate()
        .filter(|(_, s)| !s.text.trim().is_empty())
        .map(|(i, s)| (i, s.text.as_str()))
        .collect();

    match ai::rediarize(&db, &pairs).await {
        Ok(assignments) => {
            for (i, seg) in segments.iter_mut().enumerate() {
                if let Some(speaker) = assignments.get(&i) {
                    seg.speaker = Some(speaker.clone());
                }
            }
        }
        Err(e) => {
            log::warn!("AI diarization failed, returning segments unchanged: {}", e);
            // Return segments as-is rather than running the broken energy-based re-diarization
        }
    }

    let new_segments_json = serde_json::to_string(&segments)
        .map_err(|e| format!("Failed to serialize segments: {}", e))?;

    db.update_transcript_segments(&transcript.id, &new_segments_json)
        .map_err(|e| e.to_string())?;

    Ok(new_segments_json)
}
