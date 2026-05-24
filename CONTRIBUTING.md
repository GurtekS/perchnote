# Contributing to Perchnote

Thanks for the interest. This document is the architecture map — start
here, then read the code. The codebase is the source of truth; this is
the index.

For the user-facing site visit [perchnote.com](https://perchnote.com).
For local-build docs read [`README.md`](./README.md). For the threat
model read [`docs/SECURITY.md`](./docs/SECURITY.md).

---

## 1. What Perchnote is

A local-first meeting-notes app for macOS. Record a meeting, transcribe
it on-device with whisper.cpp, then optionally hand the transcript to a
Claude-class LLM that turns it into structured notes (sections, action
items with assignees and deadlines, tags). You can also chat with a
single transcript or ask AI questions across meetings.

Everything sensitive — audio, transcripts, notes, OAuth tokens, the
Anthropic API key — lives on the user's machine. The only outbound calls
are the ones the user opts into: calendar sync (Google, Microsoft, ICS),
Slack sharing, and the chosen AI provider.

---

## 2. Tech stack at a glance

| Layer | Stack |
|---|---|
| Desktop shell | Tauri 2 (Rust + WKWebView) |
| Frontend | React 19, TypeScript, TipTap 2.27 (with `extension-mention`, `suggestion`, `extension-document`), TanStack Router 1.167.4 (pinned, see §10), TanStack Query 5.90.21 (pinned), Zustand, Tailwind CSS |
| Backend | Rust (stable). SQLite via `rusqlite 0.31` + `rusqlite_migration 1`, `hound 3.5` for WAV I/O, `realfft 3.5` for FFT in mel features, `reqwest 0.12` for HTTP, `keyring 3` (apple-native) for the macOS Keychain |
| Platform helpers | Swift — `ProcessAudioTap.swift` (Core Audio CATapDescription for system-audio capture), `AppleAI.swift` (FoundationModels integration, macOS 26+). Both compiled into the binary via `build.rs` |
| Transcription | whisper.cpp invoked as a subprocess (`WhisperSidecar`). Model files are managed in app data dir |
| AI inference | One of: Anthropic Messages API (`api.anthropic.com/v1/messages` with tool-use for structured output), Ollama (`localhost:11434`), or Apple FoundationModels (on-device, macOS 26+). Provider is per-user via the `ai_provider` setting |

---

## 3. Project layout

```
src/                          React frontend
  App.tsx                     Top-level providers (QueryClient, Router)
  routes/                     TanStack Router file-based routes
    __root.tsx                Shared layout (IconRail, MeetingListPanel, AskAIOverlay, CommandPalette)
    index.tsx                 Home (TodayView)
    meeting.$id.tsx           Single-meeting view
    meetings.tsx              Meeting list / archive
    calendar.tsx              Calendar view
    folders*.tsx              Folder views
    settings.tsx              Settings nav + panels
  components/
    layout/                   IconRail, MeetingListPanel, MeetingBanner
    meeting/                  Per-meeting UI: MeetingView (composes the rest),
                                MeetingHeader, MetadataStrip,
                                NotesSurface, NoteEditor,
                                MeetingActionsBar, AiNotesHeader,
                                LiveTranscriptView, AudioBars,
                                EnhancingSkeleton, EnhanceAnimationOverlay,
                                EnhanceButton, ChatPanel, AskAIOverlay,
                                IdentifySpeakersPanel
    settings/                 Settings panels (AI, Audio, Calendar, Data, etc.)
    shared/                   CommandPalette, ContextMenu, etc.
  lib/
    ipc.ts                    Typed wrapper around `invoke` for every Tauri command
    tiptap/                   TipTap config + custom nodes
    runtime.ts                isTauriRuntime() guard for dev/browser fallbacks
  stores/                     Zustand stores (recording, UI, theme, toast)

src-tauri/
  src/
    audio/                    Microphone, system audio, ring buffer, mixer,
                              mel features, post-recording speaker clustering
    calendar/                 Google, Microsoft, ICS sync (+ shared SSRF guard)
    commands/                 Tauri command handlers (IPC entry points)
    db/                       SQLite migrations + queries
    ai/                       AI providers + prompt assembly (Anthropic, Ollama, Apple)
    transcription/            whisper.cpp invocation
    secrets.rs                Keychain-backed secret storage
  swift/                      Core Audio process tap helper (compiled by build.rs)
  icons/                      Bundled platform icons (regenerated from assets/)
  capabilities/               Tauri permissions (notification only)
  tauri.conf.json             productName=Perchnote, identifier=com.perchnote.app, CSP
  Cargo.toml                  Crate name=perchnote, lib=perchnote_lib
  build.rs                    Compiles Swift helpers, emits rpath for Swift stdlib

assets/                       Brand source files
  demo.gif                    README hero
  icon-source.png             1024px source (regenerate platform icons from this)

docs/
  SECURITY.md                 Threat model + control list

scripts/
  install.sh                  Build → /Applications/Perchnote.app
  test.sh                     Build + tests + live smoke test
  check-tanstack-pin.mjs      Offline supply-chain pin check
```

---

## 4. Data model

DB file: `~/Library/Application Support/com.perchnote.app/perchnote.db`
(WAL mode, foreign keys on). Migrations are run on app start via
`rusqlite_migration`. The constant `EXPECTED_MIGRATION_COUNT` in
`db/mod.rs` must match the number of `M::up` entries in
`db/migrations.rs`.

Tables (highlights — see `db/migrations.rs` for the full schema):

| Table | Purpose |
|---|---|
| `meetings` | One row per meeting (recorded or calendar-sourced). Fields include title, scheduled_start, actual_start, calendar_event_id, attendees (JSON), location, platform, status (`upcoming` / `recording` / `complete` / `archived`), is_pinned, is_archived, deleted_at, note_status |
| `notes` | One row per meeting (1:1). Holds both `raw_content` (user's TipTap JSON) and `generated_content` (AI-produced TipTap JSON). Edit-routing chooses which to update based on the current display mode |
| `transcripts` | One row per meeting. `segments` is a JSON array of `{start_ms, end_ms, text, speaker}` |
| `transcripts_fts` | FTS5 virtual table indexing `segments` for fast full-text search. Auto-maintained by triggers |
| `chat_messages` | Conversation history for the chat panel; tied to meeting_id (or NULL for cross-meeting chats) |
| `templates` | Note-generation prompt templates (Standard, Standup, 1:1, Sales Call, etc.) |
| `settings` | Key-value strings. Non-secret only — secrets go to Keychain |
| `speaker_labels` | Maps `(meeting_id, speaker_key)` → `display_name`. Per-meeting since migration 11 — naming "Speaker 1" in one meeting doesn't apply to another |
| `voice_profiles` | Persistent voice samples: id, speaker_name, sample_path (WAV in `voice_profiles/`), embedding (JSON-encoded 64-dim mel vector, nullable on legacy rows) |
| `mention_candidates` | Global attendee-name pool for @-mention autocomplete. Capped to top-200 by (freq DESC, last_seen_at DESC). Backfilled from existing meetings on migration 9 |
| `folders`, `meeting_folders`, `tags`, `meeting_tags` | Organization |
| `meeting_links` | Soft-linked related meetings |
| `attachments` | Files attached to a meeting (canonicalized to `$APPDATA/attachments/`) |

App data dir layout:

```
~/Library/Application Support/com.perchnote.app/
  perchnote.db                SQLite (+ -wal, -shm)
  recordings/{meeting_id}.wav One file per recording
  models/                     Whisper model files (downloaded via Settings → Audio)
  voice_profiles/{uuid}.wav   Voice samples from speaker identification
  attachments/                Per-meeting attachments
```

Secrets (never stored in SQLite) live in the macOS Keychain under
service `com.perchnote.app`. See `secrets.rs::SecretKey`:
GoogleClientSecret, GoogleOAuthTokens, MicrosoftClientSecret,
MicrosoftOAuthTokens, SlackWebhookUrl, AnthropicApiKey.

---

## 5. Key user flows

### 5.1 Recording

1. User clicks Record (or types `/` → "Start Recording" in CommandPalette).
2. Frontend calls `start_recording` IPC with the saved `audio_device` setting.
3. Rust kicks off three threads: mic capture (`cpal`), optional
   system-audio capture (CoreAudio process tap via Swift FFI), and an
   `AudioMixer` that merges and encodes to WAV.
4. Mic capture has a built-in fallback: if the named device isn't
   present (USB unplugged etc.), it uses `default_input_device()`,
   emits `recording-warning` + `audio-device-active` events, and clears
   the stale `audio_device` setting.
5. As audio flows, `WhisperSidecar` is fed chunks; it emits
   `TranscriptSegment` messages back which the frontend renders live
   and persists to `transcripts`.
6. On stop, the WAV finalizes, `recording-stopped` event fires, the
   meeting transitions to `complete`, and `PostRecordingScreen` shows.

### 5.2 Enhance (AI notes)

1. User clicks Enhance (or "Enhance Notes" from the CommandPalette on a
   meeting page). The frontend calls `generate_meeting_notes` IPC.
2. The Rust handler builds a prompt from the template + transcript +
   user notes + optional user_context (Settings → AI), then calls
   `ai::generate_notes(&db, &prompt)`.
3. `ai::generate_notes` reads the `ai_provider` setting and dispatches:
   - **Anthropic**: tool-use with `NOTE_OUTPUT_SCHEMA` forces JSON
     conforming to `GeneratedNotes { title, summary, sections, action_items, tags }`.
   - **Ollama**: `format: <schema>` for JSON mode against the local server.
   - **Apple Intelligence**: `@Generable` typed Swift structs, on-device
     via `FoundationModels` (macOS 26+ with Apple Intelligence on).
4. The frontend's `EnhanceButton` calls `generatedNotesToTiptap(notes)`
   — a pure transform that builds a TipTap doc with `summary`,
   `actionItem`, etc. custom nodes — then saves it to
   `notes.generated_content` via `update_note_generated_content`.
5. The animation overlay types the markdown form across the screen
   while the editor swaps to the structured doc.

### 5.3 AI-notes display

When `isEnhanced && notesDisplayMode === "ai"`:

- **Chrome above the editor (`AiNotesHeader`)**: tag pills row, pulled
  from the doc's root `attrs.tags` (via the `DocumentAttrs` TipTap
  extension).
- **Inside the editor**:
  - `summary` node renders as a left-accent card with a "SUMMARY" label.
  - H2 headings get a colored left bar (`.ai-enhanced-text h2` CSS).
  - `actionItem` nodes render via a React node view: checkbox + task +
    assignee pill (avatar + name) + relative date pill.
- Toggling an action-item checkbox dispatches a TipTap node update →
  `editor.onUpdate` → routes to `update_note_generated_content`, so the
  state persists across reloads.

### 5.4 Speaker identification

1. After a recording with multiple speakers, `PostRecordingScreen`
   shows the `IdentifySpeakersPanel`. Also reachable from the
   transcript drawer.
2. The panel calls `unknown_speakers_for_meeting`, which:
   - Loads the transcript JSON and finds `speaker_key`s not present in
     `speaker_labels` for this meeting.
   - Picks the longest contiguous segment for each (range = play snippet).
   - For each, computes a mel-feature vector and queries
     `match_voice_profile(query, 0.78)` for the best cross-meeting match.
3. The user clicks ▶ on a row (plays the snippet via an `<audio>`
   element pointed at `convertFileSrc(/path/to/recording.wav)`),
   confirms or edits the suggested name, clicks Save.
4. Save → `identify_speaker` IPC:
   - Clips the snippet to `voice_profiles/{uuid}.wav` (mono 16 kHz).
   - Extracts a fresh 64-dim mel embedding from the clip.
   - Inserts a `voice_profiles` row with the embedding (JSON-encoded).
   - Upserts a `speaker_labels` row scoped to `(meeting_id, speaker_key)`.
5. **Re-detect speakers** in the same panel triggers
   `recluster_speakers`, which reassigns the transcript's `speaker`
   labels using online clustering over mel embeddings extracted from
   the full meeting WAV. Threshold 0.88, EMA centroid updates,
   short-segment inheritance. See `src-tauri/src/audio/cluster.rs`.

The cross-meeting matching is mel-feature cosine — a baseline good for
2–3 person meetings. Better embedding models (ECAPA-TDNN, 3D-Speaker,
etc.) can swap in behind `match_voice_profile` without changing the
rest of the pipeline.

---

## 6. Editor architecture (TipTap)

The editor instance is mounted once per meeting. Content lives in
`notes.raw_content` (when on My Notes tab) or `notes.generated_content`
(AI Notes tab). The same React editor handles both; `handleNoteUpdate`
in `MeetingView` routes `onUpdate` JSON to the right column by mode.

Registered extensions live in `src/lib/tiptap/extensions.ts`:

- **StarterKit** — paragraph, heading (h1–h3), bullet/ordered lists,
  blockquote, code, code block, hr. Configured with `document: false`
  because we use `DocumentAttrs` instead.
- **DocumentAttrs** — extends the root Document node with a `tags` attr.
- **Placeholder**, **TaskList/TaskItem**, **Underline**, **Highlight**,
  **Link** (scheme allow-list of http/https/mailto, `isAllowedUri`
  enforces).
- **Summary** (`summary.ts`) — block node, inline content. Renders as a
  card via CSS.
- **ActionItem** (`actionItem.ts` + `ActionItemView.tsx`) — atom node,
  attrs `{task, assignee?, deadline?, done}`. React node view handles
  the checkbox + pills.
- **Callout** (`callout.ts`) — block node with `variant: "info"|"warn"|"tip"`.
- **Toggle** (`toggle.ts` + `ToggleView.tsx`) — collapsible. React node
  view. **Important**: when collapsing, the view first moves the editor
  cursor out of the body if it's currently inside, otherwise the cursor
  lands in `display: none` DOM and the editor appears frozen.
- **SlashCommand** (`slashCommand.ts`, `slashCommandItems.ts`,
  `SlashCommandList.tsx`) — `/` trigger, 13 items (headings, lists,
  quote, divider, code, callouts × 3 variants, toggle). Uses
  `@tiptap/suggestion` + `tippy.js`.
- **MentionExtension** (`mention.ts`, `MentionList.tsx`) — `@` trigger.
  Suggestions come from `list_mention_candidates(prefix, 8)` against
  the cross-meeting name pool.

**Convention**: any interactive custom node (Toggle, ActionItem) uses a
React `NodeViewRenderer`. Static nodes (Summary, Callout) use plain
`renderHTML` arrays.

---

## 7. AI provider abstraction

`src-tauri/src/ai/mod.rs` exposes three public functions:
`generate_notes`, `rediarize`, `chat`. Each reads the `ai_provider`
setting (`anthropic` / `ollama` / `apple`) and dispatches to one of:

- `anthropic_api::*` — `https://api.anthropic.com/v1/messages`, uses
  tool-use with `NOTE_OUTPUT_SCHEMA` / `DIARIZATION_OUTPUT_SCHEMA` for
  structured outputs. Bring-your-own-key (stored in Keychain as
  `AnthropicApiKey`). Models picked dynamically —
  `list_anthropic_models` IPC calls `GET /v1/models` so we don't
  maintain a hardcoded list.
- `ollama::*` — `http://localhost:11434/api/chat`. Uses Ollama's
  `format` parameter for JSON-mode structured outputs. Recovery: if
  the model hallucinates a slightly-off schema,
  `salvage_notes_from_partial` fills in defaults.
- `apple_ai::*` — calls into `AppleAI.swift` via FFI. Uses
  `LanguageModelSession` from `FoundationModels` (macOS 26+) with
  `@Generable` structs. Returns null on machines without Apple
  Intelligence; the dispatcher then surfaces an error.

When adding a new provider: implement the three functions, add an enum
variant, branch in `mod.rs::generate_notes/rediarize/chat`. The Settings
→ AI panel handles provider selection and live-fetches available models.

---

## 8. IPC and events

### 8.1 Tauri commands (Rust ↔ JS)

Registered in `src-tauri/src/lib.rs`'s `invoke_handler` list. Frontend
calls go through `src/lib/ipc.ts` which provides typed wrappers. The
canonical surface (not exhaustive — read `ipc.ts`):

- Audio / recording: `start_recording`, `stop_recording`, `is_recording`,
  `is_paused`, `pause_recording`, `resume_recording`,
  `list_audio_devices`, `list_output_devices`.
- Meetings: `list_meetings`, `get_meeting`, `create_meeting`,
  `update_meeting_metadata`, `delete_meeting`, etc.
- Notes: `create_note`, `get_note_by_meeting`,
  `update_note_raw_content`, `update_note_generated_content`,
  `rediarize_transcript`.
- AI: `check_ai_configured`, `is_ollama_running`, `list_ollama_models`,
  `is_apple_ai_available`, `list_anthropic_models`,
  `generate_meeting_notes`, `chat_with_meeting`, `ai_search_meetings`.
- Speaker ID: `unknown_speakers_for_meeting`, `identify_speaker`,
  `recluster_speakers`, `get_recording_url`, `list_voice_profiles`.
- Mentions: `list_mention_candidates`.
- Settings: `get_setting`, `set_setting` — automatically routes keys
  in `secret_key_for(...)` to the Keychain.
- Calendar / sharing: `auth_google_calendar`, `auth_microsoft_calendar`,
  `add_ics_url`, `sync_ics_calendars`, `share_to_slack`.

### 8.2 Custom DOM events

Used for loosely-coupled coordination between components without
threading callbacks. Listened via `document.addEventListener(...)`:

| Event | Dispatched by | Listened by |
|---|---|---|
| `open-command-palette` | IconRail search button | CommandPalette |
| `focus-meeting-search` | `__root.tsx` Cmd+F handler | MeetingListPanel |
| `open-transcript-drawer` | `__root.tsx` Cmd+T handler | MeetingView |
| `palette-enhance-notes` | CommandPalette "Enhance Notes" item | MeetingView |
| `menu-preferences` | Tray menu | `__root.tsx` |
| `tray-new-meeting`, `tray-toggle-recording` | Tray menu | `__root.tsx` |

### 8.3 Tauri events (Rust → JS)

`app.emit("name", payload)`. Frontend listens via
`@tauri-apps/api/event`'s `listen()`:

| Event | Meaning |
|---|---|
| `transcript-segment` | New transcript segment from whisper.cpp |
| `recording-warning` | Non-fatal recording problem (system audio failed, mic fell back) |
| `audio-device-active` | The mic actually being used right now (after fallback or otherwise) |
| `audio-level` | RMS + peak + quality assessment for the VU meter |
| `notes-generated` | Enhance finished |
| `calendar-synced` | New events came in from a calendar sync |
| `model-download-progress` | Whisper model download progress |

---

## 9. Build, install, test

```sh
# Common verification
npm run verify:frontend            # tsc + vite build, then Vitest
npm run verify:rust                # cargo check, then cargo test --lib
npm run check                      # frontend + Rust checks, no audits
npm run verify:tanstack-pin        # offline TanStack router supply-chain pin check
npm run verify:audit               # npm audit + cargo audit
npm run verify                     # check + audit

# Direct Rust tests + checks
cd src-tauri
cargo check
cargo test --lib
cargo audit                        # zero advisories required

# Frontend dep audit
npm audit                          # zero advisories required

# Full app bundle
npm run tauri:build                # Produces .app + .dmg in src-tauri/target/release/bundle/

# Install + launch (replaces /Applications/Perchnote.app)
./scripts/install.sh
open "/Applications/Perchnote.app"

# All-in-one test pipeline (bundle build + tests + smoke of local .app)
./scripts/test.sh                  # or --quick for unit/compile checks without rebuilding the .app
```

**Important**: never run plain `cargo build --release` without
`tauri build` — bare cargo doesn't embed the frontend `dist/`, so the
resulting binary loads from `localhost:1420` (which isn't running) and
shows a blank screen. Always use `npm run tauri:build`.

---

## 10. Pinned dependencies — supply-chain guard

The `@tanstack/react-router` package was compromised in versions
**1.167.68–1.167.71** (the "Shai-Hulud" supply-chain attack of
2026-05-11, GHSA-g7cv-rxg3-hmpx). To prevent ever drifting into that
range:

- `@tanstack/react-router` is pinned to **1.167.4** (no caret) in
  `package.json`.
- `@tanstack/react-query` is pinned to **5.90.21**.
- `@tanstack/router-plugin` is pinned to **1.166.13**.
- `npm run verify:tanstack-pin` checks `package.json` and
  `package-lock.json` offline and fails if `@tanstack/react-router`
  enters the compromised range or loses its exact root pin.

Upgrading these requires double-checking the upstream advisory list.

---

## 11. Code conventions

- **TipTap nodes with interaction → React node view.** See
  `ActionItemView.tsx` and `ToggleView.tsx` as templates.
- **Schema-conformant AI output** — always go through tool-use
  (Anthropic) or `format` (Ollama) or `@Generable` (Apple). Don't ask
  the model to "return JSON" in the prompt and parse it.
- **Custom DOM events for cross-component coordination** when the
  components don't share a clean parent. See §8.2 for the existing
  events; reuse patterns rather than introducing new ones casually.
- **Secrets go to Keychain**, not SQLite. Use `SecretKey` enum entries.
- **Migrations** — append `M::up` to `db/migrations.rs`, bump
  `EXPECTED_MIGRATION_COUNT` in `db/mod.rs`, write a test in
  `migration_N_tests` that confirms the new schema state. Never edit a
  migration that has already shipped.
- **Tests live next to the surface they test** — Rust tests inline in
  the file, Vitest tests in `src/__tests__/`. New features ship with
  tests.
- **Commit message style**: imperative mood, scoped prefix
  (`feat(audio):`, `fix(tiptap):`, `refactor:`, `docs:`, `chore:`).
- **macOS-only** — the Swift bridges, Keychain, and Core Audio bits are
  deliberately macOS-only. Don't add Linux/Windows-specific paths
  without discussing first.

## 12. Avoid

- **Reintroducing the Tauri shell plugin or `unsafe-eval`.** Both are
  intentionally absent for security.
- **Bare `cargo build --release`** for the user's local build — always
  `npm run tauri:build`. See §9.
- **Writing into `notes.raw_content`** when the editor is in AI Notes
  mode — route through the existing `handleNoteUpdate` which checks
  `notesDisplayMode`.
- **Putting `useRouter` / `useNavigate` / `useMatchRoute`** in
  components rendered outside `RouterProvider` (e.g., directly in
  `App.tsx`). Shared chrome lives in `routes/__root.tsx`.
  `CommandPalette` is there for exactly this reason.
- **`display: none` on an editor body that ProseMirror thinks contains
  a cursor.** The Toggle's React node view handles this by moving the
  cursor out before collapsing. Other "hide-while-editor-thinks-it's-there"
  patterns will appear to freeze the editor.

---

## Pull request checklist

1. Run `npm run verify`. Frontend checks, Rust checks, and dependency
   audits must pass.
2. If you add a new outbound destination, update the CSP and
   `docs/SECURITY.md`. Rust calls bypass CSP but should still be
   documented.
3. Don't bring back shell-execute or `unsafe-eval`.

Thanks for contributing.
