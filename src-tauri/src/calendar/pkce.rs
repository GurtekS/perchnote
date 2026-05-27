//! OAuth 2.0 `state` (RFC 6749 §10.12) and PKCE (RFC 7636) helpers for the
//! Google and Microsoft authorization-code flows. The localhost callback
//! listener accepts the first inbound TCP connection on a random port; without
//! these, an attacker who can race that accept() — or trick the browser into
//! hitting the loopback callback with their own `code` — would log the user
//! into the attacker's account. `state` defeats the CSRF; PKCE binds the code
//! to this process.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use sha2::{Digest, Sha256};
use uuid::Uuid;

pub struct AuthChallenge {
    pub state: String,
    pub code_verifier: String,
    pub code_challenge: String,
}

impl AuthChallenge {
    pub fn new() -> Self {
        let state = Uuid::new_v4().to_string();
        // 64 hex chars = 244 bits of entropy, well above the RFC 7636 minimum
        // of 128 bits. Hex digits are in the unreserved set.
        let code_verifier = format!(
            "{}{}",
            Uuid::new_v4().simple(),
            Uuid::new_v4().simple()
        );
        let code_challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(code_verifier.as_bytes()));
        Self { state, code_verifier, code_challenge }
    }
}

/// Parse an OAuth callback HTTP request, returning `(code, state)`. Returns
/// `None` if either parameter is missing or the request can't be parsed.
pub fn parse_callback(request: &str) -> Option<(String, String)> {
    let path = request.lines().next()?.split_whitespace().nth(1)?;
    let url = url::Url::parse(&format!("http://localhost{}", path)).ok()?;
    let mut code = None;
    let mut state = None;
    for (k, v) in url.query_pairs() {
        match k.as_ref() {
            "code" => code = Some(v.into_owned()),
            "state" => state = Some(v.into_owned()),
            _ => {}
        }
    }
    Some((code?, state?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn challenge_is_unique_per_call() {
        let a = AuthChallenge::new();
        let b = AuthChallenge::new();
        assert_ne!(a.state, b.state);
        assert_ne!(a.code_verifier, b.code_verifier);
        assert_ne!(a.code_challenge, b.code_challenge);
    }

    #[test]
    fn code_challenge_is_sha256_of_verifier() {
        let c = AuthChallenge::new();
        let expected = URL_SAFE_NO_PAD.encode(Sha256::digest(c.code_verifier.as_bytes()));
        assert_eq!(c.code_challenge, expected);
    }

    #[test]
    fn verifier_uses_only_unreserved_chars() {
        let c = AuthChallenge::new();
        // RFC 7636 §4.1: verifier must be [A-Z][a-z][0-9]-._~
        assert!(c.code_verifier.chars().all(|ch| ch.is_ascii_hexdigit()));
        assert!(c.code_verifier.len() >= 43 && c.code_verifier.len() <= 128);
    }

    #[test]
    fn parses_code_and_state_from_callback() {
        let req = "GET /callback?code=abc123&state=xyz789 HTTP/1.1\r\nHost: localhost\r\n\r\n";
        let (code, state) = parse_callback(req).expect("should parse");
        assert_eq!(code, "abc123");
        assert_eq!(state, "xyz789");
    }

    #[test]
    fn parses_callback_with_other_params() {
        let req = "GET /callback?state=s1&scope=foo&code=c1&authuser=0 HTTP/1.1\r\n\r\n";
        let (code, state) = parse_callback(req).expect("should parse");
        assert_eq!(code, "c1");
        assert_eq!(state, "s1");
    }

    #[test]
    fn rejects_callback_without_state() {
        let req = "GET /callback?code=abc HTTP/1.1\r\n\r\n";
        assert!(parse_callback(req).is_none());
    }

    #[test]
    fn rejects_callback_without_code() {
        let req = "GET /callback?state=xyz HTTP/1.1\r\n\r\n";
        assert!(parse_callback(req).is_none());
    }

    #[test]
    fn rejects_oauth_error_response() {
        // When user denies, Google returns ?error=access_denied&state=...
        // No code present, so we reject — caller sees a parse failure rather
        // than a successful flow with an empty code.
        let req = "GET /callback?error=access_denied&state=xyz HTTP/1.1\r\n\r\n";
        assert!(parse_callback(req).is_none());
    }

    #[test]
    fn url_decodes_callback_params() {
        let req = "GET /callback?code=a%2Fb%2Bc&state=s%3D1 HTTP/1.1\r\n\r\n";
        let (code, state) = parse_callback(req).expect("should parse");
        assert_eq!(code, "a/b+c");
        assert_eq!(state, "s=1");
    }
}
