//! perchnote-mcp — a local, read-only MCP server over your Perchnote meetings.
//!
//! An MCP client (Claude Desktop, Claude Code, anything speaking the Model
//! Context Protocol) spawns this binary as a child process and talks JSON-RPC
//! 2.0 over stdio, one message per line. There is no port, no network
//! listener, and no account: the only thing this process can do is read the
//! local Perchnote database (`Database::open_read_only` — SQLite enforces
//! read-only at the connection level), and the only peer that can talk to it
//! is the process the user explicitly configured to spawn it.
//!
//! The protocol layer is hand-rolled rather than pulling in the async MCP
//! SDK: four read-only tools need exactly four methods plus one notification,
//! serde_json is already in the tree, and blocking stdio keeps the binary
//! boring and unit-testable over in-memory readers/writers.
//!
//! stdout carries protocol frames ONLY; all diagnostics go to stderr.
//!
//! What is deliberately never exposed: calendar/ICS attendee data (the
//! `attendees` column), settings, anything API-key-adjacent, and any write
//! operation. See docs/SECURITY.md.

use std::collections::HashMap;
use std::io::{BufRead, Write};
use std::path::PathBuf;

use perchnote_lib::db::queries::{markdown_of_tiptap, Meeting, SegmentHit};
use perchnote_lib::db::Database;
use serde_json::{json, Value};

const SERVER_NAME: &str = "perchnote-mcp";
const SERVER_VERSION: &str = env!("CARGO_PKG_VERSION");
/// Spec revisions this server can speak. Negotiation: echo the client's
/// requested version when supported, otherwise answer with our latest.
const SUPPORTED_PROTOCOL_VERSIONS: &[&str] = &["2025-06-18", "2025-03-26", "2024-11-05"];
const LATEST_PROTOCOL_VERSION: &str = "2025-06-18";

/// Hard cap on formatted transcript output, before the header/notice lines.
const TRANSCRIPT_CAP_BYTES: usize = 100_000;
const SEARCH_LIMIT_DEFAULT: u64 = 20;
const SEARCH_LIMIT_MAX: u64 = 50;

const HELP: &str = "perchnote-mcp: local, read-only MCP server for Perchnote (stdio transport)

USAGE: perchnote-mcp [--db <path>]

The database path resolves in order: --db flag, PERCHNOTE_DB env var, then
the production location (~/Library/Application Support/<bundle id>/perchnote.db).
Run it from an MCP client config, not by hand (stdin/stdout are the protocol).";

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|a| a == "--help" || a == "-h") {
        eprintln!("{HELP}");
        return;
    }
    let db_path = match resolve_db_path(&args) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("perchnote-mcp: {e}");
            std::process::exit(2);
        }
    };
    let db = match Database::open_read_only(&db_path) {
        Ok(db) => db,
        Err(e) => {
            eprintln!(
                "perchnote-mcp: cannot open {} read-only: {e:#}",
                db_path.display()
            );
            std::process::exit(2);
        }
    };
    eprintln!(
        "perchnote-mcp {SERVER_VERSION}: serving {} read-only over stdio",
        db_path.display()
    );
    // Recordings live beside the database; expose paths read-only so local
    // MCP clients (Claude Code etc.) can hand audio to their own tools.
    let recordings_dir = db_path
        .parent()
        .map(|p| p.join("recordings"))
        .unwrap_or_else(|| PathBuf::from("recordings"));
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    if let Err(e) = serve(&db, &recordings_dir, stdin.lock(), stdout.lock()) {
        eprintln!("perchnote-mcp: stdio error: {e}");
        std::process::exit(1);
    }
}

// --- configuration ---

/// `--db <path>` beats `PERCHNOTE_DB` beats the production app-data location.
fn resolve_db_path(args: &[String]) -> Result<PathBuf, String> {
    if let Some(i) = args.iter().position(|a| a == "--db") {
        return match args.get(i + 1).filter(|p| !p.is_empty()) {
            Some(p) => Ok(PathBuf::from(p)),
            None => Err("--db requires a path argument".to_string()),
        };
    }
    if let Some(p) = std::env::var_os("PERCHNOTE_DB") {
        if !p.is_empty() {
            return Ok(PathBuf::from(p));
        }
    }
    let home = std::env::var_os("HOME")
        .filter(|h| !h.is_empty())
        .ok_or("HOME is not set; pass --db <path> or set PERCHNOTE_DB")?;
    Ok(PathBuf::from(home)
        .join("Library/Application Support")
        .join(bundle_identifier())
        .join("perchnote.db"))
}

/// Bundle identifier parsed from the tauri.conf.json embedded at compile
/// time — the same file the app is built from, so the default path cannot
/// drift. Falls back to the known id if the config ever stops parsing.
fn bundle_identifier() -> String {
    serde_json::from_str::<Value>(include_str!("../../tauri.conf.json"))
        .ok()
        .and_then(|v| v.get("identifier")?.as_str().map(str::to_string))
        .unwrap_or_else(|| "com.perchnote.app".to_string())
}

// --- protocol layer (JSON-RPC 2.0, newline-delimited, MCP stdio transport) ---

/// Read newline-delimited JSON-RPC messages from `input`, write responses to
/// `output`. Notifications produce no output. Returns when stdin closes —
/// the MCP stdio shutdown signal.
fn serve(
    db: &Database,
    recordings_dir: &std::path::Path,
    input: impl BufRead,
    mut output: impl Write,
) -> std::io::Result<()> {
    for line in input.lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        if let Some(response) = handle_message(db, recordings_dir, &line) {
            let mut frame =
                serde_json::to_vec(&response).expect("JSON-RPC response always serializes");
            frame.push(b'\n');
            output.write_all(&frame)?;
            output.flush()?;
        }
    }
    Ok(())
}

