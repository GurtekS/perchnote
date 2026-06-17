pub mod migrations;
pub mod queries;
pub(crate) mod searchgrammar;
pub mod seed;
pub mod vectors;

use anyhow::Result;
use rusqlite::{Connection, OpenFlags};
use std::path::PathBuf;
use std::sync::Mutex;

/// Schema health information returned by `check_database_health`
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct DatabaseHealth {
    pub schema_version: usize,
    pub tables: Vec<String>,
    pub missing_tables: Vec<String>,
    pub healthy: bool,
}

pub struct Database {
    pub conn: Mutex<Connection>,
}

/// The complete list of tables expected after all migrations have run.
/// Number of `M::up(...)` entries in `migrations.rs`. Bump when adding a
/// migration — the schema-guard test fails if this drifts. Also gates the
/// pre-migration safety backup in `Database::new` AND the perchnote-mcp
/// read-only guard (`open_read_only` refuses any other version — so an MCP
/// binary built at 18 will refuse a 17-schema DB until the app migrates it;
/// that's by design).
pub(crate) const EXPECTED_MIGRATION_COUNT: usize = 19;

const EXPECTED_TABLES: &[&str] = &[
    "meetings",
    "notes",
    "transcripts",
    "chat_messages",
    "templates",
    "folders",
    "meeting_folders",
    "tags",
    "meeting_tags",
    "settings",
    "speaker_labels",
    "meeting_links",
    "voice_profiles",
    "attachments",
    "mention_candidates",
    "prep_briefs",
    "meeting_stats",
    "reminder_links",
    "task_overlays",
    "insights_cache",
    "transcript_segments",
];

impl Database {
    pub fn new(app_data_dir: PathBuf) -> Result<Self> {
        // Must precede Connection::open; harmless when called repeatedly.
        vectors::register_vec_extension();
        std::fs::create_dir_all(&app_data_dir)?;
        let db_path = app_data_dir.join("perchnote.db");

        // A pre-open file copy only matters when migrations are about to
        // rewrite the file — that snapshot is the rollback if one goes
        // wrong. The routine daily backup moved off the startup path
        // (plan v7 #19): it's a background VACUUM INTO (compacted, WAL
        // folded in) instead of a multi-second copy stall on big files.
        if migration_pending(&db_path) {
            backup_database(&app_data_dir, &db_path);
        }

        let mut conn = Connection::open(&db_path)?;

        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;

        // Catch corruption here, where lib.rs can recover (move the file
        // aside, start fresh), instead of panicking later in a random query.
        let check: String = conn.pragma_query_value(None, "quick_check", |row| row.get(0))?;
        if check != "ok" {
            anyhow::bail!("database integrity check failed: {}", check);
        }

        let migrations = migrations::migrations();
        migrations.to_latest(&mut conn)?;

        // Cheap planner-statistics refresh (SQLite-recommended on open).
        let _ = conn.execute_batch("PRAGMA optimize;");

        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    /// Open an existing database strictly read-only — the `perchnote-mcp`
    /// entry point. Never creates the file, never migrates, never backs up:
    /// a sidecar process must not mutate the app's database, and SQLite
    /// enforces it at the connection level (any write errors out). The vec
    /// extension is still registered so connections behave identically to
    /// the app's (harmless: registration is process-global and additive).
    ///
    /// Refuses to open when the on-disk `user_version` differs from this
    /// build's migration count in either direction — half-reading an older
    /// or newer schema is worse than a clear error. WAL means reads here
    /// are safe while the app is running and writing.
    pub fn open_read_only(db_path: &std::path::Path) -> Result<Self> {
        vectors::register_vec_extension();
        if !db_path.exists() {
            anyhow::bail!(
                "database not found at {} (has the Perchnote app run at least once?)",
                db_path.display()
            );
        }
        let conn = Connection::open_with_flags(
            db_path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        let version: u32 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
        if version as usize != EXPECTED_MIGRATION_COUNT {
            anyhow::bail!(
                "schema version mismatch: database is at migration {version}, this binary expects \
                 {EXPECTED_MIGRATION_COUNT}. Read-only mode never migrates — open the Perchnote app \
                 once to migrate, or use a perchnote-mcp built from the same version as the app."
            );
        }
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    /// Daily background backup: a compacted point-in-time snapshot via
    /// VACUUM INTO, at most one per day, keeping the 3 newest. Returns
    /// true when a backup was written. Also refreshes PRAGMA optimize.
    pub fn run_daily_maintenance(&self, app_data_dir: &std::path::Path) -> bool {
        {
            let conn = self.conn.lock().unwrap();
            let _ = conn.execute_batch("PRAGMA optimize;");
        }
        let backups = app_data_dir.join("backups");
        if std::fs::create_dir_all(&backups).is_err() {
            return false;
        }
        if backup_exists_for_today(&backups) {
            return false;
        }
        let stamp = chrono::Utc::now().format("%Y%m%d-%H%M%S").to_string();
        let dest = backups.join(format!("perchnote-{stamp}.db"));
        match self.vacuum_into(&dest) {
            Ok(()) => {
                log::info!("db backup created (vacuumed): backups/perchnote-{stamp}.db");
                prune_backups(&backups, 3);
                true
            }
            Err(e) => {
                log::warn!("daily db backup failed: {e}");
                false
            }
        }
    }

    #[cfg(test)]
    pub fn new_in_memory() -> Result<Self> {
        vectors::register_vec_extension();
        let mut conn = Connection::open_in_memory()?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        let migrations = migrations::migrations();
        migrations.to_latest(&mut conn)?;
        Ok(Self { conn: Mutex::new(conn) })
    }

    /// Get the current schema migration version (number of applied migrations).
    pub fn get_schema_version(&self) -> Result<usize> {
        let conn = self.conn.lock().unwrap();
        let version: u32 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
        Ok(version as usize)
    }

    /// Validate that all expected tables exist in the database.
    /// Returns (existing_tables, missing_tables).
    pub fn validate_schema(&self) -> Result<(Vec<String>, Vec<String>)> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
        )?;
        let existing: Vec<String> = stmt
            .query_map([], |row| row.get::<_, String>(0))?
            .filter_map(|r| r.ok())
            .collect();

        let missing: Vec<String> = EXPECTED_TABLES
            .iter()
            .filter(|t| !existing.contains(&t.to_string()))
            .map(|t| t.to_string())
            .collect();

        Ok((existing, missing))
    }

    /// Write a clean point-in-time snapshot of the database to `dest` via
    /// `VACUUM INTO` — compacted, WAL fully folded in, safe to copy around.
    /// `dest` must not already exist (SQLite refuses to overwrite).
    pub fn vacuum_into(&self, dest: &std::path::Path) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("VACUUM INTO ?1", [dest.to_string_lossy()])?;
        Ok(())
    }

