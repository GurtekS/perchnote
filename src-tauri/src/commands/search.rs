use tauri::State;
use crate::db::Database;
use crate::db::queries::SearchResult;
use crate::db::vectors::VecHit;

#[tauri::command]
pub fn search_transcripts(
    db: State<'_, Database>,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<String>, String> {
    db.search_transcripts(&query, limit.unwrap_or(5)).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn search_all(
    db: State<'_, Database>,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<SearchResult>, String> {
    db.search_all(&query, limit.unwrap_or(20)).map_err(|e| e.to_string())
}

#[derive(serde::Serialize)]
pub struct SemanticHit {
    pub meeting_id: String,
    pub snippet: String,
    pub distance: f64,
    /// Start of the matched segment, so semantic hits can jump to the
    /// moment (plan v8 A4). None for orphaned/unresolvable vectors.
    pub start_ms: Option<u64>,
}

/// Nearest-meaning transcript segments (plan v2 rank 10). Hidden command —
/// no UI yet; returns [] whenever semantic recall is off, so callers can
/// always fall back to `search_all`.
#[tauri::command]
pub async fn semantic_search(
    app: tauri::AppHandle,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<SemanticHit>, String> {
    use tauri::Manager;
    let db = app.state::<Database>();
    let hits = crate::ai::embeddings::semantic_search(&db, &query, limit.unwrap_or(8))
        .await
        .map_err(|e| e.to_string())?;
    Ok(hits
        .into_iter()
        .map(|h| SemanticHit {
            meeting_id: h.meeting_id,
            snippet: h.content.chars().take(200).collect(),
            distance: h.distance,
            start_ms: h.start_ms,
        })
        .collect())
}

/// What semantic recall is running on right now — feeds the Settings → AI
/// "Semantic recall" control (plan v10 #4).
#[derive(serde::Serialize)]
pub struct EmbeddingStatus {
    /// Resolved backend: "apple" | "ollama" | "off".
    pub backend: String,
    /// The Ollama model when backend == "ollama".
    pub model: Option<String>,
    /// The persisted `embedding_backend` choice; "auto" when unset.
    pub setting: String,
    pub apple_available: bool,
    pub apple_assets_installed: bool,
}

/// Resolve and report the embedding backend. Resolving here is deliberate:
/// when auto-detect lands on Apple-without-assets it kicks off the
/// background asset download, so opening Settings nudges first-use setup.
#[tauri::command]
pub async fn embedding_status(app: tauri::AppHandle) -> Result<EmbeddingStatus, String> {
    use crate::ai::embeddings::{self, EmbeddingBackend};
    use tauri::Manager;
    let db = app.state::<Database>();
    let avail = crate::ai::apple_embed::availability();
    let setting = db
        .get_setting(embeddings::BACKEND_SETTING)
        .ok()
        .flatten()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "auto".to_string());
    let (backend, model) = match embeddings::resolve_backend(&db).await {
        Some(EmbeddingBackend::Apple) => ("apple".to_string(), None),
        Some(EmbeddingBackend::Ollama { model }) => ("ollama".to_string(), Some(model)),
        None => ("off".to_string(), None),
    };
    Ok(EmbeddingStatus {
        backend,
        model,
        setting,
        apple_available: avail.available,
        apple_assets_installed: avail.assets_installed,
    })
}

/// How many KNN hits the semantic arm contributes — the same k NotesList
/// passed to `semantic_search` back when it merged the two result sets
/// client-side (plan v9 #10 moved that merge here).
const SEMANTIC_K: usize = 8;

/// Synthesized "Related:" snippets match the keyword arms' width
/// (`extract_snippet`'s 80).
const SEMANTIC_SNIPPET_CHARS: usize = 80;

/// Modest multiplier for meetings whose keyword rows include a "title"
/// match (plan v10 #7) — typing words from a meeting's own title is
/// high-intent, so it wins close fusion calls without drowning content
/// matches. 1.15 lifts a title hit past the adjacent RRF rank
/// (1.15/62 > 1/61) but never past a meeting both arms agree on
/// (1/61 + 1/62 ≈ 2× a single-arm score).
const TITLE_BOOST: f64 = 1.15;

/// Fuse `search_all` rows with semantic KNN hits into ONE meeting-level
/// ranking via `rrf_fuse` — the server-side home of NotesList's old
/// client merge, consistent with chat ranking (which fuses the same way
/// at segment granularity; here the "Related:" row is per-meeting).
///
/// Semantics:
/// - Keyword rank list = order of each meeting's FIRST row in `keyword`
///   (search_all emits title rows, then bm25-best transcript rows, then
///   notes rows — first appearance is that meeting's best keyword showing).
/// - Semantic rank list = KNN order deduped to best-per-meeting
///   (`knn_segments` returns best-first, so the first hit wins).
/// - Every `keyword` row survives (the list needs per-arm rows), regrouped
///   by meeting in fused order; meetings ONLY the semantic arm found get
///   one synthesized `match_source: "semantic"` row whose snippet is the
///   hit content and whose `match_start_ms` keeps jump-to-moment working
///   (plan v8 A4).
/// - No semantic hits → `keyword` returned untouched, so with embeddings
///   off the output is byte-for-byte `search_all`'s.
/// - The fused score is then recency-decayed per meeting date and
///   title-boosted (plan v10 #7); `meeting_dates` holds each meeting's
///   COALESCE(actual_start, scheduled_start, created_at) and `now` is
///   resolved by the caller so this stays deterministic. Missing dates
///   don't decay, so an empty map = decay off = the pre-v10 ordering
///   modulo the title boost.
pub(crate) fn fuse_search_results(
    keyword: Vec<SearchResult>,
    semantic: &[VecHit],
    meeting_dates: &std::collections::HashMap<String, String>,
    now: chrono::DateTime<chrono::Utc>,
) -> Vec<SearchResult> {
    use std::collections::{hash_map::Entry, HashMap, HashSet};
    if semantic.is_empty() {
        return keyword;
    }

    let mut kw_ranked: Vec<String> = Vec::new();
    let mut titled: HashSet<String> = HashSet::new();
    let mut rows_by_meeting: HashMap<String, Vec<SearchResult>> = HashMap::new();
    for row in keyword {
        if row.match_source == "title" {
            titled.insert(row.meeting_id.clone());
        }
        match rows_by_meeting.entry(row.meeting_id.clone()) {
            Entry::Vacant(e) => {
                kw_ranked.push(row.meeting_id.clone());
                e.insert(vec![row]);
            }
            Entry::Occupied(mut e) => e.get_mut().push(row),
        }
    }

    let mut vec_ranked: Vec<String> = Vec::new();
    let mut best_hit: HashMap<&str, &VecHit> = HashMap::new();
    for hit in semantic {
        if let Entry::Vacant(e) = best_hit.entry(hit.meeting_id.as_str()) {
            e.insert(hit);
            vec_ranked.push(hit.meeting_id.clone());
        }
    }

    let fused = crate::db::vectors::rerank_with_weights(
        crate::db::vectors::rrf_fuse(&kw_ranked, &vec_ranked),
        |id| {
            let title = if titled.contains(id) { TITLE_BOOST } else { 1.0 };
            title
                * crate::db::vectors::recency_weight(
                    meeting_dates.get(id).map(String::as_str),
                    now,
                )
        },
    );
    let mut out: Vec<SearchResult> = Vec::new();
    for (meeting_id, _score) in fused {
        if let Some(rows) = rows_by_meeting.remove(&meeting_id) {
            out.extend(rows);
        } else if let Some(hit) = best_hit.get(meeting_id.as_str()) {
            out.push(SearchResult {
                meeting_id,
                match_source: "semantic".to_string(),
                snippet: hit.content.trim().chars().take(SEMANTIC_SNIPPET_CHARS).collect(),
                match_start_ms: hit.start_ms,
            });
        }
    }
    out
}

/// `search_all` + semantic recall fused into one ranking (plan v9 #10) —
/// what NotesList's "Related:" rows ride on. See `fuse_search_results`
/// for the exact semantics. The semantic arm stays optional everywhere:
/// embeddings off OR an embedder error degrades to exactly `search_all`,
/// the same as when the client ran the two queries independently.
/// CommandPalette deliberately stays on plain `search_all` (keyword-only
/// by design for now) — don't point it here without a plan item.
#[tauri::command]
pub async fn search_with_semantic(
    app: tauri::AppHandle,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<SearchResult>, String> {
    use tauri::Manager;
    let db = app.state::<Database>();
    let keyword = db
        .search_all(&query, limit.unwrap_or(20))
        .map_err(|e| e.to_string())?;
    let semantic = match crate::ai::embeddings::semantic_search(&db, &query, SEMANTIC_K).await {
        Ok(hits) => hits,
        Err(e) => {
            log::warn!("search_with_semantic: semantic arm failed, keyword-only: {e}");
            Vec::new()
        }
    };
    // The vector index keeps trashed meetings until hard delete (so restore
    // works), which meant their transcript text kept surfacing as
    // "semantic" rows after the user trashed them (whole-app review P2) —
    // the keyword arm filters deleted_at, the knn arm didn't. Drop hits
    // whose meeting isn't live before fusing.
    let semantic = if semantic.is_empty() {
        semantic
    } else {
        let mut ids: Vec<String> = semantic.iter().map(|h| h.meeting_id.clone()).collect();
        ids.sort();
        ids.dedup();
        let live = db.live_meeting_ids(&ids).map_err(|e| e.to_string())?;
        semantic
            .into_iter()
            .filter(|h| live.contains(&h.meeting_id))
            .collect()
    };
    // Meeting dates for both arms in one lookup (plan v10 #7) — skipped
    // when the semantic arm is empty because fusion early-returns the
    // keyword rows untouched anyway.
    let meeting_dates = if semantic.is_empty() {
        Default::default()
    } else {
        let mut ids: Vec<String> = keyword
            .iter()
            .map(|r| r.meeting_id.clone())
            .chain(semantic.iter().map(|h| h.meeting_id.clone()))
            .collect();
        ids.sort();
        ids.dedup();
        db.meeting_sort_dates(&ids).map_err(|e| e.to_string())?
    };
    Ok(fuse_search_results(keyword, &semantic, &meeting_dates, chrono::Utc::now()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kw(meeting_id: &str, source: &str, snippet: &str) -> SearchResult {
        SearchResult {
            meeting_id: meeting_id.into(),
            match_source: source.into(),
            snippet: snippet.into(),
            match_start_ms: None,
        }
    }

    fn hit(meeting_id: &str, content: &str, distance: f64, start_ms: Option<u64>) -> VecHit {
        VecHit {
            segment_id: format!("t-{meeting_id}:0"),
            meeting_id: meeting_id.into(),
            content: content.into(),
            distance,
            start_ms,
        }
    }

    fn rows(out: &[SearchResult]) -> Vec<(&str, &str)> {
        out.iter()
            .map(|r| (r.meeting_id.as_str(), r.match_source.as_str()))
            .collect()
    }

    /// Deterministic "now" for decay math — fusion never calls Utc::now().
    fn fixed_now() -> chrono::DateTime<chrono::Utc> {
        chrono::DateTime::parse_from_rfc3339("2026-06-09T12:00:00Z")
            .unwrap()
            .with_timezone(&chrono::Utc)
    }

    fn days_ago(days: i64) -> String {
        (fixed_now() - chrono::Duration::days(days)).to_rfc3339()
    }

    /// meeting_id → date, expressed as days before fixed_now (negative =
    /// future).
    fn dates(pairs: &[(&str, i64)]) -> std::collections::HashMap<String, String> {
        pairs
            .iter()
            .map(|(id, d)| (id.to_string(), days_ago(*d)))
            .collect()
    }

    /// No dates known → no decay anywhere (the title boost still applies —
    /// it is structural, not time-based).
    fn undated() -> std::collections::HashMap<String, String> {
        Default::default()
    }

    #[test]
    fn meeting_found_by_both_arms_outranks_single_source_and_rows_stay_grouped() {
        // search_all order: title rows first, then transcript rows — so m1's
        // two rows arrive split around m2's. Keyword first-appearance rank:
        // m1 then m2. Semantic rank: m2 then m4.
        let keyword = vec![
            kw("m1", "title", "Budget planning"),
            kw("m2", "title", "Spend review"),
            kw("m1", "transcript", "the budget looks tight"),
        ];
        let semantic = [
            hit("m2", "how much we can spend", 0.05, Some(1_000)),
            hit("m4", "allocating next quarter's money", 0.20, Some(2_000)),
        ];

        let out = fuse_search_results(keyword, &semantic, &undated(), fixed_now());

        // m2 (both arms: 1/62 + 1/61) above m1 (keyword only: 1/61) above
        // m4 (semantic only: 1/62); m1's rows regrouped adjacent, original
        // within-meeting order kept; m2 keeps its keyword row — no
        // synthesized duplicate just because semantic also found it.
        assert_eq!(
            rows(&out),
            vec![
                ("m2", "title"),
                ("m1", "title"),
                ("m1", "transcript"),
                ("m4", "semantic"),
            ]
        );
    }

    #[test]
    fn semantic_only_meetings_get_one_synthesized_related_row() {
        let long = format!("  {}  ", "a".repeat(120)); // padded → trim, then cap
        let semantic = [
            hit("m2", &long, 0.05, Some(61_500)),
            hit("m3", "short one", 0.30, None),
        ];

        let out = fuse_search_results(
            vec![kw("m1", "title", "Budget")],
            &semantic,
            &undated(),
            fixed_now(),
        );

        let m2 = out.iter().find(|r| r.meeting_id == "m2").unwrap();
        assert_eq!(m2.match_source, "semantic");
        assert_eq!(m2.snippet, "a".repeat(80), "content trimmed then capped at 80 chars");
        assert_eq!(m2.match_start_ms, Some(61_500), "jump-to-moment survives synthesis");

        let m3 = out.iter().find(|r| r.meeting_id == "m3").unwrap();
        assert_eq!(m3.snippet, "short one");
        assert_eq!(m3.match_start_ms, None, "orphaned vector degrades to no seek");
    }

    #[test]
    fn vec_arm_dedupes_to_best_segment_per_meeting() {
        // knn_segments is best-first; two m2 segments must collapse into one
        // Related row carrying the CLOSER segment's content and start_ms.
        let semantic = [
            hit("m2", "closest segment", 0.05, Some(1_000)),
            hit("m2", "worse segment", 0.40, Some(9_000)),
            hit("m5", "other meeting", 0.50, Some(3_000)),
        ];

        let out = fuse_search_results(
            vec![kw("m1", "title", "Budget")],
            &semantic,
            &undated(),
            fixed_now(),
        );

        let m2_rows: Vec<_> = out.iter().filter(|r| r.meeting_id == "m2").collect();
        assert_eq!(m2_rows.len(), 1, "one Related row per meeting, not per segment");
        assert_eq!(m2_rows[0].snippet, "closest segment");
        assert_eq!(m2_rows[0].match_start_ms, Some(1_000));
        // Dedupe must not eat the other semantic meeting.
        assert_eq!(out.iter().filter(|r| r.meeting_id == "m5").count(), 1);
        assert_eq!(out.len(), 3);
    }

    #[test]
    fn embeddings_off_is_byte_identical_to_search_all() {
        // Real search_all output (multi-arm, multi-meeting) fused with zero
        // semantic hits must pass through untouched — search stays exactly
        // today's behavior until an embedding index exists.
        let db = Database::new_in_memory().unwrap();
        let m = db.create_meeting("Budget planning").unwrap();
        let t = db.create_transcript(&m.id, "test").unwrap();
        db.update_transcript_segments(
            &t.id,
            r#"[{"text":"the budget looks tight","start_ms":3000,"end_ms":4000}]"#,
        )
        .unwrap();
        let note = db.create_note(&m.id, None).unwrap();
        db.update_note_raw_content(
            &note.id,
            r#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"budget follow-ups"}]}]}"#,
        )
        .unwrap();
        db.create_meeting("Budget retro").unwrap();

        let keyword = db.search_all("budget", 20).unwrap();
        assert!(keyword.len() >= 4, "want 2 titles + transcript + notes, got {keyword:?}");

        let fused = fuse_search_results(keyword.clone(), &[], &undated(), fixed_now());
        assert_eq!(
            serde_json::to_string(&fused).unwrap(),
            serde_json::to_string(&keyword).unwrap(),
        );
    }

    // --- Recency decay + title boost (plan v10 #7) ---

    #[test]
    fn title_boost_lifts_an_exact_title_match_over_the_adjacent_keyword_rank() {
        // Identical shape twice; only m2's match_source differs, so the
        // flip is attributable to the boost alone. No dates → no decay.
        let semantic = [hit("m9", "related thing", 0.1, None)];

        // m2 titled at kw rank 2: 1.15/62 > m1's 1/61 → m2 leads.
        let boosted = fuse_search_results(
            vec![
                kw("m1", "transcript", "budget mentioned"),
                kw("m2", "title", "Budget planning"),
            ],
            &semantic,
            &undated(),
            fixed_now(),
        );
        assert_eq!(
            rows(&boosted),
            vec![("m2", "title"), ("m1", "transcript"), ("m9", "semantic")]
        );

        // Same ranks, m2 not titled: plain RRF order (m1 ties m9 at 1/61,
        // id tiebreak) — m2 stays last.
        let unboosted = fuse_search_results(
            vec![
                kw("m1", "transcript", "budget mentioned"),
                kw("m2", "notes", "budget notes"),
            ],
            &semantic,
            &undated(),
            fixed_now(),
        );
        assert_eq!(
            rows(&unboosted),
            vec![("m1", "transcript"), ("m9", "semantic"), ("m2", "notes")]
        );
    }

    #[test]
    fn recent_meetings_outrank_stale_better_matches_but_uniform_dates_change_nothing() {
        let keyword = vec![
            kw("m_old", "transcript", "exact strong match"),
            kw("m_new", "transcript", "weaker match"),
        ];
        let semantic = [hit("m_sem", "related", 0.1, None)];

        // Everything dated today → pure relevance order. (m_sem at vec
        // rank 1 ties m_old's 1/61 exactly; "m_old" < "m_sem" breaks it.)
        let fresh = fuse_search_results(
            keyword.clone(),
            &semantic,
            &dates(&[("m_old", 0), ("m_new", 0), ("m_sem", 0)]),
            fixed_now(),
        );
        assert_eq!(
            rows(&fresh),
            vec![("m_old", "transcript"), ("m_sem", "semantic"), ("m_new", "transcript")]
        );

        // m_old now two half-lives stale (×0.25 = 1/61·0.25 ≈ .0041):
        // both fresh meetings overtake it; it still surfaces last.
        let decayed = fuse_search_results(
            keyword,
            &semantic,
            &dates(&[("m_old", 150), ("m_new", 0), ("m_sem", 0)]),
            fixed_now(),
        );
        assert_eq!(
            rows(&decayed),
            vec![("m_sem", "semantic"), ("m_new", "transcript"), ("m_old", "transcript")]
        );
    }

    #[test]
    fn decay_floors_so_ancient_matches_keep_relevance_order_and_never_vanish() {
        let keyword = vec![
            kw("m_a", "transcript", "best ancient match"),
            kw("m_b", "transcript", "worse ancient match"),
        ];
        let semantic = [hit("m_new", "fresh thing", 0.1, None)];
        let out = fuse_search_results(
            keyword,
            &semantic,
            &dates(&[("m_a", 1_095), ("m_b", 3_650), ("m_new", 0)]),
            fixed_now(),
        );
        // Fresh meeting first; the 3-year and 10-year meetings both sit on
        // the same 0.25 floor, so their keyword order survives — age never
        // crushes an old match to ~zero or reorders equally-old history.
        assert_eq!(
            rows(&out),
            vec![("m_new", "semantic"), ("m_a", "transcript"), ("m_b", "transcript")]
        );
    }

    #[test]
    fn decay_off_paths_are_byte_identical_to_each_other_and_to_the_boosted_fusion() {
        // GATE (plan v10 #7): four ways to "no decay" — dates unknown,
        // dated today, dated in the future, dates malformed — must produce
        // the identical byte-for-byte fusion, and that fusion is exactly
        // the pre-decay ordering (title boost included).
        let keyword = || {
            vec![
                kw("m1", "title", "Budget planning"),
                kw("m2", "title", "Spend review"),
                kw("m1", "transcript", "the budget looks tight"),
            ]
        };
        let semantic = [
            hit("m2", "how much we can spend", 0.05, Some(1_000)),
            hit("m4", "allocating next quarter's money", 0.20, Some(2_000)),
        ];
        let garbage: std::collections::HashMap<String, String> =
            [("m1", "never"), ("m2", ""), ("m4", "not/a/date")]
                .iter()
                .map(|(id, d)| (id.to_string(), d.to_string()))
                .collect();

        let baseline = fuse_search_results(keyword(), &semantic, &undated(), fixed_now());
        for (name, map) in [
            ("today", dates(&[("m1", 0), ("m2", 0), ("m4", 0)])),
            ("future", dates(&[("m1", -30), ("m2", -30), ("m4", -30)])),
            ("malformed", garbage),
        ] {
            let out = fuse_search_results(keyword(), &semantic, &map, fixed_now());
            assert_eq!(
                serde_json::to_string(&out).unwrap(),
                serde_json::to_string(&baseline).unwrap(),
                "{name} dates must not decay"
            );
        }
        assert_eq!(
            rows(&baseline),
            vec![("m2", "title"), ("m1", "title"), ("m1", "transcript"), ("m4", "semantic")]
        );
    }
}
