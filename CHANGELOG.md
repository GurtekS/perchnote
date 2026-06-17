# Changelog

## Unreleased

## 0.8.0 (2026-06-12)

### Better speaker detection on fast back-and-forth
- When two people trade quick lines inside one transcript segment, speaker
  detection no longer hands the whole block to whoever talked longer and
  drops the other person. Segments that cross a speaker change are now split
  at the word boundary so each turn keeps its own speaker, and long
  multi-speaker blocks break into shorter, correctly-attributed lines.

### Resizable columns in All Meetings
- In the table view, drag the right edge of any header (Title and every
  other column) to resize it. Your widths are remembered. Arrow keys resize a
  focused grip, and double-clicking it resets that column.

### Empty recordings don't stick around
- Stopping a recording that captured no audio, whether from a mis-click on
  record or a capture that never started, no longer leaves an empty meeting
  in your list. If there's no audio and nothing was typed or transcribed, the
  meeting is discarded on stop and you're returned home. Anything with
  audio (even silent), a transcript, or notes is always kept, and
  deliberately-created notes-only meetings are never touched.

### Untitled meetings name themselves
- A meeting left on its placeholder title ("Untitled Meeting",
  "Meeting, Jun 11, 6:05 PM") gets a short descriptive title from its
  transcript as soon as transcription finishes, with an Undo right in
  the toast. The scope is strict: titles you typed are never touched (even
  one literally named "Meeting"), calendar-synced meetings keep their
  event title, voice notes keep naming themselves from their opening
  words, and without an AI provider the placeholder simply stays.
  Toggle under AI settings → Generation → Auto-naming.

### A deep usability pass (52 verified findings, all fixed)
- **Export as Markdown now includes your AI notes**. It was silently
  exporting only raw notes + transcript.
- **Safer destructive actions**: bulk delete confirms and says how to
  undo; deleting voice profiles asks first; "always make this fix" is
  a checkbox on the replace bar, not a disappearing toast.
- **Everything is findable**: Quick Voice Note in the command palette
  (⌘⇧N), recipes and All-meetings in the palette, clickable tags that
  filter the meeting list, "Move to folder" in the right-click menu,
  catch-me-up and Ask AI visible while recording in both panes, and
  ⌘F works on every screen.
- **One way to do each thing**: a single Speakers surface in the
  transcript drawer (click any speaker pill to land there), one review
  surface at a time on Tasks, AI-generation settings live under AI,
  the default template under Templates.
- **Clearer words everywhere**: no more "diarization" or pipeline
  jargon, one name per action, friendly error messages throughout.
- **More keyboard- and screen-reader-friendly**: snooze controls
  reveal on keyboard focus, toggles announce their state, the voice
  recorder speaks its progress, focus never silently vanishes.
- Visual consistency: one recipe each for floating panels, cards,
  buttons, text sizes, and icon sizes across 40+ files; light theme
  reading contrast fixed app-wide.

### A visual refresh, end to end
- **Slickness pass**: floating surfaces (command palette, dialogs,
  toasts, Ask AI) are now frosted glass with real depth; cards read as
  material with inner highlights; status dots glow; the home hero got
  a display-grade date, a glowing kicker, and a sculpted record
  button; section rules fade instead of striping.
- **The whole app got a design pass**, verified screen-by-screen: deeper
  surface layering instead of flat black, crisper hairlines, readable
  secondary text everywhere (the old gray labels sat below accessibility
  contrast), one elevation scale, one keyboard focus ring, and
  hover-revealed list controls instead of always-on visual noise.
- **The brand green is now the accent in dark mode too.** Start
  Recording and Enhance carry an accent-driven gradient that follows
  whatever accent you pick in Settings (they were hardcoded indigo).
- Light mode inherited every improvement automatically.

### Corner-case sweep (two whole-app reviews, 30+ fixes)
- **Restoring a backup no longer deletes audio recorded after it.**
  Unrecognized recordings move to `recordings/orphaned/` instead of
  being removed.
- **Merging meetings can't corrupt notes anymore** (it used to wipe
  both sides' notes and tasks if both had typed notes). Merge now also
  carries speaker names, AI notes, folders, attachments, chat history,
  and talk stats, and the merged transcript reads in order.
- **Trashing, archiving, or renaming a calendar-synced meeting now
  sticks.** Sync used to resurrect or revert them every 5 minutes.
