//! Clip a time range out of a meeting's WAV recording, saving the slice
//! as its own WAV file. Used to produce voice-profile samples and the
//! "play this snippet" sources for the identify-speakers panel.

use anyhow::{anyhow, Result};
use hound::{SampleFormat, WavReader, WavSpec, WavWriter};
use std::path::Path;

/// Read the entire WAV at `path` into a mono f32 buffer.
/// Multi-channel inputs are downmixed by averaging.
pub fn load_wav_as_mono_f32(path: &Path) -> Result<(Vec<f32>, u32)> {
    let mut reader = WavReader::open(path)?;
    let spec = reader.spec();
    let channels = spec.channels as usize;
    let sample_rate = spec.sample_rate;

    let samples: Vec<f32> = match (spec.sample_format, spec.bits_per_sample) {
        (SampleFormat::Float, _) => reader.samples::<f32>().filter_map(|s| s.ok()).collect(),
        (SampleFormat::Int, 16) => reader
            .samples::<i16>()
            .filter_map(|s| s.ok())
            .map(|s| s as f32 / i16::MAX as f32)
            .collect(),
        (SampleFormat::Int, 32) => reader
            .samples::<i32>()
            .filter_map(|s| s.ok())
            .map(|s| s as f32 / i32::MAX as f32)
            .collect(),
        _ => return Err(anyhow!("unsupported wav format: {:?}", spec)),
    };

    if channels == 1 {
        return Ok((samples, sample_rate));
    }
    let mut mono = Vec::with_capacity(samples.len() / channels);
    for chunk in samples.chunks(channels) {
        let avg: f32 = chunk.iter().sum::<f32>() / channels as f32;
        mono.push(avg);
    }
    Ok((mono, sample_rate))
}

/// Clip `src` from `start_ms..end_ms` and write the slice to `dest` as
/// a mono 16 kHz 16-bit WAV (the canonical format for our voice samples).
pub fn clip_wav(src: &Path, dest: &Path, start_ms: u64, end_ms: u64) -> Result<()> {
    if end_ms <= start_ms {
        return Err(anyhow!("end_ms must be greater than start_ms"));
    }
    let (mono, sr) = load_wav_as_mono_f32(src)?;
    let from = ((start_ms as f64 / 1000.0) * sr as f64) as usize;
    let to = ((end_ms as f64 / 1000.0) * sr as f64).min(mono.len() as f64) as usize;
    if from >= to || from >= mono.len() {
        return Err(anyhow!("clip range outside the source audio"));
    }
    let slice = &mono[from..to];

    // Resample to 16 kHz if needed (mel extractor expects 16 kHz).
    let resampled = if sr == 16_000 {
        slice.to_vec()
    } else {
        resample_linear_public(slice, sr, 16_000)
    };

    let out_spec = WavSpec {
        channels: 1,
        sample_rate: 16_000,
        bits_per_sample: 16,
        sample_format: SampleFormat::Int,
    };
    let mut writer = WavWriter::create(dest, out_spec)?;
    for &x in &resampled {
        let clamped = x.clamp(-1.0, 1.0);
        writer.write_sample((clamped * i16::MAX as f32) as i16)?;
    }
    writer.finalize()?;
    Ok(())
}

/// Cheap linear-interpolation resampler. Speaker recognition is
/// frequency-tolerant enough that this is fine. For better quality we'd
/// reach for `rubato` (already a dep) but keep it simple here.
///
/// Exposed publicly so the voice-recognition commands can resample
/// in-memory PCM without writing an intermediate WAV file.
pub fn resample_linear_public(src: &[f32], src_sr: u32, dst_sr: u32) -> Vec<f32> {
    if src_sr == dst_sr {
        return src.to_vec();
    }
    let ratio = src_sr as f64 / dst_sr as f64;
    let dst_len = ((src.len() as f64 / ratio) as usize).max(1);
    let mut out = Vec::with_capacity(dst_len);
    for i in 0..dst_len {
        let s = i as f64 * ratio;
        let idx = s as usize;
        let frac = (s - idx as f64) as f32;
        let a = src[idx.min(src.len() - 1)];
        let b = src[(idx + 1).min(src.len() - 1)];
        out.push(a + (b - a) * frac);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use hound::{SampleFormat, WavSpec, WavWriter};
    use tempfile::tempdir;

    fn write_sine_wav(path: &Path, duration_secs: f32, freq: f32, sr: u32) {
        let spec = WavSpec {
            channels: 1,
            sample_rate: sr,
            bits_per_sample: 16,
            sample_format: SampleFormat::Int,
        };
        let mut w = WavWriter::create(path, spec).unwrap();
        let n = (duration_secs * sr as f32) as usize;
        for i in 0..n {
            let s = (2.0 * std::f32::consts::PI * freq * i as f32 / sr as f32).sin();
            w.write_sample((s * 32000.0) as i16).unwrap();
        }
        w.finalize().unwrap();
    }

    #[test]
    fn clip_wav_writes_a_valid_subrange() {
        let dir = tempdir().unwrap();
        let src = dir.path().join("src.wav");
        let dest = dir.path().join("clip.wav");
        write_sine_wav(&src, 3.0, 440.0, 16_000);

        clip_wav(&src, &dest, 500, 1500).unwrap();

        let (mono, sr) = load_wav_as_mono_f32(&dest).unwrap();
        assert_eq!(sr, 16_000);
        assert!(
            (mono.len() as i64 - 16_000).abs() <= 32,
            "expected ~1s of samples, got {}",
            mono.len()
        );
    }

    #[test]
    fn clip_wav_resamples_44k_source_to_16k() {
        let dir = tempdir().unwrap();
        let src = dir.path().join("src44k.wav");
        let dest = dir.path().join("clip.wav");
        write_sine_wav(&src, 2.0, 440.0, 44_100);

        clip_wav(&src, &dest, 200, 1200).unwrap();
        let (_, sr) = load_wav_as_mono_f32(&dest).unwrap();
        assert_eq!(sr, 16_000);
    }

    #[test]
    fn clip_wav_errors_when_range_is_inverted() {
        let dir = tempdir().unwrap();
        let src = dir.path().join("src.wav");
        let dest = dir.path().join("clip.wav");
        write_sine_wav(&src, 1.0, 440.0, 16_000);
        assert!(clip_wav(&src, &dest, 800, 200).is_err());
    }
}
