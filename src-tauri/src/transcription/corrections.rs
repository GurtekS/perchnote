//! Persistent transcript-correction rules (plan v10 #5).
//!
//! The same client name comes out of ASR wrong every meeting; v9 #8 lets
//! the user fix it everywhere once — this makes the fix STICK: rules are
//! stored in settings (`correction_rules`, a JSON array of {find, replace})
//! and applied to raw ASR output at transcription time — live chunks,
//! re-transcription, imports, all through the same choke point. They never
//! touch user-edited segments: application happens only where text is
//! BORN, not where it's stored.
//!
//! Matching is ASCII-case-insensitive char-by-char — the same semantics
//! (and the same deliberate avoidance of byte-offsets-on-case-folded-text,
//! the extract_snippet panic class) as `replace_in_transcript`.

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct CorrectionRule {
    pub find: String,
    pub replace: String,
}

/// Parse the stored JSON; malformed or absent → no rules (never an error —
/// a corrupt setting must not break transcription). Empty finds dropped.
pub fn parse_rules(stored: Option<&str>) -> Vec<CorrectionRule> {
    stored
        .and_then(|s| serde_json::from_str::<Vec<CorrectionRule>>(s).ok())
        .unwrap_or_default()
        .into_iter()
        .filter(|r| !r.find.trim().is_empty())
        .collect()
}

/// Apply every rule to one piece of ASR text, in stored order. Borrowed
/// from `replace_in_transcript`'s char-by-char scan: never computes byte
/// offsets on case-folded text.
pub fn apply_rules(text: &str, rules: &[CorrectionRule]) -> String {
    let mut out = text.to_string();
    for rule in rules {
        if let Some(replaced) = replace_ascii_ci(&out, &rule.find, &rule.replace) {
            out = replaced;
        }
    }
    out
}

fn replace_ascii_ci(text: &str, find: &str, replace: &str) -> Option<String> {
    let needle: Vec<char> = find.chars().collect();
    if needle.is_empty() {
        return None;
    }
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    let mut changed = false;
    while i < chars.len() {
        let matches = i + needle.len() <= chars.len()
            && needle
                .iter()
                .enumerate()
                .all(|(k, f)| chars[i + k].eq_ignore_ascii_case(f));
        if matches {
            out.push_str(replace);
            i += needle.len();
            changed = true;
        } else {
            out.push(chars[i]);
            i += 1;
        }
    }
    changed.then_some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rules_parse_leniently_and_apply_in_order() {
        assert!(parse_rules(None).is_empty());
        assert!(parse_rules(Some("not json")).is_empty());
        assert!(parse_rules(Some(r#"[{"find":"  ","replace":"x"}]"#)).is_empty());

        let rules = parse_rules(Some(
            r#"[{"find":"jon","replace":"John"},{"find":"perk note","replace":"Perchnote"}]"#,
        ));
        assert_eq!(rules.len(), 2);
        assert_eq!(
            apply_rules("Jon said perk note is ready, jon agreed", &rules),
            "John said Perchnote is ready, John agreed"
        );
    }

    #[test]
    fn application_is_ascii_ci_and_emoji_safe() {
        let rules = vec![CorrectionRule { find: "LAUNCH".into(), replace: "ship".into() }];
        assert_eq!(apply_rules("🎉🎉 launch party 🎉", &rules), "🎉🎉 ship party 🎉");
        // No match → text untouched (same allocation semantics either way).
        assert_eq!(apply_rules("nothing here", &rules), "nothing here");
    }

    #[test]
    fn chained_rules_see_earlier_outputs() {
        // Stored order matters and is documented behavior: rule 2 can refine
        // rule 1's output.
        let rules = vec![
            CorrectionRule { find: "kriss".into(), replace: "Chris".into() },
            CorrectionRule { find: "chris s".into(), replace: "Chris S.".into() },
        ];
        assert_eq!(apply_rules("kriss s spoke", &rules), "Chris S. spoke");
    }
}
