//! Post-transcription speaker re-clustering.
//!
//! Whisper produces transcript segments with speaker labels assigned by a
//! crude energy-change heuristic in `transcription/whisper.rs` — that
//! heuristic cycles speaker IDs modulo 4 on every energy spike, so two
//! non-adjacent turns from the same person get different labels and a
//! single meeting routinely produces noisy splits.
//!
//! This module runs after the meeting WAV is finalized. It extracts a mel
//! embedding for each segment from the full recording, then clusters the
//! segments online by cosine similarity to running cluster centroids. The
//! result is stable per-meeting speaker IDs that correspond to one person
//! each.
//!
//! Tradeoffs vs a proper deep speaker-embedding model (future work):
//! - We reuse the existing 64-dim time-averaged log-mel vector, so there
//!   is no new dependency and no model download.
//! - Embeddings are z-normalized before comparison (`mel::znorm_embedding`),
//!   which makes cosine similarity measure spectral shape instead of being
//!   dominated by the shared silence-floor offset; the merge threshold is
//!   tuned empirically against the stress suite below.
//! - 64-dim mel is still less discriminative than ECAPA-TDNN or 3D-Speaker;
//!   swapping a stronger embedder in behind `extract_mel_features` remains
//!   the upgrade path.

use std::path::Path;

use crate::audio::clip::{load_wav_as_mono_f32, resample_linear_public};
use crate::audio::mel::{cosine_similarity, extract_mel_features, znorm_embedding, MEL_BINS};
use crate::transcription::whisper::TranscriptSegment;

/// Skip segments shorter than this — a mel vector from <600 ms of audio is
/// dominated by the few phonemes that happened to be spoken, not the
/// speaker's voice.
const MIN_SEGMENT_MS: u64 = 600;

/// Cosine similarity threshold for merging a new segment into an existing
/// cluster. Higher = more likely to split a real speaker across clusters;
/// lower = more likely to merge two real speakers.
///
/// Embeddings are z-normalized (see `znorm`) before clustering, so this
/// threshold lives in a space where similarities actually spread out:
/// without normalization every log-mel vector shares a large common
/// silence-floor offset (ln 1e-10 ≈ -23 in quiet bins) that dominates the
/// cosine, compressing all similarities toward 1.0 — distinct voices then
/// merge, while background noise (which lifts the floor) makes the same
/// voice look different. The value is tuned against the stress suite below.
const MERGE_THRESHOLD: f32 = 0.65;

/// Reassign `segments[*].speaker` based on mel-embedding clustering over
/// the meeting's WAV. Returns the number of clusters produced.
///
/// Segments shorter than `MIN_SEGMENT_MS` (and segments whose embedding
/// cannot be computed) inherit the speaker label of the closest preceding
/// labeled segment, falling back to the closest following one.
///
/// Existing labels are overwritten. This is intended to run before any
/// `speaker_labels` rows reference these keys — typically right after the
/// recording finishes, before the user opens the post-recording labeling
/// UI.
pub fn recluster_segments_by_embedding(
    segments: &mut [TranscriptSegment],
    wav_path: &Path,
) -> anyhow::Result<usize> {
    if segments.is_empty() {
        return Ok(0);
    }

    let (mono, sr) = load_wav_as_mono_f32(wav_path)?;
    let pcm_16k: Vec<f32> = if sr == 16_000 {
        mono
    } else {
        resample_linear_public(&mono, sr, 16_000)
    };

    let assignments = assign_clusters(segments, &pcm_16k);
    let cluster_count = assignments
        .iter()
        .filter_map(|a| *a)
        .max()
        .map(|m| m + 1)
        .unwrap_or(0);

    for (seg, asg) in segments.iter_mut().zip(assignments.iter()) {
        if let Some(i) = asg {
            seg.speaker = Some(format!("Speaker {}", i + 1));
        }
    }

    Ok(cluster_count)
}

