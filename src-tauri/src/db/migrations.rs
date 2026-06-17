use rusqlite_migration::{Migrations, M};

pub fn migrations() -> Migrations<'static> {
    Migrations::new(vec![
        M::up(
            "CREATE TABLE meetings (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                scheduled_start TEXT,
                scheduled_end TEXT,
                actual_start TEXT,
                actual_end TEXT,
                calendar_event_id TEXT,
                attendees TEXT DEFAULT '[]',
                location TEXT,
                meeting_url TEXT,
                platform TEXT DEFAULT 'unknown',
                status TEXT DEFAULT 'upcoming',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE notes (
                id TEXT PRIMARY KEY,
                meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
                raw_content TEXT,
                generated_content TEXT,
                template_id TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE transcripts (
                id TEXT PRIMARY KEY,
                meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
                segments TEXT DEFAULT '[]',
                source TEXT NOT NULL,
                language TEXT DEFAULT 'en',
                created_at TEXT NOT NULL
            );

            CREATE TABLE chat_messages (
                id TEXT PRIMARY KEY,
                meeting_id TEXT REFERENCES meetings(id) ON DELETE CASCADE,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                context_meeting_ids TEXT DEFAULT '[]',
                created_at TEXT NOT NULL
            );

            CREATE TABLE templates (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                description TEXT,
                prompt_template TEXT NOT NULL,
                sections TEXT DEFAULT '[]',
                is_default INTEGER DEFAULT 0,
                is_builtin INTEGER DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE folders (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                color TEXT DEFAULT '#6366f1',
                icon TEXT DEFAULT '📁',
                sort_order INTEGER DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE meeting_folders (
                meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
                folder_id TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
                PRIMARY KEY (meeting_id, folder_id)
            );

            CREATE TABLE tags (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL UNIQUE,
                source TEXT DEFAULT 'manual',
                created_at TEXT NOT NULL
            );

            CREATE TABLE meeting_tags (
                meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
                tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
                PRIMARY KEY (meeting_id, tag_id)
            );

            CREATE TABLE settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );

            CREATE INDEX idx_meetings_status ON meetings(status);
            CREATE INDEX idx_meetings_scheduled_start ON meetings(scheduled_start);
            CREATE INDEX idx_meetings_calendar_event_id ON meetings(calendar_event_id);
            CREATE INDEX idx_notes_meeting_id ON notes(meeting_id);
            CREATE INDEX idx_transcripts_meeting_id ON transcripts(meeting_id);
            CREATE INDEX idx_chat_messages_meeting_id ON chat_messages(meeting_id);
            "
        ),
        M::up(
            "CREATE VIRTUAL TABLE transcripts_fts USING fts5(
                content,
                content='transcripts',
                content_rowid='rowid'
            );

            CREATE TRIGGER transcripts_ai AFTER INSERT ON transcripts BEGIN
                INSERT INTO transcripts_fts(rowid, content)
                SELECT rowid, segments FROM transcripts WHERE id = new.id;
            END;

            CREATE TRIGGER transcripts_ad AFTER DELETE ON transcripts BEGIN
                INSERT INTO transcripts_fts(transcripts_fts, rowid, content)
                VALUES('delete', old.rowid, old.segments);
            END;"
        ),
        // Migration 3: Add UPDATE trigger for transcripts FTS (segments are appended after creation)
        M::up(
            "CREATE TRIGGER transcripts_au AFTER UPDATE OF segments ON transcripts BEGIN
                INSERT INTO transcripts_fts(transcripts_fts, rowid, content)
                VALUES('delete', old.rowid, old.segments);
                INSERT INTO transcripts_fts(rowid, content)
                SELECT rowid, segments FROM transcripts WHERE id = new.id;
            END;"
        ),
        // Migration 4: Pinning, archival, soft delete, speaker labels, meeting links
        M::up(
            "ALTER TABLE meetings ADD COLUMN is_pinned INTEGER NOT NULL DEFAULT 0;
             ALTER TABLE meetings ADD COLUMN is_archived INTEGER NOT NULL DEFAULT 0;
             ALTER TABLE meetings ADD COLUMN deleted_at TEXT;

             CREATE TABLE speaker_labels (
                 id TEXT PRIMARY KEY,
                 speaker_key TEXT NOT NULL,
                 display_name TEXT NOT NULL,
                 color TEXT,
                 created_at TEXT NOT NULL,
                 UNIQUE(speaker_key)
             );

             CREATE TABLE meeting_links (
                 source_meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
                 target_meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
                 link_type TEXT NOT NULL DEFAULT 'related',
                 created_at TEXT NOT NULL,
                 PRIMARY KEY (source_meeting_id, target_meeting_id)
             );

             CREATE INDEX idx_meetings_is_pinned ON meetings(is_pinned);
             CREATE INDEX idx_meetings_is_archived ON meetings(is_archived);
             CREATE INDEX idx_meetings_deleted_at ON meetings(deleted_at);"
        ),
        // Migration 5: Voice profiles and participant type 
        M::up(
            "CREATE TABLE voice_profiles (
                 id TEXT PRIMARY KEY,
                 speaker_name TEXT NOT NULL,
                 sample_path TEXT NOT NULL,
                 created_at TEXT NOT NULL
             );

             CREATE INDEX idx_voice_profiles_name ON voice_profiles(speaker_name);

             ALTER TABLE speaker_labels ADD COLUMN participant_type TEXT DEFAULT 'in-room';"
        ),
        // Migration 6: Attachments table 
        M::up(
            "CREATE TABLE attachments (
                id TEXT PRIMARY KEY,
                meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
                file_name TEXT NOT NULL,
                file_path TEXT NOT NULL,
                file_type TEXT NOT NULL DEFAULT 'application/octet-stream',
                file_size INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL
            );

            CREATE INDEX idx_attachments_meeting_id ON attachments(meeting_id);"
        ),
        // Migration 7: Recording device info — which mic was used and whether system audio was captured
        M::up(
            "ALTER TABLE meetings ADD COLUMN device_name TEXT;
             ALTER TABLE meetings ADD COLUMN system_audio_captured INTEGER NOT NULL DEFAULT 0;"
        ),
        // Migration 8: Nested folders — parent_id for tree structure
        M::up(
            "ALTER TABLE folders ADD COLUMN parent_id TEXT REFERENCES folders(id);"
        ),
        // Migration 9: mention_candidates table + backfill from existing meetings
        M::up(
            r#"
    CREATE TABLE mention_candidates (
        name TEXT PRIMARY KEY,
        freq INTEGER NOT NULL DEFAULT 1,
        last_seen_at TEXT NOT NULL
    );
    CREATE INDEX idx_mention_candidates_freq
        ON mention_candidates(freq DESC, last_seen_at DESC);

    -- Backfill from existing meetings. The attendees column is a JSON array;
    -- json_each unrolls it. Names that appear in 0 meetings just don't show.
    INSERT INTO mention_candidates (name, freq, last_seen_at)
    SELECT
        TRIM(CASE
            WHEN j.type = 'object' THEN
                COALESCE(json_extract(j.value, '$.name'),
                         SUBSTR(json_extract(j.value, '$.email'), 1,
                                INSTR(json_extract(j.value, '$.email'), '@') - 1))
            ELSE
                CASE WHEN INSTR(j.value, '@') > 0
                    THEN SUBSTR(j.value, 1, INSTR(j.value, '@') - 1)
                    ELSE j.value
                END
        END) AS name,
        COUNT(*) AS freq,
        MAX(m.created_at) AS last_seen_at
    FROM meetings m, json_each(m.attendees) j
    WHERE m.deleted_at IS NULL
      AND m.attendees IS NOT NULL
      AND m.attendees <> ''
      AND m.attendees <> '[]'
      AND TRIM(CASE
            WHEN j.type = 'object' THEN
                COALESCE(json_extract(j.value, '$.name'),
                         json_extract(j.value, '$.email'))
            ELSE j.value
          END) <> ''
    GROUP BY name
    ON CONFLICT(name) DO UPDATE
        SET freq = freq + excluded.freq,
            last_seen_at = MAX(last_seen_at, excluded.last_seen_at);
    "#,
        ),
        // Migration 10: Add embedding column to voice_profiles for speaker recognition
        M::up(
            "ALTER TABLE voice_profiles ADD COLUMN embedding TEXT;"
        ),
        // Migration 11: Scope speaker_labels by meeting_id.
        //
        // The previous schema had UNIQUE(speaker_key), which made labels
        // global: naming "Speaker 1" as "Alice" in meeting A would
        // auto-attribute "Speaker 1" in meeting B to Alice too, even when
        // it's a different person. Cross-meeting identity should be
        // established by voice_profiles embedding similarity, not by
        // label-key collision.
        //
        // We rebuild the table with a UNIQUE(meeting_id, speaker_key)
        // constraint. Existing rows keep their data but get NULL
        // meeting_id and become legacy/orphan labels — list_speaker_labels
        // still returns them (for export), but list_speaker_labels_for_meeting
        // ignores them.
        M::up(
            "CREATE TABLE speaker_labels_new (
                 id TEXT PRIMARY KEY,
                 meeting_id TEXT REFERENCES meetings(id) ON DELETE CASCADE,
                 speaker_key TEXT NOT NULL,
                 display_name TEXT NOT NULL,
                 color TEXT,
                 participant_type TEXT DEFAULT 'in-room',
                 created_at TEXT NOT NULL,
                 UNIQUE(meeting_id, speaker_key)
             );

             INSERT INTO speaker_labels_new
                 (id, meeting_id, speaker_key, display_name, color, participant_type, created_at)
             SELECT id, NULL, speaker_key, display_name, color, participant_type, created_at
             FROM speaker_labels;

             DROP TABLE speaker_labels;
             ALTER TABLE speaker_labels_new RENAME TO speaker_labels;

             CREATE INDEX idx_speaker_labels_meeting ON speaker_labels(meeting_id);"
        ),
        // Migration 12: Pre-call prep briefs — one generated brief per
        // meeting, built from local history (+ the configured AI provider).
        M::up(
            "CREATE TABLE prep_briefs (
                 meeting_id TEXT PRIMARY KEY REFERENCES meetings(id) ON DELETE CASCADE,
                 content TEXT NOT NULL,
                 generated_at TEXT NOT NULL
             );"
        ),
        // Migration 13: Per-meeting recording stats (talk balance JSON).
        M::up(
            "CREATE TABLE meeting_stats (
                 meeting_id TEXT PRIMARY KEY REFERENCES meetings(id) ON DELETE CASCADE,
                 talk_stats TEXT NOT NULL
             );"
        ),
        // Migration 14: Apple Reminders links — makes export idempotent and
        // enables pulling completion state back (plan v5 rank 2).
        M::up(
            "CREATE TABLE reminder_links (
                 note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
                 source TEXT NOT NULL,
                 idx INTEGER NOT NULL,
                 reminder_id TEXT NOT NULL,
                 PRIMARY KEY (note_id, source, idx)
             );
             CREATE INDEX idx_reminder_links_reminder ON reminder_links(reminder_id);"
        ),
        // Migration 15: Task overlays — snooze/drop state for action items,
        // keyed by the same identity triple as done write-back. Kept OUT of
        // the note content so notes stay the honest historical record.
        M::up(
            "CREATE TABLE task_overlays (
                 note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
                 source TEXT NOT NULL,
                 idx INTEGER NOT NULL,
                 snoozed_until TEXT,
                 dropped INTEGER NOT NULL DEFAULT 0,
                 PRIMARY KEY (note_id, source, idx)
             );"
        ),
        // Migration 16: Insights cache — generated monthly narratives keyed
        // "narrative:YYYY-MM", stored beside the exact facts JSON they were
        // generated from (so the user can inspect precisely what was shared
        // with their AI provider).
        M::up(
            "CREATE TABLE insights_cache (
                 key TEXT PRIMARY KEY,
                 content TEXT NOT NULL,
                 facts TEXT NOT NULL,
                 created_at TEXT NOT NULL
             );"
        ),
        // Migration 17: Per-segment FTS (plan v8 A1). The old transcripts_fts
        // indexed the RAW SEGMENTS JSON — keys, speaker ids, and every digit
        // of every millisecond timestamp polluted the index and skewed BM25 —
        // and its external-content column name didn't match the source
        // column, so snippet()/highlight() errored at read time. The fix:
        // a materialized segment table (a rebuildable derived index; the
        // segments JSON stays canonical) kept in sync by triggers, plus an
        // FTS table whose column name MATCHES. Zero Rust write-path changes.
        M::up(
            "CREATE TABLE transcript_segments (
                 id            INTEGER PRIMARY KEY,
                 transcript_id TEXT NOT NULL REFERENCES transcripts(id) ON DELETE CASCADE,
                 meeting_id    TEXT NOT NULL,
                 seg_idx       INTEGER NOT NULL,
                 speaker_key   TEXT,
                 start_ms      INTEGER,
                 end_ms        INTEGER,
                 text          TEXT NOT NULL,
                 UNIQUE(transcript_id, seg_idx)
             );
             CREATE INDEX idx_tsegs_meeting ON transcript_segments(meeting_id);

             CREATE VIRTUAL TABLE segments_fts USING fts5(
                 text, content='transcript_segments', content_rowid='id'
             );

             CREATE TRIGGER tsegs_ai AFTER INSERT ON transcript_segments BEGIN
                 INSERT INTO segments_fts(rowid, text) VALUES (new.id, new.text);
             END;
             CREATE TRIGGER tsegs_ad AFTER DELETE ON transcript_segments BEGIN
                 INSERT INTO segments_fts(segments_fts, rowid, text)
                 VALUES('delete', old.id, old.text);
             END;
             CREATE TRIGGER tsegs_au AFTER UPDATE OF text ON transcript_segments BEGIN
                 INSERT INTO segments_fts(segments_fts, rowid, text)
                 VALUES('delete', old.id, old.text);
                 INSERT INTO segments_fts(rowid, text) VALUES (new.id, new.text);
             END;

             CREATE TRIGGER transcripts_seg_sync_upd AFTER UPDATE OF segments ON transcripts BEGIN
                 DELETE FROM transcript_segments WHERE transcript_id = old.id;
                 INSERT INTO transcript_segments
                     (transcript_id, meeting_id, seg_idx, speaker_key, start_ms, end_ms, text)
                 SELECT new.id, new.meeting_id, je.key,
                        json_extract(je.value,'$.speaker'),
                        json_extract(je.value,'$.start_ms'),
                        json_extract(je.value,'$.end_ms'),
                        COALESCE(json_extract(je.value,'$.text'),'')
                 FROM json_each(new.segments) je;
             END;
             CREATE TRIGGER transcripts_seg_sync_ins AFTER INSERT ON transcripts BEGIN
                 INSERT INTO transcript_segments
                     (transcript_id, meeting_id, seg_idx, speaker_key, start_ms, end_ms, text)
                 SELECT new.id, new.meeting_id, je.key,
                        json_extract(je.value,'$.speaker'),
                        json_extract(je.value,'$.start_ms'),
                        json_extract(je.value,'$.end_ms'),
                        COALESCE(json_extract(je.value,'$.text'),'')
                 FROM json_each(new.segments) je;
             END;

             INSERT INTO transcript_segments
                 (transcript_id, meeting_id, seg_idx, speaker_key, start_ms, end_ms, text)
             SELECT t.id, t.meeting_id, je.key,
                    json_extract(je.value,'$.speaker'),
                    json_extract(je.value,'$.start_ms'),
                    json_extract(je.value,'$.end_ms'),
                    COALESCE(json_extract(je.value,'$.text'),'')
             FROM transcripts t, json_each(t.segments) je;

             DROP TRIGGER transcripts_ai;
             DROP TRIGGER transcripts_ad;
             DROP TRIGGER transcripts_au;
             DROP TABLE transcripts_fts;"
        ),
        // Migration 18: Enhance receipts (plan v10 #2) — provenance for AI
        // notes. Which provider/model wrote generated_content, when, and the
        // sha256 of the segments JSON it read (same hash as the accuracy
        // pass) so the UI can flag "transcript changed after these notes".
        // generated_previous is the ONE-slot history: a JSON envelope
        // {content, provider, model, generated_at, transcript_sha} of the
        // version a re-enhance replaced, so restore can swap receipts too.
        // Purely additive ALTERs, no backfill — pre-18 notes keep NULLs and
        // the UI renders nothing (absent, not empty).
        M::up(
            "ALTER TABLE notes ADD COLUMN generated_provider TEXT;
             ALTER TABLE notes ADD COLUMN generated_model TEXT;
             ALTER TABLE notes ADD COLUMN generated_at TEXT;
             ALTER TABLE notes ADD COLUMN generated_transcript_sha TEXT;
             ALTER TABLE notes ADD COLUMN generated_previous TEXT;"
        ),
        // Migration 19: task identity anchors (data-lifecycle audit P1).
        // Overlays and reminder links address tasks by (note_id, source,
        // idx) — a bare position. Deleting/inserting an action item above
        // shifts every later index, so a Reminders completion could mark
        // the WRONG task done and a snooze could re-target itself. The
        // task's text at write time anchors the identity: write-back
        // verifies it and re-locates by text when the position drifted.
        // NULL = legacy rows, which keep the old positional behavior.
        M::up(
            "ALTER TABLE reminder_links ADD COLUMN task_text TEXT;
             ALTER TABLE task_overlays ADD COLUMN task_text TEXT;"
        ),
    ])
}

