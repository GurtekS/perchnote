use anyhow::{anyhow, Result};
use reqwest::Client;
use serde::{Deserialize, Serialize};

use crate::db::Database;
use super::detection::detect_platform;

const GRAPH_API_BASE: &str = "https://graph.microsoft.com/v1.0";
const AUTH_URL: &str = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
const TOKEN_URL: &str = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const SCOPE: &str = "Calendars.Read offline_access";

/// Compile-time embedded credentials (set via env vars at build time)
const EMBEDDED_MS_CLIENT_ID: Option<&str> = option_env!("MICROSOFT_CLIENT_ID");
const EMBEDDED_MS_CLIENT_SECRET: Option<&str> = option_env!("MICROSOFT_CLIENT_SECRET");

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MsOAuthTokens {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_at: i64,
}

#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: Option<String>,
    expires_in: i64,
}

#[derive(Debug, Deserialize)]
struct CalendarEventsResponse {
    value: Option<Vec<CalendarEvent>>,
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct CalendarEvent {
    id: String,
    subject: Option<String>,
    start: Option<EventTime>,
    end: Option<EventTime>,
    attendees: Option<Vec<Attendee>>,
    location: Option<LocationInfo>,
    body: Option<BodyContent>,
    #[serde(rename = "onlineMeeting")]
    online_meeting: Option<OnlineMeetingInfo>,
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct EventTime {
    #[serde(rename = "dateTime")]
    date_time: Option<String>,
    #[serde(rename = "timeZone")]
    time_zone: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[allow(dead_code)]
struct Attendee {
    #[serde(rename = "emailAddress")]
    email_address: Option<EmailAddress>,
}

#[derive(Debug, Deserialize, Serialize)]
#[allow(dead_code)]
struct EmailAddress {
    name: Option<String>,
    address: Option<String>,
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct LocationInfo {
    #[serde(rename = "displayName")]
    display_name: Option<String>,
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct BodyContent {
    content: Option<String>,
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct OnlineMeetingInfo {
    #[serde(rename = "joinUrl")]
    join_url: Option<String>,
}

pub struct MicrosoftCalendar {
    client: Client,
    client_id: String,
    client_secret: String,
}

impl MicrosoftCalendar {
    pub fn new(client_id: String, client_secret: String) -> Self {
        Self {
            client: crate::calendar::http::build_client(),
            client_id,
            client_secret,
        }
    }

    /// Create from embedded credentials or DB/Keychain fallback.
    pub fn from_db(db: &Database) -> Result<Self> {
        let client_id = EMBEDDED_MS_CLIENT_ID
            .map(|s| s.to_string())
            .or_else(|| db.get_setting("microsoft_client_id").ok().flatten())
            .ok_or_else(|| anyhow!("Microsoft Client ID not configured"))?;
        let client_secret = EMBEDDED_MS_CLIENT_SECRET
            .map(|s| s.to_string())
            .or_else(|| crate::secrets::get(crate::secrets::SecretKey::MicrosoftClientSecret).ok().flatten())
            .ok_or_else(|| anyhow!("Microsoft Client Secret not configured"))?;
        Ok(Self::new(client_id, client_secret))
    }

    /// Whether OAuth credentials are available (embedded or configured).
    pub fn has_credentials(db: &Database) -> bool {
        EMBEDDED_MS_CLIENT_ID.is_some()
            || db.get_setting("microsoft_client_id").ok().flatten().is_some()
    }

    /// Generate the OAuth authorization URL
    pub fn auth_url(&self, redirect_port: u16) -> String {
        let redirect_uri = format!("http://localhost:{}/callback", redirect_port);
        format!(
            "{}?client_id={}&redirect_uri={}&response_type=code&scope={}&response_mode=query",
            AUTH_URL,
            urlencoding::encode(&self.client_id),
            urlencoding::encode(&redirect_uri),
            urlencoding::encode(SCOPE),
        )
    }

    /// Exchange authorization code for tokens
    pub async fn exchange_code(&self, code: &str, redirect_port: u16) -> Result<MsOAuthTokens> {
        let redirect_uri = format!("http://localhost:{}/callback", redirect_port);
        let resp = self.client
            .post(TOKEN_URL)
            .form(&[
                ("code", code),
                ("client_id", &self.client_id),
                ("client_secret", &self.client_secret),
                ("redirect_uri", &redirect_uri),
                ("grant_type", "authorization_code"),
                ("scope", SCOPE),
            ])
            .send()
            .await?
            .json::<TokenResponse>()
            .await?;

        let expires_at = chrono::Utc::now().timestamp() + resp.expires_in;
        Ok(MsOAuthTokens {
            access_token: resp.access_token,
            refresh_token: resp.refresh_token.unwrap_or_default(),
            expires_at,
        })
    }

    /// Refresh an expired access token
    pub async fn refresh_token(&self, refresh_token: &str) -> Result<MsOAuthTokens> {
        let resp = self.client
            .post(TOKEN_URL)
            .form(&[
                ("refresh_token", refresh_token),
                ("client_id", &self.client_id),
                ("client_secret", &self.client_secret),
                ("grant_type", "refresh_token"),
                ("scope", SCOPE),
            ])
            .send()
            .await?
            .json::<TokenResponse>()
            .await?;

        let expires_at = chrono::Utc::now().timestamp() + resp.expires_in;
        Ok(MsOAuthTokens {
            access_token: resp.access_token,
            refresh_token: resp.refresh_token.unwrap_or_else(|| refresh_token.to_string()),
            expires_at,
        })
    }

    /// Fetch upcoming events for the configured date range
    async fn fetch_upcoming_events(&self, access_token: &str, past_days: u32, future_days: u32) -> Result<Vec<CalendarEvent>> {
        let now = chrono::Utc::now();
        let start_date_time = now - chrono::Duration::days(past_days as i64);
        let end_date_time = now + chrono::Duration::days(future_days as i64);

        let resp = self.client
            .get(format!("{}/me/calendarView", GRAPH_API_BASE))
            .bearer_auth(access_token)
            .query(&[
                ("startDateTime", start_date_time.to_rfc3339()),
                ("endDateTime", end_date_time.to_rfc3339()),
                ("$orderby", "start/dateTime".to_string()),
                ("$select", "id,subject,start,end,attendees,location,body,onlineMeeting".to_string()),
            ])
            .send()
            .await?;

        if !resp.status().is_success() {
            return Err(anyhow!("Microsoft Graph API returned {}", resp.status()));
        }

        let body = resp.json::<CalendarEventsResponse>().await?;
        Ok(body.value.unwrap_or_default())
    }

    /// Sync calendar events into the database
    pub async fn sync_events(&self, db: &Database, access_token: &str, past_days: u32, future_days: u32) -> Result<usize> {
        let events = self.fetch_upcoming_events(access_token, past_days, future_days).await?;
        let mut count = 0;

        for event in events {
            let title = event.subject.unwrap_or_else(|| "Untitled Meeting".to_string());
            let start = event.start.and_then(|t| t.date_time).unwrap_or_default();
            let end = event.end.and_then(|t| t.date_time).unwrap_or_default();

            // Build attendees JSON
            let attendees_list: Vec<serde_json::Value> = event.attendees
                .unwrap_or_default()
                .iter()
                .filter_map(|a| {
                    a.email_address.as_ref().map(|e| {
                        serde_json::json!({
                            "email": e.address,
                            "displayName": e.name,
                        })
                    })
                })
                .collect();
            let attendees_json = serde_json::to_string(&attendees_list)?;

            let location_str = event.location.and_then(|l| l.display_name);
            let body_content = event.body.and_then(|b| b.content);

            // Check online meeting URL first, then fall back to detection
            let online_url = event.online_meeting.and_then(|om| om.join_url);
            let (meeting_url, platform) = if let Some(ref url) = online_url {
                let (_, plat) = detect_platform(Some(url), None);
                (Some(url.clone()), plat)
            } else {
                detect_platform(location_str.as_deref(), body_content.as_deref())
            };

            let event_id = format!("ms_{}", event.id);
            db.upsert_calendar_meeting(
                &event_id,
                &title,
                &start,
                &end,
                &attendees_json,
                location_str.as_deref(),
                meeting_url.as_deref(),
                &platform,
            )?;

            count += 1;
        }

        Ok(count)
    }
}