    /// Compact when a purge left ≥25% of pages on the freelist — freed
    /// pages otherwise never return to the OS and the storage meter reads
    /// them as used. Returns true when a VACUUM ran.
    pub fn vacuum_if_fragmented(&self) -> Result<bool> {
        let conn = self.conn.lock().unwrap();
        let freelist: u64 = conn.pragma_query_value(None, "freelist_count", |r| r.get(0))?;
        let pages: u64 = conn.pragma_query_value(None, "page_count", |r| r.get(0))?;
        if pages > 0 && freelist * 4 >= pages {
            conn.execute("VACUUM", [])?;
            return Ok(true);
        }
        Ok(false)
    }

    /// Full health check combining version and schema validation.
    pub fn check_health(&self) -> Result<DatabaseHealth> {
        let schema_version = self.get_schema_version()?;
        let (tables, missing_tables) = self.validate_schema()?;
        let healthy = missing_tables.is_empty();

        Ok(DatabaseHealth {
            schema_version,
            tables,
            missing_tables,
            healthy,
        })
    }
}

/// True when the on-disk schema version is behind the bundled migrations —
/// i.e. opening this file is about to rewrite it. Peeks via a short-lived
/// connection; a missing/unreadable file counts as "no" (nothing to save).
fn migration_pending(db_path: &std::path::Path) -> bool {
    if !db_path.exists() {
        return false;
    }
    let Ok(conn) = Connection::open(db_path) else { return true };
    let version: u32 = conn
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .unwrap_or(0);
    (version as usize) < EXPECTED_MIGRATION_COUNT
}

fn backup_exists_for_today(backups: &std::path::Path) -> bool {
    let day = chrono::Utc::now().format("%Y%m%d").to_string();
    std::fs::read_dir(backups)
        .map(|entries| {
            entries.flatten().any(|e| {
                e.file_name()
                    .to_string_lossy()
                    .starts_with(&format!("perchnote-{}", day))
            })
        })
        .unwrap_or(false)
}

fn prune_backups(backups: &std::path::Path, keep: usize) {
    if let Ok(entries) = std::fs::read_dir(backups) {
        let mut mains: Vec<_> = entries
            .flatten()
            .map(|e| e.path())
            .filter(|p| {
                p.extension().map(|x| x == "db").unwrap_or(false)
                    && p.file_name()
                        .map(|n| n.to_string_lossy().starts_with("perchnote-"))
                        .unwrap_or(false)
            })
            .collect();
        mains.sort();
        while mains.len() > keep {
            let old = mains.remove(0);
            for suffix in ["", "-wal", "-shm"] {
                let _ = std::fs::remove_file(std::path::PathBuf::from(format!(
                    "{}{}",
                    old.display(),
                    suffix
                )));
            }
        }
    }
}

