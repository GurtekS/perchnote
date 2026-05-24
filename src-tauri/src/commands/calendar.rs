use tauri::State;
use tokio::net::TcpListener;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::db::Database;
use crate::calendar::google::{GoogleCalendar, OAuthTokens};
use crate::calendar::microsoft::{MicrosoftCalendar, MsOAuthTokens};
use crate::calendar::ics;
use crate::secrets::{self, SecretKey};

#[tauri::command]
pub async fn start_google_oauth(
    db: State<'_, Database>,
) -> Result<String, String> {
    let calendar = GoogleCalendar::from_db(&db).map_err(|e| e.to_string())?;

    // Bind to random port for callback
    let listener = TcpListener::bind("127.0.0.1:0").await.map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();

    let auth_url = calendar.auth_url(port);

    // Open browser
    let _ = open::that(&auth_url);

    // Wait for callback (with timeout)
    let (mut stream, _) = tokio::time::timeout(
        std::time::Duration::from_secs(120),
        listener.accept(),
    )
    .await
    .map_err(|_| "OAuth timed out after 2 minutes".to_string())?
    .map_err(|e| e.to_string())?;

    let mut buf = Vec::new();
    let mut tmp = [0u8; 512];
    loop {
        let n = stream.read(&mut tmp).await.map_err(|e| e.to_string())?;
        if n == 0 { break; }
        buf.extend_from_slice(&tmp[..n]);
        if buf.windows(4).any(|w| w == b"\r\n\r\n") { break; }
        if buf.len() > 65_536 { break; } // safety limit
    }
    let request = String::from_utf8_lossy(&buf);

    // Parse code from query string
    let code = request
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|path| {
            url::Url::parse(&format!("http://localhost{}", path)).ok()
        })
        .and_then(|url| {
            url.query_pairs()
                .find(|(k, _)| k == "code")
                .map(|(_, v)| v.to_string())
        })
        .ok_or("failed to parse auth code from callback")?;

    // Send a response to the browser so the user sees confirmation
    let response = "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n\r\n<html><body><h2>Connected!</h2><p>You can close this tab and return to Perchnote.</p></body></html>";
    let _ = stream.write_all(response.as_bytes()).await;

    // Exchange code for tokens
    let tokens = calendar.exchange_code(&code, port).await.map_err(|e| e.to_string())?;

    // Save tokens (Keychain)
    let tokens_json = serde_json::to_string(&tokens).map_err(|e| e.to_string())?;
    secrets::set(SecretKey::GoogleOAuthTokens, &tokens_json).map_err(|e| e.to_string())?;

    Ok("Connected to Google Calendar".to_string())
}

#[tauri::command]
pub async fn sync_calendar(
    db: State<'_, Database>,
    past_days: Option<u32>,
    future_days: Option<u32>,
) -> Result<usize, String> {
    let calendar = GoogleCalendar::from_db(&db).map_err(|e| e.to_string())?;

    let tokens_json = secrets::get(SecretKey::GoogleOAuthTokens)
        .map_err(|e| e.to_string())?
        .ok_or("not connected")?;

    let mut tokens: OAuthTokens = serde_json::from_str(&tokens_json).map_err(|e| e.to_string())?;

    // Refresh if expired
    if chrono::Utc::now().timestamp() >= tokens.expires_at {
        tokens = calendar.refresh_token(&tokens.refresh_token).await.map_err(|e| e.to_string())?;
        let tokens_json = serde_json::to_string(&tokens).map_err(|e| e.to_string())?;
        secrets::set(SecretKey::GoogleOAuthTokens, &tokens_json).map_err(|e| e.to_string())?;
    }

    let pd = past_days.unwrap_or(30);
    let fd = future_days.unwrap_or(90);
    let count = calendar.sync_events(&db, &tokens.access_token, pd, fd).await.map_err(|e| e.to_string())?;
    Ok(count)
}

#[tauri::command]
pub fn is_calendar_connected(_db: State<'_, Database>) -> bool {
    secrets::has(SecretKey::GoogleOAuthTokens)
}

#[tauri::command]
pub fn has_calendar_credentials(db: State<'_, Database>) -> bool {
    GoogleCalendar::has_credentials(&db)
}

#[tauri::command]
pub async fn disconnect_calendar(_db: State<'_, Database>) -> Result<(), String> {
    secrets::delete(SecretKey::GoogleOAuthTokens).map_err(|e| e.to_string())?;
    Ok(())
}

// --- ICS URL Calendar Integration ---

