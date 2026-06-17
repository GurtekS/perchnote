//! Embedding indexer for hybrid semantic recall (plan v2 rank 10; backend
//! dispatch plan v10 #4).
//!
//! Fully local: vectors live in the SQLite file next to everything else and
//! come from one of two on-device backends —
//!
//!   * **Apple** (`apple_embed`) — NLContextualEmbedding, macOS 14+. Zero
//!     setup: present on every machine the app runs on, so semantic recall
//!     now works for everyone (the OS may download the model assets once).
//!   * **Ollama** — the user's own Ollama with an embedding model pulled.
//!     Stays as an explicit override, and existing users who already indexed
//!     via Ollama keep it (no index churn).
//!
//! The `embedding_backend` setting ("off" | "apple" | "ollama", unset =
//! auto-detect) picks; see [`resolve_policy`] for the exact precedence. Any
//! backend failure degrades to FTS-only search — today's no-embeddings
//! behavior — with nothing surfaced beyond a log line.

use anyhow::Result;
use std::sync::atomic::{AtomicBool, Ordering};

use crate::ai::apple_embed;
use crate::db::Database;
use crate::transcription::whisper::TranscriptSegment;

/// Ollama embedding models we know how to detect, in preference order.
const KNOWN_EMBED_MODELS: &[&str] = &["nomic-embed-text", "embeddinggemma", "all-minilm"];

/// Segments shorter than this carry no recall value ("Yeah.", "Mm-hmm.").
const MIN_SEGMENT_CHARS: usize = 20;
/// Per-meeting cap — a pathological transcript shouldn't pin the embedder for minutes.
const MAX_SEGMENTS_PER_MEETING: usize = 600;
const EMBED_BATCH: usize = 32;

/// Settings keys.
pub const BACKEND_SETTING: &str = "embedding_backend";
const MODEL_SETTING: &str = "embedding_model";

// ─── Backend ──────────────────────────────────────────────────────────────────

/// A resolved, usable embedding backend. (Recall-off is `None` at the
/// resolver, not a variant — every holder of this type can embed.)
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EmbeddingBackend {
    Ollama { model: String },
    Apple,
}

impl EmbeddingBackend {
    /// Persisted model identity, fed to `ensure_vec_index`: a backend switch
    /// changes this string, which trips the same drop+rebuild path as an
    /// Ollama model change (vectors from different models never mix).
    pub fn model_id(&self) -> &str {
        match self {
            EmbeddingBackend::Ollama { model } => model,
            EmbeddingBackend::Apple => apple_embed::MODEL_ID,
        }
    }

    /// Embed a batch of texts, order preserved.
    async fn embed(&self, texts: &[String]) -> Result<Vec<Vec<f32>>> {
        match self {
            EmbeddingBackend::Ollama { model } => crate::ai::ollama::embed(model, texts).await,
            EmbeddingBackend::Apple => apple_embed::embed(texts).await,
        }
    }
}

// ─── Resolver policy (pure — unit-tested without FFI or network) ─────────────

/// What the resolver decided, before side effects.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Resolution {
    /// Recall off: explicit setting, or nothing usable. FTS-only search.
    Off,
    /// Use Apple now (assets installed).
    Apple,
    /// Apple chosen but assets missing: kick off the background download
    /// and behave as Off until it lands.
    AppleNeedsAssets,
    Ollama(String),
}

