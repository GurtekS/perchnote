//! Capture-supervisor decision policies (the capture-supervisor design items 11 & 12).
//!
//! Pure logic only — no I/O, no atomics, no tauri. The supervisor task feeds
//! each policy one observation snapshot per poll (`tick`) and receives a
//! health verdict for the UI plus a "launch a rebuild now" directive. Around
//! an actual rebuild the caller brackets reality with `rebuild_started` /
//! `rebuild_finished`; `tick` itself never assumes the launch happened.
//!
//! Rebuild attempts are rationed by [`RebuildBudget`]: three attempts on an
//! escalating 10s → 30s → 60s cooldown ladder, with the counter restored only
//! after five minutes of continuously healthy ticks. Worst case during flat
//! audio is therefore ≤ 3 sub-second capture gaps per session.

/// Maximum rebuild attempts before the budget locks until a healthy reset.
pub const MAX_REBUILD_ATTEMPTS: u32 = 3;
/// Cooldown after the Nth attempt before the next may launch (ladder
/// saturates at the last rung).
pub const REBUILD_COOLDOWNS_MS: [u64; 3] = [10_000, 30_000, 60_000];
/// Continuous healthy time that resets the attempt counter (5 minutes).
pub const HEALTHY_RESET_MS: u64 = 300_000;

/// Mic stall that triggers a (quiet) rebuild attempt.
pub const MIC_STALL_REBUILD_MS: u64 = 2_000;
/// Mic stall that surfaces the Stalled banner (matches the existing UI threshold).
pub const MIC_STALL_WARN_MS: u64 = 5_000;

/// Mic voice younger than this counts as conversation evidence for the tap.
pub const VOICE_RECENT_MS: u64 = 15_000;
/// System zero-run (RMS exactly 0.0) that warns — only with evidence.
///
/// Tuned UP from 10s after a live false positive: call apps emit exact
/// digital zeros between remote utterances, so "you spoke recently and
/// the system is flat" describes every ordinary lull — presenting, a
/// question hanging, a short pause. A broken-but-running tap is flat
/// FOREVER; duration at conversational scale is the only honest
/// discriminator, so the banner waits out normal quiet.
pub const SYS_ZERO_WARN_MS: u64 = 45_000;
/// System zero-run that triggers a rebuild — only with evidence. A
/// rebuild briefly interrupts a healthy tap, so it demands much stronger
/// evidence than the banner: ninety seconds dead-flat while the user
/// keeps talking. (Stall thresholds below stay tight — an IOProc that
/// stops delivering ANY data, zeros included, is a hard failure with no
/// quiet-call false positive.)
pub const SYS_ZERO_REBUILD_MS: u64 = 90_000;
/// System stall (ring empty) that warns — unconditional.
pub const SYS_STALL_WARN_MS: u64 = 10_000;
/// System stall that triggers a rebuild — unconditional.
pub const SYS_STALL_REBUILD_MS: u64 = 12_000;

/// Rations rebuild attempts: 3 max, cooldowns 10s/30s/60s between attempts,
/// and a reset of the attempt counter after 5 minutes continuously healthy.
///
/// Time is a caller-supplied monotonic millisecond clock.
#[derive(Debug)]
pub struct RebuildBudget {
    /// Attempts recorded since the last healthy reset.
    attempts: u32,
    /// Clock of the most recent `record_attempt`.
    last_attempt_ms: u64,
    /// Start of the current unbroken healthy streak, if one is running.
    healthy_since_ms: Option<u64>,
}

/// Cooldown owed after `attempts_made` attempts (1-based; saturates at 60s).
fn cooldown_after_attempts(attempts_made: u32) -> u64 {
    let idx = (attempts_made.saturating_sub(1) as usize).min(REBUILD_COOLDOWNS_MS.len() - 1);
    REBUILD_COOLDOWNS_MS[idx]
}

impl RebuildBudget {
    pub fn new() -> Self {
        Self {
            attempts: 0,
            last_attempt_ms: 0,
            healthy_since_ms: None,
        }
    }

