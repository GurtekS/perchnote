use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use crate::db::{Database, DatabaseHealth};
use crate::db::queries::Attachment;
use crate::secrets::{self, SecretKey};

/// Keys we transparently route to the macOS Keychain instead of the
/// plaintext SQLite settings table.
///
/// Deliberately NOT here: `user_context` (the About-You profile). It is
/// user-editable display metadata, and the database already stores far more
/// sensitive content (full transcripts/notes) in plaintext by design — the
/// at-rest threat model is FileVault.
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
        // q8_0 is near-lossless vs f16 at a quarter of the size, and beats
        // medium.en on accuracy AND speed — the recommended quality pick
        // now that the VAD gate covers turbo's noise weakness (plan v4).
        ("large-v3-turbo-q8_0", "Large V3 Turbo (recommended)", "~874 MB"),
        ("large-v3-turbo", "Large V3 Turbo (full)", "~3.1 GB"),
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
const ALLOWED_WHISPER_MODELS: &[&str] =
    &["base.en", "medium.en", "large-v3-turbo", "large-v3-turbo-q8_0"];

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
        // `things` is Cultured Code's task-manager scheme, used by the Tasks
        // view hand-off (plan v8 B6) — same risk class as mailto: it launches
        // a specific app with structured data, no code-execution surface.
        // `shortcuts`/`raycast` are deliberately NOT here: this command is
        // reachable from the whole frontend, and `shortcuts://run-shortcut`
        // can execute user-installed automations. x-callback returns go
        // through their own two-scheme gate in commands::deeplinks instead.
        "http" | "https" | "mailto" | "things" => {}
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

// ───────────────────── Pasted images (plan v9 #13) ──────────────────────
// ⌘V of a screenshot hands the frontend raw PNG BYTES, not a path —
// add_attachment can't take it. This is the bytes-in write path: decode,
// validate, land under attachments/<meeting_id>/ like any other attachment
// so storage accounting, backups, and hard-delete cleanup all see it.

/// First 8 bytes of every PNG file (the spec signature). Pasted macOS
/// screenshots are always PNG; anything else is rejected.
const PNG_MAGIC: [u8; 8] = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];

/// Decoded-size cap. A Retina full-screen screenshot is ~5–10 MB; 20 MiB
/// leaves headroom without letting one stray paste balloon the data dir.
const MAX_PASTED_IMAGE_BYTES: usize = 20 * 1024 * 1024;

/// Everything save_pasted_image does except resolving the app-data dir —
/// split out so it's testable without an AppHandle (same pattern as
/// write_backup_archive below).
pub(crate) fn save_pasted_image_impl(
    app_data_dir: &std::path::Path,
    db: &Database,
    meeting_id: &str,
    base64_png: &str,
) -> Result<Attachment, String> {
    validate_uuid(meeting_id)?;

    // Cheap precheck on the ENCODED length before allocating the decode:
    // base64 inflates by 4/3, so anything longer can't fit under the cap.
    if base64_png.len() > MAX_PASTED_IMAGE_BYTES / 3 * 4 + 4 {
        return Err("Pasted images are limited to 20 MiB".to_string());
    }
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(base64_png.trim())
        .map_err(|_| "invalid base64 image data".to_string())?;
    if bytes.len() > MAX_PASTED_IMAGE_BYTES {
        return Err("Pasted images are limited to 20 MiB".to_string());
    }
    if bytes.len() < PNG_MAGIC.len() || bytes[..PNG_MAGIC.len()] != PNG_MAGIC {
        return Err("Pasted data is not a PNG image".to_string());
    }

    let attachments_root = app_data_dir.join("attachments");
    let meeting_dir = attachments_root.join(meeting_id);
    std::fs::create_dir_all(&meeting_dir).map_err(|e| e.to_string())?;

    // Same canonicalized-containment stance as delete_attachment /
    // open_attachment: refuse to write if the resolved directory escapes
    // the attachments root (e.g. a symlink swapped in underneath us).
    let canonical_dir = meeting_dir.canonicalize().map_err(|e| e.to_string())?;
    let canonical_root = attachments_root.canonicalize().map_err(|e| e.to_string())?;
    if !canonical_dir.starts_with(&canonical_root) {
        return Err("attachment directory is outside the allowed directory".to_string());
    }

    // pasted-<n>.png with n = highest existing index + 1 — human-readable
    // names that never collide, even after deletions. create_new closes
    // the read_dir→write TOCTOU (QA audit P3-7): two near-simultaneous
    // pastes computed the same n and the second write clobbered the first;
    // now the loser of the race just takes the next number.
    let mut next = std::fs::read_dir(&canonical_dir)
        .map(|entries| {
            entries
                .filter_map(|e| e.ok())
                .filter_map(|e| e.file_name().to_str().map(String::from))
                .filter_map(|name| {
                    name.strip_prefix("pasted-")?
                        .strip_suffix(".png")?
                        .parse::<u64>()
                        .ok()
                })
                .max()
                .unwrap_or(0)
        })
        .unwrap_or(0)
        + 1;
    let (file_name, dest_path) = loop {
        let candidate = format!("pasted-{next}.png");
        let path = canonical_dir.join(&candidate);
        match std::fs::OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut f) => {
                use std::io::Write;
                f.write_all(&bytes).map_err(|e| e.to_string())?;
                break (candidate, path);
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                next += 1;
            }
            Err(e) => return Err(e.to_string()),
        }
    };

    let dest_path_str = dest_path.to_string_lossy().to_string();
    db.create_attachment(meeting_id, &file_name, &dest_path_str, "image/png", bytes.len() as i64)
        .map_err(|e| {
            // Row insert failed (e.g. FK: no such meeting) — don't leave an
            // orphan file that storage accounting would never see.
            let _ = std::fs::remove_file(&dest_path);
            e.to_string()
        })
}

/// Save an image pasted into the notes editor (⌘V of a screenshot) as a
/// meeting attachment. Takes raw PNG bytes as base64 — the paste path has
/// no source file for add_attachment to copy. Bytes never leave disk.
#[tauri::command]
pub async fn save_pasted_image(
    app: AppHandle,
    db: State<'_, Database>,
    meeting_id: String,
    base64_png: String,
) -> Result<Attachment, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    save_pasted_image_impl(&app_data_dir, &db, &meeting_id, &base64_png)
}

#[cfg(test)]
mod pasted_image_tests {
    use super::*;
    use base64::Engine as _;

    fn png_bytes(extra: usize) -> Vec<u8> {
        let mut b = PNG_MAGIC.to_vec();
        b.extend(std::iter::repeat(0u8).take(extra));
        b
    }

    fn encode(bytes: &[u8]) -> String {
        base64::engine::general_purpose::STANDARD.encode(bytes)
    }

    #[test]
    fn saves_png_and_registers_attachment_row() {
        let tmp = tempfile::tempdir().unwrap();
        let db = Database::new_in_memory().unwrap();
        let m = db.create_meeting("Deck review").unwrap();

        let bytes = png_bytes(64);
        let a = save_pasted_image_impl(tmp.path(), &db, &m.id, &encode(&bytes)).unwrap();

        assert_eq!(a.file_name, "pasted-1.png");
        assert_eq!(a.file_type, "image/png");
        assert_eq!(a.file_size, bytes.len() as i64);
        assert_eq!(std::fs::read(&a.file_path).unwrap(), bytes);
        // Containment: the stored path resolves inside attachments/<id>/.
        let root = tmp.path().join("attachments").canonicalize().unwrap();
        assert!(std::path::PathBuf::from(&a.file_path).starts_with(root.join(&m.id)));
        // The row is queryable like any other attachment.
        let listed = db.list_attachments(&m.id).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, a.id);
    }

    #[test]
    fn numbers_pastes_sequentially_past_existing_files() {
        let tmp = tempfile::tempdir().unwrap();
        let db = Database::new_in_memory().unwrap();
        let m = db.create_meeting("M").unwrap();

        let a1 = save_pasted_image_impl(tmp.path(), &db, &m.id, &encode(&png_bytes(4))).unwrap();
        let a2 = save_pasted_image_impl(tmp.path(), &db, &m.id, &encode(&png_bytes(4))).unwrap();
        assert_eq!(a1.file_name, "pasted-1.png");
        assert_eq!(a2.file_name, "pasted-2.png");

        // Pre-existing high index (e.g. restored backup) — never overwrite.
        std::fs::write(
            tmp.path().join("attachments").join(&m.id).join("pasted-7.png"),
            b"x",
        )
        .unwrap();
        let a3 = save_pasted_image_impl(tmp.path(), &db, &m.id, &encode(&png_bytes(4))).unwrap();
        assert_eq!(a3.file_name, "pasted-8.png");
    }

    #[test]
    fn rejects_non_png_bytes() {
        let tmp = tempfile::tempdir().unwrap();
        let db = Database::new_in_memory().unwrap();
        let m = db.create_meeting("M").unwrap();

        // JPEG magic, and a too-short blob.
        let jpeg = [0xFFu8, 0xD8, 0xFF, 0xE0, 0, 0, 0, 0, 1, 2, 3];
        let err = save_pasted_image_impl(tmp.path(), &db, &m.id, &encode(&jpeg)).unwrap_err();
        assert!(err.contains("not a PNG"), "got: {err}");
        let err = save_pasted_image_impl(tmp.path(), &db, &m.id, &encode(&[0x89, 0x50])).unwrap_err();
        assert!(err.contains("not a PNG"), "got: {err}");
        assert!(db.list_attachments(&m.id).unwrap().is_empty());
    }

    #[test]
    fn rejects_invalid_base64() {
        let tmp = tempfile::tempdir().unwrap();
        let db = Database::new_in_memory().unwrap();
        let m = db.create_meeting("M").unwrap();
        let err = save_pasted_image_impl(tmp.path(), &db, &m.id, "not base64!!!").unwrap_err();
        assert!(err.contains("invalid base64"), "got: {err}");
    }

    #[test]
    fn caps_decoded_size_at_20_mib() {
        let tmp = tempfile::tempdir().unwrap();
        let db = Database::new_in_memory().unwrap();
        let m = db.create_meeting("M").unwrap();

        // Over-cap payload is rejected by the cheap encoded-length precheck
        // before any decode allocation happens.
        let big = encode(&png_bytes(MAX_PASTED_IMAGE_BYTES));
        let err = save_pasted_image_impl(tmp.path(), &db, &m.id, &big).unwrap_err();
        assert!(err.contains("20 MiB"), "got: {err}");
        assert!(db.list_attachments(&m.id).unwrap().is_empty());
    }

    #[test]
    fn rejects_non_uuid_meeting_id_before_touching_disk() {
        let tmp = tempfile::tempdir().unwrap();
        let db = Database::new_in_memory().unwrap();
        let err =
            save_pasted_image_impl(tmp.path(), &db, "../../evil", &encode(&png_bytes(4))).unwrap_err();
        assert_eq!(err, "invalid id format");
        assert!(!tmp.path().join("attachments").exists());
    }

    #[test]
    fn unknown_meeting_fails_fk_and_removes_the_orphan_file() {
        let tmp = tempfile::tempdir().unwrap();
        let db = Database::new_in_memory().unwrap();
        // Valid UUID, but no such meeting row → FK constraint rejects the
        // insert and the already-written file must be cleaned up.
        let ghost = uuid::Uuid::new_v4().to_string();
        let err = save_pasted_image_impl(tmp.path(), &db, &ghost, &encode(&png_bytes(4))).unwrap_err();
        assert!(err.contains("FOREIGN KEY"), "got: {err}");
        assert!(!tmp.path().join("attachments").join(&ghost).join("pasted-1.png").exists());
    }
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

