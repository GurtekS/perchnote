pub mod migrations;
pub mod queries;
pub mod seed;

use anyhow::Result;
use rusqlite::Connection;
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
];

impl Database {
    pub fn new(app_data_dir: PathBuf) -> Result<Self> {
        std::fs::create_dir_all(&app_data_dir)?;
        let db_path = app_data_dir.join("perchnote.db");
        let mut conn = Connection::open(db_path)?;

        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;

        let migrations = migrations::migrations();
        migrations.to_latest(&mut conn)?;

        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    #[cfg(test)]
    pub fn new_in_memory() -> Result<Self> {
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

    /// Number of `M::up(...)` entries in `migrations.rs`. Bump this when
    /// you add a migration. (Stays in sync with `check_health`.)
    const EXPECTED_MIGRATION_COUNT: usize = 11;

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
                "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='transcripts_fts'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 1, "transcripts_fts virtual table must exist");
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
}
