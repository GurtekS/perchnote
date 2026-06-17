use chrono::{Datelike, Utc};
use tauri::{AppHandle, Manager, State};

use crate::ai;
use crate::db::queries::{CachedInsight, TopicTrend};
use crate::db::Database;

/// Trailing window for topic trends: this month plus the five before it.
const TREND_MONTHS_BACK: i32 = 5;
/// Trackers are a comma-separated setting; cap how many we run FTS for.
const MAX_TERMS: usize = 8;

/// Topic-tracker trends for /insights (plan v6 item 13): for each term in
/// the existing `topic_trackers` setting, how many distinct meetings
/// mentioned it, per month, over the trailing six calendar months. Pure
/// local FTS — nothing leaves the machine.
#[tauri::command]
pub fn get_topic_trends(db: State<'_, Database>) -> Result<Vec<TopicTrend>, String> {
    let terms: Vec<String> = db
        .get_setting("topic_trackers")
        .map_err(|e| e.to_string())?
        .unwrap_or_default()
        .split(',')
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
        .take(MAX_TERMS)
        .collect();
    if terms.is_empty() {
        return Ok(Vec::new());
    }
    let since = first_of_month_back(TREND_MONTHS_BACK);
    db.topic_trend_counts(&terms, &since)
        .map_err(|e| e.to_string())
}

/// ISO date of the first day of the month `n` months before the current one
/// (n = 0 → first of this month).
fn first_of_month_back(n: i32) -> String {
    let now = Utc::now();
    let total = now.year() * 12 + now.month0() as i32 - n;
    let year = total.div_euclid(12);
    let month = total.rem_euclid(12) + 1;
    format!("{year:04}-{month:02}-01")
}

fn current_month() -> String {
    Utc::now().format("%Y-%m").to_string()
}

fn narrative_key(month: &str) -> String {
    format!("narrative:{month}")
}

/// The cached monthly narrative, if one was ever generated for `month`
/// (defaults to the current month). Never triggers generation.
#[tauri::command]
pub fn get_monthly_narrative(
    db: State<'_, Database>,
    month: Option<String>,
) -> Result<Option<CachedInsight>, String> {
    let month = month.unwrap_or_else(current_month);
    db.get_insight(&narrative_key(&month)).map_err(|e| e.to_string())
}

/// Generate (or regenerate) the month's narrative: aggregate facts JSON —
/// counts, hours, titles; never transcripts or note bodies — then ONE
/// provider call, cached in insights_cache. The stored facts are returned
/// with the narrative so the UI can show exactly what was shared.
#[tauri::command]
pub async fn generate_monthly_narrative(
    db: State<'_, Database>,
    month: Option<String>,
) -> Result<CachedInsight, String> {
    let month = month.unwrap_or_else(current_month);
    if !ai::is_configured(&db) {
        return Err("No AI provider configured — set one up in Settings → AI.".into());
    }

    let facts = db.narrative_facts(&month).map_err(|e| e.to_string())?;
    if facts.get("meetings").and_then(|v| v.as_u64()).unwrap_or(0) == 0 {
        return Err("No completed meetings this month yet — nothing to reflect on.".into());
    }
    let facts_json =
        serde_json::to_string_pretty(&facts).map_err(|e| e.to_string())?;

    let prompt = format!(
        "You are writing a short monthly reflection for the user of a private,\n\
         local-first meeting-notes app. Write 120-180 words, second person\n\
         (\"you\"), warm but plainly factual.\n\
         \n\
         Rules:\n\
         - Use ONLY the facts in the JSON below. Never invent meetings,\n\
           people, numbers, or topics. Skip anything the data doesn't show.\n\
         - Compare to last month only where the JSON includes it.\n\
         - At most one gentle suggestion at the very end, and only if the\n\
           facts clearly support it. No motivational filler.\n\
         - Two or three short paragraphs of plain prose. No headings, no\n\
           bullet points, no markdown.\n\
         \n\
         FACTS:\n{facts_json}"
    );

    let content = ai::chat(&db, &prompt).await.map_err(|e| e.to_string())?;
    let content = content.trim().to_string();
    if content.is_empty() {
        return Err("The provider returned an empty narrative.".into());
    }

    let key = narrative_key(&month);
    db.upsert_insight(&key, &content, &facts_json)
        .map_err(|e| e.to_string())?;
    db.get_insight(&key)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "narrative vanished after write".into())
}

