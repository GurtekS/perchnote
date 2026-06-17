//! Solo talk-time stats (plan v3 rank 8) — the one conversation metric the
//! research round found individuals actually use. Because Perchnote holds
//! the mic and system-audio streams SEPARATELY before mixdown, "you vs
//! them" needs no diarization, no attendees, no AI: per-100ms VAD on each
//! stream, accumulated live by the mixer.

/// RMS above this counts as voice activity for a 100ms window.
/// Voice-activity threshold shared with the capture supervisor.
pub const ACTIVE_RMS: f32 = 0.01;

/// A monologue tolerates gaps (their brief "mm-hm") up to this long.
const MONO_GAP_TOLERANCE_MS: u64 = 1_500;

pub fn window_rms(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    (samples.iter().map(|s| s * s).sum::<f32>() / samples.len() as f32).sqrt()
}

#[derive(Debug, Clone, Copy, Default)]
pub struct TalkTracker {
    /// Milliseconds the mic (you) carried voice.
    pub mic_ms: u64,
    /// Milliseconds system audio (them) carried voice.
    pub sys_ms: u64,
    /// Longest stretch of you talking without them (monologue alarm metric).
    pub longest_mono_ms: u64,
    cur_mono_ms: u64,
    mono_gap_ms: u64,
}

impl TalkTracker {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn feed(&mut self, mic_rms: f32, sys_rms: f32, window_ms: u64) {
        let mic = mic_rms > ACTIVE_RMS;
        let sys = sys_rms > ACTIVE_RMS;
        if mic {
            self.mic_ms += window_ms;
        }
        if sys {
            self.sys_ms += window_ms;
        }
        if mic && !sys {
            self.cur_mono_ms += window_ms + std::mem::take(&mut self.mono_gap_ms);
            self.longest_mono_ms = self.longest_mono_ms.max(self.cur_mono_ms);
        } else if self.cur_mono_ms > 0 && !sys {
            // You went quiet but they didn't take over — bridge short pauses.
            self.mono_gap_ms += window_ms;
            if self.mono_gap_ms > MONO_GAP_TOLERANCE_MS {
                self.cur_mono_ms = 0;
                self.mono_gap_ms = 0;
            }
        } else {
            // They spoke — the monologue is over.
            self.cur_mono_ms = 0;
            self.mono_gap_ms = 0;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const W: u64 = 100;

    #[test]
    fn accumulates_each_side_independently() {
        let mut t = TalkTracker::new();
        for _ in 0..10 {
            t.feed(0.1, 0.0, W); // you
        }
        for _ in 0..5 {
            t.feed(0.0, 0.1, W); // them
        }
        for _ in 0..3 {
            t.feed(0.1, 0.1, W); // crosstalk counts for both
        }
        assert_eq!(t.mic_ms, 1_300);
        assert_eq!(t.sys_ms, 800);
    }

    #[test]
    fn monologue_survives_short_pauses_but_ends_when_they_speak() {
        let mut t = TalkTracker::new();
        for _ in 0..20 {
            t.feed(0.1, 0.0, W); // 2s monologue
        }
        for _ in 0..10 {
            t.feed(0.0, 0.0, W); // 1s breath — bridged
        }
        for _ in 0..10 {
            t.feed(0.1, 0.0, W); // resumes: one continuous monologue
        }
        assert_eq!(t.longest_mono_ms, 4_000, "pause is bridged into the run");

        t.feed(0.0, 0.2, W); // they reply — run ends
        for _ in 0..5 {
            t.feed(0.1, 0.0, W);
        }
        assert_eq!(t.longest_mono_ms, 4_000, "new shorter run doesn't beat the old");
    }

    #[test]
    fn long_silence_ends_the_monologue() {
        let mut t = TalkTracker::new();
        for _ in 0..10 {
            t.feed(0.1, 0.0, W); // 1s
        }
        for _ in 0..20 {
            t.feed(0.0, 0.0, W); // 2s silence > tolerance
        }
        for _ in 0..5 {
            t.feed(0.1, 0.0, W); // fresh 0.5s run
        }
        assert_eq!(t.longest_mono_ms, 1_000);
    }

    #[test]
    fn silence_contributes_nothing() {
        let mut t = TalkTracker::new();
        for _ in 0..50 {
            t.feed(0.001, 0.002, W);
        }
        assert_eq!((t.mic_ms, t.sys_ms, t.longest_mono_ms), (0, 0, 0));
    }
}