#[cfg(test)]
mod migration_9_tests {
    use rusqlite::{params, Connection};

    #[test]
    fn mention_candidates_backfill_counts_overlapping_attendees() {
        let migrations = crate::db::migrations::migrations();
        let mut conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "journal_mode", "WAL").unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();

        // Apply migrations 1-8 only, so the meetings table exists but
        // mention_candidates does not yet.
        migrations.to_version(&mut conn, 8).unwrap();

        // Seed two meetings with overlapping attendee names.
        conn.execute(
            "INSERT INTO meetings (id, title, attendees, created_at, updated_at)
             VALUES (?1, 'M1', ?2, '2026-05-01T10:00:00Z', '2026-05-01T10:00:00Z')",
            params!["m1", r#"["Alice", "Bob"]"#],
        ).unwrap();
        conn.execute(
            "INSERT INTO meetings (id, title, attendees, created_at, updated_at)
             VALUES (?1, 'M2', ?2, '2026-05-10T10:00:00Z', '2026-05-10T10:00:00Z')",
            params!["m2", r#"["Bob", "Carol"]"#],
        ).unwrap();

        // Now apply migration 9 — backfill should pick up the seeded rows.
        // Calling to_latest() is idempotent (no panic, no duplicate rows).
        migrations.to_latest(&mut conn).unwrap();

        let rows: Vec<(String, i64)> = {
            let mut stmt = conn.prepare(
                "SELECT name, freq FROM mention_candidates ORDER BY name"
            ).unwrap();
            stmt
                .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
                .unwrap()
                .map(|r| r.unwrap())
                .collect()
        };

        assert_eq!(rows, vec![
            ("Alice".to_string(), 1),
            ("Bob".to_string(), 2),
            ("Carol".to_string(), 1),
        ]);

        // Calling to_latest() again must be a no-op (idempotency check).
        migrations.to_latest(&mut conn).unwrap();
    }
}

#[cfg(test)]
mod migration_10_tests {
    use crate::db::Database;

