//! Cold-start deep links (plan v8 B8 hardening, verbs grown in B5).
//!
//! A perchnote:// URL that LAUNCHES the app is delivered while Tauri is
//! still in setup — the runtime `on_open_url` handler emits its event
//! before the webview has mounted any listener, so the action vanishes.
//! That breaks the headline automation ("Shortcuts time-of-day → start
//! recording" with the app closed). The frontend instead calls
//! `take_launch_deep_actions` once its listeners are up; this returns the
//! parsed launch-URL actions exactly once, so a hot reload or window
//! re-creation can never replay them.

use serde::Serialize;
use tauri::AppHandle;
use tauri_plugin_deep_link::DeepLinkExt;

use crate::deeplink::{parse_deep_link, parse_deep_link_full, Callbacks, DeepAction};

/// One wire shape for BOTH delivery paths: the runtime `deep-action` event
/// and the cold-start drain below. `src/lib/deepActions.ts` is the consumer.
#[derive(Debug, Serialize, PartialEq, Clone, Default)]
pub struct LaunchDeepAction {
    /// "record-start" | "record-stop" | "open-meeting" | "search"
    pub action: String,
    pub meeting_id: Option<String>,
    pub title: Option<String>,
    pub transcript: bool,
    pub q: Option<String>,
}

pub fn wire_action(a: DeepAction) -> LaunchDeepAction {
    match a {
        DeepAction::RecordStart { title } => LaunchDeepAction {
            action: "record-start".into(),
            title,
            ..Default::default()
        },
        DeepAction::RecordStop => LaunchDeepAction {
            action: "record-stop".into(),
            ..Default::default()
        },
        DeepAction::OpenMeeting { id, transcript } => LaunchDeepAction {
            action: "open-meeting".into(),
            meeting_id: Some(id),
            transcript,
            ..Default::default()
        },
        DeepAction::Search { q } => LaunchDeepAction {
            action: "search".into(),
            q: Some(q),
            ..Default::default()
        },
    }
}

/// Resolve which callback URL (if any) should fire, enforcing the callback
/// scheme gate. Deep links are attacker-reachable (any webpage can trigger
/// `perchnote://…` navigation), so an x-success/x-error value is hostile
/// input: opening it through the general `open_url` allowlist would let a
/// drive-by page launder a scheme-launch through Perchnote WITHOUT the
/// browser's own "open this app?" consent prompt. Callbacks therefore only
/// ever return to the two automation hosts the x-callback contract exists
/// for — `shortcuts:` and `raycast:` — and no other scheme, ever.
fn callback_target(dispatched: bool, callbacks: &Callbacks, error_reason: &str) -> Option<String> {
    let raw = if dispatched {
        callbacks.x_success.clone()?
    } else {
        callbacks.x_error.clone()?
    };
    let mut u = match url::Url::parse(&raw) {
        Ok(u) => u,
        Err(e) => {
            log::warn!("x-callback URL is not a valid URL: {e}");
            return None;
        }
    };
    // Only the RESUME shape — `shortcuts://x-callback-url/…` — may fire.
    // `shortcuts://run-shortcut` executes a user-installed automation
    // outright (QA audit finding 4), and raycast: script commands are the
    // same class, so neither is reachable from here.
    if u.scheme() != "shortcuts" || u.host_str() != Some("x-callback-url") {
        log::warn!(
            "x-callback refused ({raw}) — callbacks may only resume via shortcuts://x-callback-url/…"
        );
        return None;
    }
    if !dispatched {
        u.query_pairs_mut().append_pair("errorMessage", error_reason);
    }
    Some(u.into())
}

/// Best-effort x-callback-url completion: open x-success once the action is
/// dispatched, or x-error (with `?errorMessage=`) when the link didn't
/// parse. Launches directly (NOT via the `open_url` command, whose broader
/// allowlist serves frontend links); any failure is log-only — automation
/// must never break the app.
pub fn complete_callbacks(dispatched: bool, callbacks: &Callbacks, error_reason: &str) {
    let Some(url) = callback_target(dispatched, callbacks, error_reason) else { return };
    tauri::async_runtime::spawn(async move {
        match std::process::Command::new("/usr/bin/open").arg("--").arg(&url).status() {
            Ok(s) if s.success() => {}
            Ok(s) => log::warn!("x-callback open exited with {s}"),
            Err(e) => log::warn!("x-callback open failed: {e}"),
        }
    });
}

fn actions_from_urls<I: IntoIterator<Item = String>>(urls: I) -> Vec<LaunchDeepAction> {
    urls.into_iter()
        .filter_map(|u| parse_deep_link(&u))
        .map(wire_action)
        .collect()
}