/// One message in, at most one response out (`None` for notifications).
fn handle_message(db: &Database, recordings_dir: &std::path::Path, line: &str) -> Option<Value> {
    let msg: Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(_) => return Some(error_response(Value::Null, -32700, "Parse error")),
    };
    let Some(obj) = msg.as_object() else {
        return Some(error_response(
            Value::Null,
            -32600,
            "Invalid Request: expected a JSON object",
        ));
    };
    let id = obj.get("id").cloned();
    let method = obj.get("method").and_then(|m| m.as_str()).map(str::to_string);
    match (id, method) {
        // No id = notification; never answered, per JSON-RPC 2.0.
        (None, Some(method)) => {
            if !matches!(
                method.as_str(),
                "notifications/initialized" | "notifications/cancelled"
            ) {
                eprintln!("perchnote-mcp: ignoring notification {method}");
            }
            None
        }
        (Some(id), Some(method)) => {
            Some(handle_request(db, recordings_dir, id, &method, obj.get("params")))
        }
        (id, None) => Some(error_response(
            id.unwrap_or(Value::Null),
            -32600,
            "Invalid Request: missing method",
        )),
    }
}

fn handle_request(
    db: &Database,
    recordings_dir: &std::path::Path,
    id: Value,
    method: &str,
    params: Option<&Value>,
) -> Value {
    match method {
        "initialize" => result_response(id, initialize_result(params)),
        "ping" => result_response(id, json!({})),
        "tools/list" => result_response(id, json!({ "tools": tool_definitions() })),
        "tools/call" => match dispatch_tool_call(db, recordings_dir, params) {
            Ok(text) => result_response(
                id,
                json!({ "content": [{ "type": "text", "text": text }], "isError": false }),
            ),
            Err(CallError::UnknownTool(name)) => {
                error_response(id, -32602, &format!("Unknown tool: {name}"))
            }
            Err(CallError::BadParams(msg)) => error_response(id, -32602, &msg),
            // The tool ran and failed (unknown meeting, db hiccup): per MCP
            // semantics that is a *result* with isError, so the model can
            // read the message and try again.
            Err(CallError::Tool(msg)) => result_response(
                id,
                json!({ "content": [{ "type": "text", "text": msg }], "isError": true }),
            ),
        },
        other => error_response(id, -32601, &format!("Method not found: {other}")),
    }
}

fn initialize_result(params: Option<&Value>) -> Value {
    let requested = params
        .and_then(|p| p.get("protocolVersion"))
        .and_then(|v| v.as_str())
        .unwrap_or(LATEST_PROTOCOL_VERSION);
    let negotiated = if SUPPORTED_PROTOCOL_VERSIONS.contains(&requested) {
        requested
    } else {
        LATEST_PROTOCOL_VERSION
    };
    json!({
        "protocolVersion": negotiated,
        "capabilities": { "tools": { "listChanged": false } },
        "serverInfo": { "name": SERVER_NAME, "version": SERVER_VERSION },
        "instructions": "Read-only access to the local Perchnote meeting database. \
            search_meetings supports filters: speaker:NAME, folder:NAME, before:YYYY-MM-DD, \
            after:YYYY-MM-DD, \"quoted phrases\", and trailing-* prefix matching. Typical flow: \
            search_meetings, then get_meeting / get_transcript with a meeting_id from the results. \
            Nothing here can modify the database."
    })
}

fn result_response(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn error_response(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

// --- tools ---

fn tool_definitions() -> Value {
    let read_only = |title: &str| json!({ "title": title, "readOnlyHint": true, "openWorldHint": false });
    json!([
        {
            "name": "search_meetings",
            "description": "Full-text search across meeting titles, transcripts, and notes in the \
                local Perchnote database. Supports filters mixed into the query text: speaker:NAME, \
                folder:NAME, before:YYYY-MM-DD, after:YYYY-MM-DD, \"exact phrases\", and trailing-* \
                prefix matching (example: 'budget speaker:amy after:2026-01-01'). Filters refine \
                search words; a filters-only query matches nothing. Returns meeting_id, \
                match_source (title|transcript|notes), a snippet, and match_start_ms for \
                transcript hits.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Search words, optionally with filters" },
                    "limit": { "type": "integer", "minimum": 1, "maximum": SEARCH_LIMIT_MAX, "description": "Maximum results (default 20)" }
                },
                "required": ["query"]
            },
            "annotations": read_only("Search meetings")
        },
        {
            "name": "get_meeting",
            "description": "Fetch one meeting by id: title, date, status, duration, folders, tags, \
                the local recording path when audio exists, and the meeting's notes as markdown (my_notes = what the user typed, ai_notes = \
                the AI-enhanced version; headings, bullets, and checkbox state preserved).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "meeting_id": { "type": "string", "description": "Meeting id, e.g. from search_meetings" }
                },
                "required": ["meeting_id"]
            },
            "annotations": read_only("Get meeting")
        },
        {
            "name": "get_transcript",
            "description": "The meeting transcript as '[m:ss] Speaker: text' lines, using the \
                user's speaker names where assigned. Optionally slice by start_ms/end_ms \
                (milliseconds from recording start). Output is capped at ~100KB; for long \
                meetings request a time range.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "meeting_id": { "type": "string", "description": "Meeting id" },
                    "start_ms": { "type": "integer", "minimum": 0, "description": "Only segments starting at or after this time" },
                    "end_ms": { "type": "integer", "minimum": 0, "description": "Only segments starting at or before this time" }
                },
                "required": ["meeting_id"]
            },
            "annotations": read_only("Get transcript")
        },
        {
            "name": "list_open_action_items",
            "description": "All open (not done, not dropped) action items across active meetings, \
                newest meeting first, with task, assignee, deadline, and the source meeting.",
            "inputSchema": { "type": "object", "properties": {} },
            "annotations": read_only("List open action items")
        }
    ])
}

enum CallError {
    /// Tool name nobody advertised → JSON-RPC -32602.
    UnknownTool(String),
    /// Arguments that don't match the schema → JSON-RPC -32602.
    BadParams(String),
    /// The tool executed and failed → result with isError:true.
    Tool(String),
}

fn db_err(e: anyhow::Error) -> CallError {
    CallError::Tool(format!("database error: {e:#}"))
}

