//! perchnote:// deep links (plan v3 rank 11, verbs grown in plan v8 B5).
//! A URL scheme is the cheapest automation surface: Raycast, Shortcuts,
//! Stream Deck, and shell scripts all speak `open "perchnote://record/start"`
//! with zero integration code on our side. Verbs that take parameters and
//! the x-callback-url contract follow the Things model.

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DeepAction {
    /// Start recording (creates a meeting if none is in progress). An
    /// optional `?title=` names the created meeting.
    RecordStart { title: Option<String> },
    /// Stop the current recording.
    RecordStop,
    /// Open a specific meeting by id; `transcript` pops the drawer too.
    OpenMeeting { id: String, transcript: bool },
    /// Open the command palette pre-filled with `q` (the search grammar —
    /// speaker:/folder:/before:/after: — works exactly as if typed).
    Search { q: String },
}

/// x-callback-url companion params (per the x-callback-url spec): URLs we
/// open — never execute — after the action dispatches or fails to parse.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Callbacks {
    pub x_success: Option<String>,
    pub x_error: Option<String>,
}

/// Free-text params end up in window titles, filenames (md mirror) and
/// notifications — strip control chars and cap the length.
const TEXT_PARAM_MAX_CHARS: usize = 200;

fn sanitize_text(raw: &str) -> String {
    raw.chars()
        .filter(|c| !c.is_control())
        .take(TEXT_PARAM_MAX_CHARS)
        .collect::<String>()
        .trim()
        .to_string()
}

/// Parse a perchnote:// URL into an action. Unknown shapes → None (ignored).
pub fn parse_deep_link(url: &str) -> Option<DeepAction> {
    parse_deep_link_full(url).0
}

