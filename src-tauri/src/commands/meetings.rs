use tauri::State;
use crate::db::Database;
use crate::db::queries::{Meeting, SpeakerLabel, MeetingLink, StorageStats};

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
    db: State<'_, Database>,
    id: String,
    status: String,
) -> Result<(), String> {
    db.update_meeting_status(&id, &status).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_meeting(db: State<'_, Database>, id: String) -> Result<(), String> {
    db.delete_meeting(&id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn soft_delete_meeting(db: State<'_, Database>, id: String) -> Result<(), String> {
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
pub fn export_all_data(db: State<'_, Database>) -> Result<String, String> {
    db.export_all_data().map_err(|e| e.to_string())
}
