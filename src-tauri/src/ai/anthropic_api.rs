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
    /// Evidence extracted before composing (plan v5 quotes-first schema).
    /// Drives grounding during generation; not rendered.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub key_quotes: Vec<KeyQuote>,
    pub title: String,
    pub summary: String,
    pub sections: Vec<NoteSection>,
    pub action_items: Vec<ActionItem>,
    pub tags: Vec<String>,
    /// Optional per-bullet transcript provenance (plan v3 rank 7) — validated
    /// Rust-side like action-item refs; rendered as a ⏱ m:ss replay mark.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub bullet_anchors: Vec<BulletAnchor>,
    /// Enhance receipt (plan v10 #2) — stamped by `generate_meeting_notes`
    /// AFTER generation, never produced by the model: which provider/model
    /// ran and the transcript hash the prompt was built from. The frontend
    /// hands it back when persisting, so the receipt records what actually
    /// generated the notes (not whatever the settings say seconds later).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub receipt: Option<GenerationReceipt>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GenerationReceipt {
    pub provider: String,
    pub model: String,
    /// sha256 of the segments JSON at generation time (`segments_snapshot`);
    /// None when the meeting has no transcript at all.
    pub transcript_sha: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KeyQuote {
    pub quote: String,
    #[serde(default, deserialize_with = "lenient_ms")]
    pub start_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BulletAnchor {
    pub section_index: usize,
    pub bullet_index: usize,
    pub source_start_ms: u64,
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
    /// Transcript position (ms) this item was drawn from, when the model
    /// can cite the [m:ss] line — drives the verifiability chip in the UI.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "lenient_ms"
    )]
    pub source_start_ms: Option<u64>,
}

/// A model that fumbles the citation field (negative number, float, string)
/// must cost only the chip, never the whole notes parse.
fn lenient_ms<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<u64>, D::Error> {
    let v = Option::<serde_json::Value>::deserialize(d)?;
    Ok(v.and_then(|v| match v {
        serde_json::Value::Number(n) => n
            .as_u64()
            .or_else(|| n.as_f64().filter(|f| *f >= 0.0).map(|f| f as u64)),
        serde_json::Value::String(s) => s.trim().parse::<u64>().ok(),
        _ => None,
    }))
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
    #[serde(skip_serializing_if = "Option::is_none")]
    stream: Option<bool>,
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
        system: Some(super::prompts::NOTES_SYSTEM_PROMPT),
        messages: vec![UserMessage { role: "user", content: prompt }],
        tools: Some(vec![Tool {
            name: "emit_notes".into(),
            description: "Emit the structured meeting notes.".into(),
            input_schema: schema,
        }]),
        tool_choice: Some(ToolChoice::Tool { name: "emit_notes".into() }),
        stream: None,
    };
    let resp = send(api_key, &req).await?;
    let input = extract_tool_input(resp)?;
    serde_json::from_value(input).map_err(|e| anyhow!("structured notes did not match schema: {}", e))
}

/// Streaming variant of `generate_notes`. The request forces tool-use, so
/// deltas arrive as `input_json_delta` fragments of the structured output;
/// we accumulate the full JSON for the final parse while live-extracting the
/// `summary` string so its words can be shown as the model writes them.
pub async fn generate_notes_streaming(
    prompt: &str,
    api_key: &str,
    model: &str,
    on_delta: &(dyn Fn(&str) + Send + Sync),
) -> Result<GeneratedNotes> {
    use futures_util::StreamExt;
    let schema: serde_json::Value = serde_json::from_str(NOTE_OUTPUT_SCHEMA)?;
    let req = MessagesRequest {
        model,
        max_tokens: DEFAULT_MAX_TOKENS,
        system: Some(super::prompts::NOTES_SYSTEM_PROMPT),
        messages: vec![UserMessage { role: "user", content: prompt }],
        tools: Some(vec![Tool {
            name: "emit_notes".into(),
            description: "Emit the structured meeting notes.".into(),
            input_schema: schema,
        }]),
        tool_choice: Some(ToolChoice::Tool { name: "emit_notes".into() }),
        stream: Some(true),
    };

    let resp = client()
        .post(API_URL)
        .header("x-api-key", api_key)
        .header("anthropic-version", API_VERSION)
        .header("content-type", "application/json")
        .json(&req)
        .send()
        .await
        .map_err(|e| anyhow!("Anthropic API request failed: {}", e))?;

    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        if let Ok(err) = serde_json::from_str::<ApiError>(&body) {
            return Err(anyhow!("Anthropic API error ({}): {}", err.error.kind, err.error.message));
        }
        return Err(anyhow!("Anthropic API HTTP {}: {}", status, body));
    }

    let mut stream = resp.bytes_stream();
    let mut line_buf = String::new();
    let mut full_json = String::new();
    let mut summary = SummaryStreamer::new();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| anyhow!("Anthropic stream read failed: {}", e))?;
        line_buf.push_str(&String::from_utf8_lossy(&chunk));
        while let Some(nl) = line_buf.find('\n') {
            let line: String = line_buf[..nl].trim_end_matches('\r').to_string();
            line_buf.drain(..=nl);
            let Some(data) = line.strip_prefix("data: ") else { continue };
            let Ok(v) = serde_json::from_str::<serde_json::Value>(data) else { continue };
            match v.get("type").and_then(|t| t.as_str()) {
                Some("content_block_delta") => {
                    if let Some(pj) = v.pointer("/delta/partial_json").and_then(|p| p.as_str()) {
                        full_json.push_str(pj);
                        if let Some(text) = summary.feed(pj) {
                            if !text.is_empty() {
                                on_delta(&text);
                            }
                        }
                    }
                }
                Some("error") => {
                    let msg = v
                        .pointer("/error/message")
                        .and_then(|m| m.as_str())
                        .unwrap_or("unknown stream error");
                    return Err(anyhow!("Anthropic stream error: {}", msg));
                }
                _ => {}
            }
        }
    }

    serde_json::from_str(&full_json)
        .map_err(|e| anyhow!("structured notes did not match schema: {}", e))
}

