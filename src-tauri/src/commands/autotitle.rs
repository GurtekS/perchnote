use tauri::{AppHandle, Emitter, Manager};

use crate::db::Database;
use crate::transcription::whisper::TranscriptSegment;

/// Self-titling for placeholder meetings: a meeting created without a real
/// title swaps it for a short descriptor drawn from the finished transcript.
///
/// Hard rules:
/// - Only the exact strings the app's own creation sites write qualify:
///   "Untitled Meeting" and "Meeting — <en-US creation stamp>". A user-typed
///   title — even one literally named "Meeting" or "Untitled" — is never
///   touched, because the app never writes those strings itself.
/// - Calendar-linked meetings are skipped entirely: their title belongs to
///   the sync machinery (UID-churn adoption re-finds orphaned events by
///   feed title + start, which a retitle would break into duplicates).
/// - The swap is a compare-and-swap against the placeholder, so a rename
///   that lands while the AI call is in flight always wins.
/// - Voice notes are excluded; they self-title from their opening words in
///   the frontend (dictation IS the content — its first words beat a topic).
/// - `auto_title_on_complete` gates the pass (default ON, only "false"
///   disables — same pattern as `auto_enhance_on_complete`/`auto_diarize`).

/// The opening of a meeting carries the agenda…
const TITLE_HEAD_CHARS: usize = 3_000;
/// …and the wrap-up often names what it was really about.
const TITLE_TAIL_CHARS: usize = 1_000;
/// A hung provider must not stall the rest of the completion pipeline —
/// instant recap waits behind this so the auto-enhance mirror is born under
/// the final filename instead of being renamed one save later.
const TITLE_TIMEOUT_SECS: u64 = 30;

/// Only titles the app itself writes when the user provides none:
/// "Untitled Meeting" (new-without-recording, notes-first, calendar
/// no-title fallback) and the ⌘N/deep-link "Meeting — <creation stamp>".
/// Deliberately NOT bare "Meeting"/"Untitled"/"New meeting" — no creation
/// site has ever written those, so a meeting carrying one was named by the
/// user (or their calendar) and is theirs.
pub(crate) fn is_placeholder_title(title: &str) -> bool {
    let t = title.trim();
    if t.eq_ignore_ascii_case("untitled meeting") {
        return true;
    }
    // "Meeting — Jun 11, 6:05 PM" / "Meeting — Jun 9 at 11:53 AM" (the two
    // glues en-US Intl produces). The whole suffix must be date-shaped:
    // "Meeting — Mar 3 budget kickoff" is a real title.
    if let Some(rest) = t.strip_prefix("Meeting — ") {
        return looks_like_datestamp(rest);
    }
    false
}

/// Strictly matches the en-US creation stamp the ⌘N sites write with
/// Intl.DateTimeFormat: `Mon D[,| at] H:MM AM|PM` — and nothing more.
/// Any extra words mean a human wrote the title.
fn looks_like_datestamp(s: &str) -> bool {
    const MONTHS: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    // U+202F (the narrow no-break space newer ICU puts before AM/PM) is
    // whitespace to Rust, so split_whitespace handles every glue variant.
    let toks: Vec<&str> = s.split_whitespace().collect();
    if !(3..=5).contains(&toks.len()) || !MONTHS.contains(&toks[0]) {
        return false;
    }
    let day = toks[1].trim_end_matches(',');
    if day.is_empty() || day.len() > 2 || !day.chars().all(|c| c.is_ascii_digit()) {
        return false;
    }
    let mut rest: &[&str] = &toks[2..];
    if rest.first().copied() == Some("at") {
        rest = &rest[1..];
    }
    let (time, ampm) = match rest {
        [time, ampm] => (*time, *ampm),
        // Fused "6:05PM" — defensive; current ICU always separates them.
        [fused] => {
            let lower = fused.to_ascii_lowercase();
            let Some(time) = lower
                .strip_suffix("am")
                .or_else(|| lower.strip_suffix("pm"))
            else {
                return false;
            };
            return is_clock(time);
        }
        _ => return false,
    };
    is_clock(time) && matches!(ampm.to_ascii_uppercase().as_str(), "AM" | "PM")
}

/// `H:MM` with a 1-2 digit hour.
fn is_clock(s: &str) -> bool {
    let mut parts = s.splitn(2, ':');
    match (parts.next(), parts.next()) {
        (Some(h), Some(m)) => {
            (1..=2).contains(&h.len())
                && h.chars().all(|c| c.is_ascii_digit())
                && m.len() == 2
                && m.chars().all(|c| c.is_ascii_digit())
        }
        _ => false,
    }
}

