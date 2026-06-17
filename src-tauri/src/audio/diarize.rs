//! Neural diarization via speakrs (plan v3 rank 12) — the pyannote
//! community-1 pipeline in Rust (Apache-2.0), running on CoreML. Replaces
//! mel-clustering for the post-stop pass once validated; mel remains the
//! live/fallback path.

use anyhow::{anyhow, Result};

/// One diarized span: (start_secs, end_secs, speaker_label).
pub type DiarSpan = (f64, f64, String);

/// The HF repo speakrs downloads its models from (mirrors the constant
/// inside the crate, which isn't exported).
const SPEAKRS_HF_REPO: &str = "avencera/speakrs-models";

/// Resolve the speakrs model bundle from the local HuggingFace cache
/// WITHOUT touching the network. `None` means the models haven't been
/// downloaded yet — callers that must never trigger a download (the
/// auto-diarize completion hook) skip silently on `None`; the explicit
/// Re-detect button keeps using `from_pretrained` (which downloads).
pub fn local_model_bundle() -> Option<speakrs::ModelBundle> {
    let repo = hf_hub::Cache::from_env().model(SPEAKRS_HF_REPO.to_string());
    // The two base models both pipeline and embedder need. hf_hub's Cache
    // is a purely local lookup (snapshot symlink resolution, no HTTP).
    let seg = repo.get("segmentation-3.0.onnx")?;
    repo.get("wespeaker-voxceleb-resnet34.onnx")?;
    let dir = seg.parent()?;
    Some(speakrs::ModelBundle::from_dir(dir))
}

/// True when the speakrs models are already on disk.
pub fn models_present() -> bool {
    local_model_bundle().is_some()
}

/// Run the speakrs pipeline over 16kHz mono f32 samples.
///
/// First call downloads the models from Hugging Face into the speakrs cache
/// — callers must treat this as a long, network-using operation and gate it
/// behind explicit user action (same policy as whisper model downloads).
pub fn diarize(samples: &[f32]) -> Result<Vec<DiarSpan>> {
    use speakrs::{ExecutionMode, OwnedDiarizationPipeline};
    let mut pipeline = OwnedDiarizationPipeline::from_pretrained(ExecutionMode::CoreMl)
        .map_err(|e| anyhow!("speakrs pipeline init failed: {e}"))?;
    let result = pipeline
        .run(samples)
        .map_err(|e| anyhow!("speakrs diarization failed: {e}"))?;
    // `segments` is already the merged speaker-turn list.
    Ok(result
        .segments
        .into_iter()
        .map(|s| (s.start, s.end, s.speaker))
        .collect())
}

/// Run the speakrs pipeline from the LOCAL model cache only (no download),
/// returning spans plus one L2-normalized centroid embedding per detected
/// speaker, keyed by the app's "Speaker N" label shape. The centroids live
/// in raw wespeaker space (PLDA is applied only inside the crate's
/// clustering step), so they're directly comparable with
/// [`SpeakerEmbedder::embed`] output.
pub fn diarize_local(samples: &[f32]) -> Result<(Vec<DiarSpan>, Vec<(String, Vec<f32>)>)> {
    use speakrs::{ExecutionMode, PipelineBuilder};
    let bundle = local_model_bundle().ok_or_else(|| anyhow!("speakrs models not downloaded"))?;
    let mut pipeline = PipelineBuilder::from_bundle(bundle, ExecutionMode::CoreMl)
        .build()
        .map_err(|e| anyhow!("speakrs pipeline init failed: {e}"))?;
    let result = pipeline
        .run(samples)
        .map_err(|e| anyhow!("speakrs diarization failed: {e}"))?;

    // (chunk, local-speaker) → cluster id; gather that pair's embedding.
    // Cluster id == the SPEAKER_{k:02} index in `segments` (the crate's
    // reconstruction maps activation columns to cluster ids 0..n).
    let (chunks, spk, dim) = result.embeddings.0.dim();
    let mut pairs: Vec<(i32, Vec<f32>)> = Vec::new();
    for c in 0..chunks {
        for s in 0..spk {
            let k = result.hard_clusters.0[[c, s]];
            if k < 0 {
                continue;
            }
            let emb: Vec<f32> = (0..dim).map(|d| result.embeddings.0[[c, s, d]]).collect();
            pairs.push((k, emb));
        }
    }
    let centroids = centroids_from_cluster_pairs(&pairs);

    let spans = result
        .segments
        .into_iter()
        .map(|s| (s.start, s.end, s.speaker))
        .collect();
    Ok((spans, centroids))
}