fn dispatch_tool_call(
    db: &Database,
    recordings_dir: &std::path::Path,
    params: Option<&Value>,
) -> Result<String, CallError> {
    let params =
        params.ok_or_else(|| CallError::BadParams("tools/call requires params".to_string()))?;
    let name = params
        .get("name")
        .and_then(|n| n.as_str())
        .ok_or_else(|| CallError::BadParams("tools/call params must include a tool name".to_string()))?;
    let empty = json!({});
    let args = params.get("arguments").unwrap_or(&empty);
    match name {
        "search_meetings" => tool_search_meetings(db, args),
        "get_meeting" => tool_get_meeting(db, recordings_dir, args),
        "get_transcript" => tool_get_transcript(db, args),
        "list_open_action_items" => tool_list_open_action_items(db),
        other => Err(CallError::UnknownTool(other.to_string())),
    }
}

fn required_str<'a>(args: &'a Value, key: &str) -> Result<&'a str, CallError> {
    args.get(key)
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| CallError::BadParams(format!("missing required string argument: {key}")))
}

/// Absent/null → None; integers (or whole floats, for lax clients) → Some.
fn optional_u64(args: &Value, key: &str) -> Result<Option<u64>, CallError> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(v) => v
            .as_u64()
            .or_else(|| {
                v.as_f64()
                    .filter(|f| f.fract() == 0.0 && *f >= 0.0 && *f <= u64::MAX as f64)
                    .map(|f| f as u64)
            })
            .map(Some)
            .ok_or_else(|| CallError::BadParams(format!("{key} must be a non-negative integer"))),
    }
}

/// `search_meetings` — straight pass-through to `Database::search_all`, so
/// the MCP surface speaks exactly the app's filter grammar.
fn tool_search_meetings(db: &Database, args: &Value) -> Result<String, CallError> {
    let query = required_str(args, "query")?;
    let limit = args
        .get("limit")
        .and_then(|v| v.as_u64())
        .unwrap_or(SEARCH_LIMIT_DEFAULT)
        .clamp(1, SEARCH_LIMIT_MAX) as usize;
    let results = db.search_all(query, limit).map_err(db_err)?;
    if results.is_empty() {
        return Ok("No matches. Tips: filters (speaker:NAME, folder:NAME, before:YYYY-MM-DD, \
                   after:YYYY-MM-DD) refine search words and match nothing on their own; try \
                   fewer or broader words, or a trailing-* prefix."
            .to_string());
    }
    serde_json::to_string_pretty(&results).map_err(|e| CallError::Tool(e.to_string()))
}

fn tool_get_meeting(
    db: &Database,
    recordings_dir: &std::path::Path,
    args: &Value,
) -> Result<String, CallError> {
    let id = required_str(args, "meeting_id")?;
    let meeting = visible_meeting(db, id)?;
    let folders: Vec<String> = db
        .get_meeting_folders(id)
        .map_err(db_err)?
        .into_iter()
        .map(|f| f.name)
        .collect();
    let tags: Vec<String> = db
        .get_meeting_tags(id)
        .map_err(db_err)?
        .into_iter()
        .map(|t| t.name)
        .collect();
    let note = db.get_note_by_meeting(id).map_err(db_err)?;
    // Markdown, not flattened text (plan v10 #11): headings, bullets, and
    // checkbox state survive the trip into the MCP client.
    let (my_notes, ai_notes) = note
        .map(|n| {
            (
                markdown_of_tiptap(n.raw_content.as_deref().unwrap_or("")),
                markdown_of_tiptap(n.generated_content.as_deref().unwrap_or("")),
            )
        })
        .unwrap_or_default();

    // Local absolute path, exists-checked — null when audio was never
    // recorded or was purged by retention. Clients are local processes the
    // user configured; nothing here opens or streams the file (v10 #11).
    let wav = recordings_dir.join(format!("{}.wav", meeting.id));
    let recording_path = if wav.exists() {
        Value::String(wav.to_string_lossy().to_string())
    } else {
        Value::Null
    };

    // Built field-by-field on purpose: serializing the Meeting struct would
    // drag the ICS `attendees` column along. Calendar PII stays out of every
    // MCP surface (docs/SECURITY.md).
    let out = json!({
        "meeting_id": meeting.id,
        "title": meeting.title,
        "date": meeting_date(&meeting),
        "status": meeting.status,
        "duration_minutes": duration_minutes(&meeting),
        "platform": meeting.platform,
        "is_archived": meeting.is_archived,
        "folders": folders,
        "tags": tags,
        "my_notes": non_empty(my_notes),
        "ai_notes": non_empty(ai_notes),
        "recording_path": recording_path,
    });
    serde_json::to_string_pretty(&out).map_err(|e| CallError::Tool(e.to_string()))
}

fn tool_get_transcript(db: &Database, args: &Value) -> Result<String, CallError> {
    let id = required_str(args, "meeting_id")?;
    let start_ms = optional_u64(args, "start_ms")?;
    let end_ms = optional_u64(args, "end_ms")?;
    let meeting = visible_meeting(db, id)?;
    let transcript = db
        .get_transcript_by_meeting(id)
        .map_err(db_err)?
        .ok_or_else(|| CallError::Tool(format!("Meeting \"{}\" has no transcript.", meeting.title)))?;
    let segments = db
        .segments_in_range(&transcript.id, 0, i64::MAX)
        .map_err(db_err)?;
    let labels: HashMap<String, String> = db
        .list_speaker_labels_for_meeting(id)
        .map_err(db_err)?
        .into_iter()
        .map(|l| (l.speaker_key, l.display_name))
        .collect();

    let total = segments.len();
    let mut body = String::new();
    let mut shown = 0usize;
    let mut truncated = false;
    for seg in &segments {
        let in_range = match (seg.start_ms, start_ms, end_ms) {
            // Untimed segments are only safe to include when no range was asked for.
            (None, None, None) => true,
            (None, _, _) => false,
            (Some(s), lo, hi) => {
                let s = s.max(0) as u64;
                lo.is_none_or(|lo| s >= lo) && hi.is_none_or(|hi| s <= hi)
            }
        };
        if !in_range {
            continue;
        }
        let line = format_segment_line(seg, &labels);
        if body.len() + line.len() + 1 > TRANSCRIPT_CAP_BYTES {
            truncated = true;
            break;
        }
        body.push_str(&line);
        body.push('\n');
        shown += 1;
    }

    if body.is_empty() && !truncated {
        return Ok(if total == 0 {
            format!("Meeting \"{}\" has a transcript with no segments.", meeting.title)
        } else {
            format!(
                "No transcript segments of \"{}\" start in the requested time range ({} segments total).",
                meeting.title, total
            )
        });
    }

    let date: String = meeting_date(&meeting).chars().take(10).collect();
    let mut out = format!("Transcript: {} ({date})\n\n{body}", meeting.title);
    if truncated {
        out.push_str(&format!(
            "\n[truncated: {shown} of {total} segments shown (~100KB cap). \
             Call get_transcript with start_ms/end_ms to read a specific range.]\n"
        ));
    }
    Ok(out)
}