/// Full parse: the action plus any x-callback params. Callbacks come back
/// even when the action is None so callers can fire x-error for links that
/// carried one but didn't parse.
pub fn parse_deep_link_full(url: &str) -> (Option<DeepAction>, Callbacks) {
    let Ok(parsed) = url::Url::parse(url) else {
        return (None, Callbacks::default());
    };
    if parsed.scheme() != "perchnote" {
        return (None, Callbacks::default());
    }

    // query_pairs percent-decodes lossily — malformed escapes stay literal
    // instead of panicking. Last occurrence of a repeated key wins.
    let mut title: Option<String> = None;
    let mut q: Option<String> = None;
    let mut callbacks = Callbacks::default();
    for (key, value) in parsed.query_pairs() {
        match key.as_ref() {
            "title" => title = Some(value.into_owned()),
            "q" => q = Some(value.into_owned()),
            "x-success" => callbacks.x_success = Some(value.into_owned()),
            "x-error" => callbacks.x_error = Some(value.into_owned()),
            _ => {}
        }
    }

    // `perchnote://record/start` parses as host="record" + path="/start" —
    // fold them back into one verb list (also keeps the old tolerance for
    // trailing slashes and empty segments).
    let mut segments: Vec<&str> = Vec::new();
    if let Some(host) = parsed.host_str() {
        if !host.is_empty() {
            segments.push(host);
        }
    }
    segments.extend(parsed.path().split('/').filter(|s| !s.is_empty()));

    // x-callback-url spec alias: perchnote://x-callback-url/<verb…>
    let verb: &[&str] = match segments.split_first() {
        Some((&"x-callback-url", rest)) => rest,
        _ => &segments,
    };

    let action = match verb {
        ["record", "start"] | ["record"] => Some(DeepAction::RecordStart {
            title: title.map(|t| sanitize_text(&t)).filter(|t| !t.is_empty()),
        }),
        ["record", "stop"] => Some(DeepAction::RecordStop),
        ["meeting", id] if uuid::Uuid::parse_str(id).is_ok() => Some(DeepAction::OpenMeeting {
            id: (*id).to_string(),
            transcript: false,
        }),
        ["meeting", id, "transcript"] if uuid::Uuid::parse_str(id).is_ok() => {
            Some(DeepAction::OpenMeeting {
                id: (*id).to_string(),
                transcript: true,
            })
        }
        // `q` optional: a bare perchnote://search just opens the palette.
        ["search"] => Some(DeepAction::Search {
            q: sanitize_text(q.as_deref().unwrap_or("")),
        }),
        _ => None,
    };
    (action, callbacks)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_supported_shapes() {
        assert_eq!(
            parse_deep_link("perchnote://record/start"),
            Some(DeepAction::RecordStart { title: None })
        );
        assert_eq!(
            parse_deep_link("perchnote://record"),
            Some(DeepAction::RecordStart { title: None })
        );
        assert_eq!(parse_deep_link("perchnote://record/stop/"), Some(DeepAction::RecordStop));
        let id = "c075ff8d-5e65-4087-bce7-ba0f4391e476";
        assert_eq!(
            parse_deep_link(&format!("perchnote://meeting/{id}")),
            Some(DeepAction::OpenMeeting { id: id.into(), transcript: false })
        );
    }

    #[test]
    fn rejects_garbage_and_traversal() {
        assert_eq!(parse_deep_link("perchnote://meeting/not-a-uuid"), None);
        assert_eq!(parse_deep_link("perchnote://delete/everything"), None);
        assert_eq!(parse_deep_link("https://record/start"), None);
        assert_eq!(parse_deep_link("perchnote://"), None);
    }

    #[test]
    fn search_decodes_query_including_grammar_tokens() {
        assert_eq!(
            parse_deep_link("perchnote://search?q=acme%20speaker%3A%22Amy%20Patel%22"),
            Some(DeepAction::Search { q: r#"acme speaker:"Amy Patel""#.into() })
        );
        // q optional → empty query opens the palette plain
        assert_eq!(parse_deep_link("perchnote://search"), Some(DeepAction::Search { q: String::new() }));
    }

    #[test]
    fn record_start_title_is_decoded_capped_and_control_stripped() {
        assert_eq!(
            parse_deep_link("perchnote://record/start?title=Design%20Review"),
            Some(DeepAction::RecordStart { title: Some("Design Review".into()) })
        );
        // Control chars (encoded newline/escape) stripped
        assert_eq!(
            parse_deep_link("perchnote://record/start?title=Stand%0Aup%1B"),
            Some(DeepAction::RecordStart { title: Some("Standup".into()) })
        );
        // Length capped at 200 chars
        let long = "x".repeat(500);
        match parse_deep_link(&format!("perchnote://record/start?title={long}")) {
            Some(DeepAction::RecordStart { title: Some(t) }) => assert_eq!(t.chars().count(), 200),
            other => panic!("expected capped title, got {other:?}"),
        }
        // Whitespace-only title → behaves like no title
        assert_eq!(
            parse_deep_link("perchnote://record/start?title=%20%20"),
            Some(DeepAction::RecordStart { title: None })
        );
    }

    #[test]
    fn meeting_transcript_suffix_pops_the_drawer() {
        let id = "c075ff8d-5e65-4087-bce7-ba0f4391e476";
        assert_eq!(
            parse_deep_link(&format!("perchnote://meeting/{id}/transcript")),
            Some(DeepAction::OpenMeeting { id: id.into(), transcript: true })
        );
        // UUID still validated; unknown suffixes still rejected
        assert_eq!(parse_deep_link("perchnote://meeting/not-a-uuid/transcript"), None);
        assert_eq!(parse_deep_link(&format!("perchnote://meeting/{id}/delete")), None);
    }

    #[test]
    fn x_callback_url_prefix_is_an_alias() {
        assert_eq!(
            parse_deep_link("perchnote://x-callback-url/record/start?title=Standup"),
            Some(DeepAction::RecordStart { title: Some("Standup".into()) })
        );
        let id = "c075ff8d-5e65-4087-bce7-ba0f4391e476";
        assert_eq!(
            parse_deep_link(&format!("perchnote://x-callback-url/meeting/{id}/transcript")),
            Some(DeepAction::OpenMeeting { id: id.into(), transcript: true })
        );
        // A bare prefix is not a verb
        assert_eq!(parse_deep_link("perchnote://x-callback-url"), None);
    }

    #[test]
    fn extracts_x_success_and_x_error() {
        let (action, cb) = parse_deep_link_full(
            "perchnote://record/start?x-success=shortcuts%3A%2F%2Fdone&x-error=shortcuts%3A%2F%2Foops",
        );
        assert_eq!(action, Some(DeepAction::RecordStart { title: None }));
        assert_eq!(cb.x_success.as_deref(), Some("shortcuts://done"));
        assert_eq!(cb.x_error.as_deref(), Some("shortcuts://oops"));

        // Callbacks survive a failed parse so x-error can fire
        let (action, cb) = parse_deep_link_full("perchnote://bogus/verb?x-error=shortcuts%3A%2F%2Foops");
        assert_eq!(action, None);
        assert_eq!(cb.x_error.as_deref(), Some("shortcuts://oops"));

        // Non-perchnote URLs never yield callbacks
        let (action, cb) = parse_deep_link_full("https://evil.example/?x-success=shortcuts%3A%2F%2F");
        assert_eq!(action, None);
        assert_eq!(cb, Callbacks::default());
    }

    #[test]
    fn malformed_percent_encoding_does_not_panic() {
        // Lossy decode: bad escapes stay literal, nothing panics
        assert_eq!(
            parse_deep_link("perchnote://search?q=%zz%"),
            Some(DeepAction::Search { q: "%zz%".into() })
        );
        assert!(parse_deep_link("perchnote://record/start?title=%e2%28%a1").is_some());
        assert_eq!(parse_deep_link("perchnote://%%%"), None);
    }
}