/// L2-normalize in place. Zero vectors are left untouched (cosine against
/// them is defined as 0 everywhere we compare).
pub fn l2_normalize(v: &mut [f32]) {
    let norm = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm > 0.0 {
        for x in v.iter_mut() {
            *x /= norm;
        }
    }
}

/// Average per-cluster embeddings into one L2-normalized centroid each.
/// Input pairs are (cluster_id, raw embedding); ids < 0 and non-finite
/// embeddings (the pipeline emits NaN rows for chunk-speaker slots with no
/// usable speech) are dropped. Labels follow the app's existing key shape:
/// cluster k → "Speaker {k+1}", matching `span_label`.
pub fn centroids_from_cluster_pairs(pairs: &[(i32, Vec<f32>)]) -> Vec<(String, Vec<f32>)> {
    use std::collections::BTreeMap;
    let mut sums: BTreeMap<i32, (Vec<f32>, usize)> = BTreeMap::new();
    for (k, emb) in pairs {
        if *k < 0 || emb.is_empty() || emb.iter().any(|x| !x.is_finite()) {
            continue;
        }
        let entry = sums
            .entry(*k)
            .or_insert_with(|| (vec![0.0; emb.len()], 0));
        if entry.0.len() != emb.len() {
            continue; // shape mismatch — never expected, never fatal
        }
        for (acc, x) in entry.0.iter_mut().zip(emb) {
            *acc += x;
        }
        entry.1 += 1;
    }
    sums.into_iter()
        .map(|(k, (mut sum, n))| {
            for x in sum.iter_mut() {
                *x /= n as f32;
            }
            l2_normalize(&mut sum);
            (format!("Speaker {}", k + 1), sum)
        })
        .collect()
}

/// One-shot neural speaker embedder over the wespeaker model from the
/// local cache. `try_new` is `None` when models aren't downloaded or fail
/// to load — callers fall back to mel features. CPU execution: profile
/// clips are a few seconds, one inference; not worth CoreML asset variance.
pub struct SpeakerEmbedder {
    model: speakrs::inference::EmbeddingModel,
}

impl SpeakerEmbedder {
    pub fn try_new() -> Option<Self> {
        let bundle = local_model_bundle()?;
        match speakrs::inference::EmbeddingModel::with_mode(
            bundle.embedding_path(),
            speakrs::ExecutionMode::Cpu,
        ) {
            Ok(model) => Some(Self { model }),
            Err(e) => {
                log::warn!("speaker embedder unavailable: {e}");
                None
            }
        }
    }

