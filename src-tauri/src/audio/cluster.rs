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
//! - 64-dim mel is noticeably less discriminative than ECAPA-TDNN or
//!   3D-Speaker. The intra-meeting threshold (0.88) is therefore tuned
//!   conservatively — when in doubt, prefer over-splitting (one real
//!   speaker → two clusters) over under-splitting (two speakers merged).
//!   Over-splits are easy for the user to fix in the labeling UI; merges
//!   are not.

use std::path::Path;

use crate::audio::clip::{load_wav_as_mono_f32, resample_linear_public};
use crate::audio::mel::{cosine_similarity, extract_mel_features, MEL_BINS};
use crate::transcription::whisper::TranscriptSegment;

/// Skip segments shorter than this — a mel vector from <600 ms of audio is
/// dominated by the few phonemes that happened to be spoken, not the
/// speaker's voice.
const MIN_SEGMENT_MS: u64 = 600;

/// Cosine similarity threshold for merging a new segment into an existing
/// cluster. Higher = more likely to split a real speaker across clusters;
/// lower = more likely to merge two real speakers. 0.88 was picked to err
/// toward over-splitting given the limited discriminative power of 64-dim
/// time-averaged log-mel.
const MERGE_THRESHOLD: f32 = 0.88;

/// Exponential-moving-average weight when updating a cluster centroid with
/// a newly assigned segment's embedding. Lower = centroid is more stable
/// across the meeting; higher = adapts faster to drift.
const EMA_ALPHA: f32 = 0.25;

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

struct Cluster {
    centroid: [f32; MEL_BINS],
}

fn assign_clusters(segments: &[TranscriptSegment], pcm_16k: &[f32]) -> Vec<Option<usize>> {
    let mut clusters: Vec<Cluster> = Vec::new();
    let mut assignments: Vec<Option<usize>> = Vec::with_capacity(segments.len());

    for seg in segments {
        let assigned = embedding_for_segment(seg, pcm_16k)
            .map(|emb| assign_to_cluster(&emb, &mut clusters));
        assignments.push(assigned);
    }

    fill_unassigned_from_neighbors(&mut assignments);
    assignments
}

fn embedding_for_segment(seg: &TranscriptSegment, pcm_16k: &[f32]) -> Option<[f32; MEL_BINS]> {
    let dur_ms = seg.end_ms.saturating_sub(seg.start_ms);
    if dur_ms < MIN_SEGMENT_MS {
        return None;
    }
    let from = ((seg.start_ms as f64 / 1000.0) * 16_000.0) as usize;
    let to = ((seg.end_ms as f64 / 1000.0) * 16_000.0).min(pcm_16k.len() as f64) as usize;
    if from >= to || to > pcm_16k.len() {
        return None;
    }
    extract_mel_features(&pcm_16k[from..to])
}

fn assign_to_cluster(emb: &[f32; MEL_BINS], clusters: &mut Vec<Cluster>) -> usize {
    let best = clusters
        .iter()
        .enumerate()
        .map(|(i, c)| (i, cosine_similarity(emb, &c.centroid)))
        .max_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal));

    match best {
        Some((i, sim)) if sim >= MERGE_THRESHOLD => {
            for k in 0..MEL_BINS {
                clusters[i].centroid[k] =
                    (1.0 - EMA_ALPHA) * clusters[i].centroid[k] + EMA_ALPHA * emb[k];
            }
            i
        }
        _ => {
            clusters.push(Cluster { centroid: *emb });
            clusters.len() - 1
        }
    }
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