/// Pre-migration safety copy of the database (plus -wal/-shm sidecars) into
/// `backups/`, at most once per day, keeping the 3 newest sets. Only runs
/// when a migration is about to rewrite the file; the routine daily backup
/// is `run_daily_maintenance` (background VACUUM INTO).
fn backup_database(app_data_dir: &std::path::Path, db_path: &std::path::Path) {
    if !db_path.exists() {
        return;
    }
    let backups = app_data_dir.join("backups");
    if std::fs::create_dir_all(&backups).is_err() {
        return;
    }
    if backup_exists_for_today(&backups) {
        return;
    }

    let stamp = chrono::Utc::now().format("%Y%m%d-%H%M%S").to_string();
    for suffix in ["", "-wal", "-shm"] {
        let src = std::path::PathBuf::from(format!("{}{}", db_path.display(), suffix));
        if !src.exists() {
            continue;
        }
        let dest = backups.join(format!("perchnote-{}.db{}", stamp, suffix));
        if let Err(e) = std::fs::copy(&src, &dest) {
            log::warn!("db backup of {} failed: {}", src.display(), e);
        }
    }
    log::info!("pre-migration db backup created: backups/perchnote-{}.db", stamp);
    prune_backups(&backups, 3);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Database {
        Database::new_in_memory().unwrap()
    }

    #[test]
    fn test_migrations_apply_cleanly() {
        // Should not panic — every defined migration runs without error.
        let _db = db();
    }

    #[test]
    fn test_schema_version_equals_migration_count() {
        let db = db();
        let version = db.get_schema_version().unwrap();
        assert_eq!(
            version, EXPECTED_MIGRATION_COUNT,
            "schema version should equal number of migrations — \
             did you add an M::up without bumping EXPECTED_MIGRATION_COUNT?"
        );
    }

    #[test]
    fn test_all_expected_tables_exist() {
        let db = db();
        let (existing, missing) = db.validate_schema().unwrap();
        assert!(
            missing.is_empty(),
            "Missing tables after migrations: {:?}",
            missing
        );
        assert!(existing.len() >= EXPECTED_TABLES.len());
    }

    #[test]
    fn test_health_check_is_healthy() {
        let db = db();
        let health = db.check_health().unwrap();
        assert!(health.healthy);
        assert!(health.missing_tables.is_empty());
        assert_eq!(health.schema_version, EXPECTED_MIGRATION_COUNT);
    }

    #[test]
    fn test_fts_table_created() {
        let db = db();
        let conn = db.conn.lock().unwrap();
        let count: i32 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='segments_fts'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 1, "segments_fts virtual table must exist");
        let old: i32 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='transcripts_fts'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(old, 0, "transcripts_fts must be dropped by migration 17");
    }

    #[test]
    fn test_foreign_keys_enabled() {
        let db = db();
        let conn = db.conn.lock().unwrap();
        let fk: i32 = conn
            .query_row("PRAGMA foreign_keys", [], |r| r.get(0))
            .unwrap();
        assert_eq!(fk, 1, "foreign keys must be enabled");
    }

    // --- open_read_only (perchnote-mcp entry point) ---

    #[test]
    fn test_open_read_only_reads_and_refuses_writes() {
        let dir = tempfile::tempdir().unwrap();
        {
            let rw = Database::new(dir.path().to_path_buf()).unwrap();
            rw.create_meeting("RO check").unwrap();
        }
        let ro = Database::open_read_only(&dir.path().join("perchnote.db")).unwrap();
        let list = ro.list_meetings().unwrap();
        assert_eq!(list.len(), 1, "read-only connection must see existing data");
        assert_eq!(list[0].title, "RO check");

        let err = ro.create_meeting("nope").expect_err("write must fail");
        let msg = format!("{err:#}").to_lowercase();
        assert!(
            msg.contains("readonly") || msg.contains("read-only") || msg.contains("read only"),
            "expected a readonly error, got: {msg}"
        );
    }

    #[test]
    fn test_open_read_only_refuses_wrong_schema_versions() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("perchnote.db");
        {
            Database::new(dir.path().to_path_buf()).unwrap();
        }
        for wrong in [1u32, (EXPECTED_MIGRATION_COUNT + 5) as u32] {
            {
                let conn = Connection::open(&path).unwrap();
                conn.pragma_update(None, "user_version", wrong).unwrap();
            }
            let err = Database::open_read_only(&path)
                .err()
                .expect("must refuse mismatched schema");
            assert!(
                err.to_string().contains("schema version mismatch"),
                "expected schema mismatch error for user_version={wrong}, got: {err}"
            );
        }
    }

    #[test]
    fn test_open_read_only_refuses_missing_file() {
        let dir = tempfile::tempdir().unwrap();
        let err = Database::open_read_only(&dir.path().join("perchnote.db"))
            .err()
            .expect("must not create a database");
        assert!(err.to_string().contains("not found"), "got: {err}");
        assert!(
            !dir.path().join("perchnote.db").exists(),
            "read-only open must never create the file"
        );
    }

    #[test]
    fn test_open_read_only_sees_concurrent_wal_writes() {
        // The app (rw, WAL) and perchnote-mcp (ro) hold the file at once;
        // each new read transaction must see the latest committed write.
        let dir = tempfile::tempdir().unwrap();
        let rw = Database::new(dir.path().to_path_buf()).unwrap();
        rw.create_meeting("Before attach").unwrap();

        let ro = Database::open_read_only(&dir.path().join("perchnote.db")).unwrap();
        assert_eq!(ro.list_meetings().unwrap().len(), 1);

        let live = rw.create_meeting("While attached").unwrap();
        let seen = ro.get_meeting(&live.id).unwrap();
        assert!(
            seen.is_some(),
            "read-only WAL reader must observe writes committed after it attached"
        );
    }
}
