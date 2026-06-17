//! Meeting-call detection (plan v3 rank 1, four-brief consensus feature).
//!
//! Polls CoreAudio for processes actively capturing the microphone and
//! nudges the user when a known meeting app (or a browser, for web calls)
//! starts a call they aren't recording. Detection reads WHICH processes use
//! the mic — never any audio — and everything stays on-device.

/// Native meeting apps: a mic session here is almost certainly a call.
const MEETING_BUNDLES: &[(&str, &str)] = &[
    ("us.zoom.xos", "Zoom"),
    ("com.microsoft.teams", "Teams"),
    ("com.cisco.webex", "Webex"),
    ("Cisco-Systems.Spark", "Webex"),
    ("com.hnc.Discord", "Discord"),
    ("com.tinyspeck.slackmacgap", "Slack"),
    ("net.whatsapp.WhatsApp", "WhatsApp"),
    ("com.apple.FaceTime", "FaceTime"),
    ("com.skype.skype", "Skype"),
];

/// Browsers: mic use very likely means a Meet/Zoom-web/Teams-web call.
const BROWSER_BUNDLES: &[(&str, &str)] = &[
    ("com.google.Chrome", "your browser"),
    ("com.apple.Safari", "your browser"),
    ("org.mozilla.firefox", "your browser"),
    ("com.microsoft.edgemac", "your browser"),
    ("company.thebrowser.Browser", "your browser"),
    ("com.brave.Browser", "your browser"),
    ("com.vivaldi.Vivaldi", "your browser"),
];

/// Friendly app name when this bundle id looks like a call surface.
pub fn call_app_name(bundle_id: &str) -> Option<&'static str> {
    MEETING_BUNDLES
        .iter()
        .chain(BROWSER_BUNDLES.iter())
        .find(|(prefix, _)| bundle_id.starts_with(prefix))
        .map(|(_, name)| *name)
}

/// Seen-twice debouncer with a per-bundle cooldown. One mic-permission blip
/// must not nudge; a real call (two consecutive sightings ≥ one poll apart)
/// nudges once, then stays quiet for the cooldown even if the call runs on.
pub struct CallDetector {
    /// bundle id → consecutive sightings.
    streak: std::collections::HashMap<String, u32>,
    /// bundle id → last nudge time (seconds, caller-supplied clock).
    last_nudge: std::collections::HashMap<String, u64>,
    cooldown_secs: u64,
}

impl CallDetector {
    pub fn new(cooldown_secs: u64) -> Self {
        Self {
            streak: Default::default(),
            last_nudge: Default::default(),
            cooldown_secs,
        }
    }

    /// Feed one poll's worth of mic-active bundle ids; returns the bundles
    /// to nudge for right now.
    pub fn observe(&mut self, now_secs: u64, active: &[String]) -> Vec<String> {
        let call_apps: Vec<&String> = active
            .iter()
            .filter(|b| call_app_name(b).is_some())
            .collect();

        // Streaks: bump present, clear absent (so re-joining later re-arms).
        let present: std::collections::HashSet<&str> =
            call_apps.iter().map(|s| s.as_str()).collect();
        self.streak.retain(|k, _| present.contains(k.as_str()));
        for b in &call_apps {
            *self.streak.entry((*b).clone()).or_insert(0) += 1;
        }

        let mut nudges = Vec::new();
        for b in call_apps {
            if self.streak.get(b).copied().unwrap_or(0) != 2 {
                continue;
            }
            let cooled = self
                .last_nudge
                .get(b)
                .map(|t| now_secs.saturating_sub(*t) >= self.cooldown_secs)
                .unwrap_or(true);
            if cooled {
                self.last_nudge.insert(b.clone(), now_secs);
                nudges.push(b.clone());
            }
        }
        nudges
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn classifies_meeting_apps_and_browsers() {
        assert_eq!(call_app_name("us.zoom.xos"), Some("Zoom"));
        assert_eq!(call_app_name("com.microsoft.teams2"), Some("Teams"));
        assert_eq!(call_app_name("com.google.Chrome.helper"), Some("your browser"));
        assert_eq!(call_app_name("com.apple.garageband"), None);
    }

    #[test]
    fn one_blip_never_nudges_two_sightings_do() {
        let mut d = CallDetector::new(900);
        assert!(d.observe(0, &ids(&["us.zoom.xos"])).is_empty(), "first sighting");
        assert!(d.observe(15, &ids(&[])).is_empty(), "blip cleared");
        assert!(d.observe(30, &ids(&["us.zoom.xos"])).is_empty(), "streak restarted");
        assert_eq!(d.observe(45, &ids(&["us.zoom.xos"])), ids(&["us.zoom.xos"]));
    }

    #[test]
    fn ongoing_call_nudges_once_until_cooldown() {
        let mut d = CallDetector::new(900);
        d.observe(0, &ids(&["us.zoom.xos"]));
        assert_eq!(d.observe(15, &ids(&["us.zoom.xos"])).len(), 1);
        // Call keeps running — quiet.
        for t in [30u64, 45, 60, 600] {
            assert!(d.observe(t, &ids(&["us.zoom.xos"])).is_empty());
        }
        // Left and rejoined after cooldown — nudge again.
        assert!(d.observe(950, &ids(&[])).is_empty());
        d.observe(960, &ids(&["us.zoom.xos"]));
        assert_eq!(d.observe(975, &ids(&["us.zoom.xos"])).len(), 1);
    }

    #[test]
    fn rejoining_before_cooldown_stays_quiet() {
        let mut d = CallDetector::new(900);
        d.observe(0, &ids(&["us.zoom.xos"]));
        d.observe(15, &ids(&["us.zoom.xos"]));
        d.observe(30, &ids(&[]));
        d.observe(45, &ids(&["us.zoom.xos"]));
        assert!(d.observe(60, &ids(&["us.zoom.xos"])).is_empty(), "cooldown holds");
    }

    #[test]
    fn non_call_apps_are_ignored_entirely() {
        let mut d = CallDetector::new(900);
        d.observe(0, &ids(&["com.apple.garageband"]));
        assert!(d.observe(15, &ids(&["com.apple.garageband"])).is_empty());
    }
}

#[cfg(test)]
mod live_tests {
    /// Prints which processes are using the mic right now. Run:
    ///   cargo test live_mic_enumeration -- --ignored --nocapture
    #[test]
    #[ignore]
    fn live_mic_enumeration() {
        let ids = crate::audio::system::mic_active_bundle_ids();
        eprintln!("mic-active bundles: {ids:?}");
    }
}
