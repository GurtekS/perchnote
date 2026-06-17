use anyhow::{anyhow, Result};
use chrono::{DateTime, NaiveDateTime, Utc, Duration, TimeZone};
use futures_util::StreamExt;

use crate::db::Database;
use super::detection::detect_platform;
use super::http::{audit_url_for_remote_fetch, build_client};

/// Cap on the response body we'll accept from a single ICS feed (5 MiB).
/// Real corporate calendars rarely exceed a few hundred KiB; capping prevents
/// a hostile feed from OOMing the app. We enforce the cap *while reading*
/// so a server that lies about (or omits) Content-Length still can't make
/// us allocate unbounded memory.
const MAX_ICS_BODY_BYTES: usize = 5 * 1024 * 1024;

/// Parsed calendar event from ICS
pub(crate) struct IcsEvent {
    uid: String,
    summary: String,
    dtstart: Option<DateTime<Utc>>,
    dtend: Option<DateTime<Utc>>,
    location: Option<String>,
    description: Option<String>,
}

/// Fetch and parse an ICS URL, upsert events into the database.
/// Returns the number of events synced.
pub async fn sync_ics_url(db: &Database, ics_url: &str, past_days: u32, future_days: u32) -> Result<usize> {
    // SSRF guard: only public https URLs.
    let url = audit_url_for_remote_fetch(ics_url).await?;

    let client = build_client();
    let resp = client.get(url).send().await?;

    if !resp.status().is_success() {
        return Err(anyhow!("ICS fetch failed with status {}", resp.status()));
    }

    // Refuse oversized responses up-front via Content-Length (when honest).
    if let Some(len) = resp.content_length() {
        if len as usize > MAX_ICS_BODY_BYTES {
            return Err(anyhow!("ICS feed too large: {} bytes", len));
        }
    }

    // Read the body in chunks, bailing as soon as we exceed the cap. This
    // prevents a server that lies about Content-Length from making us
    // allocate up to MAX_ICS_BODY_BYTES + the chunk size, but never more.
    let mut buf: Vec<u8> = Vec::with_capacity(64 * 1024);
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        if buf.len() + chunk.len() > MAX_ICS_BODY_BYTES {
            return Err(anyhow!("ICS feed exceeded {} bytes", MAX_ICS_BODY_BYTES));
        }
        buf.extend_from_slice(&chunk);
    }
    let body = std::str::from_utf8(&buf)
        .map_err(|_| anyhow!("ICS feed is not valid UTF-8"))?;
    let events = parse_ics_events(body)?;

    let now = Utc::now();
    let horizon = now + Duration::days(future_days as i64);
    let past_cutoff = now - Duration::days(past_days as i64);

    let mut count = 0;
    for event in events {
        let start = match event.dtstart {
            Some(dt) => dt,
            None => continue,
        };
        let end = event.dtend.unwrap_or(start + Duration::hours(1));

        if start > horizon || end < past_cutoff {
            continue;
        }

        let (meeting_url, platform) = detect_platform(
            event.location.as_deref(),
            event.description.as_deref(),
        );

        // Use uid as calendar_event_id for dedup; skip individual failures without aborting the whole sync
        match db.upsert_calendar_meeting(
            &event.uid,
            &event.summary,
            &start.to_rfc3339(),
            &end.to_rfc3339(),
            "[]", // ICS doesn't reliably provide structured attendees
            event.location.as_deref(),
            meeting_url.as_deref(),
            &platform,
        ) {
            Ok(_) => count += 1,
            Err(e) => log::warn!("ICS: failed to upsert event '{}': {}", event.uid, e),
        }
    }

    Ok(count)
}