/// Incremental extractor for the `"summary"` string inside the streaming
/// tool-use JSON: finds the key, then unescapes and yields the value's
/// characters as they arrive, stopping at the closing quote.
pub(crate) struct SummaryStreamer {
    buf: String,
    state: SummaryState,
}

pub(crate) enum SummaryState {
    Searching,
    InString { escaped: bool },
    Done,
}

impl SummaryStreamer {
    pub(crate) fn new() -> Self {
        Self { buf: String::new(), state: SummaryState::Searching }
    }

    pub(crate) fn feed(&mut self, chunk: &str) -> Option<String> {
        match self.state {
            SummaryState::Done => None,
            SummaryState::Searching => {
                self.buf.push_str(chunk);
                if let Some(k) = self.buf.find("\"summary\"") {
                    let rest = self.buf[k + 9..].to_string();
                    if let Some(q) = rest.find('"') {
                        if rest[..q].chars().all(|c| c.is_whitespace() || c == ':') {
                            let after = rest[q + 1..].to_string();
                            self.buf.clear();
                            self.state = SummaryState::InString { escaped: false };
                            return self.feed_value(&after);
                        }
                    }
                }
                // Bound the search buffer; keep a tail so a key split across
                // chunks is still found.
                if self.buf.len() > 8192 {
                    let cut = self.buf.len() - 64;
                    self.buf.drain(..cut);
                }
                None
            }
            SummaryState::InString { .. } => self.feed_value(chunk),
        }
    }

    fn feed_value(&mut self, chunk: &str) -> Option<String> {
        let SummaryState::InString { mut escaped } = self.state else {
            return None;
        };
        let mut out = String::new();
        for c in chunk.chars() {
            if escaped {
                match c {
                    'n' => out.push('\n'),
                    't' => out.push('\t'),
                    _ => out.push(c),
                }
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == '"' {
                self.state = SummaryState::Done;
                return Some(out);
            } else {
                out.push(c);
            }
        }
        self.state = SummaryState::InString { escaped };
        Some(out)
    }
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
        stream: None,
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
        stream: None,
    };
    let resp = send(api_key, &req).await?;
    extract_text(resp)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fumbled_citation_fields_cost_the_chip_not_the_parse() {
        let parse = |v: &str| -> ActionItem {
            serde_json::from_str(&format!(r#"{{"task":"t","assignee":null,"deadline":null,"source_start_ms":{v}}}"#)).unwrap()
        };
        assert_eq!(parse("65000").source_start_ms, Some(65_000));
        assert_eq!(parse("-3").source_start_ms, None);
        assert_eq!(parse("6500.7").source_start_ms, Some(6_500));
        assert_eq!(parse("\"65000\"").source_start_ms, Some(65_000));
        assert_eq!(parse("\"about a minute in\"").source_start_ms, None);
        assert_eq!(parse("null").source_start_ms, None);
        let missing: ActionItem =
            serde_json::from_str(r#"{"task":"t","assignee":null,"deadline":null}"#).unwrap();
        assert_eq!(missing.source_start_ms, None);
    }

    #[test]
    fn summary_streamer_extracts_across_chunk_boundaries() {
        let mut s = SummaryStreamer::new();
        let mut out = String::new();
        let chunks = [
            r#"{"title":"T","su"#,
            r#"mmary":"Hel"#,
            r#"lo \"world\" line"#,
            r#"","sections":[]"#,
        ];
        for c in chunks {
            if let Some(t) = s.feed(c) {
                out.push_str(&t);
            }
        }
        assert_eq!(out, "Hello \"world\" line");
        // After the closing quote, nothing more is emitted.
        assert!(s.feed(r#""summary":"again""#).is_none());
    }

    #[test]
    fn summary_streamer_handles_missing_summary() {
        let mut s = SummaryStreamer::new();
        assert!(matches!(s.feed(r#"{"title":"only"}"#), None));
    }

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
            key_quotes: Vec::new(),
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
                source_start_ms: None,
            }],
            tags: vec!["t".into()],
            bullet_anchors: Vec::new(),
            receipt: None,
        };
        let s = serde_json::to_string(&notes).unwrap();
        let back: GeneratedNotes = serde_json::from_str(&s).unwrap();
        assert_eq!(back.title, "T");
        assert_eq!(back.action_items[0].assignee.as_deref(), Some("Alice"));
    }
}