/// Decide the backend from plain facts.
///
/// * `backend_setting` — `embedding_backend`: "off" | "apple" | "ollama";
///   anything else (unset, "") means auto-detect.
/// * `model_setting` — the legacy `embedding_model` setting. "off"/"" was
///   the pre-v10 way to disable recall and still wins in auto mode; a model
///   name marks an existing Ollama index we must not churn.
/// * `apple_*` — what `apple_embed::availability()` reported.
/// * `ollama_reachable` / `detected_ollama_model` — probe results (the
///   async wrapper only gathers these when the decision can need them).
pub(crate) fn resolve_policy(
    backend_setting: Option<&str>,
    model_setting: Option<&str>,
    apple_available: bool,
    apple_assets_installed: bool,
    ollama_reachable: bool,
    detected_ollama_model: Option<&str>,
) -> Resolution {
    let apple = || {
        if apple_assets_installed {
            Resolution::Apple
        } else {
            Resolution::AppleNeedsAssets
        }
    };
    // A real Ollama model name in the legacy setting ("off"/"" mean off; the
    // Apple sentinel is index bookkeeping, never an Ollama model).
    let legacy_model =
        model_setting.filter(|m| !m.is_empty() && *m != "off" && *m != apple_embed::MODEL_ID);

    match backend_setting {
        Some("off") => Resolution::Off,
        Some("apple") => {
            if apple_available {
                apple()
            } else {
                Resolution::Off
            }
        }
        Some("ollama") => match legacy_model.or(detected_ollama_model) {
            Some(m) => Resolution::Ollama(m.to_string()),
            None => Resolution::Off,
        },
        // Unset (or unrecognized): auto-detect.
        _ => {
            // Pre-v10 explicit off keeps recall off — honor the old switch.
            if model_setting.is_some_and(|m| m == "off" || m.is_empty()) {
                return Resolution::Off;
            }
            // An existing user already indexed via Ollama keeps Ollama while
            // it's reachable — never churn their index just because Apple
            // exists. When Ollama is down, degrade to Off (today's behavior)
            // rather than flip-flopping the index to Apple and back.
            if let Some(m) = legacy_model {
                return if ollama_reachable {
                    Resolution::Ollama(m.to_string())
                } else {
                    Resolution::Off
                };
            }
            if apple_available {
                return apple();
            }
            match detected_ollama_model {
                Some(m) => Resolution::Ollama(m.to_string()),
                None => Resolution::Off,
            }
        }
    }
}

/// First Ollama model matching a known embedding family ("name" or "name:tag").
fn detect_known_model(models: &[String]) -> Option<String> {
    KNOWN_EMBED_MODELS.iter().find_map(|known| {
        models
            .iter()
            .find(|m| m.as_str() == *known || m.starts_with(&format!("{known}:")))
            .cloned()
    })
}

// ─── Resolver (side-effecting wrapper) ────────────────────────────────────────

/// One background asset download per app run. A failed download retries
/// next launch; resolve keeps returning None (FTS-only) meanwhile.
static APPLE_ASSET_DOWNLOAD_STARTED: AtomicBool = AtomicBool::new(false);

fn trigger_apple_asset_download() {
    if APPLE_ASSET_DOWNLOAD_STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    tauri::async_runtime::spawn(async {
        log::info!("semantic recall: downloading Apple embedding assets in the background");
        match tokio::task::spawn_blocking(apple_embed::request_assets_blocking).await {
            Ok(Ok(())) => log::info!("semantic recall: Apple embedding assets installed"),
            Ok(Err(e)) => log::warn!("semantic recall: Apple asset download failed: {e}"),
            Err(e) => log::warn!("semantic recall: Apple asset download task failed: {e}"),
        }
    });
}

/// The backend to embed with, or None when semantic recall is off (explicit
/// setting, nothing usable, or Apple assets still downloading). Probes stay
/// lazy: Ollama is only contacted when the decision can depend on it.
pub async fn resolve_backend(db: &Database) -> Option<EmbeddingBackend> {
    let backend_setting = db.get_setting(BACKEND_SETTING).ok().flatten();
    let model_setting = db.get_setting(MODEL_SETTING).ok().flatten();
    let bs = backend_setting.as_deref();
    let ms = model_setting.as_deref();

    let avail = apple_embed::availability();
    let legacy_model =
        ms.filter(|m| !m.is_empty() && *m != "off" && *m != apple_embed::MODEL_ID);
    let legacy_off = ms.is_some_and(|m| m == "off" || m.is_empty());

    // Mirror resolve_policy's needs: explicit "ollama" without a model needs
    // detection; auto needs reachability for a sticky legacy model, or
    // detection when Apple can't serve.
    let needs_ollama = match bs {
        Some("ollama") => legacy_model.is_none(),
        Some(_) => false,
        None => !legacy_off && (legacy_model.is_some() || !avail.available),
    };
    let models = if needs_ollama {
        crate::ai::ollama::list_models().await.ok()
    } else {
        None
    };
    let detected = models.as_deref().and_then(detect_known_model);

    match resolve_policy(
        bs,
        ms,
        avail.available,
        avail.assets_installed,
        models.is_some(),
        detected.as_deref(),
    ) {
        Resolution::Off => None,
        Resolution::Apple => Some(EmbeddingBackend::Apple),
        Resolution::AppleNeedsAssets => {
            trigger_apple_asset_download();
            None
        }
        Resolution::Ollama(model) => {
            // Persist a detected model (like the old auto-detect did) so the
            // choice stays stable — and sticky against Apple — afterwards.
            if ms != Some(model.as_str()) {
                let _ = db.set_setting(MODEL_SETTING, &model);
                log::info!("semantic recall: detected embedding model {model}");
            }
            Some(EmbeddingBackend::Ollama { model })
        }
    }
}