/// Plain text lines from the head of the transcript, then — if the budget
/// cut anything — the newest lines after a gap marker. No timestamps or
/// speakers: the title call wants topics, not structure.
pub(crate) fn transcript_excerpt(
    segments: &[TranscriptSegment],
    head_cap: usize,
    tail_cap: usize,
) -> String {
    let texts: Vec<&str> = segments
        .iter()
        .map(|s| s.text.trim())
        .filter(|t| !t.is_empty())
        .collect();
    if texts.is_empty() {
        return String::new();
    }
    let mut head: Vec<&str> = Vec::new();
    let mut used = 0usize;
    for t in &texts {
        if used + t.len() > head_cap && !head.is_empty() {
            break;
        }
        used += t.len();
        head.push(t);
    }
    let mut out = head.join("\n");
    if head.len() < texts.len() {
        let mut tail: Vec<&str> = Vec::new();
        let mut tail_used = 0usize;
        for t in texts[head.len()..].iter().rev() {
            if tail_used + t.len() > tail_cap && !tail.is_empty() {
                break;
            }
            tail_used += t.len();
            tail.push(t);
        }
        tail.reverse();
        out.push_str("\n[…]\n");
        out.push_str(&tail.join("\n"));
    }
    out
}

/// Replies that are scaffolding around a title rather than a title. A line
/// starting with one of these is conversational preamble, never the answer.
const PREAMBLE_STARTS: [&str; 10] = [
    "here is", "here's", "here are", "sure", "certainly", "okay", "of course",
    "i'm sorry", "i am sorry", "as an ai",
];
/// Outright-useless candidates, plus the prompt's own examples (a small
/// model echoing the example verbatim is a non-answer, not a coincidence).
const JUNK_TITLES: [&str; 7] = [
    "meeting", "untitled meeting", "untitled", "new meeting", "transcript",
    "acme renewal pricing decision", "hiring plan for the support team",
];

/// Model output → a title fit for the meeting list, or None when the reply
/// is unusable. Built for the chatty failure modes of small local models:
/// <think> blocks, "Here is a title:" preambles, bullet lists, prose
/// sentences. Char-based throughout — never byte offsets (the
/// extract_snippet panic class).
pub(crate) fn sanitize_title(raw: &str) -> Option<String> {
    // Reasoning models (qwen3, deepseek-r1) wrap deliberation in
    // <think>…</think>; the answer follows the close tag. An unclosed
    // block means the reply is all deliberation — reject.
    let after_think = match (raw.contains("<think>"), raw.rsplit_once("</think>")) {
        (true, Some((_, after))) => after,
        (true, None) => return None,
        (false, _) => raw,
    };
    let lines: Vec<&str> = after_think
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect();
    let mut candidate = *lines.first()?;
    // "Here is a short title for the meeting:" → the answer is the next
    // line. "Title: Q3 budget review" → the answer is after the colon.
    if let Some((before, after)) = candidate.split_once(':') {
        let before_lower = before.to_lowercase();
        let is_scaffold = before_lower.contains("title")
            || before_lower.contains("option")
            || PREAMBLE_STARTS.iter().any(|p| before_lower.starts_with(p));
        if is_scaffold {
            let after = after.trim();
            if !after.is_empty() {
                candidate = after;
            } else {
                candidate = lines.get(1).copied()?;
            }
        }
    }
    // List markers: "- Q3 budget review" / "1. Q3 budget review".
    let candidate = candidate
        .trim_start_matches(['-', '*', '•', '–'])
        .trim_start();
    let candidate = match candidate.split_once(". ") {
        Some((n, rest)) if !n.is_empty() && n.chars().all(|c| c.is_ascii_digit()) => rest,
        _ => candidate,
    };
    let candidate = candidate
        .trim_matches(|c: char| matches!(c, '"' | '\u{201c}' | '\u{201d}' | '\'' | '`' | '*' | '#'))
        .trim();
    let candidate = candidate.trim_end_matches(['.', '…', '!', ',', ':']).trim();
    let collapsed = candidate.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.chars().count() < 3 {
        return None;
    }
    let lower = collapsed.to_lowercase();
    if JUNK_TITLES.contains(&lower.as_str()) {
        return None;
    }
    if PREAMBLE_STARTS.iter().any(|p| lower.starts_with(p)) {
        return None;
    }
    // The prompt asks for 3-7 words; far past that it's a sentence of
    // scaffolding that slipped every other check, not a title.
    if collapsed.split(' ').count() > 12 {
        return None;
    }
    // Word-boundary cap; even good models pad occasionally.
    let mut out = String::new();
    for word in collapsed.split(' ') {
        let next_len = out.chars().count() + usize::from(!out.is_empty()) + word.chars().count();
        if next_len > 60 && !out.is_empty() {
            break;
        }
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(word);
    }
    if out.chars().count() > 60 {
        out = out.chars().take(60).collect::<String>().trim_end().to_string();
    }
    Some(out)
}