/// Two-pass agglomerative clustering. Pass 1 embeds every segment; pass 2
/// repeatedly merges the closest pair of clusters (size-weighted centroids)
/// until no pair clears MERGE_THRESHOLD. Unlike the previous online
/// single-pass approach this is order-independent and immune to EMA drift —
/// on real conversations the online version let early mixed-voice chunks
/// drag one centroid into the middle and swallow both speakers.
fn assign_clusters(segments: &[TranscriptSegment], pcm_16k: &[f32]) -> Vec<Option<usize>> {
    let embeddings: Vec<Option<Vec<f32>>> = segments
        .iter()
        .map(|seg| embedding_for_segment(seg, pcm_16k))
        .collect();

    let embedded: Vec<usize> = embeddings
        .iter()
        .enumerate()
        .filter_map(|(i, e)| e.is_some().then_some(i))
        .collect();

    let mut members: Vec<Vec<usize>> = embedded.iter().map(|&i| vec![i]).collect();
    let mut centroids: Vec<Vec<f32>> = embedded
        .iter()
        .map(|&i| embeddings[i].clone().unwrap())
        .collect();

    loop {
        let mut best: Option<(usize, usize, f32)> = None;
        for a in 0..centroids.len() {
            for b in (a + 1)..centroids.len() {
                let sim = cluster_similarity(&centroids[a], &centroids[b]);
                if best.map(|(_, _, s)| sim > s).unwrap_or(true) {
                    best = Some((a, b, sim));
                }
            }
        }
        match best {
            Some((a, b, sim)) if sim >= MERGE_THRESHOLD => {
                let (na, nb) = (members[a].len() as f32, members[b].len() as f32);
                let last = centroids[a].len() - 1;
                for k in 0..last {
                    centroids[a][k] = (centroids[a][k] * na + centroids[b][k] * nb) / (na + nb);
                }
                // Pitch slot: weighted average over the voiced side(s) only.
                let (pa, pb) = (centroids[a][last], centroids[b][last]);
                centroids[a][last] = match (pa.is_finite(), pb.is_finite()) {
                    (true, true) => (pa * na + pb * nb) / (na + nb),
                    (true, false) => pa,
                    (false, true) => pb,
                    (false, false) => f32::NAN,
                };
                let moved = members.remove(b);
                centroids.remove(b);
                members[a].extend(moved);
            }
            _ => break,
        }
    }

    // Absorb tiny clusters — chunks containing both voices (or a noise
    // burst) often clear the threshold for no one and strand as phantom
    // "Speaker N"s. Anything under max(2, 5% of embedded segments) is
    // folded into its most similar surviving cluster.
    // Size-based pruning is statistical — below ~20 embedded segments a
    // "small" cluster is indistinguishable from a brief real speaker, so
    // skip absorption entirely for short meetings.
    let min_size = if embedded.len() >= 20 {
        ((embedded.len() as f32 * 0.05).ceil() as usize).max(2)
    } else {
        0
    };
    while min_size > 0 && members.len() > 1 {
        let Some(small) = (0..members.len())
            .filter(|&c| members[c].len() < min_size)
            .min_by_key(|&c| members[c].len())
        else {
            break;
        };
        let mut best: Option<(usize, f32)> = None;
        for other in 0..members.len() {
            if other == small {
                continue;
            }
            let s = cluster_similarity(&centroids[small], &centroids[other]);
            if best.map(|(_, bs)| s > bs).unwrap_or(true) {
                best = Some((other, s));
            }
        }
        let Some((target, _)) = best else { break };
        let (ns, nt) = (members[small].len() as f32, members[target].len() as f32);
        let last = centroids[target].len() - 1;
        for k in 0..last {
            centroids[target][k] =
                (centroids[target][k] * nt + centroids[small][k] * ns) / (ns + nt);
        }
        let (pt, ps) = (centroids[target][last], centroids[small][last]);
        centroids[target][last] = match (pt.is_finite(), ps.is_finite()) {
            (true, true) => (pt * nt + ps * ns) / (ns + nt),
            (true, false) => pt,
            (false, true) => ps,
            (false, false) => f32::NAN,
        };
        let moved = members.remove(small);
        centroids.remove(small);
        let t = if target > small { target - 1 } else { target };
        members[t].extend(moved);
    }

    // Stable naming: clusters ordered by first appearance in the meeting,
    // so the first voice heard is "Speaker 1".
    let mut order: Vec<usize> = (0..members.len()).collect();
    order.sort_by_key(|&c| members[c].iter().min().copied().unwrap_or(usize::MAX));

    let mut assignments: Vec<Option<usize>> = vec![None; segments.len()];
    for (rank, &c) in order.iter().enumerate() {
        for &seg_idx in &members[c] {
            assignments[seg_idx] = Some(rank);
        }
    }

    fill_unassigned_from_neighbors(&mut assignments);
    assignments
}

