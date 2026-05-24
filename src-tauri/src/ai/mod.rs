//! AI module — provider-agnostic entry points.
//!
//! Three backends are supported:
//!   * `Anthropic`         — the Anthropic Messages API (bring-your-own-key)
//!   * `Ollama`            — a local Ollama server at `http://localhost:11434`
//!   * `AppleIntelligence` — Apple's on-device FoundationModels (macOS 26+)
//!
//! The user picks one in Settings → AI. This module reads that choice from
//! the DB settings table and dispatches `generate_notes`, `rediarize`, and
//! `chat` to the right implementation.

pub mod anthropic_api;
pub mod apple_ai;
pub mod ollama;
pub mod prompts;

use anyhow::{anyhow, Result};
use std::collections::HashMap;

use crate::db::Database;
use crate::secrets::{self, SecretKey};

pub use anthropic_api::{GeneratedNotes, DEFAULT_MODEL as DEFAULT_ANTHROPIC_MODEL};

/// DB settings keys.
pub const PROVIDER_SETTING: &str = "ai_provider";
pub const ANTHROPIC_MODEL_SETTING: &str = "anthropic_model";
pub const OLLAMA_MODEL_SETTING: &str = "ollama_model";

const DEFAULT_OLLAMA_MODEL: &str = "llama3.2";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Provider {
    Anthropic,
    Ollama,
    AppleIntelligence,
}

impl Provider {
    fn from_str(s: &str) -> Self {
        match s {
            "ollama" => Provider::Ollama,
            "apple"  => Provider::AppleIntelligence,
            _        => Provider::Anthropic,
        }
    }
}

fn selected_provider(db: &Database) -> Provider {
    let raw = db.get_setting(PROVIDER_SETTING).ok().flatten();
    Provider::from_str(raw.as_deref().unwrap_or("anthropic"))
}

/// True when the selected provider is ready to use. Frontend uses this to
/// gate the "Enhance" / "Ask AI" affordances.
pub fn is_configured(db: &Database) -> bool {
    match selected_provider(db) {
        Provider::Anthropic         => secrets::has(SecretKey::AnthropicApiKey),
        Provider::Ollama            => ollama::is_running_blocking(),
        Provider::AppleIntelligence => apple_ai::is_available(),
    }
}

fn anthropic_creds(db: &Database) -> Result<(String, String)> {
    let key = secrets::get(SecretKey::AnthropicApiKey)?
        .ok_or_else(|| anyhow!("No Anthropic API key configured. Add one in Settings → AI."))?;
    let model = db
        .get_setting(ANTHROPIC_MODEL_SETTING)
        .ok()
        .flatten()
        .unwrap_or_else(|| DEFAULT_ANTHROPIC_MODEL.to_string());
    Ok((key, model))
}

fn ollama_model(db: &Database) -> String {
    db.get_setting(OLLAMA_MODEL_SETTING)
        .ok()
        .flatten()
        .unwrap_or_else(|| DEFAULT_OLLAMA_MODEL.to_string())
}

pub async fn generate_notes(db: &Database, prompt: &str) -> Result<GeneratedNotes> {
    match selected_provider(db) {
        Provider::Anthropic => {
            let (key, model) = anthropic_creds(db)?;
            anthropic_api::generate_notes(prompt, &key, &model).await
        }
        Provider::Ollama => {
            let model = ollama_model(db);
            ollama::generate_notes(prompt, &model).await
        }
        Provider::AppleIntelligence => apple_ai::generate_notes(prompt).await,
    }
}

pub async fn rediarize(db: &Database, segments: &[(usize, &str)]) -> Result<HashMap<usize, String>> {
    match selected_provider(db) {
        Provider::Anthropic => {
            let (key, model) = anthropic_creds(db)?;
            anthropic_api::rediarize(segments, &key, &model).await
        }
        Provider::Ollama => {
            let model = ollama_model(db);
            ollama::rediarize(segments, &model).await
        }
        Provider::AppleIntelligence => apple_ai::rediarize(segments).await,
    }
}

pub async fn chat(db: &Database, prompt: &str) -> Result<String> {
    match selected_provider(db) {
        Provider::Anthropic => {
            let (key, model) = anthropic_creds(db)?;
            anthropic_api::chat(prompt, &key, &model).await
        }
        Provider::Ollama => {
            let model = ollama_model(db);
            ollama::chat(prompt, &model).await
        }
        Provider::AppleIntelligence => apple_ai::chat(prompt).await,
    }
}
