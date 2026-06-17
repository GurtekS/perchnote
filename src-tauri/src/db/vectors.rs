//! Segment-embedding store for hybrid semantic recall (plan v2 rank 10).
//!
//! A `vec0` virtual table (sqlite-vec) holds one embedding per transcript
//! segment. The table is created lazily at first embed because its dimension
//! is fixed at creation time and depends on the configured embedding model;
//! `(model, dims)` are recorded in settings and a mismatch drops + recreates
//! the index (vectors from different models aren't comparable anyway).
//!
//! Everything here degrades: no embedder configured → no table → callers get
//! empty results and fall back to FTS-only search, which is today's behavior.

use anyhow::{anyhow, Result};
use rusqlite::params;

use super::Database;

/// Register sqlite-vec on every connection opened after this call. Must run
/// before `Connection::open`; calling it more than once is harmless (SQLite
/// dedupes auto-extensions).
pub fn register_vec_extension() {
    type EntryPoint = unsafe extern "C" fn(
        *mut rusqlite::ffi::sqlite3,
        *mut *const std::os::raw::c_char,
        *const rusqlite::ffi::sqlite3_api_routines,
    ) -> std::os::raw::c_int;
    unsafe {
        rusqlite::ffi::sqlite3_auto_extension(Some(std::mem::transmute::<*const (), EntryPoint>(
            sqlite_vec::sqlite3_vec_init as *const (),
        )));
    }
}

/// f32 slice → little-endian BLOB, the binding format vec0 expects.
fn embedding_blob(v: &[f32]) -> Vec<u8> {
    v.iter().flat_map(|f| f.to_le_bytes()).collect()
}

/// One KNN hit, already joined back to its source meeting.
#[derive(Debug, Clone)]
pub struct VecHit {
    /// "{transcript_id}:{seg_idx}" as written by ai::embeddings — lets
    /// segment-level consumers (chat retrieval, plan v8 A5) fuse vec hits
    /// with FTS hits and expand neighbors.
    pub segment_id: String,
    pub meeting_id: String,
    pub content: String,
    pub distance: f64,
    /// Start of the matched segment in the recording (plan v8 A4) — lets
    /// semantic hits jump to the moment like FTS hits do. None when the
    /// segment_id no longer resolves (orphaned vector, out-of-range index).
    pub start_ms: Option<u64>,
}

/// segment_id is "{transcript_id}:{seg_idx}" (written by ai::embeddings).
/// Rsplit because the index is the only colon we control the right side of.
pub(crate) fn parse_segment_id(segment_id: &str) -> Option<(String, usize)> {
    let (tid, idx) = segment_id.rsplit_once(':')?;
    Some((tid.to_string(), idx.parse().ok()?))
}

/// start_ms for each requested segment of ONE transcript, in one query.
/// Chosen over deserializing `segments` in Rust: json_extract walks the
/// JSON inside SQLite (the JSON parse cache makes repeated extracts on the
/// same row cheap), so an hour-long transcript's JSON never crosses the
/// FFI boundary just to read k ≤ 8 integers. Missing transcript row,
/// out-of-range index, or a non-numeric value all degrade to None.
fn segment_starts(
    conn: &rusqlite::Connection,
    transcript_id: &str,
    seg_idxs: &[usize],
) -> Vec<Option<u64>> {
    let cols: Vec<String> = seg_idxs
        .iter()
        .map(|i| format!("json_extract(segments, '$[{i}].start_ms')"))
        .collect();
    let sql = format!("SELECT {} FROM transcripts WHERE id = ?1", cols.join(", "));
    let row = conn.query_row(&sql, params![transcript_id], |r| {
        (0..seg_idxs.len())
            .map(|c| r.get::<_, rusqlite::types::Value>(c))
            .collect::<rusqlite::Result<Vec<_>>>()
    });
    match row {
        Ok(vals) => vals
            .into_iter()
            .map(|v| match v {
                rusqlite::types::Value::Integer(i) if i >= 0 => Some(i as u64),
                rusqlite::types::Value::Real(f) if f.is_finite() && f >= 0.0 => Some(f as u64),
                _ => None,
            })
            .collect(),
        Err(_) => vec![None; seg_idxs.len()],
    }
}

