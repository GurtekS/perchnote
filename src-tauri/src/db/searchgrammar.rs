//! Search filter grammar (plan v8 A2).
//!
//! Parses `speaker:` / `before:` / `after:` / `folder:` filters, quoted
//! phrases, and a trailing-`*` prefix out of a raw search query, leaving a
//! sanitized FTS5 MATCH string. The same hostile-input rules as
//! `sanitize_fts_query` apply to every term that reaches FTS: strip to
//! alphanumeric+whitespace, ≤64 chars per term, ≤20 terms — user text is
//! never treated as FTS grammar (`OR` stays a literal word).
//!
//! `speaker:` keys on diarization labels (speaker_labels.display_name) or
//! raw speaker keys — NEVER ICS attendees (the user's calendar carries no
//! attendee data, and attendee-keyed features are out per project policy).

/// A query decomposed into FTS terms and meeting-level filters.
#[derive(Debug, Default, PartialEq)]
pub(crate) struct ParsedQuery {
    /// FTS5 MATCH string: quoted phrases/terms, prefix terms as `"stem"*`.
    /// Empty when no term survived sanitization.
    pub fts: String,
    /// The non-filter query text with quotes/stars stripped but punctuation
    /// kept — what LIKE arms and snippet extraction should center on.
    pub plain_text: String,
    /// Case-insensitive needle against speaker display names or raw keys.
    pub speaker: Option<String>,
    /// Exclusive upper bound on the meeting date (`date < before`), ISO day.
    pub before: Option<String>,
    /// Inclusive lower bound on the meeting date (`date >= after`), ISO day.
    pub after: Option<String>,
    /// Case-insensitive contains-needle against folder names.
    pub folder: Option<String>,
}

impl ParsedQuery {
    pub fn has_filters(&self) -> bool {
        self.speaker.is_some()
            || self.before.is_some()
            || self.after.is_some()
            || self.folder.is_some()
    }
}

/// Split into whitespace-delimited tokens, where double quotes group — both
/// bare (`"quarterly budget"`) and as a filter value (`folder:"Work stuff"`).
/// An unterminated quote runs to the end of input.
fn tokenize(raw: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut cur = String::new();
    let mut in_quotes = false;
    for c in raw.chars() {
        match c {
            '"' => {
                in_quotes = !in_quotes;
                cur.push('"');
            }
            c if c.is_whitespace() && !in_quotes => {
                if !cur.is_empty() {
                    tokens.push(std::mem::take(&mut cur));
                }
            }
            c => cur.push(c),
        }
    }
    if !cur.is_empty() {
        tokens.push(cur);
    }
    tokens
}

/// Strip surrounding double quotes (a lone `"` strips to nothing).
fn unquote(s: &str) -> String {
    s.trim_matches('"').to_string()
}

/// FTS-sanitize one term's inner text: alphanumeric/whitespace only,
/// whitespace collapsed. Returns None when nothing survives.
fn sanitize_inner(s: &str) -> Option<String> {
    let cleaned: String = s
        .chars()
        .map(|c| if c.is_alphanumeric() || c.is_whitespace() { c } else { ' ' })
        .collect();
    let words: Vec<&str> = cleaned
        .split_whitespace()
        .filter(|w| w.len() <= 64)
        .collect();
    if words.is_empty() {
        None
    } else {
        Some(words.join(" "))
    }
}

/// Exactly `YYYY-MM-DD` with plausible month/day ranges. Filters carrying
/// anything else are dropped entirely (not demoted to search terms — the
/// user typed filter intent, and the fragment would only pollute matches).
fn is_iso_date(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return false;
    }
    let digits = |r: std::ops::Range<usize>| b[r].iter().all(|c| c.is_ascii_digit());
    if !digits(0..4) || !digits(5..7) || !digits(8..10) {
        return false;
    }
    let month: u8 = s[5..7].parse().unwrap_or(0);
    let day: u8 = s[8..10].parse().unwrap_or(0);
    (1..=12).contains(&month) && (1..=31).contains(&day)
}