#[tauri::command]
pub async fn add_ics_url(db: State<'_, Database>, url: String) -> Result<(), String> {
    // Validate URL by fetching it (use defaults for initial add)
    let count = ics::sync_ics_url(&db, &url, 30, 90).await.map_err(|e| e.to_string())?;

    // Store the URL in settings (support multiple as JSON array)
    let mut urls = get_ics_urls_list(&db);
    if !urls.contains(&url) {
        urls.push(url);
    }
    let json = serde_json::to_string(&urls).map_err(|e| e.to_string())?;
    db.set_setting("ics_calendar_urls", &json).map_err(|e| e.to_string())?;

    log::info!("Added ICS URL, synced {} events", count);
    Ok(())
}

#[tauri::command]
pub fn remove_ics_url(db: State<'_, Database>, url: String) -> Result<(), String> {
    let mut urls = get_ics_urls_list(&db);
    urls.retain(|u| u != &url);
    let json = serde_json::to_string(&urls).map_err(|e| e.to_string())?;
    db.set_setting("ics_calendar_urls", &json).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn list_ics_urls(db: State<'_, Database>) -> Vec<String> {
    get_ics_urls_list(&db)
}

#[tauri::command]
pub async fn sync_ics_calendars(
    db: State<'_, Database>,
    past_days: Option<u32>,
    future_days: Option<u32>,
) -> Result<usize, String> {
    let pd = past_days.unwrap_or(30);
    let fd = future_days.unwrap_or(90);
    let urls = get_ics_urls_list(&db);
    let mut total = 0;
    for url in &urls {
        match ics::sync_ics_url(&db, url, pd, fd).await {
            Ok(count) => total += count,
            Err(e) => log::warn!("ICS sync error for {}: {}", url, e),
        }
    }
    Ok(total)
}

fn get_ics_urls_list(db: &Database) -> Vec<String> {
    db.get_setting("ics_calendar_urls")
        .ok()
        .flatten()
        .and_then(|json| serde_json::from_str::<Vec<String>>(&json).ok())
        .unwrap_or_default()
}

// --- Microsoft Calendar OAuth ---

#[tauri::command]
pub async fn start_microsoft_oauth(
    db: State<'_, Database>,
) -> Result<String, String> {
    let calendar = MicrosoftCalendar::from_db(&db).map_err(|e| e.to_string())?;

    let listener = TcpListener::bind("127.0.0.1:0").await.map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();

    let auth_url = calendar.auth_url(port);
    let _ = open::that(&auth_url);

    let (mut stream, _) = tokio::time::timeout(
        std::time::Duration::from_secs(120),
        listener.accept(),
    )
    .await
    .map_err(|_| "OAuth timed out after 2 minutes".to_string())?
    .map_err(|e| e.to_string())?;

    let mut buf = Vec::new();
    let mut tmp = [0u8; 512];
    loop {
        let n = stream.read(&mut tmp).await.map_err(|e| e.to_string())?;
        if n == 0 { break; }
        buf.extend_from_slice(&tmp[..n]);
        if buf.windows(4).any(|w| w == b"\r\n\r\n") { break; }
        if buf.len() > 65_536 { break; } // safety limit
    }
    let request = String::from_utf8_lossy(&buf);

    let code = request
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|path| url::Url::parse(&format!("http://localhost{}", path)).ok())
        .and_then(|url| {
            url.query_pairs()
                .find(|(k, _)| k == "code")
                .map(|(_, v)| v.to_string())
        })
        .ok_or("failed to parse auth code from callback")?;

    let response = "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n\r\n<html><body><h2>Connected!</h2><p>You can close this tab and return to Perchnote.</p></body></html>";
    let _ = stream.write_all(response.as_bytes()).await;

    let tokens = calendar.exchange_code(&code, port).await.map_err(|e| e.to_string())?;
    let tokens_json = serde_json::to_string(&tokens).map_err(|e| e.to_string())?;
    secrets::set(SecretKey::MicrosoftOAuthTokens, &tokens_json).map_err(|e| e.to_string())?;

    Ok("Connected to Microsoft Calendar".to_string())
}

#[tauri::command]
pub async fn sync_microsoft_calendar(
    db: State<'_, Database>,
    past_days: Option<u32>,
    future_days: Option<u32>,
) -> Result<usize, String> {
    let calendar = MicrosoftCalendar::from_db(&db).map_err(|e| e.to_string())?;

    let tokens_json = secrets::get(SecretKey::MicrosoftOAuthTokens)
        .map_err(|e| e.to_string())?
        .ok_or("not connected")?;

    let mut tokens: MsOAuthTokens = serde_json::from_str(&tokens_json).map_err(|e| e.to_string())?;

    if chrono::Utc::now().timestamp() >= tokens.expires_at {
        tokens = calendar.refresh_token(&tokens.refresh_token).await.map_err(|e| e.to_string())?;
        let tokens_json = serde_json::to_string(&tokens).map_err(|e| e.to_string())?;
        secrets::set(SecretKey::MicrosoftOAuthTokens, &tokens_json).map_err(|e| e.to_string())?;
    }

    let pd = past_days.unwrap_or(30);
    let fd = future_days.unwrap_or(90);
    let count = calendar.sync_events(&db, &tokens.access_token, pd, fd).await.map_err(|e| e.to_string())?;
    Ok(count)
}

