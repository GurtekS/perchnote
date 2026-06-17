use tauri::State;
use crate::db::Database;
use crate::db::queries::Tag;

#[tauri::command]
pub fn list_tags(db: State<'_, Database>) -> Result<Vec<Tag>, String> {
    db.list_tags().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_meeting_tags(
    db: State<'_, Database>,
    meeting_id: String,
) -> Result<Vec<Tag>, String> {
    db.get_meeting_tags(&meeting_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_tags_for_meetings(
    db: State<'_, Database>,
    meeting_ids: Vec<String>,
) -> Result<std::collections::HashMap<String, Vec<Tag>>, String> {
    db.get_tags_for_meetings(&meeting_ids).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn add_tag_to_meeting(
    db: State<'_, Database>,
    meeting_id: String,
    tag_id: String,
) -> Result<(), String> {
    db.add_tag_to_meeting(&meeting_id, &tag_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn remove_tag_from_meeting(
    db: State<'_, Database>,
    meeting_id: String,
    tag_id: String,
) -> Result<(), String> {
    db.remove_tag_from_meeting(&meeting_id, &tag_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_tag(
    db: State<'_, Database>,
    name: String,
    source: Option<String>,
) -> Result<Tag, String> {
    db.create_tag(&name, &source.unwrap_or_else(|| "manual".to_string()))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_tag(db: State<'_, Database>, id: String) -> Result<(), String> {
    db.delete_tag(&id).map_err(|e| e.to_string())
}