/// Parse a raw query into FTS terms + filters. Later duplicates of the same
/// filter win (`speaker:a speaker:b` → b).
pub(crate) fn parse_search_query(raw: &str) -> ParsedQuery {
    let mut out = ParsedQuery::default();
    let mut fts_terms: Vec<String> = Vec::new();
    let mut plain_words: Vec<String> = Vec::new();

    for token in tokenize(raw) {
        // `key:value` filters (key is case-insensitive; value may be quoted).
        let lower = token.to_lowercase();
        let filter = ["speaker:", "before:", "after:", "folder:"]
            .iter()
            .find(|k| lower.starts_with(**k))
            .map(|k| (&lower[..k.len() - 1], unquote(&token[k.len()..])));
        if let Some((key, value)) = filter {
            if value.is_empty() {
                continue;
            }
            match key {
                "speaker" => out.speaker = Some(value.to_lowercase()),
                "folder" => out.folder = Some(value.to_lowercase()),
                "before" if is_iso_date(&value) => out.before = Some(value),
                "after" if is_iso_date(&value) => out.after = Some(value),
                _ => {} // before:/after: with a malformed date — dropped
            }
            continue;
        }

        if fts_terms.len() >= 20 {
            continue; // term cap — same DoS bound as sanitize_fts_query
        }

        // Trailing `*` on an unquoted token → FTS prefix query. Stems
        // shorter than 2 chars would be index scans; treat as plain text.
        let (body, prefix) = match token.strip_suffix('*') {
            Some(stem) if !stem.starts_with('"') => (stem.to_string(), true),
            _ => (token.clone(), false),
        };
        let inner = unquote(&body);
        if inner.is_empty() {
            continue;
        }
        plain_words.push(inner.clone());
        if let Some(clean) = sanitize_inner(&inner) {
            if prefix && clean.len() >= 2 && !clean.contains(' ') {
                fts_terms.push(format!("\"{}\"*", clean));
            } else {
                fts_terms.push(format!("\"{}\"", clean));
            }
        }
    }

    out.fts = fts_terms.join(" ");
    out.plain_text = plain_words.join(" ");
    out
}

/// Escape `%`, `_`, and `\` for use inside a `LIKE … ESCAPE '\'` pattern,
/// lowercased to pair with `lower(column)`.
pub(crate) fn escape_like(s: &str) -> String {
    s.to_lowercase()
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_terms_are_quoted_literals() {
        let p = parse_search_query("quarterly OR budget");
        assert_eq!(p.fts, r#""quarterly" "OR" "budget""#);
        assert_eq!(p.plain_text, "quarterly OR budget");
        assert!(!p.has_filters());
    }

    #[test]
    fn quoted_phrase_stays_one_unit() {
        let p = parse_search_query(r#""quarterly budget" review"#);
        assert_eq!(p.fts, r#""quarterly budget" "review""#);
        assert_eq!(p.plain_text, "quarterly budget review");
    }

    #[test]
    fn punctuation_stripped_for_fts_but_kept_in_plain_text() {
        let p = parse_search_query("C++ rollout!");
        assert_eq!(p.fts, r#""C" "rollout""#);
        // LIKE arms still see the raw words, so a "C++" title can match.
        assert_eq!(p.plain_text, "C++ rollout!");
    }

    #[test]
    fn speaker_filter_plain_and_quoted() {
        assert_eq!(
            parse_search_query("speaker:Amy budget").speaker.as_deref(),
            Some("amy")
        );
        let p = parse_search_query(r#"speaker:"Amy Patel" budget"#);
        assert_eq!(p.speaker.as_deref(), Some("amy patel"));
        assert_eq!(p.fts, r#""budget""#);
        assert_eq!(p.plain_text, "budget");
    }

    #[test]
    fn date_filters_validate_and_drop_garbage() {
        let p = parse_search_query("budget before:2026-06-01 after:2026-01-15");
        assert_eq!(p.before.as_deref(), Some("2026-06-01"));
        assert_eq!(p.after.as_deref(), Some("2026-01-15"));

        let bad = parse_search_query("budget before:junk after:2026-13-40");
        assert!(bad.before.is_none());
        assert!(bad.after.is_none());
        // The malformed filters don't leak into the FTS terms either.
        assert_eq!(bad.fts, r#""budget""#);
    }

    #[test]
    fn folder_filter_quoted_value() {
        let p = parse_search_query(r#"folder:"Work Stuff" sync"#);
        assert_eq!(p.folder.as_deref(), Some("work stuff"));
        assert_eq!(p.fts, r#""sync""#);
    }

    #[test]
    fn trailing_star_becomes_prefix_query() {
        assert_eq!(parse_search_query("budg*").fts, r#""budg"*"#);
        // 1-char stems and bare stars don't become scans.
        assert_eq!(parse_search_query("b*").fts, r#""b""#);
        assert_eq!(parse_search_query("*").fts, "");
    }

    #[test]
    fn filter_only_query_has_empty_fts() {
        let p = parse_search_query("speaker:amy");
        assert!(p.fts.is_empty());
        assert!(p.plain_text.is_empty());
        assert!(p.has_filters());
    }

    #[test]
    fn later_duplicate_filter_wins() {
        let p = parse_search_query("speaker:amy speaker:bob x");
        assert_eq!(p.speaker.as_deref(), Some("bob"));
    }

    #[test]
    fn term_cap_holds() {
        let many = (0..30).map(|i| format!("t{i}")).collect::<Vec<_>>().join(" ");
        let p = parse_search_query(&many);
        assert_eq!(p.fts.matches('"').count(), 40, "20 terms × 2 quotes");
    }

    #[test]
    fn empty_and_junk_queries_parse_to_nothing() {
        assert_eq!(parse_search_query(""), ParsedQuery::default());
        let p = parse_search_query("!!! ???");
        assert!(p.fts.is_empty());
        assert_eq!(p.plain_text, "!!! ???");
    }

    #[test]
    fn escape_like_neutralizes_wildcards() {
        assert_eq!(escape_like("50%_a\\b"), "50\\%\\_a\\\\b");
    }
}