/// Download the Silero VAD model (~1MB) that gates transcription chunks.
/// Fixed, allowlisted URL — same trust posture as whisper model downloads.
#[tauri::command]
pub async fn download_vad_model(app: AppHandle) -> Result<String, String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let models_dir = data_dir.join("models");
    std::fs::create_dir_all(&models_dir).map_err(|e| e.to_string())?;
    let dest = models_dir.join(crate::transcription::engine::VAD_MODEL_FILENAME);
    if dest.exists() {
        return Ok(dest.display().to_string());
    }
    let url = format!(
        "https://huggingface.co/ggml-org/whisper-vad/resolve/main/{}",
        crate::transcription::engine::VAD_MODEL_FILENAME
    );
    let bytes = reqwest::get(&url)
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .bytes()
        .await
        .map_err(|e| e.to_string())?;
    std::fs::write(&dest, &bytes).map_err(|e| e.to_string())?;
    log::info!("silero VAD model downloaded ({} bytes)", bytes.len());
    Ok(dest.display().to_string())
}

/// Whether the VAD gate model is on disk.
#[tauri::command]
pub fn vad_model_ready(app: AppHandle) -> Result<bool, String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(data_dir
        .join("models")
        .join(crate::transcription::engine::VAD_MODEL_FILENAME)
        .exists())
}

// ───────────────────────── .perchnote backup archive ─────────────────────────
// Plan v2 rank 12. A restorable, checksummed zip: a VACUUM'd db snapshot,
// every recording and attachment, and a manifest of per-file SHA-256s. The
// JSON "export all" can't restore anything; this can (restore path follows).

#[derive(serde::Serialize, serde::Deserialize)]
struct BackupManifest {
    format: String,
    format_version: u32,
    app_version: String,
    created_at: String,
    files: Vec<BackupFileEntry>,
}

#[derive(serde::Serialize, serde::Deserialize)]
struct BackupFileEntry {
    path: String,
    sha256: String,
    bytes: u64,
}

#[derive(Serialize)]
pub struct BackupSummary {
    pub path: String,
    pub files: usize,
    pub bytes: u64,
}

#[derive(Serialize)]
pub struct BackupVerifyReport {
    pub ok: bool,
    pub checked: usize,
    pub problems: Vec<String>,
}

/// Stream `src` into the zip entry while hashing, returning (sha256-hex, bytes).
fn zip_file_hashed(
    zw: &mut zip::ZipWriter<std::fs::File>,
    src: &std::path::Path,
) -> anyhow::Result<(String, u64)> {
    use sha2::Digest;
    use std::io::{Read, Write};
    let mut f = std::fs::File::open(src)?;
    let mut hasher = sha2::Sha256::new();
    let mut bytes: u64 = 0;
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        zw.write_all(&buf[..n])?;
        bytes += n as u64;
    }
    Ok((format!("{:x}", hasher.finalize()), bytes))
}

/// Collect (zip-relative path, absolute path) for every file under `dir`,
/// recursively, prefixed with `prefix/`. Recursion matters: attachments live
/// in per-meeting subdirectories (`attachments/<meeting_id>/<file>`), and a
/// flat listing would silently drop them all from the backup. Missing dir →
/// empty. Sorted for stable manifests.
fn dir_files(dir: &std::path::Path, prefix: &str) -> Vec<(String, std::path::PathBuf)> {
    fn walk(dir: &std::path::Path, rel: &str, out: &mut Vec<(String, std::path::PathBuf)>) {
        let Ok(rd) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in rd.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().into_owned();
            let child_rel = format!("{rel}/{name}");
            if path.is_dir() {
                walk(&path, &child_rel, out);
            } else if path.is_file() {
                out.push((child_rel, path));
            }
        }
    }
    let mut out = Vec::new();
    walk(dir, prefix, &mut out);
    out.sort();
    out
}

/// Build the archive at `dest`: deflated db snapshot + manifest, stored
/// (uncompressed) recordings/attachments — PCM doesn't deflate and this keeps
/// multi-GB exports IO-bound. Returns (file count, total source bytes).
fn write_backup_archive(
    snapshot_db: &std::path::Path,
    recordings_dir: &std::path::Path,
    attachments_dir: &std::path::Path,
    app_version: &str,
    dest: &std::path::Path,
) -> anyhow::Result<(usize, u64)> {
    use std::io::Write;
    use zip::write::SimpleFileOptions;

    let deflate = SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    let stored = SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Stored)
        .large_file(true);

    let mut zw = zip::ZipWriter::new(std::fs::File::create(dest)?);
    let mut manifest = BackupManifest {
        format: "perchnote-backup".into(),
        format_version: 1,
        app_version: app_version.into(),
        created_at: chrono::Utc::now().to_rfc3339(),
        files: Vec::new(),
    };

    zw.start_file("perchnote.db", deflate)?;
    let (sha, bytes) = zip_file_hashed(&mut zw, snapshot_db)?;
    manifest.files.push(BackupFileEntry { path: "perchnote.db".into(), sha256: sha, bytes });

    let mut media = dir_files(recordings_dir, "recordings");
    media.extend(dir_files(attachments_dir, "attachments"));
    for (rel, abs) in media {
        zw.start_file(&*rel, stored)?;
        let (sha, bytes) = zip_file_hashed(&mut zw, &abs)?;
        manifest.files.push(BackupFileEntry { path: rel, sha256: sha, bytes });
    }

    let count = manifest.files.len();
    let total: u64 = manifest.files.iter().map(|f| f.bytes).sum();
    zw.start_file("manifest.json", deflate)?;
    zw.write_all(serde_json::to_string_pretty(&manifest)?.as_bytes())?;
    zw.finish()?;
    Ok((count, total))
}

/// Re-hash every manifest entry inside the archive and flag extras/misses.
fn verify_archive_file(path: &std::path::Path) -> anyhow::Result<BackupVerifyReport> {
    use sha2::Digest;
    use std::io::Read;

    let mut za = zip::ZipArchive::new(std::fs::File::open(path)?)?;
    let manifest: BackupManifest = {
        let entry = za.by_name("manifest.json")?;
        serde_json::from_reader(entry)?
    };

    let mut problems = Vec::new();
    let listed: std::collections::HashSet<&str> =
        manifest.files.iter().map(|f| f.path.as_str()).collect();
    let extras: Vec<String> = za
        .file_names()
        .filter(|n| *n != "manifest.json" && !listed.contains(n))
        .map(String::from)
        .collect();
    problems.extend(extras.into_iter().map(|n| format!("unexpected entry: {n}")));

    for fi in &manifest.files {
        let Ok(mut entry) = za.by_name(&fi.path) else {
            problems.push(format!("missing: {}", fi.path));
            continue;
        };
        let mut hasher = sha2::Sha256::new();
        let mut buf = vec![0u8; 1 << 20];
        let mut bytes: u64 = 0;
        loop {
            let n = entry.read(&mut buf)?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
            bytes += n as u64;
        }
        let sha = format!("{:x}", hasher.finalize());
        if sha != fi.sha256 || bytes != fi.bytes {
            problems.push(format!("corrupt: {}", fi.path));
        }
    }

    Ok(BackupVerifyReport {
        ok: problems.is_empty(),
        checked: manifest.files.len(),
        problems,
    })
}

/// Export a checksummed `.perchnote` archive to the Desktop (Documents as
/// fallback) and return where it landed. Async: the zip work runs on a
/// blocking thread; only the brief VACUUM holds the db lock.
#[tauri::command]
pub async fn export_backup_archive(
    app: AppHandle,
    db: State<'_, Database>,
) -> Result<BackupSummary, String> {
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let backups_dir = app_data.join("backups");
    std::fs::create_dir_all(&backups_dir).map_err(|e| e.to_string())?;
    let snapshot = backups_dir.join("export-snapshot.db");
    let _ = std::fs::remove_file(&snapshot);
    db.vacuum_into(&snapshot).map_err(|e| e.to_string())?;

    let dest_dir = app
        .path()
        .desktop_dir()
        .or_else(|_| app.path().document_dir())
        .map_err(|e| e.to_string())?;
    let dest = dest_dir.join(format!(
        "Perchnote-backup-{}.perchnote",
        chrono::Local::now().format("%Y-%m-%d-%H%M%S")
    ));
    let recordings = app_data.join("recordings");
    let attachments = app_data.join("attachments");
    let version = app.package_info().version.to_string();

    let dest_for_task = dest.clone();
    let snapshot_for_task = snapshot.clone();
    let result = tokio::task::spawn_blocking(move || {
        write_backup_archive(
            &snapshot_for_task,
            &recordings,
            &attachments,
            &version,
            &dest_for_task,
        )
    })
    .await
    .map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(&snapshot);

    match result {
        Ok((files, bytes)) => Ok(BackupSummary {
            path: dest.to_string_lossy().to_string(),
            files,
            bytes,
        }),
        Err(e) => {
            let _ = std::fs::remove_file(&dest);
            Err(e.to_string())
        }
    }
}