#[tauri::command]
pub fn is_microsoft_connected(_db: State<'_, Database>) -> bool {
    secrets::has(SecretKey::MicrosoftOAuthTokens)
}

#[tauri::command]
pub fn has_microsoft_credentials(db: State<'_, Database>) -> bool {
    MicrosoftCalendar::has_credentials(&db)
}

#[tauri::command]
pub async fn disconnect_microsoft(_db: State<'_, Database>) -> Result<(), String> {
    secrets::delete(SecretKey::MicrosoftOAuthTokens).map_err(|e| e.to_string())?;
    Ok(())
}

// --- Auto-create meetings from calendar events ---

#[tauri::command]
pub fn auto_create_from_calendar(db: State<'_, Database>) -> Result<usize, String> {
    let meetings = db.list_meetings().map_err(|e| e.to_string())?;
    let now = chrono::Utc::now();
    let mut created = 0;

    for meeting in meetings {
        if meeting.status != "upcoming" {
            continue;
        }
        if let Some(start) = &meeting.scheduled_start {
            if let Ok(start_time) = chrono::DateTime::parse_from_rfc3339(start) {
                let diff = start_time.signed_duration_since(now);
                // Auto-create meeting entry 5 minutes before
                if diff.num_seconds() > 0 && diff.num_seconds() <= 300 {
                    // Meeting already exists as "upcoming", just mark it as ready
                    let _ = db.update_meeting_status(&meeting.id, "ready");
                    created += 1;
                }
            }
        }
    }

    Ok(created)
}

// --- Share meeting notes as HTML ---