    #[test]
    fn voice_profiles_has_embedding_column() {
        let db = Database::new_in_memory().unwrap();
        let conn = db.conn.lock().unwrap();
        let mut stmt = conn.prepare("PRAGMA table_info(voice_profiles)").unwrap();
        let cols: Vec<String> = stmt
            .query_map([], |r| r.get::<_, String>(1))
            .unwrap()
            .filter_map(|r| r.ok())
            .collect();
        assert!(cols.contains(&"embedding".to_string()));
    }
}

#[cfg(test)]
mod migration_11_tests {
    use rusqlite::{params, Connection};

    #[test]
    fn speaker_labels_gains_meeting_id_column() {
        let db = crate::db::Database::new_in_memory().unwrap();
        let conn = db.conn.lock().unwrap();
        let mut stmt = conn.prepare("PRAGMA table_info(speaker_labels)").unwrap();
        let cols: Vec<String> = stmt
            .query_map([], |r| r.get::<_, String>(1))
            .unwrap()
            .filter_map(|r| r.ok())
            .collect();
        assert!(cols.contains(&"meeting_id".to_string()));
    }

    #[test]
    fn legacy_speaker_keys_migrate_to_null_meeting() {
        // Apply migrations up to 10 only, seed pre-migration speaker_labels
        // with the old global UNIQUE(speaker_key) constraint, then apply
        // migration 11 and verify the rows survive with meeting_id = NULL.
        let migrations = crate::db::migrations::migrations();
        let mut conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "journal_mode", "WAL").unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();