/// Sub-window size/hop for per-segment embeddings. Whisper emits fixed ~5s
/// chunks, and in a conversation one chunk regularly contains BOTH voices;
/// a full-chunk average then lands between the speakers and bridges their
/// clusters. Embedding 1s windows and taking the per-dim MEDIAN keeps the
/// chunk's majority voice as its signature instead of the blend.
const SUBWINDOW_SAMPLES: usize = 16_000; // 1s at 16kHz
const SUBWINDOW_HOP: usize = 8_000; // 0.5s

/// Similarity penalty per unit of normalized pitch difference. Pitch
/// (fundamental frequency) is the strongest cheap speaker-discriminative
/// cue, but appending it as cosine dims doesn't work — cosine rewards
/// same-sign values, so two different-but-both-high voices still correlate.
/// Subtracting an explicit |Δpitch| penalty from the mel cosine encodes
/// "different pitch → different person" directly: same voice with noise
/// keeps Δpitch ≈ 0 (no penalty), distinct voices get pushed apart.
const PITCH_PENALTY: f32 = 0.25;

fn embedding_for_segment(seg: &TranscriptSegment, pcm_16k: &[f32]) -> Option<Vec<f32>> {
    let dur_ms = seg.end_ms.saturating_sub(seg.start_ms);
    if dur_ms < MIN_SEGMENT_MS {
        return None;
    }
    let from = ((seg.start_ms as f64 / 1000.0) * 16_000.0) as usize;
    let to = ((seg.end_ms as f64 / 1000.0) * 16_000.0).min(pcm_16k.len() as f64) as usize;
    if from >= to || to > pcm_16k.len() {
        return None;
    }
    let slice = &pcm_16k[from..to];

    // Window mel embeddings (z-normed each — see `mel::znorm_embedding`),
    // plus an f0 estimate per window.
    let mut window_embs: Vec<[f32; MEL_BINS]> = Vec::new();
    let mut f0s: Vec<f32> = Vec::new();
    let mut start = 0usize;
    loop {
        let end = (start + SUBWINDOW_SAMPLES).min(slice.len());
        if end.saturating_sub(start) < SUBWINDOW_SAMPLES / 2 && !window_embs.is_empty() {
            break;
        }
        let win = &slice[start..end];
        if let Some(mut emb) = extract_mel_features(win) {
            znorm_embedding(&mut emb);
            window_embs.push(emb);
            if let Some(f0) = estimate_f0(win) {
                f0s.push(f0);
            }
        }
        if end == slice.len() {
            break;
        }
        start += SUBWINDOW_HOP;
    }
    if window_embs.is_empty() {
        return None;
    }

    // Per-dim median across windows → robust to minority-voice windows.
    let mut mel = [0.0f32; MEL_BINS];
    let mut scratch: Vec<f32> = Vec::with_capacity(window_embs.len());
    for (d, out) in mel.iter_mut().enumerate() {
        scratch.clear();
        scratch.extend(window_embs.iter().map(|w| w[d]));
        scratch.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        *out = scratch[scratch.len() / 2];
    }
    znorm_embedding(&mut mel);

    // Trailing pitch slot: normalized log median-f0 (≈±1 across typical
    // voices), NaN when the segment is unvoiced. Compared via an explicit
    // penalty in `cluster_similarity`, not via cosine.
    let mut out: Vec<f32> = mel.to_vec();
    if f0s.is_empty() {
        out.push(f32::NAN);
    } else {
        f0s.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let f0_med = f0s[f0s.len() / 2];
        out.push(((f0_med / 150.0).ln() / 0.35).clamp(-2.5, 2.5));
    }
    Some(out)
}

