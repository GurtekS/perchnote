use chrono::Utc;
use serde::{Deserialize, Serialize};
use rusqlite::{params, OptionalExtension};
use anyhow::Result;
use uuid::Uuid;

use super::Database;

// --- Types ---

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Meeting {
    pub id: String,
    pub title: String,
    pub scheduled_start: Option<String>,
    pub scheduled_end: Option<String>,
    pub actual_start: Option<String>,
    pub actual_end: Option<String>,
    pub calendar_event_id: Option<String>,
    pub attendees: String,
    pub location: Option<String>,
    pub meeting_url: Option<String>,
    pub platform: String,
    pub status: String,
    pub is_pinned: bool,
    pub is_archived: bool,
    pub deleted_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub device_name: Option<String>,
    pub system_audio_captured: bool,
    #[serde(default = "default_note_status")]
    pub note_status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpeakerLabel {
    pub id: String,
    /// Meeting this label applies to. None for legacy rows from before
    /// migration 11, which are kept around for export but ignored by
    /// per-meeting lookups.
    pub meeting_id: Option<String>,
    pub speaker_key: String,
    pub display_name: String,
    pub color: Option<String>,
    /// Participant type — "in-room", "remote", or "phone"
    #[serde(default = "default_participant_type")]
    pub participant_type: String,
    pub created_at: String,
}

fn default_participant_type() -> String {
    "in-room".to_string()
}

fn default_note_status() -> String {
    "none".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MeetingLink {
    pub source_meeting_id: String,
    pub target_meeting_id: String,
    pub link_type: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StorageStats {
    pub total_meetings: usize,
    pub total_transcripts: usize,
    pub total_notes: usize,
    pub total_chat_messages: usize,
    pub db_size_bytes: u64,
}

/// File attachment associated with a meeting.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Attachment {
    pub id: String,
    pub meeting_id: String,
    pub file_name: String,
    pub file_path: String,
    pub file_type: String,
    pub file_size: i64,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Note {
    pub id: String,
    pub meeting_id: String,
    pub raw_content: Option<String>,
    pub generated_content: Option<String>,
    pub template_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    /// Enhance receipt (plan v10 #2): which provider wrote generated_content.
    /// All NULL for notes from before migration 18 and for never-enhanced
    /// notes — the UI renders nothing for those (absent, not empty).
    #[serde(default)]
    pub generated_provider: Option<String>,
    #[serde(default)]
    pub generated_model: Option<String>,
    #[serde(default)]
    pub generated_at: Option<String>,
    /// sha256 of the segments JSON the generation read — the same
    /// `segments_snapshot` hash the accuracy pass uses, so the UI can flag
    /// "transcript changed after these notes" when the live hash drifts.
    #[serde(default)]
    pub generated_transcript_sha: Option<String>,
    /// One-slot history: JSON envelope {content, provider, model,
    /// generated_at, transcript_sha} of the version a re-enhance replaced.
    #[serde(default)]
    pub generated_previous: Option<String>,
}

/// SELECT column list matching `map_note_row` — every Note read goes through
/// this pair so the receipt fields can't silently drop out of one query.
const NOTE_COLUMNS: &str = "id, meeting_id, raw_content, generated_content, template_id, \
     created_at, updated_at, generated_provider, generated_model, generated_at, \
     generated_transcript_sha, generated_previous";

fn map_note_row(row: &rusqlite::Row) -> rusqlite::Result<Note> {
    Ok(Note {
        id: row.get(0)?,
        meeting_id: row.get(1)?,
        raw_content: row.get(2)?,
        generated_content: row.get(3)?,
        template_id: row.get(4)?,
        created_at: row.get(5)?,
        updated_at: row.get(6)?,
        generated_provider: row.get(7)?,
        generated_model: row.get(8)?,
        generated_at: row.get(9)?,
        generated_transcript_sha: row.get(10)?,
        generated_previous: row.get(11)?,
    })
}

/// A single action item, flattened out of a note body for the Tasks rollup.
/// `(note_id, source, index)` addresses the exact node so the rollup can write
/// `done` back into the source note.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActionItem {
    pub meeting_id: String,
    pub meeting_title: String,
    pub meeting_date: Option<String>,
    pub note_id: String,
    pub source: String, // "raw" | "generated"
    pub index: usize,   // Nth actionItem in that body, document order
    pub task: String,
    pub assignee: Option<String>,
    pub deadline: Option<String>,
    pub done: bool,
    /// Overlay state (plan v5): hidden from the default view + digest until
    /// this date. Never mutates the meeting-stated deadline.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snoozed_until: Option<String>,
    /// Consciously dropped in triage — excluded everywhere except the note.
    #[serde(default)]
    pub dropped: bool,
}

/// Attributes pulled off one `actionItem` TipTap node.
struct ActionItemAttrs {
    task: String,
    assignee: Option<String>,
    deadline: Option<String>,
    done: bool,
}

/// Depth-first walk of a TipTap doc, collecting `actionItem` nodes in document
/// order. Shared with `set_nth_action_item_done` so read and write order match.
fn collect_action_items(node: &serde_json::Value, out: &mut Vec<ActionItemAttrs>) {
    if node.get("type").and_then(|t| t.as_str()) == Some("actionItem") {
        let attrs = node.get("attrs");
        let get_str = |k: &str| {
            attrs
                .and_then(|a| a.get(k))
                .and_then(|v| v.as_str())
                .map(str::to_string)
        };
        out.push(ActionItemAttrs {
            task: get_str("task").unwrap_or_default(),
            assignee: get_str("assignee"),
            deadline: get_str("deadline"),
            done: attrs
                .and_then(|a| a.get("done"))
                .and_then(|v| v.as_bool())
                .unwrap_or(false),
        });
    }
    if let Some(children) = node.get("content").and_then(|c| c.as_array()) {
        for child in children {
            collect_action_items(child, out);
        }
    }
}

/// Set `done` on the `target`th `actionItem` (document order). `counter` tracks
/// how many action items have been seen so far. Returns true once it sets one.
/// The text of every actionItem in document order — the identity anchor
/// for positional write-back (migration 19).
fn collect_action_item_texts(node: &serde_json::Value, out: &mut Vec<String>) {
    if node.get("type").and_then(|t| t.as_str()) == Some("actionItem") {
        out.push(
            node.pointer("/attrs/task")
                .and_then(|t| t.as_str())
                .unwrap_or("")
                .to_string(),
        );
    }
    if let Some(children) = node.get("content").and_then(|c| c.as_array()) {
        for child in children {
            collect_action_item_texts(child, out);
        }
    }
}

fn set_nth_action_item_done(
    node: &mut serde_json::Value,
    target: usize,
    counter: &mut usize,
    done: bool,
) -> bool {
    if node.get("type").and_then(|t| t.as_str()) == Some("actionItem") {
        if *counter == target {
            let obj = match node.as_object_mut() {
                Some(o) => o,
                None => return false,
            };
            let attrs = obj
                .entry("attrs")
                .or_insert_with(|| serde_json::Value::Object(serde_json::Map::new()));
            if let Some(attrs_obj) = attrs.as_object_mut() {
                attrs_obj.insert("done".to_string(), serde_json::Value::Bool(done));
                return true;
            }
            return false;
        }
        *counter += 1;
    }
    if let Some(children) = node.get_mut("content").and_then(|c| c.as_array_mut()) {
        for child in children {
            if set_nth_action_item_done(child, target, counter, done) {
                return true;
            }
        }
    }
    false
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Transcript {
    pub id: String,
    pub meeting_id: String,
    pub segments: String,
    pub source: String,
    pub language: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub id: String,
    pub meeting_id: Option<String>,
    pub role: String,
    pub content: String,
    pub context_meeting_ids: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Template {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub prompt_template: String,
    pub sections: String,
    pub is_default: bool,
    pub is_builtin: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Folder {
    pub id: String,
    pub name: String,
    pub color: String,
    pub icon: String,
    pub sort_order: i32,
    pub parent_id: Option<String>,
    pub meeting_count: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Tag {
    pub id: String,
    pub name: String,
    pub source: String,
    pub created_at: String,
}

/// Voice profile for speaker identification 
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VoiceProfile {
    pub id: String,
    pub speaker_name: String,
    pub sample_path: String,
    pub created_at: String,
}

// --- Helpers ---

/// Build a safe FTS5 MATCH query from arbitrary user input.
///
/// FTS5 has a small but real grammar (`AND`, `OR`, `NOT`, `NEAR`, column
/// filters, prefix `*`, parentheses, quotes). User input must not be treated
/// as that grammar — both for correctness (a search for `OR` shouldn't act
/// like an operator) and to deny a DoS via pathological queries. We strip
/// every non-alphanumeric/whitespace character, split on whitespace, and
/// wrap each remaining token in double quotes so FTS treats it as a literal
/// phrase. Empty input or input that contains only stripped characters
/// returns an empty string, which callers must treat as "no results".
fn sanitize_fts_query(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .map(|c| if c.is_alphanumeric() || c.is_whitespace() { c } else { ' ' })
        .collect();
    cleaned
        .split_whitespace()
        // Keep query bounded — extremely long single tokens were a DoS vector.
        .filter(|w| w.len() <= 64)
        .take(20)
        .map(|w| format!("\"{}\"", w))
        .collect::<Vec<_>>()
        .join(" ")
}

/// `sanitize_fts_query`, but OR-joined. Chat questions are natural language
/// ("what did we decide about the budget?") — the implicit-AND form would
/// demand every filler word appear in one segment and almost always match
/// nothing. OR + bm25 ranking is the recall-oriented retrieval shape: rare
/// terms dominate the score, filler terms fade out.
fn sanitize_fts_query_any(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .map(|c| if c.is_alphanumeric() || c.is_whitespace() { c } else { ' ' })
        .collect();
    cleaned
        .split_whitespace()
        .filter(|w| w.len() <= 64)
        .take(20)
        .map(|w| format!("\"{}\"", w))
        .collect::<Vec<_>>()
        .join(" OR ")
}

fn now() -> String {
    Utc::now().to_rfc3339()
}

fn new_id() -> String {
    Uuid::new_v4().to_string()
}

fn map_meeting_row(row: &rusqlite::Row) -> rusqlite::Result<Meeting> {
    Ok(Meeting {
        id: row.get(0)?,
        title: row.get(1)?,
        scheduled_start: row.get(2)?,
        scheduled_end: row.get(3)?,
        actual_start: row.get(4)?,
        actual_end: row.get(5)?,
        calendar_event_id: row.get(6)?,
        attendees: row.get(7)?,
        location: row.get(8)?,
        meeting_url: row.get(9)?,
        platform: row.get(10)?,
        status: row.get(11)?,
        is_pinned: row.get(12)?,
        is_archived: row.get(13)?,
        deleted_at: row.get(14)?,
        created_at: row.get(15)?,
        updated_at: row.get(16)?,
        device_name: row.get(17)?,
        system_audio_captured: row.get::<_, i64>(18).map(|v| v != 0).unwrap_or(false),
        note_status: default_note_status(),
    })
}

fn map_meeting_row_with_note_status(row: &rusqlite::Row) -> rusqlite::Result<Meeting> {
    Ok(Meeting {
        id: row.get(0)?,
        title: row.get(1)?,
        scheduled_start: row.get(2)?,
        scheduled_end: row.get(3)?,
        actual_start: row.get(4)?,
        actual_end: row.get(5)?,
        calendar_event_id: row.get(6)?,
        attendees: row.get(7)?,
        location: row.get(8)?,
        meeting_url: row.get(9)?,
        platform: row.get(10)?,
        status: row.get(11)?,
        is_pinned: row.get(12)?,
        is_archived: row.get(13)?,
        deleted_at: row.get(14)?,
        created_at: row.get(15)?,
        updated_at: row.get(16)?,
        device_name: row.get(17)?,
        system_audio_captured: row.get::<_, i64>(18).map(|v| v != 0).unwrap_or(false),
        note_status: row.get::<_, Option<String>>(19)?.unwrap_or_else(default_note_status),
    })
}

// --- Meeting Queries ---

impl Database {
    pub fn create_meeting(&self, title: &str) -> Result<Meeting> {
        let conn = self.conn.lock().unwrap();
        let id = new_id();
        let now = now();
        conn.execute(
            "INSERT INTO meetings (id, title, created_at, updated_at) VALUES (?1, ?2, ?3, ?4)",
            params![id, title, now, now],
        )?;
        Ok(Meeting {
            id,
            title: title.to_string(),
            scheduled_start: None,
            scheduled_end: None,
            actual_start: None,
            actual_end: None,
            calendar_event_id: None,
            attendees: "[]".to_string(),
            location: None,
            meeting_url: None,
            platform: "unknown".to_string(),
            status: "upcoming".to_string(),
            is_pinned: false,
            is_archived: false,
            deleted_at: None,
            created_at: now.clone(),
            updated_at: now,
            device_name: None,
            system_audio_captured: false,
            note_status: default_note_status(),
        })
    }

    pub fn update_meeting_device(
        &self,
        id: &str,
        device_name: Option<&str>,
        system_audio_captured: bool,
    ) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE meetings SET device_name = ?1, system_audio_captured = ?2, updated_at = ?3 WHERE id = ?4",
            params![device_name, system_audio_captured as i64, now(), id],
        )?;
        Ok(())
    }

    pub fn get_meeting(&self, id: &str) -> Result<Option<Meeting>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, title, scheduled_start, scheduled_end, actual_start, actual_end,
                    calendar_event_id, attendees, location, meeting_url, platform, status,
                    is_pinned, is_archived, deleted_at, created_at, updated_at,
                    device_name, system_audio_captured
             FROM meetings WHERE id = ?1"
        )?;
        let mut rows = stmt.query_map(params![id], map_meeting_row)?;
        match rows.next() {
            Some(row) => Ok(Some(row?)),
            None => Ok(None),
        }
    }

    pub fn list_meetings(&self) -> Result<Vec<Meeting>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT m.id, m.title, m.scheduled_start, m.scheduled_end, m.actual_start, m.actual_end,
                    m.calendar_event_id, m.attendees, m.location, m.meeting_url, m.platform, m.status,
                    m.is_pinned, m.is_archived, m.deleted_at, m.created_at, m.updated_at,
                    m.device_name, m.system_audio_captured,
                    CASE
                      WHEN n.generated_content IS NOT NULL THEN 'enhanced'
                      WHEN n.raw_content IS NOT NULL AND n.raw_content != '' THEN 'draft'
                      ELSE 'none'
                    END as note_status
             FROM meetings m
             LEFT JOIN notes n ON n.meeting_id = m.id
             WHERE m.deleted_at IS NULL AND m.is_archived = 0
             ORDER BY m.is_pinned DESC, COALESCE(m.scheduled_start, m.created_at) DESC"
        )?;
        let rows = stmt.query_map([], map_meeting_row_with_note_status)?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub fn list_archived_meetings(&self) -> Result<Vec<Meeting>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, title, scheduled_start, scheduled_end, actual_start, actual_end,
                    calendar_event_id, attendees, location, meeting_url, platform, status,
                    is_pinned, is_archived, deleted_at, created_at, updated_at,
                    device_name, system_audio_captured
             FROM meetings WHERE is_archived = 1 AND deleted_at IS NULL
             ORDER BY updated_at DESC"
        )?;
        let rows = stmt.query_map([], map_meeting_row)?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub fn list_deleted_meetings(&self) -> Result<Vec<Meeting>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, title, scheduled_start, scheduled_end, actual_start, actual_end,
                    calendar_event_id, attendees, location, meeting_url, platform, status,
                    is_pinned, is_archived, deleted_at, created_at, updated_at,
                    device_name, system_audio_captured
             FROM meetings WHERE deleted_at IS NOT NULL
             ORDER BY deleted_at DESC"
        )?;
        let rows = stmt.query_map([], map_meeting_row)?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub fn update_meeting_title(&self, id: &str, title: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE meetings SET title = ?1, updated_at = ?2 WHERE id = ?3",
            params![title, now(), id],
        )?;
        Ok(())
    }

    /// Compare-and-swap title update for the auto-titler: one statement under
    /// the connection mutex, so a user rename that landed first can never be
    /// clobbered — the WHERE clause simply stops matching. Returns whether
    /// the swap happened.
    pub fn update_meeting_title_if_unchanged(
        &self,
        id: &str,
        expected: &str,
        title: &str,
    ) -> Result<bool> {
        let conn = self.conn.lock().unwrap();
        let n = conn.execute(
            "UPDATE meetings SET title = ?1, updated_at = ?2 WHERE id = ?3 AND title = ?4",
            params![title, now(), id, expected],
        )?;
        Ok(n > 0)
    }

    pub fn delete_meeting(&self, id: &str) -> Result<()> {
        // The semantic index is a vec0 virtual table — no FK cascade reaches
        // it. Purge first, or the deleted meeting's transcript text would
        // keep surfacing in semantic search forever.
        self.purge_meeting_vectors(id)?;
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM meetings WHERE id = ?1", params![id])?;
        Ok(())
    }

    pub fn soft_delete_meeting(&self, id: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE meetings SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2",
            params![now(), id],
        )?;
        Ok(())
    }

    pub fn restore_meeting(&self, id: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE meetings SET deleted_at = NULL, updated_at = ?1 WHERE id = ?2",
            params![now(), id],
        )?;
        Ok(())
    }

    pub fn toggle_pin_meeting(&self, id: &str) -> Result<bool> {
        let conn = self.conn.lock().unwrap();
        let current: bool = conn.query_row(
            "SELECT is_pinned FROM meetings WHERE id = ?1",
            params![id],
            |row| row.get(0),
        )?;
        let new_val = !current;
        conn.execute(
            "UPDATE meetings SET is_pinned = ?1, updated_at = ?2 WHERE id = ?3",
            params![new_val, now(), id],
        )?;
        Ok(new_val)
    }

    pub fn archive_meeting(&self, id: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE meetings SET is_archived = 1, updated_at = ?1 WHERE id = ?2",
            params![now(), id],
        )?;
        Ok(())
    }

    pub fn unarchive_meeting(&self, id: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE meetings SET is_archived = 0, updated_at = ?1 WHERE id = ?2",
            params![now(), id],
        )?;
        Ok(())
    }

    pub fn update_meeting_status(&self, id: &str, status: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE meetings SET status = ?1, updated_at = ?2 WHERE id = ?3",
            params![status, now(), id],
        )?;
        Ok(())
    }

    /// Mark meetings left in an in-flight recording state by a crash as
    /// complete, returning their ids so the caller can repair their WAV
    /// headers. Only valid to call at startup, before any recording starts.
    pub fn reconcile_interrupted_meetings(&self) -> Result<Vec<String>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            // 'generating' is a legacy in-flight status no current code path
            // writes — rows stuck there can never resolve on their own.
            "SELECT id FROM meetings WHERE status IN ('recording', 'transcribing', 'generating')",
        )?;
        let ids: Vec<String> = stmt
            .query_map([], |row| row.get(0))?
            .filter_map(|r| r.ok())
            .collect();
        if !ids.is_empty() {
            conn.execute(
                "UPDATE meetings SET status = 'complete', updated_at = ?1
                 WHERE status IN ('recording', 'transcribing', 'generating')",
                params![now()],
            )?;
        }
        Ok(ids)
    }

    /// Every meeting id in the table, including soft-deleted and archived rows.
    /// Used by the orphaned-recording sweep, which must only remove files that
    /// belong to NO meeting at all.
    pub fn all_meeting_ids(&self) -> Result<std::collections::HashSet<String>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT id FROM meetings")?;
        let ids = stmt
            .query_map([], |row| row.get(0))?
            .filter_map(|r| r.ok())
            .collect();
        Ok(ids)
    }

    pub fn update_meeting_metadata(
        &self,
        id: &str,
        scheduled_start: Option<&str>,
        scheduled_end: Option<&str>,
        location: Option<&str>,
        attendees: Option<&str>,
    ) -> Result<()> {
        // Scope the lock so it is released before we call upsert_mention_candidate /
        // prune_mention_candidates (which each re-acquire the same mutex).
        {
            let conn = self.conn.lock().unwrap();
            conn.execute(
                "UPDATE meetings SET
                   scheduled_start = COALESCE(?1, scheduled_start),
                   scheduled_end   = COALESCE(?2, scheduled_end),
                   location        = ?3,
                   attendees       = COALESCE(?4, attendees),
                   updated_at      = ?5
                 WHERE id = ?6",
                params![scheduled_start, scheduled_end, location, attendees, now(), id],
            )?;
        } // conn (MutexGuard) is dropped here

        // If attendees were provided, populate the mention pool.
        if let Some(att_json) = attendees {
            if let Ok(arr) = serde_json::from_str::<serde_json::Value>(att_json) {
                if let Some(items) = arr.as_array() {
                    let now_str = now();
                    for item in items {
                        let name = match item {
                            serde_json::Value::String(s) => {
                                if let Some(idx) = s.find('@') { s[..idx].to_string() } else { s.clone() }
                            }
                            serde_json::Value::Object(o) => {
                                if let Some(n) = o.get("name").and_then(|v| v.as_str()) {
                                    n.to_string()
                                } else if let Some(e) = o.get("email").and_then(|v| v.as_str()) {
                                    if let Some(idx) = e.find('@') { e[..idx].to_string() } else { e.to_string() }
                                } else { String::new() }
                            }
                            _ => String::new(),
                        };
                        if !name.is_empty() {
                            let _ = self.upsert_mention_candidate(&name, &now_str);
                        }
                    }
                    let _ = self.prune_mention_candidates();
                }
            }
        }

        Ok(())
    }

    pub fn update_meeting_times(&self, id: &str, actual_start: Option<&str>, actual_end: Option<&str>) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        // COALESCE preserves existing values when None is passed — prevents stop_recording
        // from nulling out actual_start by passing None for the start argument.
        conn.execute(
            "UPDATE meetings SET actual_start = COALESCE(?1, actual_start), actual_end = COALESCE(?2, actual_end), updated_at = ?3 WHERE id = ?4",
            params![actual_start, actual_end, now(), id],
        )?;
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    pub fn upsert_calendar_meeting(
        &self,
        calendar_event_id: &str,
        title: &str,
        scheduled_start: &str,
        scheduled_end: &str,
        attendees: &str,
        location: Option<&str>,
        meeting_url: Option<&str>,
        platform: &str,
    ) -> Result<Meeting> {
        let conn = self.conn.lock().unwrap();
        let now = now();

        let existing: Option<(String, String, Option<String>)> = conn
            .query_row(
                "SELECT id, COALESCE(scheduled_start, ''), title FROM meetings WHERE calendar_event_id = ?1",
                params![calendar_event_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .ok();

        if let Some((id, prev_start, _prev_title)) = existing {
            // The user's decisions outrank the feed (data-lifecycle audit
            // P1: this UPDATE used to clear deleted_at/is_archived and
            // rewrite the title unconditionally — trashed synced meetings
            // climbed out of the trash every 5 minutes and renames
            // reverted). Resurrect ONLY on a genuine reschedule (the start
            // time changed — effectively a new instance of the event). The
            // title is set at INSERT and never overwritten afterwards: we
            // can't tell a user rename from a calendar-side rename without
            // storing the last-synced title, and clobbering the user's is
            // the worse failure. Times/attendees/location/url track the feed.
            let rescheduled = prev_start != scheduled_start;
            if rescheduled {
                conn.execute(
                    "UPDATE meetings SET scheduled_start=?1, scheduled_end=?2,
                     attendees=?3, location=?4, meeting_url=?5, platform=?6, updated_at=?7,
                     deleted_at=NULL, is_archived=0
                     WHERE id=?8",
                    params![scheduled_start, scheduled_end, attendees, location, meeting_url, platform, now, id],
                )?;
            } else {
                conn.execute(
                    "UPDATE meetings SET scheduled_start=?1, scheduled_end=?2,
                     attendees=?3, location=?4, meeting_url=?5, platform=?6, updated_at=?7
                     WHERE id=?8",
                    params![scheduled_start, scheduled_end, attendees, location, meeting_url, platform, now, id],
                )?;
            }
            drop(conn);
            Ok(self.get_meeting(&id)?.unwrap())
        } else {
            // UID churn (whole-app review P2): some providers re-issue a new
            // UID for the same event — matching only on calendar_event_id
            // duplicated the meeting and left the old one as a permanent
            // ghost. Before inserting, adopt an existing synced meeting with
            // the same title at the same start.
            let adopt: Option<String> = conn
                .query_row(
                    "SELECT id FROM meetings
                     WHERE title = ?1 AND scheduled_start = ?2
                       AND calendar_event_id IS NOT NULL AND deleted_at IS NULL",
                    params![title, scheduled_start],
                    |row| row.get(0),
                )
                .ok();
            if let Some(id) = adopt {
                conn.execute(
                    "UPDATE meetings SET calendar_event_id=?1, scheduled_end=?2,
                     attendees=?3, location=?4, meeting_url=?5, platform=?6, updated_at=?7
                     WHERE id=?8",
                    params![calendar_event_id, scheduled_end, attendees, location, meeting_url, platform, now, id],
                )?;
                drop(conn);
                return Ok(self.get_meeting(&id)?.unwrap());
            }
            let id = new_id();
            conn.execute(
                "INSERT INTO meetings (id, title, scheduled_start, scheduled_end,
                 calendar_event_id, attendees, location, meeting_url, platform,
                 is_pinned, is_archived, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0, 0, ?10, ?11)",
                params![id, title, scheduled_start, scheduled_end, calendar_event_id, attendees, location, meeting_url, platform, now, now],
            )?;
            drop(conn);
            Ok(self.get_meeting(&id)?.unwrap())
        }
    }

    // --- Note Queries ---

    pub fn create_note(&self, meeting_id: &str, template_id: Option<&str>) -> Result<Note> {
        let conn = self.conn.lock().unwrap();
        let id = new_id();
        let now = now();
        conn.execute(
            "INSERT INTO notes (id, meeting_id, template_id, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![id, meeting_id, template_id, now, now],
        )?;
        Ok(Note {
            id,
            meeting_id: meeting_id.to_string(),
            raw_content: None,
            generated_content: None,
            template_id: template_id.map(String::from),
            created_at: now.clone(),
            updated_at: now,
            generated_provider: None,
            generated_model: None,
            generated_at: None,
            generated_transcript_sha: None,
            generated_previous: None,
        })
    }

    /// Return the meeting's note, creating an empty one if none exists yet.
    /// Atomic under the connection lock so concurrent callers (auto-save and
    /// the enhance flow) can't insert duplicate rows for the same meeting.
    pub fn get_or_create_note(&self, meeting_id: &str) -> Result<Note> {
        let conn = self.conn.lock().unwrap();
        {
            let mut stmt = conn.prepare(&format!(
                "SELECT {NOTE_COLUMNS}
                 FROM notes WHERE meeting_id = ?1 ORDER BY created_at DESC LIMIT 1"
            ))?;
            let mut rows = stmt.query_map(params![meeting_id], map_note_row)?;
            if let Some(row) = rows.next() {
                return Ok(row?);
            }
        }
        let id = new_id();
        let now = now();
        conn.execute(
            "INSERT INTO notes (id, meeting_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?4)",
            params![id, meeting_id, now, now],
        )?;
        Ok(Note {
            id,
            meeting_id: meeting_id.to_string(),
            raw_content: None,
            generated_content: None,
            template_id: None,
            created_at: now.clone(),
            updated_at: now,
            generated_provider: None,
            generated_model: None,
            generated_at: None,
            generated_transcript_sha: None,
            generated_previous: None,
        })
    }

    pub fn get_note_by_meeting(&self, meeting_id: &str) -> Result<Option<Note>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(&format!(
            "SELECT {NOTE_COLUMNS}
             FROM notes WHERE meeting_id = ?1 ORDER BY created_at DESC LIMIT 1"
        ))?;
        let mut rows = stmt.query_map(params![meeting_id], map_note_row)?;
        match rows.next() {
            Some(row) => Ok(Some(row?)),
            None => Ok(None),
        }
    }

    pub fn update_note_raw_content(&self, id: &str, raw_content: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE notes SET raw_content = ?1, updated_at = ?2 WHERE id = ?3",
            params![raw_content, now(), id],
        )?;
        Ok(())
    }

    pub fn update_note_generated_content(&self, id: &str, generated_content: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE notes SET generated_content = ?1, updated_at = ?2 WHERE id = ?3",
            params![generated_content, now(), id],
        )?;
        Ok(())
    }

    /// Update raw and generated content in one statement so the enhance flow
    /// can't be interleaved with an autosave between two separate writes.
    /// `raw_content: None` leaves the existing raw body untouched.
    pub fn update_note_contents(
        &self,
        id: &str,
        raw_content: Option<&str>,
        generated_content: &str,
    ) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE notes SET raw_content = COALESCE(?1, raw_content),
                              generated_content = ?2, updated_at = ?3
             WHERE id = ?4",
            params![raw_content, generated_content, now(), id],
        )?;
        Ok(())
    }

    pub fn get_note_by_id(&self, id: &str) -> Result<Option<Note>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(&format!(
            "SELECT {NOTE_COLUMNS} FROM notes WHERE id = ?1"
        ))?;
        let mut rows = stmt.query_map(params![id], map_note_row)?;
        match rows.next() {
            Some(row) => Ok(Some(row?)),
            None => Ok(None),
        }
    }

    /// Persist freshly generated AI notes WITH their receipt (plan v10 #2):
    /// provider/model that ran, generation timestamp, and the transcript
    /// hash the prompt was built from. If the note already had generated
    /// content, that version (content + its receipts) moves into the one
    /// `generated_previous` slot first — a re-enhance never silently
    /// destroys the prior AI notes. One lock acquisition: the read-old +
    /// write-new can't interleave with another writer.
    #[allow(clippy::too_many_arguments)]
    pub fn update_note_generated_with_receipt(
        &self,
        id: &str,
        raw_content: Option<&str>,
        generated_content: &str,
        provider: &str,
        model: &str,
        transcript_sha: Option<&str>,
    ) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        let old: Option<(Option<String>, Option<String>, Option<String>, Option<String>, Option<String>)> =
            conn.query_row(
                "SELECT generated_content, generated_provider, generated_model,
                        generated_at, generated_transcript_sha
                 FROM notes WHERE id = ?1",
                params![id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
            .ok();
        let Some(old) = old else {
            anyhow::bail!("note not found: {id}");
        };
        // Envelope only when there WAS a prior version; otherwise leave the
        // previous slot untouched (NULL stays NULL on first enhance).
        let previous: Option<String> = old.0.as_ref().map(|content| {
            serde_json::json!({
                "content": content,
                "provider": old.1,
                "model": old.2,
                "generated_at": old.3,
                "transcript_sha": old.4,
            })
            .to_string()
        });
        conn.execute(
            "UPDATE notes SET raw_content = COALESCE(?1, raw_content),
                              generated_content = ?2,
                              generated_provider = ?3,
                              generated_model = ?4,
                              generated_at = ?5,
                              generated_transcript_sha = ?6,
                              generated_previous = COALESCE(?7, generated_previous),
                              updated_at = ?5
             WHERE id = ?8",
            params![raw_content, generated_content, provider, model, now(), transcript_sha, previous, id],
        )?;
        Ok(())
    }

    /// Swap `generated_content` with the one-slot previous version — content
    /// AND receipt fields trade places (the restored version's receipt comes
    /// back from the envelope; the displaced version's receipt goes in).
    /// Errors when there is no previous version. Returns the updated note.
    pub fn restore_previous_generated(&self, id: &str) -> Result<Note> {
        {
            let conn = self.conn.lock().unwrap();
            let row: Option<(Option<String>, Option<String>, Option<String>, Option<String>, Option<String>, Option<String>)> =
                conn.query_row(
                    "SELECT generated_content, generated_provider, generated_model,
                            generated_at, generated_transcript_sha, generated_previous
                     FROM notes WHERE id = ?1",
                    params![id],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
                )
                .ok();
            let Some((cur_content, cur_provider, cur_model, cur_at, cur_sha, previous)) = row else {
                anyhow::bail!("note not found: {id}");
            };
            let previous = previous.ok_or_else(|| anyhow::anyhow!("no previous version to restore"))?;
            let envelope: serde_json::Value = serde_json::from_str(&previous)
                .map_err(|e| anyhow::anyhow!("previous-version slot is corrupt: {e}"))?;
            let restored_content = envelope
                .get("content")
                .and_then(|v| v.as_str())
                .ok_or_else(|| anyhow::anyhow!("previous-version slot has no content"))?
                .to_string();
            let env_str = |k: &str| envelope.get(k).and_then(|v| v.as_str()).map(str::to_string);

            // The displaced current version becomes the new previous slot —
            // restore is its own undo.
            let new_previous: Option<String> = cur_content.as_ref().map(|content| {
                serde_json::json!({
                    "content": content,
                    "provider": cur_provider,
                    "model": cur_model,
                    "generated_at": cur_at,
                    "transcript_sha": cur_sha,
                })
                .to_string()
            });
            conn.execute(
                "UPDATE notes SET generated_content = ?1,
                                  generated_provider = ?2,
                                  generated_model = ?3,
                                  generated_at = ?4,
                                  generated_transcript_sha = ?5,
                                  generated_previous = ?6,
                                  updated_at = ?7
                 WHERE id = ?8",
                params![
                    restored_content,
                    env_str("provider"),
                    env_str("model"),
                    env_str("generated_at"),
                    env_str("transcript_sha"),
                    new_previous,
                    now(),
                    id
                ],
            )?;
        }
        self.get_note_by_id(id)?
            .ok_or_else(|| anyhow::anyhow!("note not found after restore: {id}"))
    }

    // --- Action Item Rollup ---

    /// Flatten every `actionItem` node from all active meetings' notes (both the
    /// raw and generated note bodies) into one list, in meeting-recency then
    /// document order. Malformed note JSON is skipped, never fatal.
    pub fn list_action_items(&self) -> Result<Vec<ActionItem>> {
        let overlays = self.task_overlays().unwrap_or_default();
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT m.id, m.title,
                    COALESCE(m.actual_start, m.scheduled_start, m.created_at) AS mdate,
                    n.id, n.raw_content, n.generated_content
             FROM meetings m
             JOIN notes n ON n.meeting_id = m.id
             WHERE m.deleted_at IS NULL AND m.is_archived = 0
             ORDER BY mdate DESC",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, Option<String>>(5)?,
            ))
        })?;

        let mut out = Vec::new();
        for row in rows {
            let (meeting_id, title, mdate, note_id, raw, generated) = row?;
            for (source, content) in [("raw", raw), ("generated", generated)] {
                let Some(json) = content else { continue };
                let value = match serde_json::from_str::<serde_json::Value>(&json) {
                    Ok(v) => v,
                    Err(_) => {
                        log::warn!(
                            "action-item rollup: skipping malformed {source} body for note {note_id}"
                        );
                        continue;
                    }
                };
                let mut items = Vec::new();
                collect_action_items(&value, &mut items);
                for (index, attrs) in items.into_iter().enumerate() {
                    let task_text = attrs.task.clone();
                    out.push(ActionItem {
                        meeting_id: meeting_id.clone(),
                        meeting_title: title.clone(),
                        meeting_date: mdate.clone(),
                        note_id: note_id.clone(),
                        source: source.to_string(),
                        index,
                        task: attrs.task,
                        assignee: attrs.assignee,
                        deadline: attrs.deadline,
                        done: attrs.done,
                        // An overlay decorates this slot only when its text
                        // anchor agrees (or is legacy-NULL) — a snooze must
                        // never re-target itself onto a different task after
                        // the note was edited (migration 19).
                        snoozed_until: overlays
                            .get(&(note_id.clone(), source.to_string(), index))
                            .filter(|(_, _, t)| t.is_none() || t.as_deref() == Some(task_text.as_str()))
                            .and_then(|(s, _, _)| s.clone()),
                        dropped: overlays
                            .get(&(note_id.clone(), source.to_string(), index))
                            .filter(|(_, _, t)| t.is_none() || t.as_deref() == Some(task_text.as_str()))
                            .map(|(_, d, _)| *d)
                            .unwrap_or(false),
                    });
                }
            }
        }
        Ok(out)
    }

    /// Flip the `done` attr of the Nth `actionItem` (document order) in the given
    /// note body and persist. Addressed by `(note_id, source, index)` — the same
    /// addressing `list_action_items` produces, so the rollup checkbox and the
    /// in-note checkbox stay in sync.
    pub fn set_action_item_done(
        &self,
        note_id: &str,
        source: &str,
        index: usize,
        done: bool,
        expected_text: Option<&str>,
    ) -> Result<()> {
        let note = self
            .get_note_by_id(note_id)?
            .ok_or_else(|| anyhow::anyhow!("note not found"))?;
        let content = match source {
            "raw" => note.raw_content,
            "generated" => note.generated_content,
            other => return Err(anyhow::anyhow!("invalid action-item source: {other}")),
        }
        .ok_or_else(|| anyhow::anyhow!("note {source} body is empty"))?;

        let mut value: serde_json::Value = serde_json::from_str(&content)?;
        // Positional addressing drifts when items above are added/removed
        // (migration 19): when the caller knows which TEXT it meant, verify
        // the position — and if it moved, re-locate by exact text rather
        // than flipping whatever now sits at the old index.
        let index = match expected_text {
            None => index,
            Some(expected) => {
                let mut texts = Vec::new();
                collect_action_item_texts(&value, &mut texts);
                if texts.get(index).map(String::as_str) == Some(expected) {
                    index
                } else {
                    let matches: Vec<usize> = texts
                        .iter()
                        .enumerate()
                        .filter(|(_, t)| t.as_str() == expected)
                        .map(|(i, _)| i)
                        .collect();
                    match matches.as_slice() {
                        [only] => {
                            log::info!(
                                "action-item write-back relocated \"{expected}\" {index} -> {only}"
                            );
                            *only
                        }
                        [] => {
                            return Err(anyhow::anyhow!(
                                "that task is no longer in the note — refresh and try again"
                            ))
                        }
                        _ => {
                            return Err(anyhow::anyhow!(
                                "several tasks share this text — open the note to edit it"
                            ))
                        }
                    }
                }
            }
        };
        let mut counter = 0usize;
        if !set_nth_action_item_done(&mut value, index, &mut counter, done) {
            return Err(anyhow::anyhow!("action item index {index} out of range"));
        }
        let updated = serde_json::to_string(&value)?;
        match source {
            "raw" => self.update_note_raw_content(note_id, &updated)?,
            "generated" => self.update_note_generated_content(note_id, &updated)?,
            _ => unreachable!(),
        }
        Ok(())
    }

    // --- Transcript Queries ---

    pub fn create_transcript(&self, meeting_id: &str, source: &str) -> Result<Transcript> {
        let conn = self.conn.lock().unwrap();
        let id = new_id();
        let now = now();
        conn.execute(
            "INSERT INTO transcripts (id, meeting_id, source, created_at)
             VALUES (?1, ?2, ?3, ?4)",
            params![id, meeting_id, source, now],
        )?;
        Ok(Transcript {
            id,
            meeting_id: meeting_id.to_string(),
            segments: "[]".to_string(),
            source: source.to_string(),
            language: "en".to_string(),
            created_at: now,
        })
    }

    pub fn append_transcript_segment(&self, id: &str, segment_json: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE transcripts SET segments = json_insert(
                CASE WHEN segments = '[]' THEN '[]' ELSE segments END,
                '$[#]',
                json(?1)
             ) WHERE id = ?2",
            params![segment_json, id],
        )?;
        Ok(())
    }

    /// Replace all transcript segments (used by re-diarization)
    pub fn update_transcript_segments(&self, id: &str, segments_json: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE transcripts SET segments = ?1 WHERE id = ?2",
            params![segments_json, id],
        )?;
        Ok(())
    }

    pub fn get_transcript_by_meeting(&self, meeting_id: &str) -> Result<Option<Transcript>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, meeting_id, segments, source, language, created_at
             FROM transcripts WHERE meeting_id = ?1 ORDER BY created_at DESC LIMIT 1"
        )?;
        let mut rows = stmt.query_map(params![meeting_id], |row| {
            Ok(Transcript {
                id: row.get(0)?,
                meeting_id: row.get(1)?,
                segments: row.get(2)?,
                source: row.get(3)?,
                language: row.get(4)?,
                created_at: row.get(5)?,
            })
        })?;
        match rows.next() {
            Some(row) => Ok(Some(row?)),
            None => Ok(None),
        }
    }

    // --- Chat Queries ---

    pub fn create_chat_message(
        &self,
        meeting_id: Option<&str>,
        role: &str,
        content: &str,
        context_meeting_ids: &str,
    ) -> Result<ChatMessage> {
        let conn = self.conn.lock().unwrap();
        let id = new_id();
        let now = now();
        conn.execute(
            "INSERT INTO chat_messages (id, meeting_id, role, content, context_meeting_ids, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![id, meeting_id, role, content, context_meeting_ids, now],
        )?;
        Ok(ChatMessage {
            id,
            meeting_id: meeting_id.map(String::from),
            role: role.to_string(),
            content: content.to_string(),
            context_meeting_ids: context_meeting_ids.to_string(),
            created_at: now,
        })
    }

    pub fn list_chat_messages(&self, meeting_id: Option<&str>) -> Result<Vec<ChatMessage>> {
        let conn = self.conn.lock().unwrap();
        let map_row = |row: &rusqlite::Row| -> rusqlite::Result<ChatMessage> {
            Ok(ChatMessage {
                id: row.get(0)?,
                meeting_id: row.get(1)?,
                role: row.get(2)?,
                content: row.get(3)?,
                context_meeting_ids: row.get(4)?,
                created_at: row.get(5)?,
            })
        };
        match meeting_id {
            Some(mid) => {
                let mut stmt = conn.prepare(
                    "SELECT id, meeting_id, role, content, context_meeting_ids, created_at
                     FROM chat_messages WHERE meeting_id = ?1 ORDER BY created_at ASC"
                )?;
                let results = stmt.query_map(params![mid], map_row)?
                    .filter_map(|r| r.ok())
                    .collect();
                Ok(results)
            }
            None => {
                let mut stmt = conn.prepare(
                    "SELECT id, meeting_id, role, content, context_meeting_ids, created_at
                     FROM chat_messages WHERE meeting_id IS NULL ORDER BY created_at ASC"
                )?;
                let results = stmt.query_map([], map_row)?
                    .filter_map(|r| r.ok())
                    .collect();
                Ok(results)
            }
        }
    }

    // --- Template Queries ---

    pub fn create_template(
        &self,
        name: &str,
        description: Option<&str>,
        prompt_template: &str,
        sections: &str,
        is_default: bool,
        is_builtin: bool,
    ) -> Result<Template> {
        let conn = self.conn.lock().unwrap();
        let id = new_id();
        let now = now();
        conn.execute(
            "INSERT INTO templates (id, name, description, prompt_template, sections, is_default, is_builtin, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![id, name, description, prompt_template, sections, is_default, is_builtin, now, now],
        )?;
        Ok(Template {
            id,
            name: name.to_string(),
            description: description.map(String::from),
            prompt_template: prompt_template.to_string(),
            sections: sections.to_string(),
            is_default,
            is_builtin,
            created_at: now.clone(),
            updated_at: now,
        })
    }

    pub fn list_templates(&self) -> Result<Vec<Template>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, name, description, prompt_template, sections, is_default, is_builtin, created_at, updated_at
             FROM templates ORDER BY is_default DESC, name ASC"
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(Template {
                id: row.get(0)?,
                name: row.get(1)?,
                description: row.get(2)?,
                prompt_template: row.get(3)?,
                sections: row.get(4)?,
                is_default: row.get(5)?,
                is_builtin: row.get(6)?,
                created_at: row.get(7)?,
                updated_at: row.get(8)?,
            })
        })?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub fn get_template_by_id(&self, id: &str) -> Result<Option<Template>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, name, description, prompt_template, sections, is_default, is_builtin, created_at, updated_at
             FROM templates WHERE id = ?1",
        )?;
        let mut rows = stmt.query_map(params![id], |row| {
            Ok(Template {
                id: row.get(0)?,
                name: row.get(1)?,
                description: row.get(2)?,
                prompt_template: row.get(3)?,
                sections: row.get(4)?,
                is_default: row.get(5)?,
                is_builtin: row.get(6)?,
                created_at: row.get(7)?,
                updated_at: row.get(8)?,
            })
        })?;
        Ok(rows.next().transpose()?)
    }

    pub fn get_default_template(&self) -> Result<Option<Template>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, name, description, prompt_template, sections, is_default, is_builtin, created_at, updated_at
             FROM templates WHERE is_default = 1 LIMIT 1"
        )?;
        let mut rows = stmt.query_map([], |row| {
            Ok(Template {
                id: row.get(0)?,
                name: row.get(1)?,
                description: row.get(2)?,
                prompt_template: row.get(3)?,
                sections: row.get(4)?,
                is_default: row.get(5)?,
                is_builtin: row.get(6)?,
                created_at: row.get(7)?,
                updated_at: row.get(8)?,
            })
        })?;
        match rows.next() {
            Some(row) => Ok(Some(row?)),
            None => Ok(None),
        }
    }

    pub fn update_template(
        &self,
        id: &str,
        name: &str,
        description: Option<&str>,
        prompt_template: &str,
        sections: &str,
        is_default: bool,
    ) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        let now = now();
        conn.execute(
            "UPDATE templates SET name = ?1, description = ?2, prompt_template = ?3, sections = ?4, is_default = ?5, updated_at = ?6 WHERE id = ?7",
            params![name, description, prompt_template, sections, is_default, now, id],
        )?;
        Ok(())
    }

    pub fn delete_template(&self, id: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM templates WHERE id = ?1 AND is_builtin = 0", params![id])?;
        Ok(())
    }

    // --- Folder Queries ---

    pub fn create_folder(&self, name: &str, color: &str, icon: &str, parent_id: Option<&str>) -> Result<Folder> {
        let conn = self.conn.lock().unwrap();
        let id = new_id();
        let now = now();
        let sort_order: i32 = match parent_id {
            None => conn.query_row(
                "SELECT COALESCE(MAX(sort_order), 0) + 1 FROM folders WHERE parent_id IS NULL",
                [], |row| row.get(0),
            )?,
            Some(pid) => conn.query_row(
                "SELECT COALESCE(MAX(sort_order), 0) + 1 FROM folders WHERE parent_id = ?1",
                params![pid], |row| row.get(0),
            )?,
        };
        conn.execute(
            "INSERT INTO folders (id, name, color, icon, sort_order, parent_id, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![id, name, color, icon, sort_order, parent_id, now, now],
        )?;
        Ok(Folder {
            id,
            name: name.to_string(),
            color: color.to_string(),
            icon: icon.to_string(),
            sort_order,
            parent_id: parent_id.map(|s| s.to_string()),
            meeting_count: 0,
            created_at: now.clone(),
            updated_at: now,
        })
    }

    pub fn list_folders(&self) -> Result<Vec<Folder>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT f.id, f.name, f.color, f.icon, f.sort_order, f.parent_id,
                    COUNT(mf.meeting_id) as meeting_count,
                    f.created_at, f.updated_at
             FROM folders f
             LEFT JOIN meeting_folders mf ON mf.folder_id = f.id
             GROUP BY f.id
             ORDER BY f.sort_order ASC"
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(Folder {
                id: row.get(0)?,
                name: row.get(1)?,
                color: row.get(2)?,
                icon: row.get(3)?,
                sort_order: row.get(4)?,
                parent_id: row.get(5)?,
                meeting_count: row.get(6)?,
                created_at: row.get(7)?,
                updated_at: row.get(8)?,
            })
        })?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub fn add_meeting_to_folder(&self, meeting_id: &str, folder_id: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT OR IGNORE INTO meeting_folders (meeting_id, folder_id) VALUES (?1, ?2)",
            params![meeting_id, folder_id],
        )?;
        Ok(())
    }

    pub fn remove_meeting_from_folder(&self, meeting_id: &str, folder_id: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM meeting_folders WHERE meeting_id = ?1 AND folder_id = ?2",
            params![meeting_id, folder_id],
        )?;
        Ok(())
    }

    pub fn delete_folder(&self, id: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM meeting_folders WHERE folder_id = ?1", params![id])?;
        conn.execute("DELETE FROM folders WHERE id = ?1", params![id])?;
        Ok(())
    }

    #[allow(dead_code)]
    pub fn get_meeting_folder_ids(&self, meeting_id: &str) -> Result<Vec<String>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT folder_id FROM meeting_folders WHERE meeting_id = ?1"
        )?;
        let rows = stmt.query_map(params![meeting_id], |row| row.get::<_, String>(0))?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    /// The meeting's first folder in sidebar order (sort_order, id as the
    /// tiebreak) — the `by-folder` mirror layout files the meeting under it.
    pub fn get_first_folder_name_for_meeting(&self, meeting_id: &str) -> Result<Option<String>> {
        let conn = self.conn.lock().unwrap();
        let name = conn
            .query_row(
                "SELECT f.name FROM folders f
                 JOIN meeting_folders mf ON mf.folder_id = f.id
                 WHERE mf.meeting_id = ?1
                 ORDER BY f.sort_order ASC, f.id ASC
                 LIMIT 1",
                params![meeting_id],
                |row| row.get(0),
            )
            .optional()?;
        Ok(name)
    }

    /// Entire meeting→folders membership map in one query. The list views
    /// previously issued one get_meeting_ids_in_folder round-trip per folder
    /// (N+1); this replaces all of them.
    pub fn get_folder_memberships_map(
        &self,
    ) -> Result<std::collections::HashMap<String, Vec<String>>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT meeting_id, folder_id FROM meeting_folders")?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        let mut map: std::collections::HashMap<String, Vec<String>> =
            std::collections::HashMap::new();
        for row in rows {
            let (meeting_id, folder_id) = row?;
            map.entry(meeting_id).or_default().push(folder_id);
        }
        Ok(map)
    }

    pub fn get_meeting_ids_in_folder(&self, folder_id: &str) -> Result<Vec<String>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT meeting_id FROM meeting_folders WHERE folder_id = ?1"
        )?;
        let rows = stmt.query_map(params![folder_id], |row| row.get::<_, String>(0))?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    /// Batch-update folder ordering (scoped to a parent; parent_id param is for documentation/future use)
    pub fn reorder_folders(&self, folder_ids: &[String], _parent_id: Option<&str>) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        let now = now();
        for (i, id) in folder_ids.iter().enumerate() {
            conn.execute(
                "UPDATE folders SET sort_order = ?1, updated_at = ?2 WHERE id = ?3",
                params![i as i32, now, id],
            )?;
        }
        Ok(())
    }

    pub fn move_folder(&self, id: &str, new_parent_id: Option<&str>) -> Result<()> {
        if Some(id) == new_parent_id {
            return Err(anyhow::anyhow!("Cannot move folder onto itself"));
        }
        let conn = self.conn.lock().unwrap();
        // Validate new_parent_id exists
        if let Some(npid) = new_parent_id {
            let exists: bool = conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM folders WHERE id = ?1)",
                params![npid],
                |row| row.get(0),
            ).unwrap_or(false);
            if !exists {
                return Err(anyhow::anyhow!("Target parent folder does not exist"));
            }
        }
        // Guard: ensure new_parent_id is not a descendant of id
        if let Some(npid) = new_parent_id {
            let mut current: Option<String> = Some(npid.to_string());
            while let Some(cur) = current {
                let parent: Option<String> = conn.query_row(
                    "SELECT parent_id FROM folders WHERE id = ?1",
                    params![cur],
                    |row| row.get(0),
                ).unwrap_or(None);
                if let Some(ref p) = parent {
                    if p.as_str() == id {
                        return Err(anyhow::anyhow!("Cannot move folder into its own descendant"));
                    }
                }
                current = parent;
            }
        }
        conn.execute(
            "UPDATE folders SET parent_id = ?1, updated_at = ?2 WHERE id = ?3",
            params![new_parent_id, now(), id],
        )?;
        Ok(())
    }

    pub fn delete_folder_recursive(&self, id: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        let mut all_ids: Vec<String> = Vec::new();
        let mut queue: std::collections::VecDeque<String> = std::collections::VecDeque::from([id.to_string()]);
        let mut child_stmt = conn.prepare("SELECT id FROM folders WHERE parent_id = ?1")?;
        while let Some(current) = queue.pop_front() {
            all_ids.push(current.clone());
            let children: Vec<String> = child_stmt.query_map(params![current], |row| row.get::<_, String>(0))?
                .filter_map(|r| r.ok())
                .collect();
            queue.extend(children);
        }
        // Wrap deletes in a transaction for atomicity
        let tx = conn.unchecked_transaction()?;
        // Delete meeting associations first (in case FK cascade is not active)
        for fid in &all_ids {
            tx.execute("DELETE FROM meeting_folders WHERE folder_id = ?1", params![fid])?;
        }
        // Delete folders in reverse order (children before parents)
        for fid in all_ids.iter().rev() {
            tx.execute("DELETE FROM folders WHERE id = ?1", params![fid])?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn get_meeting_folders(&self, meeting_id: &str) -> Result<Vec<Folder>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT f.id, f.name, f.color, f.icon, f.sort_order, f.parent_id,
                    COUNT(mf2.meeting_id) as meeting_count,
                    f.created_at, f.updated_at
             FROM folders f
             JOIN meeting_folders mf ON mf.folder_id = f.id AND mf.meeting_id = ?1
             LEFT JOIN meeting_folders mf2 ON mf2.folder_id = f.id
             GROUP BY f.id"
        )?;
        let rows = stmt.query_map(params![meeting_id], |row| {
            Ok(Folder {
                id: row.get(0)?,
                name: row.get(1)?,
                color: row.get(2)?,
                icon: row.get(3)?,
                sort_order: row.get(4)?,
                parent_id: row.get(5)?,
                meeting_count: row.get(6)?,
                created_at: row.get(7)?,
                updated_at: row.get(8)?,
            })
        })?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub fn get_meetings_in_folder(&self, folder_id: &str) -> Result<Vec<Meeting>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT m.id, m.title, m.scheduled_start, m.scheduled_end, m.actual_start, m.actual_end,
                    m.calendar_event_id, m.attendees, m.location, m.meeting_url, m.platform, m.status,
                    m.is_pinned, m.is_archived, m.deleted_at, m.created_at, m.updated_at,
                    m.device_name, m.system_audio_captured
             FROM meetings m
             JOIN meeting_folders mf ON mf.meeting_id = m.id AND mf.folder_id = ?1
             WHERE m.deleted_at IS NULL
             ORDER BY COALESCE(m.scheduled_start, m.created_at) DESC"
        )?;
        let rows = stmt.query_map(params![folder_id], map_meeting_row)?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    // --- Tag Queries ---

    pub fn create_tag(&self, name: &str, source: &str) -> Result<Tag> {
        let conn = self.conn.lock().unwrap();
        let id = new_id();
        let now = now();
        conn.execute(
            "INSERT OR IGNORE INTO tags (id, name, source, created_at) VALUES (?1, ?2, ?3, ?4)",
            params![id, name, source, now],
        )?;
        // OR IGNORE means the name may already exist with a DIFFERENT id —
        // returning the id we just rolled would hand callers a phantom row
        // (QA audit P3: two quick notes racing the voice-note tag's first
        // creation FK-failed the loser). Read back whichever row won.
        conn.query_row(
            "SELECT id, name, source, created_at FROM tags WHERE name = ?1",
            params![name],
            |row| {
                Ok(Tag {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    source: row.get(2)?,
                    created_at: row.get(3)?,
                })
            },
        )
        .map_err(Into::into)
    }

    pub fn list_tags(&self) -> Result<Vec<Tag>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, name, source, created_at FROM tags ORDER BY name ASC"
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(Tag {
                id: row.get(0)?,
                name: row.get(1)?,
                source: row.get(2)?,
                created_at: row.get(3)?,
            })
        })?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub fn add_tag_to_meeting(&self, meeting_id: &str, tag_id: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT OR IGNORE INTO meeting_tags (meeting_id, tag_id) VALUES (?1, ?2)",
            params![meeting_id, tag_id],
        )?;
        Ok(())
    }

    pub fn remove_tag_from_meeting(&self, meeting_id: &str, tag_id: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM meeting_tags WHERE meeting_id = ?1 AND tag_id = ?2",
            params![meeting_id, tag_id],
        )?;
        Ok(())
    }

    pub fn delete_tag(&self, id: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM meeting_tags WHERE tag_id = ?1", params![id])?;
        conn.execute("DELETE FROM tags WHERE id = ?1", params![id])?;
        Ok(())
    }

    pub fn get_meeting_tags(&self, meeting_id: &str) -> Result<Vec<Tag>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT t.id, t.name, t.source, t.created_at
             FROM tags t
             JOIN meeting_tags mt ON mt.tag_id = t.id
             WHERE mt.meeting_id = ?1
             ORDER BY t.name ASC"
        )?;
        let rows = stmt.query_map(params![meeting_id], |row| {
            Ok(Tag {
                id: row.get(0)?,
                name: row.get(1)?,
                source: row.get(2)?,
                created_at: row.get(3)?,
            })
        })?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    /// Tags for many meetings at once — the list view uses this instead of
    /// one `get_meeting_tags` round-trip per row. Meetings without tags are
    /// absent from the map.
    pub fn get_tags_for_meetings(
        &self,
        meeting_ids: &[String],
    ) -> Result<std::collections::HashMap<String, Vec<Tag>>> {
        let mut map: std::collections::HashMap<String, Vec<Tag>> =
            std::collections::HashMap::new();
        if meeting_ids.is_empty() {
            return Ok(map);
        }
        let conn = self.conn.lock().unwrap();
        // Chunked to stay well under SQLite's bound-parameter limit.
        for chunk in meeting_ids.chunks(500) {
            let placeholders = vec!["?"; chunk.len()].join(",");
            let sql = format!(
                "SELECT mt.meeting_id, t.id, t.name, t.source, t.created_at
                 FROM tags t
                 JOIN meeting_tags mt ON mt.tag_id = t.id
                 WHERE mt.meeting_id IN ({placeholders})
                 ORDER BY t.name ASC"
            );
            let mut stmt = conn.prepare(&sql)?;
            let rows = stmt.query_map(rusqlite::params_from_iter(chunk), |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    Tag {
                        id: row.get(1)?,
                        name: row.get(2)?,
                        source: row.get(3)?,
                        created_at: row.get(4)?,
                    },
                ))
            })?;
            for row in rows {
                let (meeting_id, tag) = row?;
                map.entry(meeting_id).or_default().push(tag);
            }
        }
        Ok(map)
    }

    // --- Settings Queries ---

    pub fn get_setting(&self, key: &str) -> Result<Option<String>> {
        let conn = self.conn.lock().unwrap();
        let result = conn.query_row(
            "SELECT value FROM settings WHERE key = ?1",
            params![key],
            |row| row.get(0),
        );
        match result {
            Ok(val) => Ok(Some(val)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    pub fn delete_setting(&self, key: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM settings WHERE key = ?1", params![key])?;
        Ok(())
    }

    pub fn set_setting(&self, key: &str, value: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
        Ok(())
    }

    // --- Search ---

    pub fn search_transcripts(&self, query: &str, limit: usize) -> Result<Vec<String>> {
        let fts_query = sanitize_fts_query(query);
        if fts_query.is_empty() {
            return Ok(Vec::new());
        }
        let conn = self.conn.lock().unwrap();
        // The CTE scores each matching segment; the outer GROUP BY collapses
        // to one row per meeting ranked by its best segment. MATERIALIZED is
        // load-bearing: flattened into the aggregate query, bm25() loses its
        // FTS context and SQLite errors with "unable to use function bm25".
        let mut stmt = conn.prepare(
            "WITH hits AS MATERIALIZED (
                 SELECT ts.meeting_id AS meeting_id, bm25(segments_fts) AS r
                 FROM segments_fts
                 JOIN transcript_segments ts ON ts.id = segments_fts.rowid
                 WHERE segments_fts MATCH ?1
             )
             SELECT meeting_id
             FROM hits
             GROUP BY meeting_id
             ORDER BY MIN(r)
             LIMIT ?2"
        )?;
        let rows = stmt.query_map(params![fts_query, limit], |row| {
            row.get::<_, String>(0)
        })?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    /// Per-term monthly distinct-meeting counts for topic trackers
    /// (plan v6 item 13). Months are "YYYY-MM"; only meetings dated on or
    /// after `since` (an ISO date, normally the first of the window's
    /// oldest month) are counted. Terms that sanitize to nothing are
    /// returned with no counts rather than dropped, so the UI can still
    /// render the tracker row.
    pub fn topic_trend_counts(&self, terms: &[String], since: &str) -> Result<Vec<TopicTrend>> {
        let conn = self.conn.lock().unwrap();
        let mut out = Vec::with_capacity(terms.len());
        for term in terms {
            let fts_query = sanitize_fts_query(term);
            let mut counts: Vec<TopicMonthCount> = Vec::new();
            if !fts_query.is_empty() {
                let mut stmt = conn.prepare(
                    "SELECT substr(COALESCE(m.actual_start, m.scheduled_start, m.created_at), 1, 7) AS month,
                            COUNT(DISTINCT m.id)
                     FROM segments_fts
                     JOIN transcript_segments ts ON ts.id = segments_fts.rowid
                     JOIN meetings m ON m.id = ts.meeting_id
                     WHERE segments_fts MATCH ?1
                       AND m.deleted_at IS NULL
                       AND COALESCE(m.actual_start, m.scheduled_start, m.created_at) >= ?2
                     GROUP BY month
                     ORDER BY month",
                )?;
                let rows = stmt.query_map(params![fts_query, since], |row| {
                    Ok(TopicMonthCount {
                        month: row.get(0)?,
                        meetings: row.get(1)?,
                    })
                })?;
                counts = rows.filter_map(|r| r.ok()).collect();
            }
            out.push(TopicTrend { term: term.clone(), counts });
        }
        Ok(out)
    }

    // --- Insights cache + monthly narrative facts (plan v6 item 14) ---

    pub fn upsert_insight(&self, key: &str, content: &str, facts: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO insights_cache (key, content, facts, created_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(key) DO UPDATE SET
               content = excluded.content,
               facts = excluded.facts,
               created_at = excluded.created_at",
            params![key, content, facts, now()],
        )?;
        Ok(())
    }

    pub fn get_insight(&self, key: &str) -> Result<Option<CachedInsight>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT key, content, facts, created_at FROM insights_cache WHERE key = ?1",
        )?;
        let mut rows = stmt.query_map(params![key], |row| {
            Ok(CachedInsight {
                key: row.get(0)?,
                content: row.get(1)?,
                facts: row.get(2)?,
                created_at: row.get(3)?,
            })
        })?;
        Ok(rows.next().transpose()?)
    }

    /// Aggregate facts for one calendar month ("YYYY-MM") — counts, hours,
    /// and titles ONLY. This JSON is the entirety of what a narrative
    /// generation shares with the AI provider: no transcripts, no note
    /// bodies, no attendee data.
    pub fn narrative_facts(&self, month: &str) -> Result<serde_json::Value> {
        let prev = prev_month(month);
        let meetings = self.list_meetings()?;

        let in_month = |m: &Meeting, target: &str| {
            m.status == "complete" && meeting_sort_date(m).starts_with(target)
        };
        let month_meetings: Vec<&Meeting> =
            meetings.iter().filter(|m| in_month(m, month)).collect();
        let prev_meetings: Vec<&Meeting> =
            meetings.iter().filter(|m| in_month(m, &prev)).collect();

        let hours = |ms: &[&Meeting]| total_hours(ms);

        // Busiest week: complete meetings bucketed by their Monday.
        let busiest_week = busiest_week_of(&month_meetings);

        // Recurring series this month (≥2 instances), by normalized title.
        let top_series = recurring_series(&month_meetings, 2, 3);

        // Tasks captured in the month's meetings; done/open from today's state.
        let items = self.list_action_items()?;
        let month_items: Vec<_> = items
            .iter()
            .filter(|i| i.meeting_date.as_deref().is_some_and(|d| d.starts_with(month)))
            .collect();
        let done = month_items.iter().filter(|i| i.done).count();
        let dropped = month_items.iter().filter(|i| i.dropped).count();

        // Topic trackers, this month vs last.
        let terms: Vec<String> = self
            .get_setting("topic_trackers")?
            .unwrap_or_default()
            .split(',')
            .map(|t| t.trim().to_string())
            .filter(|t| !t.is_empty())
            .take(8)
            .collect();
        let mut topics = Vec::new();
        if !terms.is_empty() {
            for t in self.topic_trend_counts(&terms, &format!("{prev}-01"))? {
                let count_for = |mo: &str| {
                    t.counts.iter().find(|c| c.month == mo).map(|c| c.meetings).unwrap_or(0)
                };
                let (cur_n, prev_n) = (count_for(month), count_for(&prev));
                if cur_n > 0 || prev_n > 0 {
                    topics.push(serde_json::json!({
                        "term": t.term, "meetings": cur_n, "prev_month": prev_n
                    }));
                }
            }
        }

        Ok(serde_json::json!({
            "month": month,
            "meetings": month_meetings.len(),
            "hours": hours(&month_meetings),
            "prev_month": { "month": prev, "meetings": prev_meetings.len(), "hours": hours(&prev_meetings) },
            "busiest_week": busiest_week,
            "recurring_series": top_series
                .into_iter()
                .map(|(title, n)| serde_json::json!({ "title": title, "meetings": n }))
                .collect::<Vec<_>>(),
            "tasks": {
                "captured": month_items.len(),
                "done": done,
                "still_open": month_items.len().saturating_sub(done + dropped),
            },
            "topics": topics,
        }))
    }

    /// Aggregate facts for an arbitrary [`from`, `to`) window (ISO dates,
    /// `to` exclusive) — the quarter/year sibling of `narrative_facts`
    /// (plan v9 item 14). The privacy contract is identical and absolute:
    /// counts, hours, and titles ONLY — no transcripts, no note bodies, no
    /// attendee data. Adds per-month buckets so a longer narrative can
    /// describe the arc of the period instead of one blurred total.
    pub fn narrative_facts_range(
        &self,
        label: &str,
        from: &str,
        to: &str,
    ) -> Result<serde_json::Value> {
        let meetings = self.list_meetings()?;
        let range_meetings: Vec<&Meeting> = meetings
            .iter()
            .filter(|m| {
                let d = meeting_sort_date(m);
                m.status == "complete" && d.as_str() >= from && d.as_str() < to
            })
            .collect();

        // Month buckets, clamped to months that have begun — zeros for the
        // future would read as a collapse instead of a period in progress.
        let current_month = chrono::Utc::now().format("%Y-%m").to_string();
        let mut months = months_in_range(from, to);
        months.retain(|mo| mo.as_str() <= current_month.as_str());
        let by_month: Vec<serde_json::Value> = months
            .iter()
            .map(|mo| {
                let ms: Vec<&Meeting> = range_meetings
                    .iter()
                    .copied()
                    .filter(|m| meeting_sort_date(m).starts_with(mo.as_str()))
                    .collect();
                serde_json::json!({ "month": mo, "meetings": ms.len(), "hours": total_hours(&ms) })
            })
            .collect();

        // Tasks captured in the window's meetings; done/open from today's state.
        let items = self.list_action_items()?;
        let range_items: Vec<_> = items
            .iter()
            .filter(|i| i.meeting_date.as_deref().is_some_and(|d| d >= from && d < to))
            .collect();
        let done = range_items.iter().filter(|i| i.done).count();
        let dropped = range_items.iter().filter(|i| i.dropped).count();

        // Topic trackers: window total + per-month counts (term names are
        // user-typed settings, never derived from content).
        let terms: Vec<String> = self
            .get_setting("topic_trackers")?
            .unwrap_or_default()
            .split(',')
            .map(|t| t.trim().to_string())
            .filter(|t| !t.is_empty())
            .take(8)
            .collect();
        let mut topics = Vec::new();
        if !terms.is_empty() && !months.is_empty() {
            for t in self.topic_trend_counts(&terms, from)? {
                let in_window: Vec<&TopicMonthCount> =
                    t.counts.iter().filter(|c| months.contains(&c.month)).collect();
                let total: i64 = in_window.iter().map(|c| c.meetings).sum();
                if total > 0 {
                    topics.push(serde_json::json!({
                        "term": t.term,
                        "meetings": total,
                        "by_month": in_window
                            .iter()
                            .map(|c| serde_json::json!({ "month": c.month, "meetings": c.meetings }))
                            .collect::<Vec<_>>(),
                    }));
                }
            }
        }

        Ok(serde_json::json!({
            "period": label,
            "from": from,
            "to": to,
            "meetings": range_meetings.len(),
            "hours": total_hours(&range_meetings),
            "by_month": by_month,
            "busiest_week": busiest_week_of(&range_meetings),
            // A series is "sustained" over a long window at ≥3 instances;
            // title exclusions identical to the monthly path.
            "recurring_series": recurring_series(&range_meetings, 3, 5)
                .into_iter()
                .map(|(title, n)| serde_json::json!({ "title": title, "meetings": n }))
                .collect::<Vec<_>>(),
            "tasks": {
                "captured": range_items.len(),
                "done": done,
                "still_open": range_items.len().saturating_sub(done + dropped),
            },
            "topics": topics,
        }))
    }

    /// Deterministic brag-doc markdown for a [`from`, `to`) window — plan v9
    /// item 14's "Crunched" retention moment. NO AI anywhere: every line is a
    /// fact the user created (completed tasks, meeting counts, sustained
    /// series, tracked topics). Dropped items are excluded everywhere; a
    /// snooze never hides a completed item.
    pub fn build_brag_doc(&self, period: &str, from: &str, to: &str) -> Result<String> {
        let meetings = self.list_meetings()?;
        let range_meetings: Vec<&Meeting> = meetings
            .iter()
            .filter(|m| {
                let d = meeting_sort_date(m);
                m.status == "complete" && d.as_str() >= from && d.as_str() < to
            })
            .collect();
        let series = recurring_series(&range_meetings, 3, 5);

        // One accomplishment per (meeting, task text): notes often carry the
        // same item in both the raw and AI-enhanced bodies. When the copies
        // disagree, a done copy wins the dedupe.
        let items = self.list_action_items()?;
        let mut captured: Vec<&ActionItem> = items
            .iter()
            .filter(|i| {
                !i.dropped
                    && !i.task.trim().is_empty()
                    && i.meeting_date.as_deref().is_some_and(|d| d >= from && d < to)
            })
            .collect();
        captured.sort_by(|a, b| {
            a.meeting_date
                .cmp(&b.meeting_date)
                .then(b.done.cmp(&a.done))
                .then(a.index.cmp(&b.index))
        });
        let mut seen: std::collections::HashSet<(String, String)> =
            std::collections::HashSet::new();
        captured.retain(|i| seen.insert((i.meeting_id.clone(), i.task.trim().to_lowercase())));
        let done_items: Vec<&&ActionItem> = captured.iter().filter(|i| i.done).collect();

        // Topics that grew: first vs last begun month of the window.
        let current_month = chrono::Utc::now().format("%Y-%m").to_string();
        let mut months = months_in_range(from, to);
        months.retain(|mo| mo.as_str() <= current_month.as_str());
        let terms: Vec<String> = self
            .get_setting("topic_trackers")?
            .unwrap_or_default()
            .split(',')
            .map(|t| t.trim().to_string())
            .filter(|t| !t.is_empty())
            .take(8)
            .collect();
        let mut grown: Vec<String> = Vec::new();
        if !terms.is_empty() && months.len() >= 2 {
            let (first_mo, last_mo) = (months[0].clone(), months[months.len() - 1].clone());
            for t in self.topic_trend_counts(&terms, from)? {
                let count_for = |mo: &str| {
                    t.counts.iter().find(|c| c.month == mo).map(|c| c.meetings).unwrap_or(0)
                };
                let (a, b) = (count_for(&first_mo), count_for(&last_mo));
                if b > a && b >= 2 {
                    grown.push(format!(
                        "{} ({} meeting{} in {} → {} in {})",
                        t.term,
                        a,
                        if a == 1 { "" } else { "s" },
                        month_display(&first_mo),
                        b,
                        month_display(&last_mo),
                    ));
                }
            }
        }

        let total_h = total_hours(&range_meetings);
        let mut doc = String::new();
        doc.push_str(&format!("# Brag doc — {}\n\n", period_display(period)));
        doc.push_str(&format!(
            "Generated by Perchnote on {} from your own meeting notes, on this Mac. \
             Counts, titles, and tasks you checked off — nothing here is AI-written.\n\n",
            chrono::Local::now().format("%B %-d, %Y")
        ));

        doc.push_str("## At a glance\n\n");
        doc.push_str(&format!(
            "- {} meeting{} ({} hour{})\n",
            range_meetings.len(),
            if range_meetings.len() == 1 { "" } else { "s" },
            fmt_hours_md(total_h),
            if total_h == 1.0 { "" } else { "s" },
        ));
        doc.push_str(&format!(
            "- {} of {} captured action item{} completed\n",
            done_items.len(),
            captured.len(),
            if captured.len() == 1 { "" } else { "s" },
        ));
        if !series.is_empty() {
            doc.push_str(&format!(
                "- Series sustained: {}\n",
                series
                    .iter()
                    .map(|(t, n)| format!("{t} ({n} meetings)"))
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
        }
        if !grown.is_empty() {
            doc.push_str(&format!("- Topics that grew: {}\n", grown.join(", ")));
        }

        doc.push_str("\n## Completed items\n\n");
        if done_items.is_empty() {
            doc.push_str(
                "Nothing checked off in this period yet — tasks you complete in \
                 your meeting notes will land here.\n",
            );
        } else {
            let mut by_month_items: std::collections::BTreeMap<String, Vec<&&ActionItem>> =
                std::collections::BTreeMap::new();
            for i in &done_items {
                let mo = i
                    .meeting_date
                    .as_deref()
                    .and_then(|d| d.get(0..7))
                    .unwrap_or("")
                    .to_string();
                by_month_items.entry(mo).or_default().push(i);
            }
            for (mo, list) in by_month_items {
                doc.push_str(&format!("### {}\n\n", month_display(&mo)));
                for i in list {
                    doc.push_str(&format!(
                        "- [x] {} — {} ({})\n",
                        i.task.trim(),
                        i.meeting_title,
                        short_date(i.meeting_date.as_deref().unwrap_or("")),
                    ));
                }
                doc.push('\n');
            }
        }

        Ok(doc.trim_end().to_string() + "\n")
    }

    /// Unified search across meeting titles, transcript content, and note content.
    /// Returns meeting IDs with the source of the match. A meeting may yield
    /// up to one row PER ARM (title + transcript + notes) — the palette
    /// groups rows by meeting, so a meeting matched in several places shows
    /// all of them (plan v8 A3 v2). Callers that want one-per-meeting dedupe
    /// on meeting_id (chat retrieval and NotesList already do).
    ///
    /// Supports the filter grammar (plan v8 A2): `speaker:` / `before:` /
    /// `after:` / `folder:` plus quoted phrases and trailing-`*` prefix —
    /// see `searchgrammar`. Filters refine a text search; a filters-only
    /// query (no search terms) returns nothing. A `speaker:` filter limits
    /// results to transcript hits — titles and notes aren't attributable
    /// to a speaker.
    pub fn search_all(&self, query: &str, limit: usize) -> Result<Vec<SearchResult>> {
        let parsed = crate::db::searchgrammar::parse_search_query(query);
        if parsed.has_filters() && parsed.fts.is_empty() {
            return Ok(Vec::new());
        }
        // What LIKE arms and snippets center on: the de-filtered query text
        // when the grammar consumed anything, the raw query otherwise (so
        // punctuation-only searches behave exactly as before).
        let needle = if parsed.plain_text.is_empty() {
            query.to_string()
        } else {
            parsed.plain_text.clone()
        };
        // Meeting-level filter fragment shared by all arms. Dates compare
        // lexicographically against ISO-8601 — `< 'YYYY-MM-DD'` excludes
        // that day (any timestamp on it sorts after the bare date), and
        // `>= 'YYYY-MM-DD'` includes it.
        let mut meeting_clauses = String::new();
        let mut meeting_binds: Vec<String> = Vec::new();
        if let Some(before) = &parsed.before {
            meeting_clauses
                .push_str(" AND COALESCE(m.actual_start, m.scheduled_start, m.created_at) < ?");
            meeting_binds.push(before.clone());
        }
        if let Some(after) = &parsed.after {
            meeting_clauses
                .push_str(" AND COALESCE(m.actual_start, m.scheduled_start, m.created_at) >= ?");
            meeting_binds.push(after.clone());
        }
        if let Some(folder) = &parsed.folder {
            meeting_clauses.push_str(
                " AND EXISTS (SELECT 1 FROM meeting_folders mf \
                   JOIN folders f ON f.id = mf.folder_id \
                   WHERE mf.meeting_id = m.id \
                     AND lower(f.name) LIKE '%' || ? || '%' ESCAPE '\\')",
            );
            meeting_binds.push(crate::db::searchgrammar::escape_like(folder));
        }

        let conn = self.conn.lock().unwrap();
        // escape_like keeps a typed % or _ literal (LIKE is already
        // ASCII-case-insensitive, which the lowercase needle relies on).
        let like_query = format!("%{}%", crate::db::searchgrammar::escape_like(&needle));
        let mut results: Vec<SearchResult> = Vec::new();

        // 1. Search meeting titles (LIKE)
        if parsed.speaker.is_none() {
            let sql = format!(
                "SELECT m.id, m.title FROM meetings m
                 WHERE m.deleted_at IS NULL AND m.title LIKE ? ESCAPE '\\'{meeting_clauses}
                 LIMIT ?"
            );
            let mut stmt = conn.prepare(&sql)?;
            let binds: Vec<&dyn rusqlite::types::ToSql> = std::iter::once(&like_query as _)
                .chain(meeting_binds.iter().map(|b| b as _))
                .chain(std::iter::once(&limit as _))
                .collect();
            let rows = stmt.query_map(&binds[..], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?;
            for row in rows.flatten() {
                results.push(SearchResult {
                    meeting_id: row.0,
                    match_source: "title".to_string(),
                    snippet: row.1,
                    match_start_ms: None,
                });
            }
        }

        // 2. Search transcripts — per-segment FTS (plan v8 A1). The CTE
        //    scores every matching segment; the outer GROUP BY keeps one
        //    row per meeting, and SQLite's bare-column rule pins text and
        //    start_ms to the MIN(r) row, i.e. that meeting's best-ranked
        //    segment. The snippet is the actual matched segment, not the
        //    old first-token guess. MATERIALIZED is load-bearing: flattened
        //    into the aggregate query, bm25() loses its FTS context and
        //    SQLite errors with "unable to use function bm25".
        if !parsed.fts.is_empty() {
            // `speaker:` matches the meeting-scoped diarization label
            // (contains, case-insensitive) or the raw segment key
            // ("Speaker 1") exactly — never ICS attendees.
            let speaker_clause = if parsed.speaker.is_some() {
                " AND (lower(ts.speaker_key) = ? OR EXISTS (
                     SELECT 1 FROM speaker_labels sl
                     WHERE sl.meeting_id = ts.meeting_id
                       AND sl.speaker_key = ts.speaker_key
                       AND lower(sl.display_name) LIKE '%' || ? || '%' ESCAPE '\\'))"
            } else {
                ""
            };
            let sql = format!(
                "WITH hits AS MATERIALIZED (
                     SELECT ts.meeting_id AS meeting_id,
                            ts.text       AS seg_text,
                            ts.start_ms   AS start_ms,
                            bm25(segments_fts) AS r
                     FROM segments_fts
                     JOIN transcript_segments ts ON ts.id = segments_fts.rowid
                     JOIN meetings m ON m.id = ts.meeting_id
                     WHERE segments_fts MATCH ? AND m.deleted_at IS NULL\
                     {speaker_clause}{meeting_clauses}
                 )
                 SELECT meeting_id, seg_text, start_ms, MIN(r)
                 FROM hits
                 GROUP BY meeting_id
                 ORDER BY MIN(r)
                 LIMIT ?"
            );
            let speaker_binds: Vec<String> = parsed
                .speaker
                .iter()
                .flat_map(|s| [s.clone(), crate::db::searchgrammar::escape_like(s)])
                .collect();
            let mut stmt = conn.prepare(&sql)?;
            let binds: Vec<&dyn rusqlite::types::ToSql> = std::iter::once(&parsed.fts as _)
                .chain(speaker_binds.iter().map(|b| b as _))
                .chain(meeting_binds.iter().map(|b| b as _))
                .chain(std::iter::once(&limit as _))
                .collect();
            let rows = stmt.query_map(&binds[..], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<i64>>(2)?,
                ))
            });
            if let Err(e) = &rows {
                log::error!("transcript FTS arm failed: {}", e);
            }
            if let Ok(rows) = rows {
                for (meeting_id, seg_text, start_ms) in rows.flatten() {
                    results.push(SearchResult {
                        meeting_id,
                        match_source: "transcript".to_string(),
                        snippet: extract_snippet(&seg_text, &needle, 80),
                        match_start_ms: start_ms.and_then(|v| u64::try_from(v).ok()),
                    });
                }
            }
        }

        // 3. Search notes raw_content and generated_content. Notes are stored
        //    as TipTap JSON, so a SQL LIKE over the raw column matches
        //    structural tokens ("task", "heading", "true", "level") in every
        //    note and can leak raw JSON into snippets. Instead, extract the
        //    visible text in Rust and match on that (plan v8 A6).
        if parsed.speaker.is_none() {
            let lower_query = needle.to_lowercase();
            let sql = format!(
                "SELECT n.meeting_id, n.raw_content, n.generated_content
                 FROM notes n
                 JOIN meetings m ON m.id = n.meeting_id
                 WHERE m.deleted_at IS NULL
                   AND (n.raw_content IS NOT NULL OR n.generated_content IS NOT NULL)\
                   {meeting_clauses}"
            );
            let mut stmt = conn.prepare(&sql)?;
            let binds: Vec<&dyn rusqlite::types::ToSql> =
                meeting_binds.iter().map(|b| b as _).collect();
            let rows = stmt.query_map(&binds[..], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            })?;
            // A meeting can have several note rows — one "notes" result each
            // is noise, so dedupe within this arm only.
            let mut noted: std::collections::HashSet<String> = std::collections::HashSet::new();
            for (meeting_id, raw, generated) in rows.flatten() {
                if results.len() >= limit {
                    break;
                }
                if noted.contains(&meeting_id) {
                    continue;
                }
                // Prefer generated content (the old COALESCE order) and stop
                // at the first field whose visible text matches.
                let matched_text = [generated, raw].into_iter().flatten().find_map(|json| {
                    let text = plain_text_of_tiptap(&json);
                    text.to_lowercase().contains(&lower_query).then_some(text)
                });
                if let Some(text) = matched_text {
                    noted.insert(meeting_id.clone());
                    results.push(SearchResult {
                        meeting_id,
                        match_source: "notes".to_string(),
                        match_start_ms: None,
                        snippet: extract_snippet(&text, &needle, 80),
                    });
                }
            }
        }

        results.truncate(limit);
        Ok(results)
    }

    /// Segment-level retrieval for Ask AI (plan v8 A5): the bm25-best
    /// segments matching ANY question term, across all live meetings. The
    /// question is sanitized like `sanitize_fts_query` (it is not grammar
    /// input), then OR-joined for recall. Non-aggregating on purpose —
    /// bm25() in a plain ORDER BY keeps its FTS context, so no MATERIALIZED
    /// CTE is needed here.
    pub fn search_segments(&self, question: &str, limit: usize) -> Result<Vec<SegmentHit>> {
        let fts_query = sanitize_fts_query_any(question);
        if fts_query.is_empty() {
            return Ok(Vec::new());
        }
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT ts.transcript_id, ts.meeting_id, ts.seg_idx, ts.speaker_key, ts.start_ms, ts.text
             FROM segments_fts
             JOIN transcript_segments ts ON ts.id = segments_fts.rowid
             JOIN meetings m ON m.id = ts.meeting_id
             WHERE segments_fts MATCH ?1 AND m.deleted_at IS NULL
             ORDER BY bm25(segments_fts)
             LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![fts_query, limit], map_segment_hit_row)?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    /// `search_segments` with the question's typed filters applied
    /// (plan v9 #7): meeting-level scoping (before:/after:/folder:) plus
    /// segment-level speaker: — same clause semantics as `search_all`,
    /// duplicated deliberately rather than refactoring the audited
    /// original. `question_terms` is the de-filtered question text.
    pub fn search_segments_scoped(
        &self,
        question_terms: &str,
        parsed: &crate::db::searchgrammar::ParsedQuery,
        limit: usize,
    ) -> Result<Vec<SegmentHit>> {
        let fts_query = sanitize_fts_query_any(question_terms);
        if fts_query.is_empty() {
            return Ok(Vec::new());
        }
        let mut clauses = String::new();
        let mut binds: Vec<String> = Vec::new();
        if parsed.speaker.is_some() {
            clauses.push_str(
                " AND (lower(ts.speaker_key) = ? OR EXISTS (
                     SELECT 1 FROM speaker_labels sl
                     WHERE sl.meeting_id = ts.meeting_id
                       AND sl.speaker_key = ts.speaker_key
                       AND lower(sl.display_name) LIKE '%' || ? || '%' ESCAPE '\\'))",
            );
            let s = parsed.speaker.as_ref().unwrap();
            binds.push(s.clone());
            binds.push(crate::db::searchgrammar::escape_like(s));
        }
        if let Some(before) = &parsed.before {
            clauses.push_str(" AND COALESCE(m.actual_start, m.scheduled_start, m.created_at) < ?");
            binds.push(before.clone());
        }
        if let Some(after) = &parsed.after {
            clauses.push_str(" AND COALESCE(m.actual_start, m.scheduled_start, m.created_at) >= ?");
            binds.push(after.clone());
        }
        if let Some(folder) = &parsed.folder {
            clauses.push_str(
                " AND EXISTS (SELECT 1 FROM meeting_folders mf \
                   JOIN folders f ON f.id = mf.folder_id \
                   WHERE mf.meeting_id = m.id \
                     AND lower(f.name) LIKE '%' || ? || '%' ESCAPE '\\')",
            );
            binds.push(crate::db::searchgrammar::escape_like(folder));
        }
        let sql = format!(
            "SELECT ts.transcript_id, ts.meeting_id, ts.seg_idx, ts.speaker_key, ts.start_ms, ts.text
             FROM segments_fts
             JOIN transcript_segments ts ON ts.id = segments_fts.rowid
             JOIN meetings m ON m.id = ts.meeting_id
             WHERE segments_fts MATCH ? AND m.deleted_at IS NULL{clauses}
             ORDER BY bm25(segments_fts)
             LIMIT ?"
        );
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(&sql)?;
        let all_binds: Vec<&dyn rusqlite::types::ToSql> = std::iter::once(&fts_query as _)
            .chain(binds.iter().map(|b| b as _))
            .chain(std::iter::once(&limit as _))
            .collect();
        let rows = stmt.query_map(&all_binds[..], map_segment_hit_row)?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    /// Live meeting ids passing a parsed query's filters — the scope set
    /// for retrieval arms that can't filter in SQL (vec hits, recency
    /// fallback). speaker: means "this person spoke there" at meeting
    /// granularity here; the FTS arm applies it per segment.
    pub fn meetings_matching_filters(
        &self,
        parsed: &crate::db::searchgrammar::ParsedQuery,
    ) -> Result<std::collections::HashSet<String>> {
        let mut clauses = String::new();
        let mut binds: Vec<String> = Vec::new();
        if let Some(speaker) = &parsed.speaker {
            clauses.push_str(
                " AND EXISTS (SELECT 1 FROM transcript_segments ts
                     WHERE ts.meeting_id = m.id
                       AND (lower(ts.speaker_key) = ? OR EXISTS (
                            SELECT 1 FROM speaker_labels sl
                            WHERE sl.meeting_id = ts.meeting_id
                              AND sl.speaker_key = ts.speaker_key
                              AND lower(sl.display_name) LIKE '%' || ? || '%' ESCAPE '\\')))",
            );
            binds.push(speaker.clone());
            binds.push(crate::db::searchgrammar::escape_like(speaker));
        }
        if let Some(before) = &parsed.before {
            clauses.push_str(" AND COALESCE(m.actual_start, m.scheduled_start, m.created_at) < ?");
            binds.push(before.clone());
        }
        if let Some(after) = &parsed.after {
            clauses.push_str(" AND COALESCE(m.actual_start, m.scheduled_start, m.created_at) >= ?");
            binds.push(after.clone());
        }
        if let Some(folder) = &parsed.folder {
            clauses.push_str(
                " AND EXISTS (SELECT 1 FROM meeting_folders mf \
                   JOIN folders f ON f.id = mf.folder_id \
                   WHERE mf.meeting_id = m.id \
                     AND lower(f.name) LIKE '%' || ? || '%' ESCAPE '\\')",
            );
            binds.push(crate::db::searchgrammar::escape_like(folder));
        }
        let sql = format!("SELECT m.id FROM meetings m WHERE m.deleted_at IS NULL{clauses}");
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(&sql)?;
        let all_binds: Vec<&dyn rusqlite::types::ToSql> = binds.iter().map(|b| b as _).collect();
        let rows = stmt.query_map(&all_binds[..], |r| r.get::<_, String>(0))?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    /// All segments of one transcript with seg_idx in [lo, hi], in
    /// chronological order — the ±N neighbor expansion around a retrieval
    /// hit. Soft-deleted meetings yield nothing (vec hits aren't pre-filtered
    /// the way FTS hits are).
    pub fn segments_in_range(&self, transcript_id: &str, lo: i64, hi: i64) -> Result<Vec<SegmentHit>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT ts.transcript_id, ts.meeting_id, ts.seg_idx, ts.speaker_key, ts.start_ms, ts.text
             FROM transcript_segments ts
             JOIN meetings m ON m.id = ts.meeting_id
             WHERE ts.transcript_id = ?1 AND ts.seg_idx BETWEEN ?2 AND ?3
               AND m.deleted_at IS NULL
             ORDER BY ts.seg_idx",
        )?;
        let rows = stmt.query_map(params![transcript_id, lo, hi], map_segment_hit_row)?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    // --- Speaker Label Queries ---

    /// Insert or update a speaker label for `(meeting_id, speaker_key)`.
    /// Labels are scoped to a meeting since migration 11 — the same
    /// `speaker_key` ("Speaker 1") in two different meetings is treated as
    /// two different people.
    pub fn upsert_speaker_label(
        &self,
        meeting_id: &str,
        speaker_key: &str,
        display_name: &str,
        color: Option<&str>,
        participant_type: Option<&str>,
    ) -> Result<SpeakerLabel> {
        let conn = self.conn.lock().unwrap();
        let now = now();
        let pt = participant_type.unwrap_or("in-room");
        let existing: Option<String> = conn
            .query_row(
                "SELECT id FROM speaker_labels WHERE meeting_id = ?1 AND speaker_key = ?2",
                params![meeting_id, speaker_key],
                |row| row.get(0),
            )
            .ok();

        let (id, created_at) = if let Some(id) = existing {
            conn.execute(
                "UPDATE speaker_labels SET display_name = ?1, color = ?2, participant_type = ?3 WHERE id = ?4",
                params![display_name, color, pt, id],
            )?;
            // Preserve original created_at on update.
            let created: String = conn
                .query_row("SELECT created_at FROM speaker_labels WHERE id = ?1", params![id], |r| r.get(0))
                .unwrap_or_else(|_| now.clone());
            (id, created)
        } else {
            let id = new_id();
            conn.execute(
                "INSERT INTO speaker_labels (id, meeting_id, speaker_key, display_name, color, participant_type, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![id, meeting_id, speaker_key, display_name, color, pt, now],
            )?;
            (id, now)
        };

        Ok(SpeakerLabel {
            id,
            meeting_id: Some(meeting_id.to_string()),
            speaker_key: speaker_key.to_string(),
            display_name: display_name.to_string(),
            color: color.map(String::from),
            participant_type: pt.to_string(),
            created_at,
        })
    }

    /// All speaker labels, including legacy rows with `meeting_id = NULL`
    /// from before migration 11. Used by the export pipeline so backups
    /// don't silently drop pre-migration labels.
    pub fn list_speaker_labels(&self) -> Result<Vec<SpeakerLabel>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, meeting_id, speaker_key, display_name, color, COALESCE(participant_type, 'in-room'), created_at
             FROM speaker_labels ORDER BY display_name ASC"
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(SpeakerLabel {
                id: row.get(0)?,
                meeting_id: row.get(1)?,
                speaker_key: row.get(2)?,
                display_name: row.get(3)?,
                color: row.get(4)?,
                participant_type: row.get(5)?,
                created_at: row.get(6)?,
            })
        })?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    /// Labels belonging to one specific meeting. Legacy NULL-meeting rows
    /// are excluded — those are only kept for export and never re-attached
    /// to a meeting since we can't tell which one they came from.
    pub fn list_speaker_labels_for_meeting(&self, meeting_id: &str) -> Result<Vec<SpeakerLabel>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, meeting_id, speaker_key, display_name, color, COALESCE(participant_type, 'in-room'), created_at
             FROM speaker_labels WHERE meeting_id = ?1 ORDER BY display_name ASC"
        )?;
        let rows = stmt.query_map(params![meeting_id], |row| {
            Ok(SpeakerLabel {
                id: row.get(0)?,
                meeting_id: row.get(1)?,
                speaker_key: row.get(2)?,
                display_name: row.get(3)?,
                color: row.get(4)?,
                participant_type: row.get(5)?,
                created_at: row.get(6)?,
            })
        })?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub fn delete_speaker_label(&self, id: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM speaker_labels WHERE id = ?1", params![id])?;
        Ok(())
    }

    // --- Voice Profile Queries ---

    pub fn create_voice_profile(&self, speaker_name: &str, sample_path: &str) -> Result<VoiceProfile> {
        let conn = self.conn.lock().unwrap();
        let id = new_id();
        let now = now();
        conn.execute(
            "INSERT INTO voice_profiles (id, speaker_name, sample_path, created_at)
             VALUES (?1, ?2, ?3, ?4)",
            params![id, speaker_name, sample_path, now],
        )?;
        Ok(VoiceProfile {
            id,
            speaker_name: speaker_name.to_string(),
            sample_path: sample_path.to_string(),
            created_at: now,
        })
    }

    pub fn list_voice_profiles(&self) -> Result<Vec<VoiceProfile>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, speaker_name, sample_path, created_at
             FROM voice_profiles ORDER BY created_at DESC"
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(VoiceProfile {
                id: row.get(0)?,
                speaker_name: row.get(1)?,
                sample_path: row.get(2)?,
                created_at: row.get(3)?,
            })
        })?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub fn delete_voice_profile(&self, id: &str) -> Result<Option<String>> {
        let conn = self.conn.lock().unwrap();
        // Get the sample path before deleting so we can clean up the file
        let sample_path: Option<String> = conn
            .query_row("SELECT sample_path FROM voice_profiles WHERE id = ?1", params![id], |row| row.get(0))
            .ok();
        conn.execute("DELETE FROM voice_profiles WHERE id = ?1", params![id])?;
        Ok(sample_path)
    }

    // --- Meeting Link Queries ---

    pub fn link_meetings(&self, source_id: &str, target_id: &str, link_type: &str) -> Result<MeetingLink> {
        let conn = self.conn.lock().unwrap();
        let now = now();
        conn.execute(
            "INSERT OR IGNORE INTO meeting_links (source_meeting_id, target_meeting_id, link_type, created_at) VALUES (?1, ?2, ?3, ?4)",
            params![source_id, target_id, link_type, now],
        )?;
        Ok(MeetingLink { source_meeting_id: source_id.to_string(), target_meeting_id: target_id.to_string(), link_type: link_type.to_string(), created_at: now })
    }

    pub fn unlink_meetings(&self, source_id: &str, target_id: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM meeting_links WHERE source_meeting_id = ?1 AND target_meeting_id = ?2", params![source_id, target_id])?;
        Ok(())
    }

    pub fn get_linked_meetings(&self, meeting_id: &str) -> Result<Vec<MeetingLink>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT source_meeting_id, target_meeting_id, link_type, created_at FROM meeting_links
             WHERE source_meeting_id = ?1 OR target_meeting_id = ?1
             ORDER BY created_at DESC"
        )?;
        let rows = stmt.query_map(params![meeting_id], |row| {
            Ok(MeetingLink {
                source_meeting_id: row.get(0)?,
                target_meeting_id: row.get(1)?,
                link_type: row.get(2)?,
                created_at: row.get(3)?,
            })
        })?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    /// (meeting_id, short plain-text preview of the raw notes) in ONE
    /// round-trip — NotesList previously fetched every meeting's full note
    /// bodies individually just to derive these lines (lifetime #18).
    pub fn list_note_previews(&self) -> Result<Vec<NotePreview>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT n.meeting_id, n.raw_content
             FROM notes n
             JOIN meetings m ON m.id = n.meeting_id
             WHERE m.deleted_at IS NULL AND n.raw_content IS NOT NULL",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })?;
        let mut out = Vec::new();
        for (meeting_id, raw) in rows.flatten() {
            let preview = tiptap_preview(&raw, 200);
            if !preview.is_empty() {
                out.push(NotePreview { meeting_id, preview });
            }
        }
        Ok(out)
    }

    /// (id, title, sort date, status) for EVERY meeting row — archived and
    /// trashed included, since their audio files exist regardless. Feeds
    /// the storage breakdown and the audio-retention sweep.
    pub fn meeting_audio_index(&self) -> Result<Vec<(String, String, Option<String>, String)>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, title, COALESCE(actual_start, scheduled_start, created_at), status
             FROM meetings",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get(0)?,
                r.get(1)?,
                r.get::<_, Option<String>>(2)?,
                r.get(3)?,
            ))
        })?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    /// COALESCE(actual_start, scheduled_start, created_at) for each of
    /// `ids`, in one query — the batch, id-keyed sibling of
    /// `meeting_sort_date(&Meeting)`, the same "when did this meeting
    /// happen" the date filters and chat block headers use. Feeds
    /// recency-aware search fusion (plan v10 #7); unknown ids are simply
    /// absent and callers treat a missing date as "no decay".
    /// Which of `ids` are live (not trashed, not archived) — the same
    /// visibility rule the keyword search arms apply via SQL.
    pub fn live_meeting_ids(
        &self,
        ids: &[String],
    ) -> Result<std::collections::HashSet<String>> {
        if ids.is_empty() {
            return Ok(Default::default());
        }
        let conn = self.conn.lock().unwrap();
        let placeholders = vec!["?"; ids.len()].join(",");
        let mut stmt = conn.prepare(&format!(
            "SELECT id FROM meetings
             WHERE id IN ({placeholders}) AND deleted_at IS NULL AND is_archived = 0"
        ))?;
        let rows = stmt.query_map(rusqlite::params_from_iter(ids), |r| r.get::<_, String>(0))?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub fn meeting_sort_dates(
        &self,
        ids: &[String],
    ) -> Result<std::collections::HashMap<String, String>> {
        if ids.is_empty() {
            return Ok(Default::default());
        }
        let conn = self.conn.lock().unwrap();
        let placeholders = vec!["?"; ids.len()].join(",");
        let mut stmt = conn.prepare(&format!(
            "SELECT id, COALESCE(actual_start, scheduled_start, created_at)
             FROM meetings WHERE id IN ({placeholders})"
        ))?;
        let rows = stmt.query_map(rusqlite::params_from_iter(ids), |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    // --- Storage Stats ---

    pub fn get_storage_stats(&self) -> Result<StorageStats> {
        let conn = self.conn.lock().unwrap();
        let total_meetings: usize = conn.query_row("SELECT COUNT(*) FROM meetings", [], |r| r.get(0))?;
        let total_transcripts: usize = conn.query_row("SELECT COUNT(*) FROM transcripts", [], |r| r.get(0))?;
        let total_notes: usize = conn.query_row("SELECT COUNT(*) FROM notes", [], |r| r.get(0))?;
        let total_chat_messages: usize = conn.query_row("SELECT COUNT(*) FROM chat_messages", [], |r| r.get(0))?;
        let page_count: u64 = conn.query_row("PRAGMA page_count", [], |r| r.get(0))?;
        let page_size: u64 = conn.query_row("PRAGMA page_size", [], |r| r.get(0))?;
        Ok(StorageStats { total_meetings, total_transcripts, total_notes, total_chat_messages, db_size_bytes: page_count * page_size })
    }

    // --- Backup / Export ---

    pub fn export_all_data(&self) -> Result<String> {
        let meetings = self.list_meetings()?;
        let archived = self.list_archived_meetings()?;
        let templates = self.list_templates()?;
        let folders = self.list_folders()?;
        let tags = self.list_tags()?;
        let speaker_labels = self.list_speaker_labels()?;

        let (notes, transcripts) = {
            let conn = self.conn.lock().unwrap();
            let mut note_stmt = conn.prepare(&format!("SELECT {NOTE_COLUMNS} FROM notes"))?;
            let notes: Vec<Note> = note_stmt.query_map([], map_note_row)?.filter_map(|r| r.ok()).collect();

            let mut transcript_stmt = conn.prepare("SELECT id, meeting_id, segments, source, language, created_at FROM transcripts")?;
            let transcripts: Vec<Transcript> = transcript_stmt.query_map([], |row| {
                Ok(Transcript { id: row.get(0)?, meeting_id: row.get(1)?, segments: row.get(2)?, source: row.get(3)?, language: row.get(4)?, created_at: row.get(5)? })
            })?.filter_map(|r| r.ok()).collect();
            (notes, transcripts)
        };

        let data = serde_json::json!({
            "version": 1,
            "exported_at": now(),
            "meetings": meetings,
            "archived_meetings": archived,
            "notes": notes,
            "transcripts": transcripts,
            "templates": templates,
            "folders": folders,
            "tags": tags,
            "speaker_labels": speaker_labels,
        });

        Ok(serde_json::to_string_pretty(&data)?)
    }

    // --- Attachment Queries ---

    pub fn create_attachment(
        &self,
        meeting_id: &str,
        file_name: &str,
        file_path: &str,
        file_type: &str,
        file_size: i64,
    ) -> Result<Attachment> {
        let conn = self.conn.lock().unwrap();
        let id = new_id();
        let now = now();
        conn.execute(
            "INSERT INTO attachments (id, meeting_id, file_name, file_path, file_type, file_size, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![id, meeting_id, file_name, file_path, file_type, file_size, now],
        )?;
        Ok(Attachment {
            id,
            meeting_id: meeting_id.to_string(),
            file_name: file_name.to_string(),
            file_path: file_path.to_string(),
            file_type: file_type.to_string(),
            file_size,
            created_at: now,
        })
    }

    pub fn list_attachments(&self, meeting_id: &str) -> Result<Vec<Attachment>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, meeting_id, file_name, file_path, file_type, file_size, created_at
             FROM attachments WHERE meeting_id = ?1 ORDER BY created_at DESC"
        )?;
        let rows = stmt.query_map(params![meeting_id], |row| {
            Ok(Attachment {
                id: row.get(0)?,
                meeting_id: row.get(1)?,
                file_name: row.get(2)?,
                file_path: row.get(3)?,
                file_type: row.get(4)?,
                file_size: row.get(5)?,
                created_at: row.get(6)?,
            })
        })?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub fn get_attachment(&self, id: &str) -> Result<Option<Attachment>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, meeting_id, file_name, file_path, file_type, file_size, created_at
             FROM attachments WHERE id = ?1"
        )?;
        let mut rows = stmt.query_map(params![id], |row| {
            Ok(Attachment {
                id: row.get(0)?,
                meeting_id: row.get(1)?,
                file_name: row.get(2)?,
                file_path: row.get(3)?,
                file_type: row.get(4)?,
                file_size: row.get(5)?,
                created_at: row.get(6)?,
            })
        })?;
        match rows.next() {
            Some(row) => Ok(Some(row?)),
            None => Ok(None),
        }
    }

    pub fn delete_attachment(&self, id: &str) -> Result<Option<String>> {
        let conn = self.conn.lock().unwrap();
        // Return the file_path so the caller can delete the file from disk
        let file_path: Option<String> = conn
            .query_row(
                "SELECT file_path FROM attachments WHERE id = ?1",
                params![id],
                |row| row.get(0),
            )
            .ok();
        conn.execute("DELETE FROM attachments WHERE id = ?1", params![id])?;
        Ok(file_path)
    }

    /// Top-N matching mention candidates ordered by freq DESC, recency DESC.
    /// `prefix` is case-insensitive; pass "" to get the top overall.
    pub fn list_mention_candidates(&self, prefix: &str, limit: usize) -> anyhow::Result<Vec<String>> {
        let limit = limit.clamp(1, 50) as i64;
        let conn = self.conn.lock().unwrap();
        let like = format!("{}%", prefix);
        let mut stmt = conn.prepare(
            "SELECT name FROM mention_candidates
             WHERE name LIKE ?1 COLLATE NOCASE
             ORDER BY freq DESC, last_seen_at DESC
             LIMIT ?2"
        )?;
        let rows = stmt
            .query_map(rusqlite::params![like, limit], |r| r.get::<_, String>(0))?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    }

    /// Bump (or insert) a name in the mention pool. Idempotent per call.
    pub fn upsert_mention_candidate(&self, name: &str, seen_at: &str) -> anyhow::Result<()> {
        let trimmed = name.trim();
        if trimmed.is_empty() { return Ok(()); }
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO mention_candidates(name, freq, last_seen_at)
             VALUES (?1, 1, ?2)
             ON CONFLICT(name) DO UPDATE
                 SET freq = freq + 1,
                     last_seen_at = MAX(last_seen_at, excluded.last_seen_at)",
            rusqlite::params![trimmed, seen_at],
        )?;
        Ok(())
    }

    /// Drop everything past the top-200 by (freq DESC, last_seen_at DESC).
    /// Call after upsert when you suspect the cap may be exceeded.
    pub fn prune_mention_candidates(&self) -> anyhow::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM mention_candidates
             WHERE name NOT IN (
                 SELECT name FROM mention_candidates
                 ORDER BY freq DESC, last_seen_at DESC
                 LIMIT 200
             )",
            [],
        )?;
        Ok(())
    }

    /// Insert a voice profile WITH its mel embedding (replaces save_voice_profile
    /// for the new-from-snippet flow). The embedding is JSON-encoded so it can
    /// live in the existing TEXT column without schema gymnastics.
    pub fn save_voice_profile_with_embedding(
        &self,
        speaker_name: &str,
        sample_path: &str,
        embedding: &[f32],
    ) -> anyhow::Result<String> {
        let conn = self.conn.lock().unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        let now_str = now();
        let emb_json = serde_json::to_string(embedding)?;
        conn.execute(
            "INSERT INTO voice_profiles (id, speaker_name, sample_path, embedding, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![id, speaker_name, sample_path, emb_json, now_str],
        )?;
        Ok(id)
    }

    /// Every voice profile with its cached embedding JSON (if any):
    /// (id, speaker_name, sample_path, embedding_json). The neural matcher
    /// uses this to re-embed legacy mel rows from their sample WAVs and to
    /// load match candidates in one pass.
    pub fn list_voice_profiles_with_embeddings(
        &self,
    ) -> anyhow::Result<Vec<(String, String, String, Option<String>)>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, speaker_name, sample_path, embedding
             FROM voice_profiles ORDER BY created_at DESC",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, Option<String>>(3)?,
            ))
        })?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }

    /// Cache an embedding on an existing profile row (migration-10 column).
    /// Used when re-embedding legacy mel profiles with the neural model —
    /// each sample WAV is embedded once, then read from here forever.
    pub fn update_voice_profile_embedding(
        &self,
        id: &str,
        embedding: &[f32],
    ) -> anyhow::Result<()> {
        let conn = self.conn.lock().unwrap();
        let emb_json = serde_json::to_string(embedding)?;
        conn.execute(
            "UPDATE voice_profiles SET embedding = ?1 WHERE id = ?2",
            rusqlite::params![emb_json, id],
        )?;
        Ok(())
    }

    /// Find the voice profile most similar to `query` by cosine similarity.
    /// Returns `Some((name, similarity))` when the best match exceeds
    /// `threshold`, otherwise `None`. Profiles without an embedding are
    /// skipped (legacy rows from before this feature shipped).
    pub fn match_voice_profile(
        &self,
        query: &[f32],
        threshold: f32,
    ) -> anyhow::Result<Option<(String, f32)>> {
        use crate::audio::mel::{cosine_similarity, znorm_embedding};
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT speaker_name, embedding FROM voice_profiles WHERE embedding IS NOT NULL"
        )?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;

        // Compare in z-normalized space — raw log-mel vectors share a large
        // silence-floor offset that pushes every cosine toward 1.0, making
        // the threshold meaningless. Stored profiles stay raw; we normalize
        // both sides at comparison time.
        let mut query_n = query.to_vec();
        znorm_embedding(&mut query_n);

        let mut best: Option<(String, f32)> = None;
        for row in rows {
            let (name, emb_json) = row?;
            let mut emb: Vec<f32> = match serde_json::from_str(&emb_json) {
                Ok(v) => v,
                Err(_) => continue,
            };
            if emb.len() != query_n.len() { continue; }
            znorm_embedding(&mut emb);
            let sim = cosine_similarity(&query_n, &emb);
            match &best {
                Some((_, s)) if sim <= *s => {}
                _ => best = Some((name, sim)),
            }
        }

        Ok(best.filter(|(_, s)| *s >= threshold))
    }

    /// The previous completed meeting in this meeting's series — matched by
    /// normalized title (dates/numbers stripped), so "Weekly Sync — Jun 3"
    /// and "Weekly Sync — Jun 10" pair up (plan v2 rank 11 v1).
    pub fn last_time_in_series(&self, meeting_id: &str) -> Result<Option<LastTimeCard>> {
        let me = self
            .get_meeting(meeting_id)?
            .ok_or_else(|| anyhow::anyhow!("meeting not found"))?;
        let key = normalize_series_title(&me.title);
        // Generic/auto titles ("Meeting — Jun 9 at 11:53 AM") must not chain
        // unrelated ad-hoc meetings into a fake series.
        if key.split_whitespace().count() < 2 || key.starts_with("meeting") {
            return Ok(None);
        }
        let mut candidates: Vec<Meeting> = self
            .list_meetings()?
            .into_iter()
            .filter(|m| m.id != meeting_id && m.status == "complete")
            .filter(|m| normalize_series_title(&m.title) == key)
            .collect();
        candidates.sort_by(|a, b| meeting_sort_date(b).cmp(&meeting_sort_date(a)));
        for m in candidates {
            let gen = self
                .get_note_by_meeting(&m.id)?
                .and_then(|n| n.generated_content)
                .filter(|g| !g.trim().is_empty());
            if let Some(gen) = gen {
                let open_items = self
                    .list_action_items()?
                    .into_iter()
                    .filter(|i| i.meeting_id == m.id && !i.done)
                    .collect();
                let date = m
                    .actual_start
                    .clone()
                    .or_else(|| m.scheduled_start.clone())
                    .unwrap_or_else(|| m.created_at.clone());
                return Ok(Some(LastTimeCard {
                    meeting_id: m.id,
                    title: m.title,
                    date,
                    summary: extract_summary_text(&gen),
                    open_items,
                }));
            }
        }
        Ok(None)
    }

    /// Open action items from OTHER meetings related to this one — the
    /// "open loops" you likely want to revisit (plan rank 13). Related means
    /// sharing an attendee OR belonging to the same recurring series (same
    /// normalized title). The series key matters in practice: .ics calendar
    /// feeds strip attendee data, so attendee overlap alone finds nothing
    /// for users on ICS sync.
    pub fn open_action_items_for_meeting_attendees(
        &self,
        meeting_id: &str,
    ) -> Result<Vec<ActionItem>> {
        let meeting = self
            .get_meeting(meeting_id)?
            .ok_or_else(|| anyhow::anyhow!("meeting not found"))?;
        let attendees = parse_attendee_names(&meeting.attendees);
        let series_key = {
            let key = normalize_series_title(&meeting.title);
            // Same guards as the "Last time" card: short or auto-generated
            // titles would chain unrelated meetings together.
            (key.split_whitespace().count() >= 2 && !key.starts_with("meeting"))
                .then_some(key)
        };
        if attendees.is_empty() && series_key.is_none() {
            return Ok(Vec::new());
        }
        let related: std::collections::HashSet<String> = self
            .list_meetings()?
            .into_iter()
            .filter(|m| m.id != meeting_id)
            .filter(|m| {
                let by_attendee = parse_attendee_names(&m.attendees)
                    .iter()
                    .any(|a| attendees.iter().any(|b| a.eq_ignore_ascii_case(b)));
                let by_series = series_key
                    .as_deref()
                    .map(|k| normalize_series_title(&m.title) == k)
                    .unwrap_or(false);
                by_attendee || by_series
            })
            .map(|m| m.id)
            .collect();
        if related.is_empty() {
            return Ok(Vec::new());
        }
        Ok(self
            .list_action_items()?
            .into_iter()
            .filter(|i| !i.done && related.contains(&i.meeting_id))
            .collect())
    }

    /// Remove all speaker labels for a meeting. Called after re-clustering:
    /// the new "Speaker N" keys describe different groupings, so labels tied
    /// to the old keys would silently display the wrong names.
    pub fn delete_speaker_labels_for_meeting(&self, meeting_id: &str) -> Result<usize> {
        let conn = self.conn.lock().unwrap();
        let n = conn.execute(
            "DELETE FROM speaker_labels WHERE meeting_id = ?1",
            params![meeting_id],
        )?;
        Ok(n)
    }

    /// Merge one speaker key into another for a meeting — the fix for
    /// over-split clusters ("Speaker 5" is really "Speaker 2"). Rewrites
    /// every matching transcript segment, and resolves labels: `into_key`
    /// keeps its own name if it has one, otherwise inherits `from_key`'s;
    /// `from_key`'s label row is removed. Returns segments changed.
    pub fn merge_speaker_keys(
        &self,
        meeting_id: &str,
        from_key: &str,
        into_key: &str,
    ) -> Result<usize> {
        if from_key == into_key {
            return Ok(0);
        }
        let transcript = self
            .get_transcript_by_meeting(meeting_id)?
            .ok_or_else(|| anyhow::anyhow!("no transcript for this meeting"))?;
        let mut segments: serde_json::Value = serde_json::from_str(&transcript.segments)?;
        let mut changed = 0usize;
        if let Some(arr) = segments.as_array_mut() {
            for seg in arr {
                if seg.get("speaker").and_then(|v| v.as_str()) == Some(from_key) {
                    seg["speaker"] = serde_json::Value::String(into_key.to_string());
                    changed += 1;
                }
            }
        }
        self.update_transcript_segments(&transcript.id, &serde_json::to_string(&segments)?)?;

        let labels = self.list_speaker_labels_for_meeting(meeting_id)?;
        let from_label = labels.iter().find(|l| l.speaker_key == from_key).cloned();
        let into_label = labels.iter().find(|l| l.speaker_key == into_key).cloned();
        if let (Some(from_l), None) = (&from_label, &into_label) {
            self.upsert_speaker_label(
                meeting_id,
                into_key,
                &from_l.display_name,
                from_l.color.as_deref(),
                Some(&from_l.participant_type),
            )?;
        }
        if let Some(from_l) = from_label {
            self.delete_speaker_label(&from_l.id)?;
        }
        Ok(changed)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LastTimeCard {
    pub meeting_id: String,
    pub title: String,
    pub date: String,
    pub summary: String,
    pub open_items: Vec<ActionItem>,
}

/// Lowercase, strip digits/punctuation, collapse whitespace — date suffixes
/// and numbering vanish so recurring titles compare equal.
fn normalize_series_title(t: &str) -> String {
    t.to_lowercase()
        .chars()
        .map(|c| if c.is_alphabetic() || c.is_whitespace() { c } else { ' ' })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn meeting_sort_date(m: &Meeting) -> String {
    m.actual_start
        .clone()
        .or_else(|| m.scheduled_start.clone())
        .unwrap_or_else(|| m.created_at.clone())
}

/// First `max_chars` of a TipTap doc's visible text — the list-preview cut.
/// Walks text nodes depth-first; stops as soon as the budget is spent so
/// huge notes never get fully traversed.
fn tiptap_preview(raw_json: &str, max_chars: usize) -> String {
    fn walk(node: &serde_json::Value, out: &mut String, max: usize) {
        if out.len() >= max {
            return;
        }
        if let Some(text) = node.get("text").and_then(|t| t.as_str()) {
            if !out.is_empty() && !out.ends_with(' ') {
                out.push(' ');
            }
            out.push_str(text.trim());
        }
        if let Some(children) = node.get("content").and_then(|c| c.as_array()) {
            for child in children {
                if out.len() >= max {
                    return;
                }
                walk(child, out, max);
            }
        }
    }
    let Ok(doc) = serde_json::from_str::<serde_json::Value>(raw_json) else {
        return String::new();
    };
    let mut out = String::new();
    walk(&doc, &mut out, max_chars);
    let mut trimmed = out.trim().to_string();
    if trimmed.len() > max_chars {
        // Cut on a char boundary at or below the budget.
        let mut cut = max_chars;
        while !trimmed.is_char_boundary(cut) {
            cut -= 1;
        }
        trimmed.truncate(cut);
    }
    trimmed
}

/// "YYYY-MM" of the month before the given "YYYY-MM".
fn prev_month(month: &str) -> String {
    let y: i32 = month.get(0..4).and_then(|s| s.parse().ok()).unwrap_or(2000);
    let m: i32 = month.get(5..7).and_then(|s| s.parse().ok()).unwrap_or(1);
    let total = y * 12 + (m - 1) - 1;
    format!("{:04}-{:02}", total.div_euclid(12), total.rem_euclid(12) + 1)
}

/// ISO date of the Monday of the week containing the given timestamp's date.
fn monday_of(ts: &str) -> Option<String> {
    use chrono::Datelike;
    let date = chrono::NaiveDate::parse_from_str(ts.get(0..10)?, "%Y-%m-%d").ok()?;
    let monday = date - chrono::Duration::days(date.weekday().num_days_from_monday() as i64);
    Some(monday.format("%Y-%m-%d").to_string())
}

/// The months ("YYYY-MM") covered by [`from`, `to`) — ISO dates, `to`
/// exclusive, so a `to` on the 1st leaves its month out. Empty when the
/// window is inverted or unparseable.
fn months_in_range(from: &str, to: &str) -> Vec<String> {
    let parse = |s: &str| -> Option<(i32, i32)> {
        Some((s.get(0..4)?.parse().ok()?, s.get(5..7)?.parse().ok()?))
    };
    let (Some((fy, fm)), Some((ty, tm))) = (parse(from), parse(to)) else {
        return Vec::new();
    };
    let start = fy * 12 + (fm - 1);
    let end = ty * 12 + (tm - 1) + if to.get(8..10) == Some("01") { 0 } else { 1 };
    (start..end)
        .map(|t| format!("{:04}-{:02}", t.div_euclid(12), t.rem_euclid(12) + 1))
        .collect()
}

/// Total capped meeting hours, rounded to one decimal — the narrative-facts
/// hours rule, shared by the month and range paths.
fn total_hours(ms: &[&Meeting]) -> f64 {
    (ms.iter().map(|m| capped_span_hours(m)).sum::<f64>() * 10.0).round() / 10.0
}

/// Busiest week among the given meetings, bucketed by their Monday.
fn busiest_week_of(meetings: &[&Meeting]) -> Option<serde_json::Value> {
    let mut weeks: std::collections::HashMap<String, u32> = std::collections::HashMap::new();
    for m in meetings {
        if let Some(monday) = monday_of(&meeting_sort_date(m)) {
            *weeks.entry(monday).or_insert(0) += 1;
        }
    }
    weeks
        .into_iter()
        .max_by(|a, b| a.1.cmp(&b.1).then(b.0.cmp(&a.0)))
        .map(|(start, count)| serde_json::json!({ "week_of": start, "meetings": count }))
}

/// Recurring series within a set of meetings, grouped by normalized title:
/// (representative title, count) for groups with ≥ `min` instances, biggest
/// first, at most `top`. Exclusions identical to series-template matching:
/// too-generic titles would group unrelated meetings into a phantom "series".
fn recurring_series(meetings: &[&Meeting], min: u32, top: usize) -> Vec<(String, u32)> {
    let mut series: std::collections::HashMap<String, (String, u32)> =
        std::collections::HashMap::new();
    for m in meetings {
        let key = normalize_series_title(&m.title);
        if key.split_whitespace().count() < 2 || key == "untitled meeting" {
            continue;
        }
        let e = series.entry(key).or_insert((m.title.clone(), 0));
        e.1 += 1;
    }
    let mut out: Vec<(String, u32)> =
        series.into_values().filter(|(_, n)| *n >= min).collect();
    out.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    out.truncate(top);
    out
}

/// "2026-04" → "April 2026" (raw input echoed back when malformed).
fn month_display(yyyy_mm: &str) -> String {
    const NAMES: [&str; 12] = [
        "January", "February", "March", "April", "May", "June",
        "July", "August", "September", "October", "November", "December",
    ];
    let m: usize = yyyy_mm.get(5..7).and_then(|s| s.parse().ok()).unwrap_or(0);
    match (m, yyyy_mm.get(0..4)) {
        (1..=12, Some(y)) => format!("{} {}", NAMES[m - 1], y),
        _ => yyyy_mm.to_string(),
    }
}

/// "2026-Q2" → "Q2 2026"; a bare year stays as is.
fn period_display(period: &str) -> String {
    match period.split_once('-') {
        Some((y, q)) => format!("{q} {y}"),
        None => period.to_string(),
    }
}

/// "2026-04-03T10:00:00Z" → "Apr 3" (date prefix echoed back when unparseable).
fn short_date(ts: &str) -> String {
    chrono::NaiveDate::parse_from_str(ts.get(0..10).unwrap_or(""), "%Y-%m-%d")
        .map(|d| d.format("%b %-d").to_string())
        .unwrap_or_else(|_| ts.get(0..10).unwrap_or(ts).to_string())
}

/// Markdown-facing hours: whole numbers without the trailing ".0".
fn fmt_hours_md(h: f64) -> String {
    if (h - h.trunc()).abs() < f64::EPSILON {
        format!("{h:.0}")
    } else {
        format!("{h:.1}")
    }
}

/// Meeting duration in hours — actual span preferred, scheduled as fallback;
/// nonpositive or implausibly long (>8h, header-repair leftovers) count as 0.
/// Mirrors the frontend's weeklyLoad rule so the two surfaces agree.
fn capped_span_hours(m: &Meeting) -> f64 {
    fn span(a: &Option<String>, b: &Option<String>) -> f64 {
        let (Some(a), Some(b)) = (a, b) else { return 0.0 };
        let parse = |s: &str| {
            chrono::DateTime::parse_from_rfc3339(s)
                .map(|d| d.timestamp())
                .or_else(|_| {
                    chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S%.f")
                        .map(|d| d.and_utc().timestamp())
                })
                .ok()
        };
        let (Some(a), Some(b)) = (parse(a), parse(b)) else { return 0.0 };
        let h = (b - a) as f64 / 3600.0;
        if h > 0.0 && h <= 8.0 { h } else { 0.0 }
    }
    let actual = span(&m.actual_start, &m.actual_end);
    if actual > 0.0 { actual } else { span(&m.scheduled_start, &m.scheduled_end) }
}

/// Text of the TipTap `summary` node, if the doc has one.
fn extract_summary_text(tiptap_json: &str) -> String {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(tiptap_json) else {
        return String::new();
    };
    let Some(nodes) = v.get("content").and_then(|c| c.as_array()) else {
        return String::new();
    };
    for node in nodes {
        if node.get("type").and_then(|t| t.as_str()) == Some("summary") {
            return node
                .get("content")
                .and_then(|c| c.as_array())
                .map(|kids| {
                    kids.iter()
                        .filter_map(|k| k.get("text").and_then(|t| t.as_str()))
                        .collect::<Vec<_>>()
                        .join("")
                })
                .unwrap_or_default();
        }
    }
    String::new()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchResult {
    pub meeting_id: String,
    pub match_source: String,
    pub snippet: String,
    /// For transcript matches: start of the first segment containing the
    /// query, so the UI can jump straight to the moment (plan rank 11 v1).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub match_start_ms: Option<u64>,
}

/// One row of `transcript_segments`, as surfaced by chat retrieval
/// (plan v8 A5) — both bm25 seed hits and their expanded neighbors.
#[derive(Debug, Clone)]
pub struct SegmentHit {
    pub transcript_id: String,
    pub meeting_id: String,
    pub seg_idx: i64,
    pub speaker_key: Option<String>,
    pub start_ms: Option<i64>,
    pub text: String,
}

fn map_segment_hit_row(row: &rusqlite::Row) -> rusqlite::Result<SegmentHit> {
    Ok(SegmentHit {
        transcript_id: row.get(0)?,
        meeting_id: row.get(1)?,
        seg_idx: row.get(2)?,
        speaker_key: row.get(3)?,
        start_ms: row.get(4)?,
        text: row.get(5)?,
    })
}

#[derive(Debug, Clone, Serialize)]
pub struct NotePreview {
    pub meeting_id: String,
    pub preview: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct CachedInsight {
    pub key: String,
    pub content: String,
    /// The exact facts JSON the content was generated from.
    pub facts: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct TopicTrend {
    pub term: String,
    pub counts: Vec<TopicMonthCount>,
}

#[derive(Debug, Clone, Serialize)]
pub struct TopicMonthCount {
    /// "YYYY-MM"
    pub month: String,
    pub meetings: i64,
}

/// ASCII-case-insensitive literal replace, char-by-char — deliberately
/// never computes byte offsets on case-folded text (the extract_snippet
/// panic class, QA audit P1). None when nothing matched.
fn replace_ascii_ci(text: &str, find: &str, replace: &str) -> Option<String> {
    let needle: Vec<char> = find.chars().collect();
    if needle.is_empty() {
        return None;
    }
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    let mut changed = false;
    while i < chars.len() {
        let matches = i + needle.len() <= chars.len()
            && needle
                .iter()
                .enumerate()
                .all(|(k, f)| chars[i + k].eq_ignore_ascii_case(f));
        if matches {
            out.push_str(replace);
            i += needle.len();
            changed = true;
        } else {
            out.push(chars[i]);
            i += 1;
        }
    }
    changed.then_some(out)
}

/// Largest char-boundary index ≤ `i` (stable Rust lacks floor_char_boundary).
fn clamp_to_char_boundary(s: &str, mut i: usize) -> usize {
    if i >= s.len() {
        return s.len();
    }
    while i > 0 && !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

/// Extract a short snippet from content around the first occurrence of the
/// query, case-insensitive. Every slice index is clamped to a UTF-8 char
/// boundary of the ORIGINAL string: the match offset comes from the
/// lowercased haystack (lowercasing can change byte lengths — İ), and the
/// arithmetic window edges can land inside a multi-byte char. Unclamped,
/// this panicked on emoji/CJK near a match — in the search hot path, on a
/// sync command, i.e. an app crash per keystroke (QA audit P1).
fn extract_snippet(content: &str, query: &str, max_len: usize) -> String {
    let lower_content = content.to_lowercase();
    let lower_query = query.to_lowercase();
    if lower_query.is_empty() {
        return content.chars().take(max_len).collect();
    }
    if let Some(found) = lower_content.find(&lower_query) {
        let pos = clamp_to_char_boundary(content, found);
        let start = clamp_to_char_boundary(content, pos.saturating_sub(max_len / 2));
        let end = clamp_to_char_boundary(
            content,
            (pos + lower_query.len() + max_len / 2).min(content.len()),
        );
        // Widen to whitespace where available so words aren't cut. The +len
        // skips past the whitespace char itself — `+ 1` would land inside a
        // multi-byte space (U+00A0 is whitespace) and panic the same way.
        let start = content[..start]
            .rfind(char::is_whitespace)
            .map(|p| p + content[p..].chars().next().map_or(1, |c| c.len_utf8()))
            .unwrap_or(start);
        let end = content[end..]
            .find(char::is_whitespace)
            .map(|p| end + p)
            .unwrap_or(end);
        let mut snippet = content[start..end].to_string();
        if start > 0 { snippet = format!("...{}", snippet); }
        if end < content.len() { snippet = format!("{}...", snippet); }
        snippet
    } else {
        content.chars().take(max_len).collect()
    }
}

impl Database {
    /// Mark the stored transcript segment containing `ms` as highlighted.
    /// Returns false when no segment spans that moment (caller keeps it
    /// pending). Operates on raw JSON so unknown fields survive.
    pub fn highlight_segment_at(&self, meeting_id: &str, ms: u64) -> Result<bool> {
        self.edit_segments(meeting_id, |segs| {
            let mut hit = false;
            for seg in segs.iter_mut() {
                let start = seg.get("start_ms").and_then(|v| v.as_u64()).unwrap_or(0);
                let end = seg.get("end_ms").and_then(|v| v.as_u64()).unwrap_or(0);
                if ms >= start && ms <= end {
                    seg["highlighted"] = serde_json::Value::Bool(true);
                    hit = true;
                }
            }
            hit
        })
    }

    /// Flip one segment's highlight by index; returns the new state.
    pub fn toggle_segment_highlight(&self, meeting_id: &str, index: usize) -> Result<bool> {
        self.edit_segments(meeting_id, |segs| {
            let Some(seg) = segs.get_mut(index) else { return false };
            let now = !seg.get("highlighted").and_then(|v| v.as_bool()).unwrap_or(false);
            seg["highlighted"] = serde_json::Value::Bool(now);
            now
        })
    }

    /// Current segments JSON + its sha256 hex — the accuracy pass's
    /// starting snapshot (plan v10 #3). None when no transcript exists.
    pub fn segments_snapshot(&self, meeting_id: &str) -> Result<Option<(String, String)>> {
        use sha2::{Digest, Sha256};
        let conn = self.conn.lock().unwrap();
        let json: Option<String> = conn
            .query_row(
                "SELECT COALESCE(segments, '[]') FROM transcripts
                 WHERE meeting_id = ?1 ORDER BY created_at DESC LIMIT 1",
                params![meeting_id],
                |r| r.get(0),
            )
            .ok();
        Ok(json.map(|j| {
            let hash = format!("{:x}", Sha256::digest(j.as_bytes()));
            (j, hash)
        }))
    }

    /// Just the current transcript hash — the staleness comparison input for
    /// enhance receipts (plan v10 #2). A note is stale when its stored
    /// `generated_transcript_sha` and this value are BOTH present and differ;
    /// either side missing means "don't know", never "stale". Same
    /// sha256-of-segments-JSON as `segments_snapshot`/the accuracy pass.
    pub fn transcript_sha(&self, meeting_id: &str) -> Result<Option<String>> {
        Ok(self.segments_snapshot(meeting_id)?.map(|(_, hash)| hash))
    }

    /// Atomically replace a meeting's segments ONLY if they still hash to
    /// `expected_sha256` — the accuracy pass's guard (plan v10 #3): the
    /// whole-file re-decode runs for minutes in the background, and any
    /// user edit landing meanwhile must win. One lock acquisition = the
    /// compare and the swap can't interleave with other writers (the same
    /// contract as edit_segments). False = no write (mismatch/missing).
    pub fn swap_segments_if_unchanged(
        &self,
        meeting_id: &str,
        expected_sha256: &str,
        new_segments_json: &str,
    ) -> Result<bool> {
        use sha2::{Digest, Sha256};
        let conn = self.conn.lock().unwrap();
        let row: Option<(String, String)> = conn
            .query_row(
                "SELECT id, COALESCE(segments, '[]') FROM transcripts
                 WHERE meeting_id = ?1 ORDER BY created_at DESC LIMIT 1",
                params![meeting_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .ok();
        let Some((transcript_id, current)) = row else { return Ok(false) };
        let current_hash = format!("{:x}", Sha256::digest(current.as_bytes()));
        if current_hash != expected_sha256 {
            return Ok(false);
        }
        conn.execute(
            "UPDATE transcripts SET segments = ?1 WHERE id = ?2",
            params![new_segments_json, transcript_id],
        )?;
        Ok(true)
    }

    /// Replace one segment's text (drawer inline edit, plan v9 #8). Raw-JSON
    /// edit so unknown fields survive; the migration-17 sync triggers
    /// re-materialize transcript_segments + FTS on write. False when the
    /// index doesn't exist.
    pub fn update_segment_text(&self, meeting_id: &str, index: usize, new_text: &str) -> Result<bool> {
        self.edit_segments(meeting_id, |segs| {
            let Some(seg) = segs.get_mut(index) else { return false };
            seg["text"] = serde_json::Value::String(new_text.to_string());
            true
        })
    }

    /// Literal find→replace across every segment of a meeting's transcript —
    /// the misheard-name fixer (plan v9 #8). ASCII-case-insensitive (matches
    /// the drawer's match counting for the names/words people actually fix;
    /// non-ASCII compares exactly). Returns the number of segments touched.
    pub fn replace_in_transcript(&self, meeting_id: &str, find: &str, replace: &str) -> Result<usize> {
        if find.trim().is_empty() {
            return Ok(0);
        }
        self.edit_segments(meeting_id, |segs| {
            let mut touched = 0usize;
            for seg in segs.iter_mut() {
                if let Some(text) = seg.get("text").and_then(|t| t.as_str()) {
                    if let Some(replaced) = replace_ascii_ci(text, find, replace) {
                        seg["text"] = serde_json::Value::String(replaced);
                        touched += 1;
                    }
                }
            }
            touched
        })
    }

    /// Load → edit → store the segments JSON array of a meeting's transcript.
    ///
    /// Read, mutation, and write all happen under ONE connection-lock
    /// acquisition (QA audit P1-2): the old two-lock version let a live
    /// `append_transcript_segment` land between the SELECT and the UPDATE,
    /// after which the stale snapshot overwrote it — a freshly transcribed
    /// segment silently and permanently lost (the sync triggers then
    /// re-materialize FTS from the clobbered JSON). Every other transcript
    /// writer needs this same mutex, so holding it across the whole
    /// read-modify-write closes the race.
    fn edit_segments<T>(
        &self,
        meeting_id: &str,
        f: impl FnOnce(&mut Vec<serde_json::Value>) -> T,
    ) -> Result<T> {
        let conn = self.conn.lock().unwrap();
        let (transcript_id, segments_json): (String, String) = conn
            .query_row(
                "SELECT id, COALESCE(segments, '[]') FROM transcripts
                 WHERE meeting_id = ?1 ORDER BY created_at DESC LIMIT 1",
                params![meeting_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(|_| anyhow::anyhow!("no transcript for meeting"))?;
        let mut segs: Vec<serde_json::Value> =
            serde_json::from_str(&segments_json).unwrap_or_default();
        let out = f(&mut segs);
        conn.execute(
            "UPDATE transcripts SET segments = ?1 WHERE id = ?2",
            params![serde_json::to_string(&segs)?, transcript_id],
        )?;
        Ok(out)
    }

    /// Settings key remembering which template a recurring series uses.
    /// None for titles too generic to identify a series (same guards as the
    /// "Last time" card).
    fn series_template_key(title: &str) -> Option<String> {
        let key = normalize_series_title(title);
        (key.split_whitespace().count() >= 2 && !key.starts_with("meeting"))
            .then(|| format!("series_template:{key}"))
    }

    /// Remember an explicit template choice for this meeting's series, so
    /// the next instance (and instant recap) enhances the same way.
    pub fn remember_series_template(&self, meeting_title: &str, template_id: &str) -> Result<()> {
        if let Some(key) = Self::series_template_key(meeting_title) {
            self.set_setting(&key, template_id)?;
        }
        Ok(())
    }

    pub fn series_template_for(&self, meeting_title: &str) -> Result<Option<String>> {
        match Self::series_template_key(meeting_title) {
            Some(key) => self.get_setting(&key),
            None => Ok(None),
        }
    }

    /// The not-yet-recorded meeting whose scheduled start is closest to now,
    /// within ±`window_mins`. Lets call detection attach a recording nudge
    /// to the calendar event the user is presumably in.
    pub fn meeting_near_now(&self, window_mins: i64) -> Result<Option<Meeting>> {
        let now = chrono::Utc::now();
        let best = self
            .list_meetings()?
            .into_iter()
            .filter(|m| m.status == "upcoming" || m.status == "ready")
            .filter_map(|m| {
                let start = m.scheduled_start.as_deref()?;
                let t = chrono::DateTime::parse_from_rfc3339(start).ok()?;
                let delta = (now - t.with_timezone(&chrono::Utc)).num_minutes().abs();
                (delta <= window_mins).then_some((delta, m))
            })
            .min_by_key(|(delta, _)| *delta)
            .map(|(_, m)| m);
        Ok(best)
    }
}

// ───────────────────────────── Prep briefs ──────────────────────────────────

/// One prior meeting shared with today's attendees, distilled for the
/// prep-brief prompt.
#[derive(Debug, Clone, Serialize)]
pub struct PrepHistoryItem {
    pub title: String,
    pub date: String,
    pub summary: String,
    pub my_notes: String,
}

/// Attendee names from the meetings.attendees JSON, which historically holds
/// either plain strings or {name, email} objects (see migration 9).
pub fn parse_attendee_names(attendees_json: &str) -> Vec<String> {
    let Ok(values) = serde_json::from_str::<Vec<serde_json::Value>>(attendees_json) else {
        return Vec::new();
    };
    values
        .into_iter()
        .filter_map(|v| match v {
            serde_json::Value::String(s) => Some(s),
            serde_json::Value::Object(o) => o
                .get("name")
                .and_then(|n| n.as_str())
                .map(String::from)
                .or_else(|| {
                    o.get("email").and_then(|e| e.as_str()).map(|e| {
                        e.split('@').next().unwrap_or(e).to_string()
                    })
                }),
            _ => None,
        })
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

impl Database {
    /// Stored prep brief for a meeting: (content, generated_at).
    pub fn get_prep_brief(&self, meeting_id: &str) -> Result<Option<(String, String)>> {
        let conn = self.conn.lock().unwrap();
        let row = conn
            .query_row(
                "SELECT content, generated_at FROM prep_briefs WHERE meeting_id = ?1",
                params![meeting_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        Ok(row)
    }

    /// Each setter touches ONLY its own column — snoozing must never clear
    /// a drop and dropping must never clear a snooze.
    pub fn set_task_snooze(
        &self,
        note_id: &str,
        source: &str,
        idx: usize,
        snoozed_until: Option<&str>,
        task_text: Option<&str>,
    ) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO task_overlays (note_id, source, idx, snoozed_until, dropped, task_text)
             VALUES (?1, ?2, ?3, ?4, 0, ?5)
             ON CONFLICT(note_id, source, idx) DO UPDATE
                 SET snoozed_until = excluded.snoozed_until,
                     task_text = COALESCE(excluded.task_text, task_overlays.task_text)",
            params![note_id, source, idx as i64, snoozed_until, task_text],
        )?;
        Ok(())
    }

    pub fn set_task_dropped(
        &self,
        note_id: &str,
        source: &str,
        idx: usize,
        dropped: bool,
        task_text: Option<&str>,
    ) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO task_overlays (note_id, source, idx, snoozed_until, dropped, task_text)
             VALUES (?1, ?2, ?3, NULL, ?4, ?5)
             ON CONFLICT(note_id, source, idx) DO UPDATE
                 SET dropped = excluded.dropped,
                     task_text = COALESCE(excluded.task_text, task_overlays.task_text)",
            params![note_id, source, idx as i64, dropped as i64, task_text],
        )?;
        Ok(())
    }

    #[allow(clippy::type_complexity)]
    fn task_overlays(
        &self,
    ) -> Result<std::collections::HashMap<(String, String, usize), (Option<String>, bool, Option<String>)>>
    {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT note_id, source, idx, snoozed_until, dropped, task_text FROM task_overlays",
        )?;
        let map = stmt
            .query_map([], |r| {
                Ok((
                    (r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)? as usize),
                    (
                        r.get::<_, Option<String>>(3)?,
                        r.get::<_, i64>(4)? != 0,
                        r.get::<_, Option<String>>(5)?,
                    ),
                ))
            })?
            .filter_map(|r| r.ok())
            .collect();
        Ok(map)
    }

    pub fn upsert_reminder_link(
        &self,
        note_id: &str,
        source: &str,
        idx: usize,
        reminder_id: &str,
        task_text: &str,
    ) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO reminder_links (note_id, source, idx, reminder_id, task_text)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(note_id, source, idx) DO UPDATE
                 SET reminder_id = excluded.reminder_id,
                     task_text = excluded.task_text",
            params![note_id, source, idx as i64, reminder_id, task_text],
        )?;
        Ok(())
    }

    pub fn get_reminder_link(
        &self,
        note_id: &str,
        source: &str,
        idx: usize,
    ) -> Result<Option<String>> {
        let conn = self.conn.lock().unwrap();
        let row = conn
            .query_row(
                "SELECT reminder_id FROM reminder_links
                 WHERE note_id = ?1 AND source = ?2 AND idx = ?3",
                params![note_id, source, idx as i64],
                |r| r.get(0),
            )
            .optional()?;
        Ok(row)
    }

    /// All links: (reminder_id, note_id, source, idx, task_text-at-export).
    #[allow(clippy::type_complexity)]
    pub fn all_reminder_links(
        &self,
    ) -> Result<Vec<(String, String, String, usize, Option<String>)>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT reminder_id, note_id, source, idx, task_text FROM reminder_links",
        )?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, i64>(3)? as usize,
                    r.get::<_, Option<String>>(4)?,
                ))
            })?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    }

    pub fn set_talk_stats(&self, meeting_id: &str, json: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO meeting_stats (meeting_id, talk_stats) VALUES (?1, ?2)
             ON CONFLICT(meeting_id) DO UPDATE SET talk_stats = excluded.talk_stats",
            params![meeting_id, json],
        )?;
        Ok(())
    }

    pub fn get_talk_stats(&self, meeting_id: &str) -> Result<Option<String>> {
        let conn = self.conn.lock().unwrap();
        let row = conn
            .query_row(
                "SELECT talk_stats FROM meeting_stats WHERE meeting_id = ?1",
                params![meeting_id],
                |r| r.get(0),
            )
            .optional()?;
        Ok(row)
    }

    /// Add one mixer session's talk time to whatever is already persisted —
    /// a mic switch records a single meeting as two sessions, and a plain
    /// overwrite kept only the final leg. Durations sum; the longest
    /// monologue is the max across sessions.
    pub fn merge_talk_stats(
        &self,
        meeting_id: &str,
        mic_ms: u64,
        sys_ms: u64,
        longest_mono_ms: u64,
    ) -> Result<()> {
        let existing = self.get_talk_stats(meeting_id)?;
        let prev: serde_json::Value = existing
            .as_deref()
            .and_then(|s| serde_json::from_str(s).ok())
            .unwrap_or(serde_json::json!({}));
        let get = |k: &str| prev.get(k).and_then(|v| v.as_u64()).unwrap_or(0);
        let merged = serde_json::json!({
            "mic_ms": get("mic_ms") + mic_ms,
            "sys_ms": get("sys_ms") + sys_ms,
            "longest_mono_ms": get("longest_mono_ms").max(longest_mono_ms),
        })
        .to_string();
        self.set_talk_stats(meeting_id, &merged)
    }

    pub fn upsert_prep_brief(&self, meeting_id: &str, content: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO prep_briefs (meeting_id, content, generated_at)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(meeting_id) DO UPDATE
                 SET content = excluded.content, generated_at = excluded.generated_at",
            params![meeting_id, content, chrono::Utc::now().to_rfc3339()],
        )?;
        Ok(())
    }

    /// Recent meetings sharing at least one attendee with `meeting_id`,
    /// newest first, with their AI summary and a plain-text cut of the
    /// user's own notes — the local "history with these people".
    pub fn prep_history_for_meeting(
        &self,
        meeting_id: &str,
        limit: usize,
    ) -> Result<Vec<PrepHistoryItem>> {
        let meeting = self
            .get_meeting(meeting_id)?
            .ok_or_else(|| anyhow::anyhow!("meeting not found"))?;
        let attendees = parse_attendee_names(&meeting.attendees);
        if attendees.is_empty() {
            return Ok(Vec::new());
        }
        let mut related: Vec<Meeting> = self
            .list_meetings()?
            .into_iter()
            .filter(|m| m.id != meeting_id && m.deleted_at.is_none())
            .filter(|m| {
                parse_attendee_names(&m.attendees)
                    .iter()
                    .any(|a| attendees.iter().any(|b| a.eq_ignore_ascii_case(b)))
            })
            .collect();
        related.sort_by(|a, b| meeting_sort_date(b).cmp(&meeting_sort_date(a)));
        related.truncate(limit);

        let mut out = Vec::new();
        for m in related {
            let note = self.get_note_by_meeting(&m.id)?;
            let (summary, my_notes) = note
                .map(|n| {
                    let summary = n
                        .generated_content
                        .as_deref()
                        .map(extract_summary_text)
                        .unwrap_or_default();
                    let my_notes: String =
                        plain_text_of_tiptap(n.raw_content.as_deref().unwrap_or(""))
                            .chars()
                            .take(400)
                            .collect();
                    (summary, my_notes)
                })
                .unwrap_or_default();
            let date: String = meeting_sort_date(&m).chars().take(10).collect();
            out.push(PrepHistoryItem {
                title: m.title,
                date,
                summary,
                my_notes,
            });
        }
        Ok(out)
    }
}

