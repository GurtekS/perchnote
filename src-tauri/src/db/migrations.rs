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