// ─── Indexing + search ────────────────────────────────────────────────────────

/// Embed and store every usable segment of one meeting's transcript.
/// Returns the number of vectors written (0 when disabled or no transcript).
pub async fn index_meeting(db: &Database, meeting_id: &str) -> Result<usize> {
    let Some(backend) = resolve_backend(db).await else {
        return Ok(0);
    };
    let Some(transcript) = db.get_transcript_by_meeting(meeting_id).ok().flatten() else {
        return Ok(0);
    };
    let segments: Vec<TranscriptSegment> =
        serde_json::from_str(&transcript.segments).unwrap_or_default();

    let usable: Vec<(usize, String)> = segments
        .iter()
        .enumerate()
        .map(|(i, s)| (i, s.text.trim().to_string()))
        .filter(|(_, t)| t.len() >= MIN_SEGMENT_CHARS)
        .take(MAX_SEGMENTS_PER_MEETING)
        .collect();
    if usable.is_empty() {
        return Ok(0);
    }

    let mut written = 0usize;
    for batch in usable.chunks(EMBED_BATCH) {
        let texts: Vec<String> = batch.iter().map(|(_, t)| t.clone()).collect();
        let vectors = backend.embed(&texts).await?;
        let dims = vectors.first().map(|v| v.len()).unwrap_or(0);
        // First batch establishes (or validates) the index shape.
        db.ensure_vec_index(backend.model_id(), dims)?;
        let items: Vec<(String, String, String, Vec<f32>)> = batch
            .iter()
            .zip(vectors)
            .map(|((seg_idx, text), emb)| {
                (
                    format!("{}:{}", transcript.id, seg_idx),
                    meeting_id.to_string(),
                    text.clone(),
                    emb,
                )
            })
            .collect();
        written += db.upsert_segment_vectors(&items)?;
    }
    Ok(written)
}

/// Nearest transcript segments to a natural-language query, best first.
/// Empty when recall is off or nothing is indexed — callers fall back to FTS.
pub async fn semantic_search(
    db: &Database,
    query: &str,
    k: usize,
) -> Result<Vec<crate::db::vectors::VecHit>> {
    if query.trim().is_empty() || !db.vec_index_ready() {
        return Ok(Vec::new());
    }
    let Some(backend) = resolve_backend(db).await else {
        return Ok(Vec::new());
    };
    let mut vectors = backend.embed(&[query.to_string()]).await?;
    let Some(query_emb) = vectors.pop() else {
        return Ok(Vec::new());
    };
    db.knn_segments(&query_emb, k)
}

