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
pub mod apple_embed;
pub mod embeddings;
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

/// (provider, model) that a generation dispatched right now would use —
/// stamped onto the enhance receipt (plan v10 #2). Resolved the same way
/// `generate_notes` resolves its backend, minus the credential checks
/// (the receipt records intent at dispatch; a missing key fails the call
/// itself before anything is persisted).
pub fn provider_receipt(db: &Database) -> (String, String) {
    match selected_provider(db) {
        Provider::Anthropic => (
            "anthropic".to_string(),
            db.get_setting(ANTHROPIC_MODEL_SETTING)
                .ok()
                .flatten()
                .unwrap_or_else(|| DEFAULT_ANTHROPIC_MODEL.to_string()),
        ),
        Provider::Ollama => ("ollama".to_string(), ollama_model(db)),
        Provider::AppleIntelligence => ("apple".to_string(), "on-device".to_string()),
    }
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

/// Streaming variant of `generate_notes`. Anthropic streams live summary
/// deltas through `on_delta`; other providers fall back to the blocking
/// call and emit nothing (the UI keeps its skeleton).
pub async fn generate_notes_streaming(
    db: &Database,
    prompt: &str,
    on_delta: &(dyn Fn(&str) + Send + Sync),
) -> Result<GeneratedNotes> {
    match selected_provider(db) {
        Provider::Anthropic => {
            let (key, model) = anthropic_creds(db)?;
            anthropic_api::generate_notes_streaming(prompt, &key, &model, on_delta).await
        }
        Provider::Ollama => {
            let model = ollama_model(db);
            ollama::generate_notes_streaming(prompt, &model, on_delta).await
        }
        // Apple Intelligence stays blocking until snapshot streaming lands
        // in the Swift bridge.
        Provider::AppleIntelligence => generate_notes(db, prompt).await,
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