    /// Embed mono 16 kHz samples; returns an L2-normalized vector. Clips
    /// shorter than one second carry too little voice to trust.
    pub fn embed(&mut self, samples_16k: &[f32]) -> Result<Vec<f32>> {
        if samples_16k.len() < 16_000 {
            return Err(anyhow!("clip too short for a speaker embedding"));
        }
        let emb = self
            .model
            .embed(samples_16k)
            .map_err(|e| anyhow!("speaker embedding failed: {e}"))?;
        let mut v = emb.to_vec();
        if v.is_empty() || v.iter().any(|x| !x.is_finite()) {
            return Err(anyhow!("speaker embedding was empty or non-finite"));
        }
        l2_normalize(&mut v);
        Ok(v)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Validation against the real interview recording (known ground truth:
    /// exactly two speakers in healthy balance). Run:
    ///   PERCH_WAV=~/Library/.../recordings/<id>.wav \
    ///   cargo test real_speakrs_diarization -- --ignored --nocapture
    #[test]
    #[ignore]
    fn real_speakrs_diarization() {
        let wav = std::env::var("PERCH_WAV").expect("set PERCH_WAV");
        let samples =
            crate::transcription::engine::wav_to_whisper_samples(std::path::Path::new(&wav))
                .unwrap();
        eprintln!("audio: {}s", samples.len() / 16_000);

        let t0 = std::time::Instant::now();
        let spans = diarize(&samples).unwrap();
        eprintln!("diarized in {:?} -> {} spans", t0.elapsed(), spans.len());

        let mut per_speaker: std::collections::HashMap<&str, f64> = Default::default();
        for (start, end, spk) in &spans {
            *per_speaker.entry(spk.as_str()).or_default() += end - start;
        }
        let total: f64 = per_speaker.values().sum();
        let mut shares: Vec<(&str, f64)> = per_speaker
            .iter()
            .map(|(k, v)| (*k, v / total))
            .collect();
        shares.sort_by(|a, b| b.1.total_cmp(&a.1));
        for (spk, share) in &shares {
            eprintln!("  {spk}: {:.1}%", share * 100.0);
        }
        for (s, e, spk) in spans.iter().take(10) {
            eprintln!("  [{s:.1}-{e:.1}] {spk}");
        }

        assert_eq!(shares.len(), 2, "ground truth: exactly two speakers");
        assert!(
            shares[1].1 > 0.2,
            "both speakers carry real share (got {:.1}%)",
            shares[1].1 * 100.0
        );
    }

    #[test]
    fn l2_normalize_unit_norm_and_zero_safe() {
        let mut v = vec![3.0, 4.0];
        l2_normalize(&mut v);
        assert!((v[0] - 0.6).abs() < 1e-6 && (v[1] - 0.8).abs() < 1e-6);

        let mut z = vec![0.0, 0.0];
        l2_normalize(&mut z);
        assert_eq!(z, vec![0.0, 0.0], "zero vector must not become NaN");
    }

    #[test]
    fn centroids_group_average_normalize_and_label() {
        let pairs = vec![
            (0, vec![2.0, 0.0]),
            (0, vec![4.0, 0.0]),
            (1, vec![0.0, 5.0]),
            (-1, vec![9.0, 9.0]),               // unassigned slot — dropped
            (0, vec![f32::NAN, 1.0]),           // NaN row — dropped
        ];
        let cents = centroids_from_cluster_pairs(&pairs);
        assert_eq!(cents.len(), 2);
        assert_eq!(cents[0].0, "Speaker 1");
        assert_eq!(cents[1].0, "Speaker 2");
        // Speaker 1: mean of (2,0),(4,0) = (3,0) → normalized (1,0).
        assert!((cents[0].1[0] - 1.0).abs() < 1e-6 && cents[0].1[1].abs() < 1e-6);
        // Speaker 2: (0,5) → (0,1).
        assert!((cents[1].1[1] - 1.0).abs() < 1e-6);
    }

    #[test]
    fn centroids_empty_input_yields_no_speakers() {
        assert!(centroids_from_cluster_pairs(&[]).is_empty());
        // All-invalid input too.
        let pairs = vec![(-1, vec![1.0]), (2, vec![f32::INFINITY])];
        assert!(centroids_from_cluster_pairs(&pairs).is_empty());
    }

    /// Synthesize a fixture clip with macOS `say` and return mono 16 kHz
    /// samples. Live-test helper only.
    #[cfg(test)]
    fn say_16k(voice: &str, text: &str) -> Vec<f32> {
        let dir = std::env::temp_dir();
        let out = dir.join(format!("perchnote-sayfix-{voice}-{}.wav", text.len()));
        let status = std::process::Command::new("say")
            .args([
                "-v",
                voice,
                "--data-format=LEI16@16000",
                "-o",
                out.to_str().unwrap(),
                text,
            ])
            .status()
            .expect("`say` must be runnable");
        assert!(status.success(), "say failed for voice {voice}");
        let samples =
            crate::transcription::engine::wav_to_whisper_samples(&out).expect("fixture wav loads");
        let _ = std::fs::remove_file(&out);
        samples
    }

    /// Live fixture gate (plan v10 #1): embed two `say` voices with the
    /// neural model and verify same-voice similarity beats cross-voice with
    /// real margin — i.e. auto-naming can never pick the WRONG profile.
    /// Needs the speakrs models in the local HF cache. Run:
    ///   cargo test say_fixture_embed_and_match -- --ignored --nocapture
    #[test]
    #[ignore]
    fn say_fixture_embed_and_match() {
        assert!(models_present(), "download speakrs models first (Re-detect once)");
        let mut embedder = SpeakerEmbedder::try_new().expect("embedder loads from local cache");

        let enroll_a = say_16k("Samantha", "Hello, this is a longer enrollment sample for the first speaker profile in our meeting assistant test.");
        let probe_a = say_16k("Samantha", "Completely different words spoken now, to verify the voice itself is what gets matched.");
        let enroll_b = say_16k("Daniel", "Hello, this is a longer enrollment sample for the second speaker profile in our meeting assistant test.");

        let ea = embedder.embed(&enroll_a).unwrap();
        let pa = embedder.embed(&probe_a).unwrap();
        let eb = embedder.embed(&enroll_b).unwrap();

        let same = crate::audio::mel::cosine_similarity(&pa, &ea);
        let cross = crate::audio::mel::cosine_similarity(&pa, &eb);
        eprintln!("same-voice cosine:  {same:.4}");
        eprintln!("cross-voice cosine: {cross:.4}");
        eprintln!(
            "auto-apply threshold {}: same {} | cross {}",
            crate::commands::voice::NEURAL_AUTO_APPLY_THRESHOLD,
            if same >= crate::commands::voice::NEURAL_AUTO_APPLY_THRESHOLD { "WOULD AUTO-NAME" } else { "suggestion only" },
            if cross >= crate::commands::voice::NEURAL_AUTO_APPLY_THRESHOLD { "FALSE POSITIVE" } else { "rejected" },
        );

        assert!(same > cross + 0.15, "same-voice must beat cross-voice with margin");
        assert!(
            cross < crate::commands::voice::NEURAL_AUTO_APPLY_THRESHOLD,
            "a different voice must NEVER clear the auto-apply threshold (got {cross:.4})"
        );
    }

    /// Full local pipeline on a stitched two-voice fixture: diarize, build
    /// centroids, match against `say`-voice profiles — the wrong name must
    /// never win. Run:
    ///   cargo test say_fixture_diarize_and_name -- --ignored --nocapture
    #[test]
    #[ignore]
    fn say_fixture_diarize_and_name() {
        assert!(models_present(), "download speakrs models first (Re-detect once)");
        let mut embedder = SpeakerEmbedder::try_new().expect("embedder loads");

        let a = say_16k("Samantha", "Let us walk through the quarterly roadmap and the launch checklist for the new feature, including dates and owners for every single milestone we have planned.");
        let b = say_16k("Daniel", "Thanks for the overview. I want to flag two risks on the infrastructure side and propose that we move the migration earlier in the schedule.");
        let mut meeting: Vec<f32> = Vec::with_capacity(a.len() + b.len() + 16_000);
        meeting.extend_from_slice(&a);
        meeting.extend(std::iter::repeat(0.0).take(8_000)); // half-second gap
        meeting.extend_from_slice(&b);

        let (spans, centroids) = diarize_local(&meeting).unwrap();
        eprintln!("{} spans, {} centroids", spans.len(), centroids.len());
        for (s, e, spk) in &spans {
            eprintln!("  [{s:.1}-{e:.1}] {spk}");
        }
        assert!(!spans.is_empty(), "fixture speech must produce spans");
        assert!(!centroids.is_empty(), "speakers must yield centroids");

        let profiles = vec![
            ("Samantha".to_string(), embedder.embed(&say_16k("Samantha", "An unrelated enrollment sentence for the first profile.")).unwrap()),
            ("Daniel".to_string(), embedder.embed(&say_16k("Daniel", "An unrelated enrollment sentence for the second profile.")).unwrap()),
        ];

        // Ground truth by time: Samantha speaks first, Daniel second.
        let boundary = a.len() as f64 / 16_000.0;
        for (label, centroid) in &centroids {
            let talk_before: f64 = spans.iter().filter(|(s0, _, spk)| span_label(spk) == *label && *s0 < boundary).map(|(s0, e0, _)| e0.min(boundary) - s0).sum();
            let talk_after: f64 = spans.iter().filter(|(_, e0, spk)| span_label(spk) == *label && *e0 > boundary).map(|(s0, e0, _)| e0 - s0.max(boundary)).sum();
            let truth = if talk_before >= talk_after { "Samantha" } else { "Daniel" };
            for (name, emb) in &profiles {
                let sim = crate::audio::mel::cosine_similarity(centroid, emb);
                eprintln!("  {label} vs {name}: {sim:.4} (truth: {truth})");
            }
            // THE gate (plan v10 #1): the production decision fn must never
            // auto-apply the wrong name. Missing (None) is acceptable —
            // that's the suggestion surface's job.
            match crate::commands::voice::auto_apply_match(centroid, &profiles) {
                Some((name, sim)) => {
                    eprintln!("  {label} AUTO-NAMES as {name} ({sim:.4})");
                    assert_eq!(name, truth, "{label} FALSELY auto-named {name} (sim {sim:.4})");
                }
                None => eprintln!("  {label} → no auto-name (suggestion only)"),
            }
        }
    }
}

/// Map a speakrs span label ("SPEAKER_00") to the app's key shape
/// ("Speaker 1"). Cluster k → "Speaker {k+1}", same as the centroids.
pub fn span_label(spk: &str) -> String {
    let n: usize = spk
        .rsplit('_')
        .next()
        .and_then(|d| d.parse().ok())
        .unwrap_or(0);
    format!("Speaker {}", n + 1)
}

/// The "Speaker N" label whose span overlaps `[s, e]` (seconds) most, or
/// `fallback` when nothing touches it.
fn speaker_for_interval(s: f64, e: f64, spans: &[DiarSpan], fallback: Option<&str>) -> Option<String> {
    let mut per: std::collections::HashMap<&str, f64> = Default::default();
    for (b0, b1, spk) in spans {
        let ov = (e.min(*b1) - s.max(*b0)).max(0.0);
        if ov > 0.0 {
            *per.entry(spk.as_str()).or_default() += ov;
        }
    }
    per.into_iter()
        .max_by(|a, b| a.1.total_cmp(&b.1))
        .map(|(spk, _)| span_label(spk))
        .or_else(|| fallback.map(str::to_string))
}

/// Assign speakers AND re-segment along speaker turns: when a segment's words
/// straddle a speaker change, it's split into one sub-segment per turn at the
/// word boundary, so fast back-and-forth doesn't collapse onto whoever talked
/// longest (each speaker is kept). Segments without word timestamps (live-only
/// or Apple transcripts) fall back to a single max-overlap assignment — never
/// worse than before. Returns the new segment list and the distinct speaker
/// count.
pub fn assign_speakers_splitting(
    segments: Vec<crate::transcription::whisper::TranscriptSegment>,
    spans: &[DiarSpan],
) -> (Vec<crate::transcription::whisper::TranscriptSegment>, usize) {
    let mut out = Vec::with_capacity(segments.len());
    let mut used: std::collections::BTreeSet<String> = Default::default();
    for seg in segments {
        for piece in split_segment_by_speaker(seg, spans) {
            if let Some(sp) = &piece.speaker {
                used.insert(sp.clone());
            }
            out.push(piece);
        }
    }
    (out, used.len())
}

/// Split one segment into per-speaker pieces along its words; returns a single
/// (speaker-assigned) segment when it can't or needn't split.
fn split_segment_by_speaker(
    seg: crate::transcription::whisper::TranscriptSegment,
    spans: &[DiarSpan],
) -> Vec<crate::transcription::whisper::TranscriptSegment> {
    use crate::transcription::whisper::{TranscriptSegment, WordTimestamp};

    let s = seg.start_ms as f64 / 1000.0;
    let e = seg.end_ms as f64 / 1000.0;
    let whole = speaker_for_interval(s, e, spans, None);

    // How many distinct speakers touch the segment at all?
    let mut touching: std::collections::BTreeSet<String> = Default::default();
    for (b0, b1, spk) in spans {
        if (e.min(*b1) - s.max(*b0)).max(0.0) > 0.0 {
            touching.insert(span_label(spk));
        }
    }

    // Nothing to split: no word times, or a single (or no) speaker. Keep the
    // segment and its exact text; only stamp the speaker.
    let splittable =
        touching.len() >= 2 && seg.words.as_ref().map(|w| w.len() >= 2).unwrap_or(false);
    if !splittable {
        let mut seg = seg;
        seg.speaker = whole;
        return vec![seg];
    }
    let words: Vec<WordTimestamp> = seg.words.clone().unwrap_or_default();

    // Per-word speaker, then smooth lone single-word flips (a stray word
    // mid-sentence shouldn't carve a turn) before grouping into runs.
    let mut labels: Vec<String> = words
        .iter()
        .map(|w| {
            speaker_for_interval(
                w.start_ms as f64 / 1000.0,
                w.end_ms.max(w.start_ms) as f64 / 1000.0,
                spans,
                whole.as_deref(),
            )
            .unwrap_or_else(|| whole.clone().unwrap_or_else(|| "Speaker 1".to_string()))
        })
        .collect();
    for i in 1..labels.len().saturating_sub(1) {
        if labels[i] != labels[i - 1] && labels[i - 1] == labels[i + 1] {
            labels[i] = labels[i - 1].clone();
        }
    }

    // Group consecutive same-speaker words into runs.
    let mut runs: Vec<(String, Vec<crate::transcription::whisper::WordTimestamp>)> = Vec::new();
    for (w, label) in words.into_iter().zip(labels) {
        match runs.last_mut() {
            Some((l, ws)) if *l == label => ws.push(w),
            _ => runs.push((label, vec![w])),
        }
    }

    // One run after smoothing → just a single-speaker segment, text untouched.
    if runs.len() <= 1 {
        let mut seg = seg;
        seg.speaker = runs.into_iter().next().map(|(l, _)| l).or(whole);
        return vec![seg];
    }

    // Genuine multi-speaker stretch: one sub-segment per run, text rebuilt
    // from its words (their tokens concatenate back to the original text).
    let mut pieces = Vec::with_capacity(runs.len());
    for (i, (label, run_words)) in runs.into_iter().enumerate() {
        let text = run_words
            .iter()
            .map(|w| w.word.as_str())
            .collect::<Vec<_>>()
            .join(" ");
        let start_ms = run_words.first().map(|w| w.start_ms).unwrap_or(seg.start_ms);
        let end_ms = run_words
            .last()
            .map(|w| w.end_ms.max(w.start_ms))
            .unwrap_or(seg.end_ms)
            .max(start_ms);
        pieces.push(TranscriptSegment {
            text,
            start_ms,
            end_ms,
            speaker: Some(label),
            confidence: seg.confidence,
            words: Some(run_words),
            is_overlap: seg.is_overlap,
            speaker_confidence: seg.speaker_confidence,
            // A ⌘D highlight lost its exact time when it became a bool on the
            // parent; pin it to the first piece rather than star every one.
            highlighted: i == 0 && seg.highlighted,
        });
    }
    pieces
}

#[cfg(test)]
mod assign_tests {
    use super::*;
    use crate::transcription::whisper::TranscriptSegment;

    fn seg(start_ms: u64, end_ms: u64) -> TranscriptSegment {
        TranscriptSegment {
            text: "x".into(),
            start_ms,
            end_ms,
            speaker: None,
            confidence: None,
            words: None,
            is_overlap: false,
            speaker_confidence: 0.0,
            highlighted: false,
        }
    }

    #[test]
    fn word_less_segments_assign_by_max_overlap_without_splitting() {
        // No word timestamps → behave like the old per-segment assignment:
        // one speaker each by max overlap, no new segments.
        let segs = vec![seg(0, 5_000), seg(5_000, 10_000), seg(60_000, 61_000)];
        let spans = vec![
            (0.0, 4.0, "SPEAKER_00".to_string()),
            (3.5, 9.5, "SPEAKER_01".to_string()),
        ];
        let (out, n) = assign_speakers_splitting(segs, &spans);
        assert_eq!(out.len(), 3, "word-less segments are never split");
        assert_eq!(n, 2);
        assert_eq!(out[0].speaker.as_deref(), Some("Speaker 1"), "4s vs 1.5s overlap");
        assert_eq!(out[1].speaker.as_deref(), Some("Speaker 2"));
        assert_eq!(out[2].speaker, None, "nothing spans the far segment");
    }

    use crate::transcription::whisper::WordTimestamp;

    /// Segment carrying one word per `texts` entry, evenly tiled across
    /// [start_ms, end_ms].
    fn wseg(start_ms: u64, end_ms: u64, texts: &[&str]) -> TranscriptSegment {
        let n = texts.len() as u64;
        let step = (end_ms - start_ms) / n.max(1);
        let words = texts
            .iter()
            .enumerate()
            .map(|(i, t)| WordTimestamp {
                word: t.to_string(),
                start_ms: start_ms + i as u64 * step,
                end_ms: start_ms + (i as u64 + 1) * step,
            })
            .collect();
        TranscriptSegment {
            text: texts.join(" "),
            start_ms,
            end_ms,
            speaker: None,
            confidence: None,
            words: Some(words),
            is_overlap: false,
            speaker_confidence: 0.0,
            highlighted: false,
        }
    }

    #[test]
    fn splits_a_two_speaker_segment_at_the_word_boundary() {
        // 0-8s, four words; A owns 0-4s, B owns 4-8s.
        let seg = wseg(0, 8_000, &["one", "two", "three", "four"]);
        let spans = vec![
            (0.0, 4.0, "SPEAKER_00".to_string()),
            (4.0, 8.0, "SPEAKER_01".to_string()),
        ];
        let (out, n) = assign_speakers_splitting(vec![seg], &spans);
        assert_eq!(n, 2);
        assert_eq!(out.len(), 2, "one piece per speaker turn");
        assert_eq!(out[0].speaker.as_deref(), Some("Speaker 1"));
        assert_eq!(out[0].text, "one two");
        assert_eq!(out[0].start_ms, 0);
        assert_eq!(out[1].speaker.as_deref(), Some("Speaker 2"));
        assert_eq!(out[1].text, "three four");
        assert_eq!(out[1].end_ms, 8_000);
    }

    #[test]
    fn single_speaker_segment_is_kept_whole_with_text_untouched() {
        let seg = wseg(0, 6_000, &["all", "one", "person"]);
        let spans = vec![(0.0, 6.0, "SPEAKER_00".to_string())];
        let (out, n) = assign_speakers_splitting(vec![seg], &spans);
        assert_eq!(n, 1);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].text, "all one person", "exact text preserved");
        assert_eq!(out[0].speaker.as_deref(), Some("Speaker 1"));
    }

