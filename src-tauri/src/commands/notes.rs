use tauri::State;
use crate::ai;
use crate::db::Database;
use crate::db::queries::{ActionItem, LastTimeCard, Note, Transcript};
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

/// Return the meeting's note, creating an empty row if none exists. Used by the
/// enhance flow and auto-save so AI notes always have a row to persist into and
/// never get misrouted into `raw_content`.
#[tauri::command]
pub fn get_or_create_note(
    db: State<'_, Database>,
    meeting_id: String,
) -> Result<Note, String> {
    db.get_or_create_note(&meeting_id).map_err(|e| e.to_string())
}

/// Roll up every action item across active meetings' notes for the Tasks view.
#[tauri::command]
pub fn list_action_items(db: State<'_, Database>) -> Result<Vec<ActionItem>, String> {
    db.list_action_items().map_err(|e| e.to_string())
}

/// Open loops: unfinished action items from prior meetings sharing an
/// attendee with this one (plan rank 13).
#[tauri::command]
pub fn open_loops_for_meeting(
    db: State<'_, Database>,
    meeting_id: String,
) -> Result<Vec<ActionItem>, String> {
    db.open_action_items_for_meeting_attendees(&meeting_id)
        .map_err(|e| e.to_string())
}

/// "Last time" in this meeting's series (plan v2 rank 11).
#[tauri::command]
pub fn last_time_in_series(
    db: State<'_, Database>,
    meeting_id: String,
) -> Result<Option<LastTimeCard>, String> {
    db.last_time_in_series(&meeting_id).map_err(|e| e.to_string())
}

/// Toggle an action item's `done` state, writing back into its source note so
/// the rollup and the in-note checkbox stay in sync.
#[tauri::command]
pub fn set_action_item_done(
    db: State<'_, Database>,
    note_id: String,
    source: String,
    index: usize,
    done: bool,
    task: Option<String>,
) -> Result<(), String> {
    db.set_action_item_done(&note_id, &source, index, done, task.as_deref())
        .map_err(|e| e.to_string())
}

/// Snooze (or unsnooze with None) a task — overlay only, the note and its
/// meeting-stated deadline are untouched (plan v5 rank 3).
#[tauri::command]
pub fn set_task_snooze(
    db: State<'_, Database>,
    note_id: String,
    source: String,
    index: usize,
    snoozed_until: Option<String>,
    task: Option<String>,
) -> Result<(), String> {
    db.set_task_snooze(&note_id, &source, index, snoozed_until.as_deref(), task.as_deref())
        .map_err(|e| e.to_string())
}

/// Consciously drop a task in triage (plan v5 rank 4 state; UI follows).
#[tauri::command]
pub fn set_task_dropped(
    db: State<'_, Database>,
    note_id: String,
    source: String,
    index: usize,
    dropped: bool,
    task: Option<String>,
) -> Result<(), String> {
    db.set_task_dropped(&note_id, &source, index, dropped, task.as_deref())
        .map_err(|e| e.to_string())
}

#[derive(serde::Deserialize)]
pub struct ReminderExportItem {
    pub task: String,
    pub body: String,
    pub deadline: Option<String>,
    // Identity triple — lets export upsert instead of duplicate (plan v5).
    pub note_id: String,
    pub source: String,
    pub index: usize,
}