    /// True if an attempt may launch now: under the cap and past the cooldown
    /// owed by the previous attempt.
    pub fn may_attempt(&self, now_ms: u64) -> bool {
        if self.attempts >= MAX_REBUILD_ATTEMPTS {
            return false;
        }
        if self.attempts == 0 {
            return true;
        }
        now_ms.saturating_sub(self.last_attempt_ms) >= cooldown_after_attempts(self.attempts)
    }

    /// Charge one attempt. Also breaks any healthy streak — attempting a
    /// rebuild is proof the capture was not healthy.
    pub fn record_attempt(&mut self, now_ms: u64) {
        self.attempts = self.attempts.saturating_add(1);
        self.last_attempt_ms = now_ms;
        self.healthy_since_ms = None;
    }

    /// Note one healthy observation. Once the streak spans
    /// [`HEALTHY_RESET_MS`] without interruption, the attempt counter resets.
    pub fn record_healthy(&mut self, now_ms: u64) {
        let since = *self.healthy_since_ms.get_or_insert(now_ms);
        if now_ms.saturating_sub(since) >= HEALTHY_RESET_MS {
            self.attempts = 0;
        }
    }

    /// Interrupt the healthy streak ("continuously" means exactly that).
    /// Module-internal: policies call this on every non-healthy tick.
    fn break_healthy_streak(&mut self) {
        self.healthy_since_ms = None;
    }
}

impl Default for RebuildBudget {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------
// Microphone (item 12)
// ---------------------------------------------------------------------------

/// One poll's mic observations, read from the capture atomics by the caller.
#[derive(Debug, Clone, Copy)]
pub struct MicObs {
    /// Milliseconds since the mic ring last produced data.
    pub stall_ms: u64,
    /// The cpal error callback fired for the current stream.
    pub stream_error: bool,
    /// Recording is paused (rebuilds are pointless and counters are reset).
    pub paused: bool,
}

/// Mic health for the `audio-health` event (`as_str` is the wire name).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MicHealth {
    Ok,
    Stalled,
    Rebuilding,
}

impl MicHealth {
    pub fn as_str(self) -> &'static str {
        match self {
            MicHealth::Ok => "ok",
            MicHealth::Stalled => "stalled",
            MicHealth::Rebuilding => "rebuilding",
        }
    }
}

/// Mic supervisor policy. Trigger: `stall_ms >= 2s || stream_error`, gated on
/// `!paused` and the budget. The banner only turns Stalled at 5s, so a
/// healthy rebuild path recovers before the user ever sees a warning.
#[derive(Debug, Default)]
pub struct MicPolicy {
    budget: RebuildBudget,
    rebuilding: bool,
}

impl MicPolicy {
    pub fn new() -> Self {
        Self::default()
    }

    /// Evaluate one poll. Returns `(health, launch_rebuild)`. When the launch
    /// directive is `true` the attempt is already charged to the budget and
    /// the returned health is `Rebuilding`; the caller should start the
    /// rebuild promptly and bracket it with `rebuild_started` /
    /// `rebuild_finished`.
    pub fn tick(&mut self, now_ms: u64, obs: &MicObs) -> (MicHealth, bool) {
        if self.rebuilding {
            self.budget.break_healthy_streak();
            return (MicHealth::Rebuilding, false);
        }

        let trigger = obs.stream_error || obs.stall_ms >= MIC_STALL_REBUILD_MS;
        if trigger && !obs.paused && self.budget.may_attempt(now_ms) {
            self.budget.record_attempt(now_ms);
            return (MicHealth::Rebuilding, true);
        }

        let health = if obs.stall_ms >= MIC_STALL_WARN_MS {
            MicHealth::Stalled
        } else {
            MicHealth::Ok
        };
        if health == MicHealth::Ok && !trigger {
            self.budget.record_healthy(now_ms);
        } else {
            self.budget.break_healthy_streak();
        }
        (health, false)
    }

    /// The caller actually launched the rebuild returned by `tick`.
    pub fn rebuild_started(&mut self) {
        self.rebuilding = true;
    }