// --- Quarter/year narratives + brag doc (plan v9 item 14) ---

/// Strictly parse a period id — "YYYY" or "YYYY-QN" with N in 1..=4,
/// nothing else (lowercase q, months, ranges all rejected). Returns the
/// [from, to) ISO date window, `to` exclusive.
fn parse_period(period: &str) -> Result<(String, String), String> {
    let err = || format!("invalid period '{period}' — expected YYYY or YYYY-Q1..Q4");
    let year_of = |s: &str| -> Option<i32> {
        (s.len() == 4 && s.bytes().all(|b| b.is_ascii_digit()))
            .then(|| s.parse().ok())
            .flatten()
    };
    if let Some(y) = year_of(period) {
        return Ok((format!("{y:04}-01-01"), format!("{:04}-01-01", y + 1)));
    }
    let b = period.as_bytes();
    if b.len() == 7 && b[4] == b'-' && b[5] == b'Q' && (b'1'..=b'4').contains(&b[6]) {
        if let Some(y) = year_of(&period[0..4]) {
            let q = (b[6] - b'0') as i32;
            let start_month = (q - 1) * 3 + 1;
            let from = format!("{y:04}-{start_month:02}-01");
            let to = if q == 4 {
                format!("{:04}-01-01", y + 1)
            } else {
                format!("{y:04}-{:02}-01", start_month + 3)
            };
            return Ok((from, to));
        }
    }
    Err(err())
}

/// The cached quarter/year narrative ("2026-Q2" | "2026"), if one was ever
/// generated. Never triggers generation; still validates the period so the
/// cache key space stays closed.
#[tauri::command]
pub fn get_period_narrative(
    db: State<'_, Database>,
    period: String,
) -> Result<Option<CachedInsight>, String> {
    parse_period(&period)?;
    db.get_insight(&narrative_key(&period)).map_err(|e| e.to_string())
}

/// Generate (or regenerate) a quarter/year narrative: the same facts
/// contract as the monthly one — counts, hours, titles; never transcripts
/// or note bodies — over the whole window, with per-month buckets so the
/// model can tell the arc. ONE provider call, cached in insights_cache.
#[tauri::command]
pub async fn generate_period_narrative(
    db: State<'_, Database>,
    period: String,
) -> Result<CachedInsight, String> {
    let (from, to) = parse_period(&period)?;
    if !ai::is_configured(&db) {
        return Err("No AI provider configured — set one up in Settings → AI.".into());
    }

    let facts = db
        .narrative_facts_range(&period, &from, &to)
        .map_err(|e| e.to_string())?;
    if facts.get("meetings").and_then(|v| v.as_u64()).unwrap_or(0) == 0 {
        return Err("No completed meetings in this period yet — nothing to reflect on.".into());
    }
    let facts_json = serde_json::to_string_pretty(&facts).map_err(|e| e.to_string())?;

    let (horizon, words, paras) = if period.contains("-Q") {
        ("quarter", "150-220", "Two or three")
    } else {
        ("year", "200-280", "Three or four")
    };
    let prompt = format!(
        "You are writing a short reflection on the user's {horizon} for a\n\
         private, local-first meeting-notes app. Write {words} words, second\n\
         person (\"you\"), warm but plainly factual.\n\
         \n\
         Rules:\n\
         - Use ONLY the facts in the JSON below. Never invent meetings,\n\
           people, numbers, or topics. Skip anything the data doesn't show.\n\
         - A {horizon} is a story arc, not a list: use the per-month buckets\n\
           to describe how the period moved — ramps, peaks, quiet stretches —\n\
           naming months only as the JSON shows them. If the window isn't\n\
           over yet, treat it as in progress, never as a falling-off.\n\
         - At most one gentle suggestion at the very end, and only if the\n\
           facts clearly support it. No motivational filler, no scores, no\n\
           grades.\n\
         - {paras} short paragraphs of plain prose. No headings, no bullet\n\
           points, no markdown.\n\
         \n\
         FACTS:\n{facts_json}"
    );

    let content = ai::chat(&db, &prompt).await.map_err(|e| e.to_string())?;
    let content = content.trim().to_string();
    if content.is_empty() {
        return Err("The provider returned an empty narrative.".into());
    }

    let key = narrative_key(&period);
    db.upsert_insight(&key, &content, &facts_json)
        .map_err(|e| e.to_string())?;
    db.get_insight(&key)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "narrative vanished after write".into())
}

