//! Direct Anthropic Messages API client.
//!
//! Replaces the prior `claude -p` subprocess invocation. Users supply their
//! own API key (stored in the macOS Keychain via `secrets::SecretKey::AnthropicApiKey`).
//! Structured output is forced via tool-use with `tool_choice`, which is the
//! API equivalent of the CLI's `--json-schema` flag.

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::Duration;

use super::prompts::{
    build_diarization_prompt, DIARIZATION_OUTPUT_SCHEMA, NOTE_OUTPUT_SCHEMA,
};

const API_URL: &str = "https://api.anthropic.com/v1/messages";
const API_VERSION: &str = "2023-06-01";
const DEFAULT_MAX_TOKENS: u32 = 8192;
pub const DEFAULT_MODEL: &str = "claude-sonnet-4-6";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GeneratedNotes {
    pub title: String,
    pub summary: String,
    pub sections: Vec<NoteSection>,
    pub action_items: Vec<ActionItem>,
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoteSection {
    pub heading: String,
    pub bullets: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActionItem {
    pub task: String,
    pub assignee: Option<String>,
    pub deadline: Option<String>,
}

// ─── Wire format ─────────────────────────────────────────────────────────────

#[derive(Serialize)]
struct MessagesRequest<'a> {
    model: &'a str,
    max_tokens: u32,
    messages: Vec<UserMessage<'a>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    system: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tools: Option<Vec<Tool>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_choice: Option<ToolChoice>,
}

#[derive(Serialize)]
struct UserMessage<'a> {
    role: &'a str,
    content: &'a str,
}

#[derive(Serialize)]
struct Tool {
    name: String,
    description: String,
    input_schema: serde_json::Value,
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ToolChoice {
    Tool { name: String },
}

#[derive(Deserialize)]
struct MessagesResponse {
    content: Vec<ContentBlock>,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ContentBlock {
    Text { text: String },
    ToolUse { input: serde_json::Value },
}

#[derive(Deserialize)]
struct ApiError {
    error: ApiErrorBody,
}

#[derive(Deserialize)]
struct ApiErrorBody {
    #[serde(rename = "type")]
    kind: String,
    message: String,
}

// ─── HTTP client ─────────────────────────────────────────────────────────────

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(120))
        .user_agent(concat!("Perchnote/", env!("CARGO_PKG_VERSION")))
        .build()
        .expect("reqwest client build")
}

async fn send(api_key: &str, req: &MessagesRequest<'_>) -> Result<MessagesResponse> {
    let resp = client()
        .post(API_URL)
        .header("x-api-key", api_key)
        .header("anthropic-version", API_VERSION)
        .header("content-type", "application/json")
        .json(req)
        .send()
        .await
        .map_err(|e| anyhow!("Anthropic API request failed: {}", e))?;

    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();

    if !status.is_success() {
        // Parse the structured error body if we can — the message field is
        // what tells the user "invalid x-api-key" vs rate-limit vs etc.
        if let Ok(err) = serde_json::from_str::<ApiError>(&body) {
            return Err(anyhow!(
                "Anthropic API error ({}): {}",
                err.error.kind,
                err.error.message
            ));
        }
        return Err(anyhow!("Anthropic API HTTP {}: {}", status, body));
    }

    serde_json::from_str::<MessagesResponse>(&body)
        .map_err(|e| anyhow!("failed to parse Anthropic response: {} (body: {})", e, body))
}

/// Pull the input of the first `tool_use` block, or fall back to text.
fn extract_tool_input(resp: MessagesResponse) -> Result<serde_json::Value> {
    for block in resp.content {
        if let ContentBlock::ToolUse { input } = block {
            return Ok(input);
        }
    }
    Err(anyhow!("no tool_use block in response"))
}

fn extract_text(resp: MessagesResponse) -> Result<String> {
    for block in resp.content {
        if let ContentBlock::Text { text } = block {
            return Ok(text);
        }
    }
    Err(anyhow!("no text block in response"))
}

// ─── Public API ──────────────────────────────────────────────────────────────

/// Generate structured meeting notes. Forces the model to emit a single
/// `tool_use` call matching `NOTE_OUTPUT_SCHEMA` — equivalent to the CLI's
/// `--json-schema` flag.
pub async fn generate_notes(prompt: &str, api_key: &str, model: &str) -> Result<GeneratedNotes> {
    let schema: serde_json::Value = serde_json::from_str(NOTE_OUTPUT_SCHEMA)?;
    let req = MessagesRequest {
        model,
        max_tokens: DEFAULT_MAX_TOKENS,
        system: None,
        messages: vec![UserMessage { role: "user", content: prompt }],
        tools: Some(vec![Tool {
            name: "emit_notes".into(),
            description: "Emit the structured meeting notes.".into(),
            input_schema: schema,
        }]),
        tool_choice: Some(ToolChoice::Tool { name: "emit_notes".into() }),
    };
    let resp = send(api_key, &req).await?;
    let input = extract_tool_input(resp)?;
    serde_json::from_value(input).map_err(|e| anyhow!("structured notes did not match schema: {}", e))
}