/// Verify a `.perchnote` archive's checksums without touching the live data.
#[tauri::command]
pub async fn verify_backup_archive(path: String) -> Result<BackupVerifyReport, String> {
    tokio::task::spawn_blocking(move || verify_archive_file(std::path::Path::new(&path)))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

// ── Restore ──────────────────────────────────────────────────────────────────
// Restoring can't swap the database under the open connection, so it happens
// in two phases: `restore_backup_archive` verifies the archive and extracts
// it into `restore-staging/` with a marker file, then the app relaunches and
// `apply_pending_restore` (called before the db is opened) performs the swap.

const RESTORE_STAGING_DIR: &str = "restore-staging";
const RESTORE_MARKER: &str = "restore-pending.json";

#[derive(Serialize)]
pub struct BackupCandidate {
    pub path: String,
    pub bytes: u64,
    pub modified: String,
}

/// Zip entry names we are willing to write to disk. Everything else —
/// absolute paths, `..` traversal, unexpected roots — is rejected.
fn safe_restore_rel_path(name: &str) -> Option<std::path::PathBuf> {
    if name == "manifest.json" {
        return None; // metadata, not data — skip silently
    }
    let ok_root = name == "perchnote.db"
        || name.starts_with("recordings/")
        || name.starts_with("attachments/");
    if !ok_root {
        return None;
    }
    let p = std::path::Path::new(name);
    let clean = p
        .components()
        .all(|c| matches!(c, std::path::Component::Normal(_)));
    if !clean || name.ends_with('/') {
        return None;
    }
    Some(p.to_path_buf())
}

/// Extract a verified archive into the staging directory. Returns the number
/// of files written.
fn extract_archive_to_staging(
    archive: &std::path::Path,
    staging: &std::path::Path,
) -> anyhow::Result<usize> {
    let _ = std::fs::remove_dir_all(staging);
    std::fs::create_dir_all(staging)?;
    let mut za = zip::ZipArchive::new(std::fs::File::open(archive)?)?;
    let mut written = 0usize;
    for i in 0..za.len() {
        let mut entry = za.by_index(i)?;
        let Some(rel) = safe_restore_rel_path(entry.name()) else {
            if entry.name() != "manifest.json" {
                anyhow::bail!("archive contains a disallowed entry: {}", entry.name());
            }
            continue;
        };
        let dest = staging.join(rel);
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut out = std::fs::File::create(&dest)?;
        std::io::copy(&mut entry, &mut out)?;
        written += 1;
    }
    Ok(written)
}

/// Finish a staged restore. Runs at startup BEFORE the database is opened.
/// Media files merge additively (files not in the backup are kept — the
/// orphan sweep tolerates extras, while deleting them would be destructive);
/// the database is swapped, with the previous one preserved under
/// `backups/pre-restore-<stamp>*`. Best-effort: any failure logs, restores
/// the previous db, and leaves the staging dir for inspection.
pub fn apply_pending_restore(app_data: &std::path::Path) {
    let staging = app_data.join(RESTORE_STAGING_DIR);
    let marker = staging.join(RESTORE_MARKER);
    if !marker.exists() {
        return;
    }
    let staged_db = staging.join("perchnote.db");
    if !staged_db.exists() {
        log::error!("restore: marker present but no staged db; aborting restore");
        let _ = std::fs::remove_dir_all(&staging);
        return;
    }
    log::info!("restore: applying staged backup restore");

    // 1) Media, additively. A copy failure costs one file, not the restore.
    // Same-id collisions keep the CURRENT disk file (whole-app review P2-9):
    // the same meeting id means the same recording, and the file already on
    // disk is the same audio or a longer continuation of it — the backup's
    // copy is never an upgrade.
    for sub in ["recordings", "attachments"] {
        for (rel, abs) in dir_files(&staging.join(sub), sub) {
            let dest = app_data.join(&rel);
            if dest.exists() {
                log::info!("restore: kept existing {} (backup copy skipped)", rel);
                continue;
            }
            if let Some(parent) = dest.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            if let Err(e) = std::fs::rename(&abs, &dest) {
                log::error!("restore: could not place {}: {}", rel, e);
            }
        }
    }

    // 2) Move the live db aside, keeping it recoverable.
    let stamp = chrono::Utc::now().format("%Y%m%d-%H%M%S");
    let backups = app_data.join("backups");
    let _ = std::fs::create_dir_all(&backups);
    let mut moved_aside: Vec<(std::path::PathBuf, std::path::PathBuf)> = Vec::new();
    for suffix in ["", "-wal", "-shm"] {
        let src = app_data.join(format!("perchnote.db{suffix}"));
        if src.exists() {
            let dst = backups.join(format!("pre-restore-{stamp}.db{suffix}"));
            match std::fs::rename(&src, &dst) {
                Ok(()) => moved_aside.push((src, dst)),
                Err(e) => log::error!("restore: move-aside of {:?} failed: {}", src, e),
            }
        }
    }

    // 3) Swap the staged db in; on failure put the old one back.
    if let Err(e) = std::fs::rename(&staged_db, app_data.join("perchnote.db")) {
        log::error!("restore: db swap failed ({}); rolling back", e);
        for (orig, aside) in moved_aside {
            let _ = std::fs::rename(&aside, &orig);
        }
        return;
    }

    let _ = std::fs::remove_dir_all(&staging);
    log::info!(
        "restore: complete; previous database preserved as backups/pre-restore-{stamp}.db"
    );
}

/// `.perchnote` archives in the usual save spots, newest first.
#[tauri::command]
pub fn list_backup_archives(app: AppHandle) -> Result<Vec<BackupCandidate>, String> {
    let mut dirs: Vec<std::path::PathBuf> = Vec::new();
    if let Ok(d) = app.path().desktop_dir() {
        dirs.push(d);
    }
    if let Ok(d) = app.path().document_dir() {
        dirs.push(d);
    }
    if let Ok(d) = app.path().download_dir() {
        dirs.push(d);
    }
    let mut out: Vec<(std::time::SystemTime, BackupCandidate)> = Vec::new();
    for dir in dirs {
        let Ok(rd) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in rd.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().into_owned();
            if !name.ends_with(".perchnote") {
                continue;
            }
            let Ok(meta) = entry.metadata() else {
                continue;
            };
            let modified = meta.modified().unwrap_or(std::time::UNIX_EPOCH);
            out.push((
                modified,
                BackupCandidate {
                    path: path.to_string_lossy().to_string(),
                    bytes: meta.len(),
                    modified: chrono::DateTime::<chrono::Utc>::from(modified).to_rfc3339(),
                },
            ));
        }
    }
    out.sort_by(|a, b| b.0.cmp(&a.0));
    Ok(out.into_iter().map(|(_, c)| c).collect())
}