/// Export tasks to Apple Reminders, idempotently: each item's created
/// reminder ID is stored against its (note_id, source, index) identity, so
/// re-exporting UPDATES the existing reminder instead of duplicating it
/// (the previous behavior — every export doubled the list). Arguments
/// travel as argv — never interpolated — so task text can't inject
/// AppleScript. Returns how many exported successfully.
#[tauri::command]
pub async fn export_tasks_to_reminders(
    db: State<'_, Database>,
    items: Vec<ReminderExportItem>,
) -> Result<usize, String> {
    // argv: 1=existingId(or ""), 2=name, 3=body, [4,5,6 = y,m,d]
    const SCRIPT: &str = r#"on run argv
set existingId to item 1 of argv
set taskName to item 2 of argv
set taskBody to item 3 of argv
set hasDue to (count of argv) >= 6
tell application "Reminders"
    if not (exists list "Perchnote") then
        make new list with properties {name:"Perchnote"}
    end if
    set theReminder to missing value
    if existingId is not "" then
        try
            set theReminder to first reminder of list "Perchnote" whose id is existingId
        end try
    end if
    if theReminder is missing value then
        set theReminder to make new reminder at end of reminders of list "Perchnote" with properties {name:taskName, body:taskBody}
    else
        set name of theReminder to taskName
        set body of theReminder to taskBody
    end if
    if hasDue then
        set dd to current date
        set year of dd to (item 4 of argv as integer)
        set month of dd to (item 5 of argv as integer)
        set day of dd to (item 6 of argv as integer)
        set hours of dd to 9
        set minutes of dd to 0
        set seconds of dd to 0
        set due date of theReminder to dd
    end if
    return id of theReminder
end tell
end run"#;

    let mut exported = 0usize;
    for item in items {
        if item.task.trim().is_empty() {
            continue;
        }
        let existing = db
            .get_reminder_link(&item.note_id, &item.source, item.index)
            .ok()
            .flatten()
            .unwrap_or_default();
        let mut cmd = tokio::process::Command::new("/usr/bin/osascript");
        cmd.arg("-e")
            .arg(SCRIPT)
            .arg(&existing)
            .arg(&item.task)
            .arg(&item.body);
        if let Some(d) = item.deadline.as_deref().and_then(parse_iso_ymd) {
            cmd.arg(d.0.to_string()).arg(d.1.to_string()).arg(d.2.to_string());
        }
        match cmd.output().await {
            Ok(out) if out.status.success() => {
                exported += 1;
                let id = String::from_utf8_lossy(&out.stdout).trim().to_string();
                if !id.is_empty() {
                    let _ = db.upsert_reminder_link(&item.note_id, &item.source, item.index, &id, &item.task);
                }
            }
            Ok(out) => log::warn!(
                "Reminders export failed for '{}': {}",
                item.task,
                String::from_utf8_lossy(&out.stderr)
            ),
            Err(e) => return Err(format!("could not run osascript: {}", e)),
        }
    }
    Ok(exported)
}

/// Parse the completion-pull script output: one "<id>\t<0|1>" line per
/// reminder in the Perchnote list.
fn parse_reminder_status(stdout: &str) -> Vec<(String, bool)> {
    stdout
        .lines()
        .filter_map(|l| {
            let (id, done) = l.rsplit_once('\t')?;
            let id = id.trim();
            (!id.is_empty()).then(|| (id.to_string(), done.trim() == "1"))
        })
        .collect()
}

/// Pull completion state back from Apple Reminders ("two-way for the one
/// field that matters"): reminders the user checked off in Reminders mark
/// the corresponding action items done here. One osascript round-trip.
/// Returns how many items were newly completed.
#[tauri::command]
pub async fn pull_reminder_completions(db: State<'_, Database>) -> Result<usize, String> {
    let links = db.all_reminder_links().map_err(|e| e.to_string())?;
    if links.is_empty() {
        return Ok(0);
    }
    const SCRIPT: &str = r#"on run argv
set output to ""
tell application "Reminders"
    if not (exists list "Perchnote") then return ""
    repeat with r in (reminders of list "Perchnote")
        set doneFlag to "0"
        if completed of r then set doneFlag to "1"
        set output to output & (id of r) & tab & doneFlag & linefeed
    end repeat
end tell
return output
end run"#;
    let out = tokio::process::Command::new("/usr/bin/osascript")
        .arg("-e")
        .arg(SCRIPT)
        .output()
        .await
        .map_err(|e| format!("could not run osascript: {}", e))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    let status = parse_reminder_status(&String::from_utf8_lossy(&out.stdout));
    let completed: std::collections::HashSet<&str> = status
        .iter()
        .filter(|(_, done)| *done)
        .map(|(id, _)| id.as_str())
        .collect();
    let mut newly = 0usize;
    for (reminder_id, note_id, source, idx, task_text) in &links {
        // task_text anchors identity (migration 19): the write-back
        // verifies the position and re-locates by text if items above
        // were added/removed since export — never flips a stranger.
        if completed.contains(reminder_id.as_str())
            && db
                .set_action_item_done(note_id, source, *idx, true, task_text.as_deref())
                .is_ok()
        {
            newly += 1;
        }
    }
    Ok(newly)
}

