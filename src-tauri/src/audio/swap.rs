use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use super::ringbuf::AudioConsumer;

/// What the control plane hands the mixer when a capture source is rebuilt
/// (mic supervisor / system-tap rebuild — the capture-supervisor design).
pub struct SwapPayload {
    pub consumer: AudioConsumer,
    pub sample_rate: u32,
    /// Device/source label for logs and the "switched to X" toast.
    pub label: String,
}

/// One-deep mailbox for hot-swapping a capture source into the running
/// mixer. The supervisor posts; the mixer takes at the top of its loop.
/// Steady-state cost in the audio loop is one relaxed atomic load — the
/// Mutex is touched only when `seq` says a payload is waiting.
pub struct SourceSwap {
    seq: AtomicU64,
    slot: Mutex<Option<SwapPayload>>,
}

impl SourceSwap {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            seq: AtomicU64::new(0),
            slot: Mutex::new(None),
        })
    }

    /// Replaces any unconsumed payload (latest wins — a second rebuild
    /// before the mixer woke supersedes the first) and bumps `seq`.
    pub fn post(&self, payload: SwapPayload) {
        if let Ok(mut slot) = self.slot.lock() {
            *slot = Some(payload);
        }
        self.seq.fetch_add(1, Ordering::Release);
    }

    /// `last_seen` is the caller's local cursor; returns a payload only
    /// when something was posted since the cursor.
    pub fn take_if_new(&self, last_seen: &mut u64) -> Option<SwapPayload> {
        let cur = self.seq.load(Ordering::Acquire);
        if cur == *last_seen {
            return None;
        }
        *last_seen = cur;
        self.slot.lock().ok()?.take()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::ringbuf::create_audio_ring;

    fn payload(label: &str) -> SwapPayload {
        let (_prod, cons) = create_audio_ring(1024);
        SwapPayload { consumer: cons, sample_rate: 48_000, label: label.into() }
    }

    #[test]
    fn take_without_post_returns_none() {
        let swap = SourceSwap::new();
        let mut cursor = 0u64;
        assert!(swap.take_if_new(&mut cursor).is_none());
    }

    #[test]
    fn post_take_take_returns_exactly_once() {
        let swap = SourceSwap::new();
        let mut cursor = 0u64;
        swap.post(payload("a"));
        assert!(swap.take_if_new(&mut cursor).is_some());
        assert!(swap.take_if_new(&mut cursor).is_none());
    }

    #[test]
    fn double_post_latest_wins() {
        let swap = SourceSwap::new();
        let mut cursor = 0u64;
        swap.post(payload("first"));
        swap.post(payload("second"));
        let got = swap.take_if_new(&mut cursor).expect("payload");
        assert_eq!(got.label, "second");
        assert!(swap.take_if_new(&mut cursor).is_none());
    }

    #[test]
    fn cursors_are_independent_across_slots() {
        let mic = SourceSwap::new();
        let sys = SourceSwap::new();
        let (mut mic_cur, mut sys_cur) = (0u64, 0u64);
        mic.post(payload("mic"));
        assert!(sys.take_if_new(&mut sys_cur).is_none());
        assert!(mic.take_if_new(&mut mic_cur).is_some());
    }
}