impl Database {
    /// True when the vector index exists (i.e. an embedder has run at least
    /// once). Cheap probe used to decide whether semantic recall is on.
    pub fn vec_index_ready(&self) -> bool {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='vec_segments'",
            [],
            |_| Ok(()),
        )
        .is_ok()
    }

    /// Ensure the vec0 table exists for `model` at `dims`. A model or dims
    /// change drops the index — embeddings from different models must never
    /// be mixed — and the caller re-indexes over time.
    pub fn ensure_vec_index(&self, model: &str, dims: usize) -> Result<()> {
        if dims == 0 || dims > 8192 {
            return Err(anyhow!("implausible embedding dims: {dims}"));
        }
        let stored_model = self.get_setting("embedding_index_model")?.unwrap_or_default();
        let stored_dims: usize = self
            .get_setting("embedding_index_dims")?
            .and_then(|s| s.parse().ok())
            .unwrap_or(0);
        let exists = self.vec_index_ready();
        if exists && stored_model == model && stored_dims == dims {
            return Ok(());
        }
        {
            let conn = self.conn.lock().unwrap();
            if exists {
                log::info!(
                    "vec index: model/dims changed ({stored_model}/{stored_dims} -> {model}/{dims}); rebuilding"
                );
                conn.execute("DROP TABLE vec_segments", [])?;
            }
            // dims is validated numeric above; vec0 DDL can't take a bound param.
            conn.execute(
                &format!(
                    "CREATE VIRTUAL TABLE vec_segments USING vec0(
                        segment_id TEXT PRIMARY KEY,
                        embedding  FLOAT[{dims}] distance_metric=cosine,
                        meeting_id TEXT,
                        +content   TEXT
                    )"
                ),
                [],
            )?;
        }
        self.set_setting("embedding_index_model", model)?;
        self.set_setting("embedding_index_dims", &dims.to_string())?;
        Ok(())
    }

    /// Upsert a batch of segment embeddings. vec0 (0.1.9) has no
    /// INSERT OR REPLACE, so this is DELETE + INSERT inside one transaction.
    /// `items`: (segment_id, meeting_id, content, embedding).
    pub fn upsert_segment_vectors(
        &self,
        items: &[(String, String, String, Vec<f32>)],
    ) -> Result<usize> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        for (seg_id, meeting_id, content, emb) in items {
            tx.execute("DELETE FROM vec_segments WHERE segment_id = ?1", params![seg_id])?;
            tx.execute(
                "INSERT INTO vec_segments(segment_id, embedding, meeting_id, content)
                 VALUES (?1, ?2, ?3, ?4)",
                params![seg_id, embedding_blob(emb), meeting_id, content],
            )?;
        }
        tx.commit()?;
        Ok(items.len())
    }

    /// Remove every vector for one meeting. vec0 virtual tables get no FK
    /// cascade, so `delete_meeting` calls this explicitly — otherwise the
    /// deleted meeting's transcript text (stored verbatim in `content`)
    /// keeps surfacing in semantic search after the meeting is gone.
    pub fn purge_meeting_vectors(&self, meeting_id: &str) -> Result<usize> {
        if !self.vec_index_ready() {
            return Ok(0);
        }
        let conn = self.conn.lock().unwrap();
        let n = conn.execute(
            "DELETE FROM vec_segments WHERE meeting_id = ?1",
            params![meeting_id],
        )?;
        Ok(n)
    }

    /// Sweep vectors whose meeting no longer exists (deletions from before
    /// purge_meeting_vectors existed, or interrupted deletes). Mirrors the
    /// WAV orphan sweep; runs at startup.
    pub fn prune_orphaned_vectors(&self) -> Result<usize> {
        if !self.vec_index_ready() {
            return Ok(0);
        }
        let conn = self.conn.lock().unwrap();
        let n = conn.execute(
            "DELETE FROM vec_segments
             WHERE meeting_id NOT IN (SELECT id FROM meetings)",
            [],
        )?;
        Ok(n)
    }

    /// Meeting ids that already have at least one vector — lets the indexer
    /// skip work it has done.
    pub fn vec_indexed_meeting_ids(&self) -> Result<std::collections::HashSet<String>> {
        if !self.vec_index_ready() {
            return Ok(Default::default());
        }
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT DISTINCT meeting_id FROM vec_segments")?;
        let ids = stmt
            .query_map([], |r| r.get::<_, String>(0))?
            .filter_map(|r| r.ok())
            .collect();
        Ok(ids)
    }

    /// K-nearest segments to `query_emb`, best first. Empty when the index
    /// doesn't exist — the degrade-to-FTS path.
    pub fn knn_segments(&self, query_emb: &[f32], k: usize) -> Result<Vec<VecHit>> {
        if !self.vec_index_ready() {
            return Ok(Vec::new());
        }
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT segment_id, meeting_id, content, distance
             FROM vec_segments
             WHERE embedding MATCH ?1 AND k = ?2
             ORDER BY distance",
        )?;
        let mut hits: Vec<(VecHit, Option<(String, usize)>)> = stmt
            .query_map(params![embedding_blob(query_emb), k as i64], |r| {
                let segment_id: String = r.get(0)?;
                let parsed = parse_segment_id(&segment_id);
                Ok((
                    VecHit {
                        segment_id,
                        meeting_id: r.get(1)?,
                        content: r.get(2)?,
                        distance: r.get(3)?,
                        start_ms: None,
                    },
                    parsed,
                ))
            })?
            .filter_map(|r| r.ok())
            .collect();

        // Resolve start_ms in one query per DISTINCT transcript (k is small,
        // so this is a handful of point lookups at most). See segment_starts
        // for why resolution happens in SQL rather than Rust.
        let mut by_transcript: std::collections::HashMap<String, Vec<(usize, usize)>> =
            Default::default();
        for (pos, (_, parsed)) in hits.iter().enumerate() {
            if let Some((tid, seg_idx)) = parsed {
                by_transcript.entry(tid.clone()).or_default().push((pos, *seg_idx));
            }
        }
        for (tid, entries) in by_transcript {
            let idxs: Vec<usize> = entries.iter().map(|(_, i)| *i).collect();
            for ((pos, _), start) in entries.iter().zip(segment_starts(&conn, &tid, &idxs)) {
                hits[*pos].0.start_ms = start;
            }
        }
        Ok(hits.into_iter().map(|(h, _)| h).collect())
    }
}