/// Parse a YYYY-MM-DD prefix into (year, month, day).
fn parse_iso_ymd(s: &str) -> Option<(i32, u32, u32)> {
    let s = s.get(..10)?;
    let mut parts = s.split('-');
    let y: i32 = parts.next()?.parse().ok()?;
    let m: u32 = parts.next()?.parse().ok()?;
    let d: u32 = parts.next()?.parse().ok()?;
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    Some((y, m, d))
}

/// Write raw and generated content in one statement — the enhance flow uses
/// this so an autosave can't land between two separate writes.
#[tauri::command]
pub fn update_note_contents(
    db: State<'_, Database>,
    id: String,
    raw_content: Option<String>,
    generated_content: String,
) -> Result<(), String> {
    db.update_note_contents(&id, raw_content.as_deref(), &generated_content)
        .map_err(|e| e.to_string())
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

/// Atomic raw+generated write WITH the enhance receipt (plan v10 #2):
/// provider/model that generated the notes, a fresh generated_at, and the
/// transcript hash the generation read. The prior generated version (content
/// + its receipts) moves into the one previous-version slot.
#[tauri::command]
pub fn update_note_contents_with_receipt(
    db: State<'_, Database>,
    id: String,
    raw_content: Option<String>,
    generated_content: String,
    provider: String,
    model: String,
    transcript_sha: Option<String>,
) -> Result<(), String> {
    db.update_note_generated_with_receipt(
        &id,
        raw_content.as_deref(),
        &generated_content,
        &provider,
        &model,
        transcript_sha.as_deref(),
    )
    .map_err(|e| e.to_string())
}

/// Swap generated_content with the one-slot previous version — content and
/// receipt fields both trade places. Returns the updated note.
#[tauri::command]
pub fn restore_previous_notes(db: State<'_, Database>, id: String) -> Result<Note, String> {
    db.restore_previous_generated(&id).map_err(|e| e.to_string())
}

/// Current transcript hash for a meeting — the live side of the receipt
/// staleness comparison. None when the meeting has no transcript.
#[tauri::command]
pub fn get_transcript_sha(
    db: State<'_, Database>,
    meeting_id: String,
) -> Result<Option<String>, String> {
    db.transcript_sha(&meeting_id).map_err(|e| e.to_string())
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

#[cfg(test)]
mod reminder_tests {
    #[test]
    fn parses_pull_output_lines() {
        use super::parse_reminder_status;
        let out = "x-apple-reminder://AAA\t1\nx-apple-reminder://BBB\t0\n\n";
        let parsed = parse_reminder_status(out);
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0], ("x-apple-reminder://AAA".to_string(), true));
        assert_eq!(parsed[1].1, false);
        assert!(parse_reminder_status("").is_empty());
    }

    use super::parse_iso_ymd;

    #[test]
    fn parses_iso_prefix_and_rejects_garbage() {
        assert_eq!(parse_iso_ymd("2026-06-12"), Some((2026, 6, 12)));
        assert_eq!(parse_iso_ymd("2026-06-12T09:00:00Z"), Some((2026, 6, 12)));
        assert_eq!(parse_iso_ymd("next friday"), None);
        assert_eq!(parse_iso_ymd("2026-13-01"), None, "month out of range");
        assert_eq!(parse_iso_ymd("2026-00-10"), None);
        assert_eq!(parse_iso_ymd("2026-06-32"), None, "day out of range");
        assert_eq!(parse_iso_ymd(""), None);
        assert_eq!(parse_iso_ymd("06/12/2026"), None);
    }
}