/// Verify the archive, stage its contents, and write the restore marker.
/// The UI relaunches the app afterwards; the swap happens on boot.
#[tauri::command]
pub async fn restore_backup_archive(app: AppHandle, path: String) -> Result<usize, String> {
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let staging = app_data.join(RESTORE_STAGING_DIR);
    tokio::task::spawn_blocking(move || -> Result<usize, String> {
        let archive = std::path::Path::new(&path);
        let report = verify_archive_file(archive).map_err(|e| e.to_string())?;
        if !report.ok {
            return Err(format!(
                "archive failed verification: {}",
                report.problems.first().cloned().unwrap_or_default()
            ));
        }
        let written = extract_archive_to_staging(archive, &staging).map_err(|e| e.to_string())?;
        std::fs::write(
            staging.join(RESTORE_MARKER),
            serde_json::json!({
                "source": path,
                "created_at": chrono::Utc::now().to_rfc3339(),
            })
            .to_string(),
        )
        .map_err(|e| e.to_string())?;
        Ok(written)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Relaunch the app — used by the restore flow to trigger the staged swap.
#[tauri::command]
pub fn restart_app(app: AppHandle) {
    app.restart();
}

/// Post a local macOS notification. Lets frontend flows that finish work in
/// the background (instant recap) reach the user when the app isn't focal.
#[tauri::command]
pub fn notify_user(app: AppHandle, title: String, body: String) {
    use tauri_plugin_notification::NotificationExt;
    let _ = app.notification().builder().title(title).body(body).show();
}

#[cfg(test)]
mod backup_archive_tests {
    use super::*;

    fn make_source(dir: &std::path::Path) -> (std::path::PathBuf, std::path::PathBuf, std::path::PathBuf) {
        let db = dir.join("snap.db");
        std::fs::write(&db, b"not-really-sqlite-but-bytes-are-bytes").unwrap();
        let rec = dir.join("recordings");
        std::fs::create_dir_all(&rec).unwrap();
        std::fs::write(rec.join("a.wav"), vec![7u8; 4096]).unwrap();
        std::fs::write(rec.join("b.wav"), vec![9u8; 1024]).unwrap();
        // Attachments are nested per meeting id — the archive must recurse.
        let att = dir.join("attachments");
        std::fs::create_dir_all(att.join("m1")).unwrap();
        std::fs::write(att.join("m1").join("doc.pdf"), b"pdfish").unwrap();
        (db, rec, att)
    }

    #[test]
    fn archive_round_trips_and_verifies_clean() {
        let tmp = tempfile::tempdir().unwrap();
        let (db, rec, att) = make_source(tmp.path());
        let dest = tmp.path().join("out.perchnote");

        let (files, bytes) = write_backup_archive(&db, &rec, &att, "0.0.0-test", &dest).unwrap();
        assert_eq!(files, 4); // db + 2 wavs + 1 attachment
        assert_eq!(bytes, 37 + 4096 + 1024 + 6);

        let report = verify_archive_file(&dest).unwrap();
        assert!(report.ok, "problems: {:?}", report.problems);
        assert_eq!(report.checked, 4);
    }

    #[test]
    fn verify_flags_a_tampered_entry() {
        use std::io::Write;
        let tmp = tempfile::tempdir().unwrap();
        let (db, rec, att) = make_source(tmp.path());
        let legit = tmp.path().join("legit.perchnote");
        write_backup_archive(&db, &rec, &att, "0.0.0-test", &legit).unwrap();

        // Rebuild the archive with one wav's bytes flipped but the ORIGINAL
        // manifest carried over — exactly what silent corruption looks like.
        let mut za = zip::ZipArchive::new(std::fs::File::open(&legit).unwrap()).unwrap();
        let manifest_raw = {
            use std::io::Read;
            let mut e = za.by_name("manifest.json").unwrap();
            let mut s = String::new();
            e.read_to_string(&mut s).unwrap();
            s
        };
        let tampered = tmp.path().join("tampered.perchnote");
        let mut zw = zip::ZipWriter::new(std::fs::File::create(&tampered).unwrap());
        let opts = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        for name in ["perchnote.db", "attachments/m1/doc.pdf", "recordings/a.wav", "recordings/b.wav"] {
            use std::io::Read;
            let mut data = Vec::new();
            za.by_name(name).unwrap().read_to_end(&mut data).unwrap();
            if name == "recordings/a.wav" {
                data[100] ^= 0xFF;
            }
            zw.start_file(name, opts).unwrap();
            zw.write_all(&data).unwrap();
        }
        zw.start_file("manifest.json", opts).unwrap();
        zw.write_all(manifest_raw.as_bytes()).unwrap();
        zw.finish().unwrap();

        let report = verify_archive_file(&tampered).unwrap();
        assert!(!report.ok);
        assert_eq!(report.problems, vec!["corrupt: recordings/a.wav".to_string()]);
    }

    #[test]
    fn verify_flags_missing_and_unexpected_entries() {
        use std::io::Write;
        let tmp = tempfile::tempdir().unwrap();
        let (db, rec, att) = make_source(tmp.path());
        let legit = tmp.path().join("legit.perchnote");
        write_backup_archive(&db, &rec, &att, "0.0.0-test", &legit).unwrap();

        let mut za = zip::ZipArchive::new(std::fs::File::open(&legit).unwrap()).unwrap();
        let manifest_raw = {
            use std::io::Read;
            let mut e = za.by_name("manifest.json").unwrap();
            let mut s = String::new();
            e.read_to_string(&mut s).unwrap();
            s
        };
        // Drop b.wav (missing) and add an interloper (unexpected).
        let bad = tmp.path().join("bad.perchnote");
        let mut zw = zip::ZipWriter::new(std::fs::File::create(&bad).unwrap());
        let opts = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        for name in ["perchnote.db", "attachments/m1/doc.pdf", "recordings/a.wav"] {
            use std::io::Read;
            let mut data = Vec::new();
            za.by_name(name).unwrap().read_to_end(&mut data).unwrap();
            zw.start_file(name, opts).unwrap();
            zw.write_all(&data).unwrap();
        }
        zw.start_file("evil.txt", opts).unwrap();
        zw.write_all(b"surprise").unwrap();
        zw.start_file("manifest.json", opts).unwrap();
        zw.write_all(manifest_raw.as_bytes()).unwrap();
        zw.finish().unwrap();

        let report = verify_archive_file(&bad).unwrap();
        assert!(!report.ok);
        assert!(report.problems.contains(&"unexpected entry: evil.txt".to_string()));
        assert!(report.problems.contains(&"missing: recordings/b.wav".to_string()));
    }

    #[test]
    fn staging_extraction_round_trips_every_file() {
        let tmp = tempfile::tempdir().unwrap();
        let (db, rec, att) = make_source(tmp.path());
        let archive = tmp.path().join("out.perchnote");
        write_backup_archive(&db, &rec, &att, "0.0.0-test", &archive).unwrap();

        let staging = tmp.path().join("staging");
        let written = extract_archive_to_staging(&archive, &staging).unwrap();
        assert_eq!(written, 4);
        assert_eq!(
            std::fs::read(staging.join("perchnote.db")).unwrap(),
            b"not-really-sqlite-but-bytes-are-bytes"
        );
        assert_eq!(
            std::fs::read(staging.join("attachments/m1/doc.pdf")).unwrap(),
            b"pdfish"
        );
        assert_eq!(std::fs::read(staging.join("recordings/a.wav")).unwrap(), vec![7u8; 4096]);
    }

    #[test]
    fn extraction_rejects_zip_slip_entries() {
        use std::io::Write;
        let tmp = tempfile::tempdir().unwrap();
        let evil = tmp.path().join("evil.perchnote");
        let mut zw = zip::ZipWriter::new(std::fs::File::create(&evil).unwrap());
        let opts = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        zw.start_file("perchnote.db", opts).unwrap();
        zw.write_all(b"db").unwrap();
        zw.start_file("recordings/../../escape.wav", opts).unwrap();
        zw.write_all(b"gotcha").unwrap();
        zw.finish().unwrap();

        let staging = tmp.path().join("staging");
        let err = extract_archive_to_staging(&evil, &staging).unwrap_err();
        assert!(err.to_string().contains("disallowed entry"), "{err}");
        assert!(!tmp.path().join("escape.wav").exists());
    }

    #[test]
    fn pending_restore_swaps_db_and_merges_media() {
        let tmp = tempfile::tempdir().unwrap();
        let app_data = tmp.path();

        // Live state: an old db and one existing recording NOT in the backup.
        std::fs::write(app_data.join("perchnote.db"), b"OLD-DB").unwrap();
        std::fs::write(app_data.join("perchnote.db-wal"), b"OLD-WAL").unwrap();
        std::fs::create_dir_all(app_data.join("recordings")).unwrap();
        std::fs::write(app_data.join("recordings/keep-me.wav"), b"existing").unwrap();

        // Staged restore.
        let staging = app_data.join("restore-staging");
        std::fs::create_dir_all(staging.join("recordings")).unwrap();
        std::fs::create_dir_all(staging.join("attachments/m1")).unwrap();
        std::fs::write(staging.join("perchnote.db"), b"NEW-DB").unwrap();
        std::fs::write(staging.join("recordings/restored.wav"), b"from-backup").unwrap();
        std::fs::write(staging.join("attachments/m1/doc.pdf"), b"pdfish").unwrap();
        std::fs::write(staging.join("restore-pending.json"), b"{}").unwrap();

        apply_pending_restore(app_data);

        // Db swapped, old one preserved under backups/pre-restore-*.
        assert_eq!(std::fs::read(app_data.join("perchnote.db")).unwrap(), b"NEW-DB");
        let preserved: Vec<_> = std::fs::read_dir(app_data.join("backups"))
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert!(preserved.iter().any(|n| n.starts_with("pre-restore-") && n.ends_with(".db")));
        assert!(preserved.iter().any(|n| n.ends_with(".db-wal")));
        // Media merged additively; staging cleaned up.
        assert_eq!(std::fs::read(app_data.join("recordings/restored.wav")).unwrap(), b"from-backup");
        assert_eq!(std::fs::read(app_data.join("recordings/keep-me.wav")).unwrap(), b"existing");
        assert_eq!(std::fs::read(app_data.join("attachments/m1/doc.pdf")).unwrap(), b"pdfish");
        assert!(!staging.exists());
    }

    #[test]
    fn pending_restore_is_a_noop_without_marker() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("perchnote.db"), b"OLD-DB").unwrap();
        apply_pending_restore(tmp.path());
        assert_eq!(std::fs::read(tmp.path().join("perchnote.db")).unwrap(), b"OLD-DB");
    }
}

// ───────────────────────── Update check (plan v4) ────────────────────────────
// Manual only, user-initiated: auto-updating an ad-hoc-signed app would
// invalidate the TCC microphone/Screen-Recording grants on every release,
// so until the app is Developer-ID signed this stays a check + link.

/// Numeric triple comparison: is `latest` newer than `current`?
fn version_newer(latest: &str, current: &str) -> bool {
    fn triple(v: &str) -> [u64; 3] {
        let mut out = [0u64; 3];
        for (i, part) in v.trim_start_matches('v').split('.').take(3).enumerate() {
            out[i] = part
                .chars()
                .take_while(|c| c.is_ascii_digit())
                .collect::<String>()
                .parse()
                .unwrap_or(0);
        }
        out
    }
    triple(latest) > triple(current)
}

#[derive(Serialize)]
pub struct UpdateCheck {
    pub current: String,
    pub latest: String,
    pub url: String,
    pub update_available: bool,
}

#[tauri::command]
pub async fn check_for_update() -> Result<UpdateCheck, String> {
    #[derive(serde::Deserialize)]
    struct Release {
        tag_name: String,
        html_url: String,
    }
    let current = env!("CARGO_PKG_VERSION").to_string();
    let resp = reqwest::Client::new()
        .get("https://api.github.com/repos/GurtekS/perchnote/releases/latest")
        .header("user-agent", concat!("Perchnote/", env!("CARGO_PKG_VERSION")))
        .header("accept", "application/vnd.github+json")
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| format!("update check failed: {e}"))?
        .error_for_status()
        .map_err(|e| format!("update check failed: {e}"))?;
    let release: Release = resp.json().await.map_err(|e| e.to_string())?;
    let latest = release.tag_name.trim_start_matches('v').to_string();
    Ok(UpdateCheck {
        update_available: version_newer(&latest, &current),
        current,
        latest,
        url: release.html_url,
    })
}

#[cfg(test)]
mod update_tests {
    use super::version_newer;

    #[test]
    fn compares_versions_numerically() {
        assert!(version_newer("0.4.1", "0.4.0"));
        assert!(version_newer("v0.5.0", "0.4.9"));
        assert!(version_newer("1.0.0", "0.99.99"));
        assert!(!version_newer("0.4.0", "0.4.0"));
        assert!(!version_newer("0.3.9", "0.4.0"));
        assert!(!version_newer("garbage", "0.4.0"));
    }
}

// ───────────────────────── Markdown mirror (plan v3 rank 10) ─────────────────
// "Your data is just files": optionally mirror each meeting's notes as a
// Markdown file in ~/Documents/Perchnote — iCloud/git/Obsidian pick them up
// for free. The frontend owns TipTap→Markdown (its serializer is the single
// source of truth); this side owns paths, naming, and writing.

/// Shared character rules for anything that becomes a single path component
/// (file stems, layout subdirectories): separators and other unsafe characters
/// become spaces, whitespace collapses, and leading/trailing dots go — so the
/// result can never traverse or nest. May be empty; callers pick the fallback.
fn sanitize_path_component(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => ' ',
            c if c.is_control() => ' ',
            c => c,
        })
        .collect();
    let collapsed = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    collapsed.trim_matches(['.', ' ']).chars().take(120).collect()
}

/// A filesystem-safe file stem from a meeting title.
fn safe_md_stem(title: &str) -> String {
    let stem = sanitize_path_component(title);
    if stem.is_empty() { "Untitled".to_string() } else { stem }
}

/// Where inside the vault a mirror write lands, per the `md_mirror_layout`
/// setting (plan v8 B4). Every component is fixed-width digits or a sanitized
/// single component, so the path can't escape the vault by construction;
/// anything unresolvable (no folder, malformed date, unknown layout) falls
/// back to the vault root — i.e. the flat layout.
fn mirror_rel_dir(layout: &str, date: &str, first_folder: Option<&str>) -> std::path::PathBuf {
    match layout {
        "monthly" => {
            let b = date.as_bytes();
            let dated = b.len() >= 7
                && b[..4].iter().all(u8::is_ascii_digit)
                && b[4] == b'-'
                && b[5..7].iter().all(u8::is_ascii_digit);
            if dated {
                std::path::Path::new(&date[..4]).join(&date[5..7])
            } else {
                std::path::PathBuf::new()
            }
        }
        "by-folder" => match first_folder.map(sanitize_path_component) {
            Some(name) if !name.is_empty() => std::path::PathBuf::from(name),
            _ => std::path::PathBuf::new(),
        },
        _ => std::path::PathBuf::new(), // "flat", unset, or unknown
    }
}

/// What one mirror write actually did, for the frontend to surface
/// (plan v10 #9).
#[derive(serde::Serialize)]
pub struct MirrorWriteResult {
    /// Absolute path written: the mirror file itself, or the `.conflict.md`
    /// beside it when the write conflicted. Empty when the mirror is off.
    pub path: String,
    /// True when the on-disk file held an external edit, so the new content
    /// went to a `.conflict.md` instead of overwriting it.
    pub conflicted: bool,
}