/// Mel-shape cosine with a pitch-difference penalty. The last element of
/// each embedding is the normalized pitch (NaN = unvoiced); everything
/// before it is the z-normed mel vector.
fn cluster_similarity(a: &[f32], b: &[f32]) -> f32 {
    let n = a.len();
    let cos = cosine_similarity(&a[..n - 1], &b[..n - 1]);
    let (pa, pb) = (a[n - 1], b[n - 1]);
    if pa.is_finite() && pb.is_finite() {
        cos - PITCH_PENALTY * (pa - pb).abs()
    } else {
        cos
    }
}

/// Fundamental-frequency estimate via normalized autocorrelation over a
/// 2048-sample slice from the window's center (128ms — several pitch
/// periods even at 50Hz). Returns None for unvoiced/quiet audio.
fn estimate_f0(window: &[f32]) -> Option<f32> {
    const N: usize = 2048;
    const MIN_LAG: usize = 40; // 400 Hz
    const MAX_LAG: usize = 320; // 50 Hz
    if window.len() < N {
        return None;
    }
    let mid = (window.len() - N) / 2;
    let frame = &window[mid..mid + N];
    let energy: f32 = frame.iter().map(|s| s * s).sum();
    if energy < 1e-3 {
        return None;
    }
    let mut best_lag = 0usize;
    let mut best_norm = 0.0f32;
    for lag in MIN_LAG..=MAX_LAG {
        let mut ac = 0.0f32;
        for i in 0..(N - lag) {
            ac += frame[i] * frame[i + lag];
        }
        let norm = ac / energy;
        if norm > best_norm {
            best_norm = norm;
            best_lag = lag;
        }
    }
    (best_norm > 0.30).then(|| 16_000.0 / best_lag as f32)
}