/// Reciprocal Rank Fusion over per-meeting rank lists (k=60, the standard
/// constant). Each input is best-rank-per-meeting, rank starting at 1;
/// a meeting missing from a list contributes nothing for that list.
pub fn rrf_fuse(
    fts_ranked: &[String],
    vec_ranked: &[String],
) -> Vec<(String, f64)> {
    const RRF_K: f64 = 60.0;
    let mut scores: std::collections::HashMap<String, f64> = Default::default();
    for (rank, id) in fts_ranked.iter().enumerate() {
        *scores.entry(id.clone()).or_default() += 1.0 / (RRF_K + rank as f64 + 1.0);
    }
    for (rank, id) in vec_ranked.iter().enumerate() {
        *scores.entry(id.clone()).or_default() += 1.0 / (RRF_K + rank as f64 + 1.0);
    }
    let mut out: Vec<(String, f64)> = scores.into_iter().collect();
    out.sort_by(|a, b| b.1.total_cmp(&a.1).then(a.0.cmp(&b.0)));
    out
}

// --- Recency-aware fusion (plan v10 #7) ---

/// Half-life of the recency decay applied to fused scores, in days. A
/// meeting ~2.5 months old carries half the weight of one from today.
pub const RECENCY_HALF_LIFE_DAYS: f64 = 75.0;

/// Lower bound of the decay multiplier. History never decays to zero — an
/// old exact match keeps a quarter of its fused score, so it still beats
/// any fresh result scoring under a quarter of it. Reached at exactly two
/// half-lives (0.5² = 0.25), i.e. ~5 months; everything older is flat.
pub const RECENCY_WEIGHT_FLOOR: f64 = 0.25;

/// Stored meeting timestamps are RFC3339 (`queries::now`), but calendar
/// imports can carry bare dates or other ISO shapes — fall back to the
/// YYYY-MM-DD prefix at midnight UTC; day resolution is plenty against a
/// 75-day half-life. None = unparseable.
fn parse_meeting_ts(s: &str) -> Option<chrono::DateTime<chrono::Utc>> {
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(s) {
        return Some(dt.with_timezone(&chrono::Utc));
    }
    let date: chrono::NaiveDate = s.get(0..10)?.parse().ok()?;
    Some(chrono::DateTime::from_naive_utc_and_offset(
        date.and_hms_opt(0, 0, 0)?,
        chrono::Utc,
    ))
}

