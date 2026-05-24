# Security

This document describes the threat model the app is designed against, the
controls in place, and the procedure for reporting issues.

## Reporting a vulnerability

Please **do not** open a public GitHub issue. Email the maintainers at the
address listed in the repository profile, or use GitHub's private security
advisory feature (Security tab → Report a vulnerability). We'll acknowledge
within 72 hours.

## Threat model

The app is a single-user local desktop application. The realistic threats
we design against are:

1. **Filesystem-level compromise of the user's machine** — malware or a
   stolen Time Machine backup reads the app's SQLite database.
2. **Hostile content inside a meeting** — a participant reads malicious
   instructions out loud (prompt injection) or a calendar invite contains
   a malicious URL.
3. **Hostile content inside an ICS feed** — the URL the user pasted is
   attacker-controlled and tries to SSRF into the local network.
4. **Supply-chain compromise** — a malicious npm/cargo dependency tries
   to exfiltrate credentials.

Out of scope (for now):

- Active malware already running with the user's privileges (it can read
  the keychain via the user's prompt).
- Physical access while the screen is unlocked.
- Side-channel attacks on the Whisper model.

## Controls

### Secrets at rest

OAuth access/refresh tokens, the OAuth client secret, the Slack
webhook URL, and the Anthropic API key are stored exclusively in the
**macOS Keychain** under the service `com.perchnote.app`. The SQLite
`settings` table never contains these values; on first launch after
upgrade, any legacy plaintext rows are deleted (see
`src-tauri/src/secrets.rs::purge_legacy_plaintext_rows`). A filesystem
read therefore yields the user's notes (already on disk unencrypted by
design) but does *not* yield bearer tokens.

### Content Security Policy

The production CSP forbids `unsafe-eval` and `unsafe-inline` in
`script-src`. Outbound `connect-src` is allow-listed to:
`googleapis.com`, `outlook.office365.com`, `microsoft.com`, and
`huggingface.co`. (Anthropic API calls originate from the Rust backend,
not the webview, so they bypass CSP entirely.) Inline event handlers,
`eval`, and `Function(...)` are non-functional inside the webview.

### Tauri capability surface

The default capability bundle now grants only `core:default` and the
notification permission. Shell-execute, shell-spawn, and shell-open
are explicitly removed. Frontend code cannot spawn processes or
open arbitrary URLs/files; everything routes through narrowly typed
Tauri commands.

### Input validation

- IDs that flow into filesystem paths are validated as v4 UUIDs.
- `open_attachment` canonicalizes the stored path and refuses to open
  anything outside `$APPDATA/attachments`.
- `reveal_in_finder` only accepts paths under the app data, Desktop,
  or Documents directories.
- `open_url` only accepts `http`, `https`, or `mailto` URLs.
- `download_whisper_model` only accepts model IDs from a hardcoded
  allow-list.

### SSRF guard on ICS feeds

`src-tauri/src/calendar/http.rs::audit_url_for_remote_fetch` rejects:

- non-`https` schemes
- pseudo-hostnames (`localhost`, cloud-metadata names)
- literal loopback / link-local / private / CG-NAT IPs (IPv4 and IPv6)

A 30s total timeout + 10s connect timeout is applied to every outbound
HTTP from the calendar/sync code paths, and the response body is capped
at 5 MiB.

### FTS5 query sanitization

Search queries are stripped to alphanumeric tokens, capped to 20 tokens
of 64 characters each, and wrapped as quoted phrase literals before
being passed to SQLite FTS5 `MATCH`. FTS operators (`NEAR`, `*`, column
filters, `AND`/`OR`/`NOT`) supplied by the user are inert.

### TipTap link allow-list

The TipTap `Link` extension is configured with `protocols: ["http",
"https", "mailto"]` and an `isAllowedUri` callback. Pasted or AI-generated
`javascript:` / `data:` / `file:` URLs are dropped.

### Prompt-injection mitigation

`src-tauri/src/ai/prompts.rs::SYSTEM_PREAMBLE` instructs the model to
treat content between `<<<TRANSCRIPT>>>` / `<<<USER_NOTES>>>` fences as
untrusted *data*, never as instructions. This is best-effort — see
[OWASP LLM01 (2025)](https://genai.owasp.org/llmrisk/llm01-prompt-injection/)
for why no full mitigation exists today.

## Supply chain

`npm audit` and `cargo audit` are required to be clean on every PR.
Lockfiles (`package-lock.json`, `Cargo.lock`) are committed; production
installs use `npm ci`, never `npm install`, so a new malicious version
cannot be silently pulled in.

The `@tanstack/react-router` supply-chain compromise of 2026-05-11
(GHSA-g7cv-rxg3-hmpx) affected versions 1.167.68–1.167.71. The pin in
this repository (`1.167.4`) predates the compromise window. Run
`npm run verify:tanstack-pin` to validate `package.json` and
`package-lock.json` offline before networked audits.

## Auditing your fork

Before publishing a fork:

```sh
# Frontend
npm audit signatures      # verify npm-side integrity
npm audit                 # zero advisories required
npm run build             # no TypeScript errors

# Rust
cd src-tauri
cargo audit               # zero open advisories required
cargo check
cargo test
```

Then grep for personal artifacts:

```sh
git grep -nE "/Users/|@gmail\.com|api[_-]?key" -- ':!*.lock' ':!Cargo.lock'
```

This should produce no hits before pushing.