/// Segments too short to embed inherit from their nearest labeled neighbor
/// — preceding first, then following. Keeps short backchannels ("yeah",
/// "mhm") attached to the surrounding turn instead of dropping their
/// speaker label.
fn fill_unassigned_from_neighbors(assignments: &mut [Option<usize>]) {
    let len = assignments.len();
    for i in 0..len {
        if assignments[i].is_some() {
            continue;
        }
        let prev = (0..i).rev().find_map(|j| assignments[j]);
        let next = (i + 1..len).find_map(|j| assignments[j]);
        assignments[i] = prev.or(next);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use hound::{SampleFormat, WavSpec, WavWriter};
    use tempfile::tempdir;

    fn segment(start_ms: u64, end_ms: u64) -> TranscriptSegment {
        TranscriptSegment {
            text: "...".to_string(),
            start_ms,
            end_ms,
            speaker: Some("Speaker 1".to_string()),
            confidence: None,
            words: None,
            is_overlap: false,
            speaker_confidence: 0.0,
            highlighted: false,
        }
    }

    fn write_wav(path: &Path, samples: &[f32], sample_rate: u32) {
        let spec = WavSpec {
            channels: 1,
            sample_rate,
            bits_per_sample: 16,
            sample_format: SampleFormat::Int,
        };
        let mut writer = WavWriter::create(path, spec).unwrap();
        for &s in samples {
            let s16 = (s * i16::MAX as f32).clamp(i16::MIN as f32, i16::MAX as f32) as i16;
            writer.write_sample(s16).unwrap();
        }
        writer.finalize().unwrap();
    }

    fn sine(freq: f32, dur_secs: f32, sr: u32) -> Vec<f32> {
        let n = (dur_secs * sr as f32) as usize;
        (0..n)
            .map(|i| (2.0 * std::f32::consts::PI * freq * i as f32 / sr as f32).sin() * 0.3)
            .collect()
    }

    /// Synthesize a meeting with two distinct "voices" (200 Hz vs 1000 Hz
    /// sines) interleaved across four segments. Clustering should produce
    /// two clusters; segments 0+2 should land in one and 1+3 in the other.
    #[test]
    fn two_distinct_tones_produce_two_clusters() {
        let dir = tempdir().unwrap();
        let wav_path = dir.path().join("meeting.wav");

        let voice_a = sine(200.0, 1.0, 16_000);
        let voice_b = sine(1000.0, 1.0, 16_000);
        let mut pcm = Vec::new();
        pcm.extend_from_slice(&voice_a);
        pcm.extend_from_slice(&voice_b);
        pcm.extend_from_slice(&voice_a);
        pcm.extend_from_slice(&voice_b);
        write_wav(&wav_path, &pcm, 16_000);

        let mut segments = vec![
            segment(0, 1000),
            segment(1000, 2000),
            segment(2000, 3000),
            segment(3000, 4000),
        ];

        let n = recluster_segments_by_embedding(&mut segments, &wav_path).unwrap();
        assert_eq!(n, 2, "expected two clusters, got {}", n);
        assert_eq!(segments[0].speaker, segments[2].speaker);
        assert_eq!(segments[1].speaker, segments[3].speaker);
        assert_ne!(segments[0].speaker, segments[1].speaker);
    }

    #[test]
    fn identical_tones_collapse_to_one_cluster() {
        let dir = tempdir().unwrap();
        let wav_path = dir.path().join("meeting.wav");

        let voice = sine(440.0, 4.0, 16_000);
        write_wav(&wav_path, &voice, 16_000);

        let mut segments = vec![
            segment(0, 1000),
            segment(1000, 2000),
            segment(2000, 3000),
            segment(3000, 4000),
        ];

        let n = recluster_segments_by_embedding(&mut segments, &wav_path).unwrap();
        assert_eq!(n, 1);
        assert!(segments.iter().all(|s| s.speaker == segments[0].speaker));
    }

    #[test]
    fn short_segments_inherit_from_neighbors() {
        let dir = tempdir().unwrap();
        let wav_path = dir.path().join("meeting.wav");

        let voice_a = sine(200.0, 1.0, 16_000);
        let voice_b = sine(1000.0, 1.0, 16_000);
        let short = sine(200.0, 0.2, 16_000);
        let mut pcm = Vec::new();
        pcm.extend_from_slice(&voice_a);
        pcm.extend_from_slice(&short);
        pcm.extend_from_slice(&voice_b);
        write_wav(&wav_path, &pcm, 16_000);

        let mut segments = vec![
            segment(0, 1000),
            segment(1000, 1200), // too short to embed
            segment(1200, 2200),
        ];

        recluster_segments_by_embedding(&mut segments, &wav_path).unwrap();
        // The short segment should inherit from segment 0 (the preceding
        // labeled neighbor), not from segment 2.
        assert_eq!(segments[1].speaker, segments[0].speaker);
        assert_ne!(segments[1].speaker, segments[2].speaker);
    }

    // ─── Stress suite ─────────────────────────────────────────────────────
    // Voice-like signals instead of pure tones: a harmonic stack at a
    // fundamental f0 whose per-harmonic envelope varies per segment, which
    // simulates different phonemes from the same throat. This is the case
    // time-averaged log-mel is weakest at, so these tests pin down the
    // real-world behavior, not the easy sine case.

    /// Harmonic-stack "voice": fundamental f0 with `envelope` giving the
    /// relative amplitude of each harmonic, shaped by a speaker-specific
    /// spectral `brightness` tilt (real voices differ in vocal tract, not
    /// just pitch — two humans never share an identical formant envelope).
    fn voice_b(f0: f32, envelope: &[f32], brightness: f32, dur_secs: f32, sr: u32) -> Vec<f32> {
        let n = (dur_secs * sr as f32) as usize;
        (0..n)
            .map(|i| {
                let t = i as f32 / sr as f32;
                let mut s = 0.0_f32;
                for (h, &a) in envelope.iter().enumerate() {
                    let tilt = (h as f32 + 1.0).powf(-brightness);
                    s += a * tilt * (2.0 * std::f32::consts::PI * f0 * (h as f32 + 1.0) * t).sin();
                }
                s * 0.12
            })
            .collect()
    }

    fn voice(f0: f32, envelope: &[f32], dur_secs: f32, sr: u32) -> Vec<f32> {
        voice_b(f0, envelope, 0.6, dur_secs, sr)
    }

    /// Deterministic white noise (LCG — no rand dependency, reproducible).
    fn white_noise(n: usize, amp: f32, seed: u32) -> Vec<f32> {
        let mut x = seed;
        (0..n)
            .map(|_| {
                x = x.wrapping_mul(1664525).wrapping_add(1013904223);
                (((x >> 9) as f32 / (1 << 22) as f32) - 1.0) * amp
            })
            .collect()
    }

    // Distinct "phoneme" envelopes — same voice, different content.
    const PHONEMES: [[f32; 6]; 6] = [
        [1.0, 0.8, 0.30, 0.20, 0.10, 0.05],
        [1.0, 0.2, 0.90, 0.40, 0.05, 0.30],
        [0.8, 1.0, 0.10, 0.60, 0.30, 0.10],
        [1.0, 0.5, 0.50, 0.10, 0.40, 0.20],
        [0.9, 0.3, 0.70, 0.50, 0.20, 0.40],
        [1.0, 0.7, 0.20, 0.30, 0.50, 0.15],
    ];

    fn run_cluster(pcm: &[f32], seg_ms: u64, count: usize) -> (usize, Vec<Option<String>>) {
        let dir = tempdir().unwrap();
        let wav_path = dir.path().join("m.wav");
        write_wav(&wav_path, pcm, 16_000);
        let mut segments: Vec<TranscriptSegment> = (0..count as u64)
            .map(|i| segment(i * seg_ms, (i + 1) * seg_ms))
            .collect();
        let n = recluster_segments_by_embedding(&mut segments, &wav_path).unwrap();
        (n, segments.into_iter().map(|s| s.speaker).collect())
    }

    /// One speaker, six different "phoneme" mixes. The content varies but
    /// the voice doesn't — over-splitting here is the documented failure
    /// mode; more than 2 clusters for one voice is pathological.
    #[test]
    fn stress_same_voice_varying_content_does_not_oversplit() {
        let mut pcm = Vec::new();
        for env in &PHONEMES {
            pcm.extend(voice(140.0, env, 1.0, 16_000));
        }
        let (n, _) = run_cluster(&pcm, 1000, 6);
        eprintln!("[stress] same voice, 6 phoneme mixes → {} cluster(s)", n);
        assert!(n <= 2, "one voice split into {} clusters — pathological over-splitting", n);
    }

    /// Two speakers alternating turns with varying content. The suite's
    /// core promise: A-turns share a label, B-turns share a label, labels
    /// differ.
    #[test]
    fn stress_two_voices_alternating_with_varying_content() {
        let mut pcm = Vec::new();
        for i in 0..5 {
            pcm.extend(voice_b(110.0, &PHONEMES[i], 0.4, 1.0, 16_000));
            pcm.extend(voice_b(230.0, &PHONEMES[(i + 1) % 6], 1.1, 1.0, 16_000));
        }
        let (n, speakers) = run_cluster(&pcm, 1000, 10);
        eprintln!("[stress] 2 voices × 5 turns → {} cluster(s), labels {:?}", n, speakers);

        let a_labels: std::collections::HashSet<_> =
            speakers.iter().step_by(2).cloned().collect();
        let b_labels: std::collections::HashSet<_> =
            speakers.iter().skip(1).step_by(2).cloned().collect();
        assert!(
            a_labels.is_disjoint(&b_labels),
            "speaker A and B turns share labels: A={:?} B={:?}",
            a_labels, b_labels
        );
        assert!(n >= 2 && n <= 4, "expected ~2 clusters for 2 voices, got {}", n);
    }

    /// Same voice with and without background noise (≈12dB SNR) must not
    /// split into "clean me" and "noisy me".
    #[test]
    fn stress_noise_robustness_same_voice() {
        let mut pcm = Vec::new();
        for i in 0..2 {
            pcm.extend(voice(150.0, &PHONEMES[i], 1.0, 16_000));
        }
        for i in 2..4 {
            let clean = voice(150.0, &PHONEMES[i], 1.0, 16_000);
            let noise = white_noise(clean.len(), 0.03, 7 + i as u32);
            pcm.extend(clean.iter().zip(noise).map(|(s, nz)| s + nz));
        }
        let (n, speakers) = run_cluster(&pcm, 1000, 4);
        eprintln!("[stress] clean+noisy same voice → {} cluster(s), {:?}", n, speakers);
        assert_eq!(n, 1, "background noise split one voice into {} clusters", n);
    }

    /// Six speakers, two non-adjacent turns each. Measures both separation
    /// (distinct voices get distinct labels) and consistency (the same
    /// voice's two turns reunite).
    #[test]
    fn stress_six_speakers_two_turns_each() {
        let f0s = [100.0_f32, 140.0, 185.0, 240.0, 310.0, 400.0];
        // Distinct vocal-tract brightness per speaker, like real voices.
        let tilts = [0.25_f32, 0.5, 0.75, 1.0, 1.25, 1.5];
        let mut pcm = Vec::new();
        // Round 1: each speaker once; round 2: each again with new content.
        for (i, f0) in f0s.iter().enumerate() {
            pcm.extend(voice_b(*f0, &PHONEMES[i % 6], tilts[i], 1.0, 16_000));
        }
        for (i, f0) in f0s.iter().enumerate() {
            pcm.extend(voice_b(*f0, &PHONEMES[(i + 3) % 6], tilts[i], 1.0, 16_000));
        }
        let (n, speakers) = run_cluster(&pcm, 1000, 12);
        let consistent = (0..6)
            .filter(|&i| speakers[i] == speakers[i + 6])
            .count();
        let distinct: std::collections::HashSet<_> =
            speakers[..6].iter().cloned().collect();
        eprintln!(
            "[stress] 6 speakers × 2 turns → {} clusters, {}/6 voices re-identified, {}/6 distinct in round 1",
            n, consistent, distinct.len()
        );
        assert!(
            consistent >= 4,
            "only {}/6 voices got the same label on their second turn",
            consistent
        );
        assert!(
            distinct.len() >= 4,
            "only {}/6 distinct voices separated in round one",
            distinct.len()
        );
    }

    /// A speaker whose pitch drifts upward across the meeting (fatigue,
    /// excitement). The EMA centroid should track the drift.
    #[test]
    fn stress_gradual_pitch_drift_tracks_one_speaker() {
        let mut pcm = Vec::new();
        for i in 0..12 {
            let f0 = 140.0 + i as f32 * 2.0; // 140 → 162 Hz across 12 turns
            pcm.extend(voice(f0, &PHONEMES[i % 6], 1.0, 16_000));
        }
        let (n, _) = run_cluster(&pcm, 1000, 12);
        eprintln!("[stress] pitch drift 140→162Hz over 12 turns → {} cluster(s)", n);
        assert!(n <= 2, "gradual drift fragmented one voice into {} clusters", n);
    }

    /// Pure silence between two speakers: silence yields a finite mel
    /// vector, so it CAN form its own cluster — this documents that VAD
    /// is the transcriber's job, not the clusterer's.
    #[test]
    fn stress_silent_segment_behavior_documented() {
        let mut pcm = Vec::new();
        pcm.extend(voice(120.0, &PHONEMES[0], 1.0, 16_000));
        pcm.extend(std::iter::repeat(0.0_f32).take(16_000));
        pcm.extend(voice(120.0, &PHONEMES[1], 1.0, 16_000));
        let (n, speakers) = run_cluster(&pcm, 1000, 3);
        eprintln!("[stress] voice|silence|voice → {} cluster(s), {:?}", n, speakers);
        // The two voice turns must reunite regardless of what silence does.
        assert_eq!(speakers[0], speakers[2], "silence broke same-voice continuity");
    }

    /// Native 44.1kHz recording exercises the resample path end-to-end.
    #[test]
    fn stress_44k1_wav_resample_path() {
        let sr = 44_100;
        let mut pcm = Vec::new();
        pcm.extend(voice_b(110.0, &PHONEMES[0], 0.4, 1.0, sr));
        pcm.extend(voice_b(240.0, &PHONEMES[1], 1.1, 1.0, sr));
        pcm.extend(voice_b(110.0, &PHONEMES[2], 0.4, 1.0, sr));
        pcm.extend(voice_b(240.0, &PHONEMES[3], 1.1, 1.0, sr));

        let dir = tempdir().unwrap();
        let wav_path = dir.path().join("m44.wav");
        write_wav(&wav_path, &pcm, sr);
        let mut segments = vec![
            segment(0, 1000),
            segment(1000, 2000),
            segment(2000, 3000),
            segment(3000, 4000),
        ];
        let n = recluster_segments_by_embedding(&mut segments, &wav_path).unwrap();
        eprintln!("[stress] 44.1kHz two voices → {} cluster(s)", n);
        assert_eq!(segments[0].speaker, segments[2].speaker);
        assert_eq!(segments[1].speaker, segments[3].speaker);
        assert_ne!(segments[0].speaker, segments[1].speaker);
        assert!(n >= 2);
    }

    /// Offline diagnostic against a REAL meeting recording. Ignored by
    /// default; run with:
    ///   PERCH_WAV=/path/to/x.wav PERCH_SEGMENTS=/path/to/segs.json \
    ///   cargo test real_meeting_diagnostic -- --ignored --nocapture
    /// Prints cluster structure so threshold/algorithm changes can be
    /// evaluated against real conversations, not just synthetic voices.
    #[test]
    #[ignore]
    fn real_meeting_diagnostic() {
        let wav = std::env::var("PERCH_WAV").expect("set PERCH_WAV");
        let segs_path = std::env::var("PERCH_SEGMENTS").expect("set PERCH_SEGMENTS");
        let json = std::fs::read_to_string(&segs_path).unwrap();
        let mut segments: Vec<TranscriptSegment> = serde_json::from_str(&json).unwrap();

        let n = recluster_segments_by_embedding(&mut segments, Path::new(&wav)).unwrap();

        use std::collections::HashMap;
        let mut counts: HashMap<String, usize> = HashMap::new();
        for s in &segments {
            *counts.entry(s.speaker.clone().unwrap_or_default()).or_default() += 1;
        }
        let mut runs: Vec<(String, usize)> = Vec::new();
        for s in &segments {
            let k = s.speaker.clone().unwrap_or_default();
            match runs.last_mut() {
                Some((last, c)) if *last == k => *c += 1,
                _ => runs.push((k, 1)),
            }
        }
        let changes = runs.len().saturating_sub(1);
        eprintln!("[real] clusters={} distribution={:?}", n, counts);
        eprintln!("[real] turn changes={} runs(first 40)={:?}", changes, &runs[..runs.len().min(40)]);
    }

    #[test]
    fn empty_segments_returns_zero() {
        let dir = tempdir().unwrap();
        let wav_path = dir.path().join("meeting.wav");
        write_wav(&wav_path, &sine(440.0, 1.0, 16_000), 16_000);

        let mut segments: Vec<TranscriptSegment> = vec![];
        let n = recluster_segments_by_embedding(&mut segments, &wav_path).unwrap();
        assert_eq!(n, 0);
    }

    #[test]
    fn all_segments_too_short_returns_zero_and_leaves_unassigned() {
        let dir = tempdir().unwrap();
        let wav_path = dir.path().join("meeting.wav");
        write_wav(&wav_path, &sine(440.0, 1.0, 16_000), 16_000);

        let mut segments = vec![segment(0, 100), segment(100, 200)];
        let original_speakers: Vec<_> = segments.iter().map(|s| s.speaker.clone()).collect();
        let n = recluster_segments_by_embedding(&mut segments, &wav_path).unwrap();
        assert_eq!(n, 0);
        let after: Vec<_> = segments.iter().map(|s| s.speaker.clone()).collect();
        assert_eq!(after, original_speakers, "no embeddings → no reassignment");
    }
}
