use tauri::State;
use crate::db::Database;
use crate::db::queries::Folder;

#[tauri::command]
pub fn create_folder(
    db: State<'_, Database>,
    name: String,
    color: String,
    icon: String,
    parent_id: Option<String>,
) -> Result<Folder, String> {
    db.create_folder(&name, &color, &icon, parent_id.as_deref()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_folders(db: State<'_, Database>) -> Result<Vec<Folder>, String> {
    db.list_folders().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn add_meeting_to_folder(
    db: State<'_, Database>,
    meeting_id: String,
    folder_id: String,
) -> Result<(), String> {
    db.add_meeting_to_folder(&meeting_id, &folder_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn remove_meeting_from_folder(
    db: State<'_, Database>,
    meeting_id: String,
    folder_id: String,
) -> Result<(), String> {
    db.remove_meeting_from_folder(&meeting_id, &folder_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_folder(
    db: State<'_, Database>,
    id: String,
) -> Result<(), String> {
    db.delete_folder(&id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_meeting_ids_in_folder(
    db: State<'_, Database>,
    folder_id: String,
) -> Result<Vec<String>, String> {
    db.get_meeting_ids_in_folder(&folder_id).map_err(|e| e.to_string())
}

/// Reorder folders via drag-and-drop
#[tauri::command]
pub fn reorder_folders(
    db: State<'_, Database>,
    folder_ids: Vec<String>,
    parent_id: Option<String>,
) -> Result<(), String> {
    db.reorder_folders(&folder_ids, parent_id.as_deref()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn move_folder(
    db: State<'_, Database>,
    id: String,
    new_parent_id: Option<String>,
) -> Result<(), String> {
    db.move_folder(&id, new_parent_id.as_deref()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_folder_recursive(
    db: State<'_, Database>,
    id: String,
) -> Result<(), String> {
    db.delete_folder_recursive(&id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_meeting_folders(
    db: State<'_, Database>,
    meeting_id: String,
) -> Result<Vec<Folder>, String> {
    db.get_meeting_folders(&meeting_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_meetings_in_folder(
    db: State<'_, Database>,
    folder_id: String,
) -> Result<Vec<crate::db::queries::Meeting>, String> {
    db.get_meetings_in_folder(&folder_id).map_err(|e| e.to_string())
}