/// Write one meeting's Markdown into the mirror folder. Returns the path
/// written and whether the clobber guard diverted it to a `.conflict.md`.
/// No-op (empty path) when the mirror is disabled.
#[tauri::command]
pub fn write_md_mirror(
    app: AppHandle,
    db: State<'_, Database>,
    meeting_id: String,
    markdown: String,
) -> Result<MirrorWriteResult, String> {
    validate_uuid(&meeting_id)?;
    let enabled = db
        .get_setting("md_mirror_enabled")
        .ok()
        .flatten()
        .as_deref()
        == Some("true");
    if !enabled {
        return Ok(MirrorWriteResult { path: String::new(), conflicted: false });
    }
    let meeting = db
        .get_meeting(&meeting_id)
        .map_err(|e| e.to_string())?
        .ok_or("meeting not found")?;
    let vault = app
        .path()
        .document_dir()
        .map_err(|e| e.to_string())?
        .join("Perchnote");
    let date: String = meeting
        .scheduled_start
        .as_deref()
        .or(meeting.actual_start.as_deref())
        .unwrap_or(&meeting.created_at)
        .chars()
        .take(10)
        .collect();
    let layout = db
        .get_setting(MIRROR_LAYOUT_KEY)
        .ok()
        .flatten()
        .unwrap_or_default();
    // Folder lookup only when the layout files by it; a lookup hiccup or an
    // unfiled meeting lands in the vault root.
    let first_folder = (layout == "by-folder")
        .then(|| db.get_first_folder_name_for_meeting(&meeting_id).ok().flatten())
        .flatten();
    let dir = vault.join(mirror_rel_dir(&layout, &date, first_folder.as_deref()));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    // Two meetings with the same title and day used to derive the SAME file
    // and take turns "conflicting" with each other through one shared
    // .conflict.md (QA audit P3-9). Disambiguate instead: a path another
    // meeting already tracks gets a numbered variant, so sharing never
    // starts. (Entries that already share a path from before this fix keep
    // working — the refcounted cleanup never deletes a still-tracked file.)
    let current = db.get_setting(MIRROR_PATHS_KEY).ok().flatten();
    let path = disambiguate_mirror_path(
        current.as_deref(),
        &meeting_id,
        &dir,
        &date,
        &safe_md_stem(&meeting.title),
    );
    // The guarded write (plan v10 #9) decides whether `path` is safe to
    // overwrite or the content must divert to a `.conflict.md`; on a clean
    // write it also runs the lifecycle bookkeeping (plan v8 B2/B4): the path
    // derives from title + layout, so a rename or a layout switch re-derives
    // it — track where this meeting last landed and remove the file the
    // previous write left behind, instead of forking into two.
    let (written, conflicted, updated) =
        guarded_mirror_write(&vault, current.as_deref(), &meeting_id, &path, markdown.as_bytes())?;
    if let Some(updated) = updated {
        // Bookkeeping is best-effort; the write stands.
        if let Err(e) = db.set_setting(MIRROR_PATHS_KEY, &updated) {
            log::warn!("mirror: could not update {MIRROR_PATHS_KEY}: {e}");
        }
    }
    Ok(MirrorWriteResult { path: written.to_string_lossy().to_string(), conflicted })
}

// Mirror lifecycle (plan v8 B2): the settings row `mirror_paths` holds a JSON
// map of meeting_id → last write, stored as `{"path": <absolute path>,
// "hash": <sha256-hex of the bytes written>}`. The path lets a title rename
// move the mirror instead of forking it and a hard delete take the vault copy
// with it; the hash powers the clobber guard (plan v10 #9). Entries written
// before the guard existed are plain path strings — they parse leniently
// (path known, hash unknown) and upgrade to the object shape on their next
// write. No schema change — it rides the existing settings k/v table.

const MIRROR_PATHS_KEY: &str = "mirror_paths";

/// The first "{date} {stem}.md" / "{date} {stem} (N).md" path in `dir` that
/// no OTHER meeting currently tracks (QA audit P3-9: a shared path made
/// same-title-same-day meetings alternate conflict diversions forever).
/// This meeting's own tracked path is always acceptable — re-writes stay
/// stable. Capped suffix as a runaway guard; the cap case just shares.
fn disambiguate_mirror_path(
    map_json: Option<&str>,
    meeting_id: &str,
    dir: &std::path::Path,
    date: &str,
    stem: &str,
) -> std::path::PathBuf {
    let map = parse_mirror_paths(map_json);
    for n in 1..=50u32 {
        let name = if n == 1 {
            format!("{date} {stem}.md")
        } else {
            format!("{date} {stem} ({n}).md")
        };
        let candidate = dir.join(name);
        let cstr = candidate.to_string_lossy();
        let taken_by_other = map
            .iter()
            .any(|(k, v)| k != meeting_id && mirror_entry_path(v) == Some(cstr.as_ref()));
        if !taken_by_other {
            return candidate;
        }
    }
    dir.join(format!("{date} {stem}.md"))
}

/// Layout setting (plan v8 B4): "flat" (default), "monthly", or "by-folder".
/// Resolved per write, so a change migrates lazily — no mass move.
const MIRROR_LAYOUT_KEY: &str = "md_mirror_layout";

/// The clobber guard (plan v10 #9): perform one mirror write without ever
/// overwriting an external edit.
///
/// Each tracked entry remembers the sha256 of the bytes Perchnote last wrote
/// there. When the next write targets the same file and the bytes on disk no
/// longer hash to that value, someone — Obsidian, the user — edited the file:
/// their copy stays untouched and the new content lands in
/// `<stem>.conflict.md` beside it instead. One conflict file per note, latest
/// wins: a later conflicted write overwrites the previous `.conflict.md`.
/// The map keeps tracking the ORIGINAL path, so rename/delete lifecycle
/// still targets the user's file, and the next write re-checks it.
///
/// NOT a conflict (the write proceeds normally and re-records the hash):
/// - no on-disk file at the target (the user deleted it — recreate it);
/// - on-disk bytes equal the INCOMING bytes — e.g. the user accepted a
///   previous conflict by copying the `.conflict.md` over the original, so
///   overwriting is a byte-identical no-op and the entry just re-syncs;
/// - a tracked entry with no recorded hash (written before the guard
///   existed): treated as unknown — this write behaves as it always did,
///   then records a hash for the next one;
/// - a different target path (title rename / layout switch): the existing
///   lifecycle semantics apply unchanged.
///
/// Hashes compare the raw bytes read and written — no line-ending or
/// encoding normalization, so any external byte change counts as an edit.
///
/// Returns (path actually written, conflicted, updated map JSON to persist —
/// `None` when a conflict left the bookkeeping deliberately untouched).
fn guarded_mirror_write(
    vault: &std::path::Path,
    prior_json: Option<&str>,
    meeting_id: &str,
    target: &std::path::Path,
    markdown: &[u8],
) -> Result<(std::path::PathBuf, bool, Option<String>), String> {
    let incoming = sha256_hex(markdown);
    let externally_edited = match mirror_paths_get(prior_json, meeting_id) {
        Some((tracked, Some(stored))) => {
            let tracked = std::path::Path::new(&tracked);
            // String equality catches the common case; same_file catches a
            // case-only title rename deriving a new spelling of the same
            // APFS file. Either way `target` names the file we last wrote.
            (tracked == target || same_file(tracked, target))
                && match std::fs::read(target) {
                    Ok(bytes) => {
                        let on_disk = sha256_hex(&bytes);
                        on_disk != stored && on_disk != incoming
                    }
                    // Missing (or unreadable) file — nothing to clobber.
                    Err(_) => false,
                }
        }
        _ => false, // untracked, or a legacy entry that has no hash yet
    };
    if externally_edited {
        let conflict = conflict_path_for(target);
        std::fs::write(&conflict, markdown).map_err(|e| e.to_string())?;
        return Ok((conflict, true, None));
    }
    std::fs::write(target, markdown).map_err(|e| e.to_string())?;
    let updated = mirror_track_and_cleanup(vault, prior_json, meeting_id, target, &incoming);
    Ok((target.to_path_buf(), false, Some(updated)))
}

/// Where a conflicted write lands: `2026-06-10 Sync.md` →
/// `2026-06-10 Sync.conflict.md`, in the same directory.
fn conflict_path_for(target: &std::path::Path) -> std::path::PathBuf {
    target.with_extension("conflict.md")
}

/// Lowercase-hex sha256 of raw bytes.
fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::Digest;
    format!("{:x}", sha2::Sha256::digest(bytes))
}

/// Track a finished write in the `mirror_paths` map and clean up the file the
/// meeting's previous write left elsewhere (a title rename or layout switch
/// both re-derive the path). Returns the updated map for the caller to persist.
fn mirror_track_and_cleanup(
    vault: &std::path::Path,
    prior_json: Option<&str>,
    meeting_id: &str,
    written: &std::path::Path,
    written_hash: &str,
) -> String {
    let prior_entry = mirror_paths_get(prior_json, meeting_id);
    let written_str = written.to_string_lossy().to_string();
    let (updated, previous) = mirror_paths_insert(prior_json, meeting_id, &written_str, written_hash);
    if let Some(prev) = previous.filter(|p| *p != written_str) {
        // Two meetings can derive the same filename (same title + day);
        // never remove a path another meeting still tracks.
        if !mirror_paths_references(&updated, &prev) {
            // The clobber guard's contract extends to cleanup (plan v10 #9):
            // a title rename or layout switch re-derives the path, but the
            // file left at the OLD path may hold external edits. Known hash
            // + on-disk mismatch → it's the user's now; leave it in place.
            // Legacy entries (no recorded hash) keep their original behavior.
            let stored = prior_entry
                .as_ref()
                .and_then(|(p, h)| (*p == prev).then(|| h.clone()).flatten());
            let externally_edited = match (&stored, std::fs::read(&prev)) {
                (Some(stored), Ok(bytes)) => sha256_hex(&bytes) != *stored,
                _ => false,
            };
            if externally_edited {
                log::info!("mirror: {prev} was edited outside the app — leaving it in place");
            } else {
                remove_mirror_file(vault, std::path::Path::new(&prev), Some(written));
            }
        }
    }
    updated
}

/// Parse the stored map; absent or corrupt JSON degrades to an empty map.
fn parse_mirror_paths(json: Option<&str>) -> serde_json::Map<String, serde_json::Value> {
    match json.and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok()) {
        Some(serde_json::Value::Object(map)) => map,
        _ => serde_json::Map::new(),
    }
}