static TAKEN: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// True once the frontend has drained launch URLs. The runtime on_open_url
/// handler must stay silent until then: on macOS the plugin BOTH invokes
/// handlers for the launch URL and stores it for `get_current()`, so
/// without this gate a cold-start link is handled twice — its x-callback
/// fired twice, and (in a narrow window) its action dispatched twice
/// (QA audit finding 3).
pub fn launch_drain_completed() -> bool {
    TAKEN.load(std::sync::atomic::Ordering::SeqCst)
}

#[tauri::command]
pub fn take_launch_deep_actions(app: AppHandle) -> Vec<LaunchDeepAction> {
    if TAKEN.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return Vec::new();
    }
    let urls: Vec<String> = app
        .deep_link()
        .get_current()
        .ok()
        .flatten()
        .unwrap_or_default()
        .into_iter()
        .map(|u| u.to_string())
        .collect();
    // x-callbacks fire at parse time: the frontend dispatches the drained
    // actions the moment this returns, and best-effort is the contract.
    for u in &urls {
        let (action, callbacks) = parse_deep_link_full(u);
        complete_callbacks(action.is_some(), &callbacks, "unrecognized perchnote:// link");
    }
    actions_from_urls(urls)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_parsed_urls_to_wire_actions() {
        let id = "c075ff8d-5e65-4087-bce7-ba0f4391e476";
        let actions = actions_from_urls([
            "perchnote://record/start".to_string(),
            format!("perchnote://meeting/{id}"),
            "perchnote://garbage/everything".to_string(), // dropped
            "perchnote://record/stop".to_string(),
        ]);
        assert_eq!(actions.len(), 3);
        assert_eq!(actions[0].action, "record-start");
        assert_eq!(actions[0].title, None);
        assert_eq!(actions[1].action, "open-meeting");
        assert_eq!(actions[1].meeting_id.as_deref(), Some(id));
        assert!(!actions[1].transcript);
        assert_eq!(actions[2].action, "record-stop");
    }

    #[test]
    fn maps_new_verbs_to_wire_actions() {
        let id = "c075ff8d-5e65-4087-bce7-ba0f4391e476";
        let actions = actions_from_urls([
            "perchnote://record/start?title=Design%20Review".to_string(),
            format!("perchnote://meeting/{id}/transcript"),
            "perchnote://search?q=roadmap%20speaker%3AAmy".to_string(),
            // x-callback params don't disturb the action mapping
            "perchnote://x-callback-url/record/stop?x-success=shortcuts%3A%2F%2F".to_string(),
        ]);
        assert_eq!(actions.len(), 4);
        assert_eq!(actions[0].action, "record-start");
        assert_eq!(actions[0].title.as_deref(), Some("Design Review"));
        assert_eq!(actions[1].action, "open-meeting");
        assert_eq!(actions[1].meeting_id.as_deref(), Some(id));
        assert!(actions[1].transcript);
        assert_eq!(actions[2].action, "search");
        assert_eq!(actions[2].q.as_deref(), Some("roadmap speaker:Amy"));
        assert_eq!(actions[3].action, "record-stop");
    }

    #[test]
    fn empty_input_is_empty_output() {
        assert!(actions_from_urls(Vec::<String>::new()).is_empty());
    }

    #[test]
    fn callbacks_only_resume_waiting_shortcuts() {
        let cb = |success: &str| Callbacks {
            x_success: Some(success.to_string()),
            x_error: None,
        };
        assert_eq!(
            callback_target(true, &cb("shortcuts://x-callback-url/resume"), ""),
            Some("shortcuts://x-callback-url/resume".to_string())
        );
        // A drive-by page must not be able to launder app/automation
        // launches (or open redirects) through the callback path —
        // including shortcuts://run-shortcut, which executes outright.
        for hostile in [
            "shortcuts://run-shortcut?name=Wipe%20Disk",
            "raycast://confetti",
            "raycast://script-commands/run?name=x",
            "https://evil.example/phish",
            "things:///add?title=x",
            "mailto:a@b.c",
            "file:///etc/passwd",
            "not a url",
        ] {
            assert_eq!(callback_target(true, &cb(hostile), ""), None, "{hostile}");
        }
    }

    #[test]
    fn x_error_gets_the_reason_appended() {
        let callbacks = Callbacks {
            x_success: None,
            x_error: Some("shortcuts://x-callback-url/err".to_string()),
        };
        let got = callback_target(false, &callbacks, "bad link").unwrap();
        assert_eq!(got, "shortcuts://x-callback-url/err?errorMessage=bad+link");
        // And the success leg never falls through to x-error.
        assert_eq!(callback_target(true, &callbacks, "bad link"), None);
    }
}