/// Re-diarize transcript segments by asking the model to assign a speaker
/// label to each `(index, text)` pair.
pub async fn rediarize(
    segments: &[(usize, &str)],
    api_key: &str,
    model: &str,
) -> Result<HashMap<usize, String>> {
    if segments.is_empty() {
        return Ok(HashMap::new());
    }
    let prompt = build_diarization_prompt(segments);
    let schema: serde_json::Value = serde_json::from_str(DIARIZATION_OUTPUT_SCHEMA)?;
    let req = MessagesRequest {
        model,
        max_tokens: DEFAULT_MAX_TOKENS,
        system: None,
        messages: vec![UserMessage { role: "user", content: &prompt }],
        tools: Some(vec![Tool {
            name: "emit_assignments".into(),
            description: "Emit the per-segment speaker assignments.".into(),
            input_schema: schema,
        }]),
        tool_choice: Some(ToolChoice::Tool { name: "emit_assignments".into() }),
    };
    let resp = send(api_key, &req).await?;
    let input = extract_tool_input(resp)?;

    #[derive(Deserialize)]
    struct Assignment {
        index: usize,
        speaker: String,
    }
    #[derive(Deserialize)]
    struct DiarizationOutput {
        assignments: Vec<Assignment>,
    }
    let parsed: DiarizationOutput = serde_json::from_value(input)
        .map_err(|e| anyhow!("diarization output did not match schema: {}", e))?;
    Ok(parsed.assignments.into_iter().map(|a| (a.index, a.speaker)).collect())
}

/// Available model listing returned by `GET /v1/models`. We expose `id`
/// (used in API requests) and `display_name` (human-readable, e.g.
/// "Claude Sonnet 4.6"). `created_at` is also surfaced so the UI can sort
/// newest-first without us hardcoding a model order.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelListing {
    pub id: String,
    pub display_name: String,
    pub created_at: String,
}

pub async fn list_models(api_key: &str) -> Result<Vec<ModelListing>> {
    #[derive(Deserialize)]
    struct ListResponse {
        data: Vec<ModelListing>,
    }
    let url = "https://api.anthropic.com/v1/models";
    let resp = client()
        .get(url)
        .header("x-api-key", api_key)
        .header("anthropic-version", API_VERSION)
        .send()
        .await
        .map_err(|e| anyhow!("Anthropic API request failed: {}", e))?;
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        if let Ok(err) = serde_json::from_str::<ApiError>(&body) {
            return Err(anyhow!("Anthropic API error ({}): {}", err.error.kind, err.error.message));
        }
        return Err(anyhow!("Anthropic API HTTP {}: {}", status, body));
    }
    let parsed: ListResponse = serde_json::from_str(&body)
        .map_err(|e| anyhow!("failed to parse model list: {}", e))?;
    Ok(parsed.data)
}

/// Plain-text chat reply. No tool use — the meeting-chat UI expects free-form
/// prose, not a structured blob.
pub async fn chat(prompt: &str, api_key: &str, model: &str) -> Result<String> {
    let req = MessagesRequest {
        model,
        max_tokens: DEFAULT_MAX_TOKENS,
        system: Some("You are a meeting notes assistant. Answer using ONLY the text provided in the prompt."),
        messages: vec![UserMessage { role: "user", content: prompt }],
        tools: None,
        tool_choice: None,
    };
    let resp = send(api_key, &req).await?;
    extract_text(resp)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_tool_input_picks_first_tool_use() {
        let resp = MessagesResponse {
            content: vec![
                ContentBlock::Text { text: "thinking…".into() },
                ContentBlock::ToolUse { input: serde_json::json!({"x": 1}) },
            ],
        };
        let input = extract_tool_input(resp).unwrap();
        assert_eq!(input, serde_json::json!({"x": 1}));
    }

    #[test]
    fn test_extract_tool_input_errors_when_none() {
        let resp = MessagesResponse {
            content: vec![ContentBlock::Text { text: "no tool".into() }],
        };
        assert!(extract_tool_input(resp).is_err());
    }

    #[test]
    fn test_extract_text_picks_first_text() {
        let resp = MessagesResponse {
            content: vec![
                ContentBlock::ToolUse { input: serde_json::json!({}) },
                ContentBlock::Text { text: "hello".into() },
            ],
        };
        assert_eq!(extract_text(resp).unwrap(), "hello");
    }

    #[test]
    fn test_parse_api_error_body() {
        let body = r#"{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}"#;
        let err: ApiError = serde_json::from_str(body).unwrap();
        assert_eq!(err.error.kind, "authentication_error");
        assert!(err.error.message.contains("invalid"));
    }

    #[test]
    fn test_generated_notes_schema_roundtrip() {
        let notes = GeneratedNotes {
            title: "T".into(),
            summary: "S".into(),
            sections: vec![NoteSection {
                heading: "H".into(),
                bullets: vec!["b1".into()],
            }],
            action_items: vec![ActionItem {
                task: "do it".into(),
                assignee: Some("Alice".into()),
                deadline: None,
            }],
            tags: vec!["t".into()],
        };
        let s = serde_json::to_string(&notes).unwrap();
        let back: GeneratedNotes = serde_json::from_str(&s).unwrap();
        assert_eq!(back.title, "T");
        assert_eq!(back.action_items[0].assignee.as_deref(), Some("Alice"));
    }
}