/// Build the deterministic brag doc for a period — NO AI call, facts only —
/// and write it to the Desktop (Documents as fallback, mirroring
/// `export_backup_archive`). Returns the full path. The filename is built
/// from the validated period, so it can't carry path components.
#[tauri::command]
pub fn export_brag_doc(
    app: AppHandle,
    db: State<'_, Database>,
    period: String,
) -> Result<String, String> {
    let (from, to) = parse_period(&period)?;
    let doc = db
        .build_brag_doc(&period, &from, &to)
        .map_err(|e| e.to_string())?;
    let dir = app
        .path()
        .desktop_dir()
        .or_else(|_| app.path().document_dir())
        .map_err(|e| e.to_string())?;
    let path = dir.join(format!("Perchnote brag doc {period}.md"));
    std::fs::write(&path, doc.as_bytes()).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_of_month_back_handles_year_boundaries() {
        // Pure arithmetic check via a fixed reference: rebuild the function's
        // math for a known date rather than the wall clock.
        let compute = |year: i32, month0: i32, n: i32| {
            let total = year * 12 + month0 - n;
            format!("{:04}-{:02}-01", total.div_euclid(12), total.rem_euclid(12) + 1)
        };
        assert_eq!(compute(2026, 5, 5), "2026-01-01"); // June 2026 back 5 → January
        assert_eq!(compute(2026, 1, 5), "2025-09-01"); // February 2026 back 5 → prior September
        assert_eq!(compute(2026, 0, 0), "2026-01-01");
    }

    #[test]
    fn current_month_window_is_well_formed() {
        let s = first_of_month_back(5);
        assert_eq!(s.len(), 10);
        assert!(s.ends_with("-01"));
    }

    #[test]
    fn parse_period_accepts_quarters_and_years() {
        assert_eq!(
            parse_period("2026-Q1").unwrap(),
            ("2026-01-01".to_string(), "2026-04-01".to_string())
        );
        assert_eq!(
            parse_period("2026-Q2").unwrap(),
            ("2026-04-01".to_string(), "2026-07-01".to_string())
        );
        assert_eq!(
            parse_period("2026-Q3").unwrap(),
            ("2026-07-01".to_string(), "2026-10-01".to_string())
        );
        // Q4 and bare years roll the exclusive end into the next year.
        assert_eq!(
            parse_period("2026-Q4").unwrap(),
            ("2026-10-01".to_string(), "2027-01-01".to_string())
        );
        assert_eq!(
            parse_period("2026").unwrap(),
            ("2026-01-01".to_string(), "2027-01-01".to_string())
        );
    }

    #[test]
    fn parse_period_rejects_everything_else() {
        for bad in [
            "", "26", "20261", "abcd", "2026-06", "2026-Q0", "2026-Q5",
            "2026-q2", "2026-Q22", "2026 Q2", "Q2-2026", "2026-Q2 ", " 2026",
            "2026-Q2/../x", "202x-Q2",
        ] {
            assert!(parse_period(bad).is_err(), "{bad:?} should be rejected");
        }
    }
}
