//! Ollama backend.
//!
//! Talks to a local Ollama server at `http://localhost:11434`. The user is
//! expected to have installed it (`brew install ollama`) and pulled at
//! least one model (`ollama pull llama3.2`).
//!
//! Structured outputs use Ollama's `format` parameter, which accepts a JSON
//! schema (added in v0.5). The model is constrained to emit JSON matching
//! that schema — much cleaner than prompt-based "please return JSON" tricks.

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::time::Duration;

use super::anthropic_api::{ActionItem, GeneratedNotes, NoteSection};
use super::prompts::{build_diarization_prompt, DIARIZATION_OUTPUT_SCHEMA, NOTE_OUTPUT_SCHEMA};

const BASE_URL: &str = "http://localhost:11434";

// ─── HTTP client ─────────────────────────────────────────────────────────────

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(3))
        .timeout(Duration::from_secs(180)) // local inference can be slow
        .build()
        .expect("reqwest client build")
}

#[derive(Serialize)]
struct ChatRequest<'a> {
    model: &'a str,
    messages: Vec<Message<'a>>,
    stream: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    format: Option<Value>,
}

#[derive(Serialize)]
struct Message<'a> {
    role: &'a str,
    content: &'a str,
}

#[derive(Deserialize)]
struct ChatResponse {
    message: AssistantMessage,
}

#[derive(Deserialize)]
struct AssistantMessage {
    content: String,
}

#[derive(Deserialize)]
struct TagsResponse {
    models: Vec<ModelInfo>,
}

#[derive(Deserialize)]
struct ModelInfo {
    name: String,
}

async fn chat_request(model: &str, prompt: &str, schema: Option<Value>) -> Result<String> {
    let req = ChatRequest {
        model,
        messages: vec![Message { role: "user", content: prompt }],
        stream: false,
        format: schema,
    };
    let resp = client()
        .post(format!("{}/api/chat", BASE_URL))
        .json(&req)
        .send()
        .await
        .map_err(|e| anyhow!("Ollama is unreachable at {} — is it running? ({})", BASE_URL, e))?;
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(anyhow!("Ollama HTTP {}: {}", status, body));
    }
    let parsed: ChatResponse = serde_json::from_str(&body)
        .map_err(|e| anyhow!("could not parse Ollama response: {} (body: {})", e, body))?;
    Ok(parsed.message.content)
}

// ─── Public API ──────────────────────────────────────────────────────────────

pub async fn generate_notes(prompt: &str, model: &str) -> Result<GeneratedNotes> {
    let schema: Value = serde_json::from_str(NOTE_OUTPUT_SCHEMA)?;
    let raw = chat_request(model, prompt, Some(schema)).await?;
    // Smaller local models sometimes leak the schema or wrap output in fences
    // even when `format` is set; strip the common variants before parsing.
    let cleaned = strip_json_fences(&raw);
    serde_json::from_str::<GeneratedNotes>(cleaned)
        .map_err(|e| anyhow!("Ollama returned non-conforming JSON for notes: {} (raw: {})", e, raw))
        .or_else(|_| salvage_notes_from_partial(&raw))
}

pub async fn rediarize(segments: &[(usize, &str)], model: &str) -> Result<HashMap<usize, String>> {
    if segments.is_empty() {
        return Ok(HashMap::new());
    }
    let prompt = build_diarization_prompt(segments);
    let schema: Value = serde_json::from_str(DIARIZATION_OUTPUT_SCHEMA)?;
    let raw = chat_request(model, &prompt, Some(schema)).await?;
    let cleaned = strip_json_fences(&raw);

    #[derive(Deserialize)]
    struct Assignment { index: usize, speaker: String }
    #[derive(Deserialize)]
    struct DiarizationOutput { assignments: Vec<Assignment> }

    let parsed: DiarizationOutput = serde_json::from_str(cleaned)
        .map_err(|e| anyhow!("Ollama returned non-conforming JSON for diarization: {} (raw: {})", e, raw))?;
    Ok(parsed.assignments.into_iter().map(|a| (a.index, a.speaker)).collect())
}