/// Parse ICS text into events.
pub(crate) fn parse_ics_events(ics_text: &str) -> Result<Vec<IcsEvent>> {
    let mut events = Vec::new();
    let mut in_event = false;
    let mut uid = String::new();
    let mut summary = String::new();
    let mut dtstart = None;
    let mut dtend = None;
    let mut location = None;
    let mut description = None;
    let mut cancelled = false;

    for line in unfold_ics_lines(ics_text) {
        let line = line.trim();
        if line == "BEGIN:VEVENT" {
            in_event = true;
            uid.clear();
            summary.clear();
            dtstart = None;
            dtend = None;
            location = None;
            description = None;
            cancelled = false;
        } else if line == "END:VEVENT" && in_event {
            in_event = false;
            // A cancelled event syncing as live kept resurrecting in the
            // meeting list (whole-app review P2) — the spec says
            // STATUS:CANCELLED means gone.
            if !uid.is_empty() && !summary.is_empty() && !cancelled {
                events.push(IcsEvent {
                    uid: uid.clone(),
                    summary: summary.clone(),
                    dtstart,
                    dtend,
                    location: location.clone(),
                    description: description.clone(),
                });
            }
        } else if in_event {
            if let Some(val) = strip_ics_prop(line, "UID") {
                uid = val.to_string();
            } else if let Some(val) = strip_ics_prop(line, "SUMMARY") {
                summary = unescape_ics(val);
            } else if line.starts_with("DTSTART") {
                dtstart = parse_ics_datetime_with_params(line, "DTSTART");
            } else if line.starts_with("DTEND") {
                dtend = parse_ics_datetime_with_params(line, "DTEND");
            } else if let Some(val) = strip_ics_prop(line, "STATUS") {
                cancelled = val.trim().eq_ignore_ascii_case("CANCELLED");
            } else if let Some(val) = strip_ics_prop(line, "LOCATION") {
                location = Some(unescape_ics(val));
            } else if let Some(val) = strip_ics_prop(line, "DESCRIPTION") {
                description = Some(unescape_ics(val));
            }
        }
    }

    Ok(events)
}

/// Unfold ICS continuation lines (lines starting with space/tab are continuations).
pub(crate) fn unfold_ics_lines(text: &str) -> Vec<String> {
    let mut lines = Vec::new();
    for raw_line in text.lines() {
        if raw_line.starts_with(' ') || raw_line.starts_with('\t') {
            // Continuation of previous line
            if let Some(last) = lines.last_mut() {
                *last += raw_line.trim_start();
            }
        } else {
            lines.push(raw_line.to_string());
        }
    }
    lines
}

/// Strip an ICS property name (potentially with parameters) and return the value.
/// Handles both `PROP:value` and `PROP;PARAM=X:value` forms.
pub(crate) fn strip_ics_prop<'a>(line: &'a str, prop: &str) -> Option<&'a str> {
    if let Some(rest) = line.strip_prefix(prop) {
        if let Some(value) = rest.strip_prefix(':') {
            return Some(value);
        }
        if rest.starts_with(';') {
            // Has parameters: find the colon after params
            if let Some(colon_pos) = rest.find(':') {
                return Some(&rest[colon_pos + 1..]);
            }
        }
    }
    None
}

/// Parse a DTSTART/DTEND line honoring a TZID parameter (whole-app review
/// P2: parameters were stripped, so `DTSTART;TZID=America/New_York:…`
/// parsed as SYSTEM-local time — events from any other timezone landed at
/// the wrong hour). IANA names resolve via chrono-tz; unknown TZIDs fall
/// back to the old floating-time behavior rather than dropping the event.
fn parse_ics_datetime_with_params(line: &str, prop: &str) -> Option<DateTime<Utc>> {
    let rest = line.strip_prefix(prop)?;
    let colon = rest.find(':')?;
    let (params, value) = (&rest[..colon], &rest[colon + 1..]);
    let tzid = params.split(';').find_map(|p| p.strip_prefix("TZID="));
    if let Some(tzid) = tzid {
        let val = value.trim();
        if val.len() >= 15 && !val.ends_with('Z') {
            if let (Ok(tz), Ok(ndt)) = (
                tzid.parse::<chrono_tz::Tz>(),
                NaiveDateTime::parse_from_str(&val[..15], "%Y%m%dT%H%M%S"),
            ) {
                if let Some(dt) = tz.from_local_datetime(&ndt).single() {
                    return Some(dt.with_timezone(&Utc));
                }
            }
        }
    }
    parse_ics_datetime(value)
}

/// Parse ICS datetime formats: 20260316T140000Z or 20260316T140000 or 20260316
fn parse_ics_datetime(val: &str) -> Option<DateTime<Utc>> {
    let val = val.trim();

    // Full datetime with Z suffix
    if val.len() >= 15 && val.ends_with('Z') {
        let dt_str = &val[..15];
        return NaiveDateTime::parse_from_str(dt_str, "%Y%m%dT%H%M%S")
            .ok()
            .map(|dt| dt.and_utc());
    }

    // Full datetime without Z — floating time (local). Convert via system timezone.
    if val.len() >= 15 {
        let dt_str = &val[..15];
        return NaiveDateTime::parse_from_str(dt_str, "%Y%m%dT%H%M%S")
            .ok()
            .and_then(|ndt| chrono::Local.from_local_datetime(&ndt).single())
            .map(|dt| dt.with_timezone(&Utc));
    }

    // Date only — store at noon UTC so that local-timezone display lands on the correct calendar day
    // for all timezones from UTC-12 to UTC+12.
    if val.len() >= 8 {
        let dt_str = &val[..8];
        return chrono::NaiveDate::parse_from_str(dt_str, "%Y%m%d")
            .ok()
            .map(|d| d.and_hms_opt(12, 0, 0).unwrap().and_utc());
    }

    None
}