    /// The rebuild completed. `recovered` is informational — budget effects
    /// flow from subsequent ticks (an Ok tick starts the healthy streak; a
    /// still-stalled tick retries on the cooldown ladder).
    pub fn rebuild_finished(&mut self, _recovered: bool) {
        self.rebuilding = false;
    }
}

// ---------------------------------------------------------------------------
// System tap (item 11)
// ---------------------------------------------------------------------------

/// One poll's system-tap observations.
#[derive(Debug, Clone, Copy)]
pub struct SysObs {
    /// Milliseconds since the tap ring last produced data (IOProc dead).
    pub stall_ms: u64,
    /// Milliseconds of bit-exact-zero audio (tap delivering but broken).
    pub zero_run_ms: u64,
    /// Milliseconds since the local mic last heard voice.
    pub voice_ago_ms: u64,
    /// A known call app currently holds the microphone.
    pub call_app_active: bool,
    /// Screen-recording / system-audio permission still granted.
    pub permission: bool,
    /// Recording is paused.
    pub paused: bool,
}

/// System-tap health for the `audio-health` event (`as_str` is the wire name).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SysHealth {
    Ok,
    Silent,
    Stalled,
    Rebuilding,
    PermissionLost,
}

impl SysHealth {
    pub fn as_str(self) -> &'static str {
        match self {
            SysHealth::Ok => "ok",
            SysHealth::Silent => "silent",
            SysHealth::Stalled => "stalled",
            SysHealth::Rebuilding => "rebuilding",
            SysHealth::PermissionLost => "permission_lost",
        }
    }
}

/// System-tap supervisor policy.
///
/// A zero-run is ambiguous (flat audio is legal), so it only ever warns or
/// rebuilds with conversation evidence: a call app holding the mic, or local
/// voice within [`VOICE_RECENT_MS`]. A stall is unambiguous (the IOProc fires
/// on the device clock regardless of content) and acts unconditionally.
/// Without permission the tap is unfixable: health is `PermissionLost` and a
/// rebuild never launches.
#[derive(Debug, Default)]
pub struct SysTapPolicy {
    budget: RebuildBudget,
    rebuilding: bool,
}

impl SysTapPolicy {
    pub fn new() -> Self {
        Self::default()
    }

    /// Evaluate one poll. Same contract as [`MicPolicy::tick`].
    pub fn tick(&mut self, now_ms: u64, obs: &SysObs) -> (SysHealth, bool) {
        if self.rebuilding {
            self.budget.break_healthy_streak();
            return (SysHealth::Rebuilding, false);
        }
        if !obs.permission {
            self.budget.break_healthy_streak();
            return (SysHealth::PermissionLost, false);
        }

        let evidence = obs.call_app_active || obs.voice_ago_ms < VOICE_RECENT_MS;
        let trigger = (obs.zero_run_ms >= SYS_ZERO_REBUILD_MS && evidence)
            || obs.stall_ms >= SYS_STALL_REBUILD_MS;
        if trigger && !obs.paused && self.budget.may_attempt(now_ms) {
            self.budget.record_attempt(now_ms);
            return (SysHealth::Rebuilding, true);
        }

        // Stalled outranks Silent: no data at all is the stronger signal.
        let health = if obs.stall_ms >= SYS_STALL_WARN_MS {
            SysHealth::Stalled
        } else if obs.zero_run_ms >= SYS_ZERO_WARN_MS && evidence {
            SysHealth::Silent
        } else {
            SysHealth::Ok
        };
        if health == SysHealth::Ok && !trigger {
            self.budget.record_healthy(now_ms);
        } else {
            self.budget.break_healthy_streak();
        }
        (health, false)
    }

    /// The caller actually launched the rebuild returned by `tick`.
    pub fn rebuild_started(&mut self) {
        self.rebuilding = true;
    }