/// Run the swap for one completed meeting. Every exit short of the CAS
/// succeeding leaves the placeholder in place — which is always a safe
/// outcome; the user can rename by hand exactly as before.
pub async fn autotitle_on_complete(app: &AppHandle, meeting_id: &str) {
    let db = app.state::<Database>();
    let enabled = db
        .get_setting("auto_title_on_complete")
        .ok()
        .flatten()
        .as_deref()
        != Some("false");
    if !enabled {
        return;
    }
    let Ok(Some(meeting)) = db.get_meeting(meeting_id) else {
        return;
    };
    if !is_placeholder_title(&meeting.title) {
        return;
    }
    // Calendar-synced meetings keep their feed title even when it's the
    // no-title fallback: UID-churn adoption re-finds orphaned events by
    // (feed title, scheduled_start) — retitling would turn provider UID
    // re-issues into permanent duplicates.
    if meeting.calendar_event_id.is_some() {
        return;
    }
    if !crate::ai::is_configured(&db) {
        return;
    }
    let Ok(Some(transcript)) = db.get_transcript_by_meeting(meeting_id) else {
        return;
    };
    let segments: Vec<TranscriptSegment> =
        serde_json::from_str(&transcript.segments).unwrap_or_default();
    let excerpt = transcript_excerpt(&segments, TITLE_HEAD_CHARS, TITLE_TAIL_CHARS);
    if excerpt.is_empty() {
        return;
    }
    let prompt = format!(
        "Excerpts from a meeting transcript are fenced below ([…] marks skipped \
         middle content).\n\n<transcript>\n{excerpt}\n</transcript>\n\nReply with \
         ONLY a short descriptive title for the meeting in the <transcript> block: \
         3 to 7 words, plain text, no quotes, no trailing punctuation, no dates. \
         Name the specific topic, project, or decision (in the style of \
         \"Acme renewal pricing decision\" or \"Hiring plan for the support \
         team\", but drawn from this transcript). Avoid generic words like \
         \"meeting\" or \"discussion\" unless nothing more specific was said."
    );
    let raw = match tokio::time::timeout(
        std::time::Duration::from_secs(TITLE_TIMEOUT_SECS),
        crate::ai::chat(&db, &prompt),
    )
    .await
    {
        Ok(Ok(reply)) => reply,
        Ok(Err(e)) => {
            log::warn!("auto-title: {meeting_id} generation failed: {e}");
            return;
        }
        Err(_) => {
            log::warn!("auto-title: {meeting_id} timed out after {TITLE_TIMEOUT_SECS}s");
            return;
        }
    };
    let Some(title) = sanitize_title(&raw) else {
        log::warn!("auto-title: {meeting_id} reply unusable: {raw:?}");
        return;
    };
    if title == meeting.title {
        return;
    }
    match db.update_meeting_title_if_unchanged(meeting_id, &meeting.title, &title) {
        Ok(true) => {
            log::info!("auto-title: {meeting_id} → {title:?}");
            let _ = app.emit(
                "meeting-retitled",
                serde_json::json!({
                    "meeting_id": meeting_id,
                    "title": title,
                    "previous_title": meeting.title,
                }),
            );
        }
        Ok(false) => {
            log::info!(
                "auto-title: {meeting_id} title changed (or meeting deleted) mid-flight — leaving it"
            );
        }
        Err(e) => log::warn!("auto-title: {meeting_id} title update failed: {e}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn segs(texts: &[&str]) -> Vec<TranscriptSegment> {
        texts
            .iter()
            .enumerate()
            .map(|(i, t)| {
                serde_json::from_value(serde_json::json!({
                    "text": t,
                    "start_ms": i as u64 * 1000,
                    "end_ms": i as u64 * 1000 + 900,
                }))
                .unwrap()
            })
            .collect()
    }

    #[test]
    fn app_written_placeholders_are_detected() {
        for t in [
            "Untitled Meeting",
            "untitled meeting",
            "  Untitled Meeting  ",
            // Comma glue (older ICU) and "at" glue (the shipped WKWebView's
            // en-US output — see the series tests in db/queries.rs).
            "Meeting — Jun 11, 6:05 PM",
            "Meeting — Dec 3, 12:00 AM",
            "Meeting — Jun 9 at 11:53 AM",
            "Meeting — May 5 at 9:00 AM",
            "Meeting — Sep 30 at 12:00 AM",
        ] {
            assert!(is_placeholder_title(t), "{t:?} should be a placeholder");
        }
    }

    #[test]
    fn user_titles_are_never_placeholders() {
        for t in [
            "Q3 Budget Review",
            "Meeting — Budget review",   // en-dash but no datestamp: user-typed
            "Meeting — Mar 3 budget kickoff", // date-opening suffix, real words after
            "Meeting — Dec 10 board prep",
            "Meeting — May 5K planning",
            "Meeting with Sam",
            "1:1 with Amy Chen",
            "Voice note — Jun 11, 6:05 PM", // voice notes self-title elsewhere
            "Meetings retrospective",
            "Junk drawer cleanup",
            // The app never writes these; a meeting carrying one was named
            // by the user (or their calendar) and is theirs.
            "Meeting",
            "New meeting",
            "Untitled",
            "",
        ] {
            assert!(!is_placeholder_title(t), "{t:?} should NOT be a placeholder");
        }
    }

    #[test]
    fn sanitize_strips_wrapping_and_prefixes() {
        assert_eq!(
            sanitize_title("Title: \"Q3 budget review.\"").as_deref(),
            Some("Q3 budget review")
        );
        assert_eq!(sanitize_title("**Acme renewal kickoff**").as_deref(), Some("Acme renewal kickoff"));
        assert_eq!(
            sanitize_title("Q3 budget review\n\nThis title reflects…").as_deref(),
            Some("Q3 budget review")
        );
        assert_eq!(sanitize_title("  spaced   out   title  ").as_deref(), Some("spaced out title"));
    }

    #[test]
    fn sanitize_unwraps_chatty_model_scaffolding() {
        // Preamble + colon + answer on the same line.
        assert_eq!(
            sanitize_title("Here is a title: Q3 budget review").as_deref(),
            Some("Q3 budget review")
        );
        // Preamble line ending in a colon, answer on the next line.
        assert_eq!(
            sanitize_title("Sure, here's a short title for the meeting:\n\nQ3 Budget Review")
                .as_deref(),
            Some("Q3 Budget Review")
        );
        // Bullet and numbered lists take the first item.
        assert_eq!(
            sanitize_title("- Q3 budget review\n- Acme renewal kickoff").as_deref(),
            Some("Q3 budget review")
        );
        assert_eq!(sanitize_title("1. Q3 budget review").as_deref(), Some("Q3 budget review"));
        assert_eq!(
            sanitize_title("Here are some options:\n1. Q3 budget review").as_deref(),
            Some("Q3 budget review")
        );
        // Reasoning models: the answer follows the </think> close.
        assert_eq!(
            sanitize_title("<think>\nThe user wants a title…\n</think>\nQ3 Budget Review")
                .as_deref(),
            Some("Q3 Budget Review")
        );
        // …and an unclosed think block is all deliberation, no answer.
        assert_eq!(sanitize_title("<think>\nHmm, the transcript covers…"), None);
    }

    #[test]
    fn sanitize_rejects_junk_replies() {
        for raw in [
            "",
            "  \n  ",
            "Meeting",
            "Untitled",
            "\"Meeting\"",
            "I'm sorry, I can't summarize this transcript.",
            "As an AI, I cannot name this meeting.",
            // A prose sentence that dodged the preamble checks is not a title.
            "The speakers in this transcript spend most of their time going back and forth about scheduling",
            // Echoing the prompt's own example is a non-answer.
            "Acme renewal pricing decision",
            // Preamble with no extractable answer anywhere.
            "Sure! The best title would be something about budgets",
        ] {
            assert_eq!(sanitize_title(raw), None, "{raw:?} should be rejected");
        }
    }

    #[test]
    fn sanitize_caps_length_at_a_word_boundary() {
        let long = "alpha bravo charlie delta echo foxtrot golf hotel india juliet";
        let out = sanitize_title(long).unwrap();
        assert!(out.chars().count() <= 60, "got {} chars", out.chars().count());
        assert!(!out.ends_with(' '));
        assert!(long.starts_with(&out));
        // A single overlong word still comes back bounded.
        let one_word = "x".repeat(200);
        assert!(sanitize_title(&one_word).unwrap().chars().count() <= 60);
    }

    #[test]
    fn excerpt_takes_head_then_tail_with_gap_marker() {
        let segments = segs(&["aaaa", "bbbb", "cccc", "dddd", "eeee"]);
        let out = transcript_excerpt(&segments, 9, 5);
        // head fits two segments (4+4 ≤ 9, third overflows), tail fits the last.
        assert_eq!(out, "aaaa\nbbbb\n[…]\neeee");
        // Everything fits → no marker.
        let all = transcript_excerpt(&segments, 1000, 1000);
        assert_eq!(all, "aaaa\nbbbb\ncccc\ndddd\neeee");
    }

    #[test]
    fn excerpt_skips_blanks_and_handles_empty() {
        assert_eq!(transcript_excerpt(&[], 100, 100), "");
        let blank = segs(&["   ", "", "real words"]);
        assert_eq!(transcript_excerpt(&blank, 100, 100), "real words");
    }
}