pub async fn chat(prompt: &str, model: &str) -> Result<String> {
    chat_request(model, prompt, None).await
}

/// Quick health probe used by `is_configured` and the frontend status badge.
/// Blocking version so it can run from the synchronous `is_configured` path.
pub fn is_running_blocking() -> bool {
    // Use a separate blocking client with a tight timeout so we don't hang
    // the IPC handler when Ollama isn't installed.
    let result = reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_millis(500))
        .timeout(Duration::from_secs(1))
        .build()
        .and_then(|c| c.get(format!("{}/api/tags", BASE_URL)).send());
    matches!(result, Ok(r) if r.status().is_success())
}

pub async fn list_models() -> Result<Vec<String>> {
    let resp = client()
        .get(format!("{}/api/tags", BASE_URL))
        .send()
        .await
        .map_err(|e| anyhow!("Ollama is unreachable: {}", e))?;
    if !resp.status().is_success() {
        return Err(anyhow!("Ollama HTTP {}", resp.status()));
    }
    let tags: TagsResponse = resp.json().await?;
    Ok(tags.models.into_iter().map(|m| m.name).collect())
}

// ─── Output cleanup ──────────────────────────────────────────────────────────

/// Strip ```json ... ``` fences and leading/trailing whitespace.
fn strip_json_fences(s: &str) -> &str {
    let t = s.trim();
    let stripped = t.strip_prefix("```json")
        .or_else(|| t.strip_prefix("```"))
        .unwrap_or(t);
    let stripped = stripped.trim_start_matches('\n');
    stripped.strip_suffix("```").unwrap_or(stripped).trim()
}

/// Last-resort: if parsing fails, try to find a JSON object in the body that
/// at least has a title + summary, and fill in empty defaults for the rest.
/// Small models occasionally omit `action_items` or `tags`.
fn salvage_notes_from_partial(raw: &str) -> Result<GeneratedNotes> {
    let val: Value = serde_json::from_str(strip_json_fences(raw))
        .map_err(|e| anyhow!("salvage parse failed: {}", e))?;
    Ok(GeneratedNotes {
        title:   val["title"].as_str().unwrap_or("Untitled").to_string(),
        summary: val["summary"].as_str().unwrap_or("").to_string(),
        sections: serde_json::from_value(val["sections"].clone()).unwrap_or_else(|_| {
            vec![NoteSection { heading: "Notes".into(), bullets: vec![val.to_string()] }]
        }),
        action_items: serde_json::from_value(val["action_items"].clone())
            .unwrap_or_else(|_| Vec::<ActionItem>::new()),
        tags: serde_json::from_value(val["tags"].clone()).unwrap_or_default(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_json_fences_handles_plain_json() {
        assert_eq!(strip_json_fences(r#"{"x":1}"#), r#"{"x":1}"#);
    }

    #[test]
    fn strip_json_fences_strips_json_fence() {
        assert_eq!(strip_json_fences("```json\n{\"x\":1}\n```"), r#"{"x":1}"#);
    }

    #[test]
    fn strip_json_fences_strips_plain_fence() {
        assert_eq!(strip_json_fences("```\n{\"x\":1}\n```"), r#"{"x":1}"#);
    }

    #[test]
    fn salvage_fills_missing_fields() {
        let raw = r#"{"title":"T","summary":"S"}"#;
        let n = salvage_notes_from_partial(raw).unwrap();
        assert_eq!(n.title, "T");
        assert_eq!(n.summary, "S");
        assert!(n.action_items.is_empty());
        assert!(n.tags.is_empty());
    }

    // `is_running_blocking` and HTTP-touching tests are intentionally absent —
    // they'd require a live Ollama server, which we can't guarantee in CI.
}
