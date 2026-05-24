use tauri::State;
use crate::db::Database;
use crate::db::queries::Template;

#[tauri::command]
pub fn list_templates(db: State<'_, Database>) -> Result<Vec<Template>, String> {
    db.list_templates().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_default_template(db: State<'_, Database>) -> Result<Option<Template>, String> {
    db.get_default_template().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_template(
    db: State<'_, Database>,
    name: String,
    description: Option<String>,
    prompt_template: String,
    sections: String,
    is_default: bool,
) -> Result<Template, String> {
    db.create_template(&name, description.as_deref(), &prompt_template, &sections, is_default, false)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_template(
    db: State<'_, Database>,
    id: String,
    name: String,
    description: Option<String>,
    prompt_template: String,
    sections: String,
    is_default: bool,
) -> Result<(), String> {
    db.update_template(&id, &name, description.as_deref(), &prompt_template, &sections, is_default)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_template(db: State<'_, Database>, id: String) -> Result<(), String> {
    db.delete_template(&id).map_err(|e| e.to_string())
}