/// A TipTap doc rendered as markdown — a Rust port of the frontend's
/// serializeTiptap.ts (same node semantics, same checkbox/action-item
/// shapes), so the perchnote-mcp bin can hand Claude structured notes
/// instead of flattened text (plan v10 #11, second half). Unknown nodes
/// degrade to their inline text rather than vanishing.
pub fn markdown_of_tiptap(raw: &str) -> String {
    use serde_json::Value;

    fn inline(content: Option<&Vec<Value>>) -> String {
        let Some(kids) = content else { return String::new() };
        kids.iter()
            .map(|n| {
                if n.get("type").and_then(|t| t.as_str()) == Some("hardBreak") {
                    return "\n".to_string();
                }
                let mut t = n.get("text").and_then(|t| t.as_str()).unwrap_or("").to_string();
                if t.is_empty() {
                    // Non-text inline node (mention, timestampChip…): recurse.
                    return inline(n.get("content").and_then(|c| c.as_array()));
                }
                let marks: Vec<&str> = n
                    .get("marks")
                    .and_then(|m| m.as_array())
                    .map(|ms| ms.iter().filter_map(|m| m.get("type").and_then(|t| t.as_str())).collect())
                    .unwrap_or_default();
                if marks.contains(&"code") {
                    t = format!("`{t}`");
                }
                if marks.contains(&"bold") {
                    t = format!("**{t}**");
                }
                if marks.contains(&"italic") {
                    t = format!("*{t}*");
                }
                if marks.contains(&"strike") {
                    t = format!("~~{t}~~");
                }
                if marks.contains(&"link") {
                    // Same safety rule as the frontend: unsafe schemes fall
                    // back to plain text.
                    let href = n
                        .get("marks")
                        .and_then(|m| m.as_array())
                        .and_then(|ms| {
                            ms.iter().find(|m| m.get("type").and_then(|t| t.as_str()) == Some("link"))
                        })
                        .and_then(|m| m.pointer("/attrs/href"))
                        .and_then(|h| h.as_str())
                        .filter(|h| {
                            let h = h.trim().to_ascii_lowercase();
                            h.starts_with("http://") || h.starts_with("https://") || h.starts_with("mailto:")
                        });
                    if let Some(href) = href {
                        t = format!("[{t}]({})", href.trim());
                    }
                }
                t
            })
            .collect()
    }

    fn list_items(node: &Value, ordered: bool, depth: usize, out: &mut Vec<String>) {
        let indent = "  ".repeat(depth);
        for (i, li) in node.get("content").and_then(|c| c.as_array()).into_iter().flatten().enumerate() {
            for child in li.get("content").and_then(|c| c.as_array()).into_iter().flatten() {
                let ty = child.get("type").and_then(|t| t.as_str()).unwrap_or("");
                if ty == "bulletList" || ty == "orderedList" {
                    block(child, depth + 1, out);
                } else {
                    let marker = if ordered { format!("{}. ", i + 1) } else { "- ".to_string() };
                    out.push(format!(
                        "{indent}{marker}{}",
                        inline(child.get("content").and_then(|c| c.as_array()))
                    ));
                }
            }
        }
    }

    fn block(node: &Value, depth: usize, out: &mut Vec<String>) {
        let ty = node.get("type").and_then(|t| t.as_str()).unwrap_or("");
        let content = node.get("content").and_then(|c| c.as_array());
        match ty {
            "heading" => {
                let level = node
                    .pointer("/attrs/level")
                    .and_then(|l| l.as_u64())
                    .unwrap_or(1)
                    .min(6) as usize;
                out.push(format!("{} {}", "#".repeat(level), inline(content)));
            }
            "paragraph" => out.push(inline(content)),
            "summary" => out.push(format!("> **Summary** — {}", inline(content))),
            "actionItem" => {
                let done = node.pointer("/attrs/done").and_then(|d| d.as_bool()).unwrap_or(false);
                let task = node.pointer("/attrs/task").and_then(|t| t.as_str()).unwrap_or("");
                let mut extras: Vec<String> = Vec::new();
                if let Some(a) = node.pointer("/attrs/assignee").and_then(|a| a.as_str()) {
                    if !a.trim().is_empty() {
                        extras.push(format!("@{}", a.trim()));
                    }
                }
                if let Some(d) = node.pointer("/attrs/deadline").and_then(|d| d.as_str()) {
                    if !d.trim().is_empty() {
                        extras.push(format!("due {}", d.trim()));
                    }
                }
                let suffix = if extras.is_empty() {
                    String::new()
                } else {
                    format!(" ({})", extras.join(", "))
                };
                out.push(format!("- [{}] {task}{suffix}", if done { "x" } else { " " }));
            }
            "bulletList" => list_items(node, false, depth, out),
            "orderedList" => list_items(node, true, depth, out),
            "taskList" => {
                for li in content.into_iter().flatten() {
                    let checked =
                        li.pointer("/attrs/checked").and_then(|c| c.as_bool()).unwrap_or(false);
                    let text = li
                        .get("content")
                        .and_then(|c| c.as_array())
                        .and_then(|c| c.first())
                        .map(|p| inline(p.get("content").and_then(|c| c.as_array())))
                        .unwrap_or_default();
                    out.push(format!("- [{}] {text}", if checked { "x" } else { " " }));
                }
            }
            "blockquote" => {
                let mut inner = Vec::new();
                for c in content.into_iter().flatten() {
                    block(c, depth, &mut inner);
                }
                for line in inner {
                    out.push(format!("> {line}"));
                }
            }
            "codeBlock" => out.push(format!("```\n{}\n```", inline(content))),
            "horizontalRule" => out.push("---".to_string()),
            _ => {
                let text = inline(content);
                if !text.is_empty() {
                    out.push(text);
                } else {
                    // Container nodes (callout, toggle…): recurse into blocks.
                    for c in content.into_iter().flatten() {
                        block(c, depth, out);
                    }
                }
            }
        }
    }

    let Ok(v) = serde_json::from_str::<Value>(raw) else {
        return String::new();
    };
    let mut out = Vec::new();
    for n in v.get("content").and_then(|c| c.as_array()).into_iter().flatten() {
        block(n, 0, &mut out);
    }
    out.retain(|l| !l.trim().is_empty());
    out.join("\n")
}

