//! Mel-feature extractor for speaker recognition.
//!
//! Given mono 16 kHz PCM, return a 64-dim log-mel feature vector. This
//! is a deliberately simple approach — averaged log-mel-energies, no
//! deltas, no PLDA backend. It's enough to distinguish 2-4 speakers in
//! a single meeting; better-quality embeddings can be swapped in later
//! behind the same `extract_mel_features` interface.

use realfft::RealFftPlanner;

pub const MEL_BINS: usize = 64;
pub const SAMPLE_RATE: u32 = 16_000;

/// Number of FFT input samples per frame. 25 ms at 16 kHz = 400 samples,
/// rounded up to the nearest power of two for FFT efficiency.
const FFT_SIZE: usize = 512;

/// Hop between successive frames in samples. 10 ms at 16 kHz = 160.
const HOP_SIZE: usize = 160;

/// Cosine similarity between two equal-length vectors. Returns 0.0 if
/// either input is the zero vector (no meaningful direction).
pub fn cosine_similarity(a: &[f32], b: &[f32]) -> f32 {
    debug_assert_eq!(a.len(), b.len());
    let mut dot = 0.0_f32;
    let mut na = 0.0_f32;
    let mut nb = 0.0_f32;
    for i in 0..a.len() {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    if na == 0.0 || nb == 0.0 {
        return 0.0;
    }
    dot / (na.sqrt() * nb.sqrt())
}

/// Map a linear-frequency Hz value to the mel scale.
fn hz_to_mel(hz: f32) -> f32 {
    2595.0 * (1.0 + hz / 700.0).log10()
}

/// Build a [MEL_BINS][FFT_SIZE/2 + 1] triangular filterbank covering
/// 0 Hz to Nyquist. Precomputed once per call to `extract_mel_features`.
fn mel_filterbank() -> Vec<Vec<f32>> {
    let n_freqs = FFT_SIZE / 2 + 1;
    let max_mel = hz_to_mel(SAMPLE_RATE as f32 / 2.0);
    let mel_points: Vec<f32> = (0..MEL_BINS + 2)
        .map(|i| (i as f32 / (MEL_BINS + 1) as f32) * max_mel)
        .collect();
    let bin_freqs: Vec<f32> = mel_points
        .iter()
        .map(|m| 700.0 * (10.0_f32.powf(*m / 2595.0) - 1.0))
        .collect();
    let bins: Vec<usize> = bin_freqs
        .iter()
        .map(|f| ((FFT_SIZE as f32 + 1.0) * f / SAMPLE_RATE as f32) as usize)
        .collect();
    let mut filters = vec![vec![0.0_f32; n_freqs]; MEL_BINS];
    for m in 0..MEL_BINS {
        let lo = bins[m];
        let mid = bins[m + 1];
        let hi = bins[m + 2];
        for k in lo..mid.min(n_freqs) {
            filters[m][k] = (k - lo) as f32 / (mid - lo).max(1) as f32;
        }
        for k in mid..hi.min(n_freqs) {
            filters[m][k] = (hi - k) as f32 / (hi - mid).max(1) as f32;
        }
    }
    filters
}

/// Time-averaged 64-dim log-mel vector for the input PCM. Input must be
/// mono 16 kHz f32 samples in [-1.0, 1.0]. Returns `None` if the clip is
/// shorter than one full frame.
pub fn extract_mel_features(pcm: &[f32]) -> Option<[f32; MEL_BINS]> {
    if pcm.len() < FFT_SIZE {
        return None;
    }

    let mut planner = RealFftPlanner::<f32>::new();
    let fft = planner.plan_fft_forward(FFT_SIZE);
    let mut input_buf = fft.make_input_vec();
    let mut output_buf = fft.make_output_vec();

    // Hann window — reduces spectral leakage.
    let hann: Vec<f32> = (0..FFT_SIZE)
        .map(|n| {
            0.5 - 0.5
                * (2.0 * std::f32::consts::PI * n as f32 / (FFT_SIZE - 1) as f32).cos()
        })
        .collect();

    let filterbank = mel_filterbank();
    let mut mel_sum = [0.0_f32; MEL_BINS];
    let mut frame_count = 0_usize;

    let mut frame_start = 0;
    while frame_start + FFT_SIZE <= pcm.len() {
        // Window the frame.
        for i in 0..FFT_SIZE {
            input_buf[i] = pcm[frame_start + i] * hann[i];
        }
        // FFT.
        fft.process(&mut input_buf, &mut output_buf).ok()?;

        // Power spectrum (|X|^2).
        let n_freqs = FFT_SIZE / 2 + 1;
        let mut power = vec![0.0_f32; n_freqs];
        for k in 0..n_freqs {
            power[k] = output_buf[k].re * output_buf[k].re
                + output_buf[k].im * output_buf[k].im;
        }

        // Project onto mel filterbank, take log.
        for m in 0..MEL_BINS {
            let mut energy = 0.0_f32;
            for k in 0..n_freqs {
                energy += power[k] * filterbank[m][k];
            }
            mel_sum[m] += (energy + 1e-10).ln();
        }
        frame_count += 1;
        frame_start += HOP_SIZE;
    }

    if frame_count == 0 {
        return None;
    }
    let mut out = [0.0_f32; MEL_BINS];
    for m in 0..MEL_BINS {
        out[m] = mel_sum[m] / frame_count as f32;
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn returns_none_for_too_short_clip() {
        let short = vec![0.0_f32; 100];
        assert!(extract_mel_features(&short).is_none());
    }

    #[test]
    fn returns_finite_vector_for_silence() {
        let silence = vec![0.0_f32; SAMPLE_RATE as usize]; // 1 second
        let features = extract_mel_features(&silence).unwrap();
        assert_eq!(features.len(), MEL_BINS);
        assert!(features.iter().all(|f| f.is_finite()));
    }

    #[test]
    fn distinguishes_two_different_tones() {
        // 200 Hz sine vs 1000 Hz sine should produce visibly different
        // mel vectors (cosine similarity meaningfully below 1.0).
        let sr = SAMPLE_RATE as f32;
        let dur = SAMPLE_RATE as usize;
        let low: Vec<f32> = (0..dur)
            .map(|i| (2.0 * std::f32::consts::PI * 200.0 * i as f32 / sr).sin())
            .collect();
        let high: Vec<f32> = (0..dur)
            .map(|i| (2.0 * std::f32::consts::PI * 1000.0 * i as f32 / sr).sin())
            .collect();

        let a = extract_mel_features(&low).unwrap();
        let b = extract_mel_features(&high).unwrap();
        let cos = cosine_similarity(&a, &b);
        assert!(
            cos < 0.97,
            "different tones should produce different mel vectors, got cos={}",
            cos
        );
    }
}