        migrations.to_version(&mut conn, 10).unwrap();

        conn.execute(
            "INSERT INTO speaker_labels (id, speaker_key, display_name, color, participant_type, created_at)
             VALUES (?1, 'Speaker 1', 'Alice', NULL, 'in-room', '2026-05-20T10:00:00Z')",
            params!["legacy-id"],
        ).unwrap();

        migrations.to_latest(&mut conn).unwrap();

        let row: (String, Option<String>, String) = conn
            .query_row(
                "SELECT id, meeting_id, display_name FROM speaker_labels WHERE id = ?1",
                params!["legacy-id"],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(row.0, "legacy-id");
        assert!(row.1.is_none(), "legacy row should have NULL meeting_id");
        assert_eq!(row.2, "Alice");
    }

    #[test]
    fn same_speaker_key_in_two_meetings_allowed_after_migration() {
        let db = crate::db::Database::new_in_memory().unwrap();
        let m_a = db.create_meeting("A").unwrap();
        let m_b = db.create_meeting("B").unwrap();

        db.upsert_speaker_label(&m_a.id, "Speaker 1", "Alice", None, None).unwrap();
        db.upsert_speaker_label(&m_b.id, "Speaker 1", "Bob", None, None).unwrap();

        let labels_a = db.list_speaker_labels_for_meeting(&m_a.id).unwrap();
        let labels_b = db.list_speaker_labels_for_meeting(&m_b.id).unwrap();
        assert_eq!(labels_a[0].display_name, "Alice");
        assert_eq!(labels_b[0].display_name, "Bob");
    }
}

#[cfg(test)]
mod migration_18_tests {
    use rusqlite::Connection;

