<div align="center">

<a href="https://perchnote.com">
  <img src="./src-tauri/icons/128x128@2x.png" width="96" height="96" alt="Perchnote" />
</a>

# Perchnote

[**perchnote.com**](https://perchnote.com)

Local-first meeting notes for macOS. It records mic + system audio,
transcribes everything on your machine with whisper.cpp (in-process,
Metal), and turns transcripts into structured, source-cited notes with
the AI you choose: Anthropic API, local Ollama, or Apple Intelligence.
Without any AI configured it's still a fast meeting notepad.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
![Platform: macOS 14+](https://img.shields.io/badge/platform-macOS%2014+-000000?logo=apple&logoColor=white)
![Tauri 2](https://img.shields.io/badge/Tauri-2-24C8DB?logo=tauri&logoColor=white)
![React 19](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=white)
![Rust](https://img.shields.io/badge/Rust-stable-CE412B?logo=rust&logoColor=white)
![Anthropic API](https://img.shields.io/badge/AI-Claude%204.x-D97757?logo=anthropic&logoColor=white)

</div>

![Perchnote demo](./assets/demo.gif)

The audio, transcripts, and notes all stay on your machine in a local
SQLite database. The only things that ever leave are calls you turn on
yourself: calendar sync, Slack sharing, and the Anthropic API when you
ask for AI notes (once enabled, that includes a weekly auto-refresh of
your "About You" profile, built from your own meeting notes; editing the
field turns it off).

## ✨ Features

- **Never miss a recording.** When Zoom, Teams, or your browser grabs
  the mic, Perchnote offers one-click recording into the calendar event
  you're in. It watches *which app* uses the mic, never the audio.
- **Capture anything.** Mic and system audio together via Core Audio
  process taps. No bot, no virtual cable, and optional stereo (you on
  the left, them on the right). You can also drop any audio file onto
  the window, like a Voice Memo or a call recording, and it becomes a
  fully transcribed meeting.
- **On-device transcription.** whisper.cpp in-process on Metal (no
  Homebrew), behind a Silero voice-activity gate with hallucination
  filtering and beam search. Models from fast Base to Large-v3-Turbo,
  downloadable in Settings.
- **Speaker recognition.** Neural diarization (pyannote-grade, on
  CoreML) that splits turns at the word boundary, so fast back-and-forth
  keeps each speaker straight. There's one panel to name, merge, and
  re-detect, and names propagate everywhere instantly.
- **AI notes you can verify.** Summaries stream live as they're written;
  the model pulls verbatim quotes first, then composes. Action items and
  bullets carry ▸ m:ss chips that replay the cited moment, and Ask AI
  cites its sources the same way. "Catch me up" recaps a call you joined
  late, and Recipes run saved prompts ("draft the follow-up email")
  against any meeting. It's pluggable across Anthropic, Ollama (qwen3
  recommended), and Apple Intelligence, all optional.
- **Instant recap.** Recordings enhance themselves on stop. A "Notes
  ready, 3 action items" notification lets you know when it's done.
- **The full task loop.** Cross-meeting rollup with write-back, due-date
  buckets, snooze that never touches meeting-stated deadlines, stale-item
  triage (Done/Snooze/Drop), a Monday week-in-review, idempotent Apple
  Reminders export with completion sync-back, and one-click Things
  hand-off.
- **Meeting continuity.** Recurring meetings open with last time's
  summary and one-click carry-over of unfinished items; templates bind
  per series; ⌘D flags moments live and weights them in the summary.
- **Search that finds the moment.** ⌘K searches titles, notes, and
  transcripts per sentence, and results carry what was said and jump
  playback to it. Filters work everywhere, including Ask AI:
  `speaker:amy`, `folder:work`, `before:`/`after:` dates, `"exact
  phrase"`, `budg*`. Misheard a name? Edit any transcript line, or fix
  it everywhere with find-and-replace, and search and citations re-sync.
  Optional local semantic recall (sqlite-vec, Apple or Ollama
  embeddings) finds meaning, not just keywords.
- **Insights.** A monthly read on your meeting load, open-loop trends,
  topic trackers, and talk-balance (you vs. them), each measured against
  your own baseline, with a year-end brag-doc export.
- **Your data is files when you want it.** Checksummed `.perchnote`
  backup archives with verified restore, and an optional Markdown mirror
  to Documents/Perchnote (flat, by month, or by folder) that follows your
  edits, renames, and deletes. Frontmatter carries tags, a deep link
  back, and the recording's path for Dataview.
- **Automation & MCP.** `perchnote://` deep links (record, stop,
  transcript, search) with x-callback-url support, plus recipes for
  Shortcuts, Raycast, and Stream Deck in
  [`docs/SHORTCUTS.md`](./docs/SHORTCUTS.md). There's also a local
  read-only [MCP server](#-use-with-claude-mcp) so Claude can search your
  meetings with nothing leaving the machine.
- **Keyboard-first.** ⌘N records instantly, ⌘1–⌘5 switch sections,
  ⌘[/⌘] retrace your path, ⌘K searches everything, ⌘/ shows the rest.
- **Calendar.** Google Calendar OAuth, Microsoft Graph OAuth, or any
  read-only ICS feed.
- **Self-maintaining.** Daily database backups, crash recovery that
  repairs interrupted recordings, a unified rotating log, and an "About
  You" profile that writes itself from your meeting history.

## 📋 Requirements

- macOS 14 or newer. The Core Audio `CATapDescription` API only exists on
  14+; older versions fall back to mic-only.
- [Node.js](https://nodejs.org/) 20+
- [Rust](https://rustup.rs/) (stable)
- Xcode Command Line Tools (`xcode-select --install`). The Swift
  process-tap helper in `src-tauri/swift/` gets compiled during the build.
- For AI features (optional): an
  [Anthropic API key](https://console.anthropic.com/settings/keys)
  (stored in the macOS Keychain), a local [Ollama](https://ollama.com)
  with a model pulled, or Apple Intelligence on macOS 26+.
- A Whisper model, downloaded in Settings → Audio (or during
  onboarding). No Homebrew or external binaries required; whisper runs
  inside the app.

## 📥 Install

Grab the latest `.dmg` from the
[releases page](https://github.com/GurtekS/perchnote/releases/latest),
open it, and drag **Perchnote** to `/Applications`.

The build is currently unsigned, so the first launch will hit Gatekeeper.
Right-click the app in `/Applications` and choose **Open**, then confirm
the warning. From then on it launches normally. If you'd rather clear
the quarantine flag in one shot:

```sh
xattr -dr com.apple.quarantine /Applications/Perchnote.app
```

To verify the download, compare against the `.sha256` checksum file
published next to the DMG on the release page:

```sh
shasum -a 256 -c Perchnote_*_aarch64.dmg.sha256
```

Apple-silicon Macs only for now (the published asset is `aarch64`).
Intel users should build from source.

## 🚀 Quick start

```sh
git clone https://github.com/GurtekS/perchnote.git
cd perchnote
npm install
npm run tauri dev
```

First launch walks you through onboarding and grabs a Whisper model.
macOS will ask for Microphone and Screen Recording permission. Yes,
Screen Recording, even though nothing visual is captured. That's the
macOS permission that gates system-audio access.

## 📦 Building a release

```sh
npm run tauri:build
# .app and .dmg end up in src-tauri/target/release/bundle/
```

### Optional: bake in OAuth credentials

If you want Google or Microsoft Calendar to work without each user
registering their own OAuth app, copy `.env.example` to `.env`, fill in
the IDs and secrets, then export them before building:

```sh
set -a; source .env; set +a
npm run tauri:build
```

If you skip this, users can still paste their own client IDs into
Settings → Calendar.

### Regenerating icons

Source raven image lives at `assets/icon-source.png`. To regenerate every
platform size from it after editing:

```sh
npx tauri icon assets/icon-source.png
```

This rewrites everything under `src-tauri/icons/` including the macOS
`.icns`.

## 🤖 Use with Claude (MCP)

`perchnote-mcp` is a small read-only [MCP](https://modelcontextprotocol.io)
server over your meeting database. Your MCP client spawns it locally and
talks to it over stdio. There's no port, no network listener, and no
account. It exposes four tools: `search_meetings` (same filter grammar
as in-app search: `speaker:`, `folder:`, `before:`/`after:`, `"phrases"`,
`prefix*`), `get_meeting`, `get_transcript`, and
`list_open_action_items`. It can never write, and calendar attendee data
is never exposed. See [`docs/SECURITY.md`](./docs/SECURITY.md).

Build it:

```sh
cd src-tauri
cargo build --release --bin perchnote-mcp
# binary: src-tauri/target/release/perchnote-mcp
```

Then add it to `~/Library/Application Support/Claude/claude_desktop_config.json`
(Claude Desktop → Settings → Developer → Edit Config), adjusting the path
to where you cloned the repo:

```json
{
  "mcpServers": {
    "perchnote": {
      "command": "/path/to/perchnote/src-tauri/target/release/perchnote-mcp"
    }
  }
}
```

For Claude Code it's one command:

```sh
claude mcp add perchnote /path/to/perchnote/src-tauri/target/release/perchnote-mcp
```

By default it reads the production database
(`~/Library/Application Support/com.perchnote.app/perchnote.db`, safe
while the app is running, since WAL handles concurrent reads). Point it
elsewhere with `--db <path>` or the `PERCHNOTE_DB` env var. The binary
refuses databases whose schema doesn't match the version it was built
from, so rebuild it when you update the app.

## 🔒 Security posture

- **All secrets in the macOS Keychain.** OAuth tokens, OAuth client
  secrets, the Slack webhook URL, and the Anthropic API key all live
  under the `com.perchnote.app` service. SQLite never holds them.
- **Hard CSP.** Production CSP forbids `unsafe-eval` and `unsafe-inline`.
  Full policy is in `src-tauri/tauri.conf.json`.
- **No shell plugin.** Frontend code can't spawn processes or open
  arbitrary URLs. `open_url` is a Rust command with a scheme allow-list.
- **SSRF guard on ICS feeds.** Loopback, link-local, private, CG-NAT,
  and cloud-metadata IPs are rejected. Cleartext HTTP is rejected. 30s
  total + 10s connect timeout. Response body capped at 5 MiB.
- **Path traversal mitigation.** IDs get validated as v4 UUIDs and
  canonicalized against the app data dir before any filesystem op.
- **Prompt-injection mitigation.** Transcripts and user notes are wrapped
  in `<<<TRANSCRIPT>>>` / `<<<USER_NOTES>>>` fences. A system preamble
  tells the model to treat that content as data, not instructions.
- **Pinned `@tanstack/*`** to avoid the Shai-Hulud `react-router`
  compromise window (1.167.68 to 1.167.71). Exact versions in
  `package.json` plus the lockfile.
- **No third-party telemetry.** Outbound HTTP only goes to services you
  connect yourself: Anthropic, Google, Microsoft, Slack, and Hugging
  Face (for model downloads).

Full threat model: [`docs/SECURITY.md`](./docs/SECURITY.md).

## 📁 Project layout

```
assets/                 Brand source (icon-source.png, demo.gif)
src/                    React 19 + TanStack Router frontend
  components/           Per-route components
  lib/                  IPC client, TipTap config, keyword extraction
  stores/               Zustand stores (recording, UI, theme, toast)
src-tauri/
  src/
    audio/              Microphone + system audio capture
    calendar/           Google, Microsoft, ICS sync (plus shared SSRF guard)
    commands/           Tauri command handlers (IPC entry points)
    db/                 SQLite migrations and queries
    ai/                 Anthropic Messages API client and prompt assembly
    transcription/      whisper.cpp invocation
    secrets.rs          Keychain-backed secret storage
  swift/                Core Audio process tap helper (compiled by build.rs)
  icons/                Bundled platform icons (regenerated from assets/)
  capabilities/         Tauri permissions (notification only)
  tauri.conf.json       CSP, bundle metadata
scripts/
  install.sh            Build → /Applications/Perchnote.app
  test.sh               Build + tests + live smoke test
  check-tanstack-pin.mjs  Offline supply-chain pin check
```

## 🛠️ Scripts

| Command              | What it does                                       |
| -------------------- | -------------------------------------------------- |
| `npm run dev`        | Vite frontend only (Tauri backend mocked)          |
| `npm run tauri dev`  | Full Tauri app in dev mode                         |
| `npm run build`      | Type-check and build the frontend                  |
| `npm run tauri:build`| Build and bundle the macOS `.app` and `.dmg`       |
| `npm test`           | Vitest suite                                       |
| `npm run verify:frontend` | Frontend build plus Vitest suite             |
| `npm run verify:rust`| Rust type-check plus library unit tests            |
| `npm run check`      | Frontend and Rust verification without audits      |
| `npm run verify:tanstack-pin` | Offline TanStack router supply-chain pin check |
| `npm run verify:audit` | npm and Rust dep advisory checks                 |
| `npm run verify`     | Full local verification pipeline                   |

## 🤝 Contributing

PRs welcome. Architecture map in [`CONTRIBUTING.md`](./CONTRIBUTING.md).
Before you submit:

1. Run `npm run verify`. It runs frontend checks, Rust checks, and
   dependency audits.
2. For a faster local loop before audits, run `npm run check`.
3. If you add a new outbound destination, update the CSP (for any browser
   calls) and `docs/SECURITY.md`. Rust calls bypass CSP but should still
   be documented.
4. Don't bring back shell-execute or `unsafe-eval`.

## 📄 License

MIT. See [LICENSE](./LICENSE).
