use chrono::Utc;
use serde::{Deserialize, Serialize};
use rusqlite::params;
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

    pub fn delete_meeting(&self, id: &str) -> Result<()> {
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

        let existing: Option<String> = conn
            .query_row(
                "SELECT id FROM meetings WHERE calendar_event_id = ?1",
                params![calendar_event_id],
                |row| row.get(0),
            )
            .ok();

        if let Some(id) = existing {
            conn.execute(
                "UPDATE meetings SET title=?1, scheduled_start=?2, scheduled_end=?3,
                 attendees=?4, location=?5, meeting_url=?6, platform=?7, updated_at=?8,
                 deleted_at=NULL, is_archived=0
                 WHERE id=?9",
                params![title, scheduled_start, scheduled_end, attendees, location, meeting_url, platform, now, id],
            )?;
            drop(conn);
            Ok(self.get_meeting(&id)?.unwrap())
        } else {
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
        })
    }

    pub fn get_note_by_meeting(&self, meeting_id: &str) -> Result<Option<Note>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, meeting_id, raw_content, generated_content, template_id, created_at, updated_at
             FROM notes WHERE meeting_id = ?1 ORDER BY created_at DESC LIMIT 1"
        )?;
        let mut rows = stmt.query_map(params![meeting_id], |row| {
            Ok(Note {
                id: row.get(0)?,
                meeting_id: row.get(1)?,
                raw_content: row.get(2)?,
                generated_content: row.get(3)?,
                template_id: row.get(4)?,
                created_at: row.get(5)?,
                updated_at: row.get(6)?,
            })
        })?;
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
        Ok(Tag {
            id,
            name: name.to_string(),
            source: source.to_string(),
            created_at: now,
        })
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
        let mut stmt = conn.prepare(
            "SELECT t.meeting_id
             FROM transcripts t
             JOIN transcripts_fts fts ON fts.rowid = t.rowid
             WHERE transcripts_fts MATCH ?1
             ORDER BY rank
             LIMIT ?2"
        )?;
        let rows = stmt.query_map(params![fts_query, limit], |row| {
            row.get::<_, String>(0)
        })?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    /// Unified search across meeting titles, transcript content, and note content.
    /// Returns meeting IDs with the source of the match.
    pub fn search_all(&self, query: &str, limit: usize) -> Result<Vec<SearchResult>> {
        let conn = self.conn.lock().unwrap();
        let like_query = format!("%{}%", query);
        let mut results: Vec<SearchResult> = Vec::new();
        let mut seen_ids: std::collections::HashSet<String> = std::collections::HashSet::new();

        // 1. Search meeting titles (LIKE)
        {
            let mut stmt = conn.prepare(
                "SELECT id, title FROM meetings WHERE title LIKE ?1 COLLATE NOCASE LIMIT ?2"
            )?;
            let rows = stmt.query_map(params![like_query, limit], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?;
            for row in rows.flatten() {
                if seen_ids.insert(row.0.clone()) {
                    results.push(SearchResult {
                        meeting_id: row.0,
                        match_source: "title".to_string(),
                        snippet: row.1,
                    });
                }
            }
        }

        // 2. Search transcripts (FTS)
        {
            let fts_query = sanitize_fts_query(query);

            if !fts_query.is_empty() {
                let mut stmt = conn.prepare(
                    "SELECT t.meeting_id, snippet(transcripts_fts, 0, '→', '←', '...', 32)
                     FROM transcripts t
                     JOIN transcripts_fts fts ON fts.rowid = t.rowid
                     WHERE transcripts_fts MATCH ?1
                     ORDER BY rank
                     LIMIT ?2"
                )?;
                let rows = stmt.query_map(params![fts_query, limit], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                });
                if let Ok(rows) = rows {
                    for row in rows.flatten() {
                        if seen_ids.insert(row.0.clone()) {
                            results.push(SearchResult {
                                meeting_id: row.0,
                                match_source: "transcript".to_string(),
                                snippet: row.1,
                            });
                        }
                    }
                }
            }
        }

        // 3. Search notes raw_content and generated_content (LIKE)
        {
            let mut stmt = conn.prepare(
                "SELECT n.meeting_id, COALESCE(n.generated_content, n.raw_content, '')
                 FROM notes n
                 WHERE n.raw_content LIKE ?1 COLLATE NOCASE
                    OR n.generated_content LIKE ?1 COLLATE NOCASE
                 LIMIT ?2"
            )?;
            let rows = stmt.query_map(params![like_query, limit], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?;
            for row in rows.flatten() {
                if seen_ids.insert(row.0.clone()) {
                    // Extract a short snippet around the match
                    let content = row.1;
                    let snippet = extract_snippet(&content, query, 80);
                    results.push(SearchResult {
                        meeting_id: row.0,
                        match_source: "notes".to_string(),
                        snippet,
                    });
                }
            }
        }

        results.truncate(limit);
        Ok(results)
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
            let mut note_stmt = conn.prepare("SELECT id, meeting_id, raw_content, generated_content, template_id, created_at, updated_at FROM notes")?;
            let notes: Vec<Note> = note_stmt.query_map([], |row| {
                Ok(Note { id: row.get(0)?, meeting_id: row.get(1)?, raw_content: row.get(2)?, generated_content: row.get(3)?, template_id: row.get(4)?, created_at: row.get(5)?, updated_at: row.get(6)? })
            })?.filter_map(|r| r.ok()).collect();

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

    /// Find the voice profile most similar to `query` by cosine similarity.
    /// Returns `Some((name, similarity))` when the best match exceeds
    /// `threshold`, otherwise `None`. Profiles without an embedding are
    /// skipped (legacy rows from before this feature shipped).
    pub fn match_voice_profile(
        &self,
        query: &[f32],
        threshold: f32,
    ) -> anyhow::Result<Option<(String, f32)>> {
        use crate::audio::mel::cosine_similarity;
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT speaker_name, embedding FROM voice_profiles WHERE embedding IS NOT NULL"
        )?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;

        let mut best: Option<(String, f32)> = None;
        for row in rows {
            let (name, emb_json) = row?;
            let emb: Vec<f32> = match serde_json::from_str(&emb_json) {
                Ok(v) => v,
                Err(_) => continue,
            };
            if emb.len() != query.len() { continue; }
            let sim = cosine_similarity(query, &emb);
            match &best {
                Some((_, s)) if sim <= *s => {}
                _ => best = Some((name, sim)),
            }
        }

        Ok(best.filter(|(_, s)| *s >= threshold))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchResult {
    pub meeting_id: String,
    pub match_source: String,
    pub snippet: String,
}

/// Extract a short snippet from content around the first occurrence of the query.
fn extract_snippet(content: &str, query: &str, max_len: usize) -> String {
    let lower_content = content.to_lowercase();
    let lower_query = query.to_lowercase();
    if let Some(pos) = lower_content.find(&lower_query) {
        let start = pos.saturating_sub(max_len / 2);
        let end = (pos + query.len() + max_len / 2).min(content.len());
        // Find safe char boundaries
        let start = content[..start].rfind(char::is_whitespace).map(|p| p + 1).unwrap_or(start);
        let end = content[end..].find(char::is_whitespace).map(|p| end + p).unwrap_or(end);
        let mut snippet = content[start..end].to_string();
        if start > 0 { snippet = format!("...{}", snippet); }
        if end < content.len() { snippet = format!("{}...", snippet); }
        snippet
    } else {
        content.chars().take(max_len).collect()
    }
}

#[cfg(test)]
mod tests {
    use crate::db::Database;

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
}