- **Apple Reminders completions and snoozes can't hit the wrong task**
  after a note edit. Write-back verifies the task's text and re-locates
  it if it moved.
- **Enhance is honest**: it refuses empty meetings instead of inventing
  notes, can't double-run against the automatic recap, can't leak one
  meeting's notes into another if you navigate mid-enhance, and a dead
  transcriber now shows a banner *during* the recording instead of a
  silent "0 segments" at the end.
- Tasks use your local calendar day (evening users saw today's tasks
  as "Overdue"); deleting the recording-in-progress meeting is refused;
  tray Quit stops the recording first; trashed meetings stopped
  surfacing in semantic search; long-meeting chat says when it
  truncates; calendar events in other timezones land at the right hour
  and cancelled events stop syncing.
- Smaller: exports of emoji-titled meetings aren't invisible dotfiles,
  durations exclude paused time, week math is right in UTC+ timezones,
  huge task lists stay responsive, failed imports clean up fully, and
  a dozen more.

### Speakers that name themselves
- If you've saved a voice profile, recurring voices are now recognized
  and named automatically after each recording, strictly on-device and
  tuned so a wrong auto-name is ~never (ambiguous matches stay
  suggestions in the Speakers panel), with a per-speaker Undo the
  moment it happens. Toggle in Settings → Audio.

### Semantic recall for everyone
- Search and Ask AI's "means the same thing" matching used to require
  running Ollama. It now works out of the box using Apple's on-device
  language model (macOS 14+): no setup, no downloads from us, nothing
  leaves the Mac. Ollama remains available as an explicit choice in
  Settings → AI, and existing Ollama indexes keep working untouched.

### The transcript gets better after you stop
- **Accuracy pass (on by default, toggleable).** When a recording
  stops, the whole file is quietly re-decoded with full context and
  the live transcript is upgraded in place. Speaker labels and
  highlights carry over; the view refreshes the moment it lands. If
  you edited a segment in the meantime, your edits win, and the pass
  steps aside instead of overwriting.
- **Correction rules that stick.** When you fix a misheard name with
  replace-all, one tap on "Always make this fix" saves it as a rule
  applied to every future transcription (live, import, and accuracy
  pass alike). Manage the list in Settings → Audio.

### Ask AI, mid-meeting
- Ask AI now works while you're still recording. An **Ask AI** button
  sits next to "Catch me up" on the live transcript (⌘J always worked;
  now you can see it). The AI is told the transcript is partial, so it
  answers about a discussion in progress instead of pretending the
  meeting already ended.

### The menu bar knows your meetings
- The tray menu now lists your three most recent meetings, one click
  from anywhere on your Mac to the notes.

### Quick voice notes
- **Capture a thought without ceremony.** "Quick Voice Note" in the
  menu-bar tray starts recording immediately into a meeting tagged
  `voice-note`, and when you stop, it titles itself from your first
  words. Search, recall, tasks, and AI notes all work on it like any
  meeting.

### Recipes that know your meetings
- A recipe can now carry a **scope** (`folder:ClientX after:2026-03`) and
  run across your recent meetings instead of just the open one, using the
  same retrieval as Ask AI's All-meetings mode.
- **Auto-run for a series.** After running a recipe, one click makes it
  run automatically every time a meeting in that series finishes. The
  output appears as a dismissible card on the meeting; it is never
  written into your notes and never saved.

### Notes that say where they came from
- **Enhance receipts.** AI notes now carry a quiet line saying which
  provider and model wrote them and when, from the transcript as it
  stood at generation. If the transcript is corrected afterwards, an
  amber "Transcript changed after these notes" badge offers one-click
  re-enhance, and the previous version is kept, viewable, and
  restorable (restore is its own undo).

### Your vault, never clobbered
- If a mirrored note's file was edited outside Perchnote, the mirror
  now refuses to overwrite it. Your version stays, the app's version
  is written to a `.conflict.md` beside it, and a toast tells you
  once (with a "Show in Finder" shortcut).
- Renaming a meeting (or switching the vault layout) used to delete
  the old file even if you'd edited it outside the app. Cleanup now
  checks first and leaves your edited copy in place.

### Tasks, in bulk
- Select many action items on the Tasks view and complete, reopen, or
  copy them in one action: one click per decision, not per task.