/// One entry's tracked path. Reads the current `{path, hash}` objects AND the
/// plain string entries written before plan v10 #9 — the lenient upgrade:
/// old entries stay valid, they just don't know their hash yet.
fn mirror_entry_path(v: &serde_json::Value) -> Option<&str> {
    match v {
        serde_json::Value::String(s) => Some(s),
        serde_json::Value::Object(o) => o.get("path").and_then(|p| p.as_str()),
        _ => None,
    }
}

/// The sha256 recorded for an entry; `None` for legacy string entries.
fn mirror_entry_hash(v: &serde_json::Value) -> Option<&str> {
    v.as_object()?.get("hash")?.as_str()
}

/// Look up one meeting's tracked (path, hash-if-known).
fn mirror_paths_get(json: Option<&str>, meeting_id: &str) -> Option<(String, Option<String>)> {
    let map = parse_mirror_paths(json);
    let entry = map.get(meeting_id)?;
    let path = mirror_entry_path(entry)?.to_string();
    Some((path, mirror_entry_hash(entry).map(str::to_string)))
}

/// Insert meeting_id → {path, hash}. Returns (serialized map, previously
/// tracked path).
fn mirror_paths_insert(
    json: Option<&str>,
    meeting_id: &str,
    path: &str,
    hash: &str,
) -> (String, Option<String>) {
    let mut map = parse_mirror_paths(json);
    let previous = map
        .insert(meeting_id.to_string(), serde_json::json!({ "path": path, "hash": hash }))
        .and_then(|v| mirror_entry_path(&v).map(str::to_string));
    (serde_json::Value::Object(map).to_string(), previous)
}

/// Drop a meeting's entry. Returns (serialized map, the path it tracked).
fn mirror_paths_remove(json: Option<&str>, meeting_id: &str) -> (String, Option<String>) {
    let mut map = parse_mirror_paths(json);
    let removed = map
        .remove(meeting_id)
        .and_then(|v| mirror_entry_path(&v).map(str::to_string));
    (serde_json::Value::Object(map).to_string(), removed)
}

/// Does any remaining meeting still track `path`?
fn mirror_paths_references(json: &str, path: &str) -> bool {
    parse_mirror_paths(Some(json))
        .values()
        .any(|v| mirror_entry_path(v) == Some(path))
}

/// True when both paths name the same on-disk file. dev+inode, not string or
/// canonical-path equality — APFS is case-insensitive, so a case-only title
/// rename derives a "different" path that still names the same file.
fn same_file(a: &std::path::Path, b: &std::path::Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    match (std::fs::metadata(a), std::fs::metadata(b)) {
        (Ok(a), Ok(b)) => a.dev() == b.dev() && a.ino() == b.ino(),
        _ => false,
    }
}

/// Best-effort removal of a previously mirrored file. Deletes only when the
/// path canonicalizes (symlinks resolved) to a real `.md` strictly inside
/// `vault`, and isn't the same file as `keep` — the file a rename just wrote.
fn remove_mirror_file(vault: &std::path::Path, stale: &std::path::Path, keep: Option<&std::path::Path>) {
    let (Ok(vault), Ok(stale)) = (vault.canonicalize(), stale.canonicalize()) else {
        return; // vault or file already gone — nothing to remove
    };
    if !stale.starts_with(&vault) || stale == vault {
        return;
    }
    if stale.extension().and_then(|e| e.to_str()) != Some("md") {
        return;
    }
    // Conflict files hold the user's unmerged external edits (plan v10 #9).
    // They are the USER's to resolve and are never auto-deleted — not by a
    // rename, a layout switch, or a hard delete. (Tracked paths never point
    // at one; this guards against a corrupt map ever aiming us at one.)
    if stale
        .file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n.ends_with(".conflict.md"))
    {
        return;
    }
    if keep.is_some_and(|k| same_file(k, &stale)) {
        return;
    }
    if let Err(e) = std::fs::remove_file(&stale) {
        log::warn!("mirror: could not remove stale file {}: {e}", stale.display());
        return;
    }
    // A layout switch strands 2026/06-style dirs once their last file moves
    // out; prune upward, strictly inside the vault — never the vault root.
    // remove_dir refuses non-empty dirs, and the first refusal ends the walk.
    let mut parent = stale.parent();
    while let Some(dir) = parent {
        if dir == vault || !dir.starts_with(&vault) || std::fs::remove_dir(dir).is_err() {
            break;
        }
        parent = dir.parent();
    }
}

/// Hard-delete hook (plan v8 B2): drop the meeting's `mirror_paths` entry and
/// remove its mirrored .md. Deliberately ignores `md_mirror_enabled` — a file
/// we wrote for a now-purged meeting is exactly the kind of artifact hard
/// delete promises to take with it. Soft delete (trash) never calls this.
/// A `.conflict.md` left beside the file by the clobber guard (plan v10 #9)
/// stays: it holds content the user never reviewed, and the dir prune below
/// naturally refuses to remove a directory that still contains it.
pub(crate) fn remove_mirror_on_hard_delete(app: &AppHandle, db: &Database, meeting_id: &str) {
    let current = db.get_setting(MIRROR_PATHS_KEY).ok().flatten();
    let (updated, removed) = mirror_paths_remove(current.as_deref(), meeting_id);
    let Some(removed) = removed else { return };
    if let Err(e) = db.set_setting(MIRROR_PATHS_KEY, &updated) {
        log::warn!("mirror: could not update {MIRROR_PATHS_KEY}: {e}");
    }
    if mirror_paths_references(&updated, &removed) {
        return; // shared filename — another meeting still owns this file
    }
    let Ok(doc_dir) = app.path().document_dir() else { return };
    remove_mirror_file(&doc_dir.join("Perchnote"), std::path::Path::new(&removed), None);
}

#[cfg(test)]
mod md_mirror_tests {
    use super::{mirror_rel_dir, safe_md_stem};
    use std::path::PathBuf;

    #[test]
    fn stems_are_filesystem_safe() {
        assert_eq!(safe_md_stem("Design Sync: Q2/Q3 *plans*?"), "Design Sync Q2 Q3 plans");
        assert_eq!(safe_md_stem("   "), "Untitled");
        assert_eq!(safe_md_stem("a/b\\c:d"), "a b c d");
        assert_eq!(safe_md_stem("ends with dot."), "ends with dot");
        assert!(safe_md_stem(&"x".repeat(500)).chars().count() <= 120);
    }

    #[test]
    fn flat_unset_and_unknown_layouts_resolve_to_the_vault_root() {
        assert_eq!(mirror_rel_dir("flat", "2026-06-10", None), PathBuf::new());
        assert_eq!(mirror_rel_dir("", "2026-06-10", Some("Work")), PathBuf::new());
        assert_eq!(mirror_rel_dir("yearly", "2026-06-10", Some("Work")), PathBuf::new());
    }

    #[test]
    fn monthly_layout_resolves_to_year_slash_month() {
        assert_eq!(mirror_rel_dir("monthly", "2026-06-10", None), PathBuf::from("2026/06"));
        assert_eq!(mirror_rel_dir("monthly", "1999-01-02", Some("ignored")), PathBuf::from("1999/01"));
        // Malformed dates land in the vault root, never in a junk dir.
        assert_eq!(mirror_rel_dir("monthly", "garbage", None), PathBuf::new());
        assert_eq!(mirror_rel_dir("monthly", "2026/06/10", None), PathBuf::new());
        assert_eq!(mirror_rel_dir("monthly", "", None), PathBuf::new());
    }

    #[test]
    fn by_folder_layout_uses_one_sanitized_component_or_the_root() {
        assert_eq!(
            mirror_rel_dir("by-folder", "2026-06-10", Some("Client Work")),
            PathBuf::from("Client Work")
        );
        // Hostile names cannot traverse or nest — same rules as safe_md_stem.
        assert_eq!(mirror_rel_dir("by-folder", "2026-06-10", Some("../../evil")), PathBuf::from("evil"));
        assert_eq!(mirror_rel_dir("by-folder", "2026-06-10", Some("a/b\\c")), PathBuf::from("a b c"));
        assert_eq!(mirror_rel_dir("by-folder", "2026-06-10", Some("..")), PathBuf::new());
        assert_eq!(mirror_rel_dir("by-folder", "2026-06-10", Some("   ")), PathBuf::new());
        // Unfiled meetings stay in the vault root.
        assert_eq!(mirror_rel_dir("by-folder", "2026-06-10", None), PathBuf::new());
    }
}

#[cfg(test)]
mod mirror_lifecycle_tests {
    use super::{
        mirror_paths_get, mirror_paths_insert, mirror_paths_references, mirror_paths_remove,
        mirror_rel_dir, mirror_track_and_cleanup, remove_mirror_file,
    };

    #[test]
    fn insert_tracks_path_and_returns_previous() {
        let (json, prev) = mirror_paths_insert(None, "m1", "/v/2026-06-09 Sync.md", "h1");
        assert_eq!(prev, None);
        let (json, prev) = mirror_paths_insert(Some(&json), "m1", "/v/2026-06-09 Renamed.md", "h2");
        assert_eq!(prev.as_deref(), Some("/v/2026-06-09 Sync.md"));
        assert!(json.contains("Renamed"));
        assert!(!json.contains("Sync.md"));
        assert_eq!(
            mirror_paths_get(Some(&json), "m1"),
            Some(("/v/2026-06-09 Renamed.md".into(), Some("h2".into())))
        );
    }

    #[test]
    fn corrupt_map_degrades_to_empty() {
        let (json, prev) = mirror_paths_insert(Some("not json at all"), "m1", "/v/a.md", "h");
        assert_eq!(prev, None);
        assert_eq!(
            mirror_paths_get(Some(&json), "m1"),
            Some(("/v/a.md".into(), Some("h".into())))
        );
        // Non-object JSON likewise.
        let (json, removed) = mirror_paths_remove(Some("[1,2]"), "m1");
        assert_eq!(json, "{}");
        assert_eq!(removed, None);
    }

    #[test]
    fn legacy_string_entries_parse_leniently_and_upgrade_on_insert() {
        // A map written before plan v10 #9 holds plain path strings.
        let legacy = r#"{"m1":"/v/2026-06-09 Sync.md","m2":"/v/b.md"}"#;
        // The path reads fine; the hash is simply unknown.
        assert_eq!(
            mirror_paths_get(Some(legacy), "m1"),
            Some(("/v/2026-06-09 Sync.md".into(), None))
        );
        // remove/references see legacy paths too.
        assert!(mirror_paths_references(legacy, "/v/b.md"));
        let (json, removed) = mirror_paths_remove(Some(legacy), "m2");
        assert_eq!(removed.as_deref(), Some("/v/b.md"));
        // The next write upgrades the entry to {path, hash} in place.
        let (json, prev) = mirror_paths_insert(Some(&json), "m1", "/v/2026-06-09 Sync.md", "h1");
        assert_eq!(prev.as_deref(), Some("/v/2026-06-09 Sync.md"));
        assert_eq!(
            mirror_paths_get(Some(&json), "m1"),
            Some(("/v/2026-06-09 Sync.md".into(), Some("h1".into())))
        );
    }