    #[test]
    fn segment_without_words_falls_back_to_single_assignment() {
        // Two speakers overlap but no word times → can't split; pick dominant.
        let seg = seg(0, 8_000); // words: None
        let spans = vec![
            (0.0, 5.0, "SPEAKER_00".to_string()),
            (5.0, 8.0, "SPEAKER_01".to_string()),
        ];
        let (out, n) = assign_speakers_splitting(vec![seg], &spans);
        assert_eq!(out.len(), 1, "no split without word timestamps");
        assert_eq!(n, 1);
        assert_eq!(out[0].speaker.as_deref(), Some("Speaker 1"), "5s vs 3s overlap");
    }

    #[test]
    fn a_lone_word_blip_does_not_carve_a_turn() {
        // Word 3 grazes B but is surrounded by A — smoothed back to A.
        let seg = wseg(0, 8_000, &["a", "b", "c", "d"]);
        let spans = vec![
            (0.0, 4.5, "SPEAKER_00".to_string()),
            (4.5, 6.5, "SPEAKER_01".to_string()), // only word index 2 (4-6s) lands here
            (6.5, 8.0, "SPEAKER_00".to_string()),
        ];
        let (out, _) = assign_speakers_splitting(vec![seg], &spans);
        assert_eq!(out.len(), 1, "single-word flip smoothed away");
        assert_eq!(out[0].speaker.as_deref(), Some("Speaker 1"));
    }
}