/// Multiplicative recency weight for a meeting dated `date` as of `now`:
/// 0.5^(age / half-life), floored at RECENCY_WEIGHT_FLOOR.
///
/// Deliberately NOT the plan's literal "third RRF arm": a rank-based date
/// arm pays every meeting in the corpus ~1/(k+rank) regardless of relevance
/// — at k=60 a fresh non-match would out-earn a top FTS hit — and a
/// meeting's payout would depend on how many OTHER candidates are newer,
/// not on its own age. A multiplicative decay on the fused score depends on
/// age alone, preserves relevance order among same-day meetings exactly,
/// and makes "decay off" a literal ×1.0 no-op.
///
/// Missing/unparseable dates and future dates don't decay (weight 1.0):
/// decay is a tiebreaker, never a gate. `now` is passed in so callers
/// resolve it once at the command layer and this stays deterministic.
pub fn recency_weight(date: Option<&str>, now: chrono::DateTime<chrono::Utc>) -> f64 {
    let Some(ts) = date.and_then(parse_meeting_ts) else {
        return 1.0;
    };
    let age_days = (now - ts).num_milliseconds() as f64 / 86_400_000.0;
    if age_days <= 0.0 {
        return 1.0;
    }
    (0.5f64)
        .powf(age_days / RECENCY_HALF_LIFE_DAYS)
        .max(RECENCY_WEIGHT_FLOOR)
}