fn tool_list_open_action_items(db: &Database) -> Result<String, CallError> {
    let items = db.list_action_items().map_err(db_err)?;
    let open: Vec<Value> = items
        .into_iter()
        .filter(|i| !i.done && !i.dropped)
        .map(|i| {
            let mut o = serde_json::Map::new();
            o.insert("task".into(), i.task.into());
            if let Some(a) = i.assignee {
                o.insert("assignee".into(), a.into());
            }
            if let Some(d) = i.deadline {
                o.insert("deadline".into(), d.into());
            }
            if let Some(s) = i.snoozed_until {
                o.insert("snoozed_until".into(), s.into());
            }
            o.insert("meeting".into(), i.meeting_title.into());
            o.insert("meeting_id".into(), i.meeting_id.into());
            if let Some(d) = i.meeting_date {
                o.insert("date".into(), d.chars().take(10).collect::<String>().into());
            }
            Value::Object(o)
        })
        .collect();
    if open.is_empty() {
        return Ok("No open action items.".to_string());
    }
    serde_json::to_string_pretty(&Value::Array(open)).map_err(|e| CallError::Tool(e.to_string()))
}

// --- formatting helpers ---

/// A meeting the MCP surface admits exists: present and not soft-deleted
/// (trash stays private until it's either restored or purged).
fn visible_meeting(db: &Database, id: &str) -> Result<Meeting, CallError> {
    db.get_meeting(id)
        .map_err(db_err)?
        .filter(|m| m.deleted_at.is_none())
        .ok_or_else(|| CallError::Tool(format!("No meeting with id {id}.")))
}

/// The date the rest of the app sorts by: actual start, else scheduled, else created.
fn meeting_date(m: &Meeting) -> String {
    m.actual_start
        .clone()
        .or_else(|| m.scheduled_start.clone())
        .unwrap_or_else(|| m.created_at.clone())
}

/// Whole minutes between the actual start/end pair, falling back to the
/// scheduled pair; None when either end is missing or unparseable.
fn duration_minutes(m: &Meeting) -> Option<i64> {
    let span = |a: &Option<String>, b: &Option<String>| -> Option<i64> {
        let start = chrono::DateTime::parse_from_rfc3339(a.as_deref()?).ok()?;
        let end = chrono::DateTime::parse_from_rfc3339(b.as_deref()?).ok()?;
        let mins = (end - start).num_minutes();
        (mins >= 0).then_some(mins)
    };
    span(&m.actual_start, &m.actual_end).or_else(|| span(&m.scheduled_start, &m.scheduled_end))
}

fn non_empty(s: String) -> Option<String> {
    (!s.is_empty()).then_some(s)
}

/// "[m:ss] Name: text" — the user's diarization label when assigned,
/// otherwise the raw key ("Speaker 1"); bare text when diarization never ran.
fn format_segment_line(seg: &SegmentHit, labels: &HashMap<String, String>) -> String {
    let stamp = seg
        .start_ms
        .map(fmt_mss)
        .unwrap_or_else(|| "--:--".to_string());
    match seg
        .speaker_key
        .as_ref()
        .map(|k| labels.get(k).unwrap_or(k))
    {
        Some(name) => format!("[{stamp}] {name}: {}", seg.text.trim()),
        None => format!("[{stamp}] {}", seg.text.trim()),
    }
}

/// 95000 → "1:35". Total minutes, no hour split — unambiguous to sort and grep.
fn fmt_mss(ms: i64) -> String {
    let secs = ms.max(0) / 1000;
    format!("{}:{:02}", secs / 60, secs % 60)
}

// --- tests ---

#[cfg(test)]
mod tests {
    use super::*;

    const SENTINEL: &str = "SENTINEL_ATTENDEE@example.com";

