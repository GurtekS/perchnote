use tauri::State;
use crate::db::Database;
use crate::db::queries::SearchResult;

#[tauri::command]
pub fn search_transcripts(
    db: State<'_, Database>,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<String>, String> {
    db.search_transcripts(&query, limit.unwrap_or(5)).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn search_all(
    db: State<'_, Database>,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<SearchResult>, String> {
    db.search_all(&query, limit.unwrap_or(20)).map_err(|e| e.to_string())
}