### Reads better, sized your way
- AI notes now render one step smaller and tighter than the typing
  surface, so generated output stopped looking longer than it is.
- **Editor font size** (Settings → General): Small / Default / Large,
  applied to your notes and AI notes instantly.

### Fixes
- Recording could restart by itself after enhancing (a "start recording
  on arrival" flag armed for a meeting you were already viewing never
  got consumed, then fired on a later navigation). The flag now names
  its target meeting and can only ever start that one.
- An AI-generated task could be assigned to someone who was never in
  the meeting (a name from your own background context leaked into a
  solo call's tasks). Owners now must appear in the transcript, the
  speaker names, or the attendee list, or else the task is kept
  but unowned.
- The "Catch me up" card could render with the live transcript showing
  through it.
- The note editor's formatting bar is back while recording. It had
  been hidden exactly when most notes get written.
- Voice samples in Settings → Audio can now be selected and deleted
  in bulk.
- AI-enhanced notes could borrow a speaker's name from a *different*
  meeting (a global label map keyed by "Speaker 1" collided across
  meetings). Notes and meeting chat now resolve names strictly within
  the meeting. Re-enhance any affected meeting to repair its notes.
- "Re-detect speakers" running at the same time as the accuracy pass
  (or a transcript edit) can no longer quietly revert the newer
  transcript; whichever finishes second now steps aside and retries.
- The accuracy pass found models only in the app's own folder. It
  now finds Homebrew-installed whisper models too, and heavy
  background transcriptions queue instead of stacking in memory.
- A bulk task action that fails partway now says how far it got and
  keeps the remaining items selected for retry.
- Two meetings with the same title on the same day no longer share one
  vault file (they used to alternate "conflict" warnings forever). The
  second meeting now mirrors to "Title (2).md", and existing
  shared files untangle themselves on their next write.
- The "system audio is flat" warning fired during ordinary quiet
  stretches of real calls. It now waits 45 seconds before warning and
  90 before rebuilding the tap, and the copy says what it means.
- Onboarding now teaches the drop-a-file import path with live
  feedback on your first import.

## 0.7.0 (2026-06-10)

### Every recording, not just the ones Perchnote made
- **Drop any audio file onto the window** (Voice Memos, Apple Notes
  call recordings, in-person captures) and it becomes a normal
  meeting: converted locally, transcribed, speakers detected, notes
  ready to enhance. Dated honestly from the file itself.
- **Stereo recording (optional)**: your mic on the left channel,
  everyone else on the right. Playback you can lateralize; toggling
  the setting can never corrupt an in-progress recording.

### Mid-meeting and post-meeting AI, on your terms
- **"Catch me up"**: joined late or zoned out? One click on the live
  transcript recaps what's been discussed, decided, and asked, in a
  card that's never saved anywhere.
- **Recipes**: your saved prompts ("Draft follow-up email", "Status
  update for my manager", "Decision log", "Q&A extract"), one click
  from any meeting, output to copy, never auto-written into notes.
  Add your own.
- **Quarter and year, in sentences**: the Insights view now tells
  the longer story from counts, hours, and titles only, plus a
  **brag doc** export: your completed work as plain markdown, with a
  line stating none of it is AI-written.

### Fix what was heard
- **Edit any transcript segment, or fix a misheard name everywhere**
  with find-and-replace. Search, semantic recall, and citations all
  re-sync.
- **Paste the deck into your notes**: ⌘V a screenshot; it's stored
  with the meeting, rendered inline, and mirrored as a link.

### Sharper recall
- Ask AI obeys typed filters (`folder:ClientX after:2026-03`).
- The "Related:" results row is now ranked by the same fusion math
  the chat retrieval uses, in one round-trip.
- **Recent meetings rank like it**: results decay gently with age
  (75-day half-life, never below a floor), so last Tuesday's
  discussion outranks a 2024 mention without typing `after:`.
- **Apple Speech engine (macOS 26+, beta)**: zero-download
  transcription for imports and re-transcription, ~13× faster on
  single files; whisper stays the default and the live engine.
- Claude (or any MCP client) can now see a meeting's recording path:
  read-only, local, path only.

### Capture, hardened (from a second adversarial audit)
- **Echo cancellation (experimental, off by default)**, for meetings
  on speakers without headphones, using the system voice-processing
  unit. Falls back to standard capture rather than ever costing a
  recording.
- Importing stereo audio now downmixes properly. The converter was
  silently keeping only the left channel.
- Stereo recordings re-transcribe and re-detect speakers correctly.
- A transcript edit can no longer race the live transcriber and drop
  a freshly spoken segment; concurrent file drops queue instead of
  loading duplicate transcription engines; pasted-image links render
  correctly in Obsidian.

## 0.6.0 (2026-06-10)

### Your meetings, readable by your AI
- **perchnote-mcp**: a local, read-only MCP server so Claude Desktop,
  Claude Code, or any MCP client can search your meetings, read
  transcripts, and list open tasks *without anything leaving the
  machine*: no port, no network, no account; it refuses mismatched
  schema versions and never exposes calendar attendee data. Setup in
  the README; exposure model documented in docs/SECURITY.md.
- **Ask AI understands filters**: `what did we decide about pricing
  folder:ClientX after:2026-03` scopes retrieval to exactly that.

### Fix what was transcribed
- **Edit any transcript segment**: hover, pencil, fix. Search,
  semantic recall, and citations all re-sync; custom data on the
  segment survives.
- **Replace everywhere**: find a misheard name, type the correction,
  one click fixes every occurrence (tells you how many).
- **Find, don't filter**: transcript search now keeps the
  conversation visible, steps "2 of 7" with Enter, and rings the
  current match. The old hide-non-matching behavior is a toggle.

### Hardening (from a full-day adversarial audit)
- Fixed a crash: searching notes or transcripts containing emoji/CJK
  near a match could panic the app on every keystroke.
- Cold-start deep links no longer double-fire their x-callbacks;
  callbacks are restricted to resuming a waiting shortcut (nothing
  can launder `shortcuts://run-shortcut` through Perchnote); deep
  links now surface a hidden window.
- Merged meetings keep their transcripts searchable; jump-to-moment
  hand-offs are keyed to their meeting (no foreign seeks); a pending
  mirror write can't outlive a hard delete.

### Search that finds the moment
- **Per-segment transcript search**: search hits now land on the exact
  sentence, not just the meeting. Results carry a real snippet of what
  was said and jump playback straight to that moment. (Under the hood:
  the transcript index was rebuilt per-segment, ranked by BM25, with
  existing transcripts backfilled automatically on first launch.)
- **Search filters**: `speaker:amy`, `folder:work`, `before:2026-06-01`,
  `after:2026-01-15`, `"exact phrase"`, and `budg*` prefix search work
  anywhere search does. Speaker filters match the people you've named
  in diarization. Typed filters show as chips so you can see what's
  active; a malformed date says "ignored" instead of silently failing.
- **The ⌘K palette searches everything**: titles, transcripts, and
  notes, grouped by meeting with timestamps on transcript hits. A
  meeting matched in several places shows every match. The footer
  teaches the filter syntax while you type.

### Ask AI that shows its work
- **Citations**: answers now cite their sources as [1][2] chips;
  clicking one opens the meeting and plays the cited moment. Retrieval
  is segment-level (the AI sees the relevant ~8k characters, not 15
  full transcripts), fusing keyword and semantic search when local
  embeddings are enabled.

### A vault that keeps up
- **The markdown mirror follows your notes**: edits re-mirror a few
  seconds after you stop typing, renaming a meeting moves its file,
  and hard-deleting a meeting removes its mirror. Layout is now
  configurable: one folder, by month (2026/06), or by meeting folder.
- **Frontmatter grew up**: mirrored notes carry the recording's path
  (`audio:`) for Dataview queries, alongside the existing deep link
  back to the meeting.

### Automation
- **Send to Things**: one click creates every open task in this view
  as Things to-dos, with due dates and a link back to the meeting.
  One-way by design; the button says so.
- **Deep-link verbs**: `perchnote://record/start?title=Standup`,
  `perchnote://search?q=…`, `perchnote://meeting/…/transcript`, and
  x-callback-url support for Shortcuts round-trips. Links that launch
  the app now run their action (they used to get lost during startup).
  See docs/SHORTCUTS.md for recipes. Callback URLs are restricted to
  the two automation schemes they exist for, so a webpage can't launder
  app launches through Perchnote.
- **Recording survives source trouble better**: fixed a case where a
  successfully recovered system-audio tap could immediately trigger a
  second, pointless recovery attempt.

### Insights: your meetings, in sentences
- **New Insights view** (⌘5): meeting load measured against *your own*
  typical week (12-week sparkline, dominant start-time window), open
  loops framed for action (count, oldest age, what closed this week,
  never a guilt score), and topic-tracker trends (how often "pricing"
  came up, month over month). No filters, no date pickers; every
  module ends in one click. Computed entirely on this Mac.
- **"Your June"**: a few honest paragraphs about your month,
  generated by your AI provider from counts, hours, and titles only.
  The card's "What the AI saw" disclosure shows the exact facts JSON
  that was sent, so the privacy claim is inspectable, not asserted.
  Transcripts and notes never leave the app.

### Eyes-free and keyboard-first
- **VoiceOver overhaul**: the notes editor announces itself properly
  (and consecutive blocks no longer run together into one utterance);
  navigation announces where you landed and keeps the window title
  honest; toasts speak through reliable pre-mounted live regions with
  correct urgency (errors interrupt, success waits its turn);
  "Enhancing notes…" is audible during generation; increased-contrast
  mode gets solid borders and raised muted text.
- **One Escape, one layer**: a dismissal ladder closes only the
  topmost overlay (closing the shortcuts panel no longer also wipes
  your list selection and search). The transcript drawer now closes
  on Escape too.
- **The meeting list is one tab stop**: ↑/↓/Home/End move between
  meetings, Enter opens, Space selects; Tab re-enters where you left.
  F6 cycles the panes (list ↔ notes ↔ transcript). All dialogs share
  one focus-trap contract and return focus where you were.
- An axe accessibility test suite now guards the overlay components,
  and the icon-button/focus-indicator sweep it triggered is fixed.

## 0.5.0 (2026-06-10)

Two research-driven cycles: plan v3 (twelve items synthesized from
deep studies of Granola, Fathom, Circleback, Otter, Fireflies, Notion
AI, and the local-first ecosystem) and the start of plan v4
(transcription quality + production polish).

### Never miss a meeting
- **Call detection**: when Zoom, Teams, or your browser starts using
  the microphone and Perchnote isn't recording, a nudge offers
  one-click recording into the calendar event you're presumably in.
  Only *which app* uses the mic is checked, never any audio.
- **Instant recap**: recordings enhance themselves on completion, and
  "Notes ready, N action items" arrives as a notification.

### Speaker recognition, leveled up
- **Neural diarization**: Re-detect now runs a pyannote-grade pipeline
  on CoreML (validated on a real interview: 311 fine-grained turns vs
  30 before, catches sub-second interjections), falling back to the
  classic clusterer automatically.

### Transcription quality
- **Voice-activity gate**: an on-device Silero model (~1 MB, one-click
  download in Settings → Audio) screens out non-speech audio before
  transcription, the literature's strongest defense against whisper's
  phantom phrases. Plus: confidence-based segment filtering, a
  hallucination blocklist ("thanks for watching"…), beam-search
  decoding, and confidence-gated context carry.

### Continuity & focus
- **Carry-forward**: one click threads last meeting's unfinished items
  into this meeting's notes as a checklist agenda.
- **Series template memory**: pick a template for a recurring meeting
  once; every future instance (and instant recap) uses it. Re-run
  enhanced notes with any template without losing your raw notes.
- **Live highlights**: ⌘D flags the transcript moment while recording;
  filter any transcript to its flagged moments; flagged lines weigh
  heavier in the AI summary.
- **Per-bullet provenance**: section bullets carry ⏱ replay marks to
  the exact transcript moment, validated like action-item citations.
- **Topic trackers**: your terms ("pricing", a project name) counted
  and clickable on every transcript.
- **Talk balance**: you-vs-them speaking time and longest monologue,
  computed from the separate mic/system streams with no diarization.

### The task loop, completed
- **Reminders round-trip**: export is idempotent (the duplication bug
  is fixed), and checking a task off in Apple Reminders syncs back.
- **Snooze, buckets, triage**: due-date sections (Overdue/Today/This
  week/Later/No date), snooze that never touches meeting-stated
  deadlines, age chips, and a stale-item review flow (Done/Snooze/Drop).
- **Week in review**: Mondays open with last week's meetings, open
  items by age, and the next seven days' deadlines.
- **Per-assignee follow-up**: copy anyone's open items as an
  email-ready list.

### Notes you can trust more
- **Quotes-first generation**: the AI extracts verbatim evidence
  before composing, with stricter commitment-only action items and
  deterministic cleanup (placeholder owners, implausible deadlines,
  duplicates).

### Files, automation, polish
- **Markdown mirror**: notes as plain .md files in Documents/Perchnote
  for iCloud, git, or Obsidian.
- **Deep links**: `perchnote://record/start`, `/record/stop`,
  `/meeting/<id>` for Raycast, Shortcuts, and Stream Deck.
- **Flash-free launch** with window position memory; a unified rotating
  log that now also captures webview errors; a manual update check
  (auto-update deliberately waits for code signing, which protects
  your permission grants).
- Calendar week view lays out overlapping events side-by-side; the
  transcript toolbar and all async buttons keep stable geometry.

## 0.4.0 (2026-06-10)

Functionality deepening from the fact-checked 12-item plan v2
(`docs/ENHANCEMENT_PLAN.md`): all twelve ranks shipped.

### Recording & transcription
- **Whisper now runs inside the app**: the model loads once per
  recording instead of once per 5-second chunk (it was reloading ~145MB
  every few seconds), live transcription latency drops several-fold,
  segments can no longer arrive out of order, and context carries
  across chunks. `brew install whisper-cpp` is no longer needed; Metal
  acceleration is built in. Validated end-to-end on a real interview
  recording (~100× realtime).
- **Pause-aligned transcription chunks**: whisper now cuts at real
  speech pauses (≥600ms of quiet) instead of a flat 5 seconds, so words
  are never split at chunk boundaries; a quietest-moment fallback keeps
  the live transcript within ~12s even for non-stop talkers.
- **System audio reaches the recording file properly**: dedicated
  WAV-path resampler with drift cap; mic stalls (dead AirPods) no longer
  freeze the shared timeline, and you're warned after 5s of mic silence.

### AI notes
- **Templates actually work end-to-end**: the picker's choice and your
  typed notes both reach the model (previously the backend ignored both).
- **Ollama parity**: live streaming summaries, right-sized context
  windows (no more silent truncation at 2048 tokens for long meetings).
- **Apple Intelligence citation parity**: guided generation can now emit
  m:ss source chips; and for every provider, broken or missing citations
  are re-anchored to the best-grounded transcript moment instead of
  being dropped.
- **Copy/export includes everything**: a canonical serializer replaces
  the ad-hoc extractor that silently dropped the AI summary and every
  action item from copied/exported notes.

### Continuity
- **"Last time" card**: recurring meetings open with the previous
  session's summary, its unfinished action items, and a jump link.
- **Semantic recall foundation (experimental)**: when Ollama is running
  with an embedding model pulled (e.g. `nomic-embed-text`), transcripts
  are indexed into a local vector store inside the same SQLite file, so
  meaning-based lookups can find what keyword search misses. Fully
  local, zero-config, and invisible when Ollama isn't around.

### Backup you can trust
- **Full backup (.perchnote)**: one click writes a checksum-manifested
  archive (database snapshot + recordings + attachments) to your Desktop
  and immediately re-verifies every hash.
- **Restore**: pick any archive, confirm, relaunch: media merge in
  additively and the database swaps atomically with your previous one
  preserved. (Also fixed: attachments were being silently omitted from
  archives.)

## 0.3.0 (2026-06-10)

The fleet release: a 22-agent research + UX audit workflow produced a
ranked 14-item plan (`docs/ENHANCEMENT_PLAN.md`); every rank shipped in
v1-or-better form, and the work surfaced two latent production bugs.

### AI notes you can watch and verify
- **Live streaming Enhance**: the summary writes itself on screen within
  seconds (live extraction from the structured-output stream); no more
  15-40s skeleton.
- **Verifiable action items**: items carry ▸ m:ss source chips; click to
  open the transcript drawer and hear the cited moment. Citations are
  bounds-checked AND content-grounded in Rust (hallucinated anchors are
  stripped, never rendered).
- **Retrieval-grounded Ask AI**: cross-meeting questions select context
  by relevance via full-text search, not recency.

### Found & fixed: transcript search was dead
Transcript full-text search had been silently broken since early
migrations (aliasing bug + an FTS external-content column mismatch, both
swallowed). It now works, and search results jump to the matching
second of audio.

### Flow
- One-click Enhance on waiting meetings; Join & Record on cards, agenda,
  and week views; pre-meeting "open loops with these attendees" card;
  ⌘D mark-this-moment stamps while recording.
- Menu-bar presence: live ⏺ elapsed timer, working tray Start/Stop and
  New Meeting.
- Tasks: Export to Apple Reminders (due dates included) and a once-daily
  9am due/overdue digest notification.

### First run
- Onboarding requests both permissions (Screen Recording explained up
  front), background-downloads the default Whisper model, and ends with a
  live 5-second capture-and-transcribe proof.

### Foundation
- Semantic type tokens (.text-caption/.text-footnote) with the five
  highest-traffic surfaces migrated; folder-membership queries batched
  (N+1 removed from both list surfaces).

Earlier in this line (originally listed as Unreleased):

- **Join & Record**: upcoming calendar meetings with a call link get a
  one-click chip that opens the call and starts recording.
- **One-click Enhance**: transcribed-but-unenhanced meetings show an
  Enhance chip on their card; the flow runs on open with zero extra clicks.
- **Menu-bar recording presence**: the tray's Start/Stop and New Meeting
  actions now work, and a live ⏺ m:ss elapsed timer shows in the menu bar
  while recording (visible behind fullscreen calls).
- **Tasks follow-through**: "Export to Reminders" creates the visible open
  tasks in a "Perchnote" Reminders list with due dates; a once-daily 9am
  digest notification reports due-today/overdue counts.
- **⌘D mark-this-moment**: stamps the live elapsed time at the cursor
  while recording; listed in the ⌘/ shortcuts overlay.
- **Folder queries batched**: one membership-map round-trip replaces a
  per-folder query fan-out on both list surfaces.

## 0.2.0 (2026-06-09)

The "one long day" release: twenty commits of reliability, intelligence, and polish.

### Speaker recognition, rebuilt
- Diarization redesigned for real conversations and validated against actual call audio: 1s sub-window median embeddings, order-independent two-pass agglomerative clustering, pitch (f0) penalty, phantom-cluster absorption. A real two-person interview that previously collapsed into one speaker now resolves to exactly two with correct turn structure.
- One holistic Speakers panel everywhere: name speakers (names propagate to the transcript, drawer, stats, and timeline instantly), merge duplicate detections, re-detect with voice similarity. Stale name labels are cleared on re-cluster instead of silently mislabeling.

### Meeting intelligence
- Tasks view: action items roll up across meetings with status/assignee filters, sorting, an overdue chip, and checkbox write-back that stays in sync with the source notes.
- "About You" generates itself from your meeting history (and refreshes weekly) while hand-written text is never touched; one click jumps from an enhancement straight to its extracted tasks.

### Reliability
- Crash recovery: interrupted recordings are reconciled at startup and their WAV headers repaired; orphaned recordings are swept; deleting a meeting deletes its audio.
- Daily database backups, corruption detection with move-aside recovery (no more crash loops), a mixer watchdog that warns the moment capture dies, Screen Recording permission-loss detection mid-recording, and a disk-space guard before recording.
- Dropped audio (overloaded machine) is now counted and reported instead of silently lost.

### Workflow & UI
- Pathing: ⌘[/⌘] history with rail back/forward buttons, ⌘1–⌘5 section switching, folder pills that open the folder, ⌘N creates a meeting and starts recording, ⌘/ shows every shortcut.
- A design-token slickness pass: press feedback on every control, unified focus rings and floating-chrome elevation, pop-in menus, shell atmosphere, native cursor/selection behavior, and no more white flash at launch.
- Accessibility: WCAG-AA muted text in both themes, labelled dialogs, focus traps, live-region transcript announcements.
- Startup parse cost cut by splitting the 1.09MB bundle into five cacheable chunks.

### Security
- TipTap link sanitization (javascript:/file:/data: stripped from AI or imported docs), atomic note writes, search no longer surfaces deleted meetings.

## 0.1.2 (earlier)
- Initial public release line: recording, local transcription, AI enhancement, folders, calendar sync, unsigned DMG distribution.
