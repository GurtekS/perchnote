//! Keychain-backed secret storage.
//!
//! All long-lived credentials (OAuth tokens, client secrets, Slack webhook)
//! live in the macOS Keychain rather than in the SQLite settings table, so a
//! filesystem-level compromise of the app data dir does not yield bearer
//! tokens.

use anyhow::{anyhow, Result};
use keyring::Entry;

const SERVICE: &str = "com.perchnote.app";

/// Allow-list of keys we'll ever read/write. Keeps the call sites typo-proof
/// and the audit surface small.
#[derive(Debug, Clone, Copy)]
pub enum SecretKey {
    GoogleClientSecret,
    GoogleOAuthTokens,
    MicrosoftClientSecret,
    MicrosoftOAuthTokens,
    SlackWebhookUrl,
    AnthropicApiKey,
}

impl SecretKey {
    fn name(self) -> &'static str {
        match self {
            SecretKey::GoogleClientSecret => "google_client_secret",
            SecretKey::GoogleOAuthTokens => "google_oauth_tokens",
            SecretKey::MicrosoftClientSecret => "microsoft_client_secret",
            SecretKey::MicrosoftOAuthTokens => "microsoft_oauth_tokens",
            SecretKey::SlackWebhookUrl => "slack_webhook_url",
            SecretKey::AnthropicApiKey => "anthropic_api_key",
        }
    }
}

fn entry(key: SecretKey) -> Result<Entry> {
    Entry::new(SERVICE, key.name())
        .map_err(|e| anyhow!("keychain entry for {}: {}", key.name(), e))
}

/// Process-lifetime cache (user report: "Perchnote wants to use your
/// confidential information…" kept appearing). Every keychain READ can
/// trigger the macOS authorization prompt — and the AI key was being read
/// on every call, plus `has()` on every check_ai_configured UI query. One
/// read per key per app run is the most the keychain ever sees now; the
/// prompt appears at most once per launch (and "Always Allow" silences it
/// entirely until the app binary changes, i.e. until a new build is
/// installed — unsigned builds get a fresh identity each time).
static CACHE: std::sync::Mutex<Option<std::collections::HashMap<&'static str, Option<String>>>> =
    std::sync::Mutex::new(None);

fn cache_get(name: &'static str) -> Option<Option<String>> {
    CACHE.lock().ok()?.as_ref()?.get(name).cloned()
}

fn cache_put(name: &'static str, value: Option<String>) {
    if let Ok(mut guard) = CACHE.lock() {
        guard.get_or_insert_with(Default::default).insert(name, value);
    }
}

pub fn set(key: SecretKey, value: &str) -> Result<()> {
    entry(key)?.set_password(value)
        .map_err(|e| anyhow!("keychain write for {}: {}", key.name(), e))?;
    cache_put(key.name(), Some(value.to_string()));
    Ok(())
}

pub fn get(key: SecretKey) -> Result<Option<String>> {
    if let Some(hit) = cache_get(key.name()) {
        return Ok(hit);
    }
    let fresh = match entry(key)?.get_password() {
        Ok(v) => Some(v),
        Err(keyring::Error::NoEntry) => None,
        Err(e) => return Err(anyhow!("keychain read for {}: {}", key.name(), e)),
    };
    cache_put(key.name(), fresh.clone());
    Ok(fresh)
}

pub fn delete(key: SecretKey) -> Result<()> {
    match entry(key)?.delete_credential() {
        Ok(_) | Err(keyring::Error::NoEntry) => {
            cache_put(key.name(), None);
            Ok(())
        }
        Err(e) => Err(anyhow!("keychain delete for {}: {}", key.name(), e)),
    }
}

pub fn has(key: SecretKey) -> bool {
    matches!(get(key), Ok(Some(_)))
}

/// One-shot migration: drop any legacy plaintext rows from the SQLite settings
/// table. The keychain is now authoritative; existing users will be prompted
/// to re-authenticate Google/Microsoft on next sync, which is intentional.
pub fn purge_legacy_plaintext_rows(db: &crate::db::Database) {
    const LEGACY_KEYS: &[&str] = &[
        "google_oauth_tokens",
        "google_client_secret",
        "microsoft_oauth_tokens",
        "microsoft_client_secret",
        "slack_webhook_url",
        "anthropic_api_key",
    ];
    if let Ok(conn) = db.conn.lock() {
        for key in LEGACY_KEYS {
            let _ = conn.execute("DELETE FROM settings WHERE key = ?1", rusqlite::params![key]);
        }
    }
}