    #[test]
    fn remove_drops_entry_and_returns_tracked_path() {
        let (json, _) = mirror_paths_insert(None, "m1", "/v/a.md", "ha");
        let (json, _) = mirror_paths_insert(Some(&json), "m2", "/v/b.md", "hb");
        let (json, removed) = mirror_paths_remove(Some(&json), "m1");
        assert_eq!(removed.as_deref(), Some("/v/a.md"));
        assert!(!json.contains("m1"));
        assert!(json.contains("m2"));
        // Removing an untracked meeting reports nothing to delete.
        let (_, removed) = mirror_paths_remove(Some(&json), "m1");
        assert_eq!(removed, None);
    }

    #[test]
    fn references_sees_paths_shared_by_other_meetings() {
        let (json, _) = mirror_paths_insert(None, "m1", "/v/2026-06-09 Untitled.md", "h");
        let (json, _) = mirror_paths_insert(Some(&json), "m2", "/v/2026-06-09 Untitled.md", "h");
        let (json, removed) = mirror_paths_remove(Some(&json), "m1");
        assert!(mirror_paths_references(&json, removed.as_deref().unwrap()));
        let (json, removed) = mirror_paths_remove(Some(&json), "m2");
        assert!(!mirror_paths_references(&json, removed.as_deref().unwrap()));
    }

    #[test]
    fn delete_only_inside_vault() {
        let tmp = tempfile::tempdir().unwrap();
        let vault = tmp.path().join("vault");
        std::fs::create_dir_all(&vault).unwrap();
        let inside = vault.join("a.md");
        let outside = tmp.path().join("outside.md");
        std::fs::write(&inside, "x").unwrap();
        std::fs::write(&outside, "x").unwrap();

        remove_mirror_file(&vault, &outside, None);
        assert!(outside.exists(), "must never delete outside the vault");

        remove_mirror_file(&vault, &inside, None);
        assert!(!inside.exists(), "vault-contained .md should be removed");

        // Already gone — a stale tracked path is a quiet no-op.
        remove_mirror_file(&vault, &inside, None);
    }

    #[test]
    fn delete_refuses_symlink_escape_and_non_md() {
        let tmp = tempfile::tempdir().unwrap();
        let vault = tmp.path().join("vault");
        std::fs::create_dir_all(&vault).unwrap();
        let secret = tmp.path().join("secret.md");
        std::fs::write(&secret, "x").unwrap();
        let link = vault.join("link.md");
        std::os::unix::fs::symlink(&secret, &link).unwrap();

        // Canonicalizes to outside the vault → untouched (link included).
        remove_mirror_file(&vault, &link, None);
        assert!(secret.exists());
        assert!(link.exists());

        let txt = vault.join("notes.txt");
        std::fs::write(&txt, "x").unwrap();
        remove_mirror_file(&vault, &txt, None);
        assert!(txt.exists(), "only .md files are ever removed");
    }

    #[test]
    fn delete_keeps_the_file_a_case_only_rename_just_wrote() {
        let tmp = tempfile::tempdir().unwrap();
        let vault = tmp.path().join("vault");
        std::fs::create_dir_all(&vault).unwrap();
        let written = vault.join("2026-06-09 Sync.md");
        std::fs::write(&written, "fresh").unwrap();

        // On case-insensitive APFS the stale spelling names the SAME file the
        // rename just wrote; the inode guard must refuse to remove it.
        let stale_spelling = vault.join("2026-06-09 sync.md");
        if stale_spelling.canonicalize().is_ok() {
            remove_mirror_file(&vault, &stale_spelling, Some(&written));
            assert!(written.exists(), "case-only rename must not delete the fresh write");
        }
        // Same path passed as both stale and keep is the degenerate case.
        remove_mirror_file(&vault, &written, Some(&written));
        assert!(written.exists());
    }

    #[test]
    fn layout_switch_moves_the_file_on_the_meetings_next_write() {
        let tmp = tempfile::tempdir().unwrap();
        let vault = tmp.path().join("vault");
        std::fs::create_dir_all(&vault).unwrap();
        // First write lands flat in the vault root.
        let flat = vault.join("2026-06-10 Sync.md");
        std::fs::write(&flat, "v1").unwrap();
        let json = mirror_track_and_cleanup(&vault, None, "m1", &flat, &super::sha256_hex(b"v1"));
        assert!(flat.exists());
        // The setting flips to monthly; the meeting's NEXT write re-derives
        // its path and the bookkeeping removes the flat-layout leftover.
        let monthly = vault
            .join(mirror_rel_dir("monthly", "2026-06-10", None))
            .join("2026-06-10 Sync.md");
        std::fs::create_dir_all(monthly.parent().unwrap()).unwrap();
        std::fs::write(&monthly, "v2").unwrap();
        let json =
            mirror_track_and_cleanup(&vault, Some(&json), "m1", &monthly, &super::sha256_hex(b"v2"));
        assert!(!flat.exists(), "stale flat-layout file should be cleaned up");
        assert!(monthly.exists());
        assert!(mirror_paths_references(&json, monthly.to_str().unwrap()));
        assert!(!mirror_paths_references(&json, flat.to_str().unwrap()));
    }

    #[test]
    fn cleanup_keeps_a_previous_file_the_user_edited_outside_the_app() {
        let tmp = tempfile::tempdir().unwrap();
        let vault = tmp.path().join("vault");
        std::fs::create_dir_all(&vault).unwrap();
        // Mirror writes "v1" and records its hash; the user then annotates
        // the file in an external editor.
        let old = vault.join("2026-06-10 Sync.md");
        std::fs::write(&old, "v1").unwrap();
        let json = mirror_track_and_cleanup(&vault, None, "m1", &old, &super::sha256_hex(b"v1"));
        std::fs::write(&old, "v1 plus my notes").unwrap();
        // A title rename re-derives the path. Cleanup must NOT delete the
        // edited file — the clobber guard's promise covers renames too.
        let renamed = vault.join("2026-06-10 Sync (renamed).md");
        std::fs::write(&renamed, "v2").unwrap();
        let json =
            mirror_track_and_cleanup(&vault, Some(&json), "m1", &renamed, &super::sha256_hex(b"v2"));
        assert!(old.exists(), "externally edited previous file must survive a rename");
        assert_eq!(std::fs::read(&old).unwrap(), b"v1 plus my notes");
        assert!(renamed.exists());
        // An UNEDITED previous file still cleans up on the next move.
        let moved = vault.join("2026-06-10 Sync (again).md");
        std::fs::write(&moved, "v3").unwrap();
        let _ =
            mirror_track_and_cleanup(&vault, Some(&json), "m1", &moved, &super::sha256_hex(b"v3"));
        assert!(!renamed.exists(), "unedited previous file is cleaned up as before");
    }

    #[test]
    fn track_and_cleanup_keeps_a_path_another_meeting_shares() {
        let tmp = tempfile::tempdir().unwrap();
        let vault = tmp.path().join("vault");
        std::fs::create_dir_all(&vault).unwrap();
        let shared = vault.join("2026-06-10 Untitled.md");
        std::fs::write(&shared, "x").unwrap();
        // Two meetings derive the same flat path; m1 then moves to monthly.
        let json = mirror_track_and_cleanup(&vault, None, "m1", &shared, "h");
        let json = mirror_track_and_cleanup(&vault, Some(&json), "m2", &shared, "h");
        let moved = vault.join("2026").join("06").join("2026-06-10 Untitled.md");
        std::fs::create_dir_all(moved.parent().unwrap()).unwrap();
        std::fs::write(&moved, "x").unwrap();
        let _ = mirror_track_and_cleanup(&vault, Some(&json), "m1", &moved, "h");
        assert!(shared.exists(), "m2 still tracks the flat file — keep it");
        assert!(moved.exists());
    }

    #[test]
    fn stale_delete_prunes_now_empty_layout_dirs_but_never_the_vault() {
        let tmp = tempfile::tempdir().unwrap();
        let vault = tmp.path().join("vault");
        let month_dir = vault.join("2026").join("06");
        std::fs::create_dir_all(&month_dir).unwrap();
        let stale = month_dir.join("2026-06-10 Sync.md");
        std::fs::write(&stale, "x").unwrap();

        remove_mirror_file(&vault, &stale, None);
        assert!(!stale.exists());
        assert!(!month_dir.exists(), "emptied month dir should be pruned");
        assert!(!vault.join("2026").exists(), "emptied year dir should be pruned");
        assert!(vault.exists(), "the vault root itself is never removed");
    }

    #[test]
    fn prune_stops_at_dirs_that_still_hold_files() {
        let tmp = tempfile::tempdir().unwrap();
        let vault = tmp.path().join("vault");
        let month_dir = vault.join("2026").join("06");
        std::fs::create_dir_all(&month_dir).unwrap();
        let stale = month_dir.join("a.md");
        std::fs::write(&stale, "x").unwrap();
        std::fs::write(month_dir.join("b.md"), "x").unwrap();

        remove_mirror_file(&vault, &stale, None);
        assert!(!stale.exists());
        assert!(month_dir.join("b.md").exists());
        assert!(month_dir.exists(), "non-empty dirs are never removed");
    }
}

#[cfg(test)]
mod clobber_guard_tests {
    use super::{
        conflict_path_for, guarded_mirror_write, mirror_paths_get, remove_mirror_file, sha256_hex,
    };
    use std::path::{Path, PathBuf};

    /// A fresh vault dir and the flat-layout target inside it.
    fn vault_and_target(tmp: &tempfile::TempDir) -> (PathBuf, PathBuf) {
        let vault = tmp.path().join("vault");
        std::fs::create_dir_all(&vault).unwrap();
        let target = vault.join("2026-06-10 Sync.md");
        (vault, target)
    }

    /// guarded_mirror_write for the common assertions: returns the map JSON
    /// after a write that is expected to be clean.
    fn clean_write(vault: &Path, prior: Option<&str>, target: &Path, content: &[u8]) -> String {
        let (written, conflicted, updated) =
            guarded_mirror_write(vault, prior, "m1", target, content).unwrap();
        assert_eq!(written, target);
        assert!(!conflicted);
        updated.expect("a clean write must update the bookkeeping")
    }