/// All text content of a TipTap doc, whitespace-collapsed. `pub` so the
/// perchnote-mcp bin renders notes the same way search matching does.
pub fn plain_text_of_tiptap(raw: &str) -> String {
    fn walk(v: &serde_json::Value, out: &mut Vec<String>) {
        if let Some(t) = v.get("text").and_then(|t| t.as_str()) {
            out.push(t.to_string());
        }
        if let Some(kids) = v.get("content").and_then(|c| c.as_array()) {
            for k in kids {
                walk(k, out);
            }
        }
    }
    let Ok(v) = serde_json::from_str::<serde_json::Value>(raw) else {
        return String::new();
    };
    let mut parts = Vec::new();
    walk(&v, &mut parts);
    parts.join(" ").split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use crate::db::Database;
    use rusqlite::params;

    fn db() -> Database {
        Database::new_in_memory().unwrap()
    }

    // --- Meetings ---

    #[test]
    fn test_create_meeting_returns_meeting_with_correct_title() {
        let db = db();
        let m = db.create_meeting("Standup").unwrap();
        assert_eq!(m.title, "Standup");
        assert!(!m.id.is_empty());
        assert_eq!(m.status, "upcoming");
        assert_eq!(m.platform, "unknown");
        assert!(!m.is_pinned);
        assert!(!m.is_archived);
        assert!(m.deleted_at.is_none());
    }

    #[test]
    fn title_cas_only_swaps_the_expected_title() {
        let db = db();
        let m = db.create_meeting("Untitled Meeting").unwrap();
        assert!(db
            .update_meeting_title_if_unchanged(&m.id, "Untitled Meeting", "Acme renewal kickoff")
            .unwrap());
        // A second pass holding the stale placeholder must not clobber.
        assert!(!db
            .update_meeting_title_if_unchanged(&m.id, "Untitled Meeting", "Something else")
            .unwrap());
        assert_eq!(
            db.get_meeting(&m.id).unwrap().unwrap().title,
            "Acme renewal kickoff"
        );
    }

    #[test]
    fn meeting_sort_dates_coalesces_and_skips_unknown_ids() {
        let db = db();
        let by_created = db.create_meeting("Created only").unwrap();
        let by_actual = db.create_meeting("Actually started").unwrap();
        db.update_meeting_times(&by_actual.id, Some("2026-01-02T03:04:05Z"), None)
            .unwrap();

        let ids = vec![
            by_created.id.clone(),
            by_actual.id.clone(),
            "no-such-meeting".to_string(),
        ];
        let dates = db.meeting_sort_dates(&ids).unwrap();
        assert_eq!(dates.len(), 2, "unknown ids are absent, not errors");
        assert_eq!(dates[&by_created.id], by_created.created_at);
        assert_eq!(dates[&by_actual.id], "2026-01-02T03:04:05Z");
        assert!(db.meeting_sort_dates(&[]).unwrap().is_empty());
    }

    #[test]
    fn test_get_meeting_returns_none_for_unknown_id() {
        let db = db();
        let result = db.get_meeting("nonexistent-id").unwrap();
        assert!(result.is_none());
    }

    #[test]
    fn test_get_meeting_returns_created_meeting() {
        let db = db();
        let m = db.create_meeting("Retrospective").unwrap();
        let fetched = db.get_meeting(&m.id).unwrap().unwrap();
        assert_eq!(fetched.id, m.id);
        assert_eq!(fetched.title, "Retrospective");
    }

    #[test]
    fn test_list_meetings_excludes_deleted_and_archived() {
        let db = db();
        let active = db.create_meeting("Active").unwrap();
        let archived = db.create_meeting("Archived").unwrap();
        let deleted = db.create_meeting("Deleted").unwrap();
        db.archive_meeting(&archived.id).unwrap();
        db.soft_delete_meeting(&deleted.id).unwrap();

        let list = db.list_meetings().unwrap();
        let ids: Vec<&str> = list.iter().map(|m| m.id.as_str()).collect();
        assert!(ids.contains(&active.id.as_str()));
        assert!(!ids.contains(&archived.id.as_str()));
        assert!(!ids.contains(&deleted.id.as_str()));
    }

    #[test]
    fn test_list_meetings_pinned_comes_first() {
        let db = db();
        let a = db.create_meeting("Regular").unwrap();
        let b = db.create_meeting("Pinned").unwrap();
        db.toggle_pin_meeting(&b.id).unwrap();

        let list = db.list_meetings().unwrap();
        assert_eq!(list[0].id, b.id, "pinned meeting should be first");
        assert_eq!(list[1].id, a.id);
    }

    #[test]
    fn test_update_meeting_title() {
        let db = db();
        let m = db.create_meeting("Old Title").unwrap();
        db.update_meeting_title(&m.id, "New Title").unwrap();
        let fetched = db.get_meeting(&m.id).unwrap().unwrap();
        assert_eq!(fetched.title, "New Title");
    }

    #[test]
    fn test_update_meeting_status() {
        let db = db();
        let m = db.create_meeting("Meeting").unwrap();
        db.update_meeting_status(&m.id, "recording").unwrap();
        let fetched = db.get_meeting(&m.id).unwrap().unwrap();
        assert_eq!(fetched.status, "recording");
    }

    #[test]
    fn test_toggle_pin_meeting_returns_new_state() {
        let db = db();
        let m = db.create_meeting("Meeting").unwrap();
        assert!(!m.is_pinned);
        let pinned = db.toggle_pin_meeting(&m.id).unwrap();
        assert!(pinned);
        let unpinned = db.toggle_pin_meeting(&m.id).unwrap();
        assert!(!unpinned);
    }

    #[test]
    fn test_archive_unarchive_meeting() {
        let db = db();
        let m = db.create_meeting("Meeting").unwrap();
        db.archive_meeting(&m.id).unwrap();

        let active = db.list_meetings().unwrap();
        assert!(active.iter().all(|x| x.id != m.id));

        let archived = db.list_archived_meetings().unwrap();
        assert!(archived.iter().any(|x| x.id == m.id));

        db.unarchive_meeting(&m.id).unwrap();
        let active2 = db.list_meetings().unwrap();
        assert!(active2.iter().any(|x| x.id == m.id));
    }

    #[test]
    fn test_soft_delete_and_restore_meeting() {
        let db = db();
        let m = db.create_meeting("Meeting").unwrap();
        db.soft_delete_meeting(&m.id).unwrap();

        // Must not appear in active list
        let active = db.list_meetings().unwrap();
        assert!(active.iter().all(|x| x.id != m.id));

        // Must appear in deleted list
        let deleted = db.list_deleted_meetings().unwrap();
        assert!(deleted.iter().any(|x| x.id == m.id));

        // deleted_at is set
        let fetched = db.get_meeting(&m.id).unwrap().unwrap();
        assert!(fetched.deleted_at.is_some());

        // Restore clears deleted_at
        db.restore_meeting(&m.id).unwrap();
        let fetched2 = db.get_meeting(&m.id).unwrap().unwrap();
        assert!(fetched2.deleted_at.is_none());
    }

    #[test]
    fn test_hard_delete_removes_meeting() {
        let db = db();
        let m = db.create_meeting("Meeting").unwrap();
        db.delete_meeting(&m.id).unwrap();
        let fetched = db.get_meeting(&m.id).unwrap();
        assert!(fetched.is_none());
    }

    #[test]
    fn test_hard_delete_cascades_to_notes() {
        let db = db();
        let m = db.create_meeting("Meeting").unwrap();
        db.create_note(&m.id, None).unwrap();
        db.delete_meeting(&m.id).unwrap();

        let note = db.get_note_by_meeting(&m.id).unwrap();
        assert!(note.is_none(), "note should be cascade-deleted with meeting");
    }

    #[test]
    fn test_hard_delete_cascades_to_transcripts() {
        let db = db();
        let m = db.create_meeting("Meeting").unwrap();
        db.create_transcript(&m.id, "local").unwrap();
        db.delete_meeting(&m.id).unwrap();

        let t = db.get_transcript_by_meeting(&m.id).unwrap();
        assert!(t.is_none(), "transcript should be cascade-deleted with meeting");
    }

    // --- Notes ---

    #[test]
    fn test_create_note_has_empty_content() {
        let db = db();
        let m = db.create_meeting("M").unwrap();
        let note = db.create_note(&m.id, None).unwrap();
        assert_eq!(note.meeting_id, m.id);
        assert!(note.raw_content.is_none());
        assert!(note.generated_content.is_none());
        assert!(note.template_id.is_none());
    }

    #[test]
    fn test_get_note_by_meeting_returns_none_if_no_note() {
        let db = db();
        let m = db.create_meeting("M").unwrap();
        let note = db.get_note_by_meeting(&m.id).unwrap();
        assert!(note.is_none());
    }

    #[test]
    fn test_update_note_raw_content() {
        let db = db();
        let m = db.create_meeting("M").unwrap();
        let note = db.create_note(&m.id, None).unwrap();
        db.update_note_raw_content(&note.id, "# My notes").unwrap();
        let fetched = db.get_note_by_meeting(&m.id).unwrap().unwrap();
        assert_eq!(fetched.raw_content.unwrap(), "# My notes");
    }

    #[test]
    fn test_update_note_generated_content() {
        let db = db();
        let m = db.create_meeting("M").unwrap();
        let note = db.create_note(&m.id, None).unwrap();
        let json = r#"{"title":"T","summary":"S","sections":[],"action_items":[],"tags":[]}"#;
        db.update_note_generated_content(&note.id, json).unwrap();
        let fetched = db.get_note_by_meeting(&m.id).unwrap().unwrap();
        assert_eq!(fetched.generated_content.unwrap(), json);
    }

    #[test]
    fn test_get_or_create_note_is_idempotent() {
        let db = db();
        let m = db.create_meeting("M").unwrap();
        // First call creates the row.
        let a = db.get_or_create_note(&m.id).unwrap();
        // Second call must return the SAME row, not a duplicate.
        let b = db.get_or_create_note(&m.id).unwrap();
        assert_eq!(a.id, b.id);

        // And it must not clobber content written between calls.
        db.update_note_generated_content(&a.id, "GEN").unwrap();
        let c = db.get_or_create_note(&m.id).unwrap();
        assert_eq!(c.id, a.id);
        assert_eq!(c.generated_content.unwrap(), "GEN");
    }

    #[test]
    fn test_get_or_create_note_returns_existing() {
        let db = db();
        let m = db.create_meeting("M").unwrap();
        let created = db.create_note(&m.id, None).unwrap();
        let got = db.get_or_create_note(&m.id).unwrap();
        assert_eq!(got.id, created.id);
    }

    // A doc with two action items: "A" at top level (index 0) and "B" nested
    // inside a bullet list (index 1, done).
    const TWO_ACTION_ITEMS: &str = r#"{"type":"doc","content":[
        {"type":"actionItem","attrs":{"task":"A","assignee":"Amy","deadline":"2026-06-10","done":false}},
        {"type":"bulletList","content":[{"type":"listItem","content":[
            {"type":"actionItem","attrs":{"task":"B","assignee":null,"deadline":null,"done":true}}
        ]}]}
    ]}"#;

    #[test]
    fn test_list_action_items_extracts_in_document_order() {
        let db = db();
        let m = db.create_meeting("Standup").unwrap();
        let note = db.create_note(&m.id, None).unwrap();
        db.update_note_generated_content(&note.id, TWO_ACTION_ITEMS).unwrap();

        let items = db.list_action_items().unwrap();
        assert_eq!(items.len(), 2);

        assert_eq!(items[0].task, "A");
        assert_eq!(items[0].index, 0);
        assert_eq!(items[0].source, "generated");
        assert_eq!(items[0].assignee.as_deref(), Some("Amy"));
        assert_eq!(items[0].deadline.as_deref(), Some("2026-06-10"));
        assert!(!items[0].done);
        assert_eq!(items[0].meeting_id, m.id);
        assert_eq!(items[0].meeting_title, "Standup");

        assert_eq!(items[1].task, "B"); // nested still found, in order
        assert_eq!(items[1].index, 1);
        assert!(items[1].done);
        assert_eq!(items[1].assignee, None);
    }

    #[test]
    fn test_list_action_items_excludes_archived_and_deleted() {
        let db = db();
        for (title, hide) in [("archived", "a"), ("deleted", "d"), ("active", "")] {
            let m = db.create_meeting(title).unwrap();
            let note = db.create_note(&m.id, None).unwrap();
            db.update_note_generated_content(&note.id, TWO_ACTION_ITEMS).unwrap();
            match hide {
                "a" => db.archive_meeting(&m.id).unwrap(),
                "d" => db.soft_delete_meeting(&m.id).unwrap(),
                _ => {}
            }
        }
        let items = db.list_action_items().unwrap();
        // Only the active meeting's two items remain.
        assert_eq!(items.len(), 2);
        assert!(items.iter().all(|i| i.meeting_title == "active"));
    }

    #[test]
    fn test_list_action_items_skips_malformed_json() {
        let db = db();
        let m = db.create_meeting("M").unwrap();
        let note = db.create_note(&m.id, None).unwrap();
        db.update_note_raw_content(&note.id, "this is not json").unwrap();
        db.update_note_generated_content(&note.id, TWO_ACTION_ITEMS).unwrap();
        // Malformed raw body is skipped; generated body still yields its items.
        let items = db.list_action_items().unwrap();
        assert_eq!(items.len(), 2);
        assert!(items.iter().all(|i| i.source == "generated"));
    }

    #[test]
    fn write_back_relocates_by_text_when_items_shift_and_overlays_never_retarget() {
        // Migration 19: position is fragile, text anchors identity.
        let db = db();
        let m = db.create_meeting("M").unwrap();
        let note = db.create_note(&m.id, None).unwrap();
        db.update_note_generated_content(&note.id, TWO_ACTION_ITEMS).unwrap();
        // Snooze "B" (idx 1) with its text anchor recorded.
        db.set_task_snooze(&note.id, "generated", 1, Some("2099-01-01"), Some("B")).unwrap();
        // An edit removes item A — B shifts to idx 0.
        let only_b = r#"{"type":"doc","content":[
            {"type":"actionItem","attrs":{"task":"B","assignee":null,"deadline":null,"done":false}}
        ]}"#;
        db.update_note_generated_content(&note.id, only_b).unwrap();
        // A stale positional write aimed at idx 1 with anchor "B" relocates
        // to idx 0 instead of failing or flipping a stranger.
        db.set_action_item_done(&note.id, "generated", 1, true, Some("B")).unwrap();
        let items = db.list_action_items().unwrap();
        assert_eq!(items.len(), 1);
        assert!(items[0].done, "relocated write-back hit B");
        // The overlay recorded for ("generated", 1, "B") does NOT decorate
        // whatever sits at idx 1 now (nothing) nor B at idx 0 positionally
        // — lost beats wrong.
        assert!(items[0].snoozed_until.is_none(), "stale overlay must not re-target");
        // An anchor pointing at vanished text refuses rather than guesses.
        assert!(db.set_action_item_done(&note.id, "generated", 0, true, Some("gone")).is_err());
    }

    #[test]
    fn test_set_action_item_done_writes_back_nth_node() {
        let db = db();
        let m = db.create_meeting("M").unwrap();
        let note = db.create_note(&m.id, None).unwrap();
        db.update_note_generated_content(&note.id, TWO_ACTION_ITEMS).unwrap();

        // Flip item 0 (A) to done, and item 1 (B) to not-done.
        db.set_action_item_done(&note.id, "generated", 0, true, None).unwrap();
        db.set_action_item_done(&note.id, "generated", 1, false, None).unwrap();

        let items = db.list_action_items().unwrap();
        assert!(items[0].done, "A should now be done");
        assert!(!items[1].done, "B should now be not done");

        // Other attrs preserved (not clobbered).
        assert_eq!(items[0].task, "A");
        assert_eq!(items[0].assignee.as_deref(), Some("Amy"));
    }

    #[test]
    fn test_set_action_item_done_out_of_range_errors() {
        let db = db();
        let m = db.create_meeting("M").unwrap();
        let note = db.create_note(&m.id, None).unwrap();
        db.update_note_generated_content(&note.id, TWO_ACTION_ITEMS).unwrap();
        assert!(db.set_action_item_done(&note.id, "generated", 9, true, None).is_err());
        assert!(db.set_action_item_done(&note.id, "raw", 0, true, None).is_err()); // raw empty
    }

    #[test]
    fn test_create_note_with_template_id() {
        let db = db();
        let m = db.create_meeting("M").unwrap();
        let t = db.create_template("T", None, "prompt", "[]", false, false).unwrap();
        let note = db.create_note(&m.id, Some(&t.id)).unwrap();
        assert_eq!(note.template_id.unwrap(), t.id);
    }

    // --- Transcripts ---

    #[test]
    fn test_create_transcript_and_get_by_meeting() {
        let db = db();
        let m = db.create_meeting("M").unwrap();
        db.create_transcript(&m.id, "local").unwrap();
        let t = db.get_transcript_by_meeting(&m.id).unwrap();
        assert!(t.is_some());
        let t = t.unwrap();
        assert_eq!(t.meeting_id, m.id);
        assert_eq!(t.source, "local");
        assert_eq!(t.language, "en");
        assert_eq!(t.segments, "[]");
    }

    #[test]
    fn test_get_transcript_by_meeting_returns_none_when_absent() {
        let db = db();
        let m = db.create_meeting("M").unwrap();
        assert!(db.get_transcript_by_meeting(&m.id).unwrap().is_none());
    }

    #[test]
    fn test_update_transcript_segments() {
        let db = db();
        let m = db.create_meeting("M").unwrap();
        let t = db.create_transcript(&m.id, "local").unwrap();
        let segs = r#"[{"text":"Hello","start_ms":0,"end_ms":1000,"speaker":"A"}]"#;
        db.update_transcript_segments(&t.id, segs).unwrap();
        let fetched = db.get_transcript_by_meeting(&m.id).unwrap().unwrap();
        assert_eq!(fetched.segments, segs);
    }

    // --- FTS5 Search ---

    #[test]
    fn test_fts_search_finds_transcript_text() {
        let db = db();
        let m = db.create_meeting("Budget Meeting").unwrap();
        let t = db.create_transcript(&m.id, "local").unwrap();
        let segs = r#"[{"text":"We discussed the quarterly budget allocation","start_ms":0,"end_ms":2000,"speaker":"A"}]"#;
        db.update_transcript_segments(&t.id, segs).unwrap();

        let results = db.search_transcripts("quarterly budget", 100).unwrap();
        assert!(!results.is_empty(), "FTS should return results for 'quarterly budget'");
    }

    #[test]
    fn test_fts_search_returns_empty_for_no_match() {
        let db = db();
        let m = db.create_meeting("Meeting").unwrap();
        let t = db.create_transcript(&m.id, "local").unwrap();
        db.update_transcript_segments(&t.id, r#"[{"text":"Hello world","start_ms":0,"end_ms":1000,"speaker":"A"}]"#).unwrap();

        let results = db.search_transcripts("xyznonexistent", 100).unwrap();
        assert!(results.is_empty());
    }

    #[test]
    fn test_fts_index_updated_after_segment_update() {
        let db = db();
        let m = db.create_meeting("Meeting").unwrap();
        let t = db.create_transcript(&m.id, "local").unwrap();

        // First update: no mention of "roadmap"
        db.update_transcript_segments(&t.id, r#"[{"text":"General discussion","start_ms":0,"end_ms":1000,"speaker":"A"}]"#).unwrap();
        assert!(db.search_transcripts("roadmap", 100).unwrap().is_empty());

        // Second update: now mentions "roadmap"
        db.update_transcript_segments(&t.id, r#"[{"text":"The roadmap for Q3 was reviewed","start_ms":0,"end_ms":2000,"speaker":"A"}]"#).unwrap();
        let results = db.search_transcripts("roadmap", 100).unwrap();
        assert!(!results.is_empty(), "FTS should reflect updated segment content");
    }

    #[test]
    fn test_fts_search_respects_limit() {
        let db = db();
        // Create 5 meetings each with "budget" in transcript
        for i in 0..5 {
            let m = db.create_meeting(&format!("Meeting {i}")).unwrap();
            let t = db.create_transcript(&m.id, "local").unwrap();
            let seg = format!(r#"[{{"text":"budget discussion {i}","start_ms":0,"end_ms":1000,"speaker":"A"}}]"#);
            db.update_transcript_segments(&t.id, &seg).unwrap();
        }
        let results = db.search_transcripts("budget", 3).unwrap();
        assert!(results.len() <= 3, "search should respect the limit");
    }

    // --- Folders ---

    #[test]
    fn test_create_folder_with_defaults() {
        let db = db();
        let f = db.create_folder("Work", "#ff0000", "💼", None).unwrap();
        assert_eq!(f.name, "Work");
        assert_eq!(f.color, "#ff0000");
        assert_eq!(f.icon, "💼");
    }

    #[test]
    fn test_list_folders_ordered_by_sort_order() {
        let db = db();
        db.create_folder("Z", "#aaa", "📁", None).unwrap();
        db.create_folder("A", "#bbb", "📁", None).unwrap();
        let all = db.list_folders().unwrap();
        let ids: Vec<String> = all.iter().map(|f| f.id.clone()).collect();
        db.reorder_folders(&ids, None).unwrap();
        let ordered = db.list_folders().unwrap();
        assert_eq!(ordered[0].id, ids[0]);
        assert_eq!(ordered[1].id, ids[1]);
    }

    #[test]
    fn test_add_and_remove_meeting_from_folder() {
        let db = db();
        let m = db.create_meeting("M").unwrap();
        let f = db.create_folder("Work", "#aaa", "📁", None).unwrap();
        db.add_meeting_to_folder(&m.id, &f.id).unwrap();

        let ids = db.get_meeting_ids_in_folder(&f.id).unwrap();
        assert!(ids.contains(&m.id));

        db.remove_meeting_from_folder(&m.id, &f.id).unwrap();
        let ids2 = db.get_meeting_ids_in_folder(&f.id).unwrap();
        assert!(!ids2.contains(&m.id));
    }

    #[test]
    fn test_delete_folder_cascades_junction() {
        let db = db();
        let m = db.create_meeting("M").unwrap();
        let f = db.create_folder("Work", "#aaa", "📁", None).unwrap();
        db.add_meeting_to_folder(&m.id, &f.id).unwrap();
        db.delete_folder(&f.id).unwrap();

        // Meeting still exists
        assert!(db.get_meeting(&m.id).unwrap().is_some());
        // Folder is gone
        let folders = db.list_folders().unwrap();
        assert!(folders.iter().all(|x| x.id != f.id));
    }

    #[test]
    fn test_reorder_folders_updates_sort_order() {
        let db = db();
        let f1 = db.create_folder("First", "#aaa", "📁", None).unwrap();
        let f2 = db.create_folder("Second", "#bbb", "📁", None).unwrap();
        // Reverse the order
        db.reorder_folders(&[f2.id.clone(), f1.id.clone()], None).unwrap();
        let ordered = db.list_folders().unwrap();
        assert_eq!(ordered[0].id, f2.id, "f2 should now be first");
        assert_eq!(ordered[1].id, f1.id, "f1 should now be second");
    }

    #[test]
    fn test_first_folder_name_follows_sidebar_order() {
        let db = db();
        let m = db.create_meeting("M").unwrap();
        assert_eq!(db.get_first_folder_name_for_meeting(&m.id).unwrap(), None);

        let f1 = db.create_folder("First", "#aaa", "📁", None).unwrap();
        let f2 = db.create_folder("Second", "#bbb", "📁", None).unwrap();
        db.add_meeting_to_folder(&m.id, &f2.id).unwrap();
        db.add_meeting_to_folder(&m.id, &f1.id).unwrap();
        assert_eq!(
            db.get_first_folder_name_for_meeting(&m.id).unwrap().as_deref(),
            Some("First")
        );
        // Reordering the sidebar changes which folder is "first".
        db.reorder_folders(&[f2.id.clone(), f1.id.clone()], None).unwrap();
        assert_eq!(
            db.get_first_folder_name_for_meeting(&m.id).unwrap().as_deref(),
            Some("Second")
        );
    }

    // --- Tags ---

    #[test]
    fn test_create_tag_and_list() {
        let db = db();
        db.create_tag("engineering", "manual").unwrap();
        let tags = db.list_tags().unwrap();
        assert!(tags.iter().any(|t| t.name == "engineering"));
    }

    #[test]
    fn test_create_tag_unique_name_constraint() {
        let db = db();
        let first = db.create_tag("unique-tag", "manual").unwrap();
        // create_tag uses INSERT OR IGNORE, so a second call succeeds but returns a
        // new struct with a fresh UUID — while the DB still holds only the first row.
        // We verify uniqueness by checking that only one tag with this name exists.
        let _second = db.create_tag("unique-tag", "manual").unwrap();
        let tags = db.list_tags().unwrap();
        let matching: Vec<_> = tags.iter().filter(|t| t.name == "unique-tag").collect();
        assert_eq!(matching.len(), 1, "duplicate tag name must not create a second row");
        assert_eq!(matching[0].id, first.id, "the stored tag must be the first one inserted");
    }

    #[test]
    fn test_add_and_remove_tag_from_meeting() {
        let db = db();
        let m = db.create_meeting("M").unwrap();
        let tag = db.create_tag("q3", "manual").unwrap();
        db.add_tag_to_meeting(&m.id, &tag.id).unwrap();

        let tags = db.get_meeting_tags(&m.id).unwrap();
        assert!(tags.iter().any(|t| t.id == tag.id));

        db.remove_tag_from_meeting(&m.id, &tag.id).unwrap();
        let tags2 = db.get_meeting_tags(&m.id).unwrap();
        assert!(tags2.iter().all(|t| t.id != tag.id));
    }

    #[test]
    fn test_get_tags_for_meetings_batches_and_groups() {
        let db = db();
        let m1 = db.create_meeting("M1").unwrap();
        let m2 = db.create_meeting("M2").unwrap();
        let m3 = db.create_meeting("M3").unwrap(); // no tags
        let t1 = db.create_tag("alpha", "manual").unwrap();
        let t2 = db.create_tag("beta", "manual").unwrap();
        db.add_tag_to_meeting(&m1.id, &t1.id).unwrap();
        db.add_tag_to_meeting(&m1.id, &t2.id).unwrap();
        db.add_tag_to_meeting(&m2.id, &t2.id).unwrap();

        let map = db
            .get_tags_for_meetings(&[m1.id.clone(), m2.id.clone(), m3.id.clone()])
            .unwrap();
        let m1_names: Vec<_> = map[&m1.id].iter().map(|t| t.name.as_str()).collect();
        assert_eq!(m1_names, vec!["alpha", "beta"], "tags sorted by name");
        assert_eq!(map[&m2.id].len(), 1);
        assert!(!map.contains_key(&m3.id), "untagged meetings are absent");

        assert!(db.get_tags_for_meetings(&[]).unwrap().is_empty());
    }

    #[test]
    fn test_delete_meeting_cascades_meeting_tags() {
        let db = db();
        let m = db.create_meeting("M").unwrap();
        let tag = db.create_tag("cascade", "manual").unwrap();
        db.add_tag_to_meeting(&m.id, &tag.id).unwrap();
        db.delete_meeting(&m.id).unwrap();

        // Tag itself still exists
        let tags = db.list_tags().unwrap();
        assert!(tags.iter().any(|t| t.id == tag.id), "tag itself must survive meeting deletion");
    }

    // --- Crash reconciliation / atomic note writes / search hygiene ---

    #[test]
    fn test_reconcile_interrupted_meetings_completes_stuck_rows() {
        let db = db();
        let m1 = db.create_meeting("Crashed").unwrap();
        let m2 = db.create_meeting("Fine").unwrap();
        let m3 = db.create_meeting("Legacy zombie").unwrap();
        db.update_meeting_status(&m1.id, "recording").unwrap();
        db.update_meeting_status(&m2.id, "complete").unwrap();
        db.update_meeting_status(&m3.id, "generating").unwrap();

        let stuck = db.reconcile_interrupted_meetings().unwrap();
        assert_eq!(stuck.len(), 2);
        assert!(stuck.contains(&m1.id) && stuck.contains(&m3.id));
        assert_eq!(db.get_meeting(&m3.id).unwrap().unwrap().status, "complete");
        assert_eq!(db.get_meeting(&m1.id).unwrap().unwrap().status, "complete");
        // Second run is a no-op
        assert!(db.reconcile_interrupted_meetings().unwrap().is_empty());
    }

    #[test]
    fn test_update_note_contents_atomic_and_preserves_raw() {
        let db = db();
        let m = db.create_meeting("M").unwrap();
        let note = db.create_note(&m.id, None).unwrap();
        db.update_note_raw_content(&note.id, "{\"raw\":1}").unwrap();

        // None leaves raw untouched
        db.update_note_contents(&note.id, None, "{\"gen\":1}").unwrap();
        let n = db.get_note_by_id(&note.id).unwrap().unwrap();
        assert_eq!(n.raw_content.as_deref(), Some("{\"raw\":1}"));
        assert_eq!(n.generated_content.as_deref(), Some("{\"gen\":1}"));

        // Some(raw) writes both in one statement
        db.update_note_contents(&note.id, Some("{\"raw\":2}"), "{\"gen\":2}").unwrap();
        let n = db.get_note_by_id(&note.id).unwrap().unwrap();
        assert_eq!(n.raw_content.as_deref(), Some("{\"raw\":2}"));
        assert_eq!(n.generated_content.as_deref(), Some("{\"gen\":2}"));
    }

    // --- Enhance receipts (plan v10 #2) ---

    #[test]
    fn test_receipt_fields_round_trip_and_absent_by_default() {
        let db = db();
        let m = db.create_meeting("M").unwrap();
        let note = db.create_note(&m.id, None).unwrap();

        // Never-enhanced note: all receipt fields absent.
        let n = db.get_note_by_id(&note.id).unwrap().unwrap();
        assert!(n.generated_provider.is_none());
        assert!(n.generated_model.is_none());
        assert!(n.generated_at.is_none());
        assert!(n.generated_transcript_sha.is_none());
        assert!(n.generated_previous.is_none());

        db.update_note_generated_with_receipt(
            &note.id,
            Some("{\"raw\":1}"),
            "{\"gen\":1}",
            "anthropic",
            "claude-sonnet-4-6",
            Some("abc123"),
        )
        .unwrap();

        let n = db.get_note_by_id(&note.id).unwrap().unwrap();
        assert_eq!(n.raw_content.as_deref(), Some("{\"raw\":1}"));
        assert_eq!(n.generated_content.as_deref(), Some("{\"gen\":1}"));
        assert_eq!(n.generated_provider.as_deref(), Some("anthropic"));
        assert_eq!(n.generated_model.as_deref(), Some("claude-sonnet-4-6"));
        assert!(n.generated_at.is_some(), "generated_at stamped at persist time");
        assert_eq!(n.generated_transcript_sha.as_deref(), Some("abc123"));
        // First enhance: nothing to remember yet.
        assert!(n.generated_previous.is_none());

        // get_note_by_meeting reads the same columns.
        let by_meeting = db.get_note_by_meeting(&m.id).unwrap().unwrap();
        assert_eq!(by_meeting.generated_provider.as_deref(), Some("anthropic"));
    }

    #[test]
    fn test_regenerate_fills_previous_slot_and_restore_swaps_both_ways() {
        let db = db();
        let m = db.create_meeting("M").unwrap();
        let note = db.create_note(&m.id, None).unwrap();

        db.update_note_generated_with_receipt(
            &note.id, None, "{\"gen\":\"v1\"}", "anthropic", "claude-sonnet-4-6", Some("sha-v1"),
        ).unwrap();
        let v1_at = db.get_note_by_id(&note.id).unwrap().unwrap().generated_at;

        // Re-enhance with a different provider: v1 (content + receipts)
        // moves into the one previous slot.
        db.update_note_generated_with_receipt(
            &note.id, None, "{\"gen\":\"v2\"}", "ollama", "llama3.2", Some("sha-v2"),
        ).unwrap();
        let n = db.get_note_by_id(&note.id).unwrap().unwrap();
        assert_eq!(n.generated_content.as_deref(), Some("{\"gen\":\"v2\"}"));
        assert_eq!(n.generated_provider.as_deref(), Some("ollama"));
        let env: serde_json::Value =
            serde_json::from_str(n.generated_previous.as_deref().unwrap()).unwrap();
        assert_eq!(env["content"], "{\"gen\":\"v1\"}");
        assert_eq!(env["provider"], "anthropic");
        assert_eq!(env["model"], "claude-sonnet-4-6");
        assert_eq!(env["transcript_sha"], "sha-v1");

        // Restore: content AND receipts swap; the displaced v2 becomes the
        // new previous slot (restore is its own undo).
        let restored = db.restore_previous_generated(&note.id).unwrap();
        assert_eq!(restored.generated_content.as_deref(), Some("{\"gen\":\"v1\"}"));
        assert_eq!(restored.generated_provider.as_deref(), Some("anthropic"));
        assert_eq!(restored.generated_model.as_deref(), Some("claude-sonnet-4-6"));
        assert_eq!(restored.generated_transcript_sha.as_deref(), Some("sha-v1"));
        assert_eq!(restored.generated_at, v1_at, "v1's own timestamp comes back");
        let env2: serde_json::Value =
            serde_json::from_str(restored.generated_previous.as_deref().unwrap()).unwrap();
        assert_eq!(env2["content"], "{\"gen\":\"v2\"}");
        assert_eq!(env2["provider"], "ollama");
        assert_eq!(env2["transcript_sha"], "sha-v2");

        // Restore again: back to v2 — the swap is symmetric.
        let again = db.restore_previous_generated(&note.id).unwrap();
        assert_eq!(again.generated_content.as_deref(), Some("{\"gen\":\"v2\"}"));
        assert_eq!(again.generated_provider.as_deref(), Some("ollama"));
    }

    #[test]
    fn test_restore_without_previous_version_errors() {
        let db = db();
        let m = db.create_meeting("M").unwrap();
        let note = db.create_note(&m.id, None).unwrap();
        let err = db.restore_previous_generated(&note.id).unwrap_err();
        assert!(err.to_string().contains("no previous version"), "got: {err}");
    }

    #[test]
    fn test_transcript_sha_staleness_comparison() {
        let db = db();
        let m = db.create_meeting("M").unwrap();

        // No transcript at all → no hash → never "stale".
        assert!(db.transcript_sha(&m.id).unwrap().is_none());

        let t = db.create_transcript(&m.id, "local").unwrap();
        db.update_transcript_segments(
            &t.id,
            r#"[{"text":"alpha","start_ms":0,"end_ms":1000,"speaker":"A"}]"#,
        ).unwrap();

        // transcript_sha is the segments_snapshot hash — the receipt and the
        // accuracy pass agree on what "the transcript" hashes to.
        let sha_at_generation = db.transcript_sha(&m.id).unwrap().unwrap();
        let (_, snapshot_hash) = db.segments_snapshot(&m.id).unwrap().unwrap();
        assert_eq!(sha_at_generation, snapshot_hash);

        let note = db.create_note(&m.id, None).unwrap();
        db.update_note_generated_with_receipt(
            &note.id, None, "{\"gen\":1}", "anthropic", "claude-sonnet-4-6",
            Some(&sha_at_generation),
        ).unwrap();

        // Untouched transcript: hashes match → not stale.
        assert_eq!(db.transcript_sha(&m.id).unwrap().as_deref(), Some(sha_at_generation.as_str()));

        // A transcript correction after generation drifts the live hash —
        // exactly the comparison the stale badge makes.
        db.update_segment_text(&m.id, 0, "alpha corrected").unwrap();
        let live = db.transcript_sha(&m.id).unwrap().unwrap();
        assert_ne!(live, sha_at_generation, "edited transcript must hash differently");
        let stored = db.get_note_by_id(&note.id).unwrap().unwrap().generated_transcript_sha;
        assert_eq!(stored.as_deref(), Some(sha_at_generation.as_str()), "the receipt keeps the as-of-generation hash");
    }

    #[test]
    fn test_search_all_returns_match_start_ms_for_transcripts() {
        let db = db();
        let m = db.create_meeting("FTS jump test").unwrap();
        let t = db.create_transcript(&m.id, "test").unwrap();
        db.update_transcript_segments(
            &t.id,
            r#"[{"text":"hello there","start_ms":0,"end_ms":1000},
                {"text":"the zebra appears","start_ms":5000,"end_ms":6000}]"#,
        ).unwrap();

        let results = db.search_all("zebra", 10).unwrap();
        let hit = results
            .iter()
            .find(|r| r.match_source == "transcript")
            .expect("transcript hit expected");
        assert_eq!(hit.match_start_ms, Some(5000));
    }

    // --- Accuracy pass CAS (plan v10 #3) ---

    #[test]
    fn segment_swap_is_compare_and_swap() {
        let db = db();
        let m = db.create_meeting("M").unwrap();
        let t = db.create_transcript(&m.id, "test").unwrap();
        db.update_transcript_segments(
            &t.id,
            r#"[{"text":"live rough","start_ms":0,"end_ms":1000}]"#,
        ).unwrap();

        let (_json, hash) = db.segments_snapshot(&m.id).unwrap().unwrap();
        let upgraded = r#"[{"text":"whole-file precise","start_ms":0,"end_ms":1000}]"#;
        assert!(db.swap_segments_if_unchanged(&m.id, &hash, upgraded).unwrap());
        let stored = db.get_transcript_by_meeting(&m.id).unwrap().unwrap().segments;
        assert!(stored.contains("whole-file precise"));
        // FTS followed the swap (the sync triggers fire on the CAS update too).
        assert_eq!(db.search_transcripts("precise", 10).unwrap().len(), 1);
        assert!(db.search_transcripts("rough", 10).unwrap().is_empty());

        // Stale hash (a user edit happened meanwhile) -> no write, edit wins.
        assert!(!db.swap_segments_if_unchanged(&m.id, &hash, "[]").unwrap());
        let stored = db.get_transcript_by_meeting(&m.id).unwrap().unwrap().segments;
        assert!(stored.contains("whole-file precise"));
        // Unknown meeting -> false, not an error.
        assert!(!db.swap_segments_if_unchanged("nope", &hash, "[]").unwrap());
    }

    // --- Transcript correction (plan v9 #8) ---

    #[test]
    fn segment_text_edit_updates_fts_and_keeps_unknown_fields() {
        let db = db();
        let m = db.create_meeting("M").unwrap();
        let t = db.create_transcript(&m.id, "test").unwrap();
        db.update_transcript_segments(
            &t.id,
            r#"[{"text":"the kwarterly budget","start_ms":0,"end_ms":1000,"speaker":"A","custom_field":42}]"#,
        ).unwrap();

        assert!(db.update_segment_text(&m.id, 0, "the quarterly budget").unwrap());
        // FTS re-synced through the triggers: old token gone, new one found.
        assert!(db.search_transcripts("kwarterly", 10).unwrap().is_empty());
        assert_eq!(db.search_transcripts("quarterly", 10).unwrap().len(), 1);
        // Unknown JSON fields survive the raw-JSON round trip.
        let stored = db.get_transcript_by_meeting(&m.id).unwrap().unwrap().segments;
        assert!(stored.contains("\"custom_field\":42"), "{stored}");
        // Out-of-range index is a no-op, not an error.
        assert!(!db.update_segment_text(&m.id, 9, "x").unwrap());
    }

    #[test]
    fn replace_in_transcript_is_ascii_case_insensitive_and_counts_segments() {
        let db = db();
        let m = db.create_meeting("M").unwrap();
        let t = db.create_transcript(&m.id, "test").unwrap();
        db.update_transcript_segments(
            &t.id,
            r#"[{"text":"jon said hi","start_ms":0,"end_ms":1},
                {"text":"then Jon left, jon waved","start_ms":2,"end_ms":3},
                {"text":"unrelated","start_ms":4,"end_ms":5}]"#,
        ).unwrap();

        let n = db.replace_in_transcript(&m.id, "jon", "John").unwrap();
        assert_eq!(n, 2, "two segments touched");
        let stored = db.get_transcript_by_meeting(&m.id).unwrap().unwrap().segments;
        assert!(stored.contains("John said hi"));
        assert!(stored.contains("then John left, John waved"));
        assert!(!stored.to_lowercase().contains("jon "), "{stored}");
        // FTS reflects the fix.
        assert_eq!(db.search_transcripts("john", 10).unwrap().len(), 1);

        // Empty finds are refused; emoji content stays panic-free.
        assert_eq!(db.replace_in_transcript(&m.id, "  ", "x").unwrap(), 0);
        db.update_transcript_segments(
            &t.id,
            r#"[{"text":"🎉🎉 launch party 🎉","start_ms":0,"end_ms":1}]"#,
        ).unwrap();
        assert_eq!(db.replace_in_transcript(&m.id, "LAUNCH", "ship").unwrap(), 1);
        let stored = db.get_transcript_by_meeting(&m.id).unwrap().unwrap().segments;
        assert!(stored.contains("🎉🎉 ship party 🎉"));
    }

    // --- extract_snippet UTF-8 safety (QA audit P1) ---

    #[test]
    fn snippet_survives_multibyte_content() {
        // The auditor's exact repro: emoji padding before the match put the
        // arithmetic window edge inside a 🎉 and panicked the search path.
        let content = format!("{} launch task", "🎉".repeat(20));
        let s = super::extract_snippet(&content, "launch", 80);
        assert!(s.contains("launch"));

        // Multi-byte whitespace: U+00A0 is whitespace; the old `+ 1` after
        // rfind landed inside it.
        let s = super::extract_snippet("intro\u{00A0}budget talk", "budget", 8);
        assert!(s.contains("budget"));

        // Turkish İ lowercases to two chars — offsets shift; must not panic.
        let content = format!("{} budget here", "İ".repeat(30));
        let s = super::extract_snippet(&content, "budget", 20);
        assert!(!s.is_empty());

        // CJK around the match.
        let s = super::extract_snippet("会議の予算は budget 次の四半期", "budget", 10);
        assert!(s.contains("budget"));
    }

    #[test]
    fn snippet_plain_ascii_behavior_unchanged() {
        let s = super::extract_snippet("aaa bbb ccc needle ddd eee", "needle", 12);
        assert!(s.contains("needle"));
        let s = super::extract_snippet("no match here", "zzz", 5);
        assert_eq!(s, "no ma");
    }

    // --- Filter grammar (plan v8 A2) ---

    #[test]
    fn search_speaker_filter_narrows_to_labeled_speaker() {
        let db = db();
        let m = db.create_meeting("Sync").unwrap();
        let t = db.create_transcript(&m.id, "test").unwrap();
        db.update_transcript_segments(
            &t.id,
            r#"[{"text":"the budget is fine","start_ms":0,"end_ms":1,"speaker":"Speaker 1"},
                {"text":"budget needs another pass","start_ms":5000,"end_ms":6000,"speaker":"Speaker 2"}]"#,
        ).unwrap();
        db.upsert_speaker_label(&m.id, "Speaker 1", "Amy Patel", None, None).unwrap();
        db.upsert_speaker_label(&m.id, "Speaker 2", "Bob", None, None).unwrap();

        // Label contains-match, case-insensitive.
        let hits = db.search_all("speaker:amy budget", 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].match_start_ms, Some(0), "must be Amy's segment");

        // Raw key works too (unlabeled speakers).
        let hits = db.search_all(r#"speaker:"speaker 2" budget"#, 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].match_start_ms, Some(5000), "must be Speaker 2's segment");

        // Non-matching speaker → nothing, even though the text matches.
        assert!(db.search_all("speaker:carol budget", 10).unwrap().is_empty());
    }

    #[test]
    fn search_speaker_filter_suppresses_title_and_note_hits() {
        let db = db();
        let m = db.create_meeting("budget review").unwrap();
        let note = db.create_note(&m.id, None).unwrap();
        db.update_note_raw_content(
            &note.id,
            r#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"budget thoughts"}]}]}"#,
        ).unwrap();

        // Title and note both contain "budget", but a speaker filter means
        // "find where this person said it" — no transcript, no results.
        assert!(db.search_all("speaker:amy budget", 10).unwrap().is_empty());
        // Sanity: without the filter both arms hit.
        assert!(!db.search_all("budget", 10).unwrap().is_empty());
    }

    #[test]
    fn search_date_filters_split_meetings() {
        let db = db();
        let old = db.create_meeting("January retro").unwrap();
        let new = db.create_meeting("May retro").unwrap();
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "UPDATE meetings SET actual_start = '2026-01-15T10:00:00Z' WHERE id = ?1",
                params![old.id],
            ).unwrap();
            conn.execute(
                "UPDATE meetings SET actual_start = '2026-05-15T10:00:00Z' WHERE id = ?1",
                params![new.id],
            ).unwrap();
        }
        for m_id in [&old.id, &new.id] {
            let t = db.create_transcript(m_id, "test").unwrap();
            db.update_transcript_segments(
                &t.id,
                r#"[{"text":"we reviewed the budget","start_ms":0,"end_ms":1}]"#,
            ).unwrap();
        }

        let before = db.search_all("budget before:2026-03-01", 10).unwrap();
        assert_eq!(before.len(), 1);
        assert_eq!(before[0].meeting_id, old.id);

        let after = db.search_all("budget after:2026-03-01", 10).unwrap();
        assert_eq!(after.len(), 1);
        assert_eq!(after[0].meeting_id, new.id);

        // after: is inclusive of the named day.
        let on_day = db.search_all("budget after:2026-05-15", 10).unwrap();
        assert_eq!(on_day.len(), 1);
        assert_eq!(on_day[0].meeting_id, new.id);

        // Date filters apply to the title arm too.
        let titles = db.search_all("retro before:2026-03-01", 10).unwrap();
        assert_eq!(titles.len(), 1);
        assert_eq!(titles[0].meeting_id, old.id);
    }

    #[test]
    fn search_folder_filter_scopes_to_folder_members() {
        let db = db();
        let in_folder = db.create_meeting("Work sync").unwrap();
        let outside = db.create_meeting("Other sync").unwrap();
        let f = db.create_folder("Client Work", "#aaa", "📁", None).unwrap();
        db.add_meeting_to_folder(&in_folder.id, &f.id).unwrap();
        for m_id in [&in_folder.id, &outside.id] {
            let t = db.create_transcript(m_id, "test").unwrap();
            db.update_transcript_segments(
                &t.id,
                r#"[{"text":"deadline discussion","start_ms":0,"end_ms":1}]"#,
            ).unwrap();
        }

        let hits = db.search_all("deadline folder:client", 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].meeting_id, in_folder.id);
    }

    #[test]
    fn search_quoted_phrase_requires_adjacency() {
        let db = db();
        let phrase = db.create_meeting("A").unwrap();
        let scattered = db.create_meeting("B").unwrap();
        let t1 = db.create_transcript(&phrase.id, "test").unwrap();
        db.update_transcript_segments(
            &t1.id,
            r#"[{"text":"the quarterly budget was approved","start_ms":0,"end_ms":1}]"#,
        ).unwrap();
        let t2 = db.create_transcript(&scattered.id, "test").unwrap();
        db.update_transcript_segments(
            &t2.id,
            r#"[{"text":"budget review happens quarterly","start_ms":0,"end_ms":1}]"#,
        ).unwrap();

        let hits = db.search_all(r#""quarterly budget""#, 10).unwrap();
        assert_eq!(hits.len(), 1, "phrase must not match scattered words");
        assert_eq!(hits[0].meeting_id, phrase.id);
    }

    #[test]
    fn search_trailing_star_prefix_matches() {
        let db = db();
        let m = db.create_meeting("M").unwrap();
        let t = db.create_transcript(&m.id, "test").unwrap();
        db.update_transcript_segments(
            &t.id,
            r#"[{"text":"the budgetary impact is small","start_ms":0,"end_ms":1}]"#,
        ).unwrap();

        assert_eq!(db.search_all("budg*", 10).unwrap().len(), 1);
        // Without the star the partial token matches nothing.
        assert!(db.search_all("budg", 10).unwrap().is_empty());
    }

    #[test]
    fn search_filters_without_terms_return_nothing() {
        let db = db();
        let m = db.create_meeting("Work sync").unwrap();
        let f = db.create_folder("Work", "#aaa", "📁", None).unwrap();
        db.add_meeting_to_folder(&m.id, &f.id).unwrap();

        assert!(db.search_all("folder:work", 10).unwrap().is_empty());
        assert!(db.search_all("speaker:amy", 10).unwrap().is_empty());
    }

    #[test]
    fn search_all_returns_one_row_per_arm_for_the_same_meeting() {
        // A meeting matched by title AND transcript AND notes yields three
        // rows (the palette groups them); each arm contributes at most one.
        let db = db();
        let m = db.create_meeting("Budget planning").unwrap();
        let t = db.create_transcript(&m.id, "test").unwrap();
        db.update_transcript_segments(
            &t.id,
            r#"[{"text":"the budget looks tight","start_ms":3000,"end_ms":4000}]"#,
        ).unwrap();
        let note = db.create_note(&m.id, None).unwrap();
        db.update_note_raw_content(
            &note.id,
            r#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"budget follow-ups"}]}]}"#,
        ).unwrap();

        let results = db.search_all("budget", 20).unwrap();
        let mine: Vec<&super::SearchResult> =
            results.iter().filter(|r| r.meeting_id == m.id).collect();
        let sources: Vec<&str> = mine.iter().map(|r| r.match_source.as_str()).collect();
        assert_eq!(mine.len(), 3, "one row per arm, got {sources:?}");
        for src in ["title", "transcript", "notes"] {
            assert_eq!(
                sources.iter().filter(|s| **s == src).count(),
                1,
                "exactly one {src} row"
            );
        }
        let transcript_row = mine.iter().find(|r| r.match_source == "transcript").unwrap();
        assert_eq!(transcript_row.match_start_ms, Some(3000));
    }

    #[test]
    fn test_search_all_picks_best_segment_per_meeting() {
        // Two segments match; the denser one must supply snippet + start_ms,
        // and the meeting must appear exactly once (per-segment FTS grouped
        // by meeting — plan v8 A1).
        let db = db();
        let m = db.create_meeting("Best segment test").unwrap();
        let t = db.create_transcript(&m.id, "test").unwrap();
        db.update_transcript_segments(
            &t.id,
            r#"[{"text":"budget mentioned once amid many other unrelated words today","start_ms":1000,"end_ms":2000},
                {"text":"budget budget budget","start_ms":9000,"end_ms":9500}]"#,
        ).unwrap();

        let results = db.search_all("budget", 10).unwrap();
        let hits: Vec<_> = results
            .iter()
            .filter(|r| r.match_source == "transcript" && r.meeting_id == m.id)
            .collect();
        assert_eq!(hits.len(), 1, "one result per meeting, not per segment");
        assert_eq!(hits[0].match_start_ms, Some(9000));
        assert!(hits[0].snippet.contains("budget budget"));
    }

    #[test]
    fn test_search_all_excludes_soft_deleted_meetings() {
        let db = db();
        let kept = db.create_meeting("quarterly sync").unwrap();
        let gone = db.create_meeting("quarterly review").unwrap();
        let note = db.create_note(&gone.id, None).unwrap();
        // Visible text would match — but the meeting is deleted.
        db.update_note_raw_content(
            &note.id,
            r#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"quarterly budget talk"}]}]}"#,
        )
        .unwrap();
        db.soft_delete_meeting(&gone.id).unwrap();

        let results = db.search_all("quarterly", 20).unwrap();
        assert!(results.iter().any(|r| r.meeting_id == kept.id));
        assert!(
            results.iter().all(|r| r.meeting_id != gone.id),
            "soft-deleted meetings must not surface in search"
        );
    }

    #[test]
    fn test_search_all_notes_ignore_tiptap_structural_tokens() {
        let db = db();
        let m = db.create_meeting("Sync").unwrap();
        let note = db.create_note(&m.id, None).unwrap();
        // Visible text is "buy milk" / "call amy"; everything else is
        // TipTap structure that used to LIKE-match every note.
        db.update_note_raw_content(
            &note.id,
            r#"{"type":"doc","content":[{"type":"heading","attrs":{"level":2},"content":[{"type":"text","text":"buy milk"}]},{"type":"taskList","content":[{"type":"taskItem","attrs":{"checked":true},"content":[{"type":"paragraph","content":[{"type":"text","text":"call amy"}]}]}]}]}"#,
        )
        .unwrap();

        for token in ["task", "heading", "paragraph", "true", "level", "doc", "attrs"] {
            let results = db.search_all(token, 10).unwrap();
            assert!(
                results.iter().all(|r| r.meeting_id != m.id),
                "structural token {:?} must not match the note via its JSON",
                token
            );
        }

        // The visible text itself still matches.
        let results = db.search_all("milk", 10).unwrap();
        assert!(results
            .iter()
            .any(|r| r.meeting_id == m.id && r.match_source == "notes"));
    }

    #[test]
    fn test_search_all_notes_match_visible_text_with_plain_snippet() {
        let db = db();
        let m = db.create_meeting("Roadmap").unwrap();
        let note = db.create_note(&m.id, None).unwrap();
        // Visible text contains "task", so even a structural-looking word
        // must match when it really appears on screen.
        db.update_note_raw_content(
            &note.id,
            r#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Amy owns the launch task for April"}]}]}"#,
        )
        .unwrap();

        let results = db.search_all("launch task", 10).unwrap();
        let hit = results
            .iter()
            .find(|r| r.meeting_id == m.id && r.match_source == "notes")
            .expect("visible note text must match");
        assert!(hit.snippet.contains("launch task"));
        assert!(
            !hit.snippet.contains('{') && !hit.snippet.contains('"') && !hit.snippet.contains(':'),
            "snippet must be plain text, not TipTap JSON: {}",
            hit.snippet
        );
    }

    #[test]
    fn test_search_all_notes_match_generated_content_too() {
        let db = db();
        let m = db.create_meeting("Standup").unwrap();
        let note = db.create_note(&m.id, None).unwrap();
        db.update_note_generated_content(
            &note.id,
            r#"{"type":"doc","content":[{"type":"summary","content":[{"type":"text","text":"Discussed the kumquat budget."}]}]}"#,
        )
        .unwrap();

        let results = db.search_all("kumquat", 10).unwrap();
        let hit = results
            .iter()
            .find(|r| r.meeting_id == m.id && r.match_source == "notes")
            .expect("generated content visible text must match");
        assert!(hit.snippet.contains("kumquat budget"));
    }

    #[test]
    fn attendee_names_parse_strings_and_objects() {
        use crate::db::queries::parse_attendee_names;
        assert_eq!(parse_attendee_names(r#"["Riley", " Bob "]"#), vec!["Riley", "Bob"]);
        assert_eq!(
            parse_attendee_names(r#"[{"name":"Riley Quinn","email":"j@x.com"},{"email":"sam@y.com"}]"#),
            vec!["Riley Quinn", "sam"]
        );
        assert!(parse_attendee_names("").is_empty());
        assert!(parse_attendee_names("[]").is_empty());
    }

    #[test]
    fn prep_brief_round_trips_and_overwrites() {
        let db = db();
        let m = db.create_meeting("Catch up").unwrap();
        assert!(db.get_prep_brief(&m.id).unwrap().is_none());
        db.upsert_prep_brief(&m.id, "## Meeting\nfirst").unwrap();
        db.upsert_prep_brief(&m.id, "## Meeting\nsecond").unwrap();
        let (content, generated_at) = db.get_prep_brief(&m.id).unwrap().unwrap();
        assert_eq!(content, "## Meeting\nsecond");
        assert!(!generated_at.is_empty());
    }

    #[test]
    fn prep_history_finds_attendee_overlap_with_summaries() {
        let db = db();
        let prev = db.create_meeting("1:1 with Riley").unwrap();
        db.update_meeting_metadata(&prev.id, None, None, None, Some(r#"["Riley Quinn"]"#))
            .unwrap();
        db.update_meeting_status(&prev.id, "complete").unwrap();
        let note = db.create_note(&prev.id, None).unwrap();
        db.update_note_generated_content(
            &note.id,
            r#"{"type":"doc","content":[{"type":"summary","content":[{"type":"text","text":"Discussed the Q3 vendor renewal."}]}]}"#,
        )
        .unwrap();

        let unrelated = db.create_meeting("Other call").unwrap();
        db.update_meeting_metadata(&unrelated.id, None, None, None, Some(r#"["Sam"]"#))
            .unwrap();

        let upcoming = db.create_meeting("Catch up").unwrap();
        db.update_meeting_metadata(
            &upcoming.id,
            None,
            None,
            None,
            Some(r#"[{"name":"Riley Quinn","email":"riley@example.com"}]"#),
        )
        .unwrap();

        let history = db.prep_history_for_meeting(&upcoming.id, 8).unwrap();
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].title, "1:1 with Riley");
        assert_eq!(history[0].summary, "Discussed the Q3 vendor renewal.");
    }

    #[test]
    fn test_last_time_in_series_matches_normalized_titles() {
        let db = db();
        let prev = db.create_meeting("Weekly Sync — Jun 3").unwrap();
        db.update_meeting_status(&prev.id, "complete").unwrap();
        let n = db.create_note(&prev.id, None).unwrap();
        db.update_note_generated_content(&n.id, r#"{"type":"doc","content":[
            {"type":"summary","content":[{"type":"text","text":"Shipped the beta."}]},
            {"type":"actionItem","attrs":{"task":"Follow up","done":false}}]}"#).unwrap();

        let cur = db.create_meeting("Weekly Sync — Jun 10").unwrap();
        let card = db.last_time_in_series(&cur.id).unwrap().expect("series match");
        assert_eq!(card.meeting_id, prev.id);
        assert_eq!(card.summary, "Shipped the beta.");
        assert_eq!(card.open_items.len(), 1);

        // Generic auto titles never chain into a series.
        let auto = db.create_meeting("Meeting — Jun 9 at 11:53 AM").unwrap();
        assert!(db.last_time_in_series(&auto.id).unwrap().is_none());

        // Unrelated titles don't match.
        let other = db.create_meeting("Design Review").unwrap();
        assert!(db.last_time_in_series(&other.id).unwrap().is_none());
    }

    #[test]
    fn test_task_overlays_decorate_rollup_and_partial_update() {
        let db = db();
        let m = db.create_meeting("Overlay").unwrap();
        let n = db.create_note(&m.id, None).unwrap();
        db.update_note_generated_content(&n.id, r#"{"type":"doc","content":[
            {"type":"actionItem","attrs":{"task":"Snooze me","done":false}}]}"#).unwrap();

        db.set_task_snooze(&n.id, "generated", 0, Some("2026-06-17"), None).unwrap();
        let items = db.list_action_items().unwrap();
        let it = items.iter().find(|i| i.task == "Snooze me").unwrap();
        assert_eq!(it.snoozed_until.as_deref(), Some("2026-06-17"));
        assert!(!it.dropped);

        // Setting dropped must not clobber the snooze (partial update).
        db.set_task_dropped(&n.id, "generated", 0, true, None).unwrap();
        let items = db.list_action_items().unwrap();
        let it = items.iter().find(|i| i.task == "Snooze me").unwrap();
        assert!(it.dropped);
        assert_eq!(
            it.snoozed_until.as_deref(),
            Some("2026-06-17"),
            "dropping must not clear the snooze"
        );
        // And unsnoozing must not clear the drop.
        db.set_task_snooze(&n.id, "generated", 0, None, None).unwrap();
        let items = db.list_action_items().unwrap();
        let it = items.iter().find(|i| i.task == "Snooze me").unwrap();
        assert!(it.dropped && it.snoozed_until.is_none());
    }

    #[test]
    fn test_open_loops_match_on_shared_attendees_only() {
        let db = db();
        let prior = db.create_meeting("Prior with Amy").unwrap();
        db.update_meeting_metadata(&prior.id, None, None, None, Some(r#"["Amy","Sam"]"#)).unwrap();
        let n = db.create_note(&prior.id, None).unwrap();
        db.update_note_generated_content(&n.id, r#"{"type":"doc","content":[
            {"type":"actionItem","attrs":{"task":"Send deck to Amy","done":false}},
            {"type":"actionItem","attrs":{"task":"Done thing","done":true}}]}"#).unwrap();

        let unrelated = db.create_meeting("Unrelated").unwrap();
        db.update_meeting_metadata(&unrelated.id, None, None, None, Some(r#"["Bob"]"#)).unwrap();
        let n2 = db.create_note(&unrelated.id, None).unwrap();
        db.update_note_generated_content(&n2.id, r#"{"type":"doc","content":[
            {"type":"actionItem","attrs":{"task":"Bob task","done":false}}]}"#).unwrap();

        let upcoming = db.create_meeting("Next with Amy").unwrap();
        db.update_meeting_metadata(&upcoming.id, None, None, None, Some(r#"["Amy"]"#)).unwrap();

        let loops = db.open_action_items_for_meeting_attendees(&upcoming.id).unwrap();
        assert_eq!(loops.len(), 1, "only the open item from the shared-attendee meeting");
        assert_eq!(loops[0].task, "Send deck to Amy");

        // No attendees → no loops.
        let bare = db.create_meeting("Bare").unwrap();
        assert!(db.open_action_items_for_meeting_attendees(&bare.id).unwrap().is_empty());
    }

    #[test]
    fn test_segment_highlights_set_and_toggle_preserving_unknown_fields() {
        let db = db();
        let m = db.create_meeting("HL").unwrap();
        let t = db.create_transcript(&m.id, "test").unwrap();
        db.update_transcript_segments(
            &t.id,
            r#"[{"text":"a","start_ms":0,"end_ms":5000,"custom_field":42},
                {"text":"b","start_ms":5000,"end_ms":10000}]"#,
        )
        .unwrap();

        // ⌘D at 3s lands in segment 0; a miss reports false.
        assert!(db.highlight_segment_at(&m.id, 3_000).unwrap());
        assert!(!db.highlight_segment_at(&m.id, 99_000).unwrap());
        // Drawer toggle flips segment 1 on, then off.
        assert!(db.toggle_segment_highlight(&m.id, 1).unwrap());
        assert!(!db.toggle_segment_highlight(&m.id, 1).unwrap());

        let segs: Vec<serde_json::Value> = serde_json::from_str(
            &db.get_transcript_by_meeting(&m.id).unwrap().unwrap().segments,
        )
        .unwrap();
        assert_eq!(segs[0]["highlighted"], true);
        assert_eq!(segs[0]["custom_field"], 42, "unknown fields must survive edits");
        assert_eq!(segs[1]["highlighted"], false);
    }

    #[test]
    fn test_series_template_memory_round_trips_with_guards() {
        let db = db();
        // Remember and recall across differently-dated instances.
        db.remember_series_template("Design Sync — Jun 2", "tpl-1").unwrap();
        assert_eq!(
            db.series_template_for("Design Sync — Jun 9").unwrap(),
            Some("tpl-1".to_string())
        );
        // Generic/auto titles never bind a series.
        db.remember_series_template("Meeting — Jun 9 at 9:00 AM", "tpl-2").unwrap();
        assert_eq!(db.series_template_for("Meeting — Jun 10 at 9:00 AM").unwrap(), None);
        db.remember_series_template("Sync", "tpl-3").unwrap();
        assert_eq!(db.series_template_for("Sync").unwrap(), None);
    }

    #[test]
    fn test_meeting_near_now_picks_closest_upcoming_within_window() {
        let db = db();
        let near = db.create_meeting("Standup").unwrap();
        let start = (chrono::Utc::now() - chrono::Duration::minutes(3)).to_rfc3339();
        db.update_meeting_metadata(&near.id, Some(&start), None, None, None).unwrap();

        let far = db.create_meeting("Later").unwrap();
        let far_start = (chrono::Utc::now() + chrono::Duration::minutes(90)).to_rfc3339();
        db.update_meeting_metadata(&far.id, Some(&far_start), None, None, None).unwrap();

        let done = db.create_meeting("Past complete").unwrap();
        db.update_meeting_metadata(&done.id, Some(&start), None, None, None).unwrap();
        db.update_meeting_status(&done.id, "complete").unwrap();

        let hit = db.meeting_near_now(15).unwrap().unwrap();
        assert_eq!(hit.id, near.id);
        // Window excludes everything when tightened below the 3-minute gap.
        assert!(db.meeting_near_now(2).unwrap().is_none());
    }

    #[test]
    fn test_open_loops_match_on_series_title_without_attendees() {
        // The ICS reality: no attendee data anywhere. Recurring titles must
        // still surface last week's unfinished items.
        let db = db();
        let prior = db.create_meeting("Design Sync — Jun 2").unwrap();
        let n = db.create_note(&prior.id, None).unwrap();
        db.update_note_generated_content(&n.id, r#"{"type":"doc","content":[
            {"type":"actionItem","attrs":{"task":"Ship the tokens","done":false}}]}"#).unwrap();

        let upcoming = db.create_meeting("Design Sync — Jun 9").unwrap();
        let loops = db.open_action_items_for_meeting_attendees(&upcoming.id).unwrap();
        assert_eq!(loops.len(), 1);
        assert_eq!(loops[0].task, "Ship the tokens");

        // Auto-generated titles must never chain.
        let auto_a = db.create_meeting("Meeting — Jun 8 at 9:00 AM").unwrap();
        let na = db.create_note(&auto_a.id, None).unwrap();
        db.update_note_generated_content(&na.id, r#"{"type":"doc","content":[
            {"type":"actionItem","attrs":{"task":"Stray","done":false}}]}"#).unwrap();
        let auto_b = db.create_meeting("Meeting — Jun 9 at 9:00 AM").unwrap();
        assert!(db.open_action_items_for_meeting_attendees(&auto_b.id).unwrap().is_empty());
    }

    #[test]
    fn test_get_folder_memberships_map_groups_by_meeting() {
        let db = db();
        let m1 = db.create_meeting("A").unwrap();
        let m2 = db.create_meeting("B").unwrap();
        let f1 = db.create_folder("F1", "#888888", "folder", None).unwrap();
        let f2 = db.create_folder("F2", "#888888", "folder", None).unwrap();
        db.add_meeting_to_folder(&m1.id, &f1.id).unwrap();
        db.add_meeting_to_folder(&m1.id, &f2.id).unwrap();
        db.add_meeting_to_folder(&m2.id, &f1.id).unwrap();

        let map = db.get_folder_memberships_map().unwrap();
        assert_eq!(map[&m1.id].len(), 2);
        assert_eq!(map[&m2.id], vec![f1.id.clone()]);
        assert!(!map.contains_key("missing"));
    }

    #[test]
    fn test_merge_speaker_keys_rewrites_segments_and_inherits_label() {
        let db = db();
        let m = db.create_meeting("M").unwrap();
        let t = db.create_transcript(&m.id, "test").unwrap();
        let segs = r#"[{"text":"a","start_ms":0,"end_ms":1000,"speaker":"Speaker 1"},
                       {"text":"b","start_ms":1000,"end_ms":2000,"speaker":"Speaker 2"},
                       {"text":"c","start_ms":2000,"end_ms":3000,"speaker":"Speaker 2"}]"#;
        db.update_transcript_segments(&t.id, segs).unwrap();
        db.upsert_speaker_label(&m.id, "Speaker 2", "Amy", None, None).unwrap();

        let changed = db.merge_speaker_keys(&m.id, "Speaker 2", "Speaker 1").unwrap();
        assert_eq!(changed, 2);

        let t2 = db.get_transcript_by_meeting(&m.id).unwrap().unwrap();
        assert!(!t2.segments.contains("Speaker 2"), "from_key must be gone from segments");

        // Speaker 1 had no label, so it inherits "Amy"; Speaker 2's row is gone.
        let labels = db.list_speaker_labels_for_meeting(&m.id).unwrap();
        assert_eq!(labels.len(), 1);
        assert_eq!(labels[0].speaker_key, "Speaker 1");
        assert_eq!(labels[0].display_name, "Amy");

        // Merging a key into itself is a no-op.
        assert_eq!(db.merge_speaker_keys(&m.id, "Speaker 1", "Speaker 1").unwrap(), 0);
    }

    #[test]
    fn test_merge_speaker_keys_keeps_target_name_over_source() {
        let db = db();
        let m = db.create_meeting("M").unwrap();
        let t = db.create_transcript(&m.id, "test").unwrap();
        db.update_transcript_segments(
            &t.id,
            r#"[{"text":"a","start_ms":0,"end_ms":1000,"speaker":"Speaker 1"},
                {"text":"b","start_ms":1000,"end_ms":2000,"speaker":"Speaker 2"}]"#,
        ).unwrap();
        db.upsert_speaker_label(&m.id, "Speaker 1", "Sam", None, None).unwrap();
        db.upsert_speaker_label(&m.id, "Speaker 2", "Amy", None, None).unwrap();

        db.merge_speaker_keys(&m.id, "Speaker 2", "Speaker 1").unwrap();
        let labels = db.list_speaker_labels_for_meeting(&m.id).unwrap();
        assert_eq!(labels.len(), 1);
        assert_eq!(labels[0].display_name, "Sam", "target keeps its own name");
    }

    // --- Templates ---

    #[test]
    fn test_create_template_and_list() {
        let db = db();
        db.create_template("Meeting Notes", Some("Standard notes"), "You are {{title}}", r#"["Summary","Action Items"]"#, false, false).unwrap();
        let templates = db.list_templates().unwrap();
        assert!(templates.iter().any(|t| t.name == "Meeting Notes"));
    }

    #[test]
    fn test_get_default_template_returns_none_when_none_set() {
        let db = db();
        let default = db.get_default_template().unwrap();
        assert!(default.is_none());
    }

    #[test]
    fn test_create_template_as_default() {
        let db = db();
        db.create_template("Default", None, "prompt", "[]", true, false).unwrap();
        let default = db.get_default_template().unwrap();
        assert!(default.is_some());
        assert_eq!(default.unwrap().name, "Default");
    }

    #[test]
    fn test_update_template_changes_fields() {
        let db = db();
        let t = db.create_template("Old", None, "old prompt", "[]", false, false).unwrap();
        db.update_template(&t.id, "New", None, "new prompt", r#"["Section"]"#, true).unwrap();
        let templates = db.list_templates().unwrap();
        let updated = templates.iter().find(|x| x.id == t.id).unwrap();
        assert_eq!(updated.name, "New");
        assert_eq!(updated.prompt_template, "new prompt");
        assert!(updated.is_default);
    }

    // --- Speaker Labels ---

    #[test]
    fn test_upsert_speaker_label_creates_new() {
        let db = db();
        let m = db.create_meeting("Meeting").unwrap();
        let label = db.upsert_speaker_label(&m.id, "SPEAKER_00", "Alice", Some("#ff0000"), Some("in-room")).unwrap();
        assert_eq!(label.display_name, "Alice");
        assert_eq!(label.speaker_key, "SPEAKER_00");
        assert_eq!(label.meeting_id.as_deref(), Some(m.id.as_str()));
        assert_eq!(label.participant_type, "in-room");
    }

    #[test]
    fn test_upsert_speaker_label_updates_existing() {
        let db = db();
        let m = db.create_meeting("Meeting").unwrap();
        db.upsert_speaker_label(&m.id, "SPEAKER_00", "Alice", None, None).unwrap();
        let updated = db.upsert_speaker_label(&m.id, "SPEAKER_00", "Alice Smith", Some("#00ff00"), Some("remote")).unwrap();
        assert_eq!(updated.display_name, "Alice Smith");
        assert_eq!(updated.participant_type, "remote");

        let labels = db.list_speaker_labels_for_meeting(&m.id).unwrap();
        let matching: Vec<_> = labels.iter().filter(|l| l.speaker_key == "SPEAKER_00").collect();
        assert_eq!(matching.len(), 1, "upsert must not create duplicate entries within a meeting");
    }

    #[test]
    fn test_same_speaker_key_in_two_meetings_are_independent() {
        let db = db();
        let a = db.create_meeting("Meeting A").unwrap();
        let b = db.create_meeting("Meeting B").unwrap();

        db.upsert_speaker_label(&a.id, "Speaker 1", "Alice", None, None).unwrap();
        db.upsert_speaker_label(&b.id, "Speaker 1", "Bob", None, None).unwrap();

        let labels_a = db.list_speaker_labels_for_meeting(&a.id).unwrap();
        let labels_b = db.list_speaker_labels_for_meeting(&b.id).unwrap();

        assert_eq!(labels_a.len(), 1);
        assert_eq!(labels_a[0].display_name, "Alice");
        assert_eq!(labels_b.len(), 1);
        assert_eq!(labels_b[0].display_name, "Bob");
    }

    #[test]
    fn test_list_speaker_labels_for_meeting_excludes_other_meetings() {
        let db = db();
        let a = db.create_meeting("A").unwrap();
        let b = db.create_meeting("B").unwrap();
        db.upsert_speaker_label(&a.id, "Speaker 1", "Alice", None, None).unwrap();
        db.upsert_speaker_label(&b.id, "Speaker 1", "Bob", None, None).unwrap();

        let labels = db.list_speaker_labels_for_meeting(&a.id).unwrap();
        assert_eq!(labels.len(), 1);
        assert!(labels.iter().all(|l| l.meeting_id.as_deref() == Some(a.id.as_str())));
    }

    #[test]
    fn test_delete_speaker_label() {
        let db = db();
        let m = db.create_meeting("Meeting").unwrap();
        let label = db.upsert_speaker_label(&m.id, "SPEAKER_01", "Bob", None, None).unwrap();
        db.delete_speaker_label(&label.id).unwrap();
        let labels = db.list_speaker_labels_for_meeting(&m.id).unwrap();
        assert!(labels.iter().all(|l| l.id != label.id));
    }

    // --- Meeting Links ---

    #[test]
    fn test_link_and_unlink_meetings() {
        let db = db();
        let a = db.create_meeting("Meeting A").unwrap();
        let b = db.create_meeting("Meeting B").unwrap();
        db.link_meetings(&a.id, &b.id, "related").unwrap();

        let links = db.get_linked_meetings(&a.id).unwrap();
        assert!(links.iter().any(|l| l.target_meeting_id == b.id));

        db.unlink_meetings(&a.id, &b.id).unwrap();
        let links2 = db.get_linked_meetings(&a.id).unwrap();
        assert!(links2.iter().all(|l| l.target_meeting_id != b.id));
    }

    #[test]
    fn test_duplicate_link_is_rejected() {
        let db = db();
        let a = db.create_meeting("A").unwrap();
        let b = db.create_meeting("B").unwrap();
        db.link_meetings(&a.id, &b.id, "related").unwrap();
        // link_meetings uses INSERT OR IGNORE, so the second call succeeds silently.
        // We verify uniqueness by checking that only one link row exists for this pair.
        db.link_meetings(&a.id, &b.id, "related").unwrap();
        let links = db.get_linked_meetings(&a.id).unwrap();
        let matching: Vec<_> = links.iter()
            .filter(|l| l.source_meeting_id == a.id && l.target_meeting_id == b.id)
            .collect();
        assert_eq!(matching.len(), 1, "duplicate link must not create a second row");
    }

    #[test]
    fn test_delete_meeting_cascades_meeting_links() {
        let db = db();
        let a = db.create_meeting("A").unwrap();
        let b = db.create_meeting("B").unwrap();
        db.link_meetings(&a.id, &b.id, "related").unwrap();
        db.delete_meeting(&a.id).unwrap();

        let links = db.get_linked_meetings(&b.id).unwrap();
        assert!(links.is_empty(), "links from deleted meeting must be cascade-deleted");
    }

    // --- Chat Messages ---

    #[test]
    fn test_create_chat_message_with_meeting() {
        let db = db();
        let m = db.create_meeting("M").unwrap();
        let msg = db.create_chat_message(Some(&m.id), "user", "What was decided?", "[]").unwrap();
        assert_eq!(msg.role, "user");
        assert_eq!(msg.content, "What was decided?");
        assert_eq!(msg.meeting_id, Some(m.id));
    }

    #[test]
    fn test_create_global_chat_message_no_meeting() {
        let db = db();
        let msg = db.create_chat_message(None, "assistant", "I'm here to help", "[]").unwrap();
        assert!(msg.meeting_id.is_none());
        assert_eq!(msg.role, "assistant");
    }

    #[test]
    fn test_list_chat_messages_filtered_by_meeting() {
        let db = db();
        let m1 = db.create_meeting("M1").unwrap();
        let m2 = db.create_meeting("M2").unwrap();
        db.create_chat_message(Some(&m1.id), "user", "msg1", "[]").unwrap();
        db.create_chat_message(Some(&m2.id), "user", "msg2", "[]").unwrap();

        let msgs = db.list_chat_messages(Some(&m1.id)).unwrap();
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0].content, "msg1");
    }

    // --- Voice Profiles ---

    #[test]
    fn test_create_voice_profile() {
        let db = db();
        let vp = db.create_voice_profile("Alice", "/path/to/sample.wav").unwrap();
        assert_eq!(vp.speaker_name, "Alice");
        assert_eq!(vp.sample_path, "/path/to/sample.wav");
    }

    #[test]
    fn test_list_voice_profiles() {
        let db = db();
        db.create_voice_profile("Alice", "/a.wav").unwrap();
        db.create_voice_profile("Bob", "/b.wav").unwrap();
        let profiles = db.list_voice_profiles().unwrap();
        assert!(profiles.iter().any(|p| p.speaker_name == "Alice"));
        assert!(profiles.iter().any(|p| p.speaker_name == "Bob"));
    }

    #[test]
    fn test_delete_voice_profile() {
        let db = db();
        let vp = db.create_voice_profile("Carol", "/c.wav").unwrap();
        db.delete_voice_profile(&vp.id).unwrap();
        let profiles = db.list_voice_profiles().unwrap();
        assert!(profiles.iter().all(|p| p.id != vp.id));
    }

    // --- Attachments ---

    #[test]
    fn test_create_and_list_attachments() {
        let db = db();
        let m = db.create_meeting("M").unwrap();
        db.create_attachment(&m.id, "doc.pdf", "/path/doc.pdf", "application/pdf", 1024).unwrap();
        let attachments = db.list_attachments(&m.id).unwrap();
        assert_eq!(attachments.len(), 1);
        assert_eq!(attachments[0].file_name, "doc.pdf");
    }

    #[test]
    fn test_delete_attachment() {
        let db = db();
        let m = db.create_meeting("M").unwrap();
        let a = db.create_attachment(&m.id, "file.txt", "/f.txt", "text/plain", 100).unwrap();
        db.delete_attachment(&a.id).unwrap();
        let attachments = db.list_attachments(&m.id).unwrap();
        assert!(attachments.is_empty());
    }

    // --- Settings ---

    #[test]
    fn test_set_and_get_setting() {
        let db = db();
        db.set_setting("theme", "dark").unwrap();
        let val = db.get_setting("theme").unwrap();
        assert_eq!(val, Some("dark".to_string()));
    }

    #[test]
    fn test_get_setting_returns_none_for_unknown_key() {
        let db = db();
        let val = db.get_setting("nonexistent_key_xyz").unwrap();
        assert!(val.is_none());
    }

    // --- Storage Stats ---

    #[test]
    fn test_get_storage_stats_after_creating_data() {
        let db = db();
        let m = db.create_meeting("M").unwrap();
        db.create_note(&m.id, None).unwrap();
        db.create_transcript(&m.id, "local").unwrap();
        let stats = db.get_storage_stats().unwrap();
        assert!(stats.total_meetings >= 1);
    }

    #[test]
    fn list_mention_candidates_orders_by_freq_then_recency() {
        let db = Database::new_in_memory().unwrap();
        let conn = db.conn.lock().unwrap();
        conn.execute("INSERT INTO mention_candidates(name, freq, last_seen_at) VALUES ('Alice', 5, '2026-01-01T00:00:00Z')", []).unwrap();
        conn.execute("INSERT INTO mention_candidates(name, freq, last_seen_at) VALUES ('Bob',   5, '2026-05-01T00:00:00Z')", []).unwrap();
        conn.execute("INSERT INTO mention_candidates(name, freq, last_seen_at) VALUES ('Carol', 10, '2026-01-01T00:00:00Z')", []).unwrap();
        drop(conn);

        let all = db.list_mention_candidates("", 10).unwrap();
        assert_eq!(all, vec!["Carol", "Bob", "Alice"]); // Carol higher freq; Bob more recent than Alice.

        let with_prefix = db.list_mention_candidates("a", 10).unwrap();
        assert_eq!(with_prefix, vec!["Alice"]);
    }

    #[test]
    fn upsert_mention_candidate_increments_freq() {
        let db = Database::new_in_memory().unwrap();
        db.upsert_mention_candidate("Alice", "2026-05-01T00:00:00Z").unwrap();
        db.upsert_mention_candidate("Alice", "2026-05-02T00:00:00Z").unwrap();
        db.upsert_mention_candidate("Bob",   "2026-05-01T00:00:00Z").unwrap();

        let conn = db.conn.lock().unwrap();
        let alice_freq: i64 = conn.query_row(
            "SELECT freq FROM mention_candidates WHERE name = 'Alice'", [], |r| r.get(0)
        ).unwrap();
        assert_eq!(alice_freq, 2);
    }

    #[test]
    fn prune_mention_candidates_caps_to_top_200() {
        let db = Database::new_in_memory().unwrap();
        let conn = db.conn.lock().unwrap();
        for i in 0..250 {
            conn.execute(
                "INSERT INTO mention_candidates(name, freq, last_seen_at) VALUES (?1, ?2, '2026-01-01T00:00:00Z')",
                rusqlite::params![format!("name{:04}", i), i as i64],
            ).unwrap();
        }
        drop(conn);

        db.prune_mention_candidates().unwrap();

        let conn = db.conn.lock().unwrap();
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM mention_candidates", [], |r| r.get(0)).unwrap();
        assert_eq!(count, 200);

        // The 200 survivors should all have the top freq scores (50..=249).
        let lowest_freq: i64 = conn.query_row(
            "SELECT MIN(freq) FROM mention_candidates", [], |r| r.get(0)
        ).unwrap();
        assert_eq!(lowest_freq, 50);
    }

    #[test]
    fn update_meeting_metadata_upserts_attendees_into_pool() {
        let db = Database::new_in_memory().unwrap();
        db.create_meeting("Test").unwrap();
        let meeting_id = {
            let conn = db.conn.lock().unwrap();
            conn.query_row("SELECT id FROM meetings LIMIT 1", [], |r| r.get::<_, String>(0)).unwrap()
        };

        db.update_meeting_metadata(
            &meeting_id, None, None, None, Some(r#"["Alice", "Bob"]"#),
        ).unwrap();

        let candidates = db.list_mention_candidates("", 10).unwrap();
        assert!(candidates.contains(&"Alice".to_string()));
        assert!(candidates.contains(&"Bob".to_string()));
    }

    #[test]
    fn match_voice_profile_returns_best_above_threshold() {
        use crate::audio::mel::{cosine_similarity, MEL_BINS};
        let db = Database::new_in_memory().unwrap();

        // Two stored profiles: Alice and Bob, with distinct embeddings.
        let alice_emb: Vec<f32> = (0..MEL_BINS).map(|i| if i < 32 { 1.0 } else { 0.0 }).collect();
        let bob_emb:   Vec<f32> = (0..MEL_BINS).map(|i| if i < 32 { 0.0 } else { 1.0 }).collect();

        db.save_voice_profile_with_embedding("Alice", "/path/alice.wav", &alice_emb).unwrap();
        db.save_voice_profile_with_embedding("Bob",   "/path/bob.wav",   &bob_emb).unwrap();

        // Query close to Alice — should return Alice.
        let mut query = alice_emb.clone();
        query[5] += 0.1;
        let m = db.match_voice_profile(&query, 0.7).unwrap();
        assert!(m.is_some(), "expected a match");
        let (name, sim) = m.unwrap();
        assert_eq!(name, "Alice");
        assert!(sim > 0.7);

        // Verify the matcher's similarity computation matches the helper.
        let recomputed = cosine_similarity(&query, &alice_emb);
        assert!((sim - recomputed).abs() < 0.001);
    }

    #[test]
    fn match_voice_profile_returns_none_below_threshold() {
        use crate::audio::mel::MEL_BINS;
        let db = Database::new_in_memory().unwrap();

        let alice_emb: Vec<f32> = (0..MEL_BINS).map(|i| if i < 32 { 1.0 } else { 0.0 }).collect();
        db.save_voice_profile_with_embedding("Alice", "/path/alice.wav", &alice_emb).unwrap();

        // Orthogonal query — cosine ~0.
        let query: Vec<f32> = (0..MEL_BINS).map(|i| if i < 32 { 0.0 } else { 1.0 }).collect();
        let m = db.match_voice_profile(&query, 0.7).unwrap();
        assert!(m.is_none(), "should not match below threshold");
    }

    #[test]
    fn voice_profile_embedding_cache_round_trips() {
        let db = Database::new_in_memory().unwrap();
        // Legacy row without an embedding (the pre-snippet enroll path).
        let p = db.create_voice_profile("Amy", "/samples/amy.wav").unwrap();

        let rows = db.list_voice_profiles_with_embeddings().unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].1, "Amy");
        assert_eq!(rows[0].2, "/samples/amy.wav");
        assert!(rows[0].3.is_none(), "no embedding cached yet");

        // Re-embed pass caches the neural vector on the row…
        db.update_voice_profile_embedding(&p.id, &[0.6, 0.8]).unwrap();
        let rows = db.list_voice_profiles_with_embeddings().unwrap();
        let cached: Vec<f32> = serde_json::from_str(rows[0].3.as_deref().unwrap()).unwrap();
        assert_eq!(cached, vec![0.6, 0.8]);

        // …and overwriting (e.g. a mel row upgraded to neural) sticks.
        db.update_voice_profile_embedding(&p.id, &[1.0, 0.0]).unwrap();
        let rows = db.list_voice_profiles_with_embeddings().unwrap();
        let cached: Vec<f32> = serde_json::from_str(rows[0].3.as_deref().unwrap()).unwrap();
        assert_eq!(cached, vec![1.0, 0.0]);
    }

    // --- Topic trends (plan v6 item 13) ---

    fn seed_transcript(db: &Database, meeting_id: &str, text: &str) {
        let t = db.create_transcript(meeting_id, "live").unwrap();
        let segments = format!(
            r#"[{{"start_ms":0,"end_ms":1000,"text":"{}","confidence":0.9}}]"#,
            text
        );
        db.update_transcript_segments(&t.id, &segments).unwrap();
    }

    #[test]
    fn topic_trend_counts_groups_distinct_meetings_by_month() {
        let db = Database::new_in_memory().unwrap();
        let this_month = chrono::Utc::now().format("%Y-%m").to_string();

        let a = db.create_meeting("Pricing sync").unwrap();
        seed_transcript(&db, &a.id, "we discussed pricing today and pricing again");
        let b = db.create_meeting("Roadmap").unwrap();
        seed_transcript(&db, &b.id, "pricing came up briefly near the roadmap");
        let c = db.create_meeting("Standup").unwrap();
        seed_transcript(&db, &c.id, "no relevant topics here");

        let trends = db
            .topic_trend_counts(&["pricing".into()], "2000-01-01")
            .unwrap();
        assert_eq!(trends.len(), 1);
        assert_eq!(trends[0].term, "pricing");
        // Two meetings mention it (repeat mentions inside one meeting count once).
        assert_eq!(trends[0].counts.len(), 1);
        assert_eq!(trends[0].counts[0].month, this_month);
        assert_eq!(trends[0].counts[0].meetings, 2);
    }

    #[test]
    fn topic_trend_counts_excludes_deleted_and_respects_since() {
        let db = Database::new_in_memory().unwrap();

        let a = db.create_meeting("Kept").unwrap();
        seed_transcript(&db, &a.id, "budget review");
        let b = db.create_meeting("Deleted").unwrap();
        seed_transcript(&db, &b.id, "budget review too");
        db.soft_delete_meeting(&b.id).unwrap();

        let trends = db.topic_trend_counts(&["budget".into()], "2000-01-01").unwrap();
        assert_eq!(trends[0].counts.len(), 1);
        assert_eq!(trends[0].counts[0].meetings, 1, "soft-deleted meetings must not count");

        // A `since` in the far future excludes everything but keeps the term row.
        let trends = db.topic_trend_counts(&["budget".into()], "2999-01-01").unwrap();
        assert_eq!(trends.len(), 1);
        assert!(trends[0].counts.is_empty());
    }

    #[test]
    fn note_previews_come_back_in_one_call_with_truncated_text() {
        let db = Database::new_in_memory().unwrap();
        let m = db.create_meeting("M").unwrap();
        let note = db.get_or_create_note(&m.id).unwrap();
        let long = "word ".repeat(100);
        let doc = format!(
            r#"{{"type":"doc","content":[{{"type":"heading","content":[{{"type":"text","text":"Agenda"}}]}},{{"type":"paragraph","content":[{{"type":"text","text":"{long}"}}]}}]}}"#
        );
        db.update_note_raw_content(&note.id, &doc).unwrap();

        let previews = db.list_note_previews().unwrap();
        assert_eq!(previews.len(), 1);
        assert_eq!(previews[0].meeting_id, m.id);
        assert!(previews[0].preview.starts_with("Agenda"));
        assert!(previews[0].preview.len() <= 200);

        // Trashed meetings drop out.
        db.soft_delete_meeting(&m.id).unwrap();
        assert!(db.list_note_previews().unwrap().is_empty());
    }

    #[test]
    fn merge_talk_stats_sums_sessions_and_maxes_monologue() {
        let db = Database::new_in_memory().unwrap();
        let m = db.create_meeting("M").unwrap();
        // Session 1 (before the mic switch), then session 2.
        db.merge_talk_stats(&m.id, 60_000, 30_000, 20_000).unwrap();
        db.merge_talk_stats(&m.id, 10_000, 40_000, 15_000).unwrap();
        let json: serde_json::Value =
            serde_json::from_str(&db.get_talk_stats(&m.id).unwrap().unwrap()).unwrap();
        assert_eq!(json["mic_ms"], 70_000);
        assert_eq!(json["sys_ms"], 70_000);
        assert_eq!(json["longest_mono_ms"], 20_000, "monologue is max, not sum");
    }

    // --- Insights cache + narrative facts (plan v6 item 14) ---

    #[test]
    fn insights_cache_upserts_by_key_and_reads_back() {
        let db = Database::new_in_memory().unwrap();
        assert!(db.get_insight("narrative:2026-06").unwrap().is_none());

        db.upsert_insight("narrative:2026-06", "first draft", "{\"a\":1}").unwrap();
        let one = db.get_insight("narrative:2026-06").unwrap().unwrap();
        assert_eq!(one.content, "first draft");
        assert_eq!(one.facts, "{\"a\":1}");

        db.upsert_insight("narrative:2026-06", "regenerated", "{\"a\":2}").unwrap();
        let two = db.get_insight("narrative:2026-06").unwrap().unwrap();
        assert_eq!(two.content, "regenerated");
        assert_eq!(two.facts, "{\"a\":2}");
    }

    #[test]
    fn narrative_facts_counts_only_the_months_completed_meetings() {
        let db = Database::new_in_memory().unwrap();
        let month = chrono::Utc::now().format("%Y-%m").to_string();

        // Two completed meetings this month with 1h + 0.5h spans.
        for (start, end, title) in [
            ("05T10:00:00Z", "05T11:00:00Z", "Design sync"),
            ("06T09:00:00Z", "06T09:30:00Z", "Design sync"),
        ] {
            let m = db.create_meeting(title).unwrap();
            db.update_meeting_times(
                &m.id,
                Some(&format!("{month}-{start}")),
                Some(&format!("{month}-{end}")),
            )
            .unwrap();
            db.update_meeting_status(&m.id, "complete").unwrap();
        }
        // A still-upcoming meeting and a default-titled one must not count
        // toward series; the upcoming one not toward totals.
        db.create_meeting("Future planning").unwrap();
        let u = db.create_meeting("Untitled Meeting").unwrap();
        db.update_meeting_times(
            &u.id,
            Some(&format!("{month}-07T10:00:00Z")),
            Some(&format!("{month}-07T10:30:00Z")),
        )
        .unwrap();
        db.update_meeting_status(&u.id, "complete").unwrap();

        let facts = db.narrative_facts(&month).unwrap();
        assert_eq!(facts["meetings"], 3);
        assert_eq!(facts["hours"], 2.0);
        assert_eq!(facts["prev_month"]["meetings"], 0);
        let series = facts["recurring_series"].as_array().unwrap();
        assert_eq!(series.len(), 1, "untitled meetings must not form a series");
        assert_eq!(series[0]["title"], "Design sync");
        assert_eq!(series[0]["meetings"], 2);
        assert!(facts["busiest_week"].is_object());
    }

    #[test]
    fn prev_month_handles_january() {
        assert_eq!(super::prev_month("2026-01"), "2025-12");
        assert_eq!(super::prev_month("2026-06"), "2026-05");
    }

    #[test]
    fn capped_span_hours_rejects_marathons_and_uses_fallback() {
        let mut m = Database::new_in_memory()
            .unwrap()
            .create_meeting("M")
            .unwrap();
        m.actual_start = Some("2026-06-05T10:00:00Z".into());
        m.actual_end = Some("2026-06-07T10:00:00Z".into()); // 48h "meeting"
        m.scheduled_start = Some("2026-06-05T10:00:00Z".into());
        m.scheduled_end = Some("2026-06-05T10:45:00Z".into());
        assert_eq!(super::capped_span_hours(&m), 0.75);
    }

    // --- Range narrative facts + brag doc (plan v9 item 14) ---

    /// Seed a meeting with actual times; `complete` controls whether it
    /// counts (window filters require status == "complete").
    fn seed_timed_meeting(
        db: &Database,
        title: &str,
        start: &str,
        end: &str,
        complete: bool,
    ) -> super::Meeting {
        let m = db.create_meeting(title).unwrap();
        db.update_meeting_times(&m.id, Some(start), Some(end)).unwrap();
        if complete {
            db.update_meeting_status(&m.id, "complete").unwrap();
        }
        m
    }

    #[test]
    fn months_in_range_handles_quarters_and_years() {
        assert_eq!(
            super::months_in_range("2026-04-01", "2026-07-01"),
            vec!["2026-04", "2026-05", "2026-06"]
        );
        assert_eq!(
            super::months_in_range("2025-10-01", "2026-01-01"),
            vec!["2025-10", "2025-11", "2025-12"]
        );
        let year = super::months_in_range("2026-01-01", "2027-01-01");
        assert_eq!(year.len(), 12);
        assert_eq!(year[0], "2026-01");
        assert_eq!(year[11], "2026-12");
        assert!(super::months_in_range("2026-07-01", "2026-04-01").is_empty());
    }

    #[test]
    fn narrative_facts_range_buckets_by_month_and_respects_window() {
        let db = Database::new_in_memory().unwrap();
        // Q1 2026 (fully in the past, so the begun-months clamp is inert).
        seed_timed_meeting(&db, "Design sync", "2026-01-05T10:00:00Z", "2026-01-05T11:00:00Z", true);
        seed_timed_meeting(&db, "Design sync", "2026-01-12T10:00:00Z", "2026-01-12T11:00:00Z", true);
        seed_timed_meeting(&db, "Design sync", "2026-02-02T09:00:00Z", "2026-02-02T09:30:00Z", true);
        seed_timed_meeting(&db, "Too early", "2025-12-31T10:00:00Z", "2025-12-31T11:00:00Z", true);
        // `to` is exclusive: the very first instant of April is out.
        seed_timed_meeting(&db, "Too late", "2026-04-01T00:00:00Z", "2026-04-01T01:00:00Z", true);
        seed_timed_meeting(&db, "Never happened", "2026-02-03T10:00:00Z", "2026-02-03T11:00:00Z", false);

        let facts = db
            .narrative_facts_range("2026-Q1", "2026-01-01", "2026-04-01")
            .unwrap();
        assert_eq!(facts["period"], "2026-Q1");
        assert_eq!(facts["meetings"], 3);
        assert_eq!(facts["hours"], 2.5);

        let by_month = facts["by_month"].as_array().unwrap();
        assert_eq!(by_month.len(), 3, "Jan, Feb, Mar buckets — even empty ones");
        assert_eq!(by_month[0]["month"], "2026-01");
        assert_eq!(by_month[0]["meetings"], 2);
        assert_eq!(by_month[0]["hours"], 2.0);
        assert_eq!(by_month[1]["month"], "2026-02");
        assert_eq!(by_month[1]["meetings"], 1);
        assert_eq!(by_month[1]["hours"], 0.5);
        assert_eq!(by_month[2]["month"], "2026-03");
        assert_eq!(by_month[2]["meetings"], 0);

        let series = facts["recurring_series"].as_array().unwrap();
        assert_eq!(series.len(), 1, "3 instances over the window form a series");
        assert_eq!(series[0]["title"], "Design sync");
        assert_eq!(series[0]["meetings"], 3);
        assert!(facts["busiest_week"].is_object());
    }

    #[test]
    fn narrative_facts_range_leaks_no_transcripts_notes_or_people() {
        let db = Database::new_in_memory().unwrap();
        let m = seed_timed_meeting(
            &db,
            "Compensation planning",
            "2026-02-03T10:00:00Z",
            "2026-02-03T11:00:00Z",
            true,
        );
        seed_transcript(&db, &m.id, "SECRET-TRANSCRIPT salary numbers for the team");
        let note = db.get_or_create_note(&m.id).unwrap();
        db.update_note_raw_content(
            &note.id,
            r#"{"type":"doc","content":[
                {"type":"paragraph","content":[{"type":"text","text":"SECRET-NOTE-BODY"}]},
                {"type":"actionItem","attrs":{"task":"SECRET-TASK email legal","assignee":"SECRET-PERSON","deadline":null,"done":true}}
            ]}"#,
        )
        .unwrap();
        db.set_setting("topic_trackers", "salary").unwrap();

        let facts = db
            .narrative_facts_range("2026-Q1", "2026-01-01", "2026-04-01")
            .unwrap();

        // The privacy contract, asserted on the serialized JSON: counts,
        // hours, and titles only — nothing from transcripts, note bodies,
        // task text, or people may appear.
        let s = serde_json::to_string(&facts).unwrap();
        for leak in ["SECRET-TRANSCRIPT", "SECRET-NOTE-BODY", "SECRET-TASK", "SECRET-PERSON"] {
            assert!(!s.contains(leak), "facts JSON must never contain {leak}: {s}");
        }

        // And the shape is a closed set — new fields must be added consciously.
        let mut keys: Vec<&str> = facts.as_object().unwrap().keys().map(|k| k.as_str()).collect();
        keys.sort();
        assert_eq!(
            keys,
            ["busiest_week", "by_month", "from", "hours", "meetings", "period",
             "recurring_series", "tasks", "to", "topics"]
        );

        // Aggregates still work: the task counted, the tracked term counted.
        assert_eq!(facts["tasks"]["captured"], 1);
        assert_eq!(facts["tasks"]["done"], 1);
        assert_eq!(facts["topics"][0]["term"], "salary");
        assert_eq!(facts["topics"][0]["meetings"], 1);
    }

    #[test]
    fn brag_doc_includes_done_excludes_dropped_and_groups_by_month() {
        let db = Database::new_in_memory().unwrap();
        let april = seed_timed_meeting(&db, "Pricing review", "2026-04-03T10:00:00Z", "2026-04-03T11:00:00Z", true);
        let may = seed_timed_meeting(&db, "Design sync", "2026-05-12T10:00:00Z", "2026-05-12T10:30:00Z", true);
        let march = seed_timed_meeting(&db, "Old standup", "2026-03-02T10:00:00Z", "2026-03-02T11:00:00Z", true);

        // April: one done, one still open, one done-but-consciously-dropped.
        let na = db.get_or_create_note(&april.id).unwrap();
        db.update_note_raw_content(
            &na.id,
            r#"{"type":"doc","content":[
                {"type":"actionItem","attrs":{"task":"Send pricing proposal","done":true}},
                {"type":"actionItem","attrs":{"task":"Draft follow-up","done":false}},
                {"type":"actionItem","attrs":{"task":"Dropped thing","done":true}}
            ]}"#,
        )
        .unwrap();
        db.set_task_dropped(&na.id, "raw", 2, true, None).unwrap();

        // May: done item, snoozed far out (snooze must not hide a brag), and
        // duplicated verbatim in the AI body (must appear exactly once).
        let nm = db.get_or_create_note(&may.id).unwrap();
        let ship = r#"{"type":"doc","content":[{"type":"actionItem","attrs":{"task":"Ship onboarding fix","done":true}}]}"#;
        db.update_note_raw_content(&nm.id, ship).unwrap();
        db.update_note_generated_content(&nm.id, ship).unwrap();
        db.set_task_snooze(&nm.id, "raw", 0, Some("2099-01-01"), None).unwrap();

        // March (outside the Q2 window): a done item that must not appear.
        let no = db.get_or_create_note(&march.id).unwrap();
        db.update_note_raw_content(
            &no.id,
            r#"{"type":"doc","content":[{"type":"actionItem","attrs":{"task":"Out-of-window chore","done":true}}]}"#,
        )
        .unwrap();

        let doc = db.build_brag_doc("2026-Q2", "2026-04-01", "2026-07-01").unwrap();

        assert!(doc.contains("# Brag doc — Q2 2026"), "{doc}");
        assert!(doc.contains("- 2 meetings (1.5 hours)"), "{doc}");
        assert!(doc.contains("- 2 of 3 captured action items completed"), "{doc}");

        assert!(doc.contains("### April 2026"), "{doc}");
        assert!(doc.contains("- [x] Send pricing proposal — Pricing review (Apr 3)"), "{doc}");
        assert!(doc.contains("### May 2026"), "{doc}");
        assert!(doc.contains("- [x] Ship onboarding fix — Design sync (May 12)"), "{doc}");
        assert!(
            doc.find("### April 2026").unwrap() < doc.find("### May 2026").unwrap(),
            "months in chronological order"
        );

        assert_eq!(doc.matches("Ship onboarding fix").count(), 1, "raw+AI copies dedupe");
        assert!(!doc.contains("Dropped thing"), "dropped items are excluded");
        assert!(!doc.contains("Draft follow-up"), "open items are not brags");
        assert!(!doc.contains("Out-of-window chore"));
        assert!(!doc.contains("Old standup"));
    }

    #[test]
    fn brag_doc_lists_sustained_series_and_grown_topics() {
        let db = Database::new_in_memory().unwrap();
        // Q1 2026: a sustained series (3 instances) and a topic that grew
        // from 0 mentions in January to 2 distinct meetings in March.
        for (start, end) in [
            ("2026-01-07T10:00:00Z", "2026-01-07T10:30:00Z"),
            ("2026-02-04T10:00:00Z", "2026-02-04T10:30:00Z"),
            ("2026-03-04T10:00:00Z", "2026-03-04T10:30:00Z"),
        ] {
            seed_timed_meeting(&db, "Design sync", start, end, true);
        }
        let a = seed_timed_meeting(&db, "Pricing deep dive", "2026-03-10T10:00:00Z", "2026-03-10T11:00:00Z", true);
        seed_transcript(&db, &a.id, "pricing model walkthrough");
        let b = seed_timed_meeting(&db, "Exec review", "2026-03-17T10:00:00Z", "2026-03-17T11:00:00Z", true);
        seed_transcript(&db, &b.id, "pricing approval discussion");
        db.set_setting("topic_trackers", "pricing").unwrap();

        let doc = db.build_brag_doc("2026-Q1", "2026-01-01", "2026-04-01").unwrap();
        assert!(doc.contains("- Series sustained: Design sync (3 meetings)"), "{doc}");
        assert!(
            doc.contains("- Topics that grew: pricing (0 meetings in January 2026 → 2 in March 2026)"),
            "{doc}"
        );
        assert!(doc.contains("Nothing checked off in this period yet"), "{doc}");
    }

    #[test]
    fn topic_trend_counts_survives_fts_metacharacters() {
        let db = Database::new_in_memory().unwrap();
        let m = db.create_meeting("M").unwrap();
        seed_transcript(&db, &m.id, "project alpha status");

        // Operator-looking and quoted input must be treated literally, never parsed.
        let trends = db
            .topic_trend_counts(
                &["project alpha".into(), "\"OR\" NOT(".into(), "***".into()],
                "2000-01-01",
            )
            .unwrap();
        assert_eq!(trends.len(), 3);
        assert_eq!(trends[0].counts[0].meetings, 1);
        // "***" sanitizes to nothing → empty counts, row preserved.
        assert!(trends[2].counts.is_empty());
    }

    // --- calendar upsert honors user decisions (data-lifecycle audit P1) ---

    #[test]
    fn calendar_sync_cannot_resurrect_trash_or_revert_renames() {
        let db = db();
        let m = db
            .upsert_calendar_meeting("ev1", "Standup", "2026-06-12T09:00:00Z", "2026-06-12T09:30:00Z", "[]", None, None, "zoom")
            .unwrap();
        // User renames and trashes it; the next unchanged sync must touch neither.
        db.update_meeting_title(&m.id, "1:1 with Amy").unwrap();
        db.soft_delete_meeting(&m.id).unwrap();
        let synced = db
            .upsert_calendar_meeting("ev1", "Standup", "2026-06-12T09:00:00Z", "2026-06-12T09:30:00Z", "[]", None, None, "zoom")
            .unwrap();
        assert_eq!(synced.id, m.id);
        assert_eq!(synced.title, "1:1 with Amy", "rename must stick");
        assert!(synced.deleted_at.is_some(), "trash must stick");
        // A genuine reschedule resurrects (it's a new instance of the event)
        // but still never touches the title.
        let moved = db
            .upsert_calendar_meeting("ev1", "Standup (moved)", "2026-06-13T09:00:00Z", "2026-06-13T09:30:00Z", "[]", None, None, "zoom")
            .unwrap();
        assert!(moved.deleted_at.is_none(), "reschedule resurrects");
        assert_eq!(moved.title, "1:1 with Amy");
        assert_eq!(moved.scheduled_start.as_deref(), Some("2026-06-13T09:00:00Z"));
    }

    // --- markdown_of_tiptap (plan v10 #11, MCP notes-as-markdown) ---

    #[test]
    fn markdown_of_tiptap_preserves_structure() {
        let doc = serde_json::json!({
            "type": "doc",
            "content": [
                { "type": "heading", "attrs": { "level": 2 },
                  "content": [{ "type": "text", "text": "Decisions" }] },
                { "type": "bulletList", "content": [
                    { "type": "listItem", "content": [
                        { "type": "paragraph",
                          "content": [{ "type": "text", "text": "Ship it",
                                        "marks": [{ "type": "bold" }] }] }
                    ]}
                ]},
                { "type": "taskList", "content": [
                    { "type": "taskItem", "attrs": { "checked": true },
                      "content": [{ "type": "paragraph",
                                    "content": [{ "type": "text", "text": "Send recap" }] }] }
                ]},
                { "type": "actionItem",
                  "attrs": { "done": false, "task": "Book room", "assignee": "Amy" } }
            ]
        })
        .to_string();
        let md = super::markdown_of_tiptap(&doc);
        assert_eq!(
            md,
            "## Decisions\n- **Ship it**\n- [x] Send recap\n- [ ] Book room (@Amy)"
        );
    }

    #[test]
    fn markdown_of_tiptap_link_safety_and_degradation() {
        let doc = serde_json::json!({
            "type": "doc",
            "content": [
                { "type": "paragraph", "content": [
                    { "type": "text", "text": "site",
                      "marks": [{ "type": "link", "attrs": { "href": "https://a.example" } }] },
                    { "type": "text", "text": " and " },
                    { "type": "text", "text": "bad",
                      "marks": [{ "type": "link", "attrs": { "href": "javascript:alert(1)" } }] }
                ]},
                { "type": "someFutureNode", "content": [
                    { "type": "text", "text": "still visible" }
                ]}
            ]
        })
        .to_string();
        let md = super::markdown_of_tiptap(&doc);
        assert!(md.contains("[site](https://a.example)"));
        assert!(md.contains("bad"), "unsafe-scheme text survives as plain text");
        assert!(!md.contains("javascript:"), "unsafe scheme never becomes a link");
        assert!(md.contains("still visible"), "unknown nodes degrade to their text");
        // Corrupt JSON degrades to empty, same contract as plain_text_of_tiptap.
        assert_eq!(super::markdown_of_tiptap("not json"), "");
    }
}
