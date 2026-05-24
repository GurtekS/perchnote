use anyhow::{anyhow, Result};
use reqwest::Client;
use serde::{Deserialize, Serialize};

use crate::db::Database;
use super::detection::detect_platform;

const CALENDAR_API_BASE: &str = "https://www.googleapis.com/calendar/v3";
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const SCOPE: &str = "https://www.googleapis.com/auth/calendar.events.readonly";

// Compile-time embedded credentials (set via env vars at build time)
const EMBEDDED_CLIENT_ID: Option<&str> = option_env!("GOOGLE_CLIENT_ID");
const EMBEDDED_CLIENT_SECRET: Option<&str> = option_env!("GOOGLE_CLIENT_SECRET");

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OAuthTokens {
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
    items: Option<Vec<CalendarEvent>>,
}

#[derive(Debug, Deserialize)]
struct CalendarEvent {
    id: String,
    summary: Option<String>,
    start: Option<EventTime>,
    end: Option<EventTime>,
    attendees: Option<Vec<Attendee>>,
    location: Option<String>,
    description: Option<String>,
}

#[derive(Debug, Deserialize)]
struct EventTime {
    #[serde(rename = "dateTime")]
    date_time: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
struct Attendee {
    email: Option<String>,
    #[serde(rename = "displayName")]
    display_name: Option<String>,
}

pub struct GoogleCalendar {
    client: Client,
    client_id: String,
    client_secret: String,
}

impl GoogleCalendar {
    pub fn new(client_id: String, client_secret: String) -> Self {
        Self {
            client: crate::calendar::http::build_client(),
            client_id,
            client_secret,
        }
    }

    /// Create from embedded credentials or DB/Keychain fallback.
    pub fn from_db(db: &Database) -> Result<Self> {
        let client_id = EMBEDDED_CLIENT_ID
            .map(|s| s.to_string())
            .or_else(|| db.get_setting("google_client_id").ok().flatten())
            .ok_or_else(|| anyhow!("Google Client ID not configured"))?;
        let client_secret = EMBEDDED_CLIENT_SECRET
            .map(|s| s.to_string())
            .or_else(|| crate::secrets::get(crate::secrets::SecretKey::GoogleClientSecret).ok().flatten())
            .ok_or_else(|| anyhow!("Google Client Secret not configured"))?;
        Ok(Self::new(client_id, client_secret))
    }

    /// Whether OAuth credentials are available (embedded or configured).
    pub fn has_credentials(db: &Database) -> bool {
        EMBEDDED_CLIENT_ID.is_some()
            || db.get_setting("google_client_id").ok().flatten().is_some()
    }

    /// Generate the OAuth authorization URL
    pub fn auth_url(&self, redirect_port: u16) -> String {
        let redirect_uri = format!("http://localhost:{}/callback", redirect_port);
        format!(
            "{}?client_id={}&redirect_uri={}&response_type=code&scope={}&access_type=offline&prompt=consent",
            AUTH_URL,
            urlencoding::encode(&self.client_id),
            urlencoding::encode(&redirect_uri),
            urlencoding::encode(SCOPE),
        )
    }

    /// Exchange authorization code for tokens
    pub async fn exchange_code(&self, code: &str, redirect_port: u16) -> Result<OAuthTokens> {
        let redirect_uri = format!("http://localhost:{}/callback", redirect_port);
        let resp = self.client
            .post(TOKEN_URL)
            .form(&[
                ("code", code),
                ("client_id", &self.client_id),
                ("client_secret", &self.client_secret),
                ("redirect_uri", &redirect_uri),
                ("grant_type", "authorization_code"),
            ])
            .send()
            .await?
            .json::<TokenResponse>()
            .await?;

        let expires_at = chrono::Utc::now().timestamp() + resp.expires_in;
        Ok(OAuthTokens {
            access_token: resp.access_token,
            refresh_token: resp.refresh_token.unwrap_or_default(),
            expires_at,
        })
    }

    /// Refresh an expired access token
    pub async fn refresh_token(&self, refresh_token: &str) -> Result<OAuthTokens> {
        let resp = self.client
            .post(TOKEN_URL)
            .form(&[
                ("refresh_token", refresh_token),
                ("client_id", &self.client_id),
                ("client_secret", &self.client_secret),
                ("grant_type", "refresh_token"),
            ])
            .send()
            .await?
            .json::<TokenResponse>()
            .await?;

        let expires_at = chrono::Utc::now().timestamp() + resp.expires_in;
        Ok(OAuthTokens {
            access_token: resp.access_token,
            refresh_token: resp.refresh_token.unwrap_or_else(|| refresh_token.to_string()),
            expires_at,
        })
    }

    /// Fetch upcoming events for the configured date range
    async fn fetch_upcoming_events(&self, access_token: &str, past_days: u32, future_days: u32) -> Result<Vec<CalendarEvent>> {
        let now = chrono::Utc::now();
        let time_min = now - chrono::Duration::days(past_days as i64);
        let time_max = now + chrono::Duration::days(future_days as i64);

        let resp = self.client
            .get(format!("{}/calendars/primary/events", CALENDAR_API_BASE))
            .bearer_auth(access_token)
            .query(&[
                ("timeMin", time_min.to_rfc3339()),
                ("timeMax", time_max.to_rfc3339()),
                ("singleEvents", "true".to_string()),
                ("orderBy", "startTime".to_string()),
            ])
            .send()
            .await?;

        if !resp.status().is_success() {
            return Err(anyhow!("calendar API returned {}", resp.status()));
        }

        let body = resp.json::<CalendarEventsResponse>().await?;
        Ok(body.items.unwrap_or_default())
    }

    /// Sync calendar events into the database
    pub async fn sync_events(&self, db: &Database, access_token: &str, past_days: u32, future_days: u32) -> Result<usize> {
        let events = self.fetch_upcoming_events(access_token, past_days, future_days).await?;
        let mut count = 0;

        for event in events {
            let title = event.summary.unwrap_or_else(|| "Untitled Meeting".to_string());
            let start = event.start.and_then(|t| t.date_time).unwrap_or_default();
            let end = event.end.and_then(|t| t.date_time).unwrap_or_default();

            let attendees_json = serde_json::to_string(
                &event.attendees.unwrap_or_default()
            )?;

            let (meeting_url, platform) = detect_platform(
                event.location.as_deref(),
                event.description.as_deref(),
            );

            db.upsert_calendar_meeting(
                &event.id,
                &title,
                &start,
                &end,
                &attendees_json,
                event.location.as_deref(),
                meeting_url.as_deref(),
                &platform,
            )?;

            count += 1;
        }

        Ok(count)
    }
}