    #[test]
    fn notes_gain_receipt_columns_with_null_defaults() {
        let migrations = crate::db::migrations::migrations();
        let mut conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "journal_mode", "WAL").unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();

        // Seed a pre-18 note, then migrate: the row must survive with NULL
        // receipts (the UI renders ABSENT for these, never an empty receipt).
        migrations.to_version(&mut conn, 17).unwrap();
        conn.execute(
            "INSERT INTO meetings (id, title, attendees, created_at, updated_at)
             VALUES ('m1', 'Old', '[]', '2026-06-01T10:00:00Z', '2026-06-01T10:00:00Z')",
            [],
        ).unwrap();
        conn.execute(
            "INSERT INTO notes (id, meeting_id, generated_content, created_at, updated_at)
             VALUES ('n1', 'm1', '{\"type\":\"doc\"}', '2026-06-01T10:00:00Z', '2026-06-01T10:00:00Z')",
            [],
        ).unwrap();

        migrations.to_latest(&mut conn).unwrap();

        let cols: Vec<String> = {
            let mut stmt = conn.prepare("PRAGMA table_info(notes)").unwrap();
            stmt.query_map([], |r| r.get::<_, String>(1))
                .unwrap()
                .filter_map(|r| r.ok())
                .collect()
        };
        for col in [
            "generated_provider",
            "generated_model",
            "generated_at",
            "generated_transcript_sha",
            "generated_previous",
        ] {
            assert!(cols.contains(&col.to_string()), "notes must gain {col}");
        }

