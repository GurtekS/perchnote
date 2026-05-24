use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use crate::db::{Database, DatabaseHealth};
use crate::db::queries::Attachment;
use crate::secrets::{self, SecretKey};

/// Keys we transparently route to the macOS Keychain instead of the
/// plaintext SQLite settings table.
fn secret_key_for(key: &str) -> Option<SecretKey> {
    match key {
        "google_client_secret"   => Some(SecretKey::GoogleClientSecret),
        "google_oauth_tokens"    => Some(SecretKey::GoogleOAuthTokens),
        "microsoft_client_secret"=> Some(SecretKey::MicrosoftClientSecret),
        "microsoft_oauth_tokens" => Some(SecretKey::MicrosoftOAuthTokens),
        "slack_webhook_url"      => Some(SecretKey::SlackWebhookUrl),
        "anthropic_api_key"      => Some(SecretKey::AnthropicApiKey),
        _ => None,
    }
}

/// Validate that an arbitrary string is a v4 UUID. Used at every command
/// boundary that takes an id and uses it in a filesystem path or SQL row
/// lookup.
pub(crate) fn validate_uuid(s: &str) -> Result<(), String> {
    uuid::Uuid::parse_str(s)
        .map(|_| ())
        .map_err(|_| "invalid id format".to_string())
}

#[derive(Serialize)]
pub struct AppPaths {
    pub data_dir: String,
    pub recordings_dir: String,
    pub models_dir: String,
    pub db_path: String,
}

#[derive(Serialize)]
pub struct ModelInfo {
    pub id: String,
    pub label: String,
    pub size: String,
    pub downloaded: bool,
    pub path: Option<String>,
}

#[tauri::command]
pub fn get_setting(db: State<'_, Database>, key: String) -> Result<Option<String>, String> {
    if let Some(sk) = secret_key_for(&key) {
        return secrets::get(sk).map_err(|e| e.to_string());
    }
    db.get_setting(&key).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_setting(
    db: State<'_, Database>,
    key: String,
    value: String,
) -> Result<(), String> {
    if let Some(sk) = secret_key_for(&key) {
        if value.is_empty() {
            return secrets::delete(sk).map_err(|e| e.to_string());
        }
        return secrets::set(sk, &value).map_err(|e| e.to_string());
    }
    db.set_setting(&key, &value).map_err(|e| e.to_string())
}

/// Get current app storage paths
#[tauri::command]
pub fn get_app_paths(app: AppHandle) -> Result<AppPaths, String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(AppPaths {
        data_dir: data_dir.display().to_string(),
        recordings_dir: data_dir.join("recordings").display().to_string(),
        models_dir: data_dir.join("models").display().to_string(),
        db_path: data_dir.join("database.sqlite").display().to_string(),
    })
}

/// List available whisper models with download status
#[tauri::command]
pub fn list_whisper_models(app: AppHandle) -> Result<Vec<ModelInfo>, String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let models_dir = data_dir.join("models");

    let models = vec![
        ("base.en", "Base (English)", "~148 MB"),
        ("medium.en", "Medium (English)", "~1.5 GB"),
        ("large-v3-turbo", "Large V3 Turbo", "~3.1 GB"),
    ];

    let brew_models_dir = std::path::PathBuf::from("/opt/homebrew/share/whisper-cpp/models");

    Ok(models
        .into_iter()
        .map(|(id, label, size)| {
            let filename = format!("ggml-{}.bin", id);
            let app_path = models_dir.join(&filename);
            let brew_path = brew_models_dir.join(&filename);
            let (downloaded, path) = if app_path.exists() {
                (true, Some(app_path.display().to_string()))
            } else if brew_path.exists() {
                (true, Some(brew_path.display().to_string()))
            } else {
                (false, None)
            };
            ModelInfo {
                id: id.to_string(),
                label: label.to_string(),
                size: size.to_string(),
                downloaded,
                path,
            }
        })
        .collect())
}

/// Download a whisper model from Hugging Face.
///
/// Only known model IDs are accepted — the same allowlist `list_whisper_models`
/// publishes — so the URL we construct can't escape the whisper.cpp model
/// path on Hugging Face.
const ALLOWED_WHISPER_MODELS: &[&str] = &["base.en", "medium.en", "large-v3-turbo"];

