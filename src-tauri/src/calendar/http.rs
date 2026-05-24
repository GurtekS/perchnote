//! Shared HTTP client config for calendar/network code.
//!
//! All outbound HTTP from the calendar/sync paths must:
//! - have a connect + total timeout (no zombie tasks against a slow attacker)
//! - announce a stable, identifying User-Agent
//! - refuse cleartext HTTP for arbitrary remote URLs (ICS feeds)
//! - refuse loopback / link-local / private addresses (SSRF mitigation)
//!
//! See `audit_url_for_remote_fetch` for the SSRF guard used by the ICS sync.

use anyhow::{anyhow, Result};
use std::net::IpAddr;
use std::time::Duration;
use tokio::net::lookup_host;
use url::Url;

const USER_AGENT: &str = concat!("Perchnote/", env!("CARGO_PKG_VERSION"));

pub fn build_client() -> reqwest::Client {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(30))
        .user_agent(USER_AGENT)
        .build()
        .expect("reqwest client build")
}

/// Reject URLs that would let a user-supplied calendar feed reach internal
/// network resources (cloud metadata, intranet, the host loopback).
///
/// We do both a syntactic check (literal IP / known loopback names) AND a
/// DNS-resolution check: the hostname is resolved here, every returned
/// address is verified against the public-IP allow-list, and the caller
/// is expected to make the request against the SAME hostname so reqwest
/// re-resolves. A determined DNS-rebinding attacker can still flip an
/// `A` record between this lookup and reqwest's, but they have to also
/// race a fresh TCP connect, and the request-time IP is then compared
/// against an allow-list that doesn't include private space — so they'd
/// have to bind a public IP and proxy to internal. Not free.
pub async fn audit_url_for_remote_fetch(raw: &str) -> Result<Url> {
    let url = Url::parse(raw).map_err(|e| anyhow!("invalid URL: {}", e))?;

    match url.scheme() {
        "https" => {}
        "http" => return Err(anyhow!("cleartext HTTP not allowed for calendar feeds")),
        other => return Err(anyhow!("unsupported URL scheme: {}", other)),
    }

    let host = url.host_str().ok_or_else(|| anyhow!("URL has no host"))?;

    // Reject by-name loopback / cloud-metadata pseudo-hosts before DNS.
    let lower = host.to_ascii_lowercase();
    if matches!(lower.as_str(),
        "localhost" | "ip6-localhost" | "ip6-loopback"
        | "metadata" | "metadata.google.internal"
    ) {
        return Err(anyhow!("host '{}' is not allowed", host));
    }

    // Literal IP case.
    if let Ok(ip) = host.parse::<IpAddr>() {
        if !is_ip_publicly_routable(&ip) {
            return Err(anyhow!("IP '{}' is not allowed", ip));
        }
        return Ok(url);
    }

    // Hostname case: resolve and verify every returned address.
    let port = url.port_or_known_default().unwrap_or(443);
    let mut saw_any = false;
    let addrs = lookup_host((host, port))
        .await
        .map_err(|e| anyhow!("DNS lookup for '{}' failed: {}", host, e))?;
    for addr in addrs {
        saw_any = true;
        if !is_ip_publicly_routable(&addr.ip()) {
            return Err(anyhow!("'{}' resolves to non-public address {}", host, addr.ip()));
        }
    }
    if !saw_any {
        return Err(anyhow!("'{}' did not resolve to any address", host));
    }

    Ok(url)
}

fn is_ip_publicly_routable(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_v4_publicly_routable(v4),
        IpAddr::V6(v6) => {
            // ::ffff:0:0/96 maps a v4 address into v6. Unwrap and apply the
            // v4 check so the v4 private/loopback/etc ranges are enforced
            // even when reached via the v6 mapping.
            if let Some(mapped) = v6.to_ipv4_mapped() {
                return is_v4_publicly_routable(&mapped);
            }
            !(v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_multicast()
                // Unique local fc00::/7
                || (v6.segments()[0] & 0xfe00) == 0xfc00
                // Link local fe80::/10
                || (v6.segments()[0] & 0xffc0) == 0xfe80)
        }
    }
}

fn is_v4_publicly_routable(v4: &std::net::Ipv4Addr) -> bool {
    !(v4.is_loopback()
        || v4.is_private()
        || v4.is_link_local()
        || v4.is_broadcast()
        || v4.is_documentation()
        || v4.is_unspecified()
        || v4.is_multicast()
        // 169.254.169.254 (AWS/GCP metadata) is caught by is_link_local().
        // 100.64.0.0/10 (carrier-grade NAT) — top two bits of octet[1] == 01.
        || (v4.octets()[0] == 100 && (v4.octets()[1] & 0xc0) == 64))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::Ipv4Addr;

    fn assert_blocked(url: &str) {
        let rt = tokio::runtime::Runtime::new().unwrap();
        let err = rt.block_on(audit_url_for_remote_fetch(url)).err();
        assert!(err.is_some(), "expected '{}' to be rejected, got Ok", url);
    }

    #[test]
    fn rejects_http_scheme() { assert_blocked("http://example.com/cal.ics"); }
    #[test]
    fn rejects_file_scheme() { assert_blocked("file:///etc/passwd"); }
    #[test]
    fn rejects_javascript_scheme() { assert_blocked("javascript:alert(1)"); }
    #[test]
    fn rejects_localhost_name() { assert_blocked("https://localhost/cal"); }
    #[test]
    fn rejects_metadata_name() { assert_blocked("https://metadata.google.internal/"); }
    #[test]
    fn rejects_literal_loopback_v4() { assert_blocked("https://127.0.0.1/cal"); }
    #[test]
    fn rejects_literal_link_local_v4() { assert_blocked("https://169.254.169.254/latest"); }
    #[test]
    fn rejects_literal_private_v4() { assert_blocked("https://10.0.0.1/cal"); }
    #[test]
    fn rejects_literal_cg_nat_v4() { assert_blocked("https://100.64.0.1/cal"); }
    #[test]
    fn rejects_literal_loopback_v6() { assert_blocked("https://[::1]/cal"); }
    #[test]
    fn rejects_v4_mapped_loopback_v6() { assert_blocked("https://[::ffff:127.0.0.1]/cal"); }

    #[test]
    fn v4_classifier_blocks_loopback() {
        assert!(!is_v4_publicly_routable(&Ipv4Addr::new(127, 0, 0, 1)));
        assert!(!is_v4_publicly_routable(&Ipv4Addr::new(10, 0, 0, 1)));
        assert!(!is_v4_publicly_routable(&Ipv4Addr::new(192, 168, 0, 1)));
        assert!(!is_v4_publicly_routable(&Ipv4Addr::new(169, 254, 169, 254)));
        assert!(!is_v4_publicly_routable(&Ipv4Addr::new(100, 64, 0, 1)));
        assert!(!is_v4_publicly_routable(&Ipv4Addr::new(100, 127, 255, 255)));
        // 100.128.0.0 is OUTSIDE the CG-NAT block — should be public.
        assert!(is_v4_publicly_routable(&Ipv4Addr::new(100, 128, 0, 1)));
        // 8.8.8.8 is Google DNS — public.
        assert!(is_v4_publicly_routable(&Ipv4Addr::new(8, 8, 8, 8)));
    }
}