    /// A fully-populated fixture database: two meetings with transcripts,
    /// speaker labels on the first, notes with action items (open, done,
    /// and dropped), a folder, a tag — and ICS attendees set to sentinel
    /// values that must never appear in any tool output. Seeded read-write
    /// via the app's own constructor, then reopened read-only exactly the
    /// way the binary does it.
    fn seeded_db() -> (tempfile::TempDir, Database) {
        let dir = tempfile::tempdir().unwrap();
        let (m1_id, m2_id) = {
            let rw = Database::new(dir.path().to_path_buf()).unwrap();

            // Meeting 1: the rich one.
            let m1 = rw.create_meeting("Q2 Budget Review").unwrap();
            {
                let conn = rw.conn.lock().unwrap();
                conn.execute(
                    "UPDATE meetings SET attendees = ?1, actual_start = ?2, actual_end = ?3,
                            status = 'completed' WHERE id = ?4",
                    rusqlite::params![
                        format!(r#"["{SENTINEL}","Secret Person"]"#),
                        "2026-03-10T10:00:00+00:00",
                        "2026-03-10T10:45:00+00:00",
                        m1.id
                    ],
                )
                .unwrap();
            }
            let t1 = rw.create_transcript(&m1.id, "live").unwrap();
            rw.update_transcript_segments(
                &t1.id,
                &json!([
                    { "speaker": "Speaker 1", "start_ms": 5000, "end_ms": 9000,
                      "text": "The budget is on track for April." },
                    { "speaker": "Speaker 2", "start_ms": 95000, "end_ms": 99000,
                      "text": "Marketing spend needs review." }
                ])
                .to_string(),
            )
            .unwrap();
            rw.upsert_speaker_label(&m1.id, "Speaker 1", "Amy", None, None)
                .unwrap();

            let note = rw.get_or_create_note(&m1.id).unwrap();
            rw.update_note_raw_content(
                &note.id,
                &json!({ "type": "doc", "content": [
                    { "type": "paragraph", "content": [
                        { "type": "text", "text": "Remember the hiring plan." } ] },
                    { "type": "actionItem", "attrs": {
                        "task": "Send budget summary", "assignee": "Sam",
                        "deadline": "2026-03-15", "done": false } },
                    { "type": "actionItem", "attrs": { "task": "Book conference room", "done": true } },
                    { "type": "actionItem", "attrs": { "task": "Dropped chore", "done": false } }
                ]})
                .to_string(),
            )
            .unwrap();
            rw.update_note_generated_content(
                &note.id,
                &json!({ "type": "doc", "content": [
                    { "type": "heading", "attrs": { "level": 2 }, "content": [
                        { "type": "text", "text": "Summary" } ] },
                    { "type": "paragraph", "content": [
                        { "type": "text", "text": "Budget approved for Q2; marketing review pending." } ] },
                    { "type": "actionItem", "attrs": { "task": "Follow up with finance", "done": false } }
                ]})
                .to_string(),
            )
            .unwrap();
            // raw index 2 = "Dropped chore" — consciously dropped in triage.
            rw.set_task_dropped(&note.id, "raw", 2, true, Some("Dropped chore"))
                .unwrap();

            let folder = rw.create_folder("Finance", "#10b981", "folder", None).unwrap();
            rw.add_meeting_to_folder(&m1.id, &folder.id).unwrap();
            let tag = rw.create_tag("budget", "manual").unwrap();
            rw.add_tag_to_meeting(&m1.id, &tag.id).unwrap();

            // Meeting 2: older, unlabeled speakers, for filter discrimination.
            let m2 = rw.create_meeting("Engineering Sync").unwrap();
            {
                let conn = rw.conn.lock().unwrap();
                conn.execute(
                    "UPDATE meetings SET attendees = ?1, actual_start = ?2, status = 'completed'
                     WHERE id = ?3",
                    rusqlite::params![
                        format!(r#"["{SENTINEL}"]"#),
                        "2026-01-05T09:00:00+00:00",
                        m2.id
                    ],
                )
                .unwrap();
            }
            let t2 = rw.create_transcript(&m2.id, "live").unwrap();
            rw.update_transcript_segments(
                &t2.id,
                &json!([
                    { "speaker": "Speaker 1", "start_ms": 1000, "end_ms": 4000,
                      "text": "Server budget needs more headroom." }
                ])
                .to_string(),
            )
            .unwrap();

            (m1.id.clone(), m2.id.clone())
        };
        let db = Database::open_read_only(&dir.path().join("perchnote.db")).unwrap();
        // Stash ids where tests can find them without re-querying.
        MEETING_IDS.with(|c| *c.borrow_mut() = Some((m1_id, m2_id)));
        (dir, db)
    }

    thread_local! {
        static MEETING_IDS: std::cell::RefCell<Option<(String, String)>> =
            const { std::cell::RefCell::new(None) };
    }

    fn m1_id() -> String {
        MEETING_IDS.with(|c| c.borrow().as_ref().unwrap().0.clone())
    }

    fn m2_id() -> String {
        MEETING_IDS.with(|c| c.borrow().as_ref().unwrap().1.clone())
    }

    /// Feed newline-delimited requests through `serve` and parse every
    /// response line — the same loop the binary runs on stdio.
    thread_local! {
        /// Per-test recordings dir for the recording_path field; default
        /// points nowhere so the field is null unless a test sets it.
        static RECORDINGS_DIR: std::cell::RefCell<PathBuf> =
            std::cell::RefCell::new(PathBuf::from("/nonexistent-recordings"));
    }

    fn run_raw_session(db: &Database, raw: &str) -> Vec<Value> {
        let mut output = Vec::new();
        let rec = RECORDINGS_DIR.with(|c| c.borrow().clone());
        serve(db, &rec, std::io::Cursor::new(raw.as_bytes().to_vec()), &mut output).unwrap();
        String::from_utf8(output)
            .unwrap()
            .lines()
            .map(|l| serde_json::from_str(l).expect("every output line is JSON"))
            .collect()
    }

    fn run_session(db: &Database, requests: &[Value]) -> Vec<Value> {
        let raw = requests
            .iter()
            .map(|r| r.to_string())
            .collect::<Vec<_>>()
            .join("\n")
            + "\n";
        run_raw_session(db, &raw)
    }

    /// tools/call through the full protocol layer; returns (response, text).
    fn call_tool(db: &Database, name: &str, args: Value) -> (Value, String) {
        let responses = run_session(
            db,
            &[json!({ "jsonrpc": "2.0", "id": 7, "method": "tools/call",
                      "params": { "name": name, "arguments": args } })],
        );
        assert_eq!(responses.len(), 1);
        let resp = responses[0].clone();
        let text = resp["result"]["content"][0]["text"]
            .as_str()
            .unwrap_or_default()
            .to_string();
        (resp, text)
    }

    fn assert_ok_tool(resp: &Value) {
        assert!(resp.get("error").is_none(), "unexpected error: {resp}");
        assert_eq!(resp["result"]["isError"], json!(false), "tool errored: {resp}");
    }

    // --- protocol ---

    #[test]
    fn initialize_negotiates_and_lists_tools() {
        let (_dir, db) = seeded_db();
        let responses = run_session(
            &db,
            &[
                json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
                    "protocolVersion": "2025-03-26",
                    "capabilities": {},
                    "clientInfo": { "name": "test-client", "version": "0.0.0" } } }),
                json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }),
                json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }),
                json!({ "jsonrpc": "2.0", "id": 3, "method": "ping" }),
            ],
        );
        // The notification produced no output: 3 responses for 4 messages.
        assert_eq!(responses.len(), 3);

        let init = &responses[0];
        assert_eq!(init["id"], json!(1));
        assert_eq!(init["result"]["protocolVersion"], json!("2025-03-26"), "echo supported version");
        assert_eq!(init["result"]["serverInfo"]["name"], json!(SERVER_NAME));
        assert!(init["result"]["capabilities"]["tools"].is_object());

        let tools = responses[1]["result"]["tools"].as_array().unwrap();
        let names: Vec<&str> = tools.iter().map(|t| t["name"].as_str().unwrap()).collect();
        assert_eq!(
            names,
            ["search_meetings", "get_meeting", "get_transcript", "list_open_action_items"]
        );
        for t in tools {
            assert_eq!(t["inputSchema"]["type"], json!("object"), "tool {t} schema");
            assert_eq!(t["annotations"]["readOnlyHint"], json!(true), "tool {t} must advertise read-only");
        }

        assert_eq!(responses[2]["result"], json!({}), "ping pongs");
    }

    #[test]
    fn initialize_with_unknown_version_answers_latest() {
        let (_dir, db) = seeded_db();
        let responses = run_session(
            &db,
            &[json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize",
                      "params": { "protocolVersion": "2099-01-01" } })],
        );
        assert_eq!(
            responses[0]["result"]["protocolVersion"],
            json!(LATEST_PROTOCOL_VERSION)
        );
    }

    #[test]
    fn malformed_and_unknown_messages_get_well_formed_errors() {
        let (_dir, db) = seeded_db();

        // Parse error → -32700, id null.
        let responses = run_raw_session(&db, "this is not json\n");
        assert_eq!(responses[0]["error"]["code"], json!(-32700));
        assert_eq!(responses[0]["id"], Value::Null);

        // Non-object → -32600.
        let responses = run_raw_session(&db, "[1,2,3]\n");
        assert_eq!(responses[0]["error"]["code"], json!(-32600));

        // Request without method → -32600, id echoed.
        let responses = run_session(&db, &[json!({ "jsonrpc": "2.0", "id": 9 })]);
        assert_eq!(responses[0]["error"]["code"], json!(-32600));
        assert_eq!(responses[0]["id"], json!(9));

        // Unknown method → -32601.
        let responses = run_session(
            &db,
            &[json!({ "jsonrpc": "2.0", "id": "abc", "method": "resources/list" })],
        );
        assert_eq!(responses[0]["error"]["code"], json!(-32601));
        assert_eq!(responses[0]["id"], json!("abc"), "string ids echo back unchanged");

        // Unknown notification → silence, never a response.
        let responses = run_session(
            &db,
            &[json!({ "jsonrpc": "2.0", "method": "notifications/whatever" })],
        );
        assert!(responses.is_empty());

        // Unknown tool → -32602.
        let responses = run_session(
            &db,
            &[json!({ "jsonrpc": "2.0", "id": 4, "method": "tools/call",
                      "params": { "name": "delete_everything", "arguments": {} } })],
        );
        assert_eq!(responses[0]["error"]["code"], json!(-32602));

        // Missing required argument → -32602.
        let responses = run_session(
            &db,
            &[json!({ "jsonrpc": "2.0", "id": 5, "method": "tools/call",
                      "params": { "name": "get_meeting", "arguments": {} } })],
        );
        assert_eq!(responses[0]["error"]["code"], json!(-32602));
    }

    // --- search_meetings ---

    #[test]
    fn search_passes_the_filter_grammar_through() {
        let (_dir, db) = seeded_db();

        // Plain word: hits m1 (title + transcript + notes) and m2 (transcript).
        let (resp, text) = call_tool(&db, "search_meetings", json!({ "query": "budget" }));
        assert_ok_tool(&resp);
        let hits: Vec<Value> = serde_json::from_str(&text).unwrap();
        let of = |mid: &str| -> Vec<&str> {
            hits.iter()
                .filter(|h| h["meeting_id"] == json!(mid))
                .map(|h| h["match_source"].as_str().unwrap())
                .collect()
        };
        assert!(of(&m1_id()).contains(&"title"));
        assert!(of(&m1_id()).contains(&"transcript"));
        assert!(of(&m1_id()).contains(&"notes"));
        assert!(of(&m2_id()).contains(&"transcript"));
        let transcript_hit = hits
            .iter()
            .find(|h| h["meeting_id"] == json!(m1_id()) && h["match_source"] == json!("transcript"))
            .unwrap();
        assert_eq!(transcript_hit["match_start_ms"], json!(5000));
        assert!(transcript_hit["snippet"].as_str().unwrap().contains("on track"));

        // speaker: filter — display-name join keeps only Amy's meeting.
        let (resp, text) =
            call_tool(&db, "search_meetings", json!({ "query": "budget speaker:amy" }));
        assert_ok_tool(&resp);
        let hits: Vec<Value> = serde_json::from_str(&text).unwrap();
        assert!(!hits.is_empty());
        assert!(hits.iter().all(|h| h["meeting_id"] == json!(m1_id())
            && h["match_source"] == json!("transcript")));

        // folder: filter.
        let (resp, text) =
            call_tool(&db, "search_meetings", json!({ "query": "budget folder:finance" }));
        assert_ok_tool(&resp);
        let hits: Vec<Value> = serde_json::from_str(&text).unwrap();
        assert!(!hits.is_empty());
        assert!(hits.iter().all(|h| h["meeting_id"] == json!(m1_id())));

        // before: date filter keeps only the January meeting.
        let (resp, text) =
            call_tool(&db, "search_meetings", json!({ "query": "budget before:2026-02-01" }));
        assert_ok_tool(&resp);
        let hits: Vec<Value> = serde_json::from_str(&text).unwrap();
        assert!(!hits.is_empty());
        assert!(hits.iter().all(|h| h["meeting_id"] == json!(m2_id())));

        // Filters-only query matches nothing, and says so in prose.
        let (resp, text) = call_tool(&db, "search_meetings", json!({ "query": "speaker:amy" }));
        assert_ok_tool(&resp);
        assert!(text.starts_with("No matches"));
    }

    #[test]
    fn search_limit_is_clamped() {
        let (_dir, db) = seeded_db();
        let (resp, text) =
            call_tool(&db, "search_meetings", json!({ "query": "budget", "limit": 9999 }));
        assert_ok_tool(&resp);
        let hits: Vec<Value> = serde_json::from_str(&text).unwrap();
        assert!(hits.len() <= SEARCH_LIMIT_MAX as usize);
    }

    // --- get_meeting ---

    #[test]
    fn get_meeting_shape_and_note_text() {
        let (_dir, db) = seeded_db();
        let (resp, text) = call_tool(&db, "get_meeting", json!({ "meeting_id": m1_id() }));
        assert_ok_tool(&resp);
        let v: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(v["title"], json!("Q2 Budget Review"));
        assert!(v["date"].as_str().unwrap().starts_with("2026-03-10"));
        assert_eq!(v["status"], json!("completed"));
        assert_eq!(v["duration_minutes"], json!(45));
        assert_eq!(v["folders"], json!(["Finance"]));
        assert_eq!(v["tags"], json!(["budget"]));
        let my_notes = v["my_notes"].as_str().unwrap();
        assert!(my_notes.contains("Remember the hiring plan."));
        assert!(!my_notes.contains('{'), "notes must be plain text, not TipTap JSON");
        assert!(v["ai_notes"].as_str().unwrap().contains("Budget approved for Q2"));
        // No recordings dir configured in this test → null, not absent.
        assert!(v["recording_path"].is_null());
    }

    #[test]
    fn get_meeting_exposes_local_recording_path_when_audio_exists() {
        let (_dir, db) = seeded_db();
        let rec_dir = tempfile::tempdir().unwrap();
        std::fs::write(rec_dir.path().join(format!("{}.wav", m1_id())), b"RIFF").unwrap();
        RECORDINGS_DIR.with(|c| *c.borrow_mut() = rec_dir.path().to_path_buf());

        let (resp, text) = call_tool(&db, "get_meeting", json!({ "meeting_id": m1_id() }));
        assert_ok_tool(&resp);
        let v: Value = serde_json::from_str(&text).unwrap();
        let path = v["recording_path"].as_str().expect("path for existing audio");
        assert!(path.ends_with(&format!("{}.wav", m1_id())));

        // m2 has no audio file → null.
        let (_, text) = call_tool(&db, "get_meeting", json!({ "meeting_id": m2_id() }));
        let v: Value = serde_json::from_str(&text).unwrap();
        assert!(v["recording_path"].is_null());
        RECORDINGS_DIR.with(|c| *c.borrow_mut() = PathBuf::from("/nonexistent-recordings"));
    }

    #[test]
    fn get_meeting_unknown_and_deleted_are_tool_errors() {
        let (dir, db) = seeded_db();
        let (resp, text) = call_tool(&db, "get_meeting", json!({ "meeting_id": "no-such-id" }));
        assert_eq!(resp["result"]["isError"], json!(true));
        assert!(text.contains("No meeting"));

        // Soft-delete m2 through a parallel rw connection; the ro surface
        // must stop admitting it exists.
        {
            let rw = Database::new(dir.path().to_path_buf()).unwrap();
            rw.soft_delete_meeting(&m2_id()).unwrap();
        }
        let (resp, _) = call_tool(&db, "get_meeting", json!({ "meeting_id": m2_id() }));
        assert_eq!(resp["result"]["isError"], json!(true));
        let (resp, _) = call_tool(&db, "get_transcript", json!({ "meeting_id": m2_id() }));
        assert_eq!(resp["result"]["isError"], json!(true));
    }

    // --- get_transcript ---

    #[test]
    fn transcript_formats_labels_timestamps_and_ranges() {
        let (_dir, db) = seeded_db();

        let (resp, text) = call_tool(&db, "get_transcript", json!({ "meeting_id": m1_id() }));
        assert_ok_tool(&resp);
        assert!(text.contains("[0:05] Amy: The budget is on track for April."),
            "label join failed:\n{text}");
        assert!(text.contains("[1:35] Speaker 2: Marketing spend needs review."),
            "unlabeled key must fall back to the raw key:\n{text}");

        // Range slice: only the second segment starts at/after 90s.
        let (resp, text) = call_tool(
            &db,
            "get_transcript",
            json!({ "meeting_id": m1_id(), "start_ms": 90000 }),
        );
        assert_ok_tool(&resp);
        assert!(!text.contains("[0:05]"));
        assert!(text.contains("[1:35]"));

        // ...and only the first starts at/before 10s.
        let (resp, text) = call_tool(
            &db,
            "get_transcript",
            json!({ "meeting_id": m1_id(), "end_ms": 10000 }),
        );
        assert_ok_tool(&resp);
        assert!(text.contains("[0:05]"));
        assert!(!text.contains("[1:35]"));

        // An empty range is a readable message, not an error.
        let (resp, text) = call_tool(
            &db,
            "get_transcript",
            json!({ "meeting_id": m1_id(), "start_ms": 500000 }),
        );
        assert_ok_tool(&resp);
        assert!(text.contains("No transcript segments"));

        // Bad argument type is a protocol error.
        let responses = run_session(
            &db,
            &[json!({ "jsonrpc": "2.0", "id": 6, "method": "tools/call",
                      "params": { "name": "get_transcript",
                                  "arguments": { "meeting_id": m1_id(), "start_ms": "early" } } })],
        );
        assert_eq!(responses[0]["error"]["code"], json!(-32602));
    }

    #[test]
    fn transcript_output_is_capped_with_notice() {
        let dir = tempfile::tempdir().unwrap();
        let mid = {
            let rw = Database::new(dir.path().to_path_buf()).unwrap();
            let m = rw.create_meeting("Marathon").unwrap();
            let t = rw.create_transcript(&m.id, "live").unwrap();
            let segments: Vec<Value> = (0..2000)
                .map(|i| {
                    json!({ "speaker": "Speaker 1", "start_ms": i * 1000,
                            "text": format!("Segment {i}: {}", "lorem ipsum dolor sit amet ".repeat(4)) })
                })
                .collect();
            rw.update_transcript_segments(&t.id, &Value::Array(segments).to_string())
                .unwrap();
            m.id
        };
        let db = Database::open_read_only(&dir.path().join("perchnote.db")).unwrap();
        let (resp, text) = call_tool(&db, "get_transcript", json!({ "meeting_id": mid }));
        assert_ok_tool(&resp);
        assert!(
            text.len() <= TRANSCRIPT_CAP_BYTES + 512,
            "cap blown: {} bytes",
            text.len()
        );
        assert!(text.contains("truncated"), "must carry a truncation notice");
        assert!(text.contains("of 2000 segments"));
        // The slice escape hatch still reaches the tail beyond the cap.
        let (resp, tail) = call_tool(
            &db,
            "get_transcript",
            json!({ "meeting_id": mid, "start_ms": 1_999_000 }),
        );
        assert_ok_tool(&resp);
        assert!(tail.contains("Segment 1999"));
        assert!(!tail.contains("truncated"));
    }

    // --- list_open_action_items ---

    #[test]
    fn action_items_are_open_only_and_compact() {
        let (_dir, db) = seeded_db();
        let (resp, text) = call_tool(&db, "list_open_action_items", json!({}));
        assert_ok_tool(&resp);
        let items: Vec<Value> = serde_json::from_str(&text).unwrap();

        let send = items
            .iter()
            .find(|i| i["task"] == json!("Send budget summary"))
            .expect("open raw item present");
        assert_eq!(send["assignee"], json!("Sam"));
        assert_eq!(send["deadline"], json!("2026-03-15"));
        assert_eq!(send["meeting"], json!("Q2 Budget Review"));
        assert_eq!(send["meeting_id"], json!(m1_id()));
        assert_eq!(send["date"], json!("2026-03-10"));

        assert!(
            items.iter().any(|i| i["task"] == json!("Follow up with finance")),
            "generated-body items roll up too"
        );
        assert!(
            !items.iter().any(|i| i["task"] == json!("Book conference room")),
            "done items must not appear"
        );
        assert!(
            !items.iter().any(|i| i["task"] == json!("Dropped chore")),
            "dropped items must not appear"
        );
    }

    // --- the line that must never be crossed ---

    #[test]
    fn attendees_never_appear_in_any_tool_output() {
        let (_dir, db) = seeded_db();
        let calls = [
            ("search_meetings", json!({ "query": "budget" })),
            ("search_meetings", json!({ "query": "Secret" })),
            ("search_meetings", json!({ "query": "SENTINEL" })),
            ("get_meeting", json!({ "meeting_id": m1_id() })),
            ("get_meeting", json!({ "meeting_id": m2_id() })),
            ("get_transcript", json!({ "meeting_id": m1_id() })),
            ("list_open_action_items", json!({})),
        ];
        for (name, args) in calls {
            let (resp, _) = call_tool(&db, name, args.clone());
            // Assert on the full serialized JSON-RPC frame, not just the
            // text field — nothing in any envelope may leak calendar PII.
            let frame = resp.to_string();
            assert!(
                !frame.contains("SENTINEL_ATTENDEE"),
                "{name} {args} leaked an attendee email: {frame}"
            );
            assert!(
                !frame.contains("Secret Person"),
                "{name} {args} leaked an attendee name: {frame}"
            );
            assert!(
                !frame.to_lowercase().contains("attendee"),
                "{name} {args} mentions attendees: {frame}"
            );
        }
        // And the tool catalog itself stays clean.
        assert!(!tool_definitions().to_string().to_lowercase().contains("attendee"));
    }

    // --- db path resolution ---

    #[test]
    #[serial_test::serial(perchnote_db_env)]
    fn db_flag_beats_env_beats_default() {
        std::env::remove_var("PERCHNOTE_DB");

        // Flag wins over env.
        std::env::set_var("PERCHNOTE_DB", "/tmp/env.db");
        let p = resolve_db_path(&["--db".into(), "/tmp/flag.db".into()]).unwrap();
        assert_eq!(p, PathBuf::from("/tmp/flag.db"));

        // Env wins over default.
        let p = resolve_db_path(&[]).unwrap();
        assert_eq!(p, PathBuf::from("/tmp/env.db"));

        // Default lands on the bundle-id app-data path.
        std::env::remove_var("PERCHNOTE_DB");
        let p = resolve_db_path(&[]).unwrap();
        let s = p.to_string_lossy();
        assert!(
            s.ends_with("Library/Application Support/com.perchnote.app/perchnote.db"),
            "unexpected default: {s}"
        );

        // Dangling --db is an error, not a silent fallback.
        assert!(resolve_db_path(&["--db".into()]).is_err());
    }

    #[test]
    fn bundle_identifier_comes_from_tauri_conf() {
        assert_eq!(bundle_identifier(), "com.perchnote.app");
    }

    /// Not a test: writes a seeded fixture db into PERCHNOTE_SMOKE_DIR for
    /// the release-binary smoke run (`cargo test ... create_smoke_db -- --ignored`).
    #[test]
    #[ignore]
    fn create_smoke_db() {
        let dir = PathBuf::from(
            std::env::var("PERCHNOTE_SMOKE_DIR").expect("set PERCHNOTE_SMOKE_DIR"),
        );
        std::fs::create_dir_all(&dir).unwrap();
        let rw = Database::new(dir.clone()).unwrap();
        let m = rw.create_meeting("Q2 Budget Review").unwrap();
        {
            let conn = rw.conn.lock().unwrap();
            conn.execute(
                "UPDATE meetings SET attendees = ?1, actual_start = ?2, actual_end = ?3,
                        status = 'completed' WHERE id = ?4",
                rusqlite::params![
                    format!(r#"["{SENTINEL}"]"#),
                    "2026-03-10T10:00:00+00:00",
                    "2026-03-10T10:45:00+00:00",
                    m.id
                ],
            )
            .unwrap();
        }
        let t = rw.create_transcript(&m.id, "live").unwrap();
        rw.update_transcript_segments(
            &t.id,
            &json!([
                { "speaker": "Speaker 1", "start_ms": 5000,
                  "text": "The budget is on track for April." },
                { "speaker": "Speaker 2", "start_ms": 95000,
                  "text": "Marketing spend needs review." }
            ])
            .to_string(),
        )
        .unwrap();
        rw.upsert_speaker_label(&m.id, "Speaker 1", "Amy", None, None).unwrap();
        let note = rw.get_or_create_note(&m.id).unwrap();
        rw.update_note_raw_content(
            &note.id,
            &json!({ "type": "doc", "content": [
                { "type": "actionItem", "attrs": {
                    "task": "Send budget summary", "assignee": "Sam",
                    "deadline": "2026-03-15", "done": false } }
            ]})
            .to_string(),
        )
        .unwrap();
        eprintln!("smoke db ready: {}/perchnote.db (meeting {})", dir.display(), m.id);
    }
}