#[tauri::command]
pub async fn download_whisper_model(
    app: AppHandle,
    model_id: String,
) -> Result<String, String> {
    if !ALLOWED_WHISPER_MODELS.contains(&model_id.as_str()) {
        return Err(format!("unknown whisper model: {}", model_id));
    }

    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let models_dir = data_dir.join("models");
    std::fs::create_dir_all(&models_dir).map_err(|e| e.to_string())?;

    let filename = format!("ggml-{}.bin", model_id);
    let dest_path = models_dir.join(&filename);

    if dest_path.exists() {
        return Ok(dest_path.display().to_string());
    }

    let url = format!(
        "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/{}",
        filename
    );

    log::info!("downloading whisper model from: {}", url);
    let _ = app.emit("model-download-progress", serde_json::json!({
        "model_id": model_id,
        "status": "downloading",
        "progress": 0,
    }));

    let client = reqwest::Client::new();
    let response = client.get(&url).send().await.map_err(|e| e.to_string())?;

    if !response.status().is_success() {
        return Err(format!("Download failed: HTTP {}", response.status()));
    }

    let total_size = response.content_length().unwrap_or(0);
    let mut downloaded: u64 = 0;

    // Write to a temp file first, then rename
    let tmp_path = dest_path.with_extension("bin.downloading");
    let mut file = tokio::fs::File::create(&tmp_path)
        .await
        .map_err(|e| e.to_string())?;

    use tokio::io::AsyncWriteExt;
    let mut stream = response.bytes_stream();
    use futures_util::StreamExt;

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        file.write_all(&chunk).await.map_err(|e| e.to_string())?;
        downloaded += chunk.len() as u64;

        let progress = if total_size > 0 {
            (downloaded as f64 / total_size as f64 * 100.0) as u32
        } else {
            0
        };

        let _ = app.emit("model-download-progress", serde_json::json!({
            "model_id": model_id,
            "status": "downloading",
            "progress": progress,
            "downloaded_bytes": downloaded,
            "total_bytes": total_size,
        }));
    }

    file.flush().await.map_err(|e| e.to_string())?;
    drop(file);

    // Rename temp file to final path
    tokio::fs::rename(&tmp_path, &dest_path)
        .await
        .map_err(|e| e.to_string())?;

    let _ = app.emit("model-download-progress", serde_json::json!({
        "model_id": model_id,
        "status": "complete",
        "progress": 100,
    }));

    log::info!("whisper model downloaded to: {}", dest_path.display());
    Ok(dest_path.display().to_string())
}

/// Update the custom export/recordings directory.
///
/// `path_type` must be a recognised slot (`recordings` or `export`), and
/// `path` must be absolute, contain no `..` traversal, and resolve under
/// the user's home directory. Stored-then-trusted paths are the easiest
/// way to introduce a deferred path-traversal sink later, so we tighten
/// here even though no current code reads these settings.
#[tauri::command]
pub fn set_custom_storage_path(
    db: State<'_, Database>,
    path_type: String,
    path: String,
) -> Result<(), String> {
    if !matches!(path_type.as_str(), "recordings" | "export") {
        return Err(format!("unknown path slot '{}'", path_type));
    }

    let candidate = std::path::PathBuf::from(&path);
    if !candidate.is_absolute() {
        return Err("path must be absolute".to_string());
    }
    use std::path::Component;
    for c in candidate.components() {
        if matches!(c, Component::CurDir | Component::ParentDir) {
            return Err("path may not contain '.' or '..' segments".to_string());
        }
    }
    let home = std::env::var_os("HOME")
        .map(std::path::PathBuf::from)
        .ok_or_else(|| "HOME is not set".to_string())?;
    if !candidate.starts_with(&home) {
        return Err("path must live inside your home directory".to_string());
    }

    let key = format!("custom_{}_path", path_type);
    db.set_setting(&key, &path).map_err(|e| e.to_string())
}