/// Startup backfill: index meetings that have transcripts but no vectors yet.
/// Quiet no-op when recall is off. One meeting at a time — the Ollama case
/// shares the user's server, the Apple case shares their machine.
pub async fn backfill(db: &Database) {
    let Some(_backend) = resolve_backend(db).await else {
        return;
    };
    let Ok(all_ids) = db.all_meeting_ids() else {
        return;
    };
    let done = db.vec_indexed_meeting_ids().unwrap_or_default();
    let pending: Vec<String> = all_ids.into_iter().filter(|id| !done.contains(id)).collect();
    if pending.is_empty() {
        return;
    }
    log::info!("semantic recall: backfilling {} meetings", pending.len());
    let mut indexed = 0usize;
    for id in &pending {
        match index_meeting(db, id).await {
            Ok(n) if n > 0 => indexed += 1,
            Ok(_) => {}
            Err(e) => {
                // The embedder went away mid-backfill (Ollama stopped, asset
                // eviction, …); stop quietly, retry next launch.
                log::warn!("semantic recall: backfill stopped at {id}: {e}");
                break;
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
    }
    log::info!("semantic recall: backfill indexed {indexed} meetings");
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    const APPLE: &str = apple_embed::MODEL_ID;

    /// Shorthand: facts → resolution.
    fn policy(
        backend: Option<&str>,
        model: Option<&str>,
        apple: (bool, bool), // (available, assets_installed)
        ollama: (bool, Option<&str>), // (reachable, detected model)
    ) -> Resolution {
        resolve_policy(backend, model, apple.0, apple.1, ollama.0, ollama.1)
    }

    #[test]
    fn explicit_off_beats_everything() {
        let r = policy(Some("off"), Some("nomic-embed-text"), (true, true), (true, Some("nomic-embed-text")));
        assert_eq!(r, Resolution::Off);
    }

    #[test]
    fn explicit_apple_uses_apple_or_requests_assets() {
        assert_eq!(policy(Some("apple"), None, (true, true), (false, None)), Resolution::Apple);
        assert_eq!(
            policy(Some("apple"), None, (true, false), (false, None)),
            Resolution::AppleNeedsAssets
        );
        // Apple picked on a machine that can't serve it: off, never a crash.
        assert_eq!(policy(Some("apple"), None, (false, false), (true, Some("all-minilm"))), Resolution::Off);
        // The explicit choice ignores a legacy Ollama model entirely.
        assert_eq!(
            policy(Some("apple"), Some("nomic-embed-text"), (true, true), (true, Some("nomic-embed-text"))),
            Resolution::Apple
        );
    }

    #[test]
    fn explicit_ollama_uses_the_set_model_then_detection() {
        // The persisted model wins, reachable or not (failures degrade at
        // embed time, exactly like the pre-v10 explicit setting).
        assert_eq!(
            policy(Some("ollama"), Some("nomic-embed-text"), (true, true), (false, None)),
            Resolution::Ollama("nomic-embed-text".into())
        );
        assert_eq!(
            policy(Some("ollama"), None, (true, true), (true, Some("all-minilm"))),
            Resolution::Ollama("all-minilm".into())
        );
        assert_eq!(policy(Some("ollama"), None, (true, true), (false, None)), Resolution::Off);
        // The Apple index sentinel is not an Ollama model.
        assert_eq!(policy(Some("ollama"), Some(APPLE), (true, true), (false, None)), Resolution::Off);
    }

    #[test]
    fn auto_prefers_apple_for_new_users() {
        assert_eq!(policy(None, None, (true, true), (false, None)), Resolution::Apple);
        // Assets missing: download in the background, off meanwhile.
        assert_eq!(policy(None, None, (true, false), (false, None)), Resolution::AppleNeedsAssets);
        // Empty-string backend setting means auto too.
        assert_eq!(policy(Some(""), None, (true, true), (false, None)), Resolution::Apple);
    }

    #[test]
    fn auto_keeps_an_existing_ollama_index_sticky() {
        // Already indexed via Ollama + Ollama reachable: keep it, even with
        // Apple fully available — never churn the user's index.
        assert_eq!(
            policy(None, Some("nomic-embed-text"), (true, true), (true, Some("nomic-embed-text"))),
            Resolution::Ollama("nomic-embed-text".into())
        );
        // Ollama down: degrade to off (pre-v10 behavior), do NOT flip the
        // index to Apple over a transient outage.
        assert_eq!(policy(None, Some("nomic-embed-text"), (true, true), (false, None)), Resolution::Off);
        // The Apple sentinel persisted by a previous Apple run is not a
        // legacy Ollama model — Apple keeps serving.
        assert_eq!(policy(None, Some(APPLE), (true, true), (false, None)), Resolution::Apple);
    }

    #[test]
    fn auto_honors_the_legacy_off_switch() {
        for off in [Some("off"), Some("")] {
            assert_eq!(
                policy(None, off, (true, true), (true, Some("nomic-embed-text"))),
                Resolution::Off,
                "legacy embedding_model={off:?} must keep recall off"
            );
        }
    }

    #[test]
    fn auto_falls_back_to_ollama_then_off_without_apple() {
        assert_eq!(
            policy(None, None, (false, false), (true, Some("embeddinggemma"))),
            Resolution::Ollama("embeddinggemma".into())
        );
        assert_eq!(policy(None, None, (false, false), (true, None)), Resolution::Off);
        assert_eq!(policy(None, None, (false, false), (false, None)), Resolution::Off);
    }

    #[test]
    fn detect_prefers_known_model_order_and_matches_tags() {
        let models = vec![
            "llama3.2:latest".to_string(),
            "all-minilm:l6-v2".to_string(),
            "nomic-embed-text:latest".to_string(),
        ];
        assert_eq!(detect_known_model(&models).as_deref(), Some("nomic-embed-text:latest"));
        assert_eq!(detect_known_model(&["llama3.2".to_string()]), None);
        // No prefix false-positives ("all-minilm-turbo" is not "all-minilm:…").
        assert_eq!(detect_known_model(&["all-minilm-turbo".to_string()]), None);
    }

    /// Live-fire the whole path: resolve (explicit "apple") → embed via the
    /// Swift bridge → ensure_vec_index at the model's real dims → KNN.
    /// Requires macOS with the English embedding assets installed; skips
    /// (with a note) anywhere else. Run:
    ///   cargo test real_apple_semantic_recall -- --ignored --nocapture
    #[test]
    #[ignore]
    fn real_apple_semantic_recall() {
        let avail = apple_embed::availability();
        if !avail.available || !avail.assets_installed {
            eprintln!("skipping: Apple embedding assets unavailable on this host");
            return;
        }
        crate::db::vectors::register_vec_extension();
        let db = Database::new_in_memory().unwrap();
        db.set_setting(BACKEND_SETTING, "apple").unwrap();

        let m = db.create_meeting("Platform team sync").unwrap();
        let t = db.create_transcript(&m.id, "test").unwrap();
        db.update_transcript_segments(
            &t.id,
            r#"[{"text":"Amy will own recruiting for the platform team this quarter","start_ms":0,"end_ms":4000},
                {"text":"the parking garage closes at midnight on weekends","start_ms":5000,"end_ms":9000}]"#,
        )
        .unwrap();

        let rt = tokio::runtime::Runtime::new().unwrap();
        let written = rt.block_on(index_meeting(&db, &m.id)).unwrap();
        assert_eq!(written, 2, "both segments should index");
        assert_eq!(
            db.get_setting("embedding_index_model").unwrap().as_deref(),
            Some(apple_embed::MODEL_ID)
        );
        assert_eq!(
            db.get_setting("embedding_index_dims").unwrap().as_deref(),
            Some(avail.dims.to_string().as_str())
        );

        // Zero keyword overlap with the recruiting segment — only meaning
        // can rank it first.
        let hits = rt
            .block_on(semantic_search(&db, "who is responsible for hiring", 2))
            .unwrap();
        eprintln!("hits: {hits:#?}");
        assert_eq!(hits.len(), 2);
        assert!(
            hits[0].content.contains("recruiting"),
            "recruiting segment should out-rank parking: {hits:?}"
        );
    }

    #[test]
    fn backend_model_id_separates_index_identities() {
        assert_eq!(EmbeddingBackend::Apple.model_id(), APPLE);
        let ol = EmbeddingBackend::Ollama { model: "nomic-embed-text".into() };
        assert_eq!(ol.model_id(), "nomic-embed-text");
        // Distinct identities are what trip ensure_vec_index's rebuild on a
        // backend switch.
        assert_ne!(EmbeddingBackend::Apple.model_id(), ol.model_id());
    }
}