    #[test]
    fn same_title_meetings_get_distinct_paths_instead_of_conflict_ping_pong() {
        use super::{disambiguate_mirror_path, mirror_paths_insert};
        let tmp = tempfile::tempdir().unwrap();
        let (vault, _) = vault_and_target(&tmp);

        // m1 takes the base path.
        let p1 = disambiguate_mirror_path(None, "m1", &vault, "2026-06-10", "Sync");
        assert!(p1.ends_with("2026-06-10 Sync.md"));
        let (map, _) = mirror_paths_insert(None, "m1", &p1.to_string_lossy(), "h1");

        // m2, same title + day: numbered, never shared — and stable on re-derive.
        let p2 = disambiguate_mirror_path(Some(&map), "m2", &vault, "2026-06-10", "Sync");
        assert!(p2.ends_with("2026-06-10 Sync (2).md"));
        let (map, _) = mirror_paths_insert(Some(&map), "m2", &p2.to_string_lossy(), "h2");
        assert_eq!(
            disambiguate_mirror_path(Some(&map), "m2", &vault, "2026-06-10", "Sync"),
            p2,
            "a meeting's own tracked path stays acceptable on the next write"
        );
        assert_eq!(
            disambiguate_mirror_path(Some(&map), "m1", &vault, "2026-06-10", "Sync"),
            p1
        );

        // A third sibling skips both taken slots.
        let p3 = disambiguate_mirror_path(Some(&map), "m3", &vault, "2026-06-10", "Sync");
        assert!(p3.ends_with("2026-06-10 Sync (3).md"));

        // End-to-end: writes through the guard land on distinct files with
        // no conflict — the ping-pong is structurally impossible.
        let json = clean_write(&vault, None, &p1, b"m1 v1");
        let (w2, conflicted, _) =
            guarded_mirror_write(&vault, Some(&json), "m2-real", &p2, b"m2 v1").unwrap();
        assert!(!conflicted);
        assert_eq!(w2, p2);
        assert_eq!(std::fs::read(&p1).unwrap(), b"m1 v1");
        assert_eq!(std::fs::read(&p2).unwrap(), b"m2 v1");
    }

    #[test]
    fn first_write_stores_the_content_hash() {
        let tmp = tempfile::tempdir().unwrap();
        let (vault, target) = vault_and_target(&tmp);

        let json = clean_write(&vault, None, &target, b"v1");
        assert_eq!(std::fs::read(&target).unwrap(), b"v1");
        assert_eq!(
            mirror_paths_get(Some(&json), "m1"),
            Some((target.to_string_lossy().into_owned(), Some(sha256_hex(b"v1"))))
        );
    }

    #[test]
    fn clean_rewrite_overwrites_and_updates_the_hash() {
        let tmp = tempfile::tempdir().unwrap();
        let (vault, target) = vault_and_target(&tmp);

        let json = clean_write(&vault, None, &target, b"v1");
        // Nobody touched the file in between — overwrite like always.
        let json = clean_write(&vault, Some(&json), &target, b"v2");
        assert_eq!(std::fs::read(&target).unwrap(), b"v2");
        assert_eq!(
            mirror_paths_get(Some(&json), "m1").unwrap().1,
            Some(sha256_hex(b"v2"))
        );
        assert!(!conflict_path_for(&target).exists(), "no conflict file on a clean path");
    }

    #[test]
    fn external_edit_diverts_to_a_conflict_file_and_never_touches_the_original() {
        let tmp = tempfile::tempdir().unwrap();
        let (vault, target) = vault_and_target(&tmp);

        let json = clean_write(&vault, None, &target, b"v1");
        // The user edits the file in Obsidian.
        let users = b"v1 plus the user's own thoughts \xE2\x80\x94 bytes, not lines";
        std::fs::write(&target, users).unwrap();

        let (written, conflicted, updated) =
            guarded_mirror_write(&vault, Some(&json), "m1", &target, b"v2").unwrap();
        assert!(conflicted);
        assert_eq!(written, conflict_path_for(&target));
        assert_eq!(written, vault.join("2026-06-10 Sync.conflict.md"));
        // Original is byte-for-byte the user's version; new content went beside it.
        assert_eq!(std::fs::read(&target).unwrap(), users);
        assert_eq!(std::fs::read(&written).unwrap(), b"v2");
        // Bookkeeping untouched: still the ORIGINAL path + OUR last hash, so
        // rename/delete lifecycle targets the user's file and the conflict
        // re-checks on the next write.
        assert_eq!(updated, None);
        assert_eq!(
            mirror_paths_get(Some(&json), "m1"),
            Some((target.to_string_lossy().into_owned(), Some(sha256_hex(b"v1"))))
        );
    }

    #[test]
    fn a_second_conflict_overwrites_the_previous_conflict_file() {
        let tmp = tempfile::tempdir().unwrap();
        let (vault, target) = vault_and_target(&tmp);

        let json = clean_write(&vault, None, &target, b"v1");
        std::fs::write(&target, b"user edit").unwrap();
        let (first, c1, _) = guarded_mirror_write(&vault, Some(&json), "m1", &target, b"v2").unwrap();
        let (second, c2, _) = guarded_mirror_write(&vault, Some(&json), "m1", &target, b"v3").unwrap();
        assert!(c1 && c2);
        assert_eq!(first, second, "one conflict file per note");
        // Latest wins: the conflict file always holds the newest app content.
        assert_eq!(std::fs::read(&second).unwrap(), b"v3");
        assert_eq!(std::fs::read(&target).unwrap(), b"user edit");
    }

    #[test]
    fn legacy_entry_without_a_hash_writes_like_before_then_gains_one() {
        let tmp = tempfile::tempdir().unwrap();
        let (vault, target) = vault_and_target(&tmp);
        // Pre-upgrade map: plain string path, no hash — even though the file
        // WAS edited externally, the hash is unknown, so this first write
        // after the upgrade overwrites exactly as the app always did.
        std::fs::write(&target, b"externally edited before the upgrade").unwrap();
        let legacy = serde_json::json!({ "m1": target.to_string_lossy() }).to_string();

        let json = clean_write(&vault, Some(&legacy), &target, b"v2");
        assert_eq!(std::fs::read(&target).unwrap(), b"v2");
        assert!(!conflict_path_for(&target).exists());
        // …and from now on the entry knows its hash, so the guard is armed.
        assert_eq!(
            mirror_paths_get(Some(&json), "m1").unwrap().1,
            Some(sha256_hex(b"v2"))
        );
    }

    #[test]
    fn an_externally_deleted_file_is_recreated_not_conflicted() {
        let tmp = tempfile::tempdir().unwrap();
        let (vault, target) = vault_and_target(&tmp);

        let json = clean_write(&vault, None, &target, b"v1");
        std::fs::remove_file(&target).unwrap();

        let json = clean_write(&vault, Some(&json), &target, b"v2");
        assert_eq!(std::fs::read(&target).unwrap(), b"v2");
        assert_eq!(
            mirror_paths_get(Some(&json), "m1").unwrap().1,
            Some(sha256_hex(b"v2"))
        );
    }

    #[test]
    fn accepting_the_conflict_copy_resolves_instead_of_conflicting_forever() {
        let tmp = tempfile::tempdir().unwrap();
        let (vault, target) = vault_and_target(&tmp);

        let json = clean_write(&vault, None, &target, b"v1");
        std::fs::write(&target, b"user edit").unwrap();
        let (conflict, c, _) = guarded_mirror_write(&vault, Some(&json), "m1", &target, b"v2").unwrap();
        assert!(c);
        // The user resolves by copying the conflict file over the original:
        // on-disk now equals the incoming bytes, so overwriting clobbers
        // nothing — the entry re-syncs its hash and the conflict ends.
        std::fs::copy(&conflict, &target).unwrap();
        let json = clean_write(&vault, Some(&json), &target, b"v2");
        assert_eq!(
            mirror_paths_get(Some(&json), "m1").unwrap().1,
            Some(sha256_hex(b"v2"))
        );
    }

    #[test]
    fn lifecycle_deletes_refuse_conflict_files() {
        let tmp = tempfile::tempdir().unwrap();
        let (vault, target) = vault_and_target(&tmp);
        let conflict = conflict_path_for(&target);
        std::fs::write(&conflict, b"unmerged user edits").unwrap();

        // remove_mirror_file is the single delete primitive behind both the
        // hard-delete hook and rename/layout cleanup — even if a corrupt map
        // pointed it at a conflict file, it must refuse.
        remove_mirror_file(&vault, &conflict, None);
        assert!(conflict.exists(), "conflict files are the user's to resolve");
    }

    #[test]
    fn hard_delete_of_the_original_leaves_the_conflict_file_and_its_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let vault = tmp.path().join("vault");
        let month_dir = vault.join("2026").join("06");
        std::fs::create_dir_all(&month_dir).unwrap();
        let original = month_dir.join("2026-06-10 Sync.md");
        std::fs::write(&original, b"ours").unwrap();
        let conflict = conflict_path_for(&original);
        std::fs::write(&conflict, b"theirs").unwrap();

        // What remove_mirror_on_hard_delete does to the tracked path.
        remove_mirror_file(&vault, &original, None);
        assert!(!original.exists());
        assert!(conflict.exists(), "hard delete must leave the conflict file");
        assert!(month_dir.exists(), "a dir holding only a conflict file is not empty");
    }

    #[test]
    fn rename_cleanup_leaves_the_conflict_file_behind() {
        let tmp = tempfile::tempdir().unwrap();
        let (vault, old) = vault_and_target(&tmp);

        // m1 mirrors to the old title, then conflicts there.
        let json = clean_write(&vault, None, &old, b"v1");
        std::fs::write(&old, b"user edit").unwrap();
        let (conflict, c, _) = guarded_mirror_write(&vault, Some(&json), "m1", &old, b"v2").unwrap();
        assert!(c);

        // The meeting is renamed in-app; the next write re-derives the path.
        // The old file holds the user's external edit (its bytes no longer
        // match the recorded hash), so cleanup leaves it — and the conflict
        // file, the user's unreviewed copy of OUR content, stays put too.
        let renamed = vault.join("2026-06-10 Renamed.md");
        let (written, conflicted, updated) =
            guarded_mirror_write(&vault, Some(&json), "m1", &renamed, b"v2").unwrap();
        assert!(!conflicted);
        assert_eq!(written, renamed);
        assert!(old.exists(), "rename cleanup must not delete an externally edited file");
        assert_eq!(std::fs::read(&old).unwrap(), b"user edit");
        assert!(conflict.exists(), "rename cleanup must leave the conflict file");
        let json = updated.unwrap();
        assert_eq!(
            mirror_paths_get(Some(&json), "m1").unwrap().0,
            renamed.to_string_lossy()
        );
    }
}