/// Scale every fused score by `weight(id)` and re-sort with `rrf_fuse`'s
/// exact comparator. A weight that is constantly 1.0 returns the input
/// bit-for-bit (×1.0 is exact in IEEE 754 and the comparator is a total
/// order over already-sorted keys) — the decay-off gate.
pub fn rerank_with_weights(
    mut fused: Vec<(String, f64)>,
    weight: impl Fn(&str) -> f64,
) -> Vec<(String, f64)> {
    for (id, score) in fused.iter_mut() {
        *score *= weight(id);
    }
    fused.sort_by(|a, b| b.1.total_cmp(&a.1).then(a.0.cmp(&b.0)));
    fused
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unit(mut v: Vec<f32>) -> Vec<f32> {
        let n = v.iter().map(|x| x * x).sum::<f32>().sqrt();
        if n > 0.0 {
            v.iter_mut().for_each(|x| *x /= n);
        }
        v
    }

    #[test]
    fn vec_extension_loads_and_reports_version() {
        register_vec_extension();
        let db = Database::new_in_memory().unwrap();
        let conn = db.conn.lock().unwrap();
        let v: String = conn
            .query_row("SELECT vec_version()", [], |r| r.get(0))
            .unwrap();
        assert!(v.starts_with('v'), "unexpected vec_version: {v}");
    }

    #[test]
    fn delete_meeting_purges_its_semantic_index_rows() {
        register_vec_extension();
        let db = Database::new_in_memory().unwrap();
        db.ensure_vec_index("test-model", 4).unwrap();

        let kept = db.create_meeting("Kept").unwrap();
        let doomed = db.create_meeting("Doomed").unwrap();
        db.upsert_segment_vectors(&[
            ("k:0".into(), kept.id.clone(), "kept content".into(), unit(vec![1.0, 0.0, 0.0, 0.0])),
            ("d:0".into(), doomed.id.clone(), "secret content".into(), unit(vec![0.0, 1.0, 0.0, 0.0])),
            ("d:1".into(), doomed.id.clone(), "more secrets".into(), unit(vec![0.0, 0.9, 0.1, 0.0])),
        ])
        .unwrap();

        db.delete_meeting(&doomed.id).unwrap();

        // The deleted meeting's transcript text must be gone from semantic
        // search — a query aimed straight at it finds only the survivor.
        let hits = db.knn_segments(&unit(vec![0.0, 1.0, 0.0, 0.0]), 5).unwrap();
        assert!(!hits.is_empty());
        assert!(
            hits.iter().all(|h| h.meeting_id == kept.id),
            "deleted meeting still surfaced: {hits:?}"
        );
    }

    #[test]
    fn prune_removes_rows_for_meetings_that_no_longer_exist() {
        register_vec_extension();
        let db = Database::new_in_memory().unwrap();
        db.ensure_vec_index("test-model", 4).unwrap();

        let live = db.create_meeting("Live").unwrap();
        // Simulate the pre-fix world: vectors for a meeting id with no row.
        db.upsert_segment_vectors(&[
            ("l:0".into(), live.id.clone(), "live".into(), unit(vec![1.0, 0.0, 0.0, 0.0])),
            ("g:0".into(), "ghost-meeting".into(), "ghost".into(), unit(vec![0.0, 1.0, 0.0, 0.0])),
        ])
        .unwrap();

        assert_eq!(db.prune_orphaned_vectors().unwrap(), 1);
        let hits = db.knn_segments(&unit(vec![0.0, 1.0, 0.0, 0.0]), 5).unwrap();
        assert!(hits.iter().all(|h| h.meeting_id == live.id));
        // Idempotent.
        assert_eq!(db.prune_orphaned_vectors().unwrap(), 0);
    }

    #[test]
    fn purge_and_prune_are_noops_without_an_index() {
        let db = Database::new_in_memory().unwrap();
        assert_eq!(db.purge_meeting_vectors("anything").unwrap(), 0);
        assert_eq!(db.prune_orphaned_vectors().unwrap(), 0);
    }

    #[test]
    fn knn_finds_semantic_neighbor_that_fts_cannot() {
        register_vec_extension();
        let db = Database::new_in_memory().unwrap();
        db.ensure_vec_index("test-model", 4).unwrap();

        // Three segments with handcrafted embeddings. The "paraphrase" axis:
        // seg-b's vector is near the query vector but shares no words with
        // the query — exactly what FTS misses and KNN catches.
        db.upsert_segment_vectors(&[
            ("t1:0".into(), "m-alpha".into(), "we talked about hiring plans".into(),
             unit(vec![1.0, 0.0, 0.0, 0.0])),
            ("t2:0".into(), "m-beta".into(), "the quarterly budget was approved".into(),
             unit(vec![0.0, 1.0, 0.05, 0.0])),
            ("t3:0".into(), "m-gamma".into(), "lunch options near the office".into(),
             unit(vec![0.0, 0.0, 0.0, 1.0])),
        ])
        .unwrap();

        // Query: "how much money can we spend" — semantically the budget
        // segment, lexically disjoint from it.
        let query = unit(vec![0.0, 0.97, 0.1, 0.0]);
        let hits = db.knn_segments(&query, 2).unwrap();
        assert_eq!(hits[0].meeting_id, "m-beta");
        assert!(hits[0].distance < 0.05, "cosine distance was {}", hits[0].distance);

        // FTS on the same query finds nothing (no shared terms).
        let fts = db.search_all("money spend", 8).unwrap();
        assert!(fts.is_empty());
    }

    #[test]
    fn knn_hits_carry_the_segment_start_for_jump_to_moment() {
        register_vec_extension();
        let db = Database::new_in_memory().unwrap();
        db.ensure_vec_index("test-model", 4).unwrap();

        // A real transcript row: segment_id "{transcript_id}:{seg_idx}" must
        // resolve through transcripts.segments JSON to that segment's start.
        let m = db.create_meeting("Budget sync").unwrap();
        let t = db.create_transcript(&m.id, "test").unwrap();
        db.update_transcript_segments(
            &t.id,
            r#"[{"text":"intro chatter","start_ms":0,"end_ms":4000},
                {"text":"the quarterly budget was approved","start_ms":61500,"end_ms":70000},
                {"text":"closing remarks","start_ms":300000,"end_ms":310000}]"#,
        )
        .unwrap();

        db.upsert_segment_vectors(&[
            (format!("{}:1", t.id), m.id.clone(),
             "the quarterly budget was approved".into(), unit(vec![0.0, 1.0, 0.05, 0.0])),
            (format!("{}:2", t.id), m.id.clone(),
             "closing remarks".into(), unit(vec![1.0, 0.0, 0.0, 0.0])),
            // Index beyond the segments array → json_extract NULL → None.
            (format!("{}:99", t.id), m.id.clone(),
             "stale index".into(), unit(vec![0.0, 0.0, 1.0, 0.0])),
            // Transcript row gone (or pre-format id) → None, hit still returned.
            ("ghost-transcript:0".into(), m.id.clone(),
             "orphan".into(), unit(vec![0.0, 0.0, 0.0, 1.0])),
        ])
        .unwrap();

        let hits = db.knn_segments(&unit(vec![0.0, 0.97, 0.1, 0.0]), 4).unwrap();
        assert_eq!(hits.len(), 4);
        assert_eq!(hits[0].content, "the quarterly budget was approved");
        assert_eq!(hits[0].start_ms, Some(61_500));

        let by_content = |c: &str| hits.iter().find(|h| h.content == c).unwrap();
        assert_eq!(by_content("closing remarks").start_ms, Some(300_000));
        assert_eq!(by_content("stale index").start_ms, None);
        assert_eq!(by_content("orphan").start_ms, None);
    }

    #[test]
    fn model_change_rebuilds_the_index() {
        register_vec_extension();
        let db = Database::new_in_memory().unwrap();
        db.ensure_vec_index("model-a", 4).unwrap();
        db.upsert_segment_vectors(&[(
            "t1:0".into(),
            "m1".into(),
            "hello".into(),
            unit(vec![1.0, 0.0, 0.0, 0.0]),
        )])
        .unwrap();
        assert_eq!(db.knn_segments(&unit(vec![1.0, 0.0, 0.0, 0.0]), 1).unwrap().len(), 1);

        // Same model+dims: no-op, data survives.
        db.ensure_vec_index("model-a", 4).unwrap();
        assert_eq!(db.knn_segments(&unit(vec![1.0, 0.0, 0.0, 0.0]), 1).unwrap().len(), 1);

        // New dims: rebuilt empty.
        db.ensure_vec_index("model-b", 8).unwrap();
        assert!(db.knn_segments(&unit(vec![1.0; 8]), 1).unwrap().is_empty());
    }

    #[test]
    fn missing_index_degrades_to_empty_results() {
        register_vec_extension();
        let db = Database::new_in_memory().unwrap();
        assert!(!db.vec_index_ready());
        assert!(db.knn_segments(&[0.0; 4], 5).unwrap().is_empty());
    }

    #[test]
    fn rrf_rewards_presence_in_both_lists() {
        let fused = rrf_fuse(
            &["m1".into(), "m2".into(), "m3".into()],
            &["m2".into(), "m4".into()],
        );
        // m2: 1/62 + 1/61 beats m1's 1/61 alone.
        assert_eq!(fused[0].0, "m2");
        assert!(fused.iter().any(|(id, _)| id == "m4"));
    }

    // --- Recency-aware fusion (plan v10 #7) ---

    fn fixed_now() -> chrono::DateTime<chrono::Utc> {
        chrono::DateTime::parse_from_rfc3339("2026-06-09T00:00:00Z")
            .unwrap()
            .with_timezone(&chrono::Utc)
    }

    #[test]
    fn recency_weight_follows_the_half_life_and_floors() {
        let now = fixed_now();
        let at = |days: i64| (now - chrono::Duration::days(days)).to_rfc3339();
        let w = |d: String| recency_weight(Some(&d), now);
        assert_eq!(w(at(0)), 1.0, "today decays nothing");
        assert!((w(at(75)) - 0.5).abs() < 1e-12, "one half-life = ×0.5");
        assert!((w(at(150)) - 0.25).abs() < 1e-12, "two half-lives = the floor");
        assert_eq!(w(at(3_650)), RECENCY_WEIGHT_FLOOR, "ten years still floors, never zero");
        assert_eq!(w(at(-7)), 1.0, "future dates never boost past 1");
        // Strictly monotone between today and the floor.
        assert!(w(at(10)) > w(at(30)) && w(at(30)) > w(at(74)));
    }

    #[test]
    fn missing_or_malformed_dates_do_not_decay() {
        let now = fixed_now();
        assert_eq!(recency_weight(None, now), 1.0);
        for bad in ["", "not a date", "2026-13-45T00:00:00Z", "garbage-zz"] {
            assert_eq!(recency_weight(Some(bad), now), 1.0, "{bad:?} must not decay");
        }
        // Bare ISO dates (calendar imports) DO parse, at day resolution.
        let bare = recency_weight(Some("2026-03-01"), now);
        assert!(
            bare < 1.0 && bare > RECENCY_WEIGHT_FLOOR,
            "100-day-old bare date should sit on the curve, got {bare}"
        );
    }

    #[test]
    fn unit_weights_rerank_is_the_identity_and_decay_reorders() {
        let fused = rrf_fuse(
            &["m1".into(), "m2".into()],
            &["m2".into(), "m3".into()],
        );
        // GATE: weight ≡ 1.0 reproduces the input bit for bit.
        assert_eq!(rerank_with_weights(fused.clone(), |_| 1.0), fused);
        // Decaying the both-arms winner (m2) drops it below both
        // single-arm meetings; relative order of the others is untouched.
        let reranked = rerank_with_weights(fused, |id| if id == "m2" { 0.25 } else { 1.0 });
        let ids: Vec<&str> = reranked.iter().map(|(id, _)| id.as_str()).collect();
        assert_eq!(ids, vec!["m1", "m3", "m2"]);
    }
}