        let row: (Option<String>, Option<String>, Option<String>, Option<String>, Option<String>) =
            conn.query_row(
                "SELECT generated_provider, generated_model, generated_at,
                        generated_transcript_sha, generated_previous
                 FROM notes WHERE id = 'n1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
            .unwrap();
        assert_eq!(row, (None, None, None, None, None), "pre-18 notes get NULL receipts");
    }
}

#[cfg(test)]
mod migration_17_tests {
    use rusqlite::{params, Connection};

    #[test]
    fn segment_backfill_unrolls_existing_transcripts() {
        let migrations = crate::db::migrations::migrations();
        let mut conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "journal_mode", "WAL").unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();

        migrations.to_version(&mut conn, 16).unwrap();

        conn.execute(
            "INSERT INTO meetings (id, title, attendees, created_at, updated_at)
             VALUES ('m1', 'Budget sync', '[]', '2026-06-01T10:00:00Z', '2026-06-01T10:00:00Z')",
            [],
        ).unwrap();
        conn.execute(
            "INSERT INTO transcripts (id, meeting_id, segments, source, created_at)
             VALUES ('t1', 'm1', ?1, 'local', '2026-06-01T10:00:00Z')",
            params![concat!(
                r#"[{"text":"intro chatter","start_ms":0,"end_ms":4000,"speaker":"A"},"#,
                r#"{"text":"the quarterly budget was approved","start_ms":61500,"end_ms":70000,"speaker":"B"}]"#
            )],
        ).unwrap();
        // NULL segments must backfill to zero rows, not error.
        conn.execute(
            "INSERT INTO transcripts (id, meeting_id, segments, source, created_at)
             VALUES ('t2', 'm1', NULL, 'local', '2026-06-01T11:00:00Z')",
            [],
        ).unwrap();

