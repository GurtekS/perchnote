/// Detect meeting platform from a URL or location string
pub fn detect_platform(location: Option<&str>, description: Option<&str>) -> (Option<String>, String) {
    let text = format!(
        "{} {}",
        location.unwrap_or(""),
        description.unwrap_or("")
    );

    let patterns = [
        ("zoom.us/j/", "zoom"),
        ("zoom.us/my/", "zoom"),
        ("meet.google.com/", "google_meet"),
        ("teams.microsoft.com/", "teams"),
        ("webex.com/", "webex"),
        ("slack.com/", "slack"),
    ];

    for (pattern, platform) in patterns {
        if let Some(pos) = text.find(pattern) {
            // Extract the URL containing this pattern
            let before = &text[..pos];
            let url_start = before.rfind("http").unwrap_or(pos);
            let url_text = &text[url_start..];
            let url_end = url_text.find(|c: char| c.is_whitespace() || c == ')' || c == ']' || c == '>')
                .unwrap_or(url_text.len());
            let url = url_text[..url_end].to_string();
            return (Some(url), platform.to_string());
        }
    }

    if location.is_some_and(|l| !l.is_empty() && !l.starts_with("http")) {
        return (None, "in_person".to_string());
    }

    (None, "unknown".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_detect_zoom_from_location() {
        let (url, platform) = detect_platform(Some("https://zoom.us/j/123456789"), None);
        assert_eq!(platform, "zoom");
        assert!(url.as_deref().unwrap().contains("zoom.us"));
    }

    #[test]
    fn test_detect_zoom_personal_room() {
        let (url, platform) = detect_platform(Some("https://zoom.us/my/johndoe"), None);
        assert_eq!(platform, "zoom");
        assert!(url.is_some());
    }

    #[test]
    fn test_detect_google_meet_from_description() {
        let (url, platform) = detect_platform(
            None,
            Some("Join at https://meet.google.com/abc-defg-hij for the meeting"),
        );
        assert_eq!(platform, "google_meet");
        assert!(url.as_deref().unwrap().contains("meet.google.com"));
    }

    #[test]
    fn test_detect_google_meet_from_location() {
        let (url, platform) = detect_platform(Some("https://meet.google.com/xyz-abcd-efg"), None);
        assert_eq!(platform, "google_meet");
        assert!(url.is_some());
    }

    #[test]
    fn test_detect_teams() {
        let (url, platform) = detect_platform(
            None,
            Some("Join Microsoft Teams: https://teams.microsoft.com/l/meetup-join/123"),
        );
        assert_eq!(platform, "teams");
        assert!(url.as_deref().unwrap().contains("teams.microsoft.com"));
    }

    #[test]
    fn test_detect_webex() {
        let (url, platform) = detect_platform(Some("https://company.webex.com/meet/room"), None);
        assert_eq!(platform, "webex");
        assert!(url.is_some());
    }

    #[test]
    fn test_detect_slack_huddle() {
        let (url, platform) = detect_platform(
            None,
            Some("Slack huddle: https://app.slack.com/huddle/T123/C456"),
        );
        assert_eq!(platform, "slack");
        assert!(url.is_some());
    }

    #[test]
    fn test_detect_in_person_physical_location() {
        let (url, platform) = detect_platform(Some("Conference Room 3B"), None);
        assert_eq!(platform, "in_person");
        assert!(url.is_none());
    }

    #[test]
    fn test_detect_in_person_office_address() {
        let (url, platform) = detect_platform(Some("123 Main Street, Building 2"), None);
        assert_eq!(platform, "in_person");
        assert!(url.is_none());
    }

    #[test]
    fn test_detect_unknown_no_location_no_description() {
        let (url, platform) = detect_platform(None, None);
        assert_eq!(platform, "unknown");
        assert!(url.is_none());
    }

    #[test]
    fn test_detect_unknown_empty_strings() {
        let (url, platform) = detect_platform(Some(""), Some(""));
        assert_eq!(platform, "unknown");
        assert!(url.is_none());
    }

    #[test]
    fn test_url_extracted_from_middle_of_description() {
        let (url, platform) = detect_platform(
            None,
            Some("Please join us for the sprint review. Link: https://zoom.us/j/999888777 See you there!"),
        );
        assert_eq!(platform, "zoom");
        let u = url.unwrap();
        assert!(!u.contains("See you there"), "URL extraction must stop at whitespace: got {u}");
        assert!(u.contains("zoom.us/j/999888777"));
    }

    #[test]
    fn test_description_takes_precedence_check_both_searched() {
        let (url, platform) = detect_platform(
            Some("Physical Office"),
            Some("Online via https://meet.google.com/zzz-yyy-xxx"),
        );
        assert_eq!(platform, "google_meet");
        assert!(url.is_some());
    }
}