/// Write text to the macOS clipboard via pbcopy (navigator.clipboard is blocked in WKWebView)
#[tauri::command]
pub async fn write_clipboard(text: String) -> Result<(), String> {
    use std::io::Write;
    let mut child = std::process::Command::new("pbcopy")
        .stdin(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    if let Some(stdin) = child.stdin.as_mut() {
        stdin.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
    }
    child.wait().map_err(|e| e.to_string())?;
    Ok(())
}

/// Open a URL in the system default handler. Restricted to safe schemes —
/// `javascript:`, `file:`, `vbscript:`, `data:` are all rejected so a
/// compromised meeting/calendar string can't escalate to code execution.
#[tauri::command]
pub async fn open_url(url: String) -> Result<(), String> {
    let parsed = url::Url::parse(&url).map_err(|e| format!("invalid URL: {}", e))?;
    match parsed.scheme() {
        "http" | "https" | "mailto" => {}
        other => return Err(format!("URL scheme '{}' is not allowed", other)),
    }
    std::process::Command::new("/usr/bin/open")
        .arg("--")
        .arg(parsed.as_str())
        .status()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Open a folder in Finder. The path must live inside one of the
/// app's known data directories AND contain no `..` traversal segments.
/// `PathBuf::starts_with` is a *component* prefix check — it does not
/// resolve `..` — so without the component scan, `appdata/../../etc`
/// would falsely "start with" `appdata`.
#[tauri::command]
pub async fn reveal_in_finder(app: AppHandle, path: String) -> Result<(), String> {
    let candidate = std::path::PathBuf::from(&path);

    // Reject anything containing `..` or any other non-Normal component.
    // (Normal = a plain filename. Prefix and RootDir are fine on their own.)
    use std::path::Component;
    for c in candidate.components() {
        match c {
            Component::Normal(_) | Component::Prefix(_) | Component::RootDir => {}
            Component::CurDir | Component::ParentDir => {
                return Err("path may not contain '.' or '..' segments".to_string());
            }
        }
    }

    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let desktop = app.path().desktop_dir().ok();
    let documents = app.path().document_dir().ok();
    let allowed_roots: Vec<std::path::PathBuf> = [Some(app_data), desktop, documents]
        .into_iter()
        .flatten()
        .collect();

    let within_allowed = allowed_roots.iter().any(|root| candidate.starts_with(root));
    if !within_allowed {
        return Err("path is outside the app's allowed directories".to_string());
    }

    std::fs::create_dir_all(&candidate)
        .map_err(|e| format!("could not create directory: {}", e))?;

    let status = std::process::Command::new("/usr/bin/open")
        .arg("-a")
        .arg("Finder")
        .arg("--")
        .arg(&candidate)
        .status()
        .map_err(|e| e.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("Could not open folder: exit code {:?}", status.code()))
    }
}

/// Rename a folder
#[tauri::command]
pub fn rename_folder(
    db: State<'_, Database>,
    id: String,
    name: String,
) -> Result<(), String> {
    let conn = db.conn.lock().map_err(|_| "lock error".to_string())?;
    conn.execute(
        "UPDATE folders SET name = ?2, updated_at = datetime('now') WHERE id = ?1",
        rusqlite::params![id, name],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

/// Update folder color and icon
#[tauri::command]
pub fn update_folder(
    db: State<'_, Database>,
    id: String,
    name: Option<String>,
    color: Option<String>,
    icon: Option<String>,
) -> Result<(), String> {
    let conn = db.conn.lock().map_err(|_| "lock error".to_string())?;
    if let Some(name) = name {
        conn.execute(
            "UPDATE folders SET name = ?2 WHERE id = ?1",
            rusqlite::params![id, name],
        ).map_err(|e| e.to_string())?;
    }
    if let Some(color) = color {
        conn.execute(
            "UPDATE folders SET color = ?2 WHERE id = ?1",
            rusqlite::params![id, color],
        ).map_err(|e| e.to_string())?;
    }
    if let Some(icon) = icon {
        conn.execute(
            "UPDATE folders SET icon = ?2 WHERE id = ?1",
            rusqlite::params![id, icon],
        ).map_err(|e| e.to_string())?;
    }
    conn.execute(
        "UPDATE folders SET updated_at = datetime('now') WHERE id = ?1",
        rusqlite::params![id],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

/// Check database health — returns schema version, tables, and validation status.
#[tauri::command]
pub fn check_database_health(
    db: State<'_, Database>,
) -> Result<DatabaseHealth, String> {
    db.check_health().map_err(|e| e.to_string())
}

/// Add a file attachment to a meeting. Copies the file into
/// the app's data directory under an `attachments` subfolder.
#[tauri::command]
pub async fn add_attachment(
    app: AppHandle,
    db: State<'_, Database>,
    meeting_id: String,
    file_path: String,
) -> Result<Attachment, String> {
    validate_uuid(&meeting_id)?;

    let source_path = std::path::PathBuf::from(&file_path);
    if !source_path.exists() {
        return Err("File not found".to_string());
    }
    // Defensive cap — refuse anything over 100 MiB.
    let metadata_check = std::fs::metadata(&source_path).map_err(|e| e.to_string())?;
    if metadata_check.len() > 100 * 1024 * 1024 {
        return Err("Attachments are limited to 100 MiB".to_string());
    }

    let file_name = source_path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("Invalid file name")?
        .to_string();

    // Determine file type from extension
    let file_type = match source_path.extension().and_then(|e| e.to_str()) {
        Some("pdf") => "application/pdf",
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("svg") => "image/svg+xml",
        Some("doc") | Some("docx") => "application/msword",
        Some("xls") | Some("xlsx") => "application/vnd.ms-excel",
        Some("ppt") | Some("pptx") => "application/vnd.ms-powerpoint",
        Some("txt") => "text/plain",
        Some("md") => "text/markdown",
        Some("csv") => "text/csv",
        Some("json") => "application/json",
        Some("zip") => "application/zip",
        Some("mp3") => "audio/mpeg",
        Some("wav") => "audio/wav",
        Some("mp4") => "video/mp4",
        _ => "application/octet-stream",
    }.to_string();

    // Get file size
    let metadata = std::fs::metadata(&source_path).map_err(|e| e.to_string())?;
    let file_size = metadata.len() as i64;

    // Copy file to app data attachments directory
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let attachments_dir = app_data_dir.join("attachments").join(&meeting_id);
    std::fs::create_dir_all(&attachments_dir).map_err(|e| e.to_string())?;

    // Generate unique dest filename to avoid conflicts
    let dest_name = format!("{}_{}", uuid::Uuid::new_v4(), file_name);
    let dest_path = attachments_dir.join(&dest_name);
    std::fs::copy(&source_path, &dest_path).map_err(|e| e.to_string())?;

    let dest_path_str = dest_path.to_string_lossy().to_string();

    db.create_attachment(&meeting_id, &file_name, &dest_path_str, &file_type, file_size)
        .map_err(|e| e.to_string())
}

/// List all attachments for a meeting.
#[tauri::command]
pub fn list_attachments(
    db: State<'_, Database>,
    meeting_id: String,
) -> Result<Vec<Attachment>, String> {
    db.list_attachments(&meeting_id).map_err(|e| e.to_string())
}

/// Delete an attachment (removes from DB and disk).
///
/// The DB-stored path is treated as untrusted: we canonicalize it
/// against the attachments directory and refuse to delete files
/// outside that scope even if the row was tampered with.
#[tauri::command]
pub fn delete_attachment(
    app: AppHandle,
    db: State<'_, Database>,
    id: String,
) -> Result<(), String> {
    validate_uuid(&id)?;

    let file_path = db.delete_attachment(&id).map_err(|e| e.to_string())?;
    if let Some(path) = file_path {
        // Best-effort filesystem cleanup — only if the path resolves
        // inside our attachments directory.
        if let Ok(canonical) = std::path::PathBuf::from(&path).canonicalize() {
            if let Ok(app_data) = app.path().app_data_dir() {
                if let Ok(root) = app_data.join("attachments").canonicalize() {
                    if canonical.starts_with(&root) {
                        let _ = std::fs::remove_file(&canonical);
                    }
                }
            }
        }
    }
    Ok(())
}

/// Open an attachment with the system default application.
///
/// The attachment record's stored path is treated as untrusted: we resolve
/// it against the canonical attachments directory and refuse to open
/// anything outside that scope, even if the row was tampered with.
#[tauri::command]
pub async fn open_attachment(
    app: AppHandle,
    db: State<'_, Database>,
    id: String,
) -> Result<(), String> {
    validate_uuid(&id)?;

    let attachment = db.get_attachment(&id)
        .map_err(|e| e.to_string())?
        .ok_or("Attachment not found")?;

    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let attachments_root = app_data.join("attachments");

    let stored = std::path::PathBuf::from(&attachment.file_path);
    let canonical = stored.canonicalize().map_err(|e| e.to_string())?;
    let canonical_root = attachments_root.canonicalize().map_err(|e| e.to_string())?;
    if !canonical.starts_with(&canonical_root) {
        return Err("attachment is outside the allowed directory".to_string());
    }

    open::that(&canonical).map_err(|e| e.to_string())
}

/// Save markdown export to Desktop (or Documents as fallback) and return the full path.
#[tauri::command]
pub fn save_markdown_export(
    app: AppHandle,
    filename: String,
    content: String,
) -> Result<String, String> {
    // Strip any path components — only allow a plain filename
    let safe_filename = std::path::Path::new(&filename)
        .file_name()
        .ok_or_else(|| "Invalid filename".to_string())?
        .to_string_lossy()
        .to_string();
    let dir = app.path().desktop_dir()
        .or_else(|_| app.path().document_dir())
        .map_err(|e| e.to_string())?;
    let path = dir.join(&safe_filename);
    std::fs::write(&path, content.as_bytes()).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}