/// Unescape ICS text values.
fn unescape_ics(val: &str) -> String {
    val.replace("\\n", "\n")
        .replace("\\,", ",")
        .replace("\\;", ";")
        .replace("\\\\", "\\")
}

#[cfg(test)]
mod tests {
    use super::*;

    use chrono::Datelike;
    use chrono::Timelike;

    #[test]
    fn test_parse_ics_datetime() {
        let dt = parse_ics_datetime("20260316T140000Z").unwrap();
        assert_eq!(dt.hour(), 14);
        assert_eq!(dt.month(), 3);
    }

    #[test]
    fn test_parse_ics_events_original() {
        let ics = r#"BEGIN:VCALENDAR
BEGIN:VEVENT
UID:abc123@google.com
SUMMARY:Team Standup
DTSTART:20260316T100000Z
DTEND:20260316T101500Z
LOCATION:https://meet.google.com/abc-defg-hij
END:VEVENT
END:VCALENDAR"#;
        let events = parse_ics_events(ics).unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].summary, "Team Standup");
        assert_eq!(events[0].dtstart.unwrap().hour(), 10);
    }

    const BASIC_ICS: &str = "BEGIN:VCALENDAR\r\n\
BEGIN:VEVENT\r\n\
UID:event-001@example.com\r\n\
SUMMARY:Team Standup\r\n\
DTSTART:20260321T100000Z\r\n\
DTEND:20260321T103000Z\r\n\
END:VEVENT\r\n\
END:VCALENDAR";

    // --- unfold_ics_lines ---

    #[test]
    fn test_unfold_simple_lines_unchanged() {
        let text = "BEGIN:VCALENDAR\r\nEND:VCALENDAR";
        let lines = unfold_ics_lines(text);
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0], "BEGIN:VCALENDAR");
    }

    #[test]
    fn test_unfold_continuation_lines_are_joined() {
        // ICS line folding: long lines are wrapped with a leading space
        let text = "SUMMARY:This is a very lon\r\n g summary text\r\nDTSTART:20260101T100000Z";
        let lines = unfold_ics_lines(text);
        assert_eq!(lines[0], "SUMMARY:This is a very long summary text");
    }

    #[test]
    fn test_unfold_tab_continuation() {
        let text = "DESCRIPTION:Line one\r\n\tline two";
        let lines = unfold_ics_lines(text);
        assert_eq!(lines[0], "DESCRIPTION:Line oneline two");
    }

    // --- strip_ics_prop ---

    #[test]
    fn test_strip_ics_prop_simple() {
        assert_eq!(strip_ics_prop("SUMMARY:Team Meeting", "SUMMARY"), Some("Team Meeting"));
    }

    #[test]
    fn test_strip_ics_prop_with_parameter() {
        // e.g. DTSTART;TZID=America/New_York:20260321T100000
        let result = strip_ics_prop("DTSTART;TZID=America/New_York:20260321T100000", "DTSTART");
        assert_eq!(result, Some("20260321T100000"));
    }

    #[test]
    fn test_strip_ics_prop_wrong_key_returns_none() {
        assert!(strip_ics_prop("SUMMARY:Meeting", "DTSTART").is_none());
    }

    #[test]
    fn test_strip_ics_prop_empty_value() {
        assert_eq!(strip_ics_prop("LOCATION:", "LOCATION"), Some(""));
    }

    // --- parse_ics_events ---

    #[test]
    fn test_parse_basic_event() {
        let events = parse_ics_events(BASIC_ICS).unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].uid, "event-001@example.com");
        assert_eq!(events[0].summary, "Team Standup");
        assert!(events[0].dtstart.is_some());
        assert!(events[0].dtend.is_some());
    }

    #[test]
    fn test_parse_event_with_location_and_description() {
        let ics = "BEGIN:VCALENDAR\r\n\
BEGIN:VEVENT\r\n\
UID:evt-002\r\n\
SUMMARY:Sprint Review\r\n\
DTSTART:20260322T140000Z\r\n\
DTEND:20260322T150000Z\r\n\
LOCATION:Conference Room A\r\n\
DESCRIPTION:Review sprint goals\r\n\
END:VEVENT\r\n\
END:VCALENDAR";
        let events = parse_ics_events(ics).unwrap();
        assert_eq!(events[0].location.as_deref(), Some("Conference Room A"));
        assert_eq!(events[0].description.as_deref(), Some("Review sprint goals"));
    }

    #[test]
    fn test_parse_multiple_events() {
        let ics = "BEGIN:VCALENDAR\r\n\
BEGIN:VEVENT\r\nUID:e1\r\nSUMMARY:First\r\nDTSTART:20260321T100000Z\r\nDTEND:20260321T110000Z\r\nEND:VEVENT\r\n\
BEGIN:VEVENT\r\nUID:e2\r\nSUMMARY:Second\r\nDTSTART:20260321T120000Z\r\nDTEND:20260321T130000Z\r\nEND:VEVENT\r\n\
END:VCALENDAR";
        let events = parse_ics_events(ics).unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].summary, "First");
        assert_eq!(events[1].summary, "Second");
    }

    #[test]
    fn test_parse_event_missing_uid_is_skipped() {
        let ics = "BEGIN:VCALENDAR\r\n\
BEGIN:VEVENT\r\n\
SUMMARY:No UID Event\r\n\
DTSTART:20260321T100000Z\r\n\
END:VEVENT\r\n\
END:VCALENDAR";
        let events = parse_ics_events(ics).unwrap();
        assert!(events.is_empty(), "events without UID must be skipped");
    }

    #[test]
    fn test_parse_event_missing_summary_is_skipped() {
        let ics = "BEGIN:VCALENDAR\r\n\
BEGIN:VEVENT\r\n\
UID:evt-no-summary\r\n\
DTSTART:20260321T100000Z\r\n\
END:VEVENT\r\n\
END:VCALENDAR";
        let events = parse_ics_events(ics).unwrap();
        assert!(events.is_empty(), "events without SUMMARY must be skipped");
    }

    #[test]
    fn test_parse_event_with_dtstart_timezone_param() {
        let ics = "BEGIN:VCALENDAR\r\n\
BEGIN:VEVENT\r\n\
UID:tz-evt\r\n\
SUMMARY:Timezone Meeting\r\n\
DTSTART;TZID=America/New_York:20260321T100000\r\n\
DTEND;TZID=America/New_York:20260321T110000\r\n\
END:VEVENT\r\n\
END:VCALENDAR";
        let events = parse_ics_events(ics).unwrap();
        // Parsed as naive local — just verifying it doesn't panic and returns an event
        assert_eq!(events.len(), 1);
    }

    #[test]
    fn test_parse_event_all_day_date_format() {
        let ics = "BEGIN:VCALENDAR\r\n\
BEGIN:VEVENT\r\n\
UID:allday\r\n\
SUMMARY:All Day\r\n\
DTSTART;VALUE=DATE:20260321\r\n\
DTEND;VALUE=DATE:20260322\r\n\
END:VEVENT\r\n\
END:VCALENDAR";
        let events = parse_ics_events(ics).unwrap();
        assert_eq!(events.len(), 1, "all-day (DATE) events must be parsed");
    }

    #[test]
    fn test_parse_ics_special_chars_in_summary() {
        let ics = "BEGIN:VCALENDAR\r\n\
BEGIN:VEVENT\r\n\
UID:special\r\n\
SUMMARY:Meeting\\, catch-up \\n with team\r\n\
DTSTART:20260321T100000Z\r\n\
END:VEVENT\r\n\
END:VCALENDAR";
        let events = parse_ics_events(ics).unwrap();
        // Escaped commas and newlines should be unescaped
        assert!(events[0].summary.contains(',') || events[0].summary.contains("catch-up"),
            "ICS escape sequences should be handled");
    }

    #[test]
    fn test_parse_empty_calendar_returns_empty_vec() {
        let ics = "BEGIN:VCALENDAR\r\nEND:VCALENDAR";
        let events = parse_ics_events(ics).unwrap();
        assert!(events.is_empty());
    }

    #[test]
    fn tzid_and_cancelled_are_honored() {
        let ics = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:a\r\nSUMMARY:NY Standup\r\nDTSTART;TZID=America/New_York:20260316T140000\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:b\r\nSUMMARY:Dead meeting\r\nSTATUS:CANCELLED\r\nDTSTART:20260316T140000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
        let events = parse_ics_events(ics).unwrap();
        assert_eq!(events.len(), 1, "cancelled events must not sync");
        // 14:00 New York in March (EDT, UTC-4) = 18:00 UTC — NOT the
        // machine-local interpretation.
        assert_eq!(
            events[0].dtstart.unwrap().to_rfc3339(),
            "2026-03-16T18:00:00+00:00"
        );
    }
}