#[tauri::command]
pub fn export_meeting_html(db: State<'_, Database>, meeting_id: String) -> Result<String, String> {
    let meeting = db.get_meeting(&meeting_id)
        .map_err(|e| e.to_string())?
        .ok_or("Meeting not found")?;

    let note = db.get_note_by_meeting(&meeting_id)
        .map_err(|e| e.to_string())?;

    let generated = note
        .as_ref()
        .and_then(|n| n.generated_content.as_ref())
        .cloned()
        .unwrap_or_default();

    let raw_notes = note
        .as_ref()
        .and_then(|n| n.raw_content.as_ref())
        .cloned()
        .unwrap_or_default();

    // Build sections HTML from generated content
    let sections_html = if !generated.is_empty() {
        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&generated) {
            let mut html = String::new();
            if let Some(summary) = parsed.get("summary").and_then(|s| s.as_str()) {
                html.push_str(&format!("<div class=\"summary\"><h2>Summary</h2><p>{}</p></div>", html_escape(summary)));
            }
            if let Some(sections) = parsed.get("sections").and_then(|s| s.as_array()) {
                for section in sections {
                    if let Some(heading) = section.get("heading").and_then(|h| h.as_str()) {
                        html.push_str(&format!("<h2>{}</h2>", html_escape(heading)));
                    }
                    if let Some(bullets) = section.get("bullets").and_then(|b| b.as_array()) {
                        html.push_str("<ul>");
                        for bullet in bullets {
                            if let Some(b) = bullet.as_str() {
                                html.push_str(&format!("<li>{}</li>", html_escape(b)));
                            }
                        }
                        html.push_str("</ul>");
                    }
                }
            }
            if let Some(actions) = parsed.get("action_items").and_then(|a| a.as_array()) {
                if !actions.is_empty() {
                    html.push_str("<h2>Action Items</h2><ul>");
                    for item in actions {
                        let task = item.get("task").and_then(|t| t.as_str()).unwrap_or("");
                        let assignee = item.get("assignee").and_then(|a| a.as_str()).unwrap_or("");
                        let mut line = html_escape(task);
                        if !assignee.is_empty() {
                            line.push_str(&format!(" <span class=\"assignee\">@{}</span>", html_escape(assignee)));
                        }
                        html.push_str(&format!("<li>{}</li>", line));
                    }
                    html.push_str("</ul>");
                }
            }
            html
        } else {
            format!("<pre>{}</pre>", html_escape(&generated))
        }
    } else if !raw_notes.is_empty() {
        format!("<div class=\"raw-notes\"><h2>Notes</h2><pre>{}</pre></div>", html_escape(&raw_notes))
    } else {
        "<p>No notes available for this meeting.</p>".to_string()
    };

    let date_str = meeting.scheduled_start
        .as_ref()
        .map(|s| s.to_string())
        .unwrap_or_else(|| meeting.created_at.clone());

    let html = format!(
        r#"<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title} - Perchnote</title>
<style>
  body {{ font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 720px; margin: 2rem auto; padding: 0 1rem; color: #1a1a1a; line-height: 1.6; }}
  h1 {{ font-size: 1.5rem; margin-bottom: 0.25rem; }}
  .meta {{ color: #666; font-size: 0.875rem; margin-bottom: 1.5rem; border-bottom: 1px solid #e5e5e5; padding-bottom: 1rem; }}
  h2 {{ font-size: 1.1rem; margin-top: 1.5rem; color: #333; border-bottom: 1px solid #eee; padding-bottom: 0.25rem; }}
  ul {{ padding-left: 1.5rem; }}
  li {{ margin-bottom: 0.5rem; }}
  .summary {{ background: #f8f9fa; border-radius: 8px; padding: 1rem; margin-bottom: 1rem; }}
  .summary p {{ margin: 0; }}
  .assignee {{ color: #6366f1; font-weight: 500; }}
  .footer {{ margin-top: 2rem; padding-top: 1rem; border-top: 1px solid #e5e5e5; font-size: 0.75rem; color: #999; }}
  pre {{ white-space: pre-wrap; word-wrap: break-word; background: #f8f9fa; padding: 1rem; border-radius: 8px; }}
  @media (prefers-color-scheme: dark) {{
    body {{ background: #1a1a1a; color: #e5e5e5; }}
    h2 {{ color: #ccc; border-color: #333; }}
    .summary {{ background: #262626; }}
    .meta {{ color: #999; border-color: #333; }}
    .footer {{ border-color: #333; }}
    pre {{ background: #262626; }}
  }}
</style>
</head>
<body>
<h1>{title}</h1>
<div class="meta">{date}</div>
{content}
<div class="footer">Generated by Perchnote</div>
</body>
</html>"#,
        title = html_escape(&meeting.title),
        date = html_escape(&date_str),
        content = sections_html,
    );

    Ok(html)
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

// --- Slack integration ---

#[tauri::command]
pub async fn share_to_slack(
    db: State<'_, Database>,
    meeting_id: String,
) -> Result<(), String> {
    let webhook_url = secrets::get(SecretKey::SlackWebhookUrl)
        .map_err(|e| e.to_string())?
        .ok_or("Slack webhook URL not configured. Set it in Settings > Integrations.")?;

    if webhook_url.is_empty() {
        return Err("Slack webhook URL is empty".to_string());
    }

    // Slack webhooks must be https://hooks.slack.com/services/... — refuse anything else.
    if !webhook_url.starts_with("https://hooks.slack.com/") {
        return Err("Slack webhook URL must start with https://hooks.slack.com/".to_string());
    }

    let meeting = db.get_meeting(&meeting_id)
        .map_err(|e| e.to_string())?
        .ok_or("Meeting not found")?;

    let note = db.get_note_by_meeting(&meeting_id)
        .map_err(|e| e.to_string())?;

    let generated = note
        .as_ref()
        .and_then(|n| n.generated_content.as_ref())
        .cloned()
        .unwrap_or_default();

    // Build Slack message blocks
    let mut text = format!("*{}*\n", meeting.title);

    if !generated.is_empty() {
        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&generated) {
            if let Some(summary) = parsed.get("summary").and_then(|s| s.as_str()) {
                text.push_str(&format!("\n_{}_\n", summary));
            }
            if let Some(sections) = parsed.get("sections").and_then(|s| s.as_array()) {
                for section in sections {
                    if let Some(heading) = section.get("heading").and_then(|h| h.as_str()) {
                        text.push_str(&format!("\n*{}*\n", heading));
                    }
                    if let Some(bullets) = section.get("bullets").and_then(|b| b.as_array()) {
                        for bullet in bullets {
                            if let Some(b) = bullet.as_str() {
                                text.push_str(&format!("  - {}\n", b));
                            }
                        }
                    }
                }
            }
            if let Some(actions) = parsed.get("action_items").and_then(|a| a.as_array()) {
                if !actions.is_empty() {
                    text.push_str("\n*Action Items*\n");
                    for item in actions {
                        let task = item.get("task").and_then(|t| t.as_str()).unwrap_or("");
                        let assignee = item.get("assignee").and_then(|a| a.as_str());
                        if let Some(a) = assignee {
                            text.push_str(&format!("  - {} (@{})\n", task, a));
                        } else {
                            text.push_str(&format!("  - {}\n", task));
                        }
                    }
                }
            }
        } else {
            text.push_str(&format!("\n```\n{}\n```\n", generated));
        }
    } else {
        text.push_str("\n_No generated notes available._\n");
    }

    let payload = serde_json::json!({ "text": text });

    let client = reqwest::Client::new();
    let resp = client.post(&webhook_url)
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("Failed to send to Slack: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Slack webhook returned {}: {}", status, body));
    }

    Ok(())
}