        migrations.to_latest(&mut conn).unwrap();

        let rows: Vec<(String, i64, Option<String>, Option<i64>, String)> = {
            let mut stmt = conn.prepare(
                "SELECT transcript_id, seg_idx, speaker_key, start_ms, text
                 FROM transcript_segments ORDER BY transcript_id, seg_idx",
            ).unwrap();
            stmt.query_map([], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
            }).unwrap().map(|r| r.unwrap()).collect()
        };
        assert_eq!(rows.len(), 2, "two segments from t1, none from NULL t2");
        assert_eq!(
            rows[0],
            ("t1".into(), 0, Some("A".into()), Some(0), "intro chatter".into())
        );
        assert_eq!(
            rows[1],
            ("t1".into(), 1, Some("B".into()), Some(61500),
             "the quarterly budget was approved".into())
        );

        // Backfilled rows are searchable through the new per-segment FTS…
        let hits: i64 = conn.query_row(
            "SELECT count(*) FROM segments_fts WHERE segments_fts MATCH '\"quarterly\" \"budget\"'",
            [], |r| r.get(0),
        ).unwrap();
        assert_eq!(hits, 1);

        // …and the old transcript-level FTS table and its triggers are gone.
        let old: i64 = conn.query_row(
            "SELECT count(*) FROM sqlite_master
             WHERE name IN ('transcripts_fts','transcripts_ai','transcripts_ad','transcripts_au')",
            [], |r| r.get(0),
        ).unwrap();
        assert_eq!(old, 0);
    }

    #[test]
    fn segments_replace_on_update_and_cascade_on_delete() {
        let db = crate::db::Database::new_in_memory().unwrap();
        let m = db.create_meeting("M").unwrap();
        let t = db.create_transcript(&m.id, "local").unwrap();
        db.update_transcript_segments(
            &t.id,
            r#"[{"text":"alpha","start_ms":0,"end_ms":1,"speaker":"A"},
                {"text":"beta","start_ms":2,"end_ms":3,"speaker":"B"}]"#,
        ).unwrap();

        let seg_count = |db: &crate::db::Database| -> i64 {
            let conn = db.conn.lock().unwrap();
            conn.query_row("SELECT count(*) FROM transcript_segments", [], |r| r.get(0))
                .unwrap()
        };
        assert_eq!(seg_count(&db), 2);

        // Re-writing segments replaces rows rather than appending.
        db.update_transcript_segments(
            &t.id,
            r#"[{"text":"gamma","start_ms":0,"end_ms":1,"speaker":"A"}]"#,
        ).unwrap();
        assert_eq!(seg_count(&db), 1);
        {
            let conn = db.conn.lock().unwrap();
            let text: String = conn
                .query_row("SELECT text FROM transcript_segments", [], |r| r.get(0))
                .unwrap();
            assert_eq!(text, "gamma");
        }

        // Hard-deleting the meeting cascades meetings → transcripts →
        // transcript_segments, and the delete trigger scrubs the FTS index
        // (verified via a MATCH that would otherwise ghost-hit).
        db.delete_meeting(&m.id).unwrap();
        assert_eq!(seg_count(&db), 0);
        let conn = db.conn.lock().unwrap();
        let ghosts: i64 = conn
            .query_row(
                "SELECT count(*) FROM segments_fts WHERE segments_fts MATCH 'gamma'",
                [], |r| r.get(0),
            )
            .unwrap();
        assert_eq!(ghosts, 0, "FTS must not retain entries for deleted segments");
    }
}