    /// The rebuild completed. See [`MicPolicy::rebuild_finished`].
    pub fn rebuild_finished(&mut self, _recovered: bool) {
        self.rebuilding = false;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mic(stall_ms: u64) -> MicObs {
        MicObs {
            stall_ms,
            stream_error: false,
            paused: false,
        }
    }

    /// Healthy tap baseline: customize with struct-update syntax.
    fn sys() -> SysObs {
        SysObs {
            stall_ms: 0,
            zero_run_ms: 0,
            voice_ago_ms: u64::MAX,
            call_app_active: false,
            permission: true,
            paused: false,
        }
    }

    /// Burn all three mic attempts with failed rebuilds at t = 0/10s/40s
    /// (the fastest the cooldown ladder allows). Returns the last attempt time.
    fn exhaust_mic_budget(p: &mut MicPolicy) -> u64 {
        for t in [0u64, 10_000, 40_000] {
            assert_eq!(p.tick(t, &mic(8_000)), (MicHealth::Rebuilding, true));
            p.rebuild_started();
            p.rebuild_finished(false);
        }
        40_000
    }

    /// Same for the system tap, via the unconditional stall path.
    fn exhaust_sys_budget(p: &mut SysTapPolicy) -> u64 {
        for t in [0u64, 10_000, 40_000] {
            let obs = SysObs {
                stall_ms: 20_000,
                ..sys()
            };
            assert_eq!(p.tick(t, &obs), (SysHealth::Rebuilding, true));
            p.rebuild_started();
            p.rebuild_finished(false);
        }
        40_000
    }

    // -- RebuildBudget ------------------------------------------------------

    #[test]
    fn budget_first_attempt_is_immediate() {
        let b = RebuildBudget::new();
        assert!(b.may_attempt(0));
        assert!(b.may_attempt(u64::MAX));
    }

    #[test]
    fn budget_cooldown_ladder_values_are_10_30_60() {
        assert_eq!(cooldown_after_attempts(1), 10_000);
        assert_eq!(cooldown_after_attempts(2), 30_000);
        assert_eq!(cooldown_after_attempts(3), 60_000);
        // Ladder saturates at the last rung (defensive; the cap blocks first).
        assert_eq!(cooldown_after_attempts(9), 60_000);
    }

    #[test]
    fn budget_cooldowns_gate_successive_attempts() {
        let mut b = RebuildBudget::new();
        b.record_attempt(0);
        assert!(!b.may_attempt(0), "no instant retry");
        assert!(!b.may_attempt(9_999));
        assert!(b.may_attempt(10_000), "second attempt after 10s");

        b.record_attempt(10_000);
        assert!(!b.may_attempt(39_999));
        assert!(b.may_attempt(40_000), "third attempt after 30s more");
    }

    #[test]
    fn budget_caps_at_three_attempts() {
        let mut b = RebuildBudget::new();
        b.record_attempt(0);
        b.record_attempt(10_000);
        b.record_attempt(40_000);
        // The cap dominates: even past the 60s tail rung, no fourth attempt.
        assert!(!b.may_attempt(100_000));
        assert!(!b.may_attempt(40_000 + 60_000));
        assert!(!b.may_attempt(u64::MAX));
    }

    #[test]
    fn budget_resets_after_five_minutes_continuously_healthy() {
        let mut b = RebuildBudget::new();
        b.record_attempt(0);
        b.record_attempt(10_000);
        b.record_attempt(40_000);
        assert!(!b.may_attempt(50_000));

        b.record_healthy(50_000); // streak starts here
        b.record_healthy(200_000);
        b.record_healthy(349_999); // 299_999ms — one short
        assert!(!b.may_attempt(349_999));
        b.record_healthy(350_000); // exactly 300_000ms
        assert!(b.may_attempt(350_000), "5 min healthy resets the counter");
    }

    #[test]
    fn budget_streak_must_be_continuous_to_reset() {
        let mut b = RebuildBudget::new();
        b.record_attempt(0);
        b.record_attempt(10_000);
        b.record_attempt(40_000);

        b.record_healthy(50_000);
        b.record_healthy(349_999);
        b.break_healthy_streak(); // blip at ~299.9s of health
        b.record_healthy(350_000); // clock restarts here
        b.record_healthy(649_999);
        assert!(!b.may_attempt(649_999), "two 299.9s streaks never reset");
        b.record_healthy(650_000);
        assert!(b.may_attempt(650_000));
    }

    #[test]
    fn budget_attempt_breaks_the_healthy_streak() {
        let mut b = RebuildBudget::new();
        b.record_healthy(0);
        b.record_attempt(100_000);
        b.record_attempt(110_000);
        b.record_attempt(140_000);
        // Streak restarted at the attempts: health accrued before them is gone.
        b.record_healthy(400_000); // 260s after last attempt — streak starts here
        assert!(!b.may_attempt(400_000));
        b.record_healthy(699_999);
        assert!(!b.may_attempt(699_999));
        b.record_healthy(700_000);
        assert!(b.may_attempt(700_000));
    }

    // -- MicPolicy ----------------------------------------------------------

    #[test]
    fn mic_ok_below_all_thresholds() {
        let mut p = MicPolicy::new();
        assert_eq!(p.tick(0, &mic(0)), (MicHealth::Ok, false));
        assert_eq!(p.tick(1_000, &mic(1_999)), (MicHealth::Ok, false));
    }

    #[test]
    fn mic_stall_at_2s_launches_rebuild() {
        let mut p = MicPolicy::new();
        assert_eq!(p.tick(0, &mic(1_999)), (MicHealth::Ok, false));
        assert_eq!(p.tick(1_000, &mic(2_000)), (MicHealth::Rebuilding, true));
    }

    #[test]
    fn mic_stream_error_is_a_fast_path() {
        let mut p = MicPolicy::new();
        let obs = MicObs {
            stream_error: true,
            ..mic(0)
        };
        // No stall needed: the error callback already proved the stream died.
        assert_eq!(p.tick(0, &obs), (MicHealth::Rebuilding, true));
    }

    #[test]
    fn mic_paused_suppresses_rebuild_but_not_banner() {
        let mut p = MicPolicy::new();
        let paused = |stall_ms, stream_error| MicObs {
            stall_ms,
            stream_error,
            paused: true,
        };
        assert_eq!(p.tick(0, &paused(60_000, false)), (MicHealth::Stalled, false));
        assert_eq!(p.tick(1, &paused(0, true)), (MicHealth::Ok, false));
        assert_eq!(p.tick(2, &paused(4_999, false)), (MicHealth::Ok, false));
        assert_eq!(p.tick(3, &paused(5_000, false)), (MicHealth::Stalled, false));
    }

    #[test]
    fn mic_warns_at_5s_when_rebuild_is_suppressed() {
        let mut p = MicPolicy::new();
        let t = exhaust_mic_budget(&mut p);
        // Budget gone: trigger-level stalls surface by the banner rule only.
        assert_eq!(p.tick(t + 1, &mic(4_999)), (MicHealth::Ok, false));
        assert_eq!(p.tick(t + 2, &mic(5_000)), (MicHealth::Stalled, false));
    }

    #[test]
    fn mic_reports_rebuilding_while_in_flight_and_never_double_launches() {
        let mut p = MicPolicy::new();
        assert_eq!(p.tick(0, &mic(3_000)), (MicHealth::Rebuilding, true));
        p.rebuild_started();
        for t in [100u64, 200, 60_000] {
            assert_eq!(p.tick(t, &mic(60_000)), (MicHealth::Rebuilding, false));
        }
        p.rebuild_finished(true);
        assert_eq!(p.tick(60_100, &mic(0)), (MicHealth::Ok, false));
    }

    #[test]
    fn mic_failed_rebuilds_retry_on_the_cooldown_ladder_then_cap() {
        let mut p = MicPolicy::new();
        assert_eq!(p.tick(0, &mic(8_000)), (MicHealth::Rebuilding, true));
        p.rebuild_started();
        p.rebuild_finished(false);

        // 10s rung: still broken, but too soon — banner shows the truth.
        assert_eq!(p.tick(9_999, &mic(8_000)), (MicHealth::Stalled, false));
        assert_eq!(p.tick(10_000, &mic(8_000)), (MicHealth::Rebuilding, true));
        p.rebuild_started();
        p.rebuild_finished(false);

        // 30s rung; a sub-banner stall during the cooldown reads Ok.
        assert_eq!(p.tick(20_000, &mic(3_000)), (MicHealth::Ok, false));
        assert_eq!(p.tick(39_999, &mic(8_000)), (MicHealth::Stalled, false));
        assert_eq!(p.tick(40_000, &mic(8_000)), (MicHealth::Rebuilding, true));
        p.rebuild_started();
        p.rebuild_finished(false);

        // Capped: never again this session (absent a healthy reset).
        assert_eq!(p.tick(1_000_000, &mic(8_000)), (MicHealth::Stalled, false));
        assert_eq!(p.tick(10_000_000, &mic(8_000)), (MicHealth::Stalled, false));
    }

    #[test]
    fn mic_recovery_ticks_record_healthy_and_restore_the_budget() {
        let mut p = MicPolicy::new();
        let last = exhaust_mic_budget(&mut p);
        assert_eq!(p.tick(last + 1, &mic(8_000)), (MicHealth::Stalled, false));

        // 300s of continuously-Ok ticks...
        let mut t = 41_000;
        while t <= 341_000 {
            assert_eq!(p.tick(t, &mic(0)), (MicHealth::Ok, false));
            t += 10_000;
        }
        // ...re-arms the budget.
        assert_eq!(p.tick(341_010, &mic(2_000)), (MicHealth::Rebuilding, true));
    }

    #[test]
    fn mic_intermittent_health_never_resets_the_budget() {
        let mut p = MicPolicy::new();
        exhaust_mic_budget(&mut p);

        // 200s healthy, one bad tick, 200s healthy: 400s total Ok wall time
        // but never 300s continuous — the cap must hold.
        let mut t = 41_000;
        while t <= 241_000 {
            assert_eq!(p.tick(t, &mic(0)), (MicHealth::Ok, false));
            t += 10_000;
        }
        assert_eq!(p.tick(241_010, &mic(8_000)), (MicHealth::Stalled, false));
        let mut t = 241_020;
        while t <= 441_020 {
            assert_eq!(p.tick(t, &mic(0)), (MicHealth::Ok, false));
            t += 10_000;
        }
        assert_eq!(p.tick(441_030, &mic(8_000)), (MicHealth::Stalled, false));
    }

    #[test]
    fn mic_in_flight_rebuild_does_not_accrue_healthy_time() {
        let mut p = MicPolicy::new();
        for t in [0u64, 10_000] {
            assert_eq!(p.tick(t, &mic(8_000)), (MicHealth::Rebuilding, true));
            p.rebuild_started();
            p.rebuild_finished(false);
        }
        assert_eq!(p.tick(40_000, &mic(8_000)), (MicHealth::Rebuilding, true));
        p.rebuild_started();

        // A wedged rebuild hangs for >5 min; those ticks are not "healthy".
        let mut t = 41_000;
        while t <= 391_000 {
            assert_eq!(p.tick(t, &mic(0)), (MicHealth::Rebuilding, false));
            t += 10_000;
        }
        p.rebuild_finished(false);
        assert_eq!(p.tick(400_010, &mic(8_000)), (MicHealth::Stalled, false));
    }

    // -- SysTapPolicy -------------------------------------------------------

    #[test]
    fn sys_zero_run_alone_never_warns_or_rebuilds() {
        let mut p = SysTapPolicy::new();
        // No call app, no recent voice: flat audio is presumed legitimate.
        for (t, zero) in [(0u64, 10_000u64), (1_000, 15_000), (2_000, 10_000_000)] {
            let obs = SysObs {
                zero_run_ms: zero,
                ..sys()
            };
            assert_eq!(p.tick(t, &obs), (SysHealth::Ok, false));
        }
    }

    #[test]
    fn sys_zero_run_with_call_app_warns_then_rebuilds() {
        let mut p = SysTapPolicy::new();
        let obs = |zero_run_ms| SysObs {
            zero_run_ms,
            call_app_active: true,
            ..sys()
        };
        assert_eq!(p.tick(0, &obs(SYS_ZERO_WARN_MS - 1)), (SysHealth::Ok, false));
        assert_eq!(p.tick(1, &obs(SYS_ZERO_WARN_MS)), (SysHealth::Silent, false));
        assert_eq!(p.tick(2, &obs(SYS_ZERO_REBUILD_MS - 1)), (SysHealth::Silent, false));
        assert_eq!(p.tick(3, &obs(SYS_ZERO_REBUILD_MS)), (SysHealth::Rebuilding, true));
    }

    #[test]
    fn sys_recent_voice_is_evidence_with_strict_boundary() {
        let mut p = SysTapPolicy::new();
        let obs = |zero_run_ms, voice_ago_ms| SysObs {
            zero_run_ms,
            voice_ago_ms,
            ..sys()
        };
        // voice_ago < VOICE_RECENT_MS is evidence; exactly at it is not.
        assert_eq!(
            p.tick(0, &obs(SYS_ZERO_WARN_MS, VOICE_RECENT_MS - 1)),
            (SysHealth::Silent, false)
        );
        assert_eq!(
            p.tick(1, &obs(SYS_ZERO_WARN_MS, VOICE_RECENT_MS)),
            (SysHealth::Ok, false)
        );
        assert_eq!(
            p.tick(2, &obs(SYS_ZERO_REBUILD_MS, VOICE_RECENT_MS)),
            (SysHealth::Ok, false)
        );
        assert_eq!(
            p.tick(3, &obs(SYS_ZERO_REBUILD_MS, VOICE_RECENT_MS - 1)),
            (SysHealth::Rebuilding, true)
        );
    }

    #[test]
    fn sys_stall_warns_and_rebuilds_without_evidence() {
        let mut p = SysTapPolicy::new();
        let obs = |stall_ms| SysObs { stall_ms, ..sys() };
        assert_eq!(p.tick(0, &obs(9_999)), (SysHealth::Ok, false));
        assert_eq!(p.tick(1, &obs(10_000)), (SysHealth::Stalled, false));
        assert_eq!(p.tick(2, &obs(11_999)), (SysHealth::Stalled, false));
        assert_eq!(p.tick(3, &obs(12_000)), (SysHealth::Rebuilding, true));
    }

    #[test]
    fn sys_stalled_outranks_silent() {
        let mut p = SysTapPolicy::new();
        let obs = SysObs {
            stall_ms: 10_500,
            zero_run_ms: 12_000,
            call_app_active: true,
            ..sys()
        };
        assert_eq!(p.tick(0, &obs), (SysHealth::Stalled, false));
    }

    #[test]
    fn sys_paused_suppresses_rebuild_but_not_warnings() {
        let mut p = SysTapPolicy::new();
        let stalled = SysObs {
            stall_ms: 30_000,
            paused: true,
            ..sys()
        };
        let silent = SysObs {
            zero_run_ms: SYS_ZERO_WARN_MS + 5_000,
            call_app_active: true,
            paused: true,
            ..sys()
        };
        assert_eq!(p.tick(0, &stalled), (SysHealth::Stalled, false));
        assert_eq!(p.tick(1, &silent), (SysHealth::Silent, false));
    }

    #[test]
    fn sys_permission_lost_is_terminal_and_never_rebuilds() {
        let mut p = SysTapPolicy::new();
        let obs = SysObs {
            stall_ms: 60_000,
            zero_run_ms: 60_000,
            call_app_active: true,
            permission: false,
            ..sys()
        };
        for t in [0u64, 1_000, 500_000] {
            assert_eq!(p.tick(t, &obs), (SysHealth::PermissionLost, false));
        }
        // The budget was never charged while permission was out.
        assert_eq!(p.budget.attempts, 0);
        // Restored permission: the tap may rebuild immediately.
        let restored = SysObs {
            permission: true,
            ..obs
        };
        assert_eq!(p.tick(500_100, &restored), (SysHealth::Rebuilding, true));
    }

    #[test]
    fn sys_permission_lost_ticks_do_not_accrue_healthy_time() {
        let mut p = SysTapPolicy::new();
        exhaust_sys_budget(&mut p);

        // >5 min of otherwise-clean ticks with permission out must not reset.
        let mut t = 41_000;
        while t <= 391_000 {
            let obs = SysObs {
                permission: false,
                ..sys()
            };
            assert_eq!(p.tick(t, &obs), (SysHealth::PermissionLost, false));
            t += 10_000;
        }
        let broken = SysObs {
            stall_ms: 20_000,
            ..sys()
        };
        assert_eq!(p.tick(400_010, &broken), (SysHealth::Stalled, false));
    }

    #[test]
    fn sys_reports_rebuilding_while_in_flight_then_recovers_to_ok() {
        let mut p = SysTapPolicy::new();
        let broken = SysObs {
            zero_run_ms: SYS_ZERO_REBUILD_MS + 5_000,
            call_app_active: true,
            ..sys()
        };
        assert_eq!(p.tick(0, &broken), (SysHealth::Rebuilding, true));
        p.rebuild_started();
        for t in [100u64, 5_000] {
            assert_eq!(p.tick(t, &broken), (SysHealth::Rebuilding, false));
        }
        p.rebuild_finished(true);
        assert_eq!(p.tick(5_100, &sys()), (SysHealth::Ok, false));
    }

    #[test]
    fn sys_failed_rebuilds_retry_on_the_cooldown_ladder_then_cap() {
        let mut p = SysTapPolicy::new();
        let broken = SysObs {
            stall_ms: 20_000,
            ..sys()
        };
        assert_eq!(p.tick(0, &broken), (SysHealth::Rebuilding, true));
        p.rebuild_started();
        p.rebuild_finished(false);
        assert_eq!(p.tick(9_999, &broken), (SysHealth::Stalled, false));
        assert_eq!(p.tick(10_000, &broken), (SysHealth::Rebuilding, true));
        p.rebuild_started();
        p.rebuild_finished(false);
        assert_eq!(p.tick(39_999, &broken), (SysHealth::Stalled, false));
        assert_eq!(p.tick(40_000, &broken), (SysHealth::Rebuilding, true));
        p.rebuild_started();
        p.rebuild_finished(false);
        assert_eq!(p.tick(10_000_000, &broken), (SysHealth::Stalled, false));
    }

    #[test]
    fn sys_flat_audio_without_evidence_counts_as_healthy_and_restores_budget() {
        let mut p = SysTapPolicy::new();
        exhaust_sys_budget(&mut p);

        // A long evidence-free zero-run is Ok by design — and therefore also
        // accrues healthy time toward the budget reset.
        let flat = SysObs {
            zero_run_ms: 999_999,
            ..sys()
        };
        let mut t = 41_000;
        while t <= 341_000 {
            assert_eq!(p.tick(t, &flat), (SysHealth::Ok, false));
            t += 10_000;
        }
        let broken = SysObs {
            stall_ms: 12_000,
            ..sys()
        };
        assert_eq!(p.tick(341_010, &broken), (SysHealth::Rebuilding, true));
    }

    // -- wire names ---------------------------------------------------------

    #[test]
    fn health_strings_match_the_event_contract() {
        assert_eq!(MicHealth::Ok.as_str(), "ok");
        assert_eq!(MicHealth::Stalled.as_str(), "stalled");
        assert_eq!(MicHealth::Rebuilding.as_str(), "rebuilding");
        assert_eq!(SysHealth::Ok.as_str(), "ok");
        assert_eq!(SysHealth::Silent.as_str(), "silent");
        assert_eq!(SysHealth::Stalled.as_str(), "stalled");
        assert_eq!(SysHealth::Rebuilding.as_str(), "rebuilding");
        assert_eq!(SysHealth::PermissionLost.as_str(), "permission_lost");
    }
}
